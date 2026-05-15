/**
 * Fallout — Radcat's signature weapon (Phase F2 of progression redesign).
 *
 * Persistent aura. A radius around the hero continuously irradiates every
 * enemy inside it: a steady DoT that ramps up the longer the enemy stays
 * irradiated, plus a brief residual decay after the enemy exits. No
 * cooldown — the kit is "always on" like an aura skill.
 *
 * Mechanic distinct from sig_mothman_dustcloak / sig_camper_signalfire:
 *   - Aura follows the hero rather than a planted zone. No spawn cost.
 *   - Per-enemy ramp counter (state.run.radcatRamps Map) tracks
 *     irradiation seconds, scaling damage from 1× to 3× over 3 seconds.
 *   - On exit, the enemy keeps taking a decaying tick for 1.5s.
 *
 * Visual: a single floor-decal plane glued to the hero (NOT InstancedMesh —
 * only ONE aura ring per kit, so one Mesh is appropriate). Reuses
 * `aoe_danger` tex from MANIFEST when available.
 *
 * SFX placeholder: none — passive aura, the constant audio cue would annoy.
 */
import * as THREE from 'three';
import { state } from '../../state.js';
import { tex } from '../../particleTextures.js';
import { queryRadius } from '../../enemies.js';
import { applyFloorTier, floorDecalGeometry, floorDecalMaterial } from '../../fxLayers.js';
import { fxTex } from '../../fxTextures.js';

const AURA_Y = 0.06;
let _aura = null;

function _ensureMesh() {
  if (_aura) return;
  const geo = floorDecalGeometry(2);
  const mat = floorDecalMaterial({ map: fxTex('aoe_danger') || tex('emberWarm'), color: 0x66ff99, opacity: 0.35 });
  _aura = new THREE.Mesh(geo, mat);
  _aura.position.y = AURA_Y;
  applyFloorTier(_aura, 'kill_pickup');
  state.scene.add(_aura);
}

export default {
  id: 'sig_radcat_fallout',
  name: 'Fallout',
  desc: 'Constant aura — ramps damage the longer enemies stay irradiated.',
  icon: '☢️',
  maxLevel: 8,
  // No cooldown — "tick" represents the once-per-frame aura sample. Each
  // level dials radius + per-second dmg + the ramp ceiling.
  levels: [
    { radius: 2.8, dmgPerSec:  4, rampCap: 1.8 },
    { radius: 3.0, dmgPerSec:  5, rampCap: 2.0 },
    { radius: 3.2, dmgPerSec:  7, rampCap: 2.2 },
    { radius: 3.4, dmgPerSec:  9, rampCap: 2.4 },
    { radius: 3.6, dmgPerSec: 12, rampCap: 2.6 },
    { radius: 3.8, dmgPerSec: 16, rampCap: 2.8 },
    { radius: 4.0, dmgPerSec: 21, rampCap: 3.0 },
    { radius: 4.2, dmgPerSec: 28, rampCap: 3.0 },
  ],

  init(state, level, inst) {
    _ensureMesh();
    inst.ramps = new Map();    // enemy -> { acc: seconds in radius, residual: seconds remaining out }
    inst.dotAcc = 0;
  },

  tick(state, dt, level, inst) {
    _ensureMesh();
    const h = state.hero.pos;
    const r = level.radius * (state.hero.statMul.area || 1);
    _aura.position.x = h.x;
    _aura.position.z = h.z;
    _aura.scale.set(r, 1, r);
    // Aura pulses opacity for visual life
    _aura.material.opacity = 0.30 + Math.abs(Math.sin(state.time.game * 2.2)) * 0.12;

    inst.dotAcc += dt;
    if (inst.dotAcc < 0.25) return;   // sample 4× per second; sufficient for ramp accumulation
    const slice = inst.dotAcc;
    inst.dotAcc = 0;

    let cands = null;
    try { cands = queryRadius(h, r); } catch (_) { cands = state.enemies && state.enemies.active; }
    if (!cands) return;
    const r2 = r * r;
    const inside = new Set();
    for (const e of cands) {
      if (!e || !e.alive || !e.mesh) continue;
      const dx = e.mesh.position.x - h.x;
      const dz = e.mesh.position.z - h.z;
      if (dx * dx + dz * dz > r2) continue;
      inside.add(e);
      let rec = inst.ramps.get(e);
      if (!rec) { rec = { acc: 0, residual: 0 }; inst.ramps.set(e, rec); }
      rec.acc = Math.min(3.0, rec.acc + slice);
      rec.residual = 1.5;     // refresh exit DoT
      const rampMul = 1 + (rec.acc / 3.0) * (level.rampCap - 1);
      const dps = level.dmgPerSec * (state.hero.statMul.dmg || 1) * rampMul;
      e._dotDps = Math.max(e._dotDps || 0, dps);
      e._dotUntil = Math.max(e._dotUntil || 0, state.time.game + slice * 1.5);
      e._dotSource = 'sig_radcat_fallout';
    }
    // Decay residuals for enemies that left the radius this slice. Iterating
    // the Map is bounded by recent contacts (capped by swarm density in radius).
    for (const [e, rec] of inst.ramps) {
      if (inside.has(e)) continue;
      if (!e || !e.alive) { inst.ramps.delete(e); continue; }
      rec.residual -= slice;
      if (rec.residual <= 0) { inst.ramps.delete(e); continue; }
      // Half-strength tail
      const dps = level.dmgPerSec * (state.hero.statMul.dmg || 1) * 0.5;
      e._dotDps = Math.max(e._dotDps || 0, dps);
      e._dotUntil = Math.max(e._dotUntil || 0, state.time.game + slice * 1.2);
      e._dotSource = 'sig_radcat_fallout_decay';
    }
  },

  refresh(state, level, inst) {
    // Geometry/material stay; size changes per tick.
  },
};
