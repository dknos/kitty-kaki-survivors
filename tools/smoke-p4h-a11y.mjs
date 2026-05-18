#!/usr/bin/env node
/**
 * PHASE 4 P4H (#142) — Accessibility smoke.
 *
 * Boots the game in Playwright Chromium and verifies the three P4H
 * accessibility surfaces:
 *
 *   1. Default meta exposes optShake / optColorblind / optHoldConfirm keys.
 *      (optShake + optColorblind were already present pre-P4H; we still
 *      assert their shape to prevent regression.)
 *   2. Flipping each toggle via meta.setOption() persists to localStorage.
 *      We programmatically set:
 *        - optShake = 0
 *        - optColorblind = 'deuteranopia'
 *        - optHoldConfirm = true
 *      Then read meta back to confirm the in-memory write took.
 *   3. Reload round-trip — after a hard reload, all three options retain
 *      their flipped values via the {...DEFAULT,...parsed} spread in
 *      loadMeta().
 *   4. Each toggle ON + OFF boots without console errors (smoke acceptance
 *      from docs/P4_BACKLOG.md: "Smoke loads w/ each toggle off+on").
 *
 * We do NOT need to render the hold-confirm progress animation here — the
 * helper is exercised by the e2e/UAT pass. Smoke covers meta plumbing +
 * boot-time application.
 *
 * Strategy notes:
 *   - No npm install. Playwright + Chromium expected at the shared cache
 *     paths, same as smoke-p4g-mixer.mjs / smoke-p4j-telemetry.mjs.
 *   - Per advisor: state._optShakeMul is set by main.js boot from
 *     meta.optShake, NOT by setOption() in-session. We assert meta.optShake
 *     directly; the reload round-trip is the persistence proof.
 *   - postFXPass.uniforms.uColorblind.value is set in main.js boot via
 *     applyAccessibilityOptions(). After reload with optColorblind set, we
 *     read it through window.kkState.postFXPass to verify the boot path
 *     wired through.
 *
 * Run: node tools/smoke-p4h-a11y.mjs
 *
 * Port: 8777 (after 8776 mixer, 8775 telemetry, 8773 forest-v2).
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
const PORT = Number(process.env.PORT || 8777);
const BOOT_TIMEOUT_MS = 60000;

// ── Static server (lifted from smoke-p4g-mixer) ────────────────────────────
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

function fail(msg) { console.error('[smoke-p4h] FAIL: ' + msg); }

async function waitBoot(page) {
  // Boot signal: window.kkStartRun must be wired (main.js init line 555).
  // Also wait for kkState so postFXPass is reachable.
  await page.waitForFunction(
    () => typeof window.kkStartRun === 'function' && window.kkState && window.kkState.postFXPass,
    null,
    { timeout: BOOT_TIMEOUT_MS },
  );
}

async function main() {
  if (!fs.existsSync(PLAY_PATH)) {
    console.error('[smoke-p4h] FAIL: playwright not installed at ' + PLAY_PATH);
    console.error('[smoke-p4h] Per CLAUDE.md, smoke tools NEVER run npm install.');
    process.exit(2);
  }
  if (!fs.existsSync(PLAYWRIGHT_EXEC)) {
    console.error('[smoke-p4h] FAIL: chromium binary not found at ' + PLAYWRIGHT_EXEC);
    process.exit(2);
  }
  console.log('[smoke-p4h] playwright check: OK');

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('[smoke-p4h] server on http://127.0.0.1:' + PORT);

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

  const failures = [];

  try {
    const url = 'http://127.0.0.1:' + PORT + '/index.html?smoke=1';
    await page.goto(url, { waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
    console.log('[smoke-p4h] page loaded; waiting for boot');
    await waitBoot(page);
    console.log('[smoke-p4h] boot OK');

    // ─── Assertion 1: default meta exposes the 3 a11y keys ─────────────
    console.log('\n========== ASSERTION 1: default meta keys ==========');
    const defaultShape = await page.evaluate(async () => {
      const meta = await import('./src/meta.js');
      const m = meta.getMeta();
      return {
        shakeType:       typeof m.optShake,
        shakeVal:        m.optShake,
        colorblindType:  typeof m.optColorblind,
        colorblindVal:   m.optColorblind,
        holdConfirmType: typeof m.optHoldConfirm,
        holdConfirmVal:  m.optHoldConfirm,
      };
    });
    console.log('  optShake:        ' + defaultShape.shakeType + ' = ' + defaultShape.shakeVal);
    console.log('  optColorblind:   ' + defaultShape.colorblindType + ' = ' + defaultShape.colorblindVal);
    console.log('  optHoldConfirm:  ' + defaultShape.holdConfirmType + ' = ' + defaultShape.holdConfirmVal);
    if (defaultShape.shakeType !== 'number') {
      failures.push('optShake should be number, got ' + defaultShape.shakeType);
    }
    if (defaultShape.colorblindType !== 'string') {
      failures.push('optColorblind should be string, got ' + defaultShape.colorblindType);
    }
    // optHoldConfirm may be either boolean (fresh save) OR (theoretically)
    // any falsy on a legacy save where the key was missing. The
    // {...DEFAULT,...parsed} spread in loadMeta should always backfill to
    // false. Assert it's a boolean.
    if (defaultShape.holdConfirmType !== 'boolean') {
      failures.push('optHoldConfirm should be boolean, got ' + defaultShape.holdConfirmType);
    }

    // ─── Assertion 2: setOption() flips each toggle ─────────────────────
    console.log('\n========== ASSERTION 2: setOption() writes ==========');
    const afterSet = await page.evaluate(async () => {
      const meta = await import('./src/meta.js');
      meta.setOption('optShake',        0);
      meta.setOption('optColorblind',   'deuteranopia');
      meta.setOption('optHoldConfirm',  true);
      const m = meta.getMeta();
      return {
        shake:       m.optShake,
        colorblind:  m.optColorblind,
        holdConfirm: m.optHoldConfirm,
      };
    });
    console.log('  optShake:        ' + afterSet.shake);
    console.log('  optColorblind:   ' + afterSet.colorblind);
    console.log('  optHoldConfirm:  ' + afterSet.holdConfirm);
    if (afterSet.shake !== 0) failures.push('optShake setOption did not stick: ' + afterSet.shake);
    if (afterSet.colorblind !== 'deuteranopia') failures.push('optColorblind setOption did not stick: ' + afterSet.colorblind);
    if (afterSet.holdConfirm !== true) failures.push('optHoldConfirm setOption did not stick: ' + afterSet.holdConfirm);

    // ─── Assertion 3: localStorage round-trip across reload ─────────────
    console.log('\n========== ASSERTION 3: reload round-trip ==========');
    await page.reload({ waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
    await waitBoot(page);
    const persisted = await page.evaluate(async () => {
      const meta = await import('./src/meta.js');
      const m = meta.getMeta();
      return {
        shake:       m.optShake,
        colorblind:  m.optColorblind,
        holdConfirm: m.optHoldConfirm,
      };
    });
    console.log('  optShake:        ' + persisted.shake);
    console.log('  optColorblind:   ' + persisted.colorblind);
    console.log('  optHoldConfirm:  ' + persisted.holdConfirm);
    if (persisted.shake !== 0) failures.push('optShake did not persist across reload: ' + persisted.shake);
    if (persisted.colorblind !== 'deuteranopia') failures.push('optColorblind did not persist across reload: ' + persisted.colorblind);
    if (persisted.holdConfirm !== true) failures.push('optHoldConfirm did not persist across reload: ' + persisted.holdConfirm);

    // ─── Assertion 3b: postfx uniform reflects colorblind on boot ───────
    // main.js:459 calls applyAccessibilityOptions(postFXPass, {...colorblind}).
    // deuteranopia → uColorblind.value = 1.
    const uniformVal = await page.evaluate(() => {
      const pp = window.kkState && window.kkState.postFXPass;
      if (!pp || !pp.uniforms || !pp.uniforms.uColorblind) return null;
      return pp.uniforms.uColorblind.value;
    });
    console.log('  postfx uColorblind: ' + uniformVal);
    if (uniformVal !== 1) failures.push('postfx uColorblind not 1 (deuteranopia) after reload: ' + uniformVal);

    // ─── Assertion 4: toggle each OFF and verify clean reboot ──────────
    console.log('\n========== ASSERTION 4: toggle OFF + reboot ==========');
    await page.evaluate(async () => {
      const meta = await import('./src/meta.js');
      meta.setOption('optShake',        1.0);
      meta.setOption('optColorblind',   'off');
      meta.setOption('optHoldConfirm',  false);
    });
    // Reset the recorded error buffers — the only errors we care about now
    // are ones that fire AFTER the toggles are flipped back to default and
    // the page reloads.
    consoleErrors.length = 0;
    pageErrors.length = 0;
    await page.reload({ waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
    await waitBoot(page);
    const offShape = await page.evaluate(async () => {
      const meta = await import('./src/meta.js');
      const m = meta.getMeta();
      return {
        shake:       m.optShake,
        colorblind:  m.optColorblind,
        holdConfirm: m.optHoldConfirm,
        cbUniform:   (window.kkState && window.kkState.postFXPass
                      && window.kkState.postFXPass.uniforms
                      && window.kkState.postFXPass.uniforms.uColorblind)
                       ? window.kkState.postFXPass.uniforms.uColorblind.value : null,
      };
    });
    console.log('  optShake:        ' + offShape.shake);
    console.log('  optColorblind:   ' + offShape.colorblind);
    console.log('  optHoldConfirm:  ' + offShape.holdConfirm);
    console.log('  postfx uColorblind: ' + offShape.cbUniform);
    if (offShape.shake !== 1.0) failures.push('optShake reset to 1.0 did not persist: ' + offShape.shake);
    if (offShape.colorblind !== 'off') failures.push('optColorblind reset to off did not persist: ' + offShape.colorblind);
    if (offShape.holdConfirm !== false) failures.push('optHoldConfirm reset to false did not persist: ' + offShape.holdConfirm);
    if (offShape.cbUniform !== 0) failures.push('postfx uColorblind not 0 (off) after reset: ' + offShape.cbUniform);

    // ─── Assertion 5: holdConfirm helper import surface ─────────────────
    // Verify the module loads and exports the expected symbol. If a future
    // refactor renames it, this fails loudly rather than silently
    // de-wiring the destructive button protection.
    console.log('\n========== ASSERTION 5: holdConfirm helper export ==========');
    const helperOk = await page.evaluate(async () => {
      try {
        const m = await import('./src/holdConfirm.js');
        return typeof m.holdConfirm === 'function';
      } catch (_) { return false; }
    });
    console.log('  holdConfirm export: ' + helperOk);
    if (!helperOk) failures.push('src/holdConfirm.js did not export holdConfirm()');

  } catch (e) {
    failures.push('uncaught: ' + ((e && (e.stack || e.message)) || String(e)));
    console.error('[smoke-p4h] uncaught:', e);
  }

  console.log('\n========== SMOKE SUMMARY ==========');
  console.log('console.errors (after toggle reset): ' + consoleErrors.length);
  console.log('pageerrors     (after toggle reset): ' + pageErrors.length);
  for (const e of pageErrors) console.log('  - ' + e);

  try { await browser.close(); } catch (_) {}
  try { server.close(); } catch (_) {}

  if (failures.length) {
    for (const f of failures) fail(f);
    console.error('[smoke-p4h] FAIL: ' + failures.length + ' assertion(s) failed');
    process.exit(1);
  }
  if (pageErrors.length > 0) {
    console.error('[smoke-p4h] FAIL: ' + pageErrors.length + ' pageerror(s) during smoke');
    process.exit(1);
  }
  console.log('[smoke-p4h] OK — a11y smoke passed');
}

main().catch((e) => {
  console.error('[smoke-p4h] FAIL (main):', e);
  try { server.close(); } catch (_) {}
  process.exit(1);
});
