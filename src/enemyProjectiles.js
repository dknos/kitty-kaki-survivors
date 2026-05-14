/**
 * Enemy projectile system. Wizards (and future ranged tiers) fire from
 * `enemies.js`. This module owns the visuals + movement + hero collision.
 */
import * as THREE from 'three';
import { state } from './state.js';
import { takeDamage as heroTakeDamage } from './hero.js';
import { tex } from './particleTextures.js';
import { BLOOM_LAYER } from './postfx.js';

const HIT_R = 0.9;
const HIT_R2 = HIT_R * HIT_R;
const WORLD_BOUND = 80;
const _flatX = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));

// Shared geometry — caching keeps draw-call count flat across the swarm.
// Per-projectile materials are cloned so we can color-shift each bolt to its
// damage type (magic/fire/ice). All meshes ride BLOOM_LAYER so they punch
// through the post bloom pass.
const _coreGeo = new THREE.SphereGeometry(0.22, 10, 10);
const _glowGeo = new THREE.PlaneGeometry(1.0, 1.0);
const _trailGeo = new THREE.PlaneGeometry(1, 1);

// Color palette per damage source. Default ('magic') for backwards-compat
// with callers that don't pass a kind.
const _projKinds = {
  magic: { tex: 'wizardBolt', core: 0xff9af0, glow: 0xff66ee, trail: 0xff66ee },
  fire:  { tex: 'fireBolt',   core: 0xffd28a, glow: 0xff7a3a, trail: 0xff7a3a },
  ice:   { tex: 'iceBolt',    core: 0xeaf6ff, glow: 0x88ddff, trail: 0x88ddff },
};

function _mkCoreMat(hex) {
  return new THREE.MeshBasicMaterial({ color: hex });
}
function _mkGlowMat(texName, hex) {
  return new THREE.MeshBasicMaterial({
    map: tex(texName) || tex('glowGold'),
    color: hex,
    transparent: true, opacity: 0.85,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
}
function _mkTrailMat(hex) {
  return new THREE.MeshBasicMaterial({
    map: tex('glowWhite'),
    color: hex,
    transparent: true, opacity: 0.55,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
}

/**
 * Spawn an enemy projectile at (x,y,z) aimed at the hero. ttl in seconds.
 * Optional `kind` controls the visual palette ('magic' default | 'fire' | 'ice').
 */
export function spawnEnemyProjectile(x, y, z, dmg = 9, speed = 9, ttl = 2.4, kind = 'magic') {
  const hero = state.hero.pos;
  const dx = hero.x - x;
  const dz = hero.z - z;
  const d = Math.hypot(dx, dz) || 1;
  const vx = (dx / d) * speed;
  const vz = (dz / d) * speed;

  const palette = _projKinds[kind] || _projKinds.magic;
  const group = new THREE.Group();
  const core = new THREE.Mesh(_coreGeo, _mkCoreMat(palette.core));
  const glow = new THREE.Mesh(_glowGeo, _mkGlowMat(palette.tex, palette.glow));
  glow.quaternion.copy(_flatX);
  glow.position.y = -0.05;
  core.layers.enable(BLOOM_LAYER);
  glow.layers.enable(BLOOM_LAYER);
  group.add(core);
  group.add(glow);
  // Motion trail — flat additive plane stretched along velocity. Acts as a
  // silhouette so the player can clock the projectile path before it lands.
  const trail = new THREE.Mesh(_trailGeo, _mkTrailMat(palette.trail));
  // Stretch along world Z (the direction we'll rotate the group toward).
  const yaw = Math.atan2(vx, vz);
  trail.rotation.order = 'YXZ';
  trail.rotation.x = -Math.PI / 2;
  trail.rotation.y = yaw;
  trail.position.y = -0.08;
  trail.scale.set(0.42, 1.6, 1);   // width, length, _
  trail.layers.enable(BLOOM_LAYER);
  group.add(trail);
  group.position.set(x, y || 1.0, z);
  state.scene.add(group);

  state.enemyProjectiles.active.push({
    mesh: group, vx, vz, ttl, dmg,
    core, glow, trail,
    // age accumulator for pulse animation
    age: 0,
  });
}

export function updateEnemyProjectiles(dt) {
  const list = state.enemyProjectiles.active;
  const heroPos = state.hero.pos;
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    p.mesh.position.x += p.vx * dt;
    p.mesh.position.z += p.vz * dt;
    p.ttl -= dt;
    p.age = (p.age || 0) + dt;
    // Glow pulse: sells "live magic energy" vs an inert sprite.
    if (p.glow) {
      const pulse = 1 + Math.sin(p.age * 14) * 0.18;
      p.glow.scale.set(pulse, pulse, pulse);
      p.glow.rotation.z = (p.glow.rotation.z || 0) + dt * 4.2;
    }
    if (p.core) {
      const corePulse = 1 + Math.sin(p.age * 22) * 0.12;
      p.core.scale.setScalar(corePulse);
    }
    if (p.trail) {
      // Trail flickers length so the projectile reads as motion vs static.
      p.trail.scale.set(0.42, 1.6 + Math.sin(p.age * 18) * 0.18, 1);
      p.trail.material.opacity = 0.4 + 0.2 * Math.abs(Math.sin(p.age * 12));
    }

    // Out-of-range or expired
    const dx = p.mesh.position.x - heroPos.x;
    const dz = p.mesh.position.z - heroPos.z;
    const d2 = dx * dx + dz * dz;
    if (p.ttl <= 0 || Math.abs(dx) > WORLD_BOUND || Math.abs(dz) > WORLD_BOUND) {
      // Dispose cloned per-projectile materials so we don't leak.
      if (p.core && p.core.material) p.core.material.dispose();
      if (p.glow && p.glow.material) p.glow.material.dispose();
      if (p.trail && p.trail.material) p.trail.material.dispose();
      state.scene.remove(p.mesh);
      list.splice(i, 1);
      continue;
    }
    // Hero collision
    if (d2 <= HIT_R2) {
      heroTakeDamage(p.dmg);
      if (p.core && p.core.material) p.core.material.dispose();
      if (p.glow && p.glow.material) p.glow.material.dispose();
      if (p.trail && p.trail.material) p.trail.material.dispose();
      state.scene.remove(p.mesh);
      list.splice(i, 1);
      continue;
    }
  }
}
