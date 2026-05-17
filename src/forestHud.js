/**
 * FOREST-V2-A10 Stage HUD (2026-05-17)
 *
 * Vanilla-VS top-bar overlay for the Forest stage. Adds legibility for the
 * 30-minute Reaper arc + run progression:
 *
 *   • Stage clock (top-center)         — MM:SS reading state.time.game,
 *                                        color shifts with the day/night
 *                                        phase to mirror forestDayNight.js
 *                                        (MIDDAY → BLOOD_MOON).
 *   • Reaper countdown (below clock)   — "REAPER IN M:SS" once gameT >=
 *                                        1680 (T-2:00 from 1800s spawn);
 *                                        flips to "REAPER ACTIVE" at 1800s.
 *   • Kill counter (top-right)         — "Kills: N" reading state.run.kills.
 *   • Chest counter (top-left)         — Spec FALLBACK: no per-run counter
 *                                        exists in code (only
 *                                        meta.lifetime.chestsOpened). To
 *                                        avoid taking a meta dependency
 *                                        and per the spec, the chest
 *                                        counter is rendered with a
 *                                        placeholder "—" until a per-run
 *                                        hook lands in forestChests.js.
 *                                        See "Chest counter fallback" in
 *                                        the final-report contract notes.
 *
 * === Field-name verification (grep against src/, 2026-05-17) ===
 *   state.stage          → ABSENT. Replaced by state.run.stage.id (literal
 *                          guard mirrors every forest-only block in
 *                          main.js).
 *   state.title          → ABSENT. Replaced by state.started (inverse: a
 *                          truthy state.started means we are PAST the
 *                          title screen). main.js:1701 `if
 *                          (!state.started) return;` confirms shape.
 *   state.gameOver       → ✓ present (enemies.js:943, hero.js:567).
 *   state.run.kills      → ✓ present (enemies.js:866 `state.run.kills++`).
 *   state.time.game      → ✓ present, paused-aware (cohort 7 verified;
 *                          forestDayNight.js, forestReaper.js consume it).
 *
 * === Palette lock ===
 * Reuses three hex constants already established in repo by other FE-V2
 * modules (forestCoffins, forestChests, forestNeutrals, forestDayNight).
 * No new hex literals are introduced:
 *
 *   slot-1 bone  #c7b89a — clock (MIDDAY), kill counter, chest counter
 *   slot-5 amber #e89c4a — clock (DUSK/TWILIGHT/BLOOD_MOON), reaper banner
 *   slot-6 gold  #d9a648 — clock (GOLDEN_HOUR)
 *
 * Forest's locked 8-color palette (docs/FOREST_VISUAL_STYLE.md) contains
 * no red; per the spec, BLOOD_MOON urgency is conveyed by slot-5 amber +
 * bold + slow pulse, not a new red constant.
 *
 * === z-index ===
 * z-index: 70 — above gameplay flashes (forestPickups 55, forestReaper
 * 60) and button prompts (50), well below pause/level-up overlays (95+)
 * and modals (130+). Picked vs. spec's suggested 50 because that value
 * collides with buttonPrompts.js.
 *
 * === Lifecycle ===
 *   loadForestHud(scene, state)   — idempotent. Wired from arenaDecor.js
 *                                   gated on state._hudLoaded, mirroring
 *                                   the forestDayNight gate.
 *   tickForestHud(state, dt)      — per-frame. Mutates textContent +
 *                                   style.color only (no cssText
 *                                   rewrites). Show/hide via
 *                                   style.visibility.
 *   disposeForestHud()            — removes root + style element by id.
 *                                   Idempotent; safe across stage swaps.
 *
 * NB: This module owns ONLY DOM. It never touches the scene, the camera,
 * or any THREE object — the scene parameter is accepted to mirror the
 * loadFoo(scene, state) convention of sibling modules and to keep the
 * arenaDecor wiring uniform.
 */

// ── Palette (existing constants — see header) ──────────────────────────────
const SLOT1_BONE_CSS  = '#c7b89a'; // MIDDAY clock + counters
const SLOT5_AMBER_CSS = '#e89c4a'; // DUSK / TWILIGHT / BLOOD_MOON + reaper
const SLOT6_GOLD_CSS  = '#d9a648'; // GOLDEN_HOUR clock

// ── Phase thresholds (mirror forestDayNight.js T_* constants) ──────────────
const T_MIDDAY_END   = 600;   // 0..600   MIDDAY
const T_GOLDEN_END   = 1200;  // 600..1200 GOLDEN_HOUR
const T_DUSK_END     = 1740;  // 1200..1740 DUSK
const T_TWILIGHT_END = 1800;  // 1740..1800 TWILIGHT
                              // 1800+      BLOOD_MOON

// ── Reaper banner thresholds (mirror forestReaper.js schedule) ─────────────
const REAPER_WARN_T   = 1680; // T-2:00 from spawn
const REAPER_SPAWN_T  = 1800; // active

// ── DOM ids (kk- prefix matches every other overlay in src/) ───────────────
const ROOT_ID   = 'kk-forest-hud';
const STYLE_ID  = 'kk-forest-hud-style';
const CLOCK_ID  = 'kk-forest-hud-clock';
const REAPER_ID = 'kk-forest-hud-reaper';
const KILLS_ID  = 'kk-forest-hud-kills';
const CHESTS_ID = 'kk-forest-hud-chests';

// ── Cached refs (avoid getElementById per frame) ───────────────────────────
let _root   = null;
let _clockEl  = null;
let _reaperEl = null;
let _killsEl  = null;
let _chestsEl = null;
let _styleEl  = null;

// Last-applied values — guard against redundant DOM writes so the only
// per-frame work in the common case is a handful of string comparisons.
let _lastClockText  = '';
let _lastClockColor = '';
let _lastReaperText = '';
let _lastReaperVisible = false;
let _lastReaperClass = '';
let _lastKillsText  = '';
let _lastChestsText = '';
let _lastVisible    = true;

/**
 * Inject CSS once (id-gated). Two pulse keyframes:
 *   kk-fh-pulse-twilight — fast amber brightness pulse (T-30s → spawn)
 *   kk-fh-pulse-bloodmoon — slow amber pulse (post-spawn, more menacing)
 */
function _ensureStyle() {
  if (_styleEl && document.getElementById(STYLE_ID)) return;
  if (document.getElementById(STYLE_ID)) {
    _styleEl = document.getElementById(STYLE_ID);
    return;
  }
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = [
    '#' + ROOT_ID + ' {',
    '  position: fixed; left: 0; top: 0; right: 0;',
    '  pointer-events: none; z-index: 70;',
    '  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;',
    '  -webkit-font-smoothing: antialiased;',
    '  user-select: none;',
    '}',
    '#' + CLOCK_ID + ' {',
    '  position: absolute; top: 8px; left: 50%;',
    '  transform: translateX(-50%);',
    '  font-size: 28px; font-weight: 700; letter-spacing: 0.06em;',
    '  color: ' + SLOT1_BONE_CSS + ';',
    '  text-shadow: 0 0 4px rgba(0,0,0,0.85), 0 2px 6px rgba(0,0,0,0.7);',
    '}',
    '#' + REAPER_ID + ' {',
    '  position: absolute; top: 46px; left: 50%;',
    '  transform: translateX(-50%);',
    '  font-size: 18px; font-weight: 700; letter-spacing: 0.14em;',
    '  text-transform: uppercase;',
    '  color: ' + SLOT5_AMBER_CSS + ';',
    '  text-shadow: 0 0 6px rgba(0,0,0,0.9), 0 2px 6px rgba(0,0,0,0.7);',
    '  visibility: hidden;',
    '}',
    '#' + REAPER_ID + '.kk-fh-twilight {',
    '  animation: kk-fh-pulse-twilight 0.9s ease-in-out infinite;',
    '}',
    '#' + REAPER_ID + '.kk-fh-bloodmoon {',
    '  animation: kk-fh-pulse-bloodmoon 1.8s ease-in-out infinite;',
    '}',
    '#' + KILLS_ID + ' {',
    '  position: absolute; top: 12px; right: 14px;',
    '  font-size: 14px; font-weight: 700; letter-spacing: 0.08em;',
    '  color: ' + SLOT1_BONE_CSS + ';',
    '  text-shadow: 0 0 4px rgba(0,0,0,0.85), 0 1px 3px rgba(0,0,0,0.7);',
    '}',
    '#' + CHESTS_ID + ' {',
    '  position: absolute; top: 12px; left: 14px;',
    '  font-size: 14px; font-weight: 700; letter-spacing: 0.08em;',
    '  color: ' + SLOT1_BONE_CSS + ';',
    '  text-shadow: 0 0 4px rgba(0,0,0,0.85), 0 1px 3px rgba(0,0,0,0.7);',
    '}',
    '@keyframes kk-fh-pulse-twilight {',
    '  0%, 100% { opacity: 1.0; filter: brightness(1.0); }',
    '  50%      { opacity: 0.6; filter: brightness(1.4); }',
    '}',
    '@keyframes kk-fh-pulse-bloodmoon {',
    '  0%, 100% { opacity: 0.85; filter: brightness(0.95); }',
    '  50%      { opacity: 1.0;  filter: brightness(1.25); }',
    '}',
  ].join('\n');
  document.head.appendChild(s);
  _styleEl = s;
}

/**
 * Build the root + 4 child divs once. Idempotent: if the root already
 * exists in DOM (e.g. dispose forgot to run before re-load), we re-adopt
 * it rather than orphan a duplicate.
 */
function _ensureRoot() {
  // Re-adopt existing root if a prior session left it (defensive).
  const existing = document.getElementById(ROOT_ID);
  if (existing) {
    _root     = existing;
    _clockEl  = document.getElementById(CLOCK_ID);
    _reaperEl = document.getElementById(REAPER_ID);
    _killsEl  = document.getElementById(KILLS_ID);
    _chestsEl = document.getElementById(CHESTS_ID);
    return;
  }
  const root = document.createElement('div');
  root.id = ROOT_ID;

  const clock = document.createElement('div');
  clock.id = CLOCK_ID;
  clock.textContent = '0:00';

  const reaper = document.createElement('div');
  reaper.id = REAPER_ID;
  reaper.textContent = '';

  const kills = document.createElement('div');
  kills.id = KILLS_ID;
  kills.textContent = 'Kills: 0';

  const chests = document.createElement('div');
  chests.id = CHESTS_ID;
  // Per-run chest counter not tracked in current build — see header
  // "Chest counter fallback". Em-dash placeholder communicates "field is
  // intentional but uncountable" rather than zero (which would lie).
  chests.textContent = 'Chests: —';

  root.appendChild(clock);
  root.appendChild(reaper);
  root.appendChild(kills);
  root.appendChild(chests);
  document.body.appendChild(root);

  _root     = root;
  _clockEl  = clock;
  _reaperEl = reaper;
  _killsEl  = kills;
  _chestsEl = chests;

  // Reset write-suppression caches so first tick paints unconditionally.
  _lastClockText = '';
  _lastClockColor = '';
  _lastReaperText = '';
  _lastReaperVisible = false;
  _lastReaperClass = '';
  _lastKillsText = '';
  _lastChestsText = '';
  _lastVisible = true;
}

/**
 * Stage clock formatter. MM:SS, leading-zero seconds, no leading zero
 * on minutes (Vanilla Survivors convention).
 */
function _fmtMMSS(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

/**
 * Reaper-countdown formatter. M:SS, no leading zero on minutes. Clamps
 * negatives to 0:00 (post-spawn we render a different string upstream).
 */
function _fmtCountdown(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.ceil(seconds); // ceil so the user sees 2:00 → 1:59, not 1:59 → 1:58
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

/**
 * Map game-time → clock color. Mirrors forestDayNight phase boundaries
 * so the HUD reads as part of the same atmospheric beat as the lights.
 *
 *   MIDDAY        slot-1 bone  (calm)
 *   GOLDEN_HOUR   slot-6 gold  (warm)
 *   DUSK          slot-5 amber (warning)
 *   TWILIGHT      slot-5 amber (still — pulse + bold communicate urgency)
 *   BLOOD_MOON    slot-5 amber (still — slow pulse communicates dread)
 */
function _clockColorForT(gameT) {
  if (gameT < T_MIDDAY_END)   return SLOT1_BONE_CSS;
  if (gameT < T_GOLDEN_END)   return SLOT6_GOLD_CSS;
  return SLOT5_AMBER_CSS; // DUSK + TWILIGHT + BLOOD_MOON all share amber
}

/**
 * Should the HUD render at all? Forest stage + run started + not game-over.
 * Order matters: `state.started` first short-circuits before we deref
 * `state.run.stage` (which can be null on the title screen).
 */
function _shouldShow(state) {
  if (!state) return false;
  if (state.started !== true) return false;
  if (state.gameOver === true) return false;
  if (!state.run || !state.run.stage || state.run.stage.id !== 'forest') return false;
  return true;
}

/**
 * Idempotent load. Mirrors the FOREST-V2-A9 daynight gate in arenaDecor.js
 * (state._hudLoaded flips before the call so a builder throw doesn't
 * spin-retry; we re-clear the flag on dispose).
 *
 * @param {THREE.Scene} _scene  — unused (DOM-only module; accepted for
 *                                signature parity with sibling loaders).
 * @param {object}      _state  — unused at load time (read live each tick).
 */
export function loadForestHud(_scene, _state) {
  _ensureStyle();
  _ensureRoot();
}

/**
 * Per-frame tick. Reads state.time.game + state.run.kills, writes
 * textContent + (clock only) style.color. No style.cssText rewrites, no
 * className mutation in the common case (only when crossing the
 * TWILIGHT / BLOOD_MOON pulse thresholds).
 *
 * @param {object} state
 * @param {number} _dt — unused; we derive everything from state.time.game.
 */
export function tickForestHud(state, _dt) {
  if (!_root) return; // not loaded

  const show = _shouldShow(state);
  if (show !== _lastVisible) {
    _root.style.visibility = show ? 'visible' : 'hidden';
    _lastVisible = show;
  }
  if (!show) return; // skip all reads + DOM writes when hidden

  const gameT = (state.time && typeof state.time.game === 'number') ? state.time.game : 0;

  // ── Clock ──
  const clockText = _fmtMMSS(gameT);
  if (clockText !== _lastClockText) {
    _clockEl.textContent = clockText;
    _lastClockText = clockText;
  }
  const clockColor = _clockColorForT(gameT);
  if (clockColor !== _lastClockColor) {
    _clockEl.style.color = clockColor;
    _lastClockColor = clockColor;
  }

  // ── Reaper banner ──
  let reaperText = '';
  let reaperVisible = false;
  let reaperClass = '';
  if (gameT >= REAPER_SPAWN_T) {
    reaperText = 'REAPER ACTIVE';
    reaperVisible = true;
    reaperClass = 'kk-fh-bloodmoon'; // slow pulse
  } else if (gameT >= REAPER_WARN_T) {
    reaperText = 'REAPER IN ' + _fmtCountdown(REAPER_SPAWN_T - gameT);
    reaperVisible = true;
    // Fast pulse only inside the final TWILIGHT minute (T-60 → spawn);
    // earlier (T-2:00 → T-1:00) keep it static so the pulse is meaningful.
    reaperClass = (gameT >= (REAPER_SPAWN_T - 60)) ? 'kk-fh-twilight' : '';
  }
  if (reaperText !== _lastReaperText) {
    _reaperEl.textContent = reaperText;
    _lastReaperText = reaperText;
  }
  if (reaperVisible !== _lastReaperVisible) {
    _reaperEl.style.visibility = reaperVisible ? 'visible' : 'hidden';
    _lastReaperVisible = reaperVisible;
  }
  if (reaperClass !== _lastReaperClass) {
    _reaperEl.className = reaperClass; // single-class element; full overwrite is fine
    _lastReaperClass = reaperClass;
  }

  // ── Kill counter ──
  const killsN = (state.run && typeof state.run.kills === 'number') ? state.run.kills : 0;
  const killsText = 'Kills: ' + killsN;
  if (killsText !== _lastKillsText) {
    _killsEl.textContent = killsText;
    _lastKillsText = killsText;
  }

  // ── Chest counter (fallback path) ──
  // If a future forestChests revision adds `state.run._chestsOpened`,
  // surface it here without any other code change.
  const chestsN = (state.run && typeof state.run._chestsOpened === 'number')
    ? state.run._chestsOpened
    : null;
  const chestsText = (chestsN === null) ? 'Chests: —' : ('Chests: ' + chestsN);
  if (chestsText !== _lastChestsText) {
    _chestsEl.textContent = chestsText;
    _lastChestsText = chestsText;
  }
}

/**
 * Dispose: remove root + style elements by id, clear cached refs.
 * Idempotent — safe to call on stage swap whether or not the HUD was
 * ever loaded on this run. Mirrors the FE-V2 dispose contract (no scene
 * param required since we own no scene state).
 */
export function disposeForestHud() {
  const root = document.getElementById(ROOT_ID);
  if (root && root.parentNode) root.parentNode.removeChild(root);
  const style = document.getElementById(STYLE_ID);
  if (style && style.parentNode) style.parentNode.removeChild(style);
  _root = null;
  _clockEl = null;
  _reaperEl = null;
  _killsEl = null;
  _chestsEl = null;
  _styleEl = null;
  _lastClockText = '';
  _lastClockColor = '';
  _lastReaperText = '';
  _lastReaperVisible = false;
  _lastReaperClass = '';
  _lastKillsText = '';
  _lastChestsText = '';
  _lastVisible = true;
}
