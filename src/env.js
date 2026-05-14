/**
 * Forest environment: ground plane + scattered scenery + lights + fog.
 * Trimmed from original game's buildCastleEnv() (line 4409). No destructibles,
 * no central tower platform — the hero IS the player, no fixed structure here.
 */
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { WORLD } from './config.js';
import { cloneCached } from './assets.js';

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
// TODO(assets): swap these primitive placeholders for Kenney "Fantasy Town Kit"
// GLBs when the pack is downloaded. The Kenney URL hash rotated and 404s as of
// 2026-05-13; until a fresh pack is pulled into assets/fantasy_town/, the
// _makeBuilding() factory below generates BoxGeometry + cone-roof primitives
// sized for silhouette-readability under the 60° top-down camera. All
// buildings sit > 25u from origin (combat lane is preserved) and only render
// in the `forest` stage.
//
// Composition spec (from the level-design advisor brief):
//   1× Keep landmark   ~ (0, 0, -50)
//   3-4× Market cluster   ~ (40, 0, -30)
//   2-3× Barracks cluster ~ (-40, 0, -30)
//   2-3× Old Ruins        ~ (60, 0, 80)
//   1-2× Gate / arch      ~ (0, 0, 60)
const BUILDINGS = [
  // Central keep — the silhouette anchor of the district.
  { kind: 'keep',  x:   0, z: -50, rot: 0.00, scale: 1.20 },
  // Market cluster (3 houses) — clumped around (40, -30).
  { kind: 'house', x:  36, z: -24, rot: 0.30, scale: 1.00 },
  { kind: 'house', x:  46, z: -34, rot: -0.40, scale: 1.10 },
  { kind: 'house', x:  42, z: -42, rot: 0.95, scale: 0.95 },
  { kind: 'house', x:  32, z: -36, rot: 1.65, scale: 1.05 },
  // Barracks cluster (2 houses + 1 keep-ish tower) — clumped around (-40, -30).
  { kind: 'house', x: -36, z: -26, rot: -0.20, scale: 1.05 },
  { kind: 'house', x: -44, z: -36, rot: 0.55, scale: 1.00 },
  { kind: 'keep',  x: -38, z: -44, rot: 0.10, scale: 0.85 },
  // Old Ruins — broken stumps near (60, 80).
  { kind: 'ruin',  x:  56, z:  74, rot: 0.20, scale: 1.10 },
  { kind: 'ruin',  x:  64, z:  84, rot: 1.10, scale: 0.95 },
  { kind: 'ruin',  x:  52, z:  88, rot: -0.60, scale: 1.20 },
  // Gate / arch leading south toward the player's hunting grounds.
  { kind: 'gate',  x:   0, z:  60, rot: 0.00, scale: 1.15 },
  { kind: 'gate',  x:  10, z:  58, rot: -0.25, scale: 0.85 },
];

// ── Shared building materials ──
// Three flat-shaded materials, reused across every building to keep draw-call
// state changes low. Palette pulled from STYLE_BIBLE.md (warm tan / ink /
// sage). MeshStandardMaterial picks up the HDRI envMap for subtle lighting.
const BUILDING_MATS = {
  wall: new THREE.MeshStandardMaterial({
    color: 0xd9c79a, roughness: 0.85, metalness: 0.0, flatShading: true,
  }),
  roof: new THREE.MeshStandardMaterial({
    color: 0x8a4a2a, roughness: 0.75, metalness: 0.0, flatShading: true,
  }),
  trim: new THREE.MeshStandardMaterial({
    color: 0x3a2a1a, roughness: 0.90, metalness: 0.0, flatShading: true,
  }),
};

/**
 * Build a single primitive-placeholder building of the requested kind.
 * Each call returns a Group with a UNIQUE geometry-set so it costs one mesh
 * per part (the brief disallows InstancedMesh for buildings — they're meant
 * to feel authored). Triangle budget per building stays small (~600-1200 tris)
 * so the full district stays well under the 80k allotment.
 *
 * @param {'keep'|'house'|'ruin'|'gate'} kind
 * @returns {THREE.Group}
 */
function _makeBuilding(kind) {
  const g = new THREE.Group();
  g.userData._kkBuilding = kind;
  const W = BUILDING_MATS.wall, R = BUILDING_MATS.roof, T = BUILDING_MATS.trim;

  if (kind === 'keep') {
    // Tall stone keep — square base + tapered tower + conical cap.
    const base = new THREE.Mesh(new THREE.BoxGeometry(8, 6, 8), W);
    base.position.y = 3; g.add(base);
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.0, 12, 12), W);
    tower.position.set(0, 12, 0); g.add(tower);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(3.4, 5, 12), R);
    cap.position.set(0, 20.5, 0); g.add(cap);
    // Ink-dark door for silhouette punch.
    const door = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.4, 0.2), T);
    door.position.set(0, 1.2, 4.05); g.add(door);
  } else if (kind === 'house') {
    // Small townhouse — box body + ridged roof + chimney.
    const body = new THREE.Mesh(new THREE.BoxGeometry(6, 4, 5), W);
    body.position.y = 2; g.add(body);
    // Roof: two-sided prism via a rotated 4-sided cone.
    const roof = new THREE.Mesh(new THREE.ConeGeometry(4.2, 3.2, 4), R);
    roof.position.set(0, 5.6, 0);
    roof.rotation.y = Math.PI / 4;
    g.add(roof);
    const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.7, 2.2, 0.7), T);
    chimney.position.set(1.8, 6.4, -1.0); g.add(chimney);
    const door = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.0, 0.15), T);
    door.position.set(0, 1.0, 2.55); g.add(door);
  } else if (kind === 'ruin') {
    // Half-collapsed stone wall fragment — a few broken upright pieces.
    const w1 = new THREE.Mesh(new THREE.BoxGeometry(5, 3.2, 0.8), W);
    w1.position.set(0, 1.6, 0); g.add(w1);
    const w2 = new THREE.Mesh(new THREE.BoxGeometry(0.8, 2.4, 4), W);
    w2.position.set(2.6, 1.2, 2.4); g.add(w2);
    // A toppled stump — short and tilted.
    const stump = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.4, 0.7), W);
    stump.position.set(-2.4, 0.7, 1.8);
    stump.rotation.z = 0.35;
    g.add(stump);
  } else if (kind === 'gate') {
    // Stone arch — two pillars + lintel beam.
    const pL = new THREE.Mesh(new THREE.BoxGeometry(1.6, 7, 1.6), W);
    pL.position.set(-3.2, 3.5, 0); g.add(pL);
    const pR = new THREE.Mesh(new THREE.BoxGeometry(1.6, 7, 1.6), W);
    pR.position.set( 3.2, 3.5, 0); g.add(pR);
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(8.0, 1.4, 1.6), T);
    lintel.position.set(0, 7.7, 0); g.add(lintel);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(9.0, 0.6, 2.0), R);
    cap.position.set(0, 8.7, 0); g.add(cap);
  }

  // Buildings are large authored geometry: cast + receive shadows per the
  // selective-shadow rule (PERF.md §6). Mark _castSet so any later pool
  // walker skips re-setting these.
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
  // Authored placements — unique meshes, no instancing. Tagged forestOnly so
  // applyStageTint hides the whole district in twilight + cinder stages.
  for (const spec of BUILDINGS) {
    const b = _makeBuilding(spec.kind);
    b.position.set(spec.x, 0, spec.z);
    b.rotation.y = spec.rot;
    b.scale.setScalar(spec.scale);
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

  scene.add(group);
  // Stash the sun on the group so main.js can re-point it each frame.
  group.userData.sun = sun;
  // Stash the ground mesh + scene ref so applyStageTint can recolor on demand.
  group.userData.ground = ground;
  group.userData.scene = scene;
  group.userData.baseFogColor = scene.fog ? scene.fog.color.getHex() : null;
  group.userData.applyStageTint = (stage) => {
    if (!stage) return;
    const id = stage.id;
    const isForest   = id === 'forest';
    const isTwilight = id === 'twilight';
    const isCinder   = id === 'cinder';
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
  };
  return group;
}
