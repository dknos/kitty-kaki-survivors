#!/usr/bin/env bash
# fetch-music.sh — FOREST-V2-A18 ambient music layers.
#
# All source samples are CC0 Kenney pack content already fetched by
# `scripts/fetch-audio.sh`. We do NOT pull a new pack here because:
#
#   - kenney.nl/assets/music-loops + /music-pack pages are JS-rendered and
#     their CDN URLs are version-stamped (cache-busted), so a static URL
#     bakes in a 404 risk. The existing sci-fi + jingles packs already
#     yield enough drone + tonal material to compose 5 short phase loops.
#   - 40s phase loops at mono 22050Hz q=3 vorbis come in ~110-150KB each,
#     leaving ~1MB headroom under the 2MB budget — no need for full music
#     pack tracks.
#
# This script just shells out to `process-music.sh` which performs the
# real work (ffmpeg layer + acrossfade-stitch + loudnorm pipeline). Kept
# as a separate entry point so contributors can rebuild raw music assets
# the same way `scripts/fetch-audio.sh` + `scripts/process-audio.sh` work.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Make sure raw packs exist (idempotent fetch).
if [ ! -d "${KK_AUDIO_RAW_DIR:-/tmp/kk_audio_raw}/scifi_pack" ]; then
  "$ROOT/scripts/fetch-audio.sh"
fi

# Render the 5 phase music loops.
exec "$ROOT/scripts/process-music.sh"
