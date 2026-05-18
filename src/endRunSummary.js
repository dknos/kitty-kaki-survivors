/**
 * End-of-run summary screen — PHASE 1 P1F (2026-05-17).
 *
 * VS-style results panel shown after a run ends. Detects the end-of-run
 * transition by POLLING `state.gameOver` and `state.run.stats.reaperOutlasted`
 * each frame from the main tick — NO direct hooks into enemies/death/win
 * paths. One-shot per run via `state.run._summaryShown`.
 *
 * ── Trigger conditions ─────────────────────────────────────────────────────
 *   • Hero death        → state.gameOver === true (set by hero.js:567)
 *   • Final-boss kill   → state.gameOver === true && state.victory === true
 *                         (set by enemies.js:967–968)
 *   • Reaper kill of hero → state.gameOver === true (forestReaper.js:431)
 *   • Reaper outlasted  → state.run.stats.reaperOutlasted === true
 *                         (forestReaper.js:446) — does NOT flip gameOver, so
 *                         we poll it separately.
 *
 * Both triggers funnel into showSummary(reason). The first one wins per run.
 *
 * ── Header copy + color ────────────────────────────────────────────────────
 *   victory / outlast → "RUN COMPLETE" (slot-7 gold #ffd86b)
 *   death             → "GAME OVER"   (reaper red #ff2020)
 *
 * ── Coexistence with ui.js showDeathScreen ─────────────────────────────────
 * The existing kk-death modal (ui.js:1686, z-index 110) keeps firing on
 * state.gameOver. Our summary panel sits at z-index 130 — strictly above
 * the death modal + HUD (z 70) + boss bars (z 65) + pause overlay (z 95) +
 * cinematic banner (z 90). Both are visible at once; the player can click
 * either CONTINUE (ours) or the death modal's MENU button. Both routes
 * exit through window.kkReturnToMenu so end-state is identical.
 *
 * Keyboard race: kk-death also binds Enter/Space (ui.js:2053) to its
 * restart() flow. We register our key handler in the capture phase AND
 * call stopImmediatePropagation so our handler wins — the panel is
 * visually on top, so its key bindings should win too.
 *
 * ── Title return ───────────────────────────────────────────────────────────
 * Uses window.kkReturnToMenu (main.js:589) — full teardown +
 * showMenuV2() rebind. Reload fallback only if that hook is missing.
 *
 * ── Pause ──────────────────────────────────────────────────────────────────
 * Sets state.time.paused = true on show. The main tick gate at main.js:1777
 * already freezes on `gameOver || paused || pendingLevelUp` so the death-
 * triggered path is already frozen — the explicit `paused = true` is for
 * the outlast path where gameOver is NOT set and the run would otherwise
 * keep ticking under the panel. Restored to its prior value on hide.
 *
 * ── Palette (slot-locked, no new hex constants) ────────────────────────────
 *   panel bg     : slot-4 dark   #4a3220   (matches forestAchievements toast)
 *   panel border : slot-7 cream  #ffd86b   (matches achievements gold)
 *   header win   : slot-7 cream  #ffd86b
 *   header dead  : reaper red    #ff2020   (matches bossIntroCinematic reaper)
 *   stat label   : slot-1 bone   #c7b89a   (matches achievements text)
 *   stat value   : slot-6 gold   #d9a648
 *   btn idle     : slot-6 gold   #d9a648
 *   btn hover    : slot-7 cream  #ffd86b
 *   weapon icon  : slot-7 cream  #ffd86b
 *
 * ── Public API ─────────────────────────────────────────────────────────────
 *   loadEndRunSummary(state)
 *   tickEndRunSummary(state, dt)
 *   showSummary(reason)            — 'death' | 'victory' | 'outlast' | 'manual'
 *   disposeEndRunSummary()
 */

// Lazy import — runtime only, mirrors bossIntroCinematic. Static would pull
// audio.js's WebAudio refs into the smoke harness.
import { REGISTRY as WEAPON_REGISTRY } from './weapons/index.js';
// PHASE 4 P4J (#140) — Telemetry export button (Download telemetry JSON).
// Static import; telemetry.js is dependency-free so it adds no graph weight.
import { exportJSON as telemetryExportJSON, suggestFilename as telemetrySuggestFilename } from './telemetry.js';

// ── Slot-locked palette (reused constants, no new hex) ─────────────────────
const C_PANEL_BG     = '#4a3220';   // slot-4 dark
const C_PANEL_BORDER = '#ffd86b';   // slot-7 cream
const C_HEADER_WIN   = '#ffd86b';   // slot-7 cream
const C_HEADER_DEAD  = '#ff2020';   // reaper red
const C_LABEL        = '#c7b89a';   // slot-1 bone
const C_VALUE        = '#d9a648';   // slot-6 gold
const C_BTN          = '#d9a648';   // slot-6 gold
const C_BTN_HOVER    = '#ffd86b';   // slot-7 cream
const C_ICON         = '#ffd86b';   // slot-7 cream

// ── DOM ids ────────────────────────────────────────────────────────────────
const PANEL_ID = 'kk-endrun-summary';
const STYLE_ID = 'kk-endrun-summary-style';

// ── Module state ───────────────────────────────────────────────────────────
let _styleEl       = null;
let _panelEl       = null;
let _continueBtn   = null;
let _stateRef      = null;
let _keyHandler    = null;
let _prevPaused    = false;
let _sfx           = null;

// ── Lifecycle ──────────────────────────────────────────────────────────────

/**
 * Idempotent. Stashes state ref + warms the lazy sfx import. Safe to call
 * across stage swaps; dispose() flips refs back to null so a re-load
 * rebuilds cleanly. DOM is lazy-created on first showSummary() — load()
 * does NOT touch the document tree.
 */
export function loadEndRunSummary(state) {
  _stateRef = state || null;
  if (!_sfx) {
    import('./audio.js').then((m) => { _sfx = m.sfx; }).catch(() => {});
  }
}

/**
 * Per-frame tick. Polls state.gameOver + state.run.stats.reaperOutlasted
 * for the FIRST end-of-run transition this run. One-shot via
 * state.run._summaryShown. Stage-agnostic; bails fast when nothing to do.
 *
 * Called BEFORE the main tick's gameOver/paused/pendingLevelUp gate so it
 * keeps polling even after gameOver flips (otherwise the gate at
 * main.js:1777 would short-circuit before we ever ran).
 */
export function tickEndRunSummary(state, _dt) {
  if (!state || !state.run) return;
  if (state.run._summaryShown === true) return;

  // Trigger A: gameOver (covers hero death, final-boss kill, reaper kill).
  if (state.gameOver === true) {
    const reason = (state.victory === true) ? 'victory' : 'death';
    showSummary(reason);
    return;
  }

  // Trigger B: reaper outlasted (35:00). Does NOT flip gameOver, so we
  // detect it on its own.
  const stats = state.run.stats;
  if (stats && stats.reaperOutlasted === true) {
    showSummary('outlast');
    return;
  }
}

/**
 * Public trigger. Idempotent per run via state.run._summaryShown. Safe to
 * call from any path; tick polling is the normal source. Manual quit from
 * pause menu (future hookup) would call showSummary('manual').
 *
 * @param {'death'|'victory'|'outlast'|'manual'} reason
 */
export function showSummary(reason) {
  const state = _stateRef;
  if (!state || !state.run) return;
  if (state.run._summaryShown === true) return;

  // CRITICAL: stamp synchronously before any DOM/async work so a same-frame
  // re-entrant call (e.g. tick polling + a manual trigger in the same frame)
  // can't double-show.
  state.run._summaryShown = true;

  // Capture prior paused value so we can restore on hide.
  _prevPaused = !!(state.time && state.time.paused);
  if (state.time) state.time.paused = true;

  _ensureStyle();
  _ensureBuilt(reason);

  // SFX cue: gold chime on win/outlast, boss-warn on death. Lazy sfx may not
  // have resolved yet (boot race) — swallow the miss.
  try {
    if (_sfx) {
      if ((reason === 'victory' || reason === 'outlast') && _sfx.evolutionChime) {
        _sfx.evolutionChime();
      } else if (reason === 'death' && _sfx.bossWarn) {
        _sfx.bossWarn();
      }
    }
  } catch (_) {}

  // Keyboard: Enter / Space / Escape → CONTINUE.
  //
  // The existing ui.js kk-death modal (z 110) ALSO listens for Enter/Space
  // and maps them to its restart() flow (ui.js:2053). Both handlers would
  // fire on the same keypress, causing restart + kkReturnToMenu to race
  // (both call _teardownActiveRun then set conflicting state.mode +
  // state.started). We register in the capture phase AND use
  // stopImmediatePropagation so our handler runs first and the kk-death
  // handler never sees the event. Our z-130 is strictly above the death
  // modal, so this matches the visual hierarchy.
  _keyHandler = (e) => {
    if (!e) return;
    if (e.code === 'Enter' || e.code === 'Space' || e.code === 'Escape'
        || e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') {
      e.preventDefault();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      else if (typeof e.stopPropagation === 'function') e.stopPropagation();
      _onContinue();
    }
  };
  try { window.addEventListener('keydown', _keyHandler, true); } catch (_) {}
}

/**
 * Tear down DOM, drop refs, restore paused, remove key handler. Idempotent.
 * Mirrors disposeBossIntroCinematic shape: safe across stage swaps + run
 * resets. Does NOT clear state.run._summaryShown — that's the run-level
 * one-shot flag, owned by state.resetState().
 */
export function disposeEndRunSummary() {
  if (_keyHandler) {
    try { window.removeEventListener('keydown', _keyHandler, true); } catch (_) {}
    _keyHandler = null;
  }
  const panel = document.getElementById(PANEL_ID);
  if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
  const style = document.getElementById(STYLE_ID);
  if (style && style.parentNode) style.parentNode.removeChild(style);
  // Restore paused if we set it. Skip if state is gone (dispose during
  // teardown is fine — paused has no meaning post-teardown).
  if (_stateRef && _stateRef.time && _prevPaused === false) {
    _stateRef.time.paused = false;
  }
  _panelEl     = null;
  _continueBtn = null;
  _styleEl     = null;
  _prevPaused  = false;
  // NOTE: _stateRef is intentionally NOT nulled here. dispose fires in 5
  // sites (one in _teardownActiveRun + four stage-swap branches in
  // applyMetaUpgrades). applyMetaUpgrades runs at run start — nulling
  // _stateRef there would leave the module stateless for the entire next
  // run, so the next death/win would silently bail in showSummary().
  // _stateRef is a stable module-level binding (not a DOM/scene
  // resource); loadEndRunSummary() is the only canonical (re)binder.
}

// ── Internals ──────────────────────────────────────────────────────────────

/**
 * CONTINUE click/key handler. Hides the panel + returns to title via
 * window.kkReturnToMenu (full teardown path defined in main.js:589). If the
 * hook is somehow missing, falls back to a hard reload — the nuclear option
 * but always works.
 */
/**
 * PHASE 4 P4J (#140) — "Telemetry" button handler. Creates a Blob URL of the
 * full persisted telemetry store (last 100 runs) and triggers a download via
 * a temporary anchor click. Does NOT close the panel — the player may still
 * want to click CONTINUE after grabbing the file. Revokes the Blob URL after
 * the click so we don't leak object URLs across many opens.
 */
function _onDownloadTelemetry() {
  let url = null;
  try { url = telemetryExportJSON(); } catch (e) { console.warn('[endRunSummary] telemetry export failed:', e); }
  if (!url) return;
  let filename = 'kks_telemetry.json';
  try { filename = telemetrySuggestFilename() || filename; } catch (_) {}
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (e) {
    console.warn('[endRunSummary] telemetry download click failed:', e);
  }
  // Revoke shortly after the click so the download finishes claiming the URL.
  try { setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 1500); } catch (_) {}
}

function _onContinue() {
  // Hide the panel locally before kkReturnToMenu does its teardown — the
  // teardown will dispose us too, but a fast click should feel responsive.
  if (_panelEl) _panelEl.style.opacity = '0';
  // Remove the key handler immediately so a held key can't fire twice.
  if (_keyHandler) {
    try { window.removeEventListener('keydown', _keyHandler, true); } catch (_) {}
    _keyHandler = null;
  }
  // Restore paused BEFORE the return-to-menu call. kkReturnToMenu also sets
  // paused=false (main.js:601) but doing it here too is harmless and keeps
  // the contract: pause is owned by this module while the panel is up.
  if (_stateRef && _stateRef.time) _stateRef.time.paused = _prevPaused;

  if (typeof window !== 'undefined' && typeof window.kkReturnToMenu === 'function') {
    try { window.kkReturnToMenu(); return; }
    catch (e) { console.warn('[endRunSummary] kkReturnToMenu failed:', e); }
  }
  // Fallback: hard reload.
  try { if (typeof window !== 'undefined') window.location.reload(); } catch (_) {}
}

function _ensureStyle() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) {
    _styleEl = document.getElementById(STYLE_ID);
    return;
  }
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    #${PANEL_ID} {
      position: fixed;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      width: 640px;
      max-width: calc(100vw - 40px);
      max-height: calc(100vh - 40px);
      overflow-y: auto;
      pointer-events: auto;
      z-index: 130;
      font-family: monospace, 'Courier New', Courier;
      color: ${C_LABEL};
      background: linear-gradient(180deg, rgba(74,50,32,0.94), rgba(40,26,16,0.96));
      border: 2px solid ${C_PANEL_BORDER};
      box-shadow: 0 12px 40px rgba(0,0,0,0.7), 0 0 22px ${C_PANEL_BORDER}33;
      padding: 24px 28px 22px;
      opacity: 0;
      transition: opacity 0.22s ease-out;
      box-sizing: border-box;
    }
    #${PANEL_ID}.kk-ers-show {
      opacity: 1;
    }
    #${PANEL_ID} .kk-ers-header {
      text-align: center;
      font-size: 28px;
      font-weight: 900;
      letter-spacing: 0.22em;
      margin-bottom: 4px;
      text-shadow: 0 2px 12px rgba(0,0,0,0.7);
    }
    #${PANEL_ID} .kk-ers-subheader {
      text-align: center;
      font-size: 11px;
      letter-spacing: 0.30em;
      color: ${C_LABEL};
      opacity: 0.62;
      margin-bottom: 18px;
      text-transform: uppercase;
    }
    #${PANEL_ID} .kk-ers-cols {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 22px;
      margin-bottom: 18px;
    }
    #${PANEL_ID} .kk-ers-col h3 {
      margin: 0 0 8px;
      font-size: 11px;
      letter-spacing: 0.24em;
      text-transform: uppercase;
      color: ${C_PANEL_BORDER};
      opacity: 0.78;
      border-bottom: 1px solid ${C_PANEL_BORDER}55;
      padding-bottom: 4px;
    }
    #${PANEL_ID} .kk-ers-stats {
      display: grid;
      grid-template-columns: 1fr auto;
      column-gap: 12px;
      row-gap: 5px;
      align-items: baseline;
      font-size: 13px;
    }
    #${PANEL_ID} .kk-ers-stats .kk-ers-label {
      color: ${C_LABEL};
      letter-spacing: 0.10em;
      text-transform: uppercase;
      font-size: 11px;
      opacity: 0.82;
    }
    #${PANEL_ID} .kk-ers-stats .kk-ers-value {
      color: ${C_VALUE};
      text-align: right;
      font-weight: 700;
    }
    #${PANEL_ID} .kk-ers-flag {
      grid-column: 1 / -1;
      color: ${C_PANEL_BORDER};
      font-size: 12px;
      letter-spacing: 0.10em;
      margin-top: 4px;
    }
    #${PANEL_ID} .kk-ers-weapons {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
    }
    #${PANEL_ID} .kk-ers-weapon {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 8px 4px;
      background: rgba(0,0,0,0.28);
      border: 1px solid ${C_PANEL_BORDER}44;
      min-height: 56px;
      text-align: center;
    }
    #${PANEL_ID} .kk-ers-weapon-icon {
      font-size: 22px;
      line-height: 1;
      color: ${C_ICON};
      margin-bottom: 4px;
    }
    #${PANEL_ID} .kk-ers-weapon-name {
      font-size: 10px;
      letter-spacing: 0.08em;
      color: ${C_LABEL};
      text-transform: uppercase;
      line-height: 1.1;
    }
    #${PANEL_ID} .kk-ers-weapon-level {
      font-size: 10px;
      color: ${C_VALUE};
      margin-top: 2px;
      letter-spacing: 0.08em;
    }
    #${PANEL_ID} .kk-ers-weapons-empty {
      grid-column: 1 / -1;
      text-align: center;
      font-size: 11px;
      color: ${C_LABEL};
      opacity: 0.55;
      padding: 12px 0;
      letter-spacing: 0.10em;
    }
    #${PANEL_ID} .kk-ers-achievements {
      margin: 4px 0 14px;
      padding: 8px 10px;
      background: rgba(0,0,0,0.22);
      border: 1px solid ${C_PANEL_BORDER}33;
    }
    #${PANEL_ID} .kk-ers-achievements .kk-ers-ach-title {
      font-size: 11px;
      letter-spacing: 0.20em;
      text-transform: uppercase;
      color: ${C_PANEL_BORDER};
      margin-bottom: 4px;
    }
    #${PANEL_ID} .kk-ers-achievements .kk-ers-ach-list {
      font-size: 12px;
      color: ${C_VALUE};
      letter-spacing: 0.06em;
      line-height: 1.4;
    }
    #${PANEL_ID} .kk-ers-footer {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 12px;
      margin-top: 8px;
    }
    /* PHASE 4 P4J — secondary "Telemetry" button. Same gold border for
       palette discipline (slot-locked, no new hex), smaller padding +
       font size so the primary CONTINUE keeps the visual emphasis. */
    #${PANEL_ID} .kk-ers-btn-sm {
      padding: 8px 18px;
      font-size: 11px;
      letter-spacing: 0.20em;
    }
    #${PANEL_ID} .kk-ers-btn {
      background: rgba(0,0,0,0.45);
      color: ${C_BTN};
      border: 2px solid ${C_BTN};
      padding: 10px 36px;
      font-family: inherit;
      font-size: 14px;
      font-weight: 800;
      letter-spacing: 0.30em;
      text-transform: uppercase;
      cursor: pointer;
      transition: color 0.15s ease-out, border-color 0.15s ease-out,
                  background 0.15s ease-out, box-shadow 0.15s ease-out;
    }
    #${PANEL_ID} .kk-ers-btn:hover,
    #${PANEL_ID} .kk-ers-btn:focus {
      color: ${C_BTN_HOVER};
      border-color: ${C_BTN_HOVER};
      background: rgba(0,0,0,0.62);
      box-shadow: 0 0 18px ${C_BTN_HOVER}55;
      outline: none;
    }
  `;
  document.head.appendChild(s);
  _styleEl = s;
}

/**
 * Build the panel DOM on first show. Idempotent — if it already exists,
 * just re-trigger the fade-in. Re-using an existing element across two
 * show calls in the same run shouldn't happen (one-shot flag) but the
 * guard keeps us cheap if a future caller bypasses the flag.
 */
function _ensureBuilt(reason) {
  if (typeof document === 'undefined') return;
  if (document.getElementById(PANEL_ID)) {
    _panelEl = document.getElementById(PANEL_ID);
    // Re-show: re-toggle class for the fade.
    _panelEl.classList.remove('kk-ers-show');
    void _panelEl.offsetWidth;
    _panelEl.classList.add('kk-ers-show');
    return;
  }
  const state = _stateRef;
  if (!state) return;

  const root = document.getElementById('ui-root') || document.body;
  if (!root) return;

  const el = document.createElement('div');
  el.id = PANEL_ID;

  // ── Header ────────────────────────────────────────────────────────────
  const isWin = (reason === 'victory' || reason === 'outlast');
  const headerText = isWin ? 'RUN COMPLETE' : 'GAME OVER';
  const headerColor = isWin ? C_HEADER_WIN : C_HEADER_DEAD;

  const header = document.createElement('div');
  header.className = 'kk-ers-header';
  header.textContent = headerText;
  header.style.color = headerColor;
  if (!isWin) {
    header.style.textShadow = `0 2px 12px rgba(0,0,0,0.7), 0 0 18px ${headerColor}66`;
  } else {
    header.style.textShadow = `0 2px 12px rgba(0,0,0,0.7), 0 0 22px ${headerColor}55`;
  }
  el.appendChild(header);

  const sub = document.createElement('div');
  sub.className = 'kk-ers-subheader';
  sub.textContent = _subheaderForReason(reason, state);
  el.appendChild(sub);

  // ── Two columns: stats + weapons ──────────────────────────────────────
  const cols = document.createElement('div');
  cols.className = 'kk-ers-cols';

  cols.appendChild(_buildStatsColumn(state, reason));
  cols.appendChild(_buildWeaponsColumn(state));

  el.appendChild(cols);

  // ── Achievements this run (optional row, only if any unlocked) ────────
  const achList = _achievementsThisRunList(state);
  if (achList.length > 0) {
    const achBox = document.createElement('div');
    achBox.className = 'kk-ers-achievements';
    const t = document.createElement('div');
    t.className = 'kk-ers-ach-title';
    t.textContent = `Achievements Unlocked (${achList.length})`;
    achBox.appendChild(t);
    const list = document.createElement('div');
    list.className = 'kk-ers-ach-list';
    list.textContent = achList.join('  •  ');
    achBox.appendChild(list);
    el.appendChild(achBox);
  }

  // ── Footer: CONTINUE + DOWNLOAD TELEMETRY ─────────────────────────────
  // PHASE 4 P4J (#140) — secondary "Telemetry" button writes the full
  // localStorage `kks_telemetry` store to disk via Blob URL. Sits LEFT of
  // CONTINUE so the primary action keeps its position. Styled `.kk-ers-btn-sm`
  // so the gold border read isn't a duplicate of CONTINUE's emphasis.
  const footer = document.createElement('div');
  footer.className = 'kk-ers-footer';

  const dlBtn = document.createElement('button');
  dlBtn.type = 'button';
  dlBtn.className = 'kk-ers-btn kk-ers-btn-sm';
  dlBtn.textContent = 'Telemetry';
  dlBtn.title = 'Download per-run telemetry JSON (last 100 runs)';
  dlBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    _onDownloadTelemetry();
  });
  footer.appendChild(dlBtn);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'kk-ers-btn';
  btn.textContent = 'Continue';
  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); _onContinue(); });
  footer.appendChild(btn);
  el.appendChild(footer);

  root.appendChild(el);
  _panelEl = el;
  _continueBtn = btn;

  // Trigger fade-in on next frame so the transition kicks.
  void el.offsetWidth;
  el.classList.add('kk-ers-show');

  // Move focus onto the button so Enter/Space land on it without the user
  // having to click first. Guarded for stub DOMs.
  try { btn.focus({ preventScroll: true }); } catch (_) {
    try { btn.focus(); } catch (_) {}
  }
}

// ── Stat column builders ───────────────────────────────────────────────────

function _buildStatsColumn(state, reason) {
  const col = document.createElement('div');
  col.className = 'kk-ers-col';

  const h = document.createElement('h3');
  h.textContent = 'Run Stats';
  col.appendChild(h);

  const grid = document.createElement('div');
  grid.className = 'kk-ers-stats';

  const stats = (state.run && state.run.stats) || {};

  _statRow(grid, 'Stage Time', _fmtTime(state.time && state.time.game));
  _statRow(grid, 'Kills',      _fmtInt(state.run && state.run.kills));
  _statRow(grid, 'Gold',       _fmtInt(state.run && state.run.gold));
  _statRow(grid, 'Chests',     _fmtInt(state.run && state.run._chestsOpened));
  _statRow(grid, 'Coffins',    _coffinCount(state));
  _statRow(grid, 'Mini-Bosses', _fmtInt(state.run && state.run.miniBossKills));

  // Reaper outcomes — only one of these is meaningful per run.
  if (stats.reaperOutlasted === true) {
    _flag(grid, '✓ Reaper outlasted (35:00)');
  } else if (typeof stats.reaperKillTime === 'number') {
    _statRow(grid, 'Reaper Killed @', _fmtTime(stats.reaperKillTime));
  }

  // Reason ribbon (small clarifier — helps disambiguate manual/outlast).
  if (reason === 'manual') {
    _flag(grid, '⏸ Quit from pause menu');
  }

  col.appendChild(grid);
  return col;
}

function _buildWeaponsColumn(state) {
  const col = document.createElement('div');
  col.className = 'kk-ers-col';

  const h = document.createElement('h3');
  h.textContent = 'Arsenal';
  col.appendChild(h);

  const grid = document.createElement('div');
  grid.className = 'kk-ers-weapons';

  const weapons = (state && Array.isArray(state.weapons)) ? state.weapons : [];
  if (weapons.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'kk-ers-weapons-empty';
    empty.textContent = '— No weapons —';
    grid.appendChild(empty);
  } else {
    // Render up to 9 weapons (3×3). Past 9 we just truncate visually; the
    // typical run caps at 6 active + a couple of hidden Forest specials.
    for (let i = 0; i < Math.min(weapons.length, 9); i++) {
      const w = weapons[i];
      if (!w || !w.id) continue;
      const reg = WEAPON_REGISTRY && WEAPON_REGISTRY[w.id];
      const name = (reg && reg.name) ? reg.name : String(w.id);
      const icon = (reg && reg.icon) ? reg.icon : '⚔';
      const level = (typeof w.level === 'number') ? w.level : '?';

      const cell = document.createElement('div');
      cell.className = 'kk-ers-weapon';
      cell.title = `${name} — Level ${level}`;
      const ic = document.createElement('div');
      ic.className = 'kk-ers-weapon-icon';
      ic.textContent = icon;
      cell.appendChild(ic);
      const nm = document.createElement('div');
      nm.className = 'kk-ers-weapon-name';
      // Trim long names so the 3-col grid stays clean.
      nm.textContent = (name.length > 14) ? name.slice(0, 13) + '…' : name;
      cell.appendChild(nm);
      const lv = document.createElement('div');
      lv.className = 'kk-ers-weapon-level';
      lv.textContent = `L${level}`;
      cell.appendChild(lv);

      grid.appendChild(cell);
    }
  }

  col.appendChild(grid);
  return col;
}

// ── Small helpers ──────────────────────────────────────────────────────────

function _statRow(grid, label, value) {
  const l = document.createElement('div');
  l.className = 'kk-ers-label';
  l.textContent = label;
  grid.appendChild(l);
  const v = document.createElement('div');
  v.className = 'kk-ers-value';
  v.textContent = value;
  grid.appendChild(v);
}

function _flag(grid, text) {
  const f = document.createElement('div');
  f.className = 'kk-ers-flag';
  f.textContent = text;
  grid.appendChild(f);
}

function _subheaderForReason(reason, state) {
  if (reason === 'victory') return 'Final boss defeated';
  if (reason === 'outlast') return 'Reaper outlasted';
  if (reason === 'manual')  return 'Run abandoned';
  // death: try to disambiguate via reaper kill time
  const stats = (state.run && state.run.stats) || {};
  if (typeof stats.reaperKillTime === 'number') return 'Slain by the Reaper';
  return 'You fell in battle';
}

function _fmtTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function _fmtInt(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  // Comma thousands for readability on big kill totals.
  return v.toLocaleString ? v.toLocaleString() : String(v);
}

function _coffinCount(state) {
  const obj = state && state.run && state.run._coffinsOpened;
  if (!obj || typeof obj !== 'object') return _fmtInt(0);
  // _coffinsOpened is a sparse map keyed by 'c<idx>'. Count truthy entries.
  let n = 0;
  for (const k in obj) { if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k]) n++; }
  return _fmtInt(n);
}

/**
 * Read state.run._achievementsThisRun (a Set per cohort 19) and return a
 * sorted array of human-readable labels. Defensive against the Set being
 * absent (legacy save loads) or being a plain object (JSON-revived).
 */
function _achievementsThisRunList(state) {
  const raw = state && state.run && state.run._achievementsThisRun;
  if (!raw) return [];
  let ids = [];
  if (raw instanceof Set) {
    ids = Array.from(raw);
  } else if (Array.isArray(raw)) {
    ids = raw.slice();
  } else if (typeof raw === 'object') {
    // JSON-revived path (Set serialised to {}) — best-effort.
    ids = Object.keys(raw);
  }
  if (ids.length === 0) return [];
  // Pretty-print: replace underscores with spaces, title-case-ish.
  return ids.map((id) => String(id).replace(/_/g, ' ').toUpperCase()).sort();
}
