/**
 * Drop pickups: heart (HP) and star (gem-vacuum).
 *
 * Pooled InstancedMesh per type. Pickup logic on hero contact each frame.
 * Spawn rate is gated in enemies.killEnemy.
 *
 * Hearts:  heal 25 HP. 5% drop chance per kill, 100% on elite.
 * Stars:   instantly magnetize every on-screen gem. 2% chance, 50% on elite.
 */
import * as THREE from 'three';
import { state } from './state.js';
import { spawnMagnetSpark } from './fx.js';
import { HERO } from './config.js';
import { sfx } from './audio.js';
import { tex } from './particleTextures.js';
import { BLOOM_LAYER } from './postfx.js';

const ATTRACT_MUL = 2.5;    // attraction radius = pickupRadius × this
const ATTRACT_ACCEL = 28;
const ATTRACT_MAX = 22;

const CAP_HEARTS = 32;
const CAP_STARS  = 16;
const CAP_BOMBS  = 8;
const CAP_FREEZE = 8;
const CAP_CHICKENS = 6;
const Y_BASE = 0.7;
const PICK_R2 = 1.4 * 1.4;

const _m4 = new THREE.Matrix4();
const _v3 = new THREE.Vector3();
const _q  = new THREE.Quaternion();

let _heartInst = null;
let _starInst  = null;
let _bombInst = null;
let _freezeInst = null;
let _chickenInst = null;
// Per-pickup billboard halo sprite layer — one InstancedMesh per pickup
// family, painted with the matching procedural decal. Sits flat above each
// pickup and floats at the same Y. Sells the pickup as a "hand-drawn icon"
// rather than a primitive shape.
let _heartHaloInst = null;
let _starHaloInst = null;
let _bombHaloInst = null;
let _freezeHaloInst = null;
let _chickenHaloInst = null;

const _hearts = []; // {x,z,t}
const _stars  = []; // {x,z,t}
const _bombs  = [];
const _freezes = [];
const _chickens = [];

let _heartDirty = false;
let _starDirty  = false;
let _bombDirty = false;
let _freezeDirty = false;
let _chickenDirty = false;

/** Build an extruded heart geometry (3D, faces normal direction up). */
function _makeHeartGeometry() {
  const shape = new THREE.Shape();
  // Classic two-lobe heart curve
  shape.moveTo(0, 0.5);
  shape.bezierCurveTo(0, 0.85, -0.55, 0.95, -0.55, 0.40);
  shape.bezierCurveTo(-0.55, -0.05, -0.05, -0.30, 0, -0.65);
  shape.bezierCurveTo(0.05, -0.30, 0.55, -0.05, 0.55, 0.40);
  shape.bezierCurveTo(0.55, 0.95, 0, 0.85, 0, 0.5);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.25, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.06, bevelSegments: 3, curveSegments: 16,
  });
  geo.center();
  geo.rotateX(Math.PI);    // flip so the cleft is up at the screen-top
  return geo;
}

/** Build a 5-pointed star geometry (extruded). */
function _makeStarGeometry() {
  const shape = new THREE.Shape();
  const outer = 0.7, inner = 0.30;
  for (let i = 0; i < 10; i++) {
    const r = (i % 2 === 0) ? outer : inner;
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.22, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.05, bevelSegments: 3, curveSegments: 8,
  });
  geo.center();
  return geo;
}

const _flatX = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const _zeroScale = new THREE.Vector3(0, 0, 0);

function _makeInstanced(geo, color, emissiveColor, cap) {
  const mat = new THREE.MeshStandardMaterial({
    color: color,
    emissive: emissiveColor,
    // Bumped from 0.25 — pickups were reading as "matte primitive"; this gets
    // them just into the readable-glow band without blowing out under bloom.
    emissiveIntensity: 0.55,
    roughness: 0.4,
    metalness: 0.15,
  });
  const inst = new THREE.InstancedMesh(geo, mat, cap);
  inst.count = cap;
  inst.frustumCulled = false;
  inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < cap; i++) {
    _m4.compose(_v3.set(0, -1000, 0), _q.identity(), _zeroScale);
    inst.setMatrixAt(i, _m4);
  }
  inst.instanceMatrix.needsUpdate = true;
  return inst;
}

/**
 * Build an InstancedMesh of flat sprite billboards. Each instance is a
 * unit-size plane painted with the given procedural decal. Sits flat above
 * the pickup (the geometry/icon underneath) so the player reads the food
 * silhouette at any zoom. Additive blend — bumps under bloom for clarity.
 */
function _makeHaloInstanced(texName, cap, color = 0xffffff, opacity = 0.95) {
  const geo = new THREE.PlaneGeometry(1, 1);
  const mat = new THREE.MeshBasicMaterial({
    map: tex(texName),
    color, transparent: true, opacity,
    depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const inst = new THREE.InstancedMesh(geo, mat, cap);
  inst.count = cap;
  inst.frustumCulled = false;
  inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < cap; i++) {
    _m4.compose(_v3.set(0, -1000, 0), _flatX, _zeroScale);
    inst.setMatrixAt(i, _m4);
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.layers.enable(BLOOM_LAYER);
  return inst;
}

export function initPickups(scene) {
  if (_heartInst) return;
  _heartInst = _makeInstanced(_makeHeartGeometry(), 0xff3355, 0x991133, CAP_HEARTS);
  _starInst  = _makeInstanced(_makeStarGeometry(),  0xffd24a, 0x7a4400, CAP_STARS);
  // Bomb (dark sphere) — AoE damage all on-screen enemies
  _bombInst    = _makeInstanced(new THREE.SphereGeometry(0.45, 16, 12),     0x2b2b2b, 0xff5022, CAP_BOMBS);
  // Freeze (cyan octahedron) — 3s slow on all enemies on screen
  _freezeInst  = _makeInstanced(new THREE.OctahedronGeometry(0.50, 0),      0x88ddff, 0x4488cc, CAP_FREEZE);
  // Chicken (warm egg cylinder) — full heal
  _chickenInst = _makeInstanced(new THREE.SphereGeometry(0.40, 12, 10),     0xffe3a0, 0x8a5511, CAP_CHICKENS);
  scene.add(_heartInst);
  scene.add(_starInst);
  scene.add(_bombInst);
  scene.add(_freezeInst);
  scene.add(_chickenInst);
  // Sprite halo layer — one InstancedMesh per pickup family.
  _heartHaloInst   = _makeHaloInstanced('heartSprite',  CAP_HEARTS,  0xffffff, 0.85);
  _starHaloInst    = _makeHaloInstanced('starSprite',   CAP_STARS,   0xffffff, 0.90);
  _bombHaloInst    = _makeHaloInstanced('bombSprite',   CAP_BOMBS,   0xffffff, 0.95);
  _freezeHaloInst  = _makeHaloInstanced('snowflake',    CAP_FREEZE,  0xffffff, 0.90);
  _chickenHaloInst = _makeHaloInstanced('drumstick',    CAP_CHICKENS,0xffffff, 0.95);
  scene.add(_heartHaloInst);
  scene.add(_starHaloInst);
  scene.add(_bombHaloInst);
  scene.add(_freezeHaloInst);
  scene.add(_chickenHaloInst);
}

export function spawnHeart(x, z) {
  if (_hearts.length >= CAP_HEARTS) _hearts.shift();
  _hearts.push({ x, z, t: 0, vx: 0, vz: 0 });
}

export function spawnStar(x, z) {
  if (_stars.length >= CAP_STARS) _stars.shift();
  _stars.push({ x, z, t: 0, vx: 0, vz: 0 });
}

export function spawnBomb(x, z) {
  if (state.run?.stage?.id === 'forest') return; // forestPickups owns this stage
  if (_bombs.length >= CAP_BOMBS) _bombs.shift();
  _bombs.push({ x, z, t: 0, vx: 0, vz: 0 });
}
export function spawnFreeze(x, z) {
  if (state.run?.stage?.id === 'forest') return; // forestPickups owns this stage
  if (_freezes.length >= CAP_FREEZE) _freezes.shift();
  _freezes.push({ x, z, t: 0, vx: 0, vz: 0 });
}
export function spawnChicken(x, z) {
  if (state.run?.stage?.id === 'forest') return; // forestPickups owns this stage
  if (_chickens.length >= CAP_CHICKENS) _chickens.shift();
  _chickens.push({ x, z, t: 0, vx: 0, vz: 0 });
}

function _magnetTowardHero(p, dt) {
  const heroR = HERO.pickupRadius * (state.hero.statMul.magnet || 1) * ATTRACT_MUL;
  const dx = state.hero.pos.x - p.x;
  const dz = state.hero.pos.z - p.z;
  const d2 = dx * dx + dz * dz;
  if (d2 > heroR * heroR) return;
  const d = Math.sqrt(d2) || 1e-6;
  const nx = dx / d, nz = dz / d;
  p.vx = (p.vx || 0) + nx * ATTRACT_ACCEL * dt;
  p.vz = (p.vz || 0) + nz * ATTRACT_ACCEL * dt;
  const sp2 = p.vx * p.vx + p.vz * p.vz;
  if (sp2 > ATTRACT_MAX * ATTRACT_MAX) {
    const s = ATTRACT_MAX / Math.sqrt(sp2);
    p.vx *= s;
    p.vz *= s;
  }
  p.x += p.vx * dt;
  p.z += p.vz * dt;
}

const _spinEuler = new THREE.Euler();
const _pickupScl = new THREE.Vector3();   // iter 33k — pool for compose
function _writeMatrix(inst, i, p, scale) {
  _v3.set(p.x, Y_BASE + Math.sin(p.t * 3) * 0.18, p.z);
  _spinEuler.set(0, p.t * 1.4, 0);   // gentle Y-axis spin
  _q.setFromEuler(_spinEuler);
  _m4.compose(_v3, _q, _pickupScl.set(scale, scale, scale));
  inst.setMatrixAt(i, _m4);
}

// Write the halo billboard matrix. Plane lies flat above the pickup so the
// painted decal reads top-down. Pulses with a soft pop so the halo "breathes".
const _haloScl = new THREE.Vector3();
function _writeHalo(inst, i, p, scale) {
  if (!inst) return;
  const pulse = 1 + Math.sin(p.t * 4.5) * 0.07;
  _v3.set(p.x, Y_BASE + Math.sin(p.t * 3) * 0.18 + 0.45, p.z);
  _haloScl.set(scale * pulse, scale * pulse, scale * pulse);
  _m4.compose(_v3, _flatX, _haloScl);
  inst.setMatrixAt(i, _m4);
}

function _hide(inst, i) {
  _m4.compose(_v3.set(0, -1000, 0), _q.identity(), _zeroScale);
  inst.setMatrixAt(i, _m4);
}

export function tickPickups(dt) {
  if (!_heartInst) return;
  const hx = state.hero.pos.x, hz = state.hero.pos.z;

  // Hearts
  for (let i = _hearts.length - 1; i >= 0; i--) {
    const p = _hearts[i];
    p.t += dt;
    _magnetTowardHero(p, dt);
    const dx = p.x - hx, dz = p.z - hz;
    const d2 = dx * dx + dz * dz;
    if (d2 <= PICK_R2) {
      _hide(_heartInst, i);
      _hide(_heartHaloInst, i);
      _hearts.splice(i, 1);
      _heartDirty = true;
      // Heal
      const before = state.hero.hp;
      state.hero.hp = Math.min(state.hero.hpMax, state.hero.hp + 25 * (state.run.heartPotency || 1));
      const healed = state.hero.hp - before;
      if (healed > 0) {
        spawnMagnetSpark(state.hero.pos.x, 1.5, state.hero.pos.z);
        try { import('./damageNumbers.js').then(m => m.spawnHealNumber && m.spawnHealNumber(healed)); } catch (_) {}
      }
      try { sfx.heartPickup(); } catch (_) {}
      continue;
    }
    _writeMatrix(_heartInst, i, p, 1.0);
    _writeHalo(_heartHaloInst, i, p, 1.6);
    _heartDirty = true;
  }

  // Stars — same shape, different pickup effect
  for (let i = _stars.length - 1; i >= 0; i--) {
    const p = _stars[i];
    p.t += dt;
    _magnetTowardHero(p, dt);
    const dx = p.x - hx, dz = p.z - hz;
    const d2 = dx * dx + dz * dz;
    if (d2 <= PICK_R2) {
      _hide(_starInst, i);
      _hide(_starHaloInst, i);
      _stars.splice(i, 1);
      _starDirty = true;
      // Magnetize all on-screen gems
      const list = state.gems.list;
      for (let g = 0; g < list.length; g++) {
        if (list[g].active) list[g].magnetized = true;
      }
      state.fx.bloomBoost = Math.max(state.fx.bloomBoost, 0.6);
      state.fx.chromaticPulse = 0.6;
      try { sfx.starPickup(); } catch (_) {}
      continue;
    }
    _writeMatrix(_starInst, i, p, 1.2);
    _writeHalo(_starHaloInst, i, p, 1.8);
    _starDirty = true;
  }

  // ── Bombs (AoE on pickup) ──
  for (let i = _bombs.length - 1; i >= 0; i--) {
    const p = _bombs[i];
    p.t += dt;
    _magnetTowardHero(p, dt);
    const dx = p.x - hx, dz = p.z - hz;
    if (dx * dx + dz * dz <= PICK_R2) {
      _hide(_bombInst, i);
      _hide(_bombHaloInst, i);
      _bombs.splice(i, 1);
      _bombDirty = true;
      _bombEffect(p.x, p.z);
      continue;
    }
    _writeMatrix(_bombInst, i, p, 1.3);
    _writeHalo(_bombHaloInst, i, p, 1.8);
    _bombDirty = true;
  }

  // ── Freezes (3s global slow on pickup) ──
  for (let i = _freezes.length - 1; i >= 0; i--) {
    const p = _freezes[i];
    p.t += dt;
    _magnetTowardHero(p, dt);
    const dx = p.x - hx, dz = p.z - hz;
    if (dx * dx + dz * dz <= PICK_R2) {
      _hide(_freezeInst, i);
      _hide(_freezeHaloInst, i);
      _freezes.splice(i, 1);
      _freezeDirty = true;
      _freezeEffect();
      continue;
    }
    _writeMatrix(_freezeInst, i, p, 1.2);
    _writeHalo(_freezeHaloInst, i, p, 1.8);
    _freezeDirty = true;
  }

  // ── Chickens (full heal on pickup) ──
  for (let i = _chickens.length - 1; i >= 0; i--) {
    const p = _chickens[i];
    p.t += dt;
    _magnetTowardHero(p, dt);
    const dx = p.x - hx, dz = p.z - hz;
    if (dx * dx + dz * dz <= PICK_R2) {
      _hide(_chickenInst, i);
      _hide(_chickenHaloInst, i);
      _chickens.splice(i, 1);
      _chickenDirty = true;
      state.hero.hp = state.hero.hpMax;
      spawnMagnetSpark(state.hero.pos.x, 1.8, state.hero.pos.z, 0xffd24a);
      continue;
    }
    _writeMatrix(_chickenInst, i, p, 1.2);
    _writeHalo(_chickenHaloInst, i, p, 1.8);
    _chickenDirty = true;
  }

  // Hide indices beyond current list length (cleanup tails) — both the
  // primitive geometry instance AND the sprite halo instance.
  for (let i = _hearts.length; i < CAP_HEARTS; i++) { _hide(_heartInst, i); _hide(_heartHaloInst, i); }
  for (let i = _stars.length;  i < CAP_STARS;  i++) { _hide(_starInst,  i); _hide(_starHaloInst, i); }
  for (let i = _bombs.length;  i < CAP_BOMBS;  i++) { _hide(_bombInst,  i); _hide(_bombHaloInst, i); }
  for (let i = _freezes.length;i < CAP_FREEZE; i++) { _hide(_freezeInst,i); _hide(_freezeHaloInst, i); }
  for (let i = _chickens.length;i < CAP_CHICKENS;i++) { _hide(_chickenInst,i); _hide(_chickenHaloInst, i); }

  if (_heartDirty) {
    _heartInst.instanceMatrix.needsUpdate = true;
    if (_heartHaloInst) _heartHaloInst.instanceMatrix.needsUpdate = true;
    _heartDirty = false;
  }
  if (_starDirty)  {
    _starInst.instanceMatrix.needsUpdate  = true;
    if (_starHaloInst) _starHaloInst.instanceMatrix.needsUpdate = true;
    _starDirty  = false;
  }
  if (_bombDirty)  {
    _bombInst.instanceMatrix.needsUpdate  = true;
    if (_bombHaloInst) _bombHaloInst.instanceMatrix.needsUpdate = true;
    _bombDirty  = false;
  }
  if (_freezeDirty){
    _freezeInst.instanceMatrix.needsUpdate = true;
    if (_freezeHaloInst) _freezeHaloInst.instanceMatrix.needsUpdate = true;
    _freezeDirty = false;
  }
  if (_chickenDirty){
    _chickenInst.instanceMatrix.needsUpdate = true;
    if (_chickenHaloInst) _chickenHaloInst.instanceMatrix.needsUpdate = true;
    _chickenDirty = false;
  }
}

// Bomb: AoE 50 damage to all enemies within 18 units of pickup point.
function _bombEffect(x, z) {
  try { sfx.weaponBomb(); } catch (_) {}
  // Dynamic import to dodge any circular setup at load.
  import('./enemies.js').then(({ queryRadius, damageEnemy }) => {
    const cands = queryRadius({ x, z }, 18);
    for (const e of cands) damageEnemy(e, 50, 'bomb');
    import('./destructibles.js').then(({ smashLogsInRadius }) => smashLogsInRadius(x, z, 18));
    state.fx.bloomBoost = Math.max(state.fx.bloomBoost, 1.0);
    state.fx.shake = Math.max(state.fx.shake, 0.5);
    // Layered art-pipeline burst: flash + shockwave + smoke + ballistic embers.
    import('./vfxBurst.js').then(({ burstExplosion }) => burstExplosion(x, z, 18, 0xffae4a));
  });
}

// Freeze: spawn a giant temporary web under everyone so the existing slow logic
// just works. 5s duration, full-screen radius, harsh slow.
function _freezeEffect() {
  const h = state.hero.pos;
  state.webs.list.push({
    x: h.x, z: h.z,
    radius: 60,
    ttl: 3.0,
    life: 3.0,
    slowMul: 0.15,    // 85% slow
  });
  state.fx.chromaticPulse = 0.6;
  state.fx.bloomBoost = Math.max(state.fx.bloomBoost, 0.7);
}

export function resetPickups() {
  _hearts.length = 0; _stars.length = 0;
  _bombs.length = 0; _freezes.length = 0; _chickens.length = 0;
  const all = [
    [_heartInst, CAP_HEARTS], [_starInst, CAP_STARS],
    [_bombInst, CAP_BOMBS], [_freezeInst, CAP_FREEZE],
    [_chickenInst, CAP_CHICKENS],
    [_heartHaloInst, CAP_HEARTS], [_starHaloInst, CAP_STARS],
    [_bombHaloInst, CAP_BOMBS], [_freezeHaloInst, CAP_FREEZE],
    [_chickenHaloInst, CAP_CHICKENS],
  ];
  for (const [inst, cap] of all) {
    if (!inst) continue;
    for (let i = 0; i < cap; i++) _hide(inst, i);
    inst.instanceMatrix.needsUpdate = true;
  }
}
