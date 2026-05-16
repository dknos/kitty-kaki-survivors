/**
 * Dissolve-to-Gold death FX — Punch List #3 (2026-05-16).
 *
 * Pre-pooled, zero-allocation death-burst module. Fires on every enemy death
 * (called from `killEnemy()` in src/enemies.js). Hundreds of deaths per run
 * × 24 instances per burst is the single highest perf risk on the punch list,
 * so this module follows the *bossTelegraphs mote pool* pattern (one
 * InstancedMesh, ring-buffer slot table, dead slots collapse to a precomputed
 * hide matrix) — NOT the evolveBurst.js pattern (which alloc-per-spawn).
 *
 * Brief constraints met here:
 *   - 24 instances/burst MAX, palette pulled from the active stage's locked
 *     8-color table (see docs/{FOREST,TWILIGHT,CINDER,VOID}_VISUAL_STYLE.md).
 *   - Pool cap 256 = ~10 concurrent bursts × 24 = safe upper bound. If pool
 *     is full when spawn fires we drop the burst silently (better than
 *     stutter or partial pop).
 *   - ZERO `new THREE.X()` calls inside `spawnDissolveBurst()` or
 *     `tickDissolveBursts()`. Every Vector3/Matrix4/Color/Quaternion is
 *     module-scoped and reused. Per-slot state is plain numeric properties
 *     on a pre-allocated slot object — no object literals at runtime.
 *   - Kill-switch: `state.run.lowFx` is read at spawn entry. When true, the
 *     particle burst is skipped entirely (the death itself still happens,
 *     the existing kill ring + blob-shadow scale-down still fire). Lets a
 *     player or remote console disable the FX wholesale without restart.
 *   - ADDITIVE blend + BLOOM_LAYER tagged so the existing bloom composer
 *     picks the burst up without any postfx change.
 *   - Reuses `tex('glowWhite')` — NO new textures.
 *   - World-space billboards (oriented flat on XZ — same FLAT_X_QUAT as
 *     evolveBurst / fx.js kill ring). Reads as a flat "gold dust" burst
 *     under the iso camera.
 *
 * Dissolve note. The brief asked for a noise-driven alpha-cutout on the
 * enemy mesh itself. After grepping the codebase there is no simplex/snoise
 * vertex shader to reuse (`injectVertAnim` in src/assets.js is sin-wave
 * displacement, not noise), AND enemy materials are shared across pooled
 * clones (cloneCached → upgradeMaterials hits the same mat.uuid), so
 * mutating opacity on the dying enemy would bleed onto living siblings.
 * Safe path: the enemy mesh is already hidden (`enemy.mesh.visible = false`
 * at the top of killEnemy), and the dissolve effect is delivered entirely
 * by this sprite burst sitting where the enemy was. The blob-shadow
 * scale-down (handled by blobShadows.js when `e.alive` flips false) covers
 * the missing "fade-out" cue for free. Net visual: enemy snaps out, gold
 * dust radiates outward and fades over 0.6s.
 *
 * Public API:
 *   initDissolveBurst(scene)              — boot wiring; idempotent.
 *   setDissolveBurstStateRef(state)       — wire run.lowFx access.
 *   spawnDissolveBurst(pos, stageId)      — fire-and-forget; safe if not init.
 *   tickDissolveBursts(dt)                — per-frame integrator.
 *   disposeAllDissolveBursts(scene)       — hard cleanup on run teardown.
 *   _debugActiveSlotCount()               — testing/perf-probe hook.
 *
 * Perf measurement recipe (target: < 8% frametime regression):
 *   1. Launch the game (`npm run dev` or current launcher).
 *   2. Hit F3 — perfHUD overlay shows tick block timings.
 *   3. Pick Cinder stage (highest enemy density per minute) and run to
 *      wave ~15 (~minute 12) — hundreds of trash deaths per second.
 *   4. Note avg frametime + the `evolveBursts` / `dissolveBursts` ticks.
 *   5. Toggle `state.run.lowFx = true` from devtools, observe delta.
 *   6. Compare before/after this commit — regression budget is 8%.
 */
import * as THREE from 'three';
import { tex } from '../particleTextures.js';
import { BLOOM_LAYER } from '../postfx.js';
import { FLAT_X_QUAT } from '../fxLayers.js';

// ─── Palette table ──────────────────────────────────────────────────────────
// Per-stage death-burst tint (the "to-gold" reading). Slot numbers reference
// docs/<STAGE>_VISUAL_STYLE.md. Cross-check via
//   grep -nE "0x[0-9a-f]{6}" src/fx/dissolveBurst.js
// against those tables before merging — palette drift is the #1 audit risk.
//
// Two-tone per stage: `hot` is the bright pinpoint at spawn (peak frame
// flash), `cool` is the trailing/late-life tint as motes expand outward.
// We interpolate from hot → cool over a slot's lifetime so the burst reads
// as a flash settling into colored dust.
const PALETTE = {
  forest: {
    hot:  0xffd86b, // slot 7 — amber detonation (single-frame peak in style)
    cool: 0x7df0c4, // slot 4 — bio-glow primary mint (forest's signature glow)
  },
  twilight: {
    hot:  0xffcd5b, // slot 7 — fountain glow peak
    cool: 0xa98030, // slot 6 — gold dim (settles into warm dusk gold)
  },
  cinder: {
    hot:  0xffd24a, // slot 7 — ballista glow active (warm gold)
    cool: 0xff5522, // slot 4 — ember orange hot (lingering ember tint)
  },
  void: {
    hot:  0xffffff, // slot 7 — teleport flash (white)
    cool: 0x7fffff, // slot 6 — portal cyan active
  },
};
function _paletteFor(stageId) {
  return PALETTE[stageId] || PALETTE.forest;
}

// ─── Tunables ───────────────────────────────────────────────────────────────
const BURST_COUNT  = 24;        // instances per death (brief cap)
const POOL_CAP     = 256;       // total InstancedMesh slots — ~10 concurrent bursts
const LIFE         = 0.6;       // seconds — full burst envelope (brief: 0.6s)
const RADIUS_END   = 1.4;       // world units — outer radius at end of life
const SIZE         = 0.55;      // world units — base quad side at peak scale
const SPAWN_Y      = 0.9;       // world Y — chest-height for the death sparkle
const Y_RISE       = 0.45;      // world units — vertical drift over LIFE
const HIDE_Y       = -1000;     // off-screen sentinel for unused slots

// ─── Module state (all module-scoped to avoid runtime allocation) ───────────
let _scene = null;
let _stateRef = null;
let _inst = null;
let _colAttr = null;

// Slot table — pre-allocated, plain numeric props (no nested objects).
// `used=false` means the slot collapses to the hide matrix on the next tick.
const _slots = new Array(POOL_CAP);
for (let i = 0; i < POOL_CAP; i++) {
  _slots[i] = {
    used: false,
    x: 0, y: 0, z: 0,             // current world position
    vx: 0, vz: 0,                 // horizontal velocity (radial outward)
    ang: 0,                        // launch angle (cached, not strictly needed in tick)
    life: LIFE, age: 0,
    hot:  0xffffff,                // per-slot hot color
    cool: 0xffffff,                // per-slot cool color
  };
}

// Round-robin write cursor so we don't always scan from 0; for a full pool
// this keeps spawn O(1) amortized instead of O(POOL_CAP) per attempt.
let _writeCursor = 0;

// Reusable math scratch. ALL composes/setColor calls reuse these — no
// allocations inside spawn or tick.
const _mat4    = new THREE.Matrix4();
const _pos     = new THREE.Vector3();
const _scl     = new THREE.Vector3();
const _colTmp  = new THREE.Color();
const _hideMat = new THREE.Matrix4();
const _hidePos = new THREE.Vector3(0, HIDE_Y, 0);
const _hideScl = new THREE.Vector3(0, 0, 0);
_hideMat.compose(_hidePos, FLAT_X_QUAT, _hideScl);

// ─── Init / teardown ────────────────────────────────────────────────────────
export function initDissolveBurst(scene) {
  if (_inst) return;
  _scene = scene;

  // Plane geometry — 1u × 1u, per-instance scale provides actual size.
  // Pre-rotated baked via FLAT_X_QUAT in the per-slot compose; geometry
  // stays axis-aligned so the same instance matrix can hide a slot by
  // collapsing scale to zero.
  const geo = new THREE.PlaneGeometry(1, 1);
  const mat = new THREE.MeshBasicMaterial({
    map: tex('glowWhite') || null,
    color: 0xffffff,
    transparent: true,
    opacity: 1.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  _inst = new THREE.InstancedMesh(geo, mat, POOL_CAP);
  _inst.count = POOL_CAP;
  _inst.frustumCulled = false;
  _inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _inst.layers.enable(BLOOM_LAYER);

  // Per-instance color so each death can carry its stage palette without
  // a per-stage material variant. Cyan/gold/mint coexist in one draw call.
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

export function setDissolveBurstStateRef(s) { _stateRef = s || null; }

// ─── Spawn — ZERO allocation path ───────────────────────────────────────────
/**
 * Fire a 24-instance gold-dust burst at (pos.x, pos.z), tinted by stageId.
 * Safe to call before init (no-op). Safe to call with missing position
 * (no-op). Kill-switch: `state.run.lowFx === true` skips the burst entirely.
 * Returns the count of slots actually written (0 on drop / kill-switch / no
 * init).
 */
export function spawnDissolveBurst(pos, stageId) {
  if (!_inst || !pos) return 0;
  // Kill-switch — short-circuit on user/console toggle. Read once per spawn.
  if (_stateRef && _stateRef.run && _stateRef.run.lowFx === true) return 0;

  const palette = _paletteFor(stageId);
  const hotHex  = palette.hot;
  const coolHex = palette.cool;
  const baseX   = pos.x || 0;
  const baseZ   = pos.z || 0;

  // Try to claim BURST_COUNT free slots via round-robin from _writeCursor.
  // Single scan worst-case = POOL_CAP iterations; typical case = inline hit.
  let written = 0;
  let scanned = 0;
  while (written < BURST_COUNT && scanned < POOL_CAP) {
    const idx = _writeCursor;
    _writeCursor = (_writeCursor + 1) % POOL_CAP;
    scanned++;

    const s = _slots[idx];
    if (s.used) continue;
    s.used = true;
    s.x = baseX;
    s.y = SPAWN_Y;
    s.z = baseZ;
    // Even radial fan — angle = written * (2π / BURST_COUNT) so the visual
    // is symmetric regardless of which slot indices we landed on.
    const ang = (written / BURST_COUNT) * Math.PI * 2;
    s.ang = ang;
    s.vx = Math.cos(ang) * (RADIUS_END / LIFE);
    s.vz = Math.sin(ang) * (RADIUS_END / LIFE);
    s.life = LIFE;
    s.age = 0;
    s.hot  = hotHex;
    s.cool = coolHex;
    written++;
  }
  // If we wrapped a full lap without finding 24 slots, pool was saturated —
  // partial burst is acceptable (drop the missing instances silently). No
  // resize, no allocation, no crash. The write cursor naturally advanced
  // past the last claimed index so the next spawn picks up where this one
  // stopped scanning.
  return written;
}

// ─── Tick — ZERO allocation path ────────────────────────────────────────────
export function tickDissolveBursts(dt) {
  if (!_inst) return;
  let anyChange = false;
  for (let i = 0; i < POOL_CAP; i++) {
    const s = _slots[i];
    if (!s.used) continue;
    s.age += dt;
    if (s.age >= s.life) {
      s.used = false;
      _inst.setMatrixAt(i, _hideMat);
      // Color stays whatever it was; hide-matrix scale=0 means it's never
      // sampled. No need to reset the color buffer.
      anyChange = true;
      continue;
    }
    // Integrate position (linear outward + linear vertical rise).
    s.x += s.vx * dt;
    s.z += s.vz * dt;
    s.y = SPAWN_Y + (Y_RISE * (s.age / s.life));

    const k = s.age / s.life;
    // Opacity envelope: punchy attack, long fade.
    //   0.00 - 0.10 : 0 → 1   (peak flash window)
    //   0.10 - 1.00 : 1 → 0   (cubic ease-out)
    let alpha;
    if (k < 0.10) {
      alpha = k / 0.10;
    } else {
      const tailK = (k - 0.10) / 0.90;
      const inv = 1 - tailK;
      alpha = inv * inv * inv; // ease-out cubic
    }
    // Scale envelope: grow 0.5 → 1.2 → fade. Pre-peak inflation pops the
    // sparkle, then small grow-while-fading sells the dust drift.
    const scale = SIZE * (0.5 + k * 0.9) * (alpha > 0 ? 1.0 : 0.0);

    // Color: lerp hot → cool over life. Multiply by alpha so the additive
    // pass naturally fades to black (no per-instance opacity needed —
    // additive black contributes zero, same effect as alpha=0).
    // Manual hex lerp (no THREE.Color.lerp — that would alloc on read).
    const hr = (s.hot  >> 16) & 0xff, hg = (s.hot  >> 8) & 0xff, hb = s.hot  & 0xff;
    const cr = (s.cool >> 16) & 0xff, cg = (s.cool >> 8) & 0xff, cb = s.cool & 0xff;
    // Linear RGB lerp in 0-1 space; final multiply by alpha bakes the fade
    // into the additive contribution.
    const rR = (hr + (cr - hr) * k) / 255 * alpha;
    const gG = (hg + (cg - hg) * k) / 255 * alpha;
    const bB = (hb + (cb - hb) * k) / 255 * alpha;
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

// ─── Dispose / reset ────────────────────────────────────────────────────────
/**
 * Hard cleanup — called on run/stage teardown. Drops every live slot back
 * to hidden; doesn't destroy the InstancedMesh (it's reused for the next
 * run, same as fx.js kill rings). If you want a full geo/mat dispose on
 * shutdown, that's _destroyDissolveBurst (private; not currently wired —
 * the game never tears down the renderer until tab close).
 */
export function disposeAllDissolveBursts(/* scene */) {
  if (!_inst) return;
  for (let i = 0; i < POOL_CAP; i++) {
    const s = _slots[i];
    if (!s.used) continue;
    s.used = false;
    _inst.setMatrixAt(i, _hideMat);
  }
  _inst.instanceMatrix.needsUpdate = true;
}

// ─── Debug / test hooks ─────────────────────────────────────────────────────
export function _debugActiveSlotCount() {
  let n = 0;
  for (let i = 0; i < POOL_CAP; i++) if (_slots[i].used) n++;
  return n;
}
export function _debugPoolCap() { return POOL_CAP; }
