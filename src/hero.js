/**
 * Hero: spawn, movement, damage, level-up trigger.
 */
import * as THREE from 'three';
import { state, xpForLevel } from './state.js';
import { HERO, DASH, JUMP, CHARACTERS } from './config.js';
import { cloneCached, upgradeMaterials } from './assets.js';
import { selectedCharacter } from './meta.js';
import { sfx } from './audio.js';
import { showDeathScreen, showLevelUpModal, flashDamage, flashLevelUp } from './ui.js';
import { weaponChoices } from './weapons/index.js';
import { isDashPressed, consumeJump } from './input.js';
import { queryRadius, damageEnemy } from './enemies.js';
import { spawnKillRing } from './fx.js';
import { spawnDashStreak } from './vfxBurst.js';
import { smashLogsInRadius } from './destructibles.js';
import { spawnHeroDamageNumber } from './damageNumbers.js';

const _tmpDir = new THREE.Vector3();

// ── Mirror Step (Dash evolution) ──────────────────────────────────────────
// Shared geometry/material caches for the ghost-twin orbital burst.
const _GHOST_CORE_GEO = new THREE.SphereGeometry(0.18, 8, 8);
const _GHOST_CORE_MAT = new THREE.MeshBasicMaterial({ color: 0xff5cd0 });
const _GHOST_HALO_GEO = new THREE.SphereGeometry(0.55, 12, 10);
const _GHOST_HALO_MAT = new THREE.MeshBasicMaterial({
  color: 0xff5cd0, transparent: true, opacity: 0.35, depthWrite: false,
});
// Tracks live ghost-twin visuals so updateHero can fade them.
const _mirrorGhosts = [];

function spawnMirrorStepGhost(x, z) {
  // Visual: a magenta halo + core at the dash-start position. Lives ~0.5s
  // and shrinks/fades. Doesn't collide — purely decorative.
  const group = new THREE.Group();
  const core = new THREE.Mesh(_GHOST_CORE_GEO, _GHOST_CORE_MAT);
  const halo = new THREE.Mesh(_GHOST_HALO_GEO, _GHOST_HALO_MAT.clone());
  group.add(core);
  group.add(halo);
  group.position.set(x, 0.6, z);
  state.scene.add(group);
  _mirrorGhosts.push({ group, halo: halo.material, t: 0, life: 0.55 });

  // Orbital burst: 8 magenta projectiles radiating outward. Uses the same
  // state.projectiles.active list so the central tick handles motion/hits.
  const COUNT = 8;
  const SPEED = 18;
  const DMG = 25;
  const TTL = 0.7;
  for (let i = 0; i < COUNT; i++) {
    const a = (i / COUNT) * Math.PI * 2;
    const dir = { x: Math.cos(a), z: Math.sin(a) };
    const m = new THREE.Group();
    const c = new THREE.Mesh(_GHOST_CORE_GEO, _GHOST_CORE_MAT);
    m.add(c);
    m.position.set(x, 0.5, z);
    state.scene.add(m);
    state.projectiles.active.push({
      mesh: m,
      vel: new THREE.Vector3(dir.x * SPEED, 0, dir.z * SPEED),
      dmg: DMG * (state.hero.statMul.dmg || 1),
      ttl: TTL,
      pierce: 2,
      hit: new Set(),
      ownerWeapon: 'mirror_step',
    });
  }
}

function _tickMirrorGhosts(dt) {
  for (let i = _mirrorGhosts.length - 1; i >= 0; i--) {
    const g = _mirrorGhosts[i];
    g.t += dt;
    const k = g.t / g.life;
    if (k >= 1) {
      state.scene.remove(g.group);
      _mirrorGhosts.splice(i, 1);
      continue;
    }
    const fade = 1 - k;
    if (g.halo) g.halo.opacity = 0.35 * fade;
    g.group.scale.setScalar(1 + k * 0.6);
  }
}

export function initHero(scene) {
  const group = new THREE.Group();
  group.name = 'heroGroup';

  // Bright cyan base marker — always visible, sits at hero feet so you can
  // never lose the hero even if the GLB fails to load.
  const marker = new THREE.Mesh(
    new THREE.CylinderGeometry(0.6, 0.8, 0.15, 16),
    new THREE.MeshBasicMaterial({ color: 0x44ffcc })
  );
  marker.position.y = 0.08;
  group.add(marker);

  const mesh = cloneCached('hero');
  if (mesh) {
    // Hero is plush fabric — high roughness, no metalness sheen.
    upgradeMaterials(mesh, 0.55, 0.92);
    // Auto-fit: measure native bbox, derive scale = targetHeight / bbox.y.
    // Survives GLB re-exports with different units (the 0.06→4.0 drift saga).
    const rawBox = new THREE.Box3().setFromObject(mesh);
    const rawSize = rawBox.getSize(new THREE.Vector3());
    const autoFit = rawSize.y > 1e-6 ? HERO.targetHeight / rawSize.y : 1;
    // Per-character placeholder differentiation (tint + scale). Until each
    // character gets a real model, we recolor the shared GLB.
    const char = selectedCharacter(CHARACTERS);
    const charScale = char && char.scaleMul ? char.scaleMul : 1;
    const charTint = char && char.tint != null ? char.tint : 0xffffff;
    mesh.scale.setScalar(autoFit * HERO.scale * charScale);
    mesh.position.set(0, HERO.yOffset, 0);
    let meshCount = 0;
    const _tint = new THREE.Color(charTint);
    mesh.traverse((o) => {
      if (o.isMesh) {
        meshCount++;
        o.castShadow = true;
        o.receiveShadow = false;
        o.frustumCulled = false;
        if (charTint !== 0xffffff && o.material && o.material.color) {
          // Materials are cached & shared across clones; clone before tinting
          // so we don't pollute the cache for future re-spawns/other chars.
          o.material = o.material.clone();
          o.material.color.multiply(_tint);
        }
      }
    });
    group.add(mesh);
    _innerMesh = mesh;
    _baseInnerY = mesh.position.y;
    _baseScale = mesh.scale.x;
    const box = new THREE.Box3().setFromObject(mesh);
    const size = box.getSize(new THREE.Vector3());
    console.log(`[hero] GLB loaded — ${meshCount} mesh(es), raw bbox.y=${rawSize.y.toFixed(3)}, autoFit=${autoFit.toFixed(3)}, final size: ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}`);
  } else {
    // Hero GLB didn't load — make the marker tower-shaped so it's obvious
    const fallback = new THREE.Mesh(
      new THREE.ConeGeometry(0.7, 2.2, 8),
      new THREE.MeshLambertMaterial({ color: 0xff44cc, emissive: 0x441133 })
    );
    fallback.position.y = 1.1;
    group.add(fallback);
    console.warn('[hero] tower-castle.glb missing — using fallback cone');
  }

  scene.add(group);
  state.hero.mesh = group;
  state.hero.pos = new THREE.Vector3(0, 0, 0);
  state.hero.vel.set(0, 0, 0);
  state.hero.facing.set(0, 0, 1);
}

/**
 * Re-create the hero mesh for the currently-selected character. Called when
 * the player picks a different character on the start screen, and on restart.
 * Cheap: GLB is cached, only does a clone + re-add.
 */
export function rebuildHero(scene) {
  if (state.hero.mesh && state.hero.mesh.parent) {
    state.hero.mesh.parent.remove(state.hero.mesh);
  }
  state.hero.mesh = null;
  _innerMesh = null;
  initHero(scene);
}

// Camera is at (+X, +Y, +Z) looking at hero — yaw 45°. Remap input axes to
// align with what the player sees on screen instead of raw world XZ.
const SQRT_HALF = 0.7071067811865476;

// Procedural walk animation state
let _stepPhase = 0;
let _innerMesh = null;     // the GLB child of state.hero.mesh (excludes the disc marker)
let _baseInnerY = 0;
let _baseScale = 1;        // captured at init after auto-fit, used by death anim

export function updateHero(dt) {
  const h = state.hero;
  const mv = state.input.moveVec;

  // Isometric input remap: screen up = world -X-Z, screen right = world +X-Z.
  let speedMul = h.statMul.moveSpeed || 1;
  if (h.dashCD > 0) h.dashCD -= dt;

  // Pummarola passive: continuous HP regen (capped at hpMax). Cheap, no alloc.
  // Iter 11 — Shop Tree Live Wires: Survival tier 3 "Regeneration" adds
  // passive_regen HP/sec on top of Pummarola so the two stack additively
  // (a player with both gets regenPerSec + passive_regen per second).
  const _regenRate = (h.regenPerSec || 0) + (state.run.passive_regen || 0);
  if (_regenRate > 0 && h.hp > 0 && h.hp < h.hpMax && !state.gameOver) {
    h.hp = Math.min(h.hpMax, h.hp + _regenRate * dt);
  }

  // Dash trigger
  if (h.dashUnlocked && h.dashLevel > 0 && h.dashCD <= 0 && state.time.real >= h.dashUntil && isDashPressed()) {
    const cfg = DASH.levels[Math.min(h.dashLevel, DASH.levels.length - 1)];
    if (cfg) {
      // Air-dash combo: if jumping/airborne at dash start, lock a 0.4s phase
      // dash that ignores gravity. Reads as a true "blink forward in air" beat
      // — pre-evolution flavor of a phase dash.
      const isAirborne = !h.grounded || h.pos.y > 0.01;
      const dur = isAirborne ? Math.max(cfg.duration, 0.4) : cfg.duration;
      h.dashUntil = state.time.real + dur;
      h._airDashUntil = isAirborne ? state.time.real + dur : 0;
      // Mirror Step (dash evolution): −25% dash cooldown + spawn a ghost twin
      // at the start position that fires one orbital burst before fading.
      const cdMul = h.dashEvolved ? 0.75 : 1.0;
      h.dashCD = cfg.cooldown * cdMul;
      if (h.dashEvolved) {
        try { spawnMirrorStepGhost(h.pos.x, h.pos.z); } catch (_) {}
      }
      if (sfx && sfx.weaponDash) sfx.weaponDash();
      h.iFramesUntil = state.time.game + cfg.iFrames;
      if (isAirborne) {
        h.velY = 0;             // freeze vertical motion at dash start
      }
      // Dash direction: current move input, or facing if idle
      const ix = mv.x, iy = mv.y;
      if (ix * ix + iy * iy > 0.01) {
        h.dashDir.x = (ix + iy) * SQRT_HALF;
        h.dashDir.z = (iy - ix) * SQRT_HALF;
        const dl = Math.hypot(h.dashDir.x, h.dashDir.z) || 1;
        h.dashDir.x /= dl; h.dashDir.z /= dl;
      }
      // else: keep last dashDir (or facing); state.hero.facing is already a unit XZ vector
      if (h.facing && (h.facing.x || h.facing.z) && ix*ix+iy*iy < 0.01) {
        h.dashDir.x = h.facing.x; h.dashDir.z = h.facing.z;
      }
      state.fx.shake = Math.max(state.fx.shake, 0.35);
    }
  }

  // Apply dash speed boost + knock+damage to nearby enemies on each dashing frame
  const dashing = state.time.real < h.dashUntil;
  if (dashing) {
    const cfg = DASH.levels[Math.min(h.dashLevel, DASH.levels.length - 1)];
    if (cfg) {
      // Motion trail — one stretched additive plane behind the hero per frame.
      // Mirror Step recolors the dash trail magenta.
      const trailColor = h.dashEvolved ? 0xff5cd0 : 0x7fffe4;
      try { spawnDashStreak(h.pos.x, h.pos.z, h.dashDir.x, h.dashDir.z, trailColor); } catch (_) {}
      speedMul *= cfg.speedMul;
      // Hit enemies within radius around hero this frame
      try {
        const cands = queryRadius(h.pos, cfg.radius);
        for (const e of cands) {
          if (!e || !e.alive) continue;
          if (e._dashedThisDash === h.dashUntil) continue; // hit once per dash
          e._dashedThisDash = h.dashUntil;
          e.knockVx = h.dashDir.x * cfg.knockback;
          e.knockVz = h.dashDir.z * cfg.knockback;
          damageEnemy(e, cfg.dmg, 'dash');
        }
        // Smash any breakable logs the dash sweeps through.
        smashLogsInRadius(h.pos.x, h.pos.z, cfg.radius);
      } catch (_) {}
    }
  }

  // Stage hazard slow (pollen drifts, etc.) — read by hero movement.
  const hazardSlow = h.hazardSlow || 1;
  // Grothar Engulf 1.0s slow flag (set by bossTelegraphs.js on resolve).
  if (state.run.signature_engulfSlowUntil && state.run.signature_engulfSlowUntil > state.time.game) speedMul *= 0.5;
  // Frosted-affix aura slow (set per-frame by enemies.js agent 8a; defaults to 1).
  if (state.run.affix_frostSlow) speedMul *= state.run.affix_frostSlow;
  const speed = HERO.speed * speedMul * hazardSlow;
  // While dashing, override input direction with the locked dashDir
  const dx = dashing ? h.dashDir.x : (mv.x + mv.y) * SQRT_HALF;
  const dz = dashing ? h.dashDir.z : (mv.y - mv.x) * SQRT_HALF;
  const vx = dx * speed;
  const vz = dz * speed;
  h.vel.set(vx, 0, vz);

  h.pos.x += vx * dt;
  h.pos.z += vz * dt;

  // ── Jump / gravity ──
  if (consumeJump() && h.grounded) {
    h.velY = JUMP.velocity;
    h.grounded = false;
  }
  // While an air-dash is active, freeze the hero at current altitude (no
  // gravity). When it expires, gravity resumes naturally for the rest of the
  // jump arc.
  const airDashing = h._airDashUntil && state.time.real < h._airDashUntil;
  if (airDashing) {
    h.velY = 0;
    h.grounded = false;
  } else if (!h.grounded || h.pos.y > JUMP.groundY) {
    h.velY += JUMP.gravity * dt;
    h.pos.y += h.velY * dt;
    if (h.pos.y <= JUMP.groundY) {
      // Landing — capture velY for squash strength, then ground.
      const impact = Math.min(1.0, -h.velY / 12);
      if (impact > 0.05) {
        h._squashUntil = state.time.real + 0.18;
        h._squashStrength = impact;
      }
      h.pos.y = JUMP.groundY;
      h.velY = 0;
      h.grounded = true;
    }
  } else {
    h.pos.y = JUMP.groundY;
  }

  if (h.mesh) {
    h.mesh.position.set(h.pos.x, HERO.yOffset + h.pos.y, h.pos.z);

    // Face move direction + procedural walk animation
    const mag2 = vx * vx + vz * vz;
    if (mag2 > 1e-4) {
      _tmpDir.set(vx, 0, vz).normalize();
      h.facing.copy(_tmpDir);
      const yaw = Math.atan2(vx, vz);
      h.mesh.rotation.y = yaw;

      // Step phase advances faster the faster we walk
      const mag = Math.sqrt(mag2);
      _stepPhase += mag * dt * 1.6;
    } else {
      _stepPhase += dt * 0.5;  // gentle idle breathing
    }

    if (_innerMesh) {
      const moving = mag2 > 1e-4;
      // Airborne: zero out the step bob/sway, lean into velocity for "leap" feel.
      const airFactor = h.grounded ? 1.0 : 0.15;
      const bob = (moving ? Math.abs(Math.sin(_stepPhase * Math.PI)) * 0.25
                          : Math.sin(_stepPhase) * 0.04) * airFactor;
      _innerMesh.position.y = _baseInnerY + bob;
      // Tilt forward into movement direction (about local X axis)
      const tilt = (moving ? 0.18 : 0) * airFactor + (h.grounded ? 0 : 0.10);
      _innerMesh.rotation.x = tilt;
      // Side-to-side sway each step (about local Z axis)
      const sway = (moving ? Math.sin(_stepPhase * Math.PI) * 0.10 : 0) * airFactor;
      _innerMesh.rotation.z = sway;

      // Landing squash — brief Y-flatten + X-bulge after a high-velocity ground hit
      if (h._squashUntil && state.time.real < h._squashUntil) {
        const k = (h._squashUntil - state.time.real) / 0.18;   // 1→0
        const amt = (h._squashStrength || 0.5) * k;
        _innerMesh.scale.y = _baseScale * (1 - amt * 0.25);
        _innerMesh.scale.x = _baseScale * (1 + amt * 0.15);
        _innerMesh.scale.z = _baseScale * (1 + amt * 0.15);
      } else if (h._squashUntil) {
        // Restore once expired
        _innerMesh.scale.set(_baseScale, _baseScale, _baseScale);
        h._squashUntil = 0;
      }
    }

    // I-frame flicker
    if (state.time.game < h.iFramesUntil) {
      const phase = Math.floor(state.time.real * 1000 / 80) % 2;
      h.mesh.visible = phase === 0;
    } else if (!h.mesh.visible) {
      h.mesh.visible = true;
    }
  }

  // Mirror Step: tick the ghost-twin visuals (fade/scale out).
  _tickMirrorGhosts(dt);

  // Level-up check (loop to handle multi-level XP gains)
  while (h.xp >= h.xpNext && !state.pendingLevelUp) {
    h.xp -= h.xpNext;
    h.level += 1;
    h.xpNext = xpForLevel(h.level);
    state.pendingLevelUp = true;
    state.levelUpChoices = weaponChoices(3);
    showLevelUpModal(state.levelUpChoices);
    if (sfx && sfx.levelUp) sfx.levelUp();
    try { flashLevelUp(); } catch (_) {}
  }
}

export function takeDamage(amt) {
  const h = state.hero;
  if (state.time.game < h.iFramesUntil) return;
  if (state.gameOver) return;

  // Armor passive multiplier (lower = less damage taken; capped at 0.40)
  let dmgMul = (h.statMul && h.statMul.dmgTaken) ? h.statMul.dmgTaken : 1;
  // Sanctum (Sticky Web evolution): −30% damage while standing in any
  // burning web. Flag refreshed every web tick — see weapons/web.js.
  if (h.inSanctum) dmgMul *= 0.7;
  // Iter 11 — Shop Tree Live Wires: Survival tier 1 "Iron Skin" wires
  // passive_dmgReduction (additive 0..1, cap 0.75) into incoming damage.
  // Composes multiplicatively with the existing dmgTaken multiplier so a
  // run with Armor + Iron Skin stacks gracefully. Must run BEFORE Nine Lives
  // consumption below so the signature consumes a post-DR lethal hit.
  if (state.run.passive_dmgReduction > 0) {
    dmgMul *= (1 - Math.min(0.75, state.run.passive_dmgReduction));
  }
  amt = amt * dmgMul;
  h.hp -= amt;
  h.iFramesUntil = state.time.game + HERO.iFramesSec;
  state.run.dmgTaken += amt;
  state.run.flawless = false;
  state.run.noDmgKills = 0;
  // Damage-scaled feedback: small hits = subtle, big hits = jarring.
  const sev = Math.min(1, amt / 30);          // 30 dmg → max severity
  state.fx.chromaticPulse = 0.4 + 0.6 * sev;
  if (state.fx.shake < 0.30 + 0.30 * sev) state.fx.shake = 0.30 + 0.30 * sev;
  // Deeper "ouch" SFX for harder hits. Wired in audio.js.
  try { flashDamage(sev); } catch (_) {}
  if (sfx && sfx.heroHurt) sfx.heroHurt();
  try { spawnHeroDamageNumber(amt); } catch (_) {}

  if (h.hp <= 0) {
    // ── Kitty "Nine Lives" signature: first lethal hit becomes 1 HP + i-frame.
    // Skipped if Shop Tree Second Wind already grants a revive — prevents
    // double-stacking the survival comeback (see ITER_789_BRIEFS.md risk flag).
    if (
      state.run.signature_nineLives === true &&
      !state.run.signature_nineLivesUsed &&
      !state.run.passive_revives
    ) {
      h.hp = 1;
      h.iFramesUntil = (state.time.game + HERO.iFramesSec) + 1.5;
      state.run.signature_nineLivesUsed = true;
      return;
    }

    // ── Phoenix "Ember Burst" signature: on death, emit a one-shot AoE before
    // routing to the death screen. Fires exactly once per run.
    if (state.run.signature_emberBurst) {
      state.run.signature_emberBurst = false;
      try {
        const hp = state.hero.pos;
        const targets = queryRadius(hp, 10) || [];
        for (const e of targets) {
          if (!e || !e.alive || !e.mesh) continue;
          // Knockback: normalized direction away from hero × 16
          const dx = e.mesh.position.x - hp.x;
          const dz = e.mesh.position.z - hp.z;
          const len = Math.hypot(dx, dz) || 1;
          e.knockVx = (dx / len) * 16;
          e.knockVz = (dz / len) * 16;
          damageEnemy(e, 200, 'phoenix');
        }
      } catch (err) { console.warn('[phoenix emberBurst]', err); }
    }

    h.hp = 0;
    state.gameOver = true;
    state.dyingUntil = state.time.real + 1.4;
    state.fx.shake = 1.0;
    state.fx.chromaticPulse = 1;
    if (sfx && sfx.heroDeath) sfx.heroDeath();
    // death screen deferred until anim plays out — see updateDeathAnim
  }
}

// Animate hero during the 1.4s death window: squash, spin, fade. Called from
// main.js even while gameOver is true (so the world freezes around the anim).
export function updateDeathAnim(realDt) {
  if (!_innerMesh || !state.gameOver) return;
  const remain = state.dyingUntil - state.time.real;
  const total = 1.4;
  const k = 1 - Math.max(0, Math.min(1, remain / total));   // 0..1 progress
  if (state.victory) {
    // Victory: hop + spin + bright stay (no fade, no sink)
    const hop = Math.sin(k * Math.PI) * 1.6;
    _innerMesh.position.y = _baseInnerY + hop;
    _innerMesh.rotation.y += realDt * 8;
    _innerMesh.scale.set(_baseScale, _baseScale * (1 + hop * 0.15), _baseScale);
  } else {
    // Defeat: squash, sink, fade
    const sxz = 1 + Math.sin(k * Math.PI) * 0.4 - k * 0.35 + Math.sin(k * Math.PI * 4) * 0.05;
    const sy  = 1 + Math.cos(k * Math.PI) * 0.3 - k * 0.6;
    _innerMesh.scale.set(_baseScale * sxz, _baseScale * sy, _baseScale * sxz);
    _innerMesh.rotation.y += realDt * (8 + k * 14);
    _innerMesh.rotation.z = Math.sin(k * Math.PI * 2) * 0.5;
    _innerMesh.position.y = _baseInnerY - k * 0.8;
    _innerMesh.traverse(o => {
      if (o.isMesh && o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (!m.transparent) { m.transparent = true; m.depthWrite = false; }
          m.opacity = Math.max(0, 1 - k * 1.15);
        }
      }
    });
  }
  if (remain <= 0 && !state._deathShown) {
    state._deathShown = true;
    showDeathScreen();
  }
}
