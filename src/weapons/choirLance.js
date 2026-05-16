/**
 * Choir Lance — Forest special weapon (FE-C1B, Cohort 1 Agent 2).
 *
 * Unlock-gated by `meta.forestWeapons` (Crystal Choir Grove puzzle reward).
 * Auto-fires a single-target spear at the nearest enemy on cooldown; impact
 * leaves a rotating crystal "echo" sigil that fires a secondary homing shot
 * when *any* weapon damages an enemy in range (observed via the shared
 * `enemy._flashUntil` hit-flash timestamp set in enemies.js:damageEnemy).
 *
 * Visual contract (matches Spider Web FX quality bar):
 *   - Spear: single chainFx additive ribbon arc (life 0.18s, line weight
 *     0.075/0.030 — falls inside the 0.06-0.10 outer / 0.03-0.05 inner band).
 *   - Echo: small rotating sigil cluster — 6 flashStar quads per echo,
 *     pre-pooled InstancedMesh, BLOOM_LAYER tagged.
 *
 * Palette (locked from docs/FOREST_VISUAL_STYLE.md):
 *   slot 5 — #3ecf9a mint deep      (spear inner core)
 *   slot 8 — #a8e6ff crystal blue   (spear outer + echo sigil)
 *
 * Pool caps:
 *   - 8 spear arcs max per cast volley window (via chainFx pool draw)
 *   - 4 echoes max simultaneously
 *   - 6 sigil quads × 4 echoes = 24 InstancedMesh slots
 *
 * Hot-path allocation audit: all THREE.* construction is inside
 * `_ensureMeshes()` (lazy one-shot) or module-scope. Per-frame paths reuse
 * scratch vectors.
 */
import * as THREE from 'three';
import { state } from '../state.js';
import { damageEnemy, queryRadius } from '../enemies.js';
import { tex } from '../particleTextures.js';
import { sfx } from '../audio.js';
import { BLOOM_LAYER } from '../postfx.js';
import { spawnChainArc } from '../chainFx.js';

// ─── tunables ────────────────────────────────────────────────────────────────
const ECHO_CAP        = 4;             // max simultaneous echoes
const SIGILS_PER_ECHO = 6;             // flashStar quads per echo (rotating cluster)
const ECHO_SLOT_CAP   = ECHO_CAP * SIGILS_PER_ECHO; // 24 InstancedMesh slots
const ECHO_LIFE       = 3.0;           // seconds before echo dissolves
const ECHO_TARGET_R   = 7.0;           // homing-shot trigger / scan radius
const ECHO_FIRE_CD    = 0.20;          // min seconds between echo retriggers
const ECHO_SIGIL_RAD  = 0.85;          // sigil orbit radius (world units)
const ECHO_SIGIL_Y    = 0.95;          // echo hover height
const ECHO_SIGIL_SIZE = 0.45;          // sigil quad side
const ECHO_ROT_SPEED  = 1.6;           // radians/sec orbit
const SPEAR_LIFE      = 0.18;          // chainFx arc fade duration
const SPEAR_RANGE     = 22;            // single-target acquisition range
const SPEAR_OUTER_R   = 0.075;         // chainFx outer half-width (spec 0.06-0.10)
const SPEAR_INNER_R   = 0.030;         // chainFx inner half-width
const HOMING_LIFE     = 0.16;          // homing shot arc duration

// Palette literals — both slots are explicitly forest-locked.
const COLOR_SPEAR_OUTER = 0xa8e6ff;    // slot 8 crystal blue (outer)
const COLOR_SPEAR_INNER = 0x3ecf9a;    // slot 5 mint deep (hot core)
const COLOR_ECHO        = 0xa8e6ff;    // slot 8 crystal blue (sigil cluster)

// ─── module scratch (zero per-frame alloc) ───────────────────────────────────
const _m4 = new THREE.Matrix4();
const _vPos = new THREE.Vector3();
const _vScale = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _eu = new THREE.Euler();
const _zeroScale = new THREE.Vector3(0, 0, 0);
const _flatX = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));

// ─── module state ────────────────────────────────────────────────────────────
// Echo slot: { live, x, z, ttl, rotPhase, fireCd, echoDmg }
const _echoes = new Array(ECHO_CAP);
for (let i = 0; i < ECHO_CAP; i++) {
  _echoes[i] = { live: false, x: 0, z: 0, ttl: 0, rotPhase: 0, fireCd: 0, echoDmg: 35 };
}

let _sigilMesh = null;     // InstancedMesh for sigil quads
let _meshesReady = false;

// ─── lazy mesh init ──────────────────────────────────────────────────────────
function _ensureMeshes() {
  if (_meshesReady) return;
  if (!state.scene) return;
  // Sigil quads share one InstancedMesh — flashStar texture, additive,
  // BLOOM_LAYER tagged.
  const geo = new THREE.PlaneGeometry(ECHO_SIGIL_SIZE, ECHO_SIGIL_SIZE);
  const mat = new THREE.MeshBasicMaterial({
    map: tex('flashStar'),
    color: COLOR_ECHO,
    transparent: true,
    opacity: 0.90,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  _sigilMesh = new THREE.InstancedMesh(geo, mat, ECHO_SLOT_CAP);
  _sigilMesh.count = ECHO_SLOT_CAP;
  _sigilMesh.frustumCulled = false;
  _sigilMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _sigilMesh.layers.enable(BLOOM_LAYER);
  for (let i = 0; i < ECHO_SLOT_CAP; i++) {
    _vPos.set(0, -1000, 0);
    _m4.compose(_vPos, _flatX, _zeroScale);
    _sigilMesh.setMatrixAt(i, _m4);
  }
  _sigilMesh.instanceMatrix.needsUpdate = true;
  state.scene.add(_sigilMesh);
  _meshesReady = true;
}

// ─── echo helpers ────────────────────────────────────────────────────────────
function _findFreeEcho() {
  for (let i = 0; i < ECHO_CAP; i++) if (!_echoes[i].live) return i;
  // All slots live → reuse oldest.
  let oldest = 0, oldestTtl = Infinity;
  for (let i = 0; i < ECHO_CAP; i++) {
    if (_echoes[i].ttl < oldestTtl) { oldestTtl = _echoes[i].ttl; oldest = i; }
  }
  return oldest;
}

function _writeSigilMatrices(echoIdx, e) {
  const base = echoIdx * SIGILS_PER_ECHO;
  const ttlFade = Math.min(1, e.ttl / 0.5); // fade tail
  const scale = 1.0 * ttlFade;
  for (let s = 0; s < SIGILS_PER_ECHO; s++) {
    const ang = e.rotPhase + (s / SIGILS_PER_ECHO) * Math.PI * 2;
    const px = e.x + Math.cos(ang) * ECHO_SIGIL_RAD;
    const pz = e.z + Math.sin(ang) * ECHO_SIGIL_RAD;
    _vPos.set(px, ECHO_SIGIL_Y, pz);
    _eu.set(0, -ang, 0);
    _q.setFromEuler(_eu);
    _vScale.set(scale, scale, scale);
    _m4.compose(_vPos, _q, _vScale);
    _sigilMesh.setMatrixAt(base + s, _m4);
  }
}

function _hideSigils(echoIdx) {
  const base = echoIdx * SIGILS_PER_ECHO;
  _vPos.set(0, -1000, 0);
  _m4.compose(_vPos, _flatX, _zeroScale);
  for (let s = 0; s < SIGILS_PER_ECHO; s++) {
    _sigilMesh.setMatrixAt(base + s, _m4);
  }
}

// ─── targeting ───────────────────────────────────────────────────────────────
// Find nearest live enemy to `pos` within `range`. Returns the enemy or null.
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

// Find a "recently damaged" enemy near this echo. Uses `_flashUntil` set by
// enemies.js:damageEnemy on EVERY damage source — i.e. this fires when any
// weapon (or even hazard) just dealt damage to something inside the echo's
// reach. Throttled by echo.fireCd so a single damage event triggers at most
// one homing shot per echo per ECHO_FIRE_CD window.
function _findRecentlyDamaged(echo) {
  const range = ECHO_TARGET_R;
  const now = state.time && state.time.game;
  if (now == null) return null;
  let cands = null;
  try { cands = queryRadius({ x: echo.x, z: echo.z }, range); } catch (_) { cands = null; }
  if (!cands) cands = state.enemies && state.enemies.active;
  if (!cands) return null;
  let best = null, bestT = 0;
  const r2 = range * range;
  for (const e of cands) {
    if (!e || !e.alive || !e.mesh) continue;
    if (!e._flashUntil || e._flashUntil <= now) continue;
    const dx = e.mesh.position.x - echo.x;
    const dz = e.mesh.position.z - echo.z;
    if (dx * dx + dz * dz > r2) continue;
    // Newest flash wins — `_flashUntil` is `now + flashDur`, so the highest
    // value means most recently struck.
    if (e._flashUntil > bestT) { bestT = e._flashUntil; best = e; }
  }
  return best;
}

// ─── spear cast + echo fire ──────────────────────────────────────────────────
function _castSpear(level) {
  const hero = state.hero.pos;
  const tgt = _findNearest(hero, SPEAR_RANGE);
  if (!tgt) return false;
  const tp = tgt.mesh.position;
  // Spear visual = single straight chainFx arc with overrides for tight
  // jitter (segments=2, jitter=0.10) so it reads as a clean spear rather
  // than a jagged bolt. line weight inside spec window.
  spawnChainArc(state.scene, hero, { x: tp.x, z: tp.z }, {
    outerColor: COLOR_SPEAR_OUTER,
    innerColor: COLOR_SPEAR_INNER,
    life: SPEAR_LIFE,
    segments: 2,
    jitter: 0.10,
    outerRadius: SPEAR_OUTER_R,
    innerRadius: SPEAR_INNER_R,
  });
  const dmgMul = (state.hero.statMul && state.hero.statMul.dmg) || 1;
  try { damageEnemy(tgt, level.dmg * dmgMul, 'choir_lance'); } catch (_) {}
  // Plant an echo at the impact point (rounded so multiple impacts on the
  // same enemy this run don't infinitely stack identical echoes — slot
  // reuse handles that, but the round helps visual readability).
  const idx = _findFreeEcho();
  const e = _echoes[idx];
  e.live = true;
  e.x = tp.x;
  e.z = tp.z;
  e.ttl = ECHO_LIFE;
  e.rotPhase = Math.random() * Math.PI * 2;
  e.fireCd = ECHO_FIRE_CD * 0.5; // brief grace so the spawn frame doesn't fire
  e.echoDmg = level.echoDmg;
  try { sfx.weaponChain && sfx.weaponChain(); } catch (_) {}
  return true;
}

function _echoFireHoming(echo, target) {
  const ep = target.mesh.position;
  spawnChainArc(state.scene, { x: echo.x, z: echo.z }, { x: ep.x, z: ep.z }, {
    outerColor: COLOR_SPEAR_OUTER,
    innerColor: COLOR_SPEAR_INNER,
    life: HOMING_LIFE,
    segments: 3,
    jitter: 0.18,
    outerRadius: SPEAR_OUTER_R,
    innerRadius: SPEAR_INNER_R,
  });
  const dmgMul = (state.hero.statMul && state.hero.statMul.dmg) || 1;
  try { damageEnemy(target, echo.echoDmg * dmgMul, 'choir_lance'); } catch (_) {}
}

// ─── weapon module ───────────────────────────────────────────────────────────
export default {
  id: 'choir_lance',
  name: 'Choir Lance',
  desc: 'Crystal spear plants echoes that resonate with every weapon hit',
  icon: '💎',
  hidden: true, // Forest special — never appears in level-up card pool
  maxLevel: 8,
  levels: [
    { cooldown: 2.00, dmg: 220, echoDmg: 35 },
    { cooldown: 1.95, dmg: 245, echoDmg: 42 },
    { cooldown: 1.90, dmg: 275, echoDmg: 50 },
    { cooldown: 1.80, dmg: 310, echoDmg: 60 },
    { cooldown: 1.70, dmg: 350, echoDmg: 72 },
    { cooldown: 1.60, dmg: 395, echoDmg: 86 },
    { cooldown: 1.50, dmg: 445, echoDmg: 100 },
    { cooldown: 1.40, dmg: 500, echoDmg: 120 },
  ],

  init(state, level, inst) { inst.cd = 0.5; },

  tick(state, dt, level, inst) {
    if (inst.cd === undefined) inst.cd = 0;
    _ensureMeshes();
    if (!_meshesReady) return;

    // ── Tick echoes: ttl, rotation, recently-damaged scan ──
    let dirty = false;
    for (let i = 0; i < ECHO_CAP; i++) {
      const e = _echoes[i];
      if (!e.live) continue;
      e.ttl -= dt;
      e.fireCd -= dt;
      e.rotPhase += dt * ECHO_ROT_SPEED;
      if (e.ttl <= 0) {
        e.live = false;
        _hideSigils(i);
        dirty = true;
        continue;
      }
      _writeSigilMatrices(i, e);
      dirty = true;
      // Homing trigger: scan for any enemy that took damage in the last
      // ~0.18s and is inside ECHO_TARGET_R. Throttled per-echo by fireCd.
      if (e.fireCd <= 0) {
        const dmgTarget = _findRecentlyDamaged(e);
        if (dmgTarget) {
          _echoFireHoming(e, dmgTarget);
          e.fireCd = ECHO_FIRE_CD;
        }
      }
    }
    if (dirty) _sigilMesh.instanceMatrix.needsUpdate = true;

    // ── Spear cast ──
    inst.cd -= dt;
    if (inst.cd > 0) return;
    const fired = _castSpear(level);
    // If no target found, retry quickly so we don't burn a full cooldown.
    if (!fired) { inst.cd = 0.25; return; }
    inst.cd = level.cooldown
      * ((state.hero.statMul && state.hero.statMul.cooldown) || 1)
      * (state.run.passive_cooldown || 1);
  },

  refresh(state, level, inst) {
    if (inst.cd > level.cooldown * 0.5) inst.cd = level.cooldown * 0.25;
  },
};
