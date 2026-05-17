/**
 * Briar Whip — Forest special weapon (FE-V2 cohort 2, 2026-05-17).
 *
 * Cone sweep. Every level.cooldown seconds, a thorned vine ribbon sweeps
 * a cone in the hero's facing direction (or toward the nearest enemy if
 * the hero hasn't moved recently). Each enemy inside the wedge takes
 * level.dmg once + has a configurable chance to bleed (DoT).
 *
 * Mechanic — distinct from sap_weaver (passive sticky globs), root_grasp
 * (single targeted snare), wisp_lantern (orbital homing), and
 * sig_rocker_powerchord (forward sonic wave that propagates).
 *   - INSTANT cone sweep (no propagation) — enemies inside take damage
 *     immediately at the moment of swing.
 *   - DIRECTIONAL: hero facing OR closest enemy fallback (matches the
 *     rocker_powerchord directional precedent).
 *   - Bleed via the existing _dotDps/_dotUntil channel. Application
 *     chance scales from 25%→100%; DoT itself is fixed 5 dmg/s for 2s.
 *
 * Bleed contract decision (brief was underspecified — "25% bleed (DoT
 * 5/s for 2s)" then "bleed 25%→100%"):
 *   Treating percentage as APPLICATION CHANCE (not damage scalar) is the
 *   only reading where the scaling table coheres. DoT amount + duration
 *   stay fixed at 5/s and 2s; chance ramps with level. _dotSource =
 *   'briar_whip'.
 *
 * Visual contract (Spider Web FX quality bar):
 *   - 3 pre-pooled ribbon meshes (PlaneGeometry with rewritten position
 *     buffer per sweep) — pre-allocated in _ensureMeshes.
 *   - Slot-4 mint body, slot-7 amber tip-pulse on swing frame.
 *   - BLOOM_LAYER tagged.
 *
 * Palette substitutions (brief asked for off-palette 0x6b4f3a brown /
 * 0xc7b89a bone; 8-color slot-lock is hard-required, so:
 *   slot 5 deep mint 0x3ecf9a  — vine body (matches root_grasp tip)
 *   slot 4 mint      0x7df0c4  — vine highlight
 *   slot 7 amber     0xffd86b  — tip burst pulse on each swing
 *
 * Pool caps:
 *   - 3 ribbon segments (matches brief "2-3 thorny ribbon mesh segments")
 *
 * Hot-path allocation: all THREE.* construction in _ensureMeshes (one-shot
 * lazy). Tick reuses module-scope scratch only. Static imports only.
 */
import * as THREE from 'three';
import { state } from '../state.js';
import { damageEnemy, queryRadius } from '../enemies.js';
import { sfx } from '../audio.js';
import { BLOOM_LAYER } from '../postfx.js';

// ─── tunables ────────────────────────────────────────────────────────────────
const RIBBON_COUNT      = 3;            // segments per swing (matches brief)
const RIBBON_SEGMENTS   = 12;           // spine vertex resolution
const RIBBON_VERTS      = (RIBBON_SEGMENTS + 1) * 2;
const RIBBON_HALF_W     = 0.075;        // mid-band of 0.06-0.10 line-weight spec
const RIBBON_Y          = 0.45;         // chest-height vine plane
const RIBBON_LIFE       = 0.28;         // seconds: swing → fade
const BLEED_DPS         = 5;            // fixed (see header bleed contract)
const BLEED_DUR         = 2.0;          // fixed

// Palette literals — locked. See header for substitution rationale.
const COLOR_VINE        = 0x3ecf9a;     // slot 5 deep mint (vine body)
const COLOR_TIP         = 0xffd86b;     // slot 7 amber (tip pulse)

// ─── module scratch ──────────────────────────────────────────────────────────
const _swingOrigin = new THREE.Vector3();

// ─── module state ────────────────────────────────────────────────────────────
const _ribbons = new Array(RIBBON_COUNT);   // persistent meshes (pre-allocated)
let _meshesReady = false;

// Tiny "swings in flight" pool — each swing references one of the ribbons.
// Multiple swings can stagger across ribbons but we don't keep more than the
// pool because brief specifies 2-3 visual segments. Each entry:
//   { live, ribbonIdx, ax, az, bx, bz, arc, t }
const _swings = new Array(RIBBON_COUNT);
for (let i = 0; i < RIBBON_COUNT; i++) {
  _swings[i] = { live: false, ribbonIdx: i, ax: 0, az: 0, bx: 0, bz: 0, arc: 0, t: 0 };
}

// ─── lazy mesh init ──────────────────────────────────────────────────────────
function _ensureMeshes() {
  if (_meshesReady) return;
  if (!state.scene) return;

  // Shared index buffer — same shape across all ribbons.
  const indices = new Uint16Array(RIBBON_SEGMENTS * 6);
  for (let s = 0; s < RIBBON_SEGMENTS; s++) {
    const v0 = s * 2, v1 = v0 + 1, v2 = v0 + 2, v3 = v0 + 3;
    const o = s * 6;
    indices[o + 0] = v0; indices[o + 1] = v1; indices[o + 2] = v2;
    indices[o + 3] = v2; indices[o + 4] = v1; indices[o + 5] = v3;
  }
  for (let i = 0; i < RIBBON_COUNT; i++) {
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
    _ribbons[i] = { mesh, mat, geo, pos };
  }
  _meshesReady = true;
}

// ─── ribbon writer ───────────────────────────────────────────────────────────
// Draws an arc from `(ax,az)` (hero origin) sweeping through `arc` radians
// centered on the swing axis. Writes RIBBON_SEGMENTS+1 spine points × 2
// (top+bottom) into the persistent position buffer.
function _writeRibbon(r, swing, t) {
  // swing.bx/bz is the AIM direction (unit vector + length=length).
  // Angle of aim:
  const ang = Math.atan2(swing.bz - swing.az, swing.bx - swing.ax);
  const len = Math.hypot(swing.bx - swing.ax, swing.bz - swing.az);
  const halfArc = swing.arc * 0.5;
  for (let i = 0; i <= RIBBON_SEGMENTS; i++) {
    const u = i / RIBBON_SEGMENTS;            // 0..1 along spine
    // Sweep parameter — animate from -halfArc → +halfArc as t goes 0→1.
    // The spine itself traces an arc (radial) at distance r=len*u.
    const sweepCenter = -halfArc + swing.arc * t;
    // Each segment along the spine occupies a slightly different sweep slice
    // so the ribbon reads as a curved blade (tail trails behind tip).
    const segAng = sweepCenter - (1 - u) * (swing.arc * 0.35);
    const rad = len * u;
    const sx = swing.ax + Math.cos(ang + segAng) * rad;
    const sz = swing.az + Math.sin(ang + segAng) * rad;
    // Width taper — fat midline, thin tips (sin pi).
    const taper = Math.sin(u * Math.PI);
    const w = RIBBON_HALF_W * Math.max(0.45, taper);
    // Perpendicular to the local tangent for top/bottom vertices.
    const perpX = -Math.sin(ang + segAng) * w;
    const perpZ =  Math.cos(ang + segAng) * w;
    const base = i * 6;
    r.pos[base + 0] = sx + perpX;
    r.pos[base + 1] = RIBBON_Y;
    r.pos[base + 2] = sz + perpZ;
    r.pos[base + 3] = sx - perpX;
    r.pos[base + 4] = RIBBON_Y;
    r.pos[base + 5] = sz - perpZ;
  }
  r.geo.attributes.position.needsUpdate = true;
}

// ─── aim ─────────────────────────────────────────────────────────────────────
function _aimAngle(hero) {
  // Prefer nearest enemy in 14u (matches sapWeaver TARGET_RANGE precedent).
  let cands = null;
  try { cands = queryRadius(hero, 14); } catch (_) { cands = null; }
  if (!cands) cands = state.enemies && state.enemies.active;
  let best = null, bestD2 = Infinity;
  if (cands) {
    for (const e of cands) {
      if (!e || !e.alive || !e.mesh) continue;
      const dx = e.mesh.position.x - hero.x;
      const dz = e.mesh.position.z - hero.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = e; }
    }
  }
  if (best) return Math.atan2(best.mesh.position.z - hero.z, best.mesh.position.x - hero.x);
  // Fallback: hero facing vector (set by hero.js, used by rocker_powerchord too).
  if (state.hero && state.hero.facing) {
    return Math.atan2(state.hero.facing.z || 0, state.hero.facing.x || 1);
  }
  return 0;
}

// ─── damage application ─────────────────────────────────────────────────────
// Capture-and-apply at swing time. Damage is INSTANT (one hit per swing per
// enemy). Bleed roll happens per-hit. Subsequent ticks of the visual don't
// re-apply damage.
function _applyHits(swing, level, dmgMul) {
  const ax = swing.ax, az = swing.az;
  const ang = Math.atan2(swing.bz - az, swing.bx - ax);
  const len = Math.hypot(swing.bx - ax, swing.bz - az);
  const halfArc = swing.arc * 0.5;
  const cosA = Math.cos(ang), sinA = Math.sin(ang);
  let cands = null;
  try { cands = queryRadius({ x: ax, z: az }, len); } catch (_) { cands = null; }
  if (!cands) cands = state.enemies && state.enemies.active;
  if (!cands) return;
  const now = (state.time && state.time.game) || 0;
  for (const e of cands) {
    if (!e || !e.alive || !e.mesh) continue;
    const rx = e.mesh.position.x - ax;
    const rz = e.mesh.position.z - az;
    const along = rx * cosA + rz * sinA;
    if (along < 0 || along > len) continue;
    // Angular distance from the aim axis (signed perpendicular -> atan2 for
    // arc-membership check rather than perp-distance, which would carve a
    // rectangle instead of a wedge).
    const perp = rx * -sinA + rz * cosA;
    const enemyAng = Math.atan2(perp, along);
    if (Math.abs(enemyAng) > halfArc) continue;
    try { damageEnemy(e, level.dmg * dmgMul, 'briar_whip'); } catch (_) {}
    if (!e.alive) continue;
    // Bleed roll. Brief specifies application chance scaling 25→100%.
    if (Math.random() < level.bleedChance) {
      const dps = BLEED_DPS * dmgMul;
      e._dotDps  = Math.max(e._dotDps || 0, dps);
      e._dotUntil = Math.max(e._dotUntil || 0, now + BLEED_DUR);
      e._dotSource = 'briar_whip';
    }
  }
}

// ─── swing dispatch ─────────────────────────────────────────────────────────
function _findFreeSwing() {
  for (let i = 0; i < RIBBON_COUNT; i++) if (!_swings[i].live) return i;
  // No slot — recycle the oldest (largest t — already mid-fade).
  let oldest = 0, oldestT = -1;
  for (let i = 0; i < RIBBON_COUNT; i++) {
    if (_swings[i].t > oldestT) { oldestT = _swings[i].t; oldest = i; }
  }
  return oldest;
}

function _swing(level, areaMul, dmgMul) {
  _ensureMeshes();
  if (!_meshesReady) return;
  const hero = state.hero.pos;
  _swingOrigin.set(hero.x, RIBBON_Y, hero.z);
  const ang = _aimAngle(hero);
  const len = level.length * areaMul;
  const arc = level.arc;

  const idx = _findFreeSwing();
  const s = _swings[idx];
  s.live = true;
  s.ax = hero.x;
  s.az = hero.z;
  s.bx = hero.x + Math.cos(ang) * len;
  s.bz = hero.z + Math.sin(ang) * len;
  s.arc = arc;
  s.t = 0;

  // Show + initialize ribbon.
  const r = _ribbons[s.ribbonIdx];
  r.mesh.visible = true;
  r.mat.opacity = 1.0;
  r.mat.color.setHex(COLOR_TIP);   // amber flash on swing frame
  _writeRibbon(r, s, 0);

  _applyHits(s, level, dmgMul);

  try { sfx.weaponWeb && sfx.weaponWeb(); } catch (_) {}
}

// ─── weapon module ───────────────────────────────────────────────────────────
export default {
  id: 'briar_whip',
  name: 'Briar Whip',
  desc: 'A thorned vine sweeps in front of you, cutting and bleeding what it touches',
  icon: '🌹',
  hidden: true,                  // Forest special — never appears in level-up card pool
  maxLevel: 8,
  // Level table — arc 90°→180°, length 4→7u, dmg 15→40, bleed chance 25→100%.
  // arc stored in radians.
  levels: [
    { cooldown: 1.20, arc: 90  * Math.PI / 180, length: 4.0, dmg: 15, bleedChance: 0.25 },
    { cooldown: 1.15, arc: 100 * Math.PI / 180, length: 4.5, dmg: 18, bleedChance: 0.35 },
    { cooldown: 1.10, arc: 110 * Math.PI / 180, length: 5.0, dmg: 22, bleedChance: 0.45 },
    { cooldown: 1.05, arc: 125 * Math.PI / 180, length: 5.5, dmg: 26, bleedChance: 0.55 },
    { cooldown: 1.00, arc: 140 * Math.PI / 180, length: 6.0, dmg: 30, bleedChance: 0.65 },
    { cooldown: 0.95, arc: 155 * Math.PI / 180, length: 6.3, dmg: 33, bleedChance: 0.80 },
    { cooldown: 0.90, arc: 170 * Math.PI / 180, length: 6.6, dmg: 36, bleedChance: 0.90 },
    { cooldown: 0.85, arc: 180 * Math.PI / 180, length: 7.0, dmg: 40, bleedChance: 1.00 },
  ],

  init(state, level, inst) {
    inst.cd = 0.5;
    void level;
  },

  tick(state, dt, level, inst) {
    if (inst.cd === undefined) inst.cd = 0;
    _ensureMeshes();
    if (!_meshesReady) return;

    // Advance live ribbons — sweep + opacity fade.
    for (let i = 0; i < RIBBON_COUNT; i++) {
      const s = _swings[i];
      if (!s.live) continue;
      s.t += dt / RIBBON_LIFE;
      const r = _ribbons[s.ribbonIdx];
      if (s.t >= 1) {
        s.live = false;
        r.mesh.visible = false;
        r.mat.opacity = 0;
        continue;
      }
      _writeRibbon(r, s, s.t);
      r.mat.opacity = 1.0 - s.t;
      // Lerp the swing color from amber tip (slot 7) → vine body (slot 5)
      // across the swing — sells "flash then settle".
      const k = Math.min(1, s.t * 2);   // hit body color by mid-swing
      const cur = COLOR_TIP;
      const dst = COLOR_VINE;
      // Manual lerp w/o alloc: extract channels, mix, recompose.
      const cr = ((cur >> 16) & 0xff), cg = ((cur >> 8) & 0xff), cb = (cur & 0xff);
      const dr = ((dst >> 16) & 0xff), dg = ((dst >> 8) & 0xff), db = (dst & 0xff);
      const mr = Math.round(cr + (dr - cr) * k);
      const mg = Math.round(cg + (dg - cg) * k);
      const mb = Math.round(cb + (db - cb) * k);
      r.mat.color.setHex((mr << 16) | (mg << 8) | mb);
    }

    // Cooldown / swing.
    inst.cd -= dt;
    if (inst.cd > 0) return;
    const dmgMul  = (state.hero.statMul && state.hero.statMul.dmg) || 1;
    const areaMul = (state.hero.statMul && state.hero.statMul.area) || 1;
    const cdMul   = (state.hero.statMul && state.hero.statMul.cooldown) || 1;
    _swing(level, areaMul, dmgMul);
    inst.cd = level.cooldown * cdMul * (state.run.passive_cooldown || 1);
  },

  refresh(state, level, inst) {
    if (inst.cd > level.cooldown * 0.5) inst.cd = level.cooldown * 0.25;
  },
};
