# Palette Audit — 2026-05-16

Backlog item **D1**: verify every stage interactable module + the shared FX
module strictly adheres to its locked 8-color palette
(`docs/<STAGE>_VISUAL_STYLE.md`).

**Result: ZERO drift.** Every non-trivial hex literal in scope resolves
either to a locked palette slot, to an allowed convention (inactive
`0x000000`, neutral-tint `0xffffff` for InstancedMesh `instanceColor`), or
to a non-color hash/seed constant. No fixes applied to source files.

Auditor: palette-audit subagent (Claude Opus 4.7 1M).
Branch: `swarm/palette-audit`.

## Audit method

1. Extract palette slots from each `docs/<STAGE>_VISUAL_STYLE.md` table.
2. `grep -oE '0x[0-9a-fA-F]{6}'` each module; sort/uniq the literals.
3. For each literal:
   - Membership in the locked palette set → ✅
   - `0x000000` (inactive emissive) → ✅ (allowed convention)
   - `0xffffff` (neutral tint for per-instance color override) → ✅ (allowed
     convention; flagged as ⚠️ once for visibility)
   - Substring of an 8-digit RNG/hash constant (e.g. `0x6D2B79F5`) → N/A
   - RNG seed constant (e.g. `0xC0FFEE`, `0xBADBEE`, `0xDADADA`,
     `0xC0DE99`) → N/A
   - Otherwise → drift (zero found)
4. For `arenaDecor.js` (multi-stage), scoped the grep to the line range of
   each `_build<Stage>Decor` function only — other stages share the file.

## Locked palettes (reference)

### Forest (`docs/FOREST_VISUAL_STYLE.md`)
| Slot | Hex | Use |
|------|-----|-----|
| 1 | `0x1a1e22` | Stone-trunk base |
| 2 | `0x2d3a55` | Crystal-trunk mid |
| 3 | `0x5f8fb5` | Crystal facet hi |
| 4 | `0x7df0c4` | Bio-glow primary |
| 5 | `0x3ecf9a` | Bio-glow secondary |
| 6 | `0xf5a300` | Amber idle |
| 7 | `0xffd86b` | Amber detonation |
| 8 | `0xa8e6ff` | Chain-lightning |

### Twilight (`docs/TWILIGHT_VISUAL_STYLE.md`)
| Slot | Hex | Use |
|------|-----|-----|
| 1 | `0x1a0a2e` | Bruised purple deep |
| 2 | `0x2d1547` | Bruised purple mid |
| 3 | `0x7a5fa5` | Violet pale |
| 4 | `0xe8d4b0` | Bone white |
| 5 | `0x8b1a2e` | Blood red rich |
| 6 | `0xa98030` | Gold dim |
| 7 | `0xffcd5b` | Fountain glow peak |
| 8 | `0xa8e6ff` | Movement-boost aura (same hex as forest slot 8 — intentional reuse) |

### Cinder (`docs/CINDER_VISUAL_STYLE.md`)
| Slot | Hex | Use |
|------|-----|-----|
| 1 | `0x0a0604` | Charred black |
| 2 | `0x3a342f` | Ash gray |
| 3 | `0x7a3d1a` | Rust orange dim |
| 4 | `0xff5522` | Ember orange hot |
| 5 | `0xd4c4a8` | Ash white |
| 6 | `0x5a1810` | Dried blood |
| 7 | `0xffd24a` | Ballista glow active |
| 8 | `0xffb86b` | Repair progress aura |

### Void (`docs/VOID_VISUAL_STYLE.md`)
| Slot | Hex | Use |
|------|-----|-----|
| 1 | `0x040208` | Obsidian black |
| 2 | `0x1a0a3a` | Deep violet abyss |
| 3 | `0x3a1a5e` | Cosmic purple mid |
| 4 | `0xd8dce8` | Chrome white edge |
| 5 | `0x00d4ff` | Portal cyan idle |
| 6 | `0x7fffff` | Portal cyan active |
| 7 | `0xffffff` | Teleport flash (only stage where pure white is a palette slot) |
| 8 | `0xa8b8ff` | Star points |

## Per-module findings

### `src/forestAmber.js`
| Literal | Status | Notes |
|---------|--------|-------|
| `0x2d3a55` | ✅ | Forest slot 2 |
| `0x5f8fb5` | ✅ | Forest slot 3 |
| `0xa8e6ff` | ✅ | Forest slot 8 (chain-lightning) |
| `0xf5a300` | ✅ | Forest slot 6 (amber idle) |
| `0xffd86b` | ✅ | Forest slot 7 (amber detonation) |
| `0x6D2B79` | N/A | Substring of `0x6D2B79F5` — Mulberry32 PRNG mixing constant (line 132). Not a color. |

Slots used: 2, 3, 6, 7, 8. Slots 1, 4, 5 not used (this module owns amber
hotspots, not the stone/bio-glow geometry that lives in the forest decor
builder). All in palette. **No drift.**

### `src/twilightFountains.js`
| Literal | Status | Notes |
|---------|--------|-------|
| `0x2d1547` | ✅ | Twilight slot 2 |
| `0x8b1a2e` | ✅ | Twilight slot 5 (blood fountain liquid) |
| `0xa98030` | ✅ | Twilight slot 6 (light fountain liquid) |
| `0xe8d4b0` | ✅ | Twilight slot 4 (bone stone rim) |
| `0xffcd5b` | ✅ | Twilight slot 7 (drink-flash) |
| `0xa8e6ff` | ✅ | Twilight slot 8 (movement-boost aura) |
| `0x6D2B79` | N/A | Substring of `0x6D2B79F5` — PRNG constant (line 88). Not a color. |

Slots used: 2, 4, 5, 6, 7, 8. Slots 1, 3 belong to hedge/decor geometry
(arenaDecor `_buildTwilightDecor`). All in palette. **No drift.**

### `src/cinderBallistas.js`
| Literal | Status | Notes |
|---------|--------|-------|
| `0x0a0604` | ✅ | Cinder slot 1 (charred chassis) |
| `0x3a342f` | ✅ | Cinder slot 2 (ash gray) |
| `0x7a3d1a` | ✅ | Cinder slot 3 (rust metal bands) |
| `0xd4c4a8` | ✅ | Cinder slot 5 (ash white highlights) |
| `0xffd24a` | ✅ | Cinder slot 7 (ballista glow + bolt) |
| `0xffb86b` | ✅ | Cinder slot 8 (repair progress aura) |
| `0x000000` | ✅ | Inactive emissive default at line 316 (matches allowed convention: "no light emitted yet" — chassis is dark until activation). |
| `0x6D2B79` | N/A | Substring of `0x6D2B79F5` — PRNG constant. Not a color. |

Slots used: 1, 2, 3, 5, 7, 8. Slots 4 (ember orange) and 6 (dried blood)
belong to decor / catapults / crater rings in `_buildCinderDecor`. All in
palette. **No drift.**

### `src/voidTeleportPads.js`
| Literal | Status | Notes |
|---------|--------|-------|
| `0x040208` | ✅ | Void slot 1 (obsidian black) |
| `0x1a0a3a` | ✅ | Void slot 2 (cooldown ring dim) |
| `0x3a1a5e` | ✅ | Void slot 3 (cosmic purple mid) |
| `0xd8dce8` | ✅ | Void slot 4 (chrome white edge) |
| `0x00d4ff` | ✅ | Void slot 5 (pad idle cyan) |
| `0x7fffff` | ✅ | Void slot 6 (pad pulse peak charged) |
| `0xffffff` | ✅ | Void slot 7 (teleport flash — single-frame white; explicitly permitted by the style doc as a palette slot, not a generic fallback) |
| `0xa8b8ff` | ✅ | Void slot 8 (star points) |
| `0x6D2B79` | N/A | Substring of `0x6D2B79F5` — PRNG constant. Not a color. |

Full palette coverage (all 8 slots). **No drift.**

### `src/chainFx.js`
| Literal | Status | Notes |
|---------|--------|-------|
| `0xa8e6ff` | ✅ | Used only as `DEFAULT_OUTER_COLOR` / `DEFAULT_INNER_COLOR` (lines 48-49) — the documented default when callers omit `opts.outerColor`/`opts.innerColor`. Matches forest slot 8 / twilight slot 8 (intentional shared "fast/electric" accent). |

`chainFx.js` is palette-parameterized per its module contract (see header
JSDoc: "Stage palette is parameter.") and accepts arbitrary colors via
`opts`. The two default constants live at the module top so the public API
signature documents what callers get if they pass nothing. This is the
expected shape, not a hardcode. **No drift.**

### `src/arenaDecor.js _buildForestDecor` (lines 54-355)
| Literal | Status | Notes |
|---------|--------|-------|
| `0x2d3a55` | ✅ | Forest slot 2 (crystal-trunk mid) |
| `0x5f8fb5` | ✅ | Forest slot 3 (crystal facet hi) |
| `0x7df0c4` | ✅ | Forest slot 4 (bio-glow primary) |
| `0x3ecf9a` | ✅ | Forest slot 5 (bio-glow secondary) |
| `0xC0FFEE` | N/A | Mulberry32 seed at line 76 (`_rngState = 0xC0FFEE`). Not a color. |
| `0x6D2B79` | N/A | Substring of `0x6D2B79F5` — PRNG mixing constant (line 78). Not a color. |

Slots used: 2, 3, 4, 5. Slot 1 (stone-trunk base) is not directly bound
in this builder — crystal-trunk mid (slot 2) is the diffuse and slot 3
the facet; slot 1 lives in the broader `arenaDecor`/`floors` lookup
outside the per-builder scope. Slots 6/7/8 belong to the amber/chain FX
modules. All in palette. **No drift.**

### `src/arenaDecor.js _buildTwilightDecor` (lines 378-706)
| Literal | Status | Notes |
|---------|--------|-------|
| `0x1a0a2e` | ✅ | Twilight slot 1 (hedge base shadow / instanceColor lane A, line 511) |
| `0x2d1547` | ✅ | Twilight slot 2 (hedge body mid / instanceColor lane B, line 512) |
| `0xe8d4b0` | ✅ | Twilight slot 4 (stone rim / bone white) |
| `0xffffff` | ⚠️ ✅ | Line 503: neutral white as `MeshStandardMaterial.color` base for `InstancedMesh.instanceColor` per-instance tinting (slots 1 + 2). Three.js multiplies material color by instance color — the displayed pixels are slot 1/2 only. White is the identity multiplicand. Allowed under the "no light emitted yet / neutral default" convention extended to multiplicative tinting. |
| `0xBADBEE` | N/A | Mulberry32 seed at line 23 of the builder. Not a color. |
| `0x6D2B79` | N/A | Substring of `0x6D2B79F5` — PRNG constant. Not a color. |

Slots used: 1, 2, 4 (visible). Slots 3 (violet pale highlight), 5/6/7
(fountain liquid + flash), 8 (movement aura) belong to fountains module
or unused. All in palette. **No drift.**

### `src/arenaDecor.js _buildCinderDecor` (lines 707-1047)
| Literal | Status | Notes |
|---------|--------|-------|
| `0x0a0604` | ✅ | Cinder slot 1 (charred wood) |
| `0x3a342f` | ✅ | Cinder slot 2 (ash gray counterweights) |
| `0x7a3d1a` | ✅ | Cinder slot 3 (rust orange metal bands) |
| `0xff5522` | ✅ | Cinder slot 4 (ember accents on smoldering wood — matches stageHazards lava exact hex, per style doc note "Slot 4 + slot 7 reuse") |
| `0xd4c4a8` | ✅ | Cinder slot 5 (bone fragments / ash white) |
| `0x5a1810` | ✅ | Cinder slot 6 (dried blood crater overlay) |
| `0xDADADA` | N/A | Mulberry32 seed at line 33 of the builder. Not a color. |
| `0x6D2B79` | N/A | Substring of `0x6D2B79F5` — PRNG constant. Not a color. |

Slots used: 1, 2, 3, 4, 5, 6. Slots 7 (ballista glow) + 8 (repair aura)
belong to the ballistas module. All in palette. **No drift.**

### `src/arenaDecor.js _buildVoidDecor` (lines 1048-1335)
| Literal | Status | Notes |
|---------|--------|-------|
| `0x040208` | ✅ | Void slot 1 (obsidian — tile undersides, missing-tile decals) |
| `0x1a0a3a` | ✅ | Void slot 2 (deep violet abyss — gap inner gradient, shadow material) |
| `0x3a1a5e` | ✅ | Void slot 3 (cosmic purple — tile tops, pillar diffuse) |
| `0xd8dce8` | ✅ | Void slot 4 (chrome white — tile bevel edges, pillar facet caps) |
| `0xa8b8ff` | ✅ | Void slot 8 (star points — gap drift particles, pillar shimmer) |
| `0xC0DE99` | N/A | Mulberry32 seed at line 38 of the builder. Not a color. |
| `0x6D2B79` | N/A | Substring of `0x6D2B79F5` — PRNG constant. Not a color. |

Slots used: 1, 2, 3, 4, 8. Slots 5/6/7 (pad cyan idle / pulse peak /
teleport flash) belong to the teleport pads module. All in palette.
**No drift.**

## Open questions / style-doc gaps

None for D1 strictly. A few low-priority observations the user may want
to file as future cleanup, not in scope to fix today:

1. **Forest slot 1 (`0x1a1e22`, "stone-trunk base")** is not directly
   referenced inside `_buildForestDecor` — the visible trunk geometry
   uses slot 2 mid + slot 3 facet only. May be intentional (slot 1 was
   reserved for a planned darker base but never wired), or may indicate
   the trunk silhouette is currently a little lighter than the style
   doc envisioned. Not a drift (no off-palette color was substituted);
   just a slot the builder never uses. Worth a half-line confirmation
   from the Forest Decor Agent next time decor changes.
2. **`floors.void = 0x040208`** referenced in the Void style doc as
   living in `arenaDecor.js` line 1139 is no longer present at that
   line — a `grep -n "floors\."` returns no hits in `arenaDecor.js`.
   The literal `0x040208` IS used inside `_buildVoidDecor` (in palette),
   so the void floor color is correct; only the style-doc line-number
   reference has drifted. Trivial doc-housekeeping, not a palette
   issue.
3. **`0xffffff` as InstancedMesh tint base** (twilight hedge mat) is
   the only "convention extension" call I had to make in this audit.
   If the team wants the audit rule to be hex-strict, the alternative
   pattern is `new THREE.MeshStandardMaterial({ color: 0x1a0a2e })`
   and tint per-instance from slot 1 vs slot 2 via a small additive
   delta — but that costs a second material or per-instance recompute
   and gains nothing visible. Recommend keeping the `0xffffff`-as-
   identity-tint convention and adding an explicit line to the style
   docs ("`0xffffff` is permitted as the material base color when
   `InstancedMesh.instanceColor` provides the displayed tint").

## Verification

```
$ node tools/smoke-sig-weapons.mjs
✓ descriptions.js entries
✓ AVATARS.signatureWeapon ↔ kit id bindings
✓ REGISTRY map populated for every sig kit (Codex 2026-05-15 fix)
ALL CHECKS PASS

$ node --check src/forestAmber.js          # OK
$ node --check src/twilightFountains.js    # OK
$ node --check src/cinderBallistas.js      # OK
$ node --check src/voidTeleportPads.js     # OK
$ node --check src/chainFx.js              # OK
$ node --check src/arenaDecor.js           # OK
```

## Summary

Zero drift, zero source-file changes. The locked-palette discipline across
the four stage-interactable modules + the shared chain-FX module is
holding. Documenting it here so future agents can rerun this audit by
grep + table-compare without re-reading each module from scratch.
