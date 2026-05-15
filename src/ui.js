/**
 * DOM-based UI overlay for Kitty Kaki Survivors.
 * Mounts everything into #ui-root (defined in index.html).
 * Tron/synthwave aesthetic — neon on dark, glowing borders, monospace.
 *
 * Public API (called by main.js):
 *   initUI(), updateUI(), showLevelUpModal(choices), hideLevelUpModal(),
 *   showDeathScreen(), showStartScreen(text), hideStartScreen()
 */
import { state } from './state.js';
import {
  commitRunResults, getMeta, setOption, achievementCount, ACHIEVEMENTS, isDiscovered, dailyChallengeConfig, commitDailyRun, equippedRelic, selectedStage, HOUSE_UPGRADES, houseLevel, houseCost, buyHouseUpgrade, QUEST_TEMPLATES, availableQuests, activeQuests, acceptQuest, abandonQuest, claimQuest, maxActiveQuests,
  grantSigils,
  isCharacterUnlocked,

  SHOP_TREE, purchaseTreeNode, nodeUnlocked, nodeOwned, sigilCount,
  addPreset, removePreset, listPresets, applyPreset,
  weeklyMutatorConfig,
  // Iter 10a — settings overhaul
  exportMeta, importMeta, resetMeta,
} from './meta.js';
// Iter 10a — accessibility uniform pusher + audio mix setters routed from
// the Options menu sliders. Imported eagerly so the Options modal sliders
// don't have to await a dynamic import on every drag event.
import { applyAccessibilityOptions } from './postfx.js';
import { setMasterVolume, setMusicVolume, setSfxVolume, sfx } from './audio.js';
import { CHARACTERS, STAGES, AVATARS } from './config.js';
import { SLOT_SYMBOLS, rollReel, resolveOutcome, applyOutcome } from './slotMachine.js';
import { pushFocusScope, popFocusScope } from './uiFocus.js';
import { mountLegend as mountPromptLegend, formatPrompt } from './buttonPrompts.js';
import { loadArenaDecor } from './arenaDecor.js';
import { bindTooltip, unbindTooltip, hideTooltip } from './tooltips.js';
import { weaponBlurb, passiveBlurb, fillerBlurb, characterBlurb, weaponStatRows, passiveStatRows } from './weapons/descriptions.js';
import { showCodex, isCodexOpen } from './codex.js';
import { showRunHistory, recordRunResult } from './runHistory.js';
import { downloadShareCard, renderShareCard } from './shareCard.js';
import { topRunsAcrossAll, formatSeedShareString } from './leaderboard.js';
import { createCharCarousel } from './charCarousel.js';
import { GLTF_CACHE } from './assets.js';

// ── Theme constants ──────────────────────────────────────────────────────────
const C = {
  bg:      '#0a1410',
  text:    '#f5efe1',           // off-white parchment
  cyan:    '#7fffe4',           // softer mint
  magenta: '#ff7ad8',           // softer rose
  red:     '#ff5e5e',
  amber:   '#ffd27f',           // warm gold
  green:   '#7ee08a',
  ink:     'rgba(8, 14, 12, 0.86)',
  edge:    'rgba(255, 232, 188, 0.18)',
};
// Font stacks — loaded via Google Fonts in injectFonts()
const F = {
  display: '"Cinzel Decorative", "Cinzel", "Trajan Pro", "Cormorant Garamond", Georgia, serif',
  body:    '"Inter", "Segoe UI", "Helvetica Neue", -apple-system, system-ui, sans-serif',
  mono:    '"JetBrains Mono", "Fira Code", "Consolas", monospace',
};

// ── Build version ────────────────────────────────────────────────────────────
// Flipped to '1.0.0' on the iter-11 ship commit (Shop Tree Live Wires —
// the broken-tier-1-3-consumers gap was the last v1.0 blocker).
export const KK_VERSION = '1.4.26';

// ── Module-local DOM refs ────────────────────────────────────────────────────
let _root = null;
let _hud = null;
let _hpFill = null;
let _xpFill = null;
let _levelText = null;
let _timeText = null;
let _killsText = null;

let _modal = null;
let _modalKeyHandler = null;
let _modalFocusScope = null;

let _deathScreen = null;
let _deathKeyHandler = null;
let _deathClickHandler = null;
let _deathFocusScope = null;

let _startScreen = null;
let _startFocusScope = null;
let _startStageRowRef = null;
let _startCharRowRef = null;
let _startBtnRowRef = null;
let _startPresetRowRef = null;
let _charCarousel = null;
// Iter 32d — two-view start screen. 'menu' = title + meta buttons + Play.
// 'select' = carousel + archetype + stage + preset + Start Run + Back.
// main.js gates click/Space → start by reading getStartView() === 'select'.
let _startView = 'menu';
let _menuPanel = null;
let _selectPanel = null;
export function getStartView() {
  return _startScreen ? _startView : null;
}
function _setStartView(view) {
  if (!_startScreen || !_menuPanel || !_selectPanel) return;
  _startView = view;
  _menuPanel.style.display   = view === 'menu'   ? 'flex' : 'none';
  _selectPanel.style.display = view === 'select' ? 'flex' : 'none';
  try { _refreshStartFocus(); } catch (_) {}
}
export function setStartView(view) { _setStartView(view); }
function _refreshStartFocus() {
  if (!_startScreen) return;
  if (_startFocusScope) { popFocusScope(_startFocusScope); _startFocusScope = null; }
  const chars = _startCharRowRef ? Array.from(_startCharRowRef.children).filter(el => el.style.cursor === 'pointer') : [];
  const stages = _startStageRowRef ? Array.from(_startStageRowRef.children).filter(el => el.style.cursor === 'pointer') : [];
  const presets = _startPresetRowRef ? Array.from(_startPresetRowRef.querySelectorAll('[data-focusable="1"]')) : [];
  const btns = _startBtnRowRef ? Array.from(_startBtnRowRef.querySelectorAll('button')) : [];
  const els = [...chars, ...stages, ...presets, ...btns];
  if (!els.length) return;
  _startFocusScope = pushFocusScope(els, { layout: 'auto' });
}

// Cache last values to avoid DOM thrash
const _last = {
  hpPct: -1,
  hpColor: '',
  xpPct: -1,
  level: -1,
  timeStr: '',
  kills: -1,
};

// ── Google Fonts loader ──────────────────────────────────────────────────────
function injectFonts() {
  if (document.getElementById('kk-fonts')) return;
  // Preconnect to speed up font fetch
  const pre1 = document.createElement('link');
  pre1.rel = 'preconnect'; pre1.href = 'https://fonts.googleapis.com';
  const pre2 = document.createElement('link');
  pre2.rel = 'preconnect'; pre2.href = 'https://fonts.gstatic.com'; pre2.crossOrigin = 'anonymous';
  const link = document.createElement('link');
  link.id = 'kk-fonts'; link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?'
    + 'family=Cinzel+Decorative:wght@700;900'
    + '&family=Cinzel:wght@500;700;900'
    + '&family=Inter:wght@400;500;600;700'
    + '&family=JetBrains+Mono:wght@400;600'
    + '&display=swap';
  document.head.appendChild(pre1);
  document.head.appendChild(pre2);
  document.head.appendChild(link);
}

// ── CSS injection ────────────────────────────────────────────────────────────
function injectCSS() {
  if (document.getElementById('kk-ui-style')) return;
  injectFonts();
  const css = `
    /* ── Reset / base ── */
    #ui-root, #ui-root * { box-sizing: border-box; }
    #ui-root button {
      font-family: ${F.body}; font-weight: 600;
      letter-spacing: 0.18em; text-transform: uppercase;
      transition: transform 0.14s ease, background 0.14s ease, border-color 0.14s ease, box-shadow 0.14s ease;
    }
    #ui-root button:hover, #ui-root button:focus-visible {
      outline: none;
      transform: translateY(-1px);
      box-shadow: 0 4px 16px rgba(127,255,228,0.18), 0 0 0 1px ${C.edge} inset;
    }

    /* ── HUD ── */
    .kk-hud {
      position: absolute; inset: 0;
      pointer-events: none;
      font-family: ${F.body};
      color: ${C.text};
    }
    .kk-hp-wrap {
      position: absolute; top: 22px; left: 22px;
      display: flex; align-items: center; gap: 10px;
      pointer-events: auto;
    }
    .kk-hp-label {
      font-family: ${F.display};
      font-size: 13px; font-weight: 700; letter-spacing: 0.32em;
      color: ${C.amber};
    }
    .kk-hp-bar {
      width: 240px; height: 12px;
      background: rgba(8,14,12,0.72);
      border-radius: 6px;
      box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset,
                  0 0 0 1px ${C.edge} inset,
                  0 2px 12px rgba(0,0,0,0.45);
      position: relative; overflow: hidden;
    }
    .kk-hp-fill {
      height: 100%; width: 100%;
      background: linear-gradient(180deg, #a8ff9a, #4ec56a 65%, #2f8a48);
      border-radius: 6px;
      transition: width 0.12s linear, background 0.2s linear;
    }
    .kk-xp-bar {
      position: absolute; top: 0; left: 0; right: 0;
      height: 4px;
      background: rgba(8,14,12,0.55);
      pointer-events: auto;
    }
    .kk-xp-fill {
      height: 100%; width: 0%;
      background: linear-gradient(90deg, ${C.cyan}, ${C.amber});
      box-shadow: 0 0 8px rgba(127,255,228,0.55);
      transition: width 0.12s linear;
    }
    .kk-stats {
      position: absolute; top: 22px; right: 22px;
      text-align: right;
      pointer-events: auto;
      line-height: 1.35;
    }
    .kk-stats .kk-line {
      font-family: ${F.body};
      font-size: 13px; letter-spacing: 0.14em; opacity: 0.95;
    }
    .kk-stats .kk-level {
      font-family: ${F.display};
      font-size: 30px; font-weight: 900;
      color: ${C.amber};
      letter-spacing: 0.18em;
      text-shadow: 0 2px 12px rgba(0,0,0,0.6);
    }
    .kk-stats .kk-time {
      font-family: ${F.mono};
      font-size: 22px; color: ${C.text};
      letter-spacing: 0.10em;
    }
    .kk-stats .kk-kills {
      font-size: 14px; color: ${C.text}; opacity: 0.88;
      letter-spacing: 0.14em;
    }

    /* ── Modal scaffold ── */
    .kk-modal {
      position: fixed; inset: 0;
      background:
        radial-gradient(ellipse at center, rgba(0,0,0,0.35), rgba(0,0,0,0.72) 75%),
        rgba(8,14,12,0.62);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      pointer-events: auto;
      font-family: ${F.body};
      z-index: 100;
    }
    .kk-modal-title {
      font-family: ${F.display};
      font-size: calc(var(--kk-font-scale, 1) * 44px); font-weight: 900;
      letter-spacing: 0.18em; margin-bottom: 32px;
      color: ${C.amber};
      text-shadow: 0 2px 16px rgba(0,0,0,0.55);
    }
    @keyframes kk-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.72; }
    }
    @keyframes kk-fade-in {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .kk-card-row {
      display: flex; flex-direction: row; gap: 22px;
      max-width: 96vw;
    }
    .kk-card {
      width: 232px; min-height: 296px;
      background: linear-gradient(180deg, rgba(20,28,22,0.92), rgba(8,14,12,0.94));
      border: 1px solid ${C.edge};
      border-radius: 10px;
      box-shadow:
        0 1px 0 rgba(255,255,255,0.04) inset,
        0 18px 32px rgba(0,0,0,0.55),
        0 0 0 1px rgba(0,0,0,0.4);
      padding: 20px 18px; cursor: pointer;
      display: flex; flex-direction: column; align-items: center;
      color: ${C.text};
      animation: kk-fade-in 0.28s ease-out backwards;
    }
    .kk-card:hover, .kk-card:focus {
      transform: translateY(-6px);
      border-color: ${C.amber};
      box-shadow:
        0 1px 0 rgba(255,255,255,0.05) inset,
        0 20px 36px rgba(0,0,0,0.6),
        0 0 22px rgba(255,210,127,0.28);
      outline: none;
    }
    .kk-card-num {
      font-family: ${F.display};
      font-size: calc(var(--kk-font-scale, 1) * 11px); color: ${C.amber};
      margin-bottom: 4px; letter-spacing: 0.32em;
      opacity: 0.8;
    }
    .kk-card-icon {
      font-size: calc(var(--kk-font-scale, 1) * 60px); line-height: 1; margin: 6px 0 10px;
      filter: drop-shadow(0 4px 10px rgba(0,0,0,0.5));
    }
    .kk-card-name {
      font-family: ${F.display};
      font-size: calc(var(--kk-font-scale, 1) * 19px); font-weight: 700; color: ${C.text};
      text-align: center; margin-bottom: 4px;
      letter-spacing: 0.08em;
    }
    .kk-card-level {
      font-family: ${F.body};
      font-size: calc(var(--kk-font-scale, 1) * 11px); color: ${C.amber};
      margin-bottom: 12px; letter-spacing: 0.32em;
      text-transform: uppercase;
    }
    .kk-card-desc {
      font-size: calc(var(--kk-font-scale, 1) * 12.5px); color: rgba(245,239,225,0.78);
      text-align: center; line-height: 1.5;
      flex: 1;
      font-family: ${F.body};
    }

    /* ── Death screen ── */
    .kk-death {
      position: fixed; inset: 0;
      background:
        radial-gradient(ellipse at center, rgba(0,0,0,0.55), rgba(0,0,0,0.92) 78%),
        rgba(8,14,12,0.88);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      pointer-events: auto;
      font-family: ${F.body};
      z-index: 110;
      padding: 32px 16px;
    }
    .kk-death-title {
      font-family: ${F.display};
      font-size: calc(var(--kk-font-scale, 1) * 76px); font-weight: 900; letter-spacing: 0.18em;
      color: ${C.red};
      text-shadow: 0 4px 18px rgba(0,0,0,0.6), 0 0 22px rgba(255,94,94,0.35);
      margin-bottom: 28px;
    }
    .kk-death-stats {
      font-family: ${F.body};
      font-size: calc(var(--kk-font-scale, 1) * 15px); color: ${C.text};
      line-height: 1.9; margin-bottom: 18px;
      text-align: left;
      background: rgba(8,14,12,0.55);
      border: 1px solid ${C.edge}; border-radius: 8px;
      padding: 18px 28px; min-width: min(360px, 90vw);
      letter-spacing: 0.04em;
    }
    .kk-death-stats .kk-stat-val {
      font-family: ${F.mono};
      color: ${C.amber};
      float: right; margin-left: 18px;
    }
    .kk-death-hint {
      font-size: calc(var(--kk-font-scale, 1) * 12px); color: rgba(245,239,225,0.7);
      letter-spacing: 0.28em; text-transform: uppercase;
      margin-top: 10px;
    }

    /* ── Start screen ── */
    .kk-start {
      position: fixed; inset: 0;
      background:
        radial-gradient(ellipse at 50% 30%, rgba(127,255,228,0.08), transparent 60%),
        radial-gradient(ellipse at center, rgba(0,0,0,0.55), rgba(0,0,0,0.88) 80%);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      display: flex; flex-direction: column;
      align-items: center; justify-content: flex-start;
      overflow-y: auto; overflow-x: hidden;
      padding: clamp(12px, 2vh, 24px) 20px clamp(24px, 6vh, 60px);
      gap: clamp(2px, 0.6vh, 8px);
      pointer-events: auto;
      font-family: ${F.body};
      z-index: 90;
    }
    .kk-start-title {
      font-family: ${F.display};
      font-size: clamp(28px, calc(var(--kk-font-scale, 1) * 5.2vw), calc(var(--kk-font-scale, 1) * 56px));
      font-weight: 900;
      letter-spacing: 0.22em;
      color: ${C.amber};
      text-shadow:
        0 2px 20px rgba(0,0,0,0.65),
        0 0 36px rgba(255,210,127,0.25);
      margin-bottom: 6px;
      text-align: center;
      line-height: 1.05;
    }
    .kk-start-sub {
      font-family: ${F.body};
      font-size: calc(var(--kk-font-scale, 1) * 13px); color: rgba(245,239,225,0.78);
      letter-spacing: 0.34em; text-transform: uppercase;
      animation: kk-pulse 1.6s ease-in-out infinite;
    }

    /* ── Panel chrome — used for shop / grimoire / options ── */
    .kk-panel {
      background: linear-gradient(180deg, rgba(20,28,22,0.94), rgba(8,14,12,0.96));
      border: 1px solid ${C.edge};
      border-radius: 12px;
      box-shadow:
        0 1px 0 rgba(255,255,255,0.04) inset,
        0 24px 48px rgba(0,0,0,0.65);
      padding: 24px 28px;
      animation: kk-fade-in 0.28s ease-out;
    }

    /* ── Mobile ── */
    /* Iter 21b — drop hardcoded font-size overrides so the global --kk-font-scale
       responsive default (set in index.html @media block) actually reaches modal
       text. We keep layout overrides (column cards, narrower HP bar) since those
       aren't covered by the scale var. */
    @media (max-width: 600px) {
      .kk-card-row { flex-direction: column; gap: 12px; }
      .kk-card { width: 80vw; min-height: 0; padding: 12px; }
      .kk-card-icon { margin: 4px 0 8px; }
      .kk-modal-title { margin-bottom: 18px; }
      .kk-hp-bar { width: 150px; }
    }
    /* ──────────────────────────────────────────────────────────────────
       Iter 29b — unified menu visual polish.
       Layered ON TOP of the original class rules; reinforces consistency
       across every modal (start screen, death, options, shop, house,
       grimoire, quests, casino, hall, codex). Tokens stay in C/F so the
       design language stays single-source.
       ────────────────────────────────────────────────────────────────── */
    /* Modal scaffold — richer backdrop, smooth fade-in entry */
    .kk-modal, .kk-death, .kk-start {
      animation: kk-modal-in 0.32s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes kk-modal-in {
      from { opacity: 0; backdrop-filter: blur(0px); -webkit-backdrop-filter: blur(0px); }
      to   { opacity: 1; }
    }
    /* Modal title — ornamental gold underline that draws in on entry */
    .kk-modal-title {
      position: relative;
      padding-bottom: 14px;
    }
    .kk-modal-title::after {
      content: '';
      position: absolute; left: 50%; bottom: 0;
      width: 220px; height: 2px;
      transform: translateX(-50%);
      background: linear-gradient(90deg,
        transparent 0%,
        ${C.amber} 18%,
        ${C.amber} 50%,
        ${C.amber} 82%,
        transparent 100%);
      box-shadow: 0 0 14px ${C.amber}66;
      animation: kk-underline-in 0.6s cubic-bezier(0.4, 0, 0.2, 1) 0.18s backwards;
    }
    @keyframes kk-underline-in {
      from { transform: translateX(-50%) scaleX(0); opacity: 0; }
      to   { transform: translateX(-50%) scaleX(1); opacity: 1; }
    }
    /* Panel — subtle inner glow + animated top edge highlight */
    .kk-panel {
      position: relative;
      background: linear-gradient(180deg, rgba(22,32,26,0.92), rgba(8,14,12,0.96)) !important;
      border-color: rgba(255,210,127,0.22) !important;
      box-shadow:
        0 1px 0 rgba(255,255,255,0.06) inset,
        0 0 0 1px rgba(0,0,0,0.45) inset,
        0 12px 28px rgba(0,0,0,0.55),
        0 0 0 1px rgba(255,210,127,0.08) !important;
    }
    .kk-panel::before {
      content: '';
      position: absolute; top: -1px; left: 14%; right: 14%; height: 1px;
      background: linear-gradient(90deg, transparent, ${C.amber}, transparent);
      opacity: 0.45;
      pointer-events: none;
    }
    /* Card hover — slightly lifted glow + amber edge sheen */
    .kk-card {
      transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;
    }
    .kk-card:hover, .kk-card:focus {
      transform: translateY(-6px) scale(1.015);
    }
    /* ── Button system (3 tiers) ──
       Apply via .kk-btn-primary / .kk-btn-secondary / .kk-btn-danger.
       Existing inline-styled buttons stay; new code can opt in. */
    .kk-btn-primary, .kk-btn-secondary, .kk-btn-danger {
      padding: 11px 24px;
      border-radius: 8px;
      font-family: ${F.display};
      font-size: calc(var(--kk-font-scale, 1) * 13px);
      font-weight: 700;
      letter-spacing: 0.28em;
      text-transform: uppercase;
      cursor: pointer;
      transition: transform 0.14s ease, border-color 0.14s ease,
                  box-shadow 0.18s ease, background 0.18s ease, color 0.18s ease;
      backdrop-filter: blur(2px);
    }
    .kk-btn-primary {
      background: linear-gradient(180deg, rgba(28,34,30,0.95), rgba(12,18,14,0.95));
      border: 1px solid ${C.amber};
      color: ${C.amber};
      box-shadow:
        0 1px 0 rgba(255,255,255,0.06) inset,
        0 8px 22px rgba(0,0,0,0.5),
        0 0 18px rgba(255,210,127,0.18);
    }
    .kk-btn-primary:hover, .kk-btn-primary:focus-visible {
      transform: translateY(-2px);
      background: linear-gradient(180deg, rgba(48,40,28,0.95), rgba(28,22,14,0.95));
      box-shadow:
        0 1px 0 rgba(255,255,255,0.08) inset,
        0 14px 28px rgba(0,0,0,0.55),
        0 0 26px rgba(255,210,127,0.45);
    }
    .kk-btn-secondary {
      background: linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86));
      border: 1px solid ${C.edge};
      color: ${C.text};
      box-shadow:
        0 1px 0 rgba(255,255,255,0.04) inset,
        0 6px 18px rgba(0,0,0,0.5);
    }
    .kk-btn-secondary:hover, .kk-btn-secondary:focus-visible {
      transform: translateY(-2px);
      border-color: ${C.cyan};
      color: ${C.cyan};
      box-shadow:
        0 1px 0 rgba(255,255,255,0.06) inset,
        0 12px 24px rgba(0,0,0,0.55),
        0 0 22px rgba(127,255,228,0.22);
    }
    .kk-btn-danger {
      background: linear-gradient(180deg, rgba(40,16,16,0.95), rgba(20,8,8,0.95));
      border: 1px solid ${C.red};
      color: ${C.red};
      box-shadow:
        0 1px 0 rgba(255,255,255,0.04) inset,
        0 8px 22px rgba(0,0,0,0.5),
        0 0 18px rgba(255,94,94,0.18);
    }
    .kk-btn-danger:hover, .kk-btn-danger:focus-visible {
      transform: translateY(-2px);
      background: linear-gradient(180deg, rgba(64,20,20,0.95), rgba(28,10,10,0.95));
      box-shadow:
        0 1px 0 rgba(255,255,255,0.06) inset,
        0 14px 28px rgba(0,0,0,0.55),
        0 0 26px rgba(255,94,94,0.45);
    }
    /* Section headers shared across modals — uppercase amber chip with rule */
    .kk-section-hdr {
      font-family: ${F.display};
      font-size: calc(var(--kk-font-scale, 1) * 12px);
      font-weight: 700;
      letter-spacing: 0.36em;
      color: ${C.amber};
      text-transform: uppercase;
      padding: 0 0 8px 0;
      margin: 4px 0 10px 0;
      border-bottom: 1px solid rgba(255,210,127,0.22);
      position: relative;
    }
    .kk-section-hdr::after {
      content: '';
      position: absolute; left: 0; bottom: -1px;
      width: 36px; height: 1px;
      background: ${C.amber};
      box-shadow: 0 0 6px ${C.amber};
    }
    /* Scrollbar polish — dark-themed thin scrollbar in modal panels */
    .kk-modal::-webkit-scrollbar,
    .kk-death::-webkit-scrollbar,
    .kk-panel::-webkit-scrollbar {
      width: 8px; height: 8px;
    }
    .kk-modal::-webkit-scrollbar-track,
    .kk-death::-webkit-scrollbar-track,
    .kk-panel::-webkit-scrollbar-track {
      background: rgba(8,14,12,0.55);
      border-radius: 4px;
    }
    .kk-modal::-webkit-scrollbar-thumb,
    .kk-death::-webkit-scrollbar-thumb,
    .kk-panel::-webkit-scrollbar-thumb {
      background: linear-gradient(180deg, ${C.amber}88, ${C.amber}44);
      border-radius: 4px;
      border: 1px solid rgba(0,0,0,0.4);
    }
    .kk-modal::-webkit-scrollbar-thumb:hover,
    .kk-death::-webkit-scrollbar-thumb:hover,
    .kk-panel::-webkit-scrollbar-thumb:hover {
      background: ${C.amber};
    }
    /* Generic global override — make every button feel snappier */
    #ui-root button:active { transform: translateY(0); transition-duration: 0.05s; }

    /* ─────────────────────────────────────────────────────────────────
       Iter 29c — ornamental corner frames.
       Every .kk-panel auto-receives four gold corner pieces (procedural
       SVG data-URIs, ~150 bytes each). On top of the existing panel
       gradient — no JS change, pure CSS layering. Adds the "real game
       UI / Hades-style ward" feel without external assets. */
    .kk-panel {
      background-image:
        url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Cg fill='none' stroke='%23ffd27f' stroke-width='1.3' stroke-linecap='round' opacity='0.85'%3E%3Cpath d='M 4 4 L 18 4 M 4 4 L 4 18'/%3E%3Ccircle cx='4' cy='4' r='1.6' fill='%23ffd27f' stroke='none'/%3E%3Cpath d='M 18 4 Q 24 5, 22 11'/%3E%3Cpath d='M 4 18 Q 5 24, 11 22'/%3E%3C/g%3E%3C/svg%3E"),
        url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Cg fill='none' stroke='%23ffd27f' stroke-width='1.3' stroke-linecap='round' opacity='0.85'%3E%3Cpath d='M 36 4 L 22 4 M 36 4 L 36 18'/%3E%3Ccircle cx='36' cy='4' r='1.6' fill='%23ffd27f' stroke='none'/%3E%3Cpath d='M 22 4 Q 16 5, 18 11'/%3E%3Cpath d='M 36 18 Q 35 24, 29 22'/%3E%3C/g%3E%3C/svg%3E"),
        url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Cg fill='none' stroke='%23ffd27f' stroke-width='1.3' stroke-linecap='round' opacity='0.85'%3E%3Cpath d='M 4 36 L 18 36 M 4 36 L 4 22'/%3E%3Ccircle cx='4' cy='36' r='1.6' fill='%23ffd27f' stroke='none'/%3E%3Cpath d='M 18 36 Q 24 35, 22 29'/%3E%3Cpath d='M 4 22 Q 5 16, 11 18'/%3E%3C/g%3E%3C/svg%3E"),
        url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Cg fill='none' stroke='%23ffd27f' stroke-width='1.3' stroke-linecap='round' opacity='0.85'%3E%3Cpath d='M 36 36 L 22 36 M 36 36 L 36 22'/%3E%3Ccircle cx='36' cy='36' r='1.6' fill='%23ffd27f' stroke='none'/%3E%3Cpath d='M 22 36 Q 16 35, 18 29'/%3E%3Cpath d='M 36 22 Q 35 16, 29 18'/%3E%3C/g%3E%3C/svg%3E"),
        linear-gradient(180deg, rgba(22,32,26,0.92), rgba(8,14,12,0.96)) !important;
      background-position: top left, top right, bottom left, bottom right, 0 0 !important;
      background-repeat: no-repeat, no-repeat, no-repeat, no-repeat, no-repeat !important;
      background-size: 40px 40px, 40px 40px, 40px 40px, 40px 40px, cover !important;
    }

    /* Cards get a subtler treatment — single top-edge flourish only,
       since 4 corners are visually heavy on a 232px-wide card. */
    .kk-card {
      background-image:
        url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 12'%3E%3Cg fill='none' stroke='%23ffd27f' stroke-width='1' stroke-linecap='round' opacity='0.7'%3E%3Cline x1='12' y1='6' x2='48' y2='6'/%3E%3Cline x1='72' y1='6' x2='108' y2='6'/%3E%3Ccircle cx='60' cy='6' r='1.8' fill='%23ffd27f' stroke='none'/%3E%3Ccircle cx='12' cy='6' r='1.0' fill='%23ffd27f' stroke='none'/%3E%3Ccircle cx='108' cy='6' r='1.0' fill='%23ffd27f' stroke='none'/%3E%3C/g%3E%3C/svg%3E"),
        linear-gradient(180deg, rgba(20,28,22,0.92), rgba(8,14,12,0.94)) !important;
      background-position: center 8px, 0 0 !important;
      background-repeat: no-repeat, no-repeat !important;
      background-size: 80% 12px, cover !important;
    }

    /* Iter 29 — small-screen modal fits.
       Modals are full-viewport flex containers; cards/grids inside use
       minmax(280-320px, 1fr) which doesn't shrink past their min and
       overflows narrow viewports. Force responsive overrides below 720px
       so every modal stays inside the viewport without horizontal scroll. */
    @media (max-width: 720px) {
      .kk-fs-xl { font-size: calc(var(--kk-font-scale, 1) * 22px) !important; }
      .kk-fs-lg { font-size: calc(var(--kk-font-scale, 1) * 17px) !important; }
      .kk-fs-md { font-size: calc(var(--kk-font-scale, 1) * 14px) !important; }
      .kk-fs-sm { font-size: calc(var(--kk-font-scale, 1) * 12px) !important; }
    }
    @media (max-width: 480px) {
      /* Force every grid-template-columns: repeat(auto-fill, minmax(NNNpx, 1fr))
         pattern to single-column. Catches Shop / House / Grimoire / Quest /
         Codex / Hall of Records / Casino card grids without per-modal CSS. */
      [style*="grid-template-columns: repeat(auto-fill"] { grid-template-columns: 1fr !important; }
      /* Cards/inputs hard-floor */
      button, input, select, textarea { max-width: 100%; }
      /* Modal containers — clamp padding so headers don't bleed off-screen. */
      .kk-death, .kk-start { padding: 18px 10px !important; }
    }
    /* Catch-all — never let any modal overflow horizontally. */
    body { overflow-x: hidden; }
  `;
  const style = document.createElement('style');
  style.id = 'kk-ui-style';
  style.textContent = css;
  document.head.appendChild(style);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function hpColorFor(pct) {
  if (pct < 0.30) return C.red;
  if (pct < 0.60) return C.amber;
  return C.green;
}

// ── Iter-9 helpers: share clipboard + small green toast ─────────────────────
// `copyTextToClipboard` prefers navigator.clipboard.writeText (HTTPS / modern)
// but falls back to a hidden textarea + execCommand('copy') so the affordance
// still works on localhost dev and older browsers. Returns a Promise<boolean>.
function copyTextToClipboard(text) {
  const s = String(text == null ? '' : text);
  // Modern path
  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
    try {
      return navigator.clipboard.writeText(s).then(() => true).catch(() => _fallbackCopy(s));
    } catch (_) { /* fall through to fallback */ }
  }
  return Promise.resolve(_fallbackCopy(s));
}
function _fallbackCopy(s) {
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed; left:-9999px; top:0; opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch (_) { return false; }
}

// 1.4s green pulse — matches the achievement toast cadence called out in the
// iter-9 tuning table. Anchored top-center so it doesn't fight the death/start
// modals stacked beneath it.
function _kkShowMicroToast(text, color) {
  const root = _root || document.getElementById('ui-root') || document.body;
  if (!root) return;
  // Iter 18 — auto-fire UI error SFX when caller passed the red color (the
  // existing "Share failed" / "Copy failed" call sites are the contract). The
  // green/amber/cyan toasts stay silent so success acks don't double-cue with
  // the uiClick that triggered them.
  if (color === C.red) { try { sfx.uiError(); } catch (_) {} }
  const toast = document.createElement('div');
  const col = color || C.green;
  toast.style.cssText = `
    position: fixed; left: 50%; top: 12%;
    transform: translateX(-50%);
    padding: 8px 18px;
    background: linear-gradient(180deg, rgba(20,28,22,0.86), rgba(8,14,12,0.92));
    border: 1px solid ${col};
    border-radius: 8px;
    font-family: ${F.body};
    font-size: 12px; letter-spacing: 0.22em; text-transform: uppercase;
    color: ${col};
    text-shadow: 0 0 6px ${col}55;
    box-shadow: 0 8px 22px rgba(0,0,0,0.55), 0 0 18px ${col}33;
    pointer-events: none;
    z-index: 200;
    animation: kk-fade-in 0.18s ease-out;
  `;
  toast.textContent = text;
  root.appendChild(toast);
  setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 1400);
}

// Compose a runHistory-style entry from the live state — what we hand to the
// share-card renderer when there's no committed runHistory entry yet. Mirrors
// recordRunResult's shape (see src/runHistory.js).
function _runEntryFromState() {
  if (!state) return null;
  const stageId = (state.run && state.run.stage && state.run.stage.id) || 'forest';
  const charId  = (state.run && state.run.character) || 'kitty';
  const mode    = state.modes && state.modes.hyper ? 'hyper'
              : state.modes && state.modes.endless ? 'endless'
              : state.modes && state.modes.daily ? 'daily'
              : state.modes && state.modes.weekly ? 'weekly'
              : state.modes && state.modes.bossRush ? 'boss-rush'
              : 'normal';
  const weaponsUsed = Array.isArray(state.weapons)
    ? state.weapons.map(w => ({ id: w.id, level: w.level || 1, evolved: !!(w.inst && w.inst.evolved) }))
    : [];
  return {
    stage: stageId,
    character: charId,
    mode,
    durationSec: Math.max(0, Math.floor((state.time && state.time.game) || 0)),
    level: (state.hero && state.hero.level) || 0,
    kills: (state.run && state.run.kills) || 0,
    dmgDealt: Math.floor((state.run && state.run.dmgDealt) || 0),
    weaponsUsed,
    outcome: state.victory ? 'victory' : 'death',
    endedAt: new Date().toISOString(),
    // The committed entry will have a seed; the leaderboard's makeSeed is
    // available at share time but we leave the fallback to shareCard.js.
  };
}

function getRegistry() {
  // weapons/index.js exports REGISTRY (id → {name, desc, icon, ...})
  // It may not be loaded yet at module-evaluation time; dynamic import-with-cache.
  if (_registry) return _registry;
  return null;
}
let _registry = null;
async function loadRegistry() {
  if (_registry) return _registry;
  try {
    const m = await import('./weapons/index.js');
    _registry = m.REGISTRY || m.default || {};
  } catch (e) {
    _registry = {};
  }
  return _registry;
}

// ── Public API ───────────────────────────────────────────────────────────────

export function initUI() {
  injectCSS();
  _root = document.getElementById('ui-root');
  if (!_root) {
    console.error('[ui] #ui-root not found');
    return;
  }
  // Iter 10a accessibility: make ui-root a polite live region so screen
  // readers announce toasts (achievements, secrets, run-end summaries)
  // without interrupting the user's current focus.
  if (!_root.hasAttribute('aria-live')) {
    _root.setAttribute('aria-live', 'polite');
    _root.setAttribute('aria-relevant', 'additions text');
  }

  // Try to warm registry cache (non-blocking)
  loadRegistry();

  // Build HUD container
  _hud = document.createElement('div');
  _hud.className = 'kk-hud';

  // XP bar (top, full-width thin)
  const xpBar = document.createElement('div');
  xpBar.className = 'kk-xp-bar';
  _xpFill = document.createElement('div');
  _xpFill.className = 'kk-xp-fill';
  xpBar.appendChild(_xpFill);

  // HP bar (top-left)
  const hpWrap = document.createElement('div');
  hpWrap.className = 'kk-hp-wrap';
  hpWrap.style.top = '20px'; // below xp strip
  const hpLabel = document.createElement('div');
  hpLabel.className = 'kk-hp-label';
  hpLabel.textContent = 'HP';
  const hpBar = document.createElement('div');
  hpBar.className = 'kk-hp-bar';
  _hpFill = document.createElement('div');
  _hpFill.className = 'kk-hp-fill';
  hpBar.appendChild(_hpFill);
  hpWrap.appendChild(hpLabel);
  hpWrap.appendChild(hpBar);

  // Stats (top-right)
  const stats = document.createElement('div');
  stats.className = 'kk-stats';
  _levelText = document.createElement('div');
  _levelText.className = 'kk-line kk-level';
  _levelText.textContent = 'LV 1';
  _timeText = document.createElement('div');
  _timeText.className = 'kk-line kk-time';
  _timeText.textContent = '00:00';
  _killsText = document.createElement('div');
  _killsText.className = 'kk-line kk-kills';
  _killsText.textContent = 'KILLS 0';
  // Next mini-boss countdown (small, below kills)
  _nextBossText = document.createElement('div');
  _nextBossText.className = 'kk-line';
  _nextBossText.style.cssText = `font-size: 12px; color: ${C.amber}; letter-spacing: 2px; text-shadow: 0 0 6px ${C.amber}; margin-top: 4px;`;

  _dpsText = document.createElement('div');
  _dpsText.className = 'kk-line';
  _dpsText.style.cssText = `font-size: 12px; color: ${C.green}; letter-spacing: 2px; text-shadow: 0 0 6px ${C.green};`;
  _dpsText.textContent = 'DPS 0';

  stats.appendChild(_levelText);
  stats.appendChild(_timeText);
  stats.appendChild(_killsText);
  stats.appendChild(_dpsText);
  stats.appendChild(_nextBossText);

  // Dash readout (bottom-left)
  _dashReadout = document.createElement('div');
  _dashReadout.style.cssText = `position: absolute; bottom: 16px; left: 16px;
    font-family: ${F.body}; font-size: 14px; letter-spacing: 2px;
    color: ${C.cyan}; text-shadow: 0 0 8px ${C.cyan}; display: none;`;

  // Weapon roster — bottom-right HUD chip showing icons + level pips
  _weaponPanel = document.createElement('div');
  _weaponPanel.style.cssText = `
    position: absolute; bottom: 16px; right: 16px;
    display: flex; gap: 8px;
    font-family: ${F.body};
    pointer-events: none;
  `;

  _hud.appendChild(xpBar);
  _hud.appendChild(hpWrap);
  _hud.appendChild(stats);
  _hud.appendChild(_dashReadout);
  _hud.appendChild(_weaponPanel);
  _root.appendChild(_hud);

  // Persistent button-prompt legend (bottom-right, swaps glyphs by device).
  mountPromptLegend(_hud);
}

let _dashReadout = null;
let _weaponPanel = null;
let _nextBossText = null;
let _dpsText = null;
const _weaponCells = new Map(); // id -> {wrap, level}

export function updateUI() {
  if (!_hpFill) return;
  const h = state.hero;

  // HP
  const hpPct = Math.max(0, Math.min(1, h.hp / Math.max(1, h.hpMax)));
  if (hpPct !== _last.hpPct) {
    _hpFill.style.width = (hpPct * 100).toFixed(1) + '%';
    _last.hpPct = hpPct;
  }
  const col = hpColorFor(hpPct);
  if (col !== _last.hpColor) {
    _hpFill.style.background = col;
    _hpFill.style.color = col; // for currentColor shadow
    _last.hpColor = col;
  }

  // XP
  const xpPct = Math.max(0, Math.min(1, h.xp / Math.max(1, h.xpNext)));
  if (xpPct !== _last.xpPct) {
    _xpFill.style.width = (xpPct * 100).toFixed(1) + '%';
    _last.xpPct = xpPct;
  }

  // Level
  if (h.level !== _last.level) {
    _levelText.textContent = `LV ${h.level}`;
    _last.level = h.level;
  }

  // Time
  const t = fmtTime(state.time.game);
  if (t !== _last.timeStr) {
    _timeText.textContent = t;
    _last.timeStr = t;
  }

  // Kills
  if (state.run.kills !== _last.kills) {
    _killsText.textContent = `KILLS ${state.run.kills}`;
    _last.kills = state.run.kills;
  }

  // DPS — sliding-window mean over last 5s
  if (_dpsText) {
    const win = state.run._dpsWin;
    const now = state.time.game;
    const cutoff = now - 5;
    while (win.length > 0 && win[0][0] < cutoff) win.shift();
    let sum = 0;
    for (let i = 0; i < win.length; i++) sum += win[i][1];
    const dps = sum / 5;
    const fmt = dps >= 1000 ? (dps/1000).toFixed(1) + 'K' : Math.round(dps).toString();
    _dpsText.textContent = `DPS ${fmt}`;
  }

  // Mini-boss countdown (uses globally-attached fn to avoid frame-time imports)
  if (_nextBossText && typeof window.__kkNextMiniBoss === 'function') {
    const sec = window.__kkNextMiniBoss();
    if (sec === null) _nextBossText.textContent = '';
    else _nextBossText.textContent = `ELITE IN ${fmtTime(sec)}`;
  }

  // Weapon panel (rebuild only when the weapon set/levels change)
  if (_weaponPanel) _updateWeaponPanel();

  // Dash readout
  if (_dashReadout) {
    if (h.dashUnlocked) {
      _dashReadout.style.display = 'block';
      const ready = h.dashCD <= 0;
      _dashReadout.textContent = ready
        ? `DASH READY [SHIFT]  Lv${h.dashLevel}`
        : `DASH ${h.dashCD.toFixed(1)}s  Lv${h.dashLevel}`;
      _dashReadout.style.opacity = ready ? '1' : '0.6';
    } else {
      _dashReadout.style.display = 'none';
    }
  }
}

export function showLevelUpModal(choices) {
  // Iter 21a — kill any hover tooltip before this modal covers the source el.
  // Without this, click-through into a modal leaves the tooltip floating at
  // z:9999 with no mouseleave fired (the source detaches / gets occluded).
  try { hideTooltip(); } catch (_) {}
  if (_modal) hideLevelUpModal();

  const registry = _registry || {};
  // Try to ensure registry is loaded (fire-and-forget; cards will fall back gracefully)
  if (!_registry) loadRegistry().then(() => {
    // If modal still open, repaint card contents
    if (_modal) repaintCards(choices);
  });

  _modal = document.createElement('div');
  _modal.className = 'kk-modal';

  const title = document.createElement('div');
  title.className = 'kk-modal-title';
  // Iter 32i — show queue count when multiple levels are pending so the
  // player understands the cascade ("Level Up · 3 more after this").
  const remaining = state && state.pendingLevelCount ? state.pendingLevelCount : 1;
  title.textContent = remaining > 1 ? `Level Up · +${remaining - 1} more` : 'Level Up';
  _modal.appendChild(title);
  const sub = document.createElement('div');
  sub.style.cssText = `font-family: ${F.body}; font-size: calc(var(--kk-font-scale, 1) * 12px); letter-spacing: 0.34em;
    color: rgba(245,239,225,0.62); text-transform: uppercase; margin: -22px 0 28px;`;
  sub.textContent = remaining > 1 ? `Cascade — pick to continue` : 'Choose your path';
  _modal.appendChild(sub);

  const row = document.createElement('div');
  row.className = 'kk-card-row';
  row.dataset.role = 'cards';
  _modal.appendChild(row);

  // Reroll / skip controls (only show when player has charges)
  const qolRow = document.createElement('div');
  qolRow.style.cssText = 'display:flex; gap:14px; margin-top:24px; pointer-events:auto;';
  function qolBtn(label, accent, charges) {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `${label} <span style="font-family:${F.mono};font-size:calc(var(--kk-font-scale, 1) * 11px);opacity:0.78;margin-left:6px;">×${charges}</span>`;
    b.style.cssText = `padding: 10px 22px; cursor: pointer;
      background: linear-gradient(180deg, rgba(20,28,22,0.86), rgba(8,14,12,0.92));
      border: 1px solid ${C.edge}; border-radius: 8px;
      color: ${accent};
      font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 13px); font-weight: 700;
      letter-spacing: 0.26em;
      box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 20px rgba(0,0,0,0.5);`;
    return b;
  }
  function rebuildQol() {
    qolRow.innerHTML = '';
    if (state.hero.rerolls > 0) {
      // Reroll bound to Q on kbm (no semantic action in the prompt map);
      // render a Q pill directly so the visual style matches.
      const qPill = `<span class="kk-prompt" style="--kk-prompt-color:${C.cyan}">Q</span>`;
      const b = qolBtn(`${qPill}Reroll`, C.cyan, state.hero.rerolls);
      b.onclick = () => doReroll();
      qolRow.appendChild(b);
    }
    if (state.hero.skips > 0) {
      const b = qolBtn(`${formatPrompt('interact', '')}Skip`, C.amber, state.hero.skips);
      b.onclick = () => doSkip();
      qolRow.appendChild(b);
    }
  }
  function doReroll() {
    if (state.hero.rerolls <= 0) return;
    state.hero.rerolls -= 1;
    import('./weapons/index.js').then(({ weaponChoices }) => {
      const fresh = weaponChoices(3 + ((state && state.run && state.run.casinoExtraChoices) || 0));
      state.levelUpChoices = fresh;
      paintCards(row, fresh, _registry || {});
      rebuildQol();
      if (typeof row._kkRefreshFocus === 'function') row._kkRefreshFocus();
    });
  }
  function doSkip() {
    if (state.hero.skips <= 0) return;
    state.hero.skips -= 1;
    // Iter 32i — Skip burns one queued level too. If more queued, re-open
    // with a fresh roll; else close.
    state.pendingLevelCount = Math.max(0, (state.pendingLevelCount || 1) - 1);
    state.levelUpChoices.length = 0;
    hideLevelUpModal();
    if (state.pendingLevelCount > 0) {
      import('./weapons/index.js').then(({ weaponChoices }) => {
        state.pendingLevelUp = true;
        state.levelUpChoices = weaponChoices(3 + ((state && state.run && state.run.casinoExtraChoices) || 0));
        showLevelUpModal(state.levelUpChoices);
      });
    } else {
      state.pendingLevelUp = false;
    }
  }
  _modal.appendChild(qolRow);
  rebuildQol();

  _root.appendChild(_modal);

  paintCards(row, choices, registry);

  // Refresh focus scope — called any time cards or qol buttons are rebuilt.
  const refreshFocusScope = () => {
    if (_modalFocusScope) { popFocusScope(_modalFocusScope); _modalFocusScope = null; }
    const cards = Array.from(row.querySelectorAll('.kk-card'));
    const qolBtns = Array.from(qolRow.querySelectorAll('button'));
    _modalFocusScope = pushFocusScope([...cards, ...qolBtns], { layout: 'auto' });
  };
  row._kkRefreshFocus = refreshFocusScope;
  refreshFocusScope();

  _modalKeyHandler = (e) => {
    if (e.code === 'Digit1' || e.key === '1') pickChoice(state.levelUpChoices, 0);
    else if (e.code === 'Digit2' || e.key === '2') pickChoice(state.levelUpChoices, 1);
    else if (e.code === 'Digit3' || e.key === '3') pickChoice(state.levelUpChoices, 2);
    else if (e.code === 'KeyQ') doReroll();
    else if (e.code === 'KeyE') doSkip();
  };
  window.addEventListener('keydown', _modalKeyHandler);
}

function paintCards(row, choices, registry) {
  row.innerHTML = '';
  choices.forEach((choice, i) => {
    const entry = (registry && registry[choice.id]) || {};
    // Filler/evolution choices carry their own name/desc/icon on the choice object.
    const icon = choice.icon || entry.icon || '★';
    const name = choice.name || entry.name || choice.id || 'Unknown';
    const desc = choice.desc || entry.desc || (choice.kind === 'passive' ? 'Passive bonus' : 'Weapon');
    const lvl = choice.level || 1;

    const card = document.createElement('button');
    card.className = 'kk-card';
    card.type = 'button';
    if (choice.kind === 'evolution') {
      // Make evolution cards visually distinct — gold border, "EVOLVE" tag
      card.style.borderColor = C.amber;
      card.style.boxShadow = `0 0 18px ${C.amber}, 0 0 32px ${C.amber}`;
    } else if (choice.kind === 'passive') {
      // Passives get a cyan accent so they read as a distinct slot type.
      card.style.borderColor = C.cyan;
      card.style.boxShadow = `0 1px 0 rgba(255,255,255,0.04) inset, 0 12px 26px rgba(0,0,0,0.55), 0 0 18px rgba(127,255,228,0.18)`;
    }
    const levelLine =
      choice.kind === 'evolution' ? `<div class="kk-card-level" style="color:${C.amber}">★ EVOLUTION ★</div>` :
      choice.kind === 'passive'   ? `<div class="kk-card-level" style="color:${C.cyan}">PASSIVE · LV ${lvl}</div>` :
                                    `<div class="kk-card-level">Lv ${lvl}</div>`;
    card.innerHTML = `
      <div class="kk-card-num">[${i + 1}]</div>
      <div class="kk-card-icon">${icon}</div>
      <div class="kk-card-name">${escapeHtml(name)}</div>
      ${levelLine}
      <div class="kk-card-desc">${escapeHtml(desc)}</div>
    `;
    card.addEventListener('click', () => pickChoice(choices, i));
    // Rich tooltip with current → next stats so the player understands the pick.
    bindTooltip(card, () => buildChoiceTooltip(choice));
    row.appendChild(card);
  });
}

// Build a tooltip-card content object for any level-up choice (weapon, passive,
// evolution, or filler). Lives near paintCards so changes stay co-located.
function buildChoiceTooltip(choice) {
  if (!choice) return null;
  if (choice.kind === 'evolution') {
    return {
      title: choice.name || 'Evolution',
      icon: choice.icon || '★',
      body: (choice.desc || '') + '\n\nEvolutions are permanent: this transforms the base weapon into its ultimate form for the rest of the run.',
      tags: ['Evolution', 'AoE'],
      accent: '#ffd27f',
    };
  }
  if (choice.kind === 'passive') {
    // Passives stack from level 1; compare to current level if owned.
    const owned = (state.passives || []).find(p => p.id === choice.id);
    const prev = owned ? owned.level : 0;
    const b = passiveBlurb(choice.id, choice.level);
    if (!b) return { title: choice.name || 'Passive', body: choice.desc || '' };
    return {
      title: b.name + (prev ? ` · Lv ${prev}→${choice.level}` : ` · Lv ${choice.level}`),
      icon: b.icon,
      body: b.flavor + '\n\n' + b.body,
      tags: b.tags,
      stats: passiveStatRows(choice.id, choice.level, prev || undefined),
      accent: '#7fffe4',
    };
  }
  if (choice.kind === 'filler') {
    const b = fillerBlurb(choice.id);
    return {
      title: choice.name || 'Bonus',
      icon: choice.icon || '★',
      body: (b ? b.flavor : (choice.desc || '')),
      tags: b ? b.tags : ['Utility'],
      accent: '#7ee08a',
    };
  }
  // weapon (default)
  const owned = state.weapons && state.weapons.find(w => w.id === choice.id);
  const prevLevel = owned ? owned.level : 0;
  const wb = weaponBlurb(choice.id, choice.level);
  if (!wb) {
    return { title: choice.name || choice.id, body: choice.desc || '' };
  }
  return {
    title: wb.name + (prevLevel ? ` · Lv ${prevLevel}→${choice.level}` : ` · NEW · Lv ${choice.level}`),
    icon: wb.icon,
    body: wb.flavor + '\n\n' + wb.body,
    tags: wb.tags,
    stats: weaponStatRows(choice.id, choice.level, prevLevel || undefined),
    accent: '#7fffe4',
  };
}

function repaintCards(choices) {
  if (!_modal) return;
  const row = _modal.querySelector('[data-role="cards"]');
  if (row) paintCards(row, choices, _registry || {});
}

function pickChoice(choices, idx) {
  const c = choices[idx];
  if (!c) return;
  import('./xp.js').then(m => {
    if (m && typeof m.applyLevelUpChoice === 'function') m.applyLevelUpChoice(c);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[ch]));
}

export function hideLevelUpModal() {
  if (_modalKeyHandler) {
    window.removeEventListener('keydown', _modalKeyHandler);
    _modalKeyHandler = null;
  }
  if (_modalFocusScope) { popFocusScope(_modalFocusScope); _modalFocusScope = null; }
  if (_modal && _modal.parentNode) _modal.parentNode.removeChild(_modal);
  _modal = null;
  hideTooltip();
}

export function showDeathScreen() {
  if (_deathScreen) return;

  // Defensive: clear any active tooltip before drawing the death modal. Stuck
  // tooltips sit at z:9999 and visually mask the death-screen buttons.
  try { hideTooltip(); } catch (_) {}

  // Run-history log: snapshot the run into meta.runHistory[]. Runs first so the
  // history entry reflects the live state (weapons, evolutions, kills) before
  // teardown touches anything. Capture the return value so the SHARE button
  // and preview thumbnail render against the same canonical entry shape.
  let latestRunEntry = null;
  try { latestRunEntry = recordRunResult(state, state.victory ? 'victory' : 'death'); } catch (_) {}
  if (!latestRunEntry) latestRunEntry = _runEntryFromState();

  // Daily-run leaderboard commit must run BEFORE commitRunResults so the daily
  // sigil grant is included in this run's sigilsEarned tally.
  let dailySummary = null;
  if (state.modes && state.modes.daily) {
    dailySummary = commitDailyRun({ kills: state.run.kills, timeSurvived: state.time.game });
    if (dailySummary.newKillsBest || dailySummary.newTimeBest) {
      setTimeout(() => showBanner('★ NEW DAILY BEST', 3.5, '#c87bff'), 800);
      grantSigils(3, 'daily');
    }
  }

  // Commit run to persistent meta and pull rewards/highlights
  const summary = commitRunResults({
    timeSurvived: state.time.game,
    kills: state.run.kills,
    dmgDealt: state.run.dmgDealt,
    level: state.hero.level,
    victory: state.victory,
    stageId: state.run.stage ? state.run.stage.id : null,
    greedMul: state.run.passive_greedMul || 0,
  });
  const meta = getMeta();
  // First-victory unlock banners
  if (summary.unlockedHyper) setTimeout(() => showBanner('🔥 HYPER MODE UNLOCKED', 4.0, '#ff5555'), 600);
  if (summary.unlockedEndless) setTimeout(() => showBanner('♾ ENDLESS UNLOCKED', 4.0, '#7fffe4'), 1200);
  if (summary.unlockedCinder) setTimeout(() => showBanner('🜂 CINDER CAVERNS UNLOCKED', 4.5, '#ff7a3a'), 1800);
  // Iter 7: Clockwork character unlock — Boss Rush + Twilight victory.
  // 2.4s delay slots after the stage banners so they don't stomp each other
  // when multiple unlocks fire from the same victory run.
  if (summary.unlockedClockwork) setTimeout(() => showBanner('★ CHARACTER UNLOCKED: CLOCKWORK', 4.0, '#7fffe4'), 2400);

  _deathScreen = document.createElement('div');
  _deathScreen.className = 'kk-death';

  const title = document.createElement('div');
  title.className = 'kk-death-title';
  title.textContent = state.victory ? 'VICTORY' : 'YOU DIED';
  if (state.victory) title.style.color = C.amber;

  const bestT = summary.isBestTime ? ' <span style="color:'+C.amber+'">★ BEST</span>' : '';
  const bestK = summary.isBestKills ? ' <span style="color:'+C.amber+'">★ BEST</span>' : '';

  const stats = document.createElement('div');
  stats.className = 'kk-death-stats';
  stats.style.cssText = `
    display: grid;
    grid-template-columns: 1fr auto;
    column-gap: 36px; row-gap: 6px;
    align-items: baseline;
  `;
  const statRow = (label, value, extra = '') => `
    <div style="font-family:${F.body}; letter-spacing:0.20em; text-transform:uppercase; font-size:calc(var(--kk-font-scale, 1) * 12px); color:rgba(245,239,225,0.72);">${label}</div>
    <div style="font-family:${F.mono}; font-size:calc(var(--kk-font-scale, 1) * 15px); color:${C.amber}; text-align:right;">${value}${extra}</div>
  `;
  // Custom-colored row for sigil earnings — magenta/epic shade, matches `#c87bff`.
  const sigilRow = (label, value) => `
    <div style="font-family:${F.body}; letter-spacing:0.20em; text-transform:uppercase; font-size:calc(var(--kk-font-scale, 1) * 12px); color:rgba(245,239,225,0.72);">${label}</div>
    <div style="font-family:${F.mono}; font-size:calc(var(--kk-font-scale, 1) * 15px); color:#c87bff; text-align:right;">${value}</div>
  `;
  stats.innerHTML = [
    statRow('Time Survived',  fmtTime(state.time.game), bestT),
    statRow('Level Reached',  state.hero.level),
    statRow('Kills',          state.run.kills, bestK),
    statRow('Damage Dealt',   Math.floor(state.run.dmgDealt).toLocaleString()),
    `<div style="grid-column:1/-1; height:1px; background:${C.edge}; margin:6px 0;"></div>`,
    statRow('Coins Earned',   `+${summary.coinsEarned}`),
    statRow('Embers Earned',  `+${summary.embersEarned || 0} 🔥`),
    sigilRow('Sigils Earned', `✦ +${summary.sigilsEarned || 0}`),
    statRow('Total Coins',    meta.coins.toLocaleString()),
    statRow('Total Embers',   `${(meta.embers || 0).toLocaleString()} 🔥`),
    statRow('Runs',           meta.runs),
    statRow('Achievements',   `${achievementCount()} / ${ACHIEVEMENTS.length}`),
  ].join('');

  // Stash the run summary so the town arrival toast can re-surface earnings.
  window._kkLastRunSummary = {
    coinsEarned:  summary.coinsEarned,
    embersEarned: summary.embersEarned || 0,
    kills:        state.run.kills,
    time:         state.time.game,
    victory:      !!state.victory,
    unlockedHyper: !!summary.unlockedHyper,
    unlockedEndless: !!summary.unlockedEndless,
    unlockedCinder: !!summary.unlockedCinder,
    unlockedClockwork: !!summary.unlockedClockwork,
  };

  // Button row (RETRY in-place reset, plus hint)
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex; gap:18px; margin-top:8px;';
  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.textContent = 'Retry ▸ R';
  const retryAccent = state.victory ? C.amber : C.cyan;
  retryBtn.style.cssText = `padding: 14px 44px; cursor: pointer;
    background: linear-gradient(180deg, rgba(20,28,22,0.95), rgba(8,14,12,0.95));
    border: 1px solid ${retryAccent};
    border-radius: 8px;
    color: ${retryAccent};
    font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 18px); font-weight: 700;
    letter-spacing: 0.32em;
    box-shadow: 0 1px 0 rgba(255,255,255,0.06) inset, 0 12px 28px rgba(0,0,0,0.5);`;
  btnRow.appendChild(retryBtn);

  // Return-to-Town button — closes the run/town/upgrade loop without reload.
  const townBtn = document.createElement('button');
  townBtn.type = 'button';
  townBtn.textContent = '🏘 Return to Town';
  townBtn.style.cssText = `padding: 14px 28px; cursor: pointer;
    background: linear-gradient(180deg, rgba(28,20,16,0.95), rgba(14,10,8,0.95));
    border: 1px solid #c9b07a;
    border-radius: 8px;
    color: #c9b07a;
    font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 16px); font-weight: 700;
    letter-spacing: 0.24em;
    box-shadow: 0 1px 0 rgba(255,255,255,0.06) inset, 0 12px 28px rgba(0,0,0,0.5);`;
  btnRow.appendChild(townBtn);

  // Return-to-Main-Menu button — full exit from the run+town cycle, drops
  // to the start screen so the player can rebind character/stage/options.
  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'kk-btn-secondary';
  menuBtn.textContent = '↩ Main Menu';
  menuBtn.style.cssText = `padding: 14px 24px;`;
  btnRow.appendChild(menuBtn);

  const hint = document.createElement('div');
  hint.className = 'kk-death-hint';
  hint.textContent = 'R · Retry    T · Town    M or Esc · Main Menu';

  // Per-source damage breakdown — drives "one more run" by exposing which
  // weapon was actually carrying the run.
  const breakdown = document.createElement('div');
  breakdown.style.cssText = `
    margin: 6px 0 4px 0;
    font-family: ${F.body};
    color: ${C.text};
    min-width: min(460px, 90vw); max-width: 580px;
    background: rgba(8,14,12,0.55);
    border: 1px solid ${C.edge}; border-radius: 8px;
    padding: 16px 22px;
  `;
  const dmgByWeapon = state.run.dmgByWeapon || {};
  const sources = Object.entries(dmgByWeapon)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const totalDmg = Math.max(1, state.run.dmgDealt);
  const elapsed = Math.max(1, state.time.game);
  if (sources.length > 0) {
    const head = document.createElement('div');
    head.style.cssText = `
      font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 11px);
      color: ${C.amber}; letter-spacing: 0.36em; text-transform: uppercase;
      margin-bottom: 10px;
    `;
    head.textContent = 'Damage by Source';
    breakdown.appendChild(head);
    for (const [src, amt] of sources) {
      const pct = (amt / totalDmg * 100).toFixed(0);
      const dps = (amt / elapsed).toFixed(1);
      const row = document.createElement('div');
      row.style.cssText = `
        display: grid;
        grid-template-columns: 110px 1fr 60px 46px 60px;
        gap: 14px; align-items: center;
        padding: 3px 0;
        font-size: calc(var(--kk-font-scale, 1) * 12px);
      `;
      const label = src.replace(/_/g, ' ');
      const pctRatio = amt / totalDmg;
      row.innerHTML = `
        <span style="font-family:${F.body}; font-weight:600; letter-spacing:0.08em; text-transform:uppercase; color:${C.text};">${escapeHtml(label)}</span>
        <span style="background:rgba(255,255,255,0.05); height:8px; border-radius:4px; position:relative; overflow:hidden;">
          <span style="position:absolute; left:0; top:0; bottom:0; width:${(pctRatio * 100).toFixed(1)}%; background:linear-gradient(90deg, ${C.cyan}, ${C.amber}); border-radius:4px;"></span>
        </span>
        <span style="font-family:${F.mono}; text-align:right; color:${C.text};">${Math.floor(amt).toLocaleString()}</span>
        <span style="font-family:${F.mono}; text-align:right; color:${C.amber};">${pct}%</span>
        <span style="font-family:${F.mono}; text-align:right; color:rgba(245,239,225,0.7);">${dps}/s</span>
      `;
      breakdown.appendChild(row);
    }
  }

  // Relic drop panel — appears only on victory (boss dropped a relic).
  let relicPanel = null;
  if (state.victory && state.run.relicDrop) {
    const drop = state.run.relicDrop;
    relicPanel = document.createElement('div');
    relicPanel.style.cssText = `
      margin: 4px 0; padding: 16px 22px;
      min-width: min(460px, 90vw); max-width: 580px;
      background: linear-gradient(180deg, rgba(20,28,22,0.94), rgba(8,14,12,0.96));
      border: 1px solid ${drop.tierColor};
      border-radius: 10px;
      box-shadow:
        0 1px 0 rgba(255,255,255,0.05) inset,
        0 14px 32px rgba(0,0,0,0.6),
        0 0 24px ${drop.tierColor}33;
      animation: kk-fade-in 0.42s ease-out;
    `;
    const affixLines = drop.affixes.map(a =>
      `<div style="font-family:${F.body};font-size:calc(var(--kk-font-scale, 1) * 13px);color:${C.text};letter-spacing:0.06em;margin-top:3px;">▸ ${escapeHtml(a.fmt)}</div>`
    ).join('');
    relicPanel.innerHTML = `
      <div style="font-family:${F.display};font-size:calc(var(--kk-font-scale, 1) * 10px);color:${drop.tierColor};letter-spacing:0.36em;text-transform:uppercase;margin-bottom:2px;">★ Relic Dropped</div>
      <div style="font-family:${F.display};font-size:calc(var(--kk-font-scale, 1) * 20px);font-weight:700;color:${C.text};letter-spacing:0.10em;">${escapeHtml(drop.name)}</div>
      <div style="font-family:${F.body};font-size:calc(var(--kk-font-scale, 1) * 11px);color:${drop.tierColor};letter-spacing:0.28em;text-transform:uppercase;margin-top:2px;">${escapeHtml(drop.tier)}</div>
      <div style="margin-top:8px;">${affixLines}</div>
      <div style="margin-top:10px; font-family:${F.body}; font-size:calc(var(--kk-font-scale, 1) * 11px); color:rgba(245,239,225,0.62); letter-spacing:0.04em;">Auto-equipped for next run · manage in Grimoire.</div>
    `;
  }

  // ── Iter-9: SHARE panel ──
  // Big amber SHARE button next to RETRY, plus a 200×105 preview thumbnail of
  // the rendered share card so the player sees what's going on the wire
  // BEFORE they download. The preview is the same renderShareCard() canvas at
  // a smaller display size — no second render pass, no PNG round-trip.
  // Adds the button into the existing btnRow so layout matches RETRY width
  // and the focus scope picks it up automatically.
  const sharePanel = document.createElement('div');
  sharePanel.style.cssText = `
    display: flex; gap: 18px; align-items: center; justify-content: center;
    margin: 4px 0 2px 0;
  `;
  const previewWrap = document.createElement('div');
  previewWrap.style.cssText = `
    width: 200px; height: 105px;
    border: 1px solid ${C.amber};
    border-radius: 6px;
    background: linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86));
    box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 22px rgba(0,0,0,0.55), 0 0 18px rgba(255,210,127,0.18);
    display: flex; align-items: center; justify-content: center;
    overflow: hidden;
  `;
  // Best-effort preview render. If shareCard.js (9b) hasn't merged, swallow
  // the error and leave the empty thumbnail frame — the SHARE button itself
  // still attempts the download and will fail loudly if needed.
  try {
    const previewCanvas = renderShareCard(latestRunEntry);
    if (previewCanvas) {
      previewCanvas.style.cssText = 'width: 100%; height: 100%; display:block; image-rendering: -webkit-optimize-contrast;';
      previewWrap.appendChild(previewCanvas);
    }
  } catch (e) {
    // Friendly fallback label so the area doesn't read as broken.
    previewWrap.innerHTML = `<div style="font-family:${F.body}; font-size:calc(var(--kk-font-scale, 1) * 11px); letter-spacing:0.18em; color:rgba(245,239,225,0.55); text-transform:uppercase;">preview</div>`;
  }
  // SHARE button — sized to read at first glance, accent-matched to victory
  // (amber) or death (cyan) like RETRY so the row reads as one composition.
  const shareBtn = document.createElement('button');
  shareBtn.type = 'button';
  shareBtn.textContent = '📷 SHARE';
  const shareAccent = state.victory ? C.amber : C.cyan;
  shareBtn.style.cssText = `padding: 14px 26px; cursor: pointer;
    background: linear-gradient(180deg, rgba(28,20,16,0.95), rgba(14,10,8,0.95));
    border: 1px solid ${shareAccent};
    border-radius: 8px;
    color: ${shareAccent};
    font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 16px); font-weight: 700;
    letter-spacing: 0.28em;
    box-shadow: 0 1px 0 rgba(255,255,255,0.06) inset, 0 12px 28px rgba(0,0,0,0.5), 0 0 16px ${shareAccent}33;`;
  shareBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (shareBtn.disabled) return;
    shareBtn.disabled = true;
    const prev = shareBtn.textContent;
    shareBtn.textContent = '…rendering';
    try {
      await downloadShareCard(latestRunEntry);
      _kkShowMicroToast('Share card saved', C.amber);
      shareBtn.textContent = '✓ SAVED';
      setTimeout(() => { shareBtn.textContent = prev; shareBtn.disabled = false; }, 1400);
    } catch (err) {
      shareBtn.textContent = prev;
      shareBtn.disabled = false;
      _kkShowMicroToast('Share failed', C.red);
    }
  });
  sharePanel.appendChild(previewWrap);
  sharePanel.appendChild(shareBtn);

  _deathScreen.appendChild(title);
  _deathScreen.appendChild(stats);
  _deathScreen.appendChild(breakdown);
  if (relicPanel) _deathScreen.appendChild(relicPanel);
  _deathScreen.appendChild(sharePanel);
  _deathScreen.appendChild(btnRow);
  _deathScreen.appendChild(hint);
  _root.appendChild(_deathScreen);
  _deathFocusScope = pushFocusScope([retryBtn, shareBtn, townBtn, menuBtn], { layout: 'list' });

  const restart = () => {
    // Tear down listeners + the modal first, then trigger the in-place reset
    if (_deathKeyHandler) window.removeEventListener('keydown', _deathKeyHandler);
    _deathKeyHandler = null;
    if (_deathFocusScope) { popFocusScope(_deathFocusScope); _deathFocusScope = null; }
    if (_deathScreen && _deathScreen.parentNode) _deathScreen.parentNode.removeChild(_deathScreen);
    _deathScreen = null;
    if (typeof window.kkRestart === 'function') window.kkRestart();
    else location.reload();
  };
  retryBtn.addEventListener('click', (e) => { e.stopPropagation(); restart(); });

  const goTown = () => {
    if (_deathKeyHandler) window.removeEventListener('keydown', _deathKeyHandler);
    _deathKeyHandler = null;
    if (_deathFocusScope) { popFocusScope(_deathFocusScope); _deathFocusScope = null; }
    if (_deathScreen && _deathScreen.parentNode) _deathScreen.parentNode.removeChild(_deathScreen);
    _deathScreen = null;
    if (typeof window.kkReturnToTown === 'function') window.kkReturnToTown();
    else if (typeof window.kkRestart === 'function') window.kkRestart();
    else location.reload();
  };
  townBtn.addEventListener('click', (e) => { e.stopPropagation(); goTown(); });

  const goMenu = () => {
    if (_deathKeyHandler) window.removeEventListener('keydown', _deathKeyHandler);
    _deathKeyHandler = null;
    if (_deathFocusScope) { popFocusScope(_deathFocusScope); _deathFocusScope = null; }
    if (_deathScreen && _deathScreen.parentNode) _deathScreen.parentNode.removeChild(_deathScreen);
    _deathScreen = null;
    if (typeof window.kkReturnToMenu === 'function') window.kkReturnToMenu();
    else location.reload();
  };
  menuBtn.addEventListener('click', (e) => { e.stopPropagation(); goMenu(); });

  _deathKeyHandler = (e) => {
    if (e.code === 'KeyR' || e.key === 'r' || e.key === 'R' || e.code === 'Enter' || e.code === 'Space') restart();
    else if (e.code === 'KeyT' || e.key === 't' || e.key === 'T') goTown();
    else if (e.code === 'KeyM' || e.key === 'm' || e.key === 'M') goMenu();
    // Escape: defaults to Main Menu — full reset is the safest catch-all from
    // a death modal, town is one button-press away from there.
    else if (e.code === 'Escape' || e.key === 'Escape') goMenu();
  };
  window.addEventListener('keydown', _deathKeyHandler);
}

export function showStartScreen(text) {
  // Iter 21a — defensive tooltip hide on modal entry.
  try { hideTooltip(); } catch (_) {}
  if (_startScreen) {
    // Update subtitle in place
    const sub = _startScreen.querySelector('.kk-start-sub');
    if (sub) sub.textContent = text || '';
    // Iter 32d — every showStartScreen returns the player to the main menu
    // (death + return-to-menu reuses the same _startScreen DOM, so without
    // this reset they'd land on whatever view they were in last).
    _setStartView('menu');
    // Lazy-mount carousel: first call fires before preloadAll resolves, so the
    // cache is empty. Once 'hero' is in the cache, mount on the next call.
    if (!_charCarousel && GLTF_CACHE && GLTF_CACHE.hero && _startCharRowRef) {
      try {
        // Wipe loading placeholder
        _startCharRowRef.innerHTML = '';
        _charCarousel = createCharCarousel(_startCharRowRef, {
          items: AVATARS,
          initialId: getMeta().selectedAvatar || 'kitty',
          onSelect: (id) => {
            setOption('selectedAvatar', id);
            getMeta().selectedAvatar = id;
            _refreshStartFocus();
          },
        });
        _refreshStartFocus();
      } catch (e) { console.warn('[carousel.lateMount]', e); }
    }
    return;
  }
  // Ensure root exists even if initUI hasn't run (called early in boot)
  if (!_root) {
    injectCSS();
    _root = document.getElementById('ui-root');
    if (!_root) return;
  }

  _startScreen = document.createElement('div');
  _startScreen.className = 'kk-start';

  // Ornamental flourish above title — vector flourish in warm gold, sells the
  // "real game" feel without needing an external asset.
  const ornamentTop = document.createElement('div');
  ornamentTop.innerHTML = `
    <svg width="320" height="22" viewBox="0 0 320 22" xmlns="http://www.w3.org/2000/svg" style="display:block; filter:drop-shadow(0 2px 6px rgba(0,0,0,0.5));">
      <g fill="none" stroke="${C.amber}" stroke-width="1.2" stroke-linecap="round" opacity="0.85">
        <line x1="20"  y1="11" x2="130" y2="11"/>
        <line x1="190" y1="11" x2="300" y2="11"/>
        <path d="M130 11 Q 140 4, 150 11 T 170 11" />
        <circle cx="160" cy="11" r="2.4" fill="${C.amber}" stroke="none"/>
        <circle cx="20"  cy="11" r="1.6" fill="${C.amber}" stroke="none"/>
        <circle cx="300" cy="11" r="1.6" fill="${C.amber}" stroke="none"/>
      </g>
    </svg>
  `;
  ornamentTop.style.cssText = 'margin-bottom: 4px;';

  const title = document.createElement('div');
  title.className = 'kk-start-title';
  title.textContent = 'Kitty Kaki Survivors';

  // Mirror flourish under the title
  const ornamentBot = document.createElement('div');
  ornamentBot.innerHTML = ornamentTop.innerHTML;
  ornamentBot.style.cssText = 'margin-top: 2px; margin-bottom: 6px; transform: rotate(180deg);';

  const sub = document.createElement('div');
  sub.className = 'kk-start-sub';
  sub.textContent = text || '';

  const meta = getMeta();
  const metaLine = document.createElement('div');
  metaLine.style.cssText = `margin-top:24px;font-size:calc(var(--kk-font-scale, 1) * 14px);color:${C.amber};text-shadow:0 0 6px ${C.amber};letter-spacing:2px;`;
  metaLine.style.cssText = `margin-top: 8px; font-family: ${F.body}; font-size: calc(var(--kk-font-scale, 1) * 13px); letter-spacing: 0.24em; text-transform: uppercase; color: rgba(245,239,225,0.78);`;
  metaLine.innerHTML = meta.runs > 0
    ? `<span style="color:${C.amber}">${meta.coins.toLocaleString()}</span> coins  ·  best <span style="color:${C.amber}">${fmtTime(meta.bestTime)}</span>  ·  <span style="color:${C.amber}">${meta.runs}</span> runs`
    : '<span style="opacity:0.7;">— first run —</span>';

  // Character picker — Iter 31: 3D carousel hosting real GLB models.
  // The legacy card-grid path is replaced; charCarousel.js renders its own
  // info panel + arrow buttons + pip strip into this host.
  const charRow = document.createElement('div');
  charRow.style.cssText = 'display:flex; flex-direction:column; align-items:center; gap:4px; margin-top:6px; pointer-events:auto; width:100%; max-width:90vw;';
  // Sigil-pip colour matches the magenta sigil treatment used in the death-screen
  // stats row + shop tree (`#c87bff`). Don't introduce a fresh token.
  const SIGIL_PIP_C = '#c87bff';
  // Decode an unlock token into a human hint. `null` = always unlocked.
  // Forms supported (per iter-7 contract):
  //   'sigils:N'                  → "Earn N sigils to unlock"
  //   'flag:unlockedClockwork'    → flag-specific hint string
  //   '<achievement_id>'          → "Unlock: <id>" (legacy / current pattern)
  function formatUnlockHint(unlock) {
    if (unlock === null || unlock == null) return '';
    if (typeof unlock !== 'string') return `Unlock: ${String(unlock)}`;
    if (unlock.startsWith('sigils:')) {
      const n = parseInt(unlock.slice(7), 10);
      return Number.isFinite(n) ? `Earn ${n} sigils to unlock` : 'Earn sigils to unlock';
    }
    if (unlock.startsWith('flag:')) {
      const flag = unlock.slice(5);
      if (flag === 'unlockedClockwork') return 'Clear Boss Rush on Twilight Hollow to unlock.';
      return `Unlock: ${flag}`;
    }
    return `Unlock: ${unlock}`;
  }
  // Parse `'sigils:N'` → N, else null. Used by the progress-pip path.
  function parseSigilGate(unlock) {
    if (typeof unlock !== 'string' || !unlock.startsWith('sigils:')) return null;
    const n = parseInt(unlock.slice(7), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  function paintChars() {
    // Iter 32: carousel = avatar; chip row = archetype. Preset-apply hits
    // here to sync both. Carousel takes selectedAvatar; archRow repaints.
    if (_charCarousel && meta && meta.selectedAvatar) {
      try { _charCarousel.setSelection(meta.selectedAvatar); } catch (_) {}
    }
    try { paintArchetypes(); } catch (_) {}
  }
  // Iter 32: carousel = AVATAR picker (2 entries). Archetype picker is the
  // chip row built immediately below. Carousel mounts only after preloadAll
  // resolves (cache populated) — the lazy-mount path in the
  // _startScreen-exists guard handles the first showStartScreen call.
  if (_charCarousel) { try { _charCarousel.destroy(); } catch (_) {} _charCarousel = null; }
  if (GLTF_CACHE && GLTF_CACHE.hero) {
    _charCarousel = createCharCarousel(charRow, {
      items: AVATARS,
      initialId: meta.selectedAvatar || 'kitty',
      onSelect: (id) => {
        setOption('selectedAvatar', id);
        meta.selectedAvatar = id;
        _refreshStartFocus();
      },
    });
  } else {
    // Loading placeholder until preload finishes
    const ph = document.createElement('div');
    ph.style.cssText = 'padding:28px;opacity:0.7;font-family:"Crimson Text",Georgia,serif;letter-spacing:0.12em;';
    ph.textContent = 'Loading characters…';
    charRow.appendChild(ph);
  }

  // ── Archetype chip row — gameplay profile (starter weapon + stats + signature)
  const archRow = document.createElement('div');
  archRow.style.cssText = `
    display:flex; gap:6px; margin-top:6px; pointer-events:auto;
    flex-wrap:wrap; justify-content:center; max-width:760px;
  `;
  // Same guard as carousel wrap — main.js installs window click→start.
  archRow.addEventListener('click', (e) => { e.stopPropagation(); });
  function paintArchetypes() {
    archRow.innerHTML = '';
    const archTitle = document.createElement('div');
    archTitle.style.cssText = `
      width: 100%; text-align: center;
      font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 12px);
      letter-spacing: 0.28em; color: rgba(245,239,225,0.55);
      margin-bottom: 4px; text-transform: uppercase;
    `;
    archTitle.textContent = '— starter archetype —';
    archRow.appendChild(archTitle);

    for (const ch of CHARACTERS) {
      const unlocked = isCharacterUnlocked(ch, meta);
      const selected = ch.id === meta.selectedChar;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.disabled = !unlocked;
      const accent = selected ? C.amber : (unlocked ? C.cyan : 'rgba(120,120,120,0.5)');
      chip.style.cssText = `
        padding: 8px 14px;
        background: ${selected ? 'rgba(255,210,127,0.14)' : 'linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86))'};
        border: 1px solid ${accent};
        border-radius: 999px;
        color: ${selected ? C.amber : (unlocked ? C.text : 'rgba(120,120,120,0.7)')};
        font-family: ${F.body}; font-size: calc(var(--kk-font-scale, 1) * 12.5px);
        letter-spacing: 0.16em; cursor: ${unlocked ? 'pointer' : 'not-allowed'};
        display: inline-flex; align-items: center; gap: 6px;
        transition: transform 0.15s ease, border-color 0.15s ease;
      `;
      const lockGlyph = unlocked ? '' : '🔒 ';
      chip.innerHTML = `${unlocked ? (ch.icon || '◇') : ''}${lockGlyph}<span>${escapeHtml(ch.name)}</span>`;
      if (unlocked) {
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          setOption('selectedChar', ch.id);
          meta.selectedChar = ch.id;
          paintArchetypes();
          _refreshStartFocus();
        });
        chip.addEventListener('mouseenter', () => { chip.style.transform = 'translateY(-1px)'; });
        chip.addEventListener('mouseleave', () => { chip.style.transform = 'translateY(0)'; });
      }
      bindTooltip(chip, () => {
        const b = characterBlurb(ch.id);
        const statRows = [
          { label: 'Starter', value: ch.starter },
          { label: 'Max HP',  value: String(ch.hpMax) },
        ];
        if (ch.statMul) {
          if (ch.statMul.dmg && ch.statMul.dmg !== 1)              statRows.push({ label: 'DMG',  value: `×${ch.statMul.dmg.toFixed(2)}` });
          if (ch.statMul.moveSpeed && ch.statMul.moveSpeed !== 1)  statRows.push({ label: 'Move', value: `×${ch.statMul.moveSpeed.toFixed(2)}` });
          if (ch.statMul.magnet && ch.statMul.magnet !== 1)        statRows.push({ label: 'Magnet', value: `×${ch.statMul.magnet.toFixed(2)}` });
          if (ch.statMul.projSpeed && ch.statMul.projSpeed !== 1)  statRows.push({ label: 'Proj Spd', value: `×${ch.statMul.projSpeed.toFixed(2)}` });
        }
        if (ch.signatureName) statRows.unshift({ label: 'Signature', value: String(ch.signatureName) });
        const bodyParts = [];
        if (unlocked) {
          bodyParts.push(b ? b.flavor : ch.desc);
          if (ch.signatureDesc) bodyParts.push(`◆ ${ch.signatureName}: ${ch.signatureDesc}`);
          bodyParts.push(`Starter weapon: ${ch.starter} (auto-equipped at run start).`);
        } else {
          bodyParts.push(formatUnlockHint(ch.unlock));
        }
        return {
          title: unlocked ? ch.name : `${ch.name} (Locked)`,
          icon: unlocked ? ch.icon : '🔒',
          body: bodyParts.join('\n\n'),
          tags: unlocked ? (b ? b.tags : ['Archetype']) : ['Locked'],
          stats: unlocked ? statRows : undefined,
          accent: selected ? '#ffd27f' : '#7fffe4',
        };
      });
      archRow.appendChild(chip);
    }
  }
  paintArchetypes();

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display: flex; gap: 12px; margin-top: 22px; pointer-events: auto; flex-wrap: wrap; justify-content: center;';

  const ghostBtn = (label, accent) => `
    padding: 10px 22px; cursor: pointer;
    background: linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86));
    border: 1px solid ${C.edge};
    border-radius: 8px;
    color: ${accent};
    font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 13px); font-weight: 700;
    letter-spacing: 0.28em;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 20px rgba(0,0,0,0.5);
  `;

  const shopBtn = document.createElement('button');
  shopBtn.type = 'button';
  shopBtn.textContent = 'Shop';
  shopBtn.style.cssText = ghostBtn('Shop', C.amber);
  shopBtn.addEventListener('mouseenter', () => { try { sfx.uiHover(); } catch (_) {} });
  shopBtn.addEventListener('click', (e) => { e.stopPropagation(); showShop(); });

  const grimBtn = document.createElement('button');
  grimBtn.type = 'button';
  grimBtn.textContent = 'Grimoire';
  grimBtn.style.cssText = ghostBtn('Grimoire', C.magenta);
  grimBtn.addEventListener('mouseenter', () => { try { sfx.uiHover(); } catch (_) {} });
  grimBtn.addEventListener('click', (e) => { e.stopPropagation(); showGrimoire(); });

  const codexBtn = document.createElement('button');
  codexBtn.type = 'button';
  codexBtn.textContent = 'Codex';
  codexBtn.style.cssText = ghostBtn('Codex', C.cyan);
  codexBtn.addEventListener('mouseenter', () => { try { sfx.uiHover(); } catch (_) {} });
  codexBtn.addEventListener('click', (e) => { e.stopPropagation(); showCodex(); });

  const historyBtn = document.createElement('button');
  historyBtn.type = 'button';
  historyBtn.textContent = 'History';
  historyBtn.style.cssText = ghostBtn('History', C.amber);
  historyBtn.addEventListener('mouseenter', () => { try { sfx.uiHover(); } catch (_) {} });
  historyBtn.addEventListener('click', (e) => { e.stopPropagation(); showRunHistory(); });

  const optsBtn = document.createElement('button');
  optsBtn.type = 'button';
  optsBtn.textContent = 'Options';
  optsBtn.style.cssText = ghostBtn('Options', C.cyan);
  optsBtn.addEventListener('mouseenter', () => { try { sfx.uiHover(); } catch (_) {} });
  optsBtn.addEventListener('click', (e) => { e.stopPropagation(); showOptions(); });

  // ── Credits + How To Play ──
  // Credits opens an in-game modal (showCredits, defined later in this file).
  // How To Play opens the static `how-to-play.html` page in a new tab so the
  // game-side focus scope stays intact and players can scroll the reference.
  const creditsBtn = document.createElement('button');
  creditsBtn.type = 'button';
  creditsBtn.textContent = 'Credits';
  creditsBtn.setAttribute('aria-label', 'View credits');
  creditsBtn.style.cssText = ghostBtn('Credits', C.amber);
  creditsBtn.addEventListener('mouseenter', () => { try { sfx.uiHover(); } catch (_) {} });
  creditsBtn.addEventListener('click', (e) => { e.stopPropagation(); showCredits(); });

  const howToBtn = document.createElement('button');
  howToBtn.type = 'button';
  howToBtn.textContent = 'How To Play';
  howToBtn.setAttribute('aria-label', 'Open How To Play in a new tab');
  howToBtn.style.cssText = ghostBtn('How To Play', C.cyan);
  howToBtn.addEventListener('mouseenter', () => { try { sfx.uiHover(); } catch (_) {} });
  howToBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    try { sfx.uiClick(); } catch (_) {}
    try { window.open('how-to-play.html', '_blank', 'noopener'); } catch (_) {}
  });

  // ── Daily / Weekly toggle pair ──
  // Mutually exclusive with each other and with BossRush; toggling one ON
  // untoggles the other two so the run-mode pipeline stays deterministic.
  // Each card carries a small 📋 icon that copies the seed-share string to
  // the clipboard for instant sharing (iter-9 retention hook #1).
  const purple = '#c87bff';
  const weeklyMagenta = '#c87bff'; // matches iter-9 brief; same family as Daily
                                    // for visual cohesion but distinguished by
                                    // border + "WEEKLY" label.
  const _untoggleOther = (mode) => {
    if (mode !== 'daily')   setOption('optDaily',    false);
    if (mode !== 'weekly')  setOption('optWeekly',   false);
    if (mode !== 'bossRush')setOption('optBossRush', false);
  };

  // Inline 📋 share-pill — appears in the bottom-right corner of each card.
  // Stops propagation so clicking it doesn't toggle the parent card mode.
  const _shareIconHTML = `<span class="kk-share-pip" style="
    position:absolute; right:6px; bottom:6px;
    width:22px; height:22px;
    display:flex; align-items:center; justify-content:center;
    border-radius:5px;
    border:1px solid rgba(245,239,225,0.28);
    background: rgba(8,14,12,0.66);
    font-size:calc(var(--kk-font-scale, 1) * 11px);
    color:rgba(245,239,225,0.85);
    cursor:pointer;
    transition: transform 0.12s ease, border-color 0.12s ease;
  " title="Copy seed">📋</span>`;

  // Daily challenge toggle — fixed character + modifier, no shop bonuses.
  const dailyBtn = document.createElement('button');
  dailyBtn.type = 'button';
  dailyBtn.style.position = 'relative';
  const paintDaily = () => {
    const m = getMeta();
    const cfg = dailyChallengeConfig(CHARACTERS.map(c => c.id));
    const on = !!m.optDaily;
    const todayIsRecord = m.dailyRun && m.dailyRun.date === cfg.date;
    const best = todayIsRecord
      ? `BEST ${m.dailyRun.bestKills}K · ${fmtTime(m.dailyRun.bestTime)}`
      : 'NO RUNS YET';
    dailyBtn.innerHTML = `
      <div style="font-family:${F.display}; font-size:calc(var(--kk-font-scale, 1) * 13px); font-weight:700; letter-spacing:0.28em;">Daily ${on ? '★' : ''}</div>
      <div style="font-family:${F.body}; font-size:calc(var(--kk-font-scale, 1) * 9.5px); opacity:0.82; margin-top:3px; letter-spacing:0.12em; text-transform:uppercase;">${escapeHtml(cfg.date)} · ${escapeHtml(cfg.modifier)}</div>
      <div style="font-family:${F.mono}; font-size:calc(var(--kk-font-scale, 1) * 10px); opacity:0.85; margin-top:2px;">${best}</div>
      ${_shareIconHTML}
    `;
    dailyBtn.style.cssText = `padding: 10px 26px 10px 18px; cursor: pointer; position:relative;
      background: ${on ? 'linear-gradient(180deg, rgba(200,123,255,0.22), rgba(110,60,180,0.18))' : 'linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86))'};
      border: 1px solid ${on ? purple : C.edge};
      border-radius: 8px;
      color: ${purple};
      box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 20px rgba(0,0,0,0.5);
      line-height: 1.15; text-align:center;`;
    // Wire the share-pip after innerHTML reset.
    const pip = dailyBtn.querySelector('.kk-share-pip');
    if (pip) {
      pip.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const cfg2 = dailyChallengeConfig(CHARACTERS.map(c => c.id));
        const m2 = getMeta();
        const entry = {
          stage:     'forest',
          character: cfg2.character || 'kitty',
          mode:      'daily',
          kills:     (m2.dailyRun && m2.dailyRun.bestKills) || 0,
          timeSurvived: (m2.dailyRun && m2.dailyRun.bestTime) || 0,
          seed:      cfg2.seed || cfg2.date || '',
        };
        const text = typeof formatSeedShareString === 'function'
          ? formatSeedShareString(entry)
          : `${entry.seed} · ${entry.kills}k · ${fmtTime(entry.timeSurvived)} · ${entry.character}`;
        copyTextToClipboard(text).then((ok) => {
          _kkShowMicroToast(ok ? 'Seed copied' : 'Copy failed', ok ? C.green : C.red);
        });
      });
    }
  };
  paintDaily();
  dailyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const m = getMeta();
    const next = !m.optDaily;
    if (next) _untoggleOther('daily');
    setOption('optDaily', next);
    paintDaily();
    if (typeof paintWeekly === 'function') paintWeekly();
  });

  // Weekly mutator toggle — same shape as Daily, magenta accent, ISO-week
  // keyed mutator pulled from weeklyMutatorConfig(). Personal best read from
  // meta.weeklyBest (initialized by 9a's commitWeeklyRun).
  const weeklyBtn = document.createElement('button');
  weeklyBtn.type = 'button';
  weeklyBtn.style.position = 'relative';
  let _weeklyCfgCache = null;
  const _weeklyCfg = () => {
    if (_weeklyCfgCache) return _weeklyCfgCache;
    try {
      _weeklyCfgCache = typeof weeklyMutatorConfig === 'function'
        ? weeklyMutatorConfig() : null;
    } catch (_) { _weeklyCfgCache = null; }
    return _weeklyCfgCache;
  };
  function paintWeekly() {
    const m = getMeta();
    const cfg = _weeklyCfg();
    const on = !!m.optWeekly;
    const label = cfg ? (cfg.mutatorLabel || cfg.mutatorId || 'MUTATOR') : 'MUTATOR PENDING';
    const wk = cfg ? (cfg.weekKey || '') : '';
    const best = (m.weeklyBest && m.weeklyBest.kills)
      ? `BEST ${m.weeklyBest.kills}K · ${fmtTime(m.weeklyBest.time || 0)}`
      : 'NO RUNS YET';
    weeklyBtn.innerHTML = `
      <div style="font-family:${F.display}; font-size:calc(var(--kk-font-scale, 1) * 13px); font-weight:700; letter-spacing:0.28em;">Weekly ${on ? '★' : ''}</div>
      <div style="font-family:${F.body}; font-size:calc(var(--kk-font-scale, 1) * 9.5px); opacity:0.82; margin-top:3px; letter-spacing:0.12em; text-transform:uppercase;">${escapeHtml(wk)} · ${escapeHtml(label)}</div>
      <div style="font-family:${F.mono}; font-size:calc(var(--kk-font-scale, 1) * 10px); opacity:0.85; margin-top:2px;">${best}</div>
      ${_shareIconHTML}
    `;
    weeklyBtn.style.cssText = `padding: 10px 26px 10px 18px; cursor: pointer; position:relative;
      background: ${on ? 'linear-gradient(180deg, rgba(255,122,216,0.22), rgba(160,60,140,0.18))' : 'linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86))'};
      border: 1px solid ${on ? C.magenta : C.edge};
      border-radius: 8px;
      color: ${C.magenta};
      box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 20px rgba(0,0,0,0.5);
      line-height: 1.15; text-align:center;`;
    const pip = weeklyBtn.querySelector('.kk-share-pip');
    if (pip) {
      pip.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const cfg2 = _weeklyCfg();
        const m2 = getMeta();
        const wb = m2.weeklyBest || {};
        const entry = {
          stage:     wb.stage     || 'forest',
          character: wb.character || 'kitty',
          mode:      'weekly',
          kills:     wb.kills || 0,
          timeSurvived: wb.time || 0,
          seed:      (cfg2 && cfg2.seed) || (cfg2 && cfg2.weekKey) || '',
        };
        const text = typeof formatSeedShareString === 'function'
          ? formatSeedShareString(entry)
          : `${entry.seed} · ${entry.kills}k · ${fmtTime(entry.timeSurvived)} · ${entry.character}`;
        copyTextToClipboard(text).then((ok) => {
          _kkShowMicroToast(ok ? 'Seed copied' : 'Copy failed', ok ? C.green : C.red);
        });
      });
    }
  }
  paintWeekly();
  weeklyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const m = getMeta();
    const next = !m.optWeekly;
    if (next) _untoggleOther('weekly');
    setOption('optWeekly', next);
    paintWeekly();
    paintDaily();
  });
  // Hover tooltip — surfaces mutator label + flavor + personal best.
  bindTooltip(weeklyBtn, () => {
    const cfg = _weeklyCfg();
    const m = getMeta();
    const wb = m.weeklyBest || {};
    const bestLine = wb.kills
      ? `Personal best: ${wb.kills} kills · ${fmtTime(wb.time || 0)} · ${String(wb.character || '?').toUpperCase()}`
      : 'No weekly runs yet.';
    const flavor = (cfg && cfg.mutatorLabel) ? cfg.mutatorLabel : 'Pending — weekly mutator not yet rolled.';
    const body = [
      `Mutator: ${cfg && cfg.mutatorId ? cfg.mutatorId : '—'}`,
      flavor,
      bestLine,
      'Mutually exclusive with Daily and Boss Rush.',
    ].join('\n\n');
    return {
      title: 'Weekly Challenge',
      icon: '🌑',
      body,
      tags: ['Mutator', 'Leaderboard'],
      accent: C.magenta,
    };
  });

  // ── Hall of Records ──
  // Surfaces local leaderboard.topRunsAcrossAll(20) as a single-screen table.
  // Seed column is click-to-replay — sets selectedChar/selectedStage and shows
  // a green "Loaded seed X" toast, then hides the modal.
  const recordsBtn = document.createElement('button');
  recordsBtn.type = 'button';
  recordsBtn.textContent = 'Records';
  recordsBtn.style.cssText = ghostBtn('Records', C.magenta);
  recordsBtn.addEventListener('mouseenter', () => { try { sfx.uiHover(); } catch (_) {} });
  recordsBtn.addEventListener('click', (e) => { e.stopPropagation(); showHallOfRecords(); });

  const townBtn = document.createElement('button');
  townBtn.type = 'button';
  townBtn.textContent = '🏘 Town';
  townBtn.style.cssText = ghostBtn('Town', '#c9b07a');
  townBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (typeof window.kkEnterTown === 'function') window.kkEnterTown();
  });

  btnRow.appendChild(townBtn);
  btnRow.appendChild(shopBtn);
  btnRow.appendChild(grimBtn);
  btnRow.appendChild(codexBtn);
  btnRow.appendChild(historyBtn);
  btnRow.appendChild(recordsBtn);
  btnRow.appendChild(howToBtn);
  btnRow.appendChild(creditsBtn);
  btnRow.appendChild(optsBtn);

  // Iter 32d — Daily/Weekly are run-mode toggles. Move them off the main
  // menu and onto a dedicated row inside the select panel (player only
  // tunes a run after clicking Play).
  const modeRow = document.createElement('div');
  modeRow.style.cssText = 'display:flex; gap:10px; margin-top:10px; pointer-events:auto; flex-wrap:wrap; justify-content:center;';
  modeRow.addEventListener('click', (e) => { e.stopPropagation(); });
  modeRow.appendChild(dailyBtn);
  modeRow.appendChild(weeklyBtn);

  // URL-replay header — appended first so it floats above the title when
  // state.replaySeed is set by 9b's boot-time URL parser. Pure display tag;
  // mode toggles happen in main.js. Defensive read (state.replaySeed may not
  // exist yet during 9b merge windows).
  const replay = (state && state.replaySeed) || null;
  if (replay && (replay.seed || replay.kills != null || replay.time != null)) {
    const replayHeader = document.createElement('div');
    replayHeader.style.cssText = `
      margin: 0 auto 18px auto;
      padding: 8px 18px;
      background: linear-gradient(180deg, rgba(127,255,228,0.14), rgba(60,140,120,0.08));
      border: 1px solid ${C.cyan};
      border-radius: 8px;
      font-family: ${F.body};
      font-size: calc(var(--kk-font-scale, 1) * 11.5px); letter-spacing: 0.18em; text-transform: uppercase;
      color: ${C.cyan};
      box-shadow: 0 0 14px rgba(127,255,228,0.22), 0 6px 18px rgba(0,0,0,0.4);
      max-width: 80vw;
    `;
    const seedTxt = escapeHtml(String(replay.seed || '—'));
    const killTxt = (replay.kills != null) ? `· kills ${replay.kills | 0}` : '';
    const timeTxt = (replay.time != null) ? `· ${fmtTime(replay.time | 0)}` : '';
    const charTxt = replay.character ? `· ${escapeHtml(String(replay.character).toUpperCase())}` : '';
    const stageTxt = replay.stage ? `· ${escapeHtml(String(replay.stage).toUpperCase())}` : '';
    replayHeader.innerHTML = `Replaying ${seedTxt} ${killTxt} ${timeTxt} ${charTxt} ${stageTxt}`.trim();
    _startScreen.appendChild(replayHeader);
  }

  _startScreen.appendChild(ornamentTop);
  _startScreen.appendChild(title);
  _startScreen.appendChild(ornamentBot);
  _startScreen.appendChild(sub);
  _startScreen.appendChild(metaLine);

  // Iter 32d — two-view container. Menu shows first (Play + meta buttons).
  // Click Play → Select panel (avatar carousel, archetype, stage, preset, Start Run).
  _menuPanel = document.createElement('div');
  _menuPanel.style.cssText = `
    display: flex; flex-direction: column; align-items: center; gap: 10px;
    margin-top: 6px; pointer-events: auto; width: 100%; max-width: 760px;
  `;
  _selectPanel = document.createElement('div');
  _selectPanel.style.cssText = `
    display: none; flex-direction: column; align-items: center; gap: 4px;
    margin-top: 6px; pointer-events: auto; width: 100%; max-width: 760px;
  `;
  _startScreen.appendChild(_menuPanel);
  _startScreen.appendChild(_selectPanel);

  // Equipped relic chip — small inline badge under the meta line.
  const relic = equippedRelic();
  if (relic) {
    const chip = document.createElement('div');
    const affixSummary = relic.affixes.map(a => escapeHtml(a.fmt)).join(' · ');
    chip.style.cssText = `
      margin-top: 10px; padding: 8px 16px;
      background: linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86));
      border: 1px solid ${relic.tierColor};
      border-radius: 999px;
      box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 18px rgba(0,0,0,0.5);
      font-family: ${F.body}; font-size: calc(var(--kk-font-scale, 1) * 11.5px); color: ${C.text};
      letter-spacing: 0.06em;
      display: inline-flex; align-items: center; gap: 8px;
    `;
    chip.innerHTML = `
      <span style="font-family:${F.display}; font-size:calc(var(--kk-font-scale, 1) * 10px); letter-spacing:0.32em; color:${relic.tierColor}; text-transform:uppercase;">${escapeHtml(relic.tier)} Relic</span>
      <span style="opacity:0.78;">${affixSummary}</span>
    `;
    _startScreen.appendChild(chip);
  }
  // Stage picker row — small inline chips. Shown when at least one stage
  // beyond the default exists; gated stages display locked until their flag
  // is satisfied (currently `unlockedHyper` = first victory).
  // Hoisted so `paintPresets` can re-paint stages when a preset is applied.
  let paintStages = null;
  if (STAGES.length > 1) {
    const stageRow = document.createElement('div');
    stageRow.style.cssText = `display:flex; gap:10px; margin-top:18px; pointer-events:auto;
      flex-wrap:wrap; justify-content:center; max-width:90vw;`;
    paintStages = function () {
      stageRow.innerHTML = '';
      const meta2 = getMeta();
      for (const st of STAGES) {
        const locked = st.unlock != null && !meta2[st.unlock];
        const selected = (meta2.selectedStage || 'forest') === st.id;
        const border = selected ? C.amber : (locked ? 'rgba(80,80,80,0.4)' : C.edge);
        const chip = document.createElement('div');
        chip.style.cssText = `
          padding: 10px 16px;
          background: linear-gradient(180deg, rgba(20,28,22,0.86), rgba(8,14,12,0.92));
          border: 1px solid ${border};
          border-radius: 10px;
          color: ${locked ? 'rgba(120,120,120,0.65)' : C.text};
          cursor: ${locked ? 'default' : 'pointer'};
          font-family: ${F.body};
          min-width: 220px; max-width: 260px;
          box-shadow: ${selected
            ? `0 0 0 1px ${C.amber} inset, 0 12px 26px rgba(0,0,0,0.55)`
            : `0 1px 0 rgba(255,255,255,0.04) inset, 0 10px 22px rgba(0,0,0,0.5)`};
          transition: transform 0.16s ease, border-color 0.16s ease;
        `;
        chip.innerHTML = `
          <div style="font-family:${F.display};font-size:calc(var(--kk-font-scale, 1) * 13px);font-weight:700;letter-spacing:0.14em;color:${selected ? C.amber : C.text};">${escapeHtml(st.name)}</div>
          <div style="font-size:calc(var(--kk-font-scale, 1) * 11px);line-height:1.45;opacity:${locked ? 0.55 : 0.78};margin-top:3px;">${locked ? (st.id === 'cinder' ? 'Unlocks after a Twilight Hollow victory.' : 'Unlocks after first victory.') : escapeHtml(st.desc)}</div>
        `;
        if (!locked) {
          chip.onclick = (e) => {
            e.stopPropagation();
            setOption('selectedStage', st.id);
            // Immediate preview: retint the world behind the start screen so
            // the player sees the picked stage's atmosphere before pressing Start.
            if (state.envGroup && state.envGroup.userData && state.envGroup.userData.applyStageTint) {
              state.envGroup.userData.applyStageTint(st);
            }
            // Swap arena decor in the start-screen preview too, so the
            // player sees the trees / crystals / cracks for the picked stage
            // before pressing Start.
            if (state.scene) {
              try { loadArenaDecor(st.id, state.scene); } catch (_) {}
            }
            paintStages();
            _refreshStartFocus();
          };
        }
        stageRow.appendChild(chip);
      }
    }
    paintStages();
    _selectPanel.appendChild(stageRow);
    _startStageRowRef = stageRow;
  }

  // ── Presets row ────────────────────────────────────────────────────────────
  // Convenience: save up to 6 character+stage combos. Stage + character only —
  // not weapons or run modifiers (deliberately out of scope).
  const PRESET_CAP = 6;
  const PRESET_C = '#c87bff';
  const presetRow = document.createElement('div');
  presetRow.style.cssText = `display:flex; flex-direction:column; gap:6px;
    margin-top:18px; pointer-events:auto; align-items:center; max-width:90vw;`;

  // Empty-state subtitle — only shown when there are no user presets saved.
  const presetSubtitle = document.createElement('div');
  presetSubtitle.style.cssText = `font-family:${F.body}; font-size:calc(var(--kk-font-scale, 1) * 10.5px);
    letter-spacing:0.28em; text-transform:uppercase;
    color: rgba(245,239,225,0.55);`;
  presetSubtitle.textContent = 'Save your favorite character + stage combo.';

  const presetChips = document.createElement('div');
  presetChips.style.cssText = `display:flex; flex-wrap:wrap; gap:8px;
    justify-content:center; pointer-events:auto;`;

  // Inline name-prompt panel — re-used for save flow. Hidden by default.
  const presetPrompt = document.createElement('div');
  presetPrompt.style.cssText = `display:none; margin-top:6px; gap:6px;
    flex-wrap:wrap; justify-content:center; align-items:center;`;

  function _charIcon(charId) {
    const c = CHARACTERS.find(x => x.id === charId);
    return c ? c.icon : '❓';
  }
  function _stageName(stageId) {
    const s = STAGES.find(x => x.id === stageId);
    return s ? s.name : stageId;
  }

  function showSavePrompt() {
    const m = getMeta();
    presetPrompt.innerHTML = '';
    // Pop the start-screen focus scope while the prompt is open. The focus
    // module installs a capture-phase keydown listener, so Enter/Escape would
    // otherwise be swallowed before the <input> sees them. We re-push by
    // calling _refreshStartFocus() in closePrompt().
    if (_startFocusScope) { popFocusScope(_startFocusScope); _startFocusScope = null; }
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 32;
    input.placeholder = 'Preset name…';
    input.style.cssText = `padding:8px 12px; font-family:${F.body}; font-size:calc(var(--kk-font-scale, 1) * 12px);
      background: rgba(8,14,12,0.65); color:${C.text};
      border: 1px solid ${C.edge}; border-radius:6px;
      letter-spacing:0.06em; min-width:180px; outline:none;`;
    input.addEventListener('focus', () => { input.style.borderColor = PRESET_C; });
    input.addEventListener('blur', () => { input.style.borderColor = C.edge; });

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save';
    saveBtn.setAttribute('data-focusable', '1');
    saveBtn.style.cssText = `padding:8px 14px; cursor:pointer;
      background: linear-gradient(180deg, rgba(200,123,255,0.22), rgba(110,60,180,0.18));
      border: 1px solid ${PRESET_C}; border-radius:6px;
      color:${PRESET_C}; font-family:${F.display}; font-size:calc(var(--kk-font-scale, 1) * 11px);
      letter-spacing:0.22em; font-weight:700;`;

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.setAttribute('data-focusable', '1');
    cancelBtn.style.cssText = `padding:8px 14px; cursor:pointer;
      background: rgba(20,28,22,0.78);
      border: 1px solid ${C.edge}; border-radius:6px;
      color:rgba(245,239,225,0.7); font-family:${F.display}; font-size:calc(var(--kk-font-scale, 1) * 11px);
      letter-spacing:0.22em;`;

    const commit = () => {
      const m2 = getMeta();
      if (listPresets().length >= PRESET_CAP) { closePrompt(); return; }
      addPreset({
        name: input.value,
        character: m2.selectedChar,
        stage: m2.selectedStage || 'forest',
      });
      closePrompt();
      paintPresets();
      _refreshStartFocus();
    };
    const closePrompt = () => {
      presetPrompt.style.display = 'none';
      presetPrompt.innerHTML = '';
      paintPresets();
      _refreshStartFocus();
    };

    saveBtn.addEventListener('click', (e) => { e.stopPropagation(); commit(); });
    cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); closePrompt(); });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); closePrompt(); }
    });

    presetPrompt.appendChild(input);
    presetPrompt.appendChild(saveBtn);
    presetPrompt.appendChild(cancelBtn);
    presetPrompt.style.display = 'flex';
    // Defer focus until DOM committed so the input actually receives it.
    setTimeout(() => { try { input.focus(); input.select && input.select(); } catch (_) {} }, 0);
  }

  function confirmRemove(presetId, presetName) {
    if (typeof window.confirm === 'function') {
      if (!window.confirm(`Delete preset "${presetName}"?`)) return;
    }
    removePreset(presetId);
    paintPresets();
    _refreshStartFocus();
  }

  function paintPresets() {
    presetChips.innerHTML = '';
    const presets = listPresets();
    const full = presets.length >= PRESET_CAP;
    // Up to 6 displayed (cap also enforces 6 max — same number).
    const shown = presets.slice(0, PRESET_CAP);

    // Empty-state subtitle: only shown when no user presets yet.
    presetSubtitle.style.display = presets.length === 0 ? 'block' : 'none';

    for (const p of shown) {
      const chip = document.createElement('div');
      chip.setAttribute('data-focusable', '1');
      chip.tabIndex = 0;
      chip.style.cssText = `
        position: relative;
        padding: 8px 28px 8px 14px;
        background: linear-gradient(180deg, rgba(20,28,22,0.86), rgba(8,14,12,0.92));
        border: 1px solid ${C.edge};
        border-radius: 999px;
        box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 18px rgba(0,0,0,0.5);
        color: ${C.text};
        cursor: pointer;
        font-family: ${F.body};
        display: inline-flex; align-items: center; gap: 8px;
        transition: transform 0.14s ease, border-color 0.14s ease;
        max-width: 220px;
      `;
      const charIcon = _charIcon(p.character);
      const stageLabel = _stageName(p.stage);
      // Truncate stage labels that would overflow the chip.
      const stageShort = stageLabel.length > 14 ? stageLabel.slice(0, 13) + '…' : stageLabel;
      chip.innerHTML = `
        <span style="font-size:calc(var(--kk-font-scale, 1) * 16px); line-height:1;">${charIcon}</span>
        <span style="display:inline-flex; flex-direction:column; line-height:1.2; min-width:0;">
          <span style="font-family:${F.display}; font-size:calc(var(--kk-font-scale, 1) * 11px); letter-spacing:0.14em; font-weight:700; color:${C.text}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:160px;">${escapeHtml(p.name)}</span>
          <span style="font-family:${F.body}; font-size:calc(var(--kk-font-scale, 1) * 9.5px); letter-spacing:0.18em; text-transform:uppercase; color:rgba(245,239,225,0.6);">${escapeHtml(stageShort)}</span>
        </span>
      `;

      // Dedicated remove (✕) button — keyboard-reachable and trivial to hit.
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.textContent = '✕';
      closeBtn.title = 'Delete preset';
      closeBtn.style.cssText = `
        position: absolute; top: 50%; right: 6px; transform: translateY(-50%);
        width: 18px; height: 18px; padding: 0;
        background: transparent; border: none;
        color: rgba(245,239,225,0.45); cursor: pointer;
        font-family: ${F.mono}; font-size: calc(var(--kk-font-scale, 1) * 12px); line-height: 1;
      `;
      closeBtn.addEventListener('mouseenter', () => { closeBtn.style.color = C.red; });
      closeBtn.addEventListener('mouseleave', () => { closeBtn.style.color = 'rgba(245,239,225,0.45)'; });
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        confirmRemove(p.id, p.name);
      });
      chip.appendChild(closeBtn);

      chip.addEventListener('mouseenter', () => {
        chip.style.transform = 'translateY(-2px)';
        chip.style.borderColor = PRESET_C;
      });
      chip.addEventListener('mouseleave', () => {
        chip.style.transform = 'translateY(0)';
        chip.style.borderColor = C.edge;
      });

      // Long-press to delete (mobile/touch friendly) — 600ms hold.
      let _lp = null;
      chip.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        _lp = setTimeout(() => { _lp = null; confirmRemove(p.id, p.name); }, 600);
      });
      const cancelLP = () => { if (_lp) { clearTimeout(_lp); _lp = null; } };
      chip.addEventListener('mouseup', cancelLP);
      chip.addEventListener('mouseleave', cancelLP);

      // Right-click also deletes.
      chip.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        confirmRemove(p.id, p.name);
      });

      chip.addEventListener('click', (e) => {
        if (_lp) return; // long-press fired
        e.stopPropagation();
        // applyPreset mutates the singleton meta object in place (same ref as
        // our `meta` capture), so paintChars/paintStages re-read the new
        // selection automatically — no manual sync needed.
        applyPreset(p.id);
        paintChars();
        if (typeof paintStages === 'function') paintStages();
        paintPresets();
        _refreshStartFocus();
      });
      chip.addEventListener('keydown', (e) => {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          e.stopPropagation();
          confirmRemove(p.id, p.name);
        }
      });

      presetChips.appendChild(chip);
    }

    // "+ Save Current" chip (or disabled cap chip).
    const saveChip = document.createElement('div');
    saveChip.setAttribute('data-focusable', '1');
    saveChip.tabIndex = 0;
    const disabled = full;
    saveChip.style.cssText = `
      padding: 8px 16px;
      background: ${disabled
        ? 'rgba(20,28,22,0.5)'
        : 'linear-gradient(180deg, rgba(200,123,255,0.18), rgba(110,60,180,0.14))'};
      border: 1px dashed ${disabled ? 'rgba(120,120,120,0.4)' : PRESET_C};
      border-radius: 999px;
      box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 18px rgba(0,0,0,0.5);
      color: ${disabled ? 'rgba(120,120,120,0.6)' : PRESET_C};
      cursor: ${disabled ? 'not-allowed' : 'pointer'};
      font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 11px);
      letter-spacing: 0.20em; font-weight: 700;
      display: inline-flex; align-items: center; gap: 6px;
      transition: transform 0.14s ease, border-color 0.14s ease;
    `;
    saveChip.textContent = disabled ? `Slots Full (${PRESET_CAP})` : '+ Save Current';
    if (!disabled) {
      saveChip.addEventListener('mouseenter', () => {
        saveChip.style.transform = 'translateY(-2px)';
        saveChip.style.borderColor = '#e8a3ff';
      });
      saveChip.addEventListener('mouseleave', () => {
        saveChip.style.transform = 'translateY(0)';
        saveChip.style.borderColor = PRESET_C;
      });
      saveChip.addEventListener('click', (e) => {
        e.stopPropagation();
        showSavePrompt();
      });
      saveChip.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          showSavePrompt();
        }
      });
    }
    presetChips.appendChild(saveChip);
  }
  paintPresets();

  presetRow.appendChild(presetSubtitle);
  presetRow.appendChild(presetChips);
  presetRow.appendChild(presetPrompt);
  _selectPanel.appendChild(presetRow);
  _startPresetRowRef = presetRow;

  _selectPanel.appendChild(charRow);
  // Iter 34 — Phase C: archetype chip row deleted. Gameplay derives from the
  // avatar carousel selection via AVATARS[].baseArchetype. The `archRow` DOM
  // element is still constructed above for now (so `paintArchetypes()` calls
  // elsewhere don't crash); it just isn't mounted into the start panel. Phase
  // F prunes the dead construction once CHARACTERS is removed.
  _selectPanel.appendChild(modeRow);

  // ── Select panel footer: Start Run + Back to Menu ──
  const selectFooter = document.createElement('div');
  selectFooter.style.cssText = 'display:flex; gap:12px; margin-top:10px; pointer-events:auto; flex-wrap:wrap; justify-content:center;';
  selectFooter.addEventListener('click', (e) => { e.stopPropagation(); });

  const startRunBtn = document.createElement('button');
  startRunBtn.type = 'button';
  startRunBtn.textContent = '▶  PLAY';
  startRunBtn.className = 'kk-btn-primary';
  startRunBtn.style.cssText = `
    padding: 12px 34px; cursor: pointer;
    background: linear-gradient(180deg, rgba(255,210,127,0.22), rgba(180,130,40,0.26));
    border: 1px solid ${C.amber};
    border-radius: 10px;
    color: ${C.amber};
    font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 18px); font-weight: 800;
    letter-spacing: 0.28em;
    box-shadow: 0 1px 0 rgba(255,255,255,0.08) inset, 0 12px 24px rgba(0,0,0,0.55), 0 0 22px rgba(255,210,127,0.22);
  `;
  startRunBtn.addEventListener('mouseenter', () => { try { sfx.uiHover(); } catch (_) {} });
  startRunBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    try { sfx.uiClick(); } catch (_) {}
    if (typeof window !== 'undefined' && typeof window.kkStartRun === 'function') window.kkStartRun();
  });

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.textContent = '‹  BACK';
  backBtn.style.cssText = `
    padding: 14px 26px; cursor: pointer;
    background: linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86));
    border: 1px solid ${C.edge};
    border-radius: 10px;
    color: ${C.text};
    font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 13px); font-weight: 700;
    letter-spacing: 0.28em;
  `;
  backBtn.addEventListener('mouseenter', () => { try { sfx.uiHover(); } catch (_) {} });
  backBtn.addEventListener('click', (e) => { e.stopPropagation(); _setStartView('menu'); });

  selectFooter.appendChild(backBtn);
  selectFooter.appendChild(startRunBtn);
  _selectPanel.appendChild(selectFooter);

  // ── Menu panel: big Play button + existing btnRow (meta buttons + mode toggles) ──
  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.textContent = '▶  PLAY';
  playBtn.style.cssText = `
    padding: 18px 60px; cursor: pointer;
    background: linear-gradient(180deg, rgba(255,210,127,0.22), rgba(180,130,40,0.26));
    border: 1px solid ${C.amber};
    border-radius: 12px;
    color: ${C.amber};
    font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 22px); font-weight: 800;
    letter-spacing: 0.32em;
    box-shadow: 0 1px 0 rgba(255,255,255,0.08) inset, 0 14px 28px rgba(0,0,0,0.6), 0 0 24px rgba(255,210,127,0.22);
  `;
  playBtn.addEventListener('mouseenter', () => { try { sfx.uiHover(); } catch (_) {} });
  playBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    try { sfx.uiClick(); } catch (_) {}
    _setStartView('select');
  });
  _menuPanel.appendChild(playBtn);
  _menuPanel.appendChild(btnRow);

  _startCharRowRef = charRow;
  _startBtnRowRef = btnRow;
  _startView = 'menu';
  _menuPanel.style.display = 'flex';
  _selectPanel.style.display = 'none';
  _root.appendChild(_startScreen);
  _refreshStartFocus();
  // Surface the build version in the bottom-right corner. Attached to body so
  // it survives modal stacks AND doesn't fight the start-screen flex layout.
  _setVersionLabelVisible(true);
}

export function hideStartScreen() {
  if (_startFocusScope) { popFocusScope(_startFocusScope); _startFocusScope = null; }
  if (_charCarousel) { try { _charCarousel.destroy(); } catch (_) {} _charCarousel = null; }
  _menuPanel = null;
  _selectPanel = null;
  _startView = 'menu';
  _startStageRowRef = null;
  _startCharRowRef = null;
  _startBtnRowRef = null;
  _startPresetRowRef = null;
  // Clear any active tooltip BEFORE removing the start-screen DOM. Character
  // cards register tooltips bound to themselves; if the player clicks/Space's
  // through while hovering, removing _startScreen orphans the card and no
  // mouseleave fires — leaving the tooltip stuck at opacity:1 over gameplay.
  try { hideTooltip(); } catch (_) {}
  if (_startScreen && _startScreen.parentNode) {
    _startScreen.parentNode.removeChild(_startScreen);
  }
  _startScreen = null;
  // Hide the version pill in-run — it's only contextually useful on the menu /
  // start screen, where the player might want to share a bug report with build.
  _setVersionLabelVisible(false);
}

// ── Slot machine helpers ─────────────────────────────────────────────────────
const _outcomeTiers = ['single', 'double', 'triple', 'jackpot'];

function _outcomeText(outcome) {
  if (outcome.tier === 'jackpot') return '777 JACKPOT! MAX UPGRADES';
  if (outcome.tier === 'triple')  return `TRIPLE ${outcome.symbol.icon} — ${outcome.symbol.name} x3`;
  if (outcome.tier === 'double')  return `PAIR ${outcome.symbol.icon} — ${outcome.symbol.name} x2`;
  return `${outcome.symbol.icon} — ${outcome.symbol.name}`;
}

function _outcomeStyle(tier) {
  if (tier === 'jackpot') return { color: '#ffe14a', size: 36 };
  if (tier === 'triple')  return { color: '#ffe14a', size: 28 };
  if (tier === 'double')  return { color: C.cyan,    size: 24 };
  return { color: C.cyan, size: 22 };
}

// Note: outcome is NOT applied until the player chooses (Take / Gamble).
// continueBtn.onclick is set by caller to commit current `_pendingOutcome`.
function _showOutcome(outcome, result, continueBtn, gambleBtn) {
  const ts = _outcomeStyle(outcome.tier);
  result.style.color = ts.color;
  result.style.textShadow = `0 0 12px ${ts.color}, 0 0 28px ${ts.color}`;
  result.style.fontSize = ts.size + 'px';
  result.textContent = _outcomeText(outcome);
  continueBtn.style.display = 'inline-block';
  if (outcome.tier === 'jackpot') {
    state.fx.shake = Math.max(state.fx.shake, 1.0);
    state.fx.bloomBoost = 1.0;
  } else if (outcome.tier === 'triple') {
    state.fx.shake = Math.max(state.fx.shake, 0.6);
    state.fx.bloomBoost = 0.7;
  }
}

// Classic double-or-nothing: 50/50. Win → apply 2× outcome. Lose → apply nothing.
function _doGamble(pendingRef, result, continueBtn, gambleBtn) {
  gambleBtn.style.display = 'none';
  gambleBtn.onclick = null;
  const prev = pendingRef.outcome;
  const win = Math.random() < 0.5;
  if (win) {
    // Replace the pending outcome with a doubled version
    const doubled = {
      tier: prev.tier === 'single' ? 'double'
          : prev.tier === 'double' ? 'triple'
          : prev.tier === 'triple' ? 'jackpot'
          : prev.tier,
      symbol: prev.symbol,
      count: Math.min(3, (prev.count || 1) * 2),
    };
    pendingRef.outcome = doubled;
    const ts = _outcomeStyle(doubled.tier);
    result.style.color = ts.color;
    result.style.textShadow = `0 0 12px ${ts.color}, 0 0 28px ${ts.color}`;
    result.style.fontSize = ts.size + 'px';
    result.textContent = `🎲 DOUBLED! ${_outcomeText(doubled)}`;
    state.fx.shake = Math.max(state.fx.shake, 0.7);
    state.fx.bloomBoost = 0.9;
  } else {
    pendingRef.outcome = null;  // nothing applied on commit
    result.textContent = '💀 BUSTED — Nothing for you.';
    result.style.color = '#ff5566';
    result.style.textShadow = '0 0 12px #ff5566, 0 0 28px #ff5566';
    result.style.fontSize = '22px';
    state.fx.shake = Math.max(state.fx.shake, 0.35);
  }
}

// ── Slot machine modal ───────────────────────────────────────────────────────
let _slotModal = null;
let _slotKeyHandler = null;

export function isSlotOpen() { return !!_slotModal; }

export function showSlotMachine() {
  // Iter 21a — defensive tooltip hide on modal entry.
  try { hideTooltip(); } catch (_) {}
  if (_slotModal) return;
  state.time.paused = true;

  _slotModal = document.createElement('div');
  _slotModal.style.cssText = `
    position: fixed; inset: 0;
    background:
      radial-gradient(ellipse at 50% 30%, rgba(255,210,127,0.08), transparent 60%),
      radial-gradient(ellipse at center, rgba(0,0,0,0.55), rgba(0,0,0,0.9) 80%);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    pointer-events: auto;
    font-family: ${F.body};
    z-index: 105;
  `;

  const title = document.createElement('div');
  title.textContent = 'Treasure';
  title.style.cssText = `font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 52px); font-weight: 900;
    letter-spacing: 0.20em; color: ${C.amber};
    text-shadow: 0 2px 18px rgba(0,0,0,0.6), 0 0 28px rgba(255,210,127,0.22);
    margin-bottom: 6px;`;

  const slotSub = document.createElement('div');
  slotSub.style.cssText = `font-family: ${F.body}; font-size: calc(var(--kk-font-scale, 1) * 11px); letter-spacing: 0.34em;
    color: rgba(245,239,225,0.62); text-transform: uppercase; margin-bottom: 22px;`;
  slotSub.textContent = 'Spin the reels of fortune';

  // Reel cabinet
  const reelRow = document.createElement('div');
  reelRow.style.cssText = `display: flex; gap: 14px; margin-bottom: 22px;
    background: linear-gradient(180deg, rgba(20,28,22,0.94), rgba(8,14,12,0.96));
    border: 1px solid ${C.edge}; border-radius: 12px;
    box-shadow:
      0 1px 0 rgba(255,255,255,0.06) inset,
      0 0 0 1px rgba(0,0,0,0.4),
      0 24px 48px rgba(0,0,0,0.6);
    padding: 22px 26px;`;

  const reels = [];
  for (let i = 0; i < 3; i++) {
    const r = document.createElement('div');
    r.style.cssText = `width: 116px; height: 138px;
      background: linear-gradient(180deg, rgba(8,12,10,0.9), rgba(4,6,5,0.95));
      border: 1px solid ${C.edge};
      border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-size: calc(var(--kk-font-scale, 1) * 64px); line-height: 1;
      box-shadow: inset 0 2px 10px rgba(0,0,0,0.7), inset 0 -1px 0 rgba(255,255,255,0.04);
      filter: drop-shadow(0 4px 8px rgba(0,0,0,0.4));`;
    r.textContent = '❓';
    reels.push(r);
    reelRow.appendChild(r);
  }

  const result = document.createElement('div');
  result.style.cssText = `min-height: 56px; font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 24px); font-weight: 700;
    letter-spacing: 0.22em; color: ${C.text};
    margin-bottom: 18px; text-align: center;`;
  result.textContent = 'Rolling…';

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display: flex; gap: 14px;';

  const slotBtnStyle = (accent) => `padding: 12px 28px; cursor: pointer;
    background: linear-gradient(180deg, rgba(20,28,22,0.94), rgba(8,14,12,0.96));
    border: 1px solid ${accent};
    border-radius: 8px;
    color: ${accent};
    font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 14px); font-weight: 700;
    letter-spacing: 0.28em;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 12px 26px rgba(0,0,0,0.55);
    display: none;`;

  const gambleBtn = document.createElement('button');
  gambleBtn.type = 'button';
  gambleBtn.textContent = 'Double or Nothing · G';
  gambleBtn.style.cssText = slotBtnStyle(C.amber);

  const continueBtn = document.createElement('button');
  continueBtn.type = 'button';
  continueBtn.textContent = 'Take It · Space';
  continueBtn.style.cssText = slotBtnStyle(C.magenta);
  // pending outcome ref — mutated by gamble if used
  const pending = { outcome: null };
  continueBtn.addEventListener('click', () => {
    if (pending.outcome) applyOutcome(pending.outcome);
    _closeSlot();
  });

  btnRow.appendChild(gambleBtn);
  btnRow.appendChild(continueBtn);

  _slotModal.appendChild(title);
  _slotModal.appendChild(slotSub);
  _slotModal.appendChild(reelRow);
  _slotModal.appendChild(result);
  _slotModal.appendChild(btnRow);
  _root.appendChild(_slotModal);

  // ── Spin animation ──
  // iter 33r — was 1100/1750/2500ms (~2.7s total), too long with chest cadence
  // bumped down. Cut to 500/800/1100ms (~1.3s total). Skip button + Space
  // during spin snap reels to final state immediately.
  const stops = [500, 800, 1100];
  const finalRolls = [rollReel(), rollReel(), rollReel()];

  let elapsed = 0;
  let lastTick = performance.now();
  let _skipped = false;

  function symbolForFrame(reelIdx, t) {
    const stop = stops[reelIdx];
    if (t >= stop) return finalRolls[reelIdx].icon;
    // Cycle speed slows as we approach stop time
    const tRem = stop - t;
    const speed = Math.max(30, 220 - tRem * 0.3);
    const idx = Math.floor(t / speed) % SLOT_SYMBOLS.length;
    return SLOT_SYMBOLS[idx].icon;
  }

  function _finalizeSpin() {
    for (let i = 0; i < 3; i++) {
      reels[i].textContent = finalRolls[i].icon;
      reels[i].style.borderColor = C.amber;
      reels[i].style.boxShadow = `0 0 18px ${C.amber}, inset 0 0 12px rgba(0,0,0,0.7)`;
    }
    skipBtn.style.display = 'none';
    const outcome = resolveOutcome(finalRolls);
    pending.outcome = outcome;
    _showOutcome(outcome, result, continueBtn, gambleBtn);
    if (outcome.tier !== 'jackpot') {
      gambleBtn.style.display = 'inline-block';
      gambleBtn.onclick = () => _doGamble(pending, result, continueBtn, gambleBtn);
    }
  }

  function animLoop() {
    if (_skipped) return;
    const now = performance.now();
    const dt = now - lastTick;
    lastTick = now;
    elapsed += dt;

    for (let i = 0; i < 3; i++) reels[i].textContent = symbolForFrame(i, elapsed);

    // Lock indicator: when a reel stops, flash its border
    for (let i = 0; i < 3; i++) {
      if (elapsed >= stops[i] && reels[i].style.borderColor !== C.amber) {
        reels[i].style.borderColor = C.amber;
        reels[i].style.boxShadow = `0 0 18px ${C.amber}, inset 0 0 12px rgba(0,0,0,0.7)`;
      }
    }

    if (elapsed < stops[2] + 150) {
      _slotRAF = requestAnimationFrame(animLoop);
      return;
    }
    _finalizeSpin();
  }
  let _slotRAF = requestAnimationFrame(animLoop);
  _slotModal.__rafId = () => _slotRAF;

  // iter 33r — Skip button (visible during spin). Click or press Space/Enter
  // mid-spin to snap reels to final state immediately.
  const skipBtn = document.createElement('button');
  skipBtn.type = 'button';
  skipBtn.textContent = 'Skip · Space';
  skipBtn.style.cssText = `padding: 10px 22px; cursor: pointer;
    background: linear-gradient(180deg, rgba(20,28,22,0.94), rgba(8,14,12,0.96));
    border: 1px solid rgba(245,239,225,0.4); border-radius: 8px;
    color: rgba(245,239,225,0.85);
    font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 12px); font-weight: 700;
    letter-spacing: 0.28em;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 12px 26px rgba(0,0,0,0.55);
    margin-bottom: 12px;`;
  skipBtn.addEventListener('click', () => {
    if (_skipped) return;
    _skipped = true;
    if (_slotRAF) cancelAnimationFrame(_slotRAF);
    _finalizeSpin();
  });
  // Insert skip ABOVE the result line so layout is stable.
  _slotModal.insertBefore(skipBtn, result);

  _slotKeyHandler = (e) => {
    // During spin, Space/Enter skips to final state.
    if (!pending.outcome && !_skipped) {
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        _skipped = true;
        if (_slotRAF) cancelAnimationFrame(_slotRAF);
        _finalizeSpin();
        return;
      }
      return;
    }
    if (continueBtn.style.display === 'none') return;
    if (e.code === 'Enter' || e.code === 'Space') {
      if (pending.outcome) applyOutcome(pending.outcome);
      _closeSlot();
    } else if (e.code === 'KeyG' && gambleBtn.style.display !== 'none') {
      _doGamble(pending, result, continueBtn, gambleBtn);
    } else if (e.code === 'Escape') {
      if (pending.outcome) applyOutcome(pending.outcome);
      _closeSlot();
    }
  };
  window.addEventListener('keydown', _slotKeyHandler);
}

function _closeSlot() {
  if (!_slotModal) return;
  if (_slotKeyHandler) window.removeEventListener('keydown', _slotKeyHandler);
  _slotKeyHandler = null;
  if (_slotModal.parentNode) _slotModal.parentNode.removeChild(_slotModal);
  _slotModal = null;
  if (!state.gameOver && state.started) state.time.paused = false;
}

// ── Casino — Seedy Tent modals (iter 22B) ────────────────────────────────────
// Three modals: showCasinoMenu (entry hub) → showCasinoSlots / showBossRushWager.
// All share an Esc-to-close handler and the dark-amber gambling aesthetic.
// State + RNG live in casino.js; this layer is presentation + input only.
let _casinoModal = null;
let _casinoKey = null;

function _closeCasino() {
  if (!_casinoModal) return;
  if (_casinoKey) window.removeEventListener('keydown', _casinoKey);
  _casinoKey = null;
  if (_casinoModal.parentNode) _casinoModal.parentNode.removeChild(_casinoModal);
  _casinoModal = null;
  try { sfx.modalClose(); } catch (_) {}
}

// Shared dark-tent backdrop CSS — matches the lantern-red palette.
const _CASINO_BG = `
  position: fixed; inset: 0;
  background:
    radial-gradient(ellipse at 50% 30%, rgba(255,80,80,0.10), transparent 60%),
    radial-gradient(ellipse at center, rgba(0,0,0,0.6), rgba(0,0,0,0.92) 80%);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  display: flex; flex-direction: column;
  align-items: center; justify-content: flex-start;
  pointer-events: auto;
  z-index: 122;
  overflow-y: auto;
  padding: 48px 20px;
`;

// Tiny color/balance helpers used across all three casino modals.
const CASINO_RED = '#ff5e5e';
function _embers() { return getMeta().embers || 0; }
function _emberLine(label) {
  const m = getMeta();
  const won = (m.casinoLifetimeWon || 0);
  const wagered = (m.casinoLifetimeWagered || 0);
  return `
    <div style="font-family:${F.display}; font-size:calc(var(--kk-font-scale,1) * 22px); color:#ffae6a;
                margin-bottom: 22px; letter-spacing:0.18em;
                display:flex; gap:24px; flex-wrap:wrap; justify-content:center; align-items:baseline;">
      <span style="display:inline-flex;align-items:baseline;gap:10px;">
        <span style="font-family:${F.body};font-size:calc(var(--kk-font-scale,1) * 13px);letter-spacing:0.32em;color:rgba(245,239,225,0.62);text-transform:uppercase;">${label || 'Embers'}</span>
        <span style="font-family:${F.mono};">${_embers().toLocaleString()}</span> 🔥
      </span>
      <span style="display:inline-flex;align-items:baseline;gap:10px;font-size:calc(var(--kk-font-scale,1) * 13px);color:rgba(245,239,225,0.5);">
        <span style="letter-spacing:0.32em;text-transform:uppercase;">Lifetime</span>
        <span style="font-family:${F.mono};">+${won.toLocaleString()} / −${wagered.toLocaleString()}</span>
      </span>
    </div>`;
}

/**
 * Casino entry hub — two big buttons (Slots, Boss Rush Wager) + a status line
 * if a wager is already pending (which blocks starting another one).
 */
// Iter 33e — Casino dashboard. Tabbed hub with three sections:
//   Games  — Slots (Embers) and Parlay (Sigils 50/50 doubler)
//   Buffs  — Permanent + Temporary powerups paid in Sigils
//   House  — Casino unlocks paid in Sigils
// Always available, no gating.
let _casinoTab = 'games';
export function showCasinoMenu(initialTab) {
  try { hideTooltip(); } catch (_) {}
  if (_casinoModal) return;
  if (initialTab === 'games' || initialTab === 'buffs' || initialTab === 'house') {
    _casinoTab = initialTab;
  }
  try { sfx.modalOpen(); } catch (_) {}
  _casinoModal = document.createElement('div');
  _casinoModal.style.cssText = _CASINO_BG;

  const meta = (function(){ try { return JSON.parse(localStorage.getItem('kk_meta') || '{}'); } catch (_) { return {}; } })();
  const sigils = meta.sigils || 0;
  const embers = meta.embers || 0;

  const header = document.createElement('div');
  header.innerHTML = `
    <div style="font-family:${F.display}; font-size:calc(var(--kk-font-scale,1) * 40px); font-weight:900;
                letter-spacing:0.22em; color:${CASINO_RED};
                text-shadow: 0 2px 18px rgba(0,0,0,0.7), 0 0 30px rgba(255,80,80,0.25);
                margin-bottom: 4px; text-align:center;">The Seedy Tent</div>
    <div style="font-family:${F.body}; font-size:calc(var(--kk-font-scale,1) * 11px); letter-spacing:0.34em;
                color:rgba(245,239,225,0.55); text-transform:uppercase; margin-bottom: 14px; text-align:center;">
      Pull the lever. Cash the sigils. The wheel remembers.
    </div>
    <div style="display:flex; gap:18px; justify-content:center; margin-bottom:18px; font-family:${F.display}; letter-spacing:0.22em;">
      <div style="color:#ffd27f; font-size:calc(var(--kk-font-scale,1) * 16px);">🔥 ${embers.toLocaleString()} Embers</div>
      <div style="color:#c9a4ff; font-size:calc(var(--kk-font-scale,1) * 16px);">✦ ${sigils.toLocaleString()} Sigils</div>
    </div>
  `;
  _casinoModal.appendChild(header);

  const tabRow = document.createElement('div');
  tabRow.style.cssText = 'display:flex; gap:8px; margin-bottom:16px;';
  const tabs = [
    { id: 'games', label: 'Games' },
    { id: 'buffs', label: 'Buffs' },
    { id: 'house', label: 'House' },
  ];
  const body = document.createElement('div');
  body.style.cssText = 'max-width: 760px; width: 100%; min-height: 280px; display:flex; flex-direction:column; gap:10px;';

  const renderTab = () => {
    body.innerHTML = '';
    if (_casinoTab === 'games') {
      body.appendChild(_buildGamesTab());
    } else if (_casinoTab === 'buffs') {
      body.appendChild(_buildBuffsTab());
    } else {
      body.appendChild(_buildHouseTab());
    }
    for (const tb of tabRow.children) {
      const active = tb.dataset.tabid === _casinoTab;
      tb.style.background = active ? `linear-gradient(180deg, rgba(60,28,28,0.96), rgba(28,12,12,0.96))` : `linear-gradient(180deg, rgba(20,12,12,0.78), rgba(10,6,6,0.86))`;
      tb.style.color = active ? '#ffd27f' : 'rgba(245,239,225,0.55)';
      tb.style.borderColor = active ? CASINO_RED : C.edge;
    }
  };

  for (const t of tabs) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.tabid = t.id;
    b.textContent = t.label;
    b.style.cssText = `padding:9px 22px; cursor:pointer; border-radius:8px; border:1px solid ${C.edge};
      font-family:${F.display}; letter-spacing:0.26em; font-size:calc(var(--kk-font-scale,1) * 13px);
      background:linear-gradient(180deg, rgba(20,12,12,0.78), rgba(10,6,6,0.86)); color:rgba(245,239,225,0.55);`;
    b.onclick = () => { try { sfx.uiClick(); } catch (_) {} _casinoTab = t.id; renderTab(); };
    tabRow.appendChild(b);
  }
  _casinoModal.appendChild(tabRow);
  _casinoModal.appendChild(body);
  renderTab();

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Leave · Esc';
  close.style.cssText = `padding: 10px 26px; cursor: pointer; margin-top:16px;
    background: linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86));
    border: 1px solid ${C.edge}; border-radius: 8px;
    color: ${C.magenta}; font-family: ${F.display}; font-size: calc(var(--kk-font-scale,1) * 13px); font-weight: 700;
    letter-spacing: 0.28em;`;
  close.onclick = _closeCasino;
  _casinoModal.appendChild(close);
  _root.appendChild(_casinoModal);

  _casinoKey = (e) => { if (e.code === 'Escape') _closeCasino(); };
  window.addEventListener('keydown', _casinoKey);
}

function _buildGamesTab() {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:grid; grid-template-columns: 1fr 1fr; gap:14px;';
  const mkCard = (icon, name, sub, accent, onclick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.style.cssText = `padding:22px 18px; cursor:pointer;
      background: linear-gradient(180deg, rgba(28,16,16,0.94), rgba(14,8,8,0.96));
      border: 1px solid ${accent}; border-radius: 12px; color:${accent};
      font-family:${F.display}; letter-spacing:0.22em;
      box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 14px 28px rgba(0,0,0,0.6);`;
    b.innerHTML = `
      <div style="font-size:calc(var(--kk-font-scale,1) * 40px); margin-bottom:6px;">${icon}</div>
      <div style="font-size:calc(var(--kk-font-scale,1) * 18px); font-weight:700;">${name}</div>
      <div style="font-size:calc(var(--kk-font-scale,1) * 11px); opacity:0.7; margin-top:6px;">${sub}</div>`;
    b.onclick = () => { try { sfx.uiClick(); } catch (_) {} onclick(); };
    return b;
  };
  wrap.appendChild(mkCard('🎰', 'Slots', '3-reel · pays Embers', '#ffd27f', () => { _closeCasino(); showCasinoSlots(); }));
  wrap.appendChild(mkCard('🪙', 'Parlay', '50/50 · sigil doubler', '#c9a4ff', () => { _closeCasino(); showCasinoParlay(); }));
  return wrap;
}

function _buildBuffsTab() {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex; flex-direction:column; gap:14px;';
  // Lazy-import catalogs each render so the data is always fresh
  import('./casino.js').then(({ CASINO_PERM_BUFFS, CASINO_RUN_BUFFS, permLevel, buyPerm, buyRunBuff }) => {
    wrap.innerHTML = '';
    const sec = (title, color) => {
      const h = document.createElement('div');
      h.style.cssText = `font-family:${F.display}; letter-spacing:0.32em; color:${color}; font-size:calc(var(--kk-font-scale,1) * 13px); margin:6px 0 4px;`;
      h.textContent = title;
      return h;
    };
    wrap.appendChild(sec('PERMANENT — Spent Sigils, kept forever', '#ffd27f'));
    for (const def of CASINO_PERM_BUFFS) {
      const lvl = permLevel(def.id);
      const cost = def.cost * (lvl + 1);
      wrap.appendChild(_buffRow(def, `${def.desc}`, `Lv ${lvl}/${def.max}`, cost, lvl >= def.max, () => {
        if (buyPerm(def.id)) { try { sfx.uiClick(); } catch (_) {} renderBuffs(); }
      }));
    }
    wrap.appendChild(sec('TEMPORARY — One-shot, applied next run', '#c9a4ff'));
    for (const def of CASINO_RUN_BUFFS) {
      wrap.appendChild(_buffRow(def, def.desc, 'Queues', def.cost, false, () => {
        if (buyRunBuff(def.id)) { try { sfx.uiClick(); } catch (_) {} renderBuffs(); }
      }));
    }
  });
  const renderBuffs = () => {
    // Re-render full menu when sigil count or levels change so the header
    // and all "buy" affordability checks stay current.
    _closeCasino();
    showCasinoMenu();
  };
  return wrap;
}

function _buffRow(def, descText, levelText, cost, maxed, onBuy) {
  const meta = (function(){ try { return JSON.parse(localStorage.getItem('kk_meta') || '{}'); } catch (_) { return {}; } })();
  const sigils = meta.sigils || 0;
  const canAfford = sigils >= cost && !maxed;
  const row = document.createElement('div');
  row.style.cssText = `display:grid; grid-template-columns: 38px 1fr auto; gap:12px; align-items:center;
    background: linear-gradient(180deg, rgba(20,12,12,0.86), rgba(10,6,6,0.86));
    border: 1px solid ${C.edge}; border-radius: 8px; padding: 10px 14px;`;
  row.innerHTML = `
    <div style="font-size:calc(var(--kk-font-scale,1) * 26px); text-align:center;">${def.icon}</div>
    <div>
      <div style="font-family:${F.display}; letter-spacing:0.22em; color:#f5efe1; font-size:calc(var(--kk-font-scale,1) * 13px);">${def.name}</div>
      <div style="font-family:${F.body}; font-size:calc(var(--kk-font-scale,1) * 11px); color:rgba(245,239,225,0.6);">${descText} · <span style="color:#c9a4ff;">${levelText}</span></div>
    </div>`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = maxed ? 'MAX' : `${cost} ✦`;
  btn.disabled = !canAfford;
  btn.style.cssText = `padding:8px 16px; cursor:${canAfford ? 'pointer' : 'not-allowed'};
    background: linear-gradient(180deg, rgba(60,28,28,0.94), rgba(28,12,12,0.96));
    border: 1px solid ${canAfford ? CASINO_RED : C.edge}; border-radius: 6px;
    color: ${canAfford ? '#ffd27f' : 'rgba(245,239,225,0.4)'};
    font-family:${F.display}; letter-spacing:0.22em; font-size:calc(var(--kk-font-scale,1) * 12px);`;
  btn.onclick = canAfford ? onBuy : null;
  row.appendChild(btn);
  return row;
}

function _buildHouseTab() {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex; flex-direction:column; gap:14px;';
  import('./casino.js').then(({ CASINO_HOUSE_UPGRADES, houseOwned, buyHouse }) => {
    wrap.innerHTML = '';
    const h = document.createElement('div');
    h.style.cssText = `font-family:${F.display}; letter-spacing:0.32em; color:#ffd27f; font-size:calc(var(--kk-font-scale,1) * 13px); margin:6px 0 4px;`;
    h.textContent = 'HOUSE — One-time unlocks';
    wrap.appendChild(h);
    for (const def of CASINO_HOUSE_UPGRADES) {
      const owned = houseOwned(def.id);
      wrap.appendChild(_buffRow(def, def.desc, owned ? 'OWNED' : 'Not owned', def.cost, owned, () => {
        if (buyHouse(def.id)) { try { sfx.uiClick(); } catch (_) {} _closeCasino(); showCasinoMenu(); }
      }));
    }
    const stub = document.createElement('div');
    stub.style.cssText = `font-family:${F.body}; font-size:calc(var(--kk-font-scale,1) * 10.5px); color:rgba(245,239,225,0.45); margin-top:8px; text-align:center;`;
    stub.textContent = 'More tables, decks, and dens unlocking in upcoming iters.';
    wrap.appendChild(stub);
  });
  return wrap;
}

// Parlay modal — single-track pure 50/50 doubler. Player stakes N sigils
// (range PARLAY_MIN_BET..PARLAY_MAX_BET capped at current balance). Each flip
// either doubles the pool or wipes it; the player chooses when to cash out.
export function showCasinoParlay() {
  try { hideTooltip(); } catch (_) {}
  if (_casinoModal) return;
  try { sfx.modalOpen(); } catch (_) {}
  _casinoModal = document.createElement('div');
  _casinoModal.style.cssText = _CASINO_BG;
  import('./casino.js').then(({ parlayFlip, settleParlay, PARLAY_MIN_BET, PARLAY_MAX_BET }) => {
    _casinoModal.innerHTML = '';
    const meta = (function(){ try { return JSON.parse(localStorage.getItem('kk_meta') || '{}'); } catch (_) { return {}; } })();
    let sigils = meta.sigils || 0;
    let seed = 0;        // sigils committed at game start
    let pool = 0;        // current pool (doubles or wipes per flip)
    let flips = 0;
    let busted = false;

    const title = document.createElement('div');
    title.style.cssText = `font-family:${F.display}; font-size:calc(var(--kk-font-scale,1) * 40px); font-weight:900;
      letter-spacing:0.22em; color:#c9a4ff; margin-bottom:6px; text-align:center;`;
    title.textContent = 'Parlay';
    _casinoModal.appendChild(title);

    const sub = document.createElement('div');
    sub.style.cssText = `font-family:${F.body}; font-size:calc(var(--kk-font-scale,1) * 11px); letter-spacing:0.34em;
      color:rgba(245,239,225,0.55); text-transform:uppercase; margin-bottom:18px; text-align:center;`;
    sub.textContent = '50/50 flip · cash out anytime · bust wipes pool';
    _casinoModal.appendChild(sub);

    const state_ = document.createElement('div');
    state_.style.cssText = `max-width:520px; width:100%; padding:18px 22px; margin-bottom:14px;
      background: linear-gradient(180deg, rgba(28,18,40,0.96), rgba(12,8,18,0.96));
      border:1px solid #c9a4ff; border-radius:12px; text-align:center;
      font-family:${F.display}; letter-spacing:0.22em;`;
    _casinoModal.appendChild(state_);

    const controls = document.createElement('div');
    controls.style.cssText = `display:flex; gap:10px; justify-content:center; margin-bottom:18px;`;
    _casinoModal.appendChild(controls);

    const refreshUI = () => {
      const balance = sigils - seed + pool;
      state_.innerHTML = `
        <div style="color:#c9a4ff; font-size:calc(var(--kk-font-scale,1) * 12px); margin-bottom:6px;">FLIPS · ${flips}</div>
        <div style="color:#f5efe1; font-size:calc(var(--kk-font-scale,1) * 24px); margin-bottom:6px;">Pool: ${pool} ✦</div>
        <div style="color:rgba(245,239,225,0.6); font-size:calc(var(--kk-font-scale,1) * 11px);">Wallet now: ${balance} ✦</div>
        ${busted ? `<div style="color:${CASINO_RED}; margin-top:8px;">BUST · pool wiped</div>` : ''}
      `;
      controls.innerHTML = '';
      const mkBtn = (label, accent, onclick, disabled = false) => {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = label;
        b.disabled = disabled;
        b.style.cssText = `padding:10px 22px; cursor:${disabled ? 'not-allowed' : 'pointer'};
          background: linear-gradient(180deg, rgba(40,24,56,0.94), rgba(20,12,28,0.96));
          border:1px solid ${disabled ? C.edge : accent}; border-radius:8px;
          color:${disabled ? 'rgba(245,239,225,0.4)' : accent}; font-family:${F.display}; letter-spacing:0.24em; font-size:calc(var(--kk-font-scale,1) * 13px);`;
        b.onclick = disabled ? null : onclick;
        return b;
      };
      if (pool === 0 && !busted) {
        // Pick a seed
        for (const v of [5, 10, 25, 50, 100]) {
          const can = v >= PARLAY_MIN_BET && v <= PARLAY_MAX_BET && sigils >= v;
          controls.appendChild(mkBtn(`Stake ${v} ✦`, '#c9a4ff', () => {
            seed = v; pool = v; flips = 0; busted = false; refreshUI();
          }, !can));
        }
      } else if (busted) {
        controls.appendChild(mkBtn('Try Again', '#c9a4ff', () => {
          settleParlay(seed, 0);
          sigils = sigils - seed;
          seed = 0; pool = 0; flips = 0; busted = false; refreshUI();
        }));
      } else {
        controls.appendChild(mkBtn(`Flip · risk ${pool} ✦`, CASINO_RED, () => {
          const win = parlayFlip();
          flips += 1;
          if (win) { pool *= 2; }
          else { busted = true; }
          refreshUI();
        }));
        controls.appendChild(mkBtn(`Cash out · take ${pool} ✦`, '#9bff9b', () => {
          settleParlay(seed, pool);
          sigils = sigils - seed + pool;
          seed = 0; pool = 0; flips = 0; refreshUI();
        }));
      }
    };
    refreshUI();

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.textContent = '← Back to Casino';
    backBtn.style.cssText = `padding:10px 24px; cursor:pointer;
      background: linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86));
      border: 1px solid ${C.edge}; border-radius: 8px; color: ${C.magenta};
      font-family: ${F.display}; font-size: calc(var(--kk-font-scale,1) * 13px); letter-spacing: 0.28em;`;
    backBtn.onclick = () => {
      if (pool > 0 && !busted) settleParlay(seed, pool);
      _closeCasino(); showCasinoMenu();
    };
    _casinoModal.appendChild(backBtn);
  });
  _root.appendChild(_casinoModal);
  _casinoKey = (e) => { if (e.code === 'Escape') { _closeCasino(); showCasinoMenu(); } };
  window.addEventListener('keydown', _casinoKey);
}

/**
 * Slot machine modal — 3 reels rendered as large emoji glyphs, staggered stop
 * animation. Bet selector at the bottom. Math.random() RNG via casino.js;
 * this layer just orchestrates the visuals + delegates resolveSpin().
 */
export function showCasinoSlots() {
  try { hideTooltip(); } catch (_) {}
  if (_casinoModal) return;
  try { sfx.modalOpen(); } catch (_) {}
  _casinoModal = document.createElement('div');
  _casinoModal.style.cssText = _CASINO_BG;

  const title = document.createElement('div');
  title.style.cssText = `font-family:${F.display}; font-size:calc(var(--kk-font-scale,1) * 44px); font-weight:900;
    letter-spacing:0.22em; color:${C.amber};
    text-shadow: 0 2px 16px rgba(0,0,0,0.55), 0 0 24px rgba(255,210,127,0.22);
    margin-bottom: 4px; text-align:center;`;
  title.textContent = 'Slots';
  _casinoModal.appendChild(title);

  const sub = document.createElement('div');
  sub.style.cssText = `font-family:${F.body}; font-size:calc(var(--kk-font-scale,1) * 11px); letter-spacing:0.34em;
    color:rgba(245,239,225,0.6); text-transform:uppercase; margin-bottom: 22px; text-align:center;`;
  sub.innerHTML = '★ ★ ★ = 25× · 3-match = 8× · pair = 1.5× · pity rail under 100 🔥 pays 1.2×';
  _casinoModal.appendChild(sub);

  const emberWrap = document.createElement('div');
  emberWrap.innerHTML = _emberLine('Balance');
  _casinoModal.appendChild(emberWrap);

  // Reel cabinet
  const reelRow = document.createElement('div');
  reelRow.style.cssText = `display:flex; gap:14px; margin-bottom:18px;
    background: linear-gradient(180deg, rgba(20,16,12,0.96), rgba(8,6,4,0.98));
    border: 1px solid ${CASINO_RED};
    border-radius: 12px;
    box-shadow:
      0 1px 0 rgba(255,255,255,0.05) inset,
      0 0 0 1px rgba(0,0,0,0.4),
      0 24px 48px rgba(0,0,0,0.6),
      0 0 28px rgba(255,80,80,0.12);
    padding: 22px 26px;`;

  const reelEls = [];
  for (let i = 0; i < 3; i++) {
    const r = document.createElement('div');
    r.style.cssText = `width:118px; height:138px;
      background: linear-gradient(180deg, rgba(8,8,8,0.92), rgba(4,4,4,0.96));
      border: 1px solid ${C.edge};
      border-radius: 8px;
      display:flex; align-items:center; justify-content:center;
      font-size: calc(var(--kk-font-scale,1) * 64px); line-height: 1;
      box-shadow: inset 0 2px 10px rgba(0,0,0,0.7), inset 0 -1px 0 rgba(255,255,255,0.04);
      transition: border-color 0.18s ease, box-shadow 0.18s ease;`;
    r.textContent = '❓';
    reelEls.push(r);
    reelRow.appendChild(r);
  }
  _casinoModal.appendChild(reelRow);

  // Result line
  const resultEl = document.createElement('div');
  resultEl.style.cssText = `min-height:42px; font-family:${F.display}; font-size:calc(var(--kk-font-scale,1) * 22px); font-weight:700;
    letter-spacing:0.22em; color:${C.text};
    margin-bottom: 14px; text-align:center;`;
  resultEl.textContent = ' ';
  _casinoModal.appendChild(resultEl);

  // Bet selector row
  const betRow = document.createElement('div');
  betRow.style.cssText = 'display:flex; gap:12px; margin-bottom:18px; flex-wrap:wrap; justify-content:center;';
  let _selectedBet = 10;
  let _spinning = false;
  const betBtns = [];
  // Bet-row render lives at function scope so the spin-completion handler
  // can re-paint after the payout shifts the balance. CASINO is captured at
  // import time and threaded into renderBets via closure.
  let renderBets = () => {};
  // Async import + render — keeps the modal building UI immediately and lets
  // casino.js stay out of the top-level import graph for ui.js (lazy boot).
  import('./casino.js').then((CASINO) => {
    renderBets = () => {
      betRow.innerHTML = '';
      betBtns.length = 0;
      for (const bet of CASINO.SLOT_BETS) {
        const can = _embers() >= bet && !_spinning;
        const btn = document.createElement('button');
        btn.type = 'button';
        const active = _selectedBet === bet;
        btn.style.cssText = `padding:10px 22px; cursor:${can ? 'pointer' : 'not-allowed'};
          background: linear-gradient(180deg, ${active ? 'rgba(60,30,10,0.96)' : 'rgba(20,16,12,0.88)'}, rgba(8,6,4,0.95));
          border: 1px solid ${can ? (active ? C.amber : C.edge) : 'rgba(80,80,80,0.4)'};
          border-radius: 8px;
          color: ${can ? (active ? C.amber : C.text) : 'rgba(120,120,120,0.6)'};
          font-family:${F.display}; font-size:calc(var(--kk-font-scale,1) * 13px); font-weight:700;
          letter-spacing:0.22em;
          box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 18px rgba(0,0,0,0.5);
          opacity: ${can ? 1 : 0.55};`;
        btn.textContent = `${bet} 🔥`;
        if (can) {
          btn.addEventListener('click', () => {
            try { sfx.uiClick(); } catch (_) {}
            _selectedBet = bet;
            renderBets();
          });
        }
        betBtns.push(btn);
        betRow.appendChild(btn);
      }
      // Hint when balance is below the smallest bet — kept inside renderBets
      // so it survives every re-render call (single source of truth).
      if (_embers() < CASINO.SLOT_BETS[0]) {
        const hint = document.createElement('div');
        hint.style.cssText = `font-family:${F.body}; font-size:calc(var(--kk-font-scale,1) * 12px); letter-spacing:0.20em;
          text-align:center; color:${CASINO_RED}; margin-top:8px; text-transform:uppercase; width:100%;`;
        hint.textContent = 'Need more Embers — try a run!';
        betRow.appendChild(hint);
      }
    };
    renderBets();
    // Wire spin
    _wireSpin(CASINO);
  });
  _casinoModal.appendChild(betRow);

  // Spin button
  const spinBtn = document.createElement('button');
  spinBtn.type = 'button';
  spinBtn.textContent = 'SPIN · Space';
  spinBtn.style.cssText = `padding: 14px 36px; cursor:pointer;
    background: linear-gradient(180deg, rgba(60,16,16,0.96), rgba(28,8,8,0.98));
    border: 1px solid ${CASINO_RED}; border-radius: 10px;
    color: ${CASINO_RED}; font-family:${F.display}; font-size:calc(var(--kk-font-scale,1) * 18px); font-weight:900;
    letter-spacing:0.30em; margin-bottom: 18px;
    box-shadow: 0 1px 0 rgba(255,255,255,0.05) inset, 0 16px 32px rgba(0,0,0,0.6), 0 0 22px rgba(255,80,80,0.25);`;
  _casinoModal.appendChild(spinBtn);

  // Footer — back/leave row
  const footRow = document.createElement('div');
  footRow.style.cssText = 'display:flex; gap:12px;';
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.textContent = 'Back to Menu';
  backBtn.style.cssText = `padding: 9px 22px; cursor:pointer;
    background: linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86));
    border: 1px solid ${C.edge}; border-radius: 8px;
    color: ${C.magenta}; font-family:${F.display}; font-size: calc(var(--kk-font-scale,1) * 12px); font-weight:700;
    letter-spacing:0.26em;`;
  backBtn.onclick = () => { _closeCasino(); showCasinoMenu(); };
  footRow.appendChild(backBtn);
  const leaveBtn = document.createElement('button');
  leaveBtn.type = 'button';
  leaveBtn.textContent = 'Leave · Esc';
  leaveBtn.style.cssText = backBtn.style.cssText;
  leaveBtn.onclick = _closeCasino;
  footRow.appendChild(leaveBtn);
  _casinoModal.appendChild(footRow);
  _root.appendChild(_casinoModal);

  // ── Spin engine ──
  // SLOT_SYMBOLS imported lazily by the .then() block above; this closure is
  // initialized from inside the .then() handler (_wireSpin) so the array is
  // captured. Each spin: debit bet, animate scrolling glyphs, lock reels in
  // 0.6s staggers, then resolve via casino.resolveSpin and credit payout.
  let _rafId = 0;
  function _wireSpin(CASINO) {
    const doSpin = () => {
      if (_spinning) return;
      if (_embers() < _selectedBet) {
        try { sfx.uiError(); } catch (_) {}
        return;
      }
      // Debit bet up-front so the displayed balance reflects the stake during
      // the spin. resolveSpin() credits the payout after.
      const m = getMeta();
      m.embers -= _selectedBet;
      // No saveMeta here — resolveSpin saves once with payout baked in.
      _spinning = true;
      // Refresh the bet row to reflect new disabled state.
      // (cheap — same DOM, just a re-render.)
      const reels = CASINO.rollThreeReels();
      const stopAt = [700, 1300, 1900];   // ms — 0.6s offsets
      const t0 = performance.now();
      // Sound cue at spin start
      try { sfx.coinPickup(); } catch (_) {}
      for (const r of reelEls) {
        r.style.borderColor = C.edge;
        r.style.boxShadow = 'inset 0 2px 10px rgba(0,0,0,0.7), inset 0 -1px 0 rgba(255,255,255,0.04)';
      }
      resultEl.textContent = 'Spinning…';
      resultEl.style.color = C.text;
      const tick = () => {
        const t = performance.now() - t0;
        for (let i = 0; i < 3; i++) {
          if (t >= stopAt[i]) {
            reelEls[i].textContent = reels[i].icon;
            // Lock indicator
            if (reelEls[i].style.borderColor !== C.amber) {
              reelEls[i].style.borderColor = C.amber;
              reelEls[i].style.boxShadow = `0 0 18px ${C.amber}, inset 0 0 12px rgba(0,0,0,0.7)`;
            }
          } else {
            // Cycle symbol icons rapidly; slow down as we approach stop.
            const rem = stopAt[i] - t;
            const speed = Math.max(45, 360 - rem * 0.22);
            const idx = Math.floor(t / speed) % CASINO.SLOT_SYMBOLS.length;
            reelEls[i].textContent = CASINO.SLOT_SYMBOLS[idx].icon;
          }
        }
        if (t < stopAt[2] + 120) {
          _rafId = requestAnimationFrame(tick);
          return;
        }
        // Settle
        const out = CASINO.resolveSpin(_selectedBet, reels);
        _spinning = false;
        // Show result
        if (out.tier === 'jackpot') {
          resultEl.style.color = C.amber;
          resultEl.textContent = `${out.label}  ·  +${out.payout.toLocaleString()} 🔥`;
          try { sfx.levelUp(); } catch (_) {}
        } else if (out.tier === 'triple') {
          resultEl.style.color = C.amber;
          resultEl.textContent = `${out.label}  ·  +${out.payout.toLocaleString()} 🔥`;
          try { sfx.uiClick(); } catch (_) {}
        } else if (out.tier === 'double') {
          resultEl.style.color = C.cyan;
          resultEl.textContent = `${out.label}  ·  +${out.payout.toLocaleString()} 🔥`;
          try { sfx.uiClick(); } catch (_) {}
        } else if (out.pity) {
          resultEl.style.color = '#ffae6a';
          resultEl.textContent = `pity  ·  +${out.payout.toLocaleString()} 🔥`;
          try { sfx.uiClick(); } catch (_) {}
        } else {
          resultEl.style.color = CASINO_RED;
          resultEl.textContent = 'no match  ·  −' + _selectedBet.toLocaleString() + ' 🔥';
          try { sfx.uiCancel(); } catch (_) {}
        }
        // Repaint balance line + bet buttons (some bets may now be disabled).
        emberWrap.innerHTML = _emberLine('Balance');
        renderBets();
      };
      _rafId = requestAnimationFrame(tick);
    };
    spinBtn.addEventListener('click', doSpin);
    // Track for cleanup
    _casinoModal.__cancelRaf = () => { if (_rafId) cancelAnimationFrame(_rafId); _rafId = 0; };
  }

  _casinoKey = (e) => {
    if (e.code === 'Escape') {
      if (_casinoModal && _casinoModal.__cancelRaf) _casinoModal.__cancelRaf();
      _closeCasino();
    } else if (e.code === 'Space' || e.code === 'Enter') {
      e.preventDefault();
      spinBtn.click();
    }
  };
  window.addEventListener('keydown', _casinoKey);
}

/**
 * Boss Rush Wager modal — pick 1-3 mutator chips, slide the wager (100-1000),
 * commit. Confirming routes through casino.startBossRushWager() which debits
 * Embers, flips state.modes.bossRush, and stashes the localStorage record.
 * After commit we close + nudge the player to the gate; they walk over,
 * press E, the run starts in Boss Rush mode.
 */
export function showBossRushWager() {
  try { hideTooltip(); } catch (_) {}
  if (_casinoModal) return;
  try { sfx.modalOpen(); } catch (_) {}
  _casinoModal = document.createElement('div');
  _casinoModal.style.cssText = _CASINO_BG;

  const title = document.createElement('div');
  title.style.cssText = `font-family:${F.display}; font-size:calc(var(--kk-font-scale,1) * 38px); font-weight:900;
    letter-spacing:0.22em; color:${CASINO_RED};
    text-shadow: 0 2px 16px rgba(0,0,0,0.6), 0 0 28px rgba(255,80,80,0.25);
    margin-bottom: 4px; text-align:center;`;
  title.textContent = 'Boss Rush Wager';
  _casinoModal.appendChild(title);

  const sub = document.createElement('div');
  sub.style.cssText = `font-family:${F.body}; font-size:calc(var(--kk-font-scale,1) * 11px); letter-spacing:0.34em;
    color:rgba(245,239,225,0.6); text-transform:uppercase; margin-bottom: 22px; text-align:center;`;
  sub.innerHTML = 'Stake 100–1000 🔥 · 1 stack = ×2 · 2 stacks = ×4 · 3 stacks = ×8 · Forfeit on death';
  _casinoModal.appendChild(sub);

  const emberWrap = document.createElement('div');
  emberWrap.innerHTML = _emberLine('Balance');
  _casinoModal.appendChild(emberWrap);

  // Mutator chip row + commit are built after the dynamic import (we need the
  // BOSS_RUSH_MUTATORS array and the existing-wager guard).
  import('./casino.js').then((CASINO) => {
    // Active-wager guard
    if (CASINO.hasActiveWager()) {
      const warn = document.createElement('div');
      warn.style.cssText = `max-width: 560px; width:100%; padding:14px 22px;
        background: linear-gradient(180deg, rgba(40,16,16,0.94), rgba(20,8,8,0.96));
        border: 1px solid ${CASINO_RED}; border-radius: 10px;
        color:#ffae6a; font-family:${F.body}; font-size:calc(var(--kk-font-scale,1) * 13px);
        text-align:center; margin-bottom: 18px; letter-spacing:0.10em;`;
      warn.innerHTML = `You have an active wager — complete it first.<br>
        <span style="opacity:0.7;">Win or lose the next Boss Rush run to settle.</span>`;
      _casinoModal.insertBefore(warn, emberWrap.nextSibling);
    }

    const selected = new Set();
    const chipRow = document.createElement('div');
    chipRow.style.cssText = 'display:flex; gap:14px; margin-bottom:18px; flex-wrap:wrap; justify-content:center;';
    function renderChips() {
      chipRow.innerHTML = '';
      for (const mut of CASINO.BOSS_RUSH_MUTATORS) {
        const on = selected.has(mut.id);
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.style.cssText = `padding:12px 18px; cursor:pointer;
          background: linear-gradient(180deg, ${on ? 'rgba(60,16,16,0.96)' : 'rgba(20,16,12,0.88)'}, rgba(8,6,4,0.95));
          border: 1px solid ${on ? mut.accent : 'rgba(80,80,80,0.55)'};
          border-radius: 10px;
          color: ${on ? mut.accent : C.text};
          font-family:${F.body};
          letter-spacing:0.12em;
          min-width: 168px;
          box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 10px 22px rgba(0,0,0,0.55) ${on ? `, 0 0 18px ${mut.accent}44` : ''};
          transition: transform 0.12s ease, border-color 0.12s ease;`;
        chip.innerHTML = `
          <div style="font-family:${F.display};font-size:calc(var(--kk-font-scale,1) * 14px);font-weight:700;letter-spacing:0.22em;margin-bottom:4px;">${escapeHtml(mut.label)}</div>
          <div style="font-size:calc(var(--kk-font-scale,1) * 11.5px); opacity:${on ? 0.95 : 0.75};">${escapeHtml(mut.desc)}</div>
          <div style="margin-top:6px; font-size:calc(var(--kk-font-scale,1) * 10px); letter-spacing:0.28em; text-transform:uppercase; color:${on ? mut.accent : 'rgba(245,239,225,0.45)'};">${on ? '◆ ARMED' : 'Tap to arm'}</div>
        `;
        chip.addEventListener('click', () => {
          try { sfx.uiClick(); } catch (_) {}
          if (selected.has(mut.id)) selected.delete(mut.id); else selected.add(mut.id);
          renderChips();
          repaintPayout();
        });
        chipRow.appendChild(chip);
      }
    }
    renderChips();
    _casinoModal.appendChild(chipRow);

    // Wager slider
    const sliderWrap = document.createElement('div');
    sliderWrap.style.cssText = 'max-width: 560px; width:100%; margin-bottom: 18px;';
    const sliderLabel = document.createElement('div');
    sliderLabel.style.cssText = `font-family:${F.display}; font-size:calc(var(--kk-font-scale,1) * 14px); font-weight:700;
      letter-spacing:0.22em; color:${C.amber}; text-align:center; margin-bottom: 6px;`;
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '100';
    slider.max = '1000';
    slider.step = '50';
    slider.value = '200';
    slider.style.cssText = 'width: 100%; accent-color: #ffae6a;';
    const payoutLine = document.createElement('div');
    payoutLine.style.cssText = `font-family:${F.body}; font-size:calc(var(--kk-font-scale,1) * 12.5px); letter-spacing:0.16em;
      color:rgba(245,239,225,0.72); text-align:center; margin-top:8px;`;
    function repaintPayout() {
      const stacks = selected.size;
      const mul = CASINO.payoutMulForStacks(stacks);
      const amt = parseInt(slider.value, 10) || 0;
      const cap = _embers();
      // Clamp slider's max to current balance (don't let player offer-stake
      // more than they have).
      slider.max = String(Math.max(100, Math.min(1000, cap)));
      if (parseInt(slider.value, 10) > parseInt(slider.max, 10)) slider.value = slider.max;
      sliderLabel.textContent = `Stake  ${parseInt(slider.value, 10).toLocaleString()} 🔥`;
      if (stacks === 0) {
        payoutLine.innerHTML = `Pick at least one mutator to arm the wager.`;
        commitBtn.disabled = true;
        commitBtn.style.opacity = '0.55';
        commitBtn.style.cursor = 'not-allowed';
      } else {
        const payout = amt * mul;
        payoutLine.innerHTML = `<span style="color:${C.amber};">${stacks} stack${stacks > 1 ? 's' : ''}</span> · payout ×${mul} → <span style="color:${C.amber};">${payout.toLocaleString()} 🔥</span> on victory · forfeit ${amt.toLocaleString()} 🔥 on death`;
        commitBtn.disabled = cap < amt;
        commitBtn.style.opacity = cap < amt ? '0.55' : '1';
        commitBtn.style.cursor = cap < amt ? 'not-allowed' : 'pointer';
      }
    }
    slider.addEventListener('input', repaintPayout);

    sliderWrap.appendChild(sliderLabel);
    sliderWrap.appendChild(slider);
    sliderWrap.appendChild(payoutLine);
    _casinoModal.appendChild(sliderWrap);

    // GO button + footer
    const commitBtn = document.createElement('button');
    commitBtn.type = 'button';
    commitBtn.textContent = '⚔ COMMIT & GO';
    commitBtn.style.cssText = `padding: 14px 36px; cursor:pointer;
      background: linear-gradient(180deg, rgba(60,16,16,0.96), rgba(28,8,8,0.98));
      border: 1px solid ${CASINO_RED}; border-radius: 10px;
      color: ${CASINO_RED}; font-family:${F.display}; font-size:calc(var(--kk-font-scale,1) * 16px); font-weight:900;
      letter-spacing:0.28em; margin-bottom: 14px;
      box-shadow: 0 1px 0 rgba(255,255,255,0.05) inset, 0 14px 28px rgba(0,0,0,0.6), 0 0 22px rgba(255,80,80,0.25);`;
    commitBtn.addEventListener('click', () => {
      if (commitBtn.disabled) return;
      const amt = parseInt(slider.value, 10) || 0;
      const stacks = selected.size;
      const muts = CASINO.BOSS_RUSH_MUTATORS.filter(m => selected.has(m.id));
      const res = CASINO.startBossRushWager({ wagerAmount: amt, stacks, mutators: muts });
      if (!res.ok) {
        try { sfx.uiError(); } catch (_) {}
        // Reuse the micro toast for a clear error message.
        const reasonText = {
          unlocked: 'Casino not unlocked.',
          already_active: 'A wager is already pending — complete it first.',
          bad_amount: 'Wager must be 100–1000 🔥.',
          bad_stacks: 'Stack count mismatch.',
          insufficient: 'Not enough Embers.',
          no_mutators: 'Pick at least one mutator.',
        }[res.reason] || 'Wager rejected.';
        _kkShowMicroToast(reasonText, C.red);
        return;
      }
      try { sfx.bossWarn && sfx.bossWarn(); } catch (_) {}
      _closeCasino();
      showBanner('⚔ WAGER COMMITTED · WALK TO THE GATE', 3.6, CASINO_RED);
    });
    _casinoModal.appendChild(commitBtn);

    repaintPayout();
  });

  const footRow = document.createElement('div');
  footRow.style.cssText = 'display:flex; gap:12px;';
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.textContent = 'Back to Menu';
  backBtn.style.cssText = `padding: 9px 22px; cursor:pointer;
    background: linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86));
    border: 1px solid ${C.edge}; border-radius: 8px;
    color: ${C.magenta}; font-family:${F.display}; font-size: calc(var(--kk-font-scale,1) * 12px); font-weight:700;
    letter-spacing:0.26em;`;
  backBtn.onclick = () => { _closeCasino(); showCasinoMenu(); };
  footRow.appendChild(backBtn);
  const leaveBtn = document.createElement('button');
  leaveBtn.type = 'button';
  leaveBtn.textContent = 'Leave · Esc';
  leaveBtn.style.cssText = backBtn.style.cssText;
  leaveBtn.onclick = _closeCasino;
  footRow.appendChild(leaveBtn);
  _casinoModal.appendChild(footRow);
  _root.appendChild(_casinoModal);

  _casinoKey = (e) => { if (e.code === 'Escape') _closeCasino(); };
  window.addEventListener('keydown', _casinoKey);
}

// ── Grimoire modal (evolution discoveries) ───────────────────────────────────
let _grimModal = null;
export function showGrimoire() {
  // Iter 21a — defensive tooltip hide on modal entry.
  try { hideTooltip(); } catch (_) {}
  if (_grimModal) return;
  try { sfx.modalOpen(); } catch (_) {}
  _grimModal = document.createElement('div');
  _grimModal.style.cssText = `
    position: fixed; inset: 0;
    background:
      radial-gradient(ellipse at 50% 30%, rgba(255,122,216,0.07), transparent 60%),
      radial-gradient(ellipse at center, rgba(0,0,0,0.55), rgba(0,0,0,0.9) 80%);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    display: flex; flex-direction: column;
    align-items: center; justify-content: flex-start;
    padding: 48px 20px;
    pointer-events: auto;
    font-family: ${F.body};
    z-index: 120; overflow-y: auto;
  `;
  const title = document.createElement('div');
  title.style.cssText = `font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 44px); font-weight: 900;
    letter-spacing: 0.20em; color: ${C.magenta};
    text-shadow: 0 2px 16px rgba(0,0,0,0.55), 0 0 24px rgba(255,122,216,0.22);
    margin-bottom: 6px;`;
  title.textContent = 'Grimoire';

  const subtitle = document.createElement('div');
  subtitle.style.cssText = `font-family: ${F.body}; font-size: calc(var(--kk-font-scale, 1) * 11px); letter-spacing: 0.32em;
    color: rgba(245,239,225,0.62); text-transform: uppercase; margin-bottom: 26px;`;
  subtitle.textContent = 'Evolution recipes — discovered through play';

  const grid = document.createElement('div');
  grid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; max-width: 1100px; width: 100%;';

  // Passives section header + grid (populated below alongside evolutions).
  const passSubtitle = document.createElement('div');
  passSubtitle.style.cssText = `font-family: ${F.body}; font-size: calc(var(--kk-font-scale, 1) * 11px); letter-spacing: 0.32em;
    color: rgba(245,239,225,0.62); text-transform: uppercase; margin: 28px 0 14px;`;
  passSubtitle.textContent = 'Passives — mastery across runs';

  const passGrid = document.createElement('div');
  passGrid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; max-width: 1100px; width: 100%;';

  import('./weapons/index.js').then(({ REGISTRY, EVOLUTIONS, PASSIVES }) => {
    // Build the passive codex first so it appears right under the evolutions.
    const meta = getMeta();
    const seen = (meta && meta.passivesSeen) || {};
    for (const p of PASSIVES) {
      const owned = (state.passives || []).find(e => e.id === p.id);
      const liveLevel = owned ? owned.level : 0;
      const lifetimeLevel = Math.max(liveLevel, seen[p.id] || 0);
      const pipColor = lifetimeLevel > 0 ? C.magenta : 'rgba(120,120,120,0.4)';
      const card = document.createElement('div');
      card.style.cssText = `
        background: linear-gradient(180deg, rgba(20,22,28,0.94), rgba(8,10,14,0.96));
        border: 1px solid ${lifetimeLevel > 0 ? 'rgba(255,122,216,0.45)' : 'rgba(80,80,80,0.4)'};
        border-radius: 10px;
        box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 20px rgba(0,0,0,0.5);
        padding: 12px 14px;
        display: grid; grid-template-columns: 40px 1fr; gap: 12px; align-items: center;
      `;
      // Build pip strip: filled pips = lifetime max level reached.
      let pips = '';
      for (let i = 1; i <= p.maxLevel; i++) {
        const filled = i <= lifetimeLevel;
        pips += `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:3px;background:${filled ? pipColor : 'transparent'};border:1px solid ${filled ? pipColor : 'rgba(120,120,120,0.4)'};"></span>`;
      }
      const descText = p.desc(Math.max(1, lifetimeLevel || 1));
      card.innerHTML = `
        <div style="font-size:calc(var(--kk-font-scale, 1) * 30px);text-align:center;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.5));${lifetimeLevel > 0 ? '' : 'opacity:0.45;'}">${p.icon}</div>
        <div>
          <div style="font-family:${F.display};font-size:calc(var(--kk-font-scale, 1) * 13px);font-weight:700;letter-spacing:0.10em;color:${lifetimeLevel > 0 ? C.magenta : 'rgba(180,180,180,0.7)'};">${escapeHtml(p.name)}</div>
          <div style="font-size:calc(var(--kk-font-scale, 1) * 11px);color:rgba(245,239,225,0.72);line-height:1.45;margin:3px 0 6px;">${escapeHtml(descText)}</div>
          <div style="display:flex;align-items:center;gap:8px;">
            <div>${pips}</div>
            <div style="font-family:${F.mono};font-size:calc(var(--kk-font-scale, 1) * 10px);color:rgba(245,239,225,0.55);letter-spacing:0.08em;">Lv ${lifetimeLevel}/${p.maxLevel}</div>
          </div>
        </div>
      `;
      passGrid.appendChild(card);
    }

    for (const baseId of Object.keys(EVOLUTIONS)) {
      const evo = EVOLUTIONS[baseId];
      const base = REGISTRY[baseId] || {};
      const found = isDiscovered(evo.id);
      const card = document.createElement('div');
      card.style.cssText = `
        background: linear-gradient(180deg, rgba(20,28,22,0.94), rgba(8,14,12,0.96));
        border: 1px solid ${found ? C.amber : 'rgba(80,80,80,0.4)'};
        border-radius: 10px;
        box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 12px 26px rgba(0,0,0,0.55);
        padding: 16px 18px;
        display: grid; grid-template-columns: 56px 1fr; gap: 14px; align-items: center;
      `;
      if (found) {
        card.innerHTML = `
          <div style="font-size:calc(var(--kk-font-scale, 1) * 40px);text-align:center;filter:drop-shadow(0 3px 6px rgba(0,0,0,0.5));">${evo.icon}</div>
          <div>
            <div style="font-family:${F.display};font-size:calc(var(--kk-font-scale, 1) * 15px);font-weight:700;letter-spacing:0.10em;color:${C.amber};">${escapeHtml(evo.name)}</div>
            <div style="font-size:calc(var(--kk-font-scale, 1) * 11.5px);color:rgba(245,239,225,0.78);line-height:1.5;margin:4px 0 8px;">${escapeHtml(evo.desc)}</div>
            <div style="font-family:${F.body};font-size:calc(var(--kk-font-scale, 1) * 11px);color:rgba(245,239,225,0.62);letter-spacing:0.08em;">
              <span style="color:${C.amber};">Recipe</span> · ${base.icon || '★'} ${escapeHtml(base.name || baseId)} (max) + ${evo.requires.count}× ${escapeHtml(evo.requires.filler)}
            </div>
          </div>
        `;
      } else {
        card.innerHTML = `
          <div style="font-size:calc(var(--kk-font-scale, 1) * 40px);text-align:center;color:rgba(120,120,120,0.55);">?</div>
          <div>
            <div style="font-family:${F.display};font-size:calc(var(--kk-font-scale, 1) * 15px);font-weight:700;letter-spacing:0.10em;color:rgba(120,120,120,0.7);">Undiscovered</div>
            <div style="font-size:calc(var(--kk-font-scale, 1) * 11.5px);color:rgba(120,120,120,0.55);line-height:1.5;margin-top:4px;">Max a base weapon and stack the right passive to reveal this evolution.</div>
          </div>
        `;
      }
      grid.appendChild(card);
    }
  });

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close · Esc';
  close.style.cssText = `margin-top: 28px; padding: 10px 26px; cursor: pointer;
    background: linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86));
    border: 1px solid ${C.edge}; border-radius: 8px;
    color: ${C.magenta}; font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 13px); font-weight: 700;
    letter-spacing: 0.28em;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 20px rgba(0,0,0,0.5);`;
  close.onclick = hideGrimoire;

  _grimModal.appendChild(title);
  _grimModal.appendChild(subtitle);
  _grimModal.appendChild(grid);
  _grimModal.appendChild(passSubtitle);
  _grimModal.appendChild(passGrid);
  _grimModal.appendChild(close);
  _root.appendChild(_grimModal);
}
export function hideGrimoire() {
  if (!_grimModal) return;
  try { sfx.modalClose(); } catch (_) {}
  if (_grimModal.parentNode) _grimModal.parentNode.removeChild(_grimModal);
  _grimModal = null;
}
export function isGrimoireOpen() { return !!_grimModal; }

// ── Shop modal ───────────────────────────────────────────────────────────────
let _shopModal = null;
let _shopFocusScope = null;
export function showShop() {
  // Iter 21a — defensive tooltip hide on modal entry.
  try { hideTooltip(); } catch (_) {}
  if (_shopModal) return;
  try { sfx.modalOpen(); } catch (_) {}
  _shopModal = document.createElement('div');
  _shopModal.style.cssText = `
    position: fixed; inset: 0;
    background:
      radial-gradient(ellipse at 50% 30%, rgba(255,210,127,0.06), transparent 60%),
      radial-gradient(ellipse at center, rgba(0,0,0,0.55), rgba(0,0,0,0.9) 80%);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    display: flex; flex-direction: column;
    align-items: center; justify-content: flex-start;
    pointer-events: auto;
    font-family: ${F.body};
    z-index: 120;
    overflow-y: auto;
    padding: 48px 20px;
  `;
  const title = document.createElement('div');
  title.style.cssText = `font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 44px); font-weight: 900;
    letter-spacing: 0.20em; color: ${C.amber};
    text-shadow: 0 2px 16px rgba(0,0,0,0.55), 0 0 24px rgba(255,210,127,0.18);
    margin-bottom: 6px;`;
  title.textContent = 'Shop';

  const subtitle = document.createElement('div');
  subtitle.style.cssText = `font-family: ${F.body}; font-size: calc(var(--kk-font-scale, 1) * 11px); letter-spacing: 0.32em;
    color: rgba(245,239,225,0.62); text-transform: uppercase; margin-bottom: 22px;`;
  subtitle.textContent = 'Spend sigils on a permanent meta tree — carry between runs';

  // Treasury (coins) + Sigil counter side-by-side in the header. Sigils are the
  // tree-shop currency; coins remain visible for context (legacy shops, codex).
  const SIGIL_C = '#c87bff';
  const coinsLine = document.createElement('div');
  coinsLine.style.cssText = `font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 22px); color: ${C.amber};
    margin-bottom: 28px; letter-spacing: 0.18em;
    display: flex; align-items: baseline; gap: 28px; flex-wrap: wrap; justify-content: center;`;
  function paintCoins() {
    const m = getMeta();
    coinsLine.innerHTML = `
      <span style="display:inline-flex; align-items:baseline; gap:10px;">
        <span style="font-family:${F.body};font-size:calc(var(--kk-font-scale, 1) * 13px);letter-spacing:0.32em;color:rgba(245,239,225,0.62);text-transform:uppercase;">Treasury</span>
        <span style="font-family:${F.mono};color:${C.amber};">${m.coins.toLocaleString()}</span>
      </span>
      <span style="display:inline-flex; align-items:baseline; gap:10px;">
        <span style="font-family:${F.body};font-size:calc(var(--kk-font-scale, 1) * 13px);letter-spacing:0.32em;color:rgba(245,239,225,0.62);text-transform:uppercase;">Sigils</span>
        <span style="font-family:${F.mono};color:${SIGIL_C};">✦ ${sigilCount().toLocaleString()}</span>
      </span>
    `;
  }
  paintCoins();

  // Three-column branching tree. One column per branch, four tiers stacked.
  // Tier-to-tier connectors (▼) live between cards inside each column.
  const grid = document.createElement('div');
  grid.style.cssText = `
    display: grid; grid-template-columns: repeat(3, minmax(240px, 1fr));
    gap: 28px;
    max-width: 1100px; width: 100%;
    align-items: start;
  `;

  // Branch metadata — header chrome only; node data comes from SHOP_TREE.
  const BRANCH_META = {
    survival: { name: 'Survival', icon: '🛡', tagline: 'Endure',  accent: C.cyan },
    power:    { name: 'Power',    icon: '⚔', tagline: 'Strike',  accent: C.amber },
    greed:    { name: 'Greed',    icon: '💰', tagline: 'Loot',    accent: SIGIL_C },
  };

  function paintNode(node) {
    const unlocked = nodeUnlocked(node.id);
    const owned = nodeOwned(node.id);
    const sigils = sigilCount();
    const affordable = sigils >= node.cost;
    const lockedVisually = !unlocked && !owned;

    // Three visual states drive the look: owned (amber, ✓), unlocked-purchasable
    // (cyan, hover lift), unlocked-but-unaffordable (dim cyan), locked (gray).
    const state =
      owned ? 'owned' :
      !unlocked ? 'locked' :
      affordable ? 'buy' :
      'poor';

    const borderC =
      state === 'owned' ? C.amber :
      state === 'buy'   ? C.cyan :
      state === 'poor'  ? 'rgba(127,255,228,0.32)' :
                          'rgba(80,80,80,0.4)';
    const txtC =
      state === 'owned' ? C.text :
      state === 'locked' ? 'rgba(120,120,120,0.65)' :
                           C.text;
    const costC =
      state === 'owned' ? C.amber :
      state === 'buy'   ? C.cyan :
      state === 'poor'  ? 'rgba(127,255,228,0.5)' :
                          'rgba(120,120,120,0.55)';
    const iconOverlay =
      state === 'owned'  ? '<div style="position:absolute;top:8px;right:10px;font-size:calc(var(--kk-font-scale, 1) * 18px);color:'+C.amber+';text-shadow:0 1px 4px rgba(0,0,0,0.6);">✓</div>' :
      state === 'locked' ? '<div style="position:absolute;top:8px;right:10px;font-size:calc(var(--kk-font-scale, 1) * 16px);opacity:0.75;">🔒</div>' :
      '';

    const card = document.createElement('div');
    card.style.cssText = `
      position: relative;
      background: linear-gradient(180deg, rgba(20,28,22,0.94), rgba(8,14,12,0.96));
      border: 1px solid ${borderC};
      border-radius: 10px;
      box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 12px 26px rgba(0,0,0,0.55)
        ${state === 'owned' ? ', 0 0 18px rgba(255,210,127,0.18)' : ''};
      padding: 14px 16px;
      display: grid; grid-template-columns: 52px 1fr; gap: 12px; align-items: center;
      transition: transform 0.14s ease, border-color 0.14s ease, box-shadow 0.14s ease;
      opacity: ${state === 'locked' ? 0.6 : 1};
    `;

    // Tier pip row — one bright pip per tier earned on this node. Only owned
    // nodes light their pips; locked/buy/poor nodes show empty placeholders.
    const pips = Array.from({ length: 4 }, (_, i) => {
      const lit = (i + 1 <= node.tier) && state === 'owned';
      const accent = state === 'owned' ? C.amber : (state === 'buy' ? C.cyan : 'rgba(255,255,255,0.10)');
      return `<span style="display:inline-block;width:12px;height:4px;border-radius:2px;background:${lit ? accent : 'rgba(255,255,255,0.10)'};"></span>`;
    }).join('');

    const tierLabel = `T${node.tier}`;
    const costLine =
      state === 'owned'  ? 'OWNED' :
      state === 'locked' ? 'LOCKED' :
      `✦ ${node.cost}${state === 'poor' ? ` — need ${node.cost - sigils}` : ''}`;

    card.innerHTML = `
      ${iconOverlay}
      <div style="font-size:calc(var(--kk-font-scale, 1) * 34px);text-align:center;filter:drop-shadow(0 3px 6px rgba(0,0,0,0.5));opacity:${state === 'locked' ? 0.55 : 1};">${node.icon}</div>
      <div>
        <div style="display:flex; align-items:baseline; gap:8px;">
          <div style="font-family:${F.display};font-size:calc(var(--kk-font-scale, 1) * 14px);font-weight:700;letter-spacing:0.10em;color:${txtC};">${escapeHtml(node.name)}</div>
          <div style="font-family:${F.mono};font-size:calc(var(--kk-font-scale, 1) * 10px);letter-spacing:0.18em;color:rgba(245,239,225,0.45);">${tierLabel}</div>
        </div>
        <div style="font-size:calc(var(--kk-font-scale, 1) * 11px);color:${state === 'locked' ? 'rgba(120,120,120,0.55)' : 'rgba(245,239,225,0.72)'};line-height:1.45;margin-top:3px;">${escapeHtml(node.desc)}</div>
        <div style="display:flex;gap:3px;margin-top:7px;">${pips}</div>
        <div style="font-family:${F.mono};font-size:calc(var(--kk-font-scale, 1) * 11px);color:${costC};margin-top:6px;letter-spacing:0.10em;">
          ${costLine}
        </div>
      </div>
    `;

    if (state === 'buy') {
      card.style.cursor = 'pointer';
      card.addEventListener('mouseenter', () => {
        card.style.transform = 'translateY(-2px)';
        card.style.borderColor = C.amber;
      });
      card.addEventListener('mouseleave', () => {
        card.style.transform = 'translateY(0)';
        card.style.borderColor = borderC;
      });
      card.onclick = () => {
        const r = purchaseTreeNode(node.id);
        if (r && r.ok) {
          paintCoins();
          repaintGrid();
        }
      };
    } else if (state === 'poor') {
      card.style.cursor = 'not-allowed';
    } else {
      card.style.cursor = 'default';
    }

    // Tooltip surfaces unlock requirements when locked, otherwise standard stats.
    bindTooltip(card, () => {
      const branchMeta = BRANCH_META[node.branch];
      const stats = [
        { label: 'Branch', value: branchMeta.name },
        { label: 'Tier',   value: `${node.tier}/4` },
        { label: 'Cost',   value: state === 'owned' ? 'OWNED' : `${node.cost} sigils` },
      ];
      if (state === 'poor') stats.push({ label: 'Need', value: `${node.cost - sigils} more sigils` });
      let bodyExtra = '';
      if (state === 'locked') {
        const reqNames = node.requires.map(rid => {
          const r = SHOP_TREE.find(n => n.id === rid);
          return r ? r.name : rid;
        }).join(', ');
        bodyExtra = `\n\nLocked. Requires: ${reqNames || 'none'}.`;
      } else if (state === 'owned') {
        bodyExtra = '\n\nPurchased — applies to every future run.';
      } else if (state === 'buy') {
        bodyExtra = '\n\nPermanent: applies to every future run.';
      } else if (state === 'poor') {
        bodyExtra = '\n\nEarn sigils from daily runs, quests, and mini-bosses.';
      }
      return {
        title: node.name,
        icon: node.icon,
        body: node.desc + bodyExtra,
        tags: [branchMeta.name, `Tier ${node.tier}`],
        stats,
        accent:
          state === 'owned'  ? '#ffd27f' :
          state === 'locked' ? '#888' :
                               '#7fffe4',
      };
    });
    return card;
  }

  // Build a branch column: header + 4 stacked nodes + ▼ connectors.
  function paintColumn(branchId) {
    const meta = BRANCH_META[branchId];
    const col = document.createElement('div');
    col.style.cssText = 'display:flex; flex-direction:column; gap:10px;';

    const header = document.createElement('div');
    header.style.cssText = `
      text-align: center;
      padding: 10px 12px 14px;
      border-bottom: 1px solid ${C.edge};
      margin-bottom: 4px;
    `;
    header.innerHTML = `
      <div style="font-size:calc(var(--kk-font-scale, 1) * 28px);filter:drop-shadow(0 3px 6px rgba(0,0,0,0.55));">${meta.icon}</div>
      <div style="font-family:${F.display}; font-size:calc(var(--kk-font-scale, 1) * 18px); font-weight:700; letter-spacing:0.20em; color:${meta.accent}; margin-top:2px;">${escapeHtml(meta.name)}</div>
      <div style="font-family:${F.body}; font-size:calc(var(--kk-font-scale, 1) * 10.5px); letter-spacing:0.32em; text-transform:uppercase; color:rgba(245,239,225,0.55); margin-top:3px;">${escapeHtml(meta.tagline)}</div>
    `;
    col.appendChild(header);

    const branchNodes = SHOP_TREE
      .filter(n => n.branch === branchId)
      .sort((a, b) => a.tier - b.tier);
    branchNodes.forEach((node, i) => {
      col.appendChild(paintNode(node));
      if (i < branchNodes.length - 1) {
        const conn = document.createElement('div');
        const lit = nodeOwned(node.id);
        conn.style.cssText = `text-align:center; font-family:${F.mono}; font-size:calc(var(--kk-font-scale, 1) * 16px); line-height:1;
          color:${lit ? meta.accent : 'rgba(245,239,225,0.22)'};
          text-shadow:${lit ? `0 0 8px ${meta.accent}55` : 'none'};
          margin: -2px 0;`;
        conn.textContent = '▼';
        col.appendChild(conn);
      }
    });
    return col;
  }

  let _closeBtnRef = null;
  function refreshShopFocus(initialIndex = 0) {
    if (_shopFocusScope) { popFocusScope(_shopFocusScope); _shopFocusScope = null; }
    // Collect every node card across the 3 columns in column-major order so
    // gamepad up/down navigates within a branch column naturally.
    const cards = [];
    for (const col of grid.children) {
      for (const child of col.children) {
        // Skip the column header (first child) and connectors (▼ divs).
        // Node cards are the only elements with cursor styling or pointer.
        if (child.tagName === 'DIV' && child.children.length > 0 && child.style.gridTemplateColumns) {
          cards.push(child);
        }
      }
    }
    const els = [...cards];
    if (_closeBtnRef) els.push(_closeBtnRef);
    _shopFocusScope = pushFocusScope(els, { layout: 'auto', onCancel: hideShop, initialIndex });
  }
  function repaintGrid() {
    const prevFocusIdx = _shopFocusScope ? _shopFocusScope.focused : 0;
    grid.innerHTML = '';
    grid.appendChild(paintColumn('survival'));
    grid.appendChild(paintColumn('power'));
    grid.appendChild(paintColumn('greed'));
    if (_closeBtnRef) refreshShopFocus(prevFocusIdx);
  }
  repaintGrid();

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close · Esc';
  close.style.cssText = `margin-top: 28px; padding: 10px 26px; cursor: pointer;
    background: linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86));
    border: 1px solid ${C.edge}; border-radius: 8px;
    color: ${C.magenta}; font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 13px); font-weight: 700;
    letter-spacing: 0.28em;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 20px rgba(0,0,0,0.5);`;
  close.onclick = hideShop;
  _closeBtnRef = close;

  _shopModal.appendChild(title);
  _shopModal.appendChild(subtitle);
  _shopModal.appendChild(coinsLine);
  _shopModal.appendChild(grid);
  _shopModal.appendChild(close);
  _root.appendChild(_shopModal);
  refreshShopFocus(0);
}
export function hideShop() {
  if (!_shopModal) return;
  try { sfx.modalClose(); } catch (_) {}
  if (_shopFocusScope) { popFocusScope(_shopFocusScope); _shopFocusScope = null; }
  if (_shopModal.parentNode) _shopModal.parentNode.removeChild(_shopModal);
  _shopModal = null;
  hideTooltip();
}

// ── House upgrade kiosk (Embers currency) ──
let _houseModal = null;
export function isHouseOpen() { return !!_houseModal; }
export function showHouse() {
  // Iter 21a — defensive tooltip hide on modal entry.
  try { hideTooltip(); } catch (_) {}
  if (_houseModal) return;
  try { sfx.modalOpen(); } catch (_) {}
  _houseModal = document.createElement('div');
  _houseModal.style.cssText = `
    position: fixed; inset: 0;
    background:
      radial-gradient(ellipse at 50% 30%, rgba(255,180,80,0.05), transparent 60%),
      radial-gradient(ellipse at center, rgba(0,0,0,0.55), rgba(0,0,0,0.9) 80%);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    display: flex; flex-direction: column;
    align-items: center; justify-content: flex-start;
    pointer-events: auto;
    font-family: ${F.body};
    z-index: 120;
    overflow-y: auto;
    padding: 48px 20px;
  `;
  const title = document.createElement('div');
  title.style.cssText = `font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 44px); font-weight: 900;
    letter-spacing: 0.20em; color: #ffae6a;
    text-shadow: 0 2px 16px rgba(0,0,0,0.55), 0 0 24px rgba(255,160,90,0.20);
    margin-bottom: 6px;`;
  title.textContent = 'The House';

  const subtitle = document.createElement('div');
  subtitle.style.cssText = `font-family: ${F.body}; font-size: calc(var(--kk-font-scale, 1) * 11px); letter-spacing: 0.32em;
    color: rgba(245,239,225,0.62); text-transform: uppercase; margin-bottom: 22px;`;
  subtitle.textContent = 'Long-term renovations — fueled by Embers from past hunts';

  const emberLine = document.createElement('div');
  emberLine.style.cssText = `font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 22px); color: #ffae6a;
    margin-bottom: 28px; letter-spacing: 0.18em;
    display: flex; align-items: baseline; gap: 12px;`;
  function paintEmbers() {
    emberLine.innerHTML = `<span style="font-size:calc(var(--kk-font-scale, 1) * 13px);letter-spacing:0.32em;color:rgba(245,239,225,0.62);text-transform:uppercase;">Embers</span> <span style="font-family:${F.mono};">${(getMeta().embers || 0).toLocaleString()}</span> 🔥`;
  }
  paintEmbers();

  const grid = document.createElement('div');
  grid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; max-width: 1100px; width: 100%;';

  function paintCard(upg) {
    const lvl = houseLevel(upg.id);
    const maxed = lvl >= upg.max;
    const cost = maxed ? 0 : houseCost(upg, lvl);
    const can = !maxed && (getMeta().embers || 0) >= cost;
    const accent = maxed ? '#ffae6a' : (can ? C.cyan : 'rgba(120,120,120,0.5)');
    const card = document.createElement('div');
    card.style.cssText = `
      background: linear-gradient(180deg, rgba(28,20,16,0.94), rgba(14,10,8,0.96));
      border: 1px solid ${maxed ? '#ffae6a' : (can ? C.edge : 'rgba(80,80,80,0.4)')};
      border-radius: 10px;
      box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 12px 26px rgba(0,0,0,0.55);
      padding: 16px 18px;
      display: grid; grid-template-columns: 56px 1fr; gap: 14px; align-items: center;
      transition: transform 0.14s ease, border-color 0.14s ease;
    `;
    const pips = Array.from({ length: upg.max }, (_, i) =>
      `<span style="display:inline-block;width:14px;height:5px;border-radius:2px;background:${i < lvl ? '#ffae6a' : 'rgba(255,255,255,0.10)'};"></span>`
    ).join('');
    card.innerHTML = `
      <div style="font-size:calc(var(--kk-font-scale, 1) * 38px);text-align:center;filter:drop-shadow(0 3px 6px rgba(0,0,0,0.5));">${upg.icon}</div>
      <div>
        <div style="font-family:${F.display};font-size:calc(var(--kk-font-scale, 1) * 15px);font-weight:700;letter-spacing:0.10em;color:${C.text};">${escapeHtml(upg.name)}</div>
        <div style="font-size:calc(var(--kk-font-scale, 1) * 11.5px);color:rgba(245,239,225,0.72);line-height:1.45;margin-top:3px;">${escapeHtml(upg.desc)}</div>
        <div style="display:flex;gap:3px;margin-top:8px;">${pips}</div>
        <div style="font-family:${F.mono};font-size:calc(var(--kk-font-scale, 1) * 11px);color:${accent};margin-top:6px;letter-spacing:0.08em;">
          ${maxed ? 'FULLY UPGRADED' : `${cost.toLocaleString()} 🔥`}
        </div>
      </div>
    `;
    if (!maxed) {
      card.style.cursor = can ? 'pointer' : 'not-allowed';
      card.addEventListener('mouseenter', () => {
        if (can) { card.style.transform = 'translateY(-2px)'; card.style.borderColor = '#ffae6a'; }
      });
      card.addEventListener('mouseleave', () => {
        card.style.transform = 'translateY(0)';
        card.style.borderColor = can ? C.edge : 'rgba(80,80,80,0.4)';
      });
      card.onclick = () => {
        if (buyHouseUpgrade(upg.id)) {
          paintEmbers();
          repaintGrid();
        }
      };
    }
    return card;
  }
  function repaintGrid() {
    grid.innerHTML = '';
    for (const upg of HOUSE_UPGRADES) grid.appendChild(paintCard(upg));
  }
  repaintGrid();

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close · Esc';
  close.style.cssText = `margin-top: 28px; padding: 10px 26px; cursor: pointer;
    background: linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86));
    border: 1px solid ${C.edge}; border-radius: 8px;
    color: ${C.magenta}; font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 13px); font-weight: 700;
    letter-spacing: 0.28em;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 20px rgba(0,0,0,0.5);`;
  close.onclick = hideHouse;

  _houseModal.appendChild(title);
  _houseModal.appendChild(subtitle);
  _houseModal.appendChild(emberLine);
  _houseModal.appendChild(grid);
  _houseModal.appendChild(close);
  _root.appendChild(_houseModal);
}
export function hideHouse() {
  if (!_houseModal) return;
  try { sfx.modalClose(); } catch (_) {}
  if (_houseModal.parentNode) _houseModal.parentNode.removeChild(_houseModal);
  _houseModal = null;
}

// ── Quest Board modal (90s CRT in the house interior) ──
let _questModal = null;
export function isQuestBoardOpen() { return !!_questModal; }
export function showQuestBoard() {
  // Iter 21a — defensive tooltip hide on modal entry.
  try { hideTooltip(); } catch (_) {}
  if (_questModal) return;
  try { sfx.modalOpen(); } catch (_) {}
  const meta = getMeta();
  const lain = !!(meta.quests && meta.quests.lainTerminal);
  _questModal = document.createElement('div');
  _questModal.style.cssText = `
    position: fixed; inset: 0;
    background:
      radial-gradient(ellipse at 50% 25%, ${lain ? 'rgba(80,200,255,0.06)' : 'rgba(42,255,102,0.05)'}, transparent 60%),
      radial-gradient(ellipse at center, rgba(0,0,0,0.62), rgba(0,0,0,0.92) 80%);
    backdrop-filter: blur(10px);
    display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
    pointer-events: auto;
    font-family: ${F.body};
    z-index: 120;
    overflow-y: auto;
    padding: 48px 20px;
  `;

  const title = document.createElement('div');
  title.style.cssText = `font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 38px); font-weight: 900;
    letter-spacing: 0.22em; color: ${lain ? '#4fd0ff' : '#2aff66'};
    text-shadow: 0 2px 16px rgba(0,0,0,0.55), 0 0 24px ${lain ? 'rgba(80,200,255,0.20)' : 'rgba(42,255,102,0.20)'};
    margin-bottom: 6px;`;
  title.textContent = lain ? 'NAVI · Quest Terminal' : 'KAKI-DOS · Bounty Board';

  const subtitle = document.createElement('div');
  subtitle.style.cssText = `font-family: ${F.mono}; font-size: calc(var(--kk-font-scale, 1) * 11px); letter-spacing: 0.32em;
    color: rgba(245,239,225,0.6); text-transform: uppercase; margin-bottom: 22px;`;
  subtitle.textContent = `Active ${activeQuests().length} / ${maxActiveQuests()}    Completed lifetime: ${(meta.quests && meta.quests.completedCount) || 0}`;

  const grid = document.createElement('div');
  grid.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 28px; max-width: 1100px; width: 100%;';

  const activeCol = document.createElement('div');
  const offerCol = document.createElement('div');
  grid.appendChild(activeCol); grid.appendChild(offerCol);

  function questCard(tpl, q) {
    const isActive = !!q;
    const complete = isActive && q.progress >= tpl.goal;
    const card = document.createElement('div');
    const accent = complete ? '#ffae6a' : (isActive ? (lain ? '#4fd0ff' : '#2aff66') : C.amber);
    card.style.cssText = `
      background: linear-gradient(180deg, rgba(20,28,22,0.94), rgba(8,14,12,0.96));
      border: 1px solid ${accent};
      border-radius: 10px;
      box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 12px 26px rgba(0,0,0,0.55);
      padding: 14px 16px;
      margin-bottom: 12px;
      display: grid; grid-template-columns: 44px 1fr; gap: 12px; align-items: start;
    `;
    let progressBar = '';
    if (isActive) {
      const pct = Math.min(100, Math.floor((q.progress / tpl.goal) * 100));
      progressBar = `
        <div style="height:6px; background:rgba(255,255,255,0.08); border-radius:3px; margin-top:6px; overflow:hidden;">
          <div style="height:100%; width:${pct}%; background:${accent};"></div>
        </div>
        <div style="font-family:${F.mono}; font-size:calc(var(--kk-font-scale, 1) * 10px); color:${accent}; margin-top:4px; letter-spacing:0.08em;">
          ${q.progress} / ${tpl.goal}${complete ? '   ·   READY TO CLAIM' : ''}
        </div>
      `;
    }
    card.innerHTML = `
      <div style="font-size:calc(var(--kk-font-scale, 1) * 28px); line-height:1; filter:drop-shadow(0 2px 4px rgba(0,0,0,0.5));">${tpl.icon}</div>
      <div>
        <div style="font-family:${F.display}; font-size:calc(var(--kk-font-scale, 1) * 13px); font-weight:700; letter-spacing:0.10em; color:${C.text};">${escapeHtml(tpl.name)}</div>
        <div style="font-size:calc(var(--kk-font-scale, 1) * 11.5px); color:rgba(245,239,225,0.72); line-height:1.45; margin-top:3px;">${escapeHtml(tpl.desc)}</div>
        <div style="font-family:${F.mono}; font-size:calc(var(--kk-font-scale, 1) * 11px); color:${C.amber}; margin-top:6px; letter-spacing:0.06em;">
          Reward: ${tpl.coins} coins  ·  ${tpl.embers} 🔥
        </div>
        ${progressBar}
      </div>
    `;
    // Buttons
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex; gap:8px; margin-top:10px; grid-column:1/-1;';
    const mkBtn = (label, color, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.style.cssText = `padding:7px 14px; cursor:pointer;
        background:rgba(20,28,22,0.78); border:1px solid ${color}; border-radius:6px;
        color:${color}; font-family:${F.display}; font-size:calc(var(--kk-font-scale, 1) * 11px); letter-spacing:0.22em;`;
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      return b;
    };
    if (isActive && complete) {
      btns.appendChild(mkBtn('Claim', '#ffae6a', () => {
        const result = claimQuest(tpl.id);
        if (result) { grantSigils(2, 'quest'); repaint(); }
      }));
    }
    if (isActive && !complete) {
      btns.appendChild(mkBtn('Abandon', '#c87b7b', () => {
        if (abandonQuest(tpl.id)) repaint();
      }));
    }
    if (!isActive) {
      const canAccept = activeQuests().length < maxActiveQuests();
      btns.appendChild(mkBtn(canAccept ? 'Accept' : 'Slot Full', canAccept ? (lain ? '#4fd0ff' : '#2aff66') : 'rgba(120,120,120,0.6)', () => {
        if (!canAccept) return;
        if (acceptQuest(tpl.id)) repaint();
      }));
    }
    card.appendChild(btns);
    return card;
  }

  function repaint() {
    activeCol.innerHTML = `<div style="font-family:${F.display};font-size:calc(var(--kk-font-scale, 1) * 12px);letter-spacing:0.30em;color:${lain ? '#4fd0ff' : '#2aff66'};margin-bottom:10px;text-transform:uppercase;">Active</div>`;
    const active = activeQuests();
    if (active.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = `padding:18px; border:1px dashed ${C.edge}; border-radius:8px; color:rgba(245,239,225,0.5); font-size:calc(var(--kk-font-scale, 1) * 13px); text-align:center;`;
      empty.textContent = 'No active bounties. Accept one from the offer pool →';
      activeCol.appendChild(empty);
    } else {
      for (const q of active) {
        const tpl = QUEST_TEMPLATES.find(t => t.id === q.id);
        if (tpl) activeCol.appendChild(questCard(tpl, q));
      }
    }
    offerCol.innerHTML = `<div style="font-family:${F.display};font-size:calc(var(--kk-font-scale, 1) * 12px);letter-spacing:0.30em;color:${C.amber};margin-bottom:10px;text-transform:uppercase;">Offer Pool</div>`;
    const offers = availableQuests();
    for (const tpl of offers) offerCol.appendChild(questCard(tpl, null));
    // Update header counter
    subtitle.textContent = `Active ${activeQuests().length} / ${maxActiveQuests()}    Completed lifetime: ${(getMeta().quests && getMeta().quests.completedCount) || 0}`;
  }
  repaint();

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close · Esc';
  close.style.cssText = `margin-top: 28px; padding: 10px 26px; cursor: pointer;
    background: linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86));
    border: 1px solid ${C.edge}; border-radius: 8px;
    color: ${C.magenta}; font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 13px); font-weight: 700;
    letter-spacing: 0.28em;`;
  close.onclick = hideQuestBoard;

  _questModal.appendChild(title);
  _questModal.appendChild(subtitle);
  _questModal.appendChild(grid);
  _questModal.appendChild(close);
  _root.appendChild(_questModal);
}
export function hideQuestBoard() {
  if (!_questModal) return;
  try { sfx.modalClose(); } catch (_) {}
  if (_questModal.parentNode) _questModal.parentNode.removeChild(_questModal);
  _questModal = null;
}
export function isShopOpen() { return !!_shopModal; }

// ── Options panel (iter 10a — sectioned + accessibility-complete) ────────────
// Sections: Audio · Display · Controls · Accessibility · Modes · Data.
// Every control writes via setOption AND applies live so the change is
// visible immediately (font scale, colorblind palette, etc.).
let _optionsPanel = null;

// Font-scale bucket classes — applied to wrapper containers (NOT per-element
// rewrites). Multiplied via calc(var(--kk-font-scale) * Npx) so the player's
// slider mutates --kk-font-scale at :root (see main.js boot + index.html).
function _ensureFontScaleStyle() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('kk-font-scale-css')) return;
  const s = document.createElement('style');
  s.id = 'kk-font-scale-css';
  s.textContent = `
    .kk-fs-mono { font-size: calc(var(--kk-font-scale, 1) * 11px); }
    .kk-fs-sm   { font-size: calc(var(--kk-font-scale, 1) * 13px); }
    .kk-fs-md   { font-size: calc(var(--kk-font-scale, 1) * 16px); }
    .kk-fs-lg   { font-size: calc(var(--kk-font-scale, 1) * 22px); }
    .kk-fs-xl   { font-size: calc(var(--kk-font-scale, 1) * 44px); }
  `;
  document.head.appendChild(s);
}

function _applyFontScale(v) {
  const fs = Math.max(0.6, Math.min(1.6, Number(v) || 1));
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.style.setProperty('--kk-font-scale', String(fs));
  }
}

// Re-push the postfx uniforms + state caches after any accessibility toggle
// so the change reads immediately (no app reload required).
function _applyAccessibilityLive() {
  const m = getMeta();
  state._optReduceMotion = !!m.optReduceMotion;
  state._optReducedFlashing = !!m.optReducedFlashing;
  // Reduce-motion forces shake to 0; otherwise honor the slider value.
  state._optShakeMul = state._optReduceMotion ? 0 : Number(m.optShake);
  applyAccessibilityOptions(state.postFXPass, {
    reduceMotion: state._optReduceMotion,
    colorblind:   m.optColorblind,
    highContrast: !!m.optHighContrast,
  });
}

export function showOptions() {
  // Iter 21a — defensive tooltip hide on modal entry.
  try { hideTooltip(); } catch (_) {}
  try { sfx.modalOpen(); } catch (_) {}
  if (_optionsPanel) return;
  _ensureFontScaleStyle();
  const meta = getMeta();

  _optionsPanel = document.createElement('div');
  _optionsPanel.setAttribute('role', 'dialog');
  _optionsPanel.setAttribute('aria-label', 'Options');
  _optionsPanel.style.cssText = `
    position: fixed; inset: 0;
    background:
      radial-gradient(ellipse at center, rgba(0,0,0,0.55), rgba(0,0,0,0.9) 80%);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    display: flex; flex-direction: column;
    align-items: center; justify-content: flex-start;
    pointer-events: auto;
    font-family: ${F.body};
    z-index: 120;
    overflow-y: auto;
    padding: 40px 20px;
  `;

  const title = document.createElement('div');
  title.textContent = 'Options';
  title.className = 'kk-fs-xl';
  title.style.cssText = `font-family: ${F.display}; font-weight: 900;
    letter-spacing: 0.20em; color: ${C.cyan};
    text-shadow: 0 2px 14px rgba(0,0,0,0.5);
    margin-bottom: 18px;`;

  // Wrapper that hosts all sections, scrollable when long.
  const wrap = document.createElement('div');
  wrap.style.cssText = `
    display: flex; flex-direction: column; gap: 18px;
    width: min(560px, 100%); color: ${C.text};
  `;

  // ── helpers ──
  function sectionBox(label) {
    const box = document.createElement('div');
    box.className = 'kk-panel';
    box.style.cssText = `
      background: linear-gradient(180deg, rgba(20,28,22,0.85), rgba(8,14,12,0.92));
      border: 1px solid ${C.edge}; border-radius: 10px;
      padding: 14px 18px;
      display: flex; flex-direction: column; gap: 10px;
      box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 6px 16px rgba(0,0,0,0.45);
    `;
    const hdr = document.createElement('div');
    hdr.textContent = label;
    hdr.className = 'kk-fs-sm';
    hdr.style.cssText = `font-family: ${F.display}; font-weight: 700;
      letter-spacing: 0.32em; color: ${C.amber};
      text-transform: uppercase;
      border-bottom: 1px solid rgba(255,210,127,0.18);
      padding-bottom: 6px; margin-bottom: 4px;`;
    box.appendChild(hdr);
    return box;
  }

  function row(labelText, controlEl, hint) {
    const r = document.createElement('div');
    r.style.cssText = `display: flex; justify-content: space-between; align-items: center;
      gap: 18px; padding: 3px 0;`;
    const labWrap = document.createElement('div');
    labWrap.style.cssText = `display: flex; flex-direction: column; gap: 2px; flex: 1 1 auto;`;
    const lab = document.createElement('span');
    lab.textContent = labelText;
    lab.className = 'kk-fs-sm';
    lab.style.cssText = `font-family: ${F.body};
      letter-spacing: 0.22em; text-transform: uppercase;
      color: rgba(245,239,225,0.82);`;
    labWrap.appendChild(lab);
    if (hint) {
      const h = document.createElement('span');
      h.textContent = hint;
      h.className = 'kk-fs-mono';
      h.style.cssText = `font-family: ${F.mono};
        color: rgba(245,239,225,0.45);
        letter-spacing: 0.06em;`;
      labWrap.appendChild(h);
    }
    r.appendChild(labWrap);
    r.appendChild(controlEl);
    return r;
  }

  const sliderStyle = 'width: 180px; accent-color:' + C.cyan;
  const toggleStyle = (accent) => `padding: 6px 22px; cursor: pointer;
    background: linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86));
    border: 1px solid ${C.edge}; border-radius: 6px;
    color: ${accent}; font-family: ${F.display}; font-weight: 700;
    letter-spacing: 0.24em;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset;`;
  const selectStyle = `padding: 6px 12px; cursor: pointer;
    background: linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86));
    border: 1px solid ${C.edge}; border-radius: 6px;
    color: ${C.cyan}; font-family: ${F.body};
    letter-spacing: 0.10em; min-width: 180px;`;

  function mkSlider(min, max, step, value, onChange) {
    const s = document.createElement('input');
    s.type = 'range';
    s.min = String(min); s.max = String(max); s.step = String(step);
    s.value = String(value);
    s.style.cssText = sliderStyle;
    s.className = 'kk-fs-sm';
    s.addEventListener('input', () => onChange(parseFloat(s.value)));
    return s;
  }
  function mkToggle(initial, accent, onText, offText, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'kk-fs-sm';
    b.setAttribute('aria-pressed', String(!!initial));
    b.style.cssText = toggleStyle(accent);
    function paint(on) { b.textContent = on ? onText : offText; b.setAttribute('aria-pressed', String(!!on)); }
    paint(initial);
    b.addEventListener('click', () => { const nv = onClick(); paint(nv); });
    return b;
  }
  function mkSelect(options, value, onChange) {
    const sel = document.createElement('select');
    sel.className = 'kk-fs-sm';
    sel.style.cssText = selectStyle;
    for (const o of options) {
      const op = document.createElement('option');
      op.value = o.value;
      op.textContent = o.label;
      if (o.value === value) op.selected = true;
      sel.appendChild(op);
    }
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }

  // ─── Section: Audio ───
  const sAudio = sectionBox('Audio');
  const masterSlider = mkSlider(0, 1, 0.05, meta.optMasterVolume != null ? meta.optMasterVolume : meta.optVolume, v => {
    setOption('optMasterVolume', v); setMasterVolume(v);
  });
  const musicSlider = mkSlider(0, 1, 0.05, meta.optMusicVolume != null ? meta.optMusicVolume : (meta.optVolume * 0.6), v => {
    setOption('optMusicVolume', v); setMusicVolume(v);
  });
  const sfxSlider = mkSlider(0, 1, 0.05, meta.optSfxVolume != null ? meta.optSfxVolume : meta.optVolume, v => {
    setOption('optSfxVolume', v); setSfxVolume(v);
  });
  const musicTgl = mkToggle(!!meta.optMusic, C.cyan, 'On', 'Off', () => {
    const nv = !getMeta().optMusic;
    setOption('optMusic', nv);
    import('./audio.js').then(m => nv ? m.startMusic() : m.stopMusic());
    return nv;
  });
  sAudio.appendChild(row('Master Volume', masterSlider));
  sAudio.appendChild(row('Music Volume',  musicSlider));
  sAudio.appendChild(row('SFX Volume',    sfxSlider));
  sAudio.appendChild(row('Music Track',   musicTgl, 'Procedural in-run music loop'));

  // ─── Section: Display ───
  const sDisp = sectionBox('Display');
  const vfxSlider = mkSlider(0, 1, 0.05, meta.optVfx != null ? meta.optVfx : 1.0, v => setOption('optVfx', v));
  const shkSlider = mkSlider(0, 1.5, 0.1, meta.optShake, v => {
    setOption('optShake', v);
    state._optShakeMul = state._optReduceMotion ? 0 : v;
  });
  const reduceMotionTgl = mkToggle(!!meta.optReduceMotion, C.amber, 'On', 'Off', () => {
    const nv = !getMeta().optReduceMotion;
    setOption('optReduceMotion', nv);
    // User explicitly chose — sentinel so boot won't override from prefers-reduced-motion.
    setOption('optReduceMotionUserSet', true);
    _applyAccessibilityLive();
    return nv;
  });
  const reducedFlashTgl = mkToggle(!!meta.optReducedFlashing, C.amber, 'On', 'Off', () => {
    const nv = !getMeta().optReducedFlashing;
    setOption('optReducedFlashing', nv);
    _applyAccessibilityLive();
    return nv;
  });
  const hcTgl = mkToggle(!!meta.optHighContrast, C.amber, 'On', 'Off', () => {
    const nv = !getMeta().optHighContrast;
    setOption('optHighContrast', nv);
    _applyAccessibilityLive();
    return nv;
  });
  const cbSelect = mkSelect([
    { value: 'off',           label: 'Off' },
    { value: 'deuteranopia',  label: 'Deuteranopia (green-weak)' },
    { value: 'protanopia',    label: 'Protanopia (red-weak)' },
    { value: 'tritanopia',    label: 'Tritanopia (blue-weak)' },
  ], meta.optColorblind || 'off', v => {
    setOption('optColorblind', v);
    _applyAccessibilityLive();
  });
  const fsSlider = mkSlider(0.85, 1.30, 0.05, meta.optFontScale != null ? meta.optFontScale : 1.0, v => {
    setOption('optFontScale', v);
    _applyFontScale(v);
  });
  const frameCapSel = mkSelect([
    { value: '0',   label: 'Unlocked' },
    { value: '30',  label: '30 fps' },
    { value: '60',  label: '60 fps' },
    { value: '144', label: '144 fps' },
  ], String(meta.optFrameCap || 0), v => setOption('optFrameCap', parseInt(v, 10) || 0));
  sDisp.appendChild(row('VFX Intensity',    vfxSlider));
  sDisp.appendChild(row('Screen Shake',     shkSlider, 'Reduce Motion overrides to 0'));
  sDisp.appendChild(row('Reduce Motion',    reduceMotionTgl, 'Skip flashes, warp, screen shake'));
  sDisp.appendChild(row('Reduced Flashing', reducedFlashTgl, 'Cap to ~4 flashes/sec at 40% alpha'));
  sDisp.appendChild(row('High Contrast',    hcTgl, 'Boost HUD + text legibility'));
  sDisp.appendChild(row('Colorblind',       cbSelect));
  sDisp.appendChild(row('Font Scale',       fsSlider, '0.85× to 1.30× (modals only)'));
  sDisp.appendChild(row('Frame Cap',        frameCapSel, 'Hint only; v1.0 honors monitor refresh'));

  // ─── Section: Controls ───
  const sCtrl = sectionBox('Controls');
  const aimTgl = mkToggle(!!meta.optManualAim, C.cyan, 'On · 🎯', 'Off', () => {
    const nv = !getMeta().optManualAim;
    setOption('optManualAim', nv);
    return nv;
  });
  const deadzoneSlider = mkSlider(0, 0.30, 0.01, meta.optControllerDeadzone != null ? meta.optControllerDeadzone : 0.15, v => {
    setOption('optControllerDeadzone', v);
  });
  sCtrl.appendChild(row('Manual Aim',         aimTgl, 'Mouse target for autoaim/volley'));
  sCtrl.appendChild(row('Controller Deadzone', deadzoneSlider, '0.00 (twitchy) to 0.30 (lazy)'));

  // ─── Section: Accessibility (i18n stub) ───
  const sA11y = sectionBox('Accessibility');
  const langSel = mkSelect([
    { value: 'en', label: 'English' },
  ], meta.optLanguage || 'en', v => setOption('optLanguage', v));
  sA11y.appendChild(row('Language', langSel, 'More languages post-1.0'));

  // ─── Section: Modes (unlock-gated) ───
  const sMode = sectionBox('Modes');
  let anyMode = false;
  if (meta.unlockedHyper) {
    anyMode = true;
    const hyperBtn = mkToggle(!!meta.optHyper, '#ff7a7a', 'On · 🔥', 'Off', () => {
      const nv = !getMeta().optHyper; setOption('optHyper', nv); return nv;
    });
    sMode.appendChild(row('Hyper Mode', hyperBtn, '1.5× difficulty + coins'));
  }
  if (meta.unlockedEndless) {
    anyMode = true;
    const endBtn = mkToggle(!!meta.optEndless, C.cyan, 'On · ♾', 'Off', () => {
      const nv = !getMeta().optEndless; setOption('optEndless', nv); return nv;
    });
    sMode.appendChild(row('Endless', endBtn, 'No final boss timer'));
  }
  if (meta.unlockedHyper) {
    anyMode = true;
    const brBtn = mkToggle(!!meta.optBossRush, '#ff7a7a', 'On · ⚔', 'Off', () => {
      const nv = !getMeta().optBossRush; setOption('optBossRush', nv); return nv;
    });
    sMode.appendChild(row('Boss Rush', brBtn, 'Mini-bosses at 25/75/135s, final at 200s'));
  }
  if (!anyMode) {
    const empty = document.createElement('div');
    empty.className = 'kk-fs-mono';
    empty.style.cssText = `font-family: ${F.mono}; color: rgba(245,239,225,0.5); padding: 4px 0;`;
    empty.textContent = '— First victory unlocks Hyper, Endless, and Boss Rush —';
    sMode.appendChild(empty);
  }

  // ─── Section: Data ───
  const sData = sectionBox('Data');
  // Export — copy + download.
  const exportRow = document.createElement('div');
  exportRow.style.cssText = 'display: flex; gap: 10px; flex-wrap: wrap;';
  const exportCopyBtn = document.createElement('button');
  exportCopyBtn.type = 'button';
  exportCopyBtn.className = 'kk-fs-sm';
  exportCopyBtn.style.cssText = toggleStyle(C.cyan);
  exportCopyBtn.textContent = 'Copy JSON';
  exportCopyBtn.addEventListener('click', () => {
    const json = exportMeta();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(json);
        exportCopyBtn.textContent = 'Copied ✓';
      } else {
        // Fallback: textarea + execCommand
        const ta = document.createElement('textarea');
        ta.value = json;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (_) {}
        document.body.removeChild(ta);
        exportCopyBtn.textContent = 'Copied ✓';
      }
    } catch (e) { exportCopyBtn.textContent = 'Copy failed'; }
    setTimeout(() => { exportCopyBtn.textContent = 'Copy JSON'; }, 1800);
  });
  const exportFileBtn = document.createElement('button');
  exportFileBtn.type = 'button';
  exportFileBtn.className = 'kk-fs-sm';
  exportFileBtn.style.cssText = toggleStyle(C.cyan);
  exportFileBtn.textContent = 'Download .json';
  exportFileBtn.addEventListener('click', () => {
    const json = exportMeta();
    try {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `kk-survivors-save-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      console.warn('[exportMeta] download failed', e);
    }
  });
  exportRow.appendChild(exportCopyBtn);
  exportRow.appendChild(exportFileBtn);
  sData.appendChild(row('Save Export', exportRow, 'Copy / download your meta progress'));

  // Import — textarea OR file input.
  const importWrap = document.createElement('div');
  importWrap.style.cssText = 'display: flex; flex-direction: column; gap: 8px; width: 100%;';
  const importStatus = document.createElement('div');
  importStatus.className = 'kk-fs-mono';
  importStatus.style.cssText = `font-family: ${F.mono}; color: rgba(245,239,225,0.6);`;
  const importTa = document.createElement('textarea');
  importTa.className = 'kk-fs-mono';
  importTa.placeholder = 'Paste exported JSON here…';
  importTa.style.cssText = `width: 100%; min-height: 80px;
    background: rgba(8,14,12,0.92); color: ${C.text};
    border: 1px solid ${C.edge}; border-radius: 6px;
    padding: 8px 10px; font-family: ${F.mono};
    resize: vertical;`;
  const importBtnRow = document.createElement('div');
  importBtnRow.style.cssText = 'display: flex; gap: 10px; flex-wrap: wrap;';
  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.className = 'kk-fs-sm';
  importBtn.style.cssText = toggleStyle(C.amber);
  importBtn.textContent = 'Import Pasted';
  importBtn.addEventListener('click', () => {
    const r = importMeta(importTa.value);
    if (r.ok) {
      importStatus.style.color = C.green;
      importStatus.textContent = '✓ Save imported. Restart recommended.';
      // Re-apply live so the new settings show without a reload.
      _applyAccessibilityLive();
      _applyFontScale(getMeta().optFontScale != null ? getMeta().optFontScale : 1);
    } else {
      importStatus.style.color = C.red;
      importStatus.textContent = `✗ Import failed: ${r.reason || 'unknown'}`;
    }
  });
  const fileIn = document.createElement('input');
  fileIn.type = 'file';
  fileIn.accept = 'application/json,.json';
  fileIn.style.cssText = `color: ${C.text}; font-family: ${F.mono};`;
  fileIn.addEventListener('change', () => {
    const f = fileIn.files && fileIn.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      importTa.value = String(reader.result || '');
      const r = importMeta(importTa.value);
      if (r.ok) {
        importStatus.style.color = C.green;
        importStatus.textContent = '✓ Save imported from file. Restart recommended.';
        _applyAccessibilityLive();
        _applyFontScale(getMeta().optFontScale != null ? getMeta().optFontScale : 1);
      } else {
        importStatus.style.color = C.red;
        importStatus.textContent = `✗ Import failed: ${r.reason || 'unknown'}`;
      }
    };
    reader.onerror = () => {
      importStatus.style.color = C.red;
      importStatus.textContent = '✗ Could not read file';
    };
    reader.readAsText(f);
  });
  importBtnRow.appendChild(importBtn);
  importBtnRow.appendChild(fileIn);
  importWrap.appendChild(importTa);
  importWrap.appendChild(importBtnRow);
  importWrap.appendChild(importStatus);
  sData.appendChild(row('Save Import', importWrap));

  // Reset — type-to-confirm.
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'kk-fs-sm';
  resetBtn.style.cssText = toggleStyle(C.red);
  resetBtn.textContent = 'Reset Progress…';
  resetBtn.addEventListener('click', () => {
    _showResetConfirmModal(() => {
      resetMeta();
      _applyAccessibilityLive();
      _applyFontScale(1);
      hideOptions();
      // Reload to ensure all module-level caches drop.
      try { window.location.reload(); } catch (_) {}
    });
  });
  sData.appendChild(row('Reset Progress', resetBtn, 'Wipes coins, embers, unlocks, runs'));

  // Append sections
  wrap.appendChild(sAudio);
  wrap.appendChild(sDisp);
  wrap.appendChild(sCtrl);
  wrap.appendChild(sA11y);
  wrap.appendChild(sMode);
  wrap.appendChild(sData);

  // Footer button row — Close + Return-to-Main-Menu side by side.
  // Menu button only renders if we're mid-run or in a sub-mode (town /
  // catacomb / interior); on the start screen itself there's nothing to
  // return from, so only Close shows.
  const footer = document.createElement('div');
  footer.style.cssText = `display:flex; gap:14px; margin-top:20px; flex-wrap:wrap; justify-content:center;`;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'kk-btn-secondary kk-fs-sm';
  close.textContent = 'Close · Esc';
  close.setAttribute('aria-label', 'Close options');
  close.addEventListener('click', hideOptions);
  footer.appendChild(close);

  if (state.mode !== 'menu') {
    const menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    menuBtn.className = 'kk-btn-primary kk-fs-sm';
    menuBtn.textContent = '↩ Main Menu';
    menuBtn.setAttribute('aria-label', 'Return to main menu');
    menuBtn.addEventListener('click', () => {
      if (typeof window.kkReturnToMenu === 'function') window.kkReturnToMenu();
      else location.reload();
    });
    footer.appendChild(menuBtn);
  }

  _optionsPanel.appendChild(title);
  _optionsPanel.appendChild(wrap);
  _optionsPanel.appendChild(footer);
  _root.appendChild(_optionsPanel);

  state.time.paused = true;
}

// Reset-progress type-to-confirm modal — RESET text gate so a misclick can't
// destroy years of progress. Calls `onConfirm()` only when the player types
// the exact word and presses the confirm button.
function _showResetConfirmModal(onConfirm) {
  const overlay = document.createElement('div');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Confirm reset progress');
  overlay.style.cssText = `
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.78);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    display: flex; align-items: center; justify-content: center;
    z-index: 200; font-family: ${F.body};
  `;
  const box = document.createElement('div');
  box.style.cssText = `
    background: linear-gradient(180deg, rgba(40,15,15,0.95), rgba(20,8,8,0.97));
    border: 2px solid ${C.red}; border-radius: 12px;
    padding: 24px 30px; min-width: min(360px, 90vw); max-width: 460px;
    color: ${C.text};
    box-shadow: 0 16px 36px rgba(0,0,0,0.65), 0 0 22px rgba(255,94,94,0.25);
    display: flex; flex-direction: column; gap: 12px;
  `;
  const h = document.createElement('div');
  h.className = 'kk-fs-lg';
  h.style.cssText = `font-family: ${F.display}; font-weight: 900; letter-spacing: 0.16em;
    color: ${C.red}; text-transform: uppercase;`;
  h.textContent = 'Reset progress';
  const p = document.createElement('div');
  p.className = 'kk-fs-sm';
  p.style.cssText = `line-height: 1.5; color: rgba(245,239,225,0.85);`;
  p.innerHTML = `This wipes <b>coins, embers, sigils, unlocks, run history, achievements, and presets</b>. There is no undo.<br><br>Type <b style="color:${C.red};">RESET</b> to confirm:`;
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.placeholder = 'RESET';
  inp.className = 'kk-fs-md';
  inp.style.cssText = `padding: 8px 12px; background: rgba(8,4,4,0.9);
    color: ${C.text}; border: 1px solid ${C.edge}; border-radius: 6px;
    font-family: ${F.mono}; letter-spacing: 0.2em; text-transform: uppercase;`;
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display: flex; gap: 10px; margin-top: 6px;';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'kk-fs-sm';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = `padding: 8px 18px; cursor: pointer;
    background: rgba(20,20,20,0.8); color: ${C.text};
    border: 1px solid ${C.edge}; border-radius: 6px;
    font-family: ${F.display}; font-weight: 700; letter-spacing: 0.20em;`;
  cancelBtn.addEventListener('click', () => {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  });
  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'kk-fs-sm';
  confirmBtn.textContent = 'Wipe Progress';
  confirmBtn.disabled = true;
  confirmBtn.style.cssText = `padding: 8px 18px; cursor: not-allowed;
    background: rgba(80,20,20,0.6); color: rgba(245,239,225,0.5);
    border: 1px solid ${C.red}; border-radius: 6px;
    font-family: ${F.display}; font-weight: 700; letter-spacing: 0.20em;
    opacity: 0.5;`;
  function refreshGate() {
    const ok = inp.value.trim().toUpperCase() === 'RESET';
    confirmBtn.disabled = !ok;
    confirmBtn.style.cursor = ok ? 'pointer' : 'not-allowed';
    confirmBtn.style.background = ok ? `rgba(160,40,40,0.9)` : 'rgba(80,20,20,0.6)';
    confirmBtn.style.color = ok ? C.text : 'rgba(245,239,225,0.5)';
    confirmBtn.style.opacity = ok ? '1' : '0.5';
  }
  inp.addEventListener('input', refreshGate);
  confirmBtn.addEventListener('click', () => {
    if (inp.value.trim().toUpperCase() !== 'RESET') return;
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    try { onConfirm(); } catch (e) { console.warn('[resetMeta] confirm failed', e); }
  });
  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(confirmBtn);
  box.appendChild(h);
  box.appendChild(p);
  box.appendChild(inp);
  box.appendChild(btnRow);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  setTimeout(() => inp.focus(), 0);
}

export function hideOptions() {
  if (!_optionsPanel) return;
  try { sfx.modalClose(); } catch (_) {}
  if (_optionsPanel.parentNode) _optionsPanel.parentNode.removeChild(_optionsPanel);
  _optionsPanel = null;
  if (!state.gameOver && state.started) state.time.paused = false;
}

export function isOptionsOpen() { return !!_optionsPanel; }

// ── Weapon panel ─────────────────────────────────────────────────────────────
function _updateWeaponPanel() {
  if (!_weaponPanel) return;
  const reg = _registry || {};
  const weapons = state.weapons || [];
  // Add/update cells
  for (const w of weapons) {
    const entry = reg[w.id];
    if (!entry) continue;
    let cell = _weaponCells.get(w.id);
    if (!cell) {
      const wrap = document.createElement('div');
      const evolved = w.inst && w.inst.evolved;
      wrap.style.cssText = `
        width: 56px; padding: 6px 4px;
        background: rgba(6,16,8,0.85);
        border: 1px solid ${evolved ? C.amber : C.cyan};
        box-shadow: 0 0 8px ${evolved ? 'rgba(255,225,74,0.55)' : 'rgba(68,255,204,0.45)'};
        text-align: center; line-height: 1.2;
        color: ${C.text};
      `;
      const icon = document.createElement('div');
      icon.style.cssText = 'font-size: calc(var(--kk-font-scale, 1) * 24px);';
      icon.textContent = entry.icon || '★';
      const lvl = document.createElement('div');
      lvl.style.cssText = `font-size: calc(var(--kk-font-scale, 1) * 10px); color: ${evolved ? C.amber : C.cyan}; letter-spacing: 1px;`;
      lvl.textContent = evolved ? 'EVO' : `LV${w.level}`;
      wrap.appendChild(icon); wrap.appendChild(lvl);
      _weaponPanel.appendChild(wrap);
      cell = { wrap, level: w.level, evolved };
      _weaponCells.set(w.id, cell);
      // Pointer events default to none on the HUD; enable on the cell so the
      // tooltip listeners fire when the player pauses + hovers.
      wrap.style.pointerEvents = 'auto';
      wrap.style.cursor = 'help';
      bindTooltip(wrap, () => {
        const w2 = (state.weapons || []).find(x => x.id === w.id);
        if (!w2) return null;
        const evo = w2.inst && w2.inst.evolved;
        const wb = weaponBlurb(w2.id, w2.level);
        if (!wb) return { title: w.id, body: 'Equipped weapon.' };
        const reg = (_registry || {})[w2.id];
        const maxLv = reg ? reg.maxLevel : w2.level;
        return {
          title: wb.name + (evo ? ' · EVOLVED' : ` · Lv ${w2.level}/${maxLv}`),
          icon: wb.icon,
          body: wb.flavor + '\n\n' + wb.body + (evo ? '\n\nEvolved form active.' : ''),
          tags: wb.tags,
          stats: weaponStatRows(w2.id, w2.level),
          accent: evo ? '#ffd27f' : '#7fffe4',
        };
      });
    } else {
      const evolved = w.inst && w.inst.evolved;
      if (cell.level !== w.level || cell.evolved !== evolved) {
        const lvl = cell.wrap.children[1];
        lvl.textContent = evolved ? 'EVO' : `LV${w.level}`;
        cell.wrap.style.borderColor = evolved ? C.amber : C.cyan;
        cell.wrap.style.boxShadow = `0 0 8px ${evolved ? 'rgba(255,225,74,0.55)' : 'rgba(68,255,204,0.45)'}`;
        lvl.style.color = evolved ? C.amber : C.cyan;
        cell.level = w.level;
        cell.evolved = evolved;
      }
    }
  }
  // Remove cells for weapons no longer owned (e.g., reset)
  const ownedIds = new Set(weapons.map(w => w.id));
  for (const [id, cell] of _weaponCells.entries()) {
    if (!ownedIds.has(id)) {
      unbindTooltip(cell.wrap);
      if (cell.wrap.parentNode) cell.wrap.parentNode.removeChild(cell.wrap);
      _weaponCells.delete(id);
    }
  }
}

// ── Achievement toast ────────────────────────────────────────────────────────
const _achQueue = [];
let _achToast = null;
export function tryAchievement(id) {
  // Import locally to avoid circular import at module load
  return import('./meta.js').then(m => {
    const def = m.unlockAchievement(id);
    if (def) _enqueueAchievement(def);
    return def;
  });
}
function _enqueueAchievement(def) {
  _achQueue.push(def);
  if (!_achToast) _showNextAchievement();
}
function _showNextAchievement() {
  const def = _achQueue.shift();
  if (!def || !_root) { _achToast = null; return; }
  _achToast = document.createElement('div');
  _achToast.style.cssText = `
    position: fixed; right: 20px; top: 96px;
    background: linear-gradient(180deg, rgba(20,28,22,0.95), rgba(8,14,12,0.97));
    border: 1px solid ${C.amber};
    border-radius: 10px;
    box-shadow:
      0 1px 0 rgba(255,255,255,0.06) inset,
      0 14px 30px rgba(0,0,0,0.55),
      0 0 22px rgba(255,210,127,0.18);
    padding: 14px 18px; min-width: min(280px, 90vw);
    font-family: ${F.body};
    color: ${C.text}; pointer-events: none; z-index: 65;
    transform: translateX(120%); transition: transform 0.4s ease-out;
    display: flex; gap: 14px; align-items: center;
  `;
  _achToast.innerHTML = `
    <div style="font-size:calc(var(--kk-font-scale, 1) * 38px);filter:drop-shadow(0 3px 8px rgba(0,0,0,0.5));">${def.icon}</div>
    <div>
      <div style="font-family:${F.display};font-size:calc(var(--kk-font-scale, 1) * 10px);color:${C.amber};letter-spacing:0.36em;text-transform:uppercase;">Achievement</div>
      <div style="font-family:${F.display};font-size:calc(var(--kk-font-scale, 1) * 18px);font-weight:700;color:${C.text};letter-spacing:0.10em;margin-top:2px;">${escapeHtml(def.name)}</div>
      <div style="font-size:calc(var(--kk-font-scale, 1) * 11.5px);opacity:0.78;margin-top:3px;line-height:1.45;">${escapeHtml(def.desc)}</div>
    </div>
  `;
  _root.appendChild(_achToast);
  requestAnimationFrame(() => { if (_achToast) _achToast.style.transform = 'translateX(0)'; });
  setTimeout(() => {
    if (!_achToast) return;
    _achToast.style.transform = 'translateX(120%)';
    setTimeout(() => {
      if (_achToast && _achToast.parentNode) _achToast.parentNode.removeChild(_achToast);
      _achToast = null;
      _showNextAchievement();
    }, 400);
  }, 3500);
}

// ── Secret toast (purple-framed variant) ─────────────────────────────────────
const _secretQueue = [];
let _secretToast = null;
export function trySecret(id) {
  return import('./meta.js').then(m => {
    const def = m.unlockSecret(id);
    if (def) _enqueueSecret(def);
    return def;
  });
}
function _enqueueSecret(def) {
  _secretQueue.push(def);
  if (!_secretToast) _showNextSecret();
}
function _showNextSecret() {
  const def = _secretQueue.shift();
  if (!def || !_root) { _secretToast = null; return; }
  const purple = '#c87bff';
  _secretToast = document.createElement('div');
  _secretToast.style.cssText = `
    position: fixed; right: 20px; top: 96px;
    background: linear-gradient(180deg, rgba(28,12,36,0.96), rgba(12,4,22,0.97));
    border: 1px solid ${purple};
    border-radius: 10px;
    box-shadow:
      0 1px 0 rgba(255,255,255,0.06) inset,
      0 14px 30px rgba(0,0,0,0.55),
      0 0 24px rgba(200,123,255,0.28);
    padding: 14px 18px; min-width: min(300px, 90vw);
    font-family: ${F.body};
    color: ${C.text}; pointer-events: none; z-index: 66;
    transform: translateX(120%); transition: transform 0.4s ease-out;
    display: flex; gap: 14px; align-items: center;
  `;
  _secretToast.innerHTML = `
    <div style="font-size:calc(var(--kk-font-scale, 1) * 38px);filter:drop-shadow(0 3px 10px rgba(200,123,255,0.45));">${def.icon}</div>
    <div>
      <div style="font-family:${F.display};font-size:calc(var(--kk-font-scale, 1) * 10px);color:${purple};letter-spacing:0.36em;text-transform:uppercase;">★ Secret Found</div>
      <div style="font-family:${F.display};font-size:calc(var(--kk-font-scale, 1) * 18px);font-weight:700;color:${C.text};letter-spacing:0.10em;margin-top:2px;">${escapeHtml(def.name)}</div>
      <div style="font-size:calc(var(--kk-font-scale, 1) * 11.5px);opacity:0.78;margin-top:3px;line-height:1.45;">${escapeHtml(def.desc)}</div>
    </div>
  `;
  _root.appendChild(_secretToast);
  requestAnimationFrame(() => { if (_secretToast) _secretToast.style.transform = 'translateX(0)'; });
  setTimeout(() => {
    if (!_secretToast) return;
    _secretToast.style.transform = 'translateX(120%)';
    setTimeout(() => {
      if (_secretToast && _secretToast.parentNode) _secretToast.parentNode.removeChild(_secretToast);
      _secretToast = null;
      _showNextSecret();
    }, 400);
  }, 4000);
}

// ── Tutorial overlay (first run only) ────────────────────────────────────────
let _tutorial = null;
let _tutorialHideTO = null;
export function showTutorial() {
  // Iter 21a — defensive tooltip hide on modal entry.
  try { hideTooltip(); } catch (_) {}
  if (_tutorial || !_root) return;
  _tutorial = document.createElement('div');
  _tutorial.style.cssText = `
    position: fixed; left: 50%; bottom: 110px;
    transform: translateX(-50%);
    background: rgba(6,16,8,0.92);
    border: 1px solid ${C.cyan};
    box-shadow: 0 0 16px rgba(68,255,204,0.55);
    padding: 16px 28px; min-width: min(460px, 90vw);
    font-family: ${F.body}; color: ${C.text};
    font-size: calc(var(--kk-font-scale, 1) * 13px); letter-spacing: 1px; line-height: 1.8;
    pointer-events: auto; z-index: 70;
    opacity: 0; transition: opacity 0.35s ease-out;
    text-align: left;
  `;
  _tutorial.innerHTML = `
    <div style="font-size:calc(var(--kk-font-scale, 1) * 18px);color:${C.cyan};text-shadow:0 0 8px ${C.cyan};letter-spacing:4px;text-align:center;margin-bottom:10px;">CONTROLS</div>
    <div><span style="color:${C.amber}">WASD / Arrows</span> &mdash; Move</div>
    <div><span style="color:${C.amber}">Space</span> &mdash; Jump</div>
    <div><span style="color:${C.amber}">Shift</span> &mdash; Dash <span style="opacity:0.6">(unlocks via filler)</span></div>
    <div><span style="color:${C.amber}">Mouse wheel</span> &mdash; Zoom <span style="opacity:0.6">(unlocks via filler)</span></div>
    <div><span style="color:${C.amber}">ESC</span> &mdash; Options</div>
    <div style="text-align:center;margin-top:8px;opacity:0.7;font-size:calc(var(--kk-font-scale, 1) * 11px);">[click or any key to dismiss]</div>
  `;
  _root.appendChild(_tutorial);
  // Fade in on next frame
  requestAnimationFrame(() => { if (_tutorial) _tutorial.style.opacity = '1'; });
  const dismiss = () => hideTutorial();
  _tutorial.addEventListener('click', dismiss);
  window.addEventListener('keydown', dismiss, { once: true });
  // Auto-dismiss after 10s
  _tutorialHideTO = setTimeout(dismiss, 10000);
}
export function hideTutorial() {
  if (!_tutorial) return;
  if (_tutorialHideTO) { clearTimeout(_tutorialHideTO); _tutorialHideTO = null; }
  _tutorial.style.opacity = '0';
  const el = _tutorial;
  _tutorial = null;
  setTimeout(() => { if (el && el.parentNode) el.parentNode.removeChild(el); }, 400);
  // Persist seen flag
  setOption('seenTutorial', true);
}

// ── Damage flash overlay ─────────────────────────────────────────────────────
let _dmgOverlay = null;
let _dmgFadeTO = null;
function _ensureDmgOverlay() {
  if (_dmgOverlay) return;
  _dmgOverlay = document.createElement('div');
  _dmgOverlay.id = 'kk-dmg-overlay';
  _dmgOverlay.style.cssText = `
    position: fixed; inset: 0;
    background: radial-gradient(ellipse at center, rgba(255,40,40,0) 35%, rgba(255,40,40,0.65) 100%);
    pointer-events: none; z-index: 25;
    opacity: 0;
    transition: opacity 0.12s ease-out;
  `;
  document.body.appendChild(_dmgOverlay);
}
export function flashDamage(severity = 1) {
  _ensureDmgOverlay();
  const op = Math.min(1, 0.45 + 0.55 * severity);   // 0.45..1.0 by severity
  const ms = 70 + Math.floor(severity * 80);         // 70..150ms
  _dmgOverlay.style.opacity = String(op);
  if (_dmgFadeTO) clearTimeout(_dmgFadeTO);
  _dmgFadeTO = setTimeout(() => {
    if (_dmgOverlay) _dmgOverlay.style.opacity = '0';
  }, ms);
}

// ── Level-up flash overlay ───────────────────────────────────────────────────
let _luOverlay = null;
let _luFadeTO = null;
function _ensureLuOverlay() {
  if (_luOverlay) return;
  _luOverlay = document.createElement('div');
  _luOverlay.id = 'kk-lu-overlay';
  _luOverlay.style.cssText = `
    position: fixed; inset: 0;
    background: radial-gradient(ellipse at center, rgba(68,255,204,0.45) 0%, rgba(68,255,204,0) 60%);
    pointer-events: none; z-index: 24;
    opacity: 0;
    transition: opacity 0.25s ease-out;
  `;
  document.body.appendChild(_luOverlay);
}
export function flashLevelUp() {
  _ensureLuOverlay();
  _luOverlay.style.opacity = '1';
  if (_luFadeTO) clearTimeout(_luFadeTO);
  _luFadeTO = setTimeout(() => {
    if (_luOverlay) _luOverlay.style.opacity = '0';
  }, 200);
}

// ── Hall of Records ──────────────────────────────────────────────────────────
// Iter-9 retention surface #5: surfaces local leaderboard.topRunsAcrossAll(20)
// as a single-screen table. Defaults to topRunsAcrossAll's existing sort order
// (timeSurvived desc, kills desc) — the brief calls "sortable" but lists no
// per-column toggle, so we don't gold-plate click-to-resort headers. Seed cell
// is click-to-replay: it pre-loads the entry's stage/character/mode into the
// next run via setOption, then closes the modal.
let _hallModal = null;
export function isHallOfRecordsOpen() { return !!_hallModal; }
export function hideHallOfRecords() {
  if (!_hallModal) return;
  try { sfx.modalClose(); } catch (_) {}
  if (_hallModal.parentNode) _hallModal.parentNode.removeChild(_hallModal);
  _hallModal = null;
}
export function showHallOfRecords() {
  // Iter 21a — defensive tooltip hide on modal entry.
  try { hideTooltip(); } catch (_) {}
  if (_hallModal) return;
  try { sfx.modalOpen(); } catch (_) {}
  if (!_root) {
    injectCSS();
    _root = document.getElementById('ui-root');
    if (!_root) return;
  }
  const runs = (typeof topRunsAcrossAll === 'function') ? (topRunsAcrossAll(20) || []) : [];

  _hallModal = document.createElement('div');
  _hallModal.style.cssText = `
    position: fixed; inset: 0;
    background:
      radial-gradient(ellipse at 50% 30%, rgba(255,122,216,0.06), transparent 60%),
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
  title.style.cssText = `font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 44px); font-weight: 900;
    letter-spacing: 0.20em; color: ${C.magenta};
    text-shadow: 0 2px 16px rgba(0,0,0,0.55), 0 0 24px rgba(255,122,216,0.22);
    margin-bottom: 6px;`;
  title.textContent = 'Hall of Records';

  const subtitle = document.createElement('div');
  subtitle.style.cssText = `font-family: ${F.body}; font-size: calc(var(--kk-font-scale, 1) * 11px); letter-spacing: 0.32em;
    color: rgba(245,239,225,0.62); text-transform: uppercase; margin-bottom: 22px;`;
  subtitle.textContent = `Top ${Math.min(runs.length, 20)} runs across all categories · click a seed to replay`;

  const table = document.createElement('div');
  table.style.cssText = `
    width: 100%; max-width: 1000px;
    background: linear-gradient(180deg, rgba(20,28,22,0.94), rgba(8,14,12,0.96));
    border: 1px solid ${C.edge}; border-radius: 10px;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 14px 36px rgba(0,0,0,0.55);
    padding: 14px 18px;
    display: flex; flex-direction: column; gap: 4px;
  `;

  // Header row
  const header = document.createElement('div');
  header.style.cssText = `
    display: grid;
    grid-template-columns: 48px 1.2fr 1.2fr 0.9fr 0.8fr 0.9fr 1.6fr;
    column-gap: 12px;
    padding: 8px 10px;
    font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 10.5px); letter-spacing: 0.30em;
    text-transform: uppercase; color: ${C.amber};
    border-bottom: 1px solid ${C.edge};
  `;
  for (const lbl of ['Rank', 'Character', 'Stage', 'Mode', 'Kills', 'Time', 'Seed']) {
    const c = document.createElement('div'); c.textContent = lbl; header.appendChild(c);
  }
  table.appendChild(header);

  if (runs.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = `padding: 28px; text-align: center; color: rgba(245,239,225,0.62); font-size: calc(var(--kk-font-scale, 1) * 13px); letter-spacing: 0.16em;`;
    empty.textContent = 'No records yet. Survive a run to appear here.';
    table.appendChild(empty);
  } else {
    runs.forEach((r, i) => {
      const row = document.createElement('div');
      const isTop3 = i < 3;
      const accentC = i === 0 ? C.amber : i === 1 ? C.cyan : i === 2 ? C.magenta : 'rgba(245,239,225,0.78)';
      row.style.cssText = `
        display: grid;
        grid-template-columns: 48px 1.2fr 1.2fr 0.9fr 0.8fr 0.9fr 1.6fr;
        column-gap: 12px;
        padding: 8px 10px;
        align-items: center;
        font-family: ${F.mono}; font-size: calc(var(--kk-font-scale, 1) * 12px);
        color: ${C.text};
        border-bottom: 1px solid rgba(255,232,188,0.06);
        ${isTop3 ? 'background: linear-gradient(90deg, rgba(255,210,127,0.05), transparent);' : ''}
      `;
      const seedBtn = document.createElement('button');
      seedBtn.type = 'button';
      seedBtn.textContent = r.seed || '—';
      seedBtn.title = 'Click to load this seed for the next run';
      seedBtn.style.cssText = `
        padding: 4px 8px; cursor: pointer;
        background: rgba(8,14,12,0.66);
        border: 1px solid ${C.cyan};
        border-radius: 6px;
        color: ${C.cyan};
        font-family: ${F.mono}; font-size: calc(var(--kk-font-scale, 1) * 11px); letter-spacing: 0.04em;
      `;
      seedBtn.addEventListener('mouseenter', () => { try { sfx.uiHover(); } catch (_) {} });
      seedBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        try { sfx.uiClick(); } catch (_) {}
        if (r.stage) setOption('selectedStage', r.stage);
        if (r.char)  setOption('selectedChar',  r.char);
        // Always clear ALL mode toggles first, then flip the one that matches
        // the recorded run. Otherwise a player with Daily on, clicking a hyper
        // seed, ends up with BOTH Daily and Hyper active — which the run
        // pipeline (main.js applyMetaUpgrades) treats as a bug state.
        setOption('optHyper',    false);
        setOption('optEndless',  false);
        setOption('optBossRush', false);
        setOption('optDaily',    false);
        setOption('optWeekly',   false);
        if (r.mode === 'hyper')     setOption('optHyper',    true);
        else if (r.mode === 'endless')   setOption('optEndless',  true);
        else if (r.mode === 'boss-rush') setOption('optBossRush', true);
        // daily/weekly seeds are date-locked — don't auto-toggle those.
        // The player can opt-in explicitly via the Daily/Weekly button.
        _kkShowMicroToast(`Loaded seed ${r.seed || ''}`, C.amber);
        setTimeout(() => { hideHallOfRecords(); }, 350);
      });
      const charLabel = (r.char || '?').toUpperCase();
      const stageLabel = (r.stage || '?').toUpperCase();
      const modeLabel = (r.mode || 'normal').toUpperCase();
      row.innerHTML = `
        <div style="color:${accentC};font-family:${F.mono};font-size:calc(var(--kk-font-scale, 1) * 14px);">#${i + 1}</div>
        <div style="font-family:${F.display};font-size:calc(var(--kk-font-scale, 1) * 12px);letter-spacing:0.10em;color:${C.text};">${escapeHtml(charLabel)}</div>
        <div style="font-family:${F.body};font-size:calc(var(--kk-font-scale, 1) * 11px);letter-spacing:0.12em;color:rgba(245,239,225,0.82);text-transform:uppercase;">${escapeHtml(stageLabel)}</div>
        <div style="font-family:${F.body};font-size:calc(var(--kk-font-scale, 1) * 10.5px);letter-spacing:0.16em;color:${r.mode === 'daily' ? '#c87bff' : r.mode === 'weekly' ? C.magenta : r.mode === 'hyper' ? C.red : C.cyan};text-transform:uppercase;">${escapeHtml(modeLabel)}</div>
        <div style="color:${C.amber};">${(r.kills | 0).toLocaleString()}</div>
        <div style="color:${C.text};">${fmtTime(r.timeSurvived | 0)}</div>
      `;
      // Replace the last cell placeholder with the live button.
      const seedCell = document.createElement('div');
      seedCell.appendChild(seedBtn);
      row.appendChild(seedCell);
      table.appendChild(row);
    });
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close · Esc';
  close.style.cssText = `margin-top: 22px; padding: 10px 26px; cursor: pointer;
    background: linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86));
    border: 1px solid ${C.edge}; border-radius: 8px;
    color: ${C.magenta}; font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 13px); font-weight: 700;
    letter-spacing: 0.28em;`;
  close.addEventListener('mouseenter', () => { try { sfx.uiHover(); } catch (_) {} });
  close.onclick = hideHallOfRecords;

  // ── Helltide stats panel (iter 18) ──────────────────────────────────────
  // Sits between the subtitle and the top-runs table so it's the first thing
  // a returning player sees — surfaces the lifetime "feels like it MATTERS"
  // weight that iter 17's run-currency was missing. Reads from meta.lifetime
  // which helltide.endHelltide() bumps on every event close.
  const helltidePanel = document.createElement('div');
  {
    const m = (typeof getMeta === 'function') ? getMeta() : {};
    const lt = (m && m.lifetime) || {};
    const totalEmbers = (lt.helltideEmbersTotal | 0) || 0;
    const maxBanked = (lt.helltideMaxBanked | 0) || 0;
    helltidePanel.style.cssText = `
      width: 100%; max-width: 1000px;
      background: linear-gradient(180deg, rgba(34,18,12,0.92), rgba(20,10,8,0.94));
      border: 1px solid rgba(255,122,40,0.45);
      border-radius: 10px;
      box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset,
                  0 12px 28px rgba(0,0,0,0.55),
                  0 0 28px rgba(255,90,40,0.10);
      padding: 14px 22px;
      display: flex; align-items: center; justify-content: space-between;
      gap: 18px; flex-wrap: wrap;
      margin-bottom: 14px;
    `;
    helltidePanel.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:2px;">
        <div style="font-family:${F.display};font-size:calc(var(--kk-font-scale, 1) * 13px);font-weight:900;letter-spacing:0.28em;color:#ffae6a;text-transform:uppercase;">
          🔥 Helltide
        </div>
        <div style="font-family:${F.body};font-size:calc(var(--kk-font-scale, 1) * 10.5px);letter-spacing:0.22em;color:rgba(245,239,225,0.55);text-transform:uppercase;">
          Hellfire embers — lifetime tally
        </div>
      </div>
      <div style="display:flex;gap:28px;align-items:baseline;">
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px;">
          <div style="font-family:${F.mono};font-size:calc(var(--kk-font-scale, 1) * 22px);color:#ff8a5a;letter-spacing:0.04em;">
            ${totalEmbers.toLocaleString()} ⚜
          </div>
          <div style="font-family:${F.body};font-size:calc(var(--kk-font-scale, 1) * 9.5px);letter-spacing:0.24em;color:rgba(245,239,225,0.62);text-transform:uppercase;">
            Embers banked (lifetime)
          </div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px;">
          <div style="font-family:${F.mono};font-size:calc(var(--kk-font-scale, 1) * 22px);color:#ff8a5a;letter-spacing:0.04em;">
            ${maxBanked.toLocaleString()} ⚜
          </div>
          <div style="font-family:${F.body};font-size:calc(var(--kk-font-scale, 1) * 9.5px);letter-spacing:0.24em;color:rgba(245,239,225,0.62);text-transform:uppercase;">
            Most banked in one Helltide
          </div>
        </div>
      </div>
    `;
  }

  _hallModal.appendChild(title);
  _hallModal.appendChild(subtitle);
  _hallModal.appendChild(helltidePanel);
  _hallModal.appendChild(table);
  _hallModal.appendChild(close);
  _root.appendChild(_hallModal);

  // Capture-phase Esc handler — mirrors runHistory + codex patterns so the
  // global Esc in main.js doesn't toggle the options panel underneath.
  const winKey = (e) => {
    if (!_hallModal) { window.removeEventListener('keydown', winKey, true); return; }
    if (e.code === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      hideHallOfRecords();
    }
  };
  window.addEventListener('keydown', winKey, true);
}

// ── Banner ───────────────────────────────────────────────────────────────────
let _banner = null;
let _bannerHideTO = null;
export function showBanner(text, durationSec = 3, color) {
  if (!_root) return;
  if (_banner && _banner.parentNode) _banner.parentNode.removeChild(_banner);
  if (_bannerHideTO) clearTimeout(_bannerHideTO);
  _banner = document.createElement('div');
  const col = color || C.amber;
  _banner.style.cssText = `
    position: fixed; left: 50%; top: 18%;
    transform: translateX(-50%);
    font-family: ${F.display};
    font-size: 38px; font-weight: 900; letter-spacing: 0.18em;
    color: ${col};
    text-shadow: 0 2px 14px rgba(0,0,0,0.65), 0 0 22px ${col}55;
    pointer-events: none; z-index: 80;
    padding: 12px 28px;
    background: linear-gradient(180deg, rgba(20,28,22,0.72), rgba(8,14,12,0.78));
    border-top: 1px solid ${C.edge};
    border-bottom: 1px solid ${C.edge};
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    box-shadow: 0 12px 36px rgba(0,0,0,0.55);
    white-space: nowrap;
    animation: kk-fade-in 0.35s ease-out;
  `;
  _banner.textContent = text;
  _root.appendChild(_banner);
  _bannerHideTO = setTimeout(() => {
    if (_banner && _banner.parentNode) _banner.parentNode.removeChild(_banner);
    _banner = null;
  }, durationSec * 1000);
}

// ── Credits modal ────────────────────────────────────────────────────────────
// Mirrors the Grimoire / Shop / Codex modal aesthetic — gradient backdrop with
// a radial highlight at the top, blur, gold-accented title. Lists the people +
// libraries that made the game. Esc-friendly via uiFocus push.
let _creditsModal = null;
let _creditsFocusScope = null;

export function showCredits() {
  // Iter 21a — defensive tooltip hide on modal entry.
  try { hideTooltip(); } catch (_) {}
  if (_creditsModal || !_root) return;
  try { sfx.modalOpen(); } catch (_) {}

  _creditsModal = document.createElement('div');
  _creditsModal.setAttribute('role', 'dialog');
  _creditsModal.setAttribute('aria-label', 'Credits');
  _creditsModal.style.cssText = `
    position: fixed; inset: 0;
    background:
      radial-gradient(ellipse at 50% 30%, rgba(255,210,127,0.08), transparent 60%),
      radial-gradient(ellipse at center, rgba(0,0,0,0.55), rgba(0,0,0,0.92) 80%);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    display: flex; flex-direction: column;
    align-items: center; justify-content: flex-start;
    padding: 48px 20px;
    pointer-events: auto;
    font-family: ${F.body};
    z-index: 125; overflow-y: auto;
  `;

  const title = document.createElement('div');
  title.style.cssText = `font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 44px); font-weight: 900;
    letter-spacing: 0.20em; color: ${C.amber};
    text-shadow: 0 2px 16px rgba(0,0,0,0.55), 0 0 24px rgba(255,210,127,0.22);
    margin-bottom: 6px;`;
  title.textContent = 'Credits';

  const subtitle = document.createElement('div');
  subtitle.style.cssText = `font-family: ${F.body}; font-size: calc(var(--kk-font-scale, 1) * 11px); letter-spacing: 0.32em;
    color: rgba(245,239,225,0.62); text-transform: uppercase; margin-bottom: 26px;`;
  subtitle.textContent = `Made with care · ${KK_VERSION}`;

  const sections = document.createElement('div');
  sections.style.cssText = 'display: grid; grid-template-columns: 1fr; gap: 14px; max-width: 720px; width: 100%;';

  const _section = (heading, accent, lines) => {
    const card = document.createElement('div');
    card.style.cssText = `
      background: linear-gradient(180deg, rgba(20,28,22,0.94), rgba(8,14,12,0.96));
      border: 1px solid ${accent};
      border-radius: 10px;
      box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 12px 26px rgba(0,0,0,0.55);
      padding: 16px 20px;
    `;
    const h = document.createElement('div');
    h.style.cssText = `font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 13px); font-weight: 700;
      letter-spacing: 0.28em; text-transform: uppercase; color: ${accent}; margin-bottom: 8px;`;
    h.textContent = heading;
    card.appendChild(h);
    const body = document.createElement('div');
    body.style.cssText = `font-size: calc(var(--kk-font-scale, 1) * 13px); line-height: 1.65; color: ${C.text};`;
    body.innerHTML = lines.join('<br>');
    card.appendChild(body);
    return card;
  };

  sections.appendChild(_section('Made by', C.amber, [
    `<a href="mailto:slopfactory9000@gmail.com" style="color:${C.amber};text-decoration:none;">@slopfactory9000</a> · code, gameplay, shaders, FX`,
  ]));
  sections.appendChild(_section('Tech', C.cyan, [
    `<a href="https://threejs.org" target="_blank" rel="noopener" style="color:${C.cyan};text-decoration:none;">THREE.js 0.160</a> + addons (EffectComposer, GLTFLoader, DRACOLoader)`,
    'No bundler — native ES modules + importmap',
  ]));
  sections.appendChild(_section('Art', C.amber, [
    'Models — <span style="color:' + C.amber + ';">Quaternius</span> (Ultimate Monsters bundle, chest) — CC0',
    'Models — <span style="color:' + C.amber + ';">Poly by Google</span> via Poly Pizza (Beetle, Ladybug, Grasshopper, Mantis, etc.) — CC-BY',
    'Textures &amp; HDRI — <span style="color:' + C.amber + ';">Poly Haven</span> (forrest_ground_01, approaching_storm) — CC0',
    'All FX, particles, post-processing — procedural / canvas-rendered',
  ]));
  sections.appendChild(_section('Inspiration', C.magenta, [
    '<span style="color:' + C.magenta + ';">Vampire Survivors</span> — the loop, the slot machine, the joy of horde shaping',
    '<span style="color:' + C.magenta + ';">Halls of Torment</span> — weapon evolutions, biome variety',
    '<span style="color:' + C.magenta + ';">Hades</span> — accessibility bar, polish discipline, character signatures',
  ]));
  sections.appendChild(_section('Special Thanks', C.cyan, [
    'Claude Opus 4.7 (1M context) — pair-programmer for the iter 1-11 sprint',
    'The open-source three.js + WebGPU community',
    'Everyone who tested an early build and said "the spider web is good"',
  ]));

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close · Esc';
  close.setAttribute('aria-label', 'Close credits');
  close.style.cssText = `margin-top: 26px; padding: 10px 26px; cursor: pointer;
    background: linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86));
    border: 1px solid ${C.edge}; border-radius: 8px;
    color: ${C.amber}; font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 13px); font-weight: 700;
    letter-spacing: 0.28em;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 20px rgba(0,0,0,0.5);`;
  close.onclick = hideCredits;

  _creditsModal.appendChild(title);
  _creditsModal.appendChild(subtitle);
  _creditsModal.appendChild(sections);
  _creditsModal.appendChild(close);
  _root.appendChild(_creditsModal);

  // Focus scope: trap arrow/enter to the close button (single focus target).
  // onCancel fires when uiFocus.cancelFocus() is called (Esc).
  _creditsFocusScope = pushFocusScope([close], { layout: 'auto', onCancel: hideCredits });
}

export function hideCredits() {
  if (!_creditsModal) return;
  try { sfx.modalClose(); } catch (_) {}
  if (_creditsFocusScope) { popFocusScope(_creditsFocusScope); _creditsFocusScope = null; }
  if (_creditsModal.parentNode) _creditsModal.parentNode.removeChild(_creditsModal);
  _creditsModal = null;
}

export function isCreditsOpen() { return !!_creditsModal; }

// ── Version label (start screen bottom-right) ────────────────────────────────
// Attached to <body> not _startScreen so it doesn't fight the start-screen
// flex layout AND it doesn't disappear when start screen unmounts. Visibility
// is toggled by start screen show/hide via the helper below.
let _versionLabel = null;
function _ensureVersionLabel() {
  if (_versionLabel) return _versionLabel;
  _versionLabel = document.createElement('div');
  _versionLabel.id = 'kk-version-label';
  _versionLabel.style.cssText = `
    position: fixed; right: 12px; bottom: 12px;
    font-family: ${F.mono};
    font-size: calc(var(--kk-font-scale, 1) * 10px); letter-spacing: 0.12em;
    color: rgba(245,239,225,0.42);
    pointer-events: none; z-index: 5;
    user-select: none;
    text-shadow: 0 1px 2px rgba(0,0,0,0.6);
  `;
  _versionLabel.textContent = `v${KK_VERSION}`;
  document.body.appendChild(_versionLabel);
  return _versionLabel;
}
function _setVersionLabelVisible(visible) {
  const el = _ensureVersionLabel();
  el.style.display = visible ? 'block' : 'none';
}

// ── Error toasts (kk-meta-load-failed, kk-asset-load-failed, error) ──────────
// Bound at MODULE LOAD time (not initUI) so boot-time failures during
// preloadAll()/loadMeta() — which fire before initUI() — still surface to the
// player. _root may not exist yet; each emit-handler probes #ui-root lazily.
let _errorListenersBound = false;
let _lastWindowErrorAt = 0;

function _getToastRoot() {
  return _root || document.getElementById('ui-root') || document.body;
}

// Generic toast factory. Stacks vertically in the top-right corner with a
// 8px gap. Sticky toasts get a Dismiss button + manual close; auto toasts
// fade out after `durationMs` and remove themselves.
//   opts: { color, durationMs, sticky, icon, title, body }
let _toastSlot = 0;
function _spawnErrorToast(opts) {
  const root = _getToastRoot();
  if (!root) return null;

  const col = opts.color || C.amber;
  const slot = _toastSlot++;
  const top = 20 + (slot % 6) * 86; // 6-deep vertical stack, then wrap

  const toast = document.createElement('div');
  toast.setAttribute('role', 'alert');
  toast.setAttribute('aria-live', 'assertive');
  toast.style.cssText = `
    position: fixed; right: 20px; top: ${top}px;
    background: linear-gradient(180deg, rgba(20,28,22,0.96), rgba(8,14,12,0.98));
    border: 1px solid ${col};
    border-radius: 10px;
    box-shadow:
      0 1px 0 rgba(255,255,255,0.06) inset,
      0 14px 30px rgba(0,0,0,0.55),
      0 0 22px ${col}33;
    padding: 12px 16px; min-width: min(280px, 90vw); max-width: 360px;
    font-family: ${F.body};
    color: ${C.text}; pointer-events: ${opts.sticky ? 'auto' : 'none'};
    z-index: 220;
    transform: translateX(120%); transition: transform 0.32s ease-out;
    display: flex; gap: 12px; align-items: flex-start;
  `;
  const icon = String(opts.icon || '⚠');
  const safeTitle = escapeHtml(String(opts.title || ''));
  const safeBody  = escapeHtml(String(opts.body || ''));
  const dismissHtml = opts.sticky
    ? `<button type="button" class="kk-err-dismiss" style="
        margin-top:6px;padding:5px 12px;cursor:pointer;
        background:linear-gradient(180deg,rgba(20,28,22,0.78),rgba(8,14,12,0.86));
        border:1px solid ${col};border-radius:6px;
        color:${col};font-family:${F.display};font-size:calc(var(--kk-font-scale, 1) * 11px);font-weight:700;
        letter-spacing:0.22em;text-transform:uppercase;
      ">Dismiss</button>` : '';
  toast.innerHTML = `
    <div style="font-size:calc(var(--kk-font-scale, 1) * 22px);line-height:1;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.5));">${escapeHtml(icon)}</div>
    <div style="flex:1;">
      <div style="font-family:${F.display};font-size:calc(var(--kk-font-scale, 1) * 11px);color:${col};letter-spacing:0.28em;text-transform:uppercase;">${safeTitle}</div>
      <div style="font-size:calc(var(--kk-font-scale, 1) * 12px);opacity:0.86;margin-top:4px;line-height:1.5;">${safeBody}</div>
      ${dismissHtml}
    </div>
  `;
  root.appendChild(toast);
  requestAnimationFrame(() => { toast.style.transform = 'translateX(0)'; });

  const removeToast = () => {
    if (!toast.parentNode) return;
    toast.style.transform = 'translateX(120%)';
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
      _toastSlot = Math.max(0, _toastSlot - 1);
    }, 360);
  };

  if (opts.sticky) {
    const btn = toast.querySelector('.kk-err-dismiss');
    if (btn) btn.addEventListener('click', removeToast);
  } else {
    setTimeout(removeToast, Math.max(500, opts.durationMs || 4000));
  }
  return toast;
}

function _bindErrorListeners() {
  if (_errorListenersBound) return;
  _errorListenersBound = true;

  // 10b emits this from meta.js loadMeta() on JSON.parse failure.
  window.addEventListener('kk-meta-load-failed', (e) => {
    const detail = (e && e.detail) || {};
    if (detail && detail.reason) console.error('[meta] load failed:', detail.reason);
    _spawnErrorToast({
      color: C.red,
      sticky: true,
      icon: '⚠',
      title: 'Save Load Failed',
      body: "Save data couldn't be loaded. Your progress is reset to defaults. Check the console for details.",
    });
  });

  // 10b emits this from assets.js _preload() on GLTF failure.
  window.addEventListener('kk-asset-load-failed', (e) => {
    const detail = (e && e.detail) || {};
    if (detail && detail.key) console.warn('[assets] failed:', detail.key, detail.path || '');
    _spawnErrorToast({
      color: C.amber,
      sticky: false,
      durationMs: 6000,
      icon: '⚠',
      title: 'Asset Load Warning',
      body: 'Some art assets failed to load. The game will still run but may show placeholders.',
    });
  });

  // Generic window-level handlers. Throttled to one visible toast per 3s — a
  // runaway RAF callback can fire hundreds of errors/sec; the throttle keeps
  // the toast stack legible while still mirroring every error to the console.
  const _handleWinError = (label, err) => {
    try { console.error(`[${label}]`, err); } catch (_) {}
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - _lastWindowErrorAt < 3000) return;
    _lastWindowErrorAt = now;
    _spawnErrorToast({
      color: C.red,
      sticky: false,
      durationMs: 4000,
      icon: '⚠',
      title: 'Error',
      body: 'An error occurred. Press F3 for diagnostics.',
    });
  };
  window.addEventListener('error', (e) => {
    _handleWinError('error', (e && (e.error || e.message)) || e);
  });
  window.addEventListener('unhandledrejection', (e) => {
    _handleWinError('unhandledrejection', (e && (e.reason || e)) || e);
  });
}

// Bind immediately at module-load time — boot-time asset/meta failures fire
// BEFORE initUI() is called, so a listener registered inside initUI() would
// miss them entirely.
_bindErrorListeners();

// ── WebGL context-loss modal ─────────────────────────────────────────────────
// main.js installs the canvas-level webglcontextlost / webglcontextrestored
// listeners and calls these helpers. Persistent modal — no auto-dismiss; the
// player needs explicit acknowledgement (reload button) or a restore event.
let _ctxLossModal = null;

export function showContextLossModal() {
  // Iter 21a — defensive tooltip hide on modal entry.
  try { hideTooltip(); } catch (_) {}
  if (_ctxLossModal) return;
  const root = _getToastRoot();
  if (!root) return;

  _ctxLossModal = document.createElement('div');
  _ctxLossModal.setAttribute('role', 'dialog');
  _ctxLossModal.setAttribute('aria-label', 'Graphics device disconnected');
  _ctxLossModal.style.cssText = `
    position: fixed; inset: 0;
    background:
      radial-gradient(ellipse at 50% 30%, rgba(255,80,80,0.10), transparent 60%),
      radial-gradient(ellipse at center, rgba(0,0,0,0.65), rgba(0,0,0,0.95) 80%);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    pointer-events: auto;
    font-family: ${F.body};
    z-index: 240;
  `;

  const card = document.createElement('div');
  card.style.cssText = `
    background: linear-gradient(180deg, rgba(20,28,22,0.96), rgba(8,14,12,0.98));
    border: 1px solid ${C.red};
    border-radius: 12px;
    box-shadow:
      0 1px 0 rgba(255,255,255,0.06) inset,
      0 24px 48px rgba(0,0,0,0.6),
      0 0 28px ${C.red}33;
    padding: 28px 36px; min-width: min(360px, 90vw); max-width: 480px; text-align: center;
  `;

  const icon = document.createElement('div');
  icon.style.cssText = `font-size: calc(var(--kk-font-scale, 1) * 44px); margin-bottom: 8px; filter: drop-shadow(0 3px 10px ${C.red}66);`;
  icon.textContent = '⚠';

  const title = document.createElement('div');
  title.style.cssText = `font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 22px); font-weight: 700;
    letter-spacing: 0.22em; color: ${C.red}; text-transform: uppercase; margin-bottom: 8px;`;
  title.textContent = 'Graphics Disconnected';

  const body = document.createElement('div');
  body.style.cssText = `font-size: calc(var(--kk-font-scale, 1) * 13.5px); color: ${C.text}; line-height: 1.6; margin-bottom: 18px; opacity: 0.88;`;
  body.textContent = 'Your GPU device was disconnected (driver reset, tab throttling, or a system event). Reconnecting…';

  const reload = document.createElement('button');
  reload.type = 'button';
  reload.textContent = 'Reload Page';
  reload.setAttribute('aria-label', 'Reload page to recover');
  reload.style.cssText = `padding: 12px 28px; cursor: pointer;
    background: linear-gradient(180deg, rgba(40,18,18,0.94), rgba(20,8,8,0.96));
    border: 1px solid ${C.red}; border-radius: 8px;
    color: ${C.red}; font-family: ${F.display}; font-size: calc(var(--kk-font-scale, 1) * 13px); font-weight: 700;
    letter-spacing: 0.28em; text-transform: uppercase;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 20px rgba(0,0,0,0.5);`;
  reload.onclick = () => { try { window.location.reload(); } catch (_) {} };

  card.appendChild(icon);
  card.appendChild(title);
  card.appendChild(body);
  card.appendChild(reload);
  _ctxLossModal.appendChild(card);
  root.appendChild(_ctxLossModal);
}

export function hideContextLossModal() {
  if (!_ctxLossModal) return;
  if (_ctxLossModal.parentNode) _ctxLossModal.parentNode.removeChild(_ctxLossModal);
  _ctxLossModal = null;
}

// ── Helltide countdown bar (iter 17) ────────────────────────────────────────
// Top-center bar shown only while the Helltide event is active. Hosts the
// remaining time + the running ember count. Created lazily on first call
// to showHelltideBar so the DOM stays clean when no helltide is running.
let _helltideBar = null;
let _helltideFill = null;
let _helltideLabel = null;
let _helltideBank = null;
export function showHelltideBar(remainingSec, totalSec, embers) {
  if (!_root) return;
  if (!_helltideBar) {
    _helltideBar = document.createElement('div');
    _helltideBar.style.cssText = `
      position: fixed; left: 50%; top: 8px;
      transform: translateX(-50%);
      pointer-events: none; z-index: 70;
      padding: 6px 14px 8px;
      background: linear-gradient(180deg, rgba(60,12,8,0.92), rgba(20,4,2,0.96));
      border: 1px solid #ff5a28;
      border-radius: 8px;
      box-shadow: 0 0 18px rgba(255,90,40,0.45),
                  0 6px 22px rgba(0,0,0,0.65);
      font-family: ${F.display}; min-width: min(320px, 90vw);
    `;
    const header = document.createElement('div');
    header.style.cssText = `
      display: flex; justify-content: space-between; align-items: baseline;
      gap: 18px; font-size: 12px; letter-spacing: 0.24em;
      text-transform: uppercase; color: #ff8a5a;
      text-shadow: 0 1px 6px rgba(0,0,0,0.7);
    `;
    _helltideLabel = document.createElement('span');
    _helltideLabel.textContent = 'HELLTIDE — 3:00';
    _helltideBank = document.createElement('span');
    _helltideBank.style.cssText = 'color: #ffc278; font-weight: 800;';
    _helltideBank.textContent = '0 ⚜';
    header.appendChild(_helltideLabel);
    header.appendChild(_helltideBank);
    const track = document.createElement('div');
    track.style.cssText = `
      margin-top: 4px;
      height: 6px; width: 100%;
      background: rgba(40,8,6,0.85);
      border: 1px solid rgba(255,90,40,0.45);
      border-radius: 3px; overflow: hidden;
    `;
    _helltideFill = document.createElement('div');
    _helltideFill.style.cssText = `
      height: 100%; width: 100%;
      background: linear-gradient(90deg, #ffc26b, #ff5a28 60%, #b03010);
      box-shadow: 0 0 10px rgba(255,90,40,0.65) inset;
    `;
    // No CSS transition — we drive width directly each tick from showHelltideBar.
    // A CSS transition fights the per-frame update and reads as stutter.
    track.appendChild(_helltideFill);
    _helltideBar.appendChild(header);
    _helltideBar.appendChild(track);
    _root.appendChild(_helltideBar);
  }
  const r = Math.max(0, remainingSec | 0);
  const mins = Math.floor(r / 60);
  const secs = r % 60;
  _helltideLabel.textContent = `HELLTIDE — ${mins}:${secs < 10 ? '0' + secs : secs}`;
  _helltideBank.textContent = `${embers | 0} ⚜`;
  const k = totalSec > 0 ? Math.max(0, Math.min(1, remainingSec / totalSec)) : 0;
  _helltideFill.style.width = (k * 100).toFixed(1) + '%';
}

export function hideHelltideBar() {
  if (!_helltideBar) return;
  if (_helltideBar.parentNode) _helltideBar.parentNode.removeChild(_helltideBar);
  _helltideBar = null;
  _helltideFill = null;
  _helltideLabel = null;
  _helltideBank = null;
}
