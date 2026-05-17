/**
 * Toggleable performance overlay — FPS, frame-time, draw calls, triangle
 * count, active-entity counts. Off by default; press F3 to toggle.
 *
 * Cheap to compute: reads `renderer.info` (already populated by THREE.js
 * each frame) and counts from `state.*` arrays. Repaint throttled to 4 Hz so
 * the text doesn't smear.
 *
 * Lives outside the main HUD on purpose — `pointer-events: none`, fixed
 * bottom-left, terminal-style monospace so it reads as a debug tool, not a
 * gameplay element.
 */
import { state } from './state.js';
import { profilerRecord } from './perfProfiler.js';

let _el = null;
let _on = false;
let _last = performance.now();
let _accFrames = 0;
let _accMs = 0;
let _accT = 0;
let _fps = 0;
let _msAvg = 0;
let _nextPaint = 0;

// iter 33o — per-subsystem timing.
// perfMark(name, startMs) accumulates (now - startMs) into _perfAcc[name].
// Displayed in perfHUD as sorted ms breakdown over the same window as FPS.
const _perfAcc = Object.create(null);
const _perfDisp = Object.create(null);
// FOREST-V2-A29: profiler taps the same bracket — when its localStorage
// gate is set, we want to record every tick even when the F3 HUD is off.
// `_profilerOn` lets `perfStart` return a usable timestamp without paying
// the cost in normal play (the flag is set once by initPerfHUD from
// localStorage; main.js doesn't have to know about it).
let _profilerOn = false;
export function _perfHUDSetProfilerOn(v) { _profilerOn = !!v; }
export function perfMark(name, startMs) {
  if (!_on && !_profilerOn) return;
  const dt = performance.now() - startMs;
  if (_on) _perfAcc[name] = (_perfAcc[name] || 0) + dt;
  if (_profilerOn) profilerRecord(name, dt);
}
export function perfStart() {
  return (_on || _profilerOn) ? performance.now() : 0;
}

export function initPerfHUD() {
  if (_el) return;
  _el = document.createElement('div');
  _el.id = 'kk-perf';
  _el.style.cssText = `
    position: fixed; left: 12px; bottom: 12px;
    pointer-events: none; z-index: 200;
    font-family: 'JetBrains Mono', 'Consolas', monospace;
    font-size: 11px; line-height: 1.45;
    color: #7fffe4;
    background: rgba(8,14,12,0.78);
    border: 1px solid rgba(255,232,188,0.18);
    border-radius: 6px;
    padding: 8px 12px;
    box-shadow: 0 6px 16px rgba(0,0,0,0.45);
    text-shadow: 0 1px 0 rgba(0,0,0,0.5);
    white-space: pre;
    display: none;
  `;
  document.body.appendChild(_el);
  // F3 toggle. Also exposes window.kkPerf for quick console toggling.
  window.addEventListener('keydown', (e) => {
    if (e.code === 'F3') {
      e.preventDefault();
      togglePerfHUD();
    }
  });
  window.kkPerf = () => togglePerfHUD();
}

export function togglePerfHUD() {
  _on = !_on;
  if (_el) _el.style.display = _on ? 'block' : 'none';
}

// iter 33o — headless harness read path. window.kkPerfSnapshot() returns a
// shallow copy of the displayed ms breakdown + FPS/calls/tris/enemies.
if (typeof window !== 'undefined') {
  window.kkPerfSnapshot = () => {
    const r = state.renderer;
    const info = r && r.info ? r.info : null;
    return {
      fps: +_fps.toFixed(1),
      ms: +_msAvg.toFixed(2),
      calls: info ? info.render.calls : 0,
      tris: info ? info.render.triangles : 0,
      geoms: info ? info.memory.geometries : 0,
      texs: info ? info.memory.textures : 0,
      enemies: state.enemies && state.enemies.active ? state.enemies.active.length : 0,
      breakdown: Object.assign({}, _perfDisp),
    };
  };
  window.kkPerfForceOn = () => { _on = true; if (_el) _el.style.display = 'block'; };
  window.kkState = state;
  window.kkPoolProbe = () => {
    const out = {};
    const pools = (state.enemies && state.enemies.pools) || {};
    for (const k of Object.keys(pools)) {
      const m = pools[k][0];
      if (!m) continue;
      let meshN = 0, matN = 0, triN = 0, tinyN = 0;
      const mats = new Set();
      const submeshes = [];
      m.traverse((o) => {
        if (!o.isMesh) return;
        meshN++;
        let tris = 0;
        if (o.geometry && o.geometry.attributes && o.geometry.attributes.position) {
          const idx = o.geometry.index;
          tris = idx ? idx.count / 3 : o.geometry.attributes.position.count / 3;
          triN += tris;
        }
        const bb = (o.geometry && (o.geometry.boundingBox || (o.geometry.computeBoundingBox(), o.geometry.boundingBox))) || null;
        let diag = 0;
        if (bb) {
          const dx = bb.max.x - bb.min.x, dy = bb.max.y - bb.min.y, dz = bb.max.z - bb.min.z;
          diag = Math.sqrt(dx * dx + dy * dy + dz * dz);
        }
        if (tris < 40 || diag < 0.05) tinyN++;
        submeshes.push({ name: o.name || '?', tris: Math.round(tris), diag: +diag.toFixed(3), skinned: !!o.isSkinnedMesh });
        const ma = Array.isArray(o.material) ? o.material : [o.material];
        for (const x of ma) if (x) mats.add(x.uuid);
      });
      matN = mats.size;
      out[k] = { meshes: meshN, mats: matN, tris: Math.round(triN), tiny: tinyN, submeshes };
    }
    return out;
  };
}

export function updatePerfHUD() {
  if (!_on || !_el) return;
  const now = performance.now();
  const dt = now - _last;
  _last = now;
  _accFrames += 1;
  _accMs += dt;
  _accT += dt;
  if (now < _nextPaint) return;
  _nextPaint = now + 250;
  _fps = _accFrames > 0 ? (1000 * _accFrames / _accMs) : 0;
  _msAvg = _accFrames > 0 ? (_accMs / _accFrames) : 0;
  // Compute per-subsystem ms-per-frame avg from the accumulator window.
  const _denom = Math.max(1, _accFrames);
  for (const k in _perfAcc) _perfDisp[k] = _perfAcc[k] / _denom;
  for (const k in _perfAcc) _perfAcc[k] = 0;
  _accFrames = 0; _accMs = 0;

  const r = state.renderer;
  const info = r && r.info ? r.info : null;
  const calls = info ? info.render.calls : 0;
  const tris  = info ? info.render.triangles : 0;
  const lines = info ? info.render.lines : 0;
  const geoms = info ? info.memory.geometries : 0;
  const texs  = info ? info.memory.textures : 0;

  const aliveEnemies = state.enemies && state.enemies.active ? state.enemies.active.length : 0;
  const projs    = state.projectiles && state.projectiles.active ? state.projectiles.active.length : 0;
  const eprojs   = state.enemyProjectiles && state.enemyProjectiles.active ? state.enemyProjectiles.active.length : 0;
  const gems     = state.gems && state.gems.list ? state.gems.list.length : 0;
  const webs     = state.webs && state.webs.list ? state.webs.list.length : 0;

  const fpsColor = _fps >= 58 ? '#7ee08a' : _fps >= 45 ? '#ffd27f' : '#ff7a7a';
  const lines_out = [
    `FPS    ${_fps.toFixed(1).padStart(5)}   ${_msAvg.toFixed(2)}ms`,
    `calls  ${String(calls).padStart(5)}   tris ${String(tris).padStart(6)}`,
    `geoms  ${String(geoms).padStart(5)}   texs ${String(texs).padStart(4)}   lines ${lines}`,
    ``,
    `enemies   ${String(aliveEnemies).padStart(4)}`,
    `projs ${String(projs).padStart(3)}  enemyProjs ${String(eprojs).padStart(3)}`,
    `gems ${String(gems).padStart(4)}   webs ${String(webs).padStart(2)}`,
  ];

  // iter 33o — per-subsystem breakdown (top 10 ms hogs).
  const _names = Object.keys(_perfDisp);
  if (_names.length > 0) {
    _names.sort((a, b) => _perfDisp[b] - _perfDisp[a]);
    lines_out.push(``);
    lines_out.push(`-- ms/frame --`);
    for (let i = 0; i < Math.min(_names.length, 10); i++) {
      const n = _names[i];
      const v = _perfDisp[n];
      if (v < 0.02) break;
      lines_out.push(`${n.padEnd(12)} ${v.toFixed(2).padStart(5)}`);
    }
  }

  _el.innerHTML = `<span style="color:${fpsColor};">${lines_out[0]}</span>\n` + lines_out.slice(1).join('\n');
}
