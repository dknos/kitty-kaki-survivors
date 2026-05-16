# Twilight Stage — Shared Visual Style Guide

Locked contract for any agent (Decor, Fountains, Hazards, Audio) touching the
Twilight stage. Mirrors the Forest preflight pattern (`FOREST_VISUAL_STYLE.md`,
commit b5da106). Visual-style drift across parallel agents is the #1 risk per
pre-flight review (Gemini 2026-05-15) — adhere to this file or escalate.

## Theme
**Cursed Aristocracy** — sprawling, overgrown mansion courtyard reclaimed by
rot. Hedge mazes split the play ring; ruined fountains slump in the corners
where shrubs failed to swallow them. Bruised purple twilight overhead, bone-
white stonework, dim gold sconces. Hades hallway feel re-skinned as topiary
walls: ranged enemies CAN shoot OVER hedges (no LoS block), but the player
must navigate AROUND them — turning every cul-de-sac into a possible coffin
unless they can drink from a Fountain and dash out.

## 8-Color Palette (locked)
All twilight assets — geometry color, emissive, FX rings, particles — must
draw from this palette. Hex strings + THREE hex literals both listed. These
slots are **stage-local**: forest slot 4 (mint) means something different
than twilight slot 4 (bone). Per-stage palettes are the contract, not per-
hex exclusivity.

| Slot | Use | Hex | THREE | Notes |
|------|-----|-----|-------|-------|
| 1 | Bruised purple deep | `#1a0a2e` | `0x1a0a2e` | Ground/hedge base shadow, near-black |
| 2 | Bruised purple mid | `#2d1547` | `0x2d1547` | Hedge body diffuse, fountain stone shadow |
| 3 | Violet pale | `#7a5fa5` | `0x7a5fa5` | Hedge highlight, vine accent |
| 4 | Bone white | `#e8d4b0` | `0xe8d4b0` | Hedge stone walls + fountain rim |
| 5 | Blood red rich | `#8b1a2e` | `0x8b1a2e` | Blood Fountain liquid + idle emissive |
| 6 | Gold dim | `#a98030` | `0xa98030` | Light Fountain liquid + idle emissive |
| 7 | Fountain glow peak | `#ffcd5b` | `0xffcd5b` | Single-frame drink-flash (both variants) |
| 8 | Movement-boost aura | `#a8e6ff` | `0xa8e6ff` | Speed-buff aura ring around player |

**Palette note — slot 8 reuse.** Slot 8 (`#a8e6ff`) is the same hex value as
forest slot 8 (chain-lightning cyan-white). This is *not* a copy-paste slip
— it's an intentional reuse of the only known "fast/electric" color in our
shared accent vocabulary, and slots are functional-per-stage, not exclusive-
per-hex. Functional use differs (forest = chain arcs; twilight = movement
buff aura), so the player reads "something fast is happening" consistently
across stages without inferring a wrong mechanic.

**No off-palette colors.** Greens are out (forest owns them). Cyan-white
appears ONLY as the movement-boost aura (slot 8) — do not bleed it into
hedge highlights, fountain idle, or ambient glow. Reds outside slot 5 are
out (no orange-red ground emission — cinder owns that).

## Line Weight + Bloom Feel
Reference: Spider Web FX is the quality bar
(`feedback_kitty_kaki_fx_quality.md`). Rune ring texture is canonical for
ground glyphs. Flat shading on hedge + stone geometry.

- Fountain idle pulse: emissive lerps 1.2-1.8 on slot 5 (blood) or slot 6
  (light) at 0.5 Hz (slightly slower than forest's amber pulse — reads as
  "deep slow heartbeat" vs forest's "charged crystal").
- Drink-flash: single-frame peak emissive 3.5 on slot 7 (gold-amber). One
  frame only — anything longer reads as "fountain exploding," not "drinking."
- Speed-boost aura: expanding ring on slot 8, line weight 0.06-0.08 world
  units, additive blend, bloom on. Crisp inner rim, soft outer fade. NOT
  chunky. Two concentric rings (tight + loose halo) for the Spider Web FX
  parity look.
- Hedge body: flat-shading on merged BufferGeometry (NOT InstancedMesh of
  cubes — boxes read as Minecraft). Lean toward a tall extruded irregular
  prism or a stacked-cluster silhouette so each segment reads as topiary.
- Stone walls (rim + fountain rim): flat-shading slot 4 with subtle slot 2
  shadow material. Avoid texture-mapped stone — bloom + flat-shaded reads
  cleaner under our pipeline.
- Emissive intensity bands: fountain idle 1.2-1.8, drink peak 3.5 (one
  frame), aura ring 2.0-2.6.

## Fountain Spec — Drink Interaction Contract
Concrete visual + behavioral contract for the Twilight Fountains Agent
(Phase 2). Two variants: **Blood** (slot 5 emissive liquid) and **Light**
(slot 6 emissive liquid). Mechanically identical; pick variant per-hotspot
in the JSON for visual variety.

1. **Idle state**: fountain liquid pulses emissive 1.2-1.8 at 0.5 Hz on
   slot 5 or 6 (per variant). Subtle 0.03-amp Y-bob on the liquid disk
   (NOT the stone rim). Stone rim is static.
2. **Proximity trigger**: player walks within `1.5u` of the fountain
   center → drink animation begins. No button prompt — automatic on
   proximity to keep mid-fight friction low (mirror Forest Amber's
   projectile-trigger pattern).
3. **Drink animation (0.0-0.6s)**: liquid emissive ramps 1.5 → 3.5 (slot 7
   color override during the ramp), then snaps back to idle on frame 0.6.
   Aura ring spawns around the **player** (not the fountain) at t=0.6.
4. **Speed buff (4.0s duration)**: hero gains `1.75x` movement-speed
   multiplier. Implementation contract for Phase 2: prefer publishing
   `state.run.fountainSpeedBuff = { mul: 1.75, expiresAt: state.time.game + 4.0 }`
   and reading it in the hero movement loop (mirrors the
   `state.run.forestSlowZones` publish-and-read pattern, avoids import
   cycles, easy to unit-test). Alternative: temporarily multiply
   `state.hero.statMul.moveSpeed *= 1.75` and revert in tick when
   `expiresAt` passes (simpler but riskier under stat-recompute paths in
   `meta.js`/`weapons/passives.js`). **Phase-2 agent picks one and locks
   it in code; document the choice in `twilightFountains.js` header.**
5. **Aura ring (0.0-4.0s, on player)**: two concentric rings on slot 8.
   Inner ring radius 0.9u (tight halo), outer ring radius 1.4u (loose
   trail). Both follow the player's position each tick. Opacity 1.0 → 0.0
   linear ease over 4 seconds so the buff visibly ticks down.
6. **Cooldown**: `30s` per-fountain cooldown after drink consumed.
   **Locked.** Rationale: a single-use-per-run rule punishes the player
   for drinking early; 30s lets them re-drink after escaping a hedge trap,
   making the mechanic genuinely usable as the "panic button" the Gemini
   brief describes. During cooldown the liquid emissive drops to a flat
   0.6 (dim, no pulse) — clear visual tell that the fountain is "spent."
   At cooldown expiry, idle pulse resumes.
7. **Audio**: pour-SFX layer plays during the 0.6s drink animation; chime
   plays on aura activation (t=0.6); subtle "drying out" gurgle on
   cooldown drop. See Audio brief below.

**Hotspot count**: 6-8 fountains across the play ring, placed at the
inside of hedge-maze dead-ends (so the panic-button proposition lands
when the player is genuinely trapped). Decor Agent owns placement.

## Hedge-Wall Density Targets
For the Twilight Decor Agent placement:
- **4-6 hedge segments** forming partial mazes inside the play ring
  [radius 18, 55].
- Each segment: **3-6u long, 1u thick, 1.5u tall**. Tall enough to read
  as a wall; short enough that ranged enemies' projectiles arc cleanly
  over (we do not block enemy projectile paths).
- Segments form L-shapes or U-shapes — **NEVER fully enclose any region**.
  Every dead-end has ≥2 escape routes via either direct path or fountain
  speed-boost. Failure mode to avoid: player gets stuck against a hedge
  wall with no fountain in dash-range = unwinnable trap.
- Slow-zones inside hedge corridors: `0.65x` enemy speed (same shape as
  forest amber slow-zones — `state.run.twilightSlowZones`). Hazards Agent
  publishes the array of `{ x, z, r2, mul }` per corridor; `enemies.js`
  reads it via the existing aggregator pattern (see Hazards brief).
- Slow-zone placement bias: center each zone on the **inside curve** of a
  hedge segment so swarms passing through corridors are funneled into
  single-file, giving the player kiting room.

## Hotspot JSON Contract
Decor Agent writes `assets/twilight_fountain_hotspots.json` after scatter:
```json
[
  { "x": 24.5, "z": -18.2, "variant": "blood", "scale": 1.05, "seed": 2000 },
  { "x": -31.0, "z": 14.7, "variant": "light", "scale": 0.95, "seed": 2001 }
]
```
Fountains Agent reads this at stage load to spawn entities.

- `variant`: `'blood'` or `'light'` — picks slot 5 vs slot 6 idle color.
- `scale`: 0.85-1.20 (matches forest amber range so the silhouette family
  reads similarly across stages).
- `seed`: lets per-fountain visual variation (pulse phase offset, drink
  particle scatter) be deterministic across reloads.

Empty array at preflight; Decor Agent fills it in Phase 1A.

## Audio Style
Audio Agent: Kenney CC0 / freesound CC0/CC-BY only.
- **Ambient courtyard**: low wind through hedges + distant crow caw or
  faint chamber-music whisper (4-7s loop, seamless). No twilight stage
  ambient yet — Audio Agent will need to author this.
- **Fountain pour SFX**: gentle water-flowing layer for fountain idle
  (low volume, optionally per-fountain spatial); louder cascade during
  the 0.6s drink animation.
- **Speed-boost activation chime**: bright shimmer / bell on aura
  activation (t=0.6 of drink). 0.4-0.7s. Single hit, not looping.
- **Cooldown gurgle**: subtle "drying out" sound on cooldown drop (when
  liquid emissive falls to 0.6). 0.3-0.5s. Quiet — diegetic feedback
  only, not a UI ping.
- ffmpeg normalize to -16 LUFS to match existing weapon SFX bus.

## What's OUT
- Green (forest owns it — bio-glow, crystal mint)
- Orange/red ground emission (cinder owns warm-decay)
- Bright cyan-white outside the movement-boost aura (slot 8 is buff-only)
- Texture-mapped stone or hedge UV maps
- Box/cube hedges (must read as topiary, not Minecraft)
- Pathfinding / nav-mesh hedges — hedges are NOT colliders; slow-zones
  in corridors are the only enemy-pacing tool (mirror forest's pattern)
- Fully enclosed dead-ends (always ≥2 escape paths)
- Drink button prompts — proximity-trigger keeps mid-fight friction low
