/**
 * Cozy home decoration — placement engine + catalog.
 *
 * Owns:
 *   - HOME_CATALOG: the 16 player-decoratable items (3 default-unlocked + 13
 *     achievement-gated). Each entry binds a GLB key (assets.js#preloadAll),
 *     a footprint (floor grid tiles or "wall" type), and an unlockCheck()
 *     predicate against meta.js flags. Items that pass unlockCheck but aren't
 *     yet in meta.homeUnlocks are awarded via syncHomeUnlocks() — fired on
 *     every interior enter and on every claimed achievement.
 *   - The 10×10 floor grid (1u tile = 1u world-space), centered at room
 *     origin. Reserved tiles mask the 6 existing fixture footprints (door,
 *     renovations desk, sketchbook easel, tea kettle, computer desk, yarn
 *     basket) + the fireplace's east-wall offset.
 *   - The 8-slot-per-wall hangable layout (32 wall slots total). Walls are
 *     keyed N/S/E/W relative to the room (south = door wall).
 *   - openDecorateMode / closeDecorateMode — DOM overlay lifecycle. Decorate
 *     mode is a module-local _decorateActive flag, NOT a new state.mode value
 *     (main.js's mode branch is hands-off). While active, the regular
 *     interior interactable prompt is suppressed and hero input is frozen
 *     via state.time.paused (matches the existing modal contract).
 *
 * Persistence: meta.homePlacements + meta.homeUnlocks. Cap = 30 placements
 * to keep the room render budget sane.
 *
 * Pattern siblings: town.js (interactable list + DOM prompt), interior.js
 * (group toggling + room rebuild on enter).
 */

import * as THREE from 'three';
import { state } from './state.js';
import {
  getMeta, saveMeta,
  isHomeItemUnlocked, unlockHomeItem,
  listHomePlacements, setHomePlacements,
} from './meta.js';
import { cloneCached } from './assets.js';
import { sfx } from './audio.js';
import { gamepadState } from './gamepad.js';
import { consumePadInteract } from './input.js';

// ── Room geometry (mirrors interior.js constants — keep in sync) ────────────
export const ROOM_W = 14;
export const ROOM_D = 11;
export const WALL_H = 4;
const DOOR_W = 2.4;

// ── Grid (centered at room origin, 10 cols × 8 rows because room is 14×11
// world-space with 0.5u margins for walls). Tile pitch = 1u. ───────────────
export const TILE = 1.0;
export const GRID_COLS = 10;     // x axis
export const GRID_ROWS = 8;      // z axis
// Helpers — tile (gx, gz) coords run gx ∈ [0..GRID_COLS-1], gz ∈ [0..GRID_ROWS-1].
// World position of the tile *center*:
export function tileToWorld(gx, gz) {
  // Origin sits between tile (4.5, 3.5). Subtract half-grid + 0.5 to center.
  const wx = (gx - (GRID_COLS - 1) / 2) * TILE;
  const wz = (gz - (GRID_ROWS - 1) / 2) * TILE;
  return { x: wx, z: wz };
}
export function worldToTile(wx, wz) {
  const gx = Math.round(wx / TILE + (GRID_COLS - 1) / 2);
  const gz = Math.round(wz / TILE + (GRID_ROWS - 1) / 2);
  return { gx, gz };
}

// ── Reserved tiles — fixture footprints that must NOT accept placements.
// Each tuple = [gx, gz]. Fixtures (interior.js):
//   Renovations Desk  at world (-4.0, -2.0)  → tile (0.5..1.5, 1.5..2.5) →   (0,1)(0,2)(1,1)(1,2)
//   Sketchbook Easel  at world ( 4.0, -2.0)  → tile (8,1)(8,2)(9,1)(9,2)
//   Tea Kettle        at world ( 0.0, -4.0)  → tile (4,0)(4,1)(5,0)(5,1)
//   Yarn Basket       at world ( 5.5,  2.2)  → tile (9,5)(9,6)
//   Computer Desk     at world (-5.5,  2.2)  → tile (0,5)(0,6)
//   Fireplace         at world (-7,    2.5) (east wall) → tile (0,6)(0,7)
//   Door zone (south) (x in ±DOOR_W/2 at gz=GRID_ROWS-1) → tile (4,7)(5,7)
// We do a generous 2x2 envelope around each fixture for the desk-like ones so
// the player can't drop a chair into the easel's bounding box.
const RESERVED_TILES = new Set([
  // Renovations desk envelope
  '0,1','0,2','1,1','1,2',
  // Sketchbook easel envelope
  '8,1','8,2','9,1','9,2',
  // Tea kettle envelope
  '4,0','4,1','5,0','5,1',
  // Yarn basket
  '9,5','9,6',
  // Computer desk
  '0,5','0,6',
  // Fireplace strip (west wall, south side). '0,6' already covered by the
  // computer desk envelope above — Set dedups so it's harmless either way.
  '0,7',
  // Door zone (south wall middle 2 tiles)
  '4,7','5,7',
]);
export function isReserved(gx, gz) {
  return RESERVED_TILES.has(`${gx},${gz}`);
}
export function inBounds(gx, gz) {
  return gx >= 0 && gx < GRID_COLS && gz >= 0 && gz < GRID_ROWS;
}

// ── Wall slots (8 per wall, 4 walls). Wall sides: 'N' (-z), 'S' (+z), 'E'
// (+x), 'W' (-x). Slot 0 starts at the wall's "left" side when viewed from
// inside the room (so the slot index reads left-to-right consistently).
// Each wall has its own length: N/S walls are ROOM_W=14 long; E/W walls are
// ROOM_D=11. Padding = 0.7u from each corner. 8 slots distribute evenly.
export const WALL_SLOTS = 8;
const WALL_PAD = 0.7;
export function wallSlotToWorld(side, slot) {
  const t = slot / (WALL_SLOTS - 1);   // 0..1
  if (side === 'N') {
    const usable = ROOM_W - 2 * WALL_PAD;
    return { x: -ROOM_W / 2 + WALL_PAD + t * usable, y: 2.4, z: -ROOM_D / 2 + 0.2, rotY: 0 };
  }
  if (side === 'S') {
    const usable = ROOM_W - 2 * WALL_PAD;
    return { x:  ROOM_W / 2 - WALL_PAD - t * usable, y: 2.4, z:  ROOM_D / 2 - 0.2, rotY: Math.PI };
  }
  if (side === 'E') {
    const usable = ROOM_D - 2 * WALL_PAD;
    return { x:  ROOM_W / 2 - 0.2, y: 2.4, z: -ROOM_D / 2 + WALL_PAD + t * usable, rotY: -Math.PI / 2 };
  }
  // 'W'
  const usable = ROOM_D - 2 * WALL_PAD;
  return { x: -ROOM_W / 2 + 0.2, y: 2.4, z:  ROOM_D / 2 - WALL_PAD - t * usable, rotY:  Math.PI / 2 };
}

// ── HOME_CATALOG ─────────────────────────────────────────────────────────────
// id          stable key — also persisted on placements
// name        player-facing label
// icon        emoji palette icon
// glb         assets.js cache key (cloneCached)
// scale       uniform scale applied to cloned mesh
// gridSize    [w, d] in tiles for floor items; absent for wall items
// wall        true for wall items (banners, mounts)
// elev        y-offset applied after placing (for skull mount eye-line, etc.)
// unlock      flavor text shown in the locked-tooltip
// unlockCheck (meta) => bool — predicate against existing flags
// flavor      decorate-toast subtitle when first unlocked
//
// All bind to existing achievement / mode flags — no new tracking introduced.
// First three (rug, plant, lamp) are default-unlocked.
export const HOME_CATALOG = [
  {
    id: 'rug', name: 'Round Rug', icon: '🟤',
    glb: 'home_rug', scale: 2.4, gridSize: [2, 2], elev: 0.02,
    unlock: 'Start a hearth.',
    unlockCheck: () => true,
  },
  {
    id: 'plant', name: 'Potted Plant', icon: '🪴',
    glb: 'home_plant', scale: 0.012, gridSize: [1, 1],
    unlock: 'A green thumb costs nothing.',
    unlockCheck: () => true,
  },
  {
    id: 'lamp', name: 'Standing Lamp', icon: '💡',
    glb: 'home_lamp', scale: 1.4, gridSize: [1, 1],
    unlock: 'Light begets light.',
    unlockCheck: () => true,
    // Small warm point-light attached on instantiate.
    emissive: { y: 1.8, color: 0xffd28a, intensity: 0.35, range: 4.5 },
  },
  {
    id: 'bed', name: 'Cozy Bed', icon: '🛏',
    glb: 'home_bed', scale: 1.7, gridSize: [2, 3],
    unlock: 'Survive your first run.',
    unlockCheck: (m) => !!(m.achievements && m.achievements.first_victory),
    flavor: 'rest is earned',
  },
  {
    id: 'bookshelf', name: 'Tall Bookshelf', icon: '📚',
    glb: 'home_bookshelf', scale: 2.0, gridSize: [1, 1],
    unlock: 'Open your first chest.',
    unlockCheck: (m) => !!(m.achievements && m.achievements.first_chest),
    flavor: 'a library of small triumphs',
  },
  {
    id: 'cauldron', name: 'Bubbling Cauldron', icon: '🧪',
    glb: 'home_cauldron', scale: 1.4, gridSize: [1, 1],
    unlock: 'Defeat any elite.',
    unlockCheck: (m) => !!(m.achievements && m.achievements.first_elite),
    flavor: 'brew the impossible',
    emissive: { y: 0.55, color: 0x6affad, intensity: 0.5, range: 2.5 },
  },
  {
    id: 'chair', name: 'Wooden Chair', icon: '🪑',
    glb: 'home_chair', scale: 1.5, gridSize: [1, 1],
    unlock: 'Score your first kill.',
    unlockCheck: (m) => !!(m.achievements && m.achievements.first_kill),
    flavor: 'somewhere to sit',
  },
  {
    id: 'side_table', name: 'Side Table', icon: '🟫',
    glb: 'home_side_table', scale: 1.4, gridSize: [1, 1],
    unlock: 'Discover a weapon evolution.',
    unlockCheck: (m) => !!(m.achievements && m.achievements.first_evolution),
    flavor: 'set down the burden',
  },
  {
    id: 'sofa', name: 'Velvet Sofa', icon: '🛋',
    glb: 'home_sofa', scale: 1.7, gridSize: [2, 1],
    unlock: 'Reach 100 kills in a single run.',
    unlockCheck: (m) => !!(m.achievements && m.achievements.kills_100),
    flavor: 'collapse comfortably',
  },
  {
    id: 'cat', name: 'House Cat', icon: '🐈',
    glb: 'home_cat', scale: 1.4, gridSize: [1, 1],
    unlock: 'Sweep all 3 mini-bosses in one run.',
    unlockCheck: (m) => !!(m.achievements && m.achievements.minibox_x3),
    flavor: 'a small companion',
  },
  {
    id: 'chest', name: 'Treasure Chest', icon: '🎁',
    glb: 'home_chest', scale: 1.6, gridSize: [1, 1],
    unlock: 'Hit a 7-7-7 jackpot.',
    unlockCheck: (m) => !!(m.achievements && m.achievements.first_jackpot),
    flavor: 'the house always wins',
  },
  // ── Wall items (5) ────────────────────────────────────────────────────────
  {
    id: 'banner_wall', name: 'Hung Banner', icon: '🏳',
    glb: 'home_banner_wall', scale: 1.8, wall: true,
    unlock: 'Clear Hyper Mode for the first time.',
    unlockCheck: (m) => !!m.unlockedHyper,
    flavor: 'hung above your hearth',
  },
  {
    id: 'banner_alt', name: 'Cinder Banner', icon: '🚩',
    glb: 'home_banner_alt', scale: 1.6, wall: true,
    unlock: 'Unlock Cinder Caverns.',
    unlockCheck: (m) => !!m.unlockedCinder,
    flavor: 'red threads, scorched edges',
  },
  {
    id: 'sword_mount', name: 'Sword on the Wall', icon: '⚔',
    glb: 'home_sword_mount', scale: 1.6, wall: true,
    unlock: 'Unlock Endless Mode.',
    unlockCheck: (m) => !!m.unlockedEndless,
    flavor: 'mounted, not retired',
  },
  {
    id: 'shield_mount', name: 'Celtic Shield', icon: '🛡',
    glb: 'home_shield_mount', scale: 1.5, wall: true,
    unlock: 'Win on Twilight Hollow.',
    unlockCheck: (m) => !!(m.achievements && m.achievements.champion_twilight),
    flavor: 'a hollow that did not hold',
  },
  {
    id: 'skull_mount', name: 'Boss Trophy', icon: '💀',
    glb: 'home_skull_mount', scale: 1.6, wall: true,
    unlock: 'Win Boss Rush on Twilight (unlock Clockwork).',
    unlockCheck: (m) => !!m.unlockedClockwork,
    flavor: 'a war trophy, freshly polished',
  },
];

export const HOME_PLACEMENT_CAP = 30;

// ── Module state ────────────────────────────────────────────────────────────
let _decorScene = null;          // THREE.Group attached to interior group
let _placementMeshes = new Map();// id → THREE.Group (one per placement)
let _decorateActive = false;
let _selectedItemId = null;      // catalog id currently held by the cursor
let _cursorMesh = null;          // ground highlight tile
let _wallCursorMesh = null;      // wall-slot indicator
let _hoverTile = null;           // {gx, gz} | null
let _hoverWall = null;           // {side, slot} | null
let _overlayEl = null;
let _paletteEl = null;
let _placementsDirty = false;    // batched save flag — flushed on commit
let _onCloseCb = null;           // optional caller hook (re-show interior prompt)

// ── Iter 23b — gamepad / input-mode state ──────────────────────────────────
// Decorate mode supports mouse+kbm AND gamepad. _inputMode tracks which
// device was last seen so cursor rendering branches cleanly between the
// raycast path (mouse) and the discrete-grid path (gamepad). A mousemove
// flips back to 'mouse'; ANY gamepad activity flips to 'gamepad'.
let _inputMode = 'mouse';        // 'mouse' | 'gamepad'
// Gamepad-driven focus position. Mirrors _hoverTile / _hoverWall shape so
// the rest of the placement plumbing can stay agnostic. When _inputMode is
// 'gamepad' these are the active focus; in 'mouse' they're shadow state
// (kept around so toggling back to gamepad lands where you left off).
let _gpFocusTile = { gx: 5, gz: 4 };   // default = roughly room center
let _gpFocusWall = null;               // { side, slot } when traversed onto a wall
// Left-stick edge detection — analog axes need one-shot-per-deflection
// logic. We track the previous frame's quantized direction and re-fire
// after _STICK_REPEAT_S of continued hold for hold-to-repeat.
let _stickPrevDir = { x: 0, z: 0 };
let _stickRepeatT = 0;
const _STICK_THRESH = 0.55;
const _STICK_REPEAT_S = 0.18;
// D-pad hold-to-repeat (held buttons re-fire after the same cadence so
// players can sweep across the grid without machine-gunning the d-pad).
let _dpadRepeatT = { up: 0, down: 0, left: 0, right: 0 };
const _DPAD_REPEAT_S = 0.18;
// Frame timer (delta accumulated each tickHomeDecor for repeat math).
let _lastTickT = 0;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Attach the decor scene group to the supplied parent (the interior group).
 * Idempotent — repeated calls return the cached group.
 */
export function initHomeDecor(parent) {
  if (_decorScene) return _decorScene;
  _decorScene = new THREE.Group();
  _decorScene.name = 'homeDecorGroup';
  parent.add(_decorScene);
  return _decorScene;
}

/**
 * Re-instantiate every persisted placement into the scene. Called by
 * interior.js#enterInterior so the room reflects the saved meta on each
 * walk-in (and any items unlocked since last visit are pre-applied).
 */
export function rebuildPlacements() {
  if (!_decorScene) return;
  // Clear previous instances
  for (const [, mesh] of _placementMeshes) {
    if (mesh.parent) mesh.parent.remove(mesh);
  }
  _placementMeshes.clear();
  const list = listHomePlacements();
  for (const p of list) {
    const mesh = _spawnPlacementMesh(p);
    if (mesh) _placementMeshes.set(p.id, mesh);
  }
}

/**
 * Diff existing meta.homeUnlocks against HOME_CATALOG.unlockCheck and grant
 * any newly-eligible item. Returns the array of newly-granted catalog defs
 * so the caller can toast them (interior.js fires this on enter, but other
 * call sites — death screen, achievement claim — can also trigger).
 */
export function syncHomeUnlocks() {
  const meta = getMeta();
  if (!meta.homeUnlocks) meta.homeUnlocks = {};
  const granted = [];
  for (const item of HOME_CATALOG) {
    if (meta.homeUnlocks[item.id]) continue;
    let ok = false;
    try { ok = !!item.unlockCheck(meta); } catch (_) { ok = false; }
    if (ok) {
      meta.homeUnlocks[item.id] = Date.now();
      granted.push(item);
    }
  }
  if (granted.length) saveMeta();
  return granted;
}

/** True while the player is actively decorating (palette open). */
export function isDecorateActive() { return _decorateActive; }

/**
 * Open the decorate-mode DOM overlay. Suppresses the interior interactable
 * prompt by setting state.time.paused (existing modal contract) and showing
 * a fullscreen-but-non-blocking palette pinned to the left edge so the room
 * stays visible.
 */
export function openDecorateMode() {
  if (_decorateActive) return;
  _decorateActive = true;
  try { sfx.modalOpen(); } catch (_) {}
  // Pause hero input — same pattern as showHouse() etc.
  if (state.time) state.time.paused = true;
  // Sync unlocks once on open so the palette reflects the latest flags.
  syncHomeUnlocks();
  _buildOverlay();
  _attachInputListeners();
  _ensureCursors();
}

export function closeDecorateMode() {
  if (!_decorateActive) return;
  _decorateActive = false;
  try { sfx.modalOpen(); } catch (_) {}
  if (state.time) state.time.paused = false;
  _detachInputListeners();
  _destroyOverlay();
  _hideCursors();
  _selectedItemId = null;
  _hoverTile = null;
  _hoverWall = null;
  // Iter 23b — reset gamepad transients so a re-open lands in mouse mode by
  // default and the d-pad repeat clocks don't carry across sessions.
  _inputMode = 'mouse';
  _gpFocusWall = null;
  _stickPrevDir = { x: 0, z: 0 };
  _stickRepeatT = 0;
  _dpadRepeatT = { up: 0, down: 0, left: 0, right: 0 };
  _lastTickT = 0;
  // Also drain a stale pad-interact queue: B-to-exit fires _gpSecondaryAction
  // which calls closeDecorateMode here; the same B-press already enqueued
  // _padInteractQueued in input.js. If we don't drain it now, the very next
  // frame after close will fire an interact on whatever interactable the
  // hero is standing on. tickHomeDecor already drains while active — this
  // catches the close-mid-frame edge case.
  try { consumePadInteract(); } catch (_) {}
  // Flush any pending placements (defensive — placeItem saves immediately,
  // but a session crash mid-rotate could leave _placementsDirty set).
  if (_placementsDirty) { saveMeta(); _placementsDirty = false; }
  if (typeof _onCloseCb === 'function') { try { _onCloseCb(); } catch (_) {} }
}

/** Hook for interior.js — called after closeDecorateMode() finishes. */
export function setOnClose(cb) { _onCloseCb = cb; }

/**
 * Per-frame tick from interior.js. Updates cursor position from the mouse,
 * snaps to the nearest tile or wall slot. No-op while decorate mode is off.
 * Iter 23b — also services gamepad navigation + button actions.
 */
export function tickHomeDecor() {
  if (!_decorateActive) return;
  // Derive dt locally — interior.js's tickInterior() doesn't forward one to
  // us, and we only need it for the stick/d-pad hold-to-repeat clocks.
  const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
  const dt = _lastTickT ? Math.min(0.1, (now - _lastTickT) / 1000) : 0;
  _lastTickT = now;
  // Drain the global pad-interact queue regardless of input mode — if we
  // don't, B-press for "exit decorate" would also fire an interact on the
  // first frame after closing decorate. We consume it now and route it
  // through our own gamepad dispatcher below.
  const padInteract = consumePadInteract();
  _gpTick(dt, padInteract);
  _updateCursor();
}

// ── Mesh instantiation ──────────────────────────────────────────────────────

function _spawnPlacementMesh(p) {
  const def = HOME_CATALOG.find(c => c.id === p.itemId);
  if (!def) return null;
  const group = new THREE.Group();
  group.name = `homePlace_${p.itemId}_${p.id}`;
  const kit = cloneCached(def.glb);
  if (kit) {
    kit.scale.setScalar(def.scale || 1);
    kit.traverse(o => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    group.add(kit);
  } else {
    // Fallback: warm-tinted cube so the player still sees their placement
    // when an asset fails to load. Better than an invisible footprint.
    const cube = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.8, 0.6),
      new THREE.MeshStandardMaterial({ color: 0xb6864a, roughness: 0.85 }),
    );
    cube.position.y = 0.4;
    cube.castShadow = true;
    group.add(cube);
  }
  // Emissive bake — bump the cloned mesh's material(s) emissive channel
  // instead of spawning a per-placement PointLight. Three.js's default
  // forward-renderer shader budgets ~8 lights and the interior already
  // has 7 fixed lights; with placement cap = 30 a player who lined the
  // walls with lamps would blow that budget and trigger shader recompiles
  // / silent dropouts. Material emissive renders for free and reads as
  // "warm glow" with no per-placement light cost.
  if (def.emissive && kit) {
    kit.traverse(o => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m && m.emissive && typeof m.emissive.setHex === 'function') {
          m.emissive.setHex(def.emissive.color);
          // Scale up — emissive without a backing light needs a higher value
          // to read at the same warmth as the original PointLight design.
          m.emissiveIntensity = (def.emissive.intensity || 0.5) * 2.4;
          m.needsUpdate = true;
        }
      }
    });
  }
  // Position + rotation
  if (def.wall && p.wallSide) {
    const w = wallSlotToWorld(p.wallSide, p.wallSlot || 0);
    group.position.set(w.x, w.y, w.z);
    group.rotation.y = w.rotY;
    if (def.elev) group.position.y += def.elev;
  } else {
    const w = tileToWorld(p.gridX, p.gridZ);
    group.position.set(w.x, def.elev || 0, w.z);
    group.rotation.y = p.rotY || 0;
  }
  _decorScene.add(group);
  return group;
}

// ── Placement ops ───────────────────────────────────────────────────────────

function _newPlacementId() {
  return 'h' + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
}

function _placementsFootprintAt(gx, gz, excludeId) {
  // True if any *other* placement overlaps tile (gx,gz). Reads from live meta.
  const list = listHomePlacements();
  for (const p of list) {
    if (excludeId && p.id === excludeId) continue;
    const def = HOME_CATALOG.find(c => c.id === p.itemId);
    if (!def || def.wall) continue;
    const [w, d] = def.gridSize || [1, 1];
    for (let dx = 0; dx < w; dx++) {
      for (let dz = 0; dz < d; dz++) {
        if (p.gridX + dx === gx && p.gridZ + dz === gz) return true;
      }
    }
  }
  return false;
}

function _canPlaceAt(def, gx, gz, excludeId) {
  if (def.wall) return false;
  const [w, d] = def.gridSize || [1, 1];
  for (let dx = 0; dx < w; dx++) {
    for (let dz = 0; dz < d; dz++) {
      const tx = gx + dx, tz = gz + dz;
      if (!inBounds(tx, tz)) return false;
      if (isReserved(tx, tz)) return false;
      if (_placementsFootprintAt(tx, tz, excludeId)) return false;
    }
  }
  return true;
}

function _placeFloorItem(itemId, gx, gz) {
  const def = HOME_CATALOG.find(c => c.id === itemId);
  if (!def || def.wall) return false;
  if (!_canPlaceAt(def, gx, gz)) return false;
  const list = listHomePlacements();
  if (list.length >= HOME_PLACEMENT_CAP) return false;
  const placement = { id: _newPlacementId(), itemId, gridX: gx, gridZ: gz, rotY: 0 };
  list.push(placement);
  setHomePlacements(list);
  const mesh = _spawnPlacementMesh(placement);
  if (mesh) _placementMeshes.set(placement.id, mesh);
  try { sfx.uiClick(); } catch (_) {}
  return true;
}

function _placeWallItem(itemId, side, slot) {
  const def = HOME_CATALOG.find(c => c.id === itemId);
  if (!def || !def.wall) return false;
  // No two wall items in the same slot
  const list = listHomePlacements();
  if (list.some(p => p.wallSide === side && p.wallSlot === slot)) return false;
  if (list.length >= HOME_PLACEMENT_CAP) return false;
  const placement = { id: _newPlacementId(), itemId, wallSide: side, wallSlot: slot, rotY: 0 };
  list.push(placement);
  setHomePlacements(list);
  const mesh = _spawnPlacementMesh(placement);
  if (mesh) _placementMeshes.set(placement.id, mesh);
  try { sfx.uiClick(); } catch (_) {}
  return true;
}

function _pickupAt(gx, gz) {
  // Floor pickup — find topmost placement with (gx, gz) inside its footprint.
  const list = listHomePlacements();
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    const def = HOME_CATALOG.find(c => c.id === p.itemId);
    if (!def || def.wall) continue;
    const [w, d] = def.gridSize || [1, 1];
    if (gx >= p.gridX && gx < p.gridX + w && gz >= p.gridZ && gz < p.gridZ + d) {
      // Remove
      const mesh = _placementMeshes.get(p.id);
      if (mesh && mesh.parent) mesh.parent.remove(mesh);
      _placementMeshes.delete(p.id);
      list.splice(i, 1);
      setHomePlacements(list);
      try { sfx.uiClick(); } catch (_) {}
      // Re-equip the picked-up item so the player can place it again.
      _selectedItemId = p.itemId;
      _highlightSelectedPaletteEntry();
      return true;
    }
  }
  return false;
}

function _pickupWallAt(side, slot) {
  const list = listHomePlacements();
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    if (p.wallSide === side && p.wallSlot === slot) {
      const mesh = _placementMeshes.get(p.id);
      if (mesh && mesh.parent) mesh.parent.remove(mesh);
      _placementMeshes.delete(p.id);
      list.splice(i, 1);
      setHomePlacements(list);
      try { sfx.uiClick(); } catch (_) {}
      _selectedItemId = p.itemId;
      _highlightSelectedPaletteEntry();
      return true;
    }
  }
  return false;
}

function _rotateAt(gx, gz) {
  // Find the placement and bump its rotY by 90°.
  const list = listHomePlacements();
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    const def = HOME_CATALOG.find(c => c.id === p.itemId);
    if (!def || def.wall) continue;
    const [w, d] = def.gridSize || [1, 1];
    if (gx >= p.gridX && gx < p.gridX + w && gz >= p.gridZ && gz < p.gridZ + d) {
      p.rotY = ((p.rotY || 0) + Math.PI / 2) % (Math.PI * 2);
      setHomePlacements(list);
      const mesh = _placementMeshes.get(p.id);
      if (mesh) mesh.rotation.y = p.rotY;
      try { sfx.uiClick(); } catch (_) {}
      return true;
    }
  }
  return false;
}

// ── Cursors (ground tile highlight + wall slot indicator) ───────────────────

function _ensureCursors() {
  if (!_decorScene) return;
  if (!_cursorMesh) {
    const geo = new THREE.PlaneGeometry(TILE * 0.94, TILE * 0.94);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x7fffe4, transparent: true, opacity: 0.32,
      depthWrite: false, side: THREE.DoubleSide,
    });
    _cursorMesh = new THREE.Mesh(geo, mat);
    _cursorMesh.position.y = 0.03;
    _decorScene.add(_cursorMesh);
  }
  if (!_wallCursorMesh) {
    const geo = new THREE.PlaneGeometry(1.1, 1.1);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd27f, transparent: true, opacity: 0.36,
      depthWrite: false, side: THREE.DoubleSide,
    });
    _wallCursorMesh = new THREE.Mesh(geo, mat);
    _decorScene.add(_wallCursorMesh);
  }
  _cursorMesh.visible = false;
  _wallCursorMesh.visible = false;
}

function _hideCursors() {
  if (_cursorMesh) _cursorMesh.visible = false;
  if (_wallCursorMesh) _wallCursorMesh.visible = false;
}

const _raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _mouse = { clientX: 0, clientY: 0 };

function _floorIntersect() {
  // Cast against a virtual plane at y=0; computed analytically.
  const cam = state.camera;
  if (!cam) return null;
  const dom = state.renderer && state.renderer.domElement;
  if (!dom) return null;
  const rect = dom.getBoundingClientRect();
  const nx = ((_mouse.clientX - rect.left) / rect.width) * 2 - 1;
  const ny = -(((_mouse.clientY - rect.top) / rect.height) * 2 - 1);
  _ndc.set(nx, ny);
  _raycaster.setFromCamera(_ndc, cam);
  // Plane y=0 intersection
  const o = _raycaster.ray.origin, d = _raycaster.ray.direction;
  if (Math.abs(d.y) < 1e-6) return null;
  const t = -o.y / d.y;
  if (t <= 0) return null;
  return { x: o.x + d.x * t, z: o.z + d.z * t };
}

function _nearestWallSlot(wx, wz) {
  // Pick wall by which boundary the cursor is closest to.
  const distN = Math.abs(wz - (-ROOM_D / 2));
  const distS = Math.abs(wz - ( ROOM_D / 2));
  const distE = Math.abs(wx - ( ROOM_W / 2));
  const distW = Math.abs(wx - (-ROOM_W / 2));
  const minD = Math.min(distN, distS, distE, distW);
  if (minD > 1.8) return null;     // too far from any wall
  let side, t;
  if (minD === distN)      { side = 'N'; t = (wx - (-ROOM_W / 2 + WALL_PAD)) / (ROOM_W - 2 * WALL_PAD); }
  else if (minD === distS) { side = 'S'; t = ((ROOM_W / 2 - WALL_PAD) - wx) / (ROOM_W - 2 * WALL_PAD); }
  else if (minD === distE) { side = 'E'; t = (wz - (-ROOM_D / 2 + WALL_PAD)) / (ROOM_D - 2 * WALL_PAD); }
  else                     { side = 'W'; t = ((ROOM_D / 2 - WALL_PAD) - wz) / (ROOM_D - 2 * WALL_PAD); }
  t = Math.max(0, Math.min(1, t));
  const slot = Math.round(t * (WALL_SLOTS - 1));
  return { side, slot };
}

function _updateCursor() {
  if (!_cursorMesh || !_wallCursorMesh) return;
  if (_inputMode === 'gamepad') {
    _updateCursorGamepad();
    return;
  }
  const hit = _floorIntersect();
  if (!hit) {
    _cursorMesh.visible = false;
    _wallCursorMesh.visible = false;
    _hoverTile = null; _hoverWall = null;
    return;
  }
  const def = _selectedItemId ? HOME_CATALOG.find(c => c.id === _selectedItemId) : null;
  if (def && def.wall) {
    // Wall placement mode
    const ws = _nearestWallSlot(hit.x, hit.z);
    _hoverTile = null;
    _hoverWall = ws;
    if (ws) _paintWallCursor(ws);
    else _wallCursorMesh.visible = false;
    return;
  }
  // Floor placement (or pickup with no item held)
  const { gx, gz } = worldToTile(hit.x, hit.z);
  _hoverWall = null;
  if (!inBounds(gx, gz)) {
    _hoverTile = null;
    _cursorMesh.visible = false;
    return;
  }
  _hoverTile = { gx, gz };
  _paintFloorCursor(gx, gz, def);
}

/**
 * Iter 23b — gamepad cursor branch. The d-pad / left-stick code has already
 * moved `_gpFocusTile` or `_gpFocusWall`; we just project those into world
 * space and tint the cursor mesh. Hover-state mirrors mouse mode so the
 * existing _placementsFootprintAt / _canPlaceAt feedback paints normally.
 */
function _updateCursorGamepad() {
  const def = _selectedItemId ? HOME_CATALOG.find(c => c.id === _selectedItemId) : null;
  if (_gpFocusWall) {
    _hoverTile = null;
    _hoverWall = _gpFocusWall;
    _paintWallCursor(_gpFocusWall);
    return;
  }
  const { gx, gz } = _gpFocusTile;
  _hoverWall = null;
  _hoverTile = { gx, gz };
  _paintFloorCursor(gx, gz, def);
}

function _paintWallCursor(ws) {
  const w = wallSlotToWorld(ws.side, ws.slot);
  _wallCursorMesh.position.set(w.x, w.y, w.z);
  _wallCursorMesh.rotation.y = w.rotY;
  _wallCursorMesh.visible = true;
  _cursorMesh.visible = false;
}

function _paintFloorCursor(gx, gz, def) {
  const center = tileToWorld(gx, gz);
  _cursorMesh.position.set(center.x, 0.03, center.z);
  const reserved = isReserved(gx, gz);
  const occupied = _placementsFootprintAt(gx, gz);
  let canPlace = false;
  if (def) canPlace = _canPlaceAt(def, gx, gz);
  // Gamepad mode uses amber (#ffd27f) as its baseline focus color so it
  // reads as "controller cursor"; mouse keeps the cyan baseline. Both still
  // surface the red/cyan place-validity feedback.
  const gp = _inputMode === 'gamepad';
  _cursorMesh.material.color.setHex(
    reserved ? 0xff5e5e :
    canPlace ? (gp ? 0xffd27f : 0x7fffe4) :
    occupied ? 0xffd27f :
    0xb0b0b0,
  );
  // In gamepad mode bump the opacity slightly so the focus tile is
  // visually punchier than a passive mouse hover.
  _cursorMesh.material.opacity = gp ? 0.55 : 0.32;
  _cursorMesh.visible = true;
  _wallCursorMesh.visible = false;
}

// ── Input ───────────────────────────────────────────────────────────────────

function _onMouseMove(e) {
  _mouse.clientX = e.clientX;
  _mouse.clientY = e.clientY;
  // Iter 23b — mouse activity flips the input mode back to 'mouse'. This is
  // the only hook that triggers the flip; gamepad activity flips the other
  // way inside _gpTick.
  if (_inputMode !== 'mouse') _inputMode = 'mouse';
}

function _onMouseDown(e) {
  if (!_decorateActive) return;
  // Don't react to clicks inside the palette overlay.
  if (_overlayEl && _overlayEl.contains(e.target)) return;
  if (e.button === 2) {
    // Right-click → pick up
    e.preventDefault();
    if (_hoverTile) { _pickupAt(_hoverTile.gx, _hoverTile.gz); _updatePaletteCounts(); }
    else if (_hoverWall) { _pickupWallAt(_hoverWall.side, _hoverWall.slot); _updatePaletteCounts(); }
    return;
  }
  if (e.button === 0) {
    e.preventDefault();
    if (!_selectedItemId) {
      // No item held — toggle pickup-mode click (pick up the item under the cursor)
      if (_hoverTile) { _pickupAt(_hoverTile.gx, _hoverTile.gz); _updatePaletteCounts(); }
      else if (_hoverWall) { _pickupWallAt(_hoverWall.side, _hoverWall.slot); _updatePaletteCounts(); }
      return;
    }
    const def = HOME_CATALOG.find(c => c.id === _selectedItemId);
    if (!def) return;
    if (def.wall) {
      if (_hoverWall) _placeWallItem(_selectedItemId, _hoverWall.side, _hoverWall.slot);
    } else if (_hoverTile) {
      _placeFloorItem(_selectedItemId, _hoverTile.gx, _hoverTile.gz);
    }
    _updatePaletteCounts();
  }
}

function _onKeyDown(e) {
  if (!_decorateActive) return;
  if (e.code === 'Escape' || e.code === 'KeyH') {
    e.preventDefault();
    closeDecorateMode();
    return;
  }
  if (e.code === 'KeyR') {
    if (_hoverTile) { _rotateAt(_hoverTile.gx, _hoverTile.gz); e.preventDefault(); }
  }
}

function _onContextMenu(e) {
  if (!_decorateActive) return;
  if (_overlayEl && _overlayEl.contains(e.target)) return;
  e.preventDefault();
}

// ── Iter 23b — gamepad input dispatcher ───────────────────────────────────
// Polls gamepadState (already refreshed by input.js#sampleInput each frame)
// and turns d-pad / stick / button activity into the same actions the
// mouse+kbm handlers fire. Lives inside the same module so it shares
// _selectedItemId / _hoverTile / _hoverWall etc.

/**
 * Translate a d-pad / left-stick "direction nudge" into a focus-tile delta.
 * Mapping is grid-aligned (advisor said keep it simple): up=gz-1, down=gz+1,
 * left=gx-1, right=gx+1. From the far edge of the floor in any direction,
 * one more nudge moves onto the corresponding wall.
 */
function _gpMoveFocus(dir /* 'up'|'down'|'left'|'right' */) {
  // If we're currently on a wall, the inverse direction returns us to the
  // floor; same-axis nudges scroll along the wall slots.
  if (_gpFocusWall) {
    const w = _gpFocusWall;
    if (w.side === 'N') {
      if (dir === 'down') { _gpFocusWall = null; _gpFocusTile = { gx: _wallSlotToGx(w.slot), gz: 0 }; return; }
      if (dir === 'left')  { _gpFocusWall = { side: 'N', slot: Math.max(0, w.slot - 1) }; return; }
      if (dir === 'right') { _gpFocusWall = { side: 'N', slot: Math.min(WALL_SLOTS - 1, w.slot + 1) }; return; }
      return;
    }
    if (w.side === 'S') {
      if (dir === 'up') { _gpFocusWall = null; _gpFocusTile = { gx: _wallSlotToGx(WALL_SLOTS - 1 - w.slot), gz: GRID_ROWS - 1 }; return; }
      if (dir === 'left')  { _gpFocusWall = { side: 'S', slot: Math.max(0, w.slot - 1) }; return; }
      if (dir === 'right') { _gpFocusWall = { side: 'S', slot: Math.min(WALL_SLOTS - 1, w.slot + 1) }; return; }
      return;
    }
    if (w.side === 'E') {
      if (dir === 'left') { _gpFocusWall = null; _gpFocusTile = { gx: GRID_COLS - 1, gz: _wallSlotToGz(w.slot) }; return; }
      if (dir === 'up')   { _gpFocusWall = { side: 'E', slot: Math.max(0, w.slot - 1) }; return; }
      if (dir === 'down') { _gpFocusWall = { side: 'E', slot: Math.min(WALL_SLOTS - 1, w.slot + 1) }; return; }
      return;
    }
    if (w.side === 'W') {
      if (dir === 'right') { _gpFocusWall = null; _gpFocusTile = { gx: 0, gz: _wallSlotToGz(WALL_SLOTS - 1 - w.slot) }; return; }
      if (dir === 'up')    { _gpFocusWall = { side: 'W', slot: Math.max(0, w.slot - 1) }; return; }
      if (dir === 'down')  { _gpFocusWall = { side: 'W', slot: Math.min(WALL_SLOTS - 1, w.slot + 1) }; return; }
      return;
    }
  }
  // On the floor — nudge until we slide off an edge, then step onto the
  // corresponding wall.
  let { gx, gz } = _gpFocusTile;
  if (dir === 'up')    gz--;
  if (dir === 'down')  gz++;
  if (dir === 'left')  gx--;
  if (dir === 'right') gx++;
  if (gz < 0) {
    _gpFocusWall = { side: 'N', slot: _gxToWallSlot(_gpFocusTile.gx) };
    return;
  }
  if (gz >= GRID_ROWS) {
    _gpFocusWall = { side: 'S', slot: (WALL_SLOTS - 1) - _gxToWallSlot(_gpFocusTile.gx) };
    return;
  }
  if (gx < 0) {
    _gpFocusWall = { side: 'W', slot: (WALL_SLOTS - 1) - _gzToWallSlot(_gpFocusTile.gz) };
    return;
  }
  if (gx >= GRID_COLS) {
    _gpFocusWall = { side: 'E', slot: _gzToWallSlot(_gpFocusTile.gz) };
    return;
  }
  _gpFocusTile = { gx, gz };
}
function _gxToWallSlot(gx) {
  // 10 columns → 8 slots: linear remap, rounded.
  return Math.max(0, Math.min(WALL_SLOTS - 1, Math.round(gx / (GRID_COLS - 1) * (WALL_SLOTS - 1))));
}
function _gzToWallSlot(gz) {
  return Math.max(0, Math.min(WALL_SLOTS - 1, Math.round(gz / (GRID_ROWS - 1) * (WALL_SLOTS - 1))));
}
function _wallSlotToGx(slot) {
  return Math.max(0, Math.min(GRID_COLS - 1, Math.round(slot / (WALL_SLOTS - 1) * (GRID_COLS - 1))));
}
function _wallSlotToGz(slot) {
  return Math.max(0, Math.min(GRID_ROWS - 1, Math.round(slot / (WALL_SLOTS - 1) * (GRID_ROWS - 1))));
}

/** Cycle palette selection by step (+1 = next unlocked, -1 = previous). */
function _gpCyclePalette(step) {
  const unlockedIds = HOME_CATALOG.filter(i => isHomeItemUnlocked(i.id)).map(i => i.id);
  if (unlockedIds.length === 0) return;
  let idx = _selectedItemId ? unlockedIds.indexOf(_selectedItemId) : -1;
  if (idx < 0) idx = (step > 0) ? -1 : 0;
  idx = (idx + step + unlockedIds.length) % unlockedIds.length;
  _selectedItemId = unlockedIds[idx];
  _highlightSelectedPaletteEntry();
  // Scroll the palette so the new selection is visible — important since
  // the catalog has 16 entries and the overlay is 76vh tall.
  try {
    const card = _paletteEl && _paletteEl.querySelector(`[data-item-id="${_selectedItemId}"]`);
    if (card && card.scrollIntoView) card.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  } catch (_) {}
  try { sfx.uiClick(); } catch (_) {}
}

/**
 * Page palette categories. Catalog layout (HOME_CATALOG above) is 11 floor
 * items followed by 5 wall items. LB = jump to start of floor section; RB
 * = jump to start of wall section.
 */
function _gpPagePalette(dir /* -1 = floor, +1 = wall */) {
  const targetWall = dir > 0;
  const unlocked = HOME_CATALOG.filter(i => isHomeItemUnlocked(i.id) && !!i.wall === targetWall);
  if (unlocked.length === 0) return;
  _selectedItemId = unlocked[0].id;
  _highlightSelectedPaletteEntry();
  try {
    const card = _paletteEl && _paletteEl.querySelector(`[data-item-id="${_selectedItemId}"]`);
    if (card && card.scrollIntoView) card.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  } catch (_) {}
  try { sfx.uiClick(); } catch (_) {}
}

/** A button: place (if item held) else pick up at focus. */
function _gpPrimaryAction() {
  if (_selectedItemId) {
    const def = HOME_CATALOG.find(c => c.id === _selectedItemId);
    if (!def) return;
    if (def.wall) {
      if (_gpFocusWall) _placeWallItem(_selectedItemId, _gpFocusWall.side, _gpFocusWall.slot);
    } else if (!_gpFocusWall) {
      _placeFloorItem(_selectedItemId, _gpFocusTile.gx, _gpFocusTile.gz);
    }
    _updatePaletteCounts();
    return;
  }
  // Nothing held — pick up under the focus.
  if (_gpFocusWall) _pickupWallAt(_gpFocusWall.side, _gpFocusWall.slot);
  else _pickupAt(_gpFocusTile.gx, _gpFocusTile.gz);
  _updatePaletteCounts();
}

/** B button: pick up at focus, OR exit if nothing under focus and nothing held. */
function _gpSecondaryAction() {
  // Try pickup first
  let picked = false;
  if (_gpFocusWall) picked = _pickupWallAt(_gpFocusWall.side, _gpFocusWall.slot);
  else picked = _pickupAt(_gpFocusTile.gx, _gpFocusTile.gz);
  if (picked) { _updatePaletteCounts(); return; }
  // Nothing to pick up — if nothing is held either, B exits decorate mode.
  if (!_selectedItemId) {
    closeDecorateMode();
  } else {
    // Clear selection so the next B-press exits (two-step "drop, then exit").
    _selectedItemId = null;
    _highlightSelectedPaletteEntry();
    try { sfx.uiClick(); } catch (_) {}
  }
}

function _gpRotateAction() {
  if (_gpFocusWall) return; // wall items don't rotate
  _rotateAt(_gpFocusTile.gx, _gpFocusTile.gz);
}

function _gpTick(dt, padInteractDrained) {
  // padInteractDrained is the value already pulled from consumePadInteract()
  // by tickHomeDecor — pad-B triggers the input.js queue, but we route it
  // through our own _gpSecondaryAction below using gamepadState.justPressed.b
  // directly. The drain is just to keep interior.js from re-firing it on the
  // first frame after decorate closes. (See advisor note 2.)
  void padInteractDrained;

  if (!gamepadState.connected) return;
  const jp = gamepadState.justPressed;
  const b = gamepadState.buttons;

  // ── Detect any gamepad activity → flip _inputMode = 'gamepad' ───────────
  const stickActive = Math.hypot(gamepadState.lx, gamepadState.ly) > _STICK_THRESH;
  const anyEdge = jp.a || jp.b || jp.x || jp.y || jp.lb || jp.rb ||
                  jp.start || jp.back ||
                  jp.dpadUp || jp.dpadDown || jp.dpadLeft || jp.dpadRight;
  const anyHeld = b.dpadUp || b.dpadDown || b.dpadLeft || b.dpadRight;
  if (anyEdge || stickActive || anyHeld) {
    if (_inputMode !== 'gamepad') {
      _inputMode = 'gamepad';
      // Seed wall focus from the current mouse hover if available so the
      // first nudge doesn't snap the cursor across the room.
      if (_hoverWall) { _gpFocusWall = { ..._hoverWall }; }
      else if (_hoverTile) { _gpFocusTile = { ..._hoverTile }; _gpFocusWall = null; }
    }
  }

  // ── Navigation: d-pad (digital, edge-detect + hold-repeat) ──────────────
  // dir is also the key into _dpadRepeatT so the clock math reads cleanly.
  const stepDpad = (key, dir) => {
    if (jp[key]) {
      _gpMoveFocus(dir);
      _dpadRepeatT[dir] = _DPAD_REPEAT_S;
      return;
    }
    if (b[key]) {
      _dpadRepeatT[dir] -= dt;
      if (_dpadRepeatT[dir] <= 0) {
        _gpMoveFocus(dir);
        _dpadRepeatT[dir] = _DPAD_REPEAT_S;
      }
    } else {
      _dpadRepeatT[dir] = 0;
    }
  };
  stepDpad('dpadUp', 'up');
  stepDpad('dpadDown', 'down');
  stepDpad('dpadLeft', 'left');
  stepDpad('dpadRight', 'right');

  // ── Navigation: left stick (analog, quantized to cardinal). Diagonal
  // input commits the dominant axis. Edge fires on cross-threshold; hold
  // re-fires every _STICK_REPEAT_S. ──
  const lx = gamepadState.lx, ly = gamepadState.ly;
  let curDir = { x: 0, z: 0 };
  if (Math.abs(lx) > _STICK_THRESH || Math.abs(ly) > _STICK_THRESH) {
    if (Math.abs(lx) > Math.abs(ly)) curDir = { x: Math.sign(lx), z: 0 };
    else                              curDir = { x: 0, z: Math.sign(ly) };
  }
  const sameAsPrev = (curDir.x === _stickPrevDir.x && curDir.z === _stickPrevDir.z);
  if (!sameAsPrev) {
    // Direction changed (or rest → deflect, or deflect → rest, or flipped).
    if (curDir.x !== 0 || curDir.z !== 0) {
      _gpMoveFocus(curDir.x < 0 ? 'left' : curDir.x > 0 ? 'right' : curDir.z < 0 ? 'up' : 'down');
      _stickRepeatT = _STICK_REPEAT_S;
    }
    _stickPrevDir = curDir;
  } else if (curDir.x !== 0 || curDir.z !== 0) {
    _stickRepeatT -= dt;
    if (_stickRepeatT <= 0) {
      _gpMoveFocus(curDir.x < 0 ? 'left' : curDir.x > 0 ? 'right' : curDir.z < 0 ? 'up' : 'down');
      _stickRepeatT = _STICK_REPEAT_S;
    }
  }

  // ── Button edges ────────────────────────────────────────────────────────
  if (jp.a) _gpPrimaryAction();
  if (jp.b) _gpSecondaryAction();
  if (jp.x) _gpRotateAction();
  if (jp.y) _gpCyclePalette(+1);
  if (jp.lb) _gpPagePalette(-1);   // jump to floor section
  if (jp.rb) _gpPagePalette(+1);   // jump to wall section
  if (jp.start || jp.back) closeDecorateMode();
}

function _attachInputListeners() {
  const dom = state.renderer && state.renderer.domElement;
  if (!dom) return;
  dom.addEventListener('mousemove', _onMouseMove);
  dom.addEventListener('mousedown', _onMouseDown);
  dom.addEventListener('contextmenu', _onContextMenu);
  window.addEventListener('keydown', _onKeyDown);
}

function _detachInputListeners() {
  const dom = state.renderer && state.renderer.domElement;
  if (dom) {
    dom.removeEventListener('mousemove', _onMouseMove);
    dom.removeEventListener('mousedown', _onMouseDown);
    dom.removeEventListener('contextmenu', _onContextMenu);
  }
  window.removeEventListener('keydown', _onKeyDown);
}

// ── Overlay DOM ─────────────────────────────────────────────────────────────
// Pinned to the left edge so the room stays visible. Uses kk-fs-* classes so
// it scales with --kk-font-scale (iter 21b contract).

function _buildOverlay() {
  if (_overlayEl) return;
  _overlayEl = document.createElement('div');
  _overlayEl.id = 'kk-home-decorate';
  _overlayEl.style.cssText = `
    position: fixed; left: 16px; top: 12%; width: 340px; max-height: 76vh;
    background: linear-gradient(180deg, rgba(20,28,22,0.94), rgba(8,14,12,0.96));
    border: 1px solid rgba(255,232,188,0.18);
    border-radius: 12px;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 24px 48px rgba(0,0,0,0.65);
    padding: 16px 18px 12px;
    font-family: "Inter", system-ui, sans-serif;
    color: #f5efe1;
    z-index: 200;
    display: flex; flex-direction: column;
    pointer-events: auto;
    animation: kk-fade-in 0.22s ease-out;
  `;
  // Title row
  const titleRow = document.createElement('div');
  titleRow.style.cssText = 'display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 6px;';
  const title = document.createElement('div');
  title.className = 'kk-fs-lg';
  title.style.cssText = 'font-family: "Cinzel Decorative", serif; font-weight: 900; letter-spacing: 0.18em; color: #ffd27f;';
  title.textContent = 'DECORATE';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'kk-fs-sm';
  closeBtn.textContent = '×';
  closeBtn.style.cssText = `
    background: transparent; border: 1px solid rgba(255,232,188,0.18);
    color: #f5efe1; font-size: 18px; line-height: 1; width: 28px; height: 28px;
    border-radius: 6px; cursor: pointer; padding: 0;
  `;
  closeBtn.addEventListener('click', () => closeDecorateMode());
  titleRow.appendChild(title);
  titleRow.appendChild(closeBtn);
  _overlayEl.appendChild(titleRow);

  // Subtitle
  const sub = document.createElement('div');
  sub.className = 'kk-fs-mono';
  sub.style.cssText = 'letter-spacing: 0.26em; text-transform: uppercase; color: rgba(245,239,225,0.6); margin-bottom: 12px;';
  const list = listHomePlacements();
  sub.textContent = `${list.length}/${HOME_PLACEMENT_CAP} placed`;
  sub.id = 'kk-home-count';
  _overlayEl.appendChild(sub);

  // Palette scroller
  _paletteEl = document.createElement('div');
  _paletteEl.style.cssText = `
    overflow-y: auto; flex: 1; min-height: 0;
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
    padding-right: 4px;
    pointer-events: auto;
  `;
  // Iter 26 — single delegated mousedown listener on the palette container
  // (replaces per-card click handlers in _renderPalette). See _onPaletteMouseDown.
  _paletteEl.addEventListener('mousedown', _onPaletteMouseDown);
  _overlayEl.appendChild(_paletteEl);
  _renderPalette();

  // Instruction strip
  const strip = document.createElement('div');
  strip.className = 'kk-fs-mono';
  strip.style.cssText = `
    margin-top: 12px; padding: 8px 10px;
    border-top: 1px solid rgba(255,232,188,0.10);
    color: rgba(245,239,225,0.7); letter-spacing: 0.10em; line-height: 1.6;
  `;
  strip.innerHTML =
    '<b style="color:#ffd27f;">CLICK</b> place &nbsp;·&nbsp; ' +
    '<b style="color:#ffd27f;">R</b> rotate &nbsp;·&nbsp; ' +
    '<b style="color:#ffd27f;">RIGHT-CLICK</b> pick up &nbsp;·&nbsp; ' +
    '<b style="color:#ffd27f;">H / ESC</b> exit' +
    '<br><span style="opacity:0.7;">' +
    '<b style="color:#ffd27f;">D-PAD</b> nav &nbsp;·&nbsp; ' +
    '<b style="color:#ffd27f;">A</b> place &nbsp;·&nbsp; ' +
    '<b style="color:#ffd27f;">B</b> pick up / exit &nbsp;·&nbsp; ' +
    '<b style="color:#ffd27f;">X</b> rotate &nbsp;·&nbsp; ' +
    '<b style="color:#ffd27f;">Y</b> cycle &nbsp;·&nbsp; ' +
    '<b style="color:#ffd27f;">LB/RB</b> page' +
    '</span>';
  _overlayEl.appendChild(strip);

  document.body.appendChild(_overlayEl);
}

function _renderPalette() {
  if (!_paletteEl) return;
  _paletteEl.innerHTML = '';
  for (const item of HOME_CATALOG) {
    const unlocked = isHomeItemUnlocked(item.id);
    const card = document.createElement('div');
    card.dataset.itemId = item.id;
    if (unlocked) card.dataset.unlocked = '1';
    card.style.cssText = `
      position: relative;
      background: linear-gradient(180deg, rgba(28,36,30,0.85), rgba(14,20,16,0.95));
      border: 1px solid ${unlocked ? 'rgba(255,232,188,0.18)' : 'rgba(80,80,80,0.4)'};
      border-radius: 8px;
      padding: 10px 6px 8px;
      text-align: center;
      cursor: ${unlocked ? 'pointer' : 'not-allowed'};
      opacity: ${unlocked ? '1' : '0.45'};
      transition: transform 0.12s ease, border-color 0.12s ease;
    `;
    card.innerHTML = `
      <div style="font-size: 26px; line-height: 1; margin-bottom: 6px; pointer-events: none;
        filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5));">${item.icon}${unlocked ? '' : '<span style="position:absolute;top:6px;right:8px;font-size:10px;color:#ff7ad8;">🔒</span>'}</div>
      <div class="kk-fs-mono" style="letter-spacing: 0.05em; color: ${unlocked ? '#f5efe1' : 'rgba(245,239,225,0.55)'}; line-height: 1.2; pointer-events: none;">
        ${item.name}
      </div>
      ${!unlocked ? `<div class="kk-fs-mono" style="margin-top:4px;color:rgba(255,122,216,0.7);font-size:9px;letter-spacing:0.04em;pointer-events:none;">${escapeHtml(item.unlock)}</div>` : ''}
    `;
    if (unlocked) {
      card.addEventListener('mouseenter', () => {
        card.style.transform = 'translateY(-2px)';
        card.style.borderColor = '#ffd27f';
      });
      card.addEventListener('mouseleave', () => {
        card.style.transform = '';
        if (_selectedItemId !== item.id) card.style.borderColor = 'rgba(255,232,188,0.18)';
      });
    }
    _paletteEl.appendChild(card);
  }
  _highlightSelectedPaletteEntry();
}

// ── Iter 26 — palette selection via event delegation ───────────────────────
// Previously each card carried its own `click` handler attached in
// _renderPalette. That worked in isolation but proved fragile: any DOM
// rebuild dropped the listeners, and a single mid-card child element with
// stray pointer-events could swallow the click without bubbling far enough
// to fire it. Delegation moves the listener up to _paletteEl itself, runs
// on `mousedown` (fires before `click` so it beats any focus-shift races),
// and resolves the target via [data-item-id]. Children of the card are
// marked pointer-events:none in _renderPalette so e.target is always the
// card root — but closest() handles the alternative regardless.
function _onPaletteMouseDown(e) {
  if (e.button !== 0) return;        // left-click only — right-click does nothing in palette
  const card = e.target && e.target.closest ? e.target.closest('[data-item-id]') : null;
  if (!card || !card.dataset || !card.dataset.itemId) return;
  // stopPropagation + preventDefault to be defensive against future canvas
  // listeners that might try to consume mousedown bubbling up from the body.
  e.preventDefault();
  e.stopPropagation();
  const itemId = card.dataset.itemId;
  // Re-check unlocked at click time (not render time) so a syncHomeUnlocks
  // that fired between render and click — e.g. an achievement toast still
  // animating — doesn't lock out a now-eligible card.
  if (!isHomeItemUnlocked(itemId)) return;
  _selectedItemId = itemId;
  _highlightSelectedPaletteEntry();
  try { sfx.uiClick(); } catch (_) {}
}

function _highlightSelectedPaletteEntry() {
  if (!_paletteEl) return;
  for (const child of _paletteEl.children) {
    if (child.dataset && child.dataset.itemId === _selectedItemId) {
      child.style.borderColor = '#7fffe4';
      child.style.boxShadow = '0 0 14px rgba(127,255,228,0.25)';
    } else {
      child.style.boxShadow = '';
      // Don't override the locked color
      const unlocked = isHomeItemUnlocked(child.dataset.itemId);
      child.style.borderColor = unlocked ? 'rgba(255,232,188,0.18)' : 'rgba(80,80,80,0.4)';
    }
  }
}

function _updatePaletteCounts() {
  const el = _overlayEl && _overlayEl.querySelector('#kk-home-count');
  if (!el) return;
  const list = listHomePlacements();
  el.textContent = `${list.length}/${HOME_PLACEMENT_CAP} placed`;
}

function _destroyOverlay() {
  // Detach the delegated palette listener before nulling the ref. The DOM
  // node is about to be removed (which also drops listeners), but explicit
  // teardown keeps the lifecycle symmetric with _buildOverlay.
  if (_paletteEl) {
    try { _paletteEl.removeEventListener('mousedown', _onPaletteMouseDown); } catch (_) {}
  }
  if (_overlayEl && _overlayEl.parentNode) _overlayEl.parentNode.removeChild(_overlayEl);
  _overlayEl = null;
  _paletteEl = null;
}

// Local — avoid importing ui.js's escapeHtml helper (one-way coupling)
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, ch => (
    { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch]
  ));
}
