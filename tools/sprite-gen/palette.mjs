/**
 * Palette constants. Authoritative source: docs/SPRITES_VISUAL_STYLE.md +
 * docs/<STAGE>_VISUAL_STYLE.md. Keep in sync.
 *
 * Each palette is keyed by slot number (1-8). Values are [r, g, b] in 0-255.
 * Pure white is intentionally NOT in the neutral palette — only the
 * "peak flash" exception frames may use it (see SPRITES_VISUAL_STYLE §A-A).
 */

/** Stage-agnostic neutral palette (hit-flash, dust, aura, generic FX). */
export const NEUTRAL = Object.freeze({
  slot1: [0x1a, 0x1e, 0x22], // charcoal outline
  slot3: [0x5f, 0x8f, 0xb5], // cool blue mid
  slot8: [0xa8, 0xe6, 0xff], // bright cyan highlight
  white: [0xff, 0xff, 0xff], // peak-flash exception only
});

/** Warm-accent extension authorized in the SPRITES-A1 brief for the
 *  Borgir explosion only. Documented in docs/SPRITE_GEN_PIPELINE.md as
 *  a contract extension awaiting doc-owner sign-off. */
export const WARM = Object.freeze({
  slot6: [0xf5, 0xa3, 0x00], // amber core
  slot7: [0xff, 0xd8, 0x6b], // hot yellow
});

/** Per-stage palettes — placeholder, only NEUTRAL is used by the 4
 *  starter FX sheets. Other stages will hand-fill these from their
 *  *_VISUAL_STYLE.md files when their first FX sheet ships. */
export const FOREST = Object.freeze({});
export const TWILIGHT = Object.freeze({});
export const CINDER = Object.freeze({});
export const VOID = Object.freeze({});

export const PALETTES = Object.freeze({
  neutral: NEUTRAL,
  forest: FOREST,
  twilight: TWILIGHT,
  cinder: CINDER,
  void: VOID,
});
