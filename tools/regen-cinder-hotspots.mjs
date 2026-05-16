// Build-time generator for assets/cinder_ballista_hotspots.json.
//
// Pairs with the Phase-1A fix in src/arenaDecor.js (mulberry32(0xDADADA)
// seeded cinder decor): we replay the same catapult positions + ballista
// rejection-sampling here so the hotspots we write to disk land at the same
// stone-base placeholders the runtime renders. The runtime ships ballista
// placeholders at these positions, but the Phase-2 Cinder Ballistas Agent
// reads this JSON as the source of truth for spawning interactable turrets.
//
// Why a standalone tool: the runtime stashes cinderBallistaHotspots in
// group.userData but does NOT persist them to disk (no fs in browser ESM).
// Phase-2 cinderBallistas.js will fetch the JSON at stage load, so the JSON
// is the source of truth. Regenerate whenever the cinder decor algorithm or
// seed changes.
//
// Split-stream RNG model (cleaner than twilight's single-tape pattern):
//   - rngCatapult  = mulberry32(0xDADADA)            — catapult positions
//   - rngBallista  = mulberry32(0xDADADA ^ 0x10000)  — ballista rejection
// Crater and ember streams (0x20000, 0x30000) are NOT replayed here — the
// regen tool only cares about decisions that affect the hotspot file.
//
// Run:  node tools/regen-cinder-hotspots.mjs
//
// Contract (per docs/CINDER_VISUAL_STYLE.md + brief):
//   - 4-6 ballista hotspots inside ring [20, 50]
//   - min-distance 8u between any two hotspots (rejection sampling)
//   - min-distance 6u from any catapult center (don't overlap obstacles)
//   - facing = atan2(-z, -x) so each ballista initially faces play center
//   - scale 0.90..1.10, seeds start at 4000 (unique, monotonic)
//   - 2-decimal x/z/scale, 2-space indent (matches existing JSON style)

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '..', 'assets', 'cinder_ballista_hotspots.json');

// ── Seeds must match src/arenaDecor.js _buildCinderDecor ─────────────────
const SEED = 0xDADADA;
const SEED_CATAPULT = SEED;
const SEED_BALLISTA = (SEED ^ 0x10000) >>> 0;

// mulberry32 — same algorithm + initial state as the runtime, so the first
// N rand() calls produce the same sequence on both sides.
function makeMulberry(seed) {
  let state = seed >>> 0;
  return function rand() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Replay catapult derivation from arenaDecor._buildCinderDecor ─────────
// Per-catapult RNG draw order (must match the runtime byte-for-byte):
//   COUNT: 1 draw   (3..4 via 3 + ((rand() * 2) | 0))
//   per catapult:
//     1) angle jitter   (rand() - 0.5) * 2 * jitterMax
//     2) radius         22 + rand() * 23    → 22..45
//     3) facing yaw     rand() * 2π         (consumed for parity even though
//                                            the hotspot file doesn't care)
//     4) arm tilt       0.52 + rand() * 0.35
//     5) arm spin       rand() * 2π
function deriveCatapults(rand) {
  const COUNT = 3 + ((rand() * 2) | 0); // 3..4
  const step = (Math.PI * 2) / COUNT;
  const jitterMax = step * 0.25;
  const catapults = [];
  for (let c = 0; c < COUNT; c++) {
    const angle = c * step + (rand() - 0.5) * 2 * jitterMax;
    const radius = 22 + rand() * 23;
    const yaw = rand() * Math.PI * 2;     // consumed for tape parity
    const armTilt = 0.52 + rand() * 0.35; // consumed for tape parity
    const armSpin = rand() * Math.PI * 2; // consumed for tape parity
    catapults.push({
      x: Math.cos(angle) * radius,
      z: Math.sin(angle) * radius,
      yaw,
      armTilt,
      armSpin,
    });
  }
  return catapults;
}

// ── Replay ballista rejection sampler ────────────────────────────────────
// Per-ballista RNG draw order (must match runtime):
//   COUNT_TARGET: 1 draw   (4..6 via 4 + ((rand() * 3) | 0))
//   per ATTEMPT (accept OR reject):
//     a) angle   → 1 draw
//     b) radius  → 1 draw  via 20 + rand() * 30
//     c) scale   → 1 draw  via 0.9 + rand() * 0.20
//   Rejected samples still consume all three draws — the runtime computes
//   scale before the reject check too (it's in the same expression block).
const MIN_BALLISTA_DIST = 8;
const MIN_BALLISTA_DIST_SQ = MIN_BALLISTA_DIST * MIN_BALLISTA_DIST;
const MIN_CATAPULT_DIST = 6;
const MIN_CATAPULT_DIST_SQ = MIN_CATAPULT_DIST * MIN_CATAPULT_DIST;
const RING_MIN = 20;
const RING_MAX = 50;
const GUARD = 400;

function deriveBallistas(rand, catapults) {
  const TARGET = 4 + ((rand() * 3) | 0); // 4..6
  const out = [];
  let guard = 0;
  while (out.length < TARGET && guard++ < GUARD) {
    const a = rand() * Math.PI * 2;
    const r = 20 + rand() * 30;
    const scale = +(0.9 + rand() * 0.20).toFixed(2);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    // Reject if too close to another ballista.
    let bad = false;
    for (const p of out) {
      const dx = x - p.x, dz = z - p.z;
      if (dx * dx + dz * dz < MIN_BALLISTA_DIST_SQ) { bad = true; break; }
    }
    if (bad) continue;
    // Reject if too close to any catapult center.
    for (const cat of catapults) {
      const dx = x - cat.x, dz = z - cat.z;
      if (dx * dx + dz * dz < MIN_CATAPULT_DIST_SQ) { bad = true; break; }
    }
    if (bad) continue;
    out.push({
      x: +x.toFixed(2),
      z: +z.toFixed(2),
      scale,
      seed: 4000 + out.length,
      facing: +Math.atan2(-z, -x).toFixed(4), // toward play center
    });
  }
  return out;
}

// ── verify before write ──────────────────────────────────────────────────
function verify(hotspots, catapults) {
  let tightBallistaPairs = 0;
  let tightCatapult = 0;
  let outOfRing = 0;
  let badFacing = 0;
  for (let i = 0; i < hotspots.length; i++) {
    const h = hotspots[i];
    for (let j = i + 1; j < hotspots.length; j++) {
      const g = hotspots[j];
      const d = Math.hypot(h.x - g.x, h.z - g.z);
      if (d < MIN_BALLISTA_DIST) {
        tightBallistaPairs++;
        console.warn(`  tight ballista pair seed=${h.seed} <-> seed=${g.seed}: ${d.toFixed(2)}u`);
      }
    }
    for (const cat of catapults) {
      const d = Math.hypot(h.x - cat.x, h.z - cat.z);
      if (d < MIN_CATAPULT_DIST) {
        tightCatapult++;
        console.warn(`  ballista seed=${h.seed} too close to catapult (${cat.x.toFixed(2)},${cat.z.toFixed(2)}): ${d.toFixed(2)}u`);
      }
    }
    const r = Math.hypot(h.x, h.z);
    if (r < RING_MIN || r > RING_MAX) {
      outOfRing++;
      console.warn(`  out-of-ring seed=${h.seed} r=${r.toFixed(2)}`);
    }
    if (typeof h.facing !== 'number' || !Number.isFinite(h.facing)) {
      badFacing++;
      console.warn(`  bad facing seed=${h.seed}: ${h.facing}`);
    }
  }
  return tightBallistaPairs + tightCatapult + outOfRing + badFacing;
}

// ── main ─────────────────────────────────────────────────────────────────
const rngCatapult = makeMulberry(SEED_CATAPULT);
const rngBallista = makeMulberry(SEED_BALLISTA);

const catapults = deriveCatapults(rngCatapult);
console.log(`Derived ${catapults.length} catapults (seed 0x${SEED_CATAPULT.toString(16).toUpperCase()}):`);
for (const c of catapults) {
  console.log(
    `  cx=${c.x.toFixed(2)} cz=${c.z.toFixed(2)} yaw=${c.yaw.toFixed(2)} ` +
    `armTilt=${c.armTilt.toFixed(2)} armSpin=${c.armSpin.toFixed(2)}`
  );
}

const hotspots = deriveBallistas(rngBallista, catapults);
console.log(`\nDerived ${hotspots.length} ballista hotspots (seed 0x${SEED_BALLISTA.toString(16).toUpperCase()}):`);
for (const h of hotspots) {
  console.log(
    `  x=${h.x.toFixed(2)} z=${h.z.toFixed(2)} scale=${h.scale} ` +
    `facing=${h.facing.toFixed(2)} seed=${h.seed}`
  );
}

const violations = verify(hotspots, catapults);
if (violations !== 0) {
  console.error(`\nFAIL: ${violations} constraint violation(s) detected — refusing to write.`);
  process.exit(1);
}
if (hotspots.length < 4 || hotspots.length > 6) {
  console.error(`\nFAIL: hotspot count ${hotspots.length} outside target band [4, 6] — refusing to write.`);
  process.exit(1);
}

writeFileSync(OUT_PATH, JSON.stringify(hotspots, null, 2) + '\n');
console.log(`\nWrote ${hotspots.length} hotspots to ${OUT_PATH}`);
console.log(`min-distance ${MIN_BALLISTA_DIST}u between ballistas enforced; tight pairs: 0`);
console.log(`min-distance ${MIN_CATAPULT_DIST}u from catapults enforced; close calls: 0`);
console.log(`ring [${RING_MIN}, ${RING_MAX}]u enforced; out-of-ring: 0`);
console.log(`facings: all finite, atan2(-z,-x) toward play center`);
