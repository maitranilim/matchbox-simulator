import * as THREE from 'three';
import { S } from '../core/state.js';
import { rand, toast } from '../core/util.js';
import { Item } from './item.js';
import { catalogById } from './catalog.js';
import { Candle } from '../world/candle.js';
import { raycast } from '../physics/physics.js';
import { clearEffects } from './effects.js';
import { frameInView } from '../core/stage.js';

export const MAX_ITEMS = 24;

/** Pick a free spot on the table behind the matchbox and drop the item there. */
function dropSpot() {
  for (let tries = 0; tries < 24; tries++) {
    // Behind and beside the matchbox, clear of the box, candle and ashtray.
    const a = rand(-Math.PI * 0.95, -Math.PI * 0.05);
    const r = rand(13, 22);
    const p = new THREE.Vector3(Math.cos(a) * r * 1.2 + 1, 0, Math.sin(a) * r * 0.8 - 3);
    const clear = S.items.every((it) => it.group.position.distanceTo(p) > 8);
    if (clear || tries === 23) return p;
  }
  return new THREE.Vector3(0, 0, -10);
}

export function spawnItem(id, at) {
  const def = catalogById[id];
  if (!def) return null;
  if (S.items.length >= MAX_ITEMS) {
    const old = S.items.find((it) => !it.burning) ?? S.items[0];
    old.remove();
    toast(`The table is full, so the ${old.name.toLowerCase()} went back in the cupboard.`);
  }
  let spot = at ? at.clone() : dropSpot();
  // A pan goes straight onto a free stove, since that is where you want it.
  if (!at && id === 'oil') {
    const stove = S.items.find((it) => it.id === 'stove' && !S.items.some((o) => o.id === 'oil' && o.group.position.distanceTo(it.group.position) < 8));
    if (stove && stove.group.position.y > -1) spot = stove.group.position.clone();
  }
  // Fall from a few cm above whatever is below the spot.
  const hit = raycast({ x: spot.x, y: 60, z: spot.z }, { x: 0, y: -1, z: 0 }, 100);
  const y = (hit ? hit.point.y : 0) + (def.lay ? 4 : 1.5);
  let item;
  if (def.custom && id === 'candle') {
    item = new Candle(new THREE.Vector3(spot.x, y, spot.z), { name: 'Candle' });
    item.def = def;
    item.id = 'candle';
    item.initPhysics();
  } else {
    item = new Item(def);
    // Flat things tumble in; tall things are set down upright.
    const tilt = def.lay ? 0.25 : 0;
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(rand(-tilt, tilt), rand(0, Math.PI * 2), rand(-tilt, tilt)));
    item.spawn(new THREE.Vector3(spot.x, y, spot.z), { quat, angvel: { x: rand(-tilt, tilt), y: rand(-0.5, 0.5), z: rand(-tilt, tilt) } });
  }
  S.items.push(item);
  if (!at) frameInView(new THREE.Vector3(spot.x, 4, spot.z));
  return item;
}

export function clearItems() {
  for (const it of [...S.items]) if (!it.permanent) it.remove();
  clearEffects();
}
