/**
 * Enemy "tells" — readable silhouette cues so threats parse at a glance,
 * BEFORE the first hit lands.
 *
 * Three InstancedMesh layers, all on BLOOM_LAYER so they participate in the
 * existing post-FX bloom pass (additive blending, reads under bloom without
 * blowing out the swarm):
 *
 *   1. Elite ground rings   — flat ring under elites / mini / final boss,
 *                             color-coded by threat tier (gold/magenta/red).
 *   2. Ranged wind-up tells — a small additive crescent above ranged-enemy
 *                             heads, appears in the last 0.6s before they fire.
 *   3. Threat dot           — pulsing dot floating above mini-boss / final boss
 *                             so the eye locks on them through a crowd.
 *
 * PERF: zero per-frame allocations — all temps are module-scope. Hidden
 * instance slots collapse to zero scale + y=-1000 (same pattern as gems /
 * blob shadows). Caps are intentionally tight; if a horde overruns them the
 * excess simply doesn't render its tell (gameplay-safe).
 */
import * as THREE from 'three';
import { state } from './state.js';
import { BLOOM_LAYER } from './postfx.js';

// ── Caps ──────────────────────────────────────────────────────────────────
const ELITE_RING_CAP   = 32;
const RANGED_TELL_CAP  = 16;
const THREAT_DOT_CAP   = 8;
// Iter 10b — Leaping-affix landing-zone marker. 16 slots covers the worst
// case (8a's affix-roll keeps Leaping rare — 1/elite, never > 8 in flight).
const LEAP_MARKER_CAP  = 16;

// ── Tunables ──────────────────────────────────────────────────────────────
// Inner/outer widened so the textured rune art has room to breathe.
const RING_INNER       = 0.9;
const RING_OUTER       = 1.8;
const RING_Y           = 0.04;
const HIDE_Y           = -1000;

const RANGED_WINDUP    = 0.6;   // seconds before fire when the tell starts
const RANGED_TELL_Y    = 1.9;   // above enemy head
const RANGED_TELL_SIZE = 0.45;

const DOT_Y            = 2.4;
const DOT_SIZE         = 0.30;

// Threat-tier colors
const COL_ELITE        = new THREE.Color(0xffd24a);
const COL_MINI         = new THREE.Color(0xff66ee);
const COL_FINAL        = new THREE.Color(0xff3344);
const COL_RANGED       = new THREE.Color(0x88ddff);
const COL_DOT_MINI     = new THREE.Color(0xff66ee);
const COL_DOT_FINAL    = new THREE.Color(0xff3344);

// Affix tints (iter 8c) — override the threat-tier color when the enemy has
// a matching slot field stamped by enemyAffixes.js. Pre-allocated at module
// scope so the per-frame loop stays zero-alloc.
const COL_VOLATILE     = new THREE.Color(0x66ddff);   // cyan ring — "don't dash through"
const COL_FROST        = new THREE.Color(0x88ddff);   // cool blue — slow aura
const COL_SHIELD_GOLD  = new THREE.Color(0xffd24a);   // gold base for flicker modulation
const COL_VAMP_RED     = new THREE.Color(0xff3344);   // reuse COL_FINAL hue for vampiric blend
const COL_LEAP_MARKER  = new THREE.Color(0xff66cc);   // magenta — "land spot, get out"
const _ringColTmp      = new THREE.Color();           // scratch for blend math (reused)

// ── Leap-marker tunables ──────────────────────────────────────────────────
// Brief tunings: scale 0.6 → 1.4 as windup remaining drops to 0, with a
// ±0.2 pulse keyed to wall time so the marker reads as "alive / charging"
// instead of a static decal. Y is parked just above the ground ring layer
// so the magenta sells over the ground tile texture.
const LEAP_MARKER_Y       = 0.06;
const LEAP_SCALE_MIN      = 0.6;
const LEAP_SCALE_MAX      = 1.4;
const LEAP_PULSE_AMP      = 0.3;
const LEAP_PULSE_HZ       = 12.0;

// ── Module-scope temps (reuse — zero per-frame allocations) ───────────────
const _mat       = new THREE.Matrix4();
const _pos       = new THREE.Vector3();
const _scl       = new THREE.Vector3();
const _quat      = new THREE.Quaternion();
const _hideMat   = new THREE.Matrix4();
const _axisY     = new THREE.Vector3(0, 1, 0);
const _zeroQuat  = new THREE.Quaternion();
const _hidePos   = new THREE.Vector3(0, HIDE_Y, 0);
const _hideScl   = new THREE.Vector3(0, 0, 0);
_hideMat.compose(_hidePos, _zeroQuat, _hideScl);

// ── State ─────────────────────────────────────────────────────────────────
let _scene       = null;
let _eliteRings  = /** @type {THREE.InstancedMesh|null} */ (null);
let _rangedTells = /** @type {THREE.InstancedMesh|null} */ (null);
let _threatDots  = /** @type {THREE.InstancedMesh|null} */ (null);
let _leapMarkers = /** @type {THREE.InstancedMesh|null} */ (null);

// Leap-marker slot table. One slot per leaping enemy in flight; the writer
// (enemies.js leap update branch) calls setLeapMarker every tick during
// windup, clearLeapMarker on resolve / kill. The "touched-this-frame" flag
// lets updateEnemyTells prune slots whose owning enemy died mid-windup
// without an explicit clearLeapMarker call (safety net).
const _leapSlots = new Array(LEAP_MARKER_CAP); // {used, x, z, remaining, total, key, touchedFrame}
for (let i = 0; i < LEAP_MARKER_CAP; i++) _leapSlots[i] = { used: false, x: 0, z: 0, remaining: 0, total: 0.6, key: null, touchedFrame: -1 };
let _leapFrame = 0;

// ──────────────────────────────────────────────────────────────────────────
// Procedural rune-ring texture — sharp inner pulse + outer band of ticks +
// 4 cardinal runic glyphs. Beats a flat-color RingGeometry by a country mile.
// ──────────────────────────────────────────────────────────────────────────
export function makeRuneRingTexture() { return _makeRuneRingTexture(); }
function _makeRuneRingTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  const cx = S / 2, cy = S / 2;

  // Radial falloff: hot center band, cool soft edges (alpha mask).
  const g = ctx.createRadialGradient(cx, cy, S * 0.30, cx, cy, S * 0.50);
  g.addColorStop(0.00, 'rgba(0,0,0,0)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.0)');
  g.addColorStop(0.62, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.75, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.92, 'rgba(255,255,255,0.10)');
  g.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);

  // Tick marks around the outer edge (24 ticks).
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 2.5;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const r0 = S * 0.40, r1 = S * 0.46;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
    ctx.stroke();
  }
  // 4 cardinal "rune" wedges — small diamonds.
  ctx.fillStyle = 'rgba(255,255,255,1)';
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const r = S * 0.36;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.beginPath();
    ctx.moveTo(0, -5);
    ctx.lineTo(7, 0);
    ctx.lineTo(0, 5);
    ctx.lineTo(-7, 0);
    ctx.closePath();
    ctx.fill();
  }
  // Thin bright filament right at the center band.
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(0, 0, S * 0.31, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

// ──────────────────────────────────────────────────────────────────────────
// Init
// ──────────────────────────────────────────────────────────────────────────
export function initEnemyTells(scene) {
  _scene = scene;

  // ── Elite ground ring ──
  // Solid disc plane (alpha comes from the rune texture); rotate flat.
  const ringGeo = new THREE.PlaneGeometry(RING_OUTER * 2, RING_OUTER * 2);
  ringGeo.rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({
    map: _makeRuneRingTexture(),
    color: 0xffffff,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  _eliteRings = new THREE.InstancedMesh(ringGeo, ringMat, ELITE_RING_CAP);
  _eliteRings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _eliteRings.frustumCulled = false;
  _eliteRings.renderOrder = 4;
  _eliteRings.layers.enable(BLOOM_LAYER);
  if (_eliteRings.instanceColor === null) {
    // Allocate per-instance color buffer so each ring can be tier-tinted.
    const colors = new Float32Array(ELITE_RING_CAP * 3);
    _eliteRings.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
  }
  for (let i = 0; i < ELITE_RING_CAP; i++) {
    _eliteRings.setMatrixAt(i, _hideMat);
    _eliteRings.setColorAt(i, COL_ELITE);
  }
  _eliteRings.instanceMatrix.needsUpdate = true;
  if (_eliteRings.instanceColor) _eliteRings.instanceColor.needsUpdate = true;
  _scene.add(_eliteRings);

  // ── Ranged wind-up tell ──
  // Crescent built from a thin ring arc, tilted so it floats above the head
  // and reads as a charging glyph from the iso camera.
  const tellGeo = new THREE.RingGeometry(RANGED_TELL_SIZE * 0.55, RANGED_TELL_SIZE, 24, 1, Math.PI * 0.15, Math.PI * 0.7);
  tellGeo.rotateX(-Math.PI / 2.4);
  const tellMat = new THREE.MeshBasicMaterial({
    color: COL_RANGED,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  _rangedTells = new THREE.InstancedMesh(tellGeo, tellMat, RANGED_TELL_CAP);
  _rangedTells.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _rangedTells.frustumCulled = false;
  _rangedTells.renderOrder = 5;
  _rangedTells.layers.enable(BLOOM_LAYER);
  for (let i = 0; i < RANGED_TELL_CAP; i++) {
    _rangedTells.setMatrixAt(i, _hideMat);
  }
  _rangedTells.instanceMatrix.needsUpdate = true;
  _scene.add(_rangedTells);

  // ── Threat-tier dot (mini-boss / final boss billboard) ──
  const dotGeo = new THREE.PlaneGeometry(DOT_SIZE, DOT_SIZE);
  const dotMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  _threatDots = new THREE.InstancedMesh(dotGeo, dotMat, THREAT_DOT_CAP);
  _threatDots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _threatDots.frustumCulled = false;
  _threatDots.renderOrder = 6;
  _threatDots.layers.enable(BLOOM_LAYER);
  if (_threatDots.instanceColor === null) {
    const colors = new Float32Array(THREAT_DOT_CAP * 3);
    _threatDots.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
  }
  for (let i = 0; i < THREAT_DOT_CAP; i++) {
    _threatDots.setMatrixAt(i, _hideMat);
    _threatDots.setColorAt(i, COL_DOT_MINI);
  }
  _threatDots.instanceMatrix.needsUpdate = true;
  if (_threatDots.instanceColor) _threatDots.instanceColor.needsUpdate = true;
  _scene.add(_threatDots);

  // ── Leap-marker InstancedMesh (iter 10b) ──
  // Magenta rune-ring on the ground at the captured leap-target. Reuses the
  // existing makeRuneRingTexture art so the affix family reads as "magical
  // warning, same as the other tells". Additive blending + BLOOM_LAYER so
  // it glows through the swarm's silhouette clutter.
  const leapGeo = new THREE.PlaneGeometry(RING_OUTER * 2, RING_OUTER * 2);
  leapGeo.rotateX(-Math.PI / 2);
  const leapMat = new THREE.MeshBasicMaterial({
    map: _makeRuneRingTexture(),
    color: 0xffffff,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  _leapMarkers = new THREE.InstancedMesh(leapGeo, leapMat, LEAP_MARKER_CAP);
  _leapMarkers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _leapMarkers.frustumCulled = false;
  _leapMarkers.renderOrder = 5;
  _leapMarkers.layers.enable(BLOOM_LAYER);
  if (_leapMarkers.instanceColor === null) {
    const colors = new Float32Array(LEAP_MARKER_CAP * 3);
    _leapMarkers.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
  }
  for (let i = 0; i < LEAP_MARKER_CAP; i++) {
    _leapMarkers.setMatrixAt(i, _hideMat);
    _leapMarkers.setColorAt(i, COL_LEAP_MARKER);
  }
  _leapMarkers.instanceMatrix.needsUpdate = true;
  if (_leapMarkers.instanceColor) _leapMarkers.instanceColor.needsUpdate = true;
  _scene.add(_leapMarkers);
}

// ──────────────────────────────────────────────────────────────────────────
// Leap-marker imperative API (iter 10b)
// ──────────────────────────────────────────────────────────────────────────
// setLeapMarker(x, z, remaining, total) — called from enemies.js per tick
// while a Leaping-affix enemy is in its 0.6s windup. The marker scales from
// LEAP_SCALE_MIN to LEAP_SCALE_MAX as `remaining` → 0 (1 - remaining/total),
// with a small pulse so the eye locks on. We slot by `key` (enemy reference)
// so repeat calls re-use the same slot.
//
// The 4-argument signature lines up with the locked contract; we allow `key`
// as an optional 5th arg for callers that want explicit clear-on-kill (the
// brief asks `clearLeapMarker(enemyId?)` so the symmetric pattern is to let
// setLeapMarker also accept the key — if absent we fall back to (x,z) match).
export function setLeapMarker(x, z, remaining, total, key) {
  if (!_leapMarkers) return;
  const remainingClamped = Math.max(0, remaining);
  const totalClamped     = Math.max(0.0001, total);
  // Find existing slot for this key (or x,z within 0.5u) so per-tick calls
  // don't bleed into adjacent slots.
  let slot = -1;
  for (let i = 0; i < LEAP_MARKER_CAP; i++) {
    const s = _leapSlots[i];
    if (!s.used) continue;
    if (key != null && s.key === key) { slot = i; break; }
    if (key == null && Math.abs(s.x - x) < 0.5 && Math.abs(s.z - z) < 0.5) { slot = i; break; }
  }
  if (slot < 0) {
    // Allocate a free slot.
    for (let i = 0; i < LEAP_MARKER_CAP; i++) {
      if (!_leapSlots[i].used) { slot = i; break; }
    }
  }
  if (slot < 0) return; // cap reached, gameplay-safe
  const s = _leapSlots[slot];
  s.used        = true;
  s.x           = x;
  s.z           = z;
  s.remaining   = remainingClamped;
  s.total       = totalClamped;
  s.key         = key != null ? key : null;
  s.touchedFrame = _leapFrame;

  // Compute scale: progress 0 → 1 maps to LEAP_SCALE_MIN → LEAP_SCALE_MAX.
  const progress = 1 - (remainingClamped / totalClamped);
  const baseScale = LEAP_SCALE_MIN + (LEAP_SCALE_MAX - LEAP_SCALE_MIN) * progress;
  // Pulse via wall time so all markers share rhythm; sin(t*12) ± 0.3 = ±20%.
  const pulse = 1.0 + LEAP_PULSE_AMP * Math.sin(state.time.real * LEAP_PULSE_HZ);
  const finalScale = baseScale * pulse;

  _pos.set(x, LEAP_MARKER_Y, z);
  _scl.set(finalScale, 1, finalScale);
  _quat.setFromAxisAngle(_axisY, state.time.real * 1.2 + slot * 0.7);
  _mat.compose(_pos, _quat, _scl);
  _leapMarkers.setMatrixAt(slot, _mat);
  _leapMarkers.setColorAt(slot, COL_LEAP_MARKER);
  _leapMarkers.instanceMatrix.needsUpdate = true;
  if (_leapMarkers.instanceColor) _leapMarkers.instanceColor.needsUpdate = true;
}

// clearLeapMarker(enemyId?) — called from enemies.js on leap resolve. If
// enemyId is omitted, clears ALL markers (used by resetEnemyTells).
export function clearLeapMarker(enemyId) {
  if (!_leapMarkers) return;
  if (enemyId == null) {
    for (let i = 0; i < LEAP_MARKER_CAP; i++) {
      _leapSlots[i].used = false;
      _leapSlots[i].key  = null;
      _leapMarkers.setMatrixAt(i, _hideMat);
    }
    _leapMarkers.instanceMatrix.needsUpdate = true;
    return;
  }
  for (let i = 0; i < LEAP_MARKER_CAP; i++) {
    const s = _leapSlots[i];
    if (!s.used) continue;
    if (s.key === enemyId) {
      s.used = false;
      s.key  = null;
      _leapMarkers.setMatrixAt(i, _hideMat);
      _leapMarkers.instanceMatrix.needsUpdate = true;
      return;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Per-frame update
// ──────────────────────────────────────────────────────────────────────────
export function updateEnemyTells(dt) {
  if (!_eliteRings || !_rangedTells || !_threatDots) return;

  const active = state.enemies.active;
  const t      = state.time.game;
  const heroP  = state.hero.pos;

  // Ring pulse: subtle radial throb so the silhouette doesn't read as a static decal.
  const ringPulse = 1 + Math.sin(t * 4.5) * 0.04;
  // Dot pulse: faster + bigger amplitude so the eye locks onto mini/final.
  const dotPulse  = 1 + Math.sin(t * 8.0) * 0.18;
  const dotOpacityPulse = 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(t * 11.0));

  let ringSlot = 0;
  let tellSlot = 0;
  let dotSlot  = 0;

  for (let i = 0; i < active.length; i++) {
    const e = active[i];
    if (!e || !e.alive) continue;
    const ep = e.mesh.position;

    // ── 1. Elite ring ──
    // Render condition: any elite, OR any affixed enemy carrying a ground-tell
    // affix (volatile / shielded / frosted) so trash mobs with an affix also
    // earn a silhouette cue. Non-affixed standards still skip — they should
    // read as background filler.
    const wantsAffixRing = (e._volatile || e._shieldedRim || e._frostAura);
    if ((e.elite || wantsAffixRing) && ringSlot < ELITE_RING_CAP) {
      // Base threat-tier color, then override by affix in teaching-priority
      // order: Volatile beats Shield beats Vamp beats Frost. Volatile leads
      // because "cyan ring = explosive" is the highest-stakes lesson and
      // mis-reading it ends the run.
      let col = COL_ELITE;
      if (e.isFinalBoss)      col = COL_FINAL;
      else if (e.isMiniBoss)  col = COL_MINI;

      if (e._volatile) {
        col = COL_VOLATILE;
      } else if (e._shieldedRim) {
        // Gold flicker: modulate the base gold by a fast sine so the rim
        // pulses like a charging ward. Use the scratch THREE.Color to avoid
        // mutating the const palette entry.
        const flick = 0.55 + 0.45 * Math.sin(t * 8.0);
        _ringColTmp.copy(COL_SHIELD_GOLD).multiplyScalar(flick + 0.55);
        col = _ringColTmp;
      } else if (e._vampPct) {
        // Blend the existing tier color halfway toward red so vampiric elites
        // read as "still elite, but bloody". For non-elite vampirics we start
        // from COL_ELITE so they still get a clear silhouette.
        _ringColTmp.copy(e.elite ? col : COL_ELITE).lerp(COL_VAMP_RED, 0.55);
        col = _ringColTmp;
      } else if (e._frostAura) {
        col = COL_FROST;
      }

      // Frost: slight upward drift on the ring's Y so the cyan tint reads as
      // "cold rising off the corpse", distinguishing it from the static
      // volatile pulse. (No new particle slot — this is the "cool blue tint"
      // fallback the brief flags as acceptable.)
      const ringY = e._frostAura ? RING_Y + 0.04 + 0.025 * Math.sin(t * 2.2 + i) : RING_Y;
      _pos.set(ep.x, ringY, ep.z);
      _scl.set(ringPulse, 1, ringPulse);
      // Slow yaw rotation — sells "magic glyph rotating" vs flat decal.
      // Use enemy index for varied phase so a cluster doesn't lockstep.
      _quat.setFromAxisAngle(_axisY, t * 0.4 + i * 0.7);
      _mat.compose(_pos, _quat, _scl);
      _eliteRings.setMatrixAt(ringSlot, _mat);
      _eliteRings.setColorAt(ringSlot, col);
      ringSlot++;
    }

    // ── 2. Ranged wind-up tell ──
    // e.ranged is the tier config block; e.rangedCD ticks down toward 0 in
    // enemies.js. When it's <= RANGED_WINDUP, the enemy is about to fire.
    // After firing, rangedCD is reset to r.cooldown (well above RANGED_WINDUP),
    // so the tell naturally vanishes.
    if (e.ranged && e.rangedCD > 0 && e.rangedCD <= RANGED_WINDUP && tellSlot < RANGED_TELL_CAP) {
      // Aim crescent toward hero so it doubles as a directional cue.
      const dx = heroP.x - ep.x;
      const dz = heroP.z - ep.z;
      const yaw = Math.atan2(dx, dz);
      _quat.setFromAxisAngle(_axisY, yaw);

      // Grow as the wind-up progresses: small at 0.6s out, full at fire.
      const k = 1 - (e.rangedCD / RANGED_WINDUP);          // 0 → 1
      const grow = 0.6 + k * 0.8;                          // 0.6 → 1.4
      const flick = 1 + Math.sin(t * 28.0) * 0.18;
      _pos.set(ep.x, RANGED_TELL_Y, ep.z);
      _scl.set(grow * flick, grow * flick, grow * flick);
      _mat.compose(_pos, _quat, _scl);
      _rangedTells.setMatrixAt(tellSlot, _mat);
      tellSlot++;
    }

    // ── 3. Threat dot (mini-boss + final boss + vampiric) ──
    // Extending the condition to include `_vampPct` is render-color logic
    // (the "vampiric = red dot" tell from the brief). Bosses still take
    // precedence on color when both flags are set.
    if ((e.isMiniBoss || e.isFinalBoss || e._vampPct) && dotSlot < THREAT_DOT_CAP) {
      let col = COL_DOT_MINI;
      if (e.isFinalBoss) col = COL_DOT_FINAL;
      else if (e.isMiniBoss) col = COL_DOT_MINI;
      else if (e._vampPct) col = COL_VAMP_RED;  // bare trash vampiric → red dot
      _pos.set(ep.x, DOT_Y + Math.sin(t * 3 + i) * 0.08, ep.z);
      _scl.set(dotPulse, dotPulse, dotPulse);
      _mat.compose(_pos, _zeroQuat, _scl);
      _threatDots.setMatrixAt(dotSlot, _mat);
      _threatDots.setColorAt(dotSlot, col);
      dotSlot++;
    }
  }

  // Collapse unused slots so leftover instances from prior frames don't render.
  for (let i = ringSlot; i < ELITE_RING_CAP; i++) {
    _eliteRings.setMatrixAt(i, _hideMat);
  }
  for (let i = tellSlot; i < RANGED_TELL_CAP; i++) {
    _rangedTells.setMatrixAt(i, _hideMat);
  }
  for (let i = dotSlot; i < THREAT_DOT_CAP; i++) {
    _threatDots.setMatrixAt(i, _hideMat);
  }

  // Drive the dot's per-frame opacity pulse on the shared material — cheap
  // and saves us setting per-instance alpha (which InstancedMesh can't do
  // without a custom shader).
  _threatDots.material.opacity = dotOpacityPulse;

  _eliteRings.instanceMatrix.needsUpdate = true;
  if (_eliteRings.instanceColor) _eliteRings.instanceColor.needsUpdate = true;
  _rangedTells.instanceMatrix.needsUpdate = true;
  _threatDots.instanceMatrix.needsUpdate = true;
  if (_threatDots.instanceColor) _threatDots.instanceColor.needsUpdate = true;

  // Leap-marker per-frame prune: any slot whose touchedFrame isn't this frame
  // belongs to an enemy that didn't call setLeapMarker this tick (killed, leap
  // resolved without calling clear, etc.). Hide + free.
  if (_leapMarkers) {
    let leapDirty = false;
    for (let i = 0; i < LEAP_MARKER_CAP; i++) {
      const s = _leapSlots[i];
      if (s.used && s.touchedFrame !== _leapFrame) {
        s.used = false;
        s.key  = null;
        _leapMarkers.setMatrixAt(i, _hideMat);
        leapDirty = true;
      }
    }
    if (leapDirty) _leapMarkers.instanceMatrix.needsUpdate = true;
  }
  // Advance frame counter LAST so the next updateEnemies → setLeapMarker
  // tick stamps with the next frame's index, and our next pass prunes anyone
  // who didn't refresh.
  _leapFrame++;
}

// ──────────────────────────────────────────────────────────────────────────
// Reset (called from main.js on run restart)
// ──────────────────────────────────────────────────────────────────────────
export function resetEnemyTells() {
  if (!_eliteRings || !_rangedTells || !_threatDots) return;
  for (let i = 0; i < ELITE_RING_CAP; i++) _eliteRings.setMatrixAt(i, _hideMat);
  for (let i = 0; i < RANGED_TELL_CAP; i++) _rangedTells.setMatrixAt(i, _hideMat);
  for (let i = 0; i < THREAT_DOT_CAP;  i++) _threatDots.setMatrixAt(i, _hideMat);
  _eliteRings.instanceMatrix.needsUpdate = true;
  _rangedTells.instanceMatrix.needsUpdate = true;
  _threatDots.instanceMatrix.needsUpdate = true;
  // Wipe leap markers + free all slots so the next run starts clean.
  if (_leapMarkers) {
    for (let i = 0; i < LEAP_MARKER_CAP; i++) {
      _leapSlots[i].used = false;
      _leapSlots[i].key  = null;
      _leapMarkers.setMatrixAt(i, _hideMat);
    }
    _leapMarkers.instanceMatrix.needsUpdate = true;
  }
}
