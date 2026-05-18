/**
 * PHASE 1 P1B — Achievement chain (swarm/forest-achievements)
 *
 * Adds 14 new achievement IDs covering kill milestones, boss kills, exploration,
 * progression, mastery, and survival. Persistent meta tracking, slide-in toast
 * on unlock, and a title-screen panel listing all unlocked.
 *
 * The existing meta.js infrastructure (ACHIEVEMENTS array, unlockAchievement(),
 * meta.achievements map, the older top-right toast in ui.js) is left untouched.
 * This module:
 *   - registers a parallel ACH_DEFS list (only IDs new to this PR),
 *   - writes the new schema `{ unlockedAt: ISOString, count: 1 }` into the
 *     shared `meta.achievements` map (truthy entry = unlocked, both shapes),
 *   - renders its own gold-bordered bottom-right toast (4s slide),
 *   - exposes a title-screen `mountTitlePanel()` for menuV2.
 *
 * Public API:
 *   loadAchievements()       — boot-time wiring. Idempotent.
 *   tickAchievements(state)  — per-frame check loop. Cheap when unlocked.
 *   unlockAchievement(id)    — direct dispatch (called from tick + event hooks).
 *   getAchievements()        — returns the def list (for menuV2 panel).
 *   mountTitlePanel(parent)  — appends the title-screen indicator + click→modal.
 *   disposeAchievements()    — tears down DOM (toast queue, modal).
 *
 * Implementation notes / contract decisions documented inline.
 */

import { getMeta, saveMeta, unlockAvatar, isAvatarUnlocked } from './meta.js';
import { AVATARS } from './config.js';
import { sfx } from './audio.js';

// ── Achievement definitions ──────────────────────────────────────────────────
// 16 IDs (well over the 12-15 contract target). Each has:
//   id        — unique string, written into meta.achievements
//   name      — toast/panel title
//   desc      — toast/panel description (one line)
//   category  — grouping for panel ('Kills' / 'Bosses' / 'Exploration' /
//               'Progression' / 'Mastery' / 'Survival')
// The contract listed 17 candidate IDs; we ship 16. The one omitted ID is
// `first_elite`, which already exists in the legacy meta.js ACHIEVEMENTS
// array and is already fired from enemies.js. Reusing that wiring avoids a
// double-toast on elite kills. See FINAL REPORT in commit body.
const ACH_DEFS = [
  // Kills
  { id: 'kill_50',           name: 'Bloodied Paws',     desc: 'Kill 50 enemies in a run',     category: 'Kills' },
  { id: 'kill_250',          name: 'Field of Bone',     desc: 'Kill 250 enemies in a run',    category: 'Kills' },
  { id: 'kill_1000',         name: 'Reaper of Reapers', desc: 'Kill 1000 enemies in a run',   category: 'Kills' },
  // Bosses
  { id: 'first_miniboss',    name: 'Big-Game Hunter',   desc: 'Kill your first miniboss',     category: 'Bosses' },
  { id: 'reaper_outlasted',  name: 'Outlasted Death',   desc: 'Outlast the Reaper (35:00)',   category: 'Bosses' },
  // Exploration
  { id: 'all_rooms_visited', name: 'Cartographer',      desc: 'Visit all 7 forest rooms',     category: 'Exploration' },
  { id: 'chest_x5',          name: 'Five-Finger Discount', desc: 'Open 5 chests in a run',    category: 'Exploration' },
  { id: 'coffin_x1',         name: 'Pall-Bearer',       desc: 'Open 1 evolution coffin',      category: 'Exploration' },
  // Progression
  { id: 'time_10min',        name: 'Steady Pace',       desc: 'Reach 10:00 stage time',       category: 'Progression' },
  { id: 'time_20min',        name: 'Long Haul',         desc: 'Reach 20:00 stage time',       category: 'Progression' },
  { id: 'time_30min',        name: 'The Reaper Cometh', desc: 'Survive to 30:00',             category: 'Progression' },
  // Mastery
  { id: 'weapon_l8',         name: 'Maxed Out',         desc: 'Level a weapon to L8',         category: 'Mastery' },
  { id: 'weapon_evolved',    name: 'Coffin Awakening',  desc: 'Evolve a weapon via coffin',   category: 'Mastery' },
  { id: 'weapons_5_kit',     name: 'Full Arsenal',      desc: 'Carry 5 weapons at once',      category: 'Mastery' },
  // Survival
  { id: 'no_hit_60s',        name: 'Untouchable Minute',desc: 'Take no damage for the first 60s', category: 'Survival' },
  { id: 'full_hp_5min',      name: 'Picture of Health', desc: 'Stay at full HP for 5 cumulative minutes', category: 'Survival' },
  // PHASE 4 P4F (#144, 2026-05-18) — Char-unlock gating achievements.
  // Three forest avatars (rune/mire/shroud kitten) are gated on these:
  //   no_hit_clear      → Rune Kitten
  //   rings_dodged_100  → Mire Kitten
  //   reaper_outlasted  → Shroud Kitten (existing — see Bosses)
  // The avatar unlock fires from _maybeUnlockAvatarFor() below, called inside
  // unlockAchievement() on the first-lifetime write path.
  { id: 'no_hit_clear',      name: 'Untouched Victory', desc: 'Win a forest run without taking any damage', category: 'Survival' },
  { id: 'rings_dodged_100',  name: 'Ring Reader',       desc: 'Dodge 100 mushroom-ring puffs',             category: 'Survival' },
];

// Quick id→def lookup (built once, no per-tick allocation).
const ACH_BY_ID = {};
for (const def of ACH_DEFS) ACH_BY_ID[def.id] = def;

// Evolved-weapon ids — anything in this list satisfies weapon_evolved.
// Mirrors the FOREST_SPECIAL_IDS subset that represents coffin-evolved
// superweapons (chain_storm, frost_eternal). Inst.evolved is also checked.
const EVOLVED_WEAPON_IDS = new Set(['chain_storm', 'frost_eternal']);

// Visible kit cap (matches forestWeaponDrops.KIT_VISIBLE_CAP). Hidden Forest
// specials + coffin evolutions sit in state.weapons but don't count against
// the player's slot budget — same logic as _visibleKitCount() upstream.
function _visibleKitCount(weapons, registry) {
  if (!weapons) return 0;
  let n = 0;
  for (let i = 0; i < weapons.length; i++) {
    const id = weapons[i] && weapons[i].id;
    const mod = registry && id ? registry[id] : null;
    if (mod && mod.hidden === true) continue;
    n++;
  }
  return n;
}

// ── Toast pipeline ───────────────────────────────────────────────────────────
// Slide-in from bottom-right, 4s display, 0.3s slide. Queue back-to-back
// unlocks so 3 simultaneous unlocks → ~12s total visible time. z-index 60
// (above gameplay flashes, below the modal).

const TOAST_DURATION_MS  = 4000;
const TOAST_SLIDE_MS     = 300;
const PALETTE_GOLD       = '#ffd86b';   // slot-7 gold border
const PALETTE_DARK_BG    = '#4a3220';   // slot-4 dark
const PALETTE_BONE       = '#c7b89a';   // slot-1 bone text

let _toastQueue   = [];
let _toastActive  = null;
let _toastTimerId = 0;
let _wired        = false;

function _ensureToastHost() {
  // Mount under #ui-root so it tears down with the rest of the UI on reset.
  // Fallback to body if #ui-root is missing (e.g. early boot frame).
  return document.getElementById('ui-root') || document.body || null;
}

function _renderToast(def) {
  if (typeof document === 'undefined') return null;
  const host = _ensureToastHost();
  if (!host) return null;

  const el = document.createElement('div');
  el.className = 'kk-ach-toast';
  el.style.cssText = `
    position: fixed;
    right: 20px;
    bottom: 20px;
    min-width: 260px;
    max-width: min(360px, 90vw);
    padding: 12px 16px;
    background: ${PALETTE_DARK_BG};
    border: 2px solid ${PALETTE_GOLD};
    border-radius: 6px;
    color: ${PALETTE_BONE};
    font-family: "Cinzel", "Cormorant Garamond", Georgia, serif;
    font-size: 13px;
    line-height: 1.45;
    letter-spacing: 0.04em;
    box-shadow: 0 6px 18px rgba(0,0,0,0.55), 0 0 12px rgba(255,216,107,0.18);
    pointer-events: none;
    z-index: 60;
    transform: translateX(120%);
    transition: transform ${TOAST_SLIDE_MS}ms ease-out;
  `;

  const title = document.createElement('div');
  title.style.cssText = `color:${PALETTE_GOLD};font-weight:700;letter-spacing:0.18em;text-transform:uppercase;font-size:11px;margin-bottom:4px;`;
  // PHASE 4 P4F (#144) — avatar-unlock variant uses a different title prefix
  // so the player can tell a character unlock from an achievement unlock.
  // Same palette / chime / slide animation as the achievement toast so the
  // visual language stays unified.
  if (def && def._kind === 'avatar') {
    title.textContent = (def._icon || '\u{1F3C6}') + ' CHARACTER UNLOCKED';
  } else {
    title.textContent = '\u{1F3C6} ACHIEVEMENT UNLOCKED';
  }

  const name = document.createElement('div');
  name.style.cssText = `color:${PALETTE_BONE};font-size:15px;font-weight:600;margin-bottom:2px;`;
  name.textContent = def.name;

  const desc = document.createElement('div');
  desc.style.cssText = `color:${PALETTE_BONE};opacity:0.78;font-size:12px;`;
  desc.textContent = def.desc;

  el.appendChild(title);
  el.appendChild(name);
  el.appendChild(desc);
  host.appendChild(el);

  // Animate in on next frame so the transition triggers.
  requestAnimationFrame(() => { el.style.transform = 'translateX(0)'; });

  return el;
}

function _pumpToastQueue() {
  if (_toastActive) return;
  const def = _toastQueue.shift();
  if (!def) return;
  const el = _renderToast(def);
  if (!el) return;
  _toastActive = el;
  try { sfx && sfx.evolutionChime && sfx.evolutionChime(); }
  catch (_) {}
  _toastTimerId = setTimeout(() => {
    // Slide out, then remove, then pump next.
    if (_toastActive) _toastActive.style.transform = 'translateX(120%)';
    setTimeout(() => {
      if (_toastActive && _toastActive.parentNode) {
        _toastActive.parentNode.removeChild(_toastActive);
      }
      _toastActive = null;
      _toastTimerId = 0;
      _pumpToastQueue();
    }, TOAST_SLIDE_MS + 20);
  }, TOAST_DURATION_MS);
}

function _enqueueToast(def) {
  _toastQueue.push(def);
  _pumpToastQueue();
}

// ── Persistent unlock ─────────────────────────────────────────────────────
// Writes the NEW shape `{ unlockedAt: ISOString, count: 1 }` into
// meta.achievements. The shared map already holds older entries written by
// meta.js#unlockAchievement as numeric timestamps — we don't migrate those.
// The per-run Set (state.run._achievementsThisRun) gates the toast so a
// fresh run can re-feel the chime; meta.achievements is the lifetime record.

/** Look up a def by id. Returns null for unknown ids. */
export function getAchievementDef(id) { return ACH_BY_ID[id] || null; }

/** Returns the full def list (sorted by category for menuV2 panel rendering). */
export function getAchievements() { return ACH_DEFS.slice(); }

/** Returns count and total — surfaced by mountTitlePanel + smoke probes. */
export function getAchievementProgress() {
  const meta = getMeta() || {};
  const map = meta.achievements || {};
  let n = 0;
  for (const def of ACH_DEFS) if (map[def.id]) n++;
  return { unlocked: n, total: ACH_DEFS.length };
}

/** Returns true if this id is unlocked in the persistent meta map. */
export function isAchievementUnlocked(id) {
  const meta = getMeta() || {};
  return !!(meta.achievements && meta.achievements[id]);
}

/**
 * Unlock an achievement by id. Idempotent in two layers:
 *   - meta.achievements[id] is only written if absent.
 *   - state.run._achievementsThisRun gates the toast so the same id can't
 *     re-toast within the same run, but a fresh run CAN re-toast for the
 *     player-feel reason called out in the brief.
 * Returns the def on first dispatch this run, null otherwise.
 */
export function unlockAchievement(id) {
  const def = ACH_BY_ID[id];
  if (!def) return null;

  // Per-run dedup (toast gate).
  try {
    if (typeof window !== 'undefined' && window.__kkAchState) {
      // diagnostic noop; reserved for future devtools probe
    }
  } catch (_) {}
  const runSet = _runSet();
  if (runSet.has(id)) return null;
  runSet.add(id);

  // Persistent meta write — only on the FIRST lifetime unlock.
  const meta = getMeta();
  if (!meta.achievements) meta.achievements = {};
  const isFirstLifetimeUnlock = !meta.achievements[id];
  if (isFirstLifetimeUnlock) {
    meta.achievements[id] = { unlockedAt: new Date().toISOString(), count: 1 };
    try { saveMeta(); } catch (e) { /* persistence is best-effort */ }
  }

  _enqueueToast(def);

  // PHASE 4 P4F (#144) — Avatar unlock funnel.
  // Generic hook: any AVATARS[] entry whose `unlock` field equals this
  // achievement id graduates from locked → unlocked here. Gated on the
  // first-lifetime path so re-firing the achievement in later runs does not
  // re-toast the avatar banner. unlockAvatar() is also internally idempotent
  // (no-op if already unlocked) — this gate is a belt over a suspender.
  if (isFirstLifetimeUnlock) {
    try { _maybeUnlockAvatarFor(id); }
    catch (e) { /* avatar unlock is best-effort, never breaks ach toast */ }
  }

  return def;
}

// ── Avatar unlock hook (P4F #144) ────────────────────────────────────────
// Scans the AVATARS array for entries whose `unlock` field carries this
// achievement id (the "achievement id" unlock form documented in meta.js
// #isCharacterUnlocked). Calls unlockAvatar() + fires a transient banner
// reusing the achievement toast pipeline (same gold-bordered, slot-7
// palette) so a unified "Achievement → Char Unlocked" beat plays.
//
// `unlock` form contract — three shapes are documented in meta.js for
// CHARACTERS:
//   null              — always unlocked
//   'sigils:N'        — sigil milestone (NOT an achievement id)
//   'flag:fieldName'  — meta flag set elsewhere (NOT an achievement id)
//   <any other str>   — bare achievement id (this hook's match path)
// We deliberately skip the prefixed forms so a future avatar gated on a
// flag whose name happens to collide with an achievement id won't double-fire.
function _maybeUnlockAvatarFor(achId) {
  if (!achId || !Array.isArray(AVATARS)) return;
  for (let i = 0; i < AVATARS.length; i++) {
    const av = AVATARS[i];
    if (!av || typeof av.unlock !== 'string') continue;
    if (av.unlock === achId
        && !av.unlock.startsWith('flag:')
        && !av.unlock.startsWith('sigils:')) {
      if (isAvatarUnlocked(av.id)) continue;
      unlockAvatar(av.id, 'achievement:' + achId);
      _enqueueAvatarUnlockToast(av, achId);
    }
  }
}

// Banner-style toast for avatar unlocks. Reuses the achievement toast queue
// so consecutive unlocks (e.g. dodge-100 + no-hit on a clean victory run)
// stack without overlapping. Visually distinct from the achievement toast
// via a different title prefix ("CHARACTER UNLOCKED") but same palette so
// the moment reads as one unified celebration.
function _enqueueAvatarUnlockToast(avatar, achId) {
  if (!avatar) return;
  const synthDef = {
    id: '__avatar_unlock_' + avatar.id,
    name: avatar.name + ' UNLOCKED',
    desc: (avatar.desc || '').split('—').slice(1).join('—').trim()
          || ('Unlocked via ' + achId),
    category: 'Avatar',
    _kind: 'avatar',                  // tag picked up by _renderToast below
    _icon: avatar.icon || '🐱',
  };
  _enqueueToast(synthDef);
}

// Lazy access to the per-run Set so we tolerate a missing state.run shape
// during early boot frames.
function _runSet() {
  // Imported lazily to avoid a circular dep at module load (state.js does
  // not import this file). We bind once on first call.
  let st;
  try { st = _bound.state; } catch (_) {}
  if (!st) return _DUMMY_SET;
  if (!st.run) return _DUMMY_SET;
  if (!st.run._achievementsThisRun || !(st.run._achievementsThisRun instanceof Set)) {
    st.run._achievementsThisRun = new Set();
  }
  return st.run._achievementsThisRun;
}
const _DUMMY_SET = new Set();   // sink when no state is available
const _bound = { state: null }; // set by loadAchievements()

// ── Tick check loop ──────────────────────────────────────────────────────
// Per-tick eligibility scan. Each check is O(1) plus a Set lookup; ~20-25
// short-circuited reads per frame total. All checks bail immediately if the
// id is already in the per-run Set, so unlocked achievements add ~1 lookup
// each from then on.

// Full-HP cumulative timer (in seconds, accumulated across frames where
// hp === hpMax). 300s = 5 minutes. Reset to 0 on hp loss is NOT required by
// the contract ("cumulative pause-resets allowed"); we keep the running
// total monotonic across the run.
let _fullHpTimer = 0;

// Per-run "all rooms" tracker: object map { roomId: true }. Reset every run.
// Read via state.run.currentRoom (mirrored by main.js room-transition tick).
function _ensureRoomTracker(st) {
  if (!st.run._roomsVisited || typeof st.run._roomsVisited !== 'object') {
    st.run._roomsVisited = {};
    // Seed with the start room so a player who never leaves Glade still
    // makes progress on the panel display.
    if (st.run.currentRoom) st.run._roomsVisited[st.run.currentRoom] = true;
  }
  return st.run._roomsVisited;
}

/**
 * Per-frame achievement scan. Called from main.js' main run-mode tick.
 * Cheap on inactive frames (most checks short-circuit on the runSet guard).
 * Stage-agnostic: kill / time / weapon / hp / chest checks fire in any
 * stage; forest-specific checks (rooms, coffin, reaper) safely no-op
 * elsewhere because the state fields they read are forest-managed and
 * stay at their defaults on non-forest runs.
 */
export function tickAchievements(state, dt) {
  if (!state || !state.run || !state.time) return;
  const runSet = _runSet();

  // ── Kill milestones (per-tick read against running counter) ───────────
  const kills = state.run.kills | 0;
  if (kills >= 50    && !runSet.has('kill_50'))    unlockAchievement('kill_50');
  if (kills >= 250   && !runSet.has('kill_250'))   unlockAchievement('kill_250');
  if (kills >= 1000  && !runSet.has('kill_1000'))  unlockAchievement('kill_1000');

  // ── Time milestones ───────────────────────────────────────────────────
  const t = state.time.game || 0;
  if (t >= 600  && !runSet.has('time_10min')) unlockAchievement('time_10min');
  if (t >= 1200 && !runSet.has('time_20min')) unlockAchievement('time_20min');
  if (t >= 1800 && !runSet.has('time_30min')) unlockAchievement('time_30min');

  // ── First miniboss (state.run.miniBossKills bumped by enemies.js) ─────
  if ((state.run.miniBossKills | 0) >= 1 && !runSet.has('first_miniboss')) {
    unlockAchievement('first_miniboss');
  }

  // ── Reaper outlasted (set by forestReaper.js at 35:00) ────────────────
  if (state.run.stats && state.run.stats.reaperOutlasted === true
      && !runSet.has('reaper_outlasted')) {
    unlockAchievement('reaper_outlasted');
  }

  // ── Chests (forestChests bumps state.run._chestsOpened on each pick) ─
  if ((state.run._chestsOpened | 0) >= 5 && !runSet.has('chest_x5')) {
    unlockAchievement('chest_x5');
  }

  // ── Coffin (forestCoffins writes truthy entries into _coffinsOpened) ──
  if (!runSet.has('coffin_x1')) {
    const c = state.run._coffinsOpened;
    if (c && typeof c === 'object') {
      for (const k in c) { if (c[k]) { unlockAchievement('coffin_x1'); break; } }
    }
  }

  // ── All 7 rooms visited (forest-only; no-op elsewhere) ─────────────────
  // FOREST_ROOMS exposes 7 ids: glade, saphollow, crystalchoir,
  // amberlabyrinth, bramblemaze, mossroot, glowfen. We track via the
  // currentRoom mirror that main.js#_tickForestRoomTransition updates.
  if (state.run.currentRoom && !runSet.has('all_rooms_visited')) {
    const seen = _ensureRoomTracker(state);
    seen[state.run.currentRoom] = true;
    let count = 0;
    for (const k in seen) if (seen[k]) count++;
    if (count >= 7) unlockAchievement('all_rooms_visited');
  }

  // ── Weapons ───────────────────────────────────────────────────────────
  const weapons = state.weapons || [];
  if (weapons.length > 0) {
    // weapon_l8: any weapon at level >= 8.
    if (!runSet.has('weapon_l8')) {
      for (let i = 0; i < weapons.length; i++) {
        if ((weapons[i].level | 0) >= 8) { unlockAchievement('weapon_l8'); break; }
      }
    }
    // weapon_evolved: either an inst.evolved flag (set by weapons/index.js
    // when an evolution offer is picked) OR a hardcoded coffin-evolved id.
    if (!runSet.has('weapon_evolved')) {
      for (let i = 0; i < weapons.length; i++) {
        const w = weapons[i];
        const isEvolved =
          (w.inst && w.inst.evolved === true)
          || EVOLVED_WEAPON_IDS.has(w.id);
        if (isEvolved) { unlockAchievement('weapon_evolved'); break; }
      }
    }
    // weapons_5_kit: visible (non-hidden) kit size >= 5. WEAPON_REGISTRY is
    // optional — when absent (e.g. early boot), fall back to weapons.length.
    if (!runSet.has('weapons_5_kit')) {
      const reg = _bound.weaponRegistry;
      const kit = reg ? _visibleKitCount(weapons, reg) : weapons.length;
      if (kit >= 5) unlockAchievement('weapons_5_kit');
    }
  }

  // ── Survival: no_hit_60s ──────────────────────────────────────────────
  // hero._lastHitAt isn't tracked in the existing hero damage path (out of
  // our file-boundary to add). Fallback per contract: state.run.dmgTaken
  // (NOT totalDamageTaken, which doesn't exist) === 0 at t>=60.
  if (t >= 60
      && (state.run.dmgTaken | 0) === 0
      && !runSet.has('no_hit_60s')) {
    unlockAchievement('no_hit_60s');
  }

  // ── Survival: full_hp_5min (cumulative; pause-resets allowed) ─────────
  // Accumulate dt only while hero is at full HP. Contract: 300s cumulative,
  // hp drops do NOT reset the counter ("cumulative pause-resets allowed").
  if (!runSet.has('full_hp_5min') && state.hero && dt > 0) {
    const hp    = state.hero.hp || 0;
    const hpMax = state.hero.hpMax || 1;
    if (hp >= hpMax - 0.001) _fullHpTimer += dt;
    if (_fullHpTimer >= 300) unlockAchievement('full_hp_5min');
  }

  // ── P4D NG+ unlock (#143, 2026-05-18) ────────────────────────────────
  // Profile-wide flag flips true on the first Forest clear. Two signals
  // qualify as "clear" per docs/P4_BACKLOG.md: state.victory (final-boss
  // kill) OR state.run.stats.reaperOutlasted (Reaper outlasted at 35:00 —
  // the alternate forest clear path forestReaper.js stamps). Self-gated
  // via state.run._ngPlusUnlockFired (initialized by state.js resetState
  // implicitly — the run object is rebuilt per run, so a fresh run starts
  // with the field undefined, matching the _xFired idiom from
  // feedback_kks_wave_dispatcher_throttle.md). saveMeta() inline because
  // forestAchievements.js already owns a saveMeta() import (line 28) and
  // mirrors the pattern unlockAchievement uses two functions up.
  if (!state.run._ngPlusUnlockFired
      && state.run.stage && state.run.stage.id === 'forest'
      && (state.victory === true
          || (state.run.stats && state.run.stats.reaperOutlasted === true))) {
    state.run._ngPlusUnlockFired = true;
    try {
      const meta = getMeta();
      if (meta && !meta.unlockedNgPlus) {
        meta.unlockedNgPlus = true;
        saveMeta();
      }
    } catch (_) { /* persistence best-effort */ }
  }

  // ── P4F no_hit_clear edge (#144, 2026-05-18) ──────────────────────────
  // Forest-only win where state.run.dmgTaken === 0 at clear moment. Uses
  // the same victory-OR-reaperOutlasted clear signal as the NG+ unlock so
  // an outlast counts as a clear. Self-gated via state.run._noHitClearFired
  // mirroring the _ngPlusUnlockFired idiom — a fresh run rebuilds state.run,
  // so the flag starts undefined and fires exactly once per qualifying clear.
  // damageTaken field is state.run.dmgTaken (stamped by hero.js#heroTakeDamage,
  // state.js:271 init to 0) — NOT state.run.stats.damageTakenTotal as the
  // P4F brief loosely described. The tick fires unlockAchievement which
  // routes through the avatar-unlock hook for Rune Kitten.
  if (!state.run._noHitClearFired
      && state.run.stage && state.run.stage.id === 'forest'
      && (state.victory === true
          || (state.run.stats && state.run.stats.reaperOutlasted === true))
      && (state.run.dmgTaken | 0) === 0) {
    state.run._noHitClearFired = true;
    if (!runSet.has('no_hit_clear')) unlockAchievement('no_hit_clear');
  }

  // ── P4F rings_dodged_100 tick (#144, 2026-05-18) ──────────────────────
  // forestEnvHazards.js bumps state.run.stats.ringsDodged at each
  // MP_PUFF→MP_IDLE transition where the hero never entered the puff
  // radius. Lifetime threshold is intentionally per-run (matches the
  // "dodge 100 mushroom rings" framing) — the counter resets every run
  // via state.run rebuild, so a player who consistently dodges 30/run will
  // never unlock without a single bigger session. That matches the design
  // intent of a moderate-effort secret. Mire Kitten unlocks from the
  // avatar-unlock hook inside unlockAchievement.
  if (state.run.stats
      && (state.run.stats.ringsDodged | 0) >= 100
      && !runSet.has('rings_dodged_100')) {
    unlockAchievement('rings_dodged_100');
  }
}

// ── Title-screen panel ───────────────────────────────────────────────────
// menuV2 calls mountTitlePanel(parent). We append a compact indicator that
// reads "Achievements: N/Total" and opens a modal on click.

let _titleIndicator = null;
let _modalEl        = null;
let _modalKeyHandler = null;

/** Mount the title-screen "Achievements: N/Total" indicator. */
export function mountTitlePanel(parent) {
  if (!parent || typeof document === 'undefined') return null;
  if (_titleIndicator && _titleIndicator.parentNode) {
    _titleIndicator.parentNode.removeChild(_titleIndicator);
  }
  const ind = document.createElement('button');
  ind.type = 'button';
  ind.className = 'kk-ach-title-indicator';
  ind.style.cssText = `
    margin-left: 10px;
    padding: 4px 10px;
    background: rgba(20,28,22,0.65);
    border: 1px solid ${PALETTE_GOLD};
    border-radius: 4px;
    color: ${PALETTE_GOLD};
    font-family: "Geist Mono", "JetBrains Mono", "Consolas", monospace;
    font-size: 11px;
    letter-spacing: 0.08em;
    cursor: pointer;
    pointer-events: auto;
  `;
  _refreshIndicator(ind);
  ind.addEventListener('click', _openModal);
  parent.appendChild(ind);
  _titleIndicator = ind;
  return ind;
}

function _refreshIndicator(ind) {
  if (!ind) ind = _titleIndicator;
  if (!ind) return;
  const { unlocked, total } = getAchievementProgress();
  ind.textContent = `\u{1F3C6} Achievements: ${unlocked}/${total}`;
}

function _openModal() {
  if (_modalEl) return;
  const host = _ensureToastHost();
  if (!host) return;

  const overlay = document.createElement('div');
  overlay.className = 'kk-ach-modal';
  overlay.style.cssText = `
    position: fixed; inset: 0;
    background: rgba(8,14,12,0.78);
    z-index: 70;
    display: flex; align-items: center; justify-content: center;
    font-family: "Cinzel", "Cormorant Garamond", Georgia, serif;
    color: ${PALETTE_BONE};
  `;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) _closeModal();
  });

  const panel = document.createElement('div');
  panel.style.cssText = `
    min-width: 480px; max-width: min(720px, 92vw);
    max-height: 78vh; overflow: auto;
    padding: 20px 24px;
    background: ${PALETTE_DARK_BG};
    border: 2px solid ${PALETTE_GOLD};
    border-radius: 8px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.6);
  `;

  const header = document.createElement('div');
  header.style.cssText = `
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 14px;
  `;
  const title = document.createElement('div');
  title.style.cssText = `color:${PALETTE_GOLD};font-size:18px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;`;
  const { unlocked, total } = getAchievementProgress();
  title.textContent = `\u{1F3C6} Achievements  ${unlocked}/${total}`;
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'ESC · Close';
  closeBtn.style.cssText = `
    padding: 4px 10px;
    background: transparent;
    border: 1px solid ${PALETTE_GOLD};
    color: ${PALETTE_GOLD};
    border-radius: 4px;
    font-family: inherit;
    font-size: 11px;
    letter-spacing: 0.1em;
    cursor: pointer;
  `;
  closeBtn.addEventListener('click', _closeModal);
  header.appendChild(title);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  // Group by category for a tidy listing.
  const byCat = {};
  for (const def of ACH_DEFS) {
    if (!byCat[def.category]) byCat[def.category] = [];
    byCat[def.category].push(def);
  }
  const order = ['Kills', 'Bosses', 'Exploration', 'Progression', 'Mastery', 'Survival'];

  for (const cat of order) {
    const arr = byCat[cat];
    if (!arr) continue;
    const catHeader = document.createElement('div');
    catHeader.textContent = cat.toUpperCase();
    catHeader.style.cssText = `
      color: ${PALETTE_GOLD};
      font-size: 11px;
      letter-spacing: 0.22em;
      margin: 14px 0 6px;
      opacity: 0.85;
    `;
    panel.appendChild(catHeader);
    for (const def of arr) {
      panel.appendChild(_renderModalRow(def));
    }
  }

  overlay.appendChild(panel);
  host.appendChild(overlay);
  _modalEl = overlay;

  _modalKeyHandler = (e) => { if (e.key === 'Escape') _closeModal(); };
  document.addEventListener('keydown', _modalKeyHandler);
}

function _renderModalRow(def) {
  const unlocked = isAchievementUnlocked(def.id);
  const row = document.createElement('div');
  row.style.cssText = `
    display: flex; align-items: center; gap: 10px;
    padding: 8px 10px;
    margin-bottom: 4px;
    background: ${unlocked ? 'rgba(255,216,107,0.08)' : 'rgba(0,0,0,0.18)'};
    border: 1px solid ${unlocked ? PALETTE_GOLD : 'rgba(199,184,154,0.18)'};
    border-radius: 4px;
    opacity: ${unlocked ? 1 : 0.55};
  `;

  const icon = document.createElement('span');
  icon.style.cssText = `
    width: 24px; text-align: center; font-size: 16px;
    color: ${unlocked ? PALETTE_GOLD : PALETTE_BONE};
  `;
  icon.textContent = unlocked ? '\u{2713}' : '\u{1F512}';

  const body = document.createElement('div');
  body.style.cssText = `flex: 1;`;
  const name = document.createElement('div');
  name.style.cssText = `
    color: ${unlocked ? PALETTE_BONE : 'rgba(199,184,154,0.65)'};
    font-size: 13px; font-weight: 600; letter-spacing: 0.05em;
  `;
  name.textContent = def.name;
  const desc = document.createElement('div');
  desc.style.cssText = `
    color: ${unlocked ? PALETTE_BONE : 'rgba(199,184,154,0.5)'};
    opacity: 0.85; font-size: 11px; margin-top: 1px;
  `;
  desc.textContent = def.desc;
  body.appendChild(name);
  body.appendChild(desc);

  row.appendChild(icon);
  row.appendChild(body);
  return row;
}

function _closeModal() {
  if (_modalEl && _modalEl.parentNode) _modalEl.parentNode.removeChild(_modalEl);
  _modalEl = null;
  if (_modalKeyHandler) {
    document.removeEventListener('keydown', _modalKeyHandler);
    _modalKeyHandler = null;
  }
  // Re-stamp the indicator in case an unlock happened while the modal was open.
  _refreshIndicator();
}

// ── Lifecycle ────────────────────────────────────────────────────────────

/**
 * Boot-time wiring. Idempotent. Binds the state ref so the per-run Set can
 * be lazily initialized, and (best-effort) the weapons REGISTRY for the
 * weapons_5_kit visible-kit check. Falls back gracefully if REGISTRY isn't
 * importable in the current environment (e.g. headless smoke).
 */
export function loadAchievements(stateRef, weaponRegistryRef) {
  if (_wired) {
    if (stateRef && !_bound.state) _bound.state = stateRef;
    if (weaponRegistryRef && !_bound.weaponRegistry) _bound.weaponRegistry = weaponRegistryRef;
    return;
  }
  _wired = true;
  _bound.state = stateRef || null;
  _bound.weaponRegistry = weaponRegistryRef || null;
  // Reset cumulative timer on a fresh wiring (safety; main.js calls this once
  // per session at boot, runs don't re-call it). The per-run Set is reset by
  // state.resetState() (see state.js init).
  _fullHpTimer = 0;
}

/** Dispose all DOM owned by this module. Safe to call multiple times. */
export function disposeAchievements() {
  // Clear active toast + queue.
  if (_toastTimerId) { clearTimeout(_toastTimerId); _toastTimerId = 0; }
  if (_toastActive && _toastActive.parentNode) {
    _toastActive.parentNode.removeChild(_toastActive);
  }
  _toastActive = null;
  _toastQueue = [];

  // Close modal + indicator.
  _closeModal();
  if (_titleIndicator && _titleIndicator.parentNode) {
    _titleIndicator.parentNode.removeChild(_titleIndicator);
  }
  _titleIndicator = null;
}

// Devtools probe — surface state for smoke tests / manual inspection.
// Mounted on window only when present; safe in headless node.
try {
  if (typeof window !== 'undefined') {
    window.__kkAchievements = {
      list: () => ACH_DEFS.slice(),
      progress: getAchievementProgress,
      unlock: unlockAchievement,
      isUnlocked: isAchievementUnlocked,
    };
  }
} catch (_) {}
