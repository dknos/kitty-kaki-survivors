# Perf Audit Report — PHASE 2 P2B (#133)

> Headless capture, 30 s settle, gate `localStorage.kkPerf=1`.
> Run host: WSL2 swiftshader-GL, Playwright Chromium, 1280x720.
> Branch: `swarm/perf-audit`. Live snapshot:
>
> ```bash
> SETTLE_MS=30000 node /tmp/perf-capture-once.mjs > snap.json
> ```
>
> The capture script is intentionally NOT committed — it's a one-off probe.
> Repeat with the gate set in any browser console (`localStorage.setItem
> ('kkPerf','1'); location.reload();`) for a hardware-GL number.

## Run summary

| Metric         | Value           |
|----------------|-----------------|
| Frame count    | 60-frame rolling window |
| Subsystems tracked | 53          |
| Enemies alive (end of capture) | 104 |
| Draw calls     | 711             |
| Triangles      | 1.69 M          |
| `kkPerfSnapshot().fps` | 0.0 (headless — see "Caveat" below) |

### Caveat: headless figures are RELATIVE, not absolute

`tools/smoke-forest-v2.mjs` and the one-shot probe both run with
`--use-gl=swiftshader`. Real frame rate in that environment is 3-4 fps
(per cohort 15 note in the smoke header). The `render` row dominates the
window — that's the swiftshader composite + bloom cost, not a code
regression. Per-tick CPU work shown below is therefore much lower in
absolute terms than it would be at hardware-GL 60 fps (the work is the
same but it's distributed across far more frames per second). What
**does** transfer is **relative ordering** — the hottest CPU ticks here
will remain the hottest under hardware GL.

A hardware-GL re-run (open the dev server in Chrome, enable the gate,
play 30 s, copy `kkPerfProfilerSnapshot(15)`) is recommended before
shipping any fix — those numbers go into a follow-up cohort report.

## Top 10 hot ticks (avg ms over 60-frame window)

| # | Function (perfMark name) | avg ms | max ms | Notes |
|---|---|---:|---:|---|
| 1  | `render`           | 16.290 | 25.900 | GL composite + bloom (swiftshader). **Excluded from optimization scope — see "Render is GL, not code"**. |
| 2  | `enemies`          |  0.488 |  0.900 | `updateEnemies` — 104 alive in capture. Linear scan, spatial hash, blob shadow scatter. Hottest CPU tick. |
| 3  | `spawnDir`         |  0.057 |  1.800 | `tickSpawnDirector` — wave spawn logic. Avg cheap but max bursty (1.8 ms) when a wave dispatches. |
| 4  | `forestNeutrals`   |  0.055 |  0.300 | Roe deer / fireflies / lantern beetles wander loops. |
| 5  | `weapons`          |  0.055 |  0.800 | `tickWeapons` — all active weapons; each iterates its own projectiles. |
| 6  | `ui`               |  0.055 |  0.200 | `updateUI` — DOM HUD diffs. |
| 7  | `dmgNums`          |  0.032 |  0.200 | Damage number layout + fade. |
| 8  | `forestDayNight`   |  0.022 |  0.100 | Fog/light lerp per frame. |
| 9  | `gems`             |  0.020 |  0.100 | XP gem InstancedMesh magnet. |
| 10 | `trapCorridor`     |  0.018 |  0.300 | Forest trap-corridor segments tick. |

### Render is GL, not code

`render` averaging 16.290 ms in headless looks alarming but is entirely
swiftshader fragment cost — `kkPerfSnapshot().calls=711, tris=1.69M`.
Under hardware GL the same workload sits at ~7.5 ms per `PERF.md`. The
profiler still reports it because `perfMark('render', _p)` brackets the
THREE composite — that's correct behavior (so a hardware run can detect
a GL regression). For PHASE 2 P2B's "consistently >2 ms" gate, the
**CPU** subsystems below `render` are what matter.

## Functions consistently > 2 ms

**None observed in this capture** under headless conditions. The hottest
CPU subsystem (`enemies` at 0.49 ms avg) sits well under the 2 ms gate
even at 104 alive enemies. `spawnDir` had a 1.8 ms max spike on a
single wave-dispatch frame but averages 0.06 ms.

### Why this isn't surprising

The architectural rules listed in `PERF.md` (pooled meshes,
`InstancedMesh` for any pool > 4, spatial hash, no-alloc tmp vectors)
keep per-tick work bounded. The previous audit cohorts (iter 33o and
the `perfStart/perfMark` bracket rollout) already caught the obvious
hot spots.

### Watch-list (max spikes worth tracking under hardware GL)

| Function | max in capture | Likely cause of spike |
|---|---:|---|
| `spawnDir` | 1.8 ms | `tickSpawnDirector` first-wave dispatch — clones from pool, instantiates AnimationMixers. Spike scales with wave-burst size. |
| `enemies`  | 0.9 ms | `updateEnemies` end-of-life GC pass (kill ring, dispose, return-to-pool) batches when a wave dies in a frame. |
| `weapons`  | 0.8 ms | `tickWeapons` evolved-tier weapons (chain arc + dissolve burst) bracket through `chainArcs`/`dissolveBursts` *separately*, so max here is mostly weapon AI + projectile dispatch. |
| `forestNeutrals` | 0.3 ms | Lantern-beetle path resampling on segment boundary cross. |
| `dmgNums`  | 0.2 ms | DOM reflow when 20+ damage popups land same frame. |

## Suggested fixes (per offender)

These are seeded from inspection + `PERF.md` watch-list, not from a
fired-regression. Promote whichever the next hardware-GL capture
flags as crossing 2 ms.

1. **`render`** — out of scope; render budget owned by post-FX pipeline
   in `postfx.js`. Re-measure under hardware GL before any action.
2. **`enemies`** — if hardware-GL run shows > 2 ms with 100+ alive:
   - Confirm blob-shadow `InstancedMesh` skips far/offscreen entities
     (per `PERF.md`, currently O(n)). A camera-distance gate at 24 u
     would clip ~half the active set during late-run waves.
   - Verify `updateEnemies` end-of-life batch doesn't iterate the full
     pool when only a handful actually died.
3. **`spawnDir`** — 1.8 ms max spike is from cold-pool inflate. Bump
   `POOL_PREWARM` for the wave kinds that fire first (already tuned
   per `PERF.md` rule 2). Re-verify pool sizes for new cohort 27 / 28
   enemies if they appear in first wave.
4. **`weapons`** — confirm signature-weapon evolution chains
   (chainArcs, dissolveBursts, evolveBursts) early-out when their
   inner active list is empty. Tier-up cinematic spikes should be
   isolated to `evolveCinematic` (separate bracket, currently 0.005 ms
   avg).
5. **`forestNeutrals`** — pre-compute neutral wander waypoints at
   load (currently resampled on segment cross).
6. **`ui`** — `updateUI` already throttles via `_last` cache per
   `PERF.md`. Spot-check for any HUD element that re-runs `getRect()`
   per frame (forces layout).
7. **`dmgNums`** — pool DOM nodes for damage popups (currently
   create-and-destroy per pop). Threshold: only worth doing if max
   sits > 0.5 ms under hardware GL.
8. **`forestDayNight`** — fully GPU-shader-driven would erase this
   tick (currently CPU lerps then assigns to `scene.fog.color` /
   light intensities). Not urgent at 0.02 ms.
9. **`gems`** — InstancedMesh + magnet drift. Check that magnet
   distance check uses spatial hash (cellSize 6) and not brute force.
10. **`trapCorridor`** — segment tick walks all corridor instances
    regardless of hero distance. Add a camera-distance gate.

## Contract ambiguities + decisions

| Ambiguity | Decision | Why |
|---|---|---|
| Brief says "wrap each tick call in main.js: `tickFoo(...)` → `wrappedTickFoo(...)`" — but codebase already has `perfStart()/perfMark()` brackets on every tick (58 sites since iter 33o). | Tap the existing `perfMark` pipeline from `perfHUD.js` rather than re-wrap. Adds one branch + one function call per existing bracket; main.js edits stay at 4 lines. | Re-wrapping 58 sites would blow the "≤40 LOC changes to main.js" budget and create pointless churn. The "wrap" semantic is realized by the existing layer; profiler hooks into it. |
| "Show perf overlay (toggle via key '`' aka backtick or 'P')." Existing perfHUD already binds F3. | Profiler binds backtick + `KeyP`. perfHUD keeps F3. Both overlays coexist (perfHUD bottom-left, profiler top-left). | Two different display modalities (single-window avg vs rolling avg+max with bar chart) — useful in parallel for cross-validation. |
| "Profiler MUST be disabled by default — wrap is a no-op pass-through when `localStorage.getItem('kkPerf') !== '1'`." | Profiler's `profilerRecord` early-returns when gate is off (single branch). `perfStart()` also returns 0 in that path. Existing 58 wraps therefore stay near-zero overhead. | Matches the zero-overhead default contract; verified with `node --check` plus smoke-forest-v2 pass with gate OFF. |
| "tools/_perf_report.md (audit output, gitignored — but commit the template/example)." | File committed (this document) as both template and example, populated with real numbers from a 30 s headless run. Not gitignored — gitignoring would exclude the template. | Avoids the dual-file complication; a future audit overwrites this file in-place. |
| Toggle key 'P' — should it be lowercase too? | Bound to `e.code === 'KeyP'` which fires for both cases. Gated on `_enabled` so we never steal `P` in prod. | Matches "uppercase P" intent without breaking case-sensitive devs. |
| Smoke harness already calls `window.kkPerfForceOn()` (perfHUD's bypass). Does it need to also force the profiler? | No. Smokes run with gate OFF — profiler stays asleep — so behavior is unchanged. The capture script enables the gate via `addInitScript`. | Smokes shouldn't take on profiler cost (still need to pass headless). |

## Smoke results (gate OFF — production path)

| Smoke | Result |
|---|---|
| `tools/smoke-sig-weapons.mjs` | PASS — 13/13 sig kits, REGISTRY bindings clean |
| `tools/smoke-sprite-fx.mjs`   | PASS — 88/88 sprite-fx JSON manifests |
| `tools/smoke-forest-v2.mjs`   | PASS — 4 phases (glade / sealedroom / goldenhour / reaperwarn), 0 console errors, 42.9 s runtime, fps ≈ 4.0 swiftshader |

## Files

* `src/perfProfiler.js` (new) — ring buffer + DOM overlay + key handler.
* `src/perfHUD.js` (edit) — forwards `perfMark` deltas to `profilerRecord`.
* `src/main.js` (edit) — `initPerfProfiler()` once + `renderPerfProfilerOverlay()` per frame.
* `docs/PERF_AUDIT.md` — process docs.
* `tools/_perf_report.md` — this file.
