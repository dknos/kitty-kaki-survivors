/**
 * Forest Expansion v0.1 — Room Registry (Cohort 1A Foundations).
 *
 * Defines the 4-room layout for the Forest stage: one central hub (The Glade)
 * plus 3 puzzle rooms (Sap Hollow, Crystal Choir Grove, Amber Labyrinth).
 * Each room has world-space bounds + a center anchor. Portals in the Glade
 * connect outward to the 3 puzzle rooms.
 *
 * Read by:
 *   - Cohort 2 (puzzleSystem.js, arenaDecor.js per-room switch)
 *   - Cohort 3 (forestPortals.js, spawnDirector.js room-scope, main.js camera bounds)
 *
 * Source: docs/FOREST_EXPANSION_PLAN.md §1, §3, §4.
 * Constraints: flat single-file module, no THREE import, no game-state mutation.
 */

/**
 * @typedef {Object} ForestRoomBounds
 * @property {number} minX
 * @property {number} maxX
 * @property {number} minZ
 * @property {number} maxZ
 */

/**
 * @typedef {Object} ForestRoomDef
 * @property {string} id
 * @property {string} name
 * @property {{x:number,z:number}} center
 * @property {ForestRoomBounds} bounds
 * @property {boolean} isHub
 * @property {?string} puzzle      // puzzle id implemented by Cohort 3 Agent 6
 * @property {?string} weapon      // weapon id implemented by Cohort 1B Agent 2
 */

/** @type {Record<string, ForestRoomDef>} */
export const FOREST_ROOMS = {
  glade:          { id: 'glade',          name: 'The Glade',           center: { x:   0, z:   0 }, bounds: { minX:  -45, maxX:  45, minZ:  -45, maxZ:  45 }, isHub: true,  puzzle: null,                  weapon: null },
  saphollow:      { id: 'saphollow',      name: 'Sap Hollow',          center: { x: -70, z: -90 }, bounds: { minX:  -90, maxX: -50, minZ: -120, maxZ: -60 }, isHub: false, puzzle: 'flow_weaver',         weapon: 'sap_weaver' },
  crystalchoir:   { id: 'crystalchoir',   name: 'Crystal Choir Grove', center: { x:   0, z:  80 }, bounds: { minX:  -25, maxX:  25, minZ:   55, maxZ: 105 }, isHub: false, puzzle: 'harmonic_alignment',  weapon: 'choir_lance' },
  amberlabyrinth: { id: 'amberlabyrinth', name: 'Amber Labyrinth',     center: { x: 130, z:   0 }, bounds: { minX:  103, maxX: 158, minZ:  -20, maxZ:  20 }, isHub: false, puzzle: 'prism_lock',          weapon: 'prism_warden' },
};

/**
 * Portal hotspot positions. Each portal sits inside the Glade hub bounds,
 * close to the edge nearest its destination room. Cohort 3 Agent 5
 * (forestPortals.js) consumes this to spawn portal entities + pollen trails.
 *
 * @type {Record<string, {from:string,to:string,x:number,z:number}>}
 */
export const FOREST_PORTAL_POSITIONS = {
  toSaphollow:      { from: 'glade', to: 'saphollow',      x: -35, z: -45 },
  toCrystalchoir:   { from: 'glade', to: 'crystalchoir',   x:   0, z:  55 },
  toAmberlabyrinth: { from: 'glade', to: 'amberlabyrinth', x:  55, z:  10 },
};

/**
 * Lookup a room definition by id. Returns null for unknown ids so callers
 * can branch without throwing (e.g. on a malformed save with a stale room id).
 *
 * @param {string} id
 * @returns {ForestRoomDef|null}
 */
export function getRoomById(id) {
  return FOREST_ROOMS[id] || null;
}

/**
 * Axis-aligned bounds check. Inclusive on all 4 edges so a position exactly
 * on the boundary counts as inside. Used for room-scope despawn and "which
 * room is the hero in" detection.
 *
 * @param {number} x
 * @param {number} z
 * @param {string} roomId
 * @returns {boolean}
 */
export function isPositionInRoom(x, z, roomId) {
  const r = FOREST_ROOMS[roomId];
  if (!r) return false;
  return x >= r.bounds.minX && x <= r.bounds.maxX
      && z >= r.bounds.minZ && z <= r.bounds.maxZ;
}

/**
 * Returns the id of the first room whose bounds contain (x, z), or null if
 * the position is in a no-man's-land corridor between rooms. Iteration order
 * follows Object.keys(FOREST_ROOMS) — rooms are non-overlapping by design so
 * order does not matter for correctness.
 *
 * @param {number} x
 * @param {number} z
 * @returns {?string}
 */
export function detectRoom(x, z) {
  for (const id in FOREST_ROOMS) {
    if (isPositionInRoom(x, z, id)) return id;
  }
  return null;
}
