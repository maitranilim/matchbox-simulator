import * as THREE from 'three';
import { scene, camera } from '../core/stage.js';
import { S } from '../core/state.js';
import { clamp, damp, noise1, rand, UP } from '../core/util.js';
import { glowTex } from './particles.js';

const quad = new THREE.PlaneGeometry(1, 1);
const vert = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }';
const frag = /* glsl */ `
uniform float uTime, uSeed, uLean, uIntensity, uFlare, uBlue, uStretch, uAlpha, uSoot;
uniform vec3 uOuter, uMid, uInner;
varying vec2 vUv;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), u.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y); }
float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ v += a * vnoise(p); p *= 2.03; a *= 0.5; } return v; }
void main(){
  float y = vUv.y;
  float x = (vUv.x - 0.5) * 2.0;
  float t = uTime;
  float n  = fbm(vec2(x * 1.8 + uSeed, y * 2.6 - t * 3.0));
  float n2 = fbm(vec2(x * 4.0 - uSeed * 1.7, y * 6.0 - t * 5.5));
  x += (n - 0.5) * 0.42 * y * y * 1.6 * uStretch + (n2 - 0.5) * 0.08 * y;
  x -= uLean * y * y * 0.9;
  float yy = y - 0.22;
  float h = yy > 0.0 ? yy / (0.72 + (n - 0.5) * 0.12) : -yy / 0.19;
  float hc = clamp(h, 0.0, 1.0);
  float w = yy > 0.0 ? mix(0.3, 0.02, pow(hc, 0.8)) : 0.3 * (1.0 - 0.1 * hc);
  float d = length(vec2(x / w, h));
  float edge = 1.0 + (n2 - 0.5) * 0.25;
  float a = smoothstep(edge, edge * 0.5, d);
  float core = smoothstep(0.78, 0.05, d) * smoothstep(0.9, 0.25, y);
  vec3 col = mix(uOuter, uMid, smoothstep(0.95, 0.45, d));
  col = mix(col, uInner, core * (0.85 + uFlare * 0.15));
  float blue = smoothstep(0.34, 0.1, y) * smoothstep(0.3, 0.95, d) * uBlue;
  col = mix(col, vec3(0.22, 0.42, 1.0), blue * 0.85);
  float dark = smoothstep(0.55, 0.05, d) * smoothstep(0.36, 0.16, y) * (1.0 - uFlare);
  col *= 1.0 - dark * 0.5;
  // Tips cool to a smoky red; sooty fuels get dark ragged tips.
  col = mix(col, vec3(0.9, 0.2, 0.04), smoothstep(0.55, 0.95, y) * 0.5);
  col *= 1.0 - uSoot * smoothstep(0.5, 0.95, y) * (0.5 + n2 * 0.5);
  float alpha = a * (0.7 + 0.3 * core) * uAlpha;
  gl_FragColor = vec4(col * uIntensity * (1.0 + uFlare * 1.4), alpha);
}`;

/** Colour presets for different fuels. */
export const FLAME_COLORS = {
  wood: { outer: [1, 0.33, 0.05], mid: [1, 0.68, 0.24], inner: [1, 0.94, 0.78] },
  alcohol: { outer: [0.18, 0.32, 1.0], mid: [0.35, 0.55, 1.0], inner: [0.75, 0.82, 1.0] },
  gas: { outer: [0.15, 0.3, 1.0], mid: [0.3, 0.5, 1.0], inner: [0.6, 0.85, 1.0] },
  soot: { outer: [1, 0.24, 0.02], mid: [1, 0.52, 0.12], inner: [1, 0.85, 0.5] },
  sparkle: { outer: [1, 0.45, 0.1], mid: [1, 0.8, 0.4], inner: [1, 1, 0.9] },
};

/** Every live flame, used by lights, dust motes and the fire roar sound. */
export const flames = new Set();

const _side = new THREE.Vector3();
const _wind = new THREE.Vector3();
const _tip = new THREE.Vector3();

export class Flame {
  constructor({ height = 0.95, width = 0.5, blue = 0.55, intensity = 2.4, speed = 1, colors = FLAME_COLORS.wood, alpha = 1, soot = 0, glow = 0.4, glowColor = 0xff7a30 } = {}) {
    this.height = height;
    this.width = width;
    this.speed = speed;
    this.seed = rand(0, 50);
    this.size = 0.05;
    this.target = 1;
    this.dying = false;
    this.dead = false;
    this.flare = 0;
    this.leanX = 0;
    this.flicker = 1;
    this.glowK = glow;
    this.base = new THREE.Vector3();
    this.prevBase = null;
    this.vel = new THREE.Vector3();
    this.u = {
      uTime: { value: 0 }, uSeed: { value: this.seed }, uLean: { value: 0 }, uIntensity: { value: intensity },
      uFlare: { value: 0 }, uBlue: { value: blue }, uStretch: { value: 1 }, uAlpha: { value: alpha }, uSoot: { value: soot },
      uOuter: { value: new THREE.Vector3(...colors.outer) }, uMid: { value: new THREE.Vector3(...colors.mid) }, uInner: { value: new THREE.Vector3(...colors.inner) },
    };
    this.mesh = new THREE.Mesh(quad, new THREE.ShaderMaterial({
      uniforms: this.u, vertexShader: vert, fragmentShader: frag,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    this.mesh.renderOrder = 10;
    this.mesh.frustumCulled = false;
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: glowColor, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: glow }));
    this.glow.renderOrder = 9;
    scene.add(this.mesh, this.glow);
    flames.add(this);
  }

  /** Current visible height in cm. */
  get visibleHeight() { return this.height * this.size; }

  die(fast = false) {
    this.dying = true;
    this.target = 0;
    this.dieRate = fast ? 30 : 14;
  }

  update(dt, t) {
    this.size = damp(this.size, this.target, this.dying ? this.dieRate : 7, dt);
    if (this.dying && this.size < 0.02) { this.dispose(); return; }
    if (this.prevBase) this.vel.copy(this.base).sub(this.prevBase).divideScalar(Math.max(dt, 1e-4));
    else this.prevBase = new THREE.Vector3();
    this.prevBase.copy(this.base);

    // Lean away from wind and motion, as seen from the camera.
    _side.set(1, 0, 0).applyQuaternion(camera.quaternion);
    _side.y = 0;
    _side.normalize();
    _wind.copy(S.windVec).multiplyScalar(1.1).addScaledVector(this.vel, -0.06 / Math.max(1, this.height));
    let lean = clamp(_wind.dot(_side), -1.1, 1.1);
    if (S.blowT > 0) lean += (noise1(t * 30 + this.seed) - 0.5) * 2.4 * S.blowT;
    this.leanX = damp(this.leanX, lean, 10, dt);

    const wl = S.windVec.length();
    const flick = 0.9 + 0.1 * noise1(t * 9 * this.speed + this.seed) + 0.06 * (noise1(t * 23 + this.seed * 3) - 0.5) +
      (wl > 0.3 ? (noise1(t * 17 + this.seed) - 0.5) * 0.25 * wl : 0);
    this.flicker = flick;
    const stretch = 1 + clamp(this.vel.length() * 0.03 / Math.max(1, this.height), 0, 0.35);
    const s = this.size * flick;
    const h = this.height * s * stretch;
    const w = this.width * 2 * s;
    this.u.uTime.value = t * this.speed;
    this.u.uLean.value = this.leanX;
    this.u.uFlare.value = this.flare;
    this.u.uStretch.value = 1 + wl * 0.6;
    this.mesh.scale.set(w, h, 1);
    this.mesh.position.copy(this.base).addScaledVector(UP, (0.5 - 0.17) * h);
    this.mesh.rotation.set(0, Math.atan2(camera.position.x - this.mesh.position.x, camera.position.z - this.mesh.position.z), 0);
    this.glow.position.copy(this.base).addScaledVector(UP, 0.3 * h);
    const g = (1.4 + this.flare * 2.5) * s * (this.height / 0.95);
    this.glow.scale.set(g * 1.6, g * 1.9, 1);
    this.glow.material.opacity = clamp(this.glowK * 0.5 * flick + this.flare * 0.45, 0, 1);
  }

  tip(target = _tip) {
    return target.copy(this.base).addScaledVector(UP, this.height * this.size * 0.85);
  }

  dispose() {
    if (this.dead) return;
    this.dead = true;
    scene.remove(this.mesh, this.glow);
    this.mesh.material.dispose();
    this.glow.material.dispose();
    flames.delete(this);
  }
}

export function updateFlames(dt, t) {
  for (const f of [...flames]) f.update(dt, t);
}
