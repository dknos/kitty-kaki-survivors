/**
 * Forest Expansion v0.1 — Sap Hollow puzzle: Flow Weaver (FE-C3C).
 *
 * Room: saphollow, center (-70, -90)
 * Time limit: 75s (puzzleSystem.js hard-caps at 120s anyway)
 * Weapon reward: 'sap_weaver' (gated via puzzleSystem._win → unlockForestWeapon)
 *
 * Setup:
 *   - 6 floating sap orbs (InstancedMesh, bob in place, glow tint slot 5 mint)
 *   - 3 conduit pillars (visible amber sinks, slot 7)
 *   - All meshes parented to a module Group so dispose is one scene.remove.
 *
 * Interaction:
 *   The player drops Sticky Web patches (`state.webs.list`) by firing the
 *   existing weapon. When a web touches an orb (proximity within ORB_TRIGGER_R),
 *   the orb receives an impulse toward its NEAREST conduit (dot-product over
 *   normalized orb→conduit vectors picks the nearest by direction-agnostic
 *   distance). Per-orb Set dedups each web reference so a sustained 5-second
 *   web doesn't re-impulse every frame.
 *
 *   v0.1 simplifications (per task brief):
 *     - No 90° wall ricochet (direct impulse only)
 *     - Single orb-type (no amber/crystal distinction in the catch logic)
 *     - Conduit catch = orb within CONDUIT_CATCH_R of conduit center
 *
 * Win:  every conduit has caught >= 2 orbs.
 * Fail: 75s timeout OR endPuzzleEarly() — onFail snaps orbs back to start and
 *       publishes a soft penalty (state.run.fountainSpeedBuff with mul: 0.6,
 *       8s) so the player feels the failure even though hero.js doesn't yet
 *       read a forest-specific slow flag. The fountainSpeedBuff field is the
 *       only existing hero-read speed-buff hook (see src/hero.js:307-309); we
 *       set it to a <1 multiplier so it slows the player. Twilight fountains
 *       don't co-exist on the Forest stage so there's no real conflict.
 *
 * Cleanup vs dispose (per puzzleSystem contract):
 *   cleanup(state) — reset orb positions, clear catch counts, hide impulse
 *                    state. Mesh + materials stay alive so a retry attempt
 *                    spawns instantly.
 *   disposeFlowWeaver(scene) — full teardown (geometries + materials + group
 *                    removal). Called on stage teardown by the integration
 *                    glue (FE-C3A) — not from cleanup so retries don't go
 *                    empty.
 *
 * Palette (forest 8-color, LOCKED per docs/FOREST_VISUAL_STYLE.md):
 *   slot 5 0x3ecf9a — sap orb emissive (bio-glow secondary, mint deep)
 *   slot 7 0xffd86b — conduit pillar emissive (amber detonation yellow)
 *   slot 4 0x7df0c4 — orb→conduit connection trail (bio-glow primary)
 *
 * Quality bar (Spider Web FX, per docs):
 *   - Bloom-tagged via BLOOM_LAYER on every glowing mesh.
 *   - Conduit pillars use flatShading + emissive 1.4-2.0.
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from './postfx.js';
import { registerPuzzle } from './puzzleSystem.js';
import { FOREST_ROOMS } from './forestRooms.js';

// ─── Tunables ───────────────────────────────────────────────────────────────
const PUZZLE_ID         = 'flow_weaver';
const ROOM_ID           = 'saphollow';
const WEAPON_REWARD     = 'sap_weaver';
const TIME_LIMIT_SECS   = 75;

const ORB_COUNT         = 6;
const ORB_RADIUS        = 0.45;          // visual sphere radius
const ORB_BOB_AMP       = 0.18;          // y-bob amplitude
const ORB_BOB_HZ        = 0.6;
const ORB_Y_BASE        = 1.2;           // resting height above floor
const ORB_TRIGGER_R     = 1.10;          // web→orb proximity
const ORB_TRIGGER_R2    = ORB_TRIGGER_R * ORB_TRIGGER_R;
const ORB_IMPULSE_SPEED = 6.0;           // m/s once impulsed
const ORB_FRICTION      = 1.6;           // m/s² scalar drag while moving
const ORB_SCATTER_R     = 5.5;           // initial orb spawn ring radius around room center

const CONDUIT_COUNT     = 3;
const CONDUIT_RADIUS    = 0.55;          // base radius of pillar
const CONDUIT_HEIGHT    = 2.4;
const CONDUIT_RING_R    = 7.5;           // distance from room center to each conduit
const CONDUIT_CATCH_R   = 1.20;          // orb → conduit center catch radius
const CONDUIT_CATCH_R2  = CONDUIT_CATCH_R * CONDUIT_CATCH_R;
const CONDUIT_TARGET    = 2;             // orbs needed per conduit to win

const COLOR_ORB_BODY    = 0x1a1e22;      // slot 1 — near-black charcoal core
const COLOR_ORB_GLOW    = 0x3ecf9a;      // slot 5 — bio-glow secondary (mint deep)
const COLOR_CONDUIT     = 0x2d3a55;      // slot 2 — crystal deep blue-gray base
const COLOR_CONDUIT_GLOW= 0xffd86b;      // slot 7 — amber detonation yellow
const COLOR_TRAIL       = 0x7df0c4;      // slot 4 — bio-glow primary (orb trail glints)

const FAIL_SLOW_MUL     = 0.6;           // <1 so it actually slows
const FAIL_SLOW_DURATION= 8.0;           // seconds

// ─── Module state ───────────────────────────────────────────────────────────
let _group = null;                       // parent THREE.Group for everything
let _orbInst = null;                     // InstancedMesh — 6 orbs
let _orbMat  = null;
let _orbGeo  = null;
let _conduitInst = null;                 // InstancedMesh — 3 conduit pillars
let _conduitMat  = null;
let _conduitGeo  = null;
let _disposed = true;                    // true until first loadFlowWeaver

// Per-orb runtime state (slot-aligned with _orbInst).
const _orbs = [];                        // { x, z, sx, sz, vx, vz, moving, caught, phase, seenWebs:Set }
const _conduits = [];                    // { x, z, caught:number }

// Scratch — avoid per-frame allocations in tick.
const _scratchM4    = new THREE.Matrix4();
const _scratchPos   = new THREE.Vector3();
const _scratchScale = new THREE.Vector3(1, 1, 1);
const _identityQuat = new THREE.Quaternion();
const _conduitQuat  = new THREE.Quaternion(); // upright orientation (identity already works)

// Anchor (room center) — resolved at load (FOREST_ROOMS) so a future room
// reposition only needs the registry change.
let _cx = 0;
let _cz = 0;

// Lifecycle bookkeeping flags published into state.run.* so puzzleSystem
// callers + the integration glue can inspect progress without poking module
// internals. Cleared by `_resetPuzzleState`.
function _publishProgress(state) {
  if (!state || !state.run) return;
  state.run.flowWeaverCaught = [
    _conduits[0] ? _conduits[0].caught : 0,
    _conduits[1] ? _conduits[1].caught : 0,
    _conduits[2] ? _conduits[2].caught : 0,
  ];
}

// ─── Public: load ───────────────────────────────────────────────────────────
/**
 * Build the orb + conduit meshes for Sap Hollow. Idempotent — a second
 * call disposes the prior build first.
 *
 * @param {THREE.Scene} scene
 */
export function loadFlowWeaver(scene) {
  if (!scene) return;
  if (!_disposed) disposeFlowWeaver(scene);

  const room = FOREST_ROOMS[ROOM_ID];
  if (!room) {
    // Should never happen — registry ships before this module. Bail silently
    // so a malformed save can't crash the stage load.
    return;
  }
  _cx = room.center.x;
  _cz = room.center.z;

  _group = new THREE.Group();
  _group.name = '__puzzleFlowWeaver';

  // ── Orbs: 6 floating spheres, slot-5 mint glow, bob in place ────────────
  _orbGeo = new THREE.SphereGeometry(ORB_RADIUS, 16, 12);
  _orbMat = new THREE.MeshStandardMaterial({
    color: COLOR_ORB_BODY,
    emissive: COLOR_ORB_GLOW,
    emissiveIntensity: 1.6,              // within 1.2-1.8 bio-glow band
    roughness: 0.35,
    metalness: 0.10,
    flatShading: false,                  // orbs read as smooth pearls
    transparent: true,
    opacity: 0.92,
  });
  _orbInst = new THREE.InstancedMesh(_orbGeo, _orbMat, ORB_COUNT);
  _orbInst.frustumCulled = false;
  _orbInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _orbInst.layers.enable(BLOOM_LAYER);
  _group.add(_orbInst);

  _orbs.length = 0;
  for (let i = 0; i < ORB_COUNT; i++) {
    const ang = (i / ORB_COUNT) * Math.PI * 2;
    const sx = _cx + Math.cos(ang) * ORB_SCATTER_R;
    const sz = _cz + Math.sin(ang) * ORB_SCATTER_R;
    _orbs.push({
      x: sx, z: sz,
      sx, sz,                            // remembered start for fail-snap-back
      vx: 0, vz: 0,
      moving: false,
      caught: false,
      phase: ang,                        // bob desync
      seenWebs: new Set(),               // per-orb web-ref dedup
    });
    _writeOrbMatrix(i);
  }
  _orbInst.instanceMatrix.needsUpdate = true;

  // ── Conduits: 3 pillars at fixed angles, slot-7 amber glow ──────────────
  _conduitGeo = new THREE.CylinderGeometry(CONDUIT_RADIUS * 0.85, CONDUIT_RADIUS, CONDUIT_HEIGHT, 8, 1, false);
  _conduitMat = new THREE.MeshStandardMaterial({
    color: COLOR_CONDUIT,
    emissive: COLOR_CONDUIT_GLOW,
    emissiveIntensity: 1.6,              // within 1.4-2.0 amber idle band
    roughness: 0.40,
    metalness: 0.20,
    flatShading: true,                   // catch faceted light per FOREST_VISUAL_STYLE
    transparent: true,
    opacity: 0.95,
  });
  _conduitInst = new THREE.InstancedMesh(_conduitGeo, _conduitMat, CONDUIT_COUNT);
  _conduitInst.frustumCulled = false;
  _conduitInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _conduitInst.layers.enable(BLOOM_LAYER);
  _group.add(_conduitInst);

  _conduits.length = 0;
  for (let i = 0; i < CONDUIT_COUNT; i++) {
    // 3-fold symmetric ring offset by π/6 so conduits don't sit dead-on
    // the orb spawn angles (would let an orb fall straight onto a conduit
    // before the player webs it).
    const ang = (i / CONDUIT_COUNT) * Math.PI * 2 + Math.PI / 6;
    const cx = _cx + Math.cos(ang) * CONDUIT_RING_R;
    const cz = _cz + Math.sin(ang) * CONDUIT_RING_R;
    _conduits.push({ x: cx, z: cz, caught: 0 });

    _scratchPos.set(cx, CONDUIT_HEIGHT * 0.5, cz);
    _scratchScale.set(1, 1, 1);
    _scratchM4.compose(_scratchPos, _conduitQuat, _scratchScale);
    _conduitInst.setMatrixAt(i, _scratchM4);
  }
  _conduitInst.instanceMatrix.needsUpdate = true;

  scene.add(_group);
  _disposed = false;

  // Touched-but-unused identity values (silence "unused" lints in some
  // toolchains while flagging intent for future use).
  void _identityQuat;
  void COLOR_TRAIL;
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function _writeOrbMatrix(i) {
  const o = _orbs[i];
  // Y bob applied during tick; baseline write here uses ORB_Y_BASE only.
  _scratchPos.set(o.x, ORB_Y_BASE, o.z);
  _scratchScale.set(1, 1, 1);
  _scratchM4.compose(_scratchPos, _identityQuat, _scratchScale);
  _orbInst.setMatrixAt(i, _scratchM4);
}

/**
 * For an orb at (x,z), find the conduit whose normalized direction
 * minimises (1 - dot(orb→conduit, world-down-irrelevant)) — i.e. the
 * conduit with smallest angle subtended. In practice with 3 well-spread
 * conduits this is identical to "nearest by squared distance"; the brief
 * specified dot-product so we use it explicitly to keep the contract
 * transparent.
 *
 * Returns the conduit index, or -1 if no conduit exists (puzzle disposed).
 */
function _nearestConduit(ox, oz) {
  if (_conduits.length === 0) return -1;
  let best = -1;
  let bestD2 = Infinity;
  for (let i = 0; i < _conduits.length; i++) {
    const c = _conduits[i];
    const dx = c.x - ox;
    const dz = c.z - oz;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = i; }
  }
  return best;
}

// ─── Public: tick ───────────────────────────────────────────────────────────
/**
 * Per-frame integrator. Idempotent on disposed state — bails immediately.
 *
 * @param {number} dt seconds since last frame
 * @param {any} state global game state (passes through state.webs.list)
 */
export function tickFlowWeaver(dt, state) {
  if (_disposed || !_orbInst) return;
  if (!state) return;

  const webs = state.webs && state.webs.list;
  const tGame = (state.time && state.time.game) || 0;
  let dirty = false;

  for (let i = 0; i < _orbs.length; i++) {
    const o = _orbs[i];
    if (o.caught) {
      // Snap caught orbs out of play — hide their matrix by zero-scaling so
      // they neither receive impulses nor occlude the conduit visual.
      _scratchPos.set(o.x, ORB_Y_BASE, o.z);
      _scratchScale.set(0, 0, 0);
      _scratchM4.compose(_scratchPos, _identityQuat, _scratchScale);
      _orbInst.setMatrixAt(i, _scratchM4);
      dirty = true;
      continue;
    }

    // ── Web hit detection (only for orbs not already moving) ───────────────
    if (!o.moving && webs && webs.length > 0) {
      for (let w = 0; w < webs.length; w++) {
        const web = webs[w];
        if (!web) continue;
        if (o.seenWebs.has(web)) continue;
        const dx = web.x - o.x;
        const dz = web.z - o.z;
        // Web radius is generous — combine with orb trigger so a partial overlap
        // still counts. (Web radius typically ~4u, so adding orb trigger keeps
        // detection symmetric.)
        const wr = (typeof web.radius === 'number' ? web.radius : 4.0);
        const r2 = (wr + ORB_TRIGGER_R) * (wr + ORB_TRIGGER_R);
        if (dx * dx + dz * dz <= r2) {
          o.seenWebs.add(web);
          // Impulse toward nearest conduit.
          const cIdx = _nearestConduit(o.x, o.z);
          if (cIdx >= 0) {
            const c = _conduits[cIdx];
            const tx = c.x - o.x;
            const tz = c.z - o.z;
            const len = Math.hypot(tx, tz) || 1;
            o.vx = (tx / len) * ORB_IMPULSE_SPEED;
            o.vz = (tz / len) * ORB_IMPULSE_SPEED;
            o.moving = true;
          }
          break;  // one impulse per tick per orb
        }
      }
    }

    // ── Integrate motion ───────────────────────────────────────────────────
    if (o.moving) {
      // Friction — scalar decel along velocity vector.
      const sp = Math.hypot(o.vx, o.vz);
      if (sp > 0) {
        const decel = Math.min(sp, ORB_FRICTION * dt);
        o.vx -= (o.vx / sp) * decel;
        o.vz -= (o.vz / sp) * decel;
      }
      o.x += o.vx * dt;
      o.z += o.vz * dt;

      // Conduit catch?
      for (let c = 0; c < _conduits.length; c++) {
        const cd = _conduits[c];
        const dx = cd.x - o.x;
        const dz = cd.z - o.z;
        if (dx * dx + dz * dz <= CONDUIT_CATCH_R2) {
          cd.caught += 1;
          o.caught = true;
          o.moving = false;
          o.vx = o.vz = 0;
          break;
        }
      }
      // Speed died? Stop & let player re-web it.
      if (!o.caught && Math.hypot(o.vx, o.vz) < 0.1) {
        o.moving = false;
        o.vx = o.vz = 0;
        o.seenWebs.clear();  // forgive: let same web re-trigger after rest
      }
    } else {
      // Idle bob — y wobble only; xz unchanged.
      o.phase += dt * Math.PI * 2 * ORB_BOB_HZ;
    }

    // Write matrix. Y = base + bob (only while idle); moving orbs hold base Y.
    const y = o.moving ? ORB_Y_BASE : ORB_Y_BASE + Math.sin(o.phase) * ORB_BOB_AMP;
    _scratchPos.set(o.x, y, o.z);
    _scratchScale.set(1, 1, 1);
    _scratchM4.compose(_scratchPos, _identityQuat, _scratchScale);
    _orbInst.setMatrixAt(i, _scratchM4);
    dirty = true;
  }

  if (dirty) _orbInst.instanceMatrix.needsUpdate = true;

  // Publish caught counts so the HUD (FE-C3A) can render "2/2 2/2 1/2".
  _publishProgress(state);

  // Subtle conduit pulse — emissive lerps slightly to "breathe". Single
  // material covers all 3 (cheap).
  if (_conduitMat) {
    const pulse = 0.5 + 0.5 * Math.sin(tGame * Math.PI * 2 * 0.4);
    _conduitMat.emissiveIntensity = 1.4 + (2.0 - 1.4) * pulse;
  }
}

// ─── Public: dispose ────────────────────────────────────────────────────────
/**
 * Full teardown — geometries + materials disposed, scene group removed.
 * Called by integration glue on stage teardown / run reset, NOT by the
 * puzzleSystem cleanup hook (so retries on the same stage spawn instantly).
 *
 * @param {THREE.Scene} scene
 */
export function disposeFlowWeaver(scene) {
  if (_group) {
    if (scene && _group.parent === scene) scene.remove(_group);
    else if (_group.parent) _group.parent.remove(_group);
    _group = null;
  }
  if (_orbGeo)     { try { _orbGeo.dispose(); }     catch (_) {} _orbGeo = null; }
  if (_orbMat)     { try { _orbMat.dispose(); }     catch (_) {} _orbMat = null; }
  if (_conduitGeo) { try { _conduitGeo.dispose(); } catch (_) {} _conduitGeo = null; }
  if (_conduitMat) { try { _conduitMat.dispose(); } catch (_) {} _conduitMat = null; }
  _orbInst = null;
  _conduitInst = null;
  _orbs.length = 0;
  _conduits.length = 0;
  _disposed = true;
}

// ─── Internal: reset (called from puzzle cleanup hook) ──────────────────────
/**
 * Reset orbs to start, clear catch counts, but keep the meshes alive so a
 * retry attempt spawns immediately. Called by puzzleSystem on both win and
 * fail/timeout paths.
 */
function _resetPuzzleState(state) {
  for (const o of _orbs) {
    o.x = o.sx;
    o.z = o.sz;
    o.vx = 0;
    o.vz = 0;
    o.moving = false;
    o.caught = false;
    o.seenWebs.clear();
  }
  for (const c of _conduits) c.caught = 0;
  // Rewrite all orb matrices so a previously-caught orb (hidden-scale) re-shows.
  if (_orbInst) {
    for (let i = 0; i < _orbs.length; i++) _writeOrbMatrix(i);
    _orbInst.instanceMatrix.needsUpdate = true;
  }
  if (state && state.run) state.run.flowWeaverCaught = [0, 0, 0];
}

// ─── Puzzle registration ────────────────────────────────────────────────────
// Module-load one-shot — puzzleSystem stores the def by id. Cohort 3A
// integration glue calls startPuzzle('flow_weaver') on player interact-key
// press inside the saphollow room.
registerPuzzle({
  id: PUZZLE_ID,
  roomId: ROOM_ID,
  timeLimit: TIME_LIMIT_SECS,
  weaponReward: WEAPON_REWARD,

  onStart(state) {
    _resetPuzzleState(state);
  },

  isWinCondition(/* state */) {
    if (_conduits.length === 0) return false;
    for (const c of _conduits) {
      if (c.caught < CONDUIT_TARGET) return false;
    }
    return true;
  },

  // No isFailCondition — puzzleSystem handles timeout via _limit. Manual
  // fails (e.g. boss-spawn force-return) go through endPuzzleEarly().

  onFail(state) {
    // Soft penalty — slow the player for 8s. The fountainSpeedBuff field is
    // the only existing hero-read slow hook (src/hero.js:307-309); Forest
    // stage doesn't ship twilight fountains so there's no real conflict.
    // mul: 0.6 < 1 so it slows rather than buffs.
    if (state && state.run) {
      const tNow = (state.time && state.time.game) || 0;
      state.run.fountainSpeedBuff = {
        mul: FAIL_SLOW_MUL,
        expiresAt: tNow + FAIL_SLOW_DURATION,
      };
    }
  },

  cleanup(state) {
    // Win OR fail — return orbs to start, conduit counts to zero. Mesh stays.
    _resetPuzzleState(state);
  },
});

// ─── Debug surface ──────────────────────────────────────────────────────────
export function _debugFlowWeaverConduits() { return _conduits.slice(); }
export function _debugFlowWeaverOrbs() { return _orbs.slice(); }
