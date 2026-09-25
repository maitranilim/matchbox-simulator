import * as THREE from 'three';
import { scene } from '../core/stage.js';
import { BOX, MATCH, S } from '../core/state.js';
import { clamp, damp, ease, lerp, rand, smoothstep, toast, tween, _v1, _v2, _v3 } from '../core/util.js';
import { PhysicsBody, GROUP, ALL, groups } from '../physics/physics.js';
import { Flame } from '../fx/flame.js';
import { emitSmoke, emitSparks, flash } from '../fx/particles.js';
import { fire } from '../fire/fire.js';
import { sound } from '../audio/sound.js';
import { drawer } from './matchbox.js';
import { addScorch, ashtrayHeight } from './table.js';

const GN = MATCH.len;

// While being slid out of the box a match ignores the box itself (the fingers
// guide it past the card), but it still bumps into everything else.
function matchGroups(held) {
  if (held === 'lifting') return groups(GROUP.HELD, ALL & ~GROUP.BOX);
  return held ? groups(GROUP.HELD, ALL) : groups(GROUP.DYNAMIC, ALL);
}
const woodTex = (() => {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#e2c393';
  g.fillRect(0, 0, 64, 512);
  for (let i = 0; i < 26; i++) {
    const x = rand(0, 64);
    g.strokeStyle = `rgba(150,105,55,${rand(0.12, 0.35)})`;
    g.lineWidth = rand(0.5, 2);
    g.beginPath(); g.moveTo(x, 0);
    for (let y = 0; y <= 512; y += 32) g.lineTo(x + Math.sin(y * 0.01 + i) * 2, y);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();

const stickGeo = new THREE.BoxGeometry(MATCH.thick, GN, MATCH.thick, 1, 70, 1);
stickGeo.translate(0, -GN / 2, 0);
const headGeo = (() => {
  const g = new THREE.SphereGeometry(1, 22, 16);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + 0.06 * Math.sin(x * 7.1 + y * 3.3) * Math.cos(z * 5.7 - y * 2.1);
    p.setXYZ(i, x * 0.093 * k, y * 0.16 * k + 0.03, z * 0.093 * k);
  }
  g.computeVertexNormals();
  return g;
})();
const hitGeo = new THREE.BoxGeometry(0.24, GN + 0.25, 0.26).translate(0, -GN / 2 + 0.12, 0);
const hitMat = new THREE.MeshBasicMaterial({ visible: false });
const HEAD_RED = new THREE.Color(0x9c1b12);
const HEAD_CHAR = new THREE.Color(0x1b1512);
const HEAD_CRUMBLE = new THREE.Color(0x4a1c14);

/** Wood that chars along a burn front with a glowing ember band. */
function stickMaterial(u) {
  const m = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.78, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uBurn; uniform float uCurl; varying float vD;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float dd = -position.y; vD = dd;
        float charK = smoothstep(uBurn + 0.04, uBurn - 0.25, dd);
        transformed.xz *= mix(1.0, 0.66, charK);
        float cc = max(0.0, uBurn - dd);
        transformed.x += uCurl * cc * cc;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uBurn; uniform float uEmber; uniform float uTime; varying float vD;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float charT = smoothstep(uBurn + 0.06, uBurn - 0.12, vD);
        float scorch = smoothstep(uBurn + 0.5, uBurn + 0.02, vD) * (1.0 - charT);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.42, 0.27, 0.15), scorch * 0.85);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.022, 0.019, 0.017), charT);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 1.0, charT);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float band = exp(-pow((vD - uBurn) / 0.065, 2.0));
        float flick = 0.7 + 0.3 * sin(uTime * 23.0 + vD * 57.0) * sin(uTime * 6.3 + vD * 13.0);
        float tail = smoothstep(uBurn - 0.55, uBurn, vD) * charT;
        float spots = step(0.82, fract(sin(floor(vD * 40.0) * 91.7) * 4375.5)) * tail;
        totalEmissiveRadiance += vec3(1.0, 0.3, 0.04) * (band * 5.5 + tail * 0.6 + spots * 2.0) * uEmber * flick;`);
  };
  m.customProgramCacheKey = () => 'matchstick-v2';
  return m;
}

export class Match {
  constructor() {
    this.kind = 'match';
    this.material = 'wood';
    this.u = { uBurn: { value: -1 }, uEmber: { value: 0 }, uTime: { value: 0 }, uCurl: { value: 0.035 } };
    this.group = new THREE.Group();
    this.stick = new THREE.Mesh(stickGeo, stickMaterial(this.u));
    this.headMat = new THREE.MeshStandardMaterial({ color: HEAD_RED.clone(), roughness: 0.5, emissive: new THREE.Color(0, 0, 0) });
    this.head = new THREE.Mesh(headGeo, this.headMat);
    for (const m of [this.stick, this.head]) { m.castShadow = true; m.receiveShadow = true; m.userData.match = this; }
    this.hit = new THREE.Mesh(hitGeo, hitMat);
    this.hit.userData.match = this;
    this.group.add(this.stick, this.head, this.hit);

    this.state = 'box'; // box | lifting | held | dropped
    this.slot = null;
    this.phys = null;
    this.lit = false;
    this.everLit = false;
    this.litTime = 0;
    this.flareIgn = false;
    this.burn = -1;
    this.ember = 0;
    this.headHeat = 0;
    this.headChar = 0;
    this.headState = 'fresh'; // fresh | burning | burnt | crumbled
    this.wear = 0;
    this.heatProg = 0;
    this.flame = null;
    this.smokeT = 0;
    this.base = new THREE.Vector3();
    this.hovered = false;
    this.restT = 0;
    this.scorched = false;
    this.crackleT = rand(0.1, 0.4);
  }

  axis(t = new THREE.Vector3()) { return t.set(0, 1, 0).applyQuaternion(this.group.getWorldQuaternion(new THREE.Quaternion())); }
  headWorld(t = new THREE.Vector3()) { return this.head.getWorldPosition(t); }
  burnPointWorld(t = new THREE.Vector3()) {
    const b = clamp(this.burn, 0, GN);
    return b < 0.12 ? this.group.localToWorld(t.set(this.head.position.x, 0.03, 0)) : this.group.localToWorld(t.set(0, -b, 0));
  }
  canIgnite() { return !this.lit && this.headState !== 'crumbled' && this.burn < GN - 0.8 && this.state !== 'lifting'; }

  /**
   * Give the match a rigid body (it has left the box). `held` is false, true,
   * or 'lifting' while fingers slide it out from between the others.
   */
  makePhysical(held) {
    if (this.phys) return;
    scene.attach(this.group);
    this.phys = new PhysicsBody(this.group, {
      shapes: [
        { type: 'box', hx: MATCH.thick / 2, hy: GN / 2, hz: MATCH.thick / 2, pos: [0, -GN / 2, 0], density: 0.45 },
        { type: 'ball', r: 0.095, pos: [0, 0.03, 0], density: 1.6 },
      ],
      friction: 0.55,
      restitution: 0.25,
      ccd: true,
      linearDamping: 0.3,
      angularDamping: 0.6,
      owner: this,
      groups: matchGroups(held),
    });
    // A real safety match (2 mm aspen stick plus head) weighs about 0.09 g.
    this.phys.setMass(MATCH.mass);
  }

  setHeld(held) {
    if (!this.phys) return;
    this.phys.setGroups(matchGroups(held));
    this.phys.body.setAngularDamping(held ? 8 : 0.6);
    this.phys.body.setLinearDamping(held ? 2 : 0.3);
  }

  ignite(byStrike) {
    if (this.lit) return;
    const fresh = this.headState === 'fresh';
    this.lit = true;
    this.everLit = true;
    this.litTime = 0;
    this.flareIgn = fresh;
    this.heatProg = 0;
    if (fresh) { this.headState = 'burning'; this.burn = -0.3; } else this.burn = Math.max(this.burn, 0.12);
    this.flame = new Flame({ height: 1.3, width: 0.6, blue: 0.55, intensity: this.state === 'box' ? 1.3 : 2.4 });
    this.flame.size = fresh ? 0.3 : 0.08;
    this.base.copy(this.burnPointWorld(_v1));
    this.flame.base.copy(this.base);
    S.stats.lit++;
    if (fresh) {
      sound.ignite();
      flash(this.headWorld(_v1));
      const dir = byStrike ? _v2.set(-Math.sign(S.headVel.x || 1), 0.4, 0.3).normalize() : _v2.set(0, 1, 0);
      emitSparks(this.headWorld(_v3), 55, dir, 70, 35);
      for (let i = 0; i < 8; i++) emitSmoke(this.headWorld(_v3), { size: 0.15, size1: 1.2, alpha: 0.28, shade: 0.75, spread: 0.08 });
      if (this.state === 'held') S.camShake = 0.12;
    } else sound.burst({ dur: 0.35, f0: 600, f1: 1800, q: 0.7, gain: 0.35, attack: 0.02 });
  }

  extinguish(reason) {
    if (!this.lit) return;
    this.lit = false;
    if (this.flame) this.flame.die(reason === 'box');
    this.flame = null;
    this.smokeT = reason === 'burnout' ? 1.2 : 3.2;
    if (this.headState === 'burning') this.headState = 'burnt';
    if (reason === 'blow' || reason === 'shake' || reason === 'water') sound.fizz();
    const msg = {
      blow: 'Blown out. Watch the smoke curl.',
      shake: 'Shaken out.',
      wind: 'The wind got it.',
      starve: 'Held head-up too long, so the flame starved.',
      water: 'Doused.',
    }[reason];
    if (msg && this.state === 'held') toast(msg);
  }

  /** Water, powder, smothering. */
  douse() { if (this.lit) this.extinguish('water'); this.heatProg = 0; }

  crumble() {
    this.headState = 'crumbled';
    this.headMat.color.copy(HEAD_CRUMBLE);
    this.head.scale.setScalar(0.6);
    emitSparks(this.headWorld(_v1), 6, _v2.set(0, -1, 0), 20, 12);
    toast('The head crumbled from too much grinding. Drop it and grab another.');
    sound.burst({ dur: 0.15, f0: 1200, q: 1, gain: 0.3 });
  }

  /** Register this match's flame as a heat source. */
  addHeat() {
    if (!this.lit || !this.flame) return;
    const f = this.flame;
    fire.add({ x: this.base.x, y: this.base.y, z: this.base.z, h: Math.max(0.3, f.visibleHeight), r: Math.max(0.15, f.width * f.size * 0.55), power: f.size, owner: this, kind: 'match' });
  }

  /** Catch fire from other flames. */
  heatFrom(dt) {
    if (!this.canIgnite()) { this.heatProg = 0; return; }
    const p = this.headState === 'fresh' ? this.headWorld(_v1) : this.burnPointWorld(_v1);
    const e = fire.exposure(p, this);
    this.heatProg = Math.max(0, this.heatProg + dt * (e - 0.25) * (this.state === 'box' ? rand(0.8, 1.6) : 1));
    const thresh = this.headState === 'fresh' ? 0.3 : 0.9;
    if (this.heatProg > thresh) {
      const inBox = this.state === 'box';
      this.ignite(false);
      if (inBox && !S.flareToast) {
        S.flareToast = true;
        toast('Uh-oh, the matches in the box caught fire! Close the drawer to smother them.');
        setTimeout(() => (S.flareToast = false), 6000);
      }
    }
  }

  update(dt, t) {
    this.u.uTime.value = t;
    const ax = this.axis(_v1);
    const headDown = clamp(-ax.y, 0, 1);
    const headUp = clamp(ax.y, 0, 1);
    if (this.lit) {
      this.litTime += dt;
      if (this.flareIgn) {
        const u = this.litTime;
        this.headHeat = u < 0.12 ? (3.5 * u) / 0.12 : 3.5 * Math.exp(-(u - 0.12) * 2.6) + 0.25 * (1 - smoothstep(0.2, 0.5, this.burn));
        this.headChar = clamp(u / 1.3, 0, 1);
        this.flame.flare = clamp(1 - (u - 0.05) / 0.35, 0, 1);
      } else {
        this.headHeat = damp(this.headHeat, this.burn < 0.3 ? 0.25 : 0, 3, dt);
        this.flame.flare = 0;
      }
      const flareK = this.flareIgn ? (this.litTime < 0.14 ? 1.9 : lerp(1.9, 1, smoothstep(0.14, 1.1, this.litTime))) : 1;
      const tiltK = (0.72 + 0.4 * headDown - 0.15 * headUp) * (1 - 0.18 * S.wind);
      this.flame.target = tiltK * flareK * (this.state === 'box' ? 0.8 : 1);
      if (!this.flareIgn || this.litTime > 0.55) {
        // Head-down burns fast (flame licks fresh wood), head-up starves.
        let rate = 0.13 * (1 + 2.4 * headDown) * (1 - 0.45 * headUp);
        if (this.state === 'box') rate *= 0.75;
        if (this.state === 'dropped') rate *= 1.25;
        if (this.burn < 0.1) rate *= 2.2;
        this.burn += rate * dt;
      }
      this.ember = damp(this.ember, 1, 4, dt);
      this.base.copy(this.burnPointWorld(_v2));
      this.flame.base.copy(this.base);
      if (Math.random() < dt * 6) emitSmoke(this.flame.tip(), { size: 0.06, size1: 0.6, alpha: 0.1, life: 2.6, rise: 1.1, shade: 0.4, spread: 0.02 });
      if (Math.random() < dt * 0.8) emitSparks(this.base, 1, _v3.set(0, 1, 0), 12, 4);
      this.crackleT -= dt;
      if (this.crackleT < 0) { this.crackleT = rand(0.05, 0.45); sound.crackle(rand(0.03, 0.12)); }
      const settled = this.litTime > 1;
      const wind = S.windVec.length();
      if (settled && wind > 0.55 && Math.random() < dt * (wind - 0.55) * 1.3 * (this.state === 'box' ? 0.4 : 1)) this.extinguish('wind');
      else if (settled && headUp > 0.72 && Math.random() < dt * 0.45) this.extinguish('starve');
      else if (this.state === 'dropped' && this.restT > 0.35 && this.burn > 1.6 && Math.random() < dt * 0.05) this.extinguish('burnout');
      else if (this.burn >= GN - 0.04) this.extinguish('burnout');
    } else {
      this.ember = Math.max(0, this.ember - dt * (this.burn >= GN - 0.1 ? 0.6 : 0.28));
      this.headHeat = Math.max(0, this.headHeat - dt * 1.2);
      if (this.smokeT > 0) {
        this.smokeT -= dt;
        const k = this.smokeT / 3.2;
        if (Math.random() < dt * 40 * k * k + dt * 3) emitSmoke(this.burnPointWorld(_v2), { size: 0.05, size1: 0.9, alpha: 0.26 * (0.4 + k), life: 3.6, rise: 0.8, shade: 0.62, spread: 0.015 });
      }
    }
    this.u.uBurn.value = this.everLit ? this.burn : -1;
    this.u.uEmber.value = this.ember;
    if (this.headState !== 'crumbled') {
      this.headMat.color.copy(HEAD_RED).lerp(HEAD_CHAR, this.headChar);
      this.head.scale.setScalar(1 - 0.2 * this.headChar);
      this.head.position.x = this.everLit ? this.u.uCurl.value * Math.max(0, this.burn) ** 2 : 0;
    }
    const glow = this.headHeat + this.heatProg * 2.5 + (this.hovered ? 0.35 : 0);
    this.headMat.emissive.setRGB(glow, 0.32 * glow + (this.hovered ? 0.1 : 0), 0.05 * glow);

    // Resting on the table leaves a scorch mark where it burned.
    if (this.state === 'dropped' && this.phys) {
      const v = this.phys.linvel(_v3).length();
      this.restT = v < 1 ? this.restT + dt : 0;
      if (!this.scorched && this.restT > 0.5 && !this.lit && this.everLit && this.burn >= 1.2) {
        const p = this.group.localToWorld(_v2.set(0, -Math.min(this.burn, GN) * 0.6, 0));
        if (p.y < 0.4 && ashtrayHeight(p.x, p.z) === 0) { this.scorched = true; addScorch(p.x, p.z); }
      }
    }
  }

  dispose() {
    if (this.flame) this.flame.dispose();
    if (this.phys) { this.phys.dispose(); this.phys = null; }
    if (this.group.parent) this.group.parent.remove(this.group);
    this.stick.material.dispose();
    this.headMat.dispose();
  }
}

// Two layers of 12 matches in the tray.
export const slots = [];
for (let layer = 0; layer < 2; layer++) {
  for (let j = 0; j < 12; j++) {
    slots.push({
      layer,
      pos: new THREE.Vector3(BOX.drawerLen / 2 - BOX.wall - 0.24, BOX.wall + 0.07 + layer * 0.118, -BOX.drawerDepth / 2 + BOX.wall + 0.15 + j * 0.262 + layer * 0.13),
      rotY: rand(-0.025, 0.025),
      rotX: rand(-0.2, 0.2),
      match: null,
    });
  }
}

function placeInSlot(m, slot) {
  m.slot = slot;
  slot.match = m;
  m.state = 'box';
  drawer.add(m.group);
  m.group.position.copy(slot.pos);
  m.group.rotation.set(slot.rotX, slot.rotY, -Math.PI / 2);
}

/** Fill every empty (or used) slot with a fresh match. */
export function refillBox(animate) {
  let n = 0;
  for (const slot of slots) {
    if (slot.match) {
      const m = slot.match;
      if (m.everLit || m.headState !== 'fresh') {
        m.dispose();
        S.matches.splice(S.matches.indexOf(m), 1);
        slot.match = null;
      } else continue;
    }
    const m = new Match();
    S.matches.push(m);
    placeInSlot(m, slot);
    if (animate) {
      const y = slot.pos.y, y0 = y + 3.5 + rand(0, 1.2), k = n++;
      m.group.position.y = y0;
      m.group.visible = false;
      tween(0.55, (t) => { m.group.visible = true; m.group.position.y = lerp(y0, y, ease.outBounce(t)); }, {
        delay: k * 0.04,
        done: () => { if (k % 3 === 0) sound.tick(0.12); },
      });
    }
  }
}

export const inBox = () => S.matches.filter((m) => m.state === 'box');
