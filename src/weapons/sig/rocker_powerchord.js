/**
 * Power Chord — RockerKaki's signature weapon (Phase F3 of progression redesign).
 *
 * Sonic wavefront. Hero strikes a chord on cooldown; a forward-facing sonic
 * cone propagates from the hero's facing direction, dealing damage as it
 * sweeps outward. Hero "faces" the closest enemy at the moment of strike,
 * so positioning + aim are the player's decision but the chord itself
 * commits to that vector for the duration of the wave.
 *
 * Mechanic distinct from sig_sote_warhowl (radial shockwave, 360°) and
 * sig_bomdia_sunburst (8-way compass beams):
 *   - One DIRECTIONAL cone, not radial — encourages the player to face the
 *     densest swarm before firing.
 *   - Each enemy is hit ONCE during the cone's sweep (captured at cast time
 *     based on perpendicular + along-axis position, drained as the wave
 *     advances). No per-frame swarm scan.
 *
 * Plan §2 #1: shares one 4-slot InstancedMesh for the wave visual. Uses a
 * scaled rectangle plane textured with `wizardBolt` (warm magenta tint).
 *
 * SFX placeholder: sfx.weaponChain (close cousin in energy / crack).
 */
import * as THREE from 'three';
import { state } from '../../state.js';
import { tex } from '../../particleTextures.js';
import { sfx } from '../../audio.js';
import { damageEnemy, queryRadius } from '../../enemies.js';
import { applyFloorTier } from '../../fxLayers.js';
import { BLOOM_LAYER } from '../../postfx.js';

const WAVE_CAP = 4;
const WAVE_Y = 0.08;
const _m4 = new THREE.Matrix4();
const _v3 = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _hideMat = (() => { const m = new THREE.Matrix4(); m.compose(new THREE.Vector3(0, -1000, 0), new THREE.Quaternion(), new THREE.Vector3(0,0,0)); return m; })();

let _inst = null;
const _waves = []; // { cx, cz, ang, maxLen, width, t, life, dmg, targets:[{e,along}], idx }

function _ensureMesh() {
  if (_inst) return;
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    map: tex('wizardBolt') || tex('moteMagenta'),
    color: 0xff66cc,
    transparent: true, opacity: 0.85, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  _inst = new THREE.InstancedMesh(geo, mat, WAVE_CAP);
  _inst.count = WAVE_CAP;
  _inst.frustumCulled = false;
  _inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < WAVE_CAP; i++) _inst.setMatrixAt(i, _hideMat);
  applyFloorTier(_inst, 'telegraph');
  _inst.layers.enable(BLOOM_LAYER);
  state.scene.add(_inst);
}

function _write(i, w) {
  const k = w.t / w.life;
  const len = w.maxLen * k;          // wavefront expands linearly
  // Plane placed so its near edge stays at the hero and far edge tracks the
  // wavefront. Mid-point sits at len/2 from hero in direction `ang`.
  const lx = w.cx + Math.cos(w.ang) * (len * 0.5);
  const lz = w.cz + Math.sin(w.ang) * (len * 0.5);
  _v3.set(lx, WAVE_Y, lz);
  _scl.set(len || 0.01, 1, w.width);
  _q.setFromEuler(new THREE.Euler(0, -w.ang, 0));
  _m4.compose(_v3, _q, _scl);
  _inst.setMatrixAt(i, _m4);
}
function _hide(i) { _inst.setMatrixAt(i, _hideMat); }

export function tickPowerChords(dt) {
  if (_waves.length === 0) return;
  _ensureMesh();
  let dirty = false;
  for (let i = 0; i < WAVE_CAP; i++) {
    const w = _waves[i];
    if (!w) continue;
    w.t += dt;
    if (w.t >= w.life) { _waves[i] = null; _hide(i); dirty = true; continue; }
    _write(i, w);
    dirty = true;
    const len = w.maxLen * (w.t / w.life);
    while (w.idx < w.targets.length && w.targets[w.idx].along <= len) {
      const { e } = w.targets[w.idx];
      if (e && e.alive) damageEnemy(e, w.dmg, 'sig_rocker_powerchord');
      w.idx += 1;
    }
  }
  if (dirty) _inst.instanceMatrix.needsUpdate = true;
}

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

function _strike(level) {
  _ensureMesh();
  const h = state.hero.pos;
  // Pick wave direction: face the closest enemy if any in range; otherwise
  // use the hero's facing vector so the chord still fires in a sensible dir.
  let ang;
  const tgt = _findNearest(h, 20);
  if (tgt) {
    ang = Math.atan2(tgt.mesh.position.z - h.z, tgt.mesh.position.x - h.x);
  } else if (state.hero.facing) {
    ang = Math.atan2(state.hero.facing.z || 0, state.hero.facing.x || 1);
  } else {
    ang = 0;
  }
  const maxLen = level.length * (state.hero.statMul.area || 1);
  const width = level.width;
  const dmg = level.dmg * (state.hero.statMul.dmg || 1);
  // Capture targets within the wedge at cast time + store along-axis distance
  // so tickPowerChords can drain them as the wave passes through.
  const targets = [];
  let cands = null;
  try { cands = queryRadius(h, maxLen); } catch (_) { cands = state.enemies && state.enemies.active; }
  if (cands) {
    const cosA = Math.cos(ang), sinA = Math.sin(ang);
    const halfW = width * 0.5;
    for (const e of cands) {
      if (!e || !e.alive || !e.mesh) continue;
      const rx = e.mesh.position.x - h.x;
      const rz = e.mesh.position.z - h.z;
      const along = rx * cosA + rz * sinA;
      if (along < 0 || along > maxLen) continue;
      const perp = Math.abs(rx * -sinA + rz * cosA);
      if (perp > halfW) continue;
      targets.push({ e, along });
    }
  }
  targets.sort((a, b) => a.along - b.along);
  let slot = -1;
  for (let i = 0; i < WAVE_CAP; i++) if (!_waves[i]) { slot = i; break; }
  if (slot === -1) {
    let oldest = 0; let oldestT = -1;
    for (let i = 0; i < WAVE_CAP; i++) if (_waves[i] && _waves[i].t > oldestT) { oldestT = _waves[i].t; oldest = i; }
    slot = oldest;
  }
  _waves[slot] = { cx: h.x, cz: h.z, ang, maxLen, width, t: 0, life: level.duration, dmg, targets, idx: 0 };
}

export default {
  id: 'sig_rocker_powerchord',
  name: 'Power Chord',
  desc: 'Forward sonic wave — face the swarm, then strike.',
  icon: '🎸',
  maxLevel: 8,
  levels: [
    { cooldown: 2.6, length:  8, width: 3.0, duration: 0.45, dmg: 20 },
    { cooldown: 2.4, length:  9, width: 3.2, duration: 0.45, dmg: 27 },
    { cooldown: 2.2, length: 10, width: 3.4, duration: 0.50, dmg: 36 },
    { cooldown: 2.0, length: 11, width: 3.6, duration: 0.50, dmg: 48 },
    { cooldown: 1.8, length: 12, width: 3.8, duration: 0.55, dmg: 62 },
    { cooldown: 1.6, length: 13, width: 4.0, duration: 0.55, dmg: 82 },
    { cooldown: 1.4, length: 14, width: 4.4, duration: 0.60, dmg: 108 },
    { cooldown: 1.2, length: 16, width: 4.8, duration: 0.60, dmg: 140 },
  ],

  init(state, level, inst) { inst.cd = 0.5; },

  tick(state, dt, level, inst) {
    if (inst.cd === undefined) inst.cd = 0;
    inst.cd -= dt;
    tickPowerChords(dt);
    if (inst.cd > 0) return;
    _strike(level);
    try { sfx.weaponChain(); } catch (_) {}
    inst.cd = level.cooldown * (state.hero.statMul.cooldown || 1) * (state.run.passive_cooldown || 1);
  },

  refresh(state, level, inst) {
    if (inst.cd > level.cooldown * 0.5) inst.cd = level.cooldown * 0.25;
  },
};
