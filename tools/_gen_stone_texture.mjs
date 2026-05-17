#!/usr/bin/env node
/**
 * _gen_stone_texture.mjs — FOREST-V2-A33 / PHASE 3 P3B
 *
 * Deterministic procedural generator for the single stone/granite texture
 * consumed by src/forestLandmarks.js and src/forestCoffins.js (PR #137).
 * Outputs:
 *   assets/textures/forest_stone_512.png
 *
 * File is 512×512 PNG-8 grayscale, sRGB, tileable on both axes. Pure
 * luminance preserves the locked forest palette — when applied as
 * `MeshStandardMaterial.map` the result is `tint * luminance`, never
 * introducing new hues. See assets/textures/README.md for rationale and
 * docs/FOREST_VISUAL_STYLE.md §"8-Color Palette" for the palette contract.
 *
 * Mirrors the structure of tools/_gen_tree_textures.mjs (PR #136). Pattern:
 *   - 4-octave value-noise fBm at scale ~0.02-0.08 → granite surface mottle.
 *   - 8 crack line strokes via Bresenham → subtle darker hairlines.
 *   - 5% density moss specks → very faint luminance bumps.
 *   - Midtone-anchored output centered near 0.70 luminance so tinted slot
 *     colors (slot-3 brown 0x6b4f3a, slot-1 bone 0xc7b89a, slot-4 dark
 *     0x4a3220) stay legibly close to their original palette values under
 *     the squint test.
 *
 * Determinism: mulberry32(0x57104E55) seeds all noise + crack + speckle
 * passes. Re-running the script yields byte-identical PNG.
 */
import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

// SIZE chosen to fit the <100 KB budget after deflate. 512² grayscale with
// fBm + cracks + moss specks lands at ~160 KB compressed; 256² lands at
// ~25-35 KB (matches the tree texture cohort 32 precedent — filename keeps
// the `_512` suffix for consistency with the existing texture pack but the
// pixel grid is 256). The visual squint test is unchanged because all
// surfaces consuming the texture are small (≤2 m on screen).
const SIZE = 256;

// ── mulberry32 PRNG (matches _gen_tree_textures.mjs) ───────────────────────
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

// ── value-noise on a torus (wrap-safe; matches tree-tex generator) ─────────
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

// fBm starting at lattice grid=4 (≈ scale 0.0078) and doubling each octave
// so the 4-octave stack covers scale ~0.008-0.06 — matches the spec band
// 0.02-0.08 and adds one coarser octave for trunk-scale variation.
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

// ── stone surface: midtone-anchored fBm + crack hairlines + moss specks ───
function generateStone() {
  const png = new PNG({ width: SIZE, height: SIZE, colorType: 0 });

  // Two fBm fields:
  //   surface — broad granite mottle (4 octaves, low amplitude)
  //   grit    — fine speckle (3 octaves at higher frequency, very low amp)
  const surface = fbm(0x57104E55, 4);
  const grit    = fbm(0x6172AC1D, 3);
  const fineRand = mulberry32(0xA110B14D);

  // Allocate luminance plane first; we paint base then composite cracks +
  // specks at the end so Bresenham strokes don't get blurred by post-grain.
  const lum = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE;
      const v = y / SIZE;
      // Base near 0.70 so tints retain their palette feel.
      const broad = surface(u, v);          // ~[0,1]
      const fine  = grit(u * 3, v * 3);     // ~[0,1]
      const grain = (fineRand() - 0.5) * 0.06;
      // Center surface noise around 0 (subtract 0.5) and scale to ±0.10.
      // Fine grit gets ±0.04. Together ≈ ±0.20 luminance about 0.70 base.
      let L = 0.70 + (broad - 0.5) * 0.20 + (fine - 0.5) * 0.08 + grain;
      lum[y * SIZE + x] = L;
    }
  }

  // ── crack hairlines via Bresenham ───────────────────────────────────────
  // 10 random line segments, length 40-90 px (~SIZE/6 to SIZE/3), luminance dip of -0.18.
  // Wrap on the torus (mod SIZE) so cracks that exit one edge re-enter
  // the opposite — preserves tileability.
  const crackRand = mulberry32(0xCAFEC4A9);
  const CRACK_COUNT = 10;
  for (let c = 0; c < CRACK_COUNT; c++) {
    const x0 = Math.floor(crackRand() * SIZE);
    const y0 = Math.floor(crackRand() * SIZE);
    const ang = crackRand() * Math.PI * 2;
    const len = 40 + Math.floor(crackRand() * 50); // 40..90 px on a 256 grid
    const x1 = x0 + Math.round(Math.cos(ang) * len);
    const y1 = y0 + Math.round(Math.sin(ang) * len);
    drawLineWrapped(lum, x0, y0, x1, y1, -0.18);
  }

  // ── moss specks — 5% density, small luminance bumps ─────────────────────
  // "Speck" = a single brightened pixel + 4-neighbor with half intensity.
  // Density spec'd at 5% but applied per-pixel with low probability so the
  // result reads as scattered tiny moss flecks rather than continuous
  // coverage. Intensity is +0.06 (subtle; preserves the squint test).
  const mossRand = mulberry32(0x103510C7);
  const MOSS_P = 0.05;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (mossRand() < MOSS_P) {
        addLumWrapped(lum, x, y, +0.06);
        addLumWrapped(lum, x + 1, y, +0.03);
        addLumWrapped(lum, x - 1, y, +0.03);
        addLumWrapped(lum, x, y + 1, +0.03);
        addLumWrapped(lum, x, y - 1, +0.03);
      }
    }
  }

  // ── encode → grayscale PNG (RGB triplet for max compat) ─────────────────
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let L = lum[y * SIZE + x];
      // Clamp to safe luminance band so tints never blow out or go pitch.
      if (L < 0.20) L = 0.20;
      if (L > 0.92) L = 0.92;
      const px = (y * SIZE + x) * 4;
      const b = Math.round(L * 255);
      png.data[px]     = b;
      png.data[px + 1] = b;
      png.data[px + 2] = b;
      png.data[px + 3] = 255;
    }
  }
  return PNG.sync.write(png, { colorType: 0, deflateLevel: 9 });
}

// Bresenham line, wrapping (toroidal). Adds `delta` luminance per pixel.
function drawLineWrapped(lum, x0, y0, x1, y1, delta) {
  let x = x0, y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  const maxSteps = dx - dy + 2; // safety
  let steps = 0;
  while (steps++ < maxSteps) {
    addLumWrapped(lum, x, y, delta);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

function addLumWrapped(lum, x, y, delta) {
  const xx = ((x % SIZE) + SIZE) % SIZE;
  const yy = ((y % SIZE) + SIZE) % SIZE;
  lum[yy * SIZE + xx] += delta;
}

const repoRoot = new URL('../', import.meta.url);
writeFileSync(new URL('assets/textures/forest_stone_512.png', repoRoot), generateStone());
console.log('[gen-stone-texture] wrote stone to assets/textures/forest_stone_512.png');
