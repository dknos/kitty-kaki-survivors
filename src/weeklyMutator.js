/**
 * Weekly mutator pool (iter 9 "Retention Hooks").
 *
 * Each Monday (UTC, per meta.isoWeekKey()) the seed cycles to a new mutator
 * pulled deterministically from this list. Mutators are pure runState
 * stampers — the same shape as SHOP_TREE node effects (meta.js:481) so the
 * surrounding code already knows how to read them.
 *
 * The READER contract is locked: 9b's main.js / spawnDirector.js / xp.js /
 * enemies.js / hero.js will read these exact slot names. Don't rename without
 * touching them too.
 *
 *   DOUBLE_SPAWNS     → runState.weeklySpawnMul       = 2
 *   HALF_HP_HALF_DMG  → runState.weeklyEnemyHpMul     = 0.5
 *                       runState.weeklyEnemyDmgMul    = 0.5
 *   CHEST_LOCKDOWN    → runState.weeklyChestLockUntilSec = 300
 *   BOSS_PARADE       → runState.weeklyExtraMiniBoss  = true
 *   NO_PASSIVES       → runState.weeklyNoPassives     = true
 *   XP_FAMINE         → runState.weeklyXpMul          = 0.7
 *
 * Mirrors the daily-challenge convention: weekly skips shop bonuses for a
 * fair leaderboard. 9b enforces that side of the contract in applyMetaUpgrades.
 *
 * The `desc` strings target the wolf-tone codex voice (terse, mythic) so
 * 9c's codex "Lore → weekly_mutators" tab can drop them in unchanged.
 */
export const WEEKLY_MUTATORS = [
  {
    id: 'DOUBLE_SPAWNS',
    label: 'Double Spawns',
    desc: 'The horde swells. Two shadows for every one — the forest remembers nothing else.',
    apply: (runState) => {
      runState.weeklySpawnMul = 2;
    },
  },
  {
    id: 'HALF_HP_HALF_DMG',
    label: 'Glass Hordes',
    desc: 'Brittle bones, brittle teeth. Strike first or be swarmed; neither side can afford a second blow.',
    apply: (runState) => {
      runState.weeklyEnemyHpMul = 0.5;
      runState.weeklyEnemyDmgMul = 0.5;
    },
  },
  {
    id: 'CHEST_LOCKDOWN',
    label: 'Chest Lockdown',
    desc: 'The vault-spirits are sleeping. No coffers will surface for the first five minutes — survive the drought.',
    apply: (runState) => {
      runState.weeklyChestLockUntilSec = 300;
    },
  },
  {
    id: 'BOSS_PARADE',
    label: 'Boss Parade',
    desc: 'A fourth name walks the line. Where three trials stood, now four — and the last one comes late, hungry.',
    apply: (runState) => {
      runState.weeklyExtraMiniBoss = true;
    },
  },
  {
    id: 'NO_PASSIVES',
    label: 'No Passives',
    desc: 'No quiet gifts this week. Every level-up demands a blade — your stat-shadows have nothing to offer.',
    apply: (runState) => {
      runState.weeklyNoPassives = true;
    },
  },
  {
    id: 'XP_FAMINE',
    label: 'XP Famine',
    desc: 'The hunt-light dims. Every kill yields less than its weight; greed buys little here.',
    apply: (runState) => {
      runState.weeklyXpMul = 0.7;
    },
  },
];

/**
 * Apply a mutator by id. Quiet no-op if the id is unknown so a save-file from
 * a future build can't crash today's run-start path.
 *
 * Returns the matched mutator def (or null) so the caller can log/toast its
 * label without a second lookup.
 */
export function applyWeeklyMutator(runState, mutatorId) {
  if (!runState || !mutatorId) return null;
  const m = WEEKLY_MUTATORS.find(x => x.id === mutatorId);
  if (!m) return null;
  try { m.apply(runState); } catch (e) { console.warn('[weeklyMutator]', mutatorId, e); }
  return m;
}
