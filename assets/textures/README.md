# Forest Tree Textures (PHASE 3 P3A — FOREST-V2-A32)

Two tileable surface textures for the forest decor "tree" silhouettes
(crystal-trunk bodies + facet-cone tips) in `src/arenaDecor.js`. Added to
ship PR #136 (`feat(textures): tree bark + leaf textures on forest decor`).

## Files

| File | Size | Use |
|------|------|-----|
| `forest_bark_512.png`   | 256×256 grayscale PNG-8 (~42 KB) | `MeshStandardMaterial.map` on hex-prism trunk bodies |
| `forest_leaves_512.png` | 256×256 grayscale PNG-8 (~30 KB) | `MeshStandardMaterial.map` on facet/canopy cone tips |

Total: ~72 KB (budget 500 KB per the FOREST-V2-A32 brief).

## Source

**Procedurally generated.** See `tools/_gen_tree_textures.mjs` for the
deterministic generator (mulberry32 PRNG, value-noise fBm + horizontal
crack threshold for bark; toroidally-wrapped soft-blob speckle + macro
fBm for leaves). Re-running the generator produces byte-identical PNGs.

ambientCG and Kenney nature packs were considered (per the agent brief)
but rejected because:

1. The minimum useful ambientCG bark zip (Bark012 1K) is ~19 MB before
   extraction, and palette-quantizing it to the locked forest 8-color
   palette would need ImageMagick (not installed in this workspace) or a
   second tool chain.
2. Procedural generation guarantees palette-neutrality on the first try
   (see "Palette" below) and is CI-reproducible.

No third-party assets were downloaded; no attribution is required.

The generator itself is original code, MIT-licensed alongside the
repository.

## Palette

Both textures are pure-luminance (single grayscale channel encoded as
RGB triplet for PNG compatibility, sRGB color space). They contain no
color information.

This is critical for palette discipline: the locked 8-color forest
palette in `docs/FOREST_VISUAL_STYLE.md` requires "no off-palette
colors." When a luminance texture is bound as `MeshStandardMaterial.map`
the GPU multiplies it pointwise by `material.color` (a palette slot)
plus `material.emissive`. The result is therefore always a shaded
variation of the existing palette slot — never a new hue. The squint
test passes by construction.

Verified slots that consume these textures (in `src/arenaDecor.js`):

| Builder | Body (bark) tint | Tip (leaves) tint | Tip emissive |
|---------|------------------|-------------------|--------------|
| `_buildGladeDecor`           | `0x2d3a55` (slot 2) | `0x5f8fb5` (slot 3) | `0x7df0c4` (slot 4) |
| `_buildSapHollowDecor`       | `0x2d3a55` (slot 2) | n/a (no tips)       | n/a |
| `_buildCrystalChoirDecor`    | `0x2d3a55` (slot 2) | `0x5f8fb5` (slot 3) | `0x7df0c4` (slot 4) |
| `_buildAmberLabyrinthDecor`  | `0x1a1e22` (slot 1) | `0x5f8fb5` (slot 3) | `0xf5a300` (slot 6) |

## Tiling parameters

Set in `src/arenaDecor.js` at texture load time:

- `wrapS = wrapT = THREE.RepeatWrapping`
- `anisotropy = min(8, renderer.capabilities.getMaxAnisotropy())`
- `colorSpace = THREE.SRGBColorSpace`
- Bark `repeat.set(1, 4)` (tall vertical run on trunks)
- Leaves `repeat.set(2, 2)` (denser pattern on the cone tips)

## License

This project's LICENSE (MIT). No third-party content included; nothing
extra to attribute.
