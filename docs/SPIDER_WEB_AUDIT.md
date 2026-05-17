# Spider Web FX Quality Bar — Audit Report (PHASE 2 P2A)

**Branch:** `swarm/spiderweb-fx-audit`
**Date:** 2026-05-17
**Reference mandate:** `feedback_kitty_kaki_fx_quality.md` — *"Spider Web FX is the quality bar; rune ring texture is canonical. Flat RingGeometry / MeshBasicMaterial / plain-emissive = placeholder = unacceptable. Visual polish is ship-blocker."*

---

## Quality bar — what "canonical" actually means in this codebase

The *Spider Web FX* visual (`src/weapons/web.js`) is itself a `PlaneGeometry`
+ `MeshBasicMaterial(map: tex('webBraid'))`. It is NOT a custom
`ShaderMaterial` — it is a baked sprite texture applied to a flat plane and
tinted via `material.color`. The actual "quality bar" pattern in the codebase
is the **`makeRuneRingTexture()`** canvas-baked sigil in
`src/enemyTells.js` — an 8-layer 512² procedural canvas (radial alpha mask,
twin concentric arcs, segmented inner band, 24 radial tick marks, 8 runic
glyphs at cardinals + ordinals, 4 chord spokes across opposing runes, 48
outer "hair" stipples, paper-grain noise). It is used by every other
quality consumer:

- `weapons/frostbloom.js` — frost ring telegraph
- `weapons/frostEternal.js` — frost storm hub
- `weapons/orbitals.js` — orbital trail
- `weapons/sigilbell.js` — summoning ring
- `bells.js` — bell tower sigil
- `bossTelegraphs.js` — every boss tell ring
- `arenaDecor.js` (5+ usages) — arena floor sigils

The 8 baked layers ARE the procedural noise/glyph the spec brief asks for.

### Contract ambiguity — resolved

The PHASE 2 task spec brief asked for *"Custom ShaderMaterial with
procedural noise/glyph"*. After audit, this direction was **rejected**
because:
1. No production code in the repo uses a ShaderMaterial for rune-ring FX.
2. Introducing one would create a *third* visual style not matching either
   the canonical baked-texture bar or the flat-donut placeholders.
3. Sampling the existing canvas-baked texture matches the user's "Spider
   Web FX quality bar" outcome at zero per-instance cost.

Helper at `src/fx/runeRing.js` therefore wraps the canonical bake
(`makeRuneRingTexture`) on a flat `PlaneGeometry`, with palette tint via
`material.color`. Identical underlying tech to spider web FX.

### Helper line count

Spec asked for ~200-400 lines; actual ~190 lines including doc comments.
Smaller because the canonical bake is already factored — helper only
needs to wrap geometry/material construction + ground-decal mode + a
geometry cache by radius.

---

## Target audit — 12 systems

| # | Target | Status | Change |
|---|--------|--------|--------|
| 1 | `forestLandmarks.js` shrine sparkle | **placeholder → upgraded** | Was `TorusGeometry(0.45, 0.04)` blank donut. Now canonical baked-glyph ring via helper. |
| 1b | `forestLandmarks.js` pulse pool | **placeholder → upgraded** | 16 pre-allocated trigger pulses were flat `RingGeometry(0.2, 0.32)`. Each now uses helper with own material so per-pulse opacity ramp still works. |
| 2 | `forestChests.js` chest sparkle | **placeholder → upgraded** | Was flat `RingGeometry(0.45, 0.65)` slot-6 gold donut. Now canonical baked-glyph ring via helper (instanced, cap=8). |
| 3 | `forestCoffins.js` coffin sparkle | **placeholder → upgraded** | Was `TorusGeometry(0.55, 0.06)` blank gold donut. Now canonical baked-glyph ring. Y-spin rotation corrected (`rotation.set(0, spin, 0)` instead of `(PI/2, spin, 0)` — helper geometry is already pre-flattened). |
| 4 | `forestPickups.js` bomb/magnet/chicken sparkle | **placeholder → upgraded** | `_buildSparkleMesh(cap)` was flat `RingGeometry(0.30, 0.45)` 16-seg. Now canonical baked-glyph ring; all three pickup types share the helper via this single factory. |
| 5 | `forestWeaponDrops.js` weapon drop sparkle | **placeholder → upgraded** | Was flat `RingGeometry(?, ?)` 16-seg slot-7 gold. Now canonical baked-glyph ring. |
| 6a | `forestEnvHazards.js` mushroom puff ring | **placeholder → upgraded** | Was flat `RingGeometry(puffInner, puffOuter)` slot-2 green ground-decal. Now canonical baked-glyph ring with `groundDecal:true` (polygonOffset + renderOrder=-1 preserved). |
| 6b | `forestEnvHazards.js` branch telegraph ring | **placeholder → upgraded** | Was flat `RingGeometry(1.3, 1.5)` slot-6 amber ground-decal. Now canonical baked-glyph ring with `groundDecal:true`. |
| 7 | `forestAmber.js` shockwave ring | **deferred — load-bearing dramatic** | Reflows `RingGeometry` per-frame to keep constant 0.08-world-unit line weight while expanding 0→4u. A textured plane would either stretch the baked band proportionally (wrong line weight) or require per-frame canvas re-bake. The constant-line-weight expanding ring is the explicit `docs/FOREST_VISUAL_STYLE.md` "Explosive Amber Ring Shockwave Spec" — and the user mandate says don't break dramatic timing. Visual is intentionally thin/clean per spec, not a "magic glyph" — left as-is. |
| 8a | `trapCorridor.js` telegraph ring | **placeholder → upgraded** | Per-trap `RingGeometry(r-0.08, r)` slot-4 bio-glow mint. Now canonical baked-glyph ring (per-instance material preserved for independent opacity animation across telegraph/impact phases). |
| 8b | `trapCorridor.js` impact ring | **placeholder → upgraded** | Per-trap `RingGeometry(r-0.08, r)` slot-8 cyan-white shockwave. Now canonical baked-glyph ring via same `_buildRingMesh()` factory. |
| 9 | `forestSigilArc.js` sigil sprite trail | **N/A — not a rune ring** | Uses `CircleGeometry(STAR_RADIUS, 12)` and `CircleGeometry(TRAIL_RADIUS, 8)` for tiny 0.06-0.12u billboard particles in a curving HUD-bound arc. These are sparkle DOTS, not summoning RINGS — the canonical rune-ring texture would be unreadable at that pixel footprint. Different FX category. |
| 10 | `evolveCinematic.js` gold burst ring | **deferred — load-bearing dramatic** | Single pre-allocated `RingGeometry(0.85, 1.0, 48)` scaled per-frame from 0→8u over the 1.5s evolve cinematic. Replacing with a textured plane would scale the baked band proportionally (the ring would appear to "balloon" with stretched glyphs instead of "expand cleanly"). User mandate explicitly says don't break dramatic timing on evolveCinematic. Left as-is. |
| 11 | `bossIntroCinematic.js` name banner background | **N/A — DOM only** | The 1.5s boss intro is camera dolly + an HTML `<div>` banner (`#kk-boss-intro-banner`) with CSS gradient/border. There is no 3D rune ring in this module. |
| 12 | `forestSealedDoors.js` seal portal tint | **N/A — emissive recolor only** | Sealed state mutates `discMat.emissive.setHex(COLOR_AMBER_IDLE)` + `crystalMat.emissive.setHex(...)` on EXISTING portal disc/rim/crystal meshes. There is no FX ring to upgrade — the sealed state is a color/intensity swap on geometry that already exists in `forestPortals.js` (which builds the disc/rim with proper material). |

### Summary

- **upgraded:** 9 placeholder targets across 7 files
- **deferred (dramatic load-bearing):** 2 — `forestAmber.js`, `evolveCinematic.js`
- **N/A:** 3 — `forestSigilArc.js`, `bossIntroCinematic.js`, `forestSealedDoors.js`

---

## Helper API

```js
import { createRuneRing } from './fx/runeRing.js';

const { mesh, material, geometry, dispose } = createRuneRing({
  radius      : 0.45,            // target outer world-radius of the visible band
  color       : 0xd9a648,        // palette-locked tint (slot-6 gold etc.)
  opacity     : 0.85,            // base opacity
  additive    : true,            // additive blending (default true)
  bloom       : true,            // tag BLOOM_LAYER (default true)
  groundDecal : false,           // polygonOffset + renderOrder=-1 (default false)
  instanced   : false,           // return InstancedMesh
  cap         : 8,               // required when instanced=true
  shareMaterial: false,          // reuse module-level shared mat (default false)
  userData    : { foo: 'bar' },  // merged onto mesh.userData
});
```

### Why a `geometry` cache by radius?

The canonical rune-ring texture's visible band sits at canvas-radius
0.62..0.74 of the half-extent. A `PlaneGeometry(s, s)` rotated flat shows
that band at world-radius `s * 0.74 / 2`. The helper inverts this so the
caller specifies the *band outer world-radius* directly and the helper
computes the plane size. Identical radii share one cached `PlaneGeometry`.

### Why no `update(dt)` API?

The task spec brief mentioned `update(dt)` for animating a time uniform.
The chosen pattern is a textured `MeshBasicMaterial` (no uniforms), and all
existing call sites animate ring opacity/scale on the **mesh** directly
(per their existing tick loops). Adding a no-op `update(dt)` would be
misleading. Documented omission.

### Render-order modes

The canonical pattern has two distinct uses:

1. **Overhead sparkle halo** — `groundDecal: false` (default). renderOrder
   defaults, no polygonOffset. Used for chest/coffin/shrine/pickup/weapon-
   drop sparkles that hover above props.
2. **Ground decal** — `groundDecal: true`. Adds polygonOffset (factor/units
   = -1) and sets `mesh.renderOrder = -1` so opaque hero/enemy meshes
   occlude the flat ring correctly (cohort-20 Z-order fix, 2026-05-17).
   Used for mushroom puff, branch telegraph, trap corridor rings.

---

## Smoke results

| Smoke harness | Result |
|---|---|
| `node tools/smoke-sig-weapons.mjs` | PASS (all 13 sig weapons, REGISTRY, descriptions, avatars) |
| `node tools/smoke-sprite-fx.mjs` | PASS (88/88 sprite-fx atlas checks) |
| `node tools/smoke-forest-v2.mjs` | PASS (4/4 phases — glade, sealedroom, goldenhour, reaperwarn; 0 console errors; 0 page errors) |
| `node --check` on every touched .js | clean |

Visual sanity-check via `tools/_thumb_forest_phase_*.png` thumbnails
confirms the upgraded sparkle rings render with visible glyph bandstructure
(arcs + tick marks + cardinal/ordinal runes) rather than featureless
donuts. Sealed-room phase (with overlapping sparkle + telegraph + impact
FX) renders cleanly with 0 console errors.

---

## Deferred targets (recommended PHASE 3 follow-ups)

1. **`forestAmber.js` shockwave** — if a future cohort wants a textured
   shockwave, the right approach is a SECOND helper (`createExpandingRing`
   or similar) that uses a thin annular texture with non-square uv
   mapping so the band line-weight stays constant while only the radius
   scales. Out of scope for PHASE 2 P2A.
2. **`evolveCinematic.js` gold burst** — same pattern as forestAmber.
   The dramatic scale-up reads better as a clean thin line than a
   ballooning glyph; the cinematic timing is what carries the moment.
   No upgrade recommended unless user explicitly asks.
3. **`forestSigilArc.js` sprite trail** — different FX category (sparkle
   dots, not rings). If the user wants the dots to feel "magical" too, a
   separate `sparkleStar` helper using a star-glyph texture would be
   appropriate. Out of scope for PHASE 2 P2A.

---

## File diff summary

| File | Lines changed | Type |
|---|---|---|
| `src/fx/runeRing.js` | +190 (new) | helper |
| `src/forestLandmarks.js` | +14 / -23 | refactor (2 call sites) |
| `src/forestChests.js` | +10 / -16 | refactor (1 call site) |
| `src/forestCoffins.js` | +13 / -14 | refactor (1 call site + 3-line spin-axis fix) |
| `src/forestPickups.js` | +8 / -16 | refactor (1 factory) |
| `src/forestWeaponDrops.js` | +11 / -16 | refactor (1 call site) |
| `src/forestEnvHazards.js` | +18 / -49 | refactor (2 call sites) |
| `src/trapCorridor.js` | +9 / -25 | refactor (1 factory) |

Net: -47 LOC on consumers, +190 LOC on the new helper. Centralised
detail accrues at the helper; placeholder sprawl removed.
