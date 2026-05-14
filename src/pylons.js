/**
 * Shock Pylon — area-denial combat destructible.
 *
 * Stationary, 300 HP. Cycles: 2.0s wind-up telegraph (ring grows from 0 to 6u),
 * 0.3s snap (shockwave executes, hero in range eats damage + knockback), 1.5s
 * rest. Forces the player to either close + break the pylon, or weave its
 * pulse windows. 2 per run, first wave at t=2:00.
 *
 * Piggybacks on state.enemies.active with isPylon:true. Movement + contact
 * gated in enemies.js. killEnemy branches to onPylonKilled.
 */
import * as THREE from 'three';
import { state } from './state.js';
import { grantEmbers } from './meta.js';
import { takeDamage as heroTakeDamage } from './hero.js';
import { makeRuneRingTexture } from './enemyTells.js';
import { tex } from './particleTextures.js';

let _pylonRuneTex = null;
function _getPylonRuneTex() { return _pylonRuneTex || (_pylonRuneTex = makeRuneRingTexture()); }

const PYLON_HP = 300;
const PULSE_RADIUS = 6.0;
const PULSE_DAMAGE = 12;
const PHASE_CHARGE = 2.0;
const PHASE_SNAP = 0.3;
const PHASE_REST = 1.5;
const RESPAWN_DELAY = 25.0;
const DIST_FROM_HERO_MIN = 24;
const DIST_FROM_HERO_MAX = 38;

let _scene = null;

function _pickPylonPos() {
  const hp = state.hero.pos;
  for (let attempt = 0; attempt < 12; attempt++) {
    const a = Math.random() * Math.PI * 2;
    const r = DIST_FROM_HERO_MIN + Math.random() * (DIST_FROM_HERO_MAX - DIST_FROM_HERO_MIN);
    const x = hp.x + Math.cos(a) * r;
    const z = hp.z + Math.sin(a) * r;
    let tooClose = false;
    for (const p of state.pylons.list) {
      if (!p.alive) continue;
      const dx = p.mesh.position.x - x;
      const dz = p.mesh.position.z - z;
      if (dx * dx + dz * dz < 144) { tooClose = true; break; }
    }
    // Also avoid stacking on totems
    if (!tooClose && state.totems) {
      for (const t of state.totems.list) {
        if (!t.alive) continue;
        const dx = t.mesh.position.x - x;
        const dz = t.mesh.position.z - z;
        if (dx * dx + dz * dz < 100) { tooClose = true; break; }
      }
    }
    if (!tooClose) return { x, z };
  }
  const a = Math.random() * Math.PI * 2;
  return { x: hp.x + Math.cos(a) * 28, z: hp.z + Math.sin(a) * 28 };
}

function _makePylonMesh() {
  const g = new THREE.Group();
  // Base cog
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(1.0, 1.2, 0.45, 12),
    new THREE.MeshStandardMaterial({ color: 0x3a3a48, roughness: 0.65, metalness: 0.5 }),
  );
  base.position.y = 0.22;
  base.castShadow = true; base.receiveShadow = true;
  g.add(base);
  // Central column (octagonal-ish)
  const column = new THREE.Mesh(
    new THREE.CylinderGeometry(0.45, 0.55, 2.2, 8),
    new THREE.MeshStandardMaterial({ color: 0x2c2c38, roughness: 0.55, metalness: 0.65 }),
  );
  column.position.y = 1.4;
  column.castShadow = true;
  g.add(column);
  // Two side prongs (forks)
  for (const sx of [-1, 1]) {
    const prong = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 1.6, 0.16),
      new THREE.MeshStandardMaterial({ color: 0x3a3a48, roughness: 0.55, metalness: 0.7 }),
    );
    prong.position.set(sx * 0.6, 1.7, 0);
    prong.rotation.z = sx * 0.18;
    prong.castShadow = true;
    g.add(prong);
  }
  // Capacitor orb — emissive cyan
  const orb = new THREE.Mesh(
    new THREE.SphereGeometry(0.42, 16, 12),
    new THREE.MeshStandardMaterial({
      color: 0x4fd0ff, emissive: 0x4fd0ff, emissiveIntensity: 1.4, roughness: 0.3,
    }),
  );
  orb.position.y = 2.7;
  g.add(orb);
  g.userData._orb = orb;
  // Telegraph ring — textured rune disc (canonical magic-AoE art), grows
  // during charge phase. Reads as inscribing spell circle vs a flat donut.
  const tellRing = new THREE.Mesh(
    new THREE.PlaneGeometry(2.0, 2.0),
    new THREE.MeshBasicMaterial({
      map: _getPylonRuneTex(),
      color: 0x4fd0ff, transparent: true, opacity: 0.55,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }),
  );
  tellRing.rotation.order = 'YXZ';   // yaw first so spin (rotation.y) reads in world space
  tellRing.rotation.x = -Math.PI / 2;
  tellRing.position.y = 0.05;
  tellRing.scale.setScalar(0.001);
  tellRing.userData.spinPhase = Math.random() * Math.PI * 2;
  g.add(tellRing);
  g.userData._tellRing = tellRing;
  // Glow halo (around orb) — textured radial glow with a sparkle overlay.
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(2.4, 2.4),
    new THREE.MeshBasicMaterial({
      map: tex('glowCyan'),
      color: 0x4fd0ff, transparent: true, opacity: 0.55,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }),
  );
  halo.position.y = 2.7;
  g.add(halo);
  g.userData._halo = halo;
  // Capacitor sparkle — small twinkle that flicks as the pylon charges.
  const sparkle = new THREE.Mesh(
    new THREE.PlaneGeometry(1.0, 1.0),
    new THREE.MeshBasicMaterial({
      map: tex('twinkle'),
      color: 0xeaf6ff, transparent: true, opacity: 0.0,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }),
  );
  sparkle.position.y = 2.7;
  g.add(sparkle);
  g.userData._sparkle = sparkle;
  // Cyan accent light
  const pl = new THREE.PointLight(0x4fd0ff, 1.4, 9, 2);
  pl.position.y = 2.7;
  g.add(pl);
  g.userData._light = pl;
  return g;
}

function _spawnOne() {
  const pos = _pickPylonPos();
  const mesh = _makePylonMesh();
  mesh.position.set(pos.x, 0, pos.z);
  _scene.add(mesh);
  const pylon = {
    mesh, glbKey: '__pylon__',
    hp: PYLON_HP, hpMax: PYLON_HP,
    spd: 0, dmg: 0,
    contactCooldown: Infinity,
    elite: false, isFinalBoss: false, isMiniBoss: false,
    isPylon: true, faceYaw: 0,
    alive: true, _spatialKey: null,
    knockVx: 0, knockVz: 0, slowMul: 1,
    _dotDps: 0, _dotUntil: 0, _flashUntil: 0, _wasFlashing: false,
    procAnim: null, ranged: null, rangedCD: 0,
    _animPhase: 0, _baseY: 0, _baseScale: 1,
    // Pulse-cycle state machine
    phase: 'rest', phaseT: PHASE_REST * 0.5,
  };
  state.enemies.spatial.insert(pylon);
  state.enemies.active.push(pylon);
  state.pylons.list.push(pylon);
  return pylon;
}

export function onPylonKilled(pylon) {
  if (!pylon) return;
  if (pylon.mesh && pylon.mesh.parent) pylon.mesh.parent.remove(pylon.mesh);
  try { grantEmbers(2); } catch (_) {}
  import('./chest.js').then(({ spawnChest }) => spawnChest(pylon.mesh.position.x, pylon.mesh.position.z));
  const i = state.pylons.list.indexOf(pylon);
  if (i >= 0) state.pylons.list.splice(i, 1);
  state.pylons.respawnQueue.push({ at: state.time.game + RESPAWN_DELAY });
}

export function initPylons(scene) { _scene = scene; }

function _resolveSnap(p) {
  const hp = state.hero.pos;
  const dx = hp.x - p.mesh.position.x;
  const dz = hp.z - p.mesh.position.z;
  const d2 = dx * dx + dz * dz;
  if (d2 <= PULSE_RADIUS * PULSE_RADIUS) {
    try { heroTakeDamage(PULSE_DAMAGE); } catch (_) {}
    // Knock the hero outward from the pylon
    const d = Math.max(0.001, Math.sqrt(d2));
    state.hero.pos.x = p.mesh.position.x + (dx / d) * (PULSE_RADIUS + 0.4);
    state.hero.pos.z = p.mesh.position.z + (dz / d) * (PULSE_RADIUS + 0.4);
  }
  state.fx.shake = Math.max(state.fx.shake || 0, 0.35);
  // Spark layer — use existing burst module for a small additive flash
  import('./vfxBurst.js').then(({ burstExplosion }) =>
    burstExplosion(p.mesh.position.x, p.mesh.position.z, PULSE_RADIUS, 0x4fd0ff)
  ).catch(() => {});
}

export function tickPylons(dt) {
  if (!_scene) return;
  if (state.mode !== 'run') return;
  // Hold pylon spawns until armedAt (default t=2:00). Lets the early run breathe.
  if (state.time.game < state.pylons.armedAt) return;
  if (!state.pylons.initialized) {
    state.pylons.initialized = true;
    for (let i = 0; i < state.pylons.target; i++) _spawnOne();
  }
  for (let i = state.pylons.respawnQueue.length - 1; i >= 0; i--) {
    if (state.time.game >= state.pylons.respawnQueue[i].at) {
      _spawnOne();
      state.pylons.respawnQueue.splice(i, 1);
    }
  }
  const t = state.time.real;
  for (const p of state.pylons.list) {
    if (!p.alive) continue;
    p.phaseT += dt;
    // Idle orb glow flicker
    if (p.mesh.userData._orb) {
      p.mesh.userData._orb.material.emissiveIntensity = 1.0 + 0.4 * Math.sin(t * 5 + p.mesh.position.x);
    }
    // Rune ring slowly spins during charge so the ticks visibly inscribe
    // the spell circle. Euler order is YXZ on the ring — rotation.y is the
    // world-up yaw because it composes BEFORE the -π/2 X-flip.
    const tell = p.mesh.userData._tellRing;
    if (tell) tell.rotation.y = (tell.userData.spinPhase || 0) + t * 0.6;
    // Sparkle flick — random small flash, brighter when phase is 'charge'.
    const sp = p.mesh.userData._sparkle;
    if (sp) {
      const base = (p.phase === 'charge') ? 0.5 : 0.15;
      sp.material.opacity = base + Math.abs(Math.sin(t * 18 + p.mesh.position.x)) * 0.45;
      sp.rotation.z += dt * 1.7;
    }
    if (p.phase === 'rest') {
      // Hide tell ring
      const r = p.mesh.userData._tellRing; if (r) r.scale.setScalar(0.001);
      if (p.phaseT >= PHASE_REST) { p.phase = 'charge'; p.phaseT = 0; }
    } else if (p.phase === 'charge') {
      // Telegraph ring grows from 0 to PULSE_RADIUS over PHASE_CHARGE
      const k = Math.min(1, p.phaseT / PHASE_CHARGE);
      const ring = p.mesh.userData._tellRing;
      if (ring) {
        // Plane is unit-sized (2u edge) — scale to half-radius equivalent.
        const s = Math.max(0.001, PULSE_RADIUS * k);
        ring.scale.set(s, s, s);
        ring.material.opacity = 0.45 + 0.40 * k;
      }
      // Halo brightens as it charges
      if (p.mesh.userData._halo) p.mesh.userData._halo.material.opacity = 0.55 + 0.40 * k;
      if (p.mesh.userData._light) p.mesh.userData._light.intensity = 1.4 + 2.0 * k;
      if (p.phaseT >= PHASE_CHARGE) {
        // Snap!
        p.phase = 'snap';
        p.phaseT = 0;
        _resolveSnap(p);
      }
    } else if (p.phase === 'snap') {
      // Flash ring at full radius for the snap duration, then transition to rest
      const ring = p.mesh.userData._tellRing;
      if (ring) {
        const s = PULSE_RADIUS * (1 + p.phaseT * 0.4);
        ring.scale.set(s, s, s);
        ring.material.opacity = 0.95 * (1 - p.phaseT / PHASE_SNAP);
      }
      if (p.phaseT >= PHASE_SNAP) { p.phase = 'rest'; p.phaseT = 0; }
    }
  }
}

export function resetPylons() {
  if (!state.pylons) return;
  for (const p of state.pylons.list) {
    if (p.mesh && p.mesh.parent) p.mesh.parent.remove(p.mesh);
  }
  state.pylons.list.length = 0;
  state.pylons.respawnQueue.length = 0;
  state.pylons.initialized = false;
}
