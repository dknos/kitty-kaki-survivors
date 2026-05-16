/**
 * Twilight Fountains — discrete interactable entity (PREFLIGHT STUB).
 *
 * Phase-2 Twilight Fountains Agent will fill this in. Mirrors the shape of
 * `src/forestAmber.js` (commit 5fca693) so the Phase-2 agent has a known
 * port pattern. This file is a stub — function bodies contain TODOs, not
 * runtime logic.
 *
 * Contract: docs/TWILIGHT_VISUAL_STYLE.md §"Fountain Spec — Drink Interaction".
 *
 * Public API:
 *   loadTwilightFountains(scene, hotspotsUrl?) — spawn entities from JSON, return count
 *   tickTwilightFountains(dt, state)            — per-frame: pulse idle, detect proximity,
 *                                                 advance drink anim, apply speed buff,
 *                                                 tick cooldown
 *   clearTwilightFountains(scene)               — dispose all entities + FX
 *
 * Hotspot JSON: [{ x, z, variant: 'blood'|'light', scale, seed }]
 *               (see assets/twilight_fountain_hotspots.json)
 *
 * Design notes (for Phase-2 agent):
 * - Per-entity Mesh (NOT InstancedMesh): 6-8 entities is trivial for the
 *   draw-call budget, and per-entity emissive lerping (idle pulse / drink
 *   flash / cooldown dim) is cheap on Mesh vs. shader hook on InstancedMesh.
 *   Mirror the forestAmber.js shape — body + liquid disk as separate meshes
 *   so the liquid pulses independently of the static stone rim.
 * - Proximity scan per tick: for each idle fountain, distance² to player
 *   ≤ (1.5)² → enter drink state. 6-8 fountains × 1 player is one comparison
 *   each — well inside the frame budget. No spatial index needed.
 * - Speed-buff publication (PICK ONE in implementation and lock it):
 *     OPTION A (preferred): publish state.run.fountainSpeedBuff = {
 *       mul: 1.75, expiresAt: state.time.game + 4.0 }. Hero movement loop
 *       reads it (analogous to state.run.forestSlowZones in enemies.js).
 *       Decouples this module from hero.js; survives stat-recompute paths
 *       in meta.js / weapons/passives.js cleanly.
 *     OPTION B: mutate state.hero.statMul.moveSpeed *= 1.75 on drink-end,
 *       store the prior value, restore it on expiry. Simpler, but if any
 *       other path (level-up, passive proc) recomputes statMul in the
 *       interim, the restore math becomes ambiguous.
 *   Document the chosen option in the file header when wiring it.
 * - Cooldown: 30s per fountain (LOCKED in docs). After drink consumed,
 *   liquid emissive flat 0.6, no pulse, until cooldown expires.
 * - Aura ring: two concentric rings on slot 8 around the PLAYER, not
 *   the fountain. Re-position each tick from state.hero.mesh.position.
 *   Disposed on buff expiry.
 *
 * Palette (8-color, locked — see docs/TWILIGHT_VISUAL_STYLE.md):
 *   slot 2 #2d1547 — fountain stone shadow / body
 *   slot 4 #e8d4b0 — fountain stone rim
 *   slot 5 #8b1a2e — Blood Fountain liquid (idle emissive)
 *   slot 6 #a98030 — Light Fountain liquid (idle emissive)
 *   slot 7 #ffcd5b — drink-flash override (peak frame)
 *   slot 8 #a8e6ff — speed-buff aura (player ring, bloom ON)
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from './postfx.js';
import { sfx } from './audio.js';

// ─── module state ─────────────────────────────────────────────────────────────
// Mirror forestAmber.js shape. _fountains is the per-entity registry; _group is
// the single scene-attached parent for cheap teardown; _disposables tracks
// geos/mats that survive across entities (shared geometry, shared materials).
const _fountains = [];        // { x, z, variant, scale, seed, state, ... }
let _hotspotsLoaded = null;
let _group = null;            // parent Group added to scene
const _disposables = [];      // geos/mats tracked for clearTwilightFountains
const _auraRings = [];        // { group, mats, geos, anchor, expiresAt, ... }

// ─── tuning constants (LOCKED per docs/TWILIGHT_VISUAL_STYLE.md) ──────────────
const PROXIMITY_R = 1.5;             // drink-trigger radius (world units)
const DRINK_DURATION = 0.6;          // drink animation length (s)
const BUFF_DURATION = 4.0;           // movement-speed buff duration (s)
const BUFF_MUL = 1.75;               // movement-speed multiplier
const COOLDOWN_DURATION = 30.0;      // per-fountain cooldown (s) — LOCKED

const IDLE_PULSE_HZ = 0.5;           // liquid emissive pulse frequency
const IDLE_EMISSIVE_MIN = 1.2;       // spec band 1.2-1.8
const IDLE_EMISSIVE_MAX = 1.8;
const DRINK_PEAK_EMISSIVE = 3.5;     // single-frame peak on slot 7
const COOLDOWN_EMISSIVE = 0.6;       // dim flat emissive during cooldown

const AURA_INNER_R = 0.9;            // tight halo around player
const AURA_OUTER_R = 1.4;            // loose trail halo
const AURA_LINE_WIDTH = 0.07;        // line weight band 0.06-0.08

const COLOR_STONE_BODY   = 0x2d1547; // slot 2 — fountain stone shadow
const COLOR_STONE_RIM    = 0xe8d4b0; // slot 4 — fountain stone rim
const COLOR_BLOOD_LIQUID = 0x8b1a2e; // slot 5 — Blood Fountain liquid
const COLOR_LIGHT_LIQUID = 0xa98030; // slot 6 — Light Fountain liquid
const COLOR_DRINK_FLASH  = 0xffcd5b; // slot 7 — single-frame drink override
const COLOR_AURA         = 0xa8e6ff; // slot 8 — speed-buff aura

// ─── public: load ─────────────────────────────────────────────────────────────
/**
 * Spawn fountain entities from the hotspot JSON.
 *
 * TODO(phase-2): mirror loadForestAmber:
 *   1. clearTwilightFountains(scene) first (idempotent reload)
 *   2. fetch hotspotsUrl, parse JSON; bail with warn on failure
 *   3. build _group, attach to scene
 *   4. build shared stone-body + stone-rim geometries (merged BufferGeometry,
 *      flat-shaded) — push into _disposables
 *   5. for each hotspot: pick liquid color from variant ('blood'|'light'),
 *      build per-entity liquid material (so emissive can be independently
 *      lerped per tick), construct mesh group (body + rim + liquid disk),
 *      apply scale + seeded rotation jitter, register in _fountains with
 *      state='idle', cooldownUntil=0, pulsePhase from seeded RNG
 *   6. return _fountains.length so caller can log "spawned N fountains"
 */
export async function loadTwilightFountains(scene, hotspotsUrl = 'assets/twilight_fountain_hotspots.json') {
  // TODO(phase-2): implement per the shape described above. Stub returns 0
  // so callers (stage init, hot-reload paths) get a safe no-op until the
  // Fountains Agent ships.
  void scene; void hotspotsUrl;
  void _fountains; void _hotspotsLoaded; void _group; void _disposables;
  return 0;
}

// ─── public: tick ────────────────────────────────────────────────────────────
/**
 * Per-frame update.
 *
 * TODO(phase-2): mirror tickForestAmber shape:
 *   1. bail if no state / no scene / no fountains
 *   2. for each fountain:
 *        - state === 'idle' (and not cooldown):
 *            pulse liquid emissive between MIN and MAX (sin wave, 0.5 Hz)
 *            check distance² to state.hero.mesh.position; if ≤ PROXIMITY_R²
 *              and player is alive, transition state='drinking', drinkTimer=0
 *        - state === 'idle' AND cooldownUntil > tNow:
 *            hold liquid emissive flat at COOLDOWN_EMISSIVE (no pulse)
 *            when cooldownUntil <= tNow, resume idle pulse
 *        - state === 'drinking':
 *            advance drinkTimer; lerp liquid emissive 1.5 → DRINK_PEAK_EMISSIVE,
 *            override color to COLOR_DRINK_FLASH during ramp
 *            on drinkTimer >= DRINK_DURATION:
 *              - revert color to variant idle color
 *              - drop liquid emissive to COOLDOWN_EMISSIVE
 *              - apply speed buff (see header: pick state.run.fountainSpeedBuff
 *                publish OR direct statMul mutation; LOCK the choice in code)
 *              - spawn aura ring on player (push to _auraRings, anchor=state.hero)
 *              - set fountain.cooldownUntil = tNow + COOLDOWN_DURATION
 *              - transition state='idle'
 *              - sfx.fountainChime? sfx.fountainPourEnd?
 *   3. tick _auraRings: reposition each ring group to anchor.mesh.position,
 *      fade material opacity 1.0 → 0.0 linear over BUFF_DURATION, dispose
 *      when t >= BUFF_DURATION (and CLEAR the speed buff at the same time
 *      so visual + mechanical state stay in lockstep)
 */
export function tickTwilightFountains(dt, state) {
  // TODO(phase-2): implement per the shape described above.
  void dt; void state;
  void _auraRings;
  void PROXIMITY_R; void DRINK_DURATION; void BUFF_DURATION; void BUFF_MUL;
  void COOLDOWN_DURATION;
  void IDLE_PULSE_HZ; void IDLE_EMISSIVE_MIN; void IDLE_EMISSIVE_MAX;
  void DRINK_PEAK_EMISSIVE; void COOLDOWN_EMISSIVE;
  void AURA_INNER_R; void AURA_OUTER_R; void AURA_LINE_WIDTH;
  void COLOR_STONE_BODY; void COLOR_STONE_RIM;
  void COLOR_BLOOD_LIQUID; void COLOR_LIGHT_LIQUID;
  void COLOR_DRINK_FLASH; void COLOR_AURA;
  void THREE; void BLOOM_LAYER; void sfx;
}

// ─── public: clear ───────────────────────────────────────────────────────────
/**
 * Dispose all entities + in-flight aura FX.
 *
 * TODO(phase-2): mirror clearForestAmber:
 *   1. for each _auraRings entry: detach group, dispose geos + mats, splice
 *   2. for each fountain: dispose per-entity liquid material (shared body/rim
 *      mats are in _disposables and disposed below)
 *   3. if _group: detach from scene, clear reference
 *   4. dispose all _disposables, clear array
 *   5. clear _fountains, clear _hotspotsLoaded
 *   6. IMPORTANT: also clear state.run.fountainSpeedBuff if Option-A was
 *      chosen (so a stage transition doesn't leak the buff into the next
 *      stage). Stub omits — Phase-2 adds when publishing the buff.
 */
export function clearTwilightFountains(scene) {
  // TODO(phase-2): implement per the shape described above.
  void scene;
}

// ─── debug exports (mirror forestAmber.js) ───────────────────────────────────
export function _debugFountains() { return _fountains.slice(); }
export function _debugHotspots() { return _hotspotsLoaded; }
