/**
 * Town hub — walkable plaza between runs.
 *
 * Phase-1 scaffold: stone plaza, cabin (future House upgrades), Adventure Gate
 * (starts a run on E), four lamp posts. The town group attaches to the main
 * scene and toggles visible based on state.mode === 'town'.
 *
 * In town mode, main.js runs a stripped-down tick (input + hero + fx + camera)
 * with no spawn director, weapons, enemies, or pickups.
 *
 * Interactables are a flat list: {pos, radius, label, key}. tickTown finds
 * the closest one inside its trigger radius and shows the [E] prompt; pressing
 * E fires the activate handler.
 */
import * as THREE from 'three';
import { state } from './state.js';
import { CHARACTERS } from './config.js';
import { getMeta, setOption } from './meta.js';
import { initChatBindings, tickBubbles } from './chatBubble.js';
import { bindPrompt, setPromptLabel, formatPrompt } from './buttonPrompts.js';
import { BLOOM_LAYER } from './postfx.js';
import { makeRuneRingTexture } from './enemyTells.js';

// Shared rune-ring texture for town FX (statue selection ring). Cached on
// first call so every statue + the catacomb / interior swaps share one upload.
let _runeTex = null;
function _getRuneTex() { return _runeTex || (_runeTex = makeRuneRingTexture()); }

const PLAZA_R = 18;
const FENCE_R = 22;

let _group = null;
let _portal = null;
let _promptEl = null;
let _promptBinding = null;
let _activeKey = null;
let _onGateActivate = null;
const _handlers = {};

// Static interactables — character statues are appended dynamically in buildTown.
const _interactables = [
  { pos: { x: 0, z: 14 },  radius: 3.5, label: '⚔  Enter the Hunt',      key: 'gate'  },
  { pos: { x: 0, z: -14 }, radius: 4.0, label: '🏠  Enter the House',    key: 'house' },
  { pos: { x: -12, z: -3 }, radius: 3.0, label: '🛒  Shop (coming soon)', key: 'shop'  },
];
// Per-character statue refs so we can repaint selection rings on select.
const _statueRefs = {};

function _matStandard(color, roughness = 0.85, metalness = 0.0) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function _makeCabin() {
  const g = new THREE.Group();
  // Body
  const body = new THREE.Mesh(new THREE.BoxGeometry(7, 4, 5), _matStandard(0x6a4a30, 0.85));
  body.position.y = 2;
  body.castShadow = true; body.receiveShadow = true;
  g.add(body);
  // Pyramid roof
  const roof = new THREE.Mesh(new THREE.ConeGeometry(5.2, 2.6, 4), _matStandard(0x553028, 0.9));
  roof.rotation.y = Math.PI / 4;
  roof.position.y = 5.3;
  roof.castShadow = true;
  g.add(roof);
  // Door
  const door = new THREE.Mesh(
    new THREE.PlaneGeometry(1.2, 2.2),
    new THREE.MeshStandardMaterial({ color: 0x2a1a10, roughness: 0.95, side: THREE.DoubleSide }),
  );
  door.position.set(0, 1.1, 2.51);
  g.add(door);
  // Glowing windows
  for (const x of [-2.2, 2.2]) {
    const w = new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, 0.9),
      new THREE.MeshStandardMaterial({
        color: 0xffd86a, emissive: 0xffb050, emissiveIntensity: 0.9, roughness: 0.6,
      }),
    );
    w.position.set(x, 2.3, 2.51);
    g.add(w);
  }
  // Chimney
  const chim = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.6, 0.7), _matStandard(0x4a3a2a, 0.9));
  chim.position.set(2.2, 6.0, -1.2);
  chim.castShadow = true;
  g.add(chim);
  return g;
}

function _makeAdventureGate() {
  const g = new THREE.Group();
  // Two stone pillars
  for (const x of [-2.4, 2.4]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.9, 4.2, 0.9), _matStandard(0x5a5550, 0.9));
    p.position.set(x, 2.1, 0);
    p.castShadow = true;
    g.add(p);
  }
  // Lintel
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(6.0, 0.9, 1.0), _matStandard(0x5a5550, 0.9));
  lintel.position.set(0, 4.65, 0);
  lintel.castShadow = true;
  g.add(lintel);
  // Capstone above lintel
  const cap = new THREE.Mesh(new THREE.BoxGeometry(6.6, 0.4, 1.2), _matStandard(0x3a3530, 0.9));
  cap.position.set(0, 5.3, 0);
  g.add(cap);
  // Glowing portal disc — animated in tickTown
  _portal = new THREE.Mesh(
    new THREE.CircleGeometry(1.8, 36),
    new THREE.MeshBasicMaterial({ color: 0x7fffd4, transparent: true, opacity: 0.55, depthWrite: false }),
  );
  _portal.rotation.x = -Math.PI / 2;
  _portal.position.set(0, 0.06, 0);
  g.add(_portal);
  // Portal point light
  const pl = new THREE.PointLight(0x7fffd4, 1.8, 14, 2);
  pl.position.set(0, 1.6, 0);
  g.add(pl);
  return g;
}

function _makeLamp() {
  const g = new THREE.Group();
  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.15, 3.4, 8),
    _matStandard(0x222020, 0.85, 0.3),
  );
  post.position.y = 1.7;
  post.castShadow = true;
  g.add(post);
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.32, 12, 8),
    new THREE.MeshStandardMaterial({ color: 0xffd86a, emissive: 0xffb050, emissiveIntensity: 1.4 }),
  );
  head.position.y = 3.5;
  g.add(head);
  const pl = new THREE.PointLight(0xffb050, 0.9, 9, 2);
  pl.position.y = 3.4;
  g.add(pl);
  return g;
}

// Statue pedestal — `ch` is a CHARACTERS entry. `unlocked` toggles dim/lit.
function _makeCharStatue(ch, unlocked) {
  const g = new THREE.Group();
  // Selection ring under base (shown only for currently-picked character).
  // Iter 10b FX residue cleanup: swapped from flat RingGeometry +
  // MeshBasicMaterial to PlaneGeometry + makeRuneRingTexture so the statue
  // selection cue matches the rest of the game's "rune-warning" art
  // language (chest halo, elite tells, boss telegraphs all share the same tex).
  // Gold tint per brief — Hades-style "you are the chosen one" warmth.
  const ringGeo = new THREE.PlaneGeometry(3.1, 3.1);
  ringGeo.rotateX(-Math.PI / 2);
  const ring = new THREE.Mesh(
    ringGeo,
    new THREE.MeshBasicMaterial({
      map: _getRuneTex(),
      color: 0xffd24a, transparent: true, opacity: 0.85,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }),
  );
  ring.position.y = 0.04;
  ring.visible = false;
  ring.layers.enable(BLOOM_LAYER);
  g.add(ring);
  g.userData._selRing = ring;

  // Pedestal base
  const base = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.2, 0.5, 16), _matStandard(0x3a3530, 0.9));
  base.position.y = 0.25;
  base.castShadow = true; base.receiveShadow = true;
  g.add(base);
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.95, 0.2, 16), _matStandard(0x5a5550, 0.85));
  top.position.y = 0.6;
  g.add(top);

  // Figure — tinted by character color, scaled by character size. Locked
  // statues render as gray stone with a "?" plate.
  const tint = unlocked ? (ch.tint || 0xffffff) : 0x55514c;
  const scaleMul = (ch.scaleMul || 1.0) * (unlocked ? 1 : 0.85);
  // Body (block torso)
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 1.0, 0.55),
    new THREE.MeshStandardMaterial({ color: tint, roughness: 0.7, metalness: 0.05 }),
  );
  body.position.y = 1.35;
  body.scale.set(scaleMul, scaleMul, scaleMul);
  body.castShadow = true;
  g.add(body);
  // Head (sphere)
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.32, 16, 12),
    new THREE.MeshStandardMaterial({ color: tint, roughness: 0.6, metalness: 0.05 }),
  );
  head.position.y = 2.1;
  head.scale.set(scaleMul, scaleMul, scaleMul);
  head.castShadow = true;
  g.add(head);
  // Cape-ish back plate for silhouette variety (small box on back)
  const cape = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.7, 0.08),
    new THREE.MeshStandardMaterial({ color: tint, roughness: 0.85, metalness: 0.0 }),
  );
  cape.position.set(0, 1.4, -0.32);
  cape.scale.set(scaleMul, scaleMul, scaleMul);
  cape.castShadow = true;
  g.add(cape);

  if (!unlocked) {
    // Floating "?" plate above the head for clarity
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(0.6, 0.6),
      new THREE.MeshBasicMaterial({ color: 0xffaa44, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    );
    plate.position.y = 2.85;
    g.add(plate);
  } else {
    // Subtle accent point light over unlocked statues
    const pl = new THREE.PointLight(tint, 0.6, 4, 2);
    pl.position.y = 2.2;
    g.add(pl);
  }
  return g;
}

function _makeShopStall() {
  const g = new THREE.Group();
  // Counter
  const counter = new THREE.Mesh(new THREE.BoxGeometry(3.0, 1.2, 1.4), _matStandard(0x6a4a30, 0.85));
  counter.position.y = 0.6;
  counter.castShadow = true; counter.receiveShadow = true;
  g.add(counter);
  // Awning poles
  for (const x of [-1.3, 1.3]) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.8, 8), _matStandard(0x2a2018, 0.9));
    p.position.set(x, 2.0, 0);
    g.add(p);
  }
  // Striped awning (red + cream alternating planes)
  for (let i = 0; i < 6; i++) {
    const stripe = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 1.6),
      new THREE.MeshStandardMaterial({
        color: i % 2 === 0 ? 0xc23a3a : 0xece2cc, roughness: 0.9, side: THREE.DoubleSide,
      }),
    );
    stripe.position.set(-1.35 + i * 0.54, 3.0, 0.4);
    stripe.rotation.x = -Math.PI / 3;
    g.add(stripe);
  }
  return g;
}

export function buildTown(scene) {
  if (_group) return _group;
  const g = new THREE.Group();
  g.name = 'townGroup';

  // ── Plaza floor ──
  const plaza = new THREE.Mesh(
    new THREE.CircleGeometry(PLAZA_R, 64),
    new THREE.MeshStandardMaterial({ color: 0x8a7d6a, roughness: 0.85 }),
  );
  plaza.rotation.x = -Math.PI / 2;
  plaza.position.y = -0.05;
  plaza.receiveShadow = true;
  g.add(plaza);
  // Darker stone border ring
  const border = new THREE.Mesh(
    new THREE.RingGeometry(PLAZA_R, PLAZA_R + 1.2, 64),
    new THREE.MeshStandardMaterial({ color: 0x3c342c, roughness: 0.9 }),
  );
  border.rotation.x = -Math.PI / 2;
  border.position.y = -0.04;
  g.add(border);

  // ── Buildings + props ──
  const cabin = _makeCabin();
  cabin.position.set(0, 0, -14);
  g.add(cabin);

  const gate = _makeAdventureGate();
  gate.position.set(0, 0, 14);
  g.add(gate);

  const shopStall = _makeShopStall();
  shopStall.position.set(-12, 0, -3);
  shopStall.rotation.y = Math.PI / 6;
  g.add(shopStall);

  // ── Character statues — one per CHARACTERS entry, arc'd between hero
  // spawn (z=6) and the Adventure Gate (z=14). Player walks through them
  // on the way to the gate so character pick is the natural pre-run beat.
  const meta = getMeta();
  const N = CHARACTERS.length;
  for (let i = 0; i < N; i++) {
    const ch = CHARACTERS[i];
    const unlocked = ch.unlock === null || (meta.achievements && meta.achievements[ch.unlock]);
    // Place in a shallow arc centered at x=0, z=10.5, span ~14 across the plaza
    const t = (N === 1) ? 0 : (i / (N - 1) - 0.5);
    const px = t * 14;
    const pz = 10.5 + 0.6 * Math.abs(t);
    const statue = _makeCharStatue(ch, !!unlocked);
    statue.position.set(px, 0, pz);
    // Statue faces inward toward where the hero will stand (slightly tilted)
    statue.rotation.y = -Math.atan2(px, 6 - pz);
    g.add(statue);
    _statueRefs[ch.id] = statue;
    _interactables.push({
      pos: { x: px, z: pz },
      radius: 2.4,
      label: unlocked ? `🎭  Play as ${ch.name}` : `🔒  Locked · ${ch.unlock}`,
      key: `char:${ch.id}`,
      _unlocked: !!unlocked,
    });
  }
  // Initial ring repaint
  _repaintStatueSelection();

  // Lamp posts at four corners
  for (const [x, z] of [[-14, -14], [14, -14], [-14, 14], [14, 14]]) {
    const lamp = _makeLamp();
    lamp.position.set(x, 0, z);
    g.add(lamp);
  }

  // Town fence ring — short stone posts every ~30°
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const post = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.9, 0.4),
      _matStandard(0x6a635a, 0.9),
    );
    post.position.set(Math.cos(a) * FENCE_R, 0.45, Math.sin(a) * FENCE_R);
    post.castShadow = true;
    g.add(post);
  }

  scene.add(g);
  _group = g;

  // ── DOM interaction prompt ──
  if (!_promptEl) {
    _promptEl = document.createElement('div');
    _promptEl.id = 'kk-town-prompt';
    _promptEl.style.cssText = `
      position: fixed; bottom: 14%; left: 50%; transform: translateX(-50%);
      padding: 10px 22px; pointer-events: none; z-index: 90;
      background: linear-gradient(180deg, rgba(28,22,18,0.92), rgba(18,14,12,0.92));
      border: 1px solid rgba(255,220,160,0.35); border-radius: 8px;
      color: #f4e6c4; font: 600 16px 'Cinzel Decorative', serif;
      letter-spacing: 0.06em;
      box-shadow: 0 6px 18px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.08);
      backdrop-filter: blur(6px);
      display: none;
    `;
    document.body.appendChild(_promptEl);
    _promptBinding = bindPrompt(_promptEl, 'interact', '');
    window.addEventListener('keydown', _onKeyDown);
    initChatBindings();
  }

  g.visible = false;
  return g;
}

function _repaintStatueSelection() {
  const sel = getMeta().selectedChar;
  for (const id of Object.keys(_statueRefs)) {
    const ring = _statueRefs[id].userData._selRing;
    if (ring) ring.visible = (id === sel);
  }
}

function _selectChar(id) {
  const ch = CHARACTERS.find(c => c.id === id);
  if (!ch) return;
  const meta = getMeta();
  const unlocked = ch.unlock === null || (meta.achievements && meta.achievements[ch.unlock]);
  if (!unlocked) return;
  setOption('selectedChar', id);
  meta.selectedChar = id;
  _repaintStatueSelection();
  // Brief affordance toast
  if (_promptEl) _promptEl.textContent = `★  Now playing as ${ch.name}`;
}

function _onKeyDown(e) {
  if (state.mode !== 'town') return;
  if (e.code !== 'KeyE' && e.code !== 'Enter') return;
  if (!_activeKey) return;
  if (_activeKey === 'gate' && _onGateActivate) _onGateActivate();
  else if (_activeKey.startsWith('char:')) _selectChar(_activeKey.slice(5));
  else if (_handlers[_activeKey]) _handlers[_activeKey]();
}

export function setGateHandler(fn) { _onGateActivate = fn; }
export function setInteractionHandler(key, fn) { _handlers[key] = fn; }

export function enterTown() {
  state.mode = 'town';
  if (_group) _group.visible = true;
  // Spawn just inside the plaza, facing the gate
  state.hero.pos.set(0, 0, 6);
  state.hero.vel.set(0, 0, 0);
  state.hero.facing.set(0, 0, 1);
  _repaintStatueSelection();
}

export function exitTown() {
  state.mode = 'run';
  if (_group) _group.visible = false;
  if (_promptEl) _promptEl.style.display = 'none';
  _activeKey = null;
}

export function isInTown() { return state.mode === 'town'; }

export function tickTown(dt) {
  if (state.mode !== 'town') {
    if (_promptEl && _promptEl.style.display !== 'none') _promptEl.style.display = 'none';
    return;
  }

  // Position + fade speech bubbles each frame (Palace-style chat).
  tickBubbles();

  // Animate portal — gentle scale pulse + opacity sine
  const t = state.time.real;
  if (_portal) {
    const s = 1 + 0.08 * Math.sin(t * 2.6);
    _portal.scale.set(s, s, s);
    _portal.material.opacity = 0.50 + 0.18 * Math.sin(t * 2.6 + 0.4);
  }
  // Animate selected statue ring (rotate + opacity pulse) and gentle bob.
  // After the iter 10b swap, the X-rotation is baked into the PlaneGeometry,
  // so we yaw the rune by mutating rotation.y (the world-up axis) — same
  // visual feel as the original rotation.z spin on the un-baked RingGeometry.
  const sel = getMeta().selectedChar;
  if (sel && _statueRefs[sel]) {
    const ring = _statueRefs[sel].userData._selRing;
    if (ring) {
      ring.rotation.y += dt * 0.6;
      ring.material.opacity = 0.55 + 0.30 * Math.sin(t * 3.2);
      const rs = 1 + 0.08 * Math.sin(t * 2.4);
      ring.scale.set(rs, rs, rs);
    }
    _statueRefs[sel].position.y = 0.1 + 0.06 * Math.sin(t * 1.9);
  }
  // Reset bob on non-selected statues
  for (const id of Object.keys(_statueRefs)) {
    if (id !== sel) _statueRefs[id].position.y = 0;
  }

  // Closest interactable inside its trigger radius
  const h = state.hero.pos;
  let best = null, bestD = Infinity;
  for (const it of _interactables) {
    const dx = h.x - it.pos.x;
    const dz = h.z - it.pos.z;
    const d2 = dx * dx + dz * dz;
    const r = it.radius;
    if (d2 < r * r && d2 < bestD) { best = it; bestD = d2; }
  }
  _activeKey = best ? best.key : null;
  if (best) {
    setPromptLabel(_promptBinding, best.label);
    _promptEl.style.display = 'block';
  } else {
    _promptEl.style.display = 'none';
  }

  // Constrain hero to fence — sliding clamp
  const r2 = h.x * h.x + h.z * h.z;
  const R = FENCE_R - 0.8;
  if (r2 > R * R) {
    const r = Math.sqrt(r2);
    h.x = (h.x / r) * R;
    h.z = (h.z / r) * R;
  }
}
