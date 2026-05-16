// Build-time generator for assets/twilight_slowzone_hotspots.json.
//
// Twilight Phase-3 swarm: hedge-corridor slow-zones that funnel enemies into
// single-file lines through the topiary maze gaps. Mirrors the forest pattern
// (commit abf97aa), but where forest slow-zones key off amber hotspots, the
// twilight zones key off the hedge-corridor midpoints derived from the same
// mulberry32(0xBADBEE) tape the runtime + fountain regen tool replay.
//
// Why a standalone tool: same reason as regen-twilight-hotspots.mjs — the
// runtime can't fs.write the derived placements, so we persist them to disk
// for stageHazards.loadTwilightHazards() to fetch at stage load.
//
// Algorithm:
//   1. Fresh mulberry32(0xBADBEE), replay deriveHedges() (identical to the
//      fountain tool — must produce the SAME 4-6 hedges byte-for-byte so
//      zones align with runtime hedge geometry).
//   2. For each hedge, place 3 slow-zones along the tangent at offsets
//      { -halfL/2, 0, +halfL/2 }, each shifted ~1.2u toward origin so the
//      zones sit on the *inside curve* of the hedge — where enemies funnel
//      when approaching the play ring center.
//   3. Schema: { x, z, r: 2.0, mul: 0.65, seed: 3000+ }.
//
// Total: 3 zones × 4-6 hedges = 12-18 zones (matches the brief target).
//
// Run:  node tools/regen-twilight-slowzones.mjs

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '..', 'assets', 'twilight_slowzone_hotspots.json');

// Seed must match src/arenaDecor.js _buildTwilightDecor + regen-twilight-hotspots.mjs
const SEED = 0xBADBEE;

// Zone shape constants — mirrors forest's FOREST_SLOWZONE_* but values per brief.
const ZONE_RADIUS = 2.0;
const ZONE_MUL = 0.65;
const INSIDE_OFFSET = 1.2; // u radial inward toward origin

// mulberry32 — identical to the fountain regen tool + runtime arenaDecor.
function makeRng(seed) {
  let state = seed >>> 0;
  return function rand() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Replay hedge derivation — must match regen-twilight-hotspots.mjs byte-for-byte
// so the hedges we anchor zones to are the same ones the runtime renders.
function deriveHedges(rand) {
  const HEDGE_COUNT = 4 + ((rand() * 3) | 0); // 4..6
  const hedgeStep = (Math.PI * 2) / HEDGE_COUNT;
  const hedgeJitterMax = hedgeStep * 0.30;
  const hedges = [];
  for (let h = 0; h < HEDGE_COUNT; h++) {
    const angle = h * hedgeStep + (rand() - 0.5) * 2 * hedgeJitterMax;
    const radius = 22 + rand() * 26;
    const length = 3 + rand() * 3;
    const tanJit = (rand() - 0.5) * 0.7;
    const colorVariant = rand() < 0.5 ? 0 : 1; // drain to align tape (unused here)
    void colorVariant;
    const tangentAngle = angle + Math.PI / 2 + tanJit;
    const cx = Math.cos(angle) * radius;
    const cz = Math.sin(angle) * radius;
    const tx = Math.cos(tangentAngle);
    const tz = Math.sin(tangentAngle);
    hedges.push({ cx, cz, length, tx, tz, radius });
  }
  return hedges;
}

// For each hedge, place 3 zones along tangent at t ∈ {-halfL/2, 0, +halfL/2},
// each shifted INSIDE_OFFSET toward origin so swarms entering the corridor
// from outside the ring get funneled along the inside curve.
function buildZones(hedges) {
  const out = [];
  let seedCounter = 3000;
  for (const hg of hedges) {
    const halfL = hg.length / 2;
    const ts = [-halfL / 2, 0, +halfL / 2];
    // Inward unit vector — from hedge center toward origin.
    const inLen = Math.hypot(hg.cx, hg.cz) || 1;
    const inX = -hg.cx / inLen;
    const inZ = -hg.cz / inLen;
    for (const t of ts) {
      const x = hg.cx + hg.tx * t + inX * INSIDE_OFFSET;
      const z = hg.cz + hg.tz * t + inZ * INSIDE_OFFSET;
      out.push({
        x: +x.toFixed(2),
        z: +z.toFixed(2),
        r: ZONE_RADIUS,
        mul: ZONE_MUL,
        seed: seedCounter++,
      });
    }
  }
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────
const rand = makeRng(SEED);
const hedges = deriveHedges(rand);
console.log(`Derived ${hedges.length} hedges (seed 0x${SEED.toString(16).toUpperCase()}):`);
for (const hg of hedges) {
  console.log(
    `  cx=${hg.cx.toFixed(2)} cz=${hg.cz.toFixed(2)} len=${hg.length.toFixed(2)} `
    + `radial=${Math.hypot(hg.cx, hg.cz).toFixed(2)}u`
  );
}

const zones = buildZones(hedges);

// Sanity checks before write.
const allRadii = zones.every((z) => z.r === ZONE_RADIUS);
const allMuls = zones.every((z) => z.mul === ZONE_MUL);
const allInRange = zones.every((z) => {
  const r = Math.hypot(z.x, z.z);
  return r >= 10 && r <= 55;
});
if (!allRadii || !allMuls) {
  console.error('FAIL: radius/mul mismatch.');
  process.exit(1);
}
if (!allInRange) {
  console.warn('Warning: some zones land outside the typical play ring [10, 55].');
}
if (zones.length < 12 || zones.length > 18) {
  console.error(`FAIL: zone count ${zones.length} outside [12, 18].`);
  process.exit(1);
}

writeFileSync(OUT_PATH, JSON.stringify(zones, null, 2) + '\n');
console.log(`Wrote ${zones.length} slow-zones to ${OUT_PATH}`);
console.log(`radius ${ZONE_RADIUS}u, mul ${ZONE_MUL}x, inside-offset ${INSIDE_OFFSET}u`);
