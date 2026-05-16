/**
 * Forest Hub Portals + Pollen Breadcrumbs — Cohort 3 Agent 5 (FE-C3B).
 *
 * Contract: docs/FOREST_EXPANSION_PLAN.md §4 (Cohort 3 Agent 5) + §8.
 * Pattern reference: src/voidTeleportPads.js (entity state machine, cooldown,
 *                     iframe-on-arrival, BLOOM_LAYER rim arcs).
 * Visual style: docs/FOREST_VISUAL_STYLE.md (8-color palette, locked).
 *
 * Public API:
 *   loadForestPortals(scene)     — spawn 6 portal entities + 3 breadcrumb
 *                                  trails, return total portal count.
 *   tickForestPortals(dt, state) — per-frame: idle pulse, breadcrumb bob,
 *                                  proximity check, E-key activation,
 *                                  teleport resolution, cooldown timer,
 *                                  flash FX lifecycle.
 *   disposeForestPortals(scene)  — tear down everything (also exported as
 *                                  clearForestPortals for naming parity with
 *                                  loadForestAmber/clearForestAmber).
 *
 * === ACTIVATION MODEL (differs from voidTeleportPads!) ===
 * Void pads auto-trigger on continuous proximity. Forest portals require BOTH:
 *   (1) hero within PROXIMITY_R (1.5u) of the portal
 *   (2) `state.input?.interactPressed` true on this tick (edge-triggered E /
 *       A-button — Cohort 3A wires this in src/hero.js)
 * Defensive optional-chain on input so a missing field can't crash this
 * module while FE-C3A is in flight.
 *
 * === PORTAL TOPOLOGY (LOCKED) ===
 * 3 outbound portals in the Glade (from FOREST_PORTAL_POSITIONS) +
 * 3 return portals at each puzzle room's center. Total = 6. NO meta-gate;
 * all portals are usable from run 1.
 *
 *   toSaphollow      (-35, -45)  →  saphollow.center      (-70, -90)
 *   toCrystalchoir   (  0,  55)  →  crystalchoir.center   (  0,  80)
 *   toAmberlabyrinth ( 55,  10)  →  amberlabyrinth.center ( 130,  0)
 *   returnSaphollow      → glade.center (0,0)
 *   returnCrystalchoir   → glade.center (0,0)
 *   returnAmberlabyrinth → glade.center (0,0)
 *
 * Arrival is at the puzzle room's center (NOT at the symmetric portal
 * position) so the player lands well inside the room. Return portals all
 * arrive at glade center (0,0) which is sufficiently far from all 3
 * outbound portals that the cooldown gate has trivial work to do.
 *
 * === POLLEN BREADCRUMBS ===
 * 3 trails (one per outbound portal), each pre-pooled as a single
 * InstancedMesh of BREADCRUMBS_PER_TRAIL small additive-blend mint orbs.
 * Trail goes from world-origin tree center (0,0) to the outbound portal
 * position. Per-instance bob via sin(time + phase). Seed 0xC0FFEE per spec.
 * Return portals do NOT get breadcrumbs (they live inside puzzle rooms, not
 * along the glade's tree-to-edge paths).
 *
 * === MUTATION HOOK ===
 * Mirrors voidTeleportPads: direct mutation of state.hero.pos.{x,z} +
 * state.hero.mesh.position.{x,z} on the same tick as the destination snap,
 * so the mesh never lags a frame behind the logical position. Y untouched
 * (hero stays on the floor plane).
 *
 * === PALETTE (forest, locked — see docs/FOREST_VISUAL_STYLE.md) ===
 *   slot 1 #1a1e22 — stone-trunk base (rim ring detail)
 *   slot 2 #2d3a55 — crystal-trunk mid (disc undertone)
 *   slot 3 #5f8fb5 — crystal facet hi (cooldown ring)
 *   slot 4 #7df0c4 — bio-glow primary mint (breadcrumbs, return-portal accent)
 *   slot 5 #3ecf9a — bio-glow secondary (edge fade)
 *   slot 6 #f5a300 — amber idle (outbound-portal disc baseline)
 *   slot 7 #ffd86b — amber detonation glow (teleport flash, peak emissive)
 *   slot 8 #a8e6ff — chain-lightning cyan (unused here; reserved by style guide)
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from './postfx.js';
import { FOREST_PORTAL_POSITIONS, FOREST_ROOMS } from './forestRooms.js';

// ─── tuning constants (LOCKED) ───────────────────────────────────────────────
export const PROXIMITY_R          = 1.5;
export const PROXIMITY_R2         = PROXIMITY_R * PROXIMITY_R;
export const COOLDOWN_DURATION    = 6.0;   // matches voidTeleportPads
export const IFRAMES_ON_ARRIVAL   = 0.4;   // matches voidTeleportPads
export const LOCAL_STEP_GUARD     = 0.3;   // re-entry guard at destination

export const IDLE_PULSE_HZ        = 0.7;   // matches forest_amber idle
export const IDLE_EMISSIVE_MIN    = 1.4;
export const IDLE_EMISSIVE_MAX    = 2.0;
export const TELEPORT_FLASH_EMISSIVE = 3.5;

// Activation ring FX (slot 7, bloom ON, additive). Same expand/fade pattern
// as voidTeleportPads flash ring, palette-shifted to amber.
export const FLASH_RING_LIFE       = 0.18;
export const FLASH_RING_INNER_R    = 0.65;
export const FLASH_RING_LINE_WIDTH = 0.08;   // forest spec: 0.06-0.10
export const FLASH_RING_OPACITY    = 1.0;

// Cooldown ring overlay (slot 3 crystal-facet, bloom OFF).
export const COOLDOWN_RING_INNER_R    = 0.95;
export const COOLDOWN_RING_LINE_WIDTH = 0.06;   // forest spec: 0.06-0.10
export const COOLDOWN_RING_OPACITY_MAX = 0.80;

// Rim ring on portal edge (slot 4 mint for return, slot 6 amber for outbound),
// bloom ON, additive — meets "Spider Web FX quality bar" line weight.
export const RIM_RING_LINE_WIDTH   = 0.07;   // forest spec: 0.06-0.10

// Disc Y-bob (cosmetic).
const DISC_BOB_AMP  = 0.025;
const DISC_BOB_HZ   = 0.5;
const DISC_BASE_Y   = 0.08;

// Floating crystal/glyph above each portal (small octahedron).
const CRYSTAL_BASE_Y    = 0.85;
const CRYSTAL_BOB_AMP   = 0.10;
const CRYSTAL_SPIN_HZ   = 0.35;

// ─── breadcrumb tuning ───────────────────────────────────────────────────────
export const BREADCRUMBS_PER_TRAIL = 12;          // 8-12 per spec — use the top end
export const BREADCRUMB_SEED       = 0xC0FFEE;     // per spec
export const BREADCRUMB_ORB_R      = 0.10;         // small mint motes
export const BREADCRUMB_BOB_AMP    = 0.12;
export const BREADCRUMB_BOB_HZ     = 0.6;
export const BREADCRUMB_Y_BASE     = 0.55;

// ─── palette color constants (forest, locked) ────────────────────────────────
export const COLOR_STONE_TRUNK     = 0x1a1e22;  // slot 1
export const COLOR_CRYSTAL_MID     = 0x2d3a55;  // slot 2
export const COLOR_CRYSTAL_FACET   = 0x5f8fb5;  // slot 3 (cooldown ring)
export const COLOR_BIOGLOW_PRIMARY = 0x7df0c4;  // slot 4 (breadcrumbs / return rim)
export const COLOR_BIOGLOW_SECOND  = 0x3ecf9a;  // slot 5 (edge fade)
export const COLOR_AMBER_IDLE      = 0xf5a300;  // slot 6 (outbound disc idle)
export const COLOR_AMBER_FLASH     = 0xffd86b;  // slot 7 (teleport flash)
export const COLOR_CHAIN_CYAN      = 0xa8e6ff;  // slot 8 (reserved)

// ─── module state ────────────────────────────────────────────────────────────
const _portals = [];          // entity records (see _spawnPortal)
const _trails  = [];          // { mesh, mat, geo, instanceData[] }
const _flashRings = [];       // in-flight activation FX
const _disposables = [];      // shared geos/mats tracked for dispose
let _group = null;            // parent THREE.Group, single removal target

// ─── seeded PRNG (mirrors voidTeleportPads / forestAmber) ────────────────────
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

// ─── geometry builders (shared across all portals) ──────────────────────────
function _buildDiscGeometry() {
  // Thin cylinder lying flat — matches voidTeleportPads disc dimensions.
  return new THREE.CylinderGeometry(0.85, 0.85, 0.06, 32, 1, false);
}
function _buildRimGeometry() {
  // Slim torus at the disc rim. Line weight 0.07u — within 0.06-0.10 spec.
  const geo = new THREE.TorusGeometry(0.85, RIM_RING_LINE_WIDTH / 2, 8, 48);
  geo.rotateX(Math.PI / 2);
  return geo;
}
function _buildCrystalGeometry() {
  // Floating glyph above portal — small octahedron, flat-shaded.
  return new THREE.OctahedronGeometry(0.18, 0);
}
function _buildBreadcrumbGeometry() {
  // Pollen orb — small icosahedron, additive blended. Cheap geometry.
  return new THREE.IcosahedronGeometry(BREADCRUMB_ORB_R, 0);
}

// Cooldown overlay ring — RingGeometry on XZ plane, slot 3 crystal-facet,
// bloom OFF, additive. Per-portal so opacity ramps independently.
function _spawnCooldownRing(parentGroup) {
  const inner = COOLDOWN_RING_INNER_R;
  const outer = inner + COOLDOWN_RING_LINE_WIDTH;
  const geo = new THREE.RingGeometry(inner, outer, 48, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: COLOR_CRYSTAL_FACET,
    transparent: true,
    opacity: 0.0,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    // NOTE: do NOT enable BLOOM_LAYER. Cooldown is a state, not a celebration.
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = 0.09;
  mesh.frustumCulled = false;
  parentGroup.add(mesh);
  return { mesh, mat, geo };
}

// ─── teleport flash ring (slot 7 amber, bloom ON) ───────────────────────────
function _spawnFlashRing(scene, x, z) {
  const inner = FLASH_RING_INNER_R;
  const outer = inner + FLASH_RING_LINE_WIDTH;
  const geo = new THREE.RingGeometry(inner, outer, 48, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: COLOR_AMBER_FLASH,
    transparent: true,
    opacity: FLASH_RING_OPACITY,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, 0.10, z);
  mesh.frustumCulled = false;
  mesh.layers.enable(BLOOM_LAYER);
  scene.add(mesh);
  return {
    group: mesh,
    mats: [mat],
    geos: [geo],
    baseOpacity: FLASH_RING_OPACITY,
    t: 0,
    life: FLASH_RING_LIFE,
  };
}

// ─── per-portal spawn ───────────────────────────────────────────────────────
function _spawnPortal(parentGroup, sharedGeos, sharedMats, def) {
  // def: { id, x, z, dest:{x,z}, kind:'outbound'|'return', seed }
  const rng = _seededRand(def.seed);
  const entGroup = new THREE.Group();
  entGroup.position.set(def.x, 0, def.z);

  // Tint — outbound portals are amber (warm welcome from glade), return
  // portals are mint (cool come-home glow). Both flash slot-7 on activation.
  const baseColor = (def.kind === 'outbound') ? COLOR_AMBER_IDLE : COLOR_BIOGLOW_PRIMARY;
  const rimColor  = (def.kind === 'outbound') ? COLOR_AMBER_IDLE : COLOR_BIOGLOW_PRIMARY;
  const peakColor = COLOR_AMBER_FLASH;

  // Per-entity disc material — emissive lerps for idle pulse, spikes to
  // slot-7 flash on activation.
  const discMat = new THREE.MeshStandardMaterial({
    color: COLOR_CRYSTAL_MID,           // slot 2 undertone keeps disc readable
    emissive: baseColor,
    emissiveIntensity: IDLE_EMISSIVE_MIN,
    transparent: true,
    opacity: 0.95,
    roughness: 0.30,
    metalness: 0.20,
    flatShading: true,
  });
  const discMesh = new THREE.Mesh(sharedGeos.disc, discMat);
  discMesh.position.y = DISC_BASE_Y;
  discMesh.frustumCulled = false;
  discMesh.layers.enable(BLOOM_LAYER);
  entGroup.add(discMesh);

  // Rim ring — slim torus, additive emissive on BLOOM_LAYER. This is the
  // "Spider Web FX bar" arc visual. Line weight 0.07u (within 0.06-0.10).
  const rimMat = new THREE.MeshBasicMaterial({
    color: rimColor,
    transparent: true,
    opacity: 0.90,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const rimMesh = new THREE.Mesh(sharedGeos.rim, rimMat);
  rimMesh.position.y = DISC_BASE_Y;
  rimMesh.frustumCulled = false;
  rimMesh.layers.enable(BLOOM_LAYER);
  entGroup.add(rimMesh);

  // Floating glyph crystal above portal (octahedron, slot 3 facet color,
  // slight bloom). Per-instance spin/bob in tick.
  const crystalMat = new THREE.MeshStandardMaterial({
    color: COLOR_CRYSTAL_FACET,
    emissive: baseColor,
    emissiveIntensity: 1.2,
    roughness: 0.35,
    metalness: 0.30,
    flatShading: true,
  });
  const crystalMesh = new THREE.Mesh(sharedGeos.crystal, crystalMat);
  crystalMesh.position.y = CRYSTAL_BASE_Y;
  crystalMesh.frustumCulled = false;
  crystalMesh.layers.enable(BLOOM_LAYER);
  entGroup.add(crystalMesh);

  // Cooldown overlay.
  const cooldownRing = _spawnCooldownRing(entGroup);

  parentGroup.add(entGroup);

  return {
    id: def.id,
    x: def.x,
    z: def.z,
    dest: { x: def.dest.x, z: def.dest.z },
    kind: def.kind,
    seed: def.seed,
    baseColorHex: baseColor,
    peakColorHex: peakColor,
    cooldownUntil: 0,
    localStepGuard: 0,
    pulsePhase: rng() * Math.PI * 2,
    bobPhase:   rng() * Math.PI * 2,
    crystalPhase: rng() * Math.PI * 2,
    cooldownActive: false,
    entGroup,
    discMesh,
    discMat,
    rimMat,
    crystalMesh,
    crystalMat,
    cooldownRing,
    rng,
  };
}

// ─── breadcrumb trail (InstancedMesh, pre-pooled, additive, bloom) ──────────
function _spawnBreadcrumbTrail(parentGroup, sharedGeo, fromX, fromZ, toX, toZ, seed) {
  const rng = _seededRand(seed);

  const mat = new THREE.MeshBasicMaterial({
    color: COLOR_BIOGLOW_PRIMARY,      // slot 4 mint
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.InstancedMesh(sharedGeo, mat, BREADCRUMBS_PER_TRAIL);
  mesh.frustumCulled = false;
  mesh.layers.enable(BLOOM_LAYER);
  // Instance color array would let per-orb tint vary; we keep one color so
  // palette stays locked. Per-instance scale + bob phase carry the variation.

  const instanceData = new Array(BREADCRUMBS_PER_TRAIL);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const scaleVec = new THREE.Vector3();

  const dx = toX - fromX;
  const dz = toZ - fromZ;

  for (let i = 0; i < BREADCRUMBS_PER_TRAIL; i++) {
    // Evenly distribute along the line with a small lateral jitter so the
    // trail looks scattered rather than dotted-line. Skip the absolute
    // endpoints (i+1)/(N+1).
    const tParam = (i + 1) / (BREADCRUMBS_PER_TRAIL + 1);
    // Lateral jitter perpendicular to the line, ±0.5u.
    const lat = (rng() - 0.5) * 1.0;
    // Tangent direction (normalized) + perpendicular.
    const len = Math.max(1e-3, Math.hypot(dx, dz));
    const tx = dx / len, tz = dz / len;
    const px = -tz, pz = tx;             // perpendicular (XZ-plane)
    const baseX = fromX + dx * tParam + px * lat;
    const baseZ = fromZ + dz * tParam + pz * lat;
    const bobPhase = rng() * Math.PI * 2;
    const scl = 0.7 + rng() * 0.6;       // 0.7-1.3 visual variation

    instanceData[i] = {
      baseX,
      baseZ,
      bobPhase,
      scl,
    };

    scaleVec.set(scl, scl, scl);
    m.compose(
      new THREE.Vector3(baseX, BREADCRUMB_Y_BASE, baseZ),
      q,
      scaleVec
    );
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  parentGroup.add(mesh);

  return { mesh, mat, geo: sharedGeo, instanceData };
}

// ─── public: load ───────────────────────────────────────────────────────────
export function loadForestPortals(scene) {
  if (!scene) return 0;
  // Idempotent: tear down any prior group before rebuilding.
  disposeForestPortals(scene);

  _group = new THREE.Group();
  _group.name = '__forestPortals';

  // Shared geometries — disposed in disposeForestPortals.
  const discGeo      = _buildDiscGeometry();
  const rimGeo       = _buildRimGeometry();
  const crystalGeo   = _buildCrystalGeometry();
  const breadcrumbGeo = _buildBreadcrumbGeometry();
  _disposables.push(discGeo, rimGeo, crystalGeo, breadcrumbGeo);

  const sharedGeos = {
    disc: discGeo,
    rim: rimGeo,
    crystal: crystalGeo,
    breadcrumb: breadcrumbGeo,
  };
  const sharedMats = {};

  // ── Outbound portals (3) — read from FOREST_PORTAL_POSITIONS, dest is
  //    the destination room's center (NOT the symmetric portal position).
  let seedCounter = 7000;
  const outboundDefs = [];
  for (const key in FOREST_PORTAL_POSITIONS) {
    const p = FOREST_PORTAL_POSITIONS[key];
    const destRoom = FOREST_ROOMS[p.to];
    if (!destRoom) {
      console.warn('[forestPortals] missing destination room for', key, p);
      continue;
    }
    outboundDefs.push({
      id: key,
      x: p.x,
      z: p.z,
      dest: { x: destRoom.center.x, z: destRoom.center.z },
      kind: 'outbound',
      seed: seedCounter++,
    });
  }
  for (const def of outboundDefs) {
    _portals.push(_spawnPortal(_group, sharedGeos, sharedMats, def));
  }

  // ── Return portals (3) — at each puzzle room's center, dest = glade center.
  //    Naming: 'returnSaphollow' etc. Iteration order matches FOREST_ROOMS,
  //    but skip the hub (glade).
  const gladeCenter = FOREST_ROOMS.glade.center;
  for (const roomId in FOREST_ROOMS) {
    const room = FOREST_ROOMS[roomId];
    if (room.isHub) continue;
    _portals.push(_spawnPortal(_group, sharedGeos, sharedMats, {
      id: 'return_' + roomId,
      x: room.center.x,
      z: room.center.z,
      dest: { x: gladeCenter.x, z: gladeCenter.z },
      kind: 'return',
      seed: seedCounter++,
    }));
  }

  // ── Pollen breadcrumbs (3 trails — outbound only). Seed 0xC0FFEE per spec;
  //    nudged per-trail so the 3 trails don't all jitter identically.
  for (let i = 0; i < outboundDefs.length; i++) {
    const def = outboundDefs[i];
    const trail = _spawnBreadcrumbTrail(
      _group,
      breadcrumbGeo,
      0, 0,                       // central tree at world origin (per spec)
      def.x, def.z,
      (BREADCRUMB_SEED + i * 17) >>> 0
    );
    _trails.push(trail);
  }

  scene.add(_group);
  return _portals.length;
}

// ─── helper: lookup portal by id (defensive — for E-key intent testing) ─────
function _findReadyPortalNearHero(heroPos, tNow) {
  let best = null;
  let bestD2 = PROXIMITY_R2;
  for (const portal of _portals) {
    if (portal.cooldownUntil > tNow) continue;
    if (portal.localStepGuard > tNow) continue;
    const dx = heroPos.x - portal.x;
    const dz = heroPos.z - portal.z;
    const d2 = dx * dx + dz * dz;
    if (d2 <= bestD2) {
      best = portal;
      bestD2 = d2;
    }
  }
  return best;
}

// ─── public: tick ───────────────────────────────────────────────────────────
export function tickForestPortals(dt, state) {
  if (!state || _portals.length === 0) return;
  const scene = state.scene;
  if (!scene) return;
  const tNow = (state.time && state.time.game) || 0;
  const hero = state.hero;
  const heroPos = hero && hero.pos;
  const heroAlive = !!(hero && hero.hp > 0 && !state.gameOver);

  // ── PASS 1: idle pulse + cooldown timer + crystal bob/spin + breadcrumb bob
  for (const portal of _portals) {
    // Idle disc emissive pulse — slot 6 (or slot 4 for return) → slot 7 peak.
    portal.pulsePhase += dt * (Math.PI * 2 * IDLE_PULSE_HZ);
    const k = 0.5 + 0.5 * Math.sin(portal.pulsePhase);
    if (portal.discMat) {
      portal.discMat.emissiveIntensity = IDLE_EMISSIVE_MIN
        + (IDLE_EMISSIVE_MAX - IDLE_EMISSIVE_MIN) * k;
      if (k > 0.95) portal.discMat.emissive.setHex(portal.peakColorHex);
      else          portal.discMat.emissive.setHex(portal.baseColorHex);
    }

    // Disc Y-bob (cosmetic).
    portal.bobPhase += dt * (Math.PI * 2 * DISC_BOB_HZ);
    if (portal.discMesh) {
      portal.discMesh.position.y = DISC_BASE_Y + Math.sin(portal.bobPhase) * DISC_BOB_AMP;
    }

    // Floating crystal — slow spin + sin-bob above the disc.
    portal.crystalPhase += dt * (Math.PI * 2 * CRYSTAL_SPIN_HZ);
    if (portal.crystalMesh) {
      portal.crystalMesh.rotation.y = portal.crystalPhase;
      portal.crystalMesh.position.y = CRYSTAL_BASE_Y + Math.sin(portal.crystalPhase * 1.3) * CRYSTAL_BOB_AMP;
    }

    // Cooldown overlay opacity ramp.
    if (portal.cooldownActive) {
      const remaining = portal.cooldownUntil - tNow;
      if (remaining > 0) {
        const frac = Math.max(0, Math.min(1, remaining / COOLDOWN_DURATION));
        if (portal.cooldownRing) portal.cooldownRing.mat.opacity = COOLDOWN_RING_OPACITY_MAX * frac;
      } else {
        if (portal.cooldownRing) portal.cooldownRing.mat.opacity = 0;
        portal.cooldownActive = false;
      }
    }
  }

  // ── Breadcrumb bob — single matrix rewrite per orb. Cheap.
  if (_trails.length > 0) {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    for (const trail of _trails) {
      const data = trail.instanceData;
      const len = data.length;
      for (let i = 0; i < len; i++) {
        const d = data[i];
        d.bobPhase += dt * (Math.PI * 2 * BREADCRUMB_BOB_HZ);
        const y = BREADCRUMB_Y_BASE + Math.sin(d.bobPhase) * BREADCRUMB_BOB_AMP;
        pos.set(d.baseX, y, d.baseZ);
        scl.set(d.scl, d.scl, d.scl);
        m.compose(pos, q, scl);
        trail.mesh.setMatrixAt(i, m);
      }
      trail.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // ── PASS 2: E-key edge + proximity + activation.
  // Edge-triggered: interactPressed is true on the tick the key transitions
  // down. Defensive optional chain because Cohort 3A is wiring this in
  // parallel; if missing we just skip activation rather than crash.
  const interactEdge = !!(state.input && state.input.interactPressed);
  if (heroAlive && heroPos && interactEdge) {
    const target = _findReadyPortalNearHero(heroPos, tNow);
    if (target) {
      // === ACTIVATION FRAME ===
      // (1) Origin flash — disc emissive spike + slot-7 ring.
      if (target.discMat) {
        target.discMat.emissive.setHex(COLOR_AMBER_FLASH);
        target.discMat.emissiveIntensity = TELEPORT_FLASH_EMISSIVE;
      }
      _flashRings.push(_spawnFlashRing(scene, target.x, target.z));

      // (2) Hero position snap — pos + mesh in the same tick.
      state.hero.pos.x = target.dest.x;
      state.hero.pos.z = target.dest.z;
      if (state.hero.mesh) {
        state.hero.mesh.position.x = target.dest.x;
        state.hero.mesh.position.z = target.dest.z;
      }

      // (3) iFrames on arrival — preserve any longer existing window.
      state.hero.iFramesUntil = Math.max(
        state.hero.iFramesUntil || 0,
        tNow + IFRAMES_ON_ARRIVAL
      );

      // (4) Destination flash at arrival point (matches voidTeleportPads
      //     "single-frame peak on origin AND destination on the same
      //     frame"). The destination isn't an entity itself, so we just
      //     spawn the slot-7 ring at the arrival coord.
      _flashRings.push(_spawnFlashRing(scene, target.dest.x, target.dest.z));

      // (5) Cooldown on ORIGIN portal.
      target.cooldownUntil = tNow + COOLDOWN_DURATION;
      target.cooldownActive = true;
      if (target.cooldownRing) target.cooldownRing.mat.opacity = COOLDOWN_RING_OPACITY_MAX;

      // (6) Re-entry guard on ANY portal whose position is at the arrival
      //     coord (e.g. the paired return portal at room center — landing
      //     on top of it should NOT immediately consume the next E-press).
      for (const p of _portals) {
        if (p === target) continue;
        const ddx = p.x - target.dest.x;
        const ddz = p.z - target.dest.z;
        if (ddx * ddx + ddz * ddz <= PROXIMITY_R2) {
          p.localStepGuard = tNow + LOCAL_STEP_GUARD;
        }
      }

      // (7) Defensive SFX — only fire if a forest-portal handler exists.
      //     Don't fall through to void-themed sounds.
      // (audio.js may add `sfx.forestPortal` later; we don't import it here
      //  to keep the dep graph tight. Wiring is FE-C3A's call.)
    }
  }

  // ── PASS 3: tick flash rings (expand + fade + dispose on expiry).
  for (let i = _flashRings.length - 1; i >= 0; i--) {
    const r = _flashRings[i];
    r.t += dt;
    const k = Math.min(1, r.t / r.life);
    const sc = 1.0 + 1.5 * k;
    r.group.scale.set(sc, 1, sc);
    r.mats[0].opacity = r.baseOpacity * (1 - k);
    if (k >= 1) {
      if (r.group.parent) r.group.parent.remove(r.group);
      else if (scene) scene.remove(r.group);
      for (const g of r.geos) { try { g.dispose(); } catch (_) {} }
      for (const m of r.mats) { try { m.dispose(); } catch (_) {} }
      _flashRings.splice(i, 1);
    }
  }
}

// ─── public: dispose ────────────────────────────────────────────────────────
export function disposeForestPortals(scene) {
  // Tear down in-flight flash rings (scene children).
  for (const r of _flashRings) {
    if (r.group && r.group.parent) r.group.parent.remove(r.group);
    else if (r.group && scene) scene.remove(r.group);
    for (const g of r.geos) { try { g.dispose(); } catch (_) {} }
    for (const m of r.mats) { try { m.dispose(); } catch (_) {} }
  }
  _flashRings.length = 0;

  // Tear down per-portal materials (geometries are shared, disposed below).
  for (const portal of _portals) {
    if (portal.cooldownRing) {
      try { portal.cooldownRing.mat.dispose(); } catch (_) {}
      try { portal.cooldownRing.geo.dispose(); } catch (_) {}
      portal.cooldownRing = null;
    }
    if (portal.discMat)    { try { portal.discMat.dispose(); } catch (_) {} }
    if (portal.rimMat)     { try { portal.rimMat.dispose(); } catch (_) {} }
    if (portal.crystalMat) { try { portal.crystalMat.dispose(); } catch (_) {} }
  }

  // Tear down breadcrumb trail InstancedMesh materials.
  for (const trail of _trails) {
    if (trail.mat) { try { trail.mat.dispose(); } catch (_) {} }
    // The InstancedMesh itself is parented to _group, removed wholesale below.
    // Its geometry is in _disposables and disposed there.
  }
  _trails.length = 0;

  // Remove parent group + dispose shared geos/mats.
  if (_group) {
    if (scene && _group.parent === scene) scene.remove(_group);
    else if (_group.parent) _group.parent.remove(_group);
    _group = null;
  }
  for (const d of _disposables) { try { d.dispose && d.dispose(); } catch (_) {} }
  _disposables.length = 0;

  _portals.length = 0;
}

// Naming-parity alias for code that follows the loadForestAmber/clearForestAmber
// convention. Functionally identical to disposeForestPortals.
export { disposeForestPortals as clearForestPortals };

// ─── debug exports (mirror voidTeleportPads / forestAmber pattern) ──────────
export function _debugPortals()    { return _portals.slice(); }
export function _debugTrails()     { return _trails.slice(); }
export function _debugFlashRings() { return _flashRings.slice(); }
