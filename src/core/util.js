import * as THREE from 'three';

export const V3 = THREE.Vector3;
export const UP = new V3(0, 1, 0);

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (a, b) => a + Math.random() * (b - a);
export const pick = (arr) => arr[(Math.random() * arr.length) | 0];
/** Frame-rate independent exponential approach. */
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

const NOISE = new Float32Array(1024).map(() => Math.random());
/** Cheap smooth 1D value noise in [0, 1]. */
export function noise1(x) {
  const i = Math.floor(x);
  const f = x - i;
  const a = NOISE[i & 1023];
  const b = NOISE[(i + 1) & 1023];
  return a + (b - a) * f * f * (3 - 2 * f);
}

export const ease = {
  outBack: (t) => 1 + 2.5 * Math.pow(t - 1, 3) + 1.5 * Math.pow(t - 1, 2),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  outBounce(t) {
    if (t < 1 / 2.75) return 7.5625 * t * t;
    if (t < 2 / 2.75) return 7.5625 * (t -= 1.5 / 2.75) * t + 0.75;
    if (t < 2.5 / 2.75) return 7.5625 * (t -= 2.25 / 2.75) * t + 0.9375;
    return 7.5625 * (t -= 2.625 / 2.75) * t + 0.984375;
  },
};

const tweens = [];
/**
 * Run `update(t)` for t in [0, 1] over `dur` seconds.
 * `sim: true` follows simulation time (slow-mo), otherwise wall time.
 */
export function tween(dur, update, { delay = 0, done, sim = false } = {}) {
  const tw = { t: -delay, dur, update, done, sim, dead: false };
  tweens.push(tw);
  return tw;
}
export function updateTweens(realDt, simDt) {
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i];
    if (tw.dead) { tweens.splice(i, 1); continue; }
    tw.t += tw.sim ? simDt : realDt;
    if (tw.t < 0) continue;
    const k = clamp(tw.t / tw.dur, 0, 1);
    tw.update(k);
    if (k >= 1) { tweens.splice(i, 1); tw.done && tw.done(); }
  }
}

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function canvasTexture(canvas, { srgb = true, repeat, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  t.anisotropy = aniso;
  return t;
}

export function radialTexture(stops, size = 128) {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

/** Add per-pixel grain to a canvas. */
export function grain(ctx, w, h, amount = 12) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * amount;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

export const $ = (id) => document.getElementById(id);

// Messages queue up so each one stays on screen long enough to read: when
// two things happen in the same instant (water hits a pan fire and the
// burner under it), the second no longer wipes out the first.
const TOAST_READ_MS = 1600;
const toastQueue = [];
let toastTimer = 0;
let toastWait = 0;
let toastShownAt = -Infinity;
let toastShown = '';

export function toast(msg, ms = 2800) {
  if (!$('toast')) return;
  if (msg === toastShown && performance.now() - toastShownAt < TOAST_READ_MS) return;
  if (toastQueue.some((q) => q[0] === msg)) return;
  toastQueue.push([msg, ms]);
  if (toastQueue.length > 3) toastQueue.shift();
  pumpToasts();
}

function pumpToasts() {
  if (toastWait || !toastQueue.length) return;
  const wait = toastShownAt + TOAST_READ_MS - performance.now();
  if (wait > 0) {
    toastWait = setTimeout(() => { toastWait = 0; pumpToasts(); }, wait);
    return;
  }
  const [msg, ms] = toastQueue.shift();
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  toastShown = msg;
  toastShownAt = performance.now();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  pumpToasts();
}

// Scratch vectors. Only use within a single synchronous block.
export const _v1 = new V3();
export const _v2 = new V3();
export const _v3 = new V3();
export const _v4 = new V3();
export const _q1 = new THREE.Quaternion();
export const _q2 = new THREE.Quaternion();
