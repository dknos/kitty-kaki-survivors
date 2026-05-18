#!/usr/bin/env node
/**
 * PHASE 4 P4D (#143) — NG+ modifiers smoke.
 *
 * Boots the game in Playwright Chromium and verifies the three P4D NG+
 * modifier flags each produce the documented gameplay effect when toggled
 * in isolation. Pre-arms `meta.unlockedNgPlus = true` so the gate is open
 * for all four scenarios (baseline + each flag).
 *
 * The four scenarios share one browser context (sequential, not parallel —
 * shared meta + state would race). Each scenario:
 *   1. Sets meta (unlocks NG+, flips the relevant opt, clears the others).
 *   2. Reloads the page so applyMetaUpgrades re-snapshots state.modes.
 *   3. Forces selectedStage=forest, calls window.kkStartRun().
 *   4. Waits SAMPLE_MS while the spawn director runs.
 *   5. Reads the relevant counters from window.kkState.
 *
 * Counters:
 *   - mirror: state.enemies.active.length (alive cap)
 *   - twin:   number of isMiniBoss/isFinalBoss enemies in active list
 *             (drives the twin-pair assertion — at least 2 boss-flagged
 *              entities present after we force a miniboss spawn via direct
 *              state.time.game push)
 *   - half:   count of drops returned from dropForestPickup over N calls
 *
 * For twin, we force-time-advance to past STAGE.miniBossSchedule[0] (the
 * first miniboss tick). For half-pickup, we directly call dropForestPickup
 * N=1000 times and count non-null returns.
 *
 * Strategy notes:
 *   - No npm install. Playwright + Chromium expected at the shared cache
 *     paths, same as smoke-p4j-telemetry.mjs / smoke-p4g-mixer.mjs.
 *   - state.modes flags are mirrored from meta inside applyMetaUpgrades
 *     (main.js ~line 1219 region), which runs at run start. We MUST reload
 *     between scenarios so a fresh meta snapshot is applied (in-session
 *     setOption only writes meta; state.modes is run-scoped).
 *   - mirror tolerance ±15% on the cap — D(t) curve + RNG horde phase makes
 *     a tight assertion unreliable. We assert mirror > baseline * 1.20
 *     (well inside the +50% lever, well outside RNG noise) AND mirror at
 *     least matches the lower band of (baseline * 1.30).
 *
 * Run: node tools/smoke-p4d-ngplus.mjs
 *
 * Port: 8778 (after 8777 a11y, 8776 mixer, 8775 telemetry, 8773 forest-v2).
 */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8778);
const BOOT_TIMEOUT_MS = 60000;
const SAMPLE_MS = 5000;
const PICKUP_TRIALS = 200;

// ── Static server (lifted from smoke-p4h-a11y) ─────────────────────────────
function mime(p) {
  if (p.endsWith('.js'))   return 'application/javascript';
  if (p.endsWith('.mjs'))  return 'application/javascript';
  if (p.endsWith('.html')) return 'text/html';
  if (p.endsWith('.css'))  return 'text/css';
  if (p.endsWith('.json')) return 'application/json';
  if (p.endsWith('.glb'))  return 'model/gltf-binary';
  if (p.endsWith('.png'))  return 'image/png';
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
  if (p.endsWith('.svg'))  return 'image/svg+xml';
  if (p.endsWith('.mp3'))  return 'audio/mpeg';
  if (p.endsWith('.wav'))  return 'audio/wav';
  if (p.endsWith('.ogg'))  return 'audio/ogg';
  return 'application/octet-stream';
}
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const full = path.join(ROOT, rel);
  if (!full.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found: ' + rel); return; }
    res.writeHead(200, { 'Content-Type': mime(full), 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

const PLAY_PATH = '/home/nemoclaw/node_modules/playwright';
const PLAYWRIGHT_EXEC = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

function fail(msg) { console.error('[smoke-p4d] FAIL: ' + msg); }

async function waitBoot(page) {
  await page.waitForFunction(
    () => typeof window.kkStartRun === 'function' && typeof window.kkPerfForceOn === 'function',
    null,
    { timeout: BOOT_TIMEOUT_MS },
  );
}

/**
 * Reload, set flags, start run, sample enemy density for SAMPLE_MS.
 * Returns { aliveAvg, aliveMax, bossCount, miniBossCount, finalBossCount }.
 */
async function runSpawnScenario(page, flags, opts = {}) {
  const wantBoss = !!opts.wantBoss;
  // Stamp the meta FIRST, then reload — boot's applyMetaUpgrades at init runs
  // exactly once; the per-run start() skips the re-apply when weapons.length
  // is already populated by init. So we need the meta on disk before the boot
  // path reads it.
  await page.evaluate(async (flags) => {
    const meta = await import('./src/meta.js');
    meta.setOption('unlockedNgPlus',  true);
    meta.setOption('selectedStage',   'forest');
    meta.setOption('optNgMirror',     !!flags.mirror);
    meta.setOption('optNgTwin',       !!flags.twin);
    meta.setOption('optNgHalfPickup', !!flags.half);
    // Make sure no competing modes are on (daily / weekly / hyper / bossRush
    // would gate the NG+ mirror in applyMetaUpgrades).
    meta.setOption('optHyper',        false);
    meta.setOption('optEndless',      false);
    meta.setOption('optBossRush',     false);
    meta.setOption('optWeekly',       false);
    meta.setOption('optDaily',        false);
  }, flags);
  await page.reload({ waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
  await waitBoot(page);
  await page.evaluate(() => {
    if (typeof window.kkPerfForceOn === 'function') window.kkPerfForceOn();
    window.kkStartRun();
  });
  await page.waitForFunction(
    () => !!window.kkState && !!window.kkState.run && !!window.kkState.enemies,
    null,
    { timeout: BOOT_TIMEOUT_MS },
  );

  // Headless rAF runs at ~1Hz with realDt clamped to 50ms, so 5s of wall
  // time only advances state.time.game by ~0.2s — not enough for the
  // director to clear its ramp. We drive the spawn director directly via a
  // controlled stride: push state.time.game forward in 0.15s increments
  // (matches SPAWN.tickIntervalSec) and call tickSpawnDirector N times.
  //
  // For wantBoss runs we additionally start at t=300s so we're well past
  // STAGE.miniBossSchedule[0]=240 — the schedule fires inside the director
  // tick once `state.time.game >= due`.
  const startT = wantBoss ? 300 : 30;
  const driveResult = await page.evaluate(async (startT) => {
    const s = window.kkState;
    if (!s || !s.time) return { ok: false, reason: 'kkState missing' };
    const mod = await import('./src/spawnDirector.js');
    if (typeof mod.tickSpawnDirector !== 'function') {
      return { ok: false, reason: 'tickSpawnDirector not exported' };
    }
    s.time.game = startT;
    // 200 ticks × 0.15s = 30s of director time. With SPAWN.tickIntervalSec
    // = 0.15s, every call is a guaranteed tick (we feed dt = 0.15s).
    const samples = [];
    for (let i = 0; i < 200; i++) {
      s.time.game += 0.15;
      mod.tickSpawnDirector(0.15);
      if (i % 10 === 0) samples.push(s.enemies.active.length);
    }
    return {
      ok: true,
      samples,
      finalAlive: s.enemies.active.length,
      finalGameT: s.time.game,
    };
  }, startT);
  if (!driveResult.ok) {
    console.log('    [drive ERR]', driveResult.reason);
    return { aliveAvg: 0, aliveMax: 0, bossCount: 0, miniBossCount: 0, finalBossCount: 0, twinCount: 0 };
  }
  const samples = driveResult.samples || [];
  const aliveMax = samples.length ? Math.max(...samples) : 0;
  const aliveAvg = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
  console.log('    [drive] startT=' + startT
    + ', finalGameT=' + driveResult.finalGameT.toFixed(1)
    + ', finalAlive=' + driveResult.finalAlive);

  const bossSnap = await page.evaluate(() => {
    const s = window.kkState;
    if (!s || !s.enemies || !s.enemies.active) {
      return { boss: 0, mini: 0, final: 0, twin: 0 };
    }
    let boss = 0, mini = 0, final = 0, twin = 0;
    for (const e of s.enemies.active) {
      if (!e) continue;
      if (e.isMiniBoss)  { boss++; mini++; }
      if (e.isFinalBoss) { boss++; final++; }
      if (e._isTwin)     { twin++; }
    }
    return { boss, mini, final, twin };
  });

  return {
    aliveAvg, aliveMax,
    bossCount: bossSnap.boss,
    miniBossCount: bossSnap.mini,
    finalBossCount: bossSnap.final,
    twinCount: bossSnap.twin,
  };
}

/**
 * Half-pickup gate probe (deterministic). The challenge: dropForestPickup
 * has multiple branches (bomb / magnet / chicken / no-spawn) and pool caps
 * that saturate quickly, so a naive call-count probe drowns the gate signal
 * in pool-exhaustion noise. Instead we exercise the gate path directly by
 * monkey-patching `Math.random` to a deterministic sequence:
 *   - Even calls return 0.10 (gate's `< 0.5` check → DENY when gate on)
 *   - Odd  calls return 0.90 (gate's `< 0.5` check → PASS when gate on)
 * Then rngRoll=0.99 (NO branch — natural return null). We then measure how
 * many of N calls returned null. Without the gate: all N return null
 * (natural return path). With the gate: also all N return null. That fails
 * to differentiate.
 *
 * BETTER: feed rngRoll=0.005 (BOMB branch, always-spawn before gate).
 * Without gate, every call attempts _spawnBomb (pool-limited to 16 truthy
 * then 984 null = 0.984 null rate). With gate, ~50% return null at the gate
 * (500), the remaining 500 attempt _spawnBomb (pool empty so 16 truthy + 484
 * null) = (500 + 484) / 1000 = 0.984 null rate. Identical.
 *
 * CORRECT approach: reset the bomb pool between every call so the BOMB
 * branch is never pool-exhausted. The pool reset is via the module's
 * disposeForestPickups + loadForestPickups, too heavy per call.
 *
 * Pragmatic alternative: rather than counting null returns, count the
 * number of times dropForestPickup actually entered the spawn-attempt
 * branch (i.e. returned ANY value — null OR truthy — past the gate). We
 * instrument by wrapping `_spawnBomb` (the path rngRoll=0.005 dispatches
 * to). With gate OFF: every call reaches _spawnBomb (N invocations). With
 * gate ON: ~50% reach it (N/2 invocations). We compare invocation counts.
 *
 * Implementation: wrap dropForestPickup itself with a "did we get past the
 * gate" counter. Since the gate is the ONLY pre-spawn null return added by
 * P4D, we can detect it by toggling the meta flag and re-counting: the
 * delta in pre-gate-passed invocations IS the gate's effect.
 *
 * Cleanest: just measure how many calls return null WHEN rngRoll>=0.07
 * (always-null branch). Wait — without the gate, ALL of those return null
 * (1.0 null rate). With the gate, ALL of those still return null (1.0).
 * No signal.
 *
 * Final design: use rngRoll=0.005 (bomb) and reset the bomb pool by
 * reaching into the module's internal `_bPhase` Uint8Array after each call
 * to free the slot. That gives a clean "every call tries to spawn" baseline.
 * If we can access _bPhase via the module... we can't, it's not exported.
 *
 * SIMPLEST WORKING APPROACH: time-based. With gate OFF, dropForestPickup
 * with rngRoll=0.005 returns truthy ONCE per slot-free state. Drain the pool
 * once, then for the next N calls everyone returns null. With gate ON, of N
 * pool-drain-then-N calls, the gate denies ~50% pre-attempt — meaning the
 * _bPhase pool also drains slower. Tricky to measure.
 *
 * CHOSEN: measure via _spawnBomb wrap from the module side using a
 * page.evaluate that monkey-patches the module's exports. Easier: pass
 * rngRoll=0.999 (always natural-null) and call with gate=on/off; the gate
 * is the ONLY active code branch difference. But both still return null.
 *
 * REAL FIX (just verified by reading code): rngRoll=0.005 ALWAYS hits the
 * `if (rngRoll < 0.01)` branch which calls `_spawnBomb`. _spawnBomb returns
 * true when a slot is free. To prevent pool exhaustion, we call
 * `disposeForestPickups` + `loadForestPickups` between BATCHES. With one
 * call per batch and a clean pool each batch, every call WITHOUT the gate
 * returns 'pickup_bomb', and every call WITH the gate returns null half the
 * time (rough 50/50). We do N batches → N possible truthies → compare.
 */
async function probeHalfPickup(page, flags) {
  // Stamp meta first, then reload — same boot/apply ordering as
  // runSpawnScenario. The half-pickup gate reads state.modes.ngHalfPickup
  // which is mirrored from meta inside applyMetaUpgrades.
  await page.evaluate(async (flags) => {
    const meta = await import('./src/meta.js');
    meta.setOption('unlockedNgPlus',  true);
    meta.setOption('selectedStage',   'forest');
    meta.setOption('optNgMirror',     false);
    meta.setOption('optNgTwin',       false);
    meta.setOption('optNgHalfPickup', !!flags.half);
    meta.setOption('optHyper',        false);
    meta.setOption('optEndless',      false);
    meta.setOption('optBossRush',     false);
    meta.setOption('optWeekly',       false);
    meta.setOption('optDaily',        false);
  }, flags);
  await page.reload({ waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
  await waitBoot(page);
  await page.evaluate(() => {
    if (typeof window.kkPerfForceOn === 'function') window.kkPerfForceOn();
    window.kkStartRun();
  });
  await page.waitForFunction(
    () => !!window.kkState && !!window.kkState.run && !!window.kkState.enemies,
    null,
    { timeout: BOOT_TIMEOUT_MS },
  );
  // Brief settle so loadForestPickups has fired and the pickup module is
  // _loaded:true (dropForestPickup short-circuits when not loaded).
  await new Promise((r) => setTimeout(r, 1500));

  // Reset pool by dispose+reload BEFORE each call to keep the bomb branch
  // unconstrained. Use rngRoll=0.005 to always hit the bomb branch — with
  // a clean pool, the spawn always succeeds. The ONLY way the call returns
  // null is the new P4D gate firing. So null-rate cleanly maps to gate
  // denial probability.
  return await page.evaluate(async (n) => {
    const mod = await import('./src/forestPickups.js');
    if (typeof mod.dropForestPickup !== 'function') return { error: 'dropForestPickup not exported' };
    if (typeof mod.loadForestPickups !== 'function' || typeof mod.disposeForestPickups !== 'function') {
      return { error: 'pickup module is missing load/dispose surface' };
    }
    const scene = window.kkState && window.kkState.scene;
    let nullReturns = 0;
    let truthyReturns = 0;
    for (let i = 0; i < n; i++) {
      mod.disposeForestPickups(scene);
      mod.loadForestPickups(scene, window.kkState);
      const pos = { x: (i % 50) - 25, z: (Math.floor(i / 50) % 50) - 25 };
      const r = mod.dropForestPickup(pos, 0.005, 1.0);
      if (r === null || r === undefined) nullReturns++;
      else truthyReturns++;
    }
    return { nullReturns, truthyReturns };
  }, PICKUP_TRIALS);
}

async function main() {
  if (!fs.existsSync(PLAY_PATH)) {
    console.error('[smoke-p4d] FAIL: playwright not installed at ' + PLAY_PATH);
    console.error('[smoke-p4d] Per CLAUDE.md, smoke tools NEVER run npm install.');
    process.exit(2);
  }
  if (!fs.existsSync(PLAYWRIGHT_EXEC)) {
    console.error('[smoke-p4d] FAIL: chromium binary not found at ' + PLAYWRIGHT_EXEC);
    process.exit(2);
  }
  console.log('[smoke-p4d] playwright check: OK');

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('[smoke-p4d] server on http://127.0.0.1:' + PORT);

  const { chromium } = require(PLAY_PATH);
  const browser = await chromium.launch({
    executablePath: PLAYWRIGHT_EXEC,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
    ],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();

  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[console.error]', msg.text());
  });
  page.on('pageerror', (e) => {
    pageErrors.push(e.message);
    console.error('[pageerror]', e.message);
  });

  const failures = [];

  try {
    const url = 'http://127.0.0.1:' + PORT + '/index.html?smoke=1';
    await page.goto(url, { waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
    await waitBoot(page);
    console.log('[smoke-p4d] boot OK');

    // ─── Assertion 0: meta exposes the NG+ keys ─────────────────────────
    console.log('\n========== ASSERTION 0: meta NG+ key shape ==========');
    const metaShape = await page.evaluate(async () => {
      const m = await import('./src/meta.js');
      const d = m.getMeta();
      return {
        mirror:  typeof d.optNgMirror,
        twin:    typeof d.optNgTwin,
        half:    typeof d.optNgHalfPickup,
        unlock:  typeof d.unlockedNgPlus,
      };
    });
    console.log('  optNgMirror:     ' + metaShape.mirror);
    console.log('  optNgTwin:       ' + metaShape.twin);
    console.log('  optNgHalfPickup: ' + metaShape.half);
    console.log('  unlockedNgPlus:  ' + metaShape.unlock);
    if (metaShape.mirror !== 'boolean') failures.push('optNgMirror not boolean: ' + metaShape.mirror);
    if (metaShape.twin   !== 'boolean') failures.push('optNgTwin not boolean: ' + metaShape.twin);
    if (metaShape.half   !== 'boolean') failures.push('optNgHalfPickup not boolean: ' + metaShape.half);
    if (metaShape.unlock !== 'boolean') failures.push('unlockedNgPlus not boolean: ' + metaShape.unlock);

    // ─── Assertion 1: BASELINE — all flags OFF ──────────────────────────
    console.log('\n========== ASSERTION 1: baseline (all flags OFF) ==========');
    const baseline = await runSpawnScenario(page, { mirror: false, twin: false, half: false });
    console.log('  alive avg=' + baseline.aliveAvg.toFixed(1)
      + ', max=' + baseline.aliveMax
      + ', boss=' + baseline.bossCount
      + ', twin=' + baseline.twinCount);
    // Sanity: director should have spawned SOMETHING in 5s.
    if (baseline.aliveMax < 1) {
      failures.push('baseline spawn never fired (aliveMax=' + baseline.aliveMax + ')');
    }
    if (baseline.twinCount !== 0) {
      failures.push('baseline twin count should be 0, got ' + baseline.twinCount);
    }

    // ─── Assertion 2: MIRROR — +50% spawn cap ───────────────────────────
    console.log('\n========== ASSERTION 2: mirror=on (+50% spawn) ==========');
    const mirror = await runSpawnScenario(page, { mirror: true, twin: false, half: false });
    console.log('  alive avg=' + mirror.aliveAvg.toFixed(1)
      + ', max=' + mirror.aliveMax
      + ', boss=' + mirror.bossCount);
    // Use avg, not max — SPAWN.targetAliveCap clamps the top end so two
    // scenarios that both saturate the cap report identical aliveMax even
    // with sharply different swarmMul. avg reflects the alive-density delta
    // across the 5s window which is where the +50% lever actually reads.
    // Tolerance: mirror.aliveAvg > baseline.aliveAvg * 1.30 (well inside the
    // +50% lever, well outside the RNG noise band).
    const mirrorFloor = Math.max(1, baseline.aliveAvg * 1.30);
    if (mirror.aliveAvg < mirrorFloor) {
      failures.push('mirror aliveAvg (' + mirror.aliveAvg.toFixed(1)
        + ') did not exceed baseline floor (' + mirrorFloor.toFixed(1)
        + ' = baseline ' + baseline.aliveAvg.toFixed(1) + ' × 1.30)');
    } else {
      console.log('  PASS: mirror.aliveAvg ' + mirror.aliveAvg.toFixed(1)
        + ' >= floor ' + mirrorFloor.toFixed(1));
    }

    // ─── Assertion 3: TWIN — paired bosses present after miniboss tick ──
    console.log('\n========== ASSERTION 3: twin=on (paired bosses) ==========');
    const twin = await runSpawnScenario(page, { mirror: false, twin: true, half: false }, { wantBoss: true });
    console.log('  alive=' + twin.aliveMax
      + ', boss=' + twin.bossCount
      + ', mini=' + twin.miniBossCount
      + ', twin=' + twin.twinCount);
    // After forcing time.game past first miniboss tick we should see ≥2
    // miniboss entities AND ≥1 with _isTwin flag.
    if (twin.miniBossCount < 2) {
      failures.push('twin miniBossCount should be >=2, got ' + twin.miniBossCount);
    }
    if (twin.twinCount < 1) {
      failures.push('twin _isTwin tag count should be >=1, got ' + twin.twinCount);
    }
    if (twin.bossCount < 2) {
      failures.push('twin total boss-flagged count should be >=2, got ' + twin.bossCount);
    }

    // ─── Assertion 4: HALF PICKUP — 50% drop denial ─────────────────────
    console.log('\n========== ASSERTION 4: half=off vs half=on (drop denial) ==========');
    const halfOff = await probeHalfPickup(page, { half: false });
    const halfOn  = await probeHalfPickup(page, { half: true });
    if (halfOff && halfOff.error) failures.push('half=off probe error: ' + halfOff.error);
    if (halfOn  && halfOn.error)  failures.push('half=on probe error: ' + halfOn.error);
    console.log('  off: null=' + halfOff.nullReturns + '/' + PICKUP_TRIALS
      + ', truthy=' + halfOff.truthyReturns);
    console.log('  on:  null=' + halfOn.nullReturns + '/' + PICKUP_TRIALS
      + ', truthy=' + halfOn.truthyReturns);
    // Clean-pool probe: each call resets the bomb pool then calls
    // dropForestPickup with rngRoll=0.005 (bomb branch). Without gate, every
    // call should spawn a bomb (null rate ~0). With gate, ~50% return null
    // pre-spawn. Tolerance: gate-ON null rate should be in [0.40, 0.60] and
    // gate-OFF should be <0.10 (a couple stragglers OK if pool dispose mid-
    // tick drops a frame).
    const offNullRate = halfOff.nullReturns / PICKUP_TRIALS;
    const onNullRate  = halfOn.nullReturns  / PICKUP_TRIALS;
    const delta = onNullRate - offNullRate;
    console.log('  null rate off=' + offNullRate.toFixed(3)
      + ', on=' + onNullRate.toFixed(3)
      + ', delta=' + delta.toFixed(3));
    if (offNullRate > 0.15) {
      failures.push('half=off null rate (' + offNullRate.toFixed(3)
        + ') should be <0.15 with clean-pool probe');
    }
    if (onNullRate < 0.40 || onNullRate > 0.60) {
      failures.push('half=on null rate (' + onNullRate.toFixed(3)
        + ') should be in [0.40, 0.60] (50% gate target)');
    }
    if (delta < 0.30) {
      failures.push('half-pickup null-rate delta (' + delta.toFixed(3)
        + ') should be >=0.30 (50% denial gate); off=' + offNullRate.toFixed(3)
        + ', on=' + onNullRate.toFixed(3));
    } else {
      console.log('  PASS: half-pickup gate added ' + (delta * 100).toFixed(1) + '% denial');
    }

  } catch (e) {
    failures.push('uncaught: ' + ((e && (e.stack || e.message)) || String(e)));
    console.error('[smoke-p4d] uncaught:', e);
  }

  console.log('\n========== SMOKE SUMMARY ==========');
  console.log('pageerrors: ' + pageErrors.length);
  for (const e of pageErrors) console.log('  - ' + e);

  try { await browser.close(); } catch (_) {}
  try { server.close(); } catch (_) {}

  if (failures.length) {
    for (const f of failures) fail(f);
    console.error('[smoke-p4d] FAIL: ' + failures.length + ' assertion(s) failed');
    process.exit(1);
  }
  if (pageErrors.length > 0) {
    console.error('[smoke-p4d] FAIL: ' + pageErrors.length + ' pageerror(s) during smoke');
    process.exit(1);
  }
  console.log('[smoke-p4d] OK — NG+ smoke passed');
}

main().catch((e) => {
  console.error('[smoke-p4d] FAIL (main):', e);
  try { server.close(); } catch (_) {}
  process.exit(1);
});
