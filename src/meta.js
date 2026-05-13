/**
 * Persistent meta-progression: coins, run history, unlocks.
 * Stored in localStorage under a single namespaced key. Versioned so we can
 * migrate without nuking saves later.
 */

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
  optVolume: 0.7,
  optShake: 1.0,
  optMusic: false,    // user prefers silence by default; opt-in via options menu
  // First-run tutorial seen flag
  seenTutorial: false,
  // Achievement unlock map: { id: timestamp }
  achievements: {},
  // Shop purchased levels: { hp: 2, magnet: 1, ... }
  shop: {},
  // Mode unlocks (true after first victory)
  unlockedHyper: false,
  unlockedEndless: false,
  unlockedCinder: false,    // unlocked by victory on Twilight Hollow
  // Mode toggles for the next run
  optHyper: false,
  optEndless: false,
  // VFX intensity (0.0..1.0)
  optVfx: 1.0,
  // Mouse-aim mode (overrides nearest-enemy targeting for autoaim/volley)
  optManualAim: false,
  // Boss Rush mode — compressed boss-only run. Unlocks alongside Hyper/Endless.
  optBossRush: false,
  // Discovered evolutions: { evolutionId: timestamp }
  discoveries: {},
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
  },
  // Daily challenge: persistent best per-day; rolls over at local midnight
  dailyRun: {
    date: '',         // 'YYYY-MM-DD' of the recorded best
    attempts: 0,
    bestKills: 0,
    bestTime: 0,
  },
  // Affix relics dropped by the final boss. Each = { id, name, tier, affixes }.
  // Most recent is auto-equipped on run start.
  relics: [],
  equippedRelic: null,    // id of the currently-equipped relic (or null)
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
  saveMeta();
  return true;
}

export const ACHIEVEMENTS = [
  { id: 'first_kill',       name: 'First Blood',      desc: 'Defeat your first enemy', icon: '⚔️' },
  { id: 'first_elite',      name: 'Giant Slayer',     desc: 'Defeat an elite',        icon: '🛡️' },
  { id: 'kills_100',        name: 'Centurion',        desc: '100 kills in one run',   icon: '💯' },
  { id: 'first_chest',      name: 'Treasure Hunter',  desc: 'Open your first chest',  icon: '🎁' },
  { id: 'first_jackpot',    name: 'Jackpot!',         desc: 'Hit a 7-7-7 jackpot',    icon: '🎰' },
  { id: 'first_victory',    name: 'Champion',         desc: 'Defeat the final boss',  icon: '👑' },
  { id: 'first_evolution',  name: 'Evolved',          desc: 'Unlock a weapon evolution', icon: '🌟' },
  { id: 'minibox_x3',       name: 'Triple Threat',    desc: 'Defeat all 3 mini-bosses', icon: '🔥' },
];

let _data = null;

export function loadMeta() {
  if (_data) return _data;
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      _data = { ...DEFAULT, ...parsed };
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
export function commitRunResults({ timeSurvived, kills, dmgDealt, level, victory, stageId }) {
  const meta = getMeta();
  // 1 coin per kill, +5 per minute survived. Hyper boosts coin gain.
  // Vault stacks on top of Hyper coin bonus.
  const vaultLv = (meta.house && meta.house.vault) || 0;
  const coinMul = (meta.optHyper ? 1.5 : 1) * (1 + 0.25 * vaultLv);
  const coinsEarned = Math.floor((kills + Math.floor(timeSurvived / 12)) * coinMul);
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
  let unlockedHyper = false, unlockedEndless = false, unlockedCinder = false;
  if (victory && !meta.unlockedHyper) { meta.unlockedHyper = true; unlockedHyper = true; }
  if (victory && !meta.unlockedEndless) { meta.unlockedEndless = true; unlockedEndless = true; }
  if (victory && stageId === 'twilight' && !meta.unlockedCinder) {
    meta.unlockedCinder = true; unlockedCinder = true;
  }
  saveMeta();
  return { coinsEarned, embersEarned, isBestTime, isBestKills, unlockedHyper, unlockedEndless, unlockedCinder };
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
