import * as THREE from 'three';
import { scene } from '../core/stage.js';
import { ASHTRAY } from '../core/state.js';
import { canvasTexture, grain, makeCanvas, rand } from '../core/util.js';
import { PhysicsBody, trimeshFrom } from '../physics/physics.js';
import { scorchTex, surface } from '../fx/particles.js';

function woodTexture() {
  const S = 1024, planks = 4, ph = S / planks;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  const tones = ['#3a2415', '#34200f', '#402818', '#2f1d10'];
  for (let i = 0; i < planks; i++) {
    const y0 = i * ph;
    const grad = g.createLinearGradient(0, y0, 0, y0 + ph);
    grad.addColorStop(0, tones[i]);
    grad.addColorStop(0.5, '#452c1a');
    grad.addColorStop(1, tones[(i + 1) % 4]);
    g.fillStyle = grad;
    g.fillRect(0, y0, S, ph);
    for (let k = 0; k < 90; k++) {
      const yy = y0 + Math.random() * ph;
      g.strokeStyle = Math.random() < 0.6 ? `rgba(20,10,4,${rand(0.08, 0.28)})` : `rgba(120,80,50,${rand(0.05, 0.15)})`;
      g.lineWidth = rand(0.6, 2.4);
      g.beginPath();
      const f = rand(0.004, 0.012), amp = rand(2, 9), ph0 = rand(0, 6);
      for (let x = 0; x <= S; x += 8) {
        const y = yy + Math.sin(x * f + ph0) * amp + Math.sin(x * f * 3.1 + ph0 * 2) * amp * 0.3;
        x === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.stroke();
    }
    for (let k = 0; k < 2; k++) {
      const kx = rand(80, 944), ky = y0 + rand(30, ph - 30);
      for (let r = 26; r > 2; r -= 3) {
        g.strokeStyle = `rgba(22,11,5,${0.12 + (26 - r) * 0.012})`;
        g.lineWidth = 1.4;
        g.beginPath();
        g.ellipse(kx, ky, r * 2.4, r * 0.8, 0, 0, Math.PI * 2);
        g.stroke();
      }
    }
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.fillRect(0, y0, S, 3);
  }
  grain(g, S, S, 12);
  return canvasTexture(c, { repeat: [10, 10] });
}

const woodTex = woodTexture();
export const tableMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.62, metalness: 0, bumpMap: woodTex, bumpScale: 0.6 }),
);
tableMesh.rotation.x = -Math.PI / 2;
tableMesh.receiveShadow = true;
scene.add(tableMesh);

// Glass ashtray.
const profile = [[0, 0.02], [2.05, 0.02], [2.3, 0.1], [2.34, 0.46], [2.26, 0.53], [2.12, 0.5], [2, 0.32], [1.9, 0.27], [0, 0.26]].map(([x, y]) => new THREE.Vector2(x, y));
const ashGeo = new THREE.LatheGeometry(profile, 72);
export const ashtray = new THREE.Mesh(
  ashGeo,
  new THREE.MeshPhysicalMaterial({ color: 0x2c3f45, roughness: 0.22, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.15, side: THREE.DoubleSide }),
);
ashtray.position.set(ASHTRAY.x, 0, ASHTRAY.z);
ashtray.castShadow = true;
ashtray.receiveShadow = true;
scene.add(ashtray);

export function initTablePhysics() {
  // The table: a thick slab so nothing tunnels through it.
  const tableRoot = new THREE.Object3D();
  tableRoot.position.set(0, -5, 0);
  scene.add(tableRoot);
  new PhysicsBody(tableRoot, { type: 'fixed', shapes: [{ type: 'box', hx: 100, hy: 5, hz: 100 }], friction: 0.55, owner: { kind: 'table', material: 'wood' } });
  // Ashtray: exact triangle mesh so things can land in the bowl.
  const tm = trimeshFrom(ashGeo);
  new PhysicsBody(ashtray, { type: 'fixed', shapes: [{ type: 'trimesh', ...tm }], friction: 0.4, restitution: 0.2, owner: { kind: 'ashtray', material: 'glass' } });
}

/** Height of the ashtray surface (for particles that do not use physics). */
export function ashtrayHeight(x, z) {
  const d = Math.hypot(x - ASHTRAY.x, z - ASHTRAY.z);
  return d < ASHTRAY.rIn ? 0.27 : d < ASHTRAY.rRim ? 0.5 : 0;
}

const scorches = [];
export function addScorch(x, z, y = 0.004, size = 1) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: scorchTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
  );
  m.rotation.x = -Math.PI / 2;
  m.rotation.z = rand(0, 6.28);
  m.position.set(x, y, z);
  const s = rand(0.6, 1) * size;
  m.scale.set(s * 1.8, s, 1);
  scene.add(m);
  scorches.push(m);
  return m;
}
export function clearScorches() {
  for (const m of scorches) { scene.remove(m); m.material.dispose(); }
  scorches.length = 0;
}

const heightProviders = [ashtrayHeight];
export function addHeightProvider(fn) { heightProviders.push(fn); }
surface.heightAt = (x, z) => {
  let h = 0;
  for (const fn of heightProviders) h = Math.max(h, fn(x, z));
  return h;
};
