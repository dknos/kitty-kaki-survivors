#!/usr/bin/env bash
# process-audio.sh — manifest-driven ffmpeg pipeline that turns the Kenney raw
# packs at /tmp/kk_audio_raw/ into game-ready Ogg Vorbis samples under
# assets/audio/<category>/.
#
# Each manifest row: BUCKET|SOURCE_REL|TARGET_NAME|FFMPEG_FILTERS
#   - BUCKET     : audio.js sfx bucket (drives target subdir via BUCKET_DIR map)
#   - SOURCE_REL : path under /tmp/kk_audio_raw/
#   - TARGET_NAME: filename written to assets/audio/<dir>/
#   - FFMPEG_FILTERS: -af filter chain (silenceremove/loudnorm/asetrate/atempo/aecho)
#
# Re-runnable: each row regenerates its target file. Edit a filter, re-run,
# diff one row instead of the whole pack.
set -euo pipefail

RAW_DIR="${KK_AUDIO_RAW_DIR:-/tmp/kk_audio_raw}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_ROOT="$ROOT/assets/audio"
MANIFEST="$ROOT/scripts/audio_manifest.txt"

if [ ! -d "$RAW_DIR" ]; then
  echo "ERROR: raw dir not found: $RAW_DIR  (run scripts/fetch-audio.sh first)" >&2
  exit 1
fi
if [ ! -f "$MANIFEST" ]; then
  echo "ERROR: manifest not found: $MANIFEST" >&2
  exit 1
fi

# Bucket -> output subdirectory map (kept here so manifest stays compact).
declare -A BUCKET_DIR=(
  [shoot]=cast [weaponChain]=cast [weaponAutoaim]=cast [weaponBomb]=cast
  [weaponWeb]=cast [weaponDash]=cast [weaponBurger]=cast
  [hit]=hit [enemyHurt]=hit [enemyDeath]=hit [eliteDeath]=hit
  [heroHurt]=hit [heroHit]=hit
  [pickup]=pickup [coinPickup]=pickup [heartPickup]=pickup
  [starPickup]=pickup [chestOpen]=pickup
  [levelUp]=levelup
  [death]=death [heroDeath]=death [explosion]=death
  [bossWarn]=boss [bossSpawn]=boss [bossShockwave]=boss
  [victory]=levelup
  # Iter 18 — UI SFX bouquet (Kenney Interface pack, CC0).
  [uiClick]=ui [uiCancel]=ui [uiHover]=ui [uiError]=ui
  [modalOpen]=ui [modalClose]=ui
  # FOREST-V2-A13 (#117) — Forest-event SFX layer (Kenney CC0).
  # Economy / level-up QoL distinct cues — route to ui/.
  [reroll]=ui [banish]=ui [skipHeal]=ui
  # Forest-specific cues — route to forest/.
  [reaperWarn]=forest [reaperSpawn]=forest [coffinOpen]=forest [landmarkActivate]=forest
  # Forest pickup chimes — route to pickup/.
  [bombPickup]=pickup [magnetPickup]=pickup [chickenPickup]=pickup
  # Stage-agnostic evolution chime — route to fx/ (matches existing manifest path).
  [evolutionChime]=fx
)

# Common loudness/trim chain prepended to every row to guarantee tight
# attack + consistent peak (-1 dBFS) so the runtime gain budget is honest.
TRIM_NORM="silenceremove=start_periods=1:start_silence=0.02:start_threshold=-50dB,volume=0.92"

count=0
fail=0
trim() {
  local s="$1"
  # strip leading whitespace
  s="${s#"${s%%[![:space:]]*}"}"
  # strip trailing whitespace
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}
while IFS='|' read -r bucket src target filters; do
  bucket="$(trim "$bucket")"
  case "$bucket" in '#'*|'') continue ;; esac
  src="$(trim "$src")"
  target="$(trim "$target")"
  filters="$(trim "$filters")"

  dir="${BUCKET_DIR[$bucket]:-}"
  if [ -z "$dir" ]; then
    echo "[warn] unknown bucket: $bucket — skipping $target" >&2
    continue
  fi
  in_path="$RAW_DIR/$src"
  out_path="$OUT_ROOT/$dir/$target"
  if [ ! -f "$in_path" ]; then
    echo "[miss] $in_path" >&2
    fail=$((fail+1))
    continue
  fi
  mkdir -p "$OUT_ROOT/$dir"
  chain="$TRIM_NORM"
  [ -n "$filters" ] && chain="$chain,$filters"
  # Mono + Ogg Vorbis ~96kbps (q4 ≈ 128kbps; q2 ≈ 96kbps).
  ffmpeg -y -hide_banner -loglevel error \
    -i "$in_path" -ac 1 -af "$chain" -c:a libvorbis -q:a 2 "$out_path"
  count=$((count+1))
  printf "  %-18s %-12s %s\n" "$bucket" "$dir/" "$target"
done < "$MANIFEST"

echo
echo "[done] processed=$count fail=$fail"
echo "[size] $(du -sh "$OUT_ROOT" | cut -f1) total under assets/audio/"
