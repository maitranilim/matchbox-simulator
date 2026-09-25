import * as THREE from 'three';

/**
 * World scale: 1 unit = 1 cm. Masses are in grams, so forces are in
 * g·cm/s² (dynes) and gravity is 981 cm/s².
 */
export const GRAVITY = 981;
export const AMBIENT_C = 20;

// Matchbox dimensions (a standard 52 x 36 x 15 mm safety-match box).
export const BOX = {
  len: 5.2, // along X
  depth: 3.6, // along Z
  height: 1.5,
  wall: 0.05,
  drawerLen: 5,
  drawerTravel: 3.3,
};
BOX.drawerDepth = BOX.depth - 2 * BOX.wall - 0.06;
BOX.drawerHeight = BOX.height - 2 * BOX.wall - 0.08;
export const STRIP = { x0: -2.45, x1: 2.45, y0: 0.2, y1: 1.3, z: BOX.depth / 2 + 0.085 };

export const MATCH = { len: 4.2, thick: 0.11, headR: 0.1, mass: 0.09 };
export const ASHTRAY = { x: -5.3, z: -1.6, rIn: 1.9, rRim: 2.32 };
export const CANDLE_HOME = new THREE.Vector3(6.6, 0, -3.3);

/** Mutable simulation state shared across modules. */
export const S = {
  started: false,
  wind: 0.1,
  room: 0.3,
  tilt: THREE.MathUtils.degToRad(15),
  timeScale: 1,
  timeTarget: 1,
  simTime: 0,
  drawerOpen: 0,
  drawerTween: null,
  held: null,
  pressed: false,
  pointerType: 'mouse',
  ndc: new THREE.Vector2(0.15, -0.25),
  headPos: new THREE.Vector3(1, 2, 2.2),
  headTarget: new THREE.Vector3(1, 2, 2.2),
  headVel: new THREE.Vector3(),
  prevHead: new THREE.Vector3(),
  contact: false,
  contactPrev: false,
  strikeEnergy: 0,
  strikeThresh: 1.2,
  liftQuat: new THREE.Quaternion(),
  clearOfBox: true,
  autoStrike: null,
  autoStrikeQueued: false,
  assist: null,
  strokeCounted: false,
  lastUV: null,
  blowT: 0,
  camShake: 0,
  shakeTimes: [],
  lastShakeDir: 0,
  windVec: new THREE.Vector3(),
  stats: { strikes: 0, lit: 0 },
  matches: [],
  items: [],
  selected: null,
  grab: null,
  bloom: true,
  sound: true,
};
