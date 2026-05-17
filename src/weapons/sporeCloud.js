/**
 * Spore Cloud — Forest special weapon (FE-V2 cohort 2, 2026-05-17).
 *
 * Passive AoE drift. Every level.interval seconds, emits a spore cloud
 * centered on the hero that expands from a small disc to its full radius
 * over 1.5s, ticking damage + slow against any enemy that touches it.
 *
 * Mechanic — distinct from root_grasp (single targeted snare patch with
 * full-stop root) and frostbloom (single instantaneous freeze ring):
 *   - Multiple living clouds at once (CLOUD_CAP=6). Each cloud lives 1.5s
 *     and expands radially during that window.
 *   - Per-frame "touch" check: enemies inside any live cloud accumulate a
 *     DoT tick via the existing _dotDps/_dotUntil channel and get briefly
 *     slowed via the _frozenUntil / _frozenWasSpd hooks (using a partial
 *     speed multiplier rather than 0 — see "slow contract" below).
 *   - Slow contract: we reuse frostbloom's _frozenWasSpd backup/restore
 *     pattern but write `e.spd = e._frozenWasSpd * (1 - slowPct)` instead
 *     of zero. Only applied if not already frozen (no double-stomp on
 *     _frozenWasSpd). enemies.js movement integrator restores the original
 *     spd once _frozenUntil elapses (same code path as frostbloom). This
 *     keeps the slow within the existing file boundary (no enemies.js edit)
 *     while staying distinct from frostbloom's full-freeze visual.
 *
 * Visual contract (Spider Web FX quality bar):
 *   - Pre-pooled InstancedMesh of additive billboard rings (CLOUD_CAP=6).
 *   - Pollen sprite (canvas-procedural — see particleTextures.js _makePollen),
 *     tinted with slot-4 mint so the cloud reads bio-luminescent.
 *   - BLOOM_LAYER tagged for soft halo.
 *   - Expansion + opacity-fade ease so each pulse has weight (not a flat
 *     pop-out).
 *
 * Palette substitutions (brief asked for off-palette 0x4a7a4a "forest green";
 * 8-color slot-lock is hard-required by CLAUDE.md, so:
 *   slot 4 mint     0x7df0c4  — cloud body (idle)
 *   slot 5 deep     0x3ecf9a  — cloud rim (gradient pulse via opacity drift)
 *
 * Pool caps:
 *   - 6 live spore clouds max (InstancedMesh capacity).
 *
 * Hot-path allocation: all THREE.* construction in _ensureMeshes (one-shot
 * lazy). Tick reuses module-scope scratch only. Static imports only.
 */
import * as THREE from 'three';
import { state } from '../state.js';
import { damageEnemy, queryRadius } from '../enemies.js';
import { tex } from '../particleTextures.js';
import { sfx } from '../audio.js';
import { BLOOM_LAYER } from '../postfx.js';

// ─── tunables ────────────────────────────────────────────────────────────────
const CLOUD_CAP        = 6;            // max simultaneous spore clouds
const CLOUD_Y          = 0.40;         // hover height (knee level — drifts)
const CLOUD_LIFE       = 1.5;          // seconds: spawn → max radius → fade
const CLOUD_START_R    = 2.5;          // start radius (matches brief)
const SLOW_REAPPLY_GAP = 0.50;         // per-enemy: how often to re-stamp slow
const TICK_INTERVAL    = 0.5;          // seconds: damage tick cadence per enemy

// Palette literals — locked. See header for substitution rationale.
const COLOR_CLOUD      = 0x7df0c4;     // slot 4 mint

// ─── module scratch ──────────────────────────────────────────────────────────
const _m4 = new THREE.Matrix4();
const _vPos = new THREE.Vector3();
const _vScale = new THREE.Vector3();
const _flatX = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const _zeroScale = new THREE.Vector3(0, 0, 0);

// ─── module state ────────────────────────────────────────────────────────────
// Each cloud slot: { live, x, z, age, startR, maxR, recentTicks:Map<enemy,nextTime> }
const _clouds = new Array(CLOUD_CAP);
for (let i = 0; i < CLOUD_CAP; i++) {
  _clouds[i] = {
    live: false, x: 0, z: 0, age: 0,
    startR: CLOUD_START_R, maxR: CLOUD_START_R,
    recentTicks: new Map(),
  };
}

let _cloudMesh = null;       // InstancedMesh of cloud billboards
let _cloudMat  = null;       // shared material (alpha tweened collectively)
let _meshesReady = false;

// ─── lazy mesh init ──────────────────────────────────────────────────────────
function _ensureMeshes() {
  if (_meshesReady) return;
  if (!state.scene) return;
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  _cloudMat = new THREE.MeshBasicMaterial({
    map: tex('pollen') || tex('glowWhite'),
    color: COLOR_CLOUD,
    transparent: true,
    opacity: 0.65,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  _cloudMesh = new THREE.InstancedMesh(geo, _cloudMat, CLOUD_CAP);
  _cloudMesh.count = CLOUD_CAP;
  _cloudMesh.frustumCulled = false;
  _cloudMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _cloudMesh.layers.enable(BLOOM_LAYER);
  for (let i = 0; i < CLOUD_CAP; i++) {
    _m4.compose(_vPos.set(0, -1000, 0), _flatX, _zeroScale);
    _cloudMesh.setMatrixAt(i, _m4);
  }
  _cloudMesh.instanceMatrix.needsUpdate = true;
  state.scene.add(_cloudMesh);
  _meshesReady = true;
}

// ─── slot helpers ────────────────────────────────────────────────────────────
function _findFreeCloud() {
  for (let i = 0; i < CLOUD_CAP; i++) if (!_clouds[i].live) return i;
  // None free — recycle the oldest (largest age).
  let oldest = 0, oldestAge = -1;
  for (let i = 0; i < CLOUD_CAP; i++) {
    if (_clouds[i].age > oldestAge) { oldestAge = _clouds[i].age; oldest = i; }
  }
  return oldest;
}

function _writeCloudMatrix(i, c) {
  // Lifetime t∈[0,1]. Smooth-step expansion + cubic opacity fade-out.
  const t = Math.min(1, c.age / CLOUD_LIFE);
  const expand = 0.30 + 0.70 * t;
  const r = c.startR + (c.maxR - c.startR) * expand;
  _vPos.set(c.x, CLOUD_Y, c.z);
  _vScale.set(r * 2, 1, r * 2);
  _m4.compose(_vPos, _flatX, _vScale);
  _cloudMesh.setMatrixAt(i, _m4);
}

function _hideCloud(i) {
  _m4.compose(_vPos.set(0, -1000, 0), _flatX, _zeroScale);
  _cloudMesh.setMatrixAt(i, _m4);
}

// ─── spawn ───────────────────────────────────────────────────────────────────
function _emitCloud(level, areaMul) {
  _ensureMeshes();
  if (!_meshesReady) return;
  const hero = state.hero.pos;
  const idx = _findFreeCloud();
  const c = _clouds[idx];
  c.live = true;
  c.x = hero.x;
  c.z = hero.z;
  c.age = 0;
  c.startR = CLOUD_START_R;
  c.maxR = level.area * areaMul;
  c.recentTicks.clear();
  _writeCloudMatrix(idx, c);
  try { sfx.weaponWeb && sfx.weaponWeb(); } catch (_) {}
}

// ─── per-cloud touch sweep ───────────────────────────────────────────────────
// Damage + slow tick. Each enemy in cloud radius takes level.dmg every
// TICK_INTERVAL seconds (via _dotDps/_dotUntil refresh) and gets slowed for
// SLOW_REAPPLY_GAP via the _frozenUntil/_frozenWasSpd partial-restore hook.
function _applyTouch(c, level, dmgMul) {
  const now = (state.time && state.time.game) || 0;
  const r2 = c.maxR * c.maxR;
  // Use current cloud radius (during expansion), not max — visual+gameplay match.
  const expand = 0.30 + 0.70 * Math.min(1, c.age / CLOUD_LIFE);
  const curR = c.startR + (c.maxR - c.startR) * expand;
  const curR2 = curR * curR;
  let cands = null;
  try { cands = queryRadius({ x: c.x, z: c.z }, curR); } catch (_) { cands = null; }
  if (!cands) cands = state.enemies && state.enemies.active;
  if (!cands) return;
  for (const e of cands) {
    if (!e || !e.alive || !e.mesh) continue;
    const dx = e.mesh.position.x - c.x;
    const dz = e.mesh.position.z - c.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > curR2 || d2 > r2) continue;
    const nextAt = c.recentTicks.get(e) || 0;
    if (now < nextAt) continue;
    // Damage tick — use the existing _dotDps/_dotUntil channel so the
    // damage applies via the central enemies.js DoT pulser. Cumulative
    // dps stamp = level.dmg per TICK_INTERVAL seconds.
    const dps = (level.dmg / TICK_INTERVAL) * dmgMul;
    e._dotDps  = Math.max(e._dotDps || 0, dps);
    e._dotUntil = Math.max(e._dotUntil || 0, now + TICK_INTERVAL * 1.25);
    e._dotSource = 'spore_cloud';
    // Slow stamp — partial. Reuse _frozenWasSpd backup so enemies.js
    // restores original spd when _frozenUntil elapses. Skip bosses
    // marked _heavy/_noKnockback to avoid stranding them. Skip enemies
    // currently FROZEN (don't blow away their stronger CC).
    if (!e._heavy && !e._noKnockback) {
      const slowUntil = now + SLOW_REAPPLY_GAP * 2;
      const alreadyFrozen = !!e._frozenUntil && e._frozenWasSpd !== undefined && e.spd === 0;
      if (!alreadyFrozen) {
        if (!e._frozenUntil) {
          e._frozenWasSpd = e.spd;
        }
        const baseSpd = (e._frozenWasSpd !== undefined) ? e._frozenWasSpd : e.spd;
        e.spd = baseSpd * (1 - level.slow);
        if (!e._frozenUntil || e._frozenUntil < slowUntil) e._frozenUntil = slowUntil;
      }
    }
    c.recentTicks.set(e, now + TICK_INTERVAL);
  }
}

// ─── weapon module ───────────────────────────────────────────────────────────
export default {
  id: 'spore_cloud',
  name: 'Spore Cloud',
  desc: 'Drifting clouds of mushroom spores damage and slow enemies they touch',
  icon: '🍄',
  hidden: true,            // Forest special — never appears in level-up card pool
  maxLevel: 8,
  // Level table — interval shortens, area grows, dmg + slow ramp.
  // dmg is per-TICK_INTERVAL (so 6 dmg over 0.5s = 12 dps; matches brief).
  levels: [
    { cooldown: 2.50, interval: 2.50, area: 5.0, dmg:  6, slow: 0.50 },
    { cooldown: 2.35, interval: 2.35, area: 5.4, dmg:  8, slow: 0.53 },
    { cooldown: 2.20, interval: 2.20, area: 5.9, dmg: 10, slow: 0.56 },
    { cooldown: 2.05, interval: 2.05, area: 6.3, dmg: 12, slow: 0.59 },
    { cooldown: 1.90, interval: 1.90, area: 6.8, dmg: 14, slow: 0.62 },
    { cooldown: 1.75, interval: 1.75, area: 7.2, dmg: 16, slow: 0.65 },
    { cooldown: 1.60, interval: 1.60, area: 7.6, dmg: 17, slow: 0.68 },
    { cooldown: 1.50, interval: 1.50, area: 8.0, dmg: 18, slow: 0.70 },
  ],

  init(state, level, inst) {
    inst.cd = 1.0;
    void level;
  },

  tick(state, dt, level, inst) {
    if (inst.cd === undefined) inst.cd = 0;
    _ensureMeshes();
    if (!_meshesReady) return;

    const dmgMul  = (state.hero.statMul && state.hero.statMul.dmg) || 1;
    const areaMul = (state.hero.statMul && state.hero.statMul.area) || 1;
    const cdMul   = (state.hero.statMul && state.hero.statMul.cooldown) || 1;
    let dirty = false;

    // Tick live clouds — expand visual, sweep touch, expire when over life.
    for (let i = 0; i < CLOUD_CAP; i++) {
      const c = _clouds[i];
      if (!c.live) continue;
      c.age += dt;
      if (c.age >= CLOUD_LIFE) {
        c.live = false;
        c.recentTicks.clear();
        _hideCloud(i);
        dirty = true;
        continue;
      }
      _applyTouch(c, level, dmgMul);
      _writeCloudMatrix(i, c);
      dirty = true;
    }

    // Per-frame opacity drift for the shared material — fade in / out as the
    // youngest cloud ages. Cheap because it's one .opacity write per frame.
    if (_cloudMat) {
      let youngestAge = CLOUD_LIFE;
      let anyLive = false;
      for (let i = 0; i < CLOUD_CAP; i++) {
        if (!_clouds[i].live) continue;
        anyLive = true;
        if (_clouds[i].age < youngestAge) youngestAge = _clouds[i].age;
      }
      if (anyLive) {
        const k = Math.min(1, youngestAge / CLOUD_LIFE);
        _cloudMat.opacity = 0.65 * (1 - 0.65 * k);
      }
    }

    if (dirty) _cloudMesh.instanceMatrix.needsUpdate = true;

    // Cooldown / emit new cloud.
    inst.cd -= dt;
    if (inst.cd > 0) return;
    _emitCloud(level, areaMul);
    inst.cd = level.interval * cdMul * (state.run.passive_cooldown || 1);
  },

  refresh(state, level, inst) {
    if (inst.cd > level.interval * 0.5) inst.cd = level.interval * 0.25;
  },
};
