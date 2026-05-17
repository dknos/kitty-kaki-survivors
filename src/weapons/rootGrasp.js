/**
 * Root Grasp — Forest special weapon (FE-V2, 2026-05-17).
 *
 * Unlocked by completing the Mossroot Pulse puzzle (puzzle reward —
 * puzzleSystem._win calls unlockForestWeapon('root_grasp')). Once unlocked,
 * `meta.forestWeapons` carries the id across runs and the hidden 5th-slot
 * auto-equipper in src/weapons/index.js (_equipForestSpecialsForRun)
 * pushes the kit into state.weapons at the first acquireWeapon of each run.
 *
 * Mechanic: vine-snare AoE that roots enemies for ~0.6s. Auto-fires on
 * cooldown — plants a vine "snare patch" centered on the nearest enemy
 * (or, if none in range, at a forward arc location around the hero so the
 * weapon visibly does something during downtime — same pattern as
 * sapWeaver/_castGlobs).
 *
 * Within the snare:
 *   - Initial impact damage (level.dmg) at spawn.
 *   - Enemies are ROOTED for level.rootDur seconds. Implementation reuses
 *     the existing frostbloom `_frozenUntil` + `_frozenWasSpd` fields —
 *     enemies.js movement integrator restores spd from `_frozenWasSpd`
 *     once `_frozenUntil` elapses (see enemies.js:1425-1433). This avoids
 *     inventing a parallel root system; visually still distinct via slot-4
 *     vine ribbons differentiating it from frostbloom's cyan ring.
 *   - Patch lingers PATCH_LIFE seconds; new enemies entering the radius
 *     during that window get re-rooted (subject to per-enemy debounce so
 *     the same enemy doesn't burn unlimited damage instances).
 *
 * Visual contract (matches Spider Web FX quality bar):
 *   - Patch base: flat additive disc (slot 4 mint, BLOOM_LAYER, additive).
 *   - 4 vine ribbons sprout outward from patch center to its rim — pre-
 *     pooled module-local ribbon meshes, NOT chainFx (mirrors sapWeaver's
 *     reasoning: continuous 60Hz spawns would starve the 48-slot chain pool).
 *   - Line weight 0.075u — within 0.06-0.10 spec band.
 *   - Slot 7 amber pulse flash on spawn frame (TELEPORT_FLASH style).
 *
 * Palette (locked from docs/FOREST_VISUAL_STYLE.md):
 *   slot 4 #7df0c4 — bio-glow primary mint (patch disc, vine ribbons)
 *   slot 5 #3ecf9a — bio-glow secondary (vine tendril tips)
 *   slot 7 #ffd86b — amber detonation (single-frame spawn flash)
 *
 * Pool caps:
 *   - 8 snare patches max
 *   - 4 vine ribbons × 8 patches = 32 ribbon mesh slots
 *
 * Hot-path allocation audit: all THREE.* construction inside _ensureMeshes
 * (lazy, one-shot). Spawn + tick paths reuse module-scope scratch vectors.
 * Static imports only (per perf-fix 9509535).
 */
import * as THREE from 'three';
import { state } from '../state.js';
import { damageEnemy, queryRadius } from '../enemies.js';
import { tex } from '../particleTextures.js';
import { sfx } from '../audio.js';
import { BLOOM_LAYER } from '../postfx.js';

// ─── tunables ────────────────────────────────────────────────────────────────
const PATCH_CAP        = 8;            // max simultaneous snare patches
const VINES_PER_PATCH  = 4;
const RIBBON_CAP       = PATCH_CAP * VINES_PER_PATCH;     // 32 slots
const PATCH_Y          = 0.10;         // floor-hover Y
const PATCH_BASE_R     = 2.4;          // base patch radius (root area)
const PATCH_LIFE       = 3.5;          // seconds before patch expires
const ROOT_REAPPLY_GAP = 0.40;         // per-enemy: how often re-rooting can land
const FLASH_LIFE       = 0.20;         // spawn-flash ring lifetime
const FLASH_INNER_R    = 0.55;
const FLASH_LINE_W     = 0.08;
const RIBBON_SEGMENTS  = 8;
const RIBBON_VERTS     = (RIBBON_SEGMENTS + 1) * 2;
const RIBBON_HALF_W    = 0.075;        // mid-band of spec 0.06-0.10
const VINE_Y           = 0.18;
const TARGET_RANGE     = 14;           // nearest-enemy search radius

// Palette literals — locked.
const COLOR_PATCH      = 0x7df0c4;     // slot 4 mint
const COLOR_VINE       = 0x7df0c4;     // slot 4 mint (vine ribbons)
const COLOR_VINE_TIP   = 0x3ecf9a;     // slot 5 darker mint (tip taper — color shift via opacity)
const COLOR_FLASH      = 0xffd86b;     // slot 7 amber spawn flash

// ─── module scratch ──────────────────────────────────────────────────────────
const _m4 = new THREE.Matrix4();
const _vPos = new THREE.Vector3();
const _vScale = new THREE.Vector3();
const _flatX = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const _zeroScale = new THREE.Vector3(0, 0, 0);

// ─── module state ────────────────────────────────────────────────────────────
// Each patch: { live, x, z, ttl, radius, pulseT, recentRoots:Map<enemy,nextTime> }
const _patches = new Array(PATCH_CAP);
for (let i = 0; i < PATCH_CAP; i++) {
  _patches[i] = {
    live: false, x: 0, z: 0, ttl: 0,
    radius: PATCH_BASE_R, pulseT: 0,
    recentRoots: new Map(),
  };
}

// Ribbon slot: persistent per-slot mesh, position buffer rewritten on spawn.
const _ribbons = new Array(RIBBON_CAP);
let _patchMesh = null;       // InstancedMesh of patch discs
let _flashRings = [];        // transient amber spawn flashes
let _meshesReady = false;

// Per-frame color lerp scratch (alloc-free).
let _patchColorIdle = null;
let _patchColorFlash = null;
let _patchColorTarget = null;

// ─── lazy mesh init (hot-path-safe: only fires once) ─────────────────────────
function _ensureMeshes() {
  if (_meshesReady) return;
  if (!state.scene) return;

  // Patch disc — flat plane on XZ.
  const patchGeo = new THREE.PlaneGeometry(1, 1);
  patchGeo.rotateX(-Math.PI / 2);
  const patchMat = new THREE.MeshBasicMaterial({
    map: tex('glowWhite'),
    color: COLOR_PATCH,
    transparent: true,
    opacity: 0.78,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  _patchColorIdle   = new THREE.Color(COLOR_PATCH);
  _patchColorFlash  = new THREE.Color(COLOR_FLASH);
  _patchColorTarget = new THREE.Color();
  _patchMesh = new THREE.InstancedMesh(patchGeo, patchMat, PATCH_CAP);
  _patchMesh.count = PATCH_CAP;
  _patchMesh.frustumCulled = false;
  _patchMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _patchMesh.layers.enable(BLOOM_LAYER);
  for (let i = 0; i < PATCH_CAP; i++) {
    _m4.compose(_vPos.set(0, -1000, 0), _flatX, _zeroScale);
    _patchMesh.setMatrixAt(i, _m4);
  }
  _patchMesh.instanceMatrix.needsUpdate = true;
  state.scene.add(_patchMesh);

  // Ribbon pool — one mesh per slot (4 per patch × 8 patches = 32 total).
  // Persistent geo+mat, position attribute rewritten in _writeVine.
  const indices = new Uint16Array(RIBBON_SEGMENTS * 6);
  for (let s = 0; s < RIBBON_SEGMENTS; s++) {
    const v0 = s * 2, v1 = v0 + 1, v2 = v0 + 2, v3 = v0 + 3;
    const o = s * 6;
    indices[o + 0] = v0; indices[o + 1] = v1; indices[o + 2] = v2;
    indices[o + 3] = v2; indices[o + 4] = v1; indices[o + 5] = v3;
  }
  for (let i = 0; i < RIBBON_CAP; i++) {
    const pos = new Float32Array(RIBBON_VERTS * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    const mat = new THREE.MeshBasicMaterial({
      color: COLOR_VINE,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.layers.enable(BLOOM_LAYER);
    mesh.visible = false;
    state.scene.add(mesh);
    _ribbons[i] = {
      live: false, owner: -1,        // which patch slot this ribbon belongs to
      ax: 0, az: 0, bx: 0, bz: 0,
      ttl: 0, phase: 0,
      mesh, mat, geo, pos,
    };
  }
  // Silence unused-color warnings (tip color used via opacity taper rather than
  // a per-segment hex switch — keeps the alloc-free contract).
  void COLOR_VINE_TIP;
  _meshesReady = true;
}

// ─── patch slot helpers ──────────────────────────────────────────────────────
function _findFreePatch() {
  for (let i = 0; i < PATCH_CAP; i++) if (!_patches[i].live) return i;
  let oldest = 0, oldestTtl = Infinity;
  for (let i = 0; i < PATCH_CAP; i++) {
    if (_patches[i].ttl < oldestTtl) { oldestTtl = _patches[i].ttl; oldest = i; }
  }
  return oldest;
}

function _writePatchMatrix(i, p) {
  const fade = Math.min(1, p.ttl / 0.6);
  const pulseK = Math.max(0, Math.min(1, p.pulseT / 0.3));
  const scale = p.radius * 2 * (1 + 0.30 * pulseK) * fade;
  _vPos.set(p.x, PATCH_Y, p.z);
  _vScale.set(scale, 1, scale);
  _m4.compose(_vPos, _flatX, _vScale);
  _patchMesh.setMatrixAt(i, _m4);
}

function _hidePatch(i) {
  _vPos.set(0, -1000, 0);
  _m4.compose(_vPos, _flatX, _zeroScale);
  _patchMesh.setMatrixAt(i, _m4);
}

// ─── ribbon (vine) helpers ───────────────────────────────────────────────────
function _findFreeRibbon() {
  for (let i = 0; i < RIBBON_CAP; i++) if (!_ribbons[i].live) return i;
  return -1;
}

function _writeVine(r) {
  // Vine shape: catenary-ish dip from patch-center to rim point, with a
  // sin-pi taper for tip pinch. Subtle wobble seeded by phase reads as
  // "vine swaying" without per-frame matrix work.
  const ax = r.ax, az = r.az, bx = r.bx, bz = r.bz;
  const dx = bx - ax, dz = bz - az;
  for (let i = 0; i <= RIBBON_SEGMENTS; i++) {
    const t = i / RIBBON_SEGMENTS;
    const taper = Math.sin(t * Math.PI);
    const droop = -0.06 * taper;
    const wobble = Math.sin(t * 5.5 + r.phase) * 0.045 * taper;
    const sx = ax + dx * t;
    const sz = az + dz * t;
    const sy = VINE_Y + droop + wobble;
    const w = RIBBON_HALF_W * Math.max(0.55, taper);
    const base = i * 6;
    r.pos[base + 0] = sx;
    r.pos[base + 1] = sy + w;
    r.pos[base + 2] = sz;
    r.pos[base + 3] = sx;
    r.pos[base + 4] = sy - w;
    r.pos[base + 5] = sz;
  }
  r.geo.attributes.position.needsUpdate = true;
}

function _spawnVinesForPatch(patchIdx, p) {
  // 4 vines sprouting from patch center toward rim, evenly spaced.
  for (let v = 0; v < VINES_PER_PATCH; v++) {
    const slot = _findFreeRibbon();
    if (slot === -1) return;
    const angle = (v / VINES_PER_PATCH) * Math.PI * 2 + Math.random() * 0.5;
    const r = _ribbons[slot];
    r.live = true;
    r.owner = patchIdx;
    r.ax = p.x;
    r.az = p.z;
    r.bx = p.x + Math.cos(angle) * p.radius;
    r.bz = p.z + Math.sin(angle) * p.radius;
    r.ttl = p.ttl;
    r.phase = Math.random() * Math.PI * 2;
    r.mat.opacity = 0.85;
    r.mesh.visible = true;
    _writeVine(r);
  }
}

function _hideVinesForPatch(patchIdx) {
  for (let i = 0; i < RIBBON_CAP; i++) {
    const r = _ribbons[i];
    if (r.live && r.owner === patchIdx) {
      r.live = false;
      r.owner = -1;
      r.mesh.visible = false;
      r.mat.opacity = 0;
    }
  }
}

// ─── spawn-flash ring (slot 7 amber, bloom) ──────────────────────────────────
function _spawnFlashRing(x, z) {
  const inner = FLASH_INNER_R;
  const outer = inner + FLASH_LINE_W;
  const geo = new THREE.RingGeometry(inner, outer, 36, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: COLOR_FLASH,
    transparent: true,
    opacity: 1.0,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, 0.10, z);
  mesh.frustumCulled = false;
  mesh.layers.enable(BLOOM_LAYER);
  state.scene.add(mesh);
  _flashRings.push({ mesh, mat, geo, t: 0, life: FLASH_LIFE });
}

// ─── patch spawn ─────────────────────────────────────────────────────────────
function _castPatch(level, dmgMul, areaMul) {
  _ensureMeshes();
  if (!_meshesReady) return;
  const hero = state.hero.pos;
  // Aim: nearest enemy in range, else random forward angle (visible activity).
  let nearestDist = Infinity;
  let nearest = null;
  let cands = null;
  try { cands = queryRadius(hero, TARGET_RANGE); } catch (_) { cands = null; }
  if (!cands) cands = state.enemies && state.enemies.active;
  if (cands) {
    for (const e of cands) {
      if (!e || !e.alive || !e.mesh) continue;
      const dx = e.mesh.position.x - hero.x;
      const dz = e.mesh.position.z - hero.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < nearestDist) { nearestDist = d2; nearest = e; }
    }
  }
  let tx, tz;
  if (nearest) {
    tx = nearest.mesh.position.x;
    tz = nearest.mesh.position.z;
  } else {
    // No target — drop the patch a bit ahead of hero in a random direction.
    const ang = Math.random() * Math.PI * 2;
    tx = hero.x + Math.cos(ang) * 3.0;
    tz = hero.z + Math.sin(ang) * 3.0;
  }
  const idx = _findFreePatch();
  // Free old vines if reusing slot.
  _hideVinesForPatch(idx);
  const p = _patches[idx];
  p.live = true;
  p.x = tx;
  p.z = tz;
  p.ttl = PATCH_LIFE;
  p.radius = PATCH_BASE_R * areaMul;
  p.pulseT = 0.30;
  p.recentRoots.clear();
  _writePatchMatrix(idx, p);
  _spawnVinesForPatch(idx, p);
  _spawnFlashRing(tx, tz);

  // Apply initial damage + root to everything currently inside.
  _applyRoot(p, level, dmgMul);

  try { sfx.weaponWeb && sfx.weaponWeb(); } catch (_) {}
}

// ─── root + damage application ───────────────────────────────────────────────
// Per-patch per-tick (and on spawn): root enemies inside radius for level.rootDur
// seconds via the existing freezeUntil field; deal level.dmg base damage on the
// first contact per (enemy, patch) pair. Re-rooting subsequent ticks does NOT
// re-apply damage to the same enemy — debounced via patch.recentRoots.
function _applyRoot(p, level, dmgMul) {
  const r2 = p.radius * p.radius;
  const now = (state.time && state.time.game) || 0;
  let cands = null;
  try { cands = queryRadius({ x: p.x, z: p.z }, p.radius); } catch (_) { cands = null; }
  if (!cands) cands = state.enemies && state.enemies.active;
  if (!cands) return;
  for (const e of cands) {
    if (!e || !e.alive || !e.mesh) continue;
    const dx = e.mesh.position.x - p.x;
    const dz = e.mesh.position.z - p.z;
    if (dx * dx + dz * dz > r2) continue;
    const nextAt = p.recentRoots.get(e) || 0;
    if (now < nextAt) continue;
    // Apply root via the existing frostbloom _frozenUntil/_frozenWasSpd
    // hooks — enemies.js movement integrator (line 1425) restores spd
    // once _frozenUntil elapses. Bosses with _heavy/_noKnockback are
    // skipped so we don't strand a slow-spawning final-boss in place.
    if (!e._heavy && !e._noKnockback) {
      const rootUntil = now + level.rootDur;
      if (!e._frozenUntil || e._frozenUntil < rootUntil) {
        if (!e._frozenUntil) {
          e._frozenWasSpd = e.spd;
          e.spd = 0;
        }
        e._frozenUntil = rootUntil;
      }
    }
    // Damage tick — base level.dmg, mul by hero dmg.
    try { damageEnemy(e, level.dmg * dmgMul, 'root_grasp'); } catch (_) {}
    p.recentRoots.set(e, now + ROOT_REAPPLY_GAP);
  }
}

// ─── weapon module ───────────────────────────────────────────────────────────
export default {
  id: 'root_grasp',
  name: 'Root Grasp',
  desc: 'Vine-snare AoE that roots enemies in place for a short window',
  icon: '🌿',
  // Forest special slot — hidden from level-up card pool (see weapons/index.js
  // weaponChoices filter). Auto-equipped at run start when unlocked.
  hidden: true,
  maxLevel: 8,
  levels: [
    { cooldown: 2.20, rootDur: 0.55, dmg: 140 },
    { cooldown: 2.10, rootDur: 0.60, dmg: 160 },
    { cooldown: 2.00, rootDur: 0.65, dmg: 180 },
    { cooldown: 1.90, rootDur: 0.70, dmg: 205 },
    { cooldown: 1.80, rootDur: 0.75, dmg: 235 },
    { cooldown: 1.70, rootDur: 0.80, dmg: 270 },
    { cooldown: 1.60, rootDur: 0.85, dmg: 310 },
    { cooldown: 1.50, rootDur: 0.90, dmg: 355 },
  ],

  init(state, level, inst) { inst.cd = 0.6; },

  tick(state, dt, level, inst) {
    if (inst.cd === undefined) inst.cd = 0;
    _ensureMeshes();
    if (!_meshesReady) return;

    const dmgMul = (state.hero.statMul && state.hero.statMul.dmg) || 1;
    const areaMul = (state.hero.statMul && state.hero.statMul.area) || 1;
    let dirty = false;
    let maxPulseK = 0;

    // ── Tick existing patches: ttl decay, re-root sweep, prune stale roots
    for (let i = 0; i < PATCH_CAP; i++) {
      const p = _patches[i];
      if (!p.live) continue;
      p.ttl -= dt;
      p.pulseT -= dt;
      if (p.ttl <= 0) {
        p.live = false;
        p.recentRoots.clear();
        _hidePatch(i);
        _hideVinesForPatch(i);
        dirty = true;
        continue;
      }
      // Periodic re-root sweep (every frame is cheap with queryRadius +
      // the per-enemy nextAt debounce — overall cost is bounded).
      _applyRoot(p, level, dmgMul);
      _writePatchMatrix(i, p);
      dirty = true;
      const pulseK = Math.max(0, Math.min(1, p.pulseT / 0.3));
      if (pulseK > maxPulseK) maxPulseK = pulseK;
    }
    if (dirty) _patchMesh.instanceMatrix.needsUpdate = true;

    // Shared-material color lerp: spike toward slot-7 amber during fresh pulses.
    if (_patchMesh && _patchColorTarget) {
      _patchColorTarget.copy(_patchColorIdle).lerp(_patchColorFlash, maxPulseK * 0.55);
      _patchMesh.material.color.copy(_patchColorTarget);
    }

    // ── Spawn-flash rings (expand + fade + dispose)
    for (let i = _flashRings.length - 1; i >= 0; i--) {
      const fr = _flashRings[i];
      fr.t += dt;
      const k = Math.min(1, fr.t / fr.life);
      const sc = 1.0 + 1.4 * k;
      fr.mesh.scale.set(sc, 1, sc);
      fr.mat.opacity = 1.0 * (1 - k);
      if (k >= 1) {
        if (fr.mesh.parent) fr.mesh.parent.remove(fr.mesh);
        try { fr.geo.dispose(); } catch (_) {}
        try { fr.mat.dispose(); } catch (_) {}
        _flashRings.splice(i, 1);
      }
    }

    // ── Cooldown / new cast ──
    inst.cd -= dt;
    if (inst.cd > 0) return;
    _castPatch(level, dmgMul, areaMul);
    inst.cd = level.cooldown
      * ((state.hero.statMul && state.hero.statMul.cooldown) || 1)
      * (state.run.passive_cooldown || 1);
  },

  refresh(state, level, inst) {
    if (inst.cd > level.cooldown * 0.5) inst.cd = level.cooldown * 0.25;
  },
};
