/**
 * Tea-steep minigame — timing reflex.
 *
 * A needle sweeps across a temperature arc. Tap Space/click to stop the
 * brew. Where the needle lands grades into Perfect / Good / Steady / Burnt.
 * 5 rounds, each faster than the last. Pays Embers per tier.
 *
 * Same overlay architecture as sketchbook + yarndart.
 */
import { grantEmbers } from './meta.js';
import { hideTooltip } from './tooltips.js';

const PALETTE = {
  paper:    '#f3e8cf',
  ink:      '#231a14',
  warmTan:  '#d99b54',
  teaAmber: '#c98a3a',
  sakura:   '#e8a3c7',
  sage:     '#8aaa6a',
  indigo:   '#384a78',
  ember:    '#ff7a3a',
  highlight:'#fff9e6',
};

// Arc geometry (in canvas-relative units; recomputed on resize)
const ARC_THICK = 60;
const TOTAL_ROUNDS = 5;

// Zones along the arc, expressed as [t0, t1] fractions of the full sweep.
// The needle moves t from 0 to 1, then bounces back. Position values:
const ZONES = [
  { tier: 'BURNT',   t: [0.00, 0.18], color: '#7a4032', emberReward: 0 },
  { tier: 'STEADY',  t: [0.18, 0.38], color: PALETTE.warmTan,  emberReward: 1 },
  { tier: 'GOOD',    t: [0.38, 0.46], color: PALETTE.teaAmber, emberReward: 2 },
  { tier: 'PERFECT', t: [0.46, 0.54], color: PALETTE.sage,     emberReward: 3 },
  { tier: 'GOOD',    t: [0.54, 0.62], color: PALETTE.teaAmber, emberReward: 2 },
  { tier: 'STEADY',  t: [0.62, 0.82], color: PALETTE.warmTan,  emberReward: 1 },
  { tier: 'BURNT',   t: [0.82, 1.00], color: '#7a4032', emberReward: 0 },
];

let _root = null, _canvas = null, _ctx = null, _open = false, _raf = 0;
let _state = null;
let _lastT = 0;

function _resetState() {
  return {
    round: 1,
    elapsed: 0,
    phase: 'play',
    needleT: 0,             // 0..1 along arc
    needleVel: 0.55,         // 0..1/s — starting sweep speed
    needleDir: 1,
    lastTier: null,
    totalEarned: 0,
    perfectCount: 0,
    flashTime: 0,
    flashColor: '#ffffff',
    flashTier: '',
  };
}

function _arcGeom() {
  const W = _canvas.width, H = _canvas.height;
  const cx = W / 2;
  const cy = H * 0.62;
  const r  = Math.min(W * 0.32, H * 0.42);
  return { cx, cy, r };
}

function _drawArc(ctx) {
  const { cx, cy, r } = _arcGeom();
  // The needle sweeps from t=0 (leftmost) to t=1 (rightmost) across a
  // half-circle on the TOP of (cx,cy). Map t∈[0,1] to angle∈[π, 0].
  for (const z of ZONES) {
    const a0 = Math.PI - z.t[0] * Math.PI;
    const a1 = Math.PI - z.t[1] * Math.PI;
    ctx.strokeStyle = z.color;
    ctx.lineWidth = ARC_THICK;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.min(a0, a1), Math.max(a0, a1));
    ctx.stroke();
  }
  // Outer ink border
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(cx, cy, r + ARC_THICK / 2 + 2, Math.PI, 0);
  ctx.stroke();
  // Inner ink border
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, r - ARC_THICK / 2 - 2, Math.PI, 0);
  ctx.stroke();
  // Tick marks for each zone boundary
  ctx.strokeStyle = 'rgba(35,26,20,0.55)';
  ctx.lineWidth = 2;
  for (const z of ZONES) {
    for (const tv of z.t) {
      const a = Math.PI - tv * Math.PI;
      const r0 = r - ARC_THICK / 2 - 4;
      const r1 = r + ARC_THICK / 2 + 4;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.stroke();
    }
  }
  // Zone labels (centered on each zone, outside the arc)
  ctx.font = '700 13px "Cinzel Decorative", serif';
  ctx.fillStyle = PALETTE.ink;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const z of ZONES) {
    const mid = (z.t[0] + z.t[1]) / 2;
    const a = Math.PI - mid * Math.PI;
    const rl = r + ARC_THICK / 2 + 22;
    ctx.fillText(z.tier, cx + Math.cos(a) * rl, cy + Math.sin(a) * rl);
  }
  ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
}

function _drawNeedle(ctx, t) {
  const { cx, cy, r } = _arcGeom();
  const a = Math.PI - t * Math.PI;
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  const r0 = r - ARC_THICK / 2 - 12;
  const r1 = r + ARC_THICK / 2 + 14;
  ctx.beginPath();
  ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
  ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
  ctx.stroke();
  // Pivot dot
  ctx.fillStyle = PALETTE.ink;
  ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = PALETTE.highlight;
  ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
}

function _drawKettle(ctx) {
  const { cx, cy } = _arcGeom();
  const kx = cx, ky = cy + 130;
  // Body — squat warm rectangle with curved top
  ctx.fillStyle = PALETTE.teaAmber;
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.ellipse(kx, ky, 110, 70, 0, 0, Math.PI * 2);
  ctx.fill(); ctx.stroke();
  // Spout
  ctx.beginPath();
  ctx.moveTo(kx + 90,  ky - 30);
  ctx.lineTo(kx + 130, ky - 60);
  ctx.lineTo(kx + 145, ky - 40);
  ctx.lineTo(kx + 105, ky - 12);
  ctx.closePath();
  ctx.fillStyle = PALETTE.teaAmber; ctx.fill(); ctx.stroke();
  // Lid + knob
  ctx.beginPath();
  ctx.ellipse(kx, ky - 55, 50, 14, 0, 0, Math.PI * 2);
  ctx.fillStyle = PALETTE.warmTan; ctx.fill(); ctx.stroke();
  ctx.beginPath();
  ctx.arc(kx, ky - 70, 12, 0, Math.PI * 2);
  ctx.fillStyle = PALETTE.ink; ctx.fill();
  // Steam wisps
  ctx.strokeStyle = 'rgba(35,26,20,0.35)';
  ctx.lineWidth = 3;
  const t = performance.now() / 1000;
  for (let i = 0; i < 3; i++) {
    const ox = (i - 1) * 18;
    ctx.beginPath();
    for (let k = 0; k <= 18; k++) {
      const yy = ky - 80 - k * 4;
      const xx = kx + ox + Math.sin(t * 1.8 + k * 0.3 + i) * 6;
      if (k === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
    }
    ctx.stroke();
  }
}

function _zoneAt(t) {
  for (const z of ZONES) if (t >= z.t[0] && t < z.t[1]) return z;
  return ZONES[ZONES.length - 1];
}

function _drawFrame() {
  if (!_open || !_state) return;
  const c = _canvas, ctx = _ctx;
  const W = c.width, H = c.height;
  const s = _state;
  ctx.fillStyle = PALETTE.paper;
  ctx.fillRect(0, 0, W, H);
  // Grain
  ctx.fillStyle = 'rgba(35,26,20,0.04)';
  for (let i = 0; i < 320; i++) {
    const gx = (i * 9301 + 49297) % W;
    const gy = (i * 23117 + 79867) % H;
    ctx.fillRect(gx, gy, 2, 2);
  }

  _drawKettle(ctx);
  _drawArc(ctx);
  if (s.phase === 'play') _drawNeedle(ctx, s.needleT);
  else if (s.phase === 'between' || s.phase === 'result') _drawNeedle(ctx, s.needleT);

  // Flash on tap
  if (s.flashTime > 0) {
    const a = Math.min(1, s.flashTime / 0.4);
    ctx.fillStyle = s.flashColor;
    ctx.globalAlpha = 0.25 * a;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
    ctx.font = '900 78px "Cinzel Decorative", serif';
    ctx.fillStyle = s.flashColor;
    ctx.textAlign = 'center';
    ctx.fillText(s.flashTier, W / 2, H * 0.30);
    ctx.textAlign = 'start';
  }

  // HUD top bar
  const barH = 60;
  ctx.fillStyle = 'rgba(35,26,20,0.85)';
  ctx.fillRect(0, 0, W, barH);
  ctx.fillStyle = PALETTE.paper;
  ctx.font = '700 22px "Cinzel Decorative", serif';
  ctx.textBaseline = 'middle';
  ctx.fillText('☕  Tea Ceremony', 24, barH / 2);
  ctx.font = '500 14px ui-monospace, monospace';
  ctx.fillStyle = 'rgba(243,232,207,0.78)';
  ctx.fillText(`Round ${s.round} / ${TOTAL_ROUNDS}    Embers: ${s.totalEarned} 🔥`, 240, barH / 2);
  ctx.font = '500 13px "Inter", system-ui, sans-serif';
  ctx.fillStyle = 'rgba(35,26,20,0.55)';
  ctx.fillText('Tap Space or click to lock the temperature.  Esc to leave.', 24, H - 22);
  ctx.textBaseline = 'alphabetic';

  // Result screen
  if (s.phase === 'result') {
    ctx.fillStyle = 'rgba(35,26,20,0.78)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.font = '900 56px "Cinzel Decorative", serif';
    ctx.fillStyle = PALETTE.paper;
    ctx.fillText('Tea poured', W / 2, H / 2 - 60);
    ctx.font = '500 22px ui-monospace, monospace';
    ctx.fillStyle = PALETTE.teaAmber;
    ctx.fillText(`Perfect pours: ${s.perfectCount} / ${TOTAL_ROUNDS}`, W / 2, H / 2 - 10);
    ctx.font = '900 38px "Cinzel Decorative", serif';
    ctx.fillStyle = PALETTE.ember;
    ctx.fillText(`+${s.totalEarned}  🔥  Embers`, W / 2, H / 2 + 44);
    ctx.font = '500 14px "Inter", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(243,232,207,0.72)';
    ctx.fillText('Click anywhere to close.', W / 2, H / 2 + 100);
    ctx.textAlign = 'start';
  }
}

function _tick(dt) {
  const s = _state;
  if (s.flashTime > 0) s.flashTime -= dt;
  if (s.phase === 'play') {
    s.needleT += s.needleDir * s.needleVel * dt;
    if (s.needleT > 1) { s.needleT = 1; s.needleDir = -1; }
    else if (s.needleT < 0) { s.needleT = 0; s.needleDir = 1; }
  } else if (s.phase === 'between') {
    s.elapsed += dt;
    if (s.elapsed >= 1.2) _nextRound();
  }
}

function _lockBrew() {
  const s = _state;
  if (s.phase !== 'play') return;
  const z = _zoneAt(s.needleT);
  const r = grantEmbers(z.emberReward);
  s.totalEarned += r;
  s.lastTier = z.tier;
  if (z.tier === 'PERFECT') s.perfectCount += 1;
  s.flashTime = 0.6;
  s.flashColor = z.color;
  s.flashTier = z.tier + (r > 0 ? `   +${r} 🔥` : '');
  s.phase = 'between';
  s.elapsed = 0;
}

function _nextRound() {
  const s = _state;
  s.round += 1;
  if (s.round > TOTAL_ROUNDS) {
    s.phase = 'result';
    return;
  }
  s.needleT = 0; s.needleDir = 1;
  // Each round increases sweep speed by 18%
  s.needleVel *= 1.18;
  s.phase = 'play';
}

function _onPointerDown(e) {
  if (!_open || !_state) return;
  if (_state.phase === 'result') { _close(); return; }
  if (_state.phase === 'play') _lockBrew();
}
function _onKey(e) {
  if (!_open) return;
  if (e.code === 'Escape') { _close(); return; }
  if (e.code === 'Space' || e.code === 'Enter') {
    if (_state && _state.phase === 'play') {
      e.preventDefault();
      _lockBrew();
    } else if (_state && _state.phase === 'result') {
      _close();
    }
  }
}
function _onResize() {
  if (!_canvas) return;
  _canvas.width = window.innerWidth;
  _canvas.height = window.innerHeight;
}
function _loop(t) {
  if (!_open) return;
  const dt = Math.min(0.05, (t - _lastT) / 1000);
  _lastT = t;
  _tick(dt);
  _drawFrame();
  _raf = requestAnimationFrame(_loop);
}

export function showTeaSteep() {
  // Iter 21a — defensive tooltip hide on modal entry.
  try { hideTooltip(); } catch (_) {}
  if (_open) return;
  _open = true;
  _root = document.createElement('div');
  _root.id = 'kk-teasteep';
  _root.style.cssText = 'position:fixed; inset:0; z-index:130; background:#1a120c; cursor:pointer; touch-action:none;';
  _canvas = document.createElement('canvas');
  _canvas.style.cssText = 'display:block; width:100vw; height:100vh;';
  _canvas.width = window.innerWidth;
  _canvas.height = window.innerHeight;
  _ctx = _canvas.getContext('2d');
  _root.appendChild(_canvas);
  document.body.appendChild(_root);
  _state = _resetState();
  _root.addEventListener('pointerdown', _onPointerDown);
  window.addEventListener('keydown', _onKey);
  window.addEventListener('resize', _onResize);
  _lastT = performance.now();
  _raf = requestAnimationFrame(_loop);
}

function _close() {
  if (!_open) return;
  _open = false;
  if (_raf) cancelAnimationFrame(_raf);
  _raf = 0;
  window.removeEventListener('keydown', _onKey);
  window.removeEventListener('resize', _onResize);
  if (_root && _root.parentNode) _root.parentNode.removeChild(_root);
  _root = null; _canvas = null; _ctx = null; _state = null;
}

export function hideTeaSteep() { _close(); }
export function isTeaSteepOpen() { return _open; }
