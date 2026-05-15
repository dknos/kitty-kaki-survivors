#!/usr/bin/env node
/**
 * Headless perf harness for kitty-kaki-survivors.
 *
 * 1. Starts a local static server on PORT (default 8765) rooted at repo top.
 * 2. Launches Playwright Chromium (full, not headless-shell, for WebGL).
 * 3. Loads index.html, calls window.kkStartRun(), boosts spawnMul, samples
 *    window.kkPerfSnapshot() for SAMPLE_SECONDS.
 * 4. Reports FPS / ms / calls / enemies summary + sorted ms breakdown.
 *
 * Run: node tools/perf-bench.js [spawnMul] [seconds]
 */
const path = require('path');
const http = require('http');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8765);
const SPAWN_MUL = Number(process.argv[2] || 2.0);
const SECONDS = Number(process.argv[3] || 45);

// ── Static server ────────────────────────────────────────────────────────────
function mime(p) {
  if (p.endsWith('.js'))   return 'application/javascript';
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

async function main() {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('[bench] server on http://127.0.0.1:' + PORT);

  // Locate playwright module (installed globally at ~/node_modules).
  const PLAY_PATH = '/home/nemoclaw/node_modules/playwright';
  const { chromium } = require(PLAY_PATH);
  const executablePath = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-webgpu',
    ],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('console', (msg) => {
    const t = msg.text();
    if (!/\bDEBUG\b|404|favicon/.test(t)) console.log('[page]', t);
  });
  page.on('pageerror', (e) => console.error('[page-err]', e.message));

  await page.goto('http://127.0.0.1:' + PORT + '/index.html', { waitUntil: 'load', timeout: 30000 });
  console.log('[bench] page loaded; waiting for boot');

  // Wait for game globals.
  await page.waitForFunction(() => typeof window.kkStartRun === 'function' && typeof window.kkPerfSnapshot === 'function' && window.kkState, null, { timeout: 30000 });
  console.log('[bench] boot complete; starting run');

  await page.evaluate((mul) => {
    window.kkPerfForceOn();
    window.kkStartRun();
    setTimeout(() => {
      const s = window.kkState;
      if (s && s.run) {
        s.run.weeklySpawnMul = mul;
        s.run.dailySpawnMul  = mul;
      }
    }, 1500);
  }, SPAWN_MUL);

  console.log('[bench] sampling for ' + SECONDS + 's at spawnMul=' + SPAWN_MUL);
  const samples = [];
  const startT = Date.now();
  while ((Date.now() - startT) < SECONDS * 1000) {
    const snap = await page.evaluate(() => window.kkPerfSnapshot());
    snap.t = +((Date.now() - startT) / 1000).toFixed(1);
    samples.push(snap);
    process.stdout.write(`\r[bench] t=${snap.t.toFixed(1)}s  FPS=${snap.fps}  ms=${snap.ms}  calls=${snap.calls}  enemies=${snap.enemies}     `);
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('');

  // Summary
  const valid = samples.filter((s) => s.fps > 0);
  const maxEnemies = Math.max(...valid.map((s) => s.enemies));
  const peakSample = valid.reduce((a, b) => (b.ms > a.ms ? b : a));
  const minFpsSample = valid.reduce((a, b) => (b.fps < a.fps ? b : a));
  console.log('\n========== PEAK STRESS SAMPLE ==========');
  console.log(`max enemies: ${maxEnemies}`);
  console.log(`peak ms:     ${peakSample.ms} ms (t=${peakSample.t}s, FPS ${peakSample.fps}, enemies ${peakSample.enemies}, calls ${peakSample.calls})`);
  console.log(`min FPS:     ${minFpsSample.fps} (t=${minFpsSample.t}s, ms ${minFpsSample.ms}, enemies ${minFpsSample.enemies}, calls ${minFpsSample.calls})`);

  const sortedSlow = valid.slice().sort((a, b) => b.ms - a.ms).slice(0, 5);
  console.log('\n--- top 5 slowest frames (per-subsystem ms) ---');
  for (const s of sortedSlow) {
    console.log(`t=${s.t}s  FPS=${s.fps}  ms=${s.ms}  enemies=${s.enemies}  calls=${s.calls}`);
    const entries = Object.entries(s.breakdown || {}).filter(([, v]) => v >= 0.02).sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [k, v] of entries) console.log(`  ${k.padEnd(14)} ${v.toFixed(2)}ms`);
  }

  // Average breakdown across the dip (worst quartile by ms)
  valid.sort((a, b) => b.ms - a.ms);
  const worstQ = valid.slice(0, Math.max(1, Math.floor(valid.length / 4)));
  const avgBreak = {};
  for (const s of worstQ) {
    for (const [k, v] of Object.entries(s.breakdown || {})) {
      avgBreak[k] = (avgBreak[k] || 0) + v;
    }
  }
  for (const k in avgBreak) avgBreak[k] = +(avgBreak[k] / worstQ.length).toFixed(2);
  console.log(`\n--- avg per-subsystem ms across worst quartile (n=${worstQ.length}) ---`);
  const sortedBreak = Object.entries(avgBreak).sort((a, b) => b[1] - a[1]);
  for (const [k, v] of sortedBreak) if (v >= 0.05) console.log(`  ${k.padEnd(14)} ${v.toFixed(2)}ms`);

  await browser.close();
  server.close();
}

main().catch((e) => { console.error('[bench] FAIL', e); process.exit(1); });
