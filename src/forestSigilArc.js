/**
 * Forest Sigil Arc — visual feedback for prestige-currency rewards (P1G,
 * 2026-05-17).
 *
 * Sigils already drop on mini-boss / final-boss / room-boss kills via
 * grantSigils() in src/enemies.js (cohort 14 wiring). The currency tick was
 * INVISIBLE prior to this module — players had no idea they earned anything
 * until they reached the menu screen. This module:
 *
 *   1. Polls meta.lifetime.sigilsEarned each tick. The lifetime counter is
 *      monotonic (grantSigils only ever increments it; spend on shop tree
 *      touches meta.sigils, not the lifetime counter — see grantSigils() in
 *      src/meta.js). meta.sigils is non-monotonic (drained by casino /
 *      SHOP_TREE) and therefore unsuitable for "did the player just earn?"
 *      diff polling. We cache the last-seen value in
 *      state.run._sigilsLastSeen (init in src/state.js so the first run-tick
 *      doesn't false-fire on stale lifetime balance from prior runs).
 *
 *   2. On a positive diff, spawns up to MAX_ARC concurrent gold star arcs.
 *      Start position scans state.enemies.active for the most recently
 *      killed mini/final/room-boss (alive === false and isMiniBoss /
 *      isFinalBoss / _isRoomBoss). The pool dedupes dead enemies on the
 *      next spawnEnemy() call, so this scan window is one frame at worst.
 *      Falls back to hero pos when no dead boss is found (defensive — the
 *      kill might happen in a tick where the pool already recycled it, or
 *      a future caller might grant sigils outside the kill loop).
 *
 *   3. Animates a parabolic arc from the kill pos to a HUD-anchor projected
 *      back into world space, plus 5 alpha-fading gold trail dots in its
 *      wake. Star travels for ARC_SEC seconds with a sin(πt) Y bump and
 *      linear XZ lerp. On arrival, plays sfx.pickup and bumps the HUD
 *      counter (a separate DOM widget owned by this module).
 *
 *   4. Owns a small "Sigils: N" DOM widget. forestHud already owns top-
 *      right "Kills: N" (top: 12px, right: 14px). We avoid collision by
 *      positioning our counter just below: top: 36px, right: 14px. Reuses
 *      the same monospace font + slot-6 gold color used by forestPickups
 *      sparkle rings for visual coherence.
 *
 * ── Pre-pool ────────────────────────────────────────────────────────────────
 *   MAX_ARC = 8 concurrent stars
 *   TRAIL_DOTS_PER_STAR = 6 (oldest fades out as the star moves)
 *
 * Two pre-pooled InstancedMeshes: STAR_MESH (CircleGeometry star sprite)
 * and TRAIL_MESH (small disc). Both bloom-tagged via BLOOM_LAYER for the
 * "gold pop" highlight. Zero per-frame allocation in the common-case spawn.
 *
 * ── Palette (slot-locked — no new hex constants) ──────────────────────────
 *   slot 7 amber 0xffd86b — star body (matches forestAmber detonation flash,
 *                            forestReaper soul ember, forestWeaponDrops
 *                            sparkle ring; canonical "bloom-y gold" slot)
 *   slot 6 gold  0xd9a648 — trail dots (sparkle/glow tone, mirrors
 *                            forestPickups + forestWeaponDrops sparkle ring)
 *
 * ── HUD coexistence note (cohort 10 forestHud) ────────────────────────────
 * forestHud owns IDs `kk-forest-hud` (root) and `kk-forest-hud-kills`
 * (top-right). We mount our own root `kk-forest-sigil-hud` to keep
 * lifecycle independent (forestHud disposes via disposeForestHud(); our
 * widget disposes via disposeForestSigilArc()). Both DOM widgets coexist
 * on stage; z-index 71 sits one above forestHud's 70 so we're never
 * occluded by it on layout edge cases.
 *
 * ── Lifecycle ──────────────────────────────────────────────────────────────
 *   loadForestSigilArc(scene, state)   — idempotent. Wired from arenaDecor.js
 *                                         gated on state._sigilArcLoaded.
 *   tickForestSigilArc(state, dt)      — per-frame. Polls diff, advances
 *                                         arcs, fades trail dots.
 *   disposeForestSigilArc()            — removes scene group + DOM + style.
 *                                         Idempotent; safe across stage swaps.
 *
 * Forest-only by design: this module makes sense only inside the Forest
 * arena (room-boss / final-boss path lives there). Main.js gates both load
 * and tick on stage.id === 'forest' to mirror sibling FE-V2 modules.
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from './postfx.js';
import { state as _gameState } from './state.js';
import { getMeta } from './meta.js';
import { sfx } from './audio.js';

// ── Pre-pool caps ──────────────────────────────────────────────────────────
const MAX_ARC = 8;
const TRAIL_DOTS_PER_STAR = 6;
const TRAIL_TOTAL = MAX_ARC * TRAIL_DOTS_PER_STAR;

// ── Palette (slot-locked, no new hex) ─────────────────────────────────────
const SLOT7_AMBER = 0xffd86b; // star body + bloom flash
const SLOT6_GOLD  = 0xd9a648; // trail dot tone

// ── HUD-widget CSS color string (reuse slot-6 gold) ───────────────────────
const HUD_GOLD_CSS = '#d9a648';

// ── Arc tunables ──────────────────────────────────────────────────────────
const ARC_SEC        = 0.8;   // travel time per star (spec brief)
const ARC_PEAK_BUMP  = 2.0;   // peak Y above start (spec watch-out)
const STAR_START_Y   = 1.0;   // start +1u above kill point (spec)
const STAR_RADIUS    = 0.42;  // visible disc radius (sprite scale 1.0)
const TRAIL_RADIUS   = 0.18;
const TRAIL_SPACING  = ARC_SEC / TRAIL_DOTS_PER_STAR; // emit cadence (seconds)
const TRAIL_FADE_SEC = 0.50;  // trail dot full-fade after spawn

// ── HUD-anchor (top-right corner, slightly inset so it lands at the widget) ─
// Spec watch-out: "end (HUD-anchor projected to world space)". We unproject
// a screen anchor through the active camera each tick (so window resize +
// camera rotation track). Both inputs are in NDC space [-1, +1]:
//   HUD_NDC_X = 0.82   ≈ near right edge, matches "Sigils: " widget position
//   HUD_NDC_Y = 0.78   ≈ ~36px below top edge (matches widget vertical inset)
//
// Unprojection happens lazily each tick; we cache result so 60Hz reads
// don't waste raycaster allocations.
const HUD_NDC_X = 0.82;
const HUD_NDC_Y = 0.78;

// ── DOM ids (kk- prefix mirrors every other overlay in src/) ──────────────
const ROOT_ID    = 'kk-forest-sigil-hud';
const STYLE_ID   = 'kk-forest-sigil-hud-style';
const COUNTER_ID = 'kk-forest-sigil-hud-counter';

// ── Module state ───────────────────────────────────────────────────────────
let _loaded = false;
let _scene  = null;
let _group  = null;
let _disposables = [];

// Star arc pool — parallel typed arrays for hot-path math.
let _arcActive = null;   // Uint8Array
let _arcT      = null;   // Float32Array (0..1 progress)
let _arcSx     = null;   // Float32Array (start x)
let _arcSy     = null;   // Float32Array (start y)
let _arcSz     = null;   // Float32Array (start z)
let _arcEx     = null;   // Float32Array (end x — HUD-anchor world)
let _arcEy     = null;   // Float32Array (end y)
let _arcEz     = null;   // Float32Array (end z)
let _arcTrailT = null;   // Float32Array — accumulator for next trail emit

// Trail pool — independent ring buffer per star (TRAIL_DOTS_PER_STAR per arc).
let _trailActive = null; // Uint8Array
let _trailT      = null; // Float32Array (0..TRAIL_FADE_SEC seconds remaining)
let _trailX      = null; // Float32Array
let _trailY      = null; // Float32Array
let _trailZ      = null; // Float32Array
let _trailNext   = null; // Uint8Array — ring index per arc (0..TRAIL_DOTS_PER_STAR-1)

// InstancedMeshes — built once, persist for the scene's life.
let _starMesh  = null;
let _trailMesh = null;

// Reusable scratch — zero per-frame allocation.
const _dummy = new THREE.Object3D();
const _zeroDummy = new THREE.Object3D();
_zeroDummy.scale.set(0, 0, 0);
_zeroDummy.updateMatrix();
const _ZERO_MATRIX = _zeroDummy.matrix.clone();
const _ndcVec  = new THREE.Vector3();

// HUD-anchor world cache (rebuilt each tick).
const _hudAnchor = new THREE.Vector3();

// HUD widget refs.
let _root      = null;
let _counterEl = null;
let _styleEl   = null;
let _lastCounterText = '';

function _track(obj) { _disposables.push(obj); }

// ── Mesh builders ──────────────────────────────────────────────────────────
function _buildStarMesh() {
  // Star body — additive flat disc rotated to face up (top-down camera
  // reads it as a billboard sprite). CircleGeometry is the same primitive
  // used by forestPickups sparkles; reusing the pattern keeps the visual
  // grammar consistent across all forest-pickup-like FX.
  const geo = new THREE.CircleGeometry(STAR_RADIUS, 12);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: SLOT7_AMBER,
    transparent: true,
    opacity: 1.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, MAX_ARC);
  // BLOOM_LAYER tag per spec watch-out — bloom composer picks it up and
  // produces the gold halo on arrival.
  mesh.layers.enable(BLOOM_LAYER);
  mesh.frustumCulled = false;
  mesh.userData.sigilArcPart = 'star';
  _track(geo); _track(mat);
  return mesh;
}

function _buildTrailMesh() {
  const geo = new THREE.CircleGeometry(TRAIL_RADIUS, 8);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: SLOT6_GOLD,
    transparent: true,
    opacity: 0.75,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, TRAIL_TOTAL);
  mesh.layers.enable(BLOOM_LAYER);
  mesh.frustumCulled = false;
  mesh.userData.sigilArcPart = 'trail';
  _track(geo); _track(mat);
  return mesh;
}

function _zeroInstanced(mesh, cap) {
  if (!mesh) return;
  for (let i = 0; i < cap; i++) mesh.setMatrixAt(i, _ZERO_MATRIX);
  mesh.instanceMatrix.needsUpdate = true;
}

// ── HUD widget ────────────────────────────────────────────────────────────
function _ensureStyle() {
  if (_styleEl && document.getElementById(STYLE_ID)) return;
  if (document.getElementById(STYLE_ID)) {
    _styleEl = document.getElementById(STYLE_ID);
    return;
  }
  const s = document.createElement('style');
  s.id = STYLE_ID;
  // Mirrors forestHud's kills counter shape, offset 24px below so they
  // stack cleanly without collision (forestHud kills sits at top:12).
  // z-index 71 sits one above forestHud's 70 — defensive, since both are
  // pointer-events:none and would never visually collide in practice.
  s.textContent = [
    '#' + ROOT_ID + ' {',
    '  position: fixed; left: 0; top: 0; right: 0;',
    '  pointer-events: none; z-index: 71;',
    '  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;',
    '  -webkit-font-smoothing: antialiased;',
    '  user-select: none;',
    '}',
    '#' + COUNTER_ID + ' {',
    '  position: absolute; top: 36px; right: 14px;',
    '  font-size: 14px; font-weight: 700; letter-spacing: 0.08em;',
    '  color: ' + HUD_GOLD_CSS + ';',
    '  text-shadow: 0 0 4px rgba(0,0,0,0.85), 0 1px 3px rgba(0,0,0,0.7);',
    '}',
  ].join('\n');
  document.head.appendChild(s);
  _styleEl = s;
}

function _ensureRoot() {
  const existing = document.getElementById(ROOT_ID);
  if (existing) {
    _root      = existing;
    _counterEl = document.getElementById(COUNTER_ID);
    return;
  }
  const root = document.createElement('div');
  root.id = ROOT_ID;
  const counter = document.createElement('div');
  counter.id = COUNTER_ID;
  counter.textContent = 'Sigils: 0';
  root.appendChild(counter);
  document.body.appendChild(root);
  _root = root;
  _counterEl = counter;
  _lastCounterText = '';
}

function _disposeHud() {
  const root = document.getElementById(ROOT_ID);
  if (root && root.parentNode) root.parentNode.removeChild(root);
  const style = document.getElementById(STYLE_ID);
  if (style && style.parentNode) style.parentNode.removeChild(style);
  _root = null;
  _counterEl = null;
  _styleEl = null;
  _lastCounterText = '';
}

// ── Diff polling ──────────────────────────────────────────────────────────

/**
 * Read the monotonic lifetime sigil counter. Defensive: returns 0 on any
 * meta shape mismatch (legacy save loads) so polling never throws.
 */
function _readLifetimeSigils() {
  try {
    const meta = getMeta();
    return (meta && meta.lifetime && Number(meta.lifetime.sigilsEarned)) || 0;
  } catch (_) { return 0; }
}

/**
 * Scan state.enemies.active for the most recent dead mini/final/room-boss
 * (alive === false AND a tier flag set). Returns the kill mesh.position
 * snapshot or null if none found. Stable across one frame: the enemy pool
 * keeps dead entries until the next spawnEnemy() recycles the slot.
 */
function _findRecentBossKillPos(state) {
  if (!state || !state.enemies || !state.enemies.active) return null;
  const arr = state.enemies.active;
  // Walk backwards — most recently appended slots are most likely the
  // fresh kills (spawn order tends to push, deaths flip alive in-place).
  for (let i = arr.length - 1; i >= 0; i--) {
    const e = arr[i];
    if (!e || e.alive !== false) continue;
    if (!e.isMiniBoss && !e.isFinalBoss && !e._isRoomBoss) continue;
    if (!e.mesh || !e.mesh.position) continue;
    // Defensive: skip enemies whose position was reset to origin (unlikely
    // mid-frame but defensible against future pool semantics).
    const p = e.mesh.position;
    if (p.x === 0 && p.y === 0 && p.z === 0) continue;
    return p;
  }
  return null;
}

// ── Pool helpers ──────────────────────────────────────────────────────────
function _allocArc() {
  for (let i = 0; i < MAX_ARC; i++) {
    if (_arcActive[i] === 0) return i;
  }
  return -1; // pool full — drop the spawn; UI counter still updates
}

function _freeArc(i) {
  _arcActive[i] = 0;
  _arcT[i] = 0;
  _arcTrailT[i] = 0;
  if (_starMesh) {
    _starMesh.setMatrixAt(i, _ZERO_MATRIX);
    _starMesh.instanceMatrix.needsUpdate = true;
  }
}

function _allocTrail(arcIdx) {
  // Ring-buffer: oldest dot for this arc is overwritten when full.
  const slot = arcIdx * TRAIL_DOTS_PER_STAR + (_trailNext[arcIdx] % TRAIL_DOTS_PER_STAR);
  _trailNext[arcIdx] = (_trailNext[arcIdx] + 1) % TRAIL_DOTS_PER_STAR;
  return slot;
}

// ── HUD-anchor projection ─────────────────────────────────────────────────
function _projectHudAnchor(state) {
  if (!state || !state.camera) {
    // No camera — fall back to a fixed offset above the hero so the visual
    // still reads (rare boot-edge case; loadForestSigilArc shouldn't run
    // pre-camera, but be defensive).
    const h = state && state.hero && state.hero.pos;
    _hudAnchor.set((h && h.x) || 0, 8, (h && h.z) || 0);
    return _hudAnchor;
  }
  _ndcVec.set(HUD_NDC_X, HUD_NDC_Y, 0.5);
  _ndcVec.unproject(state.camera);
  // Top-down camera tends to project the corner several units away from
  // hero; that's exactly where we want the star to land for the "thrown
  // off-screen into the HUD" reading.
  _hudAnchor.copy(_ndcVec);
  return _hudAnchor;
}

// ── Stamping ──────────────────────────────────────────────────────────────
function _stampStar(i, x, y, z, scale) {
  _dummy.position.set(x, y, z);
  _dummy.rotation.set(0, 0, 0);
  _dummy.scale.setScalar(scale);
  _dummy.updateMatrix();
  _starMesh.setMatrixAt(i, _dummy.matrix);
  _starMesh.instanceMatrix.needsUpdate = true;
}

function _stampTrail(slot, x, y, z, scale) {
  _dummy.position.set(x, y, z);
  _dummy.rotation.set(0, 0, 0);
  _dummy.scale.setScalar(scale);
  _dummy.updateMatrix();
  _trailMesh.setMatrixAt(slot, _dummy.matrix);
  _trailMesh.instanceMatrix.needsUpdate = true;
}

function _hideTrail(slot) {
  _trailMesh.setMatrixAt(slot, _ZERO_MATRIX);
  _trailMesh.instanceMatrix.needsUpdate = true;
}

// ── Counter widget update ─────────────────────────────────────────────────
function _updateCounter() {
  if (!_counterEl) return;
  try {
    const meta = getMeta();
    const n = (meta && meta.sigils) || 0;
    const txt = 'Sigils: ' + n;
    if (txt !== _lastCounterText) {
      _counterEl.textContent = txt;
      _lastCounterText = txt;
    }
  } catch (_) { /* ignore */ }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Idempotent load. Mirrors the FOREST-V2-A10 HUD gate in arenaDecor.js
 * (state._sigilArcLoaded flips before the call so a builder throw doesn't
 * spin-retry; we re-clear the flag on dispose).
 *
 * @param {THREE.Scene} scene
 * @param {object}      state
 */
export function loadForestSigilArc(scene, state) {
  if (_loaded) return;
  if (!scene) return;
  _scene = scene;
  _group = new THREE.Group();
  _group.name = '__forestSigilArc';

  _arcActive = new Uint8Array(MAX_ARC);
  _arcT      = new Float32Array(MAX_ARC);
  _arcSx     = new Float32Array(MAX_ARC);
  _arcSy     = new Float32Array(MAX_ARC);
  _arcSz     = new Float32Array(MAX_ARC);
  _arcEx     = new Float32Array(MAX_ARC);
  _arcEy     = new Float32Array(MAX_ARC);
  _arcEz     = new Float32Array(MAX_ARC);
  _arcTrailT = new Float32Array(MAX_ARC);

  _trailActive = new Uint8Array(TRAIL_TOTAL);
  _trailT      = new Float32Array(TRAIL_TOTAL);
  _trailX      = new Float32Array(TRAIL_TOTAL);
  _trailY      = new Float32Array(TRAIL_TOTAL);
  _trailZ      = new Float32Array(TRAIL_TOTAL);
  _trailNext   = new Uint8Array(MAX_ARC);

  _starMesh  = _buildStarMesh();
  _trailMesh = _buildTrailMesh();
  _group.add(_starMesh);
  _group.add(_trailMesh);
  _zeroInstanced(_starMesh,  MAX_ARC);
  _zeroInstanced(_trailMesh, TRAIL_TOTAL);
  scene.add(_group);

  // Re-baseline the sigil-diff cache so the very first poll after load
  // doesn't false-fire on accumulated lifetime sigils from prior runs.
  if (state && state.run) {
    state.run._sigilsLastSeen = _readLifetimeSigils();
  }

  _ensureStyle();
  _ensureRoot();
  _updateCounter();

  _loaded = true;
}

/**
 * Per-frame tick. Three jobs:
 *   1. Poll lifetime-sigil diff vs state.run._sigilsLastSeen → spawn arcs.
 *   2. Advance active arcs (parabolic Y, linear XZ); emit trail dots.
 *   3. Fade trail dots; on arc completion fire sfx + bump HUD counter.
 *
 * @param {object} state
 * @param {number} dt — paused-aware logic seconds (mirrors all other
 *                       forest-only ticks in main.js).
 */
export function tickForestSigilArc(state, dt) {
  if (!_loaded) return;
  if (!state || !state.run) return;
  if (dt == null || !isFinite(dt) || dt < 0) dt = 0;

  // ── Diff poll ────────────────────────────────────────────────────────
  const lifetime = _readLifetimeSigils();
  const lastSeen = (state.run._sigilsLastSeen == null) ? lifetime : state.run._sigilsLastSeen;
  let diff = lifetime - lastSeen;
  if (diff > 0) {
    // Clamp to MAX_ARC so a multi-grant on a single frame doesn't try to
    // spawn dozens of stars (pool would silently drop excess via -1 alloc;
    // clamp keeps the visual proportional + bounds CPU on the kill spike).
    const burst = Math.min(diff, MAX_ARC);
    const killPos = _findRecentBossKillPos(state);
    const sx = killPos ? killPos.x : (state.hero && state.hero.pos && state.hero.pos.x) || 0;
    const szSrc = killPos ? killPos.z : (state.hero && state.hero.pos && state.hero.pos.z) || 0;
    const sy = STAR_START_Y;
    const anchor = _projectHudAnchor(state);
    for (let n = 0; n < burst; n++) {
      const i = _allocArc();
      if (i < 0) break;
      _arcActive[i] = 1;
      _arcT[i] = 0;
      _arcTrailT[i] = 0;
      // Light jitter so multi-spawns don't perfectly overlay each other.
      const jx = (n - (burst - 1) * 0.5) * 0.18;
      const jz = (n % 2 === 0 ? 1 : -1) * (n * 0.06);
      _arcSx[i] = sx + jx;
      _arcSy[i] = sy;
      _arcSz[i] = szSrc + jz;
      _arcEx[i] = anchor.x;
      _arcEy[i] = anchor.y;
      _arcEz[i] = anchor.z;
      // Initial stamp at start pos so the star is visible on the first
      // frame (no one-frame pop-in at the destination if dt is 0).
      _stampStar(i, _arcSx[i], _arcSy[i], _arcSz[i], 1.0);
    }
    state.run._sigilsLastSeen = lifetime;
  } else if (diff < 0) {
    // Defensive: lifetime went backwards (impossible per grantSigils, but
    // could happen on save-import or migration). Re-baseline silently.
    state.run._sigilsLastSeen = lifetime;
  }

  // ── Advance arcs ─────────────────────────────────────────────────────
  for (let i = 0; i < MAX_ARC; i++) {
    if (_arcActive[i] === 0) continue;
    _arcT[i] += dt / ARC_SEC;
    if (_arcT[i] >= 1.0) {
      // Arrival — fire sfx + bump counter, then free the slot.
      try { sfx.pickup && sfx.pickup(); } catch (_) {}
      _updateCounter();
      _freeArc(i);
      continue;
    }
    const t = _arcT[i];
    // Linear XZ + parabolic Y (sin(πt) envelope, ramped by ARC_PEAK_BUMP).
    const x = _arcSx[i] + (_arcEx[i] - _arcSx[i]) * t;
    const z = _arcSz[i] + (_arcEz[i] - _arcSz[i]) * t;
    const yLerp = _arcSy[i] + (_arcEy[i] - _arcSy[i]) * t;
    const y = yLerp + Math.sin(t * Math.PI) * ARC_PEAK_BUMP;
    // Slight scale pulse so the star reads as "in motion" against the
    // background. Peak at mid-flight (t=0.5).
    const scale = 0.85 + 0.30 * Math.sin(t * Math.PI);
    _stampStar(i, x, y, z, scale);

    // Trail emit on cadence.
    _arcTrailT[i] += dt;
    if (_arcTrailT[i] >= TRAIL_SPACING) {
      _arcTrailT[i] -= TRAIL_SPACING;
      const slot = _allocTrail(i);
      _trailActive[slot] = 1;
      _trailT[slot] = TRAIL_FADE_SEC;
      _trailX[slot] = x;
      _trailY[slot] = y;
      _trailZ[slot] = z;
      _stampTrail(slot, x, y, z, 1.0);
    }
  }

  // ── Fade trail dots ──────────────────────────────────────────────────
  for (let s = 0; s < TRAIL_TOTAL; s++) {
    if (_trailActive[s] === 0) continue;
    _trailT[s] -= dt;
    if (_trailT[s] <= 0) {
      _trailActive[s] = 0;
      _hideTrail(s);
      continue;
    }
    // Alpha-fade via shrinking scale (cheap; per-instance opacity would
    // require a custom shader or per-instance attribute buffer). Fade
    // envelope: 1.0 → 0 over TRAIL_FADE_SEC.
    const f = _trailT[s] / TRAIL_FADE_SEC; // 1.0 → 0
    _stampTrail(s, _trailX[s], _trailY[s], _trailZ[s], f);
  }
}

/**
 * Dispose: scene group + DOM + style. Idempotent across stage swaps.
 */
export function disposeForestSigilArc() {
  _disposeHud();
  if (!_loaded && !_group) return;
  if (_group) {
    if (_scene && _group.parent === _scene) _scene.remove(_group);
    else if (_group.parent) _group.parent.remove(_group);
    _group = null;
  }
  for (let i = 0; i < _disposables.length; i++) {
    try { _disposables[i].dispose && _disposables[i].dispose(); } catch (_) {}
  }
  _disposables = [];
  _starMesh = null;
  _trailMesh = null;
  _arcActive = _arcT = _arcSx = _arcSy = _arcSz = null;
  _arcEx = _arcEy = _arcEz = _arcTrailT = null;
  _trailActive = _trailT = _trailX = _trailY = _trailZ = null;
  _trailNext = null;
  _scene = null;
  _loaded = false;
}
