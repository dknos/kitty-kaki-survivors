#!/usr/bin/env node
/**
 * PHASE 4 P4E (#145) — Daily seed leaderboard smoke.
 *
 * Verifies the acceptance contract from docs/P4_BACKLOG.md:
 *   1. Deterministic seed-of-day: two browsers seeded with the same YYYYMMDD
 *      produce identical first-N enemy spawn positions out of the spawn
 *      director.
 *   2. Shareable code: encodeShareCode + decodeShareCode round-trip correctly.
 *   3. Local scoreboard: topDailyForSeed returns at least one entry after a
 *      recordRun(mode='daily').
 *
 * Strategy notes:
 *   - Two PAGES inside the same Playwright context (cheaper than two
 *     browsers; localStorage is per-origin per-context but per-tab in the
 *     same context shares cookies, NOT localStorage — Playwright contexts
 *     give each tab its own localStorage). To force shared+isolated state,
 *     each scenario reloads after stamping meta so applyMetaUpgrades takes
 *     a fresh snapshot.
 *   - We bypass the broken headless rAF cadence by driving tickSpawnDirector
 *     directly (lifted from smoke-p4d-ngplus.mjs:150). state.time.game is
 *     pushed forward in 0.15s increments matching SPAWN.tickIntervalSec; each
 *     call is a guaranteed tick.
 *   - First-N spawn capture: after each tick we snapshot
 *     state.enemies.active.length; the FIRST 5 unique enemy mesh positions
 *     (in spawn order) are recorded. Spawn director uses the seeded `rand()`
 *     for: angle, ringJitter, weightedPick. Positions are
 *     hero+cos(angle)*r/sin(angle)*r so byte-identical RNG → identical
 *     coords.
 *   - cosmetic Math.random in enemies.js (hue/mixerPhase) is NOT seeded —
 *     it does NOT affect position. The smoke compares positions, not visual
 *     state, so this is fine.
 *
 * Run: node tools/smoke-p4e-daily.mjs
 *
 * Port: 8780 (after 8779 charunlock, 8778 NG+, 8777 a11y, 8776 mixer,
 * 8775 telemetry).
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
const PORT = Number(process.env.PORT || 8780);
const BOOT_TIMEOUT_MS = 60000;
const FIRST_N_SPAWNS = 5;
const POS_TOLERANCE = 1e-4;

// ── Static server (lifted from smoke-p4f-charunlock) ──────────────────────
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

function fail(msg) { console.error('[smoke-p4e] FAIL: ' + msg); }

async function waitBoot(page) {
  await page.waitForFunction(
    () => typeof window.kkStartRun === 'function' && !!window.kkState,
    null,
    { timeout: BOOT_TIMEOUT_MS },
  );
}

/**
 * Boot a fresh page in daily mode, drive the spawn director, return the
 * first-N enemy spawn positions in spawn order. Each scenario stamps meta,
 * reloads, calls kkStartRun, then drives ticks directly so we don't depend
 * on the headless rAF cadence.
 */
async function captureFirstSpawns(page) {
  // Stamp meta first, then reload — same boot/apply ordering as
  // smoke-p4d-ngplus. Force daily mode on, all other modes off, force
  // forest stage so we don't get a stage-rule swarmMul difference.
  await page.evaluate(async () => {
    const meta = await import('./src/meta.js');
    meta.setOption('selectedStage',   'forest');
    meta.setOption('optDaily',        true);
    meta.setOption('optHyper',        false);
    meta.setOption('optEndless',      false);
    meta.setOption('optBossRush',     false);
    meta.setOption('optWeekly',       false);
    // Clear NG+ flags so they don't perturb the spawn director.
    meta.setOption('optNgMirror',     false);
    meta.setOption('optNgTwin',       false);
    meta.setOption('optNgHalfPickup', false);
  });
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

  // Verify seeding actually engaged via kkStartRun's applyMetaUpgrades path.
  // Fail-fast per advisor note (#3): if state.modes.daily is false or the
  // PRNG isn't seeded we'd silently match Math.random and the determinism
  // assertion below would be a false positive.
  const seedCheck = await page.evaluate(async () => {
    const rng = await import('./src/dailyRng.js');
    const s = window.kkState;
    return {
      dailyMode: !!(s && s.modes && s.modes.daily),
      isSeeded:  rng.isDailySeeded(),
      seedInt:   rng.todaySeedInt(),
    };
  });
  if (!seedCheck.dailyMode) throw new Error('state.modes.daily was false after kkStartRun (daily seeding skipped)');
  if (!seedCheck.isSeeded)  throw new Error('dailyRng.isDailySeeded() was false after kkStartRun (seedDaily skipped)');

  // Drive the director directly. Mirrors smoke-p4d-ngplus pattern:
  // state.time.game pushed forward in 0.15s slices, tickSpawnDirector called
  // with dt=0.15s; SPAWN.tickIntervalSec is also 0.15s so each call is a
  // guaranteed tick. After each tick we snapshot the active enemies
  // (length + first-N XZ positions). We capture positions in SPAWN order
  // by remembering each fresh entry the first frame it appears.
  const spawnsResult = await page.evaluate(async (N) => {
    const s = window.kkState;
    if (!s || !s.time) return { ok: false, reason: 'kkState missing' };
    const mod = await import('./src/spawnDirector.js');
    if (typeof mod.tickSpawnDirector !== 'function') {
      return { ok: false, reason: 'tickSpawnDirector not exported' };
    }
    const rng = await import('./src/dailyRng.js');
    // Pause the game loop's logic phase so background rAF ticks (which would
    // call tickSpawnDirector with whatever realDt the headless browser hands
    // us) can't perturb state between our explicit ticks. main.js bails
    // before logic if state.time.paused is true.
    if (s.time) s.time.paused = true;
    // Fresh director state — start from t=0 so we observe the very first
    // spawns of this run. Also drain the existing active list so the
    // deficit calc isn't biased by whatever the boot path inflated to.
    s.time.game = 0;
    if (s.enemies && Array.isArray(s.enemies.active)) {
      // Drain by detaching the meshes back to their pools (mirrors
      // _teardownActiveRun pattern but lighter — we just need the list to
      // be empty so deficit math starts from a clean slate).
      for (const e of s.enemies.active) {
        if (!e || !e.mesh) continue;
        e.alive = false;
        e.mesh.visible = false;
        if (e.isTotem || e.isPylon || e.isBell) {
          if (e.mesh.parent) e.mesh.parent.remove(e.mesh);
          continue;
        }
        const pool = s.enemies.pools[e.glbKey] || (s.enemies.pools[e.glbKey] = []);
        pool.push(e.mesh);
      }
      s.enemies.active.length = 0;
      if (s.enemies.spatial && typeof s.enemies.spatial.clear === 'function') {
        s.enemies.spatial.clear();
      }
    }
    if (typeof mod.resetSpawnDirector === 'function') mod.resetSpawnDirector();
    // Re-seed AFTER reset so the smoke is testing the SAME stream regardless
    // of whatever boot-time / kkStartRun calls may have consumed from the
    // PRNG before we got here. The acceptance contract is "same YYYYMMDD
    // seed → same first-N spawns starting from a known seed state"; the
    // boot path is shared so any pre-consumption would be identical between
    // pages, but re-seeding here removes any worry about page-specific
    // boot ordering jitter (e.g. browser-pool warmup that calls into
    // applyMetaUpgrades once vs twice).
    rng.seedDaily(rng.todaySeedInt());

    // DEBUG: probe a few rand values right after the reseed via the SAME
    // module import we have here. Compare these between pages to confirm
    // the PRNG itself is deterministic across browser sessions.
    const probeAfterSeed = [];
    for (let i = 0; i < 4; i++) probeAfterSeed.push(rng.rand());
    // Re-seed again so the actual tickSpawnDirector run starts from the
    // known seed state (since the probe consumed 4 rands).
    rng.seedDaily(rng.todaySeedInt());

    const positions = [];
    const seen = new Set();
    const callCountTrace = [];
    // Up to 200 ticks × 0.15s = 30s of director time. With D-ramp the
    // director hits target-alive within a few hundred ms, so 5 unique
    // spawns land well inside this window.
    for (let i = 0; i < 200 && positions.length < N; i++) {
      s.time.game += 0.15;
      mod.tickSpawnDirector(0.15);
      if (i < 4) callCountTrace.push({ tick: i, calls: rng._dbgCallCount(), activeLen: s.enemies.active.length });
      // Detect newly-arrived enemies by identity. state.enemies.active is
      // a live array; new entries are pushed to the tail.
      for (const e of s.enemies.active) {
        if (!e || seen.has(e)) continue;
        seen.add(e);
        // Filter out non-director arena props: Totems (src/totems.js),
        // Pylons (src/pylons.js), Bells (src/bells.js) are placed at run
        // start by their own modules using Math.random (cosmetic position,
        // NOT the director's responsibility). The acceptance test verifies
        // spawnDirector determinism specifically — so skip these from the
        // first-N capture, otherwise we'd assert against placement logic
        // that intentionally stays unseeded.
        if (e.isTotem || e.isPylon || e.isBell) continue;
        // mesh.position is a THREE.Vector3 — pull primitives so the result
        // crosses the playwright bridge cleanly.
        const px = e.mesh && e.mesh.position ? e.mesh.position.x : null;
        const pz = e.mesh && e.mesh.position ? e.mesh.position.z : null;
        positions.push({ x: px, z: pz, tier: e.tierKey || e.glbKey || '?' });
        if (positions.length >= N) break;
      }
    }
    return {
      ok: true,
      positions,
      finalAlive: s.enemies.active.length,
      finalGameT: s.time.game,
      heroPos: { x: s.hero.pos.x, z: s.hero.pos.z },
      stageRingMul: (s.run && s.run.stageRuleSpawnRingMul) || 1,
      probeAfterSeed,
      callCountTrace,
    };
  }, FIRST_N_SPAWNS);

  if (!spawnsResult.ok) {
    throw new Error('captureFirstSpawns drive failed: ' + spawnsResult.reason);
  }
  return spawnsResult;
}

function _samePos(a, b) {
  if (!a || !b) return false;
  if (a.tier !== b.tier) return false;
  if (typeof a.x !== 'number' || typeof b.x !== 'number') return false;
  if (typeof a.z !== 'number' || typeof b.z !== 'number') return false;
  return Math.abs(a.x - b.x) <= POS_TOLERANCE && Math.abs(a.z - b.z) <= POS_TOLERANCE;
}

async function main() {
  if (!fs.existsSync(PLAY_PATH)) {
    console.error('[smoke-p4e] FAIL: playwright not installed at ' + PLAY_PATH);
    console.error('[smoke-p4e] Per CLAUDE.md, smoke tools NEVER run npm install.');
    process.exit(2);
  }
  if (!fs.existsSync(PLAYWRIGHT_EXEC)) {
    console.error('[smoke-p4e] FAIL: chromium binary not found at ' + PLAYWRIGHT_EXEC);
    process.exit(2);
  }
  console.log('[smoke-p4e] playwright check: OK');

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('[smoke-p4e] server on http://127.0.0.1:' + PORT);

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

  const failures = [];
  const pageErrors = [];

  try {
    // Two ISOLATED browser contexts so localStorage doesn't bleed between
    // them — each context represents a separate "player" on the same date.
    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    for (const [p, label] of [[pageA, 'A'], [pageB, 'B']]) {
      p.on('console', (msg) => {
        if (msg.type() === 'error') console.log(`[console.error ${label}]`, msg.text());
      });
      p.on('pageerror', (e) => {
        pageErrors.push(`[${label}] ${e.message}`);
        console.error(`[pageerror ${label}]`, e.message);
      });
    }

    const url = 'http://127.0.0.1:' + PORT + '/index.html?smoke=1';
    await pageA.goto(url, { waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
    await pageB.goto(url, { waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
    await waitBoot(pageA);
    await waitBoot(pageB);
    console.log('[smoke-p4e] both pages booted');

    // ── ASSERTION 1: determinism — same seed → same first-N spawns ────────
    console.log('\n========== ASSERTION 1: deterministic first-N spawns ==========');
    const a = await captureFirstSpawns(pageA);
    const b = await captureFirstSpawns(pageB);
    console.log('  pageA hero: (' + a.heroPos.x.toFixed(4) + ', ' + a.heroPos.z.toFixed(4) + ') stageRingMul=' + a.stageRingMul);
    console.log('  pageB hero: (' + b.heroPos.x.toFixed(4) + ', ' + b.heroPos.z.toFixed(4) + ') stageRingMul=' + b.stageRingMul);
    console.log('  pageA probeAfterSeed: ' + JSON.stringify(a.probeAfterSeed));
    console.log('  pageB probeAfterSeed: ' + JSON.stringify(b.probeAfterSeed));
    console.log('  pageA callCountTrace: ' + JSON.stringify(a.callCountTrace));
    console.log('  pageB callCountTrace: ' + JSON.stringify(b.callCountTrace));
    console.log('  pageA positions: ' + a.positions.length + ' (finalGameT=' + a.finalGameT.toFixed(2) + ')');
    for (const p of a.positions) console.log('    ' + p.tier + ' @ (' + p.x.toFixed(4) + ', ' + p.z.toFixed(4) + ')');
    console.log('  pageB positions: ' + b.positions.length + ' (finalGameT=' + b.finalGameT.toFixed(2) + ')');
    for (const p of b.positions) console.log('    ' + p.tier + ' @ (' + p.x.toFixed(4) + ', ' + p.z.toFixed(4) + ')');

    if (a.positions.length < FIRST_N_SPAWNS) {
      failures.push(`pageA captured only ${a.positions.length}/${FIRST_N_SPAWNS} spawns`);
    }
    if (b.positions.length < FIRST_N_SPAWNS) {
      failures.push(`pageB captured only ${b.positions.length}/${FIRST_N_SPAWNS} spawns`);
    }
    if (a.positions.length === b.positions.length) {
      let mismatches = 0;
      for (let i = 0; i < a.positions.length; i++) {
        if (!_samePos(a.positions[i], b.positions[i])) {
          mismatches++;
          console.log(`  MISMATCH [${i}]: A=${JSON.stringify(a.positions[i])} vs B=${JSON.stringify(b.positions[i])}`);
        }
      }
      if (mismatches > 0) {
        failures.push(`${mismatches}/${a.positions.length} spawn positions diverged between pages`);
      } else {
        console.log('  ✓ All ' + a.positions.length + ' spawn positions match within tolerance ' + POS_TOLERANCE);
      }
    }

    // ── ASSERTION 2: share code round-trip ────────────────────────────────
    console.log('\n========== ASSERTION 2: share code encode/decode round-trip ==========');
    const round = await pageA.evaluate(async () => {
      const lb = await import('./src/leaderboard.js');
      const sample = {
        seed: lb.makeSeed('forest', 'kitty', 'daily'),
        char: 'kitty',
        kills: 423,
        timeSurvived: 754,
      };
      const code = lb.encodeShareCode(sample);
      const decoded = lb.decodeShareCode(code);
      return { sample, code, decoded };
    });
    console.log('  encoded: ' + round.code);
    console.log('  decoded: ' + JSON.stringify(round.decoded));
    if (!round.code) failures.push('encodeShareCode returned empty');
    if (!round.decoded) failures.push('decodeShareCode returned null on a freshly-encoded code');
    else {
      if (round.decoded.s !== round.sample.seed)  failures.push('decoded.s != sample.seed');
      if (round.decoded.k !== round.sample.kills) failures.push('decoded.k != sample.kills');
      if (round.decoded.t !== round.sample.timeSurvived) failures.push('decoded.t != sample.timeSurvived');
      if (round.decoded.c !== round.sample.char)  failures.push('decoded.c != sample.char');
    }
    // Malformed input → null guard.
    const bad = await pageA.evaluate(async () => {
      const lb = await import('./src/leaderboard.js');
      return {
        empty:    lb.decodeShareCode(''),
        garbage:  lb.decodeShareCode('not-base64-!!!'),
        notJson:  lb.decodeShareCode(btoa('not json')),
      };
    });
    if (bad.empty !== null)   failures.push('decodeShareCode("") should return null');
    if (bad.garbage !== null) failures.push('decodeShareCode("not-base64-!!!") should return null');
    if (bad.notJson !== null) failures.push('decodeShareCode(btoa("not json")) should return null');

    // ── ASSERTION 3: topDailyForSeed returns the recorded entry ───────────
    console.log('\n========== ASSERTION 3: topDailyForSeed after recordRun ==========');
    const lbResult = await pageA.evaluate(async () => {
      const lb = await import('./src/leaderboard.js');
      // Wipe any prior entries so the assertion is clean.
      lb.resetLeaderboard();
      const seed = lb.makeSeed('forest', 'kitty', 'daily');
      const rec = lb.recordRun({
        stage: 'forest',
        char: 'kitty',
        mode: 'daily',
        kills: 100,
        timeSurvived: 540,
        level: 12,
        dmgDealt: 9001,
        victory: false,
      });
      const top = lb.topDailyForSeed(seed, 10);
      const today = lb.topDailyToday(10);
      return { seed, rec, top, today };
    });
    console.log('  seed: ' + lbResult.seed);
    console.log('  recordRun -> ' + JSON.stringify(lbResult.rec));
    console.log('  topDailyForSeed: ' + lbResult.top.length + ' entries');
    console.log('  topDailyToday:   ' + lbResult.today.length + ' entries');
    if (!lbResult.top || lbResult.top.length === 0) {
      failures.push('topDailyForSeed should return >= 1 entry after recordRun(mode=daily)');
    } else {
      const e0 = lbResult.top[0];
      if (e0.mode !== 'daily')   failures.push('top entry mode should be "daily", got ' + e0.mode);
      if (!e0.dailyDate)         failures.push('top entry should carry a dailyDate stamp');
      if (e0.kills !== 100)      failures.push('top entry kills should be 100, got ' + e0.kills);
      if (e0.timeSurvived !== 540) failures.push('top entry timeSurvived should be 540, got ' + e0.timeSurvived);
    }
    if (!lbResult.today || lbResult.today.length === 0) {
      failures.push('topDailyToday should return >= 1 entry after recordRun(mode=daily)');
    }

    // ── ASSERTION 4: non-daily recordRun does NOT stamp dailyDate ─────────
    console.log('\n========== ASSERTION 4: non-daily recordRun has no dailyDate ==========');
    const nonDaily = await pageA.evaluate(async () => {
      const lb = await import('./src/leaderboard.js');
      lb.resetLeaderboard();
      const rec = lb.recordRun({
        stage: 'forest', char: 'kitty', mode: 'normal',
        kills: 10, timeSurvived: 60, level: 3, dmgDealt: 200, victory: false,
      });
      return { rec };
    });
    console.log('  normal-mode recordRun -> ' + JSON.stringify(nonDaily.rec));
    // recordRun returns { rankInCategory, isNewBest, seed }, NOT the entry,
    // so we can't read dailyDate from the return value. Read back from
    // storage instead.
    const stored = await pageA.evaluate(async () => {
      const raw = localStorage.getItem('kk-leaderboard-v1');
      return raw ? JSON.parse(raw) : null;
    });
    if (!stored || !stored.runs || stored.runs.length === 0) {
      failures.push('non-daily recordRun did not persist anything');
    } else {
      const e = stored.runs[stored.runs.length - 1];
      if ('dailyDate' in e) {
        failures.push('non-daily recordRun should NOT stamp dailyDate, but entry has dailyDate=' + e.dailyDate);
      }
    }

    await ctxA.close();
    await ctxB.close();
  } catch (e) {
    failures.push('uncaught: ' + ((e && (e.stack || e.message)) || String(e)));
    console.error('[smoke-p4e] uncaught:', e);
  }

  console.log('\n========== SMOKE SUMMARY ==========');
  console.log('pageerrors: ' + pageErrors.length);
  for (const e of pageErrors) console.log('  - ' + e);

  try { await browser.close(); } catch (_) {}
  try { server.close(); } catch (_) {}

  if (failures.length) {
    for (const f of failures) fail(f);
    console.error('[smoke-p4e] FAIL: ' + failures.length + ' assertion(s) failed');
    process.exit(1);
  }
  if (pageErrors.length > 0) {
    console.error('[smoke-p4e] FAIL: ' + pageErrors.length + ' pageerror(s) during smoke');
    process.exit(1);
  }
  console.log('[smoke-p4e] OK — daily seed leaderboard smoke passed');
}

main().catch((e) => {
  console.error('[smoke-p4e] FAIL (main):', e);
  try { server.close(); } catch (_) {}
  process.exit(1);
});
