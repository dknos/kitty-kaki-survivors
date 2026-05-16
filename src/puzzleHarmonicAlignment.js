/**
 * Forest Expansion v0.1 — Crystal Choir Grove puzzle: Harmonic Alignment (FE-C3C).
 *
 * Room: crystalchoir, center (0, 80)
 * Time limit: 40s
 * Weapon reward: 'choir_lance'
 *
 * Setup:
 *   - 5 floor pads in a row (InstancedMesh discs), slot 4 mint idle, slot 8
 *     cyan-blue when lit.
 *   - 3-step sequence generated deterministically per run from
 *     state.run.startedAt (set by resetState in state.js line 374). Same run
 *     → same sequence across retries; new run → new sequence.
 *
 * Interaction phases:
 *   1. DEMO  — replay the 3-pad sequence in order, with cyan note arcs drawn
 *              between consecutive pads (Spider Web FX bar via chainFx).
 *              Each lit beat lasts DEMO_STEP_SECS; one full demo loop fits
 *              inside 3 × DEMO_STEP_SECS.
 *   2. INPUT — wait for the hero to walk over the expected pad. Right pad
 *              advances; wrong pad triggers fail (dissonance burst + slow).
 *              Pad detection: hero.pos within PAD_HIT_R of pad center.
 *   3. WIN   — all 3 pads stepped in order before timeout.
 *
 * Win:  sequence completed.
 * Fail: wrong pad stepped on (immediate fail) OR 40s timeout. onFail emits
 *       dissonance — a bright bloom burst at the hero (we spawn a few short
 *       chainFx arcs radiating from hero as a "screen-flash" stand-in since
 *       there's no global flash hook in postfx) plus
 *       state.run.choirDissonance = { mul: 0.65, expiresAt: tNow + 6 }. The
 *       choirDissonance flag is consumed by FE-C3A integration glue (hero.js
 *       does NOT read it yet in v0.1 — this is by spec design; the flag is
 *       still set so that wiring lands in a single edit).
 *
 * Cleanup vs dispose (per puzzleSystem contract):
 *   cleanup(state) — clear lit state, reset phase, drop the input cursor.
 *                    Mesh + materials stay alive so a retry attempt spawns
 *                    instantly with a freshly-rolled sequence.
 *   disposeHarmonicAlignment(scene) — full teardown for stage swap.
 *
 * Palette (forest 8-color, LOCKED per docs/FOREST_VISUAL_STYLE.md):
 *   slot 4 0x7df0c4 — pad mint idle (bio-glow primary)
 *   slot 8 0xa8e6ff — pad lit + note arcs (chain-lightning cyan-white)
 *   slot 5 0x3ecf9a — pad rim (bio-glow secondary)
 *
 * Quality bar:
 *   - Note arcs use spawnChainArc with both colors = slot 8, life 0.55s,
 *     line weight 0.06-0.10 (default outerRadius 0.085, innerRadius 0.035).
 *   - All glowing meshes tag BLOOM_LAYER.
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from './postfx.js';
import { registerPuzzle } from './puzzleSystem.js';
import { FOREST_ROOMS } from './forestRooms.js';
import { spawnChainArc } from './chainFx.js';

// ─── Tunables ───────────────────────────────────────────────────────────────
const PUZZLE_ID         = 'harmonic_alignment';
const ROOM_ID           = 'crystalchoir';
const WEAPON_REWARD     = 'choir_lance';
const TIME_LIMIT_SECS   = 40;

const PAD_COUNT         = 5;
const PAD_RADIUS        = 1.10;          // visual disc radius
const PAD_HIT_R         = 1.50;          // hero detection radius (spec: 1.5u)
const PAD_HIT_R2        = PAD_HIT_R * PAD_HIT_R;
const PAD_SPACING       = 3.20;          // gap between adjacent pad centers
const PAD_Y             = 0.05;          // hover just above floor
const PAD_HEIGHT        = 0.12;          // thin disc thickness
const PAD_DIM_EMISSIVE  = 0.6;           // idle emissive intensity
const PAD_LIT_EMISSIVE  = 2.2;           // lit / demo-step intensity

const SEQUENCE_LEN      = 3;             // 3 pads to step

const DEMO_STEP_SECS    = 0.55;          // how long each demo pad stays lit
const DEMO_INTER_GAP    = 0.10;          // dark gap between demo steps
const DEMO_HOLD_AFTER   = 0.80;          // pause after demo completes before INPUT
const STEP_LIT_AFTER_HIT= 0.35;          // feedback flash when player hits a pad
const NOTE_ARC_LIFE     = 0.55;          // chain-arc life for demo note arcs
const NOTE_ARC_Y        = 0.50;          // arc midpoint Y

const FAIL_DISSONANCE_MUL = 0.65;
const FAIL_DISSONANCE_SEC = 6.0;
const FAIL_BURST_ARCS     = 6;           // chainFx arcs spawned around hero on fail
const FAIL_BURST_R        = 2.5;         // arc reach from hero

const COLOR_PAD_BODY    = 0x2d3a55;      // slot 2 — crystal mid base
const COLOR_PAD_IDLE    = 0x7df0c4;      // slot 4 — bio-glow primary mint
const COLOR_PAD_LIT     = 0xa8e6ff;      // slot 8 — cyan-white when lit
const COLOR_PAD_RIM     = 0x3ecf9a;      // slot 5 — bio-glow secondary rim (reserved)

// Puzzle internal phases. Strings so console / debug reads cleanly.
const PHASE_IDLE  = 'idle';   // before onStart wires it
const PHASE_DEMO  = 'demo';
const PHASE_INPUT = 'input';
const PHASE_DONE  = 'done';

// ─── Module state ───────────────────────────────────────────────────────────
let _group = null;
let _padInst = null;
let _padMat  = null;
let _padGeo  = null;
let _disposed = true;

// Per-pad runtime state (slot-aligned with _padInst).
const _pads = [];             // { x, z, lit:bool, litUntil:number, baseY:number }

// Sequence state.
let _sequence = [];           // length SEQUENCE_LEN, values 0..PAD_COUNT-1
let _phase    = PHASE_IDLE;
let _phaseTimer = 0;
let _demoStep = 0;            // 0..SEQUENCE_LEN-1
let _inputStep = 0;           // 0..SEQUENCE_LEN-1
let _lastHeroPadIndex = -1;   // edge-detect: only react when hero ENTERS a pad

// Scratch — avoid per-frame allocs.
const _scratchM4    = new THREE.Matrix4();
const _scratchPos   = new THREE.Vector3();
const _scratchScale = new THREE.Vector3(1, 1, 1);
const _identityQuat = new THREE.Quaternion();
const _padQuat      = new THREE.Quaternion(); // identity is fine for upright disc

// Room anchor.
let _cx = 0;
let _cz = 0;

// ─── Helpers ────────────────────────────────────────────────────────────────
/**
 * Cheap mulberry32 — same family used by forestAmber.js. Deterministic given
 * a seed; we feed state.run.startedAt (a performance.now() timestamp) so two
 * retries of the same run see the same sequence, and a new run gets a fresh
 * one. Returns an int in [0, max).
 */
function _seededInt(seed, max) {
  let s = (seed >>> 0) || 1;
  s = (s + 0x6D2B79F5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) % max;
}

function _rollSequence(state) {
  // Mix in startedAt + a salt per step so consecutive picks don't repeat.
  const baseSeed = ((state && state.run && state.run.startedAt) | 0) || 1;
  const out = new Array(SEQUENCE_LEN);
  // Sample without immediate repeat — 3 of 5 pads, allowed to repeat
  // non-adjacently. The brief says "3-step sequence", no constraint on
  // uniqueness; we add the non-adjacent rule purely so the demo reads
  // visually (otherwise a A-A-B sequence would flash one pad twice in a row).
  let prev = -1;
  for (let i = 0; i < SEQUENCE_LEN; i++) {
    let pick;
    let guard = 0;
    do {
      pick = _seededInt(baseSeed + i * 1013 + guard * 31, PAD_COUNT);
      guard++;
    } while (pick === prev && guard < 8);
    out[i] = pick;
    prev = pick;
  }
  return out;
}

function _writePadMatrix(i) {
  const p = _pads[i];
  _scratchPos.set(p.x, PAD_Y + PAD_HEIGHT * 0.5, p.z);
  _scratchScale.set(1, 1, 1);
  _scratchM4.compose(_scratchPos, _padQuat, _scratchScale);
  _padInst.setMatrixAt(i, _scratchM4);
}

function _lightPad(i, durationSecs, scene) {
  const p = _pads[i];
  if (!p) return;
  p.lit = true;
  p.litUntil = durationSecs;             // remaining seconds — counted down in tick
  // No per-instance color on InstancedMesh by default for this geo — we
  // signal lit-state by lerping the shared emissive intensity in tick. With
  // 5 pads that's a single uniform shift which reads cleanly enough; the
  // chain-arc note between lit pads carries most of the puzzle's "active"
  // visual.
  void scene; // reserved for per-pad chime/decal if added later
}

function _spawnNoteArc(scene, fromIdx, toIdx) {
  if (!scene) return;
  const a = _pads[fromIdx];
  const b = _pads[toIdx];
  if (!a || !b) return;
  // Both colors slot 8 (forest spec for arc visuals). Defaults give us
  // outer 0.085 / inner 0.035 — inside the 0.06-0.10 Spider Web FX band.
  spawnChainArc(scene, { x: a.x, z: a.z }, { x: b.x, z: b.z }, {
    outerColor: COLOR_PAD_LIT,
    innerColor: COLOR_PAD_LIT,
    life: NOTE_ARC_LIFE,
    y: NOTE_ARC_Y,
  });
}

function _spawnDissonanceBurst(scene, hero) {
  if (!scene || !hero || !hero.pos) return;
  const hx = hero.pos.x;
  const hz = hero.pos.z;
  for (let i = 0; i < FAIL_BURST_ARCS; i++) {
    const ang = (i / FAIL_BURST_ARCS) * Math.PI * 2;
    const tx = hx + Math.cos(ang) * FAIL_BURST_R;
    const tz = hz + Math.sin(ang) * FAIL_BURST_R;
    spawnChainArc(scene, { x: hx, z: hz }, { x: tx, z: tz }, {
      outerColor: COLOR_PAD_LIT,
      innerColor: COLOR_PAD_LIT,
      life: 0.45,
      y: 0.7,
    });
  }
}

// ─── Public: load ───────────────────────────────────────────────────────────
/**
 * Build the 5 floor pads for Crystal Choir Grove. Idempotent.
 *
 * @param {THREE.Scene} scene
 */
export function loadHarmonicAlignment(scene) {
  if (!scene) return;
  if (!_disposed) disposeHarmonicAlignment(scene);

  const room = FOREST_ROOMS[ROOM_ID];
  if (!room) return;
  _cx = room.center.x;
  _cz = room.center.z;

  _group = new THREE.Group();
  _group.name = '__puzzleHarmonicAlignment';

  // Disc geo — thin cylinder for "stepping stone" pad silhouette.
  _padGeo = new THREE.CylinderGeometry(PAD_RADIUS, PAD_RADIUS * 0.96, PAD_HEIGHT, 24, 1, false);
  _padMat = new THREE.MeshStandardMaterial({
    color: COLOR_PAD_BODY,
    emissive: COLOR_PAD_IDLE,
    emissiveIntensity: PAD_DIM_EMISSIVE,
    roughness: 0.35,
    metalness: 0.10,
    flatShading: true,                   // crisp facet light per FOREST_VISUAL_STYLE
    transparent: true,
    opacity: 0.94,
  });
  _padInst = new THREE.InstancedMesh(_padGeo, _padMat, PAD_COUNT);
  _padInst.frustumCulled = false;
  _padInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _padInst.layers.enable(BLOOM_LAYER);
  _group.add(_padInst);

  // Lay pads in a straight row aligned with room +X axis. Centered on room
  // center so the player meets them after walking into the room from the
  // hub direction.
  _pads.length = 0;
  const startX = _cx - ((PAD_COUNT - 1) * PAD_SPACING) * 0.5;
  for (let i = 0; i < PAD_COUNT; i++) {
    const px = startX + i * PAD_SPACING;
    const pz = _cz;
    _pads.push({ x: px, z: pz, lit: false, litUntil: 0, baseY: PAD_Y });
    _writePadMatrix(i);
  }
  _padInst.instanceMatrix.needsUpdate = true;

  // Pre-roll an initial sequence so a peek into the room (before onStart
  // fires) doesn't show blank state. onStart re-rolls deterministically.
  _sequence = [0, 1, 2];
  _phase = PHASE_IDLE;
  _phaseTimer = 0;
  _demoStep = 0;
  _inputStep = 0;
  _lastHeroPadIndex = -1;

  scene.add(_group);
  _disposed = false;

  void COLOR_PAD_RIM;
}

// ─── Public: tick ───────────────────────────────────────────────────────────
/**
 * Per-frame integrator. Drives the demo→input phase machine, hero-pad
 * detection, dissonance fail on wrong pad.
 *
 * @param {number} dt
 * @param {any} state
 */
export function tickHarmonicAlignment(dt, state) {
  if (_disposed || !_padInst) return;
  if (!state || !state.scene) return;

  const scene = state.scene;
  const hero = state.hero;

  // Tick lit timers + decay emissive on shared material.
  let anyLit = false;
  for (const p of _pads) {
    if (p.lit) {
      p.litUntil -= dt;
      if (p.litUntil <= 0) {
        p.lit = false;
        p.litUntil = 0;
      } else {
        anyLit = true;
      }
    }
  }
  // Shared material — when ANY pad is lit, brighten the whole bank. Reads
  // as the lit pad being the brightest because the chain-arc note between
  // pads carries the directionality. Avoids per-instance color hookup.
  if (_padMat) {
    _padMat.emissiveIntensity = anyLit ? PAD_LIT_EMISSIVE : PAD_DIM_EMISSIVE;
  }

  // Phase machine.
  if (_phase === PHASE_DEMO) {
    _phaseTimer += dt;
    const stepTotal = DEMO_STEP_SECS + DEMO_INTER_GAP;
    const expectedStep = Math.floor(_phaseTimer / stepTotal);
    if (expectedStep > _demoStep && _demoStep < SEQUENCE_LEN) {
      // Light next step on rising edge.
      _demoStep = expectedStep;
      if (_demoStep < SEQUENCE_LEN) {
        const idx = _sequence[_demoStep];
        _lightPad(idx, DEMO_STEP_SECS, scene);
        // Arc from previous to current.
        if (_demoStep > 0) {
          _spawnNoteArc(scene, _sequence[_demoStep - 1], idx);
        }
      }
    }
    // First step (demoStep stays at 0 from init, expectedStep starts at 0).
    if (_demoStep === 0 && _phaseTimer >= 0 && _phaseTimer < stepTotal && !_pads[_sequence[0]].lit) {
      // Light pad 0 once at the start (this also fires the first frame).
      _lightPad(_sequence[0], DEMO_STEP_SECS, scene);
    }

    // Done demoing? After the last step's hold, switch to INPUT.
    if (_phaseTimer >= stepTotal * SEQUENCE_LEN + DEMO_HOLD_AFTER) {
      _phase = PHASE_INPUT;
      _phaseTimer = 0;
      _inputStep = 0;
      _lastHeroPadIndex = _detectHeroPad(hero);  // seed edge-detect
    }
  } else if (_phase === PHASE_INPUT) {
    _phaseTimer += dt;
    const padIdx = _detectHeroPad(hero);
    // Edge-detect: only react when the hero ENTERS a new pad. Standing on
    // one shouldn't repeatedly fire.
    if (padIdx !== _lastHeroPadIndex) {
      _lastHeroPadIndex = padIdx;
      if (padIdx >= 0) {
        const expected = _sequence[_inputStep];
        if (padIdx === expected) {
          // Correct hit — light the pad, advance.
          _lightPad(padIdx, STEP_LIT_AFTER_HIT, scene);
          if (_inputStep > 0) {
            _spawnNoteArc(scene, _sequence[_inputStep - 1], padIdx);
          }
          _inputStep++;
          if (_inputStep >= SEQUENCE_LEN) {
            _phase = PHASE_DONE;
          }
        } else {
          // Wrong pad — set a sticky fail flag for isFailCondition() to
          // pick up next system tick. We don't call _fail directly because
          // puzzleSystem owns the lifecycle. The dissonance burst fires
          // here so the visual is locked to the input frame.
          _wrongPadHit = true;
          _spawnDissonanceBurst(scene, hero);
        }
      }
    }
  }
  // PHASE_DONE / PHASE_IDLE → nothing to tick.

  // Push matrix updates if any (currently writes don't change position,
  // but kept for symmetry with the other puzzles if scaling/animation is
  // added later).
}

// Sticky flag flipped by tick on wrong pad; cleared by onStart/cleanup.
// Module-level (not stuffed into state) because it's an internal sentinel
// for the isFailCondition predicate.
let _wrongPadHit = false;

function _detectHeroPad(hero) {
  if (!hero || !hero.pos) return -1;
  const hx = hero.pos.x;
  const hz = hero.pos.z;
  for (let i = 0; i < _pads.length; i++) {
    const p = _pads[i];
    const dx = hx - p.x;
    const dz = hz - p.z;
    if (dx * dx + dz * dz <= PAD_HIT_R2) return i;
  }
  return -1;
}

// ─── Public: dispose ────────────────────────────────────────────────────────
export function disposeHarmonicAlignment(scene) {
  if (_group) {
    if (scene && _group.parent === scene) scene.remove(_group);
    else if (_group.parent) _group.parent.remove(_group);
    _group = null;
  }
  if (_padGeo) { try { _padGeo.dispose(); } catch (_) {} _padGeo = null; }
  if (_padMat) { try { _padMat.dispose(); } catch (_) {} _padMat = null; }
  _padInst = null;
  _pads.length = 0;
  _sequence.length = 0;
  _phase = PHASE_IDLE;
  _phaseTimer = 0;
  _demoStep = 0;
  _inputStep = 0;
  _lastHeroPadIndex = -1;
  _wrongPadHit = false;
  _disposed = true;
}

// ─── Internal: per-attempt reset (cleanup hook) ─────────────────────────────
function _resetPuzzleState(state) {
  for (const p of _pads) { p.lit = false; p.litUntil = 0; }
  _phase = PHASE_IDLE;
  _phaseTimer = 0;
  _demoStep = 0;
  _inputStep = 0;
  _lastHeroPadIndex = -1;
  _wrongPadHit = false;
  if (_padMat) _padMat.emissiveIntensity = PAD_DIM_EMISSIVE;
  if (state && state.run) state.run.harmonicSequence = _sequence.slice();
}

// ─── Puzzle registration ────────────────────────────────────────────────────
registerPuzzle({
  id: PUZZLE_ID,
  roomId: ROOM_ID,
  timeLimit: TIME_LIMIT_SECS,
  weaponReward: WEAPON_REWARD,

  onStart(state) {
    _resetPuzzleState(state);
    // Roll a fresh deterministic sequence for this attempt.
    _sequence = _rollSequence(state);
    _phase = PHASE_DEMO;
    _phaseTimer = -0.001;     // first tick fires the initial pad immediately
    if (state && state.run) state.run.harmonicSequence = _sequence.slice();
  },

  isWinCondition(/* state */) {
    return _phase === PHASE_DONE;
  },

  isFailCondition(/* state */) {
    return _wrongPadHit === true;
  },

  onFail(state) {
    // Publish the dissonance slow for FE-C3A to wire into hero speed.
    if (state && state.run) {
      const tNow = (state.time && state.time.game) || 0;
      state.run.choirDissonance = {
        mul: FAIL_DISSONANCE_MUL,
        expiresAt: tNow + FAIL_DISSONANCE_SEC,
      };
    }
  },

  cleanup(state) {
    _resetPuzzleState(state);
  },
});

// ─── Debug surface ──────────────────────────────────────────────────────────
export function _debugHarmonicSequence() { return _sequence.slice(); }
export function _debugHarmonicPhase() { return _phase; }
export function _debugHarmonicPads() { return _pads.slice(); }
