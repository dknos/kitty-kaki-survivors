/**
 * Per-tick frametime profiler — rolling 60-frame window, avg/max per
 * subsystem, optional bar-chart overlay.
 *
 * MISSION (PHASE 2 P2B, FOREST-V2-A29): identify any tick function
 * consistently > 2 ms so we can prioritize hot-path optimization.
 *
 * INTEGRATION
 * -----------
 * The codebase already brackets every per-frame tick call in src/main.js
 * with `perfStart()/perfMark()` from perfHUD.js (58 sites as of cohort
 * 28). Rather than re-wrap all 58 sites, this profiler taps into the
 * existing `perfMark` pipeline: perfHUD.js calls `profilerRecord(name,
 * ms)` once per mark, and we accumulate a Float64Array(60) ringbuffer
 * per name. perfHUD continues to own its single-window avg display and
 * F3 toggle; perfProfiler owns the rolling avg/max display and the
 * backtick/P toggle. The two overlays can coexist.
 *
 * ZERO-OVERHEAD DEFAULT
 * ---------------------
 * Profiler is OFF by default. `profilerRecord` first line is
 * `if (!_enabled) return;` so the per-tick cost is one branch.
 *
 * Enable:   localStorage.setItem('kkPerf','1'); location.reload();
 * Disable:  localStorage.removeItem('kkPerf'); location.reload();
 *
 * Once enabled, press backtick (`) or capital P to toggle the overlay.
 * Data still records when overlay is hidden, so you can flip it on
 * mid-run to inspect.
 *
 * RINGBUFFER
 * ----------
 * Each tracked subsystem owns one Float64Array(60). We cycle a write
 * cursor instead of push/shift (zero-alloc per frame). avg/max are
 * recomputed lazily — only when the overlay paint actually needs them
 * (every ~250 ms), not per-frame.
 *
 * DOM
 * ---
 * The overlay paints into a fixed-position div, top-left, monospace,
 * 11 px. Repaint throttled to 4 Hz so the bar chart doesn't smear.
 * Bars are HTML/CSS gradients (no canvas), kept narrow so the panel
 * stays under ~280 px wide.
 *
 * HEADLESS HARNESS
 * ----------------
 * Exposes `window.kkPerfProfilerSnapshot()` for smoke probes. Returns
 * top-K records by avg ms. Does NOT shadow perfHUD's
 * `window.kkPerfSnapshot` / `window.kkPerfForceOn` — they remain the
 * canonical paths for the existing smoke-forest-v2 harness.
 */

const WINDOW_FRAMES = 60;
const TOP_K_OVERLAY = 15;
const REPAINT_MS = 250;
const BAR_REF_MS = 4.0; // a tick at 4ms fills the bar — generous, so 2ms hot
                        // funcs read as ~half-bar (clearly visible).

// One ring per named subsystem.
const _rings = Object.create(null);  // name -> { buf:Float64Array, idx:int, filled:bool }
const _names = [];                   // insertion order — keeps overlay rows stable
// Cached top-K computed at paint time (avoid per-frame sorts).
const _displayCache = []; // { name, avg, max, last }

let _enabled = false;
let _overlayOn = false;
let _el = null;
let _nextPaint = 0;

// Read the persist flag once. Wrapped in try/catch because localStorage can
// throw in cross-origin iframes / privacy-mode contexts.
function _readGate() {
  try {
    return (typeof localStorage !== 'undefined') &&
           (localStorage.getItem('kkPerf') === '1');
  } catch (_e) {
    return false;
  }
}

// Get or lazily create the ring for `name`.
function _ringFor(name) {
  let r = _rings[name];
  if (!r) {
    r = { buf: new Float64Array(WINDOW_FRAMES), idx: 0, filled: false };
    _rings[name] = r;
    _names.push(name);
  }
  return r;
}

/**
 * Record a single tick measurement. Called by perfHUD.perfMark on every
 * bracket. MUST be cheap when disabled — that's the zero-overhead contract.
 */
export function profilerRecord(name, ms) {
  if (!_enabled) return;
  const r = _ringFor(name);
  r.buf[r.idx] = ms;
  r.idx = (r.idx + 1) % WINDOW_FRAMES;
  if (r.idx === 0) r.filled = true;
}

/**
 * Aggregate a single ring into { name, avg, max, last, samples }.
 * Called at paint time, not per-frame.
 */
function _aggregate(name) {
  const r = _rings[name];
  if (!r) return null;
  const n = r.filled ? WINDOW_FRAMES : r.idx;
  if (n === 0) return { name, avg: 0, max: 0, last: 0, samples: 0 };
  let sum = 0, max = 0;
  const buf = r.buf;
  for (let i = 0; i < n; i++) {
    const v = buf[i];
    sum += v;
    if (v > max) max = v;
  }
  // "last" = the most recently written slot, which is `idx-1` mod len.
  const lastIdx = (r.idx - 1 + WINDOW_FRAMES) % WINDOW_FRAMES;
  return {
    name,
    avg: sum / n,
    max,
    last: buf[lastIdx],
    samples: n,
  };
}

/**
 * Headless / external readers. Returns top-K subsystems by avg ms over the
 * rolling 60-frame window. Includes WINDOW_FRAMES + enabled flag for
 * harness diagnostics.
 */
export function getReport(k = TOP_K_OVERLAY) {
  const rows = [];
  for (let i = 0; i < _names.length; i++) {
    const a = _aggregate(_names[i]);
    if (a) rows.push(a);
  }
  rows.sort((x, y) => y.avg - x.avg);
  return {
    enabled: _enabled,
    window: WINDOW_FRAMES,
    count: rows.length,
    rows: rows.slice(0, k),
  };
}

/**
 * Mount the overlay DOM + key handler. Idempotent. Called once at boot.
 * Always safe to call — when the gate is off the overlay just never shows.
 */
export function initPerfProfiler() {
  if (_el) return; // idempotent
  _enabled = _readGate();

  // DOM always built so the toggle is reachable in dev mode without re-init.
  // When disabled, the toggle just paints "(disabled)" and bails.
  _el = document.createElement('div');
  _el.id = 'kk-perf-profiler';
  _el.style.cssText = [
    'position:fixed; left:12px; top:12px;',
    'pointer-events:none; z-index:201;',
    "font-family:'JetBrains Mono','Consolas',monospace;",
    'font-size:11px; line-height:1.4;',
    'color:#f0e6d4;',
    'background:rgba(8,14,18,0.82);',
    'border:1px solid rgba(127,255,228,0.22);',
    'border-radius:6px;',
    'padding:8px 10px;',
    'box-shadow:0 6px 16px rgba(0,0,0,0.5);',
    'white-space:pre;',
    'min-width:260px; max-width:320px;',
    'display:none;',
  ].join(' ');
  document.body.appendChild(_el);

  // Key bindings — backtick or shift+P. Only react when gated on so we
  // never steal keystrokes in prod.
  window.addEventListener('keydown', (e) => {
    if (!_enabled) return;
    // backtick on US layout reports code 'Backquote'. We also accept 'KeyP'
    // (any case) so a Shift+P typed deliberately still toggles.
    if (e.code === 'Backquote' || e.code === 'KeyP') {
      e.preventDefault();
      togglePerf();
    }
  });

  // Console shortcuts — independent of the gate, so a dev can flip the
  // gate on, reload, then hit `window.kkPerfProfiler()` to toggle.
  if (typeof window !== 'undefined') {
    window.kkPerfProfiler = togglePerf;
    window.kkPerfProfilerSnapshot = (k) => getReport(k);
    window.kkPerfProfilerEnable = () => {
      try { localStorage.setItem('kkPerf', '1'); } catch (_e) {}
      _enabled = true;
    };
    window.kkPerfProfilerDisable = () => {
      try { localStorage.removeItem('kkPerf'); } catch (_e) {}
      _enabled = false;
      _overlayOn = false;
      if (_el) _el.style.display = 'none';
    };
  }
}

export function togglePerf() {
  _overlayOn = !_overlayOn;
  if (_el) _el.style.display = _overlayOn ? 'block' : 'none';
}

/**
 * Called by main.js once per frame. Paints the overlay if visible.
 * No-op (single branch) when overlay is hidden — keeps the cost off the
 * critical path for normal play.
 */
export function renderOverlay() {
  if (!_overlayOn || !_el) return;
  const now = performance.now();
  if (now < _nextPaint) return;
  _nextPaint = now + REPAINT_MS;

  // Disabled but overlay open: show why nothing renders.
  if (!_enabled) {
    _el.textContent =
      'perfProfiler: DISABLED\n' +
      'enable: localStorage.setItem("kkPerf","1"); reload\n';
    return;
  }

  // Recompute display cache. Cheap — WINDOW_FRAMES * len(names) per repaint
  // at 4 Hz, so even 60 names is < 15 k ops/s.
  _displayCache.length = 0;
  for (let i = 0; i < _names.length; i++) {
    const a = _aggregate(_names[i]);
    if (a && a.samples > 0) _displayCache.push(a);
  }
  _displayCache.sort((x, y) => y.avg - x.avg);

  // Sum + total >2ms count for the header.
  let total = 0;
  let hotCount = 0;
  for (let i = 0; i < _displayCache.length; i++) {
    total += _displayCache[i].avg;
    if (_displayCache[i].avg >= 2.0) hotCount++;
  }

  const head =
    `perfProfiler  (60-frame window)\n` +
    `total avg ${total.toFixed(2)}ms   hot >=2ms: ${hotCount}\n` +
    `name           avg   max  last  ${'█'.repeat(8)}\n`;

  const lines = [head];
  const max = Math.min(_displayCache.length, TOP_K_OVERLAY);
  for (let i = 0; i < max; i++) {
    const row = _displayCache[i];
    const bar = _barFor(row.avg);
    const color = row.avg >= 2.0 ? '#ff7a7a' : row.avg >= 1.0 ? '#ffd27f' : '#7ee08a';
    const namePad = row.name.length > 14 ? row.name.slice(0, 14) : row.name.padEnd(14);
    const line =
      `<span style="color:${color}">` +
      `${namePad} ` +
      `${row.avg.toFixed(2).padStart(5)} ` +
      `${row.max.toFixed(2).padStart(5)} ` +
      `${row.last.toFixed(2).padStart(5)}  ` +
      `${bar}` +
      `</span>`;
    lines.push(line);
  }
  if (_displayCache.length > max) {
    lines.push(`<span style="color:#888">  ... ${_displayCache.length - max} more</span>`);
  }
  _el.innerHTML = lines.join('\n');
}

// Build an 8-cell unicode bar for a given ms reading.
function _barFor(ms) {
  const n = Math.max(0, Math.min(8, Math.round((ms / BAR_REF_MS) * 8)));
  return '█'.repeat(n) + '░'.repeat(8 - n);
}

// Test helper — flush all rings. Not used in prod; exposed for unit tests
// or for a smoke that wants a clean window after a warmup phase.
export function _resetForTest() {
  for (const k in _rings) delete _rings[k];
  _names.length = 0;
  _displayCache.length = 0;
}

// Diagnostic — current gate state. Used by docs/PERF_AUDIT.md instructions
// to verify localStorage flip took effect.
export function isEnabled() { return _enabled; }
