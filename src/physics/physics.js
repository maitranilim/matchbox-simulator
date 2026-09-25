import * as THREE from 'three';
import { GRAVITY } from '../core/state.js';
import { clamp } from '../core/util.js';

/**
 * Thin wrapper around a Rapier world, in centimetres and grams.
 *
 * Every simulated thing is a `PhysicsBody`: a Three.js object plus a Rapier
 * rigid body built from a list of shape specs. Dynamic bodies drive their
 * object (interpolated between fixed steps); kinematic bodies follow their
 * object. Colliders remember their owner so queries and contact events can
 * find the game object they belong to.
 */
export let R = null;
export let world = null;
let events = null;

export const STEP = 1 / 120;
const MAX_STEPS = 8;
let accumulator = 0;

const tracked = new Set();
const ownerByCollider = new Map();
const preStep = new Set();
const impactListeners = [];

// Collision groups (membership << 16 | filter).
export const GROUP = { STATIC: 0x0001, DYNAMIC: 0x0002, HELD: 0x0004, DEBRIS: 0x0008, BOX: 0x0010 };
export const groups = (member, filter) => (member << 16) | filter;
export const ALL = 0xffff;

export async function initPhysics() {
  // Loaded on demand so the page and intro can render while the WASM loads.
  const RAPIER = (await import('@dimforge/rapier3d-compat')).default;
  await RAPIER.init();
  R = RAPIER;
  world = new R.World({ x: 0, y: -GRAVITY, z: 0 });
  world.lengthUnit = 100; // 100 units per metre
  world.timestep = STEP;
  // Small, light things (a 0.1 g match against a 6 g candle) need a stiffer
  // solve than the defaults: more iterations, and contacts corrected down to
  // 0.2 mm instead of 1 mm so nothing visibly sinks into anything else.
  world.numSolverIterations = 8;
  world.integrationParameters.normalizedAllowedLinearError = 0.0002;
  // Fast thin things (a flicked match) can hit several surfaces in one step.
  world.maxCcdSubsteps = 4;
  events = new R.EventQueue(true);
}

/** Build a Rapier ColliderDesc from a plain shape spec. */
function colliderDesc(s) {
  let d;
  switch (s.type) {
    case 'box': d = R.ColliderDesc.cuboid(s.hx, s.hy, s.hz); break;
    case 'ball': d = R.ColliderDesc.ball(s.r); break;
    case 'cylinder': d = R.ColliderDesc.cylinder(s.hh, s.r); break;
    case 'roundCylinder': d = R.ColliderDesc.roundCylinder(s.hh, s.r, s.round ?? 0.05); break;
    case 'capsule': d = R.ColliderDesc.capsule(s.hh, s.r); break;
    case 'cone': d = R.ColliderDesc.cone(s.hh, s.r); break;
    case 'hull': d = R.ColliderDesc.convexHull(s.points); break;
    case 'trimesh': d = R.ColliderDesc.trimesh(s.vertices, s.indices); break;
    default: throw new Error(`Unknown shape ${s.type}`);
  }
  if (!d) throw new Error(`Could not build ${s.type} collider`);
  if (s.pos) d.setTranslation(s.pos[0], s.pos[1], s.pos[2]);
  if (s.quat) d.setRotation({ x: s.quat[0], y: s.quat[1], z: s.quat[2], w: s.quat[3] });
  else if (s.rot) {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(s.rot[0], s.rot[1], s.rot[2]));
    d.setRotation(q);
  }
  return d;
}

/** Convex hull points from a geometry (optionally subsampled). */
export function hullPoints(geometry, maxPoints = 400, scale = 1) {
  const pos = geometry.attributes.position;
  const step = Math.max(1, Math.floor(pos.count / maxPoints));
  const out = [];
  for (let i = 0; i < pos.count; i += step) out.push(pos.getX(i) * scale, pos.getY(i) * scale, pos.getZ(i) * scale);
  return new Float32Array(out);
}

export function trimeshFrom(geometry) {
  const g = geometry.index ? geometry : geometry.clone();
  return {
    vertices: new Float32Array(g.attributes.position.array),
    indices: g.index ? new Uint32Array(g.index.array) : new Uint32Array([...Array(g.attributes.position.count).keys()]),
  };
}

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

export class PhysicsBody {
  /**
   * @param {THREE.Object3D} object  root object; must be a direct child of the scene for dynamic bodies
   * @param {object} o
   * @param {'dynamic'|'fixed'|'kinematic'} [o.type]
   * @param {Array} o.shapes  shape specs: {type, ...dims, pos?, rot?, density?, friction?, restitution?}
   * @param {number} [o.density]  g/cm³ default for all shapes
   */
  constructor(object, o) {
    this.object = object;
    this.owner = o.owner ?? null;
    this.type = o.type ?? 'dynamic';
    object.updateMatrixWorld(true);
    object.matrixWorld.decompose(_p, _q, _s);

    let bd;
    if (this.type === 'fixed') bd = R.RigidBodyDesc.fixed();
    else if (this.type === 'kinematic') bd = R.RigidBodyDesc.kinematicPositionBased();
    else bd = R.RigidBodyDesc.dynamic();
    bd.setTranslation(_p.x, _p.y, _p.z).setRotation(_q);
    if (this.type === 'dynamic') {
      bd.setLinearDamping(o.linearDamping ?? 0.05)
        .setAngularDamping(o.angularDamping ?? 0.15)
        .setCcdEnabled(o.ccd ?? false)
        .setCanSleep(true);
      if (o.linvel) bd.setLinvel(o.linvel.x, o.linvel.y, o.linvel.z);
      if (o.angvel) bd.setAngvel(o.angvel);
    }
    this.body = world.createRigidBody(bd);
    this.colliders = [];
    this.defaults = {
      density: o.density ?? 1,
      friction: o.friction ?? 0.6,
      restitution: o.restitution ?? 0.1,
      groups: o.groups ?? groups(this.type === 'dynamic' ? GROUP.DYNAMIC : GROUP.STATIC, ALL),
    };
    for (const s of o.shapes) this.addShape(s);

    this.prevPos = new THREE.Vector3().copy(_p);
    this.prevQuat = new THREE.Quaternion().copy(_q);
    this.currPos = new THREE.Vector3().copy(_p);
    this.currQuat = new THREE.Quaternion().copy(_q);
    tracked.add(this);
  }

  addShape(s) {
    const d = colliderDesc(s)
      .setDensity(s.density ?? this.defaults.density)
      .setFriction(s.friction ?? this.defaults.friction)
      .setRestitution(s.restitution ?? this.defaults.restitution)
      .setCollisionGroups(s.groups ?? this.defaults.groups);
    if (s.sensor) d.setSensor(true);
    if (this.type === 'dynamic') {
      d.setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS);
      d.setContactForceEventThreshold(s.impactThreshold ?? 2e3);
    }
    const c = world.createCollider(d, this.body);
    c.userData = { spec: s };
    ownerByCollider.set(c.handle, this);
    this.colliders.push(c);
    return c;
  }

  removeShape(c) {
    ownerByCollider.delete(c.handle);
    world.removeCollider(c, true);
    this.colliders.splice(this.colliders.indexOf(c), 1);
  }

  /** Replace every collider (e.g. after the object shrinks or melts), keeping its mass by default. */
  setShapes(shapes, { keepMass = true } = {}) {
    const m = this.body.mass();
    for (const c of [...this.colliders]) this.removeShape(c);
    for (const s of shapes) this.addShape(s);
    if (keepMass && m > 0) this.setMass(m);
    this.body.wakeUp();
  }

  /** Scale all collider densities, e.g. as fuel burns away. */
  setDensityScale(k) {
    for (const c of this.colliders) {
      const s = c.userData.spec;
      c.setDensity(Math.max(1e-4, (s.density ?? this.defaults.density) * k));
    }
    this.body.recomputeMassPropertiesFromColliders();
  }

  /** Scale densities so the body weighs exactly `grams`. */
  setMass(grams) {
    this.body.recomputeMassPropertiesFromColliders();
    const k = grams / this.body.mass();
    for (const c of this.colliders) {
      const s = c.userData.spec;
      s.density = (s.density ?? this.defaults.density) * k;
      c.setDensity(s.density);
    }
    this.body.recomputeMassPropertiesFromColliders();
  }

  get mass() { return this.body.mass(); }

  /**
   * Does any collider overlap another body's? `filter` is a collision-group
   * mask of what counts. Checked shape against shape directly rather than
   * through the broad phase, so bodies created this frame are seen too.
   */
  overlapping(filter = ALL) {
    world.propagateModifiedBodyPositionsToColliders();
    for (const other of tracked) {
      if (other === this || !other.body) continue;
      for (const o of other.colliders) {
        if (o.isSensor() || !((o.collisionGroups() >>> 16) & filter) || !o.isEnabled()) continue;
        const op = o.translation(), orot = o.rotation();
        for (const c of this.colliders) {
          if (!c.isSensor() && c.intersectsShape(o.shape, op, orot)) return true;
        }
      }
    }
    return false;
  }

  /**
   * Nudge the body straight up until none of its colliders overlap anything
   * else, so a new object never starts inside another one. Returns the lift.
   */
  liftClear(maxLift = 200, step = 0.25) {
    const b = this.body;
    const start = b.translation();
    let lift = 0;
    while (lift < maxLift && this.overlapping()) {
      lift += step;
      b.setTranslation({ x: start.x, y: start.y + lift, z: start.z }, true);
    }
    if (lift > 0) {
      this.object.position.y += lift;
      this.prevPos.y += lift;
      this.currPos.y += lift;
    }
    return lift;
  }

  setGroups(g) { for (const c of this.colliders) c.setCollisionGroups(g); }

  /** Teleport (dynamic) or move (kinematic) the body to the object's current transform. */
  syncFromObject() {
    this.object.updateMatrixWorld(true);
    this.object.matrixWorld.decompose(_p, _q, _s);
    if (this.type === 'kinematic') {
      this.body.setNextKinematicTranslation(_p);
      this.body.setNextKinematicRotation(_q);
    } else {
      this.body.setTranslation(_p, true);
      this.body.setRotation(_q, true);
      this.prevPos.copy(_p); this.currPos.copy(_p);
      this.prevQuat.copy(_q); this.currQuat.copy(_q);
    }
  }

  applyImpulse(v, point) {
    if (this.type !== 'dynamic') return;
    if (point) this.body.applyImpulseAtPoint(v, point, true);
    else this.body.applyImpulse(v, true);
  }

  velocityAt(point, target = new THREE.Vector3()) {
    const v = this.body.velocityAtPoint(point);
    return target.set(v.x, v.y, v.z);
  }

  linvel(target = new THREE.Vector3()) {
    const v = this.body.linvel();
    return target.set(v.x, v.y, v.z);
  }

  /**
   * Drive a point on the body towards a target with a force-limited,
   * critically damped velocity controller (a "hand").
   */
  driveTo(localPoint, target, { gain = 18, maxForce = 3e5, maxSpeed = 400, dt = STEP, atPoint = true } = {}) {
    const b = this.body;
    const m = b.mass();
    const wp = _p.copy(localPoint).applyQuaternion(this.currQuat).add(this.currPos);
    const v = b.velocityAtPoint(wp);
    let vx = (target.x - wp.x) * gain, vy = (target.y - wp.y) * gain, vz = (target.z - wp.z) * gain;
    const vl = Math.hypot(vx, vy, vz);
    if (vl > maxSpeed) { const k = maxSpeed / vl; vx *= k; vy *= k; vz *= k; }
    const dvx = vx - v.x;
    // The hand also has to hold the weight up, so gravity counts against maxForce.
    const dvy = vy - v.y + GRAVITY * dt;
    const dvz = vz - v.z;
    const maxJ = maxForce * dt;
    let jx = dvx * m, jy = dvy * m, jz = dvz * m;
    const jl = Math.hypot(jx, jy, jz);
    if (jl > maxJ) { const k = maxJ / jl; jx *= k; jy *= k; jz *= k; }
    // At the grab point things swing like they would in a hand; at the centre
    // of mass the orientation is left to alignTo().
    if (atPoint) b.applyImpulseAtPoint({ x: jx, y: jy, z: jz }, wp, true);
    else b.applyImpulse({ x: jx, y: jy, z: jz }, true);
  }

  /** Rotate towards a target orientation by setting angular velocity. */
  alignTo(targetQuat, { gain = 14, maxRate = 30 } = {}) {
    _q.copy(targetQuat).multiply(_q2.copy(this.currQuat).invert());
    if (_q.w < 0) { _q.x = -_q.x; _q.y = -_q.y; _q.z = -_q.z; _q.w = -_q.w; }
    const angle = 2 * Math.acos(clamp(_q.w, -1, 1));
    const sn = Math.sqrt(1 - _q.w * _q.w);
    let wx = 0, wy = 0, wz = 0;
    if (sn > 1e-5) {
      const r = Math.min(angle * gain, maxRate);
      wx = (_q.x / sn) * r; wy = (_q.y / sn) * r; wz = (_q.z / sn) * r;
    }
    this.body.setAngvel({ x: wx, y: wy, z: wz }, true);
  }

  dispose() {
    tracked.delete(this);
    for (const c of this.colliders) ownerByCollider.delete(c.handle);
    world.removeRigidBody(this.body);
    this.colliders = [];
    this.body = null;
  }
}
const _q2 = new THREE.Quaternion();

export function onPreStep(fn) { preStep.add(fn); return () => preStep.delete(fn); }
export function onImpact(fn) { impactListeners.push(fn); }

/** Advance the world by `dt` of simulation time using fixed steps. */
export function stepPhysics(dt) {
  accumulator = Math.min(accumulator + dt, STEP * MAX_STEPS);
  while (accumulator >= STEP) {
    for (const b of tracked) {
      if (b.type !== 'dynamic') continue;
      b.prevPos.copy(b.currPos);
      b.prevQuat.copy(b.currQuat);
    }
    for (const fn of preStep) fn(STEP);
    world.step(events);
    for (const b of tracked) {
      if (b.type !== 'dynamic') continue;
      const t = b.body.translation();
      const r = b.body.rotation();
      b.currPos.set(t.x, t.y, t.z);
      b.currQuat.set(r.x, r.y, r.z, r.w);
    }
    events.drainContactForceEvents((e) => {
      const a = ownerByCollider.get(e.collider1());
      const b = ownerByCollider.get(e.collider2());
      const f = e.totalForceMagnitude();
      for (const fn of impactListeners) fn(a, b, f);
    });
    accumulator -= STEP;
  }
  const alpha = accumulator / STEP;
  for (const b of tracked) {
    if (b.type !== 'dynamic') continue;
    b.object.position.lerpVectors(b.prevPos, b.currPos, alpha);
    b.object.quaternion.slerpQuaternions(b.prevQuat, b.currQuat, alpha);
  }
}

export function ownerOf(collider) { return ownerByCollider.get(collider.handle)?.owner ?? null; }
export function bodyOf(collider) { return ownerByCollider.get(collider.handle) ?? null; }

/**
 * Cast a ray. Returns { point, normal, toi, body, owner } or null.
 * `exclude` is a PhysicsBody (or array of them) to ignore.
 */
export function raycast(origin, dir, maxToi = 500, exclude = null, staticOnly = false) {
  const ray = new R.Ray(origin, dir);
  const ex = Array.isArray(exclude) ? exclude : exclude ? [exclude] : [];
  const pred = ex.length > 1 ? (c) => !ex.includes(ownerByCollider.get(c.handle)) : undefined;
  const flags = staticOnly ? R.QueryFilterFlags.EXCLUDE_DYNAMIC : undefined;
  const hit = world.castRayAndGetNormal(ray, maxToi, true, flags, undefined, undefined, ex.length === 1 && ex[0].body ? ex[0].body : undefined, pred);
  if (!hit) return null;
  const pb = ownerByCollider.get(hit.collider.handle);
  return {
    toi: hit.timeOfImpact,
    point: new THREE.Vector3(origin.x + dir.x * hit.timeOfImpact, origin.y + dir.y * hit.timeOfImpact, origin.z + dir.z * hit.timeOfImpact),
    normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
    body: pb ?? null,
    owner: pb?.owner ?? null,
  };
}

/** All PhysicsBodies with a collider overlapping a sphere. */
export function bodiesInSphere(center, radius) {
  const out = new Set();
  const shape = new R.Ball(radius);
  world.intersectionsWithShape(center, { x: 0, y: 0, z: 0, w: 1 }, shape, (c) => {
    const pb = ownerByCollider.get(c.handle);
    if (pb) out.add(pb);
    return true;
  });
  return [...out];
}

/** Height of the first surface below a point (table is y = 0). */
export function groundBelow(p, exclude = null) {
  const hit = raycast({ x: p.x, y: p.y + 0.01, z: p.z }, { x: 0, y: -1, z: 0 }, 200, exclude);
  return hit ? hit.point.y : 0;
}

/**
 * Every pair of touching bodies that overlap by more than `minDepth` cm,
 * deepest first: [{ a, b, depth }]. Used by the debug hooks and tests.
 */
export function overlaps(minDepth = 0.02) {
  const deepest = new Map();
  for (const pb of tracked) {
    if (pb.type !== 'dynamic') continue;
    for (const c of pb.colliders) {
      if (c.isSensor()) continue;
      world.contactPairsWith(c, (o) => {
        const other = ownerByCollider.get(o.handle);
        if (!other || other === pb || o.isSensor()) return;
        world.contactPair(c, o, (m) => {
          for (let i = 0; i < m.numContacts(); i++) {
            const depth = -m.contactDist(i);
            if (depth <= minDepth) continue;
            const key = [pb, other].map((x) => x.body?.handle).sort().join(':');
            if ((deepest.get(key)?.depth ?? 0) < depth) deepest.set(key, { a: pb, b: other, depth });
          }
        });
      });
    }
  }
  return [...deepest.values()].sort((x, y) => y.depth - x.depth);
}

export function allBodies() { return [...tracked]; }
