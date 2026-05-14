/**
 * Run-history log — a rolling buffer of the player's last 20 finished runs.
 *
 * Persists into meta.runHistory[] (managed via getMeta/saveMeta from meta.js).
 * Each entry: {
 *   seed, stage, character, durationSec, level, kills,
 *   weaponsUsed: [ids], evolutionsAchieved: [ids],
 *   outcome: 'death' | 'victory', endedAt: ISO string
 * }
 *
 * Public API:
 *   recordRunResult(state, outcome)
 *   showRunHistory(), hideRunHistory(), isRunHistoryOpen()
 */

import { getMeta, saveMeta, setOption } from './meta.js';
import { makeSeed } from './leaderboard.js';
import { hideTooltip } from './tooltips.js';

const MAX_ENTRIES = 20;

// ── Theme tokens (kept local so this module doesn't depend on ui.js) ────────
const C = {
  text:    '#f5efe1',
  cyan:    '#7fffe4',
  amber:   '#ffd27f',
  magenta: '#ff7ad8',
  edge:    'rgba(255, 232, 188, 0.18)',
};
const F = {
  display: '"Cinzel Decorative", "Cinzel", Georgia, serif',
  body:    '"Inter", "Segoe UI", system-ui, sans-serif',
  mono:    '"JetBrains Mono", "Consolas", monospace',
};

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function _fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${day} ${hh}:${mm}`;
  } catch (_) { return iso; }
}

/**
 * Snapshot a finished run into meta.runHistory. Called from main.js when a
 * run resolves (death or victory). The state object is duck-typed: we read
 * the same fields ui.js's death screen reads — state.run.*, state.hero.*,
 * state.time.*, state.victory, plus weapons/evolutions/passives lists.
 */
export function recordRunResult(state, outcome) {
  if (!state) return;
  const meta = getMeta();
  if (!Array.isArray(meta.runHistory)) meta.runHistory = [];

  const stageId = (state.run && state.run.stage && state.run.stage.id) || meta.selectedStage || 'forest';
  const charId  = (state.run && state.run.character) || meta.selectedChar || 'kitty';
  const mode    = state.modes && state.modes.hyper ? 'hyper'
              : state.modes && state.modes.endless ? 'endless'
              : state.modes && state.modes.daily ? 'daily'
              : state.modes && state.modes.bossRush ? 'boss-rush'
              : 'normal';

  const weaponsUsed = Array.isArray(state.weapons)
    ? state.weapons.map(w => ({ id: w.id, level: w.level || 1, evolved: !!(w.inst && w.inst.evolved) }))
    : [];
  const evolutionsAchieved = weaponsUsed.filter(w => w.evolved).map(w => w.id);
  if (state.hero && state.hero.dashEvolved) evolutionsAchieved.push('dash');

  const passives = Array.isArray(state.passives)
    ? state.passives.map(p => ({ id: p.id, level: p.level || 0 }))
    : [];

  const entry = {
    seed:        makeSeed(stageId, charId, mode),
    stage:       stageId,
    character:   charId,
    mode,
    durationSec: Math.max(0, Math.floor((state.time && state.time.game) || 0)),
    level:       (state.hero && state.hero.level) || 0,
    kills:       (state.run && state.run.kills) || 0,
    dmgDealt:    Math.floor((state.run && state.run.dmgDealt) || 0),
    weaponsUsed,
    passives,
    evolutionsAchieved,
    outcome:     outcome === 'victory' ? 'victory' : 'death',
    endedAt:     new Date().toISOString(),
  };
  meta.runHistory.unshift(entry);
  if (meta.runHistory.length > MAX_ENTRIES) {
    meta.runHistory.length = MAX_ENTRIES;
  }
  saveMeta();
  return entry;
}

// ── History modal ───────────────────────────────────────────────────────────
let _modal = null;

export function isRunHistoryOpen() { return !!_modal; }

export function hideRunHistory() {
  if (!_modal) return;
  if (_modal.parentNode) _modal.parentNode.removeChild(_modal);
  _modal = null;
}

export function showRunHistory() {
  // Iter 21a — defensive tooltip hide on modal entry.
  try { hideTooltip(); } catch (_) {}
  if (_modal) return;
  const root = document.getElementById('ui-root') || document.body;
  const meta = getMeta();
  const history = Array.isArray(meta.runHistory) ? meta.runHistory : [];

  _modal = document.createElement('div');
  _modal.style.cssText = `
    position: fixed; inset: 0;
    background:
      radial-gradient(ellipse at 50% 30%, rgba(255,210,127,0.06), transparent 60%),
      radial-gradient(ellipse at center, rgba(0,0,0,0.55), rgba(0,0,0,0.92) 80%);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    display: flex; flex-direction: column;
    align-items: center; justify-content: flex-start;
    padding: 48px 20px;
    pointer-events: auto;
    font-family: ${F.body};
    z-index: 130; overflow-y: auto;
  `;

  const title = document.createElement('div');
  title.style.cssText = `font-family: ${F.display}; font-size: 44px; font-weight: 900;
    letter-spacing: 0.20em; color: ${C.amber};
    text-shadow: 0 2px 16px rgba(0,0,0,0.55), 0 0 24px rgba(255,210,127,0.22);
    margin-bottom: 6px;`;
  title.textContent = 'Run History';

  const subtitle = document.createElement('div');
  subtitle.style.cssText = `font-family: ${F.body}; font-size: 11px; letter-spacing: 0.32em;
    color: rgba(245,239,225,0.62); text-transform: uppercase; margin-bottom: 26px;`;
  subtitle.textContent = `Last ${Math.min(history.length, MAX_ENTRIES)} of ${MAX_ENTRIES} runs · re-roll a seed to replay its setup`;

  const list = document.createElement('div');
  list.style.cssText = 'width: 100%; max-width: 980px; display: flex; flex-direction: column; gap: 10px;';

  if (history.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = `padding: 36px 28px; text-align: center;
      border: 1px dashed ${C.edge}; border-radius: 10px;
      color: rgba(245,239,225,0.62); font-size: 13px; letter-spacing: 0.12em;`;
    empty.textContent = 'No finished runs yet. Survive (or fall) once and your record will appear here.';
    list.appendChild(empty);
  } else {
    history.forEach((entry, idx) => list.appendChild(_renderRow(entry, idx)));
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close · Esc';
  close.style.cssText = `margin-top: 26px; padding: 10px 26px; cursor: pointer;
    background: linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86));
    border: 1px solid ${C.edge}; border-radius: 8px;
    color: ${C.amber}; font-family: ${F.display}; font-size: 13px; font-weight: 700;
    letter-spacing: 0.28em;`;
  close.onclick = hideRunHistory;

  _modal.appendChild(title);
  _modal.appendChild(subtitle);
  _modal.appendChild(list);
  _modal.appendChild(close);
  root.appendChild(_modal);

  // Esc to close (capture-phase to preempt the global Esc in main.js)
  const winKey = (e) => {
    if (!_modal) { window.removeEventListener('keydown', winKey, true); return; }
    if (e.code === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      hideRunHistory();
    }
  };
  window.addEventListener('keydown', winKey, true);
}

function _renderRow(entry, idx) {
  const row = document.createElement('div');
  const win = entry.outcome === 'victory';
  const accent = win ? C.amber : 'rgba(255,94,94,0.65)';
  row.style.cssText = `
    background: linear-gradient(180deg, rgba(20,28,22,0.92), rgba(8,14,12,0.96));
    border: 1px solid ${win ? C.amber : C.edge};
    border-radius: 10px;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 22px rgba(0,0,0,0.5);
    padding: 14px 18px;
    display: grid;
    grid-template-columns: auto 1fr auto;
    column-gap: 18px;
    align-items: center;
  `;

  const wepIds = (entry.weaponsUsed || []).map(w => w.id + (w.evolved ? '★' : ''));
  const evos = (entry.evolutionsAchieved || []).join(', ');

  const left = document.createElement('div');
  left.style.cssText = `font-family:${F.mono}; font-size: 18px; color: ${accent}; min-width: 32px; text-align: center;`;
  left.textContent = `#${idx + 1}`;

  const mid = document.createElement('div');
  mid.innerHTML = `
    <div style="font-family:${F.display};font-size:14px;font-weight:700;letter-spacing:0.14em;color:${C.text};">
      ${_esc(String(entry.character || '').toUpperCase())} · ${_esc(String(entry.stage || '').toUpperCase())}
      <span style="color:${accent};font-size:11px;letter-spacing:0.22em;margin-left:8px;">${win ? '★ VICTORY' : '† DEATH'}</span>
    </div>
    <div style="font-family:${F.mono};font-size:11.5px;color:rgba(245,239,225,0.78);margin-top:4px;letter-spacing:0.08em;">
      ${_fmtTime(entry.durationSec)} · Lv ${entry.level} · ${entry.kills} kills · ${(entry.dmgDealt || 0).toLocaleString()} dmg
    </div>
    <div style="font-family:${F.body};font-size:10.5px;color:rgba(245,239,225,0.62);margin-top:4px;letter-spacing:0.06em;">
      <span style="opacity:0.7;">Weapons:</span> ${_esc(wepIds.join(', ') || '—')}
      ${evos ? `<br><span style="opacity:0.7;">Evolutions:</span> <span style="color:${C.amber};">${_esc(evos)}</span>` : ''}
    </div>
    <div style="font-family:${F.mono};font-size:10px;color:rgba(245,239,225,0.42);margin-top:4px;letter-spacing:0.06em;">
      ${_esc(entry.seed || '')} · ${_esc(_fmtDate(entry.endedAt))}
    </div>
  `;

  const right = document.createElement('button');
  right.type = 'button';
  right.textContent = 'Re-roll Seed';
  right.title = 'Set the next run to this entry\'s stage + character + mode.';
  right.style.cssText = `padding: 8px 16px; cursor: pointer;
    background: linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86));
    border: 1px solid ${C.cyan}; border-radius: 8px;
    color: ${C.cyan};
    font-family: ${F.display}; font-size: 11px; font-weight: 700; letter-spacing: 0.24em;`;
  right.onclick = (e) => {
    e.stopPropagation();
    // Apply the entry's setup to the next run's selection.
    setOption('selectedStage', entry.stage);
    setOption('selectedChar',  entry.character);
    if (entry.mode === 'hyper')    setOption('optHyper',    true);
    if (entry.mode === 'endless')  setOption('optEndless',  true);
    if (entry.mode === 'boss-rush')setOption('optBossRush', true);
    if (entry.mode === 'daily')    setOption('optDaily',    true);
    right.textContent = '✓ Seeded';
    right.style.color = C.amber;
    right.style.borderColor = C.amber;
    setTimeout(() => { hideRunHistory(); }, 450);
  };

  row.appendChild(left);
  row.appendChild(mid);
  row.appendChild(right);
  return row;
}
