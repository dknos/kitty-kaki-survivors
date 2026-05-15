/**
 * Dust Cloak — Mothman's signature weapon (Phase D of progression redesign).
 *
 * Trap/zone kit. Drops a pollen cloud at the hero's position on cooldown:
 *   - applies a damage-over-time tick to any enemy inside the radius
 *   - applies a brief slow (lighter than web, since DoT IS the value here)
 *   - pairs with the Webspinner baseArchetype's Lingering Silk signature:
 *     standing in your own cloud heals via signature_webHeal (we register
 *     each cloud into state.webs.list so the existing tickWebs heal path
 *     finds it without a new accessor).
 *
 * Visuals: one shared InstancedMesh of pollen-textured planes (cap-bounded,
 * plan §2 #1). Cloud planes ride the FLOOR_TIER.telegraph layer via fxLayers
 * so they sort under enemy silhouettes.
 *
 * SFX placeholder: reuses sfx.weaponWeb (cast). Phase G adds bespoke audio.
 */
import * as THREE from 'three';
import { state } from '../../state.js';
import { tex } from '../../particleTextures.js';
import { sfx } from '../../audio.js';
import { queryRadius } from '../../enemies.js';
import { applyFloorTier, floorDecalGeometry, floorDecalMaterial } from '../../fxLayers.js';

const CLOUD_CAP = 16;
const CLOUD_Y = 0.06;
const _m4 = new THREE.Matrix4();
const _v3 = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _hideMat = (() => {
  const m = new THREE.Matrix4();
  const z = new THREE.Vector3(0, 0, 0);
  m.compose(new THREE.Vector3(0, -1000, 0), new THREE.Quaternion(), z);
  return m;
})();

let _inst = null;
const _clouds = []; // { x, z, radius, ttl, life, dmgPerSec, dotInterval, nextDot }

function _ensureMesh() {
  if (_inst) return;
  const geo = floorDecalGeometry(2);
  const mat = floorDecalMaterial({ map: tex('pollen'), color: 0xb6f6c2, opacity: 0.55 });
  _inst = new THREE.InstancedMesh(geo, mat, CLOUD_CAP);
  _inst.count = CLOUD_CAP;
  _inst.frustumCulled = false;
  _inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < CLOUD_CAP; i++) _inst.setMatrixAt(i, _hideMat);
  applyFloorTier(_inst, 'telegraph');
  state.scene.add(_inst);
}

function _writeCloudMatrix(i, c) {
  const k = c.ttl / c.life;            // 1..0 over lifetime
  const r = c.radius * (0.75 + 0.25 * k);
  _v3.set(c.x, CLOUD_Y, c.z);
  _scale.set(r, r, r);
  _m4.compose(_v3, new THREE.Quaternion(), _scale);
  _inst.setMatrixAt(i, _m4);
}

function _hide(i) {
  _inst.setMatrixAt(i, _hideMat);
}

export function tickDustClouds(dt) {
  if (_clouds.length === 0) return;
  _ensureMesh();
  let dirty = false;
  for (let i = 0; i < CLOUD_CAP; i++) {
    const c = _clouds[i];
    if (!c) { continue; }
    c.ttl -= dt;
    if (c.ttl <= 0) {
      _clouds[i] = null;
      _hide(i);
      dirty = true;
      continue;
    }
    _writeCloudMatrix(i, c);
    dirty = true;
    c.nextDot -= dt;
    if (c.nextDot > 0) continue;
    c.nextDot += c.dotInterval;
    // DoT stamp: refresh _dotDps/_dotUntil on enemies inside. Same channel
    // enemies.js already drains, so we don't add a new tick path.
    let cands = null;
    try { cands = queryRadius({ x: c.x, z: c.z }, c.radius); } catch (_) { cands = null; }
    if (!cands) continue;
    const r2 = c.radius * c.radius;
    for (const e of cands) {
      if (!e || !e.alive || !e.mesh) continue;
      const dx = e.mesh.position.x - c.x;
      const dz = e.mesh.position.z - c.z;
      if (dx * dx + dz * dz > r2) continue;
      e._dotDps = Math.max(e._dotDps || 0, c.dmgPerSec);
      e._dotUntil = Math.max(e._dotUntil || 0, state.time.game + c.dotInterval * 1.3);
      e._dotSource = 'sig_mothman_dustcloak';
    }
  }
  if (dirty) _inst.instanceMatrix.needsUpdate = true;
}

function _spawnCloud(x, z, level) {
  _ensureMesh();
  // Find a free slot. Cloud cap is intentionally small (16) — overflow drops
  // the oldest entry so a long run can't accumulate ghost clouds.
  let slot = -1;
  for (let i = 0; i < CLOUD_CAP; i++) if (!_clouds[i]) { slot = i; break; }
  if (slot === -1) {
    let oldest = 0; let oldestTtl = Infinity;
    for (let i = 0; i < CLOUD_CAP; i++) if (_clouds[i] && _clouds[i].ttl < oldestTtl) { oldestTtl = _clouds[i].ttl; oldest = i; }
    slot = oldest;
  }
  const radius = level.radius * (state.hero.statMul.area || 1);
  const ttl    = level.duration * (state.hero.statMul.duration || 1);
  _clouds[slot] = {
    x, z, radius,
    ttl, life: ttl,
    dmgPerSec: level.dmgPerSec * (state.hero.statMul.dmg || 1),
    dotInterval: 0.5,
    nextDot: 0,
  };
  // Mothman pairs with the webspinner Lingering Silk signature; we ride the
  // existing state.webs.list heal path by pushing a passive "web" entry that
  // has slowMul=1 (no slow contribution) so it counts only for the heal.
  if (state.webs && state.webs.list) {
    state.webs.list.push({
      x, z, radius,
      ttl, life: ttl,
      slowMul: 1.0,        // no slow — dust IS the slow vector for sig_mothman
      burn: false,
      _passive: true,       // marker: tickWebs shouldn't render this via web pool
    });
  }
}

export default {
  id: 'sig_mothman_dustcloak',
  name: 'Dust Cloak',
  desc: 'Pollen clouds at your feet — DoT + Silk heal stacking.',
  icon: '🦋',
  maxLevel: 8,
  // Provisional curve. dmgPerSec ramps so the cloud feels like an evolving
  // hazard, not a static damage tile. Radius grows slower than web — clouds
  // are meant to chain WITH movement, not blanket the screen.
  levels: [
    { cooldown: 3.2, duration: 4.5, radius: 3.0, dmgPerSec: 4  },
    { cooldown: 3.0, duration: 4.8, radius: 3.2, dmgPerSec: 5  },
    { cooldown: 2.8, duration: 5.0, radius: 3.4, dmgPerSec: 7  },
    { cooldown: 2.6, duration: 5.2, radius: 3.6, dmgPerSec: 9  },
    { cooldown: 2.4, duration: 5.5, radius: 3.8, dmgPerSec: 12 },
    { cooldown: 2.2, duration: 5.8, radius: 4.0, dmgPerSec: 16 },
    { cooldown: 2.0, duration: 6.0, radius: 4.2, dmgPerSec: 22 },
    { cooldown: 1.7, duration: 6.5, radius: 4.5, dmgPerSec: 30 },
  ],

  init(state, level, inst) { inst.cd = 0.6; },

  tick(state, dt, level, inst) {
    if (inst.cd === undefined) inst.cd = 0;
    inst.cd -= dt;
    tickDustClouds(dt);
    if (inst.cd > 0) return;
    const h = state.hero.pos;
    _spawnCloud(h.x, h.z, level);
    try { sfx.weaponWeb(); } catch (_) {}
    inst.cd = level.cooldown * (state.hero.statMul.cooldown || 1) * (state.run.passive_cooldown || 1);
  },

  refresh(state, level, inst) {
    if (inst.cd > level.cooldown * 0.5) inst.cd = level.cooldown * 0.25;
  },
};
