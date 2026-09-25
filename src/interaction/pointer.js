import * as THREE from 'three';
import { camera, controls, renderer } from '../core/stage.js';
import { S } from '../core/state.js';
import { clamp, _v1 } from '../core/util.js';
import { groundBelow, onPreStep } from '../physics/physics.js';
import { sound } from '../audio/sound.js';
import { boxMeshes, drawerMeshes, setDrawer, boxGroup } from '../world/matchbox.js';
import { pickMatch, updateHandControls } from './hand.js';

/**
 * Pointer input: orbit the camera, click the box and matches, and grab
 * cupboard items. Grabbed items are pulled by a spring at the grab point
 * (like holding something by one spot), so heavy things lag and swing and
 * everything still collides.
 */
const el = renderer.domElement;
const container = document.getElementById('app');
const raycaster = new THREE.Raycaster();
const plane = new THREE.Plane();
let down = null;
let onSelect = () => {};
export function onItemSelect(fn) { onSelect = fn; }

function setNdc(e) {
  const r = el.getBoundingClientRect();
  S.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
}

function itemMeshes() {
  const out = [];
  for (const it of S.items) it.group.traverse((o) => { if (o.isMesh && o.visible && o.material.visible !== false) out.push(o); });
  return out;
}

/** What is under the pointer: { kind: 'item'|'match'|'box', item?, match?, point }. */
function pick() {
  raycaster.setFromCamera(S.ndc, camera);
  const cands = [];
  const openMatches = S.drawerOpen > 0.55 ? S.matches.filter((m) => m.state === 'box').map((m) => m.hit) : [];
  const dropped = S.matches.filter((m) => m.state === 'dropped' && !m.lit).map((m) => m.hit);
  for (const h of raycaster.intersectObjects([...openMatches, ...dropped], false)) {
    // Only matches sticking out of the box are reachable.
    if (h.object.userData.match.state === 'box' && h.point.x < 2.65) continue;
    cands.push({ kind: 'match', match: h.object.userData.match, point: h.point, distance: h.distance - 0.2 });
    break;
  }
  const ih = raycaster.intersectObjects(itemMeshes(), false)[0];
  if (ih) cands.push({ kind: 'item', item: ih.object.userData.item, point: ih.point, distance: ih.distance });
  const bh = raycaster.intersectObjects([...boxMeshes, ...drawerMeshes], false)[0];
  if (bh) cands.push({ kind: 'box', point: bh.point, distance: bh.distance });
  cands.sort((a, b) => a.distance - b.distance);
  return cands[0] ?? null;
}

// ---------------------------------------------------------------------------
// Grabbing items.

function startGrab(item, point) {
  if (!item.phys || !item.phys.body) return;
  const local = item.group.worldToLocal(point.clone());
  // How far the grab point sits above the item's lowest point, so the item
  // can be carried up and over whatever it is moved across.
  const bottom = new THREE.Box3().setFromObject(item.group).min.y;
  S.grab = { item, local, height: point.y + 2.5, clear: point.y - bottom + 0.6, target: point.clone(), prevDamp: item.phys.body.angularDamping() };
  item.phys.body.setAngularDamping(5);
  item.phys.body.wakeUp();
  controls.enabled = false;
  el.style.cursor = 'grabbing';
  sound.tick(0.15);
}

function endGrab() {
  const g = S.grab;
  if (!g) return;
  if (g.item.phys && g.item.phys.body) g.item.phys.body.setAngularDamping(g.prevDamp);
  S.grab = null;
  controls.enabled = S.started;
}

function updateGrabTarget() {
  const g = S.grab;
  if (!g) return;
  raycaster.setFromCamera(S.ndc, camera);
  plane.set(new THREE.Vector3(0, 1, 0), -g.height);
  const p = raycaster.ray.intersectPlane(plane, _v1);
  if (p) {
    g.target.set(clamp(p.x, -40, 40), g.height, clamp(p.z, -30, 14));
    // Rise over anything underneath (a candle, the stove), like a hand
    // lifting a thing over an obstacle rather than pushing it through.
    const floor = groundBelow({ x: g.target.x, y: 60, z: g.target.z }, g.item.phys);
    g.target.y = Math.min(40, Math.max(g.target.y, floor + g.clear));
  }
}

onPreStep((dt) => {
  const g = S.grab;
  if (!g) return;
  if (!g.item.phys || !g.item.phys.body || g.item.removed) { endGrab(); return; }
  // A hand can hold up about 30 N; heavy things hang lower and lag more.
  g.item.phys.driveTo(g.local, g.target, { gain: 12, maxForce: 3e6, dt });
});

// ---------------------------------------------------------------------------

function onDown(e) {
  if (!S.started) return;
  setNdc(e);
  S.pointerType = e.pointerType;
  if (e.button !== 0) return;
  S.pressed = true;
  down = { x: e.clientX, y: e.clientY, t: performance.now(), hit: null };
  if (S.held) return;
  const hit = pick();
  down.hit = hit;
  if (hit && hit.kind === 'item') {
    // Stop the orbit controls from taking this gesture.
    controls.enabled = false;
  }
}

function onMove(e) {
  setNdc(e);
  S.pointerType = e.pointerType;
  if (!S.started) return;
  if (down && down.hit && down.hit.kind === 'item' && !S.grab && !S.held) {
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) startGrab(down.hit.item, down.hit.point);
  }
  if (S.grab) { updateGrabTarget(); return; }
  if (S.held) return;
  const hit = pick();
  for (const m of S.matches) m.hovered = false;
  S.hoverItem = null;
  if (hit && hit.kind === 'match') hit.match.hovered = true;
  if (hit && hit.kind === 'item') S.hoverItem = hit.item;
  el.style.cursor = hit ? (hit.kind === 'item' ? 'grab' : 'pointer') : 'default';
}

function onUp(e) {
  if (e.button !== 0) return;
  S.pressed = false;
  const d = down;
  down = null;
  if (S.grab) { endGrab(); return; }
  if (!d) return;
  const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
  const quick = performance.now() - d.t < 600;
  controls.enabled = S.started;
  updateHandControls();
  if (moved > 7 || !quick || S.held) return;
  const hit = d.hit;
  if (!hit) { onSelect(null); return; }
  if (hit.kind === 'match') { pickMatch(hit.match); el.style.cursor = 'default'; return; }
  if (hit.kind === 'item') { onSelect(hit.item); return; }
  if (hit.kind === 'box') setDrawer(S.drawerOpen < 0.5);
}

container.addEventListener('pointerdown', onDown, true);
window.addEventListener('pointermove', onMove);
window.addEventListener('pointerup', onUp);
el.addEventListener('contextmenu', (e) => e.preventDefault());
el.addEventListener('wheel', (e) => {
  if (S.grab) {
    e.preventDefault();
    e.stopImmediatePropagation();
    S.grab.height = clamp(S.grab.height + (e.deltaY > 0 ? -1 : 1), 0.5, 30);
    updateGrabTarget();
    return;
  }
  if (S.held) {
    e.preventDefault();
    setTilt(S.tilt + (e.deltaY > 0 ? 1 : -1) * THREE.MathUtils.degToRad(5));
  }
}, { passive: false, capture: true });

let tiltCb = () => {};
export function onTilt(fn) { tiltCb = fn; }
export function setTilt(a) {
  S.tilt = clamp(a, THREE.MathUtils.degToRad(-60), THREE.MathUtils.degToRad(60));
  tiltCb(S.tilt);
}

export { boxGroup };
