/**
 * Forest FX pre-warm — PHASE 2 P2C (2026-05-17).
 *
 * Many forest systems lazy-create textures / materials on FIRST invocation.
 * The canonical `createRuneRing` helper (P2A) bakes a 512² canvas-glyph
 * texture the first time any consumer asks for a ring. That bake (8 layers
 * — radial gradient, twin arcs, segmented inner band, 24 tick marks, 8
 * runic glyphs, 4 chord spokes, 48 outer stipples, paper-grain noise)
 * runs once but the first call to take the hit during gameplay is whichever
 * FX fires first — usually a chest pickup, hazard puff, or pulse beat.
 * That call lands a single-frame hitch the size of the bake.
 *
 * This module fires DUMMY pre-warms during forest stage load (after every
 * other forest loader has built its meshes) so the canvas bake + the per-
 * radius PlaneGeometry caches in `fx/runeRing.js` are populated BEFORE any
 * real spawn fires.
 *
 * ── What this actually does ──────────────────────────────────────────────
 * For each unique `radius` (and groundDecal variant) used across the forest
 * codebase, we call `createRuneRing({ radius, ... }).dispose()`:
 *   • First call triggers the lazy `makeRuneRingTexture()` canvas bake.
 *   • Each unique radius warms one PlaneGeometry cache entry.
 *   • Each ground-decal radius warms a separate material clone (different
 *     polygonOffset settings — the geometry cache key is shared, the
 *     material is per-call).
 *   • Dispose immediately so the per-instance material clones don't leak.
 *     The shared canvas texture + cached geometries stay alive (module-
 *     owned) so subsequent real spawns get cache hits.
 *
 * ── What this does NOT do ────────────────────────────────────────────────
 * The spec brief listed several pre-warm targets that are NOT reachable
 * from the current public API surface:
 *   • Boss intro banner DOM — already created by `loadBossIntroCinematic`
 *     at stage load (arenaDecor.js l.2566). Already warm.
 *   • Mushroom puff sphere expansion — SphereGeometry built inside
 *     `_buildMushroomMesh` at load time. Already warm.
 *   • Falling branch crash burst — `_branchBoxMesh` InstancedMesh built at
 *     load via `_buildBranchMeshes`. Already warm.
 *   • Coffin gold pillar burst — no such code path exists in the current
 *     `forestCoffins.js` (only chests have the pillar burst); the coffin
 *     "open burst" is the spark rune ring, which IS covered.
 *   • Amber shockwave (`_spawnShockwave`), chest open pillar burst
 *     (`_burstMesh`), reaper tint overlay (`_ensureTintEl`), pickup flash
 *     overlay (`_ensureFlashEl`) — all private inside their respective
 *     modules. Future cohorts should expose `_prewarmFx()` helpers per the
 *     spec watch-out so these can be pre-warmed too.
 *   • Day/night ambient capture — baseline captured lazily on first tick
 *     after `state.time.game` is set; deferred to a future cohort (touches
 *     scene fog + sun + hemi).
 *
 * ── Why no `renderer.render(scene, camera)` push ─────────────────────────
 * The spec watch-out notes that forcing a synchronous render is invasive
 * (risks breaking the existing render-loop / Playwright lifecycle in
 * smoke-forest-v2.mjs) and the alternative — just creating the texture +
 * material — IS the primary cost saving. The canvas bake is the CPU work
 * we're moving off the gameplay frame; GL upload latency on first real
 * frame is negligible compared to an 8-layer 512² canvas draw.
 *
 * ── Budget ───────────────────────────────────────────────────────────────
 * Aim < 50 ms total. Runs once per forest stage load, never per frame.
 * Per-step timing is captured into a single console.log line under the
 * `[prewarm]` tag so a perf audit can confirm the budget after the fact.
 */

import { createRuneRing } from './fx/runeRing.js';

// ── Pre-warm targets ─────────────────────────────────────────────────────
// Collected by grep across all `createRuneRing(...)` call sites in src/.
// Reviewed 2026-05-17 against:
//   forestLandmarks.js (0.45 shrine sparkle, 0.32 pulse),
//   forestCoffins.js   (0.55 spark),
//   forestChests.js    (0.65 sparkle),
//   forestPickups.js   (0.45 sparkle),
//   forestWeaponDrops.js (0.50 sparkle),
//   forestEnvHazards.js  (1.5 puff [groundDecal], 1.5 branch tele [groundDecal]),
//   trapCorridor.js    (per-trap radius, default 1.6 [groundDecal]).
//
// Set semantics keep the order stable + de-duplicate near-identical radii
// (the runeRing geometry cache rounds to 3 decimal places, so two callers
// asking for 0.45 share one geometry).
const OVERHEAD_RADII = [0.32, 0.45, 0.50, 0.55, 0.65];
const GROUND_DECAL_RADII = [1.5, 1.6];

// ── Pre-warm runner ──────────────────────────────────────────────────────
// Each step:
//   1. Call createRuneRing with the target radius (and groundDecal flag).
//      First call triggers makeRuneRingTexture() canvas bake.
//      Subsequent calls hit the cached texture + geometry.
//   2. Immediately dispose() — releases the per-instance material clone.
//      Shared texture + cached geometries persist (module-owned).
//   3. Wrap in try/catch so a single failure doesn't break the whole
//      pre-warm pass.
//   4. Record per-step ms into a single rollup log at the end.
function _prewarmStep(label, fn, timings) {
  const t0 = (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now();
  let ok = true;
  try {
    fn();
  } catch (e) {
    ok = false;
    // Use warn (not error) so smoke harnesses' console-error gate stays
    // clean. Pre-warm failures are non-fatal — the FX system still works,
    // we just lose the hitch-elimination benefit for that step.
    try {
      console.warn('[prewarm] forestFx step "' + label + '" failed:', e);
    } catch (_) { /* console may not exist in some sandboxes */ }
  }
  const t1 = (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now();
  timings.push({ label, ms: t1 - t0, ok });
}

/**
 * Run the forest FX pre-warm pass. Call once per stage load AFTER every
 * other forest loader has built its meshes (arenaDecor.js _buildForestDecor
 * end-of-function gate).
 *
 * @param {THREE.Scene}  _scene  unused — kept for API symmetry + future
 *                                pre-warm steps that may need scene attach.
 * @param {object}       _state  unused — same.
 * @param {THREE.Camera} _camera unused — same.
 */
export function prewarmForestFx(_scene, _state, _camera) {
  const timings = [];
  const t0 = (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now();

  // ── runeRing overhead variants (sparkle haloes) ─────────────────────
  // First step warms the canvas texture bake; remaining steps just warm
  // per-radius PlaneGeometry cache entries.
  for (let i = 0; i < OVERHEAD_RADII.length; i++) {
    const r = OVERHEAD_RADII[i];
    _prewarmStep('runeRing(' + r + ')', () => {
      const ring = createRuneRing({
        radius: r,
        // Slot-6 gold — matches the most common forest call site (chest,
        // coffin, pickup, weapon-drop, branch-tele, pulse). Color does not
        // affect cache keys; using one consistent color avoids confusing
        // future grep'ers who'd assume each radius wanted a different tint.
        color: 0xd9a648,
        opacity: 0.85,
        // Non-instanced — keeps the dummy allocation cheap. The geometry
        // cache is keyed by radius, not by mesh type, so this warms the
        // same entry an InstancedMesh consumer would use later.
      });
      ring.dispose();
    }, timings);
  }

  // ── runeRing ground-decal variants (flat-on-floor rings) ─────────────
  // groundDecal:true picks up polygonOffset settings on the MATERIAL
  // (geometry is shared with overhead variants of the same radius). We
  // pre-warm distinct radii so the geometry cache entries are populated.
  for (let i = 0; i < GROUND_DECAL_RADII.length; i++) {
    const r = GROUND_DECAL_RADII[i];
    _prewarmStep('runeRing(' + r + ',groundDecal)', () => {
      const ring = createRuneRing({
        radius: r,
        color: 0xd9a648,
        opacity: 0.85,
        groundDecal: true,
      });
      ring.dispose();
    }, timings);
  }

  // ── Rollup log ──────────────────────────────────────────────────────
  // Single-line summary so the perf log stays uncluttered. Per-step ms
  // shown inline for the rare case where one step dominates.
  const t1 = (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now();
  const totalMs = (t1 - t0).toFixed(1);
  try {
    const failed = timings.filter((s) => !s.ok).length;
    const detail = timings
      .map((s) => s.label + ':' + s.ms.toFixed(1) + 'ms')
      .join(' ');
    const tag = failed > 0
      ? '[prewarm] forestFx: ' + totalMs + 'ms (' + failed + ' failed) ' + detail
      : '[prewarm] forestFx: ' + totalMs + 'ms ' + detail;
    console.log(tag);
  } catch (_) { /* console may not exist in some sandboxes */ }
}
