/**
 * Procedural audio via Web Audio API. Minimal: no audio files needed.
 *
 * Layout (iter 10a):
 *   _ctx ─► _master ─► destination
 *               ▲
 *       _musicBus (music + ambient bed)
 *       _sfxBus   (combat sfx submaster)
 *
 * - `_master` is the master gain; `setMasterVolume` writes to it.
 * - `_musicBus` carries procedural music + menu/town/interior ambient bed.
 *   `setMusicVolume` writes to it.
 * - `_sfxBus` carries combat/UI SFX. `setSfxVolume` writes to it.
 * - Legacy `setVolume(v)` is a deprecated shim mapping to `setMasterVolume`.
 * - Every sfx.* is throttled: a 30ms minimum gap per-method prevents layering
 *   when e.g. an orbital hits 5 enemies in one frame.
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

// ─── Legacy helpers (kept for back-compat; route through _musicBus) ──────────
// These three were previously wired to _master. After the iter-10a split they
// route through _musicBus so they participate in music-volume control. No
// in-tree caller invokes them today (all SFX go through sxTone/sxNoiseBurst),
// but keeping the helpers means future melodic ambient nudges land in the
// music bus by default.

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

// ─── New synth library: routes through the SFX submaster ─────────────────────

/** Tone routed through the sfx submaster. dur in seconds. */
function sxTone(freq, duration, type = 'triangle', vol = 1) {
  if (!_enabled) return;
  const ctx = ensureCtx();
  if (ctx.state !== 'running') return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(g).connect(_sfxBus);
  osc.start(t);
  osc.stop(t + duration + 0.02);
}

/** Noise burst routed through the sfx submaster. */
function sxNoiseBurst(duration, vol = 1, opts = {}) {
  if (!_enabled) return;
  const ctx = ensureCtx();
  if (ctx.state !== 'running') return;
  const t = ctx.currentTime;
  const buf = ctx.createBuffer(1, Math.max(1, ctx.sampleRate * duration), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.7;
  const src = ctx.createBufferSource(); src.buffer = buf;
  const filt = ctx.createBiquadFilter();
  filt.type = opts.filterType || 'lowpass';
  filt.frequency.value = opts.cutoff || 1200;
  if (opts.q != null) filt.Q.value = opts.q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  src.connect(filt).connect(g).connect(_sfxBus);
  src.start(t);
  src.stop(t + duration + 0.02);
}

/** Pitch sweep routed through the sfx submaster. */
function sxPitchSweep(fromHz, toHz, duration, vol = 1, type = 'square') {
  if (!_enabled) return;
  const ctx = ensureCtx();
  if (ctx.state !== 'running') return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(fromHz, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, toHz), t + duration);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(g).connect(_sfxBus);
  osc.start(t);
  osc.stop(t + duration + 0.02);
}

// ─── Throttle wrapper ────────────────────────────────────────────────────────
// Per-method minimum gap (ms). Calls inside the window are dropped silently —
// crucial because orbitals/chain often resolve multiple hits per frame.
const _lastCallAt = Object.create(null);
const THROTTLE_MS = 30;

function _throttled(key, fn) {
  return function () {
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const last = _lastCallAt[key] || 0;
    if (now - last < THROTTLE_MS) return;
    _lastCallAt[key] = now;
    try { fn(); } catch (_) {}
  };
}

// ─── Public sfx ──────────────────────────────────────────────────────────────
// Volume design (relative loudness, all routed via the sfx submaster):
//   loud peaks  ~0.55-0.70  (bomb, bossSpawn, heroDeath, eliteDeath)
//   medium      ~0.30-0.45  (weapons, enemyDeath, chestOpen, heroHurt)
//   pickups     ~0.16-0.22  (~−15 dB below the loud actions)
//   chatter     ~0.10-0.18  (enemyHurt — also throttled by callers)
export const sfx = {
  // Submaster — exposed so callers / debug can mute the SFX bus independently.
  get _gain() { return _sfxBus; },

  // ── Legacy hooks (kept so existing call sites don't break) ─────────────────
  shoot:    _throttled('shoot',    () => sxPitchSweep(880, 220, 0.10, 0.20, 'square')),
  hit:      _throttled('hit',      () => { sxTone(180, 0.08, 'square', 0.30); sxNoiseBurst(0.06, 0.20, { cutoff: 800 }); }),
  pickup:   _throttled('pickup',   () => sxPitchSweep(660, 1320, 0.08, 0.22, 'triangle')),
  levelUp:  _throttled('levelUp',  () => { sxPitchSweep(330, 880, 0.18, 0.40, 'triangle'); setTimeout(() => sxPitchSweep(440, 1320, 0.18, 0.40, 'triangle'), 70); }),
  heroHit:  _throttled('heroHit',  () => { sxPitchSweep(440, 110, 0.18, 0.40, 'sawtooth'); sxNoiseBurst(0.10, 0.25, { cutoff: 600 }); }),
  death:    _throttled('death',    () => { sxPitchSweep(330, 60, 0.6, 0.50, 'sawtooth'); sxNoiseBurst(0.5, 0.30, { cutoff: 400 }); }),
  explosion:_throttled('explosion',() => { sxNoiseBurst(0.25, 0.45, { cutoff: 500 }); sxPitchSweep(220, 60, 0.25, 0.38, 'sawtooth'); }),
  victory:  () => {
    // Not throttled — triumphant cadence is the whole point.
    const notes = [392, 523, 659, 784, 1047];
    notes.forEach((f, i) => setTimeout(() => sxPitchSweep(f * 0.5, f, 0.25, 0.45, 'triangle'), i * 100));
    setTimeout(() => sxPitchSweep(1047, 1568, 0.6, 0.55, 'triangle'), 600);
  },
  bossWarn: _throttled('bossWarn', () => {
    [220, 220, 220].forEach((f, i) => setTimeout(() => sxTone(f, 0.18, 'sawtooth', 0.35), i * 180));
  }),

  // ── Weapon hooks ───────────────────────────────────────────────────────────
  weaponBurger: _throttled('weaponBurger', () => {
    // Soft thud — orbital body-check
    sxTone(140, 0.06, 'sine', 0.28);
    sxNoiseBurst(0.05, 0.10, { cutoff: 500 });
  }),
  weaponChain: _throttled('weaponChain', () => {
    // Quick zap, two stacked tones for that electric "shing"
    sxPitchSweep(1400, 700, 0.10, 0.18, 'square');
    sxPitchSweep(2100, 1050, 0.10, 0.12, 'sawtooth');
  }),
  weaponAutoaim: _throttled('weaponAutoaim', () => {
    // Pop + sweep
    sxTone(900, 0.02, 'square', 0.22);
    sxPitchSweep(700, 1400, 0.08, 0.18, 'triangle');
  }),
  weaponBomb: _throttled('weaponBomb', () => {
    // Big low boom, noise + low sweep
    sxNoiseBurst(0.55, 0.55, { cutoff: 380 });
    sxPitchSweep(180, 40, 0.60, 0.55, 'sawtooth');
    sxTone(60, 0.40, 'sine', 0.45);
  }),
  weaponWeb: _throttled('weaponWeb', () => {
    // Slow pluck
    sxPitchSweep(420, 220, 0.14, 0.24, 'triangle');
  }),
  weaponDash: _throttled('weaponDash', () => {
    // Whoosh — band-pass-like noise sweep via two filtered bursts
    sxNoiseBurst(0.20, 0.35, { filterType: 'bandpass', cutoff: 1400, q: 1.2 });
    sxPitchSweep(900, 240, 0.20, 0.10, 'sawtooth');
  }),

  // ── Enemy reactions ────────────────────────────────────────────────────────
  enemyHurt: _throttled('enemyHurt', () => {
    // Thin crit-like tone
    sxTone(1600, 0.05, 'square', 0.14);
  }),
  enemyDeath: _throttled('enemyDeath', () => {
    // Short noise + thud
    sxNoiseBurst(0.10, 0.30, { cutoff: 900 });
    sxTone(200, 0.10, 'square', 0.28);
  }),
  eliteDeath: _throttled('eliteDeath', () => {
    // Bigger, glittery
    sxNoiseBurst(0.20, 0.40, { cutoff: 1100 });
    sxPitchSweep(220, 80, 0.40, 0.45, 'sawtooth');
    setTimeout(() => sxPitchSweep(1200, 2400, 0.18, 0.20, 'triangle'), 60);
    setTimeout(() => sxPitchSweep(1600, 2800, 0.14, 0.16, 'triangle'), 140);
  }),

  // ── Hero reactions ─────────────────────────────────────────────────────────
  heroHurt: _throttled('heroHurt', () => {
    // Low buzz
    sxTone(180, 0.18, 'sawtooth', 0.40);
    sxNoiseBurst(0.10, 0.22, { cutoff: 700 });
  }),
  heroDeath: _throttled('heroDeath', () => {
    // Long descending sweep
    sxPitchSweep(440, 50, 1.20, 0.55, 'sawtooth');
    sxNoiseBurst(0.80, 0.30, { cutoff: 400 });
    setTimeout(() => sxPitchSweep(220, 30, 0.60, 0.40, 'sawtooth'), 400);
  }),

  // ── Pickups (sit ~−15 dB below loud actions) ───────────────────────────────
  coinPickup: _throttled('coinPickup', () => {
    // Bright ding
    sxTone(1320, 0.05, 'triangle', 0.20);
    setTimeout(() => sxTone(1760, 0.08, 'triangle', 0.18), 25);
  }),
  heartPickup: _throttled('heartPickup', () => {
    // Warm two-note arpeggio
    sxTone(523, 0.12, 'triangle', 0.22);
    setTimeout(() => sxTone(784, 0.18, 'triangle', 0.22), 70);
  }),
  starPickup: _throttled('starPickup', () => {
    // Sparkle: noise + high tone + glitter
    sxNoiseBurst(0.06, 0.12, { filterType: 'highpass', cutoff: 4000 });
    sxTone(1760, 0.10, 'triangle', 0.20);
    setTimeout(() => sxTone(2349, 0.10, 'triangle', 0.18), 60);
  }),
  chestOpen: _throttled('chestOpen', () => {
    // Wood thunk + sparkle
    sxTone(180, 0.10, 'square', 0.35);
    sxNoiseBurst(0.08, 0.20, { cutoff: 700 });
    setTimeout(() => {
      sxTone(1568, 0.12, 'triangle', 0.22);
      sxTone(2093, 0.14, 'triangle', 0.18);
    }, 90);
  }),

  // ── Boss ───────────────────────────────────────────────────────────────────
  bossSpawn: _throttled('bossSpawn', () => {
    // Low rumble + scary stab
    sxNoiseBurst(0.90, 0.45, { cutoff: 220 });
    sxPitchSweep(80, 40, 0.90, 0.55, 'sawtooth');
    setTimeout(() => {
      sxTone(110, 0.25, 'sawtooth', 0.50);
      sxTone(146, 0.25, 'sawtooth', 0.40);
    }, 250);
  }),
  bossShockwave: _throttled('bossShockwave', () => {
    // Fast low whoosh
    sxNoiseBurst(0.18, 0.45, { filterType: 'bandpass', cutoff: 600, q: 0.8 });
    sxPitchSweep(320, 80, 0.20, 0.35, 'sawtooth');
  }),
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
}

/** Resume the audio context + restart menuBed if mode warrants it. */
export function resumeAudio() {
  if (_ctx && _ctx.state === 'suspended' && typeof _ctx.resume === 'function') {
    try { _ctx.resume(); } catch (_) {}
  }
  // Next mode-poll tick will retrigger the bed for menu/town/interior.
  _startModePoll();
}
