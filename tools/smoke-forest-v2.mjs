#!/usr/bin/env node
/**
 * Expanded Forest visual regression smoke (FOREST-V2-A15, 2026-05-17).
 *
 * After 14 content cohorts (rooms, landmarks, neutrals, coffins, hazards,
 * chests, reaper, pickups, daynight, hud, bossbars, levelup-economy, sfx,
 * sealdoors) we need a regression QA gate. This single script boots the
 * game in Playwright Chromium, captures 4 diagnostic screenshots covering
 * the major new systems, and fails loudly on any boot break, console
 * error, missing HUD element, or low FPS.
 *
 * Output (gitignored via tools/_thumb_*.png):
 *   tools/_thumb_forest_phase_1_glade.png       — boot, hero in glade hub
 *   tools/_thumb_forest_phase_2_sealedroom.png  — hero in sealed mossroot
 *   tools/_thumb_forest_phase_3_goldenhour.png  — t=700s, golden-hour fog
 *   tools/_thumb_forest_phase_4_reaperwarn.png  — t=1780s, REAPER IN + tint
 *
 * Per-phase assertion gates (see PHASE COMMENTARY below for rationale):
 *   1. HUD root #kk-forest-hud exists + has child text containing ':'
 *      (HH:MM clock — proves the HUD mounted and is ticking).
 *   2. state.enemies.active contains >=1 enemy with _isRoomBoss === true,
 *      AND the return portal for mossroot has portal._sealed === true.
 *      _sealed is the canonical system flag (set by _applySealVisual);
 *      preferred over getHex() comparison to the mint constant because
 *      it's robust to palette tweaks.
 *   3. scene.fog.color differs from the phase-1 baseline by >5% in any
 *      channel (proxy for day/night shift active). Baseline is snapshotted
 *      DURING phase 1 while game-time is still <600s (MIDDAY).
 *   4. #kk-forest-hud-reaper exists, is visible, textContent contains
 *      'REAPER'. Also probe for #kk-reaper-tint overlay (red-tint).
 *
 * PHASE COMMENTARY:
 *   Phase 1 — natural boot; 3s settle so forestDayNight captures baseline.
 *   Phase 2 — teleport via state.hero.pos.{x,z} = mossroot center (0,-140).
 *             _tickForestRoomTransition detects the room change next frame
 *             and calls _forestSealOnRoomEnter('mossroot'), which spawns
 *             the room boss and seals the return portal. This is TEST-ONLY
 *             trickery — production hero movement is keyboard/gamepad
 *             driven. We just bypass input.
 *   Phase 3 — mutate state.time.game = 700 (mid-GOLDEN_HOUR window
 *             600..1200). state.time.real left alone — phase logic only
 *             reads state.time.game. forestDayNight ticks per frame and
 *             relerps fog/light toward the GOLDEN_HOUR anchor.
 *   Phase 4 — mutate state.time.game = 1780. BRIEF SAID 1740, but the
 *             reaper red-tint overlay (kk-reaper-tint) fires at WARN_T=1770
 *             in forestReaper.js. At 1740s the HUD banner exists (HUD
 *             warns at 1680) but the tint does NOT. Raised to 1780 so
 *             BOTH the HUD "REAPER IN 0:20" assertion AND the red-tint
 *             screenshot intent are satisfied. Logged as deviation.
 *
 * FPS gate (per phase, 2s rAF counter):
 *   Headless Chromium with --use-gl=swiftshader can't approach 30fps; the
 *   brief's "fail <20" was written assuming hardware GL. This smoke runs
 *   in CI-style headless, so the FPS check is a LIVENESS PROBE, not a perf
 *   gate: fps > 0.5 proves the rAF loop is alive; fps == 0 means the game
 *   loop is dead (real regression). Meaningful perf testing requires
 *   hardware GL — see tools/perf-bench.js for that.
 *
 *     fps > 0.5  → ok (rAF alive)
 *     fps <= 0.5 → fail (rAF dead)
 *
 * KNOWN PRE-EXISTING CONSOLE ERRORS:
 *   None as of this commit — the two prior baseline errors (menuV2 SVG
 *   `xMidYEnd` typo and the implicit `/favicon.ico` 404) were fixed in
 *   the FOREST-V2-A16 baseline-console-fix branch. Allow-list mechanism
 *   retained (empty) for future regressions.
 *
 * Run: node tools/smoke-forest-v2.mjs
 *
 * NO npm install. Playwright is expected at /home/nemoclaw/node_modules
 * (shared cache) — same convention as tools/smoke-forest-amber.js.
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
const PORT = Number(process.env.PORT || 8773); // avoid 8771 (amber smoke)
const BOOT_TIMEOUT_MS = 60000;                  // bumped from 30s per brief
const PHASE_SETTLE_MS = 3000;                   // phase 1 settle (also lets
                                                // forestDayNight capture baseline)
const ROOM_SETTLE_MS = 2000;                    // phase 2 — room transition + boss spawn
const TIME_JUMP_SETTLE_MS = 1200;               // phases 3+4 — let fog/HUD relerp
const FPS_WINDOW_MS = 2000;                     // rAF counter window per phase

// Mossroot center (from src/forestRooms.js — center: { x: 0, z: -140 }).
const MOSSROOT_X = 0;
const MOSSROOT_Z = -140;

// FPS liveness floor — see header for why this isn't a perf gate in headless.
const FPS_LIVENESS_FLOOR = 0.5;

// Known pre-existing console errors. Substring match.
// Empty as of the FOREST-V2-A16 baseline-console-fix branch — append new
// entries here if a regression triages as known-baseline rather than fixable.
const KNOWN_PRE_EXISTING_ERRORS = [];
function isPreExisting(msg) {
  return KNOWN_PRE_EXISTING_ERRORS.some((sub) => msg.includes(sub));
}

// ── Static server (lifted from tools/smoke-forest-amber.js) ────────────────
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

// ── Playwright location (must match other smoke tools — never install here) ─
const PLAY_PATH = '/home/nemoclaw/node_modules/playwright';
const PLAYWRIGHT_EXEC = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

function fileSize(p) {
  try { return fs.statSync(p).size; } catch (_) { return -1; }
}

// Per-phase result records — drives the summary + exit code.
const results = [];
function recordPhase(n, label, pass, reason, fps, extras) {
  results.push({ n, label, pass, reason, fps, extras: extras || {} });
  const status = pass ? 'PASS' : 'FAIL';
  console.log('phase ' + n + ' (' + label + '): ' + status + ' — ' + reason
              + (fps != null ? '  [fps=' + fps.toFixed(1) + ']' : ''));
}

/** rAF-driven FPS counter for FPS_WINDOW_MS — returned as number. */
async function measureFps(page) {
  return await page.evaluate(async (windowMs) => {
    return await new Promise((resolve) => {
      let frames = 0;
      const t0 = performance.now();
      function tick() {
        frames++;
        if (performance.now() - t0 >= windowMs) {
          resolve(frames / (windowMs / 1000));
        } else {
          requestAnimationFrame(tick);
        }
      }
      requestAnimationFrame(tick);
    });
  }, FPS_WINDOW_MS);
}

/** Wait until predicate returns truthy or timeout. Returns last value. */
async function pollUntil(page, fn, timeoutMs, intervalMs) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await page.evaluate(fn);
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs || 100));
  }
  return last;
}

async function main() {
  const t0 = Date.now();

  // Pre-flight: bail clean if playwright isn't available — never npm install.
  if (!fs.existsSync(PLAY_PATH)) {
    console.error('[smoke-v2] FAIL: playwright not installed at ' + PLAY_PATH);
    console.error('[smoke-v2] Per CLAUDE.md, smoke tools NEVER run npm install.');
    process.exit(2);
  }
  if (!fs.existsSync(PLAYWRIGHT_EXEC)) {
    console.error('[smoke-v2] FAIL: chromium binary not found at ' + PLAYWRIGHT_EXEC);
    console.error('[smoke-v2] Set PLAYWRIGHT_BROWSERS_PATH or run a manual playwright install.');
    process.exit(2);
  }
  console.log('[smoke-v2] playwright check: OK (' + PLAY_PATH + ')');

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('[smoke-v2] server on http://127.0.0.1:' + PORT);

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

  try {
    // ── Boot ──────────────────────────────────────────────────────────────
    const url = 'http://127.0.0.1:' + PORT + '/index.html?smoke=1';
    await page.goto(url, { waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
    console.log('[smoke-v2] page loaded; waiting for kkStartRun');

    await page.waitForFunction(
      () => typeof window.kkStartRun === 'function',
      null,
      { timeout: BOOT_TIMEOUT_MS },
    );

    // Pin run to Forest BEFORE start (canonical path — matches amber smoke).
    await page.evaluate(async () => {
      try {
        const mod = await import('./src/meta.js');
        if (mod.setOption) mod.setOption('selectedStage', 'forest');
        else if (mod.getMeta) {
          const m = mod.getMeta();
          if (m) m.selectedStage = 'forest';
        }
      } catch (e) {
        console.warn('[smoke-v2] meta setOption fallback:', e && e.message);
      }
    });

    // Start the run + publish kkState via perfHUD.
    await page.evaluate(() => {
      if (typeof window.kkPerfForceOn === 'function') window.kkPerfForceOn();
      window.kkStartRun();
    });

    // Wait for kkState to publish (perfHUD sets it on first tick).
    await page.waitForFunction(
      () => !!window.kkState && !!window.kkState.run,
      null,
      { timeout: BOOT_TIMEOUT_MS },
    );
    console.log('[smoke-v2] kkState live; settling ' + PHASE_SETTLE_MS + 'ms for phase 1');

    // ── PHASE 1 — glade hub ───────────────────────────────────────────────
    await new Promise((r) => setTimeout(r, PHASE_SETTLE_MS));

    // Snapshot fog baseline NOW while game-time is still <600s (MIDDAY). This
    // baseline drives the phase-3 day/night assertion.
    const fogBaseline = await page.evaluate(() => {
      const s = window.kkState;
      if (!s || !s.scene || !s.scene.fog || !s.scene.fog.color) return null;
      const c = s.scene.fog.color;
      return { r: c.r, g: c.g, b: c.b, hex: c.getHex() };
    });
    console.log('[smoke-v2] fog baseline:', JSON.stringify(fogBaseline));

    const ss1 = path.join(__dirname, '_thumb_forest_phase_1_glade.png');
    await page.screenshot({ path: ss1, fullPage: false });

    const fps1 = await measureFps(page);
    const p1 = await page.evaluate(() => {
      const hud = document.querySelector('#kk-forest-hud');
      if (!hud) return { ok: false, reason: '#kk-forest-hud missing' };
      const text = hud.textContent || '';
      if (!text.includes(':')) {
        return { ok: false, reason: 'HUD text missing clock — text="' + text.slice(0, 80) + '"' };
      }
      const s = window.kkState;
      const gameT = (s && s.time && s.time.game) || -1;
      return { ok: true, reason: 'HUD live, clock visible, gameT=' + gameT.toFixed(1) + 's', gameT };
    });
    // FPS liveness gate (rAF alive in headless ≠ perf gate — see header).
    let p1Pass = p1.ok;
    let p1Reason = p1.reason;
    if (p1Pass && fps1 <= FPS_LIVENESS_FLOOR) {
      p1Pass = false;
      p1Reason += '; rAF DEAD (fps=' + fps1.toFixed(2) + ')';
    }
    recordPhase(1, 'glade', p1Pass, p1Reason, fps1, { gameT: p1.gameT });

    // ── PHASE 2 — sealed mossroot room ────────────────────────────────────
    // Teleport via direct hero.pos mutation. _tickForestRoomTransition picks
    // it up next frame: detectRoom returns 'mossroot', sets currentRoom,
    // calls _forestSealOnRoomEnter('mossroot') → spawns room boss + seals
    // the return portal.
    await page.evaluate(({ x, z }) => {
      const s = window.kkState;
      if (s && s.hero && s.hero.pos) {
        s.hero.pos.x = x;
        s.hero.pos.z = z;
      }
    }, { x: MOSSROOT_X, z: MOSSROOT_Z });

    // Poll for room transition + boss spawn — up to ROOM_SETTLE_MS.
    const roomReady = await pollUntil(page, () => {
      const s = window.kkState;
      if (!s || !s.run || !s.enemies || !s.enemies.active) return false;
      if (s.run.currentRoom !== 'mossroot') return false;
      const bosses = s.enemies.active.filter((e) => e && e._isRoomBoss === true);
      return bosses.length >= 1;
    }, ROOM_SETTLE_MS, 100);

    // Brief extra settle so the sealed-portal tint pulse has visible frames.
    await new Promise((r) => setTimeout(r, 500));

    const ss2 = path.join(__dirname, '_thumb_forest_phase_2_sealedroom.png');
    await page.screenshot({ path: ss2, fullPage: false });

    const fps2 = await measureFps(page);
    // Portal probe — call forestPortals.getForestPortals() via dynamic
    // import (the module is at /src/forestPortals.js, served by our static
    // server) and read _sealed flags directly. Falls back gracefully if
    // import fails.
    const p2 = await page.evaluate(async () => {
      const s = window.kkState;
      if (!s || !s.run) return { ok: false, reason: 'kkState/run missing' };
      const room = s.run.currentRoom;
      const bosses = (s.enemies && s.enemies.active || []).filter((e) => e && e._isRoomBoss === true);
      const bossCount = bosses.length;
      if (bossCount < 1) {
        return { ok: false, reason: 'no _isRoomBoss enemy (currentRoom=' + room + ')', bossCount, room };
      }
      // Sealed-portal check — use the _sealed system flag, not hex comparison.
      let sealedCount = 0;
      let portalCount = 0;
      let probeErr = null;
      try {
        const mod = await import('/src/forestPortals.js');
        const portals = (mod.getForestPortals && mod.getForestPortals()) || [];
        portalCount = portals.length;
        for (const p of portals) {
          if (p && p._sealed === true) sealedCount++;
        }
      } catch (e) {
        probeErr = (e && e.message) || String(e);
      }
      if (probeErr) {
        return { ok: false, reason: 'portal probe failed: ' + probeErr, bossCount, room };
      }
      // Also check for the kk-sealed-prompt DOM element (shows when hero
      // near a sealed portal). May be absent if hero stands at room center
      // far from portal — log but don't fail on it.
      const promptEl = document.querySelector('#kk-sealed-prompt');
      const promptVisible = promptEl ? (promptEl.style.display !== 'none') : false;
      return {
        ok: sealedCount >= 1,
        reason: sealedCount >= 1
          ? 'room=' + room + ', bosses=' + bossCount + ', sealedPortals='
            + sealedCount + '/' + portalCount
            + ', sealedPrompt=' + (promptEl ? 'present(visible=' + promptVisible + ')' : 'absent')
          : 'no sealed portals found (bosses=' + bossCount + ', room=' + room
            + ', totalPortals=' + portalCount + ')',
        bossCount, room, sealedCount, portalCount,
      };
    });
    let p2Pass = p2.ok && roomReady;
    let p2Reason = p2.reason + (roomReady ? '' : ' [roomReady poll TIMEOUT]');
    if (p2Pass && fps2 <= FPS_LIVENESS_FLOOR) {
      p2Pass = false;
      p2Reason += '; rAF DEAD (fps=' + fps2.toFixed(2) + ')';
    }
    recordPhase(2, 'sealedroom', p2Pass, p2Reason, fps2,
      { bossCount: p2.bossCount, sealedCount: p2.sealedCount, room: p2.room });

    // ── PHASE 3 — golden hour at t=700s ────────────────────────────────────
    await page.evaluate(() => {
      const s = window.kkState;
      if (s && s.time) s.time.game = 700;
    });
    // Let forestDayNight relerp toward the GOLDEN_HOUR anchor.
    await new Promise((r) => setTimeout(r, TIME_JUMP_SETTLE_MS));

    const ss3 = path.join(__dirname, '_thumb_forest_phase_3_goldenhour.png');
    await page.screenshot({ path: ss3, fullPage: false });

    const fps3 = await measureFps(page);
    const p3 = await page.evaluate((baseline) => {
      const s = window.kkState;
      if (!s || !s.scene || !s.scene.fog || !s.scene.fog.color) {
        return { ok: false, reason: 'scene.fog.color missing' };
      }
      const c = s.scene.fog.color;
      const curr = { r: c.r, g: c.g, b: c.b, hex: c.getHex() };
      if (!baseline) {
        return { ok: false, reason: 'no baseline captured at phase 1', curr };
      }
      // Per-channel relative delta — pass if ANY channel differs by >5%.
      const dr = Math.abs(curr.r - baseline.r) / Math.max(baseline.r, 0.001);
      const dg = Math.abs(curr.g - baseline.g) / Math.max(baseline.g, 0.001);
      const db = Math.abs(curr.b - baseline.b) / Math.max(baseline.b, 0.001);
      const maxDelta = Math.max(dr, dg, db);
      const passed = maxDelta > 0.05;
      return {
        ok: passed,
        reason: passed
          ? 'fog shifted: dr=' + (dr * 100).toFixed(1) + '% dg=' + (dg * 100).toFixed(1) + '% db=' + (db * 100).toFixed(1) + '%'
          : 'fog unchanged: max channel delta=' + (maxDelta * 100).toFixed(2) + '% (need >5%)',
        baseline, curr, maxDelta,
      };
    }, fogBaseline);
    let p3Pass = p3.ok;
    let p3Reason = p3.reason;
    if (p3Pass && fps3 <= FPS_LIVENESS_FLOOR) {
      p3Pass = false;
      p3Reason += '; rAF DEAD (fps=' + fps3.toFixed(2) + ')';
    }
    recordPhase(3, 'goldenhour', p3Pass, p3Reason, fps3, { maxDelta: p3.maxDelta });

    // ── PHASE 4 — reaper warn at t=1780s ──────────────────────────────────
    // BRIEF SAID 1740; raised to 1780 so red-tint overlay (kk-reaper-tint,
    // fires at WARN_T=1770 in forestReaper.js) is also captured. At 1780
    // HUD shows "REAPER IN 0:20" (HUD warn at 1680, spawn at 1800).
    await page.evaluate(() => {
      const s = window.kkState;
      if (s && s.time) s.time.game = 1780;
    });
    await new Promise((r) => setTimeout(r, TIME_JUMP_SETTLE_MS));

    const ss4 = path.join(__dirname, '_thumb_forest_phase_4_reaperwarn.png');
    await page.screenshot({ path: ss4, fullPage: false });

    const fps4 = await measureFps(page);
    const p4 = await page.evaluate(() => {
      const banner = document.querySelector('#kk-forest-hud-reaper');
      if (!banner) return { ok: false, reason: '#kk-forest-hud-reaper missing' };
      const text = banner.textContent || '';
      const visible = banner.style.visibility !== 'hidden';
      if (!text.includes('REAPER')) {
        return {
          ok: false,
          reason: 'banner text missing REAPER: "' + text + '" (visible=' + visible + ')',
          bannerText: text, bannerVisible: visible,
        };
      }
      // Probe red-tint overlay — best-effort, included in extras (not a gate).
      const tint = document.querySelector('#kk-reaper-tint');
      const tintPresent = !!tint;
      const s = window.kkState;
      const gameT = (s && s.time && s.time.game) || -1;
      return {
        ok: visible,
        reason: visible
          ? 'banner "' + text + '" visible @ t=' + gameT + 's, tintOverlay=' + tintPresent
          : 'banner present but hidden (text="' + text + '")',
        bannerText: text, bannerVisible: visible, tintPresent, gameT,
      };
    });
    let p4Pass = p4.ok;
    let p4Reason = p4.reason;
    if (p4Pass && fps4 <= FPS_LIVENESS_FLOOR) {
      p4Pass = false;
      p4Reason += '; rAF DEAD (fps=' + fps4.toFixed(2) + ')';
    }
    recordPhase(4, 'reaperwarn', p4Pass, p4Reason, fps4,
      { bannerText: p4.bannerText, tintPresent: p4.tintPresent });

    // ── Summary ───────────────────────────────────────────────────────────
    const passCount = results.filter((r) => r.pass).length;
    const failCount = results.length - passCount;
    const runtimeSec = ((Date.now() - t0) / 1000).toFixed(1);

    // Split console errors into known-baseline (suppressed for gate) vs new.
    const knownErrors = consoleErrors.filter(isPreExisting);
    const newErrors   = consoleErrors.filter((e) => !isPreExisting(e));

    console.log('\n========== SMOKE SUMMARY ==========');
    console.log('total: ' + passCount + ' pass, ' + failCount + ' fail');
    console.log('runtime: ' + runtimeSec + 's');
    console.log('screenshots:');
    console.log('  phase 1: ' + fileSize(ss1) + ' bytes  ' + ss1);
    console.log('  phase 2: ' + fileSize(ss2) + ' bytes  ' + ss2);
    console.log('  phase 3: ' + fileSize(ss3) + ' bytes  ' + ss3);
    console.log('  phase 4: ' + fileSize(ss4) + ' bytes  ' + ss4);
    console.log('console.errors (new):           ' + newErrors.length);
    for (const e of newErrors) console.log('  - ' + e);
    console.log('console.errors (known baseline): ' + knownErrors.length + ' (suppressed)');
    for (const e of knownErrors) console.log('  ~ ' + e);
    console.log('console.warns:  ' + consoleWarnings.length + ' (suppressed)');
    console.log('pageerrors:     ' + pageErrors.length);
    for (const e of pageErrors) console.log('  - ' + e);

    const allShotsOk = [ss1, ss2, ss3, ss4].every((p) => fileSize(p) > 0);

    await browser.close();
    server.close();

    // Exit non-zero if: any phase failed, any NEW console.error, any
    // pageerror, or any screenshot missing. Per brief: warnings OK,
    // screenshots save even on fail. Known-baseline errors are surfaced
    // but don't break the gate (see header for rationale).
    const hardFail = failCount > 0 || newErrors.length > 0
                     || pageErrors.length > 0 || !allShotsOk;
    if (hardFail) {
      console.error('[smoke-v2] FAIL — phases=' + failCount + ' newErrors=' + newErrors.length
                    + ' pageerrors=' + pageErrors.length + ' allShotsOk=' + allShotsOk);
      process.exit(1);
    }
    console.log('[smoke-v2] OK — all 4 phases passed');
  } catch (e) {
    console.error('[smoke-v2] FAIL (uncaught):', e && (e.stack || e.message || e));
    try { await browser.close(); } catch (_) {}
    try { server.close(); } catch (_) {}
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[smoke-v2] FAIL (main):', e);
  try { server.close(); } catch (_) {}
  process.exit(1);
});
