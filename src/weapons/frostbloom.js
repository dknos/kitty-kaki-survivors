/**
 * Frostbloom — aura weapon.
 * Emits an expanding cyan-white ring of frost at the hero every cooldown.
 * Enemies caught in the ring are frozen for `freezeDur` seconds (spd 0) and
 * take +25% damage from all sources while frozen (see enemies.js damageEnemy).
 *
 * Visual: 3 staggered textured-plane rings (rune-texture art) on the ground
 * using AdditiveBlending, each rotating with its own yaw drift so the pulse
 * reads as a layered spell circle rather than a single flat disc.
 */
import * as THREE from 'three';
import { state } from '../state.js';
import { damageEnemy, queryRadius } from '../enemies.js';
import { BLOOM_LAYER } from '../postfx.js';
import { sfx } from '../audio.js';
import { makeRuneRingTexture } from '../enemyTells.js';

// ── Shared geometry + material (cached across all rings) ─────────────────────
// Textured plane (1u radius equivalent) — uses the canonical rune ring art
// so each frost pulse reads as ice-mage glyph rather than a flat cyan donut.
// Per-instance materials are cloned so each of the 3 staggered rings can
// fade its own opacity and (subtly) drift its own yaw.
const RING_GEO = new THREE.PlaneGeometry(2.0, 2.0);
let _frostRuneTex = null;
function _getFrostTex() { return _frostRuneTex || (_frostRuneTex = makeRuneRingTexture()); }
function _makeFrostRingMat() {
  return new THREE.MeshBasicMaterial({
    map: _getFrostTex(),
    color: 0xbbf0ff,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

const _flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const _axisY = new THREE.Vector3(0, 1, 0);
const _quat = new THREE.Quaternion();
const RING_COUNT = 3;            // 3-ring stagger so the aura pulses
const RING_LIFE = 0.55;          // seconds each ring expands before fading
const RING_STAGGER = 0.10;       // seconds between successive ring spawns

function _makeRing() {
  const m = new THREE.Mesh(RING_GEO, _makeFrostRingMat());
  m.quaternion.copy(_flat);
  m.position.y = 0.06;
  m.visible = false;
  // Each ring carries its own yaw offset so the textured rune ticks don't
  // all align — kills the "lockstep" feel of using a single rune tex on
  // multiple stacked rings.
  m.userData.yawBase = Math.random() * Math.PI * 2;
  // The ring glow itself goes on the bloom layer for the dreamy frost halo.
  m.layers.enable(BLOOM_LAYER);
  return m;
}

export default {
  id: 'frostbloom',
  name: 'Frostbloom',
  desc: 'A frost aura pulses outward, freezing enemies and raising the damage they take',
  icon: '❄️',
  maxLevel: 8,
  levels: [
    { cooldown: 4.0, radius: 4.0, freezeDur: 1.0, dmg: 6  },
    { cooldown: 3.6, radius: 4.7, freezeDur: 1.15, dmg: 9  },
    { cooldown: 3.2, radius: 5.4, freezeDur: 1.25, dmg: 13 },
    { cooldown: 2.8, radius: 6.1, freezeDur: 1.4, dmg: 17 },
    { cooldown: 2.4, radius: 6.8, freezeDur: 1.55, dmg: 22 },
    { cooldown: 2.0, radius: 7.5, freezeDur: 1.7, dmg: 27 },
    { cooldown: 1.75, radius: 8.2, freezeDur: 1.85, dmg: 31 },
    { cooldown: 1.5, radius: 9.0, freezeDur: 2.0, dmg: 35 },
  ],

  init(state, level, inst) {
    inst.cd = 0.5;
    inst.rings = [];
    for (let i = 0; i < RING_COUNT; i++) {
      const m = _makeRing();
      state.scene.add(m);
      inst.rings.push({ mesh: m, age: -1, delay: i * RING_STAGGER });
    }
    inst._hit = null;
  },

  tick(state, dt, level, inst) {
    if (!inst.rings) return;
    const hero = state.hero.pos;
    const now = state.time.game;
    const areaMul = state.hero.statMul.area || 1;
    const radius = level.radius * areaMul;
    const dmgMul = state.hero.statMul.dmg || 1;
    const dmg = level.dmg * dmgMul;

    inst.cd -= dt;
    if (inst.cd <= 0) {
      // Iter 11a SHOP_TREE Power tier 2 "Quick Hands" composes with statMul.cooldown.
      inst.cd = level.cooldown * (state.hero.statMul.cooldown || 1) * (state.run.passive_cooldown || 1);
      // Start all rings at the hero's current position, with stagger delays.
      for (const r of inst.rings) {
        r.age = -r.delay;       // negative age means waiting on stagger
        r.x = hero.x;
        r.z = hero.z;
        r.maxR = radius;
      }
      // Damage + freeze application happens at the start of the pulse so the
      // visual ring traces an already-frozen wave (looks crunchier).
      const cand = queryRadius(hero, radius);
      if (cand && cand.length) {
        const freezeUntil = now + level.freezeDur;
        for (const e of cand) {
          if (!e || !e.alive) continue;
          damageEnemy(e, dmg, 'frostbloom');
          if (!e.alive) continue;
          // Apply freeze: halt + remember original spd for restore.
          if (!e._frozenUntil || e._frozenUntil < freezeUntil) {
            if (!e._frozenUntil) {
              e._frozenWasSpd = e.spd;
              e.spd = 0;
            }
            e._frozenUntil = freezeUntil;
          }
        }
      }
      try { sfx.weaponWeb && sfx.weaponWeb(); } catch (_) {}
    }

    // Advance rings. Each ring expands from 0 → maxR over RING_LIFE.
    // Re-orient each ring with a unique yaw + slow counter-spin so the rune
    // ticks visibly rotate (sells "spell circle inscribing itself").
    for (const r of inst.rings) {
      if (r.age < 0) { r.age += dt; r.mesh.visible = false; continue; }
      if (r.age > RING_LIFE) { r.mesh.visible = false; continue; }
      r.age += dt;
      const t = Math.min(1, r.age / RING_LIFE);
      const scale = (r.maxR || radius) * (0.1 + 0.9 * t);
      r.mesh.position.set(r.x, 0.06, r.z);
      r.mesh.scale.set(scale, scale, scale);
      // Compose flat orientation with a per-ring yaw drift so the textured
      // ticks don't lockstep visually.
      const yaw = (r.mesh.userData.yawBase || 0) + now * 0.8 + (r.delay * 6);
      _quat.setFromAxisAngle(_axisY, yaw);
      r.mesh.quaternion.multiplyQuaternions(_quat, _flat);
      r.mesh.material.opacity = 0.85 * (1 - t);
      r.mesh.visible = true;
    }
  },

  refresh(state, level, inst) {
    // Idempotent: just snap cd down so the higher-level pulse fires soon.
    if (inst.cd > level.cooldown * 0.5) inst.cd = level.cooldown * 0.25;
  },
};
