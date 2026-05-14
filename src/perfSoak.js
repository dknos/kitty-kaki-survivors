/**
 * Deterministic 60-second soak benchmark — iter 10b deliverable.
 *
 * Captures per-frame render-time samples for `seconds` of game time at a
 * fixed enemy-spawn density (`spawnMul`) and reports {p50, p90, p99, fpsAvg,
 * maxAlive, drawCallsP99}. Validates the BALANCE.md flagged 162-alive case
 * (`spawnMul: 1.5`) AND the iter-9 weekly DOUBLE_SPAWNS case (`spawnMul:
 * 2.0`). The 220-alive cap clamps actual live enemy count; what we measure
 * is the perf cost of the resulting churn.
 *
 * Console-only output (no UI surface — F3 perfHUD already covers live
 * inspection). Outputs to `console.table` AND `navigator.clipboard.write
 * Text(JSON.stringify(...))` so the player can paste the result into a
 * report. `window.kkSoak` is the canonical entry point.
 *
 * Guards:
 *   - REFUSES to run while a real run is active (`state.mode !== 'menu'`).
 *     Wiping `state.time.game` mid-run would corrupt the player's session.
 *   - Restores `state.run.weeklySpawnMul` / `state.run.dailySpawnMul` after
 *     the soak completes (the soak temporarily forces spawn density via the
 *     existing weekly spawn-mul reader so we don't have to patch the spawn
 *     director).
 *   - Logs a "PERF SOAK FAILED" warning when p99 ≥ 25ms so iter 12 perf
 *     hardening can pick the data up. Target: p99 ≤ 22ms at spawnMul 1.5
 *     per the brief.
 */
import { state } from './state.js';

// ──────────────────────────────────────────────────────────────────────────
// Percentile helpers
// ──────────────────────────────────────────────────────────────────────────
function _percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.round((p / 100) * (sortedAsc.length - 1))));
  return sortedAsc[idx];
}

// Tiny deterministic PRNG for repeatable seeds (Mulberry32). Not yet wired
// into the spawn director — soak just forces `state.run.weeklySpawnMul` to
// `spawnMul` and lets the director's existing randomness ride. If iter 12
// needs strict determinism we can swap Math.random for this PRNG.
function _seededRng(seed) {
  let s = 0;
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
  return function rng() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Main entry
// ──────────────────────────────────────────────────────────────────────────
/**
 * @param {Object} opts
 * @param {number} [opts.seconds=60]   Wall-clock soak duration
 * @param {string} [opts.seed='iter10soak']
 * @param {number} [opts.spawnMul=1.0]
 * @returns {Promise<{p50, p90, p99, fpsAvg, maxAlive, drawCallsP99}>}
 */
export function runPerfSoak({ seconds = 60, seed = 'iter10soak', spawnMul = 1.0 } = {}) {
  return new Promise((resolve) => {
    // Guard: only from menu so we never corrupt an active run.
    if (state.mode !== 'menu') {
      console.warn('[perfSoak] kkSoak only runs from menu mode (mode=' + state.mode + '). Return to start screen first.');
      resolve(null);
      return;
    }
    // Stash anything we mutate so the soak is a no-op on completion.
    const prevSpawnMul = (state.run && state.run.weeklySpawnMul != null) ? state.run.weeklySpawnMul : null;
    const prevDailySpawnMul = (state.run && state.run.dailySpawnMul != null) ? state.run.dailySpawnMul : null;
    const prevGameTime = state.time.game;
    const rng = _seededRng(seed); // reserved for future strict-determinism wire-up
    void rng;

    // Force the spawn-mul on state.run (the spawn director reads this).
    if (state.run) {
      state.run.weeklySpawnMul = spawnMul;
      state.run.dailySpawnMul  = spawnMul;
    }

    console.log(`[perfSoak] starting seconds=${seconds} seed=${seed} spawnMul=${spawnMul}`);

    const samples = [];
    const drawSamples = [];
    let maxAlive = 0;
    let startReal = performance.now();
    let lastReal = startReal;
    let frameCount = 0;

    // Use rAF directly so we measure real frame-time + don't depend on the
    // game's main loop ordering. The game's RAF loop continues to run in
    // parallel; we only observe.
    const tick = (now) => {
      const dt = now - lastReal;
      lastReal = now;
      samples.push(dt);
      frameCount++;

      // Live-count + draw-calls snapshot (renderer.info is reset before
      // every frame by main.js).
      const alive = state.enemies && state.enemies.active ? state.enemies.active.length : 0;
      if (alive > maxAlive) maxAlive = alive;
      const calls = (state.renderer && state.renderer.info) ? state.renderer.info.render.calls : 0;
      drawSamples.push(calls);

      const elapsed = (now - startReal) / 1000;
      if (elapsed < seconds) {
        requestAnimationFrame(tick);
      } else {
        // ── Finalize ──
        const sortedFt = samples.slice().sort((a, b) => a - b);
        const sortedDc = drawSamples.slice().sort((a, b) => a - b);
        const p50 = _percentile(sortedFt, 50);
        const p90 = _percentile(sortedFt, 90);
        const p99 = _percentile(sortedFt, 99);
        const fpsAvg = frameCount / ((now - startReal) / 1000);
        const drawCallsP99 = _percentile(sortedDc, 99);

        const result = {
          seconds,
          seed,
          spawnMul,
          p50: +p50.toFixed(2),
          p90: +p90.toFixed(2),
          p99: +p99.toFixed(2),
          fpsAvg: +fpsAvg.toFixed(1),
          maxAlive,
          drawCallsP99,
          frames: frameCount,
        };

        // Restore.
        if (state.run) {
          state.run.weeklySpawnMul = prevSpawnMul;
          state.run.dailySpawnMul  = prevDailySpawnMul;
        }
        // Don't restore state.time.game — soak is from menu, game time stays 0.
        void prevGameTime;

        console.log('[perfSoak] done');
        try { console.table([result]); } catch (_) { console.log(result); }
        try {
          if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(JSON.stringify(result, null, 2));
            console.log('[perfSoak] result JSON copied to clipboard');
          }
        } catch (_) {}

        // Threshold gate: iter 12 perf-hardening trigger if p99 fails target.
        if (result.p99 >= 25) {
          console.warn('[perfSoak] PERF SOAK FAILED — p99 ' + result.p99 + 'ms >= 25ms threshold. Flag for iter 12 perf hardening.');
        } else if (result.p99 >= 22) {
          console.warn('[perfSoak] p99 ' + result.p99 + 'ms exceeds 22ms iter-10b target but below the 25ms hard fail. Tune in iter 12.');
        }

        resolve(result);
      }
    };
    requestAnimationFrame(tick);
  });
}

// Console shortcut. Default args make `kkSoak()` Just Work.
if (typeof window !== 'undefined') {
  window.kkSoak = (opts) => runPerfSoak(opts || {});
}
