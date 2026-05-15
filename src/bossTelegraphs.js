/**
 * Mini-boss telegraphs: named announcements + periodic wind-up + per-boss
 * signature attack. Each named boss now runs its OWN pattern so the silhouette
 * and the tell teach the player who they're fighting:
 *
 *   GROTHAR (idx 0) — Engulf:     1.2s cyan contracting ring, then pull +
 *                                  damage + slow.
 *   VEXMAW  (idx 1) — Sonic Cone: 0.9s magenta forward wedge tell, then 0.2s
 *                                  pulse that hits anything inside the cone.
 *   OBLIDOR (idx 2) — Quake Cross:1.6s amber 4-bar tell at cardinals, then
 *                                  4 expanding shockwave bars (safe diagonals).
 *
 * THE NIGHTMARE (final) cycles the three every 5s (`floor(t/5) % 3`) so the
 * climax has all three rhythms back-to-back.
 *
 * Per-enemy state stored on the enemy object itself (no parallel map):
 *   _telegraphInit       bool   — first-sight bootstrap
 *   _nextTellAt          number — gameTime of next wind-up start
 *   _windupStart         number — gameTime when current wind-up started (-1 if idle)
 *   _activePatternIdx    number — pattern captured at windup START (final boss
 *                                 cycles, so we must lock the choice in)
 *   _activeWindup        number — windup duration captured at windup START
 *   _tellRing            Mesh   — the growing warning ring/wedge (Engulf/Sonic)
 *   _quakeMeshes         Mesh[] — 4 pooled bars for Oblidor's cross tell
 *   _coneDir             {x,z}  — boss→hero direction locked at Sonic windup start
 *
 * Engulf pull is multi-frame: `_pulls` queue holds active hero lerps so
 * `updateBossTelegraphs` can advance them each tick (resolve-time teleport
 * would erase the "pre-dash away during windup" counterplay).
 */
import * as THREE from 'three';
import { state } from './state.js';
import { BLOOM_LAYER } from './postfx.js';
import { takeDamage as heroTakeDamage } from './hero.js';
import { sfx } from './audio.js';
import { makeRuneRingTexture } from './enemyTells.js';
import { tex } from './particleTextures.js';
import { applyFloorTier, floorDecalMaterial } from './fxLayers.js';

let _runeTex = null;
function _getRuneTex() { return _runeTex || (_runeTex = makeRuneRingTexture()); }

// Iter 10b — geometry pool. PERF.md flagged this as a per-windup allocation
// hotspot (RingGeometry/PlaneGeometry constructors run every tell). We share
// ONE PlaneGeometry per visual class — ring (2u plane, pre-rotated flat),
// quake bar (6u×2u plane, pre-rotated flat), and cone (BufferGeometry built
// lazily). Each mesh still gets its own MeshBasicMaterial (opacity is
// per-windup state, so per-instance materials are correct). Active mesh
// count caps at 4 simultaneous boss windups (3 mini-boss patterns + the
// Nightmare final boss); resolve recycles them via the _activeRings fade-out
// path which already removes from scene + drops the mesh ref.
//
// The actual win: ~4-8 PlaneGeometry constructors per boss-windup-cycle
// replaced with property assignments. Material creation is left per-call
// because each pattern instance needs its own opacity / color state.
const POOL_MAX_SIMULTANEOUS = 4;
let _ringPoolGeo = null;
let _quakeBarPoolGeo = null;
let _conePoolGeo = null;
function _getRingPoolGeo() {
  if (!_ringPoolGeo) {
    _ringPoolGeo = new THREE.PlaneGeometry(2.0, 2.0);
    _ringPoolGeo.rotateX(-Math.PI / 2);
  }
  return _ringPoolGeo;
}
function _getQuakeBarPoolGeo() {
  if (!_quakeBarPoolGeo) {
    _quakeBarPoolGeo = new THREE.PlaneGeometry(6.0, 2.0);
    _quakeBarPoolGeo.rotateX(-Math.PI / 2);
  }
  return _quakeBarPoolGeo;
}
function _getConePoolGeo() {
  if (!_conePoolGeo) {
    // Cone built as a TriangleFan: 1 center vert + N+1 rim verts. Pre-baked
    // once, scaled per-windup. 90° wedge total (±45° around forward +X).
    const segs = 16;
    const halfAng = Math.PI / 4;
    const r = 1.0;
    const verts = [0, 0, 0];
    const uvs   = [0.5, 0.5];
    for (let i = 0; i <= segs; i++) {
      const k = i / segs;
      const a = -halfAng + k * (halfAng * 2);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      verts.push(x, 0, z);
      uvs.push(0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5);
    }
    const idx = [];
    for (let i = 1; i <= segs; i++) idx.push(0, i, i + 1);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    _conePoolGeo = g;
  }
  return _conePoolGeo;
}

// ──────────────────────────────────────────────────────────────────────────
// V2 (post-v1.0) — shared boss-tell mote pool.
// The audit V2 brief: each boss pattern should layer a particle mote sub-
// effect on top of the rune ring/cone/bars: Engulf gets cyan motes spiraling
// INWARD (sells "drawn in"), Sonic gets magenta streaks racing along the
// cone axis (sells "shrieker charging up"), Quake gets amber debris dust at
// the bar edges (sells "ground cracking"). Elite-pack telegraph (in
// miniEvents.js) imports `spawnTellMote` for converging-pack motes.
//
// All motes share one InstancedMesh (one draw call total) using the
// per-color mote-trail texture from particleTextures.js. Per-instance
// color/scale/rotation written each frame for live motes; dead slots
// collapse to zero-scale + y=-1000 (same hide pattern as enemyTells.js).
//
// Each mote carries:
//   {used, x, y, z, vx, vy, vz, life, age, color, scale, baseRot, ...}
//
// PERF: one InstancedMesh, ZERO per-frame allocations after init.
// ──────────────────────────────────────────────────────────────────────────
const MOTE_CAP = 96;  // 3 patterns × ~24 motes + ~12 for elite-pack + headroom
const MOTE_Y   = 0.18;
let _moteInst = null;
let _moteColAttr = null;
const _motes = new Array(MOTE_CAP);
for (let i = 0; i < MOTE_CAP; i++) {
  _motes[i] = {
    used: false, x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    life: 0, age: 0,
    baseScale: 1.0, lenScale: 1.0,
    rot: 0,              // yaw around world Y (kept simple — motes are flat planes)
    color: 0xffffff,
    fadeIn: 0.1,         // fraction of life spent ramping in
  };
}
const _moteMat4   = new THREE.Matrix4();
const _motePos    = new THREE.Vector3();
const _moteScl    = new THREE.Vector3();
const _moteQuat   = new THREE.Quaternion();
const _moteHidePos= new THREE.Vector3(0, -1000, 0);
const _moteHideScl= new THREE.Vector3(0, 0, 0);
const _moteFlatX  = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const _moteYawAxis= new THREE.Vector3(0, 1, 0);
const _moteColTmp = new THREE.Color();
// Compose hide matrix once.
const _moteHideMat = new THREE.Matrix4();
_moteHideMat.compose(_moteHidePos, _moteFlatX, _moteHideScl);

function _ensureMoteInst() {
  if (_moteInst || !_scene) return _moteInst;
  // Plane geometry — 1u × 1u. Per-instance scale.x sets WIDTH, scale.z sets
  // LENGTH (after flat rotation). The mote-trail texture's bright head is
  // at x=0.12 in UV → with default flat rotation, that becomes -Z (north).
  // We then yaw each mote so the head points along its velocity vector.
  const g = new THREE.PlaneGeometry(1.0, 1.0);
  // moteMagenta has the most balanced canvas; per-instance color tints it.
  const m = floorDecalMaterial({ map: tex('moteWhite') || tex('moteCyan'), opacity: 0.95 });
  _moteInst = new THREE.InstancedMesh(g, m, MOTE_CAP);
  _moteInst.count = MOTE_CAP;
  _moteInst.frustumCulled = false;
  _moteInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  applyFloorTier(_moteInst, 'boss_mote');
  // Per-instance color so cyan/magenta/amber motes coexist in one draw call.
  const colArr = new Float32Array(MOTE_CAP * 3);
  _moteColAttr = new THREE.InstancedBufferAttribute(colArr, 3);
  _moteInst.instanceColor = _moteColAttr;
  for (let i = 0; i < MOTE_CAP; i++) {
    _moteInst.setMatrixAt(i, _moteHideMat);
    _moteColTmp.setHex(0xffffff);
    _moteInst.setColorAt(i, _moteColTmp);
  }
  _moteInst.instanceMatrix.needsUpdate = true;
  if (_moteInst.instanceColor) _moteInst.instanceColor.needsUpdate = true;
  _scene.add(_moteInst);
  return _moteInst;
}

/**
 * Spawn a mote at (x, z), moving toward (x+dx, z+dz) over `life` seconds.
 * `color` hex, `widthScale` is the perpendicular thickness (default 0.45),
 * `lenScale` is the trail length (default 1.6). Caller can pass `fadeIn` to
 * stagger in (default 0.1 = ramp during first 10% of life). Returns true if
 * a slot was found, false if cap was reached (drop is gameplay-safe — motes
 * are pure decoration).
 *
 * Motion model: constant velocity. Caller picks dx/dz scaled to (life ×
 * desired_distance), so vx = dx/life. Velocity is captured at spawn; if the
 * mote should curve (Engulf spiral), spawn many short-lived motes with the
 * intended chord rather than building curve math here.
 */
export function spawnTellMote(x, z, dx, dz, life, color, widthScale, lenScale, yOffset) {
  _ensureMoteInst();
  let slot = -1;
  for (let i = 0; i < MOTE_CAP; i++) {
    if (!_motes[i].used) { slot = i; break; }
  }
  if (slot < 0) return false; // cap — gameplay-safe drop
  const m = _motes[slot];
  m.used = true;
  m.x = x; m.y = (yOffset != null ? yOffset : MOTE_Y); m.z = z;
  m.vx = dx / Math.max(0.001, life);
  m.vy = 0;
  m.vz = dz / Math.max(0.001, life);
  m.life = Math.max(0.05, life);
  m.age = 0;
  m.color = color >>> 0;
  m.baseScale = (widthScale != null ? widthScale : 0.45);
  m.lenScale  = (lenScale  != null ? lenScale  : 1.6);
  // Head points along motion vector. Mote-trail bitmap's bright pinpoint is
  // at uv.x=0.12. With our plane lying flat (rotateX -π/2 baked into
  // _moteFlatX), the U axis maps to world +X by default. So yaw = atan2 of
  // motion in (x, z) about world Y aligns the head with motion.
  m.rot = -Math.atan2(dz, dx);
  m.fadeIn = 0.15;
  return true;
}

function _updateBossTellMotes(dt) {
  if (!_moteInst) return;
  let anyChange = false;
  for (let i = 0; i < MOTE_CAP; i++) {
    const m = _motes[i];
    if (!m.used) continue;
    m.age += dt;
    if (m.age >= m.life) {
      m.used = false;
      _moteInst.setMatrixAt(i, _moteHideMat);
      anyChange = true;
      continue;
    }
    m.x += m.vx * dt;
    m.y += m.vy * dt;
    m.z += m.vz * dt;
    const k = m.age / m.life;
    // Triangular alpha: ramp in for fadeIn, then fade out over the rest.
    let alpha;
    if (k < m.fadeIn) alpha = k / m.fadeIn;
    else alpha = 1 - (k - m.fadeIn) / (1 - m.fadeIn);
    alpha = Math.max(0, Math.min(1, alpha));
    // Slight stretch as the mote travels — sells motion smear.
    const lenK = m.lenScale * (0.85 + 0.30 * Math.min(1, k * 2.5));
    _motePos.set(m.x, m.y, m.z);
    // Compose: flat rotation then yaw about Y (multiplyQuaternions order:
    // _yawQ × _moteFlatX = first apply flat, then yaw).
    _moteQuat.setFromAxisAngle(_moteYawAxis, m.rot);
    _moteQuat.multiply(_moteFlatX);
    _moteScl.set(lenK, 1, m.baseScale);
    _moteMat4.compose(_motePos, _moteQuat, _moteScl);
    _moteInst.setMatrixAt(i, _moteMat4);
    _moteColTmp.setHex(m.color).multiplyScalar(alpha);
    _moteInst.setColorAt(i, _moteColTmp);
    anyChange = true;
  }
  if (anyChange) {
    _moteInst.instanceMatrix.needsUpdate = true;
    if (_moteInst.instanceColor) _moteInst.instanceColor.needsUpdate = true;
  }
}

function _resetBossTellMotes() {
  if (!_moteInst) return;
  for (let i = 0; i < MOTE_CAP; i++) {
    _motes[i].used = false;
    _moteInst.setMatrixAt(i, _moteHideMat);
  }
  _moteInst.instanceMatrix.needsUpdate = true;
}

export const MINI_BOSS_NAMES = [
  { name: 'GROTHAR THE GLUTTON',     subtitle: 'awakens hungering' },
  { name: 'VEXMAW THE SHRIEKER',     subtitle: 'splits the canopy' },
  { name: 'OBLIDOR, IRON COLOSSUS',  subtitle: 'walks the wood'    },
];
export const FINAL_BOSS_NAME = { name: 'THE NIGHTMARE', subtitle: 'has come for you' };

const TELEGRAPH_INTERVAL_MINI  = 9.0;
const TELEGRAPH_INTERVAL_FINAL = 6.0;

// Pattern-specific tint colors. Players learn the windup color → pattern
// association — Engulf cyan, Sonic Cone magenta, Quake Cross amber.
const COL_ENGULF = 0x66ddff; // cyan — matches the volatile-affix family
const COL_SONIC  = 0xff44cc; // magenta — distinct from any other tell
const COL_QUAKE  = 0xffaa44; // amber — inherits the original shockwave color
const COL_FINAL  = 0xff5555; // red highlight overlay when final boss cycles

let _scene = null;
const _activeRings = []; // outward-expanding hit confirmations (pooled visuals)
const _pulls = [];       // active Engulf hero-pull lerps

// ──────────────────────────────────────────────────────────────────────────
// Init / reset
// ──────────────────────────────────────────────────────────────────────────
export function initBossTelegraphs(scene) {
  _scene = scene;
}

export function nameForMiniBoss(idx) {
  return MINI_BOSS_NAMES[idx] || { name: 'NAMELESS HORROR', subtitle: 'arrives' };
}

export function resetBossTelegraphs() {
  for (const r of _activeRings) {
    if (r.mesh && r.mesh.parent) r.mesh.parent.remove(r.mesh);
  }
  _activeRings.length = 0;
  _pulls.length = 0;
  // V2: clear mote pool so motes from a previous run don't ghost in.
  _resetBossTellMotes();
  // Engulf slow is a one-shot state.run flag; clear it so a fresh run does
  // not start mid-slow if the player died inside a windup.
  if (state && state.run) state.run.signature_engulfSlowUntil = 0;
}

// ──────────────────────────────────────────────────────────────────────────
// Shared mesh builders — all reuse makeRuneRingTexture so visuals stay on
// the same "runic warning" art language as the rest of the FX.
// ──────────────────────────────────────────────────────────────────────────
function _makeRingMesh(color, opacity) {
  // Pooled geometry — one PlaneGeometry shared across all ring tells.
  const g = _getRingPoolGeo();
  const m = floorDecalMaterial({ map: _getRuneTex(), color, opacity: opacity != null ? opacity : 0.95 });
  const ring = new THREE.Mesh(g, m);
  ring.position.y = 0.04;
  applyFloorTier(ring, 'boss_tell');
  return ring;
}

function _makeConeMesh(color) {
  // Pooled cone geometry — TriangleFan built once via _getConePoolGeo,
  // 90° wedge (±45° around forward +X). Per-mesh material so the magenta
  // tint + opacity pulse is independent per windup. Boss-facing-hero
  // rotation is applied by the caller via rotation.y = -atan2(z, x).
  const g = _getConePoolGeo();
  const m = floorDecalMaterial({ map: _getRuneTex(), color, opacity: 0.85 });
  const mesh = new THREE.Mesh(g, m);
  mesh.position.y = 0.04;
  applyFloorTier(mesh, 'boss_tell');
  return mesh;
}

function _makeQuakeBar(color, opacity) {
  // Pooled 6u×2u plane (rune-textured). Quake bar shares the same geometry
  // across all 4 cardinal directions × multiple bosses simultaneously — the
  // per-bar position + rotation are mesh-level transforms.
  const g = _getQuakeBarPoolGeo();
  const m = floorDecalMaterial({ map: _getRuneTex(), color, opacity: opacity != null ? opacity : 0.85 });
  const bar = new THREE.Mesh(g, m);
  bar.position.y = 0.04;
  applyFloorTier(bar, 'boss_tell');
  return bar;
}

// ──────────────────────────────────────────────────────────────────────────
// Pattern definitions — single source of truth for tints, durations, tells,
// and resolve mechanics. Each pattern is a small interface so the dispatch
// loop in updateBossTelegraphs stays generic.
// ──────────────────────────────────────────────────────────────────────────

// ── 0. Grothar — Engulf ───────────────────────────────────────────────────
const engulfPattern = {
  id: 'engulf',
  windupColor: COL_ENGULF,
  windupDuration: 1.2,
  makeTell(boss) {
    // Contracting outer ring (rune art, primary tell).
    const ring = _makeRingMesh(COL_ENGULF, 0.95);
    ring.position.set(boss.mesh.position.x, 0.04, boss.mesh.position.z);
    ring.scale.set(6.0, 1, 6.0);
    _scene.add(ring);
    // V2: inner glow ring at higher pulse frequency. Sells the "draw-in"
    // suction by being smaller + brighter at the center of the contract.
    // Stored on the boss so _disposeTell can clean it up.
    const inner = _makeRingMesh(COL_ENGULF, 0.55);
    inner.position.set(boss.mesh.position.x, 0.045, boss.mesh.position.z);
    inner.scale.set(2.2, 1, 2.2);
    _scene.add(inner);
    boss._engulfInner = inner;
    // V2: mote accumulator — track how much windup-time has elapsed since
    // last mote emission. Per-mote: cyan, spirals inward, life ~0.75s,
    // velocity scaled so it covers from radius 6u to ~0u in that time.
    boss._engulfMoteAcc = 0;
    return ring;
  },
  resolve(boss, _state) {
    const bx = boss.mesh.position.x;
    const bz = boss.mesh.position.z;
    const hp = state.hero.pos;
    const dx = hp.x - bx, dz = hp.z - bz;
    const d  = Math.max(0.001, Math.hypot(dx, dz));

    // Damage first. The pull happens regardless (it's the signature beat) —
    // but damage only if hero was in the danger zone (8u catch radius).
    if (d <= 8.0) {
      heroTakeDamage(14);
      // 1.0s slow read by hero.js movement.
      state.run.signature_engulfSlowUntil = state.time.game + 1.0;
    }

    // Queue a 0.4s pull: hero lerps from current pos toward a target 6u
    // closer to the boss (clamped at boss position). Multi-frame so the
    // player can fight against it (they can't move out of it without dash).
    const pullDist = Math.min(6.0, d);
    const ux = dx / d, uz = dz / d;
    const srcX = hp.x, srcZ = hp.z;
    const tgtX = hp.x - ux * pullDist;
    const tgtZ = hp.z - uz * pullDist;
    _pulls.push({
      startT: state.time.game,
      endT:   state.time.game + 0.4,
      srcX, srcZ, tgtX, tgtZ,
    });

    // Visual: contracting ring becomes an expanding "released" ring for the
    // moment of impact.
    const ring = _makeRingMesh(COL_ENGULF, 1.0);
    ring.position.set(bx, 0.05, bz);
    _scene.add(ring);
    _activeRings.push({ mesh: ring, age: 0, ttl: 0.45, maxRadius: 8.0, type: 'ring' });

    // V2: clean the inner glow ring + emit a release burst — 12 motes
    // flying OUTWARD from boss center (opposite direction of windup motes)
    // so the impact reads as a kinetic release. Cyan, short life.
    if (boss._engulfInner) {
      if (boss._engulfInner.parent) boss._engulfInner.parent.remove(boss._engulfInner);
      boss._engulfInner = null;
    }
    const RELEASE_N = 12;
    for (let i = 0; i < RELEASE_N; i++) {
      const a = (i / RELEASE_N) * Math.PI * 2 + Math.random() * 0.2;
      const dist = 4.5 + Math.random() * 2.0;
      spawnTellMote(
        bx, bz,
        Math.cos(a) * dist, Math.sin(a) * dist,
        0.45,
        0x9eeeff,
        0.50, 1.4,
        0.18,
      );
    }

    state.fx.shake      = Math.max(state.fx.shake || 0, 0.40);
    state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.45);
  },
};

// ── 1. Vexmaw — Sonic Cone ─────────────────────────────────────────────────
const sonicConePattern = {
  id: 'sonic',
  windupColor: COL_SONIC,
  windupDuration: 0.9,
  makeTell(boss) {
    // Lock direction at windup START so the cone doesn't track the hero.
    // Side-step counterplay requires the cone to commit early.
    const bx = boss.mesh.position.x;
    const bz = boss.mesh.position.z;
    const hp = state.hero.pos;
    const dx = hp.x - bx, dz = hp.z - bz;
    const d  = Math.max(0.001, Math.hypot(dx, dz));
    boss._coneDir = { x: dx / d, z: dz / d };

    const cone = _makeConeMesh(COL_SONIC);
    cone.position.set(bx, 0.04, bz);
    cone.scale.set(7.0, 1, 7.0);
    // Rotate cone forward direction (+X local) to face hero. The local
    // forward axis is +X, so rotation.y = -atan2(z, x).
    cone.rotation.y = -Math.atan2(boss._coneDir.z, boss._coneDir.x);
    _scene.add(cone);
    // V2: inner glow cone — smaller, hotter, faster pulse. Sits inside the
    // outer cone so the wedge layers like an actual sonic blast charging up.
    const inner = _makeConeMesh(COL_SONIC);
    inner.position.set(bx, 0.05, bz);
    inner.scale.set(4.5, 1, 4.5);
    inner.rotation.y = cone.rotation.y;
    inner.material.opacity = 0.55;
    _scene.add(inner);
    boss._sonicInner = inner;
    // V2: streak mote accumulator. Motes spawn at cone tip and race BACK
    // toward the boss (charging-up suction beat). Magenta, short life.
    boss._sonicMoteAcc = 0;
    return cone;
  },
  resolve(boss, _state) {
    const bx = boss.mesh.position.x;
    const bz = boss.mesh.position.z;
    const hp = state.hero.pos;
    const dx = hp.x - bx, dz = hp.z - bz;
    const d  = Math.max(0.001, Math.hypot(dx, dz));

    // Cone hit: dot(boss→hero, lockedDir) ≥ cos(45°) AND inside cone radius.
    const cd = boss._coneDir || { x: 1, z: 0 };
    const dot = (dx / d) * cd.x + (dz / d) * cd.z;
    if (d <= 7.0 && dot >= 0.707) {
      heroTakeDamage(22);
    }
    boss._coneDir = null;

    // 0.2s flash pulse — short, sharp, magenta. Cheap reuse of _activeRings
    // pool with the cone geometry preserved by passing it as the mesh.
    const flash = _makeConeMesh(COL_SONIC);
    flash.position.set(bx, 0.05, bz);
    flash.scale.set(7.0, 1, 7.0);
    flash.rotation.y = -Math.atan2(cd.z, cd.x);
    _scene.add(flash);
    _activeRings.push({ mesh: flash, age: 0, ttl: 0.20, maxRadius: 7.0, type: 'cone' });

    // V2: clean inner cone + emit forward-firing burst motes along the cone
    // axis (opposite to the suction direction). 10 motes splayed within
    // the ±45° wedge, blasting outward to ~7u.
    if (boss._sonicInner) {
      if (boss._sonicInner.parent) boss._sonicInner.parent.remove(boss._sonicInner);
      boss._sonicInner = null;
    }
    const baseAng = Math.atan2(cd.z, cd.x);
    const FIRE_N = 10;
    for (let i = 0; i < FIRE_N; i++) {
      const spread = (i / (FIRE_N - 1) - 0.5) * (Math.PI / 2.5);
      const a = baseAng + spread;
      const dist = 5.5 + Math.random() * 1.5;
      spawnTellMote(
        bx, bz,
        Math.cos(a) * dist, Math.sin(a) * dist,
        0.35,
        0xff9ee6,
        0.40, 1.8,
        0.20,
      );
    }

    state.fx.shake      = Math.max(state.fx.shake || 0, 0.30);
    state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.40);
  },
};

// ── 2. Oblidor — Quake Cross ───────────────────────────────────────────────
const QUAKE_DIRS = [
  { ang:  0,                  dx:  1, dz:  0 }, // E
  { ang:  Math.PI / 2,        dx:  0, dz:  1 }, // S
  { ang:  Math.PI,            dx: -1, dz:  0 }, // W
  { ang: -Math.PI / 2,        dx:  0, dz: -1 }, // N
];
const QUAKE_LEN = 6.0;
const QUAKE_HALF_WIDTH = 1.0; // 2u wide → 1u each side

const quakeCrossPattern = {
  id: 'quake',
  windupColor: COL_QUAKE,
  windupDuration: 1.6,
  makeTell(boss) {
    // Build 4 cardinal bars. Stored on boss (NOT _tellRing — that single slot
    // can't hold 4 meshes). Pooled so each resolve cleans them up and the
    // next windup re-builds — Oblidor only telegraphs every 9s so the cost
    // is in the noise.
    const bx = boss.mesh.position.x;
    const bz = boss.mesh.position.z;
    const bars = [];
    for (let i = 0; i < QUAKE_DIRS.length; i++) {
      const d = QUAKE_DIRS[i];
      const bar = _makeQuakeBar(COL_QUAKE, 0.55);
      // Each bar extends QUAKE_LEN from boss center along its cardinal.
      const midX = bx + d.dx * (QUAKE_LEN / 2);
      const midZ = bz + d.dz * (QUAKE_LEN / 2);
      bar.position.set(midX, 0.04, midZ);
      bar.rotation.y = -d.ang; // align bar long-axis with cardinal
      _scene.add(bar);
      bars.push(bar);
    }
    boss._quakeMeshes = bars;
    // V2: debris-dust accumulator. Each tick during windup, sprinkle a few
    // amber motes near the bar edges with small outward-jittered velocity.
    // Sells "ground cracking, dust shaking loose".
    boss._quakeDebrisAcc = 0;
    // Return the first bar as the "tell ring" so the dispatch loop's
    // boss._tellRing cleanup also fires for at least one mesh (we override
    // cleanup below). We return a sentinel object: the dispatcher checks
    // truthiness, and we handle teardown in our own _disposeTell helper.
    return bars[0];
  },
  resolve(boss, _state) {
    const bx = boss.mesh.position.x;
    const bz = boss.mesh.position.z;
    const hp = state.hero.pos;

    // Hit-test: hero inside ANY bar's bbox (local-rotated rectangle).
    // For an axis-aligned cardinal bar, the test is simple: project hero
    // onto the bar's long axis and check both projections vs. (QUAKE_LEN/2,
    // QUAKE_HALF_WIDTH). Safe gaps are the diagonals.
    let hit = false;
    for (let i = 0; i < QUAKE_DIRS.length; i++) {
      const d = QUAKE_DIRS[i];
      // Bar centerline starts at boss, extends QUAKE_LEN along (dx, dz).
      // Hero relative to boss:
      const rx = hp.x - bx, rz = hp.z - bz;
      // Project onto bar long axis (dx, dz) → s ∈ [0, QUAKE_LEN]
      const s = rx * d.dx + rz * d.dz;
      // Perpendicular distance:
      const perpX = rx - s * d.dx;
      const perpZ = rz - s * d.dz;
      const perp = Math.hypot(perpX, perpZ);
      if (s >= 0 && s <= QUAKE_LEN && perp <= QUAKE_HALF_WIDTH) {
        hit = true;
        break;
      }
    }
    if (hit) heroTakeDamage(26);

    // Repurpose the 4 windup bars as the expanding shockwave visuals:
    // brighten + push them into _activeRings for fade-out animation. This
    // avoids re-allocating 4 meshes on resolve (GC-friendly).
    const bars = boss._quakeMeshes || [];
    for (let i = 0; i < bars.length; i++) {
      bars[i].material.opacity = 1.0;
      _activeRings.push({
        mesh: bars[i], age: 0, ttl: 0.55, maxRadius: 1.4,
        type: 'quake', baseScaleX: 1, baseScaleZ: 1,
      });
    }
    boss._quakeMeshes = null;
    boss._tellRing = null; // dispatch loop won't try to remove it twice

    // V2: per-cardinal debris release burst — 3 motes per bar, perpendicular
    // to the bar's long axis (kicks out to the sides as the shockwave hits).
    // Total 12 motes; well under cap.
    for (let i = 0; i < QUAKE_DIRS.length; i++) {
      const d = QUAKE_DIRS[i];
      // Perpendicular axis (right-hand normal of (dx, dz)):
      const px = -d.dz, pz = d.dx;
      for (let s = 0; s < 3; s++) {
        const along = 1.5 + s * 1.8; // along bar length
        const sx = bx + d.dx * along;
        const sz = bz + d.dz * along;
        const side = (Math.random() - 0.5) * 2; // ±perpendicular splash
        spawnTellMote(
          sx, sz,
          px * side * 1.6, pz * side * 1.6,
          0.40,
          0xffd28a,
          0.30, 1.1,
          0.18,
        );
      }
    }

    state.fx.shake      = Math.max(state.fx.shake || 0, 0.55);
    state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.55);
  },
};

export const MINI_BOSS_PATTERNS = [engulfPattern, sonicConePattern, quakeCrossPattern];

// ──────────────────────────────────────────────────────────────────────────
// Per-frame update
// ──────────────────────────────────────────────────────────────────────────
function _pickPatternIdx(boss, t) {
  if (boss.isFinalBoss) {
    // Cycle every 5s — captured at windup START in updateBossTelegraphs so
    // the resolve always matches the tell that was shown.
    return Math.floor(t / 5) % MINI_BOSS_PATTERNS.length;
  }
  const pi = boss._patternIdx != null ? boss._patternIdx : 0;
  return pi % MINI_BOSS_PATTERNS.length;
}

function _disposeTell(boss) {
  // Engulf/Sonic: single mesh in _tellRing.
  if (boss._tellRing) {
    if (boss._tellRing.parent) boss._tellRing.parent.remove(boss._tellRing);
    boss._tellRing = null;
  }
  // V2 inner layers — safety net (patterns clean these on resolve but if a
  // boss dies mid-windup we still need to drop the inner meshes).
  if (boss._engulfInner) {
    if (boss._engulfInner.parent) boss._engulfInner.parent.remove(boss._engulfInner);
    boss._engulfInner = null;
  }
  if (boss._sonicInner) {
    if (boss._sonicInner.parent) boss._sonicInner.parent.remove(boss._sonicInner);
    boss._sonicInner = null;
  }
  // Quake: 4 meshes in _quakeMeshes (only set if a quake was interrupted
  // before resolve — normal resolve transfers them to _activeRings first).
  if (boss._quakeMeshes) {
    for (const m of boss._quakeMeshes) {
      if (m && m.parent) m.parent.remove(m);
    }
    boss._quakeMeshes = null;
  }
}

/**
 * Iter 19 (FX_AUDIT_V2 §198 — "Known caveat"): single-boss telegraph teardown
 * for the death path. If a mini-boss or final-boss dies during its windup
 * (rare — sigilbell stun + heavy DPS), the inner-glow planes / quake bars /
 * tell rings would otherwise leak in scene until resetBossTelegraphs() fires
 * on the next run. Call this from enemies.killEnemy() so disposal happens
 * the moment the boss dies, regardless of which lifecycle stage it was in.
 *
 * Drops every telegraph artifact attached to `e`, returns mid-windup state
 * to idle, and clears the mote accumulators so a respawned/recycled pool
 * mesh doesn't inherit dirty rate counters.
 *
 * Module-level arrays (_activeRings, _pulls, _motes) are NOT keyed by enemy.
 * They contain orphaned animation entries that self-tick to completion via
 * their TTLs in updateBossTelegraphs/_updateBossTellMotes — no per-enemy
 * cleanup is needed there, and removing them would visually cut off
 * shockwaves the player has already seen launch.
 */
export function disposeBossTelegraphs(e) {
  if (!e) return;
  // Drop every mesh artifact (rune ring, inner glows, quake bars).
  _disposeTell(e);
  // Reset windup bookkeeping so a recycled pool object can't appear
  // mid-windup on respawn (_telegraphInit gates this, but belt-and-braces).
  e._windupStart = -1;
  e._activePatternIdx = null;
  e._activeWindup = 0;
  e._coneDir = null;
  // V2 mote accumulators — clear so a recycled mesh doesn't burst-emit
  // motes on its first windup tick from a stale acc value.
  e._engulfMoteAcc = 0;
  e._sonicMoteAcc = 0;
  e._quakeDebrisAcc = 0;
}

function _updateTellMidWindup(boss, pattern, elapsed, t, dt) {
  // Pattern-specific in-windup animation. Keeps the tell readable.
  const k = Math.min(1, elapsed / boss._activeWindup);
  const bx = boss.mesh.position.x;
  const bz = boss.mesh.position.z;

  if (pattern.id === 'engulf') {
    if (!boss._tellRing) return;
    // Contracting outer ring: 6.0 → 1.2 over the windup. Tracks boss position
    // so a moving Grothar still shows where the pull will originate.
    const s = 6.0 - k * 4.8;
    boss._tellRing.scale.set(s, 1, s);
    boss._tellRing.position.x = bx;
    boss._tellRing.position.z = bz;
    boss._tellRing.material.opacity = 0.5 + 0.45 * (0.5 + 0.5 * Math.sin(t * 18));
    // V2: inner glow — faster pulse (9 Hz vs outer 18 Hz half-cycle), grows
    // brighter as the windup nears resolve. Sits at half the outer scale.
    if (boss._engulfInner) {
      const si = (s * 0.45) + 0.2;
      boss._engulfInner.scale.set(si, 1, si);
      boss._engulfInner.position.x = bx;
      boss._engulfInner.position.z = bz;
      boss._engulfInner.material.opacity = 0.35 + 0.55 * k * (0.5 + 0.5 * Math.sin(t * 9));
    }
    // V2: spawn cyan motes spiraling INWARD. Emit ~8 motes/sec during
    // windup, scaled up as resolve approaches (intensity ramp).
    boss._engulfMoteAcc = (boss._engulfMoteAcc || 0) + dt;
    const rate = 0.12 - 0.06 * k; // every 0.12s → 0.06s as windup ends
    while (boss._engulfMoteAcc >= rate) {
      boss._engulfMoteAcc -= rate;
      // Spawn at a random point on the outer ring; mote target = boss center.
      // Add a small tangential offset so the path spirals rather than going
      // dead-straight (sells "drawn in by vortex").
      const a = Math.random() * Math.PI * 2;
      const r = 5.0 + Math.random() * 1.2;
      const sx = bx + Math.cos(a) * r;
      const sz = bz + Math.sin(a) * r;
      // Tangent-biased target = boss + small perpendicular offset
      const tang = (Math.random() - 0.5) * 1.2;
      const px = -Math.sin(a) * tang;
      const pz =  Math.cos(a) * tang;
      const tgtX = bx + px;
      const tgtZ = bz + pz;
      spawnTellMote(
        sx, sz,
        tgtX - sx, tgtZ - sz,
        0.55 + Math.random() * 0.2,
        0x9eeeff,
        0.40, 1.5,
        0.18,
      );
    }
  } else if (pattern.id === 'sonic') {
    if (!boss._tellRing) return;
    // Cone pulses but DOESN'T re-aim — direction was locked at start.
    boss._tellRing.position.x = bx;
    boss._tellRing.position.z = bz;
    const s = 6.0 + k * 1.5;
    boss._tellRing.scale.set(s, 1, s);
    boss._tellRing.material.opacity = 0.55 + 0.4 * (0.5 + 0.5 * Math.sin(t * 26));
    // V2: inner glow — smaller, hotter, breathes faster (13 Hz). Stays
    // anchored on boss.
    if (boss._sonicInner) {
      boss._sonicInner.position.x = bx;
      boss._sonicInner.position.z = bz;
      const si = 4.5 + k * 0.8;
      boss._sonicInner.scale.set(si, 1, si);
      boss._sonicInner.material.opacity = 0.35 + 0.55 * k * (0.5 + 0.5 * Math.sin(t * 13));
    }
    // V2: streak motes — spawn at cone tip / forward radius, race BACK to
    // boss. Sells "shrieker inhaling air before the blast". ~10/sec.
    boss._sonicMoteAcc = (boss._sonicMoteAcc || 0) + dt;
    const rate = 0.10 - 0.04 * k;
    const cd = boss._coneDir || { x: 1, z: 0 };
    const baseAng = Math.atan2(cd.z, cd.x);
    while (boss._sonicMoteAcc >= rate) {
      boss._sonicMoteAcc -= rate;
      const spread = (Math.random() - 0.5) * (Math.PI / 2.5);   // ±36°
      const a = baseAng + spread;
      const r = 5.0 + Math.random() * 1.5;
      const sx = bx + Math.cos(a) * r;
      const sz = bz + Math.sin(a) * r;
      // Velocity points back toward boss; mote head will be at boss-side.
      spawnTellMote(
        sx, sz,
        bx - sx, bz - sz,
        0.35 + Math.random() * 0.15,
        0xff9ee6,
        0.30, 1.6,
        0.22,
      );
    }
  } else if (pattern.id === 'quake') {
    // Pulse all 4 bars in unison. Brighten as resolve approaches so the
    // player feels the "wind up" beat.
    const bars = boss._quakeMeshes || [];
    const op   = 0.45 + 0.5 * k * (0.5 + 0.5 * Math.sin(t * 14));
    for (const bar of bars) bar.material.opacity = op;
    // V2: debris dust along each bar's edge. ~6/sec total (1.5/bar/sec).
    // Each fleck has tiny outward perpendicular velocity. Ramps with k so
    // resolve has the most dust.
    boss._quakeDebrisAcc = (boss._quakeDebrisAcc || 0) + dt;
    const rate = 0.18 - 0.10 * k;
    while (boss._quakeDebrisAcc >= rate) {
      boss._quakeDebrisAcc -= rate;
      const dir = QUAKE_DIRS[Math.floor(Math.random() * QUAKE_DIRS.length)];
      const along = Math.random() * QUAKE_LEN;
      // Pick a side (perpendicular)
      const side = Math.random() < 0.5 ? -1 : 1;
      const px = -dir.dz, pz = dir.dx;
      const sx = bx + dir.dx * along + px * side * (QUAKE_HALF_WIDTH * 0.95);
      const sz = bz + dir.dz * along + pz * side * (QUAKE_HALF_WIDTH * 0.95);
      // Velocity: small kick outward perpendicular to the bar.
      spawnTellMote(
        sx, sz,
        px * side * 0.5, pz * side * 0.5,
        0.45 + Math.random() * 0.2,
        0xffd28a,
        0.22, 0.7,
        0.22,
      );
    }
  }
}

export function updateBossTelegraphs(dt) {
  if (!_scene) return;
  // V2 mote layer: ensure pool exists, then tick all live motes once per
  // frame. Runs even when no boss is in windup so release-burst motes from
  // a recent resolve continue to fly out and fade.
  _ensureMoteInst();
  _updateBossTellMotes(dt);

  const t = state.time.game;
  const active = state.enemies.active;

  // ── Engulf pull tick ────────────────────────────────────────────────
  // Lerp hero each frame across active pulls; remove when finished.
  for (let i = _pulls.length - 1; i >= 0; i--) {
    const p = _pulls[i];
    const dur = p.endT - p.startT;
    const k = (t - p.startT) / dur;
    if (k >= 1) {
      // Final snap to target (cheap; player already mostly there).
      state.hero.pos.x = p.tgtX;
      state.hero.pos.z = p.tgtZ;
      const last = _pulls.length - 1;
      if (i !== last) _pulls[i] = _pulls[last];
      _pulls.pop();
      continue;
    }
    // Ease-out for a "yank then settle" feel.
    const e = 1 - (1 - k) * (1 - k);
    state.hero.pos.x = p.srcX + (p.tgtX - p.srcX) * e;
    state.hero.pos.z = p.srcZ + (p.tgtZ - p.srcZ) * e;
  }

  // ── Expanding shockwave visuals (post-resolve) ──────────────────────
  for (let i = _activeRings.length - 1; i >= 0; i--) {
    const r = _activeRings[i];
    r.age += dt;
    const k = r.age / r.ttl;
    if (k >= 1) {
      if (r.mesh.parent) r.mesh.parent.remove(r.mesh);
      const last = _activeRings.length - 1;
      if (i !== last) _activeRings[i] = _activeRings[last];
      _activeRings.pop();
      continue;
    }
    if (r.type === 'quake') {
      // Bars stretch outward + fade. Length already covers full reach, so
      // we just expand width slightly (impact thud) and dim.
      const w = 1.0 + k * 0.6;
      r.mesh.scale.set(1.0, 1, w);
      r.mesh.material.opacity = 1 - k;
    } else if (r.type === 'cone') {
      // Cone flash: brief brighten, no scale change.
      r.mesh.material.opacity = 1 - k;
    } else {
      // Default expanding ring (Engulf release + legacy shockwave path).
      const s = 0.5 + k * r.maxRadius * 1.3;
      r.mesh.scale.set(s, 1, s);
      r.mesh.material.opacity = 1 - k;
    }
  }

  // ── Per-boss windup / resolve dispatch ──────────────────────────────
  for (let i = 0; i < active.length; i++) {
    const e = active[i];
    if (!e.alive) continue;
    if (!(e.isMiniBoss || e.isFinalBoss)) continue;

    if (!e._telegraphInit) {
      e._telegraphInit = true;
      e._windupStart = -1;
      // Slight delay before the first tell so the spawn banner reads cleanly.
      e._nextTellAt = t + (e.isFinalBoss ? 4.0 : 6.0);
    }

    const interval = e.isFinalBoss ? TELEGRAPH_INTERVAL_FINAL : TELEGRAPH_INTERVAL_MINI;

    if (e._windupStart > 0) {
      // Pattern was captured at windup START — read it here, not _pickPatternIdx
      // (final boss cycles, so the time-based pick can flip mid-windup).
      const pIdx = e._activePatternIdx != null ? e._activePatternIdx : 0;
      const pattern = MINI_BOSS_PATTERNS[pIdx % MINI_BOSS_PATTERNS.length];
      const elapsed = t - e._windupStart;
      if (elapsed >= e._activeWindup) {
        pattern.resolve(e, state);
        // Pattern's resolve clears _tellRing/_quakeMeshes if it repurposes
        // them; this is the safety net.
        _disposeTell(e);
        e._windupStart = -1;
        e._activePatternIdx = null;
        e._activeWindup = 0;
        e._nextTellAt = t + interval;
      } else {
        _updateTellMidWindup(e, pattern, elapsed, t, dt);
      }
      continue;
    }

    if (t >= e._nextTellAt) {
      // Capture pattern + duration AT WINDUP START so the resolve can never
      // mismatch the tell (final-boss cycling makes this load-bearing).
      const pIdx = _pickPatternIdx(e, t);
      const pattern = MINI_BOSS_PATTERNS[pIdx];
      e._activePatternIdx = pIdx;
      e._activeWindup = pattern.windupDuration;
      e._windupStart = t;

      const tell = pattern.makeTell(e);
      // Engulf/Sonic store their single mesh as _tellRing for the dispatch
      // loop's cleanup. Quake stores its 4 meshes in _quakeMeshes (set by
      // makeTell itself); the returned mesh is the first bar as a sentinel.
      if (pattern.id !== 'quake') e._tellRing = tell;
      if (sfx && sfx.bossSpawn) sfx.bossSpawn();
    }
  }
}
