/**
 * Chain Lightning — fires a bolt to the nearest enemy, then arcs to up to
 * `chains` more enemies within `chainRadius`. Each arc deals diminishing damage.
 * Visual: short-lived bright line segments, fade over ~0.18s.
 */
import { state } from '../state.js';
import { damageEnemy, queryRadius } from '../enemies.js';
import { sfx } from '../audio.js';
import { spawnChainArc } from '../chainFx.js';

// Chain-arc visual is owned by src/chainFx.js (A4 refactor). The colors below
// stay weapon-local because they're palette-locked to the chain-lightning
// weapon's identity (cyan glow + white-hot core); stage interactables call the
// same spawnChainArc with their own palette.
const ARC_LIFE = 0.18;          // weapon arc fades faster than forest amber's
const ARC_OUTER_COLOR = 0x4fb6ff;
const ARC_INNER_COLOR = 0xffffff;
const BRANCH_LIFE_MUL = 0.55;   // ~35% branch fork lives ~half as long

function _findNearest(pos, exclude) {
  let cands = null;
  try { cands = queryRadius(pos, 22); } catch (_) { cands = null; }
  if (!cands || cands.length === 0) cands = state.enemies.active;
  let best = null, bestD2 = Infinity;
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
  // Main arc: spawnChainArc fills in dist-derived segments/jitter from the
  // shared formula (identical to the pre-refactor inline values).
  spawnChainArc(state.scene, a, b, {
    outerColor: ARC_OUTER_COLOR,
    innerColor: ARC_INNER_COLOR,
    life: ARC_LIFE,
  });

  // ~35% chance: spawn a small branch fork from a perpendicular tip that
  // dies faster. This is chain.js-specific (forest amber's chain arcs don't
  // branch). The branch tip is computed in the weapon's local space; the
  // shared module just renders whatever endpoints we hand it.
  if (Math.random() < 0.35) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    // Anchor the branch root on the mid-segment of the arc path (~1/3-2/3
    // along the line — matches the pre-refactor "idx among pts.length"
    // distribution well enough for visual parity since pts is jitter-driven
    // and we no longer expose the path).
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
      // Sharper jitter, shorter path — pre-refactor used segments=3,
      // jitter=0.35 for branches regardless of distance.
      segments: 3,
      jitter: 0.35,
    });
  }
}

// Arc tick is owned by src/chainFx.js — main.js calls tickChainArcs once per
// frame for all consumers. Nothing weapon-side to export here.

export default {
  id: 'chain',
  name: 'Chain Lightning',
  desc: 'Arcs between nearby enemies',
  icon: '⚡',
  maxLevel: 8,
  levels: [
    { cooldown: 1.40, dmg: 18, chains: 1, chainRadius: 5.0, falloff: 0.7 },
    { cooldown: 1.30, dmg: 24, chains: 2, chainRadius: 5.5, falloff: 0.75 },
    { cooldown: 1.20, dmg: 32, chains: 3, chainRadius: 6.0, falloff: 0.78 },
    { cooldown: 1.10, dmg: 44, chains: 4, chainRadius: 6.5, falloff: 0.80 },
    { cooldown: 1.00, dmg: 58, chains: 5, chainRadius: 7.0, falloff: 0.82 },
    { cooldown: 0.90, dmg: 76, chains: 6, chainRadius: 7.5, falloff: 0.85 },
    { cooldown: 0.80, dmg: 96, chains: 7, chainRadius: 8.0, falloff: 0.88 },
    { cooldown: 0.70, dmg: 120,chains: 8, chainRadius: 9.0, falloff: 0.90 },
  ],

  init(state, level, inst) { inst.cd = 0.3; },

  tick(state, dt, level, inst) {
    if (inst.cd === undefined) inst.cd = 0;
    inst.cd -= dt;
    if (inst.cd > 0) return;

    const hero = state.hero.pos;
    const first = _findNearest(hero);
    if (!first) { inst.cd = 0.2; return; }

    const dmgMul = state.hero.statMul.dmg || 1;
    const evoMul = inst.evolved ? 2.0 : 1;
    const evoChainsBonus = inst.evolved ? 3 : 0;
    let dmg = level.dmg * dmgMul * evoMul;
    const hit = new Set();

    // First arc: hero → first
    _drawArc(hero, first.mesh.position);
    const chainSrc = inst.evolved ? 'storm' : 'chain';
    damageEnemy(first, dmg, chainSrc);
    hit.add(first);

    // Chain
    let from = first;
    const totalChains = level.chains + evoChainsBonus;
    for (let i = 0; i < totalChains; i++) {
      const next = _findNearestWithin(from.mesh.position, level.chainRadius, hit);
      if (!next) break;
      dmg *= level.falloff;
      _drawArc(from.mesh.position, next.mesh.position);
      damageEnemy(next, dmg, chainSrc);
      hit.add(next);
      from = next;
    }

    try { sfx.weaponChain(); } catch (_) {}
    const cdMul = state.hero.statMul.cooldown || 1;
    // Iter 11a SHOP_TREE Power tier 2 "Quick Hands" composes with the iter-7
    // statMul.cooldown chain (passives/signature_tempo/Overdrive).
    inst.cd = (inst.evolved ? 0.30 : level.cooldown) * cdMul * (state.run.passive_cooldown || 1);

    // ── Boom "Charged Coil" signature: every 5th arc volley fires a free
    // re-cast at full chain count. Echo is re-entrancy-guarded so it doesn't
    // increment the counter itself (otherwise it would re-echo infinitely).
    if (state.run.signature_chainEcho && !inst._echoing) {
      state.run.signature_chainEchoCounter = (state.run.signature_chainEchoCounter || 0) + 1;
      if ((state.run.signature_chainEchoCounter % 5) === 0) {
        inst._echoing = true;
        // Replay the same volley path. Zero the cd so the inner tick's gate
        // doesn't bail; dt=0 so no further drain. The recursive call's tail
        // will re-stamp inst.cd to a fresh full cooldown.
        const savedCd = inst.cd;
        inst.cd = 0;
        try { this.tick(state, 0, level, inst); }
        finally {
          inst._echoing = false;
          // If the echo bailed early (e.g. _findNearest returned null inside),
          // restore the real cd rather than letting the short fallback stick.
          if (inst.cd < savedCd) inst.cd = savedCd;
        }
      }
    }
  },

  refresh(state, level, inst) {
    if (inst.cd > level.cooldown * 0.5) inst.cd = level.cooldown * 0.25;
  },
};
