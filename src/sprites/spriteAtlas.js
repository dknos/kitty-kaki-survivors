/**
 * Atlas loader for the sprite system. Pure async loader — fetches the JSON
 * descriptor, fetches the PNG (via THREE.TextureLoader), wires NearestFilter
 * so pixels stay crunchy under upscale, returns a registered atlas record
 * that spritePool keys off of.
 *
 * Schema is locked in docs/SPRITES_VISUAL_STYLE.md (v1). Loader rejects on
 * schema mismatch — silent acceptance would let agents drift the contract.
 */
import * as THREE from 'three';

const _atlases = new Map(); // id → atlasRecord

/**
 * @typedef AtlasRecord
 * @property {string}   id
 * @property {string}   imageUrl
 * @property {number}   frameWidth
 * @property {number}   frameHeight
 * @property {number}   cols
 * @property {number}   rows
 * @property {number}   frameCount
 * @property {number}   pixelsPerWorldUnit
 * @property {[number,number]} anchor
 * @property {'alpha'|'additive'} blendMode
 * @property {boolean}  bloom
 * @property {'screen'|'cylinder'|'none'} billboard
 * @property {Record<string,{from:number,to:number,fps:number,loop:boolean}>} anims
 * @property {string}   palette
 * @property {THREE.Texture|null} texture
 */

/**
 * Load an atlas JSON descriptor + its PNG. Returns the registered atlas
 * record. Subsequent calls with the same id short-circuit (cached).
 *
 * @param {string} id  Stable id like 'fx/hit_flash_v1'
 * @param {string} jsonUrl  e.g. 'assets/sprites/fx/hit_flash_v1.json'
 */
export async function loadAtlas(id, jsonUrl) {
  if (_atlases.has(id)) return _atlases.get(id);
  const resp = await fetch(jsonUrl);
  if (!resp.ok) throw new Error(`[spriteAtlas] fetch failed: ${jsonUrl} (${resp.status})`);
  const json = await resp.json();
  _validateSchema(jsonUrl, json);

  // Image path resolves relative to the JSON file's directory.
  const base = jsonUrl.replace(/\/[^/]+$/, '/');
  const imageUrl = base + json.image;

  const texture = await new Promise((res, rej) => {
    new THREE.TextureLoader().load(imageUrl, res, undefined, rej);
  });
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;

  const record = {
    id,
    imageUrl,
    frameWidth: json.frameWidth,
    frameHeight: json.frameHeight,
    cols: json.cols,
    rows: json.rows,
    frameCount: json.frameCount,
    pixelsPerWorldUnit: json.pixelsPerWorldUnit ?? 24,
    anchor: json.anchor ?? [0.5, 0.5],
    blendMode: json.blendMode ?? 'alpha',
    bloom: !!json.bloom,
    billboard: json.billboard ?? 'screen',
    anims: json.anims ?? { default: { from: 0, to: json.frameCount - 1, fps: 12, loop: false } },
    palette: json.palette ?? 'neutral',
    texture,
  };
  _atlases.set(id, record);
  return record;
}

export function getAtlas(id) {
  return _atlases.get(id) ?? null;
}

export function listAtlasIds() {
  return Array.from(_atlases.keys());
}

export function disposeAtlases() {
  for (const a of _atlases.values()) {
    if (a.texture && a.texture.dispose) a.texture.dispose();
  }
  _atlases.clear();
}

function _validateSchema(jsonUrl, j) {
  const fail = (msg) => { throw new Error(`[spriteAtlas] ${jsonUrl}: ${msg}`); };
  if (j.version !== 1) fail(`unsupported version ${j.version} (expected 1)`);
  if (typeof j.image !== 'string') fail('missing "image"');
  for (const k of ['frameWidth', 'frameHeight', 'cols', 'rows', 'frameCount']) {
    if (!Number.isFinite(j[k]) || j[k] <= 0) fail(`bad/missing "${k}"`);
  }
  if (j.frameCount > j.cols * j.rows) fail(`frameCount (${j.frameCount}) > cols*rows (${j.cols * j.rows})`);
  if (j.blendMode && !['alpha', 'additive'].includes(j.blendMode)) fail(`bad blendMode "${j.blendMode}"`);
  if (j.billboard && !['screen', 'cylinder', 'none'].includes(j.billboard)) fail(`bad billboard "${j.billboard}"`);
  if (j.anims) {
    for (const [name, a] of Object.entries(j.anims)) {
      if (!Number.isFinite(a.from) || !Number.isFinite(a.to) || !Number.isFinite(a.fps)) {
        fail(`anim "${name}" missing from/to/fps`);
      }
      if (a.from < 0 || a.to >= j.frameCount || a.from > a.to) {
        fail(`anim "${name}" range [${a.from}..${a.to}] out of bounds (frameCount=${j.frameCount})`);
      }
    }
  }
}
