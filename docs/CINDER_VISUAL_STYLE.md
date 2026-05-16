# Cinder Stage — Shared Visual Style Guide

Locked contract for any agent (Decor, Ballistas, Hazards, Audio) touching the
Cinder stage. Mirrors the Forest and Twilight preflight pattern
(`FOREST_VISUAL_STYLE.md`, `TWILIGHT_VISUAL_STYLE.md`). Visual-style drift
across parallel agents is the #1 risk per pre-flight review (Gemini
2026-05-15) — adhere to this file or escalate.

## Theme
**Rotting Battleground** — mud-churned warzone littered with the decaying
remains of a siege gone wrong. Massive ruined catapults slump where their
counterweights snapped; crater pits scar the dried-blood-stained mud
between them. The play ring is shaped by these few but enormous wrecks —
fewer obstacles than forest's crystals or twilight's hedges, but each one
big enough to force the player into figure-eight kites rather than perfect
circles. Smoldering ember accents from the existing Eruption hazard
(lava puddles, see `stageHazards.js` line 297+) pop against the basalt-
black backdrop. The Rotting Battleground decor is **additive** on top of
the lava system, not a replacement.

Centerpiece interactable: **Ballista Turrets** — broken siege engines the
player can repair on a 10s timer. Once activated, a turret auto-fires
massive piercing bolts in a straight line for the rest of the run.
Permanent allies. Stack 4-6 of them and the player has remade the
battlefield in their favor.

## 8-Color Palette (locked)
All cinder assets — geometry color, emissive, FX rings, particles — must
draw from this palette. Hex strings + THREE hex literals both listed.
These slots are **stage-local**: forest slot 4 (mint), twilight slot 4
(bone), and cinder slot 4 (ember orange) all mean different things. Per-
stage palettes are the contract, not per-hex exclusivity.

| Slot | Use | Hex | THREE | Notes |
|------|-----|-----|-------|-------|
| 1 | Charred black | `#0a0604` | `0x0a0604` | Siege engine wood, crater pit interior |
| 2 | Ash gray | `#3a342f` | `0x3a342f` | Catapult stone counterweights, crater rim |
| 3 | Rust orange dim | `#7a3d1a` | `0x7a3d1a` | Corroded metal bands on siege wood |
| 4 | Ember orange hot | `#ff5522` | `0xff5522` | Live ember accents (smoldering wood) |
| 5 | Ash white | `#d4c4a8` | `0xd4c4a8` | Bone fragments, smoke, ballista chassis highlight |
| 6 | Dried blood | `#5a1810` | `0x5a1810` | Battlefield gore, stained ground, crater interior overlay |
| 7 | Ballista glow active | `#ffd24a` | `0xffd24a` | Working ballista bolt + targeting laser (slot 7) |
| 8 | Repair progress aura | `#ffb86b` | `0xffb86b` | Soft warm gold for 10s repair timer ring |

**Palette note — slot 4 + slot 7 reuse.** Slot 4 (`#ff5522`) is the **exact
same hex** as the existing live-lava color in `stageHazards.js` (line 319:
`arming ? 0xffd24a : 0xff5522`). Slot 7 (`#ffd24a`) matches the existing
lava arming-yellow. This is *not* a copy-paste slip — it's an intentional
reuse so the Eruption lava and the Cinder set dress (smoldering wood,
ballista bolts) read as the **same fire palette**. Functional use differs
(lava = floor hazard, ballista bolts = projectile, ember accents = decor),
but the player reads "this stage burns" consistently. Slot 8 (`#ffb86b`)
is a softer warm gold — visually distinct from slot 7's hot saturated
yellow so the repair-in-progress aura is unambiguous against an activated
turret's bolt glow.

**No off-palette colors.** Greens are OUT (forest owns them). Purples are
OUT (twilight owns them). Bright cyan-white is OUT (forest chain /
twilight movement aura — neither belongs here). Fresh red blood is OUT —
we want **dried/clotted slot 6**, not bright wound red. Cool tones in
general are out: cinder is a warm-decay stage end-to-end.

## Line Weight + Bloom Feel
Reference: Spider Web FX is the quality bar
(`feedback_kitty_kaki_fx_quality.md`). Rune ring texture is canonical for
ground glyphs. Flat shading on catapult wood, stone, and ballista chassis.

- Catapult silhouettes: large, jagged, broken. Flat-shaded merged
  BufferGeometry — NOT InstancedMesh of cubes (boxes read as Minecraft).
  Stone counterweight reads as a rough hex prism; the snapped arm reads
  as a tapered beam at a dramatic angle.
- Crater rings: flat plane decals on the floor, opacity 0.6, bloom OFF.
  No raised geometry — they're scars in the mud, not pits the player can
  walk into.
- Ballista repair aura: expanding ring on slot 8, line weight 0.06-0.08
  world units, additive blend, bloom ON. Crisp inner rim, soft outer
  fade. Same Spider Web FX parity as twilight's movement-buff aura.
- Ballista bolt: thin emissive cylinder on slot 7, bloom ON. Tube radius
  0.15u, length 30u. Reads as a streak of yellow-gold light slamming
  forward — NOT a chunky javelin.
- Emissive intensity bands: ember decor accents 0.8-1.2 (subtle ambient
  smolder), ballista idle chassis 0 (dark/broken), ballista activated
  chassis 1.4-2.0 (slow pulse), ballista repair aura 2.0-2.6, ballista
  bolt 3.0-3.5 (bright streak, fades along its 30u length).
- Audio + visual: ballista activation chime layered on a single-frame
  peak emissive 3.5 on slot 7 — the "I'm online now" moment.

## Ballista Turret Spec — Repair + Auto-Fire Interaction Contract
Concrete visual + behavioral contract for the Cinder Ballistas Agent
(Phase 2). One variant: every ballista starts broken and identical;
activation order is determined by player movement.

1. **Idle state (broken)**: dark slot-1 charred silhouette, slot-3 rust
   accents on metal bands, slot-5 ash-white highlights on the chassis
   frame. NO emissive — the turret reads as dead siege equipment.
   No bob, no pulse. Optional 0.5 Hz subtle Y-bob (0.01-amp) ONLY on the
   bolt-cradle to signal "this thing isn't load-bearing anymore."
2. **Proximity trigger**: player walks within `1.5u` of the ballista
   center → repair animation begins. No button prompt — proximity-
   triggered to keep mid-fight friction low (mirrors twilight fountain
   pattern).
3. **Repair animation (0.0-10.0s)**: slot-8 aura ring around the ballista
   base, line weight 0.07 world units, additive blend, bloom ON. Ring
   inner radius fixed at `0.9u`; ring opacity ramps `0.4 → 1.0` linearly
   over the 10s timer as a visual "progress bar." A second cosmetic
   inner-ring overlay can rotate slowly to sell "machinery being
   cranked." Repair SFX loop plays continuously during this window.
4. **Repair cancel**: player must STAY within `3.0u` of the ballista
   during the full 10s. If the player leaves the 3.0u cancel-radius, the
   timer **resets to 0** (not paused) and the aura snaps off. This
   forces the player to commit a window of mobility — not pop in for
   1.5s, dash away, and come back to instantly finish. The 3.0u radius
   is generous enough that the player can still kite a few enemies
   without abandoning the repair entirely.
5. **Activation frame (single frame, t=10.0)**: single-frame emissive
   peak `3.5` on slot 7 across the chassis (the "I'm online" flash).
   Activation chime plays. Repair aura snaps off. Permanent activation
   flag set on the entity.
6. **Activated state (permanent for the run)**: slot-7 ember-gold glow
   on the chassis with slow 0.4 Hz emissive pulse `1.4 ↔ 2.0`. Slow
   scanning rotation of the bolt-cradle toward the nearest enemy
   (max yaw rate ~`2.0 rad/s`).
7. **Auto-fire loop (every 2.0s while activated)**: bolt fires from the
   cradle along the cradle's current facing direction. Bolt = slot-7
   emissive cylinder, length `30u`, radius `0.15u`, travels at `80u/s`,
   max range `30u` then despawns. Bolt **pierces ALL enemies** in its
   path — no pierce cap, no damage falloff per pierce. Bolt damage:
   `45 dmg` per pierce, applied via the existing
   `damageEnemy(enemy, dmg, 'ballista_turret')` hook from
   `enemies.js`. Future passive systems can scale ballista damage by
   filtering on `source === 'ballista_turret'`.
8. **Multiple ballistas active simultaneously**: each activated turret
   ticks its own fire loop independently. With 4-6 ballistas, expect
   2-3 bolts in flight at any moment once mid-run. This is the desired
   power-fantasy payoff for the 10s repair commitment.
9. **Persistence model**: activation state lives on the per-entity
   ballista object (`b.activated = true`), NOT on `state.run`. There is
   no global `state.run.ballistaActive` flag. Rationale: ballistas are
   per-entity, not a global buff; mixing them onto `state.run` would
   force a serialization shape that doesn't match the data. Stage
   teardown (`clearCinderBallistas`) wipes the entity array, which
   wipes activation state alongside it — no leakage across runs.
10. **Audio**: repair-loop SFX during the 10s window
    (`sfx.ballistaRepairLoop()`); activation chime at t=10
    (`sfx.ballistaActivate()`); bolt thunk + whoosh on each fire
    (`sfx.ballistaFire()`). See Audio brief below.

**Hotspot count**: 4-6 ballistas across the play ring at radius 22-50u.
Decor Agent owns placement. NEVER place a ballista inside the spawn safe
zone (radius < 18u) or inside / overlapping a catapult obstacle
(2u clearance minimum). Spread across radial quadrants so the player
isn't forced to camp one corner of the map to use them.

## Catapult Obstacle Spec
For the Cinder Decor Agent placement:
- **3-4 massive ruined catapults** placed at radius `22-45u` (not at
  center). Each catapult footprint is approximately **4u diameter**.
- Catapults are **VISUAL obstacles only**. Per the project's "no
  pathfinding" constraint, do NOT add colliders. Instead the Hazards
  Agent publishes optional **slow-zones** at `0.7x` enemy speed within
  `2u` of each catapult center — mirroring the forest-amber and
  twilight-hedge slow-zone pattern. Slow-zone publish key:
  `state.run.cinderSlowZones = [{ x, z, r2, mul }]` for
  `enemies.js` to read via the existing aggregator pattern.
- Catapult geometry: hex-prism stone counterweight base (slot 1+2
  diffuse), snapped wooden arm at a dramatic upward angle (slot 1
  diffuse with slot 3 rust-orange metal-band accents), optional
  smoldering ember dots (slot 4 emissive ≤1.2 intensity, ≤6 per
  catapult — additive bloom, sized < 0.15u so they read as glowing
  cracks not lanterns). Flat shading throughout.
- Catapult silhouette must read DIFFERENT from forest crystals and
  twilight hedges: bigger, fewer, more dramatic angles, asymmetric
  (one side counterweight, other side broken arm).

## Crater Spec
For the Cinder Decor Agent placement:
- **4-6 craters** scattered through the play ring at radius `15-50u`.
- Pure visual decoration — **NO gameplay effect** (no slow-zone, no
  damage, no occlusion). The Eruption lava system (`stageHazards.js`)
  owns the dangerous floor mechanics on cinder; craters are just scars.
- Geometry: thin RingGeometry or PlaneGeometry decal lying flat on the
  ground (rotateX -π/2), opacity `0.6`, bloom **OFF**.
- Color: slot 6 dried-blood interior with slot 2 ash-gray rim. The
  interior can use a darker emissive (intensity ≤0.2) for a subtle
  "still warm from the impact" tell, but bloom must remain OFF so the
  craters don't compete with the live lava puddles for the player's
  eye.
- Random rotation around Y for each crater so the decal repeat isn't
  obvious. Random scale `0.85-1.25` for silhouette variety.

## Hotspot JSON Contract
Decor Agent writes `assets/cinder_ballista_hotspots.json` after scatter:
```json
[
  { "x": 24.5, "z": -18.2, "scale": 1.05, "seed": 3000, "facing": 1.57 },
  { "x": -31.0, "z": 14.7, "scale": 0.95, "seed": 3001, "facing": -1.57 }
]
```
Ballistas Agent reads this at stage load to spawn entities.

- `x`, `z`: world-space ballista base position.
- `scale`: 0.85-1.20 (matches forest amber + twilight fountain range so
  the silhouette family reads similarly across stages).
- `seed`: lets per-ballista visual variation (pulse phase offset,
  particle scatter, scanning-cradle phase) be deterministic across
  reloads.
- `facing`: initial yaw angle in **radians** for the bolt-cradle, where
  `0 = +X axis`. Compute it so the bolt vector points from the
  ballista's outer-ring position **toward the play center** (i.e. into
  the play ring's interior, toward where enemies path). For a ballista
  at `(x, z)`, the natural facing is `atan2(-z, -x)` — the unit vector
  from the ballista back to the origin. Decor Agent uses this as a
  hint; the runtime cradle then scans live toward the nearest enemy.

Empty array at preflight; Decor Agent fills it in Phase 1A.

## Audio Style
Audio Agent: Kenney CC0 / freesound CC0/CC-BY only. ffmpeg normalize to
-16 LUFS to match existing weapon SFX bus.

- **Ambient battlefield**: low wind across the mud + distant crow caw +
  occasional creaking wood/metal (4-7s loop, seamless). No cinder stage
  ambient yet — Audio Agent will need to author this. Avoid loud
  battlefield-cliché brass or war drums; the rot is silent. Diegetic
  decay, not heroic music.
- **Ballista repair loop (`sfx.ballistaRepairLoop()`)**: cranking +
  hammering loop, 1-2s loop-point seamless. Plays for the full 10s
  repair window. Low-mid frequency emphasis (heavy mechanical), not
  high-pitched. Diegetic feedback for "this is taking work."
- **Ballista activate (`sfx.ballistaActivate()`)**: triumphant unlock
  chime, 0.6-1.0s, single hit, not looping. Bright but warm — slot 7
  gold colored sound, not slot 8 cyan colored. This is the
  power-fantasy reward moment.
- **Ballista fire (`sfx.ballistaFire()`)**: heavy bolt thunk + whoosh,
  0.4-0.7s. Plays once per bolt. With 4-6 active ballistas firing
  every 2s the cadence becomes a battlefield rhythm — Audio Agent
  should keep the sample punchy so 2-3 simultaneous plays don't mud
  out the mix.

## What's OUT
- Green (forest owns it — bio-glow, crystal mint)
- Purple (twilight owns it — hedges, fountain stone shadow)
- Bright cyan-white (forest chain / twilight movement aura — neither
  belongs here)
- Fresh wound-red blood (we want dried/clotted slot 6, not slot 5 of
  twilight's blood-fountain liquid)
- Cool tones in general — cinder is end-to-end warm decay
- Texture-mapped wood or stone UV maps
- Box/cube catapults (must read as ruined siege engines, not Minecraft
  trebuchet)
- Pathfinding / nav-mesh catapults — catapults are NOT colliders;
  slow-zones (0.7x at 2u) are the only enemy-pacing tool (mirrors
  forest's and twilight's pattern)
- Crater pits the player can walk INTO (craters are floor decals, not
  geometry)
- Button-prompt repair — proximity-trigger only, with the 3.0u
  cancel-radius being the only "commitment" mechanic
- Replacing the existing Eruption lava system — the Rotting
  Battleground decor is **additive** on top of lava; do NOT touch
  `stageHazards.js`'s `_lavas` array, `_spawnLavaNearHero`, or
  the `if (stageId === 'cinder')` block at line 297+
