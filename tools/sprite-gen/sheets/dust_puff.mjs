/**
 * dust_puff_v1 — ground-aligned dust burst. Footfall / landing FX.
 *
 * 32×32 source pixels, 8 frames, 2 rows × 4 cols (128×64 sheet).
 *
 * Concept: a small cluster of "dust pixels" spawns near the ground, rises
 * and drifts outward, then disperses. Strictly aliased (0/1 alpha) — no
 * additive halo (alpha blend, no bloom). Cylinder billboard so dust faces
 * the camera but stays vertical.
 *
 * Anchor = [0.5, 1.0] — bottom-center, so the sprite sits flush on ground.
 *
 * Procgen approach: simulate ~24 dust "particles" with deterministic
 * Mulberry32 randomness. Each particle has a (x0, y0, vx, vy, lifeOffset).
 * For each frame, advance particles, quantize to pixel grid, paint slot-3
 * (main dust) with slot-1 flecks (heavy / dark grit). Anti-overlap not
 * required — multiple particles landing on the same pixel just over-paint.
 */
import path from 'node:path';
import { createCanvas, putPixel, savePNG, saveJSON, mulberry32 } from '../canvas.mjs';
import { NEUTRAL } from '../palette.mjs';

const FRAME_W = 32;
const FRAME_H = 32;
const FRAMES = 8;
const COLS = 4;
const ROWS = 2;
const SEED = 0xDEAD0FFE >>> 0; // "DEAD-OFFEe" — dust off feet

/** Simulate one dust particle's position at frame t. */
function particlePos(p, t) {
  // Gravity / air-drag: simple Euler with mild downward pull AFTER initial pop.
  const u = t / (FRAMES - 1);
  const x = p.x0 + p.vx * t;
  const y = p.y0 + p.vy * t + 0.18 * t * t; // accelerate downward late
  // Particles "die" past their per-particle TTL.
  const alive = t <= p.ttl;
  return { x, y, alive, u };
}

function buildParticles() {
  const rand = mulberry32(SEED);
  const out = [];
  // 26 particles — enough density for visible cluster, sparse enough for
  // the per-frame look to stay readable at 32×32.
  for (let i = 0; i < 26; i++) {
    const angle = (rand() * Math.PI) - Math.PI / 2 + (rand() - 0.5) * 0.4; // mostly outward / up
    const speed = 0.6 + rand() * 1.8;
    out.push({
      // start clustered near bottom-center of the frame (anchor is [0.5, 1.0])
      x0: FRAME_W / 2 - 0.5 + (rand() - 0.5) * 4,
      y0: FRAME_H - 4 + (rand() - 0.5) * 2,
      vx: Math.cos(angle) * speed * 0.9,
      vy: Math.sin(angle) * speed * 0.85, // negative = upward (Y inverted in image space, but our particles use image coords with +Y = down, so we want negative)
      ttl: 4 + Math.floor(rand() * 4), // 4..7 frames
      heavy: rand() < 0.18, // ~18% are dark grit flecks
    });
  }
  // Re-sign vy: we want most particles to actually go UP at first.
  for (const p of out) p.vy = -Math.abs(p.vy);
  return out;
}

function stampFrame(canvas, frameCol, frameRow, frame, particles) {
  const ox = frameCol * FRAME_W;
  const oy = frameRow * FRAME_H;
  for (const p of particles) {
    const { x, y, alive } = particlePos(p, frame);
    if (!alive) continue;
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || px >= FRAME_W || py < 0 || py >= FRAME_H) continue;
    const color = p.heavy ? NEUTRAL.slot1 : NEUTRAL.slot3;
    putPixel(canvas, ox + px, oy + py, [...color, 255]);
  }
}

export function generate(outDir) {
  const sheetW = FRAME_W * COLS;
  const sheetH = FRAME_H * ROWS;
  const canvas = createCanvas(sheetW, sheetH);
  const particles = buildParticles();

  for (let f = 0; f < FRAMES; f++) {
    const col = f % COLS;
    const row = Math.floor(f / COLS);
    stampFrame(canvas, col, row, f, particles);
  }

  const pngPath = path.join(outDir, 'dust_puff_v1.png');
  const jsonPath = path.join(outDir, 'dust_puff_v1.json');
  savePNG(canvas, pngPath);
  saveJSON({
    version: 1,
    image: 'dust_puff_v1.png',
    frameWidth: FRAME_W,
    frameHeight: FRAME_H,
    cols: COLS,
    rows: ROWS,
    frameCount: FRAMES,
    pixelsPerWorldUnit: 24,
    anchor: [0.5, 1.0],
    blendMode: 'alpha',
    bloom: false,
    billboard: 'cylinder',
    anims: {
      default: { from: 0, to: FRAMES - 1, fps: 18, loop: false },
    },
    palette: 'neutral',
    license: 'internal',
    source: 'procgen v1',
  }, jsonPath);
  return { pngPath, jsonPath };
}
