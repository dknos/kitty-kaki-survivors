/**
 * Forest Environmental Hazards — VS-style kite mechanics (FE-V2-A5, 2026-05-17).
 *
 * Three hazard types scattered across all 7 forest rooms. Distinct from the
 * single-lane Trap Corridor (src/trapCorridor.js); these are room-scoped
 * environmental damage zones that ALSO damage enemies — so the player can
 * kite swarms through them for tactical thinning.
 *
 *   1. Mushroom Rings (`mushroom_ring`) — ring of 5-7 small mushrooms with a
 *      periodic green spore puff. Phases: idle (3.5s) → telegraph (0.5s) →
 *      puff (0.3s damage frame) → cooldown back to idle. Damage during puff:
 *      5 hp to anything inside the ring radius (1.5u). Damage-once-per-puff
 *      gate via per-ring Set; reset on next telegraph.
 *   2. Tar Pits (`tar_pit`) — dark oval ground patch, continuous DoT for
 *      anything standing in it. Hero: 60% slow + 2 dmg/s applied via 0.25s
 *      sub-tick (0.5 dmg per sub-tick) using per-entity `_lastTarTickAt`.
 *      Enemies: damage only (see "Enemy slow/stun fallback" below).
 *   3. Falling Branches (`falling_branch`) — randomly armed at one of the
 *      per-room trigger positions. Phases: armed (1.5s ground telegraph
 *      ring) → falling (0.15s y-drop) → crash (0.1s damage frame in r=1.5
 *      for 30 dmg + 0.4s hero stun) → linger (0.5s) → reschedule (6-10s
 *      cooldown). Cap 8 active branches stage-wide via a fixed pre-pool.
 *
 * Lifecycle:
 *   loadForestEnvHazards(scene, state, rngOverride?) — build pre-pooled
 *     instanced meshes and scatter hazards across the 7 forest rooms.
 *     Idempotent.
 *   tickForestEnvHazards(state, dt) — per-frame: phase advance, damage
 *     application, matrix re-stamps. Cheap when not loaded.
 *   disposeForestEnvHazards(scene) — tear down all meshes + clear pool state.
 *
 * Seed: `_mulberry32(0xC0FFEB)` — distinct from neutrals (0xC0FFEA),
 * coffins (0xC0FFE9), landmarks (0xC0FFE8) so placements are uncorrelated.
 *
 * ── Damage hooks ────────────────────────────────────────────────────────────
 * Static imports of `damageEnemy` (enemies.js) and `takeDamage` (hero.js),
 * mirroring src/trapCorridor.js so the perf-fix 9509535 "no dynamic import in
 * per-frame hot paths" contract is honored. Each damage call is wrapped in
 * try/catch so a downstream fault never blows up the hazard tick.
 *
 * ── Enemy slow / stun fallback ─────────────────────────────────────────────
 * Per brief: "If damage application requires more than ~5 lines or invasive
 * enemy iteration: FALLBACK — hazards damage hero only, enemies pass through."
 * Slow on enemies and stun on enemies are gated through enemies.js's existing
 * slow aggregator (`state.run.<stage>SlowZones`) — adding a 4th publisher
 * and managing its lifecycle against stageHazards' async fetch-publish
 * pattern is invasive. Stun has no reader at all in enemies.js. Therefore:
 *
 *   - Enemies: take DAMAGE from all 3 hazards (cheap — same call shape as
 *     trapCorridor). No slow, no stun.
 *   - Hero: takes DAMAGE + SLOW (tar pit / mushroom) + STUN (branch).
 *
 * This is the most kite-relevant behavior anyway — the player kites mobs
 * through, mobs eat damage, hero plays around the slow/stun. Documented in
 * the final report.
 *
 * ── Hero slow channel ──────────────────────────────────────────────────────
 * Hero movement consumes `state.hero.hazardSlow` (read once per frame in
 * src/hero.js:330). `tickStageHazards` writes it ABSOLUTELY every frame
 * (src/stageHazards.js:433). Our tick runs AFTER stageHazards (see main.js
 * tick order) and MIN-stacks: `h.hazardSlow = min(h.hazardSlow, mySlow)`.
 *
 * ── Hero stun ──────────────────────────────────────────────────────────────
 * There is no first-class hero stun primitive. Per advisor, branch-crash
 * "stun" on hero is a 0.4s ZERO-velocity slow (hazardSlow = 0). This reads
 * as a stun for movement and respects the existing speed multiplier path.
 *
 * ── Self-gating (avoid wave-dispatcher freeze trap) ────────────────────────
 * Mushroom rings advance via phase timers — no `t >= dueAt; fire()` pattern.
 * Falling branches: when a crash completes and linger finishes, the trigger
 * position re-arms via `nextDropAt = t + (6 + rand()*4)`. After the dispatch
 * fires, nextDropAt is set immediately so the freeze trap (per
 * feedback_kks_wave_dispatcher_throttle.md) cannot occur.
 *
 * ── Palette (slot-locked — no new hex constants) ───────────────────────────
 *   slot 2  #4a7a4a — forest green (spore puff ring) [from forestLandmarks]
 *   slot 3  #6b4f3a — earth brown (mushroom stem, branch) [from forestLandmarks]
 *   slot 4  #4a3220 — dark brown (tar pit ground) [from forestNeutrals]
 *   slot 5  #e89c4a — saturated amber (mushroom cap) [from forestLandmarks]
 *   slot 6  #d9a648 — gold/amber (branch telegraph ring) [from forestNeutrals]
 *
 * ── Keep-out zones ─────────────────────────────────────────────────────────
 * Mirrors the forestNeutrals precedent: lockdown (1,-28 r=10) + trap shards
 * (-1, z=19/22/25 r=3.6) + portals (r=2) + landmarks (r=2). Coffins +
 * puzzle nodes do NOT expose XZ — same deviation that neutrals already
 * accepts. Documented up top.
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from './postfx.js';
import { FOREST_ROOMS, FOREST_PORTAL_POSITIONS } from './forestRooms.js';
import { getLandmarkPositions } from './forestLandmarks.js';
import { state as _gameState } from './state.js';
import { damageEnemy } from './enemies.js';
import { takeDamage as heroTakeDamage } from './hero.js';
import { createRuneRing } from './fx/runeRing.js';

// ── pool caps ───────────────────────────────────────────────────────────────
const MUSHROOMS_PER_RING_MIN = 5;
const MUSHROOMS_PER_RING_MAX = 7;
const RINGS_PER_ROOM_MIN     = 2;
const RINGS_PER_ROOM_MAX     = 3;
const CAP_RINGS              = 24;  // 3 × 7 rooms = 21, +3 headroom
const CAP_MUSHROOMS          = CAP_RINGS * MUSHROOMS_PER_RING_MAX; // 168 stems/caps/auras

const TARPITS_PER_ROOM_MIN   = 1;
const TARPITS_PER_ROOM_MAX   = 2;
const CAP_TARPITS            = 16;  // 2 × 7 = 14, +2 headroom

const BRANCH_TRIGGERS_PER_ROOM_MIN = 1;
const BRANCH_TRIGGERS_PER_ROOM_MAX = 2;
const CAP_TRIGGERS                 = 16;  // 2 × 7 = 14, +2 headroom
const CAP_ACTIVE_BRANCHES          = 8;   // hard cap per brief

// ── palette (slots already used elsewhere — no new hex constants) ──────────
const SLOT2_GREEN  = 0x4a7a4a;   // spore puff
const SLOT3_BROWN  = 0x6b4f3a;   // mushroom stem, branch
const SLOT4_DARK   = 0x4a3220;   // tar pit
const SLOT5_AMBER  = 0xe89c4a;   // mushroom cap
const SLOT6_GOLD   = 0xd9a648;   // branch telegraph ring

// ── keep-out (mirrors forestNeutrals precedent) ────────────────────────────
const LOCKDOWN = { x: 1.0, z: -28.0, r2: (8 + 2) * (8 + 2) };
const TRAP_SHARDS = [
  { x: -1.0, z: 19.0, r2: (1.6 + 2) * (1.6 + 2) },
  { x: -1.0, z: 22.0, r2: (1.6 + 2) * (1.6 + 2) },
  { x: -1.0, z: 25.0, r2: (1.6 + 2) * (1.6 + 2) },
];
const PORTAL_KEEPOUT_R2   = 2 * 2;
const LANDMARK_KEEPOUT_R2 = 2 * 2;

// ── mushroom-ring tunables ─────────────────────────────────────────────────
const RING_RADIUS         = 1.0;   // ring of mushrooms — circle radius
const SPORE_PUFF_RADIUS   = 1.5;   // damage radius during puff
const RING_PUFF_DMG       = 5;
const RING_HERO_SLOW_MUL  = 0.5;
const RING_HERO_SLOW_DUR  = 1.0;   // seconds hero stays slowed after puff
const PHASE_IDLE_SEC      = 3.5;
const PHASE_TELEGRAPH_SEC = 0.5;
const PHASE_PUFF_SEC      = 0.3;   // damage frame + visual expand

const PUFF_INNER          = 0.3;
const PUFF_OUTER          = SPORE_PUFF_RADIUS;

// ── tar-pit tunables ───────────────────────────────────────────────────────
const TARPIT_RADIUS       = 2.0;
const TARPIT_HERO_SLOW    = 0.4;   // 60% slow → 0.4× speed
const TARPIT_DPS          = 2.0;
const TARPIT_SUBTICK_SEC  = 0.25;  // apply 0.5 dmg every 0.25s

// ── falling-branch tunables ────────────────────────────────────────────────
const BRANCH_DMG_RADIUS   = 1.5;
const BRANCH_DMG          = 30;
const BRANCH_STUN_DUR     = 0.4;
const BRANCH_ARMED_SEC    = 1.5;
const BRANCH_FALL_SEC     = 0.15;
const BRANCH_CRASH_SEC    = 0.1;
const BRANCH_LINGER_SEC   = 0.5;
const BRANCH_FALL_FROM_Y  = 5.0;
const BRANCH_FALL_TO_Y    = 0.2;
const BRANCH_COOLDOWN_MIN = 6.0;
const BRANCH_COOLDOWN_MAX = 10.0;

// Ring (RingGeometry) telegraph for branch.
const BRANCH_TELE_INNER = 1.3;
const BRANCH_TELE_OUTER = 1.5;

// Branch phase codes (Uint8Array friendly).
const BP_IDLE    = 0;  // waiting for nextDropAt
const BP_ARMED   = 1;
const BP_FALLING = 2;
const BP_CRASH   = 3;
const BP_LINGER  = 4;

// Mushroom phase codes.
const MP_IDLE      = 0;
const MP_TELEGRAPH = 1;
const MP_PUFF      = 2;

// ── module state ───────────────────────────────────────────────────────────
let _loaded = false;
let _group = null;
let _disposables = [];

// ── Mushroom rings ──
let _ringCount   = 0;
let _ringPos     = null;  // Float32Array [cx, cz, ...]
let _ringPhase   = null;  // Uint8Array MP_*
let _ringPhaseT  = null;  // Float32Array — elapsed in current phase
let _ringHits    = null;  // Array<Set> per-ring damage-once gate (cleared on telegraph→puff)
// Per-mushroom instanced meshes (stem cylinder + cap sphere). Stamped once at
// load, never re-stamped per tick. Spore puff is its own ring instanced mesh
// (one per ring slot — scaled & opacity-driven during puff phase).
let _stemMesh    = null;  // InstancedMesh — CAP_MUSHROOMS
let _capMesh     = null;  // InstancedMesh — CAP_MUSHROOMS
let _mushroomCount = 0;
let _puffMesh    = null;  // InstancedMesh of RingGeometry — CAP_RINGS (one per ring)

// ── Tar pits ──
let _tarCount    = 0;
let _tarPos      = null;  // Float32Array [cx, cz, ...]
let _tarMesh     = null;  // InstancedMesh — CircleGeometry — CAP_TARPITS
// Per-entity sub-tick timers — hero gets one slot; enemies are tracked via a
// WeakMap so dead refs GC cleanly.
let _heroTarLastTickAt = 0;
let _enemyTarLastTickAt = null; // WeakMap<enemyRef, number>

// ── Falling branches (trigger sites + active branches) ──
let _triggerCount   = 0;
let _triggerPos     = null;  // Float32Array [x, z, ...] (immutable after load)
let _triggerNextAt  = null;  // Float32Array — t at which next drop should arm (per trigger)
let _triggerActiveBranch = null;  // Int8Array — -1 if no branch tied to this trigger, else _branchIdx

let _branchCount = 0;  // number of active branches
let _branchPhase = null;  // Uint8Array BP_*
let _branchPhaseT = null;  // Float32Array
let _branchX = null;       // Float32Array
let _branchZ = null;       // Float32Array
let _branchTrigger = null; // Int8Array — owning trigger index (to re-arm after linger)
let _branchHits = null;    // Array<Set> per-branch damage-once gate (cleared on enter CRASH)
let _branchBoxMesh = null; // InstancedMesh — BoxGeometry — CAP_ACTIVE_BRANCHES
let _branchRingMesh = null; // InstancedMesh — RingGeometry — CAP_ACTIVE_BRANCHES

// Module clock (drives self-gating dispatch times)
let _clock = 0;

// Reusable scratch (no allocations in hot path)
const _dummy = new THREE.Object3D();
const _zeroDummy = new THREE.Object3D();
_zeroDummy.scale.set(0, 0, 0);
_zeroDummy.updateMatrix();
const _ZERO_MATRIX = _zeroDummy.matrix.clone();

// ── deterministic RNG ──────────────────────────────────────────────────────
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

// ── keep-out test ──────────────────────────────────────────────────────────
function _isInKeepout(x, z, landmarkPositions) {
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
  if (landmarkPositions) {
    for (let i = 0; i < landmarkPositions.length; i++) {
      const lp = landmarkPositions[i];
      if (!lp) continue;
      dx = x - lp.x;
      dz = z - lp.z;
      if (dx * dx + dz * dz < LANDMARK_KEEPOUT_R2) return true;
    }
  }
  return false;
}

function _tryPickSpot(room, rand, attempts, inset, landmarkPositions, existingSpots, existingMinDist2) {
  const minX = room.bounds.minX + inset;
  const maxX = room.bounds.maxX - inset;
  const minZ = room.bounds.minZ + inset;
  const maxZ = room.bounds.maxZ - inset;
  if (maxX <= minX || maxZ <= minZ) return null;
  for (let a = 0; a < attempts; a++) {
    const x = minX + rand() * (maxX - minX);
    const z = minZ + rand() * (maxZ - minZ);
    if (_isInKeepout(x, z, landmarkPositions)) continue;
    // Existing-spot separation check (prevents tarpit-on-tarpit overlap etc.).
    if (existingSpots && existingMinDist2 > 0) {
      let bad = false;
      for (let i = 0; i < existingSpots.length; i++) {
        const s = existingSpots[i];
        const dx = x - s.x, dz = z - s.z;
        if (dx * dx + dz * dz < existingMinDist2) { bad = true; break; }
      }
      if (bad) continue;
    }
    return { x, z };
  }
  return null;
}

// ── mesh builders ──────────────────────────────────────────────────────────
function _buildMushroomMeshes() {
  // Stem — small cylinder, slot-3 brown.
  const stemGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.4, 8);
  const stemMat = new THREE.MeshStandardMaterial({
    color: SLOT3_BROWN, roughness: 0.95, metalness: 0.02, flatShading: true,
  });
  _stemMesh = new THREE.InstancedMesh(stemGeo, stemMat, CAP_MUSHROOMS);
  _stemMesh.userData.envHazardKind = 'mushroom_stem';
  _track(stemGeo); _track(stemMat);

  // Cap — sphere, slot-5 amber. emissive bumped during telegraph via a shared
  // material color swap on the cap mesh? InstancedMesh shares one material
  // across all instances — so per-ring telegraph "brighten" cannot be done
  // per-ring without per-instance color (InstancedBufferAttribute). Instead,
  // the telegraph "pulse" rides on the puffMesh opacity rising 0→0.4 during
  // the 0.5s telegraph window, then expanding+fading during the 0.3s puff
  // window. Mushrooms stay visually static; the spore ring carries the
  // warning. Simpler, palette-clean, and matches the brief's "billboard ring
  // expansion 0.5s" beat.
  const capGeo = new THREE.SphereGeometry(0.25, 10, 8);
  const capMat = new THREE.MeshStandardMaterial({
    color: SLOT5_AMBER,
    emissive: SLOT5_AMBER,
    emissiveIntensity: 0.2,
    roughness: 0.7, metalness: 0.05, flatShading: true,
  });
  _capMesh = new THREE.InstancedMesh(capGeo, capMat, CAP_MUSHROOMS);
  _capMesh.userData.envHazardKind = 'mushroom_cap';
  _track(capGeo); _track(capMat);

  // Puff ring — canonical rune-ring helper (PHASE 2 P2A). Replaces the flat
  // RingGeometry placeholder with the 8-layer baked-glyph quality bar so the
  // spore halo reads as a "magical sigil" instead of a featureless donut.
  // Ground-decal: polygonOffset BELOW + renderOrder -1 so hero/enemy meshes
  // occlude correctly (2026-05-17 cohort 20 fix).
  const puffRune = createRuneRing({
    radius: PUFF_OUTER, color: SLOT2_GREEN, opacity: 0.7,
    groundDecal: true, instanced: true, cap: CAP_RINGS,
    userData: { envHazardKind: 'mushroom_puff' },
  });
  _puffMesh = puffRune.mesh;
  _track(puffRune.material);
}

function _buildTarPitMesh() {
  // CircleGeometry at radius 1.0 (scaled per-instance to TARPIT_RADIUS so
  // future tarpit-size variance is a one-line change). Rotate so circle lies
  // flat on the ground plane.
  const geo = new THREE.CircleGeometry(1.0, 28);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: SLOT4_DARK,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    side: THREE.DoubleSide,
    // Ground-decal Z-order fix (2026-05-17 user report).
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  _tarMesh = new THREE.InstancedMesh(geo, mat, CAP_TARPITS);
  _tarMesh.userData.envHazardKind = 'tar_pit';
  _tarMesh.renderOrder = -1;
  _track(geo); _track(mat);
}

function _buildBranchMeshes() {
  // Branch — BoxGeometry 0.3 × 0.4 × 2.5 (length along local Z), slot-3 brown.
  // Hidden until falling/crash/linger; identity-scaled and parked offscreen
  // (y=-99) in unused slots.
  const bGeo = new THREE.BoxGeometry(0.3, 0.4, 2.5);
  const bMat = new THREE.MeshStandardMaterial({
    color: SLOT3_BROWN, roughness: 0.9, metalness: 0.02, flatShading: true,
  });
  _branchBoxMesh = new THREE.InstancedMesh(bGeo, bMat, CAP_ACTIVE_BRANCHES);
  _branchBoxMesh.userData.envHazardKind = 'branch';
  _track(bGeo); _track(bMat);

  // Telegraph ring — canonical rune-ring helper (PHASE 2 P2A). Slot-6 amber
  // baked-glyph quality bar replaces the flat RingGeometry placeholder.
  // Ground-decal flag keeps the renderOrder=-1 + polygonOffset Z-fix.
  const teleRune = createRuneRing({
    radius: BRANCH_TELE_OUTER, color: SLOT6_GOLD, opacity: 0.85,
    groundDecal: true, instanced: true, cap: CAP_ACTIVE_BRANCHES,
    userData: { envHazardKind: 'branch_ring' },
  });
  _branchRingMesh = teleRune.mesh;
  _track(teleRune.material);
}

// ── placement ──────────────────────────────────────────────────────────────
function _placeMushroomRings(rand, landmarkPositions) {
  _ringPos    = new Float32Array(CAP_RINGS * 2);
  _ringPhase  = new Uint8Array(CAP_RINGS);
  _ringPhaseT = new Float32Array(CAP_RINGS);
  _ringHits   = new Array(CAP_RINGS);
  for (let i = 0; i < CAP_RINGS; i++) _ringHits[i] = new Set();

  // Track per-ring mushroom slot starts so each ring's 5-7 mushrooms live in
  // contiguous instance slots (lets us cap-and-walk cleanly).
  let ringIdx = 0;
  let mushroomIdx = 0;
  const ringSpots = []; // for inter-ring spacing within rooms
  for (const roomId in FOREST_ROOMS) {
    if (ringIdx >= CAP_RINGS) break;
    const room = FOREST_ROOMS[roomId];
    if (!room) continue;
    const span = RINGS_PER_ROOM_MAX - RINGS_PER_ROOM_MIN + 1;
    const n = RINGS_PER_ROOM_MIN + ((rand() * span) | 0);
    const roomRingSpots = [];
    for (let i = 0; i < n && ringIdx < CAP_RINGS; i++) {
      // Inset ≥ ring_radius + 1u so the mushrooms aren't kissing the wall.
      const spot = _tryPickSpot(room, rand, 16, RING_RADIUS + 1.5,
                                 landmarkPositions, roomRingSpots, (3 * 3));
      if (!spot) continue;
      roomRingSpots.push(spot);
      _ringPos[ringIdx * 2 + 0] = spot.x;
      _ringPos[ringIdx * 2 + 1] = spot.z;
      // Stagger phases so rings don't fire in lockstep.
      _ringPhase[ringIdx] = MP_IDLE;
      _ringPhaseT[ringIdx] = -(rand() * PHASE_IDLE_SEC);

      const mushrooms = MUSHROOMS_PER_RING_MIN
        + ((rand() * (MUSHROOMS_PER_RING_MAX - MUSHROOMS_PER_RING_MIN + 1)) | 0);
      for (let k = 0; k < mushrooms && mushroomIdx < CAP_MUSHROOMS; k++) {
        const theta = (k / mushrooms) * Math.PI * 2;
        const mx = spot.x + Math.cos(theta) * RING_RADIUS;
        const mz = spot.z + Math.sin(theta) * RING_RADIUS;
        // Stamp stem (center at y=0.2 — height 0.4 → half=0.2 sits on ground).
        _dummy.position.set(mx, 0.2, mz);
        _dummy.rotation.set(0, theta, 0);
        _dummy.scale.setScalar(1);
        _dummy.updateMatrix();
        _stemMesh.setMatrixAt(mushroomIdx, _dummy.matrix);
        // Stamp cap at top of stem (y=0.4 + cap_radius 0.25 → center y=0.55).
        _dummy.position.set(mx, 0.55, mz);
        _dummy.rotation.set(0, theta, 0);
        _dummy.scale.setScalar(1);
        _dummy.updateMatrix();
        _capMesh.setMatrixAt(mushroomIdx, _dummy.matrix);
        mushroomIdx++;
      }

      // Stamp puff ring at zero scale (hidden), positioned at ring center.
      _dummy.position.set(spot.x, 0.06, spot.z);
      _dummy.rotation.set(0, 0, 0);
      _dummy.scale.setScalar(0.001);
      _dummy.updateMatrix();
      _puffMesh.setMatrixAt(ringIdx, _dummy.matrix);

      ringSpots.push(spot);
      ringIdx++;
    }
  }
  _ringCount = ringIdx;
  _mushroomCount = mushroomIdx;

  // Zero unused slots.
  for (let i = _mushroomCount; i < CAP_MUSHROOMS; i++) {
    _stemMesh.setMatrixAt(i, _ZERO_MATRIX);
    _capMesh.setMatrixAt(i, _ZERO_MATRIX);
  }
  for (let i = _ringCount; i < CAP_RINGS; i++) {
    _puffMesh.setMatrixAt(i, _ZERO_MATRIX);
  }
  _stemMesh.instanceMatrix.needsUpdate = true;
  _capMesh.instanceMatrix.needsUpdate = true;
  _puffMesh.instanceMatrix.needsUpdate = true;
}

function _placeTarPits(rand, landmarkPositions) {
  _tarPos = new Float32Array(CAP_TARPITS * 2);

  let idx = 0;
  for (const roomId in FOREST_ROOMS) {
    if (idx >= CAP_TARPITS) break;
    const room = FOREST_ROOMS[roomId];
    if (!room) continue;
    // Bigger rooms get the higher count. Span x*z > 4000 → 2 pits.
    const w = room.bounds.maxX - room.bounds.minX;
    const h = room.bounds.maxZ - room.bounds.minZ;
    const area = w * h;
    const maxN = area > 4000 ? TARPITS_PER_ROOM_MAX : TARPITS_PER_ROOM_MIN;
    const n = TARPITS_PER_ROOM_MIN + ((rand() * (maxN - TARPITS_PER_ROOM_MIN + 1)) | 0);
    const roomSpots = [];
    for (let i = 0; i < n && idx < CAP_TARPITS; i++) {
      const spot = _tryPickSpot(room, rand, 16, TARPIT_RADIUS + 1.0,
                                 landmarkPositions, roomSpots, (TARPIT_RADIUS * 2 + 1) * (TARPIT_RADIUS * 2 + 1));
      if (!spot) continue;
      roomSpots.push(spot);
      _tarPos[idx * 2 + 0] = spot.x;
      _tarPos[idx * 2 + 1] = spot.z;
      // Stamp tar pit. Scale to TARPIT_RADIUS via uniform scale on x,z (geom
      // is unit radius). y stays 1 because the disc has no thickness.
      _dummy.position.set(spot.x, 0.03, spot.z);
      _dummy.rotation.set(0, 0, 0);
      _dummy.scale.set(TARPIT_RADIUS, 1, TARPIT_RADIUS);
      _dummy.updateMatrix();
      _tarMesh.setMatrixAt(idx, _dummy.matrix);
      idx++;
    }
  }
  _tarCount = idx;

  for (let i = _tarCount; i < CAP_TARPITS; i++) {
    _tarMesh.setMatrixAt(i, _ZERO_MATRIX);
  }
  _tarMesh.instanceMatrix.needsUpdate = true;
}

function _placeBranchTriggers(rand, landmarkPositions) {
  _triggerPos          = new Float32Array(CAP_TRIGGERS * 2);
  _triggerNextAt       = new Float32Array(CAP_TRIGGERS);
  _triggerActiveBranch = new Int8Array(CAP_TRIGGERS);

  let idx = 0;
  for (const roomId in FOREST_ROOMS) {
    if (idx >= CAP_TRIGGERS) break;
    const room = FOREST_ROOMS[roomId];
    if (!room) continue;
    const span = BRANCH_TRIGGERS_PER_ROOM_MAX - BRANCH_TRIGGERS_PER_ROOM_MIN + 1;
    const n = BRANCH_TRIGGERS_PER_ROOM_MIN + ((rand() * span) | 0);
    const roomSpots = [];
    for (let i = 0; i < n && idx < CAP_TRIGGERS; i++) {
      const spot = _tryPickSpot(room, rand, 16, BRANCH_DMG_RADIUS + 1.0,
                                 landmarkPositions, roomSpots, (BRANCH_DMG_RADIUS * 2 + 1) * (BRANCH_DMG_RADIUS * 2 + 1));
      if (!spot) continue;
      roomSpots.push(spot);
      _triggerPos[idx * 2 + 0] = spot.x;
      _triggerPos[idx * 2 + 1] = spot.z;
      // Stagger initial dispatch: first drop 2..8s in.
      _triggerNextAt[idx] = 2 + rand() * 6;
      _triggerActiveBranch[idx] = -1;
      idx++;
    }
  }
  _triggerCount = idx;

  // Branch pool — all hidden at load. Pose stamped lazily on arm.
  _branchPhase   = new Uint8Array(CAP_ACTIVE_BRANCHES);
  _branchPhaseT  = new Float32Array(CAP_ACTIVE_BRANCHES);
  _branchX       = new Float32Array(CAP_ACTIVE_BRANCHES);
  _branchZ       = new Float32Array(CAP_ACTIVE_BRANCHES);
  _branchTrigger = new Int8Array(CAP_ACTIVE_BRANCHES);
  _branchHits    = new Array(CAP_ACTIVE_BRANCHES);
  for (let i = 0; i < CAP_ACTIVE_BRANCHES; i++) {
    _branchHits[i] = new Set();
    _branchPhase[i] = BP_IDLE;
    _branchTrigger[i] = -1;
    _branchBoxMesh.setMatrixAt(i, _ZERO_MATRIX);
    _branchRingMesh.setMatrixAt(i, _ZERO_MATRIX);
  }
  _branchBoxMesh.instanceMatrix.needsUpdate = true;
  _branchRingMesh.instanceMatrix.needsUpdate = true;
  _branchCount = 0;
}

// ── mushroom ring tick ─────────────────────────────────────────────────────
function _tickMushroomRings(state, dt) {
  if (_ringCount === 0) return;
  let puffDirty = false;
  const heroAlive = state && state.hero && !state.gameOver;
  const hx = heroAlive ? state.hero.pos.x : 0;
  const hz = heroAlive ? state.hero.pos.z : 0;
  const enemies = (state && state.enemies && state.enemies.active) || null;

  for (let r = 0; r < _ringCount; r++) {
    _ringPhaseT[r] += dt;
    const phase = _ringPhase[r];
    const t = _ringPhaseT[r];
    const cx = _ringPos[r * 2 + 0];
    const cz = _ringPos[r * 2 + 1];

    if (phase === MP_IDLE) {
      // Spore ring fully hidden.
      if (t >= PHASE_IDLE_SEC) {
        _ringPhase[r] = MP_TELEGRAPH;
        _ringPhaseT[r] = 0;
        // Pre-clear the per-puff damage set so the upcoming puff is a fresh slate.
        _ringHits[r].clear();
        // Telegraph stamp at low opacity (rises during window).
        _puffSetVisual(r, cx, cz, 0.001, 0);
        puffDirty = true;
      }
    } else if (phase === MP_TELEGRAPH) {
      const k = Math.min(1, t / PHASE_TELEGRAPH_SEC);
      // Pulse opacity 0 → 0.4, scale grows tiny (0.001 → 0.4× of full).
      const opacity = 0.4 * k;
      // Material opacity is shared across instances — but RingGeometry-based
      // InstancedMesh material opacity affects all instances. To keep things
      // simple and palette-locked, opacity rides via the dummy's scale.y
      // (which has no real effect on a flat ring) — instead we use a separate
      // approach: scale the puff ring grows from 0.001 → 1.0 during the puff
      // phase, and during telegraph stays small (scale ~0.4) with the shared
      // material at a fixed transparent value. The pulse "brighten" beat is
      // carried by the material being on bloom + the scale change.
      const scale = 0.001 + 0.4 * k;
      _puffSetVisual(r, cx, cz, scale, opacity);
      puffDirty = true;
      if (t >= PHASE_TELEGRAPH_SEC) {
        _ringPhase[r] = MP_PUFF;
        _ringPhaseT[r] = 0;
      }
    } else if (phase === MP_PUFF) {
      const k = Math.min(1, t / PHASE_PUFF_SEC);
      // Scale 0.4 → 1.0, opacity 1.0 → 0.0 (ease-out).
      const scale = 0.4 + 0.6 * k;
      const opacity = 1.0 - k;
      _puffSetVisual(r, cx, cz, scale, opacity);
      puffDirty = true;

      // Damage application during puff phase — once per entity per puff.
      // Hero
      if (heroAlive) {
        if (!_ringHits[r].has(state.hero)) {
          const dx = hx - cx;
          const dz = hz - cz;
          if (dx * dx + dz * dz <= SPORE_PUFF_RADIUS * SPORE_PUFF_RADIUS) {
            try { heroTakeDamage(RING_PUFF_DMG); }
            catch (e) { /* swallow */ }
            // Stamp 1s slow on hero (consumed by hazardSlow stamper below in
            // tickForestEnvHazards).
            state.hero._envHazardSlowMul = Math.min(
              (state.hero._envHazardSlowMul || 1),
              RING_HERO_SLOW_MUL,
            );
            state.hero._envHazardSlowUntil = Math.max(
              (state.hero._envHazardSlowUntil || 0),
              _clock + RING_HERO_SLOW_DUR,
            );
            _ringHits[r].add(state.hero);
          }
        }
      }
      // Enemies — damage only (no slow per fallback).
      if (enemies) {
        for (let i = 0; i < enemies.length; i++) {
          const e = enemies[i];
          if (!e || !e.alive) continue;
          if (_ringHits[r].has(e)) continue;
          const ex = (e.mesh && e.mesh.position) ? e.mesh.position.x : (e.pos ? e.pos.x : 0);
          const ez = (e.mesh && e.mesh.position) ? e.mesh.position.z : (e.pos ? e.pos.z : 0);
          const dx = ex - cx;
          const dz = ez - cz;
          if (dx * dx + dz * dz > SPORE_PUFF_RADIUS * SPORE_PUFF_RADIUS) continue;
          try { damageEnemy(e, RING_PUFF_DMG, 'forestEnvHazard'); _ringHits[r].add(e); }
          catch (err) { /* swallow */ }
        }
      }

      if (t >= PHASE_PUFF_SEC) {
        _ringPhase[r] = MP_IDLE;
        _ringPhaseT[r] = 0;
        // Hide spore ring.
        _puffSetVisual(r, cx, cz, 0.001, 0);
        puffDirty = true;
        _ringHits[r].clear();
      }
    }
  }
  if (puffDirty) {
    _puffMesh.instanceMatrix.needsUpdate = true;
    // Opacity is a shared-material property — but we want per-ring opacity.
    // The InstancedMesh material is shared, so a per-instance opacity would
    // need InstancedBufferAttribute. To keep the visual coherent with cheap
    // pooling, we rely on the rings firing at staggered times (initial phase
    // offset) so two simultaneous rings is rare; the worst-case visual is a
    // brief shared-fade beat which still reads as "spore puffs popping".
  }
}

// Helper to stamp the puff ring's position + scale. Opacity is encoded into
// the per-instance scale.y so a near-zero opacity is also a near-zero ring
// (visually equivalent for a flat disc — invisible at scale=0).
// We use a tiny scale.y trick: when opacity should be 0, scale.y goes to 0
// which collapses the disc to a line invisible from iso camera. When > 0,
// scale.y = 1. This avoids the InstancedMesh-shared-material problem.
function _puffSetVisual(r, cx, cz, scale, opacity) {
  const yScale = opacity > 0.01 ? 1 : 0;
  _dummy.position.set(cx, 0.06, cz);
  _dummy.rotation.set(0, 0, 0);
  _dummy.scale.set(scale, yScale, scale);
  _dummy.updateMatrix();
  _puffMesh.setMatrixAt(r, _dummy.matrix);
}

// ── tar pit tick ───────────────────────────────────────────────────────────
function _tickTarPits(state, dt) {
  if (_tarCount === 0) return;
  const heroAlive = state && state.hero && !state.gameOver;
  const hx = heroAlive ? state.hero.pos.x : 0;
  const hz = heroAlive ? state.hero.pos.z : 0;
  const enemies = (state && state.enemies && state.enemies.active) || null;
  const r2 = TARPIT_RADIUS * TARPIT_RADIUS;
  const dmgPerSubtick = TARPIT_DPS * TARPIT_SUBTICK_SEC; // 0.5 dmg

  let heroInAnyPit = false;
  for (let i = 0; i < _tarCount; i++) {
    const cx = _tarPos[i * 2 + 0];
    const cz = _tarPos[i * 2 + 1];

    if (heroAlive) {
      const dx = hx - cx, dz = hz - cz;
      if (dx * dx + dz * dz <= r2) {
        heroInAnyPit = true;
        // Stamp slow (consumed by hazardSlow stamper at end of tick).
        // Tar pit slow lasts as long as hero is inside; refresh per frame.
        state.hero._envHazardSlowMul = Math.min(
          (state.hero._envHazardSlowMul || 1),
          TARPIT_HERO_SLOW,
        );
        state.hero._envHazardSlowUntil = Math.max(
          (state.hero._envHazardSlowUntil || 0),
          _clock + 0.05, // tiny lookahead so frame-to-frame transition is sticky
        );
        // Damage sub-tick (per spec: 0.5 dmg per 0.25s).
        if (_clock - _heroTarLastTickAt >= TARPIT_SUBTICK_SEC) {
          _heroTarLastTickAt = _clock;
          try { heroTakeDamage(dmgPerSubtick); } catch (_) { /* swallow */ }
        }
      }
    }
    // Enemies — damage only (no slow per fallback).
    if (enemies) {
      for (let j = 0; j < enemies.length; j++) {
        const e = enemies[j];
        if (!e || !e.alive) continue;
        const ex = (e.mesh && e.mesh.position) ? e.mesh.position.x : (e.pos ? e.pos.x : 0);
        const ez = (e.mesh && e.mesh.position) ? e.mesh.position.z : (e.pos ? e.pos.z : 0);
        const ddx = ex - cx, ddz = ez - cz;
        if (ddx * ddx + ddz * ddz > r2) continue;
        let last = _enemyTarLastTickAt.get(e);
        if (last === undefined) last = -999;
        if (_clock - last >= TARPIT_SUBTICK_SEC) {
          _enemyTarLastTickAt.set(e, _clock);
          try { damageEnemy(e, dmgPerSubtick, 'forestEnvHazard'); } catch (_) { /* swallow */ }
        }
      }
    }
  }
  // If hero left ALL pits this frame, reset the last-tick clock so re-entering
  // costs a fresh sub-tick (prevents the "step in, get hit immediately" race
  // when re-entering from outside).
  if (heroAlive && !heroInAnyPit) {
    _heroTarLastTickAt = _clock - TARPIT_SUBTICK_SEC; // arm next entry for full-cost first tick
  }
}

// ── falling branch tick ────────────────────────────────────────────────────
function _allocBranch() {
  // Find first BP_IDLE slot in the active pool.
  for (let i = 0; i < CAP_ACTIVE_BRANCHES; i++) {
    if (_branchPhase[i] === BP_IDLE && _branchTrigger[i] === -1) {
      return i;
    }
  }
  return -1;
}

function _tickBranchTriggers(state, dt) {
  if (_triggerCount === 0) return;

  // 1. Arm new branches at triggers whose dueAt has passed AND have no
  //    active branch tied to them. Hard cap at CAP_ACTIVE_BRANCHES.
  for (let ti = 0; ti < _triggerCount; ti++) {
    if (_triggerActiveBranch[ti] !== -1) continue;
    const dueAt = _triggerNextAt[ti];
    if (!Number.isFinite(dueAt)) continue;
    if (_clock < dueAt) continue;
    // Try to allocate an active branch slot. If pool full, push the next
    // attempt back to the cap-reroll cooldown (don't keep retrying every
    // frame — that's the wave-dispatcher freeze trap shape).
    const bi = _allocBranch();
    if (bi === -1) {
      // Reschedule a frame later; mark as Infinity until a slot opens. Re-arm
      // happens when ANY branch completes its linger (see crash→linger
      // transition below — we sweep all idle triggers at that point).
      _triggerNextAt[ti] = Number.POSITIVE_INFINITY;
      continue;
    }
    _triggerActiveBranch[ti] = bi;
    _branchTrigger[bi] = ti;
    _branchPhase[bi] = BP_ARMED;
    _branchPhaseT[bi] = 0;
    _branchX[bi] = _triggerPos[ti * 2 + 0];
    _branchZ[bi] = _triggerPos[ti * 2 + 1];
    _branchHits[bi].clear();
    _branchCount++;
    // Self-gate: next dispatch for this trigger is scheduled at crash→linger
    // exit, not here. Set to Infinity so we don't fire again this cycle.
    _triggerNextAt[ti] = Number.POSITIVE_INFINITY;
    // Stamp branch hidden (it appears mid-fall); stamp ring at full opacity.
    _branchSetMeshes(bi, /*armed=*/true, /*falling=*/false, /*crash=*/false);
  }

  // 2. Advance every active branch's state machine.
  const heroAlive = state && state.hero && !state.gameOver;
  const hx = heroAlive ? state.hero.pos.x : 0;
  const hz = heroAlive ? state.hero.pos.z : 0;
  const enemies = (state && state.enemies && state.enemies.active) || null;
  let dirty = false;

  for (let i = 0; i < CAP_ACTIVE_BRANCHES; i++) {
    const phase = _branchPhase[i];
    if (phase === BP_IDLE) continue;
    _branchPhaseT[i] += dt;
    const t = _branchPhaseT[i];

    if (phase === BP_ARMED) {
      _branchSetMeshes(i, true, false, false);
      dirty = true;
      if (t >= BRANCH_ARMED_SEC) {
        _branchPhase[i] = BP_FALLING;
        _branchPhaseT[i] = 0;
      }
    } else if (phase === BP_FALLING) {
      // Animate Y from BRANCH_FALL_FROM_Y → BRANCH_FALL_TO_Y.
      _branchSetMeshes(i, true, true, false);
      dirty = true;
      if (t >= BRANCH_FALL_SEC) {
        _branchPhase[i] = BP_CRASH;
        _branchPhaseT[i] = 0;
        _branchHits[i].clear();
      }
    } else if (phase === BP_CRASH) {
      _branchSetMeshes(i, false, false, true);
      dirty = true;
      // Damage application — once per entity per crash.
      const cx = _branchX[i], cz = _branchZ[i];
      const r2 = BRANCH_DMG_RADIUS * BRANCH_DMG_RADIUS;
      if (heroAlive && !_branchHits[i].has(state.hero)) {
        const dx = hx - cx, dz = hz - cz;
        if (dx * dx + dz * dz <= r2) {
          try { heroTakeDamage(BRANCH_DMG); } catch (_) { /* swallow */ }
          // Hero "stun" — zero hazardSlow for BRANCH_STUN_DUR. Reads as a
          // movement freeze (multiplied with speed in hero.js — zero × speed
          // = no movement). dash + abilities still fire (they ride dashCD,
          // not hazardSlow).
          state.hero._envHazardSlowMul = 0;
          state.hero._envHazardSlowUntil = Math.max(
            (state.hero._envHazardSlowUntil || 0),
            _clock + BRANCH_STUN_DUR,
          );
          _branchHits[i].add(state.hero);
        }
      }
      if (enemies) {
        for (let j = 0; j < enemies.length; j++) {
          const e = enemies[j];
          if (!e || !e.alive) continue;
          if (_branchHits[i].has(e)) continue;
          const ex = (e.mesh && e.mesh.position) ? e.mesh.position.x : (e.pos ? e.pos.x : 0);
          const ez = (e.mesh && e.mesh.position) ? e.mesh.position.z : (e.pos ? e.pos.z : 0);
          const ddx = ex - cx, ddz = ez - cz;
          if (ddx * ddx + ddz * ddz > r2) continue;
          try { damageEnemy(e, BRANCH_DMG, 'forestEnvHazard'); _branchHits[i].add(e); }
          catch (_) { /* swallow */ }
        }
      }
      if (t >= BRANCH_CRASH_SEC) {
        _branchPhase[i] = BP_LINGER;
        _branchPhaseT[i] = 0;
      }
    } else if (phase === BP_LINGER) {
      _branchSetMeshes(i, false, false, true);
      dirty = true;
      if (t >= BRANCH_LINGER_SEC) {
        // Release slot back to pool, re-arm trigger.
        const ti = _branchTrigger[i];
        _branchPhase[i] = BP_IDLE;
        _branchTrigger[i] = -1;
        _branchHits[i].clear();
        _branchBoxMesh.setMatrixAt(i, _ZERO_MATRIX);
        _branchRingMesh.setMatrixAt(i, _ZERO_MATRIX);
        _branchCount = Math.max(0, _branchCount - 1);
        if (ti >= 0 && ti < _triggerCount) {
          _triggerActiveBranch[ti] = -1;
          // Self-gate the next dispatch via cooldown. mulberry-free since
          // this is per-entity stochastic; Math.random is fine for hazard
          // cadence (the placement/seed determinism is preserved on load).
          _triggerNextAt[ti] = _clock + (BRANCH_COOLDOWN_MIN
            + Math.random() * (BRANCH_COOLDOWN_MAX - BRANCH_COOLDOWN_MIN));
        }
        // Also re-arm any starved triggers whose nextAt was set to Infinity
        // because the pool was full at their original due time.
        _reArmStarvedTriggers();
      }
    }
  }

  if (dirty) {
    _branchBoxMesh.instanceMatrix.needsUpdate = true;
    _branchRingMesh.instanceMatrix.needsUpdate = true;
  }
}

function _reArmStarvedTriggers() {
  for (let ti = 0; ti < _triggerCount; ti++) {
    if (_triggerActiveBranch[ti] !== -1) continue;
    if (Number.isFinite(_triggerNextAt[ti])) continue;
    // Re-arm with a normal cooldown so they don't all fire at once.
    _triggerNextAt[ti] = _clock + (BRANCH_COOLDOWN_MIN
      + Math.random() * (BRANCH_COOLDOWN_MAX - BRANCH_COOLDOWN_MIN));
  }
}

function _branchSetMeshes(i, armedRingVisible, falling, crashOrLinger) {
  const cx = _branchX[i], cz = _branchZ[i];
  // Telegraph ring
  if (armedRingVisible) {
    _dummy.position.set(cx, 0.05, cz);
    _dummy.rotation.set(0, 0, 0);
    _dummy.scale.setScalar(1);
    _dummy.updateMatrix();
    _branchRingMesh.setMatrixAt(i, _dummy.matrix);
  } else {
    _branchRingMesh.setMatrixAt(i, _ZERO_MATRIX);
  }
  // Branch box
  if (falling) {
    const t = _branchPhaseT[i];
    const k = Math.min(1, t / BRANCH_FALL_SEC);
    const easeK = k * k; // ease-in for the drop
    const y = BRANCH_FALL_FROM_Y + (BRANCH_FALL_TO_Y - BRANCH_FALL_FROM_Y) * easeK;
    _dummy.position.set(cx, y, cz);
    _dummy.rotation.set(0, 0, 0);
    _dummy.scale.setScalar(1);
    _dummy.updateMatrix();
    _branchBoxMesh.setMatrixAt(i, _dummy.matrix);
  } else if (crashOrLinger) {
    _dummy.position.set(cx, BRANCH_FALL_TO_Y, cz);
    _dummy.rotation.set(0, 0, 0);
    _dummy.scale.setScalar(1);
    _dummy.updateMatrix();
    _branchBoxMesh.setMatrixAt(i, _dummy.matrix);
  } else {
    // Armed phase — branch hidden (only ring is visible).
    _branchBoxMesh.setMatrixAt(i, _ZERO_MATRIX);
  }
}

// ── public API ─────────────────────────────────────────────────────────────

/**
 * Build pre-pooled hazard meshes and scatter across all 7 forest rooms.
 * Idempotent — gated on `_loaded` so a double-load is a no-op.
 *
 * @param {THREE.Scene} scene
 * @param {Object} _state - GameState (unused at load; tick reads hero+enemies).
 * @param {Function} [rngOverride] - optional rng for tests; defaults to
 *   `_mulberry32(0xC0FFEB)` — distinct from neutrals (0xC0FFEA).
 */
export function loadForestEnvHazards(scene, _state, rngOverride) {
  if (_loaded) return;
  if (!scene) return;
  _group = new THREE.Group();
  _group.name = '__forestEnvHazards';

  _buildMushroomMeshes();
  _buildTarPitMesh();
  _buildBranchMeshes();

  _group.add(_stemMesh);
  _group.add(_capMesh);
  _group.add(_puffMesh);
  _group.add(_tarMesh);
  _group.add(_branchBoxMesh);
  _group.add(_branchRingMesh);

  let landmarkPositions = null;
  try { landmarkPositions = getLandmarkPositions(); }
  catch (_) { landmarkPositions = null; }

  const rand = (typeof rngOverride === 'function') ? rngOverride : _mulberry32(0xC0FFEB);
  _placeMushroomRings(rand, landmarkPositions);
  _placeTarPits(rand, landmarkPositions);
  _placeBranchTriggers(rand, landmarkPositions);

  _enemyTarLastTickAt = new WeakMap();
  _heroTarLastTickAt = -999;
  _clock = 0;

  scene.add(_group);
  _loaded = true;
}

/**
 * Per-frame tick: phase advance + damage application for all 3 hazard types.
 * Cheap when not loaded (single early-out).
 *
 * Hero slow is MIN-stacked against `state.hero.hazardSlow` (already written
 * absolute by tickStageHazards earlier in the frame). The tick order in
 * main.js places this AFTER tickStageHazards, so the min-write is observed
 * by the next frame's updateHero.
 *
 * @param {Object} state - GameState
 * @param {number} dt    - frame seconds (logic delta)
 */
export function tickForestEnvHazards(state, dt) {
  if (!_loaded) return;
  if (!state) return;
  _clock += dt;

  _tickMushroomRings(state, dt);
  _tickTarPits(state, dt);
  _tickBranchTriggers(state, dt);

  // Apply hero slow channel — MIN-stack with whatever stageHazards published
  // earlier in the frame. Stamped slow expires at `_envHazardSlowUntil`; on
  // expiry, reset to 1 so we don't permanently hold pollen at our value.
  if (state.hero) {
    const until = state.hero._envHazardSlowUntil || 0;
    if (_clock < until) {
      const myMul = state.hero._envHazardSlowMul;
      if (typeof myMul === 'number') {
        const current = (typeof state.hero.hazardSlow === 'number') ? state.hero.hazardSlow : 1;
        if (myMul < current) state.hero.hazardSlow = myMul;
      }
    } else {
      // Expired — reset our stamp so a stale mul doesn't bleed.
      if (state.hero._envHazardSlowMul !== undefined) {
        state.hero._envHazardSlowMul = 1;
      }
    }
  }
}

/**
 * Tear down all env-hazard meshes + clear pool state. Idempotent — safe to
 * call when not loaded. Pairs with disposeForestNeutrals shape so main.js
 * teardown blocks can call all four forest extras together.
 *
 * @param {THREE.Scene} scene
 */
export function disposeForestEnvHazards(scene) {
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

  _stemMesh = _capMesh = _puffMesh = null;
  _ringPos = _ringPhase = _ringPhaseT = null;
  _ringHits = null;
  _ringCount = 0;
  _mushroomCount = 0;

  _tarMesh = null;
  _tarPos = null;
  _tarCount = 0;
  _heroTarLastTickAt = -999;
  _enemyTarLastTickAt = null;

  _branchBoxMesh = _branchRingMesh = null;
  _triggerPos = _triggerNextAt = _triggerActiveBranch = null;
  _triggerCount = 0;
  _branchPhase = _branchPhaseT = _branchX = _branchZ = _branchTrigger = null;
  _branchHits = null;
  _branchCount = 0;

  // Clear hero stamps so a re-load doesn't inherit stale slow.
  if (_gameState && _gameState.hero) {
    _gameState.hero._envHazardSlowMul = 1;
    _gameState.hero._envHazardSlowUntil = 0;
  }
  _clock = 0;
  _loaded = false;

  if (_gameState && '_envHazardsLoaded' in _gameState) {
    _gameState._envHazardsLoaded = false;
  }
}
