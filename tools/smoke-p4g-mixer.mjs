#!/usr/bin/env node
/**
 * PHASE 4 P4G (#141) — Audio mixer smoke.
 *
 * Boots the game in Playwright Chromium and verifies the 4-bus mixer:
 *
 *   1. Post-boot, all 4 GainNodes exist (master / music / sfx / ambient).
 *   2. Setting a bus volume to 0 sets gainNode.gain.value === 0 but the
 *      underlying play() call STILL FIRES — verified via _debug.counts() delta.
 *      This is the P4G mute-≠-skip acceptance.
 *   3. localStorage round-trip — set each slider, reload, slider position
 *      restored from meta.opt{Master,Music,Sfx,Ambient}Volume.
 *   4. Schema — meta.optMusicVolume / optSfxVolume / optAmbientVolume /
 *      optMasterVolume are all readable through meta.getMeta().
 *
 * Strategy notes:
 *   - We launch Chromium with --autoplay-policy=no-user-gesture-required so
 *     the AudioContext is "running" without a synthetic user gesture. Our
 *     play paths bail when ctx.state !== 'running', so this is the cheapest
 *     way to make _play() actually exercise.
 *   - We import './src/audio.js' inside page.evaluate() so we can call
 *     unlockAudio() + setMasterVolume(0) etc directly. window.kkAudioDebug
 *     is wired from main.js boot (debug surface).
 *   - For the mute-≠-skip test, we mute each bus, snapshot count, trigger
 *     one play through each bus, settle ~50ms, and assert count went up
 *     by at least 1. SFX is easiest (sfx.uiClick); music goes through the
 *     procedural playNote (we hit it via startMusic + a step settle); ambient
 *     goes through playStageAmbient('forest') → forest day/night phase init.
 *
 * No npm install. Playwright + Chromium expected at the shared cache paths,
 * same as smoke-p4j-telemetry.mjs.
 *
 * Run: node tools/smoke-p4g-mixer.mjs
 *
 * Port: 8776 (avoids 8771 amber, 8773 forest-v2, 8775 telemetry).
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
const PORT = Number(process.env.PORT || 8776);
const BOOT_TIMEOUT_MS = 60000;
const SETTLE_MS = 250;

// ── Static server (lifted from smoke-p4j-telemetry) ────────────────────────
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

function fail(msg) { console.error('[smoke-p4g] FAIL: ' + msg); }

async function main() {
  if (!fs.existsSync(PLAY_PATH)) {
    console.error('[smoke-p4g] FAIL: playwright not installed at ' + PLAY_PATH);
    console.error('[smoke-p4g] Per CLAUDE.md, smoke tools NEVER run npm install.');
    process.exit(2);
  }
  if (!fs.existsSync(PLAYWRIGHT_EXEC)) {
    console.error('[smoke-p4g] FAIL: chromium binary not found at ' + PLAYWRIGHT_EXEC);
    process.exit(2);
  }
  console.log('[smoke-p4g] playwright check: OK');

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('[smoke-p4g] server on http://127.0.0.1:' + PORT);

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
      // CRITICAL — without this, AudioContext starts suspended; our _play
      // paths bail at ctx.state !== 'running' and the mute-≠-skip assertion
      // would trivially pass (counters stay 0 in both branches).
      '--autoplay-policy=no-user-gesture-required',
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
    console.log('[smoke-p4g] page loaded; waiting for kkAudioDebug');

    await page.waitForFunction(
      () => typeof window.kkAudioDebug === 'object' && window.kkAudioDebug !== null,
      null,
      { timeout: BOOT_TIMEOUT_MS },
    );

    // Click to satisfy any leftover user-gesture gates and unlock the audio
    // context for good measure. With --autoplay-policy this is belt + braces.
    await page.click('body', { force: true }).catch(() => {});
    await page.evaluate(async () => {
      const m = await import('./src/audio.js');
      m.unlockAudio();
    });
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    // ─── Assertion 1: all 4 GainNodes exist post-boot ────────────────────
    const busShape = await page.evaluate(() => {
      const b = window.kkAudioDebug.buses();
      return {
        master:  !!(b.master  && typeof b.master.gain  === 'object'),
        music:   !!(b.music   && typeof b.music.gain   === 'object'),
        sfx:     !!(b.sfx     && typeof b.sfx.gain     === 'object'),
        ambient: !!(b.ambient && typeof b.ambient.gain === 'object'),
      };
    });
    console.log('\n========== ASSERTION 1: bus existence ==========');
    console.log('master:  ' + busShape.master);
    console.log('music:   ' + busShape.music);
    console.log('sfx:     ' + busShape.sfx);
    console.log('ambient: ' + busShape.ambient);
    for (const k of ['master', 'music', 'sfx', 'ambient']) {
      if (!busShape[k]) failures.push('bus "' + k + '" missing or no .gain');
    }

    // ─── Assertion 2: mute = 0 amplitude, NOT skip ───────────────────────
    // For each non-master bus, set its gain to 0, snapshot _play counts,
    // trigger one play on that bus, settle, assert count went up.
    console.log('\n========== ASSERTION 2: mute-≠-skip ==========');

    // SFX bus mute test
    const sfxResult = await page.evaluate(async () => {
      const a = await import('./src/audio.js');
      a.setSfxVolume(0);
      const before = window.kkAudioDebug.counts().sfx;
      const gainBefore = window.kkAudioDebug.buses().sfx.gain.value;
      // Fire a UI sfx — goes through _play('uiClick') → _sfxBus.
      try { a.sfx.uiClick(); } catch (_) {}
      // Settle: _play schedules at ctx.currentTime, counter bumps synchronously.
      await new Promise((r) => setTimeout(r, 100));
      const after = window.kkAudioDebug.counts().sfx;
      return { before, after, gain: gainBefore };
    });
    console.log('SFX  mute: gain=' + sfxResult.gain + ', counts ' + sfxResult.before + ' → ' + sfxResult.after);
    if (sfxResult.gain !== 0) failures.push('SFX gain not 0 after setSfxVolume(0): ' + sfxResult.gain);
    if (sfxResult.after <= sfxResult.before) failures.push('SFX play did not fire when muted (count delta=' + (sfxResult.after - sfxResult.before) + ')');

    // Music bus mute test — startMusic spawns a setInterval that calls
    // playNote on beat 0; one step is ~272ms (110bpm 8ths). We wait ~400ms
    // so at least one note scheduled.
    const musicResult = await page.evaluate(async () => {
      const a = await import('./src/audio.js');
      a.setMusicVolume(0);
      window.kkAudioDebug.resetCounts();
      const gainBefore = window.kkAudioDebug.buses().music.gain.value;
      a.startMusic();
      await new Promise((r) => setTimeout(r, 600));
      a.stopMusic();
      const after = window.kkAudioDebug.counts().music;
      return { after, gain: gainBefore };
    });
    console.log('Music mute: gain=' + musicResult.gain + ', count after 600ms = ' + musicResult.after);
    if (musicResult.gain !== 0) failures.push('Music gain not 0 after setMusicVolume(0): ' + musicResult.gain);
    if (musicResult.after < 1) failures.push('Music play did not fire when muted (count=' + musicResult.after + ')');

    // Ambient bus mute test — playStageAmbient('forest') triggers
    // music.setForestPhase('midday') → _forestSlotInit → newSlot.el.play().
    // _playCounts.ambient bumps inside setForestPhase BEFORE play(); on a
    // ctx that's running we should see an increment regardless of element
    // load timing.
    const ambientResult = await page.evaluate(async () => {
      const a = await import('./src/audio.js');
      a.setAmbientVolume(0);
      // Tear down any stale forest music slot from prior boot — playStageAmbient
      // may have been invoked on a previous start path; the early-return guard
      // (`_forestCurrentPhase === phase && _forestActiveIdx >= 0`) would skip
      // re-init if so, and our counter wouldn't bump.
      try { a.music._teardownForestMusic(); } catch (_) {}
      window.kkAudioDebug.resetCounts();
      const gainBefore = window.kkAudioDebug.buses().ambient.gain.value;
      try { a.playStageAmbient('forest'); } catch (_) {}
      await new Promise((r) => setTimeout(r, 400));
      const after = window.kkAudioDebug.counts().ambient;
      return { after, gain: gainBefore };
    });
    console.log('Ambient mute: gain=' + ambientResult.gain + ', count after 400ms = ' + ambientResult.after);
    if (ambientResult.gain !== 0) failures.push('Ambient gain not 0 after setAmbientVolume(0): ' + ambientResult.gain);
    if (ambientResult.after < 1) failures.push('Ambient play did not fire when muted (count=' + ambientResult.after + ')');

    // ─── Assertion 3: localStorage round-trip ────────────────────────────
    console.log('\n========== ASSERTION 3: localStorage round-trip ==========');
    await page.evaluate(async () => {
      const meta = await import('./src/meta.js');
      meta.setOption('optMasterVolume',  0.42);
      meta.setOption('optMusicVolume',   0.13);
      meta.setOption('optSfxVolume',     0.71);
      meta.setOption('optAmbientVolume', 0.27);
    });
    // Reload and read back.
    await page.reload({ waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
    await page.waitForFunction(
      () => typeof window.kkAudioDebug === 'object' && window.kkAudioDebug !== null,
      null,
      { timeout: BOOT_TIMEOUT_MS },
    );
    const persisted = await page.evaluate(async () => {
      const meta = await import('./src/meta.js');
      const m = meta.getMeta();
      return {
        master:  m.optMasterVolume,
        music:   m.optMusicVolume,
        sfx:     m.optSfxVolume,
        ambient: m.optAmbientVolume,
      };
    });
    console.log('after reload:');
    console.log('  optMasterVolume:  ' + persisted.master);
    console.log('  optMusicVolume:   ' + persisted.music);
    console.log('  optSfxVolume:     ' + persisted.sfx);
    console.log('  optAmbientVolume: ' + persisted.ambient);
    const EPS = 0.001;
    if (Math.abs(persisted.master  - 0.42) > EPS) failures.push('optMasterVolume not persisted (' + persisted.master + ')');
    if (Math.abs(persisted.music   - 0.13) > EPS) failures.push('optMusicVolume not persisted ('  + persisted.music  + ')');
    if (Math.abs(persisted.sfx     - 0.71) > EPS) failures.push('optSfxVolume not persisted ('    + persisted.sfx    + ')');
    if (Math.abs(persisted.ambient - 0.27) > EPS) failures.push('optAmbientVolume not persisted (' + persisted.ambient + ')');

    // ─── Assertion 4: schema readability ──────────────────────────────────
    console.log('\n========== ASSERTION 4: schema readability ==========');
    const schema = await page.evaluate(async () => {
      const meta = await import('./src/meta.js');
      const m = meta.getMeta();
      return {
        masterType:  typeof m.optMasterVolume,
        musicType:   typeof m.optMusicVolume,
        sfxType:     typeof m.optSfxVolume,
        ambientType: typeof m.optAmbientVolume,
      };
    });
    console.log('  optMasterVolume:  ' + schema.masterType);
    console.log('  optMusicVolume:   ' + schema.musicType);
    console.log('  optSfxVolume:     ' + schema.sfxType);
    console.log('  optAmbientVolume: ' + schema.ambientType);
    for (const [k, t] of Object.entries(schema)) {
      if (t !== 'number') failures.push('schema field ' + k + ' is not number (' + t + ')');
    }

  } catch (e) {
    failures.push('uncaught: ' + ((e && (e.stack || e.message)) || String(e)));
    console.error('[smoke-p4g] uncaught:', e);
  }

  console.log('\n========== SMOKE SUMMARY ==========');
  console.log('console.errors: ' + consoleErrors.length);
  console.log('pageerrors:     ' + pageErrors.length);
  for (const e of pageErrors) console.log('  - ' + e);

  try { await browser.close(); } catch (_) {}
  try { server.close(); } catch (_) {}

  if (failures.length) {
    for (const f of failures) fail(f);
    console.error('[smoke-p4g] FAIL: ' + failures.length + ' assertion(s) failed');
    process.exit(1);
  }
  if (pageErrors.length > 0) {
    console.error('[smoke-p4g] FAIL: ' + pageErrors.length + ' pageerror(s) during smoke');
    process.exit(1);
  }
  console.log('[smoke-p4g] OK — audio mixer smoke passed');
}

main().catch((e) => {
  console.error('[smoke-p4g] FAIL (main):', e);
  try { server.close(); } catch (_) {}
  process.exit(1);
});
