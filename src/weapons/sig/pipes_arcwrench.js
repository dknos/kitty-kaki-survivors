/**
 * Arc Wrench — Pipes' signature weapon (Phase F1 of progression redesign).
 *
 * Pierce-line lightning. Throws a fast electric bolt in the direction of the
 * nearest enemy that drills straight through every enemy in its path. Each
 * hit stamps a brief electric DoT mark (1.0s) at low dps so trailing damage
 * adds up while the player repositions. Pairs with Boom baseArchetype's
 * Charged Coil signature: every 5th cast triggers a free re-cast.
 *
 * Mechanic distinct: NOT chain (jumps) and NOT autoAim (single bolt). It's
 * a line-pierce projectile that prefers piercing pierce-count over speed,
 * so the bullet looks like it's barreling through a ranked file of enemies.
 *
 * Reuses the autoAim projectile pool (spawnAutoAimProjectile) — zero new
 * draw calls. The DoT mark uses the existing _dotDps/_dotUntil channel
 * already drained by enemies.js.
 *
 * SFX placeholder: sfx.weaponChain (close cousin).
 */
import { state } from '../../state.js';
import { sfx } from '../../audio.js';
import { spawnAutoAimProjectile } from '../autoAim.js';

function _findNearest(pos, range) {
  const cands = state.enemies && state.enemies.active;
  if (!cands || cands.length === 0) return null;
  let best = null, bestD2 = range * range;
  for (const e of cands) {
    if (!e || !e.alive || !e.mesh) continue;
    const dx = e.mesh.position.x - pos.x;
    const dz = e.mesh.position.z - pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = e; }
  }
  return best;
}

export default {
  id: 'sig_pipes_arcwrench',
  name: 'Arc Wrench',
  desc: 'Line-pierce bolt — drills through a packed file of enemies.',
  icon: '🥸',
  maxLevel: 8,
  // Phase G tune: pre-G L8 = 88 dmg × pierce 14 / 0.55s cd ≈ 2240 line-DPS in
  // packed swarms — well past cowboy/bezelbug. Line-pierce kits SHOULD lead
  // single-axis DPS by design, but 2200 dwarfed every other kit. Trim dmg
  // 88→60 and pierce ceiling 14→10 at L8 → 60×10/0.55 ≈ 1090 line-DPS,
  // ~1.5× cowboy's 700-ish packed-file value.
  levels: [
    { cooldown: 1.20, speed: 24, dmg: 12, ttl: 0.95, pierce: 4, dotDps:  2, dotDur: 1.0 },
    { cooldown: 1.10, speed: 25, dmg: 16, ttl: 0.95, pierce: 5, dotDps:  3, dotDur: 1.0 },
    { cooldown: 1.00, speed: 26, dmg: 20, ttl: 1.00, pierce: 5, dotDps:  4, dotDur: 1.1 },
    { cooldown: 0.90, speed: 26, dmg: 26, ttl: 1.00, pierce: 6, dotDps:  6, dotDur: 1.1 },
    { cooldown: 0.82, speed: 27, dmg: 33, ttl: 1.05, pierce: 7, dotDps:  8, dotDur: 1.2 },
    { cooldown: 0.74, speed: 27, dmg: 41, ttl: 1.05, pierce: 8, dotDps: 11, dotDur: 1.2 },
    { cooldown: 0.65, speed: 28, dmg: 50, ttl: 1.10, pierce: 9, dotDps: 14, dotDur: 1.3 },
    { cooldown: 0.55, speed: 28, dmg: 60, ttl: 1.10, pierce: 10, dotDps: 18, dotDur: 1.3 },
  ],

  init(state, level, inst) {
    inst.cd = 0;
    inst.castCount = 0;
  },

  tick(state, dt, level, inst) {
    if (inst.cd === undefined) inst.cd = 0;
    inst.cd -= dt;
    if (inst.cd > 0) return;
    const hero = state.hero.pos;
    const target = _findNearest(hero, 20);
    if (!target) { inst.cd = 0.18; return; }
    const tp = target.mesh.position;
    const angle = Math.atan2(tp.z - hero.z, tp.x - hero.x);
    const dir = { x: Math.cos(angle), z: Math.sin(angle) };
    const dmg = level.dmg * (state.hero.statMul.dmg || 1);
    spawnAutoAimProjectile(hero, dir, level, dmg, 1, 0, 'sig_pipes_arcwrench', {
      ice: true,                  // gold-into-blue palette swap — reads as electric
      pierceOverride: level.pierce,
      scale: 1.15,
    });
    inst.castCount += 1;
    // Charged Coil signature (Boom baseArchetype) — every 5th cast emits a
    // bonus bolt. Free re-cast pattern; the existing signature_chainEcho hook
    // stays armed in chain.js but the meta-effect is recreated here so the
    // signature still feels active even though we replaced chain.js as starter.
    if (state.run.signature_chainEcho) {
      state.run.signature_chainEchoCounter = (state.run.signature_chainEchoCounter || 0) + 1;
      if (state.run.signature_chainEchoCounter >= 5) {
        state.run.signature_chainEchoCounter = 0;
        spawnAutoAimProjectile(hero, dir, level, dmg * 0.8, 1, 0, 'sig_pipes_arcwrench', {
          ice: true, pierceOverride: level.pierce, scale: 0.9,
        });
      }
    }
    try { sfx.weaponChain(); } catch (_) {}
    inst.cd = level.cooldown * (state.hero.statMul.cooldown || 1) * (state.run.passive_cooldown || 1);
  },

  refresh(state, level, inst) {
    if (inst.cd > level.cooldown * 0.5) inst.cd = level.cooldown * 0.25;
  },
};
