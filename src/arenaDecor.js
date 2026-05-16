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

function _buildForestDecor(group) {
  // PETRIFIED FOREST — bioluminescent crystal-stone woods.
  // Contract: docs/FOREST_VISUAL_STYLE.md (8-color palette, choke corridors,
  // amber hotspot JSON). Per-cluster crystal pack with funnel gaps and slot-5
  // accent shards. No grass tufts (doesn't fit petrified theme). Amber
  // hotspots are coordinate-only and written to disk for the Phase-2 Amber
  // Interactable agent to consume — we do NOT render them here.
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
  // 0) Real gravestones (iter 14) — 18 Lousberg CC0 gravestones scattered
  // around the outer ring. Cycle through 3 variants for silhouette variety.
  // Authored meshes (~30 KB each, 4-8 mats each) but with only 18 instances
  // the draw-call cost stays well inside budget. Reading these as "this is
  // a graveyard" is the entire point of the twilight stage.
  let graves = 0;
  graves += _scatterGLB(group, 'kit_gravestone',  6, 22, 56, [1.5, 2.5]);
  graves += _scatterGLB(group, 'kit_gravestone2', 6, 22, 56, [1.5, 2.5]);
  graves += _scatterGLB(group, 'kit_grave',       6, 22, 56, [1.5, 2.5]);

  // 1) Floating crystal shards (iter 34 quality pass) — replaced the old
  // OctahedronGeometry diamonds (read as "purple squares" from iso). Now a
  // tall hex-prism column with two stacked tip cones so each shard reads as
  // a faceted Blizzard-style crystal even when scale shrinks them in the
  // back of the fog. BufferGeometryUtils.mergeGeometries lets us keep one
  // shared geo per InstancedMesh (still one draw call for all 26).
  const CRYSTALS = 26;
  const _shardBody = new THREE.CylinderGeometry(0.22, 0.34, 1.1, 6, 1, false);
  const _shardTipUp   = new THREE.ConeGeometry(0.22, 0.50, 6);
  _shardTipUp.translate(0, 0.80, 0);
  const _shardTipDown = new THREE.ConeGeometry(0.34, 0.34, 6);
  _shardTipDown.rotateX(Math.PI);
  _shardTipDown.translate(0, -0.72, 0);
  const crystGeo = (() => {
    // Manual merge — avoid adding a fresh BufferGeometryUtils import in this
    // file (the helper is already pulled in by assets.js for static merging,
    // but a single per-stage build doesn't need it). Push the three sub-
    // geometries into one BufferGeometry by concatenating attributes.
    const merge = new THREE.BufferGeometry();
    const parts = [_shardBody, _shardTipUp, _shardTipDown];
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
  _shardBody.dispose(); _shardTipUp.dispose(); _shardTipDown.dispose();
  const crystMat = new THREE.MeshStandardMaterial({
    color: 0x8a3acc, emissive: 0xc070ff, emissiveIntensity: 1.4,
    roughness: 0.22, metalness: 0.15, transparent: true, opacity: 0.92,
    flatShading: true,   // faceted highlights — reads as cut crystal, not blob
  });
  const crystInst = new THREE.InstancedMesh(crystGeo, crystMat, CRYSTALS);
  crystInst.layers.enable(BLOOM_LAYER);
  const baseY = new Float32Array(CRYSTALS);
  const phase = new Float32Array(CRYSTALS);
  const amp = new Float32Array(CRYSTALS);
  const freq = new Float32Array(CRYSTALS);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < CRYSTALS; i++) {
    const { x, z } = _scatterRing(22, 58, 1.6);
    const y = 1.2 + Math.random() * 0.7;
    baseY[i] = y;
    phase[i] = Math.random() * Math.PI * 2;
    amp[i]   = 0.15 + Math.random() * 0.25;
    freq[i]  = 0.6  + Math.random() * 0.5;
    dummy.position.set(x, y, z);
    // Tall shards skew slightly per-instance so the cluster reads as natural.
    dummy.scale.set(
      0.55 + Math.random() * 0.35,
      0.85 + Math.random() * 0.60,
      0.55 + Math.random() * 0.35,
    );
    // Tilt: small lean off vertical + free yaw. Avoids parade-line uniformity.
    dummy.rotation.set(
      (Math.random() - 0.5) * 0.5,
      Math.random() * Math.PI * 2,
      (Math.random() - 0.5) * 0.5,
    );
    dummy.updateMatrix();
    crystInst.setMatrixAt(i, dummy.matrix);
  }
  crystInst.instanceMatrix.needsUpdate = true;
  group.add(crystInst);
  _bobbers = { mesh: crystInst, baseY, phase, amp, freq };
  _track(crystGeo); _track(crystMat);

  // 2) Ground rune circles — textured plane (rune-ring art) lying flat on
  // the ground. Stays off bloom (subtle ambient detail; bloom would smear
  // them into the fog). Swapped from RingGeometry primitive to the canonical
  // rune art so the scatter reads as inscribed glyphs, not flat outlines.
  //
  // Iter 34 quality pass: prefer the Vertex Imagen 4 hand-painted `ring_arcane`
  // WebP (manifest "Hand-painted Blizzard-style ground rings") over the
  // canvas-drawn rune so each rune reads as inked sigil art instead of a
  // simple tinted circle when 40 of them carpet the floor.
  const RUNES = 40;
  const runeGeo = new THREE.PlaneGeometry(1.9, 1.9);
  const runeMat = new THREE.MeshBasicMaterial({
    map: fxTex('ring_arcane') || makeRuneRingTexture(),
    color: 0x4ce0ff, transparent: true, opacity: 0.32, side: THREE.DoubleSide,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const runeInst = new THREE.InstancedMesh(runeGeo, runeMat, RUNES);
  for (let i = 0; i < RUNES; i++) {
    const { x, z } = _scatterRing(18, 58, 1.5);
    const s = 0.8 + Math.random() * 1.2;
    dummy.position.set(x, -0.06, z);
    dummy.scale.set(s, s, 1);
    dummy.rotation.set(-Math.PI / 2, 0, Math.random() * Math.PI * 2);
    dummy.updateMatrix();
    runeInst.setMatrixAt(i, dummy.matrix);
  }
  runeInst.instanceMatrix.needsUpdate = true;
  group.add(runeInst);
  _track(runeGeo); _track(runeMat);

  return { crystals: CRYSTALS, runes: RUNES, graves };
}

function _buildCinderDecor(group) {
  // 1) Cracked rock formations — jittered icosahedrons, dark red.
  const ROCKS = 32;
  const rockGeo = new THREE.IcosahedronGeometry(0.8, 0);
  // Jitter the vertex positions so each instance looks cracked. (The geometry
  // is shared across instances, so we jitter once — gives a chunky silhouette
  // that reads as "broken basalt" rather than "perfect d20".)
  const pos = rockGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setX(i, pos.getX(i) + (Math.random() - 0.5) * 0.25);
    pos.setY(i, pos.getY(i) + (Math.random() - 0.5) * 0.25);
    pos.setZ(i, pos.getZ(i) + (Math.random() - 0.5) * 0.25);
  }
  rockGeo.computeVertexNormals();
  // Iter 14: darken cinder rocks to basalt-black with hotter emissive cracks.
  // The old 0x4a1814 / 0x2a0604 hue read as terracotta clay; the user
  // feedback was that the cinder stage felt "samey" — pushing the material
  // toward 0x1a0e0c lets the lava cracks (additive bloom planes) pop.
  const rockMat = new THREE.MeshStandardMaterial({
    color: 0x1a0e0c, roughness: 1.0, metalness: 0,
    emissive: 0x661a08, emissiveIntensity: 0.55,
  });
  const rockInst = new THREE.InstancedMesh(rockGeo, rockMat, ROCKS);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < ROCKS; i++) {
    const { x, z } = _scatterRing(20, 60, 1.6);
    const s = 0.7 + Math.random() * 1.4;
    dummy.position.set(x, 0.3 * s, z);
    dummy.scale.set(s, s * (0.6 + Math.random() * 0.6), s);
    dummy.rotation.set(Math.random() * 0.6, Math.random() * Math.PI * 2, Math.random() * 0.6);
    dummy.updateMatrix();
    rockInst.setMatrixAt(i, dummy.matrix);
  }
  rockInst.instanceMatrix.needsUpdate = true;
  group.add(rockInst);
  _track(rockGeo); _track(rockMat);

  // 2) Lava cracks — thin emissive planes that radiate from origin. On
  // BLOOM_LAYER so they glow through the warm fog.
  const CRACKS = 10;
  const crackGeo = new THREE.PlaneGeometry(1, 0.18);
  const crackMat = new THREE.MeshBasicMaterial({
    color: 0xff5a1a, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
    depthWrite: false,
  });
  const crackInst = new THREE.InstancedMesh(crackGeo, crackMat, CRACKS);
  crackInst.layers.enable(BLOOM_LAYER);
  for (let i = 0; i < CRACKS; i++) {
    const a = (i / CRACKS) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
    // Start a few units out from origin (keep the spawn point clean) and
    // stretch a 6-18u crack outward.
    const r0 = 4 + Math.random() * 3;
    const len = 6 + Math.random() * 12;
    const mid = r0 + len * 0.5;
    const x = Math.cos(a) * mid;
    const z = Math.sin(a) * mid;
    dummy.position.set(x, -0.05, z);
    dummy.scale.set(len, 0.5 + Math.random() * 0.6, 1);
    // Lay flat (-π/2 on X) then rotate around Y to point outward. We bake
    // both into a single Z-up plane lying on the ground.
    dummy.rotation.set(-Math.PI / 2, 0, -a);
    dummy.updateMatrix();
    crackInst.setMatrixAt(i, dummy.matrix);
  }
  crackInst.instanceMatrix.needsUpdate = true;
  group.add(crackInst);
  _track(crackGeo); _track(crackMat);

  // Iter 14: charred-stump set dress (8 broken Lousberg pillars laid low,
  // scaled tiny + dark-tinted) reads as "scorched ground debris" — fills
  // the gap that made cinder feel sparser than the other stages.
  let stumps = 0;
  for (let i = 0; i < 10; i++) {
    const clone = cloneCached('kit_pillar_broken');
    if (!clone) break;
    const { x, z } = _scatterRing(20, 58, 1.5);
    clone.scale.setScalar(0.9 + Math.random() * 0.8);
    clone.position.set(x, 0, z);
    clone.rotation.set(
      (Math.random() - 0.5) * 0.4,
      Math.random() * Math.PI * 2,
      (Math.random() - 0.5) * 0.4,
    );
    // Tint dark grey-black to read as char/basalt.
    clone.traverse(o => {
      if (o.isMesh && o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (m.color) {
            // Clone the material so we don't mutate the shared GLTF mat.
            const newMat = m.clone();
            newMat.color.setHex(0x1a0c08);
            newMat.roughness = 1.0;
            if (newMat.emissive) newMat.emissive.setHex(0x3a0a04);
            newMat.emissiveIntensity = 0.25;
            if (Array.isArray(o.material)) {
              const idx = o.material.indexOf(m);
              o.material[idx] = newMat;
            } else {
              o.material = newMat;
            }
          }
        }
        o.castShadow = false;
        o.receiveShadow = true;
      }
    });
    group.add(clone);
    stumps++;
  }

  return { rocks: ROCKS, cracks: CRACKS, stumps };
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
    case 'forest':   counts = _buildForestDecor(group); break;
    case 'twilight': counts = _buildTwilightDecor(group); break;
    case 'cinder':   counts = _buildCinderDecor(group); break;
    case 'catacomb':
    case 'void':     counts = _buildCatacombDecor(group); break;
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
