/**
 * Cheesy Burgers — orbital weapon.
 * N burgers orbit the hero, damaging on contact (per-orb/per-enemy cooldown).
 * Each burger is a stacked group: bottom bun + patty + cheese square + top bun
 * with sesame seed dots. A flat additive glow disc sits under each one so they
 * still read as energy + pop under bloom.
 */
import * as THREE from 'three';
import { state } from '../state.js';
import { damageEnemy, queryRadius } from '../enemies.js';
import { tex } from '../particleTextures.js';
import { BLOOM_LAYER } from '../postfx.js';
import { cloneCached } from '../assets.js';
import { sfx } from '../audio.js';
import { makeRuneRingTexture } from '../enemyTells.js';

// Shared rune texture for the burger orbital ground halo. Lazy so we never
// build the canvas during module-init (browser tab may not yet have a doc).
let _orbRuneTex = null;
function _getOrbRuneTex() { return _orbRuneTex || (_orbRuneTex = makeRuneRingTexture()); }

// ── Shared geometries + materials (cached across all orbs for batching) ──
// Burger primitive now uses textured caps (sesame bun decal on top, cheese
// slice on patty) so the silhouette reads as food instead of stacked cylinders.
const BUN_GEO    = new THREE.CylinderGeometry(0.30, 0.34, 0.16, 18);
const TOP_BUN_GEO = new THREE.SphereGeometry(0.32, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2); // dome
const PATTY_GEO  = new THREE.CylinderGeometry(0.32, 0.32, 0.09, 18);
// Cheese slice is now a flat decal plane (was a 0.58 box that bloomed weirdly).
// Painted with cheeseSlice texture so we see the drips + outline, not a square.
const CHEESE_PLANE = new THREE.PlaneGeometry(0.72, 0.72);
const BUN_CAP_PLANE = new THREE.PlaneGeometry(0.66, 0.66);   // sesame decal on dome
const PATTY_CAP_PLANE = new THREE.PlaneGeometry(0.66, 0.66); // grill-mark decal on patty
const SHIMMER_PLANE = new THREE.PlaneGeometry(1.2, 1.2);     // heat shimmer behind burger
const SEED_GEO   = new THREE.SphereGeometry(0.035, 6, 5);

const BUN_MAT    = new THREE.MeshStandardMaterial({ color: 0xd99b54, roughness: 0.78, metalness: 0.0 });
const PATTY_MAT  = new THREE.MeshStandardMaterial({ color: 0x3e1f0e, roughness: 0.85, metalness: 0.0 });
const SEED_MAT   = new THREE.MeshStandardMaterial({ color: 0xf2e3b6, roughness: 0.7 });

// Lazy texture lookup: tex() requires initParticleTextures to have run, which
// happens at scene bootstrap. The orbitals module loads earlier in some import
// orders, so we resolve the textures inside _makeBurgerPrimitive.
function _bunCapMat() {
  return new THREE.MeshBasicMaterial({
    map: tex('bunCap'),
    transparent: true, depthWrite: false, side: THREE.DoubleSide, alphaTest: 0.05,
  });
}
function _cheeseMat(evolved) {
  return new THREE.MeshBasicMaterial({
    map: tex(evolved ? 'cheeseToxic' : 'cheeseSlice'),
    transparent: true, depthWrite: false, side: THREE.DoubleSide, alphaTest: 0.05,
  });
}
function _pattyCapMat() {
  return new THREE.MeshBasicMaterial({
    map: tex('pattyTop'),
    transparent: true, depthWrite: false, side: THREE.DoubleSide, alphaTest: 0.05,
  });
}

const GLOW_GEO = new THREE.PlaneGeometry(0.95, 0.95);
const GLOW_MAT = new THREE.MeshBasicMaterial({
  map: tex('glowGold'), color: 0xffd24a,
  transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending,
});

// Iter 32j — hit-radius was 0.55, visual mesh is ~0.95 wide. Enemies could
// pass through the visible orbital without colliding (user: "first hit of
// game passes through mob"). 1.0 matches the visual envelope and gives the
// orbital ring a slightly forgiving contact halo so fast-walking trash
// can't slip between adjacent orbitals at low levels (count=2).
const HIT_RADIUS = 1.0;
const _glowFlat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const _topDownFlat = new THREE.Euler(-Math.PI / 2, 0, 0);

// Build a fallback burger from primitives if no GLB is provided.
// Layered: bottom bun + grilled patty (with grill-mark decal on top face) +
// cheese slice decal (with drips + outline) + dome bun + sesame-cap decal.
// The painted decals carry the "hand-drawn food" silhouette so the burger
// reads as an oekaki-style sticker rather than primitive geometry.
function _makeBurgerPrimitive(evolved = false) {
  const g = new THREE.Group();
  // Bottom bun
  const bot = new THREE.Mesh(BUN_GEO, BUN_MAT);
  bot.position.y = 0.08;
  bot.castShadow = true;
  g.add(bot);
  // Patty
  const patty = new THREE.Mesh(PATTY_GEO, PATTY_MAT);
  patty.position.y = 0.20;
  g.add(patty);
  // Grill-mark decal on top of patty (faces up, alpha-tested)
  const pattyDecal = new THREE.Mesh(PATTY_CAP_PLANE, _pattyCapMat());
  pattyDecal.rotation.copy(_topDownFlat);
  pattyDecal.position.y = 0.248;
  g.add(pattyDecal);
  // Cheese slice decal (drips + outline)
  const cheese = new THREE.Mesh(CHEESE_PLANE, _cheeseMat(evolved));
  cheese.rotation.copy(_topDownFlat);
  cheese.rotation.z = Math.PI / 6;
  cheese.position.y = 0.27;
  g.add(cheese);
  // Dome bun
  const top = new THREE.Mesh(TOP_BUN_GEO, BUN_MAT);
  top.scale.set(1.0, 0.85, 1.0);
  top.position.y = 0.28;
  top.castShadow = true;
  g.add(top);
  // Sesame cap decal — top-down sticker on the dome (where seeds would be)
  const bunDecal = new THREE.Mesh(BUN_CAP_PLANE, _bunCapMat());
  bunDecal.rotation.copy(_topDownFlat);
  bunDecal.position.y = 0.555;
  g.add(bunDecal);
  // Three 3D sesame seeds for parallax richness — kept small so the decal
  // does the heavy lifting and these add depth at iso angle.
  const seedPositions = [
    [-0.10, 0.55, -0.06],
    [ 0.12, 0.55,  0.04],
    [ 0.00, 0.55,  0.13],
  ];
  for (const [x, y, z] of seedPositions) {
    const s = new THREE.Mesh(SEED_GEO, SEED_MAT);
    s.position.set(x, y, z);
    g.add(s);
  }
  return g;
}

// Auto-fit a cloned GLB to a target bounding-box height (in world units),
// so any donated cheeseburger model — regardless of authored scale or pivot —
// reads at the right size as an orbital. Centers on origin too.
const TARGET_HEIGHT = 0.95;     // matches the primitive's silhouette
function _normalizeBurgerGlb(root) {
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const h = Math.max(0.001, size.y);
  const k = TARGET_HEIGHT / h;
  root.scale.multiplyScalar(k);
  // Recompute center post-scale and shift so origin sits at the burger base.
  root.position.x -= center.x * k;
  root.position.y -= (center.y - size.y / 2) * k;
  root.position.z -= center.z * k;
  // Cast/receive shadows so the orbital looks grounded.
  root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return root;
}

// Try the GLB first; fall back to primitives if missing.
// `evolved` swaps to the Double Cheeseburger model (Toxic Halo evolution).
// Even when the GLB is used we layer a sesame decal + cheese drip on top
// so the orbital reads as deliberate art at all camera angles. The decal
// planes use alpha-tested cutouts so they don't blow out under bloom.
function _makeBurger(evolved = false) {
  const key = evolved ? 'burger_evo' : 'burger';
  const glb = cloneCached(key) || cloneCached('burger');  // graceful evo fallback
  if (glb) {
    const wrap = new THREE.Group();
    const norm = _normalizeBurgerGlb(glb);
    wrap.add(norm);
    // Layer a top-down sesame decal floating just above the GLB so even
    // donated models read as "kitty kaki burger" silhouette from iso camera.
    // Important: GLB body geometry would z-occlude a decal placed inside its
    // bounding box, so we (a) lift the decal slightly ABOVE the GLB top and
    // (b) disable depth test + bump render order so it always reads on top.
    const bunDecal = new THREE.Mesh(BUN_CAP_PLANE, _bunCapMat());
    bunDecal.material.depthTest = false;
    bunDecal.rotation.copy(_topDownFlat);
    bunDecal.position.y = TARGET_HEIGHT + 0.04;
    bunDecal.scale.setScalar(0.85);
    bunDecal.renderOrder = 3;
    wrap.add(bunDecal);
    // If evolved, layer a second toxic-green cheese drip ABOVE the GLB so
    // the player can tell at-a-glance that Toxic Halo is active. Same
    // depth-test override so the GLB never hides the toxic tell.
    if (evolved) {
      const toxicDecal = new THREE.Mesh(CHEESE_PLANE, _cheeseMat(true));
      toxicDecal.material.depthTest = false;
      toxicDecal.rotation.copy(_topDownFlat);
      toxicDecal.position.y = TARGET_HEIGHT + 0.02;
      toxicDecal.scale.setScalar(1.05);
      toxicDecal.renderOrder = 2;
      wrap.add(toxicDecal);
    }
    return wrap;
  }
  return _makeBurgerPrimitive(evolved);
}

function spawnOrbs(level, inst) {
  const scene = state.scene;
  inst.orbs = [];
  const evolved = !!inst.evolved;
  for (let i = 0; i < level.count; i++) {
    const group = new THREE.Group();
    // Burger stack — stays on the default render layer. BLOOM_LAYER is for
    // glowy emissives; putting the burger on it makes the bloom pass render
    // each mesh in isolation against black, then additive-composite it back,
    // which produced the ghostly "blue square" look the player flagged.
    const burger = _makeBurger(evolved);
    group.add(burger);
    // ── Layered ground FX ──
    // 1. Rune disc base — the canonical magic-AoE art under the burger so
    //    the orbital reads as a sacred relic, not a floating sandwich.
    const runeMat = new THREE.MeshBasicMaterial({
      map: _getOrbRuneTex(),
      color: evolved ? 0xa8ff3a : 0xffd24a,
      transparent: true, opacity: 0.55,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const rune = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), runeMat);
    rune.quaternion.copy(_glowFlat);
    rune.position.y = -0.42;
    rune.layers.enable(BLOOM_LAYER);
    group.add(rune);
    // 2. Soft glow halo (kept from the original art) — sits between rune and burger
    const glowMat = new THREE.MeshBasicMaterial({
      map: tex('glowGold'),
      color: evolved ? 0xa8ff3a : 0xffd24a,
      transparent: true, opacity: 0.45,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const glow = new THREE.Mesh(GLOW_GEO, glowMat);
    glow.quaternion.copy(_glowFlat);
    glow.position.y = -0.38;
    glow.layers.enable(BLOOM_LAYER);
    group.add(glow);
    // 3. Heat shimmer billboard — soft warm glow that pulses, sells "freshly
    //    grilled". For Toxic Halo this becomes the dripping poison aura.
    const shimmerMat = new THREE.MeshBasicMaterial({
      map: tex(evolved ? 'sparkCyan' : 'glowGold'),
      color: evolved ? 0xa8ff3a : 0xff9a3a,
      transparent: true, opacity: evolved ? 0.55 : 0.30,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const shimmer = new THREE.Mesh(SHIMMER_PLANE, shimmerMat);
    shimmer.quaternion.copy(_glowFlat);
    shimmer.position.y = -0.45;
    shimmer.layers.enable(BLOOM_LAYER);
    group.add(shimmer);
    group.position.copy(state.hero.pos);
    group.position.y = 0.5;
    scene.add(group);
    inst.orbs.push({
      mesh: group,
      core: burger,
      glow,
      rune,
      shimmer,
      angle: (i / level.count) * Math.PI * 2,
      lastHitTime: new Map(),
    });
  }
}

function disposeOrbs(inst) {
  if (!inst.orbs) return;
  const scene = state.scene;
  for (const o of inst.orbs) {
    if (o.mesh) scene.remove(o.mesh);
  }
  inst.orbs = null;
}

export default {
  id: 'orbitals',
  name: 'Cheesy Burgers',
  desc: 'Sacred cheeseburgers orbit you, smashing what they touch',
  icon: '🍔',
  maxLevel: 8,
  levels: [
    { count: 2, dmg: 8,  radius: 2.5, rotSpeed: 2.4, dmgInterval: 0.5 },
    { count: 3, dmg: 10, radius: 2.6, rotSpeed: 2.6, dmgInterval: 0.45 },
    { count: 3, dmg: 13, radius: 2.8, rotSpeed: 2.8, dmgInterval: 0.4 },
    { count: 4, dmg: 16, radius: 3.0, rotSpeed: 2.9, dmgInterval: 0.4 },
    { count: 4, dmg: 20, radius: 3.2, rotSpeed: 3.0, dmgInterval: 0.35 },
    { count: 5, dmg: 25, radius: 3.4, rotSpeed: 3.0, dmgInterval: 0.3 },
    { count: 5, dmg: 32, radius: 3.6, rotSpeed: 3.2, dmgInterval: 0.3 },
    { count: 6, dmg: 40, radius: 3.8, rotSpeed: 3.4, dmgInterval: 0.25 },
  ],

  init(state, level, inst) {
    spawnOrbs(level, inst);
  },

  tick(state, dt, level, inst) {
    if (!inst.orbs) return;
    const hero = state.hero.pos;
    const now = state.time.game;
    const areaMul = state.hero.statMul.area || 1;
    const radius = level.radius * areaMul;
    const dmgMul = state.hero.statMul.dmg || 1;
    const evoMul = inst.evolved ? 2.5 : 1;
    const dmg = level.dmg * dmgMul * evoMul;
    const radiusFinal = radius * (inst.evolved ? 1.15 : 1);

    // Toxic Halo evo: swap to Double Cheeseburger model + recolor ground glow.
    // The base burger meshes get disposed/rebuilt instead of tinted in-place
    // (tinting GLB materials per-mesh was unreliable across the food pack).
    // spawnOrbs() now reads `inst.evolved` to bake the toxic decals + green
    // halo, so a clean re-spawn is all we need.
    if (inst.evolved && !inst._tinted) {
      inst._tinted = true;
      disposeOrbs(inst);
      spawnOrbs(level, inst);
    }

    // Layered pulses — each layer breathes at its own rhythm so the orbital
    // doesn't feel like a single static prop.
    const pulse        = 1 + Math.sin(now * 4) * 0.08;     // halo
    const runePulse    = 1 + Math.sin(now * 2.6) * 0.06;   // disc, slow
    const shimmerPulse = 1 + Math.sin(now * 7.2) * 0.14;   // shimmer, fast
    const shimmerAlpha = 0.25 + Math.abs(Math.sin(now * 3.5)) * 0.20;

    for (const orb of inst.orbs) {
      orb.angle += level.rotSpeed * dt;
      const x = hero.x + Math.cos(orb.angle) * radiusFinal;
      const z = hero.z + Math.sin(orb.angle) * radiusFinal;
      // Gentle vertical bob: each orb phased by its angle so the ring breathes.
      const bob = Math.sin(now * 3.1 + orb.angle * 2) * 0.06;
      orb.mesh.position.set(x, 0.5 + bob, z);
      // Self-spin so each burger reads as a tumbling object, not a sprite.
      if (orb.core) orb.core.rotation.y += dt * 1.8;
      if (orb.glow) orb.glow.scale.setScalar(pulse);
      if (orb.rune) {
        orb.rune.scale.setScalar(runePulse);
        orb.rune.rotation.z = (orb.rune.rotation.z || 0) + dt * 0.6;
      }
      if (orb.shimmer) {
        orb.shimmer.scale.setScalar(shimmerPulse);
        orb.shimmer.material.opacity = shimmerAlpha * (inst.evolved ? 1.8 : 1.0);
      }

      // Collision check
      const candidates = queryRadius(orb.mesh.position, HIT_RADIUS);
      if (!candidates || candidates.length === 0) continue;
      for (const enemy of candidates) {
        if (!enemy || !enemy.alive) continue;
        const last = orb.lastHitTime.get(enemy) || -Infinity;
        if (now - last >= level.dmgInterval) {
          const src = inst.evolved ? 'toxic_halo' : 'orbitals';
          damageEnemy(enemy, dmg, src);
          try { sfx.weaponBurger(); } catch (_) {}
          orb.lastHitTime.set(enemy, now);
          // Toxic Halo: stamp a poison DoT (1s @ dmg/2 per second)
          if (inst.evolved) {
            enemy._dotDps = dmg * 0.5;
            enemy._dotUntil = now + 1.0;
            enemy._dotSource = src;
          }
        }
      }
    }
  },

  refresh(state, level, inst) {
    disposeOrbs(inst);
    spawnOrbs(level, inst);
  },
};
