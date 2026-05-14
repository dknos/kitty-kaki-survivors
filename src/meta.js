/**
 * Persistent meta-progression: coins, run history, unlocks.
 * Stored in localStorage under a single namespaced key. Versioned so we can
 * migrate without nuking saves later.
 */

// Iter 11c — read state.run.passive_coinMul (SHOP_TREE Greed tier-1 "Magpie"
// bonus baked in applyMetaUpgrades) inside commitRunResults. No circular dep:
// state.js does not import meta.js. Adding the only import in this file.
import { state } from './state.js';

const SAVE_KEY = 'kk-survivors-meta-v1';

const DEFAULT = {
  version: 1,
  coins: 0,
  embers: 0,          // House-upgrade currency. Scarce — ~3-6 per run.
  house: {},          // { kitchen: 2, cellar: 1, ... } owned levels
  // ── Quest board (90s CRT in the house interior) ──
  // Active: array of current bounties (length cap depends on lainTerminal flag).
  // Completed: lifetime tally for the "quests done" stat.
  quests: { active: [], completedCount: 0, lainTerminal: false },
  runs: 0,
  bestTime: 0,
  bestKills: 0,
  totalKills: 0,
  // ── Options ──
  optVolume: 0.7,             // legacy single-slider value; kept for back-compat
  optShake: 1.0,
  optMusic: false,    // user prefers silence by default; opt-in via options menu
  // ── Iter 10a audio mix split — Master/Music/SFX (defaults: combat readability) ──
  optMasterVolume: 1.0,
  optMusicVolume: 0.5,
  optSfxVolume: 0.7,
  // ── Iter 10a accessibility ──
  // Reduce Motion: skip screen shake, chromatic aberration, VFX bursts.
  // ReduceMotionUserSet sentinel = true once the user explicitly toggled the
  // option; this lets boot honor `prefers-reduced-motion` only on first run.
  optReduceMotion: false,
  optReduceMotionUserSet: false,
  optReducedFlashing: false,
  optHighContrast: false,
  optColorblind: 'off',          // 'off' | 'deuteranopia' | 'protanopia' | 'tritanopia'
  optFontScale: 1.0,             // 0.85..1.30, surfaced via --kk-font-scale CSS var
  optFrameCap: 0,                // 0=unlocked; 30/60/144 valid
  optControllerDeadzone: 0.15,   // 0..0.30 — gamepad.js reads this
  optLanguage: 'en',             // i18n stub for v1.1+
  // First-run tutorial seen flag (legacy single-card overlay)
  seenTutorial: false,
  // Guided 6-stage tutorial completion (src/tutorial.js)
  tutorialDone: false,
  // Achievement unlock map: { id: timestamp }
  achievements: {},
  // Shop purchased levels: { hp: 2, magnet: 1, ... }
  shop: {},
  // Mode unlocks (true after first victory)
  unlockedHyper: false,
  unlockedEndless: false,
  unlockedCinder: false,    // unlocked by victory on Twilight Hollow
  // Character unlock flag — Clockwork drops on first Boss Rush victory on
  // Twilight Hollow (hardest combination currently in-game). Flipped in
  // commitRunResults; read by isCharacterUnlocked() for the 'flag:...' form.
  unlockedClockwork: false,
  // Iter 22B — Catacomb Void clear flag. Gates the Seedy Tent (casino) in
  // town.js. Set in commitRunResults on first victory with stageId==='void'.
  unlockedVoid: false,
  // ── Casino (iter 22B) ───────────────────────────────────────────────
  // Persisted gambling stats. The Seedy Tent reads casinoUnlocked through
  // unlockedVoid; the lifetime fields drive a future "high roller" achievement
  // and are surfaced in the casino menu header so the player can track ROI.
  // casinoBossRushClears is the snapshot counter the wager settlement uses
  // (compared against the clearsSnapshot stored in localStorage).
  casinoUnlocked: false,
  casinoLifetimeWagered: 0,
  casinoLifetimeWon: 0,
  casinoSlotsBigWins: 0,
  casinoBossRushClears: 0,
  // Mode toggles for the next run
  optHyper: false,
  optEndless: false,
  // VFX intensity (0.0..1.0)
  optVfx: 1.0,
  // Mouse-aim mode (overrides nearest-enemy targeting for autoaim/volley)
  optManualAim: false,
  // Boss Rush mode — compressed boss-only run. Unlocks alongside Hyper/Endless.
  optBossRush: false,
  // Weekly mutator mode — opt-in for the next run. Mutually exclusive with
  // Daily/BossRush (enforced by main.js applyMetaUpgrades). Iter 9.
  optWeekly: false,
  // Discovered evolutions: { evolutionId: timestamp }
  discoveries: {},
  // Passive codex: high-water-mark level reached for each passive id, across runs.
  // Surfaced in the Grimoire so players see their cumulative mastery.
  passivesSeen: {},
  // Selected character id for the next run
  selectedChar: 'kitty',
  // Selected stage id for the next run
  selectedStage: 'forest',
  // Secret unlocks (cryptic conditions): { id: timestamp }
  secrets: {},
  // Lifetime counters used to test cumulative secret conditions
  lifetime: {
    bugKills: 0,      // ant/beetle/etc (tiers with procAnim)
    jackpots: 0,      // 7-7-7 slot hits
    coinsEverEarned: 0,
    // Cumulative sigils ever earned (separate from meta.sigils, which is
    // the *spendable* balance — buying a tree node decrements that but
    // does NOT touch lifetime). Drives the 'sigils:N' unlock form for
    // characters like Phoenix Vow (sigils:30).
    sigilsEarned: 0,
    // Iter 9: cumulative chests opened across all runs. Bumped from the
    // existing questEvent('chestOpen') handler so we don't add a new call
    // site — drives the chest_hoarder tier-2 achievement.
    chestsOpened: 0,
    // Iter 9: distinct runs where the player defeated ALL 3 mini-bosses.
    // Bumped from commitRunResults when state.run.allMiniBosses is set by
    // the run-end caller. Drives triple_x3.
    fullSweepRuns: 0,
    // Iter 18: Helltide lifetime stats — bumped from helltide.endHelltide()
    // at every event end. Surfaced in the Hall of Records modal so the
    // run-currency feels persistent.
    helltideEmbersTotal: 0,   // cumulative ⚜ banked across all runs
    helltideMaxBanked: 0,     // best single-Helltide bank across history
  },
  // Daily challenge: persistent best per-day; rolls over at local midnight
  dailyRun: {
    date: '',         // 'YYYY-MM-DD' of the recorded best
    attempts: 0,
    bestKills: 0,
    bestTime: 0,
  },
  // Iter 9: Weekly mutator best. Keyed by ISO 8601 week ('2026-W19'). Resets
  // on rollover (Monday 00:00 UTC by isoWeekKey()). Two independent bests
  // (kills + time) mirror the daily contract.
  weeklyBestKey: '',
  weeklyBest: { kills: 0, time: 0, character: 'kitty', stage: 'forest' },
  weeklyAttempts: 0,
  // Affix relics dropped by the final boss. Each = { id, name, tier, affixes }.
  // Most recent is auto-equipped on run start.
  relics: [],
  equippedRelic: null,    // id of the currently-equipped relic (or null)
  // ── Iter 6 ("Meta With Teeth") ──
  // Sigils: prestige currency earned from boss kills, quests, dailies.
  // shopTree: { nodeId: 1 } for purchased branch-tree upgrades (SHOP_TREE below).
  // presets: saved character+stage combos for quick re-launch from the menu.
  sigils: 0,
  shopTree: {},
  presets: [],
};

// ── Affix relics (final boss loot) ───────────────────────────────────────────
// Each entry: id, label, statKey, rollRange [min, max], formatter.
export const AFFIX_POOL = [
  { id: 'dmg',       label: 'Power',      stat: 'dmg',         range: [0.04, 0.22], fmt: v => `+${(v*100).toFixed(0)}% damage` },
  { id: 'hpMax',     label: 'Vitality',   stat: 'hpMax',       range: [10, 40],     fmt: v => `+${Math.round(v)} max HP` },
  { id: 'moveSpeed', label: 'Swiftness',  stat: 'moveSpeed',   range: [0.04, 0.18], fmt: v => `+${(v*100).toFixed(0)}% move speed` },
  { id: 'magnet',    label: 'Attraction', stat: 'magnet',      range: [0.10, 0.35], fmt: v => `+${(v*100).toFixed(0)}% pickup radius` },
  { id: 'projSpeed', label: 'Velocity',   stat: 'projSpeed',   range: [0.06, 0.25], fmt: v => `+${(v*100).toFixed(0)}% projectile speed` },
  { id: 'cooldown',  label: 'Cadence',    stat: 'cooldown',    range: [-0.08, -0.22], fmt: v => `${(v*100).toFixed(0)}% weapon cooldown` },
  { id: 'duration',  label: 'Endurance',  stat: 'duration',    range: [0.08, 0.28], fmt: v => `+${(v*100).toFixed(0)}% effect duration` },
];

const TIER_THRESHOLD = [
  { name: 'Common',    color: '#cfd6cc', minRoll: 0.0 },
  { name: 'Rare',      color: '#7fb7ff', minRoll: 0.5 },
  { name: 'Epic',      color: '#c87bff', minRoll: 0.78 },
  { name: 'Mythic',    color: '#ffd27f', minRoll: 0.94 },
];

function _roll(min, max) { return min + Math.random() * (max - min); }

/** Roll a fresh relic. 2 affixes, tier derived from average roll quality. */
export function rollRelic() {
  // Pick 2 distinct affix slots
  const pool = AFFIX_POOL.slice();
  pool.sort(() => Math.random() - 0.5);
  const picks = pool.slice(0, 2);
  let qualityAvg = 0;
  const affixes = picks.map(a => {
    const [lo, hi] = a.range;
    const t = Math.random();          // 0..1 roll quality
    qualityAvg += t;
    const value = lo + (hi - lo) * t;
    return { id: a.id, stat: a.stat, value, label: a.label, fmt: a.fmt(value) };
  });
  qualityAvg /= picks.length;
  let tier = TIER_THRESHOLD[0];
  for (const tDef of TIER_THRESHOLD) if (qualityAvg >= tDef.minRoll) tier = tDef;
  const id = 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
  return {
    id,
    name: `${tier.name} ${affixes[0].label} ${affixes[1].label}`,
    tier: tier.name,
    tierColor: tier.color,
    affixes,
    droppedAt: Date.now(),
  };
}

/** Persist a relic. Auto-equips the new drop if no relic is currently equipped. */
export function addRelic(relic) {
  const meta = getMeta();
  if (!meta.relics) meta.relics = [];
  meta.relics.push(relic);
  if (!meta.equippedRelic) meta.equippedRelic = relic.id;
  saveMeta();
}

/** Returns the currently-equipped relic def, or null. */
export function equippedRelic() {
  const meta = getMeta();
  if (!meta.equippedRelic || !meta.relics) return null;
  return meta.relics.find(r => r.id === meta.equippedRelic) || null;
}

/** Equip a relic by id (or null to un-equip). Returns the def now equipped. */
export function equipRelic(id) {
  const meta = getMeta();
  meta.equippedRelic = id || null;
  saveMeta();
  return equippedRelic();
}

/** Today's local-date key 'YYYY-MM-DD'. */
export function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Stable 32-bit hash of a string (xfnv1a). Used as the daily seed. */
function _hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Pick today's daily-challenge configuration deterministically from the date.
 * Returns { date, character, modifierLabel } where character is one of the
 * CHARACTER ids. modifierLabel is a player-facing flavor string.
 */
export function dailyChallengeConfig(characterIds) {
  const date = todayKey();
  const seed = _hashStr(date);
  const charIdx = seed % characterIds.length;
  const modifiers = ['NO SHOP BONUSES', 'HARDER SPAWNS', 'FAST CHESTS', 'LOW HP', 'SWARM DAY'];
  const modIdx = (seed >>> 8) % modifiers.length;
  return {
    date,
    character: characterIds[charIdx],
    modifier: modifiers[modIdx],
    seed,
  };
}

/**
 * ISO 8601 week key, e.g. '2026-W19'. Thursday determines the year; weeks
 * start Monday. Computed entirely in UTC to avoid the Sun/Mon midnight drift
 * that bit us in early daily testing — leaderboard cadence MUST be globally
 * consistent so two players in different TZs see the same active mutator.
 */
export function isoWeekKey() {
  const d = new Date();
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/**
 * Pick this week's mutator deterministically from the ISO week key. Mirrors
 * dailyChallengeConfig: same xfnv1a hash → bounded index into the WEEKLY_MUTATORS
 * pool. Returns { weekKey, mutatorId, mutatorLabel, seed } so callers can
 * render flavor + dispatch the apply() side-effect from weeklyMutator.js.
 *
 * The pool is imported lazily to keep this module's import graph clean
 * (weeklyMutator.js only re-imports the constant labels, not behavior).
 */
export function weeklyMutatorConfig() {
  // Local mirror of WEEKLY_MUTATORS shape — keep ids in sync with
  // src/weeklyMutator.js. Six total; one rolls per ISO week.
  const POOL = [
    { id: 'DOUBLE_SPAWNS',    label: 'Double Spawns' },
    { id: 'HALF_HP_HALF_DMG', label: 'Glass Hordes' },
    { id: 'CHEST_LOCKDOWN',   label: 'Chest Lockdown' },
    { id: 'BOSS_PARADE',      label: 'Boss Parade' },
    { id: 'NO_PASSIVES',      label: 'No Passives' },
    { id: 'XP_FAMINE',        label: 'XP Famine' },
  ];
  const weekKey = isoWeekKey();
  const seed = _hashStr(weekKey);
  const pick = POOL[seed % POOL.length];
  return {
    weekKey,
    mutatorId: pick.id,
    mutatorLabel: pick.label,
    seed,
  };
}

/**
 * Commit a weekly-mutator run. Bumps attempts; resets the record on week
 * rollover. Mirrors commitDailyRun's two-independent-bests contract (kills
 * and time are tracked separately, so a kill-record run and a survive-record
 * run can both land in the same week). Returns { newKillsBest, newTimeBest,
 * weekKey } so the death screen can toast.
 *
 * character + stage are persisted on the best entry so the records modal can
 * show the loadout that achieved it.
 */
export function commitWeeklyRun({ kills, time, character, stage } = {}) {
  const meta = getMeta();
  const weekKey = isoWeekKey();
  if (!meta.weeklyBest || meta.weeklyBestKey !== weekKey) {
    meta.weeklyBestKey = weekKey;
    meta.weeklyBest = { kills: 0, time: 0, character: character || 'kitty', stage: stage || 'forest' };
    meta.weeklyAttempts = 0;
  }
  meta.weeklyAttempts = (meta.weeklyAttempts || 0) + 1;
  const k = Number(kills) || 0;
  const t = Number(time) || 0;
  let newKillsBest = false, newTimeBest = false;
  if (k > (meta.weeklyBest.kills || 0)) {
    meta.weeklyBest.kills = k;
    meta.weeklyBest.character = character || meta.weeklyBest.character;
    meta.weeklyBest.stage = stage || meta.weeklyBest.stage;
    newKillsBest = true;
  }
  if (t > (meta.weeklyBest.time || 0)) {
    meta.weeklyBest.time = t;
    meta.weeklyBest.character = character || meta.weeklyBest.character;
    meta.weeklyBest.stage = stage || meta.weeklyBest.stage;
    newTimeBest = true;
  }
  saveMeta();
  return { newKillsBest, newTimeBest, weekKey };
}

/**
 * Walk the achievement DAG for `id`, returning the entry plus its immediate
 * parents/children defs and a 0..1 percentComplete (1 if unlocked, else the
 * progress() lambda or 0 for binary-only entries). Defensive against typo'd
 * `requires` edges — unknown parent ids are silently skipped so a future
 * build's save data can't crash today's codex render.
 */
export function achievementChain(id) {
  const meta = getMeta();
  const achievement = ACHIEVEMENTS.find(a => a.id === id);
  if (!achievement) {
    return { achievement: null, parents: [], children: [], percentComplete: 0 };
  }
  const parents = (achievement.requires || [])
    .map(pid => ACHIEVEMENTS.find(a => a.id === pid))
    .filter(Boolean);
  const children = ACHIEVEMENTS.filter(a =>
    Array.isArray(a.requires) && a.requires.includes(id)
  );
  const unlocked = !!(meta.achievements && meta.achievements[id]);
  let percentComplete;
  if (unlocked) {
    percentComplete = 1;
  } else if (typeof achievement.progress === 'function') {
    const p = achievement.progress(meta);
    percentComplete = Math.max(0, Math.min(1, Number(p) || 0));
  } else {
    percentComplete = 0;
  }
  return { achievement, parents, children, percentComplete };
}

/**
 * Commit a daily-challenge run result. Resets the record if the stored date
 * is older than today (new day = fresh leaderboard).
 */
export function commitDailyRun({ kills, timeSurvived }) {
  const meta = getMeta();
  const today = todayKey();
  if (!meta.dailyRun || meta.dailyRun.date !== today) {
    meta.dailyRun = { date: today, attempts: 0, bestKills: 0, bestTime: 0 };
  }
  meta.dailyRun.attempts += 1;
  let newKillsBest = false, newTimeBest = false;
  if (kills > meta.dailyRun.bestKills) { meta.dailyRun.bestKills = kills; newKillsBest = true; }
  if (timeSurvived > meta.dailyRun.bestTime) { meta.dailyRun.bestTime = timeSurvived; newTimeBest = true; }
  saveMeta();
  return { newKillsBest, newTimeBest };
}

/**
 * Secret unlocks — cryptic conditions surfaced only after the player stumbles
 * on them. Different from achievements: secrets toast with a purple "★ SECRET
 * FOUND" frame and live in their own Grimoire tab. Conditions are checked at
 * the relevant call sites and persisted in meta.secrets.
 */
export const SECRETS = [
  { id: 'bug_lord',         name: 'Bug Lord',           desc: 'Lifetime extermination',                  icon: '🪲', hint: 'Show no mercy to the smaller things.' },
  { id: 'untouchable_5min', name: 'Untouchable',        desc: 'Reach 5:00 without taking damage',        icon: '🛡️', hint: 'A perfect first act.' },
  { id: 'speedrun_lv10',    name: 'Faster Than Light',  desc: 'Hit level 10 in under 2:00',              icon: '⚡', hint: 'Greed pays dividends.' },
  { id: 'pacifist_100',     name: 'Flawless',           desc: 'Kill 100 enemies without taking damage',  icon: '🕊️', hint: 'Carve a path; leave no trace.' },
  { id: 'triple_jackpot',   name: 'House Always Wins',  desc: 'Hit 3 lifetime jackpots',                 icon: '🎰', hint: 'The wheel remembers.' },
  { id: 'marathon',         name: 'The Long Night',     desc: 'Survive 25:00 in a single run',           icon: '🌙', hint: 'Outlast the dawn.' },
  { id: 'hoarder',          name: 'Hoarder',            desc: 'Earn 500 coins lifetime',                 icon: '💰', hint: 'Wealth is its own weapon.' },
];

// Persistent meta-upgrade shop. Each upgrade has 5 levels at escalating cost.
// Effects apply at run start (in main.js boot). Hard cap at MAX level.
export const SHOP_UPGRADES = [
  { id: 'hp',      name: 'Iron Resolve',  desc: '+10 Max HP per level',          icon: '❤️', max: 5, baseCost: 25 },
  { id: 'magnet',  name: 'Lodestone',     desc: '+15% pickup radius per level',  icon: '🧲', max: 5, baseCost: 25 },
  { id: 'speed',   name: 'Swift Boots',   desc: '+5% move speed per level',      icon: '👟', max: 5, baseCost: 30 },
  { id: 'damage',  name: 'Sharpened',     desc: '+5% damage per level',          icon: '⚔️', max: 5, baseCost: 35 },
  { id: 'growth',  name: 'Quick Study',   desc: '+8% XP gain per level',         icon: '📖', max: 5, baseCost: 30 },
  { id: 'luck',    name: 'Lucky Charm',   desc: '+3% chest spawn rate per level',icon: '🍀', max: 5, baseCost: 30 },
];

export function upgradeCost(upg, currentLevel) {
  // Quadratic cost ramp: lvl 0→25, 1→50, 2→100, 3→200, 4→400
  return Math.floor(upg.baseCost * Math.pow(2, currentLevel));
}

// ── House upgrades — permanent run-start buffs purchased with Embers. ──
// Smaller tracks (max 3) than the shop. Each track is mechanically distinct
// from the shop so the two currencies don't feel redundant.
export const HOUSE_UPGRADES = [
  { id: 'kitchen',    name: 'Kitchen',    desc: '+20 starting HP per level',         icon: '🍲', max: 3, costs: [1, 3, 8] },
  { id: 'cellar',     name: 'Cellar',     desc: 'Starter weapon begins +1 level',    icon: '🍷', max: 3, costs: [2, 5, 12] },
  { id: 'garden',     name: 'Garden',     desc: 'Heart pickups +50% potency',        icon: '🌿', max: 3, costs: [1, 3, 8] },
  { id: 'shrine',     name: 'Shrine',     desc: '+1 starting reroll per level',      icon: '⛩️', max: 3, costs: [1, 4, 10] },
  { id: 'apothecary', name: 'Apothecary', desc: '+0.5 HP/s passive regen per level', icon: '🌡', max: 3, costs: [2, 5, 12] },
  { id: 'vault',      name: 'Vault',      desc: '+25% end-of-run coins per level',   icon: '🏦', max: 3, costs: [1, 3, 8] },
  // One-time unlock: swap the 90s CRT for a Lain Navi terminal that allows
  // three concurrent active quests instead of one. Pricier than a stat track
  // because it's a permanent capability upgrade, not a stack.
  { id: 'lain',       name: 'Lain Navi',  desc: 'Upgrade CRT → Navi terminal · 3 active quests', icon: '💠', max: 1, costs: [20] },
];

export function houseLevel(id) {
  const meta = getMeta();
  return (meta.house && meta.house[id]) || 0;
}

export function houseCost(upg, currentLevel) {
  if (currentLevel >= upg.max) return Infinity;
  return upg.costs[currentLevel] || Infinity;
}

// ── Quest system ──
// A quest is a goal-based bounty the player accepts at the house computer.
// It tracks progress via in-game event hooks (killEnemy, chest open, etc.)
// and is claimed on return to the computer for coins + embers.
export const QUEST_TEMPLATES = [
  // Hunt: kill N enemies of a tier-keyed type (glb key, matching ENEMY_TIERS).
  { id: 'hunt_zombies', kind: 'hunt', target: 'zombie', goal: 30, name: 'Thin the Wandering Dead', desc: 'Slay 30 zombies (Mushnubs).', icon: '🧟', coins: 60, embers: 1 },
  { id: 'hunt_bugs',    kind: 'hunt', target: 'ant',    goal: 60, name: 'Pest Control',            desc: 'Crush 60 ants.',           icon: '🐜', coins: 50, embers: 1 },
  { id: 'hunt_spider',  kind: 'hunt', target: 'spider', goal: 20, name: 'Web Sweeper',             desc: 'Slay 20 spiders.',         icon: '🕷', coins: 70, embers: 1 },
  { id: 'hunt_wolves',  kind: 'hunt', target: 'wolf',   goal: 15, name: 'Wolfsbane',               desc: 'Slay 15 wolves.',          icon: '🐺', coins: 90, embers: 2 },
  { id: 'hunt_demon',   kind: 'hunt', target: 'demon',  goal: 10, name: 'Demonslayer',             desc: 'Defeat 10 demons.',        icon: '👹', coins: 110, embers: 2 },
  // Boss: defeat any mini-boss (count goal = how many across runs).
  { id: 'boss_mini',    kind: 'boss', target: 'mini',   goal: 3,  name: 'Three Trials',            desc: 'Defeat 3 mini-bosses (any run).', icon: '🛡', coins: 200, embers: 4 },
  { id: 'boss_final',   kind: 'boss', target: 'final',  goal: 1,  name: 'The Nightmare',           desc: 'Defeat a final boss.',     icon: '👑', coins: 400, embers: 6 },
  // Survive: live N seconds in a single run.
  { id: 'survive_5',    kind: 'survive', goal: 300, name: 'Five Minutes of Hell', desc: 'Survive 5 minutes in one run.', icon: '⏱', coins: 80, embers: 1 },
  { id: 'survive_10',   kind: 'survive', goal: 600, name: 'A Long Hunt',          desc: 'Survive 10 minutes in one run.', icon: '⏳', coins: 180, embers: 3 },
  // Collect: chests opened across runs.
  { id: 'collect_chests', kind: 'collect', target: 'chest', goal: 5, name: 'Treasure Seeker', desc: 'Open 5 chests (any runs).', icon: '🎁', coins: 80, embers: 1 },
  // Hoard: total coins earned across runs.
  { id: 'hoard_coins',  kind: 'hoard', target: 'coins', goal: 250, name: 'Bag of Gold', desc: 'Earn 250 coins across runs.', icon: '💰', coins: 100, embers: 2 },
];

export function maxActiveQuests() {
  const meta = getMeta();
  return (meta.quests && meta.quests.lainTerminal) ? 3 : 1;
}

/** Return the list of templates not currently active. Used by the offer screen. */
export function availableQuests() {
  const meta = getMeta();
  if (!meta.quests) meta.quests = { active: [], completedCount: 0, lainTerminal: false };
  const activeIds = new Set(meta.quests.active.map(q => q.id));
  return QUEST_TEMPLATES.filter(t => !activeIds.has(t.id));
}

export function activeQuests() {
  const meta = getMeta();
  if (!meta.quests) meta.quests = { active: [], completedCount: 0, lainTerminal: false };
  return meta.quests.active;
}

export function acceptQuest(id) {
  const meta = getMeta();
  if (!meta.quests) meta.quests = { active: [], completedCount: 0, lainTerminal: false };
  if (meta.quests.active.length >= maxActiveQuests()) return false;
  if (meta.quests.active.some(q => q.id === id)) return false;
  const tpl = QUEST_TEMPLATES.find(t => t.id === id);
  if (!tpl) return false;
  meta.quests.active.push({ id, progress: 0, acceptedAt: Date.now() });
  saveMeta();
  return true;
}

export function abandonQuest(id) {
  const meta = getMeta();
  if (!meta.quests) return false;
  const i = meta.quests.active.findIndex(q => q.id === id);
  if (i < 0) return false;
  meta.quests.active.splice(i, 1);
  saveMeta();
  return true;
}

export function claimQuest(id) {
  const meta = getMeta();
  if (!meta.quests) return null;
  const i = meta.quests.active.findIndex(q => q.id === id);
  if (i < 0) return null;
  const q = meta.quests.active[i];
  const tpl = QUEST_TEMPLATES.find(t => t.id === id);
  if (!tpl) return null;
  if (q.progress < tpl.goal) return null;       // not complete
  meta.quests.active.splice(i, 1);
  meta.quests.completedCount = (meta.quests.completedCount || 0) + 1;
  meta.coins += tpl.coins;
  meta.embers = (meta.embers || 0) + tpl.embers;
  saveMeta();
  return { coins: tpl.coins, embers: tpl.embers, template: tpl };
}

/**
 * Progress-event hook. Called from gameplay code on relevant events.
 * Examples:
 *   questEvent('kill', { tier: 'wolf' });
 *   questEvent('miniBoss');
 *   questEvent('finalBoss');
 *   questEvent('survive', { seconds: state.time.game });
 *   questEvent('chestOpen');
 *   questEvent('coinsEarned', { amount: 50 });
 */
export function questEvent(kind, payload) {
  const meta = getMeta();
  // Iter 9 piggyback: bump lifetime chest counter on the existing chestOpen
  // signal so the chest_hoarder tier-2 achievement has progress without us
  // inventing a new call site. Runs even when no active quests need it.
  if (kind === 'chestOpen') {
    if (!meta.lifetime) meta.lifetime = { bugKills: 0, jackpots: 0, coinsEverEarned: 0, sigilsEarned: 0, chestsOpened: 0, fullSweepRuns: 0 };
    meta.lifetime.chestsOpened = (meta.lifetime.chestsOpened || 0) + 1;
    saveMeta();
  }
  if (!meta.quests || !meta.quests.active.length) return;
  let dirty = false;
  for (const q of meta.quests.active) {
    const tpl = QUEST_TEMPLATES.find(t => t.id === q.id);
    if (!tpl) continue;
    if (tpl.kind === 'hunt' && kind === 'kill' && payload && payload.tier === tpl.target) {
      q.progress = Math.min(tpl.goal, (q.progress || 0) + 1);
      dirty = true;
    } else if (tpl.kind === 'boss' && tpl.target === 'mini' && kind === 'miniBoss') {
      q.progress = Math.min(tpl.goal, (q.progress || 0) + 1);
      dirty = true;
    } else if (tpl.kind === 'boss' && tpl.target === 'final' && kind === 'finalBoss') {
      q.progress = Math.min(tpl.goal, (q.progress || 0) + 1);
      dirty = true;
    } else if (tpl.kind === 'survive' && kind === 'survive' && payload) {
      // Single-run survive uses max-reached, not additive.
      q.progress = Math.max(q.progress || 0, Math.min(tpl.goal, Math.floor(payload.seconds)));
      dirty = true;
    } else if (tpl.kind === 'collect' && tpl.target === 'chest' && kind === 'chestOpen') {
      q.progress = Math.min(tpl.goal, (q.progress || 0) + 1);
      dirty = true;
    } else if (tpl.kind === 'hoard' && tpl.target === 'coins' && kind === 'coinsEarned' && payload) {
      q.progress = Math.min(tpl.goal, (q.progress || 0) + (payload.amount || 0));
      dirty = true;
    }
  }
  if (dirty) saveMeta();
}

/** Grant N Embers and persist. Used by house minigames. */
export function grantEmbers(n) {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const meta = getMeta();
  meta.embers = (meta.embers || 0) + Math.floor(n);
  saveMeta();
  return Math.floor(n);
}

export function buyHouseUpgrade(id) {
  const meta = getMeta();
  const upg = HOUSE_UPGRADES.find(u => u.id === id);
  if (!upg) return false;
  const cur = houseLevel(id);
  if (cur >= upg.max) return false;
  const cost = houseCost(upg, cur);
  if ((meta.embers || 0) < cost) return false;
  meta.embers -= cost;
  if (!meta.house) meta.house = {};
  meta.house[id] = cur + 1;
  // Side effects for one-time capability upgrades
  if (id === 'lain') {
    if (!meta.quests) meta.quests = { active: [], completedCount: 0, lainTerminal: false };
    meta.quests.lainTerminal = true;
  }
  saveMeta();
  return true;
}

/**
 * Achievement DAG (iter 9). Each entry carries:
 *   - tier:     1 (current 8) | 2 (gated by tier-1 parent) | 3 (gated by tier-2)
 *   - requires: [parentId, ...] — must all be unlocked before this one lights up
 *   - progress: (meta) => 0..1  — fraction toward the goal (binary for "first X")
 *
 * Tier-1 entries keep their original IDs so existing unlock call sites work
 * unchanged. Tier-2/3 are layered on top by extending lifetime counters or
 * by reading achievement state directly — no new tracking required outside
 * of the chest_hoarder + fullSweepRuns piggybacks added above.
 */
export const ACHIEVEMENTS = [
  // ── Tier 1 (original 8) — root unlocks ────────────────────────────────────
  { id: 'first_kill',       name: 'First Blood',      desc: 'Defeat your first enemy',     icon: '⚔️', tier: 1, requires: [] },
  { id: 'first_elite',      name: 'Giant Slayer',     desc: 'Defeat an elite',             icon: '🛡️', tier: 1, requires: [] },
  { id: 'kills_100',        name: 'Centurion',        desc: '100 kills in one run',        icon: '💯', tier: 1, requires: [] },
  { id: 'first_chest',      name: 'Treasure Hunter',  desc: 'Open your first chest',       icon: '🎁', tier: 1, requires: [] },
  { id: 'first_jackpot',    name: 'Jackpot!',         desc: 'Hit a 7-7-7 jackpot',         icon: '🎰', tier: 1, requires: [] },
  { id: 'first_victory',    name: 'Champion',         desc: 'Defeat the final boss',       icon: '👑', tier: 1, requires: [] },
  { id: 'first_evolution',  name: 'Evolved',          desc: 'Unlock a weapon evolution',   icon: '🌟', tier: 1, requires: [] },
  { id: 'minibox_x3',       name: 'Triple Threat',    desc: 'Defeat all 3 mini-bosses',    icon: '🔥', tier: 1, requires: [] },
  // ── Tier 2 — compound mastery, gated by a single tier-1 parent ────────────
  {
    id: 'centurion_x10', name: 'Decimator',
    desc: '1,000 lifetime kills',
    icon: '🗡',
    tier: 2, requires: ['kills_100'],
    progress: (m) => Math.min(1, ((m && m.totalKills) || 0) / 1000),
  },
  {
    id: 'evolver', name: 'Triple Bloom',
    desc: '3 evolutions in a single run',
    icon: '🌸',
    tier: 2, requires: ['first_evolution'],
    // Run-scoped — binary. Caller (run-end commit) flips the achievement when
    // the count is met; we surface 0/1 here so the DAG renders correctly.
  },
  {
    id: 'champion_twilight', name: 'Hollow Champion',
    desc: 'Victory on Twilight Hollow',
    icon: '🌒',
    tier: 2, requires: ['first_victory'],
  },
  {
    id: 'chest_hoarder', name: 'Hoarder of Coffers',
    desc: '50 lifetime chests opened',
    icon: '📦',
    tier: 2, requires: ['first_chest'],
    progress: (m) => Math.min(1, ((m && m.lifetime && m.lifetime.chestsOpened) || 0) / 50),
  },
  {
    id: 'sigil_collector', name: 'Sigil Reaper',
    desc: '50 lifetime sigils earned',
    icon: '🔱',
    tier: 2, requires: ['first_kill'],
    progress: (m) => Math.min(1, ((m && m.lifetime && m.lifetime.sigilsEarned) || 0) / 50),
  },
  {
    id: 'triple_x3', name: 'Trial of Trials',
    desc: 'Sweep all 3 mini-bosses in 3 separate runs',
    icon: '⚜',
    tier: 2, requires: ['minibox_x3'],
    progress: (m) => Math.min(1, ((m && m.lifetime && m.lifetime.fullSweepRuns) || 0) / 3),
  },
  // ── Tier 3 — capstone, gated by a tier-2 parent ───────────────────────────
  {
    id: 'master_collector', name: 'Lorekeeper',
    desc: 'Discover every weapon evolution',
    icon: '📚',
    tier: 3, requires: ['evolver'],
    // Discoveries map count vs. known evolution count is hard to read from
    // here without coupling — codex (9c) renders binary completion based on
    // its own evolution count. We report 0 here so percentComplete stays
    // valid until the achievement itself unlocks.
  },
  {
    id: 'apex_predator', name: 'Apex Predator',
    desc: '5,000 lifetime kills',
    icon: '🦴',
    tier: 3, requires: ['centurion_x10'],
    progress: (m) => Math.min(1, ((m && m.totalKills) || 0) / 5000),
  },
  {
    id: 'void_walker', name: 'Void Walker',
    desc: 'Victory on the Void stage',
    icon: '🌀',
    tier: 3, requires: ['champion_twilight'],
    // Void stage is post-iter-9; entry placeholder so the DAG renders fully.
  },
];

// ── Sigils — prestige currency (iter 6 "Meta With Teeth") ────────────────────
// Earned from mini-bosses (1) / final bosses (5) / quest claims (2) / daily
// best-postings (3). Spent in the branching SHOP_TREE below. Sigils granted
// during a run are summed in _sigilsThisRun and surfaced via commitRunResults.
let _sigilsThisRun = 0;

/**
 * Grant N sigils from a tagged source. Returns the amount actually granted
 * (so callers can show "+N" toasts). Floors negatives + non-finite to 0.
 * Note: granting also flows into the per-run accumulator so commitRunResults
 * can report sigilsEarned without double-counting house/menu grants — anything
 * not from a 'miniBoss' or 'finalBoss' source still counts toward the run
 * total since the player saw the +N during that play session.
 */
export function grantSigils(n, source) {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const amt = Math.floor(n);
  const meta = getMeta();
  meta.sigils = (meta.sigils || 0) + amt;
  // Lifetime counter — drives 'sigils:N' character unlocks (e.g. Phoenix Vow
  // at 30). Stays monotonic even when meta.sigils is spent on SHOP_TREE.
  if (!meta.lifetime) meta.lifetime = { bugKills: 0, jackpots: 0, coinsEverEarned: 0, sigilsEarned: 0 };
  meta.lifetime.sigilsEarned = (meta.lifetime.sigilsEarned || 0) + amt;
  _sigilsThisRun += amt;
  saveMeta();
  return amt;
}

/** Current sigil balance. */
export function sigilCount() {
  const meta = getMeta();
  return meta.sigils || 0;
}

// ── Branching shop tree ─────────────────────────────────────────────────────
// 3 branches × 4 tiers = 12 nodes. Each tier requires its predecessor in the
// same branch. Costs: 4/7/12/18 per tier (≈41/branch, ≈123 for full clear).
// Each node's effect(runState) mutates state.run.passive_* scalars at run
// start; iter 7 plumbs the more complex flags (revives, frenzy, free chest).
export const SHOP_TREE = [
  // ── Survival ── durability + recovery
  {
    id: 'survival-1-iron-skin', branch: 'survival', tier: 1, requires: [], cost: 4,
    name: 'Iron Skin', desc: '+5% damage reduction', icon: '🛡️',
    effect: (runState) => {
      runState.passive_dmgReduction = (runState.passive_dmgReduction || 0) + 0.05;
    },
  },
  {
    id: 'survival-2-second-wind', branch: 'survival', tier: 2, requires: ['survival-1-iron-skin'], cost: 7,
    name: 'Second Wind', desc: 'Free revive at 25% HP, once per run', icon: '🪽',
    effect: (runState) => {
      runState.passive_revives = (runState.passive_revives || 0) + 1;
    },
  },
  {
    id: 'survival-3-regeneration', branch: 'survival', tier: 3, requires: ['survival-2-second-wind'], cost: 12,
    name: 'Regeneration', desc: '+0.5 HP/sec passive regen', icon: '🌿',
    effect: (runState) => {
      runState.passive_regen = (runState.passive_regen || 0) + 0.5;
    },
  },
  {
    id: 'survival-4-phoenix', branch: 'survival', tier: 4, requires: ['survival-3-regeneration'], cost: 18,
    name: 'Phoenix', desc: 'Revives x2 per run (caps at 6 with Vault)', icon: '🔥',
    // TODO(iter6-wire): respawn loop reads passive_revives; cap at 6 with house.vault stacks.
    effect: (runState) => {
      runState.passive_revives = (runState.passive_revives || 0) + 2;
    },
  },
  // ── Power ── offense + cooldown
  {
    id: 'power-1-sharpened-edge', branch: 'power', tier: 1, requires: [], cost: 4,
    name: 'Sharpened Edge', desc: '+8% damage', icon: '⚔️',
    effect: (runState) => {
      runState.passive_dmg = (runState.passive_dmg || 1) * 1.08;
    },
  },
  {
    id: 'power-2-quick-hands', branch: 'power', tier: 2, requires: ['power-1-sharpened-edge'], cost: 7,
    name: 'Quick Hands', desc: '−6% all weapon cooldown', icon: '⚡',
    effect: (runState) => {
      runState.passive_cooldown = (runState.passive_cooldown || 1) * 0.94;
    },
  },
  {
    id: 'power-3-critical-eye', branch: 'power', tier: 3, requires: ['power-2-quick-hands'], cost: 12,
    name: 'Critical Eye', desc: '+15% crit chance', icon: '🎯',
    effect: (runState) => {
      runState.passive_critChance = (runState.passive_critChance || 0) + 0.15;
    },
  },
  {
    id: 'power-4-overdrive', branch: 'power', tier: 4, requires: ['power-3-critical-eye'], cost: 18,
    name: 'Overdrive', desc: 'Every 60s: 5s frenzy (+50% atk speed, +25% dmg)', icon: '💥',
    // TODO(iter6-wire): main loop ticks an overdrive timer when passive_overdrive=true,
    // stacks transient multipliers onto cooldown + dmg statMul during the 5s window.
    effect: (runState) => {
      runState.passive_overdrive = true;
    },
  },
  // ── Greed ── economy + drops
  {
    id: 'greed-1-magpie', branch: 'greed', tier: 1, requires: [], cost: 4,
    name: 'Magpie', desc: '+20% coin from kills', icon: '🪙',
    effect: (runState) => {
      runState.passive_coinMul = (runState.passive_coinMul || 0) + 0.20;
    },
  },
  {
    id: 'greed-2-lucky-charm', branch: 'greed', tier: 2, requires: ['greed-1-magpie'], cost: 7,
    name: 'Lucky Charm', desc: '+5% chest spawn rate', icon: '🍀',
    effect: (runState) => {
      runState.passive_chestRate = (runState.passive_chestRate || 0) + 0.05;
    },
  },
  {
    id: 'greed-3-sigil-sense', branch: 'greed', tier: 3, requires: ['greed-2-lucky-charm'], cost: 12,
    name: 'Sigil Sense', desc: '+1 sigil per mini-boss', icon: '🔮',
    effect: (runState) => {
      runState.passive_miniBossSigilBonus = (runState.passive_miniBossSigilBonus || 0) + 1;
    },
  },
  {
    id: 'greed-4-treasure-map', branch: 'greed', tier: 4, requires: ['greed-3-sigil-sense'], cost: 18,
    name: 'Treasure Map', desc: 'Each run starts with a free chest near you', icon: '🗺',
    // TODO(iter6-wire): chest-spawner reads passive_treasureMap at run start,
    // drops one common chest within ~6u of the hero before enemies appear.
    effect: (runState) => {
      runState.passive_treasureMap = true;
    },
  },
];

/** True if every prerequisite for this node is owned. Tier-1 nodes always true. */
export function nodeUnlocked(id) {
  const meta = getMeta();
  if (!meta.shopTree) meta.shopTree = {};
  const node = SHOP_TREE.find(n => n.id === id);
  if (!node) return false;
  for (const req of node.requires) if (!meta.shopTree[req]) return false;
  return true;
}

/** True if the player owns this tree node. */
export function nodeOwned(id) {
  const meta = getMeta();
  return !!(meta.shopTree && meta.shopTree[id]);
}

/**
 * Buy a tree node. Returns { ok, reason? } so callers can show specific
 * error toasts. Cost is in sigils; node must be unlocked + not already owned.
 */
export function purchaseTreeNode(id) {
  const meta = getMeta();
  if (!meta.shopTree) meta.shopTree = {};
  const node = SHOP_TREE.find(n => n.id === id);
  if (!node) return { ok: false, reason: 'unknown' };
  if (meta.shopTree[id]) return { ok: false, reason: 'already_owned' };
  if (!nodeUnlocked(id)) return { ok: false, reason: 'locked' };
  if ((meta.sigils || 0) < node.cost) return { ok: false, reason: 'insufficient_sigils' };
  meta.sigils -= node.cost;
  meta.shopTree[id] = 1;
  saveMeta();
  return { ok: true };
}

// ── Presets — saved character+stage combos for fast re-launch ───────────────
function _presetId() {
  return 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
}

/**
 * Save a new preset. Empty/garbage names get a synthesized fallback so the
 * UI list never shows blanks. Returns the new preset id so the caller can
 * highlight it.
 */
export function addPreset({ name, character, stage } = {}) {
  const meta = getMeta();
  if (!meta.presets) meta.presets = [];
  const id = _presetId();
  const safeName = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 32) : `Preset ${meta.presets.length + 1}`;
  meta.presets.push({ id, name: safeName, character: character || 'kitty', stage: stage || 'forest' });
  saveMeta();
  return id;
}

export function removePreset(id) {
  const meta = getMeta();
  if (!meta.presets) return;
  const i = meta.presets.findIndex(p => p.id === id);
  if (i >= 0) {
    meta.presets.splice(i, 1);
    saveMeta();
  }
}

export function listPresets() {
  const meta = getMeta();
  if (!meta.presets) meta.presets = [];
  // Return a defensive shallow copy so callers can sort/filter without mutating save state.
  return meta.presets.map(p => ({ id: p.id, name: p.name, character: p.character, stage: p.stage }));
}

/** Apply a preset by id: sets selectedChar + selectedStage and saves. */
export function applyPreset(id) {
  const meta = getMeta();
  if (!meta.presets) return;
  const p = meta.presets.find(x => x.id === id);
  if (!p) return;
  meta.selectedChar = p.character;
  meta.selectedStage = p.stage;
  saveMeta();
}

let _data = null;

export function loadMeta() {
  if (_data) return _data;
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // ── Iter 10a migration ──
      // Detect legacy single-slider saves: optVolume present, new Master/
      // Music/SFX keys absent. Must inspect `parsed` BEFORE the spread —
      // otherwise DEFAULT seeds the new keys and we lose the signal.
      const hasLegacy = (parsed.optVolume !== undefined)
        && (parsed.optMasterVolume === undefined)
        && (parsed.optMusicVolume  === undefined)
        && (parsed.optSfxVolume    === undefined);
      _data = { ...DEFAULT, ...parsed };
      if (hasLegacy) {
        const v = Number(parsed.optVolume);
        if (Number.isFinite(v)) {
          _data.optMasterVolume = Math.max(0, Math.min(1, v));
          _data.optMusicVolume  = Math.max(0, Math.min(1, v * 0.6));
          _data.optSfxVolume    = Math.max(0, Math.min(1, v));
        }
      }
      return _data;
    }
  } catch (e) {
    console.warn('[meta] load failed, using defaults', e);
  }
  _data = { ...DEFAULT };
  return _data;
}

export function saveMeta() {
  if (!_data) return;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(_data));
  } catch (e) {
    console.warn('[meta] save failed', e);
  }
}

export function getMeta() {
  return _data || loadMeta();
}

/**
 * Commit a finished run's results. Returns { coinsEarned, isBestTime, isBestKills }
 * so the death screen can highlight wins.
 */
export function commitRunResults({ timeSurvived, kills, dmgDealt, level, victory, stageId, bossRush, weekly, character, fullSweep }) {
  const meta = getMeta();
  // 1 coin per kill, +5 per minute survived. Hyper boosts coin gain.
  // Vault stacks on top of Hyper coin bonus.
  const vaultLv = (meta.house && meta.house.vault) || 0;
  // Greed passive multiplier passed by caller (showDeathScreen) — defaults to 0.
  const greedMul = (typeof arguments[0] !== 'undefined' && typeof arguments[0].greedMul === 'number') ? arguments[0].greedMul : 0;
  // Iter 11c — SHOP_TREE Greed tier-1 "Magpie" passive (+0.20 per owned level).
  // applyMetaUpgrades bakes node effects into state.run.passive_coinMul; we
  // compose additively with the in-run greedMul weapon-passive so both
  // "coin gain bonus" sources stack linearly on top of the (Hyper × Vault)
  // multiplicative chassis.
  const passiveCoinMul = (state && state.run && state.run.passive_coinMul) || 0;
  const coinMul = (meta.optHyper ? 1.5 : 1) * (1 + 0.25 * vaultLv) * (1 + greedMul + passiveCoinMul);
  const coinsEarned = Math.floor((kills + Math.floor(timeSurvived / 12)) * coinMul);
  // Sigils accumulated this run (via grantSigils since last commit) flush into the return.
  const sigilsEarned = _sigilsThisRun;
  _sigilsThisRun = 0;
  // Embers — scarce hub currency. ~5 per 5-min run; +1 per 50 kills.
  const embersEarned = Math.max(0, Math.floor(timeSurvived / 60) + Math.floor(kills / 50) + (victory ? 2 : 0));
  meta.embers = (meta.embers || 0) + embersEarned;
  // Quest hooks at run end (survive seconds + coins earned this run).
  try { questEvent('survive', { seconds: timeSurvived }); } catch (_) {}
  try { questEvent('coinsEarned', { amount: coinsEarned }); } catch (_) {}
  const isBestTime = timeSurvived > meta.bestTime;
  const isBestKills = kills > meta.bestKills;
  meta.coins += coinsEarned;
  if (!meta.lifetime) meta.lifetime = { bugKills: 0, jackpots: 0, coinsEverEarned: 0 };
  meta.lifetime.coinsEverEarned = (meta.lifetime.coinsEverEarned || 0) + coinsEarned;
  meta.runs += 1;
  meta.totalKills += kills;
  if (isBestTime) meta.bestTime = timeSurvived;
  if (isBestKills) meta.bestKills = kills;
  // Mode unlocks on first victory
  let unlockedHyper = false, unlockedEndless = false, unlockedCinder = false, unlockedClockwork = false, unlockedVoid = false;
  if (victory && !meta.unlockedHyper) { meta.unlockedHyper = true; unlockedHyper = true; }
  if (victory && !meta.unlockedEndless) { meta.unlockedEndless = true; unlockedEndless = true; }
  if (victory && stageId === 'twilight' && !meta.unlockedCinder) {
    meta.unlockedCinder = true; unlockedCinder = true;
  }
  // Iter 22B — Catacomb Void clear unlocks the Seedy Tent casino. Once set,
  // tickTown repaints the interactable label on its next pass.
  if (victory && stageId === 'void' && !meta.unlockedVoid) {
    meta.unlockedVoid = true; unlockedVoid = true;
  }
  // Clockwork character unlock — Boss Rush victory on Twilight Hollow.
  // Hardest currently-shippable combo (compressed timer + 1.30× HP). Caller
  // may pass `bossRush` explicitly; fall back to meta.optBossRush (same
  // source-of-truth the run was started with) so we work even if the call
  // site hasn't been updated yet.
  const inBossRush = (typeof bossRush === 'boolean') ? bossRush : !!meta.optBossRush;
  if (victory && inBossRush && stageId === 'twilight' && !meta.unlockedClockwork) {
    meta.unlockedClockwork = true; unlockedClockwork = true;
  }
  // Iter 22B — every Boss Rush victory bumps the casino's settlement counter.
  // The casino wager record stashes a snapshot of this value at wager start;
  // on town entry, settlePendingWager() compares the current value to decide
  // payout vs forfeit. Bumps regardless of stage so a Cinder/Void Boss Rush
  // also settles a wager.
  if (victory && inBossRush) {
    meta.casinoBossRushClears = (meta.casinoBossRushClears || 0) + 1;
  }
  // Iter 9: full-mini-boss-sweep tally. Caller passes `fullSweep: true` when
  // all 3 mini-bosses fell in this run. Drives the triple_x3 tier-2 chain.
  if (fullSweep) {
    if (!meta.lifetime) meta.lifetime = { bugKills: 0, jackpots: 0, coinsEverEarned: 0, sigilsEarned: 0, chestsOpened: 0, fullSweepRuns: 0 };
    meta.lifetime.fullSweepRuns = (meta.lifetime.fullSweepRuns || 0) + 1;
  }
  // Iter 9: weekly mutator commit. Mirrors the daily contract — caller sets
  // `weekly: true` when state.modes.weekly was active. We piggyback here
  // instead of forcing 9b's death-screen path to know about isoWeekKey().
  let weeklyResult = null;
  if (weekly) {
    weeklyResult = commitWeeklyRun({
      kills,
      time: timeSurvived,
      character: character || meta.selectedChar,
      stage: stageId || meta.selectedStage,
    });
  }
  saveMeta();
  return {
    coinsEarned, embersEarned, sigilsEarned, isBestTime, isBestKills,
    unlockedHyper, unlockedEndless, unlockedCinder, unlockedClockwork,
    unlockedVoid,
    weeklyResult,
  };
}

export function resetMeta() {
  _data = { ...DEFAULT };
  saveMeta();
}

export function setOption(key, val) {
  const meta = getMeta();
  meta[key] = val;
  saveMeta();
}

/**
 * Iter 10a — Save Export. Returns the meta blob as a formatted JSON string.
 * Used by the Options ▸ Data ▸ Export workflow (copy-to-clipboard + file
 * download). Safe to inspect by users; no secrets.
 */
export function exportMeta() {
  const meta = getMeta();
  try {
    return JSON.stringify(meta, null, 2);
  } catch (e) {
    console.warn('[meta] exportMeta failed', e);
    return JSON.stringify(DEFAULT, null, 2);
  }
}

/**
 * Iter 10a — Save Import. Parse a previously-exported JSON blob, validate it
 * has a `version` field, merge over DEFAULT (so unknown keys are tolerated
 * and missing keys get defaults), persist, and reset cached _data so callers
 * see the imported value via getMeta().
 *
 * Returns `{ ok: true }` on success or `{ ok: false, reason }` on failure.
 * Reasons: `'empty'`, `'parse'`, `'shape'`, `'no_version'`.
 */
export function importMeta(str) {
  if (typeof str !== 'string' || !str.trim()) return { ok: false, reason: 'empty' };
  let parsed;
  try {
    parsed = JSON.parse(str);
  } catch (e) {
    return { ok: false, reason: 'parse' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'shape' };
  }
  if (typeof parsed.version === 'undefined') {
    return { ok: false, reason: 'no_version' };
  }
  // Merge over DEFAULT so a partial save still produces a usable state.
  _data = { ...DEFAULT, ...parsed };
  saveMeta();
  return { ok: true };
}

/**
 * Unlock an achievement by id. Returns the achievement def if newly unlocked
 * (so the caller can toast it), or null if already unlocked / unknown id.
 */
export function unlockAchievement(id) {
  const meta = getMeta();
  if (!meta.achievements) meta.achievements = {};
  if (meta.achievements[id]) return null;
  const def = ACHIEVEMENTS.find(a => a.id === id);
  if (!def) return null;
  meta.achievements[id] = Date.now();
  saveMeta();
  return def;
}

export function achievementCount() {
  const meta = getMeta();
  return Object.keys(meta.achievements || {}).length;
}

/**
 * Attempt to buy one level of a shop upgrade. Returns true on success, false if
 * maxed or not enough coins.
 */
export function buyUpgrade(id) {
  const meta = getMeta();
  if (!meta.shop) meta.shop = {};
  const upg = SHOP_UPGRADES.find(u => u.id === id);
  if (!upg) return false;
  const cur = meta.shop[id] || 0;
  if (cur >= upg.max) return false;
  const cost = upgradeCost(upg, cur);
  if (meta.coins < cost) return false;
  meta.coins -= cost;
  meta.shop[id] = cur + 1;
  saveMeta();
  return true;
}

/** Get the level (0..max) the player owns for this upgrade. */
export function shopLevel(id) {
  const meta = getMeta();
  return (meta.shop && meta.shop[id]) || 0;
}

/** Mark an evolution recipe as discovered. Returns true if newly discovered. */
export function discoverEvolution(id) {
  const meta = getMeta();
  if (!meta.discoveries) meta.discoveries = {};
  if (meta.discoveries[id]) return false;
  meta.discoveries[id] = Date.now();
  saveMeta();
  return true;
}

export function isDiscovered(id) {
  const meta = getMeta();
  return !!(meta.discoveries && meta.discoveries[id]);
}

/**
 * Unlock a secret by id. Returns the secret def if newly unlocked (so the
 * caller can toast it), or null if already unlocked / unknown id.
 */
export function unlockSecret(id) {
  const meta = getMeta();
  if (!meta.secrets) meta.secrets = {};
  if (meta.secrets[id]) return null;
  const def = SECRETS.find(s => s.id === id);
  if (!def) return null;
  meta.secrets[id] = Date.now();
  saveMeta();
  // Mirror into the codex so the Secrets tab lights up immediately.
  try { import('./codex.js').then(({ notifySecretFound }) => notifySecretFound(id)); } catch (_) {}
  return def;
}

/** True if a secret with this id has been unlocked. */
export function isSecretUnlocked(id) {
  const meta = getMeta();
  return !!(meta.secrets && meta.secrets[id]);
}

/** Bump a lifetime counter and persist. Returns the new value. */
export function bumpLifetime(key, n = 1) {
  const meta = getMeta();
  if (!meta.lifetime) meta.lifetime = { bugKills: 0, jackpots: 0, coinsEverEarned: 0 };
  meta.lifetime[key] = (meta.lifetime[key] || 0) + n;
  saveMeta();
  return meta.lifetime[key];
}

/** Resolve the currently-selected stage def. Falls back to the first entry. */
export function selectedStage(STAGES) {
  const meta = getMeta();
  return STAGES.find(s => s.id === meta.selectedStage) || STAGES[0];
}

/** Resolve the currently-selected character def. Falls back to kitty. */
export function selectedCharacter(CHARACTERS) {
  const meta = getMeta();
  return CHARACTERS.find(c => c.id === meta.selectedChar) || CHARACTERS[0];
}

/**
 * Returns true if the given character def is unlocked for the given meta.
 *
 * Supported unlock-string forms (parsed in this order):
 *   - null/undefined            → always unlocked (default character)
 *   - 'sigils:N'                → meta.lifetime.sigilsEarned >= N
 *   - 'flag:fieldName'          → !!meta[fieldName] (e.g. unlockedClockwork)
 *   - <achievement-id>          → !!meta.achievements[id]
 *
 * Prefix forms must be checked BEFORE the achievement-map fallback —
 * otherwise 'sigils:30' would silently look up meta.achievements['sigils:30']
 * and never return true. Existing inline check in ui.js (~line 1146) should
 * route through this helper so new unlock kinds plug in cleanly.
 */
export function isCharacterUnlocked(char, meta) {
  if (!char) return false;
  const u = char.unlock;
  if (u === null || u === undefined) return true;
  if (typeof u !== 'string') return false;
  const m = meta || getMeta();
  if (u.startsWith('sigils:')) {
    const n = parseInt(u.slice(7), 10);
    if (!Number.isFinite(n)) return false;
    const have = (m.lifetime && m.lifetime.sigilsEarned) || 0;
    return have >= n;
  }
  if (u.startsWith('flag:')) {
    const key = u.slice(5);
    return !!m[key];
  }
  return !!(m.achievements && m.achievements[u]);
}
