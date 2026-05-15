// Bare-minimum THREE.js stub for Phase B smoke tests. Only exports the
// constructors actually referenced by config.js/state.js at module-init time.
class Vector2   { constructor(x = 0, y = 0)         { this.x = x; this.y = y; } set(){return this;} copy(){return this;} }
class Vector3   { constructor(x = 0, y = 0, z = 0)  { this.x = x; this.y = y; this.z = z; } set(){return this;} copy(){return this;} }
class Quaternion { constructor() {} setFromEuler(){return this;} copy(){return this;} }
class Euler     { constructor() {} }
class Matrix4   { constructor() {} compose(){return this;} setPosition(){return this;} identity(){return this;} copy(){return this;} multiply(){return this;} multiplyMatrices(){return this;} makeRotationY(){return this;} }
class Color     { constructor() {} }
class Scene     { constructor() {} add(){} }
class Group     { constructor() {} add(){} }
class Object3D  { constructor() {} add(){} }

export {
  Vector2, Vector3, Quaternion, Euler, Matrix4, Color, Scene, Group, Object3D,
};
class PlaneGeometry { constructor() {} rotateX(){return this;} }
class CircleGeometry { constructor() {} }
class BoxGeometry { constructor() {} }
class SphereGeometry { constructor() {} }
class ConeGeometry { constructor() {} }
class BufferGeometry { constructor() {} }
class Box3 { setFromObject(){return this;} getSize(v){return v;} }
class MeshBasicMaterial { constructor() {} clone(){return this;} }
class MeshLambertMaterial { constructor() {} clone(){return this;} }
class MeshStandardMaterial { constructor() {} clone(){return this;} }
class InstancedMesh { constructor() { this.instanceMatrix = { setUsage(){}, needsUpdate:false }; this.layers = { enable(){} }; } setMatrixAt(){} setColorAt(){} }
class InstancedBufferAttribute { constructor() {} setUsage(){} }
class Mesh { constructor() { this.position={x:0,y:0,z:0,set(){}}; this.rotation={x:0,y:0,z:0,order:''}; this.scale={x:1,y:1,z:1,setScalar(){}}; this.layers={enable(){}}; this.userData={}; } }
class TextureLoader { load(){ return { colorSpace:'', anisotropy:0, minFilter:0, magFilter:0 }; } }
class CanvasTexture { constructor() {} }
class PointLight { constructor() {} }
class DirectionalLight { constructor() {} }
class AmbientLight { constructor() {} }
class HemisphereLight { constructor() {} }
class Fog { constructor() {} }

// EffectComposer / Pass stubs for postfx.js
class EffectComposer { constructor() {} addPass() {} setSize() {} render() {} }
class RenderPass { constructor() {} }
class UnrealBloomPass { constructor() {} }
class ShaderPass { constructor() {} }
class OutputPass { constructor() {} }
class GLTFLoader { constructor() {} setDRACOLoader(){} load(){} }
class DRACOLoader { constructor() {} setDecoderPath(){} setDecoderConfig(){} }
class RGBELoader { constructor() {} load(){} setDataType(){} }
const SkeletonUtils = { clone: (x) => x };
function mergeGeometries() { return new BufferGeometry(); }
export { EffectComposer, RenderPass, UnrealBloomPass, ShaderPass, OutputPass,
         GLTFLoader, DRACOLoader, RGBELoader, SkeletonUtils, mergeGeometries };
export { PlaneGeometry, CircleGeometry, BoxGeometry, SphereGeometry, ConeGeometry, BufferGeometry, Box3,
         MeshBasicMaterial, MeshLambertMaterial, MeshStandardMaterial,
         InstancedMesh, InstancedBufferAttribute, Mesh, TextureLoader, CanvasTexture,
         PointLight, DirectionalLight, AmbientLight, HemisphereLight, Fog };
export const SRGBColorSpace = 'srgb';
export const LinearMipmapLinearFilter = 1;
export const LinearFilter = 0;
export const DynamicDrawUsage = 0;
export const AdditiveBlending = 2;
export const NormalBlending = 1;
export const DoubleSide = 2;
export const FrontSide = 0;
export const BackSide = 1;
export const NoColorSpace = '';
export const RepeatWrapping = 1000;
export const ClampToEdgeWrapping = 1001;
export const PCFSoftShadowMap = 2;
export const ACESFilmicToneMapping = 4;
export const Color3 = Color;
export default { Vector3, Quaternion, Euler, Matrix4, Color, Scene };
