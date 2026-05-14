/**
 * Layered sprite VFX: flashes, shockwaves, smoke puffs, embers with gravity.
 * Each layer is a single InstancedMesh sharing a hand-painted atlas texture.
 * Spawn with burstExplosion(x, z, scale, colorHex) for a complete bomb-style FX.
 */
import * as THREE from 'three';
import { state } from './state.js';
import { tex } from './particleTextures.js';
import { BLOOM_LAYER } from './postfx.js';

const SMOKE_CAP = 96;
const EMBER_CAP = 128;
const FLASH_CAP = 16;
const SHOCK_CAP = 16;
const DASH_CAP  = 48;

const _m4 = new THREE.Matrix4();
const _v3 = new THREE.Vector3();
const _flatX = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const _zeroScale = new THREE.Vector3(0, 0, 0);
const _color = new THREE.Color();

let _smokeInst = null, _emberInst = null, _flashInst = null, _shockInst = null, _dashInst = null;

const _smokes = []; // {x,y,z,vx,vy,vz, t, life, baseScale, color}
const _embers = []; // {x,y,z,vx,vy,vz, t, life, color}
const _flashes = []; // {x,z, t, life, baseScale, color}
const _shocks = []; // {x,z, t, life, baseScale, color}
const _dashStreaks = []; // {x,z, ang, length, t, life, color}

let _smokeDirty=false, _emberDirty=false, _flashDirty=false, _shockDirty=false, _dashDirty=false;

function _mkInst(geo, mat, cap, flat = true) {
  const inst = new THREE.InstancedMesh(geo, mat, cap);
  inst.count = cap;
  inst.frustumCulled = false;
  inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < cap; i++) {
    _m4.compose(_v3.set(0, -1000, 0), flat ? _flatX : new THREE.Quaternion(), _zeroScale);
    inst.setMatrixAt(i, _m4);
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  inst.instanceColor.setUsage(THREE.DynamicDrawUsage);
  const c = new THREE.Color(0xffffff);
  for (let i = 0; i < cap; i++) inst.setColorAt(i, c);
  inst.instanceColor.needsUpdate = true;
  inst.layers.enable(BLOOM_LAYER);
  return inst;
}

export function initVFXBurst(scene) {
  if (_smokeInst) return;
  const planeGeo = new THREE.PlaneGeometry(1, 1);

  const smokeMat = new THREE.MeshBasicMaterial({
    map: tex('smokeWarm'),
    transparent: true, opacity: 0.85,
    depthWrite: false, blending: THREE.NormalBlending,
  });
  _smokeInst = _mkInst(planeGeo, smokeMat, SMOKE_CAP);
  scene.add(_smokeInst);

  const emberMat = new THREE.MeshBasicMaterial({
    map: tex('emberWarm'),
    transparent: true, opacity: 1.0,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  _emberInst = _mkInst(planeGeo, emberMat, EMBER_CAP);
  scene.add(_emberInst);

  const flashMat = new THREE.MeshBasicMaterial({
    map: tex('flashStar'),
    transparent: true, opacity: 1.0,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  _flashInst = _mkInst(planeGeo, flashMat, FLASH_CAP);
  scene.add(_flashInst);

  const shockMat = new THREE.MeshBasicMaterial({
    map: tex('shockwave'),
    transparent: true, opacity: 1.0,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  _shockInst = _mkInst(planeGeo, shockMat, SHOCK_CAP);
  scene.add(_shockInst);

  // Dash streak — long thin additive plane stretched along motion direction.
  const dashMat = new THREE.MeshBasicMaterial({
    map: tex('glowCyan'),
    transparent: true, opacity: 0.9,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  _dashInst = _mkInst(planeGeo, dashMat, DASH_CAP);
  scene.add(_dashInst);
}

/** Spawn a single dash streak at (x,z) oriented along the dash direction. */
export function spawnDashStreak(x, z, dirX, dirZ, color = 0x7fffe4) {
  if (_dashStreaks.length >= DASH_CAP) _dashStreaks.shift();
  const ang = Math.atan2(dirX, dirZ); // around Y axis
  _dashStreaks.push({ x, z, ang, length: 2.4, t: 0, life: 0.32, color });
}

function _push(arr, cap, obj) { if (arr.length >= cap) arr.shift(); arr.push(obj); }

// Iter 10a — reduced-flashing throttle: cap to 4 flashes/sec (250ms gap) and
// dampen alpha to 0.4 when state._optReducedFlashing is on. Tracked per
// module so we don't add a global timer.
let _lastFlashAt = 0;
function _spawnFlash(x, z, scale, color) {
  // Reduce-motion strips flashes outright (the screen-warp + camera punch is
  // what reads as "motion" — the 250ms star pop also counts).
  if (state._optReduceMotion) return;
  if (state._optReducedFlashing) {
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (now - _lastFlashAt < 250) return;
    _lastFlashAt = now;
    // Dampen by tinting the spawn color toward 40% alpha-equivalent. Flash
    // material is additive so multiplying the spawn color is the path.
    const c = (color >>> 0);
    const r = ((c >> 16) & 0xff) * 0.4;
    const g = ((c >>  8) & 0xff) * 0.4;
    const b = ( c        & 0xff) * 0.4;
    color = ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
  }
  _push(_flashes, FLASH_CAP, { x, z, t: 0, life: 0.25, baseScale: 4.5 * scale, color });
}
function _spawnShock(x, z, scale, color) {
  if (state._optReduceMotion) return;
  _push(_shocks, SHOCK_CAP, { x, z, t: 0, life: 0.55, baseScale: 1.0 * scale, color });
}
function _spawnSmoke(x, y, z, vx, vy, vz, scale, color) {
  _push(_smokes, SMOKE_CAP, { x, y, z, vx, vy, vz, t: 0, life: 1.4 + Math.random() * 0.5, baseScale: 2.0 * scale, color });
}
function _spawnEmber(x, y, z, vx, vy, vz, color) {
  _push(_embers, EMBER_CAP, { x, y, z, vx, vy, vz, t: 0, life: 0.7 + Math.random() * 0.3, color });
}

/**
 * One-call layered burst. `radius` ≈ how far embers travel.
 * Colors: warmTint applied to flash/shock; smoke/ember stay on their atlases.
 * Iter 10a — when state._optReduceMotion is set, the flash + shock layers
 * are skipped via _spawnFlash/_spawnShock early-returns; smoke/embers still
 * fire so the explosion has visual presence without the screen-punching pulse.
 */
export function burstExplosion(x, z, radius = 6, warmTint = 0xffd078) {
  const scale = radius / 6;
  _spawnFlash(x, z, scale, warmTint);
  _spawnShock(x, z, radius, warmTint);

  const smokeCount = Math.min(10, 6 + Math.floor(scale * 4));
  for (let i = 0; i < smokeCount; i++) {
    const a = (i / smokeCount) * Math.PI * 2 + Math.random() * 0.5;
    const sp = 1.5 + Math.random() * 1.8;
    _spawnSmoke(x, 0.4, z,
      Math.cos(a) * sp, 1.2 + Math.random() * 0.8, Math.sin(a) * sp,
      scale, 0xb0a090);
  }
  const emberCount = Math.min(20, 12 + Math.floor(scale * 8));
  for (let i = 0; i < emberCount; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 4 + Math.random() * 4 * scale;
    _spawnEmber(x, 0.6, z,
      Math.cos(a) * sp, 3 + Math.random() * 3, Math.sin(a) * sp,
      Math.random() < 0.5 ? 0xffb14a : 0xff6020);
  }
}

const _GRAV = -9.5;
const _AIR  = 0.92;

export function updateVFXBurst(dt) {
  // Flashes — scale-in then fade out, flat on ground plane.
  for (let i = 0; i < _flashes.length; i++) {
    const f = _flashes[i];
    f.t += dt;
    const k = f.t / f.life;
    if (k >= 1) {
      _m4.compose(_v3.set(0, -1000, 0), _flatX, _zeroScale);
      _flashInst.setMatrixAt(i, _m4);
    } else {
      const s = f.baseScale * (k < 0.25 ? (k / 0.25) : 1) * (1 - k * 0.5);
      _v3.set(f.x, 0.5, f.z);
      _m4.compose(_v3, _flatX, new THREE.Vector3(s, s, s));
      _flashInst.setMatrixAt(i, _m4);
      const a = 1 - k;
      _flashInst.setColorAt(i, _color.setHex(f.color).multiplyScalar(a));
    }
    _flashDirty = true;
  }
  while (_flashes.length && _flashes[0].t >= _flashes[0].life) _flashes.shift();

  // Shockwaves — expand and fade flat on the ground.
  for (let i = 0; i < _shocks.length; i++) {
    const r = _shocks[i];
    r.t += dt;
    const k = r.t / r.life;
    if (k >= 1) {
      _m4.compose(_v3.set(0, -1000, 0), _flatX, _zeroScale);
      _shockInst.setMatrixAt(i, _m4);
    } else {
      const s = r.baseScale * (0.4 + k * 4.2);
      _v3.set(r.x, 0.06, r.z);
      _m4.compose(_v3, _flatX, new THREE.Vector3(s, s, s));
      _shockInst.setMatrixAt(i, _m4);
      const a = (1 - k) * (1 - k);
      _shockInst.setColorAt(i, _color.setHex(r.color).multiplyScalar(a));
    }
    _shockDirty = true;
  }
  while (_shocks.length && _shocks[0].t >= _shocks[0].life) _shocks.shift();

  // Smoke — rise, expand, fade. Use flat orientation; reads as ground puff.
  for (let i = 0; i < _smokes.length; i++) {
    const sm = _smokes[i];
    sm.t += dt;
    const k = sm.t / sm.life;
    if (k >= 1) {
      _m4.compose(_v3.set(0, -1000, 0), _flatX, _zeroScale);
      _smokeInst.setMatrixAt(i, _m4);
    } else {
      // Drift outward, slow as it lives
      sm.x += sm.vx * dt;
      sm.y += sm.vy * dt;
      sm.z += sm.vz * dt;
      sm.vx *= Math.pow(0.4, dt);
      sm.vz *= Math.pow(0.4, dt);
      sm.vy = Math.max(0.2, sm.vy * Math.pow(0.6, dt));
      const s = sm.baseScale * (0.6 + k * 2.2);
      _v3.set(sm.x, sm.y, sm.z);
      _m4.compose(_v3, _flatX, new THREE.Vector3(s, s, s));
      _smokeInst.setMatrixAt(i, _m4);
      // Darken to gray as it ages
      const shade = 1 - k * 0.6;
      _smokeInst.setColorAt(i, _color.setHex(sm.color).multiplyScalar(shade));
    }
    _smokeDirty = true;
  }
  while (_smokes.length && _smokes[0].t >= _smokes[0].life) _smokes.shift();

  // Embers — ballistic with gravity + air drag, additive sparks.
  for (let i = 0; i < _embers.length; i++) {
    const e = _embers[i];
    e.t += dt;
    const k = e.t / e.life;
    if (k >= 1 || e.y < 0) {
      _m4.compose(_v3.set(0, -1000, 0), _flatX, _zeroScale);
      _emberInst.setMatrixAt(i, _m4);
    } else {
      e.vy += _GRAV * dt;
      const drag = Math.pow(_AIR, dt * 60);
      e.vx *= drag; e.vz *= drag;
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      e.z += e.vz * dt;
      const s = 0.6 * (1 - k * 0.3);
      _v3.set(e.x, e.y, e.z);
      _m4.compose(_v3, _flatX, new THREE.Vector3(s, s, s));
      _emberInst.setMatrixAt(i, _m4);
      const a = 1 - k;
      _emberInst.setColorAt(i, _color.setHex(e.color).multiplyScalar(a));
    }
    _emberDirty = true;
  }
  while (_embers.length && (_embers[0].t >= _embers[0].life || _embers[0].y < 0)) _embers.shift();

  // Dash streaks — flat additive plane stretched along motion. Fades 0.32s.
  const _dashQ = new THREE.Quaternion();
  const _dashE = new THREE.Euler();
  for (let i = 0; i < _dashStreaks.length; i++) {
    const ds = _dashStreaks[i];
    ds.t += dt;
    const k = ds.t / ds.life;
    if (k >= 1) {
      _m4.compose(_v3.set(0, -1000, 0), _flatX, _zeroScale);
      _dashInst.setMatrixAt(i, _m4);
    } else {
      // Stretched along world Z-axis then rotated to dirAng (around Y).
      // Plane(1,1) → scale (width, _, length); rotation Y aligns the long axis.
      _dashE.set(-Math.PI / 2, ds.ang, 0, 'YXZ');
      _dashQ.setFromEuler(_dashE);
      const widthScale = 0.55 * (1 - k * 0.4);
      const lenScale   = ds.length * (1 - k * 0.2);
      _v3.set(ds.x, 0.45, ds.z);
      _m4.compose(_v3, _dashQ, new THREE.Vector3(widthScale, lenScale, 1));
      _dashInst.setMatrixAt(i, _m4);
      const a = 1 - k;
      _dashInst.setColorAt(i, _color.setHex(ds.color).multiplyScalar(a));
    }
    _dashDirty = true;
  }
  while (_dashStreaks.length && _dashStreaks[0].t >= _dashStreaks[0].life) _dashStreaks.shift();

  if (_flashDirty) { _flashInst.instanceMatrix.needsUpdate = true; _flashInst.instanceColor.needsUpdate = true; _flashDirty = false; }
  if (_shockDirty) { _shockInst.instanceMatrix.needsUpdate = true; _shockInst.instanceColor.needsUpdate = true; _shockDirty = false; }
  if (_smokeDirty) { _smokeInst.instanceMatrix.needsUpdate = true; _smokeInst.instanceColor.needsUpdate = true; _smokeDirty = false; }
  if (_emberDirty) { _emberInst.instanceMatrix.needsUpdate = true; _emberInst.instanceColor.needsUpdate = true; _emberDirty = false; }
  if (_dashDirty)  { _dashInst.instanceMatrix.needsUpdate = true; _dashInst.instanceColor.needsUpdate = true; _dashDirty = false; }
}

export function resetVFXBurst() {
  _smokes.length = 0; _embers.length = 0; _flashes.length = 0; _shocks.length = 0; _dashStreaks.length = 0;
  for (const inst of [_smokeInst, _emberInst, _flashInst, _shockInst, _dashInst]) {
    if (!inst) continue;
    for (let i = 0; i < inst.count; i++) {
      _m4.compose(_v3.set(0, -1000, 0), _flatX, _zeroScale);
      inst.setMatrixAt(i, _m4);
    }
    inst.instanceMatrix.needsUpdate = true;
  }
}
