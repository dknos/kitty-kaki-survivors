/**
 * hit_flash_v1 — generic impact spark. Stage-agnostic, neutral palette.
 *
 * 32×32 source pixels per frame, 6 frames, 1 row × 6 cols (192×32 sheet).
 * Frames: radial burst, expanding from 4px to 28px diameter, fading.
 *
 * Frame plan:
 *   0 — 4px white core (peak flash exception)
 *   1 — 10px diameter, white inner + slot-8 cyan halo, additive 4-step alpha allowed
 *   2 — 16px diameter, slot-8 inner + slot-3 outer
 *   3 — 22px diameter, slot-3 + faint slot-8 outline (still bright)
 *   4 — 26px diameter, slot-3 outline only, hollow center (fading)
 *   5 — 28px diameter, broken-arc slot-3 dots (almost gone)
 *
 * Hard 1px outlines, additive blend, screen billboard, bloom on.
 */
import path from 'node:path';
import { createCanvas, putPixel, savePNG, saveJSON, mulberry32 } from '../canvas.mjs';
import { NEUTRAL } from '../palette.mjs';

const FRAME_W = 32;
const FRAME_H = 32;
const FRAMES = 6;
const COLS = 6;
const ROWS = 1;
const SEED = 0xF1A511 >>> 0; // "FLASH" → arbitrary fixed seed

/**
 * Stamp a radial burst centered at (cx, cy) of the given frame.
 * radius is the visible diameter / 2. Uses simple distance bucketing —
 * no anti-aliasing, no sub-pixel jitter, so output is fully aliased
 * per the visual contract (additive 4-step alpha allowed on halo only).
 */
function stampBurst(canvas, frameCol, radius, frame) {
  const cx = frameCol * FRAME_W + FRAME_W / 2 - 0.5;
  const cy = FRAME_H / 2 - 0.5;
  const r = radius;
  const rInner = Math.max(0, r - 3);
  const rCore = Math.max(0, r - 6);

  for (let y = 0; y < FRAME_H; y++) {
    for (let x = 0; x < FRAME_W; x++) {
      const dx = x - FRAME_W / 2 + 0.5;
      const dy = y - FRAME_H / 2 + 0.5;
      const d = Math.sqrt(dx * dx + dy * dy);
      // Hollow ring: only paint pixels near radius shell.
      // For frame 0 we want a solid core, not a ring.
      if (frame === 0) {
        if (d <= r) {
          putPixel(canvas, frameCol * FRAME_W + x, y,
            d <= 1.5 ? [...NEUTRAL.white, 255] : [...NEUTRAL.slot8, 255]);
        }
      } else if (frame === 1) {
        // bright pulse: white core, slot-8 halo, slot-3 1px outer
        if (d <= rCore + 0.5)       putPixel(canvas, frameCol * FRAME_W + x, y, [...NEUTRAL.white, 255]);
        else if (d <= rInner + 0.5) putPixel(canvas, frameCol * FRAME_W + x, y, [...NEUTRAL.slot8, 255]);
        else if (d <= r + 0.3)      putPixel(canvas, frameCol * FRAME_W + x, y, [...NEUTRAL.slot3, 255]);
        else if (d <= r + 1.1)      putPixel(canvas, frameCol * FRAME_W + x, y, [...NEUTRAL.slot3, 168]); // 4-step halo
      } else if (frame === 2) {
        // expanding bright ring with slot-8 inside, slot-3 shell
        if (d <= rInner + 0.5 && d >= rCore - 0.5) putPixel(canvas, frameCol * FRAME_W + x, y, [...NEUTRAL.slot8, 255]);
        else if (d <= r + 0.3 && d >= rInner)      putPixel(canvas, frameCol * FRAME_W + x, y, [...NEUTRAL.slot3, 255]);
        else if (d <= r + 1.1 && d > r)            putPixel(canvas, frameCol * FRAME_W + x, y, [...NEUTRAL.slot3, 84]); // soft halo
      } else if (frame === 3) {
        // hollow ring slot-3 with slot-8 sparkle dots
        if (d <= r + 0.3 && d >= r - 1.0) putPixel(canvas, frameCol * FRAME_W + x, y, [...NEUTRAL.slot3, 255]);
        else if (d <= r - 1.5 && d >= r - 2.5 && ((x + y) & 3) === 0) {
          putPixel(canvas, frameCol * FRAME_W + x, y, [...NEUTRAL.slot8, 255]);
        }
      } else if (frame === 4) {
        // thin ring with gaps (every 3rd pixel transparent)
        if (d <= r + 0.3 && d >= r - 0.7) {
          const a = Math.atan2(dy, dx);
          const seg = ((a + Math.PI) * 16 / (2 * Math.PI)) | 0;
          if (seg % 2 === 0) putPixel(canvas, frameCol * FRAME_W + x, y, [...NEUTRAL.slot3, 255]);
        }
      } else if (frame === 5) {
        // broken arc dots
        if (d <= r + 0.3 && d >= r - 0.7) {
          const a = Math.atan2(dy, dx);
          const seg = ((a + Math.PI) * 12 / (2 * Math.PI)) | 0;
          if (seg % 3 === 0) putPixel(canvas, frameCol * FRAME_W + x, y, [...NEUTRAL.slot3, 255]);
        }
      }
    }
  }
}

export function generate(outDir) {
  const sheetW = FRAME_W * COLS;
  const sheetH = FRAME_H * ROWS;
  const canvas = createCanvas(sheetW, sheetH);
  // Seeded RNG for any jitter; current procgen is deterministic by geometry,
  // but we hold the handle so future tweaks stay deterministic.
  const _rand = mulberry32(SEED); void _rand;

  // Radii lifted from the brief: "expanding from 4px to 28px diameter".
  // Diameter → radius. 6 frames, growth roughly linear with mild ease-out.
  const radii = [2, 5, 8, 11, 13, 14];
  for (let f = 0; f < FRAMES; f++) {
    stampBurst(canvas, f, radii[f], f);
  }

  const pngPath = path.join(outDir, 'hit_flash_v1.png');
  const jsonPath = path.join(outDir, 'hit_flash_v1.json');
  savePNG(canvas, pngPath);
  saveJSON({
    version: 1,
    image: 'hit_flash_v1.png',
    frameWidth: FRAME_W,
    frameHeight: FRAME_H,
    cols: COLS,
    rows: ROWS,
    frameCount: FRAMES,
    pixelsPerWorldUnit: 24,
    anchor: [0.5, 0.5],
    blendMode: 'additive',
    bloom: true,
    billboard: 'screen',
    anims: {
      default: { from: 0, to: FRAMES - 1, fps: 30, loop: false },
    },
    palette: 'neutral',
    license: 'internal',
    source: 'procgen v1',
  }, jsonPath);
  return { pngPath, jsonPath };
}
