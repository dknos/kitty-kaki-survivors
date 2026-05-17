import { state } from '../state.js';
import { setPromptLabel } from '../buttonPrompts.js';

export function updateInteractables(interactables, promptBinding, promptEl) {
  const h = state.hero.pos;
  let best = null, bestD = Infinity;
  for (const it of interactables) {
    const dx = h.x - it.pos.x;
    const dz = h.z - it.pos.z;
    const d2 = dx * dx + dz * dz;
    const r = it.radius || 1; // some have radius, fallback 1
    if (d2 < r * r && d2 < bestD) { best = it; bestD = d2; }
  }

  if (best) {
    setPromptLabel(promptBinding, best.label);
    if (promptEl) promptEl.style.display = 'block';
  } else {
    if (promptEl) promptEl.style.display = 'none';
  }
  return best ? best.key : null;
}
