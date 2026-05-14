/**
 * Casino interior — Seedy Tent walkable room (iter 33g).
 *
 * Architectural sibling to interior.js. Player enters via the town's casino
 * interactable, lands in this room, walks up to one of five stations, and
 * presses E to open the matching modal (Slots, Parlay, Buffs, House) or
 * walks back to the exit interactable to return to town.
 *
 * Camera + control reuse the interior-mode branch in main.js (state.mode is
 * 'casino_interior'). Hero mesh + input are shared. Hero is clamped to the
 * room with a door gap on +Z so the south wall reads as the exit.
 *
 * Visuals lean on cached Poly Pizza GLBs (casino_building, casino_chip,
 * casino_dice) plus procedural geometry (velvet floor, gold trim, slot
 * cabinet, parlay table, bar counter, ledger desk, chandelier).
 */
import * as THREE from 'three';
import { state } from './state.js';
import { bindPrompt, setPromptLabel } from './buttonPrompts.js';
import { BLOOM_LAYER } from './postfx.js';
import { cloneCached } from './assets.js';

const ROOM_W = 20;
const ROOM_D = 14;
const WALL_H = 4.6;
const DOOR_W = 2.6;

let _group = null;
let _promptEl = null;
let _promptBinding = null;
let _activeKey = null;
const _handlers = {};
const _interactables = [
  { pos: { x: 0,   z: ROOM_D / 2 - 1.6 }, radius: 1.9, label: '🚪  Leave the Casino',         key: 'exit' },
  { pos: { x: -6,  z: -3.4 },             radius: 1.9, label: '🎰  Slot Machine · spin Embers',  key: 'slots' },
  { pos: { x: 6,   z: -3.4 },             radius: 1.9, label: '🪙  Parlay Table · double Sigils', key: 'parlay' },
  { pos: { x: -6,  z: 2.8 },              radius: 1.9, label: '✨  Buff Counter · spend Sigils',  key: 'buffs' },
  { pos: { x: 6,   z: 2.8 },              radius: 1.9, label: '👑  House Manager · unlocks',      key: 'house' },
];

function _matStandard(color, roughness = 0.85, metalness = 0.0) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function _makeFloor() {
  // Crimson velvet rug w/ darker checkerboard inset and gold border. Reads
  // "gambling den" without needing a texture upload.
  const g = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM_W, ROOM_D),
    _matStandard(0x4a0e10, 0.95),
  );
  base.rotation.x = -Math.PI / 2;
  base.position.y = 0;
  base.receiveShadow = true;
  g.add(base);
  // Inner checkerboard panel — 6x4 grid of dark/light squares
  const inset = new THREE.Group();
  const tileW = (ROOM_W - 4) / 6;
  const tileD = (ROOM_D - 4) / 4;
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 4; j++) {
      const dark = (i + j) % 2 === 0;
      const tile = new THREE.Mesh(
        new THREE.PlaneGeometry(tileW * 0.95, tileD * 0.95),
        new THREE.MeshBasicMaterial({
          color: dark ? 0x231a14 : 0x2a1414,
          transparent: true, opacity: 0.65,
        }),
      );
      tile.rotation.x = -Math.PI / 2;
      tile.position.set(
        -ROOM_W / 2 + 2 + tileW * (i + 0.5),
        0.004,
        -ROOM_D / 2 + 2 + tileD * (j + 0.5),
      );
      inset.add(tile);
    }
  }
  g.add(inset);
  // Gold border strips along the inset perimeter
  const goldMat = new THREE.MeshStandardMaterial({ color: 0xc98a3a, roughness: 0.4, metalness: 0.6 });
  const bN = new THREE.Mesh(new THREE.BoxGeometry(ROOM_W - 3.6, 0.04, 0.10), goldMat);
  bN.position.set(0, 0.02, -ROOM_D / 2 + 2);
  g.add(bN);
  const bS = new THREE.Mesh(new THREE.BoxGeometry(ROOM_W - 3.6, 0.04, 0.10), goldMat);
  bS.position.set(0, 0.02, ROOM_D / 2 - 2);
  g.add(bS);
  const bE = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.04, ROOM_D - 3.6), goldMat);
  bE.position.set(ROOM_W / 2 - 2, 0.02, 0);
  g.add(bE);
  const bW = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.04, ROOM_D - 3.6), goldMat);
  bW.position.set(-ROOM_W / 2 + 2, 0.02, 0);
  g.add(bW);
  // Baseboard trim along all four walls
  const trimMat = _matStandard(0x2a0a0a, 0.85);
  const trimH = 0.22;
  const tN = new THREE.Mesh(new THREE.BoxGeometry(ROOM_W, trimH, 0.14), trimMat);
  tN.position.set(0, trimH / 2, -ROOM_D / 2 + 0.18);
  g.add(tN);
  const tS = new THREE.Mesh(new THREE.BoxGeometry(ROOM_W, trimH, 0.14), trimMat);
  tS.position.set(0, trimH / 2, ROOM_D / 2 - 0.18);
  g.add(tS);
  const tE = new THREE.Mesh(new THREE.BoxGeometry(0.14, trimH, ROOM_D), trimMat);
  tE.position.set(ROOM_W / 2 - 0.18, trimH / 2, 0);
  g.add(tE);
  const tW = new THREE.Mesh(new THREE.BoxGeometry(0.14, trimH, ROOM_D), trimMat);
  tW.position.set(-ROOM_W / 2 + 0.18, trimH / 2, 0);
  g.add(tW);
  return g;
}

function _makeWall(w, h, color = 0x6a1014) {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, 0.25),
    _matStandard(color, 0.95),
  );
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

function _makeNeonSign() {
  // "CASINO" — a fat additive plane behind the back wall that bleeds bloom.
  // Kept as a single plane (no per-letter geometry) so the read is "neon glow"
  // without needing an SDF font upload.
  const g = new THREE.Group();
  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(7.5, 1.4),
    new THREE.MeshBasicMaterial({
      color: 0xff3a3a, transparent: true, opacity: 0.95,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }),
  );
  panel.layers.enable(BLOOM_LAYER);
  panel.position.set(0, WALL_H - 1.4, -ROOM_D / 2 + 0.4);
  g.add(panel);
  // A fainter outer halo so the neon reads soft, not pixelated
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(8.6, 2.2),
    new THREE.MeshBasicMaterial({
      color: 0xff7a3a, transparent: true, opacity: 0.32,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }),
  );
  halo.position.set(0, WALL_H - 1.4, -ROOM_D / 2 + 0.36);
  g.add(halo);
  // Warm fill light on the back wall
  const pl = new THREE.PointLight(0xff7a3a, 1.4, 8, 2);
  pl.position.set(0, WALL_H - 0.8, -ROOM_D / 2 + 1.2);
  g.add(pl);
  return g;
}

function _makeChandelier() {
  // Hanging brass ring + 6 candle bulbs. One pointlight at the ring's center.
  const g = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.1, 0.06, 8, 24),
    new THREE.MeshStandardMaterial({ color: 0xc98a3a, roughness: 0.35, metalness: 0.65 }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = WALL_H - 1.2;
  g.add(ring);
  // Suspension chain (short cylinder)
  const chain = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.02, 1.0, 6),
    _matStandard(0x8a6a3a, 0.6, 0.5),
  );
  chain.position.y = WALL_H - 0.7;
  g.add(chain);
  // Candle bulbs around the ring
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.10, 8, 6),
      new THREE.MeshStandardMaterial({
        color: 0xffd27f, emissive: 0xffd27f, emissiveIntensity: 1.8, roughness: 0.4,
      }),
    );
    bulb.position.set(Math.cos(a) * 1.1, WALL_H - 1.2, Math.sin(a) * 1.1);
    bulb.layers.enable(BLOOM_LAYER);
    g.add(bulb);
  }
  const pl = new THREE.PointLight(0xffd27f, 1.2, 14, 2);
  pl.position.set(0, WALL_H - 1.2, 0);
  g.add(pl);
  return g;
}

function _makeSlotMachine() {
  // Three-window slot cabinet — wood chassis, brass trim, glowing reel panes
  // (each pane a bloom-additive plane). Big enough that the interactable label
  // reads naturally when the player walks up.
  const g = new THREE.Group();
  const chassis = new THREE.Mesh(
    new THREE.BoxGeometry(1.8, 2.4, 0.9),
    _matStandard(0x3a1410, 0.7, 0.2),
  );
  chassis.position.y = 1.2;
  chassis.castShadow = true; chassis.receiveShadow = true;
  g.add(chassis);
  // Top crest — gold arch
  const crest = new THREE.Mesh(
    new THREE.BoxGeometry(2.0, 0.4, 1.0),
    new THREE.MeshStandardMaterial({ color: 0xc98a3a, roughness: 0.35, metalness: 0.65 }),
  );
  crest.position.y = 2.6;
  g.add(crest);
  // Brass frame around the reel area
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(1.55, 0.95, 0.05),
    new THREE.MeshStandardMaterial({ color: 0xc98a3a, roughness: 0.4, metalness: 0.6 }),
  );
  frame.position.set(0, 1.55, 0.46);
  g.add(frame);
  // Three reel panes (left, center, right)
  for (let i = 0; i < 3; i++) {
    const pane = new THREE.Mesh(
      new THREE.PlaneGeometry(0.42, 0.78),
      new THREE.MeshBasicMaterial({
        color: i === 1 ? 0xffd27f : 0xff7a3a,
        transparent: true, opacity: 0.92,
        depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      }),
    );
    pane.position.set(-0.48 + i * 0.48, 1.55, 0.49);
    pane.layers.enable(BLOOM_LAYER);
    pane.userData._slotPane = true;
    g.add(pane);
  }
  // Pull-lever on the side — short cylinder + red ball
  const leverArm = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.04, 0.55, 8),
    _matStandard(0x8a6a3a, 0.5, 0.5),
  );
  leverArm.position.set(1.0, 1.7, 0);
  g.add(leverArm);
  const leverBall = new THREE.Mesh(
    new THREE.SphereGeometry(0.10, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0xc23a3a, roughness: 0.4, metalness: 0.5 }),
  );
  leverBall.position.set(1.0, 2.0, 0);
  g.add(leverBall);
  // Coin tray at the bottom
  const tray = new THREE.Mesh(
    new THREE.BoxGeometry(1.5, 0.2, 0.5),
    _matStandard(0x2a1410, 0.7, 0.2),
  );
  tray.position.set(0, 0.3, 0.5);
  g.add(tray);
  // Coin tray glow
  const trayGlow = new THREE.PointLight(0xffd27f, 0.5, 3, 2);
  trayGlow.position.set(0, 0.6, 0.8);
  g.add(trayGlow);
  return g;
}

function _makeParlayTable() {
  // Round green-felt poker table w/ gold trim, casino_dice + chip stacks on top.
  const g = new THREE.Group();
  const top = new THREE.Mesh(
    new THREE.CylinderGeometry(1.4, 1.4, 0.12, 24),
    new THREE.MeshStandardMaterial({ color: 0x0e5a32, roughness: 0.95 }),
  );
  top.position.y = 0.9;
  top.castShadow = true; top.receiveShadow = true;
  g.add(top);
  // Gold trim ring
  const trim = new THREE.Mesh(
    new THREE.TorusGeometry(1.4, 0.07, 8, 32),
    new THREE.MeshStandardMaterial({ color: 0xc98a3a, roughness: 0.35, metalness: 0.65 }),
  );
  trim.rotation.x = Math.PI / 2;
  trim.position.y = 0.96;
  g.add(trim);
  // Pedestal
  const ped = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.32, 0.85, 12),
    _matStandard(0x3a1410, 0.7, 0.2),
  );
  ped.position.y = 0.45;
  g.add(ped);
  // Floor flare
  const flare = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.55, 0.05, 12),
    _matStandard(0x231a14, 0.85),
  );
  flare.position.y = 0.02;
  g.add(flare);
  // Dice on top (cached GLB) — two pips so it reads as a parlay roll
  for (let i = 0; i < 2; i++) {
    const die = cloneCached('casino_dice');
    if (!die) break;
    die.scale.setScalar(1.6);
    die.position.set(-0.3 + i * 0.6, 1.06, -0.2 + i * 0.4);
    die.rotation.set(Math.random() * 0.3, Math.random() * Math.PI, Math.random() * 0.3);
    die.traverse(o => { if (o.isMesh) { o.castShadow = true; } });
    g.add(die);
  }
  // Chip stacks (cached GLB) — two stacks of 3 each
  for (const [sx, sz] of [[-0.7, 0.3], [0.5, 0.5]]) {
    for (let s = 0; s < 3; s++) {
      const chip = cloneCached('casino_chip');
      if (!chip) break;
      chip.scale.setScalar(5);
      chip.rotation.x = -Math.PI / 2;
      chip.position.set(sx, 0.97 + s * 0.04, sz);
      g.add(chip);
    }
  }
  return g;
}

function _makeBuffCounter() {
  // Long wooden bar w/ brass rail and three glowing bottles on the back shelf.
  // Reads as a counter you walk up to and buy something from.
  const g = new THREE.Group();
  // Bar top
  const top = new THREE.Mesh(
    new THREE.BoxGeometry(3.6, 0.18, 1.0),
    _matStandard(0x3a1a10, 0.6, 0.25),
  );
  top.position.set(0, 1.05, 0);
  top.castShadow = true; top.receiveShadow = true;
  g.add(top);
  // Brass rail along the front edge
  const rail = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.04, 3.6, 8),
    new THREE.MeshStandardMaterial({ color: 0xc98a3a, roughness: 0.35, metalness: 0.65 }),
  );
  rail.rotation.z = Math.PI / 2;
  rail.position.set(0, 0.85, 0.55);
  g.add(rail);
  // Front panel (kick board)
  const front = new THREE.Mesh(
    new THREE.BoxGeometry(3.6, 0.95, 0.08),
    _matStandard(0x2a0a0a, 0.85),
  );
  front.position.set(0, 0.48, 0.5);
  g.add(front);
  // Back shelf — three bottles glowing magenta/cyan/gold
  for (let i = 0; i < 3; i++) {
    const color = [0xc9a4ff, 0x4fd0ff, 0xffd27f][i];
    const bottle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.16, 0.55, 10),
      new THREE.MeshStandardMaterial({
        color, emissive: color, emissiveIntensity: 0.9, roughness: 0.45,
      }),
    );
    bottle.position.set(-0.9 + i * 0.9, 1.45, -0.35);
    bottle.layers.enable(BLOOM_LAYER);
    bottle.castShadow = true;
    g.add(bottle);
    const cork = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 0.10, 8),
      _matStandard(0x4a2f1c, 0.85),
    );
    cork.position.set(-0.9 + i * 0.9, 1.77, -0.35);
    g.add(cork);
  }
  // Back shelf plank
  const shelf = new THREE.Mesh(
    new THREE.BoxGeometry(3.0, 0.06, 0.30),
    _matStandard(0x3a1a10, 0.6, 0.25),
  );
  shelf.position.set(0, 1.15, -0.35);
  g.add(shelf);
  // Counter accent light
  const pl = new THREE.PointLight(0xc9a4ff, 0.6, 4, 2);
  pl.position.set(0, 1.6, 0.5);
  g.add(pl);
  return g;
}

function _makeHouseDesk() {
  // Manager's desk — ornate wood, ledger book, chip-stack centerpiece,
  // crown ornament so the "house upgrades" function reads at a glance.
  const g = new THREE.Group();
  const top = new THREE.Mesh(
    new THREE.BoxGeometry(2.4, 0.16, 1.1),
    _matStandard(0x3a1a10, 0.6, 0.25),
  );
  top.position.y = 0.95;
  top.castShadow = true; top.receiveShadow = true;
  g.add(top);
  // 4 legs
  for (const [x, z] of [[-1.05, -0.45], [1.05, -0.45], [-1.05, 0.45], [1.05, 0.45]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.95, 0.14), _matStandard(0x2a0a0a, 0.85));
    leg.position.set(x, 0.475, z);
    g.add(leg);
  }
  // Ledger book
  const book = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.14, 0.5),
    new THREE.MeshStandardMaterial({ color: 0x8a1a1a, roughness: 0.7 }),
  );
  book.position.set(-0.55, 1.10, 0);
  g.add(book);
  // Quill on top of book
  const quill = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.005, 0.50, 6),
    _matStandard(0xf3e8cf, 0.85),
  );
  quill.rotation.z = Math.PI / 5;
  quill.position.set(-0.45, 1.30, -0.10);
  g.add(quill);
  // Chip-stack centerpiece — six chips stacked on a felt tray
  const tray = new THREE.Mesh(
    new THREE.CylinderGeometry(0.32, 0.32, 0.03, 12),
    new THREE.MeshStandardMaterial({ color: 0x0e5a32, roughness: 0.95 }),
  );
  tray.position.set(0.55, 1.05, 0);
  g.add(tray);
  for (let s = 0; s < 6; s++) {
    const chip = cloneCached('casino_chip');
    if (!chip) break;
    chip.scale.setScalar(5);
    chip.rotation.x = -Math.PI / 2;
    chip.position.set(0.55, 1.08 + s * 0.04, 0);
    g.add(chip);
  }
  // Crown ornament on top of the desk's back
  const crown = new THREE.Mesh(
    new THREE.ConeGeometry(0.15, 0.30, 6),
    new THREE.MeshStandardMaterial({ color: 0xc98a3a, emissive: 0xffd27f, emissiveIntensity: 0.4, roughness: 0.3, metalness: 0.7 }),
  );
  crown.position.set(0.55, 1.55, -0.45);
  crown.layers.enable(BLOOM_LAYER);
  g.add(crown);
  return g;
}

function _makeExitDoor() {
  // Visual marker for the south exit — wood double door + green EXIT sign.
  const g = new THREE.Group();
  const door = new THREE.Mesh(
    new THREE.BoxGeometry(DOOR_W, WALL_H - 0.6, 0.12),
    _matStandard(0x3a1a10, 0.8, 0.1),
  );
  door.position.y = (WALL_H - 0.6) / 2;
  g.add(door);
  // Door split line
  const split = new THREE.Mesh(
    new THREE.PlaneGeometry(0.04, WALL_H - 0.8),
    new THREE.MeshBasicMaterial({ color: 0x0a0608 }),
  );
  split.position.set(0, (WALL_H - 0.6) / 2, 0.07);
  g.add(split);
  // EXIT sign above
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(0.9, 0.30),
    new THREE.MeshBasicMaterial({
      color: 0x2aff66, transparent: true, opacity: 0.95,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }),
  );
  sign.position.set(0, WALL_H - 0.4, 0.07);
  sign.layers.enable(BLOOM_LAYER);
  g.add(sign);
  return g;
}

export function buildCasinoInterior(scene) {
  if (_group) return _group;
  const g = new THREE.Group();
  g.name = 'casinoInteriorGroup';

  // ── Floor ──
  g.add(_makeFloor());

  // ── Walls (back, east, west, front w/ door gap) ──
  const back = _makeWall(ROOM_W, WALL_H);
  back.position.set(0, WALL_H / 2, -ROOM_D / 2);
  g.add(back);
  const left = _makeWall(0.25, WALL_H);
  left.geometry = new THREE.BoxGeometry(0.25, WALL_H, ROOM_D);
  left.position.set(-ROOM_W / 2, WALL_H / 2, 0);
  g.add(left);
  const right = _makeWall(0.25, WALL_H);
  right.geometry = new THREE.BoxGeometry(0.25, WALL_H, ROOM_D);
  right.position.set(ROOM_W / 2, WALL_H / 2, 0);
  g.add(right);
  const halfDoor = DOOR_W / 2;
  const sideW = (ROOM_W - DOOR_W) / 2;
  const frontL = _makeWall(sideW, WALL_H);
  frontL.position.set(-(sideW / 2 + halfDoor), WALL_H / 2, ROOM_D / 2);
  g.add(frontL);
  const frontR = _makeWall(sideW, WALL_H);
  frontR.position.set((sideW / 2 + halfDoor), WALL_H / 2, ROOM_D / 2);
  g.add(frontR);
  const lintel = _makeWall(DOOR_W + 0.25, WALL_H * 0.32);
  lintel.position.set(0, WALL_H - 0.6, ROOM_D / 2);
  g.add(lintel);

  // ── Neon "CASINO" sign on the back wall ──
  g.add(_makeNeonSign());

  // ── Chandelier overhead ──
  g.add(_makeChandelier());

  // ── Furniture (5 stations matching _interactables) ──
  const slot = _makeSlotMachine();
  slot.position.set(-6, 0, -3.4 - 0.6);   // sit slightly behind the interact spot
  slot.rotation.y = 0.18;
  g.add(slot);

  const parlay = _makeParlayTable();
  parlay.position.set(6, 0, -3.4);
  g.add(parlay);

  const counter = _makeBuffCounter();
  counter.position.set(-6, 0, 2.8 + 0.4);
  counter.rotation.y = -Math.PI;          // face south so player approaches from front
  g.add(counter);

  const desk = _makeHouseDesk();
  desk.position.set(6, 0, 2.8 + 0.3);
  desk.rotation.y = Math.PI;
  g.add(desk);

  const door = _makeExitDoor();
  door.position.set(0, 0, ROOM_D / 2 - 0.05);
  g.add(door);

  // ── Side decor: poker chip clusters on the floor near the entry ──
  for (let i = 0; i < 6; i++) {
    const chip = cloneCached('casino_chip');
    if (!chip) break;
    chip.scale.setScalar(5);
    chip.rotation.x = -Math.PI / 2;
    chip.rotation.z = (i / 6) * Math.PI * 2;
    chip.position.set(
      (i % 2 === 0 ? -1 : 1) * (3 + Math.random() * 0.5),
      0.04 + (i % 3) * 0.02,
      ROOM_D / 2 - 3.2 + (Math.random() - 0.5) * 0.4,
    );
    g.add(chip);
  }

  // ── Ambient lighting ──
  const fill = new THREE.PointLight(0xffae6a, 0.55, 24, 2);
  fill.position.set(0, 3.4, 0);
  g.add(fill);
  // Cool kicker from front-left so the chandelier warm fill reads warm
  const kicker = new THREE.PointLight(0xc9a4ff, 0.35, 18, 2);
  kicker.position.set(-ROOM_W / 2 + 1.5, 3.0, ROOM_D / 2 - 2);
  g.add(kicker);
  // Red wall-wash from the neon sign side
  const wash = new THREE.PointLight(0xff3a3a, 0.4, 12, 2);
  wash.position.set(0, 2.4, -ROOM_D / 2 + 2);
  g.add(wash);

  // Hide initially — only visible when state.mode === 'casino_interior'
  g.position.y = -200;
  scene.add(g);
  _group = g;

  // ── DOM prompt ──
  if (!_promptEl) {
    _promptEl = document.createElement('div');
    _promptEl.id = 'kk-casino-interior-prompt';
    _promptEl.style.cssText = `
      position: fixed; bottom: 14%; left: 50%; transform: translateX(-50%);
      padding: 10px 22px; pointer-events: none; z-index: 90;
      background: linear-gradient(180deg, rgba(36,10,12,0.95), rgba(20,6,8,0.95));
      border: 1px solid rgba(255,60,60,0.55); border-radius: 8px;
      color: #ffd27f; font: 600 16px 'Cinzel Decorative', serif;
      letter-spacing: 0.06em;
      box-shadow: 0 6px 18px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,210,127,0.18);
      display: none;
    `;
    document.body.appendChild(_promptEl);
    _promptBinding = bindPrompt(_promptEl, 'interact', '');
    window.addEventListener('keydown', _onKeyDown);
  }
  return g;
}

function _onKeyDown(e) {
  if (state.mode !== 'casino_interior') return;
  if (e.code !== 'KeyE' && e.code !== 'Enter') return;
  if (!_activeKey) return;
  if (_handlers[_activeKey]) _handlers[_activeKey]();
}

export function setCasinoInteriorHandler(key, fn) { _handlers[key] = fn; }

export function enterCasinoInterior() {
  state.mode = 'casino_interior';
  if (_group) _group.position.y = 0;
  // Spawn at the door (south end of the room)
  state.hero.pos.set(0, 0, ROOM_D / 2 - 2.4);
  state.hero.vel.set(0, 0, 0);
  state.hero.facing.set(0, 0, -1);
}

export function exitCasinoInterior() {
  state.mode = 'town';
  if (_group) _group.position.y = -200;
  if (_promptEl) _promptEl.style.display = 'none';
  _activeKey = null;
}

export function tickCasinoInterior(dt) {
  if (state.mode !== 'casino_interior') {
    if (_promptEl && _promptEl.style.display !== 'none') _promptEl.style.display = 'none';
    return;
  }

  // Slot-pane flicker + chandelier sway (cheap atmospherics).
  if (_group) {
    const t = state.time.real;
    _group.traverse(o => {
      if (o.userData && o.userData._slotPane) {
        o.material.opacity = 0.78 + 0.18 * (0.5 + 0.5 * Math.sin(t * 4.3 + o.position.x * 7));
      }
    });
  }

  // Find closest interactable
  const h = state.hero.pos;
  let best = null, bestD = Infinity;
  for (const it of _interactables) {
    const dx = h.x - it.pos.x;
    const dz = h.z - it.pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < it.radius * it.radius && d2 < bestD) { best = it; bestD = d2; }
  }
  _activeKey = best ? best.key : null;
  if (best) {
    setPromptLabel(_promptBinding, best.label);
    _promptEl.style.display = 'block';
  } else {
    _promptEl.style.display = 'none';
  }

  // Constrain hero to room interior with a small wall margin
  const margin = 0.6;
  const minX = -ROOM_W / 2 + margin;
  const maxX =  ROOM_W / 2 - margin;
  const minZ = -ROOM_D / 2 + margin;
  // Door gap on +z lets the player walk out — exit handled by the 'exit' interactable
  const maxZ = (Math.abs(h.x) < DOOR_W / 2 + 0.2)
    ? ROOM_D / 2 + 1.8
    : ROOM_D / 2 - margin;
  if (h.x < minX) h.x = minX;
  if (h.x > maxX) h.x = maxX;
  if (h.z < minZ) h.z = minZ;
  if (h.z > maxZ) h.z = maxZ;
}

export const CASINO_INTERIOR_ROOM = { W: ROOM_W, D: ROOM_D };
