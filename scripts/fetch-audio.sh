#!/usr/bin/env bash
# fetch-audio.sh — idempotent download + extract of Kenney audio packs.
# All packs are CC0 (Creative Commons Zero). Re-running is safe.
#
# Output: /tmp/kk_audio_raw/<pack>/Audio/<file>.ogg
# Used by: scripts/process-audio.sh (which reads from /tmp/kk_audio_raw).
set -euo pipefail

OUT_DIR="${KK_AUDIO_RAW_DIR:-/tmp/kk_audio_raw}"
mkdir -p "$OUT_DIR"
cd "$OUT_DIR"

declare -A PACKS=(
  [impact]="https://kenney.nl/media/pages/assets/impact-sounds/8aa7b545c9-1677589768/kenney_impact-sounds.zip"
  [interface]="https://kenney.nl/media/pages/assets/interface-sounds/d23a84242e-1677589452/kenney_interface-sounds.zip"
  [rpg]="https://kenney.nl/media/pages/assets/rpg-audio/706161bc16-1677590336/kenney_rpg-audio.zip"
  [scifi]="https://kenney.nl/media/pages/assets/sci-fi-sounds/e3af5f7ed7-1677589334/kenney_sci-fi-sounds.zip"
  [casino]="https://kenney.nl/media/pages/assets/casino-audio/f578a13f51-1721639069/kenney_casino-audio.zip"
  [uiaudio]="https://kenney.nl/media/pages/assets/ui-audio/e19c9b1814-1677590494/kenney_ui-audio.zip"
  [digital]="https://kenney.nl/media/pages/assets/digital-audio/7492b26e77-1677590265/kenney_digital-audio.zip"
  [jingles]="https://kenney.nl/media/pages/assets/music-jingles/4f5dd770b7-1677590399/kenney_music-jingles.zip"
)

for name in "${!PACKS[@]}"; do
  zip="${name}.zip"
  pack_dir="${name}_pack"
  if [ -d "$pack_dir" ]; then
    echo "[skip] $name (already extracted at $pack_dir/)"
    continue
  fi
  if [ ! -f "$zip" ]; then
    echo "[wget] ${PACKS[$name]}"
    wget -q "${PACKS[$name]}" -O "$zip"
  fi
  echo "[unzip] $zip -> $pack_dir/"
  mkdir -p "$pack_dir"
  unzip -q "$zip" -d "$pack_dir"
done

echo "[done] $OUT_DIR"
