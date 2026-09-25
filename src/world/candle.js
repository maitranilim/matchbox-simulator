import * as THREE from 'three';
import { scene } from '../core/stage.js';
import { S } from '../core/state.js';
import { damp, rand, toast, _v1, _v2 } from '../core/util.js';
import { PhysicsBody } from '../physics/physics.js';
import { Flame } from '../fx/flame.js';
import { emitSmoke } from '../fx/particles.js';
import { fire } from '../fire/fire.js';
import { sound } from '../audio/sound.js';

const HOLDER_TOP = 0.13;
const holderProfile = [[0, 0], [1.05, 0], [1.12, 0.05], [1.1, 0.13], [0.7, 0.1], [0.7, 0.25], [0.64, 0.26], [0.62, 0.13], [0, 0.13]].map(([x, y]) => new THREE.Vector2(x, y));
const holderGeo = new THREE.LatheGeometry(holderProfile, 64);
const waxGeo = new THREE.CylinderGeometry(0.56, 0.58, 1, 56, 1);
const poolGeo = new THREE.CircleGeometry(0.5, 40);
const wickGeo = new THREE.CylinderGeometry(0.02, 0.028, 0.32, 8);

/** A small candle in a brass holder. Wax slowly burns down; it can be knocked over. */
export class Candle {
  constructor(pos, { height = 2.3, color = 0xf1e5cc, name = 'Candle' } = {}) {
    this.kind = 'candle';
    this.name = name;
    this.material = 'wax';
    this.group = new THREE.Group();
    this.group.position.copy(pos);
    scene.add(this.group);
    const brass = new THREE.MeshStandardMaterial({ color: 0xb58f55, metalness: 1, roughness: 0.32 });
    this.holder = new THREE.Mesh(holderGeo, brass);
    this.waxMat = new THREE.MeshPhysicalMaterial({ color, roughness: 0.42, sheen: 0.4, emissive: new THREE.Color(0xff8a40), emissiveIntensity: 0 });
    this.body = new THREE.Mesh(waxGeo, this.waxMat);
    this.poolMat = new THREE.MeshStandardMaterial({ color: 0xfff0d8, roughness: 0.15, emissive: new THREE.Color(0xffa050), emissiveIntensity: 0, transparent: true, opacity: 0.95 });
    this.pool = new THREE.Mesh(poolGeo, this.poolMat);
    this.pool.rotation.x = -Math.PI / 2;
    this.wickMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9, emissive: new THREE.Color(0xff5a10), emissiveIntensity: 0 });
    this.wick = new THREE.Mesh(wickGeo, this.wickMat);
    this.wick.rotation.z = 0.12;
    for (const m of [this.holder, this.body]) { m.castShadow = true; m.receiveShadow = true; }
    this.group.add(this.holder, this.body, this.pool, this.wick);
    for (const m of [this.holder, this.body, this.pool, this.wick]) m.userData.item = this;

    this.height = height;
    this.physHeight = height;
    this.lit = false;
    this.flame = null;
    this.heatProg = 0;
    this.smokeT = 0;
    this.glow = 0;
    this.layout();
  }

  top() { return HOLDER_TOP + this.height; }
  wickTip(t = new THREE.Vector3()) { return this.group.localToWorld(t.set(0.02, this.top() + 0.3, 0)); }

  shapes() {
    return [
      { type: 'cylinder', hh: 0.065, r: 1.1, pos: [0, 0.065, 0], density: 8.5, friction: 0.5 },
      { type: 'cylinder', hh: this.height / 2, r: 0.57, pos: [0, HOLDER_TOP + this.height / 2, 0], density: 0.9, friction: 0.6 },
    ];
  }

  initPhysics() {
    this.phys = new PhysicsBody(this.group, { shapes: this.shapes(), owner: this, restitution: 0.05, angularDamping: 0.3 });
  }

  /** Mass in grams (live from the physics body). */
  get mass() { return this.phys ? this.phys.mass : 0; }

  layout() {
    this.body.scale.y = this.height;
    this.body.position.y = HOLDER_TOP + this.height / 2;
    this.pool.position.y = this.top() + 0.002;
    this.wick.position.set(0.01, this.top() + 0.14, 0);
  }

  ignite() {
    if (this.lit || this.height <= 0.5) return;
    this.lit = true;
    this.flame = new Flame({ height: 1.25, width: 0.5, blue: 1, intensity: 2.2, speed: 0.75 });
    this.flame.size = 0.1;
    this.flame.base.copy(this.wickTip(_v1)).y -= 0.12;
    sound.burst({ dur: 0.5, f0: 500, f1: 1500, q: 0.7, gain: 0.3, attack: 0.03 });
    toast(`The ${this.name.toLowerCase()} is lit.`);
  }

  extinguish(msg) {
    if (!this.lit) return;
    this.lit = false;
    this.flame.die();
    this.flame = null;
    this.smokeT = 4;
    if (msg) toast(msg);
    sound.fizz();
  }

  douse() { this.extinguish(); this.heatProg = 0; }

  addHeat() {
    if (!this.lit || !this.flame) return;
    const f = this.flame;
    fire.add({ x: f.base.x, y: f.base.y, z: f.base.z, h: Math.max(0.3, f.visibleHeight), r: Math.max(0.15, f.width * f.size * 0.5), power: f.size * 1.1, owner: this, kind: 'candle' });
  }

  heatFrom(dt) {
    if (this.lit || this.height <= 0.5) { this.heatProg = 0; return; }
    const tip = this.wickTip(_v1);
    // A flame actually touching the wick lights it quickly, as it does for real.
    const e = fire.exposure(tip, this) + (fire.touching(tip, this, 0.05) ? 1.2 : 0);
    this.heatProg = Math.max(0, this.heatProg + dt * (e - 0.3));
    if (this.heatProg > 0.5) { this.heatProg = 0; this.ignite(); }
  }

  update(dt) {
    const up = _v2.set(0, 1, 0).applyQuaternion(this.group.quaternion).y;
    if (this.lit) {
      this.height = Math.max(0.5, this.height - dt * 0.0035);
      if (this.height <= 0.5) this.extinguish(`The ${this.name.toLowerCase()} burned all the way down.`);
      this.glow = damp(this.glow, 1, 1.5, dt);
      if (this.flame) {
        this.flame.base.copy(this.wickTip(_v1)).y -= 0.12;
        this.flame.target = (1 - 0.2 * S.wind) * (up < 0.3 ? 0.6 : 1);
        const w = S.windVec.length();
        if (w > 0.78 && Math.random() < dt * (w - 0.78) * 1.2) this.extinguish('A gust blew the candle out.');
        if (up < -0.2 && Math.random() < dt * 2) this.extinguish('The candle smothered itself upside down.');
        if (Math.random() < dt * 2) emitSmoke(this.flame.tip(), { size: 0.05, size1: 0.5, alpha: 0.06, life: 2.4, rise: 1.2, shade: 0.35, spread: 0.02 });
      }
    } else {
      this.glow = Math.max(0, this.glow - dt * 0.5);
      if (this.smokeT > 0) {
        this.smokeT -= dt;
        const k = this.smokeT / 4;
        if (Math.random() < dt * 40 * k * k + dt * 2) emitSmoke(this.wickTip(_v1), { size: 0.04, size1: 0.9, alpha: 0.28 * (0.3 + k), life: 4, rise: 0.75, shade: 0.7, spread: 0.01 });
      }
    }
    this.waxMat.emissiveIntensity = 0.03 * this.glow;
    this.poolMat.emissiveIntensity = 0.45 * this.glow * (this.flame ? this.flame.flicker : 1);
    this.wickMat.emissiveIntensity = this.lit ? 3 : this.smokeT > 0 ? 3 * (this.smokeT / 4) ** 2 : 0;
    this.layout();
    // Rebuild the collider once the wax has visibly burned down.
    if (this.phys && this.physHeight - this.height > 0.08) {
      this.physHeight = this.height;
      this.phys.setShapes(this.shapes(), { keepMass: false });
    }
  }

  reset(height = 2.3) {
    this.height = height;
    this.physHeight = height;
    this.layout();
    if (this.phys) this.phys.setShapes(this.shapes(), { keepMass: false });
  }

  dispose() {
    if (this.flame) this.flame.dispose();
    if (this.phys) { this.phys.dispose(); this.phys = null; }
    scene.remove(this.group);
  }

  /** Take it off the table (used for cupboard candles). */
  remove() {
    if (this.removed) return;
    this.removed = true;
    this.dispose();
    const i = S.items.indexOf(this);
    if (i >= 0) S.items.splice(i, 1);
    if (S.selected === this) S.selected = null;
  }

  get temperature() { return this.lit ? 1000 : 20; }
  get burning() { return this.lit; }

  statusText() {
    return this.lit ? 'Burning' : this.height <= 0.5 ? 'Burned down' : 'Unlit';
  }
}
