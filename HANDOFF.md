# Kitty Kaki Survivors — Handoff for Next Claude Session (2026-05-14)

> **Heads up:** this handoff was written from a Windows session. The next session is opening in WSL — paths become `/mnt/c/Users/rneeb/Documents/kitty-kaki-survivors`. PowerShell commands won't work; use bash. Git remote + repo state is the source of truth across both.

---

## Iter 14 (2026-05-14, this session) — Dungeon & Environment Pro-Quality Pass

**User feedback** (verbatim): *"the dungeons are basic looking too, cant we use high quality assets, theres tons of them online and we've used them before, research and build out the dungeons with real assets... go deep, max effort, max agents"*

Shipped commits (in order):
- `5f16812` — `DUNGEON_OVERHAUL.md` plan
- `6a0d4dc` — Asset acquisition: 20 CC0 GLBs (Quaternius town + Lousberg dungeon + ruins + torches), 2.8 MB total, sorted under `assets/kits/{town,dungeon,ruins,torches}/`. `scripts/fetch-kits.sh` is idempotent and re-runnable. `assets/ASSETS_MANIFEST.md` catalogs sources + licenses.
- `3d576ea` — `src/env.js` forest: real Quaternius kingdom-district buildings replace `_makeBuilding` BoxGeometry placeholders. Per-stage lighting added to `applyStageTint` (twilight cool dusk, cinder hot orange, void crypt-violet).
- `8abe231` — `src/catacomb.js`: real Lousberg pillars/coffins/crypt/bones/arch. Walls + floor pick up PBR stone material (brown_mud retinted). Quaternius wall-torch GLB with ember-cone + flicker.
- `eb4da4e` — `src/arenaDecor.js`: 18 Lousberg gravestones in twilight, basalt-black cinder rocks + 10 charred stumps, real-GLB cardinal pillars + 14 grounded bones in catacomb/void.
- `327826d` — `src/town.js`: Quaternius Fantasy House (`kit_house`) cabin + Castle Gate (`kit_gate`) adventure gate, portal disc + audio cue preserved.

**Hands-off**: AoE FX agent (`a9a5d4d7489b52f96`) was editing `bossTelegraphs.js / fx.js / miniEvents.js / particleTextures.js / stageHazards.js / weapons/frostbloom.js / weapons/sigilbell.js / FX_AUDIT_V2.md` simultaneously. None of those files were touched in this iter. All my commits used explicit `git add <path>` to keep their work-in-progress dirty.

**Punted to iter 15**:
- `src/interior.js` cabin interior primitives (out of scope — interior is iso-only and reads fine at that camera; user feedback was the dungeon/forest, not the room).
- Atmospheric per-stage particles (pollen / wisps / embers / ghost sparkles). Spec is in `DUNGEON_OVERHAUL.md` — depends on the AoE agent's `particleTextures.js` changes landing first so we don't merge-conflict.
- ASSETS.md is now superseded by `assets/ASSETS_MANIFEST.md` but not deleted — manifest covers iter-14 assets only; ASSETS.md has the original Poly Pizza pickup props.

**Credits**: all 20 new GLBs are CC0 (Quaternius + Kay Lousberg). No `ui.js` credit-modal merge needed.

**Live URL**: rebuild after push, hard-refresh https://dknos.github.io/kitty-kaki-survivors/. Forest stage should now show real medieval buildings; press E on the catacomb stairs → real Lousberg dungeon chamber. Stages should feel distinct (gravestones in twilight, basalt rocks + char-stumps in cinder, ossuary bones in void).

---

## Project at a glance

- **Repo:** `dknos/kitty-kaki-survivors` (GitHub Pages from `main` branch root)
- **Live URL:** https://dknos.github.io/kitty-kaki-survivors/ (rebuild ~60s after push)
- **Stack:** THREE.js **0.160** via importmap. No bundler. Served as static files.
- **Genre:** Vampire-Survivors-style horde game with a hub town, interior, dungeon, multiple stages.
- **Pages flow:** push to `main` → wait ~60s → hard-refresh the live URL to test.

## Standing user mandate

Direct quote from the user, still in force:

> "talk to advisor and finish all tasks, plan improve iterate the game until it is fully shippable and able to compete with the best survivors games ever made"

User also asked us to "use sota technologies, send out agents to for nvidia hugging face research to utilize latest technology and find latest techniques on github/academic/arvix for best practices and coolest features". See `SOTA_RESEARCH.md` in the repo — research is already done. Headline finding: **r171 + TSL compute particles is the biggest unlock**, queued as iter 11 (post-roadmap).

User collaboration style:
- Likes parallel worktree/background agents (3 per iteration is the cadence)
- Commits and pushes after every iteration so Pages reflects state
- Reports bugs by user-visible symptom ("blue squares orbit", "wolf walks backward", "ring effects look plain AI glow") — fix the symptom AND root cause
- No long-winded summaries; show what changed and what's next

## Roadmap & current task list

# 🚀 v1.0.0 SHIPPED (commit `a3e8bb4`)

10-iteration shippability plan + a post-roadmap r171 spike. **All 11 iters complete. v1.0 live at https://dknos.github.io/kitty-kaki-survivors/.**

| # | Iter | Status |
|---|---|---|
| 26-30 | Iters 1-5 | completed (Combat Grammar / One More Slot / Controller First / Stage Rules / Teach the Loop) |
| 31 | Iter 6: Meta With Teeth (sigils + branching shop + presets) | **completed** `ded59e3` |
| 32 | Iter 7: Roster Pressure (signatures + Phoenix + Clockwork) | **completed** `593ab7f` |
| 33 | Iter 8: Enemy Identity (affixes + per-boss patterns + codex) | **completed** `61617a7` |
| 34 | Iter 9: Retention Hooks (weekly mutator + share card + DAG + Hall of Records) | **completed** `0b2fe5a` |
| 35 | Iter 10: Polish Lock (audio/a11y, tier-4 capstones, FX residue, ship rituals) | **completed** `4836f98` |
| 36 | **Iter 11: Shop Tree Live Wires (RE-PRIORITIZED from r171 spike)** — closes the tier-1-3 consumer gap discovered by 10b. KK_VERSION → 1.0.0. | **completed** `a3e8bb4` 🚢 |
| 37 | Iter 12: r171 + TSL compute particles spike (worktree-isolated) | **completed — NO-GO verdict, deferred to v1.1** (see `../kk-survivors-r171/R171_SPIKE.md`) |
| — | Tutorial disable | shipped `364a527` (user feedback: tutorial cards are annoying) |
| 38+ | Iter 13+ candidates | open polish backlog (none ship-blocking): r171 retry with TSL bloom port (4-6 days), notifyCombatPressure caller wiring, og-card.png screenshot, shop-tree-passive in-game tooltips, orbitals passive_cooldown via dmgInterval knob, perf hardening if user reports drops, Cloudflare leaderboard, touch/mobile, i18n actual translations, OST |

WSL session may have a fresh task list — if so, re-create these from this table.

**Pre-generated briefs:**
- `ITER_789_BRIEFS.md` — 3-agent splits for iters 7-9 (data/hooks/UI). All shipped.
- `ITER_10_11_BRIEFS.md` — iter 10 + iter 11 (r171 spike) + ship reassessment (8-point quality checklist).
- `FX_AUDIT.md` — FX placeholder audit from 2026-05-14 pass.

**Loop state:** STOPPED. All planned iters shipped or deferred. v1.0 live; no needle-moving work remains in scope per user mandate. Next session can pick up iter 13+ candidates above if user requests.

## Iter 12 spike outcome (post-v1.0)

`../kk-survivors-r171` worktree on branch `iter-12-spike-r171`. **NO-GO for v1.0.x.** r171's TSL `PostProcessing` has no camera-layer-mask sub-pass; porting our selective bloom (23 `BLOOM_LAYER` call sites + 80-line `PostFXShader`) would be 700-900 LOC across 26+ files — exceeds the 2x file-surface budget. WebGL2 stays the rendering floor. Worktree branch is left in place for future v1.1 retry; full findings in `../kk-survivors-r171/R171_SPIKE.md`. The 12b perf-compare harness (`compareRenderers` extension to perfSoak.js) also lives on the spike branch; can be cherry-picked if useful.

To resume v1.1: read `R171_SPIKE.md` "What would unblock a future GO" section. Estimated 4-6 days focused work (Pattern A vs B bloom decision, PostFXShader → TSL nodes port, `onBeforeCompile` splices to NodeMaterial rewrite with WebGL2 fallback alive, shadow bias visual gate, run `compareRenderers` on iGPU + dGPU).

## Iteration pattern (use it)

For each iteration:
1. Mark task `in_progress`.
2. Spawn **3 parallel background agents** (`Agent` tool, `run_in_background: true`) on **non-overlapping file surfaces**. Brief them with file paths + concrete API + "do NOT touch X (other agent owns it)".
3. Wait for completion notifications. Verify with `git status`, `node --check`, and quick smoke imports.
4. Commit + push with a detailed message listing what shipped per sub-task.
5. Mark task `completed`, set next iteration `in_progress`.

When agents touch the same file (e.g. `main.js`, `ui.js`), expect 3-way merges. Strategy that worked: pick the agent with the largest changes as base, manually re-apply others' specific additions.

**Background agents cannot commit** (shell permission denied). They leave files in place; the parent session commits.

## Recent commits (top of `main`)

- `d1e6ea3` Iter 10/11 briefs + ship reassessment (898 lines)
- `0b2fe5a` Iter 9: Retention Hooks — weekly mutator + share card + achievement DAG + Hall of Records
- `61617a7` Iter 8: Enemy Identity — affixes + per-boss patterns + codex
- `593ab7f` Iter 7: Roster Pressure — character signatures + Phoenix + Clockwork
- `ff42d8a` Handoff refresh
- `7b8ebc2` FX quality pass — burgers fixed, rings rune-textured, 18 new particle helpers
- `c3ef07d` Remove persistent "Skip tutorial" corner button
- `ded59e3` Iter 6: Meta With Teeth — sigils + 3-branch shop tree + presets

## Architecture (the parts you need to know)

### Scene-swap state machine
`state.mode ∈ {'menu', 'town', 'interior', 'catacomb', 'run'}`. Run lifecycle hooks live in `src/main.js`: `_primeRunStart`, `_teardownActiveRun`. Most subsystems init at boot once and reset on run start.

### Key modules
- `src/main.js` — render loop, mode branches, run lifecycle, camera, sun shadow follow
- `src/state.js` — central mutable state (always import `{ state }`)
- `src/config.js` — STAGES, ENEMY_TIERS, HERO, WORLD, XP tunables
- `src/meta.js` — persistent localStorage (`meta.tutorialDone`, `meta.codex`, `meta.runHistory`, shop levels, currencies)
- `src/audio.js` — WebAudio procedural synth + ~17 SFX hooks
- `src/postfx.js` — selective bloom via `BLOOM_LAYER`, two-composer pipeline
- `src/enemies.js` — spawn, AI step, kill, procAnim (`'crawl'|'hover'|'hop'|'flap'|'inch'|'pad'`), faceYaw radians (replaced old faceFlip bool)
- `src/weapons/` — 6 modules in `REGISTRY`, 5 evolutions in `EVOLUTIONS`. Passives in `passives.js` use idempotent `apply(level, prev)` pattern — divide out `prev` before applying new. Passives set `state.run.passive_*` scalars consumed elsewhere.
- `src/xp.js` — InstancedMesh gem pool (cap 500), level-up vacuum, soft cap at 60 active
- `src/ui.js` — every modal pushes a focus scope via `uiFocus.js`
- `src/uiFocus.js` — keyboard/gamepad nav with focus scope stack
- `src/buttonPrompts.js` — device-aware glyph pills (E↔B etc.) auto-refresh on device flip
- `src/gamepad.js` — XInput layer; `gamepadState`, `getAimDirection()`. `input.activeDevice` flips on last-touched device.
- `src/tutorial.js` — 6-stage first-run guide. **Important:** stage 1 must NOT pause the game (deadlocks movement). Already fixed in `36dccd8`.
- `src/tooltips.js` — 200ms hover delay, listens for `kk-focus-change` CustomEvent
- `src/codex.js` — bestiary/weapons/passives/secrets tabs. Discovery hooks called from `enemies.js`, `xp.js`, `weapons/index.js`.
- `src/runHistory.js` — last 20 runs, re-roll-seed button per row
- `src/stageRules.js` — per-stage modifier registry: `onRunStart`, `onTick`, `onEnemySpawn`, `notify*`
- `src/miniEvents.js` — one-slot scheduler for Treasure Goblin / Meteor Shower / Elite Pack
- `src/arenaProps.js` — destructible barrels/crates/totems
- `src/arenaDecor.js` — InstancedMesh biome decor (trees/grass/crystals/runes/rocks/bones)
- `src/stageHazards.js` — pollen, fog (`uInner`/`uOuter` shrink on twilight surge), lava (`spawnLavaPuddle` exported)
- `src/blobShadows.js` — InstancedMesh contact discs. **Hero gets a tight blob on top of its real PCF shadow** — without this the PCF alone reads as a green smear from hemi bounce.
- `src/enemyTells.js` — exports `makeRuneRingTexture()` for shared rune-disc art (boss telegraphs reuse it).
- `src/env.js` — lights + ground. Hemi groundColor is **neutral gray** (`0x1a1a1f`), NOT green.

### Visual style locked in
- 8-color palette + 4/2/1 px line weights. See `STYLE_BIBLE.md` + `style-bible.html`.
- Procedural rune ring texture (radial falloff + ticks + 4 cardinal glyphs) is the canonical "magic AoE" look. Reused by enemy elite tells, boss wind-ups, shockwaves. Reuse it for new rings — do NOT use flat `RingGeometry` + `MeshBasicMaterial`. Import `makeRuneRingTexture` from `src/enemyTells.js`.
- BLOOM_LAYER is selective — only emissive/FX meshes opt in. Don't put bulk geometry on it (cheese-burger blue-squares bug came from BLOOM on a wide cheese mesh).

### Common gotchas
- `node --check src/foo.js` works for syntax. Full `import` fails locally because `three` is loaded via importmap, not node_modules.
- LF↔CRLF warnings on every commit are normal noise.
- Don't auto-add `--no-verify` / skip hooks.
- All assets/textures are procedural (canvas) or GLB drop-ins from `assets/`. No npm dependencies.

## What to do next

**Iter 10: Polish Lock** is in_progress at time of writing (3 bg agents running). Brief at `ITER_10_11_BRIEFS.md` "Iter 10" section. If you arrive between fan-outs:
- 3-agent split: 10a (audio split + settings overhaul + accessibility), 10b (FX residue + tier-4 capstones + leap marker + perf soak), 10c (credits + LICENSE + how-to-play + og: tags + error UI).
- Five ship-blockers being closed: tier-4 SHOP_TREE TODO(iter6-wire) capstones (Phoenix revive cap, Overdrive 60s frenzy, Treasure Map starter chest); leap affix landing marker; LICENSE absent; WebGL context-loss handler absent; zero accessibility coverage.

**After iter 10 ships**: run `window.kkSoak({seconds: 60, seed: 'iter10soak', spawnMul: 1.5})` from console — target p99 ≤ 22ms. If pass → v1.0 ships. Iter 11 (r171 + TSL spike) runs after but does NOT gate v1.0; "documented + deferred" is a valid iter-11 outcome.

**Iter 12+ candidates** (from ITER_10_11_BRIEFS.md reassessment): perf hardening if soak fails, Cloudflare remote leaderboard, touch/mobile, i18n actual translations, r171 promotion if spike successful, original soundtrack.

## Surfaces shipped this milestone (don't break these)

### Iter 6 — Meta
- `meta.sigils` currency; `grantSigils(n, source)` exported from `src/meta.js`
- `SHOP_TREE` 12-node branching upgrade tree (3 branches × 4 tiers); persisted in `meta.shopTree`. **Tier-4 capstones get wired in iter 10b (was `// TODO(iter6-wire)`).**
- `meta.presets` character+stage convenience loadouts (cap 6)
- `state.run.passive_*` scalar pattern: `passive_dmgReduction`, `passive_dmg`, `passive_cooldown`, `passive_critChance`, `passive_regen`, `passive_coinMul`, `passive_chestRate`, `passive_miniBossSigilBonus`, `passive_revives`, `passive_overdrive`, `passive_treasureMap`
- `commitRunResults()` returns `sigilsEarned`; death screen shows sigil row (magenta `#c87bff`)
- Start screen has presets row (`_startPresetRowRef`) between stage row and play buttons

### Iter 7 — Roster
- Each `CHARACTERS` entry has `signature(runState)`, `signatureName`, `signatureDesc`. Six total: kitty, boom, webspinner, sniper, phoenix (sigils:30), clockwork (Boss Rush + Twilight victory).
- `isCharacterUnlocked(char, meta)` handles legacy achievement, `sigils:N`, `flag:fieldName` unlock forms.
- `meta.lifetime.sigilsEarned` monotonic counter (drives sigil-gated unlocks). `meta.unlockedClockwork` flag.
- `state.run.signature_*` fields stamped at run start (signature_nineLives / chainEcho / chainEchoCounter / webHeal / executeBonus / emberBurst / tempo / tempoBonus).

### Iter 8 — Enemy Identity
- `src/enemyAffixes.js` exports `AFFIX_POOL` + `rollAffixes(enemy, D)`. 6 affixes: volatile, vampiric, leaping, shielded, swift, frosted.
- `e.affixes` array on enemy, slot fields `_volatile`, `_vampPct=0.15`, `_leapCD/_leapWindup`, `_shieldHp/_shieldedRim`, `_swiftMul`, `_frostAura`.
- `state.fx.pendingVolatile` queue (paused-aware; drained in updateEnemies).
- `state.run.affix_frostSlow` per-frame value (1 default, 0.75 in aura).
- `MINI_BOSS_PATTERNS` array in bossTelegraphs.js: Grothar Engulf (cyan), Vexmaw Sonic Cone (magenta), Oblidor Quake Cross (amber); NIGHTMARE cycles all 3.
- `state.run.signature_engulfSlowUntil` read by hero.js movement.
- Codex Affixes tab + Legend overlay; `notifyAffixSeen(id)` exported from codex.js.

### Iter 9 — Retention
- `isoWeekKey()`, `weeklyMutatorConfig()`, `commitWeeklyRun()` exports from meta.js.
- `WEEKLY_MUTATORS` (6) in src/weeklyMutator.js: DOUBLE_SPAWNS, HALF_HP_HALF_DMG, CHEST_LOCKDOWN, BOSS_PARADE, NO_PASSIVES, XP_FAMINE. Effects stamp `state.run.weekly*` fields.
- ACHIEVEMENTS extended to 3-tier DAG (8/6/3). `achievementChain(id)` returns parents/children/percentComplete.
- `src/shareCard.js`: `renderShareCard(runEntry, charSummary)` → 1200×630 OG canvas; `downloadShareCard()` uses `canvas.toBlob` (NEVER toDataURL).
- `state.replaySeed` set from `?seed=` URL param at boot.
- Codex new tabs: Achievements (DAG), Mutators (weekly lore).
- Start screen: Weekly button (magenta), Records button (Hall of Records modal), share-pip (📋) on Daily/Weekly cards.
- Death screen: SHARE button + 200×105 preview thumbnail.

## FX quality bar (user-locked, 2026-05-14)

User feedback: "spider web is good, burgers are mid". Spider web FX (`src/weapons/web.js`) is the visual quality bar. `makeRuneRingTexture()` from `src/enemyTells.js` is canonical for any AoE ring. Flat `RingGeometry + MeshBasicMaterial` is the explicit anti-pattern. `src/particleTextures.js` now has 18 procedural helpers (twinkle ×3, bunCap, cheeseSlice ×2, pattyTop, hearts, stars, bombs, snowflake, drumstick, pollen, lavaPuddle, wizardBolt ×3) — reuse before adding new ones. FX deferred next pass: `town.js`/`interior.js`/`catacomb.js` rune circles (per `FX_AUDIT.md`).

## Pending bug-fix watchlist

Nothing open as of `7b8ebc2`. User confirmed/asked for: Skip-tutorial button removal (shipped `c3ef07d`), FX placeholder cleanup (shipped `7b8ebc2`).

## How to verify your work before pushing

```bash
cd /mnt/c/Users/rneeb/Documents/kitty-kaki-survivors
git status --short
for f in src/<changed>; do node --check "$f"; done
git diff --stat
git push origin main
# Wait ~60s, hard-refresh https://dknos.github.io/kitty-kaki-survivors/
```

## Memory references

`MEMORY.md` index lives at `~/.claude/projects/.../memory/`. WSL session has its own memory dir — likely empty or different. Check on first user prompt; persist new learnings there.

---

Mandate: ship.
