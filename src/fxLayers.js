/**
 * Floor-decal layer contract (iter 33aa — Phase 3 refactor).
 *
 * Ground-flat planes (kill rings, enemy telegraphs, portal runes, blob shadows)
 * share four invariants:
 *   1) PlaneGeometry pre-rotated rotateX(-π/2) so the +Z axis is the floor's
 *      visible normal — same orientation that single-mesh sites used via
 *      `mesh.rotation.x = -π/2` and instanced sites baked into geometry.
 *   2) MeshBasicMaterial — transparent + additive + depthWrite:false. Floor
 *      decals never occlude one another or world geo; they accumulate.
 *   3) renderOrder pinned to a named tier so the floor stack sorts
 *      deterministically. Transparent additive default-sorts AFTER opaque,
 *      so without renderOrder, decals draw ON TOP of hero/enemy meshes and
 *      read as HUD instead of ground FX.
 *   4) layers.enable(BLOOM_LAYER) when the tier is `boss_tell` / `kill_pickup`
 *      so the decal contributes to bloom (telegraph/kill pops need glow);
 *      `shadow` skips bloom.
 *
 * FLOOR_TIER values are the LIVE source of truth. assets/fx/MANIFEST.json
 * `_floor_tiers` block was the original design — values here reflect what
 * the code actually uses today. When they re-converge, prune the duplication.
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from './postfx.js';

// Render-order tiers for floor-flat decals. Lower → draws first (deepest).
// Higher (less negative) → draws last (most visible in floor stack). All
// values are < 0 so the entire stack stays under opaque hero/enemy meshes
// (those render at the default 0).
export const FLOOR_TIER = Object.freeze({
  shadow:      -10,  // blob shadows — bottom of floor stack
  portal:       -4,  // catacomb entrance/stair runes
  telegraph:    -3,  // enemy affix rings, mini-event ring/tell, leap markers
  kill_pickup:  -2,  // kill rings + magnet sparks + twinkle pops + pickup ring
  boss_tell:    -2,  // boss telegraph ring/cone/bar (same depth as kill pops)
  boss_mote:    -1,  // boss telegraph mote particles (just above floor stack)
});

// Pre-rotated quaternion for flat-on-ground decals. Identical to the inline
// `setFromEuler(-Math.PI/2, 0, 0)` formerly duplicated across fx.js,
// catacomb.js, miniEvents.js. Shared so callers don't allocate new ones.
export const FLAT_X_QUAT = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(-Math.PI / 2, 0, 0),
);

/**
 * PlaneGeometry pre-rotated to lie flat on Y=0. Use for InstancedMesh decals
 * where the rotation must be baked into the geometry (instance matrices
 * supply position + scale only).
 */
export function floorDecalGeometry(w, h = w) {
  const g = new THREE.PlaneGeometry(w, h);
  g.rotateX(-Math.PI / 2);
  return g;
}

/**
 * Canonical floor-decal material: transparent + additive + depthWrite:false.
 *
 * @param {object} opts
 * @param {THREE.Texture}      opts.map       Color/alpha texture.
 * @param {number}             [opts.color]   Tint (default white).
 * @param {number}             [opts.opacity] 0..1 (default 1).
 * @param {number}             [opts.side]    Default DoubleSide so flipped
 *                                            instance scales stay visible.
 */
export function floorDecalMaterial({ map, color = 0xffffff, opacity = 1, side = THREE.DoubleSide }) {
  return new THREE.MeshBasicMaterial({
    map,
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side,
  });
}

/**
 * Apply a named floor tier to a mesh: sets renderOrder and toggles bloom
 * participation. Returns the mesh for chaining.
 *
 * @param {THREE.Object3D} mesh
 * @param {keyof FLOOR_TIER} tier
 */
export function applyFloorTier(mesh, tier) {
  const order = FLOOR_TIER[tier];
  if (order == null) {
    if (typeof console !== 'undefined') console.warn('[fxLayers] unknown tier:', tier);
    return mesh;
  }
  mesh.renderOrder = order;
  if (tier !== 'shadow') mesh.layers.enable(BLOOM_LAYER);
  return mesh;
}
