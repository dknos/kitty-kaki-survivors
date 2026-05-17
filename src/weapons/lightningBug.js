/**
 * Lightning Bug — Forest special weapon (FE-V2 cohort 2, 2026-05-17).
 *
 * Homing electric chain. Every level.cooldown seconds, a tiny glowing bug
 * projectile launches from the hero, homes to the nearest enemy at HOMING_SPD
 * units/sec, hits → spawns a chain arc to the next nearest enemy within
 * level.chainRange, repeating up to level.chains times.
 *
 * Mechanic — hybrid of chain.js (chain arc spawning + falloff) and
 * wisp_lantern.js (orbital billboard sprite + InstancedMesh visual). Distinct
 * from wisp_lantern in that the bug actually TRAVELS through space (homes
 * via velocity vector), while wisps orbit and fire from their orbital pos.
 *   - One bug in flight at a time (BUG_CAP=1). When the bug expires or
 *     completes its chain, the next cooldown spawns a new one.
 *   - Chain arcs reuse spawnChainArc from chainFx (cheap pooled ribbons).
 *
 * Visual contract (Spider Web FX quality bar):
 *   - Bug: tiny SphereGeometry (r=0.15) on an InstancedMesh pool (1 slot,
 *     pre-allocated). slot-7 amber tint + BLOOM_LAYER for glow.
 *   - Chain arcs: spawnChainArc with slot-8 outer / slot-4 inner (matches
 *     wisp_lantern aesthetic so the two forest electric weapons read as
 *     family).
 *
 * Palette substitutions (brief asked for off-palette 0xd9a648 "slot-6 gold";
 * 8-color slot-lock is hard-required, so:
 *   slot 7 amber detonation 0xffd86b  — bug body (brightest sphere)
 *   slot 8 crystal blue     0xa8e6ff  — chain arc outer (matches chain.js)
 *   slot 4 mint             0x7df0c4  — chain arc inner (hot core)
 *
 * Pool caps:
 *   - 1 bug in flight at a time (matches "every 1.8s fires 1 bug")
 *   - chain arcs flow through chainFx shared pool (no module pool)
 *
 * Hot-path allocation: all THREE.* construction in _ensureMeshes (one-shot
 * lazy). Tick reuses module-scope scratch only. Static imports only.
 */
import * as THREE from 'three';
import { state } from '../state.js';
import { damageEnemy, queryRadius } from '../enemies.js';
import { sfx } from '../audio.js';
import { BLOOM_LAYER } from '../postfx.js';
import { spawnChainArc } from '../chainFx.js';

// ─── tunables ────────────────────────────────────────────────────────────────
const BUG_R             = 0.15;         // sphere radius (matches brief)
const BUG_Y             = 0.80;         // hover height
const HOMING_SPD        = 18;           // units/sec (matches brief)
const HIT_RADIUS        = 0.55;         // proximity hit threshold
const BUG_TTL_MAX       = 3.0;          // bug self-destructs after this many s
const ARC_LIFE          = 0.16;
const ARC_OUTER_R       = 0.075;        // mid-band of spec 0.06-0.10
const ARC_INNER_R       = 0.030;

// Palette literals — locked. See header for substitution rationale.
const COLOR_BUG         = 0xffd86b;     // slot 7 amber
const COLOR_ARC_OUTER   = 0xa8e6ff;     // slot 8 crystal blue
const COLOR_ARC_INNER   = 0x7df0c4;     // slot 4 mint

// ─── module scratch ──────────────────────────────────────────────────────────
const _m4 = new THREE.Matrix4();
const _vPos = new THREE.Vector3();
const _vScale = new THREE.Vector3();
const _idQuat = new THREE.Quaternion();
const _zeroScale = new THREE.Vector3(0, 0, 0);

// ─── module state ────────────────────────────────────────────────────────────
// Single bug slot (BUG_CAP=1). Keep an array shape so future expansion is
// straightforward (just bump BUG_CAP + InstancedMesh capacity).
const BUG_CAP = 1;
const _bugs = new Array(BUG_CAP);
for (let i = 0; i < BUG_CAP; i++) {
  _bugs[i] = {
    live: false,
    x: 0, z: 0, ttl: 0,
    target: null,                         // current homing target
    chainsLeft: 0, dmg: 0, range: 0,      // per-cast snapshot of level state
    hit: null,                            // Set<enemy> populated on cast
  };
}

let _bugMesh = null;       // InstancedMesh of bug sphere billboards
let _meshesReady = false;

// ─── lazy mesh init ──────────────────────────────────────────────────────────
function _ensureMeshes() {
  if (_meshesReady) return;
  if (!state.scene) return;
  const geo = new THREE.SphereGeometry(BUG_R, 10, 10);
  const mat = new THREE.MeshBasicMaterial({
    color: COLOR_BUG,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  _bugMesh = new THREE.InstancedMesh(geo, mat, BUG_CAP);
  _bugMesh.count = BUG_CAP;
  _bugMesh.frustumCulled = false;
  _bugMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _bugMesh.layers.enable(BLOOM_LAYER);
  for (let i = 0; i < BUG_CAP; i++) {
    _vPos.set(0, -1000, 0);
    _m4.compose(_vPos, _idQuat, _zeroScale);
    _bugMesh.setMatrixAt(i, _m4);
  }
  _bugMesh.instanceMatrix.needsUpdate = true;
  state.scene.add(_bugMesh);
  _meshesReady = true;
}

// ─── slot helpers ────────────────────────────────────────────────────────────
function _writeBug(i, b) {
  _vPos.set(b.x, BUG_Y, b.z);
  _vScale.set(1, 1, 1);
  _m4.compose(_vPos, _idQuat, _vScale);
  _bugMesh.setMatrixAt(i, _m4);
}

function _hideBug(i) {
  _vPos.set(0, -1000, 0);
  _m4.compose(_vPos, _idQuat, _zeroScale);
  _bugMesh.setMatrixAt(i, _m4);
}

// ─── targeting ───────────────────────────────────────────────────────────────
function _findNearest(pos, range, exclude) {
  let cands = null;
  try { cands = queryRadius(pos, range); } catch (_) { cands = null; }
  if (!cands || cands.length === 0) cands = state.enemies && state.enemies.active;
  if (!cands) return null;
  let best = null, bestD2 = range * range;
  for (const e of cands) {
    if (!e || !e.alive || !e.mesh) continue;
    if (exclude && exclude.has(e)) continue;
    const dx = e.mesh.position.x - pos.x;
    const dz = e.mesh.position.z - pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = e; }
  }
  return best;
}

// ─── launch ──────────────────────────────────────────────────────────────────
function _launch(level, dmgMul) {
  _ensureMeshes();
  if (!_meshesReady) return;
  const hero = state.hero.pos;
  const tgt = _findNearest(hero, 25, null);
  if (!tgt) return false;     // no target → keep cd low so we retry quickly
  const b = _bugs[0];
  b.live = true;
  b.x = hero.x;
  b.z = hero.z;
  b.ttl = BUG_TTL_MAX;
  b.target = tgt;
  b.chainsLeft = level.chains;
  b.dmg = level.dmg * dmgMul;
  b.range = level.chainRange;
  b.hit = new Set();
  _writeBug(0, b);
  return true;
}

// ─── tick advance for the bug ────────────────────────────────────────────────
function _advanceBug(i, dt) {
  const b = _bugs[i];
  if (!b.live) return false;

  // TTL guard.
  b.ttl -= dt;
  if (b.ttl <= 0) {
    b.live = false;
    b.target = null;
    b.hit = null;
    _hideBug(i);
    return true;
  }

  // Re-acquire target if dead/missing.
  if (!b.target || !b.target.alive || !b.target.mesh) {
    const next = _findNearest({ x: b.x, z: b.z }, b.range, b.hit);
    if (!next) {
      // No more targets in range — retire the bug.
      b.live = false;
      b.target = null;
      b.hit = null;
      _hideBug(i);
      return true;
    }
    b.target = next;
  }

  // Home toward target at HOMING_SPD.
  const tp = b.target.mesh.position;
  const dx = tp.x - b.x;
  const dz = tp.z - b.z;
  const dist = Math.hypot(dx, dz) || 1e-6;
  const step = Math.min(HOMING_SPD * dt, dist);
  b.x += (dx / dist) * step;
  b.z += (dz / dist) * step;

  // Hit check.
  if (dist <= HIT_RADIUS + step * 0.5) {
    const struck = b.target;
    try { damageEnemy(struck, b.dmg, 'lightning_bug'); } catch (_) {}
    b.hit.add(struck);
    // Chain arc from old position to struck enemy — cheap pooled ribbon.
    try {
      spawnChainArc(state.scene, { x: b.x, z: b.z }, { x: tp.x, z: tp.z }, {
        outerColor: COLOR_ARC_OUTER,
        innerColor: COLOR_ARC_INNER,
        life: ARC_LIFE,
        segments: 3,
        jitter: 0.14,
        outerRadius: ARC_OUTER_R,
        innerRadius: ARC_INNER_R,
      });
    } catch (_) {}
    // Snap bug to the struck enemy's position so next chain originates here.
    b.x = tp.x;
    b.z = tp.z;
    b.chainsLeft -= 1;
    if (b.chainsLeft <= 0) {
      b.live = false;
      b.target = null;
      b.hit = null;
      _hideBug(i);
      return true;
    }
    // Pick next target inside chain range (excluding already-hit enemies).
    const next = _findNearest({ x: b.x, z: b.z }, b.range, b.hit);
    if (!next) {
      b.live = false;
      b.target = null;
      b.hit = null;
      _hideBug(i);
      return true;
    }
    b.target = next;
  }

  _writeBug(i, b);
  return true;
}

// ─── weapon module ───────────────────────────────────────────────────────────
export default {
  id: 'lightning_bug',
  name: 'Lightning Bug',
  desc: 'A glowing bug hunts your enemies, chaining electricity between them',
  icon: '🪲',
  hidden: true,            // Forest special — never appears in level-up card pool
  maxLevel: 8,
  // Level table — chains 3→7, dmg 8→22, range 6→10u, cooldown 1.8→0.8s.
  levels: [
    { cooldown: 1.80, dmg:  8, chains: 3, chainRange:  6.0 },
    { cooldown: 1.65, dmg: 10, chains: 3, chainRange:  6.6 },
    { cooldown: 1.50, dmg: 12, chains: 4, chainRange:  7.2 },
    { cooldown: 1.35, dmg: 14, chains: 4, chainRange:  7.8 },
    { cooldown: 1.20, dmg: 16, chains: 5, chainRange:  8.4 },
    { cooldown: 1.05, dmg: 18, chains: 5, chainRange:  9.0 },
    { cooldown: 0.90, dmg: 20, chains: 6, chainRange:  9.5 },
    { cooldown: 0.80, dmg: 22, chains: 7, chainRange: 10.0 },
  ],

  init(state, level, inst) {
    inst.cd = 0.6;
    void level;
  },

  tick(state, dt, level, inst) {
    if (inst.cd === undefined) inst.cd = 0;
    _ensureMeshes();
    if (!_meshesReady) return;

    let dirty = false;

    // Advance the live bug (if any). Only one slot in this revision.
    for (let i = 0; i < BUG_CAP; i++) {
      if (_advanceBug(i, dt)) dirty = true;
    }
    if (dirty) _bugMesh.instanceMatrix.needsUpdate = true;

    // Don't launch a new bug while one is still in flight.
    if (_bugs[0].live) return;

    inst.cd -= dt;
    if (inst.cd > 0) return;

    const dmgMul = (state.hero.statMul && state.hero.statMul.dmg) || 1;
    const cdMul  = (state.hero.statMul && state.hero.statMul.cooldown) || 1;
    const fired = _launch(level, dmgMul);
    if (fired) {
      try { sfx.weaponChain && sfx.weaponChain(); } catch (_) {}
      inst.cd = level.cooldown * cdMul * (state.run.passive_cooldown || 1);
    } else {
      // No target — short retry so the next nearby spawn finds us promptly.
      inst.cd = 0.25;
    }
  },

  refresh(state, level, inst) {
    if (inst.cd > level.cooldown * 0.5) inst.cd = level.cooldown * 0.25;
  },
};
