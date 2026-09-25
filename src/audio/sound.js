import { rand } from '../core/util.js';

/** Procedural Web Audio: everything is filtered noise and a few oscillators. */
export const sound = {
  ctx: null,
  muted: false,

  init() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.ratio.value = 6;
    this.master.connect(comp);
    comp.connect(ctx.destination);
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    const loop = (type, freq, q) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(f); f.connect(g); g.connect(this.master);
      src.start();
      return { f, g };
    };
    this.scratch = loop('bandpass', 2400, 0.8);
    this.roar = loop('lowpass', 520, 0.7);
    this.hissLoop = loop('highpass', 3500, 0.5);
    this.pourLoop = loop('bandpass', 900, 2.5);
  },

  now() { return this.ctx ? this.ctx.currentTime : 0; },

  setScratch(v, speed) {
    if (!this.ctx) return;
    const t = this.now();
    this.scratch.g.gain.setTargetAtTime(v, t, 0.025);
    this.scratch.f.frequency.setTargetAtTime(1300 + speed * 180, t, 0.03);
  },
  setRoar(v) { if (this.ctx) this.roar.g.gain.setTargetAtTime(v, this.now(), 0.12); },
  setHiss(v) { if (this.ctx) this.hissLoop.g.gain.setTargetAtTime(v, this.now(), 0.05); },
  setPour(v) {
    if (!this.ctx) return;
    this.pourLoop.g.gain.setTargetAtTime(v, this.now(), 0.06);
    this.pourLoop.f.frequency.setTargetAtTime(700 + Math.random() * 500, this.now(), 0.05);
  },

  burst({ dur = 0.3, f0 = 1000, f1 = f0, type = 'bandpass', q = 1, gain = 0.5, attack = 0.005 }) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = rand(0.9, 1.1);
    const f = ctx.createBiquadFilter();
    f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(1e-4, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(1e-4, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t, rand(0, 1.5));
    src.stop(t + dur + 0.05);
  },

  tone({ f0 = 90, f1 = 40, dur = 0.25, gain = 0.4, type = 'sine' }) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(1e-4, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(1e-4, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  },

  ignite() {
    this.burst({ dur: 0.75, f0: 700, f1: 3800, q: 0.5, gain: 0.9, attack: 0.008 });
    this.burst({ dur: 0.35, f0: 5000, type: 'highpass', gain: 0.35 });
    this.tone({ f0: 110, f1: 38, dur: 0.3, gain: 0.35 });
  },
  catchFire(size = 1) {
    this.burst({ dur: 0.5 + size * 0.2, f0: 300, f1: 1400, q: 0.6, gain: 0.25 + size * 0.1, attack: 0.04 });
  },
  whoomp(size = 1) {
    this.burst({ dur: 0.9, f0: 180, f1: 900, type: 'lowpass', q: 0.7, gain: 0.7 * size, attack: 0.03 });
    this.tone({ f0: 70, f1: 30, dur: 0.6, gain: 0.5 * size });
  },
  boom(s = 1) {
    this.burst({ dur: 1.6, f0: 900, f1: 60, type: 'lowpass', q: 0.8, gain: 1.0, attack: 0.004 });
    this.burst({ dur: 0.25, f0: 3000, type: 'highpass', gain: 0.5 * s });
    this.tone({ f0: 90, f1: 22, dur: 1.2, gain: 0.9 });
  },
  crackle(v = 0.2) { this.burst({ dur: rand(0.015, 0.04), f0: rand(2000, 5000), type: 'highpass', gain: v }); },
  blow() { this.burst({ dur: 0.65, f0: 250, f1: 700, type: 'lowpass', q: 0.6, gain: 0.8, attack: 0.18 }); },
  fizz() { this.burst({ dur: 0.4, f0: 4000, f1: 1800, type: 'highpass', gain: 0.18, attack: 0.01 }); },
  sizzle(v = 0.3) { this.burst({ dur: rand(0.2, 0.5), f0: 6000, f1: 2500, type: 'highpass', gain: v, attack: 0.01 }); },
  drawer() {
    this.burst({ dur: 0.5, f0: 380, f1: 520, q: 1.4, gain: 0.3, attack: 0.06 });
    this.burst({ dur: 0.08, f0: 900, q: 2, gain: 0.15 });
  },
  tick(v = 0.35) { this.burst({ dur: 0.045, f0: rand(1800, 3200), q: 4, gain: v }); },
  /** Collision sound, pitched by material. */
  knock(v, material = 'wood') {
    const m = {
      wood: [1400, 3], metal: [3200, 12], glass: [4200, 18], soft: [500, 1], paper: [2600, 0.7], plastic: [1900, 4], wax: [900, 2],
    }[material] || [1400, 3];
    this.burst({ dur: material === 'metal' || material === 'glass' ? 0.18 : 0.05, f0: m[0] * rand(0.9, 1.1), q: m[1], gain: v });
  },
  click() { this.burst({ dur: 0.03, f0: 2500, q: 5, gain: 0.2 }); },
  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.now(), 0.05);
  },
};
