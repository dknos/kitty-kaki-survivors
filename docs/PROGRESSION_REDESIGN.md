# Progression + Roster Redesign

Status: **design lock, pre-impl**
Owner: dknos / Claude C
Branch target: `main` (single-PR-per-phase)
Last edit: 2026-05-15

## 1. Locked decisions

User-confirmed via AskUserQuestion 2026-05-15:

| Axis | Decision |
|---|---|
| **Avatar ↔ archetype** | **1:1.** Each of 12 avatars becomes its own gameplay kit. Drop the `CHARACTERS` archetype table; collapse into `AVATARS`. |
| **Kit identity depth** | **Unique signature weapon + shared pool.** Each avatar ships 1 bespoke weapon (mechanic + FX + SFX) + access to the existing 7 shared weapons. |
| **Currency** | **Embers + Mastery.** Embers stay universal (run-end), drive global meta + roster unlocks. New per-avatar Mastery currency (kills-with-this-avatar) drives signature variants + cosmetic tiers. |

## 2. Hard rules — must not violate during impl

These are non-negotiable because they encode prior incidents.

1. **VFX budget.** Last session shipped at 21.84 ms render → DPR cut to 1.25. Every new signature-weapon VFX **must**:
   - Inherit `fxLayers.js` helpers (`floorDecalMaterial`, `applyFloorTier`).
   - Share `InstancedMesh` pools — no new per-cast draw call. If the mechanic genuinely needs a new pool, it lives in a single new module under `src/weapons/<name>.js` with one `InstancedMesh` cap-bounded.
   - Reuse the 8 hand-painted Vertex textures already in `assets/fx/MANIFEST.json` where possible. New textures require a tier+blend entry in the manifest.
2. **Save schema migration is mandatory.** localStorage wipes #11–#16 in `~/.claude/projects/-home-nemoclaw/memory/MEMORY.md` were all save-shape regressions. Phase B reads `kk-survivors-meta-v1`, writes `-v2` only after successful translation, and falls back to defaults on parse failure. No in-place mutation of v1 keys.
3. **No balance numbers in this doc.** Balance is downstream of kit identities. Tuning happens in Phase G against the 12 finalized kits, not phase-by-phase.
4. **No PM2 / Discord / firebase actions.** Pure client-side game work. (`feedback_no_production_deploy.md`.)
5. **No grok-api proposals.** If a kit needs an asset we don't have, generate via Vertex Imagen 4 (`~/scripts/gen-texture.sh`) or Playwright grok-server `:3091`. (`grok_no_longer_available.md`.)

## 3. Current state — what we're refactoring away from

- `src/config.js` exports two parallel tables: `CHARACTERS` (6 archetypes — Balanced/Boom/Webspinner/Sniper/Phoenix/Clockwork) and `AVATARS` (12 visual entries — Kitty Kaki, Sote, CowboyKaki, Pipes, Bom Dia, Mothman, Camper, Space Kitty, Radcat, Mona, BezelBug, RockerKaki).
- Start screen presents both pickers (carousel + chip row) — confusing 2-axis selection.
- `src/meta.js` save key `kk-survivors-meta-v1` carries: `embers`, `achievements`, `shop`, `unlockedHyper`, `unlockedEndless`, `unlockedCinder`, `unlockedClockwork`, `unlockedVoid`, casino state. No per-avatar progression tracking.
- 7 weapons under `src/weapons/`: autoAim, chain, frostbloom, orbitals, sigilbell, web + passives + descriptions/index. Each archetype starts with one of these via `CHARACTERS.starter`.
- `runState.signature_*` flags drive archetype identity (read in `hero.js`, `enemies.js`, `weapons/*.js`).

## 4. Target state

After all phases:

- Single table `AVATARS` in `src/config.js`. Each entry has: `id, name, icon, desc, glb, tint, scaleMul, signatureWeapon, signatureFlag, baseStats {hpMax, dmgMul, moveMul, magnetMul, projSpeedMul?}, unlock {ember?: N, mastery?: N, flag?: 'name'}, masteryTiers: [{kills: N, reward: 'cosmetic_id'|'fx_skin'|'signature_v2'}]`.
- `CHARACTERS` table deleted. All consumers (carousel, hero spawn, signature application) rewired to read from `AVATARS`.
- 12 new signature-weapon modules — one per avatar — under `src/weapons/sig/<avatarId>.js`. Each exports `signatureWeapon` with the same shape as existing weapons (cooldown/fire/levelup hooks).
- `src/meta.js` save key `kk-survivors-meta-v2` adds: `avatarUnlocks: { id: { unlockedAt: ts, kills: N, runs: N } }`, `mastery: { id: N }` (per-avatar currency), `cosmetics: { id: ['tier_a', ...] }`. v1 → v2 migration reads `unlockedClockwork`, infers default 3-avatar starting roster, preserves Embers + achievements.
- New UI surface: post-run mastery gain banner, carousel locks for un-unlocked avatars w/ visible cost, per-avatar mastery progress bar in carousel.

## 5. Phase plan — one PR per phase, ship D before F

### Phase A — Design lock + doc *(this PR)*
- Write `docs/PROGRESSION_REDESIGN.md` (this file).
- No code changes.
- Exit: doc merged, advisor consulted on plan, decisions locked.

### Phase B — Currency + save schema migration
**Scope:** `src/meta.js` only. No weapon, hero, or UI touches.
**Adds:**
- New defaults: `avatarUnlocks: {}`, `mastery: {}`, `cosmetics: {}`.
- New constant `STARTER_AVATARS = ['kitty', 'sote', 'cowboy']` — first 3 free on a new save.
- New functions: `getMastery(id) → N`, `grantMastery(id, n)`, `isAvatarUnlocked(id) → bool`, `unlockAvatar(id, source)` (records source: 'ember-spend' | 'mastery-milestone' | 'flag').
- v1 → v2 migration:
  - On load, if `localStorage.getItem('kk-survivors-meta-v1')` exists and `-v2` doesn't, parse v1, copy embers/achievements/shop/mode-unlocks, derive `avatarUnlocks` from existing flag (`unlockedClockwork` → mark `rocker` as alias TBD), write `-v2`, leave `-v1` intact for rollback.
  - On parse failure, log to console.warn, fall back to defaults, do **not** overwrite either key.
- Hooks for ember-spend on roster unlock (no UI yet — Phase E surfaces it).

**Exit:** unit-style smoke (open page, dev-tools localStorage check shows both keys, no `-v2` regen on reload).

### Phase C — Kit infrastructure refactor
**Scope:** `src/config.js`, `src/charCarousel.js`, `src/hero.js`, `src/main.js`.
**Replaces:** archetype layer.
**Adds:**
- Collapsed `AVATARS` table — each entry inherits the union of `CHARACTERS` + current `AVATARS` fields.
- 12 starter avatar entries with `signatureWeapon` field pointing to a stub module (to be filled in Phase D/F).
- Helper `getActiveAvatar() → entry` reads `localStorage.kk-survivors-meta-v1.selectedAvatar` (already exists).
- Carousel reads `AVATARS` only; archetype chip row deleted from start screen.
- Hero spawn applies `baseStats` + sets `signatureWeapon` as start weapon.
- All existing 6 archetype signatures (`signature_nineLives`, `signature_chainEcho`, `signature_webHeal`, `signature_executeBonus`, `signature_emberBurst`, `signature_tempo`) remapped onto avatars per table below — no orphaned readers.

**Avatar → signature mapping (Phase C provisional, refined in D/F):**

| Avatar | Provisional signature | Starter weapon | Source archetype it absorbs |
|---|---|---|---|
| Kitty Kaki | Nine Lives | orbitals (cheesy burgers) | Balanced |
| Sote | Wolfheart (new) | sig/sote_warhowl.js | — |
| CowboyKaki | Headhunter | sig/cowboy_sixshooter.js | Sniper |
| Pipes | Charged Coil | sig/pipes_arcwrench.js | Boom |
| Bom Dia | Tempo | sig/bomdia_sunburst.js | Clockwork |
| Mothman | Lingering Silk | sig/mothman_dustcloak.js | Webspinner |
| Camper | Ember Burst | sig/camper_signalfire.js | Phoenix |
| Space Kitty | new (orbital ring) | sig/space_satellites.js | — |
| Radcat | new (DoT zones) | sig/radcat_fallout.js | — |
| Mona | new (paint AoE) | sig/mona_brushstroke.js | — |
| BezelBug | new (gem shards) | sig/bezelbug_facet.js | — |
| RockerKaki | new (sonic waves) | sig/rocker_powerchord.js | — |

**Exit:** all 12 avatars selectable, all run with their starter weapon (stub if Phase D not done — fall back to closest shared weapon). No archetype chip row visible.

### Phase D — 3 reference kits end-to-end
**Scope:** `src/weapons/sig/cowboy_sixshooter.js`, `src/weapons/sig/mothman_dustcloak.js`, `src/weapons/sig/space_satellites.js`.

These three are chosen because they span the three archetype shapes:
- **Cowboy / Six-Shooter** — ranged burst (validates projectile pool reuse, headshot crit signature).
- **Mothman / Dust Cloak** — trap/zone (validates floor-decal-tier infra carries to new weapons + lingering-tick mechanics).
- **Space Kitty / Satellites** — orbital (validates `InstancedMesh` reuse from `weapons/orbitals.js` pattern).

Each kit ships:
1. New module under `src/weapons/sig/`.
2. 8 level definitions (cooldown/damage/proj-count/ttl/pierce) matching shared-weapon shape.
3. FX: textures via existing `fxTex()` or 1 new texture/kit via Vertex Imagen 4 (added to `MANIFEST.json` w/ tier).
4. SFX: 1 cast sound + 1 impact sound per kit from Kenney/freesound CC0, ffmpeg-processed (`feedback_kitty_kaki_sfx_arena.md`).
5. Description string for `descriptions.js`.
6. Wired into `weapons/index.js` registry.

**Exit:** play all 3 avatars end-to-end, kit feels distinct, no fps regression vs current main on same swarm.

### Phase E — Unlock chain + carousel UI
**Scope:** `src/charCarousel.js`, new `src/masteryUI.js`, `src/meta.js` (consumers).
**Adds:**
- Carousel renders locked avatars dimmed w/ lock icon + cost overlay ("100 Embers" / "Defeat first mini-boss" / "Mastery 50 on Sote").
- Click on locked avatar → cost modal w/ unlock button (if affordable) → calls `unlockAvatar(id, source)`.
- Post-run banner: "+N Mastery for {avatar}" using existing banner system.
- Carousel shows mastery bar under unlocked avatars (3 tiers: 50 / 200 / 500 kills).
- Mastery tier rewards: tier 1 = aura FX color shift, tier 2 = projectile trail upgrade, tier 3 = signature v2 (variant with 1 mechanic tweak).

**Roster unlock table (locked here, Phase B reads):**

| Avatar | Unlock cost |
|---|---|
| kitty, sote, cowboy | **Free** (starter) |
| pipes | 80 Embers |
| bomdia | Defeat first mini-boss |
| mothman | 150 Embers |
| camper | Survive 5 min in one run |
| space | 200 Embers |
| radcat | Catacomb clear |
| mona | 300 Embers + Mastery 100 on any avatar |
| bezelbug | Final boss win |
| rocker | Casino jackpot |

**Exit:** save a fresh profile, unlock 3 avatars through the chain, all four UI surfaces visible.

### Phase F — Remaining 9 kits ported (2–3 PRs)
**Scope:** the 9 signature weapons not delivered in Phase D.

Suggested PR slicing:
- F1: kitty, sote, pipes, bomdia (4 kits, remap archetype signatures + 1 fully new in Sote).
- F2: camper, radcat, mona (3 fully new kits, share heat/zone mechanic patterns).
- F3: bezelbug, rocker (2 fully new kits, both gem/sonic — distinct enough for one PR).

Each kit follows Phase D's deliverable shape: module + 8 levels + FX (manifest entry if new tex) + SFX + descriptions + index registration.

**Exit:** all 12 avatars have a working signature; no shared-weapon fallback paths in `hero.js` triggered.

### Phase G — Balance pass
**Scope:** numbers-only, no new mechanics.
**Adds:**
- Final-form 8-level tables for all 12 signatures.
- HP/move/magnet baseStats tuned vs 30-minute survival benchmark per kit.
- Mastery curve calibration: tier 1 reachable in 1–2 runs, tier 2 in ~8 runs, tier 3 in ~25 runs.
- Roster unlock cost recheck against actual ember drop rate.

**Exit:** none of the 12 kits is dominant (no >2σ outlier in win-rate or DPS at the 30-min mark on a fixed seed).

## 6. Roster + currency design — locked

### Mastery currency
- 1 Mastery per ~10 enemy kills with that avatar (subject to Phase G recalibration).
- Mini-boss kill = +5, final boss kill = +15.
- Does not persist mid-run — settled at run end based on kills-with-avatar.
- Cap none (collect freely; tier rewards consume nothing — they're milestone unlocks, not spend).

### Ember currency
- Unchanged drop rate. Sinks: shop (existing), roster unlocks (new — Phase E table).
- No mastery-for-embers conversion (keeps the two tracks honest).

### Unlock states per avatar
A persistent record in save:
```js
avatarUnlocks: {
  kitty:   { unlockedAt: 0, kills: 0, runs: 0 },   // 0 = always unlocked
  cowboy:  { unlockedAt: 0, kills: 0, runs: 0 },
  sote:    { unlockedAt: 0, kills: 0, runs: 0 },
  pipes:   undefined,   // locked; ember spend or condition unlocks
  ...
}
```
- `undefined` = locked. Truthy entry = unlocked at that timestamp.
- `kills` increments on every enemy kill while that avatar is the active hero.
- `runs` increments at run end.
- Mastery is computed: `Math.floor(kills / 10)` + boss kill totals (stored separately to keep the formula auditable).

## 7. Risks + mitigation

| Risk | Mitigation |
|---|---|
| 12 new signature weapons blow framerate | Phase D ships 3 first and benchmarks; Phase F gated on D's perf result. |
| Save migration corrupts existing players | Phase B writes v2 only after success; keeps v1 untouched. Add a `migrationVersion: 2` field so we know the path taken. |
| Asset gen via Vertex Imagen 4 produces off-style textures | Reuse existing 8 textures from MANIFEST where possible; new gens go through the same WebP q88 pipeline; if quality is low, fall back to procedural canvas. |
| Players who already played v1 lose Clockwork archetype identity | Phase B migration grants Mastery on the absorbing avatar (Bom Dia gets Clockwork's Tempo as signature; Bom Dia mastery starts at +50 for existing v1 players). |
| Carousel becomes too long w/ 12 entries | Phase C step: paginate or scrollable strip — already partially handled in `charCarousel.js`. |
| Unique-weapon scope creep | Each kit gets exactly **1** bespoke weapon. Sub-mechanics piggyback on existing weapon pools (e.g. Mona's brushstroke can reuse the orbital decal pool with retinted geometry). |

## 8. Out of scope

- Stage/biome additions.
- Boss redesign.
- Enemy roster expansion.
- Online leaderboards beyond existing `leaderboard.js`.
- Cosmetic skin storefront (only the 3 mastery tiers per avatar — no shop).
- Multiplayer.

## 9. Open questions to resolve before Phase D

1. **Sote's signature mechanic** — Wolfheart placeholder. Pack mechanic? Bleed-stack? Sustain-rage? Defer to Phase D kickoff.
2. **Mastery currency name** — keep "Mastery" or rename (e.g. "Resonance", "Spirit")? Defer to Phase E UI work.
3. **Mona's paint AoE** — does it stack with stage hazards (`stageHazards.js`)? Decide before Phase F2.
4. **Phase B v1→v2 ember bonus** — should existing v1 players get a +50 Ember "transition gift" to soften the roster lock? Suggest yes.

These don't block Phase B/C. Resolve at the start of the phase that consumes them.
