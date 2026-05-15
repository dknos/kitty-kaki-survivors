/**
 * War Howl — Sote's signature weapon (Phase F1 of progression redesign).
 *
 * Radial shockwave. Every cooldown, hero emits an expanding ring that deals
 * damage to each enemy ONCE as the wave passes through their position. Plays
 * the heavy-wolf identity: short bursts of crowd cleanup, not a constant DPS
 * stream. Pairs with no specific archetype signature (baseArchetype 'kitty'
 * still applies Nine Lives — see config.js).
 *
 * Mechanic distinct:
 *   - The wave hits each enemy AT MOST ONCE per cast based on their distance
 *     to hero at spawn time, so it reads as a real expanding wave rather than
 *     a per-frame radius AoE.
 *   - No projectiles, no per-frame collision queries through the swarm — the
 *     hit set is captured at cast time, then drained as the wave radius
 *     advances past each enemy's stored distance.
 *
 * Visual: one shared InstancedMesh of 4 wave slots (cap-bounded per plan §2 #1).
 * Each wave is a flat-on-floor ring textured with the existing kill-ring
 * (`ring_arcane`) and pinned at FLOOR_TIER.kill_pickup.
 *
 * SFX placeholder: reuses sfx.weaponBurger as a brief impact thump.
 */
import * as THREE from 'three';
import { state } from '../../state.js';
import { tex } from '../../particleTextures.js';
import { sfx } from '../../audio.js';
import { damageEnemy, queryRadius } from '../../enemies.js';
import { applyFloorTier, floorDecalGeometry, floorDecalMaterial } from '../../fxLayers.js';
import { fxTex } from '../../fxTextures.js';

const WAVE_CAP = 4;
const _m4 = new THREE.Matrix4();
const _v3 = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _hideMat = (() => { const m = new THREE.Matrix4(); m.compose(new THREE.Vector3(0, -1000, 0), new THREE.Quaternion(), new THREE.Vector3(0,0,0)); return m; })();

let _inst = null;
const _waves = []; // { cx, cz, t, life, maxR, dmg, targets: [{e, d}], idx }

function _ensureMesh() {
  if (_inst) return;
  const geo = floorDecalGeometry(2);
  const mat = floorDecalMaterial({ map: fxTex('ring_arcane') || tex('ringGold'), color: 0xffd27f, opacity: 0.85 });
  _inst = new THREE.InstancedMesh(geo, mat, WAVE_CAP);
  _inst.count = WAVE_CAP;
  _inst.frustumCulled = false;
  _inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < WAVE_CAP; i++) _inst.setMatrixAt(i, _hideMat);
  applyFloorTier(_inst, 'kill_pickup');
  state.scene.add(_inst);
}

function _writeWave(i, w) {
  const r = w.maxR * (w.t / w.life);
  _v3.set(w.cx, 0.07, w.cz);
  _scl.set(r, r, r);
  _m4.compose(_v3, _q, _scl);
  _inst.setMatrixAt(i, _m4);
}

function _hide(i) { _inst.setMatrixAt(i, _hideMat); }

export function tickWarHowls(dt) {
  if (_waves.length === 0) return;
  _ensureMesh();
  let dirty = false;
  for (let i = 0; i < WAVE_CAP; i++) {
    const w = _waves[i];
    if (!w) continue;
    w.t += dt;
    if (w.t >= w.life) {
      _waves[i] = null;
      _hide(i);
      dirty = true;
      continue;
    }
    _writeWave(i, w);
    dirty = true;
    // Drain stored targets whose distance the wave has now passed. Each hit
    // dedups via the captured idx pointer — O(targets) total across lifetime.
    const r = w.maxR * (w.t / w.life);
    while (w.idx < w.targets.length && w.targets[w.idx].d <= r) {
      const { e } = w.targets[w.idx];
      if (e && e.alive) damageEnemy(e, w.dmg, 'sig_sote_warhowl');
      w.idx += 1;
    }
  }
  if (dirty) _inst.instanceMatrix.needsUpdate = true;
}

function _castWave(level) {
  _ensureMesh();
  let slot = -1;
  for (let i = 0; i < WAVE_CAP; i++) if (!_waves[i]) { slot = i; break; }
  if (slot === -1) {
    let oldest = 0; let oldestT = -1;
    for (let i = 0; i < WAVE_CAP; i++) if (_waves[i] && _waves[i].t > oldestT) { oldestT = _waves[i].t; oldest = i; }
    slot = oldest;
  }
  const hp = state.hero.pos;
  // Capture targets at cast time with their distance from hero. Sort ascending
  // so the wave hits closer enemies first as it expands.
  const maxR = level.radius * (state.hero.statMul.area || 1);
  let cands = null;
  try { cands = queryRadius(hp, maxR); } catch (_) { cands = state.enemies && state.enemies.active; }
  const targets = [];
  if (cands) {
    for (const e of cands) {
      if (!e || !e.alive || !e.mesh) continue;
      const dx = e.mesh.position.x - hp.x;
      const dz = e.mesh.position.z - hp.z;
      const d = Math.hypot(dx, dz);
      if (d > maxR) continue;
      targets.push({ e, d });
    }
  }
  targets.sort((a, b) => a.d - b.d);
  _waves[slot] = {
    cx: hp.x, cz: hp.z,
    t: 0, life: level.duration,
    maxR,
    dmg: level.dmg * (state.hero.statMul.dmg || 1),
    targets, idx: 0,
  };
}

export default {
  id: 'sig_sote_warhowl',
  name: 'War Howl',
  desc: 'Radial shockwave — hits each enemy once as the ring expands.',
  icon: '🐺',
  maxLevel: 8,
  levels: [
    { cooldown: 4.0, duration: 0.55, radius:  6, dmg: 18 },
    { cooldown: 3.7, duration: 0.60, radius:  7, dmg: 24 },
    { cooldown: 3.4, duration: 0.60, radius:  8, dmg: 32 },
    { cooldown: 3.1, duration: 0.65, radius:  9, dmg: 42 },
    { cooldown: 2.8, duration: 0.65, radius: 10, dmg: 54 },
    { cooldown: 2.5, duration: 0.70, radius: 11, dmg: 70 },
    { cooldown: 2.2, duration: 0.70, radius: 12, dmg: 90 },
    { cooldown: 1.9, duration: 0.75, radius: 14, dmg: 120 },
  ],

  init(state, level, inst) { inst.cd = 0.5; },

  tick(state, dt, level, inst) {
    if (inst.cd === undefined) inst.cd = 0;
    inst.cd -= dt;
    tickWarHowls(dt);
    if (inst.cd > 0) return;
    _castWave(level);
    try { sfx.weaponBurger(); } catch (_) {}
    inst.cd = level.cooldown * (state.hero.statMul.cooldown || 1) * (state.run.passive_cooldown || 1);
  },

  refresh(state, level, inst) {
    if (inst.cd > level.cooldown * 0.5) inst.cd = level.cooldown * 0.25;
  },
};
