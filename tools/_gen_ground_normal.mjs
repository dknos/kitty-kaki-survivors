#!/usr/bin/env node
/**
 * _gen_ground_normal.mjs — FOREST-V2-A35 / PHASE 3 P3E
 *
 * Deterministic procedural generator for the forest ground plane detail
 * normal map. Replaces the 1.4 MB Poly Haven `nor_gl.jpg` packed under
 * `assets/sprites/forrest_ground_01/` with a palette-neutral, repo-tracked,
 * <150 KB tangent-space normal map that mirrors the procedural pattern
 * established in cohorts 32 / 33 / 34 (PRs #136 / #137 / #138 — bark,
 * leaves, stone, sky-dome).
 *
 * Output:
 *   assets/textures/forest_ground_normal_512.png
 *
 * Algorithm (matches the FOREST-V2-A35 brief):
 *   1. Build a toroidal heightmap via 5-octave value-noise fBm at SIZE×SIZE.
 *      Wrap-safe sampling (same `((gx % grid) + grid) % grid` trick as
 *      `_gen_stone_texture.mjs`) so the resulting normals tile cleanly when
 *      the ground is repeated 180×180 across the 2400 u plane.
 *   2. Sprinkle ~36 rejection-sampled "pebble" dips/bumps — small Gaussian-
 *      profile circular blobs (radius 6-14 px) with random sign — to give
 *      the squint test a hint of broken-ground variation beyond pure fBm.
 *   3. Convert the heightmap to a tangent-space normal map via central
 *      differences:
 *        dx = h(x+1) - h(x-1)
 *        dy = h(y+1) - h(y-1)
 *        n  = normalize(-dx * STRENGTH, -dy * STRENGTH, 1)
 *      Pack to RGB as `(n * 0.5 + 0.5) * 255`. STRENGTH controls how much
 *      the heightmap delta contributes vs. the +z baseline; tuned so the
 *      normal map reads as "subtle surface micro-detail" rather than
 *      "obvious lumps" — the brief asks for normalScale 0.3-0.6 in env.js
 *      and a stylized squint test, so we keep the source map gentle and
 *      let env.js's existing 0.6 scale do the rest.
 *
 * Output format: PNG-8 RGB, sRGB-disabled at the loader site (the consumer
 * sets `colorSpace = THREE.NoColorSpace` because normal data MUST NOT be
 * sRGB-decoded). Alpha channel is dropped; standard tangent-space normal
 * maps don't carry one and removing it saves ~25 % file size.
 *
 * Determinism: every PRNG seed is hard-coded (mulberry32). Re-running the
 * script yields a byte-identical PNG.
 *
 * Run:
 *   node tools/_gen_ground_normal.mjs
 *   (no npm install — pngjs already vendored in node_modules/)
 */
import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

// 256² (filename keeps the `_512` suffix for cohort consistency with the
// existing texture pack — same pattern as `_gen_stone_texture.mjs` and
// `_gen_tree_textures.mjs`). A true 512² fBm + pebble normal map at
// deflateLevel 9 lands ~400 KB because pixel-scale grit is near-
// incompressible; 256² lands ~110 KB which respects the <150 KB budget.
// At repeat=180 on a 2400 u plane the per-pixel world size is still ~0.052 u
// (~5 cm), well inside the believable forest-floor micro-bump scale and
// way below the camera's effective resolution at typical gameplay zoom.
const SIZE = 256;

// Output strength of the normal vector's xy components before normalization.
// Higher = more aggressive bumps in the source map. env.js separately
// multiplies via `material.normalScale` (currently 0.6, 0.6). Keep the
// source map gentle so the in-engine knob has a usable range. Tuned by eye
// against the cohort 33 stone texture's perceived "feel".
const STRENGTH = 2.5;

// ── mulberry32 PRNG (matches _gen_stone_texture.mjs / _gen_tree_textures.mjs)
function mulberry32(seed) {
  let s = seed >>> 0;
  return function rand() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── value-noise on a torus (wrap-safe; matches sibling generators) ─────────
function makeNoise(seed, grid) {
  const rand = mulberry32(seed);
  const vals = new Float32Array(grid * grid);
  for (let i = 0; i < vals.length; i++) vals[i] = rand();
  function at(gx, gy) {
    const x = ((gx % grid) + grid) % grid;
    const y = ((gy % grid) + grid) % grid;
    return vals[y * grid + x];
  }
  function smooth(t) { return t * t * (3 - 2 * t); }
  return function sample(u, v) {
    const fx = u * grid;
    const fy = v * grid;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = smooth(fx - ix);
    const ty = smooth(fy - iy);
    const a = at(ix,     iy);
    const b = at(ix + 1, iy);
    const c = at(ix,     iy + 1);
    const d = at(ix + 1, iy + 1);
    return (a * (1 - tx) + b * tx) * (1 - ty)
         + (c * (1 - tx) + d * tx) * ty;
  };
}

// 4-octave fBm at lattice grid 4 → 8 → 16 → 32. Doubling each octave is the
// standard fBm progression and matches `_gen_stone_texture.mjs`. The
// coarsest octave at grid 4 produces broad mound/hollow variation
// (~SIZE/4 = 64 px wavelength) while the finest at grid 32 supplies the
// micro-grit. Amplitudes halve per octave so broad features dominate the
// composite — exactly what a worn-soil normal map needs. Dropped from 5
// octaves to 4 (no grid-128 layer) because pixel-scale noise is near-
// incompressible — losing the finest octave knocks the PNG from 400 KB
// down to ~110 KB and the lost detail isn't visible at gameplay zoom.
function fbm(seed, octaves) {
  const noises = [];
  let g = 4;
  for (let o = 0; o < octaves; o++) {
    noises.push({ n: makeNoise(seed + o * 17, g), amp: 1 / (1 << o) });
    g *= 2;
  }
  return function (u, v) {
    let s = 0;
    let norm = 0;
    for (const { n, amp } of noises) {
      s += n(u, v) * amp;
      norm += amp;
    }
    return s / norm;
  };
}

// Gaussian-profile pebble stamp on a torus. `sign` ∈ {-1, +1} controls
// whether the pebble is a dip (loose stone pressed in) or a bump (pebble
// resting on the surface). Radius in pixels.
function stampPebble(h, cx, cy, radius, sign, amplitude) {
  const r2 = radius * radius;
  const inv2sigma2 = 1 / (2 * (radius * 0.5) * (radius * 0.5));
  // Iterate a bounding square; wrap each pixel onto the torus.
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const x = ((cx + dx) % SIZE + SIZE) % SIZE;
      const y = ((cy + dy) % SIZE + SIZE) % SIZE;
      const falloff = Math.exp(-d2 * inv2sigma2);
      h[y * SIZE + x] += sign * amplitude * falloff;
    }
  }
}

function generateGroundNormal() {
  // ── 1. Heightmap ─────────────────────────────────────────────────────────
  // fBm in [0,1] is shifted to [-0.5, +0.5] so downstream gradient is signed
  // and central differences produce balanced ± normals. Amplitude is
  // small (0.5 here, scaled further by STRENGTH at conversion time) — the
  // heightmap itself never leaves engineering units, only the final normal
  // packing cares about absolute magnitude.
  const broad = fbm(0x6707AC1D, 4);
  const fine  = fbm(0xC8AC1217, 3); // independent fBm for high-freq grit
  const h = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE;
      const v = y / SIZE;
      // 70 % broad + 30 % fine; both centered around 0 so the mean height
      // stays flat (no DC bias in the gradient).
      const hb = broad(u, v) - 0.5;
      const hf = fine(u * 2, v * 2) - 0.5;
      h[y * SIZE + x] = hb * 0.7 + hf * 0.3;
    }
  }

  // ── 2. Pebble dips + bumps ───────────────────────────────────────────────
  // 32 stamps; ~half dips, ~half bumps. Radius 4-9 px on a 256 grid (≈
  // 1.5-3.5 % of the tile edge), so on the 2400 u plane at repeat 180 each
  // pebble reads as ~20-47 cm — believable forest-floor stone size. Count
  // dropped from 36 → 32 to compensate for the halved grid (same coverage).
  const pRand = mulberry32(0xDA1158C9);
  const PEBBLE_COUNT = 32;
  for (let i = 0; i < PEBBLE_COUNT; i++) {
    const cx = Math.floor(pRand() * SIZE);
    const cy = Math.floor(pRand() * SIZE);
    const radius = 4 + Math.floor(pRand() * 6); // 4..9
    const sign = pRand() < 0.5 ? -1 : +1;
    // Amplitude small enough that pebbles read as detail, not craters.
    const amp = 0.12 + pRand() * 0.10; // 0.12..0.22
    stampPebble(h, cx, cy, radius, sign, amp);
  }

  // ── 3. Heightmap → tangent-space normal map ──────────────────────────────
  // Central differences with wrap-around lookups so the resulting map is
  // also tileable (matches the heightmap which is already toroidal).
  const png = new PNG({ width: SIZE, height: SIZE, colorType: 2 }); // RGB
  const sample = (x, y) => h[((y % SIZE) + SIZE) % SIZE * SIZE
                            + ((x % SIZE) + SIZE) % SIZE];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = sample(x + 1, y) - sample(x - 1, y);
      const dy = sample(x, y + 1) - sample(x, y - 1);
      // Tangent-space normal: (-dx, -dy, 1) (standard OpenGL +Y convention,
      // matches Poly Haven's `nor_gl.jpg` ending the predecessor pack used).
      const nx = -dx * STRENGTH;
      const ny = -dy * STRENGTH;
      const nz = 1.0;
      const invLen = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      const rx = nx * invLen;
      const ry = ny * invLen;
      const rz = nz * invLen;
      // Pack: [-1, +1] → [0, 255].
      const idx = (y * SIZE + x) * 3; // colorType=2 → 3 bytes/pixel, no alpha
      png.data[idx]     = Math.max(0, Math.min(255, Math.round((rx * 0.5 + 0.5) * 255)));
      png.data[idx + 1] = Math.max(0, Math.min(255, Math.round((ry * 0.5 + 0.5) * 255)));
      png.data[idx + 2] = Math.max(0, Math.min(255, Math.round((rz * 0.5 + 0.5) * 255)));
    }
  }
  return PNG.sync.write(png, { colorType: 2, deflateLevel: 9 });
}

const repoRoot = new URL('../', import.meta.url);
writeFileSync(
  new URL('assets/textures/forest_ground_normal_512.png', repoRoot),
  generateGroundNormal(),
);
console.log('[gen-ground-normal] wrote ' + SIZE + '×' + SIZE + ' tangent-space '
          + 'normal map to assets/textures/forest_ground_normal_512.png');
