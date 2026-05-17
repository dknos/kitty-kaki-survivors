/**
 * Forest Evolution Coffins — VS-staple superweapon unlock chests
 * (FE-V2 Coffins, 2026-05-17).
 *
 * Vampire Survivors' signature mechanic: rare hidden chests scattered in
 * 1-2 forest rooms that, when the player meets dual conditions (kill
 * milestone + base-weapon-Lv8 + paired-passive-Lv5), upgrade a base
 * weapon into a superweapon variant.
 *
 * Lifecycle:
 *   loadForestCoffins(scene, state, rngOverride?) — scatter coffins across
 *     mossroot + glowfen rooms (gated reward — these are the two rooms
 *     farthest from the glade hub). Pre-pools all InstancedMesh.
 *   tickForestCoffins(state, dt) — per-frame: state-machine transitions
 *     (locked → unlockable → opening → opened) + open-burst FX fade.
 *   disposeForestCoffins(scene) — tear down all meshes + clear pool state.
 *
 * State machine per coffin instance:
 *   0 LOCKED      — padlock visible, base + lid visible, faint brown pulse.
 *                   No interaction. Transitions to UNLOCKABLE when the
 *                   player meets the dual-gate condition (any pair).
 *   1 UNLOCKABLE  — padlock hidden, gold sparkle ring spins overhead, lid
 *                   bobs 0.05u. Transitions to OPENING when hero enters
 *                   trigger radius (`TRIGGER_R = 1.1`).
 *   2 OPENING     — lid scales up + tilts 35°, gold pillar burst plays.
 *                   1.2s lifetime. Transitions to OPENED when burst ends.
 *                   On entry, evolution is granted: chosen pair's base
 *                   weapon is REMOVED from kit and evolved is acquired
 *                   (acquireWeapon path — naturally levels if already
 *                   owned). NOTE: We use the ADD alternative documented in
 *                   the FE-V2 brief watch-outs — base weapon stays in kit
 *                   (swap is too invasive). Persists `state.run._coffinsOpened[id]=true`.
 *   3 OPENED      — coffin hides permanently for the run.
 *
 * Spawn rules:
 *   - 1-2 coffins per forest stage. Placed in `mossroot` and/or `glowfen`
 *     (the two new rooms farthest from glade — gating reward).
 *   - Avoids: lockdown arena keep-out (r=10), trap corridor shards (r=3.6
 *     each), all portal posts (r=2), placed landmarks (r=2), bounds inset
 *     3u from room edges. Mirrors the keep-out machinery in
 *     forestLandmarks.js.
 *   - Seeded via `_mulberry32(0xC0FFE9)` — distinct from landmarks
 *     (0xC0FFE8) and earlier decor seeds.
 *
 * Unlock condition (BOTH required, per pair in FOREST_EVOLUTIONS):
 *   - state.run.kills >= 50 (gate floor; achievement-aligned with
 *     enemies.js kills_100). Higher pair-specific milestones can be
 *     wired in via the FOREST_EVOLUTIONS table if a future tuning pass
 *     wants per-pair gates (e.g. chain @ 50, frost @ 100).
 *   - Hero has the base weapon at level 8 AND the paired passive at level 5.
 *
 * Evolution pairs (FOREST_EVOLUTIONS):
 *   - chain (L8) + tome (L5)     → chain_storm   (sigil: 'storm')
 *   - frostbloom (L8) + duration (L5) → frost_eternal (sigil: 'eternal')
 *
 *   NOTE on passive ids: the FE-V2 Coffins brief suggested 'chain_battery'
 *   and 'wintercoat', but those passives don't exist in src/weapons/passives.js.
 *   We picked the closest existing fits: `tome` (cooldown) for chain (the
 *   pair that already drives the base Chain→Storm EVOLUTIONS path in
 *   weapons/index.js) and `duration` (effect duration → boosts freezeDur
 *   directly) for frostbloom. These are documented in the agent report.
 *
 * Persistence: `state.run._coffinsOpened` is per-run only (cleared in
 * resetState). Coffins do NOT persist across runs — the player gets a
 * fresh placement each forest scene load. This intentionally mirrors VS's
 * "evolution chests" — they refresh per run.
 *
 * Palette discipline (no new hex constants — slots already used elsewhere):
 *   slot 1 #c7b89a — bone (lid)
 *   slot 3 #6b4f3a — earth brown (base)
 *   slot 4 #4a3220 — dark brown (padlock)
 *   slot 6 #d9a648 — gold (sparkle ring + open burst)
 *
 * Constraints honored:
 *   - Static imports only (no dynamic import in hot path).
 *   - Pre-pooled InstancedMesh per visual component (cap 8 each: 8 max
 *     coffin instances, well above the 1-2 we actually place — extra
 *     headroom keeps pool sizing simple if a future tuning ticket scales
 *     placement up).
 *   - Self-gating: triggered/state writes happen BEFORE side-effect
 *     dispatch (acquireWeapon, FX spawn).
 *   - Zero per-spawn allocation in tick (state in typed arrays + Uint8
 *     state-machine).
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from './postfx.js';
import { FOREST_ROOMS, FOREST_PORTAL_POSITIONS } from './forestRooms.js';
import { getLandmarkPositions } from './forestLandmarks.js';
import { state as _gameState } from './state.js';
import { acquireWeapon } from './weapons/index.js';

// ── pool caps ────────────────────────────────────────────────────────────────
const CAP_COFFINS = 8; // pre-pool cap; actual placement is 1-2

// ── trigger radius (coffin slightly larger than landmarks to forgive overshoot) ─
const TRIGGER_R  = 1.1;
const TRIGGER_R2 = TRIGGER_R * TRIGGER_R;

// ── state machine codes ──────────────────────────────────────────────────────
const ST_LOCKED     = 0;
const ST_UNLOCKABLE = 1;
const ST_OPENING    = 2;
const ST_OPENED     = 3;

// ── kill-milestone floor (FE-V2 brief: 50/100/200; we gate on the lowest).
// Per-pair gates can be added in FOREST_EVOLUTIONS later if a tuning pass
// wants escalating milestones; for v0.2 a single floor is enough.
const KILL_FLOOR = 50;

// ── palette (slots already used by forestLandmarks.js — no new constants) ────
const SLOT1_BONE  = 0xc7b89a; // lid
const SLOT3_BROWN = 0x6b4f3a; // base
const SLOT4_DARK  = 0x4a3220; // padlock
const SLOT6_GOLD  = 0xd9a648; // sparkle ring + open burst

// ── bounds keep-out (mirrors forestLandmarks.js for consistency) ─────────────
const LOCKDOWN = { x: 1.0, z: -28.0, r2: (8 + 2) * (8 + 2) }; // r=10
const TRAP_SHARDS = [
  { x: -1.0, z: 19.0, r2: (1.6 + 2) * (1.6 + 2) },
  { x: -1.0, z: 22.0, r2: (1.6 + 2) * (1.6 + 2) },
  { x: -1.0, z: 25.0, r2: (1.6 + 2) * (1.6 + 2) },
];
const PORTAL_KEEPOUT_R2   = 2 * 2; // r=2 around each portal post
const LANDMARK_KEEPOUT_R2 = 2 * 2; // r=2 around any placed landmark

// ── target rooms (FE-V2 brief: "farthest from glade — gating reward") ────────
// Brief specified `mossroothollow`/`glowfenmarshes` but actual room ids are
// `mossroot`/`glowfen` (see forestRooms.js). Resolved per advisor guidance.
const TARGET_ROOMS = ['mossroot', 'glowfen'];

// ── FE-V2 evolution pair table ──────────────────────────────────────────────
// id     — evolved weapon id (must match weapons/index.js REGISTRY key)
// base   — base weapon id (must be in state.weapons @ Lv == baseLevel)
// passive— paired passive id (must be in state.passives @ Lv >= passiveLevel)
// sigil  — short label for the coffin's "ready to open" banner (cosmetic)
const FOREST_EVOLUTIONS = [
  {
    id: 'chain_storm',   base: 'chain',      baseLevel: 8,
    passive: 'tome',     passiveLevel: 5,    sigil: 'storm',
  },
  {
    id: 'frost_eternal', base: 'frostbloom', baseLevel: 8,
    passive: 'duration', passiveLevel: 5,    sigil: 'eternal',
  },
];

// ── module state ─────────────────────────────────────────────────────────────
let _loaded = false;
let _group = null;
let _disposables = [];

// Coffin pool — typed arrays for state, InstancedMesh per component.
let _coffinCount = 0;
let _coffinLidMesh   = null; // BoxGeometry 1.2×0.6×0.6 — slot-1 bone
let _coffinBaseMesh  = null; // BoxGeometry 1.2×0.4×0.6 — slot-3 brown
let _coffinLockMesh  = null; // CircleGeometry r=0.12 — slot-4 dark (on front)
let _coffinSparkMesh = null; // TorusGeometry — slot-6 gold (unlockable spin)
let _coffinPos       = null; // Float32Array [x,z,x,z,...]
let _coffinYaw       = null; // Float32Array per-instance yaw (radians)
let _coffinState     = null; // Uint8Array per-instance state code
let _coffinPair      = null; // Uint8Array per-instance FOREST_EVOLUTIONS index
                              // (only valid when state >= UNLOCKABLE)
let _coffinOpenT     = null; // Float32Array per-instance open animation elapsed

// Reusable scratch (no allocations in hot path)
const _dummy = new THREE.Object3D();
const _zeroDummy = new THREE.Object3D();
_zeroDummy.scale.set(0, 0, 0);
_zeroDummy.updateMatrix();
const _ZERO_MATRIX = _zeroDummy.matrix.clone();

// Animation tunables
const OPEN_DURATION = 1.2;   // seconds for the OPENING phase
const SPARK_SPIN_HZ = 1.2;   // sparkle ring rotation speed (full turns/sec)
const LID_BOB_HZ    = 1.4;   // unlockable lid bob frequency
const LID_BOB_AMP   = 0.05;  // unlockable lid bob amplitude

// Time accumulator for sparkle spin / lid bob — module-scope so it persists
// across ticks and survives a frame's worth of state-machine churn cleanly.
let _animClock = 0;

// ── deterministic RNG (mulberry32, fresh seed 0xC0FFE9) ─────────────────────
function _mulberry32(seed) {
  let s = seed >>> 0;
  return function rand() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────
function _isInKeepout(x, z, landmarkPts) {
  // Lockdown arena keep-out
  let dx = x - LOCKDOWN.x;
  let dz = z - LOCKDOWN.z;
  if (dx * dx + dz * dz < LOCKDOWN.r2) return true;
  // Trap corridor shards
  for (let i = 0; i < TRAP_SHARDS.length; i++) {
    const s = TRAP_SHARDS[i];
    dx = x - s.x;
    dz = z - s.z;
    if (dx * dx + dz * dz < s.r2) return true;
  }
  // Portal posts
  for (const k in FOREST_PORTAL_POSITIONS) {
    const p = FOREST_PORTAL_POSITIONS[k];
    dx = x - p.x;
    dz = z - p.z;
    if (dx * dx + dz * dz < PORTAL_KEEPOUT_R2) return true;
  }
  // Placed landmarks (snapshot from forestLandmarks.getLandmarkPositions)
  if (landmarkPts && landmarkPts.length > 0) {
    for (let i = 0; i < landmarkPts.length; i++) {
      const p = landmarkPts[i];
      dx = x - p.x;
      dz = z - p.z;
      if (dx * dx + dz * dz < LANDMARK_KEEPOUT_R2) return true;
    }
  }
  return false;
}

function _tryPlace(room, rand, placedX, placedZ, landmarkPts, attempts) {
  // Inset 3u from bounds (brief: "bounds inset 3u").
  const minX = room.bounds.minX + 3;
  const maxX = room.bounds.maxX - 3;
  const minZ = room.bounds.minZ + 3;
  const maxZ = room.bounds.maxZ - 3;
  // Coffin-vs-coffin spacing — keep multi-coffin placements apart so a
  // single hero step can't be on top of two at once.
  const SPACING2 = 3.0 * 3.0;
  for (let a = 0; a < attempts; a++) {
    const x = minX + rand() * (maxX - minX);
    const z = minZ + rand() * (maxZ - minZ);
    if (_isInKeepout(x, z, landmarkPts)) continue;
    let collide = false;
    for (let i = 0; i < placedX.length; i++) {
      const dx = x - placedX[i];
      const dz = z - placedZ[i];
      if (dx * dx + dz * dz < SPACING2) { collide = true; break; }
    }
    if (collide) continue;
    return { x, z };
  }
  return null;
}

function _track(obj) { _disposables.push(obj); }

// ── mesh builders ────────────────────────────────────────────────────────────
function _buildCoffinMeshes() {
  // Lid — BoxGeometry 1.2×0.6×0.6 (slot-1 bone), rotated -8° on X to look
  // pried open. The per-instance setMatrixAt below bakes that rotation in
  // along with the per-instance yaw + state-driven lift.
  const lidGeo = new THREE.BoxGeometry(1.2, 0.6, 0.6);
  const lidMat = new THREE.MeshStandardMaterial({
    color: SLOT1_BONE, roughness: 0.85, metalness: 0.04, flatShading: true,
  });
  _coffinLidMesh = new THREE.InstancedMesh(lidGeo, lidMat, CAP_COFFINS);
  _coffinLidMesh.userData.coffinKind = 'lid';
  _track(lidGeo); _track(lidMat);

  // Base — BoxGeometry 1.2×0.4×0.6 (slot-3 brown).
  const baseGeo = new THREE.BoxGeometry(1.2, 0.4, 0.6);
  const baseMat = new THREE.MeshStandardMaterial({
    color: SLOT3_BROWN, roughness: 0.95, metalness: 0.02, flatShading: true,
  });
  _coffinBaseMesh = new THREE.InstancedMesh(baseGeo, baseMat, CAP_COFFINS);
  _coffinBaseMesh.userData.coffinKind = 'base';
  _track(baseGeo); _track(baseMat);

  // Padlock — CircleGeometry r=0.12 (slot-4 dark), front-facing on the base.
  // Hidden on unlockable+ states via zero-matrix.
  const lockGeo = new THREE.CircleGeometry(0.12, 12);
  const lockMat = new THREE.MeshStandardMaterial({
    color: SLOT4_DARK, roughness: 0.9, metalness: 0.1, flatShading: true,
    side: THREE.DoubleSide,
  });
  _coffinLockMesh = new THREE.InstancedMesh(lockGeo, lockMat, CAP_COFFINS);
  _coffinLockMesh.userData.coffinKind = 'lock';
  _track(lockGeo); _track(lockMat);

  // Sparkle ring — TorusGeometry slot-6 gold, additive + bloom. Only visible
  // when state == UNLOCKABLE. The ring spins around Y via per-frame matrix
  // recompute on each unlockable instance.
  const sparkGeo = new THREE.TorusGeometry(0.55, 0.06, 6, 16);
  const sparkMat = new THREE.MeshBasicMaterial({
    color: SLOT6_GOLD,
    transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  _coffinSparkMesh = new THREE.InstancedMesh(sparkGeo, sparkMat, CAP_COFFINS);
  _coffinSparkMesh.layers.enable(BLOOM_LAYER);
  _coffinSparkMesh.userData.coffinKind = 'spark';
  _track(sparkGeo); _track(sparkMat);
}

// ── placement ────────────────────────────────────────────────────────────────
function _placeCoffins(rand) {
  _coffinPos    = new Float32Array(CAP_COFFINS * 2);
  _coffinYaw    = new Float32Array(CAP_COFFINS);
  _coffinState  = new Uint8Array(CAP_COFFINS);   // ST_LOCKED default (0)
  _coffinPair   = new Uint8Array(CAP_COFFINS);   // 0 until UNLOCKABLE
  _coffinOpenT  = new Float32Array(CAP_COFFINS);

  // Snapshot landmark positions for keep-out queries. Empty array if
  // forestLandmarks hasn't loaded (defensive — shouldn't happen because
  // arenaDecor's _buildForestDecor loads landmarks before coffins).
  let landmarkPts = [];
  try { landmarkPts = getLandmarkPositions(); } catch (_) { landmarkPts = []; }

  const placedX = [];
  const placedZ = [];
  let idx = 0;

  // Place 1-2 coffins: try room order [mossroot, glowfen]; per-room count
  // is 1 (50% chance to skip the second room so the player sometimes only
  // gets 1 coffin per run — adds spice).
  for (let rIdx = 0; rIdx < TARGET_ROOMS.length; rIdx++) {
    if (idx >= CAP_COFFINS) break;
    const roomId = TARGET_ROOMS[rIdx];
    const room = FOREST_ROOMS[roomId];
    if (!room) continue;
    // Skip-roll on the second room only (keeps the gating tense).
    if (rIdx > 0 && rand() < 0.5) continue;

    const spot = _tryPlace(room, rand, placedX, placedZ, landmarkPts, 24);
    if (!spot) continue;

    _coffinPos[idx * 2 + 0] = spot.x;
    _coffinPos[idx * 2 + 1] = spot.z;
    _coffinYaw[idx] = rand() * Math.PI * 2;
    _coffinState[idx] = ST_LOCKED;
    placedX.push(spot.x); placedZ.push(spot.z);
    idx++;
  }
  _coffinCount = idx;

  // Stamp the initial LOCKED matrices for all placed instances.
  for (let i = 0; i < _coffinCount; i++) {
    _stampLockedMatrices(i);
  }
  // Zero-out unused slots so stray identity matrices don't render.
  for (let i = _coffinCount; i < CAP_COFFINS; i++) {
    _coffinLidMesh.setMatrixAt(i, _ZERO_MATRIX);
    _coffinBaseMesh.setMatrixAt(i, _ZERO_MATRIX);
    _coffinLockMesh.setMatrixAt(i, _ZERO_MATRIX);
    _coffinSparkMesh.setMatrixAt(i, _ZERO_MATRIX);
  }
  _coffinLidMesh.instanceMatrix.needsUpdate = true;
  _coffinBaseMesh.instanceMatrix.needsUpdate = true;
  _coffinLockMesh.instanceMatrix.needsUpdate = true;
  _coffinSparkMesh.instanceMatrix.needsUpdate = true;
}

function _stampLockedMatrices(i) {
  const x = _coffinPos[i * 2 + 0];
  const z = _coffinPos[i * 2 + 1];
  const yaw = _coffinYaw[i];
  // Base — sits on the ground (y=0.2, half-height of 0.4).
  _dummy.position.set(x, 0.2, z);
  _dummy.rotation.set(0, yaw, 0);
  _dummy.scale.setScalar(1);
  _dummy.updateMatrix();
  _coffinBaseMesh.setMatrixAt(i, _dummy.matrix);
  // Lid — sits on top of base (y = 0.4 + 0.3 = 0.7), tilted -8° on local X
  // (around the unrotated geometry's X axis; with yaw rotation this is
  // effectively a 8° tilt forward along the long axis of the coffin —
  // sells "pried" without lifting the lid off).
  _dummy.position.set(x, 0.7, z);
  _dummy.rotation.set(-8 * Math.PI / 180, yaw, 0);
  _dummy.scale.setScalar(1);
  _dummy.updateMatrix();
  _coffinLidMesh.setMatrixAt(i, _dummy.matrix);
  // Padlock — small circle on the front face (offset slightly along yaw's
  // perpendicular). y = base midline = 0.2.
  const fx = Math.cos(yaw) * 0.31;  // 0.3 = half-depth + 0.01 z-fight pad
  const fz = Math.sin(yaw) * 0.31;
  _dummy.position.set(x + fx, 0.2, z + fz);
  _dummy.rotation.set(0, yaw + Math.PI / 2, 0); // disc normal aligned with front
  _dummy.scale.setScalar(1);
  _dummy.updateMatrix();
  _coffinLockMesh.setMatrixAt(i, _dummy.matrix);
  // Sparkle ring — hidden on LOCKED (zero matrix).
  _coffinSparkMesh.setMatrixAt(i, _ZERO_MATRIX);
}

// Re-stamp matrices for a single coffin in UNLOCKABLE state (lid bobs,
// padlock hidden, sparkle ring visible + spinning). Called per-frame for
// unlockable coffins.
function _stampUnlockableMatrices(i) {
  const x = _coffinPos[i * 2 + 0];
  const z = _coffinPos[i * 2 + 1];
  const yaw = _coffinYaw[i];
  const bob = Math.sin(_animClock * Math.PI * 2 * LID_BOB_HZ + i * 0.7) * LID_BOB_AMP;
  // Base — unchanged from LOCKED.
  _dummy.position.set(x, 0.2, z);
  _dummy.rotation.set(0, yaw, 0);
  _dummy.scale.setScalar(1);
  _dummy.updateMatrix();
  _coffinBaseMesh.setMatrixAt(i, _dummy.matrix);
  // Lid — same tilt, but bobs up by `bob` units (LID_BOB_AMP at peak).
  _dummy.position.set(x, 0.7 + bob, z);
  _dummy.rotation.set(-8 * Math.PI / 180, yaw, 0);
  _dummy.scale.setScalar(1);
  _dummy.updateMatrix();
  _coffinLidMesh.setMatrixAt(i, _dummy.matrix);
  // Padlock — hidden.
  _coffinLockMesh.setMatrixAt(i, _ZERO_MATRIX);
  // Sparkle ring — overhead at y=1.6, rotated flat + spinning around Y.
  const spin = _animClock * Math.PI * 2 * SPARK_SPIN_HZ + i * 1.3;
  _dummy.position.set(x, 1.6, z);
  _dummy.rotation.set(Math.PI / 2, spin, 0);
  _dummy.scale.setScalar(1);
  _dummy.updateMatrix();
  _coffinSparkMesh.setMatrixAt(i, _dummy.matrix);
}

// Re-stamp matrices for a coffin in OPENING state. Lid scales up + tilts
// to 35° as openT progresses 0 → OPEN_DURATION. Padlock + spark hidden.
function _stampOpeningMatrices(i) {
  const x = _coffinPos[i * 2 + 0];
  const z = _coffinPos[i * 2 + 1];
  const yaw = _coffinYaw[i];
  const t = Math.min(1, _coffinOpenT[i] / OPEN_DURATION);
  const lift = 0.4 * t;             // lid lifts 0.4u over the duration
  const lidScale = 1 + 0.3 * t;     // lid grows 30% over the duration
  const tiltDeg = -8 + (35 - (-8)) * t; // -8° → 35° tilt
  // Base — unchanged.
  _dummy.position.set(x, 0.2, z);
  _dummy.rotation.set(0, yaw, 0);
  _dummy.scale.setScalar(1);
  _dummy.updateMatrix();
  _coffinBaseMesh.setMatrixAt(i, _dummy.matrix);
  // Lid — lifted, tilted, scaled.
  _dummy.position.set(x, 0.7 + lift, z);
  _dummy.rotation.set(tiltDeg * Math.PI / 180, yaw, 0);
  _dummy.scale.setScalar(lidScale);
  _dummy.updateMatrix();
  _coffinLidMesh.setMatrixAt(i, _dummy.matrix);
  // Padlock + spark — hidden.
  _coffinLockMesh.setMatrixAt(i, _ZERO_MATRIX);
  _coffinSparkMesh.setMatrixAt(i, _ZERO_MATRIX);
}

// Hide all components for a coffin (OPENED final state).
function _stampHiddenMatrices(i) {
  _coffinLidMesh.setMatrixAt(i, _ZERO_MATRIX);
  _coffinBaseMesh.setMatrixAt(i, _ZERO_MATRIX);
  _coffinLockMesh.setMatrixAt(i, _ZERO_MATRIX);
  _coffinSparkMesh.setMatrixAt(i, _ZERO_MATRIX);
}

// ── eligibility scan ─────────────────────────────────────────────────────────
// Returns the FOREST_EVOLUTIONS index the player qualifies for, or -1.
// If the player qualifies for multiple pairs simultaneously, returns the
// first qualifying pair (FE-V2 watch-outs: "fallback: pick the first
// qualifying pair" since `pickRunSelect` UI doesn't exist).
function _findEligiblePairIndex(state) {
  const kills = (state.run && state.run.kills) || 0;
  if (kills < KILL_FLOOR) return -1;
  if (!state.weapons || !state.passives) return -1;
  for (let i = 0; i < FOREST_EVOLUTIONS.length; i++) {
    const ev = FOREST_EVOLUTIONS[i];
    const w = state.weapons.find(w => w && w.id === ev.base);
    if (!w || w.level < ev.baseLevel) continue;
    const p = state.passives.find(p => p && p.id === ev.passive);
    if (!p || p.level < ev.passiveLevel) continue;
    return i;
  }
  return -1;
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Build pre-pooled coffin meshes and scatter 1-2 across the target rooms.
 * Idempotent — gated on `_loaded` to no-op on double-load.
 *
 * @param {THREE.Scene} scene
 * @param {Object} _state - GameState (unused at load; eligibility scan runs at tick)
 * @param {Function} [rngOverride] - optional rng for tests; defaults to
 *   `_mulberry32(0xC0FFE9)` — a seed distinct from forestLandmarks (0xC0FFE8)
 *   and earlier decor seeds (0xC0FFE2..0xC0FFE7) so coffin placements are
 *   uncorrelated with other forest decor.
 */
export function loadForestCoffins(scene, _state, rngOverride) {
  if (_loaded) return;
  if (!scene) return;
  _group = new THREE.Group();
  _group.name = '__forestCoffins';

  _buildCoffinMeshes();
  _group.add(_coffinLidMesh);
  _group.add(_coffinBaseMesh);
  _group.add(_coffinLockMesh);
  _group.add(_coffinSparkMesh);

  const rand = (typeof rngOverride === 'function') ? rngOverride : _mulberry32(0xC0FFE9);
  _placeCoffins(rand);

  scene.add(_group);
  _animClock = 0;
  _loaded = true;
}

// Dispatch the evolution unlock. Called when a coffin transitions
// LOCKED+UNLOCKABLE → OPENING. Self-gating: caller has already stamped
// _coffinState[i]=ST_OPENING before invoking, so a same-frame re-entry
// can't double-dispatch.
function _dispatchEvolution(state, pairIdx) {
  const ev = FOREST_EVOLUTIONS[pairIdx];
  if (!ev) return;
  // Add the evolved weapon to the kit via the normal acquire path.
  // FE-V2 watch-outs: "ALTERNATIVE — leave base weapon, ADD evolved as a
  // separate weapon (player gets both)" — taken per advisor recommendation
  // (swap is too invasive; chain.js has live inst state via inst.evolved
  // that we'd have to clean up). The doubled output is the player's reward.
  try { acquireWeapon(ev.id); } catch (e) { console.warn('[forestCoffins] acquireWeapon failed:', ev.id, e); }
  // Optional FX hook — Ascension burst as the coffin-open visual. Defensive:
  // a missing module shouldn't break the unlock dispatch.
  const heroPos = (state && state.hero) ? state.hero.pos : null;
  const stageId = (state && state.run && state.run.stage) ? state.run.stage.id : 'forest';
  if (state && state.scene && heroPos) {
    import('./fx/evolveBurst.js').then(({ spawnEvolveBurst }) => {
      try { spawnEvolveBurst(state.scene, heroPos, stageId); } catch (_) {}
    }).catch(() => {});
  }
  // Banner — palette-locked gold, ~3s. Lazy import keeps this module
  // decoupled from ui.js (mirrors the weapons/index.js pattern).
  try {
    import('./ui.js').then(({ showBanner }) => {
      try { showBanner(`★ COFFIN OPENED: ${ev.id.toUpperCase()}`, 3.0, '#ffe14a'); } catch (_) {}
    }).catch(() => {});
  } catch (_) {}
}

/**
 * Per-frame: state-machine transitions + animation matrix re-stamps.
 * Cheap when no coffins have been placed (early-out on _loaded / count==0).
 *
 * Ordering:
 *   1. Advance _animClock (shared time for sparkle spin + lid bob).
 *   2. Per coffin: state-machine transition + matrix re-stamp.
 *      LOCKED      → eligibility check; if pair qualifies → UNLOCKABLE.
 *      UNLOCKABLE  → hero proximity check; if inside TRIGGER_R → OPENING.
 *                    Self-gate (_coffinState[i] = ST_OPENING) BEFORE
 *                    dispatch so re-entry can't double-trigger.
 *      OPENING     → tick OPEN_T; when ≥ OPEN_DURATION → OPENED.
 *      OPENED      → no-op (matrices stay hidden).
 *   3. Flag needsUpdate on the 4 InstancedMesh handles iff any matrix
 *      changed this frame (lid bobs every frame for unlockables → always
 *      flag UNLOCKABLE → true; OPENING also flag → true; LOCKED stays
 *      static so the dirty flag is unchanged for those).
 *
 * @param {Object} state - GameState
 * @param {number} dt    - frame seconds
 */
export function tickForestCoffins(state, dt) {
  if (!_loaded) return;
  if (_coffinCount === 0) return;
  if (!state || !state.hero || !state.hero.pos) return;

  _animClock += dt;
  const hx = state.hero.pos.x;
  const hz = state.hero.pos.z;
  // Pre-compute eligibility once per tick — the result is shared across
  // all LOCKED coffins (the same player either qualifies for a pair or
  // doesn't — coffin placement doesn't affect the pair table).
  const eligibleIdx = _findEligiblePairIndex(state);

  let dirty = false;
  for (let i = 0; i < _coffinCount; i++) {
    const st = _coffinState[i];
    if (st === ST_LOCKED) {
      if (eligibleIdx >= 0) {
        // Promote to UNLOCKABLE. Self-gate the state write first so a
        // same-frame re-entry can't churn the transition.
        _coffinState[i] = ST_UNLOCKABLE;
        _coffinPair[i] = eligibleIdx & 0xff;
        // Stamp the new pose (lid bob, padlock hidden, sparkle ring shown).
        _stampUnlockableMatrices(i);
        dirty = true;
      }
      // else: stays LOCKED, static matrices don't need re-stamp.
    } else if (st === ST_UNLOCKABLE) {
      // Always re-stamp (lid bob + sparkle spin animate every frame).
      _stampUnlockableMatrices(i);
      dirty = true;
      // Hero proximity check.
      const cx = _coffinPos[i * 2 + 0];
      const cz = _coffinPos[i * 2 + 1];
      const dx = hx - cx;
      const dz = hz - cz;
      if (dx * dx + dz * dz <= TRIGGER_R2) {
        // Self-gate to ST_OPENING BEFORE dispatch so a fast re-entry
        // can't double-fire (matches forestLandmarks pattern).
        _coffinState[i] = ST_OPENING;
        _coffinOpenT[i] = 0;
        // Mark this coffin as opened in the per-run map. Brief: persist
        // PER RUN only. Key is the room+index pair (string) so a future
        // tuning ticket can re-spawn coffins mid-run without colliding.
        if (state.run) {
          if (!state.run._coffinsOpened) state.run._coffinsOpened = {};
          state.run._coffinsOpened['c' + i] = true;
        }
        // Dispatch the evolution. acquireWeapon + FX burst + banner.
        const pairIdx = _coffinPair[i];
        _dispatchEvolution(state, pairIdx);
      }
    } else if (st === ST_OPENING) {
      _coffinOpenT[i] += dt;
      _stampOpeningMatrices(i);
      dirty = true;
      if (_coffinOpenT[i] >= OPEN_DURATION) {
        _coffinState[i] = ST_OPENED;
        _stampHiddenMatrices(i);
      }
    }
    // ST_OPENED — no work, matrices already hidden.
  }

  if (dirty) {
    _coffinLidMesh.instanceMatrix.needsUpdate = true;
    _coffinBaseMesh.instanceMatrix.needsUpdate = true;
    _coffinLockMesh.instanceMatrix.needsUpdate = true;
    _coffinSparkMesh.instanceMatrix.needsUpdate = true;
  }
}

/**
 * Tear down all coffin meshes + clear pool state. Idempotent — safe to
 * call when not loaded. Pairs with the disposeForestLandmarks teardown
 * shape exactly so the main.js teardown block can call both side-by-side.
 *
 * @param {THREE.Scene} scene
 */
export function disposeForestCoffins(scene) {
  if (!_loaded && !_group) return;
  if (_group) {
    if (scene && _group.parent === scene) scene.remove(_group);
    else if (_group.parent) _group.parent.remove(_group);
    _group = null;
  }
  for (let i = 0; i < _disposables.length; i++) {
    const d = _disposables[i];
    try { d.dispose && d.dispose(); } catch (_) {}
  }
  _disposables = [];
  _coffinLidMesh = _coffinBaseMesh = _coffinLockMesh = _coffinSparkMesh = null;
  _coffinPos = _coffinYaw = _coffinState = _coffinPair = _coffinOpenT = null;
  _coffinCount = 0;
  _animClock = 0;
  _loaded = false;
  // Touch _gameState only if it's safely importable; some test harnesses
  // load this module without a full game-state graph.
  if (_gameState && '_coffinsLoaded' in _gameState) {
    _gameState._coffinsLoaded = false;
  }
}
