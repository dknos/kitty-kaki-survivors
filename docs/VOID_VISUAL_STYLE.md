# Void Stage — Shared Visual Style Guide

Locked contract for any agent (Decor, Teleport Pads, Hazards, Audio) touching the
Void stage. Mirrors the Forest / Twilight / Cinder preflight pattern
(`FOREST_VISUAL_STYLE.md`, `TWILIGHT_VISUAL_STYLE.md`, `CINDER_VISUAL_STYLE.md`).
Visual-style drift across parallel agents is the #1 risk per pre-flight review
(Gemini 2026-05-15) — adhere to this file or escalate.

## Theme
**Shattered Monolith** — endgame stage in a fractured floating ruin suspended
over cosmic void. The playable area is a constellation of jagged stone
islands, broken apart by missing floor-tile gaps that open onto the abyss
below. Massive fractured pillars loom at the outer ring, their broken tops
trailing slow stardust drift. The player can't safely walk between islands —
they must use **Teleport Pads** placed at each island's center to chain
across the map, leaving slow-moving hordes behind on the abandoned island but
risking a blind drop into fresh spawn density at the destination.

The void below the tiles is the deep silent kind — no fire, no decay, no
greenery. Cosmic violets, chrome whites, portal cyans, obsidian black. The
quietest, most alien stage in the rotation. End of the line.

Centerpiece interactable: **Teleport Pads** — cyan-glowing rift discs on
the island centers. Step on → instant teleport to another pad. 6s per-pad
cooldown prevents teleport-loop abuse. Brief player iFrames on arrival
soften the "blind-drop into spawn" risk just enough that the mechanic is
usable, not punishing.

## 8-Color Palette (locked)
All void assets — geometry color, emissive, FX rings, particles — must draw
from this palette. Hex strings + THREE hex literals both listed. These slots
are **stage-local**: forest slot 4 (mint), twilight slot 4 (bone), cinder
slot 4 (ember orange), and void slot 4 (chrome white) all mean different
things. Per-stage palettes are the contract, not per-hex exclusivity.

| Slot | Use | Hex | THREE | Notes |
|------|-----|-----|-------|-------|
| 1 | Obsidian black | `#040208` | `0x040208` | Base shadow, floor tile undersides, tile-gap void |
| 2 | Deep violet abyss | `#1a0a3a` | `0x1a0a3a` | Void depths visible through cracks, cooldown ring dim |
| 3 | Cosmic purple mid | `#3a1a5e` | `0x3a1a5e` | Floating ruin stonework, pillar diffuse |
| 4 | Chrome white edge | `#d8dce8` | `0xd8dce8` | Ruin highlights, tile edges, pillar facet tops |
| 5 | Portal cyan idle | `#00d4ff` | `0x00d4ff` | Teleport pad idle glow (pulse 0.7 Hz, bloom ON) |
| 6 | Portal cyan active | `#7fffff` | `0x7fffff` | Teleport pad charged glow (peak band of pulse) |
| 7 | Teleport flash | `#ffffff` | `0xffffff` | Single-frame white flash at origin + destination |
| 8 | Star points | `#a8b8ff` | `0xa8b8ff` | Skybox star detail, ambient drift particles, tile-gap stars |

**Palette note — slot 1 reuse.** Slot 1 (`#040208`) is the **same hex** as
the existing void floor color in `arenaDecor.js` (`floors.void: 0x040208`,
line 1139). This is intentional reuse so the floor + tile undersides + the
visible void through the gaps all read as one consistent abyss. Cinder
slot 1 (`#0a0604`) and twilight slot 1 (`#1a0a2e`) are *different* hexes —
void is the only stage that's truly near-black.

**Palette note — slots 5/6/7 form a single "portal" ramp.** Slot 5 is the
idle baseline; slot 6 is the peak of the idle pulse and stays inside the
cyan family so the player doesn't read a state change from pulse alone;
slot 7 is pure white, reserved for the *single-frame* teleport activation
flash. If anything else in the stage wants "white," it's slot 4 chrome
white, not slot 7 teleport flash. Slot 7 only fires on actual teleport.

**No off-palette colors.** Greens are OUT (forest owns them). Oranges /
warm-decay reds are OUT (cinder owns them). Bruised purple slot 1/2 from
twilight is OUT — void purples are **colder and deeper** (`#1a0a3a` vs
twilight's `#1a0a2e` — colder blue cast, not warmer red cast). Bone white
is OUT — chrome white slot 4 has a slight blue cast, NOT the warm cream of
twilight bone or cinder ash. Dried-blood / fresh-blood is OUT — nothing
bleeds in the void.

## Line Weight + Bloom Feel
Reference: Spider Web FX is the quality bar
(`feedback_kitty_kaki_fx_quality.md`). Rune ring texture is canonical for
ground glyphs. Flat shading on pillar + tile geometry.

- Teleport pad idle pulse: emissive lerps 1.4 ↔ 2.0 on slot 5 → slot 6 at
  0.7 Hz (slightly faster than twilight's 0.5 Hz fountain heartbeat — reads
  as "actively powered portal" vs twilight's "deep slow liquid").
- Teleport flash: single-frame peak emissive 3.5 on slot 7 (pure white) at
  the origin pad AND the destination pad on the same frame. One frame each
  — anything longer reads as "pad detonating," not "rift opens." After the
  flash frame the origin pad immediately enters cooldown visual; the
  destination pad immediately returns to its idle pulse state.
- Cooldown ring: thin RingGeometry on slot 2 (deep violet) overlaying the
  pad surface at line weight 0.05 world units, additive blend, bloom OFF.
  Opacity ramps 0.85 → 0.0 linearly across the 6s cooldown so the player
  reads "still recovering" → "almost ready" without needing a UI HUD.
  Snaps off at cooldown=0; idle pulse resumes.
- Floor tiles: flat-shaded merged BufferGeometry hex or square plates
  (NOT InstancedMesh of cubes — boxes read as Minecraft). Slot 3 cosmic
  purple top face, slot 1 obsidian black bottom, slot 4 chrome white
  facet edge accents. Subtle slot 2 emissive ≤0.15 on edge bevels to
  catch the bloom faintly — the ruins should look mildly self-lit, like
  they're still resonating with whatever magic shattered them.
- Pillars: flat-shading on tall slot 3 cosmic-purple stonework with
  slot 2 deep-violet shadow material and slot 4 chrome-white facet caps
  on the fractured tops. Avoid texture-mapped stone — bloom + flat-shaded
  reads cleaner under our pipeline.
- Tile-gap decals: thin PlaneGeometry on slot 1 obsidian black lying
  flat on (or slightly below) the floor plane, opacity 0.95, bloom OFF.
  Optional slot 8 star-point particles drifting UP through each gap at
  ≤0.3u/s with ≤6 particles per gap, sized < 0.10u — they read as
  cosmic detail leaking through, not as a particle FX explosion.
- Pillar ambient particles: ≤8 slot 8 star points per pillar drifting
  in a slow 2-3u radius spiral, ≤0.2u/s, additive blend, bloom ON,
  sized < 0.08u. Subtle cosmic shimmer, not a particle storm.
- Emissive intensity bands: tile bevels 0.10-0.15 (just shy of bloom
  threshold), pad idle pulse 1.4-2.0 (slot 5 → 6), pad teleport flash
  3.5 (slot 7, one frame), cooldown ring overlay 0 emissive (bloom OFF
  on purpose — cooldown is a state, not a celebration), star particles
  1.6-2.2 (slot 8, bloom ON for the cosmic shimmer).

## Teleport Pad Spec — Step + Teleport Interaction Contract
Concrete visual + behavioral contract for the Void Teleport Pads Agent
(Phase 2). One variant: every pad starts identical and ready; the only
per-pad state is `cooldownUntil` and (optionally) an explicit
`pairWith` seed from the hotspot JSON.

1. **Idle state (ready, default)**: pad disc emits slot-5 cyan glow
   pulsing 1.4 ↔ 2.0 at 0.7 Hz. Pulse peak frame swaps emissive color
   to slot 6 (`#7fffff`) for that single frame so the peak reads as
   "charged" — between pulses the color sits on slot 5. Subtle 0.02-amp
   Y-bob on the disc only (NOT on the cosmetic rune ring underneath) so
   the disc feels like it's hovering a hair above the tile. Bloom ON.
   Always visible — even mid-cooldown the pad's silhouette persists,
   just with the cooldown ring overlaid.
2. **Proximity trigger (player steps on)**: when the player center
   passes within `1.2u` of the pad center AND the pad is NOT in
   cooldown, teleport fires **immediately on the next tick** — no
   button prompt, no wind-up animation. Mid-fight friction zero
   (mirror forest amber + twilight fountain pattern).
3. **Activation frame (single tick)**:
   - Origin pad: single-frame emissive peak 3.5 on slot 7 (pure white)
     across the disc + a slot-7 short-lived (~0.15s) expanding ring on
     slot 7 at the player's old position (line weight 0.10u, opacity
     1.0 → 0.0 linear over 0.15s, additive blend, bloom ON).
   - Player position (mutated directly): `state.hero.pos.x` and
     `state.hero.pos.z` snap to destination pad XZ. `state.hero.mesh.position.x/z`
     snap in lockstep so the mesh doesn't catch up a frame later.
     Y-position untouched (player stays on the floor plane).
   - Destination pad: single-frame emissive peak 3.5 on slot 7 +
     identical short-lived slot-7 ring at the new player position.
   - Player iFrames: `state.hero.iFramesUntil = state.time.game + 0.4`
     (matches existing `HERO.iFramesSec` pattern from `src/hero.js`).
     0.4s is enough to survive a single touch from a fresh spawn but
     short enough that the player can't pad-bounce to become invincible.
4. **Destination selection**:
   - **Default (auto-nearest)**: pick the nearest OTHER pad whose
     `cooldownUntil <= state.time.game` (i.e., currently ready). Ties
     broken by lower seed.
   - **Explicit pairing (`pairWith`)**: if the hotspot JSON sets
     `pairWith: <seed>` on a pad, that pad ALWAYS teleports to the pad
     with the matching seed — even if a nearer pad exists, even if the
     paired pad is in cooldown (in which case the teleport is **suppressed
     for this tick** — pad still consumes the step trigger so the player
     can't camp on a pad waiting; they have to step off and back on).
     Asymmetric: A.pairWith=B does NOT auto-set B.pairWith=A. Decor
     Agent decides each direction.
   - **Edge case (only 1 pad ready, no pair)**: teleport is suppressed
     for this tick — same step-off-and-back rule. Logged via the same
     debug hook as suppressed pair teleports.
   - **Edge case (2 pads total, no pair)**: alternates — the OTHER pad
     is always the destination. Falls naturally out of auto-nearest
     with 2 pads.
5. **Cooldown (6.0s, per-pad)**: after a successful teleport, the
   ORIGIN pad enters cooldown — sets `cooldownUntil = state.time.game + 6.0`.
   The DESTINATION pad does NOT enter cooldown (so the player can
   chain forward through the map but not loop back through the same
   pad). Cooldown ring overlay on slot 2 fades opacity 0.85 → 0.0
   linearly over the 6s; pad disc continues to pulse at slot 5 → 6
   normally but the cooldown ring visually overrides the "ready" read.
   Step-trigger checks `cooldownUntil` first — stepping on a
   cooling-down pad does nothing (no flash, no teleport, no SFX).
6. **Re-entry guard**: after teleport, the player is now standing on
   the destination pad. To prevent an immediate bounce-back the next
   tick (player still within `1.2u` of destination), the destination
   pad sets a 0.3s `localStepGuard` — proximity check on that pad is
   suppressed until `state.time.game >= localStepGuard`. Player must
   physically walk OFF the destination pad before that pad will
   accept a fresh step trigger. The cooldown on the ORIGIN pad
   plus this guard on the DESTINATION pad together fully prevent
   "infinite teleport spam" loops.
7. **Audio**:
   - Pad idle: subtle ambient drone layer per pad (optional spatial),
     looped at low volume.
   - Teleport activation: `sfx.voidTeleport()` — WHOOSH + chime,
     0.7-1.0s, single hit not looping. Plays once per teleport (NOT
     once per pad — origin + destination share the one sound).
   - Pad cooldown ready: `sfx.voidPadReady()` — subtle bell when the
     pad's cooldown timer drops to zero. 0.2-0.3s, quiet. Diegetic
     "this pad is usable again" feedback.

**Hotspot count**: 4-6 teleport pads placed at the **center of each
island** in the play ring (radius 18-50u). Decor Agent owns placement.
NEVER place a pad inside a missing-tile gap; pads must sit on solid
tile geometry. Spread across radial quadrants so the player has a
meaningful destination choice from any starting pad.

## Missing Floor Tile Hazard Spec
For the Void Decor Agent placement:
- **5-8 missing-tile patches** scattered between teleport pads at
  radius `15-50u`. Roughly rectangular floor-plane decals.
- Per the project's "no pathfinding" + simplicity principle, these
  are **VISUAL only** — NO collision, NO damage, NO slow-zone, NO
  pacing effect on enemies. They communicate "the island is shattered"
  so the teleport pad mechanic reads as gameplay-necessary, not
  cosmetic. Pads handle the actual island-hopping; gaps just sell
  the fiction.
- Geometry: thin PlaneGeometry decal lying flat at y≈-0.02 (just
  below the tile plane so it reads as a hole and not a poster),
  opacity 0.95, bloom OFF. Slot 1 obsidian black with a faint slot 2
  inner gradient (paint via vertex color or simple shader — keep
  cheap). NO emissive — the void absorbs light, it doesn't emit it.
- Random rotation around Y for each gap so the rectangle silhouette
  isn't obvious. Random scale 0.8-1.4 for variety. Aspect ratio
  jittered (0.6-1.4 wide vs deep) so gaps don't all read as squares.
- **Optional cosmetic**: ≤6 slot-8 star particles per gap drifting
  upward at ≤0.3u/s, additive blend, bloom ON, sized < 0.10u. Pure
  flavor — Decor Agent may skip if the particle budget is tight.

## Floating Ruin Pillar Spec
For the Void Decor Agent placement:
- **4-6 large pillars** at radius `20-50u` — they read as the
  remnants of a structure that used to span the void.
- Tall (8-14u height), fractured tops (jagged silhouette, not a
  flat cap). Footprint 2-3u diameter.
- Geometry: slot 3 cosmic-purple stonework body with slot 2 deep-
  violet shadow material on the underside / shadowed facets, slot 4
  chrome-white facet caps on the fractured top edges. Flat shading.
  Use a tapered prism or stacked hex-prism silhouette so each pillar
  reads as monolithic — NOT a stack of boxes.
- Pure VISUAL — NO collision, NO slow-zone. (Catacomb/void share
  no enemy-pacing structures; the teleport pads are the gameplay.)
- Subtle slot-8 ambient star-point particles drifting in a slow
  spiral around each pillar (≤8 particles per pillar, ≤0.2u/s,
  radius 2-3u, sized < 0.08u). Pillar silhouette must read DIFFERENT
  from cinder catapults (no broken arm), twilight fountains (no
  basin / liquid disc), and forest crystals (no shard cluster).

## Hotspot JSON Contract
Decor Agent writes `assets/void_teleport_hotspots.json` after scatter:
```json
[
  { "x": 24.5, "z": -18.2, "scale": 1.05, "seed": 4000 },
  { "x": -31.0, "z": 14.7, "scale": 0.95, "seed": 4001, "pairWith": 4002 },
  { "x":  10.0, "z":  32.0, "scale": 1.00, "seed": 4002, "pairWith": 4001 }
]
```
Teleport Pads Agent reads this at stage load to spawn entities.

- `x`, `z`: world-space pad center position. Must sit on a solid
  tile (NEVER inside a missing-tile gap).
- `scale`: 0.85-1.20 (matches forest amber + twilight fountain +
  cinder ballista range so the silhouette family reads similarly
  across stages).
- `seed`: lets per-pad visual variation (pulse phase offset,
  particle scatter) be deterministic across reloads. Also used as
  the lookup key for `pairWith`.
- `pairWith` (OPTIONAL): if present, this pad's teleport ALWAYS
  resolves to the pad with `seed === pairWith` — even if a nearer
  pad exists. Asymmetric: setting `pairWith` on pad A does NOT
  auto-set it on pad B. Decor Agent decides each direction.
  If unset (default), auto-nearest-non-cooldown resolution applies.

Empty array at preflight; Decor Agent fills it in Phase 1A.

## Audio Style
Audio Agent: Kenney CC0 / freesound CC0/CC-BY only. ffmpeg normalize
to -16 LUFS to match existing weapon SFX bus.

- **Ambient cosmic drone**: low sub-bass void hum + occasional
  reality-tear shimmer (a high-end glassy sliver every 6-10s). 4-7s
  seamless loop. Different from twilight's hedge-wind and cinder's
  battlefield-mud ambient — void should feel SILENT in a way no
  other stage does. Drone sits at the bottom of the mix; players
  should notice it most when they STOP moving.
- **Teleport activate (`sfx.voidTeleport()`)**: WHOOSH + chime,
  0.7-1.0s, single hit not looping. Two-layer sound design: an
  airy whoosh layer for the rift opening + a clean cyan-colored
  bell chime layer for the rift resolving. Plays once per teleport
  (origin + destination share — NOT one sound per pad). Should
  punch but not startle — this fires often enough across a run
  that it can't be a jump-scare.
- **Pad cooldown ready (`sfx.voidPadReady()`)**: subtle bell when a
  pad's cooldown expires and idle pulse resumes. 0.2-0.3s, quiet
  (~-6dB below `sfx.voidTeleport()`). Diegetic "this pad is
  usable again" feedback — not a UI ping. If multiple pads come
  off cooldown on the same frame (rare but possible), audio
  layer should mix gracefully — Audio Agent should keep the
  sample short and tonally consistent so 2-3 simultaneous plays
  don't mud out the mix.

## What's OUT
- Green (forest owns it — bio-glow, crystal mint)
- Orange / warm-decay reds (cinder owns warm-decay)
- Bruised purple slot 1/2 from twilight (twilight purples are
  warmer / red-tinted; void purples are colder / blue-tinted)
- Bone white (cream-warm — that's twilight's stone rim; void uses
  chrome-white slot 4 which has a slight blue cast)
- Dried blood / fresh blood (nothing bleeds in the void)
- Texture-mapped stone or tile UV maps
- Box/cube pillars (must read as monolithic ruins, not Minecraft)
- Pathfinding / nav-mesh tiles or pillars — no colliders. Missing
  tiles are visual-only; pillars are visual-only; pads handle ALL
  the gameplay-relevant island-hop mechanic.
- Button-prompt teleport — proximity-trigger keeps friction zero
- Damage / fall-through on tile gaps — gaps are pure visual fiction;
  the teleport pads are what makes the island-hopping playable
- Teleport loops — origin pad cooldown + destination re-entry guard
  TOGETHER prevent the player from spam-tapping a single pair to
  become permanently invincible
- HUD cooldown indicators — the slot-2 cooldown ring overlay on
  each pad is the only cooldown signal. No UI text, no minimap
  pad-state, no toast. Diegetic only.
- Bloom on the cooldown ring — cooldown is a state, not a
  celebration. Bloom is reserved for slots 5/6/7 (pad pulse +
  teleport flash) and slot 8 (cosmic shimmer).
