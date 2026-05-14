/**
 * Iter 8 — Enemy Affix System
 *
 * Spawn-time roll that stamps "slot fields" on an enemy so the existing
 * damage / kill / update loops in enemies.js can read them without branching
 * per affix. Each affix is one named threat grammar:
 *
 *   Volatile  — don't melee, don't dash through (death explosion)
 *   Vampiric  — burst-or-bust; chip damage loses
 *   Leaping   — position-aware; dash-cancellable
 *   Shielded  — burst-immune; rewards sustained DPS
 *   Swift     — fast + glassy; punishes camping
 *   Frosted   — don't get in melee range (aura slow)
 *
 * Roll weights by D(t):
 *   D < 2          → no affixes (tutorial-friendly opening)
 *   2 ≤ D < 4      → 10% chance of 1 affix
 *   4 ≤ D < 5      → 30% chance of 1 affix
 *   D ≥ 5 + elite  → 50% chance of 1 affix; 20% chance of a second distinct affix
 *
 * Final bosses + mini-bosses are SKIPPED — their per-boss patterns own identity
 * (8b owns those). Plain elites + tier mobs all roll.
 *
 * Codex hook: notifyAffixSeen(id) is called on every apply() — codex.js (8c)
 * dedupes the discovery toast.
 *
 * Field name contract (8c reads silhouette tints off these):
 *   e._volatile      = true
 *   e._vampPct       = 0.15
 *   e._leapCD        = 4.0
 *   e._leapWindup    = 0
 *   e._leapTargetX   = number | undefined
 *   e._leapTargetZ   = number | undefined
 *   e._shieldHp      = 50
 *   e._shieldedRim   = true
 *   e._swiftMul      = 1.6   (apply-time also: e.spd *= 1.6; e.dmg *= 0.6)
 *   e._frostAura    = 3
 *   e.affixes        = ['volatile', ...]   (codex + UI lookup)
 */

/** @type {Array<{id:string, name:string, weight:number, apply:Function, onDeath:Function|null, onAuraTick:Function|null}>} */
export const AFFIX_POOL = [
  {
    id: 'volatile',
    name: 'Volatile',
    weight: 1,
    apply(e) { e._volatile = true; },
    onDeath: null,    // queued by enemies.killEnemy → state.fx.pendingVolatile
    onAuraTick: null,
  },
  {
    id: 'vampiric',
    name: 'Vampiric',
    weight: 1,
    apply(e) { e._vampPct = 0.15; },
    onDeath: null,
    onAuraTick: null,
  },
  {
    id: 'leaping',
    name: 'Leaping',
    weight: 1,
    apply(e) {
      e._leapCD = 4.0;
      e._leapWindup = 0;
      e._leapTargetX = undefined;
      e._leapTargetZ = undefined;
    },
    onDeath: null,
    onAuraTick: null,
  },
  {
    id: 'shielded',
    name: 'Shielded',
    weight: 1,
    apply(e) {
      e._shieldHp = 50;
      e._shieldedRim = true;
    },
    onDeath: null,
    onAuraTick: null,
  },
  {
    id: 'swift',
    name: 'Swift',
    weight: 1,
    apply(e) {
      // Apply-time mutation: faster move, glass-jaw contact dmg.
      e._swiftMul = 1.6;
      e.spd *= 1.6;
      e.dmg *= 0.6;
    },
    onDeath: null,
    onAuraTick: null,
  },
  {
    id: 'frosted',
    name: 'Frosted',
    weight: 1,
    apply(e) { e._frostAura = 3; },
    onDeath: null,
    onAuraTick: null,
  },
];

const _affixById = Object.create(null);
for (const a of AFFIX_POOL) _affixById[a.id] = a;
export function getAffix(id) { return _affixById[id] || null; }

// ── Roll math ────────────────────────────────────────────────────────────────
function _pickWeighted(pool) {
  let total = 0;
  for (const a of pool) total += a.weight;
  let r = Math.random() * total;
  for (const a of pool) {
    r -= a.weight;
    if (r <= 0) return a;
  }
  return pool[pool.length - 1];
}

/**
 * Mutates `enemy` in place: stamps slot fields, populates `enemy.affixes = [ids]`.
 * `D` is the current difficulty value from spawnDirector.computeDifficulty(t).
 *
 * Skipped entirely for final bosses and mini-bosses — those own their own
 * identity via per-boss attack patterns (8b).
 */
export function rollAffixes(enemy, D) {
  if (!enemy) return;
  if (enemy.isFinalBoss || enemy.isMiniBoss) return;
  if (D < 2) return;

  let chanceOne = 0;
  let chanceTwo = 0;
  if (D < 4) {
    chanceOne = 0.10;
  } else if (D < 5) {
    chanceOne = 0.30;
  } else if (enemy.elite) {
    chanceOne = 0.50;
    chanceTwo = 0.20;
  } else {
    // Non-elite at D ≥ 5: keep them in the "30% at D=4" bracket so swarms
    // don't all sprout affixes simultaneously and overwhelm the readability layer.
    chanceOne = 0.30;
  }

  if (Math.random() >= chanceOne) return;

  const first = _pickWeighted(AFFIX_POOL);
  _applyAndStamp(enemy, first);

  if (chanceTwo > 0 && Math.random() < chanceTwo) {
    // Pick a *distinct* second affix.
    const remaining = AFFIX_POOL.filter(a => a.id !== first.id);
    if (remaining.length > 0) {
      const second = _pickWeighted(remaining);
      _applyAndStamp(enemy, second);
    }
  }
}

function _applyAndStamp(enemy, affix) {
  if (!enemy.affixes) enemy.affixes = [];
  enemy.affixes.push(affix.id);
  try { affix.apply(enemy); } catch (e) { console.warn('[affix.apply]', affix.id, e); }
  // Codex discovery — dedupe lives in 8c's notifyAffixSeen.
  // Defensive: 8c may not have shipped yet; swallow missing-export softly.
  try {
    import('./codex.js')
      .then(m => { if (m && typeof m.notifyAffixSeen === 'function') m.notifyAffixSeen(affix.id); })
      .catch(() => {});
  } catch (_) {}
}
