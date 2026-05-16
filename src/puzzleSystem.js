/**
 * Forest Expansion v0.1 — Generic Puzzle System (Cohort 2, FE-C2).
 *
 * Single-active-puzzle controller. Concrete puzzles (Cohort 3C — flow_weaver,
 * harmonic_alignment, prism_lock) register themselves via registerPuzzle(),
 * then the integration agent (Cohort 3A) calls startPuzzle() from a hero
 * interact-key handler when the player presses E inside a puzzle room.
 *
 * Lifecycle:
 *   register → start → tick (loop) → win | fail | timeout → cleanup
 *
 * State machine touch points (per docs/FOREST_EXPANSION_PLAN.md §3):
 *   - state.run.activePuzzle: puzzle id while active, null otherwise
 *   - state.run.roomState:    'PUZZLE_ACTIVE' while a puzzle is running,
 *                             returns to 'IN_ROOM' on end (win/fail/timeout)
 *   - state.run.forestPuzzlesSolved[id]: per-run win flag (separate from
 *                             meta.forestPuzzlesSolved which persists across runs)
 *
 * Persistence (on win):
 *   markForestPuzzleSolved(id) — lifetime puzzle-solved flag
 *   unlockForestWeapon(weaponId) — adds weapon to profile-wide unlock pool
 *
 * Hard constraints (FOREST_EXPANSION_PLAN §5/§8):
 *   - 120s hard timer cap, even if puzzleDef.timeLimit is missing or larger
 *     (prevents softlocks if a concrete puzzle ships a bad timeLimit)
 *   - Alloc-free hot path: tick uses no per-frame closures or array allocs
 *   - No THREE import here (this is a logic module; visuals live in the
 *     concrete puzzle modules)
 *
 * Not handled here (Cohort 3 scope):
 *   - HUD timer rendering (Cohort 3A reads getPuzzleTimeRemaining())
 *   - Boss-spawn forced return (Cohort 3A calls endPuzzleEarly())
 *   - Player-death cleanup (Cohort 3A calls endPuzzleEarly())
 */
import { state } from './state.js';
import { markForestPuzzleSolved, unlockForestWeapon } from './meta.js';
import { sfx } from './audio.js';

/**
 * @typedef {Object} PuzzleDef
 * @property {string} id                              Unique puzzle id, must match FOREST_ROOMS[roomId].puzzle
 * @property {string} roomId                          Room id from FOREST_ROOMS where this puzzle lives
 * @property {number} [timeLimit]                     Seconds until auto-fail (default 90, hard-capped at 120)
 * @property {string} [weaponReward]                  Weapon id granted on win (passed to unlockForestWeapon)
 * @property {(state:any) => void} [onStart]          Called once when startPuzzle succeeds
 * @property {(dt:number, state:any) => void} [onTick] Called every frame while active
 * @property {(state:any) => void} [onWin]            Called after _win bookkeeping + before cleanup
 * @property {(state:any) => void} [onFail]           Called before cleanup on fail/timeout
 * @property {(state:any) => boolean} [isWinCondition]  Polled each tick; true → _win
 * @property {(state:any) => boolean} [isFailCondition] Polled each tick; true → _fail
 * @property {(state:any) => void} [cleanup]          Called after onWin/onFail to tear down FX/entities
 */

/** Absolute upper bound on puzzle duration. Anti-softlock per FE plan §5 risk 5. */
const HARD_TIMER_CAP_SECS = 120;

/** Fallback timeLimit if a puzzleDef omits it. Halfway under hard cap. */
const DEFAULT_TIME_LIMIT_SECS = 90;

/**
 * Registry of all puzzles known to the system. Each concrete puzzle module
 * (Cohort 3C) calls registerPuzzle(def) at import time. The system never
 * mutates these defs after registration.
 *
 * @type {Record<string, PuzzleDef>}
 */
const _registry = Object.create(null);

/**
 * Active puzzle bookkeeping. _activeDef is the resolved PuzzleDef (so we
 * don't have to re-lookup in the hot tick loop), _elapsed counts seconds
 * since startPuzzle, _limit is the resolved per-instance hard-capped limit.
 * All three are reset together by _clearActive().
 */
let _activeDef = null;
let _elapsed = 0;
let _limit = 0;

/**
 * Register a concrete puzzle definition. Last write wins on id collision
 * (allows hot-reload during dev). Validates the id field only; everything
 * else is treated as optional and missing callbacks are no-ops.
 *
 * @param {PuzzleDef} puzzleDef
 */
export function registerPuzzle(puzzleDef) {
  if (!puzzleDef || typeof puzzleDef.id !== 'string' || !puzzleDef.id) {
    // eslint-disable-next-line no-console
    console.warn('[puzzleSystem] registerPuzzle: missing or invalid id');
    return;
  }
  _registry[puzzleDef.id] = puzzleDef;
}

/**
 * Begin a puzzle. Returns false if no puzzle is registered under puzzleId
 * or another puzzle is already active (caller should endPuzzleEarly first
 * if they want to swap). Sets state.run.activePuzzle + state.run.roomState
 * and starts the internal countdown.
 *
 * @param {string} puzzleId
 * @returns {boolean} true if started
 */
export function startPuzzle(puzzleId) {
  if (_activeDef) return false;
  const def = _registry[puzzleId];
  if (!def) {
    // eslint-disable-next-line no-console
    console.warn('[puzzleSystem] startPuzzle: unknown puzzle id', puzzleId);
    return false;
  }
  _activeDef = def;
  _elapsed = 0;
  // Resolve once at start, not in tick. Hard cap is mandatory per plan §5
  // even if the puzzle ships a bad timeLimit (e.g. undefined, 0, or 9999).
  const wanted = (typeof def.timeLimit === 'number' && def.timeLimit > 0)
    ? def.timeLimit
    : DEFAULT_TIME_LIMIT_SECS;
  _limit = Math.min(wanted, HARD_TIMER_CAP_SECS);

  state.run.activePuzzle = puzzleId;
  state.run.roomState = 'PUZZLE_ACTIVE';

  if (typeof def.onStart === 'function') {
    try { def.onStart(state); } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[puzzleSystem] onStart threw for', puzzleId, e);
    }
  }
  return true;
}

/**
 * Run one frame of the active puzzle. No-op when nothing is active so the
 * main run loop can call this unconditionally. Order of checks matters:
 * win is polled BEFORE fail/timeout so a player who completes on the same
 * frame the timer expires still gets credit.
 *
 * @param {number} dt seconds since last frame
 */
export function tickPuzzleSystem(dt) {
  const def = _activeDef;
  if (!def) return;

  if (typeof def.onTick === 'function') {
    try { def.onTick(dt, state); } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[puzzleSystem] onTick threw for', def.id, e);
    }
  }

  // Win first — if a puzzle finishes on the same frame as timeout, the player
  // earned it. Use try/catch so a buggy predicate can't softlock the system.
  let won = false;
  if (typeof def.isWinCondition === 'function') {
    try { won = !!def.isWinCondition(state); } catch (_) { won = false; }
  }
  if (won) { _win(def); return; }

  let failed = false;
  if (typeof def.isFailCondition === 'function') {
    try { failed = !!def.isFailCondition(state); } catch (_) { failed = false; }
  }
  if (failed) { _fail(def); return; }

  _elapsed += dt;
  if (_elapsed >= _limit) {
    _timeout(def);
  }
}

/**
 * Force-end the in-flight puzzle as a fail (no unlock, no save). Called by
 * Cohort 3A on:
 *   - player death mid-puzzle
 *   - boss-spawn force-return (15-min rule)
 *   - manual escape (if we ever wire one)
 *
 * Safe to call when no puzzle is active (no-op).
 */
export function endPuzzleEarly() {
  if (!_activeDef) return;
  _fail(_activeDef);
}

/**
 * Inspector for HUD / integration code.
 *
 * @returns {?string} active puzzle id, or null
 */
export function getActivePuzzleId() {
  return _activeDef ? _activeDef.id : null;
}

/**
 * Seconds remaining on the active puzzle timer, clamped to [0, _limit].
 * Returns 0 when no puzzle is active so HUD can render a stable "—"
 * without branching.
 *
 * @returns {number}
 */
export function getPuzzleTimeRemaining() {
  if (!_activeDef) return 0;
  const rem = _limit - _elapsed;
  return rem > 0 ? rem : 0;
}

// ── internal ────────────────────────────────────────────────────────────────

/**
 * Win path. Marks the puzzle solved (per-run + lifetime), grants the weapon
 * (if any), fires SFX, then hands off to the puzzle's own onWin/cleanup.
 * Active state is cleared LAST so user callbacks still see activePuzzle id
 * if they peek at state during onWin.
 *
 * @param {PuzzleDef} def
 */
function _win(def) {
  // Per-run flag (transient — survives until run reset)
  if (!state.run.forestPuzzlesSolved || typeof state.run.forestPuzzlesSolved !== 'object') {
    state.run.forestPuzzlesSolved = {};
  }
  state.run.forestPuzzlesSolved[def.id] = true;

  // Lifetime flag + weapon unlock (both persist to localStorage)
  try { markForestPuzzleSolved(def.id); } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[puzzleSystem] markForestPuzzleSolved threw', e);
  }
  if (typeof def.weaponReward === 'string' && def.weaponReward) {
    try { unlockForestWeapon(def.weaponReward); } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[puzzleSystem] unlockForestWeapon threw', e);
    }
  }

  // Celebratory chime — reuse the existing evolution unlock SFX so the
  // audio bus stays consistent. sfx.* keys may be missing in tests/headless
  // smoke runs, so guard with the standard `&&` idiom used elsewhere.
  try { sfx.evolutionChime && sfx.evolutionChime(); } catch (_) {}

  if (typeof def.onWin === 'function') {
    try { def.onWin(state); } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[puzzleSystem] onWin threw for', def.id, e);
    }
  }
  _runCleanup(def);
  _clearActive();
}

/**
 * Fail path. NO meta persistence, NO weapon unlock. Returns control to the
 * room (player keeps wandering) and tears down puzzle FX. Used by both
 * isFailCondition and endPuzzleEarly.
 *
 * @param {PuzzleDef} def
 */
function _fail(def) {
  try { sfx.uiError && sfx.uiError(); } catch (_) {}

  if (typeof def.onFail === 'function') {
    try { def.onFail(state); } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[puzzleSystem] onFail threw for', def.id, e);
    }
  }
  _runCleanup(def);
  _clearActive();
}

/**
 * Timeout path. Identical to fail semantically — no unlock, no persistence —
 * but kept as a named function so a future requirement to differentiate
 * (e.g. "timeout shows hint, fail doesn't") has a single seam.
 *
 * @param {PuzzleDef} def
 */
function _timeout(def) {
  _fail(def);
}

/**
 * Best-effort cleanup. Each concrete puzzle owns its FX entities and is
 * responsible for disposing them here. Try/catch so one buggy cleanup
 * doesn't leak state into the next startPuzzle attempt.
 *
 * @param {PuzzleDef} def
 */
function _runCleanup(def) {
  if (typeof def.cleanup !== 'function') return;
  try { def.cleanup(state); } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[puzzleSystem] cleanup threw for', def.id, e);
  }
}

/**
 * Reset module + game state so the next startPuzzle call has a clean slate.
 * roomState returns to 'IN_ROOM' so spawnDirector (Cohort 3A) knows to resume
 * its smoothing ramp. activePuzzle nulled so getActivePuzzleId reports honestly.
 */
function _clearActive() {
  _activeDef = null;
  _elapsed = 0;
  _limit = 0;
  state.run.activePuzzle = null;
  state.run.roomState = 'IN_ROOM';
}

// ── test/debug surface ──────────────────────────────────────────────────────
// Internal hooks exposed for tools/smoke-* and devtools. Not part of the
// public game API; underscore prefix matches the existing convention in
// forestAmber.js (_debugEntities / _debugHotspots).

export function _debugRegistry() { return Object.assign({}, _registry); }
export function _debugActive() {
  return _activeDef ? { id: _activeDef.id, elapsed: _elapsed, limit: _limit } : null;
}
