// Build-time generator for assets/forest_amber_hotspots.json.
//
// Pairs with the A1 fix in src/arenaDecor.js (mulberry32(0xC0FFEE) seeded
// forest decor): we replay the same cluster derivation here so the hotspots
// we write to disk land on the funnel-facing perimeters of the same
// crystal clusters the runtime will build.
//
// Why a standalone tool: the runtime writes amberHotspots into
// group.userData but does NOT persist them to disk (no fs in browser ESM).
// forestAmber.js and stageHazards.js both fetch the JSON, so the JSON is
// the source of truth for entity positions. Regenerate this file whenever
// the forest decor algorithm or seed changes.
//
// Run:  node tools/regen-forest-hotspots.mjs
//
// Contract:
//   - 18–22 hotspots inside ring [15, 55]
//   - min-distance 2.5u between any two hotspots (rejection sampling)
//   - biased toward cluster perimeters / funnel directions
//   - scale 0.85..1.20, seeds start at 1000 (unique, monotonic)
//   - 2-decimal x/z/scale, 2-space indent (matches existing JSON style)

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '..', 'assets', 'forest_amber_hotspots.json');

// ── Seed must match src/arenaDecor.js _buildForestDecor ──────────────────
const SEED = 0xC0FFEE;

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

// ── Replay cluster derivation from arenaDecor._buildForestDecor ──────────
// Per-cluster RNG draw order (must match the runtime byte-for-byte to keep
// cluster centers aligned):
//   CLUSTER_COUNT: 1 draw
//   per cluster:
//     1) angle jitter   (rand - 0.5) * 2 * jitterMax
//     2) radius         22 + rand * 24
//     3) funnelDir      rand * 2π
//     4) crystalCount   6 + (rand * 5)|0
function deriveClusters(rand) {
  const CLUSTER_COUNT = 4 + (rand() < 0.5 ? 0 : 1); // 4 or 5
  const baseStep = (Math.PI * 2) / CLUSTER_COUNT;
  const jitterMax = baseStep * 0.25;
  const clusters = [];
  for (let c = 0; c < CLUSTER_COUNT; c++) {
    const angle = c * baseStep + (rand() - 0.5) * 2 * jitterMax;
    const radius = 22 + rand() * 24;
    const funnelDir = rand() * Math.PI * 2;
    const crystalCount = 6 + ((rand() * 5) | 0);
    clusters.push({
      cx: Math.cos(angle) * radius,
      cz: Math.sin(angle) * radius,
      angle,
      funnelDir,
      funnelHalfWidth: Math.PI / 6,
      crystalCount,
    });
  }
  return clusters;
}

// ── min-distance rejection sampler ───────────────────────────────────────
const MIN_DIST   = 2.5;     // brief A2 constraint
const MIN_DIST_SQ = MIN_DIST * MIN_DIST;
const RING_MIN   = 15;
const RING_MAX   = 55;
const TARGET_MIN = 18;
const TARGET_MAX = 22;
const MAX_TRIES_PER_SLOT = 300;

function farEnough(x, z, accepted) {
  for (const p of accepted) {
    const dx = x - p.x;
    const dz = z - p.z;
    if (dx * dx + dz * dz < MIN_DIST_SQ) return false;
  }
  return true;
}

// Sample a candidate near the funnel-facing perimeter of a cluster. Widens
// the wedge after a few rejections so dense clumps don't starve.
function sampleNearCluster(rand, cl, attemptN) {
  // Wedge: start at funnelHalfWidth*1.4 (matches runtime intent), grow
  // toward full 2π by attempt ~120 so we always converge.
  const widenFrac = Math.min(1, attemptN / 120);
  const wedge = cl.funnelHalfWidth * 1.4 + (Math.PI - cl.funnelHalfWidth * 1.4) * widenFrac;
  const theta = cl.funnelDir + (rand() * 2 - 1) * wedge;
  // Ring of cluster perimeter. Widen radius band as we struggle.
  const rMin = 3.2;
  const rMax = 4.6 + widenFrac * 2.5;
  const r = rMin + rand() * (rMax - rMin);
  return { x: cl.cx + Math.cos(theta) * r, z: cl.cz + Math.sin(theta) * r };
}

function inSafeRing(x, z) {
  const radial = Math.hypot(x, z);
  return radial >= RING_MIN && radial <= RING_MAX;
}

function scatter(rand, clusters, count) {
  const out = [];
  let seedCounter = 1000;
  // Round-robin clusters so we don't dump all hotspots on cluster 0.
  // 2 passes through clusters to seed (matches Hades-hallway "1-2 per clump"),
  // then top-up with random clusters until target met.
  const initialPlan = [];
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < clusters.length; i++) initialPlan.push(i);
  }
  // Trim if we'd exceed TARGET_MAX during the planned passes.
  while (initialPlan.length > TARGET_MAX) initialPlan.pop();

  for (const ci of initialPlan) {
    const cl = clusters[ci];
    let placed = false;
    for (let attempt = 0; attempt < MAX_TRIES_PER_SLOT; attempt++) {
      const { x, z } = sampleNearCluster(rand, cl, attempt);
      if (!inSafeRing(x, z)) continue;
      if (!farEnough(x, z, out)) continue;
      out.push({
        x: +x.toFixed(2),
        z: +z.toFixed(2),
        scale: +(0.85 + rand() * 0.35).toFixed(2),
        seed: seedCounter++,
      });
      placed = true;
      break;
    }
    if (!placed) {
      // Couldn't place after MAX_TRIES_PER_SLOT — skip this slot quietly.
      // We'll backfill from the top-up loop if we end short of TARGET_MIN.
    }
    if (out.length >= TARGET_MAX) break;
  }

  // Top up to at least TARGET_MIN using random clusters + full perimeter.
  let topUpGuard = 0;
  while (out.length < TARGET_MIN && topUpGuard++ < 2000) {
    const cl = clusters[(rand() * clusters.length) | 0];
    const { x, z } = sampleNearCluster(rand, cl, 200); // wide wedge
    if (!inSafeRing(x, z)) continue;
    if (!farEnough(x, z, out)) continue;
    out.push({
      x: +x.toFixed(2),
      z: +z.toFixed(2),
      scale: +(0.85 + rand() * 0.35).toFixed(2),
      seed: seedCounter++,
    });
  }

  // Final hard cap.
  if (out.length > TARGET_MAX) out.length = TARGET_MAX;
  return out;
}

// ── verify min-distance contract before write ────────────────────────────
function verify(hotspots) {
  let tightPairs = 0;
  for (let i = 0; i < hotspots.length; i++) {
    for (let j = i + 1; j < hotspots.length; j++) {
      const d = Math.hypot(hotspots[i].x - hotspots[j].x, hotspots[i].z - hotspots[j].z);
      if (d < MIN_DIST) {
        tightPairs++;
        console.warn(`  tight pair ${hotspots[i].seed} ↔ ${hotspots[j].seed}: ${d.toFixed(2)}u`);
      }
      const r1 = Math.hypot(hotspots[i].x, hotspots[i].z);
      if (r1 < RING_MIN || r1 > RING_MAX) {
        console.warn(`  out-of-ring seed=${hotspots[i].seed} r=${r1.toFixed(2)}`);
      }
    }
  }
  return tightPairs;
}

// ── main ─────────────────────────────────────────────────────────────────
const rand = makeRng(SEED);
const clusters = deriveClusters(rand);
console.log(`Derived ${clusters.length} clusters (seed 0x${SEED.toString(16).toUpperCase()}):`);
for (const cl of clusters) {
  console.log(`  cx=${cl.cx.toFixed(2)} cz=${cl.cz.toFixed(2)} funnelDir=${cl.funnelDir.toFixed(2)} crystals=${cl.crystalCount}`);
}

const hotspots = scatter(rand, clusters, TARGET_MAX);
const tight = verify(hotspots);

if (tight !== 0) {
  console.error(`FAIL: ${tight} tight pair(s) detected — refusing to write.`);
  process.exit(1);
}

writeFileSync(OUT_PATH, JSON.stringify(hotspots, null, 2) + '\n');
console.log(`Wrote ${hotspots.length} hotspots to ${OUT_PATH}`);
console.log(`min-distance 2.5u enforced; tight pairs: 0`);
