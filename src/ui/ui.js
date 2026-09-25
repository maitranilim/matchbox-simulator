import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { applyRoomLight, bloom } from '../core/stage.js';
import { MATCH, S } from '../core/state.js';
import { $, clamp, toast } from '../core/util.js';
import { sound } from '../audio/sound.js';
import { CATALOG, catalogById } from '../items/catalog.js';
import { Item } from '../items/item.js';
import { Candle } from '../world/candle.js';
import { spawnItem } from '../items/spawn.js';
import { setDrawer } from '../world/matchbox.js';
import { inBox } from '../world/match.js';
import { dropHeld, strikeMatch, takeNext } from '../interaction/hand.js';
import { onItemSelect, onTilt, setTilt } from '../interaction/pointer.js';
import { puddles } from '../items/effects.js';

/** Hooks main.js provides (actions that touch many modules). */
export const actions = { blow() {}, refill() {}, cleanUp() {} };

// ---------------------------------------------------------------------------
// Cupboard

const CUPBOARD_HINT = matchMedia('(pointer: coarse)').matches ? 'tap <em>Cupboard</em> for more things to burn' : '<em>I</em> opens the cupboard';
const thumbs = new Map();

/** Render a small picture of every cupboard item once, offscreen. */
function renderThumbnails() {
  const size = 176;
  const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  r.setSize(size, size);
  r.setPixelRatio(1);
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const pm = new THREE.PMREMGenerator(r);
  {
    scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.55;
    scene.add(new THREE.HemisphereLight(0xfff1e0, 0x3a2a20, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-3, 6, 5);
    scene.add(key);
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 500);
    for (const def of CATALOG) {
      let obj, dispose;
      if (def.custom) {
        const c = new Candle(new THREE.Vector3(), { name: 'Candle' });
        c.group.removeFromParent();
        obj = c.group;
        dispose = () => {};
      } else {
        const it = new Item(def);
        obj = it.group;
        dispose = () => obj.traverse((o) => o.material && (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose()));
      }
      scene.add(obj);
      const box = new THREE.Box3().setFromObject(obj);
      const c = box.getCenter(new THREE.Vector3());
      const s = box.getSize(new THREE.Vector3()).length();
      cam.position.copy(c).add(new THREE.Vector3(0.9, 0.75, 1.25).normalize().multiplyScalar(s * 1.75));
      cam.lookAt(c);
      r.render(scene, cam);
      thumbs.set(def.id, r.domElement.toDataURL('image/png'));
      scene.remove(obj);
      dispose();
    }
    for (const img of document.querySelectorAll('.tile img')) img.src = thumbs.get(img.dataset.id) || '';
    r.dispose();
    r.forceContextLoss();
  }
}

function buildCupboard() {
  const shelves = $('shelves');
  const groups = {};
  for (const def of CATALOG) (groups[def.shelf] ??= []).push(def);
  for (const [name, defs] of Object.entries(groups)) {
    const label = document.createElement('div');
    label.className = 'shelf-label';
    label.textContent = name;
    const shelf = document.createElement('div');
    shelf.className = 'shelf';
    for (const def of defs) {
      const b = document.createElement('button');
      b.className = 'tile';
      b.title = def.blurb;
      b.innerHTML = `<img alt="" data-id="${def.id}"><span class="nm">${def.name}</span><span class="tg">${def.tag}</span>`;
      b.onclick = () => {
        sound.init();
        const it = spawnItem(def.id);
        if (it) {
          sound.drawer();
          toast(`${def.name} is on the table. Drag it where you want it.`);
          select(it);
        }
        closeCupboard();
      };
      shelf.appendChild(b);
    }
    shelves.append(label, shelf);
  }
}

export function openCupboard() {
  const c = $('cupboard');
  c.hidden = false;
  sound.drawer();
  requestAnimationFrame(() => requestAnimationFrame(() => c.classList.add('open')));
}
export function closeCupboard() {
  const c = $('cupboard');
  c.classList.remove('open');
  c.hidden = true;
}
function toggleCupboard() { $('cupboard').hidden ? openCupboard() : closeCupboard(); }

// ---------------------------------------------------------------------------
// Inspector

let insTimer = 0;
let actionKey = '';

export function select(item) {
  S.selected = item;
  const el = $('inspector');
  if (!item) { el.hidden = true; return; }
  el.hidden = false;
  const def = item.def ?? catalogById[item.id];
  $('ins-name').textContent = item.name;
  $('ins-tag').textContent = def?.tag ?? '';
  $('ins-blurb').textContent = def?.blurb ?? '';
  actionKey = '';
  refreshInspector(true);
}

function itemActions(item) {
  const def = item.def ?? {};
  const list = (def.actions ?? []).map((a) => ({
    id: a.id,
    label: typeof a.label === 'function' ? a.label(item) : a.label,
    enabled: a.enabled ? a.enabled(item) : true,
    run: () => { sound.init(); a.run(item); refreshInspector(true); },
    primary: true,
  }));
  if (!item.permanent) list.push({ id: 'putback', label: item.burning ? 'Put back (it is burning!)' : 'Put back', enabled: !item.burning, run: () => { item.remove(); select(null); } });
  return list;
}

function refreshInspector(force) {
  const item = S.selected;
  if (!item) return;
  if (item.removed) { select(null); return; }
  const T = item.temperature;
  $('ins-temp').textContent = T >= 999 ? 'flame' : `${Math.round(T)} °C`;
  $('ins-mass').textContent = formatMass(item.mass);
  $('ins-bar').style.width = `${clamp((Math.min(T, 800) - 20) / 780, 0, 1) * 100}%`;
  const st = $('ins-status');
  st.textContent = item.statusText();
  st.classList.toggle('hot', !!item.burning || T > 150);
  const acts = itemActions(item);
  const key = acts.map((a) => a.id + a.label + a.enabled).join('|');
  if (force || key !== actionKey) {
    actionKey = key;
    const box = $('ins-actions');
    box.innerHTML = '';
    for (const a of acts) {
      const b = document.createElement('button');
      b.textContent = a.label;
      b.disabled = !a.enabled;
      if (a.primary) b.className = 'primary';
      b.onclick = a.run;
      box.appendChild(b);
    }
  }
}

function formatMass(g) {
  if (!g) return '–';
  if (g < 1) return `${(g * 1000).toFixed(0)} mg`;
  if (g < 10) return `${g.toFixed(2)} g`;
  if (g < 1000) return `${g.toFixed(1)} g`;
  return `${(g / 1000).toFixed(2)} kg`;
}

// ---------------------------------------------------------------------------
// HUD

let hudTimer = 0;
let lastHint = '';
export function updateUI(dt) {
  hudTimer -= dt;
  insTimer -= dt;
  if (insTimer < 0) { insTimer = 0.15; refreshInspector(false); }
  if (hudTimer > 0) return;
  hudTimer = 0.1;
  const fresh = S.matches.filter((m) => m.state === 'box' && m.headState === 'fresh' && !m.everLit).length;
  $('st-left').textContent = fresh;
  $('st-strikes').textContent = S.stats.strikes;
  $('st-lit').textContent = S.stats.lit;
  let fires = S.matches.filter((m) => m.lit).length + S.items.filter((i) => i.burning || i.lit).length;
  for (const p of puddles) if (p.lit) fires++;
  $('st-fires').textContent = fires;

  const m = S.held;
  let hint;
  if (S.grab) hint = `Moving the ${S.grab.item.name.toLowerCase()} · <em>scroll</em> to lift or lower · let go to drop`;
  else if (m) {
    if (m.state === 'lifting') hint = 'Picking up…';
    else if (m.lit && S.assist === 'wick') hint = 'Holding the flame to the wick…';
    else if (m.lit && S.assist === 'burner') hint = 'Holding the flame to the burner…';
    else if (m.lit) hint = 'Burning! Point at a wick, a burner or anything flammable · <em>scroll</em> to tilt · <em>B</em> blow · <em>Space</em> drop';
    else if (m.headState === 'crumbled') hint = 'The head crumbled. Press <em>Space</em> to drop it';
    else if (m.headState === 'fresh') hint = S.pointerType === 'touch' ? 'Touch the brown strip and <em>swipe</em> across it to strike, or tap <em>Strike</em>' : 'Hold the mouse on the brown strip and <em>swipe</em> across it to strike, or press <em>S</em>';
    else if (S.assist === 'flame') hint = 'Relighting it in the flame…';
    else hint = m.burn < MATCH.len - 0.8 ? 'Spent. Relight it in another flame, or press <em>Space</em> to drop it' : 'Burnt out. Press <em>Space</em> to drop it';
  } else {
    if (S.drawerOpen < 0.5) hint = fresh ? `Click the matchbox to slide the drawer open <em>(or press N)</em> · ${CUPBOARD_HINT}` : 'Box is empty. Press <em>R</em> to refill';
    else hint = fresh ? `Click a match to pick it up · ${CUPBOARD_HINT}` : 'No fresh matches. Press <em>R</em> to refill';
    if (inBox().some((x) => x.lit)) hint = 'The box is on fire! Click the box to <em>close the drawer</em> and smother it, or press <em>B</em>';
  }
  if (hint !== lastHint) { $('hint').innerHTML = hint; lastHint = hint; }
  const striking = m && m.state === 'held' && m.headState === 'fresh' && !m.lit;
  $('meters').classList.toggle('show', !!striking);
  if (striking) {
    $('m-heat').style.width = `${clamp(S.strikeEnergy / S.strikeThresh, 0, 1) * 100}%`;
    $('m-wear').style.width = `${clamp(m.wear, 0, 1) * 100}%`;
  }
}

// ---------------------------------------------------------------------------
// Buttons and keys

function toggleSlow() {
  S.timeTarget = S.timeTarget === 1 ? 0.2 : 1;
  $('b-slow').classList.toggle('on', S.timeTarget !== 1);
  toast(S.timeTarget !== 1 ? 'Slow motion on' : 'Normal speed');
}
function toggleSound() {
  S.sound = !S.sound;
  sound.setMuted(!S.sound);
  $('b-sound').classList.toggle('on', S.sound);
}
function togglePanel() { $('panel').classList.toggle('hidden'); }

export function initUI() {
  buildCupboard();
  renderThumbnails();
  onItemSelect(select);
  onTilt((a) => {
    const d = Math.round(THREE.MathUtils.radToDeg(a));
    $('s-tilt').value = d;
    $('v-tilt').textContent = `${d}°`;
  });
  $('b-cupboard').onclick = openCupboard;
  $('cab-close').onclick = closeCupboard;
  $('cupboard').addEventListener('pointerdown', (e) => { if (e.target.id === 'cupboard') closeCupboard(); });
  $('ins-close').onclick = () => select(null);
  $('b-box').onclick = () => setDrawer(S.drawerOpen < 0.5);
  $('b-take').onclick = takeNext;
  $('b-strike').onclick = strikeMatch;
  $('b-blow').onclick = () => actions.blow();
  $('b-drop').onclick = () => (S.held ? dropHeld() : toast('You are not holding a match.'));
  $('b-refill').onclick = () => actions.refill();
  $('b-clean').onclick = () => actions.cleanUp();
  $('s-tilt').oninput = (e) => setTilt(THREE.MathUtils.degToRad(+e.target.value));
  $('s-wind').oninput = (e) => { S.wind = e.target.value / 100; $('v-wind').textContent = `${e.target.value}%`; };
  $('s-room').oninput = (e) => { S.room = e.target.value / 100; $('v-room').textContent = `${e.target.value}%`; applyRoomLight(); };
  $('b-slow').onclick = toggleSlow;
  $('b-sound').onclick = toggleSound;
  $('b-bloom').onclick = () => { bloom.enabled = !bloom.enabled; $('b-bloom').classList.toggle('on', bloom.enabled); };
  $('b-hide').onclick = togglePanel;
  $('toggle-panel').onclick = togglePanel;
  $('fab-cupboard').onclick = () => openCupboard();
  for (const b of document.querySelectorAll('button')) b.addEventListener('pointerdown', () => sound.init());
  window.addEventListener('keydown', (e) => {
    if (!S.started || e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (k === 'escape') { closeCupboard(); select(null); return; }
    if (k === 'i') { toggleCupboard(); return; }
    if (!$('cupboard').hidden) return;
    if (k === ' ') { e.preventDefault(); if (S.held) dropHeld(); }
    else if (k === 'b') actions.blow();
    else if (k === 'o') setDrawer(S.drawerOpen < 0.5);
    else if (k === 'n') takeNext();
    else if (k === 's') strikeMatch();
    else if (k === 'r') actions.refill();
    else if (k === 'c') actions.cleanUp();
    else if (k === 't') toggleSlow();
    else if (k === 'm') toggleSound();
    else if (k === 'h') togglePanel();
    else if (k === 'arrowup' || k === '[') setTilt(S.tilt - THREE.MathUtils.degToRad(5));
    else if (k === 'arrowdown' || k === ']') setTilt(S.tilt + THREE.MathUtils.degToRad(5));
  });
  if (window.innerWidth < 720) $('panel').classList.add('hidden');
}
