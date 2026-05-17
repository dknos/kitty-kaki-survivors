#!/usr/bin/env node
/**
 * Headless visual smoke for Forest Stage Amber Detonation FX.
 *
 * Boots a local static server, launches full Playwright Chromium (WebGL),
 * loads index.html?smoke=1, switches to the Forest stage, starts a run,
 * triggers an amber detonation via the smoke-only debug hook, and writes
 * three PNG frames covering pre / peak / post detonation.
 *
 * Output (gitignored via tools/_thumb_*.png):
 *   tools/_thumb_forest_pre_detonation.png   — baseline forest, no FX
 *   tools/_thumb_forest_detonation.png       — at-peak detonation frame
 *   tools/_thumb_forest_post_detonation.png  — settled after FX fade
 *
 * Smoke gate:
 *   The detonation hook lives in src/forestAmber.js as _debugDetonateNearest,
 *   exposed on window.kkDetonateNearestAmber only when
 *   window.__kkSmokeEnabled === true. The harness sets that flag right after
 *   page-load and before kkStartRun, so the hook is never live in prod.
 *   The URL also carries ?smoke=1 as a secondary marker for any future gating.
 *
 * Run: node tools/smoke-forest-amber.js
 *
 * NOTE: package.json declares "type": "module" so this file is ESM. The
 * existing perf-bench.js / smoke-instproj.js use CommonJS require() and
 * currently error out on launch — this file is written ESM-first to avoid
 * that trap. Same static-server + mime helpers, same Playwright flags.
 *
 * MANUAL RUN NEEDED (2026-05-16): on the current main branch the page
 * boot errors with `module './meta.js' does not provide an export named
 * 'AVATARS'` (src/menuV2.js imports AVATARS from the wrong module — it
 * lives in src/config.js). That prevents window.kkStartRun from being
 * registered, so this harness times out on the boot wait. Fix is a
 * one-line import-path correction in src/menuV2.js, which is fenced off
 * from this PR. Once that lands, run end-to-end.
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
const PORT = Number(process.env.PORT || 8771);
const BOOT_TIMEOUT_MS = 30000;
const PRE_WAIT_MS = 3000;
const PEAK_WAIT_MS = 600;
const POST_WAIT_MS = 1500;

// ── Static server (lifted from tools/perf-bench.js + tools/smoke-instproj.js) ─
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

// ── Playwright location (must match perf-bench.js — never install here) ─────
const PLAY_PATH = '/home/nemoclaw/node_modules/playwright';
const PLAYWRIGHT_EXEC = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

function fileSize(p) {
  try { return fs.statSync(p).size; } catch (_) { return -1; }
}

async function main() {
  // Pre-flight: bail clean if playwright isn't available — never npm install.
  if (!fs.existsSync(PLAY_PATH)) {
    console.error('[smoke-forest] FAIL: playwright not installed at ' + PLAY_PATH);
    console.error('[smoke-forest] Per CLAUDE.md, smoke tools NEVER run npm install.');
    process.exit(2);
  }
  if (!fs.existsSync(PLAYWRIGHT_EXEC)) {
    console.error('[smoke-forest] FAIL: chromium binary not found at ' + PLAYWRIGHT_EXEC);
    console.error('[smoke-forest] Set PLAYWRIGHT_BROWSERS_PATH or run a manual playwright install.');
    process.exit(2);
  }

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('[smoke-forest] server on http://127.0.0.1:' + PORT);

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
    ],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const consoleWarnings = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    const t = msg.text();
    const ty = msg.type();
    if (ty === 'error') {
      consoleErrors.push(t);
      console.log('[console.error]', t);
    } else if (ty === 'warning') {
      consoleWarnings.push(t);
    }
  });
  page.on('pageerror', (e) => {
    pageErrors.push(e.message);
    console.error('[pageerror]', e.message);
  });

  const url = 'http://127.0.0.1:' + PORT + '/index.html?smoke=1';
  await page.goto(url, { waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
  console.log('[smoke-forest] page loaded; waiting for boot');

  // Wait for game globals.
  await page.waitForFunction(
    () => typeof window.kkStartRun === 'function' && window.kkState,
    null,
    { timeout: BOOT_TIMEOUT_MS },
  );
  console.log('[smoke-forest] boot complete');

  // Arm the smoke-only hook BEFORE kkStartRun so forestAmber.js sees the flag.
  await page.evaluate(() => { window.__kkSmokeEnabled = true; });

  // Pin the run to Forest. setOption('selectedStage','forest') is the
  // canonical path (matches chapter-card click in menu).
  await page.evaluate(async () => {
    try {
      const mod = await import('./src/meta.js');
      if (mod.setOption) mod.setOption('selectedStage', 'forest');
      else if (mod.getMeta) {
        const m = mod.getMeta();
        if (m) m.selectedStage = 'forest';
      }
    } catch (e) {
      console.warn('[smoke-forest] meta setOption fallback:', e && e.message);
    }
  });

  // Start the run.
  await page.evaluate(() => {
    if (typeof window.kkPerfForceOn === 'function') window.kkPerfForceOn();
    window.kkStartRun();
  });
  console.log('[smoke-forest] run started; settling ' + PRE_WAIT_MS + 'ms');
  await new Promise((r) => setTimeout(r, PRE_WAIT_MS));

  // Confirm we landed on forest. Log + continue either way — the screenshots
  // are still useful diagnostic evidence.
  const stageInfo = await page.evaluate(() => {
    const s = window.kkState;
    if (!s || !s.run || !s.run.stage) return { stage: null };
    return { stage: s.run.stage.id || null, mode: s.mode || null };
  });
  console.log('[smoke-forest] stage check:', JSON.stringify(stageInfo));

  // Screenshot 1 — baseline before detonation.
  const ssPre = path.join(__dirname, '_thumb_forest_pre_detonation.png');
  await page.screenshot({ path: ssPre, fullPage: false });
  console.log('[smoke-forest] wrote pre  -> ' + ssPre + ' (' + fileSize(ssPre) + ' bytes)');

  // Trigger detonation on the amber nearest to the hero.
  const detRes = await page.evaluate(() => {
    if (typeof window.kkDetonateNearestAmber !== 'function') {
      return { ok: false, reason: 'hook not present (smoke gate?)' };
    }
    const s = window.kkState;
    const hx = (s && s.hero && s.hero.pos && s.hero.pos.x) || 0;
    const hz = (s && s.hero && s.hero.pos && s.hero.pos.z) || 0;
    try {
      const r = window.kkDetonateNearestAmber(hx, hz);
      return { ok: !!r, target: r, hero: { x: hx, z: hz } };
    } catch (e) {
      return { ok: false, reason: String(e) };
    }
  });
  console.log('[smoke-forest] detonate:', JSON.stringify(detRes));

  // Screenshot 2 — peak frame.
  await new Promise((r) => setTimeout(r, PEAK_WAIT_MS));
  const ssDet = path.join(__dirname, '_thumb_forest_detonation.png');
  await page.screenshot({ path: ssDet, fullPage: false });
  console.log('[smoke-forest] wrote peak -> ' + ssDet + ' (' + fileSize(ssDet) + ' bytes)');

  // Screenshot 3 — settled after FX fade.
  await new Promise((r) => setTimeout(r, POST_WAIT_MS));
  const ssPost = path.join(__dirname, '_thumb_forest_post_detonation.png');
  await page.screenshot({ path: ssPost, fullPage: false });
  console.log('[smoke-forest] wrote post -> ' + ssPost + ' (' + fileSize(ssPost) + ' bytes)');

  // Summary
  console.log('\n========== SUMMARY ==========');
  console.log('stage:           ' + stageInfo.stage);
  console.log('detonate target: ' + (detRes.target ? JSON.stringify(detRes.target) : '(none)'));
  console.log('pageerrors:      ' + pageErrors.length);
  for (const e of pageErrors) console.log('  -', e);
  console.log('console.errors:  ' + consoleErrors.length);
  for (const e of consoleErrors) console.log('  -', e);
  console.log('console.warns:   ' + consoleWarnings.length);
  console.log('screenshots:');
  console.log('  pre:  ' + fileSize(ssPre)  + ' bytes  ' + ssPre);
  console.log('  peak: ' + fileSize(ssDet)  + ' bytes  ' + ssDet);
  console.log('  post: ' + fileSize(ssPost) + ' bytes  ' + ssPost);

  await browser.close();
  server.close();

  // Exit non-zero on hard failure: pageerror, or any screenshot missing.
  // Detonation gate miss is logged but non-fatal — the screenshots remain
  // useful diagnostic evidence either way.
  const allShotsOk = fileSize(ssPre) > 0 && fileSize(ssDet) > 0 && fileSize(ssPost) > 0;
  if (pageErrors.length > 0 || !allShotsOk) {
    console.error('[smoke-forest] FAIL: pageerrors=' + pageErrors.length + ' allShotsOk=' + allShotsOk);
    process.exit(1);
  }
  console.log('[smoke-forest] OK');
}

main().catch((e) => {
  console.error('[smoke-forest] FAIL', e);
  try { server.close(); } catch (_) {}
  process.exit(1);
});
