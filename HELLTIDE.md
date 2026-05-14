# Helltide — Overlay Mega-Event (iter 17)

A Diablo IV-inspired timed overlay event. The world TURNS on the player for
3 minutes: sky shifts hellfire red, spawn rate doubles, multiple concurrent
mini-events fire, and a unique currency (**Hellfire Embers ⚜**) drops from
kills, banks on pickup, and unlocks Tortured Gift chests.

## What it feels like

| Beat | Signal |
|------|--------|
| **0:00** Banner `⚠ HELLTIDE ⚠ — 3:00`, sky lerps red over 1.5s, bell cue | "Something just changed." |
| **0:05** First sub-event (chest / pack / altar / surge) | "Where's that?" |
| **0:25-0:45** Cadence: another sub-event every 25-45s, up to 4 concurrent | "Holy shit there's a lot going on" |
| **3:00** Banner `HELLTIDE ENDED — BANKED N ⚜`, sky lerps back | "I survived." |
| **3:00+** Next helltide queued ~4-6 min out | "It'll come back." |

## Files touched

| File | Purpose | LOC delta |
|------|---------|-----------|
| `src/helltide.js` | **NEW** — orchestration, sub-events, ember pool, rain particles | ~590 |
| `src/miniEvents.js` | Wire init/tick/teardown; suppress new mini-events during helltide | +12 |
| `src/spawnDirector.js` | Multiply `swarmMul` by `state.run.helltideSpawnMul` | +5 |
| `src/env.js` | `applyHelltideOverlay(active, intensity)` — snapshot + lerp lighting | +75 |
| `src/state.js` | 6 new run-state flags, reset on resetState | +14 |
| `src/main.js` | Expose `window.kkTriggerHelltide` + `window.kkEndHelltide` | +10 |
| `src/ui.js` | `showHelltideBar` / `hideHelltideBar`, KK_VERSION → 1.2.0 | +80 |

Hands-off: audio.js, enemies.js, weapons/*, postfx, fx, all stage decor files,
share-card / weekly mutator / meta.

## State model (state.run.\*)

```
helltideActive       : bool   — is the event running right now?
helltideEndAt        : sec    — game-time at which the event ends
helltideNextAt       : sec    — game-time at which the next auto-trigger fires
helltideSpawnMul     : 1|2.5  — read by spawnDirector
helltideEliteBonus   : 0|0.15 — additive elite roll (reserved; not yet read)
helltideEmbersBanked : int    — embers picked up this run
helltideMaxBanked    : int    — best banked count across all helltides this run
```

All seven keys are stamped to defaults in `state.js` `resetState()` so a
retry / new run starts clean.

## Architecture

### Why a separate `helltide.js` (not in `miniEvents.js`)?

It grew past the 200-LOC threshold the brief named: kill-detection,
ember pool, rain particles, sub-event orchestration, and chest interaction
each warrant their own section. Keeping it separate also makes the
`tickMiniEvents` call site trivial: one `tickHelltide(dt)` and a guard
on the existing single-slot scheduler.

### Sub-event types

```
chest    — Tortured Gift Chest (cost 50 ⚜)
threat   — Threat Pack (4-6 elites with magenta tell ring, faster seek AI)
altar    — Hellfire Altar (8u radius, 30s, doubles ember drops in range)
surge    — Mini-Boss Surge (single elite at 1.5× HP, drops 30 ⚜ on death)
```

Weighted pick: 35% chest, 30% threat, 20% altar, 15% surge.
Max 4 concurrent; next fires every 25-45s. Expected total over 3 min: 6-8.

### Kill-detection (track-and-diff)

`src/enemies.js` is hands-off this iter, so the ember-on-kill drop can't be
wired through `killEnemy`. **AND** `killEnemy` splices the dead enemy out of
`state.enemies.active` in the same tick it kills them — so the naive
"poll for alive=false in active[]" never observes anything. The real
mechanic is a two-pass diff against a parallel snapshot map:

```
_tracked = Map<enemy ref, { count, x, z }>
_activeScratch = Set<enemy ref>   (reused per tick)

per tick:
  1. clear _activeScratch.
  2. for each e in state.enemies.active:
       - add to _activeScratch.
       - if not in _tracked:
           pre-roll embers (base 0.20 + elite 0.05 + boss 0.30; boss >= 1)
           insert with current mesh position.
       - else: refresh x/z from current mesh position.
  3. for each [e, snap] in _tracked:
       if NOT in _activeScratch:
         e was removed from active[] this tick (= dead, or escape).
         spawn snap.count embers at (snap.x, snap.z), times 2× if within
         ALTAR_RADIUS of any active altar.
         remove from _tracked.
```

Step (2) refresh is what makes the death position correct — without it
we'd drop embers at the spawn point.

False-positive note: an escaped enemy (e.g. treasure goblin that flees
off-screen) also vanishes from active[], so we'll drop embers for them
too. This is acceptable — escapes are rare in the high-density helltide
window, and the player banking a few "free" embers from a non-kill is
strictly an upside.

We use a regular `Map` (not `WeakMap`) so we can iterate; `teardownHelltide`
clears it explicitly so memory stays bounded.

### Hellfire ember pool

- Single `InstancedMesh` (256-cap) of additive red plane sprites.
- Per-ember: bob + rotation + hero-proximity scan (radius 1.8).
- Pickup auto-banks to `state.run.helltideEmbersBanked` (no XP gem magnet
  pipeline — these are run-currency, not XP).
- Lost-on-event-end: unclaimed embers get hidden + dropped. UX-wise this
  reads as "the embers fade with the helltide", not as a punishment.

### Hellfire rain (visual)

- Second `InstancedMesh` (80-cap) of small additive sprites.
- Spawn rate: 12/sec during the event, around the hero at radius 6-28.
- Curl noise + downward drift; fade out near ground.
- Hidden when no helltide active (matrix scale = 0).

### Env overlay

`applyHelltideOverlay(true)` snapshots the CURRENT (live, stage-tinted)
sun/hemi/fill/fog values, then lerps toward a hellfire target over 1.5s
via `_stepHelltideTween` called from `tickAtmosphere`. The snapshot is
taken at activation time (not boot) so the overlay restores to whatever
stage tint was in effect, not the forest baseline.

Atmospheric particles (pollen / wisps / embers / sparkles) are NOT
touched — they keep running under the overlay tint.

## Tunables (helltide.js top)

```js
HELLTIDE_DURATION       = 180   // 3 min
HELLTIDE_INTERVAL_MIN   = 240   // 4 min cooldown
HELLTIDE_INTERVAL_MAX   = 360   // 6 min cooldown
HELLTIDE_FIRST_AT_MIN   = 240   // earliest first trigger
HELLTIDE_FIRST_AT_MAX   = 360   // latest first trigger
SPAWN_MUL_DURING        = 2.5
EMBER_DROP_BASE         = 0.20
EMBER_DROP_ELITE_BONUS  = 0.05
EMBER_DROP_BOSS_BONUS   = 0.30
ALTAR_RADIUS            = 8
ALTAR_DURATION          = 30
CHEST_COST              = 50
SURGE_EMBER_DROP        = 30
EMBER_RAIN_CAP          = 80
EMBER_CAP               = 256
SUBEVENT_INTERVAL_MIN   = 25
SUBEVENT_INTERVAL_MAX   = 45
SUBEVENT_MAX_CONCURRENT = 4
```

## Performance projection

| System | Cost | Notes |
|--------|------|-------|
| Spawn director 2.5× | hits `SPAWN.targetAliveCap = 220` | At D=7 baseline target ~151; multiplier caps at 220. Existing pool ceiling handles. |
| Sub-events (4 max × ~5 entities) | ~20 extra enemies | Pooled via spawnEnemy. |
| Ember pool | 1 InstancedMesh (256 cap) | Additive plane sprites, single draw call. |
| Rain particles | 1 InstancedMesh (80 cap) | Additive plane sprites, single draw call. |
| Kill-detection | O(active) per tick | Already O(active) in updateEnemies — same shape, two WeakMap ops per enemy. |
| Env overlay lerp | 4 lights + fog | One frame's worth of color math during the 1.5s tween. |
| UI bar | 1 DOM element | Created on first show, removed on hide. |

Total extra draw calls during helltide: 2 (ember pool + rain). Triangle
count: ~672 (256+80 quads). Well under the 80k tri / 200 draw call budget.

## Debug hooks

```
window.kkTriggerHelltide()  → force-trigger the next event
window.kkEndHelltide()      → end the current event early
```

## Punted (for next iter)

- **Hellfire Brazier town interactable** — design said "optional"; deferred
  to keep scope tight. The auto-trigger + debug hook cover the design
  intent for now.
- **Hall of Records modal entry** — lifetime totals are persisted on the
  run object (`helltideEmbersBanked`, `helltideMaxBanked`) but not yet
  surfaced in the Hall of Records modal. The data is there for a
  follow-up commit.
- **Run-result stat row** — the `helltideEmbersBanked` value is in state
  and shows on the helltide-end banner, but doesn't render in the
  end-of-run summary card yet (touching share-card is out of scope).
- **Tortured Gift chest reward depth** — current opens drop 1-2 XP gems
  (value 5) + a 25% heart chance. Could grow to include weapons-cache /
  filler-pick choices, but that pulls in the slot-machine pipeline.
- **Custom audio cue** — currently reuses `sfx.bossWarn`. SFX agent will
  swap in a real bell + low rumble in their lane.

## How to test

```
1. Boot the game, enter a run.
2. F12 → DevTools console:
   await window.kkTriggerHelltide()    // returns true
3. Sky should shift red over ~1.5s. Banner: "⚠ HELLTIDE ⚠ — 3:00".
   Spawn rate visibly higher. Top-of-screen countdown bar appears.
4. Kill some enemies — red embers should drop and bank to the counter.
5. Wait for a Tortured Gift chest to spawn — walk into it with 50+ embers
   to open. (Insufficient = silent no-op; cost reads via the running bar.)
6. Wait 3 minutes (or call window.kkEndHelltide()) — sky lerps back,
   "HELLTIDE ENDED" banner, bar disappears.
7. Die / retry — state should fully reset (banked = 0, no schedule leak).
```
