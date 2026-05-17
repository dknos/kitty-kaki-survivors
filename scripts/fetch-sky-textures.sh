#!/usr/bin/env bash
# fetch-sky-textures.sh — FOREST-V2-A34 / PHASE 3 P3D
#
# Generates the five sky-dome gradient textures consumed by
# src/forestSkyDome.js:
#   assets/textures/sky_midday.png       — bone → white
#   assets/textures/sky_golden.png       — slot-6 gold → slot-7 amber
#   assets/textures/sky_dusk.png         — slot-4 dark → slot-5 amber
#   assets/textures/sky_twilight.png     — slot-4 deep → near-black + thin slot-5 band
#   assets/textures/sky_bloodmoon.png    — #ff2020 → slot-4 → black
#
# Pure procedural — no downloads. Same rationale as fetch-tree-textures.sh /
# fetch-stone-texture.sh (WSL2 download budget, deterministic CI repro, no
# new hex constants required). Mostly vertical gradients with no per-pixel
# noise — PNG compression collapses each file to <1 KB.
#
# Output size budget: <200 KB total. Expect ~2.5 KB combined.
#
# Usage:  bash scripts/fetch-sky-textures.sh

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

mkdir -p assets/textures

node tools/_gen_sky_textures.mjs

echo "[fetch-sky-textures] generated:"
ls -la assets/textures/sky_*.png
TOTAL=0
for f in assets/textures/sky_midday.png assets/textures/sky_golden.png \
         assets/textures/sky_dusk.png   assets/textures/sky_twilight.png \
         assets/textures/sky_bloodmoon.png; do
  SZ=$(stat -c%s "$f")
  TOTAL=$((TOTAL + SZ))
done
echo "[fetch-sky-textures] bytes total: $TOTAL (budget: 200000)"
test "$TOTAL" -lt 200000 || { echo "[fetch-sky-textures] OVER BUDGET"; exit 1; }
