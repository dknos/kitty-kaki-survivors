/**
 * Ambient particle emitters per Forest room (PHASE 1 P1I, 2026-05-17).
 *
 * Three room-scoped emitter subtypes that add atmospheric variety without
 * affecting gameplay:
 *
 *   1. Pollen drift (glade hub)
 *      - 30-50 amber gold dust motes scattered uniformly across glade bounds.
 *      - Tiny billboard planes (PlaneGeometry 0.08x0.08), BLOOM_LAYER.
 *      - Motion: slow Y bob (sin(t*0.4 + phase)*0.5) + lazy cos horizontal sweep.
 *      - Pre-pool cap: 64.
 *
 *   2. Lantern flicker (saphollow)
 *      - 6-10 small amber gold spheres at fixed scatter positions.
 *      - SphereGeometry r=0.15, BLOOM_LAYER. Stationary placement.
 *      - "Brightness" pulse: per-instance scale modulation (mat opacity is
 *        uniform across an InstancedMesh, so scale-as-brightness is the only
 *        cheap per-instance path — additive blending sells the visual).
 *      - Pre-pool cap: 12.
 *
 *   3. Mist (glowfen)
 *      - 10-15 bone-tinted semi-transparent planes laid flat at Y=0.3-0.6.
 *      - PlaneGeometry 4x1.5, rotated -PI/2 on X. opacity 0.15-0.30.
 *      - Drift slowly in lazy curves; slow alpha proxy via scale pulse.
 *      - Z-fix from cohort 20 (ground decal): renderOrder=-1, polygonOffset.
 *      - Pre-pool cap: 16.
 *
 * ── Per-room gating (cheap early-return) ──────────────────────────────────
 * Each emitter has its own InstancedMesh. tick() reads state.run.currentRoom
 * once at top and flips mesh.visible for the off-room emitters, then
 * early-returns its advance loop. Stamped matrices persist across visibility
 * flips, so re-entering a room shows particles at their last-known positions
 * (the lazy motion masks any visual seam).
 *
 * ── Pre-pool / zero per-frame allocation ──────────────────────────────────
 * All position / phase / freq / amp arrays are Float32Array, sized to the
 * cap, allocated once at load. The hot-path tick uses a single shared
 * Object3D scratch (matches forestSigilArc / forestNeutrals pattern) for
 * stamping. No closure allocation, no Vector3.new() in tick.
 *
 * ── Seeded RNG ────────────────────────────────────────────────────────────
 * Mulberry32 with seed 0xC0FFEC — distinct from forestSigilArc (0xC0FFEB),
 * forestLandmarks (0xC0FFE8), forestNeutrals (0xC0FFEA), and forestDecor
 * (0xC0FFEE). Optional rngOverride parameter (callers pass deterministic
 * streams in tests, matches loadForestLandmarks signature).
 *
 * ── Palette (slot-locked — no new hex constants) ──────────────────────────
 *   slot 6 gold 0xd9a648 — pollen motes + lantern bodies (matches forestNeutrals
 *                            firefly, forestLandmarks shrine sparkle / altar
 *                            glow). Canonical "warm bloom" tone.
 *   slot 1 bone 0xc7b89a — mist plane sheets (matches forestLandmarks altar
 *                            pillar). Soft fog tone.
 *
 * ── Lifecycle ──────────────────────────────────────────────────────────────
 *   loadForestEmitters(scene, state, rng)   — idempotent. Wired from arenaDecor
 *                                              gated on state._emittersLoaded.
 *   tickForestEmitters(state, dt)           — per-frame. Room-gate per emitter,
 *                                              advance motion, stamp matrices.
 *   disposeForestEmitters()                  — removes scene group + geos/mats.
 *                                              Idempotent; safe across stage swaps.
 *
 * Forest-only by design: main.js gates the tick on stage.id === 'forest' so
 * non-forest stages never call us. Dispose is wired into all 5 stage-swap
 * sites in main.js to mirror sibling FE-V2 modules.
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from './postfx.js';
import { FOREST_ROOMS } from './forestRooms.js';

// ── Palette (slot-locked, no new hex) ─────────────────────────────────────
const SLOT6_GOLD = 0xd9a648; // pollen + lantern body
const SLOT1_BONE = 0xc7b89a; // mist plane sheets

// ── Pre-pool caps ──────────────────────────────────────────────────────────
const POLLEN_CAP  = 64;
const LANTERN_CAP = 12;
const MIST_CAP    = 16;

// ── Actual spawn counts (deterministic via mulberry32 0xC0FFEC) ────────────
const POLLEN_MIN  = 30; const POLLEN_MAX  = 50;
const LANTERN_MIN = 6;  const LANTERN_MAX = 10;
const MIST_MIN    = 10; const MIST_MAX    = 15;

// ── Motion tunables ────────────────────────────────────────────────────────
// Pollen — slow Y bob + lazy horizontal cos sweep, all phase-offset per-mote
// so the field reads as a drift, not a synchronized wave.
const POLLEN_Y_AMP        = 0.5;   // spec: sin(t*0.4 + phase)*0.5
const POLLEN_Y_FREQ       = 0.4;   // spec
const POLLEN_Y_BASE       = 1.6;   // overhead, above hero head (>0.5 per spec)
const POLLEN_DRIFT_AMP    = 0.6;   // horizontal lazy cos sweep amplitude (u)
const POLLEN_DRIFT_FREQ_LO = 0.15; // randomized per-instance min freq
const POLLEN_DRIFT_FREQ_HI = 0.35;
const POLLEN_SPRITE_SCALE = 1.0;   // PlaneGeometry is 0.08x0.08 already; 1x stamp

// Lantern — stationary, brightness via scale pulse (1-2Hz per spec).
const LANTERN_Y_BASE      = 1.4;   // overhead (>0.5 per spec)
const LANTERN_PULSE_LO    = 1.0;   // Hz
const LANTERN_PULSE_HI    = 2.0;   // Hz
const LANTERN_SCALE_BASE  = 1.0;   // base sphere size (geo radius 0.15)
const LANTERN_SCALE_AMP   = 0.35;  // peak swell beyond base

// Mist — lazy curve drift over ground, slow alpha proxy via scale pulse.
const MIST_Y_LO           = 0.30;  // spec range
const MIST_Y_HI           = 0.60;
const MIST_DRIFT_AMP      = 1.2;   // u of XZ wander
const MIST_DRIFT_FREQ_LO  = 0.08;
const MIST_DRIFT_FREQ_HI  = 0.18;
const MIST_PULSE_FREQ_LO  = 0.10;  // Hz scale-pulse for depth
const MIST_PULSE_FREQ_HI  = 0.22;
const MIST_SCALE_BASE     = 1.0;
const MIST_SCALE_AMP      = 0.20;  // gentle swell so patches breathe
const MIST_OPACITY        = 0.22;  // spec: 0.15-0.30, pick mid

// ── Module state ───────────────────────────────────────────────────────────
let _loaded = false;
let _scene  = null;
let _group  = null;
let _disposables = [];

// Per-emitter pose arrays (Float32Array, zero per-frame alloc).
// Pollen:
let _pollenCount   = 0;
let _pollenX       = null;  // base X
let _pollenZ       = null;  // base Z
let _pollenPhaseY  = null;  // Y bob phase
let _pollenPhaseX  = null;  // X drift phase
let _pollenPhaseZ  = null;  // Z drift phase
let _pollenFreqX   = null;  // X drift freq
let _pollenFreqZ   = null;  // Z drift freq

// Lantern:
let _lanternCount  = 0;
let _lanternX      = null;
let _lanternZ      = null;
let _lanternPhase  = null;
let _lanternFreq   = null;

// Mist:
let _mistCount     = 0;
let _mistX         = null;  // base X
let _mistZ         = null;  // base Z
let _mistY         = null;  // base Y in [0.3, 0.6]
let _mistPhaseX    = null;
let _mistPhaseZ    = null;
let _mistFreqX     = null;
let _mistFreqZ     = null;
let _mistPulseFreq = null;
let _mistPulsePhase = null;

// InstancedMeshes.
let _pollenMesh  = null;
let _lanternMesh = null;
let _mistMesh    = null;

// Shared scratch — zero per-frame allocation.
const _dummy = new THREE.Object3D();
const _zeroDummy = new THREE.Object3D();
_zeroDummy.scale.set(0, 0, 0);
_zeroDummy.updateMatrix();
const _ZERO_MATRIX = _zeroDummy.matrix.clone();

// Module clock — drives all phase math. Advanced by dt every tick.
let _clock = 0;

function _track(obj) { _disposables.push(obj); }

// ── Deterministic RNG (mulberry32, seed 0xC0FFEC) ──────────────────────────
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

// ── Mesh builders ──────────────────────────────────────────────────────────
function _buildPollenMesh() {
  // Tiny billboard plane — spec: PlaneGeometry 0.08x0.08. Three rotates the
  // plane to face +Z by default; we leave the per-instance rotation at zero
  // so the top-down camera reads each as a small upright sprite. The plane
  // is small enough that the top-down read is effectively a dot regardless
  // of facing direction (orientation differences vanish at the pixel scale).
  const geo = new THREE.PlaneGeometry(0.08, 0.08);
  const mat = new THREE.MeshBasicMaterial({
    color: SLOT6_GOLD,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, POLLEN_CAP);
  // BLOOM_LAYER per spec — pollen reads as soft gold halo against night fog.
  mesh.layers.enable(BLOOM_LAYER);
  mesh.frustumCulled = false;
  mesh.userData.emitterKind = 'pollen';
  _track(geo); _track(mat);
  return mesh;
}

function _buildLanternMesh() {
  // Small sphere — spec: SphereGeometry r=0.15. Low segments because the
  // pulse + bloom dominates the visual read; tessellation past 8 is wasted.
  const geo = new THREE.SphereGeometry(0.15, 8, 6);
  const mat = new THREE.MeshBasicMaterial({
    color: SLOT6_GOLD,
    transparent: true,
    opacity: 1.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, LANTERN_CAP);
  // BLOOM_LAYER per spec — gold pop against saphollow darker palette.
  mesh.layers.enable(BLOOM_LAYER);
  mesh.frustumCulled = false;
  mesh.userData.emitterKind = 'lantern';
  _track(geo); _track(mat);
  return mesh;
}

function _buildMistMesh() {
  // Flat plane — spec: PlaneGeometry 4x1.5 rotated -PI/2 on X so it lies
  // horizontal at Y=0.3-0.6. Bake the rotation into the geometry once so
  // per-instance dummy.rotation stays at zero (cheap stamp).
  const geo = new THREE.PlaneGeometry(4, 1.5);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: SLOT1_BONE,
    transparent: true,
    opacity: MIST_OPACITY,
    // NO additive blending — spec calls for "low-Y plane sheets" with bone
    // tone; additive would wash out to white over the dark glowfen ground.
    depthWrite: false,
    side: THREE.DoubleSide,
    // Ground-decal Z-fix from cohort 20 (echoed by forestLandmarks altar
    // glow, forestAmber). Mist sits at Y=0.3-0.6 so flicker risk vs the
    // altar glow (Y=0.01) is bounded but real where rooms overlap (mist is
    // glowfen-only; altars span all 7 rooms but never glowfen-exclusive).
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, MIST_CAP);
  // NO BLOOM_LAYER per spec ("NOT on mist (too washy)").
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  mesh.userData.emitterKind = 'mist';
  _track(geo); _track(mat);
  return mesh;
}

function _zeroInstanced(mesh, cap) {
  if (!mesh) return;
  for (let i = 0; i < cap; i++) mesh.setMatrixAt(i, _ZERO_MATRIX);
  mesh.instanceMatrix.needsUpdate = true;
}

// ── Scatter helpers ────────────────────────────────────────────────────────

/**
 * Pick a count in [lo, hi] using rng; returns integer.
 */
function _pickCount(rand, lo, hi) {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

/**
 * Uniform XZ scatter inside a room's bounds, with a small inset so motes /
 * lanterns / mist don't ride the room edge (where bounds-detect snaps the
 * hero into the adjacent corridor).
 */
function _scatterInRoom(rand, roomId, inset) {
  const r = FOREST_ROOMS[roomId];
  if (!r) return { x: 0, z: 0 };
  const minX = r.bounds.minX + inset;
  const maxX = r.bounds.maxX - inset;
  const minZ = r.bounds.minZ + inset;
  const maxZ = r.bounds.maxZ - inset;
  return {
    x: minX + rand() * (maxX - minX),
    z: minZ + rand() * (maxZ - minZ),
  };
}

// ── Placement (per-emitter) ────────────────────────────────────────────────
function _placePollen(rand) {
  _pollenCount = _pickCount(rand, POLLEN_MIN, POLLEN_MAX);
  for (let i = 0; i < _pollenCount; i++) {
    const p = _scatterInRoom(rand, 'glade', 2);
    _pollenX[i]      = p.x;
    _pollenZ[i]      = p.z;
    _pollenPhaseY[i] = rand() * Math.PI * 2;
    _pollenPhaseX[i] = rand() * Math.PI * 2;
    _pollenPhaseZ[i] = rand() * Math.PI * 2;
    _pollenFreqX[i]  = POLLEN_DRIFT_FREQ_LO
      + rand() * (POLLEN_DRIFT_FREQ_HI - POLLEN_DRIFT_FREQ_LO);
    _pollenFreqZ[i]  = POLLEN_DRIFT_FREQ_LO
      + rand() * (POLLEN_DRIFT_FREQ_HI - POLLEN_DRIFT_FREQ_LO);
    // Initial stamp at base pose so the first visible frame isn't blank.
    _dummy.position.set(_pollenX[i], POLLEN_Y_BASE, _pollenZ[i]);
    _dummy.rotation.set(0, 0, 0);
    _dummy.scale.setScalar(POLLEN_SPRITE_SCALE);
    _dummy.updateMatrix();
    _pollenMesh.setMatrixAt(i, _dummy.matrix);
  }
  _pollenMesh.instanceMatrix.needsUpdate = true;
}

function _placeLanterns(rand) {
  _lanternCount = _pickCount(rand, LANTERN_MIN, LANTERN_MAX);
  for (let i = 0; i < _lanternCount; i++) {
    const p = _scatterInRoom(rand, 'saphollow', 3);
    _lanternX[i]     = p.x;
    _lanternZ[i]     = p.z;
    _lanternPhase[i] = rand() * Math.PI * 2;
    _lanternFreq[i]  = LANTERN_PULSE_LO
      + rand() * (LANTERN_PULSE_HI - LANTERN_PULSE_LO);
    _dummy.position.set(_lanternX[i], LANTERN_Y_BASE, _lanternZ[i]);
    _dummy.rotation.set(0, 0, 0);
    _dummy.scale.setScalar(LANTERN_SCALE_BASE);
    _dummy.updateMatrix();
    _lanternMesh.setMatrixAt(i, _dummy.matrix);
  }
  _lanternMesh.instanceMatrix.needsUpdate = true;
}

function _placeMist(rand) {
  _mistCount = _pickCount(rand, MIST_MIN, MIST_MAX);
  for (let i = 0; i < _mistCount; i++) {
    const p = _scatterInRoom(rand, 'glowfen', 3);
    _mistX[i]          = p.x;
    _mistZ[i]          = p.z;
    _mistY[i]          = MIST_Y_LO + rand() * (MIST_Y_HI - MIST_Y_LO);
    _mistPhaseX[i]     = rand() * Math.PI * 2;
    _mistPhaseZ[i]     = rand() * Math.PI * 2;
    _mistFreqX[i]      = MIST_DRIFT_FREQ_LO
      + rand() * (MIST_DRIFT_FREQ_HI - MIST_DRIFT_FREQ_LO);
    _mistFreqZ[i]      = MIST_DRIFT_FREQ_LO
      + rand() * (MIST_DRIFT_FREQ_HI - MIST_DRIFT_FREQ_LO);
    _mistPulseFreq[i]  = MIST_PULSE_FREQ_LO
      + rand() * (MIST_PULSE_FREQ_HI - MIST_PULSE_FREQ_LO);
    _mistPulsePhase[i] = rand() * Math.PI * 2;
    _dummy.position.set(_mistX[i], _mistY[i], _mistZ[i]);
    _dummy.rotation.set(0, 0, 0);
    _dummy.scale.setScalar(MIST_SCALE_BASE);
    _dummy.updateMatrix();
    _mistMesh.setMatrixAt(i, _dummy.matrix);
  }
  _mistMesh.instanceMatrix.needsUpdate = true;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Idempotent load. Builds 3 InstancedMeshes (one per emitter subtype),
 * scatters initial positions deterministically via mulberry32(0xC0FFEC),
 * and adds them to the scene under a single named group for easy teardown.
 *
 * @param {THREE.Scene} scene
 * @param {Object} _state - unused; reserved for future hooks (signature
 *                          mirrors loadForestLandmarks for consistency with
 *                          the arenaDecor fan-out call shape).
 * @param {Function} [rngOverride] - optional rng for deterministic tests.
 */
export function loadForestEmitters(scene, _state, rngOverride) {
  if (_loaded) return;
  if (!scene) return;
  _scene = scene;
  _group = new THREE.Group();
  _group.name = '__forestEmitters';

  // Allocate all per-instance pose arrays sized to the cap (zero alloc in
  // the hot path; off-room slots stay at base pose).
  _pollenX      = new Float32Array(POLLEN_CAP);
  _pollenZ      = new Float32Array(POLLEN_CAP);
  _pollenPhaseY = new Float32Array(POLLEN_CAP);
  _pollenPhaseX = new Float32Array(POLLEN_CAP);
  _pollenPhaseZ = new Float32Array(POLLEN_CAP);
  _pollenFreqX  = new Float32Array(POLLEN_CAP);
  _pollenFreqZ  = new Float32Array(POLLEN_CAP);

  _lanternX     = new Float32Array(LANTERN_CAP);
  _lanternZ     = new Float32Array(LANTERN_CAP);
  _lanternPhase = new Float32Array(LANTERN_CAP);
  _lanternFreq  = new Float32Array(LANTERN_CAP);

  _mistX          = new Float32Array(MIST_CAP);
  _mistZ          = new Float32Array(MIST_CAP);
  _mistY          = new Float32Array(MIST_CAP);
  _mistPhaseX     = new Float32Array(MIST_CAP);
  _mistPhaseZ     = new Float32Array(MIST_CAP);
  _mistFreqX      = new Float32Array(MIST_CAP);
  _mistFreqZ      = new Float32Array(MIST_CAP);
  _mistPulseFreq  = new Float32Array(MIST_CAP);
  _mistPulsePhase = new Float32Array(MIST_CAP);

  _pollenMesh  = _buildPollenMesh();
  _lanternMesh = _buildLanternMesh();
  _mistMesh    = _buildMistMesh();
  _group.add(_pollenMesh);
  _group.add(_lanternMesh);
  _group.add(_mistMesh);
  _zeroInstanced(_pollenMesh,  POLLEN_CAP);
  _zeroInstanced(_lanternMesh, LANTERN_CAP);
  _zeroInstanced(_mistMesh,    MIST_CAP);

  const rand = (typeof rngOverride === 'function')
    ? rngOverride
    : _mulberry32(0xC0FFEC);

  _placePollen(rand);
  _placeLanterns(rand);
  _placeMist(rand);

  // Start with everything hidden — the per-room visibility gate in tick()
  // flips the appropriate mesh on the first frame currentRoom matches.
  // Avoids a 1-frame flash of every emitter at boot.
  _pollenMesh.visible  = false;
  _lanternMesh.visible = false;
  _mistMesh.visible    = false;

  scene.add(_group);
  _loaded = true;
}

/**
 * Per-frame tick. Each emitter:
 *   1. Toggle mesh.visible based on state.run.currentRoom match.
 *   2. If off-room, early-return without stamping (visibility=false alone
 *      already skips the GL draw; skipping stamp avoids the matrix update).
 *   3. If on-room, advance phase math + stamp matrices.
 *
 * Reusable scratch _dummy + _ZERO_MATRIX mean zero per-frame allocation.
 *
 * @param {Object} state
 * @param {number} dt — paused-aware logic seconds (mirrors every other
 *                       forest-only tick in main.js).
 */
export function tickForestEmitters(state, dt) {
  if (!_loaded) return;
  if (dt == null || !isFinite(dt) || dt < 0) dt = 0;
  _clock += dt;

  const room = (state && state.run && state.run.currentRoom) || null;

  // ── Pollen (glade) ───────────────────────────────────────────────────
  if (room === 'glade') {
    if (!_pollenMesh.visible) _pollenMesh.visible = true;
    for (let i = 0; i < _pollenCount; i++) {
      const y = POLLEN_Y_BASE + Math.sin(_clock * POLLEN_Y_FREQ + _pollenPhaseY[i]) * POLLEN_Y_AMP;
      const x = _pollenX[i]
        + Math.cos(_clock * _pollenFreqX[i] + _pollenPhaseX[i]) * POLLEN_DRIFT_AMP;
      const z = _pollenZ[i]
        + Math.sin(_clock * _pollenFreqZ[i] + _pollenPhaseZ[i]) * POLLEN_DRIFT_AMP;
      _dummy.position.set(x, y, z);
      _dummy.rotation.set(0, 0, 0);
      _dummy.scale.setScalar(POLLEN_SPRITE_SCALE);
      _dummy.updateMatrix();
      _pollenMesh.setMatrixAt(i, _dummy.matrix);
    }
    _pollenMesh.instanceMatrix.needsUpdate = true;
  } else if (_pollenMesh.visible) {
    _pollenMesh.visible = false;
  }

  // ── Lanterns (saphollow) ─────────────────────────────────────────────
  if (room === 'saphollow') {
    if (!_lanternMesh.visible) _lanternMesh.visible = true;
    for (let i = 0; i < _lanternCount; i++) {
      // Per-instance brightness pulse. InstancedMesh material.opacity is
      // shared across instances, so we use scale-as-brightness with
      // additive blending — the same trick forestSigilArc uses for trail
      // dot fades. Phase-offset per-lantern gives the desynced flicker.
      const pulse = Math.sin(_clock * Math.PI * 2 * _lanternFreq[i] + _lanternPhase[i]);
      const scale = LANTERN_SCALE_BASE + pulse * LANTERN_SCALE_AMP;
      _dummy.position.set(_lanternX[i], LANTERN_Y_BASE, _lanternZ[i]);
      _dummy.rotation.set(0, 0, 0);
      _dummy.scale.setScalar(scale);
      _dummy.updateMatrix();
      _lanternMesh.setMatrixAt(i, _dummy.matrix);
    }
    _lanternMesh.instanceMatrix.needsUpdate = true;
  } else if (_lanternMesh.visible) {
    _lanternMesh.visible = false;
  }

  // ── Mist (glowfen) ───────────────────────────────────────────────────
  if (room === 'glowfen') {
    if (!_mistMesh.visible) _mistMesh.visible = true;
    for (let i = 0; i < _mistCount; i++) {
      const x = _mistX[i]
        + Math.cos(_clock * _mistFreqX[i] + _mistPhaseX[i]) * MIST_DRIFT_AMP;
      const z = _mistZ[i]
        + Math.sin(_clock * _mistFreqZ[i] + _mistPhaseZ[i]) * MIST_DRIFT_AMP;
      // Slow scale "breath" sells the alpha pulse for depth — per-instance
      // material opacity isn't a thing on InstancedMesh, so scale serves as
      // the depth-pulse proxy (the same scale-fade trick used by the pollen
      // and lantern emitters here, and by forestSigilArc trail dots).
      const pulse = Math.sin(_clock * Math.PI * 2 * _mistPulseFreq[i] + _mistPulsePhase[i]);
      const scale = MIST_SCALE_BASE + pulse * MIST_SCALE_AMP;
      _dummy.position.set(x, _mistY[i], z);
      _dummy.rotation.set(0, 0, 0);
      _dummy.scale.setScalar(scale);
      _dummy.updateMatrix();
      _mistMesh.setMatrixAt(i, _dummy.matrix);
    }
    _mistMesh.instanceMatrix.needsUpdate = true;
  } else if (_mistMesh.visible) {
    _mistMesh.visible = false;
  }
}

/**
 * Dispose: scene group + every tracked geometry/material. Idempotent across
 * stage swaps. Matches the disposeForestSigilArc shape so main.js teardown
 * blocks can call us with no scene argument.
 */
export function disposeForestEmitters() {
  if (!_loaded && !_group) return;
  if (_group) {
    if (_scene && _group.parent === _scene) _scene.remove(_group);
    else if (_group.parent) _group.parent.remove(_group);
    _group = null;
  }
  for (let i = 0; i < _disposables.length; i++) {
    try { _disposables[i].dispose && _disposables[i].dispose(); } catch (_) {}
  }
  _disposables = [];

  _pollenMesh = _lanternMesh = _mistMesh = null;
  _pollenX = _pollenZ = _pollenPhaseY = _pollenPhaseX = _pollenPhaseZ = null;
  _pollenFreqX = _pollenFreqZ = null;
  _pollenCount = 0;

  _lanternX = _lanternZ = _lanternPhase = _lanternFreq = null;
  _lanternCount = 0;

  _mistX = _mistZ = _mistY = null;
  _mistPhaseX = _mistPhaseZ = _mistFreqX = _mistFreqZ = null;
  _mistPulseFreq = _mistPulsePhase = null;
  _mistCount = 0;

  _clock = 0;
  _scene = null;
  _loaded = false;
}
