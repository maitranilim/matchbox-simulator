import * as THREE from 'three';
import { scene, shake } from '../core/stage.js';
import { S } from '../core/state.js';
import { clamp, damp, rand, smoothstep, _v1, _v2 } from '../core/util.js';
import { raycast } from '../physics/physics.js';
import { Flame, FLAME_COLORS } from '../fx/flame.js';
import { droplets, emitFireball, emitSmoke, fireballs, flash, smoke as smokeSys } from '../fx/particles.js';
import { fire, explode } from '../fire/fire.js';
import { sound } from '../audio/sound.js';

// ---------------------------------------------------------------------------
// Liquid pools on the table (spilled alcohol and the like).

const puddleTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 20, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.72, 'rgba(255,255,255,0.9)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.beginPath();
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const r = 100 + Math.sin(a * 3) * 10 + Math.sin(a * 7 + 1) * 6 + Math.random() * 4;
    g.lineTo(128 + Math.cos(a) * r, 128 + Math.sin(a) * r);
  }
  g.fill();
  return new THREE.CanvasTexture(c);
})();

export const puddles = new Set();

/**
 * A pool of flammable liquid. It burns across its surface as one sheet of
 * flame, evaporates slowly while unlit, and shrinks as its fuel burns off.
 */
export class Puddle {
  constructor(pos, { ml = 30, kind = 'alcohol' } = {}) {
    this.kind = 'puddle';
    this.liquid = kind;
    this.ml = ml;
    this.pos = pos.clone();
    this.radius = 0;
    this.lit = false;
    this.flames = [];
    this.spreadT = 0;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshPhysicalMaterial({
        color: 0xcfe6ff, roughness: 0.02, metalness: 0, transparent: true, opacity: 0.35, alphaMap: puddleTex,
        clearcoat: 1, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3,
      }),
    );
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.rotation.z = rand(0, 6);
    this.mesh.position.copy(this.pos).y += 0.01;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
    puddles.add(this);
  }

  /** ~1 ml of 70% alcohol spreads to about 1.3 cm² on a sealed table. */
  targetRadius() { return Math.sqrt(Math.max(0, this.ml) * 1.3 / Math.PI) + 0.3; }

  add(ml) { this.ml += ml; }

  addHeat() {
    if (!this.lit) return;
    const k = clamp(this.ml / 8, 0.25, 1);
    const n = Math.max(1, Math.round(this.radius / 1.6));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, r = i === 0 ? 0 : this.radius * 0.55;
      fire.add({ x: this.pos.x + Math.cos(a) * r, y: this.pos.y, z: this.pos.z + Math.sin(a) * r, h: 3.2 * k, r: Math.max(0.8, this.radius * 0.5), power: 1.6 * k, owner: this, kind: 'alcohol' });
    }
  }

  heatFrom(dt) {
    if (this.lit || this.ml <= 0.2) return;
    // Alcohol's flash point (~12-20 °C) is below room temperature: any flame
    // touching the vapour above the pool lights it at once.
    const probe = _v1.copy(this.pos);
    for (let dy = 0; dy < 1.5; dy += 0.5) {
      probe.y = this.pos.y + dy;
      if (fire.touching(probe, this, this.radius)) { this.ignite(); return; }
    }
  }

  ignite() {
    if (this.lit) return;
    this.lit = true;
    this.spreadT = 0;
    sound.whoomp(0.5);
    flash(this.pos, { size: 5 + this.radius * 2, color: 0x88aaff, strength: 0.6 });
  }

  douse(pos, amount = 1, kind = 'water') {
    if (kind === 'water') {
      // Alcohol mixes with water: it keeps burning until diluted enough.
      this.water = (this.water ?? 0) + amount * 0.6;
      this.ml += amount * 0.3;
      if (this.lit && this.water > this.ml * 0.8) this.extinguish();
    } else if (kind === 'powder' && this.lit && Math.random() < 0.3 * amount) this.extinguish();
  }

  extinguish() {
    if (!this.lit) return;
    this.lit = false;
    for (const f of this.flames) f.die();
    this.flames = [];
    sound.fizz();
  }

  update(dt, t) {
    const target = this.targetRadius();
    this.radius = damp(this.radius, target, this.radius < target ? 3 : 1, dt);
    this.mesh.scale.setScalar(this.radius * 2);
    if (this.lit) {
      this.spreadT += dt;
      // 70% isopropyl burns at about 1 ml every 1.5 s per 20 cm² of pool.
      this.ml -= dt * (0.25 + this.radius * this.radius * 0.035);
      const nFlames = Math.min(7, Math.max(1, Math.round(this.radius * 1.3)));
      while (this.flames.length < nFlames) {
        const f = new Flame({ height: 2.6, width: 0.9, blue: 1, intensity: 1.4, colors: FLAME_COLORS.alcohol, alpha: 0.55 + S.room * -0.3, glow: 0.15, glowColor: 0x6688ff, speed: 1.2 });
        f.lightK = 0.35;
        f.size = 0.05;
        f.offA = rand(0, Math.PI * 2);
        f.offR = this.flames.length === 0 ? 0 : rand(0.3, 0.8);
        this.flames.push(f);
      }
      const k = clamp(this.ml / 6, 0.2, 1) * smoothstep(0, 0.4, this.spreadT);
      for (const f of this.flames) {
        f.base.set(this.pos.x + Math.cos(f.offA) * f.offR * this.radius, this.pos.y + 0.02, this.pos.z + Math.sin(f.offA) * f.offR * this.radius);
        f.target = k * rand(0.9, 1.05);
        f.u.uAlpha.value = 0.75 - S.room * 0.45; // hard to see in daylight
      }
      // A little water vapour and next to no soot.
      if (Math.random() < dt * 2) emitSmoke(_v2.copy(this.pos).setY(this.pos.y + 3), { size: 0.4, size1: 2, alpha: 0.03, life: 2.5, rise: 3, shade: 0.9 });
      if (this.ml <= 0.3) this.extinguish();
    } else {
      // Unlit alcohol evaporates.
      this.ml -= dt * 0.04 * this.radius;
    }
    this.mesh.material.opacity = clamp(this.ml / 5, 0, 0.35);
    if (this.ml <= 0.05 && !this.lit) this.dispose();
  }

  dispose() {
    puddles.delete(this);
    for (const f of this.flames) f.dispose();
    scene.remove(this.mesh);
    this.mesh.material.dispose();
  }
}

/** Find (or create) a puddle at a spot on whatever surface is below. */
export function spill(pos, ml, kind = 'alcohol', exclude = null, staticOnly = true) {
  const hit = raycast({ x: pos.x, y: pos.y + 0.5, z: pos.z }, { x: 0, y: -1, z: 0 }, 50, exclude, staticOnly);
  const ground = hit ? hit.point : new THREE.Vector3(pos.x, 0, pos.z);
  for (const p of puddles) {
    if (p.liquid === kind && p.pos.distanceTo(ground) < p.radius + 1.5) { p.add(ml); return p; }
  }
  return new Puddle(ground, { ml, kind });
}

// ---------------------------------------------------------------------------
// Pouring and sprinkling: droplets that fly, hit things and act on them.

const COLORS = { water: [0.55, 0.7, 0.85], powder: [0.95, 0.95, 0.93], alcohol: [0.75, 0.85, 0.95] };

function landDroplet(p, hit) {
  const owner = hit ? hit.owner : null;
  const pos = hit ? hit.point : new THREE.Vector3(p.x, p.y, p.z);
  if (p.kind === 'alcohol') {
    // Alcohol pools on the table below wherever it lands.
    const pd = spill(pos, p.amount, 'alcohol', null, true);
    if (p.burning) pd.ignite();
    return;
  }
  if (owner && owner.douse) owner.douse(pos, p.amount, p.kind);
  for (const pd of puddles) if (pd.pos.distanceTo(pos) < pd.radius + 0.5) pd.douse(pos, p.amount, p.kind);
}

function dropletMove(p, dt) {
  // Raycast along this step's motion so droplets land on items, not only the table.
  const len = Math.hypot(p.vx, p.vy, p.vz) * dt;
  if (len > 1e-4 && !p.dead) {
    const dir = _v1.set(p.vx, p.vy, p.vz).normalize();
    const hit = raycast({ x: p.x - p.vx * dt, y: p.y - p.vy * dt, z: p.z - p.vz * dt }, dir, len + 0.05, p.exclude);
    if (hit) {
      p.x = hit.point.x; p.y = hit.point.y + 0.02; p.z = hit.point.z;
      landDroplet(p, hit);
      p.dead = true;
      return;
    }
  }
  const src = fire.touching(_v2.set(p.x, p.y, p.z));
  if (!src) return;
  if (p.kind === 'alcohol') {
    // Pouring alcohol onto a fire: the stream catches and carries flame back.
    if (!p.burning) {
      p.burning = true;
      p.cr = 1.2; p.cg = 1.5; p.cb = 3; p.a0 = 0.9;
      fireballs.emit({ x: p.x, y: p.y, z: p.z, vx: p.vx * 0.2, vy: 20, vz: p.vz * 0.2, life: 0.5, s0: 0.6, s1: 3, s: 0.6, lift: 60, drag: 3, a0: 0.5, rot: 0, rv: 1, tint: [0.35, 0.55, 1.6], r: 1, g: 1, b: 1, a: 1 });
    }
    return;
  }
  // Water and powder passing through a flame knock it down (and water flashes to steam).
  if (src.owner && src.owner.douse) {
    src.owner.douse(_v2.clone(), p.amount, p.kind);
    if (p.kind === 'water') {
      emitSmoke(_v2, { size: 0.3, size1: 2.5, alpha: 0.25, life: 1.6, rise: 6, shade: 1.1 });
      if (Math.random() < 0.3) sound.sizzle(0.12);
    }
    p.dead = true;
  }
}

/** Emitters run on simulation time so slow motion slows the pour too. */
const emitters = [];

export function pourStream(from, dir, { kind = 'water', count = 60, speed = 45, spread = 0.12, amount = 1, exclude = null, duration = 1 } = {}) {
  const color = COLORS[kind];
  emitters.push({
    t: 0, duration, count, emitted: 0,
    emit(n) {
      for (let i = 0; i < n; i++) {
        const s = speed * rand(0.85, 1.1);
        droplets.emit({
          x: from.x + rand(-0.15, 0.15), y: from.y, z: from.z + rand(-0.15, 0.15),
          vx: (dir.x + rand(-spread, spread)) * s, vy: (dir.y + rand(-spread, spread)) * s, vz: (dir.z + rand(-spread, spread)) * s,
          life: 3, s: kind === 'powder' ? rand(0.1, 0.25) : rand(0.12, 0.22), a0: kind === 'powder' ? 0.85 : 0.6,
          cr: color[0], cg: color[1], cb: color[2], r: 1, g: 1, b: 1, a: 1,
          drag: kind === 'powder' ? 2.5 : 0.2, gscale: kind === 'powder' ? 0.5 : 1,
          kind, amount, exclude, onMove: dropletMove, onLand: (p) => landDroplet(p, null),
        });
      }
      if (kind !== 'powder') sound.setPour(0.25);
    },
    end() { if (kind !== 'powder') sound.setPour(0); },
  });
}

// ---------------------------------------------------------------------------
// Flammable gas jets (aerosol) and dust clouds (flour).

export const gasJets = [];
export const clouds = [];

/** Spray propellant: invisible-ish mist that turns into a jet of fire if it meets a flame. */
export function sprayGas(from, dir, { owner = null, count = 90, duration = 1.2 } = {}) {
  emitters.push({
    t: 0, duration, count, emitted: 0,
    emit(n) {
      for (let i = 0; i < n; i++) {
        const s = rand(160, 260);
        const p = fireballs.emit({
          x: from.x, y: from.y, z: from.z,
          vx: dir.x * s + rand(-15, 15), vy: dir.y * s + rand(-10, 20), vz: dir.z * s + rand(-15, 15),
          life: rand(0.35, 0.6), s0: 0.2, s1: 3.5, s: 0.2, lift: 30, drag: 4.5, a0: 0.0, rot: rand(0, 6), rv: rand(-2, 2),
          tint: [0.0, 0.0, 0.0], r: 0, g: 0, b: 0, a: 0,
        });
        gasJets.push({ p, owner, lit: false });
      }
      sound.setHiss(0.22);
    },
    end() { sound.setHiss(0); },
  });
}

function updateEmitters(dt) {
  for (let i = emitters.length - 1; i >= 0; i--) {
    const e = emitters[i];
    e.t += dt;
    const due = Math.min(e.count, Math.round((e.t / e.duration) * e.count));
    if (due > e.emitted) { e.emit(due - e.emitted); e.emitted = due; }
    if (e.emitted >= e.count) { emitters.splice(i, 1); e.end(); }
  }
}

/** Throw a cloud of fine powder. Flour dust in air is explosive. */
export function throwDust(from, vel, { count = 80, flammable = true } = {}) {
  for (let i = 0; i < count; i++) {
    const s = rand(0.7, 1.15);
    const p = fireballs.emit({
      x: from.x + rand(-0.4, 0.4), y: from.y + rand(-0.2, 0.4), z: from.z + rand(-0.4, 0.4),
      vx: vel.x * s + rand(-18, 18), vy: vel.y * s + rand(-8, 18), vz: vel.z * s + rand(-18, 18),
      life: rand(2.5, 4), s0: 0.5, s1: rand(3, 6), s: 0.5, lift: -20, drag: 2.2, a0: 0.35, rot: rand(0, 6), rv: rand(-1, 1),
      tint: [0, 0, 0], r: 1, g: 1, b: 1, a: 0.35,
    });
    p.dust = true;
    clouds.push({ p, lit: false, flammable });
  }
}

// Fireball particles are additive, so unlit gas and dust are drawn as dark
// (invisible) puffs plus normal-blended smoke puffs for the visible mist.
export function updateGasAndDust(dt) {
  updateEmitters(dt);
  // Gas jet: find ignition.
  let jetLit = 0;
  for (let i = gasJets.length - 1; i >= 0; i--) {
    const g = gasJets[i];
    const p = g.p;
    if (p.age >= p.life || p.dead) { gasJets.splice(i, 1); continue; }
    if (!g.lit) {
      const pos = _v1.set(p.x, p.y, p.z);
      const src = fire.touching(pos, g.owner, 0.3);
      const nearLit = gasJets.some((o) => o.lit && Math.abs(o.p.x - p.x) + Math.abs(o.p.y - p.y) + Math.abs(o.p.z - p.z) < 2.5);
      if (src || nearLit) {
        g.lit = true;
        p.tint = [1, 1, 1];
        p.a0 = 0.8;
        p.life = p.age + rand(0.25, 0.5);
        p.s1 *= 1.3;
      } else {
        // Unlit propellant: faint visible mist.
        p.tint = [0, 0, 0];
        if (Math.random() < 0.12) smokeSys.emit({ x: p.x, y: p.y, z: p.z, vx: p.vx * 0.3, vy: 0, vz: p.vz * 0.3, rise: 1, life: 0.8, s0: 0.3, s1: 1.8, s: 0.3, a0: 0.07, a: 0, rot: 0, rv: 0, seed: rand(0, 99), shade: 1.2, cr: 1, cg: 1, cb: 1, scale: 1, r: 1, g: 1, b: 1 });
      }
    }
    if (g.lit) {
      jetLit++;
      fire.add({ x: p.x, y: p.y - 0.5, z: p.z, h: 2.5, r: 1.2, power: 2.4, owner: g.owner, kind: 'gasjet' });
    }
  }
  if (jetLit > 6) sound.setRoar(0.5);

  // Dust clouds: a flame lights one particle; fire runs through the cloud.
  let ignitedNow = 0;
  for (let i = clouds.length - 1; i >= 0; i--) {
    const c = clouds[i];
    const p = c.p;
    if (p.age >= p.life || p.dead) { clouds.splice(i, 1); continue; }
    if (c.lit) {
      fire.add({ x: p.x, y: p.y, z: p.z, h: 3, r: 2, power: 3, owner: null, kind: 'dust' });
      continue;
    }
    // Unlit dust: draw as a pale cloud (darken the additive puff to near zero
    // and add a normal-blended smoke puff for the visible white).
    p.tint = [0, 0, 0];
    if (Math.random() < dt * 8) smokeSys.emit({ x: p.x, y: p.y, z: p.z, vx: p.vx * 0.2, vy: p.vy * 0.2, vz: p.vz * 0.2, rise: -0.5, life: 0.6, s0: p.s * 0.8, s1: p.s * 1.1, s: p.s, a0: 0.28, a: 0, rot: rand(0, 6), rv: 0, seed: rand(0, 99), shade: 1.05, cr: 1, cg: 0.97, cb: 0.9, scale: 1, r: 1, g: 1, b: 1 });
    if (!c.flammable) continue;
    const pos = _v1.set(p.x, p.y, p.z);
    const src = fire.touching(pos, null, 0.6);
    const near = clouds.some((o) => o.lit && Math.abs(o.p.x - p.x) + Math.abs(o.p.y - p.y) + Math.abs(o.p.z - p.z) < 5);
    if (src || near) {
      c.lit = true;
      ignitedNow++;
      p.tint = [1, 0.95, 0.9];
      p.a0 = 0.9;
      p.age = 0;
      p.life = rand(0.5, 0.9);
      p.s0 = p.s; p.s1 = p.s * 2.6;
      p.lift = 200;
      p.vx *= 3; p.vy = p.vy * 3 + 60; p.vz *= 3;
    }
  }
  if (ignitedNow > 0 && !S.dustBoomT) {
    S.dustBoomT = 1.2;
    const lit = clouds.filter((c) => c.lit);
    const cx = lit.reduce((a, c) => a + c.p.x, 0) / lit.length;
    const cy = lit.reduce((a, c) => a + c.p.y, 0) / lit.length;
    const cz = lit.reduce((a, c) => a + c.p.z, 0) / lit.length;
    const pos = new THREE.Vector3(cx, cy, cz);
    sound.whoomp(1.3);
    flash(pos, { size: 30, strength: 1.8, dur: 0.6 });
    emitFireball(pos, { n: 40, radius: 5, speed: 60, size: 3, size1: 11, life: 1.2 });
    fire.pulse(pos, { h: 10, r: 8, power: 4, ttl: 0.6 });
    shake(0.3);
  }
  if (S.dustBoomT) S.dustBoomT = Math.max(0, S.dustBoomT - dt) || 0;
}

export function clearEffects() {
  for (const p of [...puddles]) p.dispose();
  gasJets.length = 0;
  clouds.length = 0;
  emitters.length = 0;
  sound.setPour(0);
  sound.setHiss(0);
}

export { explode };
