import * as THREE from 'three';
import { scene } from '../core/stage.js';
import { BOX, S, STRIP } from '../core/state.js';
import { canvasTexture, ease, lerp, makeCanvas, rand, toast, tween, $ } from '../core/util.js';
import { PhysicsBody, groups, GROUP, ALL } from '../physics/physics.js';
import { sound } from '../audio/sound.js';
import { addHeightProvider } from './table.js';

const { len: L, depth: D, height: H, wall: W, drawerLen: DL, drawerDepth: DD, drawerHeight: DH } = BOX;

function labelTexture() {
  const w = 1024, h = 710;
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = '#16233b';
  g.fillRect(0, 0, w, h);
  const cx = w / 2, cy = h * 0.4;
  for (let i = 0; i < 40; i++) {
    const a0 = (i / 40) * Math.PI * 2, a1 = a0 + Math.PI / 40;
    g.fillStyle = i % 2 ? 'rgba(233,220,192,0.05)' : 'rgba(255,160,80,0.035)';
    g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, 700, a0, a1); g.closePath(); g.fill();
  }
  g.strokeStyle = '#e9dcc0';
  g.lineWidth = 10; g.strokeRect(26, 26, 972, 658);
  g.lineWidth = 3; g.strokeRect(46, 46, 932, 618);
  g.save();
  g.translate(cx, cy + 40);
  g.rotate(-0.12);
  g.fillStyle = '#e2c393'; g.fillRect(-9, 0, 18, 170);
  g.fillStyle = '#b3261a'; g.beginPath(); g.ellipse(0, -6, 17, 26, 0, 0, Math.PI * 2); g.fill();
  const flameShape = (k, col) => {
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(0, -24);
    g.bezierCurveTo(46 * k, -60 * k, 34 * k, -150 * k, 6 * k, -210 * k);
    g.bezierCurveTo(-8 * k, -150 * k, -52 * k, -110 * k, -30 * k, -54 * k);
    g.bezierCurveTo(-24 * k, -38, -12, -26, 0, -24);
    g.fill();
  };
  flameShape(1, '#ff7a2e'); flameShape(0.72, '#ffb347'); flameShape(0.45, '#fff0b8');
  g.restore();
  g.fillStyle = '#e9dcc0';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = 'bold 96px Georgia, "Times New Roman", serif';
  g.fillText('EMBER & OAK', cx, h * 0.76);
  g.font = '600 30px Georgia, serif';
  g.fillText('S A F E T Y   M A T C H E S', cx, h * 0.855);
  g.font = 'bold 34px Georgia, serif';
  g.textAlign = 'left'; g.fillText('24', 78, 96);
  g.textAlign = 'right'; g.font = '600 20px Georgia, serif'; g.fillText('STRIKE ON BOX', 948, 96);
  return canvasTexture(c);
}

function strikerCanvas() {
  const c = makeCanvas(1024, 230);
  const g = c.getContext('2d');
  g.fillStyle = '#5b2c1d';
  g.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < 26000; i++) {
    const x = Math.random() * c.width, y = Math.random() * c.height, r = Math.random();
    g.fillStyle = r < 0.45 ? `rgba(25,10,6,${rand(0.3, 0.7)})` : r < 0.85 ? `rgba(140,70,45,${rand(0.2, 0.6)})` : `rgba(220,190,160,${rand(0.15, 0.5)})`;
    const s = rand(1, 3.2);
    g.fillRect(x, y, s, s);
  }
  return c;
}

// Front striker gets worn as you strike; the back one stays fresh.
const strikerFresh = strikerCanvas();
export const striker = makeCanvas(strikerFresh.width, strikerFresh.height);
striker.getContext('2d').drawImage(strikerFresh, 0, 0);
const strikerTex = canvasTexture(striker, { aniso: 4 });
const strikerBackCanvas = makeCanvas(strikerFresh.width, strikerFresh.height);
strikerBackCanvas.getContext('2d').drawImage(strikerFresh, 0, 0);
const strikerBackTex = canvasTexture(strikerBackCanvas, { aniso: 4 });

const shellMat = new THREE.MeshStandardMaterial({ color: 0x16233b, roughness: 0.72 });
const bottomMat = new THREE.MeshStandardMaterial({ color: 0xcdba98, roughness: 0.9 });
const drawerMat = new THREE.MeshStandardMaterial({ color: 0xe6d9c2, roughness: 0.92 });
const labelMat = new THREE.MeshStandardMaterial({ map: labelTexture(), roughness: 0.6 });
const stripMat = new THREE.MeshStandardMaterial({ map: strikerTex, roughness: 0.97, bumpMap: strikerTex, bumpScale: 1.5 });
const stripBackMat = new THREE.MeshStandardMaterial({ map: strikerBackTex, roughness: 0.97, bumpMap: strikerBackTex, bumpScale: 1.5 });

export const boxGroup = new THREE.Group();
scene.add(boxGroup);
export const boxMeshes = [];
export const drawerMeshes = [];

function part(parent, list, geo, mat, x, y, z) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  list.push(m);
  return m;
}

// Shell: top (label), bottom, front and back walls. Open at both X ends.
part(boxGroup, boxMeshes, new THREE.BoxGeometry(L, W, D), [shellMat, shellMat, labelMat, bottomMat, shellMat, shellMat], 0, H - W / 2, 0);
part(boxGroup, boxMeshes, new THREE.BoxGeometry(L, W, D), bottomMat, 0, W / 2, 0);
part(boxGroup, boxMeshes, new THREE.BoxGeometry(L, H - 2 * W, W), shellMat, 0, H / 2, D / 2 - W / 2);
part(boxGroup, boxMeshes, new THREE.BoxGeometry(L, H - 2 * W, W), shellMat, 0, H / 2, -D / 2 + W / 2);

const stripFront = new THREE.Mesh(new THREE.PlaneGeometry(STRIP.x1 - STRIP.x0, STRIP.y1 - STRIP.y0), stripMat);
stripFront.position.set(0, (STRIP.y0 + STRIP.y1) / 2, D / 2 + 0.003);
stripFront.receiveShadow = true;
boxGroup.add(stripFront);
boxMeshes.push(stripFront);
const stripBack = new THREE.Mesh(stripFront.geometry, stripBackMat);
stripBack.position.set(0, stripFront.position.y, -D / 2 - 0.003);
stripBack.rotation.y = Math.PI;
boxGroup.add(stripBack);
boxMeshes.push(stripBack);

// Drawer (tray) slides out along +X.
export const drawer = new THREE.Group();
boxGroup.add(drawer);
drawer.position.set(0, W + 0.012, 0);
part(drawer, drawerMeshes, new THREE.BoxGeometry(DL, W, DD), drawerMat, 0, W / 2, 0);
part(drawer, drawerMeshes, new THREE.BoxGeometry(W, DH, DD), [shellMat, drawerMat, drawerMat, drawerMat, drawerMat, drawerMat], DL / 2 - W / 2, DH / 2, 0);
part(drawer, drawerMeshes, new THREE.BoxGeometry(W, DH, DD), drawerMat, -DL / 2 + W / 2, DH / 2, 0);
part(drawer, drawerMeshes, new THREE.BoxGeometry(DL, DH, W), drawerMat, 0, DH / 2, DD / 2 - W / 2);
part(drawer, drawerMeshes, new THREE.BoxGeometry(DL, DH, W), drawerMat, 0, DH / 2, -DD / 2 + W / 2);

export const matchbox = {
  kind: 'matchbox',
  material: 'wood',
  shell: null,
  tray: null,
  bed: null,
};

export function initMatchboxPhysics() {
  // Colliders are thickened inwards (the drawer fills that space anyway) so
  // thin sticks cannot squeeze through the 0.5 mm card walls.
  const T = 0.18;
  const shapes = [
    { type: 'box', hx: L / 2, hy: T / 2, hz: D / 2, pos: [0, H - T / 2, 0] },
    { type: 'box', hx: L / 2, hy: W / 2, hz: D / 2, pos: [0, W / 2, 0] },
    { type: 'box', hx: L / 2, hy: H / 2, hz: T / 2, pos: [0, H / 2, D / 2 - T / 2] },
    { type: 'box', hx: L / 2, hy: H / 2, hz: T / 2, pos: [0, H / 2, -D / 2 + T / 2] },
  ];
  // Held down on the table by your other hand, so the shell does not move.
  matchbox.shell = new PhysicsBody(boxGroup, { type: 'fixed', shapes, friction: 0.7, owner: matchbox });
  const trayShapes = [
    { type: 'box', hx: DL / 2, hy: W / 2, hz: DD / 2, pos: [0, W / 2, 0] },
    { type: 'box', hx: W / 2, hy: DH / 2, hz: DD / 2, pos: [DL / 2 - W / 2, DH / 2, 0] },
    { type: 'box', hx: W / 2, hy: DH / 2, hz: DD / 2, pos: [-DL / 2 + W / 2, DH / 2, 0] },
    { type: 'box', hx: DL / 2, hy: DH / 2, hz: W / 2, pos: [0, DH / 2, DD / 2 - W / 2] },
    { type: 'box', hx: DL / 2, hy: DH / 2, hz: W / 2, pos: [0, DH / 2, -DD / 2 + W / 2] },
  ];
  matchbox.tray = new PhysicsBody(drawer, { type: 'kinematic', shapes: trayShapes, friction: 0.7, owner: matchbox });
  // The loose matches in the tray act as one solid "bed" while any remain.
  matchbox.bed = matchbox.tray.addShape({ type: 'box', hx: DL / 2 - 0.3, hy: 0.13, hz: DD / 2 - 0.1, pos: [0, W + 0.13, 0] });
}

export function updateMatchbox(inBoxCount) {
  drawer.position.x = BOX.drawerTravel * S.drawerOpen;
  if (matchbox.tray) {
    matchbox.tray.syncFromObject();
    matchbox.bed.setEnabled(inBoxCount > 0);
  }
}

let smotherCb = null;
export function onDrawerClosed(fn) { smotherCb = fn; }

export function setDrawer(open) {
  const from = S.drawerOpen, to = open ? 1 : 0;
  if (S.drawerTween) S.drawerTween.dead = true;
  sound.drawer();
  S.drawerTween = tween(open ? 0.75 : 0.55, (t) => {
    S.drawerOpen = lerp(from, to, open ? ease.outBack(t) : ease.inOutCubic(t));
  }, {
    done: () => {
      S.drawerTween = null;
      if (!open && smotherCb) smotherCb();
    },
  });
  $('b-box').firstChild.textContent = open ? 'Close box' : 'Open box';
}

/** UV of a world point on the front striker. */
export function stripUV(p) {
  return { u: (p.x - STRIP.x0) / (STRIP.x1 - STRIP.x0), v: (p.y - STRIP.y0) / (STRIP.y1 - STRIP.y0) };
}
export function scuffStrip(a, b, alpha, width) {
  const g = striker.getContext('2d');
  g.strokeStyle = `rgba(18,10,6,${alpha})`;
  g.lineWidth = width;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(a.u * striker.width, (1 - a.v) * striker.height);
  g.lineTo(b.u * striker.width, (1 - b.v) * striker.height);
  g.stroke();
  strikerTex.needsUpdate = true;
}
export function renewStrip() {
  striker.getContext('2d').drawImage(strikerFresh, 0, 0);
  strikerTex.needsUpdate = true;
}

addHeightProvider((x, z) => {
  if (Math.abs(x) < L / 2 && Math.abs(z) < D / 2) return H;
  const dx = BOX.drawerTravel * S.drawerOpen;
  if (x > dx - DL / 2 && x < dx + DL / 2 && Math.abs(z) < DD / 2) return 0.36;
  return 0;
});

export function smotherToast() { toast('Closing the drawer smothered the flames.'); }
