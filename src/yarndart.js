/**
 * Yarn-dart minigame — toss yarn balls at moving baskets.
 *
 * Click + drag from the yarn pile to set aim + power; release to launch.
 * Yarn balls fly with gravity, baskets bob vertically on the right side.
 * 30-second round, Embers awarded based on hits.
 *
 * Same architecture as sketchbook: DOM canvas overlay, separate from THREE.
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

const ROUND_DURATION = 30.0;
const GRAVITY = 1400;       // px/s²
const POWER_SCALE = 2.6;    // drag-to-velocity multiplier
const POWER_MAX = 1600;
const YARN_RADIUS = 18;
const BASKET_W = 86, BASKET_H = 56;
const YARN_COLORS = ['#e8a3c7', '#8aaa6a', '#c98a3a', '#384a78', '#ff7a3a'];

let _root = null, _canvas = null, _ctx = null, _open = false, _raf = 0;
let _state = null;
let _lastT = 0;

function _spawnYarnPile() {
  // Bottom-left, slightly elevated above ground
  return { x: 130, y: window.innerHeight - 130 };
}

function _newBaskets() {
  const baskets = [];
  const W = _canvas.width;
  const baseX = W - 150;
  for (let i = 0; i < 3; i++) {
    baskets.push({
      x: baseX,
      yCenter: 180 + i * 170,
      amp: 70 + Math.random() * 40,
      speed: 1.0 + Math.random() * 0.8,
      phase: Math.random() * Math.PI * 2,
    });
  }
  return baskets;
}

function _drawYarnBall(ctx, x, y, color, r = YARN_RADIUS) {
  // Body
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  // Wound-yarn line pattern (3 diagonal arcs)
  ctx.strokeStyle = 'rgba(35,26,20,0.55)';
  ctx.lineWidth = 1.4;
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.ellipse(x, y, r * 0.95, r * 0.4, i * Math.PI / 3, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Highlight
  ctx.fillStyle = PALETTE.highlight;
  ctx.beginPath();
  ctx.arc(x - r * 0.32, y - r * 0.32, r * 0.22, 0, Math.PI * 2);
  ctx.fill();
}

function _drawBasket(ctx, b) {
  const x = b.x, y = b.yCenter + Math.sin(b.phase) * b.amp;
  // Body (trapezoid)
  ctx.fillStyle = PALETTE.warmTan;
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(x - BASKET_W / 2,        y - BASKET_H / 2);
  ctx.lineTo(x + BASKET_W / 2,        y - BASKET_H / 2);
  ctx.lineTo(x + BASKET_W / 2 + 12,   y + BASKET_H / 2);
  ctx.lineTo(x - BASKET_W / 2 - 12,   y + BASKET_H / 2);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  // Weave lines
  ctx.strokeStyle = 'rgba(35,26,20,0.45)';
  ctx.lineWidth = 2;
  for (let i = 1; i < 4; i++) {
    const yi = y - BASKET_H / 2 + i * (BASKET_H / 4);
    const dx = i * 3;
    ctx.beginPath();
    ctx.moveTo(x - BASKET_W / 2 - dx, yi);
    ctx.lineTo(x + BASKET_W / 2 + dx, yi);
    ctx.stroke();
  }
  // Rim (top ellipse)
  ctx.fillStyle = PALETTE.teaAmber;
  ctx.beginPath();
  ctx.ellipse(x, y - BASKET_H / 2, BASKET_W / 2 + 4, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 3;
  ctx.stroke();
  // Hit pulse
  if (b.hitFlash && b.hitFlash > 0) {
    ctx.strokeStyle = `rgba(255,250,225,${b.hitFlash})`;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.ellipse(x, y, BASKET_W / 2 + 20 * (1 - b.hitFlash), 30 * (1 - b.hitFlash) + 14, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function _drawFrame() {
  if (!_open || !_state) return;
  const c = _canvas, ctx = _ctx;
  const W = c.width, H = c.height;
  const s = _state;

  // Paper background
  ctx.fillStyle = PALETTE.paper;
  ctx.fillRect(0, 0, W, H);
  // Grain dots
  ctx.fillStyle = 'rgba(35,26,20,0.04)';
  for (let i = 0; i < 320; i++) {
    const gx = (i * 9301 + 49297) % W;
    const gy = (i * 23117 + 79867) % H;
    ctx.fillRect(gx, gy, 2, 2);
  }

  // Floor stripe
  ctx.fillStyle = PALETTE.warmTan;
  ctx.fillRect(0, H - 70, W, 70);
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, H - 70); ctx.lineTo(W, H - 70);
  ctx.stroke();

  // Yarn pile (stack of 3 yarn balls at spawn point)
  const pile = s.pile;
  for (let i = 0; i < 3; i++) {
    _drawYarnBall(ctx, pile.x - 4 + i * 6, pile.y + 12 - i * 14, YARN_COLORS[(s.shotsFired + i) % YARN_COLORS.length], 20);
  }

  // Baskets
  for (const b of s.baskets) _drawBasket(ctx, b);

  // Active yarn balls in flight
  for (const y of s.balls) {
    _drawYarnBall(ctx, y.x, y.y, y.color);
  }

  // Aim line if dragging
  if (s.drag) {
    const dx = s.drag.cx - pile.x;
    const dy = s.drag.cy - pile.y;
    const launchX = pile.x;
    const launchY = pile.y;
    // Aim vector (reverse: drag away from target = pull-back direction)
    const power = Math.min(POWER_MAX, Math.hypot(dx, dy) * POWER_SCALE);
    const ang = Math.atan2(-dy, -dx);
    const aimLen = Math.min(220, power / 5);
    ctx.strokeStyle = PALETTE.indigo;
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(launchX, launchY);
    ctx.lineTo(launchX + Math.cos(ang) * aimLen, launchY + Math.sin(ang) * aimLen);
    ctx.stroke();
    ctx.setLineDash([]);
    // Predict trajectory (8 dots)
    const vx0 = Math.cos(ang) * power;
    const vy0 = Math.sin(ang) * power;
    ctx.fillStyle = 'rgba(56,74,120,0.55)';
    for (let i = 1; i <= 14; i++) {
      const t = i * 0.05;
      const px = launchX + vx0 * t;
      const py = launchY + vy0 * t + 0.5 * GRAVITY * t * t;
      if (py > H - 70 || px > W) break;
      ctx.beginPath();
      ctx.arc(px, py, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // HUD top bar
  const barH = 60;
  ctx.fillStyle = 'rgba(35,26,20,0.85)';
  ctx.fillRect(0, 0, W, barH);
  ctx.fillStyle = PALETTE.paper;
  ctx.font = '700 22px "Cinzel Decorative", serif';
  ctx.textBaseline = 'middle';
  ctx.fillText('🧶  Yarn Toss', 24, barH / 2);
  ctx.font = '500 14px ui-monospace, monospace';
  ctx.fillStyle = 'rgba(243,232,207,0.78)';
  ctx.fillText(`Hits: ${s.hits}    Streak: ${s.streak}    Embers: ${s.totalEarned} 🔥`, 220, barH / 2);
  const tLeft = Math.max(0, ROUND_DURATION - s.elapsed);
  ctx.font = '700 22px ui-monospace, monospace';
  ctx.fillStyle = tLeft < 5 ? PALETTE.ember : PALETTE.teaAmber;
  ctx.textAlign = 'right';
  ctx.fillText(tLeft.toFixed(1) + 's', W - 24, barH / 2);
  ctx.textAlign = 'start';

  // Bottom hint
  ctx.font = '500 13px "Inter", system-ui, sans-serif';
  ctx.fillStyle = 'rgba(35,26,20,0.55)';
  ctx.fillText('Click + drag on the yarn pile to aim, release to throw.  Esc to leave.', 24, H - 22);

  // Result overlay
  if (s.phase === 'result') {
    ctx.fillStyle = 'rgba(35,26,20,0.78)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.font = '900 56px "Cinzel Decorative", serif';
    ctx.fillStyle = PALETTE.paper;
    ctx.fillText('Yarn toss complete', W / 2, H / 2 - 60);
    ctx.font = '500 22px ui-monospace, monospace';
    ctx.fillStyle = PALETTE.teaAmber;
    ctx.fillText(`${s.hits} hits   ·   Best streak ${s.bestStreak}`, W / 2, H / 2 - 10);
    ctx.font = '900 38px "Cinzel Decorative", serif';
    ctx.fillStyle = PALETTE.ember;
    ctx.fillText(`+${s.totalEarned}  🔥  Embers`, W / 2, H / 2 + 44);
    ctx.font = '500 14px "Inter", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(243,232,207,0.72)';
    ctx.fillText('Click anywhere to close.', W / 2, H / 2 + 100);
    ctx.textAlign = 'start';
  }
}

function _resetRound() {
  _state.pile = _spawnYarnPile();
  _state.baskets = _newBaskets();
  _state.balls = [];
  _state.hits = 0;
  _state.streak = 0;
  _state.bestStreak = 0;
  _state.shotsFired = 0;
  _state.elapsed = 0;
  _state.totalEarned = 0;
  _state.phase = 'play';
}

function _tick(dt) {
  const s = _state;
  if (s.phase !== 'play') return;
  s.elapsed += dt;
  if (s.elapsed >= ROUND_DURATION) {
    s.phase = 'result';
    return;
  }
  // Move baskets
  for (const b of s.baskets) {
    b.phase += b.speed * dt;
    if (b.hitFlash) b.hitFlash -= dt * 3;
    if (b.hitFlash < 0) b.hitFlash = 0;
  }
  // Move yarn balls
  const W = _canvas.width, H = _canvas.height;
  for (let i = s.balls.length - 1; i >= 0; i--) {
    const y = s.balls[i];
    y.vy += GRAVITY * dt;
    y.x += y.vx * dt;
    y.y += y.vy * dt;
    // Out of bounds
    if (y.x > W + 80 || y.x < -80 || y.y > H + 80) {
      s.balls.splice(i, 1);
      s.streak = 0;
      continue;
    }
    // Hit baskets
    let hit = false;
    for (const b of s.baskets) {
      const bx = b.x;
      const by = b.yCenter + Math.sin(b.phase) * b.amp;
      // Hit if yarn enters the basket mouth (top ellipse) while moving down
      if (y.vy > 0 &&
          Math.abs(y.x - bx) < BASKET_W / 2 + 4 &&
          Math.abs(y.y - (by - BASKET_H / 2)) < 14) {
        hit = true;
        b.hitFlash = 1.0;
        s.hits += 1;
        s.streak += 1;
        if (s.streak > s.bestStreak) s.bestStreak = s.streak;
        // Embers reward: 1 for hit, +1 extra at streak ≥ 3, +1 more at ≥ 6.
        let reward = 1;
        if (s.streak >= 3) reward += 1;
        if (s.streak >= 6) reward += 1;
        s.totalEarned += grantEmbers(reward);
        s.balls.splice(i, 1);
        break;
      }
    }
    if (hit) continue;
    // Hit floor
    if (y.y > H - 70 - YARN_RADIUS) {
      s.balls.splice(i, 1);
      s.streak = 0;
    }
  }
}

function _onPointerDown(e) {
  if (!_open || !_state) return;
  if (_state.phase === 'result') { _close(); return; }
  const p = _eventToCanvas(e);
  // Only allow drag starting near the yarn pile
  const dx = p[0] - _state.pile.x;
  const dy = p[1] - _state.pile.y;
  if (dx * dx + dy * dy > 80 * 80) return;
  _state.drag = { sx: p[0], sy: p[1], cx: p[0], cy: p[1] };
}
function _onPointerMove(e) {
  if (!_open || !_state || !_state.drag) return;
  const p = _eventToCanvas(e);
  _state.drag.cx = p[0];
  _state.drag.cy = p[1];
}
function _onPointerUp() {
  if (!_open || !_state || !_state.drag) return;
  const d = _state.drag;
  _state.drag = null;
  const dx = d.cx - _state.pile.x;
  const dy = d.cy - _state.pile.y;
  if (dx * dx + dy * dy < 18 * 18) return; // too small a drag
  const power = Math.min(POWER_MAX, Math.hypot(dx, dy) * POWER_SCALE);
  const ang = Math.atan2(-dy, -dx);
  const vx = Math.cos(ang) * power;
  const vy = Math.sin(ang) * power;
  _state.balls.push({
    x: _state.pile.x,
    y: _state.pile.y,
    vx, vy,
    color: YARN_COLORS[_state.shotsFired % YARN_COLORS.length],
  });
  _state.shotsFired += 1;
}

function _eventToCanvas(e) {
  const r = _canvas.getBoundingClientRect();
  const x = (e.clientX - r.left) * (_canvas.width / r.width);
  const y = (e.clientY - r.top)  * (_canvas.height / r.height);
  return [x, y];
}

function _onKey(e) { if (_open && e.code === 'Escape') _close(); }
function _onResize() {
  if (!_canvas) return;
  _canvas.width = window.innerWidth;
  _canvas.height = window.innerHeight;
  if (_state) {
    _state.pile = _spawnYarnPile();
    _state.baskets = _newBaskets();
  }
}

function _loop(t) {
  if (!_open) return;
  const dt = Math.min(0.05, (t - _lastT) / 1000);
  _lastT = t;
  _tick(dt);
  _drawFrame();
  _raf = requestAnimationFrame(_loop);
}

export function showYarnDart() {
  // Iter 21a — defensive tooltip hide on modal entry.
  try { hideTooltip(); } catch (_) {}
  if (_open) return;
  _open = true;
  _root = document.createElement('div');
  _root.id = 'kk-yarndart';
  _root.style.cssText = 'position:fixed; inset:0; z-index:130; background:#1a120c; cursor:crosshair; touch-action:none;';
  _canvas = document.createElement('canvas');
  _canvas.style.cssText = 'display:block; width:100vw; height:100vh;';
  _canvas.width = window.innerWidth;
  _canvas.height = window.innerHeight;
  _ctx = _canvas.getContext('2d');
  _root.appendChild(_canvas);
  document.body.appendChild(_root);

  _state = {};
  _resetRound();

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

export function hideYarnDart() { _close(); }
export function isYarnDartOpen() { return _open; }
