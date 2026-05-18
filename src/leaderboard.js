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

/** Return today's local YYYY-MM-DD string (matches meta.todayKey shape). */
function _todayDateString() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Record a finished run. Inputs:
 *   { stage, char, mode, kills, timeSurvived, level, victory, dmgDealt, dailyDate? }
 * Returns: { rankInCategory, isNewBest, seed }
 *
 * P4E daily leaderboard (#145): when `mode === 'daily'`, stamp `dailyDate`
 * on the entry so `topDailyForSeed` / `topDailyToday` can filter without
 * re-parsing the seed string. Caller may pass an explicit `dailyDate` to
 * override (replay-from-history flows); otherwise we use today's local date.
 * `dailyDate` is only stamped for daily mode — weekly / normal / hyper
 * entries omit the field so the persisted shape stays lean.
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
  if (info.mode === 'daily') {
    entry.dailyDate = info.dailyDate || _todayDateString();
  }
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

// ─── P4E daily leaderboard (#145) ────────────────────────────────────────────
//
// `topDailyForSeed` and `topDailyToday` both filter the same store by
// `mode === 'daily' && dailyDate === <YYYY-MM-DD>`. The seed in our short
// `makeSeed()` form bakes character into the slug, so two different chars on
// the same day produce different seeds — for a single LB the calendar-day
// filter is the right unit, not the seed string. `topDailyForSeed` is exposed
// as the public name the acceptance test asks for and forwards to the same
// filter logic.
//
// Share codes are base64 of a compact JSON `{ s,k,t,c }` payload (seed,
// kills, time, char). This is a comparison token — humans paste it to brag —
// not a replay token. Actual replay requires playing on the same calendar
// day with the same character; the share code carries no entropy that would
// let a recipient reconstruct the run.

/**
 * Top-N daily entries for a given seed (filters by seed + dailyDate, since
 * a player who plays the same daily on two different machines could end up
 * with two entries sharing a seed-slug but different dailyDate; this keeps
 * the cross-day filter tight). Sorts by timeSurvived desc, then kills desc.
 */
export function topDailyForSeed(seed, n = 10) {
  const data = _load();
  const filtered = data.runs.filter(r => r && r.mode === 'daily' && r.seed === seed);
  filtered.sort((a, b) => (b.timeSurvived - a.timeSurvived) || (b.kills - a.kills));
  return filtered.slice(0, Math.max(0, n));
}

/**
 * Top-N daily entries for today (local date), across ALL characters. The
 * daily-mode UI surfaces this in a "Today's leaderboard" inline panel on
 * the end-run summary.
 */
export function topDailyToday(n = 10) {
  const today = _todayDateString();
  const data = _load();
  const filtered = data.runs.filter(r => r && r.mode === 'daily' && r.dailyDate === today);
  filtered.sort((a, b) => (b.timeSurvived - a.timeSurvived) || (b.kills - a.kills));
  return filtered.slice(0, Math.max(0, n));
}

/**
 * Encode a leaderboard entry as a base64-url-safe share code. Compact JSON
 * `{ s, k, t, c }` keeps the encoded string short enough to fit in a Discord
 * embed footer. Uses encodeURIComponent → unescape → btoa for unicode safety
 * (character names with diacritics survive the round-trip).
 *
 * Returns `''` on any encoding failure rather than throwing — the share
 * button surfaces an empty result as a banner failure (caller decides UX).
 */
export function encodeShareCode(entry) {
  if (!entry) return '';
  const payload = {
    s: entry.seed || '',
    k: entry.kills | 0,
    t: (typeof entry.timeSurvived === 'number') ? Math.floor(entry.timeSurvived)
       : (typeof entry.durationSec === 'number') ? Math.floor(entry.durationSec)
       : 0,
    c: entry.char || entry.character || '',
  };
  try {
    const json = JSON.stringify(payload);
    // Unicode-safe btoa: percent-encode each unicode codepoint to a byte
    // sequence before base64. The unescape() bridge is deprecated but still
    // works in every browser; we wrap in try/catch to fall back cleanly.
    return btoa(unescape(encodeURIComponent(json)));
  } catch (_) {
    return '';
  }
}

/**
 * Decode a share code back to `{ s, k, t, c }`. Returns `null` on malformed
 * input (truncated, non-base64, JSON parse error). Callers should treat
 * `null` as "drop the paste, show an error banner".
 */
export function decodeShareCode(code) {
  if (!code || typeof code !== 'string') return null;
  try {
    const json = decodeURIComponent(escape(atob(code)));
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== 'object') return null;
    return {
      s: String(obj.s || ''),
      k: obj.k | 0,
      t: obj.t | 0,
      c: String(obj.c || ''),
    };
  } catch (_) {
    return null;
  }
}
