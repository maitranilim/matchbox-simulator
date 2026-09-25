import * as THREE from 'three';
import { camera } from '../core/stage.js';
import { AMBIENT_C, S } from '../core/state.js';
import { clamp, damp, lerp, rand, smoothstep, toast, tween, ease, _v1, _v2, _v3 } from '../core/util.js';
import { hullPoints } from '../physics/physics.js';
import { Flame, FLAME_COLORS } from '../fx/flame.js';
import { emitFireball, emitSmoke, emitSparks, flash, droplets } from '../fx/particles.js';
import { fire, explode } from '../fire/fire.js';
import { sound } from '../audio/sound.js';
import { patchBurnMaterial } from './burnShader.js';
import { pourStream, sprayGas, spill, throwDust } from './effects.js';
import * as TX from './textures.js';

// ---------------------------------------------------------------------------
// Helpers

function burnMat(params, opts) {
  const m = new THREE.MeshStandardMaterial(params);
  const u = patchBurnMaterial(m, opts);
  return [m, u];
}

function grid(nx, nz, sx, sz, y = 0) {
  const out = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      out.push(new THREE.Vector3(nx === 1 ? 0 : lerp(-sx / 2, sx / 2, i / (nx - 1)), y, nz === 1 ? 0 : lerp(-sz / 2, sz / 2, j / (nz - 1))));
    }
  }
  return out;
}

function lathe(points, segs = 48) {
  return new THREE.LatheGeometry(points.map(([x, y]) => new THREE.Vector2(x, y)), segs);
}

/** Where to aim a spray or pour: the nearest fire (not our own), else towards the camera. */
function aim(item, from, maxDist = 45) {
  const src = fire.nearest(from, maxDist, (s) => s.owner !== item && s.kind !== 'gasjet');
  if (src) return new THREE.Vector3(src.x, src.y + Math.min(src.h * 0.3, 2), src.z);
  const d = _v1.copy(camera.position).sub(from).setY(0).normalize();
  return from.clone().addScaledVector(d, 8).setY(0);
}

/** Launch velocity for a ballistic arc from `from` that lands on `to`. */
function ballistic(from, to, angleDeg = 35, drag = 1.08) {
  const dx = to.x - from.x, dz = to.z - from.z;
  const d = Math.max(1, Math.hypot(dx, dz));
  const th = THREE.MathUtils.degToRad(angleDeg);
  const dy = to.y - from.y;
  const g = 981;
  const denom = 2 * Math.cos(th) ** 2 * (d * Math.tan(th) - dy);
  const v = denom > 0 ? Math.sqrt((g * d * d) / denom) * drag : 80;
  const dir = new THREE.Vector3((dx / d) * Math.cos(th), Math.sin(th), (dz / d) * Math.cos(th));
  return { dir, speed: v };
}

function worldPoint(item, x, y, z) { return item.group.localToWorld(new THREE.Vector3(x, y, z)); }

function upness(item) { return _v3.set(0, 1, 0).applyQuaternion(item.group.quaternion).y; }

/** Tilt a visual pivot towards a world direction and back (the physics body stays put). */
function tipTowards(item, pivot, worldDir, angle = 1.1, hold = 0.9) {
  const local = worldDir.clone().setY(0).normalize().applyQuaternion(item.group.quaternion.clone().invert());
  const axis = new THREE.Vector3(local.z, 0, -local.x).normalize();
  const q0 = new THREE.Quaternion();
  const q1 = new THREE.Quaternion().setFromAxisAngle(axis, angle);
  tween(0.3, (t) => pivot.quaternion.slerpQuaternions(q0, q1, ease.outCubic(t)), {
    done: () => tween(0.35, (t) => pivot.quaternion.slerpQuaternions(q1, q0, ease.inOutCubic(t)), { delay: hold }),
  });
}

// Burn presets.
const PAPER_FLAME = { height: 2.8, width: 1.4, max: 7, colors: 'wood', blue: 0.2, intensity: 1.45, glow: 0.35 };

// ---------------------------------------------------------------------------
// The cupboard. Every entry is plain data plus a build function; the Item
// class (item.js) does the physics and fire bookkeeping.

export const CATALOG = [
  {
    id: 'newspaper',
    lay: true,
    name: 'Newspaper',
    shelf: 'Burnables',
    tag: 'Catches in a second',
    blurb: 'Thin, dry cellulose with lots of air around it. It needs about 230 °C, and a match flame reaches that in under a second. Watch the edge burn in a glowing line and the ash curl up in the plume.',
    sound: 'paper',
    physics: { mass: 1.2, linearDamping: 2.6, angularDamping: 3, friction: 0.5, restitution: 0 },
    build() {
      const geo = new THREE.PlaneGeometry(10, 14, 20, 28);
      geo.rotateX(-Math.PI / 2);
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) p.setY(i, 0.06 * (1 + Math.sin(p.getX(i) * 0.7)) + 0.04 * (1 + Math.cos(p.getZ(i) * 0.5)) - 0.06);
      geo.computeVertexNormals();
      const [m, u] = burnMat({ map: TX.newsprint(), roughness: 0.92, side: THREE.DoubleSide }, { dissolve: true, ashW: 0.45, noise: 0.9 });
      return {
        meshes: [new THREE.Mesh(geo, m)],
        shapes: [{ type: 'box', hx: 5, hy: 0.07, hz: 7 }],
        nodes: grid(4, 5, 8.4, 12),
        spacing: 2.9,
        burnUniforms: [u],
      };
    },
    burn: { ignite: 230, heatRate: 900, cool: 0.6, burnTime: 3.2, spread: 1.6, power: 1.5, flame: PAPER_FLAME, smoke: { rate: 5, size: 0.3, size1: 3, alpha: 0.12, shade: 0.7, rise: 4 }, ashFlakes: 2, burnsAway: true, massLoss: 0.95, crackle: 0.5 },
  },
  {
    id: 'cardboard',
    lay: true,
    name: 'Cardboard',
    shelf: 'Burnables',
    tag: 'Slower, smokier',
    blurb: 'The same cellulose as paper, but thick and layered, so it takes longer to heat through and burns longer with more smoke. The corrugated air gaps keep it going.',
    sound: 'paper',
    physics: { mass: 7, linearDamping: 0.8, angularDamping: 1, friction: 0.7, restitution: 0.05 },
    build() {
      const geo = new THREE.BoxGeometry(9, 0.4, 7, 18, 1, 14);
      const [m, u] = burnMat({ map: TX.kraft(), roughness: 0.95 }, { dissolve: true, ashW: 0.55, noise: 0.7, charColor: [0.04, 0.03, 0.025] });
      return {
        meshes: [new THREE.Mesh(geo, m)],
        shapes: [{ type: 'box', hx: 4.5, hy: 0.2, hz: 3.5 }],
        nodes: grid(4, 3, 8, 6, 0.1),
        spacing: 2.7,
        burnUniforms: [u],
      };
    },
    burn: { ignite: 260, heatRate: 380, cool: 0.5, burnTime: 7, spread: 0.75, power: 1.8, flame: { ...PAPER_FLAME, height: 3.2, max: 6, soot: 0.1 }, smoke: { rate: 8, size: 0.4, size1: 4, alpha: 0.18, shade: 0.5, rise: 4 }, ashFlakes: 1, sparks: 2, burnsAway: true, massLoss: 0.9 },
  },
  {
    id: 'rag',
    lay: true,
    name: 'Cotton rag',
    shelf: 'Burnables',
    tag: 'Smoulders',
    blurb: 'Cotton is almost pure cellulose, loosely woven. It lights easily, burns with lots of smoke, and keeps smouldering as glowing embers creep through the fibres after the flames die down.',
    sound: 'soft',
    physics: { mass: 14, linearDamping: 1.5, angularDamping: 2.5, friction: 0.9, restitution: 0 },
    build() {
      const geo = new THREE.PlaneGeometry(14, 14, 28, 28);
      geo.rotateX(-Math.PI / 2);
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), z = p.getZ(i);
        // Crumple: fold towards the middle, lift in wrinkles.
        const r = Math.hypot(x, z);
        const k = 0.62 + 0.08 * Math.sin(x * 0.9 + z * 0.4);
        const y = 0.5 + 0.9 * Math.sin(x * 0.8) * Math.cos(z * 0.7) * (1 - r / 12) + 0.4 * Math.sin(x * 2.1 + z * 1.7) + 1.2 * Math.max(0, 1 - r / 7);
        p.setXYZ(i, x * k, Math.max(0.05, y), z * k);
      }
      geo.computeVertexNormals();
      const [m, u] = burnMat({ map: TX.plaid(), roughness: 1, side: THREE.DoubleSide }, { dissolve: true, ashW: 0.7, noise: 0.8, charColor: [0.05, 0.04, 0.035] });
      return {
        meshes: [new THREE.Mesh(geo, m)],
        shapes: [{ type: 'hull', points: hullPoints(geo, 300) }],
        nodes: grid(3, 3, 5.5, 5.5, 1.2),
        spacing: 2.75,
        burnUniforms: [u],
      };
    },
    burn: { ignite: 255, heatRate: 420, cool: 0.5, burnTime: 11, spread: 0.45, power: 1.5, flame: { ...PAPER_FLAME, height: 2.4, max: 5 }, smoke: { rate: 10, size: 0.35, size1: 3.5, alpha: 0.22, shade: 0.55, rise: 3 }, sparks: 3, smoulder: true, burnsAway: true, massLoss: 0.92 },
  },
  {
    id: 'kindling',
    lay: true,
    name: 'Pine kindling',
    shelf: 'Burnables',
    tag: 'Hard to light, burns long',
    blurb: 'A solid block has a lot of wood behind its surface soaking the heat away, so one match struggles to light it. Hold the flame to an edge for several seconds. Once it goes it chars, glows, and burns for a long time.',
    sound: 'wood',
    physics: { density: 0.45, linearDamping: 0.05, angularDamping: 0.2, friction: 0.6, restitution: 0.2 },
    build() {
      const geo = new THREE.BoxGeometry(12, 2, 2, 24, 4, 4);
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) + 0.05 * Math.sin(p.getX(i) * 1.3));
      geo.computeVertexNormals();
      const [m, u] = burnMat({ map: TX.pine(), roughness: 0.8 }, { dissolve: false, noise: 0.5 });
      const nodes = [];
      for (let i = 0; i < 6; i++) for (const y of [-0.8, 0.8]) nodes.push(new THREE.Vector3(lerp(-5.4, 5.4, i / 5), y, 0));
      return { meshes: [new THREE.Mesh(geo, m)], shapes: [{ type: 'box', hx: 6, hy: 1, hz: 1 }], nodes, spacing: 2.2, burnUniforms: [u] };
    },
    burn: { ignite: 300, heatRate: 58, cool: 0.12, burnTime: 70, spread: 0.25, growTime: 3, power: 1.6, flame: { height: 3.6, width: 1.3, max: 6, colors: 'wood', blue: 0.2, intensity: 1.5, glow: 0.4 }, smoke: { rate: 3, size: 0.3, size1: 3, alpha: 0.12, shade: 0.5, rise: 4 }, sparks: 1.5, smoulder: true, massLoss: 0.8, crackle: 1.3 },
  },
  {
    id: 'plastic',
    name: 'Plastic bottle',
    shelf: 'Burnables',
    tag: 'Melts, black smoke',
    blurb: 'PET softens at about 80 °C, so it shrinks and slumps long before it burns. When it does catch, at around 400 °C, it burns with a sooty orange flame and thick black smoke. Plastic smoke is toxic, which is why you never burn it at home.',
    sound: 'plastic',
    physics: { mass: 22, linearDamping: 0.3, angularDamping: 0.4, friction: 0.4, restitution: 0.35 },
    build(item) {
      const prof = [[0, 0], [2.6, 0], [3.1, 0.3], [3.3, 1], [3.3, 6], [3.05, 7], [3.3, 8], [3.3, 12.5], [2.6, 15], [1.3, 17], [1.25, 18.5], [1.4, 18.6], [1.4, 18.9], [0, 18.9]];
      const geo = lathe(prof, 48);
      const [m, u] = burnMat({ color: 0xb8dcef, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.45, envMapIntensity: 1.5, side: THREE.DoubleSide, depthWrite: false }, { dissolve: false, noise: 0.4, charColor: [0.02, 0.02, 0.02], meltHeight: 18.9 });
      const bottle = new THREE.Mesh(geo, m);
      bottle.castShadow = false;
      const labelGeo = new THREE.CylinderGeometry(3.33, 3.33, 3.6, 48, 1, true).translate(0, 9.8, 0);
      const [lm, lu] = burnMat({ map: TX.productLabel({ bg: '#1d5fa8', title: 'AQUA', sub: 'mineral water · 500 ml', stripe: '#6fc3f0' }), roughness: 0.4, side: THREE.DoubleSide }, { dissolve: true, ashW: 0.4, noise: 0.6, meltHeight: 18.9 });
      const label = new THREE.Mesh(labelGeo, lm);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 1.1, 24).translate(0, 19.4, 0), new THREE.MeshStandardMaterial({ color: 0x1f5fb0, roughness: 0.5 }));
      item.meltParts = [bottle, label, cap];
      return {
        meshes: [bottle, label, cap],
        shapes: [{ type: 'cylinder', hh: 7.5, r: 3.3, pos: [0, 7.5, 0] }, { type: 'cylinder', hh: 2.5, r: 1.6, pos: [0, 17.4, 0] }],
        nodes: [0, 5, 10, 15].map((y) => new THREE.Vector3(0, y + 1, 0)).concat([new THREE.Vector3(3, 4, 0), new THREE.Vector3(-3, 10, 0)]),
        spacing: 5,
        burnUniforms: [u, lu],
      };
    },
    init(item) { item.melt = 0; item.meltShape = 0; },
    burn: { ignite: 390, heatRate: 70, cool: 0.18, burnTime: 18, spread: 0.6, power: 1.6, flame: { height: 4, width: 1.4, max: 4, colors: 'soot', soot: 0.7, blue: 0.1, intensity: 1.5 }, smoke: { rate: 12, size: 0.5, size1: 5, alpha: 0.45, shade: 0.08, rise: 5, life: 5 }, massLoss: 0.85 },
    update(item, dt) {
      if (!item.burn) return;
      // PET softens around 80 °C: slump in proportion to how far past that it is.
      if (item.maxT > 80) item.melt = Math.min(1, item.melt + dt * (item.maxT - 80) / 260);
      for (const u of item.burnUniforms) u.uMelt.value = item.melt;
      if (item.meltParts) item.meltParts[2].position.y = -18.9 * 0.72 * item.melt * 1.0;
      if (item.melt - item.meltShape > 0.2 && item.phys) {
        item.meltShape = item.melt;
        const h = 18.9 * (1 - 0.72 * item.melt * 0.8);
        item.phys.setShapes([{ type: 'cylinder', hh: h / 2, r: 3.3 * (1 + 0.2 * item.melt), pos: [0, h / 2, 0] }]);
      }
      // Burning plastic drips.
      if (item.burningCount && Math.random() < dt * 2) {
        const p = worldPoint(item, rand(-2, 2), rand(1, 8), rand(-2, 2));
        droplets.emit({ x: p.x, y: p.y, z: p.z, vx: 0, vy: -5, vz: 0, life: 2, s: 0.35, a0: 1, cr: 3, cg: 1.2, cb: 0.2, r: 1, g: 1, b: 1, a: 1 });
      }
    },
    status(item) {
      if (item.burningCount) return 'Burning, dripping';
      if (item.melt > 0.05) return `Melting (${Math.round(item.melt * 100)}%)`;
      return null;
    },
  },
  {
    id: 'alcohol',
    name: 'Rubbing alcohol',
    shelf: 'Liquids',
    tag: 'Flammable liquid',
    blurb: '70% isopropyl alcohol. Its flash point is about 20 °C, so at room temperature there is already enough vapour above a spill to catch from any flame. It burns with a pale blue, almost invisible flame and hardly any smoke: dim the room light to see it.',
    sound: 'plastic',
    physics: { mass: 195, friction: 0.5, restitution: 0.15, angularDamping: 0.3 },
    build(item) {
      const prof = [[0, 0], [2.7, 0], [3, 0.3], [3, 10.2], [2.6, 11.2], [1.2, 12], [1.2, 12.3], [0, 12.3]];
      const geo = lathe(prof, 40);
      const [m, u] = burnMat({ color: 0xf2f2ee, roughness: 0.55 }, { dissolve: false, noise: 0.4, meltHeight: 13.5 });
      const body = new THREE.Mesh(geo, m);
      const labelGeo = new THREE.CylinderGeometry(3.03, 3.03, 6.5, 40, 1, true).translate(0, 4.8, 0);
      const [lm, lu] = burnMat({ map: TX.productLabel({ bg: '#f4f6fb', fg: '#123a86', title: 'ISOPROPYL', sub: 'Rubbing Alcohol 70%', stripe: '#1f64d6', small: 'FLAMMABLE · KEEP AWAY FROM FIRE', warning: true }), roughness: 0.6 }, { dissolve: true, ashW: 0.4, meltHeight: 13.5 });
      const label = new THREE.Mesh(labelGeo, lm);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.35, 1.3, 24).translate(0, 12.9, 0), new THREE.MeshStandardMaterial({ color: 0x1f64d6, roughness: 0.4 }));
      item.meltParts = [body, label, cap];
      return {
        meshes: [body, label, cap],
        shapes: [{ type: 'cylinder', hh: 5.6, r: 3, pos: [0, 5.6, 0] }, { type: 'cylinder', hh: 0.9, r: 1.35, pos: [0, 12.6, 0] }],
        nodes: [new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 7, 0), new THREE.Vector3(0, 11, 0)],
        spacing: 4.5,
        burnUniforms: [u, lu],
      };
    },
    init(item) { item.ml = 200; item.melt = 0; item.ruptured = false; },
    // The HDPE bottle itself: softens ~120 °C, then splits and dumps its contents.
    burn: { ignite: 350, heatRate: 55, cool: 0.18, burnTime: 20, spread: 0.5, power: 1.4, flame: { height: 3.5, width: 1.1, max: 3, colors: 'soot', soot: 0.5 }, smoke: { rate: 8, size: 0.4, size1: 4, alpha: 0.35, shade: 0.12, rise: 4 }, massLoss: 0.9 },
    actions: [
      {
        id: 'spill', label: 'Spill 20 ml', enabled: (it) => it.ml > 0.5,
        run(item) {
          const from = worldPoint(item, 0, 12, 0);
          const to = aim(item, from, 25);
          const flat = to.clone().sub(item.group.position).setY(0);
          const d = Math.min(flat.length(), 6);
          flat.normalize();
          const spot = item.group.position.clone().addScaledVector(flat, Math.max(4.5, d));
          const ml = Math.min(20, item.ml);
          item.ml -= ml;
          const { dir, speed } = ballistic(from, spot, 20, 1);
          pourStream(from, dir, { kind: 'alcohol', count: 24, amount: ml / 24, speed, duration: 0.6, exclude: item.phys, spread: 0.05 });
          if (item.pivot) tipTowards(item, item.pivot, flat, 1.3, 0.4);
          toast('Spilled 20 ml. Any flame near the pool will light the vapour.');
        },
      },
    ],
    update(item, dt) {
      if (item.maxT > 110) item.melt = Math.min(1, item.melt + dt * (item.maxT - 110) / 200);
      for (const u of item.burnUniforms) u.uMelt.value = item.melt * 0.6;
      if (!item.ruptured && item.melt > 0.3 && item.ml > 1) {
        item.ruptured = true;
        const ml = item.ml;
        item.ml = 0;
        spill(item.group.position, ml, 'alcohol', item.phys);
        toast('The bottle softened and split. Its alcohol is pouring out.');
        sound.whoomp(0.4);
      }
      // Liquid is most of the weight.
      const k = (20 + item.ml * 0.87) / 194;
      if (Math.abs(k - (item.liqK ?? 1)) > 0.02 && item.phys) { item.liqK = k; item.phys.setDensityScale(k); }
    },
    status(item) {
      if (item.ruptured) return item.burningCount ? 'Split open, burning' : 'Split open';
      if (item.melt > 0.05) return 'Softening';
      return `${Math.round(item.ml)} ml left`;
    },
  },
  {
    id: 'aerosol',
    name: 'Deodorant spray',
    shelf: 'Liquids',
    tag: 'Pressurised: explosive',
    blurb: 'The propellant is butane and propane, stored as a liquid under about 3.5 bar. Heat raises that pressure fast: the can says "do not expose above 50 °C" for a reason. Spray it through a flame and the propellant itself burns as a jet of fire. Heat it enough and the can bursts.',
    sound: 'metal',
    physics: { mass: 150, friction: 0.45, restitution: 0.3, angularDamping: 0.25 },
    build(item) {
      const bodyGeo = new THREE.CylinderGeometry(2.3, 2.3, 12, 40).translate(0, 6, 0);
      const labelTex = TX.productLabel({ bg: '#20252e', fg: '#e8f1ff', title: 'FROST', sub: '48h anti-perspirant spray', stripe: '#39b6ff', small: 'PRESSURISED CONTAINER · DO NOT HEAT ABOVE 50 °C', warning: true, w: 512, h: 300 });
      const body = new THREE.Mesh(bodyGeo, new THREE.MeshStandardMaterial({ map: labelTex, metalness: 0.75, roughness: 0.3 }));
      const dome = new THREE.Mesh(new THREE.SphereGeometry(2.3, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.45, 1).translate(0, 12, 0), new THREE.MeshStandardMaterial({ color: 0xc9ced6, metalness: 1, roughness: 0.25 }));
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.2, 1.4, 24).translate(0, 13.4, 0), new THREE.MeshStandardMaterial({ color: 0xf2f4f7, roughness: 0.35 }));
      const nozzle = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.35).translate(1.25, 13.6, 0), new THREE.MeshStandardMaterial({ color: 0x39b6ff, roughness: 0.4 }));
      item.canParts = [body, dome, cap, nozzle];
      return {
        meshes: [body, dome, cap, nozzle],
        shapes: [{ type: 'cylinder', hh: 6.5, r: 2.3, pos: [0, 6.5, 0] }, { type: 'cylinder', hh: 0.75, r: 1.2, pos: [0, 13.6, 0] }],
        nodes: [],
      };
    },
    init(item) { item.T = AMBIENT_C; item.fill = 1; item.burst = false; item.sprayT = 0; },
    update(item, dt) {
      if (item.burst) return;
      // Metal can with liquid inside: slow to heat, slow to cool.
      const e = item.surfaceExposure();
      item.T += (4 * e - 0.03 * (item.T - AMBIENT_C)) * dt;
      // Vapour pressure of the butane/propane mix rises roughly exponentially.
      item.P = 3.5 * Math.exp((item.T - 20) / 42) * (0.4 + 0.6 * item.fill);
      if (item.T > 50 && !item.warned) { item.warned = true; toast('The can is past 50 °C, the limit printed on it. Pressure is climbing.'); }
      if (item.P > 15 && item.fill > 0.05) {
        item.burst = true;
        const pos = worldPoint(item, 0, 7, 0);
        explode(pos, { strength: 0.8 + item.fill * 1.2, radius: 30, owner: null });
        // Escaping propellant ignites into a fireball.
        emitFireball(pos, { n: 60, radius: 4, speed: 90, size: 3, size1: 14, life: 1.4 });
        fire.pulse(pos, { h: 14, r: 10, power: 7, ttl: 0.7 });
        item.phys.applyImpulse({ x: rand(-1, 1) * 3000, y: 9000 + rand(0, 4000), z: rand(-1, 1) * 3000 }, worldPoint(item, 0.8, 2, 0));
        for (const m of item.canParts) m.scale.set(1.12, 0.85, 1.1);
        item.canParts[0].material.color.setRGB(0.25, 0.2, 0.18);
        item.fill = 0;
        item.phys.setDensityScale(0.55);
        toast('BANG. The can burst. That is a BLEVE: boiling liquid, expanding vapour.');
      }
      const heatGlow = smoothstep(150, 500, item.T);
      item.canParts[1].material.emissive?.setRGB(heatGlow, heatGlow * 0.3, 0);
    },
    actions: [
      {
        id: 'spray', label: 'Spray', enabled: (it) => !it.burst && it.fill > 0.02,
        run(item) {
          const from = worldPoint(item, 1.6, 13.6, 0);
          const to = aim(item, from, 45);
          const dir = to.clone().sub(from);
          dir.y = Math.max(-0.2, Math.min(0.3, dir.y / Math.max(1, dir.length())));
          dir.setY(dir.y * dir.length()).normalize();
          sprayGas(from, dir, { owner: item, count: 90, duration: 1.2 });
          item.fill = Math.max(0, item.fill - 0.06);
          const has = fire.nearest(from, 45, (s) => s.owner !== item);
          toast(has ? 'Spraying at the flame. The propellant is butane.' : 'Psssht. Aim it past a flame to see the propellant burn.');
        },
      },
    ],
    status(item) {
      if (item.burst) return 'Burst';
      return `${Math.round(item.T)} °C · ${item.P ? item.P.toFixed(1) : '3.5'} bar`;
    },
    temperature: (item) => item.T,
  },
  {
    id: 'oil',
    name: 'Cooking oil',
    shelf: 'Liquids',
    tag: 'Needs ~300 °C',
    blurb: 'Vegetable oil in a small pan. A match will barely warm it: it smokes around 230 °C and only catches fire near 310 °C, so you need a real heat source like the camping stove. Once it burns, water makes it far worse. Smother it with baking soda instead.',
    sound: 'metal',
    physics: { mass: 480, friction: 0.5, restitution: 0.1, angularDamping: 0.4 },
    build(item) {
      const prof = [[0, 0], [6, 0], [6.4, 0.2], [7.2, 2.1], [7.45, 2.2], [7.5, 2.05], [6.75, 0.25], [6.1, 0.25], [0, 0.25]];
      const pan = new THREE.Mesh(lathe(prof, 56), new THREE.MeshStandardMaterial({ color: 0x2b2b2e, metalness: 0.85, roughness: 0.45, side: THREE.DoubleSide }));
      const handle = new THREE.Mesh(new THREE.BoxGeometry(11, 0.6, 1.6).translate(12.5, 1.9, 0), new THREE.MeshStandardMaterial({ color: 0x1b1410, roughness: 0.6 }));
      handle.rotation.z = 0;
      const oilMat = new THREE.MeshPhysicalMaterial({ color: 0xc18d22, roughness: 0.04, metalness: 0, clearcoat: 1, transparent: true, opacity: 0.85, emissive: new THREE.Color(0xff5a10), emissiveIntensity: 0 });
      const oil = new THREE.Mesh(new THREE.CircleGeometry(6.35, 48).rotateX(-Math.PI / 2).translate(0, 0.75, 0), oilMat);
      oil.castShadow = false;
      item.oilMesh = oil;
      const shapes = [{ type: 'cylinder', hh: 0.15, r: 6.3, pos: [0, 0.15, 0] }];
      const N = 16;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a);
        shapes.push({ type: 'box', hx: 0.15, hy: 1.05, hz: 1.5, pos: [Math.cos(a) * 6.9, 1.15, Math.sin(a) * 6.9], quat: [q.x, q.y, q.z, q.w] });
      }
      shapes.push({ type: 'box', hx: 5.5, hy: 0.3, hz: 0.8, pos: [12.5, 1.9, 0], density: 0.8 });
      return { meshes: [pan, handle, oil], shapes, nodes: [] };
    },
    init(item) { item.T = AMBIENT_C; item.ml = 60; item.lit = false; item.flames = []; item.smother = 0; },
    onSpawn(item) {
      // Slightly heavier base so it sits flat.
      item.phys.body.setAngularDamping(0.6);
    },
    update(item, dt) {
      // The pan and oil have a lot of thermal mass.
      const e = item.surfaceExposure();
      item.T += (3.2 * e - 0.012 * (item.T - AMBIENT_C)) * dt;
      if (item.lit) item.T = Math.max(item.T, 320);
      item.tipT = upness(item) < 0.4 ? (item.tipT ?? 0) + dt : 0;
      if (item.tipT > 0.3 && item.ml > 1) {
        // Spilled hot oil: a small burning pool if it was alight.
        item.ml = 0;
        item.oilMesh.visible = false;
        if (item.lit) {
          emitFireball(item.group.position, { n: 30, radius: 4, speed: 50, size: 2, size1: 8, life: 1 });
          extinguishPan(item);
        }
      }
      if (!item.lit && item.T >= 310 && item.ml > 2 && item.smother <= 0) igniteOil(item);
      item.smother = Math.max(0, item.smother - dt);
      if (item.T > 200 && !item.lit && Math.random() < dt * smoothstep(200, 300, item.T) * 12) {
        emitSmoke(worldPoint(item, rand(-4, 4), 1, rand(-4, 4)), { size: 0.4, size1: 4, alpha: 0.18, life: 4, rise: 4, shade: 0.85 });
      }
      if (item.lit) {
        item.ml -= dt * 0.18;
        if (item.ml < 1) extinguishPan(item);
        const k = clamp(item.ml / 20, 0.3, 1);
        for (const f of item.flames) {
          f.base.copy(worldPoint(item, f.ox, 0.8, f.oz));
          f.target = k * rand(0.9, 1.1);
        }
        if (Math.random() < dt * 14) emitSmoke(worldPoint(item, rand(-3, 3), 9, rand(-3, 3)), { size: 0.8, size1: 7, alpha: 0.3, life: 5, rise: 7, shade: 0.12 });
        if (Math.random() < dt * 3) emitSparks(worldPoint(item, rand(-4, 4), 1, rand(-4, 4)), 2, _v1.set(0, 1, 0), 60, 20, { lifeK: 2 });
      }
      item.oilMesh.material.emissiveIntensity = smoothstep(180, 360, item.T) * 0.35;
      item.oilMesh.material.color.setHSL(0.11, 0.7, lerp(0.42, 0.3, smoothstep(100, 320, item.T)));
    },
    addHeat(item) {
      if (!item.lit) return;
      const c = worldPoint(item, 0, 0.8, 0);
      const k = clamp(item.ml / 20, 0.3, 1);
      fire.add({ x: c.x, y: c.y, z: c.z, h: 11 * k, r: 5.5, power: 3.2 * k, owner: item, kind: 'oil' });
    },
    onDouse(item, pos, amount, kind) {
      if (kind === 'water') {
        if (item.lit || item.T > 180) {
          if (!item.steamT || performance.now() - item.steamT > 900) {
            item.steamT = performance.now();
            steamExplosion(item);
          }
        } else item.T = Math.max(AMBIENT_C, item.T - 4 * amount);
      } else if (kind === 'powder') {
        item.smother = Math.min(8, item.smother + 0.25 * amount);
        if (item.lit && item.smother > 1.5) {
          extinguishPan(item);
          item.T = Math.min(item.T, 280);
          item.smother = 6;
          toast('Smothered. Baking soda releases CO₂ and cuts off the oxygen.');
        }
      }
      return false;
    },
    status(item) {
      if (item.lit) return `Oil fire · ${Math.round(item.T)} °C`;
      if (item.ml < 1) return 'Empty';
      if (item.T > 230) return `Smoking · ${Math.round(item.T)} °C`;
      return `${Math.round(item.T)} °C`;
    },
    temperature: (item) => item.T,
    onRemove(item) { for (const f of item.flames) f.dispose(); },
  },
  {
    id: 'stove',
    name: 'Camping stove',
    shelf: 'Tools',
    tag: 'Heat source',
    blurb: 'A butane canister stove. Turn the gas on, then bring a lit match to the burner. If you let gas flow for a few seconds before lighting it, it lights with a whoomp. Put the oil pan on top to heat it.',
    sound: 'metal',
    physics: { mass: 420, friction: 0.7, restitution: 0.05, angularDamping: 0.5 },
    build(item) {
      const can = new THREE.Mesh(new THREE.CylinderGeometry(5.5, 5.5, 7.5, 44).translate(0, 3.75, 0), new THREE.MeshStandardMaterial({ map: TX.productLabel({ bg: '#e0561b', title: 'BUTANE', sub: 'camping gas · 230 g', stripe: '#262626', small: 'EXTREMELY FLAMMABLE GAS', warning: true, w: 512, h: 256 }), metalness: 0.5, roughness: 0.4 }));
      const top = new THREE.Mesh(new THREE.SphereGeometry(5.5, 40, 10, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.3, 1).translate(0, 7.5, 0), new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 1, roughness: 0.3 }));
      const valve = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.3, 2.2, 20).translate(0, 9.6, 0), new THREE.MeshStandardMaterial({ color: 0x777c84, metalness: 1, roughness: 0.35 }));
      const burner = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 1.6, 1.3, 32).translate(0, 11.3, 0), new THREE.MeshStandardMaterial({ color: 0x3a3a3c, metalness: 0.9, roughness: 0.5 }));
      const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 1.2, 16).rotateZ(Math.PI / 2).translate(1.9, 9.6, 0), new THREE.MeshStandardMaterial({ color: 0xc42222, roughness: 0.5 }));
      const arms = [];
      const shapes = [{ type: 'cylinder', hh: 3.75, r: 5.5, pos: [0, 3.75, 0] }, { type: 'cylinder', hh: 1.6, r: 1.6, pos: [0, 10, 0] }];
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + 0.3;
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a);
        const arm = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.35, 0.5), new THREE.MeshStandardMaterial({ color: 0x55585e, metalness: 1, roughness: 0.4 }));
        arm.position.set(Math.cos(a) * 3.6, 12.25, Math.sin(a) * 3.6);
        arm.quaternion.copy(q);
        arms.push(arm);
        shapes.push({ type: 'box', hx: 2.3, hy: 0.25, hz: 0.25, pos: [Math.cos(a) * 3.6, 12.2, Math.sin(a) * 3.6], quat: [q.x, q.y, q.z, q.w] });
      }
      item.knob = knob;
      return { meshes: [can, top, valve, burner, knob, ...arms], shapes, nodes: [] };
    },
    init(item) { item.gasOn = false; item.lit = false; item.gasAccum = 0; item.flames = []; item.fuel = 1; },
    update(item, dt) {
      const ring = worldPoint(item, 0, 12.1, 0);
      if (item.gasOn && item.fuel > 0) {
        item.fuel -= dt / 900;
        if (!item.lit) {
          item.gasAccum += dt;
          sound.setHiss(0.12);
          // Probe around the burner for a pilot flame.
          for (let i = 0; i < 6 && !item.lit; i++) {
            const a = (i / 6) * Math.PI * 2;
            const p = worldPoint(item, Math.cos(a) * 1.8, 12.4, Math.sin(a) * 1.8);
            if (fire.touching(p, item, 0.8 + Math.min(2.5, item.gasAccum))) lightStove(item);
          }
          if (item.gasAccum > 12 && !item.warnedGas) { item.warnedGas = true; toast('Gas is pouring out unlit. Light it or turn it off.'); }
        }
      } else if (item.lit) extinguishStove(item);
      if (item.lit) {
        sound.setHiss(0.05);
        for (const f of item.flames) {
          f.base.copy(worldPoint(item, Math.cos(f.a) * 1.9, 12.05, Math.sin(f.a) * 1.9));
          f.target = rand(0.92, 1.05);
        }
      }
      if (!item.gasOn) item.gasAccum = Math.max(0, item.gasAccum - dt * 2);
      item.knob.rotation.x = item.gasOn ? Math.PI / 2 : 0;
    },
    addHeat(item) {
      if (!item.lit) return;
      const c = worldPoint(item, 0, 11.9, 0);
      fire.add({ x: c.x, y: c.y, z: c.z, h: 3.2, r: 2.6, power: 5, owner: item, kind: 'gas' });
    },
    onDouse(item, pos, amount, kind) {
      if (item.lit && Math.random() < 0.25 * amount) {
        extinguishStove(item, true);
        toast('The flame went out but the gas is still on. That is how kitchens explode.');
      }
      return false;
    },
    actions: [
      {
        id: 'gas', label: (it) => (it.gasOn ? 'Turn gas off' : 'Turn gas on'), enabled: (it) => it.fuel > 0,
        run(item) {
          item.gasOn = !item.gasOn;
          sound.click();
          if (!item.gasOn) { sound.setHiss(0); if (item.lit) extinguishStove(item); }
          else toast('Gas on. Bring a lit match to the burner.');
        },
      },
    ],
    status(item) {
      if (item.lit) return 'Burning';
      if (item.gasOn) return `Gas on, unlit (${item.gasAccum.toFixed(1)} s)`;
      return 'Off';
    },
    onRemove(item) { for (const f of item.flames) f.dispose(); sound.setHiss(0); },
  },
  {
    id: 'water',
    name: 'Glass of water',
    shelf: 'Tools',
    tag: 'Extinguisher (mostly)',
    blurb: 'Water cools burning things below their ignition temperature and turns to steam, which pushes oxygen away. Great on paper, wood and cloth. Terrible on an oil fire: the water sinks, flashes to steam and blasts burning oil into the air.',
    sound: 'glass',
    physics: { mass: 390, friction: 0.5, restitution: 0.1, angularDamping: 0.4 },
    build(item) {
      const pivot = new THREE.Group();
      const prof = [[0, 0], [2.8, 0], [3.2, 9], [3.05, 9], [2.65, 0.45], [0, 0.45]];
      const glass = new THREE.Mesh(lathe(prof, 48), new THREE.MeshPhysicalMaterial({ color: 0xe8f4ff, roughness: 0.03, metalness: 0, transparent: true, opacity: 0.25, clearcoat: 1, side: THREE.DoubleSide, depthWrite: false }));
      glass.castShadow = false;
      const water = new THREE.Mesh(new THREE.CylinderGeometry(3.0, 2.68, 7, 40).translate(0, 3.95, 0), new THREE.MeshPhysicalMaterial({ color: 0x9fd0ff, roughness: 0.05, transparent: true, opacity: 0.45, depthWrite: false }));
      water.castShadow = false;
      pivot.add(glass, water);
      item.group.add(pivot);
      item.pivot = pivot;
      item.waterMesh = water;
      return { meshes: [glass, water], shapes: [{ type: 'cylinder', hh: 4.5, r: 3.1, pos: [0, 4.5, 0] }], nodes: [] };
    },
    init(item) { item.ml = 200; },
    actions: [
      {
        id: 'pour', label: 'Pour', enabled: (it) => it.ml > 5,
        run(item) {
          const from = worldPoint(item, 0, 9.2, 0);
          const to = aim(item, from, 45);
          const { dir, speed } = ballistic(from, to, 30);
          const flat = to.clone().sub(from).setY(0);
          pourStream(from.clone().addScaledVector(flat.clone().normalize(), 3.1), dir, { kind: 'water', count: 90, speed, duration: 1, exclude: item.phys, spread: 0.06 });
          item.ml = Math.max(0, item.ml - 60);
          tipTowards(item, item.pivot, flat, 1.2, 0.8);
        },
      },
    ],
    update(item) {
      const k = item.ml / 200;
      item.waterMesh.scale.y = Math.max(0.001, k);
      item.waterMesh.position.y = 0.5 * (1 - k);
      item.waterMesh.visible = item.ml > 1;
      const m = (190 + item.ml) / 390;
      if (Math.abs(m - (item.liqK ?? 1)) > 0.02 && item.phys) { item.liqK = m; item.phys.setDensityScale(m); }
    },
    status: (item) => (item.ml > 1 ? `${Math.round(item.ml)} ml` : 'Empty'),
  },
  {
    id: 'soda',
    name: 'Baking soda',
    shelf: 'Tools',
    tag: 'Smothers fires',
    blurb: 'Sodium bicarbonate breaks down in heat and releases carbon dioxide, which blankets the fire and starves it of oxygen. It is the right thing to throw on a small grease fire.',
    sound: 'paper',
    physics: { mass: 260, friction: 0.7, restitution: 0.05 },
    build() {
      const tex = TX.productLabel({ bg: '#f07b1a', fg: '#fff', title: 'BAKING SODA', sub: 'sodium bicarbonate', stripe: '#ffffff', small: 'NaHCO₃ · 250 g', w: 512, h: 380 });
      const white = new THREE.MeshStandardMaterial({ color: 0xf5f1e8, roughness: 0.9 });
      const face = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 });
      const box = new THREE.Mesh(new THREE.BoxGeometry(6, 9, 3.5).translate(0, 4.5, 0), [white, white, white, white, face, face]);
      return { meshes: [box], shapes: [{ type: 'box', hx: 3, hy: 4.5, hz: 1.75, pos: [0, 4.5, 0] }], nodes: [] };
    },
    init(item) { item.uses = 8; },
    actions: [
      {
        id: 'sprinkle', label: 'Sprinkle', enabled: (it) => it.uses > 0,
        run(item) {
          const from = worldPoint(item, 0, 9.3, 0);
          const to = aim(item, from, 45);
          const { dir, speed } = ballistic(from, to, 40, 1.25);
          pourStream(from, dir, { kind: 'powder', count: 70, speed, duration: 0.7, exclude: item.phys, spread: 0.1 });
          item.uses--;
          sound.burst({ dur: 0.5, f0: 3000, type: 'highpass', gain: 0.15, attack: 0.05 });
        },
      },
    ],
    status: (item) => `${item.uses} handfuls left`,
  },
  {
    id: 'flour',
    name: 'Flour',
    shelf: 'Tools',
    tag: 'Dust explosion',
    blurb: 'A bag of flour barely burns. But flour thrown into the air is millions of tiny grains, each surrounded by oxygen, and a flame races through the cloud in a flash. Dust explosions like this have levelled flour mills.',
    sound: 'soft',
    physics: { mass: 260, friction: 0.8, restitution: 0.02, angularDamping: 1 },
    build() {
      const geo = new THREE.BoxGeometry(7, 11, 4.5, 6, 10, 4).translate(0, 5.5, 0);
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const y = p.getY(i);
        const k = 1 + 0.06 * Math.sin(y * 1.1) - (y > 9.5 ? (y - 9.5) * 0.25 : 0);
        p.setX(i, p.getX(i) * k);
        p.setZ(i, p.getZ(i) * (y > 9.5 ? Math.max(0.15, 1 - (y - 9.5) * 0.6) : k));
      }
      geo.computeVertexNormals();
      const tex = TX.productLabel({ bg: '#f3ead6', fg: '#8a3b12', title: 'PLAIN FLOUR', sub: 'finely milled wheat', stripe: '#d9a441', small: '1 kg', w: 512, h: 512 });
      const [m, u] = burnMat({ map: tex, roughness: 0.95 }, { dissolve: false, noise: 0.7 });
      return { meshes: [new THREE.Mesh(geo, m)], shapes: [{ type: 'box', hx: 3.5, hy: 5.5, hz: 2.25, pos: [0, 5.5, 0] }], nodes: grid(2, 2, 5, 3, 3).concat(grid(2, 2, 5, 3, 8)), spacing: 5, burnUniforms: [u] };
    },
    // The paper bag chars; the flour inside smothers most of it.
    burn: { ignite: 280, heatRate: 120, cool: 0.4, burnTime: 6, spread: 0.25, power: 0.9, flame: { height: 1.8, width: 0.8, max: 3 }, smoke: { rate: 5, size: 0.3, size1: 3, alpha: 0.15, shade: 0.6, rise: 3 }, massLoss: 0.1 },
    init(item) { item.uses = 10; },
    actions: [
      {
        id: 'toss', label: 'Toss a handful', enabled: (it) => it.uses > 0,
        run(item) {
          const from = worldPoint(item, 0, 11.5, 0);
          const to = aim(item, from, 45);
          // Dust has high drag, so it travels roughly v / drag: launch at the
          // speed that carries the cloud just past the target.
          const vel = to.clone().sub(from).multiplyScalar(2.2 * 1.15);
          if (vel.length() > 140) vel.setLength(140);
          throwDust(from, vel, { count: 80 });
          item.uses--;
          sound.burst({ dur: 0.4, f0: 1800, type: 'bandpass', q: 0.6, gain: 0.25, attack: 0.02 });
        },
      },
    ],
    status: (item) => (item.burningCount ? 'Bag burning' : `${item.uses} handfuls left`),
  },
  {
    id: 'steelwool',
    lay: true,
    name: 'Steel wool',
    shelf: 'Burnables',
    tag: 'Burns without flame',
    blurb: 'Iron is not supposed to burn, but steel wool is so fine that a match heats the strands to glowing in a second. It burns without a flame, throwing sparks, and gets heavier as it burns: each iron atom picks up oxygen and becomes iron oxide.',
    sound: 'soft',
    physics: { mass: 8, friction: 1, restitution: 0, linearDamping: 0.8, angularDamping: 1.5 },
    build() {
      const geo = new THREE.IcosahedronGeometry(1, 5);
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const n = 1 + 0.12 * Math.sin(x * 9 + y * 7) * Math.cos(z * 8 - x * 5) + 0.06 * Math.sin(y * 21 + z * 17);
        p.setXYZ(i, x * 3.4 * n, (y * 1.25 + 1.25) * n, z * 2.3 * n);
      }
      geo.computeVertexNormals();
      const [m, u] = burnMat({ map: TX.steelFibers(), roughness: 0.55, metalness: 0.8 }, { dissolve: false, noise: 1.3, charColor: [0.09, 0.08, 0.09], emberColor: [1.0, 0.5, 0.12] });
      // Fuzzy outer layer.
      const fuzz = new THREE.Mesh(geo.clone().scale(1.08, 1.1, 1.08), new THREE.MeshStandardMaterial({ map: TX.steelFibers(), alphaMap: TX.steelAlpha(), transparent: true, alphaTest: 0.35, metalness: 0.8, roughness: 0.5, side: THREE.DoubleSide }));
      fuzz.castShadow = false;
      const nodes = [];
      for (let i = 0; i < 12; i++) nodes.push(new THREE.Vector3(rand(-2.6, 2.6), rand(0.6, 2.2), rand(-1.6, 1.6)));
      return { meshes: [new THREE.Mesh(geo, m), fuzz], shapes: [{ type: 'hull', points: hullPoints(geo, 200) }], nodes, spacing: 1.8, burnUniforms: [u] };
    },
    burn: { ignite: 260, heatRate: 1300, cool: 1.1, burnTime: 3.5, spread: 0.9, power: 0.9, flame: null, sparks: 28, sparkSpeed: 45, massLoss: -0.38, crackle: 1.6, smoke: { rate: 1, size: 0.2, size1: 1.5, alpha: 0.05, shade: 0.6 } },
    status(item) {
      if (item.burningCount) return 'Glowing';
      if (item.everBurned && item.baseMass) return `Oxidised: ${((item.mass / item.baseMass - 1) * 100).toFixed(0)}% heavier`;
      return null;
    },
  },
  {
    id: 'candle',
    name: 'Candle',
    shelf: 'Burnables',
    tag: 'Steady flame',
    blurb: 'Solid wax does not burn. The flame melts wax, the wick draws the liquid up, and heat turns it to vapour: it is the vapour that burns. That is why a candle takes a moment to light.',
    custom: true,
  },
];

// ---------------------------------------------------------------------------
// Oil pan, stove helpers.

function igniteOil(item) {
  if (item.lit) return;
  item.lit = true;
  const n = 5;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rand(0, 0.5);
    const r = i === 0 ? 0 : rand(2, 4);
    const f = new Flame({ height: 9, width: 2.2, blue: 0.1, intensity: 1.4, colors: FLAME_COLORS.soot, soot: 0.3, speed: 0.7, glow: 0.4 });
    f.ox = Math.cos(a) * r; f.oz = Math.sin(a) * r;
    f.size = 0.05;
    f.lightK = 0.8;
    item.flames.push(f);
  }
  sound.whoomp(0.8);
  flash(worldPoint(item, 0, 2, 0), { size: 20, strength: 1 });
  toast('The oil reached its auto-ignition point and caught fire.');
}

function extinguishPan(item) {
  if (!item.lit) return;
  item.lit = false;
  for (const f of item.flames) f.die();
  item.flames = [];
  sound.fizz();
}

function steamExplosion(item) {
  const pos = worldPoint(item, 0, 1, 0);
  // Burning oil thrown up by flashing steam.
  emitFireball(pos, { n: 90, radius: 5, speed: 120, size: 3, size1: 16, life: 1.6, lift: 260 });
  emitSparks(pos, 90, _v1.set(0, 1, 0), 260, 140, { lifeK: 2.5, grav: 600 });
  fire.pulse(pos.clone().setY(pos.y + 10), { h: 28, r: 16, power: 7, ttl: 1.1, owner: item });
  explode(pos, { strength: 0.35, radius: 20, fire: false });
  flash(pos, { size: 50, strength: 2, dur: 0.8 });
  sound.whoomp(1.6);
  if (!item.lit) igniteOil(item);
  item.ml = Math.max(0, item.ml - 12);
  toast('Water on burning oil: it flashes to steam and throws burning oil everywhere. Smother it instead.', 4500);
}

function lightStove(item) {
  item.lit = true;
  if (item.gasAccum > 2.5) {
    const pos = worldPoint(item, 0, 13, 0);
    const s = Math.min(1.5, item.gasAccum / 6);
    emitFireball(pos, { n: 30 + s * 40, radius: 3 + s * 3, speed: 50, size: 2, size1: 7 + s * 6, life: 0.8, tint: [0.7, 0.9, 1.4] });
    fire.pulse(pos, { h: 8 + s * 8, r: 5 + s * 5, power: 4, ttl: 0.4, owner: item });
    sound.whoomp(0.6 + s * 0.6);
    toast(`Whoomp. ${item.gasAccum.toFixed(1)} s of gas built up before it lit.`);
  } else sound.burst({ dur: 0.5, f0: 300, f1: 1200, type: 'lowpass', gain: 0.35, attack: 0.02 });
  item.gasAccum = 0;
  for (let i = 0; i < 9; i++) {
    const f = new Flame({ height: 1.6, width: 0.35, blue: 1, intensity: 1.6, colors: FLAME_COLORS.gas, alpha: 0.8, glow: 0.2, glowColor: 0x4a78ff, speed: 1.6 });
    f.a = (i / 9) * Math.PI * 2;
    f.size = 0.05;
    f.lightK = 0.25;
    item.flames.push(f);
  }
}

function extinguishStove(item) {
  item.lit = false;
  for (const f of item.flames) f.die(true);
  item.flames = [];
  sound.fizz();
}

export const catalogById = Object.fromEntries(CATALOG.map((d) => [d.id, d]));
