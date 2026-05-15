/**
 * Facet — BezelBug's signature weapon (Phase F3 of progression redesign).
 *
 * Gem-shard burst. Every cooldown, hero emits a ring of `count` shards
 * launched outward in a perfect star pattern. Each shard is a fast
 * short-lived projectile dealing piercing damage. Visually reads as the
 * gem-encrusted bug shedding facets of itself in all directions.
 *
 * Mechanic distinct from sig_cowboy_sixshooter (tight burst at single
 * target) and sig_bomdia_sunburst (4-8 fixed cardinal beams):
 *   - All-around radial volley (no aim, no compass lock) — full 360° spray.
 *   - Reuses spawnAutoAimProjectile pool (zero new draw calls).
 *   - Shards have low pierce but high count so the kit feels like a damage
 *     starburst rather than a focused drill.
 *
 * SFX placeholder: sfx.weaponAutoaim per shard (the throttle in audio.js
 * already prevents stacking when many shards launch in the same frame).
 */
import { state } from '../../state.js';
import { sfx } from '../../audio.js';
import { spawnAutoAimProjectile } from '../autoAim.js';

export default {
  id: 'sig_bezelbug_facet',
  name: 'Facet',
  desc: 'Radial gem-shard volley — all directions, no aim.',
  icon: '💎',
  maxLevel: 8,
  // count grows with level; speed × ttl ≤ ~22u (camera ortho rule).
  levels: [
    { cooldown: 1.40, speed: 20, dmg:  8, ttl: 0.85, pierce: 1, count:  6 },
    { cooldown: 1.30, speed: 21, dmg: 11, ttl: 0.90, pierce: 1, count:  7 },
    { cooldown: 1.20, speed: 22, dmg: 15, ttl: 0.90, pierce: 1, count:  9 },
    { cooldown: 1.10, speed: 22, dmg: 20, ttl: 0.95, pierce: 2, count: 11 },
    { cooldown: 1.00, speed: 23, dmg: 27, ttl: 0.95, pierce: 2, count: 13 },
    { cooldown: 0.90, speed: 24, dmg: 36, ttl: 1.00, pierce: 2, count: 16 },
    { cooldown: 0.80, speed: 25, dmg: 48, ttl: 1.00, pierce: 3, count: 20 },
    { cooldown: 0.70, speed: 26, dmg: 64, ttl: 1.05, pierce: 3, count: 24 },
  ],

  init(state, level, inst) { inst.cd = 0.5; },

  tick(state, dt, level, inst) {
    if (inst.cd === undefined) inst.cd = 0;
    inst.cd -= dt;
    if (inst.cd > 0) return;
    const hero = state.hero.pos;
    const n = level.count;
    const dmg = level.dmg * (state.hero.statMul.dmg || 1);
    const step = (Math.PI * 2) / n;
    const offset = Math.random() * step;   // tiny phase jitter so the star doesn't snap to the same axes every cast
    for (let i = 0; i < n; i++) {
      const a = i * step + offset;
      const dir = { x: Math.cos(a), z: Math.sin(a) };
      spawnAutoAimProjectile(hero, dir, level, dmg, 1, 0, 'sig_bezelbug_facet', { scale: 0.75 });
    }
    try { sfx.weaponAutoaim(); } catch (_) {}
    inst.cd = level.cooldown * (state.hero.statMul.cooldown || 1) * (state.run.passive_cooldown || 1);
  },

  refresh(state, level, inst) {
    if (inst.cd > level.cooldown * 0.5) inst.cd = level.cooldown * 0.25;
  },
};
