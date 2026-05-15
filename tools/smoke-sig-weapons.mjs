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
  // Phase D
  sig_cowboy_sixshooter: 'src/weapons/sig/cowboy_sixshooter.js',
  sig_mothman_dustcloak: 'src/weapons/sig/mothman_dustcloak.js',
  sig_space_satellites:  'src/weapons/sig/space_satellites.js',
  // Phase F1
  sig_kitty_lucky_paw:   'src/weapons/sig/kitty_lucky_paw.js',
  sig_sote_warhowl:      'src/weapons/sig/sote_warhowl.js',
  sig_pipes_arcwrench:   'src/weapons/sig/pipes_arcwrench.js',
  sig_bomdia_sunburst:   'src/weapons/sig/bomdia_sunburst.js',
  // Phase F2
  sig_camper_signalfire: 'src/weapons/sig/camper_signalfire.js',
  sig_radcat_fallout:    'src/weapons/sig/radcat_fallout.js',
  sig_mona_brushstroke:  'src/weapons/sig/mona_brushstroke.js',
  // Phase F3
  sig_bezelbug_facet:    'src/weapons/sig/bezelbug_facet.js',
  sig_rocker_powerchord: 'src/weapons/sig/rocker_powerchord.js',
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
for (const fname of ['cowboy_sixshooter', 'mothman_dustcloak', 'space_satellites',
                     'kitty_lucky_paw', 'sote_warhowl', 'pipes_arcwrench', 'bomdia_sunburst',
                     'camper_signalfire', 'radcat_fallout', 'mona_brushstroke',
                     'bezelbug_facet', 'rocker_powerchord']) {
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

// 6: Codex review (2026-05-15) flagged this gap — every sig kit AVATARS
// references MUST be imported AND added to the REGISTRY map in index.js.
// Static regex scan ensures the registration line exists per kit.
for (const id of Object.keys(SIG_FILES)) {
  const camel = id.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const re = new RegExp(`\\[\\s*${camel}\\.id\\s*\\]\\s*:\\s*${camel}`);
  assert.ok(idxSrc.match(re),
    `index.js REGISTRY missing entry for ${id} (expected: [${camel}.id]: ${camel})`);
}
console.log('✓ REGISTRY map populated for every sig kit (Codex 2026-05-15 fix)');

console.log('\nALL CHECKS PASS');
