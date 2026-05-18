#!/usr/bin/env node
/**
 * PHASE 4 P4J (#140) — Telemetry harness smoke.
 *
 * Boots the game in Playwright Chromium, starts a forest run, lets it tick
 * for ~10 seconds, force-ends the run, and asserts the localStorage shape:
 *   • parses as JSON
 *   • schemaVersion present
 *   • runs[] contains at least 1 record
 *   • that record has duration > 0 + outcome populated
 *
 * Strategy notes:
 *   - We pin selectedStage='forest' BEFORE kkStartRun (same idiom as
 *     smoke-forest-v2.mjs). beginRun then captures stage='forest'.
 *   - To force a deterministic end without waiting for natural death, we
 *     stamp state.gameOver=true after the ~10s play window. tickTelemetry
 *     detects this on the next frame, calls endRun({outcome:'death'}), and
 *     the localStorage write lands synchronously.
 *   - The boot path also clears localStorage 'kks_telemetry' BEFORE the
 *     run so the assertion's "≥1 run" check can't be satisfied by a
 *     stale record from a previous smoke pass.
 *
 * No npm install. Playwright + Chromium expected at the shared cache paths,
 * same as smoke-forest-v2.mjs.
 *
 * Run: node tools/smoke-p4j-telemetry.mjs
 *
 * Port: 8775 (avoids 8771 amber + 8773 forest-v2).
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
const PORT = Number(process.env.PORT || 8775);
const BOOT_TIMEOUT_MS = 60000;
const PLAY_SECONDS = 10;
const PLAY_TIMEOUT_MS = PLAY_SECONDS * 1000;
const END_SETTLE_MS = 800;     // give tickTelemetry + tickEndRunSummary a few frames

// ── Static server (lifted from smoke-forest-v2) ────────────────────────────
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

async function main() {
  if (!fs.existsSync(PLAY_PATH)) {
    console.error('[smoke-p4j] FAIL: playwright not installed at ' + PLAY_PATH);
    console.error('[smoke-p4j] Per CLAUDE.md, smoke tools NEVER run npm install.');
    process.exit(2);
  }
  if (!fs.existsSync(PLAYWRIGHT_EXEC)) {
    console.error('[smoke-p4j] FAIL: chromium binary not found at ' + PLAYWRIGHT_EXEC);
    process.exit(2);
  }
  console.log('[smoke-p4j] playwright check: OK');

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('[smoke-p4j] server on http://127.0.0.1:' + PORT);

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

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
      console.log('[console.error]', msg.text());
    }
  });
  page.on('pageerror', (e) => {
    pageErrors.push(e.message);
    console.error('[pageerror]', e.message);
  });

  let hardFail = false;
  let failReason = '';

  try {
    const url = 'http://127.0.0.1:' + PORT + '/index.html?smoke=1';
    await page.goto(url, { waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
    console.log('[smoke-p4j] page loaded; waiting for kkStartRun');

    await page.waitForFunction(
      () => typeof window.kkStartRun === 'function',
      null,
      { timeout: BOOT_TIMEOUT_MS },
    );

    // Pin stage to Forest BEFORE start (same idiom as smoke-forest-v2.mjs).
    await page.evaluate(async () => {
      try {
        const mod = await import('./src/meta.js');
        if (mod.setOption) mod.setOption('selectedStage', 'forest');
        else if (mod.getMeta) {
          const m = mod.getMeta();
          if (m) m.selectedStage = 'forest';
        }
      } catch (e) { console.warn('[smoke-p4j] meta setOption fallback:', e && e.message); }
    });

    // CRITICAL: wipe any stale telemetry record from a prior smoke pass
    // BEFORE the run begins. tickTelemetry's begin-edge runs before this
    // would matter (it doesn't read the store), but the assertion below
    // checks runs.length so a stale entry would make the gate trivially pass.
    await page.evaluate(() => {
      try { localStorage.removeItem('kks_telemetry'); } catch (_) {}
    });

    // Start the run + publish kkState via perfHUD (same as forest-v2 smoke).
    await page.evaluate(() => {
      if (typeof window.kkPerfForceOn === 'function') window.kkPerfForceOn();
      window.kkStartRun();
    });

    await page.waitForFunction(
      () => !!window.kkState && !!window.kkState.run,
      null,
      { timeout: BOOT_TIMEOUT_MS },
    );
    console.log('[smoke-p4j] kkState live; verifying begin-edge fired');

    // Tiny settle so tickTelemetry's begin-edge has at least one frame to fire.
    await new Promise((r) => setTimeout(r, 250));

    const beganOk = await page.evaluate(() => {
      const s = window.kkState;
      return !!(s && s.run && s.run._telemetryStarted === true);
    });
    if (!beganOk) {
      console.warn('[smoke-p4j] WARN: _telemetryStarted flag not set after 250ms; continuing anyway');
    } else {
      console.log('[smoke-p4j] begin-edge OK (_telemetryStarted=true)');
    }

    // Let the game tick for ~10s. The poll-based tick fires kill / pickup /
    // levelup events naturally as the spawn director seeds enemies and gems
    // are magnetized. We don't assert on per-event counts (varies w/ spawn
    // RNG); we only assert the schema + minimum bookkeeping at the end.
    console.log('[smoke-p4j] playing ' + PLAY_SECONDS + 's...');
    await new Promise((r) => setTimeout(r, PLAY_TIMEOUT_MS));

    // Force end of run. Stamp state.gameOver=true; tickTelemetry detects the
    // edge next frame and calls endRun({outcome:'death'}).
    await page.evaluate(() => {
      const s = window.kkState;
      if (s) { s.gameOver = true; s.victory = false; }
    });
    console.log('[smoke-p4j] gameOver stamped; settling ' + END_SETTLE_MS + 'ms');
    await new Promise((r) => setTimeout(r, END_SETTLE_MS));

    // Read localStorage and parse.
    const probe = await page.evaluate(() => {
      let raw = null;
      try { raw = localStorage.getItem('kks_telemetry'); } catch (e) { return { err: 'localStorage.getItem threw: ' + e.message }; }
      if (raw == null) return { err: 'localStorage.kks_telemetry is null (endRun did not write)' };
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { return { err: 'JSON.parse threw: ' + e.message, raw: String(raw).slice(0, 200) }; }
      return { ok: true, raw, parsed };
    });

    console.log('\n========== TELEMETRY PROBE ==========');
    if (probe.err) {
      hardFail = true;
      failReason = probe.err;
      console.error('FAIL: ' + probe.err);
    } else {
      const store = probe.parsed;
      console.log('schemaVersion: ' + store.schemaVersion);
      console.log('runs.length:   ' + (store.runs ? store.runs.length : 'undefined'));

      // Assertion 1 — schemaVersion is present + numeric.
      if (typeof store.schemaVersion !== 'number') {
        hardFail = true;
        failReason = 'schemaVersion missing or not a number';
      }
      // Assertion 2 — at least 1 run record.
      else if (!Array.isArray(store.runs) || store.runs.length < 1) {
        hardFail = true;
        failReason = 'runs[] empty or not an array';
      }
      // Assertion 3 — first run has duration > 0 + outcome populated.
      else {
        const r0 = store.runs[0];
        console.log('first run:');
        console.log('  duration: ' + r0.duration);
        console.log('  outcome:  ' + r0.outcome);
        console.log('  stage:    ' + r0.stage);
        console.log('  char:     ' + r0.char);
        console.log('  counts:   ' + JSON.stringify(r0.counts));
        console.log('  weapons:  ' + JSON.stringify(r0.weapons));
        if (typeof r0.duration !== 'number' || r0.duration <= 0) {
          hardFail = true;
          failReason = 'first run duration is not > 0 (got ' + r0.duration + ')';
        } else if (!r0.outcome || typeof r0.outcome !== 'string') {
          hardFail = true;
          failReason = 'first run outcome is not a non-empty string (got ' + JSON.stringify(r0.outcome) + ')';
        } else {
          console.log('PASS: schemaVersion=' + store.schemaVersion + ', runs=' + store.runs.length
                      + ', duration=' + r0.duration.toFixed(2) + 's, outcome=' + r0.outcome);
        }
      }
    }
  } catch (e) {
    hardFail = true;
    failReason = (e && (e.stack || e.message)) || String(e);
    console.error('[smoke-p4j] uncaught:', failReason);
  }

  // Don't gate on console.errors — boot logs sometimes include benign
  // resource-load warnings under headless GL. pageerrors WOULD be fatal but
  // we surface them in the summary regardless.
  console.log('\n========== SMOKE SUMMARY ==========');
  console.log('console.errors: ' + consoleErrors.length);
  console.log('pageerrors:     ' + pageErrors.length);
  for (const e of pageErrors) console.log('  - ' + e);

  try { await browser.close(); } catch (_) {}
  try { server.close(); } catch (_) {}

  if (hardFail) {
    console.error('[smoke-p4j] FAIL: ' + failReason);
    process.exit(1);
  }
  if (pageErrors.length > 0) {
    console.error('[smoke-p4j] FAIL: ' + pageErrors.length + ' pageerror(s) during smoke');
    process.exit(1);
  }
  console.log('[smoke-p4j] OK — telemetry harness smoke passed');
}

main().catch((e) => {
  console.error('[smoke-p4j] FAIL (main):', e);
  try { server.close(); } catch (_) {}
  process.exit(1);
});
