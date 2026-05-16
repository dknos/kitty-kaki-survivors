/**
 * Sap Weaver — Forest special weapon (FE-C1B, Cohort 1 Agent 2).
 *
 * Unlock-gated by `meta.forestWeapons` (Sap Hollow puzzle reward). Auto-fires
 * 3-4 slow sap globs on cooldown; globs stick to the ground and pull nearby
 * enemies on subsequent ticks (tendril effect). When 2+ globs are active,
 * additive ribbon strands stretch between them at the Spider Web FX quality
 * bar (line weight 0.06-0.10, additive, BLOOM_LAYER tagged).
 *
 * Palette (locked from docs/FOREST_VISUAL_STYLE.md):
 *   slot 4 — #7df0c4 bio-glow primary mint  (glob core, tendril ribbon)
 *   slot 7 — #ffd86b amber detonation       (glob pulse on impact)
 *
 * Pool caps:
 *   - 24 globs max (matches WEB_CAP precedent)
 *   - 16 ribbon-strand pairs max (one per adjacent glob link)
 *
 * Hot-path allocation audit: all THREE.* construction happens inside
 * `_ensureMeshes()` (lazy, one-shot) or at module load. The tick / spawn
 * paths reuse module-scope scratch vectors + matrices.
 *
 * Public API: default export only — registered by src/weapons/index.js into
 * the hidden 5th slot when `meta.forestWeapons.includes('sap_weaver')`.
 */
import * as THREE from 'three';
import { state } from '../state.js';
import { damageEnemy, queryRadius } from '../enemies.js';
import { tex } from '../particleTextures.js';
import { sfx } from '../audio.js';
import { BLOOM_LAYER } from '../postfx.js';

// ─── tunables ────────────────────────────────────────────────────────────────
const GLOB_CAP        = 24;          // max simultaneous sap globs
const RIBBON_CAP      = 16;          // max simultaneous tendril strands
const GLOB_Y          = 0.10;        // floor-hover Y for glob disc
const GLOB_BASE_RAD   = 1.2;         // base catch radius for "stuck" enemies
const GLOB_LIFE       = 4.5;         // seconds before glob expires
const GLOB_TICK_DMG   = 18;          // per-tick tendril pull damage
const GLOB_TICK_RATE  = 0.35;        // seconds between tendril pull/damage ticks
const GLOB_PULL_FORCE = 4.5;         // m/s² applied toward glob center
const GLOB_PULL_RANGE_MUL = 2.5;     // pull range = catch radius * this
const RIBBON_MAX_DIST = 7.5;         // strand only forms if globs within this
const RIBBON_SEGMENTS = 10;          // ribbon spine vertex count - 1
const RIBBON_VERTS    = (RIBBON_SEGMENTS + 1) * 2;
const RIBBON_HALF_W   = 0.085;       // mid-band of spec 0.06-0.10 window
const RIBBON_Y        = 0.18;        // ribbon hovers above globs

// Palette literals — both slots are explicitly forest-locked.
const COLOR_GLOB    = 0x7df0c4;      // slot 4 bio-glow primary mint
const COLOR_PULSE   = 0xffd86b;      // slot 7 amber detonation (flash on cast)
const COLOR_RIBBON  = 0x7df0c4;      // slot 4 — tendrils match glob core

// ─── module scratch (zero per-frame alloc) ───────────────────────────────────
const _m4 = new THREE.Matrix4();
const _vPos = new THREE.Vector3();
const _vScale = new THREE.Vector3();
const _flatX = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const _zeroScale = new THREE.Vector3(0, 0, 0);

// ─── module state ────────────────────────────────────────────────────────────
// Each glob slot: { live, x, z, ttl, radius, pulseT, tickAcc }
const _globs = new Array(GLOB_CAP);
// Pre-allocate the slot objects so spawn never allocates {} either.
for (let i = 0; i < GLOB_CAP; i++) {
  _globs[i] = { live: false, x: 0, z: 0, ttl: 0, radius: GLOB_BASE_RAD, pulseT: 0, tickAcc: 0 };
}

// Ribbon slot: { live, ax, az, bx, bz, ttl, phase, mesh, mat, geo, pos }
const _ribbons = new Array(RIBBON_CAP);

let _globMesh = null;     // InstancedMesh of glob discs
let _globMatColorTarget = null; // scratch Color for per-frame tint lerp
let _meshesReady = false;
// Pre-computed source/target color vectors so the per-frame lerp doesn't
// allocate. Set inside _ensureMeshes.
let _globColorIdle = null;
let _globColorPulse = null;

// ─── lazy mesh init (hot-path-safe: only fires once) ─────────────────────────
function _ensureMeshes() {
  if (_meshesReady) return;
  if (!state.scene) return; // scene not built yet (e.g. test harness)

  // Glob disc — pre-rotated PlaneGeometry to lie flat on XZ plane.
  const globGeo = new THREE.PlaneGeometry(1, 1);
  globGeo.rotateX(-Math.PI / 2);
  const globMat = new THREE.MeshBasicMaterial({
    map: tex('glowWhite'),
    color: COLOR_GLOB,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  // Cache a Color we mutate per-frame between COLOR_GLOB (idle) and
  // COLOR_PULSE (amber slot 7, fresh-cast accent) — slot 7 use spec'd in
  // the FE-C1B brief. Module-scope so per-frame paint stays alloc-free.
  _globMatColorTarget = new THREE.Color();
  _globColorIdle  = new THREE.Color(COLOR_GLOB);
  _globColorPulse = new THREE.Color(COLOR_PULSE);
  _globMesh = new THREE.InstancedMesh(globGeo, globMat, GLOB_CAP);
  _globMesh.count = GLOB_CAP;
  _globMesh.frustumCulled = false;
  _globMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _globMesh.layers.enable(BLOOM_LAYER);
  for (let i = 0; i < GLOB_CAP; i++) {
    _m4.compose(_vPos.set(0, -1000, 0), _flatX, _zeroScale);
    _globMesh.setMatrixAt(i, _m4);
  }
  _globMesh.instanceMatrix.needsUpdate = true;
  state.scene.add(_globMesh);

  // Ribbon pool — one persistent mesh per slot, position buffer rewritten
  // each tick. Indices baked once. Matches the chainFx ribbon recipe
  // (Spider Web FX quality bar) but lives module-local so we don't starve
  // the shared chainFx pool (cap=48) with continuous tendril traffic.
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
      color: COLOR_RIBBON,
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
      live: false,
      ax: 0, az: 0, bx: 0, bz: 0,
      ttl: 0,
      phase: 0,
      mesh, mat, geo, pos,
    };
  }

  _meshesReady = true;
}

// ─── glob slot helpers ───────────────────────────────────────────────────────
function _findFreeGlob() {
  for (let i = 0; i < GLOB_CAP; i++) if (!_globs[i].live) return i;
  // All slots live → reuse the oldest (lowest ttl). Keeps pool bounded.
  let oldest = 0, oldestTtl = Infinity;
  for (let i = 0; i < GLOB_CAP; i++) {
    if (_globs[i].ttl < oldestTtl) { oldestTtl = _globs[i].ttl; oldest = i; }
  }
  return oldest;
}

function _writeGlobMatrix(i, g) {
  const fade = Math.min(1, g.ttl / 0.6); // pop on spawn, fade tail
  // Pulse pop when freshly placed: scale spikes 1.3× then settles to 1.0
  // over 0.3s. pulseT decremented in tick. Tint shift not applied (shared
  // material) — additive blending + scale spike carries the impact read.
  const pulseK = Math.max(0, Math.min(1, g.pulseT / 0.3));
  const scale = g.radius * 2 * (1 + 0.30 * pulseK) * fade;
  _vPos.set(g.x, GLOB_Y, g.z);
  _vScale.set(scale, 1, scale);
  _m4.compose(_vPos, _flatX, _vScale);
  _globMesh.setMatrixAt(i, _m4);
}

function _hideGlob(i) {
  _vPos.set(0, -1000, 0);
  _m4.compose(_vPos, _flatX, _zeroScale);
  _globMesh.setMatrixAt(i, _m4);
}

// ─── ribbon helpers ──────────────────────────────────────────────────────────
function _findFreeRibbon() {
  for (let i = 0; i < RIBBON_CAP; i++) if (!_ribbons[i].live) return i;
  return -1;
}

function _writeRibbon(r) {
  // Sap tendril shape: catenary-ish dip between two endpoints, with a per-
  // segment width taper (sin(t·π) — pinches at endpoints). Vertex Y offset
  // is constant (Y up axis); ribbon reads as a flat band from iso camera.
  const ax = r.ax, az = r.az, bx = r.bx, bz = r.bz;
  const dx = bx - ax, dz = bz - az;
  for (let i = 0; i <= RIBBON_SEGMENTS; i++) {
    const t = i / RIBBON_SEGMENTS;
    const taper = Math.sin(t * Math.PI);
    // Gentle catenary droop (Y dips slightly mid-strand) plus low-frequency
    // wobble seeded by phase for an organic "sap dripping" feel.
    const droop = -0.08 * taper;
    const wobble = Math.sin(t * 6.0 + r.phase) * 0.04 * taper;
    const sx = ax + dx * t;
    const sz = az + dz * t;
    const sy = RIBBON_Y + droop + wobble;
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

// Sweep globs pairwise, lease a ribbon for each pair within RIBBON_MAX_DIST.
// O(N²) over a max-24 array is fine; called once per frame from the weapon
// tick. Ribbons left over (no longer matched) are released.
function _refreshRibbons(dt) {
  // Mark all as candidate-free; we'll re-claim during the pass.
  for (let i = 0; i < RIBBON_CAP; i++) {
    if (_ribbons[i].live) { _ribbons[i].live = false; }
  }
  let liveGlobs = 0;
  for (let i = 0; i < GLOB_CAP; i++) if (_globs[i].live) liveGlobs++;
  if (liveGlobs < 2) {
    // Hide everything; nothing to ribbon.
    for (let i = 0; i < RIBBON_CAP; i++) {
      const r = _ribbons[i];
      if (r.mesh.visible) { r.mesh.visible = false; r.mat.opacity = 0; }
    }
    return;
  }
  let usedSlots = 0;
  for (let a = 0; a < GLOB_CAP && usedSlots < RIBBON_CAP; a++) {
    const ga = _globs[a];
    if (!ga.live) continue;
    for (let b = a + 1; b < GLOB_CAP && usedSlots < RIBBON_CAP; b++) {
      const gb = _globs[b];
      if (!gb.live) continue;
      const ddx = gb.x - ga.x;
      const ddz = gb.z - ga.z;
      const d2 = ddx * ddx + ddz * ddz;
      if (d2 > RIBBON_MAX_DIST * RIBBON_MAX_DIST) continue;
      const slot = _findFreeRibbon();
      if (slot === -1) break;
      const r = _ribbons[slot];
      r.live = true;
      r.ax = ga.x; r.az = ga.z;
      r.bx = gb.x; r.bz = gb.z;
      r.phase += dt * 2.4;
      // Opacity scales with proximity: closer pairs read brighter.
      const dist = Math.sqrt(d2);
      const k = 1 - dist / RIBBON_MAX_DIST;
      r.mat.opacity = 0.40 + 0.45 * k;
      r.mesh.visible = true;
      _writeRibbon(r);
      usedSlots++;
    }
  }
  // Hide any that didn't get re-claimed this frame.
  for (let i = 0; i < RIBBON_CAP; i++) {
    const r = _ribbons[i];
    if (!r.live && r.mesh.visible) {
      r.mesh.visible = false;
      r.mat.opacity = 0;
    }
  }
}

// ─── glob spawn ──────────────────────────────────────────────────────────────
// Fire 3-4 globs in a forward arc from the hero. Direction picks the nearest
// enemy if any, else a random ground angle (so the weapon still does
// something during downtime).
function _castGlobs(level, areaMul) {
  _ensureMeshes();
  const hero = state.hero.pos;
  const count = level.globsPerCast;
  // Aim: nearest enemy in range, else random
  let ang;
  let nearestDist = Infinity;
  let nearest = null;
  const cands = state.enemies && state.enemies.active;
  if (cands) {
    for (const e of cands) {
      if (!e || !e.alive || !e.mesh) continue;
      const dx = e.mesh.position.x - hero.x;
      const dz = e.mesh.position.z - hero.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < nearestDist) { nearestDist = d2; nearest = e; }
    }
  }
  if (nearest && nearestDist < 400) {
    ang = Math.atan2(nearest.mesh.position.z - hero.z, nearest.mesh.position.x - hero.x);
  } else {
    ang = Math.random() * Math.PI * 2;
  }
  // Spread the N globs in a small arc + variable forward distance so they
  // form a "splatter" pattern, not a perfect line.
  const baseDist = level.range;
  const spreadRad = 0.55; // ~31° half-arc
  for (let n = 0; n < count; n++) {
    const t = (count === 1) ? 0 : (n / (count - 1) - 0.5) * 2; // -1..+1
    const a = ang + t * spreadRad;
    const r = baseDist * (0.55 + Math.random() * 0.6);
    const tx = hero.x + Math.cos(a) * r;
    const tz = hero.z + Math.sin(a) * r;
    const idx = _findFreeGlob();
    const g = _globs[idx];
    g.live = true;
    g.x = tx;
    g.z = tz;
    g.ttl = GLOB_LIFE;
    g.radius = GLOB_BASE_RAD * areaMul;
    g.pulseT = 0.30;
    g.tickAcc = 0;
  }
  try { sfx.weaponWeb && sfx.weaponWeb(); } catch (_) {}
}

// ─── tendril pull + damage ───────────────────────────────────────────────────
// Per-glob per-tick: pull enemies within `radius * GLOB_PULL_RANGE_MUL`
// toward glob center, and apply GLOB_TICK_DMG to enemies INSIDE the radius.
// Uses queryRadius (spatial-hash backed); falls back to active list.
function _applyTendrils(g, dmgMul, weaponSrc) {
  const pullRange = g.radius * GLOB_PULL_RANGE_MUL;
  const rPull2 = pullRange * pullRange;
  const rDmg2  = g.radius * g.radius;
  let cands = null;
  try { cands = queryRadius({ x: g.x, z: g.z }, pullRange); } catch (_) { cands = null; }
  if (!cands) cands = state.enemies && state.enemies.active;
  if (!cands) return;
  for (const e of cands) {
    if (!e || !e.alive || !e.mesh) continue;
    const dx = g.x - e.mesh.position.x;
    const dz = g.z - e.mesh.position.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > rPull2) continue;
    // Pull: nudge position toward glob center by GLOB_PULL_FORCE * dt.
    // We don't have dt here — pull is sized to the tick interval so each
    // tick yields a "tug" of approximately GLOB_PULL_FORCE * GLOB_TICK_RATE
    // meters. Bosses ignore pull (they have _heavy/_noKnockback flags;
    // we conservatively skip when present).
    if (!e._heavy && !e._noKnockback) {
      const d = Math.sqrt(d2) || 1;
      const nudge = GLOB_PULL_FORCE * GLOB_TICK_RATE / d;
      e.mesh.position.x += dx * nudge;
      e.mesh.position.z += dz * nudge;
    }
    // Damage: only if currently inside the catch radius.
    if (d2 <= rDmg2) {
      try { damageEnemy(e, GLOB_TICK_DMG * dmgMul, weaponSrc); } catch (_) {}
    }
  }
}

// ─── weapon module ───────────────────────────────────────────────────────────
export default {
  id: 'sap_weaver',
  name: 'Sap Weaver',
  desc: 'Lobs sap globs that stick and pull enemies via amber tendrils',
  icon: '🟢',
  // Forest special slot — hidden from level-up card pool (see weapons/index.js
  // weaponChoices filter). Auto-equipped at run start when unlocked.
  hidden: true,
  maxLevel: 8,
  levels: [
    { cooldown: 1.40, globsPerCast: 3, range: 4.0, dmg: 180 },
    { cooldown: 1.35, globsPerCast: 3, range: 4.5, dmg: 195 },
    { cooldown: 1.30, globsPerCast: 4, range: 5.0, dmg: 210 },
    { cooldown: 1.25, globsPerCast: 4, range: 5.5, dmg: 230 },
    { cooldown: 1.20, globsPerCast: 4, range: 6.0, dmg: 255 },
    { cooldown: 1.15, globsPerCast: 4, range: 6.5, dmg: 285 },
    { cooldown: 1.10, globsPerCast: 4, range: 7.0, dmg: 320 },
    { cooldown: 1.00, globsPerCast: 4, range: 7.5, dmg: 365 },
  ],

  init(state, level, inst) { inst.cd = 0.4; },

  tick(state, dt, level, inst) {
    if (inst.cd === undefined) inst.cd = 0;
    _ensureMeshes();
    if (!_meshesReady) return; // scene not ready

    // ── Tick existing globs: ttl, pulse, periodic tendril damage ──
    const dmgMul = (state.hero.statMul && state.hero.statMul.dmg) || 1;
    const areaMul = (state.hero.statMul && state.hero.statMul.area) || 1;
    const baseDmgScale = level.dmg / 180; // scale tick dmg with level's base dmg
    const tickDmgMul = baseDmgScale * dmgMul;
    let dirty = false;
    let maxPulseK = 0;
    for (let i = 0; i < GLOB_CAP; i++) {
      const g = _globs[i];
      if (!g.live) continue;
      g.ttl -= dt;
      g.pulseT -= dt;
      g.tickAcc += dt;
      if (g.ttl <= 0) {
        g.live = false;
        _hideGlob(i);
        dirty = true;
        continue;
      }
      // Damage / pull tick
      while (g.tickAcc >= GLOB_TICK_RATE) {
        g.tickAcc -= GLOB_TICK_RATE;
        _applyTendrils(g, tickDmgMul, 'sap_weaver');
      }
      _writeGlobMatrix(i, g);
      dirty = true;
      const pulseK = Math.max(0, Math.min(1, g.pulseT / 0.3));
      if (pulseK > maxPulseK) maxPulseK = pulseK;
    }
    if (dirty) _globMesh.instanceMatrix.needsUpdate = true;
    // Shared-material tint lerp: when any glob is mid-pulse, accent the
    // shared material toward COLOR_PULSE (slot 7 amber detonation). Returns
    // to COLOR_GLOB (slot 4) when no pulses active. Slightly globally
    // bleeds across older globs — acceptable read for fresh-cast emphasis.
    if (_globMesh && _globMatColorTarget) {
      _globMatColorTarget.copy(_globColorIdle).lerp(_globColorPulse, maxPulseK * 0.55);
      _globMesh.material.color.copy(_globMatColorTarget);
    }

    // ── Refresh tendril ribbons (visual link between adjacent globs) ──
    _refreshRibbons(dt);

    // ── Cooldown / new cast ──
    inst.cd -= dt;
    if (inst.cd > 0) return;
    _castGlobs(level, areaMul);
    inst.cd = level.cooldown
      * ((state.hero.statMul && state.hero.statMul.cooldown) || 1)
      * (state.run.passive_cooldown || 1);
  },

  refresh(state, level, inst) {
    if (inst.cd > level.cooldown * 0.5) inst.cd = level.cooldown * 0.25;
  },
};
