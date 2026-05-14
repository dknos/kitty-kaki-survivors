/**
 * UI focus navigation for keyboard + gamepad.
 *
 * Provides a stack of "focus scopes" — one scope per open modal. The topmost
 * scope owns directional navigation, activation, and cancel. Each scope is a
 * flat list of DOM elements; if the list visually forms a grid (multiple rows),
 * 2D nav (left/right/up/down with wrap-around) is computed from on-screen rects.
 *
 * Input sources:
 *   - keyboard: ArrowKeys + Enter/Space + Escape (captured at window).
 *   - gamepad: polls window.__gamepadState each animation frame. Shape:
 *       { dpadUp, dpadDown, dpadLeft, dpadRight, a, b } booleans.
 *     Edge-triggered (only on transition from false -> true).
 *
 * Public API:
 *   pushFocusScope(elements, opts?) -> scope handle
 *   popFocusScope(handle?)          -> removes top (or specific) scope
 *   moveFocus(dir)                  -> 'up'|'down'|'left'|'right'
 *   activateFocus()                 -> Enter/A on the focused element
 *   cancelFocus()                   -> Esc/B; calls scope.onCancel if provided
 *
 * Visual:
 *   `.kk-focused` class — bright yellow 3px outline + 1.04 scale pulse.
 *   Mouse hover on a scope element re-focuses it so input methods are
 *   interchangeable mid-session.
 *
 * opts:
 *   { initialIndex?: number, layout?: 'list'|'grid'|'auto', onCancel?: fn,
 *     wrap?: boolean (default true) }
 */

let _stack = [];
let _initialized = false;
let _rafHandle = 0;
let _prevPad = {};

const FOCUS_CLASS = 'kk-focused';

function injectCSS() {
  if (document.getElementById('kk-focus-style')) return;
  const s = document.createElement('style');
  s.id = 'kk-focus-style';
  s.textContent = `
    @keyframes kk-focus-pulse {
      0%   { transform: scale(1.00); }
      50%  { transform: scale(1.04); }
      100% { transform: scale(1.00); }
    }
    .${FOCUS_CLASS} {
      outline: 3px solid #ffd27f !important;
      outline-offset: 2px;
      box-shadow: 0 0 14px rgba(255,210,127,0.55), 0 0 28px rgba(255,210,127,0.35) !important;
      animation: kk-focus-pulse 1.1s ease-in-out infinite;
      z-index: 2;
      position: relative;
    }
  `;
  document.head.appendChild(s);
}

function topScope() {
  return _stack.length ? _stack[_stack.length - 1] : null;
}

function clearFocusClass(el) {
  if (el && el.classList) el.classList.remove(FOCUS_CLASS);
}

function applyFocusClass(el) {
  if (!el || !el.classList) return;
  el.classList.add(FOCUS_CLASS);
  // Try to scroll into view for long shop grids.
  if (typeof el.scrollIntoView === 'function') {
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }); } catch (_) {}
  }
}

function setFocusIndex(scope, idx) {
  if (!scope) return;
  const els = scope.elements.filter(Boolean);
  if (els.length === 0) return;
  idx = ((idx % els.length) + els.length) % els.length;
  if (scope.focused != null && scope.elements[scope.focused]) {
    clearFocusClass(scope.elements[scope.focused]);
  }
  scope.focused = idx;
  applyFocusClass(scope.elements[idx]);
}

function rectOf(el) {
  if (!el || !el.getBoundingClientRect) return { x: 0, y: 0, w: 0, h: 0, cx: 0, cy: 0 };
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
}

// Pick best neighbor in a direction. Used for grid layouts.
function pickNeighbor(scope, dir) {
  const els = scope.elements;
  if (scope.focused == null) return 0;
  const from = rectOf(els[scope.focused]);
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < els.length; i++) {
    if (i === scope.focused) continue;
    const r = rectOf(els[i]);
    const dx = r.cx - from.cx;
    const dy = r.cy - from.cy;
    let primary, secondary;
    if (dir === 'right') { primary = dx; secondary = Math.abs(dy); if (primary <= 4) continue; }
    else if (dir === 'left') { primary = -dx; secondary = Math.abs(dy); if (primary <= 4) continue; }
    else if (dir === 'down') { primary = dy; secondary = Math.abs(dx); if (primary <= 4) continue; }
    else if (dir === 'up') { primary = -dy; secondary = Math.abs(dx); if (primary <= 4) continue; }
    else continue;
    // Weighted: prefer aligned (low secondary), then closest primary.
    const score = primary + secondary * 2;
    if (score < bestScore) { bestScore = score; best = i; }
  }
  if (best === -1) {
    // Wrap-around: find the farthest element in the opposite direction (i.e.,
    // the "other side" of the grid along the requested axis).
    let wrapBest = -1;
    let wrapScore = Infinity;
    for (let i = 0; i < els.length; i++) {
      if (i === scope.focused) continue;
      const r = rectOf(els[i]);
      const dx = r.cx - from.cx;
      const dy = r.cy - from.cy;
      let key, sec;
      if (dir === 'right') { key = -dx; sec = Math.abs(dy); }       // farthest to the left
      else if (dir === 'left') { key = dx; sec = Math.abs(dy); }     // farthest to the right
      else if (dir === 'down') { key = -dy; sec = Math.abs(dx); }    // farthest up
      else if (dir === 'up') { key = dy; sec = Math.abs(dx); }       // farthest down
      else continue;
      if (key <= 0) continue;
      const score = -key + sec * 2;
      if (score < wrapScore) { wrapScore = score; wrapBest = i; }
    }
    if (wrapBest !== -1) best = wrapBest;
  }
  return best === -1 ? scope.focused : best;
}

export function moveFocus(dir) {
  const scope = topScope();
  if (!scope) return;
  const els = scope.elements;
  if (!els.length) return;

  if (scope.layout === 'list') {
    const n = els.length;
    let idx = scope.focused == null ? 0 : scope.focused;
    if (dir === 'up' || dir === 'left') idx = idx - 1;
    else if (dir === 'down' || dir === 'right') idx = idx + 1;
    if (scope.wrap !== false) idx = (idx + n) % n;
    else idx = Math.max(0, Math.min(n - 1, idx));
    setFocusIndex(scope, idx);
    return;
  }

  // grid / auto: geometric pick
  const next = pickNeighbor(scope, dir);
  setFocusIndex(scope, next);
}

export function activateFocus() {
  const scope = topScope();
  if (!scope) return;
  const el = scope.elements[scope.focused];
  if (!el) return;
  // Synthesize a click — works for <button>, divs with onclick, etc.
  try { el.click(); } catch (_) {}
}

export function cancelFocus() {
  const scope = topScope();
  if (!scope) return;
  if (typeof scope.onCancel === 'function') {
    try { scope.onCancel(); } catch (_) {}
  }
}

export function pushFocusScope(elements, opts = {}) {
  ensureInit();
  const filtered = (elements || []).filter(Boolean);
  const scope = {
    elements: filtered,
    focused: null,
    layout: opts.layout || 'auto',
    onCancel: opts.onCancel || null,
    wrap: opts.wrap !== false,
    _mouseHandlers: [],
  };
  // Mouse hover -> refocus, so mouse+pad can mix freely.
  filtered.forEach((el, i) => {
    const h = () => {
      if (topScope() !== scope) return;
      if (scope.focused !== i) setFocusIndex(scope, i);
    };
    el.addEventListener('mouseenter', h);
    scope._mouseHandlers.push([el, h]);
  });
  _stack.push(scope);
  const initial = Math.max(0, Math.min(filtered.length - 1, opts.initialIndex || 0));
  if (filtered.length) setFocusIndex(scope, initial);
  return scope;
}

export function popFocusScope(handle) {
  if (!_stack.length) return;
  let scope;
  if (handle) {
    const idx = _stack.indexOf(handle);
    if (idx === -1) return;
    scope = _stack.splice(idx, 1)[0];
  } else {
    scope = _stack.pop();
  }
  if (scope) {
    if (scope.focused != null && scope.elements[scope.focused]) {
      clearFocusClass(scope.elements[scope.focused]);
    }
    for (const [el, h] of scope._mouseHandlers) {
      try { el.removeEventListener('mouseenter', h); } catch (_) {}
    }
    scope._mouseHandlers.length = 0;
  }
}

// ── Input wiring ─────────────────────────────────────────────────────────────
function onKeyDown(e) {
  const scope = topScope();
  if (!scope) return;
  let handled = true;
  switch (e.key) {
    case 'ArrowUp':    moveFocus('up'); break;
    case 'ArrowDown':  moveFocus('down'); break;
    case 'ArrowLeft':  moveFocus('left'); break;
    case 'ArrowRight': moveFocus('right'); break;
    case 'Enter':
    case ' ':          activateFocus(); break;
    case 'Escape':     cancelFocus(); break;
    default: handled = false;
  }
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
}

function pollGamepad() {
  _rafHandle = requestAnimationFrame(pollGamepad);
  const gp = window.__gamepadState;
  if (!gp || !topScope()) { _prevPad = gp ? { ...gp } : {}; return; }
  const edge = (k) => !!gp[k] && !_prevPad[k];
  if (edge('dpadUp'))    moveFocus('up');
  if (edge('dpadDown'))  moveFocus('down');
  if (edge('dpadLeft'))  moveFocus('left');
  if (edge('dpadRight')) moveFocus('right');
  if (edge('a'))         activateFocus();
  if (edge('b'))         cancelFocus();
  _prevPad = { ...gp };
}

function ensureInit() {
  if (_initialized) return;
  _initialized = true;
  injectCSS();
  window.addEventListener('keydown', onKeyDown, true);
  _rafHandle = requestAnimationFrame(pollGamepad);
}

// Auto-init on import so the keydown handler is live even before the first
// modal opens (cheap; no work performed until a scope is pushed).
ensureInit();
