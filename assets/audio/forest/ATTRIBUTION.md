# Forest Stage Audio — Attribution

All source samples are CC0 (public domain) from Kenney.nl audio packs. No
attribution is legally required, but credited here for provenance traceability.

## Sources

- **Kenney — Impact Sounds** (CC0)
  https://kenney.nl/assets/impact-sounds
  - `impactGlass_heavy_000.ogg` → crystal_shatter_a
  - `impactGlass_heavy_002.ogg` → crystal_shatter_b (pitched +7%)
  - `impactGlass_heavy_004.ogg` → crystal_shatter_c (pitched +15%)
  - `impactBell_heavy_000.ogg`, `impactBell_heavy_002.ogg` → distant chimes
    in `forest_ambient.ogg` (lowpassed, sparse @ 12s + 27s)

- **Kenney — Sci-Fi Sounds** (CC0)
  https://kenney.nl/assets/sci-fi-sounds
  - `spaceEngineLow_000.ogg`, `spaceEngineLow_002.ogg` → wind drone bed in
    `forest_ambient.ogg` (pitched down 0.78x and 0.62x, lowpassed)
  - `lowFrequency_explosion_000.ogg`, `lowFrequency_explosion_001.ogg` →
    sub-rumble layer under crystal shatters AND main boom of
    `amber_detonation.ogg`
  - `forceField_000.ogg` → electric crackle layer in `amber_detonation.ogg`
    (highpass 1.2kHz, lowpass 4kHz)
  - `explosionCrunch_000.ogg` → mid-frequency burst layer in
    `amber_detonation.ogg`

## Processing

All assets processed with ffmpeg 7.0.2-static:
- SFX normalized to -16 LUFS to match the existing weapon SFX bus (EBU R128).
- Ambient normalized to -22 LUFS (musical bed material, sits well below SFX).
- `forest_ambient.ogg` is a 40s seamless loop built by rendering 45s then
  cross-fading the last 5s onto the first 5s (`acrossfade=d=5:c1=tri:c2=tri`)
  and concatenating with the [5,40] body. Loop seam verified by triple-loop
  amplitude inspection — no transient at the join.
- Crystal shatters are layered: bright glass impact (highpass 400-500Hz) + a
  sub-rumble layer (lowpass 160-180Hz, vol 0.25-0.35).
- Amber detonation layers boom (lowpass 400Hz) + forceField crackle
  (1.2kHz-4kHz band) + explosionCrunch (highpass 300Hz) for a warm-boom +
  electric-crackle profile per `docs/FOREST_VISUAL_STYLE.md` §"Audio Style".

## License

Kenney's CC0 dedication: https://creativecommons.org/publicdomain/zero/1.0/
No restrictions. Use, modify, redistribute freely.
