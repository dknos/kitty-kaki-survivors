/**
 * Audio: CC0 sample playback for combat/UI SFX + procedural music bed.
 *
 * Layout (iter 16):
 *   _ctx ─► _master ─► destination
 *               ▲
 *       _musicBus (procedural music + ambient bed)
 *       _sfxBus   (sample-based combat sfx)
 *
 * - `_master` is the master gain; `setMasterVolume` writes to it.
 * - `_musicBus` carries the still-procedural music + menu/town/interior bed.
 *   `setMusicVolume` writes to it.
 * - `_sfxBus` carries SFX. `setSfxVolume` writes to it.
 * - Legacy `setVolume(v)` is a deprecated shim mapping to `setMasterVolume`.
 * - Every sfx.* is throttled: a 30ms minimum gap per-method prevents layering
 *   when e.g. an orbital hits 5 enemies in one frame.
 *
 * Iter 16 (2026-05-14): replaced procedural tone synthesis with CC0 Kenney
 * samples decoded into `SFX_BANK[bucket]`. Each public sfx.* method picks a
 * random variant + ±3% playbackRate jitter so repeats don't feel robotic.
 * Music + menu-bed remain procedural (they're working fine + Music submaster
 * routes them; replacing them was out of iter 16 scope).
 */

import { state } from './state.js';

let _ctx = null;
let _master = null;       // master gain (everything funnels here)
let _musicBus = null;     // procedural music + ambient bed submaster
let _sfxBus = null;       // combat sfx submaster
let _enabled = true;
// Cached menu/town/interior mode detector — audio module polls state.mode
// since we can't observe writes to it from town/interior/catacomb modules.
let _modePollTimer = null;
let _menuBedActive = false;

function ensureCtx() {
  if (_ctx) return _ctx;
  _ctx = new (window.AudioContext || window.webkitAudioContext)();
  _master = _ctx.createGain();
  _master.gain.value = 1.0;
  _master.connect(_ctx.destination);
  // Music submaster — default 0.5 (combat readability > music vibe).
  _musicBus = _ctx.createGain();
  _musicBus.gain.value = 0.5;
  _musicBus.connect(_master);
  // SFX submaster — default 0.7. Slightly louder than music so combat reads.
  _sfxBus = _ctx.createGain();
  _sfxBus.gain.value = 0.7;
  _sfxBus.connect(_master);
  // Kick off CC0 sample decoding once we have a ctx. Safe to call on a
  // suspended context — decodeAudioData works regardless of run state.
  _primeSamples();
  return _ctx;
}

/** Resume audio context on first user gesture (required by browsers). */
export function unlockAudio() {
  const ctx = ensureCtx();
  if (ctx.state === 'suspended') ctx.resume();
  // Kick off the mode poller once we have a live ctx. menuBed auto-starts
  // when state.mode is in {menu, town, interior}.
  _startModePoll();
}

/** Master volume (0..1). Controls every audible output. */
export function setMasterVolume(v) {
  const clamped = Math.max(0, Math.min(1, Number(v) || 0));
  if (_master) _master.gain.value = clamped;
}

/** Music submaster volume (0..1). Affects procedural music + menu bed. */
export function setMusicVolume(v) {
  const clamped = Math.max(0, Math.min(1, Number(v) || 0));
  if (_musicBus) _musicBus.gain.value = clamped;
}

/** SFX submaster volume (0..1). Affects combat + UI sounds. */
export function setSfxVolume(v) {
  const clamped = Math.max(0, Math.min(1, Number(v) || 0));
  if (_sfxBus) _sfxBus.gain.value = clamped;
}

/**
 * Deprecated — kept as a back-compat shim. Existing callers (main.js boot,
 * ui.js legacy options slider) route through here so old `meta.optVolume`
 * saves still produce audible output. New code should call setMasterVolume.
 */
export function setVolume(v) {
  setMasterVolume(v);
}

export function setEnabled(b) { _enabled = !!b; }

// ─── Legacy procedural helpers (kept for back-compat; route through _musicBus) ─
// These three were previously wired to _master. After the iter-10a split they
// route through _musicBus so they participate in music-volume control. After
// iter 16 (sample-based SFX) no in-tree caller invokes them, but keeping the
// helpers means future melodic ambient nudges land in the music bus by
// default and any external user-script callers don't break.

/** Short tone — routes through _musicBus. */
function tone(f, dur, type = 'square', vol = 0.5) {
  if (!_enabled) return;
  const ctx = ensureCtx();
  if (ctx.state !== 'running') return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f, t);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(_musicBus);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

/** Frequency sweep — routes through _musicBus. */
function sweep(fStart, fEnd, dur, type = 'square', vol = 0.4) {
  if (!_enabled) return;
  const ctx = ensureCtx();
  if (ctx.state !== 'running') return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(fStart, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, fEnd), t + dur);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(_musicBus);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

/** Brief noise burst — routes through _musicBus. */
function noiseBurst(dur, vol = 0.4, lowpass = 1200) {
  if (!_enabled) return;
  const ctx = ensureCtx();
  if (ctx.state !== 'running') return;
  const t = ctx.currentTime;
  const buf = ctx.createBuffer(1, Math.max(1, ctx.sampleRate * dur), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.6;
  const src = ctx.createBufferSource(); src.buffer = buf;
  const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = lowpass;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filt).connect(g).connect(_musicBus);
  src.start(t);
  src.stop(t + dur + 0.02);
}

// ─── Sample bank: CC0 Kenney audio decoded into AudioBuffers ─────────────────
// Each bucket maps to one or more decoded AudioBuffers. _play() picks a random
// variant and applies ±3% pitch jitter so repeats don't feel robotic.
//
// Banks fill asynchronously from module init. _play() returns silently while
// buckets are still decoding — first-shot is just inaudible, not crashed.
// Decode is kicked off via _primeSamples() on the first ensureCtx() call so
// AudioContext is ready (decodeAudioData works on a suspended ctx too, but
// having the ctx in hand avoids constructor-during-decode races).

const SFX_MANIFEST = {
  // hits — busiest bucket, 3 variants for enemy_hurt
  enemyHurt:    ['audio/hit/enemy_hurt_a.ogg', 'audio/hit/enemy_hurt_b.ogg', 'audio/hit/enemy_hurt_c.ogg'],
  hit:          ['audio/hit/hit_a.ogg', 'audio/hit/hit_b.ogg'],
  enemyDeath:   ['audio/hit/enemy_death_a.ogg', 'audio/hit/enemy_death_b.ogg'],
  eliteDeath:   ['audio/hit/elite_death.ogg'],
  heroHit:      ['audio/hit/hero_hit.ogg'],
  heroHurt:     ['audio/hit/hero_hurt.ogg'],
  // pickups
  pickup:       ['audio/pickup/xp_pickup_a.ogg', 'audio/pickup/xp_pickup_b.ogg', 'audio/pickup/xp_pickup_c.ogg'],
  coinPickup:   ['audio/pickup/coin_pickup_a.ogg', 'audio/pickup/coin_pickup_b.ogg'],
  heartPickup:  ['audio/pickup/heart_pickup.ogg'],
  starPickup:   ['audio/pickup/star_pickup.ogg'],
  chestOpen:    ['audio/pickup/chest_open.ogg'],
  // level / win
  levelUp:      ['audio/levelup/levelup.ogg'],
  victory:      ['audio/levelup/victory.ogg'],
  // death / boom
  death:        ['audio/death/death.ogg'],
  heroDeath:    ['audio/death/hero_death.ogg'],
  explosion:    ['audio/death/explosion.ogg'],
  // weapons / cast
  shoot:        ['audio/cast/shoot.ogg'],
  weaponBurger: ['audio/cast/weapon_burger_a.ogg', 'audio/cast/weapon_burger_b.ogg'],
  weaponChain:  ['audio/cast/weapon_chain_a.ogg', 'audio/cast/weapon_chain_b.ogg'],
  weaponAutoaim:['audio/cast/weapon_autoaim_a.ogg', 'audio/cast/weapon_autoaim_b.ogg'],
  weaponBomb:   ['audio/cast/weapon_bomb.ogg'],
  weaponWeb:    ['audio/cast/weapon_web_a.ogg', 'audio/cast/weapon_web_b.ogg'],
  weaponDash:   ['audio/cast/weapon_dash.ogg'],
  // boss
  bossWarn:     ['audio/boss/boss_warn.ogg'],
  bossSpawnBell:['audio/boss/boss_spawn_bell.ogg'],   // layered components — sfx.bossSpawn() plays both
  bossSpawnRumble:['audio/boss/boss_spawn_rumble.ogg'],
  bossShockwave:['audio/boss/boss_shockwave.ogg'],
  // UI bouquet (iter 18) — 2 variants per bucket so menu navigation jitters
  // gracefully under the ±3% pitch shift. Kept low-gain at the call sites
  // (audio.js per-call gain, plus the sfx submaster) so they sit under combat.
  uiClick:      ['audio/ui/ui_click_a.ogg',   'audio/ui/ui_click_b.ogg'],
  uiCancel:     ['audio/ui/ui_cancel_a.ogg',  'audio/ui/ui_cancel_b.ogg'],
  uiHover:      ['audio/ui/ui_hover_a.ogg',   'audio/ui/ui_hover_b.ogg'],
  uiError:      ['audio/ui/ui_error_a.ogg',   'audio/ui/ui_error_b.ogg'],
  modalOpen:    ['audio/ui/modal_open_a.ogg', 'audio/ui/modal_open_b.ogg'],
  modalClose:   ['audio/ui/modal_close_a.ogg','audio/ui/modal_close_b.ogg'],
  // Forest stage SFX (Phase-2 Amber Interactable Agent hooks). All CC0 Kenney
  // (impact-sounds + sci-fi-sounds), processed to -16 LUFS to match the SFX
  // bus. See assets/audio/forest/ATTRIBUTION.md.
  crystalShatter:   ['audio/forest/crystal_shatter_a.ogg',
                     'audio/forest/crystal_shatter_b.ogg',
                     'audio/forest/crystal_shatter_c.ogg'],
  amberDetonation:  ['audio/forest/amber_detonation.ogg'],
  // Ascension Evolution chime (Punch List #1, 2026-05-16). Stage-agnostic
  // SFX layered with crystalShatter on weapon evolution. Manifest path is
  // intentionally absent (no `audio/fx/` directory in-tree) — `_play()`
  // drops on empty bank (line 304) so `sfx.evolutionChime()` is a graceful
  // no-op until the Kenney CC0 sample lands here.
  evolutionChime:   ['audio/fx/evolution_chime.ogg'],
  // Twilight stage SFX (Phase-2 Fountains Agent hooks). CC0 Kenney bell/glass/
  // forceField layers + synthesized gulp/water/crow elements (the Kenney packs
  // don't ship water/gulp samples). All -16 LUFS to match the SFX bus. See
  // assets/audio/twilight/ATTRIBUTION.md.
  fountainPour:        ['audio/twilight/fountain_pour.ogg'],
  fountainDrink:       ['audio/twilight/fountain_drink.ogg'],
  speedBoostActivate:  ['audio/twilight/speed_boost_activate.ogg'],
  // Cinder stage SFX (Phase-2 Ballistas Agent hooks). CC0 Kenney impact/scifi
  // layers (impactMetal_medium + impactPunch_medium for the cranking repair
  // loop; impactBell_heavy + forceField for the activation chime; lowFrequency
  // _explosion + thrusterFire for the bolt thunk + whoosh). All -16 LUFS to
  // match the SFX bus. See assets/audio/cinder/ATTRIBUTION.md.
  //
  // ballistaRepairLoop: 1.5s seamlessly-looped cranking+hammering. The Phase-2
  // Ballistas Agent should call sfx.ballistaRepairLoop() every ~1.4s during
  // the 10s repair window — slight overlap masks the seam and gives a
  // continuous mechanical feel. Implemented as a normal SFX bucket (no special
  // <audio loop=true> path) since the agent already tick()s; one less moving
  // part in the audio bus. The 30ms global throttle is well under 1.4s so
  // repeated agent calls land cleanly.
  ballistaRepairLoop:  ['audio/cinder/ballista_repair_loop.ogg'],
  ballistaActivate:    ['audio/cinder/ballista_activate.ogg'],
  ballistaFire:        ['audio/cinder/ballista_fire.ogg'],
  // Void stage SFX (Phase-2 Teleport Pads Agent hooks). CC0 Kenney layers
  // (forceField for the rift whoosh + shimmer; impactBell_heavy for the cyan
  // chime and the pad-ready bell) + a synthesized sub-bass cosmic drone in
  // the ambient. All -16 LUFS to match the SFX bus. See
  // assets/audio/void/ATTRIBUTION.md.
  //
  // voidTeleport: 0.95 s whoosh + chime. Plays ONCE per teleport — agent calls
  // it from the activation handler, not per pad (origin + destination share
  // the same sound per VOID_VISUAL_STYLE.md §Audio).
  voidTeleport:        ['audio/void/void_teleport.ogg'],
  // voidPadReady: 0.27 s subtle bell (inside VOID_VISUAL_STYLE.md §Audio
  // binding 0.2-0.3 s range — see ATTRIBUTION.md "Spec Notes" for the
  // task-brief-vs-style-guide reconciliation). Fires when a pad's 6 s
  // cooldown expires. Sample is short + tonally consistent so 2-3 plays
  // on the same frame (multiple pads coming off cooldown simultaneously)
  // layer gracefully through the sfx submaster without mudding.
  voidPadReady:        ['audio/void/void_pad_ready.ogg'],
};

const SFX_BANK = Object.fromEntries(Object.keys(SFX_MANIFEST).map(k => [k, []]));
let _samplesPrimed = false;

function _primeSamples() {
  if (_samplesPrimed) return;
  if (!_ctx) return;
  _samplesPrimed = true;
  // Resolve URLs relative to this module so GitHub Pages subpaths work.
  // ../assets/audio/... because audio.js lives in src/ and assets/ is its sibling.
  for (const [bucket, files] of Object.entries(SFX_MANIFEST)) {
    files.forEach(rel => {
      const url = new URL('../assets/' + rel, import.meta.url).href;
      fetch(url)
        .then(r => {
          if (!r.ok) throw new Error('http ' + r.status);
          return r.arrayBuffer();
        })
        .then(ab => _ctx.decodeAudioData(ab))
        .then(buf => { SFX_BANK[bucket].push(buf); })
        .catch(err => {
          // Don't kill the rest of the bank if one file 404s.
          console.warn('[audio] decode fail', rel, err && err.message);
        });
    });
  }
}

/**
 * Core sample player. Picks a random variant from the bucket, applies ±3%
 * pitch jitter, routes through the sfx submaster. Silently no-ops if the
 * bank is still decoding (first-shot tolerance).
 *
 *   _play(bucket, { gain: 0.6, rate: 1.0, delay: 0 })
 *
 *   gain  : per-call gain (the sfx submaster handles the master cut)
 *   rate  : extra playbackRate multiplier (e.g. pitch-shift a hit on crit)
 *   delay : scheduling offset in seconds (used by bossSpawn to layer the
 *           bell and rumble with a stagger)
 */
function _play(bucket, opts = {}) {
  if (!_enabled) return;
  const ctx = ensureCtx();
  if (ctx.state !== 'running') return;
  const bank = SFX_BANK[bucket];
  if (!bank || !bank.length) return;          // still decoding — drop, don't crash
  const buf = bank.length === 1 ? bank[0] : bank[Math.floor(Math.random() * bank.length)];
  const t = ctx.currentTime + Math.max(0, opts.delay || 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  // ±3% pitch jitter keeps rapid-fire repeats from sounding identical.
  src.playbackRate.value = (opts.rate != null ? opts.rate : 1) * (1 + (Math.random() - 0.5) * 0.06);
  const g = ctx.createGain();
  g.gain.value = (opts.gain != null ? opts.gain : 1);
  src.connect(g).connect(_sfxBus);
  src.start(t);
  // Auto-stop a generous window after buffer length to give Chrome a hint to
  // release the source node (buffer.duration may be undefined in odd edge
  // cases — Math.max guards it).
  src.stop(t + Math.max(0.05, (buf.duration || 0) + 0.05));
}

// ─── Throttle wrapper ────────────────────────────────────────────────────────
// Per-method minimum gap (ms). Calls inside the window are dropped silently —
// crucial because orbitals/chain often resolve multiple hits per frame.
const _lastCallAt = Object.create(null);
const THROTTLE_MS = 30;

function _throttled(key, fn) {
  return function (opts) {
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const last = _lastCallAt[key] || 0;
    if (now - last < THROTTLE_MS) return;
    _lastCallAt[key] = now;
    try { fn(opts); } catch (_) {}
  };
}

// ─── Public sfx ──────────────────────────────────────────────────────────────
// Volume design (relative loudness, all routed via the sfx submaster):
//   loud peaks  ~0.55-0.75  (bomb, bossSpawn, heroDeath, eliteDeath, victory)
//   medium      ~0.30-0.50  (weapons, enemyDeath, chestOpen, heroHurt)
//   pickups     ~0.18-0.30  (~−10 dB below the loud actions)
//   chatter     ~0.12-0.20  (enemyHurt — also throttled by callers)
//
// Bodies are one-liners over _play(bucket, {gain, rate}). Variants in the
// bucket are chosen at random; ±3% pitch jitter is applied automatically.
// Where audio.js used to layer multiple synth elements, we now either pre-
// layered them in the manifest (e.g. weaponBomb is a single bigger sample)
// OR sequence buffer plays here (bossSpawn = bell + rumble with stagger).
export const sfx = {
  // Submaster — exposed so callers / debug can mute the SFX bus independently.
  get _gain() { return _sfxBus; },

  // ── Generic / legacy ───────────────────────────────────────────────────────
  shoot:    _throttled('shoot',    () => _play('shoot',    { gain: 0.28 })),
  hit:      _throttled('hit',      () => _play('hit',      { gain: 0.40 })),
  pickup:   _throttled('pickup',   () => _play('pickup',   { gain: 0.26 })),
  levelUp:  _throttled('levelUp',  () => _play('levelUp',  { gain: 0.55 })),
  heroHit:  _throttled('heroHit',  () => _play('heroHit',  { gain: 0.45 })),
  death:    _throttled('death',    () => _play('death',    { gain: 0.55 })),
  explosion:_throttled('explosion',() => _play('explosion',{ gain: 0.55 })),
  // Not throttled — triumphant cadence is the whole point. One-shot sample.
  victory:  () => _play('victory', { gain: 0.70 }),
  // Single warning bell (audio.js used to triple-tap a sawtooth; the new
  // bell sample carries the urgency on its own).
  bossWarn: _throttled('bossWarn', () => _play('bossWarn', { gain: 0.45 })),

  // ── Weapon hooks ───────────────────────────────────────────────────────────
  weaponBurger:  _throttled('weaponBurger',  () => _play('weaponBurger',  { gain: 0.38 })),
  weaponChain:   _throttled('weaponChain',   () => _play('weaponChain',   { gain: 0.28 })),
  weaponAutoaim: _throttled('weaponAutoaim', () => _play('weaponAutoaim', { gain: 0.30 })),
  weaponBomb:    _throttled('weaponBomb',    () => _play('weaponBomb',    { gain: 0.65 })),
  weaponWeb:     _throttled('weaponWeb',     () => _play('weaponWeb',     { gain: 0.32 })),
  weaponDash:    _throttled('weaponDash',    () => _play('weaponDash',    { gain: 0.40 })),

  // ── Enemy reactions ────────────────────────────────────────────────────────
  // Iter 24a: gain + rate threadable via opts so damageEnemy can pass dmg-scaled
  // values. Throttle is preserved — the gain that lands is whichever call won
  // the 30ms throttle race, which is close enough for swarm combat.
  enemyHurt:  _throttled('enemyHurt',  (o) => _play('enemyHurt',  { gain: 0.20, ...(o || {}) })),
  enemyDeath: _throttled('enemyDeath', (o) => _play('enemyDeath', { gain: 0.40, ...(o || {}) })),
  eliteDeath: _throttled('eliteDeath', (o) => _play('eliteDeath', { gain: 0.55, ...(o || {}) })),

  // ── Hero reactions ─────────────────────────────────────────────────────────
  heroHurt:  _throttled('heroHurt',  (o) => _play('heroHurt',  { gain: 0.50, ...(o || {}) })),
  heroDeath: _throttled('heroDeath', () => _play('heroDeath', { gain: 0.70 })),

  // ── Pickups (sit ~−10 dB below loud actions; runtime gain is the budget) ───
  coinPickup:  _throttled('coinPickup',  () => _play('coinPickup',  { gain: 0.26 })),
  heartPickup: _throttled('heartPickup', () => _play('heartPickup', { gain: 0.30 })),
  starPickup:  _throttled('starPickup',  () => _play('starPickup',  { gain: 0.30 })),
  chestOpen:   _throttled('chestOpen',   () => _play('chestOpen',   { gain: 0.42 })),

  // ── Boss ───────────────────────────────────────────────────────────────────
  // Layered: bell on impact + rumble underneath. Web Audio handles the mixing
  // through the sfx submaster.
  bossSpawn: _throttled('bossSpawn', () => {
    _play('bossSpawnBell',   { gain: 0.65 });
    _play('bossSpawnRumble', { gain: 0.55, delay: 0.08 });
  }),
  bossShockwave: _throttled('bossShockwave', () => _play('bossShockwave', { gain: 0.55 })),

  // ── UI bouquet (iter 18) ───────────────────────────────────────────────────
  // Modal open/close intentionally lower-gain than clicks — they're "weight"
  // sounds that frame the click, not the click itself. uiHover uses a longer
  // throttle (separate from the 30ms default) so rapid mouseenter across a
  // row of cards doesn't machine-gun the bus.
  uiClick:    _throttled('uiClick',    () => _play('uiClick',    { gain: 0.45 })),
  uiCancel:   _throttled('uiCancel',   () => _play('uiCancel',   { gain: 0.40 })),
  uiError:    _throttled('uiError',    () => _play('uiError',    { gain: 0.55 })),
  modalOpen:  _throttled('modalOpen',  () => _play('modalOpen',  { gain: 0.55 })),
  modalClose: _throttled('modalClose', () => _play('modalClose', { gain: 0.50 })),
  // Hover has its own 100ms debounce on top of the per-call throttle so
  // dragging across a row of buttons doesn't fire on every microtick.
  uiHover:    (() => {
    let _lastHover = 0;
    const HOVER_DEBOUNCE_MS = 100;
    return () => {
      const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      if (now - _lastHover < HOVER_DEBOUNCE_MS) return;
      _lastHover = now;
      _play('uiHover', { gain: 0.22 });
    };
  })(),

  // ── Forest stage (Phase-2 Amber Interactable Agent hooks) ──────────────────
  // Crystal shatters fire on any amber interaction destruction (incl. chain-
  // hits from other amber). 3 random variants + ±3% pitch jitter so a chain
  // detonation sequence doesn't sound mechanical. Throttled 30ms — multiple
  // shatters in a single frame collapse to one audible event.
  crystalShatter:   _throttled('crystalShatter',   () => _play('crystalShatter',   { gain: 0.45 })),
  // Amber detonation — louder than shatter (this is the primary boom). One
  // sample for now; agent can layer multiple amber detonations via the timing
  // it already controls (8-12 shards + 0.6s shockwave timeline).
  amberDetonation:  _throttled('amberDetonation',  () => _play('amberDetonation',  { gain: 0.65 })),
  // Ascension Evolution chime (Punch List #1) — stage-agnostic. Bank is
  // empty until the Kenney CC0 sample ships; `_play` no-ops cleanly so
  // callers don't need to feature-detect (see `evolutionChime` manifest).
  evolutionChime:   _throttled('evolutionChime',   () => _play('evolutionChime',   { gain: 0.55 })),

  // ── Twilight stage (Phase-2 Fountains Agent hooks) ─────────────────────────
  // Fountain pour layers the 0.6s drink animation; fountain drink chime fires
  // at t=0.6 of the drink anim (aura activation moment). Speed-boost activate
  // is a one-shot whoosh+shimmer for the slot-8 aura ring spawn. All throttled
  // 30ms — proximity-triggered drinks shouldn't double-fire on a single tick.
  fountainPour:       _throttled('fountainPour',       () => _play('fountainPour',       { gain: 0.38 })),
  fountainDrink:      _throttled('fountainDrink',      () => _play('fountainDrink',      { gain: 0.50 })),
  speedBoostActivate: _throttled('speedBoostActivate', () => _play('speedBoostActivate', { gain: 0.55 })),

  // ── Cinder stage (Phase-2 Ballistas Agent hooks) ───────────────────────────
  // Repair loop: agent calls every ~1.4s during the 10s repair window. The
  // sample is 1.5s seamless, so consecutive ~1.4s plays overlap ~0.1s — the
  // overlap masks the loop seam and keeps the cranking feel continuous. Sits
  // medium-quiet (0.32) so it doesn't drown out combat SFX during the window.
  ballistaRepairLoop: _throttled('ballistaRepairLoop', () => _play('ballistaRepairLoop', { gain: 0.32 })),
  // Activation chime: louder (0.62) — this is the power-fantasy reward moment
  // at t=10. One-shot, not throttled in a way the player can hear (30ms is
  // imperceptible; double-fire would be a real audible defect).
  ballistaActivate:   _throttled('ballistaActivate',   () => _play('ballistaActivate',   { gain: 0.62 })),
  // Fire: punchy (0.55) so 2-3 simultaneous bolts (4-6 active ballistas firing
  // every 2s) don't mud the mix. Sample is short (0.65s) to leave dynamic
  // headroom for overlapping plays through the SFX submaster.
  ballistaFire:       _throttled('ballistaFire',       () => _play('ballistaFire',       { gain: 0.55 })),

  // ── Void stage (Phase-2 Teleport Pads Agent hooks) ────────────────────────
  // voidTeleport: WHOOSH + chime on rift activation. Single hit per teleport
  // (origin + destination share the one sound per VOID_VISUAL_STYLE.md §Audio
  // — Pads Agent must call this exactly once per teleport, not once per pad).
  // Gain 0.55 — punchy but not startling; fires often enough across a run
  // that it can't be a jump-scare.
  voidTeleport: _throttled('voidTeleport', () => _play('voidTeleport', { gain: 0.55 })),
  // voidPadReady: subtle bell when a pad's 6 s cooldown expires. ~−6 dB below
  // voidTeleport (0.28 vs 0.55) so it reads as diegetic "this pad is usable
  // again" feedback, not a UI ping. Throttle drops same-frame double-fires;
  // if multiple pads come off cooldown on a single tick the sample's
  // short tonal profile keeps the layered mix clean.
  voidPadReady: _throttled('voidPadReady', () => _play('voidPadReady', { gain: 0.28 })),
};

// ─────────────────────────────────────────────────────────────────────────────
// Procedural music: a bass-drone loop that ramps intensity with difficulty.
// One oscillator per voice, scheduled in 8-beat bars at ~110bpm.
// ─────────────────────────────────────────────────────────────────────────────
let _musicPlaying = false;
let _musicTier = 0;            // 0=calm, 1=combat, 2=boss
let _musicTimer = null;
let _beat = 0;

// Pentatonic minor in A — guaranteed not-sour. Bass notes drive the loop.
const A_MINOR_PENT = [110, 131, 147, 165, 196, 220, 262, 294]; // A2..D4

function playNote(f, dur, type, vol) {
  if (!_enabled || !_ctx) return;
  if (_ctx.state !== 'running') return;
  const t = _ctx.currentTime;
  const osc = _ctx.createOscillator();
  const g = _ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f, t);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  // Route music through the music submaster so it tracks Music Volume slider.
  osc.connect(g).connect(_musicBus);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function _musicStep() {
  if (!_musicPlaying) return;
  const tier = _musicTier;
  // Beat 0 of each bar: bass root pulse
  if (_beat % 8 === 0) {
    playNote(A_MINOR_PENT[0], 0.45, 'sawtooth', 0.10 + tier * 0.05);
  }
  // Beat 4: fifth
  if (_beat % 8 === 4) {
    playNote(A_MINOR_PENT[4], 0.35, 'sawtooth', 0.08 + tier * 0.05);
  }
  // Combat tier+ : melody on every odd beat
  if (tier >= 1 && _beat % 2 === 1) {
    const pick = A_MINOR_PENT[3 + ((_beat * 7) % 5)];
    playNote(pick, 0.20, 'triangle', 0.05 + tier * 0.04);
  }
  // Boss tier: low rumble on every beat
  if (tier >= 2) {
    playNote(55, 0.30, 'sawtooth', 0.10);
    if (_beat % 4 === 2) playNote(A_MINOR_PENT[1] * 2, 0.18, 'square', 0.07);
  }
  _beat++;
}

export function startMusic() {
  if (_musicPlaying) return;
  ensureCtx();
  _musicPlaying = true;
  _beat = 0;
  const bpm = 110;
  const stepMs = (60 / bpm) * 1000 / 2;  // 8th notes
  _musicTimer = setInterval(_musicStep, stepMs);
}

export function stopMusic() {
  _musicPlaying = false;
  if (_musicTimer) { clearInterval(_musicTimer); _musicTimer = null; }
}

/** tier: 0=calm, 1=combat, 2=boss */
export function setMusicTier(tier) {
  _musicTier = Math.max(0, Math.min(2, tier | 0));
}

/**
 * Public dispatcher: external systems (spawnDirector / main loop) push
 * combat-pressure signals; we map them to music tiers.
 *
 *   activeBosses == 0 + D <= 20s  → calm   (tier 0)
 *   activeBosses == 0 + D >  20s  → combat (tier 1)
 *   activeBosses >= 1 (mini)      → combat (tier 1)
 *   activeBosses >= 1 (final)     → boss   (tier 2)
 *
 * `activeBosses` may be a number (count) OR a string ('mini'|'final'). We
 * treat strings as the higher-priority signal so callers can pass shape-y
 * descriptors without juggling counts.
 */
export function notifyCombatPressure(activeBosses, D) {
  let tier = 0;
  const time = Number(D) || 0;
  if (typeof activeBosses === 'string') {
    if (activeBosses === 'final') tier = 2;
    else if (activeBosses === 'mini') tier = 1;
    else if (activeBosses === 'none') tier = time > 20 ? 1 : 0;
  } else {
    const n = Number(activeBosses) || 0;
    if (n >= 1) tier = 1;       // any boss alive → combat
    if (n >= 2) tier = 2;       // multiple bosses → boss tier
    if (n === 0 && time > 20) tier = 1;
  }
  setMusicTier(tier);
}

// ─────────────────────────────────────────────────────────────────────────────
// Menu / town / interior ambient bed — a quiet drone that gives non-combat
// modes a sense of place. Routed through _musicBus so it tracks Music Volume.
// ─────────────────────────────────────────────────────────────────────────────
let _menuBedPlaying = false;
let _menuBedTimer = null;
let _menuBedBeat = 0;

function _menuBedStep() {
  if (!_menuBedPlaying) return;
  // Low pad: A1 + E2 alternating, very low gain. The melody hint on every 4
  // beats gives the bed a slow heartbeat without ever feeling like combat.
  if (_menuBedBeat % 8 === 0) playNote(55,  1.4, 'sine', 0.05);
  if (_menuBedBeat % 8 === 4) playNote(82,  1.0, 'sine', 0.04);
  if (_menuBedBeat % 16 === 2) playNote(220, 0.8, 'triangle', 0.025);
  _menuBedBeat++;
}

/**
 * Start a low-volume ambient drone for menu / town / interior modes. Safe to
 * call repeatedly — no-op if already playing. Audio context must be unlocked
 * first (the mode poller waits for that).
 */
export function playMenuBed() {
  if (_menuBedPlaying) return;
  if (!_ctx || _ctx.state !== 'running') return;
  _menuBedPlaying = true;
  _menuBedBeat = 0;
  // 70 BPM × 8th notes ≈ 428ms per step. Slow.
  _menuBedTimer = setInterval(_menuBedStep, 428);
}

export function stopMenuBed() {
  _menuBedPlaying = false;
  if (_menuBedTimer) { clearInterval(_menuBedTimer); _menuBedTimer = null; }
}

// ── Mode poll: turn the menu bed on/off based on `state.mode` ────────────────
// We can't subscribe to state.mode mutations (they happen in town/interior/
// catacomb which we don't own), so a tiny 500ms poll keeps the bed in sync.
// Started from unlockAudio() — never fires before the user gestures.
function _startModePoll() {
  if (_modePollTimer) return;
  _modePollTimer = setInterval(() => {
    if (!_ctx) return;
    let mode = 'menu';
    try {
      if (state && typeof state.mode === 'string') mode = state.mode;
    } catch (_) {}
    const shouldPlay = (mode === 'menu' || mode === 'town' || mode === 'interior');
    if (shouldPlay && !_menuBedActive) {
      _menuBedActive = true;
      playMenuBed();
    } else if (!shouldPlay && _menuBedActive) {
      _menuBedActive = false;
      stopMenuBed();
    }
  }, 500);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage ambient bed — long looping ambient track for combat stages (Forest is
// first; cinder/twilight/void can plug in similarly later). Uses an
// HTMLAudioElement.loop = true piped through MediaElementSource into
// _musicBus so it tracks Music Volume AND avoids re-decoding the 186KB buffer
// on every play. Different from menuBed (procedural) and SFX_BANK (one-shots).
//
// The Forest ambient is a 40s seamless loop (cross-faded head/tail) — playing
// it via <audio loop=true> is cheap and Chrome handles the wrap natively.
// ─────────────────────────────────────────────────────────────────────────────
const STAGE_AMBIENT_URLS = {
  forest: 'audio/forest/forest_ambient.ogg',
  twilight: 'audio/twilight/twilight_ambient.ogg',
  cinder: 'audio/cinder/cinder_ambient.ogg',
  void: 'audio/void/void_ambient.ogg',
};
let _stageAmbient = null;        // { stageId, el, srcNode, gainNode }

function _stopStageAmbient() {
  if (!_stageAmbient) return;
  try { _stageAmbient.el.pause(); } catch (_) {}
  try { _stageAmbient.srcNode.disconnect(); } catch (_) {}
  try { _stageAmbient.gainNode.disconnect(); } catch (_) {}
  _stageAmbient = null;
}

/**
 * Start (or swap) the looping ambient bed for a stage. Call from the stage-
 * load path (main.js loadArenaDecor sibling). No-op if the same stage is
 * already playing. Call with stageId=null to stop the bed entirely.
 *
 * Safe to call before unlockAudio() — defers until the ctx is alive. Routes
 * through _musicBus so Music Volume slider controls it.
 */
export function playStageAmbient(stageId) {
  // Stop if no/unsupported stage requested.
  if (!stageId || !STAGE_AMBIENT_URLS[stageId]) {
    _stopStageAmbient();
    return;
  }
  // Already on this stage? leave it alone.
  if (_stageAmbient && _stageAmbient.stageId === stageId) return;

  // Need a live audio context to wire MediaElementSource into _musicBus.
  // If we don't have one yet (no user gesture), defer until unlockAudio
  // surfaces a running ctx. main.js calls unlockAudio on first gesture.
  ensureCtx();
  if (!_ctx || _ctx.state === 'closed') return;

  _stopStageAmbient();

  const url = new URL('../assets/' + STAGE_AMBIENT_URLS[stageId], import.meta.url).href;
  const el = new Audio(url);
  el.loop = true;
  el.preload = 'auto';
  // Slightly under unity so the source's -22 LUFS sits comfortably below
  // the procedural music tier even when both are active.
  el.volume = 1.0;

  let srcNode;
  try {
    srcNode = _ctx.createMediaElementSource(el);
  } catch (err) {
    // Some browsers throw if the element was already attached. Bail safely.
    console.warn('[audio] stage ambient source create fail', err && err.message);
    return;
  }
  const gainNode = _ctx.createGain();
  gainNode.gain.value = 0.55;  // bed gain — sits under SFX + procedural music
  srcNode.connect(gainNode).connect(_musicBus);

  _stageAmbient = { stageId, el, srcNode, gainNode };

  // Play. If ctx is suspended (rare here — we'd have bailed above) browser
  // policy will throw an unmuted-autoplay error; catch + retry on next
  // unlockAudio call by stashing the intent.
  const playPromise = el.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch((err) => {
      // Most common: ctx not yet resumed. The next unlockAudio call will
      // resume it; we replay then.
      console.warn('[audio] stage ambient autoplay deferred', err && err.message);
    });
  }
}

/** Stop the current stage ambient bed. Idempotent. */
export function stopStageAmbient() {
  _stopStageAmbient();
}

// ── Visibility helpers ───────────────────────────────────────────────────────
// main.js owns the visibilitychange listener; these helpers do the audio side.

/** Suspend the audio context. Idempotent. */
export function suspendAudio() {
  if (_ctx && _ctx.state === 'running' && typeof _ctx.suspend === 'function') {
    try { _ctx.suspend(); } catch (_) {}
  }
  // While suspended, the menuBed setInterval would still fire but playNote()
  // bails on ctx.state !== 'running'. We pause the menuBed loop anyway so it
  // resumes cleanly on focus return.
  stopMenuBed();
  _menuBedActive = false;
  // Pause the stage ambient HTMLAudioElement so it doesn't keep buffering
  // through the muted-tab window. The ctx-suspend would mute it anyway, but
  // the element's playback clock keeps advancing — pause is cleaner.
  if (_stageAmbient && _stageAmbient.el) {
    try { _stageAmbient.el.pause(); } catch (_) {}
  }
}

/** Resume the audio context + restart menuBed if mode warrants it. */
export function resumeAudio() {
  if (_ctx && _ctx.state === 'suspended' && typeof _ctx.resume === 'function') {
    try { _ctx.resume(); } catch (_) {}
  }
  // Next mode-poll tick will retrigger the bed for menu/town/interior.
  _startModePoll();
  // Resume the stage ambient if one was active before the tab blur.
  if (_stageAmbient && _stageAmbient.el && _stageAmbient.el.paused) {
    const p = _stageAmbient.el.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }
}
