/**
 * Prism Warden — Forest special weapon (FE-C1B, Cohort 1 Agent 2).
 *
 * Unlock-gated by `meta.forestWeapons` (Amber Labyrinth puzzle reward).
 * Sustained crystalline beam: 0.5s warmup once a target enters range, then
 * a continuous beam that bounces off amber clusters (reads from
 * `forestAmber._debugEntities` — live entities count as crystal anchors).
 * Damage ramps +20% per bounce up to 3 bounces. When the source target
 * leaves range or dies, the beam de-spins through a 0.25s tail and stops.
 *
 * Visual contract (matches Spider Web FX quality bar):
 *   - Beam = dedicated persistent ribbon pair (outer + inner additive
 *     ribbons, line weight 0.075/0.030 — inside the 0.06-0.10 spec band).
 *   - One module-local ribbon-mesh PAIR PER BOUNCE SEGMENT (max 4 segments
 *     = source→hit + up to 3 bounces). We do NOT call spawnChainArc —
 *     continuous 60Hz spawns would starve chainFx's 48-slot shared pool.
 *   - Bounce nodes glow as small additive billboards at reflection points.
 *
 * Palette (locked from docs/FOREST_VISUAL_STYLE.md):
 *   slot 8 — #a8e6ff crystal blue (outer ribbon, bounce nodes outer)
 *   slot 4 — #7df0c4 bio-glow mint (inner core ribbon, bounce nodes inner)
 *
 * Pool caps:
 *   - 4 ribbon segments × 2 meshes (outer+inner) = 8 ribbon meshes
 *   - 4 bounce-node billboards (one per segment-end)
 *
 * Hot-path allocation audit: all THREE.* construction is inside
 * `_ensureMeshes()` (lazy one-shot) or module-scope. Per-frame paths reuse
 * scratch vectors and rewrite the same Float32Array position buffers.
 */
import * as THREE from 'three';
import { state } from '../state.js';
import { damageEnemy, queryRadius } from '../enemies.js';
import { tex } from '../particleTextures.js';
import { sfx } from '../audio.js';
import { BLOOM_LAYER } from '../postfx.js';
import { _debugEntities as _amberEntities } from '../forestAmber.js';

// ─── tunables ────────────────────────────────────────────────────────────────
const MAX_BOUNCES        = 3;            // hard cap per spec
const SEGMENTS_PER_BEAM  = 1 + MAX_BOUNCES; // source-segment + per-bounce
const RIBBON_SEGMENTS    = 8;            // ribbon spine subdivisions per segment
const RIBBON_VERTS       = (RIBBON_SEGMENTS + 1) * 2;
const RIBBON_OUTER_R     = 0.090;        // mid-band of spec 0.06-0.10
const RIBBON_INNER_R     = 0.040;        // hot core ribbon half-width
const BEAM_Y             = 0.95;         // beam hovers at chest height
const NODE_SIZE          = 0.55;         // bounce-node billboard side
const NODE_Y             = 0.95;         // bounce nodes at beam height
const TARGET_RANGE       = 14.0;         // beam max reach (single segment)
const BOUNCE_RANGE       = 8.0;          // crystal anchor / next-target search radius
const WARMUP_DURATION    = 0.50;         // seconds before beam starts dealing damage
const COOLDOWN_TAIL      = 0.25;         // seconds to fade beam after target lost
const DPS_BASE           = 30;           // base damage per second
const DAMAGE_TICK_RATE   = 0.10;         // apply DPS in 100ms steps for cheaper checks
const BOUNCE_DAMAGE_MUL  = 1.20;         // +20% per bounce
const NOISE_RATE         = 22.0;         // ribbon flicker frequency (Hz-ish)

// Palette literals — both slots are explicitly forest-locked.
const COLOR_OUTER = 0xa8e6ff;            // slot 8 crystal blue
const COLOR_INNER = 0x7df0c4;            // slot 4 bio-glow mint

// ─── module scratch ──────────────────────────────────────────────────────────
const _m4 = new THREE.Matrix4();
const _vPos = new THREE.Vector3();
const _vScale = new THREE.Vector3();
const _flatX = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const _zeroScale = new THREE.Vector3(0, 0, 0);

// ─── module state ────────────────────────────────────────────────────────────
// One persistent beam (1 instance of this weapon → 1 beam at a time).
const _beam = {
  active: false,
  warmupT: 0,        // 0 → WARMUP_DURATION while ramping in
  tailT: 0,          // 0 → COOLDOWN_TAIL while fading out
  fadeIn: 0,         // 0..1, lerps up during warmup, down during tail
  dmgAcc: 0,         // damage tick accumulator
  // Per-frame: segment list [{ ax, az, bx, bz, dmgMul, hitTarget }, ...]
  segCount: 0,
  segs: new Array(SEGMENTS_PER_BEAM),
  noisePhase: 0,
};
for (let i = 0; i < SEGMENTS_PER_BEAM; i++) {
  _beam.segs[i] = { ax: 0, az: 0, bx: 0, bz: 0, dmgMul: 1, hitTarget: null };
}

// Pool: outer + inner ribbon mesh per segment.
const _segMeshes = new Array(SEGMENTS_PER_BEAM);
let _nodeMesh = null;          // InstancedMesh for bounce-node billboards (4 slots)
let _meshesReady = false;

// ─── lazy mesh init ──────────────────────────────────────────────────────────
function _buildRibbonIndices() {
  const indices = new Uint16Array(RIBBON_SEGMENTS * 6);
  for (let s = 0; s < RIBBON_SEGMENTS; s++) {
    const v0 = s * 2, v1 = v0 + 1, v2 = v0 + 2, v3 = v0 + 3;
    const o = s * 6;
    indices[o + 0] = v0; indices[o + 1] = v1; indices[o + 2] = v2;
    indices[o + 3] = v2; indices[o + 4] = v1; indices[o + 5] = v3;
  }
  return indices;
}

function _buildRibbon(color, opacity, indices) {
  const pos = new Float32Array(RIBBON_VERTS * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.layers.enable(BLOOM_LAYER);
  mesh.visible = false;
  return { mesh, mat, geo, pos };
}

function _ensureMeshes() {
  if (_meshesReady) return;
  if (!state.scene) return;
  const indices = _buildRibbonIndices();
  for (let i = 0; i < SEGMENTS_PER_BEAM; i++) {
    const outer = _buildRibbon(COLOR_OUTER, 0, indices);
    const inner = _buildRibbon(COLOR_INNER, 0, indices);
    state.scene.add(outer.mesh);
    state.scene.add(inner.mesh);
    _segMeshes[i] = { outer, inner };
  }
  // Bounce-node billboards — InstancedMesh of glowWhite quads, additive,
  // BLOOM_LAYER tagged. SEGMENTS_PER_BEAM total slots.
  const nodeGeo = new THREE.PlaneGeometry(NODE_SIZE, NODE_SIZE);
  nodeGeo.rotateX(-Math.PI / 2);
  const nodeMat = new THREE.MeshBasicMaterial({
    map: tex('glowWhite'),
    color: COLOR_OUTER,
    transparent: true,
    opacity: 0.90,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  _nodeMesh = new THREE.InstancedMesh(nodeGeo, nodeMat, SEGMENTS_PER_BEAM);
  _nodeMesh.count = SEGMENTS_PER_BEAM;
  _nodeMesh.frustumCulled = false;
  _nodeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _nodeMesh.layers.enable(BLOOM_LAYER);
  for (let i = 0; i < SEGMENTS_PER_BEAM; i++) {
    _vPos.set(0, -1000, 0);
    _m4.compose(_vPos, _flatX, _zeroScale);
    _nodeMesh.setMatrixAt(i, _m4);
  }
  _nodeMesh.instanceMatrix.needsUpdate = true;
  state.scene.add(_nodeMesh);
  _meshesReady = true;
}

// ─── targeting + bounce path ─────────────────────────────────────────────────
function _findNearest(pos, range) {
  let cands = null;
  try { cands = queryRadius(pos, range); } catch (_) { cands = null; }
  if (!cands || cands.length === 0) cands = state.enemies && state.enemies.active;
  if (!cands) return null;
  let best = null, bestD2 = range * range;
  for (const e of cands) {
    if (!e || !e.alive || !e.mesh) continue;
    const dx = e.mesh.position.x - pos.x;
    const dz = e.mesh.position.z - pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = e; }
  }
  return best;
}

// Find the nearest crystal-anchor point inside `range` of `pos`. Anchors are
// (a) live amber-cluster entities reported by forestAmber, (b) failing that,
// the next nearest enemy (so the beam still bounces in arenas without amber).
// Returns { x, z, target } where `target` is the enemy if we picked one, else
// null (for amber anchors).
function _findBounceAnchor(pos, range, excludeTargets) {
  // 1) Live amber clusters (preferred — matches spec "crystal decor or amber")
  let ambers = null;
  try { ambers = _amberEntities ? _amberEntities() : null; } catch (_) { ambers = null; }
  if (ambers && ambers.length > 0) {
    let bestA = null, bestD2 = range * range;
    for (const a of ambers) {
      if (!a || a.state === 'dead') continue;
      const dx = a.x - pos.x;
      const dz = a.z - pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; bestA = a; }
    }
    if (bestA) return { x: bestA.x, z: bestA.z, target: null };
  }
  // 2) Fallback: next nearest enemy not already in the chain.
  let cands = null;
  try { cands = queryRadius(pos, range); } catch (_) { cands = null; }
  if (!cands || cands.length === 0) cands = state.enemies && state.enemies.active;
  if (!cands) return null;
  let best = null, bestD2e = range * range;
  for (const e of cands) {
    if (!e || !e.alive || !e.mesh) continue;
    if (excludeTargets && excludeTargets.has(e)) continue;
    const dx = e.mesh.position.x - pos.x;
    const dz = e.mesh.position.z - pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2e) { bestD2e = d2; best = e; }
  }
  if (best) return { x: best.mesh.position.x, z: best.mesh.position.z, target: best };
  return null;
}

// Build the segment list for this frame's beam path. Returns the count of
// segments populated in `_beam.segs[]`.
function _buildBeamPath(level) {
  const hero = state.hero.pos;
  const primary = _findNearest(hero, TARGET_RANGE);
  if (!primary) return 0;
  const tp = primary.mesh.position;
  const seen = new Set();
  seen.add(primary);
  const s0 = _beam.segs[0];
  s0.ax = hero.x; s0.az = hero.z;
  s0.bx = tp.x;   s0.bz = tp.z;
  s0.dmgMul = 1;
  s0.hitTarget = primary;
  let count = 1;
  let prevX = tp.x, prevZ = tp.z;
  let mul = 1;
  for (let b = 0; b < MAX_BOUNCES; b++) {
    const next = _findBounceAnchor({ x: prevX, z: prevZ }, BOUNCE_RANGE, seen);
    if (!next) break;
    mul *= BOUNCE_DAMAGE_MUL;
    const seg = _beam.segs[count];
    seg.ax = prevX; seg.az = prevZ;
    seg.bx = next.x; seg.bz = next.z;
    seg.dmgMul = mul;
    seg.hitTarget = next.target; // may be null for amber anchors (no damage applied there)
    count += 1;
    if (next.target) seen.add(next.target);
    prevX = next.x; prevZ = next.z;
  }
  void level;
  return count;
}

// ─── ribbon writer ───────────────────────────────────────────────────────────
// Variable-width additive ribbon, matches the Spider Web FX recipe. Width
// tapers with sin(t·π) for clean pinches at the endpoints (anchored into the
// hero / bounce node visually).
function _writeRibbon(slot, halfWidth, ax, az, bx, bz, phase) {
  const pos = slot.pos;
  const dx = bx - ax;
  const dz = bz - az;
  for (let i = 0; i <= RIBBON_SEGMENTS; i++) {
    const t = i / RIBBON_SEGMENTS;
    const taper = Math.sin(t * Math.PI);
    // Light vertex-noise on width — same recipe as chainFx, cheap two-sin.
    const noise = Math.sin(t * 7.0 + phase) * 0.4 + Math.sin(t * 3.1 + phase * 0.6) * 0.4;
    const w = halfWidth * Math.max(0.55, taper * (0.85 + 0.18 * noise));
    const sx = ax + dx * t;
    const sz = az + dz * t;
    const sy = BEAM_Y;
    const base = i * 6;
    pos[base + 0] = sx;
    pos[base + 1] = sy + w;
    pos[base + 2] = sz;
    pos[base + 3] = sx;
    pos[base + 4] = sy - w;
    pos[base + 5] = sz;
  }
  slot.geo.attributes.position.needsUpdate = true;
}

function _writeNodeMatrix(i, x, z, opacity) {
  // Pulse scale tied to opacity so the node fades in/out smoothly with the beam.
  const scale = Math.max(0.001, opacity);
  _vPos.set(x, NODE_Y, z);
  _vScale.set(scale, 1, scale);
  _m4.compose(_vPos, _flatX, _vScale);
  _nodeMesh.setMatrixAt(i, _m4);
}

function _hideNode(i) {
  _vPos.set(0, -1000, 0);
  _m4.compose(_vPos, _flatX, _zeroScale);
  _nodeMesh.setMatrixAt(i, _m4);
}

function _hideAllSegments() {
  for (let i = 0; i < SEGMENTS_PER_BEAM; i++) {
    const sm = _segMeshes[i];
    if (!sm) continue;
    sm.outer.mesh.visible = false;
    sm.inner.mesh.visible = false;
    sm.outer.mat.opacity = 0;
    sm.inner.mat.opacity = 0;
    _hideNode(i);
  }
  if (_nodeMesh) _nodeMesh.instanceMatrix.needsUpdate = true;
}

// ─── per-frame paint + damage ────────────────────────────────────────────────
function _paintBeam(opacityScale) {
  // Render up to _beam.segCount segments; hide the rest.
  const baseOuterOp = 0.55;
  const baseInnerOp = 1.00;
  for (let i = 0; i < SEGMENTS_PER_BEAM; i++) {
    const sm = _segMeshes[i];
    if (!sm) continue;
    if (i >= _beam.segCount) {
      sm.outer.mesh.visible = false;
      sm.inner.mesh.visible = false;
      sm.outer.mat.opacity = 0;
      sm.inner.mat.opacity = 0;
      _hideNode(i);
      continue;
    }
    const seg = _beam.segs[i];
    _writeRibbon(sm.outer, RIBBON_OUTER_R, seg.ax, seg.az, seg.bx, seg.bz, _beam.noisePhase + i * 0.7);
    _writeRibbon(sm.inner, RIBBON_INNER_R, seg.ax, seg.az, seg.bx, seg.bz, _beam.noisePhase + i * 0.7 + 1.3);
    sm.outer.mesh.visible = true;
    sm.inner.mesh.visible = true;
    sm.outer.mat.opacity = baseOuterOp * opacityScale;
    sm.inner.mat.opacity = baseInnerOp * opacityScale;
    // Bounce node at segment END (so node sits at reflection point, not source)
    _writeNodeMatrix(i, seg.bx, seg.bz, opacityScale);
  }
  if (_nodeMesh) _nodeMesh.instanceMatrix.needsUpdate = true;
}

function _applyDamage(level) {
  // Tick damage at DAMAGE_TICK_RATE: each segment applies (DPS_BASE * dpsMul *
  // seg.dmgMul) damage per second to its endpoint enemy (if any). Damage is
  // applied in discrete tick chunks; tickAcc tracks the residual.
  const dmgMul = (state.hero.statMul && state.hero.statMul.dmg || 1);
  const dpsScale = (level.dps / DPS_BASE) || 1; // each level scales DPS
  // dmg per tick per segment baseline:
  const tickDmgBase = DPS_BASE * dpsScale * dmgMul * DAMAGE_TICK_RATE;
  for (let i = 0; i < _beam.segCount; i++) {
    const seg = _beam.segs[i];
    if (!seg.hitTarget || !seg.hitTarget.alive) continue;
    try { damageEnemy(seg.hitTarget, tickDmgBase * seg.dmgMul, 'prism_warden'); } catch (_) {}
  }
}

// ─── weapon module ───────────────────────────────────────────────────────────
export default {
  id: 'prism_warden',
  name: 'Prism Warden',
  desc: 'Sustained crystal beam — bounces off amber, ramps damage per bounce',
  icon: '🔷',
  hidden: true, // Forest special — never appears in level-up card pool
  maxLevel: 8,
  levels: [
    { cooldown: 0.0, dps: 30  },
    { cooldown: 0.0, dps: 36  },
    { cooldown: 0.0, dps: 44  },
    { cooldown: 0.0, dps: 54  },
    { cooldown: 0.0, dps: 66  },
    { cooldown: 0.0, dps: 80  },
    { cooldown: 0.0, dps: 96  },
    { cooldown: 0.0, dps: 116 },
  ],

  init(state, level, inst) { inst.cd = 0; },

  tick(state, dt, level, inst) {
    _ensureMeshes();
    if (!_meshesReady) return;

    // Build path candidates this frame (we always re-target so beam tracks
    // moving enemies and re-bounces off the current amber set).
    const newCount = _buildBeamPath(level);
    _beam.noisePhase += dt * NOISE_RATE;

    if (newCount > 0) {
      // Beam has a target this frame.
      _beam.segCount = newCount;
      if (!_beam.active) {
        // First frame of acquisition: enter warmup.
        _beam.active = true;
        _beam.warmupT = 0;
        _beam.tailT = 0;
        _beam.dmgAcc = 0;
        try { sfx.weaponChain && sfx.weaponChain(); } catch (_) {}
      }
      _beam.tailT = 0;
      if (_beam.warmupT < WARMUP_DURATION) {
        _beam.warmupT += dt;
        _beam.fadeIn = Math.min(1, _beam.warmupT / WARMUP_DURATION);
      } else {
        _beam.fadeIn = 1;
      }
      // Damage accrual only after warmup completes.
      if (_beam.warmupT >= WARMUP_DURATION) {
        _beam.dmgAcc += dt;
        while (_beam.dmgAcc >= DAMAGE_TICK_RATE) {
          _beam.dmgAcc -= DAMAGE_TICK_RATE;
          _applyDamage(level);
        }
      }
      _paintBeam(_beam.fadeIn);
    } else if (_beam.active) {
      // Target lost: enter tail fade.
      _beam.tailT += dt;
      if (_beam.tailT >= COOLDOWN_TAIL) {
        _beam.active = false;
        _beam.warmupT = 0;
        _beam.fadeIn = 0;
        _beam.segCount = 0;
        _hideAllSegments();
      } else {
        _beam.fadeIn = Math.max(0, 1 - _beam.tailT / COOLDOWN_TAIL);
        _paintBeam(_beam.fadeIn);
      }
    }

    // `inst.cd` is unused (continuous beam — no per-cast gating) but kept
    // present for symmetry with the other weapon contracts.
    if (inst.cd === undefined) inst.cd = 0;
  },

  refresh(state, level, inst) {
    // Continuous beam — `refresh` is a no-op; the weapon picks up the new
    // level's DPS on the next tick.
    void state; void level; void inst;
  },
};
