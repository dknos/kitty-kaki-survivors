/**
 * Enemy spawn director.
 *
 * Continuous-flow spawner with a difficulty curve D(t):
 *   t ∈ [0, rampSec)        → D = t / rampSec           (0 → 1)
 *   t ∈ [rampSec, maxSec)   → D linear 1 → difficultyMax
 *   t ≥ maxSec              → D = difficultyMax
 *
 * Each director tick (throttled to SPAWN.tickIntervalSec):
 *   - Tops up active enemies toward target = base + D * perD (capped).
 *   - Picks a weighted-random tier unlocked by D and spawns it on a ring
 *     around the hero, slightly off the orthographic frustum.
 *
 * Periodic events:
 *   - Horde   every SPAWN.hordeIntervalSec  → burst of hordeCount mid-tier in an arc.
 *   - Boss    every SPAWN.bossIntervalSec   → one elite at 5× HP on a wider ring.
 */
import { state } from './state.js';
import { ENEMY_TIERS, SPAWN, STAGE } from './config.js';
import { spawnEnemy } from './enemies.js';
import { showBanner } from './ui.js';
import { sfx } from './audio.js';
import { spawnChestNearHero } from './chest.js';
import { shopLevel } from './meta.js';
import { nameForMiniBoss, FINAL_BOSS_NAME } from './bossTelegraphs.js';

// ── Module-local director state ──────────────────────────────────────────────
let _acc = 0;
let _nextHorde = SPAWN.hordeIntervalSec;
let _nextChest = SPAWN.chestIntervalSec;
let _lastSeenTime = 0;
let _finalBossWarned = false;
let _finalBossSpawned = false;
let _miniBossIdx = 0;
let _miniBossWarnedFor = -1;

// ── Helpers ──────────────────────────────────────────────────────────────────
function weightedPick(tiers) {
  const total = tiers.reduce((s, t) => s + t.weight, 0);
  let r = Math.random() * total;
  for (const t of tiers) { r -= t.weight; if (r <= 0) return t; }
  return tiers[tiers.length - 1];
}

function computeDifficulty(t) {
  if (t <= 0) return 0;
  if (t < SPAWN.difficultyRampSec) return t / SPAWN.difficultyRampSec;
  if (t < SPAWN.difficultyMaxSec) {
    const span = SPAWN.difficultyMaxSec - SPAWN.difficultyRampSec;
    const k = (t - SPAWN.difficultyRampSec) / span;
    return 1 + k * (SPAWN.difficultyMax - 1);
  }
  return SPAWN.difficultyMax;
}

function ringPos(angle, radius) {
  const hp = state.hero.pos;
  return {
    x: hp.x + Math.cos(angle) * radius,
    z: hp.z + Math.sin(angle) * radius,
  };
}

function spawnOnRing(tier, angle, radiusMul = 1) {
  // Stage rule may tighten/widen the ring (Forest "Overgrowth" = 0.75×).
  const stageRingMul = (state.run && state.run.stageRuleSpawnRingMul) || 1;
  const r = (SPAWN.ringRadius + (Math.random() * 2 - 1) * SPAWN.ringJitter) * radiusMul * stageRingMul;
  const { x, z } = ringPos(angle, r);
  spawnEnemy(tier, x, z);
}

// ── Public API ───────────────────────────────────────────────────────────────
export function initSpawnDirector() {
  _acc = 0;
  _nextHorde = SPAWN.hordeIntervalSec;
  _nextChest = SPAWN.chestIntervalSec;
  _lastSeenTime = 0;
  _finalBossWarned = false;
  _finalBossSpawned = false;
  _miniBossIdx = 0;
  _miniBossWarnedFor = -1;
}

function spawnMiniBoss() {
  // Pick the strongest elite the player is allowed to fight at current D(t)
  const D = computeDifficulty(state.time.game);
  const eliteAllowed = ENEMY_TIERS.filter(t => t.elite && t.minD <= D + 1);
  const pool = eliteAllowed.length > 0 ? eliteAllowed : ENEMY_TIERS.filter(t => t.elite);
  if (pool.length === 0) return;
  const choice = pool[Math.floor(Math.random() * pool.length)];
  const buffed = {
    ...choice,
    hp: choice.hp * STAGE.miniBossHpMul,
    scale: (choice.scale || 1) * STAGE.miniBossScaleMul,
    isMiniBoss: true,
    _patternIdx: _miniBossIdx, // tells bossTelegraphs which signature attack
  };
  const angle = Math.random() * Math.PI * 2;
  spawnOnRing(buffed, angle, 1.3);
  state.fx.chromaticPulse = 0.9;
  state.fx.bloomBoost = 0.6;
  state.fx.shake = Math.max(state.fx.shake || 0, 0.5);
}

export function resetSpawnDirector() { initSpawnDirector(); }

/** Returns seconds-until next mini-boss, or null if all 3 are done / final boss next. */
export function secondsUntilNextMiniBoss() {
  if (_miniBossIdx >= STAGE.miniBossSchedule.length) return null;
  const due = STAGE.miniBossSchedule[_miniBossIdx];
  return Math.max(0, due - state.time.game);
}

function spawnFinalBoss() {
  // Pick the highest-minD elite (dragon if unlocked, else giant)
  const elites = ENEMY_TIERS.filter(t => t.elite);
  const choice = elites.reduce((best, cur) => (!best || cur.minD > best.minD) ? cur : best, null);
  if (!choice) return;
  const buffed = {
    ...choice,
    hp: choice.hp * STAGE.finalBossHpMul,
    scale: (choice.scale || 1) * STAGE.finalBossScaleMul,
    isFinalBoss: true,
  };
  const angle = Math.random() * Math.PI * 2;
  const r = SPAWN.ringRadius * 1.5;
  const hp = state.hero.pos;
  spawnEnemy(buffed, hp.x + Math.cos(angle) * r, hp.z + Math.sin(angle) * r);
  state.fx.chromaticPulse = 1.0;
  state.fx.bloomBoost = 1.0;
  state.fx.shake = 0.8;
}

export function tickSpawnDirector(dt) {
  const t = state.time.game;

  // Detect restart (game time rewound)
  if (t < _lastSeenTime) {
    _acc = 0;
    _nextHorde = SPAWN.hordeIntervalSec;
    _nextChest = SPAWN.chestIntervalSec;
    _finalBossWarned = false;
    _finalBossSpawned = false;
    _miniBossIdx = 0;
    _miniBossWarnedFor = -1;
  }
  _lastSeenTime = t;

  // Boss-rush mode compresses the boss schedule and pauses the cannon-fodder
  // swarm to focus entirely on boss fights. Stage 2+ can also shift the
  // final-boss time (Twilight Hollow = 12 min instead of 15).
  const bossRush  = !!(state.modes && state.modes.bossRush);
  const stageFB   = state.run && state.run.stageFinalBossAt;
  const baseSched = bossRush ? [25, 75, 135] : STAGE.miniBossSchedule;
  // Weekly BOSS_PARADE: a fourth mini-boss at 11:00 (660s). Only stacks onto
  // the normal schedule (not boss-rush) so we don't break that mode's pacing.
  const weeklyExtra = !bossRush && state.run && state.run.weeklyExtraMiniBoss;
  const miniSched = weeklyExtra ? [...baseSched, 660] : baseSched;
  const finalBossAt = bossRush
    ? 200
    : (stageFB != null ? stageFB : STAGE.finalBossAt);

  // ── Mini-boss schedule ──
  if (_miniBossIdx < miniSched.length) {
    const due = miniSched[_miniBossIdx];
    // Warn first
    if (_miniBossWarnedFor !== _miniBossIdx && t >= due - STAGE.miniBossWarnSec) {
      _miniBossWarnedFor = _miniBossIdx;
      showBanner('ELITE INCOMING', 3.0, '#ff8855');
      if (sfx && sfx.bossWarn) sfx.bossWarn();
    }
    // Spawn at due time
    if (t >= due) {
      spawnMiniBoss();
      const named = nameForMiniBoss(_miniBossIdx);
      showBanner(`${named.name} — ${named.subtitle.toUpperCase()}`, 2.6, '#ff8855');
      _miniBossIdx++;
    }
  }

  // ── Periodic chest spawn ──
  // Weekly CHEST_LOCKDOWN gates the entire schedule for the first N seconds
  // (default 300s = 5 min). We don't advance _nextChest during the lock window;
  // the first chest naturally spawns the instant the gate lifts because
  // _nextChest is already in the past.
  const weeklyChestLockSec = state.run && state.run.weeklyChestLockUntilSec ? state.run.weeklyChestLockUntilSec : 0;
  if (t >= _nextChest && t >= weeklyChestLockSec) {
    spawnChestNearHero(7, 14);
    // Luck shop upgrade speeds up the chest cadence by 3% per level.
    const luckMul = 1 - 0.03 * shopLevel('luck');
    const dailyMul = state.run && state.run.dailyChestMul ? state.run.dailyChestMul : 1;
    _nextChest = t + SPAWN.chestIntervalSec * luckMul * dailyMul;
  }

  // ── Final boss warning + spawn ──
  if (!_finalBossWarned && t >= finalBossAt - STAGE.finalBossWarnSec) {
    _finalBossWarned = true;
    showBanner('A POWERFUL FOE APPROACHES', 4.5, '#ff4444');
    if (sfx && sfx.bossWarn) sfx.bossWarn();
  }
  if (!_finalBossSpawned && t >= finalBossAt) {
    _finalBossSpawned = true;
    spawnFinalBoss();
    showBanner(`${FINAL_BOSS_NAME.name} — ${FINAL_BOSS_NAME.subtitle.toUpperCase()}`, 3.0, '#ffe14a');
  }

  _acc += dt;
  if (_acc < SPAWN.tickIntervalSec) return;
  _acc = 0;

  const D = computeDifficulty(t);

  // Tiers currently allowed by difficulty
  const allowedTiers = ENEMY_TIERS.filter(tier => tier.minD <= D);
  if (allowedTiers.length === 0) return;

  // ── Continuous top-up ──
  const dailyMul  = state.run && state.run.dailySpawnMul  ? state.run.dailySpawnMul  : 1;
  const ruleMul   = state.run && state.run.stageRuleSpawnMul ? state.run.stageRuleSpawnMul : 1;
  const weeklyMul = state.run && state.run.weeklySpawnMul ? state.run.weeklySpawnMul : 1;
  // Weekly DOUBLE_SPAWNS multiplies the target alive cap. Compose with daily +
  // stage-rule swarms so a Daily SWARM_DAY happening to be Weekly DOUBLE_SPAWNS
  // doesn't compound past targetAliveCap (still hard-capped below).
  const swarmMul = dailyMul * ruleMul * weeklyMul;
  // Boss rush: tiny ambient swarm (3-4 alive) so the player still has XP and
  // pickups, but the focus is the bosses.
  const target = bossRush
    ? 4
    : Math.min(
        SPAWN.targetAliveCap,
        (SPAWN.targetAliveBase + D * SPAWN.targetAlivePerD) * swarmMul
      );
  const deficit = target - state.enemies.active.length;
  if (deficit > 0) {
    const n = Math.min(SPAWN.spawnBatchPerTick, Math.ceil(deficit));
    for (let i = 0; i < n; i++) {
      const tier = weightedPick(allowedTiers);
      const angle = Math.random() * Math.PI * 2;
      spawnOnRing(tier, angle);
    }
  }

  // ── Horde event ──
  if (t >= _nextHorde) {
    // Mid-tier: allowed by D, not elite. Fall back to allowed if filter is empty.
    const hordePool = allowedTiers.filter(tier => !tier.elite);
    const pool = hordePool.length > 0 ? hordePool : allowedTiers;

    // Tight arc on one side of hero
    const center = Math.random() * Math.PI * 2;
    const arc = Math.PI / 3; // 60° spread
    for (let i = 0; i < SPAWN.hordeCount; i++) {
      const tier = weightedPick(pool);
      const angle = center + (Math.random() - 0.5) * arc;
      spawnOnRing(tier, angle);
    }

    state.fx.chromaticPulse = 0.8;
    state.fx.bloomBoost = 0.5;
    _nextHorde += SPAWN.hordeIntervalSec;
  }

}
