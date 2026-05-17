# Sprite System — Shared Visual Style + Atlas Contract

Locked contract for any agent producing or wiring sprite sheets in this
repo. Visual style drift across parallel agents is the #1 risk
(precedent: C2A/C2B, FE-C1A merge races, 2026-05-16). Read this BEFORE
generating sheets or wiring spritePool.

## Visual target — CRUNCHY PIXEL-ART (locked 2026-05-16)

User decision: crunchy pixel-art, NOT smooth painterly. Reference vibe:
HROT mob sprites, Dusk impact FX, classic Doom-style billboards. Sprites
must read as deliberate pixel art under 4× nearest-neighbor upscale.

- **Source pixel scale**: design at 1× source pixels. Sprites are
  displayed in-world at world-units derived from `pixelsPerWorldUnit` set
  in the atlas JSON (default 24 — i.e. a 32px-tall sprite stands 1.33
  world units tall, roughly hero-height).
- **Upscale**: rendered via `NearestFilter` (no mipmaps). Sub-pixel
  filtering is BANNED — kills the crunch.
- **Outlines**: 1px hard pixel outline, slot-1 (charcoal `#1a1e22`) by
  default. Lighter outlines (slot-3) allowed for bright/glowing FX.
- **Anti-aliasing**: NONE. No alpha gradients on edges. Edge pixels are
  either fully opaque (alpha 1.0) or fully transparent (alpha 0.0).
  The ONLY exception is the additive-blended bloom halo layer (see
  Blend Modes below) — those frames can use 4-step alpha (1.0/0.66/0.33/0.0).

## 8-Color palette — inherit per stage

Sprites adopt the parent stage's 8-color palette, locked per
`docs/<STAGE>_VISUAL_STYLE.md`:

| Stage | Palette source | Notes |
|-------|----------------|-------|
| Forest | `docs/FOREST_VISUAL_STYLE.md` | Bioluminescent mint + amber accents |
| Twilight | `docs/TWILIGHT_VISUAL_STYLE.md` | Fountains, cool blues |
| Cinder | `docs/CINDER_VISUAL_STYLE.md` | Lava warm |
| Void | `docs/VOID_VISUAL_STYLE.md` | Cold violets |

Stage-agnostic FX (hit-flash, dust-puff used everywhere) — use a
**neutral palette**: slot-1 (`#1a1e22`), slot-3 (`#5f8fb5`),
slot-8 (`#a8e6ff`), plus pure white (`#ffffff`) for peak flash frames
only. Off-palette colors are BANNED.

## Atlas JSON schema (locked)

Every `.png` ships with a sibling `.json` of this exact shape. Atlas
loaders MUST validate against this schema. Adding fields without
updating this doc and bumping the version is a contract break.

```jsonc
{
  "version": 1,
  "image": "hit_flash_v1.png",     // sibling filename, relative to JSON
  "frameWidth": 32,                 // source pixels per frame, X
  "frameHeight": 32,                // source pixels per frame, Y
  "cols": 4,                        // frames per row
  "rows": 2,                        // rows of frames in the sheet
  "frameCount": 8,                  // total frames (≤ cols*rows; row-major order)
  "pixelsPerWorldUnit": 24,         // 24 = 32px sprite ≈ 1.33u tall
  "anchor": [0.5, 0.5],             // pivot in normalized frame coords (0,0 top-left)
  "blendMode": "alpha",             // "alpha" | "additive"
  "bloom": false,                   // true = mesh.layers.enable(BLOOM_LAYER)
  "billboard": "screen",            // "screen" | "cylinder" | "none"
  "anims": {
    "default": { "from": 0, "to": 7, "fps": 24, "loop": false }
    // additional named anims: "idle", "attack", "death" etc.
  },
  "palette": "neutral",             // "neutral" | "forest" | "twilight" | "cinder" | "void"
  "license": "internal",            // "internal" | "CC0" | "CC-BY <author>"
  "source": "procgen v1"            // how the sheet was made — track it
}
```

## Blend modes

Two modes, no others:
- **`alpha`** — standard alpha-blended sprites. For mobs, characters, opaque pixel FX.
- **`additive`** — additive blend on a bloom-tagged plane. For glow halos,
  energy bursts, lightning arcs. Must set `bloom: true`.

Mixed FX (e.g. opaque shockwave with a glow halo): ship as TWO sprite
sheets — one alpha layer, one additive layer. Spawn both, anchor them at
the same world position, animate in lockstep.

## Billboard modes

- **`screen`** — plane always faces the camera in screen space (rotation
  ignored). For most explosions and FX bursts.
- **`cylinder`** — plane rotates around its Y axis to face camera but
  stays vertical (Y-up). For mob sprites — Doom enemy style.
- **`none`** — plane keeps its world rotation. For ground decals laid
  flat (default rotation = `rotateX(-Math.PI/2)`), or scene-anchored
  signage.

## File-system layout

```
assets/sprites/
  fx/                      # stage-agnostic FX sheets
    hit_flash_v1.png
    hit_flash_v1.json
    dust_puff_v1.png
    dust_puff_v1.json
    ...
  mobs/
    forest/                # per-stage mob sprites
      glowmoth_v1.png
      glowmoth_v1.json
  setpiece/                # one-shot big FX (boss telegraphs, ascension burst)
    borgir_explosion_v1.png
    ...
```

## Frame-coherence strategy (locked 2026-05-16)

Pixel-art does NOT tolerate AI t2i frame drift. Hard rules:

1. **FX sheets** (hit-flash, dust-puff, aura-rings, shockwaves, explosions):
   procedurally generated via Canvas2D / OffscreenCanvas. Math-driven
   (concentric rings, radial gradients quantized to palette, particle
   simulations). Deterministic per `(seed, palette)`. See
   `tools/sprite-gen/procgen.mjs`.
2. **Mob sprites**: hand-crafted in LibreSprite / Aseprite, OR generated
   by procgen+keyframe interpolation (8-direction silhouettes from a
   single source). NO Vertex i2i for mob frame sequences — incoherent.
3. **Setpiece FX** (Borgir explosion, ascension burst): allowed to use
   Vertex i2i (`gemini-3.1-flash-image-preview`) WITH frame N-1 as image
   reference + small delta prompt + manual cull. Slow, costs $.
   Permitted only for single-shot dramatic effects, not loops.

## Performance contract

- ONE `InstancedMesh` per atlas. Per-FX-spawn allocation = zero after
  pool init.
- Pool cap: default 256 per atlas. Spritepool MUST hard-cap at this
  number and recycle oldest-first when full. Match precedent in
  `src/fx/dissolveBurst.js`.
- Honor `state.run.lowFx` kill-switch — atlas registers a `bypassWhenLowFx`
  flag, spritepool short-circuits spawn when low-fx + flag set.
- BLOOM_LAYER tagging is opt-in per atlas (`bloom: true` in JSON).
- Frame-index updates: write into a single `InstancedBufferAttribute`
  with `setUsage(DynamicDrawUsage)`, batch-flush once per frame in a
  central `tickSpriteSystem(dt)` call from `src/main.js`.

## Death anim contract (vs perf fix 9509535)

Critical (per advisor 2026-05-16): a sprite mob's death anim must NOT
extend the entity's lifetime in the active-enemy collision/AI lists.

- On `killEnemy(e)`: remove from active list immediately (existing path).
- Hot-path spawns a DETACHED sprite FX (death anim) via spritePool. Pool
  manages its own lifetime. The original enemy reference is already gone.
- NO "playing death anim, still hittable" state. NO per-frame allocation
  added to kill path.

## Smoke test contract

`tools/smoke-sprite-fx.mjs` must verify:
1. Every atlas JSON in `assets/sprites/**/*.json` is schema-valid.
2. Every JSON has a sibling `.png` that exists on disk.
3. `frameCount ≤ cols * rows`.
4. `from`/`to` for every anim is in `[0, frameCount-1]`.
5. Static text-grep of `src/sprites/spritePool.js`:
   - imports THREE
   - exports `spawnSprite`, `tickSpriteSystem`, `disposeSpritePools`
   - references `NearestFilter`
   - references `DynamicDrawUsage`
   - references `InstancedBufferAttribute`

Add to existing smoke battery alongside `smoke-sig-weapons.mjs`.
