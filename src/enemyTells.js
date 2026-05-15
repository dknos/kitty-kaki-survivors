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
import { tex } from './particleTextures.js';

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
// Iter 32c — volatile was cyan (0x66ddff), nearly identical to frost (blue).
// On Twilight Hollow where both affixes spawn often, every ring read as "blue".
// Hot orange now: radiation/warning signal, no overlap with the cool family.
const COL_VOLATILE     = new THREE.Color(0xff8a33);   // orange — explosive warning
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
// Per-family ground rings (iter 28h). Each carries the same PlaneGeometry but
// a dedicated texture so the player can tell Volatile / Frosted / Shielded /
// Mini-boss / Final boss / plain Elite apart by shape, not just tint.
let _ringsElite     = /** @type {THREE.InstancedMesh|null} */ (null);
let _ringsVolatile  = /** @type {THREE.InstancedMesh|null} */ (null);
let _ringsFrosted   = /** @type {THREE.InstancedMesh|null} */ (null);
let _ringsShielded  = /** @type {THREE.InstancedMesh|null} */ (null);
let _ringsMini      = /** @type {THREE.InstancedMesh|null} */ (null);
let _ringsFinal     = /** @type {THREE.InstancedMesh|null} */ (null);
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
// Family-specific ground-ring textures (iter 28h).
//
// Every threat family (Volatile / Frosted / Shielded / Mini-boss / Final boss /
// plain Elite) now draws a DIFFERENT shape so the player can read the threat
// at a glance instead of decoding a tint.
//
// All five honor the same band constraint as `_makeRuneRingTexture`
// (alpha mass at r ≈ 0.55..0.78 of the canvas) so consumers can keep their
// PlaneGeometry sizes and the visible radius stays identical.
// ──────────────────────────────────────────────────────────────────────────

function _bandCanvas(S) {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  return { c, ctx: c.getContext('2d') };
}

function _bandTexFromCanvas(c) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

let _volatileTex = null;
function _makeVolatileExplosiveTexture() {
  if (_volatileTex) return _volatileTex;
  const S = 512;
  const { c, ctx } = _bandCanvas(S);
  ctx.clearRect(0, 0, S, S);
  const cx = S / 2, cy = S / 2;
  // Hot danger band (alpha envelope)
  const env = ctx.createRadialGradient(cx, cy, S * 0.50, cx, cy, S * 0.78);
  env.addColorStop(0.00, 'rgba(255,255,255,0)');
  env.addColorStop(0.18, 'rgba(255,255,255,0.55)');
  env.addColorStop(0.35, 'rgba(255,255,255,1.0)');
  env.addColorStop(0.62, 'rgba(255,255,255,0.85)');
  env.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = env;
  ctx.fillRect(0, 0, S, S);
  ctx.translate(cx, cy);
  // 8 zigzag explosion chevrons pointing outward — "radiation hazard" feel
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2;
    ctx.save();
    ctx.rotate(ang);
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(S * 0.30, -S * 0.04);
    ctx.lineTo(S * 0.34, S * 0.00);
    ctx.lineTo(S * 0.33, S * 0.04);
    ctx.lineTo(S * 0.38, S * 0.02);
    ctx.lineTo(S * 0.36, -S * 0.03);
    ctx.lineTo(S * 0.41, -S * 0.01);
    ctx.stroke();
    // Inner bright trace
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();
  }
  // 16 short crackle veins inside the band — danger hatching
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1.8;
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + Math.random() * 0.10;
    const r0 = S * (0.34 + Math.random() * 0.02);
    const r1 = r0 + S * (0.03 + Math.random() * 0.02);
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    const midA = a + (Math.random() - 0.5) * 0.18;
    const midR = (r0 + r1) * 0.5;
    ctx.lineTo(Math.cos(midA) * midR, Math.sin(midA) * midR);
    ctx.lineTo(Math.cos(a + (Math.random() - 0.5) * 0.10) * r1,
               Math.sin(a + (Math.random() - 0.5) * 0.10) * r1);
    ctx.stroke();
  }
  // Outer hot rim band — thick concentric stroke to read as "primed shell"
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.beginPath();
  ctx.arc(0, 0, S * 0.40, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  _volatileTex = _bandTexFromCanvas(c);
  return _volatileTex;
}

let _frostedTex = null;
function _makeFrostedCrystalTexture() {
  if (_frostedTex) return _frostedTex;
  const S = 512;
  const { c, ctx } = _bandCanvas(S);
  ctx.clearRect(0, 0, S, S);
  const cx = S / 2, cy = S / 2;
  // Band envelope — softer falloff so the snowflake reads "drifting"
  const env = ctx.createRadialGradient(cx, cy, S * 0.46, cx, cy, S * 0.80);
  env.addColorStop(0.00, 'rgba(255,255,255,0)');
  env.addColorStop(0.20, 'rgba(255,255,255,0.40)');
  env.addColorStop(0.40, 'rgba(255,255,255,0.95)');
  env.addColorStop(0.62, 'rgba(255,255,255,0.70)');
  env.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = env;
  ctx.fillRect(0, 0, S, S);
  ctx.translate(cx, cy);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineCap = 'round';
  // 6 large snowflake arms in band — main 6-fold symmetry
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2;
    ctx.save();
    ctx.rotate(ang);
    ctx.lineWidth = 4;
    // Main spine
    ctx.beginPath();
    ctx.moveTo(S * 0.30, 0);
    ctx.lineTo(S * 0.42, 0);
    ctx.stroke();
    // Two side barbs near outer end
    ctx.lineWidth = 2.5;
    for (const r of [0.34, 0.38]) {
      ctx.beginPath();
      ctx.moveTo(S * r, 0);
      ctx.lineTo(S * (r - 0.02), S * 0.025);
      ctx.moveTo(S * r, 0);
      ctx.lineTo(S * (r - 0.02), -S * 0.025);
      ctx.stroke();
    }
    // Outer tip cross
    ctx.beginPath();
    ctx.moveTo(S * 0.42, -S * 0.02);
    ctx.lineTo(S * 0.42, S * 0.02);
    ctx.stroke();
    ctx.restore();
  }
  // 12 between-arm crystalline glints (smaller diamonds)
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  for (let i = 0; i < 12; i++) {
    const ang = (i / 12) * Math.PI * 2 + Math.PI / 12;
    const r = S * (0.36 + (i % 2) * 0.04);
    ctx.save();
    ctx.rotate(ang);
    ctx.translate(r, 0);
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-3, -3, 6, 6);
    ctx.restore();
  }
  // Outer rim — thin crystalline ring
  ctx.strokeStyle = 'rgba(255,255,255,0.70)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(0, 0, S * 0.44, 0, Math.PI * 2);
  ctx.stroke();
  // Inner ring — faint
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(0, 0, S * 0.30, 0, Math.PI * 2);
  ctx.stroke();
  // Scatter of tiny snow specks across band — "drifting frost" feel
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  for (let i = 0; i < 40; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = S * (0.32 + Math.random() * 0.14);
    ctx.beginPath();
    ctx.arc(Math.cos(a) * r, Math.sin(a) * r, 0.8 + Math.random() * 1.0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  _frostedTex = _bandTexFromCanvas(c);
  return _frostedTex;
}

let _shieldedTex = null;
function _makeShieldedHeraldTexture() {
  if (_shieldedTex) return _shieldedTex;
  const S = 512;
  const { c, ctx } = _bandCanvas(S);
  ctx.clearRect(0, 0, S, S);
  const cx = S / 2, cy = S / 2;
  // Heavier, more solid band — metallic ward feel
  const env = ctx.createRadialGradient(cx, cy, S * 0.48, cx, cy, S * 0.78);
  env.addColorStop(0.00, 'rgba(255,255,255,0)');
  env.addColorStop(0.18, 'rgba(255,255,255,0.80)');
  env.addColorStop(0.42, 'rgba(255,255,255,1.0)');
  env.addColorStop(0.65, 'rgba(255,255,255,0.85)');
  env.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = env;
  ctx.fillRect(0, 0, S, S);
  ctx.translate(cx, cy);
  // Inner & outer hard edges — riveted plate look
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(0, 0, S * 0.40, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, S * 0.30, 0, Math.PI * 2);
  ctx.stroke();
  // 16 rivets evenly around mid-band
  ctx.fillStyle = 'rgba(255,255,255,1)';
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const r = S * 0.35;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * r, Math.sin(a) * r, 4, 0, Math.PI * 2);
    ctx.fill();
    // Highlight pip
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.arc(Math.cos(a) * r - 1, Math.sin(a) * r - 1, 1.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,1)';
  }
  // 4 cross-quarter cardinal bars — segmented ward
  ctx.strokeStyle = 'rgba(255,255,255,0.90)';
  ctx.lineWidth = 3;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * S * 0.30, Math.sin(a) * S * 0.30);
    ctx.lineTo(Math.cos(a) * S * 0.40, Math.sin(a) * S * 0.40);
    ctx.stroke();
  }
  // Heraldic center cross (inside the band's inner edge)
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 2.0;
  ctx.beginPath();
  ctx.moveTo(-S * 0.30, 0); ctx.lineTo(-S * 0.22, 0);
  ctx.moveTo( S * 0.22, 0); ctx.lineTo( S * 0.30, 0);
  ctx.moveTo(0, -S * 0.30); ctx.lineTo(0, -S * 0.22);
  ctx.moveTo(0,  S * 0.22); ctx.lineTo(0,  S * 0.30);
  ctx.stroke();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  _shieldedTex = _bandTexFromCanvas(c);
  return _shieldedTex;
}

let _miniBossTex = null;
function _makeMiniBossBladesTexture() {
  if (_miniBossTex) return _miniBossTex;
  const S = 512;
  const { c, ctx } = _bandCanvas(S);
  ctx.clearRect(0, 0, S, S);
  const cx = S / 2, cy = S / 2;
  // Band envelope — slightly inset so the blade tips touch the outer band
  const env = ctx.createRadialGradient(cx, cy, S * 0.48, cx, cy, S * 0.78);
  env.addColorStop(0.00, 'rgba(255,255,255,0)');
  env.addColorStop(0.30, 'rgba(255,255,255,0.85)');
  env.addColorStop(0.55, 'rgba(255,255,255,1.0)');
  env.addColorStop(0.78, 'rgba(255,255,255,0.65)');
  env.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = env;
  ctx.fillRect(0, 0, S, S);
  ctx.translate(cx, cy);
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  ctx.fillStyle   = 'rgba(255,255,255,1)';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // 4 crossed sabers around band — hostile X pattern
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * Math.PI * 2 + Math.PI / 4;
    ctx.save();
    ctx.rotate(ang);
    // Saber shape — triangle blade
    ctx.beginPath();
    ctx.moveTo(S * 0.26, -S * 0.022);
    ctx.lineTo(S * 0.44, 0);
    ctx.lineTo(S * 0.26, S * 0.022);
    ctx.closePath();
    ctx.fill();
    // Crossguard line
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(S * 0.27, -S * 0.045);
    ctx.lineTo(S * 0.27, S * 0.045);
    ctx.stroke();
    ctx.restore();
  }
  // Spike teeth around outer rim — 16 jagged barbs
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const r0 = S * 0.41;
    const r1 = S * 0.45;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    ctx.lineTo(Math.cos(a + 0.06) * r1, Math.sin(a + 0.06) * r1);
    ctx.lineTo(Math.cos(a + 0.12) * r0, Math.sin(a + 0.12) * r0);
    ctx.fill();
  }
  // Inner pentagonal void — 5-sided dark center accent (use lower alpha)
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
    const x = Math.cos(a) * S * 0.18;
    const y = Math.sin(a) * S * 0.18;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.stroke();
  // Inner thin band ring
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(0, 0, S * 0.30, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  _miniBossTex = _bandTexFromCanvas(c);
  return _miniBossTex;
}

let _finalBossTex = null;
function _makeFinalBossClawsTexture() {
  if (_finalBossTex) return _finalBossTex;
  const S = 512;
  const { c, ctx } = _bandCanvas(S);
  ctx.clearRect(0, 0, S, S);
  const cx = S / 2, cy = S / 2;
  // Wider envelope — final boss reads as the biggest threat
  const env = ctx.createRadialGradient(cx, cy, S * 0.42, cx, cy, S * 0.78);
  env.addColorStop(0.00, 'rgba(255,255,255,0)');
  env.addColorStop(0.20, 'rgba(255,255,255,0.65)');
  env.addColorStop(0.45, 'rgba(255,255,255,1.0)');
  env.addColorStop(0.70, 'rgba(255,255,255,0.78)');
  env.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = env;
  ctx.fillRect(0, 0, S, S);
  ctx.translate(cx, cy);
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  ctx.fillStyle   = 'rgba(255,255,255,1)';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // 6 inward-curving dragon claws around band
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2;
    ctx.save();
    ctx.rotate(ang);
    // Claw — curved blade arc tapering inward
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(S * 0.45, S * 0.00);
    ctx.quadraticCurveTo(S * 0.42, S * 0.08, S * 0.30, S * 0.05);
    ctx.stroke();
    // Inner bright trace
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(S * 0.44, S * 0.005);
    ctx.quadraticCurveTo(S * 0.41, S * 0.07, S * 0.31, S * 0.045);
    ctx.stroke();
    // Tip droplet
    ctx.beginPath();
    ctx.arc(S * 0.45, 0, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  // Central pentagram — 5 lines connecting outer points
  const pent = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
    pent.push([Math.cos(a) * S * 0.20, Math.sin(a) * S * 0.20]);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  // Star polygon — connect every 2nd point
  for (let i = 0; i < 5; i++) {
    const p0 = pent[i];
    const p1 = pent[(i + 2) % 5];
    if (i === 0) ctx.moveTo(p0[0], p0[1]);
    ctx.lineTo(p1[0], p1[1]);
  }
  ctx.closePath();
  ctx.stroke();
  // Outer rim
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.arc(0, 0, S * 0.42, 0, Math.PI * 2);
  ctx.stroke();
  // Inner rim
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(0, 0, S * 0.30, 0, Math.PI * 2);
  ctx.stroke();
  // Blood-splatter mottle — 60 tiny dots
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  for (let i = 0; i < 60; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = S * (0.32 + Math.random() * 0.10);
    ctx.beginPath();
    ctx.arc(Math.cos(a) * r, Math.sin(a) * r, 0.8 + Math.random() * 1.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  _finalBossTex = _bandTexFromCanvas(c);
  return _finalBossTex;
}

let _eliteWreathTex = null;
function _makeEliteWreathTexture() {
  if (_eliteWreathTex) return _eliteWreathTex;
  const S = 512;
  const { c, ctx } = _bandCanvas(S);
  ctx.clearRect(0, 0, S, S);
  const cx = S / 2, cy = S / 2;
  // Standard band envelope
  const env = ctx.createRadialGradient(cx, cy, S * 0.46, cx, cy, S * 0.80);
  env.addColorStop(0.00, 'rgba(255,255,255,0)');
  env.addColorStop(0.25, 'rgba(255,255,255,0.60)');
  env.addColorStop(0.50, 'rgba(255,255,255,1.0)');
  env.addColorStop(0.74, 'rgba(255,255,255,0.70)');
  env.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = env;
  ctx.fillRect(0, 0, S, S);
  ctx.translate(cx, cy);
  // Laurel branches — two arcs of leaves curving around the band
  // Each leaf = small ellipse tilted along the branch tangent.
  // 24 leaves total, mirrored top + bottom.
  ctx.fillStyle = 'rgba(255,255,255,1)';
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 2;
  const LEAVES_PER_SIDE = 14;
  for (let side = 0; side < 2; side++) {
    const dir = side === 0 ? 1 : -1;
    for (let i = 0; i < LEAVES_PER_SIDE; i++) {
      const t = (i + 0.5) / LEAVES_PER_SIDE;
      const a = (-Math.PI * 0.45 + t * Math.PI * 0.90) * dir + (dir > 0 ? 0 : Math.PI);
      const r = S * 0.37;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a + Math.PI / 2 - 0.3 * dir);
      // Leaf body
      ctx.beginPath();
      ctx.ellipse(0, 0, 12, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      // Vein line
      ctx.beginPath();
      ctx.moveTo(-10, 0); ctx.lineTo(10, 0);
      ctx.lineWidth = 0.8;
      ctx.stroke();
      ctx.restore();
    }
  }
  // Top crown chevron (3-pointed) — "champion" cue
  ctx.fillStyle = 'rgba(255,255,255,1)';
  ctx.beginPath();
  ctx.moveTo(-S * 0.10, -S * 0.30);
  ctx.lineTo(-S * 0.06, -S * 0.42);
  ctx.lineTo(-S * 0.02, -S * 0.34);
  ctx.lineTo(0,          -S * 0.46);
  ctx.lineTo(S * 0.02,   -S * 0.34);
  ctx.lineTo(S * 0.06,   -S * 0.42);
  ctx.lineTo(S * 0.10,   -S * 0.30);
  ctx.closePath();
  ctx.fill();
  // Bottom tied ribbon
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-S * 0.05, S * 0.30);
  ctx.quadraticCurveTo(0, S * 0.36, S * 0.05, S * 0.30);
  ctx.stroke();
  // Inner & outer thin rings to frame the wreath
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(0, 0, S * 0.30, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, S * 0.44, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  _eliteWreathTex = _bandTexFromCanvas(c);
  return _eliteWreathTex;
}

// ──────────────────────────────────────────────────────────────────────────
// Init
// ──────────────────────────────────────────────────────────────────────────
export function initEnemyTells(scene) {
  _scene = scene;

  // ── Per-family ground rings (iter 28h) ──
  // Shared PlaneGeometry. One InstancedMesh per family with its own texture.
  // Six families, each cap ELITE_RING_CAP — 6×32×Matrix4 is negligible.
  const ringGeo = new THREE.PlaneGeometry(RING_OUTER * 2, RING_OUTER * 2);
  ringGeo.rotateX(-Math.PI / 2);

  const makeFamilyRings = (tex, defaultCol) => {
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const inst = new THREE.InstancedMesh(ringGeo, mat, ELITE_RING_CAP);
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    inst.frustumCulled = false;
    // Floor-decal layer (iter 33w). Affix rings are flat ground planes
    // (rotateX(-π/2)); negative renderOrder pushes them BEFORE the opaque hero
    // and enemy meshes so the silhouette reads on top of the ring.
    inst.renderOrder = -3;
    inst.layers.enable(BLOOM_LAYER);
    inst.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(ELITE_RING_CAP * 3), 3,
    );
    for (let i = 0; i < ELITE_RING_CAP; i++) {
      inst.setMatrixAt(i, _hideMat);
      inst.setColorAt(i, defaultCol);
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.instanceColor.needsUpdate = true;
    _scene.add(inst);
    return inst;
  };

  _ringsElite    = makeFamilyRings(_makeEliteWreathTexture(),       COL_ELITE);
  _ringsVolatile = makeFamilyRings(_makeVolatileExplosiveTexture(), COL_VOLATILE);
  _ringsFrosted  = makeFamilyRings(_makeFrostedCrystalTexture(),    COL_FROST);
  _ringsShielded = makeFamilyRings(_makeShieldedHeraldTexture(),    COL_SHIELD_GOLD);
  _ringsMini     = makeFamilyRings(_makeMiniBossBladesTexture(),    COL_MINI);
  _ringsFinal    = makeFamilyRings(_makeFinalBossClawsTexture(),    COL_FINAL);

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
  // Textured with the multi-flare twinkle star so the floating beacon reads
  // as "danger pinged" rather than a flat plane. Per-instance color (set in
  // setColorAt above) tints the tex per threat tier (mini-boss vs final).
  const dotGeo = new THREE.PlaneGeometry(DOT_SIZE, DOT_SIZE);
  const dotMat = new THREE.MeshBasicMaterial({
    map: tex('flashStar') || tex('twinkle'),
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
  // Ground rune at leap target — floor decal, sit behind hero/enemies.
  _leapMarkers.renderOrder = -2;
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
  if (!_ringsElite || !_rangedTells || !_threatDots) return;

  const active = state.enemies.active;
  const t      = state.time.game;
  const heroP  = state.hero.pos;

  // Ring pulse: subtle radial throb so the silhouette doesn't read as a static decal.
  const ringPulse = 1 + Math.sin(t * 4.5) * 0.04;
  // Dot pulse: faster + bigger amplitude so the eye locks onto mini/final.
  const dotPulse  = 1 + Math.sin(t * 8.0) * 0.18;
  const dotOpacityPulse = 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(t * 11.0));

  // Per-family slot counters (iter 28h).
  let eliteSlot = 0;
  let volSlot   = 0;
  let frostSlot = 0;
  let shldSlot  = 0;
  let miniSlot  = 0;
  let finalSlot = 0;
  let tellSlot  = 0;
  let dotSlot   = 0;

  for (let i = 0; i < active.length; i++) {
    const e = active[i];
    if (!e || !e.alive) continue;
    const ep = e.mesh.position;

    // ── 1. Family-dispatched ground ring (iter 28h) ──
    // Render condition: any elite, OR any affixed enemy carrying a ground-tell
    // affix (volatile / shielded / frosted) so trash mobs with an affix also
    // earn a silhouette cue. Non-affixed standards still skip.
    //
    // Dispatch priority (highest threat first — what the player most needs
    // to read): Final Boss > Mini-Boss > Volatile > Shielded > Frosted >
    // Vampiric (tinted Elite) > plain Elite.
    const wantsAffixRing = (e._volatile || e._shieldedRim || e._frostAura);
    if (e.elite || wantsAffixRing || e.isMiniBoss || e.isFinalBoss) {
      // Frost: slight upward drift on the ring's Y so the snowflake reads as
      // "cold rising off the corpse", distinguishing it from the static rings.
      const ringY = e._frostAura ? RING_Y + 0.04 + 0.025 * Math.sin(t * 2.2 + i) : RING_Y;
      _pos.set(ep.x, ringY, ep.z);
      _scl.set(ringPulse, 1, ringPulse);
      // Slow yaw rotation — sells "magic glyph rotating" vs flat decal.
      _quat.setFromAxisAngle(_axisY, t * 0.4 + i * 0.7);
      _mat.compose(_pos, _quat, _scl);

      let bucket = null;
      let bucketSlot = 0;
      let col = null;
      if (e.isFinalBoss && finalSlot < ELITE_RING_CAP) {
        bucket = _ringsFinal; bucketSlot = finalSlot++; col = COL_FINAL;
      } else if (e.isMiniBoss && miniSlot < ELITE_RING_CAP) {
        bucket = _ringsMini;  bucketSlot = miniSlot++;  col = COL_MINI;
      } else if (e._volatile && volSlot < ELITE_RING_CAP) {
        bucket = _ringsVolatile; bucketSlot = volSlot++; col = COL_VOLATILE;
      } else if (e._shieldedRim && shldSlot < ELITE_RING_CAP) {
        // Gold flicker on the shielded ward — same modulation as before.
        const flick = 0.55 + 0.45 * Math.sin(t * 8.0);
        _ringColTmp.copy(COL_SHIELD_GOLD).multiplyScalar(flick + 0.55);
        bucket = _ringsShielded; bucketSlot = shldSlot++; col = _ringColTmp;
      } else if (e._frostAura && frostSlot < ELITE_RING_CAP) {
        bucket = _ringsFrosted; bucketSlot = frostSlot++; col = COL_FROST;
      } else if (eliteSlot < ELITE_RING_CAP) {
        // Vampiric + plain elite — share the wreath bucket; vampiric tints red.
        if (e._vampPct) {
          _ringColTmp.copy(COL_ELITE).lerp(COL_VAMP_RED, 0.55);
          col = _ringColTmp;
        } else {
          col = COL_ELITE;
        }
        bucket = _ringsElite; bucketSlot = eliteSlot++;
      }
      if (bucket) {
        bucket.setMatrixAt(bucketSlot, _mat);
        bucket.setColorAt(bucketSlot, col);
      }
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
  const familyBuckets = [
    [_ringsElite,    eliteSlot],
    [_ringsVolatile, volSlot],
    [_ringsFrosted,  frostSlot],
    [_ringsShielded, shldSlot],
    [_ringsMini,     miniSlot],
    [_ringsFinal,    finalSlot],
  ];
  for (const [inst, used] of familyBuckets) {
    for (let i = used; i < ELITE_RING_CAP; i++) inst.setMatrixAt(i, _hideMat);
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
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
  if (!_ringsElite || !_rangedTells || !_threatDots) return;
  const families = [_ringsElite, _ringsVolatile, _ringsFrosted, _ringsShielded, _ringsMini, _ringsFinal];
  for (const inst of families) {
    for (let i = 0; i < ELITE_RING_CAP; i++) inst.setMatrixAt(i, _hideMat);
    inst.instanceMatrix.needsUpdate = true;
  }
  for (let i = 0; i < RANGED_TELL_CAP; i++) _rangedTells.setMatrixAt(i, _hideMat);
  for (let i = 0; i < THREAT_DOT_CAP;  i++) _threatDots.setMatrixAt(i, _hideMat);
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
