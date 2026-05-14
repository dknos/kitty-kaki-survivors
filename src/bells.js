/**
 * Cursed Bell — risk/reward destructible.
 *
 * One bell per run, spawned at t=3:00. Rings every 4 seconds. On each ring,
 * all enemies inside a 10u radius gain `_enrageUntil` for 2s (read by
 * enemies.js to boost their speed ×1.5 and contact damage ×1.25).
 *
 * Killing the bell (250 HP) drops a guaranteed chest + 3 Ember bonus —
 * compelling but optional. If the player ignores it, the surrounding swarm
 * gets dangerous; if they break it, the rest of the run is calmer.
 */
import * as THREE from 'three';
import { state } from './state.js';
import { grantEmbers } from './meta.js';
import { makeRuneRingTexture } from './enemyTells.js';

let _bellRuneTex = null;
function _getBellRuneTex() { return _bellRuneTex || (_bellRuneTex = makeRuneRingTexture()); }

const BELL_HP = 250;
const CYCLE = 4.0;             // sec between rings
const WINDUP = 1.0;            // visible wind-up before the ring
const ENRAGE_RADIUS = 10.0;
const ENRAGE_DURATION = 2.0;
const DIST_FROM_HERO_MIN = 28;
const DIST_FROM_HERO_MAX = 44;

let _scene = null;

function _pickPos() {
  const hp = state.hero.pos;
  for (let attempt = 0; attempt < 12; attempt++) {
    const a = Math.random() * Math.PI * 2;
    const r = DIST_FROM_HERO_MIN + Math.random() * (DIST_FROM_HERO_MAX - DIST_FROM_HERO_MIN);
    const x = hp.x + Math.cos(a) * r;
    const z = hp.z + Math.sin(a) * r;
    // Avoid stacking on other static destructibles
    let tooClose = false;
    const sources = [state.totems && state.totems.list, state.pylons && state.pylons.list, state.bells && state.bells.list].filter(Boolean);
    for (const list of sources) {
      for (const o of list) {
        if (!o.alive) continue;
        const dx = o.mesh.position.x - x;
        const dz = o.mesh.position.z - z;
        if (dx * dx + dz * dz < 144) { tooClose = true; break; }
      }
      if (tooClose) break;
    }
    if (!tooClose) return { x, z };
  }
  const a = Math.random() * Math.PI * 2;
  return { x: hp.x + Math.cos(a) * 32, z: hp.z + Math.sin(a) * 32 };
}

function _makeBellMesh() {
  const g = new THREE.Group();
  // Posts (two upright wooden beams)
  for (const sx of [-0.95, 0.95]) {
    const post = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 4.2, 0.22),
      new THREE.MeshStandardMaterial({ color: 0x3a261a, roughness: 0.85 }),
    );
    post.position.set(sx, 2.1, 0);
    post.castShadow = true; post.receiveShadow = true;
    g.add(post);
  }
  // Crossbeam
  const beam = new THREE.Mesh(
    new THREE.BoxGeometry(2.3, 0.24, 0.24),
    new THREE.MeshStandardMaterial({ color: 0x3a261a, roughness: 0.85 }),
  );
  beam.position.y = 4.05;
  beam.castShadow = true;
  g.add(beam);
  // Bell body — bronze, hung from beam
  const bellGroup = new THREE.Group();
  const bellBody = new THREE.Mesh(
    new THREE.CylinderGeometry(0.62, 0.78, 1.4, 18, 1, true),
    new THREE.MeshStandardMaterial({
      color: 0x8a5a2a, roughness: 0.45, metalness: 0.65, side: THREE.DoubleSide,
    }),
  );
  bellBody.position.y = -0.7;
  bellBody.castShadow = true;
  bellGroup.add(bellBody);
  // Cap (dome on top)
  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(0.62, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x8a5a2a, roughness: 0.45, metalness: 0.65 }),
  );
  cap.position.y = 0;
  cap.castShadow = true;
  bellGroup.add(cap);
  // Loop ring at the top
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.16, 0.04, 8, 12),
    new THREE.MeshStandardMaterial({ color: 0x4a3018, roughness: 0.85 }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.45;
  bellGroup.add(ring);
  // Clapper (small dark sphere inside)
  const clapper = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0x1a1410, roughness: 0.95 }),
  );
  clapper.position.y = -1.05;
  bellGroup.add(clapper);
  // Sigil ring at the base (emissive red curse mark)
  const sigil = new THREE.Mesh(
    new THREE.TorusGeometry(0.78, 0.06, 8, 24),
    new THREE.MeshStandardMaterial({
      color: 0xc23a3a, emissive: 0xc23a3a, emissiveIntensity: 0.9, roughness: 0.5,
    }),
  );
  sigil.rotation.x = Math.PI / 2;
  sigil.position.y = -1.35;
  bellGroup.add(sigil);
  bellGroup.position.y = 4.05;
  g.add(bellGroup);
  g.userData._bell = bellGroup;
  g.userData._sigil = sigil;
  // Wind-up ground ring — textured rune disc so the enrage telegraph reads
  // as a crimson summoning circle inscribing on the floor.
  const tellRing = new THREE.Mesh(
    new THREE.PlaneGeometry(2.0, 2.0),
    new THREE.MeshBasicMaterial({
      map: _getBellRuneTex(),
      color: 0xc23a3a, transparent: true, opacity: 0.5,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }),
  );
  tellRing.rotation.order = 'YXZ';
  tellRing.rotation.x = -Math.PI / 2;
  tellRing.position.y = 0.05;
  tellRing.scale.setScalar(0.001);
  tellRing.userData.spinPhase = Math.random() * Math.PI * 2;
  g.add(tellRing);
  g.userData._tellRing = tellRing;
  // Crimson light
  const pl = new THREE.PointLight(0xc23a3a, 1.3, 12, 2);
  pl.position.set(0, 3.4, 0);
  g.add(pl);
  g.userData._light = pl;
  return g;
}

function _spawnOne() {
  const pos = _pickPos();
  const mesh = _makeBellMesh();
  mesh.position.set(pos.x, 0, pos.z);
  _scene.add(mesh);
  const bell = {
    mesh, glbKey: '__bell__',
    hp: BELL_HP, hpMax: BELL_HP,
    spd: 0, dmg: 0, contactCooldown: Infinity,
    elite: false, isFinalBoss: false, isMiniBoss: false,
    isBell: true, faceYaw: 0,
    alive: true, _spatialKey: null,
    knockVx: 0, knockVz: 0, slowMul: 1,
    _dotDps: 0, _dotUntil: 0, _flashUntil: 0, _wasFlashing: false,
    procAnim: null, ranged: null, rangedCD: 0,
    _animPhase: 0, _baseY: 0, _baseScale: 1,
    // Ring cycle state machine
    phase: 'idle', phaseT: CYCLE - WINDUP - 0.5,
    swingPhase: 0,
  };
  state.enemies.spatial.insert(bell);
  state.enemies.active.push(bell);
  state.bells.list.push(bell);
  return bell;
}

function _ringBell(b) {
  // Enrage all enemies in radius (skip static destructibles + the bell itself)
  const enrageUntil = state.time.game + ENRAGE_DURATION;
  const r2 = ENRAGE_RADIUS * ENRAGE_RADIUS;
  const bx = b.mesh.position.x;
  const bz = b.mesh.position.z;
  for (const e of state.enemies.active) {
    if (!e.alive) continue;
    if (e.isBell || e.isTotem || e.isPylon) continue;
    const dx = e.mesh.position.x - bx;
    const dz = e.mesh.position.z - bz;
    if (dx * dx + dz * dz <= r2) e._enrageUntil = enrageUntil;
  }
  state.fx.shake = Math.max(state.fx.shake || 0, 0.4);
  state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.5);
  // Visual: cyan→red enrage burst from the bell base
  import('./vfxBurst.js').then(({ burstExplosion }) =>
    burstExplosion(bx, bz, ENRAGE_RADIUS, 0xff5544)
  ).catch(() => {});
}

export function onBellKilled(bell) {
  if (!bell) return;
  if (bell.mesh && bell.mesh.parent) bell.mesh.parent.remove(bell.mesh);
  try { grantEmbers(3); } catch (_) {}
  import('./chest.js').then(({ spawnChest }) => spawnChest(bell.mesh.position.x, bell.mesh.position.z));
  const i = state.bells.list.indexOf(bell);
  if (i >= 0) state.bells.list.splice(i, 1);
  // No respawn — the bell is a one-time risk/reward objective per run.
}

export function initBells(scene) { _scene = scene; }

export function tickBells(dt) {
  if (!_scene) return;
  if (state.mode !== 'run') return;
  if (state.time.game < state.bells.armedAt) return;
  if (!state.bells.initialized) {
    state.bells.initialized = true;
    for (let i = 0; i < state.bells.target; i++) _spawnOne();
  }
  const t = state.time.real;
  for (const b of state.bells.list) {
    if (!b.alive) continue;
    b.phaseT += dt;
    // Idle bell sway (subtle)
    if (b.mesh.userData._bell) {
      b.swingPhase += dt * 1.3;
      b.mesh.userData._bell.rotation.z = Math.sin(b.swingPhase) * 0.06 + Math.sin(b.swingPhase * 2.3) * 0.025;
    }
    // Sigil ember pulse
    if (b.mesh.userData._sigil) {
      b.mesh.userData._sigil.material.emissiveIntensity = 0.7 + 0.5 * Math.sin(t * 3.2);
    }
    // Rune ring slowly spins so its glyphs inscribe over time.
    const tell = b.mesh.userData._tellRing;
    if (tell) tell.rotation.y = (tell.userData.spinPhase || 0) + t * 0.4;
    if (b.phase === 'idle') {
      const r = b.mesh.userData._tellRing; if (r) r.scale.setScalar(0.001);
      if (b.phaseT >= CYCLE - WINDUP) { b.phase = 'windup'; b.phaseT = 0; }
    } else if (b.phase === 'windup') {
      // Telegraph ring grows from 0 to ENRAGE_RADIUS, swing intensifies
      const k = Math.min(1, b.phaseT / WINDUP);
      const ring = b.mesh.userData._tellRing;
      if (ring) {
        const s = Math.max(0.001, ENRAGE_RADIUS * k);
        ring.scale.set(s, s, s);
        ring.material.opacity = 0.40 + 0.45 * k;
      }
      // Bell swings harder
      if (b.mesh.userData._bell) {
        b.mesh.userData._bell.rotation.z += Math.sin(b.swingPhase * 6) * 0.05 * k;
      }
      if (b.phaseT >= WINDUP) {
        _ringBell(b);
        b.phase = 'flash';
        b.phaseT = 0;
      }
    } else if (b.phase === 'flash') {
      // Hold flash at full radius briefly, then back to idle
      const ring = b.mesh.userData._tellRing;
      if (ring) {
        ring.scale.setScalar(ENRAGE_RADIUS * (1 + b.phaseT * 0.25));
        ring.material.opacity = 0.85 * (1 - b.phaseT / 0.35);
      }
      if (b.phaseT >= 0.35) { b.phase = 'idle'; b.phaseT = 0; }
    }
  }
}

export function resetBells() {
  if (!state.bells) return;
  for (const b of state.bells.list) {
    if (b.mesh && b.mesh.parent) b.mesh.parent.remove(b.mesh);
  }
  state.bells.list.length = 0;
  state.bells.initialized = false;
}
