# tools/sprite-gen — procedural FX sheet generator

Pure-Node procedural pixel-art generator for the FX sheets in
`assets/sprites/fx/`. No browser, no native deps. Produces deterministic
PNG + JSON pairs that satisfy the schema in
`docs/SPRITES_VISUAL_STYLE.md` (v1).

## Usage

```bash
# regenerate all 4 starter FX sheets
node tools/sprite-gen/index.mjs

# preview what would run
node tools/sprite-gen/index.mjs --dry-run
```

Output lands in `assets/sprites/fx/`:

| Sheet                       | Frames | Layout | Anim                       |
|-----------------------------|--------|--------|----------------------------|
| `hit_flash_v1.png`          | 6      | 6×1    | `default` 30fps, no loop   |
| `dust_puff_v1.png`          | 8      | 4×2    | `default` 18fps, no loop   |
| `borgir_explosion_v1.png`   | 10     | 5×2    | `default` 24fps, no loop   |
| `aura_rings_v1.png`         | 8      | 4×2    | `idle` 12fps, **loop**     |

## File layout

```
tools/sprite-gen/
  index.mjs              # entry point — runs all generators
  canvas.mjs             # pngjs-backed pixel canvas + savePNG/saveJSON + mulberry32
  palette.mjs            # NEUTRAL + WARM palette constants
  sheets/
    hit_flash.mjs        # one file per sheet, exports generate(outDir)
    dust_puff.mjs
    borgir_explosion.mjs
    aura_rings.mjs
```

## Determinism contract

Each generator owns a hardcoded seed (Mulberry32) and only writes to
its own RGBA buffer. `pngjs` does not inject `tIME` chunks by default,
so re-running on the same Node version produces byte-identical PNGs.

Smoke check:
```bash
md5sum assets/sprites/fx/*.png > /tmp/a
node tools/sprite-gen/index.mjs > /dev/null
md5sum assets/sprites/fx/*.png > /tmp/b
diff /tmp/a /tmp/b   # should be empty
```

## Adding a new sheet

1. Drop a new file in `sheets/`, e.g. `sheets/shockwave.mjs`.
2. Export `generate(outDir)` returning `{ pngPath, jsonPath }`.
3. Pick a fresh seed constant (any 32-bit int).
4. Register it in `index.mjs` `GENERATORS` array.
5. Stay inside the 8-color palette per stage (see `palette.mjs`).
6. Emit JSON conforming to v1 schema — the loader validates strictly.
7. Re-run, confirm determinism, document the recipe in
   `docs/SPRITE_GEN_PIPELINE.md`.

## Bumping a sheet version

If you change a recipe or seed of an existing sheet:
- Rename file → `_v2.png` / `_v2.json`.
- Update `image` field + `source: "procgen v2"` in JSON.
- Update consumers (spritePool callers, balance docs).
- Old `_v1` stays until callers migrate.
