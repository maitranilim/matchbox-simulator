import * as THREE from 'three';
import { canvasTexture, grain, makeCanvas, pick, rand } from '../core/util.js';

const cache = new Map();
const memo = (key, fn) => { if (!cache.has(key)) cache.set(key, fn()); return cache.get(key); };

export const newsprint = () => memo('news', () => {
  const W = 512, H = 716;
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  g.fillStyle = '#e8e2d2';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#1e1c1a';
  g.font = 'bold 44px Georgia, serif';
  g.textAlign = 'center';
  g.fillText('THE DAILY EMBER', W / 2, 58);
  g.fillRect(24, 72, W - 48, 3);
  g.font = '12px Georgia, serif';
  g.fillText('SATURDAY  ·  FIRE SAFETY SPECIAL  ·  ₹5', W / 2, 90);
  g.fillRect(24, 98, W - 48, 1);
  g.font = 'bold 26px Georgia, serif';
  g.textAlign = 'left';
  g.fillText('Why paper catches so fast', 28, 134);
  // Photo block.
  g.fillStyle = '#8d877b';
  g.fillRect(28, 150, 220, 150);
  g.fillStyle = '#6b665c';
  for (let i = 0; i < 40; i++) g.fillRect(28 + rand(0, 200), 150 + rand(0, 130), rand(8, 30), rand(6, 20));
  // Columns of text lines.
  const cols = [[28, 316, 220], [264, 150, 220]];
  g.fillStyle = '#3a3733';
  for (const [x, y0, w] of cols) {
    for (let y = y0; y < H - 30; y += 11) {
      if (Math.random() < 0.06) { y += 12; continue; }
      const lw = Math.random() < 0.1 ? w * rand(0.3, 0.8) : w;
      for (let x2 = x; x2 < x + lw; x2 += rand(14, 36)) g.fillRect(x2, y, rand(10, 30), 5);
    }
  }
  grain(g, W, H, 14);
  return canvasTexture(c);
});

export const kraft = () => memo('kraft', () => {
  const W = 512, H = 400;
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  g.fillStyle = '#b48a58';
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(${pick(['90,60,30', '210,170,120', '120,80,40'])},${rand(0.05, 0.18)})`;
    g.fillRect(rand(0, W), rand(0, H), rand(1, 6), rand(1, 2));
  }
  for (let x = 0; x < W; x += 9) { g.fillStyle = 'rgba(80,50,20,0.06)'; g.fillRect(x, 0, 3, H); }
  g.strokeStyle = 'rgba(150,30,25,0.8)';
  g.lineWidth = 6;
  g.strokeRect(150, 120, 212, 120);
  g.fillStyle = 'rgba(150,30,25,0.85)';
  g.font = 'bold 44px Arial, sans-serif';
  g.textAlign = 'center';
  g.fillText('FRAGILE', W / 2, 196);
  g.font = 'bold 20px Arial, sans-serif';
  g.fillText('THIS SIDE UP  ↑', W / 2, 228);
  grain(g, W, H, 10);
  return canvasTexture(c);
});

export const plaid = () => memo('plaid', () => {
  const W = 256;
  const c = makeCanvas(W, W);
  const g = c.getContext('2d');
  g.fillStyle = '#8c2a2a';
  g.fillRect(0, 0, W, W);
  const band = (x, w, col, horiz) => { g.fillStyle = col; horiz ? g.fillRect(0, x, W, w) : g.fillRect(x, 0, w, W); };
  for (const h of [true, false]) {
    band(20, 40, 'rgba(30,40,80,0.55)', h);
    band(100, 12, 'rgba(240,220,180,0.35)', h);
    band(150, 50, 'rgba(20,30,60,0.5)', h);
    band(220, 6, 'rgba(250,200,80,0.4)', h);
  }
  for (let y = 0; y < W; y += 2) { g.fillStyle = `rgba(0,0,0,${y % 4 ? 0.06 : 0.12})`; g.fillRect(0, y, W, 1); }
  grain(g, W, W, 20);
  return canvasTexture(c, { repeat: [2, 2] });
});

export const pine = () => memo('pine', () => {
  const W = 128, H = 512;
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, '#d9b27a'); grad.addColorStop(0.5, '#e6c28c'); grad.addColorStop(1, '#d1a66c');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 22; i++) {
    const x = rand(0, W);
    g.strokeStyle = `rgba(150,95,45,${rand(0.15, 0.45)})`;
    g.lineWidth = rand(1, 4);
    g.beginPath();
    for (let y = 0; y <= H; y += 16) g.lineTo(x + Math.sin(y * 0.02 + i) * 4, y);
    g.stroke();
  }
  g.fillStyle = 'rgba(120,70,30,0.5)';
  g.beginPath(); g.ellipse(70, 300, 9, 14, 0, 0, Math.PI * 2); g.fill();
  grain(g, W, H, 10);
  return canvasTexture(c);
});

/** A simple printed product label. */
export function productLabel({ bg, fg = '#fff', title, sub, stripe, w = 512, h = 256, small, warning }) {
  return memo(`label-${title}-${bg}`, () => {
    const c = makeCanvas(w, h);
    const g = c.getContext('2d');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    if (stripe) { g.fillStyle = stripe; g.fillRect(0, h * 0.66, w, h * 0.12); }
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.font = `bold ${Math.round(h * 0.2)}px Arial, sans-serif`;
    g.fillText(title, w * 0.5, h * 0.38);
    if (sub) { g.font = `${Math.round(h * 0.1)}px Arial, sans-serif`; g.fillText(sub, w * 0.5, h * 0.56); }
    if (small) { g.font = `${Math.round(h * 0.065)}px Arial, sans-serif`; g.fillText(small, w * 0.5, h * 0.9); }
    if (warning) {
      g.fillStyle = '#f6c21c';
      g.beginPath(); g.moveTo(w * 0.1, h * 0.92); g.lineTo(w * 0.16, h * 0.8); g.lineTo(w * 0.22, h * 0.92); g.fill();
      g.fillStyle = '#000'; g.font = `bold ${Math.round(h * 0.09)}px Arial`; g.fillText('!', w * 0.16, h * 0.91);
    }
    grain(g, w, h, 6);
    return canvasTexture(c);
  });
}

export const steelFibers = () => memo('steel', () => {
  const W = 256;
  const c = makeCanvas(W, W);
  const g = c.getContext('2d');
  g.fillStyle = '#5d6166';
  g.fillRect(0, 0, W, W);
  for (let i = 0; i < 700; i++) {
    g.strokeStyle = `rgba(${pick(['200,205,210', '120,125,130', '60,62,66', '235,238,240'])},${rand(0.3, 0.8)})`;
    g.lineWidth = rand(0.5, 1.4);
    g.beginPath();
    let x = rand(0, W), y = rand(0, W), a = rand(0, 6.28);
    g.moveTo(x, y);
    for (let k = 0; k < 8; k++) { a += rand(-0.8, 0.8); x += Math.cos(a) * 8; y += Math.sin(a) * 8; g.lineTo(x, y); }
    g.stroke();
  }
  const t = canvasTexture(c, { repeat: [2, 1] });
  return t;
});

export const steelAlpha = () => memo('steelA', () => {
  const W = 256;
  const c = makeCanvas(W, W);
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, W);
  g.strokeStyle = '#fff';
  for (let i = 0; i < 500; i++) {
    g.lineWidth = rand(1, 2.5);
    g.beginPath();
    let x = rand(0, W), y = rand(0, W), a = rand(0, 6.28);
    g.moveTo(x, y);
    for (let k = 0; k < 10; k++) { a += rand(-0.7, 0.7); x += Math.cos(a) * 9; y += Math.sin(a) * 9; g.lineTo(x, y); }
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 1);
  return t;
});
