# FX Quality Audit — 2026-05-14

> **Status: pass complete.** This doc was the planning inventory. See the
> bottom section for what actually landed.

User complaint (verbatim): *"make sure all the effects, rings are high quality and not placeholders, most seem like placeholders, spider web is good, burgers are mid"*

Quality bar: `src/weapons/web.js` (canvas-textured strands, multi-layered alpha).
Canonical ring art: `makeRuneRingTexture()` exported from `src/enemyTells.js`.
Anti-pattern: flat `RingGeometry` + `MeshBasicMaterial` (rejected per `HANDOFF.md`).

## Format
`[FILE:LINE] kind  verdict=KEEP|UPGRADE|REPLACE  reason  fix`

## Rings (RingGeometry offenders)

- `src/weapons/frostbloom.js:18` kind=ring  verdict=UPGRADED  reason=flat ring, generic AI cyan donut  fix=swap to PlaneGeometry + rune tex; each of 3 staggered rings now has random yaw offset + per-frame spin so they don't lockstep
- `src/weapons/sigilbell.js:19` kind=ring  verdict=UPGRADED  reason=plain ring outline around white disc, no runic detail  fix=PlaneGeometry + rune tex with color-cycle white→gold on detonation, slow-spin during build → fast-spin in red flash
- `src/pylons.js:99` kind=ring  verdict=UPGRADED  reason=flat additive ring telegraph  fix=PlaneGeometry + rune tex, color tinted cyan, slow Y-yaw spin; also added twinkle sparkle on the capacitor orb
- `src/bells.js:121` kind=ring  verdict=UPGRADED  reason=flat additive ring telegraph  fix=PlaneGeometry + rune tex, crimson tint, slow yaw spin
- `src/miniEvents.js:314` kind=ring  verdict=UPGRADED  reason=meteor strike outline is flat ring  fix=PlaneGeometry + rune tex, orange tint, spin accelerates as arm approaches (windup feel)
- `src/miniEvents.js:419` kind=ring  verdict=UPGRADED  reason=elite-pack telegraph is flat ring  fix=PlaneGeometry + rune tex, magenta tint, spinning
- `src/arenaDecor.js:146` kind=ring  verdict=KEEP-ish  reason=Twilight ambient rune circles (40 instanced, opacity 0.32, no bloom) — they're decor, not foreground FX. The user complaint is about foreground rings. Leaving as-is.
- `src/enemyTells.js:179` kind=ring  verdict=KEEP  reason=ranged crescent tell — partial-arc RingGeometry sized 0.45u, this is intentional silhouette art and reads as a glyph

OUT OF SCOPE (in restricted files, listing for next pass):
- `src/catacomb.js:183, 214` — interior props (catacomb glyph rings)
- `src/town.js:144, 257` — town plaza paint ring
- `src/interior.js:147` — house furnace ring

## Burgers — explicit user complaint

- `src/weapons/orbitals.js:17-69` kind=projectile/orbital  verdict=UPGRADED  reason=user said "burgers are mid"; primitive fallback was 5 untextured MeshStandard parts that read as generic stacked cylinders
  fix=
  - Added 3 new procedural decal textures: `bunCap` (sesame seed pattern with 5 ink-outlined seeds + glaze highlight), `cheeseSlice` (drip-edged cheese with ink outline), `pattyTop` (grill marks + char mottle)
  - Primitive burger now layers these top-down decals onto each component so it reads as hand-drawn food, not stacked cylinders
  - GLB path also gets the sesame decal as a top-down sticker (depth-test off + renderOrder so it always reads above the GLB body), and evolved burgers get an additional toxic-green cheese drip overlay
  - Ground FX upgraded from 1 plain glow disc → 3-layer stack: rune disc base (canonical magic-AoE art) + soft halo + heat-shimmer billboard
  - Each layer breathes at a different sine rhythm + vertical bob so the orbital reads as alive, not static
  - Evolved (Toxic Halo) now uses toxic-green tint across all layers, ~2x shimmer intensity

## Food pickups — secondary read of complaint

- `src/pickups.js:90-108` kind=pickup  verdict=UPGRADED
  fix=
  - Added per-pickup-family billboard halo InstancedMesh layers (1 per family, 1 draw call each)
  - 5 new procedural decals: `heartSprite`, `starSprite`, `bombSprite` (sphere + fuse + spark), `snowflake` (6-arm crystalline), `drumstick` (chicken leg with bone)
  - Each pickup now floats with its painted decal halo above it (additive blend, BLOOM_LAYER)
  - Bumped emissiveIntensity 0.25 → 0.55 on the underlying primitives so they read past placeholder-tier
  - Halo layers properly hide on pickup + reset; matrices flushed alongside the geometry layer

## Enemy projectiles

- `src/enemyProjectiles.js:17-24` kind=projectile  verdict=UPGRADED
  fix=
  - 3 new procedural bolt textures: `wizardBolt` (magenta with electric branches), `fireBolt`, `iceBolt`
  - `spawnEnemyProjectile` now accepts a `kind` parameter ('magic'|'fire'|'ice'); defaults to magic so existing callers stay working
  - Each projectile gets: pulsing core (sphere) + textured glow billboard with rotation + a motion trail plane stretched along velocity
  - Per-projectile materials cloned + disposed on lifecycle so we don't leak

## XP gems

- `src/xp.js:55-60` kind=gem  verdict=UPGRADED
  fix=
  - Added a second InstancedMesh `_sparkleInst` (same cap 500) painted with `twinkle` texture
  - Per-instance color mirrors gem tier color (cyan/magenta/gold)
  - Each gem's sparkle pulses on a sine wave keyed off (x*0.7 + z*1.3) so adjacent gems don't lockstep
  - Idle gems still get sparkle pulse refresh per frame (cheap — only the sparkle layer is rewritten)
  - All hide/drop/reset paths now flush both gem + sparkle layers

## Props / pickups / chests

- `src/chest.js:61-68` kind=prop  verdict=UPGRADED  reason=halo was plain TorusGeometry MeshBasic
  fix=PlaneGeometry + rune tex with spin (YXZ Euler order so .y is world-up yaw) + a top-twinkle pip painted with twinkleGold
- `src/miniEvents.js:234-240` kind=cache (goblin reward)  verdict=UPGRADED  reason=same plain TorusGeometry halo
  fix=PlaneGeometry + rune tex spin + twinkleGold pip
- `src/pylons.js:111-119` kind=prop  verdict=UPGRADED  reason=halo plane around orb was flat MeshBasic, no texture
  fix=swapped to glowCyan texture + added a phase-modulated twinkle sparkle on the capacitor
- `src/totems.js:79-85` kind=prop  verdict=KEEP-mostly  reason=already has emissive crown torus with rotation + bobbing pulse. Sufficient for now.

## Stage hazards

- `src/stageHazards.js:66-79` kind=hazard  verdict=UPGRADED  reason=pollen + lava were flat additive `CircleGeometry` discs — read as solid colored blobs
  fix=
  - Pollen: textured plane painted with `pollen` (multi-octave noise + speckle dots — sells dandelion drift)
  - Lava: textured plane painted with `lavaPuddle` (dark crust ring + bright molten interior + 5 zigzag crack veins)

## Procedural texture library additions

`src/particleTextures.js` gained these new helpers:
- `_makeTwinkle` (3 color variants: white, gold, pink)
- `_makeBunCap`, `_makeCheeseSlice` (with toxic green variant), `_makePattyTop`
- `_makeHeartSprite`, `_makeStarSprite`, `_makeBombSprite`, `_makeSnowflakeSprite`, `_makeDrumstickSprite`
- `_makePollen`, `_makeLavaPuddle`
- `_makeWizardBolt` (with fire/ice color variants)

All follow the 8-color palette + 4/2/1 px line weight discipline per STYLE_BIBLE.md (ink outline 4px, secondary 2px, whisker 1.5-2px).

## Out-of-scope but flagged

- `src/blobShadows.js:42` kind=shadow  verdict=KEEP  reason=intentional contact disc (multiplicative dark), not a foreground FX
- `src/fx.js:36-101` kind=fx  verdict=KEEP  reason=already uses `ringGold`/`sparkCyan`/`ringCyan` procedural textures (good)
- `src/vfxBurst.js` kind=fx  verdict=KEEP  reason=already uses `shockwave`/`flashStar`/`smokeWarm`/`emberWarm` textures (good)
- `src/weapons/chain.js`, `src/weapons/autoAim.js` — flat `MeshBasicMaterial` projectile glows but they're using glow textures via the `map:` field; quality already approximates web-tier. Skipped this pass.
- `src/town.js`, `src/interior.js`, `src/catacomb.js` rings — restricted files, parent session can pull them in next iteration.

## Final scope shipped

Files touched (12):
1. `src/particleTextures.js` — +18 new procedural texture helpers
2. `src/weapons/orbitals.js` — burgers (user complaint #1)
3. `src/weapons/frostbloom.js` — frost ring trio
4. `src/weapons/sigilbell.js` — sigil rune disc
5. `src/pylons.js` — pylon telegraph + capacitor twinkle
6. `src/bells.js` — bell wind-up rune ring
7. `src/miniEvents.js` — meteor + elite-pack + goblin-cache halos
8. `src/pickups.js` — heart/star/bomb/freeze/chicken billboard halos
9. `src/xp.js` — sparkle billboard layer
10. `src/chest.js` — chest halo + twinkle pip
11. `src/stageHazards.js` — pollen + lava textured planes
12. `src/enemyProjectiles.js` — per-kind silhouette + motion trail

No new `RingGeometry` in modified files. No new flat `MeshBasicMaterial` placeholder rings. All upgrades stay within the 8-color palette + 4/2/1 px line weight discipline. All InstancedMesh caps respected.
