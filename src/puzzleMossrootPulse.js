/**
 * Forest Expansion v0.2 — Mossroot Hollow puzzle: Mossroot Pulse (FE-V2).
 *
 * Room: mossroot, center (0, -140)
 * Time limit: 90s (puzzleSystem.js hard-caps at 120s anyway)
 * Weapon reward: 'root_grasp' (gated via puzzleSystem._win → unlockForestWeapon)
 *
 * Simon-says pulse pattern:
 *   - 3 root nodes (slot-4 mint glow when armed) arranged in a triangle
 *     around the room center.
 *   - Nodes light up in random sequence during a DEMO phase (slot-5
 *     pulse, ~0.55s per node).
 *   - During INPUT phase, player must touch them in the same order via
 *     proximity (within TOUCH_R of node center).
 *   - 3 successful sequences total, each one node longer & faster:
 *       round 1: 3 nodes, demo cadence 0.55s/node
 *       round 2: 4 nodes (one node may repeat), demo cadence 0.45s/node
 *       round 3: 5 nodes, demo cadence 0.38s/node
 *     Wrong-touch → fail (snap-back, soft penalty).
 *   - 8s per-round input window (per task brief; total 120s hard cap stays).
 *
 * Lifecycle (mirrors puzzleHarmonicAlignment + puzzleFlowWeaver):
 *   loadMossrootPulse(scene)       — build node meshes
 *   tickMossrootPulse(dt, state)   — wired via puzzleSystem onTick callback
 *   disposeMossrootPulse(scene)    — full teardown (called by main.js
 *                                    stage teardown paths)
 *
 * Solve path:
 *   3 rounds complete → puzzleSystem._win fires → markForestPuzzleSolved
 *   + unlockForestWeapon('root_grasp'). Per puzzleSystem contract we just
 *   set `_phase = PHASE_DONE` and return true from isWinCondition.
 *
 * Fail path:
 *   - Wrong-touch sets `_wrongTouch = true` → isFailCondition returns true.
 *   - 8s input-window timeout sets `_wrongTouch = true` likewise.
 *   - puzzleSystem._fail fires → onFail publishes a soft hero slow (mirrors
 *     puzzleFlowWeaver onFail using fountainSpeedBuff — the only existing
 *     hero-read speed-buff hook in src/hero.js).
 *
 * Palette (forest 8-color, LOCKED per docs/FOREST_VISUAL_STYLE.md):
 *   slot 1 0x1a1e22 — node body charcoal stub base
 *   slot 4 0x7df0c4 — armed-node bio-glow mint (BLOOM_LAYER, additive ring)
 *   slot 5 0x3ecf9a — pulse-firing glow (peak during demo flash)
 *   slot 7 0xffd86b — solved-node amber (round-complete celebration accent)
 *
 * Quality bar (Spider Web FX, per docs):
 *   - Bloom-tagged via BLOOM_LAYER on every glowing mesh.
 *   - Ring rim line weight 0.07u (within 0.06-0.10 spec band).
 *   - emissiveIntensity 1.4-2.0 during armed pulse, 3.0 peak on flash.
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from './postfx.js';
import { registerPuzzle } from './puzzleSystem.js';
import { FOREST_ROOMS } from './forestRooms.js';

// ─── Tunables ───────────────────────────────────────────────────────────────
const PUZZLE_ID         = 'mossroot_pulse';
const ROOM_ID           = 'mossroot';
const WEAPON_REWARD     = 'root_grasp';
const TIME_LIMIT_SECS   = 90;          // hard cap is 120 in puzzleSystem

const NODE_COUNT        = 3;
const NODE_RING_R       = 6.0;         // distance from room center
const NODE_BASE_RAD     = 0.65;        // node body radius
const NODE_HEIGHT       = 0.45;        // squat stump shape
const NODE_RING_R_VIS   = 1.10;        // armed-ring radius (visual)
const NODE_RING_LINE_W  = 0.07;        // within 0.06-0.10 spec band
const TOUCH_R           = 1.60;        // hero→node touch radius
const TOUCH_R2          = TOUCH_R * TOUCH_R;
const TOUCH_DEBOUNCE    = 0.20;        // seconds before same node can be re-touched

// Round shape: 3 rounds escalating sequence length + cadence.
const ROUNDS = [
  { length: 3, cadence: 0.55 },
  { length: 4, cadence: 0.45 },
  { length: 5, cadence: 0.38 },
];
const INPUT_WINDOW_SEC  = 8.0;         // per-round input timeout
const FAIL_SLOW_MUL     = 0.65;        // <1 so it actually slows
const FAIL_SLOW_DURATION = 6.0;

// Phases (string for readable debug).
const PHASE_IDLE  = 'idle';   // before onStart wires it (also between round transitions briefly)
const PHASE_DEMO  = 'demo';   // sequence flashing
const PHASE_INPUT = 'input';  // player tapping
const PHASE_DONE  = 'done';   // all 3 rounds complete

// Palette literals (locked).
const COLOR_NODE_BODY   = 0x1a1e22;    // slot 1
const COLOR_NODE_ARMED  = 0x7df0c4;    // slot 4 — bio-glow primary mint
const COLOR_NODE_PULSE  = 0x3ecf9a;    // slot 5 — secondary mint (flash peak)
const COLOR_NODE_DONE   = 0xffd86b;    // slot 7 — amber celebration

// ─── Module state ───────────────────────────────────────────────────────────
let _group = null;
let _bodyInst = null;
let _bodyMat = null;
let _bodyGeo = null;
let _ringInst = null;
let _ringMat = null;
let _ringGeo = null;
let _disposed = true;

// Per-node runtime (slot-aligned with _bodyInst/_ringInst).
const _nodes = [];   // { x, z, pulseT, isLit }

// Puzzle runtime
let _phase = PHASE_IDLE;
let _round = 0;             // 0..2 (3 rounds)
let _sequence = [];         // sequence for current round (indices into _nodes)
let _seqIdx = 0;            // next index to flash (demo) or to expect (input)
let _phaseTimer = 0;        // seconds elapsed inside current phase
let _wrongTouch = false;    // sentinel for isFailCondition
let _lastTouched = -1;      // debounce: last node index touched
let _lastTouchedT = 0;      // when (state.time.game) last touched fired

// Anchor (resolved at load from FOREST_ROOMS).
let _cx = 0;
let _cz = 0;

// Scratch — zero per-frame alloc.
const _scratchM4    = new THREE.Matrix4();
const _scratchPos   = new THREE.Vector3();
const _scratchScale = new THREE.Vector3(1, 1, 1);
const _identityQuat = new THREE.Quaternion();
const _flatXQuat    = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));

// ─── Seeded PRNG (mirrors puzzleHarmonicAlignment / sap_weaver) ─────────────
let _rngState = 0x70557E;
function _seedRng(seed) { _rngState = (seed >>> 0) || 1; }
function _rand() {
  _rngState = (_rngState + 0x6D2B79F5) >>> 0;
  let t = _rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ─── Public: load ───────────────────────────────────────────────────────────
/**
 * Build the 3 node meshes for Mossroot Hollow. Idempotent — a second call
 * disposes the prior build first.
 *
 * @param {THREE.Scene} scene
 */
export function loadMossrootPulse(scene) {
  if (!scene) return;
  if (!_disposed) disposeMossrootPulse(scene);

  const room = FOREST_ROOMS[ROOM_ID];
  if (!room) return;
  _cx = room.center.x;
  _cz = room.center.z;

  _group = new THREE.Group();
  _group.name = '__puzzleMossrootPulse';

  // ── Node bodies: 3 short cylinder stubs (slot-1 charcoal) ──
  _bodyGeo = new THREE.CylinderGeometry(NODE_BASE_RAD, NODE_BASE_RAD * 1.1, NODE_HEIGHT, 8, 1, false);
  _bodyMat = new THREE.MeshStandardMaterial({
    color: COLOR_NODE_BODY,
    emissive: COLOR_NODE_ARMED,            // shared material; tint via emissiveIntensity in tick
    emissiveIntensity: 0.0,                // dark until armed
    roughness: 0.6, metalness: 0.1,
    flatShading: true,
    transparent: true, opacity: 0.95,
  });
  _bodyInst = new THREE.InstancedMesh(_bodyGeo, _bodyMat, NODE_COUNT);
  _bodyInst.frustumCulled = false;
  _bodyInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _bodyInst.layers.enable(BLOOM_LAYER);
  _group.add(_bodyInst);

  // ── Armed-ring overlay: slim TorusGeometry per node, additive + bloom ──
  _ringGeo = new THREE.TorusGeometry(NODE_RING_R_VIS, NODE_RING_LINE_W / 2, 8, 36);
  _ringGeo.rotateX(Math.PI / 2);           // flat on XZ plane
  _ringMat = new THREE.MeshBasicMaterial({
    color: COLOR_NODE_ARMED,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  _ringInst = new THREE.InstancedMesh(_ringGeo, _ringMat, NODE_COUNT);
  _ringInst.frustumCulled = false;
  _ringInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _ringInst.layers.enable(BLOOM_LAYER);
  _group.add(_ringInst);

  // ── Place 3 nodes evenly on the ring ──
  _nodes.length = 0;
  for (let i = 0; i < NODE_COUNT; i++) {
    const ang = (i / NODE_COUNT) * Math.PI * 2 + Math.PI / 6;  // offset π/6 to avoid axis alignment
    const x = _cx + Math.cos(ang) * NODE_RING_R;
    const z = _cz + Math.sin(ang) * NODE_RING_R;
    _nodes.push({ x, z, pulseT: 0, isLit: false });

    // Body matrix (centered Y at half-height).
    _scratchPos.set(x, NODE_HEIGHT * 0.5, z);
    _scratchScale.set(1, 1, 1);
    _scratchM4.compose(_scratchPos, _identityQuat, _scratchScale);
    _bodyInst.setMatrixAt(i, _scratchM4);

    // Ring matrix (hover slightly above node top so it reads).
    _scratchPos.set(x, NODE_HEIGHT + 0.04, z);
    // ring geo was rotated upright at build time; identity quat keeps that.
    _scratchM4.compose(_scratchPos, _identityQuat, _scratchScale);
    _ringInst.setMatrixAt(i, _scratchM4);
  }
  _bodyInst.instanceMatrix.needsUpdate = true;
  _ringInst.instanceMatrix.needsUpdate = true;

  // Silence unused-warnings in any toolchain that flags them.
  void _flatXQuat;

  scene.add(_group);
  _disposed = false;
}

// ─── Public: tick (wired via puzzleSystem onTick — see registerPuzzle below)
/**
 * Per-frame integrator. Drives demo cadence, polls player touch, advances
 * round/phase. Returns early when disposed or no state.
 *
 * @param {number} dt seconds since last frame
 * @param {any} state global game state (reads state.hero.pos for touch)
 */
export function tickMossrootPulse(dt, state) {
  if (_disposed || !_bodyInst) return;
  if (!state) return;

  _phaseTimer += dt;

  // Idle-fade glow on every node, then per-phase overrides.
  // Default emissive = COLOR_NODE_ARMED at low intensity (subtle base glow).
  if (_bodyMat) {
    _bodyMat.emissive.setHex(COLOR_NODE_ARMED);
    _bodyMat.emissiveIntensity = 0.25;
  }

  // Pulse-decay all nodes' pulseT (used by ring opacity).
  for (let i = 0; i < _nodes.length; i++) {
    const n = _nodes[i];
    if (n.pulseT > 0) n.pulseT = Math.max(0, n.pulseT - dt);
  }

  // ── Phase logic ────────────────────────────────────────────────────────
  if (_phase === PHASE_DEMO) {
    // Flash _sequence[_seqIdx] for _cadence seconds, advance.
    const cadence = ROUNDS[_round].cadence;
    if (_phaseTimer >= cadence) {
      // Light up the next node in the sequence.
      if (_seqIdx < _sequence.length) {
        const nodeIdx = _sequence[_seqIdx];
        _nodes[nodeIdx].pulseT = cadence * 0.85;  // ring flash lasts ~85% of cadence
        _seqIdx++;
        _phaseTimer = 0;
      } else {
        // Demo done → enter INPUT phase.
        _phase = PHASE_INPUT;
        _seqIdx = 0;
        _phaseTimer = 0;
        _lastTouched = -1;
      }
    }
  } else if (_phase === PHASE_INPUT) {
    // Input window timeout?
    if (_phaseTimer >= INPUT_WINDOW_SEC) {
      _wrongTouch = true;
      return;
    }
    // Poll hero proximity to each node. First-touched node within TOUCH_R
    // becomes the candidate; debounced so a sustained press counts once.
    const hero = state.hero && state.hero.pos;
    if (!hero) return;
    const tNow = (state.time && state.time.game) || 0;
    let touchedIdx = -1;
    let bestD2 = TOUCH_R2;
    for (let i = 0; i < _nodes.length; i++) {
      const n = _nodes[i];
      const dx = hero.x - n.x;
      const dz = hero.z - n.z;
      const d2 = dx * dx + dz * dz;
      if (d2 <= bestD2) { bestD2 = d2; touchedIdx = i; }
    }
    if (touchedIdx === -1) {
      // hero stepped off — clear debounce so re-entry registers fresh
      _lastTouched = -1;
      return;
    }
    // Debounce same-node retouch unless TOUCH_DEBOUNCE elapsed.
    if (touchedIdx === _lastTouched && (tNow - _lastTouchedT) < TOUCH_DEBOUNCE) {
      return;
    }
    _lastTouched = touchedIdx;
    _lastTouchedT = tNow;

    // Check vs expected.
    const expected = _sequence[_seqIdx];
    if (touchedIdx === expected) {
      _nodes[touchedIdx].pulseT = 0.30;     // confirm-flash
      _seqIdx++;
      if (_seqIdx >= _sequence.length) {
        // Round complete!
        _round++;
        if (_round >= ROUNDS.length) {
          // All 3 rounds done → win.
          _phase = PHASE_DONE;
          // Light all nodes amber for a moment as celebration.
          for (const n of _nodes) n.pulseT = 1.0;
          if (_bodyMat) {
            _bodyMat.emissive.setHex(COLOR_NODE_DONE);
            _bodyMat.emissiveIntensity = 2.0;
          }
        } else {
          // Roll next round's sequence & re-enter DEMO.
          _sequence = _rollSequence(ROUNDS[_round].length);
          if (state && state.run) state.run.mossrootSequence = _sequence.slice();
          _phase = PHASE_DEMO;
          _seqIdx = 0;
          _phaseTimer = 0;
        }
      }
    } else {
      // Wrong tap → fail.
      _wrongTouch = true;
    }
  }

  // ── Visual write: ring opacity from pulseT, body emissive amped during pulse
  let maxPulse = 0;
  if (_ringMat) {
    // Per-instance ring opacity isn't supported via shared material; we use
    // the brightest active pulse to drive the shared ring color while a
    // per-instance scale spike (via matrix rewrite) signals which node.
    for (const n of _nodes) {
      if (n.pulseT > maxPulse) maxPulse = n.pulseT;
    }
    // While at least one node is mid-pulse, lift ring opacity & shift toward
    // peak; otherwise hold subtle base opacity so rings are always faintly visible.
    if (maxPulse > 0) {
      _ringMat.opacity = 0.55 + 0.40 * Math.min(1, maxPulse / 0.30);
      _ringMat.color.setHex(COLOR_NODE_PULSE);
    } else {
      _ringMat.opacity = 0.40;
      _ringMat.color.setHex(COLOR_NODE_ARMED);
    }
  }

  // Per-instance ring scale spike so the active-pulse node visually distinguishes
  // from the dim base rings. This is the "which node is currently lit" signal.
  for (let i = 0; i < _nodes.length; i++) {
    const n = _nodes[i];
    const k = Math.min(1, n.pulseT / 0.30);
    const sc = 1.0 + 0.45 * k;       // up to 1.45× during peak
    _scratchPos.set(n.x, NODE_HEIGHT + 0.04, n.z);
    _scratchScale.set(sc, sc, sc);
    _scratchM4.compose(_scratchPos, _identityQuat, _scratchScale);
    _ringInst.setMatrixAt(i, _scratchM4);
  }
  _ringInst.instanceMatrix.needsUpdate = true;

  // Body emissive intensity rides with the global max-pulse so the stubs
  // breathe during demo + input phases.
  if (_bodyMat && _phase !== PHASE_DONE) {
    _bodyMat.emissiveIntensity = 0.25 + (2.0 - 0.25) * Math.min(1, maxPulse / 0.30);
  }

  // Publish progress for HUD / debug consumers.
  if (state && state.run) {
    state.run.mossrootRound  = _round;
    state.run.mossrootPhase  = _phase;
    state.run.mossrootSeqIdx = _seqIdx;
  }
}

// ─── Public: dispose ────────────────────────────────────────────────────────
/**
 * Full teardown — geometries + materials disposed, scene group removed.
 * Called by main.js on stage teardown / run reset, NOT by puzzleSystem
 * cleanup hook (so retries on the same stage spawn instantly).
 *
 * @param {THREE.Scene} scene
 */
export function disposeMossrootPulse(scene) {
  if (_group) {
    if (scene && _group.parent === scene) scene.remove(_group);
    else if (_group.parent) _group.parent.remove(_group);
    _group = null;
  }
  if (_bodyGeo) { try { _bodyGeo.dispose(); } catch (_) {} _bodyGeo = null; }
  if (_bodyMat) { try { _bodyMat.dispose(); } catch (_) {} _bodyMat = null; }
  if (_ringGeo) { try { _ringGeo.dispose(); } catch (_) {} _ringGeo = null; }
  if (_ringMat) { try { _ringMat.dispose(); } catch (_) {} _ringMat = null; }
  _bodyInst = null;
  _ringInst = null;
  _nodes.length = 0;
  _phase = PHASE_IDLE;
  _round = 0;
  _sequence.length = 0;
  _seqIdx = 0;
  _phaseTimer = 0;
  _wrongTouch = false;
  _disposed = true;
}

// ─── Helpers ────────────────────────────────────────────────────────────────
/**
 * Roll a fresh deterministic-but-varied sequence of node indices for the
 * current round. Uses the seeded PRNG so a run-determinism trace can
 * replay this puzzle exactly given the seed.
 *
 * Avoids back-to-back repeats so "tap A twice in a row" doesn't appear
 * in the same step (still allowed across non-adjacent steps; rounds 2-3
 * have length > NODE_COUNT so repeats are inevitable somewhere).
 *
 * @param {number} length
 * @returns {number[]} array of node indices
 */
function _rollSequence(length) {
  const out = [];
  let last = -1;
  for (let i = 0; i < length; i++) {
    let pick;
    let safety = 8;
    do {
      pick = Math.floor(_rand() * NODE_COUNT);
      safety--;
    } while (pick === last && safety > 0);
    out.push(pick);
    last = pick;
  }
  return out;
}

/**
 * Reset internal puzzle state (called from onStart + cleanup). Mesh stays
 * alive so retries spawn immediately. Re-seeds the PRNG from the current
 * game time so consecutive attempts get fresh sequences.
 */
function _resetPuzzleState(state) {
  for (const n of _nodes) { n.pulseT = 0; n.isLit = false; }
  _phase = PHASE_IDLE;
  _round = 0;
  _sequence.length = 0;
  _seqIdx = 0;
  _phaseTimer = 0;
  _wrongTouch = false;
  _lastTouched = -1;
  _lastTouchedT = 0;
  if (_bodyMat) {
    _bodyMat.emissive.setHex(COLOR_NODE_ARMED);
    _bodyMat.emissiveIntensity = 0.25;
  }
  if (_ringMat) {
    _ringMat.opacity = 0.40;
    _ringMat.color.setHex(COLOR_NODE_ARMED);
  }
  if (state && state.run) {
    state.run.mossrootRound  = 0;
    state.run.mossrootPhase  = PHASE_IDLE;
    state.run.mossrootSeqIdx = 0;
    state.run.mossrootSequence = [];
  }
  // Re-seed the PRNG. Using state.time.game keeps it deterministic for a
  // given run-clock moment without freezing across retries.
  const tNow = (state && state.time && state.time.game) || 0;
  _seedRng(((tNow * 1000) | 0) ^ 0x70557E);
}

// ─── Puzzle registration ────────────────────────────────────────────────────
// Module-load one-shot — puzzleSystem stores the def by id. Wired via the
// `onTick` field so puzzleSystem.tickPuzzleSystem drives the per-frame
// integrator (avoids a separate per-frame call site in main.js; this is the
// same lifecycle the system was designed for, even if the existing puzzles
// also expose a redundant `tick*` export).
registerPuzzle({
  id: PUZZLE_ID,
  roomId: ROOM_ID,
  timeLimit: TIME_LIMIT_SECS,
  weaponReward: WEAPON_REWARD,

  onStart(state) {
    _resetPuzzleState(state);
    // Roll the first round's sequence and enter DEMO.
    _sequence = _rollSequence(ROUNDS[0].length);
    _phase = PHASE_DEMO;
    _phaseTimer = ROUNDS[0].cadence;   // fire first flash immediately on next tick
    _seqIdx = 0;
    _round = 0;
    if (state && state.run) state.run.mossrootSequence = _sequence.slice();
  },

  onTick(dt, state) {
    tickMossrootPulse(dt, state);
  },

  isWinCondition(/* state */) {
    return _phase === PHASE_DONE;
  },

  isFailCondition(/* state */) {
    return _wrongTouch === true;
  },

  onFail(state) {
    // Soft penalty — slow hero for 6s. fountainSpeedBuff is the only existing
    // hero-read slow hook (src/hero.js:307-309). mul < 1 so it slows.
    if (state && state.run) {
      const tNow = (state.time && state.time.game) || 0;
      state.run.fountainSpeedBuff = {
        mul: FAIL_SLOW_MUL,
        expiresAt: tNow + FAIL_SLOW_DURATION,
      };
    }
  },

  cleanup(state) {
    _resetPuzzleState(state);
  },
});

// ─── Debug surface ──────────────────────────────────────────────────────────
export function _debugMossrootPhase()    { return _phase; }
export function _debugMossrootRound()    { return _round; }
export function _debugMossrootSequence() { return _sequence.slice(); }
export function _debugMossrootNodes()    { return _nodes.slice(); }
