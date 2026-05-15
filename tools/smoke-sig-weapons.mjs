// Phase D smoke: static inspection of the 3 sig weapon modules. No game
// module graph imported (avoids the three/addons stub rabbit-hole). Uses
// regex on source text to verify the contract laid out in
// docs/PROGRESSION_REDESIGN.md §5.D.
//
// What we assert:
//   1. Each sig file exists with a `id: 'sig_<name>'` default export.
//   2. Each sig has 8 level entries (maxLevel + array length).
//   3. Each sig is imported AND registered in weapons/index.js.
//   4. Each sig has a descriptions.js entry.
//   5. AVATARS[].signatureWeapon references match the kit ids.
//
// Run: node tools/smoke-sig-weapons.mjs
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const SIG_FILES = {
  sig_cowboy_sixshooter: 'src/weapons/sig/cowboy_sixshooter.js',
  sig_mothman_dustcloak: 'src/weapons/sig/mothman_dustcloak.js',
  sig_space_satellites:  'src/weapons/sig/space_satellites.js',
};
const REPO = new URL('../', import.meta.url);
function read(rel) { return readFileSync(new URL(rel, REPO), 'utf8'); }

// 1+2: each sig file
for (const [id, rel] of Object.entries(SIG_FILES)) {
  const src = read(rel);
  assert.ok(src.includes(`id: '${id}'`), `${rel}: id literal '${id}' not found`);
  assert.ok(src.match(/maxLevel:\s*8/), `${rel}: maxLevel: 8 not found`);
  // Count level objects — opening braces inside a `levels: [ ... ]` block.
  // Crude but stable: look for the levels array and count `{ cooldown:` or
  // similar shape markers. We assert ≥ 8 occurrences.
  const levelsBlock = src.match(/levels:\s*\[(.*?)\]/s);
  assert.ok(levelsBlock, `${rel}: levels: [ ... ] block missing`);
  const objCount = (levelsBlock[1].match(/\{[^{}]*\}/g) || []).length;
  assert.equal(objCount, 8, `${rel}: expected 8 level entries, got ${objCount}`);
  assert.ok(src.match(/\bexport default\b/), `${rel}: default export missing`);
  assert.ok(src.match(/\btick\b\s*\(/), `${rel}: tick() function missing`);
  console.log(`✓ ${id}: 8 levels, default export, tick()`);
}

// 3: REGISTRY wire-up
const idxSrc = read('src/weapons/index.js');
for (const fname of ['cowboy_sixshooter', 'mothman_dustcloak', 'space_satellites']) {
  assert.ok(idxSrc.includes(`./sig/${fname}.js`),  `index.js missing import ./sig/${fname}.js`);
}
for (const id of Object.keys(SIG_FILES)) {
  // index.js maps registry entries via the imported module's `.id` field, e.g.
  // `[sigCowboySixshooter.id]: sigCowboySixshooter,`. Confirm a binding exists.
  const camel = id.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  assert.ok(idxSrc.match(new RegExp(`\\[\\s*${camel}\\.id\\s*\\]`)),
    `index.js REGISTRY binding for ${id} (expected key: [${camel}.id]) missing`);
}
console.log('✓ weapons/index.js imports + REGISTRY bindings');

// 4: descriptions.js entries
const descSrc = read('src/weapons/descriptions.js');
for (const id of Object.keys(SIG_FILES)) {
  assert.ok(descSrc.match(new RegExp(`${id}:\\s*\\{`)),
    `descriptions.js missing entry for ${id}`);
}
console.log('✓ descriptions.js entries');

// 5: AVATARS signatureWeapon references
const cfgSrc = read('src/config.js');
for (const id of Object.keys(SIG_FILES)) {
  assert.ok(cfgSrc.includes(`signatureWeapon: '${id}'`),
    `config.js: no AVATARS entry references signatureWeapon '${id}'`);
}
console.log('✓ AVATARS.signatureWeapon ↔ kit id bindings');

console.log('\nALL CHECKS PASS');
