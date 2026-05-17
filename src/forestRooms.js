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
// landmarkBudget (optional, FE-V2 2026-05-17): per-room override for the
// shrines/altars/logs counts spawned by src/forestLandmarks.js. Module
// defaults are {shrines:5, altars:2, logs:7}; per-room caps below bias
// density toward the larger rooms and ease density in puzzle rooms so
// landmarks don't shadow the puzzle telegraphs.
export const FOREST_ROOMS = {
  glade:          { id: 'glade',          name: 'The Glade',           center: { x:   0, z:   0 }, bounds: { minX:  -45, maxX:  45, minZ:  -45, maxZ:  45 }, isHub: true,  puzzle: null,                  weapon: null,           landmarkBudget: { shrines: 6, altars: 3, logs: 8 } },
  saphollow:      { id: 'saphollow',      name: 'Sap Hollow',          center: { x: -70, z: -90 }, bounds: { minX:  -90, maxX: -50, minZ: -120, maxZ: -60 }, isHub: false, puzzle: 'flow_weaver',         weapon: 'sap_weaver',   landmarkBudget: { shrines: 5, altars: 2, logs: 7 } },
  crystalchoir:   { id: 'crystalchoir',   name: 'Crystal Choir Grove', center: { x:   0, z:  80 }, bounds: { minX:  -25, maxX:  25, minZ:   55, maxZ: 105 }, isHub: false, puzzle: 'harmonic_alignment',  weapon: 'choir_lance',  landmarkBudget: { shrines: 4, altars: 2, logs: 6 } },
  amberlabyrinth: { id: 'amberlabyrinth', name: 'Amber Labyrinth',     center: { x: 130, z:   0 }, bounds: { minX:  103, maxX: 158, minZ:  -20, maxZ:  20 }, isHub: false, puzzle: 'prism_lock',          weapon: 'prism_warden', landmarkBudget: { shrines: 4, altars: 2, logs: 6 } },
  // ── Forest Expansion v0.2 (FE-V2, 2026-05-17) — 3 new rooms ──
  // bramblemaze: SE relic-chest room. No puzzle, no hidden weapon (relic chest
  //   pattern — future hazards agent wires scratch DoT via _brambleMazeHazard.
  // mossroot: far-S puzzle room. Simon-says puzzle 'mossroot_pulse' unlocks
  //   weapon 'root_grasp' via puzzleSystem._win (weaponReward field).
  // glowfen: far-W lore/relic room. No puzzle for v1; weapon 'wisp_lantern'
  //   ships as scaffolding — REGISTRY-ready, FOREST_SPECIAL_IDS-equipped, but
  //   no in-game unlock path (no puzzle). Future ticket wires unlock.
  bramblemaze:    { id: 'bramblemaze',    name: 'Bramble Maze',        center: { x:  95, z:  80 }, bounds: { minX:   70, maxX: 120, minZ:   55, maxZ: 105 }, isHub: false, puzzle: null,                  weapon: null,           landmarkBudget: { shrines: 5, altars: 2, logs: 7 } },
  mossroot:       { id: 'mossroot',       name: 'Mossroot Hollow',     center: { x:   0, z: -140 }, bounds: { minX:  -35, maxX:  35, minZ: -170, maxZ: -110 }, isHub: false, puzzle: 'mossroot_pulse',     weapon: 'root_grasp',   landmarkBudget: { shrines: 4, altars: 2, logs: 6 } },
  glowfen:        { id: 'glowfen',        name: 'Glowfen Marshes',     center: { x: -160, z:   0 }, bounds: { minX: -200, maxX: -130, minZ:  -30, maxZ:  30 }, isHub: false, puzzle: null,                  weapon: 'wisp_lantern', landmarkBudget: { shrines: 5, altars: 2, logs: 7 } },
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
  // ── FE-V2 (2026-05-17): 3 new outbound portals at glade boundaries ──
  // Bramble: NE-ish glade edge → bramblemaze SW corner (closest entry side).
  // Mossroot: S glade edge → mossroot N entry inset (12u south of room edge).
  // Glowfen: W glade edge → glowfen E entry inset (1u inside room).
  toBramblemaze:    { from: 'glade', to: 'bramblemaze',    x:  40, z:  40 },
  toMossroot:       { from: 'glade', to: 'mossroot',       x:   0, z: -44 },
  toGlowfen:        { from: 'glade', to: 'glowfen',        x: -44, z:   0 },
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
