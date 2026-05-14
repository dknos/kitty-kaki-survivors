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
  // 1) Trees — cone-on-cylinder, dark green. ~40 instances. Merged into a
  // single InstancedMesh by using a small parent group of two meshes that
  // share a transform per instance.
  const TREES = 42;
  const trunkGeo = new THREE.CylinderGeometry(0.12, 0.18, 1.2, 6);
  const crownGeo = new THREE.ConeGeometry(0.95, 2.2, 8);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 1.0, metalness: 0 });
  const crownMat = new THREE.MeshStandardMaterial({ color: 0x1d4a25, roughness: 0.95, metalness: 0 });
  const trunkInst = new THREE.InstancedMesh(trunkGeo, trunkMat, TREES);
  const crownInst = new THREE.InstancedMesh(crownGeo, crownMat, TREES);
  trunkInst.receiveShadow = false; crownInst.receiveShadow = false;
  const dummy = new THREE.Object3D();
  for (let i = 0; i < TREES; i++) {
    const { x, z } = _scatterRing(28, 60, 2.0);
    const s = 0.85 + Math.random() * 0.9;
    const ry = Math.random() * Math.PI * 2;
    // trunk
    dummy.position.set(x, 0.6 * s, z);
    dummy.scale.setScalar(s);
    dummy.rotation.set(0, ry, 0);
    dummy.updateMatrix();
    trunkInst.setMatrixAt(i, dummy.matrix);
    // crown sits on top of the trunk
    dummy.position.set(x, (1.2 + 1.1) * s, z);
    dummy.updateMatrix();
    crownInst.setMatrixAt(i, dummy.matrix);
  }
  trunkInst.instanceMatrix.needsUpdate = true;
  crownInst.instanceMatrix.needsUpdate = true;
  group.add(trunkInst); group.add(crownInst);
  _track(trunkGeo); _track(crownGeo); _track(trunkMat); _track(crownMat);

  // 2) Grass tufts — small upright planes with a soft alpha cutout. 100 of
  // them, sprinkled inside the tree ring (so the player still passes through
  // them on the periphery).
  const TUFTS = 100;
  const tuftGeo = new THREE.PlaneGeometry(0.5, 0.45);
  const tuftMat = new THREE.MeshBasicMaterial({
    color: 0x4c8a3a, side: THREE.DoubleSide, transparent: true, opacity: 0.85,
  });
  const tuftInst = new THREE.InstancedMesh(tuftGeo, tuftMat, TUFTS);
  for (let i = 0; i < TUFTS; i++) {
    const { x, z } = _scatterRing(20, 58, 1.8);
    const s = 0.7 + Math.random() * 0.9;
    dummy.position.set(x, 0.22 * s, z);
    dummy.scale.set(s, s, 1);
    dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
    dummy.updateMatrix();
    tuftInst.setMatrixAt(i, dummy.matrix);
  }
  tuftInst.instanceMatrix.needsUpdate = true;
  group.add(tuftInst);
  _track(tuftGeo); _track(tuftMat);

  return { trees: TREES, tufts: TUFTS };
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

  // 1) Floating crystal clusters — octahedrons that bob slowly. Emissive
  // purple-pink on BLOOM_LAYER so they read as magic in the bloom pass.
  const CRYSTALS = 26;
  const crystGeo = new THREE.OctahedronGeometry(0.55, 0);
  const crystMat = new THREE.MeshStandardMaterial({
    color: 0xa44dd6, emissive: 0xb054ff, emissiveIntensity: 1.2,
    roughness: 0.4, metalness: 0.1, transparent: true, opacity: 0.92,
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
    const y = 1.0 + Math.random() * 0.6;
    baseY[i] = y;
    phase[i] = Math.random() * Math.PI * 2;
    amp[i]   = 0.15 + Math.random() * 0.25;
    freq[i]  = 0.6  + Math.random() * 0.5;
    dummy.position.set(x, y, z);
    dummy.scale.setScalar(0.8 + Math.random() * 0.7);
    dummy.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
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
  const RUNES = 40;
  const runeGeo = new THREE.PlaneGeometry(1.9, 1.9);
  const runeMat = new THREE.MeshBasicMaterial({
    map: makeRuneRingTexture(),
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
function _animLoop() {
  _rafId = requestAnimationFrame(_animLoop);
  const t = (performance.now() - _animStart) * 0.001;
  const dummy = new THREE.Object3D();
  if (_bobbers && _bobbers.mesh) {
    const { mesh, baseY, phase, amp, freq } = _bobbers;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
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
