/**
 * Forest Expansion v0.1 — Amber Labyrinth puzzle: Prism Lock (FE-C3C).
 *
 * Room: amberlabyrinth, center (130, 0)
 * Time limit: 90s (puzzleSystem.js hard-caps at 120s anyway)
 * Weapon reward: 'prism_warden'
 *
 * Setup:
 *   - 5 crystal prisms (InstancedMesh, octahedron-like facets), each with a
 *     rotation state in {0, 90, 180, 270} degrees.
 *   - 3 fixed emitter positions (light sources) at the room's west wall.
 *   - 3 target socket positions at the room's east wall.
 *   - Beams drawn each frame with chainFx (Spider Web FX bar).
 *
 * Beam model (v0.1):
 *   Each emitter fires a deterministic 2-segment beam: emitter → assigned
 *   prism → output toward (one of) the 4 cardinal directions selected by the
 *   prism's current rotation. The output ray is clamped to BEAM_MAX_LEN.
 *
 *   Pairing — emitters and prisms are paired one-to-one by index (emitter i
 *   reflects through prism i). Prisms 3 and 4 are "decoy" prisms not on any
 *   beam path; they exist so the player has to identify which prisms matter.
 *
 *   A target socket is "lit" if any beam's output ray passes within
 *   SOCKET_HIT_R of its center.
 *
 *   The winning rotation set is generated deterministically per run from
 *   state.run.startedAt (same seed pattern as Harmonic Alignment), so two
 *   attempts of the same run see the same puzzle, and a fresh run sees a
 *   fresh one.
 *
 * Interaction:
 *   When any player projectile (state.projectiles.active) passes within
 *   PRISM_HIT_R of a prism, that prism's rotation cycles by 90°. Same
 *   dedup pattern as forestAmber._checkProjectileHits — only one cycle per
 *   prism per tick (regardless of how many projectiles overlap). A small
 *   per-prism cooldown prevents a sustained projectile from spamming.
 *
 * Win:  all 3 target sockets lit simultaneously for >= WIN_HOLD_SECS (3s).
 *
 * Fail: 90s timeout, OR a beam terminates within AMBER_CHAIN_R of any idle
 *       forest amber entity → trigger that amber's chain-detonation centered
 *       on the player. Amber chain-detonation is reached by setting
 *       `entity.pendingDetonate = true` on the amber's entity object
 *       (forestAmber.js consumes that flag on its next tick — see lines
 *       413-420). Player takes self-damage via hero.takeDamage(SELF_DMG).
 *
 * Cleanup vs dispose (per puzzleSystem contract):
 *   cleanup(state) — reset rotations to start, clear win-hold timer. Meshes
 *                    stay alive.
 *   disposePrismLock(scene) — full teardown for stage swap.
 *
 * Palette (forest 8-color, LOCKED per docs/FOREST_VISUAL_STYLE.md):
 *   slot 2 0x2d3a55 — prism body
 *   slot 3 0x5f8fb5 — prism facet rim
 *   slot 4 0x7df0c4 — emitter glow (bio-glow primary)
 *   slot 8 0xa8e6ff — beam visuals (chain-lightning cyan-white)
 *
 * Quality bar:
 *   - Beams use spawnChainArc with both colors slot 8, life 0.16s (re-spawned
 *     each frame so they read as continuous beams). Default radii (0.085 /
 *     0.035) sit inside the 0.06-0.10 line weight band.
 *   - All glowing meshes tag BLOOM_LAYER.
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from './postfx.js';
import { registerPuzzle } from './puzzleSystem.js';
import { FOREST_ROOMS } from './forestRooms.js';
import { spawnChainArc } from './chainFx.js';
import { takeDamage } from './hero.js';
// Reach into forestAmber via its debug accessor — that's the documented
// "public" way to get entity references (see forestAmber.js line 578). The
// chain-detonate hop uses entity.pendingDetonate, which forestAmber's own
// tick consumes one frame later.
import { _debugEntities as _amberEntities } from './forestAmber.js';

// ─── Tunables ───────────────────────────────────────────────────────────────
const PUZZLE_ID         = 'prism_lock';
const ROOM_ID           = 'amberlabyrinth';
const WEAPON_REWARD     = 'prism_warden';
const TIME_LIMIT_SECS   = 90;

const PRISM_COUNT       = 5;
const PRISM_SIZE        = 0.85;
const PRISM_Y           = 0.85;
const PRISM_HIT_R       = 0.95;
const PRISM_HIT_R2      = PRISM_HIT_R * PRISM_HIT_R;
const PRISM_RING_R      = 4.5;           // ring radius around room center
const PRISM_CYCLE_CD    = 0.20;          // seconds between cycles on a single prism

const EMITTER_COUNT     = 3;
const EMITTER_SIDE_X    = -9.0;          // emitters on west side (room-relative)
const EMITTER_SPACING   = 3.5;           // z-axis spacing between emitters
const EMITTER_RADIUS    = 0.50;
const EMITTER_Y         = 0.60;

const SOCKET_COUNT      = 3;             // == EMITTER_COUNT (1:1 puzzle pairing)
const SOCKET_SIDE_X     = 9.0;
const SOCKET_SPACING    = 3.5;
const SOCKET_RADIUS     = 0.45;
const SOCKET_HIT_R      = 0.95;
const SOCKET_HIT_R2     = SOCKET_HIT_R * SOCKET_HIT_R;

const BEAM_Y            = 0.65;
const BEAM_LIFE         = 0.16;          // beams re-spawn each frame; short life
const BEAM_MAX_LEN      = 22.0;          // clamp on prism-out segment
const BEAM_TICK_HZ      = 12;            // beam re-spawn cadence (caps chainFx load)

const WIN_HOLD_SECS     = 3.0;           // all-3-lit must persist this long

const AMBER_CHAIN_R     = 1.50;          // beam-terminus → amber proximity
const AMBER_CHAIN_R2    = AMBER_CHAIN_R * AMBER_CHAIN_R;
const SELF_DAMAGE       = 18;

const COLOR_PRISM       = 0x2d3a55;      // slot 2
const COLOR_PRISM_RIM   = 0x5f8fb5;      // slot 3 — facet rim (used as emissive accent)
const COLOR_EMITTER     = 0x7df0c4;      // slot 4 — mint bio-glow
const COLOR_SOCKET_DIM  = 0x3ecf9a;      // slot 5 — dim socket
const COLOR_SOCKET_LIT  = 0xa8e6ff;      // slot 8 — cyan when lit
const COLOR_BEAM        = 0xa8e6ff;      // slot 8

// ─── Module state ───────────────────────────────────────────────────────────
let _group = null;
let _prismInst = null;
let _prismMat  = null;
let _prismGeo  = null;
let _emitterInst = null;
let _emitterMat  = null;
let _emitterGeo  = null;
let _socketInst = null;
let _socketMat  = null;
let _socketGeo  = null;
let _disposed = true;

// Per-prism state.
const _prisms = [];           // { x, z, rot (0..3 indexing 0/90/180/270), cdUntil, seenProjectiles:Set }
const _emitters = [];         // { x, z }
const _sockets = [];          // { x, z, lit:bool }
let _targetRotations = [];    // length PRISM_COUNT — winning rot (0..3)

// Win-hold timer (frame counter of seconds with all 3 sockets simultaneously lit).
let _winHoldT = 0;

// Beam re-spawn throttle.
let _beamSpawnAccum = 0;

// Scratch.
const _scratchM4    = new THREE.Matrix4();
const _scratchPos   = new THREE.Vector3();
const _scratchScale = new THREE.Vector3(1, 1, 1);
const _identityQuat = new THREE.Quaternion();

// Room anchor.
let _cx = 0;
let _cz = 0;

// ─── Helpers ────────────────────────────────────────────────────────────────
function _seededInt(seed, max) {
  let s = (seed >>> 0) || 1;
  s = (s + 0x6D2B79F5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) % max;
}

function _rollTargetRotations(state) {
  const baseSeed = ((state && state.run && state.run.startedAt) | 0) || 1;
  const out = new Array(PRISM_COUNT);
  for (let i = 0; i < PRISM_COUNT; i++) {
    out[i] = _seededInt(baseSeed + i * 7919, 4);
  }
  return out;
}

/**
 * Convert prism rotation (0..3) to an outgoing unit direction in world space.
 * Rotation 0 = +X, 1 = +Z, 2 = -X, 3 = -Z. The input direction (emitter→
 * prism) is ignored in v0.1 — each prism just routes its emitter's "incoming"
 * along its own configured cardinal output. This keeps the puzzle solvable
 * without a full optics raycaster and matches the "align all 3 beams" spec
 * granularity.
 */
function _outDir(rot, outVec) {
  switch (rot & 3) {
    case 0: outVec.set( 1, 0,  0); break;
    case 1: outVec.set( 0, 0,  1); break;
    case 2: outVec.set(-1, 0,  0); break;
    case 3: outVec.set( 0, 0, -1); break;
    default: outVec.set(1, 0, 0);
  }
}

function _writePrismMatrix(i) {
  const p = _prisms[i];
  _scratchPos.set(p.x, PRISM_Y, p.z);
  // Visual rotation around Y so the player can see the change.
  const ang = (p.rot * Math.PI) * 0.5;
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ang);
  _scratchScale.set(1, 1, 1);
  _scratchM4.compose(_scratchPos, q, _scratchScale);
  _prismInst.setMatrixAt(i, _scratchM4);
}

function _writeEmitterMatrix(i) {
  const e = _emitters[i];
  _scratchPos.set(e.x, EMITTER_Y, e.z);
  _scratchScale.set(1, 1, 1);
  _scratchM4.compose(_scratchPos, _identityQuat, _scratchScale);
  _emitterInst.setMatrixAt(i, _scratchM4);
}

function _writeSocketMatrix(i) {
  const s = _sockets[i];
  _scratchPos.set(s.x, EMITTER_Y, s.z);
  _scratchScale.set(1, 1, 1);
  _scratchM4.compose(_scratchPos, _identityQuat, _scratchScale);
  _socketInst.setMatrixAt(i, _scratchM4);
}

// ─── Public: load ───────────────────────────────────────────────────────────
export function loadPrismLock(scene) {
  if (!scene) return;
  if (!_disposed) disposePrismLock(scene);

  const room = FOREST_ROOMS[ROOM_ID];
  if (!room) return;
  _cx = room.center.x;
  _cz = room.center.z;

  _group = new THREE.Group();
  _group.name = '__puzzlePrismLock';

  // ── Prisms — octahedron facets, rotated each on Y axis ─────────────────
  _prismGeo = new THREE.OctahedronGeometry(PRISM_SIZE, 0);
  _prismMat = new THREE.MeshStandardMaterial({
    color: COLOR_PRISM,
    emissive: COLOR_PRISM_RIM,
    emissiveIntensity: 1.2,
    roughness: 0.35,
    metalness: 0.20,
    flatShading: true,                   // crisp facet light per FOREST_VISUAL_STYLE
    transparent: true,
    opacity: 0.95,
  });
  _prismInst = new THREE.InstancedMesh(_prismGeo, _prismMat, PRISM_COUNT);
  _prismInst.frustumCulled = false;
  _prismInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _prismInst.layers.enable(BLOOM_LAYER);
  _group.add(_prismInst);

  _prisms.length = 0;
  for (let i = 0; i < PRISM_COUNT; i++) {
    // Ring layout around room center. Prisms 0..2 are the "active" ones
    // (each paired with an emitter); prisms 3,4 are decoys to add puzzle
    // depth — present but not on the win-condition path.
    const ang = (i / PRISM_COUNT) * Math.PI * 2 - Math.PI / 2;
    const px = _cx + Math.cos(ang) * PRISM_RING_R;
    const pz = _cz + Math.sin(ang) * PRISM_RING_R;
    _prisms.push({
      x: px, z: pz,
      rot: 0,                            // start unaligned
      cdUntil: 0,                        // game-time cooldown
      seenProjectiles: new Set(),
    });
    _writePrismMatrix(i);
  }
  _prismInst.instanceMatrix.needsUpdate = true;

  // ── Emitters — small glowing spheres at west wall ──────────────────────
  _emitterGeo = new THREE.SphereGeometry(EMITTER_RADIUS, 12, 10);
  _emitterMat = new THREE.MeshStandardMaterial({
    color: COLOR_PRISM,
    emissive: COLOR_EMITTER,
    emissiveIntensity: 1.6,
    roughness: 0.30,
    metalness: 0.10,
    transparent: true,
    opacity: 0.95,
  });
  _emitterInst = new THREE.InstancedMesh(_emitterGeo, _emitterMat, EMITTER_COUNT);
  _emitterInst.frustumCulled = false;
  _emitterInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _emitterInst.layers.enable(BLOOM_LAYER);
  _group.add(_emitterInst);

  _emitters.length = 0;
  const eStartZ = _cz - ((EMITTER_COUNT - 1) * EMITTER_SPACING) * 0.5;
  for (let i = 0; i < EMITTER_COUNT; i++) {
    _emitters.push({
      x: _cx + EMITTER_SIDE_X,
      z: eStartZ + i * EMITTER_SPACING,
    });
    _writeEmitterMatrix(i);
  }
  _emitterInst.instanceMatrix.needsUpdate = true;

  // ── Sockets — small discs at east wall, light up when beam hits ────────
  _socketGeo = new THREE.CylinderGeometry(SOCKET_RADIUS, SOCKET_RADIUS, 0.18, 16, 1, false);
  _socketMat = new THREE.MeshStandardMaterial({
    color: COLOR_PRISM,
    emissive: COLOR_SOCKET_DIM,
    emissiveIntensity: 1.0,
    roughness: 0.40,
    metalness: 0.10,
    flatShading: true,
    transparent: true,
    opacity: 0.95,
  });
  _socketInst = new THREE.InstancedMesh(_socketGeo, _socketMat, SOCKET_COUNT);
  _socketInst.frustumCulled = false;
  _socketInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _socketInst.layers.enable(BLOOM_LAYER);
  _group.add(_socketInst);

  _sockets.length = 0;
  const sStartZ = _cz - ((SOCKET_COUNT - 1) * SOCKET_SPACING) * 0.5;
  for (let i = 0; i < SOCKET_COUNT; i++) {
    _sockets.push({
      x: _cx + SOCKET_SIDE_X,
      z: sStartZ + i * SOCKET_SPACING,
      lit: false,
    });
    _writeSocketMatrix(i);
  }
  _socketInst.instanceMatrix.needsUpdate = true;

  // Pre-roll a default target rotation set (overwritten by onStart's seed).
  _targetRotations = [0, 0, 0, 0, 0];

  scene.add(_group);
  _disposed = false;
}

// ─── Public: tick ───────────────────────────────────────────────────────────
const _scratchDir = new THREE.Vector3();
let _failPending = false;

export function tickPrismLock(dt, state) {
  if (_disposed || !_prismInst) return;
  if (!state || !state.scene) return;

  const scene = state.scene;
  const tNow = (state.time && state.time.game) || 0;

  // ── 1) Projectile-hit cycling ─────────────────────────────────────────
  const projectiles = state.projectiles && state.projectiles.active;
  if (projectiles && projectiles.length > 0) {
    for (let pi = 0; pi < _prisms.length; pi++) {
      const p = _prisms[pi];
      if (tNow < p.cdUntil) continue;
      for (let qi = 0; qi < projectiles.length; qi++) {
        const proj = projectiles[qi];
        if (!proj || !proj.mesh) continue;
        if (p.seenProjectiles.has(proj)) continue;
        const dx = proj.mesh.position.x - p.x;
        const dz = proj.mesh.position.z - p.z;
        if (dx * dx + dz * dz <= PRISM_HIT_R2) {
          p.seenProjectiles.add(proj);
          p.rot = (p.rot + 1) & 3;
          p.cdUntil = tNow + PRISM_CYCLE_CD;
          _writePrismMatrix(pi);
          _prismInst.instanceMatrix.needsUpdate = true;
          break;
        }
      }
      // Prune the seen-set occasionally — bounded by puzzle duration but
      // could grow without bound otherwise. Cheap clear is fine because
      // cdUntil prevents same-projectile re-trigger within the cooldown.
      if (p.seenProjectiles.size > 64) p.seenProjectiles.clear();
    }
  }

  // ── 2) Recompute beam paths & socket-lit state every frame ────────────
  // Reset socket lit flags this frame.
  for (const s of _sockets) s.lit = false;

  // Resolve each (emitter, prism) pair: beam goes emitter → prism → out.
  // The output direction is set by prism.rot. End point is clamped to
  // BEAM_MAX_LEN. If end point is within SOCKET_HIT_R of any socket → lit.
  // If end point is within AMBER_CHAIN_R of an idle forest amber → fail
  // via amber chain-detonate next tick.
  const amberEntities = (() => {
    try { return _amberEntities() || []; } catch (_) { return []; }
  })();

  // Beam re-spawn throttle — chainFx pool is 48 slots; 3 beams × 2 segments
  // × ~12 Hz = ~72 spawns/sec, well inside the pool churn budget.
  _beamSpawnAccum += dt;
  const spawnInterval = 1.0 / BEAM_TICK_HZ;
  const spawnThisFrame = _beamSpawnAccum >= spawnInterval;
  if (spawnThisFrame) _beamSpawnAccum = 0;

  for (let i = 0; i < EMITTER_COUNT; i++) {
    const e = _emitters[i];
    const p = _prisms[i];                // 1:1 pairing for active prisms
    if (!e || !p) continue;

    _outDir(p.rot, _scratchDir);
    const endX = p.x + _scratchDir.x * BEAM_MAX_LEN;
    const endZ = p.z + _scratchDir.z * BEAM_MAX_LEN;

    // ── Re-spawn beam segments (throttled) ──
    if (spawnThisFrame) {
      // Emitter → prism segment.
      spawnChainArc(scene, { x: e.x, z: e.z }, { x: p.x, z: p.z }, {
        outerColor: COLOR_BEAM,
        innerColor: COLOR_BEAM,
        life: BEAM_LIFE * 1.4,           // slight overshoot so beams overlap cleanly
        y: BEAM_Y,
      });
      // Prism → out segment.
      spawnChainArc(scene, { x: p.x, z: p.z }, { x: endX, z: endZ }, {
        outerColor: COLOR_BEAM,
        innerColor: COLOR_BEAM,
        life: BEAM_LIFE * 1.4,
        y: BEAM_Y,
      });
    }

    // ── Socket lighting check ──
    // Walk the beam from prism to endpoint in coarse steps. Any socket
    // within SOCKET_HIT_R of any sample point → lit. (Closed-form
    // point-line-segment distance is cheaper but the few samples we
    // already need for amber-collision below let us reuse the loop.)
    const STEPS = 12;
    let beamTipX = p.x;
    let beamTipZ = p.z;
    for (let k = 1; k <= STEPS; k++) {
      const t = k / STEPS;
      const sx = p.x + (endX - p.x) * t;
      const sz = p.z + (endZ - p.z) * t;
      for (let si = 0; si < _sockets.length; si++) {
        const sock = _sockets[si];
        if (sock.lit) continue;
        const dxs = sock.x - sx;
        const dzs = sock.z - sz;
        if (dxs * dxs + dzs * dzs <= SOCKET_HIT_R2) {
          sock.lit = true;
        }
      }
      beamTipX = sx;
      beamTipZ = sz;
    }

    // ── Amber chain-detonate trap ──
    // If the BEAM TERMINUS lands close to an idle amber, queue its chain
    // detonation (forestAmber consumes pendingDetonate on next tick),
    // damage the player, and arm the fail flag. We only test the terminus
    // (cheaper than per-step) — landing the beam in an amber cluster IS
    // the player error the mechanic punishes.
    for (const ae of amberEntities) {
      if (!ae || ae.state !== 'idle' || ae.pendingDetonate) continue;
      const dxa = ae.x - beamTipX;
      const dza = ae.z - beamTipZ;
      if (dxa * dxa + dza * dza <= AMBER_CHAIN_R2) {
        ae.pendingDetonate = true;       // forestAmber will fire FX next tick
        _failPending = true;
        try { takeDamage(SELF_DAMAGE); } catch (_) {}
        break;
      }
    }
  }

  // ── 3) Socket emissive feedback ────────────────────────────────────────
  // Single shared material — lit-state is signaled by lifting the whole
  // bank to slot-8 cyan when ALL 3 are lit (the "you're on the win path"
  // tell). When partial, hold the dim mint. Per-instance recolor would
  // need an InstancedColor attribute — overkill for 3 sockets at this fidelity.
  if (_socketMat) {
    let allLit = true;
    for (const s of _sockets) if (!s.lit) { allLit = false; break; }
    if (allLit) {
      _socketMat.emissive.setHex(COLOR_SOCKET_LIT);
      _socketMat.emissiveIntensity = 2.2;
    } else {
      _socketMat.emissive.setHex(COLOR_SOCKET_DIM);
      _socketMat.emissiveIntensity = 1.0;
    }
  }

  // ── 4) Win-hold timer ──────────────────────────────────────────────────
  let allLitNow = true;
  for (const s of _sockets) if (!s.lit) { allLitNow = false; break; }
  if (allLitNow) {
    _winHoldT += dt;
  } else {
    _winHoldT = 0;
  }

  // Publish progress for HUD / debug.
  if (state.run) {
    state.run.prismLockSocketsLit = [
      _sockets[0] ? !!_sockets[0].lit : false,
      _sockets[1] ? !!_sockets[1].lit : false,
      _sockets[2] ? !!_sockets[2].lit : false,
    ];
    state.run.prismLockWinHold = _winHoldT;
  }
}

// ─── Public: dispose ────────────────────────────────────────────────────────
export function disposePrismLock(scene) {
  if (_group) {
    if (scene && _group.parent === scene) scene.remove(_group);
    else if (_group.parent) _group.parent.remove(_group);
    _group = null;
  }
  if (_prismGeo)   { try { _prismGeo.dispose(); }   catch (_) {} _prismGeo = null; }
  if (_prismMat)   { try { _prismMat.dispose(); }   catch (_) {} _prismMat = null; }
  if (_emitterGeo) { try { _emitterGeo.dispose(); } catch (_) {} _emitterGeo = null; }
  if (_emitterMat) { try { _emitterMat.dispose(); } catch (_) {} _emitterMat = null; }
  if (_socketGeo)  { try { _socketGeo.dispose(); }  catch (_) {} _socketGeo = null; }
  if (_socketMat)  { try { _socketMat.dispose(); }  catch (_) {} _socketMat = null; }
  _prismInst = null;
  _emitterInst = null;
  _socketInst = null;
  _prisms.length = 0;
  _emitters.length = 0;
  _sockets.length = 0;
  _targetRotations.length = 0;
  _winHoldT = 0;
  _beamSpawnAccum = 0;
  _failPending = false;
  _disposed = true;
}

// ─── Internal: per-attempt reset ────────────────────────────────────────────
function _resetPuzzleState(state) {
  // Reset rotations to 0 and clear projectile dedup sets so a retry's
  // first projectile cycles cleanly.
  for (let i = 0; i < _prisms.length; i++) {
    const p = _prisms[i];
    p.rot = 0;
    p.cdUntil = 0;
    p.seenProjectiles.clear();
    if (_prismInst) _writePrismMatrix(i);
  }
  if (_prismInst) _prismInst.instanceMatrix.needsUpdate = true;
  for (const s of _sockets) s.lit = false;
  _winHoldT = 0;
  _beamSpawnAccum = 0;
  _failPending = false;
  if (state && state.run) {
    state.run.prismLockSocketsLit = [false, false, false];
    state.run.prismLockWinHold = 0;
  }
}

// ─── Puzzle registration ────────────────────────────────────────────────────
registerPuzzle({
  id: PUZZLE_ID,
  roomId: ROOM_ID,
  timeLimit: TIME_LIMIT_SECS,
  weaponReward: WEAPON_REWARD,

  onStart(state) {
    _resetPuzzleState(state);
    _targetRotations = _rollTargetRotations(state);
    if (state && state.run) state.run.prismLockTargets = _targetRotations.slice();
  },

  isWinCondition(/* state */) {
    return _winHoldT >= WIN_HOLD_SECS;
  },

  isFailCondition(/* state */) {
    return _failPending === true;
  },

  // No onFail body — chain detonation FX + self-damage already fired during
  // tick. Slow / debuff is intentionally NOT applied (the amber explosion
  // is its own punishment).

  cleanup(state) {
    _resetPuzzleState(state);
  },
});

// ─── Debug surface ──────────────────────────────────────────────────────────
export function _debugPrismLockPrisms() { return _prisms.slice(); }
export function _debugPrismLockSockets() { return _sockets.slice(); }
export function _debugPrismLockWinHold() { return _winHoldT; }
export function _debugPrismLockTargets() { return _targetRotations.slice(); }
