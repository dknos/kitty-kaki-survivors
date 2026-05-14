/**
 * Sketchbook tracing minigame — anchor playable demo for the cozy half of
 * Kitty Kaki Survivors. Trace a ghosted ink line before it fades, scored
 * on accuracy + coverage. Pays Embers.
 *
 * Architecture:
 *   - DOM canvas overlay (separate from THREE.js pipeline)
 *   - Procedural path = sequence of [x,y] points in canvas space
 *   - Mouse/touch dragging samples positions every frame
 *   - Each sample finds nearest path segment → accumulates distance
 *   - On round end: accuracy × coverage → Embers awarded
 *
 * Style follows STYLE_BIBLE.md — Paper bg, Ink lines, Sakura/Tea-Amber/Sage
 * UI accents, single-pen 4px primary outline, 2px secondary detail.
 */
import { grantEmbers } from './meta.js';
import { sfx } from './audio.js';

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

// Round duration (s) — path fades from full opacity to invisible across this.
const ROUND_DURATION = 9.0;
// Distance (in canvas px) above which a player sample stops counting as on-path.
const ON_PATH_TOL = 28;

let _root = null;       // fullscreen overlay div
let _canvas = null;
let _ctx = null;
let _open = false;
let _raf = 0;
let _state = null;

// ── Path templates ──
// Each template returns an array of [x, y] normalized 0-1 coords; we'll scale
// to the canvas at run time. Five templates, picked randomly per round.
function _pathSpiral() {
  const pts = [];
  for (let i = 0; i <= 90; i++) {
    const t = i / 90;
    const a = t * Math.PI * 6;
    const r = 0.04 + t * 0.38;
    pts.push([0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r]);
  }
  return pts;
}
function _pathHeart() {
  const pts = [];
  for (let i = 0; i <= 90; i++) {
    const t = i / 90;
    const a = t * Math.PI * 2;
    // Classic heart curve parameterization
    const x = 16 * Math.pow(Math.sin(a), 3);
    const y = -(13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a));
    pts.push([0.5 + x / 40, 0.52 + y / 40]);
  }
  return pts;
}
function _pathStar() {
  const pts = [];
  const tips = 5;
  for (let i = 0; i <= tips * 2; i++) {
    const a = (i / (tips * 2)) * Math.PI * 2 - Math.PI / 2;
    const r = (i % 2 === 0) ? 0.36 : 0.14;
    pts.push([0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r]);
  }
  // Densify by interpolating between vertices
  const dense = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    for (let k = 0; k < 8; k++) {
      const t = k / 8;
      dense.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
    }
  }
  dense.push(pts[pts.length - 1]);
  return dense;
}
function _pathInfinity() {
  const pts = [];
  for (let i = 0; i <= 120; i++) {
    const t = i / 120;
    const a = t * Math.PI * 2;
    const denom = 1 + Math.sin(a) * Math.sin(a);
    pts.push([0.5 + 0.38 * Math.cos(a) / denom, 0.5 + 0.30 * Math.sin(a) * Math.cos(a) / denom]);
  }
  return pts;
}
function _pathWave() {
  const pts = [];
  for (let i = 0; i <= 80; i++) {
    const t = i / 80;
    pts.push([0.10 + t * 0.80, 0.50 + 0.18 * Math.sin(t * Math.PI * 3.5)]);
  }
  return pts;
}

const TEMPLATES = [
  { name: 'Spiral', fn: _pathSpiral, difficulty: 1 },
  { name: 'Heart',  fn: _pathHeart,  difficulty: 2 },
  { name: 'Star',   fn: _pathStar,   difficulty: 3 },
  { name: 'Infinity', fn: _pathInfinity, difficulty: 2 },
  { name: 'Wave',   fn: _pathWave,   difficulty: 1 },
];

// ── Geometry helpers ──
function _segDistSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-6) {
    const ex = px - ax, ey = py - ay;
    return ex * ex + ey * ey;
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + dx * t, cy = ay + dy * t;
  const ex = px - cx, ey = py - cy;
  return ex * ex + ey * ey;
}

function _distToPath(px, py, path) {
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const d2 = _segDistSq(px, py, path[i][0], path[i][1], path[i + 1][0], path[i + 1][1]);
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

// ── Render ──
function _drawFrame() {
  if (!_open || !_state) return;
  const c = _canvas, ctx = _ctx;
  const W = c.width, H = c.height;
  const s = _state;

  // Paper background with subtle grain
  ctx.fillStyle = PALETTE.paper;
  ctx.fillRect(0, 0, W, H);
  // Procedural grain dots (light)
  ctx.fillStyle = 'rgba(35,26,20,0.04)';
  for (let i = 0; i < 320; i++) {
    const gx = (i * 9301 + 49297) % W;
    const gy = (i * 23117 + 79867) % H;
    ctx.fillRect(gx, gy, 2, 2);
  }

  // Fade ghost path based on time remaining
  const tLeft = Math.max(0, ROUND_DURATION - s.elapsed);
  const ghostAlpha = Math.max(0, tLeft / ROUND_DURATION);
  if (ghostAlpha > 0) {
    ctx.strokeStyle = `rgba(35,26,20,${0.55 * ghostAlpha})`;
    ctx.lineWidth = 16;     // wide tolerance band
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < s.path.length; i++) {
      const [x, y] = s.path[i];
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // Inner thinner ghost guide
    ctx.strokeStyle = `rgba(56,74,120,${0.85 * ghostAlpha})`;
    ctx.lineWidth = 4;
    ctx.stroke();
  }

  // Player drawn path — sakura ink
  if (s.draw.length > 1) {
    ctx.strokeStyle = PALETTE.sakura;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < s.draw.length; i++) {
      const [x, y] = s.draw[i];
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // Brush head highlight
    const last = s.draw[s.draw.length - 1];
    ctx.fillStyle = PALETTE.highlight;
    ctx.beginPath();
    ctx.arc(last[0], last[1], 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // HUD — top bar
  const barH = 60;
  ctx.fillStyle = 'rgba(35,26,20,0.85)';
  ctx.fillRect(0, 0, W, barH);
  ctx.fillStyle = PALETTE.paper;
  ctx.font = '700 22px "Cinzel Decorative", serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(`✎  ${s.template.name}`, 24, barH / 2);
  // Round counter
  ctx.font = '500 14px ui-monospace, monospace';
  ctx.fillStyle = 'rgba(243,232,207,0.78)';
  ctx.fillText(`Round ${s.round} / ${s.totalRounds}    Embers earned: ${s.totalEarned} 🔥`, 220, barH / 2);
  // Timer (right-aligned)
  ctx.font = '700 22px ui-monospace, monospace';
  ctx.fillStyle = tLeft < 2 ? PALETTE.ember : PALETTE.teaAmber;
  ctx.textAlign = 'right';
  ctx.fillText(tLeft.toFixed(1) + 's', W - 24, barH / 2);
  ctx.textAlign = 'start';

  // Bottom hint
  ctx.font = '500 13px "Inter", system-ui, sans-serif';
  ctx.fillStyle = 'rgba(35,26,20,0.55)';
  ctx.fillText('Hold and drag to trace.  Esc to leave.', 24, H - 22);

  // Result overlay
  if (s.phase === 'result') {
    ctx.fillStyle = 'rgba(35,26,20,0.78)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.font = '900 56px "Cinzel Decorative", serif';
    ctx.fillStyle = PALETTE.paper;
    ctx.fillText('Sketchbook complete', W / 2, H / 2 - 60);
    ctx.font = '500 22px ui-monospace, monospace';
    ctx.fillStyle = PALETTE.teaAmber;
    const acc = (s.lastAccuracy * 100).toFixed(0);
    const cov = (s.lastCoverage * 100).toFixed(0);
    ctx.fillText(`Accuracy ${acc}%   ·   Coverage ${cov}%`, W / 2, H / 2 - 10);
    ctx.font = '900 38px "Cinzel Decorative", serif';
    ctx.fillStyle = PALETTE.ember;
    ctx.fillText(`+${s.totalEarned}  🔥  Embers`, W / 2, H / 2 + 44);
    ctx.font = '500 14px "Inter", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(243,232,207,0.72)';
    ctx.fillText('Click anywhere to close.', W / 2, H / 2 + 100);
    ctx.textAlign = 'start';
  }
}

// ── Round lifecycle ──
function _newRound() {
  const c = _canvas;
  // Pick a template biased toward easier ones first
  const round = _state.round;
  let candidates = TEMPLATES.filter(t => t.difficulty <= 1 + Math.floor(round / 2));
  if (candidates.length === 0) candidates = TEMPLATES;
  const tpl = candidates[Math.floor(Math.random() * candidates.length)];
  // Bounding-box scale to fit canvas with margin
  const margin = 80;
  const innerW = c.width - margin * 2;
  const innerH = c.height - 60 - margin * 2; // less top bar
  const innerOffY = 60 + margin;
  const innerOffX = margin;
  const raw = tpl.fn();
  const scaled = raw.map(([x, y]) => [innerOffX + x * innerW, innerOffY + y * innerH]);
  _state.template = tpl;
  _state.path = scaled;
  _state.draw = [];
  _state.elapsed = 0;
  _state.phase = 'play';
  _state.distSum = 0;
  _state.distSamples = 0;
  _state.coveredFlags = new Array(scaled.length).fill(false);
}

function _scoreAndAdvance() {
  const s = _state;
  // Accuracy: avg distance → 0..1 where 0 dist = 1.0, ON_PATH_TOL+ = 0.
  const avgDist = s.distSamples > 0 ? s.distSum / s.distSamples : ON_PATH_TOL;
  const accuracy = Math.max(0, 1 - avgDist / ON_PATH_TOL);
  // Coverage: fraction of path waypoints that had a sample within tolerance.
  const covered = s.coveredFlags.filter(Boolean).length;
  const coverage = covered / s.coveredFlags.length;
  s.lastAccuracy = accuracy;
  s.lastCoverage = coverage;
  const score = accuracy * coverage;
  // Embers: 0..5 per round. Round 1 floor 0, perfect = 5.
  const earned = Math.floor(score * 5 + 0.4);
  if (earned > 0) {
    grantEmbers(earned);
    s.totalEarned += earned;
  }
  s.round += 1;
  if (s.round > s.totalRounds) {
    s.phase = 'result';
  } else {
    _newRound();
  }
}

// ── Input ──
function _onPointerDown(e) {
  if (!_open || !_state) return;
  if (_state.phase === 'result') { _close(); return; }
  const p = _eventToCanvas(e);
  _state.drawing = true;
  _state.draw.push(p);
}
function _onPointerMove(e) {
  if (!_open || !_state || _state.phase !== 'play' || !_state.drawing) return;
  const p = _eventToCanvas(e);
  _state.draw.push(p);
  // Sample for scoring
  const d = _distToPath(p[0], p[1], _state.path);
  _state.distSum += Math.min(d, ON_PATH_TOL * 1.5);
  _state.distSamples += 1;
  // Mark covered waypoints
  for (let i = 0; i < _state.path.length; i++) {
    if (_state.coveredFlags[i]) continue;
    const [wx, wy] = _state.path[i];
    const dx = p[0] - wx, dy = p[1] - wy;
    if (dx * dx + dy * dy < ON_PATH_TOL * ON_PATH_TOL) _state.coveredFlags[i] = true;
  }
}
function _onPointerUp() {
  if (!_open || !_state) return;
  _state.drawing = false;
}

function _eventToCanvas(e) {
  const r = _canvas.getBoundingClientRect();
  const x = (e.clientX - r.left) * (_canvas.width / r.width);
  const y = (e.clientY - r.top)  * (_canvas.height / r.height);
  return [x, y];
}

function _onKey(e) {
  if (!_open) return;
  if (e.code === 'Escape') _close();
}

function _onResize() {
  if (!_canvas) return;
  _canvas.width = window.innerWidth;
  _canvas.height = window.innerHeight;
}

// ── Loop ──
let _lastT = 0;
function _loop(t) {
  if (!_open) return;
  const dt = Math.min(0.05, (t - _lastT) / 1000);
  _lastT = t;
  if (_state && _state.phase === 'play') {
    _state.elapsed += dt;
    if (_state.elapsed >= ROUND_DURATION) {
      _scoreAndAdvance();
    }
  }
  _drawFrame();
  _raf = requestAnimationFrame(_loop);
}

// ── Show / close ──
export function showSketchbook() {
  if (_open) return;
  try { sfx.modalOpen(); } catch (_) {}
  _open = true;
  _root = document.createElement('div');
  _root.id = 'kk-sketchbook';
  _root.style.cssText = `
    position: fixed; inset: 0; z-index: 130;
    background: #1a120c;
    cursor: crosshair; touch-action: none;
  `;
  _canvas = document.createElement('canvas');
  _canvas.style.cssText = 'display:block; width:100vw; height:100vh;';
  _canvas.width = window.innerWidth;
  _canvas.height = window.innerHeight;
  _ctx = _canvas.getContext('2d');
  _root.appendChild(_canvas);
  document.body.appendChild(_root);

  _state = {
    round: 1, totalRounds: 3,
    template: null, path: [], draw: [],
    elapsed: 0,
    distSum: 0, distSamples: 0, coveredFlags: [],
    drawing: false,
    phase: 'play',
    totalEarned: 0,
    lastAccuracy: 0, lastCoverage: 0,
  };
  _newRound();

  _root.addEventListener('pointerdown', _onPointerDown);
  window.addEventListener('pointermove', _onPointerMove);
  window.addEventListener('pointerup', _onPointerUp);
  window.addEventListener('keydown', _onKey);
  window.addEventListener('resize', _onResize);

  _lastT = performance.now();
  _raf = requestAnimationFrame(_loop);
}

function _close() {
  if (!_open) return;
  try { sfx.modalClose(); } catch (_) {}
  _open = false;
  if (_raf) cancelAnimationFrame(_raf);
  _raf = 0;
  window.removeEventListener('pointermove', _onPointerMove);
  window.removeEventListener('pointerup', _onPointerUp);
  window.removeEventListener('keydown', _onKey);
  window.removeEventListener('resize', _onResize);
  if (_root && _root.parentNode) _root.parentNode.removeChild(_root);
  _root = null; _canvas = null; _ctx = null; _state = null;
}

export function hideSketchbook() { _close(); }
export function isSketchbookOpen() { return _open; }
