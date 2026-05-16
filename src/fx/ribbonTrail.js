/**
 * Velocity Veil — Twilight fountain speed-buff ribbon trail FX
 * (Punch List #7, 2026-05-16).
 *
 * When the player drinks a Twilight Fountain, a 4-second 1.75× movement-speed
 * buff fires (publish-and-read via `state.run.fountainSpeedBuff`, set by
 * `src/twilightFountains.js`). This module paints that buff:
 *
 *   - **Splash**: 8-12 additive billboards bursting outward at the drink
 *     moment (one-shot, lifetime ~0.5s, slot 6 → slot 2 colour drift).
 *   - **Ribbon trail**: a stream of additive segments emitted behind the
 *     hero at a fixed cadence for exactly the buff's 4-second window; each
 *     segment fades over its own short tail-life (~0.45s) so the trail
 *     reads as a "fountain spray" tapering behind the runner.
 *
 * Both auto-dispose when the buff expires — the ribbon stops emitting and
 * every live segment naturally fades inside its own tail-life. The veil
 * descriptor captures `expiresAt` at spawn time and never re-reads
 * `state.run.fountainSpeedBuff` (the fountains module nulls that flag at
 * t=4; reading it in tick would crash on the very frame we need to stop).
 *
 * Pool pattern: mirrors `src/fx/dissolveBurst.js`.
 *   - One module-scoped InstancedMesh (POOL_CAP=128 segments).
 *   - Pre-allocated slot table, round-robin write cursor, hide-matrix sentinel.
 *   - ALL math scratch (Vector3, Matrix4, Color) is module-scoped — ZERO
 *     `new THREE.X()` calls inside `spawnVelocityVeil()` or
 *     `tickVelocityVeils()`. (Audit: `grep -nE "new THREE\." src/fx/ribbonTrail.js`
 *     should show news only inside `_initInstancedMesh()` and module
 *     top-level initializers.)
 *
 * Concurrent veils: capped at **4** (`MAX_VEILS`). The player can re-drink
 * another fountain mid-buff; the descriptor ring overwrites the oldest
 * slot rather than growing unbounded. Each veil emits independently so
 * stacked buffs visibly stack their ribbons.
 *
 * Palette (LOCKED — docs/TWILIGHT_VISUAL_STYLE.md slots 2 + 6):
 *   slot 2 #2d1547 — bruised purple mid (cool / tail tint)
 *   slot 6 #a98030 — gold dim          (hot  / head tint)
 *
 * Palette physics note: under additive blend, slot 2 (`#2d1547`) contributes
 * only ~10% brightness, so the trail will read as "mostly gold with a
 * subtle purple bruise on the trailing edge." This is intentional per the
 * brief — DO NOT substitute slot 8 (cyan aura) which is reserved for the
 * existing player ring on the same buff.
 *
 * Public API:
 *   spawnVelocityVeil(scene, statePtr)        — one-shot at drink moment;
 *                                               returns descriptor handle
 *                                               (mostly for tests) or null
 *                                               on missing scene/state or
 *                                               missing fountainSpeedBuff.
 *   tickVelocityVeils(dt)                     — per-frame integrator;
 *                                               emit ribbon segments + fade
 *                                               all live slots.
 *   disposeAllVelocityVeils(scene)            — hard cleanup on run/stage
 *                                               teardown; hides every slot
 *                                               and drops descriptors.
 *   _debugActiveVeilCount()                   — testing hook.
 *   _debugActiveSlotCount()                   — testing hook.
 *   _debugPoolCap()                           — testing hook.
 */
import * as THREE from 'three';
import { tex } from '../particleTextures.js';
import { BLOOM_LAYER } from '../postfx.js';
import { FLAT_X_QUAT } from '../fxLayers.js';

// ─── Palette (LOCKED, docs/TWILIGHT_VISUAL_STYLE.md slots 2 + 6) ─────────────
const COLOR_HOT  = 0xa98030; // slot 6 — gold dim (head of trail, splash spawn)
const COLOR_COOL = 0x2d1547; // slot 2 — bruised purple mid (tail tint)

// ─── Tunables ───────────────────────────────────────────────────────────────
const MAX_VEILS         = 4;       // concurrent buffs (player re-drink stacking cap)
const POOL_CAP          = 128;     // total InstancedMesh slots (4 veils × ~20 live + headroom)
const EMIT_INTERVAL     = 0.05;    // seconds between ribbon segment emissions per veil
const SEGMENT_LIFE      = 0.45;    // seconds — single segment fade envelope
const SEGMENT_SIZE      = 0.55;    // world units — base billboard side
const SEGMENT_Y         = 0.45;    // world Y — knee-height trail
const SPLASH_COUNT_MIN  = 8;       // splash particles per drink (low end)
const SPLASH_COUNT_RANGE= 5;       // splash particle range (8..12 inclusive)
const SPLASH_LIFE       = 0.5;     // seconds — splash particle envelope
const SPLASH_RADIUS_END = 1.6;     // world units — splash outward distance
const SPLASH_Y          = 0.8;     // world Y — chest-height splash
const SPLASH_Y_RISE     = 0.25;    // world units — vertical rise over SPLASH_LIFE
const HIDE_Y            = -1000;   // off-screen sentinel for unused slots

// Slot-kind tags. Both kinds share the same instance pool but integrate
// slightly differently in tick (ribbon segments stay put + fade; splash
// segments drift outward + rise).
const KIND_RIBBON = 1;
const KIND_SPLASH = 2;

// ─── Module state ────────────────────────────────────────────────────────────
let _scene = null;
let _inst = null;
let _colAttr = null;

// Slot table — pre-allocated, plain numeric props (no nested objects, no
// per-slot allocations at runtime).
const _slots = new Array(POOL_CAP);
for (let i = 0; i < POOL_CAP; i++) {
  _slots[i] = {
    used: false,
    kind: 0,          // KIND_RIBBON | KIND_SPLASH
    x: 0, y: 0, z: 0, // current world position
    vx: 0, vz: 0,     // velocity (splash only; ribbon is static)
    life: SEGMENT_LIFE,
    age: 0,
    sizeBase: SEGMENT_SIZE,
  };
}

// Veil descriptor ring — captures the buff snapshot at spawn time so the
// tick loop is independent of state.run.fountainSpeedBuff (which the
// fountains module nulls at expiry).
const _veils = new Array(MAX_VEILS);
for (let i = 0; i < MAX_VEILS; i++) {
  _veils[i] = {
    used: false,
    expiresAt: 0,    // captured at spawn — game-time when ribbon stops emitting
    lastEmitAt: 0,   // game-time of last segment emission
    statePtr: null,  // borrowed reference for hero.pos + time.game lookup
  };
}
let _veilWriteCursor = 0;

// Round-robin slot write cursor — amortised O(1) under typical occupancy.
let _slotWriteCursor = 0;

// Reusable math scratch — ALL composes/setColor calls reuse these.
// ZERO allocation in spawn/tick hot path.
const _mat4    = new THREE.Matrix4();
const _pos     = new THREE.Vector3();
const _scl     = new THREE.Vector3();
const _colTmp  = new THREE.Color();
const _hideMat = new THREE.Matrix4();
const _hidePos = new THREE.Vector3(0, HIDE_Y, 0);
const _hideScl = new THREE.Vector3(0, 0, 0);
_hideMat.compose(_hidePos, FLAT_X_QUAT, _hideScl);

// Pre-extracted palette RGB (manual hex lerp avoids THREE.Color.lerp alloc).
const _HOT_R  = (COLOR_HOT  >> 16) & 0xff;
const _HOT_G  = (COLOR_HOT  >>  8) & 0xff;
const _HOT_B  =  COLOR_HOT         & 0xff;
const _COOL_R = (COLOR_COOL >> 16) & 0xff;
const _COOL_G = (COLOR_COOL >>  8) & 0xff;
const _COOL_B =  COLOR_COOL        & 0xff;

// ─── Internal — InstancedMesh init (lazy, on first spawn) ────────────────────
/**
 * Build the shared InstancedMesh on first use. We can't init at module load
 * because the scene isn't ready then; we can't init in main.js boot without
 * adding another wiring import. Lazy-init on first spawn matches the
 * `dissolveBurst.js` pattern except that one is wired explicitly because
 * deaths fire on the very first frame — fountain drinks are gated behind
 * the player reaching a fountain, so lazy is safe here.
 */
function _initInstancedMesh(scene) {
  if (_inst) return;
  _scene = scene;

  // 1u × 1u plane — per-instance scale provides actual size.
  const geo = new THREE.PlaneGeometry(1, 1);
  const mat = new THREE.MeshBasicMaterial({
    map: tex('glowWhite') || null,
    color: 0xffffff,                  // tint via per-instance color
    transparent: true,
    opacity: 1.0,
    blending: THREE.AdditiveBlending, // hard contract: additive
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  _inst = new THREE.InstancedMesh(geo, mat, POOL_CAP);
  _inst.count = POOL_CAP;
  _inst.frustumCulled = false;
  _inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _inst.layers.enable(BLOOM_LAYER);   // hard contract: bloom-tagged

  const colArr = new Float32Array(POOL_CAP * 3);
  _colAttr = new THREE.InstancedBufferAttribute(colArr, 3);
  _colAttr.setUsage(THREE.DynamicDrawUsage);
  _inst.instanceColor = _colAttr;

  for (let i = 0; i < POOL_CAP; i++) {
    _inst.setMatrixAt(i, _hideMat);
    _colTmp.setHex(0xffffff);
    _inst.setColorAt(i, _colTmp);
  }
  _inst.instanceMatrix.needsUpdate = true;
  if (_inst.instanceColor) _inst.instanceColor.needsUpdate = true;
  scene.add(_inst);
}

// ─── Internal — claim & write one slot (ZERO alloc) ──────────────────────────
function _claimSlot(kind, x, y, z, vx, vz, life, sizeBase) {
  let scanned = 0;
  while (scanned < POOL_CAP) {
    const idx = _slotWriteCursor;
    _slotWriteCursor = (_slotWriteCursor + 1) % POOL_CAP;
    scanned++;
    const s = _slots[idx];
    if (s.used) continue;
    s.used = true;
    s.kind = kind;
    s.x = x; s.y = y; s.z = z;
    s.vx = vx; s.vz = vz;
    s.life = life;
    s.age = 0;
    s.sizeBase = sizeBase;
    return idx;
  }
  return -1; // pool saturated — silent drop
}

// ─── Public — spawn ─────────────────────────────────────────────────────────
/**
 * Spawn one Velocity Veil at the hero's current position. Reads the buff
 * snapshot from `statePtr.run.fountainSpeedBuff.expiresAt` ONCE (at spawn)
 * and stores it on the descriptor; tick never re-reads the global flag.
 *
 * - Fires the splash particles immediately (one-shot, 8-12 instances).
 * - Registers a veil descriptor that emits ribbon segments each tick until
 *   `statePtr.time.game > descriptor.expiresAt`.
 *
 * Returns the descriptor (mostly for tests) or null if scene/state/buff
 * are missing — a partial spawn reads worse than nothing.
 */
export function spawnVelocityVeil(scene, statePtr) {
  if (!scene || !statePtr) return null;
  const run = statePtr.run;
  const buff = run && run.fountainSpeedBuff;
  if (!buff || typeof buff.expiresAt !== 'number') return null;
  const hero = statePtr.hero;
  const heroPos = hero && hero.pos;
  if (!heroPos) return null;

  _initInstancedMesh(scene);

  // ── Descriptor ring write (overwrites oldest if full) ───────────────────
  const dIdx = _veilWriteCursor;
  _veilWriteCursor = (_veilWriteCursor + 1) % MAX_VEILS;
  const d = _veils[dIdx];
  d.used = true;
  d.expiresAt = buff.expiresAt;   // CAPTURED — never re-read from state
  d.lastEmitAt = (statePtr.time && statePtr.time.game) || 0;
  d.statePtr = statePtr;

  // ── Splash burst — 8 to 12 particles, fan outward, gold→purple drift ───
  const splashCount = SPLASH_COUNT_MIN + ((Math.random() * SPLASH_COUNT_RANGE) | 0);
  const baseX = heroPos.x || 0;
  const baseZ = heroPos.z || 0;
  for (let i = 0; i < splashCount; i++) {
    const ang = (i / splashCount) * Math.PI * 2;
    const speed = SPLASH_RADIUS_END / SPLASH_LIFE;
    _claimSlot(
      KIND_SPLASH,
      baseX, SPLASH_Y, baseZ,
      Math.cos(ang) * speed,
      Math.sin(ang) * speed,
      SPLASH_LIFE,
      SEGMENT_SIZE * 0.85,
    );
  }

  return d;
}

// ─── Public — tick ──────────────────────────────────────────────────────────
/**
 * Per-frame integrator. Two passes:
 *   1) Veil descriptors — emit ribbon segments at hero.pos every
 *      EMIT_INTERVAL seconds while game-time < captured expiresAt.
 *   2) Slot integrator — advance age, integrate position (splash drifts,
 *      ribbon holds), fade color via hot→cool lerp × alpha envelope,
 *      collapse to hide-matrix on death.
 *
 * Auto-dispose contract: ribbon emission stops the frame
 * `statePtr.time.game > d.expiresAt`. Live ribbon segments continue their
 * own ~0.45s tail fade to dead. Net effect: buff ends at t=4.0; last
 * ribbon segments disappear at t≈4.45. Splash particles all die by t=0.5.
 *
 * Note: we read `statePtr.time.game` from each descriptor's captured
 * `statePtr` (NOT `state.run.fountainSpeedBuff`). The fountains module
 * nulls that buff flag at the same expiry tick — reading it here would
 * crash exactly when we need to stop emitting.
 */
export function tickVelocityVeils(dt) {
  if (!_inst) return;

  // ── Pass 1: emit ribbon segments per live veil ──────────────────────────
  for (let i = 0; i < MAX_VEILS; i++) {
    const d = _veils[i];
    if (!d.used) continue;
    const sp = d.statePtr;
    const tNow = (sp && sp.time && sp.time.game) || 0;
    if (tNow > d.expiresAt) {
      // Veil duration elapsed — stop emitting. Don't touch live segments;
      // they'll finish their own tail-life inside Pass 2 and naturally
      // collapse to hidden when their age hits SEGMENT_LIFE.
      d.used = false;
      d.statePtr = null;
      continue;
    }
    // Emit at fixed cadence while active.
    const hero = sp.hero;
    const heroPos = hero && hero.pos;
    if (!heroPos) continue;
    while (tNow - d.lastEmitAt >= EMIT_INTERVAL) {
      d.lastEmitAt += EMIT_INTERVAL;
      _claimSlot(
        KIND_RIBBON,
        heroPos.x || 0, SEGMENT_Y, heroPos.z || 0,
        0, 0,
        SEGMENT_LIFE,
        SEGMENT_SIZE,
      );
    }
  }

  // ── Pass 2: integrate every live slot ───────────────────────────────────
  let anyChange = false;
  for (let i = 0; i < POOL_CAP; i++) {
    const s = _slots[i];
    if (!s.used) continue;
    s.age += dt;
    if (s.age >= s.life) {
      s.used = false;
      _inst.setMatrixAt(i, _hideMat);
      anyChange = true;
      continue;
    }

    // Position integration — splash drifts outward + rises, ribbon static.
    if (s.kind === KIND_SPLASH) {
      s.x += s.vx * dt;
      s.z += s.vz * dt;
      s.y = SPLASH_Y + SPLASH_Y_RISE * (s.age / s.life);
    }
    // (ribbon segments hold their spawn position — the "trail" effect comes
    // from the hero MOVING away while ribbons stay where they were emitted)

    const k = s.age / s.life;
    // Opacity envelope — punchy attack, ease-out tail.
    //   0.00 - 0.12 : 0 → 1 linear (pop)
    //   0.12 - 1.00 : 1 → 0 cubic ease-out (fade)
    let alpha;
    if (k < 0.12) {
      alpha = k / 0.12;
    } else {
      const tailK = (k - 0.12) / 0.88;
      const inv = 1 - tailK;
      alpha = inv * inv * inv;
    }
    // Scale envelope — small grow while fading sells the dissipation.
    const scale = s.sizeBase * (0.7 + k * 0.6) * (alpha > 0 ? 1.0 : 0.0);

    // Color: hot → cool over life, multiplied by alpha (additive blend +
    // alpha-pre-multiply = natural fade-to-black without per-instance opacity).
    const rR = (_HOT_R + (_COOL_R - _HOT_R) * k) / 255 * alpha;
    const gG = (_HOT_G + (_COOL_G - _HOT_G) * k) / 255 * alpha;
    const bB = (_HOT_B + (_COOL_B - _HOT_B) * k) / 255 * alpha;
    _colTmp.setRGB(rR, gG, bB);
    _inst.setColorAt(i, _colTmp);

    _pos.set(s.x, s.y, s.z);
    _scl.set(scale, scale, scale);
    _mat4.compose(_pos, FLAT_X_QUAT, _scl);
    _inst.setMatrixAt(i, _mat4);
    anyChange = true;
  }

  if (anyChange) {
    _inst.instanceMatrix.needsUpdate = true;
    if (_inst.instanceColor) _inst.instanceColor.needsUpdate = true;
  }
}

// ─── Public — dispose ───────────────────────────────────────────────────────
/**
 * Hard cleanup on run/stage teardown. Hides every live slot and drops
 * every veil descriptor. The InstancedMesh + geometry/material themselves
 * are retained (reused across runs, same shape as `dissolveBurst.js` and
 * the fx.js kill ring init pattern).
 */
export function disposeAllVelocityVeils(/* scene */) {
  if (!_inst) return;
  for (let i = 0; i < POOL_CAP; i++) {
    const s = _slots[i];
    if (!s.used) continue;
    s.used = false;
    _inst.setMatrixAt(i, _hideMat);
  }
  _inst.instanceMatrix.needsUpdate = true;
  for (let i = 0; i < MAX_VEILS; i++) {
    _veils[i].used = false;
    _veils[i].statePtr = null;
  }
}

// ─── Debug / test hooks ─────────────────────────────────────────────────────
export function _debugActiveVeilCount() {
  let n = 0;
  for (let i = 0; i < MAX_VEILS; i++) if (_veils[i].used) n++;
  return n;
}
export function _debugActiveSlotCount() {
  let n = 0;
  for (let i = 0; i < POOL_CAP; i++) if (_slots[i].used) n++;
  return n;
}
export function _debugPoolCap() { return POOL_CAP; }
export function _debugMaxVeils() { return MAX_VEILS; }
