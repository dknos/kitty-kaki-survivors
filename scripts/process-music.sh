#!/usr/bin/env bash
# process-music.sh — FOREST-V2-A18 day/night phase ambient music renderer.
#
# Builds 5 seamless ~40s music loops under assets/music/ from CC0 Kenney
# spaceEngineLow drones (sci-fi pack). Each phase gets distinct mood via
# pitch shift + EQ + optional sub layer:
#
#   midday    — bright drone (pitched +5%), high-pass 180Hz, peaceful
#   golden    — warm drone (slight pitch down), mid EQ bias
#   dusk      — slower drone (atempo 0.85), low-pass 1.2kHz, darker
#   twilight  — two detuned drones layered, tense, low volume
#   bloodmoon — sub-pitched drone + lowFrequency_explosion heartbeat
#
# Loop seam: render 45s, split into head[0,5] + body[5,40] + tail[40,45],
# acrossfade tail→head over 5s (triangle curves), concat xfade5+body35.
# Result is 40s. Looped, the file's natural end (orig [35,40]) flows into
# the file's xfaded start (which is tail→head xfaded — both segments come
# from the same continuous source so the join is inaudible).
#
# Output: assets/music/forest_<phase>.ogg (mono, 22050Hz, libvorbis q=3).
# Loudness target: -20 LUFS (music sits ~4 LUFS below SFX bus).
#
# Re-runnable. Each phase regenerates its own target file. ~30s total.

set -euo pipefail

RAW_DIR="${KK_AUDIO_RAW_DIR:-/tmp/kk_audio_raw}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/assets/music"
TMP_DIR="$(mktemp -d -t kk-music-XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

if [ ! -d "$RAW_DIR/scifi_pack" ]; then
  echo "ERROR: raw scifi_pack not found at $RAW_DIR/scifi_pack (run scripts/fetch-audio.sh first)" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

# Shared encoding flags.
ENC_OPTS=( -ac 1 -ar 22050 -c:a libvorbis -q:a 3 )

# Render a seamless 40s loop from a "raw 50s already-processed track" file.
# Args: $1 = raw50 input path, $2 = final output path.
#
# Method: split raw50 into head[0,6], body[6,44], tail[44,50], then acrossfade
# tail→head over 4s (acrossfade needs xfade-duration < input duration; the 6s
# head/tail with 4s xfade gives 2s of pre/post-fade headroom so the filter
# doesn't underflow even if atrim rounds the duration short by ~10ms).
# Concat xfade + body[2,38] (skip the 2s overlap region inside body so the
# combined output is xfade_duration + body_skipped = 38 + 38 = wait, let me
# re-derive:
#   xfade output = 4s (the crossfade region only — c1=c2=tri).
#   body         = 38s (from raw [6,44]).
#   total output = 42s. Loop-cycle = 42s.
#   At loop boundary: file ends at raw[44] (the end of body), restarts at
#   xfade which begins playing raw[44] (start of tail) crossfading with raw[6]
#   (start of head). Since raw is a continuous drone, raw[44] is identical
#   waveform to itself — no seam.
render_loop() {
  local raw50="$1" outfile="$2"
  local d="$TMP_DIR/$(basename "$outfile" .ogg)"
  ffmpeg -y -hide_banner -loglevel error -i "$raw50" -af "atrim=duration=6"            "${ENC_OPTS[@]}" "${d}_head.ogg"
  ffmpeg -y -hide_banner -loglevel error -i "$raw50" -af "atrim=start=6:duration=38"   "${ENC_OPTS[@]}" "${d}_body.ogg"
  ffmpeg -y -hide_banner -loglevel error -i "$raw50" -af "atrim=start=44:duration=6"   "${ENC_OPTS[@]}" "${d}_tail.ogg"
  ffmpeg -y -hide_banner -loglevel error -i "${d}_tail.ogg" -i "${d}_head.ogg" \
    -filter_complex "[0:a][1:a]acrossfade=d=4:c1=tri:c2=tri[out]" \
    -map "[out]" "${ENC_OPTS[@]}" "${d}_xfade.ogg"
  local concat="${d}_concat.txt"
  printf "file '%s'\nfile '%s'\n" "${d}_xfade.ogg" "${d}_body.ogg" > "$concat"
  ffmpeg -y -hide_banner -loglevel error -f concat -safe 0 -i "$concat" \
    -af "loudnorm=I=-20:LRA=8:TP=-2.0" \
    "${ENC_OPTS[@]}" "$outfile"
}

# ─── MIDDAY ─────────────────────────────────────────────────────────────
# Bright peaceful drone: highpass 180Hz, gentle lowpass 2.2kHz, +5% pitch.
echo "[music] midday"
ffmpeg -y -hide_banner -loglevel error \
  -stream_loop 9 -i "$RAW_DIR/scifi_pack/Audio/spaceEngineLow_000.ogg" \
  -filter_complex "[0:a]asetrate=44100*1.05,atempo=0.95,highpass=f=180,lowpass=f=2200,volume=0.55[a]" \
  -map "[a]" -t 50 "${ENC_OPTS[@]}" "$TMP_DIR/midday_raw.ogg"
render_loop "$TMP_DIR/midday_raw.ogg" "$OUT_DIR/forest_midday.ogg"

# ─── GOLDEN HOUR ────────────────────────────────────────────────────────
# Warm mid-tempo: highpass 120Hz, lowpass 1.8kHz, slight pitch down for
# warmth + atempo 1.0. Layer spaceEngineLow_002 underneath at lower vol.
echo "[music] golden"
ffmpeg -y -hide_banner -loglevel error \
  -stream_loop 9 -i "$RAW_DIR/scifi_pack/Audio/spaceEngineLow_000.ogg" \
  -stream_loop 9 -i "$RAW_DIR/scifi_pack/Audio/spaceEngineLow_002.ogg" \
  -filter_complex "[0:a]asetrate=44100*0.98,highpass=f=120,lowpass=f=1800,volume=0.50[a]; \
                   [1:a]asetrate=44100*0.92,highpass=f=90,lowpass=f=900,volume=0.30[b]; \
                   [a][b]amix=inputs=2:duration=longest:normalize=0[mix]" \
  -map "[mix]" -t 50 "${ENC_OPTS[@]}" "$TMP_DIR/golden_raw.ogg"
render_loop "$TMP_DIR/golden_raw.ogg" "$OUT_DIR/forest_golden.ogg"

# ─── DUSK ───────────────────────────────────────────────────────────────
# Slower ambient pad: atempo 0.85, low-pass 1.2kHz, sub layer.
echo "[music] dusk"
ffmpeg -y -hide_banner -loglevel error \
  -stream_loop 9 -i "$RAW_DIR/scifi_pack/Audio/spaceEngineLow_001.ogg" \
  -stream_loop 9 -i "$RAW_DIR/scifi_pack/Audio/spaceEngineLow_003.ogg" \
  -filter_complex "[0:a]asetrate=44100*0.85,atempo=1.05,highpass=f=80,lowpass=f=1200,volume=0.48[a]; \
                   [1:a]asetrate=44100*0.75,highpass=f=55,lowpass=f=600,volume=0.32[b]; \
                   [a][b]amix=inputs=2:duration=longest:normalize=0[mix]" \
  -map "[mix]" -t 50 "${ENC_OPTS[@]}" "$TMP_DIR/dusk_raw.ogg"
render_loop "$TMP_DIR/dusk_raw.ogg" "$OUT_DIR/forest_dusk.ogg"

# ─── TWILIGHT ───────────────────────────────────────────────────────────
# Tense low strings: two detuned drone layers create a subtle beating; very
# low frequencies, no high content. Only 60s budget (twilight window is 60s
# real time anyway), but we still render 40s loop for safety.
echo "[music] twilight"
ffmpeg -y -hide_banner -loglevel error \
  -stream_loop 9 -i "$RAW_DIR/scifi_pack/Audio/spaceEngineLow_002.ogg" \
  -stream_loop 9 -i "$RAW_DIR/scifi_pack/Audio/spaceEngineLow_004.ogg" \
  -filter_complex "[0:a]asetrate=44100*0.70,atempo=1.08,highpass=f=60,lowpass=f=900,volume=0.50[a]; \
                   [1:a]asetrate=44100*0.72,atempo=1.06,highpass=f=55,lowpass=f=700,volume=0.45[b]; \
                   [a][b]amix=inputs=2:duration=longest:normalize=0[mix]" \
  -map "[mix]" -t 50 "${ENC_OPTS[@]}" "$TMP_DIR/twilight_raw.ogg"
render_loop "$TMP_DIR/twilight_raw.ogg" "$OUT_DIR/forest_twilight.ogg"

# ─── BLOOD MOON ─────────────────────────────────────────────────────────
# Ominous drone + percussion heartbeat. spaceEngineLow pitched WAY down
# for sub-rumble + lowFrequency_explosion looped every ~3.5s as heartbeat
# layer. Highest impact phase — needs to grab attention.
#
# Build heartbeat: lowFrequency_explosion_000.ogg is ~0.8s, layer two
# slightly-offset copies at -8dB into a 45s bed with adelay every 3.5s.
echo "[music] bloodmoon"
# First: drone bed (50s)
ffmpeg -y -hide_banner -loglevel error \
  -stream_loop 14 -i "$RAW_DIR/scifi_pack/Audio/spaceEngineLow_003.ogg" \
  -filter_complex "[0:a]asetrate=44100*0.55,atempo=1.10,highpass=f=40,lowpass=f=650,volume=0.55[bed]" \
  -map "[bed]" -t 50 "${ENC_OPTS[@]}" "$TMP_DIR/bm_bed.ogg"
# Heartbeat: place lowFrequency_explosion at t=2,5.5,9,12.5,16,19.5,23,26.5,30,33.5,37,40.5,44 (every ~3.5s)
# adelay needs ms per channel. Mono = single ms arg.
ffmpeg -y -hide_banner -loglevel error \
  -i "$RAW_DIR/scifi_pack/Audio/lowFrequency_explosion_000.ogg" \
  -i "$RAW_DIR/scifi_pack/Audio/lowFrequency_explosion_000.ogg" \
  -i "$RAW_DIR/scifi_pack/Audio/lowFrequency_explosion_000.ogg" \
  -i "$RAW_DIR/scifi_pack/Audio/lowFrequency_explosion_000.ogg" \
  -i "$RAW_DIR/scifi_pack/Audio/lowFrequency_explosion_000.ogg" \
  -i "$RAW_DIR/scifi_pack/Audio/lowFrequency_explosion_000.ogg" \
  -i "$RAW_DIR/scifi_pack/Audio/lowFrequency_explosion_000.ogg" \
  -i "$RAW_DIR/scifi_pack/Audio/lowFrequency_explosion_000.ogg" \
  -i "$RAW_DIR/scifi_pack/Audio/lowFrequency_explosion_000.ogg" \
  -i "$RAW_DIR/scifi_pack/Audio/lowFrequency_explosion_000.ogg" \
  -i "$RAW_DIR/scifi_pack/Audio/lowFrequency_explosion_000.ogg" \
  -i "$RAW_DIR/scifi_pack/Audio/lowFrequency_explosion_000.ogg" \
  -i "$RAW_DIR/scifi_pack/Audio/lowFrequency_explosion_000.ogg" \
  -i "$RAW_DIR/scifi_pack/Audio/lowFrequency_explosion_000.ogg" \
  -filter_complex "
    [0:a]adelay=2000:all=1,volume=0.40[h0];
    [1:a]adelay=5500:all=1,volume=0.40[h1];
    [2:a]adelay=9000:all=1,volume=0.40[h2];
    [3:a]adelay=12500:all=1,volume=0.40[h3];
    [4:a]adelay=16000:all=1,volume=0.40[h4];
    [5:a]adelay=19500:all=1,volume=0.40[h5];
    [6:a]adelay=23000:all=1,volume=0.40[h6];
    [7:a]adelay=26500:all=1,volume=0.40[h7];
    [8:a]adelay=30000:all=1,volume=0.40[h8];
    [9:a]adelay=33500:all=1,volume=0.40[h9];
    [10:a]adelay=37000:all=1,volume=0.40[h10];
    [11:a]adelay=40500:all=1,volume=0.40[h11];
    [12:a]adelay=44000:all=1,volume=0.40[h12];
    [13:a]adelay=47500:all=1,volume=0.40[h13];
    [h0][h1][h2][h3][h4][h5][h6][h7][h8][h9][h10][h11][h12][h13]amix=inputs=14:duration=longest:normalize=0,
    lowpass=f=200,volume=1.3,atrim=duration=50[hb]
  " -map "[hb]" "${ENC_OPTS[@]}" "$TMP_DIR/bm_heartbeat.ogg"
# Combine bed + heartbeat
ffmpeg -y -hide_banner -loglevel error \
  -i "$TMP_DIR/bm_bed.ogg" -i "$TMP_DIR/bm_heartbeat.ogg" \
  -filter_complex "[0:a][1:a]amix=inputs=2:duration=first:normalize=0[mix]" \
  -map "[mix]" -t 50 "${ENC_OPTS[@]}" "$TMP_DIR/bloodmoon_raw.ogg"
render_loop "$TMP_DIR/bloodmoon_raw.ogg" "$OUT_DIR/forest_bloodmoon.ogg"

# ─── Report ─────────────────────────────────────────────────────────────
echo
echo "[music] rendered into $OUT_DIR:"
ls -la "$OUT_DIR"/*.ogg
total=$(du -cb "$OUT_DIR"/*.ogg | tail -1 | awk '{print $1}')
echo
echo "[music] total size: $total bytes ($(awk "BEGIN{printf \"%.1f\", $total/1024}")KB)"
echo "[music] budget: 2097152 bytes (2MB)"
if [ "$total" -gt 2097152 ]; then
  echo "[music] WARNING: over budget!" >&2
fi
