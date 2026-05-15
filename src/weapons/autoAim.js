/**
 * Magic Missile — auto-aim projectile weapon.
 * Fires at the nearest enemy on cooldown. Projectile updates live in weapons/index.js.
 */
import * as THREE from 'three';
import { state } from '../state.js';
import { queryRadius } from '../enemies.js';
import { sfx } from '../audio.js';
import { tex } from '../particleTextures.js';
import { BLOOM_LAYER } from '../postfx.js';
import { getAimWorldPos } from '../input.js';
import { getMeta } from '../meta.js';

// iter 33s — replaced low-poly SphereGeometry core with stacked textured
// planes. Halo uses wizardBolt-style crackling magic texture (iceBolt for
// the cyan variant); core uses flashStar for a bright pinpoint sparkle.
// Both flat-on-ground (top-down ortho camera makes the planes read as
// natural billboards). Glasswind evolved uses snowflake core for an icy
// crystal look against a pale moteWhite trail tail.
const PROJ_HALO_GEO  = new THREE.PlaneGeometry(1.4, 1.4);
const PROJ_CORE_GEO  = new THREE.PlaneGeometry(0.65, 0.65);
const PROJ_TRAIL_GEO = new THREE.PlaneGeometry(1, 1);
// Materials are lazy because tex() resolves _cache from particleTextures,
// which is populated by initParticleTextures() at scene bootstrap. autoAim
// is imported earlier in some chains, so module-scope material creation
// would lock in map:null and the missile would render as a flat colored
// rectangle. First spawn after init resolves the real texture.
let _haloMat = null, _coreMat = null, _trailMat = null;
let _haloMatIce = null, _coreMatIce = null, _trailMatIce = null;
function _mkHaloMat() {
  return new THREE.MeshBasicMaterial({
    map: tex('iceBolt'), color: 0x9ee6ff,
    transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}
function _mkCoreMat() {
  return new THREE.MeshBasicMaterial({
    map: tex('flashStar'), color: 0xffffff,
    transparent: true, opacity: 1.0, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}
function _mkTrailMat() {
  return new THREE.MeshBasicMaterial({
    map: tex('moteCyan'), color: 0x9ee6ff,
    transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}
function _mkHaloMatIce() {
  return new THREE.MeshBasicMaterial({
    map: tex('iceBolt'), color: 0xcfeaff,
    transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}
function _mkCoreMatIce() {
  return new THREE.MeshBasicMaterial({
    map: tex('snowflake'), color: 0xeaf6ff,
    transparent: true, opacity: 1.0, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}
function _mkTrailMatIce() {
  return new THREE.MeshBasicMaterial({
    map: tex('moteWhite'), color: 0xc8e8ff,
    transparent: true, opacity: 0.75, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}
function _getHaloMat()      { return _haloMat      || (_haloMat      = _mkHaloMat()); }
function _getCoreMat()      { return _coreMat      || (_coreMat      = _mkCoreMat()); }
function _getTrailMat()     { return _trailMat     || (_trailMat     = _mkTrailMat()); }
function _getHaloMatIce()   { return _haloMatIce   || (_haloMatIce   = _mkHaloMatIce()); }
function _getCoreMatIce()   { return _coreMatIce   || (_coreMatIce   = _mkCoreMatIce()); }
function _getTrailMatIce()  { return _trailMatIce  || (_trailMatIce  = _mkTrailMatIce()); }
const _glowFlat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));

// ─────────────────────────────────────────────────────────────────────────────
// iter 33u — InstancedMesh visual pool for projectiles.
// Each projectile gets a slot in 2 capacity-256 InstancedMesh banks (normal +
// ice variant), 3 parts each (halo, core, trail) → 6 draws total regardless of
// projectile count. Was 3 draws/projectile, so at 91 alive saves ~270 calls.
// Per-slot rotation+scale matrix is baked at attach time; per-frame sync just
// rewrites the translation portion via Matrix4.setPosition().
// ─────────────────────────────────────────────────────────────────────────────
const CAP_PROJ = 256;
let _projInst = null;          // { haloN, coreN, trailN, haloI, coreI, trailI }
const _freeN = [];
const _freeI = [];
const _hideMat = new THREE.Matrix4();
_hideMat.compose(new THREE.Vector3(0, -1000, 0), new THREE.Quaternion(), new THREE.Vector3(0, 0, 0));
const _initialMat = new THREE.Matrix4();
const _scratchPos = new THREE.Vector3();
const _scratchScale = new THREE.Vector3();
const _scratchQuat = new THREE.Quaternion();
const _scratchEuler = new THREE.Euler();
let _projDirty = false;

export function initProjectileVisuals(scene) {
  if (_projInst) return;
  const mkInst = (geo, mat) => {
    const im = new THREE.InstancedMesh(geo, mat, CAP_PROJ);
    im.count = CAP_PROJ;
    im.frustumCulled = false;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.layers.enable(BLOOM_LAYER);
    for (let i = 0; i < CAP_PROJ; i++) im.setMatrixAt(i, _hideMat);
    im.instanceMatrix.needsUpdate = true;
    return im;
  };
  _projInst = {
    haloN:  mkInst(PROJ_HALO_GEO,  _getHaloMat()),
    coreN:  mkInst(PROJ_CORE_GEO,  _getCoreMat()),
    trailN: mkInst(PROJ_TRAIL_GEO, _getTrailMat()),
    haloI:  mkInst(PROJ_HALO_GEO,  _getHaloMatIce()),
    coreI:  mkInst(PROJ_CORE_GEO,  _getCoreMatIce()),
    trailI: mkInst(PROJ_TRAIL_GEO, _getTrailMatIce()),
  };
  scene.add(_projInst.haloN, _projInst.coreN, _projInst.trailN);
  scene.add(_projInst.haloI, _projInst.coreI, _projInst.trailI);
  for (let i = CAP_PROJ - 1; i >= 0; i--) {
    _freeN.push(i);
    _freeI.push(i);
  }
}

function _attachProjectileVisuals(proj, origin, dir, ice, scaleMul) {
  if (!_projInst) { proj._slot = -1; return; }
  const free = ice ? _freeI : _freeN;
  if (free.length === 0) { proj._slot = -1; return; }
  const slot = free.pop();
  proj._slot = slot;
  proj._ice = ice;
  // Halo + Core matrices: rotation x=-π/2, uniform scale.
  _scratchQuat.setFromEuler(_scratchEuler.set(-Math.PI / 2, 0, 0, 'XYZ'));
  const haloMat = new THREE.Matrix4();
  _scratchScale.set(scaleMul, scaleMul, scaleMul);
  _scratchPos.set(origin.x, 0.5 - 0.02, origin.z);
  haloMat.compose(_scratchPos, _scratchQuat, _scratchScale);
  const coreMat = new THREE.Matrix4();
  _scratchPos.set(origin.x, 0.5 + 0.01, origin.z);
  coreMat.compose(_scratchPos, _scratchQuat, _scratchScale);
  // Trail matrix: x=-π/2 then y=atan2(dx,dz). Euler order XYZ matches Three's
  // Object3D.rotation default — verified against enemyProjectiles' yaw pattern.
  _scratchQuat.setFromEuler(_scratchEuler.set(-Math.PI / 2, Math.atan2(dir.x, dir.z), 0, 'XYZ'));
  const trailMat = new THREE.Matrix4();
  _scratchScale.set(0.45 * scaleMul, 1.9 * scaleMul, scaleMul);
  _scratchPos.set(origin.x, 0.5 - 0.06, origin.z);
  trailMat.compose(_scratchPos, _scratchQuat, _scratchScale);
  proj._haloMat = haloMat;
  proj._coreMat = coreMat;
  proj._trailMat = trailMat;
  const halo  = ice ? _projInst.haloI  : _projInst.haloN;
  const core  = ice ? _projInst.coreI  : _projInst.coreN;
  const trail = ice ? _projInst.trailI : _projInst.trailN;
  halo.setMatrixAt(slot, haloMat);
  core.setMatrixAt(slot, coreMat);
  trail.setMatrixAt(slot, trailMat);
  _projDirty = true;
}

export function syncProjectileVisuals(proj) {
  if (!_projInst || proj._slot == null || proj._slot < 0) return;
  const ice = proj._ice;
  const halo  = ice ? _projInst.haloI  : _projInst.haloN;
  const core  = ice ? _projInst.coreI  : _projInst.coreN;
  const trail = ice ? _projInst.trailI : _projInst.trailN;
  const px = proj.mesh.position.x;
  const pz = proj.mesh.position.z;
  proj._haloMat.setPosition(px, 0.5 - 0.02, pz);
  proj._coreMat.setPosition(px, 0.5 + 0.01, pz);
  proj._trailMat.setPosition(px, 0.5 - 0.06, pz);
  halo.setMatrixAt(proj._slot, proj._haloMat);
  core.setMatrixAt(proj._slot, proj._coreMat);
  trail.setMatrixAt(proj._slot, proj._trailMat);
  _projDirty = true;
}

export function flushProjectileVisuals() {
  if (!_projInst || !_projDirty) return;
  _projInst.haloN.instanceMatrix.needsUpdate = true;
  _projInst.coreN.instanceMatrix.needsUpdate = true;
  _projInst.trailN.instanceMatrix.needsUpdate = true;
  _projInst.haloI.instanceMatrix.needsUpdate = true;
  _projInst.coreI.instanceMatrix.needsUpdate = true;
  _projInst.trailI.instanceMatrix.needsUpdate = true;
  _projDirty = false;
}

export function releaseProjectileVisuals(proj) {
  if (!_projInst || proj._slot == null || proj._slot < 0) return;
  const ice = proj._ice;
  const slot = proj._slot;
  const halo  = ice ? _projInst.haloI  : _projInst.haloN;
  const core  = ice ? _projInst.coreI  : _projInst.coreN;
  const trail = ice ? _projInst.trailI : _projInst.trailN;
  halo.setMatrixAt(slot, _hideMat);
  core.setMatrixAt(slot, _hideMat);
  trail.setMatrixAt(slot, _hideMat);
  _projDirty = true;
  (ice ? _freeI : _freeN).push(slot);
  proj._slot = -1;
}

// Hero-relative search radius for the auto-aim weapon (iter 33x). Camera is
// ortho half-height 28u, so anything beyond ~24u from the hero is on the edge
// of the screen or off-screen entirely. We cap the search at 18u so the
// weapon only ever locks onto enemies that read on-screen — no "auto-killing
// targets I can't see".
const SEARCH_RADIUS = 18;
const FAN_SPREAD = 0.18; // radians between fanned projectiles

function findNearestEnemy(pos) {
  // Try queryRadius first (uses spatial hash if available)
  let candidates = null;
  try { candidates = queryRadius(pos, SEARCH_RADIUS); } catch (_) { candidates = null; }
  if (!candidates || candidates.length === 0) candidates = state.enemies.active;
  if (!candidates || candidates.length === 0) return null;

  let best = null;
  let bestD2 = Infinity;
  for (const e of candidates) {
    if (!e || !e.alive) continue;
    const ep = e.mesh ? e.mesh.position : e.pos;
    if (!ep) continue;
    const dx = ep.x - pos.x;
    const dz = ep.z - pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = e; }
  }
  return best;
}


// Exported for sig kits (Phase D) so cowboy_sixshooter etc. can drop bullets
// through the same InstancedMesh pool instead of allocating their own draws.
// Same signature as the historic local function — kept stable for callers.
export function spawnAutoAimProjectile(origin, dir, level, dmg, speedMul = 1, pierceBonus = 0, owner = 'autoaim', opts = null) {
  return spawnProjectile(origin, dir, level, dmg, speedMul, pierceBonus, owner, opts);
}

function spawnProjectile(origin, dir, level, dmg, speedMul = 1, pierceBonus = 0, owner = 'autoaim', opts = null) {
  const ice = !!(opts && opts.ice);
  const scaleMul = (opts && opts.scale) || 1;
  // iter 33u — group is a position-only handle; visuals come from the
  // InstancedMesh pool. Group itself is NOT added to scene.
  const group = new THREE.Group();
  group.position.set(origin.x, 0.5, origin.z);
  const vel = new THREE.Vector3(dir.x, 0, dir.z).multiplyScalar(level.speed * (state.hero.statMul.projSpeed || 1) * speedMul);
  const proj = {
    mesh: group,
    vel,
    dmg,
    ttl: level.ttl * (state.hero.statMul.duration || 1),
    pierce: level.pierce + pierceBonus,
    hit: new Set(),
    ownerWeapon: owner,
  };
  if (opts) {
    if (opts.splitOnHit) proj.splitOnHit = true;
    if (opts.ttlOverride != null) proj.ttl = opts.ttlOverride;
    if (opts.pierceOverride != null) proj.pierce = opts.pierceOverride;
    if (opts.noSplit) proj.noSplit = true;
  }
  _attachProjectileVisuals(proj, origin, dir, ice, scaleMul);
  state.projectiles.active.push(proj);
  return proj;
}

// Exported so the central projectile tick can spawn Glasswind shards on hit
// without re-importing autoAim internals. Spawns 2 perpendicular half-dmg shards.
export function spawnGlasswindShards(origin, parentVel, parentDmg) {
  // Perpendicular split: ±35° off the original heading. Shards inherit the
  // parent's actual world-velocity (already statMul-scaled) so they don't
  // double-multiply via spawnProjectile's level.speed path.
  const baseAngle = Math.atan2(parentVel.z, parentVel.x);
  const speed = Math.hypot(parentVel.x, parentVel.z) || 1;
  for (const sign of [-1, 1]) {
    const a = baseAngle + sign * 0.6;
    const dir = { x: Math.cos(a), z: Math.sin(a) };
    const group = new THREE.Group();
    group.position.set(origin.x, 0.5, origin.z);
    const vel = new THREE.Vector3(dir.x, 0, dir.z).multiplyScalar(speed * 0.9);
    const proj = {
      mesh: group, vel,
      dmg: parentDmg * 0.5, ttl: 0.8, pierce: 1,
      hit: new Set(), ownerWeapon: 'glasswind', noSplit: true,
    };
    _attachProjectileVisuals(proj, origin, dir, true, 0.6);
    state.projectiles.active.push(proj);
  }
}

export default {
  id: 'autoaim',
  name: 'Magic Missile',
  desc: 'Auto-fires at the nearest enemy',
  icon: '✨',
  maxLevel: 8,
  levels: [
    // iter 33x — range is speed × ttl. Camera ortho half-height = 28u, so we
    // cap each level's max travel under 22u to keep projectiles within the
    // visible play area. Damage trimmed ~30% so the auto-aim doesn't trivialize
    // mid-tier mobs while the player is still levelling other weapons.
    { cooldown: 1.00, speed: 16, dmg:  8, ttl: 1.10, pierce: 1, count: 1 },
    { cooldown: 0.85, speed: 17, dmg: 11, ttl: 1.15, pierce: 1, count: 1 },
    { cooldown: 0.75, speed: 18, dmg: 15, ttl: 1.20, pierce: 2, count: 1 },
    { cooldown: 0.65, speed: 19, dmg: 21, ttl: 1.20, pierce: 2, count: 2 },
    { cooldown: 0.55, speed: 20, dmg: 28, ttl: 1.20, pierce: 3, count: 2 },
    { cooldown: 0.50, speed: 21, dmg: 38, ttl: 1.20, pierce: 3, count: 3 },
    { cooldown: 0.45, speed: 22, dmg: 50, ttl: 1.20, pierce: 4, count: 3 },
    { cooldown: 0.40, speed: 22, dmg: 63, ttl: 1.20, pierce: 4, count: 4 },
  ],

  init(state, level, inst) {
    inst.cd = 0; // fire immediately on first tick when an enemy is present
  },

  tick(state, dt, level, inst) {
    if (inst.cd === undefined) inst.cd = 0;
    inst.cd -= dt;
    if (inst.cd > 0) return;

    const hero = state.hero.pos;
    // Manual aim: fire toward the projected cursor world position instead of
    // the nearest enemy. Honored when meta.optManualAim is on.
    const meta = getMeta();
    let tp;
    if (meta && meta.optManualAim) {
      const aim = getAimWorldPos();
      tp = { x: aim.x, z: aim.z };
    } else {
      const target = findNearestEnemy(hero);
      if (!target) {
        inst.cd = 0.15;
        return;
      }
      tp = target.mesh ? target.mesh.position : target.pos;
    }
    const dx = tp.x - hero.x;
    const dz = tp.z - hero.z;
    const len = Math.hypot(dx, dz) || 1;
    const baseAngle = Math.atan2(dz, dx);

    const dmgMul = state.hero.statMul.dmg || 1;
    const evo = !!inst.evolved;
    // Glasswind: +50% projectiles per volley (rounded up, min +1), pale-blue
    // visual, and each bullet carries `splitOnHit` so the central projectile
    // tick spawns 2 half-damage ice shards on first hit.
    const dmg = level.dmg * dmgMul;
    const baseCount = level.count;
    const n = evo ? Math.max(baseCount + 1, Math.ceil(baseCount * 1.5)) : baseCount;
    const projSpeedMul = 1;
    const pierceBonus = 0;
    const spawnOpts = evo ? { ice: true, splitOnHit: true } : null;
    const ownerTag = evo ? 'glasswind' : 'autoaim';

    for (let i = 0; i < n; i++) {
      const offset = (i - (n - 1) / 2) * FAN_SPREAD;
      const a = baseAngle + offset;
      const dir = { x: Math.cos(a), z: Math.sin(a) };
      spawnProjectile(hero, dir, level, dmg, projSpeedMul, pierceBonus, ownerTag, spawnOpts);
    }

    try { sfx.weaponAutoaim(); } catch (_) {}

    // Iter 11a SHOP_TREE Power tier 2 "Quick Hands" multiplies on top of the
    // existing statMul.cooldown chain (passives/signature_tempo/Overdrive).
    inst.cd = level.cooldown * (state.hero.statMul.cooldown || 1) * (state.run.passive_cooldown || 1);
  },

  refresh(state, level, inst) {
    // Snap cooldown so the new level can fire promptly.
    if (inst.cd === undefined || inst.cd > level.cooldown) {
      inst.cd = Math.min(inst.cd ?? 0, level.cooldown * 0.25);
    }
  },
};
