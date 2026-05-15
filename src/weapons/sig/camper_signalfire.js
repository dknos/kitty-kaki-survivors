/**
 * Signal Fire — Camper's signature weapon (Phase F2 of progression redesign).
 *
 * Planted hazard. Drops a smoldering campfire at the hero's position that
 * stays for `duration` seconds and applies a fire DoT to every enemy that
 * walks into its radius. Pairs with Phoenix baseArchetype's Ember Burst —
 * the kit identity says "fire begets fire". On hero death the existing
 * signature_emberBurst path still fires from hero.js.
 *
 * Mechanic distinct from sig_mothman_dustcloak (also a planted DoT zone):
 *   - Higher cooldown, longer life, smaller radius → fewer-but-stickier hot
 *     spots vs mothman's overlapping pollen carpet.
 *   - Each fire applies a strong DoT for a short window; mothman applies a
 *     weak DoT continuously. Different damage shape.
 *
 * Plan §2 #1: one shared 8-slot InstancedMesh (cap-bounded). Uses existing
 * lavaPuddle texture so no new asset gen needed.
 *
 * SFX placeholder: sfx.weaponBurger (cast thump).
 */
import * as THREE from 'three';
import { state } from '../../state.js';
import { tex } from '../../particleTextures.js';
import { sfx } from '../../audio.js';
import { queryRadius } from '../../enemies.js';
import { applyFloorTier, floorDecalGeometry, floorDecalMaterial } from '../../fxLayers.js';

const FIRE_CAP = 8;
const FIRE_Y = 0.05;
const _m4 = new THREE.Matrix4();
const _v3 = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _hideMat = (() => { const m = new THREE.Matrix4(); m.compose(new THREE.Vector3(0, -1000, 0), new THREE.Quaternion(), new THREE.Vector3(0,0,0)); return m; })();

let _inst = null;
const _fires = []; // { x, z, ttl, life, radius, dmgPerSec, nextDot }

function _ensureMesh() {
  if (_inst) return;
  const geo = floorDecalGeometry(2);
  const mat = floorDecalMaterial({ map: tex('lavaPuddle') || tex('emberWarm'), color: 0xff7a3a, opacity: 0.85 });
  _inst = new THREE.InstancedMesh(geo, mat, FIRE_CAP);
  _inst.count = FIRE_CAP;
  _inst.frustumCulled = false;
  _inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < FIRE_CAP; i++) _inst.setMatrixAt(i, _hideMat);
  applyFloorTier(_inst, 'telegraph');
  state.scene.add(_inst);
}

function _write(i, f) {
  const k = f.ttl / f.life;
  const r = f.radius * (0.7 + 0.3 * k) * (1 + 0.08 * Math.sin(state.time.game * 7));
  _v3.set(f.x, FIRE_Y, f.z);
  _scl.set(r, r, r);
  _m4.compose(_v3, _q, _scl);
  _inst.setMatrixAt(i, _m4);
}
function _hide(i) { _inst.setMatrixAt(i, _hideMat); }

export function tickSignalFires(dt) {
  if (_fires.length === 0) return;
  _ensureMesh();
  let dirty = false;
  for (let i = 0; i < FIRE_CAP; i++) {
    const f = _fires[i];
    if (!f) continue;
    f.ttl -= dt;
    if (f.ttl <= 0) {
      _fires[i] = null;
      _hide(i);
      dirty = true;
      continue;
    }
    _write(i, f);
    dirty = true;
    f.nextDot -= dt;
    if (f.nextDot > 0) continue;
    f.nextDot += 0.35;            // DoT tick interval
    let cands = null;
    try { cands = queryRadius({ x: f.x, z: f.z }, f.radius); } catch (_) { cands = null; }
    if (!cands) continue;
    const r2 = f.radius * f.radius;
    for (const e of cands) {
      if (!e || !e.alive || !e.mesh) continue;
      const dx = e.mesh.position.x - f.x;
      const dz = e.mesh.position.z - f.z;
      if (dx * dx + dz * dz > r2) continue;
      e._dotDps = Math.max(e._dotDps || 0, f.dmgPerSec);
      e._dotUntil = Math.max(e._dotUntil || 0, state.time.game + 0.55);
      e._dotSource = 'sig_camper_signalfire';
    }
  }
  if (dirty) _inst.instanceMatrix.needsUpdate = true;
}

function _light(level) {
  _ensureMesh();
  let slot = -1;
  for (let i = 0; i < FIRE_CAP; i++) if (!_fires[i]) { slot = i; break; }
  if (slot === -1) {
    let oldest = 0; let oldestTtl = Infinity;
    for (let i = 0; i < FIRE_CAP; i++) if (_fires[i] && _fires[i].ttl < oldestTtl) { oldestTtl = _fires[i].ttl; oldest = i; }
    slot = oldest;
  }
  const h = state.hero.pos;
  _fires[slot] = {
    x: h.x, z: h.z,
    ttl: level.duration, life: level.duration,
    radius: level.radius * (state.hero.statMul.area || 1),
    dmgPerSec: level.dmgPerSec * (state.hero.statMul.dmg || 1),
    nextDot: 0,
  };
}

export default {
  id: 'sig_camper_signalfire',
  name: 'Signal Fire',
  desc: 'Planted bonfires — fewer, stickier hot spots vs Mothman pollen.',
  icon: '🔥',
  maxLevel: 8,
  levels: [
    { cooldown: 5.5, duration: 6.0, radius: 2.6, dmgPerSec:  9 },
    { cooldown: 5.0, duration: 6.5, radius: 2.8, dmgPerSec: 12 },
    { cooldown: 4.5, duration: 7.0, radius: 3.0, dmgPerSec: 16 },
    { cooldown: 4.0, duration: 7.5, radius: 3.2, dmgPerSec: 21 },
    { cooldown: 3.6, duration: 8.0, radius: 3.4, dmgPerSec: 28 },
    { cooldown: 3.2, duration: 8.5, radius: 3.6, dmgPerSec: 37 },
    { cooldown: 2.8, duration: 9.0, radius: 3.8, dmgPerSec: 50 },
    { cooldown: 2.4, duration: 10.0, radius: 4.0, dmgPerSec: 66 },
  ],

  init(state, level, inst) { inst.cd = 0.8; },

  tick(state, dt, level, inst) {
    if (inst.cd === undefined) inst.cd = 0;
    inst.cd -= dt;
    tickSignalFires(dt);
    if (inst.cd > 0) return;
    _light(level);
    try { sfx.weaponBurger(); } catch (_) {}
    inst.cd = level.cooldown * (state.hero.statMul.cooldown || 1) * (state.run.passive_cooldown || 1);
  },

  refresh(state, level, inst) {
    if (inst.cd > level.cooldown * 0.5) inst.cd = level.cooldown * 0.25;
  },
};
