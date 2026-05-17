/**
 * Per-stage arena decor — visual flavor on top of the ground tint.
 *
 * Each stage gets a different decor pack (trees / crystals / lava cracks /
 * skulls) built from InstancedMesh so we keep a low draw-call budget even
 * with hundreds of pieces. Density is biased outward (toward the 60u ring)
 * so the play area stays readable.
 *
 *   loadArenaDecor(stageId, scene) — build + add decor for the stage
 *   clearArenaDecor(scene)         — remove + dispose all current decor
 *
 * Both are idempotent: calling load while decor is already mounted will
 * tear the old one down first.
 *
 * Skybox: a flat scene.background color is tinted per-stage (kept dim so
 * the existing dark fog still reads as "the world ends at the fog wall").
 * If main.js ever swaps in a gradient/cubemap, leave it alone.
 *
 * Bloom: emissive crystals + lava cracks join BLOOM_LAYER so they pop in
 * the bloom pass. Ground rune circles stay off-bloom (subtle ambient).
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from './postfx.js';
import { cloneCached } from './assets.js';
import { makeRuneRingTexture } from './enemyTells.js';
import { fxTex } from './fxTextures.js';
import { FOREST_ROOMS } from './forestRooms.js';
import { loadForestLandmarks } from './forestLandmarks.js';
import { loadForestCoffins } from './forestCoffins.js';
import { loadForestNeutrals } from './forestNeutrals.js';
import { loadForestEnvHazards } from './forestEnvHazards.js';
import { loadForestChests } from './forestChests.js';
import { loadForestReaper } from './forestReaper.js';
import { loadForestPickups } from './forestPickups.js';
import { state as _gameState } from './state.js';

// Active decor group + cleanup hooks, tracked module-side so clearArenaDecor
// can be called without a handle. One group per scene is enough in this game.
let _decorGroup = null;
let _bobbers = null;     // {mesh, baseY[], phase[], amp[], freq[]} — crystals
let _drifters = null;    // {mesh, baseY[], phase[], amp[], freq[], spin[]} — bones
let _rafId = null;
let _disposables = [];
let _savedSkyHex = null;

// ── ring-biased scatter helper ────────────────────────────────────────────────
// Pulls a random radius in [rMin, rMax] biased outward (power curve >1) so
// counts cluster near the fog ring and the play area stays clear.
function _ringR(rMin, rMax, biasPow = 1.6) {
  const u = Math.pow(Math.random(), 1 / biasPow); // skew toward 1
  return rMin + (rMax - rMin) * u;
}
function _scatterRing(rMin, rMax, biasPow = 1.6) {
  const a = Math.random() * Math.PI * 2;
  const r = _ringR(rMin, rMax, biasPow);
  return { x: Math.cos(a) * r, z: Math.sin(a) * r, a };
}

function _track(obj) { _disposables.push(obj); }

// ── stage packs ───────────────────────────────────────────────────────────────

/**
 * Forest stage dispatcher (Cohort 2, FE-C2). Routes to a per-room builder
 * keyed by `opts.roomId`. The loader (`loadArenaDecor`) fans out by calling
 * this once per room so all 4 room groups are pre-allocated at scene-load
 * time — the integration agent (Cohort 3A) just toggles `.visible` on the
 * tagged meshes when the player crosses a portal. Backward-compat: missing
 * roomId defaults to 'glade' so any pre-FE-C2 caller still works.
 */
function _buildForestDecor(group, opts) {
  const roomId = (opts && opts.roomId) || 'glade';
  let result;
  switch (roomId) {
    case 'glade':          result = _buildGladeDecor(group); break;
    case 'saphollow':      result = _buildSapHollowDecor(group); break;
    case 'crystalchoir':   result = _buildCrystalChoirDecor(group); break;
    case 'amberlabyrinth': result = _buildAmberLabyrinthDecor(group); break;
    // ── FE-V2 (2026-05-17): 3 new room builders ──
    case 'bramblemaze':    result = _buildBrambleMazeDecor(group); break;
    case 'mossroot':       result = _buildMossrootDecor(group); break;
    case 'glowfen':        result = _buildGlowfenDecor(group); break;
    default:               result = _buildGladeDecor(group); break;
  }
  // ── FE-V2 Landmarks (2026-05-17) ──
  // Landmarks are scene-scoped (span all 7 rooms), not room-scoped. The
  // per-room loader fan-out in loadArenaDecor calls _buildForestDecor 7
  // times; we gate the landmark loader on `_landmarksLoaded` so it fires
  // exactly once per scene load. disposeForestLandmarks (main.js teardown)
  // flips the flag back to false on stage swap. Group is attached to
  // state.scene, not the per-room decor group, so it doesn't get torn down
  // when an individual room's visibility toggles.
  if (_gameState && _gameState.scene && !_gameState._landmarksLoaded) {
    _gameState._landmarksLoaded = true;
    try {
      loadForestLandmarks(_gameState.scene, _gameState, opts && opts.rng);
    } catch (e) {
      console.warn('[arenaDecor] loadForestLandmarks failed:', e);
      _gameState._landmarksLoaded = false;
    }
  }
  // ── FE-V2 Coffins (2026-05-17) ──
  // Coffins are scene-scoped (1-2 placements across mossroot/glowfen).
  // Gate-once-per-scene mirrors the landmarks pattern above. Must load
  // AFTER landmarks so getLandmarkPositions() returns a populated snapshot
  // for the keep-out query (landmarks loader sits directly above us).
  if (_gameState && _gameState.scene && !_gameState._coffinsLoaded) {
    _gameState._coffinsLoaded = true;
    try {
      loadForestCoffins(_gameState.scene, _gameState, opts && opts.rng);
    } catch (e) {
      console.warn('[arenaDecor] loadForestCoffins failed:', e);
      _gameState._coffinsLoaded = false;
    }
  }
  // ── FE-V2 Neutrals (2026-05-17) ──
  // Roaming neutrals (fireflies / deer / owls) are scene-scoped — same
  // once-per-scene gating pattern as landmarks + coffins. Must load AFTER
  // landmarks because owl placement reads getLandmarkPositions() for perch
  // candidates; the landmarks loader sits two blocks above us so the
  // ordering is guaranteed.
  if (_gameState && _gameState.scene && !_gameState._neutralsLoaded) {
    _gameState._neutralsLoaded = true;
    try {
      loadForestNeutrals(_gameState.scene, _gameState, opts && opts.rng);
    } catch (e) {
      console.warn('[arenaDecor] loadForestNeutrals failed:', e);
      _gameState._neutralsLoaded = false;
    }
  }
  // ── FE-V2 Environmental Hazards (FE-V2-A5, 2026-05-17) ──
  // Scene-scoped (mushroom rings / tar pits / falling branches across all 7
  // rooms). Same once-per-scene gate as landmarks/coffins/neutrals. Load
  // AFTER landmarks because the keep-out test reads getLandmarkPositions()
  // for placement (landmarks loader sits four blocks above us so the ordering
  // is guaranteed).
  if (_gameState && _gameState.scene && !_gameState._envHazardsLoaded) {
    _gameState._envHazardsLoaded = true;
    try {
      loadForestEnvHazards(_gameState.scene, _gameState, opts && opts.rng);
    } catch (e) {
      console.warn('[arenaDecor] loadForestEnvHazards failed:', e);
      _gameState._envHazardsLoaded = false;
    }
  }
  // ── FOREST-V2-A6 Treasure Chest Drops (2026-05-17) ──
  // Scene-scoped pre-pool (8 active chests max) used by VS-style miniboss/
  // elite drops. Once-per-scene gate mirrors envHazards/neutrals/etc.
  // Independent of placement (chests spawn from enemy deaths, not arena
  // scatter) — load just bootstraps the InstancedMesh pool.
  if (_gameState && _gameState.scene && !_gameState._chestsLoaded) {
    _gameState._chestsLoaded = true;
    try {
      loadForestChests(_gameState.scene, _gameState);
    } catch (e) {
      console.warn('[arenaDecor] loadForestChests failed:', e);
      _gameState._chestsLoaded = false;
    }
  }
  // ── FOREST-V2-A7 Reaper Endgame (2026-05-17) ──
  // Scene-scoped single-instance hunter that spawns at 30:00 stage time.
  // Once-per-scene gate mirrors chests/envHazards/etc. Independent of room
  // routing (the entity reads state.run.currentRoom at spawn-time to pick an
  // edge, and the tick lives in the forest-only block in main.js).
  if (_gameState && _gameState.scene && !_gameState._reaperLoaded) {
    _gameState._reaperLoaded = true;
    try {
      loadForestReaper(_gameState.scene, _gameState);
    } catch (e) {
      console.warn('[arenaDecor] loadForestReaper failed:', e);
      _gameState._reaperLoaded = false;
    }
  }
  // ── FOREST-V2-A8 Floor Pickups (2026-05-17) ──
  // Scene-scoped pre-pool (16 bombs / 16 magnets / 8 chickens) for VS-style
  // consumable drops off enemy kills. Once-per-scene gate mirrors chests /
  // reaper. Drop-side is wired via dropForestPickup() in src/enemies.js; load
  // just bootstraps the InstancedMesh pool.
  if (_gameState && _gameState.scene && !_gameState._pickupsLoaded) {
    _gameState._pickupsLoaded = true;
    try {
      loadForestPickups(_gameState.scene, _gameState);
    } catch (e) {
      console.warn('[arenaDecor] loadForestPickups failed:', e);
      _gameState._pickupsLoaded = false;
    }
  }
  return result;
}

function _buildGladeDecor(group) {
  // PETRIFIED FOREST — bioluminescent crystal-stone woods.
  // Contract: docs/FOREST_VISUAL_STYLE.md (8-color palette, choke corridors,
  // amber hotspot JSON). Per-cluster crystal pack with funnel gaps and slot-5
  // accent shards. No grass tufts (doesn't fit petrified theme). Amber
  // hotspots are coordinate-only and written to disk for the Phase-2 Amber
  // Interactable agent to consume — we do NOT render them here.
  //
  // Note (FE-C2): this is the "glade" hub room. The pre-FE-C2 single-arena
  // forest decor lived in this function (then named _buildForestDecor); the
  // body is preserved verbatim so the existing amber hotspot JSON contract
  // and seeded chokepoints don't regress. New rooms (saphollow / crystalchoir
  // / amberlabyrinth) live in sibling builders below.
  //
  // Palette slots used here:
  //   slot 1 #1a1e22 (stone-trunk base, charcoal)         — body color
  //   slot 2 #2d3a55 (crystal-trunk mid, blue-gray)       — body color
  //   slot 3 #5f8fb5 (crystal facet hi, pale cyan-steel)  — tip color
  //   slot 4 #7df0c4 (bio-glow primary, mint)             — tip emissive
  //   slot 5 #3ecf9a (bio-glow secondary, darker mint)    — accent shards

  // ── deterministic RNG (A1 fix) ───────────────────────────────────────────
  // mulberry32 seeded with the canonical forest decor seed (0xC0FFEE). Same
  // seed used by tools/regen-forest-hotspots.mjs so cluster centers / funnels
  // derived here align with the amber hotspot positions written to disk.
  // Without this, Math.random()-driven cluster centers re-roll every reload
  // while the JSON hotspots stay fixed — they drift apart and the chokepoint
  // funnel feel collapses (cf. tight-pair issue in seeds 1000/1001 etc.).
  let _rngState = 0xC0FFEE >>> 0;
  function rand() {
    _rngState = (_rngState + 0x6D2B79F5) >>> 0;
    let t = _rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  // Local shadows of _ringR / _scatterRing so the helper paths used inside
  // this function are also seeded (the module-level versions still use
  // Math.random() for the other stage builders — only forest needs determinism
  // for the hotspot alignment contract).
  function ringR(rMin, rMax, biasPow = 1.6) {
    const u = Math.pow(rand(), 1 / biasPow);
    return rMin + (rMax - rMin) * u;
  }
  function scatterRing(rMin, rMax, biasPow = 1.6) {
    const a = rand() * Math.PI * 2;
    const r = ringR(rMin, rMax, biasPow);
    return { x: Math.cos(a) * r, z: Math.sin(a) * r, a };
  }

  // ── shared per-instance transform dummy ──────────────────────────────────
  const dummy = new THREE.Object3D();

  // ── 1) cluster centers (deterministic open-arc layout) ───────────────────
  // Pick 3–5 cluster anchors evenly around the play ring with a small angular
  // jitter, so we always preserve open arcs between clumps (player escape
  // routes). Radius per cluster picked in [22, 46] so they sit well inside
  // the 60u play ring but outside the spawn safe zone.
  const CLUSTER_COUNT = 4 + (rand() < 0.5 ? 0 : 1); // 4 or 5
  const baseStep = (Math.PI * 2) / CLUSTER_COUNT;
  const jitterMax = baseStep * 0.25;  // ≤ ¼ wedge so arcs stay open
  const clusters = [];
  for (let c = 0; c < CLUSTER_COUNT; c++) {
    const angle = c * baseStep + (rand() - 0.5) * 2 * jitterMax;
    const radius = 22 + rand() * 24; // 22..46
    clusters.push({
      cx: Math.cos(angle) * radius,
      cz: Math.sin(angle) * radius,
      angle,
      // Funnel gap: a single ~60° wedge per cluster where no crystal grows
      // (and where the amber hotspot is biased). Random offset within the
      // cluster so swarms threading through the funnel hit different lanes.
      funnelDir: rand() * Math.PI * 2,
      funnelHalfWidth: Math.PI / 6,   // 30° half = 60° gap
      crystalCount: 6 + ((rand() * 5) | 0), // 6..10
    });
  }

  // ── 2) crystal trees — TWO InstancedMesh pools sharing transforms ────────
  // Body (hex-prism): slot 2 color, NO emissive, NO bloom.
  // Tips (twin cones merged): slot 3 color, slot 4 emissive, BLOOM ON.
  // Same per-instance matrix applied to both meshes so they always co-locate.
  let totalCrystals = 0;
  for (const cl of clusters) totalCrystals += cl.crystalCount;

  // Body geo — tall hex prism. Center at y=0.55 (height/2) so y-position = 0
  // is "ground", but we lift to half-height so base sits on floor.
  const bodyGeo = new THREE.CylinderGeometry(0.22, 0.34, 1.1, 6, 1, false);
  // Tips — merge two cones (one tall up-pointing facet on top, one short
  // inverted at the base flare) into a single BufferGeometry. Same manual-
  // merge pattern as _buildTwilightDecor uses.
  const _tipUp   = new THREE.ConeGeometry(0.22, 0.55, 6);
  _tipUp.translate(0, 0.825, 0);   // sit on top of body (body half-height 0.55 + cone half 0.275)
  const _tipMid  = new THREE.ConeGeometry(0.18, 0.40, 6);
  _tipMid.translate(0, 1.20, 0);   // small secondary tip above the first
  const tipsGeo = (() => {
    const merge = new THREE.BufferGeometry();
    const parts = [_tipUp, _tipMid];
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
    return merge;
  })();
  _tipUp.dispose(); _tipMid.dispose();

  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x2d3a55,           // slot 2 — cold blue-gray
    roughness: 0.85, metalness: 0.05,
    flatShading: true,         // faceted silhouette under bloom
  });
  const tipsMat = new THREE.MeshStandardMaterial({
    color: 0x5f8fb5,           // slot 3 — pale cyan-steel facet
    emissive: 0x7df0c4,        // slot 4 — bio-glow primary mint
    emissiveIntensity: 1.5,    // spec: 1.2–1.8
    roughness: 0.25, metalness: 0.10,
    flatShading: true,
    transparent: true, opacity: 0.94,
  });
  const bodyInst = new THREE.InstancedMesh(bodyGeo, bodyMat, totalCrystals);
  const tipsInst = new THREE.InstancedMesh(tipsGeo, tipsMat, totalCrystals);
  tipsInst.layers.enable(BLOOM_LAYER);   // facet tips glow
  bodyInst.receiveShadow = false; tipsInst.receiveShadow = false;

  let ci = 0;
  for (const cl of clusters) {
    for (let k = 0; k < cl.crystalCount; k++) {
      // Inner-cluster polar scatter AROUND the cluster center (not from world
      // origin). Reserve the funnel wedge so swarm pathing has a lane.
      let theta;
      // Re-roll until outside funnel wedge (bounded loop, 8 max tries — then
      // accept whatever we have to avoid infinite loops in unlucky seeds).
      for (let tries = 0; tries < 8; tries++) {
        theta = rand() * Math.PI * 2;
        const d = Math.atan2(
          Math.sin(theta - cl.funnelDir),
          Math.cos(theta - cl.funnelDir),
        );
        if (Math.abs(d) > cl.funnelHalfWidth) break;
      }
      const r = 0.6 + rand() * 2.9;   // 0.6..3.5u from cluster center
      const x = cl.cx + Math.cos(theta) * r;
      const z = cl.cz + Math.sin(theta) * r;

      // Skew per-instance — height bias for tall facet vs squat stub.
      const sx = 0.65 + rand() * 0.45;
      const sy = 0.85 + rand() * 0.95;
      const sz = 0.65 + rand() * 0.45;
      // Sit base on floor: half-height of body is 0.55 → lift by 0.55 * sy.
      const baseY = 0.55 * sy;
      dummy.position.set(x, baseY, z);
      dummy.scale.set(sx, sy, sz);
      // Lean off vertical for facet asymmetry (spec: avoid parade-line look).
      dummy.rotation.set(
        (rand() - 0.5) * 0.40,
        rand() * Math.PI * 2,
        (rand() - 0.5) * 0.40,
      );
      dummy.updateMatrix();
      bodyInst.setMatrixAt(ci, dummy.matrix);
      tipsInst.setMatrixAt(ci, dummy.matrix);
      ci++;
    }
  }
  bodyInst.instanceMatrix.needsUpdate = true;
  tipsInst.instanceMatrix.needsUpdate = true;
  // FE-C2: tag for the integration agent's per-room visibility toggle.
  bodyInst.userData.roomId = 'glade';
  tipsInst.userData.roomId = 'glade';
  group.add(bodyInst); group.add(tipsInst);
  _track(bodyGeo); _track(tipsGeo); _track(bodyMat); _track(tipsMat);

  // ── 3) slot-5 accent shards — small bloom-lit fragments between clusters ─
  // Atmosphere only (not chokepoints). Octahedron silhouette reads as cut
  // glass at small scales. One InstancedMesh, single draw call, bloom on.
  const SHARDS = 40;
  const shardGeo = new THREE.OctahedronGeometry(0.28, 0);
  const shardMat = new THREE.MeshStandardMaterial({
    color: 0x3ecf9a,           // slot 5 — darker mint
    emissive: 0x3ecf9a,
    emissiveIntensity: 1.2,
    roughness: 0.3, metalness: 0.1,
    flatShading: true,
    transparent: true, opacity: 0.90,
  });
  const shardInst = new THREE.InstancedMesh(shardGeo, shardMat, SHARDS);
  shardInst.layers.enable(BLOOM_LAYER);
  for (let i = 0; i < SHARDS; i++) {
    const { x, z } = scatterRing(18, 55, 1.4);
    const s = 0.45 + rand() * 0.85;
    dummy.position.set(x, 0.15 + rand() * 0.35, z);
    dummy.scale.setScalar(s);
    dummy.rotation.set(
      rand() * Math.PI,
      rand() * Math.PI * 2,
      rand() * Math.PI,
    );
    dummy.updateMatrix();
    shardInst.setMatrixAt(i, dummy.matrix);
  }
  shardInst.instanceMatrix.needsUpdate = true;
  shardInst.userData.roomId = 'glade';
  group.add(shardInst);
  _track(shardGeo); _track(shardMat);

  // ── 4) ground rune ambient — subtle slot-5 rings, bloom OFF ──────────────
  // A small set of rune-ring textured planes (much lower density than the
  // twilight 40, so the petrified ground stays the visual lead). Bloom off
  // per the contract for ground-rune ambient detail.
  const RUNES = 14;
  const runeGeo = new THREE.PlaneGeometry(1.7, 1.7);
  const runeMat = new THREE.MeshBasicMaterial({
    map: fxTex('ring_arcane') || makeRuneRingTexture(),
    color: 0x3ecf9a,           // slot 5
    transparent: true, opacity: 0.22, side: THREE.DoubleSide,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const runeInst = new THREE.InstancedMesh(runeGeo, runeMat, RUNES);
  for (let i = 0; i < RUNES; i++) {
    const { x, z } = scatterRing(18, 56, 1.5);
    const s = 0.7 + rand() * 1.1;
    dummy.position.set(x, -0.06, z);
    dummy.scale.set(s, s, 1);
    dummy.rotation.set(-Math.PI / 2, 0, rand() * Math.PI * 2);
    dummy.updateMatrix();
    runeInst.setMatrixAt(i, dummy.matrix);
  }
  runeInst.instanceMatrix.needsUpdate = true;
  runeInst.userData.roomId = 'glade';
  group.add(runeInst);
  _track(runeGeo); _track(runeMat);

  // ── 5) amber hotspots — coordinate-only scatter (Phase-2 agent renders) ──
  // Bias 1–2 hotspots PER cluster onto the cluster's funnel-facing perimeter,
  // so the player can shoot one and chain-detonate the chokepoint. Reject
  // any sample outside the [15, 55] safe ring (clamp by re-sample).
  const amberHotspots = [];
  let seedCounter = 1000;
  for (const cl of clusters) {
    const wanted = rand() < 0.55 ? 2 : 1;  // mostly 1, sometimes 2
    let placed = 0;
    for (let tries = 0; tries < 24 && placed < wanted; tries++) {
      // Aim at the funnel-facing perimeter of the cluster: sample θ inside
      // the funnel wedge so the hotspot sits IN the path the swarm walks.
      const wedge = cl.funnelHalfWidth * 1.4; // a touch wider than the gap
      const theta = cl.funnelDir + (rand() * 2 - 1) * wedge;
      const r = 3.4 + rand() * 1.6;    // just outside cluster radius
      const x = cl.cx + Math.cos(theta) * r;
      const z = cl.cz + Math.sin(theta) * r;
      const radial = Math.hypot(x, z);
      if (radial < 15 || radial > 55) continue;  // safe-zone clamp
      amberHotspots.push({
        x: +x.toFixed(2),
        z: +z.toFixed(2),
        scale: +(0.85 + rand() * 0.35).toFixed(2),  // 0.85..1.20
        seed: seedCounter++,
      });
      placed++;
    }
  }
  // Top up to target band 18–22 (sometimes 4 clusters * 1 = 4; we need ~20)
  // by sampling additional perimeter spots between any cluster pair until we
  // hit at least 18. Cap at 22 to honor the upper bound.
  const TARGET_MIN = 18, TARGET_MAX = 22;
  let topUpGuard = 0;
  while (amberHotspots.length < TARGET_MIN && topUpGuard++ < 200) {
    const cl = clusters[(rand() * clusters.length) | 0];
    const theta = rand() * Math.PI * 2;   // any perimeter angle
    const r = 3.4 + rand() * 1.8;
    const x = cl.cx + Math.cos(theta) * r;
    const z = cl.cz + Math.sin(theta) * r;
    const radial = Math.hypot(x, z);
    if (radial < 15 || radial > 55) continue;
    amberHotspots.push({
      x: +x.toFixed(2),
      z: +z.toFixed(2),
      scale: +(0.85 + rand() * 0.35).toFixed(2),
      seed: seedCounter++,
    });
  }
  if (amberHotspots.length > TARGET_MAX) amberHotspots.length = TARGET_MAX;

  // Stash on the group so the loader / tools can write the JSON file once
  // (we don't fs.writeFile from a browser module — the JSON is authored by
  // the build-time tool that ran this generator. See assets/forest_amber_hotspots.json).
  group.userData.amberHotspots = amberHotspots;

  return {
    clusters: clusters.length,
    crystals: totalCrystals,
    shards: SHARDS,
    runes: RUNES,
    amberHotspots: amberHotspots.length,
  };
}

// ── FE-C2: per-room forest builders ─────────────────────────────────────────
// Sap Hollow / Crystal Choir Grove / Amber Labyrinth.
//
// Each room translates its scatter by FOREST_ROOMS[roomId].center so meshes
// don't pile on top of the Glade at world origin (advisor flagged this trap
// 2026-05-16). Each room seeds a distinct mulberry32 stream so layouts are
// deterministic across reloads but visually distinct between rooms.
//
// All InstancedMesh outputs are tagged with userData.roomId so the Cohort 3A
// integration agent can flip .visible based on the player's current room.
// For now (FE-C2), every room's meshes are added visible — the integration
// layer will gate them.
//
// PALETTE LOCK: only the 8 hex literals from docs/FOREST_VISUAL_STYLE.md may
// appear in this section. The task spec mentions "low purple fog" for the
// labyrinth — that's NOT purple in code, it's slot-5 (#3ecf9a, darker mint
// "pollen tinted" per the parenthetical clarification). Verified by grep.

/** mulberry32 factory — returns a stateful rand() in [0, 1). Per-room seeds
 *  give us deterministic-but-distinct scatter patterns across the 4 rooms. */
function _mulberry32(seed) {
  let s = seed >>> 0;
  return function rand() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Sap Hollow — lime sap floor + dripping ceiling.
 * Center (-70, -90), bounds 40×60u. Visual lead is slot-4 (mint bio-glow)
 * sap puddles + slot-5 drip particles. "Darker overall" achieved via lower
 * material opacity on accents, NOT a new palette color (palette is locked).
 */
function _buildSapHollowDecor(group) {
  const room = FOREST_ROOMS.saphollow;
  const cx = room.center.x, cz = room.center.z;
  const rand = _mulberry32(0xC0FFE2);
  const dummy = new THREE.Object3D();

  // 15-20 sap puddles — flat additive discs on the floor, slot-4 (mint).
  // Reuses the rune-ring texture via the same fxTex hook the glade uses so
  // we don't ship a second texture. Bloom OFF (these are ground splats).
  const PUDDLES = 15 + ((rand() * 6) | 0); // 15..20
  const puddleGeo = new THREE.PlaneGeometry(1.0, 1.0);
  const puddleMat = new THREE.MeshBasicMaterial({
    map: fxTex('ring_arcane') || makeRuneRingTexture(),
    color: 0x7df0c4,             // slot 4 — bio-glow primary mint
    transparent: true, opacity: 0.55, side: THREE.DoubleSide,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const puddleInst = new THREE.InstancedMesh(puddleGeo, puddleMat, PUDDLES);
  for (let i = 0; i < PUDDLES; i++) {
    // Inner scatter inside the room bounds (margin 4u from edges).
    const lx = (rand() * 2 - 1) * 16;   // ±16 inside 40u-wide bounds
    const lz = (rand() * 2 - 1) * 26;   // ±26 inside 60u-tall bounds
    const s  = 1.6 + rand() * 1.8;      // 1.6..3.4u radius
    dummy.position.set(cx + lx, -0.05, cz + lz);
    dummy.scale.set(s, s, 1);
    dummy.rotation.set(-Math.PI / 2, 0, rand() * Math.PI * 2);
    dummy.updateMatrix();
    puddleInst.setMatrixAt(i, dummy.matrix);
  }
  puddleInst.instanceMatrix.needsUpdate = true;
  puddleInst.userData.roomId = 'saphollow';
  group.add(puddleInst);
  _track(puddleGeo); _track(puddleMat);

  // Dripping ceiling particles — tiny slot-5 octahedrons hanging at variable
  // heights, additive + bloom-tagged for the wet-cave look. Static placement
  // (no animation tick) — the bloom flicker reads as drip motion.
  const DRIPS = 36;
  const dripGeo = new THREE.OctahedronGeometry(0.10, 0);
  const dripMat = new THREE.MeshStandardMaterial({
    color: 0x3ecf9a,             // slot 5 — bio-glow secondary
    emissive: 0x3ecf9a,
    emissiveIntensity: 1.6,
    roughness: 0.3, metalness: 0.1,
    flatShading: true,
    transparent: true, opacity: 0.85,
  });
  const dripInst = new THREE.InstancedMesh(dripGeo, dripMat, DRIPS);
  dripInst.layers.enable(BLOOM_LAYER);
  for (let i = 0; i < DRIPS; i++) {
    const lx = (rand() * 2 - 1) * 17;
    const lz = (rand() * 2 - 1) * 27;
    const y  = 2.4 + rand() * 1.8;      // 2.4..4.2u above floor
    const s  = 0.45 + rand() * 0.85;
    dummy.position.set(cx + lx, y, cz + lz);
    dummy.scale.setScalar(s);
    dummy.rotation.set(rand() * Math.PI, rand() * Math.PI * 2, rand() * Math.PI);
    dummy.updateMatrix();
    dripInst.setMatrixAt(i, dummy.matrix);
  }
  dripInst.instanceMatrix.needsUpdate = true;
  dripInst.userData.roomId = 'saphollow';
  group.add(dripInst);
  _track(dripGeo); _track(dripMat);

  // Slot-2 stone-trunk silhouettes around the room edge — a low ring of
  // dark crystal stubs that frame the playspace without choking it. Bloom
  // OFF (these are silhouette, not glow). Reuses the glade body geometry
  // shape but with a darker palette slot.
  const STUBS = 12;
  const stubGeo = new THREE.CylinderGeometry(0.28, 0.42, 0.95, 6, 1, false);
  const stubMat = new THREE.MeshStandardMaterial({
    color: 0x2d3a55,             // slot 2 — cold blue-gray
    roughness: 0.9, metalness: 0.05,
    flatShading: true,
  });
  const stubInst = new THREE.InstancedMesh(stubGeo, stubMat, STUBS);
  for (let i = 0; i < STUBS; i++) {
    // Place along the room perimeter at ~80% of half-bounds.
    const angle = (i / STUBS) * Math.PI * 2 + rand() * 0.4;
    const lx = Math.cos(angle) * 16;
    const lz = Math.sin(angle) * 26;
    const sy = 1.1 + rand() * 0.9;
    dummy.position.set(cx + lx, 0.475 * sy, cz + lz);
    dummy.scale.set(0.85 + rand() * 0.3, sy, 0.85 + rand() * 0.3);
    dummy.rotation.set((rand() - 0.5) * 0.25, rand() * Math.PI * 2, (rand() - 0.5) * 0.25);
    dummy.updateMatrix();
    stubInst.setMatrixAt(i, dummy.matrix);
  }
  stubInst.instanceMatrix.needsUpdate = true;
  stubInst.userData.roomId = 'saphollow';
  group.add(stubInst);
  _track(stubGeo); _track(stubMat);

  return { room: 'saphollow', puddles: PUDDLES, drips: DRIPS, stubs: STUBS };
}

/**
 * Crystal Choir Grove — singing crystal spire arc.
 * Center (0, 80), bounds 50×50u. 5-7 tall spires arranged in an arc, brighter
 * glow than glade (emissiveIntensity at the top of the spec range, 1.8).
 * Uses the same body/tip InstancedMesh pattern as the glade so the visual
 * vocabulary stays consistent.
 */
function _buildCrystalChoirDecor(group) {
  const room = FOREST_ROOMS.crystalchoir;
  const cx = room.center.x, cz = room.center.z;
  const rand = _mulberry32(0xC0FFE3);
  const dummy = new THREE.Object3D();

  const SPIRES = 5 + ((rand() * 3) | 0); // 5..7
  // Tall hex-prism body, twice the height of glade crystals.
  const bodyGeo = new THREE.CylinderGeometry(0.28, 0.46, 2.4, 6, 1, false);
  // Big tip cone for the choir-spire silhouette.
  const tipsGeo = new THREE.ConeGeometry(0.30, 1.1, 6);
  tipsGeo.translate(0, 1.75, 0);  // sit on top of body (half body 1.2 + cone half 0.55)

  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x2d3a55,             // slot 2
    roughness: 0.85, metalness: 0.05,
    flatShading: true,
  });
  const tipsMat = new THREE.MeshStandardMaterial({
    color: 0x5f8fb5,             // slot 3 — pale cyan-steel
    emissive: 0x7df0c4,          // slot 4
    emissiveIntensity: 1.8,      // top of the 1.2-1.8 spec band ("brighter than glade")
    roughness: 0.22, metalness: 0.12,
    flatShading: true,
    transparent: true, opacity: 0.95,
  });
  const bodyInst = new THREE.InstancedMesh(bodyGeo, bodyMat, SPIRES);
  const tipsInst = new THREE.InstancedMesh(tipsGeo, tipsMat, SPIRES);
  tipsInst.layers.enable(BLOOM_LAYER);

  // Arrange in a 140° arc opening toward the room entry (south-ish, -z side).
  const arcStart = Math.PI * 0.7;    // ~126°
  const arcSpan  = Math.PI * 0.78;   // ~140°
  for (let i = 0; i < SPIRES; i++) {
    const t = SPIRES > 1 ? i / (SPIRES - 1) : 0.5;
    const angle = arcStart + arcSpan * t;
    const r = 14 + rand() * 5;       // 14..19u from room center
    const lx = Math.cos(angle) * r;
    const lz = Math.sin(angle) * r;
    const sy = 1.0 + rand() * 0.5;
    const baseY = 1.2 * sy;          // half body height
    dummy.position.set(cx + lx, baseY, cz + lz);
    dummy.scale.set(0.95 + rand() * 0.3, sy, 0.95 + rand() * 0.3);
    dummy.rotation.set(
      (rand() - 0.5) * 0.15,
      rand() * Math.PI * 2,
      (rand() - 0.5) * 0.15,
    );
    dummy.updateMatrix();
    bodyInst.setMatrixAt(i, dummy.matrix);
    tipsInst.setMatrixAt(i, dummy.matrix);
  }
  bodyInst.instanceMatrix.needsUpdate = true;
  tipsInst.instanceMatrix.needsUpdate = true;
  bodyInst.userData.roomId = 'crystalchoir';
  tipsInst.userData.roomId = 'crystalchoir';
  group.add(bodyInst); group.add(tipsInst);
  _track(bodyGeo); _track(tipsGeo); _track(bodyMat); _track(tipsMat);

  // Slot-3 facet shards on the floor around the arc — atmosphere only.
  const SHARDS = 16;
  const shardGeo = new THREE.OctahedronGeometry(0.32, 0);
  const shardMat = new THREE.MeshStandardMaterial({
    color: 0x5f8fb5,             // slot 3
    emissive: 0x5f8fb5,
    emissiveIntensity: 0.8,
    roughness: 0.3, metalness: 0.1,
    flatShading: true,
    transparent: true, opacity: 0.85,
  });
  const shardInst = new THREE.InstancedMesh(shardGeo, shardMat, SHARDS);
  shardInst.layers.enable(BLOOM_LAYER);
  for (let i = 0; i < SHARDS; i++) {
    const angle = rand() * Math.PI * 2;
    const r = 8 + rand() * 12;
    const lx = Math.cos(angle) * r;
    const lz = Math.sin(angle) * r;
    const s  = 0.4 + rand() * 0.7;
    dummy.position.set(cx + lx, 0.18 + rand() * 0.25, cz + lz);
    dummy.scale.setScalar(s);
    dummy.rotation.set(rand() * Math.PI, rand() * Math.PI * 2, rand() * Math.PI);
    dummy.updateMatrix();
    shardInst.setMatrixAt(i, dummy.matrix);
  }
  shardInst.instanceMatrix.needsUpdate = true;
  shardInst.userData.roomId = 'crystalchoir';
  group.add(shardInst);
  _track(shardGeo); _track(shardMat);

  return { room: 'crystalchoir', spires: SPIRES, shards: SHARDS };
}

/**
 * Amber Labyrinth — dense amber-toned crystal walls + slot-5 "pollen" fog.
 * Center (130, 0), bounds 55×40u. Density ~4× the glade per-cluster count.
 * "Low purple fog" in the task copy = pollen-tinted = slot-5 (advisor pin).
 * No purple hex literal appears here — palette discipline.
 */
function _buildAmberLabyrinthDecor(group) {
  const room = FOREST_ROOMS.amberlabyrinth;
  const cx = room.center.x, cz = room.center.z;
  const rand = _mulberry32(0xC0FFE4);
  const dummy = new THREE.Object3D();

  // Dense amber-toned crystal walls — body slot-1 (stone), tips slot-6 amber.
  // 4× glade density per-cluster: target ~72 instances vs glade's 6-10 per
  // cluster. Lay them out as 4 walls (N/S/E/W) of the room with ~18 each,
  // leaving doorway gaps mid-edge for player traversal.
  const WALL_PER_SIDE = 18;
  const TOTAL = WALL_PER_SIDE * 4;
  const bodyGeo = new THREE.CylinderGeometry(0.20, 0.32, 1.4, 6, 1, false);
  const tipsGeo = new THREE.ConeGeometry(0.20, 0.5, 6);
  tipsGeo.translate(0, 0.95, 0);   // body half 0.7 + cone half 0.25

  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x1a1e22,             // slot 1 — stone-trunk charcoal (denser than glade)
    roughness: 0.9, metalness: 0.04,
    flatShading: true,
  });
  const tipsMat = new THREE.MeshStandardMaterial({
    color: 0x5f8fb5,             // slot 3 — facet
    emissive: 0xf5a300,          // slot 6 — amber idle warm orange
    emissiveIntensity: 1.6,      // within 1.4-2.0 amber spec band
    roughness: 0.25, metalness: 0.12,
    flatShading: true,
    transparent: true, opacity: 0.94,
  });
  const bodyInst = new THREE.InstancedMesh(bodyGeo, bodyMat, TOTAL);
  const tipsInst = new THREE.InstancedMesh(tipsGeo, tipsMat, TOTAL);
  tipsInst.layers.enable(BLOOM_LAYER);

  // 4 walls along the inside of the room bounds, with a 5u doorway in the
  // middle of each. Wall x/z extents: room is ±27.5u x ±20u from center.
  const halfX = 25;
  const halfZ = 18;
  const doorHalfWidth = 2.5;
  let ci = 0;
  // North + South walls (constant z = ±halfZ, x varies)
  for (const side of [-1, 1]) {
    for (let i = 0; i < WALL_PER_SIDE; i++) {
      const t = (i + 0.5) / WALL_PER_SIDE;       // 0..1 along wall
      let lx = -halfX + t * (halfX * 2);
      // Skip the doorway gap (push toward nearest endpoint if inside gap).
      if (Math.abs(lx) < doorHalfWidth) {
        lx = lx >= 0 ? doorHalfWidth + 0.2 : -doorHalfWidth - 0.2;
      }
      const jitter = (rand() - 0.5) * 0.8;
      const lz = side * halfZ + jitter;
      const sy = 0.85 + rand() * 1.05;
      dummy.position.set(cx + lx, 0.7 * sy, cz + lz);
      dummy.scale.set(0.8 + rand() * 0.4, sy, 0.8 + rand() * 0.4);
      dummy.rotation.set((rand() - 0.5) * 0.3, rand() * Math.PI * 2, (rand() - 0.5) * 0.3);
      dummy.updateMatrix();
      bodyInst.setMatrixAt(ci, dummy.matrix);
      tipsInst.setMatrixAt(ci, dummy.matrix);
      ci++;
    }
  }
  // East + West walls (constant x = ±halfX, z varies)
  for (const side of [-1, 1]) {
    for (let i = 0; i < WALL_PER_SIDE; i++) {
      const t = (i + 0.5) / WALL_PER_SIDE;
      let lz = -halfZ + t * (halfZ * 2);
      if (Math.abs(lz) < doorHalfWidth) {
        lz = lz >= 0 ? doorHalfWidth + 0.2 : -doorHalfWidth - 0.2;
      }
      const jitter = (rand() - 0.5) * 0.8;
      const lx = side * halfX + jitter;
      const sy = 0.85 + rand() * 1.05;
      dummy.position.set(cx + lx, 0.7 * sy, cz + lz);
      dummy.scale.set(0.8 + rand() * 0.4, sy, 0.8 + rand() * 0.4);
      dummy.rotation.set((rand() - 0.5) * 0.3, rand() * Math.PI * 2, (rand() - 0.5) * 0.3);
      dummy.updateMatrix();
      bodyInst.setMatrixAt(ci, dummy.matrix);
      tipsInst.setMatrixAt(ci, dummy.matrix);
      ci++;
    }
  }
  bodyInst.instanceMatrix.needsUpdate = true;
  tipsInst.instanceMatrix.needsUpdate = true;
  bodyInst.userData.roomId = 'amberlabyrinth';
  tipsInst.userData.roomId = 'amberlabyrinth';
  group.add(bodyInst); group.add(tipsInst);
  _track(bodyGeo); _track(tipsGeo); _track(bodyMat); _track(tipsMat);

  // Pollen fog motes — slot-5 (NOT purple) additive billboards drifting low.
  // Static placement, additive + low opacity reads as low-hanging haze under
  // the bloom pass without needing a real volumetric.
  const POLLEN = 60;
  const pollenGeo = new THREE.PlaneGeometry(0.55, 0.55);
  const pollenMat = new THREE.MeshBasicMaterial({
    map: fxTex('ring_arcane') || makeRuneRingTexture(),
    color: 0x3ecf9a,             // slot 5 — "pollen tinted" mint
    transparent: true, opacity: 0.30, side: THREE.DoubleSide,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pollenInst = new THREE.InstancedMesh(pollenGeo, pollenMat, POLLEN);
  for (let i = 0; i < POLLEN; i++) {
    const lx = (rand() * 2 - 1) * (halfX - 1);
    const lz = (rand() * 2 - 1) * (halfZ - 1);
    const y  = 0.4 + rand() * 1.2;
    const s  = 0.7 + rand() * 1.4;
    dummy.position.set(cx + lx, y, cz + lz);
    dummy.scale.set(s, s, 1);
    dummy.rotation.set(0, rand() * Math.PI * 2, 0);
    dummy.updateMatrix();
    pollenInst.setMatrixAt(i, dummy.matrix);
  }
  pollenInst.instanceMatrix.needsUpdate = true;
  pollenInst.userData.roomId = 'amberlabyrinth';
  group.add(pollenInst);
  _track(pollenGeo); _track(pollenMat);

  return { room: 'amberlabyrinth', walls: TOTAL, pollen: POLLEN };
}

/**
 * Bramble Maze (FE-V2) — thorny crystal brambles forming chokepoints.
 * Center (95, 80), bounds 50×50u. Theme: dense slot-2/slot-3 brambles
 * (short cylinders + tilted box clusters) with slot-4 mint glow at trail
 * intersections. No puzzle; intended as a relic-chest room. Hazard hook
 * flag `_brambleMazeHazard: true` stamped on the group's roomId-tagged
 * meshes so a future hazards agent can wire scratch DoT inside brambles.
 *
 * Palette discipline (locked):
 *   slot 1 #1a1e22 — charcoal stub bases
 *   slot 2 #2d3a55 — bramble mid blue-gray
 *   slot 3 #5f8fb5 — facet hi (bramble tips)
 *   slot 4 #7df0c4 — bio-glow mint (intersection accents, BLOOM_LAYER)
 *
 * Chest/key relic mechanic noted in the task brief is OUT OF SCOPE for
 * this agent (would need chest.js + a new key system, neither in our
 * file boundary). Decor + hazard hook + relic flag only — chest wiring
 * is a future ticket.
 */
function _buildBrambleMazeDecor(group) {
  const room = FOREST_ROOMS.bramblemaze;
  const cx = room.center.x, cz = room.center.z;
  const rand = _mulberry32(0xC0FFE5);
  const dummy = new THREE.Object3D();

  // Bramble cylinders — short thorny stubs forming chokepoints. Dense
  // along internal "walls" (3 internal partitions) + perimeter accent.
  const BRAMBLES = 64;
  const bramGeo = new THREE.CylinderGeometry(0.16, 0.28, 1.05, 6, 1, false);
  const bramMat = new THREE.MeshStandardMaterial({
    color: 0x2d3a55,            // slot 2 — bramble mid
    roughness: 0.92, metalness: 0.04,
    flatShading: true,
  });
  const bramInst = new THREE.InstancedMesh(bramGeo, bramMat, BRAMBLES);
  // Carve 3 internal partitions perpendicular to X axis at lz = ±14, 0,
  // each with a 4u doorway near a non-center offset (forces threading).
  const partitionRows = [-14, 0, 14];
  const halfX = 22;
  const halfZ = 22;
  let bi = 0;
  for (let r = 0; r < partitionRows.length && bi < BRAMBLES * 0.55; r++) {
    const rowZ = partitionRows[r];
    const doorCenter = (r === 1) ? 6 : (r === 0 ? -6 : 8); // staggered doorways
    const doorHalfWidth = 2.5;
    const COUNT_PER_ROW = 12;
    for (let i = 0; i < COUNT_PER_ROW && bi < BRAMBLES; i++) {
      const t = (i + 0.5) / COUNT_PER_ROW;
      let lx = -halfX + t * halfX * 2;
      // Skip the doorway gap
      if (Math.abs(lx - doorCenter) < doorHalfWidth) {
        lx = (lx < doorCenter) ? doorCenter - doorHalfWidth - 0.3 : doorCenter + doorHalfWidth + 0.3;
      }
      const jitter = (rand() - 0.5) * 0.6;
      const sy = 0.9 + rand() * 0.7;
      dummy.position.set(cx + lx, 0.525 * sy, cz + rowZ + jitter);
      dummy.scale.set(0.85 + rand() * 0.3, sy, 0.85 + rand() * 0.3);
      // Aggressive tilt for thorny silhouette
      dummy.rotation.set((rand() - 0.5) * 0.5, rand() * Math.PI * 2, (rand() - 0.5) * 0.5);
      dummy.updateMatrix();
      bramInst.setMatrixAt(bi, dummy.matrix);
      bi++;
    }
  }
  // Fill remaining slots with scattered perimeter brambles
  while (bi < BRAMBLES) {
    const angle = rand() * Math.PI * 2;
    const r = 18 + rand() * 4;
    const lx = Math.cos(angle) * r;
    const lz = Math.sin(angle) * r;
    const sy = 0.85 + rand() * 0.6;
    dummy.position.set(cx + lx, 0.525 * sy, cz + lz);
    dummy.scale.set(0.85 + rand() * 0.3, sy, 0.85 + rand() * 0.3);
    dummy.rotation.set((rand() - 0.5) * 0.5, rand() * Math.PI * 2, (rand() - 0.5) * 0.5);
    dummy.updateMatrix();
    bramInst.setMatrixAt(bi, dummy.matrix);
    bi++;
  }
  bramInst.instanceMatrix.needsUpdate = true;
  bramInst.userData.roomId = 'bramblemaze';
  bramInst.userData._brambleMazeHazard = true;   // hazard hook (future DoT)
  bramInst.userData._brambleRelicChest = true;   // relic-chest room flag (future)
  group.add(bramInst);
  _track(bramGeo); _track(bramMat);

  // Tilted box clusters — sharp thorn-shape accents at chokepoint corners.
  // Reuses the bramble mid color (slot 2) so the silhouette reads consistent.
  const BOXES = 18;
  const boxGeo = new THREE.BoxGeometry(0.22, 0.55, 0.22);
  const boxMat = new THREE.MeshStandardMaterial({
    color: 0x2d3a55,            // slot 2 — same as brambles
    roughness: 0.95, metalness: 0.05,
    flatShading: true,
  });
  const boxInst = new THREE.InstancedMesh(boxGeo, boxMat, BOXES);
  for (let i = 0; i < BOXES; i++) {
    // Cluster near doorway choke points (staggered along x near rowZ partitions)
    const rowIdx = i % 3;
    const lz = partitionRows[rowIdx] + (rand() - 0.5) * 1.8;
    const lx = (rand() * 2 - 1) * (halfX - 2);
    const sy = 1.0 + rand() * 0.8;
    dummy.position.set(cx + lx, 0.275 * sy, cz + lz);
    dummy.scale.set(0.9 + rand() * 0.5, sy, 0.9 + rand() * 0.5);
    dummy.rotation.set((rand() - 0.5) * 0.7, rand() * Math.PI * 2, (rand() - 0.5) * 0.7);
    dummy.updateMatrix();
    boxInst.setMatrixAt(i, dummy.matrix);
  }
  boxInst.instanceMatrix.needsUpdate = true;
  boxInst.userData.roomId = 'bramblemaze';
  boxInst.userData._brambleMazeHazard = true;
  group.add(boxInst);
  _track(boxGeo); _track(boxMat);

  // Mint glow accents at trail intersections — slot 4 bio-glow primary,
  // additive billboards. 8 dots at the doorway gaps + center.
  const ACCENTS = 8;
  const accentGeo = new THREE.PlaneGeometry(0.6, 0.6);
  const accentMat = new THREE.MeshBasicMaterial({
    map: fxTex('ring_arcane') || makeRuneRingTexture(),
    color: 0x7df0c4,             // slot 4 — mint
    transparent: true, opacity: 0.65, side: THREE.DoubleSide,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const accentInst = new THREE.InstancedMesh(accentGeo, accentMat, ACCENTS);
  accentInst.layers.enable(BLOOM_LAYER);
  // Place 6 at doorway gaps (2 per partition row, paired around the gap)
  // and 2 at the room center.
  const accentSpots = [
    { x: -6 - 2.5,  z: -14 }, { x: -6 + 2.5,  z: -14 },
    { x:  6 - 2.5,  z:   0 }, { x:  6 + 2.5,  z:   0 },
    { x:  8 - 2.5,  z:  14 }, { x:  8 + 2.5,  z:  14 },
    { x:  0,        z:   0 }, { x:  0,        z:   8 },
  ];
  for (let i = 0; i < ACCENTS; i++) {
    const sp = accentSpots[i];
    const s = 0.8 + rand() * 0.5;
    dummy.position.set(cx + sp.x, 0.15, cz + sp.z);
    dummy.scale.set(s, s, 1);
    dummy.rotation.set(-Math.PI / 2, 0, rand() * Math.PI * 2);
    dummy.updateMatrix();
    accentInst.setMatrixAt(i, dummy.matrix);
  }
  accentInst.instanceMatrix.needsUpdate = true;
  accentInst.userData.roomId = 'bramblemaze';
  group.add(accentInst);
  _track(accentGeo); _track(accentMat);

  return { room: 'bramblemaze', brambles: BRAMBLES, boxes: BOXES, accents: ACCENTS };
}

/**
 * Mossroot Hollow (FE-V2) — ancient root system, low ceiling feel.
 * Center (0, -140), bounds 70×60u. Theme: slot-1 charcoal floor accents +
 * slot-4/slot-5 bio-glow root veins along ground. Mossy root arches
 * (TorusKnot) form a low canopy feel. Hosts the mossroot_pulse puzzle.
 *
 * Palette (locked):
 *   slot 1 #1a1e22 — charcoal floor splats
 *   slot 4 #7df0c4 — bio-glow primary mint (root vein lines)
 *   slot 5 #3ecf9a — bio-glow secondary (pulsing arch crowns)
 */
function _buildMossrootDecor(group) {
  const room = FOREST_ROOMS.mossroot;
  const cx = room.center.x, cz = room.center.z;
  const rand = _mulberry32(0xC0FFE6);
  const dummy = new THREE.Object3D();

  // Slot-1 charcoal floor splats — low albedo discs sprinkled across the
  // floor for the "ancient stone with moss" feel. Bloom OFF.
  const SPLATS = 22;
  const splatGeo = new THREE.PlaneGeometry(1.0, 1.0);
  const splatMat = new THREE.MeshStandardMaterial({
    color: 0x1a1e22,            // slot 1 — charcoal
    roughness: 0.98, metalness: 0.02,
    transparent: true, opacity: 0.65,
    flatShading: true,
  });
  const splatInst = new THREE.InstancedMesh(splatGeo, splatMat, SPLATS);
  for (let i = 0; i < SPLATS; i++) {
    const lx = (rand() * 2 - 1) * 30;  // ±30 inside 70u-wide bounds
    const lz = (rand() * 2 - 1) * 25;
    const s = 1.4 + rand() * 2.6;
    dummy.position.set(cx + lx, -0.04, cz + lz);
    dummy.scale.set(s, s, 1);
    dummy.rotation.set(-Math.PI / 2, 0, rand() * Math.PI * 2);
    dummy.updateMatrix();
    splatInst.setMatrixAt(i, dummy.matrix);
  }
  splatInst.instanceMatrix.needsUpdate = true;
  splatInst.userData.roomId = 'mossroot';
  group.add(splatInst);
  _track(splatGeo); _track(splatMat);

  // Root arches — TorusKnot for the "thick gnarled root spine" silhouette.
  // 6 arches arranged around the room, varying scale + tilt. Slot-2 base
  // body color, slot-5 emissive on a tighter accent torus for the
  // "pulsing bio-glow along root spine" read. (Single-pulse via emissive
  // intensity — no per-frame animation here; the bloom flicker handles motion.)
  const ARCHES = 6;
  const archBodyGeo = new THREE.TorusKnotGeometry(1.4, 0.22, 48, 8, 2, 3);
  const archBodyMat = new THREE.MeshStandardMaterial({
    color: 0x2d3a55,            // slot 2 — bramble mid (base)
    roughness: 0.88, metalness: 0.06,
    flatShading: true,
  });
  const archBodyInst = new THREE.InstancedMesh(archBodyGeo, archBodyMat, ARCHES);
  const archGlowGeo = new THREE.TorusKnotGeometry(1.42, 0.07, 48, 8, 2, 3);
  const archGlowMat = new THREE.MeshStandardMaterial({
    color: 0x3ecf9a,            // slot 5 — bio-glow secondary
    emissive: 0x3ecf9a,
    emissiveIntensity: 1.6,     // top end of bio-glow band
    roughness: 0.32, metalness: 0.08,
    flatShading: true,
    transparent: true, opacity: 0.9,
  });
  const archGlowInst = new THREE.InstancedMesh(archGlowGeo, archGlowMat, ARCHES);
  archGlowInst.layers.enable(BLOOM_LAYER);
  for (let i = 0; i < ARCHES; i++) {
    const angle = (i / ARCHES) * Math.PI * 2 + rand() * 0.2;
    const r = 18 + rand() * 6;
    const lx = Math.cos(angle) * r;
    const lz = Math.sin(angle) * r;
    const sy = 0.9 + rand() * 0.5;
    dummy.position.set(cx + lx, 1.2 * sy, cz + lz);
    dummy.scale.setScalar(0.9 + rand() * 0.4);
    // Tilt arches outward + random spin so each knot reads unique.
    dummy.rotation.set(rand() * Math.PI, rand() * Math.PI * 2, (rand() - 0.5) * 0.4);
    dummy.updateMatrix();
    archBodyInst.setMatrixAt(i, dummy.matrix);
    archGlowInst.setMatrixAt(i, dummy.matrix);
  }
  archBodyInst.instanceMatrix.needsUpdate = true;
  archGlowInst.instanceMatrix.needsUpdate = true;
  archBodyInst.userData.roomId = 'mossroot';
  archGlowInst.userData.roomId = 'mossroot';
  group.add(archBodyInst); group.add(archGlowInst);
  _track(archBodyGeo); _track(archBodyMat); _track(archGlowGeo); _track(archGlowMat);

  // Root vein lines along ground — thin slot-4 emissive box "ribbons" running
  // radially from center to perimeter. 14 lines, each tilted to feel organic.
  // Bloom-tagged so the mint reads under the bloom pass.
  const VEINS = 14;
  const veinGeo = new THREE.BoxGeometry(0.12, 0.03, 5.0);   // long thin slab
  const veinMat = new THREE.MeshStandardMaterial({
    color: 0x7df0c4,            // slot 4 — bio-glow primary
    emissive: 0x7df0c4,
    emissiveIntensity: 1.4,
    roughness: 0.5, metalness: 0.1,
    flatShading: true,
    transparent: true, opacity: 0.85,
  });
  const veinInst = new THREE.InstancedMesh(veinGeo, veinMat, VEINS);
  veinInst.layers.enable(BLOOM_LAYER);
  for (let i = 0; i < VEINS; i++) {
    const angle = (i / VEINS) * Math.PI * 2;
    const r = 4 + rand() * 16;        // start radius from center
    const lx = Math.cos(angle) * r;
    const lz = Math.sin(angle) * r;
    const len = 3.0 + rand() * 4.0;
    dummy.position.set(cx + lx, 0.04, cz + lz);
    dummy.scale.set(1, 1, len / 5.0);
    dummy.rotation.set(0, angle + Math.PI / 2 + (rand() - 0.5) * 0.4, 0);
    dummy.updateMatrix();
    veinInst.setMatrixAt(i, dummy.matrix);
  }
  veinInst.instanceMatrix.needsUpdate = true;
  veinInst.userData.roomId = 'mossroot';
  group.add(veinInst);
  _track(veinGeo); _track(veinMat);

  return { room: 'mossroot', splats: SPLATS, arches: ARCHES, veins: VEINS };
}

/**
 * Glowfen Marshes (FE-V2) — glowing fen/bog with floating wisp lights.
 * Center (-160, 0), bounds 70×60u. Theme: damp atmospheric feel, slot-4
 * bio-glow dominant. Stepping-stone pads (slot-2), floating wisps
 * (slot-4 InstancedMesh), reed clusters (slot-5).
 *
 * NO puzzle (relic/lore room for v1). Hazard hook flag
 * `_glowfenHazard: true` stamped on roomId-tagged meshes for a future
 * water-DoT system to consume. Wisp lantern weapon is REGISTRY-ready
 * but has no in-game unlock path in this version (no puzzle to award it).
 *
 * Palette (locked):
 *   slot 2 #2d3a55 — stone stepping pads
 *   slot 4 #7df0c4 — bio-glow wisp lights (BLOOM_LAYER) + reed glow tips
 *   slot 5 #3ecf9a — reed cluster bodies
 */
function _buildGlowfenDecor(group) {
  const room = FOREST_ROOMS.glowfen;
  const cx = room.center.x, cz = room.center.z;
  const rand = _mulberry32(0xC0FFE7);
  const dummy = new THREE.Object3D();

  // Stepping-stone pads — flat slot-2 discs sprinkled across the marsh.
  // Bloom OFF (these are dim wet stones, not glow).
  const PADS = 14;
  const padGeo = new THREE.CylinderGeometry(1.0, 1.1, 0.18, 8, 1, false);
  const padMat = new THREE.MeshStandardMaterial({
    color: 0x2d3a55,            // slot 2 — wet stone
    roughness: 0.92, metalness: 0.05,
    flatShading: true,
  });
  const padInst = new THREE.InstancedMesh(padGeo, padMat, PADS);
  for (let i = 0; i < PADS; i++) {
    const lx = (rand() * 2 - 1) * 32;   // ±32 inside 70u-wide bounds
    const lz = (rand() * 2 - 1) * 25;
    const s = 1.0 + rand() * 1.4;
    dummy.position.set(cx + lx, 0.08, cz + lz);
    dummy.scale.set(s, 1, s);
    dummy.rotation.set((rand() - 0.5) * 0.2, rand() * Math.PI * 2, (rand() - 0.5) * 0.2);
    dummy.updateMatrix();
    padInst.setMatrixAt(i, dummy.matrix);
  }
  padInst.instanceMatrix.needsUpdate = true;
  padInst.userData.roomId = 'glowfen';
  padInst.userData._glowfenHazard = true;     // future water-DoT consumer
  group.add(padInst);
  _track(padGeo); _track(padMat);

  // Floating wisp lights — InstancedMesh of slot-4 mint orbs, 10 dots.
  // Registered on the shared _bobbers slot so the ambient animation loop
  // applies per-instance Y bob (matches task brief "slow bobbing"). Forest
  // stage doesn't currently register other _bobbers, so single-slot reuse
  // is safe; if a future room wants its own bob, lift to an array later.
  const WISPS = 10;                          // within spec 8-12
  const wispGeo = new THREE.IcosahedronGeometry(0.18, 0);
  const wispMat = new THREE.MeshBasicMaterial({
    color: 0x7df0c4,            // slot 4 — bio-glow primary
    transparent: true, opacity: 0.85,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const wispInst = new THREE.InstancedMesh(wispGeo, wispMat, WISPS);
  wispInst.layers.enable(BLOOM_LAYER);
  const wispBaseY = new Array(WISPS);
  const wispPhase = new Array(WISPS);
  const wispAmp   = new Array(WISPS);
  const wispFreq  = new Array(WISPS);
  for (let i = 0; i < WISPS; i++) {
    const lx = (rand() * 2 - 1) * 28;
    const lz = (rand() * 2 - 1) * 22;
    const y = 0.9 + rand() * 1.4;             // bob band center
    const s = 0.8 + rand() * 0.9;
    dummy.position.set(cx + lx, y, cz + lz);
    dummy.scale.setScalar(s);
    dummy.rotation.set(rand() * Math.PI, rand() * Math.PI * 2, rand() * Math.PI);
    dummy.updateMatrix();
    wispInst.setMatrixAt(i, dummy.matrix);
    wispBaseY[i] = y;
    wispPhase[i] = rand() * Math.PI * 2;
    wispAmp[i]   = 0.22 + rand() * 0.18;       // ±0.22-0.40u bob
    wispFreq[i]  = 1.2 + rand() * 0.8;         // 1.2-2.0 rad/s
  }
  wispInst.instanceMatrix.needsUpdate = true;
  wispInst.userData.roomId = 'glowfen';
  wispInst.userData._glowfenHazard = true;
  group.add(wispInst);
  _track(wispGeo); _track(wispMat);
  // Register on the shared bob slot. _animLoop reads {mesh, baseY, phase, amp, freq}.
  _bobbers = { mesh: wispInst, baseY: wispBaseY, phase: wispPhase, amp: wispAmp, freq: wispFreq };

  // Reed clusters — slot-5 thin tall cylinders gathered in 6 clumps.
  // 4-6 reeds per cluster = 24 instances total. Bloom-tagged.
  const REED_TOTAL = 28;
  const reedGeo = new THREE.CylinderGeometry(0.06, 0.10, 1.6, 5, 1, false);
  const reedMat = new THREE.MeshStandardMaterial({
    color: 0x3ecf9a,            // slot 5 — bio-glow secondary
    emissive: 0x7df0c4,         // slot 4 emissive — tips glow
    emissiveIntensity: 1.2,     // bottom of bio-glow band (subtle)
    roughness: 0.6, metalness: 0.1,
    flatShading: true,
    transparent: true, opacity: 0.92,
  });
  const reedInst = new THREE.InstancedMesh(reedGeo, reedMat, REED_TOTAL);
  reedInst.layers.enable(BLOOM_LAYER);
  // 6 clumps × ~5 reeds each
  const CLUMPS = 6;
  let ri = 0;
  for (let c = 0; c < CLUMPS && ri < REED_TOTAL; c++) {
    const angle = (c / CLUMPS) * Math.PI * 2 + rand() * 0.4;
    const r = 14 + rand() * 14;
    const ccx = Math.cos(angle) * r;
    const ccz = Math.sin(angle) * r;
    const reedsHere = 4 + ((rand() * 3) | 0); // 4..6
    for (let k = 0; k < reedsHere && ri < REED_TOTAL; k++) {
      const jx = (rand() - 0.5) * 1.2;
      const jz = (rand() - 0.5) * 1.2;
      const sy = 0.85 + rand() * 0.5;
      dummy.position.set(cx + ccx + jx, 0.8 * sy, cz + ccz + jz);
      dummy.scale.set(0.9 + rand() * 0.4, sy, 0.9 + rand() * 0.4);
      dummy.rotation.set((rand() - 0.5) * 0.25, rand() * Math.PI * 2, (rand() - 0.5) * 0.25);
      dummy.updateMatrix();
      reedInst.setMatrixAt(ri, dummy.matrix);
      ri++;
    }
  }
  reedInst.instanceMatrix.needsUpdate = true;
  reedInst.userData.roomId = 'glowfen';
  reedInst.userData._glowfenHazard = true;
  group.add(reedInst);
  _track(reedGeo); _track(reedMat);

  return { room: 'glowfen', pads: PADS, wisps: WISPS, reeds: REED_TOTAL };
}

// ── Iter 14: real CC0 GLB scatter helper ────────────────────────────────────
// Drops N clones of the given asset key around the play ring as authored
// (un-instanced) meshes. cloneCached gives each a fresh material instance,
// but Lousberg gravestone/bone kits are tiny (24-30 KB) so the draw-call
// cost stays small. Returns the array of placed clones (caller adds them
// to `group` itself isn't required since we add inline).
function _scatterGLB(group, key, count, rMin, rMax, scaleRange, biasPow = 1.6) {
  let placed = 0;
  for (let i = 0; i < count; i++) {
    const clone = cloneCached(key);
    if (!clone) continue;
    const { x, z } = _scatterRing(rMin, rMax, biasPow);
    const s = scaleRange[0] + Math.random() * (scaleRange[1] - scaleRange[0]);
    clone.scale.setScalar(s);
    clone.position.set(x, 0, z);
    clone.rotation.y = Math.random() * Math.PI * 2;
    clone.traverse(o => {
      if (o.isMesh) {
        o.castShadow = false;          // decor — skip shadow casting for perf
        o.receiveShadow = true;
      }
    });
    group.add(clone);
    placed++;
  }
  return placed;
}

function _buildTwilightDecor(group) {
  // CURSED ARISTOCRACY — overgrown courtyard reclaimed by rot.
  // Contract: docs/TWILIGHT_VISUAL_STYLE.md (8-color palette, hedge maze,
  // ruined fountains, bone-white pillar fragments, ground runes). Hedges are
  // topiary silhouettes (NOT cubes) built from a merged stacked-cluster
  // BufferGeometry; placed via deterministic mulberry32(0xBADBEE) RNG so
  // tools/regen-twilight-hotspots.mjs can replay the same hedge layout and
  // drop fountain hotspots at the dead-ends.
  //
  // Palette slots used here:
  //   slot 1 #1a0a2e (hedge base shadow)
  //   slot 2 #2d1547 (hedge mid + rune tint)
  //   slot 3 #7a5fa5 (hedge highlight via leaf-noise mix)
  //   slot 4 #e8d4b0 (bone-white pillars + fountain rims)
  // Fountain liquid (slot 5/6) is owned by Phase-2 twilightFountains.js;
  // placeholders here are stone rim + dish only, NO emissive.

  // ── deterministic RNG (mirrors forest A1 fix) ───────────────────────────
  // mulberry32 seeded 0xBADBEE. Same algorithm + initial state used by
  // tools/regen-twilight-hotspots.mjs so the hedge layout we derive here is
  // byte-identical to the one the regen tool replays when computing fountain
  // dead-end positions. Don't reorder rand() calls without updating the tool.
  let _rngState = 0xBADBEE >>> 0;
  function rand() {
    _rngState = (_rngState + 0x6D2B79F5) >>> 0;
    let t = _rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function scatterRing(rMin, rMax, biasPow = 1.6) {
    const a = rand() * Math.PI * 2;
    const u = Math.pow(rand(), 1 / biasPow);
    const r = rMin + (rMax - rMin) * u;
    return { x: Math.cos(a) * r, z: Math.sin(a) * r, a };
  }

  const dummy = new THREE.Object3D();

  // ── 1) hedge segments — deterministic layout ────────────────────────────
  // Per-hedge RNG draw order (MUST match tools/regen-twilight-hotspots.mjs
  // deriveHedges() byte-for-byte):
  //   HEDGE_COUNT: 1 draw  (4..6)
  //   per hedge:
  //     1) angle around ring (base step + jitter)  — 1 draw for jitter
  //     2) radius   18..50                          — 1 draw
  //     3) length   3..6                            — 1 draw
  //     4) tangentJitter (-0.35..0.35 rad)          — 1 draw
  //     5) colorVariant (0/1) for slot 1 vs slot 2  — 1 draw
  //
  // Each hedge is a single straight segment whose long axis lies tangent to
  // the ring at (cx, cz). The two endpoints (cx ± (L/2) * tangent) are the
  // "dead-ends" where fountains can sit.
  const HEDGE_COUNT = 4 + ((rand() * 3) | 0); // 4..6
  const hedgeStep = (Math.PI * 2) / HEDGE_COUNT;
  const hedgeJitterMax = hedgeStep * 0.30;
  const hedges = [];
  for (let h = 0; h < HEDGE_COUNT; h++) {
    const angle = h * hedgeStep + (rand() - 0.5) * 2 * hedgeJitterMax;
    const radius = 22 + rand() * 26;     // 22..48 (inside [18,50] with margin for length)
    const length = 3 + rand() * 3;       // 3..6u
    const tanJit = (rand() - 0.5) * 0.7; // ±0.35 rad off pure tangent
    const colorVariant = rand() < 0.5 ? 0 : 1;
    // Tangent direction at (angle): perpendicular to radial.
    const tangentAngle = angle + Math.PI / 2 + tanJit;
    const cx = Math.cos(angle) * radius;
    const cz = Math.sin(angle) * radius;
    const tx = Math.cos(tangentAngle);
    const tz = Math.sin(tangentAngle);
    // Endpoints (dead-ends) — pushed slightly past the hedge end so a
    // fountain placed there doesn't clip the topiary mesh.
    const halfL = length / 2;
    hedges.push({
      cx, cz, angle, length, tangentAngle, tx, tz, colorVariant,
      end1: { x: cx + tx * (halfL + 1.6), z: cz + tz * (halfL + 1.6) },
      end2: { x: cx - tx * (halfL + 1.6), z: cz - tz * (halfL + 1.6) },
    });
  }

  // Hedge geometry — merged stacked-cluster silhouette (NOT a box). Spec:
  // "tall extruded irregular prism or a stacked-cluster silhouette so each
  // segment reads as topiary." We merge three jittered cylinders along a
  // unit X axis (length 1u, scaled per-instance) so the InstancedMesh of N
  // instances still costs one draw call but reads as bushy topiary.
  function makeTopiaryGeo() {
    // Build along +X axis, span [-0.5, +0.5], width Z = 1u, height Y = 1.5u.
    // We'll scale X per-instance by `length` to stretch.
    const lobes = [];
    const LOBE_N = 5;
    for (let i = 0; i < LOBE_N; i++) {
      const u = (i / (LOBE_N - 1));
      const lx = -0.5 + u;                    // -0.5..0.5
      const ly = 0.75 + (i % 2 === 0 ? 0.05 : -0.05); // slight up-down jiggle
      const lz = (i % 2 === 0 ? 0.05 : -0.05);
      const rTop = 0.42 + (i === 0 || i === LOBE_N - 1 ? -0.06 : 0.02);
      const rBot = 0.5;
      const h = 1.5;
      const lobe = new THREE.CylinderGeometry(rTop, rBot, h, 7, 1, false);
      lobe.translate(lx, ly - h / 2 + 0.75, lz); // center at y=0.75 (half-height)
      lobes.push(lobe);
    }
    // Manual merge — same pattern as forest tipsGeo.
    const merge = new THREE.BufferGeometry();
    let vc = 0;
    for (const p of lobes) vc += p.attributes.position.count;
    const pos = new Float32Array(vc * 3);
    const nrm = new Float32Array(vc * 3);
    let off = 0;
    for (const p of lobes) {
      const pp = p.attributes.position.array;
      const pn = p.attributes.normal ? p.attributes.normal.array : null;
      pos.set(pp, off);
      if (pn) nrm.set(pn, off);
      off += pp.length;
    }
    merge.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    merge.setAttribute('normal',   new THREE.BufferAttribute(nrm, 3));
    merge.computeBoundingSphere();
    for (const p of lobes) p.dispose();
    return merge;
  }
  const hedgeGeo = makeTopiaryGeo();
  // Use per-instance color (slot 1 base vs slot 2 mid) via InstancedMesh
  // instanceColor — varies hedge tint without spawning two materials.
  const hedgeMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,            // tinted per-instance
    roughness: 0.92, metalness: 0.0,
    flatShading: true,
  });
  const hedgeInst = new THREE.InstancedMesh(hedgeGeo, hedgeMat, HEDGE_COUNT);
  hedgeInst.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(HEDGE_COUNT * 3), 3,
  );
  const colSlot1 = new THREE.Color(0x1a0a2e);
  const colSlot2 = new THREE.Color(0x2d1547);
  for (let i = 0; i < hedges.length; i++) {
    const hg = hedges[i];
    dummy.position.set(hg.cx, 0, hg.cz);
    // Geo built along +X with length 1u → scale X by hg.length to stretch.
    // Height stays 1.5u (Y scale = 1). Thickness Z stays 1u per spec.
    dummy.scale.set(hg.length, 1, 1);
    dummy.rotation.set(0, -hg.tangentAngle, 0); // rotate around Y to align with tangent
    dummy.updateMatrix();
    hedgeInst.setMatrixAt(i, dummy.matrix);
    const c = hg.colorVariant === 0 ? colSlot1 : colSlot2;
    hedgeInst.setColorAt(i, c);
  }
  hedgeInst.instanceMatrix.needsUpdate = true;
  if (hedgeInst.instanceColor) hedgeInst.instanceColor.needsUpdate = true;
  group.add(hedgeInst);
  _track(hedgeGeo); _track(hedgeMat);

  // ── 2) bone-white stone pillar fragments ────────────────────────────────
  // Broken pillar bases scattered between hedges. Hex CylinderGeometry low-
  // poly, slot 4 bone white. Single InstancedMesh — these are simple shapes
  // (just stumps), so straight cylinders read as "broken stone column."
  const WALLS = 10;
  const wallGeo = new THREE.CylinderGeometry(0.45, 0.55, 0.9, 6, 1, false);
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0xe8d4b0,     // slot 4 bone white
    roughness: 0.88, metalness: 0.02,
    flatShading: true,
  });
  const wallInst = new THREE.InstancedMesh(wallGeo, wallMat, WALLS);
  for (let i = 0; i < WALLS; i++) {
    const { x, z } = scatterRing(20, 52, 1.4);
    const sy = 0.55 + rand() * 0.9; // 0.55..1.45 — broken at varied heights
    const sxz = 0.85 + rand() * 0.35;
    dummy.position.set(x, 0.45 * sy, z);
    dummy.scale.set(sxz, sy, sxz);
    dummy.rotation.set(
      (rand() - 0.5) * 0.30,        // slight lean (broken)
      rand() * Math.PI * 2,
      (rand() - 0.5) * 0.30,
    );
    dummy.updateMatrix();
    wallInst.setMatrixAt(i, dummy.matrix);
  }
  wallInst.instanceMatrix.needsUpdate = true;
  group.add(wallInst);
  _track(wallGeo); _track(wallMat);

  // ── 3) fountain placeholders — visual stone only, NO emissive ───────────
  // Phase-2 twilightFountains.js owns the liquid glow/pulse; this layer is
  // just the stone rim + concave dish so the player sees something there
  // before the Fountains runtime mounts. Read positions from the same dead-
  // end derivation the regen tool uses (we'd ideally read the JSON, but to
  // keep this self-contained for first-load before assets fetch we re-derive).
  const FOUNTAIN_COUNT = Math.min(8, Math.max(6, 6 + ((rand() * 3) | 0))); // 6..8
  // Build fountain mesh = rim (CylinderGeometry) + concave dish (inverted
  // ConeGeometry) merged into one geo, one InstancedMesh.
  const _rim = new THREE.CylinderGeometry(1.05, 1.15, 0.45, 14, 1, false);
  _rim.translate(0, 0.225, 0);          // rim sits 0..0.45
  const _dish = new THREE.ConeGeometry(0.95, 0.35, 14, 1, false);
  _dish.rotateX(Math.PI);                // invert → tip points down
  _dish.translate(0, 0.30, 0);          // dish nestles inside the rim
  const fountainGeo = (() => {
    const merge = new THREE.BufferGeometry();
    const parts = [_rim, _dish];
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
    return merge;
  })();
  _rim.dispose(); _dish.dispose();
  const fountainMat = new THREE.MeshStandardMaterial({
    color: 0xe8d4b0,     // slot 4 bone white (same as pillars — fountain rim)
    roughness: 0.85, metalness: 0.05,
    flatShading: true,
    // NO emissive — Phase-2 Fountains agent adds the glowing liquid layer.
  });
  const fountainInst = new THREE.InstancedMesh(fountainGeo, fountainMat, FOUNTAIN_COUNT);
  // Pick dead-end endpoints round-robin from hedges, then top up if short.
  // RNG draws here MUST match the regen tool's scatter pass for parity.
  const fountainSpots = [];
  const MIN_FOUNTAIN_DIST = 6;
  function farEnough(x, z) {
    for (const p of fountainSpots) {
      const dx = x - p.x, dz = z - p.z;
      if (dx * dx + dz * dz < MIN_FOUNTAIN_DIST * MIN_FOUNTAIN_DIST) return false;
    }
    return true;
  }
  function inFountainRing(x, z) {
    const r = Math.hypot(x, z);
    return r >= 18 && r <= 50;
  }
  // Pass 1: walk hedge endpoints in order, accept those that pass the gate.
  for (const hg of hedges) {
    for (const end of [hg.end1, hg.end2]) {
      if (fountainSpots.length >= FOUNTAIN_COUNT) break;
      if (!inFountainRing(end.x, end.z)) continue;
      if (!farEnough(end.x, end.z)) continue;
      // Variant draw — alternate by index for 50/50 split.
      const variant = fountainSpots.length % 2 === 0 ? 'blood' : 'light';
      const scale = +(0.9 + rand() * 0.25).toFixed(2); // 0.9..1.15
      fountainSpots.push({
        x: +end.x.toFixed(2),
        z: +end.z.toFixed(2),
        variant, scale,
        seed: 2000 + fountainSpots.length,
      });
    }
    if (fountainSpots.length >= FOUNTAIN_COUNT) break;
  }
  // Top up if hedge endpoints couldn't satisfy 6+ (e.g. min-dist rejection).
  let topUp = 0;
  while (fountainSpots.length < 6 && topUp++ < 300) {
    const { x, z } = scatterRing(20, 48, 1.3);
    if (!inFountainRing(x, z)) continue;
    if (!farEnough(x, z)) continue;
    const variant = fountainSpots.length % 2 === 0 ? 'blood' : 'light';
    fountainSpots.push({
      x: +x.toFixed(2),
      z: +z.toFixed(2),
      variant,
      scale: +(0.9 + rand() * 0.25).toFixed(2),
      seed: 2000 + fountainSpots.length,
    });
  }
  // Render placeholders (only as many as actually placed — InstancedMesh
  // count was set to FOUNTAIN_COUNT but extras stay at identity matrix at
  // origin; fix by setting unused slots far below the ground so they don't
  // show).
  for (let i = 0; i < FOUNTAIN_COUNT; i++) {
    if (i < fountainSpots.length) {
      const f = fountainSpots[i];
      dummy.position.set(f.x, 0, f.z);
      dummy.scale.setScalar(f.scale);
      dummy.rotation.set(0, rand() * Math.PI * 2, 0);
    } else {
      // Hide unused slot far below the play floor.
      dummy.position.set(0, -1000, 0);
      dummy.scale.setScalar(0.001);
      dummy.rotation.set(0, 0, 0);
    }
    dummy.updateMatrix();
    fountainInst.setMatrixAt(i, dummy.matrix);
  }
  fountainInst.instanceMatrix.needsUpdate = true;
  group.add(fountainInst);
  _track(fountainGeo); _track(fountainMat);

  // Stash on userData for the Fountains agent + tooling sanity.
  group.userData.fountainHotspots = fountainSpots;

  // ── 4) ground runes — subtle slot-2 rings, bloom OFF, opacity 0.18 ──────
  const RUNES = 12;
  const runeGeo = new THREE.PlaneGeometry(1.7, 1.7);
  const runeMat = new THREE.MeshBasicMaterial({
    map: fxTex('ring_arcane') || makeRuneRingTexture(),
    color: 0x2d1547,             // slot 2 mid purple
    transparent: true, opacity: 0.18, side: THREE.DoubleSide,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const runeInst = new THREE.InstancedMesh(runeGeo, runeMat, RUNES);
  for (let i = 0; i < RUNES; i++) {
    const { x, z } = scatterRing(18, 55, 1.5);
    const s = 0.7 + rand() * 1.1;
    dummy.position.set(x, -0.06, z);
    dummy.scale.set(s, s, 1);
    dummy.rotation.set(-Math.PI / 2, 0, rand() * Math.PI * 2);
    dummy.updateMatrix();
    runeInst.setMatrixAt(i, dummy.matrix);
  }
  runeInst.instanceMatrix.needsUpdate = true;
  group.add(runeInst);
  _track(runeGeo); _track(runeMat);

  return {
    hedges: HEDGE_COUNT,
    walls: WALLS,
    fountainPlaceholders: fountainSpots.length,
    runes: RUNES,
  };
}

function _buildCinderDecor(group) {
  // ROTTING BATTLEGROUND — mud-churned warzone scarred by a siege gone wrong.
  // Contract: docs/CINDER_VISUAL_STYLE.md (8-color palette, ruined catapult
  // obstacles, crater scars, ballista turret hotspots). This decor is
  // **additive** on top of the existing Eruption lava system (stageHazards.js
  // line 297+); we never touch _lavas or _spawnLavaNearHero.
  //
  // Palette slots used here (cinder, per style guide):
  //   slot 1 #0a0604 (charred black — siege engine wood, crater interior)
  //   slot 2 #3a342f (ash gray — catapult stone counterweight, crater rim)
  //   slot 3 #7a3d1a (rust orange dim — corroded metal bands on wood)
  //   slot 4 #ff5522 (ember orange hot — smoldering accents, ambient embers)
  //   slot 5 #d4c4a8 (ash white — ballista chassis highlight, wood platform)
  //   slot 6 #5a1810 (dried blood — crater interior overlay)
  // Slot 7/8 (ballista glow + repair aura) belong to Phase-2 Ballistas Agent.
  //
  // ── deterministic RNG (split-stream model — cleaner than twilight's single
  // tape, see advisor note). Four independent mulberry32 streams seeded off
  // the canonical 0xDADADA root so each concern (catapults / ballistas /
  // craters / embers) is replayable in isolation. The regen tool only needs
  // to drive the catapult + ballista streams in lock-step with this file;
  // craters and embers can be added/reordered without breaking the tool.
  function makeMulberry(seed) {
    let state = seed >>> 0;
    return function rand() {
      state = (state + 0x6D2B79F5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const SEED = 0xDADADA;
  const rngCatapult = makeMulberry(SEED);
  const rngBallista = makeMulberry((SEED ^ 0x10000) >>> 0);
  const rngCrater   = makeMulberry((SEED ^ 0x20000) >>> 0);
  const rngEmber    = makeMulberry((SEED ^ 0x30000) >>> 0);

  const dummy = new THREE.Object3D();

  // ── 1) ruined catapults — 3-4 composite obstacles at radius 22-45u ──────
  // Per-instance composite Group (NOT InstancedMesh — only 3-4 of them, the
  // per-instance arm tilt + child mesh palette differ enough that composite
  // groups are simpler than a custom merged geometry). Each catapult:
  //   - stone counterweight base (slot 2 BoxGeometry 1.5×1×1.5)
  //   - 2 wooden frame uprights (slot 1 BoxGeometry 0.3×3×0.3)
  //   - broken throwing arm (slot 1 BoxGeometry 0.4×0.4×2.5, tilted 30-50°)
  //   - 2 rust band torus accents (slot 3, optional)
  // Catapult positions drive the ballista clearance contract — the regen tool
  // replays this stream to know where the obstacles sit.
  // RNG draw order per catapult (regen tool MUST mirror byte-for-byte):
  //   COUNT: 1 draw   (3..4 via 3 + ((rand() * 2) | 0))
  //   per catapult:
  //     1) angle jitter   (rand() - 0.5) * 2 * jitterMax
  //     2) radius         22 + rand() * 23   → 22..45
  //     3) facing yaw     rand() * Math.PI * 2
  //     4) arm tilt       0.52 + rand() * 0.35  (30..50°, in radians)
  //     5) arm spin       rand() * Math.PI * 2
  const CATAPULT_COUNT = 3 + ((rngCatapult() * 2) | 0); // 3..4
  const catapultStep = (Math.PI * 2) / CATAPULT_COUNT;
  const catapultJitterMax = catapultStep * 0.25;
  const catapults = [];

  // Shared geometries — cached + tracked once, instanced via composite groups.
  const baseGeo  = new THREE.BoxGeometry(1.5, 1.0, 1.5);
  const uprightGeo = new THREE.BoxGeometry(0.3, 3.0, 0.3);
  const armGeo   = new THREE.BoxGeometry(0.4, 0.4, 2.5);
  const bandGeo  = new THREE.TorusGeometry(0.22, 0.05, 6, 12);
  const baseMat  = new THREE.MeshStandardMaterial({
    color: 0x3a342f, roughness: 0.95, metalness: 0.05, flatShading: true,
  });
  const woodMat  = new THREE.MeshStandardMaterial({
    color: 0x0a0604, roughness: 0.98, metalness: 0.0, flatShading: true,
  });
  const bandMat  = new THREE.MeshStandardMaterial({
    color: 0x7a3d1a, roughness: 0.85, metalness: 0.35, flatShading: true,
  });
  _track(baseGeo); _track(uprightGeo); _track(armGeo); _track(bandGeo);
  _track(baseMat); _track(woodMat); _track(bandMat);

  for (let c = 0; c < CATAPULT_COUNT; c++) {
    const angle = c * catapultStep + (rngCatapult() - 0.5) * 2 * catapultJitterMax;
    const radius = 22 + rngCatapult() * 23;      // 22..45
    const yaw = rngCatapult() * Math.PI * 2;
    const armTilt = 0.52 + rngCatapult() * 0.35; // 30..50° in radians
    const armSpin = rngCatapult() * Math.PI * 2; // rotation around vertical
    const cx = Math.cos(angle) * radius;
    const cz = Math.sin(angle) * radius;
    catapults.push({ x: cx, z: cz, yaw });

    const g = new THREE.Group();
    g.position.set(cx, 0, cz);
    g.rotation.y = yaw;

    // Stone counterweight base — sits on floor, centered.
    const baseMesh = new THREE.Mesh(baseGeo, baseMat);
    baseMesh.position.set(0, 0.5, 0);
    g.add(baseMesh);

    // Two wooden uprights flanking the base.
    const up1 = new THREE.Mesh(uprightGeo, woodMat);
    up1.position.set(0.55, 1.5, 0);
    g.add(up1);
    const up2 = new THREE.Mesh(uprightGeo, woodMat);
    up2.position.set(-0.55, 1.5, 0);
    g.add(up2);

    // Broken throwing arm — tilted at random ascending angle, appears to
    // have snapped mid-throw. Anchored at top of uprights and angled
    // forward-up.
    const arm = new THREE.Mesh(armGeo, woodMat);
    arm.position.set(0, 2.7, 0);
    arm.rotation.set(0, armSpin, armTilt); // tilt + random yaw spin
    g.add(arm);

    // Rust band accents on the uprights — two torus rings, decorative.
    const band1 = new THREE.Mesh(bandGeo, bandMat);
    band1.position.set(0.55, 1.0, 0);
    band1.rotation.x = Math.PI / 2;
    g.add(band1);
    const band2 = new THREE.Mesh(bandGeo, bandMat);
    band2.position.set(-0.55, 2.2, 0);
    band2.rotation.x = Math.PI / 2;
    g.add(band2);

    group.add(g);
  }

  // ── 2) ballista placeholders — 4-6 stone bases at radius 20-50u ─────────
  // Phase-2 Ballistas Agent renders runtime entities; we ship only the stone
  // ring + wood platform so the player sees SOMETHING there before activation.
  // NO emissive, NO bloom on placeholders. Positions chosen by rejection
  // sampling: must respect 8u min-distance from other ballistas AND 6u
  // min-distance from any catapult center. The regen tool mirrors this loop
  // exactly so the on-disk JSON aligns with the runtime placeholder layout.
  //
  // RNG draw order (regen tool mirrors):
  //   COUNT: 1 draw   (4..6 via 4 + ((rand() * 3) | 0))
  //   per accepted slot:
  //     a) angle  → 1 draw
  //     b) radius → 1 draw  via 20 + rand() * 30
  //     c) scale  → 1 draw  via 0.9 + rand() * 0.20
  //   rejected samples consume their (angle, radius) draws — caller must
  //   replay the same accept/reject decisions.
  const BALLISTA_TARGET = 4 + ((rngBallista() * 3) | 0); // 4..6
  const MIN_BALLISTA_DIST_SQ = 8 * 8;
  const MIN_CATAPULT_DIST_SQ = 6 * 6;
  const ballistaSpots = [];
  let ballistaGuard = 0;
  while (ballistaSpots.length < BALLISTA_TARGET && ballistaGuard++ < 400) {
    const a = rngBallista() * Math.PI * 2;
    const r = 20 + rngBallista() * 30; // 20..50
    const scale = +(0.9 + rngBallista() * 0.20).toFixed(2); // 0.90..1.10
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    // Reject if too close to another ballista.
    let bad = false;
    for (const p of ballistaSpots) {
      const dx = x - p.x, dz = z - p.z;
      if (dx * dx + dz * dz < MIN_BALLISTA_DIST_SQ) { bad = true; break; }
    }
    if (bad) continue;
    // Reject if too close to any catapult center.
    for (const cat of catapults) {
      const dx = x - cat.x, dz = z - cat.z;
      if (dx * dx + dz * dz < MIN_CATAPULT_DIST_SQ) { bad = true; break; }
    }
    if (bad) continue;
    ballistaSpots.push({
      x: +x.toFixed(2),
      z: +z.toFixed(2),
      scale,
      seed: 4000 + ballistaSpots.length,
      facing: Math.atan2(-z, -x), // toward play center, per style guide
    });
  }

  // Render placeholder bases — InstancedMesh of stone rim + wood platform.
  // Build a tiny merged geometry: short cylinder (rim) + flat disk (platform).
  const _rimGeo = new THREE.CylinderGeometry(0.55, 0.6, 0.3, 12, 1, false);
  _rimGeo.translate(0, 0.15, 0);
  const _platGeo = new THREE.CylinderGeometry(0.45, 0.45, 0.1, 12, 1, false);
  _platGeo.translate(0, 0.35, 0);
  function mergeParts(parts) {
    const merge = new THREE.BufferGeometry();
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
    return merge;
  }
  const ballistaGeo = mergeParts([_rimGeo, _platGeo]);
  _rimGeo.dispose(); _platGeo.dispose();
  // Per-instance color: rim slot 4 ash-white, platform slot 1 wood (we
  // merge into one mat with the ash-white tint since the platform is small;
  // wood platform reads from the slight luminance drop in the silhouette).
  const ballistaMat = new THREE.MeshStandardMaterial({
    color: 0xd4c4a8,       // slot 5 ash white
    roughness: 0.85, metalness: 0.05,
    flatShading: true,
    // NO emissive — Phase-2 Ballistas Agent owns slot 7/8 glow + repair aura.
  });
  const BALLISTA_SLOTS = Math.max(BALLISTA_TARGET, ballistaSpots.length);
  const ballistaInst = new THREE.InstancedMesh(ballistaGeo, ballistaMat, BALLISTA_SLOTS);
  for (let i = 0; i < BALLISTA_SLOTS; i++) {
    if (i < ballistaSpots.length) {
      const b = ballistaSpots[i];
      dummy.position.set(b.x, 0, b.z);
      dummy.scale.setScalar(b.scale);
      dummy.rotation.set(0, b.facing, 0);
    } else {
      // Hide unused slot far below the play floor.
      dummy.position.set(0, -1000, 0);
      dummy.scale.setScalar(0.001);
      dummy.rotation.set(0, 0, 0);
    }
    dummy.updateMatrix();
    ballistaInst.setMatrixAt(i, dummy.matrix);
  }
  ballistaInst.instanceMatrix.needsUpdate = true;
  group.add(ballistaInst);
  _track(ballistaGeo); _track(ballistaMat);
  group.userData.cinderBallistaHotspots = ballistaSpots;

  // ── 3) craters — 4-6 ground decals at radius 18-50u, NO bloom ───────────
  // Two nested planes per crater (slot 6 dried-blood interior + slot 2 ash
  // rim). Bloom OFF, additive OFF — these are scars, not active hazards.
  // Pure decoration: no slow-zone, no damage. Eruption lava owns the
  // dangerous floor mechanics on cinder.
  const CRATER_COUNT = 4 + ((rngCrater() * 3) | 0); // 4..6
  const interiorGeo = new THREE.PlaneGeometry(1, 1);
  const rimGeo = new THREE.PlaneGeometry(1, 1);
  const interiorMat = new THREE.MeshStandardMaterial({
    color: 0x5a1810,           // slot 6 dried blood
    emissive: 0x5a1810,
    emissiveIntensity: 0.18,   // ≤0.2 per style guide line 184 ("still warm")
    roughness: 1.0, metalness: 0,
    transparent: true, opacity: 0.6, side: THREE.DoubleSide,
    depthWrite: false,
  });
  const rimMat = new THREE.MeshStandardMaterial({
    color: 0x3a342f,           // slot 2 ash gray
    roughness: 1.0, metalness: 0,
    transparent: true, opacity: 0.55, side: THREE.DoubleSide,
    depthWrite: false,
  });
  const interiorInst = new THREE.InstancedMesh(interiorGeo, interiorMat, CRATER_COUNT);
  const rimInst = new THREE.InstancedMesh(rimGeo, rimMat, CRATER_COUNT);
  // NOTE: NO BLOOM_LAYER enable on either — craters must not compete with
  // live lava puddles for the player's eye.
  for (let i = 0; i < CRATER_COUNT; i++) {
    const a = rngCrater() * Math.PI * 2;
    const r = 18 + rngCrater() * 32; // 18..50
    const s = 2 + rngCrater() * 1.0; // 2..3u diameter
    const yawRot = rngCrater() * Math.PI * 2; // hide decal tile repeat
    const cx = Math.cos(a) * r;
    const cz = Math.sin(a) * r;
    // Inner blood plane — slightly above ground to avoid z-fight with floor.
    dummy.position.set(cx, -0.04, cz);
    dummy.scale.set(s * 0.7, s * 0.7, 1);
    dummy.rotation.set(-Math.PI / 2, 0, yawRot);
    dummy.updateMatrix();
    interiorInst.setMatrixAt(i, dummy.matrix);
    // Outer ash rim — wider, sits just below the inner decal.
    dummy.position.set(cx, -0.05, cz);
    dummy.scale.set(s, s, 1);
    dummy.rotation.set(-Math.PI / 2, 0, yawRot);
    dummy.updateMatrix();
    rimInst.setMatrixAt(i, dummy.matrix);
  }
  interiorInst.instanceMatrix.needsUpdate = true;
  rimInst.instanceMatrix.needsUpdate = true;
  // Order matters for transparency: rim first (under), interior second (over).
  group.add(rimInst); group.add(interiorInst);
  _track(interiorGeo); _track(rimGeo); _track(interiorMat); _track(rimMat);

  // ── 4) ambient embers / ash — ~30 small bloom-lit octahedrons ────────────
  // Slot 4 ember orange, low to ground, additive bloom feel. Optional gentle
  // bob via the same _bobbers slot used by forest crystals — clearArenaDecor
  // wipes the slot between stage swaps so reuse is safe.
  const EMBER_COUNT = 30;
  const emberGeo = new THREE.OctahedronGeometry(0.10, 0);
  const emberMat = new THREE.MeshStandardMaterial({
    color: 0xff5522,            // slot 4 ember orange hot
    emissive: 0xff5522,
    emissiveIntensity: 1.2,     // spec: 0.8..1.2 (subtle ambient smolder)
    roughness: 0.4, metalness: 0.0,
    flatShading: true,
    transparent: true, opacity: 0.92,
  });
  const emberInst = new THREE.InstancedMesh(emberGeo, emberMat, EMBER_COUNT);
  emberInst.layers.enable(BLOOM_LAYER);
  const emberBaseY = new Float32Array(EMBER_COUNT);
  const emberPhase = new Float32Array(EMBER_COUNT);
  const emberAmp   = new Float32Array(EMBER_COUNT);
  const emberFreq  = new Float32Array(EMBER_COUNT);
  for (let i = 0; i < EMBER_COUNT; i++) {
    const a = rngEmber() * Math.PI * 2;
    const u = Math.pow(rngEmber(), 1 / 1.5); // outward bias
    const r = 18 + (55 - 18) * u;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = 0.12 + rngEmber() * 0.25; // low to the ground
    emberBaseY[i] = y;
    emberPhase[i] = rngEmber() * Math.PI * 2;
    emberAmp[i]   = 0.05 + rngEmber() * 0.08;
    emberFreq[i]  = 0.6 + rngEmber() * 0.7;
    const s = 0.6 + rngEmber() * 0.9;
    dummy.position.set(x, y, z);
    dummy.scale.setScalar(s);
    dummy.rotation.set(rngEmber() * Math.PI, rngEmber() * Math.PI * 2, rngEmber() * Math.PI);
    dummy.updateMatrix();
    emberInst.setMatrixAt(i, dummy.matrix);
  }
  emberInst.instanceMatrix.needsUpdate = true;
  group.add(emberInst);
  _track(emberGeo); _track(emberMat);
  // Register ambient bob on the shared _bobbers slot — same pattern the
  // forest crystals use. The animation tick reads {mesh, baseY, phase, amp,
  // freq} and applies a sin-wave Y offset.
  _bobbers = { mesh: emberInst, baseY: emberBaseY, phase: emberPhase, amp: emberAmp, freq: emberFreq };

  return {
    catapults: CATAPULT_COUNT,
    craters: CRATER_COUNT,
    ballistaPlaceholders: ballistaSpots.length,
    embers: EMBER_COUNT,
  };
}

function _buildVoidDecor(group) {
  // SHATTERED MONOLITH — endgame void stage: fractured floating pillars,
  // missing floor-tile decals, teleport pad placeholders, cosmic star ambient.
  // Contract: docs/VOID_VISUAL_STYLE.md (8-color palette, pad spec, tile gap
  // spec, pillar spec, hotspot JSON schema). Split from _buildCatacombDecor
  // because catacomb keeps its bone+pillar pack — void is a different theme
  // with its own color contract and gameplay (teleport pads, not bones).
  //
  // Palette slots used here (void, per style guide):
  //   slot 1 #040208 (obsidian black — missing-tile decals)
  //   slot 2 #1a0a3a (deep violet abyss — pillar shadow material, pad disc base)
  //   slot 3 #3a1a5e (cosmic purple mid — pillar stonework body)
  //   slot 4 #d8dce8 (chrome white edge — pillar fractured cap)
  //   slot 8 #a8b8ff (star points — tile-gap centers, ambient cosmic shimmer)
  // Slots 5/6/7 (pad cyan idle/active glow + teleport flash) belong to
  // Phase-2 Pads Agent — placeholders here intentionally non-emissive.
  //
  // Dimension note: task spec uses smaller pillars (0.8u dia × 3-4u tall body
  // + chrome cone cap) vs VOID_VISUAL_STYLE.md's 2-3u dia × 8-14u tall. Task
  // dimensions win — they still read as fractured monoliths at this scale and
  // keep the floating-askew feel without dominating the play area silhouette.
  //
  // ── deterministic RNG (split-stream model — mirrors cinder pattern). Four
  // independent mulberry32 streams seeded off 0xC0DE99 so each concern
  // (pillars / pads / tiles / stars) is replayable in isolation. Regen tool
  // drives the pillar + pad streams in lock-step with this file; tile + star
  // streams can be added/reordered without breaking the JSON output.
  function makeMulberry(seed) {
    let state = seed >>> 0;
    return function rand() {
      state = (state + 0x6D2B79F5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const SEED = 0xC0DE99;
  const rngPillar = makeMulberry(SEED);
  const rngPad    = makeMulberry((SEED ^ 0x10000) >>> 0);
  const rngTile   = makeMulberry((SEED ^ 0x20000) >>> 0);
  const rngStar   = makeMulberry((SEED ^ 0x30000) >>> 0);

  const dummy = new THREE.Object3D();

  // ── 1) fractured floating pillars — 4-6 composite groups at radius 20-50u
  // Each pillar = composite mesh (NOT InstancedMesh — only 4-6, and the
  // per-instance tilt + cone-cap rotation differ enough that composite groups
  // are simpler). Per-pillar layout:
  //   - slot 2 deep-violet shadow base: CylinderGeometry hex 0.4r × 3-4u tall
  //   - slot 3 cosmic-purple mid stonework band: thin Cylinder near top
  //   - slot 4 chrome-white fractured cap: ConeGeometry slightly tilted
  // Per-instance Y-rotation random + small X/Z tilt for "floating askew" feel.
  // Pillar positions drive the pad clearance contract — the regen tool
  // replays this stream to know where the pillars sit.
  //
  // RNG draw order per pillar (regen tool MUST mirror byte-for-byte):
  //   COUNT: 1 draw   (4..6 via 4 + ((rand() * 3) | 0))
  //   per pillar:
  //     1) angle jitter   (rand() - 0.5) * 2 * jitterMax
  //     2) radius         20 + rand() * 30    → 20..50
  //     3) height         3 + rand() * 1      → 3..4
  //     4) yaw            rand() * Math.PI * 2
  //     5) tilt X         (rand() - 0.5) * 0.18
  //     6) tilt Z         (rand() - 0.5) * 0.18
  const PILLAR_COUNT = 4 + ((rngPillar() * 3) | 0); // 4..6
  const pillarStep = (Math.PI * 2) / PILLAR_COUNT;
  const pillarJitterMax = pillarStep * 0.25;
  const pillars = [];

  // Shared geometries / materials — tracked once, reused across all pillars.
  const baseGeo = new THREE.CylinderGeometry(0.4, 0.45, 1.0, 6, 1, false); // hex prism, scaled per-instance
  const bandGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.18, 6, 1, false);  // wider band near top
  const capGeo  = new THREE.ConeGeometry(0.55, 1.1, 5);                     // jagged 5-sided cone
  const baseMat = new THREE.MeshStandardMaterial({
    color: 0x1a0a3a, roughness: 0.95, metalness: 0.05, flatShading: true,
  });
  const bandMat = new THREE.MeshStandardMaterial({
    color: 0x3a1a5e, roughness: 0.85, metalness: 0.10, flatShading: true,
  });
  const capMat = new THREE.MeshStandardMaterial({
    color: 0xd8dce8, roughness: 0.55, metalness: 0.20, flatShading: true,
    emissive: 0x1a0a3a, emissiveIntensity: 0.10, // mildly self-lit, per style guide
  });
  _track(baseGeo); _track(bandGeo); _track(capGeo);
  _track(baseMat); _track(bandMat); _track(capMat);

  for (let p = 0; p < PILLAR_COUNT; p++) {
    const angle = p * pillarStep + (rngPillar() - 0.5) * 2 * pillarJitterMax;
    const radius = 20 + rngPillar() * 30;     // 20..50
    const height = 3 + rngPillar() * 1;       // 3..4
    const yaw = rngPillar() * Math.PI * 2;
    const tiltX = (rngPillar() - 0.5) * 0.18; // small "floating askew" tilt
    const tiltZ = (rngPillar() - 0.5) * 0.18;
    const px = Math.cos(angle) * radius;
    const pz = Math.sin(angle) * radius;
    pillars.push({ x: px, z: pz });

    const g = new THREE.Group();
    g.position.set(px, 0, pz);
    g.rotation.set(tiltX, yaw, tiltZ);

    // Deep violet shadow base — tall prism, scaled to match per-pillar height.
    const baseMesh = new THREE.Mesh(baseGeo, baseMat);
    baseMesh.position.set(0, height * 0.5, 0);
    baseMesh.scale.set(1, height, 1);
    g.add(baseMesh);

    // Cosmic purple mid band — sits just below the cap.
    const band = new THREE.Mesh(bandGeo, bandMat);
    band.position.set(0, height - 0.15, 0);
    g.add(band);

    // Chrome white fractured cap — cone slightly tilted to look broken.
    const cap = new THREE.Mesh(capGeo, capMat);
    cap.position.set(0, height + 0.45, 0);
    cap.rotation.set((rngPillar() - 0.5) * 0.4, rngPillar() * Math.PI * 2, (rngPillar() - 0.5) * 0.4);
    g.add(cap);

    group.add(g);
  }

  // ── 2) teleport pad placeholders — 4-6 disc bases at radius 22-48u ──────
  // Phase-2 Pads Agent renders runtime entities (cyan ring + pulse + bloom);
  // we ship only the deep-violet stone disc base so the player sees a
  // recognizable silhouette before activation. NO emissive on placeholder.
  // Positions chosen by rejection sampling: must respect 12u min-distance
  // from other pads AND 4u min-distance from any pillar center. The regen
  // tool mirrors this loop exactly so the JSON aligns with placeholder
  // positions in-game.
  //
  // RNG draw order per pad attempt (regen tool MUST mirror):
  //   COUNT: 1 draw   (4..6 via 4 + ((rand() * 3) | 0))
  //   per attempt (accept OR reject):
  //     a) angle  → 1 draw
  //     b) radius → 1 draw  via 22 + rand() * 26   → 22..48
  //     c) scale  → 1 draw  via 0.85 + rand() * 0.35  → 0.85..1.20
  //   Rejected attempts STILL consume all three draws.
  const PAD_TARGET = 4 + ((rngPad() * 3) | 0); // 4..6
  const MIN_PAD_DIST_SQ = 12 * 12;
  const MIN_PILLAR_DIST_SQ = 4 * 4;
  const padSpots = [];
  let padGuard = 0;
  while (padSpots.length < PAD_TARGET && padGuard++ < 500) {
    const a = rngPad() * Math.PI * 2;
    const r = 22 + rngPad() * 26; // 22..48
    const scale = +(0.85 + rngPad() * 0.35).toFixed(2); // 0.85..1.20
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    // Reject if too close to another pad.
    let bad = false;
    for (const p of padSpots) {
      const dx = x - p.x, dz = z - p.z;
      if (dx * dx + dz * dz < MIN_PAD_DIST_SQ) { bad = true; break; }
    }
    if (bad) continue;
    // Reject if too close to any pillar center.
    for (const pil of pillars) {
      const dx = x - pil.x, dz = z - pil.z;
      if (dx * dx + dz * dz < MIN_PILLAR_DIST_SQ) { bad = true; break; }
    }
    if (bad) continue;
    padSpots.push({
      x: +x.toFixed(2),
      z: +z.toFixed(2),
      scale,
      seed: 6000 + padSpots.length,
    });
  }

  // Render placeholder disc bases — InstancedMesh of a single flat cylinder.
  // 1.2u dia × 0.1u tall per style guide (very flat rim). NO emissive — the
  // Phase-2 Pads Agent owns the cyan ring/glow.
  const padDiscGeo = new THREE.CylinderGeometry(0.6, 0.6, 0.1, 16, 1, false);
  padDiscGeo.translate(0, 0.05, 0);
  const padDiscMat = new THREE.MeshStandardMaterial({
    color: 0x1a0a3a,            // slot 2 deep violet
    roughness: 0.85, metalness: 0.10,
    flatShading: true,
    // NO emissive — Phase-2 Pads Agent owns slot 5/6/7 cyan glow + flash.
  });
  const PAD_SLOTS = Math.max(PAD_TARGET, padSpots.length);
  const padInst = new THREE.InstancedMesh(padDiscGeo, padDiscMat, PAD_SLOTS);
  for (let i = 0; i < PAD_SLOTS; i++) {
    if (i < padSpots.length) {
      const b = padSpots[i];
      dummy.position.set(b.x, 0, b.z);
      dummy.scale.setScalar(b.scale);
      dummy.rotation.set(0, 0, 0);
    } else {
      dummy.position.set(0, -1000, 0);
      dummy.scale.setScalar(0.001);
      dummy.rotation.set(0, 0, 0);
    }
    dummy.updateMatrix();
    padInst.setMatrixAt(i, dummy.matrix);
  }
  padInst.instanceMatrix.needsUpdate = true;
  group.add(padInst);
  _track(padDiscGeo); _track(padDiscMat);
  group.userData.voidTeleportHotspots = padSpots;

  // ── 3) missing-tile decals — 5-8 ground-plane decals at radius 18-50u ───
  // Pure visual fiction: NO collision, NO damage. Slot 1 obsidian black,
  // opacity 0.85, bloom OFF. Slight per-decal Y-jitter so they don't all sit
  // at exactly y=0 (reads more like holes than posters).
  const TILE_COUNT = 5 + ((rngTile() * 4) | 0); // 5..8
  const tileGeo = new THREE.PlaneGeometry(1, 1);
  const tileMat = new THREE.MeshStandardMaterial({
    color: 0x040208,            // slot 1 obsidian black
    roughness: 1.0, metalness: 0.0,
    transparent: true, opacity: 0.85, side: THREE.DoubleSide,
    depthWrite: false,
    // NO emissive — the void absorbs light, doesn't emit it.
  });
  const tileInst = new THREE.InstancedMesh(tileGeo, tileMat, TILE_COUNT);
  // NO BLOOM_LAYER enable — gaps must not glow.
  for (let i = 0; i < TILE_COUNT; i++) {
    const a = rngTile() * Math.PI * 2;
    const r = 18 + rngTile() * 32; // 18..50
    const w = 1.5 + rngTile() * 1.0;  // 1.5..2.5u
    const h = 1.5 + rngTile() * 1.0;
    const yawRot = rngTile() * Math.PI * 2;
    const yJitter = -0.02 + (rngTile() - 0.5) * 0.04; // tiny ± Y so not all at 0
    const cx = Math.cos(a) * r;
    const cz = Math.sin(a) * r;
    dummy.position.set(cx, yJitter, cz);
    dummy.scale.set(w, h, 1);
    dummy.rotation.set(-Math.PI / 2, 0, yawRot);
    dummy.updateMatrix();
    tileInst.setMatrixAt(i, dummy.matrix);
  }
  tileInst.instanceMatrix.needsUpdate = true;
  group.add(tileInst);
  _track(tileGeo); _track(tileMat);

  // ── 4) ambient cosmic star particles — ~25 small bloom-lit octahedrons ──
  // Slot 8 #a8b8ff, varied y heights 0.2-2.5u, additive bloom feel. Register
  // ambient bob on the shared _bobbers slot — clearArenaDecor wipes between
  // stage swaps so reuse is safe. Only stars bob (one InstancedMesh per slot).
  const STAR_COUNT = 25;
  const starGeo = new THREE.OctahedronGeometry(0.06, 0);
  const starMat = new THREE.MeshStandardMaterial({
    color: 0xa8b8ff,            // slot 8 star points
    emissive: 0xa8b8ff,
    emissiveIntensity: 1.6,     // 1.4..2.2 per style guide
    roughness: 0.3, metalness: 0.0,
    flatShading: true,
    transparent: true, opacity: 0.95,
  });
  const starInst = new THREE.InstancedMesh(starGeo, starMat, STAR_COUNT);
  starInst.layers.enable(BLOOM_LAYER);
  const starBaseY = new Float32Array(STAR_COUNT);
  const starPhase = new Float32Array(STAR_COUNT);
  const starAmp   = new Float32Array(STAR_COUNT);
  const starFreq  = new Float32Array(STAR_COUNT);
  for (let i = 0; i < STAR_COUNT; i++) {
    const a = rngStar() * Math.PI * 2;
    const u = Math.pow(rngStar(), 1 / 1.4); // mild outward bias
    const r = 18 + (55 - 18) * u;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = 0.2 + rngStar() * 2.3; // 0.2..2.5u — varied heights
    starBaseY[i] = y;
    starPhase[i] = rngStar() * Math.PI * 2;
    starAmp[i]   = 0.04 + rngStar() * 0.08;   // very subtle drift
    starFreq[i]  = 0.3 + rngStar() * 0.5;
    const s = 0.7 + rngStar() * 0.8;
    dummy.position.set(x, y, z);
    dummy.scale.setScalar(s);
    dummy.rotation.set(rngStar() * Math.PI, rngStar() * Math.PI * 2, rngStar() * Math.PI);
    dummy.updateMatrix();
    starInst.setMatrixAt(i, dummy.matrix);
  }
  starInst.instanceMatrix.needsUpdate = true;
  group.add(starInst);
  _track(starGeo); _track(starMat);
  // Register subtle Y-bob on the shared _bobbers slot.
  _bobbers = { mesh: starInst, baseY: starBaseY, phase: starPhase, amp: starAmp, freq: starFreq };

  return {
    pillars: PILLAR_COUNT,
    tileGaps: TILE_COUNT,
    padPlaceholders: padSpots.length,
    stars: STAR_COUNT,
  };
}

function _buildCatacombDecor(group) {
  // 1) Floating bone fragments — mix of small cones (femurs / shards) and
  // tiny boxes (vertebrae). Off-white, drift slowly at varied heights.
  // Two InstancedMesh layers (cone + box) sharing the same bobber arrays
  // so the animation tick can drive both with one trig pass.
  const TOTAL = 64;
  const CONE_N = 32, BOX_N = TOTAL - CONE_N;
  const coneGeo = new THREE.ConeGeometry(0.12, 0.5, 5);
  const boxGeo  = new THREE.BoxGeometry(0.22, 0.22, 0.22);
  const boneMat = new THREE.MeshStandardMaterial({
    color: 0xe8e0cf, roughness: 0.7, metalness: 0,
    emissive: 0x33304a, emissiveIntensity: 0.2,
  });
  const coneInst = new THREE.InstancedMesh(coneGeo, boneMat, CONE_N);
  const boxInst  = new THREE.InstancedMesh(boxGeo,  boneMat, BOX_N);

  const baseY = new Float32Array(TOTAL);
  const phase = new Float32Array(TOTAL);
  const amp = new Float32Array(TOTAL);
  const freq = new Float32Array(TOTAL);
  const spin = new Float32Array(TOTAL);
  const baseRotY = new Float32Array(TOTAL);
  const baseX = new Float32Array(TOTAL);
  const baseZ = new Float32Array(TOTAL);
  const scaleA = new Float32Array(TOTAL);

  const dummy = new THREE.Object3D();
  for (let i = 0; i < TOTAL; i++) {
    const { x, z } = _scatterRing(18, 58, 1.5);
    const y = 0.6 + Math.random() * 2.5;
    baseY[i] = y; baseX[i] = x; baseZ[i] = z;
    phase[i] = Math.random() * Math.PI * 2;
    amp[i] = 0.1 + Math.random() * 0.3;
    freq[i] = 0.3 + Math.random() * 0.5;
    spin[i] = (Math.random() - 0.5) * 0.6;
    baseRotY[i] = Math.random() * Math.PI * 2;
    scaleA[i] = 0.8 + Math.random() * 0.8;
    dummy.position.set(x, y, z);
    dummy.scale.setScalar(scaleA[i]);
    dummy.rotation.set(Math.random() * Math.PI, baseRotY[i], Math.random() * Math.PI);
    dummy.updateMatrix();
    if (i < CONE_N) coneInst.setMatrixAt(i, dummy.matrix);
    else            boxInst.setMatrixAt(i - CONE_N, dummy.matrix);
  }
  coneInst.instanceMatrix.needsUpdate = true;
  boxInst.instanceMatrix.needsUpdate = true;
  group.add(coneInst); group.add(boxInst);
  _drifters = {
    coneMesh: coneInst, boxMesh: boxInst, coneN: CONE_N, boxN: BOX_N,
    baseX, baseY, baseZ, phase, amp, freq, spin, baseRotY, scaleA,
  };
  _track(coneGeo); _track(boxGeo); _track(boneMat);

  // 2) Cardinal pillars — Lousberg CC0 pillar GLBs at N/E/S/W marking the
  // arena boundary at radius 22 (just outside the comfortable play circle).
  // Iter 14: real GLB clones replace the InstancedMesh cylinder placeholders.
  let pillarCount = 0;
  const PR = 22;
  const dirs = [[PR, 0], [0, PR], [-PR, 0], [0, -PR]];
  const PILLAR_KEYS = ['kit_pillar', 'kit_pillar2', 'kit_pillar_broken', 'kit_pillar'];
  for (let i = 0; i < 4; i++) {
    const clone = cloneCached(PILLAR_KEYS[i]);
    if (!clone) continue;
    clone.scale.setScalar(2.6);
    clone.position.set(dirs[i][0], 0, dirs[i][1]);
    clone.rotation.y = i * Math.PI / 2;
    clone.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    group.add(clone);
    pillarCount++;
  }

  // 3) Grounded ossuary bones (iter 14) — 14 Lousberg bone clusters around
  // the play ring. The existing TOTAL=64 cone+box bones float ambiently in
  // the air; this set sits on the floor so the chamber reads as a real
  // ossuary instead of just a foggy room.
  let groundBones = 0;
  groundBones += _scatterGLB(group, 'kit_bone1', 6, 14, 50, [1.3, 2.0], 1.4);
  groundBones += _scatterGLB(group, 'kit_bone2', 4, 14, 50, [1.3, 2.0], 1.4);
  groundBones += _scatterGLB(group, 'kit_bone3', 4, 14, 50, [1.3, 2.0], 1.4);

  return { bones: TOTAL, pillars: pillarCount, groundBones };
}

// ── skybox tint ───────────────────────────────────────────────────────────────
// Only tints flat THREE.Color backgrounds. If a Texture / CubeTexture has been
// installed, the existing background is left alone (per task spec).
const STAGE_SKY = {
  forest:   0x0a1810,  // a touch greener than the default 0x061008
  twilight: 0x12091e,  // bruised purple
  cinder:   0x1a0604,  // deep ember red
  catacomb: 0x06080c,  // near-black blue
  void:     0x040208,  // void-black violet
};
function _tintSkybox(scene, stageId) {
  const bg = scene.background;
  if (!bg) return;
  if (!bg.isColor) return; // gradient / cubemap → leave alone
  if (_savedSkyHex == null) _savedSkyHex = bg.getHex();
  const hex = STAGE_SKY[stageId];
  if (typeof hex === 'number') bg.setHex(hex);
}
function _restoreSkybox(scene) {
  if (_savedSkyHex == null) return;
  const bg = scene.background;
  if (bg && bg.isColor) bg.setHex(_savedSkyHex);
  _savedSkyHex = null;
}

// ── animation tick ────────────────────────────────────────────────────────────
let _animStart = 0;
const _animDummy = new THREE.Object3D();
const _animM = new THREE.Matrix4();
const _animQ = new THREE.Quaternion();
const _animS = new THREE.Vector3();
const _animP = new THREE.Vector3();
function _animLoop() {
  _rafId = requestAnimationFrame(_animLoop);
  const t = (performance.now() - _animStart) * 0.001;
  const dummy = _animDummy;
  if (_bobbers && _bobbers.mesh) {
    const { mesh, baseY, phase, amp, freq } = _bobbers;
    const m = _animM;
    const q = _animQ;
    const s = _animS;
    const p = _animP;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      m.decompose(p, q, s);
      p.y = baseY[i] + Math.sin(t * freq[i] + phase[i]) * amp[i];
      dummy.position.copy(p);
      dummy.quaternion.copy(q);
      // Slow spin around Y for the crystals.
      dummy.rotateY(0.005);
      dummy.scale.copy(s);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
  if (_drifters) {
    const d = _drifters;
    for (let i = 0; i < d.coneN + d.boxN; i++) {
      const y = d.baseY[i] + Math.sin(t * d.freq[i] + d.phase[i]) * d.amp[i];
      // Gentle lateral drift (small Lissajous) so bones don't look like
      // perfectly anchored bobbers.
      const dx = Math.sin(t * d.freq[i] * 0.7 + d.phase[i]) * 0.15;
      const dz = Math.cos(t * d.freq[i] * 0.6 + d.phase[i] * 1.3) * 0.15;
      dummy.position.set(d.baseX[i] + dx, y, d.baseZ[i] + dz);
      dummy.rotation.set(0, d.baseRotY[i] + t * d.spin[i], 0);
      dummy.scale.setScalar(d.scaleA[i]);
      dummy.updateMatrix();
      if (i < d.coneN) d.coneMesh.setMatrixAt(i, dummy.matrix);
      else             d.boxMesh.setMatrixAt(i - d.coneN, dummy.matrix);
    }
    d.coneMesh.instanceMatrix.needsUpdate = true;
    d.boxMesh.instanceMatrix.needsUpdate = true;
  }
}

// ── public API ────────────────────────────────────────────────────────────────
export function loadArenaDecor(stageId, scene) {
  if (!scene) return null;
  // Tear down any prior decor before building the new pack.
  clearArenaDecor(scene);

  const group = new THREE.Group();
  group.name = '__arenaDecor';
  let counts = null;
  switch (stageId) {
    case 'forest': {
      // FE-C2: pre-allocate decor for ALL 4 forest rooms at scene-load time
      // so the integration agent (Cohort 3A) can flip InstancedMesh.visible
      // on room transitions without rebuilding geometry. Default visibility
      // is "all visible" — Cohort 3A will gate based on state.run.currentRoom.
      counts = {
        glade:          _buildForestDecor(group, { roomId: 'glade' }),
        saphollow:      _buildForestDecor(group, { roomId: 'saphollow' }),
        crystalchoir:   _buildForestDecor(group, { roomId: 'crystalchoir' }),
        amberlabyrinth: _buildForestDecor(group, { roomId: 'amberlabyrinth' }),
        // FE-V2: 3 new rooms — bramble (relic), mossroot (puzzle), glowfen (lore).
        bramblemaze:    _buildForestDecor(group, { roomId: 'bramblemaze' }),
        mossroot:       _buildForestDecor(group, { roomId: 'mossroot' }),
        glowfen:        _buildForestDecor(group, { roomId: 'glowfen' }),
      };
      break;
    }
    case 'twilight': counts = _buildTwilightDecor(group); break;
    case 'cinder':   counts = _buildCinderDecor(group); break;
    case 'catacomb': counts = _buildCatacombDecor(group); break;
    case 'void':     counts = _buildVoidDecor(group); break;
    default: return null;
  }
  scene.add(group);
  _decorGroup = group;
  _tintSkybox(scene, stageId);

  // Kick off the bob/drift animation only if the active pack needs it.
  if (_bobbers || _drifters) {
    _animStart = performance.now();
    if (_rafId == null) _rafId = requestAnimationFrame(_animLoop);
  }
  return counts;
}

export function clearArenaDecor(scene) {
  if (_rafId != null) { cancelAnimationFrame(_rafId); _rafId = null; }
  _bobbers = null;
  _drifters = null;
  if (_decorGroup) {
    if (scene && _decorGroup.parent === scene) scene.remove(_decorGroup);
    else if (_decorGroup.parent) _decorGroup.parent.remove(_decorGroup);
    // Dispose all InstancedMesh children (geometry refs are tracked separately).
    _decorGroup.traverse((o) => {
      if (o.isInstancedMesh) {
        if (o.dispose) o.dispose();
      }
    });
    _decorGroup = null;
  }
  for (const d of _disposables) { try { d.dispose && d.dispose(); } catch (_) {} }
  _disposables = [];
  if (scene) _restoreSkybox(scene);
}
