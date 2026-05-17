/**
 * Forest Landmarks — VS-style interactable density for the Forest stage.
 * Ships 3 landmark types as a single pre-pooled module (FE-V2, 2026-05-17):
 *
 *   1. shrine_moss   — circular stone base + tall mossy obelisk + gold sparkle
 *                      ring when undiscovered. AABB r=0.9 trigger; one-shot
 *                      per instance. Effect: state.run._dmgGlobalBonus += 0.05
 *                      (composed in enemies.js damage hot path). Floaty +5.
 *
 *   2. altar_statue  — pedestal + tilted broken bone pillar fragment + faint
 *                      amber base glow when undiscovered. AABB r=0.9 trigger;
 *                      one-shot per instance. Effect: hero.maxHp += 10 and
 *                      heal to full. Floaty +10 heal.
 *
 *   3. log_fallen    — sideways cylinder cosmetic with 2 ring caps. No trigger,
 *                      no interaction. Logs are cosmetic-only this iteration —
 *                      static collider list doesn't exist in the codebase
 *                      (`state.collidersStatic` is unset; enemies.js has no
 *                      static-obstacle avoidance path). Documented as a gap;
 *                      enemy pathing through logs is acceptable for v1.
 *
 * Architecture:
 *   - One InstancedMesh per visual component (5 InstancedMesh per shrine, etc.)
 *     so per-instance state can be cheaply written via setMatrixAt + zero-scale
 *     to "hide" a triggered landmark's sparkle/glow without per-spawn alloc.
 *   - InstancedMesh caps: 64 shrines × 5 components, 32 altars × 4 components,
 *     96 logs × 3 components. Pre-allocated at scene-load time.
 *   - Triggered/visible state lives in parallel typed arrays per type.
 *   - Pulse FX (telegraph rings on trigger) live in a pre-pooled RingGeometry
 *     mesh array; zero allocation in the hot path. tickForestLandmarks fades
 *     active pulses each frame.
 *   - All BLOOM_LAYER tagging on sparkle/glow/pulse meshes (palette slot 6 gold
 *     for shrines, slot 5 amber for altars). Body meshes are non-bloom.
 *
 * Palette discipline (no new hex constants):
 *   - slot-1 #c7b89a — muted bone (altar pillar fragment)
 *   - slot-2 #4a7a4a — forest green (shrine obelisk)
 *   - slot-3 #6b4f3a — earth brown (shrine base, altar pedestal, log body)
 *   - slot-4 #4a3220 — darker brown (log ring caps)
 *   - slot-5 #e89c4a — amber (altar base glow + telegraph burst)
 *   - slot-6 #d9a648 — gold (shrine sparkle ring + telegraph pulse)
 *
 * Public API:
 *   loadForestLandmarks(scene, state, rng)
 *   tickForestLandmarks(dt, state)
 *   disposeForestLandmarks(scene)
 *   getLandmarkPositions() — read-only snapshot of placed landmark XZ centers
 *     (shrines + altars + logs flattened). Used by sibling modules
 *     (e.g. forestCoffins.js) that need to keep-out around placed landmarks.
 *     Returns [] before loadForestLandmarks runs, or after dispose.
 *
 * Constraints honored:
 *   - Static imports only (no dynamic import in hot path).
 *   - Pre-pooled InstancedMesh — zero per-spawn allocation in tick.
 *   - Self-gating: triggered[i]=true set BEFORE effect dispatch.
 *   - RNG: dedicated _mulberry32 seed (0xC0FFE8) — non-overlapping with the
 *     existing forest decor seeds (0xC0FFE2..0xC0FFE7).
 *   - Bounds keep-out: rejects placements within (1,-28) r=10 (Lockdown +
 *     2u margin), (-1, 19/22/25) r=3.6 each (Trap Corridor + margin), and
 *     within r=2 of any FOREST_PORTAL_POSITIONS post.
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from './postfx.js';
import { FOREST_ROOMS, FOREST_PORTAL_POSITIONS } from './forestRooms.js';
import { spawnHealNumber } from './damageNumbers.js';
import { sfx } from './audio.js';
import { createRuneRing } from './fx/runeRing.js';

// ── PHASE 3 P3B — forest stone texture (lazy luminance map; assets/textures/README.md) ──
let _stoneTex = null;
function _stoneTexture() {
  if (_stoneTex) return _stoneTex;
  _stoneTex = new THREE.TextureLoader().load('assets/textures/forest_stone_512.png');
  _stoneTex.wrapS = _stoneTex.wrapT = THREE.RepeatWrapping;
  _stoneTex.repeat.set(1, 1);
  _stoneTex.colorSpace = THREE.SRGBColorSpace;
  _stoneTex.anisotropy = 8;
  return _stoneTex;
}

// ── caps ─────────────────────────────────────────────────────────────────────
const CAP_SHRINES = 64;
const CAP_ALTARS  = 32;
const CAP_LOGS    = 96;
const CAP_PULSES  = 16; // active telegraph rings on screen simultaneously

// ── budgets (per room defaults; override via FOREST_ROOMS[id].landmarkBudget) ─
const DEFAULT_BUDGET = { shrines: 5, altars: 2, logs: 7 };

// ── trigger radius (AABB-ish circular gate) ─────────────────────────────────
const TRIGGER_R  = 0.9;
const TRIGGER_R2 = TRIGGER_R * TRIGGER_R;

// ── pulse FX tunables ────────────────────────────────────────────────────────
const PULSE_LIFE       = 0.4;   // seconds
const PULSE_MAX_SCALE  = 2.4;
const PULSE_INNER      = 0.2;
const PULSE_OUTER      = 0.32;

// ── palette (slots from FOREST_VISUAL_STYLE.md — already used elsewhere) ────
const SLOT1_BONE   = 0xc7b89a;
const SLOT2_GREEN  = 0x4a7a4a;
const SLOT3_BROWN  = 0x6b4f3a;
const SLOT4_DARK   = 0x4a3220;
const SLOT5_AMBER  = 0xe89c4a;
const SLOT6_GOLD   = 0xd9a648;

// ── bounds keep-out ──────────────────────────────────────────────────────────
const LOCKDOWN = { x: 1.0, z: -28.0, r2: (8 + 2) * (8 + 2) }; // r=10
const TRAP_SHARDS = [
  { x: -1.0, z: 19.0, r2: (1.6 + 2) * (1.6 + 2) },
  { x: -1.0, z: 22.0, r2: (1.6 + 2) * (1.6 + 2) },
  { x: -1.0, z: 25.0, r2: (1.6 + 2) * (1.6 + 2) },
];
const PORTAL_KEEPOUT_R2 = 2 * 2; // r=2 around each portal post

// ── module state ─────────────────────────────────────────────────────────────
let _loaded = false;
let _group = null;        // THREE.Group parent for all landmark meshes
let _disposables = [];    // geometries + materials to dispose on teardown

// Shrines: 5 InstancedMesh components
let _shrineCount = 0;
let _shrineBaseMesh = null;     // CylinderGeometry r=0.5 h=0.15
let _shrineObeliskMesh = null;  // BoxGeometry 0.4×1.2×0.4
let _shrineSparkleMesh = null;  // small TorusGeometry (sparkle ring) on BLOOM
let _shrinePos = null;          // Float32Array [x,z,x,z,...]
let _shrineTriggered = null;    // Uint8Array (0 / 1)

// Altars: 4 InstancedMesh components
let _altarCount = 0;
let _altarPedestalMesh = null;  // CylinderGeometry r=0.7 h=0.2
let _altarPillarMesh = null;    // BoxGeometry 0.5×1.0×0.5, rotated
let _altarGlowMesh = null;      // CylinderGeometry r=0.6 h=0.05 (additive)
let _altarPos = null;
let _altarTriggered = null;

// Logs: 3 InstancedMesh components
let _logCount = 0;
let _logBodyMesh = null;        // CylinderGeometry r=0.4 h=2.2 (rotated)
let _logCapAMesh = null;        // CircleGeometry (cap end A)
let _logCapBMesh = null;        // CircleGeometry (cap end B)
let _logPos = null;             // Float32Array [x,z,x,z,...] — for keep-out queries

// Pulse pool — pre-allocated ring meshes for telegraph FX
let _pulseMeshes = [];
let _pulseActive = []; // {idx, t, life, scaleEnd, color}

// Reusable scratch (no allocations in hot path)
const _dummy = new THREE.Object3D();
const _zeroDummy = new THREE.Object3D();
_zeroDummy.scale.set(0, 0, 0);
_zeroDummy.updateMatrix();
const _ZERO_MATRIX = _zeroDummy.matrix.clone();

// ── deterministic RNG (mulberry32, fresh seed) ──────────────────────────────
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
function _isInKeepout(x, z) {
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
  // Portal posts (FOREST_PORTAL_POSITIONS values)
  for (const k in FOREST_PORTAL_POSITIONS) {
    const p = FOREST_PORTAL_POSITIONS[k];
    dx = x - p.x;
    dz = z - p.z;
    if (dx * dx + dz * dz < PORTAL_KEEPOUT_R2) return true;
  }
  return false;
}

/**
 * Try to find a valid placement inside a room's bounds, avoiding keep-out
 * zones AND already-placed landmark positions (min spacing 1.6u). Returns
 * {x, z} or null if no valid spot found after `attempts`.
 */
function _tryPlace(room, rand, placedX, placedZ, attempts) {
  const minX = room.bounds.minX + 2;
  const maxX = room.bounds.maxX - 2;
  const minZ = room.bounds.minZ + 2;
  const maxZ = room.bounds.maxZ - 2;
  const SPACING2 = 1.6 * 1.6;
  for (let a = 0; a < attempts; a++) {
    const x = minX + rand() * (maxX - minX);
    const z = minZ + rand() * (maxZ - minZ);
    if (_isInKeepout(x, z)) continue;
    // Spacing check against already-placed landmark positions
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

// ── builders ─────────────────────────────────────────────────────────────────
function _buildShrineMeshes() {
  // Stone base — flat brown cylinder, no bloom.
  const baseGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.15, 16);
  const baseMat = new THREE.MeshStandardMaterial({
    color: SLOT3_BROWN, roughness: 0.95, metalness: 0.02, flatShading: true,
    map: _stoneTexture(),
  });
  _shrineBaseMesh = new THREE.InstancedMesh(baseGeo, baseMat, CAP_SHRINES);
  _shrineBaseMesh.userData.landmarkKind = 'shrine_base';
  _track(baseGeo); _track(baseMat);

  // Obelisk — mossy green box, no bloom.
  const obeGeo = new THREE.BoxGeometry(0.4, 1.2, 0.4);
  const obeMat = new THREE.MeshStandardMaterial({
    color: SLOT2_GREEN, roughness: 0.85, metalness: 0.03, flatShading: true,
    map: _stoneTexture(),
  });
  _shrineObeliskMesh = new THREE.InstancedMesh(obeGeo, obeMat, CAP_SHRINES);
  _shrineObeliskMesh.userData.landmarkKind = 'shrine_obelisk';
  _track(obeGeo); _track(obeMat);

  // Sparkle ring above — canonical rune-ring helper (PHASE 2 P2A).
  // Replaces the prior TorusGeometry "blank gold donut" with the 8-layer
  // baked-glyph quality bar so shrines read as a magical summoning sigil.
  // Discovered shrines still hide via zero-scale on the InstancedMesh slot.
  const shrineRune = createRuneRing({
    radius: 0.45, color: SLOT6_GOLD, opacity: 0.85,
    instanced: true, cap: CAP_SHRINES,
    userData: { landmarkKind: 'shrine_sparkle' },
  });
  _shrineSparkleMesh = shrineRune.mesh;
  _track(shrineRune.material);
}

function _buildAltarMeshes() {
  // Pedestal — wider brown cylinder.
  const pedGeo = new THREE.CylinderGeometry(0.7, 0.7, 0.2, 16);
  const pedMat = new THREE.MeshStandardMaterial({
    color: SLOT3_BROWN, roughness: 0.95, metalness: 0.02, flatShading: true,
    map: _stoneTexture(),
  });
  _altarPedestalMesh = new THREE.InstancedMesh(pedGeo, pedMat, CAP_ALTARS);
  _altarPedestalMesh.userData.landmarkKind = 'altar_pedestal';
  _track(pedGeo); _track(pedMat);

  // Pillar fragment — bone-colored box, tilted ~25° on x-axis.
  const pillarGeo = new THREE.BoxGeometry(0.5, 1.0, 0.5);
  const pillarMat = new THREE.MeshStandardMaterial({
    color: SLOT1_BONE, roughness: 0.7, metalness: 0.05, flatShading: true,
    map: _stoneTexture(),
  });
  _altarPillarMesh = new THREE.InstancedMesh(pillarGeo, pillarMat, CAP_ALTARS);
  _altarPillarMesh.userData.landmarkKind = 'altar_pillar';
  _track(pillarGeo); _track(pillarMat);

  // Amber base glow — flat low cylinder, additive, bloom-tagged, low opacity.
  const glowGeo = new THREE.CylinderGeometry(0.85, 0.85, 0.05, 16);
  const glowMat = new THREE.MeshBasicMaterial({
    color: SLOT5_AMBER,
    transparent: true, opacity: 0.35,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    // Ground-decal Z-order fix (2026-05-17 user report): flat glow at y=0.01
    // must render below hero/enemies. polygonOffset biases it further BELOW
    // in the depth buffer.
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  _altarGlowMesh = new THREE.InstancedMesh(glowGeo, glowMat, CAP_ALTARS);
  _altarGlowMesh.layers.enable(BLOOM_LAYER);
  _altarGlowMesh.userData.landmarkKind = 'altar_glow';
  _altarGlowMesh.renderOrder = -1;
  _track(glowGeo); _track(glowMat);
}

function _buildLogMeshes() {
  // Body cylinder — brown, no bloom. Rotated 90° on Z so it lies sideways
  // along the X axis (rotation is baked per-instance via dummy.rotation.z).
  const bodyGeo = new THREE.CylinderGeometry(0.4, 0.4, 2.2, 10);
  const bodyMat = new THREE.MeshStandardMaterial({
    color: SLOT3_BROWN, roughness: 0.9, metalness: 0.02, flatShading: true,
  });
  _logBodyMesh = new THREE.InstancedMesh(bodyGeo, bodyMat, CAP_LOGS);
  _logBodyMesh.userData.landmarkKind = 'log_body';
  _track(bodyGeo); _track(bodyMat);

  // Cap A — darker brown circle at one end. Pre-rotated so the disc faces
  // along +X (the log's long axis after the 90° Z rotation). Instances get
  // additional per-instance rotation to match log yaw + axial offset.
  const capGeoA = new THREE.CircleGeometry(0.4, 12);
  const capMatA = new THREE.MeshStandardMaterial({
    color: SLOT4_DARK, roughness: 0.95, metalness: 0.02, flatShading: true,
    side: THREE.DoubleSide,
  });
  _logCapAMesh = new THREE.InstancedMesh(capGeoA, capMatA, CAP_LOGS);
  _logCapAMesh.userData.landmarkKind = 'log_cap_a';
  _track(capGeoA); _track(capMatA);

  // Cap B — same as cap A; separate mesh for clean per-end offset/orientation.
  const capGeoB = new THREE.CircleGeometry(0.4, 12);
  const capMatB = new THREE.MeshStandardMaterial({
    color: SLOT4_DARK, roughness: 0.95, metalness: 0.02, flatShading: true,
    side: THREE.DoubleSide,
  });
  _logCapBMesh = new THREE.InstancedMesh(capGeoB, capMatB, CAP_LOGS);
  _logCapBMesh.userData.landmarkKind = 'log_cap_b';
  _track(capGeoB); _track(capMatB);
}

function _buildPulsePool() {
  // Pre-allocate CAP_PULSES ring meshes via canonical rune-ring helper
  // (PHASE 2 P2A). Each pulse owns its own MATERIAL so opacity/color can be
  // animated independently per-frame (helper's shared geometry is reused).
  for (let i = 0; i < CAP_PULSES; i++) {
    const pulse = createRuneRing({
      radius: PULSE_OUTER, color: SLOT6_GOLD, opacity: 0,
      userData: { landmarkKind: 'pulse' },
    });
    pulse.mesh.visible = false;
    _pulseMeshes.push(pulse.mesh);
    _track(pulse.material);
  }
}

// ── placement ────────────────────────────────────────────────────────────────
function _placeShrines(rand) {
  _shrinePos = new Float32Array(CAP_SHRINES * 2);
  _shrineTriggered = new Uint8Array(CAP_SHRINES);
  const placedX = [];
  const placedZ = [];
  let idx = 0;

  for (const id in FOREST_ROOMS) {
    if (idx >= CAP_SHRINES) break;
    const room = FOREST_ROOMS[id];
    const budget = (room.landmarkBudget && typeof room.landmarkBudget.shrines === 'number')
      ? room.landmarkBudget.shrines
      : DEFAULT_BUDGET.shrines;
    const n = 4 + ((rand() * 3) | 0); // 4..6 baseline
    const target = Math.min(budget, n);
    for (let i = 0; i < target && idx < CAP_SHRINES; i++) {
      const spot = _tryPlace(room, rand, placedX, placedZ, 24);
      if (!spot) continue;
      _shrinePos[idx * 2 + 0] = spot.x;
      _shrinePos[idx * 2 + 1] = spot.z;
      placedX.push(spot.x); placedZ.push(spot.z);

      // Stamp instance matrices for the 3 shrine components.
      // Base at y=0.075 (half-height), obelisk at y=0.75 (base top + half obe),
      // sparkle ring at y=2.0 hovering overhead.
      _dummy.position.set(spot.x, 0.075, spot.z);
      _dummy.rotation.set(0, rand() * Math.PI * 2, 0);
      _dummy.scale.setScalar(1);
      _dummy.updateMatrix();
      _shrineBaseMesh.setMatrixAt(idx, _dummy.matrix);

      _dummy.position.set(spot.x, 0.75, spot.z);
      _dummy.rotation.set(0, rand() * Math.PI * 2, 0);
      _dummy.updateMatrix();
      _shrineObeliskMesh.setMatrixAt(idx, _dummy.matrix);

      _dummy.position.set(spot.x, 2.0, spot.z);
      _dummy.rotation.set(Math.PI / 2, 0, 0);
      _dummy.scale.setScalar(1);
      _dummy.updateMatrix();
      _shrineSparkleMesh.setMatrixAt(idx, _dummy.matrix);

      idx++;
    }
  }
  // Zero-out remaining unused slots so stray identity matrices don't render.
  for (let i = idx; i < CAP_SHRINES; i++) {
    _shrineBaseMesh.setMatrixAt(i, _ZERO_MATRIX);
    _shrineObeliskMesh.setMatrixAt(i, _ZERO_MATRIX);
    _shrineSparkleMesh.setMatrixAt(i, _ZERO_MATRIX);
  }
  _shrineBaseMesh.instanceMatrix.needsUpdate = true;
  _shrineObeliskMesh.instanceMatrix.needsUpdate = true;
  _shrineSparkleMesh.instanceMatrix.needsUpdate = true;
  _shrineCount = idx;
}

function _placeAltars(rand) {
  _altarPos = new Float32Array(CAP_ALTARS * 2);
  _altarTriggered = new Uint8Array(CAP_ALTARS);
  const placedX = [];
  const placedZ = [];
  // Seed placedX/Z with existing shrine positions so altars space away from
  // shrines too (single global spacing budget for landmark cluster reads).
  for (let i = 0; i < _shrineCount; i++) {
    placedX.push(_shrinePos[i * 2]);
    placedZ.push(_shrinePos[i * 2 + 1]);
  }
  let idx = 0;

  for (const id in FOREST_ROOMS) {
    if (idx >= CAP_ALTARS) break;
    const room = FOREST_ROOMS[id];
    const budget = (room.landmarkBudget && typeof room.landmarkBudget.altars === 'number')
      ? room.landmarkBudget.altars
      : DEFAULT_BUDGET.altars;
    const n = 2 + ((rand() * 2) | 0); // 2..3 baseline
    const target = Math.min(budget, n);
    for (let i = 0; i < target && idx < CAP_ALTARS; i++) {
      const spot = _tryPlace(room, rand, placedX, placedZ, 24);
      if (!spot) continue;
      _altarPos[idx * 2 + 0] = spot.x;
      _altarPos[idx * 2 + 1] = spot.z;
      placedX.push(spot.x); placedZ.push(spot.z);

      // Pedestal at y=0.1, pillar tilted ~25° on X-axis, offset upward + back
      // so the broken pillar looks like it fell over the pedestal. Glow disc
      // at floor level y=0.01 to avoid z-fighting with terrain at y=0.
      _dummy.position.set(spot.x, 0.1, spot.z);
      _dummy.rotation.set(0, rand() * Math.PI * 2, 0);
      _dummy.scale.setScalar(1);
      _dummy.updateMatrix();
      _altarPedestalMesh.setMatrixAt(idx, _dummy.matrix);

      _dummy.position.set(spot.x, 0.6, spot.z);
      _dummy.rotation.set(25 * Math.PI / 180, rand() * Math.PI * 2, 0);
      _dummy.updateMatrix();
      _altarPillarMesh.setMatrixAt(idx, _dummy.matrix);

      _dummy.position.set(spot.x, 0.01, spot.z);
      _dummy.rotation.set(0, 0, 0);
      _dummy.scale.setScalar(1);
      _dummy.updateMatrix();
      _altarGlowMesh.setMatrixAt(idx, _dummy.matrix);

      idx++;
    }
  }
  for (let i = idx; i < CAP_ALTARS; i++) {
    _altarPedestalMesh.setMatrixAt(i, _ZERO_MATRIX);
    _altarPillarMesh.setMatrixAt(i, _ZERO_MATRIX);
    _altarGlowMesh.setMatrixAt(i, _ZERO_MATRIX);
  }
  _altarPedestalMesh.instanceMatrix.needsUpdate = true;
  _altarPillarMesh.instanceMatrix.needsUpdate = true;
  _altarGlowMesh.instanceMatrix.needsUpdate = true;
  _altarCount = idx;
}

function _placeLogs(rand) {
  _logPos = new Float32Array(CAP_LOGS * 2);
  const placedX = [];
  const placedZ = [];
  // Track shrines + altars to avoid stacking logs on triggers.
  for (let i = 0; i < _shrineCount; i++) {
    placedX.push(_shrinePos[i * 2]);
    placedZ.push(_shrinePos[i * 2 + 1]);
  }
  for (let i = 0; i < _altarCount; i++) {
    placedX.push(_altarPos[i * 2]);
    placedZ.push(_altarPos[i * 2 + 1]);
  }
  let idx = 0;

  for (const id in FOREST_ROOMS) {
    if (idx >= CAP_LOGS) break;
    const room = FOREST_ROOMS[id];
    const budget = (room.landmarkBudget && typeof room.landmarkBudget.logs === 'number')
      ? room.landmarkBudget.logs
      : DEFAULT_BUDGET.logs;
    const n = 6 + ((rand() * 3) | 0); // 6..8 baseline
    const target = Math.min(budget, n);
    for (let i = 0; i < target && idx < CAP_LOGS; i++) {
      const spot = _tryPlace(room, rand, placedX, placedZ, 24);
      if (!spot) continue;
      _logPos[idx * 2 + 0] = spot.x;
      _logPos[idx * 2 + 1] = spot.z;
      placedX.push(spot.x); placedZ.push(spot.z);

      // Yaw rotation so logs aren't all axis-aligned.
      const yaw = rand() * Math.PI * 2;
      // Body cylinder: rotated 90° on Z to lay sideways along (cos yaw, sin yaw).
      // Three.js cylinder default axis is +Y; rotation order Y-then-Z so the
      // cylinder rotates around world Y first then flips horizontal.
      _dummy.position.set(spot.x, 0.4, spot.z);
      _dummy.rotation.set(0, yaw, Math.PI / 2);
      _dummy.scale.setScalar(1);
      _dummy.updateMatrix();
      _logBodyMesh.setMatrixAt(idx, _dummy.matrix);

      // Cap ends — sit at ±1.1u along the log's long axis (= half height 2.2).
      const ax = Math.cos(yaw) * 1.1;
      const az = Math.sin(yaw) * 1.1;
      // Cap A faces +X local (the long axis after rotation). The disc plane
      // normal is +Z by default; rotation.y = yaw + π/2 aligns its normal
      // with the log axis. Position it at one end of the body.
      _dummy.position.set(spot.x + ax, 0.4, spot.z + az);
      _dummy.rotation.set(0, yaw + Math.PI / 2, 0);
      _dummy.scale.setScalar(1);
      _dummy.updateMatrix();
      _logCapAMesh.setMatrixAt(idx, _dummy.matrix);

      _dummy.position.set(spot.x - ax, 0.4, spot.z - az);
      _dummy.rotation.set(0, yaw + Math.PI / 2, 0);
      _dummy.updateMatrix();
      _logCapBMesh.setMatrixAt(idx, _dummy.matrix);

      idx++;
    }
  }
  for (let i = idx; i < CAP_LOGS; i++) {
    _logBodyMesh.setMatrixAt(i, _ZERO_MATRIX);
    _logCapAMesh.setMatrixAt(i, _ZERO_MATRIX);
    _logCapBMesh.setMatrixAt(i, _ZERO_MATRIX);
  }
  _logBodyMesh.instanceMatrix.needsUpdate = true;
  _logCapAMesh.instanceMatrix.needsUpdate = true;
  _logCapBMesh.instanceMatrix.needsUpdate = true;
  _logCount = idx;
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Build pre-pooled landmark meshes and scatter them across all 7 Forest rooms.
 * Idempotent — calling twice without dispose is a no-op (gated on _loaded).
 *
 * @param {THREE.Scene} scene
 * @param {Object} _state - unused; reserved for future seed override hooks
 * @param {Function} [rngOverride] - optional rng to override the default
 *   landmark seed (mulberry32 0xC0FFE8). Tests pass deterministic streams here.
 */
export function loadForestLandmarks(scene, _state, rngOverride) {
  if (_loaded) return;
  if (!scene) return;
  _group = new THREE.Group();
  _group.name = '__forestLandmarks';

  _buildShrineMeshes();
  _buildAltarMeshes();
  _buildLogMeshes();
  _buildPulsePool();

  _group.add(_shrineBaseMesh);
  _group.add(_shrineObeliskMesh);
  _group.add(_shrineSparkleMesh);
  _group.add(_altarPedestalMesh);
  _group.add(_altarPillarMesh);
  _group.add(_altarGlowMesh);
  _group.add(_logBodyMesh);
  _group.add(_logCapAMesh);
  _group.add(_logCapBMesh);
  for (let i = 0; i < _pulseMeshes.length; i++) _group.add(_pulseMeshes[i]);

  const rand = (typeof rngOverride === 'function') ? rngOverride : _mulberry32(0xC0FFE8);

  _placeShrines(rand);
  _placeAltars(rand);
  _placeLogs(rand);

  scene.add(_group);
  _loaded = true;
}

function _spawnPulse(x, z, color, scaleEnd) {
  // Find an idle pulse mesh slot. Drop the pulse on overflow (graceful — never
  // grow the pool).
  let slot = -1;
  for (let i = 0; i < _pulseMeshes.length; i++) {
    if (!_pulseMeshes[i].visible) { slot = i; break; }
  }
  if (slot < 0) return;
  const mesh = _pulseMeshes[slot];
  mesh.position.set(x, 0.1, z);
  mesh.scale.setScalar(0.2);
  mesh.material.color.setHex(color);
  mesh.material.opacity = 0.9;
  mesh.visible = true;
  _pulseActive.push({
    slot, t: 0, life: PULSE_LIFE, scaleEnd: scaleEnd || PULSE_MAX_SCALE,
  });
}

/**
 * Per-frame: hero trigger detection + pulse FX fade. Cheap when no landmarks
 * have been loaded (early-out on _loaded). No per-spawn allocation in the
 * hot path — all state lives in pre-pooled typed arrays and the pulse pool.
 *
 * @param {number} dt
 * @param {Object} state - GameState
 */
export function tickForestLandmarks(dt, state) {
  if (!_loaded) return;
  if (!state || !state.hero || !state.hero.pos || state.gameOver) {
    // Still fade active pulses so a dead-hero frame doesn't strand them.
    _fadePulses(dt);
    return;
  }
  const hx = state.hero.pos.x;
  const hz = state.hero.pos.z;

  // Shrines — circular AABB trigger r=0.9 against base position.
  for (let i = 0; i < _shrineCount; i++) {
    if (_shrineTriggered[i]) continue;
    const sx = _shrinePos[i * 2];
    const sz = _shrinePos[i * 2 + 1];
    const dx = hx - sx;
    const dz = hz - sz;
    if (dx * dx + dz * dz <= TRIGGER_R2) {
      // Self-gate FIRST so a same-frame re-entry can't double-dispatch.
      _shrineTriggered[i] = 1;
      // Effect: +5% global damage bonus.
      if (state.run) {
        state.run._dmgGlobalBonus = (state.run._dmgGlobalBonus || 0) + 0.05;
      }
      // Floaty text — spawnHealNumber prefixes "+" but is bounded to a number.
      // Best-effort visual hint; the actual buff readout lives on the HUD.
      try { spawnHealNumber(5); } catch (_) {}
      // Telegraph pulse — palette-locked slot-6 gold.
      _spawnPulse(sx, sz, SLOT6_GOLD, 2.4);
      // Hide the sparkle ring (and shrink the obelisk slightly) to mark the
      // shrine as discovered. Base + obelisk stay visible as the "spent" form.
      _shrineSparkleMesh.setMatrixAt(i, _ZERO_MATRIX);
      _shrineSparkleMesh.instanceMatrix.needsUpdate = true;
      try { sfx.landmarkActivate && sfx.landmarkActivate(); } catch (_) {}
    }
  }

  // Altars — circular AABB trigger r=0.9 against pedestal position.
  for (let i = 0; i < _altarCount; i++) {
    if (_altarTriggered[i]) continue;
    const ax = _altarPos[i * 2];
    const az = _altarPos[i * 2 + 1];
    const dx = hx - ax;
    const dz = hz - az;
    if (dx * dx + dz * dz <= TRIGGER_R2) {
      _altarTriggered[i] = 1;
      if (state.hero) {
        state.hero.hpMax = (state.hero.hpMax || 0) + 10;
        state.hero.hp = state.hero.hpMax;
      }
      try { spawnHealNumber(10); } catch (_) {}
      _spawnPulse(ax, az, SLOT5_AMBER, 2.2);
      // Hide the base glow disc — pedestal + pillar remain as the "spent" form.
      _altarGlowMesh.setMatrixAt(i, _ZERO_MATRIX);
      _altarGlowMesh.instanceMatrix.needsUpdate = true;
      try { sfx.landmarkActivate && sfx.landmarkActivate(); } catch (_) {}
    }
  }

  // Logs — cosmetic only; no trigger pass needed.

  _fadePulses(dt);
}

function _fadePulses(dt) {
  // Walk pulses in reverse so splice doesn't skip neighbors.
  for (let i = _pulseActive.length - 1; i >= 0; i--) {
    const p = _pulseActive[i];
    p.t += dt;
    const k = p.t / p.life;
    const mesh = _pulseMeshes[p.slot];
    if (k >= 1) {
      mesh.visible = false;
      mesh.material.opacity = 0;
      _pulseActive.splice(i, 1);
      continue;
    }
    // Cubic ease-out expand + linear fade.
    const ease = 1 - Math.pow(1 - k, 3);
    const s = 0.2 + (p.scaleEnd - 0.2) * ease;
    mesh.scale.setScalar(s);
    mesh.material.opacity = 0.9 * (1 - k);
  }
}

/**
 * Tear down all landmark meshes + pulse pool. Idempotent — safe to call when
 * not loaded. Pairs with `disposeFlowWeaver`-style site in main.js teardown.
 */
export function disposeForestLandmarks(scene) {
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
  _pulseMeshes = [];
  _pulseActive = [];
  _shrineBaseMesh = _shrineObeliskMesh = _shrineSparkleMesh = null;
  _altarPedestalMesh = _altarPillarMesh = _altarGlowMesh = null;
  _logBodyMesh = _logCapAMesh = _logCapBMesh = null;
  _shrinePos = _shrineTriggered = null;
  _altarPos = _altarTriggered = null;
  _logPos = null;
  _shrineCount = _altarCount = _logCount = 0;
  _loaded = false;
}

/**
 * Read-only snapshot of placed landmark XZ centers. Returns a flat
 * array of {x, z} objects covering shrines, altars, and cosmetic logs
 * in placement order. Empty array if landmarks haven't been loaded or
 * have been disposed. Intended for sibling modules (forestCoffins.js)
 * that need a quick keep-out test against already-placed landmarks.
 *
 * Allocation: O(n) — called once at coffin placement time (not in a
 * hot path). Safe to call before/after dispose without throwing.
 *
 * @returns {Array<{x:number, z:number}>}
 */
export function getLandmarkPositions() {
  const out = [];
  if (_shrinePos && _shrineCount > 0) {
    for (let i = 0; i < _shrineCount; i++) {
      out.push({ x: _shrinePos[i * 2], z: _shrinePos[i * 2 + 1] });
    }
  }
  if (_altarPos && _altarCount > 0) {
    for (let i = 0; i < _altarCount; i++) {
      out.push({ x: _altarPos[i * 2], z: _altarPos[i * 2 + 1] });
    }
  }
  if (_logPos && _logCount > 0) {
    for (let i = 0; i < _logCount; i++) {
      out.push({ x: _logPos[i * 2], z: _logPos[i * 2 + 1] });
    }
  }
  return out;
}
