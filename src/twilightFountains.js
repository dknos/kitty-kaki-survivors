/**
 * Twilight Fountains — discrete interactable entity.
 *
 * Phase-2 Twilight Fountains Agent implementation.
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
 * === IMPLEMENTATION FORK (LOCKED): Option A — publish state.run.fountainSpeedBuff ===
 * Per docs/TWILIGHT_VISUAL_STYLE.md §Fountain Spec step 4. We publish
 *   state.run.fountainSpeedBuff = { mul: 1.75, expiresAt: state.time.game + 4.0 }
 * and src/hero.js (movement loop) reads it next to the existing
 * state.run.signature_engulfSlowUntil / state.run.affix_frostSlow checks
 * around hero.js:299-301. Rationale:
 *   - Mirrors the prevailing "publish-and-read" pattern (forestSlowZones,
 *     affix_frostSlow, signature_engulfSlowUntil) — no import cycle, no
 *     stat-recompute fragility under meta.js / weapons/passives.js.
 *   - Unit-testable in isolation: write the flag, read the flag, no hero
 *     module needs to be live.
 *   - Stage teardown (resetState) re-creates state.run, so a leaked buff
 *     can't carry across runs.
 * ====================================================================
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
// Punch List #7 — Velocity Veil ribbon trail + splash. Fires AFTER the buff
// is published (state.run.fountainSpeedBuff is written) so the spawn can
// snapshot expiresAt at spawn time and never re-read the (soon-to-be-nulled)
// global flag.
import { spawnVelocityVeil } from './fx/ribbonTrail.js';

// ─── module state ─────────────────────────────────────────────────────────────
const _fountains = [];        // { x, z, variant, scale, seed, state, ... }
let _hotspotsLoaded = null;
let _group = null;            // parent Group added to scene
const _disposables = [];      // geos/mats tracked for clearTwilightFountains
const _auraRings = [];        // { group, mats, geos, expiresAt, t }

// ─── tuning constants (LOCKED per docs/TWILIGHT_VISUAL_STYLE.md) ──────────────
const PROXIMITY_R = 1.5;             // drink-trigger radius (world units)
const PROXIMITY_R2 = PROXIMITY_R * PROXIMITY_R;
const DRINK_DURATION = 0.6;          // drink animation length (s)
const BUFF_DURATION = 4.0;           // movement-speed buff duration (s)
const BUFF_MUL = 1.75;               // movement-speed multiplier
const COOLDOWN_DURATION = 30.0;      // per-fountain cooldown (s) — LOCKED

const IDLE_PULSE_HZ = 0.5;           // liquid emissive pulse frequency
const IDLE_EMISSIVE_MIN = 1.2;       // spec band 1.2-1.8
const IDLE_EMISSIVE_MAX = 1.8;
const DRINK_PEAK_EMISSIVE = 3.5;     // single-frame peak on slot 7
const COOLDOWN_EMISSIVE = 0.6;       // dim flat emissive during cooldown
const LIQUID_BOB_AMP = 0.03;         // subtle Y-bob on liquid disk only

const AURA_INNER_R = 0.9;            // tight halo around player
const AURA_OUTER_R = 1.4;            // loose trail halo
const AURA_LINE_WIDTH = 0.07;        // line weight band 0.06-0.08

// Per-entity pour SFX cadence — randomised in [8, 12] so 6 fountains
// stagger naturally and the courtyard reads as a living water-bed.
// (sfx.fountainPour is module-throttled in audio.js; this stagger gives
// the audio system room to actually play distinct pours.)
const POUR_INTERVAL_MIN = 8.0;
const POUR_INTERVAL_MAX = 12.0;

const COLOR_STONE_BODY   = 0x2d1547; // slot 2 — fountain stone shadow
const COLOR_STONE_RIM    = 0xe8d4b0; // slot 4 — fountain stone rim
const COLOR_BLOOD_LIQUID = 0x8b1a2e; // slot 5 — Blood Fountain liquid
const COLOR_LIGHT_LIQUID = 0xa98030; // slot 6 — Light Fountain liquid
const COLOR_DRINK_FLASH  = 0xffcd5b; // slot 7 — single-frame drink override
const COLOR_AURA         = 0xa8e6ff; // slot 8 — speed-buff aura

// ─── seeded PRNG (mirrors forestAmber.js _seededRand) ────────────────────────
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

// ─── geometry builders (shared across all fountains) ─────────────────────────
// Stone body — short hex pedestal. Slot 2 diffuse, flat-shaded.
function _buildBodyGeometry() {
  // CylinderGeometry with 8 radial segments reads as topiary-friendly faceted
  // stone under flat-shading. Sits half-buried at y=0.25 (yBase below).
  const geo = new THREE.CylinderGeometry(0.85, 1.10, 0.55, 8, 1, false);
  return geo;
}
// Stone rim — concave dish lip. Slot 4 diffuse.
function _buildRimGeometry() {
  // Torus oriented flat (rotated to lie on XZ) makes the rim. tube radius
  // gives the bone-stone thickness.
  const geo = new THREE.TorusGeometry(0.95, 0.10, 8, 24);
  geo.rotateX(Math.PI / 2);
  return geo;
}
// Liquid disk — thin cylinder sitting on top of the rim. Per-entity material
// so emissive lerping is independent. Geometry is shared.
function _buildLiquidGeometry() {
  const geo = new THREE.CylinderGeometry(0.82, 0.82, 0.04, 24, 1, false);
  return geo;
}

// ─── aura ring spawn (slot 8, two concentric rings on player) ────────────────
// Built on the same RingGeometry approach as forestAmber's shockwave, but
// these rings DON'T expand — they orbit the player at fixed radii and fade
// opacity linear over BUFF_DURATION. Reposition each tick from state.hero.pos.
function _spawnAuraRing(scene, anchorPos, expiresAt) {
  const group = new THREE.Group();
  group.position.set(anchorPos.x, 0.04, anchorPos.z);

  // Inner tight halo.
  const innerInner = Math.max(0.001, AURA_INNER_R - AURA_LINE_WIDTH * 0.5);
  const innerOuter = innerInner + AURA_LINE_WIDTH;
  const innerGeo = new THREE.RingGeometry(innerInner, innerOuter, 48, 1);
  innerGeo.rotateX(-Math.PI / 2);
  const innerMat = new THREE.MeshBasicMaterial({
    color: COLOR_AURA, transparent: true, opacity: 1.0,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const innerMesh = new THREE.Mesh(innerGeo, innerMat);
  innerMesh.frustumCulled = false;
  innerMesh.layers.enable(BLOOM_LAYER);
  group.add(innerMesh);

  // Outer loose halo — slightly thinner line to read as a trailing echo.
  const outerInner = Math.max(0.001, AURA_OUTER_R - AURA_LINE_WIDTH * 0.4);
  const outerOuter = outerInner + AURA_LINE_WIDTH * 0.8;
  const outerGeo = new THREE.RingGeometry(outerInner, outerOuter, 48, 1);
  outerGeo.rotateX(-Math.PI / 2);
  const outerMat = new THREE.MeshBasicMaterial({
    color: COLOR_AURA, transparent: true, opacity: 0.75,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const outerMesh = new THREE.Mesh(outerGeo, outerMat);
  outerMesh.frustumCulled = false;
  outerMesh.layers.enable(BLOOM_LAYER);
  group.add(outerMesh);

  scene.add(group);
  return {
    group,
    mats: [innerMat, outerMat],
    geos: [innerGeo, outerGeo],
    baseOpacities: [1.0, 0.75],
    t: 0,
    expiresAt,
  };
}

// ─── public: load ─────────────────────────────────────────────────────────────
export async function loadTwilightFountains(scene, hotspotsUrl = 'assets/twilight_fountain_hotspots.json') {
  if (!scene) return 0;
  // Idempotent: tear down any prior group before rebuilding.
  clearTwilightFountains(scene);

  let hotspots = null;
  try {
    const res = await fetch(hotspotsUrl);
    hotspots = await res.json();
  } catch (e) {
    console.warn('[twilightFountains] hotspot fetch failed:', e);
    return 0;
  }
  if (!Array.isArray(hotspots) || hotspots.length === 0) return 0;
  _hotspotsLoaded = hotspots;

  _group = new THREE.Group();
  _group.name = '__twilightFountains';

  // Shared geometries — disposed in clearTwilightFountains.
  const bodyGeo = _buildBodyGeometry();
  const rimGeo  = _buildRimGeometry();
  const liquidGeo = _buildLiquidGeometry();
  _disposables.push(bodyGeo, rimGeo, liquidGeo);

  // Shared body/rim materials — slot 2 + slot 4, flat-shaded. Bloom off (decor).
  const bodyMat = new THREE.MeshStandardMaterial({
    color: COLOR_STONE_BODY, roughness: 0.85, metalness: 0.05, flatShading: true,
  });
  const rimMat = new THREE.MeshStandardMaterial({
    color: COLOR_STONE_RIM, roughness: 0.70, metalness: 0.05, flatShading: true,
  });
  _disposables.push(bodyMat, rimMat);

  for (const h of hotspots) {
    const variant = h.variant === 'light' ? 'light' : 'blood';
    const liquidColor = variant === 'blood' ? COLOR_BLOOD_LIQUID : COLOR_LIGHT_LIQUID;
    const s = h.scale || 1;
    const seed = h.seed | 0;
    const rng = _seededRand(seed);

    // Per-entity assembly group so scale + position apply atomically.
    const entGroup = new THREE.Group();
    entGroup.position.set(h.x, 0, h.z);
    entGroup.scale.setScalar(s);

    // Stone body — sits at y≈0.275 so the top sits flush at y≈0.55.
    const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
    bodyMesh.position.y = 0.275;
    entGroup.add(bodyMesh);

    // Bone rim — torus around the lip.
    const rimMesh = new THREE.Mesh(rimGeo, rimMat);
    rimMesh.position.y = 0.55;
    entGroup.add(rimMesh);

    // Liquid disk — per-entity material so emissive lerping is independent.
    // Bloom ON (slot 5/6/7 are bloom-eligible per spec).
    const liquidMat = new THREE.MeshStandardMaterial({
      color: liquidColor,
      emissive: liquidColor,
      emissiveIntensity: IDLE_EMISSIVE_MIN,
      roughness: 0.20, metalness: 0.10,
      transparent: true, opacity: 0.95,
    });
    const liquidMesh = new THREE.Mesh(liquidGeo, liquidMat);
    const liquidYBase = 0.56;            // just above rim
    liquidMesh.position.y = liquidYBase;
    liquidMesh.layers.enable(BLOOM_LAYER);
    entGroup.add(liquidMesh);

    // Optional per-entity ambient PointLight — 6 lights is trivial, gives
    // the courtyard the slow-heartbeat glow without leaning on bloom alone.
    const light = new THREE.PointLight(liquidColor, 0.6, 4.0, 2.0);
    light.position.y = 0.65;
    entGroup.add(light);

    _group.add(entGroup);

    _fountains.push({
      x: h.x, z: h.z, variant, scale: s, seed,
      state: 'idle',                                 // 'idle' | 'drinking' | 'cooldown'
      cooldownUntil: 0,
      drinkTimer: 0,
      pulsePhase: rng() * Math.PI * 2,               // desync per fountain
      liquidYBase,
      pourNextAt: rng() * POUR_INTERVAL_MIN,         // first pour offset in [0, MIN]
      entGroup, bodyMesh, rimMesh, liquidMesh, liquidMat, light,
      idleColorHex: liquidColor,                     // remembered for drink-flash revert
      rng,
    });
  }

  scene.add(_group);
  return _fountains.length;
}

// ─── public: tick ────────────────────────────────────────────────────────────
export function tickTwilightFountains(dt, state) {
  if (!state || _fountains.length === 0) return;
  const scene = state.scene;
  if (!scene) return;
  const tNow = (state.time && state.time.game) || 0;
  const hero = state.hero;
  const heroPos = hero && hero.pos;
  const heroAlive = !!(hero && hero.hp > 0 && !state.gameOver);

  // ── 1) Per-fountain update ────────────────────────────────────────────────
  for (const f of _fountains) {
    // Pour SFX stagger — fire even in cooldown? No: a "spent" fountain
    // shouldn't pour. Only idle fountains contribute to the water bed.
    if (f.state === 'idle' && f.cooldownUntil <= tNow) {
      f.pourNextAt -= dt;
      if (f.pourNextAt <= 0) {
        try { sfx.fountainPour && sfx.fountainPour(); } catch (_) {}
        f.pourNextAt = POUR_INTERVAL_MIN + f.rng() * (POUR_INTERVAL_MAX - POUR_INTERVAL_MIN);
      }
    }

    if (f.state === 'cooldown') {
      // Hold liquid flat at dim — no pulse, no bob.
      f.liquidMat.emissive.setHex(f.idleColorHex);
      f.liquidMat.emissiveIntensity = COOLDOWN_EMISSIVE;
      f.liquidMesh.position.y = f.liquidYBase;
      f.light.intensity = 0.15;
      if (f.cooldownUntil <= tNow) {
        f.state = 'idle';
      }
      continue;
    }

    if (f.state === 'idle') {
      // Idle pulse — emissive lerps MIN ↔ MAX at IDLE_PULSE_HZ.
      f.pulsePhase += dt * (Math.PI * 2 * IDLE_PULSE_HZ);
      const k = 0.5 + 0.5 * Math.sin(f.pulsePhase);
      f.liquidMat.emissive.setHex(f.idleColorHex);
      f.liquidMat.emissiveIntensity = IDLE_EMISSIVE_MIN + (IDLE_EMISSIVE_MAX - IDLE_EMISSIVE_MIN) * k;
      // Subtle 0.03-amp Y-bob on the liquid disk only — rim is static.
      f.liquidMesh.position.y = f.liquidYBase + Math.sin(f.pulsePhase * 0.6) * LIQUID_BOB_AMP;
      // Light tracks idle emissive — cheap, gives slow-heartbeat ambient pool glow.
      f.light.intensity = 0.40 + 0.35 * k;

      // Proximity check — square distance to avoid sqrt. Only trigger if
      // the player is alive (drinking from a fountain while dead is wrong).
      if (heroAlive && heroPos) {
        const dx = heroPos.x - f.x;
        const dz = heroPos.z - f.z;
        if (dx * dx + dz * dz <= PROXIMITY_R2) {
          f.state = 'drinking';
          f.drinkTimer = 0;
        }
      }
      continue;
    }

    // state === 'drinking'
    f.drinkTimer += dt;
    // Color overrides to slot 7 during the ramp; emissive lerps 1.5 → PEAK.
    const dk = Math.min(1, f.drinkTimer / DRINK_DURATION);
    f.liquidMat.emissive.setHex(COLOR_DRINK_FLASH);
    f.liquidMat.emissiveIntensity = 1.5 + (DRINK_PEAK_EMISSIVE - 1.5) * dk;
    f.light.intensity = 0.8 + 1.2 * dk;

    if (f.drinkTimer >= DRINK_DURATION) {
      // ── Drink resolved: apply buff, schedule cooldown, spawn aura ──
      // Option A: publish state.run.fountainSpeedBuff for hero.js to read.
      if (state.run) {
        const expiresAt = tNow + BUFF_DURATION;
        state.run.fountainSpeedBuff = { mul: BUFF_MUL, expiresAt };
        // Aura ring on PLAYER (not fountain) — spawned only if heroPos exists.
        if (heroPos) {
          _auraRings.push(_spawnAuraRing(scene, heroPos, expiresAt));
        }
        // Punch List #7 — Velocity Veil ribbon trail + splash particles.
        // Spawned AFTER fountainSpeedBuff is published so the FX module can
        // snapshot expiresAt at spawn time. ribbonTrail captures the value
        // on the descriptor and never re-reads the global flag (which gets
        // nulled at expiry by this same module — see lifecycle block below).
        spawnVelocityVeil(scene, state);
      }
      // Schedule fountain cooldown.
      f.cooldownUntil = tNow + COOLDOWN_DURATION;
      f.state = 'cooldown';
      // Revert liquid to idle color now — cooldown branch on next tick will
      // hold the dim flat value.
      f.liquidMat.emissive.setHex(f.idleColorHex);
      f.liquidMat.emissiveIntensity = COOLDOWN_EMISSIVE;
      f.liquidMesh.position.y = f.liquidYBase;
      // Audio: drink + activation chime simultaneously (chime layered on top).
      try { sfx.fountainDrink && sfx.fountainDrink(); } catch (_) {}
      try { sfx.speedBoostActivate && sfx.speedBoostActivate(); } catch (_) {}
    }
  }

  // ── 2) Tick aura rings (follow player, fade opacity, dispose on expiry) ───
  if (_auraRings.length > 0) {
    for (let i = _auraRings.length - 1; i >= 0; i--) {
      const r = _auraRings[i];
      r.t += dt;
      // Reposition each tick from the canonical hero.pos.
      if (heroPos) {
        r.group.position.x = heroPos.x;
        r.group.position.z = heroPos.z;
      }
      const k = Math.min(1, r.t / BUFF_DURATION);
      // Linear opacity fade 1.0 → 0.0 (spec: "visibly ticks down").
      r.mats[0].opacity = r.baseOpacities[0] * (1 - k);
      r.mats[1].opacity = r.baseOpacities[1] * (1 - k);
      if (k >= 1 || (r.expiresAt && tNow >= r.expiresAt)) {
        if (r.group.parent) r.group.parent.remove(r.group);
        else if (scene) scene.remove(r.group);
        for (const g of r.geos) { try { g.dispose(); } catch (_) {} }
        for (const m of r.mats) { try { m.dispose(); } catch (_) {} }
        _auraRings.splice(i, 1);
      }
    }
  }

  // ── 3) Buff lifecycle — clear flag once expired so hero.js stops reading it.
  // Visual aura and mechanical buff lifetime are tied to the same expiresAt,
  // so they fall off in lockstep.
  if (state.run && state.run.fountainSpeedBuff && state.run.fountainSpeedBuff.expiresAt <= tNow) {
    state.run.fountainSpeedBuff = null;
  }
}

// ─── public: clear ───────────────────────────────────────────────────────────
export function clearTwilightFountains(scene) {
  // Tear down in-flight aura rings (they live as scene children).
  for (const r of _auraRings) {
    if (r.group.parent) r.group.parent.remove(r.group);
    else if (scene) scene.remove(r.group);
    for (const g of r.geos) { try { g.dispose(); } catch (_) {} }
    for (const m of r.mats) { try { m.dispose(); } catch (_) {} }
  }
  _auraRings.length = 0;

  // Dispose per-entity liquid materials (shared body/rim mats in _disposables).
  for (const f of _fountains) {
    if (f.liquidMat) { try { f.liquidMat.dispose(); } catch (_) {} }
    // PointLight has no dispose; removing the group is enough.
  }

  // Remove the parent group + dispose tracked shared geos/mats.
  if (_group) {
    if (scene && _group.parent === scene) scene.remove(_group);
    else if (_group.parent) _group.parent.remove(_group);
    _group = null;
  }
  for (const d of _disposables) { try { d.dispose && d.dispose(); } catch (_) {} }
  _disposables.length = 0;

  _fountains.length = 0;
  _hotspotsLoaded = null;

  // Option A buff cleanup: null the flag so a stage transition doesn't leak
  // the buff into the next stage. Safe-guarded — globalThis.state may be
  // absent in tooling contexts.
  try {
    const gs = (typeof globalThis !== 'undefined' && globalThis.state) ? globalThis.state : null;
    if (gs && gs.run) gs.run.fountainSpeedBuff = null;
  } catch (_) { /* tooling context — ignore */ }
}

// ─── debug exports (mirror forestAmber.js) ───────────────────────────────────
export function _debugFountains() { return _fountains.slice(); }
export function _debugHotspots() { return _hotspotsLoaded; }
export function _debugAuraRings() { return _auraRings.slice(); }
