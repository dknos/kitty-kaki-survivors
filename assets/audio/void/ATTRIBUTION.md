# Void Stage Audio — Attribution

All Kenney source samples are CC0 (public domain) from Kenney.nl audio packs.
No attribution is legally required, but credited here for provenance
traceability. The cosmic-drone bed in `void_ambient.ogg` is fully synthesized
(numpy sine + FM bell + envelope-modulated sweep) so the void can sound
distinctly "silent / vacuum" in a way the Kenney engine/wind beds the other
stages use cannot. Synthesized layers ship under the repo's MIT license.

## Sources

### CC0 Kenney layers
- **Kenney — Sci-Fi Sounds** (CC0)
  https://kenney.nl/assets/sci-fi-sounds
  - `forceField_001.ogg` → reality-tear shimmer A in `void_ambient.ogg` at
    t≈18 s (pitched 1.45x via `asetrate=63945,aresample=44100`, highpass
    1.5 kHz, vol 0.55 with a 0.05 s fade-in + 0.30 s tail — "glassy sliver"
    crackle as the void itself flickers).
  - `forceField_003.ogg` → reality-tear shimmer B in `void_ambient.ogg` at
    t≈37 s (pitched 1.32x via `asetrate=58000`, highpass 1.4 kHz, vol 0.50 —
    a slightly lower shimmer so the two tears across the loop don't sound
    identical).
  - `forceField_002.ogg` → whoosh layer in `void_teleport.ogg` (pitched
    0.78x via `asetrate=34400`, highpass 400 Hz, lowpass 6 kHz, vol 0.85 —
    the rift "opening" — airy sweep, not a hard transient).

- **Kenney — Impact Sounds** (CC0)
  https://kenney.nl/assets/impact-sounds
  - `impactBell_heavy_003.ogg` → chime layer in `void_teleport.ogg` (pitched
    1.30x via `asetrate=57330`, highpass 600 Hz, vol 0.95, delayed 180 ms
    after the whoosh attack — the rift "resolving" bell, cyan-colored tone
    per VOID_VISUAL_STYLE.md §Audio: "clean cyan-colored bell chime layer
    for the rift resolving").
  - `impactBell_heavy_004.ogg` → bell in `void_pad_ready.ogg` (pitched
    1.18x via `asetrate=52000`, highpass 700 Hz, lowpass 5.5 kHz, vol 0.62
    with a tight 0.06 s tail-fade starting at t=0.20 s — short tonal
    "ready" feedback, ~0.27 s total so it sits inside the
    VOID_VISUAL_STYLE.md §Audio 0.2-0.3 s binding range and so 2-3
    simultaneous plays layer cleanly per the style-guide warning).

### Synthesized layers (original, MIT-licensed by this repo)
The full `void_ambient.ogg` drone bed is original synthesis — the Kenney
sci-fi pack ships engine drones with mechanical character (combustion, RPM
shimmer) and the void stage explicitly should NOT read as mechanical. Per
VOID_VISUAL_STYLE.md: "void should feel SILENT in a way no other stage
does" — Kenney sources used only for the shimmer accents over the synth
bed.

- **Sub-bass cosmic drone** (Layer A) — 55 Hz fundamental with a 0.5 Hz
  tremolo (very slow breathing) + a 110 Hz octave overtone at 0.18 gain.
  The fundamental sits at the bottom of the mix so players notice it most
  when they STOP moving. Generated via numpy sine synthesis.
- **Detuned fifth** (Layer B) — 82.5 Hz sine with a 0.3 Hz tremolo plus a
  82.7 Hz partner (0.2 Hz detune beat) — provides a slow shimmer feel from
  the beat-frequency interaction. Original FM sine pair.
- **Vacuum whistle** (Layer C) — very quiet (0.025) 4400 Hz sine with a
  0.18 Hz amplitude tremolo. Sits way at the top of the spectrum as the
  "vacuum" / "empty space" cue.
- **Distant chimes** (Layer D) — FM bell pairs at t≈12 s (880 Hz + 1318 Hz
  perfect-fifth-ish, gain 0.10) and t≈32 s (740 Hz + 1108 Hz, gain 0.085).
  Each pair fires two staggered bells with a 0.4 s gap and `exp(-3.5t)`
  envelope — the "faint distant chimes" called out in VOID_VISUAL_STYLE.md
  §Audio. Quiet enough not to compete with the shimmer accents.
- **Whisper sweeps** (Layer E) — exponential 220→660 Hz sweeps with bell-
  shape `sin²` envelope, gain 0.04, at t=4 s (7.5 s long) and t=24 s
  (8.5 s long). Adds a sense of cosmic distance / motion without ever
  becoming melodic.

## Processing

All assets processed with ffmpeg 7.0.2-static, encoded as Ogg Vorbis:
- **Ambient** normalized to **-22 LUFS** (matches forest + twilight + cinder
  ambient convention — ambient beds sit musically below SFX so the stage
  ambient gain at `0.55` in the audio bus reads cleanly when both procedural
  music and the bed are active. The task brief said "-22 LUFS (matches
  existing ambient convention)" — confirmed against
  `assets/audio/forest/ATTRIBUTION.md`,
  `assets/audio/twilight/ATTRIBUTION.md`, and
  `assets/audio/cinder/ATTRIBUTION.md`).
- **SFX** normalized to **-16 LUFS** (matches existing weapon SFX bus /
  EBU R128 / cinder ballista SFX + twilight fountain SFX).
- `void_ambient.ogg` is a **40 s seamless loop**: 45 s source rendered, last
  5 s cross-faded onto the first 5 s (`acrossfade=d=5:c1=tri:c2=tri`), then
  concatenated with the [5, 45] body — same recipe as forest + twilight +
  cinder ambient. Loop seam smoothness inherited from the 5 s tri-window
  crossfade. The synth bed is intentionally slow-evolving so the seam mask
  is robust against the player-perceived loop point.
- `void_teleport.ogg` is mixed with a **180 ms bell-vs-whoosh stagger** so
  the whoosh "opens" the rift and the bell "resolves" it — two-layer sound
  design called out in VOID_VISUAL_STYLE.md §Audio. Capped at 0.95 s via
  `-t 0.95` so the file fits under the 60 KB SFX budget while preserving the
  bell tail (truncating at 0.85 s clipped the bell decay; 0.95 s reads as a
  cleaner full chime).
- `void_pad_ready.ogg` is **~0.27 s total** (0.02 s silence head + ~0.25 s
  pitched bell with a 0.06 s tail-fade starting at t=0.20 s). Sits inside
  the VOID_VISUAL_STYLE.md §Audio binding range of 0.2-0.3 s — see Spec
  Notes below. The 0.28 gain in `sfx.voidPadReady()` puts it ~6 dB below
  `sfx.voidTeleport()` (0.55) — matches the "~−6dB below sfx.voidTeleport"
  requirement.
- Ogg quality: `-q:a 0` for ambient (270 KB / 40 s ≈ 54 kbps — drone content
  compresses well, mostly slow sub-bass + slow shimmer; well inside the
  150-300 KB envelope from the task brief and the 800 KB hard ambient
  budget), `-q:a 4` for short SFX so transients stay crisp.

## File sizes
| File | Size | Duration | Codec |
|---|---|---|---|
| void_ambient.ogg | 264 KB | 40 s | vorbis @ ~54 kbps |
| void_teleport.ogg | 13 KB | 0.95 s | vorbis @ ~106 kbps |
| void_pad_ready.ogg | 6 KB | 0.27 s | vorbis @ ~171 kbps |

All well inside the per-asset budget (< 800 KB ambient, < 60 KB teleport,
< 40 KB pad-ready). The pad-ready bitrate is higher than the others because
it's a short transient-heavy clip — `-q:a 4` allocates more bits to the
strike attack so it stays crisp when 2-3 simultaneous plays layer.

## Spec Notes — task brief vs style guide

The Audio Agent task brief and `docs/VOID_VISUAL_STYLE.md` §Audio specify
slightly different ranges for two assets. The style guide is the authoritative
"Locked contract for any agent touching the Void stage" per its own preamble,
so I followed it where it conflicted with the brief, and noted the deltas
here so the next reviewer / Pads Agent reading this knows what was decided
and why.

### `void_pad_ready.ogg` duration: **followed style guide (0.2-0.3 s)**
- Task brief: "0.4-0.6s. <40KB"
- VOID_VISUAL_STYLE.md §Audio: "0.2-0.3s, quiet"
- Decision: built **~0.27 s** because the Pads Agent will read
  VOID_VISUAL_STYLE.md, and the style guide also includes the binding
  layering requirement ("if multiple pads come off cooldown on the same
  frame, audio layer should mix gracefully — keep the sample short and
  tonally consistent so 2-3 simultaneous plays don't mud out the mix"),
  which a 0.55 s sample would risk violating with 4-6 pads on a 6 s cooldown.

### `void_ambient.ogg` duration: **followed task brief + stage convention (40 s)**
- Task brief: "30-60s loop"
- VOID_VISUAL_STYLE.md §Audio: "4-7s seamless loop"
- Decision: built **40 s** because (a) forest, twilight, and cinder
  ambient are all 40 s loops with the same cross-fade recipe, (b) a 4-7 s
  loop would feel obviously repetitive given the void's "noticed when you
  STOP moving" placement, and (c) at 270 KB the 40 s file is well inside
  the 800 KB ambient budget. The 4-7 s spec in the style guide reads as a
  doc typo (likely confused with the 6-10 s shimmer cadence one line
  earlier — "a high-end glassy sliver every 6-10s"). Flagging here for
  the next style-guide pass; not escalating because the established
  stage convention is unambiguous.

## License
- Kenney CC0 dedication: https://creativecommons.org/publicdomain/zero/1.0/
  No restrictions. Use, modify, redistribute freely.
- Synthesized layers (sub-bass drone, detuned fifth, vacuum whistle, distant
  chimes, whisper sweeps) are original to this repository and inherit the
  repository's MIT license.
