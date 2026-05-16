// Build-time generator for assets/cinder_slowzone_hotspots.json.
//
// Cinder Phase-3 swarm: catapult slow-zones that funnel enemies AROUND the
// ruined siege engines. Mirrors the twilight pattern (commit pairs with
// regen-twilight-slowzones.mjs), but where twilight zones key off hedge
// midpoints, cinder zones key off the catapult positions derived from the
// same mulberry32(0xDADADA) tape the runtime + ballista regen tool replay.
//
// Why a standalone tool: same reason as regen-cinder-hotspots.mjs — the
// runtime can't fs.write derived placements, so we persist them to disk for
// stageHazards.loadCinderHazards() to fetch at stage load. Catapult positions
// live ONLY in the runtime decor builder (no JSON), so this tool replays the
// catapult-stream RNG byte-for-byte and emits one zone per catapult.
//
// Algorithm:
//   1. Fresh mulberry32(0xDADADA) on the SAME split-stream offset the
//      runtime + regen-cinder-hotspots.mjs use for catapults (no XOR; the
//      base seed IS the catapult stream — see regen-cinder-hotspots.mjs
//      line 41: SEED_CATAPULT = SEED).
//   2. Replay deriveCatapults() byte-for-byte: COUNT draw (3..4), then per
//      catapult: angle jitter, radius, yaw, armTilt, armSpin (5 draws each).
//   3. For each catapult, emit one slow-zone at the catapult position.
//   4. Schema: { x, z, r: 2.0, mul: 0.7, seed: 5000+ }.
//
// Total: 3-4 zones (one per catapult). Catapults are placed ≥12u apart by
// the decor builder's angular step, so zone-pair distance ≥ 12u naturally.
//
// Run:  node tools/regen-cinder-slowzones.mjs

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '..', 'assets', 'cinder_slowzone_hotspots.json');

// Seed must match src/arenaDecor.js _buildCinderDecor + regen-cinder-hotspots.mjs.
// SEED_CATAPULT is the BASE seed (no XOR) — confirmed by regen-cinder-hotspots.mjs
// SEED_CATAPULT = SEED line.
const SEED = 0xDADADA;
const SEED_CATAPULT = SEED;

// Zone shape constants — per docs/CINDER_VISUAL_STYLE.md catapult slow-zone spec:
// "0.7x enemy speed within 2u of each catapult center".
const ZONE_RADIUS = 2.0;
const ZONE_MUL = 0.7;
const ZONE_SEED_BASE = 5000;

// mulberry32 — identical to the ballista regen tool + runtime arenaDecor.
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

// Replay catapult derivation from arenaDecor._buildCinderDecor — must match
// regen-cinder-hotspots.mjs deriveCatapults() byte-for-byte.
// Per-catapult RNG draw order:
//   COUNT: 1 draw   (3..4 via 3 + ((rand() * 2) | 0))
//   per catapult:
//     1) angle jitter   (rand() - 0.5) * 2 * jitterMax
//     2) radius         22 + rand() * 23
//     3) facing yaw     rand() * 2π    (consumed for tape parity)
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
    void yaw; void armTilt; void armSpin;
    catapults.push({
      x: Math.cos(angle) * radius,
      z: Math.sin(angle) * radius,
    });
  }
  return catapults;
}

function buildZones(catapults) {
  const out = [];
  let seedCounter = ZONE_SEED_BASE;
  for (const c of catapults) {
    out.push({
      x: +c.x.toFixed(2),
      z: +c.z.toFixed(2),
      r: ZONE_RADIUS,
      mul: ZONE_MUL,
      seed: seedCounter++,
    });
  }
  return out;
}

// ── verify before write ──────────────────────────────────────────────────
function verify(zones) {
  let tightPairs = 0;
  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      const d = Math.hypot(zones[i].x - zones[j].x, zones[i].z - zones[j].z);
      if (d < 8) {
        tightPairs++;
        console.warn(
          `  tight pair seed=${zones[i].seed} <-> seed=${zones[j].seed}: ${d.toFixed(2)}u`
        );
      }
    }
  }
  return tightPairs;
}

// ── main ─────────────────────────────────────────────────────────────────
const rngCatapult = makeMulberry(SEED_CATAPULT);
const catapults = deriveCatapults(rngCatapult);
console.log(`Derived ${catapults.length} catapults (seed 0x${SEED_CATAPULT.toString(16).toUpperCase()}):`);
for (const c of catapults) {
  console.log(`  cx=${c.x.toFixed(2)} cz=${c.z.toFixed(2)} radial=${Math.hypot(c.x, c.z).toFixed(2)}u`);
}

const zones = buildZones(catapults);

// Sanity checks before write.
const allRadii = zones.every((z) => z.r === ZONE_RADIUS);
const allMuls = zones.every((z) => z.mul === ZONE_MUL);
if (!allRadii || !allMuls) {
  console.error('FAIL: radius/mul mismatch.');
  process.exit(1);
}
if (zones.length < 3 || zones.length > 4) {
  console.error(`FAIL: zone count ${zones.length} outside [3, 4].`);
  process.exit(1);
}
const tightPairs = verify(zones);
if (tightPairs !== 0) {
  console.error(`FAIL: ${tightPairs} tight pair(s) — catapults should be ≥12u apart per decor brief.`);
  process.exit(1);
}

writeFileSync(OUT_PATH, JSON.stringify(zones, null, 2) + '\n');
console.log(`\nWrote ${zones.length} slow-zones to ${OUT_PATH}`);
console.log(`radius ${ZONE_RADIUS}u, mul ${ZONE_MUL}x, one zone per catapult`);
console.log(`pair-distance ≥ 8u enforced; tight pairs: 0`);
