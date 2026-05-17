# Forest Textures (PHASE 3 P3A + P3B — FOREST-V2-A32/A33)

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

## P3B addendum — stone texture (FOREST-V2-A33, PR #137)

Added one additional procedural texture for the forest landmark + coffin
stone surfaces (shrine base, shrine obelisk, altar pedestal, altar pillar,
coffin lid, coffin base). Same generator pattern as P3A:

| File | Size | Use |
|------|------|-----|
| `forest_stone_512.png` | 256×256 grayscale PNG-8 (~41 KB) | `MeshStandardMaterial.map` on shrine/altar/coffin solid surfaces |

Generator: `tools/_gen_stone_texture.mjs` — mulberry32(0x57104E55) seeded,
4-octave value-noise fBm centered near luminance 0.70, 10 Bresenham crack
hairlines, 5% moss-speck density. Re-running yields a byte-identical PNG.

Tiling parameters (set in `src/forestLandmarks.js` and `src/forestCoffins.js`):

- `wrapS = wrapT = THREE.RepeatWrapping`
- `repeat.set(1, 1)` — small surfaces, no tiling needed
- `anisotropy = 8`
- `colorSpace = THREE.SRGBColorSpace`

Palette: same luminance-only contract as P3A. The shared texture is
multiplied into the existing palette slot color (slot-1 bone `0xc7b89a`
for the altar pillar + coffin lid; slot-3 brown `0x6b4f3a` for the shrine
base, altar pedestal, and coffin base; slot-2 green `0x4a7a4a` for the
shrine obelisk). No new hex constants. Squint test holds.

The texture instance is a module-private singleton inside each consumer
file so the loader fires exactly once per scene (`TextureLoader.load` is
cached, but the wrap/anisotropy setup runs only once either way).

## P3D addendum — sky-dome gradient textures (FOREST-V2-A34, PR #138)

Five 256×128 RGB sRGB vertical-gradient PNGs (`sky_midday.png`,
`sky_golden.png`, `sky_dusk.png`, `sky_twilight.png`, `sky_bloodmoon.png`)
consumed by `src/forestSkyDome.js`. Each file is ~0.5 KB (~2.5 KB total)
thanks to identical-row PNG filtering on a pure vertical gradient.
Generator: `tools/_gen_sky_textures.mjs`. Palette: atmospheric slot set
(BONE/DARK/AMBER/GOLD + slot-7 0xffd86b + cohort 20 reaper 0xff2020) —
no new hex constants. ShaderMaterial crossfades over 3s on day/night
phase change. `ClampToEdgeWrapping`, `LinearFilter`, `anisotropy = 8`,
`colorSpace = SRGBColorSpace`.

## License

This project's LICENSE (MIT). No third-party content included; nothing
extra to attribute.
