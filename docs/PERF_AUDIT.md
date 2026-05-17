# Perf Audit Process (PHASE 2 P2B)

Frametime profiler + procedure for identifying hot ticks.

## What's deployed

| Component | Toggle | Notes |
|---|---|---|
| `src/perfHUD.js` (F3 overlay) | `F3` | FPS, draw calls, geom/texture totals, per-subsystem avg ms. Single-window display. **Pre-existing.** |
| `src/perfProfiler.js` (P / backtick overlay) | `` ` `` or shift+`P` | Rolling 60-frame window. Avg, max, last per tick. Bar chart. Top-K sort. **New, PHASE 2 P2B.** |

The two overlays coexist by design. F3 is always reachable (light overhead even at rest). The profiler is **OFF by default** and only activates when the dev gate is set:

```js
localStorage.setItem('kkPerf', '1');
location.reload();
```

When the gate is off, `profilerRecord(name, ms)` returns on the very first branch (single conditional, no allocations). The `perfStart()` call inside `perfHUD.js` still returns `0` in that path, so the existing 58 wrap sites in `main.js` keep the same near-zero overhead they had before this audit.

## How the wiring works

The codebase already brackets every per-frame tick in `src/main.js` with `perfStart()` / `perfMark(name, t0)` (58 sites as of cohort 28). Rather than introduce a second wrap layer, the profiler **taps the existing pipeline**:

```
main.js                  perfHUD.js                      perfProfiler.js
─────────                ──────────                      ────────────────
_p = perfStart();    →   returns now() if F3 on
                          OR profiler gate set
tickFoo(state, dt);

perfMark('foo', _p); →   dt = now() - _p
                         _on        → _perfAcc['foo'] += dt   (F3 HUD)
                         _profilerOn → profilerRecord('foo', dt) ──→  ring['foo'].buf[idx++] = dt
```

Net effect: enabling the profiler instruments every existing `perfMark` site for free, no per-site code changes.

## How to capture a report

1. Toggle on the gate from a browser console open against the dev server:

   ```js
   localStorage.setItem('kkPerf', '1');
   location.reload();
   ```

2. Play (or auto-play via a smoke harness) for at least 30 seconds. The profiler keeps a rolling 60-frame window — at 60 fps that's the last ~1 second; at the 3–4 fps you'll see in headless WebGL it's the last ~15–20 seconds.

3. Open the overlay (`` ` `` or shift+`P`) to eyeball it live, OR dump a snapshot from the console:

   ```js
   copy(JSON.stringify(window.kkPerfProfilerSnapshot(20), null, 2));
   ```

   The harness export is `window.kkPerfProfilerSnapshot(k)` → `{ enabled, window, count, rows: [{name, avg, max, last, samples}, ...] }`. It does **not** shadow the older `window.kkPerfSnapshot` from perfHUD — the existing smoke-forest-v2 harness still reads that one.

4. Paste the top rows into `tools/_perf_report.md` (template/example is committed; the live audit overwrites it).

## Reading the bar chart

The bar references 4 ms full-scale. A tick that consistently exceeds the 2 ms budget is colored red (`#ff7a7a`) and shows ~half-full or more. Header includes `hot >=2ms: N` so a glance tells you whether any subsystem is over budget.

## Disable the profiler

```js
localStorage.removeItem('kkPerf');
location.reload();
```

Or from a running session:

```js
window.kkPerfProfilerDisable();
```

## Headless caveats

* `tools/smoke-forest-v2.mjs` runs under `--use-gl=swiftshader`. Real frame rate is 3–4 fps (see cohort 15 note + smoke-forest-v2.mjs header). **Absolute** tick numbers from that environment are useless. **Relative** ordering (which tick is hottest) is still meaningful — the bottleneck is mostly the GL, but per-tick CPU work scales with content density similarly to hardware.
* In a hardware GL run (browser with native graphics) the same code path produces meaningful absolute timings; that's the path to use when prioritizing fixes.

## Files

| File | Purpose |
|---|---|
| `src/perfProfiler.js` | Ring buffer + DOM overlay + key handler. |
| `src/perfHUD.js` (edited) | Forwards `perfMark` deltas to `profilerRecord`. Adds `_perfHUDSetProfilerOn`. |
| `src/main.js` (edited) | Calls `initPerfProfiler()` once + `renderPerfProfilerOverlay()` per frame. |
| `tools/_perf_report.md` | Latest audit output (template included). |
| `docs/PERF_AUDIT.md` | This file. |
