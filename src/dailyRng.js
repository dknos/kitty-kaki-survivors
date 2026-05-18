/**
 * P4E Daily seed PRNG (mulberry32).
 *
 * Provides deterministic per-day randomness for the Daily challenge mode.
 * Seeded once at run-start when `state.modes.daily === true` (from main.js
 * applyMetaUpgrades), cleared at run-end teardown so non-daily runs keep
 * native Math.random behavior.
 *
 * The acceptance test (tools/smoke-p4e-daily.mjs) verifies that two browser
 * sessions seeded with the same YYYYMMDD produce identical first-N spawn
 * positions out of the spawn director. To make that work, the director's
 * spawn-decision Math.random() calls (angle, ring jitter, tier weighted pick,
 * horde center/arc) are routed through `rand()` below. Cosmetic / per-mesh
 * jitter (hue, animation phase, ranged cooldown start in enemies.js) stays on
 * native Math.random — those don't influence spawn position and would
 * over-constrain the seam.
 *
 * Hard rule: when not seeded, `rand()` is a transparent alias for
 * Math.random(). This is the single seam — callers don't branch on mode.
 *
 * mulberry32 reference: github.com/bryc/code/blob/master/jshash/PRNGs.md
 *   - 32-bit state, well-distributed, ~2^32 period
 *   - safe with seed=0 only after the `|| 1` guard below (mulberry32
 *     degenerates to a constant stream when state is 0)
 */

let _state = 0;
let _active = false;
// Per-test diagnostic — counts calls to rand() since last seedDaily(). Read-only
// counter; smoke tests use this to detect divergent consumption between two
// browser sessions. Production code MUST NOT rely on this value.
let _callCount = 0;

/** Number of `rand()` calls since the most recent seedDaily(). Tests only. */
export function _dbgCallCount() { return _callCount; }

/**
 * Seed the daily PRNG from a YYYYMMDD integer (e.g. 20260518). The `|| 1`
 * guard prevents the all-zeros degenerate state. Calling seedDaily again
 * mid-run resets the stream — main.js callers should only invoke once per run.
 */
export function seedDaily(yyyymmdd) {
  _state = (yyyymmdd >>> 0) || 1;
  _active = true;
  _callCount = 0;
}

/**
 * Clear the seeded state and fall back to native Math.random. Called from
 * _teardownActiveRun (run end) and from initSpawnDirector (boot / restart
 * recovery) so a crashed daily run can't poison a subsequent non-daily run.
 */
export function clearDailySeed() {
  _active = false;
  _state = 0;
}

/** Whether the daily seed is currently active. Used by smoke tests. */
export function isDailySeeded() {
  return _active;
}

/**
 * Raw mulberry32 step — returns a uniform float in [0, 1). Callers should
 * prefer `rand()` (auto-fallback to Math.random when not seeded); this is
 * exposed for tests that want to assert determinism without checking the
 * active flag.
 */
export function dailyRand() {
  let t = (_state = (_state + 0x6D2B79F5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Drop-in replacement for Math.random(). Routes through the daily PRNG when
 * seeded, falls back to native Math.random() otherwise. Use at any spawn-
 * decision seam where deterministic per-day replay matters.
 */
export function rand() {
  if (_active) { _callCount++; return dailyRand(); }
  return Math.random();
}

/**
 * Compute the YYYYMMDD integer seed for the current local date. Centralized
 * so smoke / UI / main.js all derive the same integer.
 *
 * Local date intentionally — daily mode rolls over at the player's midnight
 * (matches meta.todayKey() which is also local). UTC would create a confusing
 * mismatch between the "today's seed" label and the dailyChallengeConfig
 * character/modifier that drives the run.
 */
export function todaySeedInt(date) {
  const d = date || new Date();
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return y * 10000 + m * 100 + day;
}
