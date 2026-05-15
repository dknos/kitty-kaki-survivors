#!/usr/bin/env node
/**
 * Smoke test InstancedMesh projectile pool.
 * Boots local server, launches Playwright, runs game 22s, screenshots,
 * captures console.error + pageerror. Reports perf snapshot.
 *
 * Run: node tools/smoke-instproj.js
 */
const path = require('path');
const http = require('http');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8769;
const WAIT_SECONDS = 22;

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
  console.log('[smoke] server on http://127.0.0.1:' + PORT);

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
    ],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
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

  await page.goto('http://127.0.0.1:' + PORT + '/index.html', { waitUntil: 'load', timeout: 30000 });
  console.log('[smoke] page loaded; waiting for boot');

  await page.waitForFunction(
    () => typeof window.kkStartRun === 'function' && window.kkState,
    null,
    { timeout: 30000 }
  );
  console.log('[smoke] boot complete; starting run');

  await page.evaluate(() => {
    if (typeof window.kkPerfForceOn === 'function') window.kkPerfForceOn();
    window.kkStartRun();
  });

  // Give run a beat to fully init, then boost spawn.
  await new Promise((r) => setTimeout(r, 1500));
  await page.evaluate(() => {
    const s = window.kkState;
    if (s && s.run) {
      s.run.weeklySpawnMul = 3.0;
      s.run.dailySpawnMul  = 3.0;
    }
  });

  console.log('[smoke] waiting ' + WAIT_SECONDS + 's for spawn/engage');
  await new Promise((r) => setTimeout(r, WAIT_SECONDS * 1000));

  const screenshotPath = path.join(__dirname, 'smoke-instproj.png');
  await page.screenshot({ path: screenshotPath, fullPage: false });
  const ssExists = fs.existsSync(screenshotPath);
  console.log('[smoke] screenshot written: ' + ssExists + ' -> ' + screenshotPath);

  const snap = await page.evaluate(() => {
    try { return window.kkPerfSnapshot ? window.kkPerfSnapshot() : null; }
    catch (e) { return { error: String(e) }; }
  });
  console.log('[smoke] kkPerfSnapshot:', JSON.stringify(snap, null, 2));

  console.log('\n========== SUMMARY ==========');
  console.log('pageerrors:', pageErrors.length);
  for (const e of pageErrors) console.log('  -', e);
  console.log('console.errors:', consoleErrors.length);
  for (const e of consoleErrors) console.log('  -', e);
  console.log('enemies:', snap && snap.enemies);
  console.log('calls:', snap && snap.calls);
  console.log('fps:', snap && snap.fps);
  console.log('ms:', snap && snap.ms);
  console.log('screenshot:', ssExists);

  await browser.close();
  server.close();
}

main().catch((e) => { console.error('[smoke] FAIL', e); process.exit(1); });
