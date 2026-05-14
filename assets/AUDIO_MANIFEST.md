# Audio Asset Manifest

All 38 audio files under `assets/audio/` are derived from **Kenney audio packs**, every one of which ships under **Creative Commons Zero (CC0, public domain)** per the bundled `License.txt` inside each pack. No attribution is required by the license. We credit Kenney here voluntarily.

Iter 16 (2026-05-14) replaces the procedural AudioContext-tone synthesis in `src/audio.js` with these sample-based playbacks. Per-call ±3% pitch jitter + 2-3 variants per high-frequency bucket keep repeats from feeling robotic.

## Source packs (all CC0)

| Pack | URL | Used for |
|------|-----|----------|
| Impact Sounds | https://kenney.nl/assets/impact-sounds | hits, hurts, generic impacts, low body |
| Interface Sounds | https://kenney.nl/assets/interface-sounds | plucks for web/frostbloom |
| RPG Audio | https://kenney.nl/assets/rpg-audio | (downloaded; unused so far — punted to iter 17 for footsteps) |
| Sci-Fi Sounds | https://kenney.nl/assets/sci-fi-sounds | bomb, explosion, dash, boss rumble |
| Casino Audio | https://kenney.nl/assets/casino-audio | gem/coin/chip pickup sparkle |
| UI Audio | https://kenney.nl/assets/ui-audio | (downloaded; reserved for iter 17 UI hooks) |
| Digital Audio | https://kenney.nl/assets/digital-audio | laser zaps for shoot/chain/autoaim |
| Music Jingles | https://kenney.nl/assets/music-jingles | level-up, victory, heart pickup, elite death, hero death |

Re-download (idempotent): `bash scripts/fetch-audio.sh`.
Re-process from raw: `bash scripts/process-audio.sh`.
Both scripts read/write under `/tmp/kk_audio_raw/` so nothing in the repo carries 80 MB of raw assets.

## Processing pipeline

Every file passes through:

1. `silenceremove=start_periods=1:start_silence=0.02:start_threshold=-50dB` — tight attack
2. `volume=0.92` — normalize to -1 dBFS-ish peak so the per-bucket runtime gain in `audio.js` is honest
3. Per-row filter chain from `scripts/audio_manifest.txt` (pitch shift, EQ, light reverb)
4. Mono downmix + Ogg Vorbis `q:a 2` (~96 kbps) for tiny shipping size

Total catalog: **38 samples, 308 KB**. Budget was 3 MB.

## Bucket → file map

Buckets mirror the `sfx.*` API surface in `src/audio.js`. Variant `_a`/`_b`/`_c` files become randomized variants in `SFX_BANK[bucket]`. Single-shot buckets (level-up, victory, hero-death, boss-spawn-bell, boss-spawn-rumble) have one file.

| Bucket | Files | Where it plays |
|--------|-------|----------------|
| `shoot` | `cast/shoot.ogg` | legacy weapon fallback |
| `hit` | `hit/hit_a.ogg`, `hit/hit_b.ogg` | generic non-enemy impact |
| `pickup` | `pickup/xp_pickup_{a,b,c}.ogg` | XP gem absorb |
| `coinPickup` | `pickup/coin_pickup_{a,b}.ogg` | currency drop |
| `heartPickup` | `pickup/heart_pickup.ogg` | heal pickup |
| `starPickup` | `pickup/star_pickup.ogg` | rare/sparkle pickup |
| `chestOpen` | `pickup/chest_open.ogg` | chest pop |
| `levelUp` | `levelup/levelup.ogg` | XP level threshold |
| `victory` | `levelup/victory.ogg` | run win fanfare |
| `heroHit` | `hit/hero_hit.ogg` | hero generic impact |
| `heroHurt` | `hit/hero_hurt.ogg` | hero HP loss |
| `heroDeath` | `death/hero_death.ogg` | descending dirge |
| `death` | `death/death.ogg` | generic death |
| `explosion` | `death/explosion.ogg` | generic boom |
| `enemyHurt` | `hit/enemy_hurt_{a,b,c}.ogg` | every enemy tick — 3 variants |
| `enemyDeath` | `hit/enemy_death_{a,b}.ogg` | enemy KO |
| `eliteDeath` | `hit/elite_death.ogg` | elite KO |
| `weaponBurger` | `cast/weapon_burger_{a,b}.ogg` | sigilbell + orbitals |
| `weaponChain` | `cast/weapon_chain_{a,b}.ogg` | chain weapon |
| `weaponAutoaim` | `cast/weapon_autoaim_{a,b}.ogg` | autoaim cast |
| `weaponBomb` | `cast/weapon_bomb.ogg` | bomb detonation |
| `weaponWeb` | `cast/weapon_web_{a,b}.ogg` | web + frostbloom |
| `weaponDash` | `cast/weapon_dash.ogg` | hero dash whoosh |
| `bossWarn` | `boss/boss_warn.ogg` | mini-event warning bell |
| `bossSpawn` | `boss/boss_spawn_bell.ogg` + `boss/boss_spawn_rumble.ogg` | sequenced layer — audio.js plays both |
| `bossShockwave` | `boss/boss_shockwave.ogg` | boss AoE telegraph land |

## Punted to iter 17+

- UI hooks (`sfx.uiClick`, `sfx.uiCancel`, `sfx.error`) — `audio.js` does not expose them today and `ui.js` is hands-off this iter, so adding them would be dead-code. Reserve `assets/audio/_raw/interface_pack` for this.
- Per-stage ambient drones — would collide with the existing menu-bed + music-tier system.
- Hero footsteps — Kenney RPG/Impact packs have rich footstep variants (carpet/concrete/grass/snow/wood), but no caller pulls them today.
- freesound.org cherry-picks for boss-unique cues — Kenney was rich enough for iter 16.
