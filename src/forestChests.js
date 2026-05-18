/**
 * Forest Treasure Chest Drops — VS signature loop (FOREST-V2-A6, 2026-05-17).
 *
 * Vampire-Survivors hallmark: every miniboss/elite kill drops a chest. Hero
 * walks over it, the chest opens, and a 3-option picker modal pauses the
 * game until the player commits to a reward. This is a forest-stage-only
 * layer that REPLACES the generic `spawnChest()`/slot-machine flow on
 * forest (see "Drop-hook decision" below); other stages keep the existing
 * chest path untouched.
 *
 * Hazard-module sibling — same shape as forestEnvHazards.js: pre-pooled
 * InstancedMesh per chest part, per-chest state machine, static imports
 * only in the hot path, zero per-spawn allocation outside the picker
 * dispatch (which is user-action-triggered).
 *
 * Chest entity (CompoundGeometry):
 *   - body   : BoxGeometry 0.6×0.4×0.4   slot-3 brown 0x6b4f3a
 *   - lid    : BoxGeometry 0.6×0.2×0.4   slot-3 brown (translated y=+0.3, hinges open)
 *   - 4 bands: BoxGeometry 0.05×0.45×0.05 slot-4 dark 0x4a3220 (4 corners)
 *   - lock   : CircleGeometry r=0.06     slot-6 amber 0xd9a648 (front face)
 *   - sparkle ring overhead              slot-6 amber 0xd9a648 (palette-locked)
 *
 * State machine per chest:
 *   CLOSED → OPENING (lid rotates 0→90° over 0.25s + gold pillar burst)
 *          → AWAIT_PICK (modal shown, game paused, chest hidden)
 *          → DISPATCH (apply reward, unpause, drain queue or despawn)
 *          → DESPAWN (slot returned to pool)
 *
 * Self-gating: lifetime is timer-driven (no `dueAt` polling). Modal dispatch
 * fires once on pick, sets state immediately to DISPATCH, never re-enters.
 *
 * ── Drop-hook decision ─────────────────────────────────────────────────────
 * Wired via static import in src/enemies.js (1-line call at the existing
 * miniboss-chest drop site). Stage-gated to forest only — non-forest stages
 * still fire `spawnChest()`/slot-machine via the existing path. On forest,
 * the original `spawnChest()` is skipped and `dropForestChest()` is called
 * instead. Both elite and miniboss kills trigger a forest chest (brief asks
 * for "miniboss/elite"). Final-boss path is unchanged on every stage — that
 * fight has its own bespoke reward sequence.
 *
 * ── Modal decision ─────────────────────────────────────────────────────────
 * Fallback HTML overlay (built in this module via document.createElement),
 * NOT the existing levelup modal. The levelup modal in ui.js is tightly
 * coupled to weaponChoices() + cascade counters + reroll/skip economy — its
 * `pickChoice` path always routes through applyLevelUpChoice and pops the
 * pendingLevelUp cascade. Reusing it would either re-credit a level
 * (visible 1-level XP gain to player) or require gutting its dispatch. A
 * standalone 3-button overlay matches the VS UX better (chest-specific
 * styling, no skip/reroll, mandatory pick).
 *
 * ── Pause semantics ────────────────────────────────────────────────────────
 * On AWAIT_PICK: set `state.time.paused = true` ONLY IF not already paused
 * (death screen / existing levelup / etc.). On DISPATCH: unset paused ONLY
 * IF we set it. The "did we pause it" flag is per-modal-show, kept in
 * `_pausedByUs`. Queued chests inherit a fresh evaluation of the same gate.
 *
 * ── Queue ──────────────────────────────────────────────────────────────────
 * If a second chest is picked up while modal is open, it transitions
 * straight to AWAIT_PICK and pushes onto `_pickQueue`. On DISPATCH, we
 * shift the next queued chest and show its modal (state stays paused
 * across modals — single pause/unpause for the whole drain).
 *
 * ── Palette (slot-locked, no new hex constants) ────────────────────────────
 *   slot 3  #6b4f3a — body + lid (brown)
 *   slot 4  #4a3220 — corner bands (dark brown)
 *   slot 6  #d9a648 — lock + sparkle ring (amber)
 *
 * ── Hard caps ──────────────────────────────────────────────────────────────
 *   CAP_CHESTS = 8 — pre-pooled active chests max (brief)
 *   Pool refusal on overflow: silently drop (mini-boss death already gave
 *   the player heart+heart+star+bomb — no chest is fine).
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from './postfx.js';
import { state as _gameState } from './state.js';
import { acquireWeapon, REGISTRY } from './weapons/index.js';
import { applyPassive, PASSIVES } from './weapons/passives.js';
import { spawnKillRing, spawnMagnetSpark } from './fx.js';
import { sfx } from './audio.js';
import { createRuneRing } from './fx/runeRing.js';
// PHASE 4 P4J (#140) — Telemetry chest_open hook. Fires from the post-apply
// chest counter bump site so the telemetry count matches state.run._chestsOpened.
import { event as telemetryEvent } from './telemetry.js';

// ── pool caps ───────────────────────────────────────────────────────────────
const CAP_CHESTS = 8;

// ── palette (slot-locked) ──────────────────────────────────────────────────
const SLOT3_BROWN = 0x6b4f3a;
const SLOT4_DARK  = 0x4a3220;
const SLOT6_GOLD  = 0xd9a648;

// ── geometry tunables ──────────────────────────────────────────────────────
const BODY_W = 0.6, BODY_H = 0.4, BODY_D = 0.4;
const LID_W  = 0.6, LID_H  = 0.2, LID_D  = 0.4;
const BAND_W = 0.05, BAND_H = 0.45, BAND_D = 0.05;
const LOCK_R = 0.06;
const SPARKLE_R_INNER = 0.45;
const SPARKLE_R_OUTER = 0.65;

// Y placements (chest base at y=0)
const BODY_CY    = BODY_H * 0.5;          // 0.2
const LID_CLOSED = BODY_H + LID_H * 0.5;  // 0.5 (lid sits atop body, closed)
const SPARKLE_Y  = 1.05;                  // overhead
const LOCK_Y     = BODY_CY;               // mid-front
const LOCK_Z     = BODY_D * 0.5 + 0.001;  // just in front of body face

// Pickup
const PICKUP_R   = 0.7;
const PICKUP_R2  = PICKUP_R * PICKUP_R;

// Phase durations (seconds)
const OPENING_SEC  = 0.25;
const BURST_SEC    = 1.0;
const DESPAWN_SEC  = 0.3;  // hide-fade after dispatch
// Pre-modal beat: lid finishes opening, then we wait BURST_HOLD before
// presenting the modal (lets the gold pillar register on screen). Brief:
// "After 0.3s open anim → present picker modal." We use OPENING_SEC=0.25
// + BURST_HOLD=0.05 = 0.30s to match.
const BURST_HOLD   = 0.05;

// Chest phase codes (Uint8Array friendly)
const CP_FREE      = 0;  // pool slot is free
const CP_CLOSED    = 1;  // visible, awaiting pickup
const CP_OPENING   = 2;  // lid rotating open
const CP_AWAIT     = 3;  // modal open or queued
const CP_DISPATCH  = 4;  // picked, applying reward + fading out
const CP_DESPAWN   = 5;  // transitional → free

// Rewards
const GOLD_BASE       = 50;
const GOLD_PER_SEC    = 5;
const GOLD_CAP        = 200;
const WEAPON_CAP      = 8;  // per existing weapons.maxLevel (verified across registry)
const PASSIVE_CAP     = 5;  // per existing passives.maxLevel (verified across PASSIVES)
const HEAL_FULL       = true; // option C: heal to full

// ── module state ───────────────────────────────────────────────────────────
let _loaded = false;
let _scene = null;
let _group = null;
let _disposables = [];

// Per-chest pool arrays
let _phase     = null;  // Uint8Array CP_*
let _phaseT    = null;  // Float32Array — elapsed in current phase
let _posX      = null;  // Float32Array
let _posZ      = null;  // Float32Array

// InstancedMeshes (CAP_CHESTS per part)
let _bodyMesh    = null;
let _lidMesh     = null;
let _band0Mesh   = null;
let _band1Mesh   = null;
let _band2Mesh   = null;
let _band3Mesh   = null;
let _lockMesh    = null;
let _sparkleMesh = null;
// Burst pillar — separate InstancedMesh, one per chest slot (visible during
// OPENING + brief lingering window). Shows up as a vertical amber bar.
let _burstMesh = null;

// Queue of chests awaiting picker (chest indices into the pool)
const _pickQueue = [];
let _activePickIdx = -1;   // chest currently showing modal, or -1
let _modalEl = null;
let _modalKeyHandler = null;
let _pausedByUs = false;

// Module clock (drives anim phase t)
let _clock = 0;

// Reusable scratch (no allocations in hot path)
const _dummy = new THREE.Object3D();
const _zeroDummy = new THREE.Object3D();
_zeroDummy.scale.set(0, 0, 0);
_zeroDummy.updateMatrix();
const _ZERO_MATRIX = _zeroDummy.matrix.clone();

function _track(obj) { _disposables.push(obj); }

// ── mesh builders ──────────────────────────────────────────────────────────
function _buildChestMeshes() {
  // Body — slot-3 brown box. Stamped on spawn; zero-matrix when slot free.
  const bodyGeo = new THREE.BoxGeometry(BODY_W, BODY_H, BODY_D);
  const bodyMat = new THREE.MeshStandardMaterial({
    color: SLOT3_BROWN, roughness: 0.85, metalness: 0.04, flatShading: true,
  });
  _bodyMesh = new THREE.InstancedMesh(bodyGeo, bodyMat, CAP_CHESTS);
  _bodyMesh.userData.chestPart = 'body';
  _bodyMesh.castShadow = true;
  _track(bodyGeo); _track(bodyMat);

  // Lid — slot-3 brown box, rotated about its back edge as it opens. The
  // hinge is at z = -LID_D/2 (the back edge of the chest), so we offset
  // the lid geometry so its origin sits at that edge. That way lid.rotation.x
  // pivots the front of the lid up cleanly without translating it.
  const lidGeo = new THREE.BoxGeometry(LID_W, LID_H, LID_D);
  // Translate so the back edge is at the local origin (geometry hinge).
  lidGeo.translate(0, 0, LID_D * 0.5);
  const lidMat = new THREE.MeshStandardMaterial({
    color: SLOT3_BROWN, roughness: 0.85, metalness: 0.04, flatShading: true,
  });
  _lidMesh = new THREE.InstancedMesh(lidGeo, lidMat, CAP_CHESTS);
  _lidMesh.userData.chestPart = 'lid';
  _lidMesh.castShadow = true;
  _track(lidGeo); _track(lidMat);

  // Corner bands — 4 separate InstancedMeshes (one per corner) so we can
  // stamp each at a distinct local offset. Cheap — CAP_CHESTS=8 each.
  const bandGeo = new THREE.BoxGeometry(BAND_W, BAND_H, BAND_D);
  const bandMat = new THREE.MeshStandardMaterial({
    color: SLOT4_DARK, roughness: 0.9, metalness: 0.05, flatShading: true,
  });
  _band0Mesh = new THREE.InstancedMesh(bandGeo, bandMat, CAP_CHESTS);
  _band1Mesh = new THREE.InstancedMesh(bandGeo, bandMat, CAP_CHESTS);
  _band2Mesh = new THREE.InstancedMesh(bandGeo, bandMat, CAP_CHESTS);
  _band3Mesh = new THREE.InstancedMesh(bandGeo, bandMat, CAP_CHESTS);
  _band0Mesh.userData.chestPart = 'band0';
  _band1Mesh.userData.chestPart = 'band1';
  _band2Mesh.userData.chestPart = 'band2';
  _band3Mesh.userData.chestPart = 'band3';
  _track(bandGeo); _track(bandMat);

  // Lock — slot-6 amber disc on the front face. CircleGeometry rotated to
  // face +Z (so it shows on the front of the chest, looking down z-axis).
  const lockGeo = new THREE.CircleGeometry(LOCK_R, 16);
  // CircleGeometry default normal is +Z, which is exactly what we want for
  // the front face. No rotation needed (chest faces +Z when yaw=0).
  const lockMat = new THREE.MeshStandardMaterial({
    color: SLOT6_GOLD,
    emissive: SLOT6_GOLD,
    emissiveIntensity: 0.35,
    roughness: 0.4, metalness: 0.3,
  });
  _lockMesh = new THREE.InstancedMesh(lockGeo, lockMat, CAP_CHESTS);
  _lockMesh.userData.chestPart = 'lock';
  _lockMesh.layers.enable(BLOOM_LAYER);
  _track(lockGeo); _track(lockMat);

  // Sparkle ring overhead — canonical rune-ring helper (PHASE 2 P2A).
  // Builds the 8-layer baked-glyph PlaneGeometry+MeshBasicMaterial pattern
  // used by every quality consumer (frostbloom/sigilbell/bossTelegraphs).
  const sparkleRune = createRuneRing({
    radius: SPARKLE_R_OUTER, color: SLOT6_GOLD, opacity: 0.85,
    instanced: true, cap: CAP_CHESTS, userData: { chestPart: 'sparkle' },
  });
  _sparkleMesh = sparkleRune.mesh;
  _track(sparkleRune.material);

  // Gold pillar burst — vertical box, additive amber, scaled up during the
  // open beat. CAP_CHESTS slots, hidden via ZERO_MATRIX when not bursting.
  const burstGeo = new THREE.BoxGeometry(0.3, 1.6, 0.3);
  const burstMat = new THREE.MeshBasicMaterial({
    color: SLOT6_GOLD,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  _burstMesh = new THREE.InstancedMesh(burstGeo, burstMat, CAP_CHESTS);
  _burstMesh.userData.chestPart = 'burst';
  _burstMesh.layers.enable(BLOOM_LAYER);
  _burstMesh.frustumCulled = false;
  _track(burstGeo); _track(burstMat);
}

function _zeroAllChestMatrices() {
  for (let i = 0; i < CAP_CHESTS; i++) {
    _bodyMesh.setMatrixAt(i, _ZERO_MATRIX);
    _lidMesh.setMatrixAt(i, _ZERO_MATRIX);
    _band0Mesh.setMatrixAt(i, _ZERO_MATRIX);
    _band1Mesh.setMatrixAt(i, _ZERO_MATRIX);
    _band2Mesh.setMatrixAt(i, _ZERO_MATRIX);
    _band3Mesh.setMatrixAt(i, _ZERO_MATRIX);
    _lockMesh.setMatrixAt(i, _ZERO_MATRIX);
    _sparkleMesh.setMatrixAt(i, _ZERO_MATRIX);
    _burstMesh.setMatrixAt(i, _ZERO_MATRIX);
  }
  _bodyMesh.instanceMatrix.needsUpdate = true;
  _lidMesh.instanceMatrix.needsUpdate = true;
  _band0Mesh.instanceMatrix.needsUpdate = true;
  _band1Mesh.instanceMatrix.needsUpdate = true;
  _band2Mesh.instanceMatrix.needsUpdate = true;
  _band3Mesh.instanceMatrix.needsUpdate = true;
  _lockMesh.instanceMatrix.needsUpdate = true;
  _sparkleMesh.instanceMatrix.needsUpdate = true;
  _burstMesh.instanceMatrix.needsUpdate = true;
}

// Stamp a chest's static meshes (body, bands, lock, sparkle) at world pos.
// Lid is stamped separately (it animates). Burst is stamped on OPENING tick.
function _stampStatic(i, x, z) {
  // Body — center y = BODY_CY.
  _dummy.position.set(x, BODY_CY, z);
  _dummy.rotation.set(0, 0, 0);
  _dummy.scale.setScalar(1);
  _dummy.updateMatrix();
  _bodyMesh.setMatrixAt(i, _dummy.matrix);

  // Bands at 4 corners (each band is a vertical bar of height BAND_H spanning
  // body+lid). Place center y at BAND_H/2 so the band sits flush on the
  // ground and runs up past the closed-lid top.
  const bx = BODY_W * 0.5 - BAND_W * 0.5;
  const bz = BODY_D * 0.5 - BAND_D * 0.5;
  const cy = BAND_H * 0.5;
  _dummy.position.set(x + bx, cy, z + bz);
  _dummy.updateMatrix();
  _band0Mesh.setMatrixAt(i, _dummy.matrix);
  _dummy.position.set(x - bx, cy, z + bz);
  _dummy.updateMatrix();
  _band1Mesh.setMatrixAt(i, _dummy.matrix);
  _dummy.position.set(x + bx, cy, z - bz);
  _dummy.updateMatrix();
  _band2Mesh.setMatrixAt(i, _dummy.matrix);
  _dummy.position.set(x - bx, cy, z - bz);
  _dummy.updateMatrix();
  _band3Mesh.setMatrixAt(i, _dummy.matrix);

  // Lock — front face. CircleGeometry's default normal is +Z so position it
  // a hair in front of the body's front face.
  _dummy.position.set(x, LOCK_Y, z + LOCK_Z);
  _dummy.rotation.set(0, 0, 0);
  _dummy.scale.setScalar(1);
  _dummy.updateMatrix();
  _lockMesh.setMatrixAt(i, _dummy.matrix);

  // Sparkle ring overhead.
  _dummy.position.set(x, SPARKLE_Y, z);
  _dummy.rotation.set(0, 0, 0);
  _dummy.scale.setScalar(1);
  _dummy.updateMatrix();
  _sparkleMesh.setMatrixAt(i, _dummy.matrix);

  // Burst — hidden initially (only stamped during OPENING).
  _burstMesh.setMatrixAt(i, _ZERO_MATRIX);

  _bodyMesh.instanceMatrix.needsUpdate = true;
  _band0Mesh.instanceMatrix.needsUpdate = true;
  _band1Mesh.instanceMatrix.needsUpdate = true;
  _band2Mesh.instanceMatrix.needsUpdate = true;
  _band3Mesh.instanceMatrix.needsUpdate = true;
  _lockMesh.instanceMatrix.needsUpdate = true;
  _sparkleMesh.instanceMatrix.needsUpdate = true;
  _burstMesh.instanceMatrix.needsUpdate = true;

  // Lid stamped at closed position (rotation 0).
  _stampLid(i, x, z, /*angle=*/0);
}

function _stampLid(i, x, z, angle) {
  // Lid hinges at the BACK edge (z = -LID_D/2 in world). Because we
  // translate(0,0,LID_D/2) on the geometry, the local origin IS the back
  // edge. So we set position to where that back edge lives in world space
  // (top-back of body) and rotate about local X to lift the lid.
  const px = x;
  const py = BODY_H + LID_H * 0.5;       // top of body, mid-lid
  const pz = z - BODY_D * 0.5;            // back edge of body
  _dummy.position.set(px, py, pz);
  _dummy.rotation.set(angle, 0, 0);
  _dummy.scale.setScalar(1);
  _dummy.updateMatrix();
  _lidMesh.setMatrixAt(i, _dummy.matrix);
  _lidMesh.instanceMatrix.needsUpdate = true;
}

function _stampBurst(i, x, z, scale, visible) {
  if (!visible || scale <= 0.001) {
    _burstMesh.setMatrixAt(i, _ZERO_MATRIX);
  } else {
    _dummy.position.set(x, 0.8 * scale, z);
    _dummy.rotation.set(0, 0, 0);
    _dummy.scale.set(1, scale, 1);
    _dummy.updateMatrix();
    _burstMesh.setMatrixAt(i, _dummy.matrix);
  }
  _burstMesh.instanceMatrix.needsUpdate = true;
}

function _hideChest(i) {
  _bodyMesh.setMatrixAt(i, _ZERO_MATRIX);
  _lidMesh.setMatrixAt(i, _ZERO_MATRIX);
  _band0Mesh.setMatrixAt(i, _ZERO_MATRIX);
  _band1Mesh.setMatrixAt(i, _ZERO_MATRIX);
  _band2Mesh.setMatrixAt(i, _ZERO_MATRIX);
  _band3Mesh.setMatrixAt(i, _ZERO_MATRIX);
  _lockMesh.setMatrixAt(i, _ZERO_MATRIX);
  _sparkleMesh.setMatrixAt(i, _ZERO_MATRIX);
  _burstMesh.setMatrixAt(i, _ZERO_MATRIX);
  _bodyMesh.instanceMatrix.needsUpdate = true;
  _lidMesh.instanceMatrix.needsUpdate = true;
  _band0Mesh.instanceMatrix.needsUpdate = true;
  _band1Mesh.instanceMatrix.needsUpdate = true;
  _band2Mesh.instanceMatrix.needsUpdate = true;
  _band3Mesh.instanceMatrix.needsUpdate = true;
  _lockMesh.instanceMatrix.needsUpdate = true;
  _sparkleMesh.instanceMatrix.needsUpdate = true;
  _burstMesh.instanceMatrix.needsUpdate = true;
}

// ── pool allocation ─────────────────────────────────────────────────────────
function _allocChest() {
  for (let i = 0; i < CAP_CHESTS; i++) {
    if (_phase[i] === CP_FREE) return i;
  }
  return -1;
}

// ── public spawn ────────────────────────────────────────────────────────────
/**
 * Drop a forest chest at world (x, z). Called from src/enemies.js miniboss/
 * elite death site. Silently no-op if module not loaded (non-forest stage)
 * or pool full. Idempotent against double-call from a single kill.
 *
 * @param {{x:number, z:number}|THREE.Vector3} pos
 */
export function dropForestChest(pos) {
  if (!_loaded) return;
  if (!pos) return;
  const i = _allocChest();
  if (i < 0) return; // pool full — silently drop
  const x = (typeof pos.x === 'number') ? pos.x : 0;
  const z = (typeof pos.z === 'number') ? pos.z : 0;
  _phase[i]   = CP_CLOSED;
  _phaseT[i]  = 0;
  _posX[i]    = x;
  _posZ[i]    = z;
  _stampStatic(i, x, z);
}

// ── per-frame tick ─────────────────────────────────────────────────────────
/**
 * Per-frame tick: pickup detection, lid open animation, burst fade,
 * despawn. Bails immediately when not loaded. Does NOT advance state while
 * the game is paused via the LEVELUP cascade — pickup/anim hold mid-frame.
 * Our own pause (`_pausedByUs`) is the modal — modal logic lives in event
 * handlers, not here.
 *
 * @param {Object} state - GameState
 * @param {number} dt    - frame seconds (logic delta)
 */
export function tickForestChests(state, dt) {
  if (!_loaded) return;
  if (!state) return;
  _clock += dt;

  const heroAlive = state && state.hero && !state.gameOver;
  const hx = heroAlive ? state.hero.pos.x : 0;
  const hz = heroAlive ? state.hero.pos.z : 0;

  // Spin/bob the sparkle rings + pickup detect + phase advance.
  let sparkleDirty = false;
  for (let i = 0; i < CAP_CHESTS; i++) {
    const phase = _phase[i];
    if (phase === CP_FREE) continue;
    _phaseT[i] += dt;
    const t = _phaseT[i];
    const cx = _posX[i], cz = _posZ[i];

    // Sparkle bob + spin while chest is visible (CLOSED / OPENING).
    if (phase === CP_CLOSED || phase === CP_OPENING) {
      const yaw = _clock * 1.6 + (i * 0.78);
      const bob = SPARKLE_Y + Math.sin(_clock * 2.0 + i) * 0.06;
      _dummy.position.set(cx, bob, cz);
      _dummy.rotation.set(0, yaw, 0);
      _dummy.scale.setScalar(1);
      _dummy.updateMatrix();
      _sparkleMesh.setMatrixAt(i, _dummy.matrix);
      sparkleDirty = true;
    }

    if (phase === CP_CLOSED) {
      // Pickup detect — hero AABB inside r=PICKUP_R.
      if (heroAlive) {
        const dx = hx - cx, dz = hz - cz;
        if (dx * dx + dz * dz <= PICKUP_R2) {
          _phase[i] = CP_OPENING;
          _phaseT[i] = 0;
          // Spark FX on open.
          try { spawnKillRing(cx, cz, true); } catch (_) {}
          // Cohort 13 deferred SFX wire — chest_open layer (FOREST-V2-A14).
          try { if (sfx && sfx.chestOpen) sfx.chestOpen(); } catch (_) {}
          for (let s = 0; s < 8; s++) {
            const a = (s / 8) * Math.PI * 2;
            const r = 0.4 + Math.random() * 0.4;
            try { spawnMagnetSpark(cx + Math.cos(a) * r, 0.6, cz + Math.sin(a) * r, SLOT6_GOLD); }
            catch (_) {}
          }
        }
      }
    } else if (phase === CP_OPENING) {
      const k = Math.min(1, t / OPENING_SEC);
      // Lid rotates from 0 to ~110° (about local X).
      const angle = (Math.PI * 0.61) * k;  // ~110°
      _stampLid(i, cx, cz, angle);
      // Burst pillar grows.
      const burstScale = 0.2 + 0.8 * k;
      _stampBurst(i, cx, cz, burstScale, true);

      if (t >= OPENING_SEC + BURST_HOLD) {
        // Present modal (or queue if one already showing).
        _phase[i] = CP_AWAIT;
        _phaseT[i] = 0;
        // Hide chest body (lid stays open visually until despawn — but we
        // collapse everything cleanly to keep the visual loop short).
        _hideChest(i);
        _queueOrShow(i);
      }
    } else if (phase === CP_AWAIT) {
      // Burst pillar fades during the wait so it doesn't persist forever.
      const burstScale = Math.max(0, 1.0 - t / BURST_SEC);
      _stampBurst(i, cx, cz, burstScale, burstScale > 0.05);
    } else if (phase === CP_DISPATCH) {
      // Fade burst out fully and free the slot after DESPAWN_SEC.
      _stampBurst(i, cx, cz, 0, false);
      if (t >= DESPAWN_SEC) {
        _phase[i] = CP_FREE;
        _phaseT[i] = 0;
        _hideChest(i);
      }
    }
  }
  if (sparkleDirty) {
    _sparkleMesh.instanceMatrix.needsUpdate = true;
  }
}

// ── pause helpers ──────────────────────────────────────────────────────────
function _shouldPause(state) {
  // Only pause if game is currently RUNNING — don't double-pause over a
  // death screen, an active levelup cascade, or an already-paused state.
  if (!state || !state.time) return false;
  if (state.time.paused) return false;
  if (state.gameOver) return false;
  if (state.pendingLevelUp) return false;
  return true;
}

function _pauseIfNeeded(state) {
  if (_pausedByUs) return;
  if (_shouldPause(state)) {
    state.time.paused = true;
    _pausedByUs = true;
  }
}

function _unpauseIfNeeded(state) {
  if (!_pausedByUs) return;
  if (!state || !state.time) return;
  // Only unpause if the game isn't otherwise locked (e.g. death screen
  // came up while modal was open).
  if (!state.gameOver && !state.pendingLevelUp) {
    state.time.paused = false;
  }
  _pausedByUs = false;
}

// ── modal flow ─────────────────────────────────────────────────────────────
function _queueOrShow(i) {
  _pickQueue.push(i);
  if (_activePickIdx === -1) {
    _drainQueue();
  }
}

function _drainQueue() {
  if (_pickQueue.length === 0) {
    _unpauseIfNeeded(_gameState);
    _activePickIdx = -1;
    return;
  }
  const next = _pickQueue.shift();
  _activePickIdx = next;
  _pauseIfNeeded(_gameState);
  _showPickerModal(next);
}

function _onPicked(chestIdx, opt) {
  if (chestIdx !== _activePickIdx) return;
  _hideModal();
  try { _applyReward(opt); }
  catch (e) { console.warn('[forestChests] reward apply failed:', e); }
  // FOREST-V2-A11 — per-run chest counter consumed by forestHud + bossBars.
  // Increment AFTER apply so a throw in _applyReward still counts the open
  // (the reward modal was committed; failure to apply shouldn't lie about it).
  if (_gameState && _gameState.run) {
    _gameState.run._chestsOpened = (_gameState.run._chestsOpened || 0) + 1;
  }
  // PHASE 4 P4J — telemetry chest_open (single dispatch site mirrors the
  // _chestsOpened counter so the two never drift).
  try { telemetryEvent('chest_open'); } catch (_) {}
  _phase[chestIdx] = CP_DISPATCH;
  _phaseT[chestIdx] = 0;
  _activePickIdx = -1;
  // Drain next queued chest (still paused). Order matters: re-show happens
  // BEFORE unpause, so we never unpause and immediately re-pause same frame.
  if (_pickQueue.length > 0) {
    _drainQueue();
  } else {
    _unpauseIfNeeded(_gameState);
  }
}

// ── reward dispatch ────────────────────────────────────────────────────────
function _pickRandomEquippedWeapon() {
  // Hero's currently equipped weapons. We level the first one we find that's
  // below cap; weighted by random() to avoid always hitting slot 0.
  if (!_gameState.weapons || _gameState.weapons.length === 0) return null;
  // Build a shuffled view of the weapon list, picking the first below cap.
  const order = [];
  for (let i = 0; i < _gameState.weapons.length; i++) order.push(i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = order[i]; order[i] = order[j]; order[j] = tmp;
  }
  for (let k = 0; k < order.length; k++) {
    const w = _gameState.weapons[order[k]];
    const mod = REGISTRY[w.id];
    const cap = (mod && typeof mod.maxLevel === 'number') ? mod.maxLevel : WEAPON_CAP;
    if (w.level < cap) return w;
  }
  return null;
}

function _pickRandomPassiveBelowCap() {
  // Filter PASSIVES list to those at level < maxLevel for current hero. We
  // accept either an existing passive (level it up) or a new one (acquire).
  if (!PASSIVES || PASSIVES.length === 0) return null;
  const owned = new Map((_gameState.passives || []).map(p => [p.id, p]));
  const candidates = [];
  for (const def of PASSIVES) {
    const have = owned.get(def.id);
    const cap = (typeof def.maxLevel === 'number') ? def.maxLevel : PASSIVE_CAP;
    if (have) {
      if (have.level < cap) candidates.push(def);
    } else {
      candidates.push(def);  // new acquisition (passives.applyPassive handles MAX_PASSIVES safety)
    }
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function _applyReward(opt) {
  if (!_gameState) return;
  if (opt === 'weapon') {
    const w = _pickRandomEquippedWeapon();
    if (w) {
      // acquireWeapon handles cap check internally — but we already pre-filtered.
      try { acquireWeapon(w.id); } catch (e) { console.warn('[forestChests] acquireWeapon:', e); }
    } else {
      // Fallback if no weapons below cap (every weapon max'd, or none equipped):
      // award gold instead so the chest isn't wasted.
      _applyGold();
    }
  } else if (opt === 'gold') {
    _applyGold();
  } else if (opt === 'healPassive') {
    // Heal to full.
    if (HEAL_FULL && _gameState.hero) {
      _gameState.hero.hp = _gameState.hero.hpMax;
    }
    // Random passive at +1 level.
    const def = _pickRandomPassiveBelowCap();
    if (def) {
      try { applyPassive({ id: def.id }); }
      catch (e) { console.warn('[forestChests] applyPassive:', e); }
    }
  }
}

function _applyGold() {
  if (!_gameState.run) return;
  const stageTimeSec = (_gameState.time && typeof _gameState.time.game === 'number') ? _gameState.time.game : 0;
  const amount = Math.min(GOLD_CAP, GOLD_BASE + Math.floor(stageTimeSec * GOLD_PER_SEC));
  _gameState.run.gold = (_gameState.run.gold || 0) + amount;
}

// ── modal UI (fallback HTML overlay) ────────────────────────────────────────
function _showPickerModal(chestIdx) {
  if (_modalEl) _hideModal();
  if (typeof document === 'undefined') return;

  const hasEquippedWeapon = !!_pickRandomEquippedWeapon();

  const overlay = document.createElement('div');
  overlay.id = 'kk-forest-chest-modal';
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:9999',
    'background:rgba(8,12,16,0.78)',
    'display:flex', 'align-items:center', 'justify-content:center',
    'pointer-events:auto',
    'font-family:system-ui, sans-serif',
  ].join(';');

  const panel = document.createElement('div');
  panel.style.cssText = [
    'background:linear-gradient(180deg, rgba(28,22,16,0.95), rgba(14,10,8,0.97))',
    'border:2px solid #d9a648',
    'border-radius:12px',
    'padding:28px 36px',
    'min-width:520px',
    'box-shadow:0 8px 40px rgba(217,166,72,0.35), 0 2px 0 rgba(255,255,255,0.04) inset',
    'text-align:center',
  ].join(';');

  const title = document.createElement('div');
  title.textContent = 'TREASURE CHEST';
  title.style.cssText = [
    'color:#d9a648',
    'font-size:22px',
    'letter-spacing:0.34em',
    'font-weight:700',
    'margin-bottom:6px',
  ].join(';');
  panel.appendChild(title);

  const sub = document.createElement('div');
  sub.textContent = 'Choose your reward';
  sub.style.cssText = [
    'color:rgba(245,239,225,0.62)',
    'font-size:12px',
    'letter-spacing:0.28em',
    'text-transform:uppercase',
    'margin-bottom:22px',
  ].join(';');
  panel.appendChild(sub);

  const row = document.createElement('div');
  row.style.cssText = 'display:flex; gap:14px; justify-content:center;';
  panel.appendChild(row);

  // Compute display values for each option BEFORE building buttons (so the
  // gold tile shows the actual current amount).
  const stageTimeSec = (_gameState.time && typeof _gameState.time.game === 'number') ? _gameState.time.game : 0;
  const goldAmount = Math.min(GOLD_CAP, GOLD_BASE + Math.floor(stageTimeSec * GOLD_PER_SEC));

  const opts = [];
  if (hasEquippedWeapon) {
    opts.push({ key: '1', id: 'weapon', icon: '⚔️', title: 'Weapon +1', desc: 'Level up a random equipped weapon' });
  }
  opts.push({ key: hasEquippedWeapon ? '2' : '1', id: 'gold', icon: '🪙', title: `+${goldAmount} Gold`, desc: 'Stash for the run' });
  opts.push({ key: hasEquippedWeapon ? '3' : '2', id: 'healPassive', icon: '💗', title: 'Full Heal + Passive', desc: 'Restore HP and level a random passive' });

  const buttons = [];
  for (let oi = 0; oi < opts.length; oi++) {
    const o = opts[oi];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.style.cssText = [
      'flex:1', 'min-width:140px', 'padding:18px 12px',
      'background:linear-gradient(180deg, rgba(40,30,18,0.86), rgba(18,12,8,0.96))',
      'border:1px solid rgba(217,166,72,0.4)', 'border-radius:8px',
      'color:#f5efe1',
      'font-family:inherit', 'font-size:13px',
      'cursor:pointer',
      'display:flex', 'flex-direction:column', 'gap:8px',
      'transition:transform 0.08s, border-color 0.08s',
    ].join(';');
    btn.onmouseenter = () => { btn.style.borderColor = '#d9a648'; btn.style.transform = 'translateY(-2px)'; };
    btn.onmouseleave = () => { btn.style.borderColor = 'rgba(217,166,72,0.4)'; btn.style.transform = ''; };

    const iconEl = document.createElement('div');
    iconEl.textContent = o.icon;
    iconEl.style.cssText = 'font-size:32px; line-height:1;';
    btn.appendChild(iconEl);
    const tEl = document.createElement('div');
    tEl.textContent = o.title;
    tEl.style.cssText = 'font-weight:700; letter-spacing:0.12em; text-transform:uppercase; color:#d9a648; font-size:13px;';
    btn.appendChild(tEl);
    const dEl = document.createElement('div');
    dEl.textContent = o.desc;
    dEl.style.cssText = 'font-size:11px; color:rgba(245,239,225,0.7);';
    btn.appendChild(dEl);
    const kEl = document.createElement('div');
    kEl.textContent = `[ ${o.key} ]`;
    kEl.style.cssText = 'font-family:monospace; font-size:11px; color:rgba(217,166,72,0.65); margin-top:4px;';
    btn.appendChild(kEl);

    btn.onclick = (ev) => {
      ev.stopPropagation();
      _onPicked(chestIdx, o.id);
    };
    row.appendChild(btn);
    buttons.push({ key: o.key, id: o.id, btn });
  }

  overlay.appendChild(panel);
  // Block clicks outside panel — VS-style mandatory pick. ESC also forbidden.
  overlay.addEventListener('click', (ev) => { ev.stopPropagation(); });

  document.body.appendChild(overlay);
  _modalEl = overlay;

  // Keyboard 1/2/3 (mapped to currently-shown buttons).
  _modalKeyHandler = (ev) => {
    // Forbid ESC dismiss.
    if (ev.key === 'Escape' || ev.code === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    for (let bi = 0; bi < buttons.length; bi++) {
      const b = buttons[bi];
      if (ev.key === b.key || ev.code === `Digit${b.key}`) {
        ev.preventDefault();
        ev.stopPropagation();
        _onPicked(chestIdx, b.id);
        return;
      }
    }
  };
  window.addEventListener('keydown', _modalKeyHandler, true);
}

function _hideModal() {
  if (_modalEl && _modalEl.parentNode) {
    _modalEl.parentNode.removeChild(_modalEl);
  }
  _modalEl = null;
  if (_modalKeyHandler) {
    window.removeEventListener('keydown', _modalKeyHandler, true);
    _modalKeyHandler = null;
  }
}

// ── public API ─────────────────────────────────────────────────────────────
/**
 * Build pre-pooled chest meshes. Idempotent — gated on `_loaded` so a
 * double-load is a no-op.
 *
 * @param {THREE.Scene} scene
 * @param {Object} _state - GameState (unused at load; tick reads hero+enemies).
 */
export function loadForestChests(scene, _state) {
  if (_loaded) return;
  if (!scene) return;
  _scene = scene;
  _group = new THREE.Group();
  _group.name = '__forestChests';

  _phase  = new Uint8Array(CAP_CHESTS);   // CP_FREE = 0 by default
  _phaseT = new Float32Array(CAP_CHESTS);
  _posX   = new Float32Array(CAP_CHESTS);
  _posZ   = new Float32Array(CAP_CHESTS);

  _buildChestMeshes();
  _group.add(_bodyMesh);
  _group.add(_lidMesh);
  _group.add(_band0Mesh);
  _group.add(_band1Mesh);
  _group.add(_band2Mesh);
  _group.add(_band3Mesh);
  _group.add(_lockMesh);
  _group.add(_sparkleMesh);
  _group.add(_burstMesh);
  _zeroAllChestMatrices();

  _pickQueue.length = 0;
  _activePickIdx = -1;
  _pausedByUs = false;
  _clock = 0;

  scene.add(_group);
  _loaded = true;
}

/**
 * Tear down all chest meshes + clear pool state. Idempotent — safe to call
 * when not loaded. Also dismisses any open modal and unpauses if we paused.
 *
 * @param {THREE.Scene} scene
 */
export function disposeForestChests(scene) {
  // Tear down modal first so a stage change doesn't strand an overlay.
  if (_modalEl) _hideModal();
  if (_pausedByUs && _gameState && _gameState.time) {
    if (!_gameState.gameOver && !_gameState.pendingLevelUp) {
      _gameState.time.paused = false;
    }
    _pausedByUs = false;
  }
  _activePickIdx = -1;
  _pickQueue.length = 0;

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

  _bodyMesh = _lidMesh = null;
  _band0Mesh = _band1Mesh = _band2Mesh = _band3Mesh = null;
  _lockMesh = _sparkleMesh = _burstMesh = null;
  _phase = _phaseT = _posX = _posZ = null;
  _scene = null;
  _clock = 0;
  _loaded = false;
}
