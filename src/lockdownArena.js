/**
 * Lockdown Arena — stage-agnostic "doors slam, clear waves or elite" mechanic.
 *
 * Spec (FOREST ITER C1):
 *   Hero enters a registered zone → doors VISUALLY slam into place around the
 *   zone (player can see them; collision is a soft clamp keeping the hero
 *   inside). spawnDirector pauses normal cadence. Lockdown dispatches 3 gated
 *   waves of mobs (one per ~6-8s). Clear condition is whichever fires first:
 *     - all 3 waves cleared (every wave-tagged mob dead)
 *     - any one Elite-tier mob killed (skill window)
 *   On clear: doors retract smoothly, reward bundle drops (8 gems + 1 chest +
 *   bloom punch + sfx), state.run.lockdownActive resets to false.
 *
 * Stage-agnostic by design — Forest is the first consumer but any stage can:
 *   import { armLockdown, triggerLockdown } from './lockdownArena.js';
 *   const id = armLockdown({ center: { x, z }, radius: 8, paletteSlots: { wall, glow, clear } });
 *   ... later: triggerLockdown(id);
 *
 * Multiple arenas may be armed per stage, but only ONE active lockdown at a
 * time (the second triggerLockdown call is a no-op while another is live).
 *
 * Door visuals — match the active stage's locked palette via paletteSlots:
 *   wall:  stone/trunk base color (Forest slot 2 #2d3a55)
 *   glow:  pulse-rim emissive during slam-in / active (Forest slot 4 #7df0c4)
 *   clear: amber flash on retract (Forest slot 6/7 #f5a300 → #ffd86b)
 * Banner uses '#a8e6ff' (Forest slot 8 cyan-white) for the wave counter.
 *
 * Door geometry — MERGED BufferGeometry + flatShading per
 * docs/FOREST_VISUAL_STYLE.md "Crystal facet edges". Pre-pooled at arm time
 * (center + palette known then); triggerLockdown only mutates position +
 * material opacity/emissive intensity — ZERO per-trigger allocation.
 *
 * spawnDirector integration: spawnDirector.tickSpawnDirector early-returns
 * when state.run.lockdownActive is true (mirrors the PUZZLE_ACTIVE pause).
 * This file owns the substitute wave-dispatcher tick (tickLockdownArena).
 *
 * Failure mode: hero death during lockdown is handled normally — the run-end
 * teardown calls disposeLockdownArenas which drops any live door geometry
 * and clears the state flags.
 */
import * as THREE from 'three';
import { state } from './state.js';
import { ENEMY_TIERS, SPAWN } from './config.js';
import { spawnEnemy } from './enemies.js';
import { spawnChest } from './chest.js';
import { dropGem } from './xp.js';
import { showBanner } from './ui.js';
import { sfx } from './audio.js';

// ─── module state ─────────────────────────────────────────────────────────────
/** @type {THREE.Scene|null} */
let _scene = null;

/**
 * Registered arenas (stage-agnostic). Each entry:
 *   {
 *     id, center: {x,z}, radius,
 *     paletteSlots: { wall, glow, clear },     // hex numbers
 *     doors: { group, north, south, east, west, materials: [...] },
 *     state: 'idle' | 'slamming' | 'active' | 'retracting',
 *     slamT: 0,            // seconds into slam-in animation
 *     retractT: 0,         // seconds into retract animation
 *     waveIdx: 0,          // 0-based wave currently dispatching (0..2)
 *     wavesCleared: 0,
 *     nextWaveAt: 0,       // state.time.game when next wave dispatches
 *     mobsThisWave: 0,     // count spawned this wave (used to detect "wave non-empty")
 *     eliteSpawned: false, // any elite seen by this lockdown (for run-state mirror)
 *     activeArena: false,  // true between trigger and clear
 *   }
 */
const _arenas = [];
let _nextArenaId = 1;

/** Id of the currently-active arena, or null when no lockdown is live. */
let _activeArenaId = null;

// ─── tuning constants ─────────────────────────────────────────────────────────
const SLAM_DURATION = 0.55;      // door drop-in animation seconds
const RETRACT_DURATION = 0.7;    // door lift-out animation seconds
const SLAM_START_Y = 8.0;        // doors begin this far above target Y
const DOOR_REST_Y = 0.0;         // resting Y for the door bottom edge
const WAVE_INTERVAL_SEC = 6.5;   // ~6-8s per spec (middle of range)
const PULSE_HZ = 0.9;            // emissive pulse frequency while active
const PULSE_MIN = 1.1;
const PULSE_MAX = 1.9;
const DOOR_THICK = 0.6;          // wall thickness (world units)
const DOOR_HEIGHT = 4.0;         // visible wall height
const DOOR_SPAN_MUL = 1.8;       // door length = radius * 2 * DOOR_SPAN_MUL/2 (spans most of arc face)
const CONTAINMENT_EPS = 0.35;    // hero-clamp inset from radius
const GLOW_RIM_INTENSITY = 1.4;  // slam-in rim emissive baseline

// Wave-size scaler per current difficulty D. D ranges 0..SPAWN.difficultyMax
// (~7-9 typical for Forest). Base 6 + ceil(D * 1.5) ≈ 8-19 mobs per wave.
function _waveCount(D) {
  return 6 + Math.ceil(Math.max(0, D) * 1.5);
}

// ─── geometry pre-pool (per-arena) ────────────────────────────────────────────
// Build 4 cardinal door slabs (north/south/east/west) around the arena. Each
// slab is a merged BufferGeometry (single box merged into the parent buffer
// — gives flatShading the per-face normal it needs without UV mapping).
// Stored on arena.doors; triggerLockdown only mutates position + material
// uniforms.
function _buildDoorMeshes(arena) {
  const { center, radius, paletteSlots } = arena;
  const wallColor = paletteSlots.wall;
  const glowColor = paletteSlots.glow;

  const spanLen = radius * DOOR_SPAN_MUL; // door length (world units)
  const halfSpan = spanLen / 2;

  // Slab geometry — one box per door, merged into a single BufferGeometry so
  // flatShading produces clean facets and a single draw call per door covers
  // the whole slab. Width=spanLen, height=DOOR_HEIGHT, depth=DOOR_THICK.
  function _makeSlabGeo() {
    const box = new THREE.BoxGeometry(spanLen, DOOR_HEIGHT, DOOR_THICK);
    // Re-bake to non-indexed so flatShading recomputes per-face normals
    // (BoxGeometry ships indexed with smooth normals from shared verts).
    const flat = box.toNonIndexed();
    flat.computeVertexNormals();
    box.dispose();
    return flat;
  }

  // Material — Lambert + emissive. Per-arena (so a chained arena trigger on
  // a different palette doesn't bleed). flatShading on Lambert is honored.
  function _makeSlabMat() {
    return new THREE.MeshLambertMaterial({
      color: wallColor,
      emissive: glowColor,
      emissiveIntensity: 0.0,        // off until slam-in starts
      transparent: true,
      opacity: 0.0,                  // hidden until slam-in starts
      flatShading: true,
      depthWrite: true,
    });
  }

  const group = new THREE.Group();
  group.visible = false;

  // 4 doors arranged on cardinal arcs around center
  // North: +Z face, rotation about Y so door's long axis lies along X
  // South: -Z face, same rotation
  // East:  +X face, rotation 90° about Y so long axis lies along Z
  // West:  -X face, rotation 90° about Y
  const restY = DOOR_HEIGHT / 2 + DOOR_REST_Y; // mesh origin at slab center
  const offset = radius + DOOR_THICK / 2;

  const doors = {};
  const materials = [];
  const _addDoor = (name, dx, dz, rotY) => {
    const geo = _makeSlabGeo();
    const mat = _makeSlabMat();
    materials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(center.x + dx, restY, center.z + dz);
    mesh.rotation.y = rotY;
    mesh.userData.targetY = restY;
    mesh.userData.dx = dx;
    mesh.userData.dz = dz;
    group.add(mesh);
    doors[name] = mesh;
  };

  _addDoor('north', 0,       offset,  0);
  _addDoor('south', 0,      -offset,  0);
  _addDoor('east',  offset,  0,       Math.PI / 2);
  _addDoor('west', -offset,  0,       Math.PI / 2);

  // Use far halfSpan to ensure doors visually overlap at the corners
  // (slab corners meet ~radius+thick offset, span is 1.8×radius long;
  // overlap is small but visible enough to read as "sealed").
  void halfSpan; // referenced for future tuning; suppress unused-var lint

  arena.doors = {
    group,
    north: doors.north,
    south: doors.south,
    east:  doors.east,
    west:  doors.west,
    materials,
  };
}

// ─── per-tick: door animation ─────────────────────────────────────────────────
function _tickDoorAnim(arena, dt) {
  const { state: aState, doors } = arena;
  if (!doors) return;

  if (aState === 'slamming') {
    arena.slamT += dt;
    const k = Math.min(1, arena.slamT / SLAM_DURATION);
    // ease-out cubic for the drop
    const ease = 1 - Math.pow(1 - k, 3);
    const startY = SLAM_START_Y + DOOR_HEIGHT / 2;
    const endY = DOOR_HEIGHT / 2 + DOOR_REST_Y;
    const y = startY + (endY - startY) * ease;
    const opacity = k; // fade-in alongside drop so doors don't pop into view
    const rim = (1 - k) * GLOW_RIM_INTENSITY + PULSE_MIN * k;

    for (const name of ['north', 'south', 'east', 'west']) {
      const d = doors[name];
      if (!d) continue;
      d.position.y = y;
      d.material.opacity = opacity;
      d.material.emissiveIntensity = rim;
    }
    if (k >= 1) {
      arena.state = 'active';
      arena.slamT = 0;
    }
  } else if (aState === 'active') {
    // Bio-glow pulse — emissive sin between PULSE_MIN and PULSE_MAX
    const t = state.time.real;
    const phase = (Math.sin(t * Math.PI * 2 * PULSE_HZ) + 1) * 0.5; // 0..1
    const e = PULSE_MIN + (PULSE_MAX - PULSE_MIN) * phase;
    for (const m of doors.materials) {
      m.emissiveIntensity = e;
      m.opacity = 1.0;
    }
  } else if (aState === 'retracting') {
    arena.retractT += dt;
    const k = Math.min(1, arena.retractT / RETRACT_DURATION);
    const ease = k * k; // ease-in (lift accelerates)
    const startY = DOOR_HEIGHT / 2 + DOOR_REST_Y;
    const endY = SLAM_START_Y + DOOR_HEIGHT / 2;
    const y = startY + (endY - startY) * ease;
    const opacity = 1 - k;
    // amber flash: glow lerps from clear color back to wall slot at the very end
    const clearColor = arena.paletteSlots.clear;
    for (const m of doors.materials) {
      m.opacity = opacity;
      m.emissiveIntensity = 2.0 * (1 - k * 0.6);
      // Briefly tint emissive toward "clear" slot for the retract punctuation.
      // Only set once at start (k<0.05) to avoid per-frame Color allocs.
      if (arena.retractT - dt <= 0 && m.emissive) {
        m.emissive.setHex(clearColor);
      }
    }
    for (const name of ['north', 'south', 'east', 'west']) {
      const d = doors[name];
      if (d) d.position.y = y;
    }
    if (k >= 1) {
      arena.state = 'idle';
      arena.retractT = 0;
      if (doors.group) doors.group.visible = false;
      // Reset emissive back to glow slot so the next trigger reads "active glow"
      // rather than "clear amber" on the first slam-in pulse.
      for (const m of doors.materials) {
        if (m.emissive) m.emissive.setHex(arena.paletteSlots.glow);
      }
    }
  }
}

// ─── wave dispatcher (substitutes for spawnDirector cadence) ──────────────────
function _spawnWave(arena, waveIdx) {
  // Mirror spawnDirector.computeDifficulty without import-cycle pain — read
  // the same SPAWN constants and use state.time.game directly.
  const t = state.time.game;
  let D;
  if (t <= 0) D = 0;
  else if (t < SPAWN.difficultyRampSec) D = t / SPAWN.difficultyRampSec;
  else if (t < SPAWN.difficultyMaxSec) {
    const span = SPAWN.difficultyMaxSec - SPAWN.difficultyRampSec;
    const k = (t - SPAWN.difficultyRampSec) / span;
    D = 1 + k * (SPAWN.difficultyMax - 1);
  } else {
    D = SPAWN.difficultyMax;
  }

  // Use non-elite tiers unlocked at current D for mob fodder. Wave 3 has a
  // small chance to swap in an elite (the "skill window" mob — killing it
  // clears the lockdown early).
  const allowed = ENEMY_TIERS.filter(tier => tier.minD <= D && !tier.elite);
  const eliteAllowed = ENEMY_TIERS.filter(tier => tier.minD <= D + 1 && tier.elite);
  const pool = allowed.length > 0 ? allowed : ENEMY_TIERS.filter(tier => !tier.elite);

  const count = _waveCount(D);
  const r = arena.radius * 0.85; // spawn just inside the door ring
  arena.mobsThisWave = 0;

  // Wave 3 elite gate — coin-flip (50%) to inject one elite from the eligible
  // pool. Tagging it _lockdownElite lets the clear scan early-exit the run.
  const injectElite = (waveIdx === 2) && eliteAllowed.length > 0 && Math.random() < 0.5;
  if (injectElite) {
    const choice = eliteAllowed[Math.floor(Math.random() * eliteAllowed.length)];
    const a = Math.random() * Math.PI * 2;
    const ex = arena.center.x + Math.cos(a) * r;
    const ez = arena.center.z + Math.sin(a) * r;
    spawnEnemy(choice, ex, ez);
    // Tag the just-spawned enemy. spawnEnemy pushes onto state.enemies.active
    // synchronously, so the last entry is ours (unless something is wrong,
    // in which case the tag is harmlessly skipped).
    const e = state.enemies.active[state.enemies.active.length - 1];
    if (e) {
      e._lockdownWave = waveIdx;
      e._lockdownElite = true;
      e._lockdownArenaId = arena.id;
    }
    arena.mobsThisWave++;
    arena.eliteSpawned = true;
    if (state.run) state.run.lockdownEliteSeen = true;
  }

  for (let i = 0; i < count; i++) {
    const tier = pool[Math.floor(Math.random() * pool.length)];
    const a = Math.random() * Math.PI * 2;
    const sx = arena.center.x + Math.cos(a) * r;
    const sz = arena.center.z + Math.sin(a) * r;
    spawnEnemy(tier, sx, sz);
    const e = state.enemies.active[state.enemies.active.length - 1];
    if (e) {
      e._lockdownWave = waveIdx;
      e._lockdownElite = false;
      e._lockdownArenaId = arena.id;
    }
    arena.mobsThisWave++;
  }
}

// ─── clear detection ──────────────────────────────────────────────────────────
// Returns true if (a) any elite tagged for this arena is dead, OR
// (b) all currently-tagged mobs (across all waves) are dead AND wavesCleared
// has reached 3.
function _checkClear(arena) {
  let aliveTagged = 0;
  let eliteAlive = 0;
  let eliteDeadSeen = false;
  const active = state.enemies.active;
  for (let i = 0; i < active.length; i++) {
    const e = active[i];
    if (!e || e._lockdownArenaId !== arena.id) continue;
    if (e.alive) {
      aliveTagged++;
      if (e._lockdownElite) eliteAlive++;
    } else if (e._lockdownElite) {
      eliteDeadSeen = true;
    }
  }
  // Early clear via elite kill: the spawned-elite was alive last frame, dead
  // this frame. We detect by "elite tag exists in the list AND not alive".
  // (Dead enemies linger in state.enemies.active for a few frames before
  // killEnemy removes them — that's our detection window.)
  if (arena.eliteSpawned && eliteAlive === 0 && eliteDeadSeen) {
    return { cleared: true, reason: 'elite' };
  }
  // Wave-progression clear: each wave's mobs must all be dead before we
  // advance. Track the "current wave" via arena.waveIdx and only count
  // aliveTagged that match it.
  const waveStillAlive = active.some(e =>
    e && e.alive && e._lockdownArenaId === arena.id && e._lockdownWave === arena.waveIdx
  );
  if (!waveStillAlive && arena.mobsThisWave > 0) {
    return { cleared: false, advance: true, reason: 'wave-cleared' };
  }
  // Defensive total-empty check (covers the all-3-waves edge if mobsThisWave
  // tracking ever drifts): if 3 waves were dispatched + no tagged mobs alive.
  if (arena.wavesCleared >= 3 && aliveTagged === 0) {
    return { cleared: true, reason: 'all-waves' };
  }
  return { cleared: false };
}

// ─── reward bundle ────────────────────────────────────────────────────────────
function _dropRewardBundle(arena) {
  const cx = arena.center.x;
  const cz = arena.center.z;

  // 8 gem cluster — small radial spray, value 3 each (small splash).
  const tmp = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const r = 1.2 + Math.random() * 0.6;
    tmp.set(cx + Math.cos(a) * r, 0.3, cz + Math.sin(a) * r);
    try { dropGem(tmp.clone(), 3); } catch (_) {}
  }

  // 1 chest at arena center
  try { spawnChest(cx, cz); } catch (e) { console.warn('[lockdownArena] spawnChest failed:', e); }

  // FX punch + sfx — match nemesis-slain reward shape
  if (state.fx) {
    state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.9);
    state.fx.shake = Math.max(state.fx.shake || 0, 0.4);
  }
  try { if (sfx && sfx.eliteDeath) sfx.eliteDeath(); } catch (_) {}
}

// ─── public API ───────────────────────────────────────────────────────────────
export function initLockdownArena(scene) {
  _scene = scene;
}

/**
 * Register a lockdown arena. Pre-builds door geometry at this call (zero
 * allocation at trigger time). Returns the arena id used by triggerLockdown.
 *
 * @param {object} opts
 * @param {{x:number,z:number}} opts.center   World-space center
 * @param {number} opts.radius                Arena radius (world units, default 8)
 * @param {{wall:number, glow:number, clear:number}} opts.paletteSlots
 *        Hex color numbers (use stage's locked palette slots).
 * @returns {number} arenaId
 */
export function armLockdown(opts) {
  if (!_scene) { console.warn('[lockdownArena] armLockdown called before initLockdownArena'); return -1; }
  if (!opts || !opts.center) { console.warn('[lockdownArena] armLockdown missing opts.center'); return -1; }
  const id = _nextArenaId++;
  const arena = {
    id,
    center: { x: opts.center.x, z: opts.center.z },
    radius: opts.radius || 8,
    paletteSlots: {
      wall:  (opts.paletteSlots && opts.paletteSlots.wall)  || 0x2d3a55,
      glow:  (opts.paletteSlots && opts.paletteSlots.glow)  || 0x7df0c4,
      clear: (opts.paletteSlots && opts.paletteSlots.clear) || 0xf5a300,
    },
    doors: null,
    state: 'idle',
    slamT: 0,
    retractT: 0,
    waveIdx: 0,
    wavesCleared: 0,
    nextWaveAt: 0,
    mobsThisWave: 0,
    eliteSpawned: false,
    activeArena: false,
  };
  _buildDoorMeshes(arena);
  _scene.add(arena.doors.group);
  _arenas.push(arena);
  return id;
}

/**
 * Activate a previously-armed arena. Returns true if the lockdown started,
 * false if another lockdown is already live (single-active rule).
 */
export function triggerLockdown(arenaId) {
  if (_activeArenaId != null) return false; // single-active rule
  const arena = _arenas.find(a => a.id === arenaId);
  if (!arena) { console.warn('[lockdownArena] triggerLockdown: unknown arena', arenaId); return false; }
  if (arena.state !== 'idle') return false;

  _activeArenaId = arenaId;
  arena.activeArena = true;
  arena.state = 'slamming';
  arena.slamT = 0;
  arena.retractT = 0;
  arena.waveIdx = 0;
  arena.wavesCleared = 0;
  arena.mobsThisWave = 0;
  arena.eliteSpawned = false;
  arena.triggeredAt = state.time.game; // watchdog timestamp for force-clear safety net

  // Reveal door group + reset opacity (in case a prior run left them hidden
  // mid-fade). The pulse loop in _tickDoorAnim will rewrite per frame.
  if (arena.doors && arena.doors.group) {
    arena.doors.group.visible = true;
    for (const m of arena.doors.materials) {
      m.opacity = 0.0;
      m.emissiveIntensity = 0.0;
    }
  }

  // Mirror to run-state so spawnDirector + UI can read.
  if (state.run) {
    state.run.lockdownActive = true;
    state.run.lockdownWavesCleared = 0;
    state.run.lockdownEliteSeen = false;
  }

  // First wave dispatches right when slam-in completes; queue it now.
  arena.nextWaveAt = state.time.game + SLAM_DURATION;

  // Wave banner — slot 8 cyan-white per Forest spec
  try { showBanner('LOCKDOWN — WAVE 1/3', 2.0, '#a8e6ff'); } catch (_) {}
  if (state.fx) {
    state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.45);
    state.fx.shake = Math.max(state.fx.shake || 0, 0.3);
  }
  return true;
}

/**
 * Per-frame tick. Drives door animation, wave dispatcher, clear detection,
 * and hero containment clamp. Call once per frame from main.js (after
 * spawnDirector so wave spawns happen on the same frame the director would
 * have run a top-up).
 */
export function tickLockdownArena(dt) {
  // Anim all arenas (idle ones early-out inside _tickDoorAnim)
  for (let i = 0; i < _arenas.length; i++) _tickDoorAnim(_arenas[i], dt);

  if (_activeArenaId == null) return;
  const arena = _arenas.find(a => a.id === _activeArenaId);
  if (!arena) { _activeArenaId = null; return; }

  // Hero containment clamp — soft push back inside radius. Only while doors
  // are actively up (slamming/active/retracting all count; retracting still
  // keeps the player inside for the reward beat).
  const hero = state.hero;
  if (hero && hero.pos && arena.state !== 'idle') {
    const dx = hero.pos.x - arena.center.x;
    const dz = hero.pos.z - arena.center.z;
    const d2 = dx * dx + dz * dz;
    const maxR = arena.radius - CONTAINMENT_EPS;
    if (d2 > maxR * maxR) {
      const d = Math.sqrt(d2);
      const k = maxR / d;
      hero.pos.x = arena.center.x + dx * k;
      hero.pos.z = arena.center.z + dz * k;
      if (hero.mesh && hero.mesh.position) {
        hero.mesh.position.x = hero.pos.x;
        hero.mesh.position.z = hero.pos.z;
      }
    }
  }

  // Wave + clear logic only runs while doors are up (active state).
  if (arena.state !== 'active') return;

  // Watchdog: if lockdown has been active for >90s without resolving, force-
  // clear. Protects against edge cases (death-respawn, lost enemy tags,
  // spawnEnemy returning null, etc.) where the player would otherwise be
  // trapped indefinitely.
  if (arena.triggeredAt && (state.time.game - arena.triggeredAt) > 90) {
    arena.state = 'retracting';
    arena.retractT = 0;
    arena.activeArena = false;
    _activeArenaId = null;
    if (state.run) state.run.lockdownActive = false;
    try { showBanner('LOCKDOWN TIMED OUT', 2.2, '#ff7a52'); } catch (_) {}
    _dropRewardBundle(arena);
    return;
  }

  // Dispatch next wave if due. Gate via nextWaveAt = +Infinity so we only
  // dispatch ONCE per wave (else this fires every tick at 60/s, spawning
  // hundreds of mobs/sec and freezing the game — first-playtest bug 2026-05-16).
  const t = state.time.game;
  if (arena.waveIdx < 3 && t >= arena.nextWaveAt && Number.isFinite(arena.nextWaveAt)) {
    _spawnWave(arena, arena.waveIdx);
    arena.nextWaveAt = Number.POSITIVE_INFINITY; // re-armed by wave-advance below
  }

  // Check clear / wave-advance
  const res = _checkClear(arena);
  if (res.cleared) {
    arena.state = 'retracting';
    arena.retractT = 0;
    arena.activeArena = false;
    _activeArenaId = null;
    if (state.run) {
      state.run.lockdownActive = false;
      // wavesCleared mirror: full clear via elite still counts the waves
      // actually completed; full-clear path bumps to 3.
      if (res.reason === 'all-waves') state.run.lockdownWavesCleared = 3;
    }
    try { showBanner('LOCKDOWN CLEARED', 2.2, '#ffd86b'); } catch (_) {}
    _dropRewardBundle(arena);
    return;
  }
  if (res.advance) {
    arena.waveIdx++;
    arena.wavesCleared++;
    arena.mobsThisWave = 0; // reset so next wave's _checkClear "advance" condition needs a fresh non-empty wave
    if (state.run) state.run.lockdownWavesCleared = arena.wavesCleared;
    if (arena.waveIdx < 3) {
      arena.nextWaveAt = t + WAVE_INTERVAL_SEC;
      const label = `LOCKDOWN — WAVE ${arena.waveIdx + 1}/3`;
      try { showBanner(label, 2.0, '#a8e6ff'); } catch (_) {}
    } else {
      // All 3 waves dispatched + all dead — next tick will hit the
      // wavesCleared>=3 + aliveTagged===0 branch and clear.
      arena.nextWaveAt = Number.POSITIVE_INFINITY;
    }
  }
}

/**
 * Run-reset hook: wipe per-arena live state (waves, active) but keep the
 * registered arenas + door meshes around (cheap; re-armed next run).
 */
export function resetLockdownArenas() {
  for (const arena of _arenas) {
    arena.state = 'idle';
    arena.slamT = 0;
    arena.retractT = 0;
    arena.waveIdx = 0;
    arena.wavesCleared = 0;
    arena.nextWaveAt = 0;
    arena.mobsThisWave = 0;
    arena.eliteSpawned = false;
    arena.activeArena = false;
    if (arena.doors) {
      arena.doors.group.visible = false;
      for (const m of arena.doors.materials) {
        m.opacity = 0.0;
        m.emissiveIntensity = 0.0;
        if (m.emissive) m.emissive.setHex(arena.paletteSlots.glow);
      }
      for (const name of ['north', 'south', 'east', 'west']) {
        const d = arena.doors[name];
        if (d) d.position.y = DOOR_HEIGHT / 2 + DOOR_REST_Y;
      }
    }
  }
  _activeArenaId = null;
  if (state.run) {
    state.run.lockdownActive = false;
    state.run.lockdownWavesCleared = 0;
    state.run.lockdownEliteSeen = false;
  }
}

/**
 * Full teardown — removes door meshes from scene + disposes geometry/materials.
 * Call from the run-reset path (paired with clearArenaDecor / clearForestAmber).
 */
export function disposeLockdownArenas(scene) {
  const s = scene || _scene;
  for (const arena of _arenas) {
    if (!arena.doors) continue;
    if (arena.doors.group && arena.doors.group.parent) {
      arena.doors.group.parent.remove(arena.doors.group);
    } else if (s && arena.doors.group) {
      s.remove(arena.doors.group);
    }
    for (const name of ['north', 'south', 'east', 'west']) {
      const d = arena.doors[name];
      if (d) {
        if (d.geometry) d.geometry.dispose();
        if (d.material && d.material.dispose) d.material.dispose();
      }
    }
    arena.doors = null;
  }
  _arenas.length = 0;
  _nextArenaId = 1;
  _activeArenaId = null;
  if (state.run) {
    state.run.lockdownActive = false;
    state.run.lockdownWavesCleared = 0;
    state.run.lockdownEliteSeen = false;
  }
}
