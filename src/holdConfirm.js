/**
 * PHASE 4 P4H (#142) — Hold-to-confirm accessibility helper.
 *
 * Wraps a DOM button so that, when meta.optHoldConfirm is true, the user
 * must hold pointerdown for `holdMs` ms before the action fires. When the
 * option is off, behaves exactly as a normal click.
 *
 * Visual feedback: an amber progress fill (forest 8-color palette) drains
 * left→right across the button's bottom edge while held. Releasing early
 * cancels and the fill resets.
 *
 * Pointer events (not click) are used so this works for both mouse and
 * touch input. The RAF loop is self-gating per
 * [[feedback_kks_wave_dispatcher_throttle.md]] — `rafId` is nulled on
 * release so the next frame check bails before scheduling more work.
 *
 * Public API:
 *   holdConfirm(button, onConfirm, opts = {})
 *
 * opts:
 *   holdMs:    number, default 600. Duration of the hold gate.
 *   palette:   { fill, trough }. Defaults to amber-on-dark from the forest
 *              8-color palette. Override per call if a button needs a
 *              different accent (e.g. red for catastrophic actions).
 *
 * Returns the button (for fluent chaining).
 *
 * Implementation notes:
 *   - We attach a wrapper `<span>` to the button via position:relative so the
 *     progress fill can be absolutely positioned. If the button already has
 *     `position` set we honor it; otherwise we set 'relative'.
 *   - When meta.optHoldConfirm flips at runtime (user toggled it in Options
 *     while the panel was open), the next pointerdown rechecks getMeta().
 *     We don't snapshot the value at attach time.
 *   - The handler always calls e.preventDefault() on pointerdown so a long
 *     press doesn't trigger native text-selection / context menu on touch.
 *   - We do NOT replace the existing click listener — the caller passes
 *     `onConfirm` which we wire either to click (when opt is off) or to a
 *     successful hold (when opt is on). The caller MUST NOT have already
 *     bound a click listener for this action — call holdConfirm() instead.
 */
import { getMeta } from './meta.js';

const DEFAULT_HOLD_MS = 600;

// Forest 8-color palette accents — amber fill on dark trough matches the
// existing menu button hover state. Caller may override via opts.palette.
const DEFAULT_PALETTE = {
  fill:   '#ffd27f',   // C.amber
  trough: 'rgba(8,14,12,0.65)',
};

export function holdConfirm(button, onConfirm, opts = {}) {
  if (!button || typeof onConfirm !== 'function') return button;
  const holdMs = Number.isFinite(opts.holdMs) ? opts.holdMs : DEFAULT_HOLD_MS;
  const palette = { ...DEFAULT_PALETTE, ...(opts.palette || {}) };

  // ── Progress fill DOM ──
  // We build a thin band at the bottom of the button. It only becomes
  // visible while a hold is in flight; otherwise width=0 and the trough is
  // invisible (transparent default).
  // Caller's button must accept absolute children — we set position:relative
  // if it's not already positioned.
  const cs = (typeof getComputedStyle === 'function' && button.nodeType === 1)
    ? getComputedStyle(button) : null;
  if (cs && cs.position === 'static') {
    button.style.position = 'relative';
  }
  // Honor overflow:visible so the fill isn't clipped if the button has a
  // border-radius — visually nicer to clip to the button bounds.
  if (!button.style.overflow) button.style.overflow = 'hidden';

  const fill = document.createElement('span');
  fill.setAttribute('aria-hidden', 'true');
  fill.style.cssText = `
    position: absolute; left: 0; bottom: 0;
    height: 3px; width: 0%;
    background: ${palette.fill};
    transition: none;
    pointer-events: none;
    box-shadow: 0 0 6px ${palette.fill};
  `;
  button.appendChild(fill);

  // ── State ──
  // rafId === null when no hold is in progress. Self-gating per
  // feedback_kks_wave_dispatcher_throttle.md — RAF callback checks rafId
  // at entry and bails immediately if cleared.
  let rafId = null;
  let startTs = 0;

  function reset() {
    if (rafId != null) {
      try { cancelAnimationFrame(rafId); } catch (_) {}
    }
    rafId = null;
    fill.style.width = '0%';
  }

  function tick() {
    // Self-gate: if reset() nulled rafId, bail before scheduling more work.
    if (rafId == null) return;
    const elapsed = (typeof performance !== 'undefined' && performance.now)
      ? performance.now() - startTs
      : Date.now() - startTs;
    const pct = Math.min(100, (elapsed / holdMs) * 100);
    fill.style.width = pct + '%';
    if (elapsed >= holdMs) {
      // Confirm fires. Clear state THEN call onConfirm so any side-effects
      // (modal teardown, page reload) don't race with our RAF.
      reset();
      try { onConfirm(); } catch (e) { console.warn('[holdConfirm] onConfirm threw:', e); }
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  function onPointerDown(e) {
    // Only react to primary button on mouse. Touch + pen pass through.
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const meta = getMeta();
    if (!meta || !meta.optHoldConfirm) {
      // Pass-through: act like a normal click. Fire onConfirm immediately.
      // We still preventDefault so the native click->dblclick chain doesn't
      // also fire later.
      e.preventDefault();
      try { onConfirm(); } catch (err) { console.warn('[holdConfirm] onConfirm threw:', err); }
      return;
    }
    // Hold path. Block native text-selection / context-menu, start the RAF.
    e.preventDefault();
    if (rafId != null) reset();
    startTs = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
    rafId = requestAnimationFrame(tick);
  }

  function onCancel() {
    if (rafId != null) reset();
  }

  // pointerdown is the trigger; pointerup / pointerleave / pointercancel all
  // abort. We attach all release events to the BUTTON not the window so a
  // hold that drags off the button cancels cleanly.
  button.addEventListener('pointerdown',   onPointerDown);
  button.addEventListener('pointerup',     onCancel);
  button.addEventListener('pointerleave',  onCancel);
  button.addEventListener('pointercancel', onCancel);
  // Keyboard activation (Enter/Space) doesn't go through pointer events; we
  // intentionally route it via the standard click pathway so screen-reader
  // users aren't forced to hold. Add a click fallback that fires only when
  // optHoldConfirm is off OR when the activation source is keyboard. The
  // 'detail' property === 0 for keyboard-triggered clicks.
  button.addEventListener('click', (e) => {
    const meta = getMeta();
    if (!meta || !meta.optHoldConfirm) return; // pointerdown already fired it
    if (e.detail === 0) {
      // Keyboard activation while hold is enabled — let it through directly.
      try { onConfirm(); } catch (err) { console.warn('[holdConfirm] onConfirm threw:', err); }
    } else {
      // Mouse/touch click — already handled by pointerdown path. Suppress
      // duplicate fire.
      e.preventDefault();
      e.stopPropagation();
    }
  });

  return button;
}
