/**
 * Frost Eternal — Forest evolution-coffin superweapon (FE-V2 Coffins, 2026-05-17).
 *
 * Evolved variant of `frostbloom`, unlocked by opening an Evolution Coffin
 * in the Forest stage while holding `frostbloom` @ L8 and the paired passive
 * (`duration`) @ L5. See src/forestCoffins.js → FOREST_EVOLUTIONS.
 *
 * Mechanic delta vs base frostbloom:
 *   - Permanent slow aura around the hero (not a pulsed ring). Each tick
 *     (`AURA_TICK` cadence) deals `aura_dps * dt`-equivalent damage to
 *     every enemy inside `radius`, AND slows them to 50% speed for a
 *     short refreshable window. Hero never has "between pulses" downtime.
 *   - Freeze chance on hit. Per damage tick, each enemy rolls
 *     `freezeChance` to also get the freeze (state machine identical to
 *     base frostbloom — `e._frozenUntil` + `e._frozenWasSpd`).
 *   - Visual: 1 persistent textured rune ring on the ground at the hero's
 *     feet, slowly counter-rotating. No expanding/fading wave — sells
 *     "eternal" rather than "pulsing".
 *
 * Reuse: pulls the same rune texture and additive material recipe as
 * frostbloom (no new textures, no new geometries) so the upgrade reads as
 * "the bloom never stops".
 *
 * Constraints (FE-V2 Coffins brief):
 *   - 8 levels mirroring frostbloom.js shape (same level-count contract for
 *     descriptions.js STAT_FIELDS reuse).
 *   - hidden: true — never appears in the level-up card pool.
 *   - Static imports only.
 *   - Default export contract: { id, name, desc, icon, hidden, maxLevel,
 *     levels[], init, tick, refresh }.
 *   - Hot-path alloc-free: ring mesh is one-shot per init, ground tick
 *     scratch is module-scope quaternion+euler.
 */
import * as THREE from 'three';
import { state } from '../state.js';
import { damageEnemy, queryRadius } from '../enemies.js';
import { BLOOM_LAYER } from '../postfx.js';
import { sfx } from '../audio.js';
import { makeRuneRingTexture } from '../enemyTells.js';
import { spawnMagnetSpark } from '../fx.js';

// Aura mechanic constants. Tick cadence sized so the aura feels constant
// (4 ticks per second) but doesn't dominate the damage budget.
const AURA_TICK = 0.25; // seconds between damage/freeze passes

// Shared geometry + texture handles — created lazily on first init so
// module load doesn't touch THREE before the renderer is up.
const RING_GEO = new THREE.PlaneGeometry(2.0, 2.0);
let _frostRuneTex = null;
function _getFrostTex() { return _frostRuneTex || (_frostRuneTex = makeRuneRingTexture()); }
function _makeFrostRingMat() {
  return new THREE.MeshBasicMaterial({
    map: _getFrostTex(),
    color: 0xbbf0ff,
    transparent: true,
    opacity: 0.55, // softer than the base frostbloom pulse — reads as "ambient halo"
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

// Orientation scratch — module-scope so the tick is alloc-free.
const _flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const _axisY = new THREE.Vector3(0, 1, 0);
const _quat = new THREE.Quaternion();

export default {
  id: 'frost_eternal',
  name: 'Frost Eternal',
  desc: 'A permanent frost halo follows the hero, slowing and freezing nearby enemies',
  icon: '❄️',
  hidden: true, // FE-V2 Forest special — never in level-up card pool
  maxLevel: 8,
  // Level table mirrors frostbloom.js's shape (cooldown / dmg / radius /
  // freezeDur) plus an aura_dps field tuned for the aura tick. `cooldown`
  // is unused at runtime (aura is constant) but kept for descriptions.js
  // STAT_FIELDS reuse and tooltip symmetry.
  levels: [
    { cooldown: 0.25, dmg: 12, radius: 4.5, freezeDur: 1.0,  freezeChance: 0.10, aura_dps: 18  },
    { cooldown: 0.25, dmg: 17, radius: 5.0, freezeDur: 1.15, freezeChance: 0.12, aura_dps: 24  },
    { cooldown: 0.25, dmg: 23, radius: 5.5, freezeDur: 1.25, freezeChance: 0.14, aura_dps: 32  },
    { cooldown: 0.25, dmg: 30, radius: 6.0, freezeDur: 1.4,  freezeChance: 0.16, aura_dps: 42  },
    { cooldown: 0.25, dmg: 39, radius: 6.5, freezeDur: 1.55, freezeChance: 0.18, aura_dps: 54  },
    { cooldown: 0.25, dmg: 48, radius: 7.0, freezeDur: 1.7,  freezeChance: 0.20, aura_dps: 68  },
    { cooldown: 0.25, dmg: 56, radius: 7.5, freezeDur: 1.85, freezeChance: 0.22, aura_dps: 82  },
    { cooldown: 0.25, dmg: 64, radius: 8.0, freezeDur: 2.0,  freezeChance: 0.25, aura_dps: 96  },
  ],

  init(state, level, inst) {
    inst.tickCd = 0;
    inst.ring = null;
    if (state.scene) {
      const mesh = new THREE.Mesh(RING_GEO, _makeFrostRingMat());
      mesh.quaternion.copy(_flat);
      mesh.position.y = 0.05;
      mesh.layers.enable(BLOOM_LAYER);
      state.scene.add(mesh);
      inst.ring = mesh;
    }
    inst._sparkCd = 0;
  },

  tick(state, dt, level, inst) {
    const hero = state.hero && state.hero.pos;
    if (!hero) return;
    const areaMul = (state.hero.statMul && state.hero.statMul.area) || 1;
    const radius = level.radius * areaMul;
    const dmgMul = (state.hero.statMul && state.hero.statMul.dmg) || 1;

    // Ring follows the hero each frame; slow counter-spin from game time.
    if (inst.ring) {
      const now = state.time.game;
      inst.ring.position.set(hero.x, 0.05, hero.z);
      // Pin scale to radius so the visible halo matches the actual damage
      // radius (2u plane × scale = world units).
      const s = radius / 2.0;
      inst.ring.scale.set(s, s, s);
      const yaw = now * 0.4;
      _quat.setFromAxisAngle(_axisY, yaw);
      inst.ring.quaternion.multiplyQuaternions(_quat, _flat);
    }

    // Damage / slow / freeze pass on the aura cadence.
    inst.tickCd -= dt;
    if (inst.tickCd <= 0) {
      inst.tickCd = AURA_TICK;
      // Per-tick damage = aura_dps * AURA_TICK (so dps reads true at any
      // tick rate). Also apply slow + freeze on the same pass.
      const dmgPerTick = level.aura_dps * AURA_TICK * dmgMul;
      const freezeUntil = state.time.game + level.freezeDur;
      const cand = queryRadius(hero, radius);
      if (cand && cand.length) {
        for (const e of cand) {
          if (!e || !e.alive) continue;
          damageEnemy(e, dmgPerTick, 'frost_eternal');
          if (!e.alive) continue;
          // Freeze proc — same state machine as frostbloom: stash original
          // spd, zero spd, refresh expiry. Only chance-gated. Capture
          // _frozenWasSpd only when not already set (so a slow→freeze
          // upgrade on the same enemy doesn't latch the half-speed as
          // the restore value), but always set spd=0 on a freeze roll —
          // freeze is a strict upgrade over the slow window.
          if (Math.random() < level.freezeChance) {
            if (!e._frozenUntil) e._frozenWasSpd = e.spd;
            e.spd = 0;
            if (!e._frozenUntil || e._frozenUntil < freezeUntil) {
              e._frozenUntil = freezeUntil;
            }
          } else {
            // Apply / refresh a non-zero slow window. The enemies module
            // freeze unwind already restores _frozenWasSpd when
            // _frozenUntil elapses; we piggyback on the same slot but
            // store half-speed instead of zero. If a freeze is already
            // latched (spd === 0) we leave it alone — slow can't
            // downgrade a freeze.
            if (e._frozenUntil && e.spd === 0) {
              if (e._frozenUntil < freezeUntil) e._frozenUntil = freezeUntil;
            } else {
              if (!e._frozenUntil) {
                e._frozenWasSpd = e.spd;
                e.spd = e._frozenWasSpd * 0.5;
              }
              if (!e._frozenUntil || e._frozenUntil < freezeUntil) {
                e._frozenUntil = freezeUntil;
              }
            }
          }
        }
      }
      // Subtle sparkle drip — same fx pool as base frostbloom but at lower
      // density (2 sparks/tick vs 8/pulse) since the aura is constant.
      if (!state._optReduceMotion) {
        for (let i = 0; i < 2; i++) {
          const a = Math.random() * Math.PI * 2;
          const r = (0.4 + Math.random() * 0.5) * radius;
          const sx = hero.x + Math.cos(a) * r;
          const sz = hero.z + Math.sin(a) * r;
          spawnMagnetSpark(sx, 0.25 + Math.random() * 0.6, sz, 0xbbf0ff);
        }
      }
    }

    // Occasional aural confirm — ~1/sec at most. SFX falls back silently
    // if the bank is missing (audio.js _play() drops on missing).
    inst._sparkCd -= dt;
    if (inst._sparkCd <= 0) {
      inst._sparkCd = 1.0;
      try { sfx.weaponWeb && sfx.weaponWeb(); } catch (_) {}
    }
  },

  refresh(state, level, inst) {
    // No cooldown to snap — aura is constant. Re-apply ring scale on level
    // up so the new radius is visible immediately.
    if (inst && inst.ring) {
      const areaMul = (state.hero.statMul && state.hero.statMul.area) || 1;
      const r = (level.radius * areaMul) / 2.0;
      inst.ring.scale.set(r, r, r);
    }
  },
};
