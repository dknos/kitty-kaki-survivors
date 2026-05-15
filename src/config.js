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
  targetAliveBase: 100,
  targetAlivePerD: 40,      // alive = base + D * perD
  targetAliveCap: 600,
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

/** Initial roster size pre-warmed per pool to hide first-horde stall. */
export const POOL_PREWARM = {
  // iter 33t — sized to absorb 100-600 alive cap without mid-game cloning.
  // Common tier counts ~2.5×; heavy tiers ~2×; rare elites 1× (low weight).
  zombie: 70, goblin: 70, skeleton: 50, orc: 36, demon: 36,
  robot: 24, mech: 16, xeno: 24, slime: 32, giant: 6, dragon: 3,
  spider: 48, wolf: 36, wizard: 24, ghost: 24,
  // Forest bugs — high counts because they're the new primary tier
  ant: 100, beetle: 60, ladybug: 50, grasshopper: 40, butterfly: 30,
  bee: 30, cockroach: 40, wasp: 24, caterpillar: 12, mantis: 12,
};

export const SPATIAL = {
  cellSize: 6,              // SpatialHash cell edge
};

export const WEAPONS = {
  startingWeapon: 'orbitals',
  maxSlots: 6,
  maxPassives: 6,
};

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
export const AVATARS = [
  {
    id: 'kitty', name: 'Kitty Kaki', icon: '🐱',
    desc: 'The original. Plush, pink-eared, ready for mayhem.',
    glb: null,                          // donor model (tower-castle-plain)
    tint: 0xffffff, scaleMul: 1.00,
  },
  {
    id: 'sote',  name: 'Sote',       icon: '🐺',
    desc: 'Heavy-built Rodin-baked silhouette. Same gameplay, new look.',
    glb: 'sote.glb',
    tint: 0xffffff, scaleMul: 1.00,
  },
  {
    id: 'cowboy', name: 'CowboyKaki', icon: '🤠',
    desc: 'Spurs, brim, and a slow draw. Same kitty, frontier loadout.',
    glb: 'cowboykaki.glb',
    tint: 0xffffff, scaleMul: 1.00,
  },
  {
    id: 'kaki3', name: 'Kaki 3', icon: '✨',
    desc: 'Placeholder name. Newly Rodin-baked silhouette.',
    glb: 'kaki3.glb',
    tint: 0xffffff, scaleMul: 1.00,
  },
];

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
