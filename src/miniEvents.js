/**
 * Mid-run mini-events — break the "kill ring forever" monotony with periodic
 * one-off interludes. A single-slot scheduler enforces a max of 1 active event
 * at a time; new events queue (skip) when something else is running.
 *
 * Events:
 *   - TreasureGoblin : fast gold enemy fleeing the hero. Kill in 8s → Cache.
 *   - MeteorShower   : 6 telegraphed ground strikes, also damages enemies.
 *   - ElitePack      : 4–6 elites in tight cluster, kill all in 15s → chest.
 */
import * as THREE from 'three';
import { state } from './state.js';
import { ENEMY_TIERS } from './config.js';
import { spawnEnemy, damageEnemy } from './enemies.js';
import { spawnChest } from './chest.js';
import { spawnHeart, spawnStar } from './pickups.js';
import { dropGem } from './xp.js';
import { showBanner } from './ui.js';
import { spawnKillRing, spawnMagnetSpark } from './fx.js';
import { BLOOM_LAYER } from './postfx.js';
import { sfx } from './audio.js';
import { grantEmbers } from './meta.js';
import { makeRuneRingTexture } from './enemyTells.js';
import { tex } from './particleTextures.js';
import { spawnTellMote } from './bossTelegraphs.js';
import { initHelltide, tickHelltide, teardownHelltide, isHelltideActive } from './helltide.js';

let _miniEventRuneTex = null;
function _getMiniRuneTex() { return _miniEventRuneTex || (_miniEventRuneTex = makeRuneRingTexture()); }

// ── Tunables ─────────────────────────────────────────────────────────────────
const GOBLIN_INTERVAL    = 90;   // sec
const METEOR_INTERVAL_DEF = 110; // sec (default stages)
const METEOR_INTERVAL_CINDER = 75;
const ELITE_INTERVAL     = 60;   // sec (after 3min)
const ELITE_START_AT     = 180;  // 3min

const GOBLIN_HP          = 80;
const GOBLIN_SPD         = 5.5;
const GOBLIN_KILL_WINDOW = 8.0;

const METEOR_STRIKES     = 6;
const METEOR_ARM_TIME    = 2.5;
const METEOR_DAMAGE      = 20;
const METEOR_RADIUS      = 2.0;
const METEOR_SPREAD_MIN  = 4;
const METEOR_SPREAD_MAX  = 12;

const ELITE_KILL_WINDOW  = 15.0;
const ELITE_PACK_MIN     = 4;
const ELITE_PACK_MAX     = 6;

// ── Module state ─────────────────────────────────────────────────────────────
let _scene = null;
let _nextGoblinAt = 0;
let _nextMeteorAt = 0;
let _nextEliteAt  = 0;

let _activeEvent = null;       // 'goblin' | 'meteor' | 'elite' | null
let _goblinState = null;       // { enemy, deadlineAt, cacheGroup, cacheX, cacheZ }
let _meteorState = null;       // { strikes: [{x,z,armAt,ring,exploded}] }
let _eliteState  = null;       // { members: [enemyRefs], deadlineAt }

// ── Lifecycle ────────────────────────────────────────────────────────────────
export function initMiniEvents(scene) {
  _scene = scene;
  resetMiniEvents();
  // Iter 17: helltide owns its own pools (ember rain + chest meshes) attached
  // to the same scene. Single init = scene wire-up + schedule first trigger.
  try { initHelltide(scene); } catch (_) {}
}

export function resetMiniEvents() {
  _nextGoblinAt = GOBLIN_INTERVAL;
  _meteorIntervalReset();
  _nextEliteAt  = Math.max(ELITE_START_AT, ELITE_INTERVAL);
  _clearGoblin();
  _clearMeteor();
  _clearElite();
  _activeEvent = null;
  // Iter 17 — re-arm helltide auto-trigger for this run so the schedule
  // restarts cleanly on Run Again / Return to Town.
  try { initHelltide(_scene); } catch (_) {}
}

function _meteorIntervalReset() {
  const stageId = state.run && state.run.stage && state.run.stage.id;
  const ivl = (stageId === 'cinder') ? METEOR_INTERVAL_CINDER : METEOR_INTERVAL_DEF;
  _nextMeteorAt = ivl;
}

function _meteorInterval() {
  const stageId = state.run && state.run.stage && state.run.stage.id;
  return (stageId === 'cinder') ? METEOR_INTERVAL_CINDER : METEOR_INTERVAL_DEF;
}

// ── Public tick ──────────────────────────────────────────────────────────────
export function tickMiniEvents(dt) {
  const t = state.time.game;
  if (!_scene) return;

  // Iter 17 — Helltide overlay ticks first (owns its own scheduler + pools).
  try { tickHelltide(dt); } catch (_) {}
  const helltide = isHelltideActive();

  // Update active event (existing mini-events still resolve to completion
  // even if a helltide kicks in mid-event — abandoning them mid-pack would
  // strand the rewards.)
  if (_activeEvent === 'goblin') _tickGoblin(dt, t);
  else if (_activeEvent === 'meteor') _tickMeteor(dt, t);
  else if (_activeEvent === 'elite')  _tickElite(dt, t);

  // Schedule new events (only if nothing active — single-slot). Helltide
  // suppresses NEW mini-event starts (too many things happening already);
  // the timers are bumped so they don't immediately fire when the helltide
  // ends.
  if (!_activeEvent && !helltide) {
    if (t >= _nextGoblinAt) {
      _startGoblin();
      _nextGoblinAt = t + GOBLIN_INTERVAL;
    } else if (t >= _nextMeteorAt) {
      _startMeteor();
      _nextMeteorAt = t + _meteorInterval();
    } else if (t >= _nextEliteAt && t >= ELITE_START_AT) {
      _startElite();
      _nextEliteAt = t + ELITE_INTERVAL;
    }
  } else {
    // While an event is active OR a helltide is running, bump pending timers
    // forward so they don't immediately fire on completion.
    if (t >= _nextGoblinAt) _nextGoblinAt = t + 5;
    if (t >= _nextMeteorAt) _nextMeteorAt = t + 5;
    if (t >= _nextEliteAt)  _nextEliteAt  = t + 5;
  }

  // Cache pickup polling (independent of active event state — cache lingers
  // after the goblin event ends until the hero touches it).
  _tickCachePickup();
}

// ── Treasure Goblin ──────────────────────────────────────────────────────────
function _startGoblin() {
  // Reuse the goblin tier as a base so it pools naturally + uses goblin glb.
  const base = ENEMY_TIERS.find(t => t.glb === 'goblin');
  if (!base) return;
  const tier = {
    ...base,
    hp: GOBLIN_HP,
    spd: GOBLIN_SPD,
    dmg: 0,                 // doesn't damage hero (and won't contact anyway)
    scale: (base.scale || 1) * 1.1,
  };
  const hp = state.hero.pos;
  const ang = Math.random() * Math.PI * 2;
  const r = 6 + Math.random() * 4;
  const x = hp.x + Math.cos(ang) * r;
  const z = hp.z + Math.sin(ang) * r;
  const e = spawnEnemy(tier, x, z);
  if (!e) return;
  // Tag for fleeing behavior + identify as goblin event
  e._flee = true;
  e._isTreasureGoblin = true;
  // Gold tint via emissive
  if (e.mesh && e.mesh.userData && e.mesh.userData.flashMats) {
    for (const fm of e.mesh.userData.flashMats) {
      if (fm.mat && fm.mat.emissive) {
        fm.mat.emissive.setHex(0xffd24a);
        fm.mat.emissiveIntensity = 0.55;
        // Update the "origEmissive" so post-flash restoration keeps the gold tint.
        fm.origEmissive = 0xffd24a;
        fm.origIntensity = 0.55;
      }
    }
  }
  // Snapshot original flashMat emissives so we can restore them after the
  // event ends (pooled meshes are shared with normal goblin spawns).
  const origFlash = [];
  if (e.mesh && e.mesh.userData && e.mesh.userData.flashMats) {
    for (const fm of e.mesh.userData.flashMats) {
      origFlash.push({ fm, prevEmissive: fm.origEmissive, prevIntensity: fm.origIntensity });
    }
  }
  _goblinState = { enemy: e, deadlineAt: state.time.game + GOBLIN_KILL_WINDOW, origFlash };
  _activeEvent = 'goblin';
  showBanner('★ TREASURE GOBLIN ★', 2.5, '#ffd24a');
  if (sfx && sfx.bossWarn) sfx.bossWarn();
}

function _tickGoblin(dt, t) {
  const gs = _goblinState;
  if (!gs) { _activeEvent = null; return; }
  const e = gs.enemy;
  if (!e || !e.alive) {
    // Killed in time?
    if (t <= gs.deadlineAt) {
      _spawnCache(e ? e.mesh.position.x : state.hero.pos.x,
                  e ? e.mesh.position.z : state.hero.pos.z);
      showBanner('CACHE DROPPED', 2.0, '#ffd24a');
    } else {
      showBanner('THE GOBLIN ESCAPES', 2.0, '#a88a44');
    }
    _clearGoblin();
    _activeEvent = null;
    return;
  }
  // Escape: deadline expired OR ran too far
  const hp = state.hero.pos;
  const dx = e.mesh.position.x - hp.x;
  const dz = e.mesh.position.z - hp.z;
  const distSq = dx * dx + dz * dz;
  if (t >= gs.deadlineAt || distSq > 80 * 80) {
    // Despawn + escape — return mesh to pool manually
    e.alive = false;
    if (e.mesh) e.mesh.visible = false;
    if (state.enemies.spatial) state.enemies.spatial.remove(e);
    const arr = state.enemies.active;
    const i = arr.indexOf(e);
    if (i !== -1) { arr[i] = arr[arr.length - 1]; arr.pop(); }
    const pool = state.enemies.pools[e.glbKey] || (state.enemies.pools[e.glbKey] = []);
    pool.push(e.mesh);
    showBanner('THE GOBLIN ESCAPES', 2.0, '#a88a44');
    _clearGoblin();
    _activeEvent = null;
  }
}

function _clearGoblin() {
  // Restore pooled mesh's flashMats so future regular spawns aren't gold.
  if (_goblinState && _goblinState.origFlash) {
    for (const o of _goblinState.origFlash) {
      if (!o.fm) continue;
      o.fm.origEmissive = o.prevEmissive;
      o.fm.origIntensity = o.prevIntensity;
      if (o.fm.mat && o.fm.mat.emissive) {
        o.fm.mat.emissive.setHex(o.prevEmissive);
        o.fm.mat.emissiveIntensity = o.prevIntensity;
      }
    }
  }
  _goblinState = null;
}

function _spawnCache(x, z) {
  // V2: persistent treasure-cache mesh — multi-mesh "faceted gem coffer"
  // replacing the iter-10 BoxGeometry placeholder. Three layers:
  //   1. Faceted gem body (OctahedronGeometry, scaled tall, gold emissive)
  //   2. Four ribbon planes draped at cardinals (sakura-pink trim glow)
  //   3. Inner sparkle billboard at the gem core (refractive feel)
  // Halo + twinkle pip above stay from the iter-10 pass.
  if (!_scene) return;
  const g = new THREE.Group();
  // 1. Faceted gem body — Octahedron rotated so a vertex points up,
  // scaled in Y to read as a tall coffer/crystal hybrid. Emissive gold
  // with subtle roughness so the iso camera still gets a clean facet read.
  const body = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.55, 0),
    new THREE.MeshStandardMaterial({
      color: 0xffd24a, emissive: 0xffaa22, emissiveIntensity: 0.7, roughness: 0.32, metalness: 0.15,
    })
  );
  body.position.y = 0.55;
  body.scale.set(1.0, 1.35, 1.0);
  body.castShadow = true;
  // 2. Four ribbon decal planes at cardinals — sakura pink emissive trim.
  // Each is a thin upright plane glued to a face of the gem so the
  // silhouette breaks up the octahedron's bare profile from any angle.
  const ribbonMat = new THREE.MeshBasicMaterial({
    map: tex('twinklePink'),
    color: 0xe8a3c7,
    transparent: true, opacity: 0.85,
    depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  for (let r = 0; r < 4; r++) {
    const ribbon = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.9), ribbonMat);
    const a = (r / 4) * Math.PI * 2;
    ribbon.position.set(Math.cos(a) * 0.45, 0.55, Math.sin(a) * 0.45);
    ribbon.rotation.y = -a;
    ribbon.layers.enable(BLOOM_LAYER);
    g.add(ribbon);
  }
  // 3. Inner sparkle billboard — sits at the gem core so the gem reads as
  // "powered" rather than "solid casting". Twinkle texture, additive, tiny.
  const innerSpark = new THREE.Mesh(
    new THREE.PlaneGeometry(0.5, 0.5),
    new THREE.MeshBasicMaterial({
      map: tex('twinkleGold'),
      transparent: true, opacity: 1.0,
      depthWrite: false, blending: THREE.AdditiveBlending,
    })
  );
  innerSpark.position.y = 0.55;
  innerSpark.rotation.x = -Math.PI / 6; // angled toward iso camera
  innerSpark.layers.enable(BLOOM_LAYER);
  g.userData.innerSpark = innerSpark;
  g.add(innerSpark);
  // Halo above cache — textured rune disc + sparkle overlay so the cache
  // pings the eye through any crowd as a "treasure goblin reward".
  const ring = new THREE.Mesh(
    new THREE.PlaneGeometry(1.8, 1.8),
    new THREE.MeshBasicMaterial({
      map: _getMiniRuneTex(),
      color: 0xffe14a, transparent: true, opacity: 0.95,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    })
  );
  ring.rotation.order = 'YXZ';
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 1.4;
  ring.userData.spinPhase = Math.random() * Math.PI * 2;
  ring.layers.enable(BLOOM_LAYER);
  // Twinkle pip floating above the halo
  const twinkle = new THREE.Mesh(
    new THREE.PlaneGeometry(0.7, 0.7),
    new THREE.MeshBasicMaterial({
      map: tex('twinkleGold'),
      transparent: true, opacity: 0.9,
      depthWrite: false, blending: THREE.AdditiveBlending,
    })
  );
  twinkle.rotation.x = -Math.PI / 2;
  twinkle.position.y = 1.85;
  twinkle.layers.enable(BLOOM_LAYER);
  g.add(body); g.add(ring); g.add(twinkle);
  g.userData.twinkle = twinkle;
  g.position.set(x, 0, z);
  g.userData.ring = ring;
  g.userData.t = 0;
  _scene.add(g);
  _caches.push({ group: g, x, z, alive: true, t: 0 });
}

const _caches = [];
const CACHE_PICKUP_R2 = 4.0;
function _tickCachePickup() {
  if (_caches.length === 0) return;
  const dt = state.time.dt || 0;
  const hx = state.hero.pos.x, hz = state.hero.pos.z;
  for (let i = _caches.length - 1; i >= 0; i--) {
    const c = _caches[i];
    if (!c.alive) continue;
    c.t += dt;
    if (c.group.userData.ring) c.group.userData.ring.rotation.y += dt * 1.6;
    if (c.group.userData.twinkle) {
      c.group.userData.twinkle.rotation.z += dt * 3.2;
      c.group.userData.twinkle.material.opacity = 0.6 + 0.35 * Math.abs(Math.sin(c.t * 6));
    }
    // V2: gem-body slow rotation (facets glint) + inner spark pulse.
    c.group.rotation.y += dt * 0.6;
    if (c.group.userData.innerSpark) {
      c.group.userData.innerSpark.rotation.z += dt * 2.4;
      c.group.userData.innerSpark.material.opacity = 0.75 + 0.25 * Math.sin(c.t * 8);
    }
    c.group.position.y = Math.sin(c.t * 2.0) * 0.08;
    const dx = c.x - hx, dz = c.z - hz;
    if (dx * dx + dz * dz <= CACHE_PICKUP_R2) {
      c.alive = false;
      // Reward: 3 embers + a lucky reroll
      try { grantEmbers(3); } catch (_) {}
      state.hero.rerolls = (state.hero.rerolls || 0) + 1;
      spawnKillRing(c.x, c.z, true);
      for (let s = 0; s < 12; s++) {
        const a = (s / 12) * Math.PI * 2;
        const r = 0.5 + Math.random() * 0.5;
        spawnMagnetSpark(c.x + Math.cos(a) * r, 0.6 + Math.random() * 1.2, c.z + Math.sin(a) * r, 0xffe14a);
      }
      state.fx.bloomBoost = Math.max(state.fx.bloomBoost, 0.6);
      state.fx.shake = Math.max(state.fx.shake, 0.3);
      showBanner('+3 ✦  +1 REROLL', 2.0, '#ffd24a');
      if (_scene && c.group.parent) c.group.parent.remove(c.group);
      _caches.splice(i, 1);
    }
  }
}

// ── Meteor Shower ────────────────────────────────────────────────────────────
function _startMeteor() {
  const hp = state.hero.pos;
  const strikes = [];
  for (let i = 0; i < METEOR_STRIKES; i++) {
    const ang = Math.random() * Math.PI * 2;
    const r = METEOR_SPREAD_MIN + Math.random() * (METEOR_SPREAD_MAX - METEOR_SPREAD_MIN);
    const x = hp.x + Math.cos(ang) * r;
    const z = hp.z + Math.sin(ang) * r;
    const ring = _makeStrikeRing(METEOR_RADIUS);
    ring.position.set(x, 0.05, z);
    _scene.add(ring);
    strikes.push({
      x, z, ring, exploded: false,
      armAt: state.time.game + METEOR_ARM_TIME + i * 0.08,
    });
  }
  _meteorState = { strikes };
  _activeEvent = 'meteor';
  showBanner('☄ METEOR SHOWER ☄', 2.4, '#ff7733');
  if (sfx && sfx.bossWarn) sfx.bossWarn();
}

function _makeStrikeRing(radius) {
  // Layered impact telegraph:
  //  • filled red disc (danger zone, low alpha) — gives the floor a hot patch
  //  • textured rune ring (canonical magic-AoE art) — runic outline that
  //    rotates as the meteor arms, sells "summoning circle locking on".
  // Reads at a glance from any zoom level.
  const g = new THREE.Group();
  const inner = new THREE.Mesh(
    new THREE.CircleGeometry(radius * 0.9, 32),
    new THREE.MeshBasicMaterial({ color: 0xff3a2a, transparent: true, opacity: 0.32, depthWrite: false })
  );
  inner.rotation.x = -Math.PI / 2;
  const outline = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 2.1, radius * 2.1),
    new THREE.MeshBasicMaterial({
      map: _getMiniRuneTex(),
      color: 0xff5a3a, transparent: true, opacity: 0.95, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    })
  );
  outline.rotation.order = 'YXZ';
  outline.rotation.x = -Math.PI / 2;
  outline.userData.spinPhase = Math.random() * Math.PI * 2;
  outline.layers.enable(BLOOM_LAYER);
  inner.renderOrder = 4;
  outline.renderOrder = 5;
  g.add(inner); g.add(outline);
  g.userData.outline = outline;
  g.userData.inner = inner;
  return g;
}

function _tickMeteor(dt, t) {
  const ms = _meteorState;
  if (!ms) { _activeEvent = null; return; }
  let pendingAny = false;
  for (const s of ms.strikes) {
    if (s.exploded) continue;
    pendingAny = true;
    // Pulse the ring color as it approaches arm time
    const remain = Math.max(0, s.armAt - t);
    const k = 1 - Math.min(1, remain / METEOR_ARM_TIME);
    if (s.ring.userData.outline) {
      const o = s.ring.userData.outline;
      o.material.opacity = 0.6 + 0.4 * Math.abs(Math.sin(t * (4 + 8 * k)));
      // Rune outline spins faster as the meteor locks in — visible windup beat.
      o.rotation.y = (o.userData.spinPhase || 0) + t * (0.6 + k * 2.4);
    }
    if (s.ring.userData.inner) {
      s.ring.userData.inner.material.opacity = 0.25 + 0.20 * k;
    }
    if (t >= s.armAt) {
      _explodeStrike(s);
    }
  }
  if (!pendingAny) {
    _clearMeteor();
    _activeEvent = null;
  }
}

function _explodeStrike(s) {
  s.exploded = true;
  if (s.ring && s.ring.parent) s.ring.parent.remove(s.ring);
  // Damage enemies in radius
  if (state.enemies.spatial) {
    const hits = state.enemies.spatial.queryRadius({ x: s.x, z: s.z }, METEOR_RADIUS);
    for (const e of hits) {
      if (!e || !e.alive) continue;
      damageEnemy(e, METEOR_DAMAGE, 'meteor');
    }
  }
  // Damage hero if in radius
  const dx = state.hero.pos.x - s.x;
  const dz = state.hero.pos.z - s.z;
  if (dx * dx + dz * dz <= METEOR_RADIUS * METEOR_RADIUS) {
    import('./hero.js').then(({ takeDamage }) => takeDamage(METEOR_DAMAGE));
  }
  // FX
  spawnKillRing(s.x, s.z, true);
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const r = 0.5 + Math.random() * 1.0;
    spawnMagnetSpark(s.x + Math.cos(a) * r, 0.5 + Math.random() * 1.2, s.z + Math.sin(a) * r, 0xff7733);
  }
  state.fx.bloomBoost = Math.max(state.fx.bloomBoost, 0.55);
  state.fx.shake = Math.max(state.fx.shake, 0.35);
  state.fx.chromaticPulse = Math.max(state.fx.chromaticPulse, 0.5);
}

function _clearMeteor() {
  if (_meteorState) {
    for (const s of _meteorState.strikes) {
      if (!s.exploded && s.ring && s.ring.parent) s.ring.parent.remove(s.ring);
    }
  }
  _meteorState = null;
}

// ── Elite Pack ───────────────────────────────────────────────────────────────
function _startElite() {
  // Pick eligible elite tier from config (giant/dragon may be too tough — also
  // accept lesser mid-tier with elite flag synthesized).
  const D = _approxDifficulty();
  const eliteTiers = ENEMY_TIERS.filter(t => t.elite && t.minD <= D + 1);
  // Fall back to top mid-tier if no real elites unlocked yet.
  let base;
  if (eliteTiers.length > 0) {
    base = eliteTiers[Math.floor(Math.random() * eliteTiers.length)];
  } else {
    const mid = ENEMY_TIERS.filter(t => !t.elite && t.minD <= D);
    base = mid.length ? mid[mid.length - 1] : ENEMY_TIERS[0];
  }
  const tier = {
    ...base,
    hp: base.hp * 1.6,
    scale: (base.scale || 1) * 1.05,
    elite: true,    // mark so kill-fx + drops behave elite
  };
  const hp = state.hero.pos;
  const cAng = Math.random() * Math.PI * 2;
  const cR = 11 + Math.random() * 4;
  const cx = hp.x + Math.cos(cAng) * cR;
  const cz = hp.z + Math.sin(cAng) * cR;
  // Magenta telegraph ring at cluster center — textured rune disc so the
  // elite-pack warning reads as a hex circle vs a flat colored donut.
  const tellRing = new THREE.Mesh(
    new THREE.PlaneGeometry(5.4, 5.4),
    new THREE.MeshBasicMaterial({
      map: _getMiniRuneTex(),
      color: 0xff44ff, transparent: true, opacity: 0.9, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    })
  );
  tellRing.rotation.order = 'YXZ';
  tellRing.rotation.x = -Math.PI / 2;
  tellRing.position.set(cx, 0.05, cz);
  tellRing.userData.spinPhase = Math.random() * Math.PI * 2;
  tellRing.layers.enable(BLOOM_LAYER);
  tellRing.renderOrder = 5;
  _scene.add(tellRing);

  const count = ELITE_PACK_MIN + Math.floor(Math.random() * (ELITE_PACK_MAX - ELITE_PACK_MIN + 1));
  const members = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + Math.random() * 0.3;
    const r = 1.2 + Math.random() * 0.8;
    const ex = cx + Math.cos(a) * r;
    const ez = cz + Math.sin(a) * r;
    const e = spawnEnemy(tier, ex, ez);
    if (e) {
      e._eliteMember = true;
      // Magenta tint
      if (e.mesh && e.mesh.userData && e.mesh.userData.flashMats) {
        for (const fm of e.mesh.userData.flashMats) {
          if (fm.mat && fm.mat.emissive) {
            fm.mat.emissive.setHex(0xff44ff);
            fm.mat.emissiveIntensity = 0.5;
            fm.origEmissive = 0xff44ff;
            fm.origIntensity = 0.5;
          }
        }
      }
      members.push(e);
    }
  }
  _eliteState = {
    members,
    deadlineAt: state.time.game + ELITE_KILL_WINDOW,
    tellRing,
    cx, cz,
    // V2: mote accumulator for converging-pack tell. Motes spawn from
    // radius ~6u and lerp inward to the cluster center, sells "pack
    // assembling at this spot". Runs only during the first 2.4s of the
    // event so it reads as a one-shot announce, not ongoing background fx.
    convergeStart: state.time.game,
    moteAcc: 0,
  };
  _activeEvent = 'elite';
  showBanner('☠ ELITE PACK ☠', 2.5, '#ff44ff');
  if (sfx && sfx.bossWarn) sfx.bossWarn();
}

function _tickElite(dt, t) {
  const es = _eliteState;
  if (!es) { _activeEvent = null; return; }
  // Pulse + spin telegraph rune ring
  if (es.tellRing) {
    const pulse = 1 + Math.sin(t * 6) * 0.06;
    es.tellRing.scale.set(pulse, pulse, pulse);
    es.tellRing.material.opacity = 0.7 + Math.abs(Math.sin(t * 4)) * 0.3;
    es.tellRing.rotation.y = (es.tellRing.userData.spinPhase || 0) + t * 0.9;
  }
  // V2: converging-pack motes during the first 2.4s of the event. Magenta,
  // spawn at radius ~6u and travel toward (cx, cz). Reuses the shared
  // boss-tell mote pool (one InstancedMesh, drop-safe if cap reached).
  const convergeElapsed = t - es.convergeStart;
  if (convergeElapsed < 2.4) {
    es.moteAcc += dt;
    const rate = 0.10; // ~10 motes/sec → ~24 total over 2.4s
    while (es.moteAcc >= rate) {
      es.moteAcc -= rate;
      const a = Math.random() * Math.PI * 2;
      const r = 5.5 + Math.random() * 1.5;
      const sx = es.cx + Math.cos(a) * r;
      const sz = es.cz + Math.sin(a) * r;
      spawnTellMote(
        sx, sz,
        es.cx - sx, es.cz - sz,
        0.55 + Math.random() * 0.15,
        0xff9ee6,
        0.35, 1.5,
        0.20,
      );
    }
  }
  // Check pack status
  const allDead = es.members.every(e => !e || !e.alive);
  if (allDead) {
    if (t <= es.deadlineAt) {
      // Reward: guaranteed chest at center
      spawnChest(es.cx, es.cz);
      spawnHeart(es.cx + 1.2, es.cz);
      spawnStar(es.cx - 1.2, es.cz);
      showBanner('PACK CLEARED — WEAPON CACHE', 2.5, '#ff44ff');
      state.fx.bloomBoost = Math.max(state.fx.bloomBoost, 0.7);
      state.fx.shake = Math.max(state.fx.shake, 0.4);
    }
    _clearElite();
    _activeEvent = null;
    return;
  }
  // Deadline expired — surviving members keep fighting but pack reward is forfeit
  if (t >= es.deadlineAt) {
    showBanner('PACK ESCAPED', 2.0, '#884488');
    _clearElite();
    _activeEvent = null;
  }
}

function _clearElite() {
  if (_eliteState) {
    if (_eliteState.tellRing && _eliteState.tellRing.parent) {
      _eliteState.tellRing.parent.remove(_eliteState.tellRing);
    }
  }
  _eliteState = null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function _approxDifficulty() {
  // Re-derive approximate D(t) — mirror of spawnDirector.computeDifficulty
  // logic but inlined here so we don't add another import surface.
  const t = state.time.game;
  if (t < 60)  return t / 60;
  if (t < 600) return 1 + ((t - 60) / 540) * 6;  // 1 → 7 over 9 min
  return 7;
}

// ── Teardown ─────────────────────────────────────────────────────────────────
export function teardownMiniEvents() {
  _clearGoblin();
  _clearMeteor();
  _clearElite();
  _activeEvent = null;
  // Clean any lingering cache pickups
  for (const c of _caches) {
    if (c.group && c.group.parent) c.group.parent.remove(c.group);
  }
  _caches.length = 0;
  // Iter 17: helltide pools (chest meshes, ember rain, banked counter) reset
  // alongside mini-events so the next run starts clean.
  try { teardownHelltide(); } catch (_) {}
}
