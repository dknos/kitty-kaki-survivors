#!/usr/bin/env node
/**
 * _gen_tree_textures.mjs — FOREST-V2-A32 / PHASE 3 P3A
 *
 * Deterministic procedural generator for the two tree textures consumed by
 * src/arenaDecor.js (PR #136). Outputs:
 *   assets/textures/forest_bark_512.png
 *   assets/textures/forest_leaves_512.png
 *
 * Both files are 256×256 PNG-8 grayscale, sRGB, tileable on both axes.
 * Pure luminance preserves the locked forest palette — when applied as
 * `MeshStandardMaterial.map` the result is `tint * luminance`, never
 * introducing new hues. See assets/textures/README.md for rationale and
 * docs/FOREST_VISUAL_STYLE.md §"8-Color Palette" for the palette contract.
 *
 * Determinism: mulberry32(0xBA47C0DE) for bark, mulberry32(0x1EAF7E55) for
 * leaves. Re-running the script yields byte-identical PNGs.
 */
import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const SIZE = 256; // 256² × 1 byte/pixel grayscale (color type 0) = ~65 KB raw → ~10-25 KB compressed

// ── mulberry32 PRNG (matches src/arenaDecor.js inline impl) ────────────────
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

// ── value-noise on a torus (wrap-safe) ─────────────────────────────────────
// Tileability is achieved by computing the lattice mod GRID so all edges
// match. Smoothstep interpolation. Stacked octaves for fBm.
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
    // u, v in [0, 1) (already wrapped by caller)
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

function fbm(seed, octaves) {
  const noises = [];
  let g = 4;
  for (let o = 0; o < octaves; o++) {
    noises.push({ n: makeNoise(seed + o * 13, g), amp: 1 / (1 << o) });
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

// ── bark: vertical fibre streaks + horizontal crack lines + grain ──────────
function generateBark() {
  const png = new PNG({ width: SIZE, height: SIZE, colorType: 0 });
  const noise = fbm(0xBA47C0DE, 4);
  const crackN = fbm(0xCAFEB4BC, 3);
  const fineRand = mulberry32(0xF1BE6A11);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE;
      const v = y / SIZE;
      // Streaked base: stretch noise vertically (small u-frequency, big v).
      // sample on (u * 1, v * 0.5) emphasises vertical runs because the
      // lookup grid sees only half a v-period across the texture height.
      const fibre = noise(u, v * 0.5);
      // Horizontal hairline cracks: threshold a narrow band of a second
      // noise. cracks are darker (-amplitude).
      const c = crackN(u * 2, v);
      const crack = Math.max(0, 0.5 - Math.abs(c - 0.5) * 12);
      // Random grain (fine speckle) — independent per pixel, low amplitude.
      const grain = (fineRand() - 0.5) * 0.08;
      let lum = 0.32 + fibre * 0.55 - crack * 0.30 + grain;
      // Soft column shading — every ~32 px add a subtle dark vertical seam
      // for "fibrous trunk" silhouette under tiling. cos period = SIZE/4.
      lum -= Math.max(0, Math.cos(u * Math.PI * 8) - 0.7) * 0.18;
      lum = Math.max(0.05, Math.min(0.95, lum));
      const px = (y * SIZE + x) * 4;
      const b = Math.round(lum * 255);
      png.data[px]     = b;
      png.data[px + 1] = b;
      png.data[px + 2] = b;
      png.data[px + 3] = 255;
    }
  }
  return PNG.sync.write(png, { colorType: 0, deflateLevel: 9 });
}

// ── leaves: speckled clusters of soft blobs (foliage feel) ─────────────────
// Density + softness chosen so close-up reads as leafy clusters but at game
// zoom (squint test) it tiles into a flat surface variation. No alpha — the
// texture multiplies the existing emissive material color.
function generateLeaves() {
  const png = new PNG({ width: SIZE, height: SIZE, colorType: 0 });
  const macro = fbm(0x1EAF7E55, 3);
  const rand = mulberry32(0xC4BB4A6E);
  // Generate ~340 leaf blob centers (random scatter on the torus); each
  // blob is a soft radial gradient. Per-pixel min-distance to the nearest
  // blob center on the wrapped torus → highest near a center.
  const BLOBS = 340;
  const cx = new Float32Array(BLOBS);
  const cy = new Float32Array(BLOBS);
  const cr = new Float32Array(BLOBS); // radius in pixels
  const ci = new Float32Array(BLOBS); // intensity 0..1
  for (let i = 0; i < BLOBS; i++) {
    cx[i] = rand() * SIZE;
    cy[i] = rand() * SIZE;
    cr[i] = 4 + rand() * 6;          // 4..10 px
    ci[i] = 0.55 + rand() * 0.45;
  }
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let acc = 0;
      for (let i = 0; i < BLOBS; i++) {
        // Toroidal distance (wrap on both axes) so blobs near the seam
        // contribute to the opposite edge and the texture tiles cleanly.
        let dx = Math.abs(x - cx[i]);
        let dy = Math.abs(y - cy[i]);
        if (dx > SIZE / 2) dx = SIZE - dx;
        if (dy > SIZE / 2) dy = SIZE - dy;
        const d2 = dx * dx + dy * dy;
        const r2 = cr[i] * cr[i];
        if (d2 < r2) {
          // soft cosine falloff
          const t = 1 - d2 / r2;
          acc += t * t * ci[i];
        }
      }
      // Macro variation breaks up the regularity at squint distance.
      const u = x / SIZE, v = y / SIZE;
      const macroV = macro(u, v) * 0.30;
      let lum = 0.30 + acc * 0.45 + macroV;
      lum = Math.max(0.10, Math.min(0.95, lum));
      const px = (y * SIZE + x) * 4;
      const b = Math.round(lum * 255);
      png.data[px]     = b;
      png.data[px + 1] = b;
      png.data[px + 2] = b;
      png.data[px + 3] = 255;
    }
  }
  return PNG.sync.write(png, { colorType: 0, deflateLevel: 9 });
}

const repoRoot = new URL('../', import.meta.url);
writeFileSync(new URL('assets/textures/forest_bark_512.png', repoRoot), generateBark());
writeFileSync(new URL('assets/textures/forest_leaves_512.png', repoRoot), generateLeaves());
console.log('[gen-tree-textures] wrote bark + leaves to assets/textures/');
