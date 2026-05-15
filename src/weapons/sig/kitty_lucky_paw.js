/**
 * Lucky Paw — Kitty Kaki's signature weapon (Phase F1 of progression redesign).
 *
 * Random-target swipe burst. Each cast picks `count` random enemies inside
 * the screen and stamps an instant-hit damage tick on each with a brief
 * twinkle-pop visual. Pairs with Nine Lives signature: low cooldown, lots
 * of small hits, the kit "feels" lucky.
 *
 * Mechanic distinct from existing kits in two ways:
 *   1. No projectile — damage applies instantly via damageEnemy() so there's
 *      no per-cast pool to maintain. Plan §2 #1: no new InstancedMesh.
 *   2. Random target selection across visible roster (within screen radius),
 *      not nearest-only. Reads as "find a lucky strike" not "deterministic aim".
 *
 * Visual: spawnMagnetSpark + spawnKillRing-style pop on the hit enemy via
 * the existing fx.js sparks pool — zero new draw calls.
 *
 * SFX placeholder: reuses sfx.weaponAutoaim. Phase G adds bespoke audio.
 */
import { state } from '../../state.js';
import { sfx } from '../../audio.js';
import { damageEnemy } from '../../enemies.js';
import { spawnMagnetSpark } from '../../fx.js';

const SCREEN_RADIUS = 18;   // matches autoAim search radius — on-screen only

function _pickRandomTargets(pos, n) {
  const cands = state.enemies && state.enemies.active;
  if (!cands || cands.length === 0) return [];
  const r2 = SCREEN_RADIUS * SCREEN_RADIUS;
  // Build the in-range pool inline (avoid allocating a filtered array when
  // n >> pool size — we use reservoir sampling instead).
  const pool = [];
  for (const e of cands) {
    if (!e || !e.alive || !e.mesh) continue;
    const dx = e.mesh.position.x - pos.x;
    const dz = e.mesh.position.z - pos.z;
    if (dx * dx + dz * dz > r2) continue;
    pool.push(e);
  }
  if (pool.length === 0) return [];
  if (pool.length <= n) return pool;
  // Partial Fisher-Yates: shuffle the first n indices, return those.
  const idx = pool.map((_, i) => i);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (idx.length - i));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = pool[idx[i]];
  return out;
}

export default {
  id: 'sig_kitty_lucky_paw',
  name: 'Lucky Paw',
  desc: 'Random-target swipes — many small lucky strikes.',
  icon: '🐾',
  maxLevel: 8,
  levels: [
    { cooldown: 0.90, count: 2, dmg:  6 },
    { cooldown: 0.80, count: 3, dmg:  8 },
    { cooldown: 0.70, count: 3, dmg: 11 },
    { cooldown: 0.60, count: 4, dmg: 14 },
    { cooldown: 0.55, count: 4, dmg: 19 },
    { cooldown: 0.50, count: 5, dmg: 25 },
    { cooldown: 0.45, count: 6, dmg: 33 },
    { cooldown: 0.40, count: 7, dmg: 42 },
  ],

  init(state, level, inst) { inst.cd = 0.3; },

  tick(state, dt, level, inst) {
    if (inst.cd === undefined) inst.cd = 0;
    inst.cd -= dt;
    if (inst.cd > 0) return;
    const dmg = level.dmg * (state.hero.statMul.dmg || 1);
    const targets = _pickRandomTargets(state.hero.pos, level.count);
    for (const e of targets) {
      damageEnemy(e, dmg, 'sig_kitty_lucky_paw');
      // Free-from-pool visual: spawn a magnet spark on the hit. Spark pool
      // is already capped (64), so we don't blow the budget at high counts.
      try { spawnMagnetSpark(e.mesh.position.x, 0.5, e.mesh.position.z, 0xffd27f); } catch (_) {}
    }
    if (targets.length > 0) {
      try { sfx.weaponAutoaim(); } catch (_) {}
    }
    inst.cd = level.cooldown * (state.hero.statMul.cooldown || 1) * (state.run.passive_cooldown || 1);
  },

  refresh(state, level, inst) {
    if (inst.cd > level.cooldown * 0.5) inst.cd = level.cooldown * 0.25;
  },
};
