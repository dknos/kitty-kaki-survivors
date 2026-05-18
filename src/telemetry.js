/**
 * Per-run telemetry harness — PHASE 4 P4J (2026-05-18, #140).
 *
 * Collects lightweight per-run stats to localStorage `kks_telemetry` so the
 * balance pass (P4I) can read 50+ runs and tune weapon dps curves without
 * a server round-trip. Schema is versioned so future field additions are
 * backwards compatible — old runs keep schemaVersion: 1 and the consumer
 * branches on it.
 *
 * ── Design constraints (per brief) ─────────────────────────────────────────
 *   • Zero per-frame allocations in event() — instrumented call sites fire
 *     thousands of times per run (kill, pickup). The current run record's
 *     counter fields are bumped in place; event objects are NEVER stored
 *     individually. Roll-up shape is built once at endRun().
 *   • Cap localStorage to last 100 runs (FIFO truncate on write). One run
 *     record is ~300 bytes JSON, so the cap stays well under the 5MB origin
 *     quota even with future field additions.
 *   • Static-imported only (no dynamic import() in the hot path — that would
 *     break the module-graph contract per feedback_kks_export_origin_module_break).
 *
 * ── Trigger contract ───────────────────────────────────────────────────────
 *   beginRun({ char, stage, seed, modifiers })
 *     Opens a record. Called from main.js `start()` after applyMetaUpgrades
 *     has stamped state.run.stage. Stamps a started_at wall-clock and a
 *     game_started_at game-clock so duration is recoverable from either.
 *
 *   event(type, payload?)
 *     Lightweight counter bump on the OPEN record. Branches on `type` and
 *     increments a pre-allocated counter (or a sparse object map for
 *     bounded-cardinality keys like weapon ids). Payload is read inline —
 *     never stored as an object. Safe to call before beginRun() (no-ops).
 *
 *   endRun({ outcome, cause })
 *     Closes the record, computes duration, rolls counters into the final
 *     shape, pushes to the persisted list, caps to last 100, writes to
 *     localStorage. Idempotent via the `_telemetryEnded` one-shot stamped
 *     on state.run (mirrors endRunSummary's `_summaryShown` pattern).
 *
 *   tickTelemetry(state)
 *     Per-frame poll mirroring tickEndRunSummary. Detects:
 *       • beginRun edge:  state.started false→true while mode === 'run'
 *       • endRun edge:    state.gameOver === true (death/victory/reaper)
 *                         OR state.run.stats.reaperOutlasted === true
 *     One-shot per run via state.run._telemetryStarted / _telemetryEnded.
 *
 *   exportJSON()
 *     Returns a Blob URL containing the full persisted store. The end-run
 *     summary "Download telemetry JSON" button uses this. Caller owns the
 *     URL.revokeObjectURL() after the download click.
 *
 *   getAll() / clearAll()
 *     Pure read / pure wipe. Used by the smoke harness + future debug UI.
 *
 * ── Schema (versioned) ─────────────────────────────────────────────────────
 *   {
 *     schemaVersion: 1,
 *     runs: [
 *       {
 *         schemaVersion: 1,           // per-run mirror so future migration is row-local
 *         started_at: 1747500000000,  // wall-clock ms (Date.now())
 *         ended_at:   1747500300000,
 *         duration:   300.0,          // game seconds (state.time.game at endRun)
 *         outcome:    'death',        // 'death' | 'clear' | 'reaper' | 'quit'
 *         cause:      null,           // free-form string (e.g. enemy id, 'reaper', etc.)
 *         char:       'kitty',
 *         stage:      'forest',
 *         seed:       null,           // optional, daily/replay seeds only
 *         modifiers:  { hyper: false, endless: false, ... },
 *         counts: {
 *           kills:        420,
 *           picks:        180,        // gems picked
 *           deaths:       1,          // hero deaths (always 0 or 1; multi-death modes future)
 *           levelups:     22,
 *           chests:       3,
 *           weapon_takes: 5,
 *           weapon_evos:  1,
 *           boss_clears:  2,
 *           room_enters:  4,
 *         },
 *         weapons: ['orbitals', 'whip', ...],     // unique ids picked this run
 *         evolves: ['whip'],                       // unique ids evolved this run
 *         room_visits: { glade: 2, mossroot: 1 }, // per-room enter counter
 *         peak_dps_window: 0,                     // 5s rolling DPS peak (reserved; 0 until enemies.js exposes it)
 *       },
 *       ...
 *     ]
 *   }
 */

const STORAGE_KEY = 'kks_telemetry';
const SCHEMA_VERSION = 1;
const MAX_RUNS = 100;

// ── Module state ───────────────────────────────────────────────────────────
// `_current` holds the OPEN run record. Counters live directly on this object
// so event() never allocates. Rolled into the persisted shape at endRun().
//
// Pre-allocated: counters are zeroed in _resetCurrent. weapons/evolves/rooms
// use small plain objects (sparse map → array at flush time).
let _current = null;
let _store   = null;   // cached parsed store (lazy load on first read/write)

// ── Storage helpers ────────────────────────────────────────────────────────

function _loadStore() {
  if (_store) return _store;
  try {
    if (typeof localStorage === 'undefined') {
      _store = { schemaVersion: SCHEMA_VERSION, runs: [] };
      return _store;
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.runs)) {
        _store = {
          schemaVersion: parsed.schemaVersion || SCHEMA_VERSION,
          runs: parsed.runs,
        };
        return _store;
      }
    }
  } catch (e) {
    console.warn('[telemetry] load failed, starting fresh:', e && e.message);
  }
  _store = { schemaVersion: SCHEMA_VERSION, runs: [] };
  return _store;
}

function _saveStore() {
  if (!_store) return;
  try {
    if (typeof localStorage === 'undefined') return;
    // Cap to last N runs — FIFO truncate on write so a player who plays
    // forever doesn't blow the quota. Trim BEFORE stringify.
    if (_store.runs.length > MAX_RUNS) {
      _store.runs = _store.runs.slice(_store.runs.length - MAX_RUNS);
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(_store));
  } catch (e) {
    console.warn('[telemetry] save failed:', e && e.message);
  }
}

function _resetCurrent() {
  _current = {
    schemaVersion: SCHEMA_VERSION,
    started_at:    0,
    game_started_at: 0,
    ended_at:      0,
    duration:      0,
    outcome:       null,
    cause:         null,
    char:          null,
    stage:         null,
    seed:          null,
    modifiers:     null,
    // ── Counters (incremented in-place by event()) ──
    _kills:        0,
    _picks:        0,
    _deaths:       0,
    _levelups:     0,
    _chests:       0,
    _weapon_takes: 0,
    _weapon_evos:  0,
    _boss_clears:  0,
    _room_enters:  0,
    // ── Sparse maps (bounded cardinality: ≤30 weapons, ≤10 rooms) ──
    _weapons:      Object.create(null),
    _evolves:      Object.create(null),
    _rooms:        Object.create(null),
    // ── Peak DPS reserved (0 until enemies.js exposes the rolling window) ──
    _peak_dps_window: 0,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Open a new run record. Safe to call twice — the second call replaces the
 * open record (matches "first beginRun wins per logical run" via the
 * caller's _telemetryStarted one-shot in tickTelemetry).
 *
 * @param {{char?:string, stage?:string, seed?:string|number|null, modifiers?:object}} opts
 */
export function beginRun(opts) {
  _resetCurrent();
  const o = opts || {};
  _current.started_at      = (typeof Date !== 'undefined') ? Date.now() : 0;
  _current.game_started_at = 0;   // game-clock at start is always 0
  _current.char       = o.char  || null;
  _current.stage      = o.stage || null;
  _current.seed       = (o.seed === undefined) ? null : o.seed;
  _current.modifiers  = o.modifiers ? Object.assign({}, o.modifiers) : null;
}

/**
 * Lightweight event hook. ZERO allocation on the hot path: branches on type
 * and bumps a pre-allocated counter, or stamps a key on a sparse map for
 * bounded-cardinality fields. Payload (if any) is read inline — never
 * stored as an object.
 *
 * Recognized types:
 *   'kill'           — payload optional; bumps _kills
 *   'pickup'         — bumps _picks
 *   'death'          — bumps _deaths (hero death)
 *   'levelup'        — bumps _levelups
 *   'chest_open'     — bumps _chests
 *   'weapon_take'    — payload.id (string) ; bumps _weapon_takes + map
 *   'weapon_evolve'  — payload.id (string) ; bumps _weapon_evos + map
 *   'boss_clear'     — bumps _boss_clears
 *   'room_enter'     — payload.id (string) ; bumps _room_enters + per-room counter
 *
 * Unknown types are silently dropped — defensive against forward-compat
 * call sites that ship before the consumer learns them.
 */
export function event(type, payload) {
  if (!_current) return;
  switch (type) {
    case 'kill':         _current._kills++;        return;
    case 'pickup':       _current._picks++;        return;
    case 'death':        _current._deaths++;       return;
    case 'levelup':      _current._levelups++;     return;
    case 'chest_open':   _current._chests++;       return;
    case 'boss_clear':   _current._boss_clears++;  return;
    case 'weapon_take': {
      _current._weapon_takes++;
      const id = payload && payload.id;
      if (id) _current._weapons[id] = (_current._weapons[id] || 0) + 1;
      return;
    }
    case 'weapon_evolve': {
      _current._weapon_evos++;
      const id = payload && payload.id;
      if (id) _current._evolves[id] = (_current._evolves[id] || 0) + 1;
      return;
    }
    case 'room_enter': {
      _current._room_enters++;
      const id = payload && payload.id;
      if (id) _current._rooms[id] = (_current._rooms[id] || 0) + 1;
      return;
    }
    default: return;
  }
}

/**
 * Close the open record, roll counters into the persisted shape, push to
 * the store, cap to last 100, write to localStorage. Idempotent against
 * a missing _current (no-op).
 *
 * @param {{outcome?:'death'|'clear'|'reaper'|'quit', cause?:string|null, duration?:number}} opts
 */
export function endRun(opts) {
  if (!_current) return;
  const o = opts || {};
  _current.outcome  = o.outcome || 'quit';
  _current.cause    = (o.cause === undefined) ? null : o.cause;
  _current.ended_at = (typeof Date !== 'undefined') ? Date.now() : 0;
  // duration: caller passes game-time seconds (state.time.game) so the value
  // is paused-aware. Falls back to wall-clock delta only if not provided.
  if (typeof o.duration === 'number' && o.duration >= 0) {
    _current.duration = o.duration;
  } else if (_current.started_at > 0 && _current.ended_at > 0) {
    _current.duration = (_current.ended_at - _current.started_at) / 1000;
  } else {
    _current.duration = 0;
  }

  // ── Roll up to the persisted shape — single allocation site. ────────────
  const record = {
    schemaVersion: _current.schemaVersion,
    started_at:    _current.started_at,
    ended_at:      _current.ended_at,
    duration:      _current.duration,
    outcome:       _current.outcome,
    cause:         _current.cause,
    char:          _current.char,
    stage:         _current.stage,
    seed:          _current.seed,
    modifiers:     _current.modifiers,
    counts: {
      kills:        _current._kills,
      picks:        _current._picks,
      deaths:       _current._deaths,
      levelups:     _current._levelups,
      chests:       _current._chests,
      weapon_takes: _current._weapon_takes,
      weapon_evos:  _current._weapon_evos,
      boss_clears:  _current._boss_clears,
      room_enters:  _current._room_enters,
    },
    weapons:     Object.keys(_current._weapons),
    evolves:     Object.keys(_current._evolves),
    room_visits: Object.assign({}, _current._rooms),
    peak_dps_window: _current._peak_dps_window || 0,
  };

  const store = _loadStore();
  store.runs.push(record);
  _saveStore();

  _current = null;
}

/**
 * Per-frame poll. Mirrors tickEndRunSummary's idiom: detects the begin/end
 * edges from observable state without invasive hooks. ZERO work on the
 * steady-state frame (both one-shot flags short-circuit).
 *
 * Called from main.js frame() right after tickEndRunSummary so the run
 * record exists by the time endRunSummary builds the export button.
 */
export function tickTelemetry(state) {
  if (!state || !state.run) return;

  // ── begin edge: state.started false→true while mode === 'run' ─────────
  // One-shot per run via state.run._telemetryStarted. Stage / char / modifiers
  // are read from state.run.stage (set by applyMetaUpgrades) and state.modes.
  if (state.started === true && state.mode === 'run'
      && state.run._telemetryStarted !== true) {
    state.run._telemetryStarted = true;
    const stage = state.run.stage;
    beginRun({
      char:      _readSelectedChar(),
      stage:     stage ? (stage.id || null) : null,
      seed:      state.replaySeed ? state.replaySeed.seed : null,
      modifiers: state.modes ? Object.assign({}, state.modes) : null,
    });
  }

  // ── end edge: gameOver true OR reaperOutlasted true ───────────────────
  // One-shot per run via state.run._telemetryEnded. Outcome derived from
  // the same triggers endRunSummary uses; cause is left null for now (the
  // brief asks for it but doesn't constrain the value — leave the hook
  // open for future enemy-id annotation).
  if (state.run._telemetryEnded === true) return;

  let outcome = null;
  if (state.gameOver === true) {
    if (state.victory === true) outcome = 'clear';
    else {
      const stats = state.run.stats || {};
      outcome = (typeof stats.reaperKillTime === 'number') ? 'reaper' : 'death';
    }
  } else {
    const stats = state.run.stats || {};
    if (stats.reaperOutlasted === true) outcome = 'clear';
  }

  if (outcome) {
    state.run._telemetryEnded = true;
    // For death outcomes, stamp the death counter so the count line matches
    // the outcome even if the kill chokepoint hook didn't fire (defensive).
    if (outcome === 'death' || outcome === 'reaper') {
      // event() is a no-op if _current is missing; safe.
      if (_current && _current._deaths === 0) _current._deaths = 1;
    }
    endRun({
      outcome,
      cause: null,
      duration: (state.time && typeof state.time.game === 'number') ? state.time.game : 0,
    });
  }
}

/**
 * Return a Blob URL containing the FULL persisted store (all runs). Caller
 * owns the URL lifecycle — call URL.revokeObjectURL(url) after the
 * download anchor click. Returns null in environments without Blob/URL.
 */
export function exportJSON() {
  try {
    if (typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
      return null;
    }
    const store = _loadStore();
    const text  = JSON.stringify(store, null, 2);
    const blob  = new Blob([text], { type: 'application/json' });
    return URL.createObjectURL(blob);
  } catch (e) {
    console.warn('[telemetry] exportJSON failed:', e && e.message);
    return null;
  }
}

/** Pure read accessor for the smoke harness and debug UI. */
export function getAll() {
  return _loadStore();
}

/** Pure wipe — drops the in-memory cache + clears the localStorage key. */
export function clearAll() {
  _store = { schemaVersion: SCHEMA_VERSION, runs: [] };
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY); }
  catch (_) {}
}

/**
 * Reads the meta selectedChar / selectedAvatar without a static import on
 * meta.js — keeps this module dependency-free so the smoke harness can
 * import it in isolation. Best-effort: reads from localStorage directly
 * using meta.js's known SAVE_KEY pattern (kk-save-v2 / kk-save).
 */
function _readSelectedChar() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const rawV2 = localStorage.getItem('kk-survivors-meta-v2');
    if (rawV2) {
      const p = JSON.parse(rawV2);
      return (p && (p.selectedAvatar || p.selectedChar)) || null;
    }
    const rawV1 = localStorage.getItem('kk-survivors-meta-v1');
    if (rawV1) {
      const p = JSON.parse(rawV1);
      return (p && (p.selectedAvatar || p.selectedChar)) || null;
    }
  } catch (_) {}
  return null;
}

/** Suggested download filename for the export button. */
export function suggestFilename() {
  const d = (typeof Date !== 'undefined') ? new Date() : null;
  if (!d) return 'kks_telemetry.json';
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  return `kks_telemetry_${yyyy}-${mm}-${dd}.json`;
}
