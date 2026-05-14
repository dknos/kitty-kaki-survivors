/**
 * Enemy system: pooled meshes, spatial hash, seek-hero + light separation,
 * contact damage, and a damage interface for weapons.
 *
 * Highest-risk module: must hold 200+ active enemies at 60fps. To that end:
 *  - No `new` calls in hot loops (temp vectors are module-scoped).
 *  - No skeletal animation mixers — meshes are static (faster + zero allocs).
 *  - Proximity via SpatialHash, never raycasting.
 *  - Pools keyed by glb key; prewarm hides first-horde stall.
 */
import * as THREE from 'three';
import { state } from './state.js';
import { ENEMY_TIERS, POOL_PREWARM, SPATIAL, HERO, SPAWN, DAMAGE } from './config.js';
import { cloneCached, GLTF_CACHE, getClips, findClip, upgradeMaterials, injectVertAnim } from './assets.js';
import { takeDamage as heroTakeDamage } from './hero.js';
import { dropGem } from './xp.js';
import { spawnDamageNumber } from './damageNumbers.js';
import { spawnKillRing } from './fx.js';
import { spawnEnemyProjectile } from './enemyProjectiles.js';
import { spawnChest } from './chest.js';
import { spawnHeart, spawnStar, spawnBomb, spawnFreeze, spawnChicken } from './pickups.js';
import { sfx } from './audio.js';
import { notifyStageEnemySpawn, notifyStageEnemyKill } from './stageRules.js';

// ── Module-scope temp vectors (reuse, never `new` in update loops) ────────────
const _tmpDir   = new THREE.Vector3();
const _tmpPush  = new THREE.Vector3();
const _tmpDelta = new THREE.Vector3();

const HERO_RADIUS = 0.4;
const ENEMY_RADIUS = 0.5;            // flat per spec
const CONTACT_RADIUS = HERO_RADIUS + ENEMY_RADIUS; // ~0.9; spec says ~1.0
const CONTACT_CD = 0.5;
const SEPARATION_DIST = 1.0;
const SEPARATION_NEIGHBORS = 3;
const CONTACT_DIST_SQ = 1.0 * 1.0;   // use a friendly 1.0 unit total contact

let _scene = null;
let _loggedSizes = null;
let _loggedClips = null;

// ── Tier lookup ───────────────────────────────────────────────────────────────
const _tierByGlb = Object.create(null);
for (const t of ENEMY_TIERS) _tierByGlb[t.glb] = t;

// ─────────────────────────────────────────────────────────────────────────────
// SpatialHash
// ─────────────────────────────────────────────────────────────────────────────
class SpatialHash {
  constructor(cellSize) {
    this.cellSize = cellSize;
    /** @type {Map<string, any[]>} */
    this.cells = new Map();
  }

  _key(cx, cz) { return cx + '_' + cz; }
  _cellCoord(v) { return Math.floor(v / this.cellSize); }

  insert(enemy) {
    const p = enemy.mesh.position;
    const cx = this._cellCoord(p.x);
    const cz = this._cellCoord(p.z);
    const key = this._key(cx, cz);
    enemy._spatialKey = key;
    let bucket = this.cells.get(key);
    if (!bucket) { bucket = []; this.cells.set(key, bucket); }
    bucket.push(enemy);
  }

  remove(enemy) {
    const key = enemy._spatialKey;
    if (key == null) return;
    const bucket = this.cells.get(key);
    if (!bucket) { enemy._spatialKey = null; return; }
    const i = bucket.indexOf(enemy);
    if (i !== -1) {
      // swap-pop
      const last = bucket.length - 1;
      if (i !== last) bucket[i] = bucket[last];
      bucket.pop();
    }
    if (bucket.length === 0) this.cells.delete(key);
    enemy._spatialKey = null;
  }

  /** Call after position update. Rehashes only if cell changed. */
  move(enemy) {
    const p = enemy.mesh.position;
    const cx = this._cellCoord(p.x);
    const cz = this._cellCoord(p.z);
    const key = this._key(cx, cz);
    if (key === enemy._spatialKey) return;
    this.remove(enemy);
    enemy._spatialKey = key;
    let bucket = this.cells.get(key);
    if (!bucket) { bucket = []; this.cells.set(key, bucket); }
    bucket.push(enemy);
  }

  /**
   * Returns array of active enemies within radius r of pos.
   * Iterates all cells overlapping the bounding box of the circle.
   */
  queryRadius(pos, r) {
    const out = [];
    const cs = this.cellSize;
    const minCX = Math.floor((pos.x - r) / cs);
    const maxCX = Math.floor((pos.x + r) / cs);
    const minCZ = Math.floor((pos.z - r) / cs);
    const maxCZ = Math.floor((pos.z + r) / cs);
    const rSq = r * r;
    for (let cx = minCX; cx <= maxCX; cx++) {
      for (let cz = minCZ; cz <= maxCZ; cz++) {
        const bucket = this.cells.get(this._key(cx, cz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const e = bucket[i];
          if (!e.alive) continue;
          const dx = e.mesh.position.x - pos.x;
          const dz = e.mesh.position.z - pos.z;
          if (dx * dx + dz * dz <= rSq) out.push(e);
        }
      }
    }
    return out;
  }

  clear() { this.cells.clear(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Init / pooling
// ─────────────────────────────────────────────────────────────────────────────
export function initEnemies(scene) {
  _scene = scene;
  state.enemies.spatial = new SpatialHash(SPATIAL.cellSize);
  state.enemies.pools = {};
  state.enemies.active.length = 0;
}

function _makePooledMesh(glbKey, scale) {
  const mesh = cloneCached(glbKey);
  if (!mesh) return null;
  // Roughness picks: bugs (chitinous) shimmer slightly, elites stand out shinier.
  let rough = null;
  const tierCfg = _tierByGlb[glbKey];
  if (tierCfg && tierCfg.elite) rough = 0.55;            // elite = glossier
  else if (tierCfg && tierCfg.procAnim) rough = 0.65;    // bugs = mid-gloss chitin
  upgradeMaterials(mesh, 0.55, rough);     // Lambert/Phong → Standard + envMap

  // Per-pool-mesh material clones — required for per-instance damage flash
  // (cloneCached shares materials across instances by default).
  const flashMats = [];
  mesh.traverse(o => {
    if (!o.isMesh || !o.material) return;
    if (Array.isArray(o.material)) {
      o.material = o.material.map(m => m.clone());
      for (const m of o.material) flashMats.push({ mat: m, origEmissive: m.emissive ? m.emissive.getHex() : 0x000000, origIntensity: m.emissiveIntensity || 0 });
    } else {
      o.material = o.material.clone();
      flashMats.push({ mat: o.material, origEmissive: o.material.emissive ? o.material.emissive.getHex() : 0x000000, origIntensity: o.material.emissiveIntensity || 0 });
    }
  });
  mesh.userData.flashMats = flashMats;

  // Per-instance hue jitter for bug-tier meshes so a swarm reads as individuals.
  // Skip Quaternius rigged models — their colors are part of the character design.
  const _tier = _tierByGlb[glbKey];
  if (_tier && _tier.procAnim) {
    const hueShift = (Math.random() - 0.5) * 0.18;   // ±9% hue rotation
    const valJitter = 1 + (Math.random() - 0.5) * 0.18;
    const _hsl = { h: 0, s: 0, l: 0 };
    for (const fm of flashMats) {
      if (!fm.mat || !fm.mat.color) continue;
      fm.mat.color.getHSL(_hsl);
      _hsl.h = (_hsl.h + hueShift + 1) % 1;
      _hsl.l = Math.max(0, Math.min(1, _hsl.l * valJitter));
      fm.mat.color.setHSL(_hsl.h, _hsl.s, _hsl.l);
      fm.mat.needsUpdate = true;
    }
  }

  // Ghost-style: cool blue tint + translucent
  if (glbKey === 'ghost') {
    mesh.traverse(o => {
      if (o.isMesh && o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          m.transparent = true;
          m.opacity = 0.55;
          m.depthWrite = false;
          if (m.color) m.color.lerp(new THREE.Color(0xaad8ff), 0.5);
          if (m.emissive) m.emissive.set(0x223355);
          m.emissiveIntensity = 0.4;
          m.needsUpdate = true;
        }
      }
    });
  }

  // Auto-fit: derive scale from bbox so swap-ins don't break sizing.
  // tier.scale acts as a multiplier on "1 hero-unit tall" baseline (~2 world units).
  // Update world matrix so bbox is correct (cloned scenes are dirty by default).
  mesh.updateMatrixWorld(true);
  const rawBox = new THREE.Box3().setFromObject(mesh);
  const raw = rawBox.getSize(new THREE.Vector3());
  const baseFit = raw.y > 1e-6 ? 2.0 / raw.y : 1;
  mesh.userData.baseFit = baseFit;
  mesh.scale.setScalar(baseFit * scale);
  // Many Quaternius models have origin at center/chest. After scaling, measure
  // bbox.min.y and stash so spawnEnemy can lift the model so feet sit on ground.
  mesh.updateMatrixWorld(true);
  const fitBox = new THREE.Box3().setFromObject(mesh);
  mesh.userData.yOffset = -fitBox.min.y;
  if (!_loggedSizes) {
    _loggedSizes = {};
  }
  if (!_loggedSizes[glbKey]) {
    _loggedSizes[glbKey] = true;
    console.log(`[enemy:${glbKey}] raw=${raw.x.toFixed(2)}x${raw.y.toFixed(2)}x${raw.z.toFixed(2)} fit=${baseFit.toFixed(3)} yOffset=${mesh.userData.yOffset.toFixed(2)}`);
  }
  mesh.visible = false;
  mesh.position.set(0, mesh.userData.yOffset, 0);

  // Animation mixer: attach a mixer + the model's first animation clip if any.
  // We pre-warm the mixer here so spawnEnemy doesn't pay the cost mid-game.
  const clips = getClips(glbKey);
  if (clips.length > 0) {
    const mixer = new THREE.AnimationMixer(mesh);
    const clip = findClip(clips, 'walk', 'run', 'move', 'idle');
    if (clip) {
      const action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.play();
      mesh.userData.hasClip = true;
    }
    mesh.userData.mixer = mixer;
    mesh.userData.mixerPhase = Math.random() * 1.2;
  }
  if (!_loggedClips) _loggedClips = {};
  if (!_loggedClips[glbKey]) {
    _loggedClips[glbKey] = true;
    console.log(`[enemy:${glbKey}] clips: ${clips.length} ${clips.map(c => c.name).join(',')}`);
  }

  // Vertex-shader animation for static GLBs (no skeleton/clips).
  // Drives leg/wing motion via uniform `vertTime` updated each frame.
  const tier = _tierByGlb[glbKey];
  if (tier && tier.procAnim && clips.length === 0) {
    mesh.userData.vertAnimMats = injectVertAnim(mesh, tier.procAnim);
  }
  return mesh;
}

export function prewarmPools() {
  for (const key of Object.keys(POOL_PREWARM)) {
    const tier = _tierByGlb[key];
    if (!tier) { console.warn(`[enemies] prewarm: no tier for "${key}"`); continue; }
    if (!GLTF_CACHE[key]) { console.warn(`[enemies] prewarm: GLTF "${key}" not loaded`); continue; }

    const n = POOL_PREWARM[key];
    const pool = state.enemies.pools[key] || (state.enemies.pools[key] = []);
    for (let i = 0; i < n; i++) {
      const mesh = _makePooledMesh(key, tier.scale);
      if (!mesh) break;
      _scene.add(mesh);
      pool.push(mesh);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Spawn / kill
// ─────────────────────────────────────────────────────────────────────────────
export function spawnEnemy(tierConfig, x, z) {
  const key = tierConfig.glb;
  let pool = state.enemies.pools[key];
  if (!pool) pool = state.enemies.pools[key] = [];

  let mesh = pool.pop();
  if (!mesh) {
    // Pool exhausted — clone fresh and warn (means POOL_PREWARM was too small).
    console.warn(`[enemies] pool empty for "${key}" — cloning mid-game`);
    mesh = _makePooledMesh(key, tierConfig.scale);
    if (!mesh) return null;
    _scene.add(mesh);
  }

  const fit = mesh.userData && mesh.userData.baseFit ? mesh.userData.baseFit : 1;
  mesh.scale.setScalar(fit * tierConfig.scale);
  // yOffset was computed at pool-time AFTER scale was applied — it's already in
  // world units. Do NOT multiply by tier.scale again (was clipping models into ground).
  const yOff = (mesh.userData && mesh.userData.yOffset) || 0;
  mesh.position.set(x, yOff, z);
  mesh.visible = true;

  /** @type {import('./state.js').EnemyInstance} */
  // Hyper mode: 1.5× HP/spd/dmg across the board.
  // Daily 'HARDER SPAWNS' modifier stacks an additional HP multiplier.
  // Stage 2+ also stacks an HP multiplier (e.g. Twilight Hollow = 1.30×).
  const hyper   = state.modes && state.modes.hyper ? 1.5 : 1;
  const dailyHp = state.run && state.run.dailyHpMul ? state.run.dailyHpMul : 1;
  const stageHp = state.run && state.run.stageHpMul ? state.run.stageHpMul : 1;
  const hpMul   = hyper * dailyHp * stageHp;
  const enemy = {
    mesh,
    glbKey: key,
    hp: tierConfig.hp * hpMul,
    hpMax: tierConfig.hp * hpMul,
    spd: tierConfig.spd * hyper,
    dmg: tierConfig.dmg * hyper,
    contactCooldown: 0,
    elite: !!tierConfig.elite,
    isFinalBoss: !!tierConfig.isFinalBoss,
    isMiniBoss: !!tierConfig.isMiniBoss,
    // Yaw offset added to atan2(dx,dz) when facing the hero.
    // - `faceFlip: true`  → π   (GLB authored facing +Z forward)
    // - `faceYaw: <rad>`  → arbitrary radian offset (e.g. ±π/2 for sideways)
    // faceYaw wins if both set.
    faceYaw: (typeof tierConfig.faceYaw === 'number')
      ? tierConfig.faceYaw
      : (tierConfig.faceFlip ? Math.PI : 0),
    alive: true,
    _spatialKey: null,
    knockVx: 0,
    knockVz: 0,
    slowMul: 1,
    _dotDps: 0,
    _dotUntil: 0,
    _flashUntil: 0,
    _wasFlashing: false,
    procAnim: tierConfig.procAnim || null,
    ranged: tierConfig.ranged || null,
    rangedCD: tierConfig.ranged ? (Math.random() * tierConfig.ranged.cooldown) : 0,
    _animPhase: Math.random() * 6,
    // yOffset is already in world units (computed post-scale at pool time)
    _baseY: (mesh.userData && mesh.userData.yOffset ? mesh.userData.yOffset : 0),
    _baseScale: (mesh.userData && mesh.userData.baseFit ? mesh.userData.baseFit : 1) * tierConfig.scale,
  };

  // If the mesh was just retrieved from pool with stale flash state, restore mats
  const fm = mesh.userData && mesh.userData.flashMats;
  if (fm) {
    for (const m of fm) {
      if (m.mat && m.mat.emissive) {
        m.mat.emissive.setHex(m.origEmissive);
        m.mat.emissiveIntensity = m.origIntensity;
      }
    }
  }

  // Selective shadow casting — only elites/mini/final cast real shadows.
  // Swarm enemies keep blob shadows for performance (200 casters would tank).
  const castOn = !!(tierConfig.elite || tierConfig.isMiniBoss || tierConfig.isFinalBoss);
  if (mesh.userData._castSet !== castOn) {
    mesh.traverse(o => { if (o.isMesh) o.castShadow = castOn; });
    mesh.userData._castSet = castOn;
  }

  state.enemies.spatial.insert(enemy);
  state.enemies.active.push(enemy);
  // Stage-rule spawn hook (e.g. per-stage tweaks to fresh enemies).
  try { notifyStageEnemySpawn(enemy); } catch (_) {}
  // Codex discovery: stamp the bestiary the first time we see this tier.
  try { import('./codex.js').then(({ notifyEnemySeen }) => notifyEnemySeen(key)); } catch (_) {}
  return enemy;
}

// Procedural body anim for static GLBs that have no AnimationMixer clip.
// Drives whole-mesh transform — no skeleton required.
function _applyProcAnim(e) {
  const m = e.mesh;
  const p = e._animPhase;
  const baseY = e._baseY || 0;
  const baseS = e._baseScale || 1;
  switch (e.procAnim) {
    case 'crawl': {
      // Subtle leg-compress: tiny scale pulse + tiny bob. NO body tilt (was
      // tipping the model through the ground at large amplitudes).
      const wob = Math.sin(p * 12);
      m.scale.x = baseS * (1 + wob * 0.04);
      m.scale.z = baseS * (1 - wob * 0.025);
      m.scale.y = baseS;
      m.position.y = baseY + Math.abs(wob) * 0.015;
      break;
    }
    case 'flap': {
      // Wing flap — scale X big amplitude reads as wings closing/opening from iso
      const flap = Math.sin(p * 18);
      m.scale.x = baseS * (1 + flap * 0.30);
      m.scale.z = baseS * (1 - flap * 0.08);
      m.scale.y = baseS;
      m.position.y = baseY + Math.sin(p * 4) * 0.35 + 0.2;
      break;
    }
    case 'hover': {
      // Rapid wing micro-jitter + soft float
      m.scale.x = baseS * (1 + Math.sin(p * 60) * 0.08);
      m.scale.z = baseS;
      m.scale.y = baseS;
      m.position.y = baseY + Math.sin(p * 6) * 0.20 + 0.25;
      break;
    }
    case 'hop': {
      // Vertical bounce — modest height so it doesn't read as flying
      const h = Math.max(0, Math.sin(p * 3.5));
      m.position.y = baseY + h * 0.30;
      // Slight squash on contact (frame where h ≈ 0)
      const squash = 1 - (1 - h) * 0.10;
      m.scale.y = baseS * squash;
      break;
    }
    case 'inch': {
      // Accordion squash along length
      const s = Math.sin(p * 4.5);
      m.scale.x = baseS * (1 + s * 0.14);
      m.scale.z = baseS * (1 - s * 0.10);
      m.scale.y = baseS;
      m.position.y = baseY + Math.abs(s) * 0.03;
      break;
    }
    case 'pad': {
      // Quadruped padding gait — gentle vertical bob + slight side-to-side
      // shoulder roll. Reads as a wolf/dog stalking forward.
      const stride = Math.sin(p * 8);
      const roll   = Math.sin(p * 4);     // half-frequency = shoulder sway
      m.position.y = baseY + Math.abs(stride) * 0.08;
      m.scale.x = baseS * (1 + stride * 0.05);
      m.scale.z = baseS * (1 - stride * 0.03);
      m.scale.y = baseS * (1 + Math.abs(stride) * 0.02);
      m.rotation.z = roll * 0.07;
      break;
    }
  }
}

export function killEnemy(enemy) {
  if (!enemy.alive) return;
  enemy.alive = false;
  enemy.mesh.visible = false;

  // Totem branch: custom death handling lives in src/totems.js (drops chest,
  // schedules respawn, removes mesh from scene since totems aren't pooled).
  if (enemy.isTotem) {
    state.enemies.spatial.remove(enemy);
    const idx = state.enemies.active.indexOf(enemy);
    if (idx >= 0) state.enemies.active.splice(idx, 1);
    import('./totems.js').then(({ onTotemKilled }) => onTotemKilled(enemy));
    return;
  }
  // Pylon branch: same shape — custom mesh, custom death drops.
  if (enemy.isPylon) {
    state.enemies.spatial.remove(enemy);
    const idx = state.enemies.active.indexOf(enemy);
    if (idx >= 0) state.enemies.active.splice(idx, 1);
    import('./pylons.js').then(({ onPylonKilled }) => onPylonKilled(enemy));
    return;
  }
  // Bell branch: same shape — risk/reward, guaranteed chest + ember bonus.
  if (enemy.isBell) {
    state.enemies.spatial.remove(enemy);
    const idx = state.enemies.active.indexOf(enemy);
    if (idx >= 0) state.enemies.active.splice(idx, 1);
    import('./bells.js').then(({ onBellKilled }) => onBellKilled(enemy));
    return;
  }

  // Clean up any in-progress boss telegraph ring attached to this enemy
  if (enemy._tellRing) {
    if (enemy._tellRing.parent) enemy._tellRing.parent.remove(enemy._tellRing);
    enemy._tellRing = null;
  }
  enemy._windupStart = -1;
  enemy._telegraphInit = false;

  // Kill ring fx (no ring on final boss — covered by victory cinematic)
  if (!enemy.isFinalBoss) {
    spawnKillRing(enemy.mesh.position.x, enemy.mesh.position.z, enemy.elite);
  }

  // Drops: heart (HP) and star (gem vacuum). Elites guaranteed-ish.
  if (!enemy.isFinalBoss) {
    const heartRoll = enemy.elite ? 1.0 : 0.05;
    if (Math.random() < heartRoll) {
      spawnHeart(enemy.mesh.position.x, enemy.mesh.position.z);
    }
    const starRoll = enemy.elite ? 0.50 : 0.02;
    if (Math.random() < starRoll) {
      spawnStar(enemy.mesh.position.x + (enemy.elite ? 1 : 0), enemy.mesh.position.z);
    }
  }
  // Elites have a chance to drop a chest at their death position
  if (enemy.elite && !enemy.isFinalBoss && !enemy.isMiniBoss && Math.random() < SPAWN.chestEliteDropChance) {
    spawnChest(enemy.mesh.position.x, enemy.mesh.position.z);
  }
  // Mini-boss: guaranteed chest + 2 hearts + 1 star + 1 bomb (proper reward).
  if (enemy.isMiniBoss) {
    const ex = enemy.mesh.position.x, ez = enemy.mesh.position.z;
    spawnChest(ex, ez);
    spawnHeart(ex - 1.2, ez);
    spawnHeart(ex + 1.2, ez);
    spawnStar(ex, ez + 1.2);
    spawnBomb(ex, ez - 1.2);
  }
  // Rare drops from regular kills: bomb 0.3%, freeze 0.5%, chicken 0.2%.
  if (!enemy.isFinalBoss && !enemy.isMiniBoss) {
    const r = Math.random();
    if (r < 0.003) spawnBomb(enemy.mesh.position.x, enemy.mesh.position.z);
    else if (r < 0.008) spawnFreeze(enemy.mesh.position.x, enemy.mesh.position.z);
    else if (r < 0.010) spawnChicken(enemy.mesh.position.x, enemy.mesh.position.z);
  }
  // Elites: 8% freeze, 5% chicken (in addition to baseline rolls)
  if (enemy.elite && !enemy.isFinalBoss && !enemy.isMiniBoss) {
    if (Math.random() < 0.08) spawnFreeze(enemy.mesh.position.x, enemy.mesh.position.z);
    if (Math.random() < 0.05) spawnChicken(enemy.mesh.position.x, enemy.mesh.position.z);
  }
  // Final boss always drops a chest (player can still grab it after victory anim — fine)
  if (enemy.isFinalBoss) {
    spawnChest(enemy.mesh.position.x + 2, enemy.mesh.position.z);
  }

  // Drop XP gem (final boss drops a bigger reward)
  dropGem(enemy.mesh.position.clone(),
    enemy.isFinalBoss ? 25 : (enemy.elite ? 5 : 1));

  state.run.kills++;
  state.run.noDmgKills = (state.run.noDmgKills || 0) + 1;
  // Codex: bump kill tally for this tier (silently throttled in codex.js).
  try { import('./codex.js').then(({ notifyEnemyKilled }) => notifyEnemyKilled(enemy.glbKey)); } catch (_) {}
  // Tutorial: 3-kill auto-advance for stage 2.
  import('./tutorial.js').then(({ notifyTutorialEvent }) => notifyTutorialEvent('enemyKill'));
  // Stage-rule kill hook (e.g. Cinder "Eruption" bonus heart near puddles).
  try { notifyStageEnemyKill(enemy); } catch (_) {}

  // Vampirism passive: heal a small flat amount per kill, capped at level value.
  const vampHpPerKill = state.run.passive_vampHpPerKill || 0;
  if (vampHpPerKill > 0 && state.hero.hp < state.hero.hpMax) {
    state.hero.hp = Math.min(state.hero.hpMax, state.hero.hp + vampHpPerKill);
  }

  // Quest progress hooks — increment hunt/boss counters at the source.
  import('./meta.js').then(({ questEvent, grantSigils }) => {
    questEvent('kill', { tier: enemy.glbKey });
    if (enemy.isMiniBoss)  { questEvent('miniBoss');  grantSigils(1, 'miniBoss'); }
    if (enemy.isFinalBoss) { questEvent('finalBoss'); grantSigils(5, 'finalBoss'); }
  });

  // Achievements
  import('./ui.js').then(({ tryAchievement, trySecret }) => {
    tryAchievement('first_kill');
    if (enemy.elite) tryAchievement('first_elite');
    if (state.run.kills >= 100) tryAchievement('kills_100');
    // Secret: Flawless — 100 kills this run without taking damage
    if (state.run.flawless && state.run.noDmgKills >= 100) trySecret('pacifist_100');
  });

  // Secret: lifetime bug kills (tiers with procAnim are the forest-bug set)
  const tier = _tierByGlb[enemy.glbKey];
  if (tier && tier.procAnim) {
    import('./meta.js').then(({ bumpLifetime }) => {
      const total = bumpLifetime('bugKills', 1);
      if (total >= 500) import('./ui.js').then(({ trySecret }) => trySecret('bug_lord'));
    });
  }

  // Final boss kill = victory (or just a banner in Endless mode)
  if (enemy.isFinalBoss && !state.gameOver) {
    state.fx.bloomBoost = 1.0;
    state.fx.shake = 0.9;
    if (sfx && sfx.victory) sfx.victory();
    import('./ui.js').then(({ tryAchievement }) => tryAchievement('first_victory'));
    // Roll + persist a relic for the death-screen reveal.
    import('./meta.js').then(({ rollRelic, addRelic }) => {
      const drop = rollRelic();
      addRelic(drop);
      state.run.relicDrop = drop;
    });
    if (state.modes && state.modes.endless) {
      // Endless: don't end the run. Drop another reward chest and let the run continue.
      import('./chest.js').then(({ spawnChest }) => {
        spawnChest(enemy.mesh.position.x + 2, enemy.mesh.position.z);
        spawnChest(enemy.mesh.position.x - 2, enemy.mesh.position.z);
      });
      import('./ui.js').then(({ showBanner }) => showBanner('THE NIGHTMARE CONTINUES', 4.0, '#ff5555'));
    } else {
      state.gameOver = true;
      state.victory = true;
      state.dyingUntil = state.time.real + 1.2;
    }
  }

  // Mini-boss tally
  if (enemy.isMiniBoss) {
    state.run.miniBossKills = (state.run.miniBossKills || 0) + 1;
    if (state.run.miniBossKills >= 3) {
      import('./ui.js').then(({ tryAchievement }) => tryAchievement('minibox_x3'));
    }
  }

  // Return mesh to pool
  const pool = state.enemies.pools[enemy.glbKey] || (state.enemies.pools[enemy.glbKey] = []);
  pool.push(enemy.mesh);

  // Remove from spatial hash
  state.enemies.spatial.remove(enemy);

  // Splice from active list
  const arr = state.enemies.active;
  const i = arr.indexOf(enemy);
  if (i !== -1) {
    const last = arr.length - 1;
    if (i !== last) arr[i] = arr[last];
    arr.pop();
  }

  if (sfx) {
    if (enemy.elite || enemy.isMiniBoss || enemy.isFinalBoss) {
      if (sfx.eliteDeath) sfx.eliteDeath();
    } else if (sfx.enemyDeath) {
      sfx.enemyDeath();
    }
  }
}

// Heavy throttle counter for enemyHurt — 1-in-4 calls actually fire (in
// addition to audio.js's own 30ms gap). Prevents a wall of crit-pings during
// large swarms while keeping per-hit feedback present.
let _enemyHurtCounter = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Damage interface (called by weapons)
// ─────────────────────────────────────────────────────────────────────────────
export function damageEnemy(enemy, dmg, source) {
  if (!enemy || !enemy.alive) return;
  // Variance + crit rolls (DoT skips crit by passing dmg with isDoT flag in future)
  const variance = 1 + (Math.random() - 0.5) * 2 * DAMAGE.variance;
  const isCrit = Math.random() < DAMAGE.critChance;
  // Frostbloom freeze (and Sigil Bell stun): frozen enemies take +25% damage.
  const frozenMul = (enemy._frozenUntil && state.time.game < enemy._frozenUntil) ? 1.25 : 1;
  // Berserk passive: damage scales with hero's missing HP.
  const berserkMax = state.run.passive_berserkMax || 0;
  const hpPct = state.hero.hpMax > 0 ? state.hero.hp / state.hero.hpMax : 1;
  const berserkMul = berserkMax > 0 ? (1 + berserkMax * Math.max(0, 1 - hpPct)) : 1;
  const finalDmg = dmg * variance * (isCrit ? DAMAGE.critMul : 1) * frozenMul * berserkMul;
  enemy.hp -= finalDmg;
  state.run.dmgDealt += finalDmg;
  state.run._dpsWin.push([state.time.game, finalDmg]);
  // Per-source damage tally (drives the death-screen breakdown).
  const src = source || enemy._dmgSource || 'other';
  if (!state.run.dmgByWeapon) state.run.dmgByWeapon = {};
  state.run.dmgByWeapon[src] = (state.run.dmgByWeapon[src] || 0) + finalDmg;
  spawnDamageNumber(enemy.mesh.position, finalDmg, isCrit);
  enemy._flashUntil = state.time.game + (isCrit ? 0.14 : 0.08);
  // Light "ow" tick — heavy 1-in-4 throttle on top of audio.js's per-method gap.
  if ((++_enemyHurtCounter & 3) === 0 && sfx && sfx.enemyHurt) sfx.enemyHurt();
  if (isCrit) state.fx.shake = Math.max(state.fx.shake || 0, 0.20);
  if (enemy.hp <= 0) {
    // Hit-stop + shake: bigger for elites. Normal kills get only hit-stop —
    // shake on every kill made the camera vibrate constantly mid-swarm.
    const stopDur = enemy.elite ? 0.10 : 0.03;
    const shakeAmt = enemy.elite ? 0.35 : 0.00;
    if (state.fx.hitStop < stopDur) state.fx.hitStop = stopDur;
    if (shakeAmt > 0 && state.fx.shake < shakeAmt) state.fx.shake = shakeAmt;
    killEnemy(enemy);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-frame update
// ─────────────────────────────────────────────────────────────────────────────
export function updateEnemies(dt) {
  const heroPos = state.hero.pos;
  const active = state.enemies.active;
  const spatial = state.enemies.spatial;

  // Iterate backwards so killEnemy splices are safe (it uses swap-pop too,
  // but backward iteration plays nicest with any future direct splicing).
  for (let i = active.length - 1; i >= 0; i--) {
    const e = active[i];
    if (!e.alive) continue;

    const ep = e.mesh.position;
    // ── Animation mixer ──
    const mixer = e.mesh.userData && e.mesh.userData.mixer;
    if (mixer) mixer.update(dt);

    // ── Procedural animation (only if no GLB clip is playing) ──
    if (e.procAnim && !(e.mesh.userData && e.mesh.userData.hasClip)) {
      e._animPhase += dt;
      _applyProcAnim(e);
      // Drive shader-vertex anim uniforms
      const vmats = e.mesh.userData && e.mesh.userData.vertAnimMats;
      if (vmats) {
        for (const m of vmats) {
          const sh = m.userData && m.userData._vertAnimShader;
          if (sh && sh.uniforms && sh.uniforms.vertTime) {
            sh.uniforms.vertTime.value = e._animPhase;
          }
        }
      }
    }

    // ── Damage flash: white emissive briefly on hit ──
    const flashMats = e.mesh.userData && e.mesh.userData.flashMats;
    if (flashMats) {
      const isFlashing = e._flashUntil && state.time.game < e._flashUntil;
      if (isFlashing !== e._wasFlashing) {
        for (const fm of flashMats) {
          if (!fm.mat || !fm.mat.emissive) continue;
          if (isFlashing) {
            fm.mat.emissive.setHex(0xffffff);
            fm.mat.emissiveIntensity = 1.6;
          } else {
            fm.mat.emissive.setHex(fm.origEmissive);
            fm.mat.emissiveIntensity = fm.origIntensity;
          }
        }
        e._wasFlashing = isFlashing;
      }
    }

    // ── Seek hero ──
    _tmpDir.set(heroPos.x - ep.x, 0, heroPos.z - ep.z);
    const distSq = _tmpDir.x * _tmpDir.x + _tmpDir.z * _tmpDir.z;

    // ── Web slow check ──
    let slow = 1;
    const webs = state.webs.list;
    for (let w = 0; w < webs.length; w++) {
      const W = webs[w];
      if (W.ttl <= 0) continue;
      const wdx = ep.x - W.x, wdz = ep.z - W.z;
      if (wdx * wdx + wdz * wdz <= W.radius * W.radius) {
        if (W.slowMul < slow) slow = W.slowMul;
      }
    }
    // Stage-rule global slow (Forest "Overgrowth" spore pulse).
    const ruleSlow = (state.run && state.run.stageRuleEnemySlow) || 1;
    if (ruleSlow < slow) slow = ruleSlow;
    e.slowMul = slow;

    // ── Frost / stun: restore spd when freeze expires (Frostbloom + Sigil Bell) ──
    if (e._frozenUntil) {
      if (state.time.game >= e._frozenUntil) {
        if (e._frozenWasSpd !== undefined) {
          e.spd = e._frozenWasSpd;
          e._frozenWasSpd = undefined;
        }
        e._frozenUntil = 0;
      }
    }

    if (distSq > 1e-6) {
      const dist = Math.sqrt(distSq);
      const inv = 1 / dist;
      const dx = _tmpDir.x * inv;
      const dz = _tmpDir.z * inv;

      // Ranged AI: stop at `stopAt`, fire on cooldown when within `range`.
      const r = e.ranged;
      let walkScale = 1;
      if (r) {
        e.rangedCD -= dt * slow;
        if (dist <= r.range) {
          if (dist <= r.stopAt) {
            walkScale = -0.3;            // gentle backpedal so we don't get melee'd
          } else {
            walkScale = 0;               // hold position to cast
          }
          if (e.rangedCD <= 0) {
            e.rangedCD = r.cooldown;
            // Fire from chest height; spawn slightly forward of enemy toward hero
            spawnEnemyProjectile(
              ep.x + dx * 0.6,
              1.0,
              ep.z + dz * 0.6,
              r.projDmg, r.projSpeed, r.projTtl,
            );
          }
        }
      }

      // Walk (scaled by slow + rangedAI behavior + Cursed Bell enrage).
      // _flee inverts the seek direction (used by Treasure Goblin mini-event).
      const enrage = (e._enrageUntil && state.time.game < e._enrageUntil) ? 1.5 : 1.0;
      const fleeMul = e._flee ? -1 : 1;
      const step = e.spd * slow * enrage * dt * walkScale * fleeMul;
      ep.x += dx * step;
      ep.z += dz * step;

      // Face hero (XZ angle). Three.js: rotation.y of 0 looks down +Z;
      // atan2(x,z) is the standard "face this vector" formula.
      e.mesh.rotation.y = Math.atan2(dx, dz) + (e.faceYaw || 0);
    }

    // ── Poison DoT (Toxic Halo) ──
    if (e._dotUntil && state.time.game < e._dotUntil) {
      damageEnemy(e, (e._dotDps || 0) * dt, e._dotSource || 'orbitals');
      if (!e.alive) continue;
    }

    // Static destructibles (totems, pylons, bells) skip movement + contact;
    // their own tickers handle behavior. DoT/flash above still applies.
    if (e.isTotem || e.isPylon || e.isBell) continue;

    // ── Knockback velocity (from dash, etc.) — additive on top of walk ──
    if (e.knockVx !== 0 || e.knockVz !== 0) {
      ep.x += e.knockVx * dt;
      ep.z += e.knockVz * dt;
      // Exponential decay (fast — ~85% per frame at 60fps)
      const decay = Math.pow(0.0008, dt);
      e.knockVx *= decay;
      e.knockVz *= decay;
      if (Math.abs(e.knockVx) < 0.05) e.knockVx = 0;
      if (Math.abs(e.knockVz) < 0.05) e.knockVz = 0;
    }

    // ── Light separation ──
    // Query a small radius and push apart from up to 3 nearest neighbors.
    const neighbors = spatial.queryRadius(ep, SEPARATION_DIST);
    let pushed = 0;
    _tmpPush.set(0, 0, 0);
    for (let k = 0; k < neighbors.length && pushed < SEPARATION_NEIGHBORS; k++) {
      const o = neighbors[k];
      if (o === e || !o.alive) continue;
      const op = o.mesh.position;
      const ddx = ep.x - op.x;
      const ddz = ep.z - op.z;
      const dSq = ddx * ddx + ddz * ddz;
      if (dSq <= 1e-6 || dSq >= SEPARATION_DIST * SEPARATION_DIST) continue;
      const d = Math.sqrt(dSq);
      const overlap = (SEPARATION_DIST - d) / SEPARATION_DIST; // 0..1
      const inv = 1 / d;
      _tmpPush.x += ddx * inv * overlap;
      _tmpPush.z += ddz * inv * overlap;
      pushed++;
    }
    if (pushed > 0) {
      // Gentle nudge — keep magnitude < movement step so swarms still close.
      const pushStep = 1.5 * dt;
      ep.x += _tmpPush.x * pushStep;
      ep.z += _tmpPush.z * pushStep;
    }

    // ── Spatial hash position update ──
    spatial.move(e);

    // ── Contact damage ──
    if (e.contactCooldown > 0) e.contactCooldown -= dt;
    _tmpDelta.set(heroPos.x - ep.x, 0, heroPos.z - ep.z);
    const contactSq = _tmpDelta.x * _tmpDelta.x + _tmpDelta.z * _tmpDelta.z;
    if (contactSq <= CONTACT_DIST_SQ && e.contactCooldown <= 0) {
      const dmgMul = (e._enrageUntil && state.time.game < e._enrageUntil) ? 1.25 : 1.0;
      heroTakeDamage(e.dmg * dmgMul);
      e.contactCooldown = CONTACT_CD;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public spatial query (for weapons / AoE)
// ─────────────────────────────────────────────────────────────────────────────
export function queryRadius(pos, r) {
  if (!state.enemies.spatial) return [];
  return state.enemies.spatial.queryRadius(pos, r);
}
