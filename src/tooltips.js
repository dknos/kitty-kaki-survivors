/**
 * Rich hover/focus tooltips.
 *
 * Vampire Survivors-style games drown new players in opaque picks. This module
 * surfaces a card-shaped tooltip for any UI element registered with
 * `bindTooltip(el, contentFn)` — pinned to the cursor for mouse, anchored to
 * the focused element's bounding rect for keyboard / gamepad navigation.
 *
 * contentFn returns:
 *   { title, body, tags?, stats?, icon?, accent? }
 *     - title   string
 *     - body    string (newlines render as paragraph breaks)
 *     - tags    string[] colored chips
 *     - stats   [{label, value, prev?}]  if prev provided, render "prev → cur"
 *     - icon    string (emoji/glyph) shown left of the title
 *     - accent  border + chip color override
 *
 * UX contract:
 *   - 200ms hover delay before show, 100ms fade-in.
 *   - Hide on mouseleave, scroll, focus change away from current element.
 *   - Re-anchor on `kk-focus-change` CustomEvent dispatched by uiFocus.js.
 *   - Stays inside viewport — flips left/up if it would overflow.
 */

const HOVER_DELAY_MS = 200;
const FADE_IN_MS = 100;

// Single shared root element so we don't churn DOM nodes per hover.
let _root = null;
let _showTimer = 0;
let _activeEl = null;
let _activeFn = null;
let _lastEvent = null;

function ensureRoot() {
  if (_root) return _root;
  injectCSS();
  _root = document.createElement('div');
  _root.className = 'kk-tooltip';
  _root.style.opacity = '0';
  _root.style.pointerEvents = 'none';
  _root.setAttribute('role', 'tooltip');
  document.body.appendChild(_root);
  return _root;
}

function injectCSS() {
  if (document.getElementById('kk-tooltip-style')) return;
  const s = document.createElement('style');
  s.id = 'kk-tooltip-style';
  s.textContent = `
    .kk-tooltip {
      position: fixed; z-index: 9999;
      min-width: 240px; max-width: 340px;
      width: max-content;
      background: #0d0d12;
      border: 1px solid #7fffe4;
      border-radius: 10px;
      box-shadow: 0 0 14px rgba(127,255,228,0.28), 0 16px 32px rgba(0,0,0,0.65);
      padding: 12px 14px 13px;
      color: #d8d4c4;
      font-family: "Inter", "Segoe UI", system-ui, sans-serif;
      font-size: 13px;
      line-height: 1.42;
      transform: translateZ(0);
      transition: opacity ${FADE_IN_MS}ms ease-out;
      pointer-events: none;
    }
    .kk-tooltip-head {
      display: flex; align-items: center; gap: 8px;
      margin-bottom: 6px;
    }
    .kk-tooltip-icon { font-size: 20px; line-height: 1; filter: drop-shadow(0 2px 3px rgba(0,0,0,0.6)); }
    .kk-tooltip-title {
      flex: 1; min-width: 0;
      font-size: 16px; font-weight: 700;
      color: #ffffff; letter-spacing: 0.04em;
    }
    .kk-tooltip-body {
      font-size: 13px; color: #b9b5a5;
      white-space: pre-line;
    }
    .kk-tooltip-tags {
      display: flex; flex-wrap: wrap; gap: 5px;
      margin-top: 8px;
    }
    .kk-tooltip-chip {
      display: inline-block; padding: 2px 7px;
      font-size: 10.5px; font-weight: 600;
      letter-spacing: 0.10em; text-transform: uppercase;
      border-radius: 999px;
      border: 1px solid currentColor;
      color: #7fffe4;
      background: rgba(127,255,228,0.08);
      line-height: 1.4;
    }
    .kk-tooltip-stats {
      display: grid;
      grid-template-columns: auto 1fr;
      column-gap: 12px; row-gap: 3px;
      margin-top: 9px;
      padding-top: 8px;
      border-top: 1px dashed rgba(127,255,228,0.22);
      font-family: "JetBrains Mono", "Fira Code", Consolas, monospace;
      font-size: 12px;
    }
    .kk-tooltip-stat-label { color: #8b8676; letter-spacing: 0.06em; }
    .kk-tooltip-stat-val   { color: #f5efe1; text-align: right; }
    .kk-tooltip-stat-prev  { color: #8b8676; }
    .kk-tooltip-stat-arrow { color: #7fffe4; margin: 0 4px; }
    .kk-tooltip-stat-new   { color: #ffd27f; }
  `;
  document.head.appendChild(s);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[ch]));
}

// Map a tag string to a tint so chips read as types at a glance.
const TAG_COLORS = {
  AoE:        '#ffd27f',
  Frost:      '#a8e8ff',
  Stun:       '#c8a8ff',
  CC:         '#a8e8ff',
  Slow:       '#a8e8ff',
  Lightning:  '#ffe14a',
  Chain:      '#ffe14a',
  Damage:     '#ff8a7a',
  Defense:    '#7ee08a',
  Mobility:   '#7fffe4',
  Cooldown:   '#7fffe4',
  Duration:   '#7fffe4',
  Projectile: '#ffd27f',
  Pierce:     '#ffd27f',
  Pickup:     '#7ee08a',
  XP:         '#7ee08a',
  Lifesteal:  '#ff7ad8',
  Risk:       '#ff7ad8',
  HP:         '#ff7ad8',
  Regen:      '#7ee08a',
  Trap:       '#c8a8ff',
  Zone:       '#c8a8ff',
  Mine:       '#c8a8ff',
  Orbit:      '#ffd27f',
  Knockback:  '#ffd27f',
  Economy:    '#ffd27f',
  Meta:       '#c87bff',
  Heal:       '#7ee08a',
  Utility:    '#9aa3b2',
  Passive:    '#7fffe4',
  Evolution:  '#ffd27f',
  Starter:    '#7fffe4',
  Balanced:   '#f5efe1',
  Control:    '#c8a8ff',
  Range:      '#ffd27f',
  'Single-Target': '#ffd27f',
  Constant:   '#7ee08a',
  Fragile:    '#ff7a7a',
  Slow_:      '#9aa3b2',
};

function chip(tag) {
  const color = TAG_COLORS[tag] || '#7fffe4';
  return `<span class="kk-tooltip-chip" style="color:${color};background:${color}1a;">${escapeHtml(tag)}</span>`;
}

function renderContent(content) {
  if (!content) return '';
  const accent = content.accent || '#7fffe4';
  const root = ensureRoot();
  root.style.borderColor = accent;
  root.style.boxShadow = `0 0 14px ${accent}47, 0 16px 32px rgba(0,0,0,0.65)`;
  const parts = [];
  parts.push('<div class="kk-tooltip-head">');
  if (content.icon) parts.push(`<span class="kk-tooltip-icon">${escapeHtml(content.icon)}</span>`);
  parts.push(`<div class="kk-tooltip-title" style="color:#fff;">${escapeHtml(content.title || '')}</div>`);
  parts.push('</div>');
  if (content.body) parts.push(`<div class="kk-tooltip-body">${escapeHtml(content.body)}</div>`);
  if (Array.isArray(content.tags) && content.tags.length) {
    parts.push('<div class="kk-tooltip-tags">');
    for (const t of content.tags) parts.push(chip(t));
    parts.push('</div>');
  }
  if (Array.isArray(content.stats) && content.stats.length) {
    parts.push('<div class="kk-tooltip-stats">');
    for (const row of content.stats) {
      parts.push(`<div class="kk-tooltip-stat-label">${escapeHtml(row.label)}</div>`);
      if (row.prev !== undefined && row.prev !== null && row.prev !== row.value) {
        parts.push(`<div class="kk-tooltip-stat-val"><span class="kk-tooltip-stat-prev">${escapeHtml(row.prev)}</span><span class="kk-tooltip-stat-arrow">→</span><span class="kk-tooltip-stat-new">${escapeHtml(row.value)}</span></div>`);
      } else {
        parts.push(`<div class="kk-tooltip-stat-val">${escapeHtml(row.value)}</div>`);
      }
    }
    parts.push('</div>');
  }
  return parts.join('');
}

function positionAtCursor(ev) {
  if (!_root) return;
  const pad = 14;
  const rect = _root.getBoundingClientRect();
  let x = ev.clientX + 16;
  let y = ev.clientY + 18;
  if (x + rect.width > window.innerWidth - pad)  x = ev.clientX - rect.width - 16;
  if (y + rect.height > window.innerHeight - pad) y = ev.clientY - rect.height - 16;
  if (x < pad) x = pad;
  if (y < pad) y = pad;
  _root.style.left = x + 'px';
  _root.style.top  = y + 'px';
}

function positionAtElement(el) {
  if (!_root || !el || !el.getBoundingClientRect) return;
  const pad = 14;
  const er = el.getBoundingClientRect();
  const tr = _root.getBoundingClientRect();
  // Prefer right of element; flip to left if it overflows; then prefer below.
  let x = er.right + 12;
  if (x + tr.width > window.innerWidth - pad) x = er.left - tr.width - 12;
  if (x < pad) x = Math.max(pad, er.left);
  let y = er.top;
  if (y + tr.height > window.innerHeight - pad) y = window.innerHeight - tr.height - pad;
  if (y < pad) y = pad;
  _root.style.left = x + 'px';
  _root.style.top  = y + 'px';
}

function showFor(el, fn, ev) {
  const content = (() => {
    try { return fn(); } catch (_) { return null; }
  })();
  if (!content) { hide(); return; }
  const root = ensureRoot();
  root.innerHTML = renderContent(content);
  _activeEl = el;
  _activeFn = fn;
  _lastEvent = ev || null;
  if (ev && (ev.clientX || ev.clientY)) positionAtCursor(ev);
  else positionAtElement(el);
  root.style.display = 'block';
  root.style.opacity = '1';
}

function hide() {
  _activeEl = null;
  _activeFn = null;
  _lastEvent = null;
  if (_showTimer) { clearTimeout(_showTimer); _showTimer = 0; }
  if (_root) {
    _root.style.opacity = '0';
    // Also collapse to display:none. Hover paths that ripped the source element
    // out of the DOM (e.g. clicking a char card → hideStartScreen removes the
    // card before mouseleave fires) leave the tooltip stuck at opacity:1 with
    // no future event to clear it. display:none defeats that stuck state.
    _root.style.display = 'none';
  }
}

function scheduleShow(el, fn, ev) {
  if (_showTimer) clearTimeout(_showTimer);
  // Cache event coords now — ev may pool / be reused.
  const cached = ev ? { clientX: ev.clientX, clientY: ev.clientY } : null;
  _showTimer = setTimeout(() => {
    _showTimer = 0;
    showFor(el, fn, cached);
  }, HOVER_DELAY_MS);
}

/**
 * Bind a tooltip to an element. Idempotent on the same element.
 *
 * @param {HTMLElement} el
 * @param {() => ({title, body, tags?, stats?, icon?, accent?} | null)} contentFn
 */
export function bindTooltip(el, contentFn) {
  if (!el || typeof contentFn !== 'function') return;
  // Replace any prior binding (so cards can re-bind on repaint without leaking).
  unbindTooltip(el);
  const onEnter = (ev) => scheduleShow(el, contentFn, ev);
  const onMove  = (ev) => {
    if (_activeEl === el) positionAtCursor(ev);
    else if (_showTimer) {
      // Update cached coords during the pre-show delay so the card lands at the
      // current pointer, not the entry point.
      _lastEvent = { clientX: ev.clientX, clientY: ev.clientY };
    }
  };
  const onLeave = () => {
    if (_showTimer) { clearTimeout(_showTimer); _showTimer = 0; }
    if (_activeEl === el) hide();
  };
  const onFocus = () => {
    if (_showTimer) clearTimeout(_showTimer);
    _showTimer = setTimeout(() => {
      _showTimer = 0;
      showFor(el, contentFn, null);
    }, HOVER_DELAY_MS);
  };
  const onBlur = () => { if (_activeEl === el) hide(); };
  el.addEventListener('mouseenter', onEnter);
  el.addEventListener('mousemove',  onMove);
  el.addEventListener('mouseleave', onLeave);
  el.addEventListener('focus',      onFocus, true);
  el.addEventListener('blur',       onBlur,  true);
  el.__kkTooltip = { onEnter, onMove, onLeave, onFocus, onBlur, contentFn };
}

export function unbindTooltip(el) {
  if (!el || !el.__kkTooltip) return;
  const h = el.__kkTooltip;
  el.removeEventListener('mouseenter', h.onEnter);
  el.removeEventListener('mousemove',  h.onMove);
  el.removeEventListener('mouseleave', h.onLeave);
  el.removeEventListener('focus',      h.onFocus, true);
  el.removeEventListener('blur',       h.onBlur,  true);
  delete el.__kkTooltip;
  if (_activeEl === el) hide();
}

export function hideTooltip() { hide(); }

// ── Focus integration ──────────────────────────────────────────────────────
// uiFocus.js dispatches `kk-focus-change` whenever the focused element changes;
// we use that to re-anchor the tooltip to the new element when navigating with
// keyboard or gamepad. Mouse hover paths above still work unchanged.
window.addEventListener('kk-focus-change', (ev) => {
  const el = ev && ev.detail && ev.detail.el;
  if (!el) { hide(); return; }
  if (!el.__kkTooltip) { hide(); return; }
  if (_showTimer) { clearTimeout(_showTimer); _showTimer = 0; }
  // Show immediately on focus changes (no delay) — the player explicitly moved.
  showFor(el, el.__kkTooltip.contentFn, null);
  positionAtElement(el);
});

// Hide on scroll / resize to avoid stuck-floating cards.
window.addEventListener('scroll', () => hide(), true);
window.addEventListener('resize', () => hide());
