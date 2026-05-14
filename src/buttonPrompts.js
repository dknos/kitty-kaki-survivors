/**
 * Context-sensitive button prompts.
 *
 * Looks up the active input device (keyboard/mouse vs gamepad) and produces a
 * glyph + tint for a semantic action ('interact', 'dash', 'confirm', etc).
 * Other modules call `formatPrompt(action, label)` to get an HTML snippet
 * featuring a styled pill, and register live elements via `bindPrompt(el, action, label)`
 * so that flipping the active device refreshes them in place.
 *
 * The input layer (`src/input.js`) and gamepad poller (`src/gamepad.js`) are
 * not modified here — we only READ from `input.activeDevice` (and the
 * `window.__activeInputDevice` mirror, if any other layer sets it). The active
 * device is sampled lazily on each call; a hook (`onDeviceChange`) should be
 * pumped by whoever flips the device so live prompts update immediately.
 */

import { input } from './input.js';

// ── Mapping table ───────────────────────────────────────────────────────────
// kbm = keyboard glyph (single char where possible — fits a 28px pill).
// pad = Xbox-style face/system button labels.
// tint = a tasteful colored border/glow for the pad glyph so face-button
//        colors are readable at a glance; kbm uses a neutral amber.
const KBM_TINT = '#f4e6c4';
const MAP = {
  interact:     { kbm: 'E',    pad: 'B',   padTint: '#5dbe5d' /* xbox-ish green hue for B */ },
  dash:         { kbm: '␣' /* ␣ */, pad: 'A', padTint: '#5dbe5d' },
  pause:        { kbm: 'P',    pad: '≡' /* ≡ start */, padTint: '#cccccc' },
  confirm:      { kbm: '⏎' /* ⏎ */, pad: 'A', padTint: '#5dbe5d' },
  cancel:       { kbm: 'Esc',  pad: 'B',   padTint: '#cf4f4f' },
  menu:         { kbm: 'Tab',  pad: '≡', padTint: '#cccccc' },
  levelUpPick:  { kbm: '⏎', pad: 'A', padTint: '#5dbe5d' },
};

const KBM_FALLBACK = { kbm: '?', pad: '?', padTint: KBM_TINT };

// ── Device detection ────────────────────────────────────────────────────────
/**
 * Returns 'kbm' or 'gamepad' based on the active device. Prefers
 * `window.__activeInputDevice` if set (lets other layers force a mode),
 * otherwise falls back to `input.activeDevice` from the input module.
 */
export function getActiveDevice() {
  const w = typeof window !== 'undefined' ? window.__activeInputDevice : null;
  if (w === 'gamepad' || w === 'kbm') return w;
  return (input && input.activeDevice === 'gamepad') ? 'gamepad' : 'kbm';
}

/**
 * getPrompt(action) → { glyph, color, device }
 * Returns the glyph string and a recommended tint color for the action,
 * given the currently active input device.
 */
export function getPrompt(action) {
  const entry = MAP[action] || KBM_FALLBACK;
  const device = getActiveDevice();
  if (device === 'gamepad') {
    return { glyph: entry.pad, color: entry.padTint, device };
  }
  return { glyph: entry.kbm, color: KBM_TINT, device };
}

// ── DOM glue ────────────────────────────────────────────────────────────────
// Inject styles once. Pill is 28px round-ish, monospace, dark background.
let _stylesInjected = false;
function ensureStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const css = `
.kk-prompt {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 28px; height: 28px; padding: 0 8px;
  border-radius: 8px; border: 2px solid var(--kk-prompt-color, #f4e6c4);
  background: rgba(0,0,0,0.7); color: #fff;
  font: 600 15px/1 'Consolas','Menlo','Courier New',monospace;
  letter-spacing: 0; vertical-align: middle;
  box-shadow: 0 0 6px var(--kk-prompt-color, #f4e6c4),
              inset 0 1px 0 rgba(255,255,255,0.08);
  margin-right: 6px;
  user-select: none;
}
.kk-prompt-legend {
  position: fixed; right: 14px; bottom: 64px;
  display: flex; gap: 12px; align-items: center;
  padding: 6px 10px;
  background: rgba(0,0,0,0.45);
  border: 1px solid rgba(255,220,160,0.25);
  border-radius: 10px;
  color: #f4e6c4; font: 500 12px 'Cinzel Decorative', serif;
  letter-spacing: 0.04em; z-index: 50;
  pointer-events: none;
}
.kk-prompt-legend .kk-prompt {
  margin-right: 4px;
}
`;
  const style = document.createElement('style');
  style.id = 'kk-button-prompts-style';
  style.textContent = css;
  document.head.appendChild(style);
}

/**
 * Returns HTML string: `<span class="kk-prompt" ...>GLYPH</span> Label`.
 * Use to swap "Press E …" / "[E] …" strings inline.
 */
export function formatPrompt(action, label) {
  ensureStyles();
  const p = getPrompt(action);
  const labelPart = label ? `<span class="kk-prompt-label">${escapeHtml(label)}</span>` : '';
  return `<span class="kk-prompt" style="--kk-prompt-color:${p.color}">${escapeHtml(p.glyph)}</span>${labelPart}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

// ── Live prompt registry ────────────────────────────────────────────────────
// Elements register their (element, action, label) so that when the device
// flips, we can rewrite them in place. We avoid MutationObserver — callers
// invoke `refreshAllPrompts()` from their device-flip hook, or call
// `setPromptLabel(el, label)` when the label itself changes.
const _live = new Set(); // entries: { el, action, getLabel }

/**
 * Bind a DOM element to render an action prompt. The element's innerHTML is
 * replaced on bind and on every refresh. `labelOrFn` may be a string or a
 * function returning a string (re-evaluated each refresh).
 */
export function bindPrompt(el, action, labelOrFn) {
  if (!el) return;
  ensureStyles();
  const getLabel = (typeof labelOrFn === 'function') ? labelOrFn : () => labelOrFn;
  const entry = { el, action, getLabel };
  _live.add(entry);
  _renderEntry(entry);
  return entry;
}

/** Update the label for a previously bound element (re-renders immediately). */
export function setPromptLabel(entry, labelOrFn) {
  if (!entry) return;
  entry.getLabel = (typeof labelOrFn === 'function') ? labelOrFn : () => labelOrFn;
  _renderEntry(entry);
}

/** Detach a bound element so it stops auto-refreshing. */
export function unbindPrompt(entry) {
  if (!entry) return;
  _live.delete(entry);
}

function _renderEntry(entry) {
  const label = entry.getLabel();
  entry.el.innerHTML = formatPrompt(entry.action, label);
}

/**
 * Re-render every live prompt. Cheap (Set iteration + innerHTML swap).
 * Call after the active input device changes. Safe to invoke each frame
 * if needed — but the device-flip hook is the intended cadence.
 */
export function refreshAllPrompts() {
  for (const entry of _live) _renderEntry(entry);
  _renderLegend();
}

// ── Device-flip auto-refresh ────────────────────────────────────────────────
// Poll the active device once per animation frame and refresh on change.
// Cheap (one comparison) and avoids depending on internal input-layer hooks.
let _lastDevice = null;
let _pollStarted = false;
function _startDevicePoll() {
  if (_pollStarted) return;
  _pollStarted = true;
  _lastDevice = getActiveDevice();
  const tick = () => {
    const d = getActiveDevice();
    if (d !== _lastDevice) {
      _lastDevice = d;
      refreshAllPrompts();
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ── HUD bottom-right persistent legend ──────────────────────────────────────
let _legendEl = null;
const _legendItems = [
  { action: 'interact', label: 'Interact' },
  { action: 'dash',     label: 'Dash' },
  { action: 'pause',    label: 'Pause' },
];

/**
 * Mount the persistent legend ("[E] Interact  [Space] Dash  [P] Pause") into
 * the HUD (or document.body as a fallback). Safe to call multiple times —
 * subsequent calls just re-render.
 */
export function mountLegend(parent) {
  ensureStyles();
  if (!_legendEl) {
    _legendEl = document.createElement('div');
    _legendEl.className = 'kk-prompt-legend';
    _legendEl.id = 'kk-prompt-legend';
  }
  const host = parent || document.body;
  if (_legendEl.parentNode !== host) host.appendChild(_legendEl);
  _renderLegend();
  _startDevicePoll();
  return _legendEl;
}

function _renderLegend() {
  if (!_legendEl) return;
  const parts = _legendItems.map((it) => {
    return `<span class="kk-prompt-legend-item">${formatPrompt(it.action, it.label)}</span>`;
  });
  _legendEl.innerHTML = parts.join('  ');
}

/** Show/hide the legend (e.g. hide during cutscenes / level-up modal). */
export function setLegendVisible(v) {
  if (_legendEl) _legendEl.style.display = v ? 'flex' : 'none';
}

// Auto-start the device poll the moment this module is imported — cheap.
if (typeof window !== 'undefined') _startDevicePoll();
