/**
 * Void Teleport Pads — discrete interactable entity.
 *
 * Phase-2 Void Teleport Pads Agent implementation.
 * Contract: docs/VOID_VISUAL_STYLE.md §"Teleport Pad Spec —
 * Step + Teleport Interaction Contract".
 *
 * Public API:
 *   loadVoidTeleportPads(scene, hotspotsUrl?)
 *     — spawn entities from JSON, return count.
 *   tickVoidTeleportPads(dt, state)
 *     — per-frame: idle pulse, proximity step detection, teleport
 *       resolution (auto-nearest OR explicit pairWith), cooldown
 *       management, flash FX lifecycles, re-entry guard.
 *   clearVoidTeleportPads(scene)
 *     — dispose all entities + in-flight flash FX.
 *
 * Hotspot JSON: [{ x, z, scale, seed, pairWith? }]
 *               (see assets/void_teleport_hotspots.json)
 *
 * === PERSISTENCE MODEL (LOCKED): per-entity cooldown timestamp ===
 * pad.cooldownUntil = state.time.game + 6.0 (per-entity), NOT on state.run.
 * Stage teardown wipes _pads → wipes all cooldown state. No leakage across
 * runs. Mirrors cinderBallistas.js per-entity `activated` flag pattern.
 *
 * === TELEPORT MUTATION HOOK (LOCKED): direct state.hero.pos + mesh mutation ===
 * Teleport is INSTANTANEOUS, not a flag — so we don't push through state.run
 * the way twilightFountains.js publishes its speed-buff. On the activation
 * frame we directly mutate:
 *   state.hero.pos.x = destPad.x;   state.hero.pos.z = destPad.z;
 *   state.hero.mesh.position.x = destPad.x;
 *   state.hero.mesh.position.z = destPad.z;
 *   state.hero.iFramesUntil = state.time.game + 0.4;
 * Y-position untouched (player stays on the floor plane). Mesh + pos snap
 * in the SAME tick so the mesh never lags one frame behind the logical pos
 * (which would let an enemy collision check land between the two halves).
 *
 * === DESTINATION RESOLUTION (LOCKED): auto-nearest OR explicit pairWith ===
 * If `pad.pairWith` is set in the hotspot JSON, that pad ALWAYS teleports
 * to the pad with matching seed — even if a nearer pad exists, even if the
 * paired pad is in cooldown (in which case the teleport is SUPPRESSED for
 * this tick; the step trigger still consumes — player must step off and
 * back on). Pairing is ASYMMETRIC: setting pairWith on A does NOT auto-set
 * it on B. Decor Agent decides each direction.
 *
 * If `pad.pairWith` is unset, pick the nearest OTHER pad whose
 * cooldownUntil <= state.time.game. Ties broken by lower seed.
 *
 * Palette (8-color void, locked):
 *   slot 1 #040208 — obsidian black (pad base undertone)
 *   slot 2 #1a0a3a — deep violet abyss (cooldown ring overlay, bloom OFF)
 *   slot 3 #3a1a5e — cosmic purple mid (pad disc rim trim, optional)
 *   slot 4 #d8dce8 — chrome white edge (pad disc bevel highlight)
 *   slot 5 #00d4ff — portal cyan idle (pad disc emissive baseline)
 *   slot 6 #7fffff — portal cyan active (pad disc emissive peak)
 *   slot 7 #ffffff — teleport flash (single-frame disc + activation ring)
 *   slot 8 #a8b8ff — star points (optional ambient particles, bloom ON)
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from './postfx.js';
import { sfx } from './audio.js';

// ─── module state ─────────────────────────────────────────────────────────────
const _pads = [];            // { x, z, scale, seed, pairWith, cooldownUntil, ... }
const _disposables = [];     // geos/mats tracked for clearVoidTeleportPads
let _hotspotsLoaded = null;
let _group = null;           // parent Group added to scene (single removal target)

// In-flight teleport flash FX (origin + destination short-lived expanding rings).
// { group, mats, geos, t, life, baseOpacity }
const _flashRings = [];

// ─── tuning constants (LOCKED per docs/VOID_VISUAL_STYLE.md) ──────────────────
export const PROXIMITY_R = 1.2;
export const PROXIMITY_R2 = PROXIMITY_R * PROXIMITY_R;
export const COOLDOWN_DURATION = 6.0;
export const LOCAL_STEP_GUARD = 0.3;      // re-entry guard on destination pad
export const IFRAMES_ON_ARRIVAL = 0.4;    // matches HERO.iFramesSec band

export const IDLE_PULSE_HZ = 0.7;
export const IDLE_EMISSIVE_MIN = 1.4;
export const IDLE_EMISSIVE_MAX = 2.0;
export const TELEPORT_FLASH_EMISSIVE = 3.5;

// Activation ring FX (short-lived expanding ring on slot 7 at origin + dest).
export const FLASH_RING_LIFE = 0.15;
export const FLASH_RING_INNER_R = 0.6;
export const FLASH_RING_LINE_WIDTH = 0.10;
export const FLASH_RING_OPACITY = 1.0;

// Cooldown ring overlay (slot 2, bloom OFF, opacity ramps 0.85 → 0.0).
export const COOLDOWN_RING_INNER_R = 0.95;
export const COOLDOWN_RING_LINE_WIDTH = 0.05;
export const COOLDOWN_RING_OPACITY_MAX = 0.85;

// Disc Y-bob.
const DISC_BOB_AMP = 0.02;

// ─── palette color constants (void, locked) ──────────────────────────────────
export const COLOR_OBSIDIAN_BLACK = 0x040208;   // slot 1
export const COLOR_DEEP_VIOLET    = 0x1a0a3a;   // slot 2
export const COLOR_COSMIC_PURPLE  = 0x3a1a5e;   // slot 3
export const COLOR_CHROME_WHITE   = 0xd8dce8;   // slot 4
export const COLOR_PORTAL_IDLE    = 0x00d4ff;   // slot 5
export const COLOR_PORTAL_ACTIVE  = 0x7fffff;   // slot 6
export const COLOR_TELEPORT_FLASH = 0xffffff;   // slot 7
export const COLOR_STAR_POINT     = 0xa8b8ff;   // slot 8

// ─── seeded PRNG (mirrors twilightFountains.js / cinderBallistas.js) ─────────
function _seededRand(seed) {
  let s = (seed >>> 0) || 1;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── geometry builders (shared across all pads) ──────────────────────────────
// TODO(Phase-2 Pads Agent): wire these into the per-entity assembly group in
// loadVoidTeleportPads. Disc + rim are shared geometries; emissive material
// is per-entity so the idle pulse + teleport flash can lerp independently.
//
// Disc — thin cylinder lying flat. Slot 5/6 emissive (per-entity), slot 4
// chrome-white edge highlight as an inset secondary mesh.
function _buildDiscGeometry() {
  const geo = new THREE.CylinderGeometry(0.85, 0.85, 0.06, 32, 1, false);
  return geo;
}
// Rim — slim torus at the disc edge for the chrome-white highlight, slot 4.
function _buildRimGeometry() {
  const geo = new THREE.TorusGeometry(0.85, 0.04, 8, 32);
  geo.rotateX(Math.PI / 2);
  return geo;
}
// Cooldown overlay ring — RingGeometry on XZ plane, slot 2, bloom OFF.
// Built per-entity so opacity ramps independently. Returned shape mirrors
// cinderBallistas._spawnRepairAura but with bloom OFF + slot 2 color.
function _spawnCooldownRing(parentGroup) {
  const inner = COOLDOWN_RING_INNER_R;
  const outer = inner + COOLDOWN_RING_LINE_WIDTH;
  const geo = new THREE.RingGeometry(inner, outer, 48, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: COLOR_DEEP_VIOLET,
    transparent: true,
    opacity: 0.0,                       // ramped up the moment cooldown starts
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,   // bloom OFF — additive but no BLOOM_LAYER enable
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = 0.06;               // sits flush atop the disc
  mesh.frustumCulled = false;
  // NOTE: do NOT enable BLOOM_LAYER. Cooldown is a state, not a celebration.
  parentGroup.add(mesh);
  return { mesh, mat, geo };
}

// ─── teleport flash ring (slot 7, bloom ON) ──────────────────────────────────
// Short-lived expanding ring spawned at origin + destination on activation.
// TODO(Phase-2 Pads Agent): expansion behavior is "thin line that grows
// outward and fades" — mirror the forest_amber shockwave ring growth curve
// (life-driven scale, opacity fade-out). Decor + line-weight values locked
// above.
function _spawnFlashRing(scene, x, z) {
  const inner = FLASH_RING_INNER_R;
  const outer = inner + FLASH_RING_LINE_WIDTH;
  const geo = new THREE.RingGeometry(inner, outer, 48, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: COLOR_TELEPORT_FLASH,
    transparent: true,
    opacity: FLASH_RING_OPACITY,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, 0.08, z);
  mesh.frustumCulled = false;
  mesh.layers.enable(BLOOM_LAYER);
  scene.add(mesh);
  return {
    group: mesh,                        // single mesh — `.group` for symmetry with twilight aura shape
    mats: [mat],
    geos: [geo],
    baseOpacity: FLASH_RING_OPACITY,
    t: 0,
    life: FLASH_RING_LIFE,
  };
}

// ─── public: load ─────────────────────────────────────────────────────────────
export async function loadVoidTeleportPads(scene, hotspotsUrl = 'assets/void_teleport_hotspots.json') {
  if (!scene) return 0;
  // Idempotent: tear down any prior group before rebuilding.
  clearVoidTeleportPads(scene);

  let hotspots = null;
  try {
    const res = await fetch(hotspotsUrl);
    hotspots = await res.json();
  } catch (e) {
    console.warn('[voidTeleportPads] hotspot fetch failed:', e);
    return 0;
  }
  if (!Array.isArray(hotspots) || hotspots.length === 0) return 0;
  _hotspotsLoaded = hotspots;

  _group = new THREE.Group();
  _group.name = '__voidTeleportPads';

  // TODO(Phase-2 Pads Agent): build shared disc/rim geometries here, register
  // them in _disposables, then per-entity assemble:
  //   - entGroup at (h.x, 0, h.z) scaled by h.scale
  //   - discMesh (shared geo + per-entity emissive material on slot 5)
  //   - rimMesh (shared geo + shared chrome-white material on slot 4)
  //   - cooldown ring spawned via _spawnCooldownRing(entGroup) — opacity 0
  //     by default, ramped only during cooldown
  //   - optional per-entity ambient slot-8 star-point particles (≤8/pad)
  //
  // Disc emissive material: NEW per-entity MeshStandardMaterial with
  //   color: COLOR_PORTAL_IDLE,
  //   emissive: COLOR_PORTAL_IDLE,
  //   emissiveIntensity: IDLE_EMISSIVE_MIN,
  //   transparent: true, opacity: 0.95,
  //   roughness: 0.30, metalness: 0.20.
  // Enable BLOOM_LAYER on disc mesh. Rim mesh: bloom OFF (chrome edge is
  // diffuse highlight only).

  for (const h of hotspots) {
    const s = h.scale || 1;
    const seed = (h.seed | 0) || 0;
    const pairWith = (typeof h.pairWith === 'number') ? (h.pairWith | 0) : null;
    const rng = _seededRand(seed);

    // Per-entity assembly group.
    const entGroup = new THREE.Group();
    entGroup.position.set(h.x, 0, h.z);
    entGroup.scale.setScalar(s);

    // TODO(Phase-2 Pads Agent): add disc + rim meshes here. Cooldown ring
    // overlay should be spawned but kept opacity-0 until cooldown starts.

    _group.add(entGroup);

    _pads.push({
      x: h.x, z: h.z, scale: s, seed, pairWith,
      cooldownUntil: 0,                 // ready by default
      localStepGuard: 0,                // re-entry guard (set on destination after teleport)
      pulsePhase: rng() * Math.PI * 2,  // desync per pad
      bobPhase: rng() * Math.PI * 2,
      // Phase-2 fills these after building meshes:
      entGroup,
      discMesh: null,
      discMat: null,
      rimMesh: null,
      cooldownRing: null,               // { mesh, mat, geo } from _spawnCooldownRing
      rng,
    });
  }

  scene.add(_group);
  return _pads.length;
}

// ─── helper: destination resolution ──────────────────────────────────────────
// TODO(Phase-2 Pads Agent): called inside tickVoidTeleportPads on a successful
// step trigger. Returns { destPad, suppressed } — destPad === null means the
// teleport could not resolve (paired pad in cooldown OR only 1 pad ready)
// and should be SUPPRESSED for this tick (no flash, no SFX, no pos mutation).
// The step trigger is still considered consumed — caller does NOT re-check
// proximity until the player physically leaves and re-enters.
//
// Implementation sketch (LOCKED — do not redesign):
//   1) if (pad.pairWith != null) {
//        const target = _pads.find(p => p.seed === pad.pairWith);
//        if (!target) return { destPad: null, suppressed: true };       // bad config
//        if (target.cooldownUntil > tNow) return { destPad: null, suppressed: true };
//        return { destPad: target, suppressed: false };
//      }
//   2) auto-nearest fallback:
//        let best = null, bestD2 = Infinity;
//        for (const p of _pads) {
//          if (p === pad) continue;
//          if (p.cooldownUntil > tNow) continue;
//          const dx = p.x - pad.x, dz = p.z - pad.z;
//          const d2 = dx*dx + dz*dz;
//          if (d2 < bestD2 || (d2 === bestD2 && p.seed < best.seed)) {
//            best = p; bestD2 = d2;
//          }
//        }
//        return { destPad: best, suppressed: best === null };
function _resolveDestination(originPad, tNow) {
  // TODO(Phase-2 Pads Agent): implement per the sketch above.
  return { destPad: null, suppressed: true };
}

// ─── public: tick ────────────────────────────────────────────────────────────
export function tickVoidTeleportPads(dt, state) {
  if (!state || _pads.length === 0) return;
  const scene = state.scene;
  if (!scene) return;
  const tNow = (state.time && state.time.game) || 0;
  const hero = state.hero;
  const heroPos = hero && hero.pos;
  const heroAlive = !!(hero && hero.hp > 0 && !state.gameOver);

  // ── 1) Per-pad update ──────────────────────────────────────────────────────
  for (const pad of _pads) {
    // TODO(Phase-2 Pads Agent): per-pad work outline. Fill once meshes exist.
    //
    // a) Idle pulse: advance pad.pulsePhase by dt * 2π * IDLE_PULSE_HZ.
    //    Lerp pad.discMat.emissiveIntensity between IDLE_EMISSIVE_MIN and
    //    IDLE_EMISSIVE_MAX using 0.5 + 0.5*sin(pulsePhase). At pulse peak
    //    (e.g. k > 0.95), set discMat.emissive to COLOR_PORTAL_ACTIVE,
    //    otherwise COLOR_PORTAL_IDLE. Disc Y-bob from bobPhase at DISC_BOB_AMP.
    //
    // b) Cooldown overlay update: if pad.cooldownUntil > tNow, set
    //    cooldownRing.mat.opacity to COOLDOWN_RING_OPACITY_MAX * remaining/6.
    //    When cooldownUntil <= tNow AND opacity > 0, snap opacity to 0 and
    //    fire sfx.voidPadReady() ONCE (use a per-pad flag `_lastCooldownState`
    //    to avoid re-firing every tick once ready).
    //
    // c) Re-entry guard: if pad.localStepGuard > tNow, skip the step
    //    proximity check below (player is standing on the destination pad
    //    after teleport — must walk off first).
    //
    // d) Step proximity: if heroAlive AND heroPos AND pad.cooldownUntil <= tNow
    //    AND pad.localStepGuard <= tNow AND dist²(hero, pad) <= PROXIMITY_R2,
    //    resolve destination via _resolveDestination(pad, tNow) and execute
    //    the activation frame below.
    //
    // === ACTIVATION FRAME (single tick — locked per spec §3) ===
    //    const { destPad, suppressed } = _resolveDestination(pad, tNow);
    //    if (suppressed || !destPad) {
    //      // Step was consumed but teleport could not resolve. Set the
    //      // re-entry guard on THIS pad so player has to step off and back on.
    //      pad.localStepGuard = tNow + LOCAL_STEP_GUARD;
    //      continue;
    //    }
    //    // 1) Origin flash + ring at pad position.
    //    pad.discMat.emissive.setHex(COLOR_TELEPORT_FLASH);
    //    pad.discMat.emissiveIntensity = TELEPORT_FLASH_EMISSIVE;
    //    _flashRings.push(_spawnFlashRing(scene, pad.x, pad.z));
    //    // 2) Player position snap (direct mutation — NOT through state.run).
    //    state.hero.pos.x = destPad.x;
    //    state.hero.pos.z = destPad.z;
    //    if (state.hero.mesh) {
    //      state.hero.mesh.position.x = destPad.x;
    //      state.hero.mesh.position.z = destPad.z;
    //    }
    //    // 3) iFrames on arrival.
    //    state.hero.iFramesUntil = Math.max(
    //      state.hero.iFramesUntil || 0,
    //      tNow + IFRAMES_ON_ARRIVAL
    //    );
    //    // 4) Destination flash + ring at destPad position.
    //    destPad.discMat.emissive.setHex(COLOR_TELEPORT_FLASH);
    //    destPad.discMat.emissiveIntensity = TELEPORT_FLASH_EMISSIVE;
    //    _flashRings.push(_spawnFlashRing(scene, destPad.x, destPad.z));
    //    // 5) Cooldown on ORIGIN only (destination stays ready).
    //    pad.cooldownUntil = tNow + COOLDOWN_DURATION;
    //    if (pad.cooldownRing) pad.cooldownRing.mat.opacity = COOLDOWN_RING_OPACITY_MAX;
    //    // 6) Re-entry guard on DESTINATION.
    //    destPad.localStepGuard = tNow + LOCAL_STEP_GUARD;
    //    // 7) SFX — single play (origin + destination share).
    //    try { sfx.voidTeleport && sfx.voidTeleport(); } catch (_) {}
  }

  // ── 2) Tick flash rings (expand + fade + dispose on expiry) ───────────────
  // TODO(Phase-2 Pads Agent): mirror forest_amber shockwave / twilight aura
  // ring lifecycle. Sketch:
  //   for (let i = _flashRings.length - 1; i >= 0; i--) {
  //     const r = _flashRings[i];
  //     r.t += dt;
  //     const k = Math.min(1, r.t / r.life);
  //     // Expand scale 1.0 → 2.5 over the life window.
  //     const scl = 1.0 + 1.5 * k;
  //     r.group.scale.set(scl, 1, scl);
  //     // Linear opacity fade 1.0 → 0.0.
  //     r.mats[0].opacity = r.baseOpacity * (1 - k);
  //     if (k >= 1) {
  //       if (r.group.parent) r.group.parent.remove(r.group);
  //       else if (scene) scene.remove(r.group);
  //       for (const g of r.geos) { try { g.dispose(); } catch (_) {} }
  //       for (const m of r.mats) { try { m.dispose(); } catch (_) {} }
  //       _flashRings.splice(i, 1);
  //     }
  //   }
}

// ─── public: clear ───────────────────────────────────────────────────────────
export function clearVoidTeleportPads(scene) {
  // Tear down in-flight flash rings (they live as scene children).
  for (const r of _flashRings) {
    if (r.group && r.group.parent) r.group.parent.remove(r.group);
    else if (r.group && scene) scene.remove(r.group);
    for (const g of r.geos) { try { g.dispose(); } catch (_) {} }
    for (const m of r.mats) { try { m.dispose(); } catch (_) {} }
  }
  _flashRings.length = 0;

  // Tear down per-entity disc materials + cooldown ring materials.
  for (const pad of _pads) {
    if (pad.cooldownRing) {
      if (pad.cooldownRing.mesh && pad.cooldownRing.mesh.parent) {
        pad.cooldownRing.mesh.parent.remove(pad.cooldownRing.mesh);
      }
      try { pad.cooldownRing.geo.dispose(); } catch (_) {}
      try { pad.cooldownRing.mat.dispose(); } catch (_) {}
      pad.cooldownRing = null;
    }
    if (pad.discMat) { try { pad.discMat.dispose(); } catch (_) {} }
  }

  // Remove the parent group + dispose shared geos/mats.
  if (_group) {
    if (scene && _group.parent === scene) scene.remove(_group);
    else if (_group.parent) _group.parent.remove(_group);
    _group = null;
  }
  for (const d of _disposables) { try { d.dispose && d.dispose(); } catch (_) {} }
  _disposables.length = 0;

  _pads.length = 0;
  _hotspotsLoaded = null;
}

// ─── debug exports (mirror cinderBallistas.js / twilightFountains.js) ────────
export function _debugPads() { return _pads.slice(); }
export function _debugHotspots() { return _hotspotsLoaded; }
export function _debugFlashRings() { return _flashRings.slice(); }
