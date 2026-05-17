/**
 * Named passives — distinct from one-shot FILLERS. Each passive is a slot
 * with its own max level (default 5) and a per-level stat effect. They
 * compete with weapons + evolutions in the level-up pool, but live in their
 * own `state.passives` array so we can cap owned passives at MAX_PASSIVES.
 *
 * Apply pattern: when the player picks the same passive twice, the second
 * pick rebuilds the cumulative buff (statMul reset to base, then re-applied
 * for the new total level). Damage-reduction caps at 0.40× incoming damage
 * so stacking can't make the hero invincible.
 */
import { state } from '../state.js';

export const MAX_PASSIVES = 6;

/**
 * Each passive defines:
 *   id, name, icon, desc(level)         — UI metadata
 *   maxLevel                            — cap
 *   apply(level)                        — installs the cumulative effect
 *                                         (called every pick; idempotent —
 *                                         must replace previous level effect)
 */
export const PASSIVES = [
  {
    id: 'spinach',  name: 'Spinach',     icon: '🥬', maxLevel: 5,
    desc: lv => `+${lv * 12}% damage`,
    apply(level, prev) {
      const newMul  = 1 + 0.12 * level;
      const prevMul = 1 + 0.12 * (prev || 0);
      state.hero.statMul.dmg *= newMul / prevMul;
    },
  },
  {
    id: 'armor',    name: 'Armor',       icon: '🛡️', maxLevel: 5,
    desc: lv => `−${lv * 5}% damage taken`,
    apply(level, prev) {
      // dmgTaken multiplier: lower is better. ×0.95 / 0.90 / 0.85 / 0.80 / 0.75.
      const newMul  = 1 - 0.05 * level;
      const prevMul = 1 - 0.05 * (prev || 0);
      state.hero.statMul.dmgTaken *= newMul / prevMul;
    },
  },
  {
    id: 'wings',    name: 'Wings',       icon: '🪶', maxLevel: 5,
    desc: lv => `+${lv * 8}% move speed`,
    apply(level, prev) {
      const newMul  = 1 + 0.08 * level;
      const prevMul = 1 + 0.08 * (prev || 0);
      state.hero.statMul.moveSpeed *= newMul / prevMul;
    },
  },
  {
    id: 'tome',     name: 'Tome',        icon: '📕', maxLevel: 5,
    desc: lv => `−${lv * 10}% weapon cooldown`,
    apply(level, prev) {
      const newMul  = Math.max(0.40, 1 - 0.10 * level);
      const prevMul = Math.max(0.40, 1 - 0.10 * (prev || 0));
      state.hero.statMul.cooldown *= newMul / prevMul;
    },
  },
  {
    id: 'bracer',   name: 'Bracer',      icon: '🏹', maxLevel: 5,
    desc: lv => `+${lv * 18}% projectile speed`,
    apply(level, prev) {
      const newMul  = 1 + 0.18 * level;
      const prevMul = 1 + 0.18 * (prev || 0);
      state.hero.statMul.projSpeed *= newMul / prevMul;
    },
  },
  {
    id: 'duration', name: 'Empty Tome',  icon: '📜', maxLevel: 5,
    desc: lv => `+${lv * 16}% effect duration`,
    apply(level, prev) {
      const newMul  = 1 + 0.16 * level;
      const prevMul = 1 + 0.16 * (prev || 0);
      state.hero.statMul.duration *= newMul / prevMul;
    },
  },
  {
    id: 'hollow',   name: 'Hollow Heart',icon: '💗', maxLevel: 5,
    desc: lv => `+${lv * 20} max HP`,
    apply(level, prev) {
      const delta = 20 * (level - (prev || 0));
      state.hero.hpMax += delta;
      state.hero.hp = Math.min(state.hero.hpMax, state.hero.hp + delta);
    },
  },
  {
    id: 'pummarola',name: 'Pummarola',   icon: '🍅', maxLevel: 5,
    desc: lv => `regen +${(lv * 0.5).toFixed(1)} HP/s`,
    apply(level/*, prev*/) {
      state.hero.regenPerSec = 0.5 * level;   // absolute, replaces prev
    },
  },
  // ── New passives (iteration 2: combinatorics expansion) ────────────────────
  // Crown — stacks with shop "growth" via a multiplicative bonus consumed by
  // xp.js when awarding gem XP. Idempotent: write the absolute mul each pick.
  {
    id: 'crown',    name: 'Crown',       icon: '👑', maxLevel: 5,
    desc: lv => `+${lv * 10}% XP gain`,
    apply(level/*, prev*/) {
      // Absolute replacement keeps it idempotent. xp.js reads this flag.
      state.run.passive_xpMul = 1 + 0.10 * level;
    },
  },
  // Vampirism — on-kill heal in HP. The parent process will read the cap from
  // state.run.passive_vampHpPerKill when applying lifesteal in enemies.js.
  {
    id: 'vampirism',name: 'Vampirism',   icon: '🩸', maxLevel: 5,
    desc: lv => `On kill: heal ${lv} HP (max)`,
    apply(level/*, prev*/) {
      state.run.passive_vampLevel    = level;
      state.run.passive_vampHpPerKill = level;          // hard cap per kill
      state.run.passive_vampPct       = 0.01 * level;   // % of dmg-on-kill
    },
  },
  // Echo — chance for spawned projectile to be fired twice. Read at weapon
  // spawn sites by the parent process: Math.random() < state.run.passive_echoChance.
  {
    id: 'echo',     name: 'Echo',        icon: '🌀', maxLevel: 5,
    desc: lv => `${lv * 5}% chance projectiles fire twice`,
    apply(level/*, prev*/) {
      state.run.passive_echoChance = 0.05 * level;
    },
  },
  // Berserk — bonus damage scaling with missing HP. Active multiplier is
  // computed per-tick by the parent in damage application:
  //   dmgBonus = passive_berserkMax * (1 - hp / hpMax)
  // applied only when hp/hpMax <= 0.5 per design ("at 50% HP").
  {
    id: 'berserk',  name: 'Berserk',     icon: '😤', maxLevel: 5,
    desc: lv => `+${lv * 5}% damage at 50% HP (scales w/ missing HP)`,
    apply(level/*, prev*/) {
      state.run.passive_berserkMax = 0.05 * level;
    },
  },
  // Steadfast — knockback resistance + bonus knock on hero attacks.
  // Parent process reads passive_knockMul for outgoing knock, and
  // passive_staggerResist for incoming knock dampening (1 = full ignore).
  {
    id: 'steadfast',name: 'Steadfast',   icon: '⛰️', maxLevel: 5,
    desc: lv => `+${lv * 20}% knockback & stagger resist`,
    apply(level/*, prev*/) {
      state.run.passive_knockMul       = 1 + 0.20 * level;
      state.run.passive_staggerResist  = 0.20 * level;   // 0..1 dampening
    },
  },
  // Greed — coin/ember drop bonus from chests. Parent reads at chest payout.
  {
    id: 'greed',    name: 'Greed',       icon: '💰', maxLevel: 5,
    desc: lv => `+${lv * 10}% chest coin/ember drops`,
    apply(level/*, prev*/) {
      state.run.passive_greedMul = 1 + 0.10 * level;
    },
  },
  // Soul Link — pickup radius (immediate via statMul.magnet) AND
  // bonus XP-on-pickup (flag for xp.js).
  {
    id: 'soullink', name: 'Soul Link',   icon: '🔗', maxLevel: 5,
    desc: lv => `+${lv * 15}% pickup radius & XP per gem`,
    apply(level, prev) {
      const newMul  = 1 + 0.15 * level;
      const prevMul = 1 + 0.15 * (prev || 0);
      state.hero.statMul.magnet *= newMul / prevMul;
      state.run.passive_soulLinkXpMul = newMul;
    },
  },
  // Druid's Charm (P1H, 2026-05-17) — forest-only XP gain boost. Hidden in
  // the level-up pool until the player has cleared at least one sealed
  // room (state.run._sealedRooms gate; see passiveChoices below). Per-
  // level boost: 10% / 18% / 25% / 33% / 42%. Absolute write to
  // state.run.passive_druidXpMul (idempotent, mirrors Crown). Consumed by
  // src/xp.js — gated on state.run.stage.id === 'forest' so outside the
  // forest the multiplier is 1.0 (no bonus, no penalty). Picked into the
  // XP-mul chain as a multiplicative factor (NOT replacing Crown).
  {
    id: 'druid_charm', name: "Druid's Charm", icon: '🌿', maxLevel: 5,
    hidden: true,
    desc: lv => `+${[10, 18, 25, 33, 42][Math.max(0, Math.min(4, lv - 1))]}% XP gain in forest stage`,
    apply(level/*, prev*/) {
      const bonus = [0.10, 0.18, 0.25, 0.33, 0.42][Math.max(0, Math.min(4, level - 1))];
      // Absolute replacement keeps it idempotent across re-picks (matches
      // Crown's pattern). xp.js multiplies this in only when on forest.
      state.run.passive_druidXpMul = 1 + bonus;
    },
  },
];

/**
 * Druid's Charm unlock gate (Item P1H). Returns true when the player has
 * cleared at least one sealed room this run (any state.run._sealedRooms
 * entry with alive === false). Mirrors forestSealedDoors._clearedCount
 * (not exported, so we inline the scan here — cheap, 1-3 keys max).
 * Falls back to false on any shape mismatch so a partial save reload can't
 * silently unlock the passive.
 */
function _druidUnlocked() {
  try {
    const sealed = state && state.run && state.run._sealedRooms;
    if (!sealed || typeof sealed !== 'object') return false;
    for (const id in sealed) {
      const rec = sealed[id];
      if (rec && rec.alive === false) return true;
    }
  } catch (_) { /* ignore */ }
  return false;
}

/** Roll-time helper: returns picks the player can still benefit from. */
export function passiveChoices(n) {
  const owned = new Map((state.passives || []).map(p => [p.id, p]));
  const slotsLeft = MAX_PASSIVES - owned.size;
  const pool = [];
  for (const p of PASSIVES) {
    // Hidden passives stay out of the offer pool until their unlock fires.
    // Druid's Charm: wait for first sealed-room clear (P1H gate). Owned
    // hidden entries (i.e. already picked once via another path) still show
    // level-up upgrades because the hidden gate only filters NEW picks.
    if (p.hidden && !owned.has(p.id)) {
      if (p.id === 'druid_charm' && !_druidUnlocked()) continue;
      // Unknown hidden ids stay locked by default (defensive).
      if (p.id !== 'druid_charm') continue;
    }
    const have = owned.get(p.id);
    if (have) {
      if (have.level < p.maxLevel) {
        pool.push({ kind: 'passive', id: p.id, level: have.level + 1,
                    name: p.name, icon: p.icon, desc: p.desc(have.level + 1) });
      }
    } else if (slotsLeft > 0) {
      pool.push({ kind: 'passive', id: p.id, level: 1,
                  name: p.name, icon: p.icon, desc: p.desc(1) });
    }
  }
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }
  return pool.slice(0, n);
}

/** Apply a passive pick (level-up or new acquisition). */
export function applyPassive(choice) {
  if (!state.passives) state.passives = [];
  const def = PASSIVES.find(p => p.id === choice.id);
  if (!def) return;
  let entry = state.passives.find(p => p.id === choice.id);
  const prevLevel = entry ? entry.level : 0;
  if (!entry) {
    if (state.passives.length >= MAX_PASSIVES) return; // safety: shouldn't happen
    entry = { id: choice.id, level: 0 };
    state.passives.push(entry);
  }
  if (entry.level >= def.maxLevel) return;
  entry.level += 1;
  def.apply(entry.level, prevLevel);
  // Persist the high-water-mark level reached for this passive across all runs
  // (used by the Grimoire codex). Lazy import keeps this file decoupled.
  try {
    import('../meta.js').then(({ getMeta, saveMeta }) => {
      const meta = getMeta();
      if (!meta.passivesSeen) meta.passivesSeen = {};
      const cur = meta.passivesSeen[choice.id] || 0;
      if (entry.level > cur) {
        meta.passivesSeen[choice.id] = entry.level;
        saveMeta();
      }
    });
  } catch (_) { /* meta unavailable; ignore */ }
}
