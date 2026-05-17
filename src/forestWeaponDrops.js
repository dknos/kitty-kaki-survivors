/**
 * Forest Ground Weapon Drops — VS-style weapon pickup drops (FOREST-V2-A17, 2026-05-17).
 *
 * When a miniboss / elite / room-boss dies on the forest stage, roll for a
 * weapon-pickup drop. The hero walks over the pickup and the weapon is added
 * to the kit at L1 (subject to a 6-weapon cap on the visible kit; if full,
 * grant 50g consolation + banner).
 *
 * ── Why a separate module ──────────────────────────────────────────────────
 * Cohort 6 (forestChests.js) handles the 3-option treasure-chest modal off
 * minibosses / elites. Cohort 8 (forestPickups.js) handles consumable floor
 * drops (bomb / magnet / chicken) off every kill. This module is the third
 * forest-only drop layer: a single ground weapon icon that, on contact, adds
 * a new weapon to the hero's kit at L1 (a "treasure" pickup VS-style). Kept
 * out of forestPickups.js because the on-pickup dispatch path is fundamentally
 * different — it routes through `acquireWeapon` (the existing weapon helper)
 * rather than firing an inline gameplay effect.
 *
 * ── Drop rules (forest only) ───────────────────────────────────────────────
 *   • room-boss kill (enemy._isRoomBoss)        — 15%
 *   • miniboss kill  (enemy.isMiniBoss)         —  5%
 *   • elite kill     (enemy.elite)              —  5%
 * Highest applicable rate wins (single roll). isFinalBoss / isNemesis carve
 * outs are enforced at the call site in enemies.js to keep this module out
 * of the boss reward path.
 *
 * ── Drop pool ──────────────────────────────────────────────────────────────
 * ANY weapon from REGISTRY that:
 *   • is not flagged `hidden: true` (excludes Forest specials + coffin
 *     evolutions — they're equipped via meta unlock / coffin dispatch).
 *   • isn't already owned by the hero (state.weapons).
 * Picked uniformly at random. If the filtered pool is empty (every visible
 * weapon owned) → fall back to a 50–100g gold grant immediately (no pickup
 * entity placed).
 *
 * ── Pre-pool ───────────────────────────────────────────────────────────────
 * CAP = 4 active pickups. Pre-allocated InstancedMesh for body (PlaneGeometry
 * 0.5x0.5, flat-on-ground) + sparkle ring (RingGeometry 0.35/0.5). Zero
 * per-spawn allocation. Per-slot Uint8Array `_phase` + Float32Array `_phaseT`,
 * `_posX`, `_posZ`, plus a per-slot weapon-id string array (lookup-only; the
 * `acquireWeapon` call doesn't touch the array between spawn and pickup).
 *
 * ── Palette (slot-locked) ──────────────────────────────────────────────────
 *   slot 1 #c7b89a — pickup body silhouette (default bone)
 *   slot 7 #ffd86b — sparkle ring + body fallback when palette accent absent
 *
 * ── Self-gating ────────────────────────────────────────────────────────────
 * On pickup detect → `_phase[i] = CP_COLLECTED` IMMEDIATELY. The dispatch
 * side-effect (acquireWeapon OR consolation gold) fires exactly once, then
 * the slot transitions to CP_DESPAWN via shrink-fade. No re-entry; double-
 * pickup is impossible.
 *
 * ── Pickup detect ──────────────────────────────────────────────────────────
 * AABB box test (brief-specified, distinct from the circle test forestPickups
 * uses): `|dx| <= PICKUP_R && |dz| <= PICKUP_R`, PICKUP_R = 0.7.
 *
 * ── Linger ─────────────────────────────────────────────────────────────────
 * 60s auto-despawn from spawn (LINGER_SEC). No magnet-multiplier scaling on
 * AABB — keeps the box test boring + predictable, matches brief.
 *
 * ── Drop hook ──────────────────────────────────────────────────────────────
 * Wired from src/enemies.js killEnemy() via a single static import + one
 * call: `dropForestWeapon(enemy.mesh.position, enemy)`. The module reads the
 * enemy's miniboss/elite/roomboss flags internally and picks the rate.
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from './postfx.js';
import { state as _gameState } from './state.js';
import { REGISTRY, acquireWeapon } from './weapons/index.js';
import { sfx } from './audio.js';
import { showBanner } from './ui.js';

// ── pool cap (per brief) ───────────────────────────────────────────────────
const CAP_PICKUPS = 4;

// ── palette (slot-locked) ──────────────────────────────────────────────────
const SLOT1_BONE  = 0xc7b89a; // body silhouette default
const SLOT7_GOLD  = 0xffd86b; // sparkle ring + body fallback

// ── drop tunables (per brief) ──────────────────────────────────────────────
const DROP_RATE_ROOMBOSS = 0.15;
const DROP_RATE_MINIBOSS = 0.05;
const DROP_RATE_ELITE    = 0.05;

// ── pickup tunables ────────────────────────────────────────────────────────
const PICKUP_R         = 0.7;        // AABB half-extent
const LINGER_SEC       = 60.0;       // auto-despawn from spawn
const DESPAWN_SEC      = 0.35;       // shrink-fade after collected
const BODY_Y           = 0.05;       // body plane hover-above-ground
const BODY_SIZE        = 0.5;        // plane edge length
const SPARKLE_Y        = 0.95;       // sparkle halo height
const SPARKLE_R_INNER  = 0.35;
const SPARKLE_R_OUTER  = 0.50;
const KIT_VISIBLE_CAP  = 6;          // brief — hard cap on visible kit
const CONSOLATION_GOLD = 50;         // brief — kit-full consolation
const FALLBACK_GOLD_MIN = 50;        // brief — pool-empty fallback
const FALLBACK_GOLD_MAX = 100;       // brief — pool-empty fallback
const BANNER_DUR_SEC    = 2.0;       // pickup banner linger

// ── phase codes (mirrors forestPickups.js / forestChests.js) ───────────────
const CP_FREE      = 0;
const CP_WAIT      = 1;
const CP_COLLECTED = 2;
const CP_DESPAWN   = 3;

// ── module state ───────────────────────────────────────────────────────────
let _loaded = false;
let _scene = null;
let _group = null;
let _disposables = [];
let _clock = 0;

// Per-slot pool arrays.
let _phase   = null;   // Uint8Array(CAP_PICKUPS)
let _phaseT  = null;   // Float32Array(CAP_PICKUPS)
let _posX    = null;   // Float32Array(CAP_PICKUPS)
let _posZ    = null;   // Float32Array(CAP_PICKUPS)
let _wpnIds  = null;   // string[CAP_PICKUPS] — weapon id staged per slot

// InstancedMesh handles.
let _bodyMesh = null;
let _sparkleMesh = null;

// Reusable scratch — zero per-frame allocation.
const _dummy = new THREE.Object3D();
const _zeroDummy = new THREE.Object3D();
_zeroDummy.scale.set(0, 0, 0);
_zeroDummy.updateMatrix();
const _ZERO_MATRIX = _zeroDummy.matrix.clone();

function _track(obj) { _disposables.push(obj); }

// ── mesh builders ──────────────────────────────────────────────────────────
function _buildBodyMesh() {
  // PlaneGeometry, rotated to lie flat on the ground. Top-down ortho camera
  // reads the plane as a billboard — same trick used by forestPickups bomb
  // sparks and the existing chest sparkle rings.
  const geo = new THREE.PlaneGeometry(BODY_SIZE, BODY_SIZE);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: SLOT1_BONE,
    transparent: true,
    opacity: 0.95,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  _bodyMesh = new THREE.InstancedMesh(geo, mat, CAP_PICKUPS);
  _bodyMesh.frustumCulled = false;
  _bodyMesh.userData.pickupPart = 'weaponDropBody';
  _track(geo); _track(mat);
}

function _buildSparkleMesh() {
  const geo = new THREE.RingGeometry(SPARKLE_R_INNER, SPARKLE_R_OUTER, 16);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: SLOT7_GOLD,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  _sparkleMesh = new THREE.InstancedMesh(geo, mat, CAP_PICKUPS);
  _sparkleMesh.layers.enable(BLOOM_LAYER);
  _sparkleMesh.frustumCulled = false;
  _sparkleMesh.userData.pickupPart = 'weaponDropSparkle';
  _track(geo); _track(mat);
}

function _zeroInstanced(mesh, cap) {
  if (!mesh) return;
  for (let i = 0; i < cap; i++) mesh.setMatrixAt(i, _ZERO_MATRIX);
  mesh.instanceMatrix.needsUpdate = true;
}

function _zeroAllMatrices() {
  _zeroInstanced(_bodyMesh, CAP_PICKUPS);
  _zeroInstanced(_sparkleMesh, CAP_PICKUPS);
}

// ── stamping ───────────────────────────────────────────────────────────────
function _stampBody(i, x, z, scale) {
  // Gentle bob via _clock + slot-offset so multiple pickups don't visually
  // sync. Scale is read by the despawn animator.
  const bob = BODY_Y + Math.sin(_clock * 2.0 + i * 1.1) * 0.04;
  _dummy.position.set(x, bob, z);
  _dummy.rotation.set(0, 0, 0);
  _dummy.scale.setScalar(scale);
  _dummy.updateMatrix();
  _bodyMesh.setMatrixAt(i, _dummy.matrix);
  _bodyMesh.instanceMatrix.needsUpdate = true;
}

function _stampSparkle(i, x, z, scale) {
  const yaw = _clock * 1.8 + i * 0.78;
  const bob = SPARKLE_Y + Math.sin(_clock * 2.2 + i * 1.2) * 0.06;
  _dummy.position.set(x, bob, z);
  _dummy.rotation.set(0, yaw, 0);
  _dummy.scale.setScalar(scale);
  _dummy.updateMatrix();
  _sparkleMesh.setMatrixAt(i, _dummy.matrix);
  _sparkleMesh.instanceMatrix.needsUpdate = true;
}

function _hideSlot(i) {
  _bodyMesh.setMatrixAt(i, _ZERO_MATRIX);
  _sparkleMesh.setMatrixAt(i, _ZERO_MATRIX);
  _bodyMesh.instanceMatrix.needsUpdate = true;
  _sparkleMesh.instanceMatrix.needsUpdate = true;
}

// ── pool allocation ────────────────────────────────────────────────────────
function _allocSlot() {
  for (let i = 0; i < CAP_PICKUPS; i++) {
    if (_phase[i] === CP_FREE) return i;
  }
  return -1;
}

// ── drop pool + rate helpers ───────────────────────────────────────────────
/**
 * Compute the spawn rate for this enemy, taking the highest applicable
 * gate. Returns 0 when no gate matches (single-roll, no double-counting).
 * Note: room-boss flag may co-exist with isMiniBoss on the same enemy; we
 * choose the 15% room-boss rate in that case (the brief lists it first +
 * with the highest rate).
 */
function _rateForEnemy(enemy) {
  if (!enemy) return 0;
  if (enemy._isRoomBoss) return DROP_RATE_ROOMBOSS;
  if (enemy.isMiniBoss)  return DROP_RATE_MINIBOSS;
  if (enemy.elite)       return DROP_RATE_ELITE;
  return 0;
}

/**
 * Build the pool of weapon ids the hero doesn't yet own and that are eligible
 * (non-hidden in REGISTRY). Cheap enough to recompute per drop (REGISTRY has
 * ~26 entries; state.weapons typically <8). Returns array of ids.
 */
function _eligibleWeaponPool() {
  const owned = new Set((_gameState.weapons || []).map(w => w.id));
  const pool = [];
  for (const id of Object.keys(REGISTRY)) {
    const mod = REGISTRY[id];
    if (!mod) continue;
    if (mod.hidden === true) continue;   // exclude Forest specials + coffin evos + superweapons
    if (owned.has(id)) continue;
    pool.push(id);
  }
  return pool;
}

/**
 * Count visible (non-hidden) weapons currently on the hero. The hidden
 * Forest specials + coffin evolutions sit in state.weapons but don't count
 * against the player's "kit slot" budget. Cohort 8 / brief default.
 */
function _visibleKitCount() {
  const list = _gameState.weapons || [];
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    const mod = REGISTRY[list[i].id];
    if (mod && mod.hidden === true) continue;
    n++;
  }
  return n;
}

function _humanizeWeaponName(id) {
  const mod = REGISTRY[id];
  if (mod && typeof mod.name === 'string' && mod.name.length > 0) return mod.name;
  // Fallback: capitalize id (snake_case → Title Case). Defensive — every
  // weapon in REGISTRY actually has a `.name`, but this keeps the banner
  // legible if a future weapon is added without one.
  return String(id || 'WEAPON').split('_').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
}

function _grantConsolationGold(amount) {
  if (!_gameState.run) return;
  _gameState.run.gold = (_gameState.run.gold || 0) + amount;
}

// ── on-pickup dispatch ─────────────────────────────────────────────────────
function _dispatchPickup(weaponId) {
  if (!_gameState) return;
  // Kit cap check — visible (non-hidden) only. If full → consolation gold +
  // banner. Otherwise acquireWeapon (existing helper). acquireWeapon also
  // handles the rare race where the same id was acquired between drop +
  // pickup (level-up card pick during the linger window): it'll just level
  // up the existing entry, which is a fair outcome — pickup still felt good.
  const kit = _visibleKitCount();
  if (kit >= KIT_VISIBLE_CAP) {
    _grantConsolationGold(CONSOLATION_GOLD);
    try { showBanner(`WEAPONS FULL — ${CONSOLATION_GOLD}G CONSOLATION`, BANNER_DUR_SEC, '#ffd86b'); } catch (_) {}
  } else {
    try { acquireWeapon(weaponId); }
    catch (e) { console.warn('[forestWeaponDrops] acquireWeapon failed:', weaponId, e); }
    const name = _humanizeWeaponName(weaponId);
    try { showBanner(`PICKED UP: ${name.toUpperCase()}`, BANNER_DUR_SEC, '#ffd86b'); } catch (_) {}
  }
  // SFX bouquet — evolutionChime is already wired in cohort 13 / audio.js;
  // _play() is a no-op when the bank's missing so this is safe in tests.
  try { sfx.evolutionChime && sfx.evolutionChime(); } catch (_) {}
}

// ── public drop API ────────────────────────────────────────────────────────
/**
 * Drop a weapon pickup at the given world position for the given enemy.
 * Silently no-op when:
 *   • the module hasn't loaded (non-forest stage),
 *   • the enemy doesn't qualify (rate=0),
 *   • the rate roll fails,
 *   • all CAP_PICKUPS slots are in use.
 *
 * Pool-empty branch: when the rate roll passes but no eligible weapon
 * remains (hero already owns every visible weapon), grant 50–100g gold
 * instead of placing a pickup. This branch ALSO bypasses the active-pickup
 * cap (gold is just a state mutation).
 *
 * @param {{x:number,z:number}|THREE.Vector3} pos enemy death position
 * @param {Object} enemy enemy record (reads _isRoomBoss / isMiniBoss / elite)
 * @returns {string|null} pickup id ('weapon_drop'), 'gold_fallback', or null
 */
export function dropForestWeapon(pos, enemy) {
  if (!_loaded) return null;
  if (!pos) return null;
  const rate = _rateForEnemy(enemy);
  if (rate <= 0) return null;
  if (Math.random() >= rate) return null;

  // Pool-empty → consolation gold (no pickup entity, no cap check).
  const pool = _eligibleWeaponPool();
  if (pool.length === 0) {
    const amount = FALLBACK_GOLD_MIN + Math.floor(Math.random() * (FALLBACK_GOLD_MAX - FALLBACK_GOLD_MIN + 1));
    _grantConsolationGold(amount);
    return 'gold_fallback';
  }

  // Cap check (4 active pickups). Silent skip — brief: "Hard cap: 4 active
  // pickups at once." No consolation here; the player will get future drops.
  const i = _allocSlot();
  if (i < 0) return null;

  const x = (typeof pos.x === 'number') ? pos.x : 0;
  const z = (typeof pos.z === 'number') ? pos.z : 0;
  const wpnId = pool[Math.floor(Math.random() * pool.length)];

  _phase[i] = CP_WAIT;
  _phaseT[i] = 0;
  _posX[i] = x;
  _posZ[i] = z;
  _wpnIds[i] = wpnId;
  _stampBody(i, x, z, 1.0);
  _stampSparkle(i, x, z, 1.0);
  return 'weapon_drop';
}

// ── per-frame tick ─────────────────────────────────────────────────────────
/**
 * Pickup detection, sparkle/body anim, collected-shrink, 60s linger
 * auto-despawn. AABB pickup test (brief — distinct from forestPickups
 * circle). Bails immediately when not loaded.
 *
 * @param {Object} state GameState
 * @param {number} dt    logic delta in seconds
 */
export function tickForestWeaponDrops(state, dt) {
  if (!_loaded) return;
  if (!state) return;
  _clock += dt;

  const heroAlive = state.hero && !state.gameOver;
  const hx = heroAlive ? state.hero.pos.x : 0;
  const hz = heroAlive ? state.hero.pos.z : 0;

  for (let i = 0; i < CAP_PICKUPS; i++) {
    const phase = _phase[i];
    if (phase === CP_FREE) continue;
    _phaseT[i] += dt;
    const t = _phaseT[i];
    const cx = _posX[i], cz = _posZ[i];

    if (phase === CP_WAIT) {
      // AABB pickup test (brief — `r=0.7 AABB`). Self-gating: transition to
      // COLLECTED IMMEDIATELY so a double-frame doesn't double-dispatch.
      if (heroAlive) {
        const dx = hx - cx, dz = hz - cz;
        if (Math.abs(dx) <= PICKUP_R && Math.abs(dz) <= PICKUP_R) {
          const wpnId = _wpnIds[i];
          _phase[i] = CP_COLLECTED;
          _phaseT[i] = 0;
          // Dispatch BEFORE shrink-stamp so a future state mutation can't
          // see the slot mid-transition.
          _dispatchPickup(wpnId);
          _stampBody(i, cx, cz, 0.001);
          _stampSparkle(i, cx, cz, 0.001);
          continue;
        }
      }
      // 60s auto-despawn from spawn.
      if (t >= LINGER_SEC) {
        _phase[i] = CP_DESPAWN;
        _phaseT[i] = 0;
        _hideSlot(i);
        continue;
      }
      // Idle repaint — sparkle spin + body bob.
      _stampBody(i, cx, cz, 1.0);
      _stampSparkle(i, cx, cz, 1.0);
    } else if (phase === CP_COLLECTED) {
      // Shrink-fade over DESPAWN_SEC, then free the slot.
      const k = Math.min(1, t / DESPAWN_SEC);
      const s = Math.max(0.001, 1.0 - k);
      _stampBody(i, cx, cz, s);
      _stampSparkle(i, cx, cz, s);
      if (t >= DESPAWN_SEC) {
        _phase[i] = CP_FREE;
        _phaseT[i] = 0;
        _wpnIds[i] = null;
        _hideSlot(i);
      }
    } else if (phase === CP_DESPAWN) {
      // Linger-out transition slot — already hidden, just free it.
      _phase[i] = CP_FREE;
      _phaseT[i] = 0;
      _wpnIds[i] = null;
    }
  }
}

// ── public load / dispose ──────────────────────────────────────────────────
/**
 * Build pre-pooled pickup meshes. Idempotent — gated on `_loaded` so a
 * double-load is a no-op. Called from arenaDecor.js (`loadArenaDecor` →
 * `_buildForestDecor`) under the once-per-scene `state._weaponDropsLoaded`
 * gate, mirroring chests/pickups/reaper.
 *
 * @param {THREE.Scene} scene
 * @param {Object} _state GameState (unused at load; tick reads hero/run).
 */
export function loadForestWeaponDrops(scene, _state) {
  if (_loaded) return;
  if (!scene) return;
  _scene = scene;
  _group = new THREE.Group();
  _group.name = '__forestWeaponDrops';

  _phase   = new Uint8Array(CAP_PICKUPS);
  _phaseT  = new Float32Array(CAP_PICKUPS);
  _posX    = new Float32Array(CAP_PICKUPS);
  _posZ    = new Float32Array(CAP_PICKUPS);
  _wpnIds  = new Array(CAP_PICKUPS).fill(null);

  _buildBodyMesh();
  _buildSparkleMesh();

  _group.add(_bodyMesh);
  _group.add(_sparkleMesh);

  _zeroAllMatrices();
  scene.add(_group);
  _clock = 0;
  _loaded = true;
}

/**
 * Tear down all pickup meshes + pool state. Idempotent — safe to call when
 * not loaded. Mirrors disposeForestPickups / disposeForestChests. The
 * `state._weaponDropsLoaded` flag is flipped back to false by the caller
 * in main.js so the next forest load gets a fresh pool.
 *
 * @param {THREE.Scene} scene
 */
export function disposeForestWeaponDrops(scene) {
  if (!_loaded && !_group) return;
  if (_group) {
    if (scene && _group.parent === scene) scene.remove(_group);
    else if (_group.parent) _group.parent.remove(_group);
    _group = null;
  }
  for (let i = 0; i < _disposables.length; i++) {
    const d = _disposables[i];
    try { d.dispose && d.dispose(); } catch (_) {}
  }
  _disposables = [];
  _bodyMesh = null;
  _sparkleMesh = null;
  _phase = _phaseT = _posX = _posZ = null;
  _wpnIds = null;
  _scene = null;
  _clock = 0;
  _loaded = false;
}
