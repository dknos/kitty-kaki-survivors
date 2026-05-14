/**
 * Chain Lightning — fires a bolt to the nearest enemy, then arcs to up to
 * `chains` more enemies within `chainRadius`. Each arc deals diminishing damage.
 * Visual: short-lived bright line segments, fade over ~0.18s.
 */
import * as THREE from 'three';
import { state } from '../state.js';
import { damageEnemy, queryRadius } from '../enemies.js';
import { sfx } from '../audio.js';
import { BLOOM_LAYER } from '../postfx.js';

const ARC_LIFE = 0.18;
const ARC_Y = 0.7;

const _activeArcs = []; // {line, mat, t}

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

// Build a noisy lightning path between two points. Returns an array of Vector3.
// `segments` controls jaggedness; `jitter` is the max perpendicular offset.
function _lightningPoints(a, b, segments, jitter) {
  const pts = [];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.max(0.001, Math.hypot(dx, dz));
  // Perpendicular (in XZ plane) for offset displacement
  const px = -dz / len;
  const pz =  dx / len;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    // Taper jitter near the endpoints so the arc anchors cleanly
    const taper = Math.sin(t * Math.PI);
    const off = (Math.random() * 2 - 1) * jitter * taper;
    const yJit = (Math.random() * 2 - 1) * jitter * 0.35 * taper;
    pts.push(new THREE.Vector3(
      a.x + dx * t + px * off,
      ARC_Y + yJit,
      a.z + dz * t + pz * off,
    ));
  }
  return pts;
}

function _arcGroupFromPoints(pts) {
  // Two-layer tube: thick outer glow + thin hot inner core, both additive.
  const curve = new THREE.CatmullRomCurve3(pts);
  const tubeSegs = Math.max(8, pts.length * 2);

  const outerGeo = new THREE.TubeGeometry(curve, tubeSegs, 0.14, 6, false);
  const outerMat = new THREE.MeshBasicMaterial({
    color: 0x4fb6ff, transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const outer = new THREE.Mesh(outerGeo, outerMat);
  outer.frustumCulled = false;
  outer.layers.enable(BLOOM_LAYER);

  const innerGeo = new THREE.TubeGeometry(curve, tubeSegs, 0.05, 6, false);
  const innerMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 1.0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const inner = new THREE.Mesh(innerGeo, innerMat);
  inner.frustumCulled = false;
  inner.layers.enable(BLOOM_LAYER);

  const group = new THREE.Group();
  group.add(outer);
  group.add(inner);
  return { group, mats: [outerMat, innerMat], geos: [outerGeo, innerGeo] };
}

function _drawArc(a, b) {
  // Main jagged path between source and target
  const dist = Math.hypot(b.x - a.x, b.z - a.z);
  const segments = Math.max(5, Math.min(10, Math.floor(dist / 1.2)));
  const jitter = Math.min(1.1, 0.25 + dist * 0.06);
  const pts = _lightningPoints(a, b, segments, jitter);

  const main = _arcGroupFromPoints(pts);
  state.scene.add(main.group);
  _activeArcs.push({ group: main.group, mats: main.mats, geos: main.geos, t: 0 });

  // ~35% chance: spawn a small branch fork from a mid-point that dies faster.
  if (Math.random() < 0.35 && pts.length >= 4) {
    const idx = 1 + Math.floor(Math.random() * (pts.length - 2));
    const root = pts[idx];
    // Branch heads off perpendicular ~0.8-1.6u long, with sharper jitter
    const ang = Math.random() * Math.PI * 2;
    const blen = 0.8 + Math.random() * 0.8;
    const tip = new THREE.Vector3(
      root.x + Math.cos(ang) * blen,
      ARC_Y,
      root.z + Math.sin(ang) * blen,
    );
    const bpts = _lightningPoints(root, tip, 3, 0.35);
    const branch = _arcGroupFromPoints(bpts);
    // Branches: half-life of the main arc, narrower outer
    state.scene.add(branch.group);
    _activeArcs.push({ group: branch.group, mats: branch.mats, geos: branch.geos, t: 0, life: ARC_LIFE * 0.55 });
  }
}

export function tickChainArcs(dt) {
  for (let i = _activeArcs.length - 1; i >= 0; i--) {
    const a = _activeArcs[i];
    const life = a.life || ARC_LIFE;
    a.t += dt;
    const k = a.t / life;
    if (k >= 1) {
      state.scene.remove(a.group);
      for (const g of a.geos) g.dispose();
      for (const m of a.mats) m.dispose();
      _activeArcs.splice(i, 1);
    } else {
      // Inner core stays bright longer, outer fades faster
      const fadeOuter = 1 - k;
      const fadeInner = 1 - k * k;
      if (a.mats[0]) a.mats[0].opacity = 0.55 * fadeOuter;
      if (a.mats[1]) a.mats[1].opacity = 1.00 * fadeInner;
    }
  }
}

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
