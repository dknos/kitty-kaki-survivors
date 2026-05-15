/**
 * Satellites — Space Kitty's signature weapon (Phase D of progression redesign).
 *
 * Orbital kit, mirror of weapons/orbitals.js but with twin counter-rotating
 * rings of smaller, faster, more numerous bodies. Tunes for "many small hits"
 * vs orbitals' "few big slams":
 *   - Inner ring: 3-6 sats, fast CCW, small hit radius
 *   - Outer ring: 3-6 sats, slow CW, larger hit radius
 *
 * Plan §2 #1: one InstancedMesh shared across both rings (twin rings sharing
 * a single 1×1 PlaneGeometry pool). All instance transforms baked into the
 * matrix per frame; no Group/Mesh allocations per satellite.
 *
 * Visuals: starSprite texture, additive, FRONT side (sprites face camera
 * via flat-on-floor orientation — same trick as fx.js kill rings).
 *
 * SFX placeholder: reuses sfx.weaponBurger (impact). Phase G adds bespoke.
 */
import * as THREE from 'three';
import { state } from '../../state.js';
import { tex } from '../../particleTextures.js';
import { BLOOM_LAYER } from '../../postfx.js';
import { sfx } from '../../audio.js';
import { damageEnemy, queryRadius } from '../../enemies.js';

const SAT_CAP = 16;        // 8 outer + 8 inner = 16 slots max
const SAT_SIZE = 0.55;
const SAT_Y = 0.45;
const HIT_RADIUS = 0.55;

const _m4 = new THREE.Matrix4();
const _v3 = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _flatQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const _zero = new THREE.Vector3(0, 0, 0);
const _hideMat = (() => { const m = new THREE.Matrix4(); m.compose(new THREE.Vector3(0, -1000, 0), _flatQ, _zero); return m; })();

let _inst = null;

function _ensureMesh() {
  if (_inst) return;
  const geo = new THREE.PlaneGeometry(SAT_SIZE, SAT_SIZE);
  const mat = new THREE.MeshBasicMaterial({
    map: tex('starSprite') || tex('flashStar'),
    color: 0xcde6ff,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  _inst = new THREE.InstancedMesh(geo, mat, SAT_CAP);
  _inst.count = SAT_CAP;
  _inst.frustumCulled = false;
  _inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < SAT_CAP; i++) _inst.setMatrixAt(i, _hideMat);
  _inst.instanceMatrix.needsUpdate = true;
  _inst.layers.enable(BLOOM_LAYER);
  state.scene.add(_inst);
}

function _writeSat(i, x, z, scale) {
  _v3.set(x, SAT_Y, z);
  _scale.set(scale, scale, scale);
  _m4.compose(_v3, _flatQ, _scale);
  _inst.setMatrixAt(i, _m4);
}

function _hide(i) {
  _inst.setMatrixAt(i, _hideMat);
}

export default {
  id: 'sig_space_satellites',
  name: 'Satellites',
  desc: 'Twin counter-rotating sat rings — fast, many, ticky.',
  icon: '🛰',
  maxLevel: 8,
  // Provisional. innerCount + outerCount ≤ 16 (SAT_CAP). dmgInterval is short
  // so the ring feels like a chainsaw of small ticks; Phase G recalibrates.
  levels: [
    { innerCount: 2, outerCount: 2, innerR: 1.8, outerR: 3.0, innerSpeed:  3.6, outerSpeed: -2.0, dmg:  6, dmgInterval: 0.35 },
    { innerCount: 3, outerCount: 2, innerR: 1.9, outerR: 3.1, innerSpeed:  3.8, outerSpeed: -2.1, dmg:  8, dmgInterval: 0.30 },
    { innerCount: 3, outerCount: 3, innerR: 2.0, outerR: 3.2, innerSpeed:  4.0, outerSpeed: -2.2, dmg: 10, dmgInterval: 0.28 },
    { innerCount: 4, outerCount: 3, innerR: 2.1, outerR: 3.3, innerSpeed:  4.2, outerSpeed: -2.3, dmg: 13, dmgInterval: 0.26 },
    { innerCount: 4, outerCount: 4, innerR: 2.2, outerR: 3.4, innerSpeed:  4.4, outerSpeed: -2.4, dmg: 16, dmgInterval: 0.24 },
    { innerCount: 5, outerCount: 4, innerR: 2.3, outerR: 3.5, innerSpeed:  4.6, outerSpeed: -2.5, dmg: 20, dmgInterval: 0.22 },
    { innerCount: 5, outerCount: 5, innerR: 2.4, outerR: 3.6, innerSpeed:  4.8, outerSpeed: -2.6, dmg: 26, dmgInterval: 0.20 },
    { innerCount: 6, outerCount: 6, innerR: 2.5, outerR: 3.8, innerSpeed:  5.0, outerSpeed: -2.8, dmg: 34, dmgInterval: 0.18 },
  ],

  init(state, level, inst) {
    _ensureMesh();
    inst.innerAngle = 0;
    inst.outerAngle = 0;
    inst.lastHit = new Map();  // enemyRef -> last-hit-time
  },

  tick(state, dt, level, inst) {
    _ensureMesh();
    const hero = state.hero.pos;
    const now = state.time.game;
    const areaMul = state.hero.statMul.area || 1;
    const dmgMul = state.hero.statMul.dmg || 1;
    const innerR = level.innerR * areaMul;
    const outerR = level.outerR * areaMul;
    inst.innerAngle += level.innerSpeed * dt;
    inst.outerAngle += level.outerSpeed * dt;

    // Place inner ring
    let slot = 0;
    for (let i = 0; i < level.innerCount && slot < SAT_CAP; i++, slot++) {
      const a = inst.innerAngle + (i / level.innerCount) * Math.PI * 2;
      const x = hero.x + Math.cos(a) * innerR;
      const z = hero.z + Math.sin(a) * innerR;
      _writeSat(slot, x, z, 1.0);
    }
    // Place outer ring (slightly bigger sprites)
    for (let i = 0; i < level.outerCount && slot < SAT_CAP; i++, slot++) {
      const a = inst.outerAngle + (i / level.outerCount) * Math.PI * 2;
      const x = hero.x + Math.cos(a) * outerR;
      const z = hero.z + Math.sin(a) * outerR;
      _writeSat(slot, x, z, 1.25);
    }
    // Hide unused slots
    for (let i = slot; i < SAT_CAP; i++) _hide(i);
    _inst.instanceMatrix.needsUpdate = true;

    // Collision: walk both rings, check enemies near each sat. Hits dedup
    // per-enemy by dmgInterval (mirrors orbitals.js pattern).
    const dmg = level.dmg * dmgMul;
    const interval = level.dmgInterval;
    slot = 0;
    for (let i = 0; i < level.innerCount; i++, slot++) {
      const a = inst.innerAngle + (i / level.innerCount) * Math.PI * 2;
      const x = hero.x + Math.cos(a) * innerR;
      const z = hero.z + Math.sin(a) * innerR;
      _check(inst, x, z, dmg, interval, now);
    }
    for (let i = 0; i < level.outerCount; i++, slot++) {
      const a = inst.outerAngle + (i / level.outerCount) * Math.PI * 2;
      const x = hero.x + Math.cos(a) * outerR;
      const z = hero.z + Math.sin(a) * outerR;
      _check(inst, x, z, dmg, interval, now);
    }
  },

  refresh(state, level, inst) {
    // Re-seed angles so the rebuilt ring spread doesn't snap; keep deltas.
  },
};

function _check(inst, x, z, dmg, interval, now) {
  let cands = null;
  try { cands = queryRadius({ x, z }, HIT_RADIUS); } catch (_) { cands = null; }
  if (!cands) return;
  for (const e of cands) {
    if (!e || !e.alive || !e.mesh) continue;
    const dx = e.mesh.position.x - x;
    const dz = e.mesh.position.z - z;
    if (dx * dx + dz * dz > HIT_RADIUS * HIT_RADIUS) continue;
    const last = inst.lastHit.get(e) || -Infinity;
    if (now - last < interval) continue;
    damageEnemy(e, dmg, 'sig_space_satellites');
    inst.lastHit.set(e, now);
    try { sfx.weaponBurger(); } catch (_) {}
  }
}
