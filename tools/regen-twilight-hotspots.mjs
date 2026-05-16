// Build-time generator for assets/twilight_fountain_hotspots.json.
//
// Pairs with the Phase-1A fix in src/arenaDecor.js (mulberry32(0xBADBEE)
// seeded twilight decor): we replay the same hedge derivation here so the
// fountain hotspots we write to disk land at the same dead-ends the runtime
// hedges form. The runtime renders fountain placeholders at these positions
// but the Phase-2 Fountains agent reads this JSON as the source of truth
// for spawning interactable entities (so reload-stable positions matter).
//
// Why a standalone tool: the runtime stashes fountainHotspots in
// group.userData but does NOT persist them to disk (no fs in browser ESM).
// Phase-2 twilightFountains.js fetches the JSON at stage load, so the JSON
// is the source of truth. Regenerate whenever the twilight decor algorithm
// or seed changes.
//
// Run:  node tools/regen-twilight-hotspots.mjs
//
// Contract (per docs/TWILIGHT_VISUAL_STYLE.md + brief):
//   - 6–8 fountain hotspots inside ring [18, 50]
//   - min-distance 6u between any two hotspots (rejection sampling)
//   - placed at hedge-corridor dead-ends (replays runtime hedge derivation)
//   - variant: 'blood' | 'light', alternated for 50/50 split
//   - scale 0.90..1.15, seeds start at 2000 (unique, monotonic)
//   - 2-decimal x/z/scale, 2-space indent (matches existing JSON style)

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '..', 'assets', 'twilight_fountain_hotspots.json');

// ── Seed must match src/arenaDecor.js _buildTwilightDecor ────────────────
const SEED = 0xBADBEE;

// mulberry32 — same algorithm + initial state as the runtime, so the first
// N rand() calls produce the same sequence both sides.
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

// ── Replay hedge derivation from arenaDecor._buildTwilightDecor ──────────
// Per-hedge RNG draw order (must match the runtime byte-for-byte):
//   HEDGE_COUNT: 1 draw  (4..6 via 4 + ((rand() * 3) | 0))
//   per hedge:
//     1) angle jitter   (rand() - 0.5) * 2 * jitterMax
//     2) radius         22 + rand() * 26      → 22..48
//     3) length         3 + rand() * 3         → 3..6
//     4) tanJit         (rand() - 0.5) * 0.7  → ±0.35 rad
//     5) colorVariant   rand() < 0.5 ? 0 : 1
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
    const colorVariant = rand() < 0.5 ? 0 : 1;
    const tangentAngle = angle + Math.PI / 2 + tanJit;
    const cx = Math.cos(angle) * radius;
    const cz = Math.sin(angle) * radius;
    const tx = Math.cos(tangentAngle);
    const tz = Math.sin(tangentAngle);
    const halfL = length / 2;
    hedges.push({
      cx, cz, angle, length, tangentAngle, tx, tz, colorVariant,
      end1: { x: cx + tx * (halfL + 1.6), z: cz + tz * (halfL + 1.6) },
      end2: { x: cx - tx * (halfL + 1.6), z: cz - tz * (halfL + 1.6) },
    });
  }
  return hedges;
}

// ── min-distance rejection sampler ───────────────────────────────────────
const MIN_DIST = 6;
const MIN_DIST_SQ = MIN_DIST * MIN_DIST;
const RING_MIN = 18;
const RING_MAX = 50;
const TARGET_MIN = 6;
const TARGET_MAX = 8;

function farEnough(x, z, accepted) {
  for (const p of accepted) {
    const dx = x - p.x, dz = z - p.z;
    if (dx * dx + dz * dz < MIN_DIST_SQ) return false;
  }
  return true;
}
function inFountainRing(x, z) {
  const r = Math.hypot(x, z);
  return r >= RING_MIN && r <= RING_MAX;
}

// Replay arenaDecor scatter pass to fill fountainSpots from hedge endpoints,
// then top up via ring scatter. RNG draw order MUST match the runtime so
// disk hotspots == runtime userData.fountainHotspots.
function scatter(rand, hedges) {
  // First fountain count cap: same expression as the runtime.
  const FOUNTAIN_COUNT = Math.min(8, Math.max(6, 6 + ((rand() * 3) | 0))); // 6..8
  const out = [];

  // Pass 1: hedge endpoints in declaration order.
  for (const hg of hedges) {
    for (const end of [hg.end1, hg.end2]) {
      if (out.length >= FOUNTAIN_COUNT) break;
      if (!inFountainRing(end.x, end.z)) continue;
      if (!farEnough(end.x, end.z, out)) continue;
      const variant = out.length % 2 === 0 ? 'blood' : 'light';
      const scale = +(0.9 + rand() * 0.25).toFixed(2); // 0.9..1.15
      out.push({
        x: +end.x.toFixed(2),
        z: +end.z.toFixed(2),
        variant, scale,
        seed: 2000 + out.length,
      });
    }
    if (out.length >= FOUNTAIN_COUNT) break;
  }

  // Pass 2: top up if min-dist rejected too many endpoints.
  let topUp = 0;
  while (out.length < TARGET_MIN && topUp++ < 300) {
    // Mirror runtime scatterRing(20, 48, 1.3) — TWO rand() calls per sample
    // in the SAME ORDER (angle first, then radius), so the disk + runtime
    // tape stay byte-aligned. scatterRing returns {a (angle), x, z}: angle
    // is the first draw, then radius via Math.pow(rand(), 1/biasPow).
    const a = rand() * Math.PI * 2;
    const u = Math.pow(rand(), 1 / 1.3);
    const r = 20 + (48 - 20) * u;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (!inFountainRing(x, z)) continue;
    if (!farEnough(x, z, out)) continue;
    const variant = out.length % 2 === 0 ? 'blood' : 'light';
    out.push({
      x: +x.toFixed(2),
      z: +z.toFixed(2),
      variant,
      scale: +(0.9 + rand() * 0.25).toFixed(2),
      seed: 2000 + out.length,
    });
  }

  // Hard cap.
  if (out.length > TARGET_MAX) out.length = TARGET_MAX;
  return out;
}

// ── verify before write ──────────────────────────────────────────────────
function verify(hotspots) {
  let tightPairs = 0;
  for (let i = 0; i < hotspots.length; i++) {
    for (let j = i + 1; j < hotspots.length; j++) {
      const d = Math.hypot(hotspots[i].x - hotspots[j].x, hotspots[i].z - hotspots[j].z);
      if (d < MIN_DIST) {
        tightPairs++;
        console.warn(`  tight pair seed=${hotspots[i].seed} <-> seed=${hotspots[j].seed}: ${d.toFixed(2)}u`);
      }
    }
    const r = Math.hypot(hotspots[i].x, hotspots[i].z);
    if (r < RING_MIN || r > RING_MAX) {
      console.warn(`  out-of-ring seed=${hotspots[i].seed} r=${r.toFixed(2)}`);
    }
  }
  return tightPairs;
}

// ── main ─────────────────────────────────────────────────────────────────
const rand = makeRng(SEED);
const hedges = deriveHedges(rand);
console.log(`Derived ${hedges.length} hedges (seed 0x${SEED.toString(16).toUpperCase()}):`);
for (const hg of hedges) {
  console.log(
    `  cx=${hg.cx.toFixed(2)} cz=${hg.cz.toFixed(2)} len=${hg.length.toFixed(2)} `
    + `end1=(${hg.end1.x.toFixed(2)},${hg.end1.z.toFixed(2)}) `
    + `end2=(${hg.end2.x.toFixed(2)},${hg.end2.z.toFixed(2)})`
  );
}

const hotspots = scatter(rand, hedges);
const tight = verify(hotspots);

if (tight !== 0) {
  console.error(`FAIL: ${tight} tight pair(s) detected — refusing to write.`);
  process.exit(1);
}

// Variant split summary.
const blood = hotspots.filter(h => h.variant === 'blood').length;
const light = hotspots.filter(h => h.variant === 'light').length;

writeFileSync(OUT_PATH, JSON.stringify(hotspots, null, 2) + '\n');
console.log(`Wrote ${hotspots.length} hotspots to ${OUT_PATH}`);
console.log(`min-distance ${MIN_DIST}u enforced; tight pairs: 0`);
console.log(`variant split: blood=${blood}, light=${light}`);
