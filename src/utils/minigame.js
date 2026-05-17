export function bindMinigameEvents(root, onPointerDown, onPointerMove, onPointerUp, onKey, onResize) {
  if (onPointerDown) root.addEventListener('pointerdown', onPointerDown);
  if (onPointerMove) window.addEventListener('pointermove', onPointerMove);
  if (onPointerUp) window.addEventListener('pointerup', onPointerUp);
  if (onKey) window.addEventListener('keydown', onKey);
  if (onResize) window.addEventListener('resize', onResize);
}

export function unbindMinigameEvents(root, onPointerDown, onPointerMove, onPointerUp, onKey, onResize) {
  if (onPointerDown) root.removeEventListener('pointerdown', onPointerDown);
  if (onPointerMove) window.removeEventListener('pointermove', onPointerMove);
  if (onPointerUp) window.removeEventListener('pointerup', onPointerUp);
  if (onKey) window.removeEventListener('keydown', onKey);
  if (onResize) window.removeEventListener('resize', onResize);
}
