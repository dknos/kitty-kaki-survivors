#!/usr/bin/env node
/**
 * Forest heap-drift smoke (PHASE 2 P2D / FOREST-V2-A31, 2026-05-17).
 *
 * Profiles JS heap growth + per-system pool sizes over a simulated 5-minute
 * Forest run. Detects leaks via linear regression on the sample timeline;
 * any tracked metric with slope > 0.1 KB/sec sustained is flagged as suspect.
 *
 * SIMULATION MODEL
 * ----------------
 * Headless Chromium with swiftshader can't approach 60fps (cohort 15 noted
 * ~4fps under WebGL load). 5 minutes of real wall-clock would still yield
 * ~1200 frames worth of accumulation — useful for *some* leaks (e.g. toast
 * queue, FX arrays growing every tick), but not enough to surface time-gated
 * systems (reaper warn at 1680s game-time, golden-hour relerp at 600-1200s,
 * sealed-room respawns). To cover both, this tool:
 *
 *   - Runs for 2min WALL-CLOCK (24 samples at 5s cadence).
 *   - Pushes `state.time.game` forward by GAMETIME_JUMP_PER_SAMPLE each tick
 *     so the 5-minute span of *game-time* events fires across the 2min window.
 *   - Forces GC between samples (window.gc() via --js-flags=--expose-gc) so
 *     usedJSHeapSize reflects live heap, not opportunistic GC pressure.
 *
 * CHROMIUM FLAGS (required, both)
 * -------------------------------
 *   --enable-precise-memory-info  — without it, performance.memory returns
 *                                   bucketed garbage (100 MB granularity).
 *   --js-flags=--expose-gc        — without it, window.gc is undefined; the
 *                                   samples drift with V8's opportunistic GC.
 *
 * METRICS SAMPLED
 * ---------------
 *   heap         : performance.memory.usedJSHeapSize (bytes)
 *   enemies      : state.enemies.active.length
 *   weapons      : state.weapons.length
 *   passives     : state.passives.length
 *   projectiles  : state.projectiles.active.length
 *   eProjectiles : state.enemyProjectiles.active.length
 *   gems         : state.gems.list.length
 *   webs         : state.webs.list.length
 *   dpsWin       : state.run._dpsWin.length          (trimmed @ ui.js:957)
 *   sealedRooms  : Object.keys(state.run._sealedRooms || {}).length
 *   achThisRun   : (state.run._achievementsThisRun instanceof Set ? .size : 0)
 *   banishedRun  : (state.run._banishedThisRun instanceof Set ? .size : 0)
 *   pendingVolat : state.fx.pendingVolatile.length
 *   domTotal     : document.querySelectorAll('*').length   (detached-node proxy)
 *   toastsLive   : document.querySelectorAll('.kk-ach-toast').length
 *
 * LEAK GATE
 * ---------
 * Linear regression slope on the last 75% of samples (skip warmup transient
 * while pools are still filling). Slope units = KB/sec for heap, count/sec
 * for everything else. Flag if heap slope > 0.1 KB/s OR count slope > 0.5/s
 * sustained. Counts that legitimately grow with game progression (e.g.
 * achievements, sealed rooms) are reported but only flagged if growth
 * outpaces expected bounds (>20 entries — there are <20 forest achievements).
 *
 * Output: tools/_heap_report.md  — timeline table + per-system slopes + top
 *                                   leak candidates with suggested fixes.
 *
 * EXIT CODES
 * ----------
 *   0 = clean run (may include leak suspects — they don't gate; the report
 *       is the deliverable, not a CI gate at this phase).
 *   1 = boot break, console.error, pageerror, or screenshot/report failure.
 *   2 = playwright / chromium not at expected path.
 *
 * Run: node tools/smoke-forest-heap.mjs
 *
 * NO npm install. Playwright at /home/nemoclaw/node_modules (shared cache).
 */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const require    = createRequire(import.meta.url);

const ROOT             = path.resolve(__dirname, '..');
const PORT             = Number(process.env.PORT || 8775);  // avoid 8773/8771
const BOOT_TIMEOUT_MS  = 60000;
const WARMUP_SETTLE_MS = 3000;     // boot settle so HUD mounts + first frame draws
const SAMPLE_INTERVAL  = 5000;     // 5s wall-clock between samples
const SAMPLE_COUNT     = 24;       // 24 × 5s = 120s wall-clock total
const GC_SETTLE_MS     = 250;      // post-gc dwell before reading heap
const GAMETIME_JUMP    = 12.5;     // +12.5s game-time per sample → 5min over 24 samples
const REPORT_PATH      = path.join(__dirname, '_heap_report.md');
const HEAP_LEAK_KB_S   = 0.1;      // KB/sec slope = leak suspect
const COUNT_LEAK_PER_S = 0.5;      // count/sec slope = leak suspect

const PLAY_PATH       = '/home/nemoclaw/node_modules/playwright';
const PLAYWRIGHT_EXEC = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

// ── Tiny static server (lifted from smoke-forest-v2.mjs) ───────────────────
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

/**
 * Ordinary-least-squares slope on (x, y) pairs.
 * Returns slope in y-units per x-unit. NaN if <2 points or zero variance.
 */
function linearSlope(xs, ys) {
  const n = xs.length;
  if (n < 2) return NaN;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i];
    sxy += xs[i] * ys[i];
    sxx += xs[i] * xs[i];
  }
  const denom = (n * sxx - sx * sx);
  if (Math.abs(denom) < 1e-9) return NaN;
  return (n * sxy - sx * sy) / denom;
}

/** Slice the last `frac` of an array. */
function tailSlice(arr, frac) {
  const start = Math.floor(arr.length * (1 - frac));
  return arr.slice(start);
}

async function main() {
  const startMs = Date.now();

  if (!fs.existsSync(PLAY_PATH)) {
    console.error('[smoke-heap] FAIL: playwright not installed at ' + PLAY_PATH);
    console.error('[smoke-heap] Per CLAUDE.md, smoke tools NEVER run npm install.');
    process.exit(2);
  }
  if (!fs.existsSync(PLAYWRIGHT_EXEC)) {
    console.error('[smoke-heap] FAIL: chromium binary not found at ' + PLAYWRIGHT_EXEC);
    process.exit(2);
  }
  console.log('[smoke-heap] playwright check: OK');

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('[smoke-heap] server on http://127.0.0.1:' + PORT);

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
      '--enable-unsafe-webgpu',
      // Heap-profile-specific flags — see header docs.
      '--enable-precise-memory-info',
      '--js-flags=--expose-gc',
    ],
  });
  const ctx  = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors    = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const t = msg.text();
      consoleErrors.push(t);
      console.log('[console.error]', t);
    }
  });
  page.on('pageerror', (e) => {
    pageErrors.push(e.message);
    console.error('[pageerror]', e.message);
  });

  const samples = [];  // [{ tWallSec, tGameSec, heap, enemies, ... }]

  try {
    // ── Boot ──────────────────────────────────────────────────────────────
    const url = 'http://127.0.0.1:' + PORT + '/index.html?smoke=1';
    await page.goto(url, { waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
    console.log('[smoke-heap] page loaded; waiting for kkStartRun');

    await page.waitForFunction(
      () => typeof window.kkStartRun === 'function',
      null,
      { timeout: BOOT_TIMEOUT_MS },
    );

    // Pin to forest stage (canonical path — matches smoke-forest-v2).
    await page.evaluate(async () => {
      try {
        const mod = await import('./src/meta.js');
        if (mod.setOption) mod.setOption('selectedStage', 'forest');
        else if (mod.getMeta) {
          const m = mod.getMeta();
          if (m) m.selectedStage = 'forest';
        }
      } catch (e) {
        console.warn('[smoke-heap] meta setOption fallback:', e && e.message);
      }
    });

    // Verify precise-memory-info is wired before we trust the samples.
    const memAvail = await page.evaluate(() => {
      const m = performance && performance.memory;
      if (!m) return { ok: false, reason: 'performance.memory undefined' };
      // Without --enable-precise-memory-info the values are bucketed to ~100MB.
      // We can't assert the flag directly, but we can warn if heapLimit looks suspicious.
      return {
        ok: true,
        heapLimit: m.jsHeapSizeLimit,
        totalHeap: m.totalJSHeapSize,
        usedHeap:  m.usedJSHeapSize,
        gcAvailable: typeof window.gc === 'function',
      };
    });
    console.log('[smoke-heap] memory probe:', JSON.stringify(memAvail));
    if (!memAvail.ok) {
      console.error('[smoke-heap] FAIL: performance.memory unavailable — chromium build mismatch?');
      process.exit(1);
    }
    if (!memAvail.gcAvailable) {
      console.warn('[smoke-heap] WARN: window.gc undefined — --js-flags=--expose-gc not applied?');
      console.warn('[smoke-heap]       Samples will drift with opportunistic GC. Proceeding.');
    }

    // Start the run + publish kkState via perfHUD.
    await page.evaluate(() => {
      if (typeof window.kkPerfForceOn === 'function') window.kkPerfForceOn();
      window.kkStartRun();
    });
    await page.waitForFunction(
      () => !!window.kkState && !!window.kkState.run,
      null,
      { timeout: BOOT_TIMEOUT_MS },
    );
    console.log('[smoke-heap] kkState live; warmup ' + WARMUP_SETTLE_MS + 'ms');
    await new Promise((r) => setTimeout(r, WARMUP_SETTLE_MS));

    // ── Sample loop ───────────────────────────────────────────────────────
    console.log('[smoke-heap] sampling: ' + SAMPLE_COUNT + ' × ' + SAMPLE_INTERVAL + 'ms');
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      // Push game-time forward so time-gated systems (reaper warn @1680,
      // golden hour @600-1200, sealed rooms) fire across the sample window.
      await page.evaluate((jump) => {
        const s = window.kkState;
        if (s && s.time && typeof s.time.game === 'number') {
          s.time.game += jump;
        }
      }, GAMETIME_JUMP);

      // Wait for the gametime jump to settle (lets HUD/dayNight/reaper
      // observe the new time-of-day across at least 1-2 frames).
      await new Promise((r) => setTimeout(r, SAMPLE_INTERVAL));

      // Force GC + brief dwell so usedJSHeapSize reflects live heap.
      await page.evaluate(() => { if (typeof window.gc === 'function') window.gc(); });
      await new Promise((r) => setTimeout(r, GC_SETTLE_MS));

      const sample = await page.evaluate(() => {
        const s = window.kkState || {};
        const run = s.run || {};
        const enemies = (s.enemies && s.enemies.active) || [];
        const projs = (s.projectiles && s.projectiles.active) || [];
        const eProjs = (s.enemyProjectiles && s.enemyProjectiles.active) || [];
        const gems = (s.gems && s.gems.list) || [];
        const webs = (s.webs && s.webs.list) || [];
        const dpsWin = run._dpsWin || [];
        const sealed = run._sealedRooms || {};
        const ach = run._achievementsThisRun;
        const banished = run._banishedThisRun;
        const pv = (s.fx && s.fx.pendingVolatile) || [];
        return {
          tGameSec: (s.time && s.time.game) || 0,
          heap: (performance.memory && performance.memory.usedJSHeapSize) || 0,
          totalHeap: (performance.memory && performance.memory.totalJSHeapSize) || 0,
          enemies: enemies.length,
          weapons: (s.weapons || []).length,
          passives: (s.passives || []).length,
          projectiles: projs.length,
          eProjectiles: eProjs.length,
          gems: gems.length,
          webs: webs.length,
          dpsWin: dpsWin.length,
          sealedRooms: Object.keys(sealed).length,
          achThisRun: (ach && typeof ach.size === 'number') ? ach.size : 0,
          banishedRun: (banished && typeof banished.size === 'number') ? banished.size : 0,
          pendingVolat: pv.length,
          domTotal: document.querySelectorAll('*').length,
          toastsLive: document.querySelectorAll('.kk-ach-toast').length,
        };
      });
      sample.tWallSec = (Date.now() - startMs) / 1000;
      samples.push(sample);
      console.log(
        '[smoke-heap] sample ' + (i + 1).toString().padStart(2, ' ') + '/' + SAMPLE_COUNT
        + '  wall=' + sample.tWallSec.toFixed(1) + 's  game=' + sample.tGameSec.toFixed(0) + 's'
        + '  heap=' + (sample.heap / 1024 / 1024).toFixed(2) + 'MB'
        + '  enemies=' + sample.enemies
        + '  dom=' + sample.domTotal
      );
    }

    // ── Analysis ──────────────────────────────────────────────────────────
    // Skip warmup (first 25%) — pools may still be filling. Slope is computed
    // on the last 75% of samples per the leak-gate spec in header.
    const tail = tailSlice(samples, 0.75);
    const xs = tail.map((s) => s.tWallSec);

    const metricNames = [
      'heap', 'totalHeap',
      'enemies', 'weapons', 'passives',
      'projectiles', 'eProjectiles',
      'gems', 'webs',
      'dpsWin', 'sealedRooms',
      'achThisRun', 'banishedRun',
      'pendingVolat',
      'domTotal', 'toastsLive',
    ];

    const slopes = {};
    const finals = {};
    const starts = {};
    for (const m of metricNames) {
      const ys = tail.map((s) => s[m]);
      slopes[m] = linearSlope(xs, ys);
      finals[m] = ys[ys.length - 1];
      starts[m] = ys[0];
    }

    // Heap slope reported in KB/sec. Other slopes in count/sec.
    const heapSlopeKBs = slopes.heap / 1024;
    const totalHeapSlopeKBs = slopes.totalHeap / 1024;

    const leakCandidates = [];
    if (heapSlopeKBs > HEAP_LEAK_KB_S) {
      leakCandidates.push({
        metric: 'heap (usedJSHeapSize)',
        slope: heapSlopeKBs.toFixed(3) + ' KB/s',
        delta: ((finals.heap - starts.heap) / 1024).toFixed(1) + ' KB over tail',
        note: 'Aggregate heap drift — narrow with per-system slopes below.',
      });
    }
    for (const m of metricNames) {
      if (m === 'heap' || m === 'totalHeap') continue;
      const slope = slopes[m];
      if (!Number.isFinite(slope) || slope <= COUNT_LEAK_PER_S) continue;
      // Per spec: counts that legitimately grow are flagged only if >20 final.
      if ((m === 'achThisRun' || m === 'sealedRooms' || m === 'banishedRun')
          && finals[m] <= 20) {
        continue;
      }
      leakCandidates.push({
        metric: m,
        slope: slope.toFixed(3) + ' /s',
        delta: '+' + (finals[m] - starts[m]) + ' over tail (start=' + starts[m] + ', end=' + finals[m] + ')',
        note: _leakHint(m),
      });
    }

    // ── Build the report ──────────────────────────────────────────────────
    const lines = [];
    lines.push('# Forest heap-drift report');
    lines.push('');
    lines.push('Generated: ' + new Date().toISOString());
    lines.push('Branch: swarm/heap-audit  (PHASE 2 P2D / FOREST-V2-A31)');
    lines.push('');
    lines.push('## Run parameters');
    lines.push('- Wall-clock duration: ' + ((Date.now() - startMs) / 1000).toFixed(1) + 's');
    lines.push('- Samples: ' + samples.length + ' @ ' + SAMPLE_INTERVAL + 'ms cadence');
    lines.push('- Game-time advance per sample: +' + GAMETIME_JUMP + 's');
    lines.push('  → simulated game-time span: ' + (samples[0]?.tGameSec || 0).toFixed(1)
                + 's … ' + (samples[samples.length - 1]?.tGameSec || 0).toFixed(1) + 's');
    lines.push('- GC available: ' + (memAvail.gcAvailable ? 'YES (window.gc)' : 'NO — opportunistic'));
    lines.push('- Headless WebGL: swiftshader (~4 fps; runtime accumulation slower than hardware)');
    lines.push('- Console.errors during run: ' + consoleErrors.length);
    lines.push('- Page errors during run:    ' + pageErrors.length);
    lines.push('');
    lines.push('## Timeline (every sample)');
    lines.push('');
    lines.push('| #  | wall s | game s |   heap MB | enemies | weapons | proj | gems | webs | dpsWin | sealed | ach | toasts | DOM   |');
    lines.push('|----|-------:|-------:|----------:|--------:|--------:|-----:|-----:|-----:|-------:|-------:|----:|-------:|------:|');
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      lines.push(
        '| ' + String(i + 1).padStart(2, ' ')
        + ' | ' + s.tWallSec.toFixed(1).padStart(6, ' ')
        + ' | ' + s.tGameSec.toFixed(0).padStart(6, ' ')
        + ' | ' + (s.heap / 1024 / 1024).toFixed(2).padStart(9, ' ')
        + ' | ' + String(s.enemies).padStart(7, ' ')
        + ' | ' + String(s.weapons).padStart(7, ' ')
        + ' | ' + String(s.projectiles).padStart(4, ' ')
        + ' | ' + String(s.gems).padStart(4, ' ')
        + ' | ' + String(s.webs).padStart(4, ' ')
        + ' | ' + String(s.dpsWin).padStart(6, ' ')
        + ' | ' + String(s.sealedRooms).padStart(6, ' ')
        + ' | ' + String(s.achThisRun).padStart(3, ' ')
        + ' | ' + String(s.toastsLive).padStart(6, ' ')
        + ' | ' + String(s.domTotal).padStart(5, ' ')
        + ' |'
      );
    }
    lines.push('');
    lines.push('## Per-system slopes (last 75% of samples)');
    lines.push('');
    lines.push('| metric         | start | end | delta | slope    | flagged |');
    lines.push('|----------------|------:|----:|------:|---------:|:-------:|');
    for (const m of metricNames) {
      const slope = slopes[m];
      const slopeStr = Number.isFinite(slope)
        ? (m === 'heap' || m === 'totalHeap'
            ? (slope / 1024).toFixed(3) + ' KB/s'
            : slope.toFixed(4) + ' /s')
        : 'n/a';
      let flagged = ' ';
      if (m === 'heap' && heapSlopeKBs > HEAP_LEAK_KB_S) flagged = 'X';
      else if (m !== 'heap' && m !== 'totalHeap'
               && Number.isFinite(slope) && slope > COUNT_LEAK_PER_S) {
        flagged = (m === 'achThisRun' || m === 'sealedRooms' || m === 'banishedRun')
          ? (finals[m] > 20 ? 'X' : ' ')
          : 'X';
      }
      lines.push(
        '| ' + m.padEnd(14, ' ')
        + ' | ' + String(starts[m]).padStart(5, ' ')
        + ' | ' + String(finals[m]).padStart(3, ' ')
        + ' | ' + String(finals[m] - starts[m]).padStart(5, ' ')
        + ' | ' + slopeStr.padStart(8, ' ')
        + ' |   ' + flagged + '    |'
      );
    }
    lines.push('');
    lines.push('## Leak candidates (slope above gate)');
    lines.push('');
    if (leakCandidates.length === 0) {
      lines.push('_None._ All tracked metrics stayed within the leak gate '
                  + '(heap < ' + HEAP_LEAK_KB_S + ' KB/s; counts < ' + COUNT_LEAK_PER_S + '/s).');
    } else {
      for (const c of leakCandidates) {
        lines.push('- **' + c.metric + '** — slope=' + c.slope
                    + ', delta=' + c.delta);
        lines.push('  - ' + c.note);
      }
    }
    lines.push('');
    lines.push('## Static-audit notes (sibling to dynamic samples)');
    lines.push('');
    lines.push('Cross-referenced with `grep` audits during this phase:');
    lines.push('');
    lines.push('- `state.run._dpsWin` is push-only in `src/enemies.js:1103` BUT trimmed each');
    lines.push('  HUD frame in `src/ui.js:957` (sliding 5s window). **Not a leak** — confirmed.');
    lines.push('- `_toastQueue` in `src/forestAchievements.js:102` is drained by `_pumpToastQueue`');
    lines.push('  in the same file, and reset to `[]` at line 626 on run reset. Toast DOM nodes');
    lines.push('  are removed in `_pumpToastQueue` after slide-out (line 178-181). Monitor');
    lines.push('  `toastsLive` column above for unbounded growth (would indicate the timer was');
    lines.push('  cancelled before removeChild fired).');
    lines.push('- `state.fx.pendingVolatile` is consumed each frame in `src/enemies.js:1281`');
    lines.push('  and reset to `[]` in `src/state.js:492`. Spike during chain explosions only.');
    lines.push('- `state.run._sealedRooms`, `_achievementsThisRun`, `_banishedThisRun` grow');
    lines.push('  monotonically *within a run* but are reset on `resetState()`. Bounded by');
    lines.push('  forest room count (<10) and achievement count (<20). Flag only if >20.');
    lines.push('');
    lines.push('## Methodology caveats');
    lines.push('');
    lines.push('- Headless swiftshader ≈ 4 fps. Frame-driven accumulators grow ~10-15x slower');
    lines.push('  than on hardware GL. Hardware re-run with `--use-gl=desktop` recommended');
    lines.push('  before declaring "no leaks" for a release build.');
    lines.push('- `performance.memory` rounds heap to nearest ~5 KB even with the precise flag.');
    lines.push('  Slopes <0.05 KB/s should be treated as noise.');
    lines.push('- DevTools Protocol heap snapshots (`Memory.takeHeapSnapshot`) give per-object');
    lines.push('  retainer chains but are 10x heavier. Add only if this report flags a leak');
    lines.push('  that the per-system samples don\'t localize.');
    lines.push('- Game-time jumps (+12.5s / sample) skip *content* the player would have');
    lines.push('  triggered between those ticks (enemy spawns, kills). Pools therefore grow');
    lines.push('  *slower* than in a real 5min run — bias is towards under-reporting leaks.');
    lines.push('');
    lines.push('## Run console summary');
    lines.push('');
    lines.push('- console.error count: ' + consoleErrors.length);
    if (consoleErrors.length > 0) {
      for (const e of consoleErrors.slice(0, 10)) lines.push('  - ' + e.slice(0, 200));
    }
    lines.push('- pageerror count:     ' + pageErrors.length);
    if (pageErrors.length > 0) {
      for (const e of pageErrors.slice(0, 10)) lines.push('  - ' + e.slice(0, 200));
    }
    lines.push('');

    fs.writeFileSync(REPORT_PATH, lines.join('\n'));
    console.log('[smoke-heap] report written: ' + REPORT_PATH);

    // Console summary tail (the report excerpt to paste back to the brief).
    console.log('\n========== HEAP SMOKE SUMMARY ==========');
    console.log('samples: ' + samples.length);
    console.log('wall:    ' + ((Date.now() - startMs) / 1000).toFixed(1) + 's');
    console.log('heap slope (tail):       ' + heapSlopeKBs.toFixed(3) + ' KB/s '
                + (heapSlopeKBs > HEAP_LEAK_KB_S ? '(FLAG)' : '(ok)'));
    console.log('total-heap slope (tail): ' + totalHeapSlopeKBs.toFixed(3) + ' KB/s');
    console.log('leak candidates: ' + leakCandidates.length);
    for (const c of leakCandidates) {
      console.log('  - ' + c.metric + '  slope=' + c.slope + '  delta=' + c.delta);
    }
    console.log('console.errors: ' + consoleErrors.length);
    console.log('pageerrors:     ' + pageErrors.length);
    console.log('report: ' + REPORT_PATH);

    await browser.close();
    server.close();

    const hardFail = consoleErrors.length > 0 || pageErrors.length > 0
                     || !fs.existsSync(REPORT_PATH);
    if (hardFail) {
      console.error('[smoke-heap] FAIL — consoleErrors=' + consoleErrors.length
                    + ' pageerrors=' + pageErrors.length);
      process.exit(1);
    }
    console.log('[smoke-heap] OK — report generated, no console/page errors');
  } catch (e) {
    console.error('[smoke-heap] FAIL (uncaught):', e && (e.stack || e.message || e));
    try { await browser.close(); } catch (_) {}
    try { server.close(); } catch (_) {}
    process.exit(1);
  }
}

/** Plain-English ownership hint per leaking metric. */
function _leakHint(metric) {
  switch (metric) {
    case 'enemies':
      return 'state.enemies.active push site: src/enemies.js / src/bells.js / src/catacomb.js.'
        + ' Pool is reaped in killEnemy + spawn-cap throttle. Investigate dead-but-not-removed.';
    case 'weapons':
    case 'passives':
      return 'state.weapons/passives are level-up additions; bounded by max-slot (8). >8 = bug.';
    case 'projectiles':
      return 'state.projectiles.active should drain on ttl=0 or pierce=0. Check projectiles.js cleanup.';
    case 'eProjectiles':
      return 'state.enemyProjectiles.active drain on ttl=0. Check enemyProjectiles.js cleanup.';
    case 'gems':
      return 'state.gems.list pool is reused via nextSlot wrap. Linear growth → cap broken.';
    case 'webs':
      return 'state.webs.list is timed-pool. Check web sweep in webs.js.';
    case 'dpsWin':
      return 'state.run._dpsWin trimmed in src/ui.js:957 each HUD frame. Growth means HUD tick stalled.';
    case 'pendingVolat':
      return 'state.fx.pendingVolatile consumed in src/enemies.js:1281. Growth = consumer skipped.';
    case 'domTotal':
      return 'document.* growth suggests un-removed DOM (toast / banner / portal prompt). '
        + 'Cross-check toastsLive and #kk-sealed-prompt churn.';
    case 'toastsLive':
      return '.kk-ach-toast removal racing with timer in forestAchievements.js:_pumpToastQueue. '
        + 'Likely _toastActive being clobbered before its remove timer fires.';
    default:
      return 'Inspect creation site (grep "' + metric + '") + reaper site.';
  }
}

main().catch((e) => {
  console.error('[smoke-heap] FAIL (main):', e);
  try { server.close(); } catch (_) {}
  process.exit(1);
});
