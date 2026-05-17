/**
 * borgir_explosion_v1 — setpiece kaboom for the Borgir mob's death.
 *
 * 48×48 source pixels, 10 frames, 2 rows × 5 cols (240×96 sheet).
 *
 * Frame plan:
 *   0 — tiny white core flash (peak-white exception, 4px)
 *   1 — white + amber core (8px), slot-7 hot halo
 *   2 — bright fireball (16px), white center, amber body, slot-7 outer
 *   3 — peak fireball (26px), amber/slot-7 with slot-8 cyan smoke flecks
 *   4 — expansion (34px), amber center → slot-3 cool shell appearing
 *   5 — peak expansion (40px), slot-3 dominates with amber dying core
 *   6 — smoke ring (40px), slot-3 hollow with slot-1 grit
 *   7 — smoke dispersal (38px), broken-arc slot-3 + slot-1 flecks
 *   8 — wisps (34px), sparse slot-3 dots
 *   9 — last embers (28px), 4-step alpha slot-3 halo only
 *
 * Warm-accent extension authorized by the SPRITES-A1 brief (slot-6 + slot-7).
 * Flagged in docs/SPRITE_GEN_PIPELINE.md as a contract extension awaiting
 * doc-owner sign-off. If rejected: demote warm pixels to slot-8 cyan.
 */
import path from 'node:path';
import { createCanvas, putPixel, savePNG, saveJSON, mulberry32 } from '../canvas.mjs';
import { NEUTRAL, WARM } from '../palette.mjs';

const FRAME_W = 48;
const FRAME_H = 48;
const FRAMES = 10;
const COLS = 5;
const ROWS = 2;
const SEED = 0xB0B61234 >>> 0;

/**
 * Single-frame stamp. (ox, oy) = top-left of the frame in sheet coords.
 *
 * The drawing model: walk every pixel in the frame, compute distance to
 * center, choose a color band by radius bucket. Frame-specific bucket
 * tables are inlined for clarity — easier to tweak one frame than to
 * factor into a generic parameterized function.
 */
function stampFrame(canvas, ox, oy, frame, rand) {
  const cx = FRAME_W / 2 - 0.5;
  const cy = FRAME_H / 2 - 0.5;
  // We use a per-frame "noise" by quantizing rand into a stable per-pixel
  // hash via (frame, x, y). Mulberry32 advances over the entire frame so
  // the order of pixel iteration is what binds determinism.
  for (let y = 0; y < FRAME_H; y++) {
    for (let x = 0; x < FRAME_W; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const px = ox + x;
      const py = oy + y;
      const n = rand(); // burns determinism budget evenly across the sheet

      switch (frame) {
        case 0: {
          // tiny white core
          if (d <= 2)        putPixel(canvas, px, py, [...NEUTRAL.white, 255]);
          break;
        }
        case 1: {
          if (d <= 1.5)      putPixel(canvas, px, py, [...NEUTRAL.white, 255]);
          else if (d <= 3.5) putPixel(canvas, px, py, [...WARM.slot7, 255]);
          else if (d <= 5)   putPixel(canvas, px, py, [...WARM.slot6, 255]);
          else if (d <= 6.2) putPixel(canvas, px, py, [...WARM.slot6, 168]); // soft halo
          break;
        }
        case 2: {
          if (d <= 2.5)      putPixel(canvas, px, py, [...NEUTRAL.white, 255]);
          else if (d <= 5)   putPixel(canvas, px, py, [...WARM.slot7, 255]);
          else if (d <= 8)   putPixel(canvas, px, py, [...WARM.slot6, 255]);
          else if (d <= 9.2) putPixel(canvas, px, py, [...WARM.slot6, 168]);
          break;
        }
        case 3: {
          if (d <= 4)         putPixel(canvas, px, py, [...WARM.slot7, 255]);
          else if (d <= 9)    putPixel(canvas, px, py, [...WARM.slot6, 255]);
          else if (d <= 13)   putPixel(canvas, px, py, [...WARM.slot7, 255]);
          // sparse cyan flecks at extreme radius — hot debris
          if (d > 11 && d < 13 && n < 0.08) putPixel(canvas, px, py, [...NEUTRAL.slot8, 255]);
          // soft outer halo
          if (d > 13 && d <= 14.2) putPixel(canvas, px, py, [...WARM.slot6, 84]);
          break;
        }
        case 4: {
          if (d <= 6)         putPixel(canvas, px, py, [...WARM.slot7, 255]);
          else if (d <= 12)   putPixel(canvas, px, py, [...WARM.slot6, 255]);
          else if (d <= 16)   putPixel(canvas, px, py, [...NEUTRAL.slot3, 255]);
          if (d > 16 && d <= 17.2) putPixel(canvas, px, py, [...NEUTRAL.slot3, 168]);
          break;
        }
        case 5: {
          if (d <= 4)        putPixel(canvas, px, py, [...WARM.slot6, 255]);
          else if (d <= 10)  putPixel(canvas, px, py, [...NEUTRAL.slot3, 255]);
          else if (d <= 19)  putPixel(canvas, px, py, [...NEUTRAL.slot3, 255]);
          else if (d <= 20.2) putPixel(canvas, px, py, [...NEUTRAL.slot3, 84]);
          // hot core dying — slot-1 specks inside fireball
          if (d <= 6 && n < 0.10) putPixel(canvas, px, py, [...NEUTRAL.slot1, 255]);
          break;
        }
        case 6: {
          // hollow smoke ring 18..20
          if (d >= 17 && d <= 20)  putPixel(canvas, px, py, [...NEUTRAL.slot3, 255]);
          else if (d >= 14 && d < 17 && n < 0.25) putPixel(canvas, px, py, [...NEUTRAL.slot1, 255]);
          break;
        }
        case 7: {
          // broken arc with slot-1 grit
          if (d >= 17 && d <= 19) {
            const a = Math.atan2(dy, dx);
            const seg = ((a + Math.PI) * 20 / (2 * Math.PI)) | 0;
            if (seg % 2 === 0) putPixel(canvas, px, py, [...NEUTRAL.slot3, 255]);
          }
          if (d >= 15 && d <= 18 && n < 0.10) putPixel(canvas, px, py, [...NEUTRAL.slot1, 255]);
          break;
        }
        case 8: {
          if (d >= 14 && d <= 17 && n < 0.20) putPixel(canvas, px, py, [...NEUTRAL.slot3, 255]);
          break;
        }
        case 9: {
          // last embers — 4-step alpha halo only
          if (d <= 13 && d >= 11) putPixel(canvas, px, py, [...NEUTRAL.slot3, 84]);
          else if (d < 11 && d >= 10) putPixel(canvas, px, py, [...NEUTRAL.slot3, 168]);
          break;
        }
      }
    }
  }
}

export function generate(outDir) {
  const sheetW = FRAME_W * COLS;
  const sheetH = FRAME_H * ROWS;
  const canvas = createCanvas(sheetW, sheetH);
  const rand = mulberry32(SEED);

  for (let f = 0; f < FRAMES; f++) {
    const col = f % COLS;
    const row = Math.floor(f / COLS);
    stampFrame(canvas, col * FRAME_W, row * FRAME_H, f, rand);
  }

  const pngPath = path.join(outDir, 'borgir_explosion_v1.png');
  const jsonPath = path.join(outDir, 'borgir_explosion_v1.json');
  savePNG(canvas, pngPath);
  saveJSON({
    version: 1,
    image: 'borgir_explosion_v1.png',
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
      default: { from: 0, to: FRAMES - 1, fps: 24, loop: false },
    },
    palette: 'neutral',
    license: 'internal',
    source: 'procgen v1',
  }, jsonPath);
  return { pngPath, jsonPath };
}
