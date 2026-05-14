# Dungeon & Environment Pro-Quality Overhaul (iter 14)

> User feedback (2026-05-14, verbatim):
> *"the dungeons are basic looking too, cant we use high quality assets,
>  theres tons of them online and we've used them before, research and build
>  out the dungeons with real assets, we can use blender to build and enhance
>  graphics/assets too go deep, max effort, max agents"*

The primitive `BoxGeometry`/`ConeGeometry` buildings in `src/env.js`,
`src/catacomb.js`, `src/town.js`, and `src/interior.js` are the explicit
ship-blocker. This iter swaps the loudest offenders to real CC0 kits, and
extends per-stage decor differentiation so the four stages stop reading as
"same kit, different tint".

## Asset acquisition strategy

Blender MCP is **not connected** in this WSL session — direct CDN download
from Poly Pizza CDN (`https://static.poly.pizza/{uuid}.glb`) is the fast
path. Every kit is CC0 (no attribution required), confirmed via the
creator's Poly Pizza profile.

Existing asset tonnage (`assets/breakroom` 46 MB + `assets/sprites` 9.7 MB
= 55 MB). New asset budget: **< 8 MB total** (post-decimation by-eye —
most Quaternius/Lousberg low-poly pieces are 30-150 KB raw). Layout:

```
assets/kits/
  town/         medieval houses, keep, gate (forest stage)
  dungeon/      coffin, crypt, pillar, arch, bones (catacomb)
  ruins/        broken pillars, broken fence (twilight)
  torches/      wall torch, brazier (catacomb + town lamps)
```

## Picks (all CC0, ≤ 1 MB each)

### Town / forest district
| Use                | Author     | Slug             |
|--------------------|------------|------------------|
| Fantasy House (lvl 1) | Quaternius | `BH2XHWUNmF`     |
| Tower House (keep)    | Quaternius | `xm5cViUjra`     |
| Town House (lvl 2)    | Quaternius | `sDQJBImZuw`     |
| Fantasy Inn (market)  | Quaternius | `x3ZcGn3jr4`     |
| Castle Gate           | Quaternius | `tKTchdiQzV`     |
| Fantasy Barracks      | Quaternius | `wTDbVozPAj`     |

### Catacomb dungeon
| Use            | Author        | Slug          |
|----------------|---------------|---------------|
| Arch (entrance/stair foot) | Kay Lousberg | `uS8wgBVxOL`  |
| Pillar         | Kay Lousberg  | `1nt8n3rVKU`  |
| Pillar (alt)   | Kay Lousberg  | `p8JPFIGc09`  |
| Broken pillar  | Kay Lousberg  | `8RXyLygEeF`  |
| Coffin         | Kay Lousberg  | `ySERERWPgE`  |
| Crypt (sarcoph) | Kay Lousberg | `iV5x01FYAl`  |
| Bones ×3       | Kay Lousberg  | `gVLnQi8VrX`, `gVT6iydSY6`, `2jLwMoAb2y` |
| Wall Torch     | Quaternius    | `WGsvr4KOZd`  |

### Twilight / ruin
| Use            | Author        | Slug          |
|----------------|---------------|---------------|
| Damaged Grave  | Kay Lousberg  | `KWtVNrHXVR`  |
| Gravestone     | Kay Lousberg  | `lrEHKjTy29`  |
| Gravestone alt | Kay Lousberg  | `ErfdU1GJSD`  |
| Broken Fence Pillar | Kay Lousberg | `8RXyLygEeF` |

(Twilight reuses the dungeon broken-pillar; this is good — twilight reads
as "the catacomb breaking ground.")

## Scope per stage

1. **Forest** — replace `_makeBuilding(...)` in `env.js` with `cloneCached`
   off the 6 Quaternius town slugs, preserving authored placements
   (keep, 4-house market cluster, 3-piece barracks, 3-piece ruin, 2 gates).
   Combat lane (r > 25u) stays clear.

2. **Catacomb** — replace `_makeWall/_makePillar/_makeTorch/_makeStairs`
   primitives in `catacomb.js`. Walls stay as `BoxGeometry` (cheaper than
   modular tiling) but get a **tileable stone texture** (Poly Haven cobble
   or reuse the existing `brown_mud` pack — TBD on which reads as crypt).
   Pillars / torches / sarcophagi / bones become real GLBs. South arch
   marks the stair foot; coffin + crypt set dress the chamber corners.

3. **Per-stage decor differentiation** — extend `arenaDecor.js` (already
   has forest/twilight/cinder/catacomb packs as InstancedMesh):
   - **Forest**: keep current trees+tufts (already good); add 6 distant
     building GLBs scattered in the outer ring.
   - **Twilight**: keep crystals, **add gravestones** (8-12 instances of
     `Gravestone` GLB) clustered around (40, ±60). Replace flat
     `RingGeometry` ground runes with `makeRuneRingTexture` planes at
     bloom strength 0.4 (matches the rune art language).
   - **Cinder**: keep cracks; **darken rock material to basalt-black
     (`0x1a0a0a` + `0.6` emissive `0xff5a1a` pulse)**; add charred-stump
     scatter (reuse existing `dead_tree` GLB tinted dark gray + scaled
     0.7×).
   - **Catacomb/Void**: replace 4 BoxGeometry pillars (already in pack)
     with 4 instances of the Lousberg `Pillar` GLB; add 6-8 bones
     scattered on the ground (the existing pack has floating bones —
     we add **grounded** bone piles in addition, so the floor reads as
     a real ossuary).

4. **Lighting per stage** (in `applyStageTint`):
   - Forest: current warm sun (no change).
   - Twilight: drop sun intensity 2.2 → 1.1, hemi sky 0xaaccff → 0x6a78a8,
     ground 0x1a1a1f → 0x1a1422.
   - Cinder: sun color 0xffe4b8 → 0xff8a4a, hemi sky → 0x884030,
     sun intensity 2.2 → 1.8, fog grows hotter.
   - Void: sun intensity 2.2 → 0.4 (almost off), hemi sky 0x553388,
     ground 0x140a1c. Catacomb torches do the heavy lifting.

5. **Town hub polish** — replace `_makeCabin` primitive cabin in `town.js`
   with `Fantasy House` GLB; replace `_makeAdventureGate` with
   `Castle Gate` GLB (keep the animated portal disc on top). Lamps stay
   primitive (they're tiny + emissive matters).

6. **Interior polish** — DEFERRED unless time permits. The cabin interior
   is iso-only and primitives read fine at that camera; user feedback
   was about the dungeon/forest, not the room.

## Perf budget projection

- New GLBs: ~25 unique, ~30-180 KB each (raw download stats projected
  from existing chest.glb=95 KB, Tree.glb=903 KB). **~3-6 MB total.**
- Tris: Quaternius low-poly buildings 400-1500 tris each; Lousberg
  dungeon pieces 100-800 tris. Per-stage worst case ~30k tris (catacomb
  has the most authored pieces). **Well under 80k budget.**
- Draw calls: every authored building is one mesh per material. Quaternius
  bundles share a single texture atlas, so ~3 mats per building. Per-stage
  worst case ~80 unique mesh calls + the existing arenaDecor InstancedMesh
  ~10 calls = **~90 draw calls** vs 200 cap.

## Process

1. **This commit (`DUNGEON_OVERHAUL.md`)** — plan visible before work
   starts. Other agents (AoE FX) see what's coming.
2. **Asset acquisition** — `scripts/fetch-kits.sh` curls all slug-resolved
   UUIDs into `assets/kits/{town,dungeon,ruins,torches}/`. Single commit
   for the asset dump + `assets/ASSETS_MANIFEST.md` + `src/assets.js`
   registration.
3. **Forest pass** — `env.js`: replace `_makeBuilding` with cloneCached
   wrappers. Boot test (`node --check`). Commit.
4. **Catacomb pass** — `catacomb.js`: real torches/pillars/coffins, walls
   keep BoxGeometry but get the existing `brown_mud` PBR pack. Commit.
5. **Per-stage decor pass** — extend `arenaDecor.js` with the goals above,
   `env.js` `applyStageTint` lighting hooks, `config.js` STAGES (only
   `groundTint`/`fogColor` tweaks if needed). Commit.
6. **Town hub polish** — replace `_makeCabin` + `_makeAdventureGate` in
   `town.js`. Commit.
7. **`HANDOFF.md`** update + final push.

## Hands-off (AoE agent in flight)

Will NOT touch:
- `src/bossTelegraphs.js`, `src/fx.js`, `src/miniEvents.js`,
  `src/particleTextures.js`, `src/stageHazards.js`,
  `src/weapons/frostbloom.js`, `src/weapons/sigilbell.js`
- `FX_AUDIT_V2.md`

All commits use explicit `git add <path>` only.
