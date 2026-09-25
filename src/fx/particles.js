import * as THREE from 'three';
import { scene, onResize } from '../core/stage.js';
import { S } from '../core/state.js';
import { clamp, damp, lerp, rand, radialTexture, makeCanvas, smoothstep } from '../core/util.js';

/** A pool of camera-facing point sprites with a per-particle update function. */
export class Particles {
  constructor(max, { map, blending = THREE.AdditiveBlending, update, order = 5 }) {
    this.max = max;
    this.list = [];
    this.updateFn = update;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.rot = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('psize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('prot', new THREE.BufferAttribute(this.rot, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: map }, uScale: { value: 800 } },
      vertexShader: /* glsl */ `
        attribute vec4 pcolor; attribute float psize; attribute float prot; uniform float uScale;
        varying vec4 vC; varying float vR;
        void main(){
          vC = pcolor; vR = prot;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = psize * uScale / max(0.1, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map; varying vec4 vC; varying float vR;
        void main(){
          vec2 c = gl_PointCoord - 0.5; float s = sin(vR), co = cos(vR);
          c = mat2(co, -s, s, co) * c;
          vec4 t = texture2D(map, c + 0.5);
          gl_FragColor = vec4(vC.rgb * t.rgb, vC.a * t.a);
        }`,
      transparent: true,
      depthWrite: false,
      blending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = order;
    scene.add(this.points);
    onResize((px) => { this.mat.uniforms.uScale.value = px; });
  }

  emit(p) {
    if (this.list.length >= this.max) this.list.shift();
    p.age = 0;
    this.list.push(p);
    return p;
  }

  update(dt) {
    const L = this.list;
    for (let i = L.length - 1; i >= 0; i--) {
      const p = L[i];
      p.age += dt;
      if (p.age >= p.life || p.dead) { L[i] = L[L.length - 1]; L.pop(); }
    }
    for (let i = 0; i < L.length; i++) {
      const p = L[i];
      this.updateFn(p, dt);
      this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
      this.col[i * 4] = p.r; this.col[i * 4 + 1] = p.g; this.col[i * 4 + 2] = p.b; this.col[i * 4 + 3] = p.a;
      this.size[i] = p.s;
      this.rot[i] = p.rot || 0;
    }
    this.geo.setDrawRange(0, L.length);
    for (const k of ['position', 'pcolor', 'psize', 'prot']) this.geo.attributes[k].needsUpdate = true;
  }
}

export const softDot = radialTexture([[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,255,255,0.8)'], [1, 'rgba(255,255,255,0)']], 64);
export const glowTex = radialTexture([[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.45)'], [1, 'rgba(255,255,255,0)']]);
export const scorchTex = radialTexture([[0, 'rgba(10,6,3,0.85)'], [0.45, 'rgba(25,14,6,0.5)'], [1, 'rgba(30,18,8,0)']]);

function puffTexture() {
  const c = makeCanvas(128, 128);
  const g = c.getContext('2d');
  for (let i = 0; i < 14; i++) {
    const x = 64 + rand(-18, 18), y = 64 + rand(-18, 18), r = rand(18, 42);
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.22)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  }
  return new THREE.CanvasTexture(c);
}
const puffTex = puffTexture();

function flakeTexture() {
  const c = makeCanvas(64, 64);
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.beginPath();
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2, r = rand(14, 28);
    g.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r);
  }
  g.fill();
  return new THREE.CanvasTexture(c);
}
const flakeTex = flakeTexture();

/** Returns the height of the ground under a point (set by the world module). */
export const surface = { heightAt: () => 0 };

// Sparks: hot, fast, bounce once or twice. Colour green lives in `g`, so
// per-particle gravity is `grav`.
export const sparks = new Particles(1400, {
  map: softDot,
  update(p, dt) {
    p.vy -= (p.grav ?? 500) * dt;
    const drag = Math.max(0, 1 - dt * (p.drag ?? 5));
    p.vx *= drag; p.vy *= drag; p.vz *= drag;
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    const floor = surface.heightAt(p.x, p.z) + 0.01;
    if (p.y < floor) { p.y = floor; p.vy *= -0.35; p.vx *= 0.5; p.vz *= 0.5; }
    const k = p.age / p.life, n = 1 - k;
    const hot = p.hot ?? 1;
    p.r = (4.5 * n + 0.6) * hot;
    p.g = (2.2 * n * n + 0.15) * hot;
    p.b = 0.6 * n * n * n * hot;
    p.a = n;
    p.s = p.s0 * (1 - k * 0.5);
  },
});

// Smoke: normal blending, rises, spreads, drifts with wind.
export const smoke = new Particles(1400, {
  map: puffTex,
  blending: THREE.NormalBlending,
  order: 6,
  update(p, dt) {
    const k = p.age / p.life;
    p.vy = damp(p.vy, p.rise, 1.5, dt);
    const w = S.windVec, sc = p.scale;
    p.vx = damp(p.vx, (w.x * 1.6 + Math.sin(p.age * 2.3 + p.seed) * 0.25) * sc, 1.2, dt);
    p.vz = damp(p.vz, (w.z * 1.6 + Math.cos(p.age * 1.9 + p.seed) * 0.2) * sc, 1.2, dt);
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    p.s = lerp(p.s0, p.s1, Math.sqrt(k));
    p.a = p.a0 * smoothstep(0, 0.08, k) * (1 - k) * (1 - k);
    p.rot += p.rv * dt;
    p.r = p.cr * p.shade; p.g = p.cg * p.shade; p.b = p.cb * p.shade;
  },
});

// Fireball / burst puffs: additive, orange to dark, used by explosions and dust.
export const fireballs = new Particles(700, {
  map: puffTex,
  order: 7,
  update(p, dt) {
    const k = p.age / p.life;
    const drag = 1 - Math.min(1, dt * (p.drag ?? 3));
    p.vx *= drag; p.vy = p.vy * drag + (p.lift ?? 120) * dt; p.vz *= drag;
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    p.s = lerp(p.s0, p.s1, 1 - Math.pow(1 - k, 2));
    const heat = 1 - smoothstep(0.0, 0.75, k);
    const tint = p.tint ?? [1, 1, 1];
    p.r = (1.6 * heat + 0.1) * tint[0] * 2.2;
    p.g = (0.7 * heat * heat + 0.03) * tint[1] * 2.2;
    p.b = 0.18 * heat * heat * heat * tint[2] * 2.2;
    p.a = (1 - k) * (p.a0 ?? 0.9);
    p.rot += (p.rv ?? 0.5) * dt;
  },
});

// Dust motes floating in the room light.
export const motes = new Particles(160, {
  map: softDot,
  update(p, dt) {
    p.x += (p.vx + S.windVec.x * 12) * dt;
    p.y += p.vy * dt + Math.sin(S.simTime * 0.5 + p.seed) * 0.4 * dt;
    p.z += (p.vz + S.windVec.z * 12) * dt;
    if (p.x > 26) p.x = -26; if (p.x < -26) p.x = 26;
    if (p.y > 16) p.y = 0.6; if (p.y < 0.4) p.y = 15;
    let e = 0.05;
    for (const f of motesLights) {
      const d2 = (p.x - f.x) ** 2 + (p.y - f.y) ** 2 + (p.z - f.z) ** 2;
      e += (f.size * 2.2) / (1 + d2 * 0.2);
    }
    p.r = e; p.g = 0.72 * e; p.b = 0.45 * e;
    p.a = clamp(e, 0, 0.9) * (0.6 + 0.4 * Math.sin(S.simTime * 1.3 + p.seed));
    p.age = 0;
  },
});
export const motesLights = [];
for (let i = 0; i < 160; i++) {
  motes.emit({ x: rand(-26, 26), y: rand(0.6, 15), z: rand(-18, 10), vx: rand(-0.3, 0.3), vy: rand(-0.2, 0.2), vz: rand(-0.3, 0.3), life: 1e9, s: rand(0.03, 0.06), seed: rand(0, 99), r: 1, g: 1, b: 1, a: 0 });
}

// Liquid / powder droplets: fall with gravity and call back when they land.
export const droplets = new Particles(900, {
  map: softDot,
  blending: THREE.NormalBlending,
  order: 6,
  update(p, dt) {
    p.vy -= 981 * dt * (p.gscale ?? 1);
    const drag = 1 - Math.min(1, dt * (p.drag ?? 0.2));
    p.vx *= drag; p.vy *= drag; p.vz *= drag;
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    if (p.onMove) p.onMove(p, dt);
    const floor = surface.heightAt(p.x, p.z, p);
    if (p.y < floor + 0.02 && !p.dead) {
      p.y = floor + 0.02;
      if (p.onLand) p.onLand(p);
      p.dead = true;
    }
    const k = p.age / p.life;
    p.r = p.cr; p.g = p.cg; p.b = p.cb;
    p.a = p.a0 * (1 - k * k);
  },
});

// Ash flakes: drift up in the plume, then flutter down.
export const ash = new Particles(500, {
  map: flakeTex,
  blending: THREE.NormalBlending,
  order: 6,
  update(p, dt) {
    const k = p.age / p.life;
    p.vy = damp(p.vy, p.age < p.up ? 18 : -6, 1.2, dt);
    p.vx = damp(p.vx, S.windVec.x * 50 + Math.sin(p.age * 3 + p.seed) * 6, 2, dt);
    p.vz = damp(p.vz, S.windVec.z * 50 + Math.cos(p.age * 2.4 + p.seed) * 6, 2, dt);
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    if (p.y < 0.02) { p.y = 0.02; p.vx = p.vz = 0; }
    p.rot += p.rv * dt;
    const glow = Math.max(0, 1 - p.age / p.glow);
    p.r = 0.08 + glow * 3; p.g = 0.07 + glow * 0.9; p.b = 0.06 + glow * 0.1;
    p.a = (1 - k) * 0.9;
  },
});

export function emitSparks(pos, n, dir, speed = 90, spread = 45, opts = {}) {
  for (let i = 0; i < n; i++) {
    sparks.emit({
      x: pos.x + rand(-0.04, 0.04), y: pos.y + rand(-0.04, 0.04), z: pos.z + rand(-0.03, 0.06),
      vx: dir.x * speed * rand(0.2, 1) + rand(-spread, spread),
      vy: dir.y * speed * rand(0.2, 1) + rand(0, spread * 1.2),
      vz: dir.z * speed * rand(0.2, 1) + rand(0, spread * 0.6),
      life: rand(0.18, 0.6) * (opts.lifeK ?? 1), s0: rand(0.03, 0.07) * (opts.sizeK ?? 1), s: 0.05,
      grav: opts.grav, hot: opts.hot, drag: opts.drag,
      r: 1, g: 1, b: 1, a: 1,
    });
  }
}

export function emitSmoke(pos, { size = 0.12, size1 = 1.1, alpha = 0.22, life = 3.2, rise = 0.9, shade = 0.55, spread = 0.03, color = [1, 1, 1] } = {}) {
  const scale = Math.max(1, rise / 0.9);
  smoke.emit({
    x: pos.x + rand(-spread, spread), y: pos.y, z: pos.z + rand(-spread, spread),
    vx: 0, vy: rise * 0.6, vz: 0, rise: rise * rand(0.8, 1.2), life: life * rand(0.8, 1.2),
    s0: size, s1: size1 * rand(0.8, 1.3), s: size, a0: alpha, a: 0, rot: rand(0, 6.28), rv: rand(-0.8, 0.8),
    seed: rand(0, 99), shade: shade * rand(0.85, 1.1), cr: color[0], cg: color[1], cb: color[2], scale,
    r: 1, g: 1, b: 1,
  });
}

export function emitFireball(pos, { n = 30, radius = 3, speed = 60, life = 1.2, size = 2, size1 = 8, lift = 120, tint } = {}) {
  for (let i = 0; i < n; i++) {
    const a = rand(0, Math.PI * 2), u = rand(-0.3, 1);
    const dx = Math.cos(a) * Math.sqrt(1 - u * u), dz = Math.sin(a) * Math.sqrt(1 - u * u);
    const sp = speed * rand(0.4, 1.2);
    fireballs.emit({
      x: pos.x + dx * radius * rand(0, 0.5), y: pos.y + u * radius * 0.4, z: pos.z + dz * radius * rand(0, 0.5),
      vx: dx * sp, vy: u * sp + rand(10, 40), vz: dz * sp,
      life: life * rand(0.6, 1.2), s0: size * rand(0.6, 1.2), s1: size1 * rand(0.7, 1.3), s: size,
      lift, rot: rand(0, 6.28), rv: rand(-1, 1), tint, r: 1, g: 1, b: 1, a: 1,
    });
  }
}

export function emitAsh(pos, n = 1, glow = 1.2) {
  for (let i = 0; i < n; i++) {
    ash.emit({
      x: pos.x + rand(-0.4, 0.4), y: pos.y + rand(0, 0.5), z: pos.z + rand(-0.4, 0.4),
      vx: rand(-4, 4), vy: rand(6, 16), vz: rand(-4, 4), up: rand(0.6, 1.8),
      life: rand(3, 6), s: rand(0.15, 0.4), rot: rand(0, 6.28), rv: rand(-3, 3), seed: rand(0, 99), glow: rand(0.3, glow),
      r: 1, g: 1, b: 1, a: 1,
    });
  }
}

// A single bright flash sprite, used on ignition and explosions.
const flashes = [];
export function flash(pos, { size = 3.2, color = 0xfff0c8, dur = 0.45, strength = 1.4 } = {}) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
  sp.renderOrder = 11;
  sp.position.copy(pos);
  scene.add(sp);
  flashes.push({ sp, t: 0, size, dur, strength });
}

export function updateParticles(dt) {
  sparks.update(dt);
  smoke.update(dt);
  fireballs.update(dt);
  motes.update(dt);
  droplets.update(dt);
  ash.update(dt);
  for (let i = flashes.length - 1; i >= 0; i--) {
    const f = flashes[i];
    f.t += dt;
    const k = Math.min(1, f.t / f.dur);
    const s = lerp(f.size * 0.12, f.size, 1 - Math.pow(1 - k, 3));
    f.sp.scale.set(s, s, 1);
    f.sp.material.opacity = (1 - k) * (1 - k) * f.strength;
    if (k >= 1) { scene.remove(f.sp); f.sp.material.dispose(); flashes.splice(i, 1); }
  }
}
