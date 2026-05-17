/**
 * Single mutable GameState object. Every module imports `state` from this file.
 * No window globals. No module-scoped game data outside this file.
 * If you need to add data, add it here so it shows up in resetState().
 */
import * as THREE from 'three';
import { HERO, XP } from './config.js';

export const state = {
  // ── Top-level mode: 'menu' (start screen), 'town' (hub), 'run' (active game),
  //    'interior' (cabin room), 'catacomb' (dungeon sub-arena). ──
  mode: 'menu',

  // ── THREE.js core (set by main.js bootstrap) ──
  scene:    /** @type {THREE.Scene|null}  */ (null),
  camera:   /** @type {THREE.OrthographicCamera|null} */ (null),
  renderer: /** @type {THREE.WebGLRenderer|null} */ (null),
  composer: /** @type {any|null} */ (null),
  bloomPass: null,
  postFXPass: null,
  envGroup: /** @type {THREE.Group|null} */ (null),

  // ── Time ──
  time: {
    game: 0,          // paused-aware run time (seconds)
    dt: 0,            // last frame delta (clamped <= 0.05)
    real: 0,          // wall-clock (for UI anims during pause)
    paused: false,    // when true, main loop skips logic + renders only
  },

  // ── Hero ──
  hero: {
    mesh:   /** @type {THREE.Object3D|null} */ (null),
    pos:    new THREE.Vector3(),
    vel:    new THREE.Vector3(),
    facing: new THREE.Vector3(0, 0, 1),
    hp:     HERO.hpMax,
    hpMax:  HERO.hpMax,
    level:  1,
    xp:     0,
    xpNext: XP.base,
    iFramesUntil: 0,   // game-time at which i-frames expire
    /** stat multipliers applied by passives; default 1.0 */
    statMul: { dmg: 1, projSpeed: 1, area: 1, cooldown: 1, magnet: 1, hpMax: 1, moveSpeed: 1, duration: 1, dmgTaken: 1 },
    regenPerSec: 0,
    // Dash (charge / pushback)
    dashUnlocked: false,
    dashLevel: 0,           // 0 = locked. Each filler pick increments.
    dashCD: 0,              // seconds until next dash usable
    dashUntil: 0,           // real-time when current dash ends (0 if not dashing)
    dashDir: { x: 0, z: 1 },
    // Vertical motion (jump)
    velY: 0,
    grounded: true,
    // Filler-pick history (for evolution eligibility)
    fillerCounts: { heal:0, maxhp:0, speed:0, magnet:0, cooldown:0, damage:0, dash:0, zoomout:0 },
    // Level-up QoL currencies
    rerolls: 1,
    skips: 1,
  },

  // ── Totems (combat-state destructibles, see src/totems.js) ──
  totems: {
    list: [],          // active totem instances (also pushed into enemies.active)
    respawnQueue: [],  // {at: gameTime, slot: index} scheduled respawns
    initialized: false,
    target: 3,         // how many totems live at once
  },

  // ── Shock Pylons (area-denial destructibles, see src/pylons.js) ──
  pylons: {
    list: [],
    respawnQueue: [],
    initialized: false,
    target: 2,
    armedAt: 120,      // game-time (sec) at which pylons first spawn
  },

  // ── Cursed Bell (risk/reward enrage objective, see src/bells.js) ──
  bells: {
    list: [],
    initialized: false,
    target: 1,
    armedAt: 180,      // game-time (sec) at which bell first spawns
  },

  // ── Enemies ──
  enemies: {
    /** @type {Array<EnemyInstance>} */
    active: [],
    /** pools keyed by glb key: { zombie: [mesh, mesh, ...], ... } */
    pools: /** @type {Record<string, THREE.Object3D[]>} */ ({}),
    /** spatial hash for fast radius queries (set by enemies.js init) */
    spatial: /** @type {any|null} */ (null),
  },

  // ── Projectiles (spawned by weapons) ──
  projectiles: {
    /** @type {Array<Projectile>} */
    active: [],
  },

  // ── Enemy projectiles (wizards, etc.) ──
  enemyProjectiles: {
    /** @type {Array<{mesh, vx, vz, ttl, dmg, hitR2}>} */
    active: [],
  },

  // ── Web slow patches (Sticky Web weapon) ──
  webs: {
    /** @type {Array<{x:number,z:number,radius:number,ttl:number,slowMul:number}>} */
    list: [],
  },

  // ── Gems / XP drops ──
  gems: {
    instMesh:   /** @type {THREE.InstancedMesh|null} */ (null),
    /** @type {Array<Gem>} */
    list: [],
    nextSlot: 0,
  },

  // ── Weapons + Passives ──
  /** @type {Array<{id:string, level:number, inst:any}>} */
  weapons: [],
  /** @type {Array<{id:string, level:number}>} */
  passives: [],

  // ── Run stats ──
  run: {
    kills: 0,
    dmgDealt: 0,
    dmgTaken: 0,
    pickedGems: 0,
    startedAt: 0,
    // Rolling DPS window: array of [gameTime, damageThisFrame] for last ~5s
    _dpsWin: [],
    /** Per-source damage tally, keyed by weapon/source id. */
    dmgByWeapon: /** @type {Record<string, number>} */ ({}),
    // Secret-unlock tracking
    noDmgKills: 0,       // kills since last hit (reset on damage)
    flawless: true,      // false once hero takes any damage this run
    speedrunChecked: false, // one-shot flag for speedrun_lv10
    // Punch List #4 (2026-05-16) — coin-paid rerolls used on the CURRENT
    // level-up/sigil offer. Reset to 0 at the top of showLevelUpModal so the
    // cap (SIGIL_REROLL.capPerOffer) never leaks across queued offers.
    rerollsThisOffer: 0,
    // FOREST-V2-A12 (#116) — level-up QoL economy.
    // `_rerollsThisRun` ramps the GOLD-paid reroll button cost
    // (50 + 25 * uses, per run). Distinct from `rerollsThisOffer` above,
    // which gates the META-coin reroll's per-offer cap.
    _rerollsThisRun: 0,
    // Set of choice ids banished this run (filtered from weaponChoices()
    // forever after the BANISH action). Set for O(1) lookup; Sets serialize
    // to `{}` in JSON.stringify — any save/load layer must convert to Array.
    /** @type {Set<string>} */
    _banishedThisRun: new Set(),
    // Punch List #3 (2026-05-16) — Dissolve-to-Gold death FX kill-switch.
    // When true, `spawnDissolveBurst` early-outs and skips the 24-instance
    // burst (the kill ring + blob-shadow scale-down still fire). Toggle from
    // devtools console (`state.run.lowFx = true`) if perf-report comes in.
    lowFx: false,
  },

  // ── FX ──
  // Iter 24b: hitStop is *consumed* by main.js (frame loop at ~L1069 and the
  // catacomb branch at ~L927) — when > 0, logicDt is forced to 0 so the world
  // freezes while damage numbers + shake still tick on realDt. No main.js
  // change is needed to trigger hit-pause; damageEnemy just sets hitStop
  // higher. _hitPauseNextEligible is a cross-frame gate so that orbitals
  // hitting 5 enemies/frame can't re-trigger every frame and lock the loop.
  fx: {
    chromaticPulse: 0,   // 0..1, decays each frame
    bloomBoost: 0,       // 0..1, decays each frame
    hitStop: 0,          // seconds of remaining time-freeze (drained each frame)
    _hitPauseNextEligible: 0,  // state.time.real value before which heavy-hit pause is skipped
    shake: 0,            // 0..1 screen-shake magnitude, decays each frame
    // Iter 8: queued Volatile-affix explosions. Each entry {x,z,t}. Drained
    // at the top of updateEnemies when t <= state.time.game.
    pendingVolatile: /** @type {Array<{x:number,z:number,t:number}>} */ ([]),
  },

  // ── Input ──
  input: {
    moveVec: new THREE.Vector2(),    // unit vector, screen-space (-1..1 each axis)
    fire: false,
  },

  // ── UI / level-up ──
  pendingLevelUp: false,
  // Iter 32i — cascade batching. When multiple levels queue from a single
  // XP injection (elite drops + accumulated trash), they were popping
  // modals back-to-back ("click click click"). Now levels accumulate here
  // and the modal sequences them with a "Level X (i of N)" header. Game
  // stays paused until pendingLevelCount === 0.
  pendingLevelCount: 0,
  /** @type {Array<{kind:'weapon'|'passive', id:string, level:number}>} */
  levelUpChoices: [],
  gameOver: false,
  victory: false,
  dyingUntil: 0,         // real-time at which death animation ends + death screen shows
  started: false,        // false until "press start" cleared

  // ── Iter 10a accessibility caches (mirrored from meta for per-frame reads) ──
  // Main.js boot + the Options menu both stamp these so per-frame readers
  // (vfxBurst, postfx, hero.takeDamage flash) can skip a getMeta() call.
  // `_optShakeMul` (existing) is forced to 0 by callers when _optReduceMotion
  // is true — see main.js boot apply + ui.showOptions onChange paths.
  _optReduceMotion: false,
  _optReducedFlashing: false,
};

/**
 * @typedef {Object} EnemyInstance
 * @property {THREE.Object3D} mesh
 * @property {string} glbKey
 * @property {number} hp
 * @property {number} hpMax
 * @property {number} spd
 * @property {number} dmg
 * @property {number} contactCooldown  // seconds until can deal contact damage again
 * @property {boolean} elite
 * @property {boolean} alive
 */

/**
 * @typedef {Object} Projectile
 * @property {THREE.Object3D} mesh
 * @property {THREE.Vector3} vel
 * @property {number} dmg
 * @property {number} ttl       // seconds remaining
 * @property {number} pierce    // remaining hits before destroy
 * @property {Set<any>} hit     // enemies already damaged by this projectile
 * @property {string} ownerWeapon
 */

/**
 * @typedef {Object} Gem
 * @property {THREE.Vector3} pos
 * @property {number} value
 * @property {boolean} active
 * @property {boolean} magnetized
 * @property {number} instanceIndex
 */

export function resetState() {
  state.time.game = 0; state.time.dt = 0; state.time.paused = false;
  state.hero.pos.set(0,0,0); state.hero.vel.set(0,0,0);
  state.hero.hp = HERO.hpMax; state.hero.hpMax = HERO.hpMax;
  state.hero.level = 1; state.hero.xp = 0; state.hero.xpNext = XP.base;
  state.hero.iFramesUntil = 0;
  for (const k of Object.keys(state.hero.statMul)) state.hero.statMul[k] = 1;
  state.enemies.active.length = 0;
  state.projectiles.active.length = 0;
  state.enemyProjectiles.active.length = 0;
  state.gems.list.length = 0; state.gems.nextSlot = 0;
  state.webs.list.length = 0;
  state.hero.dashUnlocked = false;
  state.hero.dashLevel = 0;
  state.hero.dashCD = 0;
  state.hero.dashUntil = 0;
  state.hero.dashDir.x = 0; state.hero.dashDir.z = 1;
  for (const k of Object.keys(state.hero.fillerCounts)) state.hero.fillerCounts[k] = 0;
  state.hero.rerolls = 1;
  state.hero.skips = 1;
  state.hero.velY = 0;
  state.hero.grounded = true;
  state.weapons.length = 0;
  state.passives.length = 0;
  state.hero.regenPerSec = 0;
  state.run.kills = 0; state.run.dmgDealt = 0; state.run.dmgTaken = 0; state.run.pickedGems = 0;
  state.run.miniBossKills = 0;
  // FOREST-V2-A6 — per-run gold pool, fed by the forest treasure-chest gold
  // option (3-option picker on miniboss/elite kill). 0 at run start.
  state.run.gold = 0;
  // FOREST-V2-A12 (#116) — level-up QoL economy (REROLL/BANISH/SKIP).
  // `_rerollsThisRun` ramps the gold-paid reroll cost (50 + 25 * uses).
  // `_banishedThisRun` is a Set of choice ids permanently filtered out of
  // weaponChoices() rolls for the rest of this run. Set chosen for O(1)
  // lookup; NOTE: Sets serialize to `{}` in JSON.stringify, so any future
  // save/load layer must convert to Array (acceptable loss for this PR).
  state.run._rerollsThisRun = 0;
  state.run._banishedThisRun = new Set();
  // Ascension Evolution gate (Punch List #1, 2026-05-16). Set to true the
  // first time any weapon evolves this run; gate for badges + achievements.
  state.run.hasEvolvedThisRun = false;
  state.run._dpsWin.length = 0;
  state.run.dmgByWeapon = {};
  state.run.noDmgKills = 0;
  state.run.flawless = true;
  state.run.speedrunChecked = false;
  // Punch List #4 — coin-paid reroll counter (cleared per-offer; resetState
  // also wipes it so a fresh run starts at zero).
  state.run.rerollsThisOffer = 0;
  // Punch List #3 — Dissolve-to-Gold kill-switch defaults off each run.
  // (User can still flip it back on at runtime; it just doesn't persist
  // across run-reset so a stuck "off" state can't leak into a fresh run.)
  state.run.lowFx = false;
  // ── Forest Expansion v0.1 (FE-C1A, 2026-05-16) ──
  // Multi-room state machine for the Forest stage. `roomState` drives the
  // spawnDirector pause/resume (Cohort 3 Agent 4) and the puzzle system
  // (Cohort 2 Agent 3). `currentRoom` is the id from FOREST_ROOMS (see
  // src/forestRooms.js); always reset to 'glade' so a fresh run starts in
  // the hub regardless of where the prior run ended. `activePuzzle` is the
  // puzzle id currently in flight (matches FOREST_ROOMS[id].puzzle) or null.
  // `forestPuzzlesSolved` is per-run: persistent unlocks live on the meta
  // blob (`meta.forestPuzzlesSolved` — see src/meta.js).
  state.run.roomState           = 'ARENA';   // 'ARENA' | 'TRANSITIONING' | 'IN_ROOM' | 'PUZZLE_ACTIVE'
  state.run.currentRoom         = 'glade';   // current room id from FOREST_ROOMS
  state.run.activePuzzle        = null;      // id of active puzzle, or null
  state.run.forestPuzzlesSolved = {};        // { flow_weaver: true, ... } — THIS RUN ONLY
  // ── Lockdown Arena (FOREST ITER C1, 2026-05-16) ──
  // Stage-agnostic "doors slam, clear 3 waves or 1 elite" mechanic
  // (src/lockdownArena.js). Defaults wipe per run so a fresh run can't
  // inherit a paused or fired flag from a prior run. `_forestLockdownFired`
  // is a one-time per-run trigger guard — first hero-into-zone fires it;
  // subsequent re-entries are ignored until run-reset clears it.
  state.run.lockdownActive        = false;   // spawnDirector reads this to pause normal cadence
  state.run.lockdownWavesCleared  = 0;       // 0..3 wave-progression mirror for UI/badges
  state.run.lockdownEliteSeen     = false;   // any elite tagged into the live lockdown
  state.run._forestLockdownFired  = false;   // one-time per-run trigger guard (Forest)
  // ── Sealed Door Room Progression (FOREST-V2-A14, 2026-05-17) ──
  // Per-run map keyed by FOREST_ROOMS id (sealable non-glade rooms only).
  // Shape: { roomId: { bossId: string, alive: boolean }, ... }
  // - Key MISSING        → never entered this run (next entry spawns boss + seals)
  // - alive === true     → boss alive (return portal stays sealed)
  // - alive === false    → cleared (return portal already open; no respawn)
  // Reset every run so a fresh forest run replays the gating from zero.
  // Consumed by src/forestSealedDoors.js (onRoomEnter / onRoomBossKilled).
  state.run._sealedRooms          = {};
  // FOREST ITER C2 — Trap Corridor (stage-agnostic env-damage hazard lane,
  // src/trapCorridor.js). True if ≥1 corridor is armed; cheap flag so
  // readers don't have to iterate the corridor list.
  state.run.trapCorridorActive    = false;
  // ── Forest Expansion v0.2 (FE-V2 Landmarks, 2026-05-17) ──
  // Per-run additive bonus to outgoing damage, granted by Moss Shrine
  // landmarks (+0.05 each). Composed into the main enemy damage hot path in
  // enemies.js (sits next to passive_dmg). Reset to 0 every run so a fresh
  // run starts clean; ALWAYS read as `(1 + (state.run._dmgGlobalBonus||0))`
  // so a missing field on legacy save loads can't crash the math.
  state.run._dmgGlobalBonus       = 0;
  // ── Forest Expansion v0.2 (FE-V2 Coffins, 2026-05-17) ──
  // Per-run map of opened Evolution Coffin instance ids. Reset every run
  // so a fresh forest scene gets a fresh placement + fresh opens. Coffin
  // entities live in src/forestCoffins.js; the dispatch path writes a
  // truthy entry here keyed by `'c' + instanceIdx`. Persistence is per
  // run only — coffins refresh between runs (matches VS staple).
  state.run._coffinsOpened        = {};
  // ── Forest Expansion v0.2 (FOREST-V2-A7 Reaper, 2026-05-17) ──
  // Per-run gating flags for the 30:00 endgame Reaper. All three are
  // one-shot: warning fires once at 29:30, spawn once at 30:00, outlast
  // bonus once at 35:00. Reset every run so a fresh forest run replays the
  // schedule from zero. `stats` is a free-form bag used by post-run UI
  // (reaperKillTime / reaperOutlasted are written by forestReaper.js into
  // state.run.stats). Initialized here so other systems can stamp into
  // state.run.stats too without an "if (stats)" guard at every site.
  state.run._reaperWarned         = false;
  state.run._reaperSpawned        = false;
  state.run._reaperOutlastedFired = false;
  // PHASE 1 P1G Sigil Arc (2026-05-17) — last-seen lifetime sigil count.
  // Used by src/forestSigilArc.js to detect grants via monotonic diff on
  // meta.lifetime.sigilsEarned. Re-baselined to the live lifetime value
  // inside loadForestSigilArc so the very first poll doesn't false-fire
  // on prior-run accumulation. null sentinel here forces that re-baseline
  // on first load even if state.run gets mutated by another flow.
  state.run._sigilsLastSeen       = null;
  // PHASE 1 P1E (2026-05-17) — Boss intro cinematic per-run gating. One-shot
  // per tier per run: the first miniboss / elite / room-boss / Reaper spawn
  // fires a 1.5s camera dolly + name banner; subsequent same-tier spawns are
  // skipped. _bossIntroActive is the in-flight flag (true during the 1.5s
  // sequence) — any subsystem that wants to react to "boss intro playing"
  // can read it (currently nothing does; spec FALLBACK path skips enemy
  // freeze). See src/bossIntroCinematic.js.
  state.run._cinematicSeen        = { miniboss: false, elite: false, roomboss: false, reaper: false };
  state.run._bossIntroActive      = false;
  // PHASE 1 P1F (2026-05-17) — End-of-run summary screen one-shot flag.
  // Set true by src/endRunSummary.js the first frame it detects either
  // state.gameOver === true OR state.run.stats.reaperOutlasted === true.
  // Reset every run so a fresh run can fire the panel again. The endRun
  // module never clears this itself — ownership lives here so the tick
  // poll has a single canonical source of truth across run resets.
  state.run._summaryShown         = false;
  // Per-run chest counter consumed by forestHud.js (em-dash fallback path
  // flips to numeric "Chests: N" once this field exists). Bumped in
  // forestChests._onPicked after _applyReward succeeds (single dispatch site).
  state.run._chestsOpened         = 0;
  // PHASE 1 P1B — Achievement chain. Per-run Set of unlocked achievement ids
  // (gates toast re-fire across runs; the persistent record lives on
  // meta.achievements). Cleared on resetState so a fresh run can re-feel the
  // unlock chime for player feedback. The lifetime record on meta.achievements
  // is untouched here.
  state.run._achievementsThisRun  = new Set();
  // PHASE 1 P1B — `all_rooms_visited` per-run room tracker (object map, JSON-
  // safe). Forest stage only; harmlessly stays empty on other stages.
  state.run._roomsVisited         = {};
  state.run.stats                 = {};
  state.run.relicDrop = null;
  state.run.equippedRelic = null;
  state.run.heartPotency = 1;
  state.run.cellarLv = 0;
  // Passive run-flags (iter 2). Defaults are the "no passive" identity values.
  state.run.passive_xpMul          = 1;
  state.run.passive_vampLevel      = 0;
  state.run.passive_vampHpPerKill  = 0;
  state.run.passive_vampPct        = 0;
  state.run.passive_echoChance     = 0;
  state.run.passive_berserkMax     = 0;
  state.run.passive_knockMul       = 1;
  state.run.passive_staggerResist  = 0;
  state.run.passive_greedMul       = 1;
  state.run.passive_soulLinkXpMul  = 1;
  // Druid's Charm (P1H, 2026-05-17): forest-only XP boost. xp.js reads this
  // gated on stage.id === 'forest'. Identity 1.0 when not picked.
  state.run.passive_druidXpMul     = 1;
  // ── Meta shop-tree scalars (iter 6, "Meta With Teeth") ──
  // Survival / Power / Greed branch effects bake into these at run start.
  // Effects authored in src/meta.js SHOP_TREE; consumers read these flags.
  state.run.passive_dmgReduction   = 0;   // 0..1, damage taken multiplier reduction
  state.run.passive_dmg            = 1;   // outgoing damage multiplier
  state.run.passive_cooldown       = 1;   // weapon cooldown multiplier (lower = faster)
  state.run.passive_critChance     = 0;   // 0..1, additive crit chance
  state.run.passive_regen          = 0;   // additive HP/sec passive regen
  state.run.passive_coinMul        = 0;   // additive coin-gain bonus (stacks w/ greedMul)
  state.run.passive_chestRate      = 0;   // additive chest spawn rate bonus
  state.run.passive_miniBossSigilBonus = 0; // extra sigils per mini-boss kill
  state.run.passive_revives        = 0;   // free revives banked for this run
  state.run.passive_overdrive      = false; // Power t4 capstone: ticks main-loop overdrive cycle
  state.run.passive_treasureMap    = false; // Greed t4 capstone: free starter chest in _primeRunStart
  state.run._treasureMapSpawned    = false; // one-shot guard so the chest isn't double-spawned across run-entry paths
  // ── Helltide overlay event (iter 17) ──
  // Auto-triggered timed mega-event: doubles spawn rate, runs multiple
  // concurrent mini-events, drops a unique currency. All state below is
  // owned by src/helltide.js; resetState wipes it so retries start clean.
  state.run.helltideActive         = false;
  state.run.helltideEndAt          = 0;     // game-time at which the current event ends
  state.run.helltideNextAt         = 0;     // game-time of next auto-trigger (set by helltide.js init)
  state.run.helltideSpawnMul       = 1;     // read by spawnDirector — multiplies target alive cap
  state.run.helltideEliteBonus     = 0;     // additive elite-chance bonus (reserved for future enemy roll)
  state.run.helltideEmbersBanked   = 0;     // total embers picked up this run
  state.run.helltideMaxBanked      = 0;     // best banked count across all Helltides this run
  // Overdrive cycle state (Power tier-4 capstone). Ticked from main.js run loop
  // when passive_overdrive is true: every 60s of game time, flip active=true for
  // 5s. During the active window we stash + multiply h.statMul.cooldown/dmg and
  // restore on deactivation. Stash fields live alongside so an early death or
  // restart can't strand the multipliers (resetState wipes them).
  state.run.overdriveActive        = false;
  state.run.overdriveTimer         = 0;
  state.run._overdrivePrevCD       = null;
  state.run._overdrivePrevDmg      = null;
  // Iter 8 affix per-frame scratch (re-stamped each frame by updateEnemies).
  state.run.affix_frostSlow        = 1;
  // Totem-of-Swarm bookkeeping — see src/totems.js
  if (state.totems) {
    for (const t of state.totems.list) { if (t.mesh && t.mesh.parent) t.mesh.parent.remove(t.mesh); }
    state.totems.list.length = 0;
    state.totems.respawnQueue.length = 0;
    state.totems.initialized = false;
  }
  // Shock-Pylon bookkeeping — see src/pylons.js
  if (state.pylons) {
    for (const p of state.pylons.list) { if (p.mesh && p.mesh.parent) p.mesh.parent.remove(p.mesh); }
    state.pylons.list.length = 0;
    state.pylons.respawnQueue.length = 0;
    state.pylons.initialized = false;
  }
  // Cursed-Bell bookkeeping — see src/bells.js
  if (state.bells) {
    for (const b of state.bells.list) { if (b.mesh && b.mesh.parent) b.mesh.parent.remove(b.mesh); }
    state.bells.list.length = 0;
    state.bells.initialized = false;
  }
  // Mode flags snapshot — main.js reads getMeta() and pushes here at run start.
  //
  // Punch List #6 (2026-05-16) note: profile-wide cosmetic flags (badges,
  // cosmetic unlocks, etc.) intentionally do NOT live on this per-run state
  // object — they belong on the persistent meta blob (`getMeta().badges`,
  // `meta.cosmetics`) so they survive resetState() between runs without a
  // shadow copy that can drift. Read them via hasBadge()/getMeta(), not via
  // state.modes.
  state.modes = state.modes || {};
  state.modes.hyper = false;
  state.modes.endless = false;
  state.run.startedAt = performance.now();
  state.fx.chromaticPulse = 0; state.fx.bloomBoost = 0; state.fx.hitStop = 0; state.fx.shake = 0;
  state.fx._hitPauseNextEligible = 0;
  if (state.fx.pendingVolatile) state.fx.pendingVolatile.length = 0;
  state.pendingLevelUp = false; state.pendingLevelCount = 0; state.levelUpChoices.length = 0; state.gameOver = false; state.victory = false; state.dyingUntil = 0;
}

/** Compute XP required for next level after `lvl`. */
export function xpForLevel(lvl) {
  return Math.ceil(XP.base * Math.pow(XP.growth, lvl - 1));
}
