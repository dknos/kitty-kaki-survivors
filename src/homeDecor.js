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
  // Fireplace strip (east wall)
  '0,6','0,7',
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
    unlock: 'Defeat the final boss.',
    unlockCheck: (m) => !!(m.achievements && m.achievements.first_victory),
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
 */
export function tickHomeDecor() {
  if (!_decorateActive) return;
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
  // Optional emissive bake — small warm glow on the lamp + cauldron etc.
  if (def.emissive) {
    const pl = new THREE.PointLight(
      def.emissive.color, def.emissive.intensity, def.emissive.range, 2,
    );
    pl.position.set(0, def.emissive.y, 0);
    group.add(pl);
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
    if (ws) {
      const w = wallSlotToWorld(ws.side, ws.slot);
      _wallCursorMesh.position.set(w.x, w.y, w.z);
      _wallCursorMesh.rotation.y = w.rotY;
      _wallCursorMesh.visible = true;
      _cursorMesh.visible = false;
    } else {
      _wallCursorMesh.visible = false;
    }
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
  const center = tileToWorld(gx, gz);
  _cursorMesh.position.set(center.x, 0.03, center.z);
  const reserved = isReserved(gx, gz);
  const occupied = _placementsFootprintAt(gx, gz);
  let canPlace = false;
  if (def) canPlace = _canPlaceAt(def, gx, gz);
  _cursorMesh.material.color.setHex(
    reserved ? 0xff5e5e :
    occupied ? 0xffd27f :
    canPlace ? 0x7fffe4 :
    0xb0b0b0,
  );
  _cursorMesh.visible = true;
  _wallCursorMesh.visible = false;
}

// ── Input ───────────────────────────────────────────────────────────────────

function _onMouseMove(e) {
  _mouse.clientX = e.clientX;
  _mouse.clientY = e.clientY;
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
  `;
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
    '<b style="color:#ffd27f;">CLICK</b> to place &nbsp;·&nbsp; ' +
    '<b style="color:#ffd27f;">R</b> rotate &nbsp;·&nbsp; ' +
    '<b style="color:#ffd27f;">RIGHT-CLICK</b> pick up &nbsp;·&nbsp; ' +
    '<b style="color:#ffd27f;">H / ESC</b> exit';
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
      <div style="font-size: 26px; line-height: 1; margin-bottom: 6px;
        filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5));">${item.icon}${unlocked ? '' : '<span style="position:absolute;top:6px;right:8px;font-size:10px;color:#ff7ad8;">🔒</span>'}</div>
      <div class="kk-fs-mono" style="letter-spacing: 0.05em; color: ${unlocked ? '#f5efe1' : 'rgba(245,239,225,0.55)'}; line-height: 1.2;">
        ${item.name}
      </div>
      ${!unlocked ? `<div class="kk-fs-mono" style="margin-top:4px;color:rgba(255,122,216,0.7);font-size:9px;letter-spacing:0.04em;">${escapeHtml(item.unlock)}</div>` : ''}
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
      card.addEventListener('click', () => {
        _selectedItemId = item.id;
        _highlightSelectedPaletteEntry();
        try { sfx.uiClick(); } catch (_) {}
      });
    }
    _paletteEl.appendChild(card);
  }
  _highlightSelectedPaletteEntry();
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
