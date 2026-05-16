# Forest Stage — Shared Visual Style Guide

Locked contract for any agent (Decor, Amber, Hazards, Audio overlays) touching
the Forest stage. Both Decor and Amber agents MUST adhere to this — visual
style drift across parallel agents is the #1 risk per pre-flight review
(Gemini 2026-05-15).

## Theme
**Petrified Forest** — bioluminescent crystal-stone woods. Dead trees that
became living crystal. Cold blue-green light from within the rock, warm
amber glow only at the Explosive Amber hotspots. Hades hallway feel: dense
clumps that funnel swarms into single-file lines.

## 8-Color Palette (locked)
All forest assets — geometry color, emissive, FX rings, particles — must
draw from this palette. Hex strings + THREE hex literals both listed.

| Slot | Use | Hex | THREE | Notes |
|------|-----|-----|-------|-------|
| 1 | Stone-trunk base | `#1a1e22` | `0x1a1e22` | Near-black charcoal, low albedo |
| 2 | Crystal-trunk mid | `#2d3a55` | `0x2d3a55` | Cold deep blue-gray |
| 3 | Crystal facet hi | `#5f8fb5` | `0x5f8fb5` | Pale cyan-steel, used for facet rim |
| 4 | Bio-glow primary | `#7df0c4` | `0x7df0c4` | Bioluminescent mint, emissive intensity 1.2-1.8 |
| 5 | Bio-glow secondary | `#3ecf9a` | `0x3ecf9a` | Darker mint, edge/mid bloom |
| 6 | Amber idle | `#f5a300` | `0xf5a300` | Warm orange, emissive 1.4-2.0 |
| 7 | Amber detonation | `#ffd86b` | `0xffd86b` | Bright yellow, peak frame of explosion |
| 8 | Chain-lightning | `#a8e6ff` | `0xa8e6ff` | Cool cyan-white, line-weight arcs |

**No off-palette colors.** Greens outside slots 4-5 are out. Reds are out
entirely. Stick to the 8.

## Line Weight + Bloom Feel
Reference: Spider Web FX is the quality bar
(`feedback_kitty_kaki_fx_quality.md`). Rune ring texture is canonical.

- Ring shockwaves: **line weight = 0.06-0.10 world units**, additive blend,
  bloom-tagged via `mesh.layers.enable(BLOOM_LAYER)`. Crisp inner rim, soft
  outer fade. NOT chunky/blocky.
- Crystal facet edges: use `flatShading: true` + per-instance tilt so light
  catches asymmetrically. Avoid smooth-shaded plastic look.
- Emissive intensity: bio-glow 1.2-1.8, amber idle 1.4-2.0, amber detonation
  peak 3.5 (single frame), chain arcs 2.5.
- No texture-mapped trees. Use merged BufferGeometry + flat shading. Reads
  cleaner under bloom than UV-mapped stone textures.

## Explosive Amber — Ring Shockwave Spec
Concrete visual contract for the Amber Interactable Agent:

1. **Idle state**: pulse emissive between 1.4 and 2.0 at 0.7 Hz on slot 6.
   Subtle 0.04-amp Y-bob.
2. **Detonation frame 0**: single-frame flash to emissive 3.5 on slot 7
   (yellow), particles erupt outward 4u radius.
3. **Shockwave (0.0-0.6s)**: expanding ring on slot 8 (cyan-white), inner
   radius grows 0u → 4u, line weight 0.08, additive blend, bloom on. Opacity
   1.0 → 0.0 cubic ease-out.
4. **Chain-lightning (0.0-0.4s)**: zig-zag line segments slot 8 between
   detonation point and nearest 3 enemies within 5u. Reuse existing chain
   weapon FX style (see `src/weapons/sig/rocker_powerchord.js` and
   `bezelbug_facet.js`).
5. **Crystal shatter shards**: 8-12 small slot-3 fragments fly outward with
   gravity, fade after 0.8s. Bloom OFF (decor).

## Choke-Corridor Density Targets
For the Decor Agent placement noise:
- 3-5 dense crystal clumps inside the 60u play ring at radii 18-50u.
- Each clump: 6-10 crystal trees in a 3-5u cluster, with 2-3u gaps creating
  natural funnels.
- Open arc between clumps so the player always has 1-2 escape routes.
- Amber hotspots (~20 total): seed 1-2 amber per clump-perimeter at radius
  20-55u. Avoid the spawn center (radius <15u).

## Hotspot JSON Contract
Decor Agent writes `assets/forest_amber_hotspots.json` after scatter:
```json
[
  { "x": 24.5, "z": -18.2, "scale": 1.1, "seed": 42 },
  { "x": -31.0, "z": 14.7, "scale": 0.95, "seed": 43 }
]
```
Amber Agent reads this at stage load to spawn entities. `seed` lets per-amber
visual variation be deterministic across reloads.

## Audio Style
Audio Agent: Kenney CC0 / freesound CC0/CC-BY only.
- Ambient: low wind through crystals + occasional distant chime. Loop seamless.
- Crystal shatter SFX: bright glassy break with low rumble layer. 0.4-0.7s.
- Detonation: warm boom + electric crackle. 0.6-1.0s. ffmpeg normalize to
  -16 LUFS to match existing weapon SFX bus.

## What's OUT
- Brown/sepia tones (cinder owns warm-decay)
- Purple (twilight owns it — see arenaDecor twilight pack)
- Red/orange ground emission (cinder)
- Smooth shaded plastic crystals
- Procedural particles with off-palette colors
- Any geometry that creates pathing dead-ends (enemies.js has no pathfinding;
  see slow-zones note in Hazards Phase 3 brief)
