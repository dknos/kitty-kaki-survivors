/**
 * Trap Corridor — stage-agnostic "env damage that hurts enemies too" hazard.
 *
 * Spec (FOREST ITER C2):
 *   Each corridor is a sequence of small fixed-position damage zones (shards,
 *   spore vents, vine snaps, etc — variant-driven). Per-trap state machine:
 *
 *     idle → telegraph (1.2s warning) → active (0.3s damage frame) →
 *            cooldown (2.5s rest) → idle (loops)
 *
 *   During `active`: any entity inside `radius` takes damage.
 *     - hero       : 8 hp (relies on existing hero iFrames gate in hero.js)
 *     - trash enemy: 9999 (lethal — damageEnemy clamps to current hp)
 *     - elite enemy: 25% of enemy.hpMax
 *
 *   The "hurts swarms too" is the gameplay hook — kite mobs through the lane
 *   and the env thins them for you.
 *
 *   v1 has no reward/clear condition; the corridor is permanent stage flavor +
 *   a tactical kiting lane. State on `state.run.trapCorridorActive` (bool) so
 *   spawn/UI readers don't have to iterate the corridor list.
 *
 * Stage-agnostic by design — Forest is the first consumer but any stage can:
 *   import { armCorridor } from './trapCorridor.js';
 *   armCorridor({
 *     id: 'forest-shard-lane-north',
 *     points: [ { x, z, radius }, ... ],
 *     variant: 'shard',
 *     paletteSlots: { idle, telegraph, active },
 *   });
 *
 * Pre-pool contract — per the InstancedMesh + pre-pool pattern proven in
 * dissolveBurst.js / ribbonTrail.js / bossTelegraphs.js / lockdownArena.js:
 * shard mesh + telegraph ring + impact burst ring are ALL allocated at
 * armCorridor time, NEVER per trigger. tickTrapCorridor only mutates
 * visibility / scale / position / emissive / opacity — ZERO allocation in
 * the hot path.
 *
 * Hot-path damage MUST use static imports (per perf-fix 9509535 contract in
 * src/enemies.js — dynamic `import().then()` in per-frame hot paths queues
 * Promise microtasks and tanks FPS during big-salvo events). Each
 * damageEnemy / takeDamage call is wrapped in try/catch so a damage-system
 * fault doesn't blow up the trap tick.
 *
 * lowFx handling: when state.run.lowFx is true the telegraph ring and impact
 * shockwave burst are skipped (downgraded to a flat emissive flash on the
 * shard mesh). Damage logic still runs — the kill-switch is purely cosmetic.
 */
import * as THREE from 'three';
import { state } from './state.js';
import { BLOOM_LAYER } from './postfx.js';
import { damageEnemy } from './enemies.js';
import { takeDamage as heroTakeDamage } from './hero.js';

// ─── module state ─────────────────────────────────────────────────────────────
/** @type {THREE.Scene|null} */
let _scene = null;

/**
 * Registered corridors. Each entry:
 *   {
 *     id,
 *     variant,                        // 'shard' (Forest v1; future: 'vine','spore')
 *     paletteSlots: { idle, telegraph, active },
 *     traps: [ trap, ... ],
 *     group: THREE.Group,
 *   }
 * Each trap:
 *   {
 *     center: { x, z },
 *     radius,
 *     phase: 'idle' | 'telegraph' | 'active' | 'cooldown',
 *     phaseT: 0,                      // seconds elapsed in current phase
 *     shardMesh,                      // octahedron
 *     telegraphRing,                  // RingGeometry plane (BLOOM_LAYER)
 *     impactRing,                     // RingGeometry plane (BLOOM_LAYER) — slot 8 shockwave
 *     enemyHits: Set<enemyRef>,       // mobs damaged this active frame (avoid 60×/sec)
 *   }
 */
const _corridors = [];

// ─── tuning constants ─────────────────────────────────────────────────────────
const TELEGRAPH_SEC  = 1.2;
const ACTIVE_SEC     = 0.3;
const COOLDOWN_SEC   = 2.5;
const SHARD_HOVER_Y  = 0.85;
const SHARD_SLAM_Y   = 0.10;
const SHARD_SLAM_DURATION = 0.10;        // first 0.10s of active phase: slam to ground
const SHARD_HEIGHT   = 0.6;              // overall shard height (octahedron radius * 2)
const SHARD_RADIUS   = SHARD_HEIGHT / 2; // octahedron radius (0.3u)
const RING_LINE_WEIGHT = 0.08;           // line weight per FOREST_VISUAL_STYLE.md (0.06-0.10 range)
const TELEGRAPH_PULSE_HZ = 1.8;          // bio-glow ring pulse during telegraph
const IDLE_PULSE_HZ = 0.5;               // gentle idle pulse on shard emissive
const HERO_DMG       = 8;
const TRASH_DMG      = 9999;             // lethal vs trash; damageEnemy clamps to current hp
const ELITE_DMG_PCT  = 0.25;             // elites take 25% of max hp per trigger

// ─── per-trap pool builders ───────────────────────────────────────────────────
// Build all 3 meshes for a single trap. Called from armCorridor; never re-runs.
function _buildShardMesh(paletteSlots) {
  // Small octahedron — flatShading honored on Lambert so facets read crisp
  // under bloom (matches FOREST_VISUAL_STYLE.md crystal-facet contract).
  const geo = new THREE.OctahedronGeometry(SHARD_RADIUS, 0);
  const mat = new THREE.MeshLambertMaterial({
    color: paletteSlots.active,        // slot-3 pale cyan-steel
    emissive: paletteSlots.telegraph,  // slot-4 bio-glow mint
    emissiveIntensity: 0.6,
    transparent: false,
    flatShading: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.kind = 'trapShard';
  // Shard itself does NOT bloom (decor); only the telegraph + impact rings do.
  return mesh;
}

function _buildRingMesh(radius, hexColor) {
  // Thin ring: inner = radius - lineWeight, outer = radius. Pre-rotated flat.
  // Use plane-base RingGeometry: 32 segs is plenty for a 1-2u radius ring.
  const inner = Math.max(0.02, radius - RING_LINE_WEIGHT);
  const outer = radius;
  const geo = new THREE.RingGeometry(inner, outer, 32);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: hexColor,
    transparent: true,
    opacity: 0.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.layers.enable(BLOOM_LAYER); // ring is bloom-tagged per spec
  mesh.visible = false;
  return mesh;
}

// ─── per-frame: trap state machine ────────────────────────────────────────────
function _tickTrap(trap, dt, corridor, hero, enemies, lowFx) {
  trap.phaseT += dt;

  const palette = corridor.paletteSlots;

  if (trap.phase === 'idle') {
    // Idle: shard hovers at SHARD_HOVER_Y, dim emissive pulse, rings hidden.
    trap.shardMesh.position.y = SHARD_HOVER_Y;
    // Gentle pulse so the trap is "alive" but clearly dormant.
    const t = state.time.real;
    const ePhase = (Math.sin(t * Math.PI * 2 * IDLE_PULSE_HZ) + 1) * 0.5;
    trap.shardMesh.material.emissiveIntensity = 0.45 + 0.25 * ePhase;
    // Dormant tint: idle slot color via material.color (charcoal). Stay subtle.
    trap.shardMesh.material.color.setHex(palette.idle);
    if (trap.telegraphRing.visible) trap.telegraphRing.visible = false;
    if (trap.impactRing.visible) trap.impactRing.visible = false;

    // Advance to telegraph immediately — idle phase is the "just transitioned
    // out of cooldown" instant. Real waiting happens in cooldown.
    trap.phase = 'telegraph';
    trap.phaseT = 0;
    return;
  }

  if (trap.phase === 'telegraph') {
    // Telegraph window: bright pulsing ring + brighter shard emissive so the
    // player has CLEAR visual warning before damage lands.
    const k = trap.phaseT / TELEGRAPH_SEC;   // 0..1 progress
    // Shard ramps from dim → bright over telegraph window.
    const eShard = 0.6 + 2.2 * Math.min(1, k * 1.2); // 0.6 → 2.8
    trap.shardMesh.material.emissiveIntensity = eShard;
    trap.shardMesh.material.color.setHex(palette.telegraph);
    trap.shardMesh.position.y = SHARD_HOVER_Y; // still hovering

    if (!lowFx) {
      // Pulsing ring on slot-4 bio-glow mint (additive, bloom).
      trap.telegraphRing.visible = true;
      const t = state.time.real;
      const pulse = (Math.sin(t * Math.PI * 2 * TELEGRAPH_PULSE_HZ) + 1) * 0.5; // 0..1
      // Opacity ramps from 0.35 → 0.95 over the window so the warning gets
      // visually louder as detonation approaches.
      const baseOpacity = 0.35 + 0.50 * k;
      trap.telegraphRing.material.opacity = baseOpacity * (0.65 + 0.35 * pulse);
    } else {
      // lowFx: drop the ring, keep the flat shard pulse only.
      trap.telegraphRing.visible = false;
    }

    if (trap.phaseT >= TELEGRAPH_SEC) {
      trap.phase = 'active';
      trap.phaseT = 0;
      trap.enemyHits.clear();
      // Hide telegraph ring; impact ring will fire below.
      trap.telegraphRing.visible = false;
    }
    return;
  }

  if (trap.phase === 'active') {
    // Active frame: shard slams down over the first SHARD_SLAM_DURATION, then
    // sits at SHARD_SLAM_Y for the rest of the active window. Impact ring
    // expands outward.
    const k = trap.phaseT / ACTIVE_SEC;
    const slamK = Math.min(1, trap.phaseT / SHARD_SLAM_DURATION);
    // Ease-in (accelerating drop) — squared.
    const slamEase = slamK * slamK;
    trap.shardMesh.position.y = SHARD_HOVER_Y + (SHARD_SLAM_Y - SHARD_HOVER_Y) * slamEase;
    // Color: slot-3 pale cyan-steel solid (the actual hazard mesh "at full intensity").
    trap.shardMesh.material.color.setHex(palette.active);
    trap.shardMesh.material.emissiveIntensity = 2.8 * (1 - 0.4 * k); // bright at impact, easing down

    if (!lowFx) {
      // Impact shockwave ring (slot-8 cyan-white): expands 0u → trap.radius
      // over the active window, opacity 1.0 → 0.0 cubic ease-out.
      trap.impactRing.visible = true;
      const scaleK = Math.min(1, k * 1.5); // ring finishes expanding ~2/3 through
      trap.impactRing.scale.setScalar(0.15 + scaleK * 0.95);
      const fadeK = 1 - Math.pow(1 - k, 3);
      trap.impactRing.material.opacity = 1.0 - fadeK;
    } else {
      // lowFx: flat tint flash on the shard, no ring.
      trap.impactRing.visible = false;
    }

    // Damage application — runs EVERY tick during active phase. Hero relies on
    // existing iFramesUntil gate in hero.takeDamage (no per-trap throttle
    // needed). Enemies use per-trap Set so each mob takes damage at most once
    // per active phase (otherwise a stationary mob inside the zone would eat
    // 60 hits/sec at 60fps).
    _applyTrapDamage(trap, hero, enemies);

    if (trap.phaseT >= ACTIVE_SEC) {
      trap.phase = 'cooldown';
      trap.phaseT = 0;
      // Hide impact ring; shard lifts back to hover in cooldown.
      trap.impactRing.visible = false;
    }
    return;
  }

  if (trap.phase === 'cooldown') {
    // Dormant rest. Shard rises back to hover, emissive dim.
    const k = trap.phaseT / COOLDOWN_SEC;
    // Rise from slam Y back to hover Y over the first ~30% of cooldown.
    const riseK = Math.min(1, k / 0.30);
    const riseEase = 1 - Math.pow(1 - riseK, 2);
    trap.shardMesh.position.y = SHARD_SLAM_Y + (SHARD_HOVER_Y - SHARD_SLAM_Y) * riseEase;
    // Fade emissive back to idle.
    trap.shardMesh.material.emissiveIntensity = 0.45 + (2.0 * (1 - Math.min(1, k * 2)));
    trap.shardMesh.material.color.setHex(palette.idle);
    if (trap.telegraphRing.visible) trap.telegraphRing.visible = false;
    if (trap.impactRing.visible) trap.impactRing.visible = false;
    if (trap.phaseT >= COOLDOWN_SEC) {
      trap.phase = 'idle';
      trap.phaseT = 0;
      // Reset enemyHits so next cycle starts fresh.
      trap.enemyHits.clear();
    }
    return;
  }
}

// ─── damage application (hot path; STATIC imports only) ───────────────────────
function _applyTrapDamage(trap, hero, enemies) {
  const cx = trap.center.x;
  const cz = trap.center.z;
  const r2 = trap.radius * trap.radius;

  // Hero — only if alive and inside radius. takeDamage handles its own iFrame
  // gate (state.time.game < h.iFramesUntil), so a hero walking through a long
  // corridor of active traps still won't eat 60 hits/sec.
  if (hero && hero.pos && !state.gameOver) {
    const dx = hero.pos.x - cx;
    const dz = hero.pos.z - cz;
    if (dx * dx + dz * dz <= r2) {
      try { heroTakeDamage(HERO_DMG); }
      catch (e) { console.warn('[trapCorridor] hero takeDamage failed:', e); }
    }
  }

  // Enemies — every tagged-alive enemy inside radius takes (trash) lethal or
  // (elite) 25% of max hp. Each enemy only hit once per active phase
  // (trap.enemyHits Set, cleared on phase exit / next cycle).
  if (!enemies) return;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (!e || !e.alive) continue;
    if (trap.enemyHits.has(e)) continue;
    const ex = (e.mesh && e.mesh.position) ? e.mesh.position.x : (e.pos ? e.pos.x : 0);
    const ez = (e.mesh && e.mesh.position) ? e.mesh.position.z : (e.pos ? e.pos.z : 0);
    const dx = ex - cx;
    const dz = ez - cz;
    if (dx * dx + dz * dz > r2) continue;
    const dmg = e.elite ? Math.max(1, (e.hpMax || 0) * ELITE_DMG_PCT) : TRASH_DMG;
    try {
      damageEnemy(e, dmg, 'trapCorridor');
      trap.enemyHits.add(e);
    } catch (err) {
      console.warn('[trapCorridor] damageEnemy failed:', err);
    }
  }
}

// ─── public API ───────────────────────────────────────────────────────────────
export function initTrapCorridor(scene) {
  _scene = scene;
}

/**
 * Register a corridor. Pre-builds all per-trap meshes (shard + telegraph ring
 * + impact ring) and adds them to the scene at idle position. Returns the
 * corridor id used by future API calls (currently informational only).
 *
 * @param {object} opts
 * @param {string} opts.id                                 Unique corridor id (informational)
 * @param {{x:number, z:number, radius:number}[]} opts.points  Trap positions
 * @param {string} opts.variant                            Visual variant ('shard' for Forest v1)
 * @param {{idle:number, telegraph:number, active:number}} opts.paletteSlots
 *        Hex color numbers (use stage's locked palette slots).
 * @returns {string} corridor id
 */
export function armCorridor(opts) {
  if (!_scene) {
    console.warn('[trapCorridor] armCorridor called before initTrapCorridor');
    return '';
  }
  if (!opts || !Array.isArray(opts.points) || opts.points.length === 0) {
    console.warn('[trapCorridor] armCorridor missing opts.points');
    return '';
  }
  const id = opts.id || `corridor-${_corridors.length + 1}`;
  const paletteSlots = {
    idle:      (opts.paletteSlots && opts.paletteSlots.idle)      || 0x1a1e22,
    telegraph: (opts.paletteSlots && opts.paletteSlots.telegraph) || 0x7df0c4,
    active:    (opts.paletteSlots && opts.paletteSlots.active)    || 0x5f8fb5,
  };
  const variant = opts.variant || 'shard';

  // Slot-8 cyan-white for impact shockwave ring per spec.
  const SHOCKWAVE_HEX = 0xa8e6ff;

  const group = new THREE.Group();
  group.name = `trapCorridor:${id}`;

  const traps = [];
  for (let i = 0; i < opts.points.length; i++) {
    const p = opts.points[i];
    if (!p || typeof p.x !== 'number' || typeof p.z !== 'number') continue;
    const radius = (typeof p.radius === 'number') ? p.radius : 1.6;

    const shard = _buildShardMesh(paletteSlots);
    shard.position.set(p.x, SHARD_HOVER_Y, p.z);

    // Telegraph ring sits flat on the floor (y just above 0 to avoid z-fight).
    const telegraphRing = _buildRingMesh(radius, paletteSlots.telegraph);
    telegraphRing.position.set(p.x, 0.04, p.z);

    // Impact shockwave ring — built at radius=1.0 then scaled. Slot-8.
    const impactRing = _buildRingMesh(1.0, SHOCKWAVE_HEX);
    impactRing.position.set(p.x, 0.05, p.z);
    // Encode the trap's radius into baseline scale so scale=1.0 reaches full radius.
    impactRing.userData.targetRadius = radius;
    impactRing.scale.setScalar(0.15);

    group.add(shard);
    group.add(telegraphRing);
    group.add(impactRing);

    traps.push({
      center: { x: p.x, z: p.z },
      radius,
      // Start in 'idle' so the first cycle telegraphs cleanly (idle → telegraph
      // is one tick later via the immediate-advance in _tickTrap idle branch).
      // Offset phaseT a little per-trap so the 3 traps don't fire in lockstep
      // (player can read each individually, swarms get chewed in waves).
      phase: 'cooldown',
      phaseT: -(i * 0.55), // stagger: trap 0 fires first, trap 2 ~1.1s later
      shardMesh: shard,
      telegraphRing,
      impactRing,
      enemyHits: new Set(),
    });
  }

  _scene.add(group);
  _corridors.push({ id, variant, paletteSlots, traps, group });

  if (state.run) state.run.trapCorridorActive = _corridors.length > 0;

  return id;
}

/**
 * Per-frame tick. Reads `hero` and `enemies` from caller (canonical lists in
 * state.hero / state.enemies.active) so this module stays pure-state-agnostic.
 * Cheap when no corridors are armed.
 *
 * @param {number} dt                  Logic delta seconds
 * @param {object} hero                state.hero
 * @param {object[]} enemies           state.enemies.active
 */
export function tickTrapCorridor(dt, hero, enemies) {
  if (_corridors.length === 0) return;
  // Read lowFx once per tick — short-circuits ring + burst visuals; damage
  // still applies (kill-switch is cosmetic only).
  const lowFx = !!(state.run && state.run.lowFx === true);

  for (let ci = 0; ci < _corridors.length; ci++) {
    const corr = _corridors[ci];
    const traps = corr.traps;
    for (let ti = 0; ti < traps.length; ti++) {
      _tickTrap(traps[ti], dt, corr, hero, enemies, lowFx);
    }
  }
}

/**
 * Run-reset hook: wipe per-trap runtime state (phase timers, enemy-hits sets)
 * but keep the registered corridors + meshes around (cheap; re-armed next run
 * via the stage load* path). Pairs with resetLockdownArenas shape.
 */
export function resetTrapCorridors() {
  for (const corr of _corridors) {
    for (let i = 0; i < corr.traps.length; i++) {
      const trap = corr.traps[i];
      trap.phase = 'cooldown';
      trap.phaseT = -(i * 0.55);
      trap.enemyHits.clear();
      if (trap.shardMesh) {
        trap.shardMesh.position.y = SHARD_HOVER_Y;
        trap.shardMesh.material.emissiveIntensity = 0.6;
        trap.shardMesh.material.color.setHex(corr.paletteSlots.idle);
      }
      if (trap.telegraphRing) {
        trap.telegraphRing.visible = false;
        trap.telegraphRing.material.opacity = 0;
      }
      if (trap.impactRing) {
        trap.impactRing.visible = false;
        trap.impactRing.material.opacity = 0;
        trap.impactRing.scale.setScalar(0.15);
      }
    }
  }
  if (state.run) state.run.trapCorridorActive = _corridors.length > 0;
}

/**
 * Full teardown — removes corridor meshes from scene + disposes
 * geometry/materials. Call from the run-reset path (paired with
 * disposeLockdownArenas / clearForestAmber). Stage-agnostic; safe to call
 * regardless of which stage was active.
 */
export function disposeTrapCorridors(scene) {
  const s = scene || _scene;
  for (const corr of _corridors) {
    if (corr.group) {
      if (corr.group.parent) corr.group.parent.remove(corr.group);
      else if (s) s.remove(corr.group);
    }
    for (const trap of corr.traps) {
      for (const m of [trap.shardMesh, trap.telegraphRing, trap.impactRing]) {
        if (!m) continue;
        if (m.geometry) m.geometry.dispose();
        if (m.material && m.material.dispose) m.material.dispose();
      }
      trap.shardMesh = null;
      trap.telegraphRing = null;
      trap.impactRing = null;
      trap.enemyHits.clear();
    }
    corr.traps.length = 0;
  }
  _corridors.length = 0;
  if (state.run) state.run.trapCorridorActive = false;
}
