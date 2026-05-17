#!/usr/bin/env bash
# fetch-tree-textures.sh — FOREST-V2-A32 / PHASE 3 P3A
#
# Generates two tileable luminance textures for the forest decor "tree" pack:
#   assets/textures/forest_bark_512.png   — bark surface (vertical cracks + noise)
#   assets/textures/forest_leaves_512.png — leaf/facet speckle (lattice + grain)
#
# Both are pure-luminance (grayscale, sRGB) so the per-room material `color:`
# tint multiplies cleanly and the locked 8-color forest palette is preserved
# byte-for-byte. No new hues are introduced. See assets/textures/README.md.
#
# Why procedural instead of downloading ambientCG / Kenney?
#   1. WSL2 download budget burned by 19 MB+ 1K bark zips that still need
#      palette-quantization to fit the 500 KB total budget.
#   2. ImageMagick is not installed in this workspace; quantization would
#      need a second tool chain.
#   3. Procedural generation guarantees palette-neutrality on the first try
#      and is fully deterministic (CI-reproducible, byte-stable).
#
# Output size budget: ≤500 KB total. PNG-8 grayscale; expect ~10-25 KB each.
#
# Usage:  bash scripts/fetch-tree-textures.sh

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

mkdir -p assets/textures

node tools/_gen_tree_textures.mjs

echo "[fetch-tree-textures] generated:"
ls -la assets/textures/forest_bark_512.png assets/textures/forest_leaves_512.png
TOTAL=$(du -cb assets/textures/forest_bark_512.png assets/textures/forest_leaves_512.png 2>/dev/null | tail -1 | awk '{print $1}')
echo "[fetch-tree-textures] total bytes: $TOTAL (budget: 500000)"
test "$TOTAL" -lt 500000 || { echo "[fetch-tree-textures] OVER BUDGET"; exit 1; }
