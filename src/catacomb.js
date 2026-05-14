/**
 * Catacomb — first dungeon sub-arena the player descends into mid-run.
 *
 * Sibling to interior.js, but combat continues inside. The player enters
 * via a stairs-down interactable spawned in the run scene; combat runs
 * normally in catacomb mode (enemies, weapons, FX), inside a 30u×30u
 * stone chamber. After 3 mini-waves a guaranteed chest spawns and 3
 * Embers are granted. Pressing E on the stairs returns the hero to the
 * stashed overworld position.
 *
 * Primitive scaffolding only (Kenney Modular Dungeon Kit was not bundled
 * — left as a future drop-in replacement). Walls + floor + torches +
 * broken pillars from THREE primitives. Group is parked at y=-200 when
 * inactive so its torch lights don't pollute the overworld (same trick
 * as interior.js).
 */
import * as THREE from 'three';
import { state } from './state.js';
import { grantEmbers } from './meta.js';
import { ENEMY_TIERS } from './config.js';
import { bindPrompt, setPromptLabel } from './buttonPrompts.js';
import { BLOOM_LAYER } from './postfx.js';
import { makeRuneRingTexture } from './enemyTells.js';

// Shared rune-ring texture for catacomb glyphs (entrance lip + stair foot).
// Lazy-cached so we don't re-render the canvas every build.
let _runeTex = null;
function _getRuneTex() { return _runeTex || (_runeTex = makeRuneRingTexture()); }

// Chamber dims (world units)
const CHAMBER_W = 30;
const CHAMBER_D = 30;
const WALL_H = 4;
const STAIRS_X = 0;
const STAIRS_Z = CHAMBER_D / 2 - 2.5;   // south end, just inside the wall

// Waves
const TOTAL_WAVES = 3;
const WAVE_MIN_ENEMIES = 8;
const WAVE_MAX_ENEMIES = 12;

let _scene = null;
let _group = null;
let _promptEl = null;
let _promptBinding = null;
let _torches = [];        // {pl, cone, baseIntensity}
let _returnPos = null;    // stashed run-scene hero pos before entering
let _waveIdx = 0;         // 0..TOTAL_WAVES; -1 once final reward dropped
let _waveSpawnDelay = 0;  // small delay before the next wave kicks
let _rewardDropped = false;
let _activeOnStairs = false;
let _chamberMobIds = new Set();   // enemy refs spawned by this catacomb
let _exitChestSpawned = false;

// Overworld entrance — a stairs-down mesh in the run scene that triggers
// catacomb entry when the hero stands on it and presses E.
let _entranceMesh = null;
const ENTRANCE_POS = { x: 0, z: 30 };  // 30u south of run-scene hero spawn
let _activeOnEntrance = false;

function _mat(color, roughness = 0.92, metalness = 0.0) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function _makeFloor() {
  const g = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.PlaneGeometry(CHAMBER_W, CHAMBER_D),
    _mat(0x2a2218, 0.95),
  );
  base.rotation.x = -Math.PI / 2;
  base.receiveShadow = true;
  g.add(base);
  // A few darker tile seams for texture
  for (let i = -2; i <= 2; i++) {
    const seam = new THREE.Mesh(
      new THREE.PlaneGeometry(CHAMBER_W, 0.06),
      new THREE.MeshBasicMaterial({ color: 0x14100a, transparent: true, opacity: 0.55 }),
    );
    seam.rotation.x = -Math.PI / 2;
    seam.position.y = 0.01;
    seam.position.z = (i / 2.5) * CHAMBER_D * 0.4;
    g.add(seam);
  }
  return g;
}

function _makeWall(w, h, d) {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    _mat(0x4a4338, 0.98),
  );
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

function _makeTorch() {
  const g = new THREE.Group();
  // Bracket post
  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.06, 0.7, 8),
    _mat(0x2a1f14, 0.9),
  );
  post.position.y = 1.6;
  g.add(post);
  // Flame cone (emissive)
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.18, 0.55, 10),
    new THREE.MeshStandardMaterial({
      color: 0xff7a3a, emissive: 0xff7a3a, emissiveIntensity: 2.2, roughness: 0.4,
    }),
  );
  cone.position.y = 2.15;
  g.add(cone);
  // Light
  const pl = new THREE.PointLight(0xff7a3a, 0.8, 8, 2);
  pl.position.y = 2.0;
  g.add(pl);
  g.userData = { pl, cone, baseIntensity: 0.8 };
  return g;
}

function _makePillar() {
  const g = new THREE.Group();
  // Broken column — three stacked drums, the top one offset/shorter
  const h1 = 1.2 + Math.random() * 0.4;
  const drum1 = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.6, h1, 12),
    _mat(0x5a5048, 0.95),
  );
  drum1.position.y = h1 / 2;
  drum1.castShadow = true; drum1.receiveShadow = true;
  g.add(drum1);
  if (Math.random() > 0.3) {
    const h2 = 0.8 + Math.random() * 0.6;
    const drum2 = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.55, h2, 12),
      _mat(0x5a5048, 0.95),
    );
    drum2.position.y = h1 + h2 / 2;
    drum2.position.x = (Math.random() - 0.5) * 0.12;
    drum2.castShadow = true;
    g.add(drum2);
  }
  // Base slab
  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, 0.18, 1.4),
    _mat(0x3a3328, 0.95),
  );
  slab.position.y = 0.09;
  slab.receiveShadow = true;
  g.add(slab);
  g.rotation.y = Math.random() * Math.PI;
  return g;
}

function _makeEntranceStairs() {
  // Inverted stairs leading DOWN into the ground — visible cue in the run scene
  const g = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const step = new THREE.Mesh(
      new THREE.BoxGeometry(2.4 - i * 0.3, 0.22, 0.55),
      _mat(0x3a3328, 0.95),
    );
    step.position.set(0, -0.11 - i * 0.18, i * 0.45);
    step.receiveShadow = true; step.castShadow = true;
    g.add(step);
  }
  // Dark pit cap (visual void below the stairs)
  const pit = new THREE.Mesh(
    new THREE.PlaneGeometry(2.4, 2.4),
    new THREE.MeshBasicMaterial({ color: 0x0a0608 }),
  );
  pit.rotation.x = -Math.PI / 2;
  pit.position.set(0, -1.0, 1.2);
  g.add(pit);
  // Frame stones around the opening
  for (const [dx, dz] of [[-1.5, 0],[1.5, 0],[0, -0.8]]) {
    const rock = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.5, 0.6),
      _mat(0x5a5048, 0.95),
    );
    rock.position.set(dx, 0.25, dz);
    rock.rotation.y = Math.random() * Math.PI;
    rock.castShadow = true;
    g.add(rock);
  }
  // Glowing rune at the lip — iter 10b FX residue cleanup: PlaneGeometry +
  // makeRuneRingTexture (purple-orange entrance glow, slow yaw, bloom layer).
  // The original brief calls for "purple", but this is the surface-side
  // entrance into the catacomb — the existing warm 0xff7a3a hue cues "danger
  // below" better than a cold purple. Catacomb-internal glyph (stair-foot
  // rune below) uses the purple per brief.
  const runeGeo = new THREE.PlaneGeometry(1.56, 1.56);
  runeGeo.rotateX(-Math.PI / 2);
  const rune = new THREE.Mesh(
    runeGeo,
    new THREE.MeshBasicMaterial({
      map: _getRuneTex(),
      color: 0xff7a3a, transparent: true, opacity: 0.85,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }),
  );
  rune.position.set(0, 0.05, -0.85);
  rune.layers.enable(BLOOM_LAYER);
  rune.userData._spin = 0.35;
  g.add(rune);
  g.userData._rune = rune;
  // Soft glow
  const pl = new THREE.PointLight(0xff7a3a, 1.0, 8, 2);
  pl.position.set(0, 1.2, 0);
  g.add(pl);
  return g;
}

function _makeStairs() {
  // Down-stairs marker at the south wall: 3 stepped slabs receding into the wall.
  const g = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const step = new THREE.Mesh(
      new THREE.BoxGeometry(2.6 - i * 0.4, 0.18 + i * 0.1, 0.5),
      _mat(0x6a6050, 0.92),
    );
    step.position.set(0, 0.09 + i * 0.18, i * 0.5);
    step.receiveShadow = true; step.castShadow = true;
    g.add(step);
  }
  // Glowing rune at the foot of the stairs — iter 10b FX residue cleanup.
  // Purple-magenta tint per brief: catacomb-internal glyphs should read as
  // necromantic + "you are deeper now", distinct from the warm-orange
  // surface entrance. Slow yaw + bloom layer + additive blending to match
  // the rest of the runic-tell art language. Opacity-pulse anim hook left
  // for a future tick if needed; no consumer reads this _rune ref today
  // outside the entrance, so emissive→opacity port is a static glow.
  const runeGeo = new THREE.PlaneGeometry(1.70, 1.70);
  runeGeo.rotateX(-Math.PI / 2);
  const rune = new THREE.Mesh(
    runeGeo,
    new THREE.MeshBasicMaterial({
      map: _getRuneTex(),
      color: 0xc87bff, transparent: true, opacity: 0.85,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }),
  );
  rune.position.y = 0.03;
  rune.position.z = -0.8;
  rune.layers.enable(BLOOM_LAYER);
  rune.userData._spin = 0.45;
  g.add(rune);
  g.userData._rune = rune;
  return g;
}

export function buildCatacomb(scene) {
  if (_group) return _group;
  _scene = scene;
  const g = new THREE.Group();
  g.name = 'catacombGroup';

  g.add(_makeFloor());

  // 4 walls
  const halfW = CHAMBER_W / 2;
  const halfD = CHAMBER_D / 2;
  // North (-z)
  const wN = _makeWall(CHAMBER_W, WALL_H, 0.4);
  wN.position.set(0, WALL_H / 2, -halfD);
  g.add(wN);
  // South (+z)
  const wS = _makeWall(CHAMBER_W, WALL_H, 0.4);
  wS.position.set(0, WALL_H / 2, halfD);
  g.add(wS);
  // West (-x)
  const wW = _makeWall(0.4, WALL_H, CHAMBER_D);
  wW.position.set(-halfW, WALL_H / 2, 0);
  g.add(wW);
  // East (+x)
  const wE = _makeWall(0.4, WALL_H, CHAMBER_D);
  wE.position.set(halfW, WALL_H / 2, 0);
  g.add(wE);

  // 4 wall torches — one centered on each wall
  const torchSpots = [
    { x: 0,         z: -halfD + 0.45 },
    { x: 0,         z:  halfD - 0.45 },
    { x: -halfW + 0.45, z: 0 },
    { x:  halfW - 0.45, z: 0 },
  ];
  _torches.length = 0;
  for (const s of torchSpots) {
    const t = _makeTorch();
    t.position.set(s.x, 0, s.z);
    g.add(t);
    _torches.push(t);
  }

  // 5 broken pillars — fixed positions for cover
  const pillarSpots = [
    { x: -7,  z: -7 },
    { x:  7,  z: -7 },
    { x: -7,  z:  4 },
    { x:  7,  z:  4 },
    { x:  0,  z: -3 },
  ];
  for (const s of pillarSpots) {
    const p = _makePillar();
    p.position.set(s.x, 0, s.z);
    g.add(p);
  }

  // Exit stairs at south end
  const stairs = _makeStairs();
  stairs.position.set(STAIRS_X, 0, STAIRS_Z);
  stairs.rotation.y = Math.PI; // face north (into the room)
  g.add(stairs);

  // Ambient fill — a dim cool kicker so non-torch corners don't go pure black
  const fill = new THREE.AmbientLight(0x202028, 0.55);
  g.add(fill);

  // Park below world
  g.position.y = -200;
  scene.add(g);
  _group = g;

  // Build overworld entrance — lives in the run scene at a fixed position.
  // Always visible in run mode; hidden (y=-200) during catacomb/town/interior.
  _entranceMesh = _makeEntranceStairs();
  _entranceMesh.position.set(ENTRANCE_POS.x, 0, ENTRANCE_POS.z);
  scene.add(_entranceMesh);

  // DOM prompt
  if (!_promptEl) {
    _promptEl = document.createElement('div');
    _promptEl.id = 'kk-catacomb-prompt';
    _promptEl.style.cssText = `
      position: fixed; bottom: 14%; left: 50%; transform: translateX(-50%);
      padding: 10px 22px; pointer-events: none; z-index: 90;
      background: linear-gradient(180deg, rgba(40,32,24,0.94), rgba(24,18,12,0.92));
      border: 1px solid rgba(255,210,74,0.55); border-radius: 8px;
      color: #ffd24a; font: 600 16px 'Cinzel Decorative', serif;
      letter-spacing: 0.06em;
      box-shadow: 0 6px 18px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,210,74,0.2);
      display: none;
    `;
    document.body.appendChild(_promptEl);
    _promptBinding = bindPrompt(_promptEl, 'interact', '');
    window.addEventListener('keydown', _onKeyDown);
  }
  return g;
}

function _onKeyDown(e) {
  if (e.code !== 'KeyE' && e.code !== 'Enter') return;
  if (state.mode === 'catacomb') {
    if (_activeOnStairs) exitCatacomb();
    return;
  }
  if (state.mode === 'run' && _activeOnEntrance) {
    enterCatacomb({ x: state.hero.pos.x, y: 0, z: state.hero.pos.z });
  }
}

/**
 * Called from main.js's run-mode branch each frame. Shows a prompt + listens
 * for E when the hero is standing on the overworld entrance.
 */
export function tickCatacombEntrance(dt) {
  if (!_entranceMesh) return;
  // Hide entrance while not in run mode (don't pollute town/interior)
  if (state.mode !== 'run') {
    if (_entranceMesh.visible) _entranceMesh.visible = false;
    _activeOnEntrance = false;
    if (_promptEl && _promptEl.style.display !== 'none' && state.mode !== 'catacomb') {
      _promptEl.style.display = 'none';
    }
    return;
  }
  if (!_entranceMesh.visible) _entranceMesh.visible = true;
  // Pulse the rune (iter 10b — the rune is now MeshBasicMaterial-on-PlaneGeometry,
  // so we drive opacity instead of emissiveIntensity for the same "breathing
  // ward" cue. Bloom layer makes the opacity changes read at distance).
  const rune = _entranceMesh.userData._rune;
  if (rune) {
    rune.material.opacity = 0.55 + 0.30 * Math.sin(state.time.real * 3.2);
    rune.rotation.y += dt * (rune.userData._spin || 0.35);
  }
  const dx = state.hero.pos.x - ENTRANCE_POS.x;
  const dz = state.hero.pos.z - ENTRANCE_POS.z;
  _activeOnEntrance = (dx * dx + dz * dz) < 2.2 * 2.2;
  if (_activeOnEntrance) {
    setPromptLabel(_promptBinding, 'Descend into the Catacomb');
    _promptEl.style.display = 'block';
  } else if (_promptEl.style.display !== 'none') {
    _promptEl.style.display = 'none';
  }
}

function _spawnWave() {
  // Pick weak tiers (hp ≤ 18, non-elite, non-ranged for simplicity)
  const pool = ENEMY_TIERS.filter(t => t.hp <= 18 && !t.elite && !t.ranged);
  const count = WAVE_MIN_ENEMIES + Math.floor(Math.random() * (WAVE_MAX_ENEMIES - WAVE_MIN_ENEMIES + 1));
  import('./enemies.js').then(({ spawnEnemy }) => {
    const hx = state.hero.pos.x, hz = state.hero.pos.z;
    for (let i = 0; i < count; i++) {
      const tier = pool[Math.floor(Math.random() * pool.length)];
      // Spawn around the chamber edges, away from hero spawn (south)
      let x, z, attempts = 0;
      do {
        // Bias toward north half + edges
        x = (Math.random() - 0.5) * (CHAMBER_W - 4);
        z = -Math.random() * (CHAMBER_D / 2 - 2);   // -halfD..-1
        attempts++;
      } while (attempts < 4 && (Math.abs(x - hx) < 4 && Math.abs(z - hz) < 4));
      try {
        const before = state.enemies.active.length;
        spawnEnemy(tier, x, z);
        // Track the freshly-spawned enemy
        if (state.enemies.active.length > before) {
          _chamberMobIds.add(state.enemies.active[state.enemies.active.length - 1]);
        }
      } catch (_) {}
    }
  });
}

function _countAliveWaveMobs() {
  let n = 0;
  for (const e of _chamberMobIds) {
    if (e && e.alive) n++;
  }
  return n;
}

function _dropExitReward() {
  if (_exitChestSpawned) return;
  _exitChestSpawned = true;
  // Guaranteed chest near the north end + 3 Embers
  import('./chest.js').then(({ spawnChest }) => {
    spawnChest(0, -CHAMBER_D / 2 + 4);
  });
  try { grantEmbers(3); } catch (_) {}
}

export function enterCatacomb(returnPos) {
  if (!_group) return;
  // Stash overworld position to restore on exit
  _returnPos = returnPos
    ? { x: returnPos.x, y: returnPos.y || 0, z: returnPos.z }
    : { x: state.hero.pos.x, y: 0, z: state.hero.pos.z };
  state.mode = 'catacomb';
  _group.position.y = 0;
  // Hide overworld envGroup so the dungeon feels enclosed + the overworld
  // lights/fog don't bleed in. Same trick interior.js uses by parking groups.
  if (state.envGroup) state.envGroup.position.y = -200;
  // Also hide the run-scene entrance mesh (it's parked at y=0 in the run scene)
  if (_entranceMesh) _entranceMesh.visible = false;

  // Drop hero just north of the stairs, facing into the room
  state.hero.pos.set(STAIRS_X, 0, STAIRS_Z - 2);
  state.hero.vel.set(0, 0, 0);
  state.hero.facing.set(0, 0, -1);

  // Wave state — kick off first wave immediately
  _waveIdx = 0;
  _waveSpawnDelay = 0.4;
  _rewardDropped = false;
  _exitChestSpawned = false;
  _chamberMobIds.clear();
  _activeOnStairs = false;
}

export function exitCatacomb() {
  if (!_group) return;
  // Kill / clean up any wave mobs still alive
  for (const e of _chamberMobIds) {
    if (!e) continue;
    e.alive = false;
    if (e.mesh) {
      e.mesh.visible = false;
      // Return to pool if it's a normal pooled mob
      if (e.glbKey && state.enemies.pools[e.glbKey]) {
        state.enemies.pools[e.glbKey].push(e.mesh);
      } else if (e.mesh.parent) {
        e.mesh.parent.remove(e.mesh);
      }
    }
    const idx = state.enemies.active.indexOf(e);
    if (idx >= 0) state.enemies.active.splice(idx, 1);
  }
  _chamberMobIds.clear();
  // Clear enemy projectiles spawned in here
  for (const p of state.enemyProjectiles.active) {
    if (p.mesh && p.mesh.parent) p.mesh.parent.remove(p.mesh);
  }
  state.enemyProjectiles.active.length = 0;

  // Restore overworld
  state.mode = 'run';
  _group.position.y = -200;
  if (state.envGroup) state.envGroup.position.y = 0;
  if (_entranceMesh) _entranceMesh.visible = true;
  if (_promptEl) _promptEl.style.display = 'none';
  _activeOnStairs = false;

  if (_returnPos) {
    state.hero.pos.set(_returnPos.x, _returnPos.y || 0, _returnPos.z);
    state.hero.vel.set(0, 0, 0);
  }
  _returnPos = null;
}

export function tickCatacomb(dt) {
  if (state.mode !== 'catacomb') {
    if (_promptEl && _promptEl.style.display !== 'none') _promptEl.style.display = 'none';
    return;
  }
  if (!_group) return;

  // Torch flicker
  const t = state.time.real;
  for (let i = 0; i < _torches.length; i++) {
    const tg = _torches[i];
    const ud = tg.userData;
    if (ud && ud.pl) {
      const flicker = 0.8 + 0.25 * Math.sin(t * 6.7 + i * 1.3) + 0.12 * Math.sin(t * 13.1 + i * 0.7);
      ud.pl.intensity = flicker;
      if (ud.cone) {
        const s = 0.9 + 0.18 * Math.sin(t * 8.0 + i * 1.1);
        ud.cone.scale.set(s, 1.0 + 0.12 * Math.sin(t * 7.3 + i), s);
        ud.cone.material.emissiveIntensity = 1.8 + 0.6 * Math.sin(t * 9.0 + i);
      }
    }
  }

  // Constrain hero to chamber
  const margin = 0.7;
  const h = state.hero.pos;
  const minX = -CHAMBER_W / 2 + margin;
  const maxX =  CHAMBER_W / 2 - margin;
  const minZ = -CHAMBER_D / 2 + margin;
  const maxZ =  CHAMBER_D / 2 - margin;
  if (h.x < minX) h.x = minX;
  if (h.x > maxX) h.x = maxX;
  if (h.z < minZ) h.z = minZ;
  if (h.z > maxZ) h.z = maxZ;

  // Wave logic
  if (_waveIdx < TOTAL_WAVES) {
    if (_waveSpawnDelay > 0) {
      _waveSpawnDelay -= dt;
      if (_waveSpawnDelay <= 0) {
        _spawnWave();
        _waveIdx++;
      }
    } else {
      // Wait until all wave mobs are clear, then queue the next wave
      if (_countAliveWaveMobs() === 0) {
        _waveSpawnDelay = 1.2;
      }
    }
  } else {
    // All waves spawned; drop reward when chamber is clear
    if (!_rewardDropped && _countAliveWaveMobs() === 0) {
      _rewardDropped = true;
      _dropExitReward();
    }
  }

  // Stairs prompt — only show once all combat is done so the player isn't
  // tempted to bail mid-wave. (They still CAN leave via Escape in main.js.)
  const dx = h.x - STAIRS_X;
  const dz = h.z - STAIRS_Z;
  const onStairs = (dx * dx + dz * dz) < 2.4 * 2.4;
  const combatDone = (_waveIdx >= TOTAL_WAVES) && (_countAliveWaveMobs() === 0);
  _activeOnStairs = onStairs && combatDone;
  if (_activeOnStairs) {
    setPromptLabel(_promptBinding, 'Ascend to the surface');
    _promptEl.style.display = 'block';
  } else if (onStairs && !combatDone) {
    // Status (no key glyph) — write raw text; gets rewritten when state flips.
    _promptEl.textContent = '⚔  Clear the chamber first';
    _promptEl.style.display = 'block';
  } else {
    _promptEl.style.display = 'none';
  }
}

export function isInCatacomb() {
  return state.mode === 'catacomb';
}

export function resetCatacomb() {
  // Called from run teardown — make sure we're not stuck in catacomb mode
  // and any wave mobs are cleared.
  if (_chamberMobIds.size > 0) {
    for (const e of _chamberMobIds) {
      if (!e) continue;
      e.alive = false;
      if (e.mesh && e.mesh.parent) e.mesh.parent.remove(e.mesh);
      const idx = state.enemies.active.indexOf(e);
      if (idx >= 0) state.enemies.active.splice(idx, 1);
    }
    _chamberMobIds.clear();
  }
  _returnPos = null;
  _waveIdx = 0;
  _waveSpawnDelay = 0;
  _rewardDropped = false;
  _exitChestSpawned = false;
  _activeOnStairs = false;
  if (_group) _group.position.y = -200;
  if (state.envGroup && state.envGroup.position.y < 0) state.envGroup.position.y = 0;
  if (_entranceMesh) _entranceMesh.visible = true;
  if (_promptEl) _promptEl.style.display = 'none';
}

export const CATACOMB_DIMS = { W: CHAMBER_W, D: CHAMBER_D };
