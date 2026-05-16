// Build-time generator for assets/void_chasm_hotspots.json.
//
// Pairs with B3 (Void stage chasm hazards) in src/stageHazards.js. Generates
// 10-14 chasm damage zones scattered across the void arena. Mirrors the
// cinder slowzone pattern (rejection-sampled, deterministic) — but chasms
// damage the hero over time (5 dmg/s) when standing inside, no slow.
//
// Why deterministic + co-located stream:
//   Void decor uses mulberry32(0xC0DE99) with split streams (pillar 0x0,
//   pad 0x10000, tile 0x20000, star 0x30000). We add a NEW stream
//   (chasm 0x40000) so chasm placement is reproducible AND won't shift if
//   anyone re-orders an earlier stream. The visible tile-gap decals from
//   _buildVoidDecor still scatter independently — counts differ (5-8 gaps
//   vs 10-14 chasms) so 1:1 overlap is impossible, but both derive from the
//   same root seed so the maps feel co-authored.
//
// Run:  node tools/regen-void-chasm-hotspots.mjs
//
// Contract (per B3 backlog brief + docs/VOID_VISUAL_STYLE.md):
//   - 10-14 chasm hotspots inside ring [10, 48]
//   - min-distance 3.5u between any two chasms (rejection sampling)
//   - min-distance 6u from arena center (NO spawn-pad hazards)
//   - radius varies 1.2-2.0u per zone for visual variety
//   - seeds start at 8000 (unique, monotonic; pads use 6000, slowzones 5000)
//   - 2-decimal x/z/radius, 2-space indent (matches existing JSON style)

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '..', 'assets', 'void_chasm_hotspots.json');

// ── Seed: void root XOR 0x40000 (own stream, won't shift if other streams reorder)
const SEED_ROOT  = 0xC0DE99;
const SEED_CHASM = (SEED_ROOT ^ 0x40000) >>> 0;

// mulberry32 — same algorithm/state form as the runtime so it can be replayed
// in-engine if we ever decide to render the chasms procedurally instead of
// from JSON.
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

// ── Rejection sampler ────────────────────────────────────────────────────
const MIN_CHASM_DIST    = 3.5;
const MIN_CHASM_DIST_SQ = MIN_CHASM_DIST * MIN_CHASM_DIST;
const MIN_CENTER_DIST   = 6.0;
const MIN_CENTER_DIST_SQ = MIN_CENTER_DIST * MIN_CENTER_DIST;
const RING_MIN = 10;
const RING_MAX = 48;
const GUARD = 600;

// Per-attempt RNG draw order (accept OR reject — guard band stays stable):
//   a) angle   → 1 draw
//   b) radius  → 1 draw  via RING_MIN + rand() * (RING_MAX - RING_MIN)
//   c) zRadius → 1 draw  via 1.2 + rand() * 0.8   (chasm visual radius)
function deriveChasms(rand) {
  // 10..14 inclusive via 10 + ((rand() * 5) | 0)
  const TARGET = 10 + ((rand() * 5) | 0);
  const out = [];
  let guard = 0;
  while (out.length < TARGET && guard++ < GUARD) {
    const a = rand() * Math.PI * 2;
    const r = RING_MIN + rand() * (RING_MAX - RING_MIN);
    const zRadius = +(1.2 + rand() * 0.8).toFixed(2);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    // Reject if inside the center-clearance disc (no spawn-pad hazards).
    if (x * x + z * z < MIN_CENTER_DIST_SQ) continue;
    // Reject if too close to another chasm.
    let bad = false;
    for (const p of out) {
      const dx = x - p.x, dz = z - p.z;
      if (dx * dx + dz * dz < MIN_CHASM_DIST_SQ) { bad = true; break; }
    }
    if (bad) continue;
    out.push({
      id:     8000 + out.length,
      x:      +x.toFixed(2),
      z:      +z.toFixed(2),
      radius: zRadius,
    });
  }
  return out;
}

// ── verify before write ──────────────────────────────────────────────────
function verify(hotspots) {
  let tightPairs = 0;
  let nearCenter = 0;
  let outOfRing = 0;
  for (let i = 0; i < hotspots.length; i++) {
    const h = hotspots[i];
    for (let j = i + 1; j < hotspots.length; j++) {
      const g = hotspots[j];
      const d = Math.hypot(h.x - g.x, h.z - g.z);
      if (d < MIN_CHASM_DIST) {
        tightPairs++;
        console.warn(`  tight chasm pair id=${h.id} <-> id=${g.id}: ${d.toFixed(2)}u`);
      }
    }
    const rc = Math.hypot(h.x, h.z);
    if (rc < MIN_CENTER_DIST) {
      nearCenter++;
      console.warn(`  chasm id=${h.id} too close to center: r=${rc.toFixed(2)}u`);
    }
    if (rc < RING_MIN - 0.01 || rc > RING_MAX + 0.01) {
      outOfRing++;
      console.warn(`  out-of-ring id=${h.id} r=${rc.toFixed(2)}`);
    }
    if (typeof h.radius !== 'number' || h.radius < 1.2 || h.radius > 2.0) {
      console.warn(`  chasm id=${h.id} radius=${h.radius} outside [1.2, 2.0]`);
    }
  }
  return tightPairs + nearCenter + outOfRing;
}

// ── main ─────────────────────────────────────────────────────────────────
const rngChasm = makeMulberry(SEED_CHASM);
const hotspots = deriveChasms(rngChasm);

console.log(`Derived ${hotspots.length} chasm hotspots (seed 0x${SEED_CHASM.toString(16).toUpperCase()}):`);
for (const h of hotspots) {
  const r = Math.hypot(h.x, h.z);
  console.log(`  id=${h.id} x=${h.x.toFixed(2)} z=${h.z.toFixed(2)} radius=${h.radius} (r=${r.toFixed(2)}u)`);
}

const violations = verify(hotspots);
if (violations !== 0) {
  console.error(`\nFAIL: ${violations} constraint violation(s) detected — refusing to write.`);
  process.exit(1);
}
if (hotspots.length < 10 || hotspots.length > 14) {
  console.error(`\nFAIL: hotspot count ${hotspots.length} outside target band [10, 14] — refusing to write.`);
  process.exit(1);
}

writeFileSync(OUT_PATH, JSON.stringify(hotspots, null, 2) + '\n');
console.log(`\nWrote ${hotspots.length} hotspots to ${OUT_PATH}`);
console.log(`min-distance ${MIN_CHASM_DIST}u between chasms enforced; tight pairs: 0`);
console.log(`min-distance ${MIN_CENTER_DIST}u from arena center enforced; near-center: 0`);
console.log(`ring [${RING_MIN}, ${RING_MAX}]u enforced; out-of-ring: 0`);
