/**
 * Sunburst — Bom Dia's signature weapon (Phase F1 of progression redesign).
 *
 * Cardinal-direction beam fan. Every cooldown the hero emits 4 (later 8)
 * beams along compass directions that sweep outward briefly and damage
 * everything in their path. The kit pairs with Clockwork baseArchetype's
 * Tempo signature (scales over time) so an early-run Bom Dia feels mild and
 * a late-run Bom Dia chains a sunrise of beams.
 *
 * Mechanic distinct: NOT a projectile and NOT an aura — beams are FIXED-
 * DIRECTION sweeps from the hero, so positioning matters (face the swarm).
 * Beams are static rectangles whose damage check runs once at cast time;
 * the visual lingers for `linger` seconds via a small InstancedMesh.
 *
 * Plan §2 #1: one shared 16-slot InstancedMesh capped at all-active beams
 * across all levels. Beam geometry is a unit plane scaled per-cast.
 *
 * SFX placeholder: sfx.weaponBurger (cast).
 */
import * as THREE from 'three';
import { state } from '../../state.js';
import { tex } from '../../particleTextures.js';
import { sfx } from '../../audio.js';
import { damageEnemy, queryRadius } from '../../enemies.js';
import { applyFloorTier } from '../../fxLayers.js';
import { BLOOM_LAYER } from '../../postfx.js';

const BEAM_CAP = 16;
const BEAM_Y = 0.10;
const _m4 = new THREE.Matrix4();
const _v3 = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _hideMat = (() => { const m = new THREE.Matrix4(); m.compose(new THREE.Vector3(0, -1000, 0), new THREE.Quaternion(), new THREE.Vector3(0,0,0)); return m; })();

let _inst = null;
const _beams = []; // { cx, cz, ang, len, width, t, life }

function _ensureMesh() {
  if (_inst) return;
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    map: tex('wizardBolt') || tex('moteWhite'),
    color: 0xffe080,
    transparent: true, opacity: 0.85, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  _inst = new THREE.InstancedMesh(geo, mat, BEAM_CAP);
  _inst.count = BEAM_CAP;
  _inst.frustumCulled = false;
  _inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < BEAM_CAP; i++) _inst.setMatrixAt(i, _hideMat);
  applyFloorTier(_inst, 'telegraph');
  _inst.layers.enable(BLOOM_LAYER);
  state.scene.add(_inst);
}

function _writeBeam(i, b) {
  // Beam is a rectangle pivoted at one end; offset the plane forward by
  // half its length and rotate by yaw. Decaying width pulses the beam thin.
  const fade = 1 - b.t / b.life;
  const lx = b.cx + Math.cos(b.ang) * (b.len * 0.5);
  const lz = b.cz + Math.sin(b.ang) * (b.len * 0.5);
  _v3.set(lx, BEAM_Y, lz);
  _scl.set(b.len, 1, b.width * (0.5 + 0.5 * fade));
  _q.setFromEuler(new THREE.Euler(0, -b.ang, 0));
  _m4.compose(_v3, _q, _scl);
  _inst.setMatrixAt(i, _m4);
}

function _hide(i) { _inst.setMatrixAt(i, _hideMat); }

export function tickSunbursts(dt) {
  if (_beams.length === 0) return;
  _ensureMesh();
  let dirty = false;
  for (let i = 0; i < BEAM_CAP; i++) {
    const b = _beams[i];
    if (!b) continue;
    b.t += dt;
    if (b.t >= b.life) {
      _beams[i] = null;
      _hide(i);
      dirty = true;
      continue;
    }
    _writeBeam(i, b);
    dirty = true;
  }
  if (dirty) _inst.instanceMatrix.needsUpdate = true;
}

function _castBeams(level) {
  _ensureMesh();
  const h = state.hero.pos;
  const len = level.length * (state.hero.statMul.area || 1);
  const width = level.width;
  const dmg = level.dmg * (state.hero.statMul.dmg || 1);
  const dirs = level.beamCount === 8
    ? [0, Math.PI/4, Math.PI/2, 3*Math.PI/4, Math.PI, 5*Math.PI/4, 3*Math.PI/2, 7*Math.PI/4]
    : [0, Math.PI/2, Math.PI, 3*Math.PI/2];
  for (const ang of dirs) {
    // Find a free slot
    let slot = -1;
    for (let i = 0; i < BEAM_CAP; i++) if (!_beams[i]) { slot = i; break; }
    if (slot === -1) {
      let oldest = 0; let oldestT = -1;
      for (let i = 0; i < BEAM_CAP; i++) if (_beams[i] && _beams[i].t > oldestT) { oldestT = _beams[i].t; oldest = i; }
      slot = oldest;
    }
    _beams[slot] = { cx: h.x, cz: h.z, ang, len, width, t: 0, life: level.linger };
    // Damage application — rectangle-in-world test. We sample candidates in
    // a circle of radius `len` and accept those whose perpendicular distance
    // to the beam axis is within width/2.
    let cands = null;
    try { cands = queryRadius(h, len); } catch (_) { cands = state.enemies && state.enemies.active; }
    if (!cands) continue;
    const cosA = Math.cos(ang), sinA = Math.sin(ang);
    const halfW = width * 0.5;
    for (const e of cands) {
      if (!e || !e.alive || !e.mesh) continue;
      const rx = e.mesh.position.x - h.x;
      const rz = e.mesh.position.z - h.z;
      // Along-axis component (0..len) and perpendicular (|.| ≤ halfW)
      const along = rx * cosA + rz * sinA;
      if (along < 0 || along > len) continue;
      const perp = Math.abs(rx * -sinA + rz * cosA);
      if (perp > halfW) continue;
      damageEnemy(e, dmg, 'sig_bomdia_sunburst');
    }
  }
}

export default {
  id: 'sig_bomdia_sunburst',
  name: 'Sunburst',
  desc: 'Compass beams sweep out — late-run Tempo turns morning into noon.',
  icon: '☀️',
  maxLevel: 8,
  levels: [
    { cooldown: 3.8, length:  7, width: 1.0, linger: 0.30, dmg: 16, beamCount: 4 },
    { cooldown: 3.5, length:  8, width: 1.1, linger: 0.30, dmg: 22, beamCount: 4 },
    { cooldown: 3.2, length:  9, width: 1.2, linger: 0.32, dmg: 30, beamCount: 4 },
    { cooldown: 2.9, length: 10, width: 1.3, linger: 0.32, dmg: 40, beamCount: 4 },
    { cooldown: 2.6, length: 11, width: 1.4, linger: 0.35, dmg: 52, beamCount: 8 },
    { cooldown: 2.3, length: 12, width: 1.5, linger: 0.35, dmg: 68, beamCount: 8 },
    { cooldown: 2.0, length: 13, width: 1.6, linger: 0.38, dmg: 88, beamCount: 8 },
    { cooldown: 1.7, length: 15, width: 1.8, linger: 0.40, dmg: 115, beamCount: 8 },
  ],

  init(state, level, inst) { inst.cd = 0.4; },

  tick(state, dt, level, inst) {
    if (inst.cd === undefined) inst.cd = 0;
    inst.cd -= dt;
    tickSunbursts(dt);
    if (inst.cd > 0) return;
    _castBeams(level);
    try { sfx.weaponBurger(); } catch (_) {}
    inst.cd = level.cooldown * (state.hero.statMul.cooldown || 1) * (state.run.passive_cooldown || 1);
  },

  refresh(state, level, inst) {
    if (inst.cd > level.cooldown * 0.5) inst.cd = level.cooldown * 0.25;
  },
};
