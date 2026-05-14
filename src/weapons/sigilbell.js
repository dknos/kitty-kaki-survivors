/**
 * Sigil Bell — stationary placement weapon.
 * Every cooldown, drops a glowing rune sigil at the hero's CURRENT position.
 * After 2 seconds the sigil detonates: AoE damage in `radius` + 0.6s stun.
 * Up to `maxSigils` may be live at once; oldest is recycled when over cap.
 *
 * Visual: a flat CircleGeometry rune disc on the ground using AdditiveBlending,
 * color-cycling from cool white ramp-up to a red-hot burst flash at detonation.
 */
import * as THREE from 'three';
import { state } from '../state.js';
import { damageEnemy, queryRadius } from '../enemies.js';
import { BLOOM_LAYER } from '../postfx.js';
import { sfx } from '../audio.js';
import { makeRuneRingTexture } from '../enemyTells.js';
import { burstExplosion } from '../vfxBurst.js';
import { spawnKillRing } from '../fx.js';

// ── Shared geometry + material (cached across all sigils) ────────────────────
// Disc + rune-textured plane. The textured plane carries the canonical
// magic-circle art (ticks + cardinal glyphs) so the sigil reads as a
// hand-inked summoning rune instead of a stack of two flat colored shapes.
const SIGIL_GEO = new THREE.CircleGeometry(1.0, 32);
const RUNE_GEO = new THREE.PlaneGeometry(2.0, 2.0);

let _sigilRuneTex = null;
function _getSigilRuneTex() { return _sigilRuneTex || (_sigilRuneTex = makeRuneRingTexture()); }

function _makeSigilMat() {
  return new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}
function _makeRuneMat() {
  return new THREE.MeshBasicMaterial({
    map: _getSigilRuneTex(),
    color: 0xffffff,
    transparent: true,
    opacity: 0.0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

const _flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const _yawQ = new THREE.Quaternion();
const _axisY = new THREE.Vector3(0, 1, 0);
const SIGIL_TTL = 2.0;         // seconds from drop to detonation
const STUN_DUR = 0.6;          // seconds enemies are stunned on detonation

function _makeSigilMesh() {
  const g = new THREE.Group();
  const disc = new THREE.Mesh(SIGIL_GEO, _makeSigilMat());
  // Rune disc uses the textured ring art (overrides the old flat outline).
  const rune = new THREE.Mesh(RUNE_GEO, _makeRuneMat());
  disc.quaternion.copy(_flat);
  rune.quaternion.copy(_flat);
  disc.position.y = 0.04;
  rune.position.y = 0.05;
  // Random initial yaw so two adjacent sigils don't render identical glyph
  // orientation. We rotate during tick to sell "spell inscribing itself".
  rune.userData.yawBase = Math.random() * Math.PI * 2;
  disc.layers.enable(BLOOM_LAYER);
  rune.layers.enable(BLOOM_LAYER);
  g.add(disc);
  g.add(rune);
  return { group: g, disc, rune };
}

function _cleanupSigil(s, scene) {
  if (!s) return;
  if (s.mesh && s.mesh.parent) s.mesh.parent.remove(s.mesh);
  if (s.disc && s.disc.material) s.disc.material.dispose();
  if (s.rune && s.rune.material) s.rune.material.dispose();
}

function _detonate(s, level, dmgMul, areaMul) {
  const radius = level.radius * areaMul;
  const dmg = level.dmg * dmgMul;
  const cand = queryRadius({ x: s.x, z: s.z }, radius);
  if (cand && cand.length) {
    const now = state.time.game;
    const stunUntil = now + STUN_DUR;
    for (const e of cand) {
      if (!e || !e.alive) continue;
      damageEnemy(e, dmg, 'sigilbell');
      if (!e.alive) continue;
      // Brief stun reuses the frozen-state flag so enemies.js unfreeze block
      // handles restore. Falls back to a regular halt if not already frozen.
      if (!e._frozenUntil || e._frozenUntil < stunUntil) {
        if (!e._frozenUntil) {
          e._frozenWasSpd = e.spd;
          e.spd = 0;
        }
        e._frozenUntil = stunUntil;
      }
    }
  }
  // V2: layered detonation burst — flash + shockwave + smoke + embers via
  // the existing vfxBurst pool (5-layer atlas). The old visuals relied only
  // on bloomBoost; this gives the moment of detonation the same visual
  // density as a spider-web placement. Crimson-orange tint matches the
  // red-hot ramp the sigil already shows in its final 0.4s. A kill-ring
  // overlay caps the moment with a hard outline.
  burstExplosion(s.x, s.z, radius * 1.3, 0xff5a33);
  spawnKillRing(s.x, s.z, true);
  // Burst pop on FX channels (unchanged — drives postFX bloom + shake).
  state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.6);
  state.fx.shake = Math.max(state.fx.shake || 0, 0.15);
  try { sfx.weaponBurger && sfx.weaponBurger(); } catch (_) {}
}

export default {
  id: 'sigilbell',
  name: 'Sigil Bell',
  desc: 'Drops a sigil at your feet; it pulses, then detonates with a stunning blast',
  icon: '🔔',
  maxLevel: 8,
  levels: [
    { cooldown: 3.0, radius: 2.5, dmg: 12, maxSigils: 3 },
    { cooldown: 2.7, radius: 2.9, dmg: 18, maxSigils: 3 },
    { cooldown: 2.4, radius: 3.2, dmg: 25, maxSigils: 4 },
    { cooldown: 2.1, radius: 3.6, dmg: 33, maxSigils: 4 },
    { cooldown: 1.8, radius: 4.0, dmg: 41, maxSigils: 5 },
    { cooldown: 1.5, radius: 4.4, dmg: 49, maxSigils: 5 },
    { cooldown: 1.25, radius: 4.7, dmg: 57, maxSigils: 6 },
    { cooldown: 1.0, radius: 5.0, dmg: 65, maxSigils: 6 },
  ],

  init(state, level, inst) {
    inst.cd = 0.3;
    inst.sigils = [];
  },

  tick(state, dt, level, inst) {
    if (!inst.sigils) inst.sigils = [];
    const scene = state.scene;
    const hero = state.hero.pos;
    const areaMul = state.hero.statMul.area || 1;
    const dmgMul = state.hero.statMul.dmg || 1;
    const maxSigils = level.maxSigils;

    // Drop a new sigil when off cooldown
    inst.cd -= dt;
    if (inst.cd <= 0) {
      // Iter 11a SHOP_TREE Power tier 2 "Quick Hands" composes with statMul.cooldown.
      inst.cd = level.cooldown * (state.hero.statMul.cooldown || 1) * (state.run.passive_cooldown || 1);
      // Cap: if at maxSigils, detonate the oldest immediately to make room.
      while (inst.sigils.length >= maxSigils) {
        const old = inst.sigils.shift();
        _detonate(old, level, dmgMul, areaMul);
        _cleanupSigil(old, scene);
      }
      const built = _makeSigilMesh();
      built.group.position.set(hero.x, 0, hero.z);
      scene.add(built.group);
      // Start matching the level's display radius from the get-go.
      const r = level.radius * areaMul;
      built.group.scale.set(r, 1, r);
      inst.sigils.push({
        x: hero.x, z: hero.z,
        ttl: SIGIL_TTL,
        mesh: built.group,
        disc: built.disc,
        rune: built.rune,
      });
    }

    // Advance every sigil; detonate at ttl <= 0
    const tNow = state.time.game;
    for (let i = inst.sigils.length - 1; i >= 0; i--) {
      const s = inst.sigils[i];
      s.ttl -= dt;
      // Color cycle: white ramp-up (ttl 2..0.4) → red flash burst (ttl 0.4..0)
      const ramp = Math.max(0, Math.min(1, 1 - (s.ttl / SIGIL_TTL)));   // 0..1
      // Spin the textured rune disc so the ticks + cardinal glyphs read as
      // an inscribing spell circle. Slow during build, fast during red flash.
      const spinRate = s.ttl > 0.4 ? 0.8 : 4.0;
      const yaw = (s.rune.userData.yawBase || 0) + tNow * spinRate;
      _yawQ.setFromAxisAngle(_axisY, yaw);
      s.rune.quaternion.multiplyQuaternions(_yawQ, _flat);
      if (s.ttl > 0.4) {
        // Cool white build, growing opacity + a slow pulse
        const pulse = 0.4 + 0.3 * (0.5 + 0.5 * Math.sin(tNow * 8));
        s.disc.material.color.setHex(0xeaf2ff);
        s.rune.material.color.setHex(0xbbe6ff);
        s.disc.material.opacity = pulse * (0.4 + 0.6 * ramp);
        s.rune.material.opacity = (0.6 + 0.4 * ramp);
      } else {
        // Red-hot final ramp — flash to detonation
        const t = Math.max(0, Math.min(1, 1 - (s.ttl / 0.4)));   // 0..1
        s.disc.material.color.setHex(0xff5533);
        s.rune.material.color.setHex(0xffd24a);
        s.disc.material.opacity = 0.7 + 0.3 * t;
        s.rune.material.opacity = 0.95;
        // Slight scale shimmer during red phase
        const r0 = level.radius * areaMul;
        const k = 1 + 0.05 * Math.sin(tNow * 30);
        s.mesh.scale.set(r0 * k, 1, r0 * k);
      }
      if (s.ttl <= 0) {
        _detonate(s, level, dmgMul, areaMul);
        _cleanupSigil(s, scene);
        inst.sigils.splice(i, 1);
      }
    }
  },

  refresh(state, level, inst) {
    if (inst.cd > level.cooldown * 0.5) inst.cd = level.cooldown * 0.25;
  },
};
