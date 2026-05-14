# Iter 10-11 Briefs + Ship Reassessment

> Generated 2026-05-14 by research/planning agent while iter 9 is in flight.
> No source files touched. Parent session uses this to spawn iter 10 (3 agents)
> and iter 11 (1-2 agents, isolated worktree spike).
>
> Conventions:
> - File paths absolute under `/mnt/c/Users/rneeb/Documents/kitty-kaki-survivors`.
> - `runState` = `state.run`. `meta` = `getMeta()`.
> - "Hook fires from" = call site exists; just add a read of the new field.
> - "New hook" = new call site, named precisely.
> - Agent boundaries are NON-OVERLAPPING file surfaces.

---

## Iter 10: Polish Lock

### Audit findings (per category)

#### 1. Audio mix — STRUCTURAL UNDERSPEC (severity HIGH)

`src/audio.js` already separates `_master` (music + legacy SFX) from `_sfxBus`
(combat SFX submaster). The UI exposes ONE `optVolume` slider that maps to
`_master` only — `_sfxBus` has no surface, so combat SFX can't be balanced
against music. `setMusicTier` is wired (`main.js:205` calls it once at run
start with tier 0) but never escalates as D(t) grows — `audio.js` defines
calm/combat/boss but nothing notifies it. Music plays only during runs (no
menu/town/interior bed). All ~17 SFX call sites silently swallow errors via
`try/catch (_)` so a regression here is invisible.

Concrete gaps:
- Volume control: 1 slider → needs Music / SFX / Master split.
- Music tier never advances past 0. `spawnDirector` knows when mini-boss /
  final boss is up — that's the right notify site.
- No ambient bed in `menu` / `town` / `interior` modes. Even a low-volume
  procedural drone would lift the menu from "loading screen" to "game".
- `audio.js` returns silently if `_ctx.state !== 'running'`. After tab-blur,
  Chrome can suspend without re-resume — no `visibilitychange` listener
  reaches back into `unlockAudio()`.

Recommendation: shipped in agent **10a**.

#### 2. Settings menu — INCOMPLETE (severity HIGH)

`src/ui.js:2786 showOptions()` exposes only:
Volume (single), Shake, Music toggle, VFX intensity, Manual Aim,
+ unlock-gated Hyper/Endless/Boss Rush toggles.

Missing for a 1.0 contract:
- **Music / SFX separate sliders** (see audio gap).
- **Reduce Motion** toggle (skip screen shake AND damage-flash AND camera
  bob entirely — not just dampen shake). Currently `state._optShakeMul`
  exists but cuts shake only; flashes + zoom punches + vfxBurst still run.
- **Colorblind palette** — at minimum a "high-saturation" preset that
  shifts the cyan/magenta/amber palette to deuteranopia-safe blue/orange.
  STYLE_BIBLE.md locks 8 colors; we need 1 alternate ramp.
- **High Contrast** toggle — boosts HUD/text against backdrop. Currently
  white-on-dark is the only mode.
- **Font Size Scale** (0.85× / 1.0× / 1.15× / 1.3×). UI uses `font-size`
  inline literals everywhere — implement via root CSS var
  `--kk-font-scale` consumed by a small set of class buckets.
- **Reduced Flashing** — strobing on chest open + slot machine + boss
  spawn would fail WCAG 2.3.1 if measured. Implement as a flag that
  caps flashes/sec.
- **Framerate cap** (30 / 60 / unlocked). Some integrated GPUs throttle
  better with a deliberate cap.
- **Save Export / Import** — JSON dump from localStorage to file +
  paste-from-clipboard with `version:` check. Required for accessibility
  AND backup (lost saves = lost player).
- **Reset progress** — destructive button with confirm. Currently impossible
  without DevTools.
- **Controller deadzone slider** — `gamepad.js` already has a deadzone
  constant; surface it. Otherwise twitchy sticks make 3rd-party pads unplayable.
- **Language picker (stub)** — empty dropdown wired to `meta.optLanguage =
  'en'` for i18n forward-compat. Translations defer to post-1.0.

Recommendation: shipped in agent **10a**.

#### 3. Accessibility — ZERO COVERAGE (severity HIGH)

Grep for `aria-`, `role=`, `reduceMotion`, `colorblind`, `highContrast`,
`fontSize`, `screenReader` returns no relevant hits anywhere in `src/`.
The mandate says VS/Hades parity — Hades 2 ships with reduce-motion,
colorblind, font-size, audio captioning, and full input remap.

Beyond the settings (see #2), the live HUD must also:
- Add `aria-live="polite"` to the toast region for screen-reader-friendly
  announcement of level-ups / unlocks / chest contents.
- Add `aria-label` on focusable buttons (start screen, options modal,
  level-up cards). `uiFocus.js` already tracks focus scope — annotations
  are cheap to add at scope-push time.
- Honor `prefers-reduced-motion` media query at boot as a default for
  `optReduceMotion` (don't override an explicit user choice).

Recommendation: shipped in agent **10a**.

#### 4. Intro / outro / credits — MINIMAL (severity MEDIUM)

`main.js boot()` calls `showStartScreen('Loading…')` then
`showStartScreen('Click or press SPACE to start')` — that's it. No splash,
no studio bumper, no version, no credits screen, no first-time-player
welcome (the tutorial fires only when the run starts).

- No in-game credits modal. README has credits at lines 38-48; need a
  Credits button on start screen + options. Should list Quaternius,
  Poly by Google, Poly Haven, and Three.js.
- No version label. `meta.version = 1` is invisible.
- No "Made by" attribution on start screen. README mentions
  @slopfactory9000 — surface it.
- No game-over outro variation between victory and death — they share the
  death screen layout. A 2-3 second victory cinematic (camera pull-out,
  amber bloom flash, banner) before the score screen would land it.
- The town hub IS the "first-time-player flow that's not the tutorial" —
  this exists, but the start screen doesn't tell the player it does. A
  "VISIT VILLAGE" button alongside START RUN would help.

Recommendation: shipped in agent **10c**.

#### 5. Error states — UNHARDENED (severity MEDIUM-HIGH)

`src/meta.js loadMeta()` (lines 882-896) catches JSON.parse errors and
silently falls back to DEFAULT — player loses progress with zero
notification. Same for `saveMeta()`. The user will quit thinking the game
ate their save.

`src/assets.js _preload()` (lines 25-41) resolves `false` on GLTF failure
and the spawning code does `if (!gltf) return null;` — silent. A missing
GLB means a tier silently doesn't spawn; the player thinks "no zombies?"
without ever seeing an error.

No WebGL context-loss / restore handler anywhere. On loss (driver crash,
tab background-throttle, GPU reset) all InstancedMesh contents go to
zero — gem pool, blob shadow, ranged tells, threat dots, pickup halos,
sparkle layer, kill rings, all dead. Recovery would need re-init.

No window error handler / unhandled-rejection handler routed to a user
toast. Console errors are invisible to most players.

Recommendation: shipped in agents **10b** (asset/save) and **10c**
(WebGL context-loss because it intertwines with rebuild-on-loss for the
12-ish InstancedMesh systems).

#### 6. Perf budgets vs reality (severity MEDIUM)

PERF.md targets 60 fps with ≤220 enemies. BALANCE.md flags a play-test
review for `targetAlivePerD = 18` because the new `difficultyMaxSec = 1200`
ramp can hit 162 alive by t=15:00, and the iter-9 weekly DOUBLE_SPAWNS
mutator (per ITER_789_BRIEFS.md) doubles target alive cap → **up to 324
alive**. The 220 cap clamps the live count, but the spawn-spawn-spawn
churn can spike GC.

Known soft spots not yet measured:
- Blob shadow `InstancedMesh` walks all active enemies every frame (O(220),
  fine today, ouch at 324 with DOUBLE_SPAWNS).
- `bossTelegraphs.js` allocates new RingGeometry per wind-up (PERF.md
  flags). With iter-8 per-boss patterns adding cone + cross tells, the
  per-wave allocation count goes up — needs pooling.
- DOM achievement / secret toast nodes — fine in normal play; weekly
  + iter-9 achievement chain may fire many toasts at once on a milestone
  run.

The F3 perfHUD is good infrastructure but only shows live numbers — no
recorded soak. Need an in-game "soak benchmark" mode that runs a
60-second deterministic horde at fixed seed and writes percentile
frame-times to console.

Recommendation: shipped in agent **10b** (soak benchmark + pool
RingGeometry in bossTelegraphs).

#### 7. Deferred FX residue — KNOWN (severity MEDIUM)

FX_AUDIT.md "OUT OF SCOPE" section names 12 placeholder rings still
present:
- `src/town.js:144` selection ring under character statue
- `src/town.js:257` plaza border ring
- `src/interior.js:147` house furnace ring
- `src/catacomb.js:183, 214` catacomb glyph rings

Grep confirmed 12 `RingGeometry`/`MeshBasicMaterial` instances across
those three files. Anti-pattern per HANDOFF.md. Standard upgrade:
`PlaneGeometry` + `makeRuneRingTexture()` import from `src/enemyTells.js`.

Recommendation: shipped in agent **10b**.

#### 8. Iter-8 deferred punt — leap arc tell (severity MEDIUM)

`src/enemies.js:920+` runs the leap windup → translate. `enemyAffixes.js`
sets `_leapWindup = 0.6` and captures `_leapTargetX/Z`. But
`src/enemyTells.js` exposes only `_rangedTells` and `_threatDots`
InstancedMesh slots — **no `_leapMarker` slot**, so the player gets zero
visual indication where the leap is going to land. The 0.6s windup is
"dash-cancellable" per design, but undash-cancellable in practice because
the player can't see it.

ITER_789_BRIEFS.md iter-8 flagged this as "magenta arc indicator at
landing site (NEW: reuse `_rangedTells` mesh with new `_leapMarker` slot)"
— never shipped.

Recommendation: shipped in agent **10b**.

#### 9. Tier-4 SHOP_TREE capstones — UNWIRED (severity HIGH for build identity)

Three `// TODO(iter6-wire):` comments left as land mines:
- `src/meta.js:729` `survival-4-phoenix` — passive_revives += 2 but no
  cap-at-6-with-vault stacking logic. Players who hit 6+ revives can
  cheese the game.
- `src/meta.js:759` `power-4-overdrive` — flag set, no 60s timer in main
  loop. Buying this node does NOTHING.
- `src/meta.js:790` `greed-4-treasure-map` — flag set, no chest spawned
  at run start. Buying this node does NOTHING.
- `src/state.js:265-266` declares the flags but warns no readers exist.

This is a build-variety regression — players buy a tree node and observe
zero gameplay change. Single biggest "broken promise" in the codebase.

Recommendation: shipped in agent **10b**.

#### 10. Cross-iter polish surfaces (severity LOW-MEDIUM)

- Shop tree visual richness: nodes are described in `ui.js:2261+`. Current
  rendering is text-based cards. A literal tree-visual with branch lines
  connecting tiers would communicate the prereq graph at a glance.
  Vampire Survivors' powerups grid is also text-card, so this is a polish
  call, not a blocker.
- Character signature preview clarity: iter-7c added a "Signature" tooltip
  row (`ui.js:1283`), but it appears only on hover. On the card itself a
  one-line italic preview (signatureName in cyan) would communicate
  identity without a hover gesture. Brief in 10c.
- Codex Legend overlay scannability: shipped in iter 8c — the affix
  legend exists. Verify it's reachable from F1 hotkey (currently only from
  inside Codex modal). Quick win in 10c.

#### 11. Ship-readiness rituals (severity MEDIUM)

- **README.md**: lists controls + features but no screenshots, no GIF.
  itch.io and GitHub Pages homepages benefit from a 800×400 banner + a
  2-second loop GIF. The user collaborates via Pages, so we just need
  an `assets/screenshot.png` + `assets/demo.gif` and a README link.
- **LICENSE**: missing at repo root. README line 84 says "Code under MIT
  (or your choice)" — that's not shippable. Add `LICENSE` file (MIT) and
  fix the README pointer to it.
- **Version number**: `meta.version = 1` is internal-only. Display
  "v1.0.0" on start screen + Options modal. Bump to "v1.0.0-rc" for this
  iter; flip to "v1.0.0" on iter-10 commit.
- **"How to Play" page link**: index.html has a single canvas. A static
  `how-to-play.html` covering controls + weapon evolutions + the loop is
  one of the cheapest possible ship moves. Link from start screen +
  README.
- **og:image / og:description meta tags** in `index.html`: zero today. A
  Discord paste of the URL shows a blank embed. The iter-9 share-card is
  1200×630 — same dimensions as the og:image standard. Reuse one of the
  generated cards as a static og:image asset.

Recommendation: shipped in agent **10c**.

### Proposed 3-agent split

> Heaviest concerns first. 10a takes the highest file-surface change
> (settings overhaul + audio split + accessibility) because it touches
> meta + audio + ui + several FX readers — it MUST run first or alone.
> 10b is mechanically dense but file-isolated (FX residue + tier-4
> capstones + leap marker + perf soak). 10c is breadth-y ship rituals.

#### 10a — Audio mix split + Settings overhaul + Accessibility

**Owns:** `src/audio.js`, `src/meta.js` (DEFAULT + setOption), `src/ui.js`
showOptions (lines 2786-2953), `src/main.js` (boot-time apply +
visibilitychange listener + music-tier dispatcher), `src/state.js`
(per-frame reduce-motion read), `src/vfxBurst.js` + `src/postfx.js`
(reduce-motion + reduced-flashing readers).

**Do NOT touch:** `src/town.js`, `src/interior.js`, `src/catacomb.js`,
`src/enemyTells.js`, `src/chest.js`, `src/hero.js takeDamage`. Those are
10b's territory.

**Contract:**

- Split `_master` into `_musicBus` + `_sfxBus` (already exists). Add
  `_masterBus` that both feed into. Export `setMusicVolume`, `setSfxVolume`,
  `setMasterVolume`. Keep `setVolume(v)` as a deprecated shim that sets
  master (back-compat).
- Add `setMusicTier`-driving notify: `notifyCombatPressure(activeBosses,
  D)` exported. `spawnDirector` calls it on mini-boss spawn + final boss
  spawn + boss kill (already has those events).
- Add `playMenuBed()` / `stopMenuBed()` — a low-volume ambient drone that
  plays in `menu` / `town` / `interior` modes. Reuse `playNote` infra.
- Add `visibilitychange` listener at boot: on `hidden`, suspend ctx; on
  `visible`, resume + retrigger menuBed if applicable.
- `meta.js DEFAULT` add:
  - `optMusicVolume: 0.5`
  - `optSfxVolume: 0.7`
  - `optMasterVolume: 1.0`
  - `optReduceMotion: false` (default false, but boot-time check of
    `window.matchMedia('(prefers-reduced-motion: reduce)').matches` flips
    it true if the user hasn't set anything yet — use a separate
    `optReduceMotionUserSet` flag to detect the user's choice).
  - `optColorblind: 'off'` (values: `'off' | 'deuteranopia' | 'protanopia'
    | 'tritanopia'`)
  - `optHighContrast: false`
  - `optFontScale: 1.0` (range 0.85..1.30)
  - `optReducedFlashing: false`
  - `optFrameCap: 0` (0 = unlocked; 30, 60, 144 are valid)
  - `optControllerDeadzone: 0.15`
  - `optLanguage: 'en'` (stub for i18n)
  - **Migration:** in `loadMeta`, if legacy `optVolume` is present AND
    new keys are absent, set `optMasterVolume = optVolume; optMusicVolume
    = optVolume * 0.6; optSfxVolume = optVolume`. Preserve back-compat.
- `ui.js showOptions` rebuild as scrollable list. Group into sections:
  Audio (Master / Music / SFX), Display (FX intensity, Shake, Reduce
  Motion, Reduced Flashing, High Contrast, Colorblind palette, Font
  Scale, Frame Cap), Controls (Manual Aim, Controller Deadzone),
  Accessibility (Language stub), Modes (Hyper/Endless/Boss Rush gated as
  today), Data (Save Export / Save Import / Reset Progress).
- Save Export: `meta.js exportMeta() → string` returns
  `JSON.stringify(meta, null, 2)`. UI button triggers
  `navigator.clipboard.writeText(exportMeta())` AND offers a download
  link (`Blob` + `URL.createObjectURL`).
- Save Import: `meta.js importMeta(str)` parses, validates `version`,
  merges over DEFAULT, calls saveMeta. UI button prompts via
  `<textarea>` paste OR `<input type="file">`.
- Reset Progress: confirm modal ("Type RESET to confirm") then call
  `resetMeta()`.
- `state.js` add `state._optReduceMotion = false` cache. Read in
  hero.takeDamage flash, postfx exposure pulse, vfxBurst shake.
- `vfxBurst.js` + `postfx.js`: respect `state._optReduceMotion` (skip
  zoom-pulse and chromatic aberration) and `state._optReducedFlashing`
  (cap pulse alpha to 0.4 + min 250ms between flashes).
- `gamepad.js`: read deadzone from `meta.optControllerDeadzone` instead of
  hard-coded const. Wired but configurable.
- HUD / UI accessibility:
  - Toast container (`ui.js` — find via grep for `_toastWrap` /
    similar): add `aria-live="polite"` attribute.
  - Focusable buttons: add `aria-label` at scope-push time in `uiFocus.js`
    or per-modal in `ui.js`.
- `index.html`: add `<meta name="color-scheme" content="dark">` and a
  `<style>:root { --kk-font-scale: 1; }</style>`. ui.js modal text reads
  `calc(var(--kk-font-scale) * 13px)` for body, etc. Implement via 4-5
  font-size buckets, not per-element rewrites.

**Tuning constants:**
- prefers-reduced-motion default: false unless OS says reduce.
- Master / Music / SFX defaults: 1.0 / 0.5 / 0.7. Music below SFX because
  combat readability > music vibe in a horde game.
- Font scale range: 0.85..1.30 (anything outside breaks layout).
- Reduced-flashing cap: max 4 flashes/sec, alpha 0.4.

**Verification:**
- Boot game, ESC, confirm all new sliders present.
- Lower Music to 0, confirm music silent but SFX audible.
- Toggle Reduce Motion, take a hero hit, confirm no flash + no shake.
- Toggle Colorblind=Deuteranopia, confirm cyan/magenta palette shifts
  to blue/orange in HUD borders + ring tints.
- `node --check src/audio.js src/meta.js src/ui.js src/main.js
  src/state.js src/vfxBurst.js src/postfx.js`.

#### 10b — FX residue cleanup + Tier-4 capstones + Leap marker + Perf soak

**Owns:** `src/town.js`, `src/interior.js`, `src/catacomb.js`,
`src/enemyTells.js`, `src/enemies.js` (leap windup ONLY — add
`setLeapMarker` calls), `src/state.js` (passive readers — add overdrive
timer init only, not the audio/motion bits which 10a owns),
`src/main.js` (run-loop overdrive tick + treasure-map starter chest),
`src/hero.js` (takeDamage revive cap), `src/chest.js` (treasure-map
starter chest spawn helper), `src/bossTelegraphs.js` (pool RingGeometry),
new `src/perfSoak.js` (deterministic 60-second benchmark mode).

**Do NOT touch:** `src/audio.js`, `src/ui.js showOptions`, `src/meta.js`
DEFAULT (10a owns those). `src/enemyAffixes.js` (already done in iter
8). Other agents' files.

**Contract:**

- **FX residue (12 rings):**
  - `town.js:144` selection ring under statue: swap RingGeometry +
    MeshBasicMaterial → PlaneGeometry + `makeRuneRingTexture()`. Color
    cycle gold-on-selected.
  - `town.js:257` plaza border ring: keep MeshStandardMaterial (it's
    decor, not magic), but swap RingGeometry → a textured PlaneGeometry
    with a subtle stone-veining canvas tex from `particleTextures.js`.
    Lower priority — this one is "decor not foreground", per FX_AUDIT.
    KEEP-ish acceptable here.
  - `interior.js:147` furnace ring: swap to PlaneGeometry + rune tex,
    warm-orange tint, slow spin.
  - `catacomb.js:183, 214` glyph rings: swap to PlaneGeometry + rune tex,
    purple tint, slow spin. These set the catacomb mood — bump
    BLOOM_LAYER.
  - Verify no NEW `RingGeometry` + `MeshBasicMaterial` introduced.
- **Leap marker tell:**
  - In `enemyTells.js`: add `_leapMarkers` InstancedMesh (cap 16). Use
    `makeRuneRingTexture()` PlaneGeometry, magenta tint, additive
    blending, BLOOM_LAYER. Init in `initEnemyTells`.
  - Export `setLeapMarker(x, z, windupRemaining, totalWindup)` — paints
    a slot at the leap target with `instanceColor = magenta`, scaled
    proportionally (small → big as windup approaches). Pulse via per-slot
    scale = `1.0 + 0.3 * Math.sin(t * 12)`.
  - Export `clearLeapMarker(enemyId)` — zero out the slot on resolve.
  - In `enemies.js:920+` leap update branch:
    - On windup start (currently sets `_leapWindup = 0.6`), call
      `setLeapMarker(e._leapTargetX, e._leapTargetZ, 0.6, 0.6)`.
    - Each tick, call `setLeapMarker(x, z, remaining, 0.6)` so the
      marker grows.
    - On resolve, call `clearLeapMarker`.
  - `resetEnemyTells` already exists — extend to clear leap markers too.
- **Tier-4 capstones (the three TODO(iter6-wire) bombs):**
  - `survival-4-phoenix` cap-at-6 logic: in `hero.js takeDamage`, when
    consuming a revive, check `state.run.passive_revives <= 6`
    (`meta.house.vault` adds +1 per level on top). Already-banked
    revives beyond 6 are silently discarded at apply-time, not
    revive-time. Apply that clamp in `main.js applyMetaUpgrades` after
    SHOP_TREE effects: `state.run.passive_revives = Math.min(6,
    state.run.passive_revives || 0)`.
  - `power-4-overdrive` 60s frenzy timer:
    - `state.js`: add `state.run.overdriveActive = false`,
      `state.run.overdriveTimer = 0`.
    - `main.js` run-loop tick branch: if `state.run.passive_overdrive`,
      increment `state.run.overdriveTimer += dt`. Every 60s, set
      `overdriveActive = true; overdriveTimer = 0`. After 5s of active,
      flip back to false.
    - During active: stack +50% attack speed (multiply
      `state.run.passive_cooldown` transient by 0.667) and +25% damage
      (multiply `state.run.passive_dmg` transient by 1.25).
    - Visual: amber screen tint via postfx exposure bump
      (`state.postFXPass.uniforms.uOverdriveTint = 1`) for the 5s.
      Pulse SFX `sfx.levelUp` once at activation.
  - `greed-4-treasure-map` starter chest:
    - In `_primeRunStart` (main.js), if `state.run.passive_treasureMap`,
      call `chest.spawnAt(state.hero.pos.x + 5, state.hero.pos.z + 5)`
      before the spawn director starts the wave.
    - In `chest.js`: add `spawnAt(x, z)` export if not present
      (refactor existing common chest spawn into a helper).
- **bossTelegraphs.js RingGeometry pool:**
  - PERF.md flag — currently allocates per windup. Add a 4-slot pool of
    pre-allocated PlaneGeometry + textured material, recycled on resolve.
    Visible mesh count cap = 4 (one per simultaneous boss; final boss
    fires multiple but they share the pool).
- **Save-corruption + asset-failure surface (10b owns the wiring, not
  the toast UI — 10c owns the toast):**
  - `meta.js loadMeta`: on parse failure, emit a
    `window.dispatchEvent(new CustomEvent('kk-meta-load-failed'))`. UI
    side listens (10c). DON'T silently fall back.
  - `assets.js _preload`: on failure, push to
    `window._kkAssetFailures = []` and dispatch
    `'kk-asset-load-failed'`. UI side listens (10c).
- **Perf soak benchmark:**
  - New file `src/perfSoak.js`. Exports `runPerfSoak({seconds, seed,
    spawnMul})` returning `{p50, p90, p99, fpsAvg, maxAlive,
    drawCallsP99}`. Uses `state.time.game = 0` reset, fixed enemy
    spawn seed, runs the spawn loop in a tight 60-second window with
    F3 metrics captured.
  - Console-only output (no UI). `window.kkSoak()` triggers it. Outputs
    to clipboard via `navigator.clipboard.writeText(JSON.stringify(...))`.
  - Validates the BALANCE.md flagged 162-alive perf concern AND the
    iter-9 weekly DOUBLE_SPAWNS 324-alive stress test.

**Tuning constants:**
- Leap marker scale: 0.6 (start) → 1.4 (resolve), pulse +0.2.
- Leap marker color: magenta 0xff66cc.
- Overdrive cycle: 60s wait, 5s active, +50% atk speed, +25% dmg.
- Phoenix revive cap: 6 (4 base + 2 vault levels).
- Treasure Map starter chest position: hero.pos + (5, 0, 5) offset
  (in front-right, visible at spawn).
- Perf soak duration: 60s. Spawn mul values to test: 1.0, 1.5 (BALANCE
  case), 2.0 (weekly DOUBLE_SPAWNS).

**Verification:**
- Boot, pick Twilight, run; observe magenta marker on Leaping affix
  windup. Dash out of marker bounds, confirm no damage.
- Buy survival-4-phoenix (use console to set sigils), confirm cap at 6.
- Buy power-4-overdrive, run for 65s, confirm 5s frenzy at t=60.
- Buy greed-4-treasure-map, start run, confirm chest at spawn.
- `node --check src/town.js src/interior.js src/catacomb.js
  src/enemyTells.js src/enemies.js src/hero.js src/main.js
  src/chest.js src/bossTelegraphs.js src/perfSoak.js src/state.js`.
- Run `window.kkSoak({seconds: 60, seed: 'iter10soak', spawnMul:
  1.5})`, expect p99 frame ≤ 22ms; if ≥ 25ms, flag for iter 12.

#### 10c — Ship rituals (credits + version + license + error UI + meta tags)

**Owns:** `src/ui.js` (start screen credits + version + how-to-play
button + error-toast handlers; this is the start-screen + error-surface
portion, NOT the showOptions portion — 10a owns that), `README.md`,
new `LICENSE` file at repo root, `index.html` (og: meta tags + font
scale CSS var), new `how-to-play.html` at repo root, new
`assets/screenshot.png` + `assets/demo.gif` (placeholder OK if user
hasn't captured yet; commit as 1×1 png + 1×1 gif if needed).

**Do NOT touch:** showOptions (10a), tier-4 logic (10b), FX rings
(10b), audio (10a).

**Contract:**

- **Credits modal**: `ui.js showCredits()` — new modal mirroring
  `showOptions` structure. Lists: Game by @slopfactory9000, Models
  (Quaternius CC0 + Poly by Google CC-BY), Textures (Poly Haven CC0),
  Three.js + addons, Three.js logo. Push focus scope so Esc closes
  cleanly via `uiFocus.js`.
- **Version label**: hardcoded `KK_VERSION = '1.0.0-rc1'` in ui.js.
  Render bottom-right of start screen + as a row in showOptions header.
- **Start screen polish**: add Credits + How To Play buttons in the
  ghost-button row. Keep START RUN + VISIT VILLAGE as primary CTAs.
- **Error toasts**: register listeners for:
  - `'kk-meta-load-failed'` → red persistent toast: "Save data couldn't
    be loaded. Your progress is reset to defaults. Check console for
    details." with a "Dismiss" button. Sticky until clicked.
  - `'kk-asset-load-failed'` → amber toast: "Some art assets failed to
    load. The game will still run but may show placeholders." Auto-
    dismiss 6s.
  - `window.addEventListener('webglcontextlost', ...)` → red modal:
    "Graphics device disconnected. Reconnecting…" Pause game. On
    `webglcontextrestored`, attempt re-init via a new
    `main.js rebuildAfterContextLoss()` helper. **Important:** call
    `prewarmPools()` + rebuild InstancedMesh contents (gems pool,
    blob shadows, ranged tells, threat dots, pickup halos, kill rings,
    leap markers). If too risky in iter 10, ship the modal + reload
    page button as a fallback.
  - `window.addEventListener('error', ...)` and `'unhandledrejection'`
    → console.error mirror + small red corner toast (auto-dismiss 4s)
    with "An error occurred. Press F3 for diagnostics."
- **LICENSE file** at repo root: standard MIT, current year, Daniel /
  slopfactory9000 attribution.
- **README polish**:
  - Add screenshot at top (or placeholder note "screenshot pending").
  - Add demo GIF mention (or placeholder).
  - Fix license pointer: "Code under MIT — see LICENSE."
  - Add "How to Play" link to `how-to-play.html`.
  - Add itch.io / GitHub Pages live URL prominently.
  - Bump version: "v1.0.0".
- **how-to-play.html** at repo root: static HTML, no JS dependencies.
  Sections: Controls, Loop (run → die → upgrade → run), Weapons +
  Evolutions, Characters + Signatures, Stages + Mutators, Tips. Style
  inline using the same palette as the game. Links back to the game.
- **index.html og: tags**:
  - `<meta property="og:title" content="Kitty Kaki Survivors">`
  - `<meta property="og:description" content="...">`
  - `<meta property="og:image" content="assets/og-card.png">`
  - `<meta property="og:url" content="https://dknos.github.io/...">`
  - `<meta name="twitter:card" content="summary_large_image">`
  - Add the `:root { --kk-font-scale: 1; }` CSS var that 10a's font-scale
    setting will mutate.
- **Codex F1 hotkey**: in `main.js` keydown listener, add F1 → open
  Codex. Already exists in some modes; surface it on start screen too.

**Tuning constants:**
- KK_VERSION = '1.0.0-rc1' (flip to '1.0.0' on iter-10 commit).
- Asset-failure toast duration: 6s.
- WebGL context-loss modal: persistent until restore or reload.
- og:image: 1200×630 (matches iter-9 share card).

**Verification:**
- Boot, see version in corner.
- Click Credits, see modal listing all attributions, Esc closes.
- Click How To Play, navigate to static page, click "Back" returns.
- Open DevTools console: `window.dispatchEvent(new
  CustomEvent('kk-meta-load-failed'))` → red toast appears.
- `node --check src/ui.js src/main.js`.
- Visit live URL after push — confirm og:image renders in Discord
  preview.

### Locked contracts (functions / state slots / file paths)

| Symbol | Owner agent | File |
|---|---|---|
| `setMusicVolume(v)`, `setSfxVolume(v)`, `setMasterVolume(v)` | 10a | `src/audio.js` |
| `playMenuBed()`, `stopMenuBed()` | 10a | `src/audio.js` |
| `notifyCombatPressure(activeBosses, D)` | 10a | `src/audio.js` |
| `exportMeta() → string`, `importMeta(str) → {ok, reason?}` | 10a | `src/meta.js` |
| `meta.optMusicVolume`, `meta.optSfxVolume`, `meta.optMasterVolume`, `meta.optReduceMotion`, `meta.optReduceMotionUserSet`, `meta.optColorblind`, `meta.optHighContrast`, `meta.optFontScale`, `meta.optReducedFlashing`, `meta.optFrameCap`, `meta.optControllerDeadzone`, `meta.optLanguage` | 10a | `src/meta.js` DEFAULT |
| `state._optReduceMotion`, `state._optReducedFlashing` | 10a | `src/state.js` |
| `setLeapMarker(x, z, remaining, total)`, `clearLeapMarker(enemyId)` | 10b | `src/enemyTells.js` |
| `state.run.overdriveActive`, `state.run.overdriveTimer` | 10b | `src/state.js` |
| `chest.spawnAt(x, z)` | 10b | `src/chest.js` |
| `runPerfSoak({seconds, seed, spawnMul})`, `window.kkSoak` | 10b | `src/perfSoak.js` |
| `'kk-meta-load-failed'`, `'kk-asset-load-failed'` CustomEvents | 10b emits / 10c listens | meta.js / assets.js → ui.js |
| `showCredits()`, `hideCredits()`, `isCreditsOpen()` | 10c | `src/ui.js` |
| `KK_VERSION` const | 10c | `src/ui.js` |
| `LICENSE` file | 10c | repo root |
| `how-to-play.html` | 10c | repo root |
| og: meta tags | 10c | `index.html` |

### Tuning targets

| Knob | Value | Rationale |
|---|---|---|
| Default master / music / sfx volume | 1.0 / 0.5 / 0.7 | Combat readability > music vibe |
| Font scale range | 0.85..1.30 | Beyond breaks layout |
| Reduced-flashing cap | 4 flashes/sec, alpha 0.4 | WCAG 2.3.1 safer |
| Phoenix revive cap | 6 (4 + 2 vault) | Prevents cheese stacking |
| Overdrive cycle | 60s wait, 5s active, +50% atkspd, +25% dmg | Frenzy-window per Diablo conventions |
| Treasure Map chest offset | hero + (5,0,5) | Visible at spawn without crowding |
| Leap marker color | 0xff66cc magenta | Distinct from elite ring + boss tells |
| Leap marker scale | 0.6 → 1.4 with windup | Grows = "about to land" |
| Perf soak duration | 60s, 3 trials at 1.0/1.5/2.0 spawn | Validates BALANCE.md flag + weekly DOUBLE_SPAWNS |
| Asset-failure toast duration | 6s auto-dismiss | Non-fatal degradation, don't block |
| Save-load-failure toast | persistent | Player NEEDS to know |
| Context-loss modal | persistent until restore | Critical |
| og:image dimensions | 1200×630 | Discord / Twitter standard |

### Risk flags

- **10a font-scale blast radius**: ui.js uses inline `font-size: 12px` in
  ~hundreds of cssText template literals. Implementing the scale via
  `--kk-font-scale` CSS var requires a per-modal rewrite OR a clever
  bucket via `font-size: calc(var(--kk-font-scale) * 13px)`. Pick the
  bucket approach — define 4-5 size classes (`.kk-font-sm/md/lg/xl/`
  Cinzel) and apply them consistently. Don't try to scale every literal.
- **10a audio split back-compat**: `meta.optVolume` is referenced in
  ui.js at line 2840 (vol.value = String(meta.optVolume)) and main.js at
  line 189 (setVolume(meta.optVolume)). Migration must NOT break these
  call sites mid-load. Keep `setVolume` as a shim mapping to
  setMasterVolume.
- **10b context-loss rebuild**: 12+ InstancedMesh systems need re-init.
  Risky. Pragmatic fallback: ship a modal that shows "Reload page" with
  one-click reload, defer the silent-restore path to iter 12. Document
  this in the modal's copy.
- **10b overdrive visual**: pumping `postFXPass.uniforms.uOverdriveTint`
  requires that uniform exists. If postfx.js doesn't already declare it,
  add it in this iter (small extension, no behavior change when 0). If
  too risky, fall back to a screen-tint via a fullscreen plane.
- **10b perf soak interactions**: running the soak resets `state.time.game`
  — must NOT corrupt a running run. Guard with `if (state.mode !== 'menu')
  console.warn('kkSoak runs only from menu'); return;`.
- **10c LICENSE choice**: README says "MIT (or your choice)" — confirm
  with user before committing the LICENSE file content. Default to MIT.
- **10c og:image asset**: needs a real PNG. If we don't have one, the
  iter-9 share card render API can produce one — call `renderShareCard`
  with sample data, download, drop into `assets/`. Otherwise, ship a
  placeholder and flag for iter 12.
- **Three-agent merge**: `src/ui.js` is touched by 10a (showOptions
  overhaul) and 10c (start screen + credits modal). 10a owns showOptions
  function exclusively; 10c owns the start-screen block + new modal. No
  line-range collision but expect a 2-way merge on imports/exports at
  the file top.

---

## Iter 11: r171 + TSL Spike

This is a SPIKE — exploratory, isolated, NOT shipped to main. The output
is a documented go/no-go with a perf comparison harness.

### Migration scope

Read SOTA_RESEARCH.md §1 + §8 in full. The headline:

> Since r171 (Sept 2025) `import * as THREE from 'three/webgpu'` ships
> a production WebGPU renderer with automatic WebGL2 fallback. Coverage
> ≈95% on WebGPU. Caveats: `WebGLCubeRenderTarget` → `CubeRenderTarget`,
> shadow bias values need re-tuning, `OutlinePass` and some
> `examples/jsm/postprocessing` are not yet WebGPU-native — use TSL
> `PostProcessing` instead.

**What TSL gives us:**
- **Compute particles** (`instancedArray`) — particle state on GPU
  across frames. Reports: 10k@30ms CPU → 100k@<2ms GPU (~150x).
- **TSL post-processing chain** that's WebGPU-native.
- **Node materials** simpler than custom-shader edits to `onBeforeCompile`.

**Migration risks (Three.js 0.160 → 0.171+):**
- **Selective bloom pipeline**: We use a two-composer trick (BLOOM_LAYER
  rendered into a bloom texture, then composited). r171's
  `examples/jsm/postprocessing/EffectComposer` may not preserve this in
  WebGPU mode. The TSL PostProcessing chain doesn't have an obvious
  selective-layer mask — need to port the layer trick to a custom
  TSL node graph. **This is the #1 risk.**
- **Custom shader hooks**: `assets.js injectVertAnim` uses
  `onBeforeCompile` to splice vertex code into MeshStandardMaterial.
  Node materials supersede this — `injectVertAnim` rewrite needed for
  WebGPU path.
- **DRACOLoader**: confirmed still works on r171, but verify with
  current asset pack.
- **importmap impact**: `three@0.171+` may break some addon paths. The
  current importmap pins specific subpath imports.

**File surfaces likely affected on a full migration:**
- `index.html` (importmap)
- `src/main.js` (renderer construction line 58-79)
- `src/postfx.js` (entire file — porting two-composer to TSL)
- `src/assets.js` (vertex anim injection)
- `src/env.js` (shadow bias retune)
- `src/blobShadows.js` (InstancedMesh — should port directly)
- Any file using `MeshStandardMaterial` (which is most enemies, hero,
  ground, props — these should auto-fallback but need verification)

### Proposed 1-2 agent split

**Agent 11a — Migration spike (mandatory):**

**Worktree:** `git worktree add ../kk-survivors-r171 main` and branch
to `iter-11-spike-r171`. NO commits to main from this agent.

**Owns:** entire `src/` of the worktree.

**Contract:**
1. Bump `index.html` importmap to `three@0.171+` + `three/webgpu`.
2. Try a pure-WebGL2 boot with new version — confirm zero behavioral
   regression. If anything breaks, document + stop. (Goal: prove the
   r0.171 upgrade is non-destructive even without WebGPU.)
3. Add `?renderer=webgpu` query flag. Default WebGL2. Branch at
   renderer-construction time in main.js.
4. Port post-FX chain to TSL `PostProcessing`. Reproduce selective
   bloom — this is the deliverable that determines go/no-go.
5. Add ONE TSL compute particle system as proof-of-concept: replace
   either the gem sparkle layer OR the kill-ring sparks with a TSL
   `instancedArray` particle. Compare draw calls / fps.
6. Retune shadow bias.
7. Document findings in `R171_SPIKE.md` at the worktree root (NOT main
   branch).

**Agent 11b — Perf harness (optional, can fold into 11a if budget
is tight):**

**Owns:** `src/perfSoak.js` extension OR new `src/perfCompare.js` in
the worktree.

**Contract:**
- Take iter-10's `runPerfSoak` API and extend with `compareRenderers({
  seconds, seed, spawnMul })` that runs the same seed twice — once
  with `?renderer=webgl2` and once with `?renderer=webgpu`. Outputs
  side-by-side metrics.
- Run 3 trials each at spawn-mul 1.0, 1.5, 2.0.
- Output JSON `{ webgl2: {...}, webgpu: {...}, delta: {...} }` to
  console.

### Go/no-go criteria

The spike is GO (i.e., promote to main) iff ALL of:
1. **Visual parity**: selective bloom + ACES + LGG grading + height fog
   look identical to WebGL2 within "can't tell the difference at
   normal play" tolerance. The user's bar is "spider web is good" —
   any visual regression vs. iter-9 master is auto-no-go.
2. **Perf parity or better**: WebGPU path holds ≥55fps p90 at 162-alive
   (BALANCE.md flagged stretch), no worse than WebGL2 on the same hardware.
3. **Fallback works**: dropping `?renderer=webgpu` returns to the WebGL2
   path with no visible diff vs current main.
4. **InstancedMesh systems unaffected**: gems, blob shadows, pickups,
   ranged tells, threat dots, kill rings all render correctly.
5. **No breaking r171 API hits**: nothing in `examples/jsm` we depend
   on has gone away.

The spike is NO-GO if ANY of:
- Selective bloom can't be reproduced in TSL PostProcessing without
  re-engineering > 2x file surface change.
- WebGPU perf is WORSE than WebGL2 at the BALANCE.md stretch case
  (very unlikely but possible on Intel UHD).
- onBeforeCompile-based vertex anim is non-trivial to port.
- Any iter-10 surface (audio menu, leap marker, tier-4 capstones)
  regresses on the spike branch.

**Valid spike outcome: "Documented, deferred to v1.1"** — that is
shippable as a 1.0 game per the user mandate. Cite SOTA_RESEARCH.md's
"95% WebGPU coverage" — we're not actually leaving 95% of users on a
slow path; WebGL2 stays well-optimized.

### Risk flags

- **Selective bloom port**: highest-confidence risk. If it can't be done
  via TSL nodes, the WebGPU path can't ship.
- **Mobile Safari WebGPU**: enabled in Safari 17.4 but not on all iOS
  versions. The default-WebGL2 fallback covers this.
- **Importmap break**: a single bad subpath can prevent boot. Test in
  Firefox + Chrome + Safari before declaring done.
- **Time budget**: spike is meant to be 1-2 days, not 5. If selective
  bloom port hits 2 days alone, stop and declare no-go for iter 11.
- **No worktree push to remote**: parent must explicitly NOT push the
  spike branch to GitHub Pages — only main goes there.

---

## Ship Reassessment (post iter 10/11)

Walking the user's 8-point checklist with verdicts.

### 1. Combat feel — does each weapon's impact read?

**Verdict: YES (with iter-10 polish).** Iter 1 ("Combat Grammar") shipped
legibility per ROADMAP.md. FX_AUDIT closed the placeholder rings + burger
upgrade per the user's "spider web is good, burgers are mid" complaint.
The 6 weapon families (orbitals + 5 evos via fillers) all have unique
visuals. Damage numbers + screen shake + kill rings + hit-stops are all
in. Iter-10b's tier-4 capstones (Overdrive frenzy visual, Phoenix
revive, Treasure Map starter) close the final "promised but missing"
beat.

### 2. Roster diversity — are the 6 characters genuinely different in feel?

**Verdict: YES (post iter-7).** Per ITER_789_BRIEFS.md iter 7 brief,
each character now has a signature mechanic — Nine Lives, Charged Coil,
Lingering Silk, Headhunter, Ember Burst, Tempo. These are felt within
30s of run start (the design target). HOWEVER: iter-10c MUST add the
signature preview line on the card itself (not just hover), or new
players won't know to test the differences. **Soft NO without the card
preview** — that's already in 10c contract.

### 3. Enemy identity — do the affixes change decisions?

**Verdict: YES (post iter-8) AND now post iter-10b (leap marker).**
Affixes (Volatile / Vampiric / Leaping / Shielded / Swift / Frosted)
all bring counterplay grammar. Per-boss patterns (Engulf / Sonic Cone /
Quake Cross / Nightmare cycle) replaced the monoculture shockwave.
BUT: Leaping affix was shipped without a landing-zone tell — players
get blindsided. Iter 10b closes this. **Without 10b: NO; with 10b: YES.**

### 4. Build variety — meaningful choices in shop tree + level-ups?

**Verdict: MARGINAL → YES post iter-10b.** SHOP_TREE 3 branches × 4
tiers = 12 nodes. Three of the four tier-4 capstones (Phoenix, Overdrive,
Treasure Map) are unwired today (TODO(iter6-wire) marks). Players who
spent ~123 sigils to complete a branch get a button that does nothing.
That's a 25% broken-promise rate on the meta surface. Iter 10b fixes
all three. Level-up modal currently offers weapon evolutions + passives
+ shop-tree-aware paths (per iter 6). Roster signatures (iter 7) +
weekly mutators (iter 9) further widen the decision space. **Post-10b
this is genuinely build-deep.**

### 5. Retention — daily + weekly + leaderboard + share card?

**Verdict: PARTIAL.** Daily exists since pre-iter-9. Weekly + share card
+ achievement chain DAG + Hall of Records are all iter-9 deliverables —
currently in flight per HANDOFF.md status. Leaderboard is local-only
(`src/leaderboard.js` exists; the comment header names a Cloudflare
Workers POST that doesn't exist yet). For a 1.0 ship, local-only is
**acceptable but not VS-tier**. True parity requires a remote
leaderboard (iter 12). **Yes for v1.0; iter 12+ to match top-tier.**

### 6. Polish — audio, settings, accessibility, error handling, intro?

**Verdict: NO without iter 10; YES with iter 10.** This is the entire
mandate of iter 10. Today: 1 volume slider, zero accessibility, silent
save corruption, no credits, no version, no LICENSE, 12 placeholder
rings still in town/interior/catacomb, no error toasts, no WebGL
context-loss handler. Iter 10 closes all of these. **Iter 10 ships =
YES; without iter 10 = absolute NO.**

### 7. Visual quality — every FX at spider-web tier?

**Verdict: YES (post iter-10b).** FX_AUDIT was a thorough sweep that
landed 12 file upgrades. 12 placeholders remain in restricted files
(town/interior/catacomb) — 10b closes those. All foreground combat FX
are at the user-locked quality bar. Style bible discipline (8 colors +
4/2/1 px lines) preserved throughout.

### 8. Perf — 60fps with 220 enemies on iter-9 weekly DOUBLE_SPAWNS?

**Verdict: UNKNOWN until 10b's soak runs.** PERF.md targets 60fps with
220-alive cap. BALANCE.md flags the new 162-alive case as
needs-playtest. Weekly DOUBLE_SPAWNS doubles target to 324-alive (cap
clamps to 220 actual but spawn churn intensifies). The 10b
`runPerfSoak` deliverable is exactly this measurement. If p99 frame ≥
22ms at spawnMul 2.0, **iter 12 perf hardening required**. If under,
**ship-ready**.

### Aggregate verdict

**Ship-ready as v1.0 only after iter 10 is complete and the iter-10b
perf soak passes p99 ≤ 22ms at spawnMul 1.5.** Iter 11 is a spike — its
outcome should NOT gate v1.0 ship.

Conditional iter-12+ candidates (all valid v1.1 work, not v1.0
blockers):
- **Remote leaderboard** via Cloudflare Workers + D1 (SOTA_RESEARCH §6).
- **Real OST** — procedural Web Audio music is functional but not
  Hades-tier. Either Tone.js procedural improvement or licensed loops
  (SOTA_RESEARCH §5).
- **i18n strings** — iter 10a stubs `optLanguage`; actual translations
  are a content task.
- **Mobile / touch support** — current is keyboard + gamepad. Touch
  controls + responsive layout = 1 dedicated iter.
- **Boids + WebGPU horde stretch** (SOTA_RESEARCH §3) — only after iter
  11 promotes WebGPU to default.
- **PCG biome decoration via WFC** (SOTA_RESEARCH §2) — nice-to-have.
- **WebRTC hangout lobby** (SOTA_RESEARCH §7) — strictly post-1.0.
- **Visual shop-tree tree** (with branch lines) — current text-card
  rendering is functional but flat.
- **Victory cinematic** — 2-3 second outro before the score screen.
- **Save autosave heartbeat** — currently only on commit; weekly best
  could be lost on tab close mid-run.
- **Achievement notification queue** — iter-9 ships a queue but
  if the chain DAG fires multiple at once, the toast slot may starve.

### Proposed iter 12+ priority order

1. **Iter 12 — Perf hardening** (gated on 10b soak result). Pool
   `bossTelegraphs.js` RingGeometry properly, gate blob shadows by
   camera distance, profile + fix the worst hotspot from soak data.
   Only fires if soak fails.
2. **Iter 13 — Cloudflare Workers leaderboard**. Worker + D1 +
   HMAC-signed run + GET /top KV cache. Reuse signaling for future
   multiplayer.
3. **Iter 14 — Touch / mobile** controls + responsive layout. Open
   the player base by 5x.
4. **Iter 15 — i18n content pass**. Strings → ES module per language.
   Spanish + Japanese first (high engagement audiences for VS-likes).
5. **Iter 16 — r171 + TSL promotion** (only if iter 11 spike was GO
   but deferred for stability). Default WebGPU.
6. **Iter 17 — OST + ambient pass**. Better procedural music or
   licensed loops.

End of brief.
