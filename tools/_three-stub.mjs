// Bare-minimum THREE.js stub for Phase B smoke tests. Only exports the
// constructors actually referenced by config.js/state.js at module-init time.
class Vector2   { constructor(x = 0, y = 0)         { this.x = x; this.y = y; } set(){return this;} copy(){return this;} }
class Vector3   { constructor(x = 0, y = 0, z = 0)  { this.x = x; this.y = y; this.z = z; } set(){return this;} copy(){return this;} }
class Quaternion { constructor() {} setFromEuler(){return this;} copy(){return this;} }
class Euler     { constructor() {} }
class Matrix4   { constructor() {} }
class Color     { constructor() {} }
class Scene     { constructor() {} add(){} }
class Group     { constructor() {} add(){} }
class Object3D  { constructor() {} add(){} }

export {
  Vector2, Vector3, Quaternion, Euler, Matrix4, Color, Scene, Group, Object3D,
};
export const SRGBColorSpace = 'srgb';
export const LinearMipmapLinearFilter = 1;
export const LinearFilter = 0;
export const DynamicDrawUsage = 0;
export const AdditiveBlending = 2;
export const DoubleSide = 2;
export const FrontSide = 0;
export default { Vector3, Quaternion, Euler, Matrix4, Color, Scene };
