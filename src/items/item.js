import * as THREE from 'three';
import { scene } from '../core/stage.js';
import { AMBIENT_C, S } from '../core/state.js';
import { clamp, damp, rand, smoothstep, _v1, _v2 } from '../core/util.js';
import { PhysicsBody } from '../physics/physics.js';
import { Flame, FLAME_COLORS } from '../fx/flame.js';
import { emitAsh, emitSmoke, emitSparks } from '../fx/particles.js';
import { fire } from '../fire/fire.js';
import { sound } from '../audio/sound.js';
import { addScorch } from '../world/table.js';
import { MAX_NODES } from './burnShader.js';

const NODE = { FRESH: 0, BURNING: 1, SPENT: 2 };
const _c = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();

/**
 * Something from the cupboard: a Three.js group, a rigid body with a real
 * mass, and (if it burns) a set of fuel nodes spread over its body.
 *
 * Each node has a temperature, integrated from the heat model in fire.js,
 * and ignites past the material's ignition temperature. A burning node is a
 * heat source and grows a burn front; the front lights neighbouring nodes
 * when it reaches them, and the same front values drive the char/ember/ash
 * shader, so what you see and what burns stay in sync.
 */
export class Item {
  constructor(def) {
    this.def = def;
    this.kind = 'item';
    this.id = def.id;
    this.name = def.name;
    this.material = def.sound ?? 'wood';
    this.group = new THREE.Group();
    this.group.userData.item = this;
    this.phys = null;
    this.removed = false;
    this.flags = {};
    this.age = 0;

    // Built by the definition: meshes, collider shapes, fuel nodes.
    const built = def.build(this);
    this.meshes = built.meshes;
    this.shapes = built.shapes;
    this.burnUniforms = built.burnUniforms ?? [];
    for (const m of this.meshes) {
      m.castShadow = m.castShadow !== false;
      m.receiveShadow = true;
      m.userData.item = this;
      if (!m.parent) this.group.add(m);
    }
    this.group.traverse((o) => { if (o.isMesh || o.isLineSegments || o.isPoints) o.userData.item = this; });

    this.burn = def.burn ?? null;
    const nodes = built.nodes ?? [];
    this.nodes = nodes.slice(0, MAX_NODES).map((p) => ({
      p: p.clone(), T: AMBIENT_C, state: NODE.FRESH, fuel: this.burn ? this.burn.burnTime * rand(0.85, 1.15) : 0,
      front: 0, age: 0, flame: null, wet: 0, world: new THREE.Vector3(),
    }));
    // Neighbour distances for front-driven spread.
    this.spacing = built.spacing ?? 2;
    this.frontCap = this.spacing * 1.6;
    this.maxT = AMBIENT_C;
    this.burningCount = 0;
    this.everBurned = false;
    this.consumed = 0;
    this.densityScale = 1;
    this.massTimer = 0;
    this.flameCount = 0;
    this.wet = 0;
    this.crackleT = rand(0.1, 0.5);
    this.contact = new Float32Array(this.nodes.length);
    this.contactAt = this.nodes.map(() => new THREE.Vector3());
    const bs = new THREE.Box3().setFromObject(this.group).getBoundingSphere(new THREE.Sphere());
    this.boundCenter = bs.center.clone();
    this.boundR = bs.radius;
    if (def.init) def.init(this);
  }

  /** Put it in the world at a position and give it a body. */
  spawn(pos, { quat, linvel, angvel } = {}) {
    this.group.position.copy(pos);
    if (quat) this.group.quaternion.copy(quat);
    scene.add(this.group);
    const phys = this.def.physics ?? {};
    this.phys = new PhysicsBody(this.group, {
      shapes: this.shapes,
      density: phys.density ?? 0.5,
      friction: phys.friction ?? 0.6,
      restitution: phys.restitution ?? 0.1,
      linearDamping: phys.linearDamping ?? 0.05,
      angularDamping: phys.angularDamping ?? 0.2,
      ccd: phys.ccd ?? true,
      owner: this,
      linvel, angvel,
    });
    if (phys.mass) this.phys.setMass(phys.mass);
    this.baseMass = this.phys.mass;
    if (this.def.onSpawn) this.def.onSpawn(this);
    return this;
  }

  get mass() { return this.phys && this.phys.body ? this.phys.mass : 0; }

  get temperature() { return this.def.temperature ? this.def.temperature(this) : this.maxT; }

  heatFrom(dt) { this.updateHeat(dt); }
  get burning() { return this.burningCount > 0; }

  nodeWorld(n) { return this.group.localToWorld(n.world.copy(n.p)); }

  /**
   * Flames touching any part of the body (not only a fuel node) heat the
   * node nearest to the touch point, and that is where the burn starts.
   */
  contactHeat() {
    const C = this.contact;
    C.fill(0);
    if (!this.phys || !this.phys.body) return;
    const centre = this.group.localToWorld(_c.copy(this.boundCenter));
    for (const s of fire.sources) {
      if (s.owner === this) continue;
      if (Math.hypot(centre.x - s.x, centre.y - s.y, centre.z - s.z) > this.boundR + s.h + s.r + 1) continue;
      const reach = s.r + 0.5;
      for (const f of [0, 0.35, 0.8]) {
        _p.set(s.x, s.y + s.h * f, s.z);
        let best = null, bd = reach;
        for (const col of this.phys.colliders) {
          const pr = col.projectPoint(_p, true);
          if (!pr) continue;
          const d = pr.isInside ? 0 : Math.hypot(pr.point.x - _p.x, pr.point.y - _p.y, pr.point.z - _p.z);
          if (d < bd) { bd = d; best = pr.isInside ? _p : pr.point; }
        }
        if (!best) continue;
        const e = s.power * (1 - bd / reach) * (f === 0 ? 0.8 : 1);
        const local = this.group.worldToLocal(_q.set(best.x, best.y, best.z));
        let ni = -1, nd = Infinity;
        for (let i = 0; i < this.nodes.length; i++) {
          if (this.nodes[i].state !== NODE.FRESH) continue;
          const d = this.nodes[i].p.distanceToSquared(local);
          if (d < nd) { nd = d; ni = i; }
        }
        if (ni >= 0 && e > C[ni]) { C[ni] = e; this.contactAt[ni].copy(local); }
      }
    }
  }

  /**
   * Heat reaching the body's surface from flames that touch it (contact),
   * plus radiant heat at its centre. Used by things with a single bulk
   * temperature, like the aerosol can and the oil pan.
   */
  surfaceExposure() {
    if (!this.phys || !this.phys.body) return 0;
    const centre = this.group.localToWorld(_c.copy(this.boundCenter));
    let e = fire.exposure(centre, this) * 0.5;
    for (const s of fire.sources) {
      if (s.owner === this) continue;
      if (Math.hypot(centre.x - s.x, centre.y - s.y, centre.z - s.z) > this.boundR + s.h + s.r + 1) continue;
      const reach = s.r + 0.5;
      let best = 0;
      for (const f of [0, 0.35, 0.8]) {
        _p.set(s.x, s.y + s.h * f, s.z);
        for (const col of this.phys.colliders) {
          const pr = col.projectPoint(_p, true);
          if (!pr) continue;
          const d = pr.isInside ? 0 : Math.hypot(pr.point.x - _p.x, pr.point.y - _p.y, pr.point.z - _p.z);
          if (d < reach) best = Math.max(best, s.power * (1 - d / reach));
        }
      }
      e += best;
    }
    return e;
  }

  /** Heat, ignition and burn-front bookkeeping. */
  updateHeat(dt) {
    const B = this.burn;
    if (!B || this.removed) return;
    this.group.updateMatrixWorld();
    this.contactHeat();
    let maxT = AMBIENT_C, burning = 0, consumed = 0;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      const w = this.nodeWorld(n);
      if (n.state === NODE.FRESH) {
        const e = Math.max(fire.exposure(w, this, true), this.contact[i]);
        const cap = n.wet > 0 ? 100 : Infinity; // water has to boil off first
        n.T += (B.heatRate * e - B.cool * (n.T - AMBIENT_C)) * dt;
        if (n.T > cap) { n.wet = Math.max(0, n.wet - dt * e * 0.6); n.T = cap; }
        if (n.T >= B.ignite && n.fuel > 0 && n.wet <= 0) {
          // Start the burn where the flame actually touched, if it was close.
          if (this.contact[i] > 0 && this.contactAt[i].distanceTo(n.p) < this.spacing) n.p.copy(this.contactAt[i]);
          this.igniteNode(n);
        }
      } else if (n.state === NODE.BURNING) {
        n.age += dt;
        n.fuel -= dt;
        n.T = Math.max(n.T, B.ignite + 200);
        if (n.fuel <= 0) { n.state = NODE.SPENT; this.onNodeSpent(n); }
      } else {
        n.T += (-B.cool * (n.T - AMBIENT_C)) * dt;
      }
      if (n.state !== NODE.FRESH) {
        n.front = Math.min(this.frontCap, n.front + B.spread * dt * (n.state === NODE.BURNING ? 1 : 0.6));
        consumed += n.state === NODE.SPENT ? 1 : 1 - Math.max(0, n.fuel) / B.burnTime;
      }
      if (n.state === NODE.BURNING) burning++;
      maxT = Math.max(maxT, n.T);
    }
    // Fronts light their neighbours.
    for (const a of this.nodes) {
      if (a.state === NODE.FRESH || a.front <= 0) continue;
      for (const b of this.nodes) {
        if (b.state !== NODE.FRESH || b.fuel <= 0 || b.wet > 0) continue;
        if (a.p.distanceTo(b.p) <= a.front) this.igniteNode(b);
      }
    }
    this.maxT = maxT;
    this.burningCount = burning;
    this.consumed = this.nodes.length ? consumed / this.nodes.length : 0;
  }

  igniteNode(n) {
    if (n.state !== NODE.FRESH) return;
    const first = !this.everBurned && this.burningCount === 0;
    n.state = NODE.BURNING;
    n.age = 0;
    n.front = Math.max(n.front, 0.05);
    this.everBurned = true;
    if (first) {
      sound.catchFire(this.burn.flame?.height ? Math.min(2, this.burn.flame.height / 2) : 0.5);
      if (this.def.onIgnite) this.def.onIgnite(this);
    }
  }

  onNodeSpent(n) {
    if (n.flame) { n.flame.die(); n.flame = null; this.flameCount--; }
    if (this.burn.ashFlakes) emitAsh(this.nodeWorld(n), this.burn.ashFlakes, 1.4);
  }

  /** Register burning nodes as heat sources and keep flames on them. */
  addHeat() {
    if (this.removed) return;
    if (this.def.addHeat) this.def.addHeat(this);
    const B = this.burn;
    if (!B) return;
    const F = B.flame;
    for (const n of this.nodes) {
      if (n.state !== NODE.BURNING) continue;
      const k = this.nodeIntensity(n);
      const w = n.world;
      fire.add({ x: w.x, y: w.y, z: w.z, h: Math.max(0.3, (F ? F.height : 0.6) * k), r: F ? F.width * 0.7 : 0.6, power: B.power * k, owner: this, kind: this.id });
    }
  }

  nodeIntensity(n) {
    const B = this.burn;
    const grow = smoothstep(0, B.growTime ?? 0.5, n.age);
    const fade = clamp(n.fuel / (B.burnTime * 0.3), 0, 1);
    const wind = 1 - 0.15 * S.wind;
    return Math.max(0.05, grow * (0.35 + 0.65 * fade) * wind * (this.intensityK ?? 1));
  }

  updateFx(dt, t) {
    const B = this.burn;
    if (!B || this.removed) return;
    const F = B.flame;
    let emberSum = 0;
    for (const n of this.nodes) {
      if (n.state !== NODE.BURNING) continue;
      const k = this.nodeIntensity(n);
      emberSum += k;
      if (F && !n.flame && this.flameCount < (F.max ?? 6)) {
        n.flame = new Flame({
          height: F.height * rand(0.8, 1.15), width: F.width, blue: F.blue ?? 0.3, intensity: F.intensity ?? 1.5,
          speed: F.speed ?? 0.8, colors: FLAME_COLORS[F.colors ?? 'wood'], alpha: F.alpha ?? 1, soot: F.soot ?? 0, glow: F.glow ?? 0.4,
        });
        n.flame.lightK = F.lightK ?? 1;
        n.flame.size = 0.05;
        this.flameCount++;
      }
      if (n.flame) {
        n.flame.base.copy(n.world);
        if (F.lift) n.flame.base.y += F.lift;
        n.flame.target = k;
      }
      const sm = B.smoke;
      if (sm && Math.random() < dt * sm.rate * k) {
        const tip = n.flame ? n.flame.tip(_v1) : _v1.copy(n.world);
        emitSmoke(tip, { size: sm.size ?? 0.3, size1: sm.size1 ?? 3, alpha: sm.alpha ?? 0.2, life: sm.life ?? 4, rise: sm.rise ?? 3, shade: sm.shade ?? 0.45, spread: sm.spread ?? 0.3, color: sm.color });
      }
      if (B.sparks && Math.random() < dt * B.sparks * k) emitSparks(n.world, 1, _v2.set(0, 1, 0), B.sparkSpeed ?? 25, 12, { lifeK: 1.6, sizeK: 0.9 });
      if (B.ashFlakes && Math.random() < dt * 0.8 * k) emitAsh(n.world, 1);
    }
    // Wet things sizzle while they dry.
    this.crackleT -= dt;
    if (this.burningCount && this.crackleT < 0) {
      this.crackleT = rand(0.04, 0.4) / Math.min(4, this.burningCount);
      sound.crackle(rand(0.02, 0.09) * (B.crackle ?? 1));
    }
    const glow = this.nodes.length ? emberSum / Math.max(1, Math.min(this.nodes.length, 6)) : 0;
    for (const u of this.burnUniforms) {
      u.uCount.value = this.nodes.length;
      for (let i = 0; i < this.nodes.length; i++) {
        const n = this.nodes[i];
        u.uNodes.value[i].set(n.p.x, n.p.y, n.p.z, n.state === NODE.FRESH ? -1 : n.front);
      }
      u.uEmber.value = damp(u.uEmber.value, Math.min(1.4, glow + (this.burn.smoulder && this.everBurned && this.consumed < 0.98 ? 0.25 : 0)), 3, dt);
      u.uTime.value = t;
      u.uWet.value = clamp(this.wet, 0, 1);
    }
  }

  /** Water or powder landing near a point. */
  douse(pos, amount = 1, kind = 'water') {
    if (this.def.onDouse && this.def.onDouse(this, pos, amount, kind) === false) return;
    if (!this.burn) return;
    let hit = false;
    for (const n of this.nodes) {
      const d = pos ? this.nodeWorld(n).distanceTo(pos) : 0;
      if (d > 3.5) continue;
      if (n.state === NODE.BURNING) {
        n.fuel = Math.max(0, n.fuel - (kind === 'powder' ? 0.5 : 0.2) * amount);
        if (Math.random() < 0.35 * amount) {
          n.state = n.fuel > 0.5 ? NODE.FRESH : NODE.SPENT;
          if (n.flame) { n.flame.die(); n.flame = null; this.flameCount--; }
          n.T = kind === 'water' ? 60 : this.burn.ignite - 60;
          hit = true;
        }
      } else if (n.state === NODE.FRESH) n.T = Math.max(AMBIENT_C, n.T - 60 * amount);
      if (kind === 'water') n.wet = Math.min(3, n.wet + 0.4 * amount);
    }
    if (kind === 'water') this.wet = Math.min(1, this.wet + 0.08 * amount);
    if (hit) sound.sizzle(0.2);
  }

  update(dt, t) {
    this.age += dt;
    if (this.def.update) this.def.update(this, dt, t);
    if (!this.burn || this.removed) return;
    this.updateFx(dt, t);
    this.wet = Math.max(0, this.wet - dt * 0.01 * (this.burningCount + 0.2));
    for (const n of this.nodes) if (n.wet > 0 && n.state === NODE.FRESH && n.T < 100) n.wet = Math.max(0, n.wet - dt * 0.005);

    // Mass follows fuel burned (or gained, for oxidising metals).
    this.massTimer -= dt;
    if (this.massTimer < 0 && this.phys && this.everBurned) {
      this.massTimer = 0.25;
      const k = Math.max(0.03, 1 - (this.burn.massLoss ?? 0.8) * this.consumed);
      if (Math.abs(k - this.densityScale) > 0.01) {
        this.densityScale = k;
        this.phys.setDensityScale(k);
      }
    }
    // Things that burn away entirely leave only ash.
    if (this.burn.burnsAway && this.everBurned && this.nodes.every((n) => n.state === NODE.SPENT || (n.state === NODE.FRESH && n.fuel <= 0)) && this.nodes.every((n) => n.front >= this.frontCap * 0.98 || n.state === NODE.FRESH)) {
      this.ashOut();
    }
  }

  ashOut() {
    if (this.removed) return;
    const p = this.group.position;
    if (p.y < 1.5) addScorch(p.x, p.z, 0.004, this.burn.scorch ?? 2.5);
    emitAsh(p, 10, 0.5);
    for (let i = 0; i < 5; i++) emitSmoke(p, { size: 0.5, size1: 3, alpha: 0.18, life: 4, rise: 2, shade: 0.4, spread: 1 });
    this.remove();
  }

  remove() {
    if (this.removed) return;
    this.removed = true;
    for (const n of this.nodes) if (n.flame) { n.flame.die(); n.flame = null; }
    if (this.def.onRemove) this.def.onRemove(this);
    if (this.phys) { this.phys.dispose(); this.phys = null; }
    scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
    const i = S.items.indexOf(this);
    if (i >= 0) S.items.splice(i, 1);
    if (S.selected === this) S.selected = null;
  }

  statusText() {
    if (this.def.status) {
      const s = this.def.status(this);
      if (s) return s;
    }
    if (!this.burn) return 'Stable';
    if (this.burningCount) return this.burningCount > this.nodes.length * 0.5 ? 'Fully ablaze' : 'Burning';
    if (this.wet > 0.05 || this.nodes.some((n) => n.wet > 0)) return 'Wet';
    if (this.everBurned) return this.consumed > 0.9 ? 'Burnt out' : 'Charred';
    if (this.maxT > this.burn.ignite * 0.6) return 'Getting hot';
    return 'Room temperature';
  }
}

export { NODE };
