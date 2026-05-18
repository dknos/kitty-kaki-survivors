/**
 * XP gem system. Uses a single InstancedMesh (capacity 500) so all gems = 1 draw call.
 *
 * Exports: initXP, dropGem, updateGems, applyLevelUpChoice
 */
import * as THREE from 'three';
import { state, xpForLevel } from './state.js';
import { XP, HERO } from './config.js';
import { sfx } from './audio.js';
import { weaponChoices, acquireWeapon, applyFiller, applyEvolution } from './weapons/index.js';
import { shopLevel } from './meta.js';
import { showLevelUpModal, hideLevelUpModal, flashLevelUp } from './ui.js';
import { spawnMagnetSpark } from './fx.js';
import { tex } from './particleTextures.js';
import { BLOOM_LAYER } from './postfx.js';
// PHASE 4 P4J (#140) — Telemetry pickup + levelup events. Static import keeps
// the gem-pickup hot path allocation-free.
import { event as telemetryEvent } from './telemetry.js';
import { GLTF_CACHE } from './assets.js';
// Sprite FX — STATIC import (level-up isn't per-frame, but keep the contract
// uniform with enemies.js so future per-frame XP hooks can't accidentally
// regress to dynamic import on the hot path).
import { spawnSprite } from './sprites/index.js';

const GEM_CAPACITY = 500;
const PICKUP_DIST = 0.8;
const PICKUP_DIST_SQ = PICKUP_DIST * PICKUP_DIST;
const _up = new THREE.Vector3(0, 1, 0);

// Reusable temporaries (avoid per-frame allocations).
const _mat = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scaleOne = new THREE.Vector3(1, 1, 1);
const _scaleZero = new THREE.Vector3(0, 0, 0);
const _toHero = new THREE.Vector3();
const _sparkleFlat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const _sparkleScale = new THREE.Vector3();
const _gemScale = new THREE.Vector3();   // iter 33k — pool for gem matrix compose

let _matrixDirty = false;
// Separate dirty flag for the sparkle billboard layer (capped at gem capacity
// so it pairs 1:1 with each gem slot).
let _sparkleDirty = false;
let _sparkleInst = null;
const _sparkleColor = new THREE.Color();

/** Write a hidden (scale-0) matrix at slot i. */
function _hideInstance(i) {
  _mat.compose(_pos.set(0, -1000, 0), _quat.identity(), _scaleZero);
  state.gems.instMesh.setMatrixAt(i, _mat);
  if (_sparkleInst) _sparkleInst.setMatrixAt(i, _mat);
  _matrixDirty = true;
  _sparkleDirty = true;
}

/** Write a visible matrix at slot i for given world pos + value-based scale. */
function _placeInstance(i, pos, value = 1, yaw = 0) {
  const tier = _gemTier(value);
  const s = tier.scale;
  _quat.setFromAxisAngle(_up, yaw);
  _mat.compose(pos, _quat, _gemScale.set(s, s, s));
  state.gems.instMesh.setMatrixAt(i, _mat);
  _matrixDirty = true;
  // Sparkle layer rides slightly above the gem and pulses on a sine wave.
  // Pulse is keyed off (pos.x + pos.z) so adjacent gems don't lockstep.
  if (_sparkleInst) {
    const phase = pos.x * 0.7 + pos.z * 1.3;
    const pulse = 1.6 + 0.4 * Math.sin(state.time.game * 6 + phase);
    _sparkleScale.set(pulse * s, pulse * s, pulse * s);
    _pos.set(pos.x, pos.y + 0.15, pos.z);
    _mat.compose(_pos, _sparkleFlat, _sparkleScale);
    _sparkleInst.setMatrixAt(i, _mat);
    _sparkleDirty = true;
  }
}

// Per-value color + scale tier. Multiplied onto the cheese-atlas texture,
// so neutral (white) leaves the texture as cheddar yellow. Elite shifts
// toward sharp orange-cheddar; jackpot toward bright creamy parmesan.
const _gemColor = new THREE.Color();
function _gemTier(value) {
  if (value >= 20) return { color: 0xfff5cc, scale: 2.4 };  // parmesan jackpot
  if (value >= 5)  return { color: 0xffa050, scale: 1.5 };  // sharp orange-cheddar elite
  return { color: 0xffffff, scale: 1.0 };                    // cheddar (texture base)
}

export function initXP(scene) {
  // Iter 33b — XP gem is a Quaternius cheese block (CC0, 968 tris, ~38 KB).
  // Pull geometry + atlas texture out of the cached GLB, then build a cheap
  // unlit BasicMaterial so we keep one draw call for the whole gem field.
  // Geometry is scaled once to gem footprint; tier.scale multiplies on top.
  let geo, baseMap = null;
  const gltf = GLTF_CACHE.cheese;
  if (gltf && gltf.scene) {
    gltf.scene.traverse(o => {
      if (o.isMesh && !geo) {
        geo = o.geometry.clone();
        if (o.material && o.material.map) baseMap = o.material.map;
      }
    });
    if (geo) {
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      const maxDim = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) || 1;
      const s = (XP.gemSize * 2.1) / maxDim;
      geo.scale(s, s, s);
      // Center on origin so per-slot yaw spins around the cube's center.
      geo.computeBoundingBox();
      const cx = (geo.boundingBox.max.x + geo.boundingBox.min.x) / 2;
      const cy = (geo.boundingBox.max.y + geo.boundingBox.min.y) / 2;
      const cz = (geo.boundingBox.max.z + geo.boundingBox.min.z) / 2;
      geo.translate(-cx, -cy, -cz);
    }
  }
  // Fallback to triangular prism if the GLB didn't load — keeps the game
  // playable even if the cheese asset is missing.
  if (!geo) {
    geo = new THREE.CylinderGeometry(XP.gemSize * 1.15, XP.gemSize * 1.15, XP.gemSize * 0.55, 3);
  }
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff,           // white base — texture + per-instance color tint it
    map: baseMap,
    transparent: true,
    opacity: 1.0,
  });
  const inst = new THREE.InstancedMesh(geo, mat, GEM_CAPACITY);
  inst.count = GEM_CAPACITY;
  inst.frustumCulled = false;
  inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Per-instance color allocation
  inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(GEM_CAPACITY * 3), 3);
  inst.instanceColor.setUsage(THREE.DynamicDrawUsage);

  // Hide all instances initially.
  _mat.compose(_pos.set(0, -1000, 0), _quat.identity(), _scaleZero);
  for (let i = 0; i < GEM_CAPACITY; i++) {
    inst.setMatrixAt(i, _mat);
    inst.setColorAt(i, _gemColor.setHex(0x44ffcc));
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.instanceColor.needsUpdate = true;

  state.gems.instMesh = inst;
  state.gems.list.length = 0;
  state.gems.nextSlot = 0;
  scene.add(inst);

  // ── Sparkle billboard layer ──
  // One twinkle plane per gem slot, painted flat. Adds a per-frame pulse
  // overlay so the gem field reads as "shimmering treasure" instead of
  // "100 static blue cubes". Still one draw call (InstancedMesh).
  const sparkleGeo = new THREE.PlaneGeometry(0.55, 0.55);
  const sparkleMat = new THREE.MeshBasicMaterial({
    map: tex('twinkle'),
    color: 0xffffff,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  _sparkleInst = new THREE.InstancedMesh(sparkleGeo, sparkleMat, GEM_CAPACITY);
  _sparkleInst.count = GEM_CAPACITY;
  _sparkleInst.frustumCulled = false;
  _sparkleInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _sparkleInst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(GEM_CAPACITY * 3), 3);
  _sparkleInst.instanceColor.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < GEM_CAPACITY; i++) {
    _sparkleInst.setMatrixAt(i, _mat); // already hidden
    _sparkleInst.setColorAt(i, _gemColor.setHex(0x44ffcc));
  }
  _sparkleInst.instanceMatrix.needsUpdate = true;
  _sparkleInst.instanceColor.needsUpdate = true;
  _sparkleInst.layers.enable(BLOOM_LAYER);
  scene.add(_sparkleInst);
}

export function dropGem(pos, value = 1) {
  const list = state.gems.list;

  // Try to reuse an inactive slot.
  let slot = -1;
  for (let i = 0; i < list.length; i++) {
    if (!list[i].active) { slot = i; break; }
  }

  if (slot === -1) {
    if (list.length >= GEM_CAPACITY) {
      // Over capacity — drop silently.
      return;
    }
    slot = list.length;
    list.push({
      pos: pos.clone(),
      value,
      active: true,
      magnetized: false,
      instanceIndex: slot,
      yaw: Math.random() * Math.PI * 2,
    });
  } else {
    const g = list[slot];
    g.pos.copy(pos);
    g.value = value;
    g.active = true;
    g.magnetized = false;
    g.instanceIndex = slot;
    g.yaw = Math.random() * Math.PI * 2;
  }

  const inst = state.gems.instMesh;
  const tier = _gemTier(list[slot].value);
  inst.setColorAt(slot, _gemColor.setHex(tier.color));
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  // Mirror the gem tier color onto the sparkle layer so the twinkle matches
  // (cyan gems sparkle cyan, magenta sparkles magenta, jackpot sparkles gold).
  if (_sparkleInst && _sparkleInst.instanceColor) {
    _sparkleInst.setColorAt(slot, _sparkleColor.setHex(tier.color));
    _sparkleInst.instanceColor.needsUpdate = true;
  }
  _placeInstance(slot, list[slot].pos, list[slot].value, list[slot].yaw);
}

function _triggerLevelUp() {
  const choices = weaponChoices(3 + ((state && state.run && state.run.casinoExtraChoices) || 0));
  state.levelUpChoices = choices;
  state.pendingLevelUp = true;
  showLevelUpModal(choices);
  sfx.levelUp && sfx.levelUp();
  try { flashLevelUp(); } catch (_) {}
}

export function updateGems(dt) {
  const list = state.gems.list;
  const inst = state.gems.instMesh;
  if (!inst) return;

  const hero = state.hero;
  const hx = hero.pos.x, hz = hero.pos.z;
  const pickupR = HERO.pickupRadius * hero.statMul.magnet;
  const pickupR2 = pickupR * pickupR;
  const maxSpd = XP.gemMagnetMaxSpeed;

  let anyPickup = false;

  for (let i = 0; i < list.length; i++) {
    const g = list[i];
    if (!g.active) continue;

    const dx = hx - g.pos.x;
    const dz = hz - g.pos.z;
    const d2 = dx * dx + dz * dz;

    if (!g.magnetized && d2 <= pickupR2) {
      g.magnetized = true;
      spawnMagnetSpark(g.pos.x, 0.3, g.pos.z);
    }

    let moved = false;

    if (g.magnetized) {
      // Direct-seek magnet — velocity always points exactly at hero, capped at
      // maxSpd. No tangential drift, no orbital decay, no spiral. Step clamped
      // to current distance so we never overshoot and miss the pickup window.
      const d = Math.sqrt(d2) || 1e-6;
      const nx = dx / d, nz = dz / d;
      const step = Math.min(maxSpd * dt, d);
      g.pos.x += nx * step;
      g.pos.z += nz * step;
      moved = true;

      // Pickup check (re-evaluate distance after move).
      const ddx = hx - g.pos.x;
      const ddz = hz - g.pos.z;
      if (ddx * ddx + ddz * ddz <= PICKUP_DIST_SQ) {
        // Shop growth + Crown passive + Soul Link XP-mul, all multiply on top.
        // Weekly XP_FAMINE mutator stacks here as a flat 0.7× scalar (iter 9).
        // Iter 33e — Catnip Rush run buff adds 50% XP for first 5 minutes.
        // P1H (2026-05-17) — Druid's Charm: forest-only XP boost. Absolute
        // (1 + bonus) write by passives.js; gated to forest so other arenas
        // read identity 1.0 (no bonus, no penalty).
        const catnipActive = state.run.casinoCatnipUntil && state.time.game < state.run.casinoCatnipUntil;
        const inForest = state.run.stage && state.run.stage.id === 'forest';
        const druidMul = inForest ? (state.run.passive_druidXpMul || 1) : 1;
        const xpMul = (1 + 0.08 * shopLevel('growth')) *
                      (1 + (state.run.passive_xpMul || 0)) *
                      (1 + (state.run.passive_soulLinkXpMul || 0)) *
                      (state.run.stageRuleXpMul || 1) *
                      (state.run.weeklyXpMul || 1) *
                      druidMul *
                      (catnipActive ? 1.5 : 1);
        hero.xp += g.value * xpMul;
        state.run.pickedGems++;
        // PHASE 4 P4J — telemetry pickup (counter bump, no allocation).
        try { telemetryEvent('pickup'); } catch (_) {}
        g.active = false;
        g.magnetized = false;
        _hideInstance(i);
        sfx.pickup && sfx.pickup();
        anyPickup = true;
        // Tutorial: first gem pickup primes stage 3.
        import('./tutorial.js').then(({ notifyTutorialEvent }) => notifyTutorialEvent('gemPickup'));
        continue;
      }
    }

    if (moved) {
      _placeInstance(i, g.pos, g.value, g.yaw);
    } else if (_sparkleInst) {
      // Idle gem: still repaint sparkle each frame so the twinkle pulses.
      // Cheaper than rewriting the gem matrix because we only touch the
      // sparkle billboard layer.
      const tier = _gemTier(g.value);
      const phase = g.pos.x * 0.7 + g.pos.z * 1.3;
      const pulse = 1.6 + 0.4 * Math.sin(state.time.game * 6 + phase);
      _sparkleScale.set(pulse * tier.scale, pulse * tier.scale, pulse * tier.scale);
      _pos.set(g.pos.x, g.pos.y + 0.15, g.pos.z);
      _mat.compose(_pos, _sparkleFlat, _sparkleScale);
      _sparkleInst.setMatrixAt(i, _mat);
      _sparkleDirty = true;
    }
  }

  // Soft cap on on-screen gems: if more than 60 are sitting around, force
  // the oldest 50% to magnetize regardless of distance. Stops the battlefield
  // from accumulating into "hundreds of blue cubes orbit forever" territory.
  let active = 0;
  for (let i = 0; i < list.length; i++) if (list[i].active) active++;
  if (active > 60) {
    let toForce = Math.floor(active * 0.5);
    for (let i = 0; i < list.length && toForce > 0; i++) {
      const g = list[i];
      if (g.active && !g.magnetized) {
        g.magnetized = true;
        toForce--;
      }
    }
  }

  // Level-up — Iter 32i batching. Drain all levels in one frame, count
  // them into pendingLevelCount, open a single modal sequence.
  if (anyPickup && hero.xp >= hero.xpNext) {
    let didLevel = false;
    while (hero.xp >= hero.xpNext) {
      hero.xp -= hero.xpNext;
      hero.level++;
      hero.xpNext = xpForLevel(hero.level);
      state.pendingLevelCount = (state.pendingLevelCount || 0) + 1;
      didLevel = true;
      // PHASE 4 P4J — telemetry levelup (per-level, not per-batch, so the
      // count matches state.hero.level - 1 at any point in the run).
      try { telemetryEvent('levelup'); } catch (_) {}
    }
    if (didLevel) {
      // Tutorial: stage 3 → 4 advance on first level-up.
      import('./tutorial.js').then(({ notifyTutorialEvent }) => notifyTutorialEvent('levelUp'));
      // Secret: Faster Than Light — reach level 10 in under 2 minutes
      if (!state.run.speedrunChecked && hero.level >= 10 && state.time.game < 120) {
        state.run.speedrunChecked = true;
        import('./ui.js').then(({ trySecret }) => trySecret('speedrun_lv10'));
      }
      // Vampire-Survivors-style vacuum: every gem still on the field rushes
      // the hero on a level-up. Satisfying "ka-chunk" beat + clears the screen.
      for (let i = 0; i < list.length; i++) {
        if (list[i].active) list[i].magnetized = true;
      }
      if (!state.pendingLevelUp) _triggerLevelUp();
    }
  }

  if (_matrixDirty) {
    inst.instanceMatrix.needsUpdate = true;
    _matrixDirty = false;
  }
  if (_sparkleDirty && _sparkleInst) {
    _sparkleInst.instanceMatrix.needsUpdate = true;
    _sparkleDirty = false;
  }
}

export function applyLevelUpChoice(choice) {
  // Sprite FX: ground-anchored aura burst on every level-up choice. Uses
  // the non-looping 'burst' anim (atlas extended this round — see
  // assets/sprites/fx/aura_rings_v1.json; 'idle' is loop:true and would
  // never expire). Pool cap 16, never bypassed on low-fx (it's a milestone
  // moment, not per-frame combat noise). Returns -1 if atlas not loaded
  // yet — safe no-op. try/catch so a sprite fault doesn't break the
  // level-up cascade.
  try {
    const hero = state.hero;
    if (hero && hero.pos) {
      spawnSprite('fx/aura_rings_v1', {
        x: hero.pos.x,
        y: 0.05,
        z: hero.pos.z,
        scale: 2.5,
        anim: 'burst',
      });
    }
  } catch (_) {}

  if (choice && choice.kind === 'weapon') {
    acquireWeapon(choice.id);
    try { import('./codex.js').then(({ notifyWeaponPicked }) => notifyWeaponPicked(choice.id)); } catch (_) {}
  } else if (choice && choice.kind === 'filler') {
    applyFiller(choice);
  } else if (choice && choice.kind === 'evolution') {
    applyEvolution(choice.id);
    // codex.evolutions is stamped from applyEvolution (weapons/index.js).
  } else if (choice && choice.kind === 'passive') {
    import('./weapons/passives.js').then(({ applyPassive }) => applyPassive(choice));
    try { import('./codex.js').then(({ notifyPassivePicked }) => notifyPassivePicked(choice.id)); } catch (_) {}
  }

  // Iter 32i — batch cascade. We already drained XP into pendingLevelCount
  // when the level-up loop fired. Each applyLevelUpChoice consumes ONE of
  // those queued levels. If more remain, immediately re-open the modal with
  // a fresh weapon-choice roll. Game stays paused throughout (modal-style),
  // no game-unpause between picks.
  state.pendingLevelCount = Math.max(0, (state.pendingLevelCount || 1) - 1);
  state.levelUpChoices.length = 0;
  hideLevelUpModal();

  if (state.pendingLevelCount > 0) {
    // Still queued — re-roll + re-open in place.
    state.pendingLevelUp = true;
    state.levelUpChoices = weaponChoices(3 + ((state && state.run && state.run.casinoExtraChoices) || 0));
    showLevelUpModal(state.levelUpChoices);
  } else {
    state.pendingLevelUp = false;
  }
}
