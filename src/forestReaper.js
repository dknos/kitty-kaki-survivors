/**
 * Forest Reaper Endgame — VS signature 30-minute hunter (FOREST-V2-A7, 2026-05-17).
 *
 * Vampire-Survivors hallmark: at 30:00 stage time the Reaper spawns at the
 * edge of the current room and chases the hero at 1.3× hero base speed.
 * Invincible, no telegraph windows, contact = instant death. Forces every
 * forest run to terminate. If the hero outlasts the Reaper for 5 minutes
 * (game-time 35:00), they earn a +500 coin bonus and the "REAPER OUTLASTED"
 * banner fires.
 *
 * Single-instance, self-contained entity — NOT registered with the enemies
 * array, NOT pooled. This avoids any chance of weapon hit loops, friendly
 * fire, or enemy-affix systems touching the Reaper. The only inputs to its
 * tick are `state.hero.pos` + `state.time.game`; the only output is hero
 * damage via the existing takeDamage() pipeline.
 *
 * ── Lifecycle ──────────────────────────────────────────────────────────────
 *   loadForestReaper(scene, state)  — build mesh group, hide initially
 *   tickForestReaper(state, dt)     — drive warning → spawn → chase → outlast
 *   disposeForestReaper(scene)      — dispose meshes + remove DOM tint/banner
 *
 * Load is once-per-forest-scene (idempotent, gated by `state._reaperLoaded`).
 * Tick is called from main.js's forest-only tick block (runs only on logic
 * frames — main.js:1670 already short-circuits pendingLevelUp / gameOver /
 * paused, so we don't re-check here).
 *
 * ── Schedule (game-time, paused-aware via state.time.game) ─────────────────
 *   T = 29:30 (1770s) — warning banner + red tint overlay + 0.5s shake.
 *                       Gated by state.run._reaperWarned (one-shot).
 *   T = 30:00 (1800s) — spawn Reaper at random edge of current room.
 *                       Gated by state.run._reaperSpawned (one-shot).
 *   T = 35:00 (2100s) — if alive, "REAPER OUTLASTED" + +500 coins + amber
 *                       pillar burst. Gated by state.run._reaperOutlastedFired.
 *
 * ── Damage model ───────────────────────────────────────────────────────────
 * On hero-AABB-overlap (radius 0.6 from Reaper centre, XZ-plane):
 *   - Clear state.hero.iFramesUntil = 0  (Reaper bypasses iframes intentionally)
 *   - Call takeDamage(9999) from src/hero.js  (lets existing death pipeline
 *     fire: hp goes to 0, gameOver = true, dyingUntil set, death anim plays,
 *     and any signature_nineLives / passive_revives are consumed as designed
 *     — Reaper is supposed to defeat the survival comeback signatures).
 *   - Stamp state.run.stats.reaperKillTime = state.time.game for post-run UI.
 *
 * ── Self-gating flags (per resetState) ─────────────────────────────────────
 *   state.run._reaperWarned         — warning banner + tint fired
 *   state.run._reaperSpawned        — Reaper mesh visible + chasing
 *   state.run._reaperOutlastedFired — outlast banner + +500 coin reward fired
 *   state.run.stats                 — { reaperOutlasted?, reaperKillTime? }
 *
 * ── Palette (slot-locked, no new hex constants) ────────────────────────────
 *   slot 1 #c7b89a — scythe staff + blade (bone)
 *   slot 4 #4a3220 — cloak + cowl (dark brown)
 *   slot 5 #e89c4a — eye glow (amber, BLOOM_LAYER)
 *   slot 7 #ffd86b — warning banner + outlast banner (palette flash slot)
 *
 * ── Hard caps ──────────────────────────────────────────────────────────────
 *   1 active Reaper instance (forest only).
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from './postfx.js';
import { FOREST_ROOMS } from './forestRooms.js';
import { showBanner } from './ui.js';
import { takeDamage as heroTakeDamage } from './hero.js';
import { getMeta, saveMeta } from './meta.js';
import { sfx } from './audio.js';

// ── palette (slot-locked) ───────────────────────────────────────────────────
const SLOT1_BONE  = 0xc7b89a;
const SLOT4_DARK  = 0x4a3220;
const SLOT5_AMBER = 0xe89c4a;
const SLOT7_FLASH = 0xffd86b;

// ── geometry tunables ───────────────────────────────────────────────────────
const CLOAK_R   = 0.7;
const CLOAK_H   = 2.4;
const COWL_R    = 0.45;
const EYE_R     = 0.06;
const EYE_OFFX  = 0.12;     // half-spacing between the 2 eyes
const STAFF_W   = 0.08;
const STAFF_H   = 1.4;
const STAFF_D   = 0.08;
const BLADE_W   = 0.5;
const BLADE_H   = 0.05;
const BLADE_D   = 0.05;

// ── schedule (game-time seconds) ────────────────────────────────────────────
const WARN_T     = 1770;    // 29:30 — warning fires
const SPAWN_T    = 1800;    // 30:00 — Reaper spawns
const OUTLAST_T  = 2100;    // 35:00 — survival bonus fires

// ── kinematics ──────────────────────────────────────────────────────────────
const SPEED_MUL  = 1.3;     // Reaper speed = HERO.speed * 1.3
const HERO_BASE_SPEED = 8.0;  // matches HERO.speed in src/config.js
const CONTACT_R  = 0.6;
const CONTACT_R2 = CONTACT_R * CONTACT_R;

// Visuals
const EDGE_INSET = 1.5;     // keep spawn 1.5u inside the room bounds
const MIN_SPAWN_DIST = 12;  // refuse spawn within 12u of hero (try other edges)
const TINT_FADE_SEC  = 0.6; // red overlay fade-in/out
const SHAKE_PULSE    = 0.5; // shake duration on warning
const EYE_PULSE_HZ   = 1.8; // eye-glow billboard pulse rate

// DOM ids (so dispose can remove them by lookup, no module-side refs)
const TINT_EL_ID = 'kk-reaper-tint';

// ── module-side state (single instance, single scene) ───────────────────────
let _group = null;            // root THREE.Group attached to scene
let _scene = null;
let _gameState = null;
let _eyeL = null;             // CircleGeometry for left eye glow
let _eyeR = null;             // right eye glow
let _alive = false;           // true once spawn fires; cleared on dispose
let _tintEl = null;           // red screen overlay DOM div
let _tintFadeIn = false;      // currently fading in (true) or out (false)
let _tintTimer = 0;           // seconds elapsed since fade started
let _pillarMesh = null;       // amber pillar burst on outlast (mounted briefly)
let _pillarTimer = 0;         // remaining seconds on pillar

// ─────────────────────────────────────────────────────────────────────────────
// MESH BUILD
// ─────────────────────────────────────────────────────────────────────────────

function _buildReaperGroup() {
  const g = new THREE.Group();

  // Cloak — ConeGeometry r=0.7 h=2.4, base at y=0, tip up at y=2.4.
  // ConeGeometry default points up the +Y axis with origin at centre; we
  // translate so the base sits at ground.
  const cloakGeom = new THREE.ConeGeometry(CLOAK_R, CLOAK_H, 12, 1, false);
  const cloakMat  = new THREE.MeshStandardMaterial({
    color: SLOT4_DARK, roughness: 0.95, metalness: 0.0
  });
  const cloak = new THREE.Mesh(cloakGeom, cloakMat);
  cloak.position.y = CLOAK_H * 0.5;
  cloak.castShadow = false;
  cloak.receiveShadow = false;
  g.add(cloak);

  // Cowl — Sphere at top of cloak. Sits just below the tip so the
  // "head" reads as inside the hood opening.
  const cowlGeom = new THREE.SphereGeometry(COWL_R, 16, 12);
  const cowlMat  = new THREE.MeshStandardMaterial({
    color: SLOT4_DARK, roughness: 0.95, metalness: 0.0
  });
  const cowl = new THREE.Mesh(cowlGeom, cowlMat);
  cowl.position.y = CLOAK_H - COWL_R * 0.5;   // ≈ 2.175
  g.add(cowl);

  // Eye glow — 2 tiny circles inside the cowl. Bloom layer for HDR glow.
  // We mount them slightly forward (+Z in local space) of the cowl center
  // so the camera reads them as "eyes". A gentle billboard rotation each
  // frame in the tick keeps them facing the iso camera direction.
  const eyeGeom = new THREE.CircleGeometry(EYE_R, 12);
  const eyeMat  = new THREE.MeshBasicMaterial({
    color: SLOT5_AMBER, transparent: true, opacity: 1.0
  });
  _eyeL = new THREE.Mesh(eyeGeom, eyeMat);
  _eyeR = new THREE.Mesh(eyeGeom, eyeMat.clone());
  _eyeL.position.set(-EYE_OFFX, CLOAK_H - COWL_R * 0.4, COWL_R * 0.9);
  _eyeR.position.set( EYE_OFFX, CLOAK_H - COWL_R * 0.4, COWL_R * 0.9);
  _eyeL.layers.enable(BLOOM_LAYER);
  _eyeR.layers.enable(BLOOM_LAYER);
  g.add(_eyeL);
  g.add(_eyeR);

  // Scythe — staff (vertical bone box) + blade (horizontal bone box on top).
  // Mounted to the Reaper's right side (+X in local space). Origin of the
  // staff is at its center; we translate so its base sits at ground level.
  const staffGeom = new THREE.BoxGeometry(STAFF_W, STAFF_H, STAFF_D);
  const staffMat  = new THREE.MeshStandardMaterial({
    color: SLOT1_BONE, roughness: 0.7, metalness: 0.0
  });
  const staff = new THREE.Mesh(staffGeom, staffMat);
  staff.position.set(CLOAK_R * 0.95, STAFF_H * 0.5, 0);
  g.add(staff);

  const bladeGeom = new THREE.BoxGeometry(BLADE_W, BLADE_H, BLADE_D);
  const bladeMat  = new THREE.MeshStandardMaterial({
    color: SLOT1_BONE, roughness: 0.7, metalness: 0.0
  });
  const blade = new THREE.Mesh(bladeGeom, bladeMat);
  // Blade sits across the top of the staff, offset outward so it curves away
  // from the body. Slight rotation gives it the curved-scythe silhouette.
  blade.position.set(CLOAK_R * 0.95 + BLADE_W * 0.4, STAFF_H + BLADE_H * 0.5, 0);
  blade.rotation.z = -0.35;
  g.add(blade);

  // Hide initially. Becomes visible once spawn fires.
  g.visible = false;
  return g;
}

// ─────────────────────────────────────────────────────────────────────────────
// SPAWN PLACEMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pick a spawn (x, z) on the edge of the current forest room. Strategy:
 *   1. Resolve room bounds from FOREST_ROOMS[currentRoom], fallback to glade.
 *   2. Try up to 8 candidates, each on a random side with EDGE_INSET applied.
 *   3. Accept the first candidate ≥ MIN_SPAWN_DIST from the hero.
 *   4. Fallback: if no candidate clears the threshold (tiny room + hero in
 *      one corner), accept the FARTHEST of the 8 — even close is better than
 *      stuck-on-hero. Hero won't be standing on a wall, so this is rare.
 */
function _pickSpawnAtEdge(state) {
  const roomId = (state.run && state.run.currentRoom) || 'glade';
  const def = FOREST_ROOMS[roomId] || FOREST_ROOMS.glade;
  const b = def.bounds;
  const hx = (state.hero && state.hero.pos) ? state.hero.pos.x : 0;
  const hz = (state.hero && state.hero.pos) ? state.hero.pos.z : 0;

  let bestX = b.minX + EDGE_INSET, bestZ = b.minZ + EDGE_INSET;
  let bestD2 = -1;

  for (let i = 0; i < 8; i++) {
    const side = Math.floor(Math.random() * 4);
    let x, z;
    if (side === 0) {
      // top edge (maxZ)
      x = b.minX + EDGE_INSET + Math.random() * (b.maxX - b.minX - 2 * EDGE_INSET);
      z = b.maxZ - EDGE_INSET;
    } else if (side === 1) {
      // bottom edge (minZ)
      x = b.minX + EDGE_INSET + Math.random() * (b.maxX - b.minX - 2 * EDGE_INSET);
      z = b.minZ + EDGE_INSET;
    } else if (side === 2) {
      // left edge (minX)
      x = b.minX + EDGE_INSET;
      z = b.minZ + EDGE_INSET + Math.random() * (b.maxZ - b.minZ - 2 * EDGE_INSET);
    } else {
      // right edge (maxX)
      x = b.maxX - EDGE_INSET;
      z = b.minZ + EDGE_INSET + Math.random() * (b.maxZ - b.minZ - 2 * EDGE_INSET);
    }
    const dx = x - hx, dz = z - hz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= MIN_SPAWN_DIST * MIN_SPAWN_DIST) {
      return { x, z };
    }
    if (d2 > bestD2) {
      bestD2 = d2; bestX = x; bestZ = z;
    }
  }
  return { x: bestX, z: bestZ };
}

// ─────────────────────────────────────────────────────────────────────────────
// SCREEN TINT (red ominous overlay)
// ─────────────────────────────────────────────────────────────────────────────

function _ensureTintEl() {
  if (_tintEl && _tintEl.parentNode) return _tintEl;
  // Reuse existing element if a prior dispose somehow left it behind.
  const existing = document.getElementById(TINT_EL_ID);
  if (existing) { _tintEl = existing; return _tintEl; }
  _tintEl = document.createElement('div');
  _tintEl.id = TINT_EL_ID;
  _tintEl.style.cssText = `
    position: fixed; inset: 0;
    background: radial-gradient(ellipse at center, rgba(120,16,16,0) 30%, rgba(140,18,18,0.32) 100%);
    pointer-events: none;
    opacity: 0;
    transition: opacity ${TINT_FADE_SEC}s ease-out;
    z-index: 60;
    mix-blend-mode: multiply;
  `;
  document.body.appendChild(_tintEl);
  return _tintEl;
}

function _fadeTintIn() {
  _ensureTintEl();
  _tintFadeIn = true;
  _tintTimer = 0;
  // RAF-deferred opacity change to ensure the transition fires
  requestAnimationFrame(() => { if (_tintEl) _tintEl.style.opacity = '1'; });
}

function _fadeTintOut() {
  if (!_tintEl) return;
  _tintFadeIn = false;
  _tintEl.style.opacity = '0';
  // Schedule a removal after the fade completes; if dispose runs first the
  // ?.remove() in disposeForestReaper handles it.
  setTimeout(() => {
    if (_tintEl && _tintEl.parentNode && _tintEl.style.opacity === '0') {
      _tintEl.remove();
      _tintEl = null;
    }
  }, (TINT_FADE_SEC * 1000) + 50);
}

// ─────────────────────────────────────────────────────────────────────────────
// OUTLAST REWARD (amber pillar burst)
// ─────────────────────────────────────────────────────────────────────────────

function _spawnOutlastPillar(state) {
  // Tall, slim amber pillar mounted at hero position. Bloom-on, additive
  // blend, fades over 1.0s. Doesn't interact with anything — purely cosmetic.
  if (!_scene || !state.hero || !state.hero.pos) return;
  const geom = new THREE.CylinderGeometry(0.4, 0.4, 8, 16, 1, true);
  const mat = new THREE.MeshBasicMaterial({
    color: SLOT5_AMBER, transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false
  });
  _pillarMesh = new THREE.Mesh(geom, mat);
  _pillarMesh.position.set(state.hero.pos.x, 4, state.hero.pos.z);
  _pillarMesh.layers.enable(BLOOM_LAYER);
  _scene.add(_pillarMesh);
  _pillarTimer = 1.0;
}

function _tickOutlastPillar(dt) {
  if (!_pillarMesh) return;
  _pillarTimer -= dt;
  if (_pillarTimer <= 0) {
    if (_pillarMesh.parent) _pillarMesh.parent.remove(_pillarMesh);
    if (_pillarMesh.geometry) _pillarMesh.geometry.dispose();
    if (_pillarMesh.material) _pillarMesh.material.dispose();
    _pillarMesh = null;
    return;
  }
  const k = 1 - _pillarTimer;   // 0 → 1 over the lifetime
  _pillarMesh.material.opacity = 0.85 * (1 - k);
  _pillarMesh.scale.set(1 + k * 0.6, 1 + k * 0.3, 1 + k * 0.6);
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

export function loadForestReaper(scene, state) {
  if (!scene || !state) return;
  if (state._reaperLoaded && _group && _group.parent === scene) return;
  // Idempotent: tear down any prior instance first.
  disposeForestReaper(scene);
  _scene = scene;
  _gameState = state;
  _group = _buildReaperGroup();
  scene.add(_group);
  _alive = false;
  state._reaperLoaded = true;
}

export function tickForestReaper(state, dt) {
  if (!state || !_group || !_scene) return;
  // Forest-only gate: caller (main.js) already gates on stage.id === 'forest',
  // but guard defensively so a stray call on a non-forest stage no-ops.
  if (!state.run || !state.run.stage || state.run.stage.id !== 'forest') return;

  const t = state.time.game;

  // ── 1. Warning at T = 29:30 (one-shot) ────────────────────────────────────
  if (!state.run._reaperWarned && t >= WARN_T) {
    state.run._reaperWarned = true;
    try { showBanner('REAPER APPROACHES', 3.0, '#ffd86b'); } catch (_) {}
    _fadeTintIn();
    // Screen-shake pulse 0.5s. state.fx.shake is decayed by main.js
    // applyShake; setting it pulse-high mirrors how takeDamage pulses shake.
    if (state.fx && state.fx.shake < SHAKE_PULSE) state.fx.shake = SHAKE_PULSE;
    if (state.fx) state.fx.chromaticPulse = Math.max(state.fx.chromaticPulse || 0, 0.4);
    try { sfx.reaperWarn && sfx.reaperWarn(); } catch (_) {}
  }

  // ── 2. Spawn at T = 30:00 (one-shot) ──────────────────────────────────────
  if (!state.run._reaperSpawned && t >= SPAWN_T) {
    state.run._reaperSpawned = true;
    const spawn = _pickSpawnAtEdge(state);
    _group.position.set(spawn.x, 0, spawn.z);
    _group.visible = true;
    _alive = true;
    try { sfx.reaperSpawn && sfx.reaperSpawn(); } catch (_) {}
    // Tint stays on through the chase — fade it down to a softer steady
    // value by reducing opacity (still red but less overpowering).
    if (_tintEl) _tintEl.style.opacity = '0.6';
  }

  // ── 3. Chase + contact damage (only while spawned, hero alive) ────────────
  if (_alive && !state.gameOver && state.hero && state.hero.pos) {
    const hx = state.hero.pos.x, hz = state.hero.pos.z;
    const rx = _group.position.x, rz = _group.position.z;
    const dx = hx - rx, dz = hz - rz;
    const d  = Math.hypot(dx, dz) || 1;

    // Move toward hero at 1.3× hero base speed.
    const speed = HERO_BASE_SPEED * SPEED_MUL;
    const step  = speed * dt;
    if (d <= step) {
      _group.position.x = hx;
      _group.position.z = hz;
    } else {
      _group.position.x += (dx / d) * step;
      _group.position.z += (dz / d) * step;
    }
    // Face the hero — yaw rotation around Y axis. atan2 of XZ delta.
    _group.rotation.y = Math.atan2(dx, dz);

    // Eye-glow pulse (subtle amber breathing). Pure cosmetic, drives material
    // opacity in [0.55, 1.0] band.
    if (_eyeL && _eyeR) {
      const pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(state.time.real * EYE_PULSE_HZ * Math.PI * 2));
      _eyeL.material.opacity = pulse;
      _eyeR.material.opacity = pulse;
    }

    // Contact check — XZ-plane circle of radius CONTACT_R.
    if ((dx * dx + dz * dz) <= CONTACT_R2) {
      // Reaper bypasses iframes intentionally — survivor mechanics aren't
      // supposed to cheese the 30:00 hunter. Clear iframes then deal massive
      // damage so the existing death pipeline (Nine Lives consumption,
      // Phoenix burst, gameOver flag, death anim) fires correctly.
      state.hero.iFramesUntil = 0;
      // Stamp the kill time BEFORE takeDamage so post-run UI has it even if
      // a downstream death-screen path reads state synchronously.
      state.run.stats = state.run.stats || {};
      if (state.run.stats.reaperKillTime == null) {
        state.run.stats.reaperKillTime = state.time.game;
      }
      try { heroTakeDamage(9999); } catch (e) {
        // Defensive fallback: if takeDamage throws (unlikely), force hp=0 +
        // gameOver so the run still terminates.
        if (state.hero) state.hero.hp = 0;
        state.gameOver = true;
        console.warn('[forestReaper] takeDamage failed:', e);
      }
    }
  }

  // ── 4. Outlast bonus at T = 35:00 (one-shot, hero alive) ──────────────────
  if (
    !state.run._reaperOutlastedFired
    && state.run._reaperSpawned
    && t >= OUTLAST_T
    && !state.gameOver
  ) {
    state.run._reaperOutlastedFired = true;
    state.run.stats = state.run.stats || {};
    state.run.stats.reaperOutlasted = true;
    try { showBanner('REAPER OUTLASTED', 4.0, '#ffd86b'); } catch (_) {}
    _spawnOutlastPillar(state);
    // Hide the Reaper — it's done its job. (We don't dispose: stage swap or
    // run-reset will dispose the mesh group properly via disposeForestReaper.)
    if (_group) _group.visible = false;
    _alive = false;
    // +500 coins meta reward. Brief says state.meta.gold; actual field is
    // getMeta().coins on the persistent meta blob. Saved immediately so a
    // mid-run crash can't lose the bonus.
    try {
      const m = getMeta();
      if (m) { m.coins = (m.coins || 0) + 500; saveMeta(); }
    } catch (e) {
      console.warn('[forestReaper] outlast coin reward failed:', e);
    }
    // Fade tint out — danger is past.
    _fadeTintOut();
  }

  // Ticking the outlast pillar happens regardless of _alive so the burst
  // completes its 1s fade even after the Reaper has been hidden.
  _tickOutlastPillar(dt);
}

export function disposeForestReaper(scene) {
  // Mesh group teardown — remove from scene, dispose geometries + materials.
  if (_group) {
    if (_group.parent) _group.parent.remove(_group);
    _group.traverse((o) => {
      if (o.isMesh) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) {
            for (const m of o.material) m.dispose();
          } else {
            o.material.dispose();
          }
        }
      }
    });
    _group = null;
  }
  _eyeL = null;
  _eyeR = null;
  _alive = false;

  // Pillar (outlast cosmetic) teardown — same dispose pattern.
  if (_pillarMesh) {
    if (_pillarMesh.parent) _pillarMesh.parent.remove(_pillarMesh);
    if (_pillarMesh.geometry) _pillarMesh.geometry.dispose();
    if (_pillarMesh.material) _pillarMesh.material.dispose();
    _pillarMesh = null;
    _pillarTimer = 0;
  }

  // DOM tint cleanup — drop both the module-side ref AND any stale element
  // matching our id (handles the case where a prior session leaked one).
  if (_tintEl) {
    if (_tintEl.parentNode) _tintEl.parentNode.removeChild(_tintEl);
    _tintEl = null;
  }
  const stale = (typeof document !== 'undefined') ? document.getElementById(TINT_EL_ID) : null;
  if (stale && stale.parentNode) stale.parentNode.removeChild(stale);

  _scene = null;
  _gameState = null;
}
