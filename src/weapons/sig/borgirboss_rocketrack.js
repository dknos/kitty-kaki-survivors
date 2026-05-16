/**
 * Rocket Rack — BorgirBoss's signature weapon. The dump truck on his back
 * is a vertical-launch rocket pod: every cooldown the rack lobs a fan of
 * `count` rockets in a wide forward arc.
 *
 * Mechanic distinct from `cowboy_sixshooter` (tight stagger burst) and
 * `pipes_arcwrench` (single line-pierce bolt):
 *   - WIDE simultaneous fan, ~40° arc — reads as a missile-pod salvo, not
 *     a revolver dump or a railgun shot.
 *   - Rockets scale 1.5× the autoaim sprite for chunky silhouettes that
 *     hold up under bloom.
 *   - Higher per-shot damage but lower pierce: each rocket cracks one or
 *     two enemies, then dies — pairs with the Boom baseArchetype's
 *     Charged Coil signature for an occasional bonus volley.
 *
 * Reuses the autoaim projectile pool via spawnAutoAimProjectile so the
 * kit costs zero new draw calls (plan §2 #1). No new texture either —
 * stock gold-spark trail works because rockets read more by silhouette
 * than by hue under bloom.
 */
import { state } from '../../state.js';
import { sfx } from '../../audio.js';
import { spawnAutoAimProjectile } from '../autoAim.js';

const FAN_ARC = 0.72;   // ~41° total spread

function _findNearest(pos) {
  const cands = state.enemies && state.enemies.active;
  if (!cands || cands.length === 0) return null;
  let best = null, bestD2 = Infinity;
  for (const e of cands) {
    if (!e || !e.alive) continue;
    const ep = e.mesh ? e.mesh.position : e.pos;
    if (!ep) continue;
    const dx = ep.x - pos.x;
    const dz = ep.z - pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2 && d2 < 22 * 22) { bestD2 = d2; best = e; }
  }
  return best;
}

export default {
  id: 'sig_borgirboss_rocketrack',
  name: 'Rocket Rack',
  desc: 'Dump-truck rocket pod — wide fan of explosive shells.',
  icon: '🚀',
  maxLevel: 8,
  // Tuned against the Phase G band. The rocket rack is meant to feel HEAVY:
  // per-shot dmg sits above cowboy/pipes/bezelbug but pierce caps low and
  // cooldown is slower so packed-line eDPS doesn't outrun pipes' niche.
  // L8: 8 rockets × 80 dmg × pierce 2 / 1.10s ≈ 1160 packed-DPS — slightly
  // under pipes' 1090×spread, but the burst-front delivery feels harder.
  levels: [
    { cooldown: 1.60, speed: 18, dmg: 18, ttl: 1.10, pierce: 1, count: 3 },
    { cooldown: 1.50, speed: 19, dmg: 24, ttl: 1.10, pierce: 1, count: 4 },
    { cooldown: 1.40, speed: 20, dmg: 30, ttl: 1.10, pierce: 1, count: 4 },
    { cooldown: 1.30, speed: 21, dmg: 38, ttl: 1.15, pierce: 1, count: 5 },
    { cooldown: 1.25, speed: 22, dmg: 48, ttl: 1.15, pierce: 2, count: 6 },
    { cooldown: 1.20, speed: 22, dmg: 58, ttl: 1.20, pierce: 2, count: 6 },
    { cooldown: 1.15, speed: 23, dmg: 70, ttl: 1.20, pierce: 2, count: 7 },
    { cooldown: 1.10, speed: 24, dmg: 80, ttl: 1.20, pierce: 2, count: 8 },
  ],

  init(state, level, inst) { inst.cd = 0.3; },

  tick(state, dt, level, inst) {
    if (inst.cd === undefined) inst.cd = 0;
    inst.cd -= dt;
    if (inst.cd > 0) return;
    const hero = state.hero.pos;
    const target = _findNearest(hero);
    if (!target) { inst.cd = 0.18; return; }
    const tp = target.mesh ? target.mesh.position : target.pos;
    const baseAngle = Math.atan2(tp.z - hero.z, tp.x - hero.x);
    const dmg = level.dmg * (state.hero.statMul.dmg || 1);
    const n = level.count;
    const step = n > 1 ? FAN_ARC / (n - 1) : 0;
    for (let i = 0; i < n; i++) {
      const a = baseAngle + (i - (n - 1) / 2) * step;
      const dir = { x: Math.cos(a), z: Math.sin(a) };
      spawnAutoAimProjectile(hero, dir, level, dmg, 1, 0, 'sig_borgirboss_rocketrack', {
        pierceOverride: level.pierce,
        scale: 1.5,   // chunky rocket silhouette
      });
    }
    // Charged Coil (Boom archetype) — every 5th salvo gets a half-damage
    // mirror volley spawned a frame later. Mirrors pipes_arcwrench pattern.
    if (state.run.signature_chainEcho) {
      state.run.signature_chainEchoCounter = (state.run.signature_chainEchoCounter || 0) + 1;
      if (state.run.signature_chainEchoCounter >= 5) {
        state.run.signature_chainEchoCounter = 0;
        for (let i = 0; i < n; i++) {
          const a = baseAngle + (i - (n - 1) / 2) * step;
          const dir = { x: Math.cos(a), z: Math.sin(a) };
          spawnAutoAimProjectile(hero, dir, level, dmg * 0.5, 1, 0, 'sig_borgirboss_rocketrack', {
            pierceOverride: level.pierce, scale: 1.2,
          });
        }
      }
    }
    try { sfx.weaponAutoaim(); } catch (_) {}
    inst.cd = level.cooldown * (state.hero.statMul.cooldown || 1) * (state.run.passive_cooldown || 1);
  },

  refresh(state, level, inst) {
    if (inst.cd > level.cooldown * 0.5) inst.cd = level.cooldown * 0.25;
  },
};
