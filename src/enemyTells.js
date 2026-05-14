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
// Procedural rune-ring texture — high-density summoning sigil.
//
// Iter 25 upgrade: matches `weapons/web.js _makeWeb()` motif density so every
// consumer (frostbloom, sigilbell, helltide, town statues, enemy tells,
// boss telegraphs, pylons, chests, bells, catacomb, interior, miniEvents)
// reads as "spell circle / summoning glyph" instead of "ring with ticks."
//
// CRITICAL CONSTRAINT (drop-in compat):
//   The visible alpha band MUST stay inside r ≈ 0.62…0.75 (×S). Every consumer
//   sizes its `PlaneGeometry` around that band; widening or shifting changes
//   the apparent radius of every spell effect in the game. Density goes
//   INSIDE the band, never outside.
//
// Texture is grayscale white-on-transparent — `material.color` tints downstream
// drive green (frostbloom), yellow (sigilbell ramp/treasure), blue (volatile/
// frost affixes), pink (mini/leap/helltide rift), amber (helltide altar), etc.
//
// Bloom-friendly: peak alpha = 1.0 on hot pixels so the post-FX bloom pass
// picks the rim/runes out. No raw 4-flat-diamonds anymore.
// ──────────────────────────────────────────────────────────────────────────
export function makeRuneRingTexture() { return _makeRuneRingTexture(); }
function _makeRuneRingTexture() {
  // 512² doubles per-pixel detail vs old 256² (4× pixels, well under budget —
  // one cached upload reused across ~16 consumers).
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  const cx = S / 2, cy = S / 2;

  // ── Layer 1: Radial mask (alpha envelope) ─────────────────────────────
  // Same stop positions as the previous (256²) texture so every consumer's
  // PlaneGeometry size still aligns to the visible band.
  const g = ctx.createRadialGradient(cx, cy, S * 0.30, cx, cy, S * 0.50);
  g.addColorStop(0.00, 'rgba(0,0,0,0)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.0)');
  g.addColorStop(0.58, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.66, 'rgba(255,255,255,1.0)');
  g.addColorStop(0.72, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.78, 'rgba(255,255,255,0.45)');
  g.addColorStop(0.92, 'rgba(255,255,255,0.08)');
  g.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.lineCap = 'round';

  // ── Layer 2: Twin concentric arcs (inner thin filament + outer rim) ──
  // Matches web.js's "thin lines at varied radii" feel without breaking the
  // alpha band. Inner filament at 0.62, outer rim at 0.74.
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  ctx.lineWidth = 2.0; // 4px primary outline at 512² ≈ style-bible 4px@1024
  ctx.beginPath();
  ctx.arc(0, 0, S * 0.62, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 3.0;
  ctx.beginPath();
  ctx.arc(0, 0, S * 0.74, 0, Math.PI * 2);
  ctx.stroke();

  // ── Layer 3: Arc-segmented inner band — broken arcs read as a glyph ──
  // 8 short arcs at r=0.68 with gaps between, evoking a sectioned cipher
  // wheel. Style-bible 2px secondary line weight (1.0px @ 512²).
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  for (let i = 0; i < 8; i++) {
    const a0 = (i / 8) * Math.PI * 2 + 0.06;
    const a1 = a0 + (Math.PI * 2 / 8) - 0.12;
    ctx.beginPath();
    ctx.arc(0, 0, S * 0.685, a0, a1);
    ctx.stroke();
  }

  // ── Layer 4: 24 tick marks crossing the band (radial strokes) ─────────
  // Tighter & denser than the old 24 outer ticks — these now span the full
  // band width so the ring reads as "scribed measurement glyph."
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 1.4;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const r0 = S * 0.64, r1 = S * 0.72;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
    ctx.stroke();
  }

  // ── Layer 5: 8 cardinal runic glyphs (replacing the old 4 diamonds) ──
  // Two interleaved shapes — diamonds at N/E/S/W, "eye" lozenges at the
  // ordinal angles. Hand-inked summoning circle vibe per the original brief
  // ("hand-inked summoning rune instead of a stack of two flat colored
  // shapes" — sigilbell.js comment).
  ctx.fillStyle = 'rgba(255,255,255,1)';
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const r = S * 0.685;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    if (i % 2 === 0) {
      // Cardinal diamonds — pointed glyph
      ctx.beginPath();
      ctx.moveTo(0, -10);
      ctx.lineTo(13, 0);
      ctx.lineTo(0, 10);
      ctx.lineTo(-13, 0);
      ctx.closePath();
      ctx.fill();
    } else {
      // Ordinal "eye lozenges" — elongated rune with inner dot
      ctx.beginPath();
      ctx.ellipse(0, 0, 12, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.85)';
      ctx.beginPath();
      ctx.arc(0, 0, 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,1)';
    }
    ctx.restore();
  }

  // ── Layer 6: 4 chord "spokes" connecting opposing runes ───────────────
  // Thin diametric lines crossing the disc give the eye a "magic-circle
  // grid" cue. Stay alpha-low so we don't fill in the center hole.
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1.0;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * S * 0.66, Math.sin(a) * S * 0.66);
    ctx.lineTo(Math.cos(a + Math.PI) * S * 0.66, Math.sin(a + Math.PI) * S * 0.66);
    ctx.stroke();
  }

  // ── Layer 7: Outer "hairs" — 48 high-frequency stipple ticks ─────────
  // Just outside the rim, alpha-low. Reads as ink-bleed / paper texture
  // (style-bible "paper grain"), and gives bloom something to halo over.
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 0.8;
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const r0 = S * 0.755;
    const r1 = S * 0.755 + (i % 3 === 0 ? 8 : 4); // varied length
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
    ctx.stroke();
  }

  ctx.restore();

  // ── Layer 8: Paper-grain noise modulation (subtle alpha jitter) ──────
  // Per style-bible "warm paper, ink lines." 6% alpha jitter inside the
  // visible band keeps the texture from looking sterile / vector-pure.
  // Sampled directly into the canvas pixels so it composes with all layers.
  const img = ctx.getImageData(0, 0, S, S);
  const data = img.data;
  for (let y = 0; y < S; y += 1) {
    for (let x = 0; x < S; x += 1) {
      const idx = (y * S + x) * 4 + 3;
      if (data[idx] === 0) continue;
      // 2-octave value noise — cheap, deterministic
      const n = (Math.sin(x * 0.27 + y * 0.41) * 0.5 + Math.cos((x - y) * 0.19) * 0.5);
      const jitter = 1.0 + n * 0.06;
      data[idx] = Math.max(0, Math.min(255, Math.floor(data[idx] * jitter)));
    }
  }
  ctx.putImageData(img, 0, 0);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8; // bumped from 4 — denser detail benefits from filtering
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

// ──────────────────────────────────────────────────────────────────────────
// Chevron crescent texture — for the ranged wind-up tell.
// 256² canvas, alpha-masked crescent at the top half with three forward-
// pointing chevrons. Center hot, edges fading. Mapped to a square plane;
// the bottom half is fully transparent so only the crescent renders.
// ──────────────────────────────────────────────────────────────────────────
let _chevronTex = null;
function _makeChevronCrescentTexture() {
  if (_chevronTex) return _chevronTex;
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  const cx = S / 2, cy = S * 0.62; // shift center down so crescent sits up

  // Outer rim arc band — thick stroke fading at the ends
  const arcGrad = ctx.createLinearGradient(0, 0, S, 0);
  arcGrad.addColorStop(0.00, 'rgba(255,255,255,0)');
  arcGrad.addColorStop(0.18, 'rgba(255,255,255,0.55)');
  arcGrad.addColorStop(0.50, 'rgba(255,255,255,1.0)');
  arcGrad.addColorStop(0.82, 'rgba(255,255,255,0.55)');
  arcGrad.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.strokeStyle = arcGrad;
  ctx.lineCap = 'round';
  // Two stacked arcs — outer rim + inner filament
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.arc(cx, cy, S * 0.42, Math.PI * 1.15, Math.PI * 1.85);
  ctx.stroke();
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(cx, cy, S * 0.34, Math.PI * 1.18, Math.PI * 1.82);
  ctx.stroke();

  // Three forward-pointing chevrons inside the crescent — biggest at center
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const chev = [
    { a: -0.40, r: 0.30, w: 6, span: 0.28 },
    { a:  0.00, r: 0.26, w: 8, span: 0.36 },
    { a:  0.40, r: 0.30, w: 6, span: 0.28 },
  ];
  for (const ch of chev) {
    const ang = Math.PI * 1.5 + ch.a;
    const r = S * ch.r;
    const px = cx + Math.cos(ang) * r;
    const py = cy + Math.sin(ang) * r;
    const span = ch.span;
    const r1 = r + S * 0.08;
    ctx.lineWidth = ch.w;
    ctx.beginPath();
    const l1x = cx + Math.cos(ang - span) * r1;
    const l1y = cy + Math.sin(ang - span) * r1;
    const r1x = cx + Math.cos(ang + span) * r1;
    const r1y = cy + Math.sin(ang + span) * r1;
    ctx.moveTo(l1x, l1y);
    ctx.lineTo(px, py);
    ctx.lineTo(r1x, r1y);
    ctx.stroke();
  }

  // Tick marks across the band — short radial strokes for ink-glyph feel
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1.6;
  for (let i = 0; i < 14; i++) {
    const t = i / 13;
    const a = Math.PI * 1.18 + t * Math.PI * 0.64;
    const r0 = S * 0.36, r1 = S * 0.46;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    ctx.stroke();
  }

  // Soft halo behind the band — radial gradient mask, alpha-only contribution
  ctx.globalCompositeOperation = 'destination-over';
  const halo = ctx.createRadialGradient(cx, cy - S * 0.05, S * 0.10, cx, cy - S * 0.05, S * 0.46);
  halo.addColorStop(0.00, 'rgba(255,255,255,0.20)');
  halo.addColorStop(0.65, 'rgba(255,255,255,0.10)');
  halo.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'source-over';

  _chevronTex = new THREE.CanvasTexture(c);
  _chevronTex.colorSpace = THREE.SRGBColorSpace;
  _chevronTex.anisotropy = 4;
  _chevronTex.generateMipmaps = true;
  _chevronTex.minFilter = THREE.LinearMipmapLinearFilter;
  _chevronTex.magFilter = THREE.LinearFilter;
  _chevronTex.needsUpdate = true;
  return _chevronTex;
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
  // Textured plane (chevron crescent) tilted so it floats above the enemy's
  // head and reads as a charging glyph from the iso camera. Replaces the old
  // flat RingGeometry with a hand-painted crescent — same alpha-band envelope
  // language as the rune ring, with three forward-pointing chevrons.
  const tellSize = RANGED_TELL_SIZE * 2.4;
  const tellGeo = new THREE.PlaneGeometry(tellSize, tellSize);
  tellGeo.rotateX(-Math.PI / 2.4);
  const tellMat = new THREE.MeshBasicMaterial({
    map: _makeChevronCrescentTexture(),
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
