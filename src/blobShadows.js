/**
 * Fake "blob shadow" decals under hero + every active enemy.
 * One InstancedMesh of a soft-blur dark circle texture lying at y=0.01.
 * Gives ~90% of the depth cue of real shadows for ~0.3ms total cost.
 */
import * as THREE from 'three';
import { state } from './state.js';

const CAP = 320;
const Y_DECAL = 0.02;

const _m4 = new THREE.Matrix4();
const _v3 = new THREE.Vector3();
const _flatX = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const _zeroScale = new THREE.Vector3(0, 0, 0);
const _tmpScale  = new THREE.Vector3();    // iter 33k — pool for Matrix4.compose

let _inst = null;
let _dirty = false;

function _makeShadowTexture() {
  // Soft radial gradient — black center fading to transparent.
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0.00, 'rgba(0,0,0,0.55)');
  g.addColorStop(0.40, 'rgba(0,0,0,0.35)');
  g.addColorStop(0.75, 'rgba(0,0,0,0.10)');
  g.addColorStop(1.00, 'rgba(0,0,0,0.00)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

export function initBlobShadows(scene) {
  if (_inst) return;
  const geo = new THREE.PlaneGeometry(1, 1);
  const mat = new THREE.MeshBasicMaterial({
    map: _makeShadowTexture(),
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    color: 0xffffff,
  });
  _inst = new THREE.InstancedMesh(geo, mat, CAP);
  // iter 33n — drive count from per-frame fill (was always CAP, GPU drew all
  // 320 instances each frame even with 10 enemies on screen).
  _inst.count = 0;
  _inst.frustumCulled = false;
  _inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Render shadows BEFORE the colored meshes so transparency sorts cleanly.
  _inst.renderOrder = -1;
  scene.add(_inst);
}

export function updateBlobShadows() {
  if (!_inst) return;
  let i = 0;

  // Hero gets a SMALL tight contact blob on top of its real PCF shadow —
  // anchors the model to the ground; the soft PCF alone reads as a green
  // smear because of hemi bounce. This contact disc is pitch-black at the
  // center so the eye locks on the hero's feet.
  const hp = state.hero && state.hero.pos;
  if (hp && state.mode === 'run') {
    _v3.set(hp.x, Y_DECAL, hp.z);
    _m4.compose(_v3, _flatX, _tmpScale.set(0.85, 0.85, 0.85));
    _inst.setMatrixAt(i++, _m4);
  }

  // Other entities: enemies with castShadow already cast a real one — skip.
  const arr = state.enemies.active;
  for (let k = 0; k < arr.length && i < CAP; k++) {
    const e = arr[k];
    if (!e.alive) continue;
    if (e.mesh && e.mesh.userData && e.mesh.userData._castSet) continue;
    const ms = e.mesh ? e.mesh.scale.x : 1;
    // size ≈ horizontal footprint of the model
    const r = Math.max(0.6, ms * 0.9);
    _v3.set(e.mesh.position.x, Y_DECAL, e.mesh.position.z);
    _m4.compose(_v3, _flatX, _tmpScale.set(r, r, r));
    _inst.setMatrixAt(i++, _m4);
  }
  // iter 33n — set count to live fill instead of hiding unused slots; GPU
  // skips vertex shader runs for indices >= count.
  _inst.count = i;
  _inst.instanceMatrix.needsUpdate = true;
}
