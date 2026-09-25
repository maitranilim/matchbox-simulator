import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { S } from './state.js';
import { clamp, rand } from './util.js';

export const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.getElementById('app').appendChild(renderer.domElement);

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x070605);
scene.fog = new THREE.FogExp2(0x070605, 0.011);

export const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.05, 400);
const VIEW_DIR = new THREE.Vector3(0.1, 10.4, 17.6);
export const HOME_TARGET = new THREE.Vector3(1.2, 0.8, -2.2);
camera.position.set(-9, 22, 34);

/** Where the camera settles after the intro, widened on portrait screens. */
export function homeCameraPosition() {
  const k = Math.min(Math.max(1, 1.75 / camera.aspect), 2.2);
  return HOME_TARGET.clone().addScaledVector(VIEW_DIR, k);
}

export const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(HOME_TARGET);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 5;
controls.maxDistance = 90;
controls.maxPolarAngle = Math.PI * 0.47;
controls.minPolarAngle = Math.PI * 0.06;
controls.enablePan = true;
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
controls.enabled = false;
camera.lookAt(controls.target);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.2;

export const hemi = new THREE.HemisphereLight(0x8fa6c8, 0x2a1d14, 0.4);
scene.add(hemi);
export const sun = new THREE.DirectionalLight(0xb8c9ff, 0.8);
sun.position.set(-14, 26, 12);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 24, bottom: -24, near: 1, far: 80 });
sun.shadow.bias = -4e-4;
sun.shadow.normalBias = 0.02;
scene.add(sun);

export function applyRoomLight() {
  const r = S.room;
  hemi.intensity = 0.06 + r * 1.1;
  sun.intensity = 0.05 + r * 2.4;
  scene.environmentIntensity = 0.03 + r * 0.45;
}

export const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
export const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.72, 0.5, 0.9);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const resizers = [];
export function onResize(fn) { resizers.push(fn); }
let lastAspect = camera.aspect;
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  if (S.started && Math.abs(lastAspect - camera.aspect) > 0.05) {
    const k0 = Math.min(Math.max(1, 1.75 / lastAspect), 2.2);
    const k1 = Math.min(Math.max(1, 1.75 / camera.aspect), 2.2);
    const off = camera.position.clone().sub(controls.target).multiplyScalar(k1 / k0);
    camera.position.copy(controls.target).add(off);
  }
  lastAspect = camera.aspect;
  // Pixel scale for point sprites: pixels per unit at distance 1.
  const pxScale = (h * renderer.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  for (const fn of resizers) fn(pxScale);
}
window.addEventListener('resize', resize);
export { resize };

const shakeOff = new THREE.Vector3();
export function render(dt) {
  let shaken = false;
  if (S.camShake > 0) {
    S.camShake = Math.max(0, S.camShake - dt);
    const a = S.camShake * 0.25;
    shakeOff.set(rand(-a, a), rand(-a, a), rand(-a, a));
    camera.position.add(shakeOff);
    shaken = true;
  }
  composer.render();
  if (shaken) camera.position.sub(shakeOff);
}

export function shake(amount) {
  S.camShake = clamp(Math.max(S.camShake, amount), 0, 0.8);
}

/** Pull the camera back (keeping its direction) until a point is comfortably on screen. */
export function frameInView(point, margin = 0.78) {
  const v = new THREE.Vector3();
  const dir = camera.position.clone().sub(controls.target);
  const d0 = dir.length();
  dir.normalize();
  let d = d0;
  const probe = camera.clone();
  for (; d < controls.maxDistance; d += 1.5) {
    probe.position.copy(controls.target).addScaledVector(dir, d);
    probe.lookAt(controls.target);
    probe.updateMatrixWorld();
    v.copy(point).project(probe);
    if (Math.abs(v.x) < margin && Math.abs(v.y) < margin && v.z < 1) break;
  }
  if (d - d0 < 0.5) return;
  const from = d0, to = Math.min(d, controls.maxDistance);
  let k = 0;
  const step = () => {
    k = Math.min(1, k + 1 / 50);
    const e = 1 - Math.pow(1 - k, 3);
    const cur = camera.position.clone().sub(controls.target).normalize();
    camera.position.copy(controls.target).addScaledVector(cur, from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  step();
}
