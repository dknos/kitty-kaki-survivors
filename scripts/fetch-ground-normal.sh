#!/usr/bin/env bash
# fetch-ground-normal.sh — FOREST-V2-A35 / PHASE 3 P3E
#
# Generates the procedural tangent-space normal map applied to the forest
# stage ground plane in src/env.js (PR #139):
#   assets/textures/forest_ground_normal_512.png — fBm heightmap + pebbles
#
# Palette-neutral (normal data only — no albedo or hue). Replaces the
# 1.4 MB Poly Haven `nor_gl.jpg` previously loaded from
# assets/sprites/forrest_ground_01/. The diff + rough JPGs from the
# Poly Haven pack are retained.
#
# Why procedural instead of downloading a denser ambientCG / Poly Haven map?
# Same rationale as scripts/fetch-tree-textures.sh + fetch-stone-texture.sh
# (WSL2 download budget, no ImageMagick for palette quantization,
# procedural generation is byte-deterministic + CI-reproducible).
#
# Output size budget: <150 KB. PNG-8 RGB (no alpha); expect ~100 KB.
#
# Usage:  bash scripts/fetch-ground-normal.sh

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

mkdir -p assets/textures

node tools/_gen_ground_normal.mjs

echo "[fetch-ground-normal] generated:"
ls -la assets/textures/forest_ground_normal_512.png
TOTAL=$(stat -c%s assets/textures/forest_ground_normal_512.png)
echo "[fetch-ground-normal] bytes: $TOTAL (budget: 150000)"
test "$TOTAL" -lt 150000 || { echo "[fetch-ground-normal] OVER BUDGET"; exit 1; }
