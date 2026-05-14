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

// Bright cyan core + larger additive glow halo. Shared mats across instances.
const PROJ_CORE_GEO = new THREE.SphereGeometry(0.20, 10, 10);
const PROJ_CORE_MAT = new THREE.MeshBasicMaterial({ color: 0xeaf7ff });
const PROJ_GLOW_GEO = new THREE.PlaneGeometry(0.8, 0.8);
const PROJ_GLOW_MAT = new THREE.MeshBasicMaterial({
  map: tex('glowCyan'), color: 0x7fffe4,
  transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending,
});
const _glowFlat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));

const SEARCH_RADIUS = 40;
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

// Glasswind: pale-blue / ice-shard color overrides for the evolved missile.
const PROJ_CORE_MAT_ICE = new THREE.MeshBasicMaterial({ color: 0xd6ecff });
const PROJ_GLOW_MAT_ICE = new THREE.MeshBasicMaterial({
  map: tex('glowCyan'), color: 0xbfe0ff,
  transparent: true, opacity: 0.65, depthWrite: false, blending: THREE.AdditiveBlending,
});

function spawnProjectile(origin, dir, level, dmg, speedMul = 1, pierceBonus = 0, owner = 'autoaim', opts = null) {
  const ice = !!(opts && opts.ice);
  const scaleMul = (opts && opts.scale) || 1;
  const group = new THREE.Group();
  const core = new THREE.Mesh(PROJ_CORE_GEO, ice ? PROJ_CORE_MAT_ICE : PROJ_CORE_MAT);
  const glow = new THREE.Mesh(PROJ_GLOW_GEO, ice ? PROJ_GLOW_MAT_ICE : PROJ_GLOW_MAT);
  if (scaleMul !== 1) {
    core.scale.setScalar(scaleMul);
    glow.scale.setScalar(scaleMul);
  }
  glow.quaternion.copy(_glowFlat);
  glow.position.y = -0.05;
  glow.layers.enable(BLOOM_LAYER);
  core.layers.enable(BLOOM_LAYER);
  group.add(core);
  group.add(glow);
  group.position.set(origin.x, 0.5, origin.z);
  state.scene.add(group);
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
  state.projectiles.active.push(proj);
  return proj;
}

// Exported so the central projectile tick can spawn Glasswind shards on hit
// without re-importing autoAim internals. Spawns 2 perpendicular half-dmg shards.
export function spawnGlasswindShards(origin, parentVel, parentDmg) {
  // Perpendicular split: ±35° off the original heading.
  const baseAngle = Math.atan2(parentVel.z, parentVel.x);
  const speed = Math.hypot(parentVel.x, parentVel.z) || 1;
  for (const sign of [-1, 1]) {
    const a = baseAngle + sign * 0.6;
    const dir = { x: Math.cos(a), z: Math.sin(a) };
    const group = new THREE.Group();
    const core = new THREE.Mesh(PROJ_CORE_GEO, PROJ_CORE_MAT_ICE);
    const glow = new THREE.Mesh(PROJ_GLOW_GEO, PROJ_GLOW_MAT_ICE);
    core.scale.setScalar(0.6);
    glow.scale.setScalar(0.6);
    glow.quaternion.copy(_glowFlat);
    glow.position.y = -0.05;
    glow.layers.enable(BLOOM_LAYER);
    core.layers.enable(BLOOM_LAYER);
    group.add(core);
    group.add(glow);
    group.position.set(origin.x, 0.5, origin.z);
    state.scene.add(group);
    const vel = new THREE.Vector3(dir.x, 0, dir.z).multiplyScalar(speed * 0.9);
    state.projectiles.active.push({
      mesh: group,
      vel,
      dmg: parentDmg * 0.5,
      ttl: 0.8,
      pierce: 1,
      hit: new Set(),
      ownerWeapon: 'glasswind',
      noSplit: true,    // shards don't re-split
    });
  }
}

export default {
  id: 'autoaim',
  name: 'Magic Missile',
  desc: 'Auto-fires at the nearest enemy',
  icon: '✨',
  maxLevel: 8,
  levels: [
    { cooldown: 1.00, speed: 18, dmg: 12, ttl: 2.0, pierce: 1, count: 1 },
    { cooldown: 0.85, speed: 19, dmg: 16, ttl: 2.0, pierce: 1, count: 1 },
    { cooldown: 0.75, speed: 20, dmg: 22, ttl: 2.0, pierce: 2, count: 1 },
    { cooldown: 0.65, speed: 21, dmg: 30, ttl: 2.2, pierce: 2, count: 2 },
    { cooldown: 0.55, speed: 22, dmg: 40, ttl: 2.2, pierce: 3, count: 2 },
    { cooldown: 0.50, speed: 24, dmg: 54, ttl: 2.5, pierce: 3, count: 3 },
    { cooldown: 0.45, speed: 26, dmg: 70, ttl: 2.5, pierce: 4, count: 3 },
    { cooldown: 0.40, speed: 28, dmg: 90, ttl: 3.0, pierce: 4, count: 4 },
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
