/**
 * Forest Roaming Neutrals — ambient life density (FE-V2-A4, 2026-05-17).
 *
 * Three NON-COMBAT entity types that ship visual flavor only. No XP drops,
 * no damage dealt or received, no progression interaction. They exist to
 * make the forest rooms feel inhabited so the player isn't always staring
 * at trees + enemies + landmarks.
 *
 *   1. Fireflies (`firefly_drift`) — tiny gold dots drifting in lazy curves.
 *      Pre-pooled InstancedMesh cap 192 (24 per room × 7 rooms = 168 max),
 *      slot-6 amber (0xd9a648), additive + BLOOM_LAYER. Position is a Lissajous
 *      curve around a per-instance center; zero per-frame allocation.
 *   2. Deer (`deer_passive`) — low-poly silhouettes wandering each room.
 *      State machine GRAZING → WALKING → FLEEING (proximity-driven flee when
 *      hero within 4u). Pre-pooled InstancedMesh cap 16 (1-2 per room × 7
 *      rooms = 14 max). NO collision — hero passes through; deer just decorate.
 *   3. Owls (`owl_perched`) — small rounded silhouettes atop existing landmark
 *      perches. Stationary; eyes blink every 3-5s, blink rate doubles when
 *      hero within 2u. Pre-pooled InstancedMesh cap 8 (1 per available perch,
 *      capped at 4 per stage).
 *
 * Lifecycle:
 *   loadForestNeutrals(scene, state, rngOverride?) — build pre-pooled meshes
 *     and scatter neutrals across all 7 forest rooms. Idempotent.
 *   tickForestNeutrals(state, dt) — per-frame: drift fireflies, advance deer
 *     state machines, blink owl eyes. Cheap when not loaded.
 *   disposeForestNeutrals(scene) — tear down all meshes + clear pool state.
 *
 * Seed: `_mulberry32(0xC0FFEA)` — distinct from forestLandmarks (0xC0FFE8)
 * and forestCoffins (0xC0FFE9) so neutral placements don't correlate with
 * either set.
 *
 * Palette (slot-locked — no new hex constants):
 *   slot 1 #c7b89a — bone (deer body alt; not used by default — slot 3 wins)
 *   slot 3 #6b4f3a — earth brown (deer body, deer head/antlers tint)
 *   slot 4 #4a3220 — dark brown (deer legs, owl body)
 *   slot 6 #d9a648 — gold/amber (firefly dot, owl eyes)
 *
 * Constraints honored:
 *   - Static imports only (no dynamic import in hot path or load path).
 *   - Pre-pooled InstancedMesh per visual component. Zero allocation in tick.
 *   - Reusable scratch Object3D / Matrix4 / Vector3.
 *   - Bloom layer: ONLY firefly dots. Deer + owl bodies stay off-bloom so a
 *     low-bloom hardware path doesn't have flickering corner-eye distractions.
 *   - Per-instance `instanceMatrix.needsUpdate` flagged ONCE per frame per
 *     mesh (after the inner loop), not per instance.
 *   - Owl placement defensively skips rooms with no landmark perches — never
 *     throws (logs a single warning if all rooms lack perches, then continues).
 *
 * Contract ambiguity resolved:
 *   The brief asks owls to perch on "log positions" from
 *   `getLandmarkPositions()`. The helper returns shrines+altars+logs UNTAGGED
 *   (no kind field). Per the agent edit boundary ("DO NOT EDIT ...
 *   landmarks/coffins file"), we treat any landmark position as a valid
 *   perch and rely on the cap-of-4-per-stage rule to control density.
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from './postfx.js';
import { FOREST_ROOMS, FOREST_PORTAL_POSITIONS } from './forestRooms.js';
import { getLandmarkPositions } from './forestLandmarks.js';
import { state as _gameState } from './state.js';

// ── pool caps ────────────────────────────────────────────────────────────────
const CAP_FIREFLIES = 192;  // 24 per room × 7 rooms = 168 max, 192 headroom
const CAP_DEER      = 16;   // 2 per room × 7 rooms = 14 max, 16 headroom
const CAP_OWLS      = 8;    // 1 per perch capped at 4 per stage; 8 headroom

// Per-room ranges (inclusive lo, exclusive hi via floor).
const FIREFLIES_PER_ROOM_MIN = 12;
const FIREFLIES_PER_ROOM_MAX = 24;   // resolved to floor(min + rand * (max-min+1))
const DEER_PER_ROOM_MIN      = 1;
const DEER_PER_ROOM_MAX      = 2;
const OWLS_PER_STAGE_CAP     = 4;

// ── palette (slots already used by forestLandmarks.js — no new constants) ────
const SLOT3_BROWN = 0x6b4f3a; // deer body
const SLOT4_DARK  = 0x4a3220; // deer legs, owl body
const SLOT6_GOLD  = 0xd9a648; // firefly dot, owl eyes

// ── keep-out (mirrors coffins + landmarks for consistency) ───────────────────
// Deer wander — only deer obey these (their FLEEING vector is clamped to
// room bounds AND nudged out of keep-out zones via simple deflect). Fireflies
// and owls don't walk so they only honor keep-out at placement time.
const LOCKDOWN = { x: 1.0, z: -28.0, r2: (8 + 2) * (8 + 2) }; // r=10
const TRAP_SHARDS = [
  { x: -1.0, z: 19.0, r2: (1.6 + 2) * (1.6 + 2) },
  { x: -1.0, z: 22.0, r2: (1.6 + 2) * (1.6 + 2) },
  { x: -1.0, z: 25.0, r2: (1.6 + 2) * (1.6 + 2) },
];
const PORTAL_KEEPOUT_R2 = 2 * 2;

// ── deer state-machine codes ─────────────────────────────────────────────────
const ST_GRAZING  = 0;
const ST_WALKING  = 1;
const ST_FLEEING  = 2;

// ── tunables ─────────────────────────────────────────────────────────────────
const DEER_WALK_SPEED   = 1.5;  // u/s during ST_WALKING
const DEER_FLEE_SPEED   = 5.0;  // u/s during ST_FLEEING
const DEER_FLEE_TRIGGER = 4.0;  // hero within this distance → flee
const DEER_FLEE_R2      = DEER_FLEE_TRIGGER * DEER_FLEE_TRIGGER;
const DEER_FLEE_DURATION  = 2.0;  // seconds of flee before returning to GRAZING
const DEER_GRAZE_MIN_DUR  = 4.0;  // GRAZING duration lo
const DEER_GRAZE_MAX_DUR  = 8.0;  // GRAZING duration hi
const DEER_ARRIVE_R2      = 0.04; // 0.2u² — close enough to call "arrived"
const DEER_HEAD_BOB_HZ    = 0.6;
const DEER_HEAD_BOB_AMP   = 0.04;
const DEER_INSET          = 2.0;  // bounds inset for placement + walk targets

const FIREFLY_BOB_Y_AMP = 0.3;
const FIREFLY_INSET     = 2.0;
const FIREFLY_BASE_Y    = 1.1;    // base hover height
const FIREFLY_Y_JITTER  = 0.4;    // ±jitter on top of base_y

const OWL_PROXIMITY_R2  = 2.0 * 2.0;  // hero within 2u → blink faster
const OWL_BLINK_MIN_GAP = 3.0;
const OWL_BLINK_MAX_GAP = 5.0;
const OWL_BLINK_DUR     = 0.1;  // half-blink time (0.1 down, 0.1 up = 0.2s total)
const OWL_PERCH_Y       = 0.85; // sit atop a log at ~y=0.4 body + 0.25 radius + clearance

// ── module state ─────────────────────────────────────────────────────────────
let _loaded = false;
let _group = null;
let _disposables = [];

// Fireflies — drift in Lissajous curves. All state in typed arrays.
let _fireflyCount = 0;
let _fireflyMesh  = null;             // InstancedMesh of tiny billboard plane
let _fireflyCenter = null;            // Float32Array [cx, cy, cz, ...]
let _fireflyPhase  = null;            // Float32Array per-instance phase offset
let _fireflyRadius = null;            // Float32Array per-instance drift radius
let _fireflyVSpeed = null;            // Float32Array per-instance angular speed (rad/s)

// Deer — state-machine + pooled mesh per body component.
let _deerCount = 0;
let _deerBodyMesh = null;             // InstancedMesh
let _deerLegFLMesh = null;
let _deerLegFRMesh = null;
let _deerLegBLMesh = null;
let _deerLegBRMesh = null;
let _deerHeadMesh = null;
let _deerAntlerLMesh = null;
let _deerAntlerRMesh = null;
let _deerPos = null;                  // Float32Array [x, z, ...]
let _deerYaw = null;                  // Float32Array per-instance facing
let _deerState = null;                // Uint8Array per-instance state code
let _deerStateT = null;               // Float32Array — elapsed in current state
let _deerStateDur = null;             // Float32Array — duration of current state
let _deerTargetX = null;              // Float32Array — walk target X
let _deerTargetZ = null;              // Float32Array — walk target Z
let _deerVx = null;                   // Float32Array — current velocity x (for flee)
let _deerVz = null;                   // Float32Array — current velocity z
let _deerRoom = null;                 // Uint8Array — index into _roomList for bounds clamp

// Owls — stationary, blink only.
let _owlCount = 0;
let _owlBodyMesh = null;              // InstancedMesh — body sphere
let _owlEyeLMesh = null;              // InstancedMesh — left eye (tiny circle)
let _owlEyeRMesh = null;              // InstancedMesh — right eye
let _owlPos = null;                   // Float32Array [x, z, ...]
let _owlYaw = null;                   // Float32Array — facing
let _owlBlinkT = null;                // Float32Array — elapsed since last blink trigger
let _owlBlinkGap = null;              // Float32Array — gap until next blink
let _owlBlinkPhase = null;            // Float32Array — 0..1 inside an active blink (-1 = idle)

// Per-room metadata snapshot (for deer bounds clamp; small object array OK
// because it's only walked when a deer is in ST_FLEEING or starts a new walk).
let _roomList = [];                   // [{ minX, maxX, minZ, maxZ }, ...]

// Reusable scratch (no allocations in hot path)
const _dummy = new THREE.Object3D();
const _zeroDummy = new THREE.Object3D();
_zeroDummy.scale.set(0, 0, 0);
_zeroDummy.updateMatrix();
const _ZERO_MATRIX = _zeroDummy.matrix.clone();

// Shared module clock so curves stay continuous across re-stamps.
let _animClock = 0;

// ── deterministic RNG (mulberry32, fresh seed 0xC0FFEA) ─────────────────────
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

function _track(obj) { _disposables.push(obj); }

// ── keep-out test (deer walk targets + initial placement) ────────────────────
function _isInKeepout(x, z) {
  let dx = x - LOCKDOWN.x;
  let dz = z - LOCKDOWN.z;
  if (dx * dx + dz * dz < LOCKDOWN.r2) return true;
  for (let i = 0; i < TRAP_SHARDS.length; i++) {
    const s = TRAP_SHARDS[i];
    dx = x - s.x;
    dz = z - s.z;
    if (dx * dx + dz * dz < s.r2) return true;
  }
  for (const k in FOREST_PORTAL_POSITIONS) {
    const p = FOREST_PORTAL_POSITIONS[k];
    dx = x - p.x;
    dz = z - p.z;
    if (dx * dx + dz * dz < PORTAL_KEEPOUT_R2) return true;
  }
  return false;
}

function _tryPickSpot(room, rand, attempts, inset) {
  const minX = room.bounds.minX + inset;
  const maxX = room.bounds.maxX - inset;
  const minZ = room.bounds.minZ + inset;
  const maxZ = room.bounds.maxZ - inset;
  if (maxX <= minX || maxZ <= minZ) return null;
  for (let a = 0; a < attempts; a++) {
    const x = minX + rand() * (maxX - minX);
    const z = minZ + rand() * (maxZ - minZ);
    if (!_isInKeepout(x, z)) return { x, z };
  }
  return null;
}

function _clampToRoom(x, z, roomIdx) {
  const r = _roomList[roomIdx];
  if (!r) return { x, z };
  let cx = x, cz = z;
  if (cx < r.minX + DEER_INSET) cx = r.minX + DEER_INSET;
  else if (cx > r.maxX - DEER_INSET) cx = r.maxX - DEER_INSET;
  if (cz < r.minZ + DEER_INSET) cz = r.minZ + DEER_INSET;
  else if (cz > r.maxZ - DEER_INSET) cz = r.maxZ - DEER_INSET;
  return { x: cx, z: cz };
}

// ── mesh builders ────────────────────────────────────────────────────────────
function _buildFireflyMesh() {
  // Billboard plane facing screen; cylinder billboard keeps the dot upright
  // without per-frame matrix manipulation. ShaderMaterial would be nicer but
  // a tiny MeshBasicMaterial w/ additive blending + bloom looks identical at
  // this size (0.08²) and adds zero shader compile cost.
  const geo = new THREE.PlaneGeometry(0.08, 0.08);
  const mat = new THREE.MeshBasicMaterial({
    color: SLOT6_GOLD,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  _fireflyMesh = new THREE.InstancedMesh(geo, mat, CAP_FIREFLIES);
  _fireflyMesh.layers.enable(BLOOM_LAYER);
  _fireflyMesh.userData.neutralKind = 'firefly';
  _fireflyMesh.frustumCulled = false; // small scattered dots — culling cost > render cost
  _track(geo); _track(mat);
}

function _buildDeerMeshes() {
  // Body — 0.4 × 0.6 × 0.9 box, slot-3 brown.
  const bodyGeo = new THREE.BoxGeometry(0.4, 0.6, 0.9);
  const bodyMat = new THREE.MeshStandardMaterial({
    color: SLOT3_BROWN, roughness: 0.9, metalness: 0.02, flatShading: true,
  });
  _deerBodyMesh = new THREE.InstancedMesh(bodyGeo, bodyMat, CAP_DEER);
  _deerBodyMesh.userData.neutralKind = 'deer_body';
  _track(bodyGeo); _track(bodyMat);

  // Legs — 4 instanced meshes (one per corner) share geometry but each
  // tracks an independent matrix so the dummy local offsets are explicit
  // and easy to tweak. Slot-4 dark.
  const legGeo = new THREE.BoxGeometry(0.08, 0.4, 0.08);
  const legMat = new THREE.MeshStandardMaterial({
    color: SLOT4_DARK, roughness: 0.95, metalness: 0.02, flatShading: true,
  });
  _deerLegFLMesh = new THREE.InstancedMesh(legGeo, legMat, CAP_DEER);
  _deerLegFRMesh = new THREE.InstancedMesh(legGeo, legMat, CAP_DEER);
  _deerLegBLMesh = new THREE.InstancedMesh(legGeo, legMat, CAP_DEER);
  _deerLegBRMesh = new THREE.InstancedMesh(legGeo, legMat, CAP_DEER);
  _deerLegFLMesh.userData.neutralKind = 'deer_leg';
  _deerLegFRMesh.userData.neutralKind = 'deer_leg';
  _deerLegBLMesh.userData.neutralKind = 'deer_leg';
  _deerLegBRMesh.userData.neutralKind = 'deer_leg';
  _track(legGeo); _track(legMat);

  // Head — small box at front-top, slot-3 brown (same material as body works
  // visually — minor pop is acceptable for ambient decor).
  const headGeo = new THREE.BoxGeometry(0.25, 0.25, 0.3);
  const headMat = new THREE.MeshStandardMaterial({
    color: SLOT3_BROWN, roughness: 0.9, metalness: 0.02, flatShading: true,
  });
  _deerHeadMesh = new THREE.InstancedMesh(headGeo, headMat, CAP_DEER);
  _deerHeadMesh.userData.neutralKind = 'deer_head';
  _track(headGeo); _track(headMat);

  // Antlers — 2 tiny vertical cylinders. CylinderGeometry default axis is +Y.
  // Slot-4 dark so they read against forest green.
  const antGeo = new THREE.CylinderGeometry(0.02, 0.04, 0.3, 6);
  const antMat = new THREE.MeshStandardMaterial({
    color: SLOT4_DARK, roughness: 0.9, metalness: 0.02, flatShading: true,
  });
  _deerAntlerLMesh = new THREE.InstancedMesh(antGeo, antMat, CAP_DEER);
  _deerAntlerRMesh = new THREE.InstancedMesh(antGeo, antMat, CAP_DEER);
  _deerAntlerLMesh.userData.neutralKind = 'deer_antler';
  _deerAntlerRMesh.userData.neutralKind = 'deer_antler';
  _track(antGeo); _track(antMat);
}

function _buildOwlMeshes() {
  // Body — small sphere, slot-4 dark.
  const bodyGeo = new THREE.SphereGeometry(0.25, 10, 8);
  const bodyMat = new THREE.MeshStandardMaterial({
    color: SLOT4_DARK, roughness: 0.85, metalness: 0.05, flatShading: true,
  });
  _owlBodyMesh = new THREE.InstancedMesh(bodyGeo, bodyMat, CAP_OWLS);
  _owlBodyMesh.userData.neutralKind = 'owl_body';
  _track(bodyGeo); _track(bodyMat);

  // Eyes — tiny CircleGeometry, slot-6 gold + additive. Bloom-eligible? The
  // brief says "Eyes blink every 3-5s ... amber eyes". Keep OFF bloom — they
  // should glow softly, not punch holes in the bloom mask. (Compare to coffin
  // sparkle which IS on bloom; eyes are 0.04 vs sparkle 0.55 — too small to
  // bloom cleanly anyway.)
  const eyeGeo = new THREE.CircleGeometry(0.04, 8);
  const eyeMat = new THREE.MeshBasicMaterial({
    color: SLOT6_GOLD,
    transparent: true,
    opacity: 0.95,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  _owlEyeLMesh = new THREE.InstancedMesh(eyeGeo, eyeMat, CAP_OWLS);
  _owlEyeRMesh = new THREE.InstancedMesh(eyeGeo, eyeMat, CAP_OWLS);
  _owlEyeLMesh.userData.neutralKind = 'owl_eye';
  _owlEyeRMesh.userData.neutralKind = 'owl_eye';
  _track(eyeGeo); _track(eyeMat);
}

// ── placement ────────────────────────────────────────────────────────────────
function _placeFireflies(rand) {
  _fireflyCenter = new Float32Array(CAP_FIREFLIES * 3); // (cx, cy, cz)
  _fireflyPhase  = new Float32Array(CAP_FIREFLIES);
  _fireflyRadius = new Float32Array(CAP_FIREFLIES);
  _fireflyVSpeed = new Float32Array(CAP_FIREFLIES);

  let idx = 0;
  for (const roomId in FOREST_ROOMS) {
    if (idx >= CAP_FIREFLIES) break;
    const room = FOREST_ROOMS[roomId];
    if (!room) continue;
    const span = FIREFLIES_PER_ROOM_MAX - FIREFLIES_PER_ROOM_MIN + 1;
    const n = FIREFLIES_PER_ROOM_MIN + ((rand() * span) | 0);
    for (let i = 0; i < n && idx < CAP_FIREFLIES; i++) {
      const spot = _tryPickSpot(room, rand, 12, FIREFLY_INSET);
      if (!spot) continue;
      const cy = FIREFLY_BASE_Y + (rand() * 2 - 1) * FIREFLY_Y_JITTER;
      _fireflyCenter[idx * 3 + 0] = spot.x;
      _fireflyCenter[idx * 3 + 1] = cy;
      _fireflyCenter[idx * 3 + 2] = spot.z;
      _fireflyPhase[idx]  = rand() * Math.PI * 2;
      _fireflyRadius[idx] = 0.4 + rand() * 0.6; // 0.4..1.0u drift radius
      _fireflyVSpeed[idx] = 0.5 + rand() * 0.7; // 0.5..1.2 rad/s
      idx++;
    }
  }
  _fireflyCount = idx;

  // Zero out unused slots so stray identity matrices don't render.
  for (let i = _fireflyCount; i < CAP_FIREFLIES; i++) {
    _fireflyMesh.setMatrixAt(i, _ZERO_MATRIX);
  }
  // Stamp initial pose (t=0) for placed fireflies so the first frame renders.
  _restampFireflies(0);
  _fireflyMesh.instanceMatrix.needsUpdate = true;
}

function _placeDeer(rand) {
  _deerPos       = new Float32Array(CAP_DEER * 2);
  _deerYaw       = new Float32Array(CAP_DEER);
  _deerState     = new Uint8Array(CAP_DEER);
  _deerStateT    = new Float32Array(CAP_DEER);
  _deerStateDur  = new Float32Array(CAP_DEER);
  _deerTargetX   = new Float32Array(CAP_DEER);
  _deerTargetZ   = new Float32Array(CAP_DEER);
  _deerVx        = new Float32Array(CAP_DEER);
  _deerVz        = new Float32Array(CAP_DEER);
  _deerRoom      = new Uint8Array(CAP_DEER);

  let idx = 0;
  let roomIdx = 0;
  for (const roomId in FOREST_ROOMS) {
    if (idx >= CAP_DEER) break;
    const room = FOREST_ROOMS[roomId];
    if (!room) { roomIdx++; continue; }
    const span = DEER_PER_ROOM_MAX - DEER_PER_ROOM_MIN + 1;
    const n = DEER_PER_ROOM_MIN + ((rand() * span) | 0);
    for (let i = 0; i < n && idx < CAP_DEER; i++) {
      const spot = _tryPickSpot(room, rand, 24, DEER_INSET);
      if (!spot) continue;
      _deerPos[idx * 2 + 0] = spot.x;
      _deerPos[idx * 2 + 1] = spot.z;
      _deerYaw[idx] = rand() * Math.PI * 2;
      _deerState[idx] = ST_GRAZING;
      _deerStateT[idx] = 0;
      _deerStateDur[idx] = DEER_GRAZE_MIN_DUR + rand() * (DEER_GRAZE_MAX_DUR - DEER_GRAZE_MIN_DUR);
      _deerTargetX[idx] = spot.x;
      _deerTargetZ[idx] = spot.z;
      _deerVx[idx] = 0;
      _deerVz[idx] = 0;
      _deerRoom[idx] = roomIdx & 0xff;
      idx++;
    }
    roomIdx++;
  }
  _deerCount = idx;

  // Zero out unused slots.
  for (let i = _deerCount; i < CAP_DEER; i++) {
    _deerBodyMesh.setMatrixAt(i, _ZERO_MATRIX);
    _deerLegFLMesh.setMatrixAt(i, _ZERO_MATRIX);
    _deerLegFRMesh.setMatrixAt(i, _ZERO_MATRIX);
    _deerLegBLMesh.setMatrixAt(i, _ZERO_MATRIX);
    _deerLegBRMesh.setMatrixAt(i, _ZERO_MATRIX);
    _deerHeadMesh.setMatrixAt(i, _ZERO_MATRIX);
    _deerAntlerLMesh.setMatrixAt(i, _ZERO_MATRIX);
    _deerAntlerRMesh.setMatrixAt(i, _ZERO_MATRIX);
  }
  // Stamp initial matrices.
  for (let i = 0; i < _deerCount; i++) {
    _stampDeer(i, 0);
  }
  _deerBodyMesh.instanceMatrix.needsUpdate = true;
  _deerLegFLMesh.instanceMatrix.needsUpdate = true;
  _deerLegFRMesh.instanceMatrix.needsUpdate = true;
  _deerLegBLMesh.instanceMatrix.needsUpdate = true;
  _deerLegBRMesh.instanceMatrix.needsUpdate = true;
  _deerHeadMesh.instanceMatrix.needsUpdate = true;
  _deerAntlerLMesh.instanceMatrix.needsUpdate = true;
  _deerAntlerRMesh.instanceMatrix.needsUpdate = true;
}

function _placeOwls(rand) {
  _owlPos        = new Float32Array(CAP_OWLS * 2);
  _owlYaw        = new Float32Array(CAP_OWLS);
  _owlBlinkT     = new Float32Array(CAP_OWLS);
  _owlBlinkGap   = new Float32Array(CAP_OWLS);
  _owlBlinkPhase = new Float32Array(CAP_OWLS);

  // Snapshot landmark positions. Brief asked for "log positions" but the
  // helper returns shrines+altars+logs untagged — we treat all landmarks as
  // perchable and let the per-stage cap of 4 keep density right. Documented
  // up top.
  let perches = [];
  try { perches = getLandmarkPositions(); } catch (_) { perches = []; }
  if (!perches || perches.length === 0) {
    console.warn('[forestNeutrals] no landmark perches available — owls skipped');
    _owlCount = 0;
    for (let i = 0; i < CAP_OWLS; i++) {
      _owlBodyMesh.setMatrixAt(i, _ZERO_MATRIX);
      _owlEyeLMesh.setMatrixAt(i, _ZERO_MATRIX);
      _owlEyeRMesh.setMatrixAt(i, _ZERO_MATRIX);
    }
    _owlBodyMesh.instanceMatrix.needsUpdate = true;
    _owlEyeLMesh.instanceMatrix.needsUpdate = true;
    _owlEyeRMesh.instanceMatrix.needsUpdate = true;
    return;
  }

  // Fisher-Yates shuffle (in-place, deterministic via rand). We only need
  // the first OWLS_PER_STAGE_CAP after shuffle so we can cap and bail.
  const picked = perches.slice(); // copy — we mutate
  for (let i = picked.length - 1; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    const tmp = picked[i]; picked[i] = picked[j]; picked[j] = tmp;
  }

  let idx = 0;
  const targetCount = Math.min(picked.length, OWLS_PER_STAGE_CAP, CAP_OWLS);
  for (let i = 0; i < targetCount; i++) {
    const p = picked[i];
    if (!p || typeof p.x !== 'number' || typeof p.z !== 'number') continue;
    _owlPos[idx * 2 + 0] = p.x;
    _owlPos[idx * 2 + 1] = p.z;
    _owlYaw[idx] = rand() * Math.PI * 2;
    _owlBlinkT[idx]   = 0;
    _owlBlinkGap[idx] = OWL_BLINK_MIN_GAP + rand() * (OWL_BLINK_MAX_GAP - OWL_BLINK_MIN_GAP);
    _owlBlinkPhase[idx] = -1; // -1 = idle (no active blink in progress)
    idx++;
  }
  _owlCount = idx;

  // Zero unused.
  for (let i = _owlCount; i < CAP_OWLS; i++) {
    _owlBodyMesh.setMatrixAt(i, _ZERO_MATRIX);
    _owlEyeLMesh.setMatrixAt(i, _ZERO_MATRIX);
    _owlEyeRMesh.setMatrixAt(i, _ZERO_MATRIX);
  }
  for (let i = 0; i < _owlCount; i++) {
    _stampOwl(i, /*eyeScaleY=*/1);
  }
  _owlBodyMesh.instanceMatrix.needsUpdate = true;
  _owlEyeLMesh.instanceMatrix.needsUpdate = true;
  _owlEyeRMesh.instanceMatrix.needsUpdate = true;
}

// ── per-frame stampers (zero allocation) ─────────────────────────────────────
function _restampFireflies(t) {
  for (let i = 0; i < _fireflyCount; i++) {
    const cx = _fireflyCenter[i * 3 + 0];
    const cy = _fireflyCenter[i * 3 + 1];
    const cz = _fireflyCenter[i * 3 + 2];
    const ph = _fireflyPhase[i];
    const r  = _fireflyRadius[i];
    const v  = _fireflyVSpeed[i];
    // Lissajous-ish drift per spec:
    //   x = cx + cos(t·v + ph) · r
    //   y bob = cy + sin(t·v·1.3 + ph) · BOB_Y_AMP
    //   z = cz + sin(t·v·0.7 + ph) · r
    const ang = t * v + ph;
    const dx  = Math.cos(ang) * r;
    const dy  = Math.sin(ang * 1.3) * FIREFLY_BOB_Y_AMP;
    const dz  = Math.sin(ang * 0.7) * r;
    _dummy.position.set(cx + dx, cy + dy, cz + dz);
    _dummy.rotation.set(0, 0, 0);
    _dummy.scale.setScalar(1);
    _dummy.updateMatrix();
    _fireflyMesh.setMatrixAt(i, _dummy.matrix);
  }
}

// Stamp one deer's body + 4 legs + head + 2 antlers. Pure layout — caller
// has already advanced position/yaw. The localTime arg is added to the
// per-instance phase so heads bob independently across deer.
function _stampDeer(i, localTime) {
  const x = _deerPos[i * 2 + 0];
  const z = _deerPos[i * 2 + 1];
  const yaw = _deerYaw[i];
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  // Body — center at y = leg_height (0.4) + half body (0.3) = 0.7
  _dummy.position.set(x, 0.7, z);
  _dummy.rotation.set(0, yaw, 0);
  _dummy.scale.setScalar(1);
  _dummy.updateMatrix();
  _deerBodyMesh.setMatrixAt(i, _dummy.matrix);
  // Legs — front-left/right and back-left/right. Body is 0.4×0.9 (x/z in
  // local space before yaw). Front legs at +z local, back at -z local. We
  // rotate body's local axes via cosY/sinY into world. Leg half-height 0.2
  // sits at y=0.2 so feet touch ground.
  const halfX = 0.16;  // half body X minus a bit so legs are inside profile
  const halfZ = 0.35;  // half body Z (legs hug front/back)
  function _stampLeg(mesh, lx, lz) {
    const wx = x + (lx * cosY) - (lz * sinY);
    const wz = z + (lx * sinY) + (lz * cosY);
    _dummy.position.set(wx, 0.2, wz);
    _dummy.rotation.set(0, yaw, 0);
    _dummy.scale.setScalar(1);
    _dummy.updateMatrix();
    mesh.setMatrixAt(i, _dummy.matrix);
  }
  _stampLeg(_deerLegFLMesh, -halfX,  halfZ); // front-left
  _stampLeg(_deerLegFRMesh,  halfX,  halfZ); // front-right
  _stampLeg(_deerLegBLMesh, -halfX, -halfZ); // back-left
  _stampLeg(_deerLegBRMesh,  halfX, -halfZ); // back-right
  // Head — at front-top of body. Local offset (0, +0.15, +0.55) — y rides
  // above the body, z extends past the front legs. Add bob (head rocks
  // up/down at DEER_HEAD_BOB_HZ).
  const bob = Math.sin(localTime * Math.PI * 2 * DEER_HEAD_BOB_HZ + i * 0.7) * DEER_HEAD_BOB_AMP;
  const headLocalZ = 0.55;
  const hx = x + (0 * cosY) - (headLocalZ * sinY);
  const hz = z + (0 * sinY) + (headLocalZ * cosY);
  _dummy.position.set(hx, 0.95 + bob, hz);
  _dummy.rotation.set(0, yaw, 0);
  _dummy.scale.setScalar(1);
  _dummy.updateMatrix();
  _deerHeadMesh.setMatrixAt(i, _dummy.matrix);
  // Antlers — two vertical cylinders sprouting from the head. Local offset
  // ±0.07 X-local at the head's world position, y above the head.
  function _stampAntler(mesh, lx) {
    const ax = hx + (lx * cosY);
    const az = hz + (lx * sinY);
    _dummy.position.set(ax, 1.15 + bob, az);
    _dummy.rotation.set(0, yaw, 0);
    _dummy.scale.setScalar(1);
    _dummy.updateMatrix();
    mesh.setMatrixAt(i, _dummy.matrix);
  }
  _stampAntler(_deerAntlerLMesh, -0.07);
  _stampAntler(_deerAntlerRMesh,  0.07);
}

function _stampOwl(i, eyeScaleY) {
  const x = _owlPos[i * 2 + 0];
  const z = _owlPos[i * 2 + 1];
  const yaw = _owlYaw[i];
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  // Body at OWL_PERCH_Y (sphere center).
  _dummy.position.set(x, OWL_PERCH_Y, z);
  _dummy.rotation.set(0, yaw, 0);
  _dummy.scale.setScalar(1);
  _dummy.updateMatrix();
  _owlBodyMesh.setMatrixAt(i, _dummy.matrix);
  // Eyes — small discs on the body's front face, offset ±0.08 along the
  // body's local X axis. Face the body's local +Z (apply yaw rotation).
  const eyeForwardOffset = 0.22;  // slightly outside the sphere radius
  function _stampEye(mesh, lx) {
    // World offset = local (lx, 0, eyeForwardOffset) rotated by yaw.
    const ex = x + (lx * cosY) - (eyeForwardOffset * sinY);
    const ez = z + (lx * sinY) + (eyeForwardOffset * cosY);
    _dummy.position.set(ex, OWL_PERCH_Y + 0.05, ez);
    // The disc normal is +Z by default. We want the disc facing forward —
    // along the body's local +Z. Yaw rotation around Y aligns it.
    _dummy.rotation.set(0, yaw, 0);
    _dummy.scale.set(1, eyeScaleY, 1);
    _dummy.updateMatrix();
    mesh.setMatrixAt(i, _dummy.matrix);
  }
  _stampEye(_owlEyeLMesh, -0.08);
  _stampEye(_owlEyeRMesh,  0.08);
}

// ── deer tick (state machine + movement) ─────────────────────────────────────
function _tickDeer(state, dt, hx, hz) {
  for (let i = 0; i < _deerCount; i++) {
    const st = _deerState[i];
    _deerStateT[i] += dt;
    const x = _deerPos[i * 2 + 0];
    const z = _deerPos[i * 2 + 1];
    // Proximity-driven flee preempts GRAZING and WALKING. Never preempts
    // FLEEING (a fleeing deer keeps fleeing until its timer expires; if
    // hero is still close after the timer, the next frame trips this branch
    // again and the deer flees anew — natural behavior).
    if (st !== ST_FLEEING) {
      const dx0 = x - hx;
      const dz0 = z - hz;
      if (dx0 * dx0 + dz0 * dz0 < DEER_FLEE_R2) {
        // Vector AWAY from hero.
        let nx = dx0, nz = dz0;
        const m = Math.sqrt(nx * nx + nz * nz);
        if (m > 0.001) { nx /= m; nz /= m; }
        else {
          // Hero exactly on top — pick a deterministic-ish fallback.
          const a = i * 1.7;
          nx = Math.cos(a); nz = Math.sin(a);
        }
        _deerVx[i] = nx * DEER_FLEE_SPEED;
        _deerVz[i] = nz * DEER_FLEE_SPEED;
        _deerYaw[i] = Math.atan2(nx, nz); // face flee direction
        _deerState[i] = ST_FLEEING;
        _deerStateT[i] = 0;
        _deerStateDur[i] = DEER_FLEE_DURATION;
      }
    }
    // Re-read state since we may have promoted above.
    const st2 = _deerState[i];

    if (st2 === ST_GRAZING) {
      if (_deerStateT[i] >= _deerStateDur[i]) {
        // Pick a new walk target within the deer's room bounds.
        const roomIdx = _deerRoom[i];
        const r = _roomList[roomIdx];
        if (r) {
          // Up to 8 attempts to find a target in-bounds and out of keep-out.
          let tx = x, tz = z, found = false;
          for (let a = 0; a < 8; a++) {
            // Random offset 3-8u away from current pos.
            const ang = Math.random() * Math.PI * 2;
            const dist = 3 + Math.random() * 5;
            const cx = x + Math.cos(ang) * dist;
            const cz = z + Math.sin(ang) * dist;
            const clamped = _clampToRoom(cx, cz, roomIdx);
            if (_isInKeepout(clamped.x, clamped.z)) continue;
            tx = clamped.x; tz = clamped.z; found = true; break;
          }
          if (!found) {
            // Fall back to staying put — start a new GRAZING timer rather than
            // walking nowhere.
            _deerState[i] = ST_GRAZING;
            _deerStateT[i] = 0;
            _deerStateDur[i] = DEER_GRAZE_MIN_DUR + Math.random() * (DEER_GRAZE_MAX_DUR - DEER_GRAZE_MIN_DUR);
            continue;
          }
          _deerTargetX[i] = tx;
          _deerTargetZ[i] = tz;
          // Face walk direction now so the body doesn't snap-rotate on first
          // step.
          const fdx = tx - x;
          const fdz = tz - z;
          _deerYaw[i] = Math.atan2(fdx, fdz);
          _deerState[i] = ST_WALKING;
          _deerStateT[i] = 0;
          _deerStateDur[i] = 30; // soft cap — WALKING transitions when target reached, not by timer; this is a safety bound
        } else {
          // Room missing — should not happen post-init but defend by resetting.
          _deerStateT[i] = 0;
        }
      }
    } else if (st2 === ST_WALKING) {
      // Step toward target.
      const tx = _deerTargetX[i];
      const tz = _deerTargetZ[i];
      const dx = tx - x;
      const dz = tz - z;
      const d2 = dx * dx + dz * dz;
      if (d2 <= DEER_ARRIVE_R2 || _deerStateT[i] >= _deerStateDur[i]) {
        _deerState[i] = ST_GRAZING;
        _deerStateT[i] = 0;
        _deerStateDur[i] = DEER_GRAZE_MIN_DUR + Math.random() * (DEER_GRAZE_MAX_DUR - DEER_GRAZE_MIN_DUR);
      } else {
        const d = Math.sqrt(d2);
        const step = DEER_WALK_SPEED * dt;
        const ux = dx / d;
        const uz = dz / d;
        let nx = x + ux * step;
        let nz = z + uz * step;
        // Clamp into room bounds in case the target was right at the edge.
        const clamped = _clampToRoom(nx, nz, _deerRoom[i]);
        _deerPos[i * 2 + 0] = clamped.x;
        _deerPos[i * 2 + 1] = clamped.z;
        // Face direction of travel.
        _deerYaw[i] = Math.atan2(ux, uz);
      }
    } else if (st2 === ST_FLEEING) {
      // Walk along stored velocity until duration elapses.
      const nx = x + _deerVx[i] * dt;
      const nz = z + _deerVz[i] * dt;
      const clamped = _clampToRoom(nx, nz, _deerRoom[i]);
      _deerPos[i * 2 + 0] = clamped.x;
      _deerPos[i * 2 + 1] = clamped.z;
      if (_deerStateT[i] >= _deerStateDur[i]) {
        _deerState[i] = ST_GRAZING;
        _deerStateT[i] = 0;
        _deerStateDur[i] = DEER_GRAZE_MIN_DUR + Math.random() * (DEER_GRAZE_MAX_DUR - DEER_GRAZE_MIN_DUR);
        _deerVx[i] = 0;
        _deerVz[i] = 0;
      }
    }
    // Re-stamp this deer's matrices for the new pose.
    _stampDeer(i, _animClock);
  }
}

// ── owl tick (blink scheduler) ───────────────────────────────────────────────
function _tickOwls(state, dt, hx, hz) {
  let dirty = false;
  for (let i = 0; i < _owlCount; i++) {
    const ox = _owlPos[i * 2 + 0];
    const oz = _owlPos[i * 2 + 1];
    const dx = ox - hx;
    const dz = oz - hz;
    const near = (dx * dx + dz * dz) <= OWL_PROXIMITY_R2;
    if (_owlBlinkPhase[i] < 0) {
      // Idle — accumulate toward next blink.
      _owlBlinkT[i] += dt * (near ? 2.0 : 1.0); // proximity doubles blink rate
      if (_owlBlinkT[i] >= _owlBlinkGap[i]) {
        // Begin a blink.
        _owlBlinkPhase[i] = 0;
        _owlBlinkT[i] = 0;
      }
    }
    // If blink active, advance.
    let eyeScaleY = 1;
    if (_owlBlinkPhase[i] >= 0) {
      _owlBlinkPhase[i] += dt;
      // 0 → OWL_BLINK_DUR: scale 1 → 0.05
      // OWL_BLINK_DUR → 2*OWL_BLINK_DUR: scale 0.05 → 1
      if (_owlBlinkPhase[i] <= OWL_BLINK_DUR) {
        const k = _owlBlinkPhase[i] / OWL_BLINK_DUR;
        eyeScaleY = 1 - 0.95 * k;
      } else if (_owlBlinkPhase[i] <= OWL_BLINK_DUR * 2) {
        const k = (_owlBlinkPhase[i] - OWL_BLINK_DUR) / OWL_BLINK_DUR;
        eyeScaleY = 0.05 + 0.95 * k;
      } else {
        // Blink complete — reset to idle and schedule next.
        _owlBlinkPhase[i] = -1;
        _owlBlinkT[i] = 0;
        _owlBlinkGap[i] = OWL_BLINK_MIN_GAP + Math.random() * (OWL_BLINK_MAX_GAP - OWL_BLINK_MIN_GAP);
        eyeScaleY = 1;
      }
      // Eye re-stamp this frame — body stays static so skip it.
      _stampEyeOnly(i, eyeScaleY);
      dirty = true;
    }
    // Else: idle blink — no matrix change this frame.
  }
  if (dirty) {
    _owlEyeLMesh.instanceMatrix.needsUpdate = true;
    _owlEyeRMesh.instanceMatrix.needsUpdate = true;
  }
}

// Cheap eye-only re-stamp (body is static once placed; saves 1 setMatrixAt
// per owl per frame). Mirrors _stampOwl's eye branch.
function _stampEyeOnly(i, eyeScaleY) {
  const x = _owlPos[i * 2 + 0];
  const z = _owlPos[i * 2 + 1];
  const yaw = _owlYaw[i];
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const eyeForwardOffset = 0.22;
  function _stampEye(mesh, lx) {
    const ex = x + (lx * cosY) - (eyeForwardOffset * sinY);
    const ez = z + (lx * sinY) + (eyeForwardOffset * cosY);
    _dummy.position.set(ex, OWL_PERCH_Y + 0.05, ez);
    _dummy.rotation.set(0, yaw, 0);
    _dummy.scale.set(1, eyeScaleY, 1);
    _dummy.updateMatrix();
    mesh.setMatrixAt(i, _dummy.matrix);
  }
  _stampEye(_owlEyeLMesh, -0.08);
  _stampEye(_owlEyeRMesh,  0.08);
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Build pre-pooled neutral meshes and scatter across all 7 forest rooms.
 * Idempotent — gated on `_loaded` so a double-load is a no-op.
 *
 * @param {THREE.Scene} scene
 * @param {Object} _state - GameState (unused at load; tick reads hero pos).
 * @param {Function} [rngOverride] - optional rng for tests; defaults to
 *   `_mulberry32(0xC0FFEA)` — distinct from forestLandmarks (0xC0FFE8) and
 *   forestCoffins (0xC0FFE9) so neutrals are uncorrelated with both.
 */
export function loadForestNeutrals(scene, _state, rngOverride) {
  if (_loaded) return;
  if (!scene) return;
  _group = new THREE.Group();
  _group.name = '__forestNeutrals';

  _buildFireflyMesh();
  _buildDeerMeshes();
  _buildOwlMeshes();

  _group.add(_fireflyMesh);
  _group.add(_deerBodyMesh);
  _group.add(_deerLegFLMesh);
  _group.add(_deerLegFRMesh);
  _group.add(_deerLegBLMesh);
  _group.add(_deerLegBRMesh);
  _group.add(_deerHeadMesh);
  _group.add(_deerAntlerLMesh);
  _group.add(_deerAntlerRMesh);
  _group.add(_owlBodyMesh);
  _group.add(_owlEyeLMesh);
  _group.add(_owlEyeRMesh);

  // Snapshot room bounds in iteration order (Object.keys is stable since
  // ES2015 for non-integer keys, which all our room ids are). The deer pool
  // indexes back into this list via _deerRoom for bounds-clamp on flee/walk.
  _roomList = [];
  for (const roomId in FOREST_ROOMS) {
    const r = FOREST_ROOMS[roomId];
    if (!r) { _roomList.push(null); continue; }
    _roomList.push({
      minX: r.bounds.minX, maxX: r.bounds.maxX,
      minZ: r.bounds.minZ, maxZ: r.bounds.maxZ,
    });
  }

  const rand = (typeof rngOverride === 'function') ? rngOverride : _mulberry32(0xC0FFEA);
  _placeFireflies(rand);
  _placeDeer(rand);
  _placeOwls(rand);   // depends on landmarks already loaded — gating in arenaDecor.js ensures this

  scene.add(_group);
  _animClock = 0;
  _loaded = true;
}

/**
 * Per-frame: drift fireflies, advance deer state machines, blink owls.
 * Cheap when no neutrals placed (early-out chain on _loaded + counts).
 *
 * Ordering:
 *   1. Advance _animClock for the Lissajous + head-bob curves.
 *   2. Always re-stamp fireflies (they're animated every frame — bobbing
 *      Lissajous never settles).
 *   3. Deer: tick state machine, re-stamp ALL 8 matrices per deer.
 *      (Body+4 legs+head+2 antlers — 8 component meshes; flag dirty once
 *      per mesh after the loop.)
 *   4. Owls: tick blink scheduler, eye-only re-stamp during active blinks.
 *
 * @param {Object} state - GameState
 * @param {number} dt    - frame seconds
 */
export function tickForestNeutrals(state, dt) {
  if (!_loaded) return;
  if (!state || !state.hero || !state.hero.pos) return;
  // gameOver respects the "stop responding to hero pos" contract that
  // forestLandmarks observes: deer don't flee a dead hero, owls don't
  // double-blink, fireflies keep drifting (decor only).
  const gameOver = !!state.gameOver;

  _animClock += dt;
  const hx = state.hero.pos.x;
  const hz = state.hero.pos.z;

  // ── fireflies ──
  if (_fireflyCount > 0) {
    _restampFireflies(_animClock);
    _fireflyMesh.instanceMatrix.needsUpdate = true;
  }

  // ── deer ──
  if (_deerCount > 0) {
    // gameOver: skip movement + proximity flee; still re-stamp once so
    // matrices stay coherent (head bob still subtle visual life).
    if (gameOver) {
      for (let i = 0; i < _deerCount; i++) _stampDeer(i, _animClock);
    } else {
      _tickDeer(state, dt, hx, hz);
    }
    _deerBodyMesh.instanceMatrix.needsUpdate = true;
    _deerLegFLMesh.instanceMatrix.needsUpdate = true;
    _deerLegFRMesh.instanceMatrix.needsUpdate = true;
    _deerLegBLMesh.instanceMatrix.needsUpdate = true;
    _deerLegBRMesh.instanceMatrix.needsUpdate = true;
    _deerHeadMesh.instanceMatrix.needsUpdate = true;
    _deerAntlerLMesh.instanceMatrix.needsUpdate = true;
    _deerAntlerRMesh.instanceMatrix.needsUpdate = true;
  }

  // ── owls ──
  if (_owlCount > 0 && !gameOver) {
    _tickOwls(state, dt, hx, hz);
    // _tickOwls flags needsUpdate internally only when a blink fires; body
    // is static so we never flag bodyMesh dirty post-init.
  }
}

/**
 * Tear down all neutral meshes + clear pool state. Idempotent — safe to
 * call when not loaded. Pairs with the disposeForestCoffins teardown shape
 * so main.js teardown blocks can call all three forest extras together.
 *
 * @param {THREE.Scene} scene
 */
export function disposeForestNeutrals(scene) {
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

  _fireflyMesh = null;
  _fireflyCenter = _fireflyPhase = _fireflyRadius = _fireflyVSpeed = null;
  _fireflyCount = 0;

  _deerBodyMesh = _deerLegFLMesh = _deerLegFRMesh = _deerLegBLMesh = _deerLegBRMesh = null;
  _deerHeadMesh = _deerAntlerLMesh = _deerAntlerRMesh = null;
  _deerPos = _deerYaw = _deerState = _deerStateT = _deerStateDur = null;
  _deerTargetX = _deerTargetZ = _deerVx = _deerVz = _deerRoom = null;
  _deerCount = 0;

  _owlBodyMesh = _owlEyeLMesh = _owlEyeRMesh = null;
  _owlPos = _owlYaw = _owlBlinkT = _owlBlinkGap = _owlBlinkPhase = null;
  _owlCount = 0;

  _roomList = [];
  _animClock = 0;
  _loaded = false;

  if (_gameState && '_neutralsLoaded' in _gameState) {
    _gameState._neutralsLoaded = false;
  }
}
