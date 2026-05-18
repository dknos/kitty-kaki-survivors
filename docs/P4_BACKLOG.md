# PHASE 4 Backlog — kitty-kaki-survivors

Author: Claude C  ·  Opened: 2026-05-18  ·  Advisor-ordered sequence

## Sequencing (advisor)

1. **P4J Telemetry harness** — solo, unblocks all downstream balance/NG+/daily/Cave decisions. Ship FIRST.
2. **P4G Audio mixer** + **P4H Accessibility** — foundation, harder to retrofit after Cave doubles audio/palette surface.
3. **P4D NG+ modifiers** + **P4F Char unlock chain** + **P4E Daily seed leaderboard** — replay multipliers on existing forest, near-zero new asset work.
4. **P4K Stage-author docs** authored *alongside* **P4A Cave skeleton** — Cave becomes canonical template. Cave = full pro-asset commit (~20–30 cohorts to match forest texture coverage: sky, ground normal, walls, stalactites, chest, coffin, neutrals, hazards, weapons, music phases, achievements).
5. **P4I Balance pass** — last, requires P4J data + play sessions.

## Constraints (must honor)

- **Pro-asset rule applies to Cave.** Raw-geometry Cave = debt. Either commit to full texture push or pause Cave.
- **Cohort parallelism cap: 2.** Different files only. NG+ + Cave touch overlapping run/stage code → serialize.
- **Cron exit explicit.** Each cron tick checks acceptance; if all items in current phase meet acceptance → emit `iteration tick: P4 fully shipped, awaiting user direction` and stop.
- **Smoke gates unchanged:** `smoke-sig-weapons`, `smoke-sprite-fx`, `smoke-forest-v2` must pass per merge.

## Acceptance criteria (one line per item — must be checkable)

| ID | Item | Acceptance |
|----|------|-----------|
| P4J | Telemetry harness | ✅ 208b89a — `src/telemetry.js` collects per-run stats (duration, kills, picks, deaths, weapons taken, evolves) → localStorage `kks_telemetry`. Export JSON button on end-run summary. Schema v1. smoke-p4j-telemetry passes. |
| P4G | Audio mixer | ✅ 9d27047 — 4 sliders (master/music/sfx/ambient) in options modal (Escape pause + main-menu Settings both route to showOptions; no separate pause DOM in repo). Persist to localStorage. All 12 SFX route through _sfxBus; 5 forest day/night music tracks + flat stage ambient loops route through new _ambientBus; procedural in-run music + menu bed remain on _musicBus. Mute = 0 amplitude (play() still fires; _playCounts increments under gain=0). smoke-p4g-mixer verifies 4-bus existence + mute-≠-skip + localStorage round-trip + schema readability. |
| P4H | Accessibility | ✅ efee0d9 — (a) Colorblind palette toggle (deuteranopia variant of forest 8-color), (b) screen-shake 0–100% slider, (c) hold-to-confirm toggle on irreversible menu actions. All persist. Smoke loads w/ each toggle off+on. |
| P4D | NG+ modifiers | ✅ def6428 — 3 modifiers unlock on first forest clear (state.victory OR reaperOutlasted edge in src/forestAchievements.js): Mirror Mobs (+50% spawn via swarmMul in src/spawnDirector.js), Twin Bosses (paired adjacent boss in spawnMiniBoss + spawnFinalBoss, _isTwin tag on the live enemy), Half Pickups (50% pre-gate in src/forestPickups.js dropForestPickup). Toggle pre-run from menuV2 continue card (forest-only, greyed when !meta.unlockedNgPlus). state.modes mirror in main.js applyMetaUpgrades so telemetry beginRun auto-tags the trio. smoke-p4d-ngplus drives tickSpawnDirector directly + clean-pool probe for half-pickup; baseline vs each flag independent. |
| P4F | Char unlock chain | 3 hidden chars gated on forest achievements (e.g. "clear w/o damage", "100 mushroom rings dodged", "Reaper survived 60s"). Unlock toast + persist to meta. Smoke verifies unlock flow. |
| P4E | Daily seed leaderboard | Deterministic seed-of-day (mulberry32(YYYYMMDD)). Local scoreboard top 10 per day. Shareable code = base64(seed+score+time+char). Smoke verifies same seed → same first 5 spawns. |
| P4K | Stage-author docs | `docs/STAGE_AUTHORING.md` documents: palette decl, sky dome wire, weapon registration, neutral/hazard/landmark slots, music phase hooks, achievement registration, smoke-test addition. Cave files referenced as canonical. |
| P4A | Cave stage (full pro-asset) | New stage `cave` selectable from menu. Full coverage: 5-color palette doc, 3 rooms, 2 forest-equivalent weapons, stalactite landmark, gloomshrimp neutral, cave-in hazard, sealed doors, 1 boss + 1 miniboss, 3-phase music, sky-dome equivalent (cave ceiling shader), ground normal, stone wall textures, achievements. smoke-cave-v2 passes 4 phases. |
| P4I | Balance pass | Read 50+ telemetry runs. Tune ≥3 forest weapon dps curves where p50 TTK > 8s on miniboss. Document deltas in `docs/BALANCE_LOG.md`. Smoke re-runs cohort regression. |

## Cron prompt v2 (replacing cron 7867187d)

```
P4 ITERATION TICK — sequence per docs/P4_BACKLOG.md.
1. Read docs/P4_BACKLOG.md acceptance table.
2. Find first item without acceptance met. If none → emit "iteration tick: P4 fully shipped, awaiting user direction" and stop.
3. Cohort plan ≤1 item at a time except telemetry+a11y/mixer (different files, safe parallel).
4. Branch off main, single PR, acceptance-criteria-passing smoke as merge gate.
5. Update P4_BACKLOG.md acceptance column with ✅ + commit sha on completion.
6. Never firebase deploy. Never force-push. Never npm install in this repo.
```
