/**
 * Mini-boss telegraphs: named announcements + periodic wind-up + radial
 * shockwave special attack. Gives bosses signature presence + a fair "tell"
 * the player can dodge with a dash. Final boss also uses this on a faster
 * cadence so the climax has actual pressure beats.
 *
 * Per-enemy state stored on the enemy object itself (no parallel map):
 *   _telegraphInit  bool   — first-sight bootstrap
 *   _nextTellAt     number — gameTime of next wind-up start
 *   _windupStart    number — gameTime when current wind-up started (-1 if idle)
 *   _tellRing       Mesh   — the growing red warning ring (scene-owned)
 */
import * as THREE from 'three';
import { state } from './state.js';
import { BLOOM_LAYER } from './postfx.js';
import { takeDamage as heroTakeDamage } from './hero.js';
import { sfx } from './audio.js';
import { makeRuneRingTexture } from './enemyTells.js';

let _runeTex = null;
function _getRuneTex() { return _runeTex || (_runeTex = makeRuneRingTexture()); }

export const MINI_BOSS_NAMES = [
  { name: 'GROTHAR THE GLUTTON',     subtitle: 'awakens hungering' },
  { name: 'VEXMAW THE SHRIEKER',     subtitle: 'splits the canopy' },
  { name: 'OBLIDOR, IRON COLOSSUS',  subtitle: 'walks the wood'    },
];
export const FINAL_BOSS_NAME = { name: 'THE NIGHTMARE', subtitle: 'has come for you' };

const TELEGRAPH_INTERVAL_MINI = 9.0;
const TELEGRAPH_INTERVAL_FINAL = 6.0;
const WINDUP_DURATION    = 1.2;
const SHOCKWAVE_RADIUS   = 7.0;
const SHOCKWAVE_DAMAGE   = 18;
const FINAL_SHOCKWAVE_RADIUS = 9.0;
const FINAL_SHOCKWAVE_DAMAGE = 26;

let _scene = null;
const _activeRings = []; // outward-expanding hit confirmations

export function initBossTelegraphs(scene) {
  _scene = scene;
}

export function nameForMiniBoss(idx) {
  return MINI_BOSS_NAMES[idx] || { name: 'NAMELESS HORROR', subtitle: 'arrives' };
}

function _makeWindupRing() {
  // Plane + rune texture instead of flat RingGeometry — runic ticks +
  // radial falloff sells "danger zone" vs a plain colored donut.
  const g = new THREE.PlaneGeometry(2.0, 2.0);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.MeshBasicMaterial({
    map: _getRuneTex(),
    color: 0xff3a3a, transparent: true, opacity: 0.95,
    depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(g, m);
  ring.layers.enable(BLOOM_LAYER);
  ring.position.y = 0.04;
  ring.renderOrder = 5;
  return ring;
}

function _makeShockwaveRing(color) {
  const g = new THREE.PlaneGeometry(1.8, 1.8);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.MeshBasicMaterial({
    map: _getRuneTex(),
    color: color || 0xffaa44, transparent: true, opacity: 1.0,
    depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(g, m);
  ring.layers.enable(BLOOM_LAYER);
  ring.position.y = 0.05;
  ring.renderOrder = 5;
  return ring;
}

export function updateBossTelegraphs(dt) {
  if (!_scene) return;
  const t = state.time.game;
  const active = state.enemies.active;

  // Expanding shockwave visuals (post-resolve)
  for (let i = _activeRings.length - 1; i >= 0; i--) {
    const r = _activeRings[i];
    r.age += dt;
    const k = r.age / r.ttl;
    if (k >= 1) {
      if (r.mesh.parent) r.mesh.parent.remove(r.mesh);
      const last = _activeRings.length - 1;
      if (i !== last) _activeRings[i] = _activeRings[last];
      _activeRings.pop();
      continue;
    }
    const s = 0.5 + k * r.maxRadius * 1.3;
    r.mesh.scale.set(s, 1, s);
    r.mesh.material.opacity = 1 - k;
  }

  for (let i = 0; i < active.length; i++) {
    const e = active[i];
    if (!e.alive) continue;
    if (!(e.isMiniBoss || e.isFinalBoss)) continue;

    if (!e._telegraphInit) {
      e._telegraphInit = true;
      e._windupStart = -1;
      // Slight delay before the first tell so the spawn banner reads cleanly
      e._nextTellAt = t + (e.isFinalBoss ? 4.0 : 6.0);
    }

    const interval  = e.isFinalBoss ? TELEGRAPH_INTERVAL_FINAL : TELEGRAPH_INTERVAL_MINI;
    const radius    = e.isFinalBoss ? FINAL_SHOCKWAVE_RADIUS   : SHOCKWAVE_RADIUS;
    const damage    = e.isFinalBoss ? FINAL_SHOCKWAVE_DAMAGE   : SHOCKWAVE_DAMAGE;

    if (e._windupStart > 0) {
      const elapsed = t - e._windupStart;
      if (elapsed >= WINDUP_DURATION) {
        _resolveShockwave(e, radius, damage);
        if (e._tellRing) {
          if (e._tellRing.parent) e._tellRing.parent.remove(e._tellRing);
          e._tellRing = null;
        }
        e._windupStart = -1;
        e._nextTellAt = t + interval;
      } else if (e._tellRing) {
        const k = elapsed / WINDUP_DURATION;
        const s = 0.6 + k * radius * 0.88;
        e._tellRing.scale.set(s, 1, s);
        e._tellRing.position.x = e.mesh.position.x;
        e._tellRing.position.z = e.mesh.position.z;
        // Pulse so the threat reads even peripherally
        e._tellRing.material.opacity = 0.4 + 0.55 * (0.5 + 0.5 * Math.sin(t * 22));
      }
      continue;
    }

    if (t >= e._nextTellAt) {
      e._windupStart = t;
      const ring = _makeWindupRing();
      ring.position.set(e.mesh.position.x, 0.04, e.mesh.position.z);
      ring.scale.set(0.6, 1, 0.6);
      _scene.add(ring);
      e._tellRing = ring;
      if (sfx && sfx.bossSpawn) sfx.bossSpawn();
    }
  }
}

function _resolveShockwave(boss, radius, damage) {
  const bx = boss.mesh.position.x;
  const bz = boss.mesh.position.z;

  // Hero damage + knockback if inside the danger zone
  const hp = state.hero.pos;
  const dx = hp.x - bx, dz = hp.z - bz;
  const dsq = dx * dx + dz * dz;
  if (dsq <= radius * radius) {
    heroTakeDamage(damage);
    const d = Math.max(0.001, Math.sqrt(dsq));
    state.hero.pos.x = bx + (dx / d) * (radius + 0.5);
    state.hero.pos.z = bz + (dz / d) * (radius + 0.5);
  }

  const ring = _makeShockwaveRing(boss.isFinalBoss ? 0xff5555 : 0xffaa44);
  ring.position.set(bx, 0.05, bz);
  _scene.add(ring);
  _activeRings.push({ mesh: ring, age: 0, ttl: 0.55, maxRadius: radius });

  state.fx.shake      = Math.max(state.fx.shake || 0,      boss.isFinalBoss ? 0.65 : 0.45);
  state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.55);

  // The shockwave also flattens any breakable logs in its blast radius —
  // collateral that gives the player extra pickups during boss fights.
  import('./destructibles.js').then(({ smashLogsInRadius }) => smashLogsInRadius(bx, bz, radius));
}

export function resetBossTelegraphs() {
  for (const r of _activeRings) {
    if (r.mesh.parent) r.mesh.parent.remove(r.mesh);
  }
  _activeRings.length = 0;
}
