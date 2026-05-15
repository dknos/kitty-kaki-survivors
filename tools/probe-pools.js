#!/usr/bin/env node
/**
 * Load the game headlessly, wait for boot, dump kkPoolProbe() — mesh/material/
 * tri counts per enemy GLB pool. Tells us where the draw-call budget goes.
 */
const path = require('path');
const http = require('http');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8766;

function mime(p) {
  if (p.endsWith('.js'))   return 'application/javascript';
  if (p.endsWith('.html')) return 'text/html';
  if (p.endsWith('.css'))  return 'text/css';
  if (p.endsWith('.json')) return 'application/json';
  if (p.endsWith('.glb'))  return 'model/gltf-binary';
  if (p.endsWith('.png'))  return 'image/png';
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
  if (p.endsWith('.svg'))  return 'image/svg+xml';
  if (p.endsWith('.mp3') || p.endsWith('.wav') || p.endsWith('.ogg')) return 'audio/mpeg';
  return 'application/octet-stream';
}
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const full = path.join(ROOT, rel);
  if (!full.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': mime(full), 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

async function main() {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const { chromium } = require('/home/nemoclaw/node_modules/playwright');
  const browser = await chromium.launch({
    executablePath: '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-webgl'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('[err]', e.message));
  await page.goto('http://127.0.0.1:' + PORT + '/index.html', { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => typeof window.kkStartRun === 'function' && typeof window.kkPoolProbe === 'function', null, { timeout: 30000 });
  await page.evaluate(() => window.kkStartRun());
  // Wait for pools to prewarm.
  await new Promise((r) => setTimeout(r, 6000));
  const probe = await page.evaluate(() => window.kkPoolProbe());
  console.log('\n=== POOL PROBE ===');
  const rows = Object.entries(probe).sort((a, b) => b[1].meshes - a[1].meshes);
  console.log('pool         meshes  mats  tris');
  for (const [k, v] of rows) {
    console.log(`${k.padEnd(12)} ${String(v.meshes).padStart(6)}  ${String(v.mats).padStart(4)}  ${String(v.tris).padStart(5)}`);
  }
  // Total mesh→draw-call burden scaling estimate
  const totals = rows.reduce((acc, [, v]) => ({ meshes: acc.meshes + v.meshes, mats: acc.mats + v.mats }), { meshes: 0, mats: 0 });
  console.log(`\ntotal across pools: meshes=${totals.meshes} mats=${totals.mats}`);
  const avg = rows.length > 0 ? (totals.meshes / rows.length).toFixed(2) : 'n/a';
  console.log(`avg draw-cost per enemy if scene-graph traverse drives calls: ~${avg} calls/enemy`);
  await browser.close();
  server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
