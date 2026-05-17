/**
 * Chain Storm — Forest evolution-coffin superweapon (FE-V2 Coffins, 2026-05-17).
 *
 * Evolved variant of `chain` (Chain Lightning), unlocked by opening an
 * Evolution Coffin in the Forest stage while holding `chain` @ L8 and the
 * paired passive (`tome`) @ L5. See src/forestCoffins.js → FOREST_EVOLUTIONS.
 *
 * Mechanic delta vs base chain:
 *   - Damage: 2× base chain damage (matches the existing EVOLUTIONS.chain
 *     'storm' flag semantics in src/weapons/chain.js — kept identical so a
 *     player who reaches both unlocks doesn't see two wildly different
 *     "Storm" outputs).
 *   - Range: +50% chain radius vs base (base 5..9m → storm 7.5..13.5m).
 *   - Targeting: auto-locks to the **3 nearest enemies per pulse** (3 root
 *     bolts in parallel), and each of those 3 root bolts chains through the
 *     usual chain-count count for that level. So a Lv1 Storm pulse fires
 *     3 bolts × (1 root hit + 1 chain) = up to 6 hits; Lv8 pulse fires
 *     3 × (1 + 8) = up to 27 hits. This is the "auto-locks to nearest 3
 *     enemies per pulse" contract from the FE-V2 brief.
 *
 * Visual contract:
 *   - Reuses the existing chainFx pool (spawnChainArc) with the chain
 *     palette (cyan outer / white-hot inner) so the upgrade reads as
 *     "more of the same, but bigger" — not a new visual family.
 *   - No new geometries / materials / textures. Module is alloc-free in
 *     the hot path (uses a module-scope Set for the per-pulse hit list).
 *
 * Constraints (FE-V2 Coffins brief):
 *   - 8 levels mirroring chain.js (same level-count contract for the
 *     descriptions.js stat-rows helper). Level table holds slightly steeper
 *     damage/range ramps than base chain to justify the unlock cost.
 *   - hidden: true — never appears in the level-up card pool (Forest
 *     specials are auto-equipped from meta or coffin grant).
 *   - Static imports only. No dynamic import in the tick path.
 *   - Default export contract: { id, name, desc, icon, hidden, maxLevel,
 *     levels[], init, tick, refresh }.
 */
import { state } from '../state.js';
import { damageEnemy, queryRadius } from '../enemies.js';
import { sfx } from '../audio.js';
import { spawnChainArc } from '../chainFx.js';

// Visual palette — locked to the chain-lightning family (matches chain.js
// so storm reads as "the same arc, but every pulse fans out").
const ARC_LIFE        = 0.18;
const ARC_OUTER_COLOR = 0x4fb6ff;
const ARC_INNER_COLOR = 0xffffff;
const BRANCH_LIFE_MUL = 0.55;

// Per-pulse root-bolt count. "Auto-locks to nearest 3 enemies per pulse"
// from the FE-V2 brief. Single literal so a future tuning ticket can scale
// it from one place.
const ROOT_BOLTS = 3;

// Reused across all pulses to avoid per-frame Set allocation. Cleared at
// the top of each pulse. Single-threaded JS — no contention risk.
const _hit = new Set();

function _findNearestN(pos, n, exclude) {
  // Gather candidate enemies (queryRadius is the spatial-hash fast path;
  // fall back to the active list if it isn't available — mirrors chain.js).
  let cands = null;
  try { cands = queryRadius(pos, 22); } catch (_) { cands = null; }
  if (!cands || cands.length === 0) cands = state.enemies.active;
  if (!cands || cands.length === 0) return null;

  // Insertion-sort top-N by squared distance. Keeps allocations bounded to
  // a single pre-allocated result slot per call (Array.from once). For
  // n=3 this is O(k) per candidate; vastly cheaper than full sort and
  // alloc-clean compared to sort(...).slice(0,n).
  const best = [];
  for (let i = 0; i < cands.length; i++) {
    const e = cands[i];
    if (!e || !e.alive) continue;
    if (exclude && exclude.has(e)) continue;
    const ep = e.mesh.position;
    const dx = ep.x - pos.x, dz = ep.z - pos.z;
    const d2 = dx * dx + dz * dz;
    // Insert in sorted position; trim to length n.
    let inserted = false;
    for (let j = 0; j < best.length; j++) {
      if (d2 < best[j].d2) {
        best.splice(j, 0, { e, d2 });
        inserted = true;
        break;
      }
    }
    if (!inserted && best.length < n) best.push({ e, d2 });
    if (best.length > n) best.length = n;
  }
  if (best.length === 0) return null;
  // Return just the enemies (caller doesn't need the distances).
  const out = new Array(best.length);
  for (let i = 0; i < best.length; i++) out[i] = best[i].e;
  return out;
}

function _findNearestWithin(pos, radius, exclude) {
  let cands = null;
  try { cands = queryRadius(pos, radius); } catch (_) { cands = null; }
  if (!cands || cands.length === 0) return null;
  let best = null, bestD2 = radius * radius;
  for (const e of cands) {
    if (!e || !e.alive) continue;
    if (exclude && exclude.has(e)) continue;
    const ep = e.mesh.position;
    const dx = ep.x - pos.x, dz = ep.z - pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = e; }
  }
  return best;
}

function _drawArc(a, b) {
  spawnChainArc(state.scene, a, b, {
    outerColor: ARC_OUTER_COLOR,
    innerColor: ARC_INNER_COLOR,
    life: ARC_LIFE,
  });
  // ~35% chance branch fork — same visual gloss as base chain.js so Storm
  // doesn't feel visually "thinner" than the base it replaces.
  if (Math.random() < 0.35) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const tMid = 0.25 + Math.random() * 0.5;
    const rootX = a.x + dx * tMid;
    const rootZ = a.z + dz * tMid;
    const ang = Math.random() * Math.PI * 2;
    const blen = 0.8 + Math.random() * 0.8;
    const tipX = rootX + Math.cos(ang) * blen;
    const tipZ = rootZ + Math.sin(ang) * blen;
    spawnChainArc(state.scene, { x: rootX, z: rootZ }, { x: tipX, z: tipZ }, {
      outerColor: ARC_OUTER_COLOR,
      innerColor: ARC_INNER_COLOR,
      life: ARC_LIFE * BRANCH_LIFE_MUL,
      segments: 3,
      jitter: 0.35,
    });
  }
}

export default {
  id: 'chain_storm',
  name: 'Chain Storm',
  desc: 'Forks 3 parallel chain bolts per pulse with extended range',
  icon: '🌩️',
  hidden: true, // FE-V2 Forest special — never in level-up card pool
  maxLevel: 8,
  // Level table mirrors chain.js shape (cooldown / dmg / chains / chainRadius
  // / falloff) so descriptions.js STAT_FIELDS can reuse the chain template.
  // Base chain damage × 2 per the FE-V2 brief; chainRadius × 1.5 (+50%).
  levels: [
    { cooldown: 1.30, dmg:  36, chains: 1, chainRadius:  7.5, falloff: 0.7  },
    { cooldown: 1.20, dmg:  48, chains: 2, chainRadius:  8.25, falloff: 0.75 },
    { cooldown: 1.10, dmg:  64, chains: 3, chainRadius:  9.0, falloff: 0.78 },
    { cooldown: 1.00, dmg:  88, chains: 4, chainRadius:  9.75, falloff: 0.80 },
    { cooldown: 0.90, dmg: 116, chains: 5, chainRadius: 10.5, falloff: 0.82 },
    { cooldown: 0.80, dmg: 152, chains: 6, chainRadius: 11.25, falloff: 0.85 },
    { cooldown: 0.70, dmg: 192, chains: 7, chainRadius: 12.0, falloff: 0.88 },
    { cooldown: 0.60, dmg: 240, chains: 8, chainRadius: 13.5, falloff: 0.90 },
  ],

  init(state, level, inst) {
    // Match chain.js init timing — a small warm-up cooldown so the first
    // pulse isn't simultaneous with whatever else fires on run-start.
    inst.cd = 0.3;
  },

  tick(state, dt, level, inst) {
    if (inst.cd === undefined) inst.cd = 0;
    inst.cd -= dt;
    if (inst.cd > 0) return;

    const hero = state.hero.pos;
    const roots = _findNearestN(hero, ROOT_BOLTS, null);
    if (!roots || roots.length === 0) {
      // No targets — short-cycle the cooldown so we re-try fast (mirrors
      // chain.js fallback). 0.2s matches chain.js's exact behavior.
      inst.cd = 0.2;
      return;
    }

    const dmgMul = state.hero.statMul.dmg || 1;
    _hit.clear();

    // For each root bolt: fire hero → root, then chain through the usual
    // chain count. Chained targets are shared across root bolts via _hit
    // (one enemy can't be re-hit twice in a single pulse).
    for (let r = 0; r < roots.length; r++) {
      const root = roots[r];
      if (!root || !root.alive) continue;
      if (_hit.has(root)) continue;

      let dmg = level.dmg * dmgMul;
      _drawArc(hero, root.mesh.position);
      damageEnemy(root, dmg, 'storm');
      _hit.add(root);

      // Chain off this root through level.chains hops.
      let from = root;
      for (let i = 0; i < level.chains; i++) {
        const next = _findNearestWithin(from.mesh.position, level.chainRadius, _hit);
        if (!next) break;
        dmg *= level.falloff;
        _drawArc(from.mesh.position, next.mesh.position);
        damageEnemy(next, dmg, 'storm');
        _hit.add(next);
        from = next;
      }
    }

    try { sfx.weaponChain && sfx.weaponChain(); } catch (_) {}
    const cdMul = state.hero.statMul.cooldown || 1;
    inst.cd = level.cooldown * cdMul * (state.run.passive_cooldown || 1);
  },

  refresh(state, level, inst) {
    if (inst.cd > level.cooldown * 0.5) inst.cd = level.cooldown * 0.25;
  },
};
