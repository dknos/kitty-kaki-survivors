/**
 * Cached loader for hand-painted FX textures (iter 33w).
 *
 * Replaces the runtime-canvas-drawn rings/glyphs with pre-baked, hand-painted
 * art from Vertex Imagen 4. All entries live in assets/fx/MANIFEST.json and
 * are loaded on demand; the first fxTex() call for a name kicks off a fetch
 * and returns the THREE.Texture immediately so callers can hand it to a
 * MeshBasicMaterial without awaiting — the texture starts as a 1×1 black
 * pixel and re-uploads when the image lands.
 *
 * Black is the implicit alpha for additive blending: the manifest sets the
 * default blend mode per texture (mostly additive), so the black bg of every
 * WebP simply contributes nothing to the floor.
 */
import * as THREE from 'three';

const MANIFEST_URL = 'assets/fx/MANIFEST.json';
const BASE = 'assets/fx/';

let _manifest = null;
const _cache = new Map();   // name -> THREE.Texture (cached, returned synchronously)
const _loader = new THREE.TextureLoader();

let _manifestPromise = null;

function _ensureManifest() {
  if (_manifest) return Promise.resolve(_manifest);
  if (!_manifestPromise) {
    _manifestPromise = fetch(MANIFEST_URL)
      .then((r) => r.json())
      .then((j) => { _manifest = j; return j; })
      .catch((e) => {
        console.warn('[fxTextures] manifest load failed:', e);
        _manifest = { textures: {} };
        return _manifest;
      });
  }
  return _manifestPromise;
}

// Eager-prime the manifest in the background so meta lookups don't stall.
_ensureManifest();

/**
 * Return a cached THREE.Texture for the manifest entry `name`.
 *
 * The first call kicks off the underlying WebP fetch and returns a texture
 * with a 1×1 black placeholder image; the texture mutates in place when the
 * fetch completes (TextureLoader sets `.image` and flips `.needsUpdate`).
 * Subsequent calls return the same cached instance — geometries share it.
 *
 * Returns null if the manifest hasn't loaded yet *or* the name isn't known.
 * Callers should treat null as "fall back to legacy canvas tex".
 */
export function fxTex(name) {
  const cached = _cache.get(name);
  if (cached) return cached;
  if (!_manifest) return null;
  const entry = _manifest.textures && _manifest.textures[name];
  if (!entry) return null;
  const tex = _loader.load(BASE + entry.file);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  _cache.set(name, tex);
  return tex;
}

/** Metadata block for the manifest entry (size, blend, tier, etc.). */
export function fxMeta(name) {
  if (!_manifest) return null;
  return (_manifest.textures && _manifest.textures[name]) || null;
}

/** Floor-layer tier integer (see MANIFEST `_floor_tiers`). */
export function fxTier(tierName) {
  if (!_manifest || !_manifest._floor_tiers) {
    const fallback = { shadow: -10, kill_pickup: -5, portal: -4, telegraph: -3, boss_tell: -2 };
    return fallback[tierName] != null ? fallback[tierName] : 0;
  }
  return _manifest._floor_tiers[tierName] != null ? _manifest._floor_tiers[tierName] : 0;
}

/** Force the manifest fetch to settle — only needed by tests / debug pages. */
export function fxAwait() { return _ensureManifest(); }
