/**
 * Forest Sealed Door Room Progression — FOREST-V2-A14 (2026-05-17).
 *
 * Vampire-Survivors-style room-gating: when the hero enters a non-glade
 * forest room for the FIRST time in a run, ONE miniboss spawns at the room
 * center and the room's return portal seals (tinted slot-6 amber + sealed
 * flag set). The boss must die before the portal unseals. Re-entering a
 * cleared room: no re-spawn, portal already open.
 *
 * Glade is the hub — its portals NEVER seal; the hero can always go OUT
 * to a room. Only the room→glade RETURN portal seals (player can run away
 * back to glade only after clearing the boss). This matches the brief's
 * design note: "all 6 sealed rooms only connect to glade (radial layout)".
 *
 * ── State (per run, lives in state.run._sealedRooms) ───────────────────────
 *   _sealedRooms[roomId] = { bossId, alive: boolean }
 * Initialized to {} by resetState() in state.js. Keyed by room id so re-
 * entry can distinguish "never visited" (key missing) vs "visited, boss
 * still alive" (alive=true) vs "cleared" (alive=false, key kept).
 *
 * ── Boss tagging ───────────────────────────────────────────────────────────
 * Spawned enemies are stamped with `_isRoomBoss = true` and `_roomBossId =
 * roomId`. enemies.killEnemy() calls onRoomBossKilled() early in its death
 * branch (single-line check) so the unseal fires reliably regardless of
 * which kill path resolves the death (signature weapon, contact, DoT).
 *
 * ── Difficulty band ────────────────────────────────────────────────────────
 * Tier selection is time-banded so early rooms feel beatable:
 *   t < 300s   → lowest-minD elite available
 *   t < 900s   → any elite already in pool at current difficulty
 *   t ≥ 900s   → highest-minD elite available
 * In the FE-V0.2 elite pool there are only TWO elites (giant minD=6.0,
 * dragon minD=7.0) so the time bands collapse to "giant early, dragon
 * late" — recorded for future tuning when the elite pool grows.
 *
 * Cumulative HP scale per cleared sealed room: hpMul *= (1 + cleared*0.2).
 * Applied AFTER spawnEnemy bakes the base hp/hpMax (we multiply both fields
 * post-spawn so kill-bar math stays consistent with the spawnEnemy formula).
 *
 * ── Portal sealing ─────────────────────────────────────────────────────────
 * We don't own portal geometry — forestPortals.js does. Instead we mutate
 * portal records via getForestPortals() (added in cohort 14):
 *   portal._sealed       = true|false   (consumed by _findReadyPortalNearHero)
 *   portal._sealOrigColors = { disc, rim, crystalEmissive } cached for restore
 * Tint goes slot-6 amber on disc/rim/crystal emissive (read as "warning"
 * against the normal mint-mint-amber palette of a return portal). On
 * unseal we restore the cached hex on each material reference.
 *
 * ── Proximity prompt ───────────────────────────────────────────────────────
 * When hero is within 3u of a sealed portal AND the room boss is alive,
 * show a single DOM overlay "SEALED — clear room first" near screen-bottom
 * (no world-space anchor needed — VS-style center prompt is enough at this
 * production tier; mirrors the lockdown banner shape without the slam FX).
 * Auto-hides when the hero leaves the radius or the boss dies.
 *
 * ── Palette (slot-locked; no new hex constants) ────────────────────────────
 *   slot 6 #f5a300 — sealed tint (re-used from COLOR_AMBER_IDLE)
 *   slot 7 #ffd86b — sealed pulse peak (re-used from COLOR_AMBER_FLASH)
 *
 * ── Hard caps ──────────────────────────────────────────────────────────────
 *   - At most ONE boss spawn per room per run (state.run._sealedRooms gate).
 *   - Banner uses showBanner() from ui.js — same hook the reaper cohort uses.
 *   - All mutations are static-import, no dynamic imports in the hot path.
 *
 * Public API:
 *   loadForestSealedDoors(scene, state) — once-per-scene init (no geometry
 *                                          this module spawns; sets up the
 *                                          DOM prompt + state ref).
 *   tickForestSealedDoors(state, dt)    — pulse sealed portal tint + manage
 *                                          proximity prompt visibility.
 *   onRoomEnter(roomId)                 — called by main.js when the room
 *                                          transition detects a new room id;
 *                                          spawns boss + seals on first entry.
 *   onRoomBossKilled(enemy)             — called by enemies.killEnemy on the
 *                                          `_isRoomBoss` death branch.
 *   disposeForestSealedDoors()          — removes DOM prompt; clears state.
 */
import { state as _gameState } from './state.js';
import { ENEMY_TIERS, STAGE } from './config.js';
import { FOREST_ROOMS } from './forestRooms.js';
import { spawnEnemy } from './enemies.js';
import { getForestPortals, COLOR_AMBER_IDLE, COLOR_AMBER_FLASH } from './forestPortals.js';
import { sfx } from './audio.js';
import { showBanner } from './ui.js';

// ── tuning constants ─────────────────────────────────────────────────────────
const PROMPT_RADIUS              = 3.0;
const PROMPT_RADIUS_SQ           = PROMPT_RADIUS * PROMPT_RADIUS;
const SEAL_PULSE_HZ              = 1.2;       // gentle "still sealed" pulse
const SEAL_EMISSIVE_MIN          = 1.4;       // matches portal idle min
const SEAL_EMISSIVE_MAX          = 2.6;       // peak warning intensity
const CLEAR_BANNER_SEC           = 2.0;
const CLEAR_BANNER_COLOR         = '#f5a300'; // slot 6 amber gold per brief

// Same difficulty curve as spawnDirector.computeDifficulty / enemies._computeDifficulty
// (kept inline so we don't reach into private helpers). Matches the published
// rampHpPerD scaling used by spawnEnemy at lines 371-374 of enemies.js.
function _computeD(gameTime) {
  // Mirrors src/spawnDirector.js: D ramps 0→1 over first 60s, then 1→10 by 20min
  // (~1200s). Keep aligned with config.SPAWN.rampHpPerD so HP scaling stays
  // consistent with the rest of the spawn pipeline.
  const t = Math.max(0, gameTime || 0);
  if (t <= 60) return t / 60;
  // 60s → 1.0, 1200s → ~10.0; linear past 60s
  return 1.0 + (t - 60) * (9.0 / 1140);
}

// ── module state ─────────────────────────────────────────────────────────────
let _stateRef = null;
let _promptEl = null;
let _promptVisible = false;
let _pulseT = 0;

// Per-boss bookkeeping — keyed by roomId so we can null out the live enemy
// reference on death without iterating state.enemies.active.
const _bossByRoom = Object.create(null);

// Cache of portal seal originals (per portal id) so unsealing restores the
// exact pre-seal hex values (which may differ from defaults if some other
// cohort recolored a portal mid-run — defensive).
const _sealCache = Object.create(null);

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Count cleared (alive=false) entries in state.run._sealedRooms. Used to
 * scale boss HP — each prior clear multiplies the next boss HP by +20%.
 * Cumulative compounding intentionally NOT used; the brief specifies a
 * simple additive coefficient `clearedCount * 0.2 + 1.0`.
 */
function _clearedCount(state) {
  const sealed = state && state.run && state.run._sealedRooms;
  if (!sealed) return 0;
  let n = 0;
  for (const id in sealed) {
    const rec = sealed[id];
    if (rec && rec.alive === false) n++;
  }
  return n;
}

/**
 * Pick a miniboss tier from ENEMY_TIERS based on game time. Three bands per
 * brief; with only 2 elites in the current pool (giant minD=6.0, dragon
 * minD=7.0) the bands map to:
 *   0-300s   → giant (lowest-minD elite still in difficulty window)
 *   300-900s → giant if D not yet up to dragon, else dragon
 *   900s+    → dragon (highest-minD elite)
 * Fallback: if NO elites match D (e.g. very early run, D=0 → both elites
 * gated out by minD), use the entire elite pool unfiltered so we always
 * have a boss to spawn.
 */
function _pickBossTier(gameTime) {
  const D = _computeD(gameTime);
  const allElites = ENEMY_TIERS.filter(t => t.elite);
  if (allElites.length === 0) return null;
  // Sort ascending by minD so [0] = easiest, [last] = hardest.
  const sorted = allElites.slice().sort((a, b) => (a.minD || 0) - (b.minD || 0));

  let tier;
  if (gameTime < 300) {
    // Easy band — lowest-minD elite (whether or not difficulty has caught up).
    tier = sorted[0];
  } else if (gameTime < 900) {
    // Mid band — pick the hardest elite currently in difficulty window, else
    // fall back to lowest-minD elite.
    const allowed = sorted.filter(t => t.minD <= D + 1);
    tier = allowed.length > 0 ? allowed[allowed.length - 1] : sorted[0];
  } else {
    // Hard band — top elite.
    tier = sorted[sorted.length - 1];
  }
  return tier;
}

/**
 * Find the return portal whose room matches roomId. Return portals seal in
 * the room↔glade pair (per brief design): the return portal is the one
 * sitting INSIDE the puzzle/relic room, with destRoomId='glade'.
 *
 * Returns null silently if forestPortals hasn't been loaded yet (e.g. first
 * tick of a transition before the load fires).
 */
function _findReturnPortalForRoom(roomId) {
  const portals = getForestPortals();
  if (!portals) return null;
  for (const p of portals) {
    if (p.kind === 'return' && p.roomId === roomId) return p;
  }
  return null;
}

/**
 * Snapshot the portal's current colors so unsealing restores precisely.
 * We cache per-portal-id (NOT per-roomId) so re-seal/unseal cycles within
 * one run reuse the same snapshot — defensive against a future code path
 * that re-seals after unseal (e.g. multi-boss room variant).
 */
function _cachePortalColors(portal) {
  if (_sealCache[portal.id]) return; // first cache wins (preserve pre-mod state)
  const disc = portal.discMat && portal.discMat.emissive
    ? portal.discMat.emissive.getHex() : null;
  const rim = portal.rimMat && portal.rimMat.color
    ? portal.rimMat.color.getHex() : null;
  const crystal = portal.crystalMat && portal.crystalMat.emissive
    ? portal.crystalMat.emissive.getHex() : null;
  _sealCache[portal.id] = {
    discEmissive: disc,
    rimColor: rim,
    crystalEmissive: crystal,
    baseColorHex: portal.baseColorHex,
  };
}

/**
 * Apply slot-6 amber tint to the portal materials so it reads as "warning,
 * sealed". We mutate emissive/color (not the disc.color which is the slot-2
 * crystal undertone) so the portal still looks like a portal — just with a
 * hot amber rim and floating glyph.
 */
function _applySealVisual(portal) {
  if (!portal) return;
  _cachePortalColors(portal);
  if (portal.discMat && portal.discMat.emissive) {
    portal.discMat.emissive.setHex(COLOR_AMBER_IDLE);
  }
  if (portal.rimMat && portal.rimMat.color) {
    portal.rimMat.color.setHex(COLOR_AMBER_IDLE);
  }
  if (portal.crystalMat && portal.crystalMat.emissive) {
    portal.crystalMat.emissive.setHex(COLOR_AMBER_IDLE);
  }
  // Hide cooldown ring while sealed — the cooldown UX is irrelevant when
  // the portal can't be used at all.
  if (portal.cooldownRing && portal.cooldownRing.mat) {
    portal.cooldownRing.mat.opacity = 0;
  }
  // Override base color hex so forestPortals.tick's pulse loop keeps the
  // sealed tint on PASS 1 (it writes peakColorHex on peak, baseColorHex
  // otherwise). Stash the original first.
  portal._sealed = true;
  portal.baseColorHex = COLOR_AMBER_IDLE;
  portal.peakColorHex = COLOR_AMBER_FLASH;
}

/**
 * Restore the portal to its pre-seal colors. Reads from _sealCache so a
 * mid-run color change (e.g. cohort N adds a stage-rule tint) is preserved.
 */
function _applyUnsealVisual(portal) {
  if (!portal) return;
  portal._sealed = false;
  const cache = _sealCache[portal.id];
  if (cache) {
    if (cache.discEmissive != null && portal.discMat && portal.discMat.emissive) {
      portal.discMat.emissive.setHex(cache.discEmissive);
    }
    if (cache.rimColor != null && portal.rimMat && portal.rimMat.color) {
      portal.rimMat.color.setHex(cache.rimColor);
    }
    if (cache.crystalEmissive != null && portal.crystalMat && portal.crystalMat.emissive) {
      portal.crystalMat.emissive.setHex(cache.crystalEmissive);
    }
    if (cache.baseColorHex != null) {
      portal.baseColorHex = cache.baseColorHex;
    }
    // Reset the peak so it matches the post-restore baseColor's natural pair
    // (the original portal init set peakColorHex = COLOR_AMBER_FLASH for all
    // portals; keep that constant since both kinds flash slot-7 on activate).
    portal.peakColorHex = COLOR_AMBER_FLASH;
    delete _sealCache[portal.id];
  }
}

/**
 * Build (or recover) the proximity prompt DOM overlay. Lives on document.body
 * (same root the lockdown banner uses, traversed by ui.js — keeps things
 * consistent without coupling to ui's internal _root reference).
 */
function _ensurePromptEl() {
  if (_promptEl) return _promptEl;
  if (typeof document === 'undefined') return null;
  const el = document.createElement('div');
  el.id = 'kk-sealed-prompt';
  el.style.cssText = [
    'position: fixed',
    'left: 50%',
    'bottom: 18%',
    'transform: translateX(-50%)',
    'font-family: monospace',
    'font-size: 18px',
    'font-weight: 800',
    'letter-spacing: 0.10em',
    'color: #f5a300',
    'text-shadow: 0 2px 10px rgba(0,0,0,0.65), 0 0 16px #f5a30055',
    'pointer-events: none',
    'z-index: 70',
    'padding: 8px 18px',
    'background: linear-gradient(180deg, rgba(20,18,10,0.72), rgba(8,7,4,0.78))',
    'border-top: 1px solid #f5a30066',
    'border-bottom: 1px solid #f5a30066',
    'box-shadow: 0 8px 24px rgba(0,0,0,0.55)',
    'white-space: nowrap',
    'opacity: 0',
    'transition: opacity 0.15s ease-out',
  ].join('; ') + ';';
  el.textContent = 'SEALED — clear room first';
  document.body.appendChild(el);
  _promptEl = el;
  _promptVisible = false;
  return el;
}

function _showPrompt() {
  if (!_promptEl) return;
  if (_promptVisible) return;
  _promptVisible = true;
  _promptEl.style.opacity = '1';
}

function _hidePrompt() {
  if (!_promptEl) return;
  if (!_promptVisible) return;
  _promptVisible = false;
  _promptEl.style.opacity = '0';
}

// ── public: load ─────────────────────────────────────────────────────────────

/**
 * Once-per-scene init. Mirrors the gated-load shape used by every other
 * FOREST-V2 module (chests, reaper, neutrals, etc.). Idempotent.
 *
 * @param {THREE.Scene} scene
 * @param {object} state
 */
export function loadForestSealedDoors(scene, state) {
  void scene; // no scene geometry — module is event-driven over existing portals
  _stateRef = state || _gameState;
  _ensurePromptEl();
  // Defensive: if state.run._sealedRooms hasn't been initialized by
  // resetState (legacy save or test harness), seed it here so onRoomEnter
  // can safely write into it without an undefined-key crash.
  if (_stateRef && _stateRef.run && !_stateRef.run._sealedRooms) {
    _stateRef.run._sealedRooms = {};
  }
  _pulseT = 0;
}

// ── public: tick ─────────────────────────────────────────────────────────────

/**
 * Per-frame tick. Cheap fast-path when no seals are active: a single loop
 * over getForestPortals() with an early continue on `!portal._sealed`.
 *
 * Two responsibilities:
 *   1. Pulse the slot-6 emissive intensity on sealed portal disc/rim so the
 *      "sealed" state reads visually (calm steady pulse, slower than the
 *      portal's own idle pulse so the two layers don't beat against each other).
 *   2. Show/hide the proximity prompt based on hero distance to the NEAREST
 *      sealed portal (single prompt, single z-order).
 *
 * @param {object} state
 * @param {number} dt
 */
export function tickForestSealedDoors(state, dt) {
  if (!state) return;
  const portals = getForestPortals();
  if (!portals || portals.length === 0) {
    if (_promptVisible) _hidePrompt();
    return;
  }
  _pulseT += dt;

  const k = 0.5 + 0.5 * Math.sin(_pulseT * Math.PI * 2 * SEAL_PULSE_HZ);
  const emissive = SEAL_EMISSIVE_MIN + (SEAL_EMISSIVE_MAX - SEAL_EMISSIVE_MIN) * k;

  const hero = state.hero;
  const heroPos = hero && hero.pos;
  let nearestSealedD2 = Infinity;

  for (const portal of portals) {
    if (!portal._sealed) continue;
    if (portal.discMat) {
      portal.discMat.emissiveIntensity = emissive;
    }
    if (heroPos) {
      const dx = heroPos.x - portal.x;
      const dz = heroPos.z - portal.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < nearestSealedD2) nearestSealedD2 = d2;
    }
  }

  // Prompt logic: show only while hero is alive, within radius, and game not
  // paused. Bails to hide otherwise so a paused-mid-prompt session resumes
  // cleanly without a stuck overlay.
  const heroAlive = !!(hero && hero.hp > 0 && !state.gameOver);
  const paused = !!(state.time && state.time.paused);
  if (heroAlive && !paused && nearestSealedD2 <= PROMPT_RADIUS_SQ) {
    _showPrompt();
  } else {
    _hidePrompt();
  }
}

// ── public: room entry hook ──────────────────────────────────────────────────

/**
 * Called by main.js::_tickForestRoomTransition the tick the hero's detected
 * room flips to a new id. Drives the per-run seal state machine:
 *
 *   - roomId === 'glade'                      → no-op (glade never seals)
 *   - record missing                          → spawn boss + seal portal
 *   - record exists, alive=true               → re-apply seal (defensive
 *                                                re-tint for cosmetic
 *                                                consistency; do NOT respawn)
 *   - record exists, alive=false              → no-op (already cleared)
 *
 * @param {string} roomId
 */
export function onRoomEnter(roomId) {
  const state = _stateRef || _gameState;
  if (!state || !state.run) return;
  if (!roomId || roomId === 'glade') return;
  const room = FOREST_ROOMS[roomId];
  if (!room) return;

  if (!state.run._sealedRooms) state.run._sealedRooms = {};
  const sealed = state.run._sealedRooms;

  const rec = sealed[roomId];
  if (rec && rec.alive === false) {
    // Already cleared this run — make sure the return portal is unsealed
    // (defensive: handles a hot-reload edge where we cleared mid-tint).
    const portal = _findReturnPortalForRoom(roomId);
    if (portal && portal._sealed) _applyUnsealVisual(portal);
    return;
  }

  if (rec && rec.alive === true) {
    // Boss still alive from a prior visit — re-seal portal (player may have
    // teleported back through an unsealed glade-side portal and returned).
    const portal = _findReturnPortalForRoom(roomId);
    if (portal && !portal._sealed) _applySealVisual(portal);
    return;
  }

  // First-time entry — spawn the room boss + seal the return portal.
  const gameTime = (state.time && state.time.game) || 0;
  const tier = _pickBossTier(gameTime);
  if (!tier) {
    console.warn('[forestSealedDoors] no elite tier available for', roomId);
    return;
  }

  const clearedCount = _clearedCount(state);
  const hpScale = 1.0 + clearedCount * 0.2;
  const miniBossHpMul = (STAGE && STAGE.miniBossHpMul) || 3;
  const miniBossScaleMul = (STAGE && STAGE.miniBossScaleMul) || 1.4;
  // Build a buffed tier definition. Shape mirrors spawnDirector.spawnMiniBoss
  // exactly so spawnEnemy's hp/hpMax bake stays consistent.
  const buffed = {
    ...tier,
    hp: tier.hp * miniBossHpMul,
    scale: (tier.scale || 1) * miniBossScaleMul,
    isMiniBoss: true,
  };

  const cx = room.center.x;
  const cz = room.center.z;
  let enemy = null;
  try {
    enemy = spawnEnemy(buffed, cx, cz);
  } catch (e) {
    console.warn('[forestSealedDoors] spawnEnemy failed:', e);
    return;
  }
  if (!enemy) return;

  // Apply cumulative cleared-room HP bonus AFTER spawnEnemy bakes baseline.
  // We multiply both hp and hpMax so the boss HP bar reads correctly.
  if (hpScale !== 1.0) {
    enemy.hp = enemy.hp * hpScale;
    enemy.hpMax = enemy.hpMax * hpScale;
  }

  // Tag for the kill-side hook in enemies.killEnemy.
  enemy._isRoomBoss = true;
  enemy._roomBossId = roomId;
  _bossByRoom[roomId] = enemy;

  // Stamp seal record + tint the return portal.
  sealed[roomId] = { bossId: tier.glb, alive: true };
  const portal = _findReturnPortalForRoom(roomId);
  if (portal) _applySealVisual(portal);

  // Small VFX/audio cue so the seal is felt, not just observed. bossWarn is
  // the closest match in the audio bank — used by reaper/miniboss arrivals.
  try { if (sfx && sfx.bossWarn) sfx.bossWarn(); } catch (_) {}
  if (state.fx) {
    state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.4);
    state.fx.shake = Math.max(state.fx.shake || 0, 0.25);
  }
}

// ── public: room boss kill hook ──────────────────────────────────────────────

/**
 * Called by enemies.killEnemy() when an `_isRoomBoss`-tagged enemy dies.
 * Resolves the room id off the enemy, flips alive=false, unseals the return
 * portal, drops a chest, and shows the ROOM CLEARED banner.
 *
 * @param {object} enemy
 */
export function onRoomBossKilled(enemy) {
  if (!enemy) return;
  const state = _stateRef || _gameState;
  if (!state || !state.run) return;
  const roomId = enemy._roomBossId;
  if (!roomId) return;
  if (!state.run._sealedRooms) state.run._sealedRooms = {};
  const sealed = state.run._sealedRooms;
  const rec = sealed[roomId];
  // If we already cleared this room (defensive: kill fires twice), bail
  // silently — banner/SFX already played, double-firing would spam.
  if (rec && rec.alive === false) return;
  sealed[roomId] = { bossId: (rec && rec.bossId) || (enemy.glbKey || '?'), alive: false };
  if (_bossByRoom[roomId] === enemy) _bossByRoom[roomId] = null;

  // Unseal portal.
  const portal = _findReturnPortalForRoom(roomId);
  if (portal && portal._sealed) _applyUnsealVisual(portal);

  // Banner + chime. evolutionChime reads as "progression unlocked" — picked
  // by ear over bossWarn which signals incoming threat (wrong mood here).
  try { showBanner('ROOM CLEARED', CLEAR_BANNER_SEC, CLEAR_BANNER_COLOR); } catch (_) {}
  try { if (sfx && sfx.evolutionChime) sfx.evolutionChime(); } catch (_) {}
  if (state.fx) {
    state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.6);
  }

  // No extra chest drop here — the standard miniboss death path in
  // enemies.killEnemy ALREADY fires dropForestChest on isMiniBoss kills
  // (see line ~838). The brief marked the extra chest as OPTIONAL; doubling
  // the chest pool would crowd the pickup ring and burn CAP_CHESTS faster.
  // Heart/star/bomb drops from that branch are also retained automatically.
}

// ── public: dispose ──────────────────────────────────────────────────────────

/**
 * Tear down DOM + module state. Idempotent. Safe to call on non-forest stages
 * (called by main.js stage-swap teardown). Does NOT touch portal materials —
 * forestPortals.disposeForestPortals owns those and clears the underlying
 * mesh tree (our cached hex values become orphaned on portal teardown, which
 * is fine since the cache is keyed by id and the next loadForestPortals
 * issues fresh ids).
 */
export function disposeForestSealedDoors() {
  if (_promptEl && _promptEl.parentNode) {
    _promptEl.parentNode.removeChild(_promptEl);
  }
  _promptEl = null;
  _promptVisible = false;
  _stateRef = null;
  _pulseT = 0;
  for (const k in _bossByRoom) delete _bossByRoom[k];
  for (const k in _sealCache) delete _sealCache[k];
}

// ── debug exports ────────────────────────────────────────────────────────────
export function _debugSealedRooms() {
  const state = _stateRef || _gameState;
  return state && state.run && state.run._sealedRooms
    ? JSON.parse(JSON.stringify(state.run._sealedRooms))
    : null;
}
export function _debugBossByRoom() { return { ..._bossByRoom }; }
export function _debugSealCache()  { return JSON.parse(JSON.stringify(_sealCache)); }

