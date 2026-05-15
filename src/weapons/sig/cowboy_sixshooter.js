/**
 * Six-Shooter — Cowboy Kaki's signature weapon (Phase D of the progression
 * redesign). Ranged burst: fires a tight stagger of `count` shots per cast,
 * each bullet riding through the existing autoAim InstancedMesh pool so no
 * new per-projectile draw call is added (plan §2 #1).
 *
 * Distinct from `autoaim` in two ways:
 *   1. BURST stagger — shots fire over ~0.12s instead of one big fan, reads
 *      as a revolver dump, not a magic-missile salvo.
 *   2. Headshot crit — pairs with the Sniper baseArchetype's Headhunter
 *      signature: if `signature_executeBonus` is set, bullets carry +30% dmg.
 *      The signature itself stays applied via state.run.signature_executeBonus.
 *
 * Per plan exit criterion, this kit reuses existing textures (sparkGold,
 * smokeGray) and shares the autoAim projectile pool — no new draw calls.
 */
import { state } from '../../state.js';
import { sfx } from '../../audio.js';
import { spawnAutoAimProjectile } from '../autoAim.js';

const FAN_SPREAD = 0.08;    // tight cone vs autoaim's 0.18 — revolver, not shotgun
const BURST_STAGGER = 0.04; // seconds between consecutive shots in a burst

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
    if (d2 < bestD2 && d2 < 18 * 18) { bestD2 = d2; best = e; }
  }
  return best;
}

export default {
  id: 'sig_cowboy_sixshooter',
  name: 'Six-Shooter',
  desc: 'Tight burst of bullets — Headhunter-friendly.',
  icon: '🔫',
  maxLevel: 8,
  // Provisional curve (Phase G recalibrates against the 30-min bench). Speed
  // x ttl ≤ ~22u keeps bullets on-screen at ortho zoom. Damage tracks autoaim
  // baseline; burst-count caps at 6 to honor the "six-shooter" gag.
  levels: [
    { cooldown: 1.20, speed: 22, dmg: 10, ttl: 0.85, pierce: 1, count: 2 },
    { cooldown: 1.10, speed: 23, dmg: 14, ttl: 0.85, pierce: 1, count: 2 },
    { cooldown: 1.00, speed: 24, dmg: 18, ttl: 0.85, pierce: 1, count: 3 },
    { cooldown: 0.90, speed: 24, dmg: 24, ttl: 0.85, pierce: 2, count: 3 },
    { cooldown: 0.80, speed: 25, dmg: 32, ttl: 0.85, pierce: 2, count: 4 },
    { cooldown: 0.72, speed: 25, dmg: 42, ttl: 0.90, pierce: 2, count: 5 },
    { cooldown: 0.65, speed: 26, dmg: 55, ttl: 0.90, pierce: 3, count: 6 },
    { cooldown: 0.55, speed: 26, dmg: 70, ttl: 0.90, pierce: 3, count: 6 },
  ],

  init(state, level, inst) {
    inst.cd = 0;          // fire immediately when a target enters range
    inst.burst = null;    // active burst queue: { remaining, nextAt, baseAngle, level, dmg }
  },

  tick(state, dt, level, inst) {
    if (inst.cd === undefined) inst.cd = 0;
    inst.cd -= dt;

    // ── Resolve active burst (stagger shots over BURST_STAGGER each) ──
    if (inst.burst) {
      const b = inst.burst;
      b.nextAt -= dt;
      while (b.remaining > 0 && b.nextAt <= 0) {
        const i = level.count - b.remaining;
        const offset = (i - (level.count - 1) / 2) * FAN_SPREAD;
        const a = b.baseAngle + offset;
        const dir = { x: Math.cos(a), z: Math.sin(a) };
        spawnAutoAimProjectile(state.hero.pos, dir, b.level, b.dmg, 1, 0, 'sig_cowboy_sixshooter', { scale: 0.85 });
        b.remaining -= 1;
        b.nextAt += BURST_STAGGER;
        try { sfx.weaponAutoaim(); } catch (_) {}
      }
      if (b.remaining <= 0) inst.burst = null;
      return;
    }

    if (inst.cd > 0) return;
    const hero = state.hero.pos;
    const target = _findNearest(hero);
    if (!target) {
      inst.cd = 0.15;
      return;
    }
    const tp = target.mesh ? target.mesh.position : target.pos;
    const baseAngle = Math.atan2(tp.z - hero.z, tp.x - hero.x);
    const dmgMul = state.hero.statMul.dmg || 1;
    // Headhunter (sniper signature) is already applied by enemies.takeDamage;
    // no need to pre-scale here. We only stage the burst.
    const dmg = level.dmg * dmgMul;
    inst.burst = { remaining: level.count, nextAt: 0, baseAngle, level, dmg };
    inst.cd = level.cooldown * (state.hero.statMul.cooldown || 1) * (state.run.passive_cooldown || 1);
  },

  refresh(state, level, inst) {
    if (inst.cd === undefined || inst.cd > level.cooldown) {
      inst.cd = Math.min(inst.cd ?? 0, level.cooldown * 0.25);
    }
  },
};
