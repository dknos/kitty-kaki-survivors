// Build-time generator for assets/void_teleport_hotspots.json.
//
// Pairs with the Phase-1A fix in src/arenaDecor.js (mulberry32(0xC0DE99)
// seeded void decor): we replay the same pillar positions + pad
// rejection-sampling here so the hotspots we write to disk land at the same
// stone-disc placeholders the runtime renders. The runtime ships pad
// placeholders at these positions, but the Phase-2 Void Pads Agent reads
// this JSON as the source of truth for spawning interactable pads.
//
// Why a standalone tool: the runtime stashes voidTeleportHotspots in
// group.userData but does NOT persist them to disk (no fs in browser ESM).
// Phase-2 voidPads.js will fetch the JSON at stage load, so the JSON is the
// source of truth. Regenerate whenever the void decor algorithm or seed
// changes.
//
// Split-stream RNG model (mirrors cinder pattern):
//   - rngPillar = mulberry32(0xC0DE99)            — pillar positions
//   - rngPad    = mulberry32(0xC0DE99 ^ 0x10000)  — pad rejection sampling
// Tile and star streams (0x20000, 0x30000) are NOT replayed here — the regen
// tool only cares about decisions that affect the hotspot file.
//
// Run:  node tools/regen-void-hotspots.mjs
//
// Contract (per docs/VOID_VISUAL_STYLE.md + brief):
//   - 4-6 pad hotspots inside ring [22, 48]
//   - min-distance 12u between any two hotspots (rejection sampling)
//   - min-distance 4u from any pillar center (don't overlap monoliths)
//   - scale 0.85..1.20, seeds start at 6000 (unique, monotonic)
//   - ~half the pads carry an explicit pairWith forming a non-chain cycle;
//     remaining pads omit pairWith so the Phase-2 Pads Agent falls back to
//     auto-nearest resolution
//   - 2-decimal x/z/scale, 2-space indent (matches existing JSON style)

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '..', 'assets', 'void_teleport_hotspots.json');

// ── Seeds must match src/arenaDecor.js _buildVoidDecor ───────────────────
const SEED = 0xC0DE99;
const SEED_PILLAR = SEED;
const SEED_PAD    = (SEED ^ 0x10000) >>> 0;

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

// ── Replay pillar derivation from arenaDecor._buildVoidDecor ─────────────
// Per-pillar RNG draw order (must match the runtime byte-for-byte):
//   COUNT: 1 draw   (4..6 via 4 + ((rand() * 3) | 0))
//   per pillar:
//     1) angle jitter   (rand() - 0.5) * 2 * jitterMax
//     2) radius         20 + rand() * 30   → 20..50
//     3) height         3 + rand() * 1     (consumed for tape parity)
//     4) yaw            rand() * 2π        (consumed for tape parity)
//     5) tilt X         (rand() - 0.5) * 0.18  (consumed for tape parity)
//     6) tilt Z         (rand() - 0.5) * 0.18  (consumed for tape parity)
//   The runtime also draws 3 extra randoms per pillar for the cone-cap
//   rotation, but those happen AFTER the pillar is appended to the position
//   list — they don't affect any subsequent stream we replay here (pad uses
//   its own stream). Skipping them keeps the regen tool focused on the
//   decisions that move pad-clearance points.
function derivePillars(rand) {
  const COUNT = 4 + ((rand() * 3) | 0); // 4..6
  const step = (Math.PI * 2) / COUNT;
  const jitterMax = step * 0.25;
  const pillars = [];
  for (let p = 0; p < COUNT; p++) {
    const angle = p * step + (rand() - 0.5) * 2 * jitterMax;
    const radius = 20 + rand() * 30;
    const height = 3 + rand() * 1;     // tape parity
    const yaw = rand() * Math.PI * 2;  // tape parity
    const tiltX = (rand() - 0.5) * 0.18; // tape parity
    const tiltZ = (rand() - 0.5) * 0.18; // tape parity
    pillars.push({
      x: Math.cos(angle) * radius,
      z: Math.sin(angle) * radius,
      height,
      yaw,
      tiltX,
      tiltZ,
    });
  }
  return pillars;
}

// ── Replay pad rejection sampler ─────────────────────────────────────────
// Per-pad RNG draw order (must match runtime):
//   COUNT: 1 draw   (4..6 via 4 + ((rand() * 3) | 0))
//   per ATTEMPT (accept OR reject):
//     a) angle  → 1 draw
//     b) radius → 1 draw  via 22 + rand() * 26   → 22..48
//     c) scale  → 1 draw  via 0.85 + rand() * 0.35
//   Rejected samples still consume all three draws — the runtime computes
//   scale before the reject check too (it's in the same expression block).
const MIN_PAD_DIST = 12;
const MIN_PAD_DIST_SQ = MIN_PAD_DIST * MIN_PAD_DIST;
const MIN_PILLAR_DIST = 4;
const MIN_PILLAR_DIST_SQ = MIN_PILLAR_DIST * MIN_PILLAR_DIST;
const RING_MIN = 22;
const RING_MAX = 48;
const GUARD = 500;

function derivePads(rand, pillars) {
  const TARGET = 4 + ((rand() * 3) | 0); // 4..6
  const out = [];
  let guard = 0;
  while (out.length < TARGET && guard++ < GUARD) {
    const a = rand() * Math.PI * 2;
    const r = 22 + rand() * 26;
    const scale = +(0.85 + rand() * 0.35).toFixed(2);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    let bad = false;
    for (const p of out) {
      const dx = x - p.x, dz = z - p.z;
      if (dx * dx + dz * dz < MIN_PAD_DIST_SQ) { bad = true; break; }
    }
    if (bad) continue;
    for (const pil of pillars) {
      const dx = x - pil.x, dz = z - pil.z;
      if (dx * dx + dz * dz < MIN_PILLAR_DIST_SQ) { bad = true; break; }
    }
    if (bad) continue;
    out.push({
      x: +x.toFixed(2),
      z: +z.toFixed(2),
      scale,
      seed: 6000 + out.length,
    });
  }
  return out;
}

// ── pairing pass ─────────────────────────────────────────────────────────
// Roughly half the pads get an explicit `pairWith`; the rest leave it unset
// so the Phase-2 Pads Agent falls back to auto-nearest. Pattern: pad N pairs
// with pad N+stride (mod count), where stride > 1 so the pairing graph
// isn't a simple A→B→A chain. With 4 pads: pad0→pad2, pad1→pad3 (so 0 pairs
// with 2, 1 with 3). With 5 pads: pad0→pad2, pad2→pad4 (asymmetric, every
// other). With 6 pads: pad0→pad2, pad2→pad4, pad4→pad0 (cycle of 3).
// Asymmetric by design — A.pairWith=B does NOT auto-set B.pairWith=A.
function applyPairing(pads) {
  const n = pads.length;
  if (n < 2) return; // nothing to pair
  // Pick the half indices: 0, 2, 4, ... up to roughly n/2 explicit pairs.
  // (n=4 → 0,2 = 2 pairs.  n=5 → 0,2 = 2 pairs.  n=6 → 0,2,4 = 3 pairs.)
  const half = Math.floor(n / 2);
  for (let k = 0; k < half; k++) {
    const i = k * 2;
    if (i >= n) break;
    const targetIdx = (i + 2) % n;
    if (targetIdx === i) continue; // skip self-pair (shouldn't happen at n>=2)
    pads[i].pairWith = pads[targetIdx].seed;
  }
}

// ── verify before write ──────────────────────────────────────────────────
function verify(hotspots, pillars) {
  let tightPadPairs = 0;
  let tightPillar = 0;
  let outOfRing = 0;
  let badPair = 0;
  const seedSet = new Set(hotspots.map(h => h.seed));
  for (let i = 0; i < hotspots.length; i++) {
    const h = hotspots[i];
    for (let j = i + 1; j < hotspots.length; j++) {
      const g = hotspots[j];
      const d = Math.hypot(h.x - g.x, h.z - g.z);
      if (d < MIN_PAD_DIST) {
        tightPadPairs++;
        console.warn(`  tight pad pair seed=${h.seed} <-> seed=${g.seed}: ${d.toFixed(2)}u`);
      }
    }
    for (const pil of pillars) {
      const d = Math.hypot(h.x - pil.x, h.z - pil.z);
      if (d < MIN_PILLAR_DIST) {
        tightPillar++;
        console.warn(`  pad seed=${h.seed} too close to pillar (${pil.x.toFixed(2)},${pil.z.toFixed(2)}): ${d.toFixed(2)}u`);
      }
    }
    const r = Math.hypot(h.x, h.z);
    if (r < RING_MIN || r > RING_MAX) {
      outOfRing++;
      console.warn(`  out-of-ring seed=${h.seed} r=${r.toFixed(2)}`);
    }
    if (h.pairWith != null) {
      if (!seedSet.has(h.pairWith)) {
        badPair++;
        console.warn(`  pad seed=${h.seed} pairWith=${h.pairWith} references unknown seed`);
      }
      if (h.pairWith === h.seed) {
        badPair++;
        console.warn(`  pad seed=${h.seed} pairWith itself`);
      }
    }
  }
  return tightPadPairs + tightPillar + outOfRing + badPair;
}

// ── main ─────────────────────────────────────────────────────────────────
const rngPillar = makeMulberry(SEED_PILLAR);
const rngPad    = makeMulberry(SEED_PAD);

const pillars = derivePillars(rngPillar);
console.log(`Derived ${pillars.length} pillars (seed 0x${SEED_PILLAR.toString(16).toUpperCase()}):`);
for (const p of pillars) {
  console.log(
    `  px=${p.x.toFixed(2)} pz=${p.z.toFixed(2)} h=${p.height.toFixed(2)} ` +
    `yaw=${p.yaw.toFixed(2)} tiltX=${p.tiltX.toFixed(2)} tiltZ=${p.tiltZ.toFixed(2)}`
  );
}

const hotspots = derivePads(rngPad, pillars);
applyPairing(hotspots);
console.log(`\nDerived ${hotspots.length} pad hotspots (seed 0x${SEED_PAD.toString(16).toUpperCase()}):`);
for (const h of hotspots) {
  console.log(
    `  x=${h.x.toFixed(2)} z=${h.z.toFixed(2)} scale=${h.scale} ` +
    `seed=${h.seed}${h.pairWith != null ? ` pairWith=${h.pairWith}` : ''}`
  );
}

const violations = verify(hotspots, pillars);
if (violations !== 0) {
  console.error(`\nFAIL: ${violations} constraint violation(s) detected — refusing to write.`);
  process.exit(1);
}
if (hotspots.length < 4 || hotspots.length > 6) {
  console.error(`\nFAIL: hotspot count ${hotspots.length} outside target band [4, 6] — refusing to write.`);
  process.exit(1);
}

writeFileSync(OUT_PATH, JSON.stringify(hotspots, null, 2) + '\n');
const pairCount = hotspots.filter(h => h.pairWith != null).length;
console.log(`\nWrote ${hotspots.length} hotspots to ${OUT_PATH}`);
console.log(`min-distance ${MIN_PAD_DIST}u between pads enforced; tight pairs: 0`);
console.log(`min-distance ${MIN_PILLAR_DIST}u from pillars enforced; close calls: 0`);
console.log(`ring [${RING_MIN}, ${RING_MAX}]u enforced; out-of-ring: 0`);
console.log(`explicit pairs: ${pairCount}; auto-nearest (no pairWith): ${hotspots.length - pairCount}`);
