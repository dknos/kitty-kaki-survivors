/**
 * Forest Explosive Amber — discrete interactable entity.
 *
 * Phase-2 Amber Interactable Agent implementation.
 * Contract: docs/FOREST_VISUAL_STYLE.md §"Explosive Amber — Ring Shockwave Spec".
 *
 * Public API:
 *   loadForestAmber(scene, hotspotsUrl?) — spawn entities from JSON, return count
 *   tickForestAmber(dt, state)           — per-frame: pulse, detect hits, advance FX
 *   clearForestAmber(scene)              — dispose all entities + FX
 *
 * Hotspot JSON: [{ x, z, scale, seed }]  (see assets/forest_amber_hotspots.json)
 *
 * Design notes:
 * - Per-entity Mesh (NOT InstancedMesh) — 18 entities is well inside the
 *   draw-call budget, and per-entity emissive lerping (idle pulse + detonation
 *   flash) is trivial on Mesh vs. requiring a custom shader hook on
 *   InstancedMesh. Both crystal body + tips are merged per-entity.
 * - Each entity scans state.projectiles.active per tick for collisions
 *   (18 entities × N projectiles is cheap; cheaper than wiring damage hooks
 *   into every projectile path).
 * - Chain-detonation defers next-tick: collected transitions are applied
 *   after the main loop so a dense cluster doesn't cascade in one frame.
 * - Vulnerability debuff: A3 landed — enemies.js now exposes
 *   `applyVulnerability(enemy, mul, duration)` (mirrors `_frozenUntil`).
 *   Detonation applies 1.25× incoming-damage for 0.8s to each enemy caught in
 *   the 4u AoE. Any future weapon/effect can use the same hook.
 * - Chain-lightning arcs: rendered by src/chainFx.js (shared with chain
 *   weapon — A4 backlog refactor). We pass palette slot 8 (cyan-white) for
 *   both outer + inner so arcs read as forest-spec rather than the weapon's
 *   cyan/white. main.js calls tickChainArcs once per frame for all consumers.
 *
 * Palette (8-color, locked):
 *   slot 3 #5f8fb5 — shard fragments (bloom OFF, decor only)
 *   slot 6 #f5a300 — idle body emissive (pulse 1.4 ↔ 2.0 @ 0.7Hz)
 *   slot 7 #ffd86b — detonation flash emissive (single-frame peak 3.5)
 *   slot 8 #a8e6ff — shockwave ring + chain arcs (bloom ON)
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from './postfx.js';
import { damageEnemy, queryRadius, applyVulnerability } from './enemies.js';
import { sfx } from './audio.js';
import { spawnChainArc, disposeAllChainArcs } from './chainFx.js';

// ─── module state ─────────────────────────────────────────────────────────────
const _entities = [];        // { x, z, scale, seed, state, hp, pulsePhase, mesh, light, fxTimer, fx, ... }
let _hotspotsLoaded = null;
let _group = null;           // parent Group added to scene (single removal target)
const _disposables = [];     // geos/mats tracked for clearForestAmber

// Chain-lightning arcs are owned by src/chainFx.js — spawned via
// spawnChainArc and ticked/disposed centrally. This module just calls in.

// Vulnerability debuff (A3): backed by enemies.js applyVulnerability(enemy, mul, duration).
// Any future weapon/effect can apply the same debuff via that helper — stacking
// is handled there (max mul wins, longest expiry wins). Existing freeze logic
// stays on its own `_frozenUntil` path; this is additive, not a refactor.
const VULN_DEBUFF_SUPPORTED = true;

// Re-usable scratch objects (avoid per-tick GC pressure).
const _scratchVec = new THREE.Vector3();

// ─── tuning constants ─────────────────────────────────────────────────────────
const AMBER_HP = 1;
const AMBER_HIT_R = 0.6;             // projectile collision radius (world units)
const DET_AOE_RADIUS = 4.0;          // direct AoE radius
const DET_AOE_DAMAGE = 35;           // direct AoE damage
const CHAIN_RADIUS = 5.0;            // chain-lightning target radius
const CHAIN_MAX = 3;                 // up to 3 nearest enemies hit by chain
const CHAIN_DAMAGE = 18;             // per-target chain damage
const VULN_DURATION = 0.8;           // would-be debuff seconds (kept for docs)
const VULN_INCOMING_MUL = 1.25;      // would-be debuff multiplier (kept for docs)

const DET_LIFE = 1.0;                // total detonation FX duration
const RING_DURATION = 0.6;           // shockwave ring expand+fade
const RING_MAX_RADIUS = 4.0;
const RING_LINE_WIDTH = 0.08;        // ring "line weight" world units (spec)
const ARC_LIFE = 0.4;                // chain-arc fade duration (spec 0.0-0.4s) — passed to spawnChainArc
const SHARD_LIFE = 0.8;              // shard particle lifetime
const SHARD_COUNT_MIN = 8;
const SHARD_COUNT_MAX = 12;
const SHARD_GRAVITY = -9.0;          // m/s² downward on shards

const IDLE_PULSE_HZ = 0.7;           // emissive pulse frequency
const IDLE_EMISSIVE_MIN = 1.4;       // spec band 1.4-2.0
const IDLE_EMISSIVE_MAX = 2.0;
const DET_FLASH_EMISSIVE = 3.5;      // single-frame peak (spec)

const COLOR_BODY     = 0x2d3a55;     // slot 2 — body diffuse (matches decor crystals)
const COLOR_FACET    = 0x5f8fb5;     // slot 3 — facet diffuse (also shards)
const COLOR_AMBER    = 0xf5a300;     // slot 6 — idle emissive
const COLOR_FLASH    = 0xffd86b;     // slot 7 — detonation emissive
const COLOR_CHAIN    = 0xa8e6ff;     // slot 8 — ring + chain arcs

// ─── crystal geometry builder ─────────────────────────────────────────────────
// Builds the per-amber faceted crystal geo (hex prism body + twin cones on top).
// Mirrors the decor crystal silhouette so the amber reads as "same family,
// charged" rather than a wholly different shape. Disposed in clearForestAmber.
function _buildAmberGeometry() {
  const body = new THREE.CylinderGeometry(0.26, 0.40, 1.3, 6, 1, false);
  const tipUp = new THREE.ConeGeometry(0.26, 0.65, 6);
  tipUp.translate(0, 0.975, 0);   // sit atop body (body half=0.65 + cone half=0.325)
  const tipMid = new THREE.ConeGeometry(0.20, 0.45, 6);
  tipMid.translate(0, 1.40, 0);
  const merge = new THREE.BufferGeometry();
  const parts = [body, tipUp, tipMid];
  let vc = 0;
  for (const p of parts) vc += p.attributes.position.count;
  const pos = new Float32Array(vc * 3);
  const nrm = new Float32Array(vc * 3);
  let off = 0;
  for (const p of parts) {
    const pp = p.attributes.position.array;
    const pn = p.attributes.normal ? p.attributes.normal.array : null;
    pos.set(pp, off);
    if (pn) nrm.set(pn, off);
    off += pp.length;
  }
  merge.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  merge.setAttribute('normal',   new THREE.BufferAttribute(nrm, 3));
  merge.computeBoundingSphere();
  body.dispose(); tipUp.dispose(); tipMid.dispose();
  return merge;
}

// Cheap deterministic PRNG seeded per amber for pulse phase + shard scatter.
// Mulberry32-style — purely so two amber with same seed read identically across
// reloads (spec hint: "seed lets per-amber visual variation be deterministic").
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

// ─── chain-arc renderer ──────────────────────────────────────────────────────
// Owned by src/chainFx.js (A4 refactor). We call spawnChainArc with the forest
// slot-8 palette; chainFx handles geometry + fade. main.js ticks the shared
// arc list once per frame, so we don't need a local _tickArcs here.

// ─── shockwave ring ───────────────────────────────────────────────────────────
// Expanding cyan-white ring on the ground plane, line weight 0.08, additive,
// bloom on. RingGeometry with inner+outer radii reflowed each frame so the
// "ring" stays at constant line weight as it expands.
function _spawnShockwave(scene, x, z) {
  // Start at radius ~0 so the first frame reads as a tiny pop, then grows.
  const geo = new THREE.RingGeometry(0.001, 0.001 + RING_LINE_WIDTH, 48, 1);
  geo.rotateX(-Math.PI / 2);  // lay flat on XZ plane
  const mat = new THREE.MeshBasicMaterial({
    color: COLOR_CHAIN, transparent: true, opacity: 1.0,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    // Ground-decal Z-order fix (2026-05-17 user report): amber detonation
    // shockwave is a flat ring on the floor; bias it BELOW the hero+enemy
    // meshes so they occlude it.
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, 0.04, z);
  mesh.frustumCulled = false;
  mesh.layers.enable(BLOOM_LAYER);
  mesh.renderOrder = -1;
  scene.add(mesh);
  return { mesh, mat, geo, t: 0 };
}
// Reflow the ring geometry to a new radius. Dispose the old geo and build a
// fresh one — cheap (~48 verts) and avoids ShaderMaterial gymnastics.
function _resizeRing(ring, radius) {
  const inner = Math.max(0.001, radius - RING_LINE_WIDTH * 0.5);
  const outer = inner + RING_LINE_WIDTH;
  ring.geo.dispose();
  ring.geo = new THREE.RingGeometry(inner, outer, 48, 1);
  ring.geo.rotateX(-Math.PI / 2);
  ring.mesh.geometry = ring.geo;
}

// ─── shard particles (slot 3, bloom OFF) ──────────────────────────────────────
// Small octahedron fragments, gravity-fall, fade by 0.8s. One Group per
// detonation; entire group removed when life expires.
function _spawnShards(scene, x, z, rng) {
  const count = SHARD_COUNT_MIN + Math.floor(rng() * (SHARD_COUNT_MAX - SHARD_COUNT_MIN + 1));
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: COLOR_FACET,
    roughness: 0.45, metalness: 0.10,
    flatShading: true,
    transparent: true, opacity: 0.95,
  });
  const geo = new THREE.OctahedronGeometry(0.13, 0);
  const shards = [];
  for (let i = 0; i < count; i++) {
    const a = rng() * Math.PI * 2;
    const speed = 3.0 + rng() * 3.5;
    const upSpeed = 2.5 + rng() * 3.0;
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, 0.6, z);
    m.scale.setScalar(0.65 + rng() * 0.8);
    m.rotation.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI);
    group.add(m);
    shards.push({
      mesh: m,
      vx: Math.cos(a) * speed,
      vy: upSpeed,
      vz: Math.sin(a) * speed,
      // Spin per-axis for tumbling.
      rx: (rng() - 0.5) * 8.0,
      ry: (rng() - 0.5) * 8.0,
      rz: (rng() - 0.5) * 8.0,
    });
  }
  scene.add(group);
  return { group, mat, geo, shards, t: 0 };
}
function _tickShards(shardSet, dt) {
  for (const s of shardSet.shards) {
    s.vy += SHARD_GRAVITY * dt;
    s.mesh.position.x += s.vx * dt;
    s.mesh.position.y += s.vy * dt;
    s.mesh.position.z += s.vz * dt;
    if (s.mesh.position.y < 0.05) {
      s.mesh.position.y = 0.05;
      s.vy = 0;
      s.vx *= 0.6; s.vz *= 0.6;   // friction on bounce
    }
    s.mesh.rotation.x += s.rx * dt;
    s.mesh.rotation.y += s.ry * dt;
    s.mesh.rotation.z += s.rz * dt;
  }
  // Fade material opacity over life; single material so one assignment fades all.
  const k = shardSet.t / SHARD_LIFE;
  shardSet.mat.opacity = Math.max(0, 0.95 * (1 - k * k));
}

// ─── detonation: AoE damage + chain-lightning ─────────────────────────────────
// Returns the list of (x, z) endpoints touched by chain arcs so the caller can
// scan for adjacent-amber chain transitions. Center is the amber's epicenter.
function _resolveDetonation(scene, entity) {
  const cx = entity.x;
  const cz = entity.z;

  // ── Direct AoE — 35 dmg within 4u ──────────────────────────────────────────
  let cands = null;
  try { cands = queryRadius({ x: cx, z: cz }, DET_AOE_RADIUS); }
  catch (_) { cands = null; }
  if (!cands || cands.length === 0) {
    // Fallback: spatial index may not be live (e.g. early-frame). Iterate
    // active list directly — at 18 detonators max per run this is fine.
    const list = (typeof globalThis !== 'undefined' && globalThis.state
      && globalThis.state.enemies) ? globalThis.state.enemies.active : null;
    if (list) cands = list;
  }
  if (cands) {
    const r2 = DET_AOE_RADIUS * DET_AOE_RADIUS;
    for (const e of cands) {
      if (!e || !e.alive || !e.mesh) continue;
      const dx = e.mesh.position.x - cx;
      const dz = e.mesh.position.z - cz;
      if (dx * dx + dz * dz <= r2) {
        try { damageEnemy(e, DET_AOE_DAMAGE, 'forest_amber'); } catch (_) {}
        // A3 vulnerability debuff — applied AFTER the AoE damage tick so the
        // direct hit lands at its baseline and the buff window benefits any
        // subsequent damage source (chain arcs, other weapons) for 0.8s.
        if (VULN_DEBUFF_SUPPORTED) {
          try { applyVulnerability(e, VULN_INCOMING_MUL, VULN_DURATION); } catch (_) {}
        }
      }
    }
  }

  // ── Chain lightning — up to 3 nearest enemies within 5u ────────────────────
  // Reuse queryRadius for the chain candidate pool; pick the 3 nearest by hand.
  const arcEndpoints = [];
  let chainCands = null;
  try { chainCands = queryRadius({ x: cx, z: cz }, CHAIN_RADIUS); }
  catch (_) { chainCands = cands; }
  if (chainCands && chainCands.length > 0) {
    // Pick CHAIN_MAX nearest alive enemies.
    const scored = [];
    for (const e of chainCands) {
      if (!e || !e.alive || !e.mesh) continue;
      const dx = e.mesh.position.x - cx;
      const dz = e.mesh.position.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 <= CHAIN_RADIUS * CHAIN_RADIUS) scored.push({ e, d2 });
    }
    scored.sort((a, b) => a.d2 - b.d2);
    const n = Math.min(CHAIN_MAX, scored.length);
    for (let i = 0; i < n; i++) {
      const e = scored[i].e;
      const ep = e.mesh.position;
      // Visual: jagged arc from epicenter to enemy. Forest slot-8 palette
      // (both outer + inner = cyan-white) — chainFx handles fade + dispose.
      spawnChainArc(scene, { x: cx, z: cz }, { x: ep.x, z: ep.z }, {
        outerColor: COLOR_CHAIN,
        innerColor: COLOR_CHAIN,
        life: ARC_LIFE,
      });
      try { damageEnemy(e, CHAIN_DAMAGE, 'forest_amber'); } catch (_) {}
      arcEndpoints.push({ x: ep.x, z: ep.z });
    }
  }

  // ── Audio (try/catch — fallback if Audio agent files aren't shipped) ──────
  try { sfx.amberDetonation && sfx.amberDetonation(); } catch (_) {}
  try { sfx.crystalShatter  && sfx.crystalShatter();  } catch (_) {}

  return arcEndpoints;
}

// ─── projectile collision scan ───────────────────────────────────────────────
// Cheap O(amber × projectile) scan — at 18 amber × ≤a few dozen projectiles
// it's well inside the frame budget. Bails as soon as an amber detonates so
// we don't double-trigger on overlapping projectiles in the same frame.
function _checkProjectileHits(entity, projectiles) {
  if (!projectiles || projectiles.length === 0) return false;
  const r2 = AMBER_HIT_R * AMBER_HIT_R;
  for (const p of projectiles) {
    if (!p || !p.mesh) continue;
    const dx = p.mesh.position.x - entity.x;
    const dz = p.mesh.position.z - entity.z;
    if (dx * dx + dz * dz <= r2) {
      // Don't consume the projectile — let it pass through. Player-side pierce
      // rules are owned by the projectile tick, and amber-as-HP=1 is conceptually
      // a "trigger surface", not a hit-credit target.
      return true;
    }
  }
  return false;
}

// ─── public: load ─────────────────────────────────────────────────────────────
export async function loadForestAmber(scene, hotspotsUrl = 'assets/forest_amber_hotspots.json') {
  if (!scene) return 0;
  // Idempotent: tear down any prior amber group before rebuilding.
  clearForestAmber(scene);

  // Fetch hotspot JSON. browser-relative path matches src/fxTextures.js convention.
  let hotspots = null;
  try {
    const res = await fetch(hotspotsUrl);
    hotspots = await res.json();
  } catch (e) {
    console.warn('[forestAmber] hotspot fetch failed:', e);
    return 0;
  }
  if (!Array.isArray(hotspots) || hotspots.length === 0) return 0;
  _hotspotsLoaded = hotspots;

  _group = new THREE.Group();
  _group.name = '__forestAmber';

  const sharedGeo = _buildAmberGeometry();
  _disposables.push(sharedGeo);

  for (const h of hotspots) {
    // Each amber gets its own material so emissive intensity + color can be
    // independently lerped (idle pulse / detonation flash). 18 mats is well
    // inside the budget.
    const mat = new THREE.MeshStandardMaterial({
      color: COLOR_BODY,
      emissive: COLOR_AMBER,
      emissiveIntensity: IDLE_EMISSIVE_MIN,
      roughness: 0.30, metalness: 0.15,
      flatShading: true,
      transparent: true, opacity: 0.94,
    });
    const mesh = new THREE.Mesh(sharedGeo, mat);
    const s = h.scale || 1;
    mesh.position.set(h.x, 0.65 * s, h.z);   // base sits on floor
    mesh.scale.setScalar(s);
    // Small per-instance tilt + yaw via seeded rng so reloads are deterministic.
    const rng = _seededRand(h.seed | 0);
    mesh.rotation.set(
      (rng() - 0.5) * 0.30,
      rng() * Math.PI * 2,
      (rng() - 0.5) * 0.30,
    );
    mesh.layers.enable(BLOOM_LAYER);
    _group.add(mesh);
    _disposables.push(mat);

    _entities.push({
      x: h.x, z: h.z, scale: s, seed: h.seed | 0,
      state: 'idle',                     // 'idle' | 'detonating' | 'dead'
      hp: AMBER_HP,
      pulsePhase: rng() * Math.PI * 2,   // desync pulses across the field
      yBase: mesh.position.y,
      mesh, mat, rng,
      fxTimer: 0,
      ring: null,        // shockwave object, populated on detonation
      shards: null,      // shard set, populated on detonation
      // Chain-detonation arrival flag: set by another amber's resolve pass,
      // consumed on the next tick so we don't cascade within one frame.
      pendingDetonate: false,
    });
  }

  scene.add(_group);
  return _entities.length;
}

// ─── public: tick ────────────────────────────────────────────────────────────
// state arg is the global game state (passes through state.scene + state.projectiles).
export function tickForestAmber(dt, state) {
  if (!state || _entities.length === 0) return;
  const scene = state.scene;
  if (!scene) return;
  const projectiles = state.projectiles && state.projectiles.active;
  const tNow = (state.time && state.time.game) || 0;

  // ── 1) Apply pending chain-detonations FIRST (deferred from prior tick). ──
  // This is how we honor the spec's "single chain hop max per frame" rule:
  // a transition triggered last tick fires its FX this tick.
  for (const e of _entities) {
    if (e.state === 'idle' && e.pendingDetonate) {
      e.pendingDetonate = false;
      e.state = 'detonating';
      e.fxTimer = 0;
    }
  }

  // ── 2) Chain arcs are ticked centrally in main.js via tickChainArcs(dt) ───
  //       (A4 refactor — chainFx.js owns the shared arc list).

  // ── 3) Per-entity update + collect new detonation triggers ─────────────────
  // Collect epicenters of all amber that detonated THIS tick so we can do the
  // chain-detonation adjacency pass after the loop (avoids in-loop cascade).
  const newlyDetonated = [];

  for (const e of _entities) {
    if (e.state === 'dead') continue;

    if (e.state === 'idle') {
      // Idle pulse — emissive lerps between MIN and MAX at 0.7 Hz. Subtle
      // 0.04-amp Y-bob per spec.
      e.pulsePhase += dt * (Math.PI * 2 * IDLE_PULSE_HZ);
      const k = 0.5 + 0.5 * Math.sin(e.pulsePhase);
      e.mat.emissiveIntensity = IDLE_EMISSIVE_MIN + (IDLE_EMISSIVE_MAX - IDLE_EMISSIVE_MIN) * k;
      e.mesh.position.y = e.yBase + Math.sin(e.pulsePhase * 0.6) * 0.04;

      // Damage detection: scan player projectiles for proximity hits.
      if (_checkProjectileHits(e, projectiles)) {
        e.state = 'detonating';
        e.fxTimer = 0;
        // Continue into the detonating branch on NEXT tick (FX cleanly start
        // from t=0 there). Skip rest of this iteration for predictability.
        continue;
      }
      continue;
    }

    // state === 'detonating'
    const wasZero = e.fxTimer === 0;
    e.fxTimer += dt;

    if (wasZero) {
      // ── Frame 0: peak flash + resolve damage + spawn FX ──
      e.mat.emissive.setHex(COLOR_FLASH);
      e.mat.emissiveIntensity = DET_FLASH_EMISSIVE;
      e.ring = _spawnShockwave(scene, e.x, e.z);
      e.shards = _spawnShards(scene, e.x, e.z, e.rng);
      const arcEndpoints = _resolveDetonation(scene, e);
      newlyDetonated.push({ ex: e.x, ez: e.z, arcEndpoints });
      void tNow; // tNow reserved for future vuln-debuff timestamp
    } else {
      // Hold flash one frame, then fade emissive linearly to 0 over the rest
      // of DET_LIFE. Body color stays slot 2; emissive carries the explosion.
      const fade = Math.max(0, 1 - e.fxTimer / DET_LIFE);
      e.mat.emissiveIntensity = DET_FLASH_EMISSIVE * fade * fade;
    }

    // Shockwave ring — expand 0→4u, fade opacity cubic ease-out, over 0.6s.
    if (e.ring) {
      const rk = Math.min(1, e.fxTimer / RING_DURATION);
      const radius = RING_MAX_RADIUS * rk;
      _resizeRing(e.ring, radius);
      // Cubic ease-out fade: 1 - (1-k)^3 inverted to keep opacity high early.
      e.ring.mat.opacity = Math.max(0, Math.pow(1 - rk, 3));
      if (rk >= 1) {
        if (e.ring.mesh.parent) e.ring.mesh.parent.remove(e.ring.mesh);
        else if (scene) scene.remove(e.ring.mesh);
        e.ring.geo.dispose();
        e.ring.mat.dispose();
        e.ring = null;
      }
    }

    // Shard particles — physics + fade.
    if (e.shards) {
      e.shards.t += dt;
      _tickShards(e.shards, dt);
      if (e.shards.t >= SHARD_LIFE) {
        if (e.shards.group.parent) e.shards.group.parent.remove(e.shards.group);
        else if (scene) scene.remove(e.shards.group);
        e.shards.geo.dispose();
        e.shards.mat.dispose();
        e.shards = null;
      }
    }

    // ── End of detonation lifecycle ──
    if (e.fxTimer >= DET_LIFE) {
      // Hide the crystal mesh — entity is consumed for the rest of the run.
      // Keep the Mesh in the group (so dispose runs in clearForestAmber) but
      // mark invisible. No respawn (spec: "no respawn within run").
      e.mesh.visible = false;
      e.state = 'dead';
    }
  }

  // ── 4) Chain-detonation propagation (deferred to next tick) ───────────────
  // For each amber that detonated this tick, if any chain arc terminus passes
  // within CHAIN_RADIUS (5u) of an idle amber, queue that amber to detonate
  // next tick. Single hop max — we don't re-scan against newlyDetonated.
  if (newlyDetonated.length > 0) {
    for (const det of newlyDetonated) {
      // Build the candidate set of "touched points" — the epicenter itself
      // PLUS each chain-arc endpoint. The epicenter check catches direct
      // adjacency; the endpoint check catches arc-pass-through cases.
      const touches = [{ x: det.ex, z: det.ez }];
      for (const ep of det.arcEndpoints) touches.push(ep);
      for (const other of _entities) {
        if (other.state !== 'idle' || other.pendingDetonate) continue;
        // Skip self (epicenter origin) — guarded by state !== 'idle'.
        for (const t of touches) {
          const dx = t.x - other.x;
          const dz = t.z - other.z;
          if (dx * dx + dz * dz <= CHAIN_RADIUS * CHAIN_RADIUS) {
            other.pendingDetonate = true;
            break;
          }
        }
      }
    }
  }
}

// ─── public: clear ───────────────────────────────────────────────────────────
export function clearForestAmber(scene) {
  // Tear down in-flight chain arcs first — owned by src/chainFx.js. This
  // drops EVERY live arc (including any spawned by chain.js), which is the
  // right call on stage teardown since the scene is being swapped out.
  disposeAllChainArcs(scene);

  // Tear down per-entity ring + shard sets.
  for (const e of _entities) {
    if (e.ring) {
      if (e.ring.mesh.parent) e.ring.mesh.parent.remove(e.ring.mesh);
      else if (scene) scene.remove(e.ring.mesh);
      try { e.ring.geo.dispose(); } catch (_) {}
      try { e.ring.mat.dispose(); } catch (_) {}
      e.ring = null;
    }
    if (e.shards) {
      if (e.shards.group.parent) e.shards.group.parent.remove(e.shards.group);
      else if (scene) scene.remove(e.shards.group);
      try { e.shards.geo.dispose(); } catch (_) {}
      try { e.shards.mat.dispose(); } catch (_) {}
      e.shards = null;
    }
  }

  // Remove the amber group + dispose tracked geos/mats.
  if (_group) {
    if (scene && _group.parent === scene) scene.remove(_group);
    else if (_group.parent) _group.parent.remove(_group);
    _group = null;
  }
  for (const d of _disposables) { try { d.dispose && d.dispose(); } catch (_) {} }
  _disposables.length = 0;

  _entities.length = 0;
  _hotspotsLoaded = null;
  void _scratchVec; // silence "declared but unused" if future ticks drop it
}

// ─── debug exports ───────────────────────────────────────────────────────────
export function _debugEntities() { return _entities.slice(); }
export function _debugHotspots() { return _hotspotsLoaded; }

// ─── smoke-test hook (guarded) ───────────────────────────────────────────────
// Forces the nearest idle amber to the given (x,z) to detonate next tick.
// Only exposed on window when window.__kkSmokeEnabled === true — set by the
// headless smoke harness before triggering. NEVER runs in production builds.
export function _debugDetonateNearest(x = 0, z = 0) {
  let best = null;
  let bestD2 = Infinity;
  for (const e of _entities) {
    if (e.state !== 'idle') continue;
    const dx = e.x - x;
    const dz = e.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = e; }
  }
  if (!best) return null;
  best.pendingDetonate = true;
  return { x: best.x, z: best.z, dist: Math.sqrt(bestD2) };
}
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'kkDetonateNearestAmber', {
    configurable: true,
    get() {
      return window.__kkSmokeEnabled ? _debugDetonateNearest : undefined;
    },
  });
}
