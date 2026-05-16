/**
 * Cinder Ballistas — discrete interactable entity (PREFLIGHT STUB).
 *
 * This file is the stub contract for the Phase-2 Cinder Ballistas Agent.
 * The agent fills in geometry, FX, and the tick state machine; this
 * preflight commits the public API surface, tuning constants, palette,
 * and module-level state shape so parallel agents (Decor, Audio,
 * Hazards) can plan against a stable interface.
 *
 * Contract: docs/CINDER_VISUAL_STYLE.md §"Ballista Turret Spec —
 * Repair + Auto-Fire Interaction Contract".
 *
 * Public API:
 *   loadCinderBallistas(scene, hotspotsUrl?)
 *     — spawn entities from JSON, return count. Mirrors
 *       loadForestAmber / loadTwilightFountains shape.
 *   tickCinderBallistas(dt, state)
 *     — per-frame: repair-timer + cancel-radius check, auto-fire loop,
 *       bolt projectile motion + pierce damage, FX lifecycles.
 *   clearCinderBallistas(scene)
 *     — dispose all entities + in-flight bolts + FX.
 *
 * Hotspot JSON: [{ x, z, scale, seed, facing }]
 *               (see assets/cinder_ballista_hotspots.json)
 *               `facing` = initial bolt-cradle yaw in radians where
 *               0 = +X axis. Decor Agent computes facing so the cradle
 *               points from the ballista back toward the play center
 *               (i.e. atan2(-z, -x) — bolts fire INTO the play ring
 *               where enemies path).
 *
 * === PERSISTENCE MODEL (LOCKED): per-entity activation flag ===
 * Activation state lives on each ballista entity:
 *     b.activated = true
 * NOT on state.run. Rationale per docs/CINDER_VISUAL_STYLE.md
 * §Ballista Turret Spec step 9:
 *   - Ballistas are per-entity, not a global buff. There is no single
 *     "ballista active" flag that would meaningfully live on
 *     state.run — every turret tracks its own lifecycle independently.
 *   - Stage teardown (clearCinderBallistas) wipes _ballistas, which
 *     wipes activation state alongside it. No leakage across runs.
 *   - Avoids the "publish-and-read" pattern overhead used for
 *     fountainSpeedBuff / forestSlowZones — those exist because hero.js
 *     and enemies.js need to read those flags from outside the entity
 *     module. Nothing outside cinderBallistas.js needs to read a
 *     ballista's activation state; bolts come out as projectiles that
 *     enemies.js sees through damageEnemy().
 * ============================================================
 *
 * === BOLT DAMAGE HOOK (LOCKED): damageEnemy() with source tag ===
 * Bolts call:
 *     damageEnemy(enemy, BOLT_DAMAGE_BASE, 'ballista_turret')
 * mirroring the forest_amber source-tag pattern in forestAmber.js. Any
 * future passive system that wants to scale ballista damage can filter
 * on `source === 'ballista_turret'` in the damage pipeline. This keeps
 * the stub forward-compatible without a refactor.
 * ============================================================
 *
 * Palette (8-color cinder, locked — see docs/CINDER_VISUAL_STYLE.md):
 *   slot 1 #0a0604 — charred black (chassis silhouette, broken/idle)
 *   slot 2 #3a342f — ash gray (stone fittings)
 *   slot 3 #7a3d1a — rust orange dim (corroded metal bands)
 *   slot 5 #d4c4a8 — ash white (chassis highlights)
 *   slot 7 #ffd24a — ballista active glow (chassis pulse + bolt color)
 *   slot 8 #ffb86b — repair progress aura ring (slot-8 warm gold)
 *
 * Slot 4 (#ff5522 ember orange) and slot 6 (#5a1810 dried blood) are
 * NOT used by ballista entities directly — those belong to the Decor
 * Agent (ember accents on catapults, crater interiors) and the
 * existing Eruption lava system.
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from './postfx.js';
// Phase-2 will need damageEnemy + queryRadius for the bolt pierce pass.
// Import surface declared here so the contract is visible at preflight;
// stub functions don't call them yet.
// eslint-disable-next-line no-unused-vars
import { damageEnemy, queryRadius } from './enemies.js';
// eslint-disable-next-line no-unused-vars
import { sfx } from './audio.js';

// ─── module state ─────────────────────────────────────────────────────────────
// Per-entity ballista records. Shape (Phase-2 fills in mesh/material refs):
//   {
//     x, z, scale, seed, facing,
//     state: 'broken' | 'repairing' | 'activated',
//     activated: boolean,           // LOCKED: per-entity flag, NOT state.run
//     repairTimer: number,          // 0..REPAIR_DURATION while repairing
//     fireTimer: number,            // 0..BOLT_INTERVAL while activated
//     cradleYaw: number,            // current bolt-cradle yaw (radians)
//     entGroup, chassisMesh, cradleMesh, chassisMat, repairAura,
//     pulsePhase,                   // desync activated-glow pulse across the field
//     rng,                          // seeded PRNG for deterministic FX
//   }
const _ballistas = [];

// In-flight bolt projectiles. Shape (Phase-2 fills in mesh refs):
//   {
//     x, z, vx, vz,                 // current position + velocity (world units)
//     spawnX, spawnZ,               // origin for range check
//     ownerSeed,                    // tag for debug only
//     hitSet,                       // Set<enemyId> already pierced (prevent
//                                   // multi-hit per-tick on a single enemy)
//     mesh, mat, geo,               // bolt visual
//   }
const _activeBolts = [];

// Geometries + materials tracked for dispose in clearCinderBallistas.
const _disposables = [];

// Cached hotspot data (debug + idempotency).
let _hotspotsLoaded = null;

// Parent Group added to scene — single removal target.
let _group = null;

// ─── tuning constants (LOCKED per docs/CINDER_VISUAL_STYLE.md) ────────────────
// Repair window: 10s commitment, must stay within 3.0u cancel-radius.
export const REPAIR_DURATION = 10.0;     // s
export const PROXIMITY_R = 1.5;          // drink-trigger / repair-start radius
export const PROXIMITY_R2 = PROXIMITY_R * PROXIMITY_R;
export const REPAIR_CANCEL_R = 3.0;      // must stay within this during repair
export const REPAIR_CANCEL_R2 = REPAIR_CANCEL_R * REPAIR_CANCEL_R;

// Auto-fire loop while activated.
export const BOLT_INTERVAL = 2.0;        // s between bolts
export const BOLT_SPEED = 80.0;          // world units / s
export const BOLT_LENGTH = 30.0;         // visual cylinder length (u)
export const BOLT_RADIUS = 0.15;         // visual cylinder radius (u)
export const BOLT_MAX_RANGE = 30.0;      // despawn distance (u)
export const BOLT_DAMAGE_BASE = 45;      // per pierce
// BOLT_PIERCE = Infinity: bolt pierces ALL enemies in its 30u path.
// Future weapon-pierce-cap systems may demote this to a finite cap; for
// now the spec is "massive piercing bolts" with no cap.
export const BOLT_PIERCE = Infinity;

// Cradle scanning rotation rate (radians/s) while activated.
export const CRADLE_YAW_RATE = 2.0;

// Idle (broken) emissive: 0. Activated emissive pulse band + frequency.
export const ACTIVATED_EMISSIVE_MIN = 1.4;
export const ACTIVATED_EMISSIVE_MAX = 2.0;
export const ACTIVATED_PULSE_HZ = 0.4;
// Single-frame activation flash on slot 7.
export const ACTIVATION_FLASH_EMISSIVE = 3.5;

// Repair aura ring tuning (slot 8, additive bloom).
export const REPAIR_AURA_RADIUS = 0.9;   // fixed inner radius
export const REPAIR_AURA_LINE_WIDTH = 0.07;
export const REPAIR_AURA_OPACITY_MIN = 0.4;   // ramp 0.4 → 1.0 over 10s
export const REPAIR_AURA_OPACITY_MAX = 1.0;

// ─── palette color constants (cinder, locked) ─────────────────────────────────
export const COLOR_CHARRED_BLACK = 0x0a0604;   // slot 1
export const COLOR_ASH_GRAY      = 0x3a342f;   // slot 2
export const COLOR_RUST_ORANGE   = 0x7a3d1a;   // slot 3
export const COLOR_ASH_WHITE     = 0xd4c4a8;   // slot 5
export const COLOR_BALLISTA_GLOW = 0xffd24a;   // slot 7 — chassis + bolt
export const COLOR_REPAIR_AURA   = 0xffb86b;   // slot 8 — repair ring

// ─── seeded PRNG (mirrors forestAmber.js + twilightFountains.js) ──────────────
// eslint-disable-next-line no-unused-vars
function _seededRand(seed) {
  let s = (seed >>> 0) || 1;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── public: load ─────────────────────────────────────────────────────────────
/**
 * Fetch hotspot JSON and spawn ballista entities into the scene.
 *
 * PREFLIGHT STUB: fetches + parses JSON, populates `_hotspotsLoaded`,
 * and returns the count. Phase-2 Ballistas Agent fills in:
 *
 *   TODO(phase-2): build chassis BufferGeometry (merged hex-prism base
 *     + tapered cradle beam + bolt-cradle pivot). Flat-shading on
 *     slot-1 diffuse with slot-3 rust-orange metal-band accents,
 *     slot-5 ash-white chassis highlights.
 *   TODO(phase-2): per-entity MeshStandardMaterial so emissive can be
 *     independently lerped during activated pulse (slot-7 glow band
 *     1.4 ↔ 2.0 at 0.4 Hz) — 4-6 mats is well inside the budget.
 *   TODO(phase-2): per-entity Group with chassisMesh, cradleMesh
 *     (separate so it can yaw-scan toward enemies), no light needed
 *     for idle state (broken = dark).
 *   TODO(phase-2): push to _ballistas with state='broken',
 *     activated=false, repairTimer=0, fireTimer=0, cradleYaw=facing.
 *   TODO(phase-2): track shared geos/mats in _disposables for clear().
 */
export async function loadCinderBallistas(scene, hotspotsUrl = 'assets/cinder_ballista_hotspots.json') {
  if (!scene) return 0;
  // Idempotent: tear down any prior ballista group before rebuilding.
  clearCinderBallistas(scene);

  let hotspots = null;
  try {
    const res = await fetch(hotspotsUrl);
    hotspots = await res.json();
  } catch (e) {
    console.warn('[cinderBallistas] hotspot fetch failed:', e);
    return 0;
  }
  if (!Array.isArray(hotspots) || hotspots.length === 0) return 0;
  _hotspotsLoaded = hotspots;

  // Reserved for the Phase-2 build: scene-parent group identical to
  // _forestAmber / _twilightFountains layout. Created here so the
  // teardown branch in clearCinderBallistas has a stable target.
  _group = new THREE.Group();
  _group.name = '__cinderBallistas';
  scene.add(_group);

  // TODO(phase-2): for each hotspot, build entGroup + meshes + push to
  //   _ballistas. See JSDoc above for the per-entity shape.
  // For now we return the count of hotspots accepted so callers can log
  // "loaded N ballista hotspots" — actual entity count will match once
  // Phase-2 lands.
  return hotspots.length;
}

// ─── public: tick ────────────────────────────────────────────────────────────
/**
 * Per-frame ballista update. PREFLIGHT STUB: no-op.
 *
 * Phase-2 Ballistas Agent fills in the state machine:
 *
 *   TODO(phase-2): for each ballista b in _ballistas:
 *
 *     if (b.state === 'broken'):
 *       — Proximity check vs state.hero.pos using PROXIMITY_R2.
 *       — If hero within and alive, transition to 'repairing' with
 *         b.repairTimer = 0 and spawn the slot-8 repair aura ring
 *         (RingGeometry, AdditiveBlending, bloom ON, opacity ramps
 *         REPAIR_AURA_OPACITY_MIN → MAX linearly over REPAIR_DURATION).
 *       — Start sfx.ballistaRepairLoop().
 *
 *     if (b.state === 'repairing'):
 *       — Cancel check: if hero distance > REPAIR_CANCEL_R, reset
 *         b.repairTimer = 0, transition back to 'broken', dispose
 *         the aura ring, stop the repair-loop SFX. Spec is RESET, not
 *         pause — the 10s commitment must be paid in full.
 *       — Otherwise b.repairTimer += dt and update aura opacity.
 *       — If b.repairTimer >= REPAIR_DURATION, transition to
 *         'activated': set b.activated = true (per-entity, NOT
 *         state.run), flash chassis emissive to ACTIVATION_FLASH_EMISSIVE
 *         on COLOR_BALLISTA_GLOW for one frame, play
 *         sfx.ballistaActivate(), reset b.fireTimer = 0, dispose aura.
 *
 *     if (b.state === 'activated'):
 *       — Pulse chassis emissive ACTIVATED_EMISSIVE_MIN ↔ MAX at
 *         ACTIVATED_PULSE_HZ on COLOR_BALLISTA_GLOW.
 *       — Scan cradle yaw toward nearest enemy (use queryRadius if
 *         spatial index is live, else iterate state.enemies.active).
 *         Clamp yaw delta per tick to CRADLE_YAW_RATE * dt.
 *       — b.fireTimer += dt; if >= BOLT_INTERVAL: spawn a bolt
 *         projectile aimed along the current cradle yaw, reset
 *         b.fireTimer = 0, play sfx.ballistaFire().
 *
 *   TODO(phase-2): for each bolt p in _activeBolts:
 *
 *     — p.x += p.vx * dt; p.z += p.vz * dt; p.mesh.position update.
 *     — Range check: if hypot(p.x - p.spawnX, p.z - p.spawnZ) > BOLT_MAX_RANGE,
 *       dispose bolt and splice from array.
 *     — Pierce damage scan: queryRadius around (p.x, p.z) with
 *       BOLT_RADIUS + a small epsilon, for each enemy not in p.hitSet,
 *       call damageEnemy(enemy, BOLT_DAMAGE_BASE, 'ballista_turret')
 *       and add enemy id to p.hitSet. BOLT_PIERCE = Infinity, so no
 *       cap on hits per bolt.
 *
 *   Note: bolt visuals are slot-7 emissive cylinders with bloom ON.
 *   Build orientation: cylinder axis = bolt velocity direction;
 *   easiest is a Mesh wrapped in a Group with the group rotated to
 *   match atan2(vz, vx) at spawn time.
 */
// eslint-disable-next-line no-unused-vars
export function tickCinderBallistas(dt, state) {
  // PREFLIGHT STUB: no-op. Phase-2 Ballistas Agent implements the
  // state machine described in the JSDoc above. Safe to call from
  // the main loop before Phase-2 lands — does nothing, returns nothing.
}

// ─── public: clear ───────────────────────────────────────────────────────────
/**
 * Tear down all ballista entities, in-flight bolts, and FX.
 * Idempotent — safe to call multiple times.
 *
 * PREFLIGHT STUB: removes _group from scene + nulls module state.
 * Phase-2 Ballistas Agent fills in:
 *
 *   TODO(phase-2): for each ballista in _ballistas: dispose
 *     entity-owned materials (per-entity emissive chassis mat), and
 *     any active repair-aura RingGeometry + Material.
 *   TODO(phase-2): for each bolt in _activeBolts: remove mesh from
 *     scene, dispose bolt mat + geo.
 *   TODO(phase-2): no state.run cleanup needed — per-entity model
 *     means there's no global flag to null (contrast with
 *     twilightFountains' state.run.fountainSpeedBuff cleanup).
 */
export function clearCinderBallistas(scene) {
  // Remove the parent group + dispose tracked geos/mats.
  if (_group) {
    if (scene && _group.parent === scene) scene.remove(_group);
    else if (_group.parent) _group.parent.remove(_group);
    _group = null;
  }
  for (const d of _disposables) { try { d.dispose && d.dispose(); } catch (_) {} }
  _disposables.length = 0;

  _ballistas.length = 0;
  _activeBolts.length = 0;
  _hotspotsLoaded = null;
}

// ─── debug exports (mirror forestAmber.js + twilightFountains.js) ─────────────
export function _debugBallistas() { return _ballistas.slice(); }
export function _debugActiveBolts() { return _activeBolts.slice(); }
export function _debugHotspots() { return _hotspotsLoaded; }
