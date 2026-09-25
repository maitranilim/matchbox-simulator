import * as THREE from 'three';
import { camera, controls, scene } from '../core/stage.js';
import { MATCH, S, STRIP } from '../core/state.js';
import { clamp, damp, ease, rand, toast, tween, _v1, _v2, _v3 } from '../core/util.js';
import { onPreStep, raycast } from '../physics/physics.js';
import { emitSparks } from '../fx/particles.js';
import { sound } from '../audio/sound.js';
import { scuffStrip, setDrawer, stripUV } from '../world/matchbox.js';
import { inBox } from '../world/match.js';

/**
 * The hand holding a match. The pointer sets where the match head should
 * be; a force-limited controller pulls the match's rigid body there, so it
 * slides over and bumps into things instead of passing through them.
 */
const GN = MATCH.len;
const raycaster = new THREE.Raycaster();
const _q = new THREE.Quaternion();
const Y = new THREE.Vector3(0, 1, 0);

/** Direction the stick points from the head, given the tilt. */
function stickDir(t, withVel = true) {
  const a = S.tilt;
  t.set(Math.cos(a), Math.sin(a), 0.6);
  if (withVel) {
    t.x -= clamp(S.headVel.x * 0.012, -0.4, 0.4);
    t.y -= clamp(S.headVel.y * 0.012, -0.4, 0.4);
  }
  return t.normalize();
}
function heldQuat(q) { return q.setFromUnitVectors(Y, stickDir(_v3).negate()); }

export function updateHandControls() {
  const holding = !!S.held;
  controls.mouseButtons.LEFT = holding ? -1 : THREE.MOUSE.ROTATE;
  controls.touches.ONE = holding ? -1 : THREE.TOUCH.ROTATE;
  controls.enableZoom = !holding;
}

export function pickMatch(m) {
  if (S.held || (m.state !== 'box' && m.state !== 'dropped')) return;
  if (S.grab) return;
  if (m.slot) { m.slot.match = null; m.slot = null; }
  const wasDropped = m.state === 'dropped';
  if (m.phys) { m.phys.dispose(); m.phys = null; }
  scene.attach(m.group); // keep its world transform
  m.state = 'lifting';
  m.hovered = false;
  const p0 = m.group.position.clone();
  const q0 = m.group.quaternion.clone();
  S.held = m;
  S.headPos.copy(p0);
  S.strikeEnergy = 0;
  S.anchorB = 0;
  sound.tick(0.3);
  tween(wasDropped ? 0.4 : 0.6, (k) => {
    if (m.state !== 'lifting') return;
    const e = ease.inOutCubic(k);
    const target = S.headTarget;
    const mid = _v1.copy(p0).lerp(target, 0.5);
    mid.y += 1.6;
    const a = _v2.copy(p0).lerp(mid, e);
    const b = _v3.copy(mid).lerp(target, e);
    m.group.position.copy(a.lerp(b, e));
    m.group.quaternion.copy(q0).slerp(heldQuat(_q), e);
    S.headPos.copy(m.group.position);
  }, {
    done: () => {
      if (S.held !== m) return;
      m.state = 'held';
      m.makePhysical(true);
      m.setHeld(true);
      S.prevHead.copy(S.headPos);
    },
  });
  updateHandControls();
}

export function takeNext() {
  if (S.held) { toast('You are already holding a match.'); return; }
  const usable = inBox().filter((m) => m.canIgnite());
  if (!usable.length) { toast('No usable matches left. Press R to refill.'); return; }
  usable.sort((a, b) => (b.headState === 'fresh') - (a.headState === 'fresh') || b.slot.layer - a.slot.layer || b.slot.pos.z - a.slot.pos.z);
  const m = usable[0];
  if (S.drawerOpen < 0.6) { setDrawer(true); setTimeout(() => pickMatch(m), 650); } else pickMatch(m);
}

export function dropHeld(reason) {
  const m = S.held;
  if (!m) return;
  S.held = null;
  m.hovered = false;
  if (m.state === 'lifting') { m.makePhysical(false); }
  m.state = 'dropped';
  m.restT = 0;
  m.setHeld(false);
  if (m.phys) m.phys.body.setAngvel({ x: rand(-4, 4), y: rand(-2, 2), z: rand(-4, 4) }, true);
  // Keep the table from filling up with spent matches.
  const dropped = S.matches.filter((x) => x.state === 'dropped');
  if (dropped.length > 40) {
    const old = dropped.find((x) => !x.lit && x.restT > 1);
    if (old) { old.dispose(); S.matches.splice(S.matches.indexOf(old), 1); }
  }
  if (reason === 'fingers') { toast('Ouch! Too hot, you dropped it.'); S.camShake = 0.2; }
  updateHandControls();
}

// ---------------------------------------------------------------------------
// Pointer → head target.

/** Where the ray meets the striker plane, if it does. */
function stripHit(ray) {
  if (Math.abs(ray.direction.z) < 1e-5) return null;
  const t = (STRIP.z - ray.origin.z) / ray.direction.z;
  if (t < 0) return null;
  return { t, p: ray.origin.clone().addScaledVector(ray.direction, t) };
}

function updateTarget() {
  raycaster.setFromCamera(S.ndc, camera);
  const ray = raycaster.ray;
  const m = S.held;
  S.contact = false;
  const hit = raycast(ray.origin, ray.direction, 400, m && m.phys ? m.phys : null);
  if (!hit) return;
  if (S.pressed && m && m.state === 'held' && m.headState !== 'crumbled') {
    const sh = stripHit(ray);
    if (sh && sh.t <= hit.toi + 0.6) {
      const p = sh.p;
      if (p.x > STRIP.x0 + 0.05 && p.x < STRIP.x1 - 0.05 && p.y > STRIP.y0 + 0.06 && p.y < STRIP.y1 - 0.06) {
        S.contact = true;
        S.headTarget.copy(p);
        return;
      }
    }
  }
  // Hover the head 0.4 cm off whatever is under the pointer; holding the
  // button presses it down onto the surface (physics stops it going in).
  const off = S.pressed && m && m.state === 'held' ? -0.15 : 0.4;
  const target = hit.point.clone().addScaledVector(hit.normal, off);
  if (off > 0) target.y = Math.max(target.y, hit.point.y + off);
  const dir = stickDir(_v1, false);
  if (dir.y < 0) target.y = Math.max(target.y, -dir.y * GN + 0.15);
  target.x = clamp(target.x, -30, 30);
  target.z = clamp(target.z, -24, 10);
  target.y = clamp(target.y, 0.3, 20);
  S.headTarget.copy(target);
}

function burnAnchor(m) {
  return m.headState === 'fresh' || m.headState === 'crumbled' ? 0 : clamp(m.burn, 0, GN);
}

const localAnchor = new THREE.Vector3();
const wantQuat = new THREE.Quaternion();

/** Per-frame: move the hand target, detect strikes and shake-outs. */
export function updateHand(dt, t) {
  const m = S.held;
  updateTarget();
  if (!m || m.state === 'lifting') return;
  S.prevHead.copy(S.headPos);
  const tgt = _v1.copy(S.headTarget);
  if (!S.contact) { tgt.x += Math.sin(t * 1.3) * 0.02; tgt.y += Math.sin(t * 1.7 + 1) * 0.025; }
  const rate = S.contact ? 45 : 26;
  S.headPos.x = damp(S.headPos.x, tgt.x, rate, dt);
  S.headPos.y = damp(S.headPos.y, tgt.y, rate, dt);
  S.headPos.z = damp(S.headPos.z, tgt.z, S.contact ? 60 : 18, dt);
  // Lift the hand over whatever is below it, like a real hand would,
  // unless it is deliberately pressing the match onto something.
  if (!S.contact && !S.pressed) {
    const below = raycast({ x: S.headPos.x, y: S.headPos.y + 30, z: S.headPos.z }, { x: 0, y: -1, z: 0 }, 60, m.phys);
    if (below) S.headPos.y = Math.max(S.headPos.y, below.point.y + 0.3);
  }
  const v = _v2.copy(S.headPos).sub(S.prevHead).divideScalar(Math.max(dt, 1e-4));
  S.headVel.lerp(v, 1 - Math.exp(-dt * 30));
  S.anchorB = damp(S.anchorB || 0, burnAnchor(m), 8, dt);

  const speed = Math.hypot(S.headVel.x, S.headVel.y);
  // Shake it out: four fast direction changes within 0.7 s.
  if (m.lit && !S.contact) {
    const dir = Math.sign(S.headVel.x);
    if (speed > 14 && dir !== 0 && dir !== S.lastShakeDir) { S.shakeTimes.push(t); S.lastShakeDir = dir; }
    while (S.shakeTimes.length && t - S.shakeTimes[0] > 0.7) S.shakeTimes.shift();
    if (S.shakeTimes.length >= 4 && m.litTime > 0.8) { m.extinguish('shake'); S.shakeTimes.length = 0; }
  }
  if (m.lit && m.burn > GN - 0.75) { dropHeld('fingers'); return; }

  // Striking.
  if (S.contact && m.headState === 'fresh' && !m.lit) {
    const head = m.headWorld(_v3);
    if (!S.contactPrev) {
      S.strikeThresh = rand(0.8, 1.5) + m.wear * 1.1;
      S.strokeCounted = false;
      S.lastUV = stripUV(head);
    }
    const uv = stripUV(head);
    if (speed > 4) {
      S.strikeEnergy += (speed - 4) * dt * 0.5;
      m.wear += speed * dt * 0.011;
      if (!S.strokeCounted) { S.strokeCounted = true; S.stats.strikes++; }
      const n = Math.floor(speed * dt * 16 + (Math.random() < 0.3 ? 1 : 0));
      emitSparks(head, n, _v2.set(-Math.sign(S.headVel.x) * 0.8, 0.3, 0.5).normalize(), 30 + speed * 2, 25);
      scuffStrip(S.lastUV, uv, clamp(0.05 + speed * 0.006, 0, 0.2), 5);
    } else if (speed > 0.8) {
      m.wear += dt * 0.12;
      S.strikeEnergy = Math.max(0, S.strikeEnergy - dt * 0.6);
      scuffStrip(S.lastUV, uv, 0.04, 4);
    }
    S.lastUV = uv;
    sound.setScratch(clamp(speed / 14, 0, 1) * 0.55, speed);
    if (S.strikeEnergy > S.strikeThresh) {
      S.strikeEnergy = 0;
      m.ignite(true);
      scuffStrip(uv, { u: uv.u + 0.02, v: uv.v }, 0.35, 16);
    } else if (m.wear > 1) m.crumble();
  } else {
    sound.setScratch(0, 0);
    S.strikeEnergy = Math.max(0, S.strikeEnergy - dt * 1.5);
  }
  S.contactPrev = S.contact;
}

// Physics side: pull the held match's anchor point to the hand position.
onPreStep((dt) => {
  const m = S.held;
  if (!m || m.state !== 'held' || !m.phys) return;
  localAnchor.set(0, -(S.anchorB || 0), 0);
  heldQuat(wantQuat);
  m.phys.alignTo(wantQuat, { gain: 16, maxRate: 40 });
  // Fingers push a match with at most ~0.8 N; a match weighs about 0.1 g,
  // so this is plenty to move it but it still stops against solid objects.
  m.phys.driveTo(localAnchor, S.headPos, { gain: S.contact ? 60 : 32, maxForce: 8e4, maxSpeed: 250, dt, atPoint: false });
});
