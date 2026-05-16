/**
 * All gameplay tunables. Modules import from here — no magic numbers in code.
 */

export const WORLD = {
  cameraDistance: 28,       // ortho frustum half-height baseline
  cameraLerp: 0.10,         // 0..1, higher = snappier follow
  groundSize: 2400,         // forest plane edge length
  fogNear: 90,
  fogFar: 320,
  bgColor: 0x061008,
};

export const HERO = {
  glb: 'tower-castle-plain.glb',  // donor model from original game (uncompressed copy)
  targetHeight: 3.6,        // auto-fit: scale = targetHeight / bbox.y. Re-exports w/ different units survive.
  scale: 1.0,               // optional multiplier on top of auto-fit, for art tuning
  speed: 8.0,               // units/sec
  hpMax: 100,
  iFramesSec: 0.6,
  pickupRadius: 1.6,        // gem magnet base radius — walk-onto-it close range, magnet powerups scale it (iter 33c)
  contactPushback: 0.5,     // hero gets nudged on enemy contact
  yOffset: 0,
};

export const DAMAGE = {
  variance: 0.20,           // ±20% roll on every hit
  critChance: 0.08,         // 8% chance to crit
  critMul: 2.0,             // crit × 2 damage
};

export const JUMP = {
  velocity: 9.0,          // initial upward velocity (units/sec)
  gravity: -28.0,         // applied while airborne
  groundY: 0,
  coyoteTimeSec: 0.08,    // small grace window after leaving ground
};

export const DASH = {
  // Levels stack: each pick of the 'dash' filler increments dashLevel.
  // Level 0 = locked; level 1 = unlocked; higher = better stats.
  levels: [
    null,
    { duration: 0.22, speedMul: 5.5, cooldown: 7.0, knockback: 12, radius: 3.0, dmg: 18, iFrames: 0.30 },
    { duration: 0.24, speedMul: 6.0, cooldown: 6.0, knockback: 14, radius: 3.4, dmg: 28, iFrames: 0.35 },
    { duration: 0.26, speedMul: 6.5, cooldown: 5.0, knockback: 16, radius: 3.8, dmg: 42, iFrames: 0.40 },
    { duration: 0.28, speedMul: 7.0, cooldown: 4.0, knockback: 18, radius: 4.2, dmg: 60, iFrames: 0.45 },
    { duration: 0.30, speedMul: 7.5, cooldown: 3.0, knockback: 22, radius: 4.6, dmg: 85, iFrames: 0.50 },
  ],
};

export const XP = {
  // Iter 33j — 33d's curve was still a clickfest: 8 levels in ~60s. Steeper
  // base + growth pushes the L1→L8 total from 125 XP up to ~238 XP, which
  // at the early spawn rate (~2 kills/sec) lands L8 around the 2:00 mark
  // instead of 1:00. Curve table (xpNext per level):
  //   L1→L2: 10   L2→L3: 14   L3→L4: 20   L4→L5: 27   L5→L6: 38
  //   L6→L7: 54   L7→L8: 75   L8→L9:105  L9→L10:148  L10→L11:206
  base: 10,
  growth: 1.40,
  gemValue: 1,              // default
  gemSize: 0.35,
  gemMagnetMaxSpeed: 42,
  gemMagnetAccel: 60,         // unused after iter 33a (direct-seek magnet)
};

export const SPAWN = {
  // iter 33t — bumped further; user saw 16 alive at run start because hero
  // kill-rate outpaced 64/sec topup. Now 213/sec topup (32 per 0.15s tick)
  // closes the deficit before XP-rich tiers thin out.
  // iter 33z — alive cap trimmed 600 → 350. User report: 219 enemies →
  // 2.3M tris / frame / 41 FPS on a mid laptop GPU. The cap was sized for
  // a beefier machine; 350 keeps the swarm-survivor feel at <1.5M tris.
  targetAliveBase: 100,
  targetAlivePerD: 28,      // alive = base + D * perD  (was 40)
  targetAliveCap: 350,
  difficultyRampSec: 60,    // D goes 0→1 over first 60s
  // Cap D at 1200s = 20:00. Normal runs end at 15:00 (final boss), so this
  // puts dragon-tier (minD 7) into play during the last 3 minutes pre-boss
  // rather than only in Endless mode. Tested against tier minD ladder: at
  // t=15:00 → D = 1 + (900-60)/1140 * 9 ≈ 7.6 (just enables dragon).
  difficultyMaxSec: 1200,
  difficultyMax: 10,
  ringRadius: 22,           // spawn distance from hero (visible edge)
  ringJitter: 5,
  hordeIntervalSec: 45,
  hordeCount: 70,
  bossIntervalSec: 300,
  spawnBatchPerTick: 32,    // how many enemies can spawn in one director tick
  tickIntervalSec: 0.15,
  // iter 33r — chest density was 10× too high after iter 33q spawn bump.
  // Periodic 75s + 30% elite drop dumped ~6-8 chests/min with the new alive
  // counts. 240s + 3% elite → ~1 chest/min (mini-boss + final boss still drop).
  chestIntervalSec: 240,    // periodic chest spawn near hero
  chestEliteDropChance: 0.03, // probability an elite drop also spawns a chest
  // Iter 33l — time-based HP/dmg ramp coefficients (iter 33d originally inlined).
  // Both ride _computeDifficulty(t) [0..10]. HP scales harder than dmg so the
  // hero doesn't get clapped by attrition while late mobs still feel tanky.
  rampHpPerD: 0.6,
  rampDmgPerD: 0.3,
};

/**
 * Enemy tier table. glb keys must match preload list in assets.js.
 * spd = units/sec, dmg = per-contact damage, hp = base HP, weight = roll weight,
 * minD = minimum difficulty before this tier can appear.
 */
export const ENEMY_TIERS = [
  { glb: 'zombie',    hp: 6,   spd: 2.2, dmg: 4,  minD: 0.0, weight: 10, scale: 0.9 },
  { glb: 'goblin',    hp: 9,   spd: 2.9, dmg: 5,  minD: 0.4, weight: 8,  scale: 0.8 },
  { glb: 'skeleton',  hp: 14,  spd: 2.4, dmg: 6,  minD: 0.9, weight: 7,  scale: 0.9 },
  { glb: 'orc',       hp: 28,  spd: 1.9, dmg: 10, minD: 1.8, weight: 5,  scale: 1.1 },
  { glb: 'demon',     hp: 22,  spd: 2.6, dmg: 9,  minD: 2.2, weight: 5,  scale: 0.95 },
  { glb: 'robot',     hp: 50,  spd: 1.7, dmg: 14, minD: 3.5, weight: 3,  scale: 1.0 },
  { glb: 'mech',      hp: 90,  spd: 1.4, dmg: 18, minD: 4.5, weight: 2,  scale: 1.1 },
  { glb: 'xeno',      hp: 65,  spd: 3.0, dmg: 12, minD: 5.0, weight: 3,  scale: 1.0 },
  { glb: 'slime',     hp: 35,  spd: 2.0, dmg: 8,  minD: 1.5, weight: 4,  scale: 1.0 },
  { glb: 'giant',     hp: 200, spd: 1.2, dmg: 25, minD: 6.0, weight: 1,  scale: 1.3, elite: true },
  { glb: 'dragon',    hp: 400, spd: 1.2, dmg: 30, minD: 7.0, weight: 1,  scale: 1.4, elite: true },
  // New animated Quaternius tiers
  { glb: 'spider',    hp: 8,   spd: 3.2, dmg: 5,  minD: 1.2, weight: 6,  scale: 0.85 },
  { glb: 'wolf',      hp: 18,  spd: 3.0, dmg: 7,  minD: 2.0, weight: 5,  scale: 1.0, faceYaw: Math.PI / 2, procAnim: 'pad' },
  { glb: 'wizard',    hp: 25,  spd: 1.6, dmg: 8,  minD: 3.0, weight: 4,  scale: 0.95,
    ranged: { range: 14, stopAt: 10, cooldown: 2.4, projSpeed: 9, projDmg: 9, projTtl: 2.4 } },
  { glb: 'ghost',     hp: 35,  spd: 2.4, dmg: 11, minD: 4.0, weight: 4,  scale: 1.0, ghostly: true },
  // ── Forest bugs (CC-BY Poly by Google + CC0 Quaternius) ──
  // procAnim drives a procedural body anim if the GLB has no clip:
  //   'crawl' = side-to-side body wiggle (legs implied)
  //   'flap'  = wing-like Z rotation + bob (butterfly)
  //   'hover' = small bob + rapid jitter (bee/wasp)
  //   'hop'   = vertical bounce (grasshopper)
  //   'inch'  = slow accordion squash (caterpillar)
  //   'pad'   = quadruped padding gait (wolf/dog): vertical bob + shoulder roll
  { glb: 'ant',         hp: 5,   spd: 3.0, dmg: 4,  minD: 0.0, weight: 14, scale: 0.55, procAnim: 'crawl' },
  { glb: 'beetle',      hp: 14,  spd: 1.9, dmg: 5,  minD: 0.3, weight: 10, scale: 0.75, procAnim: 'crawl' },
  { glb: 'ladybug',     hp: 10,  spd: 2.4, dmg: 5,  minD: 0.5, weight: 8,  scale: 0.65, procAnim: 'crawl' },
  { glb: 'grasshopper', hp: 12,  spd: 3.4, dmg: 6,  minD: 1.0, weight: 7,  scale: 0.70, procAnim: 'hop', faceYaw: -Math.PI / 2 },
  { glb: 'butterfly',   hp: 8,   spd: 2.6, dmg: 4,  minD: 0.8, weight: 6,  scale: 0.75, procAnim: 'flap' },
  { glb: 'bee',         hp: 14,  spd: 2.8, dmg: 7,  minD: 1.5, weight: 6,  scale: 0.60, procAnim: 'hover', faceYaw: -Math.PI / 2 },
  { glb: 'cockroach',   hp: 8,   spd: 3.6, dmg: 5,  minD: 1.3, weight: 7,  scale: 0.55, procAnim: 'crawl' },
  { glb: 'wasp',        hp: 18,  spd: 2.8, dmg: 9,  minD: 2.0, weight: 5,  scale: 0.70, procAnim: 'hover', faceYaw: -Math.PI / 2 },
  { glb: 'caterpillar', hp: 60,  spd: 1.0, dmg: 10, minD: 2.5, weight: 3,  scale: 0.90, procAnim: 'inch' },
  { glb: 'mantis',      hp: 45,  spd: 2.0, dmg: 12, minD: 3.0, weight: 4,  scale: 1.00, procAnim: 'crawl' },
];

/**
 * Nemesis Elite (C3) — Butcher-style hunter that spawns OUTSIDE the standard
 * wave system. Intentionally exported as a sibling constant, NOT added to
 * ENEMY_TIERS — the spawnDirector tier filters (allowedTiers / elite pool /
 * final-boss reduce) would otherwise eat this row and break the contract
 * ("ignores standard wave-spawning logic"). Only spawnDirector.spawnNemesis
 * and enemies.killEnemy (via isNemesis branch) ever reference it.
 *
 * `spd` is absolute units/sec like every ENEMY_TIERS row. ~1.5× a baseline
 * mob (zombie 2.2, skeleton 2.4, mid pack ~2.6) → 4.0 reads as "faster than
 * anything else in the swarm but still dodgeable by a clean dash".
 *
 * `hp` here is the BASELINE — spawnDirector multiplies by the current
 * difficulty ramp + stage HP mul at spawn time so late-game nemesis HP scales
 * with the rest of the swarm. ~8-10× a robust mid-tier (orc 28, robot 50,
 * mech 90) → 800 baseline. At t=15:00 D≈7.6, that's 800×(1+0.6·7.6) ≈ 4448
 * raw HP (Cinder 1.6× → ~7100), enough that the player has to commit a
 * volley but not so much that a focused signature run can't burst it.
 *
 * `glowColor` is the bloom-tagged red core inset in the obsidian body. Mesh
 * builder lives in enemies.js (spawnNemesisMesh) so flash mats + procedural
 * geometry stay co-located with the other procedural enemy meshes.
 */
export const NEMESIS_TIER = {
  glb: '__nemesis__',         // sentinel; mesh is procedural, never loaded
  hp: 800,                    // baseline; difficulty + stage mults applied at spawn
  spd: 4.0,                   // absolute units/sec. 1.5× a baseline mob.
  dmg: 22,                    // 1.5× a robust mid-tier contact dmg
  scale: 1.4,                 // 1.4× visual silhouette (taller, broader)
  radius: 0.7,                // contact radius hint (current contact pipeline is flat)
  color: 0x222226,            // obsidian body
  glowColor: 0xff2020,        // red eye/core (bloom-layer tagged)
  xp: 50,                     // chunky gem on kill
  isElite: true,              // metadata; spawn director keys off isNemesis flag, not this
};

/**
 * Spawn cadence (sec) for the Nemesis Elite.
 *
 * Punch List #2 (2026-05-16) — Nemesis Tease + meta-gate:
 *   - Game has no explicit "wave N" clock; we synthesise one as
 *     wave * waveSec seconds of game time (60s/wave, standard
 *     survivors-style convention). Wave 8 = 480s, which lines up with
 *     STAGE.miniBossSchedule[1] = 480 — the second mini-boss beat.
 *   - At telegraphWave (wave 7 = 420s) the director fires an arrow + banner
 *     telegraph for ALL players (newbies AND vets) so the mechanic is
 *     taught even when no spawn follows.
 *   - At wave (wave 8 = 480s) the actual Nemesis spawns ONLY if
 *     meta.unlockFlags.finalBossWin === true (first-victory meta gate).
 *     New players see tension build for free; veterans get the hunter.
 *   - respawn cadence ([respawn.min, respawn.max] measured from kill time)
 *     is unchanged.
 *   - Single-active rule preserved: if a nemesis is still alive when the
 *     timer fires, the tick is skipped (no doubling up).
 */
export const NEMESIS_SPAWN = {
  // Wave-based first spawn (Punch List #2). wave * waveSec → seconds.
  wave: 8,                    // first spawn fires at game-time wave * waveSec
  telegraphWave: 7,           // arrow + banner fires one wave earlier
  waveSec: 60,                // seconds per synthetic "wave"
  arrowLifetimeSec: 60,       // directional arrow visible 60s or until spawn
  // Post-kill respawn cadence (unchanged from C3).
  respawnMinSec: 120,
  respawnJitterSec: 60,       // post-kill ∈ [120, 180]
  spawnRadius: 50,            // distance from hero (well off-screen)
};

/** Initial roster size pre-warmed per pool to hide first-horde stall. */
export const POOL_PREWARM = {
  // iter 33y — trimmed ~40% from iter 33t. Pools auto-grow on miss (one-shot
  // clone stall) so prewarm only needs to cover the first ~30 seconds of
  // spawns, not the whole run cap. The old prewarm carried ~870 cloned
  // meshes — a big chunk of resident JS + GPU memory even before play.
  zombie: 40, goblin: 40, skeleton: 30, orc: 20, demon: 20,
  robot: 14, mech: 8,  xeno: 14, slime: 18, giant: 3, dragon: 2,
  spider: 28, wolf: 22, wizard: 14, ghost: 14,
  // Forest bugs — primary forest tier, still highest counts but trimmed.
  ant: 60, beetle: 36, ladybug: 30, grasshopper: 24, butterfly: 18,
  bee: 18, cockroach: 24, wasp: 14, caterpillar: 8, mantis: 8,
};

export const SPATIAL = {
  cellSize: 6,              // SpatialHash cell edge
};

export const WEAPONS = {
  startingWeapon: 'orbitals',
  maxSlots: 6,
  maxPassives: 6,
};

// ── Daily Challenge rewards (Punch List #6, 2026-05-16) ────────────────────
// Daily wins pay a flat 2.5× coin multiplier on top of the existing
// (Hyper × Vault × greed) chain — applied multiplicatively in
// meta.commitRunResults() so the daily-only branch composes cleanly without
// touching the additive greedMul stack. Loss/abandon runs get NO multiplier.
// The cosmetic "Daily Survivor" badge unlocks on the first daily win and
// persists in meta.badges; it has no mechanical effect anywhere in the game
// (purely a start-screen pip + death-screen banner).
export const DAILY_REWARD_MULT = 2.5;
export const DAILY_SURVIVOR_BADGE_ID = 'daily_survivor';

// Playable characters — each overrides starting weapon + a few base stats.
// `id` is the persistent identifier; `unlock` is null for default or an
// achievement id / 'sigils:N' / 'flag:fieldName' for gated characters.
//
// Each character also defines a `signature(runState)` function that stamps
// a `runState.signature_*` flag (or sets `passive_*` for the iter-6 SHOP_TREE
// interop). Readers live in hero.js / enemies.js / weapons/*.js (iter 7b).
// Tuning constants are locked in ITER_789_BRIEFS.md (iter 7 — Tuning targets).
export const CHARACTERS = [
  {
    // Iter 32: archetype id kept as 'kitty' for save-compat, but display
    // name is "Balanced" — the avatar named "Kitty Kaki" is a separate concept.
    id: 'kitty',  name: 'Balanced',   icon: '🍔',
    desc: 'Default kit. Starts with Cheesy Burgers.',
    starter: 'orbitals',
    statMul: { dmg: 1.0, moveSpeed: 1.0, magnet: 1.0 },
    hpMax: 100,
    unlock: null,
    tint: 0xffffff, scaleMul: 1.00,
    signatureName: 'Nine Lives',
    signatureDesc: 'First lethal hit per run becomes 1 HP + 1.5s i-frame.',
    // Use `if (!passive_revives)` (NOT +=) so we don't stack with SHOP_TREE
    // Second Wind / Phoenix. Risk flag called out in iter-7 brief. The
    // signature_* flag is the dedicated reader path (hero.js) and is
    // idempotent regardless of SHOP_TREE ownership.
    signature: (runState) => {
      if (!runState.passive_revives) runState.passive_revives = 1;
      runState.signature_nineLives = true;
    },
  },
  {
    id: 'boom',   name: 'Boom',       icon: '⚡',
    desc: 'Glass cannon. Starts with Chain Lightning. +20% damage, -25% HP.',
    starter: 'chain',
    statMul: { dmg: 1.20, moveSpeed: 1.0, magnet: 1.0 },
    hpMax: 75,
    unlock: 'first_jackpot',
    tint: 0xff7a3a, scaleMul: 0.92,    // placeholder: orange-red, smaller silhouette
    signatureName: 'Charged Coil',
    signatureDesc: 'Every 5th Chain Lightning arc triggers a free re-cast.',
    signature: (runState) => {
      runState.signature_chainEcho = true;
      runState.signature_chainEchoCounter = 0;
    },
  },
  {
    id: 'webspinner', name: 'Webspinner', icon: '🕷️',
    desc: 'Trapper. Starts with Sticky Web. +30% pickup radius, slower.',
    starter: 'web',
    statMul: { dmg: 1.0, moveSpeed: 0.88, magnet: 1.30 },
    hpMax: 110,
    unlock: 'minibox_x3',
    tint: 0xa066ff, scaleMul: 1.08,    // placeholder: violet, chunkier
    signatureName: 'Lingering Silk',
    signatureDesc: 'Heal 0.5 HP/s while standing inside any of your webs.',
    signature: (runState) => {
      runState.signature_webHeal = 0.5;
    },
  },
  {
    id: 'sniper', name: 'Sniper',      icon: '🎯',
    desc: 'Precise. Starts with Magic Missile. +35% projectile speed, +10% damage.',
    starter: 'autoaim',
    statMul: { dmg: 1.10, moveSpeed: 1.0, magnet: 1.0, projSpeed: 1.35 },
    hpMax: 95,
    unlock: 'first_victory',
    tint: 0x66ddaa, scaleMul: 0.96,    // placeholder: pale green, slim
    signatureName: 'Headhunter',
    signatureDesc: '×3 dmg above 80% HP, ×0.7 below 20%. Reward openers.',
    signature: (runState) => {
      runState.signature_executeBonus = true;
    },
  },
  {
    // Burst-identity character: dies LOUDLY. One free 200-dmg shockwave on
    // death — the inverse of Clockwork's slow-burn scaling. Glass cannon
    // build, slight dmg edge, low HP, warm-red phoenix tint.
    id: 'phoenix', name: 'Phoenix Vow', icon: '🪶',
    desc: 'Burns hot. +15% damage, low HP. Dies in a 200-dmg shockwave.',
    starter: 'autoaim',
    statMul: { dmg: 1.15, moveSpeed: 1.05, magnet: 1.0 },
    hpMax: 80,
    unlock: 'sigils:30',
    tint: 0xff6655, scaleMul: 0.94,    // ember-red, slightly slimmer
    signatureName: 'Ember Burst',
    signatureDesc: 'On dying, emit a 10u shockwave: 200 dmg + 0.5s knockback.',
    signature: (runState) => {
      runState.signature_emberBurst = true;
    },
  },
  {
    // Late-game scaling identity: deliberately under-tuned early so the
    // 0.00375/s tempo accumulator (cap +60% at 2:40) reads as a real arc.
    // The mirror of Phoenix — payoff for not-dying instead of dying-loud.
    id: 'clockwork', name: 'Clockwork', icon: '⚙️',
    desc: 'Slow start, late payoff. +3% damage every 8s (max +60% at 2:40).',
    starter: 'orbitals',
    statMul: { dmg: 0.90, moveSpeed: 1.0, magnet: 1.0 },
    hpMax: 95,
    unlock: 'flag:unlockedClockwork',
    tint: 0xc89858, scaleMul: 1.00,    // brass cog
    signatureName: 'Tempo',
    signatureDesc: '+3% all damage every 8s of run-time (cap +60% at 2:40).',
    signature: (runState) => {
      // ratePerSec * t, capped. 0.00375/s = +3% / 8s. 0.60 cap reached at 160s.
      runState.signature_tempo = { ratePerSec: 0.00375, cap: 0.60 };
      runState.signature_tempoBonus = 0;
    },
  },
];

/**
 * Avatars — visual character identity, independent of gameplay archetype.
 * Iter 32 split: CHARACTERS (above) now exclusively means archetype/profile
 * (starter weapon, stat multipliers, signature). AVATARS defines which mesh
 * + tint renders for the hero. The start screen presents both pickers:
 * carousel for avatar, chip row for archetype.
 *
 * `glb` field is optional — null/undefined means use the shared HERO.glb
 * donor model with optional tint. When set, preloadAll registers it as
 * `hero_${id}` and hero.js pulls that key.
 */
// Iter 34 — Phase C (progression redesign): each avatar carries its own
// gameplay identity. `baseArchetype` points to a CHARACTERS row whose
// statMul/hpMax/starter/signature get applied at run start; the original
// 6 archetypes (Balanced / Boom / Webspinner / Sniper / Phoenix / Clockwork)
// are mapped onto the avatars they "absorb" per docs/PROGRESSION_REDESIGN.md
// §5.C. `signatureWeapon` is the bespoke weapon id assigned to the avatar
// — until Phase D/F lands the module, it falls back to baseArchetype.starter.
// `unlock` follows the same shape as CHARACTERS.unlock (null = free; an
// achievement id, 'sigils:N', or 'flag:fieldName').
export const AVATARS = [
  {
    id: 'kitty', name: 'Kitty Kaki', icon: '🐱',
    desc: 'The original. Plush, pink-eared, ready for mayhem.',
    glb: null,                          // donor model (tower-castle-plain)
    tint: 0xffffff, scaleMul: 1.00,
    baseArchetype: 'kitty',             // Balanced (Nine Lives + orbitals)
    signatureWeapon: 'sig_kitty_lucky_paw',
    unlock: null,
  },
  {
    id: 'sote',  name: 'Sote',       icon: '🐺',
    desc: 'Heavy-built Rodin-baked silhouette. Same gameplay, new look.',
    glb: 'sote.glb',
    tint: 0xffffff, scaleMul: 1.00,
    baseArchetype: 'kitty',             // Balanced base; bespoke kit lands in Phase F
    signatureWeapon: 'sig_sote_warhowl',
    unlock: null,                       // STARTER per Phase B
  },
  {
    id: 'cowboy', name: 'CowboyKaki', icon: '🤠',
    desc: 'Spurs, brim, and a slow draw. Same kitty, frontier loadout.',
    glb: 'cowboykaki.glb',
    tint: 0xffffff, scaleMul: 1.00,
    baseArchetype: 'sniper',            // Headhunter + autoaim
    signatureWeapon: 'sig_cowboy_sixshooter',
    unlock: null,                       // STARTER per Phase B
  },
  {
    id: 'pipes', name: 'Pipes', icon: '🥸',
    desc: 'Team-lead avatar. Mustache, red shirt, runs the room.',
    glb: 'pipes.glb',
    tint: 0xffffff, scaleMul: 1.00,
    baseArchetype: 'boom',              // Charged Coil + chain lightning
    signatureWeapon: 'sig_pipes_arcwrench',
    unlock: 'flag:pipes',
  },
  {
    id: 'bomdia', name: 'Bom Dia', icon: '☀️',
    desc: 'Bom Dia — green twin-tails, idol energy at sunrise.',
    glb: 'bomdia.glb',
    tint: 0xffffff, scaleMul: 1.00,
    baseArchetype: 'clockwork',         // Tempo + orbitals (absorbs Clockwork)
    signatureWeapon: 'sig_bomdia_sunburst',
    unlock: 'flag:bomdia',
  },
  {
    id: 'mothman', name: 'Mothman', icon: '🦋',
    desc: 'Mothman — pink-winged cryptid, eyes like brake lights.',
    glb: 'mothman.glb',
    tint: 0xffffff, scaleMul: 1.00,
    baseArchetype: 'webspinner',        // Lingering Silk + web
    signatureWeapon: 'sig_mothman_dustcloak',
    unlock: 'flag:mothman',
  },
  {
    id: 'camper', name: 'Camper', icon: '⛺',
    desc: 'Camper — blue pigtails, bedroll, never lost in the woods.',
    glb: 'camper.glb',
    tint: 0xffffff, scaleMul: 1.00,
    baseArchetype: 'phoenix',           // Ember Burst + autoaim (absorbs Phoenix)
    signatureWeapon: 'sig_camper_signalfire',
    unlock: 'flag:camper',
  },
  {
    id: 'space', name: 'Space Kitty', icon: '🚀',
    desc: 'Space Kitty — vacuum-rated whiskers, zero-G stride.',
    glb: 'spacekitty.glb',
    tint: 0xffffff, scaleMul: 1.00,
    baseArchetype: 'kitty',             // Balanced base; orbital sat kit lands Phase D
    signatureWeapon: 'sig_space_satellites',
    unlock: 'flag:space',
  },
  {
    id: 'radcat', name: 'Radcat', icon: '☢️',
    desc: 'Geiger-line stray. Oil-slick coat, cyan spine piping, dosimeter eyes.',
    glb: 'radcat.glb',
    tint: 0xffffff, scaleMul: 1.00,
    baseArchetype: 'kitty',             // Balanced base; DoT zone kit lands Phase F
    signatureWeapon: 'sig_radcat_fallout',
    unlock: 'flag:radcat',
  },
  {
    id: 'mona', name: 'Mona', icon: '🎨',
    desc: 'Painted, not born. Madonna della Falena — the paint moved.',
    glb: 'mona.glb',
    tint: 0xffffff, scaleMul: 1.00,
    baseArchetype: 'kitty',             // Balanced base; paint AoE kit lands Phase F
    signatureWeapon: 'sig_mona_brushstroke',
    unlock: 'flag:mona',
  },
  {
    id: 'bezelbug', name: 'BezelBug', icon: '💎',
    desc: 'BezelBug — gem-encrusted exoskeleton, rivet-set wings.',
    glb: 'bezelbug.glb',
    tint: 0xffffff, scaleMul: 1.00,
    baseArchetype: 'kitty',             // Balanced base; gem-shard kit lands Phase F
    signatureWeapon: 'sig_bezelbug_facet',
    unlock: 'flag:bezelbug',
  },
  {
    id: 'rocker', name: 'RockerKaki', icon: '🎸',
    desc: 'RockerKaki — leathers, hair-spray halo, amp turned to eleven.',
    glb: 'rockerkaki.glb',
    tint: 0xffffff, scaleMul: 1.00,
    baseArchetype: 'kitty',             // Balanced base; sonic-wave kit lands Phase F
    signatureWeapon: 'sig_rocker_powerchord',
    unlock: 'flag:rocker',
  },
  {
    id: 'borgirboss', name: 'BorgirBoss', icon: '🍔',
    desc: 'BorgirBoss — burger dump truck hauling a rack of rocket launchers.',
    glb: 'borgirboss.glb',
    tint: 0xffffff, scaleMul: 1.15,
    baseArchetype: 'boom',              // big silhouette + signature ranged barrage
    signatureWeapon: 'sig_borgirboss_rocketrack',
    // Hardest avatar in the roster — only unlocks after sweeping every boss
    // on the hypermode difficulty modifier. Flag set in commitRunResults.
    unlock: 'flag:allBossesHypermode',
  },
];

/**
 * Avatar→archetype apply helper. Reads CHARACTERS row that the avatar's
 * baseArchetype points at, then returns its statMul/hpMax/starter/signature
 * fields composed onto a fresh object. Phase C uses this to remove the
 * "two-axis selection" UI: only the avatar is chosen, gameplay derives.
 *
 * Phase D/F will replace `baseArchetype` lookups with the avatar's own
 * bespoke fields. Until then this shim keeps existing archetype signatures
 * (Nine Lives, Headhunter, Tempo, etc.) intact while the kit registry fills.
 */
export function archetypeForAvatar(avatar) {
  if (!avatar) return CHARACTERS[0];
  const arch = CHARACTERS.find(c => c.id === avatar.baseArchetype);
  return arch || CHARACTERS[0];
}

/**
 * Selectable stages. Stage 1 is the default; Stage 2 unlocks on first victory
 * (shares the `unlockedHyper` flag — same trigger). Each stage tweaks the
 * difficulty curve and re-tints the ground for biome flavor without needing
 * a full asset swap.
 */
export const STAGES = [
  {
    id: 'forest', name: 'Verdant Forest',
    desc: 'The starting wood — moss, mushrooms, ferns.',
    enemyHpMul: 1.0,
    finalBossAt: 900,           // 15:00 (default)
    groundTint: 0xffffff,       // base — no recolor
    fogColor: null,             // default world fog
    unlock: null,
  },
  {
    id: 'twilight', name: 'Twilight Hollow',
    desc: 'Deeper grove. Damp mud underfoot; enemies tougher; night closes in faster.',
    enemyHpMul: 1.30,
    finalBossAt: 720,           // 12:00 — final boss arrives 3 min sooner
    // Real PBR swap: ground uses brown_mud (Poly Haven CC0). Slight cool
    // desaturation on top so the mood reads as twilight, not midday.
    groundTint: 0xb6bccc,
    fogColor: 0x0a1a22,
    unlock: 'unlockedHyper',    // first victory
  },
  {
    id: 'cinder', name: 'Cinder Caverns',
    desc: 'Scorched undercaves. Red embers settle on cracked stone; the air burns; the run gets fast.',
    enemyHpMul: 1.60,
    finalBossAt: 600,           // 10:00 — bosses come fast and hot
    // Reuses brown_mud ground but tinted deep red so it reads as fired clay /
    // basalt rather than mud. Fog goes warm-charcoal.
    groundTint: 0xc04428,
    fogColor: 0x2a0904,
    unlock: 'unlockedCinder',   // first twilight victory
  },
  {
    id: 'void', name: 'Catacomb Void',
    desc: 'A bone-quiet under-grave. The Reaper exacts a toll for every breath drawn here.',
    enemyHpMul: 1.85,
    finalBossAt: 540,           // 9:00 — death pressure forces fast runs
    // Cold purple-bruise tint with deep-violet fog to read as crypt-light.
    groundTint: 0x6a4a8a,
    fogColor: 0x0a0612,
    unlock: 'unlockedVoid',     // first cinder victory (future hook)
  },
];

export const STAGE = {
  durationSec: 1800,        // run length
  finalBossAt: 900,         // 15 min — final boss spawns; killing it triggers victory
  finalBossWarnSec: 5,      // banner shown N sec before spawn
  finalBossHpMul: 30,       // boss is the chosen elite at this HP multiplier
  finalBossScaleMul: 2.2,
  miniBossSchedule: [240, 480, 720],   // 4/8/12 min mini-boss spawns
  miniBossWarnSec: 4,
  miniBossHpMul: 3,
  miniBossScaleMul: 1.4,
};
