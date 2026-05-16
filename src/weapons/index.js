/**
 * Weapon registry + lifecycle. Add a new weapon by:
 *   1) creating src/weapons/foo.js with the default-export contract,
 *   2) importing it here and adding to REGISTRY.
 *
 * The rest of the game talks to weapons only through the four exports below.
 */
import * as THREE from 'three';
import { state } from '../state.js';
import { damageEnemy, queryRadius } from '../enemies.js';
import { unlockZoomLevel, getMaxZoomNotch, getZoomNotchCount } from '../input.js';

import orbitals from './orbitals.js';
import autoAim, { spawnGlasswindShards, syncProjectileVisuals, flushProjectileVisuals, releaseProjectileVisuals } from './autoAim.js';
import chain from './chain.js';
import web, { tickWebs } from './web.js';
import frostbloom from './frostbloom.js';
import sigilbell from './sigilbell.js';
// Iter 34 — Phase D signature weapons (1 bespoke kit per avatar; Phase F adds the rest).
import sigCowboySixshooter from './sig/cowboy_sixshooter.js';
import sigMothmanDustcloak from './sig/mothman_dustcloak.js';
import sigSpaceSatellites  from './sig/space_satellites.js';
// Phase F1 sig kits.
import sigKittyLuckyPaw    from './sig/kitty_lucky_paw.js';
import sigSoteWarhowl      from './sig/sote_warhowl.js';
import sigPipesArcwrench   from './sig/pipes_arcwrench.js';
import sigBomdiaSunburst   from './sig/bomdia_sunburst.js';
// Phase F2 sig kits.
import sigCamperSignalfire from './sig/camper_signalfire.js';
import sigRadcatFallout    from './sig/radcat_fallout.js';
import sigMonaBrushstroke  from './sig/mona_brushstroke.js';
// Phase F3 sig kits.
import sigBezelbugFacet    from './sig/bezelbug_facet.js';
import sigRockerPowerchord from './sig/rocker_powerchord.js';
// BorgirBoss (unlock-gated 13th avatar, post-Phase F).
import sigBorgirbossRocketrack from './sig/borgirboss_rocketrack.js';
// Forest Expansion C1B (FE-C1B) — special weapons unlocked by Forest puzzles.
// Registered in REGISTRY so `tickWeapons` picks them up, but `hidden: true`
// keeps them out of the level-up card pool (see weaponChoices filter below).
// Auto-equipped into a hidden 5th slot at run start when the player has
// unlocked them via `meta.forestWeapons` (puzzle reward).
import sapWeaver    from './sapWeaver.js';
import choirLance   from './choirLance.js';
import prismWarden  from './prismWarden.js';
import { getMeta } from '../meta.js';
import { passiveChoices, applyPassive, PASSIVES } from './passives.js';
export { applyPassive, PASSIVES };

export const REGISTRY = {
  [orbitals.id]:   orbitals,
  [autoAim.id]:    autoAim,
  [chain.id]:      chain,
  [web.id]:        web,
  [frostbloom.id]: frostbloom,
  [sigilbell.id]:  sigilbell,
  [sigCowboySixshooter.id]: sigCowboySixshooter,
  [sigMothmanDustcloak.id]: sigMothmanDustcloak,
  [sigSpaceSatellites.id]:  sigSpaceSatellites,
  [sigKittyLuckyPaw.id]:    sigKittyLuckyPaw,
  [sigSoteWarhowl.id]:      sigSoteWarhowl,
  [sigPipesArcwrench.id]:   sigPipesArcwrench,
  [sigBomdiaSunburst.id]:   sigBomdiaSunburst,
  [sigCamperSignalfire.id]: sigCamperSignalfire,
  [sigRadcatFallout.id]:    sigRadcatFallout,
  [sigMonaBrushstroke.id]:  sigMonaBrushstroke,
  [sigBezelbugFacet.id]:    sigBezelbugFacet,
  [sigRockerPowerchord.id]: sigRockerPowerchord,
  [sigBorgirbossRocketrack.id]: sigBorgirbossRocketrack,
  // Forest Expansion C1B — hidden special weapons (auto-equipped per
  // meta.forestWeapons; filtered out of weaponChoices via the `hidden` flag).
  [sapWeaver.id]:    sapWeaver,
  [choirLance.id]:   choirLance,
  [prismWarden.id]:  prismWarden,
};

// FE-C1B — list of weapon ids that count as Forest "special" (5th-slot)
// weapons. These are auto-equipped at run start per `meta.forestWeapons`
// (the puzzle-reward unlock list owned by Agent 1 — backward-compat: read
// defensively with `|| []`). Order is stable so equip is deterministic.
const FOREST_SPECIAL_IDS = ['sap_weaver', 'choir_lance', 'prism_warden'];

// Auto-equip Forest special weapons (FE-C1B) into the hidden 5th slot at run
// start. Idempotent: we early-return on any weapon id that's already in
// `state.weapons`, so the Cellar's repeated starter acquires (which loop
// through acquireWeapon multiple times) trigger this helper many times but
// each forest weapon is only pushed once. resetState() clears
// `state.weapons.length = 0` between runs, so the next run starts the loop
// fresh — no run-id bookkeeping needed.
function _equipForestSpecialsForRun() {
  let meta = null;
  try { meta = getMeta(); } catch (_) { meta = null; }
  const unlocked = (meta && Array.isArray(meta.forestWeapons)) ? meta.forestWeapons : [];
  if (unlocked.length === 0) return;
  for (const id of FOREST_SPECIAL_IDS) {
    if (!unlocked.includes(id)) continue;
    const mod = REGISTRY[id];
    if (!mod) continue;
    if (state.weapons.find(w => w.id === id)) continue;
    const entry = { id, level: 1, inst: {} };
    state.weapons.push(entry);
    const level = mod.levels[0];
    if (mod.init) try { mod.init(state, level, entry.inst); } catch (e) { console.warn('[weapons] forest init', id, e); }
  }
}

const WORLD_BOUND = 200; // projectile cull bound (square half-extent around hero)
const PROJ_HIT_RADIUS = 0.6;

export function initWeapons() {
  // Nothing to set up globally — scene/state are already available via `state`.
  // This exists for symmetry with the rest of the bootstrap order in main.js.
}

export function acquireWeapon(id) {
  const mod = REGISTRY[id];
  if (!mod) {
    console.warn('[weapons] unknown weapon id:', id);
    return;
  }
  const existing = state.weapons.find(w => w.id === id);
  if (existing) {
    if (existing.level >= mod.maxLevel) return;
    existing.level += 1;
    const level = mod.levels[existing.level - 1];
    if (mod.refresh) mod.refresh(state, level, existing.inst);
    _announceEligibleEvolutions();   // hitting maxLevel may unlock the evo
    return;
  }
  const entry = { id, level: 1, inst: {} };
  state.weapons.push(entry);
  const level = mod.levels[0];
  if (mod.init) mod.init(state, level, entry.inst);
  // FE-C1B: the first weapon acquired this run is the starter (see
  // main.js _startRun / _restartRun). Use this lifecycle moment to also
  // auto-equip any Forest special weapons the player has unlocked.
  // `_equipForestSpecialsForRun()` is internally idempotent (per-id
  // membership check), so subsequent acquires this run (Cellar duplicates
  // = level-ups, which hit the early-return branch above; level-up cards,
  // which hit either branch) are no-ops here.
  _equipForestSpecialsForRun();
}

export function tickWeapons(dt) {
  // 1) Run each weapon's tick
  for (const entry of state.weapons) {
    const mod = REGISTRY[entry.id];
    if (!mod) continue;
    const level = mod.levels[entry.level - 1];
    if (mod.tick) mod.tick(state, dt, level, entry.inst);
  }
  // 2) Update all live projectiles (spawned by weapons above)
  tickProjectiles(dt);
  // 3) Chain-lightning arc fade is owned by src/chainFx.js (A4 refactor) —
  //    main.js ticks the shared arc list once per frame after all spawners.
  // 4) Update sticky webs (decay + visual)
  tickWebs(dt);
}

function tickProjectiles(dt) {
  const list = state.projectiles.active;
  const scene = state.scene;
  const hero = state.hero.pos;

  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    // Move
    p.mesh.position.x += p.vel.x * dt;
    p.mesh.position.z += p.vel.z * dt;
    p.ttl -= dt;

    // Out-of-bounds / expired
    const dx = p.mesh.position.x - hero.x;
    const dz = p.mesh.position.z - hero.z;
    if (p.ttl <= 0 || Math.abs(dx) > WORLD_BOUND || Math.abs(dz) > WORLD_BOUND) {
      disposeProjectile(p, scene);
      list.splice(i, 1);
      continue;
    }

    // Collide vs enemies
    let candidates = null;
    try { candidates = queryRadius(p.mesh.position, PROJ_HIT_RADIUS); } catch (_) { candidates = null; }
    if (candidates && candidates.length > 0) {
      let killed = false;
      let didSplit = false;
      for (const enemy of candidates) {
        if (!enemy || !enemy.alive) continue;
        if (p.hit.has(enemy)) continue;
        damageEnemy(enemy, p.dmg, p.ownerWeapon || 'autoaim');
        p.hit.add(enemy);

        // Glasswind: on the first hit, fork into 2 perpendicular ice shards that
        // each pierce 1 enemy for 50% damage. Guard with `noSplit` so shards
        // themselves don't recursively split.
        if (p.splitOnHit && !p.noSplit && !didSplit) {
          try { spawnGlasswindShards(p.mesh.position, p.vel, p.dmg); } catch (_) {}
          didSplit = true;
          p.splitOnHit = false;
        }

        p.pierce -= 1;
        if (p.pierce <= 0) {
          disposeProjectile(p, scene);
          list.splice(i, 1);
          killed = true;
          break;
        }
      }
      if (killed) continue;
    }

    // iter 33u — sync InstancedMesh slot to current proj position.
    syncProjectileVisuals(p);
  }
  flushProjectileVisuals();
}

function disposeProjectile(p, scene) {
  releaseProjectileVisuals(p);
}

/**
 * Returns up to N level-up choices for weapons only.
 * Each choice: { kind:'weapon', id, level: nextLevel }.
 * Passives are handled elsewhere (xp.js).
 */
// Endgame fillers shown when all weapons are maxed — prevents empty level-up modals.
const FILLERS = [
  { kind: 'filler', id: 'heal',     name: 'Field Rations', desc: 'Restore 40 HP', icon: '🍞' },
  { kind: 'filler', id: 'maxhp',    name: 'Iron Resolve',  desc: '+25 Max HP',    icon: '❤️' },
  { kind: 'filler', id: 'speed',    name: 'Swift Boots',   desc: '+10% Move Speed', icon: '👟' },
  { kind: 'filler', id: 'magnet',   name: 'Magnet',        desc: '+60% Pickup Radius', icon: '🧲' },
  { kind: 'filler', id: 'cooldown', name: 'Focus',         desc: '-8% Cooldown',  icon: '⏱️' },
  { kind: 'filler', id: 'damage',   name: 'Sharpened',     desc: '+10% Damage',   icon: '⚔️' },
  { kind: 'filler', id: 'zoomout',  name: 'Bigger Picture',desc: 'Unlock one more zoom-out step', icon: '🔍' },
  { kind: 'filler', id: 'dash',     name: 'Charge Dash',   desc: 'SHIFT to dash + knock back enemies (each pick = stronger)', icon: '💨' },
];

export function weaponChoices(n) {
  const ids = Object.keys(REGISTRY);
  const owned = new Map(state.weapons.map(w => [w.id, w]));
  const pool = [];

  // 1) Evolutions: highest priority. Show as 'evolution' kind.
  for (const baseId of Object.keys(EVOLUTIONS)) {
    if (_isEvolutionEligible(baseId)) {
      const evo = EVOLUTIONS[baseId];
      pool.push({
        kind: 'evolution', id: baseId, level: 'EVO',
        name: evo.name, icon: evo.icon, desc: evo.desc,
      });
    }
  }

  for (const id of ids) {
    const mod = REGISTRY[id];
    // FE-C1B: hidden weapons (Forest specials, slot 5) never appear in the
    // level-up card pool — they're equipped automatically per meta unlock.
    if (mod && mod.hidden) continue;
    const have = owned.get(id);
    if (have) {
      if (have.level < mod.maxLevel) {
        pool.push({ kind: 'weapon', id, level: have.level + 1 });
      }
    } else {
      pool.push({ kind: 'weapon', id, level: 1 });
    }
  }

  // Mix in named passives. Up to 2 of the 3 cards can be passives if the
  // player has open slots / leveling room.
  try {
    const passives = passiveChoices(2);
    for (const p of passives) pool.push(p);
  } catch (_) {}

  // Shuffle the full pool (weapons + passives + evolutions).
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }

  // Always pad with fillers so the modal never has fewer than n cards.
  if (pool.length < n) {
    const zoomMaxed = getMaxZoomNotch() >= getZoomNotchCount() - 1;
    const dashMaxed = state.hero.dashLevel >= 5;   // matches DASH.levels[1..5]
    const available = FILLERS.filter(f =>
      !(f.id === 'zoomout' && zoomMaxed) &&
      !(f.id === 'dash' && dashMaxed)
    );
    const shuffled = [...available].sort(() => Math.random() - 0.5);
    for (const f of shuffled) {
      if (pool.length >= n) break;
      pool.push({ kind: 'filler', id: f.id, level: 1, name: f.name, desc: f.desc, icon: f.icon });
    }
  }
  return pool.slice(0, n);
}

// Tracks which evolutions have been announced this run so we don't repeat the banner.
const _announcedEvos = new Set();
export function _resetEvoAnnouncements() { _announcedEvos.clear(); }

/** Apply a non-weapon filler choice. Called by xp.js applyLevelUpChoice. */
export function applyFiller(choice) {
  const h = state.hero;
  switch (choice.id) {
    case 'heal':     h.hp = Math.min(h.hp + 40, h.hpMax); break;
    case 'maxhp':    h.hpMax += 25; h.hp += 25; break;
    case 'speed':    h.statMul.moveSpeed *= 1.10; break;
    case 'magnet':   h.statMul.magnet    *= 1.60; break;
    case 'cooldown': h.statMul.cooldown  *= 0.92; break;
    case 'damage':   h.statMul.dmg       *= 1.10; break;
    case 'zoomout':  unlockZoomLevel(); break;
    case 'dash':
      h.dashUnlocked = true;
      h.dashLevel = Math.min((h.dashLevel || 0) + 1, 5);
      break;
  }
  // Track the pick for evolution eligibility
  if (h.fillerCounts && choice.id in h.fillerCounts) {
    h.fillerCounts[choice.id] = (h.fillerCounts[choice.id] || 0) + 1;
  }
  // Announce any evolution that just became eligible
  _announceEligibleEvolutions();
}

/** Public hook: callers like enemies.js (mini-boss kill) can poke evolution
 *  eligibility re-check. Idempotent — _announcedEvos guards against re-banner. */
export function checkEvolutionEligibility() { _announceEligibleEvolutions(); }

function _announceEligibleEvolutions() {
  for (const baseId of Object.keys(EVOLUTIONS)) {
    if (_announcedEvos.has(baseId)) continue;
    if (_isEvolutionEligible(baseId)) {
      _announcedEvos.add(baseId);
      const evo = EVOLUTIONS[baseId];
      // Persist this evolution as discovered in the meta Grimoire
      import('../meta.js').then(({ discoverEvolution }) => discoverEvolution(evo.id));
      import('../ui.js').then(({ showBanner }) => {
        showBanner(`★ EVOLUTION READY: ${evo.name.toUpperCase()}`, 3.5, '#ffe14a');
      });
      state.fx.bloomBoost = 1.0;
    }
  }
}

// ── Evolutions ───────────────────────────────────────────────────────────────
// When a weapon is maxed AND the corresponding filler has been picked enough,
// an EVOLUTION choice appears. Picking it stamps `inst.evolved = true` and
// the weapon's tick reads that flag to apply a permanent boost.
export const EVOLUTIONS = {
  orbitals: {
    id: 'toxic_halo',
    requires: { filler: 'magnet', count: 3 },
    name: 'Toxic Halo',
    icon: '☠️',
    desc: 'Orbitals deal 2.5× damage and apply 1s poison DoT to anything they touch',
  },
  chain: {
    id: 'storm',
    requires: { filler: 'cooldown', count: 3 },
    name: 'Storm',
    icon: '🌩️',
    desc: 'Chain fires every 0.3s with +3 chains and 2× damage',
  },
  autoaim: {
    id: 'glasswind',
    requires: { passive: 'echo' },
    name: 'Glasswind',
    icon: '🪟',
    desc: 'Volleys fire 50% more projectiles; bullets split into two ice shards on first hit',
  },
  web: {
    id: 'sanctum',
    requires: { passive: 'steadfast' },
    name: 'Sanctum',
    icon: '✨',
    desc: 'Webs burn enemies inside them; you take 30% less damage while standing in any web',
  },
  // Dash isn't a REGISTRY weapon — eligibility/application has a dedicated
  // branch keyed on the literal id 'dash'. Trigger: dashLevel maxed (5) AND
  // 5 mini-boss kills this run. Kept idempotent via state.hero.dashEvolved.
  dash: {
    id: 'mirror_step',
    requires: { dashLevel: 5, miniBossKills: 5 },
    name: 'Mirror Step',
    icon: '👥',
    desc: 'Dash leaves a magenta ghost twin that fires an orbital burst; dash cooldown −25%',
  },
};

function _isEvolutionEligible(weaponId) {
  const evo = EVOLUTIONS[weaponId];
  if (!evo) return false;
  const req = evo.requires || {};

  // Dash evolution: not a REGISTRY weapon — check run-state directly.
  if (weaponId === 'dash') {
    const h = state.hero;
    if (!h.dashUnlocked) return false;
    if (h.dashEvolved) return false;
    if ((h.dashLevel || 0) < (req.dashLevel || 0)) return false;
    const kills = (state.run && state.run.miniBossKills) || 0;
    if (kills < (req.miniBossKills || 0)) return false;
    return true;
  }

  const owned = state.weapons.find(w => w.id === weaponId);
  if (!owned) return false;
  const mod = REGISTRY[weaponId];
  if (!mod || owned.level < mod.maxLevel) return false;
  if (owned.inst && owned.inst.evolved) return false; // already done

  if (req.filler) {
    const have = (state.hero.fillerCounts && state.hero.fillerCounts[req.filler]) || 0;
    if (have < (req.count || 1)) return false;
  }
  if (req.passive) {
    const passives = state.passives || [];
    const havePassive = passives.find(p => p.id === req.passive);
    if (!havePassive || havePassive.level < (req.passiveLevel || 1)) return false;
  }
  return true;
}

export function applyEvolution(weaponId) {
  if (weaponId === 'dash') {
    const h = state.hero;
    if (h.dashEvolved) return;
    h.dashEvolved = true;
    state.fx.bloomBoost = 1.0;
    state.fx.shake = Math.max(state.fx.shake || 0, 0.5);
    _fireAscensionFx();
    import('../ui.js').then(({ tryAchievement }) => tryAchievement('first_evolution'));
    const evoDef = EVOLUTIONS.dash;
    if (evoDef) try { import('../codex.js').then(({ notifyEvolutionAchieved }) => notifyEvolutionAchieved(evoDef.id)); } catch (_) {}
    return;
  }
  const owned = state.weapons.find(w => w.id === weaponId);
  if (!owned) return;
  if (!owned.inst) owned.inst = {};
  owned.inst.evolved = true;
  state.fx.bloomBoost = 1.0;
  state.fx.shake = Math.max(state.fx.shake || 0, 0.5);
  _fireAscensionFx();
  import('../ui.js').then(({ tryAchievement }) => tryAchievement('first_evolution'));
  const evoDef = EVOLUTIONS[weaponId];
  if (evoDef) try { import('../codex.js').then(({ notifyEvolutionAchieved }) => notifyEvolutionAchieved(evoDef.id)); } catch (_) {}
}

/**
 * Ascension Evolution FX hook (Punch List #1, 2026-05-16). Called from both
 * branches of applyEvolution (regular weapon + dash). Fires the 1.2s burst
 * + 30s rim, plays the SFX bouquet, and stamps the per-run state flag.
 *
 * Dynamic import + try/catch keep the evolution flow defensive: if the FX
 * module fails to load (e.g. test harness without three.js), the evolution
 * itself still applies cleanly.
 */
function _fireAscensionFx() {
  state.run.hasEvolvedThisRun = true;
  const heroMesh = state.hero && state.hero.mesh;
  const scene = heroMesh && heroMesh.parent;
  const pos = state.hero && state.hero.pos;
  const stageId = state.run && state.run.stage && state.run.stage.id;
  if (scene && pos) {
    import('../fx/evolveBurst.js').then(({ spawnEvolveBurst }) => {
      try { spawnEvolveBurst(scene, pos, stageId); } catch (_) {}
    }).catch(() => {});
  }
  // SFX bouquet — existing crystalShatter + new evolutionChime (no-op
  // until the audio file lands, per audio.js _play() drop-on-missing-bank).
  import('../audio.js').then(({ sfx }) => {
    try { sfx.crystalShatter && sfx.crystalShatter(); } catch (_) {}
    try { sfx.evolutionChime && sfx.evolutionChime(); } catch (_) {}
  }).catch(() => {});
}
