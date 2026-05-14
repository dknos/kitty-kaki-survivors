# Kitty Kaki Survivors

**▶ Play now: [dknos.github.io/kitty-kaki-survivors](https://dknos.github.io/kitty-kaki-survivors/)**

A Vampire-Survivors-style auto-attacking horde game built in **THREE.js** with no bundler. Slot-machine treasure chests, evolving weapons, animated bug swarms, branching meta tree, daily + weekly challenges, character signatures, and a shipped accessibility menu.

[**Play Now**](https://dknos.github.io/kitty-kaki-survivors/) · [**How to Play**](how-to-play.html) · [Report a Bug](https://github.com/dknos/kitty-kaki-survivors/issues)

<!-- TODO: assets/screenshot.png (1280x720) -->
<!-- TODO: assets/demo.gif    (loop, ~3s) -->

**Version:** v1.0.0-rc1 · **Status:** release-candidate (iter 10 polish lock)

**▶ Play locally:** `npx serve` then open `http://localhost:5180/`.

## Controls

| Key | Action |
|---|---|
| **WASD / Arrows / Left Stick** | Move |
| **Space / A button** | Jump |
| **Shift / B button** | Dash (after unlock) |
| **Mouse / Right Stick** | Manual aim (optional) |
| **Mouse wheel / Pinch** | Zoom (after unlock) |
| **F1** | Codex |
| **F3** | Performance overlay |
| **ESC** | Options / close modal |
| **R** | Retry (on death/victory screen) |

## Features

- **4 weapons + evolutions** — Holy Croissants, Magic Missile, Chain Lightning, Sticky Web. Each evolves at max level + 3 picks of a paired filler: Toxic Halo, Storm, Volley, Tangle.
- **6 characters with signatures** — Kitty (Nine Lives), Boom (Charged Coil), Webspinner (Lingering Silk), Sniper (Headhunter), Phoenix (Ember Burst), Clockwork (Tempo).
- **3 stages + per-stage rules** — Forest, Twilight Hollow, Cinder Caverns; each rotates biome, hazards, and horde mix.
- **Enemy affixes** — Volatile / Vampiric / Leaping / Shielded / Swift / Frosted with distinct tells and counterplay.
- **Per-boss patterns** — Engulf, Sonic Cone, Quake Cross, Nightmare cycle replace the one-trick shockwave.
- **Branching shop tree** — 3 branches × 4 tiers = 12 nodes. Tier-4 capstones (Phoenix, Overdrive, Treasure Map) are real, wired effects.
- **Treasure chests + slot machine** — drops from elites + every 75s. 7-7-7 jackpot = max upgrade. Double-or-nothing gamble.
- **Daily Challenge + Weekly Mutator** — same seed for all players; weekly rotates Monday with rule-changing modifiers.
- **Hall of Records (local)** — top runs across all characters/stages.
- **Achievement DAG + Codex** — discovery log unlocks as you encounter content.
- **Share card** — 1200×630 PNG of a run, copy-and-paste-ready for Discord / Twitter.
- **Accessibility menu** — separate Master / Music / SFX volume, Reduce Motion, Reduced Flashing, High Contrast, Colorblind palette, Font Scale, Frame Cap, Controller Deadzone, Save Export/Import, Reset Progress.
- **Visual polish** — selective bloom, vertex-shader leg/wing animation, HDRI environment, blob shadows, rim light, ACES Filmic tone mapping, height fog, LGG color grade.

## Stack

- **THREE.js 0.160** via importmap (no bundler)
- **No tests**, no TypeScript — single-file modules
- DPR 1.75 cap, selective-bloom EffectComposer pipeline, InstancedMesh-pooled FX (kill rings, sparks, blob shadows, pickups, leap markers, ranged tells)
- Procedural particle textures + procedural Web Audio (music split from SFX)
- Vertex animation injection via `onBeforeCompile` for static bug GLBs
- Per-instance material clone for damage flash + hue jitter

## Credits

Made by [@slopfactory9000](mailto:slopfactory9000@gmail.com).

**Models — all CC0 / CC-BY:**
- **Quaternius** — Ultimate Monsters bundle (Mushnub, Cactoro, Goleling, Orc, Demon, Yeti, Pink Slime, Ghost, Dragon, Mushroom King, Wasp, Spider, Wolf) and chest models — CC0
- **Poly by Google** (via [Poly Pizza](https://poly.pizza)) — Beetle, Ladybug, Grasshopper, Mantis, Cockroach, Ant, Bee, Butterfly, Caterpillar — CC-BY

**Textures &amp; HDRI:**
- **Poly Haven** — `forrest_ground_01` (1k diff/rough/normal), `approaching_storm` HDRI — CC0

**Tech:**
- [THREE.js](https://threejs.org) + addons (EffectComposer, GLTFLoader, DRACOLoader)

**Inspiration:** Vampire Survivors, Halls of Torment, Hades.

**Special thanks:** Claude Opus 4.7 (1M context) for the iter 1-11 pair-programming sprint.

## Architecture

```
src/
  main.js              # bootstrap + RAF loop + context-loss handlers
  state.js             # single mutable game state
  config.js            # tunables (DAMAGE, JUMP, DASH, ENEMY_TIERS, etc.)
  assets.js            # GLTF preload, material upgrade, vertex anim injection
  particleTextures.js  # canvas-rendered glow/spark/smoke textures
  postfx.js            # bloom composer + composite + LGG grade + height fog
  env.js               # ground, lights, HDRI environment, scenery scatter
  hero.js              # input → movement/jump/dash/walk anim/death anim
  enemies.js           # spawn, pool, AI, AnimationMixer, proc anim, flash, DoT
  enemyAffixes.js      # Volatile / Vampiric / Leaping / Shielded / Swift / Frosted
  enemyTells.js        # InstancedMesh ranged-tells, threat dots, leap markers
  enemyProjectiles.js  # wizard fireballs
  bossTelegraphs.js    # per-boss attack tells (engulf / cone / cross / nightmare)
  fx.js                # InstancedMesh pools: kill rings, sparks, pickup ring
  blobShadows.js       # InstancedMesh of soft dark circles under characters
  damageNumbers.js     # DOM-overlay floating numbers (1.2K format)
  xp.js                # gem InstancedMesh + magnetize + per-tier color
  pickups.js           # 3D extruded heart + star pickups
  chest.js             # chest spawn + open-flash + slot machine trigger
  slotMachine.js       # symbols, outcome resolution, jackpot apply
  spawnDirector.js     # D(t) curve, hordes, mini-bosses @ 4/8/12, final @ 15
  meta.js              # localStorage save (coins/sigils/runs/best/achievements)
  ui.js                # HUD, level-up modal, death screen, banners, toasts, credits
  audio.js             # procedural Web Audio sfx + tiered music (Master/Music/SFX)
  input.js             # keyboard / touch / wheel zoom (notched) / Shift dash / Space jump
  gamepad.js           # gamepad mapping + deadzone (configurable)
  uiFocus.js           # focus-scope stack + arrow/enter navigation
  weeklyMutator.js     # 7-day rotating rule modifiers
  weapons/
    index.js           # registry, evolutions, fillers
    orbitals.js        # Holy Croissants → Toxic Halo
    autoAim.js         # Magic Missile → Volley
    chain.js           # Chain Lightning → Storm
    web.js             # Sticky Web → Tangle
```

## License

Code under MIT — see [LICENSE](LICENSE). Assets keep their original CC0 / CC-BY terms (see Credits above).
