/**
 * Treasure chests spawn periodically near the hero and on elite kills.
 * On pickup, opens a slot-machine modal that rolls 3 reels for a powerup.
 *
 * Chest visual: simple gold cube + spinning ring + "?" billboard above.
 * Will be swapped for a GLB later when one is downloaded.
 */
import * as THREE from 'three';
import { state } from './state.js';
import { showSlotMachine } from './ui.js';
import { spawnKillRing, spawnMagnetSpark } from './fx.js';
import { cloneCached } from './assets.js';
import { BLOOM_LAYER } from './postfx.js';
import { makeRuneRingTexture } from './enemyTells.js';
import { tex } from './particleTextures.js';

let _chestRuneTex = null;
function _getChestRuneTex() { return _chestRuneTex || (_chestRuneTex = makeRuneRingTexture()); }

const PICKUP_RADIUS_SQ = 4.0;   // 2 units
const CHEST_Y = 0.5;

// Module-local: scene + chest list. We keep meshes pooled per-chest (each chest
// has its own group; small count so no need to over-engineer).
const _chests = [];     // {group, x, z, alive, t}
let _scene = null;

const _ringQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));

function _makeChestMesh() {
  const g = new THREE.Group();

  // Try to use the GLB; auto-fit so it's player-readable
  const glb = cloneCached('chest');
  if (glb) {
    const box = new THREE.Box3().setFromObject(glb);
    const sz = box.getSize(new THREE.Vector3());
    const target = 1.8;
    const fit = sz.y > 1e-6 ? target / sz.y : 1;
    glb.scale.setScalar(fit);
    glb.position.y = -box.min.y * fit; // rest on ground
    glb.traverse(o => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = false;
        o.frustumCulled = false;
        // Make the chest glow gently
        if (o.material && 'emissive' in o.material) {
          o.material.emissive = new THREE.Color(0xffaa22);
          o.material.emissiveIntensity = 0.35;
        }
      }
    });
    g.add(glb);
  } else {
    // Fallback box if GLB missing
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 1.0, 1.0),
      new THREE.MeshLambertMaterial({ color: 0xb8860b, emissive: 0x442200, emissiveIntensity: 0.6 }),
    );
    body.position.y = CHEST_Y;
    g.add(body);
  }

  // Halo above the chest — textured rune disc (canonical magic ring art) +
  // a twinkle billboard. The chest needs to ping the player's eye through
  // a crowd; the layered halo replaces the old plain-torus identifier.
  const ring = new THREE.Mesh(
    new THREE.PlaneGeometry(2.4, 2.4),
    new THREE.MeshBasicMaterial({
      map: _getChestRuneTex(),
      color: 0xffe14a, transparent: true, opacity: 0.95,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }),
  );
  ring.position.y = 2.2;
  ring.rotation.order = 'YXZ';
  ring.quaternion.copy(_ringQuat);
  ring.userData.spinPhase = Math.random() * Math.PI * 2;
  ring.layers.enable(BLOOM_LAYER);
  g.add(ring);
  // Twinkle pip riding on top of the halo
  const twinkle = new THREE.Mesh(
    new THREE.PlaneGeometry(0.9, 0.9),
    new THREE.MeshBasicMaterial({
      map: tex('twinkleGold'),
      transparent: true, opacity: 0.95,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }),
  );
  twinkle.position.y = 2.55;
  twinkle.quaternion.copy(_ringQuat);
  twinkle.layers.enable(BLOOM_LAYER);
  g.add(twinkle);

  // Tag for the spin loop
  g.userData.ring = ring;
  g.userData.twinkle = twinkle;
  return g;
}

export function initChests(scene) {
  _scene = scene;
}

// Ephemeral "open chest" visual — spawns the chest_open GLB at world (x,z) and
// despawns it after 1.4s. Lives outside the chest list (no pickup logic).
const _openFlashes = []; // { group, t, life }
function _spawnOpenChestFlash(x, z) {
  if (!_scene) return;
  const glb = cloneCached('chest_open');
  if (!glb) return;
  const box = new THREE.Box3().setFromObject(glb);
  const sz = box.getSize(new THREE.Vector3());
  const target = 2.0;
  const fit = sz.y > 1e-6 ? target / sz.y : 1;
  glb.scale.setScalar(fit);
  glb.position.set(x, -box.min.y * fit, z);
  glb.traverse(o => {
    if (o.isMesh && o.material && 'emissive' in o.material) {
      o.material.emissive = new THREE.Color(0xffd24a);
      o.material.emissiveIntensity = 0.6;
    }
  });
  _scene.add(glb);
  _openFlashes.push({ group: glb, t: 0, life: 1.4 });
}

export function spawnChest(x, z) {
  if (!_scene) return;
  const mesh = _makeChestMesh();
  mesh.position.set(x, 0, z);
  _scene.add(mesh);
  _chests.push({ group: mesh, x, z, alive: true, t: 0 });
}

// Iter 10b — canonical chest-spawn helper for callers that don't want the
// near-hero randomized placement. Thin wrapper so the Treasure Map capstone in
// _primeRunStart can drop a chest at a stable offset from the hero spawn.
// Same return contract as spawnChest (void; chest is pushed onto _chests).
export function spawnAt(x, z) {
  return spawnChest(x, z);
}

function _tickOpenFlashes(dt) {
  for (let i = _openFlashes.length - 1; i >= 0; i--) {
    const f = _openFlashes[i];
    f.t += dt;
    const k = f.t / f.life;
    if (k >= 1) {
      _scene.remove(f.group);
      _openFlashes.splice(i, 1);
      continue;
    }
    // Lift + fade
    f.group.position.y += dt * 0.4;
    f.group.traverse(o => {
      if (o.isMesh && o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (!m.transparent) { m.transparent = true; m.depthWrite = false; }
          m.opacity = Math.max(0, 1 - k * 1.1);
        }
      }
    });
  }
}

export function tickChests(dt) {
  _tickOpenFlashes(dt);
  if (_chests.length === 0) return;
  const hx = state.hero.pos.x, hz = state.hero.pos.z;
  for (let i = _chests.length - 1; i >= 0; i--) {
    const c = _chests[i];
    if (!c.alive) continue;
    c.t += dt;

    // Spin halo + gentle bob. The rune ring uses YXZ Euler order so
    // rotation.y is the world-up yaw (composes BEFORE the flat-X rotation).
    const ring = c.group.userData.ring;
    if (ring) ring.rotation.y = (ring.userData.spinPhase || 0) + c.t * 1.6;
    const twinkle = c.group.userData.twinkle;
    if (twinkle) {
      twinkle.rotateZ(dt * 3.2);
      twinkle.material.opacity = 0.7 + 0.3 * Math.abs(Math.sin(c.t * 5.5));
    }
    c.group.position.y = Math.sin(c.t * 2.0) * 0.08;

    // Pickup check
    const dx = c.x - hx, dz = c.z - hz;
    if (dx * dx + dz * dz <= PICKUP_RADIUS_SQ) {
      c.alive = false;
      spawnKillRing(c.x, c.z, true); // big yellow ring
      // Burst of 10 gold sparks outward
      for (let s = 0; s < 10; s++) {
        const a = (s / 10) * Math.PI * 2 + Math.random() * 0.3;
        const r = 0.4 + Math.random() * 0.4;
        spawnMagnetSpark(c.x + Math.cos(a) * r, 0.6 + Math.random() * 1.0, c.z + Math.sin(a) * r, 0xffe14a);
      }
      // Visual "open" — swap to chest_open GLB at the same position for a beat,
      // then despawn. Fire-and-forget; the open mesh is its own ephemeral object.
      _spawnOpenChestFlash(c.x, c.z);
      _scene.remove(c.group);
      _chests.splice(i, 1);
      state.fx.shake = Math.max(state.fx.shake, 0.4);
      state.fx.bloomBoost = Math.max(state.fx.bloomBoost, 0.5);
      import('./ui.js').then(({ tryAchievement }) => tryAchievement('first_chest'));
      import('./meta.js').then(({ questEvent }) => questEvent('chestOpen'));
      showSlotMachine();
      return; // one chest per frame
    }
  }
}

export function spawnChestNearHero(minR = 6, maxR = 12) {
  const ang = Math.random() * Math.PI * 2;
  const r = minR + Math.random() * (maxR - minR);
  const x = state.hero.pos.x + Math.cos(ang) * r;
  const z = state.hero.pos.z + Math.sin(ang) * r;
  spawnChest(x, z);
}

export function resetChests() {
  if (!_scene) return;
  for (const c of _chests) {
    if (c.group && c.group.parent) c.group.parent.remove(c.group);
  }
  _chests.length = 0;
}
