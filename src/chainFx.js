/**
 * Chain-lightning arc renderer — shared between src/weapons/chain.js and
 * stage interactables (forestAmber, etc.). Double-tube TubeGeometry:
 * thick outer glow + thin hot inner core. Stage palette is parameter.
 *
 * Extracted from two near-identical inline implementations (A4 backlog).
 * Both consumers used the same geometry/curve/fade-curve pipeline; only
 * the colors and `life` differed. This module is the single source of
 * truth for the chain-arc visual; future interactables import from here
 * instead of re-duplicating the ~40 LOC pattern.
 *
 * Public API:
 *   spawnChainArc(scene, a, b, opts) → handle
 *     a, b: { x, z } endpoints (world coords)
 *     opts: {
 *       outerColor: 0xa8e6ff,     // glow tube color (default cyan-white)
 *       innerColor: 0xa8e6ff,     // core tube color (often same as outer)
 *       life: 0.4,                // fade duration in seconds
 *       segments: <auto>,         // arc subdivisions; auto from dist if omitted
 *       jitter: <auto>,           // perpendicular jitter; auto from dist if omitted
 *       y: 0.7,                   // world Y for arc midpoint
 *       outerRadius: 0.14,        // outer tube radius
 *       innerRadius: 0.05,        // inner core tube radius
 *       bloom: true,              // tag BLOOM_LAYER on both tubes
 *     }
 *
 *   tickChainArcs(dt)
 *     Per-frame: advance all spawned arcs, fade opacity, dispose when expired.
 *     Outer fades linearly (1-k); inner fades cubic-ish (1-k²) for "hot core
 *     lingers" feel — identical curve to both pre-refactor implementations.
 *
 *   disposeAllChainArcs(scene)
 *     Hard cleanup; call on stage teardown.
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from './postfx.js';

// Module-level active-arc list. { group, outerMat, innerMat, geos, t, life }
const _arcs = [];

// Defaults — match the original inline implementations exactly so behavior
// stays byte-identical. Both consumers used the same baseline numbers; only
// colors and `life` actually differ between them.
const DEFAULT_Y           = 0.7;
const DEFAULT_LIFE        = 0.4;
const DEFAULT_OUTER_R     = 0.14;
const DEFAULT_INNER_R     = 0.05;
const DEFAULT_OUTER_COLOR = 0xa8e6ff;
const DEFAULT_INNER_COLOR = 0xa8e6ff;
const OUTER_OPACITY       = 0.55;
const INNER_OPACITY       = 1.0;

/**
 * Jagged-path builder. Identical to the formula both pre-refactor consumers
 * shared: perpendicular displacement tapered by sin(t·π) so endpoints anchor
 * cleanly, with a small Y jitter (0.35× amplitude) for vertical wiggle.
 */
function _arcPoints(a, b, segments, jitter, y) {
  const pts = [];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.max(0.001, Math.hypot(dx, dz));
  const px = -dz / len;
  const pz =  dx / len;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const taper = Math.sin(t * Math.PI);
    const off = (Math.random() * 2 - 1) * jitter * taper;
    const yJit = (Math.random() * 2 - 1) * jitter * 0.35 * taper;
    pts.push(new THREE.Vector3(
      a.x + dx * t + px * off,
      y + yJit,
      a.z + dz * t + pz * off,
    ));
  }
  return pts;
}

/**
 * Build one TubeGeometry mesh from a point path. Additive blending + bloom
 * layer tagging is the shared "this glows" recipe — both pre-refactor
 * implementations did exactly this.
 */
function _makeTube(curve, tubeSegs, radius, color, opacity, bloom) {
  const geo = new THREE.TubeGeometry(curve, tubeSegs, radius, 6, false);
  const mat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  if (bloom) mesh.layers.enable(BLOOM_LAYER);
  return { mesh, mat, geo };
}

/**
 * Spawn one chain arc between a and b. Returns a handle the caller can
 * inspect if needed (most callers will just rely on tickChainArcs to fade).
 */
export function spawnChainArc(scene, a, b, opts = {}) {
  // Distance-derived defaults match the formula both consumers shared.
  // Callers can still override segments/jitter explicitly if a stage wants
  // a custom feel.
  const dist = Math.hypot(b.x - a.x, b.z - a.z);
  const segments = (opts.segments != null)
    ? opts.segments
    : Math.max(5, Math.min(10, Math.floor(dist / 1.2)));
  const jitter = (opts.jitter != null)
    ? opts.jitter
    : Math.min(1.1, 0.25 + dist * 0.06);

  const y           = opts.y           != null ? opts.y           : DEFAULT_Y;
  const life        = opts.life        != null ? opts.life        : DEFAULT_LIFE;
  const outerRadius = opts.outerRadius != null ? opts.outerRadius : DEFAULT_OUTER_R;
  const innerRadius = opts.innerRadius != null ? opts.innerRadius : DEFAULT_INNER_R;
  const outerColor  = opts.outerColor  != null ? opts.outerColor  : DEFAULT_OUTER_COLOR;
  const innerColor  = opts.innerColor  != null ? opts.innerColor  : DEFAULT_INNER_COLOR;
  const bloom       = opts.bloom       !== false;

  const pts = _arcPoints(a, b, segments, jitter, y);
  const curve = new THREE.CatmullRomCurve3(pts);
  const tubeSegs = Math.max(8, pts.length * 2);

  const outer = _makeTube(curve, tubeSegs, outerRadius, outerColor, OUTER_OPACITY, bloom);
  const inner = _makeTube(curve, tubeSegs, innerRadius, innerColor, INNER_OPACITY, bloom);

  const group = new THREE.Group();
  group.add(outer.mesh);
  group.add(inner.mesh);
  scene.add(group);

  const handle = {
    group,
    outerMat: outer.mat,
    innerMat: inner.mat,
    geos: [outer.geo, inner.geo],
    mats: [outer.mat, inner.mat],
    t: 0,
    life,
  };
  _arcs.push(handle);
  return handle;
}

/**
 * Per-frame tick. Single call drains arcs from all consumers — main.js
 * runs this once after stage interactables so both chain.js (weapon) and
 * forestAmber (interactable) share the same fade pipeline.
 */
export function tickChainArcs(dt) {
  for (let i = _arcs.length - 1; i >= 0; i--) {
    const a = _arcs[i];
    a.t += dt;
    const k = a.t / a.life;
    if (k >= 1) {
      const scene = a.group.parent;
      if (scene) scene.remove(a.group);
      for (const g of a.geos) { try { g.dispose(); } catch (_) {} }
      for (const m of a.mats) { try { m.dispose(); } catch (_) {} }
      _arcs.splice(i, 1);
    } else {
      // Outer fades linearly; inner core lingers via (1-k²) — Spider Web FX
      // quality bar (crisp inner rim, soft outer halo). Identical to both
      // pre-refactor implementations.
      a.outerMat.opacity = OUTER_OPACITY * (1 - k);
      a.innerMat.opacity = INNER_OPACITY * (1 - k * k);
    }
  }
}

/**
 * Hard cleanup — drop every live arc immediately. Call on stage teardown
 * (e.g. forestAmber's clearForestAmber) so we don't leak meshes when the
 * scene swaps under us.
 */
export function disposeAllChainArcs(scene) {
  for (const a of _arcs) {
    if (a.group.parent) a.group.parent.remove(a.group);
    else if (scene) scene.remove(a.group);
    for (const g of a.geos) { try { g.dispose(); } catch (_) {} }
    for (const m of a.mats) { try { m.dispose(); } catch (_) {} }
  }
  _arcs.length = 0;
}

// Debug — let tests/tools inspect the active list without exporting the array
// reference (keeps callers from mutating it directly).
export function _debugActiveArcCount() { return _arcs.length; }
