# Forest Ambient Music — Attribution

All source samples are CC0 (public domain) from Kenney.nl audio packs. No
attribution is legally required, but credited here for provenance traceability.

## Sources

- **Kenney — Sci-Fi Sounds** (CC0)
  https://kenney.nl/assets/sci-fi-sounds
  - `spaceEngineLow_000.ogg` → base drone for `forest_midday.ogg` (pitched +5%)
  - `spaceEngineLow_000.ogg` + `spaceEngineLow_002.ogg` → layered drone bed
    for `forest_golden.ogg`
  - `spaceEngineLow_001.ogg` + `spaceEngineLow_003.ogg` → layered drone bed
    for `forest_dusk.ogg` (pitched -15% / -25%)
  - `spaceEngineLow_002.ogg` + `spaceEngineLow_004.ogg` → detuned layered
    drone for `forest_twilight.ogg` (pitched -30% / -28%, slight beating
    creates harmonic tension)
  - `spaceEngineLow_003.ogg` → sub-pitched (-45%) rumble bed for
    `forest_bloodmoon.ogg`
  - `lowFrequency_explosion_000.ogg` → low-pass-filtered heartbeat layer in
    `forest_bloodmoon.ogg` (one strike every ~3.5s across the 46s loop)

## Tracks

| Phase     | File                          | Use                            |
|-----------|-------------------------------|--------------------------------|
| MIDDAY    | `forest_midday.ogg`           | 0 – 600s (bright, peaceful)    |
| GOLDEN    | `forest_golden.ogg`           | 600 – 1200s (warm, mid-tempo)  |
| DUSK      | `forest_dusk.ogg`             | 1200 – 1740s (slower, ambient) |
| TWILIGHT  | `forest_twilight.ogg`         | 1740 – 1800s (tense, dissonant)|
| BLOODMOON | `forest_bloodmoon.ogg`        | 1800s+ (ominous + heartbeat)   |

## Processing

All files rendered with ffmpeg 7.0.2-static using `scripts/process-music.sh`:

- Per-phase EQ: highpass / lowpass tuned to brighten or darken the drone.
- Pitch shift: `asetrate=44100*<scale>` warps the sustained engine drone
  into pitched ambient texture (5s loop → minutes of continuous sound).
- Atempo: `atempo` rebalances duration after pitch shift.
- Phase mood:
  - midday: +5% pitch, highpass 180Hz, lowpass 2.2kHz (bright)
  - golden: -2% pitch, highpass 120Hz, lowpass 1.8kHz (warm)
  - dusk:   -15% pitch, lowpass 1.2kHz, sub-layer at -25% (darker)
  - twilight: -30% pitch, two detuned layers (-30% and -28%) create beating
  - bloodmoon: -45% pitch, heartbeat layer (lowFrequency_explosion @ 3.5s)
- Encoding: `libvorbis q=3`, mono, 22050Hz (~3.2KB/s) — total 620KB for
  5 tracks of ~46s each.
- Loudness: `loudnorm I=-20:LRA=8:TP=-2.0` — music sits ~4 LUFS below the
  SFX bus (-16 LUFS) so it never drowns gameplay.
- Seamless loop: rendered 50s of source, split into head[0,6] / body[6,44]
  / tail[44,50], `acrossfade d=4 c1=tri c2=tri` over tail→head produces a
  4s xfade region, concatenated with body[6,44]. At loop boundary the file's
  end (raw[44]) flows back to the xfade region (raw[44] + raw[6]) — both are
  the same continuous drone so the join is inaudible.

## Rebuild

```sh
scripts/fetch-music.sh       # ensures raw packs exist (calls fetch-audio.sh)
scripts/process-music.sh     # re-renders all 5 phase tracks
```

Both scripts are idempotent. Edit the per-phase filter chain in
`process-music.sh`, re-run, only that track regenerates.
