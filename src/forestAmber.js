/**
 * Forest Explosive Amber — discrete interactable entity.
 *
 * STUB: API surface only. Phase-2 Amber Interactable Agent fills bodies.
 * Contract locked in docs/FOREST_VISUAL_STYLE.md §"Explosive Amber".
 *
 * Public API:
 *   loadForestAmber(scene, hotspots) — spawn N amber entities from JSON
 *   tickForestAmber(dt, state)       — per-frame: pulse idle, advance FX,
 *                                       resolve detonations against enemies
 *   clearForestAmber(scene)          — dispose all entities + FX
 *
 * Hotspot JSON schema (assets/forest_amber_hotspots.json, written by Decor):
 *   [{ x: number, z: number, scale: number, seed: number }]
 *
 * Detonation triggers:
 *   - any damage source (player projectile, AoE, signature weapon)
 *   - direct contact with chain-lightning arc from another amber
 * Health: 1 (one-shot). No regen mid-run.
 *
 * FX (per style guide):
 *   - idle: emissive pulse 1.4-2.0 @ 0.7Hz on slot 6 (#f5a300)
 *   - detonation frame 0: flash slot 7 (#ffd86b) emissive 3.5
 *   - shockwave 0.0-0.6s: cyan-white ring slot 8, line weight 0.08, bloom
 *   - chain-lightning 0.0-0.4s: 3 nearest enemies within 5u, slot 8 arcs
 *   - shards: 8-12 fragments slot 3, gravity, 0.8s lifetime, bloom OFF
 *
 * Damage profile:
 *   - 35 base damage in 4u radius (full detonation epicenter)
 *   - chain-lightning: 18 damage to up to 3 enemies within 5u
 *   - applies 0.8s shatter debuff (vulnerability +25%) — TBD whether
 *     enemies.js supports debuff stack; agent verifies
 */

const _entities = [];
let _hotspotsLoaded = null;

export async function loadForestAmber(scene, hotspotsUrl = 'assets/forest_amber_hotspots.json') {
  // TODO Phase-2: fetch hotspots JSON, build entity per hotspot
  // (InstancedMesh for the crystal bodies + per-entity state record),
  // tag bloom layer, push into _entities, return entity count.
  void scene; void hotspotsUrl;
  return 0;
}

export function tickForestAmber(dt, state) {
  // TODO Phase-2:
  //   for each entity: advance idle pulse phase
  //   advance active detonation FX timelines (shockwave, chain, shards)
  //   on first contact with damage: enter detonation state, deal AoE,
  //     chain to 3 nearest enemies via state.enemies array
  //   GC entities whose detonation fully completed (state === 'dead')
  void dt; void state;
}

export function clearForestAmber(scene) {
  // TODO Phase-2: dispose geometries/materials, remove from scene, clear _entities
  void scene;
  _entities.length = 0;
  _hotspotsLoaded = null;
}

// Exported for tests / debug overlays.
export function _debugEntities() { return _entities.slice(); }
export function _debugHotspots() { return _hotspotsLoaded; }
