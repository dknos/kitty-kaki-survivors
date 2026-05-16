# Forest Expansion v0.1 — Multi-Room + Puzzle-Gated Weapons

Source: 3-panel consult 2026-05-16 (Grok Level Designer + Grok Systems Designer + Gemini Team Lead + advisor file-path audit). User ask: "build out levels big huge and interesting, unique puzzles to unlock special weapons, different areas to explore, start with forest."

## 1. RECONCILED DESIGN

| Room | Theme | Size | Puzzle | Weapon Unlock |
|---|---|---|---|---|
| **The Glade** | Lush Heart hub w/ central tree + 3 portals | 90×90u | none (horde arena) | none |
| **Sap Hollow** | Lime sap floor, dripping ceiling | 40×60u | **Flow Weaver** — web 6 sap orbs into 3 conduits (75s) | **Sap Weaver** |
| **Crystal Choir Grove** | Singing crystal spires, sequence pads | 50×50u | **Harmonic Alignment** — repeat 5-step pad sequence (40s) | **Choir Lance** |
| **Amber Labyrinth** | Dense amber maze, low ceiling fog | 55×40u | **Prism Lock** — cycle prism rotations, align 3 beams 3s | **Prism Warden** |

## 2. SHIP CUT (v0.1)

**IN:** All 3 puzzle rooms + Glade hub + 3 weapons + meta-persistence + camera lerp/lock + touch parity.
**DEFERRED:** Mini-map (use pollen breadcrumb trails instead per Designer 1), meta-progressive difficulty arc (v0.2).

**Rationale:** Foundational engineering (state machine, room mgmt, persistence) costs the same for 1 or 3 rooms. Marginal cost low. Empty portals would look broken.

## 3. CANONICAL FILE PATHS (audited 2026-05-16)

**Repo uses flat single-file modules** (no `src/state/`, `src/levels/`, `src/objects/`, `src/puzzles/` directories). All new modules sit flat in `src/`.

- `src/state.js` (flat) — extend with new run/meta fields
- `src/hero.js` — player movement, NOT `src/player.js`
- `src/main.js` — camera init + RAF tick, NOT `src/camera.js`
- `src/weapons/` directory EXISTS — new weapons go there
- `src/fx/` directory EXISTS — new FX modules go there

**New files all flat in `src/`:**
- `src/forestRooms.js` (new) — room registry, bounds, portal positions, state machine
- `src/forestPortals.js` (new) — portal entity (reuses `voidTeleportPads.js` pattern)
- `src/puzzleSystem.js` (new) — generic puzzle state machine + timer + reward hook
- `src/puzzleFlowWeaver.js` (new) — Sap Hollow puzzle
- `src/puzzleHarmonicAlignment.js` (new) — Crystal Choir puzzle
- `src/puzzlePrismLock.js` (new) — Amber Labyrinth puzzle
- `src/weapons/sapWeaver.js` (new)
- `src/weapons/choirLance.js` (new)
- `src/weapons/prismWarden.js` (new)

**Modified files:**
- `src/state.js` — add `run.roomState`, `run.currentRoom`, `run.activePuzzle`, `run.forestPuzzlesSolved`
- `src/meta.js` — add `meta.forestWeapons[]`, `meta.forestPuzzlesSolved{}` (backward-compat `|| {}`)
- `src/main.js` — camera setRoomBounds + tick puzzle/room systems
- `src/hero.js` — interact key handler hook
- `src/spawnDirector.js` — pause/resume on room state, freeze D(t) clock
- `src/enemies.js` — room-scope despawn (>60u from room boundary)
- `src/arenaDecor.js` — extend `_buildForestDecor(roomId)` with per-room switch
- `src/weapons/index.js` — register 5th hidden slot for special weapons

## 4. SWARM COHORT PLAN (advisor-corrected, 3 cohorts)

### COHORT 1 — Foundation (2 agents, parallel)

**Agent 1 — Foundations.** Branch: `swarm/forest-foundations`
- OWNS: new `src/forestRooms.js`, modifies `src/state.js`, `src/meta.js`
- READ-ONLY: everything else
- TASK: room registry (3 rooms + Glade hub coords), state.run fields, meta backward-compat defaults
- Effort: M, Risk: HIGH (save schema)

**Agent 2 — Weapons.** Branch: `swarm/forest-weapons`
- OWNS: new `src/weapons/sapWeaver.js`, `src/weapons/choirLance.js`, `src/weapons/prismWarden.js`, modifies `src/weapons/index.js`
- READ-ONLY: `src/meta.js` (gated unlock check)
- TASK: 3 new weapon impls + 5th hidden slot register. Spider Web FX quality bar (line weight 0.06-0.10, additive, BLOOM_LAYER) MANDATORY for all 3.
- Effort: M, Risk: MED

### COHORT 2 — Puzzle Base (1 agent, solo)

**Agent 3 — Puzzle System + Room Geometry.** Branch: `swarm/forest-puzzles-base`
- OWNS: new `src/puzzleSystem.js`, modifies `src/arenaDecor.js` (per-room extension)
- READ-ONLY: `src/forestRooms.js` (Agent 1's), all FX modules
- TASK: generic puzzle state machine (timer, success/fail, reward emit) + extend `_buildForestDecor(roomId)` with switch for `'glade' | 'saphollow' | 'crystalchoir' | 'amberlabyrinth'`. InstancedMesh pool per room with visibility toggle.
- Effort: L, Risk: MED (perf — DPR 1.75 cap)

### COHORT 3 — Integration + Puzzles + Portals (3 agents, parallel — clean file ownership)

**Agent 4 — Integration Glue.** Branch: `swarm/forest-integration`
- OWNS: modifies `src/spawnDirector.js`, `src/enemies.js`, `src/main.js`, `src/hero.js`
- READ-ONLY: `src/forestRooms.js`, `src/state.js`
- TASKS:
  1. `spawnDirector.js`: pause D(t) curve on `PUZZLE_ACTIVE`, freeze `lastSpawnTime`, resume at 0.6× density for 30s smoothing
  2. `enemies.js`: room-scope despawn (>60u from room boundary, `enemy.room` field)
  3. `main.js`: camera setRoomBounds + 0.6s lerp on transition, tick puzzle/room systems
  4. `hero.js`: interact key (E / A-button) hook into puzzle interactions
  5. **Boss-at-15min rule:** if `state.run.roomState !== 'ARENA'` at boss spawn, force return to Glade (puzzle marked unsolved, no weapon, banner "FINAL BOSS — RETURN!")
- Effort: L, Risk: HIGH (touches 4 core files, horde clock desync risk)

**Agent 5 — Hub & Portals.** Branch: `swarm/forest-hub-portals`
- OWNS: new `src/forestPortals.js`
- READ-ONLY: `src/forestRooms.js`, `src/voidTeleportPads.js`
- TASKS: 3 portal entities in Glade pointing to Sap Hollow / Crystal Choir / Amber Labyrinth. Reuse voidTeleportPads visual pattern (amber-tinted). Pollen breadcrumb trails (InstancedMesh, seeded 0xC0FFEE) from central tree to each portal — NO mini-map.
- Effort: S, Risk: LOW

**Agent 6 — Puzzle Implementations.** Branch: `swarm/forest-puzzles-impl`
- OWNS: new `src/puzzleFlowWeaver.js`, `src/puzzleHarmonicAlignment.js`, `src/puzzlePrismLock.js`
- READ-ONLY: `src/puzzleSystem.js` (Agent 3's), `src/forestRooms.js`, `src/chainFx.js`, `src/forestAmber.js`, `src/ribbonTrail.js`
- TASKS: 3 concrete puzzles per spec. All visual beams/lines MUST match Spider Web FX quality bar (line weight 0.06-0.10, additive, BLOOM_LAYER, palette-locked forest 8-color).
- Effort: L, Risk: MED (softlock — 90s timeout MANDATORY)

## 5. RISK REGISTER (top 5)

1. **Save corruption** (HIGH) — backward-compat `|| {}` defaults at every new field read in `meta.js`. **Owner: Agent 1.**
2. **Horde clock desync** (HIGH) — freeze `spawnDirector.lastSpawnTime` on pause, restore + smooth 30s ramp on resume. **Owner: Agent 4.**
3. **Draw call explosion** (MED) — per-room InstancedMesh visibility toggle, max 2 rooms rendered. Monitor `renderer.info.render.calls` ≤ 38. **Owner: Agent 3.**
4. **Merge conflict via shared tree race** (MED — proven precedent this session) — every agent prompt MUST include: stash-detect → STOP and report (no silent recovery). Cohorts capped at 3 with cleanly-disjoint file ownership.
5. **Puzzle softlock** (MED) — 90s non-pausable timeout MANDATORY, auto-fail returns control. **Owner: Agent 6.**

## 6. SMOKE TEST PLAN

Each branch must pass `node tools/smoke-sig-weapons.mjs` AND its specific check:

- **Agent 1:** load game with empty localStorage → no crash, new meta fields default cleanly
- **Agent 2:** force `meta.forestWeapons.push('sap_weaver')` → weapon appears in 5th slot, fires
- **Agent 3:** force `state.run.currentRoom = 'saphollow'` → only Sap Hollow decor visible, others hidden
- **Agent 4:** force `state.run.roomState = 'PUZZLE_ACTIVE'` → spawnDirector pauses, no enemies spawn for 30s; force boss-spawn while in puzzle → forced-return banner fires
- **Agent 5:** load Forest stage → 3 portals visible in Glade w/ pollen breadcrumbs
- **Agent 6:** force `puzzleSystem._win('flow_weaver')` → `meta.forestPuzzlesSolved.flow_weaver = true`, weapon granted

## 7. REJECTED

- Mini-map (UI/input overhead, pollen trail cheaper)
- Global amber chain persistence across rooms (edge case bloat)
- Timer-based 800ms asset unload (state-machine-driven only)
- Adding 6 agents in one cohort (advisor: shared-tree race precedent — cap at 3, prefer 2)

## 8. HARD CONSTRAINTS (every agent prompt)

- NO `npm install`, NO new bundler, NO firebase deploy, NO force-push
- 8-color FOREST palette (`docs/FOREST_VISUAL_STYLE.md`)
- Single-file modules, InstancedMesh pools mandatory
- CC0/CC-BY only (Kenney, freesound, Quaternius, Poly Haven)
- DPR 1.75 cap holds
- Spider Web FX quality bar (line weight 0.06-0.10, additive, BLOOM_LAYER) for ALL new beam/line visuals — Agents 2, 3, 6
- Stash-detect on setup → STOP and report (no silent recovery)
- Single commit per agent, push branch, don't merge (orchestrator merges)
