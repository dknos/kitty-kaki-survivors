/**
 * Brushstroke — Mona's signature weapon (Phase F2 of progression redesign).
 *
 * Painted streaks. Every cooldown, hero sweeps `count` short paint streaks
 * across the ground in random directions. Each streak is a thin rectangle
 * dealing dmg on cast (one-shot hit) + leaving a brief slow patch.
 *
 * Mechanic distinct: NOT projectile, NOT zone, NOT aura — a paint streak is
 * a static rectangle in world space that does its damage ONCE at cast time
 * (similar to sunburst beams) but the streaks pick random angles each cast,
 * reading as expressive painted brushwork rather than mechanical compass
 * beams.
 *
 * Plan §2 #1: one shared 32-slot InstancedMesh (cap-bounded). Streaks decay
 * over `linger` seconds.
 *
 * SFX placeholder: sfx.weaponWeb (soft swipe).
 */
import * as THREE from 'three';
import { state } from '../../state.js';
import { tex } from '../../particleTextures.js';
import { sfx } from '../../audio.js';
import { damageEnemy, queryRadius } from '../../enemies.js';
import { applyFloorTier } from '../../fxLayers.js';
import { BLOOM_LAYER } from '../../postfx.js';

const STREAK_CAP = 32;
const STREAK_Y = 0.05;
const _m4 = new THREE.Matrix4();
const _v3 = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _hideMat = (() => { const m = new THREE.Matrix4(); m.compose(new THREE.Vector3(0, -1000, 0), new THREE.Quaternion(), new THREE.Vector3(0,0,0)); return m; })();

let _inst = null;
const _streaks = []; // { cx, cz, ang, len, width, t, life }

function _ensureMesh() {
  if (_inst) return;
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    map: tex('smokeWarm') || tex('moteMagenta'),
    color: 0xff66cc,
    transparent: true, opacity: 0.75, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  _inst = new THREE.InstancedMesh(geo, mat, STREAK_CAP);
  _inst.count = STREAK_CAP;
  _inst.frustumCulled = false;
  _inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < STREAK_CAP; i++) _inst.setMatrixAt(i, _hideMat);
  applyFloorTier(_inst, 'telegraph');
  _inst.layers.enable(BLOOM_LAYER);
  state.scene.add(_inst);
}

function _write(i, s) {
  // Same rectangle pivot trick as bomdia: place at axis midpoint, scale by len/width.
  const fade = 1 - s.t / s.life;
  const lx = s.cx + Math.cos(s.ang) * (s.len * 0.5);
  const lz = s.cz + Math.sin(s.ang) * (s.len * 0.5);
  _v3.set(lx, STREAK_Y, lz);
  _scl.set(s.len, 1, s.width * (0.5 + 0.5 * fade));
  _q.setFromEuler(new THREE.Euler(0, -s.ang, 0));
  _m4.compose(_v3, _q, _scl);
  _inst.setMatrixAt(i, _m4);
}
function _hide(i) { _inst.setMatrixAt(i, _hideMat); }

export function tickBrushstrokes(dt) {
  if (_streaks.length === 0) return;
  _ensureMesh();
  let dirty = false;
  for (let i = 0; i < STREAK_CAP; i++) {
    const s = _streaks[i];
    if (!s) continue;
    s.t += dt;
    if (s.t >= s.life) { _streaks[i] = null; _hide(i); dirty = true; continue; }
    _write(i, s);
    dirty = true;
  }
  if (dirty) _inst.instanceMatrix.needsUpdate = true;
}

function _paint(level) {
  _ensureMesh();
  const h = state.hero.pos;
  const len = level.length * (state.hero.statMul.area || 1);
  const width = level.width;
  const dmg = level.dmg * (state.hero.statMul.dmg || 1);
  for (let k = 0; k < level.count; k++) {
    let slot = -1;
    for (let i = 0; i < STREAK_CAP; i++) if (!_streaks[i]) { slot = i; break; }
    if (slot === -1) {
      let oldest = 0; let oldestT = -1;
      for (let i = 0; i < STREAK_CAP; i++) if (_streaks[i] && _streaks[i].t > oldestT) { oldestT = _streaks[i].t; oldest = i; }
      slot = oldest;
    }
    const ang = Math.random() * Math.PI * 2;
    _streaks[slot] = { cx: h.x, cz: h.z, ang, len, width, t: 0, life: level.linger };
    // Damage application — rectangle hit test (along/perp components)
    let cands = null;
    try { cands = queryRadius(h, len); } catch (_) { cands = state.enemies && state.enemies.active; }
    if (!cands) continue;
    const cosA = Math.cos(ang), sinA = Math.sin(ang);
    const halfW = width * 0.5;
    for (const e of cands) {
      if (!e || !e.alive || !e.mesh) continue;
      const rx = e.mesh.position.x - h.x;
      const rz = e.mesh.position.z - h.z;
      const along = rx * cosA + rz * sinA;
      if (along < 0 || along > len) continue;
      const perp = Math.abs(rx * -sinA + rz * cosA);
      if (perp > halfW) continue;
      damageEnemy(e, dmg, 'sig_mona_brushstroke');
    }
  }
}

export default {
  id: 'sig_mona_brushstroke',
  name: 'Brushstroke',
  desc: 'Painted streaks at random angles — expressive AoE.',
  icon: '🎨',
  maxLevel: 8,
  levels: [
    { cooldown: 2.4, count: 2, length:  6, width: 0.9, linger: 0.35, dmg: 14 },
    { cooldown: 2.2, count: 2, length:  7, width: 1.0, linger: 0.35, dmg: 19 },
    { cooldown: 2.0, count: 3, length:  7, width: 1.1, linger: 0.38, dmg: 26 },
    { cooldown: 1.8, count: 3, length:  8, width: 1.2, linger: 0.38, dmg: 34 },
    { cooldown: 1.6, count: 4, length:  8, width: 1.3, linger: 0.40, dmg: 44 },
    { cooldown: 1.5, count: 4, length:  9, width: 1.4, linger: 0.40, dmg: 58 },
    { cooldown: 1.3, count: 5, length: 10, width: 1.5, linger: 0.45, dmg: 76 },
    { cooldown: 1.1, count: 6, length: 11, width: 1.6, linger: 0.45, dmg: 100 },
  ],

  init(state, level, inst) { inst.cd = 0.5; },

  tick(state, dt, level, inst) {
    if (inst.cd === undefined) inst.cd = 0;
    inst.cd -= dt;
    tickBrushstrokes(dt);
    if (inst.cd > 0) return;
    _paint(level);
    try { sfx.weaponWeb(); } catch (_) {}
    inst.cd = level.cooldown * (state.hero.statMul.cooldown || 1) * (state.run.passive_cooldown || 1);
  },

  refresh(state, level, inst) {
    if (inst.cd > level.cooldown * 0.5) inst.cd = level.cooldown * 0.25;
  },
};
