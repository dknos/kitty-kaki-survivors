// Standalone smoke for Phase B meta v1 → v2 migration.
// Stubs localStorage + state import, exercises loadMeta() three ways:
//   1. fresh profile
//   2. v1 save with unlockedClockwork:true (expect bomdia unlocked + bonuses)
//   3. v2 save round-trip (expect no re-migration)
//
// Run: node tools/smoke-meta-migration.mjs
//
// This file is throwaway scaffolding for the Phase B PR; safe to delete after
// the migration ships.
import { strict as assert } from 'node:assert';

// ── localStorage stub ─────────────────────────────────────────────────────
class LSStub {
  constructor(seed = {}) { this._d = { ...seed }; }
  getItem(k)         { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; }
  setItem(k, v)      { this._d[k] = String(v); }
  removeItem(k)      { delete this._d[k]; }
  clear()            { this._d = {}; }
}

// ── state stub (meta imports from './state.js') ───────────────────────────
const stateStub = { state: { run: {} } };

// ── Load meta.js fresh per scenario ───────────────────────────────────────
async function loadFresh(ls) {
  globalThis.localStorage = ls;
  // Bypass module cache so DEFAULT seeds fresh and _data resets per call.
  const url = new URL('../src/meta.js', import.meta.url).href + `?t=${Math.random()}`;
  const mod = await import(url);
  return mod;
}

// state.js is imported by meta.js at module load. We don't need its API for
// these scenarios — they exercise loadMeta + the new Phase B helpers, none
// of which touch `state`. The import will succeed as long as state.js parses.

async function scenario1Fresh() {
  const ls = new LSStub();
  const m = await loadFresh(ls);
  const d = m.loadMeta();
  assert.equal(d.migrationVersion, 2,            'fresh: migrationVersion should be 2');
  assert.ok(d.avatarUnlocks.kitty,               'fresh: kitty seeded');
  assert.ok(d.avatarUnlocks.sote,                'fresh: sote seeded');
  assert.ok(d.avatarUnlocks.cowboy,              'fresh: cowboy seeded');
  assert.equal(d.avatarUnlocks.bomdia, undefined,'fresh: bomdia locked');
  assert.equal(m.getMastery('kitty'), 0,         'fresh: no mastery');
  console.log('✓ scenario 1: fresh profile');
}

async function scenario2V1Migration() {
  const v1 = {
    version: 1, coins: 123, embers: 7, runs: 12,
    bestTime: 90, bestKills: 200, totalKills: 5432,
    optVolume: 0.4, achievements: { first_jackpot: 111 },
    unlockedClockwork: true, unlockedVoid: true, casinoUnlocked: true,
    selectedAvatar: 'cowboy', selectedChar: 'boom',
  };
  const ls = new LSStub({
    'kk-survivors-meta-v1': JSON.stringify(v1),
  });
  const m = await loadFresh(ls);
  const d = m.loadMeta();
  assert.equal(d.coins, 123,                       'v1: coins flowed through');
  assert.equal(d.embers, 7 + 50,                   'v1: +50 ember transition gift');
  assert.equal(d.migrationVersion, 2,              'v1: bumped');
  assert.ok(d.avatarUnlocks.bomdia,                'v1: bomdia unlocked from unlockedClockwork');
  assert.equal(d.avatarUnlocks.bomdia.source, 'v1-migration:clockwork');
  assert.equal(d.mastery.bomdia, 50,               'v1: +50 bomdia mastery');
  assert.equal(d.optMasterVolume, 0.4,             'v1: audio mini-migration ran');
  assert.equal(d.optMusicVolume, 0.24,             'v1: music = 0.4 * 0.6');
  assert.equal(d.optSfxVolume, 0.4,                'v1: sfx = 0.4');
  // v1 still intact, v2 now exists
  assert.ok(ls.getItem('kk-survivors-meta-v1'),    'v1 untouched');
  assert.ok(ls.getItem('kk-survivors-meta-v2'),    'v2 written');
  console.log('✓ scenario 2: v1 → v2 migration');
}

async function scenario3V2Roundtrip() {
  const v2 = {
    version: 1, migrationVersion: 2, coins: 50, embers: 3,
    avatarUnlocks: {
      kitty:  { unlockedAt: 0, kills: 999, runs: 4, source: 'starter' },
      sote:   { unlockedAt: 0, kills: 12,  runs: 1, source: 'starter' },
      cowboy: { unlockedAt: 0, kills: 0,   runs: 0, source: 'starter' },
    },
    mastery: { kitty: 99 },
    cosmetics: {},
    unlockFlags: {},
  };
  const ls = new LSStub({
    'kk-survivors-meta-v2': JSON.stringify(v2),
  });
  const m = await loadFresh(ls);
  const d = m.loadMeta();
  assert.equal(d.coins, 50,                          'v2: roundtrip');
  assert.equal(m.getMastery('kitty'), 99,            'v2: mastery preserved');
  assert.equal(d.avatarUnlocks.kitty.kills, 999,     'v2: kill count preserved');
  // No v1 read attempted (would've re-migrated)
  console.log('✓ scenario 3: v2 round-trip');
}

async function scenario4Api() {
  const ls = new LSStub();
  const m = await loadFresh(ls);
  m.loadMeta();
  assert.equal(m.isAvatarUnlocked('kitty'), true,    'api: starter is unlocked');
  assert.equal(m.isAvatarUnlocked('pipes'), false,   'api: pipes locked');
  // grant mastery
  assert.equal(m.grantMastery('kitty', 50), 50,      'api: grantMastery returns balance');
  assert.equal(m.getMastery('kitty'), 50);
  // recordAvatarRun (Phase G recalibration): 100 kills = +4 mastery
  // (kills/25); mini = +5; final = +15. Pre-G formula was kills/10.
  const gained = m.recordAvatarRun('kitty', { kills: 100, miniBossKills: 1, finalBossKills: 1 });
  assert.equal(gained, 4 + 5 + 15,                   'api: recordAvatarRun mastery formula');
  assert.equal(m.getMastery('kitty'), 50 + 24);
  // setUnlockFlag idempotent
  assert.equal(m.setUnlockFlag('finalBossWin'), true);
  assert.equal(m.setUnlockFlag('finalBossWin'), false);
  console.log('✓ scenario 4: API');
}

(async () => {
  try {
    await scenario1Fresh();
    await scenario2V1Migration();
    await scenario3V2Roundtrip();
    await scenario4Api();
    console.log('\nALL SCENARIOS PASS');
  } catch (e) {
    console.error('FAIL:', e.message);
    process.exit(1);
  }
})();
