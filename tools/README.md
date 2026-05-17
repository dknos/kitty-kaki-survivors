# tools/

Diagnostic and harness scripts. Outputs (PNGs, JSON probe dumps) are gitignored
— scripts only are tracked here.

## Smoke harnesses

| Script | What it does |
|--------|--------------|
| `perf-bench.js` | Headless WebGL perf bench — FPS/ms/calls/enemies sampler. |
| `smoke-instproj.js` | InstancedMesh projectile pool smoke + screenshot. |
| `smoke-merge.js` | Merge-pool sanity + screenshot. |
| `smoke-missile.js` | Missile FX smoke + screenshot. |
| `smoke-sig-weapons.mjs` | Static contract check for sig weapons (no browser). |
| `smoke-sprite-fx.mjs` | Static contract check for sprite FX (no browser). |
| `smoke-forest-amber.js` | Forest amber detonation visual smoke — 3-frame screenshot (pre / peak / post). |

### `smoke-forest-amber.js`

Boots a local static server, launches full Playwright Chromium with WebGL,
loads `index.html?smoke=1`, sets meta `selectedStage = 'forest'`, starts a
run, triggers the amber nearest to the hero via the guarded debug hook
`window.kkDetonateNearestAmber`, then captures three frames:

- `_thumb_forest_pre_detonation.png` — baseline forest
- `_thumb_forest_detonation.png` — at-peak detonation
- `_thumb_forest_post_detonation.png` — after FX fade

The detonation hook lives in `src/forestAmber.js` and is gated by
`window.__kkSmokeEnabled`, which the harness sets after page load. The hook
is invisible to production builds (the getter returns `undefined` when the
flag is unset).

Run: `node tools/smoke-forest-amber.js`. Exits non-zero on `pageerror` or
missing screenshots. The output PNGs are gitignored via `tools/_thumb_*.png`.

If Chromium fails to launch (WSL/sandbox issues), the script reports a clear
preflight error and exits 2 — it never tries to `npm install` or auto-fetch a
browser. Use the same `executablePath` pattern as `perf-bench.js`; override
with `PLAYWRIGHT_BROWSERS_PATH` if your install lives elsewhere.

#### Known blocker (as of 2026-05-16)

On `main`, page boot currently fails with:

```
The requested module './meta.js' does not provide an export named 'AVATARS'
```

`src/menuV2.js` imports `AVATARS` from `./meta.js`, but `AVATARS` actually
lives in `src/config.js`. The module-graph import error prevents `main.js`
from registering `window.kkStartRun`, so the smoke harness times out waiting
for the global. Fix is a one-line import-path correction in `src/menuV2.js`
(out of scope for this PR — menuV2 was explicitly fenced off).

Until that's resolved, the harness is wired and ready: once the menuV2
import is corrected, `node tools/smoke-forest-amber.js` should produce all
three PNGs end-to-end.
