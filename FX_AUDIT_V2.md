# FX Quality Audit V2 — 2026-05-14 (post-v1.0 polish pass)

> User feedback after iter-10 / commit `7b8ebc2`:
> *"there are still placeholder aoe effects, need that to all be pro quality assets,
>  can use grok or whatever you need to find high quality assets"*
>
> Iter-10's audit (`FX_AUDIT.md`) swept the obvious flat-ring offenders. This
> V2 pass measures the residue against the **locked spider-web bar** — not
> against "uses a rune texture" but against "carries the same density of art".

## How spider-web reads as pro

`src/weapons/web.js` + `_makeWeb()` in `particleTextures.js` together do:

- One 128×128 canvas with **haze radial gradient + 12 radial spokes + 4
  concentric jittered loops + bright center node** — the art is dense in the
  bitmap, not faked by stacking layers.
- Rendered as a single textured plane with per-instance alpha breathing.

Most other AoE surfaces use `makeRuneRingTexture()` (ticks + 4 diamonds +
filament — sparse), then layer 1-2 planes. That **gap in texture density** is
what the user is still seeing as placeholder.

Two paths to close the gap per surface:
1. Richer pattern-specific texture (denser line work, sub-ornaments).
2. Additional layered planes with motion (motes / streaks / debris dust /
   converging particles), each on its own sine frequency.

This V2 pass takes **path 2** for boss telegraphs (the brief's literal
specification: motes outward / streak lines inward / debris dust at line
edges), plus **path 1 + 2 hybrid** for the highest-frequency surfaces (kill
ring, sigilbell detonation), plus a primitive→multi-mesh upgrade for the
goblin cache (only literal `BoxGeometry+MeshStandard` left in scope).

## Format

```
[FILE:LINE] kind=X  verdict=KEEP|UPGRADE|REPLACE
  evidence: <why still placeholder OR why already pro>
  fix: <what V2 ships>
```

## Verdict roll-up
- **UPGRADE** ×9 — surfaces that already use rune art but lack motion/density
  to match spider-web. The brief explicitly named all of these.
- **REPLACE** ×1 — goblin cache primitive (BoxGeometry+MeshStandard literal
  placeholder).
- **KEEP** ×6 — surfaces that already meet or exceed the bar.

---

## Boss telegraphs (HIGHEST PRIORITY — brief #1)

- `src/bossTelegraphs.js:209-217` kind=ring(Engulf)  verdict=UPGRADE
  evidence: contracting cyan rune ring + single-sine opacity pulse. No
  particle motes "drifting outward" as brief enumerates. Density: 1 plane.
  fix: per-pattern motes layer. Engulf gets **inward-spiraling cyan motes**
  on a pooled InstancedMesh (motes converge on the ring center over the
  windup, sells "you are being drawn in"). Multi-frequency: ring breathes at
  18Hz, motes orbit at 3Hz, secondary inner glow plane at 9Hz.

- `src/bossTelegraphs.js:264-282` kind=cone(Sonic)   verdict=UPGRADE
  evidence: magenta rune-textured cone wedge with single-sine pulse. No
  inward streak lines (brief calls for "inward streak lines / Sonic Cone").
  fix: **forward-rushing magenta streak motes** along the cone axis (motes
  spawn at cone tip, race back toward the boss as it charges). Same pooled
  InstancedMesh as Engulf, just different per-pattern motion. Secondary
  inner glow cone (smaller, hotter, faster-pulsing) layered behind.

- `src/bossTelegraphs.js:326-351` kind=quake(bars)   verdict=UPGRADE
  evidence: 4 amber rune bars with synchronized opacity pulse. No "debris
  dust at line edges" (brief enumeration).
  fix: **amber debris flecks** sprinkled along each bar's length (small
  jittered y-offsets, look like dust/grit shaken loose). Brightens during
  resolve as the bar fires. Multi-frequency: bar opacity pulses at 14Hz,
  debris twinkles at 22Hz.

## Sigil Bell — detonation moment

- `src/weapons/sigilbell.js:81-107` kind=burst  verdict=UPGRADE
  evidence: `_detonate` only sets `bloomBoost` + shake — no particle burst at
  the moment of explosion. Rune disc fades, then nothing. The brief locks
  spider-web tier; spider-web has *layered* visuals so even its placement
  reads polished. Sigil's detonation moment is the loudest beat in the
  weapon and currently the visuals don't pop.
  fix: call `burstExplosion(s.x, s.z, radius * 1.4, 0xff5533)` at detonation
  + a magenta `spawnKillRing` overlay. burstExplosion already gives us
  flash+shock+smoke+embers (5-layer atlas in vfxBurst.js). Single line of
  code, massive perceived-quality bump.

## Kill ring (high frequency — cascade win)

- `src/fx.js:114-121` kind=ring(killRing)  verdict=UPGRADE
  evidence: single `ringGold` textured plane, single base scale, no center
  pop, no per-elite color variant beyond size scaling. Fires on **every**
  enemy death — any quality bump cascades hard.
  fix: **second InstancedMesh layer** — additive twinkle pop at ring center
  (`tex('twinkle')` for trash, `tex('twinkleGold')` for elites), scaled
  smaller and life 0.18s (snappier than the ring's 0.35s so it pops and
  vanishes while the ring expands). Reuse existing `_makeTwinkle` helper —
  no new texture allocation.

## Goblin cache (set-piece moment — REPLACE only literal placeholder left)

- `src/miniEvents.js:230-236` kind=cache(body)  verdict=REPLACE
  evidence: **literal placeholder** — `new THREE.BoxGeometry(0.9, 0.7, 0.9)`
  + `MeshStandardMaterial(color: 0xffd24a, emissive: 0xffaa22)`. Last
  remaining bare-primitive in scope. Halo around it was upgraded iter-10,
  but the cube body itself is the only un-touched flat primitive.
  fix: rebuild as a **multi-mesh coffer**:
    - 4-sided angled "facets" cube (ChamferedBox feel — composed of
      OctahedronGeometry scaled in Y for crystalline gem look) with
      MeshStandard gold + emissive
    - 4 ribbon planes draped at cardinal sides (BunCap/CheeseSlice grade
      decals using existing twinkleGold tex tinted)
    - Embedded bright spark in the gem core (already had twinkle pip above
      it — adding a *secondary* twinkle INSIDE the gem for refractive feel)
  Total: 3-mesh group replaces 1-mesh box. Stays cheap (one cache at a
  time max).

## Elite-pack telegraph

- `src/miniEvents.js:461-475` kind=ring(elitePack)  verdict=UPGRADE
  evidence: single magenta rune disc with breathing pulse. The brief notes
  this is a "pack assembling" beat — should have **inward-converging motes**
  showing the pack snapping into formation.
  fix: 6 magenta motes spawning at radius 4u and lerping inward to center
  over the 2-second windup → "pack converging on this spot". Multi-frequency:
  rune spins at 0.9Hz, motes orbit-and-shrink at 5Hz. Pooled into the same
  shared mote InstancedMesh as boss telegraphs (one pool, multiple consumers).

## Frost crystal pop (frostbloom)

- `src/weapons/frostbloom.js:78-148` kind=ring(frost)  verdict=UPGRADE
  evidence: 3-ring rune stack is solid, but freezing enemies on the pulse
  has no **frost crystal particles** rising at impact. Spider-web has the
  density baked in; frostbloom only has it at the rim layer.
  fix: on each pulse cast, spawn ~8 `spawnMagnetSpark` sparkles in the AoE
  ring (cyan-white color) so frozen-enemy impacts read as crystal pop.
  Re-uses existing `fx.js` spark pool — no new geometry.

## Stage hazards — pollen drift overlay

- `src/stageHazards.js:67-75` kind=hazard(pollen)  verdict=UPGRADE
  evidence: textured pollen sprite is good (iter-10 win) but the multi-blob
  noise is **static** — no inner drift particles. Real dandelion fluff
  drifts. Sub-pattern motion would push from "good" to "spider-web".
  fix: add a tiny per-pollen twinkle sub-sprite that orbits the pollen
  center on a slow phase. Re-use existing `tex('twinkle')` — no new asset.
  Caveat: keep cheap; one sub-sprite per pollen, not a cloud.

## Lava puddle — molten crackle

- `src/stageHazards.js:78-84` kind=hazard(lava)  verdict=UPGRADE
  evidence: textured lavaPuddle sprite has crack veins built into the
  bitmap (good). But pulsing alpha is the only motion — no rising ember
  particles. Lava puddles in shipped survivors games emit ambient embers
  even when no one's standing in them.
  fix: low-frequency ember spawn (every ~0.4s per active live-lava puddle,
  not arming ones) via existing `vfxBurst.js` ember pool. Caps at the
  ember pool's existing 128. Adds presence without cost.

## Surfaces that are already at the bar (KEEP — don't churn)

- `src/enemyTells.js:181-292` (full file, iter-10b)  verdict=KEEP
  reason: rune art + per-affix tints + leap marker with windup pulse +
  threat dots. Already 4-layer system with multi-frequency motion. The
  ranged crescent `new THREE.RingGeometry(...)` at line 213 is the **only**
  RingGeometry in any scope file; documented exception — partial-arc
  silhouette glyph, intentional as a magical sigil shape distinct from
  ground discs. Keeps the grep check meaningful.

- `src/weapons/orbitals.js:188-252`  verdict=KEEP
  reason: 3-layer ground FX (rune+halo+shimmer) with 3 sine frequencies
  (2.6Hz disc, 4Hz halo, 7.2Hz shimmer). Burger primitive layers
  sesame+grill+cheese decals on top. Already at spider-web tier per
  iter-10's pass. Touching it risks regression.

- `src/weapons/chain.js:74-101`  verdict=KEEP
  reason: 2-layer TubeGeometry (outer glow + inner core) with random
  branches at 35% chance, taper jitter, dual fade rates. Distinct visual
  language (lightning) and already dense.

- `src/weapons/autoAim.js`  verdict=KEEP
  reason: core sphere + textured glow billboard. Projectile FX, not AoE.
  Out of audit category but in scope file list — explicitly verified pro.

- `src/weapons/web.js`  verdict=KEEP (THE LOCKED BAR — never touch)

- `src/vfxBurst.js`  verdict=KEEP
  reason: 5-layer atlas (flash+shock+smoke+embers+dash) with gravity, air
  drag, per-layer fade curves. Already over-engineered for the bar.

- `src/fx.js` `spawnMagnetSpark` + `updatePickupRing`  verdict=KEEP
  reason: textured sparkCyan + pickupRing with proper instancing. Only
  spawnKillRing was flagged for UPGRADE.

## Known caveat (pre-existing, not introduced this pass)

If a mini-boss dies during a windup (rare — sigilbell stun + heavy DPS),
the inner-glow planes / quake bars / tell rings leak in scene until
`resetBossTelegraphs()` fires on next run. **This was already true for
`boss._tellRing` before V2**; the new `_engulfInner` / `_sonicInner`
inherit the same lifecycle. Surfaced here so the next pass can lift
disposal into an `onBossDeath(e)` hook in `enemies.js` if needed. Not
fixed here because the fix bridges files outside scope.

## Performance / discipline checks

- All UPGRADEs add layered InstancedMesh systems, **not** per-frame
  geometries. Pooled.
- One new procedural texture helper added to `particleTextures.js`:
  `_makeMoteTrail` (for the boss mote layer — a soft elliptical streak
  with directional fade so motes read as motion blur, not dots). Registered
  in `initParticleTextures()`.
- 8-color palette + 4/2/1 px line weights preserved. New textures use
  existing palette hexes only (cyan `#66ddff`, magenta `#ff44cc`, amber
  `#ffaa44`, gold `#ffd24a`).
- No `BLOOM_LAYER` on bulk geometry — only on additive sprite layers.
- No new RingGeometry. No new MeshLambertMaterial FX. No new bare
  MeshBasic flat rings.
- Documented `enemyTells.js:213` partial-arc RingGeometry as the only
  scope-file exception (intentional silhouette glyph, not a flat ring).

## External assets

**None pulled.** Procedural beats sourced for this game's identity. Brief
expressly defaults to procedural+shader. The art language is locked.

## Files modified this pass

1. `src/particleTextures.js` — +1 helper `_makeMoteTrail` + registration
2. `src/bossTelegraphs.js` — mote/streak/debris layer per pattern
3. `src/weapons/sigilbell.js` — burstExplosion call at detonation
4. `src/weapons/frostbloom.js` — spawnMagnetSpark crystal pop on pulse
5. `src/fx.js` — second InstancedMesh layer for kill ring (center twinkle)
6. `src/miniEvents.js` — multi-mesh goblin cache + elite-pack converging motes
7. `src/stageHazards.js` — pollen sub-twinkle + lava ambient embers

## What a player will see vs iter-10

| Surface          | Before (iter-10)              | After (V2)                             |
|------------------|-------------------------------|----------------------------------------|
| Boss Engulf      | Cyan rune ring, opacity pulse | + cyan motes spiraling inward          |
| Boss Sonic Cone  | Magenta cone, opacity pulse   | + streak motes racing along axis       |
| Boss Quake Cross | Amber bars, sync pulse        | + amber debris dust on bar edges       |
| Sigil detonation | Disc fade + bloom flash       | + 5-layer burstExplosion + kill ring   |
| Enemy kill ring  | Single gold ring expansion    | + center twinkle pop (gold for elites) |
| Goblin cache     | Plain gold box                | Faceted gem + ribbons + inner sparkle  |
| Elite-pack tell  | Magenta rune disc             | + 6 motes converging from radius       |
| Frost pulse      | 3 rune rings                  | + 8 crystal sparkles in AoE            |
| Pollen drift     | Static fluff sprite           | + slow orbit twinkle per puff          |
| Lava live        | Crack-vein bitmap pulse       | + ambient ember puffs every 0.4s       |
