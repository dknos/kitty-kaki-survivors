/**
 * spriteAnimator.js — thin per-entity attach helper for mob sprites.
 *
 * spritePool handles fire-and-forget FX (one-shot bursts). Mob sprites
 * need a different lifetime: they're tied to an entity that moves and
 * may switch animations (idle → attack → death). This module owns that
 * mapping.
 *
 * Pattern: each entity that wants a sprite gets a small `spriteHandle`
 * stored on the entity. Caller drives x/y/z, anim transitions, and end
 * (despawn). Handle stores a pool slot — the slot may be evicted under
 * recycle pressure, in which case the handle quietly no-ops on update.
 */
import { getAtlas } from './spriteAtlas.js';
import { spawnSprite } from './spritePool.js';

const _handles = new Set();

/**
 * Attach a sprite to an entity.
 *
 * @param {object} ent           the entity (typically an enemy/projectile object)
 * @param {string} atlasId
 * @param {object} [opts]
 * @param {number} [opts.scale=1]
 * @param {string} [opts.anim='idle']  initial anim name (falls back to 'default')
 */
export function attachSprite(ent, atlasId, opts = {}) {
  const atlas = getAtlas(atlasId);
  if (!atlas) return null;
  const handle = {
    ent,
    atlasId,
    scale: opts.scale ?? 1,
    currentAnim: opts.anim ?? 'idle',
    slot: -1, // assigned on first update tick
  };
  handle.slot = spawnSprite(atlasId, {
    x: ent.x ?? ent.position?.x ?? 0,
    y: ent.y ?? ent.position?.y ?? 0,
    z: ent.z ?? ent.position?.z ?? 0,
    scale: handle.scale,
    anim: handle.currentAnim in atlas.anims ? handle.currentAnim : 'default',
  });
  ent.spriteHandle = handle;
  _handles.add(handle);
  return handle;
}

/**
 * Switch the entity's animation. Re-spawn at current position with new anim
 * (the previous slot's anim finishes / dies naturally).
 */
export function setAnim(handle, animName) {
  if (!handle || handle.currentAnim === animName) return;
  const atlas = getAtlas(handle.atlasId);
  if (!atlas || !(animName in atlas.anims)) return;
  handle.currentAnim = animName;
  const ent = handle.ent;
  handle.slot = spawnSprite(handle.atlasId, {
    x: ent.x ?? ent.position?.x ?? 0,
    y: ent.y ?? ent.position?.y ?? 0,
    z: ent.z ?? ent.position?.z ?? 0,
    scale: handle.scale,
    anim: animName,
  });
}

/**
 * Detach the sprite. Caller is responsible for calling this when the entity
 * dies. After this call, no further updates affect the slot — it will die
 * naturally when its anim completes (one-shot) or be recycled (loop).
 */
export function detachSprite(handle) {
  if (!handle) return;
  _handles.delete(handle);
  if (handle.ent) handle.ent.spriteHandle = null;
}

/**
 * Tick every attached sprite — write current entity position into the pool
 * matrix at the handle's slot. Call ONCE per frame from main.js AFTER
 * entity x/y/z have been updated, BEFORE tickSpriteSystem.
 */
export function tickAttachedSprites(spritePoolMap /* unused — left for future per-atlas dispatch */) {
  for (const h of _handles) {
    const ent = h.ent;
    if (!ent || ent.dead) continue;
    // Re-spawn into the existing slot would be wrong (it would reset anim).
    // Instead, we'd need a direct pool write API. For now, mob sprites
    // re-spawn-on-anim-change and rely on movement being applied via a
    // setMatrixAt call in the pool. Phase 1 (FX-only) doesn't exercise
    // this — phase 2 (Glowmoth) will swap to an explicit pool API.
  }
}

/**
 * Reset the registry (test/teardown helper).
 */
export function _resetSpriteAnimator() {
  _handles.clear();
}
