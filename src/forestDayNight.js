/**
 * FOREST-V2-A9 Day/Night Cycle (2026-05-17)
 *
 * Ties atmospheric lighting to the stage clock so the 30-minute Reaper arc
 * lands at "blood moon" peak darkness. Five lerped phases keyed off
 * state.time.game (paused-aware stage clock, verified by cohort 7):
 *
 *   0..600s    MIDDAY       — bright forest, baseline values
 *   600..1200s GOLDEN_HOUR  — ambient warms toward slot-6 amber
 *   1200..1740s DUSK        — ambient toward slot-4 dark, intensity 0.6×
 *   1740..1800s TWILIGHT    — rapid drop to deep darkness (Reaper warn @ 1770)
 *   1800..endless BLOOD_MOON — max dark + red-tinted directional, intensity 0.4×
 *
 * Pure value mutation on existing scene lights/fog. NO new lights, NO new
 * geometry, NO new hex constants beyond the 8-color palette.
 *
 * Light bindings (env.js stashes refs at envGroup.userData):
 *   - sun  : THREE.DirectionalLight (warm key) — mutated
 *   - hemi : THREE.HemisphereLight (substitutes for AmbientLight in this scene
 *            — there is no AmbientLight; the hemi serves the ambient role) —
 *            color + groundColor + intensity all mutated
 *   - fill : THREE.DirectionalLight (cool fill) — NOT mutated (spec: only
 *            first DirectionalLight)
 *
 * Dispose contract: capture baseline lazily on first tick (post applyStageTint),
 * then mutate; on dispose, only restore if the LIVE light/fog values still
 * match our last-mutated fingerprint. Reason: main.js calls
 * applyStageTint(newStage) BEFORE the dispose at lines 1214/1248/1288/1310,
 * and applyStageTint already resets sun/hemi/fill to BASE_LIGHT and re-tints
 * fog. Blind restore would stomp the new stage's tint. The fingerprint guard
 * makes the transition-time dispose a safe no-op while still restoring on
 * pure in-place reload (line 701).
 */

import * as THREE from 'three';
import { music } from './audio.js';

// FOREST-V2-A18 — emit phase-change event on first entry to each phase.
// Index → name map for music.setForestPhase. Aligned with P_* constants below.
const _PHASE_NAMES = ['midday', 'golden', 'dusk', 'twilight', 'bloodmoon'];
let _lastEmittedPhase = -1;

// ── 8-color palette slots (NO new hex) ─────────────────────────────────────
const SLOT4_DARK  = 0x4a3220; // dusk/blood-moon darkness
const SLOT5_AMBER = 0xe89c4a; // red-warm bias (no red slot; amber stands in)
const SLOT6_GOLD  = 0xd9a648; // golden-hour warm

// ── Phase schedule (seconds, stage clock) ──────────────────────────────────
const T_MIDDAY_END      = 600;   // 0..600   MIDDAY
const T_GOLDEN_END      = 1200;  // 600..1200 GOLDEN_HOUR
const T_DUSK_END        = 1740;  // 1200..1740 DUSK
const T_TWILIGHT_END    = 1800;  // 1740..1800 TWILIGHT
                                  // 1800+      BLOOD_MOON

// Phase indices for state-machine readability.
const P_MIDDAY     = 0;
const P_GOLDEN     = 1;
const P_DUSK       = 2;
const P_TWILIGHT   = 3;
const P_BLOOD_MOON = 4;

// ── Per-phase END-STATE anchor mixes (advisor-confirmed reading of spec) ───
// Each anchor is the FULL state at the END of the named phase. We lerp
// linearly from previous anchor → current anchor across the phase window.
// Anchor 0 (MIDDAY end) is captured live as the baseline on first tick.
//
// Each anchor entry:
//   ambBlend    : [hex, mix] — hemi color/groundColor lerps `mix` toward `hex`
//   sunBlend    : [hex, mix] — sun.color lerps `mix` toward `hex`
//   intensityMul: scalar applied to BASE sun + hemi intensity
//   fogBlend    : [hex, mix] — scene.fog.color lerps `mix` toward `hex`
//
// Note: directional intensity multipliers are mirrored onto hemi to make the
// darkness READ (color-only shift gets washed by full sky light — advisor
// flagged). Spec was silent on hemi intensity; this is the documented call.
const PHASE_ANCHORS = [
  // P_MIDDAY — baseline. No blend. (filled in at runtime from captured base.)
  null,
  // P_GOLDEN_HOUR end
  {
    ambBlend:    [SLOT6_GOLD, 0.30],
    sunBlend:    [SLOT6_GOLD, 0.15],
    intensityMul: 1.00,
    fogBlend:    [SLOT6_GOLD, 0.15],
  },
  // P_DUSK end
  {
    ambBlend:    [SLOT4_DARK, 0.60],
    sunBlend:    [SLOT4_DARK, 0.30],
    intensityMul: 0.60,
    fogBlend:    [SLOT4_DARK, 0.40],
  },
  // P_TWILIGHT end
  {
    ambBlend:    [SLOT4_DARK, 0.80],
    sunBlend:    [SLOT4_DARK, 0.50],
    intensityMul: 0.30,
    fogBlend:    [SLOT4_DARK, 0.70],
  },
  // P_BLOOD_MOON (steady-state — no further lerp once entered)
  // Ambient = 90% slot-4 with 10% slot-5 amber pre-blended into the target.
  {
    ambBlend:    [_premixHex(SLOT4_DARK, SLOT5_AMBER, 0.10), 0.90],
    sunBlend:    [SLOT5_AMBER, 0.55],
    intensityMul: 0.40,
    fogBlend:    [SLOT4_DARK, 0.85],
  },
];

// ── Module state ──────────────────────────────────────────────────────────
let _loaded = false;
let _baselineCaptured = false;
let _scene = null;

// Cached light refs (resolved from envGroup.userData on first tick).
let _sun  = null;
let _hemi = null;

// Capture-at-first-tick baselines (the MIDDAY anchor).
const _BASE = {
  sunColorHex:    0,
  sunIntensity:   1,
  hemiColorHex:   0,
  hemiGroundHex:  0,
  hemiIntensity:  1,
  fogColorHex:    0,
  hasFog:         false,
};

// Fingerprint of our LAST mutation. Dispose-time restore only fires when the
// live values still match this — otherwise something else (applyStageTint)
// already overwrote and our restore would stomp it.
const _MUTATED_FP = {
  sunColorHex:   0,
  sunIntensity:  0,
  hemiColorHex:  0,
  hemiGroundHex: 0,
  hemiIntensity: 0,
  fogColorHex:   0,
};

// Scratch Colors — module-level to avoid per-frame allocation.
const _scratchAmbColor = new THREE.Color();
const _scratchAmbGround = new THREE.Color();
const _scratchSunColor = new THREE.Color();
const _scratchFogColor = new THREE.Color();
const _scratchPrevAmbColor = new THREE.Color();
const _scratchPrevAmbGround = new THREE.Color();
const _scratchPrevSunColor = new THREE.Color();
const _scratchPrevFogColor = new THREE.Color();
const _scratchCurAmbColor = new THREE.Color();
const _scratchCurAmbGround = new THREE.Color();
const _scratchCurSunColor = new THREE.Color();
const _scratchCurFogColor = new THREE.Color();

// Pre-built per-anchor target Color instances (avoid per-frame allocation).
// Filled at module load.
const _ANCHOR_TARGETS = PHASE_ANCHORS.map((a) => {
  if (!a) return null;
  return {
    amb: new THREE.Color(a.ambBlend[0]),
    sun: new THREE.Color(a.sunBlend[0]),
    fog: new THREE.Color(a.fogBlend[0]),
  };
});

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Pre-blend two hex colors. Used at module-load to build the BLOOD_MOON
 * ambient target ("90% slot-4 with 10% slot-5 amber mix").
 */
function _premixHex(hexA, hexB, mixBfraction) {
  const a = new THREE.Color(hexA);
  const b = new THREE.Color(hexB);
  a.lerp(b, mixBfraction);
  return a.getHex();
}

/**
 * Compute (phaseIdx, tWithinPhase) from stage clock.
 */
function _phaseAt(gameT) {
  if (gameT < T_MIDDAY_END)   return { idx: P_MIDDAY,     t: gameT / T_MIDDAY_END };
  if (gameT < T_GOLDEN_END)   return { idx: P_GOLDEN,     t: (gameT - T_MIDDAY_END) / (T_GOLDEN_END - T_MIDDAY_END) };
  if (gameT < T_DUSK_END)     return { idx: P_DUSK,       t: (gameT - T_GOLDEN_END) / (T_DUSK_END   - T_GOLDEN_END) };
  if (gameT < T_TWILIGHT_END) return { idx: P_TWILIGHT,   t: (gameT - T_DUSK_END)   / (T_TWILIGHT_END - T_DUSK_END) };
  return { idx: P_BLOOD_MOON, t: 1 };
}

/**
 * Apply an anchor (END-state of phase N) to the scratch color set and the
 * intensity scalar. Writes into outAmb/outAmbGround/outSun/outFog/outIntMul.
 * `intensityMul`s in the anchor scale BASE intensity.
 */
function _resolveAnchor(idx, outAmb, outAmbGround, outSun, outFog, baseRef) {
  if (idx === P_MIDDAY || !PHASE_ANCHORS[idx]) {
    // Baseline values (MIDDAY anchor = captured baseline).
    outAmb.setHex(baseRef.hemiColorHex);
    outAmbGround.setHex(baseRef.hemiGroundHex);
    outSun.setHex(baseRef.sunColorHex);
    outFog.setHex(baseRef.fogColorHex);
    return { intensityMul: 1.0 };
  }
  const a = PHASE_ANCHORS[idx];
  // Ambient (hemi color) blends from baseline toward target by `mix`.
  outAmb.setHex(baseRef.hemiColorHex);
  outAmb.lerp(_ANCHOR_TARGETS[idx].amb, a.ambBlend[1]);
  // Ground color follows the same blend (advisor: helps DUSK→BLOOD_MOON read).
  outAmbGround.setHex(baseRef.hemiGroundHex);
  outAmbGround.lerp(_ANCHOR_TARGETS[idx].amb, a.ambBlend[1]);
  // Sun color blend.
  outSun.setHex(baseRef.sunColorHex);
  outSun.lerp(_ANCHOR_TARGETS[idx].sun, a.sunBlend[1]);
  // Fog color blend.
  outFog.setHex(baseRef.fogColorHex);
  outFog.lerp(_ANCHOR_TARGETS[idx].fog, a.fogBlend[1]);
  return { intensityMul: a.intensityMul };
}

/**
 * Lazily resolve light refs from state.envGroup.userData. Logs a warn + sets
 * the cached ref to null if a binding is missing (skip path, no crash).
 */
function _resolveLights(state) {
  if (_sun !== null || _hemi !== null) return; // already attempted
  const eg = state && state.envGroup;
  if (!eg || !eg.userData) {
    console.warn('[forestDayNight] envGroup missing — skipping');
    return;
  }
  // Sun: DirectionalLight (first one). env.js stashes it as .sun.
  const sun = eg.userData.sun;
  if (sun && sun.isDirectionalLight) {
    _sun = sun;
  } else {
    console.warn('[forestDayNight] no DirectionalLight on envGroup.userData.sun — skipping sun path');
  }
  // Hemi: HemisphereLight (substitutes for AmbientLight — there is no
  // AmbientLight in the forest scene). env.js stashes it as .hemi.
  const hemi = eg.userData.hemi;
  if (hemi && hemi.isHemisphereLight) {
    _hemi = hemi;
  } else {
    console.warn('[forestDayNight] no HemisphereLight on envGroup.userData.hemi — skipping ambient path');
  }
}

/**
 * Capture baseline values from live lights + fog. Called once on first tick
 * (post applyStageTint(forest), so the snapshot reflects the post-tint forest
 * values — advisor flagged this ordering).
 */
function _captureBaseline(scene) {
  if (_sun) {
    _BASE.sunColorHex  = _sun.color.getHex();
    _BASE.sunIntensity = _sun.intensity;
  }
  if (_hemi) {
    _BASE.hemiColorHex  = _hemi.color.getHex();
    _BASE.hemiGroundHex = _hemi.groundColor.getHex();
    _BASE.hemiIntensity = _hemi.intensity;
  }
  if (scene && scene.fog && scene.fog.color) {
    // Both Fog and FogExp2 expose `.color`. Both branch covered.
    _BASE.fogColorHex = scene.fog.color.getHex();
    _BASE.hasFog = true;
  } else {
    _BASE.hasFog = false;
  }
  _baselineCaptured = true;

  // Seed the mutated-fingerprint with the baseline so a tick-0 dispose
  // (before any mutation) still recognises "we haven't touched anything yet".
  _MUTATED_FP.sunColorHex   = _BASE.sunColorHex;
  _MUTATED_FP.sunIntensity  = _BASE.sunIntensity;
  _MUTATED_FP.hemiColorHex  = _BASE.hemiColorHex;
  _MUTATED_FP.hemiGroundHex = _BASE.hemiGroundHex;
  _MUTATED_FP.hemiIntensity = _BASE.hemiIntensity;
  _MUTATED_FP.fogColorHex   = _BASE.fogColorHex;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Once-per-scene init. Stashes the scene ref; the actual baseline capture +
 * light resolution happens lazily on first tick (after applyStageTint(forest)
 * has run, so we snapshot the post-tint values).
 *
 * @param {THREE.Scene} scene
 * @param {object} _state — unused; kept for API symmetry with sibling modules.
 */
export function loadForestDayNight(scene, _state) {
  if (_loaded) return;
  if (!scene) return;
  _scene = scene;
  _loaded = true;
  _baselineCaptured = false;
  _sun = null;
  _hemi = null;
}

/**
 * Per-frame tick. Reads state.time.game, computes phase + lerp t, applies
 * blended values to sun/hemi/fog. First tick captures baseline.
 *
 * @param {object} state
 * @param {number} _dt — unused; we re-derive from state.time.game each frame.
 */
export function tickForestDayNight(state, _dt) {
  if (!_loaded) return;
  if (!state) return;
  // Lazy resolve on first tick (deferred so applyStageTint runs first).
  if (!_baselineCaptured) {
    _resolveLights(state);
    _captureBaseline(_scene);
    if (!_sun && !_hemi && !_BASE.hasFog) {
      // Nothing to drive — bail permanently. Mark captured so we don't retry.
      return;
    }
  }

  const gameT = (state.time && typeof state.time.game === 'number') ? state.time.game : 0;
  const { idx, t } = _phaseAt(gameT);

  // FOREST-V2-A18 — phase-change hook: emit music.setForestPhase exactly
  // once per transition (not every frame). Initial entry (was -1) also
  // fires so the music layer boots even if forestDayNight loads mid-phase.
  if (idx !== _lastEmittedPhase) {
    _lastEmittedPhase = idx;
    try { music.setForestPhase(_PHASE_NAMES[idx]); } catch (_) {}
  }

  // Resolve previous-phase + current-phase anchors, then lerp between them
  // by `t`. Continuous: no step discontinuities at phase boundaries.
  const prevIdx = idx === 0 ? 0 : idx - 1;
  const prevInt = _resolveAnchor(prevIdx, _scratchPrevAmbColor, _scratchPrevAmbGround, _scratchPrevSunColor, _scratchPrevFogColor, _BASE).intensityMul;
  const curInt  = _resolveAnchor(idx,     _scratchCurAmbColor,  _scratchCurAmbGround,  _scratchCurSunColor,  _scratchCurFogColor,  _BASE).intensityMul;

  // Interpolate intensity multiplier.
  const intMul = prevInt + (curInt - prevInt) * t;

  // Interpolate colors. .copy(prev).lerp(cur, t) — neither prev nor cur is a
  // shared constant (both are scratch), so in-place mutation is safe.
  _scratchAmbColor.copy(_scratchPrevAmbColor).lerp(_scratchCurAmbColor, t);
  _scratchAmbGround.copy(_scratchPrevAmbGround).lerp(_scratchCurAmbGround, t);
  _scratchSunColor.copy(_scratchPrevSunColor).lerp(_scratchCurSunColor, t);
  _scratchFogColor.copy(_scratchPrevFogColor).lerp(_scratchCurFogColor, t);

  // Apply.
  if (_sun) {
    _sun.color.copy(_scratchSunColor);
    _sun.intensity = _BASE.sunIntensity * intMul;
    _MUTATED_FP.sunColorHex  = _sun.color.getHex();
    _MUTATED_FP.sunIntensity = _sun.intensity;
  }
  if (_hemi) {
    _hemi.color.copy(_scratchAmbColor);
    _hemi.groundColor.copy(_scratchAmbGround);
    _hemi.intensity = _BASE.hemiIntensity * intMul;
    _MUTATED_FP.hemiColorHex  = _hemi.color.getHex();
    _MUTATED_FP.hemiGroundHex = _hemi.groundColor.getHex();
    _MUTATED_FP.hemiIntensity = _hemi.intensity;
  }
  if (_BASE.hasFog && _scene && _scene.fog && _scene.fog.color) {
    _scene.fog.color.copy(_scratchFogColor);
    _MUTATED_FP.fogColorHex = _scene.fog.color.getHex();
  }
}

/**
 * Tear down. Idempotent — safe to call when never loaded.
 *
 * Restore rule: only write back the captured baseline when the live light
 * /fog values STILL match our last-mutated fingerprint. This means:
 *
 *   • Pure reset path (line 701): nothing has touched the lights since our
 *     last tick → fingerprint matches → restore fires.
 *   • Stage transition (lines 1214/1248/1288/1310): applyStageTint(newStage)
 *     ran BEFORE this dispose and already overwrote sun/hemi → fingerprint
 *     mismatches → we skip the restore and leave the new stage's tint intact.
 *
 * Tolerant float compare for intensity (within 1e-4).
 *
 * @param {THREE.Scene} [scene] — optional; falls back to cached _scene.
 */
export function disposeForestDayNight(scene) {
  if (!_baselineCaptured) {
    // Module was load()-ed but never tick()-ed, OR never loaded at all. No
    // mutations to undo. Just clear module state.
    _loaded = false;
    _scene = null;
    _sun = null;
    _hemi = null;
    _lastEmittedPhase = -1;
    return;
  }

  const targetScene = scene || _scene;
  const fpMatches = _liveMatchesFingerprint(targetScene);

  if (fpMatches) {
    if (_sun) {
      _sun.color.setHex(_BASE.sunColorHex);
      _sun.intensity = _BASE.sunIntensity;
    }
    if (_hemi) {
      _hemi.color.setHex(_BASE.hemiColorHex);
      _hemi.groundColor.setHex(_BASE.hemiGroundHex);
      _hemi.intensity = _BASE.hemiIntensity;
    }
    if (_BASE.hasFog && targetScene && targetScene.fog && targetScene.fog.color) {
      targetScene.fog.color.setHex(_BASE.fogColorHex);
    }
  }
  // If !fpMatches: another system (applyStageTint) already overwrote our
  // mutations to the new-stage tint. Skipping restore is the correct call.

  _loaded = false;
  _baselineCaptured = false;
  _scene = null;
  _sun = null;
  _hemi = null;
  // FOREST-V2-A18 — reset phase memory so a subsequent load re-emits the
  // initial phase to the music layer.
  _lastEmittedPhase = -1;
}

/**
 * Compare live light/fog values against our last-mutated fingerprint. Tolerant
 * compare on intensity (1e-4) because float round-trip through getHex() is
 * exact, but intensity is a JS Number we wrote and re-read.
 */
function _liveMatchesFingerprint(targetScene) {
  if (_sun) {
    if (_sun.color.getHex() !== _MUTATED_FP.sunColorHex) return false;
    if (Math.abs(_sun.intensity - _MUTATED_FP.sunIntensity) > 1e-4) return false;
  }
  if (_hemi) {
    if (_hemi.color.getHex()       !== _MUTATED_FP.hemiColorHex)  return false;
    if (_hemi.groundColor.getHex() !== _MUTATED_FP.hemiGroundHex) return false;
    if (Math.abs(_hemi.intensity - _MUTATED_FP.hemiIntensity) > 1e-4) return false;
  }
  if (_BASE.hasFog && targetScene && targetScene.fog && targetScene.fog.color) {
    if (targetScene.fog.color.getHex() !== _MUTATED_FP.fogColorHex) return false;
  }
  return true;
}
