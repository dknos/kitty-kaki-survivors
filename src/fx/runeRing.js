/**
 * Rune-Ring FX helper — PHASE 2 P2A "Spider Web FX quality bar audit" (2026-05-17).
 *
 * Centralised factory for the "canonical rune ring" sparkle/telegraph visual
 * that the Forest stage uses everywhere — sparkle haloes over chests, coffins,
 * shrines, pickups, weapon drops, env-hazard puffs, branch telegraphs, and
 * trap-corridor rings.
 *
 * ── Why this helper exists ────────────────────────────────────────────────
 * PHASE 1 shipped many of those FX with FLAT `RingGeometry + MeshBasicMaterial
 * (single color)` — a featureless donut tinted with a slot color. User mandate
 * (`feedback_kitty_kaki_fx_quality.md`): "Spider Web FX is the quality bar;
 * rune ring texture is canonical. Flat RingGeometry/MeshBasicMaterial/plain-
 * emissive = placeholder = unacceptable. Visual polish is ship-blocker."
 *
 * The actual in-codebase quality bar is the `_makeRuneRingTexture()` 512²
 * canvas bake in `enemyTells.js` — 8 layers (radial alpha gradient, twin
 * concentric arcs, segmented inner band, 24 tick marks, 8 runic glyphs,
 * 4 chord spokes, 48 outer "hair" stipples, paper-grain noise). Every quality
 * consumer in this codebase (frostbloom, sigilbell, bossTelegraphs, orbitals,
 * bells, arenaDecor) maps that texture onto a flat PlaneGeometry and tints it
 * via `material.color`. There is NO ShaderMaterial path in production rune-
 * ring FX — the canvas-baked detail IS the procedural noise/glyph. This
 * helper formalises that pattern so placeholder call sites can swap in with
 * a 2-3 line edit.
 *
 * ── API ──────────────────────────────────────────────────────────────────
 *   createRuneRing(opts) -> { geometry, material, mesh, dispose }
 *
 *   opts:
 *     radius        : number  — TARGET OUTER world-radius of the visible ring.
 *                               Helper converts to PlaneGeometry size so the
 *                               canonical band sits at this radius
 *                               (band ≈ 0.74 of canvas half-extent — see
 *                               `_makeRuneRingTexture` Layer 1 stops).
 *     color         : hex     — palette-locked tint (e.g. 0xd9a648 slot-6 gold).
 *     opacity       : number  — base opacity, default 0.85.
 *     additive      : bool    — additive blending, default true (sparkle/halo).
 *     bloom         : bool    — enable BLOOM_LAYER, default true.
 *     groundDecal   : bool    — flat-on-floor ring (polygonOffset BELOW so
 *                               hero/enemy meshes occlude correctly). Default
 *                               false (overhead halo). Sets renderOrder=-1
 *                               on the returned mesh when true.
 *     instanced     : bool    — return InstancedMesh instead of Mesh.
 *     cap           : number  — InstancedMesh slot count (required if
 *                               instanced=true).
 *     shareMaterial : bool    — for non-instanced rings: if true, reuse the
 *                               module-level shared material (saves alloc when
 *                               the call site does not animate material.opacity
 *                               or color independently). Default false — most
 *                               trap/pulse consumers animate per-instance.
 *     userData      : object  — merged onto mesh.userData (optional).
 *
 *   Return:
 *     geometry : the shared (or freshly built) PlaneGeometry, rotated -PI/2
 *                so the plane lies flat on the XZ ground plane.
 *     material : MeshBasicMaterial — caller may animate `.opacity`,
 *                `.color.setHex(...)`, and `.needsUpdate` as before.
 *     mesh     : THREE.Mesh OR THREE.InstancedMesh per `instanced`.
 *     dispose  : function — releases per-instance geometry/material (the
 *                shared geometry/material survive — they are module-cached).
 *
 * ── Performance ──────────────────────────────────────────────────────────
 *   • The canonical rune-ring texture is built ONCE (lazy) via
 *     `makeRuneRingTexture()` and reused across every call.
 *   • The flat-on-XZ PlaneGeometry of a given (rounded) world radius is
 *     cached by-radius — most call sites reuse the same geometry.
 *   • When `shareMaterial:true`, a single MeshBasicMaterial is reused.
 *     When false, a fresh material clone is returned so callers may animate
 *     opacity/color independently without bleed.
 *
 * ── Why not a custom ShaderMaterial? ─────────────────────────────────────
 * The PHASE 2 task spec brief floated "ShaderMaterial with procedural noise/
 * glyph". That direction was rejected after audit: the canonical
 * `makeRuneRingTexture()` already bakes 8 procedural layers (noise + glyph
 * + tick + chord + stipple) on a 512² canvas. Sampling that texture is the
 * cheapest route to the user's "match Spider Web FX quality bar" outcome.
 * A bespoke shader would introduce a *third* visual style not matching
 * either the canonical bar or the placeholders. Documented in
 * `docs/SPIDER_WEB_AUDIT.md`.
 *
 * ── Palette contract ─────────────────────────────────────────────────────
 * Caller passes color (hex literal). Helper does NOT introduce new palette
 * constants. All forest call sites pass one of the 8 slots from
 * `docs/FOREST_VISUAL_STYLE.md`.
 */

import * as THREE from 'three';
import { BLOOM_LAYER } from '../postfx.js';
import { makeRuneRingTexture } from '../enemyTells.js';

// ── Canonical texture — built once, reused everywhere ────────────────────
// `makeRuneRingTexture()` is the 8-layer 512² canvas bake in enemyTells.js.
// Lazy-instantiated so DOM (`document.createElement('canvas')`) is only
// touched when first ring is built, never at import time (smoke harnesses
// import modules under JSDom-less Node — see tools/smoke-*.mjs).
let _texture = null;
function _getTexture() {
  if (_texture) return _texture;
  _texture = makeRuneRingTexture();
  return _texture;
}

// ── PlaneGeometry cache ──────────────────────────────────────────────────
// The canonical texture's visible band sits at canvas-radius 0.62..0.74.
// A PlaneGeometry(s, s) rotated flat shows the OUTER band edge at world-
// radius s * 0.74 / 2. So to land the band edge at `targetRadius`, the
// plane size is targetRadius * 2 / VISIBLE_BAND_OUTER.
//
// We round the requested radius to 3 decimal places before caching so
// near-identical sparkle haloes (0.45, 0.4500001, etc.) collapse to one
// geometry. Mismatch tolerance < 1 mm — irrelevant at the iso camera scale.
const VISIBLE_BAND_OUTER = 0.74;
const _geoCache = new Map();
function _getGeometry(targetRadius) {
  const key = Math.round(targetRadius * 1000) / 1000;
  const cached = _geoCache.get(key);
  if (cached) return cached;
  const planeSize = (targetRadius * 2) / VISIBLE_BAND_OUTER;
  const geo = new THREE.PlaneGeometry(planeSize, planeSize);
  geo.rotateX(-Math.PI / 2);
  _geoCache.set(key, geo);
  return geo;
}

// ── Shared overhead-sparkle material ─────────────────────────────────────
// Used by call sites that pass `shareMaterial: true` with the default-ish
// "overhead additive bloom halo" preset. Saves alloc for the common case
// (chest sparkle, coffin sparkle, weapon-drop sparkle, etc.) where all
// instances share opacity/color and the ring is shown/hidden via the
// InstancedMesh matrix (zero-scale slots).
let _sharedOverheadMat = null;
function _getSharedOverheadMat(color) {
  // Shared material can only safely be reused if all callers want the same
  // color. In practice the placeholders all want slot-6 gold; if a caller
  // wants a different tint they should pass shareMaterial:false. We do NOT
  // mutate the shared material's color on subsequent calls.
  if (_sharedOverheadMat) return _sharedOverheadMat;
  _sharedOverheadMat = new THREE.MeshBasicMaterial({
    map: _getTexture(),
    color,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  return _sharedOverheadMat;
}

function _buildMaterial(opts) {
  const additive = opts.additive !== false;
  const mat = new THREE.MeshBasicMaterial({
    map: _getTexture(),
    color: opts.color != null ? opts.color : 0xffffff,
    transparent: true,
    opacity: opts.opacity != null ? opts.opacity : 0.85,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  if (opts.groundDecal) {
    // Ground-decal Z-order fix (cohort 20 / 2026-05-17 user report): flat
    // rings at y≈0 must render BELOW hero/enemies. polygonOffset biases
    // them further into the depth buffer so opaque entities occlude them.
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -1;
  }
  return mat;
}

/**
 * Factory — see header comment for opts shape.
 */
export function createRuneRing(opts) {
  if (!opts || typeof opts !== 'object') opts = {};
  const radius = opts.radius != null ? opts.radius : 0.45;
  if (!(radius > 0)) {
    throw new Error('createRuneRing: radius must be > 0 (got ' + radius + ')');
  }
  const color = opts.color != null ? opts.color : 0xffffff;
  const bloom = opts.bloom !== false;
  const instanced = !!opts.instanced;
  const cap = opts.cap | 0;
  if (instanced && cap < 1) {
    throw new Error('createRuneRing: instanced=true requires cap >= 1 (got ' + cap + ')');
  }

  const geometry = _getGeometry(radius);
  const material = (opts.shareMaterial && !opts.groundDecal && opts.additive !== false)
    ? _getSharedOverheadMat(color)
    : _buildMaterial(opts);

  let mesh;
  if (instanced) {
    mesh = new THREE.InstancedMesh(geometry, material, cap);
    mesh.frustumCulled = false;
  } else {
    mesh = new THREE.Mesh(geometry, material);
  }
  if (bloom) mesh.layers.enable(BLOOM_LAYER);
  if (opts.groundDecal) mesh.renderOrder = -1;

  if (opts.userData) {
    for (const k in opts.userData) mesh.userData[k] = opts.userData[k];
  }

  return {
    geometry,
    material,
    mesh,
    dispose() {
      // Per-instance material only — shared material + cached geometry
      // are module-owned and persist across runs.
      if (material !== _sharedOverheadMat) material.dispose();
    },
  };
}

/**
 * Test-hook: drop the texture + caches. Called by smoke harnesses that
 * tear down the scene between runs to avoid stale GL handles. Safe to call
 * at any time — next createRuneRing() will lazily rebuild.
 */
export function _resetRuneRingCachesForTest() {
  if (_texture) { try { _texture.dispose(); } catch (_) { /* noop */ } }
  _texture = null;
  for (const g of _geoCache.values()) { try { g.dispose(); } catch (_) { /* noop */ } }
  _geoCache.clear();
  if (_sharedOverheadMat) { try { _sharedOverheadMat.dispose(); } catch (_) { /* noop */ } }
  _sharedOverheadMat = null;
}
