import * as THREE from 'three';

const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _zeroScale = new THREE.Vector3(0, 0, 0);
const _m4 = new THREE.Matrix4();

export function createInstancedMesh(geo, mat, cap, initialQuat = _q) {
  const inst = new THREE.InstancedMesh(geo, mat, cap);
  inst.count = cap;
  inst.frustumCulled = false;
  inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < cap; i++) {
    _m4.compose(_v3.set(0, -1000, 0), initialQuat, _zeroScale);
    inst.setMatrixAt(i, _m4);
  }
  inst.instanceMatrix.needsUpdate = true;
  return inst;
}
