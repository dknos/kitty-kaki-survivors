/**
 * Thin canvas abstraction over `pngjs` (pure-JS, no native deps).
 *
 * Rationale (see SPRITE_GEN_PIPELINE.md "Lib choice"): the host repo has
 * NO native canvas lib installed and the workspace contract bans
 * sudo/global installs. pngjs is pure JS, ships with deterministic
 * encoding (no tIME chunk by default), and trivially produces
 * pixel-accurate aliased output — which is exactly what the
 * CRUNCHY PIXEL-ART contract demands.
 *
 * The "canvas" here is just an RGBA byte buffer + width/height.
 * Every pixel operation is explicit — no anti-aliasing can sneak in.
 */
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef PixelCanvas
 * @property {number} width
 * @property {number} height
 * @property {Uint8Array} data  RGBA bytes, length = w*h*4
 */

/** Create a fully-transparent RGBA canvas. */
export function createCanvas(width, height) {
  return {
    width,
    height,
    data: new Uint8Array(width * height * 4), // zero-init = transparent
  };
}

/**
 * Set one pixel. Color = [r,g,b,a] in 0-255. Off-canvas writes are silently
 * dropped (lets generators draw without bounds-checking every step).
 *
 * The contract forbids partial alpha on edge pixels EXCEPT for additive
 * bloom halos (see SPRITES_VISUAL_STYLE §Anti-aliasing). Generators are
 * responsible for honoring that — this primitive does not enforce it.
 */
export function putPixel(canvas, x, y, color) {
  x = x | 0; y = y | 0;
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
  const i = (y * canvas.width + x) * 4;
  canvas.data[i + 0] = color[0];
  canvas.data[i + 1] = color[1];
  canvas.data[i + 2] = color[2];
  canvas.data[i + 3] = color[3] ?? 255;
}

/**
 * Composite a pixel using SRC-OVER (normal alpha). Only meaningful when
 * you're drawing translucent on top of opaque — most generators use
 * putPixel + last-write-wins instead.
 */
export function blendPixel(canvas, x, y, color) {
  x = x | 0; y = y | 0;
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
  const i = (y * canvas.width + x) * 4;
  const sa = (color[3] ?? 255) / 255;
  const da = canvas.data[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  for (let c = 0; c < 3; c++) {
    canvas.data[i + c] = Math.round(
      (color[c] * sa + canvas.data[i + c] * da * (1 - sa)) / oa,
    );
  }
  canvas.data[i + 3] = Math.round(oa * 255);
}

/** Read one pixel as [r,g,b,a]. */
export function getPixel(canvas, x, y) {
  const i = (y * canvas.width + x) * 4;
  return [canvas.data[i], canvas.data[i + 1], canvas.data[i + 2], canvas.data[i + 3]];
}

/** Fill a rectangle (inclusive bounds) with a single color. */
export function fillRect(canvas, x0, y0, w, h, color) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      putPixel(canvas, x, y, color);
    }
  }
}

/**
 * Save canvas as a deterministic PNG. Avoids tIME chunk and any other
 * timestamp-injecting metadata so re-runs produce byte-identical files
 * (gated by the determinism contract — see PIPELINE.md).
 */
export function savePNG(canvas, outPath) {
  const png = new PNG({
    width: canvas.width,
    height: canvas.height,
    colorType: 6, // RGBA
    bitDepth: 8,
    inputHasAlpha: true,
  });
  // pngjs expects Buffer; copy from our Uint8Array.
  png.data = Buffer.from(canvas.data);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const buf = PNG.sync.write(png, {
    colorType: 6,
    bitDepth: 8,
    inputHasAlpha: true,
    // No tIME, no zlib level forcing — pngjs defaults are deterministic
    // across runs on the same node version. We don't claim cross-version
    // determinism; the determinism gate is "same machine, two runs".
  });
  fs.writeFileSync(outPath, buf);
  return outPath;
}

/**
 * Mulberry32 PRNG — tiny, fast, deterministic. Seed in, [0,1) out.
 * No state shared between generators; each sheet owns its seed.
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Save a JSON sidecar — sorted keys not required but pretty-printed for diff. */
export function saveJSON(obj, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(obj, null, 2) + '\n');
  return outPath;
}
