/**
 * Cinder Ballistas — discrete interactable entity.
 *
 * Phase-2 Cinder Ballistas Agent implementation.
 * Contract: docs/CINDER_VISUAL_STYLE.md §"Ballista Turret Spec —
 * Repair + Auto-Fire Interaction Contract".
 *
 * Public API:
 *   loadCinderBallistas(scene, hotspotsUrl?)
 *     — spawn entities from JSON, return count.
 *   tickCinderBallistas(dt, state)
 *     — per-frame: repair-timer + cancel-radius check, auto-fire loop,
 *       bolt projectile motion + pierce damage, FX lifecycles.
 *   clearCinderBallistas(scene)
 *     — dispose all entities + in-flight bolts + FX.
 *
 * Hotspot JSON: [{ x, z, scale, seed, facing }]
 *               (see assets/cinder_ballista_hotspots.json)
 *
 * === PERSISTENCE MODEL (LOCKED): per-entity activation flag ===
 * b.activated = true (per-entity), NOT on state.run. Stage teardown wipes
 * _ballistas → wipes activation. No leakage across runs.
 *
 * === BOLT DAMAGE HOOK (LOCKED): damageEnemy() with source tag ===
 * Bolts call damageEnemy(enemy, BOLT_DAMAGE_BASE, 'ballista_turret'),
 * mirroring forest_amber. Future passives can filter on source.
 *
 * Palette (8-color cinder, locked):
 *   slot 1 #0a0604 — charred black (chassis silhouette, broken/idle)
 *   slot 2 #3a342f — ash gray (stone fittings)
 *   slot 3 #7a3d1a — rust orange dim (corroded metal bands)
 *   slot 5 #d4c4a8 — ash white (chassis highlights)
 *   slot 7 #ffd24a — ballista active glow (chassis pulse + bolt color)
 *   slot 8 #ffb86b — repair progress aura ring
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from './postfx.js';
import { damageEnemy, queryRadius } from './enemies.js';
import { sfx } from './audio.js';

// ─── module state ─────────────────────────────────────────────────────────────
const _ballistas = [];
const _activeBolts = [];
const _disposables = [];
let _hotspotsLoaded = null;
let _group = null;

// ─── tuning constants (LOCKED per docs/CINDER_VISUAL_STYLE.md) ────────────────
export const REPAIR_DURATION = 10.0;
export const PROXIMITY_R = 1.5;
export const PROXIMITY_R2 = PROXIMITY_R * PROXIMITY_R;
export const REPAIR_CANCEL_R = 3.0;
export const REPAIR_CANCEL_R2 = REPAIR_CANCEL_R * REPAIR_CANCEL_R;

export const BOLT_INTERVAL = 2.0;
export const BOLT_SPEED = 80.0;
export const BOLT_LENGTH = 30.0;
export const BOLT_RADIUS = 0.15;
export const BOLT_MAX_RANGE = 30.0;
export const BOLT_DAMAGE_BASE = 45;
export const BOLT_PIERCE = Infinity;

export const CRADLE_YAW_RATE = 2.0;

export const ACTIVATED_EMISSIVE_MIN = 1.4;
export const ACTIVATED_EMISSIVE_MAX = 2.0;
export const ACTIVATED_PULSE_HZ = 0.4;
export const ACTIVATION_FLASH_EMISSIVE = 3.5;

export const REPAIR_AURA_RADIUS = 0.9;
export const REPAIR_AURA_LINE_WIDTH = 0.07;
export const REPAIR_AURA_OPACITY_MIN = 0.4;
export const REPAIR_AURA_OPACITY_MAX = 1.0;

// Repair SFX cadence. Audio sample is 1.5s seamless — call every ~1.4s so
// consecutive plays overlap ~0.1s and mask the loop seam. audio.js also
// _throttled-wraps ballistaRepairLoop so per-entity pacing is belt-and-suspenders.
const REPAIR_SFX_INTERVAL = 1.4;

// Idle bolt-cradle Y-bob — "isn't load-bearing anymore" (spec §1).
const IDLE_CRADLE_BOB_AMP = 0.01;
const IDLE_CRADLE_BOB_HZ = 0.5;

// Bolt tunneling guard. At BOLT_SPEED=80u/s, a 60Hz tick advances ~1.33u —
// querying at the new position with a tight radius would skip enemies the
// bolt passed THROUGH. We query at the midpoint of (prev, new) with radius
// = halfStep + BOLT_RADIUS + enemy cushion. That covers the swept segment
// without needing sub-step iteration. hitSet prevents double-counting.
const BOLT_ENEMY_RADIUS_CUSHION = 0.55;

// ─── palette color constants (cinder, locked) ─────────────────────────────────
export const COLOR_CHARRED_BLACK = 0x0a0604;   // slot 1
export const COLOR_ASH_GRAY      = 0x3a342f;   // slot 2
export const COLOR_RUST_ORANGE   = 0x7a3d1a;   // slot 3
export const COLOR_ASH_WHITE     = 0xd4c4a8;   // slot 5
export const COLOR_BALLISTA_GLOW = 0xffd24a;   // slot 7 — chassis + bolt
export const COLOR_REPAIR_AURA   = 0xffb86b;   // slot 8 — repair ring

// ─── seeded PRNG ──────────────────────────────────────────────────────────────
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

// ─── chassis geometry builder (shared across all ballistas) ──────────────────
// Hex-prism base (ash-gray stone) + wooden platform (charred) + tapered bolt
// cradle beam (charred + rust bands). Built as a Group of meshes so the
// cradle can yaw independently and per-entity chassis-glow mat can be
// independently lerped on activation. Geometries shared, materials per-entity.
function _buildBaseGeometry() {
  // Short hex pedestal — ~1.0u diameter, 0.45u tall. Slot 2 ash gray.
  const geo = new THREE.CylinderGeometry(0.50, 0.55, 0.45, 6, 1, false);
  return geo;
}
function _buildPlatformGeometry() {
  // Wood platform — slightly wider disk sitting atop the base. Slot 1 charred.
  const geo = new THREE.CylinderGeometry(0.65, 0.65, 0.10, 8, 1, false);
  return geo;
}
function _buildRustBandGeometry() {
  // Rust band around the bolt rack — slot 3 dim rust.
  const geo = new THREE.TorusGeometry(0.45, 0.045, 8, 16);
  geo.rotateX(Math.PI / 2);
  return geo;
}
function _buildCradleBeamGeometry() {
  // Tapered beam for the bolt-cradle — points along +X (we yaw the whole
  // cradle group around Y to aim). Slot 1 charred for the broken silhouette,
  // chassis-glow material overlays on activation.
  const geo = new THREE.BoxGeometry(0.90, 0.12, 0.18);
  geo.translate(0.45, 0, 0);
  return geo;
}
function _buildCradleSupportGeometry() {
  // Vertical post the cradle pivots on. Slot 1 charred.
  const geo = new THREE.CylinderGeometry(0.10, 0.10, 0.45, 6, 1, false);
  return geo;
}
function _buildCradleHighlightGeometry() {
  // Thin ash-white highlight strip along the beam — slot 5 (chassis highlight).
  const geo = new THREE.BoxGeometry(0.90, 0.025, 0.04);
  geo.translate(0.45, 0.065, 0);
  return geo;
}
function _buildBoltRackGeometry() {
  // Broken bolt rack atop the platform — short narrow box, charred slot 1.
  const geo = new THREE.BoxGeometry(0.35, 0.20, 0.55);
  geo.translate(0, 0.10, 0);
  return geo;
}

// ─── repair aura ring (slot 8, bloom ON) ─────────────────────────────────────
// Built per-entity since opacity ramps independently. RingGeometry on XZ
// plane, fixed inner radius 0.9u, line width 0.07u. Per spec §3:
// "Ring inner radius fixed at 0.9u; ring opacity ramps 0.4 → 1.0 linearly
//  over the 10s timer as a visual progress bar." (No scale ramp.)
function _spawnRepairAura(parentGroup, x, z) {
  const inner = REPAIR_AURA_RADIUS;
  const outer = inner + REPAIR_AURA_LINE_WIDTH;
  const geo = new THREE.RingGeometry(inner, outer, 48, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: COLOR_REPAIR_AURA,
    transparent: true,
    opacity: REPAIR_AURA_OPACITY_MIN,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, 0.05, z);
  mesh.frustumCulled = false;
  mesh.layers.enable(BLOOM_LAYER);
  parentGroup.add(mesh);
  return { mesh, mat, geo };
}

// ─── bolt projectile (slot 7, bloom ON) ──────────────────────────────────────
// Cylinder oriented along velocity. Wrapped in a Group rotated to atan2(vz, vx)
// at spawn. Bloom ON for emissive feel.
function _spawnBolt(scene, ox, oz, dirX, dirZ) {
  // Cylinder is along Y by default; rotate -π/2 around Z to align with +X,
  // then yaw the group to aim. Center the geometry at half-length forward of
  // the spawn point so the bolt visually exits the cradle muzzle.
  const geo = new THREE.CylinderGeometry(BOLT_RADIUS, BOLT_RADIUS, BOLT_LENGTH, 8, 1, false);
  geo.rotateZ(-Math.PI / 2);          // Y-axis → +X axis
  geo.translate(BOLT_LENGTH * 0.5, 0, 0); // back end at origin → bolt extends forward

  const mat = new THREE.MeshBasicMaterial({
    color: COLOR_BALLISTA_GLOW,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.layers.enable(BLOOM_LAYER);

  const group = new THREE.Group();
  group.position.set(ox, 0.7, oz);
  group.rotation.y = Math.atan2(-dirZ, dirX); // THREE Y-up: yaw = atan2(-z, x)
  group.add(mesh);
  scene.add(group);

  const vx = dirX * BOLT_SPEED;
  const vz = dirZ * BOLT_SPEED;
  return {
    x: ox, z: oz,
    vx, vz,
    spawnX: ox, spawnZ: oz,
    life: BOLT_MAX_RANGE / BOLT_SPEED + 0.1, // belt-and-suspenders
    hitSet: new Set(),
    group, mesh, mat, geo,
  };
}

// ─── public: load ─────────────────────────────────────────────────────────────
export async function loadCinderBallistas(scene, hotspotsUrl = 'assets/cinder_ballista_hotspots.json') {
  if (!scene) return 0;
  // Idempotent: tear down any prior group before rebuilding.
  clearCinderBallistas(scene);

  let hotspots = null;
  try {
    const res = await fetch(hotspotsUrl);
    hotspots = await res.json();
  } catch (e) {
    console.warn('[cinderBallistas] hotspot fetch failed:', e);
    return 0;
  }
  if (!Array.isArray(hotspots) || hotspots.length === 0) return 0;
  _hotspotsLoaded = hotspots;

  _group = new THREE.Group();
  _group.name = '__cinderBallistas';

  // Shared geometries — disposed in clearCinderBallistas.
  const baseGeo     = _buildBaseGeometry();
  const platformGeo = _buildPlatformGeometry();
  const rustGeo     = _buildRustBandGeometry();
  const beamGeo     = _buildCradleBeamGeometry();
  const supportGeo  = _buildCradleSupportGeometry();
  const highlightGeo = _buildCradleHighlightGeometry();
  const rackGeo     = _buildBoltRackGeometry();
  _disposables.push(baseGeo, platformGeo, rustGeo, beamGeo, supportGeo, highlightGeo, rackGeo);

  // Shared mats for non-emissive parts. Bloom OFF (idle chassis is dead siege).
  const baseMat = new THREE.MeshStandardMaterial({
    color: COLOR_ASH_GRAY, roughness: 0.85, metalness: 0.05, flatShading: true,
  });
  const platformMat = new THREE.MeshStandardMaterial({
    color: COLOR_CHARRED_BLACK, roughness: 0.90, metalness: 0.05, flatShading: true,
  });
  const rustMat = new THREE.MeshStandardMaterial({
    color: COLOR_RUST_ORANGE, roughness: 0.75, metalness: 0.25, flatShading: true,
  });
  const supportMat = new THREE.MeshStandardMaterial({
    color: COLOR_CHARRED_BLACK, roughness: 0.90, metalness: 0.10, flatShading: true,
  });
  const highlightMat = new THREE.MeshStandardMaterial({
    color: COLOR_ASH_WHITE, roughness: 0.70, metalness: 0.05, flatShading: true,
  });
  const rackMat = new THREE.MeshStandardMaterial({
    color: COLOR_CHARRED_BLACK, roughness: 0.90, metalness: 0.05, flatShading: true,
  });
  _disposables.push(baseMat, platformMat, rustMat, supportMat, highlightMat, rackMat);

  for (const h of hotspots) {
    const s = h.scale || 1;
    const seed = (h.seed | 0) || 0;
    const facing = (typeof h.facing === 'number') ? h.facing : 0;
    const rng = _seededRand(seed);

    // Per-entity assembly group.
    const entGroup = new THREE.Group();
    entGroup.position.set(h.x, 0, h.z);
    entGroup.scale.setScalar(s);

    // ── Base + platform + rack (static silhouette) ──
    const baseMesh = new THREE.Mesh(baseGeo, baseMat);
    baseMesh.position.y = 0.225;
    entGroup.add(baseMesh);

    const platformMesh = new THREE.Mesh(platformGeo, platformMat);
    platformMesh.position.y = 0.50;
    entGroup.add(platformMesh);

    const rustMesh = new THREE.Mesh(rustGeo, rustMat);
    rustMesh.position.y = 0.55;
    entGroup.add(rustMesh);

    const rackMesh = new THREE.Mesh(rackGeo, rackMat);
    rackMesh.position.y = 0.55;
    entGroup.add(rackMesh);

    // ── Cradle (yaws toward enemies on activation; idle Y-bob amp 0.01) ──
    const cradleGroup = new THREE.Group();
    cradleGroup.position.y = 0.75;
    cradleGroup.rotation.y = facing;

    const supportMesh = new THREE.Mesh(supportGeo, supportMat);
    supportMesh.position.y = -0.225;
    cradleGroup.add(supportMesh);

    // Per-entity beam material so its emissive can lerp independently on
    // activation (chassis-glow band 1.4 ↔ 2.0 on slot 7).
    const beamMat = new THREE.MeshStandardMaterial({
      color: COLOR_CHARRED_BLACK,
      emissive: 0x000000,
      emissiveIntensity: 0,
      roughness: 0.80, metalness: 0.15,
      flatShading: true,
    });
    const beamMesh = new THREE.Mesh(beamGeo, beamMat);
    cradleGroup.add(beamMesh);

    const highlightMesh = new THREE.Mesh(highlightGeo, highlightMat);
    cradleGroup.add(highlightMesh);

    entGroup.add(cradleGroup);

    _group.add(entGroup);

    _ballistas.push({
      x: h.x, z: h.z, scale: s, seed, facing,
      state: 'broken',                    // 'broken' | 'repairing' | 'activated'
      activated: false,                   // per-entity flag, NOT state.run
      repairTimer: 0,
      fireTimer: 0,
      cradleYaw: facing,
      pulsePhase: rng() * Math.PI * 2,
      bobPhase: rng() * Math.PI * 2,
      sfxAcc: 0,                          // repair-loop SFX pacer
      entGroup,
      cradleGroup,
      beamMesh,
      beamMat,                            // per-entity, disposed in clear()
      repairAura: null,                   // populated in 'repairing' state
      rng,
    });
  }

  scene.add(_group);
  return _ballistas.length;
}

// ─── public: tick ────────────────────────────────────────────────────────────
export function tickCinderBallistas(dt, state) {
  if (!state || _ballistas.length === 0) return;
  const scene = state.scene;
  if (!scene) return;
  const hero = state.hero;
  const heroPos = hero && hero.pos;
  const heroAlive = !!(hero && hero.hp > 0 && !state.gameOver);

  // ── 1) Per-entity state machine ───────────────────────────────────────────
  for (const b of _ballistas) {
    // Idle bolt-cradle bob (only meaningful in 'broken' state — once activated
    // the cradle is being actively yaw-scanned and the bob would fight that).
    if (b.state === 'broken' && b.cradleGroup) {
      b.bobPhase += dt * (Math.PI * 2 * IDLE_CRADLE_BOB_HZ);
      b.cradleGroup.position.y = 0.75 + Math.sin(b.bobPhase) * IDLE_CRADLE_BOB_AMP;
    }

    if (b.state === 'broken') {
      if (heroAlive && heroPos) {
        const dx = heroPos.x - b.x;
        const dz = heroPos.z - b.z;
        if (dx * dx + dz * dz <= PROXIMITY_R2) {
          b.state = 'repairing';
          b.repairTimer = 0;
          b.sfxAcc = 0;
          b.repairAura = _spawnRepairAura(b.entGroup, 0, 0);
          // Fire the first repair SFX tick immediately so the loop feels
          // responsive to entry.
          try { sfx.ballistaRepairLoop && sfx.ballistaRepairLoop(); } catch (_) {}
        }
      }
      continue;
    }

    if (b.state === 'repairing') {
      // Cancel check (RESET, not pause — spec §4: timer "resets to 0").
      let cancel = !heroAlive || !heroPos;
      if (!cancel && heroPos) {
        const dx = heroPos.x - b.x;
        const dz = heroPos.z - b.z;
        if (dx * dx + dz * dz > REPAIR_CANCEL_R2) cancel = true;
      }
      if (cancel) {
        if (b.repairAura) {
          if (b.repairAura.mesh.parent) b.repairAura.mesh.parent.remove(b.repairAura.mesh);
          try { b.repairAura.geo.dispose(); } catch (_) {}
          try { b.repairAura.mat.dispose(); } catch (_) {}
          b.repairAura = null;
        }
        b.repairTimer = 0;
        b.sfxAcc = 0;
        b.state = 'broken';
        continue;
      }

      b.repairTimer += dt;
      // Opacity ramps 0.4 → 1.0 linearly over REPAIR_DURATION (spec §3).
      // Radius is FIXED at 0.9u — do not scale.
      if (b.repairAura) {
        const k = Math.min(1, b.repairTimer / REPAIR_DURATION);
        b.repairAura.mat.opacity = REPAIR_AURA_OPACITY_MIN
          + (REPAIR_AURA_OPACITY_MAX - REPAIR_AURA_OPACITY_MIN) * k;
      }

      // Repair SFX every ~1.4s (audio sample is 1.5s seamless; 1.4s pacing
      // gives ~0.1s overlap that masks the loop seam).
      b.sfxAcc += dt;
      if (b.sfxAcc >= REPAIR_SFX_INTERVAL) {
        b.sfxAcc -= REPAIR_SFX_INTERVAL;
        try { sfx.ballistaRepairLoop && sfx.ballistaRepairLoop(); } catch (_) {}
      }

      if (b.repairTimer >= REPAIR_DURATION) {
        // ── Activation frame (single-frame slot-7 peak, spec §5) ──
        b.state = 'activated';
        b.activated = true;
        b.fireTimer = BOLT_INTERVAL;       // initial cooldown — first shot at t+0
        // Snap cradle to its current facing (no jitter on the activation frame).
        b.cradleGroup.position.y = 0.75;
        // Slot-7 chassis glow ON; emissive starts at the activation flash peak,
        // settles back into the pulse band on subsequent ticks.
        b.beamMat.color.setHex(COLOR_BALLISTA_GLOW);
        b.beamMat.emissive.setHex(COLOR_BALLISTA_GLOW);
        b.beamMat.emissiveIntensity = ACTIVATION_FLASH_EMISSIVE;
        b.beamMesh.layers.enable(BLOOM_LAYER);
        // Dispose repair aura.
        if (b.repairAura) {
          if (b.repairAura.mesh.parent) b.repairAura.mesh.parent.remove(b.repairAura.mesh);
          try { b.repairAura.geo.dispose(); } catch (_) {}
          try { b.repairAura.mat.dispose(); } catch (_) {}
          b.repairAura = null;
        }
        try { sfx.ballistaActivate && sfx.ballistaActivate(); } catch (_) {}
      }
      continue;
    }

    // state === 'activated'
    // Chassis glow pulse 1.4 ↔ 2.0 at 0.4 Hz on slot 7.
    b.pulsePhase += dt * (Math.PI * 2 * ACTIVATED_PULSE_HZ);
    const pk = 0.5 + 0.5 * Math.sin(b.pulsePhase);
    b.beamMat.emissiveIntensity = ACTIVATED_EMISSIVE_MIN
      + (ACTIVATED_EMISSIVE_MAX - ACTIVATED_EMISSIVE_MIN) * pk;

    // ── Scan rotation: lerp cradleYaw toward nearest-enemy bearing ──
    let nearestE = null;
    let nearestD2 = Infinity;
    let scanCands = null;
    try { scanCands = queryRadius({ x: b.x, z: b.z }, BOLT_MAX_RANGE); }
    catch (_) { scanCands = null; }
    if (!scanCands) {
      const list = (state.enemies && state.enemies.active) ? state.enemies.active : null;
      if (list) scanCands = list;
    }
    if (scanCands) {
      for (const e of scanCands) {
        if (!e || !e.alive || !e.mesh) continue;
        const dx = e.mesh.position.x - b.x;
        const dz = e.mesh.position.z - b.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < nearestD2) { nearestD2 = d2; nearestE = e; }
      }
    }

    if (nearestE) {
      const tx = nearestE.mesh.position.x - b.x;
      const tz = nearestE.mesh.position.z - b.z;
      // THREE Y-up yaw convention: yaw = atan2(-z, x) (same as bolt spawn).
      const targetYaw = Math.atan2(-tz, tx);
      // Shortest-arc delta to target.
      let delta = targetYaw - b.cradleYaw;
      while (delta >  Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      const maxStep = CRADLE_YAW_RATE * dt;
      if (delta >  maxStep) delta =  maxStep;
      if (delta < -maxStep) delta = -maxStep;
      b.cradleYaw += delta;
      b.cradleGroup.rotation.y = b.cradleYaw;
    }

    // ── Auto-fire ──
    b.fireTimer -= dt;
    if (b.fireTimer <= 0 && nearestE && nearestD2 <= BOLT_MAX_RANGE * BOLT_MAX_RANGE) {
      // Fire along current cradleYaw — keeps slop honest if the cradle hasn't
      // finished tracking, mirrors the visual.
      const dirX = Math.cos(b.cradleYaw);
      const dirZ = -Math.sin(b.cradleYaw); // yaw = atan2(-z, x) inverse
      _activeBolts.push(_spawnBolt(scene, b.x, b.z, dirX, dirZ));
      b.fireTimer = BOLT_INTERVAL;
      try { sfx.ballistaFire && sfx.ballistaFire(); } catch (_) {}
    }
  }

  // ── 2) Bolt physics + pierce damage ───────────────────────────────────────
  // Linear motion; midpoint-query trick to guard against tunneling at 80u/s.
  // hitSet per-bolt prevents double-counting an enemy that lingers under the
  // bolt for multiple frames.
  for (let i = _activeBolts.length - 1; i >= 0; i--) {
    const p = _activeBolts[i];
    const prevX = p.x;
    const prevZ = p.z;
    p.x += p.vx * dt;
    p.z += p.vz * dt;
    p.life -= dt;
    if (p.group) {
      p.group.position.x = p.x;
      p.group.position.z = p.z;
    }

    // Pierce-damage scan at swept-segment midpoint with radius cushion.
    const midX = (prevX + p.x) * 0.5;
    const midZ = (prevZ + p.z) * 0.5;
    const halfStep = Math.hypot(p.x - prevX, p.z - prevZ) * 0.5;
    const scanR = halfStep + BOLT_RADIUS + BOLT_ENEMY_RADIUS_CUSHION;

    let hits = null;
    try { hits = queryRadius({ x: midX, z: midZ }, scanR); }
    catch (_) { hits = null; }
    if (!hits) {
      const list = (state.enemies && state.enemies.active) ? state.enemies.active : null;
      if (list) hits = list;
    }
    if (hits) {
      const scanR2 = scanR * scanR;
      for (const e of hits) {
        if (!e || !e.alive || !e.mesh) continue;
        if (p.hitSet.has(e)) continue;
        const dx = e.mesh.position.x - midX;
        const dz = e.mesh.position.z - midZ;
        if (dx * dx + dz * dz <= scanR2) {
          try { damageEnemy(e, BOLT_DAMAGE_BASE, 'ballista_turret'); } catch (_) {}
          p.hitSet.add(e);
        }
      }
    }

    // Range / life despawn.
    const tx = p.x - p.spawnX;
    const tz = p.z - p.spawnZ;
    if (p.life <= 0 || (tx * tx + tz * tz) > BOLT_MAX_RANGE * BOLT_MAX_RANGE) {
      if (p.group && p.group.parent) p.group.parent.remove(p.group);
      else if (p.group && scene) scene.remove(p.group);
      try { p.geo.dispose(); } catch (_) {}
      try { p.mat.dispose(); } catch (_) {}
      _activeBolts.splice(i, 1);
    }
  }
}

// ─── public: clear ───────────────────────────────────────────────────────────
export function clearCinderBallistas(scene) {
  // Tear down in-flight bolts (they live as scene children).
  for (const p of _activeBolts) {
    if (p.group && p.group.parent) p.group.parent.remove(p.group);
    else if (p.group && scene) scene.remove(p.group);
    try { p.geo.dispose(); } catch (_) {}
    try { p.mat.dispose(); } catch (_) {}
  }
  _activeBolts.length = 0;

  // Tear down per-entity beam materials + any live repair aura.
  for (const b of _ballistas) {
    if (b.repairAura) {
      if (b.repairAura.mesh.parent) b.repairAura.mesh.parent.remove(b.repairAura.mesh);
      try { b.repairAura.geo.dispose(); } catch (_) {}
      try { b.repairAura.mat.dispose(); } catch (_) {}
      b.repairAura = null;
    }
    if (b.beamMat) { try { b.beamMat.dispose(); } catch (_) {} }
  }

  // Remove the parent group + dispose shared geos/mats.
  if (_group) {
    if (scene && _group.parent === scene) scene.remove(_group);
    else if (_group.parent) _group.parent.remove(_group);
    _group = null;
  }
  for (const d of _disposables) { try { d.dispose && d.dispose(); } catch (_) {} }
  _disposables.length = 0;

  _ballistas.length = 0;
  _hotspotsLoaded = null;
}

// ─── debug exports ───────────────────────────────────────────────────────────
export function _debugBallistas() { return _ballistas.slice(); }
export function _debugActiveBolts() { return _activeBolts.slice(); }
export function _debugHotspots() { return _hotspotsLoaded; }
