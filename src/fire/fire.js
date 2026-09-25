import * as THREE from 'three';
import { scene, shake } from '../core/stage.js';
import { S } from '../core/state.js';
import { clamp, damp, rand } from '../core/util.js';
import { bodiesInSphere } from '../physics/physics.js';
import { emitFireball, emitSparks, emitSmoke, flash, motesLights } from '../fx/particles.js';
import { flames } from '../fx/flame.js';
import { sound } from '../audio/sound.js';

/**
 * Heat model.
 *
 * Every burning thing registers one or more heat sources each frame. A source
 * is a flame column: base position, height and radius (cm) and a power where
 * 1 is a single match flame. Anything that can catch fire samples
 * `exposure(point)` at a few points on itself, integrates a temperature from
 * it, and ignites past its own ignition temperature. This one mechanism gives
 * piloted ignition (touching a flame), fire climbing upward faster than
 * sideways (the plume), and slow radiant pre-heating next to a big fire.
 */
const sources = [];
const transient = [];

export const fire = {
  sources,

  begin(dt) {
    sources.length = 0;
    for (let i = transient.length - 1; i >= 0; i--) {
      const t = transient[i];
      t.ttl -= dt;
      if (t.ttl <= 0) { transient.splice(i, 1); continue; }
      sources.push(t);
    }
  },

  /** { x, y, z, h, r, power, owner, kind } */
  add(src) { sources.push(src); return src; },

  /** A short-lived heat source (fireballs, flare-ups). */
  pulse(pos, { h = 6, r = 4, power = 6, ttl = 0.4, owner = null, kind = 'fireball' } = {}) {
    transient.push({ x: pos.x, y: pos.y, z: pos.z, h, r, power, owner, kind, ttl });
  },

  /**
   * Heat flux at a point (relative units: 1 is the inside of a match flame).
   * Sources owned by `owner` are skipped unless `self` is true.
   */
  exposure(p, owner = null, self = false) {
    let e = 0;
    for (const s of sources) {
      if (s.owner === owner && owner !== null && !self) continue;
      e += sourceExposure(s, p);
    }
    return e;
  },

  /** Is the point inside any flame (not counting `owner`'s)? Returns the source. */
  touching(p, owner = null, pad = 0) {
    for (const s of sources) {
      if (s.owner === owner && owner !== null) continue;
      const dy = p.y - s.y;
      if (dy < -0.3 * s.r - pad || dy > s.h * 1.1 + pad) continue;
      const w = s.r * (1 - 0.5 * clamp(dy / s.h, 0, 1)) + 0.12 + pad;
      if (Math.hypot(p.x - s.x, p.z - s.z) < w) return s;
    }
    return null;
  },

  nearest(p, maxDist = Infinity, filter) {
    let best = null, bd = maxDist;
    for (const s of sources) {
      if (filter && !filter(s)) continue;
      const d = Math.hypot(p.x - s.x, p.y - (s.y + s.h * 0.3), p.z - s.z);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  },
};

function sourceExposure(s, p) {
  const dx = p.x - s.x, dy = p.y - s.y, dz = p.z - s.z;
  const rr = Math.hypot(dx, dz);
  let e = 0;
  if (dy > -0.35 * s.r - 0.5 && dy < s.h * 1.1) {
    const w = s.r * (1 - 0.5 * clamp(dy / s.h, 0, 1)) + 0.12;
    if (rr < w) e += s.power * (1 - 0.3 * (rr / w));
  } else if (dy >= s.h * 1.1 && dy < s.h * 4) {
    // Hot plume above the flame.
    const w = s.r * 1.5 + (dy - s.h) * 0.25;
    if (rr < w) e += s.power * 0.4 * (1 - (dy - s.h) / (3 * s.h)) * (1 - rr / w);
  }
  const d2 = dx * dx + dy * dy + dz * dz;
  const h2 = s.h * s.h + s.r * s.r;
  e += s.power * 0.08 * h2 / (d2 + h2);
  return e;
}

/**
 * Explosion: an impulse on every body nearby (lighter things fly further),
 * a heat pulse that can light what is around it, and the flash and bang.
 */
export function explode(pos, { strength = 1, radius = 18, fire: fireball = true, owner = null } = {}) {
  const bodies = bodiesInSphere(pos, radius);
  for (const pb of bodies) {
    if (pb.type !== 'dynamic' || !pb.body) continue;
    const c = pb.body.worldCom ? pb.body.worldCom() : pb.body.translation();
    const dir = new THREE.Vector3(c.x - pos.x, c.y - pos.y + 1.5, c.z - pos.z);
    const d = Math.max(1, dir.length());
    dir.normalize();
    const falloff = clamp(1 - d / radius, 0, 1);
    // Blast impulse scales with the area facing the blast, not with mass, so
    // light things fly further. Cap the velocity change so nothing is launched
    // off the table at absurd speeds.
    const o = pb.owner;
    const r = o?.boundR ?? (o?.kind === 'match' ? 0.8 : 1.5);
    const area = Math.PI * r * r;
    const m = pb.body.mass();
    const J = Math.min(strength * 90 * area * falloff * falloff, 450 * m);
    pb.applyImpulse({ x: dir.x * J, y: dir.y * J, z: dir.z * J });
    const tq = J * 0.15;
    pb.body.applyTorqueImpulse({ x: rand(-1, 1) * tq, y: rand(-1, 1) * tq, z: rand(-1, 1) * tq }, true);
  }
  if (fireball) {
    emitFireball(pos, { n: Math.round(30 + strength * 25), radius: 2 + strength * 2, speed: 40 + strength * 60, size: 2 + strength, size1: 6 + strength * 5, life: 0.8 + strength * 0.4 });
    fire.pulse(pos, { h: 4 + strength * 5, r: 3 + strength * 4, power: 5 + strength * 4, ttl: 0.35 + strength * 0.15, owner });
  }
  emitSparks(pos, Math.round(40 * strength), new THREE.Vector3(0, 1, 0), 160 * strength, 140 * strength, { lifeK: 1.5 });
  for (let i = 0; i < 12; i++) emitSmoke(pos, { size: 1.5, size1: 8 + strength * 4, alpha: 0.35, life: 5, rise: 6, shade: 0.25, spread: 2 });
  flash(pos, { size: 14 + strength * 16, strength: 2.2, dur: 0.5 + strength * 0.2 });
  boomLight(pos, strength);
  sound.boom(strength);
  shake(0.25 + strength * 0.25);
}

// ---------------------------------------------------------------------------
// Fire lights: a fixed pool of point lights assigned to the biggest fires.
// (A fixed count keeps Three.js from recompiling shaders as fires come and go.)
const LIGHTS = 4;
const pool = [];
for (let i = 0; i < LIGHTS; i++) {
  const l = new THREE.PointLight(0xff9448, 0, 120, 2);
  if (i < 2) {
    l.castShadow = true;
    l.shadow.mapSize.set(512, 512);
    l.shadow.bias = -0.003;
    l.shadow.normalBias = 0.03;
    l.shadow.camera.near = 0.08;
    l.shadow.camera.far = 60;
    l.shadow.radius = 3;
  }
  scene.add(l);
  pool.push({ light: l, target: 0, pos: new THREE.Vector3() });
}
const boom = new THREE.PointLight(0xffb070, 0, 200, 2);
scene.add(boom);
let boomT = 0, boomPow = 0;
function boomLight(pos, s) { boom.position.copy(pos).y += 3; boomT = 1; boomPow = 900 * (0.6 + s); }

export function updateFireLights(dt, t) {
  // Cluster flames by proximity and weight.
  const clusters = [];
  for (const f of flames) {
    if (f.size < 0.03) continue;
    const w = f.size * f.height * (f.lightK ?? 1);
    let c = null;
    for (const k of clusters) if (k.pos.distanceToSquared(f.base) < 9) { c = k; break; }
    if (!c) { c = { pos: f.base.clone(), w: 0, n: 0, sum: new THREE.Vector3(), flick: 0, height: 0 }; clusters.push(c); }
    c.w += w;
    c.n++;
    c.sum.addScaledVector(f.base, w);
    c.flick += f.flicker * w;
    c.height = Math.max(c.height, f.visibleHeight);
  }
  clusters.sort((a, b) => b.w - a.w);
  motesLights.length = 0;
  for (let i = 0; i < LIGHTS; i++) {
    const p = pool[i];
    const c = clusters[i];
    if (c && c.w > 0) {
      p.pos.copy(c.sum).divideScalar(c.w);
      p.pos.y += Math.max(0.35, c.height * 0.35);
      const fl = c.flick / c.w;
      p.light.position.copy(p.pos);
      p.target = 13 * Math.pow(c.w, 0.85) * fl * (0.92 + 0.08 * Math.sin(t * 31 + i * 7));
      motesLights.push({ x: p.pos.x, y: p.pos.y, z: p.pos.z, size: Math.min(4, c.w) });
    } else p.target = 0;
    p.light.intensity = damp(p.light.intensity, p.target, 25, dt);
  }
  boomT = Math.max(0, boomT - dt * 2.2);
  boom.intensity = boomPow * boomT * boomT;
  let total = 0;
  for (const f of flames) total += f.size * Math.sqrt(f.height);
  sound.setRoar(clamp(total * 0.035, 0, 0.45));
}
