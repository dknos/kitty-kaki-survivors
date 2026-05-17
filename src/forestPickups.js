/**
 * Forest Floor Pickups — VS-staple consumable drops (FOREST-V2-A8, 2026-05-17).
 *
 * Three forest-only floor consumables that drop from enemy kills, sit on the
 * ground with a sparkle ring, and apply an instant on-walk-over effect:
 *
 *   • Bomb     — kill ALL enemies currently on the active list (excluding
 *                final-boss / Reaper / `_invincible`). White screen flash +
 *                shake. Drops 1% of any enemy kill (forest only).
 *   • Magnet   — vacuum every active XP gem toward the hero (sets `magnetized`
 *                on each — same path already used by the existing star pickup
 *                and the level-up sweep in xp.js). Drops 2% of any enemy kill
 *                (forest only) when no bomb already dropped.
 *   • Chicken  — heal hero to full (`state.hero.hp = state.hero.hpMax`). Drops
 *                4% of any enemy kill (forest only) ONLY when the hero is
 *                below 50% HP at drop-time — VS-accurate gating.
 *
 * ── Why a forest-specific module ───────────────────────────────────────────
 * `src/pickups.js` already ships `spawnBomb` / `spawnFreeze` / `spawnChicken`
 * pickups with DIFFERENT visuals, different effects (the bomb in pickups.js
 * is a 50-dmg radius-18 AoE, NOT a screen-wide kill-all), and different
 * baseline drop rates that fire on EVERY stage. This module is the
 * VS-faithful kill-all bomb + new magnet + low-HP-gated chicken layer that
 * forest-only deathloops route through, leaving the cross-stage `pickups.js`
 * path untouched. Pickups can coexist on forest — see the "Coexistence note"
 * in the final report — but the visual silhouettes are intentionally distinct
 * so the player learns which icon does what.
 *
 * ── Pre-pool ────────────────────────────────────────────────────────────────
 *   CAP_BOMBS    = 16
 *   CAP_MAGNETS  = 16
 *   CAP_CHICKENS =  8
 *
 * Per-type Uint8Array `_phase` (FREE/WAIT/COLLECTED/DESPAWN), Float32Array
 * `_phaseT`, Float32Array `_posX`/`_posZ`. InstancedMesh per part with a
 * shared zero-matrix sentinel for FREE slots. Zero per-spawn allocation in
 * the drop hot path (borgir-salvo etc. fire 100+ deaths/frame).
 *
 * ── Palette (slot-locked — no new hex constants) ──────────────────────────
 *   slot 1 #c7b89a — chicken drumstick legs (bone)
 *   slot 3 #6b4f3a — bomb fuse + chicken body alt (brown)
 *   slot 4 #4a3220 — bomb body (dark)
 *   slot 5 #e89c4a — magnet prongs + top + chicken body (amber)
 *   slot 6 #d9a648 — sparkle ring, spark glow (gold)
 *
 * ── Self-gating ────────────────────────────────────────────────────────────
 *   On pickup detect → `_phase[i] = CP_COLLECTED` IMMEDIATELY, the dispatch
 *   side-effect (kill-all / vacuum / heal) fires once, then transitions to
 *   CP_DESPAWN over DESPAWN_SEC. No re-entry; double-pickup is impossible.
 *
 * ── Drop hook ──────────────────────────────────────────────────────────────
 *   Wired from src/enemies.js killEnemy() via a single static import + one
 *   call site (≤5 lines, mirrors the existing `dropForestChest` hook). One
 *   random() roll allocates ranges 0–0.01 (bomb), 0.01–0.03 (magnet),
 *   0.03–0.07 (chicken, only if hero HP < 50% at DROP TIME). Forest-only —
 *   gate is the same `_forestChestStage` already in scope in killEnemy.
 *
 * ── Linger ─────────────────────────────────────────────────────────────────
 *   30s auto-despawn from spawn (LINGER_SEC). Magnet/Bomb pickup radius
 *   scales with `state.hero.statMul.magnet` (same factor `xp.js` and
 *   `pickups.js` use). Brief calls for an "L3+ magnet_passive grows to 2.5"
 *   special case — that exact passive id doesn't exist; the existing magnet
 *   multiplier path (soullink + character statMul.magnet) already grows the
 *   radius the same way, so we reuse it instead of inventing a new gate.
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from './postfx.js';
import { state as _gameState } from './state.js';
import { damageEnemy } from './enemies.js';
import { spawnMagnetSpark } from './fx.js';
import { sfx } from './audio.js';
import { createRuneRing } from './fx/runeRing.js';

// ── pool caps ───────────────────────────────────────────────────────────────
const CAP_BOMBS    = 16;
const CAP_MAGNETS  = 16;
const CAP_CHICKENS = 8;

// ── palette (slot-locked, brief-mandated) ──────────────────────────────────
const SLOT1_BONE  = 0xc7b89a;
const SLOT3_BROWN = 0x6b4f3a;
const SLOT4_DARK  = 0x4a3220;
const SLOT5_AMBER = 0xe89c4a;
const SLOT6_GOLD  = 0xd9a648;

// ── pickup tunables ────────────────────────────────────────────────────────
const PICKUP_R         = 0.7;
const PICKUP_R2_BASE   = PICKUP_R * PICKUP_R;
const LINGER_SEC       = 30.0;
const DESPAWN_SEC      = 0.35;   // shrink-fade after collected
const SPARKLE_Y        = 0.95;   // overhead halo height
const SPARKLE_R_INNER  = 0.30;
const SPARKLE_R_OUTER  = 0.45;

// ── geometry tunables ──────────────────────────────────────────────────────
// Bomb
const BOMB_R           = 0.25;
const BOMB_FUSE_R      = 0.04;
const BOMB_FUSE_H      = 0.15;
const BOMB_SPARK_R     = 0.05;
const BOMB_BODY_Y      = BOMB_R;                                  // 0.25
const BOMB_FUSE_Y      = BOMB_BODY_Y + BOMB_R + BOMB_FUSE_H * 0.5; // ~0.575
const BOMB_SPARK_Y     = BOMB_BODY_Y + BOMB_R + BOMB_FUSE_H + 0.04;

// Magnet (horseshoe — 2 prongs + connecting top)
const MAG_PRONG_W      = 0.10;
const MAG_PRONG_H      = 0.42;
const MAG_PRONG_D      = 0.10;
const MAG_GAP          = 0.22;   // X distance between prong centres
const MAG_TOP_W        = MAG_GAP + MAG_PRONG_W;
const MAG_TOP_H        = 0.10;
const MAG_TOP_D        = MAG_PRONG_D;
const MAG_PRONG_CY     = MAG_PRONG_H * 0.5;                       // 0.21
const MAG_TOP_CY       = MAG_PRONG_H + MAG_TOP_H * 0.5;            // ~0.47

// Chicken (oblong body + 2 drumstick legs)
const CHICK_BODY_R     = 0.28;
const CHICK_BODY_SX    = 1.1;
const CHICK_BODY_SY    = 0.70;
const CHICK_BODY_SZ    = 1.0;
const CHICK_LEG_R      = 0.05;
const CHICK_LEG_H      = 0.14;
const CHICK_BODY_CY    = CHICK_BODY_R * CHICK_BODY_SY + 0.05;     // ~0.246
const CHICK_LEG_CY     = CHICK_LEG_H * 0.5;                       // 0.07

// Bomb effect
const BOMB_DMG         = 9999;
const FLASH_FADE_SEC   = 0.2;
const SHAKE_AMOUNT     = 0.4;

// ── phase codes ────────────────────────────────────────────────────────────
const CP_FREE      = 0;
const CP_WAIT      = 1;   // sitting on ground, awaiting pickup
const CP_COLLECTED = 2;   // effect dispatched, shrinking out
const CP_DESPAWN   = 3;   // transitional → FREE

// ── module state ───────────────────────────────────────────────────────────
let _loaded = false;
let _scene = null;
let _group = null;
let _disposables = [];
let _clock = 0;

// Flash overlay (single DOM div, reused across bombs).
const FLASH_EL_ID = '__kk_forest_pickup_flash';
let _flashEl = null;
let _flashTimer = 0;   // realtime seconds since last fire

// Per-type pool arrays (created in load).
let _bPhase   = null, _bPhaseT  = null, _bPosX  = null, _bPosZ  = null;
let _mPhase   = null, _mPhaseT  = null, _mPosX  = null, _mPosZ  = null;
let _cPhase   = null, _cPhaseT  = null, _cPosX  = null, _cPosZ  = null;

// InstancedMeshes — one per part per type.
let _bombBodyMesh = null, _bombFuseMesh = null, _bombSparkMesh = null;
let _magProngLMesh = null, _magProngRMesh = null, _magTopMesh = null;
let _chickBodyMesh = null, _chickLegLMesh = null, _chickLegRMesh = null;

// Sparkle ring — one InstancedMesh per type (independent lifecycle = simpler).
let _bombSparkleMesh = null, _magSparkleMesh = null, _chickSparkleMesh = null;

// Reusable scratch — zero per-frame allocation.
const _dummy = new THREE.Object3D();
const _zeroDummy = new THREE.Object3D();
_zeroDummy.scale.set(0, 0, 0);
_zeroDummy.updateMatrix();
const _ZERO_MATRIX = _zeroDummy.matrix.clone();

function _track(obj) { _disposables.push(obj); }

// ── mesh builders ──────────────────────────────────────────────────────────
function _buildBombMeshes() {
  const bodyGeo = new THREE.SphereGeometry(BOMB_R, 12, 10);
  const bodyMat = new THREE.MeshStandardMaterial({
    color: SLOT4_DARK, roughness: 0.85, metalness: 0.1, flatShading: true,
  });
  _bombBodyMesh = new THREE.InstancedMesh(bodyGeo, bodyMat, CAP_BOMBS);
  _bombBodyMesh.castShadow = true;
  _bombBodyMesh.userData.pickupPart = 'bombBody';
  _track(bodyGeo); _track(bodyMat);

  const fuseGeo = new THREE.CylinderGeometry(BOMB_FUSE_R, BOMB_FUSE_R, BOMB_FUSE_H, 6);
  const fuseMat = new THREE.MeshStandardMaterial({
    color: SLOT3_BROWN, roughness: 0.95, metalness: 0.0,
  });
  _bombFuseMesh = new THREE.InstancedMesh(fuseGeo, fuseMat, CAP_BOMBS);
  _bombFuseMesh.userData.pickupPart = 'bombFuse';
  _track(fuseGeo); _track(fuseMat);

  // Spark — flat disc, bloom-tagged, pulses scale via tick.
  const sparkGeo = new THREE.CircleGeometry(BOMB_SPARK_R, 12);
  // Rotate to face up so it billboards readably in top-down camera.
  sparkGeo.rotateX(-Math.PI / 2);
  const sparkMat = new THREE.MeshBasicMaterial({
    color: SLOT6_GOLD, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  _bombSparkMesh = new THREE.InstancedMesh(sparkGeo, sparkMat, CAP_BOMBS);
  _bombSparkMesh.layers.enable(BLOOM_LAYER);
  _bombSparkMesh.frustumCulled = false;
  _bombSparkMesh.userData.pickupPart = 'bombSpark';
  _track(sparkGeo); _track(sparkMat);
}

function _buildMagnetMeshes() {
  const prongGeo = new THREE.BoxGeometry(MAG_PRONG_W, MAG_PRONG_H, MAG_PRONG_D);
  const prongMat = new THREE.MeshStandardMaterial({
    color: SLOT5_AMBER, roughness: 0.55, metalness: 0.35, flatShading: true,
  });
  _magProngLMesh = new THREE.InstancedMesh(prongGeo, prongMat, CAP_MAGNETS);
  _magProngRMesh = new THREE.InstancedMesh(prongGeo, prongMat, CAP_MAGNETS);
  _magProngLMesh.castShadow = true;
  _magProngRMesh.castShadow = true;
  _magProngLMesh.userData.pickupPart = 'magProngL';
  _magProngRMesh.userData.pickupPart = 'magProngR';
  _track(prongGeo); _track(prongMat);

  const topGeo = new THREE.BoxGeometry(MAG_TOP_W, MAG_TOP_H, MAG_TOP_D);
  const topMat = new THREE.MeshStandardMaterial({
    color: SLOT5_AMBER, roughness: 0.55, metalness: 0.35, flatShading: true,
  });
  _magTopMesh = new THREE.InstancedMesh(topGeo, topMat, CAP_MAGNETS);
  _magTopMesh.castShadow = true;
  _magTopMesh.userData.pickupPart = 'magTop';
  _track(topGeo); _track(topMat);
}

function _buildChickenMeshes() {
  // Body — slot-5 amber (the more "roast golden" of the two — slot-3 brown
  // reads as raw chicken; slot-5 amber sells the cooked tone). Scaled non-
  // uniformly to get the oblong silhouette in one geometry.
  const bodyGeo = new THREE.SphereGeometry(CHICK_BODY_R, 14, 12);
  const bodyMat = new THREE.MeshStandardMaterial({
    color: SLOT5_AMBER, roughness: 0.75, metalness: 0.05, flatShading: true,
  });
  _chickBodyMesh = new THREE.InstancedMesh(bodyGeo, bodyMat, CAP_CHICKENS);
  _chickBodyMesh.castShadow = true;
  _chickBodyMesh.userData.pickupPart = 'chickBody';
  _track(bodyGeo); _track(bodyMat);

  const legGeo = new THREE.CylinderGeometry(CHICK_LEG_R, CHICK_LEG_R, CHICK_LEG_H, 6);
  const legMat = new THREE.MeshStandardMaterial({
    color: SLOT1_BONE, roughness: 0.9, metalness: 0.0, flatShading: true,
  });
  _chickLegLMesh = new THREE.InstancedMesh(legGeo, legMat, CAP_CHICKENS);
  _chickLegRMesh = new THREE.InstancedMesh(legGeo, legMat, CAP_CHICKENS);
  _chickLegLMesh.userData.pickupPart = 'chickLegL';
  _chickLegRMesh.userData.pickupPart = 'chickLegR';
  _track(legGeo); _track(legMat);
}

function _buildSparkleMesh(cap) {
  // Canonical rune-ring helper (PHASE 2 P2A) — replaces the prior flat
  // RingGeometry+MeshBasicMaterial donut with the baked-glyph quality bar.
  const rune = createRuneRing({
    radius: SPARKLE_R_OUTER, color: SLOT6_GOLD, opacity: 0.82,
    instanced: true, cap, userData: { pickupPart: 'sparkle' },
  });
  _track(rune.material);
  return rune.mesh;
}

function _zeroInstanced(mesh, cap) {
  if (!mesh) return;
  for (let i = 0; i < cap; i++) mesh.setMatrixAt(i, _ZERO_MATRIX);
  mesh.instanceMatrix.needsUpdate = true;
}

function _zeroAllMatrices() {
  _zeroInstanced(_bombBodyMesh,   CAP_BOMBS);
  _zeroInstanced(_bombFuseMesh,   CAP_BOMBS);
  _zeroInstanced(_bombSparkMesh,  CAP_BOMBS);
  _zeroInstanced(_bombSparkleMesh,CAP_BOMBS);
  _zeroInstanced(_magProngLMesh,  CAP_MAGNETS);
  _zeroInstanced(_magProngRMesh,  CAP_MAGNETS);
  _zeroInstanced(_magTopMesh,     CAP_MAGNETS);
  _zeroInstanced(_magSparkleMesh, CAP_MAGNETS);
  _zeroInstanced(_chickBodyMesh,  CAP_CHICKENS);
  _zeroInstanced(_chickLegLMesh,  CAP_CHICKENS);
  _zeroInstanced(_chickLegRMesh,  CAP_CHICKENS);
  _zeroInstanced(_chickSparkleMesh,CAP_CHICKENS);
}

// ── stamping helpers ───────────────────────────────────────────────────────
function _stampBomb(i, x, z, scale) {
  // Body — slot-4 dark sphere.
  _dummy.position.set(x, BOMB_BODY_Y * scale, z);
  _dummy.rotation.set(0, 0, 0);
  _dummy.scale.setScalar(scale);
  _dummy.updateMatrix();
  _bombBodyMesh.setMatrixAt(i, _dummy.matrix);

  // Fuse — slot-3 brown cylinder atop body.
  _dummy.position.set(x, BOMB_FUSE_Y * scale, z);
  _dummy.scale.setScalar(scale);
  _dummy.updateMatrix();
  _bombFuseMesh.setMatrixAt(i, _dummy.matrix);

  // Spark — pulsing gold disc above fuse.
  const pulse = scale * (0.85 + 0.35 * Math.sin(_clock * 8 + i * 1.7));
  _dummy.position.set(x, BOMB_SPARK_Y * scale, z);
  _dummy.scale.setScalar(pulse);
  _dummy.updateMatrix();
  _bombSparkMesh.setMatrixAt(i, _dummy.matrix);

  _bombBodyMesh.instanceMatrix.needsUpdate = true;
  _bombFuseMesh.instanceMatrix.needsUpdate = true;
  _bombSparkMesh.instanceMatrix.needsUpdate = true;
}

function _stampMagnet(i, x, z, scale) {
  // Slight Y-axis sway — sells it as a powerup, not arena prop.
  const yaw = Math.sin(_clock * 1.4 + i * 0.9) * 0.20;
  const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
  // Left prong — offset -MAG_GAP/2 on local X.
  const lx = -MAG_GAP * 0.5;
  _dummy.position.set(x + lx * cosY, MAG_PRONG_CY * scale, z + lx * sinY);
  _dummy.rotation.set(0, yaw, 0);
  _dummy.scale.setScalar(scale);
  _dummy.updateMatrix();
  _magProngLMesh.setMatrixAt(i, _dummy.matrix);

  // Right prong — +MAG_GAP/2.
  const rx = MAG_GAP * 0.5;
  _dummy.position.set(x + rx * cosY, MAG_PRONG_CY * scale, z + rx * sinY);
  _dummy.rotation.set(0, yaw, 0);
  _dummy.scale.setScalar(scale);
  _dummy.updateMatrix();
  _magProngRMesh.setMatrixAt(i, _dummy.matrix);

  // Top bar — centred over the prongs.
  _dummy.position.set(x, MAG_TOP_CY * scale, z);
  _dummy.rotation.set(0, yaw, 0);
  _dummy.scale.setScalar(scale);
  _dummy.updateMatrix();
  _magTopMesh.setMatrixAt(i, _dummy.matrix);

  _magProngLMesh.instanceMatrix.needsUpdate = true;
  _magProngRMesh.instanceMatrix.needsUpdate = true;
  _magTopMesh.instanceMatrix.needsUpdate = true;
}

function _stampChicken(i, x, z, scale) {
  // Slow spin so it reads as a dropped pickup, not a baked decor item.
  const yaw = _clock * 0.6 + i * 0.55;
  const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
  // Body — oblong sphere, non-uniform scale.
  _dummy.position.set(x, CHICK_BODY_CY * scale, z);
  _dummy.rotation.set(0, yaw, 0);
  _dummy.scale.set(CHICK_BODY_SX * scale, CHICK_BODY_SY * scale, CHICK_BODY_SZ * scale);
  _dummy.updateMatrix();
  _chickBodyMesh.setMatrixAt(i, _dummy.matrix);

  // Two drumstick legs — short cylinders splayed slightly outward from the
  // belly of the body. We rotate them so the long axis points up-out.
  const legOff = 0.13 * scale;  // x-offset of leg base from body centre
  // Left leg — rotated about Z so it splays left, then yaw-rotated with body.
  const lzAng = 0.4;
  // After yaw rotation, the local-X offset becomes (cosY * legOff, 0, sinY * legOff).
  _dummy.position.set(x + cosY * (-legOff), CHICK_LEG_CY * scale, z + sinY * (-legOff));
  _dummy.rotation.set(0, yaw, lzAng);
  _dummy.scale.setScalar(scale);
  _dummy.updateMatrix();
  _chickLegLMesh.setMatrixAt(i, _dummy.matrix);

  // Right leg.
  _dummy.position.set(x + cosY * (legOff), CHICK_LEG_CY * scale, z + sinY * (legOff));
  _dummy.rotation.set(0, yaw, -lzAng);
  _dummy.scale.setScalar(scale);
  _dummy.updateMatrix();
  _chickLegRMesh.setMatrixAt(i, _dummy.matrix);

  _chickBodyMesh.instanceMatrix.needsUpdate = true;
  _chickLegLMesh.instanceMatrix.needsUpdate = true;
  _chickLegRMesh.instanceMatrix.needsUpdate = true;
}

function _stampSparkle(mesh, i, x, z, scale) {
  if (!mesh) return;
  const yaw = _clock * 1.8 + i * 0.78;
  const bob = SPARKLE_Y + Math.sin(_clock * 2.2 + i * 1.2) * 0.06;
  _dummy.position.set(x, bob, z);
  _dummy.rotation.set(0, yaw, 0);
  _dummy.scale.setScalar(scale);
  _dummy.updateMatrix();
  mesh.setMatrixAt(i, _dummy.matrix);
  mesh.instanceMatrix.needsUpdate = true;
}

function _hideBomb(i) {
  _bombBodyMesh.setMatrixAt(i, _ZERO_MATRIX);
  _bombFuseMesh.setMatrixAt(i, _ZERO_MATRIX);
  _bombSparkMesh.setMatrixAt(i, _ZERO_MATRIX);
  _bombSparkleMesh.setMatrixAt(i, _ZERO_MATRIX);
  _bombBodyMesh.instanceMatrix.needsUpdate = true;
  _bombFuseMesh.instanceMatrix.needsUpdate = true;
  _bombSparkMesh.instanceMatrix.needsUpdate = true;
  _bombSparkleMesh.instanceMatrix.needsUpdate = true;
}
function _hideMagnet(i) {
  _magProngLMesh.setMatrixAt(i, _ZERO_MATRIX);
  _magProngRMesh.setMatrixAt(i, _ZERO_MATRIX);
  _magTopMesh.setMatrixAt(i, _ZERO_MATRIX);
  _magSparkleMesh.setMatrixAt(i, _ZERO_MATRIX);
  _magProngLMesh.instanceMatrix.needsUpdate = true;
  _magProngRMesh.instanceMatrix.needsUpdate = true;
  _magTopMesh.instanceMatrix.needsUpdate = true;
  _magSparkleMesh.instanceMatrix.needsUpdate = true;
}
function _hideChicken(i) {
  _chickBodyMesh.setMatrixAt(i, _ZERO_MATRIX);
  _chickLegLMesh.setMatrixAt(i, _ZERO_MATRIX);
  _chickLegRMesh.setMatrixAt(i, _ZERO_MATRIX);
  _chickSparkleMesh.setMatrixAt(i, _ZERO_MATRIX);
  _chickBodyMesh.instanceMatrix.needsUpdate = true;
  _chickLegLMesh.instanceMatrix.needsUpdate = true;
  _chickLegRMesh.instanceMatrix.needsUpdate = true;
  _chickSparkleMesh.instanceMatrix.needsUpdate = true;
}

// ── pool allocation ────────────────────────────────────────────────────────
function _allocSlot(phaseArr, cap) {
  for (let i = 0; i < cap; i++) {
    if (phaseArr[i] === CP_FREE) return i;
  }
  return -1;
}

// ── effects ────────────────────────────────────────────────────────────────
function _fireBombEffect(cx, cz) {
  if (!_gameState || !_gameState.enemies || !_gameState.enemies.active) return;
  const arr = _gameState.enemies.active;
  // Iterate a snapshot length — damageEnemy → killEnemy splices the array, so
  // we walk backwards to keep indices stable mid-loop.
  for (let i = arr.length - 1; i >= 0; i--) {
    const e = arr[i];
    if (!e || !e.alive) continue;
    if (e.isFinalBoss) continue;            // boss carve-out (advisor: keep big fights alive)
    if (e._invincible) continue;             // defensive (Reaper isn't in this list, but any future invincible affix is)
    try { damageEnemy(e, BOMB_DMG, 'bomb_pickup'); }
    catch (err) { /* swallow — bomb dispatch must never throw mid-loop */ }
  }
  // Screen flash overlay (fade-out via realtime tick).
  _showFlash();
  // Camera shake (shared with regular bomb / explosion FX).
  if (_gameState.fx) {
    _gameState.fx.shake = Math.max(_gameState.fx.shake || 0, SHAKE_AMOUNT);
    _gameState.fx.bloomBoost = Math.max(_gameState.fx.bloomBoost || 0, 0.8);
  }
  // Faux audio cue — reuse magnet-spark FX as a centred burst.
  try { spawnMagnetSpark(cx, 0.8, cz, SLOT6_GOLD); } catch (_) {}
  try { sfx.bombPickup && sfx.bombPickup(); } catch (_) {}
}

function _fireMagnetEffect(cx, cz) {
  if (!_gameState || !_gameState.gems || !_gameState.gems.list) return;
  const list = _gameState.gems.list;
  for (let g = 0; g < list.length; g++) {
    const gem = list[g];
    if (gem && gem.active) gem.magnetized = true;
  }
  if (_gameState.fx) {
    _gameState.fx.bloomBoost = Math.max(_gameState.fx.bloomBoost || 0, 0.5);
    _gameState.fx.chromaticPulse = 0.5;
  }
  // Visual cue — gold spark at hero (use cx/cz of pickup so it pops at
  // pickup location, not hero centre — clearer "the magnet did this").
  try { spawnMagnetSpark(cx, 0.9, cz, SLOT6_GOLD); } catch (_) {}
  try { sfx.magnetPickup && sfx.magnetPickup(); } catch (_) {}
}

function _fireChickenEffect(cx, cz) {
  if (!_gameState || !_gameState.hero) return;
  const hero = _gameState.hero;
  const before = hero.hp || 0;
  hero.hp = hero.hpMax;
  const healed = hero.hp - before;
  if (healed > 0) {
    try {
      // Reuse damageNumbers green floater path (same as heart pickup uses).
      import('./damageNumbers.js').then(m => m.spawnHealNumber && m.spawnHealNumber(healed));
    } catch (_) {}
  }
  try { spawnMagnetSpark(cx, 0.9, cz, SLOT5_AMBER); } catch (_) {}
  try { sfx.chickenPickup && sfx.chickenPickup(); } catch (_) {}
}

// ── flash overlay ──────────────────────────────────────────────────────────
function _ensureFlashEl() {
  if (typeof document === 'undefined') return null;
  if (_flashEl && _flashEl.parentNode) return _flashEl;
  const existing = document.getElementById(FLASH_EL_ID);
  if (existing) { _flashEl = existing; return _flashEl; }
  _flashEl = document.createElement('div');
  _flashEl.id = FLASH_EL_ID;
  _flashEl.style.cssText = [
    'position:fixed', 'inset:0', 'pointer-events:none',
    'background:#ffffff', 'opacity:0',
    'z-index:55',
    'mix-blend-mode:screen',
  ].join(';');
  document.body.appendChild(_flashEl);
  return _flashEl;
}
function _showFlash() {
  const el = _ensureFlashEl();
  if (!el) return;
  el.style.opacity = '0.85';
  _flashTimer = FLASH_FADE_SEC;
}
function _hideFlash() {
  if (_flashEl) {
    _flashEl.style.opacity = '0';
  }
  _flashTimer = 0;
}
function _disposeFlashEl() {
  if (_flashEl && _flashEl.parentNode) {
    _flashEl.parentNode.removeChild(_flashEl);
  }
  _flashEl = null;
  _flashTimer = 0;
}

// ── public spawn ───────────────────────────────────────────────────────────
function _spawnBomb(x, z) {
  const i = _allocSlot(_bPhase, CAP_BOMBS);
  if (i < 0) return false;
  _bPhase[i] = CP_WAIT;
  _bPhaseT[i] = 0;
  _bPosX[i] = x;
  _bPosZ[i] = z;
  _stampBomb(i, x, z, 1.0);
  _stampSparkle(_bombSparkleMesh, i, x, z, 1.0);
  return true;
}

function _spawnMagnet(x, z) {
  const i = _allocSlot(_mPhase, CAP_MAGNETS);
  if (i < 0) return false;
  _mPhase[i] = CP_WAIT;
  _mPhaseT[i] = 0;
  _mPosX[i] = x;
  _mPosZ[i] = z;
  _stampMagnet(i, x, z, 1.0);
  _stampSparkle(_magSparkleMesh, i, x, z, 1.0);
  return true;
}

function _spawnChicken(x, z) {
  const i = _allocSlot(_cPhase, CAP_CHICKENS);
  if (i < 0) return false;
  _cPhase[i] = CP_WAIT;
  _cPhaseT[i] = 0;
  _cPosX[i] = x;
  _cPosZ[i] = z;
  _stampChicken(i, x, z, 1.0);
  _stampSparkle(_chickSparkleMesh, i, x, z, 1.0);
  return true;
}

/**
 * Drop a forest floor pickup at world (x, z). Called from enemies.killEnemy()
 * (single static-imported call at the death/drop site). Silently no-op when
 * the module hasn't been loaded (= non-forest stage). One Math.random() roll
 * is passed in by the caller so the kill loop has full control of the RNG
 * (lets future tooling deterministically reproduce loots).
 *
 * Drop ranges (forest only, per brief):
 *   [0.00, 0.01)  → bomb     (1%)
 *   [0.01, 0.03)  → magnet   (2%)
 *   [0.03, 0.07)  → chicken  (4%, GATED on hero HP < 50% at DROP TIME)
 *   [0.07, 1.00]  → nothing
 *
 * Chicken HP gate is evaluated AT DROP TIME (VS-accurate: chicken only
 * drops when low). If gated off, the chicken bucket becomes a nothing-drop;
 * we don't fall-through to a smaller pickup.
 *
 * @param {{x:number, z:number}|THREE.Vector3} pos - enemy death position
 * @param {number} rngRoll - precomputed Math.random() (0..1)
 * @param {number} heroHpPct - hero.hp / hero.hpMax at time of kill (0..1)
 * @returns {string|null} the dropped type id or null
 */
export function dropForestPickup(pos, rngRoll, heroHpPct) {
  if (!_loaded) return null;
  if (!pos) return null;
  const x = (typeof pos.x === 'number') ? pos.x : 0;
  const z = (typeof pos.z === 'number') ? pos.z : 0;
  if (rngRoll < 0.01) {
    return _spawnBomb(x, z) ? 'pickup_bomb' : null;
  }
  if (rngRoll < 0.03) {
    return _spawnMagnet(x, z) ? 'pickup_magnet' : null;
  }
  if (rngRoll < 0.07) {
    if (heroHpPct >= 0.5) return null;          // VS-style low-HP gate
    return _spawnChicken(x, z) ? 'pickup_chicken' : null;
  }
  return null;
}

// ── per-frame tick ─────────────────────────────────────────────────────────
/**
 * Per-frame tick: pickup detection, sparkle spin/bob, shrink-out on collect,
 * 30s auto-despawn. Bails immediately when not loaded. Reads hero pos +
 * magnet statMul each frame so soullink/character mods reshape radius live.
 *
 * @param {Object} state - GameState
 * @param {number} dt    - logic-delta seconds
 */
export function tickForestPickups(state, dt) {
  if (!_loaded) return;
  if (!state) return;
  _clock += dt;

  const heroAlive = state.hero && !state.gameOver;
  const hx = heroAlive ? state.hero.pos.x : 0;
  const hz = heroAlive ? state.hero.pos.z : 0;
  // Pickup radius scales with the same magnet stat the gem code uses
  // (`pickups.js`:201). No new "L3+ magnet_passive" gate — that exact passive
  // id isn't in PASSIVES; the existing soullink path is the canonical scaler.
  const magMul = (state.hero && state.hero.statMul && state.hero.statMul.magnet) || 1;
  const pickR = PICKUP_R * magMul;
  const pickR2 = pickR * pickR;

  // ── Bombs ──
  for (let i = 0; i < CAP_BOMBS; i++) {
    const phase = _bPhase[i];
    if (phase === CP_FREE) continue;
    _bPhaseT[i] += dt;
    const t = _bPhaseT[i];
    const cx = _bPosX[i], cz = _bPosZ[i];

    if (phase === CP_WAIT) {
      // Pickup detect.
      if (heroAlive) {
        const dx = hx - cx, dz = hz - cz;
        if (dx * dx + dz * dz <= pickR2) {
          _bPhase[i] = CP_COLLECTED;
          _bPhaseT[i] = 0;
          _fireBombEffect(cx, cz);
          _stampBomb(i, cx, cz, 0.001);
          _stampSparkle(_bombSparkleMesh, i, cx, cz, 0.001);
          continue;
        }
      }
      if (t >= LINGER_SEC) {
        _bPhase[i] = CP_DESPAWN;
        _bPhaseT[i] = 0;
        _hideBomb(i);
        continue;
      }
      // Repaint anim (sparkle spin + spark pulse).
      _stampBomb(i, cx, cz, 1.0);
      _stampSparkle(_bombSparkleMesh, i, cx, cz, 1.0);
    } else if (phase === CP_COLLECTED) {
      const k = Math.min(1, t / DESPAWN_SEC);
      const s = Math.max(0.001, 1.0 - k);
      _stampBomb(i, cx, cz, s);
      _stampSparkle(_bombSparkleMesh, i, cx, cz, s);
      if (t >= DESPAWN_SEC) {
        _bPhase[i] = CP_FREE;
        _bPhaseT[i] = 0;
        _hideBomb(i);
      }
    } else if (phase === CP_DESPAWN) {
      // Was set to DESPAWN by linger-out; just transition to FREE.
      _bPhase[i] = CP_FREE;
      _bPhaseT[i] = 0;
    }
  }

  // ── Magnets ──
  for (let i = 0; i < CAP_MAGNETS; i++) {
    const phase = _mPhase[i];
    if (phase === CP_FREE) continue;
    _mPhaseT[i] += dt;
    const t = _mPhaseT[i];
    const cx = _mPosX[i], cz = _mPosZ[i];

    if (phase === CP_WAIT) {
      if (heroAlive) {
        const dx = hx - cx, dz = hz - cz;
        if (dx * dx + dz * dz <= pickR2) {
          _mPhase[i] = CP_COLLECTED;
          _mPhaseT[i] = 0;
          _fireMagnetEffect(cx, cz);
          _stampMagnet(i, cx, cz, 0.001);
          _stampSparkle(_magSparkleMesh, i, cx, cz, 0.001);
          continue;
        }
      }
      if (t >= LINGER_SEC) {
        _mPhase[i] = CP_DESPAWN;
        _mPhaseT[i] = 0;
        _hideMagnet(i);
        continue;
      }
      _stampMagnet(i, cx, cz, 1.0);
      _stampSparkle(_magSparkleMesh, i, cx, cz, 1.0);
    } else if (phase === CP_COLLECTED) {
      const k = Math.min(1, t / DESPAWN_SEC);
      const s = Math.max(0.001, 1.0 - k);
      _stampMagnet(i, cx, cz, s);
      _stampSparkle(_magSparkleMesh, i, cx, cz, s);
      if (t >= DESPAWN_SEC) {
        _mPhase[i] = CP_FREE;
        _mPhaseT[i] = 0;
        _hideMagnet(i);
      }
    } else if (phase === CP_DESPAWN) {
      _mPhase[i] = CP_FREE;
      _mPhaseT[i] = 0;
    }
  }

  // ── Chickens ──
  for (let i = 0; i < CAP_CHICKENS; i++) {
    const phase = _cPhase[i];
    if (phase === CP_FREE) continue;
    _cPhaseT[i] += dt;
    const t = _cPhaseT[i];
    const cx = _cPosX[i], cz = _cPosZ[i];

    if (phase === CP_WAIT) {
      if (heroAlive) {
        const dx = hx - cx, dz = hz - cz;
        if (dx * dx + dz * dz <= pickR2) {
          _cPhase[i] = CP_COLLECTED;
          _cPhaseT[i] = 0;
          _fireChickenEffect(cx, cz);
          _stampChicken(i, cx, cz, 0.001);
          _stampSparkle(_chickSparkleMesh, i, cx, cz, 0.001);
          continue;
        }
      }
      if (t >= LINGER_SEC) {
        _cPhase[i] = CP_DESPAWN;
        _cPhaseT[i] = 0;
        _hideChicken(i);
        continue;
      }
      _stampChicken(i, cx, cz, 1.0);
      _stampSparkle(_chickSparkleMesh, i, cx, cz, 1.0);
    } else if (phase === CP_COLLECTED) {
      const k = Math.min(1, t / DESPAWN_SEC);
      const s = Math.max(0.001, 1.0 - k);
      _stampChicken(i, cx, cz, s);
      _stampSparkle(_chickSparkleMesh, i, cx, cz, s);
      if (t >= DESPAWN_SEC) {
        _cPhase[i] = CP_FREE;
        _cPhaseT[i] = 0;
        _hideChicken(i);
      }
    } else if (phase === CP_DESPAWN) {
      _cPhase[i] = CP_FREE;
      _cPhaseT[i] = 0;
    }
  }

  // Flash overlay fade — driven by logic dt (close enough; FLASH_FADE_SEC is
  // 0.2s and the overlay is "frame-noticed" rather than gameplay-critical).
  if (_flashTimer > 0) {
    _flashTimer -= dt;
    if (_flashTimer <= 0) _hideFlash();
    else if (_flashEl) {
      const k = _flashTimer / FLASH_FADE_SEC;
      _flashEl.style.opacity = String(0.85 * Math.max(0, k));
    }
  }
}

// ── public API ─────────────────────────────────────────────────────────────
/**
 * Build pre-pooled pickup meshes. Idempotent — gated on `_loaded` so a
 * double-load is a no-op.
 *
 * @param {THREE.Scene} scene
 * @param {Object} _state - GameState (unused at load; tick reads hero/gems/enemies).
 */
export function loadForestPickups(scene, _state) {
  if (_loaded) return;
  if (!scene) return;
  _scene = scene;
  _group = new THREE.Group();
  _group.name = '__forestPickups';

  _bPhase  = new Uint8Array(CAP_BOMBS);
  _bPhaseT = new Float32Array(CAP_BOMBS);
  _bPosX   = new Float32Array(CAP_BOMBS);
  _bPosZ   = new Float32Array(CAP_BOMBS);

  _mPhase  = new Uint8Array(CAP_MAGNETS);
  _mPhaseT = new Float32Array(CAP_MAGNETS);
  _mPosX   = new Float32Array(CAP_MAGNETS);
  _mPosZ   = new Float32Array(CAP_MAGNETS);

  _cPhase  = new Uint8Array(CAP_CHICKENS);
  _cPhaseT = new Float32Array(CAP_CHICKENS);
  _cPosX   = new Float32Array(CAP_CHICKENS);
  _cPosZ   = new Float32Array(CAP_CHICKENS);

  _buildBombMeshes();
  _buildMagnetMeshes();
  _buildChickenMeshes();
  _bombSparkleMesh  = _buildSparkleMesh(CAP_BOMBS);
  _magSparkleMesh   = _buildSparkleMesh(CAP_MAGNETS);
  _chickSparkleMesh = _buildSparkleMesh(CAP_CHICKENS);

  _group.add(_bombBodyMesh);
  _group.add(_bombFuseMesh);
  _group.add(_bombSparkMesh);
  _group.add(_bombSparkleMesh);
  _group.add(_magProngLMesh);
  _group.add(_magProngRMesh);
  _group.add(_magTopMesh);
  _group.add(_magSparkleMesh);
  _group.add(_chickBodyMesh);
  _group.add(_chickLegLMesh);
  _group.add(_chickLegRMesh);
  _group.add(_chickSparkleMesh);

  _zeroAllMatrices();
  scene.add(_group);
  _clock = 0;
  _loaded = true;
}

/**
 * Tear down all pickup meshes + pool state + flash overlay. Idempotent — safe
 * to call when not loaded. Mirrors disposeForestChests / disposeForestReaper.
 *
 * @param {THREE.Scene} scene
 */
export function disposeForestPickups(scene) {
  _disposeFlashEl();
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

  _bombBodyMesh = _bombFuseMesh = _bombSparkMesh = null;
  _magProngLMesh = _magProngRMesh = _magTopMesh = null;
  _chickBodyMesh = _chickLegLMesh = _chickLegRMesh = null;
  _bombSparkleMesh = _magSparkleMesh = _chickSparkleMesh = null;
  _bPhase = _bPhaseT = _bPosX = _bPosZ = null;
  _mPhase = _mPhaseT = _mPosX = _mPosZ = null;
  _cPhase = _cPhaseT = _cPosX = _cPosZ = null;
  _scene = null;
  _clock = 0;
  _loaded = false;
}
