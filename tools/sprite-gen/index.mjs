/**
 * Sprite generator entry point. Regenerates all FX sheets sequentially.
 *
 * Usage:
 *   node tools/sprite-gen/index.mjs                  # regenerate all
 *   node tools/sprite-gen/index.mjs --dry-run        # plan, don't write
 *
 * The script is importable: each sheet module exports `generate(outDir)`
 * returning { pngPath, jsonPath }. A future smoke test can drive each
 * generator into a tmpdir and md5-compare against the on-disk fixtures
 * to gate determinism (PIPELINE.md "Determinism gate").
 *
 * Contract: same seeds + same generators → byte-identical PNG + JSON.
 * If a sheet's seed or recipe changes, the version suffix (`_v1` → `_v2`)
 * must bump and the JSON `source` field must update.
 */
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
import * as hitFlash from './sheets/hit_flash.mjs';
import * as dustPuff from './sheets/dust_puff.mjs';
import * as borgir from './sheets/borgir_explosion.mjs';
import * as auraRings from './sheets/aura_rings.mjs';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const OUT_DIR = path.join(REPO_ROOT, 'assets', 'sprites', 'fx');

export const GENERATORS = [
  { name: 'hit_flash_v1',        gen: hitFlash.generate },
  { name: 'dust_puff_v1',        gen: dustPuff.generate },
  { name: 'borgir_explosion_v1', gen: borgir.generate },
  { name: 'aura_rings_v1',       gen: auraRings.generate },
];

export function regenerateAll(outDir = OUT_DIR) {
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const { name, gen } of GENERATORS) {
    const t0 = Date.now();
    const r = gen(outDir);
    const ms = Date.now() - t0;
    const pngSize = fs.statSync(r.pngPath).size;
    results.push({ name, ms, pngSize, ...r });
    console.log(`  ✓ ${name.padEnd(22)} ${ms.toString().padStart(4)}ms  ${pngSize.toString().padStart(6)}B  ${path.relative(REPO_ROOT, r.pngPath)}`);
  }
  return results;
}

// Run when invoked directly (not when imported).
const isMain = url.fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '');
if (isMain) {
  const dry = process.argv.includes('--dry-run');
  if (dry) {
    console.log('[sprite-gen] dry-run — would regenerate:');
    for (const { name } of GENERATORS) console.log(`  - ${name}`);
    process.exit(0);
  }
  console.log(`[sprite-gen] regenerating into ${path.relative(REPO_ROOT, OUT_DIR)}/`);
  const results = regenerateAll();
  console.log(`[sprite-gen] done — ${results.length} sheets written`);
}
