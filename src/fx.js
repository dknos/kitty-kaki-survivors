/**
 * Lightweight FX: kill rings (expanding/fading torus on enemy death) and
 * magnet sparks (small upward darts when a gem locks on).
 *
 * Single InstancedMesh per FX type so this stays 2 draw calls regardless of count.
 */
import * as THREE from 'three';
import { state } from './state.js';
import { tex } from './particleTextures.js';
import { BLOOM_LAYER } from './postfx.js';
import { makeRuneRingTexture } from './enemyTells.js';

const RING_CAP = 64;
const SPARK_CAP = 64;
// V2: kill-ring center twinkle pool — same cap as the rings, since each
// kill ring also spawns a center pop. Smaller scale, shorter life so it
// pops and vanishes while the ring is still expanding.
const TWINKLE_CAP = 64;

const _m4 = new THREE.Matrix4();
const _v3 = new THREE.Vector3();
const _q  = new THREE.Quaternion();
const _flatX = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const _zeroScale = new THREE.Vector3(0, 0, 0);

let _ringInst = null;
let _sparkInst = null;
let _ringTwinkleInst = null;
let _pickupRing = null;
const _sparkColor = new THREE.Color();
const _twinkleColor = new THREE.Color();

const _rings = []; // {x,z,t,life,baseScale, eliteColor}
const _ringTwinkles = []; // {x,z,t,life, baseScale, color}
const _sparks = []; // {x,y,z,t,life}

let _ringDirty = false;
let _sparkDirty = false;
let _twinkleDirty = false;

export function initFX(scene) {
  // Kill ring — textured plane, lying flat on the ground plane (rotated)
  const ringGeo = new THREE.PlaneGeometry(2.0, 2.0);
  const ringTex = tex('ringGold');
  const ringMat = new THREE.MeshBasicMaterial({
    map: ringTex,
    color: 0xffffff,
    transparent: true,
    opacity: 1.0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  _ringInst = new THREE.InstancedMesh(ringGeo, ringMat, RING_CAP);
  _ringInst.count = RING_CAP;
  _ringInst.frustumCulled = false;
  _ringInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < RING_CAP; i++) {
    _m4.compose(_v3.set(0, -1000, 0), _flatX, _zeroScale);
    _ringInst.setMatrixAt(i, _m4);
  }
  _ringInst.instanceMatrix.needsUpdate = true;
  _ringInst.layers.enable(BLOOM_LAYER);
  scene.add(_ringInst);

  // Magnet spark — textured billboard sparkle
  const sparkGeo = new THREE.PlaneGeometry(0.6, 0.6);
  const sparkMat = new THREE.MeshBasicMaterial({
    map: tex('sparkCyan'),
    color: 0xffffff,
    transparent: true,
    opacity: 1.0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  _sparkInst = new THREE.InstancedMesh(sparkGeo, sparkMat, SPARK_CAP);
  _sparkInst.count = SPARK_CAP;
  _sparkInst.frustumCulled = false;
  _sparkInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Sparks face camera (we'll set rotation to face -Y axis from above)
  // For ortho iso, sprites laid flat read fine — orient like the ring (XZ plane)
  for (let i = 0; i < SPARK_CAP; i++) {
    _m4.compose(_v3.set(0, -1000, 0), _flatX, _zeroScale);
    _sparkInst.setMatrixAt(i, _m4);
  }
  _sparkInst.instanceMatrix.needsUpdate = true;
  _sparkInst.layers.enable(BLOOM_LAYER);
  scene.add(_sparkInst);

  // Per-instance color attribute so spawnMagnetSpark can spawn gold variants too.
  _sparkInst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(SPARK_CAP * 3), 3);
  _sparkInst.instanceColor.setUsage(THREE.DynamicDrawUsage);
  const defaultSparkColor = new THREE.Color(0x44ffcc);
  for (let i = 0; i < SPARK_CAP; i++) _sparkInst.setColorAt(i, defaultSparkColor);
  _sparkInst.instanceColor.needsUpdate = true;

  // V2 — kill-ring center twinkle layer. Painted with twinkleGold tex,
  // additive, per-instance color so elite kills get gold pop and trash
  // kills get warm-bone white pop. Single draw call shared across all
  // kill events. Sits at y just above the ring so the layered pop reads.
  const twinkleGeo = new THREE.PlaneGeometry(1.0, 1.0);
  const twinkleMat = new THREE.MeshBasicMaterial({
    map: tex('twinkleGold'),
    color: 0xffffff,
    transparent: true,
    opacity: 1.0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  _ringTwinkleInst = new THREE.InstancedMesh(twinkleGeo, twinkleMat, TWINKLE_CAP);
  _ringTwinkleInst.count = TWINKLE_CAP;
  _ringTwinkleInst.frustumCulled = false;
  _ringTwinkleInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < TWINKLE_CAP; i++) {
    _m4.compose(_v3.set(0, -1000, 0), _flatX, _zeroScale);
    _ringTwinkleInst.setMatrixAt(i, _m4);
  }
  _ringTwinkleInst.instanceMatrix.needsUpdate = true;
  _ringTwinkleInst.layers.enable(BLOOM_LAYER);
  _ringTwinkleInst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(TWINKLE_CAP * 3), 3);
  _ringTwinkleInst.instanceColor.setUsage(THREE.DynamicDrawUsage);
  const defaultTwinkleColor = new THREE.Color(0xfff9e6);
  for (let i = 0; i < TWINKLE_CAP; i++) _ringTwinkleInst.setColorAt(i, defaultTwinkleColor);
  _ringTwinkleInst.instanceColor.needsUpdate = true;
  scene.add(_ringTwinkleInst);

  // Persistent pickup-radius ring under the hero — inscribed rune circle on
  // the ground. Was a flat cyan ring (read as a "green disc" against the
  // grass shadow). Now uses the canonical rune-ring texture in a warm cream
  // tint so it reads as the hero's standing magic circle, not a HUD overlay.
  const pickupRingTex = makeRuneRingTexture();
  const pickupGeo = new THREE.PlaneGeometry(1, 1);
  const pickupMat = new THREE.MeshBasicMaterial({
    map: pickupRingTex,
    color: 0xfff1cc,
    transparent: true, opacity: 0.22,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  _pickupRing = new THREE.Mesh(pickupGeo, pickupMat);
  _pickupRing.quaternion.copy(_flatX);
  _pickupRing.position.y = 0.04;
  _pickupRing.renderOrder = -1;
  scene.add(_pickupRing);
}

export function updatePickupRing() {
  if (!_pickupRing) return;
  const h = state.hero;
  if (!h || !h.pos) return;
  const r = (h.statMul.magnet || 1) * 4.0 * 2.4;   // pickupRadius * attract mul ~= ring footprint
  _pickupRing.position.x = h.pos.x;
  _pickupRing.position.z = h.pos.z;
  _pickupRing.scale.set(r, r, r);
}

/** Pop a kill ring at world (x,z). elite scales it up. */
export function spawnKillRing(x, z, elite = false) {
  if (_rings.length >= RING_CAP) _rings.shift();
  _rings.push({
    x, z, t: 0,
    life: elite ? 0.55 : 0.35,
    baseScale: elite ? 1.6 : 0.9,
  });
  // V2: paired center twinkle pop — shorter life, smaller scale. Gold for
  // elites, warm-bone for trash so the eye gets immediate threat-tier
  // feedback at the moment of kill (separate from XP gem feedback later).
  if (_ringTwinkles.length >= TWINKLE_CAP) _ringTwinkles.shift();
  _ringTwinkles.push({
    x, z, t: 0,
    life: elite ? 0.28 : 0.18,
    baseScale: elite ? 1.4 : 0.85,
    color: elite ? 0xffd24a : 0xfff9e6,
  });
}

/** Pop a magnet spark at world position. `color` is hex; default cyan. */
export function spawnMagnetSpark(x, y, z, color = 0x44ffcc) {
  if (_sparks.length >= SPARK_CAP) _sparks.shift();
  _sparks.push({ x, y, z, t: 0, life: 0.35, color });
}

export function updateFX(dt) {
  // Rings
  for (let i = 0; i < _rings.length; i++) {
    const r = _rings[i];
    r.t += dt;
    const k = r.t / r.life;
    if (k >= 1) {
      _m4.compose(_v3.set(0, -1000, 0), _flatX, _zeroScale);
      _ringInst.setMatrixAt(i, _m4);
      _ringDirty = true;
    } else {
      const s = r.baseScale * (0.3 + k * 3.2);
      _v3.set(r.x, 0.08, r.z);
      _m4.compose(_v3, _flatX, new THREE.Vector3(s, s, s));
      _ringInst.setMatrixAt(i, _m4);
      _ringDirty = true;
    }
  }
  // Drop dead rings from front (rare, since we shift on add)
  while (_rings.length > 0 && _rings[0].t >= _rings[0].life) _rings.shift();

  // V2: kill-ring center twinkle pop — life 0.18/0.28s, ease-out scale,
  // additive fade. Paired 1:1 with kill rings (independent index — gallery
  // arrays may not stay aligned after drops).
  if (_ringTwinkleInst) {
    for (let i = 0; i < _ringTwinkles.length; i++) {
      const tw = _ringTwinkles[i];
      tw.t += dt;
      const k = tw.t / tw.life;
      if (k >= 1) {
        _m4.compose(_v3.set(0, -1000, 0), _flatX, _zeroScale);
        _ringTwinkleInst.setMatrixAt(i, _m4);
      } else {
        // Ease-out scale: snap in fast, then slight grow as it fades.
        const easeIn = Math.min(1, k * 4);             // 0 → 1 in first 25%
        const s = tw.baseScale * (0.35 + 0.85 * easeIn) * (1 - 0.2 * k);
        _v3.set(tw.x, 0.10, tw.z);
        _m4.compose(_v3, _flatX, new THREE.Vector3(s, s, s));
        _ringTwinkleInst.setMatrixAt(i, _m4);
        // Color fade: hold full bright for first 40%, then linear fade.
        const a = k < 0.4 ? 1 : 1 - (k - 0.4) / 0.6;
        _twinkleColor.setHex(tw.color).multiplyScalar(a);
        _ringTwinkleInst.setColorAt(i, _twinkleColor);
      }
      _twinkleDirty = true;
    }
    while (_ringTwinkles.length > 0 && _ringTwinkles[0].t >= _ringTwinkles[0].life) _ringTwinkles.shift();
  }

  // Sparks
  for (let i = 0; i < _sparks.length; i++) {
    const sp = _sparks[i];
    sp.t += dt;
    const k = sp.t / sp.life;
    if (k >= 1) {
      _m4.compose(_v3.set(0, -1000, 0), _q.identity(), _zeroScale);
      _sparkInst.setMatrixAt(i, _m4);
      _sparkDirty = true;
    } else {
      const rise = k * 1.2;
      const s = (1 - k) * 1.5; // sprite scale multiplier — start bigger than 1 unit
      _v3.set(sp.x, sp.y + rise, sp.z);
      _m4.compose(_v3, _flatX, new THREE.Vector3(s, s, s));
      _sparkInst.setMatrixAt(i, _m4);
      _sparkInst.setColorAt(i, _sparkColor.setHex(sp.color || 0x44ffcc));
      _sparkDirty = true;
    }
  }
  while (_sparks.length > 0 && _sparks[0].t >= _sparks[0].life) _sparks.shift();

  if (_ringDirty)  { _ringInst.instanceMatrix.needsUpdate = true; _ringDirty = false; }
  if (_sparkDirty) {
    _sparkInst.instanceMatrix.needsUpdate = true;
    if (_sparkInst.instanceColor) _sparkInst.instanceColor.needsUpdate = true;
    _sparkDirty = false;
  }
  if (_twinkleDirty && _ringTwinkleInst) {
    _ringTwinkleInst.instanceMatrix.needsUpdate = true;
    if (_ringTwinkleInst.instanceColor) _ringTwinkleInst.instanceColor.needsUpdate = true;
    _twinkleDirty = false;
  }
}
