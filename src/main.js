import * as THREE from 'three';
import './style.css';
import { applyRoomLight, camera, controls, homeCameraPosition, render, resize } from './core/stage.js';
import { CANDLE_HOME, S } from './core/state.js';
import { $, clamp, damp, ease, noise1, toast, tween, updateTweens } from './core/util.js';
import { initPhysics, onImpact, stepPhysics, overlaps, allBodies, world as physicsWorld } from './physics/physics.js';
import { updateParticles } from './fx/particles.js';
import { updateFlames } from './fx/flame.js';
import { fire, updateFireLights } from './fire/fire.js';
import { sound } from './audio/sound.js';
import { initTablePhysics, clearScorches } from './world/table.js';
import { initMatchboxPhysics, onDrawerClosed, renewStrip, setDrawer, updateMatchbox } from './world/matchbox.js';
import { inBox, refillBox } from './world/match.js';
import { Candle } from './world/candle.js';
import { catalogById } from './items/catalog.js';
import { clearItems, spawnItem } from './items/spawn.js';
import { clouds, puddles, updateGasAndDust } from './items/effects.js';
import { dropHeld, strikeMatch, updateHand, updateHandControls } from './interaction/hand.js';
import './interaction/pointer.js';
import { actions, initUI, select, updateUI } from './ui/ui.js';

let homeCandle = null;

function buildWorld() {
  initTablePhysics();
  initMatchboxPhysics();
  homeCandle = new Candle(CANDLE_HOME.clone(), { name: 'Candle' });
  homeCandle.def = catalogById.candle;
  homeCandle.id = 'candle';
  homeCandle.permanent = true;
  homeCandle.initPhysics();
  S.items.push(homeCandle);
  refillBox(false);
}

// ---------------------------------------------------------------------------
// Actions

actions.blow = () => {
  S.blowT = 0.7;
  sound.blow();
  setTimeout(() => {
    if (S.held && S.held.lit) { S.held.extinguish('blow'); return; }
    let any = false;
    for (const m of S.matches) if (m.lit) { m.extinguish('blow'); any = true; }
    for (const it of S.items) {
      if (it.kind === 'candle' && it.lit) {
        const near = it.group.position.distanceTo(camera.position) < 80;
        if (near) { it.extinguish(); any = true; }
      }
    }
    const big = S.items.filter((it) => it.kind === 'item' && it.burning);
    if (big.length) {
      // Blowing on a real fire feeds it.
      for (const it of big) { it.intensityK = 1.5; setTimeout(() => (it.intensityK = 1), 1200); }
      toast('Blowing on a bigger fire only feeds it more oxygen.');
    } else if (!any) toast('Nothing to blow out.');
  }, 260);
};

actions.refill = () => {
  if (S.drawerOpen < 0.6) setDrawer(true);
  refillBox(true);
  toast('Box refilled.');
};

actions.cleanUp = () => {
  for (const m of [...S.matches]) {
    if (m.state !== 'dropped') continue;
    if (m.flame) m.flame.die(true);
    m.flame = null;
    m.lit = false;
    const g = m.group;
    tween(0.35, (t) => g.scale.setScalar(1 - t), { done: () => m.dispose() });
    S.matches.splice(S.matches.indexOf(m), 1);
  }
  clearItems();
  clearScorches();
  renewStrip();
  homeCandle.extinguish();
  homeCandle.reset(2.3);
  homeCandle.group.position.copy(CANDLE_HOME);
  homeCandle.group.quaternion.identity();
  homeCandle.phys.syncFromObject();
  homeCandle.phys.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  homeCandle.phys.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  select(null);
  toast('Table cleaned, striker renewed, fresh candle.');
};

onDrawerClosed(() => {
  let any = false;
  for (const m of inBox()) if (m.lit) { m.extinguish('box'); any = true; }
  if (any) toast('Closing the drawer smothered the flames.');
});

// Collision sounds, pitched by material and scaled by impact force.
const lastKnock = new WeakMap();
onImpact((a, b, force) => {
  if (!S.started) return;
  const oa = a?.owner, ob = b?.owner;
  const who = oa && oa.kind !== 'table' ? oa : ob;
  if (!who) return;
  const now = performance.now();
  if (now - (lastKnock.get(who) ?? 0) < 90) return;
  lastKnock.set(who, now);
  const v = clamp((Math.log10(force) - 3.6) * 0.1, 0, 0.45);
  if (v > 0.01) sound.knock(v, who.material ?? 'wood');
});

// ---------------------------------------------------------------------------
// Frame loop

let last = performance.now();
let paused = false;

function step(dt) {
  S.timeScale = damp(S.timeScale, S.timeTarget, 6, dt);
  const sdt = dt * S.timeScale;
  S.simTime += sdt;
  const t = S.simTime;
  const gust = 0.55 + 0.45 * noise1(t * 0.6) + 0.15 * (noise1(t * 2.3 + 7) - 0.5);
  S.windVec.set(0.95, 0, -0.3).normalize().multiplyScalar(S.wind * gust);
  S.blowT = Math.max(0, S.blowT - sdt);
  if (S.blowT > 0) S.windVec.add(new THREE.Vector3(0, 0, -1).multiplyScalar(S.blowT * 1.5));

  updateTweens(dt, sdt);
  updateMatchbox(inBox().length);
  updateHand(sdt, t);
  stepPhysics(sdt);

  // Heat: everyone registers flames, then everyone reacts to the total.
  fire.begin(sdt);
  for (const m of S.matches) m.addHeat();
  for (const it of S.items) it.addHeat();
  for (const p of puddles) p.addHeat();
  updateGasAndDust(sdt);
  for (const m of S.matches) m.heatFrom(sdt);
  for (const it of [...S.items]) it.heatFrom(sdt);
  for (const p of [...puddles]) p.heatFrom(sdt);

  for (const m of S.matches) m.update(sdt, t);
  for (const it of [...S.items]) {
    it.update(sdt, t);
    if (!it.removed && it.group.position.y < -30) it.remove();
  }
  for (const p of [...puddles]) p.update(sdt, t);
  updateFlames(sdt, t);
  updateParticles(sdt);
  updateFireLights(sdt, t);
  updateUI(dt);
  if (S.started) controls.update();
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = clamp((now - last) / 1000, 0, 0.05);
  last = Math.max(last, now);
  if (paused) return;
  step(dt);
  render(dt);
}

// ---------------------------------------------------------------------------
// Boot

async function boot() {
  resize();
  applyRoomLight();
  camera.lookAt(controls.target);
  await initPhysics();
  buildWorld();
  initUI();
  $('start-label').textContent = 'Light it up';
  $('start').disabled = false;
  $('hint').textContent = 'Ready.';
  requestAnimationFrame(frame);

  $('start').onclick = () => {
    sound.init();
    $('intro').classList.add('gone');
    setTimeout(() => ($('intro').style.display = 'none'), 900);
    const from = camera.position.clone();
    const to = homeCameraPosition();
    tween(2.4, (k) => {
      camera.position.lerpVectors(from, to, ease.inOutCubic(k));
      camera.lookAt(controls.target);
    }, {
      done: () => {
        S.started = true;
        controls.enabled = true;
        updateHandControls();
        setTimeout(() => { if (S.drawerOpen < 0.1 && !S.held) setDrawer(true); }, 250);
      },
    });
  };
}

boot().catch((err) => {
  console.error(err);
  $('start-label').textContent = 'Could not start (see console)';
});

// Handy for debugging and automated checks.
window.__sim = {
  S,
  step(n, dt = 1 / 60, draw = true) { paused = true; for (let i = 0; i < n; i++) step(dt); if (draw) render(dt); },
  resume() { paused = false; },
  spawn: spawnItem,
  camera,
  THREE,
  get candle() { return homeCandle; },
  /** Skip the intro: jump the camera home and hand over controls. */
  fastStart() {
    document.getElementById('intro').style.display = 'none';
    camera.position.copy(homeCameraPosition());
    camera.lookAt(controls.target);
    S.started = true;
    controls.enabled = true;
    updateHandControls();
    setDrawer(true);
  },
  takeNext: () => import('./interaction/hand.js').then((h) => h.takeNext()),
  drop: () => dropHeld(),
  strike: () => strikeMatch(),
  fire,
  overlaps,
  bodies: allBodies,
  get world() { return physicsWorld; },
  puddles,
  clouds,
  /** Hold a test flame (like a lighter) at a point for `sec` seconds of sim time. */
  torch(x, y, z, sec = 1, power = 1) { fire.pulse({ x, y, z }, { h: 1.4, r: 0.35, power, ttl: sec }); },
};
