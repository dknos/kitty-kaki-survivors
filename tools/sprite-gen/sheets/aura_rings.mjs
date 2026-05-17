/**
 * aura_rings_v1 — looping ground-emanating ring FX (buff/zone tell).
 *
 * 64×64 source pixels, 8 frames, 2 rows × 4 cols (256×128 sheet).
 *
 * Concept: two concentric 1px pixel rings, rotating and pulsing. The
 * looping `idle` animation cycles smoothly over 8 frames — the inner
 * ring expands/contracts while the outer ring rotates phase.
 *
 * Hard 1px pixel rings, additive blend, bloom on. Cylinder billboard so
 * the ring reads as "emanating from the ground" regardless of camera yaw.
 * Anchor [0.5, 1.0] — bottom-center pinned to the floor.
 *
 * Anim name: "idle" (per brief). spriteAtlas falls back to "default" but
 * the brief explicitly names "idle" + loop=true, so we honor that.
 */
import path from 'node:path';
import { createCanvas, putPixel, savePNG, saveJSON, mulberry32 } from '../canvas.mjs';
import { NEUTRAL } from '../palette.mjs';

const FRAME_W = 64;
const FRAME_H = 64;
const FRAMES = 8;
const COLS = 4;
const ROWS = 2;
const SEED = 0xA0BAFA11 >>> 0;

/**
 * Bresenham-style midpoint circle, 1px hard. Color passed in.
 * Slight thickness option for the "pulse" peak frames.
 */
function drawRing(canvas, ox, oy, cx, cy, r, color) {
  // Walk the bounding box, mark pixels whose center sits within
  // [r-0.5, r+0.5) — gives a clean 1px aliased ring.
  const r0 = r - 0.5;
  const r1 = r + 0.5;
  const x0 = Math.max(0, Math.floor(cx - r - 1));
  const x1 = Math.min(FRAME_W - 1, Math.ceil(cx + r + 1));
  const y0 = Math.max(0, Math.floor(cy - r - 1));
  const y1 = Math.min(FRAME_H - 1, Math.ceil(cy + r + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= r0 && d < r1) {
        putPixel(canvas, ox + x, oy + y, color);
      }
    }
  }
}

/**
 * Rotated-dot decoration on a ring — places `n` evenly-spaced sparkle
 * pixels around radius r, offset by phase (radians). Used to add visible
 * rotation cues since a perfect 1px ring is rotation-invariant.
 */
function decorateRing(canvas, ox, oy, cx, cy, r, n, phase, color) {
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    const px = Math.round(cx + Math.cos(a) * r);
    const py = Math.round(cy + Math.sin(a) * r);
    putPixel(canvas, ox + px, oy + py, color);
  }
}

function stampFrame(canvas, frame, ox, oy) {
  const cx = FRAME_W / 2 - 0.5;
  // Anchor is [0.5, 1.0]: visually we want the ring centered horizontally
  // but the "ring" itself is drawn as a flat disc seen edge-on... actually
  // since billboard is cylinder (faces camera, stays vertical), the sprite
  // is a vertical quad. We draw concentric rings centered in the quad and
  // let the cylinder billboard + flat-on-ground anchor do the rest.
  const cy = FRAME_H / 2 - 0.5;

  // Inner ring pulses 18 → 26 → 18 across 8 frames (sinusoidal).
  const innerR = 22 + Math.sin((frame / FRAMES) * Math.PI * 2) * 4;
  // Outer ring stays near max, slow visual rotation via decoration dots.
  const outerR = 28;

  drawRing(canvas, ox, oy, cx, cy, innerR, [...NEUTRAL.slot8, 255]);
  drawRing(canvas, ox, oy, cx, cy, outerR, [...NEUTRAL.slot3, 255]);

  // 4-step alpha halo on outer ring (one pixel outside) — additive bloom layer.
  drawRing(canvas, ox, oy, cx, cy, outerR + 1, [...NEUTRAL.slot3, 84]);

  // Rotation cue: 6 sparkles on outer ring, phase = frame / FRAMES * 2π
  // (full rotation across the 8-frame loop)
  const phase = (frame / FRAMES) * Math.PI * 2;
  decorateRing(canvas, ox, oy, cx, cy, outerR, 6, phase, [...NEUTRAL.slot8, 255]);

  // Inner ring counter-rotation cue, 4 sparkles, opposite direction.
  decorateRing(canvas, ox, oy, cx, cy, innerR, 4, -phase + Math.PI / 4, [...NEUTRAL.slot8, 255]);
}

export function generate(outDir) {
  const sheetW = FRAME_W * COLS;
  const sheetH = FRAME_H * ROWS;
  const canvas = createCanvas(sheetW, sheetH);
  // We hold a seeded RNG handle even though geometry is currently fully
  // deterministic by position — keeps signature consistent across sheets
  // and lets later tweaks (jitter, debris) plug into the same seed.
  const _rand = mulberry32(SEED); void _rand;

  for (let f = 0; f < FRAMES; f++) {
    const col = f % COLS;
    const row = Math.floor(f / COLS);
    stampFrame(canvas, f, col * FRAME_W, row * FRAME_H);
  }

  const pngPath = path.join(outDir, 'aura_rings_v1.png');
  const jsonPath = path.join(outDir, 'aura_rings_v1.json');
  savePNG(canvas, pngPath);
  saveJSON({
    version: 1,
    image: 'aura_rings_v1.png',
    frameWidth: FRAME_W,
    frameHeight: FRAME_H,
    cols: COLS,
    rows: ROWS,
    frameCount: FRAMES,
    pixelsPerWorldUnit: 24,
    anchor: [0.5, 1.0],
    blendMode: 'additive',
    bloom: true,
    billboard: 'cylinder',
    anims: {
      idle: { from: 0, to: FRAMES - 1, fps: 12, loop: true },
    },
    palette: 'neutral',
    license: 'internal',
    source: 'procgen v1',
  }, jsonPath);
  return { pngPath, jsonPath };
}
