#!/usr/bin/env node
/**
 * PHASE 4 P4F (#144) — Char unlock chain smoke.
 *
 * Verifies the three hidden avatars (rune_kitten / mire_kitten / shroud_kitten)
 * actually graduate from locked → unlocked when their gating forest achievement
 * (no_hit_clear / rings_dodged_100 / reaper_outlasted) fires.
 *
 * Per-avatar scenario (sequential — shared meta + state would race):
 *   1. Reset meta (window.kkResetMeta() if exposed, else direct localStorage
 *      wipe + reload).
 *   2. After boot, assert isAvatarUnlocked(<id>) === false (baseline).
 *   3. Fire the gating achievement via window.__kkAchievements.unlock(<achId>)
 *      — the devtools probe already exposed at forestAchievements.js:668.
 *   4. Assert isAvatarUnlocked(<id>) === true.
 *   5. Assert meta.avatarUnlocks[<id>].source starts with 'achievement:'.
 *   6. Assert meta.achievements[<achId>] truthy (the achievement persists too).
 *
 * Then a 4th scenario verifies the AVATARS config wiring:
 *   - All three hidden avatars exist in AVATARS with non-null `unlock` strings.
 *   - The unlock strings match the three achievement ids (no `flag:` / `sigils:`).
 *
 * Run: node tools/smoke-p4f-charunlock.mjs
 *
 * Port: 8779 (after 8778 NG+, 8777 a11y, 8776 mixer, 8775 telemetry).
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
const PORT = Number(process.env.PORT || 8779);
const BOOT_TIMEOUT_MS = 60000;

// ── Static server (lifted from smoke-p4d-ngplus) ──────────────────────────
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

function fail(msg) { console.error('[smoke-p4f] FAIL: ' + msg); }

async function waitBoot(page) {
  await page.waitForFunction(
    () => typeof window.kkStartRun === 'function'
       && !!window.__kkAchievements
       && typeof window.__kkAchievements.unlock === 'function',
    null,
    { timeout: BOOT_TIMEOUT_MS },
  );
}

// Wipe localStorage for our save key BEFORE the page boots so loadMeta()
// sees a clean slate. Reload after to remount the in-memory _data cache.
async function resetMetaAndReload(page) {
  await page.evaluate(() => {
    try {
      localStorage.removeItem('kk-survivors-meta-v1');
      localStorage.removeItem('kk-survivors-meta-v2');
    } catch (_) { /* noop */ }
  });
  await page.reload({ waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
  await waitBoot(page);
}

/**
 * Full unlock cycle for one avatar.
 * Returns { ok, baselineLocked, afterUnlocked, source, achievementPersisted, reason? }.
 */
async function runUnlockCycle(page, avatarId, achId) {
  await resetMetaAndReload(page);

  const baseline = await page.evaluate(async (avatarId) => {
    const meta = await import('./src/meta.js');
    return {
      isUnlocked: meta.isAvatarUnlocked(avatarId),
      avatarUnlocks: meta.getMeta().avatarUnlocks || {},
    };
  }, avatarId);

  if (baseline.isUnlocked) {
    return { ok: false, reason: 'baseline already unlocked', baseline };
  }

  // Fire the achievement — invokes the avatar-unlock hook inside
  // forestAchievements.js#unlockAchievement.
  const fireResult = await page.evaluate((achId) => {
    try {
      const def = window.__kkAchievements.unlock(achId);
      return { ok: true, def: def && def.id };
    } catch (e) {
      return { ok: false, reason: String(e && e.message || e) };
    }
  }, achId);

  if (!fireResult.ok) {
    return { ok: false, reason: 'unlock dispatch failed: ' + fireResult.reason };
  }

  const after = await page.evaluate(async ({ avatarId, achId }) => {
    const meta = await import('./src/meta.js');
    const m = meta.getMeta();
    return {
      isUnlocked: meta.isAvatarUnlocked(avatarId),
      record: (m.avatarUnlocks || {})[avatarId] || null,
      achievementPersisted: !!(m.achievements && m.achievements[achId]),
    };
  }, { avatarId, achId });

  return {
    ok: true,
    baselineLocked: !baseline.isUnlocked,
    afterUnlocked: after.isUnlocked,
    source: after.record && after.record.source,
    achievementPersisted: after.achievementPersisted,
  };
}

async function main() {
  if (!fs.existsSync(PLAY_PATH)) {
    console.error('[smoke-p4f] FAIL: playwright not installed at ' + PLAY_PATH);
    console.error('[smoke-p4f] Per CLAUDE.md, smoke tools NEVER run npm install.');
    process.exit(2);
  }
  if (!fs.existsSync(PLAYWRIGHT_EXEC)) {
    console.error('[smoke-p4f] FAIL: chromium binary not found at ' + PLAYWRIGHT_EXEC);
    process.exit(2);
  }
  console.log('[smoke-p4f] playwright check: OK');

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('[smoke-p4f] server on http://127.0.0.1:' + PORT);

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

  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[console.error]', msg.text());
  });
  page.on('pageerror', (e) => {
    pageErrors.push(e.message);
    console.error('[pageerror]', e.message);
  });

  const failures = [];

  try {
    const url = 'http://127.0.0.1:' + PORT + '/index.html?smoke=1';
    await page.goto(url, { waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
    await waitBoot(page);
    console.log('[smoke-p4f] boot OK');

    // ── Assertion 0: AVATARS config wiring ──────────────────────────────
    console.log('\n========== ASSERTION 0: AVATARS config wiring ==========');
    const cfg = await page.evaluate(async () => {
      const c = await import('./src/config.js');
      const findUnlock = (id) => {
        const av = (c.AVATARS || []).find(a => a && a.id === id);
        return av ? av.unlock : null;
      };
      return {
        rune:   findUnlock('rune_kitten'),
        mire:   findUnlock('mire_kitten'),
        shroud: findUnlock('shroud_kitten'),
        totalAvatars: (c.AVATARS || []).length,
      };
    });
    console.log('  total AVATARS: ' + cfg.totalAvatars);
    console.log('  rune_kitten.unlock   = ' + cfg.rune);
    console.log('  mire_kitten.unlock   = ' + cfg.mire);
    console.log('  shroud_kitten.unlock = ' + cfg.shroud);
    if (cfg.rune !== 'no_hit_clear') {
      failures.push('rune_kitten.unlock should be "no_hit_clear", got ' + cfg.rune);
    }
    if (cfg.mire !== 'rings_dodged_100') {
      failures.push('mire_kitten.unlock should be "rings_dodged_100", got ' + cfg.mire);
    }
    if (cfg.shroud !== 'reaper_outlasted') {
      failures.push('shroud_kitten.unlock should be "reaper_outlasted", got ' + cfg.shroud);
    }

    // ── Assertion 1: rune_kitten ← no_hit_clear ─────────────────────────
    console.log('\n========== ASSERTION 1: rune_kitten ← no_hit_clear ==========');
    const rune = await runUnlockCycle(page, 'rune_kitten', 'no_hit_clear');
    console.log('  baselineLocked=' + rune.baselineLocked
      + ', afterUnlocked=' + rune.afterUnlocked
      + ', source=' + rune.source
      + ', achievementPersisted=' + rune.achievementPersisted);
    if (!rune.ok) failures.push('rune_kitten cycle: ' + rune.reason);
    else {
      if (!rune.baselineLocked) failures.push('rune_kitten baseline should be locked');
      if (!rune.afterUnlocked)  failures.push('rune_kitten should be unlocked after firing no_hit_clear');
      if (!rune.source || !rune.source.startsWith('achievement:')) {
        failures.push('rune_kitten source should start with "achievement:", got ' + rune.source);
      }
      if (!rune.achievementPersisted) {
        failures.push('no_hit_clear should persist in meta.achievements after firing');
      }
    }

    // ── Assertion 2: mire_kitten ← rings_dodged_100 ─────────────────────
    console.log('\n========== ASSERTION 2: mire_kitten ← rings_dodged_100 ==========');
    const mire = await runUnlockCycle(page, 'mire_kitten', 'rings_dodged_100');
    console.log('  baselineLocked=' + mire.baselineLocked
      + ', afterUnlocked=' + mire.afterUnlocked
      + ', source=' + mire.source
      + ', achievementPersisted=' + mire.achievementPersisted);
    if (!mire.ok) failures.push('mire_kitten cycle: ' + mire.reason);
    else {
      if (!mire.baselineLocked) failures.push('mire_kitten baseline should be locked');
      if (!mire.afterUnlocked)  failures.push('mire_kitten should be unlocked after firing rings_dodged_100');
      if (!mire.source || !mire.source.startsWith('achievement:')) {
        failures.push('mire_kitten source should start with "achievement:", got ' + mire.source);
      }
      if (!mire.achievementPersisted) {
        failures.push('rings_dodged_100 should persist in meta.achievements after firing');
      }
    }

    // ── Assertion 3: shroud_kitten ← reaper_outlasted ───────────────────
    console.log('\n========== ASSERTION 3: shroud_kitten ← reaper_outlasted ==========');
    const shroud = await runUnlockCycle(page, 'shroud_kitten', 'reaper_outlasted');
    console.log('  baselineLocked=' + shroud.baselineLocked
      + ', afterUnlocked=' + shroud.afterUnlocked
      + ', source=' + shroud.source
      + ', achievementPersisted=' + shroud.achievementPersisted);
    if (!shroud.ok) failures.push('shroud_kitten cycle: ' + shroud.reason);
    else {
      if (!shroud.baselineLocked) failures.push('shroud_kitten baseline should be locked');
      if (!shroud.afterUnlocked)  failures.push('shroud_kitten should be unlocked after firing reaper_outlasted');
      if (!shroud.source || !shroud.source.startsWith('achievement:')) {
        failures.push('shroud_kitten source should start with "achievement:", got ' + shroud.source);
      }
      if (!shroud.achievementPersisted) {
        failures.push('reaper_outlasted should persist in meta.achievements after firing');
      }
    }

    // ── Assertion 4: idempotency — re-firing does not re-unlock ─────────
    // Fresh reset, fire no_hit_clear once, snapshot the avatarUnlocks
    // record, fire AGAIN in the same session, and verify the record's
    // unlockedAt timestamp did not change. Two-stage check:
    //   stage 1 — runSet dedup blocks second dispatch within session.
    //   stage 2 — even if dispatch reaches the meta-write, the
    //             isFirstLifetimeUnlock gate (meta.achievements[id]
    //             already truthy after stage 1) keeps the avatar hook
    //             from re-firing.
    console.log('\n========== ASSERTION 4: idempotency ==========');
    await resetMetaAndReload(page);
    const idem = await page.evaluate(async () => {
      const meta = await import('./src/meta.js');
      window.__kkAchievements.unlock('no_hit_clear');
      const rec1 = (meta.getMeta().avatarUnlocks || {}).rune_kitten;
      const ts1 = rec1 && rec1.unlockedAt;
      // Briefly pause so a re-write would yield a different timestamp
      // — guards against the "ms-tick collision" false-positive.
      await new Promise(r => setTimeout(r, 25));
      window.__kkAchievements.unlock('no_hit_clear');
      const rec2 = (meta.getMeta().avatarUnlocks || {}).rune_kitten;
      const ts2 = rec2 && rec2.unlockedAt;
      return { ts1, ts2, equal: ts1 === ts2 };
    });
    console.log('  unlockedAt first=' + idem.ts1 + ', second=' + idem.ts2
      + ', equal=' + idem.equal);
    if (!idem.equal) {
      failures.push('re-firing no_hit_clear should not change unlockedAt timestamp (idempotency)');
    }

    // ── Assertion 5: bare 'flag:'/'sigils:' avatars are NOT collateral ─
    // If the avatar hook accidentally matched any string equality, an
    // achievement id colliding with a flag name would unlock the wrong
    // avatar. Verify by firing first_miniboss (existing achievement, not
    // gating any new avatar) and confirming no new avatar appears.
    console.log('\n========== ASSERTION 5: hook does not over-match ==========');
    await resetMetaAndReload(page);
    const overmatch = await page.evaluate(async () => {
      const meta = await import('./src/meta.js');
      const before = Object.keys(meta.getMeta().avatarUnlocks || {}).length;
      window.__kkAchievements.unlock('first_miniboss');
      const after = Object.keys(meta.getMeta().avatarUnlocks || {}).length;
      return { before, after };
    });
    console.log('  avatar count before=' + overmatch.before + ', after=' + overmatch.after);
    if (overmatch.after !== overmatch.before) {
      failures.push('first_miniboss must not unlock any avatar (got delta '
        + (overmatch.after - overmatch.before) + ')');
    }

  } catch (e) {
    failures.push('uncaught: ' + ((e && (e.stack || e.message)) || String(e)));
    console.error('[smoke-p4f] uncaught:', e);
  }

  console.log('\n========== SMOKE SUMMARY ==========');
  console.log('pageerrors: ' + pageErrors.length);
  for (const e of pageErrors) console.log('  - ' + e);

  try { await browser.close(); } catch (_) {}
  try { server.close(); } catch (_) {}

  if (failures.length) {
    for (const f of failures) fail(f);
    console.error('[smoke-p4f] FAIL: ' + failures.length + ' assertion(s) failed');
    process.exit(1);
  }
  if (pageErrors.length > 0) {
    console.error('[smoke-p4f] FAIL: ' + pageErrors.length + ' pageerror(s) during smoke');
    process.exit(1);
  }
  console.log('[smoke-p4f] OK — char unlock chain smoke passed');
}

main().catch((e) => {
  console.error('[smoke-p4f] FAIL (main):', e);
  try { server.close(); } catch (_) {}
  process.exit(1);
});
