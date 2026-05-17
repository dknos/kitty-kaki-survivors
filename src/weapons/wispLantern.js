/**
 * Wisp Lantern — Forest special weapon (FE-V2, 2026-05-17).
 *
 * Glowfen Marshes "relic" weapon. Scaffolding only in v0.2: REGISTRY-ready
 * and FOREST_SPECIAL_IDS-equipped, but Glowfen ships WITHOUT a puzzle in
 * v0.2, so nothing currently calls unlockForestWeapon('wisp_lantern'). A
 * future ticket wires the unlock (likely a "decode the wisp pattern"
 * puzzle per the task brief). Once meta.forestWeapons contains the id,
 * the existing _equipForestSpecialsForRun() autoflow takes over — no
 * additional wiring needed here.
 *
 * Mechanic: 1-3 orbiting wisp orbs auto-lock onto the closest enemy at a
 * fixed cadence. Each lock fires a homing additive ribbon arc from the
 * wisp to the target for `damage` per shot. Lock cadence shortens with
 * level (0.8s @ Lv1 → 0.45s @ Lv8). Orbital radius + count both scale up
 * with level.
 *
 * Wisp count progression (matches task brief: "3 wisps at max level"):
 *   Lv1-Lv2: 1 wisp
 *   Lv3-Lv5: 2 wisps
 *   Lv6-Lv8: 3 wisps
 *
 * Visual contract (matches Spider Web FX quality bar):
 *   - Wisps: pre-pooled InstancedMesh of additive billboards (slot-4 mint),
 *     orbital position recomputed each frame from a shared phase counter.
 *   - Homing arcs: chainFx (spawnChainArc) for cheap pooled ribbons. Lock
 *     cadence is slow enough (≥0.45s per wisp) that the 48-slot chainFx
 *     pool isn't starved even at 3 wisps × 1/0.45s/wisp ≈ 6.7 arcs/sec.
 *
 * Palette (locked from docs/FOREST_VISUAL_STYLE.md):
 *   slot 4 #7df0c4 — wisp orb body + homing arc inner
 *   slot 8 #a8e6ff — homing arc outer (crystal blue chain-lightning)
 *
 * Pool caps:
 *   - 3 wisp instances (InstancedMesh capacity)
 *   - homing arcs flow through chainFx shared pool (no module pool)
 *
 * Hot-path allocation: all THREE.* construction in _ensureMeshes (one-shot
 * lazy). Tick reuses module-scope scratch vectors only. Static imports only.
 */
import * as THREE from 'three';
import { state } from '../state.js';
import { damageEnemy, queryRadius } from '../enemies.js';
import { tex } from '../particleTextures.js';
import { sfx } from '../audio.js';
import { BLOOM_LAYER } from '../postfx.js';
import { spawnChainArc } from '../chainFx.js';

// ─── tunables ────────────────────────────────────────────────────────────────
const MAX_WISPS         = 3;            // hard cap (matches task brief)
const WISP_SIZE         = 0.42;         // billboard side length
const WISP_Y            = 0.95;         // hero-chest height
const WISP_BASE_R       = 1.65;         // base orbit radius around hero
const WISP_ORBIT_HZ     = 0.55;         // orbit speed (rad/sec scaled by 2π)
const WISP_BOB_HZ       = 0.40;         // slow Y bob — matches task brief "slow bobbing"
const WISP_BOB_AMP      = 0.18;         // Y bob amplitude (modest, doesn't break lock geometry)
const LOCK_RANGE        = 12;           // wisp target acquisition radius
const ARC_LIFE          = 0.16;
const ARC_OUTER_R       = 0.075;        // mid-band of spec 0.06-0.10
const ARC_INNER_R       = 0.030;

// Palette literals — locked.
const COLOR_WISP        = 0x7df0c4;     // slot 4 mint
const COLOR_ARC_OUTER   = 0xa8e6ff;     // slot 8 crystal blue
const COLOR_ARC_INNER   = 0x7df0c4;     // slot 4 mint (hot core)

// ─── module scratch ──────────────────────────────────────────────────────────
const _m4 = new THREE.Matrix4();
const _vPos = new THREE.Vector3();
const _vScale = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _eu = new THREE.Euler();
const _zeroScale = new THREE.Vector3(0, 0, 0);
const _flatX = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));

// ─── module state ────────────────────────────────────────────────────────────
// Per-wisp slot: { active, lockCd, phaseOffset } — position derived from
// shared orbit phase + offset each tick (alloc-free).
const _wisps = new Array(MAX_WISPS);
for (let i = 0; i < MAX_WISPS; i++) {
  _wisps[i] = { active: false, lockCd: 0, phaseOffset: (i / MAX_WISPS) * Math.PI * 2 };
}

let _wispMesh = null;       // InstancedMesh of wisp billboards
let _orbitPhase = 0;
let _meshesReady = false;

// ─── lazy mesh init ──────────────────────────────────────────────────────────
function _ensureMeshes() {
  if (_meshesReady) return;
  if (!state.scene) return;
  const geo = new THREE.PlaneGeometry(WISP_SIZE, WISP_SIZE);
  const mat = new THREE.MeshBasicMaterial({
    map: tex('glowWhite'),
    color: COLOR_WISP,
    transparent: true,
    opacity: 0.92,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  _wispMesh = new THREE.InstancedMesh(geo, mat, MAX_WISPS);
  _wispMesh.count = MAX_WISPS;
  _wispMesh.frustumCulled = false;
  _wispMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _wispMesh.layers.enable(BLOOM_LAYER);
  for (let i = 0; i < MAX_WISPS; i++) {
    _vPos.set(0, -1000, 0);
    _m4.compose(_vPos, _flatX, _zeroScale);
    _wispMesh.setMatrixAt(i, _m4);
  }
  _wispMesh.instanceMatrix.needsUpdate = true;
  state.scene.add(_wispMesh);
  _meshesReady = true;
}

// ─── targeting ───────────────────────────────────────────────────────────────
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

// ─── homing fire ─────────────────────────────────────────────────────────────
function _fireHoming(wx, wz, target, dmg) {
  const tp = target.mesh.position;
  spawnChainArc(state.scene, { x: wx, z: wz }, { x: tp.x, z: tp.z }, {
    outerColor: COLOR_ARC_OUTER,
    innerColor: COLOR_ARC_INNER,
    life: ARC_LIFE,
    segments: 3,
    jitter: 0.14,
    outerRadius: ARC_OUTER_R,
    innerRadius: ARC_INNER_R,
  });
  try { damageEnemy(target, dmg, 'wisp_lantern'); } catch (_) {}
}

// ─── weapon module ───────────────────────────────────────────────────────────
export default {
  id: 'wisp_lantern',
  name: 'Wisp Lantern',
  desc: 'Orbiting wisps auto-lock the closest enemy on a fixed cadence',
  icon: '🔮',
  hidden: true, // Forest special — never appears in level-up card pool
  maxLevel: 8,
  // Level table: wisp count, lock cadence, per-shot damage, orbit radius
  // multiplier. Cooldown isn't directly used (autofire is cadence-driven
  // per-wisp), but we include it for tooltip/stat-row symmetry with sap_weaver.
  levels: [
    { cooldown: 0.80, wisps: 1, cadence: 0.80, dmg:  18, radiusMul: 1.00 },
    { cooldown: 0.75, wisps: 1, cadence: 0.75, dmg:  22, radiusMul: 1.05 },
    { cooldown: 0.70, wisps: 2, cadence: 0.70, dmg:  26, radiusMul: 1.10 },
    { cooldown: 0.65, wisps: 2, cadence: 0.65, dmg:  31, radiusMul: 1.15 },
    { cooldown: 0.60, wisps: 2, cadence: 0.60, dmg:  37, radiusMul: 1.20 },
    { cooldown: 0.55, wisps: 3, cadence: 0.55, dmg:  44, radiusMul: 1.25 },
    { cooldown: 0.50, wisps: 3, cadence: 0.50, dmg:  52, radiusMul: 1.30 },
    { cooldown: 0.45, wisps: 3, cadence: 0.45, dmg:  62, radiusMul: 1.35 },
  ],

  init(state, level, inst) {
    // No per-instance state — wisp slots live on the module-scope _wisps[]
    // pool. inst stays {} so the rest of the weapon lifecycle (refresh) can
    // still attach state if a future revision needs it.
    void state; void level; void inst;
  },

  tick(state, dt, level, inst) {
    _ensureMeshes();
    if (!_meshesReady) return;
    const hero = state.hero && state.hero.pos;
    if (!hero) return;

    // Advance shared orbit phase. WISP_ORBIT_HZ at 2π converts to rad/sec.
    _orbitPhase += dt * Math.PI * 2 * WISP_ORBIT_HZ;
    const orbitR = WISP_BASE_R * level.radiusMul;
    const dmgMul = (state.hero.statMul && state.hero.statMul.dmg) || 1;
    const cdMul  = (state.hero.statMul && state.hero.statMul.cooldown) || 1;
    const cadenceScaled = level.cadence * cdMul * (state.run.passive_cooldown || 1);

    // Per-wisp: position update + lock cooldown tick.
    let dirty = false;
    for (let i = 0; i < MAX_WISPS; i++) {
      const w = _wisps[i];
      // Activate based on current level's wisp count.
      const shouldBeActive = (i < level.wisps);
      if (shouldBeActive !== w.active) {
        w.active = shouldBeActive;
        if (!w.active) {
          // Park inactive wisp far below scene.
          _vPos.set(0, -1000, 0);
          _m4.compose(_vPos, _flatX, _zeroScale);
          _wispMesh.setMatrixAt(i, _m4);
          dirty = true;
          continue;
        } else {
          // Spawn-flash visible — reset its lock cooldown so it doesn't
          // immediately fire on activation.
          w.lockCd = cadenceScaled * 0.5;
        }
      }
      if (!w.active) continue;

      // Position from shared phase + per-wisp offset.
      const ang = _orbitPhase + w.phaseOffset;
      const wx = hero.x + Math.cos(ang) * orbitR;
      const wz = hero.z + Math.sin(ang) * orbitR;
      // Slow Y bob keyed off shared orbit phase (per-wisp offset desyncs
      // the bob so 3 wisps don't pulse in lockstep). Visual-only — the
      // lock geometry uses (wx, wz) so the homing arc still resolves cleanly.
      const wy = WISP_Y + Math.sin(_orbitPhase * (WISP_BOB_HZ / WISP_ORBIT_HZ) + w.phaseOffset) * WISP_BOB_AMP;
      _vPos.set(wx, wy, wz);
      // Face camera-ish — rotate billboard around Y by -ang so additive
      // bloom reads consistent under iso camera. (PlaneGeometry default
      // faces +Z; flipping with -ang keeps the brightest face outward.)
      _eu.set(0, -ang, 0);
      _q.setFromEuler(_eu);
      _vScale.set(1, 1, 1);
      _m4.compose(_vPos, _q, _vScale);
      _wispMesh.setMatrixAt(i, _m4);
      dirty = true;

      // Lock cadence: scan and fire when cooldown elapses.
      w.lockCd -= dt;
      if (w.lockCd <= 0) {
        const tgt = _findNearest({ x: wx, z: wz }, LOCK_RANGE);
        if (tgt) {
          _fireHoming(wx, wz, tgt, level.dmg * dmgMul);
          // Subtle chime — reuse existing weaponChain SFX (mint/cyan family
          // pairs aurally with chain-lightning kit).
          try { sfx.weaponChain && sfx.weaponChain(); } catch (_) {}
        }
        w.lockCd = cadenceScaled;
      }
    }
    if (dirty) _wispMesh.instanceMatrix.needsUpdate = true;
    void inst;  // inst unused for this weapon (state lives on _wisps[])
  },

  refresh(state, level, inst) {
    // Shave any in-flight cooldowns on level-up so the player sees an
    // immediate fire after the choice — matches sap_weaver/choir_lance UX.
    for (const w of _wisps) {
      if (w.lockCd > level.cadence * 0.5) w.lockCd = level.cadence * 0.25;
    }
    void inst;
  },
};
