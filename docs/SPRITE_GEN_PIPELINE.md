# Sprite Generation Pipeline

How FX sprite sheets are made in this repo. Authoritative visual contract
lives in `docs/SPRITES_VISUAL_STYLE.md` — this doc covers the **how**
(tooling, recipes, gotchas), not the **what** (palette, schema, blend
modes).

## Tooling stack

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | Node 20+ (tested on v22.22.1) | Already on workstation |
| PNG encode | `pngjs@7.0.0` (pure JS) | Zero native deps; deterministic encoding (no tIME chunk) |
| Canvas API | Custom RGBA buffer (`tools/sprite-gen/canvas.mjs`) | No native `node-canvas` is allowed (sudo + libcairo headaches); a tiny `putPixel` is enough for aliased pixel art |
| RNG | Mulberry32 (32 lines, inline) | Tiny, fast, reproducible |

### Lib choice rationale (rejected alternatives)

- `canvas` / `node-canvas` — needs libpixman/libcairo, native compile, requires sudo on this workstation.
- `@napi-rs/canvas` — native binary, doesn't tolerate WSL2 path quirks well.
- `skia-canvas` — bigger native binary; overkill for pixel-aliased work.
- `sharp` — image manipulation, but no per-pixel draw API for sub-32px source.
- `jimp` — pure JS but slower than `pngjs` for our tiny outputs and has fewer escape hatches.

`pngjs` won: pure JS, tiny, deterministic, and we don't need a canvas API
since every sprite pixel is computed by formula.

## Determinism contract

Each sheet has a fixed seed (Mulberry32). Re-runs MUST produce
byte-identical PNGs:

```bash
md5sum assets/sprites/fx/*.png > /tmp/before
node tools/sprite-gen/index.mjs > /dev/null
md5sum assets/sprites/fx/*.png > /tmp/after
diff /tmp/before /tmp/after   # MUST be empty
```

If this diff ever produces output, either:
1. A generator was changed without bumping its `_vN` suffix, OR
2. The Node version changed (we don't promise cross-version determinism).

The smoke battery in `tools/smoke-sprite-fx.mjs` (to be added in a later
phase per `docs/SPRITES_VISUAL_STYLE.md §Smoke test contract`) should
gate on this.

## Recipes — the 4 starter FX sheets

All four use the **neutral** palette. Atlas-image sheet layout is
**row-major, top-to-bottom, frame 0 at top-left** (matches the row-flip
the spritePool shader does internally).

### 1. `hit_flash_v1` — generic impact spark

- 32×32 / frame, 6 frames, 1 row × 6 cols (192×32 sheet)
- Recipe: radial bursts, expanding **diameter** 4→28px
  (radii table: `[2, 5, 8, 11, 13, 14]`)
- Frame 0 = solid white 4px core (peak-flash exception)
- Frame 1 = white core + slot-8 halo + slot-3 outer with 4-step alpha halo
- Frames 2-3 = expanding hot ring with slot-8 inner + slot-3 shell
- Frames 4-5 = thinning ring → broken-arc dots (fade-out)
- Blend: `additive`, bloom: on, billboard: `screen`, anchor: `[0.5, 0.5]`
- Anim: `default` 0→5 @ 30fps, no loop
- Seed: `0x00F1A511`

### 2. `dust_puff_v1` — footfall / landing dust

- 32×32 / frame, 8 frames, 2 rows × 4 cols (128×64 sheet)
- Recipe: 26 simulated particles seeded from a Mulberry32 hash. Each
  particle has `(x0, y0, vx, vy, ttl, heavy)`. Per frame, Euler-advance
  position with mild gravity (`+0.18·t²`), quantize to pixel grid.
  ~18% of particles are "heavy" (slot-1 grit), rest are slot-3.
- Blend: `alpha` (NO bloom — dust is opaque grit, not glow)
- Billboard: `cylinder` (faces camera but stays vertical)
- Anchor: `[0.5, 1.0]` — bottom-center so sprite sits flush on ground
- Strict aliased pixels (no 4-step alpha) — alpha-blended sheet, contract requires 0/1
- Anim: `default` 0→7 @ 18fps, no loop
- Seed: `0xDEAD0FFE`

### 3. `borgir_explosion_v1` — Borgir mob kaboom

- 48×48 / frame, 10 frames, 2 rows × 5 cols (240×96 sheet)
- Recipe: 10-bucket radial color tables (one switch per frame). Core
  flash → fireball expansion → smoke ring → wisps → embers.
- Blend: `additive`, bloom: on, billboard: `screen`
- Anchor: `[0.5, 0.5]` (entity-centered)
- 4-step halo pixels on bloom frames (1, 2, 3, 4, 5, 9)
- Sparse slot-1 grit / slot-8 hot debris flecks for visual chunk
- Anim: `default` 0→9 @ 24fps, no loop
- Seed: `0xB0B61234`

**> Contract extension flagged:**
> The brief authorizes slot-6 (`#f5a300`) + slot-7 (`#ffd86b`) warm
> accents on this sheet. `docs/SPRITES_VISUAL_STYLE.md §8-Color palette`
> currently says "off-palette colors are BANNED" for the neutral set —
> the brief explicitly extends that for borgir.  
> **If the doc owner objects**, demote warm pixels to slot-8 cyan
> (search the `borgir_explosion.mjs` file for `WARM.slot6`/`WARM.slot7`,
> replace with `NEUTRAL.slot8`, regenerate, bump to `_v2`).  
> If accepted, codify by adding "warm accents (slot-6/slot-7)
> permitted on explosion/fire FX" to SPRITES_VISUAL_STYLE.md.

### 4. `aura_rings_v1` — looping ground aura

- 64×64 / frame, 8 frames, 2 rows × 4 cols (256×128 sheet)
- Recipe: 2 concentric 1px rings (Bresenham-ish midpoint walk).
  Inner radius pulses 18→26→18 sinusoidally over 8 frames; outer
  stays at 28. 4-step alpha halo one pixel outside the outer ring.
- "Rotation cue" sparkle dots (6 outer + 4 counter-inner) phase-shift
  across the loop so the eye reads spin even with rotation-invariant rings.
- Blend: `additive`, bloom: on, billboard: `cylinder`
- Anchor: `[0.5, 1.0]` — bottom-center, so ring emanates from feet
- Anim: **`idle`** (per brief — NOT `default`), 0→7 @ 12fps, **loop: true**
- Seed: `0xA0BAFA11`

## File boundary owned by this pipeline

- `tools/sprite-gen/**` — generator source
- `assets/sprites/fx/*.png` + `*.json` — generated outputs (4 starter sheets so far)

Mob sprites (`assets/sprites/mobs/`) and setpiece sprites
(`assets/sprites/setpiece/`) follow different rules — see
`docs/SPRITES_VISUAL_STYLE.md §Frame-coherence strategy`.

## Adding a new FX sheet

See `tools/sprite-gen/README.md` for the step-by-step. tl;dr:

1. New `sheets/<name>.mjs` exporting `generate(outDir) → {pngPath, jsonPath}`.
2. Fresh seed constant.
3. Register in `index.mjs` `GENERATORS`.
4. Stay inside the 8-color palette per the relevant stage.
5. Emit JSON conforming to v1 schema (loader validates).
6. Run, verify determinism, document recipe here.

## Known gaps / follow-ups

- **No smoke gate yet**: `tools/smoke-sprite-fx.mjs` from the visual
  contract is not yet wired. Hand-validated for the starter 4 by inlining
  `_validateSchema` from `src/sprites/spriteAtlas.js`. Tracked for the
  next sprite phase.
- **No visual preview HTML**: a `tools/sprite-gen/preview.html` that
  loads each PNG and animates it via `<canvas>` would help diff visual
  regressions when a recipe is tweaked. Not in this phase.
- **Borgir warm-accent extension**: see flag above. Needs doc-owner ack.
- **No determinism CI gate**: relies on a manual md5 check. Should fold
  into the smoke-sprite-fx test when that lands.
