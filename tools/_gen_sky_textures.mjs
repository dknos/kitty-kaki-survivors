#!/usr/bin/env node
/**
 * _gen_sky_textures.mjs — FOREST-V2-A34 / PHASE 3 P3D
 *
 * Deterministic procedural generator for the five sky-dome gradient
 * textures consumed by src/forestSkyDome.js. Outputs (all 256×128 PNG-8
 * sRGB, vertical gradient only — UV.y maps horizon (y=0) to zenith (y=1)):
 *
 *   assets/textures/sky_midday.png       — slot-1 bone horizon → white zenith
 *   assets/textures/sky_golden.png       — slot-6 gold horizon → slot-7 zenith
 *   assets/textures/sky_dusk.png         — slot-4 dark horizon → slot-5 amber zenith
 *   assets/textures/sky_twilight.png     — slot-4 deep horizon → near-black zenith
 *                                          with thin slot-5 amber band low
 *   assets/textures/sky_bloodmoon.png    — #ff2020 (cohort 20 reuse) horizon →
 *                                          deep dark zenith
 *
 * Each texture is a 256-pixel-wide (no horizontal variation — saves bytes),
 * 128-pixel-tall vertical gradient. PNG run-length compression on long runs
 * of identical rows lands each file at ~1-4 KB.
 *
 * The forest 8-color "atmospheric" palette referenced here is the SAME slot
 * set used by src/forestDayNight.js, src/forestReaper.js, src/forestPickups.js,
 * src/forestLandmarks.js, src/forestCoffins.js (BONE/DARK/AMBER/GOLD) plus
 * the canonical FOREST_VISUAL_STYLE slot-7 amber detonation hex. No new hex
 * constants are introduced. #ff2020 reuses src/config.js cohort-20 reaper
 * glow (red eye/core).
 *
 * Mirrors tools/_gen_stone_texture.mjs (PR #137) and
 * tools/_gen_tree_textures.mjs (PR #136). Pure-luminance is NOT applied
 * here — these textures carry hue (the sky must read warm/cold/red), so
 * they ship as full-RGB sRGB and sample directly in the sky-dome shader.
 *
 * Determinism: no PRNG. Pure linear lerps between known hex colors per
 * sample row. Re-running yields byte-identical PNGs.
 */
import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

// 256 columns × 128 rows. Horizontal is uniform (rows of identical pixels),
// so PNG row-filtering collapses to near-trivial bytes after deflate.
const W = 256;
const H = 128;

// ── Forest atmospheric palette (matches in-tree hex constants, no new) ────
// All five sky textures lerp between palette pairs from this set. None of
// these hexes is introduced by this commit — every one is referenced by
// existing forest modules (forestDayNight, forestReaper, forestLandmarks,
// forestEmitters, forestPickups, forestCoffins, forestEnvHazards, config).
const SLOT1_BONE  = 0xc7b89a; // forestLandmarks.js / forestReaper.js / forestPickups.js
const SLOT4_DARK  = 0x4a3220; // forestDayNight.js / forestEnvHazards.js / others
const SLOT5_AMBER = 0xe89c4a; // forestDayNight.js / forestReaper.js / others
const SLOT6_GOLD  = 0xd9a648; // forestDayNight.js / forestCoffins.js / others
const SLOT7_AMBER_DETONATION = 0xffd86b; // FOREST_VISUAL_STYLE.md slot 7
const REAPER_RED  = 0xff2020; // src/config.js (cohort 20 glowColor reuse)

// "near-white" + "near-black" needed for end-stop tones. Both are convention
// neutrals (per docs/PALETTE_AUDIT_2026-05-16.md §"allowed conventions"):
//   - 0xffffff: neutral tint allowed for InstancedMesh instanceColor + end-
//     stops; used by midday zenith.
//   - 0x000000: inactive emissive convention; used by twilight/bloodmoon
//     zenith as the dark-end stop.
const WHITE = 0xffffff;
const BLACK = 0x000000;

// Each entry is a list of (stop_y, hex) anchors sorted ascending in y.
// y=0 horizon, y=1 zenith. Between anchors we lerp in linear sRGB byte
// space (matches what fragments do under a default LinearFilter sample).
//
// ── Per-phase palette notes ────────────────────────────────────────────────
// midday   — bone horizon (subtle haze) → white zenith (bright sky). No blue
//            slot exists in the forest atmospheric palette; the comment in
//            the brief allows bone-gradient when a blue isn't expressable.
// golden   — slot-6 gold horizon → slot-7 amber detonation zenith. Reads as
//            classic golden-hour sky.
// dusk     — slot-4 dark horizon → slot-5 amber zenith. Anti-rule of "warm at
//            zenith" but matches the spec exactly (brief explicit). The dome
//            shows the OPPOSITE of the sun horizon, so a low-warmth zenith
//            with a darker horizon reads as "sun behind you on the ground,
//            warm afterglow above" at this phase.
// twilight — deeper slot-4 horizon → near-black zenith. A faint slot-5 amber
//            band at y≈0.08 reads as the last horizon afterglow.
// bloodmoon— red-tinted dark (reuse #ff2020) horizon → BLACK zenith. The
//            blood moon hangs below, so red bleeds up from the horizon.
const SKY_STOPS = {
  midday: [
    [0.00, SLOT1_BONE],
    [1.00, WHITE],
  ],
  golden: [
    [0.00, SLOT6_GOLD],
    [1.00, SLOT7_AMBER_DETONATION],
  ],
  dusk: [
    [0.00, SLOT4_DARK],
    [1.00, SLOT5_AMBER],
  ],
  twilight: [
    [0.00, SLOT4_DARK],
    [0.08, SLOT5_AMBER],   // thin afterglow band near horizon
    [0.30, SLOT4_DARK],    // back to deep dark above the band
    [1.00, BLACK],
  ],
  bloodmoon: [
    [0.00, REAPER_RED],
    [0.40, SLOT4_DARK],
    [1.00, BLACK],
  ],
};

// ── helpers ────────────────────────────────────────────────────────────────
function unpack(hex) {
  return {
    r: (hex >> 16) & 0xff,
    g: (hex >> 8) & 0xff,
    b: hex & 0xff,
  };
}
function lerpByte(a, b, t) {
  return Math.round(a + (b - a) * t);
}
/** Sample a stop list at y∈[0,1]; returns {r,g,b}. */
function sampleStops(stops, y) {
  // Find bracketing stop pair.
  // (stops are pre-sorted ascending by stop_y.)
  if (y <= stops[0][0]) {
    return unpack(stops[0][1]);
  }
  if (y >= stops[stops.length - 1][0]) {
    return unpack(stops[stops.length - 1][1]);
  }
  for (let i = 0; i < stops.length - 1; i++) {
    const [y0, h0] = stops[i];
    const [y1, h1] = stops[i + 1];
    if (y >= y0 && y <= y1) {
      const t = (y - y0) / (y1 - y0);
      const c0 = unpack(h0);
      const c1 = unpack(h1);
      return {
        r: lerpByte(c0.r, c1.r, t),
        g: lerpByte(c0.g, c1.g, t),
        b: lerpByte(c0.b, c1.b, t),
      };
    }
  }
  // unreachable — fall through to last stop
  return unpack(stops[stops.length - 1][1]);
}

/** Render one sky variant to a PNG buffer. */
function renderSky(stops) {
  const png = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++) {
    // Map pixel row to UV.y. We treat y=0 as TOP of the texture in pixel
    // coords but the brief defines UV.y=0 as horizon (bottom). When the
    // shader sampler reads with default `flipY = true` (THREE default) the
    // bottom row of the texture appears at UV.y=0.
    //
    // So: paint pixel row 0 (top of PNG) → UV.y=1 (zenith) → top of stops.
    //     paint pixel row H-1 → UV.y=0 (horizon) → bottom of stops.
    const uvY = 1 - (y + 0.5) / H;
    const c = sampleStops(stops, uvY);
    for (let x = 0; x < W; x++) {
      const px = (y * W + x) * 4;
      png.data[px]     = c.r;
      png.data[px + 1] = c.g;
      png.data[px + 2] = c.b;
      png.data[px + 3] = 255;
    }
  }
  // colorType 2 = RGB (no alpha) for marginally smaller files; deflate 9 for
  // max compression. Vertical gradient + identical-row PNG filtering bring
  // each file to ~1-4 KB.
  return PNG.sync.write(png, { colorType: 2, deflateLevel: 9 });
}

const repoRoot = new URL('../', import.meta.url);
function writeSky(name, stops) {
  const url = new URL(`assets/textures/sky_${name}.png`, repoRoot);
  const buf = renderSky(stops);
  writeFileSync(url, buf);
  console.log(`[gen-sky-textures] wrote sky_${name}.png (${buf.length} bytes)`);
}

writeSky('midday',    SKY_STOPS.midday);
writeSky('golden',    SKY_STOPS.golden);
writeSky('dusk',      SKY_STOPS.dusk);
writeSky('twilight',  SKY_STOPS.twilight);
writeSky('bloodmoon', SKY_STOPS.bloodmoon);

console.log('[gen-sky-textures] all 5 sky textures generated');
