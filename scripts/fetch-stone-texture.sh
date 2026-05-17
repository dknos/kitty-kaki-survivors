#!/usr/bin/env bash
# fetch-stone-texture.sh — FOREST-V2-A33 / PHASE 3 P3B
#
# Generates the single stone texture consumed by shrine/altar/coffin
# materials in src/forestLandmarks.js and src/forestCoffins.js:
#   assets/textures/forest_stone_512.png — granite mottle + crack hairlines
#
# Pure-luminance (grayscale, sRGB) so the per-surface `color:` palette tint
# multiplies cleanly and the locked 8-color forest palette is preserved
# byte-for-byte. No new hues are introduced. See assets/textures/README.md.
#
# Why procedural instead of downloading ambientCG / Kenney?
# Same rationale as scripts/fetch-tree-textures.sh — WSL2 download budget,
# no ImageMagick for palette quantization, and procedural generation is
# byte-deterministic + CI-reproducible.
#
# Output size budget: <100 KB. PNG-8 grayscale; expect ~30-50 KB.
#
# Usage:  bash scripts/fetch-stone-texture.sh

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

mkdir -p assets/textures

node tools/_gen_stone_texture.mjs

echo "[fetch-stone-texture] generated:"
ls -la assets/textures/forest_stone_512.png
TOTAL=$(stat -c%s assets/textures/forest_stone_512.png)
echo "[fetch-stone-texture] bytes: $TOTAL (budget: 100000)"
test "$TOTAL" -lt 100000 || { echo "[fetch-stone-texture] OVER BUDGET"; exit 1; }
