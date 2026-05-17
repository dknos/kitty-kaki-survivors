// Smoke harness for the sprite-FX system (Phase Sprites foundation).
// Verifies:
//   1. src/sprites/spritePool.js   contract via static text-grep
//   2. src/sprites/spriteAtlas.js  contract via static text-grep
//   3. src/sprites/index.js        public surface re-exports
//   4. src/main.js                 wires tickSpriteSystem + setSpriteLowFxProbe
//   5. assets/sprites/**/*.json    schema validation (skips cleanly if none yet)
//   6. existence of docs + sprite source files
//
// Mirrors the pattern of tools/smoke-sig-weapons.mjs (static text-grep, no
// runtime import of src/sprites/* — three.js ShaderMaterial / InstancedBufferAttribute
// don't play well with the test stub). Atlas validation is JSON-schema only.
//
// Run: node tools/smoke-sprite-fx.mjs   (no flags)
// Spec: docs/SPRITES_VISUAL_STYLE.md §Smoke test contract.

import { strict as assert } from 'node:assert';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const REPO = new URL('../', import.meta.url);
const REPO_PATH = new URL('../', import.meta.url).pathname;
function read(rel)   { return readFileSync(new URL(rel, REPO), 'utf8'); }
function exists(rel) { return existsSync(new URL(rel, REPO)); }

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log(`[OK] ${msg}`); }
function bad(msg, err) {
  fail++;
  console.error(`[FAIL] ${msg}${err ? ` — ${err.message || err}` : ''}`);
}
function check(msg, fn) {
  try { fn(); ok(msg); } catch (e) { bad(msg, e); }
}

// ── §6 existence checks (run first — everything below assumes the files load) ─
const REQUIRED_FILES = [
  'docs/SPRITES_VISUAL_STYLE.md',
  'src/sprites/spritePool.js',
  'src/sprites/spriteAtlas.js',
  'src/sprites/spriteAnimator.js',
  'src/sprites/index.js',
  'src/main.js',
];
for (const rel of REQUIRED_FILES) {
  check(`exists: ${rel}`, () => assert.ok(exists(rel), `missing: ${rel}`));
}

// If any required file is missing, bail before grepping non-existent files.
if (fail > 0) {
  console.error(`\nFAIL: ${fail} required file(s) missing — aborting deeper checks.`);
  console.error(`pass=${pass} fail=${fail}`);
  process.exit(1);
}

// ── §1 spritePool.js source contract ─────────────────────────────────────────
const poolSrc = read('src/sprites/spritePool.js');

check(`spritePool imports THREE from 'three'`, () => {
  assert.ok(/from\s+['"]three['"]/.test(poolSrc), `no \`from 'three'\` import found`);
});
for (const sym of [
  'spawnSprite',
  'tickSpriteSystem',
  'disposeSpritePools',
  'ensurePool',
  'moveSprite',
  'killSprite',
  'setLowFxProbe',
]) {
  check(`spritePool exports ${sym}`, () => {
    // matches `export function NAME` or `export { ... NAME ... }` or `export const NAME`
    const re = new RegExp(
      `export\\s+(?:async\\s+)?(?:function|const|let|var|class)\\s+${sym}\\b` +
      `|export\\s*\\{[^}]*\\b${sym}\\b[^}]*\\}`,
    );
    assert.ok(re.test(poolSrc), `no export of ${sym}`);
  });
}
check(`spritePool references NearestFilter`, () => {
  assert.ok(/\bNearestFilter\b/.test(poolSrc), 'NearestFilter not referenced');
});
check(`spritePool references DynamicDrawUsage`, () => {
  assert.ok(/\bDynamicDrawUsage\b/.test(poolSrc), 'DynamicDrawUsage not referenced');
});
check(`spritePool references InstancedBufferAttribute`, () => {
  assert.ok(/\bInstancedBufferAttribute\b/.test(poolSrc), 'InstancedBufferAttribute not referenced');
});
check(`spritePool references BLOOM_LAYER (from ../postfx.js)`, () => {
  assert.ok(/\bBLOOM_LAYER\b/.test(poolSrc), 'BLOOM_LAYER not referenced');
  assert.ok(/from\s+['"]\.\.\/postfx(?:\.js)?['"]/.test(poolSrc),
    `BLOOM_LAYER must come from '../postfx.js'`);
});
check(`spritePool instantiates a ShaderMaterial`, () => {
  assert.ok(/new\s+(?:THREE\.)?ShaderMaterial\b/.test(poolSrc),
    'no `new ShaderMaterial(...)` found');
});
check(`spritePool defines _VS (vertex shader) string constant`, () => {
  assert.ok(/\b(?:const|let|var)\s+_VS\b/.test(poolSrc), '_VS constant not declared');
});
check(`spritePool defines _FS (fragment shader) string constant`, () => {
  assert.ok(/\b(?:const|let|var)\s+_FS\b/.test(poolSrc), '_FS constant not declared');
});

// ── §2 spriteAtlas.js source contract ────────────────────────────────────────
const atlasSrc = read('src/sprites/spriteAtlas.js');

for (const sym of ['loadAtlas', 'getAtlas', 'disposeAtlases']) {
  check(`spriteAtlas exports ${sym}`, () => {
    const re = new RegExp(
      `export\\s+(?:async\\s+)?(?:function|const|let|var|class)\\s+${sym}\\b` +
      `|export\\s*\\{[^}]*\\b${sym}\\b[^}]*\\}`,
    );
    assert.ok(re.test(atlasSrc), `no export of ${sym}`);
  });
}
check(`spriteAtlas has _validateSchema function`, () => {
  assert.ok(/\bfunction\s+_validateSchema\b/.test(atlasSrc)
    || /\b_validateSchema\s*=\s*(?:function|\()/.test(atlasSrc),
    '_validateSchema not declared');
});
check(`spriteAtlas references NearestFilter`, () => {
  assert.ok(/\bNearestFilter\b/.test(atlasSrc), 'NearestFilter not referenced');
});
check(`spriteAtlas references SRGBColorSpace`, () => {
  assert.ok(/\bSRGBColorSpace\b/.test(atlasSrc), 'SRGBColorSpace not referenced');
});

// ── §3 index.js public surface ───────────────────────────────────────────────
const indexSrc = read('src/sprites/index.js');
for (const sym of ['tickSpriteSystem', 'spawnSprite', 'loadAtlas', 'ensurePool']) {
  check(`sprites/index.js re-exports ${sym}`, () => {
    // Either listed inside a re-export `export { ... NAME ... } from '...'`
    // or a forwarded named export elsewhere.
    const re = new RegExp(`export\\s*\\{[^}]*\\b${sym}\\b[^}]*\\}\\s*from`);
    assert.ok(re.test(indexSrc), `no re-export of ${sym}`);
  });
}

// ── §4 main.js wiring ────────────────────────────────────────────────────────
const mainSrc = read('src/main.js');

check(`main.js imports tickSpriteSystem from ./sprites/index.js`, () => {
  const re = /import\s*\{[^}]*\btickSpriteSystem\b[^}]*\}\s*from\s*['"]\.\/sprites\/index(?:\.js)?['"]/;
  assert.ok(re.test(mainSrc), 'tickSpriteSystem import from ./sprites/index.js not found');
});
check(`main.js imports setLowFxProbe as setSpriteLowFxProbe from ./sprites/index.js`, () => {
  const re = /import\s*\{[^}]*\bsetLowFxProbe\s+as\s+setSpriteLowFxProbe\b[^}]*\}\s*from\s*['"]\.\/sprites\/index(?:\.js)?['"]/;
  assert.ok(re.test(mainSrc),
    'aliased import `setLowFxProbe as setSpriteLowFxProbe` from ./sprites/index.js not found');
});
check(`main.js calls tickSpriteSystem(logicDt) in the tick loop`, () => {
  assert.ok(/\btickSpriteSystem\s*\(\s*logicDt\s*\)/.test(mainSrc),
    'no tickSpriteSystem(logicDt) call found');
});
check(`main.js calls setSpriteLowFxProbe(...) in bootstrap`, () => {
  assert.ok(/\bsetSpriteLowFxProbe\s*\(/.test(mainSrc),
    'no setSpriteLowFxProbe(...) call found');
});

// ── §5 atlas JSON schema validation ──────────────────────────────────────────
const SPRITES_DIR = new URL('../assets/sprites/', import.meta.url);
const SPRITES_PATH = SPRITES_DIR.pathname;

function walkJson(dirAbs, out = []) {
  if (!existsSync(dirAbs)) return out;
  for (const name of readdirSync(dirAbs)) {
    const full = join(dirAbs, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walkJson(full, out);
    else if (st.isFile() && name.toLowerCase().endsWith('.json')) out.push(full);
  }
  return out;
}

const VALID_BLEND      = new Set(['alpha', 'additive']);
const VALID_BILLBOARD  = new Set(['screen', 'cylinder', 'none']);
const REQUIRED_FIELDS  = ['image', 'frameWidth', 'frameHeight', 'cols', 'rows', 'frameCount'];

const atlasJsons = walkJson(SPRITES_PATH);
if (atlasJsons.length === 0) {
  // Pipeline agent hasn't shipped sheets yet — skip cleanly per spec.
  console.log('[SKIP] no atlas JSON files under assets/sprites/ — skipping atlas validation');
  console.log('       (presence asserted in a future test once #98/#99 ship)');
} else {
  console.log(`[INFO] found ${atlasJsons.length} atlas JSON file(s) under assets/sprites/`);
  for (const full of atlasJsons) {
    const rel = relative(REPO_PATH, full);

    let json;
    check(`${rel}: parses as JSON`, () => {
      const raw = readFileSync(full, 'utf8');
      json = JSON.parse(raw);
    });
    if (!json) continue;  // parse failed — skip downstream checks

    check(`${rel}: version === 1`, () => assert.equal(json.version, 1, `version must be 1`));

    for (const f of REQUIRED_FIELDS) {
      check(`${rel}: has required field "${f}"`, () => {
        assert.ok(Object.prototype.hasOwnProperty.call(json, f),
          `missing required field "${f}"`);
      });
    }

    check(`${rel}: frameCount <= cols * rows`, () => {
      assert.ok(typeof json.cols === 'number' && typeof json.rows === 'number'
        && typeof json.frameCount === 'number',
        'cols/rows/frameCount must be numbers');
      assert.ok(json.frameCount <= json.cols * json.rows,
        `frameCount ${json.frameCount} > cols*rows ${json.cols * json.rows}`);
    });

    check(`${rel}: sibling image file exists`, () => {
      assert.ok(typeof json.image === 'string' && json.image.length > 0,
        'image field must be a non-empty string');
      const sibling = join(dirname(full), json.image);
      assert.ok(existsSync(sibling), `sibling image not on disk: ${json.image}`);
    });

    if (Object.prototype.hasOwnProperty.call(json, 'blendMode')) {
      check(`${rel}: blendMode is alpha|additive`, () => {
        assert.ok(VALID_BLEND.has(json.blendMode),
          `blendMode "${json.blendMode}" must be one of alpha|additive`);
      });
    }
    if (Object.prototype.hasOwnProperty.call(json, 'billboard')) {
      check(`${rel}: billboard is screen|cylinder|none`, () => {
        assert.ok(VALID_BILLBOARD.has(json.billboard),
          `billboard "${json.billboard}" must be one of screen|cylinder|none`);
      });
    }

    if (json.anims && typeof json.anims === 'object') {
      for (const [name, a] of Object.entries(json.anims)) {
        check(`${rel}: anim "${name}" — from/to/fps valid`, () => {
          assert.ok(a && typeof a === 'object', `anim "${name}" must be an object`);
          assert.ok(typeof a.from === 'number' && a.from >= 0,
            `anim "${name}".from must be >= 0`);
          assert.ok(typeof a.to === 'number' && a.to < json.frameCount,
            `anim "${name}".to (${a.to}) must be < frameCount (${json.frameCount})`);
          assert.ok(a.from <= a.to, `anim "${name}".from (${a.from}) > to (${a.to})`);
          assert.ok(typeof a.fps === 'number' && a.fps > 0,
            `anim "${name}".fps must be > 0`);
        });
      }
    }
  }
}

// ── tally + exit ─────────────────────────────────────────────────────────────
console.log(`\npass=${pass} fail=${fail}`);
if (fail > 0) {
  console.error('FAIL');
  process.exit(1);
}
console.log('ALL CHECKS PASS');
