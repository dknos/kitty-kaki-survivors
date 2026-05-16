/**
 * Stage hazards — environmental rules that change movement/combat per biome.
 * Each stage gets ONE rule the advisor brief calls out as the missing
 * "stage individuality" piece. Activated when a run enters that stage.
 *
 * - **Forest**: pollen-spore drifts (slowing patches of dandelion fluff,
 *   visible as cyan ground sprites). Stepping in them slows hero 20% for 1s.
 *   Light hazard — teaches the system without punishing the early game.
 *
 * - **Twilight**: fog-of-war shroud (vision radius shrinks to ~18u via dark
 *   plane overlay). Distant threats become invisible. Encourages mobility.
 *
 * - **Cinder**: lava puddles (red emissive discs). Stepping in them deals
 *   3 dmg/s. Forced kiting. Telegraphed by a yellow rim flash before they
 *   appear so the player can dodge.
 *
 * Architecture: one module, init at boot, tick per frame in run mode. Each
 * hazard kind has its own InstancedMesh pool. The active stage's hazard set
 * is the only one that ticks; the others stay parked under the world.
 */
import * as THREE from 'three';
import { state } from './state.js';
import { takeDamage as heroTakeDamage } from './hero.js';
import { BLOOM_LAYER } from './postfx.js';
import { tex } from './particleTextures.js';
import { spawnMagnetSpark } from './fx.js';

const POLLEN_CAP = 32;
const LAVA_CAP = 18;

const _m4 = new THREE.Matrix4();
const _v3 = new THREE.Vector3();
const _flatX = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const _zero = new THREE.Vector3(0, 0, 0);
const _tmpScale = new THREE.Vector3();   // iter 33k — pool for Matrix4.compose
const _color = new THREE.Color();

let _scene = null;
let _pollenInst = null;
let _lavaInst = null;
let _twilightFogPlane = null;

// Forest chokepoint slow-zones — derived once from the same hotspot JSON the
// Amber agent reads. Stored module-side as `{x, z, r2, mul}` (r² precomputed so
// the enemy hot path needs only one multiply per zone). Published to
// `state.run.forestSlowZones` so enemies.js can read without an import cycle.
const FOREST_SLOWZONE_RADIUS = 2.5;
const FOREST_SLOWZONE_R2     = FOREST_SLOWZONE_RADIUS * FOREST_SLOWZONE_RADIUS;
const FOREST_SLOWZONE_MUL    = 0.55;
let _forestSlowZones = null;

// Active hazard rosters per stage. Populated lazily on entering a run.
const _pollens = []; // {x, z, ttl, life}
const _lavas = [];   // {x, z, ttl, life, armingUntil, radius}

function _mkInst(geo, mat, cap, blend = THREE.AdditiveBlending) {
  const inst = new THREE.InstancedMesh(geo, mat, cap);
  inst.count = cap;
  inst.frustumCulled = false;
  inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < cap; i++) {
    _m4.compose(_v3.set(0, -1000, 0), _flatX, _zero);
    inst.setMatrixAt(i, _m4);
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  inst.instanceColor.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < cap; i++) inst.setColorAt(i, _color.setHex(0xffffff));
  inst.instanceColor.needsUpdate = true;
  inst.layers.enable(BLOOM_LAYER);
  return inst;
}

export function initStageHazards(scene) {
  if (_pollenInst) return;
  _scene = scene;
  // Pollen — textured cyan-cream fluff (multi-octave noise sprite). Reads
  // as dandelion spore drift, not a solid cyan disc.
  const pollenGeo = new THREE.PlaneGeometry(2.4, 2.4);
  const pollenMat = new THREE.MeshBasicMaterial({
    map: tex('pollen'),
    color: 0xcfeaff, transparent: true, opacity: 0.85,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  _pollenInst = _mkInst(pollenGeo, pollenMat, POLLEN_CAP);
  scene.add(_pollenInst);
  // Lava — textured molten puddle (dark crust ring + bright veins). Reads
  // as a real basalt pit, not a flat red blob.
  const lavaGeo = new THREE.PlaneGeometry(3.0, 3.0);
  const lavaMat = new THREE.MeshBasicMaterial({
    map: tex('lavaPuddle'),
    color: 0xffffff, transparent: true, opacity: 0.95,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  _lavaInst = _mkInst(lavaGeo, lavaMat, LAVA_CAP);
  scene.add(_lavaInst);
  // Twilight fog — a large dark plane that follows the hero and fades to clear
  // near the center via radial gradient (sampling done in fragment shader).
  const fogGeo = new THREE.PlaneGeometry(120, 120);
  const fogMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uHero: { value: new THREE.Vector2(0, 0) },
      uInner: { value: 14.0 },
      uOuter: { value: 32.0 },
    },
    vertexShader: `
      varying vec2 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform vec2 uHero;
      uniform float uInner;
      uniform float uOuter;
      varying vec2 vWorld;
      void main() {
        float d = distance(vWorld, uHero);
        float k = smoothstep(uInner, uOuter, d);
        gl_FragColor = vec4(0.02, 0.05, 0.09, k * 0.78);
      }
    `,
  });
  _twilightFogPlane = new THREE.Mesh(fogGeo, fogMat);
  _twilightFogPlane.rotation.x = -Math.PI / 2;
  _twilightFogPlane.position.y = 0.5;
  _twilightFogPlane.visible = false;
  scene.add(_twilightFogPlane);
}

function _writeMatrix(inst, i, x, y, z, scale, color) {
  _v3.set(x, y, z);
  _m4.compose(_v3, _flatX, _tmpScale.set(scale, scale, scale));
  inst.setMatrixAt(i, _m4);
  if (color !== undefined) inst.setColorAt(i, _color.setHex(color));
}

// V2: variant of _writeMatrix that bakes a per-instance yaw rotation into the
// composed matrix (around world Y). Used by pollen + lava so the sprites
// don't all face the same UV orientation — sells "individual particles
// drifting" rather than "stamped decals". Reuses the module-scope quat/vec.
const _yawQuat = new THREE.Quaternion();
const _yawAxis = new THREE.Vector3(0, 1, 0);
const _composeQuat = new THREE.Quaternion();
function _writeMatrixYaw(inst, i, x, y, z, scale, yaw, color) {
  _v3.set(x, y, z);
  _yawQuat.setFromAxisAngle(_yawAxis, yaw);
  _composeQuat.multiplyQuaternions(_yawQuat, _flatX);
  _m4.compose(_v3, _composeQuat, _tmpScale.set(scale, scale, scale));
  inst.setMatrixAt(i, _m4);
  if (color !== undefined) inst.setColorAt(i, _color.setHex(color));
}

function _hide(inst, i) {
  _m4.compose(_v3.set(0, -1000, 0), _flatX, _zero);
  inst.setMatrixAt(i, _m4);
}

// Spawn helpers — called by tickStageHazards based on the active stage
function _spawnPollenNearHero() {
  if (_pollens.length >= POLLEN_CAP) _pollens.shift();
  const h = state.hero.pos;
  // 8-22u from hero, random angle
  const a = Math.random() * Math.PI * 2;
  const r = 8 + Math.random() * 14;
  _pollens.push({
    x: h.x + Math.cos(a) * r,
    z: h.z + Math.sin(a) * r,
    ttl: 10 + Math.random() * 6,
    life: 10 + Math.random() * 6,
  });
}

function _spawnLavaNearHero() {
  if (_lavas.length >= LAVA_CAP) _lavas.shift();
  const h = state.hero.pos;
  const a = Math.random() * Math.PI * 2;
  const r = 6 + Math.random() * 16;
  _lavas.push({
    x: h.x + Math.cos(a) * r,
    z: h.z + Math.sin(a) * r,
    ttl: 12 + Math.random() * 5,
    life: 12 + Math.random() * 5,
    armingUntil: state.time.game + 1.2,  // yellow rim flash for the first 1.2s
    radius: 1.5,
  });
}

/**
 * External spawn entry (used by Cinder stage rule "Eruption"). Drops a lava
 * puddle at an arbitrary world position with the standard arming flash.
 */
export function spawnLavaPuddle(x, z) {
  if (!_lavaInst) return;
  if (_lavas.length >= LAVA_CAP) _lavas.shift();
  _lavas.push({
    x, z,
    ttl: 8 + Math.random() * 3,
    life: 8 + Math.random() * 3,
    armingUntil: state.time.game + 1.2,
    radius: 1.5,
  });
}

let _pollenCD = 0;
let _lavaCD = 0;
// V2: ambient ember emission accumulator. Each live (not arming) lava puddle
// adds to this; when the bank hits the per-emit threshold, we spawn one spark
// near a random puddle. Cheap, reuses fx.js spark pool — no new geometry.
let _lavaEmberAcc = 0;

export function tickStageHazards(dt) {
  if (state.mode !== 'run') {
    // Make sure fog is off in non-run modes
    if (_twilightFogPlane) _twilightFogPlane.visible = false;
    return;
  }
  const stage = state.run && state.run.stage;
  const stageId = stage && stage.id;
  const heroX = state.hero.pos.x, heroZ = state.hero.pos.z;

  // ── Forest pollen ──
  let pollenSlow = 1.0;
  if (stageId === 'forest') {
    _pollenCD -= dt;
    if (_pollenCD <= 0) {
      _spawnPollenNearHero();
      _pollenCD = 2.5 + Math.random() * 2.0;
    }
    // Render + hero check
    for (let i = 0; i < _pollens.length; i++) {
      const p = _pollens[i];
      p.ttl -= dt;
      if (p.ttl <= 0) {
        _hide(_pollenInst, i);
        continue;
      }
      // Fade-in, fade-out around the lifetime midpoint
      const k = p.ttl / p.life;
      const alphaScale = Math.min(1, Math.min(k, 1 - k) * 4) || 0;
      const scale = 1.0 * (0.7 + 0.3 * Math.sin(state.time.real * 1.6 + i));
      // V2: per-puff yaw drift so each pollen sprite reads as an
      // independently-tumbling fluff rather than a stamped decal. Phase
      // offset by index so neighbors don't lockstep.
      const yaw = state.time.real * 0.30 + i * 1.37;
      _writeMatrixYaw(_pollenInst, i, p.x, 0.04, p.z, scale * alphaScale, yaw, 0xb0e0ff);
      // Slow if hero is inside
      const dx = heroX - p.x, dz = heroZ - p.z;
      if (dx * dx + dz * dz < 1.2 * 1.2) pollenSlow = Math.min(pollenSlow, 0.8);
    }
    // Clean dead entries off the front
    while (_pollens.length > 0 && _pollens[0].ttl <= 0) {
      _pollens.shift();
    }
    _pollenInst.instanceMatrix.needsUpdate = true;
    _pollenInst.instanceColor.needsUpdate = true;
  } else {
    // Hide all pollen slots when stage doesn't use them
    if (_pollens.length > 0) {
      for (let i = 0; i < POLLEN_CAP; i++) _hide(_pollenInst, i);
      _pollens.length = 0;
      _pollenInst.instanceMatrix.needsUpdate = true;
    }
  }

  // ── Twilight fog ──
  if (stageId === 'twilight') {
    if (_twilightFogPlane) {
      _twilightFogPlane.visible = true;
      _twilightFogPlane.position.x = heroX;
      _twilightFogPlane.position.z = heroZ;
      const u = _twilightFogPlane.material.uniforms;
      u.uHero.value.set(heroX, heroZ);
      // Witching Hour surge tightens vision: inner clear-radius shrinks
      // from 14u to 6u, dark wall pulls in from 32u to 18u.
      const surge = !!(state.run && state.run.twilightSurge);
      const tgtInner = surge ? 6.0  : 14.0;
      const tgtOuter = surge ? 18.0 : 32.0;
      u.uInner.value += (tgtInner - u.uInner.value) * Math.min(1, dt * 4);
      u.uOuter.value += (tgtOuter - u.uOuter.value) * Math.min(1, dt * 4);
    }
  } else {
    if (_twilightFogPlane) _twilightFogPlane.visible = false;
  }

  // ── Cinder lava ──
  if (stageId === 'cinder') {
    _lavaCD -= dt;
    if (_lavaCD <= 0) {
      _spawnLavaNearHero();
      _lavaCD = 3.5 + Math.random() * 2.0;
    }
    for (let i = 0; i < _lavas.length; i++) {
      const lp = _lavas[i];
      lp.ttl -= dt;
      if (lp.ttl <= 0) {
        _hide(_lavaInst, i);
        continue;
      }
      const arming = state.time.game < lp.armingUntil;
      // Pulse + color shift between arming (yellow) and live (red)
      const k = lp.ttl / lp.life;
      const alphaScale = Math.min(1, Math.min(k, 1 - k) * 4) || 0;
      const pulse = 0.92 + 0.10 * Math.sin(state.time.real * 6 + i);
      // V2: slow per-puddle yaw so the crack-vein bitmap pattern visually
      // shifts on each puddle — sells "molten flow" without animating the
      // texture. Phase by index so puddles don't lockstep.
      const lavaYaw = state.time.real * 0.18 + i * 0.91;
      _writeMatrixYaw(_lavaInst, i, lp.x, 0.04, lp.z, lp.radius * pulse * alphaScale, lavaYaw, arming ? 0xffd24a : 0xff5522);
      // Hero damage if standing inside live lava
      if (!arming) {
        const dx = heroX - lp.x, dz = heroZ - lp.z;
        if (dx * dx + dz * dz < lp.radius * lp.radius) {
          // 3 dmg/s, tick at most every 0.5s using i-frames as the gate
          if (state.time.game >= (state.hero.iFramesUntil || 0)) {
            try { heroTakeDamage(1.5); } catch (_) {}
          }
        }
      }
    }
    while (_lavas.length > 0 && _lavas[0].ttl <= 0) _lavas.shift();
    _lavaInst.instanceMatrix.needsUpdate = true;
    _lavaInst.instanceColor.needsUpdate = true;

    // V2: ambient lava embers — one spark every ~0.35s from a random LIVE
    // puddle (skip arming). Sells "molten" without per-puddle particle math
    // or a dedicated InstancedMesh. Skip if reduce-motion is on.
    if (!state._optReduceMotion && _lavas.length > 0) {
      _lavaEmberAcc += dt;
      if (_lavaEmberAcc >= 0.35) {
        _lavaEmberAcc = 0;
        // Pick a random live puddle (linear scan; counts are tiny — cap 18).
        const liveIdxs = [];
        for (let i = 0; i < _lavas.length; i++) {
          const lp = _lavas[i];
          if (lp.ttl > 0 && state.time.game >= lp.armingUntil) liveIdxs.push(i);
        }
        if (liveIdxs.length > 0) {
          const lp = _lavas[liveIdxs[Math.floor(Math.random() * liveIdxs.length)]];
          // Random point within the puddle radius
          const a = Math.random() * Math.PI * 2;
          const r = Math.random() * lp.radius * 0.7;
          spawnMagnetSpark(
            lp.x + Math.cos(a) * r,
            0.4 + Math.random() * 0.8,
            lp.z + Math.sin(a) * r,
            0xff9a3a,
          );
        }
      }
    }
  } else {
    if (_lavas.length > 0) {
      for (let i = 0; i < LAVA_CAP; i++) _hide(_lavaInst, i);
      _lavas.length = 0;
      _lavaInst.instanceMatrix.needsUpdate = true;
    }
  }

  // Apply pollen slow by multiplying hero speed for this frame.
  // Read by hero.js if we expose state.hero.hazardSlow.
  state.hero.hazardSlow = pollenSlow;
}

export function resetStageHazards() {
  _pollens.length = 0;
  _lavas.length = 0;
  _pollenCD = 0;
  _lavaCD = 0;
  if (_pollenInst) { for (let i = 0; i < POLLEN_CAP; i++) _hide(_pollenInst, i); _pollenInst.instanceMatrix.needsUpdate = true; }
  if (_lavaInst)   { for (let i = 0; i < LAVA_CAP; i++)   _hide(_lavaInst, i);   _lavaInst.instanceMatrix.needsUpdate = true; }
  if (_twilightFogPlane) _twilightFogPlane.visible = false;
  if (state.hero) state.hero.hazardSlow = 1.0;
  // Drop any forest slow-zones too. The visual marker (if ever shipped)
  // would be cleared by clearForestHazards; resetStageHazards only nukes the
  // data side so a stale roster doesn't bleed into the next run.
  _forestSlowZones = null;
  if (state.run) state.run.forestSlowZones = null;
}

// ─── Forest chokepoint slow-zones ────────────────────────────────────────────
// Single-file funnel pass for swarms — derives zones from the 18 deterministic
// amber hotspots (chokepoints == hotspot positions per docs/FOREST_VISUAL_STYLE.md).
// Enemies.js reads `state.run.forestSlowZones` inside its existing slow-aggregator
// loop (same pattern as Sticky Web). No per-frame work needed here; the
// load/publish/read split keeps the tick hot path zone-allocation-free.
//
// Visual marker intentionally omitted on first pass — the forest already stacks
// pollen sprites + amber idle pulse + rune rings + shockwaves, and another
// slot-5 ground ring risks muddying the read against amber telegraphs. Revisit
// after playtest if zones feel invisible.
export async function loadForestHazards(scene, hotspotsUrl = 'assets/forest_amber_hotspots.json') {
  // Idempotent: nuke any prior roster before rebuilding.
  clearForestHazards(scene);
  let hotspots = null;
  try {
    const res = await fetch(hotspotsUrl);
    hotspots = await res.json();
  } catch (e) {
    console.warn('[stageHazards] forest hotspot fetch failed:', e);
    return 0;
  }
  if (!Array.isArray(hotspots) || hotspots.length === 0) return 0;
  // Precompute r² so the enemy-loop hot path is mul-free per zone.
  _forestSlowZones = hotspots.map((h) => ({
    x: h.x, z: h.z,
    r2: FOREST_SLOWZONE_R2,
    mul: FOREST_SLOWZONE_MUL,
  }));
  // Publish so enemies.js can read without importing this module.
  if (state.run) state.run.forestSlowZones = _forestSlowZones;
  return _forestSlowZones.length;
}

export function clearForestHazards(_scene) {
  _forestSlowZones = null;
  if (state.run) state.run.forestSlowZones = null;
}
