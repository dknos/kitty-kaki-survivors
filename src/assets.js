/**
 * GLTF preload + cache. Adapted from index.html lines 1985-2068 of the original game.
 * Exports a Promise that resolves once all assets are loaded (or failed gracefully).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { HERO, AVATARS } from './config.js';

export const BASE = 'assets/breakroom/';

/** @type {Record<string, any>} */
export const GLTF_CACHE = {};

// Draco decoder served from Google's CDN — required because tower-castle.glb and
// tower-void.glb were re-exported with Draco compression.
const _draco = new DRACOLoader();
_draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
_draco.setDecoderConfig({ type: 'js' });

const _loader = new GLTFLoader();
_loader.setDRACOLoader(_draco);

function _preload(key, path) {
  return new Promise(resolve => {
    _loader.load(
      path,
      gltf => {
        GLTF_CACHE[key] = gltf;
        resolve(true);
      },
      undefined,
      err => {
        console.warn(`[assets] failed: ${path}`, err);
        GLTF_CACHE[key] = null;
        // Iter 10b — surface asset-load failures via a window CustomEvent so
        // 10c's UI layer can show a user-facing toast instead of leaving the
        // game silently spawnless. We accumulate failures on a shared list
        // so a late listener still sees the full picture (and we dispatch
        // each time so an early listener picks them up immediately too).
        try {
          if (typeof window !== 'undefined') {
            window._kkAssetFailures = window._kkAssetFailures || [];
            window._kkAssetFailures.push({ key, path, err: String(err && err.message || err) });
            window.dispatchEvent(new CustomEvent('kk-asset-load-failed', {
              detail: { failures: window._kkAssetFailures.slice() },
            }));
          }
        } catch (_) { /* event dispatch must never block the load resolve */ }
        resolve(false);
      }
    );
  });
}

/**
 * Clone a cached GLTF scene. Uses SkeletonUtils.clone for skinned meshes.
 * Returns null if the asset wasn't loaded.
 */
export function cloneCached(key) {
  const gltf = GLTF_CACHE[key];
  if (!gltf) return null;
  return SkeletonUtils.clone(gltf.scene);
}

/**
 * Lazy GLTF loader (iter 33y) — fetches the asset if not yet cached and
 * resolves with `true` when the cache entry is populated, `false` on error.
 * Used by the carousel to fetch non-default hero avatars on demand instead
 * of preloading all 12 at boot (~80 MB GPU memory).
 *
 * Returns an existing in-flight promise if one is pending for the same key,
 * so concurrent callers share a single network request.
 */
const _inflight = new Map();
export function lazyLoadGLTF(key, path) {
  if (GLTF_CACHE[key]) return Promise.resolve(true);
  const pending = _inflight.get(key);
  if (pending) return pending;
  const p = _preload(key, path).then((ok) => {
    _inflight.delete(key);
    return ok;
  });
  _inflight.set(key, p);
  return p;
}

/**
 * Drop a cached GLTF and release its GPU resources. Walks the scene graph
 * to dispose every Material, MaterialMap (Texture), and BufferGeometry so
 * VRAM doesn't leak. Used when we're done with non-selected hero avatars
 * after entering run mode.
 */
export function disposeCachedGLTF(key) {
  const gltf = GLTF_CACHE[key];
  if (!gltf) return false;
  const seenMats = new Set();
  const seenTex = new Set();
  const seenGeo = new Set();
  gltf.scene.traverse((o) => {
    if (o.geometry && !seenGeo.has(o.geometry)) {
      seenGeo.add(o.geometry);
      try { o.geometry.dispose(); } catch (_) {}
    }
    if (!o.material) return;
    const arr = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of arr) {
      if (!m || seenMats.has(m)) continue;
      seenMats.add(m);
      for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap']) {
        const t = m[slot];
        if (t && !seenTex.has(t)) { seenTex.add(t); try { t.dispose(); } catch (_) {} }
      }
      try { m.dispose(); } catch (_) {}
    }
  });
  GLTF_CACHE[key] = null;
  delete GLTF_CACHE[key];
  return true;
}

/**
 * Return the animation clips for a cached GLTF, or empty array.
 * Use with THREE.AnimationMixer to drive idle/walk/attack on enemies.
 */
export function getClips(key) {
  const gltf = GLTF_CACHE[key];
  return (gltf && gltf.animations) ? gltf.animations : [];
}

/**
 * Pick a clip by fuzzy name match (case-insensitive substring). Used for
 * resilience against varying naming conventions (Idle vs idle vs CharacterIdle).
 */
export function findClip(clips, ...needles) {
  if (!clips || clips.length === 0) return null;
  for (const needle of needles) {
    const n = needle.toLowerCase();
    for (const c of clips) {
      if (c.name && c.name.toLowerCase().includes(n)) return c;
    }
  }
  return clips[0] || null;
}

/**
 * In-place material upgrade for a cloned GLTF scene: bumps Lambert/Phong to
 * MeshStandardMaterial so it reads scene.environment and looks PBR-correct.
 * Idempotent + cheap; safe to call on every spawn.
 */
const _upgradedCache = new WeakSet();

/**
 * Inject a view-space rim light term into a MeshStandardMaterial via onBeforeCompile.
 * Cheap fragment-level fake — bumps `outgoingLight` near grazing-angle pixels so
 * characters read against dark fog without needing real backlight.
 */
/**
 * Inject vertex-displacement animation onto a static-mesh material.
 * Used to fake leg/wing motion on Poly-by-Google bugs that have no skeleton.
 * Kinds:
 *   'crawl' — bottom verts sway in alternating phase along X (leg-shuffle)
 *   'flap'  — side verts oscillate Y opposite to each other (wing flap)
 *   'hover' — side verts rapid Y micro-jitter (wing buzz)
 *   'inch'  — body verts squash-wave along X (worm crawl)
 */
function _injectVertAnim(mat, kind) {
  if (!mat || mat.userData._vertAnimKind === kind) return;
  mat.userData._vertAnimKind = kind;
  const prior = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader) => {
    if (prior) prior(shader);
    shader.uniforms.vertTime = { value: 0 };
    shader.uniforms.vertAmp  = { value: 1.0 };
    let displaceSnippet = '';
    switch (kind) {
      case 'crawl':
        displaceSnippet = `
          float legMask = smoothstep(0.5, -0.5, position.y);
          float wave = sin(vertTime * 18.0 + position.x * 6.0);
          transformed.x += wave * 0.10 * legMask * vertAmp;
          transformed.z += sin(vertTime * 18.0 + position.z * 6.0) * 0.06 * legMask * vertAmp;
        `;
        break;
      case 'flap':
        displaceSnippet = `
          float wingMask = smoothstep(0.15, 0.8, abs(position.x));
          float flap = sin(vertTime * 22.0);
          transformed.y += flap * sign(position.x) * 0.45 * wingMask * vertAmp;
        `;
        break;
      case 'hover':
        displaceSnippet = `
          float wingMask = smoothstep(0.1, 0.6, abs(position.x));
          float buzz = sin(vertTime * 80.0);
          transformed.y += buzz * sign(position.x) * 0.10 * wingMask * vertAmp;
        `;
        break;
      case 'inch':
        displaceSnippet = `
          float bodyMask = 1.0 - smoothstep(0.5, 1.0, abs(position.y));
          float pulse = sin(vertTime * 6.0 + position.x * 4.0);
          transformed.x += pulse * 0.08 * bodyMask * vertAmp;
          transformed.y += sin(vertTime * 6.0) * 0.04 * bodyMask * vertAmp;
        `;
        break;
      default:
        return;
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float vertTime;\nuniform float vertAmp;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${displaceSnippet}`);
    mat.userData._vertAnimShader = shader;
  };
  mat.needsUpdate = true;
}

/**
 * iter 33p — collapse non-skinned child Mesh primitives that share a source
 * material into a single merged Mesh per material. Cuts draw calls + scene-
 * graph traversal cost for GLBs authored as many small primitives (Wolf has
 * 21 prims / 4 materials → 4 draws/instance instead of 21).
 *
 * Safe to call on cloned scenes only. Bails if any SkinnedMesh is present
 * (bone-aware merging is a different problem). Returns count of primitives
 * collapsed; 0 means no-op.
 */
export function collapseStaticMeshes(root) {
  if (!root) return 0;
  let hasSkin = false;
  root.traverse((o) => { if (o.isSkinnedMesh) hasSkin = true; });
  if (hasSkin) return 0;

  root.updateMatrixWorld(true);
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  // Bucket meshes by source material UUID. Each bucket merges to one Mesh.
  const buckets = new Map();
  const candidates = [];
  root.traverse((o) => {
    if (!o.isMesh || o.isSkinnedMesh) return;
    if (!o.geometry || !o.material) return;
    if (Array.isArray(o.material)) return;
    candidates.push(o);
  });
  if (candidates.length < 2) return 0;

  for (const o of candidates) {
    const mat = o.material;
    const geo = o.geometry.clone();
    const toRootLocal = new THREE.Matrix4().multiplyMatrices(rootInv, o.matrixWorld);
    geo.applyMatrix4(toRootLocal);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    let b = buckets.get(mat.uuid);
    if (!b) { b = { mat, geoms: [], originals: [] }; buckets.set(mat.uuid, b); }
    b.geoms.push(geo);
    b.originals.push(o);
  }

  let collapsed = 0;
  for (const { mat, geoms, originals } of buckets.values()) {
    if (geoms.length < 2) { for (const g of geoms) g.dispose(); continue; }
    let mergedGeo;
    try { mergedGeo = mergeGeometries(geoms, false); }
    catch (e) { mergedGeo = null; }
    if (!mergedGeo) {
      for (const g of geoms) g.dispose();
      continue;
    }
    for (const o of originals) {
      if (o.parent) o.parent.remove(o);
      if (o.geometry && o.geometry !== mergedGeo) o.geometry.dispose();
    }
    for (const g of geoms) if (g !== mergedGeo) g.dispose();
    const m = new THREE.Mesh(mergedGeo, mat);
    m.name = '_collapsed_' + originals[0].name;
    m.castShadow = false;
    m.receiveShadow = false;
    root.add(m);
    collapsed += originals.length;
  }
  return collapsed;
}

/**
 * Recursively flag every material on `root` for vert anim, and return the
 * list of materials so the per-frame updater can mutate uniforms.
 */
export function injectVertAnim(root, kind) {
  const mats = [];
  root.traverse(o => {
    if (!o.isMesh || !o.material) return;
    const arr = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of arr) {
      _injectVertAnim(m, kind);
      mats.push(m);
    }
  });
  return mats;
}

function _injectRim(mat) {
  if (!mat || mat.userData._rimInjected) return;
  mat.userData._rimInjected = true;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.rimColor = { value: new THREE.Color(0xaaccff) };
    shader.uniforms.rimPower = { value: 2.4 };
    shader.uniforms.rimStrength = { value: 0.35 };
    shader.fragmentShader =
      'uniform vec3 rimColor;\nuniform float rimPower;\nuniform float rimStrength;\n' +
      shader.fragmentShader;
    // Try both: newer three.js uses <opaque_fragment>, older <output_fragment>
    const rimSnippet =
      'float rim = pow(1.0 - max(dot(normalize(vNormal), normalize(vViewPosition)), 0.0), rimPower);\n' +
      'outgoingLight += rimColor * rim * rimStrength;\n';
    if (shader.fragmentShader.includes('#include <opaque_fragment>')) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        rimSnippet + '#include <opaque_fragment>',
      );
    } else if (shader.fragmentShader.includes('#include <output_fragment>')) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <output_fragment>',
        rimSnippet + '#include <output_fragment>',
      );
    }
  };
}
export function upgradeMaterials(root, envMapIntensity = 0.55, roughness = null) {
  if (!root) return;
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (let i = 0; i < mats.length; i++) {
      const m = mats[i];
      if (_upgradedCache.has(m)) continue;
      _upgradedCache.add(m);
      if (m.isMeshStandardMaterial) {
        m.envMapIntensity = envMapIntensity;
        if (roughness !== null) m.roughness = roughness;
        _injectRim(m);
        m.needsUpdate = true;
        continue;
      }
      // Upgrade Lambert/Phong/Basic → Standard, preserving color & map
      if (m.isMeshLambertMaterial || m.isMeshPhongMaterial || m.isMeshBasicMaterial) {
        const upgraded = new THREE.MeshStandardMaterial({
          color: m.color ? m.color.clone() : new THREE.Color(0xffffff),
          map: m.map || null,
          metalness: 0.05,
          roughness: roughness !== null ? roughness : 0.85,
          emissive: (m.emissive ? m.emissive.clone() : new THREE.Color(0x000000)),
          emissiveIntensity: m.emissiveIntensity || 0,
          envMapIntensity,
          transparent: !!m.transparent,
          opacity: m.opacity !== undefined ? m.opacity : 1,
        });
        _injectRim(upgraded);
        upgraded.needsUpdate = true;
        if (Array.isArray(o.material)) o.material[i] = upgraded;
        else o.material = upgraded;
      }
    }
  });
}

/**
 * Preload hero + enemy roster. Keys here map to config.js ENEMY_TIERS[].glb
 * and HERO.glb. If a key is missing here, the corresponding system silently skips.
 */
export function preloadAll() {
  // Per-avatar GLB overrides — preload only those avatars that ship a
  // dedicated mesh (`avatar.glb` set). The base 'hero' key remains the
  // canonical donor model for any avatar without an override.
  // Phase C (Iter 34) fix: preload every avatar GLB. The earlier "only the
  // selected avatar" path used `kk-survivors-meta-v1.selectedAvatar`, which
  // Phase B's v2 migration stopped writing — so post-migration users always
  // booted with `selectedAvatarId='kitty'` and cowboy/sote/etc. never had
  // their GLB registered, falling back to the tower-castle 'hero' donor (so
  // cowboykaki looked identical to kittykaki). 11 small GLBs is a tolerable
  // upfront cost vs. wiring v2 reads + carousel lazy-load here.
  const avatarOverrides = (AVATARS || [])
    .filter(a => a && a.glb)
    .map(a => [`hero_${a.id}`, BASE + a.glb]);
  const list = [
    ['hero',     BASE + HERO.glb],
    ...avatarOverrides,
    // Animated Quaternius "Ultimate Monsters" (CC0). Keep `slime` low-poly for variety.
    ['zombie',   BASE + 'Mushnub.glb'],          // small basic enemy
    ['goblin',   BASE + 'Cactoro.glb'],          // cactus goblin
    ['skeleton', BASE + 'Goleling.glb'],         // stone golem-style
    ['orc',      BASE + 'Orc-New.glb'],          // tusked orc
    ['demon',    BASE + 'Demon-New.glb'],        // red horned demon
    ['robot',    BASE + 'Goleling-Evolved.glb'], // tougher golem
    ['mech',     BASE + 'Yeti.glb'],             // hulking brute
    ['xeno',     BASE + 'Blue-Demon.glb'],       // fast blue demon
    ['slime',    BASE + 'Pink-Slime.glb'],       // keep slime
    ['giant',    BASE + 'Mushroom-King.glb'],    // elite mushroom king
    ['dragon',   BASE + 'Dragon-New.glb'],       // dragon (elite)
    // Extras for new tiers later
    ['wizard',   BASE + 'Wizard.glb'],
    ['ghost',    BASE + 'Ghost.glb'],
    ['spider',   BASE + 'Spider.glb'],
    ['wolf',     BASE + 'Wolf.glb'],
    ['dragon_evo', BASE + 'Dragon-Evolved.glb'],
    // Forest bugs (CC-BY Poly by Google + CC0 Quaternius wasp)
    ['ant',         BASE + 'Ant.glb'],
    ['beetle',      BASE + 'Beetle.glb'],
    ['ladybug',     BASE + 'Ladybug.glb'],
    ['grasshopper', BASE + 'Grasshopper.glb'],
    ['cockroach',   BASE + 'Cockroach.glb'],
    ['mantis',      BASE + 'Mantis.glb'],
    ['wasp',        BASE + 'Wasp.glb'],
    ['bee',         BASE + 'Bee.glb'],
    ['butterfly',   BASE + 'Butterfly.glb'],
    ['caterpillar', BASE + 'Caterpillar.glb'],
    // Env props (unchanged)
    ['rock',     BASE + 'Rock.glb'],
    ['tree',     BASE + 'Tree.glb'],
    ['bush',     BASE + 'Bush.glb'],
    ['dead_tree',BASE + 'Dead Tree.glb'],
    ['chest',    BASE + 'chest.glb'],
    ['chest_open', BASE + 'chest_open.glb'],
    // Cheesy Burgers weapon meshes — from the kitty-kaki-sote food pack.
    // 'burger' = base orbital, 'burger_evo' = Toxic Halo (double cheeseburger).
    ['burger',     'assets/food/Cheeseburger.glb'],
    ['burger_evo', 'assets/food/Double Cheeseburger.glb'],
    // XP gem mesh (iter 33b) — Quaternius cheese block, CC0 from Poly Pizza.
    ['cheese',     'assets/food/cheese.glb'],
    // Casino visuals (iter 33f) — CC-BY 3.0 from Poly Pizza (Poly by Google).
    // casino_building: 1930s neon-sign casino used to replace the procedural
    // Seedy Tent. dice + poker_chip: scatter bling around the entrance.
    ['casino_building', 'assets/casino/casino_building.glb'],
    ['casino_chip',     'assets/casino/poker_chip.glb'],
    ['casino_dice',     'assets/casino/dice.glb'],
    // ── Iter 14 kits — CC0 from Poly Pizza CDN. See assets/ASSETS_MANIFEST.md.
    // Forest-district buildings (Quaternius, CC0).
    ['kit_house',     'assets/kits/town/fantasy_house.glb'],
    ['kit_house2',    'assets/kits/town/town_house.glb'],
    ['kit_inn',       'assets/kits/town/fantasy_inn.glb'],
    ['kit_keep',      'assets/kits/town/tower_house.glb'],
    ['kit_gate',      'assets/kits/town/castle_gate.glb'],
    ['kit_barracks',  'assets/kits/town/fantasy_barracks.glb'],
    // Catacomb dungeon (Kay Lousberg, CC0).
    ['kit_arch',      'assets/kits/dungeon/arch.glb'],
    ['kit_pillar',    'assets/kits/dungeon/pillar.glb'],
    ['kit_pillar2',   'assets/kits/dungeon/pillar_alt.glb'],
    ['kit_pillar_broken','assets/kits/dungeon/pillar_broken.glb'],
    ['kit_coffin',    'assets/kits/dungeon/coffin.glb'],
    ['kit_crypt',     'assets/kits/dungeon/crypt.glb'],
    ['kit_bone1',     'assets/kits/dungeon/bone1.glb'],
    ['kit_bone2',     'assets/kits/dungeon/bone2.glb'],
    ['kit_bone3',     'assets/kits/dungeon/bone3.glb'],
    // Twilight ruins (Kay Lousberg, CC0).
    ['kit_grave',     'assets/kits/ruins/damaged_grave.glb'],
    ['kit_gravestone','assets/kits/ruins/gravestone.glb'],
    ['kit_gravestone2','assets/kits/ruins/gravestone_alt.glb'],
    // Torches (Quaternius, CC0).
    ['kit_torch_wall','assets/kits/torches/torch_wall.glb'],
    ['kit_torch_stand','assets/kits/torches/torch_stand.glb'],
    // ── Iter 22A cozy home furniture (Quaternius, CC0). Used by
    // src/homeDecor.js for the H-key Decorate overlay. Keys mirror the
    // HOME_CATALOG entry ids.
    ['home_rug',           'assets/kits/home/rug.glb'],
    ['home_plant',         'assets/kits/home/plant.glb'],
    ['home_lamp',          'assets/kits/home/lamp.glb'],
    ['home_bed',           'assets/kits/home/bed.glb'],
    ['home_bookshelf',     'assets/kits/home/bookshelf.glb'],
    ['home_cauldron',      'assets/kits/home/cauldron.glb'],
    ['home_chair',         'assets/kits/home/chair.glb'],
    ['home_side_table',    'assets/kits/home/side_table.glb'],
    ['home_sofa',          'assets/kits/home/sofa.glb'],
    ['home_cat',           'assets/kits/home/cat.glb'],
    ['home_chest',         'assets/kits/home/chest.glb'],
    ['home_banner_wall',   'assets/kits/home/banner_wall.glb'],
    ['home_banner_alt',    'assets/kits/home/banner_alt.glb'],
    ['home_sword_mount',   'assets/kits/home/sword_mount.glb'],
    ['home_shield_mount',  'assets/kits/home/shield_mount.glb'],
    ['home_skull_mount',   'assets/kits/home/skull_mount.glb'],
  ];
  return Promise.all(list.map(([k, p]) => _preload(k, p)));
}
