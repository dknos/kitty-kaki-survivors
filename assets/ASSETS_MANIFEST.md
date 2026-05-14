# Assets Manifest — Kitty Kaki Survivors

Sources, licenses, and use-sites for every external 3D asset shipped with the
game. Anything added must be appended here with source URL + license + author.

All assets below are **CC0** (no attribution required). Where the upstream
license is CC-BY (Poly by Google), the credit line goes in `src/ui.js`
`showCredits()` modal (existing pattern from `assets/breakroom/`).

## Pre-existing — `assets/breakroom/`

Hero, enemies, pickups, primitive props from earlier milestones. See
`ASSETS.md` for the original drop-in list. Not duplicated here.

## Pre-existing — `assets/sprites/`

- `forrest_ground_01/` — Poly Haven, CC0. Forest stage ground PBR pack
  (diff/rough/nor_gl at 1k). Source: https://polyhaven.com/a/forrest_ground_01
- `brown_mud/` — Poly Haven, CC0. Twilight + cinder ground pack.
  Source: https://polyhaven.com/a/brown_mud_03
- `hdri/approaching_storm_1k.hdr` — Poly Haven, CC0.
  Source: https://polyhaven.com/a/approaching_storm

---

## Iter 14 (2026-05-14) — `assets/kits/`

CC0 stylized 3D kits pulled from Poly Pizza CDN
(`https://static.poly.pizza/{uuid}.glb`). Resolved via the public model
pages (`https://poly.pizza/m/{slug}`); see `scripts/fetch-kits.sh` for
the slug→UUID map and a re-runnable fetch script.

### `assets/kits/town/` — forest district buildings

| File                  | Author    | License | Size  | Source slug                |
|-----------------------|-----------|---------|-------|----------------------------|
| `fantasy_house.glb`   | Quaternius | CC0     | 410 KB | https://poly.pizza/m/BH2XHWUNmF |
| `town_house.glb`      | Quaternius | CC0     | 762 KB | https://poly.pizza/m/sDQJBImZuw |
| `fantasy_inn.glb`     | Quaternius | CC0     | 469 KB | https://poly.pizza/m/x3ZcGn3jr4 |
| `tower_house.glb`     | Quaternius | CC0     | 231 KB | https://poly.pizza/m/xm5cViUjra |
| `castle_gate.glb`     | Quaternius | CC0     | 148 KB | https://poly.pizza/m/tKTchdiQzV |
| `fantasy_barracks.glb`| Quaternius | CC0     | 259 KB | https://poly.pizza/m/wTDbVozPAj |

Used by `src/env.js` (kingdom-district buildings) and `src/town.js`
(`Fantasy House` for cabin, `Castle Gate` for adventure gate).

### `assets/kits/dungeon/` — catacomb chamber

| File              | Author       | License | Size  | Source slug                |
|-------------------|--------------|---------|-------|----------------------------|
| `arch.glb`        | Kay Lousberg | CC0     | 46 KB | https://poly.pizza/m/uS8wgBVxOL |
| `pillar.glb`      | Kay Lousberg | CC0     | 24 KB | https://poly.pizza/m/1nt8n3rVKU |
| `pillar_alt.glb`  | Kay Lousberg | CC0     | 26 KB | https://poly.pizza/m/p8JPFIGc09 |
| `pillar_broken.glb` | Kay Lousberg | CC0   | 24 KB | https://poly.pizza/m/8RXyLygEeF |
| `coffin.glb`      | Kay Lousberg | CC0     | 96 KB | https://poly.pizza/m/ySERERWPgE |
| `crypt.glb`       | Kay Lousberg | CC0     | 77 KB | https://poly.pizza/m/iV5x01FYAl |
| `bone1.glb`       | Kay Lousberg | CC0     | 25 KB | https://poly.pizza/m/gVLnQi8VrX |
| `bone2.glb`       | Kay Lousberg | CC0     | 23 KB | https://poly.pizza/m/gVT6iydSY6 |
| `bone3.glb`       | Kay Lousberg | CC0     | 25 KB | https://poly.pizza/m/2jLwMoAb2y |

Used by `src/catacomb.js` (chamber set-dress) and twilight pack in
`src/arenaDecor.js` (broken pillar carryover).

### `assets/kits/ruins/` — twilight gravestones

| File                  | Author       | License | Size  | Source slug                |
|-----------------------|--------------|---------|-------|----------------------------|
| `damaged_grave.glb`   | Kay Lousberg | CC0     | 41 KB | https://poly.pizza/m/KWtVNrHXVR |
| `gravestone.glb`      | Kay Lousberg | CC0     | 31 KB | https://poly.pizza/m/lrEHKjTy29 |
| `gravestone_alt.glb`  | Kay Lousberg | CC0     | 30 KB | https://poly.pizza/m/ErfdU1GJSD |

Used by `src/arenaDecor.js` twilight pack.

### `assets/kits/torches/` — light sources

| File              | Author     | License | Size  | Source slug                |
|-------------------|------------|---------|-------|----------------------------|
| `torch_wall.glb`  | Quaternius | CC0     | 37 KB | https://poly.pizza/m/WGsvr4KOZd |
| `torch_stand.glb` | Quaternius | CC0     | 24 KB | https://poly.pizza/m/Gq38E7hFZw |

Used by `src/catacomb.js` wall torches (`torch_wall`) and any future
free-standing brazier set-dress.

---

## Iter 22A (2026-05-14) — `assets/kits/home/`

Cozy-room furniture for the cabin interior (`src/interior.js` +
`src/homeDecor.js`). Player-decoratable via the new `H`-key Decorate
overlay; placements persist via `meta.homePlacements`. All Quaternius CC0.

### `assets/kits/home/` — cozy home furniture

| File                | Author     | License | Size   | Source slug                |
|---------------------|------------|---------|--------|----------------------------|
| `rug.glb`           | Quaternius | CC0     | 7 KB   | https://poly.pizza/m/ZYBzMHnSbM |
| `plant.glb`         | Quaternius | CC0     | 683 KB | https://poly.pizza/m/MbhbP7JrTI |
| `lamp.glb`          | Quaternius | CC0     | 10 KB  | https://poly.pizza/m/RsWYHKkDhD |
| `bed.glb`           | Quaternius | CC0     | 252 KB | https://poly.pizza/m/BuRay4fVFr |
| `bookshelf.glb`     | Quaternius | CC0     | 29 KB  | https://poly.pizza/m/TDgvIuorcX |
| `cauldron.glb`      | Quaternius | CC0     | 46 KB  | https://poly.pizza/m/QaWJOPa6Gt |
| `chair.glb`         | Quaternius | CC0     | 27 KB  | https://poly.pizza/m/IRLaR71Pyn |
| `side_table.glb`    | Quaternius | CC0     | 45 KB  | https://poly.pizza/m/rAEBvfb1FT |
| `sofa.glb`          | Quaternius | CC0     | 15 KB  | https://poly.pizza/m/lmePppSu8a |
| `cat.glb`           | Quaternius | CC0     | 233 KB | https://poly.pizza/m/qKICY6xla2 |
| `chest.glb`         | Quaternius | CC0     | 159 KB | https://poly.pizza/m/RfSBvgcZUD |
| `banner_wall.glb`   | Quaternius | CC0     | 5 KB   | https://poly.pizza/m/Kd94xlw5aj |
| `banner_alt.glb`    | Quaternius | CC0     | 34 KB  | https://poly.pizza/m/svYG8KZxjq |
| `sword_mount.glb`   | Quaternius | CC0     | 133 KB | https://poly.pizza/m/3LyJaWgoJG |
| `shield_mount.glb`  | Quaternius | CC0     | 46 KB  | https://poly.pizza/m/neNWPt8WAx |
| `skull_mount.glb`   | Quaternius | CC0     | 91 KB  | https://poly.pizza/m/VGtSTNRf2O |

Catalog entry IDs and unlock-flag bindings live in
`src/homeDecor.js#HOME_CATALOG`. Wall items (`banner_*`, `*_mount`)
anchor to one of 4 walls × 8 fixed slot positions; floor items snap to
a 10×10 tile grid that masks out the existing fixture footprints (door,
desk, easel, kettle, computer, yarn basket, fireplace).

## Totals
- 36 new GLBs, **4.7 MB** added (post-CDN download).
- Combined `assets/` size after iter 22A: ~60 MB.
- All CC0 — no `ui.js` credit-modal changes required.

## Re-fetch
Run `bash scripts/fetch-kits.sh` from repo root. Idempotent; skips
already-downloaded files. Slug → UUID resolution happens at fetch time
in case Poly Pizza rotates CDN UUIDs (none observed across multiple
runs as of 2026-05-14).
