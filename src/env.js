/**
 * Forest environment: ground plane + scattered scenery + lights + fog.
 * Trimmed from original game's buildCastleEnv() (line 4409). No destructibles,
 * no central tower platform — the hero IS the player, no fixed structure here.
 */
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { WORLD } from './config.js';
import { cloneCached } from './assets.js';
import { tex as particleTex } from './particleTextures.js';

// ── Per-stage atmospheric particles (iter 15) ────────────────────────────────
// Single THREE.Points cluster per stage, attached to envGroup at boot. Only
// the active stage's cluster is visible + ticked. Custom ShaderMaterial gives
// each point its own size + alpha (vanilla PointsMaterial is uniform-only),
// which we need for Void's per-point twinkle and Twilight's flicker. Forest +
// Cinder reuse the same shader but mostly drive size via the base uniform.
//
// Density target: 200-300 points per stage. With 4 stages = 4 draw calls max,
// well under the 80k tri / 200 draw call budget.
const ATMOS_SPECS = {
  forest: {
    count: 220,
    radius: 60,          // horizontal disc around hero
    yMin: 0.2,           // points spawn between yMin and yMax (world Y)
    yMax: 14,
    color: 0x9bcf6a,     // sage-green pollen mote
    baseSize: 1.8,
    sizeJitter: 0.8,
    baseAlpha: 0.55,
    alphaJitter: 0.25,
    texKey: 'pollen',
    blending: THREE.AdditiveBlending,
  },
  twilight: {
    count: 180,
    radius: 60,
    yMin: 0.4,
    yMax: 12,
    color: 0xb8d0ff,     // cool blue-white wisp
    baseSize: 2.0,
    sizeJitter: 0.7,
    baseAlpha: 0.50,
    alphaJitter: 0.30,
    texKey: 'glowWhite',
    blending: THREE.AdditiveBlending,
  },
  cinder: {
    count: 260,
    radius: 60,
    yMin: 0.1,
    yMax: 16,
    color: 0xff8a3a,     // ember orange
    baseSize: 1.5,
    sizeJitter: 0.9,
    baseAlpha: 0.75,
    alphaJitter: 0.20,
    texKey: 'emberWarm',
    blending: THREE.AdditiveBlending,
  },
  void: {
    count: 200,
    radius: 60,
    yMin: 0.5,
    yMax: 10,
    color: 0xc69cff,     // violet ghost sparkle
    baseSize: 1.6,
    sizeJitter: 0.7,
    baseAlpha: 0.60,
    alphaJitter: 0.35,
    texKey: 'twinkle',
    blending: THREE.AdditiveBlending,
  },
};

const _ATMOS_VS = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  varying float vAlpha;
  void main() {
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (300.0 / max(0.1, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;
const _ATMOS_FS = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    vec4 t = texture2D(uMap, gl_PointCoord);
    float a = t.a * vAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(uColor * t.rgb, a);
  }
`;

function _buildAtmosCluster(spec) {
  const N = spec.count;
  const positions = new Float32Array(N * 3);
  const sizes     = new Float32Array(N);
  const alphas    = new Float32Array(N);
  const phases    = new Float32Array(N);  // per-point random phase for twinkle
  const seeds     = new Float32Array(N);  // per-point unique seed (xz jitter)
  for (let i = 0; i < N; i++) {
    // Spawn within a disc around origin; main.js shifts to hero on first tick.
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * spec.radius;
    positions[i * 3 + 0] = Math.cos(a) * r;
    positions[i * 3 + 1] = spec.yMin + Math.random() * (spec.yMax - spec.yMin);
    positions[i * 3 + 2] = Math.sin(a) * r;
    sizes[i]  = spec.baseSize + (Math.random() - 0.5) * 2 * spec.sizeJitter;
    alphas[i] = Math.max(0, spec.baseAlpha + (Math.random() - 0.5) * 2 * spec.alphaJitter);
    phases[i] = Math.random() * Math.PI * 2;
    seeds[i]  = Math.random() * 1000;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aSize',    new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute('aAlpha',   new THREE.BufferAttribute(alphas, 1));
  // Large bounding sphere so frustum culling doesn't drop the cluster when we
  // wrap-shift points around the hero (positions move freely in world space).
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6);

  const map = particleTex(spec.texKey);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap:   { value: map },
      uColor: { value: new THREE.Color(spec.color) },
    },
    vertexShader:   _ATMOS_VS,
    fragmentShader: _ATMOS_FS,
    transparent: true,
    depthWrite: false,
    blending: spec.blending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.userData._atmosSpec = spec;
  points.userData._phases = phases;
  points.userData._seeds  = seeds;
  points.userData._baseAlpha = spec.baseAlpha;
  points.userData._alphaJitter = spec.alphaJitter;
  points.userData._tickAcc = Math.random() * 10;  // animation clock offset
  points.userData._initialized = false;           // hero-centering flag
  points.visible = false;
  return points;
}

// Per-stage tick functions. All operate on absolute world coords; hero passes
// in its x/z to anchor the wrap-disc. Vertical drift uses world Y bounds (not
// hero-relative) so jumps don't fountain particles.
function _tickForest(points, dt, hx, hz) {
  const spec = points.userData._atmosSpec;
  const pos  = points.geometry.attributes.position.array;
  const seeds = points.userData._seeds;
  points.userData._tickAcc += dt;
  const t = points.userData._tickAcc;
  const R = spec.radius, R2 = R * R;
  const N = spec.count;
  for (let i = 0; i < N; i++) {
    const ix = i * 3;
    // Slow upward drift + sin-wave x-jitter
    pos[ix + 1] += dt * (0.6 + Math.sin(t * 0.5 + seeds[i]) * 0.15);
    pos[ix + 0] += dt * Math.sin(t * 0.7 + seeds[i] * 0.13) * 0.20;
    // Respawn at base when above yMax
    if (pos[ix + 1] > spec.yMax) {
      pos[ix + 1] = spec.yMin + Math.random() * 1.0;
    }
    // Horizontal wrap around hero (mirror to opposite edge)
    const dx = pos[ix + 0] - hx;
    const dz = pos[ix + 2] - hz;
    if (dx * dx + dz * dz > R2) {
      pos[ix + 0] = hx - dx;
      pos[ix + 2] = hz - dz;
    }
  }
  points.geometry.attributes.position.needsUpdate = true;
}

function _tickTwilight(points, dt, hx, hz) {
  const spec = points.userData._atmosSpec;
  const pos  = points.geometry.attributes.position.array;
  const alphas = points.geometry.attributes.aAlpha.array;
  const seeds = points.userData._seeds;
  const phases = points.userData._phases;
  points.userData._tickAcc += dt;
  const t = points.userData._tickAcc;
  const R = spec.radius, R2 = R * R;
  const N = spec.count;
  const base = points.userData._baseAlpha;
  const aJit = points.userData._alphaJitter;
  for (let i = 0; i < N; i++) {
    const ix = i * 3;
    // Slow vertical drift + lateral orbit
    pos[ix + 1] += dt * (0.35 + Math.sin(t * 0.4 + seeds[i]) * 0.10);
    const orbit = t * 0.25 + phases[i];
    pos[ix + 0] += dt * Math.cos(orbit) * 0.30;
    pos[ix + 2] += dt * Math.sin(orbit) * 0.30;
    if (pos[ix + 1] > spec.yMax) {
      pos[ix + 1] = spec.yMin + Math.random() * 1.0;
    }
    const dx = pos[ix + 0] - hx;
    const dz = pos[ix + 2] - hz;
    if (dx * dx + dz * dz > R2) {
      pos[ix + 0] = hx - dx;
      pos[ix + 2] = hz - dz;
    }
    // Occasional flicker — per-point alpha sine with random phase
    const flicker = 0.5 + 0.5 * Math.sin(t * 2.1 + phases[i] * 3.0);
    alphas[i] = Math.max(0.05, base + (flicker - 0.5) * 2 * aJit);
  }
  points.geometry.attributes.position.needsUpdate = true;
  points.geometry.attributes.aAlpha.needsUpdate = true;
}

function _tickCinder(points, dt, hx, hz) {
  const spec = points.userData._atmosSpec;
  const pos  = points.geometry.attributes.position.array;
  const seeds = points.userData._seeds;
  points.userData._tickAcc += dt;
  const t = points.userData._tickAcc;
  const R = spec.radius, R2 = R * R;
  const N = spec.count;
  for (let i = 0; i < N; i++) {
    const ix = i * 3;
    // Fast upward rise + curl noise (embers swirling)
    pos[ix + 1] += dt * (2.6 + Math.sin(t * 0.9 + seeds[i]) * 0.35);
    const curl = t * 1.1 + seeds[i] * 0.07;
    pos[ix + 0] += dt * Math.sin(curl) * 0.55;
    pos[ix + 2] += dt * Math.cos(curl * 0.83) * 0.55;
    if (pos[ix + 1] > spec.yMax) {
      pos[ix + 1] = spec.yMin + Math.random() * 0.5;
    }
    const dx = pos[ix + 0] - hx;
    const dz = pos[ix + 2] - hz;
    if (dx * dx + dz * dz > R2) {
      pos[ix + 0] = hx - dx;
      pos[ix + 2] = hz - dz;
    }
  }
  points.geometry.attributes.position.needsUpdate = true;
}

function _tickVoid(points, dt, hx, hz) {
  const spec = points.userData._atmosSpec;
  const pos  = points.geometry.attributes.position.array;
  const alphas = points.geometry.attributes.aAlpha.array;
  const seeds = points.userData._seeds;
  const phases = points.userData._phases;
  points.userData._tickAcc += dt;
  const t = points.userData._tickAcc;
  const R = spec.radius, R2 = R * R;
  const N = spec.count;
  const base = points.userData._baseAlpha;
  const aJit = points.userData._alphaJitter;
  for (let i = 0; i < N; i++) {
    const ix = i * 3;
    // Near-static with slow orbital drift
    const orbit = t * 0.12 + phases[i];
    pos[ix + 0] += dt * Math.cos(orbit) * 0.12;
    pos[ix + 2] += dt * Math.sin(orbit) * 0.12;
    pos[ix + 1] += dt * Math.sin(t * 0.18 + seeds[i]) * 0.05;
    // Hard bounds (no vertical respawn — they barely move)
    if (pos[ix + 1] > spec.yMax) pos[ix + 1] = spec.yMax;
    if (pos[ix + 1] < spec.yMin) pos[ix + 1] = spec.yMin;
    const dx = pos[ix + 0] - hx;
    const dz = pos[ix + 2] - hz;
    if (dx * dx + dz * dz > R2) {
      pos[ix + 0] = hx - dx;
      pos[ix + 2] = hz - dz;
    }
    // Strong twinkle — per-point alpha sine with random phase
    const tw = 0.5 + 0.5 * Math.sin(t * 3.2 + phases[i] * 4.5 + seeds[i] * 0.01);
    alphas[i] = Math.max(0.05, base + (tw - 0.5) * 2 * aJit);
  }
  points.geometry.attributes.position.needsUpdate = true;
  points.geometry.attributes.aAlpha.needsUpdate = true;
}

const _TICKERS = {
  forest:   _tickForest,
  twilight: _tickTwilight,
  cinder:   _tickCinder,
  void:     _tickVoid,
};
// ─────────────────────────────────────────────────────────────────────────────

// Base scatter (always present)
const SCATTER = [
  { key: 'tree',      count: 140, rMin: 30, rMax: 380, scale: [3.0, 5.5] },
  { key: 'dead_tree', count: 60,  rMin: 30, rMax: 380, scale: [2.5, 4.5] },
  { key: 'rock',      count: 110, rMin: 20, rMax: 360, scale: [1.5, 3.5] },
  { key: 'bush',      count: 180, rMin: 15, rMax: 340, scale: [1.2, 2.8] },
];
// Twilight-only scatter — dead trees + rocks layered in for a sparser,
// gnarlier silhouette. Hidden until the player picks the Twilight stage.
const SCATTER_TWILIGHT = [
  { key: 'dead_tree', count: 80, rMin: 26, rMax: 380, scale: [2.8, 5.0] },
  { key: 'rock',      count: 60, rMin: 20, rMax: 360, scale: [2.0, 4.0] },
];

// ── Kingdom-district buildings (forest-only) ──
// Iter 14: swapped the BoxGeometry/ConeGeometry placeholders for real CC0
// Quaternius town kit GLBs (assets/kits/town/). Composition preserved from
// the level-design brief:
//   1× Keep landmark   ~ (0, 0, -50)
//   3-4× Market cluster   ~ (40, 0, -30)
//   2-3× Barracks cluster ~ (-40, 0, -30)
//   2-3× Old Ruins        ~ (60, 0, 80)
//   1-2× Gate / arch      ~ (0, 0, 60)
// All buildings sit > 25u from origin (combat lane is preserved) and only
// render in the `forest` stage (twilight + cinder + void hide them via
// forestProps[] toggle in applyStageTint).
//
// `kit` keys → assets/kits/town/ GLBs registered in src/assets.js.
// `lift` is a small y-offset applied per kit because Quaternius authors
// some bases below the world origin and some flush.
// `s` is the scale multiplier baked into the spec (kits ship at ~1u
// reference height; our world units want ~5-9u tall buildings).
const BUILDINGS = [
  // Central keep — the silhouette anchor of the district.
  { kit: 'kit_keep',     x:   0, z: -50, rot: 0.00, s: 7.5,  lift: 0 },
  // Market cluster (4 houses) — clumped around (40, -30).
  { kit: 'kit_house',    x:  36, z: -24, rot: 0.30, s: 4.0,  lift: 0 },
  { kit: 'kit_house2',   x:  46, z: -34, rot: -0.40, s: 4.2, lift: 0 },
  { kit: 'kit_inn',      x:  42, z: -42, rot: 0.95, s: 4.0,  lift: 0 },
  { kit: 'kit_house',    x:  32, z: -36, rot: 1.65, s: 3.8,  lift: 0 },
  // Barracks cluster (2 houses + 1 barracks) — clumped around (-40, -30).
  { kit: 'kit_house2',   x: -36, z: -26, rot: -0.20, s: 4.0, lift: 0 },
  { kit: 'kit_barracks', x: -44, z: -36, rot: 0.55, s: 4.6,  lift: 0 },
  { kit: 'kit_house',    x: -38, z: -44, rot: 0.10, s: 3.6,  lift: 0 },
  // Old Ruins — broken stumps near (60, 80). Reuse town_house tilted +
  // half-buried for a "collapsed homestead" silhouette without a dedicated
  // ruin asset; the kit_pillar_broken set-dresses next to it.
  { kit: 'kit_house',    x:  56, z:  74, rot: 0.20, s: 3.4,  lift: -0.8, tilt: 0.2 },
  { kit: 'kit_house2',   x:  64, z:  84, rot: 1.10, s: 3.0,  lift: -1.0, tilt: 0.35 },
  { kit: 'kit_pillar_broken', x: 52, z: 88, rot: -0.60, s: 2.0, lift: 0 },
  { kit: 'kit_pillar_broken', x: 60, z: 80, rot: 1.20, s: 1.8, lift: 0 },
  // Gate / arch leading south toward the player's hunting grounds.
  { kit: 'kit_gate',     x:   0, z:  60, rot: 0.00, s: 4.8,  lift: 0 },
];

/**
 * Build one authored building from a GLB kit. Falls back to a tiny
 * box silhouette if cloneCached fails (asset missing in preload), so the
 * world never has empty holes where a keep should be.
 */
function _spawnBuilding(spec) {
  let g = cloneCached(spec.kit);
  if (!g) {
    // Last-resort placeholder — short dark box so the failure is visible
    // but doesn't make the level unplayable.
    g = new THREE.Group();
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(3, 4, 3),
      new THREE.MeshStandardMaterial({ color: 0x3a2418, roughness: 0.95 }),
    );
    box.position.y = 2;
    g.add(box);
  }
  g.userData._kkBuilding = spec.kit;
  // Authored shadow rule (PERF.md §6).
  g.traverse(o => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      o.userData._castSet = true;
    }
  });
  return g;
}

export function buildEnv(scene, renderer) {
  const group = new THREE.Group();
  group.name = 'envGroup';

  // ── HDRI environment ──
  // Provides soft ambient reflections + light directionality for all PBR materials.
  // Doesn't override scene.background (we keep the dark fog color), only `environment`.
  new RGBELoader().load('assets/sprites/hdri/approaching_storm_1k.hdr', (hdrTex) => {
    hdrTex.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = hdrTex;
    // Re-walk env meshes to set envMapIntensity for any standard materials
    group.traverse(o => {
      if (o.isMesh && o.material && 'envMapIntensity' in o.material) {
        o.material.envMapIntensity = 0.70;
        o.material.needsUpdate = true;
      }
    });
  });

  // ── PBR ground: Poly Haven forrest_ground_01 (CC0) ──
  // diff + rough + normal at 1k. Heavy tiling (180×180) means 1k = plenty.
  const loader = new THREE.TextureLoader();
  const maxAniso = renderer ? renderer.capabilities.getMaxAnisotropy() : 1;
  const repeat = 180;

  function prepTex(t, srgb) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.anisotropy = Math.min(maxAniso, 8);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  // Stage-keyed texture packs. Forest = default; Twilight = brown_mud (CC0
   // Poly Haven). Pre-loaded so swaps are instant when the player picks a stage.
  function loadPack(base) {
    return {
      diff:   prepTex(loader.load(base + 'diff.jpg',   t => t.needsUpdate = true), true),
      rough:  prepTex(loader.load(base + 'rough.jpg',  t => t.needsUpdate = true), false),
      normal: prepTex(loader.load(base + 'nor_gl.jpg', t => t.needsUpdate = true), false),
    };
  }
  const groundPacks = {
    forest:   loadPack('assets/sprites/forrest_ground_01/'),
    twilight: loadPack('assets/sprites/brown_mud/'),
  };

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD.groundSize, WORLD.groundSize, 1, 1),
    new THREE.MeshStandardMaterial({
      map: groundPacks.forest.diff,
      roughnessMap: groundPacks.forest.rough,
      normalMap: groundPacks.forest.normal,
      roughness: 0.95,
      metalness: 0.0,
      normalScale: new THREE.Vector2(0.6, 0.6),
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.08;
  ground.receiveShadow = true;
  group.add(ground);

  // Scatter scenery. Forest props are always visible; twilight-only props
  // are flagged so applyStageTint can toggle them.
  const forestProps = [];   // visible only in forest stage (live trees + bushes)
  const twilightProps = []; // visible only in twilight (extra dead trees + rocks)
  function scatterInto(defs, tag) {
    for (const def of defs) {
      for (let i = 0; i < def.count; i++) {
        const clone = cloneCached(def.key);
        if (!clone) continue;
        const angle = Math.random() * Math.PI * 2;
        const r = def.rMin + Math.random() * (def.rMax - def.rMin);
        const sc = def.scale[0] + Math.random() * (def.scale[1] - def.scale[0]);
        clone.scale.setScalar(sc);
        clone.position.set(Math.cos(angle) * r, 0, Math.sin(angle) * r);
        clone.rotation.y = Math.random() * Math.PI * 2;
        clone.userData._stageTag = tag;
        clone.userData._kkBaseColor = null; // lazily captured on first tint
        group.add(clone);
        if (tag === 'forestOnly')   forestProps.push(clone);
        if (tag === 'twilightOnly') { twilightProps.push(clone); clone.visible = false; }
      }
    }
  }
  // Tag live trees + bushes as forest-only so they hide in Twilight (gives the
  // hollow a sparser, deader silhouette). Rocks + the base dead_tree set stay
  // visible in both stages.
  scatterInto([SCATTER[0], SCATTER[3]], 'forestOnly');    // tree + bush
  scatterInto([SCATTER[1], SCATTER[2]], 'shared');        // dead_tree + rock
  scatterInto(SCATTER_TWILIGHT, 'twilightOnly');

  // ── Kingdom-district buildings (forest-only) ──
  // Iter 14: real Quaternius CC0 town kit GLBs. cloneCached returns a fresh
  // scene per call so we can rotate/scale/position uniquely while sharing
  // the underlying GLTF in GLTF_CACHE.
  for (const spec of BUILDINGS) {
    const b = _spawnBuilding(spec);
    b.position.set(spec.x, spec.lift || 0, spec.z);
    b.rotation.y = spec.rot;
    if (spec.tilt) b.rotation.z = spec.tilt;
    b.scale.setScalar(spec.s);
    b.userData._stageTag = 'forestOnly';
    b.userData._kkBaseColor = null;
    group.add(b);
    forestProps.push(b);
  }

  // Cinematic 3-light setup: warm key + cool fill + sky hemi. HDRI fills ambient.
  // Dropped raw AmbientLight (HDRI environment provides it already).
  // Sky=cool blue, ground=neutral dark gray (NOT green — green bounce was
  // tinting hero shadow with a sickly tint). Drop intensity slightly so the
  // shadow stays readably dark.
  const hemi = new THREE.HemisphereLight(0xaaccff, 0x1a1a1f, 0.28);
  group.add(hemi);
  const sun = new THREE.DirectionalLight(0xffe4b8, 2.2);    // warm key
  sun.position.set(60, 80, 40);
  // Soft shadow casting — only the sun casts. Camera frustum sized to a 60u
  // box around the action area so we don't waste shadow-map texels.
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  sun.shadow.radius = 4;          // PCFSoftShadow blur radius
  const sc = sun.shadow.camera;
  sc.near = 0.5; sc.far = 200;
  sc.left = -40; sc.right = 40; sc.top = 40; sc.bottom = -40;
  sc.updateProjectionMatrix();
  // Make the shadow camera follow the hero — set up a target the engine
  // re-points each frame from main.js.
  sun.target.position.set(0, 0, 0);
  group.add(sun.target);
  group.add(sun);
  const fill = new THREE.DirectionalLight(0x5577aa, 0.25);  // cool fill
  fill.position.set(-30, 30, -30);
  group.add(fill);

  // ── Per-stage atmospheric particle clusters (iter 15) ──
  // Build all four at boot; applyStageTint toggles visibility per stage.
  // Each cluster ticks itself when active (tickAtmosphere below).
  const atmosClusters = {};
  for (const id of Object.keys(ATMOS_SPECS)) {
    const cluster = _buildAtmosCluster(ATMOS_SPECS[id]);
    cluster.name = `atmos_${id}`;
    group.add(cluster);
    atmosClusters[id] = cluster;
  }
  group.userData.atmosClusters = atmosClusters;
  group.userData._activeStageId = null;

  scene.add(group);
  // Stash the sun on the group so main.js can re-point it each frame.
  group.userData.sun = sun;
  group.userData.hemi = hemi;
  group.userData.fill = fill;
  // Stash the ground mesh + scene ref so applyStageTint can recolor on demand.
  group.userData.ground = ground;
  group.userData.scene = scene;
  group.userData.baseFogColor = scene.fog ? scene.fog.color.getHex() : null;
  // Capture baseline lighting once so per-stage swaps can restore on forest.
  const BASE_LIGHT = {
    sunColor:    sun.color.getHex(),
    sunIntensity: sun.intensity,
    hemiSky:     hemi.color.getHex(),
    hemiGround:  hemi.groundColor.getHex(),
    hemiIntensity: hemi.intensity,
    fillColor:   fill.color.getHex(),
    fillIntensity: fill.intensity,
  };
  group.userData.applyStageTint = (stage) => {
    if (!stage) return;
    const id = stage.id;
    const isForest   = id === 'forest';
    const isTwilight = id === 'twilight';
    const isCinder   = id === 'cinder';
    const isVoid     = id === 'void';
    // Ground pack: forest uses its own; twilight and cinder share brown_mud
    // (cinder gets a much hotter color tint on top so it reads as basalt/clay).
    const packKey = isForest ? 'forest' : 'twilight';
    const pack = groundPacks[packKey];
    if (ground.material) {
      ground.material.map         = pack.diff;
      ground.material.roughnessMap= pack.rough;
      ground.material.normalMap   = pack.normal;
      const tint = stage.groundTint || 0xffffff;
      if (ground.material.color) ground.material.color.setHex(tint);
      // Cinder reads better at slightly higher roughness so highlights don't
      // smear over the hot fog.
      ground.material.roughness = isCinder ? 1.0 : 0.95;
      ground.material.needsUpdate = true;
    }
    if (scene.fog && scene.fog.color) {
      scene.fog.color.setHex(stage.fogColor || group.userData.baseFogColor || 0x061008);
    }
    // Live forest props (trees + bushes) appear only in the forest stage —
    // twilight and cinder both want a sparser, harsher silhouette.
    for (const p of forestProps)   p.visible = isForest;
    // Twilight's extra dead trees + rocks appear in BOTH twilight and cinder:
    // a charred ex-forest reads as cinder's natural ancestor.
    for (const p of twilightProps) p.visible = isTwilight || isCinder;
    // ── Per-stage lighting (iter 14) ──
    // Reset to forest baseline, then mutate.
    sun.color.setHex(BASE_LIGHT.sunColor);
    sun.intensity = BASE_LIGHT.sunIntensity;
    hemi.color.setHex(BASE_LIGHT.hemiSky);
    hemi.groundColor.setHex(BASE_LIGHT.hemiGround);
    hemi.intensity = BASE_LIGHT.hemiIntensity;
    fill.color.setHex(BASE_LIGHT.fillColor);
    fill.intensity = BASE_LIGHT.fillIntensity;
    if (isTwilight) {
      // Cooler dusk: dim sun, blue-violet hemi.
      sun.color.setHex(0x9fb0e0);
      sun.intensity = 1.1;
      hemi.color.setHex(0x6a78a8);
      hemi.groundColor.setHex(0x1a1422);
      hemi.intensity = 0.20;
      fill.color.setHex(0x6a78c8);
      fill.intensity = 0.30;
    } else if (isCinder) {
      // Hot orange sun, scorched hemi.
      sun.color.setHex(0xff8a4a);
      sun.intensity = 1.8;
      hemi.color.setHex(0x884030);
      hemi.groundColor.setHex(0x2a0c08);
      hemi.intensity = 0.40;
      fill.color.setHex(0xaa3320);
      fill.intensity = 0.45;
    } else if (isVoid) {
      // Crypt-light: sun almost off, violet hemi — torches must carry it.
      sun.color.setHex(0x4a3a6a);
      sun.intensity = 0.4;
      hemi.color.setHex(0x553388);
      hemi.groundColor.setHex(0x0a0612);
      hemi.intensity = 0.35;
      fill.color.setHex(0x6644aa);
      fill.intensity = 0.20;
    }
    // ── Per-stage atmospheric particles (iter 15) ──
    // Show only the cluster for the active stage; flag others off so
    // tickAtmosphere skips them. Reset _initialized so the first tick
    // re-centers the disc on the hero's current position.
    group.userData._activeStageId = id;
    if (atmosClusters) {
      for (const k of Object.keys(atmosClusters)) {
        const c = atmosClusters[k];
        c.visible = (k === id);
        if (c.visible) c.userData._initialized = false;
      }
    }
  };
  // ── Tick the active stage's atmospheric particles (iter 15) ──
  // Called once per gameplay frame from main.js. dt is real-time (not
  // game-time) so atmosphere keeps drifting during hit-stop/pause for life.
  // hero is optional; falls back to (0,0) if undefined (e.g. title-screen
  // hover where the run hasn't started yet — but main.js guards anyway).
  group.userData.tickAtmosphere = (dt, hero) => {
    const id = group.userData._activeStageId;
    if (!id) return;
    const cluster = atmosClusters[id];
    if (!cluster || !cluster.visible) return;
    const ticker = _TICKERS[id];
    if (!ticker) return;
    const hx = hero && hero.pos ? hero.pos.x : 0;
    const hz = hero && hero.pos ? hero.pos.z : 0;
    // First-frame re-center: shift the disc-centered initial spawn so the
    // points appear around the hero, not origin.
    if (!cluster.userData._initialized) {
      const pos = cluster.geometry.attributes.position.array;
      const N = cluster.userData._atmosSpec.count;
      for (let i = 0; i < N; i++) {
        pos[i * 3 + 0] += hx;
        pos[i * 3 + 2] += hz;
      }
      cluster.geometry.attributes.position.needsUpdate = true;
      cluster.userData._initialized = true;
    }
    // Clamp dt for safety (long pauses / tab-switch resume).
    const safeDt = Math.min(dt, 0.05);
    ticker(cluster, safeDt, hx, hz);
  };
  return group;
}
