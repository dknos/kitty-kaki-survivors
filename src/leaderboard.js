/**
 * Local leaderboard + seed-share scaffolding.
 *
 * Persists best runs per (stage, character, mode) tuple in localStorage,
 * surfacing them on the start screen and in the death screen "your best"
 * tags. Also generates shareable seed strings so players can compare runs
 * deterministically.
 *
 * No server in v1 — pure client. When the multiplayer/Cloudflare Workers
 * layer lands, this module is the obvious place to also POST scores to a
 * public leaderboard. The API surface (`recordRun`, `bestFor`,
 * `topRunsAcrossAll`) is server-agnostic.
 */

const STORAGE_KEY = 'kk-leaderboard-v1';
const MAX_PER_KEY = 5;          // keep top-5 per category
const MAX_TOTAL = 200;          // global cap, oldest entries cycled out

function _load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return { runs: [] };
}

function _save(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (_) {}
}

function _key(stage, char, mode) {
  return `${stage}|${char}|${mode}`;
}

/** Compose a short shareable seed string for the given run conditions. */
export function makeSeed(stage, char, mode, dayString) {
  // 'forest|kitty|normal|2026-05-13' → 'F-KI-NM-26-05-13'
  // Compact + readable; humans can recognize stage + character at a glance.
  const stagePart = (stage || 'forest').toUpperCase().slice(0, 1);
  const charPart = (char || 'kitty').toUpperCase().slice(0, 2);
  const modePart = (mode || 'normal').toUpperCase().slice(0, 2);
  const datePart = dayString ? dayString.slice(2).replace(/-/g, '-') : '';
  return `${stagePart}-${charPart}-${modePart}${datePart ? '-' + datePart : ''}`;
}

/**
 * Record a finished run. Inputs:
 *   { stage, char, mode, kills, timeSurvived, level, victory, dmgDealt }
 * Returns: { rankInCategory, isNewBest, seed }
 */
export function recordRun(info) {
  const data = _load();
  const seed = makeSeed(info.stage, info.char, info.mode);
  const entry = {
    stage: info.stage,
    char: info.char,
    mode: info.mode,
    kills: info.kills | 0,
    timeSurvived: info.timeSurvived | 0,
    level: info.level | 0,
    dmgDealt: info.dmgDealt | 0,
    victory: !!info.victory,
    when: Date.now(),
    seed,
  };
  data.runs.push(entry);
  // Soft cap: drop oldest if over MAX_TOTAL
  if (data.runs.length > MAX_TOTAL) {
    data.runs.splice(0, data.runs.length - MAX_TOTAL);
  }
  _save(data);
  // Compute rank in this category (sort by time survived, then kills)
  const cat = data.runs.filter(r => r.stage === info.stage && r.char === info.char && r.mode === info.mode);
  cat.sort((a, b) => (b.timeSurvived - a.timeSurvived) || (b.kills - a.kills));
  const rankInCategory = cat.indexOf(entry) + 1;
  const isNewBest = rankInCategory === 1 && cat.length > 1;
  return { rankInCategory, isNewBest, seed };
}

/** Return the top run for the given category, or null. */
export function bestFor(stage, char, mode) {
  const data = _load();
  const cat = data.runs.filter(r => r.stage === stage && r.char === char && r.mode === mode);
  if (cat.length === 0) return null;
  cat.sort((a, b) => (b.timeSurvived - a.timeSurvived) || (b.kills - a.kills));
  return cat[0];
}

/** Top N runs across all categories (used by the "Hall of Records" screen). */
export function topRunsAcrossAll(n = 10) {
  const data = _load();
  const sorted = data.runs.slice().sort((a, b) => (b.timeSurvived - a.timeSurvived) || (b.kills - a.kills));
  return sorted.slice(0, n);
}

/** Clear all stored runs (for a debug/reset path). */
export function resetLeaderboard() {
  _save({ runs: [] });
}

// Helper to format mm:ss for UI render
export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Format a one-line seed-share string for clipboard / Discord paste.
 * Tolerant of both shapes that flow through this module:
 *   - leaderboard `recordRun` entries: { seed, kills, timeSurvived, char }
 *   - runHistory entries (meta.runHistory[]): { seed, kills, durationSec, character }
 * Output: "F-KI-NM-26-05-13 · 423k · 12:34 · kitty"
 */
export function formatSeedShareString(entry) {
  if (!entry) return '';
  const seed = entry.seed || '?';
  const kills = entry.kills | 0;
  const time = (typeof entry.timeSurvived === 'number') ? entry.timeSurvived
             : (typeof entry.durationSec === 'number') ? entry.durationSec
             : 0;
  const character = entry.character || entry.char || '?';
  return `${seed} · ${kills}k · ${formatTime(time)} · ${character}`;
}
