/**
 * spritePool.js — pre-pooled InstancedMesh of PlaneGeometry per atlas.
 *
 * One ShaderMaterial per atlas. Each instance carries:
 *   - per-instance world transform (instanceMatrix)
 *   - per-instance frame index   (aFrame InstancedBufferAttribute)
 *   - per-instance world scale   (aScale InstancedBufferAttribute, single float)
 *
 * Vertex shader reads `aFrame` + atlas (cols, rows) → uv offset. Vertex
 * shader also handles billboard rotation (screen | cylinder | none) so
 * we don't pay per-frame rotation update from JS.
 *
 * Fragment samples sub-region with NearestFilter for pixel crunch.
 *
 * Perf contract (docs/SPRITES_VISUAL_STYLE.md):
 *   - Zero per-spawn allocation. Pool of N instances. Recycle oldest-first.
 *   - One draw call per atlas.
 *   - lowFx kill-switch: if atlas.bypassWhenLowFx + state.run.lowFx, no spawn.
 *
 * Lifetime model — every spawned sprite has finite life (anim duration or
 * explicit ttl). Dead instances are written to a hidden "stash" position
 * (far below the world) and the slot is reused.
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from '../postfx.js';
import { getAtlas } from './spriteAtlas.js';

const DEFAULT_POOL_CAP = 256;
const STASH_Y = -10000; // off-screen parking for dead instances

const _pools = new Map(); // atlasId → poolRecord

let _globalLowFx = () => false; // optional hook set by main.js

export function setLowFxProbe(fn) {
  if (typeof fn === 'function') _globalLowFx = fn;
}

/**
 * Initialize the pool for a loaded atlas. Idempotent — re-calling returns
 * the existing pool. Must be called AFTER loadAtlas(id) resolves AND after
 * the scene is constructed.
 *
 * @param {THREE.Scene} scene
 * @param {string}      atlasId
 * @param {number}      [cap=DEFAULT_POOL_CAP]
 * @param {object}      [opts]
 * @param {boolean}     [opts.bypassWhenLowFx=false]
 */
export function ensurePool(scene, atlasId, cap = DEFAULT_POOL_CAP, opts = {}) {
  if (_pools.has(atlasId)) return _pools.get(atlasId);
  const atlas = getAtlas(atlasId);
  if (!atlas) throw new Error(`[spritePool] atlas not loaded: ${atlasId}`);

  const geom = new THREE.PlaneGeometry(1, 1);
  // Per-instance frame index (float32, one per instance).
  const frameAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
  frameAttr.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute('aFrame', frameAttr);
  // Per-instance scalar scale (world units height; width derived from aspect).
  const scaleAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
  scaleAttr.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute('aScale', scaleAttr);

  const aspect = atlas.frameWidth / atlas.frameHeight;
  const billboardMode = atlas.billboard === 'cylinder' ? 1
                      : atlas.billboard === 'none'     ? 2
                      : 0;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMap:        { value: atlas.texture },
      uCols:       { value: atlas.cols },
      uRows:       { value: atlas.rows },
      uAspect:     { value: aspect },
      uBillboard:  { value: billboardMode },
      uAnchor:     { value: new THREE.Vector2(atlas.anchor[0], atlas.anchor[1]) },
    },
    vertexShader: _VS,
    fragmentShader: _FS,
    transparent: true,
    depthWrite: false,
    blending: atlas.blendMode === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
  });

  const mesh = new THREE.InstancedMesh(geom, material, cap);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false; // billboards span unpredictable bounds
  mesh.count = cap;
  if (atlas.bloom) mesh.layers.enable(BLOOM_LAYER);
  scene.add(mesh);

  // Stash every slot off-screen on init so unused slots don't render at origin.
  const stashMatrix = new THREE.Matrix4();
  stashMatrix.setPosition(0, STASH_Y, 0);
  for (let i = 0; i < cap; i++) mesh.setMatrixAt(i, stashMatrix);
  mesh.instanceMatrix.needsUpdate = true;

  const pool = {
    atlasId,
    atlas,
    mesh,
    geom,
    material,
    cap,
    frameAttr,
    scaleAttr,
    bypassWhenLowFx: !!opts.bypassWhenLowFx,
    // Per-slot state — flat arrays for cache-friendly tick.
    sX:     new Float32Array(cap),
    sY:     new Float32Array(cap),
    sZ:     new Float32Array(cap),
    sScale: new Float32Array(cap),
    sFrom:  new Uint16Array(cap),
    sTo:    new Uint16Array(cap),
    sFps:   new Float32Array(cap),
    sLoop:  new Uint8Array(cap),
    sElapsed: new Float32Array(cap), // seconds since spawn
    sAlive: new Uint8Array(cap),     // 0 = stashed, 1 = active
    sBornAt: new Float32Array(cap),  // frame counter at birth (for oldest-first recycle)
    _writeIdx: 0,                    // round-robin head for recycle
    _spawnTick: 0,
    _stashMatrix: stashMatrix.clone(),
    _matrix: new THREE.Matrix4(),
  };
  _pools.set(atlasId, pool);
  return pool;
}

/**
 * Spawn one sprite. Returns slot index or -1 if low-fx bypass.
 *
 * @param {string} atlasId
 * @param {object} opts
 * @param {number} opts.x  world x
 * @param {number} opts.y  world y
 * @param {number} opts.z  world z
 * @param {number} [opts.scale=1]   world-units height multiplier
 * @param {string} [opts.anim='default']
 */
export function spawnSprite(atlasId, opts) {
  const pool = _pools.get(atlasId);
  if (!pool) return -1;
  if (pool.bypassWhenLowFx && _globalLowFx()) return -1;

  const anim = pool.atlas.anims[opts.anim ?? 'default'] ?? pool.atlas.anims.default;
  if (!anim) return -1;

  // Find slot: prefer a stashed (dead) slot, else recycle oldest by birth tick.
  let slot = -1;
  for (let probe = 0; probe < pool.cap; probe++) {
    const i = (pool._writeIdx + probe) % pool.cap;
    if (pool.sAlive[i] === 0) { slot = i; break; }
  }
  if (slot === -1) {
    // All alive — evict oldest.
    let oldestTick = Infinity;
    for (let i = 0; i < pool.cap; i++) {
      if (pool.sBornAt[i] < oldestTick) { oldestTick = pool.sBornAt[i]; slot = i; }
    }
  }
  pool._writeIdx = (slot + 1) % pool.cap;

  const scale = opts.scale ?? 1;
  pool.sX[slot] = opts.x;
  pool.sY[slot] = opts.y;
  pool.sZ[slot] = opts.z;
  pool.sScale[slot] = scale;
  pool.sFrom[slot] = anim.from;
  pool.sTo[slot]   = anim.to;
  pool.sFps[slot]  = anim.fps;
  pool.sLoop[slot] = anim.loop ? 1 : 0;
  pool.sElapsed[slot] = 0;
  pool.sAlive[slot] = 1;
  pool.sBornAt[slot] = pool._spawnTick++;

  // Initial matrix + frame write (the tick loop will refresh after movement,
  // but having a valid one immediately means the first frame renders correctly).
  pool._matrix.identity();
  pool._matrix.setPosition(opts.x, opts.y, opts.z);
  pool.mesh.setMatrixAt(slot, pool._matrix);
  pool.frameAttr.array[slot] = anim.from;
  pool.scaleAttr.array[slot] = scale;
  pool.mesh.instanceMatrix.needsUpdate = true;
  pool.frameAttr.needsUpdate = true;
  pool.scaleAttr.needsUpdate = true;
  return slot;
}

/**
 * Tick every pool. Call once per frame from main.js.
 *
 * @param {number} dt  seconds since last frame
 */
/**
 * Move an active sprite slot to a new world position. Use this for
 * entity-attached sprites (mob billboards) that need to follow their
 * entity. No-op if slot is dead or atlas unknown.
 */
export function moveSprite(atlasId, slot, x, y, z) {
  const pool = _pools.get(atlasId);
  if (!pool || slot < 0 || slot >= pool.cap) return;
  if (pool.sAlive[slot] === 0) return;
  pool.sX[slot] = x;
  pool.sY[slot] = y;
  pool.sZ[slot] = z;
  pool._matrix.identity();
  pool._matrix.setPosition(x, y, z);
  pool.mesh.setMatrixAt(slot, pool._matrix);
  pool.mesh.instanceMatrix.needsUpdate = true;
}

/**
 * Force-stash a sprite slot (e.g. on entity despawn). Slot becomes available
 * for new spawns immediately. Use this to avoid a death-frame ghost lingering.
 */
export function killSprite(atlasId, slot) {
  const pool = _pools.get(atlasId);
  if (!pool || slot < 0 || slot >= pool.cap) return;
  if (pool.sAlive[slot] === 0) return;
  pool.sAlive[slot] = 0;
  pool.mesh.setMatrixAt(slot, pool._stashMatrix);
  pool.mesh.instanceMatrix.needsUpdate = true;
}

export function tickSpriteSystem(dt) {
  for (const pool of _pools.values()) {
    let anyAlive = false;
    let frameDirty = false;
    let matDirty = false;
    for (let i = 0; i < pool.cap; i++) {
      if (pool.sAlive[i] === 0) continue;
      anyAlive = true;
      const t = (pool.sElapsed[i] += dt);
      const totalFrames = pool.sTo[i] - pool.sFrom[i] + 1;
      const totalDur = totalFrames / pool.sFps[i];

      if (t >= totalDur) {
        if (pool.sLoop[i]) {
          // Continue looping by reducing elapsed by totalDur.
          pool.sElapsed[i] = t - totalDur * Math.floor(t / totalDur);
        } else {
          // Dead — stash off-screen and free the slot.
          pool.mesh.setMatrixAt(i, pool._stashMatrix);
          pool.sAlive[i] = 0;
          pool.frameAttr.array[i] = 0;
          matDirty = true;
          frameDirty = true;
          continue;
        }
      }
      const f = pool.sFrom[i] + Math.min(
        totalFrames - 1,
        Math.floor((pool.sElapsed[i] / totalDur) * totalFrames),
      );
      if (pool.frameAttr.array[i] !== f) {
        pool.frameAttr.array[i] = f;
        frameDirty = true;
      }
    }
    if (anyAlive) {
      if (frameDirty) pool.frameAttr.needsUpdate = true;
      if (matDirty)   pool.mesh.instanceMatrix.needsUpdate = true;
    } else if (frameDirty || matDirty) {
      if (frameDirty) pool.frameAttr.needsUpdate = true;
      if (matDirty)   pool.mesh.instanceMatrix.needsUpdate = true;
    }
  }
}

export function disposeSpritePools() {
  for (const pool of _pools.values()) {
    if (pool.mesh.parent) pool.mesh.parent.remove(pool.mesh);
    pool.geom.dispose();
    pool.material.dispose();
  }
  _pools.clear();
}

// ── Shaders ─────────────────────────────────────────────────────────────

const _VS = /* glsl */`
  precision highp float;
  attribute float aFrame;
  attribute float aScale;
  uniform float uCols;
  uniform float uRows;
  uniform float uAspect;
  uniform int   uBillboard; // 0=screen, 1=cylinder, 2=none
  uniform vec2  uAnchor;
  varying vec2  vUv;

  void main() {
    // Per-frame UV offset (row-major, top-left origin in atlas convention).
    float f    = aFrame;
    float col  = mod(f, uCols);
    float row  = floor(f / uCols);
    // Atlas image is laid out top-to-bottom; THREE samples bottom-to-top.
    // Flip the row so frame 0 reads from the TOP of the texture.
    float vRow = (uRows - 1.0) - row;
    vec2 frameUV = (uv + vec2(col, vRow)) / vec2(uCols, uRows);
    vUv = frameUV;

    // Plane is [-0.5..0.5] in XY. Apply scale + anchor offset.
    vec2 cornerOffset = (position.xy - (uAnchor - vec2(0.5))) * vec2(uAspect, 1.0) * aScale;

    // Pull instance world translation out of the instance matrix.
    vec3 iPos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);

    if (uBillboard == 2) {
      // No billboard: respect the full instance matrix + plane is XY-aligned.
      vec4 mvp = modelViewMatrix * instanceMatrix * vec4(position.xy * aScale * vec2(uAspect, 1.0), 0.0, 1.0);
      gl_Position = projectionMatrix * mvp;
      return;
    }

    if (uBillboard == 0) {
      // Screen-aligned: corners added in view space → always face camera.
      vec4 mvCenter = modelViewMatrix * vec4(iPos, 1.0);
      mvCenter.xy += cornerOffset;
      gl_Position = projectionMatrix * mvCenter;
    } else {
      // Cylinder (Y-axis billboard) — face camera horizontally, stay vertical.
      // View-space Y is preserved; we rotate XZ around the world Y of iPos to face camera.
      vec3 camDir = normalize(cameraPosition - iPos);
      camDir.y = 0.0;
      camDir = normalize(camDir);
      vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), camDir));
      vec3 up    = vec3(0.0, 1.0, 0.0);
      vec3 world = iPos + right * cornerOffset.x + up * cornerOffset.y;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
    }
  }
`;

const _FS = /* glsl */`
  precision highp float;
  uniform sampler2D uMap;
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(uMap, vUv);
    if (c.a < 0.01) discard;
    gl_FragColor = c;
  }
`;
