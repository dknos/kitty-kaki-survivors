/**
 * Sprite system public surface.
 *
 * Init order (called from main.js bootstrap):
 *   1. await loadAtlas(id, jsonUrl)  — for every atlas you want
 *   2. ensurePool(scene, id)         — once scene exists
 *   3. setLowFxProbe(() => state.run.lowFx)  — for kill-switch wiring
 *   4. spawnSprite(id, {...})        — from FX/combat code
 *   5. tickSpriteSystem(dt)          — once per frame from main loop
 *   6. disposeSpritePools() + disposeAtlases() — on full teardown
 *
 * Contract locked in docs/SPRITES_VISUAL_STYLE.md (v1).
 */
export { loadAtlas, getAtlas, listAtlasIds, disposeAtlases } from './spriteAtlas.js';
export {
  ensurePool,
  spawnSprite,
  moveSprite,
  killSprite,
  tickSpriteSystem,
  disposeSpritePools,
  setLowFxProbe,
} from './spritePool.js';
export { attachSprite, setAnim, detachSprite, tickAttachedSprites, _resetSpriteAnimator } from './spriteAnimator.js';
