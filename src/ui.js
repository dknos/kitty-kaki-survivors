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
  commitRunResults, getMeta, setOption, achievementCount, ACHIEVEMENTS, SHOP_UPGRADES, upgradeCost, buyUpgrade, shopLevel, isDiscovered, dailyChallengeConfig, commitDailyRun, equippedRelic, selectedStage, HOUSE_UPGRADES, houseLevel, houseCost, buyHouseUpgrade, QUEST_TEMPLATES, availableQuests, activeQuests, acceptQuest, abandonQuest, claimQuest, maxActiveQuests,
  grantSigils,
  isCharacterUnlocked,

  SHOP_TREE, purchaseTreeNode, nodeUnlocked, nodeOwned, sigilCount,
  addPreset, removePreset, listPresets, applyPreset,
} from './meta.js';
import { CHARACTERS, STAGES } from './config.js';
import { SLOT_SYMBOLS, rollReel, resolveOutcome, applyOutcome } from './slotMachine.js';
import { pushFocusScope, popFocusScope } from './uiFocus.js';
import { mountLegend as mountPromptLegend, formatPrompt } from './buttonPrompts.js';
import { loadArenaDecor } from './arenaDecor.js';
import { bindTooltip, unbindTooltip, hideTooltip } from './tooltips.js';
import { weaponBlurb, passiveBlurb, shopBlurb, fillerBlurb, characterBlurb, weaponStatRows, passiveStatRows } from './weapons/descriptions.js';
import { showCodex, hideCodex, isCodexOpen } from './codex.js';
import { showRunHistory, hideRunHistory, isRunHistoryOpen, recordRunResult } from './runHistory.js';

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
      font-size: 44px; font-weight: 900;
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
      font-size: 11px; color: ${C.amber};
      margin-bottom: 4px; letter-spacing: 0.32em;
      opacity: 0.8;
    }
    .kk-card-icon {
      font-size: 60px; line-height: 1; margin: 6px 0 10px;
      filter: drop-shadow(0 4px 10px rgba(0,0,0,0.5));
    }
    .kk-card-name {
      font-family: ${F.display};
      font-size: 19px; font-weight: 700; color: ${C.text};
      text-align: center; margin-bottom: 4px;
      letter-spacing: 0.08em;
    }
    .kk-card-level {
      font-family: ${F.body};
      font-size: 11px; color: ${C.amber};
      margin-bottom: 12px; letter-spacing: 0.32em;
      text-transform: uppercase;
    }
    .kk-card-desc {
      font-size: 12.5px; color: rgba(245,239,225,0.78);
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
      font-size: 76px; font-weight: 900; letter-spacing: 0.18em;
      color: ${C.red};
      text-shadow: 0 4px 18px rgba(0,0,0,0.6), 0 0 22px rgba(255,94,94,0.35);
      margin-bottom: 28px;
    }
    .kk-death-stats {
      font-family: ${F.body};
      font-size: 15px; color: ${C.text};
      line-height: 1.9; margin-bottom: 18px;
      text-align: left;
      background: rgba(8,14,12,0.55);
      border: 1px solid ${C.edge}; border-radius: 8px;
      padding: 18px 28px; min-width: 360px;
      letter-spacing: 0.04em;
    }
    .kk-death-stats .kk-stat-val {
      font-family: ${F.mono};
      color: ${C.amber};
      float: right; margin-left: 18px;
    }
    .kk-death-hint {
      font-size: 12px; color: rgba(245,239,225,0.7);
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
      align-items: center; justify-content: center;
      pointer-events: auto;
      font-family: ${F.body};
      z-index: 90;
    }
    .kk-start-title {
      font-family: ${F.display};
      font-size: 68px; font-weight: 900;
      letter-spacing: 0.22em;
      color: ${C.amber};
      text-shadow:
        0 2px 20px rgba(0,0,0,0.65),
        0 0 36px rgba(255,210,127,0.25);
      margin-bottom: 18px;
      text-align: center;
      line-height: 1.05;
    }
    .kk-start-sub {
      font-family: ${F.body};
      font-size: 13px; color: rgba(245,239,225,0.78);
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
    @media (max-width: 600px) {
      .kk-card-row { flex-direction: column; gap: 12px; }
      .kk-card { width: 80vw; min-height: 0; padding: 12px; }
      .kk-card-icon { font-size: 40px; margin: 4px 0 8px; }
      .kk-modal-title { font-size: 30px; margin-bottom: 18px; }
      .kk-hp-bar { width: 150px; }
      .kk-death-title { font-size: 44px; }
      .kk-start-title { font-size: 38px; }
    }
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
  title.textContent = 'Level Up';
  _modal.appendChild(title);
  const sub = document.createElement('div');
  sub.style.cssText = `font-family: ${F.body}; font-size: 12px; letter-spacing: 0.34em;
    color: rgba(245,239,225,0.62); text-transform: uppercase; margin: -22px 0 28px;`;
  sub.textContent = 'Choose your path';
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
    b.innerHTML = `${label} <span style="font-family:${F.mono};font-size:11px;opacity:0.78;margin-left:6px;">×${charges}</span>`;
    b.style.cssText = `padding: 10px 22px; cursor: pointer;
      background: linear-gradient(180deg, rgba(20,28,22,0.86), rgba(8,14,12,0.92));
      border: 1px solid ${C.edge}; border-radius: 8px;
      color: ${accent};
      font-family: ${F.display}; font-size: 13px; font-weight: 700;
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
      const fresh = weaponChoices(3);
      state.levelUpChoices = fresh;
      paintCards(row, fresh, _registry || {});
      rebuildQol();
      if (typeof row._kkRefreshFocus === 'function') row._kkRefreshFocus();
    });
  }
  function doSkip() {
    if (state.hero.skips <= 0) return;
    state.hero.skips -= 1;
    // Close modal without applying; resume gameplay.
    state.pendingLevelUp = false;
    state.levelUpChoices.length = 0;
    hideLevelUpModal();
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

  // Run-history log: snapshot the run into meta.runHistory[]. Runs first so the
  // history entry reflects the live state (weapons, evolutions, kills) before
  // teardown touches anything.
  try { recordRunResult(state, state.victory ? 'victory' : 'death'); } catch (_) {}

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
    <div style="font-family:${F.body}; letter-spacing:0.20em; text-transform:uppercase; font-size:12px; color:rgba(245,239,225,0.72);">${label}</div>
    <div style="font-family:${F.mono}; font-size:15px; color:${C.amber}; text-align:right;">${value}${extra}</div>
  `;
  // Custom-colored row for sigil earnings — magenta/epic shade, matches `#c87bff`.
  const sigilRow = (label, value) => `
    <div style="font-family:${F.body}; letter-spacing:0.20em; text-transform:uppercase; font-size:12px; color:rgba(245,239,225,0.72);">${label}</div>
    <div style="font-family:${F.mono}; font-size:15px; color:#c87bff; text-align:right;">${value}</div>
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
    font-family: ${F.display}; font-size: 18px; font-weight: 700;
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
    font-family: ${F.display}; font-size: 16px; font-weight: 700;
    letter-spacing: 0.24em;
    box-shadow: 0 1px 0 rgba(255,255,255,0.06) inset, 0 12px 28px rgba(0,0,0,0.5);`;
  btnRow.appendChild(townBtn);

  const hint = document.createElement('div');
  hint.className = 'kk-death-hint';
  hint.textContent = '(or reload the page)';

  // Per-source damage breakdown — drives "one more run" by exposing which
  // weapon was actually carrying the run.
  const breakdown = document.createElement('div');
  breakdown.style.cssText = `
    margin: 6px 0 4px 0;
    font-family: ${F.body};
    color: ${C.text};
    min-width: 460px; max-width: 580px;
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
      font-family: ${F.display}; font-size: 11px;
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
        font-size: 12px;
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
      min-width: 460px; max-width: 580px;
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
      `<div style="font-family:${F.body};font-size:13px;color:${C.text};letter-spacing:0.06em;margin-top:3px;">▸ ${escapeHtml(a.fmt)}</div>`
    ).join('');
    relicPanel.innerHTML = `
      <div style="font-family:${F.display};font-size:10px;color:${drop.tierColor};letter-spacing:0.36em;text-transform:uppercase;margin-bottom:2px;">★ Relic Dropped</div>
      <div style="font-family:${F.display};font-size:20px;font-weight:700;color:${C.text};letter-spacing:0.10em;">${escapeHtml(drop.name)}</div>
      <div style="font-family:${F.body};font-size:11px;color:${drop.tierColor};letter-spacing:0.28em;text-transform:uppercase;margin-top:2px;">${escapeHtml(drop.tier)}</div>
      <div style="margin-top:8px;">${affixLines}</div>
      <div style="margin-top:10px; font-family:${F.body}; font-size:11px; color:rgba(245,239,225,0.62); letter-spacing:0.04em;">Auto-equipped for next run · manage in Grimoire.</div>
    `;
  }

  _deathScreen.appendChild(title);
  _deathScreen.appendChild(stats);
  _deathScreen.appendChild(breakdown);
  if (relicPanel) _deathScreen.appendChild(relicPanel);
  _deathScreen.appendChild(btnRow);
  _deathScreen.appendChild(hint);
  _root.appendChild(_deathScreen);
  _deathFocusScope = pushFocusScope([retryBtn, townBtn], { layout: 'list' });

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

  _deathKeyHandler = (e) => {
    if (e.code === 'KeyR' || e.key === 'r' || e.key === 'R' || e.code === 'Enter' || e.code === 'Space') restart();
    else if (e.code === 'KeyT' || e.key === 't' || e.key === 'T') goTown();
  };
  window.addEventListener('keydown', _deathKeyHandler);
}

export function showStartScreen(text) {
  if (_startScreen) {
    // Update subtitle in place
    const sub = _startScreen.querySelector('.kk-start-sub');
    if (sub) sub.textContent = text || '';
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
  ornamentTop.style.cssText = 'margin-bottom: 12px;';

  const title = document.createElement('div');
  title.className = 'kk-start-title';
  title.textContent = 'Kitty Kaki Survivors';

  // Mirror flourish under the title
  const ornamentBot = document.createElement('div');
  ornamentBot.innerHTML = ornamentTop.innerHTML;
  ornamentBot.style.cssText = 'margin-top: 4px; margin-bottom: 14px; transform: rotate(180deg);';

  const sub = document.createElement('div');
  sub.className = 'kk-start-sub';
  sub.textContent = text || '';

  const meta = getMeta();
  const metaLine = document.createElement('div');
  metaLine.style.cssText = `margin-top:24px;font-size:14px;color:${C.amber};text-shadow:0 0 6px ${C.amber};letter-spacing:2px;`;
  metaLine.style.cssText = `margin-top: 8px; font-family: ${F.body}; font-size: 13px; letter-spacing: 0.24em; text-transform: uppercase; color: rgba(245,239,225,0.78);`;
  metaLine.innerHTML = meta.runs > 0
    ? `<span style="color:${C.amber}">${meta.coins.toLocaleString()}</span> coins  ·  best <span style="color:${C.amber}">${fmtTime(meta.bestTime)}</span>  ·  <span style="color:${C.amber}">${meta.runs}</span> runs`
    : '<span style="opacity:0.7;">— first run —</span>';

  // Character picker row
  const charRow = document.createElement('div');
  charRow.style.cssText = 'display:flex; gap:10px; margin-top:18px; pointer-events:auto; flex-wrap:wrap; justify-content:center; max-width:90vw;';
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
    charRow.innerHTML = '';
    for (const ch of CHARACTERS) {
      // Iter 7: helper from meta.js absorbs the new unlock token forms
      // (`sigils:N`, `flag:unlockedClockwork`) on top of the legacy
      // achievement-id pattern. Single source of truth.
      const unlocked = isCharacterUnlocked(ch, meta);
      const selected = ch.id === meta.selectedChar;
      const card = document.createElement('div');
      const borderC = selected ? C.amber : (unlocked ? C.edge : 'rgba(80,80,80,0.4)');
      const shadow = selected
        ? `0 0 0 1px ${C.amber} inset, 0 12px 26px rgba(0,0,0,0.55), 0 0 18px rgba(255,210,127,0.18)`
        : `0 1px 0 rgba(255,255,255,0.04) inset, 0 12px 22px rgba(0,0,0,0.5)`;
      card.style.cssText = `
        padding: 14px 18px 12px;
        background: linear-gradient(180deg, rgba(20,28,22,0.94), rgba(8,14,12,0.96));
        border: 1px solid ${borderC};
        border-radius: 10px;
        box-shadow: ${shadow};
        color: ${unlocked ? C.text : 'rgba(120,120,120,0.65)'};
        cursor: ${unlocked ? 'pointer' : 'default'};
        text-align: center; min-width: 148px; max-width: 168px;
        font-family: ${F.body};
        transition: transform 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease;
      `;
      // Signature preview chip — visible identity-in-one-glance. Only show
      // for unlocked characters; locked cards keep the surprise so the unlock
      // banner reads as a real reveal.
      let signatureChip = '';
      if (unlocked && ch.signatureName) {
        signatureChip = `
          <div style="margin-top:6px;display:flex;justify-content:center;">
            <span style="
              display:inline-block;padding:2px 8px;
              font-family:${F.body};font-size:10px;font-weight:600;
              letter-spacing:0.14em;text-transform:uppercase;
              border-radius:999px;border:1px solid ${C.cyan};
              color:${C.cyan};background:rgba(127,255,228,0.10);
              line-height:1.4;
            ">${escapeHtml(ch.signatureName)}</span>
          </div>`;
      }
      // Sigil-gated unlock progress pip — shown UNDER locked cards whose
      // unlock token is `'sigils:N'`. Mirrors the house-upgrade pip strip
      // (single bar, magenta fill) — no new visual language.
      let sigilPip = '';
      const sigilNeed = parseSigilGate(ch.unlock);
      if (sigilNeed != null && !unlocked) {
        const have = (meta.lifetime && meta.lifetime.sigilsEarned) || 0;
        const ratio = Math.max(0, Math.min(1, have / sigilNeed));
        const pct = (ratio * 100).toFixed(0);
        sigilPip = `
          <div style="margin-top:8px;font-family:${F.mono};font-size:10px;letter-spacing:0.08em;color:${SIGIL_PIP_C};text-align:center;">
            ✦ Sigils: ${Math.min(have, sigilNeed)}/${sigilNeed}
          </div>
          <div style="margin-top:4px;height:5px;border-radius:3px;background:rgba(255,255,255,0.08);overflow:hidden;">
            <div style="height:100%;width:${pct}%;background:${SIGIL_PIP_C};box-shadow:0 0 6px ${SIGIL_PIP_C}66;"></div>
          </div>`;
      } else if (sigilNeed != null && unlocked) {
        // Once unlocked, replace the pip with a green check so the card
        // doesn't look "stuck at locked" if the player glances back.
        sigilPip = `
          <div style="margin-top:6px;font-family:${F.mono};font-size:10.5px;letter-spacing:0.08em;color:${C.green};text-align:center;">
            ✓ Sigils complete
          </div>`;
      }
      // Locked-state desc fallback uses the pretty hint instead of the raw token.
      const descLine = unlocked ? escapeHtml(ch.desc) : escapeHtml(formatUnlockHint(ch.unlock));
      card.innerHTML = `
        <div style="font-size:36px;line-height:1;margin-bottom:6px;filter:drop-shadow(0 3px 6px rgba(0,0,0,0.5));">${unlocked ? ch.icon : '🔒'}</div>
        <div style="font-family:${F.display};font-size:13px;letter-spacing:0.18em;font-weight:700;color:${selected ? C.amber : C.text};margin-bottom:6px;">${escapeHtml(ch.name)}</div>
        <div style="font-size:10.5px;line-height:1.45;letter-spacing:0.02em;opacity:${unlocked ? 0.78 : 0.55};">${descLine}</div>
        ${signatureChip}
        ${sigilPip}
      `;
      if (unlocked) {
        card.addEventListener('mouseenter', () => {
          card.style.transform = 'translateY(-3px)';
          if (!selected) card.style.borderColor = C.amber;
        });
        card.addEventListener('mouseleave', () => {
          card.style.transform = 'translateY(0)';
          if (!selected) card.style.borderColor = borderC;
        });
      }
      if (unlocked) {
        card.onclick = (e) => {
          e.stopPropagation();
          setOption('selectedChar', ch.id);
          meta.selectedChar = ch.id;
          paintChars();
          _refreshStartFocus();
        };
      }
      bindTooltip(card, () => {
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
        // Iter 7: surface signature as a top-line stat row when present.
        if (ch.signatureName) {
          statRows.unshift({ label: 'Signature', value: String(ch.signatureName) });
        }
        // Tooltip body: flavor + signature description (if defined) + starter line.
        const bodyParts = [];
        if (unlocked) {
          bodyParts.push(b ? b.flavor : ch.desc);
          if (ch.signatureDesc) bodyParts.push(`◆ ${ch.signatureName}: ${ch.signatureDesc}`);
          bodyParts.push(`Starter weapon: ${ch.starter} (auto-equipped at run start).`);
        } else {
          bodyParts.push(formatUnlockHint(ch.unlock));
          if (sigilNeed != null) {
            const have = (meta.lifetime && meta.lifetime.sigilsEarned) || 0;
            bodyParts.push(`Progress: ${Math.min(have, sigilNeed)} / ${sigilNeed} lifetime sigils.`);
          }
        }
        return {
          title: unlocked ? ch.name : `${ch.name} (Locked)`,
          icon: unlocked ? ch.icon : '🔒',
          body: bodyParts.join('\n\n'),
          tags: unlocked ? (b ? b.tags : ['Character']) : ['Locked'],
          stats: unlocked ? statRows : undefined,
          accent: selected ? '#ffd27f' : '#7fffe4',
        };
      });
      charRow.appendChild(card);
    }
  }
  paintChars();

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display: flex; gap: 12px; margin-top: 22px; pointer-events: auto; flex-wrap: wrap; justify-content: center;';

  const ghostBtn = (label, accent) => `
    padding: 10px 22px; cursor: pointer;
    background: linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86));
    border: 1px solid ${C.edge};
    border-radius: 8px;
    color: ${accent};
    font-family: ${F.display}; font-size: 13px; font-weight: 700;
    letter-spacing: 0.28em;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 20px rgba(0,0,0,0.5);
  `;

  const shopBtn = document.createElement('button');
  shopBtn.type = 'button';
  shopBtn.textContent = 'Shop';
  shopBtn.style.cssText = ghostBtn('Shop', C.amber);
  shopBtn.addEventListener('click', (e) => { e.stopPropagation(); showShop(); });

  const grimBtn = document.createElement('button');
  grimBtn.type = 'button';
  grimBtn.textContent = 'Grimoire';
  grimBtn.style.cssText = ghostBtn('Grimoire', C.magenta);
  grimBtn.addEventListener('click', (e) => { e.stopPropagation(); showGrimoire(); });

  const codexBtn = document.createElement('button');
  codexBtn.type = 'button';
  codexBtn.textContent = 'Codex';
  codexBtn.style.cssText = ghostBtn('Codex', C.cyan);
  codexBtn.addEventListener('click', (e) => { e.stopPropagation(); showCodex(); });

  const historyBtn = document.createElement('button');
  historyBtn.type = 'button';
  historyBtn.textContent = 'History';
  historyBtn.style.cssText = ghostBtn('History', C.amber);
  historyBtn.addEventListener('click', (e) => { e.stopPropagation(); showRunHistory(); });

  const optsBtn = document.createElement('button');
  optsBtn.type = 'button';
  optsBtn.textContent = 'Options';
  optsBtn.style.cssText = ghostBtn('Options', C.cyan);
  optsBtn.addEventListener('click', (e) => { e.stopPropagation(); showOptions(); });

  // Daily challenge toggle — fixed character + modifier, no shop bonuses.
  const dailyBtn = document.createElement('button');
  dailyBtn.type = 'button';
  const purple = '#c87bff';
  const paintDaily = () => {
    const m = getMeta();
    const cfg = dailyChallengeConfig(CHARACTERS.map(c => c.id));
    const on = !!m.optDaily;
    const todayIsRecord = m.dailyRun && m.dailyRun.date === cfg.date;
    const best = todayIsRecord
      ? `BEST ${m.dailyRun.bestKills}K · ${fmtTime(m.dailyRun.bestTime)}`
      : 'NO RUNS YET';
    dailyBtn.innerHTML = `
      <div style="font-family:${F.display}; font-size:13px; font-weight:700; letter-spacing:0.28em;">Daily ${on ? '★' : ''}</div>
      <div style="font-family:${F.body}; font-size:9.5px; opacity:0.82; margin-top:3px; letter-spacing:0.12em; text-transform:uppercase;">${escapeHtml(cfg.date)} · ${escapeHtml(cfg.modifier)}</div>
      <div style="font-family:${F.mono}; font-size:10px; opacity:0.85; margin-top:2px;">${best}</div>
    `;
    dailyBtn.style.cssText = `padding: 10px 18px; cursor: pointer;
      background: ${on ? 'linear-gradient(180deg, rgba(200,123,255,0.22), rgba(110,60,180,0.18))' : 'linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86))'};
      border: 1px solid ${on ? purple : C.edge};
      border-radius: 8px;
      color: ${purple};
      box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 20px rgba(0,0,0,0.5);
      line-height: 1.15; text-align:center;`;
  };
  paintDaily();
  dailyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const m = getMeta();
    setOption('optDaily', !m.optDaily);
    paintDaily();
  });

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
  btnRow.appendChild(dailyBtn);
  btnRow.appendChild(optsBtn);

  _startScreen.appendChild(ornamentTop);
  _startScreen.appendChild(title);
  _startScreen.appendChild(ornamentBot);
  _startScreen.appendChild(sub);
  _startScreen.appendChild(metaLine);

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
      font-family: ${F.body}; font-size: 11.5px; color: ${C.text};
      letter-spacing: 0.06em;
      display: inline-flex; align-items: center; gap: 8px;
    `;
    chip.innerHTML = `
      <span style="font-family:${F.display}; font-size:10px; letter-spacing:0.32em; color:${relic.tierColor}; text-transform:uppercase;">${escapeHtml(relic.tier)} Relic</span>
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
          <div style="font-family:${F.display};font-size:13px;font-weight:700;letter-spacing:0.14em;color:${selected ? C.amber : C.text};">${escapeHtml(st.name)}</div>
          <div style="font-size:11px;line-height:1.45;opacity:${locked ? 0.55 : 0.78};margin-top:3px;">${locked ? (st.id === 'cinder' ? 'Unlocks after a Twilight Hollow victory.' : 'Unlocks after first victory.') : escapeHtml(st.desc)}</div>
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
    _startScreen.appendChild(stageRow);
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
  presetSubtitle.style.cssText = `font-family:${F.body}; font-size:10.5px;
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
    input.style.cssText = `padding:8px 12px; font-family:${F.body}; font-size:12px;
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
      color:${PRESET_C}; font-family:${F.display}; font-size:11px;
      letter-spacing:0.22em; font-weight:700;`;

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.setAttribute('data-focusable', '1');
    cancelBtn.style.cssText = `padding:8px 14px; cursor:pointer;
      background: rgba(20,28,22,0.78);
      border: 1px solid ${C.edge}; border-radius:6px;
      color:rgba(245,239,225,0.7); font-family:${F.display}; font-size:11px;
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
        <span style="font-size:16px; line-height:1;">${charIcon}</span>
        <span style="display:inline-flex; flex-direction:column; line-height:1.2; min-width:0;">
          <span style="font-family:${F.display}; font-size:11px; letter-spacing:0.14em; font-weight:700; color:${C.text}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:160px;">${escapeHtml(p.name)}</span>
          <span style="font-family:${F.body}; font-size:9.5px; letter-spacing:0.18em; text-transform:uppercase; color:rgba(245,239,225,0.6);">${escapeHtml(stageShort)}</span>
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
        font-family: ${F.mono}; font-size: 12px; line-height: 1;
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
      font-family: ${F.display}; font-size: 11px;
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
  _startScreen.appendChild(presetRow);
  _startPresetRowRef = presetRow;

  _startScreen.appendChild(charRow);
  _startScreen.appendChild(btnRow);
  _startCharRowRef = charRow;
  _startBtnRowRef = btnRow;
  _root.appendChild(_startScreen);
  _refreshStartFocus();
}

export function hideStartScreen() {
  if (_startFocusScope) { popFocusScope(_startFocusScope); _startFocusScope = null; }
  _startStageRowRef = null;
  _startCharRowRef = null;
  _startBtnRowRef = null;
  _startPresetRowRef = null;
  if (_startScreen && _startScreen.parentNode) {
    _startScreen.parentNode.removeChild(_startScreen);
  }
  _startScreen = null;
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
  title.style.cssText = `font-family: ${F.display}; font-size: 52px; font-weight: 900;
    letter-spacing: 0.20em; color: ${C.amber};
    text-shadow: 0 2px 18px rgba(0,0,0,0.6), 0 0 28px rgba(255,210,127,0.22);
    margin-bottom: 6px;`;

  const slotSub = document.createElement('div');
  slotSub.style.cssText = `font-family: ${F.body}; font-size: 11px; letter-spacing: 0.34em;
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
      font-size: 64px; line-height: 1;
      box-shadow: inset 0 2px 10px rgba(0,0,0,0.7), inset 0 -1px 0 rgba(255,255,255,0.04);
      filter: drop-shadow(0 4px 8px rgba(0,0,0,0.4));`;
    r.textContent = '❓';
    reels.push(r);
    reelRow.appendChild(r);
  }

  const result = document.createElement('div');
  result.style.cssText = `min-height: 56px; font-family: ${F.display}; font-size: 24px; font-weight: 700;
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
    font-family: ${F.display}; font-size: 14px; font-weight: 700;
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
  // Each reel cycles symbols rapidly, then locks. Decelerate so the stop
  // feels satisfying. Stop times: 1.2s, 1.9s, 2.7s.
  const stops = [1100, 1750, 2500];
  const finalRolls = [rollReel(), rollReel(), rollReel()];

  let elapsed = 0;
  let lastTick = performance.now();

  function symbolForFrame(reelIdx, t) {
    const stop = stops[reelIdx];
    if (t >= stop) return finalRolls[reelIdx].icon;
    // Cycle speed slows as we approach stop time
    const tRem = stop - t;
    const speed = Math.max(40, 400 - tRem * 0.3); // slower interval as close to stop
    const idx = Math.floor(t / speed) % SLOT_SYMBOLS.length;
    return SLOT_SYMBOLS[idx].icon;
  }

  function animLoop() {
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

    if (elapsed < stops[2] + 200) {
      _slotRAF = requestAnimationFrame(animLoop);
      return;
    }

    // ── Resolve outcome (DEFERRED apply — only on TAKE IT) ──
    const outcome = resolveOutcome(finalRolls);
    pending.outcome = outcome;
    _showOutcome(outcome, result, continueBtn, gambleBtn);

    // Gamble disabled on jackpot (don't tease losing it)
    if (outcome.tier !== 'jackpot') {
      gambleBtn.style.display = 'inline-block';
      gambleBtn.onclick = () => _doGamble(pending, result, continueBtn, gambleBtn);
    }
  }
  let _slotRAF = requestAnimationFrame(animLoop);
  _slotModal.__rafId = () => _slotRAF;

  _slotKeyHandler = (e) => {
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

// ── Grimoire modal (evolution discoveries) ───────────────────────────────────
let _grimModal = null;
export function showGrimoire() {
  if (_grimModal) return;
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
  title.style.cssText = `font-family: ${F.display}; font-size: 44px; font-weight: 900;
    letter-spacing: 0.20em; color: ${C.magenta};
    text-shadow: 0 2px 16px rgba(0,0,0,0.55), 0 0 24px rgba(255,122,216,0.22);
    margin-bottom: 6px;`;
  title.textContent = 'Grimoire';

  const subtitle = document.createElement('div');
  subtitle.style.cssText = `font-family: ${F.body}; font-size: 11px; letter-spacing: 0.32em;
    color: rgba(245,239,225,0.62); text-transform: uppercase; margin-bottom: 26px;`;
  subtitle.textContent = 'Evolution recipes — discovered through play';

  const grid = document.createElement('div');
  grid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; max-width: 1100px; width: 100%;';

  // Passives section header + grid (populated below alongside evolutions).
  const passSubtitle = document.createElement('div');
  passSubtitle.style.cssText = `font-family: ${F.body}; font-size: 11px; letter-spacing: 0.32em;
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
        <div style="font-size:30px;text-align:center;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.5));${lifetimeLevel > 0 ? '' : 'opacity:0.45;'}">${p.icon}</div>
        <div>
          <div style="font-family:${F.display};font-size:13px;font-weight:700;letter-spacing:0.10em;color:${lifetimeLevel > 0 ? C.magenta : 'rgba(180,180,180,0.7)'};">${escapeHtml(p.name)}</div>
          <div style="font-size:11px;color:rgba(245,239,225,0.72);line-height:1.45;margin:3px 0 6px;">${escapeHtml(descText)}</div>
          <div style="display:flex;align-items:center;gap:8px;">
            <div>${pips}</div>
            <div style="font-family:${F.mono};font-size:10px;color:rgba(245,239,225,0.55);letter-spacing:0.08em;">Lv ${lifetimeLevel}/${p.maxLevel}</div>
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
          <div style="font-size:40px;text-align:center;filter:drop-shadow(0 3px 6px rgba(0,0,0,0.5));">${evo.icon}</div>
          <div>
            <div style="font-family:${F.display};font-size:15px;font-weight:700;letter-spacing:0.10em;color:${C.amber};">${escapeHtml(evo.name)}</div>
            <div style="font-size:11.5px;color:rgba(245,239,225,0.78);line-height:1.5;margin:4px 0 8px;">${escapeHtml(evo.desc)}</div>
            <div style="font-family:${F.body};font-size:11px;color:rgba(245,239,225,0.62);letter-spacing:0.08em;">
              <span style="color:${C.amber};">Recipe</span> · ${base.icon || '★'} ${escapeHtml(base.name || baseId)} (max) + ${evo.requires.count}× ${escapeHtml(evo.requires.filler)}
            </div>
          </div>
        `;
      } else {
        card.innerHTML = `
          <div style="font-size:40px;text-align:center;color:rgba(120,120,120,0.55);">?</div>
          <div>
            <div style="font-family:${F.display};font-size:15px;font-weight:700;letter-spacing:0.10em;color:rgba(120,120,120,0.7);">Undiscovered</div>
            <div style="font-size:11.5px;color:rgba(120,120,120,0.55);line-height:1.5;margin-top:4px;">Max a base weapon and stack the right passive to reveal this evolution.</div>
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
    color: ${C.magenta}; font-family: ${F.display}; font-size: 13px; font-weight: 700;
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
  if (_grimModal.parentNode) _grimModal.parentNode.removeChild(_grimModal);
  _grimModal = null;
}
export function isGrimoireOpen() { return !!_grimModal; }

// ── Shop modal ───────────────────────────────────────────────────────────────
let _shopModal = null;
let _shopFocusScope = null;
export function showShop() {
  if (_shopModal) return;
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
  title.style.cssText = `font-family: ${F.display}; font-size: 44px; font-weight: 900;
    letter-spacing: 0.20em; color: ${C.amber};
    text-shadow: 0 2px 16px rgba(0,0,0,0.55), 0 0 24px rgba(255,210,127,0.18);
    margin-bottom: 6px;`;
  title.textContent = 'Shop';

  const subtitle = document.createElement('div');
  subtitle.style.cssText = `font-family: ${F.body}; font-size: 11px; letter-spacing: 0.32em;
    color: rgba(245,239,225,0.62); text-transform: uppercase; margin-bottom: 22px;`;
  subtitle.textContent = 'Spend sigils on a permanent meta tree — carry between runs';

  // Treasury (coins) + Sigil counter side-by-side in the header. Sigils are the
  // tree-shop currency; coins remain visible for context (legacy shops, codex).
  const SIGIL_C = '#c87bff';
  const coinsLine = document.createElement('div');
  coinsLine.style.cssText = `font-family: ${F.display}; font-size: 22px; color: ${C.amber};
    margin-bottom: 28px; letter-spacing: 0.18em;
    display: flex; align-items: baseline; gap: 28px; flex-wrap: wrap; justify-content: center;`;
  function paintCoins() {
    const m = getMeta();
    coinsLine.innerHTML = `
      <span style="display:inline-flex; align-items:baseline; gap:10px;">
        <span style="font-family:${F.body};font-size:13px;letter-spacing:0.32em;color:rgba(245,239,225,0.62);text-transform:uppercase;">Treasury</span>
        <span style="font-family:${F.mono};color:${C.amber};">${m.coins.toLocaleString()}</span>
      </span>
      <span style="display:inline-flex; align-items:baseline; gap:10px;">
        <span style="font-family:${F.body};font-size:13px;letter-spacing:0.32em;color:rgba(245,239,225,0.62);text-transform:uppercase;">Sigils</span>
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
      state === 'owned'  ? '<div style="position:absolute;top:8px;right:10px;font-size:18px;color:'+C.amber+';text-shadow:0 1px 4px rgba(0,0,0,0.6);">✓</div>' :
      state === 'locked' ? '<div style="position:absolute;top:8px;right:10px;font-size:16px;opacity:0.75;">🔒</div>' :
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
      <div style="font-size:34px;text-align:center;filter:drop-shadow(0 3px 6px rgba(0,0,0,0.5));opacity:${state === 'locked' ? 0.55 : 1};">${node.icon}</div>
      <div>
        <div style="display:flex; align-items:baseline; gap:8px;">
          <div style="font-family:${F.display};font-size:14px;font-weight:700;letter-spacing:0.10em;color:${txtC};">${escapeHtml(node.name)}</div>
          <div style="font-family:${F.mono};font-size:10px;letter-spacing:0.18em;color:rgba(245,239,225,0.45);">${tierLabel}</div>
        </div>
        <div style="font-size:11px;color:${state === 'locked' ? 'rgba(120,120,120,0.55)' : 'rgba(245,239,225,0.72)'};line-height:1.45;margin-top:3px;">${escapeHtml(node.desc)}</div>
        <div style="display:flex;gap:3px;margin-top:7px;">${pips}</div>
        <div style="font-family:${F.mono};font-size:11px;color:${costC};margin-top:6px;letter-spacing:0.10em;">
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
      <div style="font-size:28px;filter:drop-shadow(0 3px 6px rgba(0,0,0,0.55));">${meta.icon}</div>
      <div style="font-family:${F.display}; font-size:18px; font-weight:700; letter-spacing:0.20em; color:${meta.accent}; margin-top:2px;">${escapeHtml(meta.name)}</div>
      <div style="font-family:${F.body}; font-size:10.5px; letter-spacing:0.32em; text-transform:uppercase; color:rgba(245,239,225,0.55); margin-top:3px;">${escapeHtml(meta.tagline)}</div>
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
        conn.style.cssText = `text-align:center; font-family:${F.mono}; font-size:16px; line-height:1;
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
    color: ${C.magenta}; font-family: ${F.display}; font-size: 13px; font-weight: 700;
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
  if (_shopFocusScope) { popFocusScope(_shopFocusScope); _shopFocusScope = null; }
  if (_shopModal.parentNode) _shopModal.parentNode.removeChild(_shopModal);
  _shopModal = null;
  hideTooltip();
}

// ── House upgrade kiosk (Embers currency) ──
let _houseModal = null;
export function isHouseOpen() { return !!_houseModal; }
export function showHouse() {
  if (_houseModal) return;
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
  title.style.cssText = `font-family: ${F.display}; font-size: 44px; font-weight: 900;
    letter-spacing: 0.20em; color: #ffae6a;
    text-shadow: 0 2px 16px rgba(0,0,0,0.55), 0 0 24px rgba(255,160,90,0.20);
    margin-bottom: 6px;`;
  title.textContent = 'The House';

  const subtitle = document.createElement('div');
  subtitle.style.cssText = `font-family: ${F.body}; font-size: 11px; letter-spacing: 0.32em;
    color: rgba(245,239,225,0.62); text-transform: uppercase; margin-bottom: 22px;`;
  subtitle.textContent = 'Long-term renovations — fueled by Embers from past hunts';

  const emberLine = document.createElement('div');
  emberLine.style.cssText = `font-family: ${F.display}; font-size: 22px; color: #ffae6a;
    margin-bottom: 28px; letter-spacing: 0.18em;
    display: flex; align-items: baseline; gap: 12px;`;
  function paintEmbers() {
    emberLine.innerHTML = `<span style="font-size:13px;letter-spacing:0.32em;color:rgba(245,239,225,0.62);text-transform:uppercase;">Embers</span> <span style="font-family:${F.mono};">${(getMeta().embers || 0).toLocaleString()}</span> 🔥`;
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
      <div style="font-size:38px;text-align:center;filter:drop-shadow(0 3px 6px rgba(0,0,0,0.5));">${upg.icon}</div>
      <div>
        <div style="font-family:${F.display};font-size:15px;font-weight:700;letter-spacing:0.10em;color:${C.text};">${escapeHtml(upg.name)}</div>
        <div style="font-size:11.5px;color:rgba(245,239,225,0.72);line-height:1.45;margin-top:3px;">${escapeHtml(upg.desc)}</div>
        <div style="display:flex;gap:3px;margin-top:8px;">${pips}</div>
        <div style="font-family:${F.mono};font-size:11px;color:${accent};margin-top:6px;letter-spacing:0.08em;">
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
    color: ${C.magenta}; font-family: ${F.display}; font-size: 13px; font-weight: 700;
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
  if (_houseModal.parentNode) _houseModal.parentNode.removeChild(_houseModal);
  _houseModal = null;
}

// ── Quest Board modal (90s CRT in the house interior) ──
let _questModal = null;
export function isQuestBoardOpen() { return !!_questModal; }
export function showQuestBoard() {
  if (_questModal) return;
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
  title.style.cssText = `font-family: ${F.display}; font-size: 38px; font-weight: 900;
    letter-spacing: 0.22em; color: ${lain ? '#4fd0ff' : '#2aff66'};
    text-shadow: 0 2px 16px rgba(0,0,0,0.55), 0 0 24px ${lain ? 'rgba(80,200,255,0.20)' : 'rgba(42,255,102,0.20)'};
    margin-bottom: 6px;`;
  title.textContent = lain ? 'NAVI · Quest Terminal' : 'KAKI-DOS · Bounty Board';

  const subtitle = document.createElement('div');
  subtitle.style.cssText = `font-family: ${F.mono}; font-size: 11px; letter-spacing: 0.32em;
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
        <div style="font-family:${F.mono}; font-size:10px; color:${accent}; margin-top:4px; letter-spacing:0.08em;">
          ${q.progress} / ${tpl.goal}${complete ? '   ·   READY TO CLAIM' : ''}
        </div>
      `;
    }
    card.innerHTML = `
      <div style="font-size:28px; line-height:1; filter:drop-shadow(0 2px 4px rgba(0,0,0,0.5));">${tpl.icon}</div>
      <div>
        <div style="font-family:${F.display}; font-size:13px; font-weight:700; letter-spacing:0.10em; color:${C.text};">${escapeHtml(tpl.name)}</div>
        <div style="font-size:11.5px; color:rgba(245,239,225,0.72); line-height:1.45; margin-top:3px;">${escapeHtml(tpl.desc)}</div>
        <div style="font-family:${F.mono}; font-size:11px; color:${C.amber}; margin-top:6px; letter-spacing:0.06em;">
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
        color:${color}; font-family:${F.display}; font-size:11px; letter-spacing:0.22em;`;
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
    activeCol.innerHTML = `<div style="font-family:${F.display};font-size:12px;letter-spacing:0.30em;color:${lain ? '#4fd0ff' : '#2aff66'};margin-bottom:10px;text-transform:uppercase;">Active</div>`;
    const active = activeQuests();
    if (active.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = `padding:18px; border:1px dashed ${C.edge}; border-radius:8px; color:rgba(245,239,225,0.5); font-size:13px; text-align:center;`;
      empty.textContent = 'No active bounties. Accept one from the offer pool →';
      activeCol.appendChild(empty);
    } else {
      for (const q of active) {
        const tpl = QUEST_TEMPLATES.find(t => t.id === q.id);
        if (tpl) activeCol.appendChild(questCard(tpl, q));
      }
    }
    offerCol.innerHTML = `<div style="font-family:${F.display};font-size:12px;letter-spacing:0.30em;color:${C.amber};margin-bottom:10px;text-transform:uppercase;">Offer Pool</div>`;
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
    color: ${C.magenta}; font-family: ${F.display}; font-size: 13px; font-weight: 700;
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
  if (_questModal.parentNode) _questModal.parentNode.removeChild(_questModal);
  _questModal = null;
}
export function isShopOpen() { return !!_shopModal; }

// ── Options panel ────────────────────────────────────────────────────────────
let _optionsPanel = null;
export function showOptions() {
  if (_optionsPanel) return;
  const meta = getMeta();

  _optionsPanel = document.createElement('div');
  _optionsPanel.style.cssText = `
    position: fixed; inset: 0;
    background:
      radial-gradient(ellipse at center, rgba(0,0,0,0.5), rgba(0,0,0,0.88) 80%);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    pointer-events: auto;
    font-family: ${F.body};
    z-index: 120;
  `;

  const title = document.createElement('div');
  title.textContent = 'Options';
  title.style.cssText = `font-family: ${F.display}; font-size: 40px; font-weight: 900;
    letter-spacing: 0.20em; color: ${C.cyan};
    text-shadow: 0 2px 14px rgba(0,0,0,0.5);
    margin-bottom: 24px;`;

  const panel = document.createElement('div');
  panel.className = 'kk-panel';
  panel.style.cssText += `
    display: flex; flex-direction: column; gap: 14px;
    min-width: 380px; color: ${C.text};
  `;

  function row(labelText, controlEl) {
    const r = document.createElement('div');
    r.style.cssText = `display: flex; justify-content: space-between; align-items: center;
      gap: 18px; padding: 4px 0;`;
    const lab = document.createElement('span');
    lab.textContent = labelText;
    lab.style.cssText = `font-family: ${F.body}; font-size: 12px;
      letter-spacing: 0.24em; text-transform: uppercase;
      color: rgba(245,239,225,0.78);`;
    r.appendChild(lab); r.appendChild(controlEl);
    return r;
  }
  const toggleStyle = (accent) => `padding: 6px 22px; cursor: pointer;
    background: linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86));
    border: 1px solid ${C.edge}; border-radius: 6px;
    color: ${accent}; font-family: ${F.display}; font-size: 12px; font-weight: 700;
    letter-spacing: 0.24em;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset;`;

  // Volume
  const vol = document.createElement('input');
  vol.type = 'range'; vol.min = '0'; vol.max = '1'; vol.step = '0.05';
  vol.value = String(meta.optVolume);
  vol.style.cssText = 'width: 180px; accent-color:' + C.cyan;
  vol.addEventListener('input', () => {
    setOption('optVolume', parseFloat(vol.value));
    import('./audio.js').then(m => m.setVolume(parseFloat(vol.value)));
  });

  // Shake
  const shk = document.createElement('input');
  shk.type = 'range'; shk.min = '0'; shk.max = '1.5'; shk.step = '0.1';
  shk.value = String(meta.optShake);
  shk.style.cssText = 'width: 180px; accent-color:' + C.cyan;
  shk.addEventListener('input', () => {
    const v = parseFloat(shk.value);
    setOption('optShake', v);
    state._optShakeMul = v;
  });

  // Music toggle
  const mus = document.createElement('button');
  mus.type = 'button';
  function paintMus() { mus.textContent = getMeta().optMusic ? 'On' : 'Off'; }
  paintMus();
  mus.style.cssText = toggleStyle(C.cyan);
  mus.addEventListener('click', () => {
    setOption('optMusic', !getMeta().optMusic);
    paintMus();
    import('./audio.js').then(m => getMeta().optMusic ? m.startMusic() : m.stopMusic());
  });

  // Close
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close · Esc';
  close.style.cssText = `margin-top: 16px; padding: 10px 26px; cursor: pointer;
    background: linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86));
    border: 1px solid ${C.edge}; border-radius: 8px;
    color: ${C.magenta}; font-family: ${F.display}; font-size: 13px; font-weight: 700;
    letter-spacing: 0.28em;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 20px rgba(0,0,0,0.5);`;
  close.addEventListener('click', hideOptions);

  // VFX intensity slider
  const vfx = document.createElement('input');
  vfx.type = 'range'; vfx.min = '0'; vfx.max = '1.0'; vfx.step = '0.05';
  vfx.value = String(meta.optVfx !== undefined ? meta.optVfx : 1.0);
  vfx.style.cssText = 'width: 180px; accent-color:' + C.cyan;
  vfx.addEventListener('input', () => setOption('optVfx', parseFloat(vfx.value)));

  // Manual aim toggle (mouse → autoaim/volley target)
  const aim = document.createElement('button');
  aim.type = 'button';
  function paintAim() { aim.textContent = getMeta().optManualAim ? 'On · 🎯' : 'Off'; }
  paintAim();
  aim.style.cssText = toggleStyle(C.cyan);
  aim.addEventListener('click', () => {
    setOption('optManualAim', !getMeta().optManualAim);
    paintAim();
  });

  panel.appendChild(row('Volume',     vol));
  panel.appendChild(row('Shake',      shk));
  panel.appendChild(row('Music',      mus));
  panel.appendChild(row('VFX',        vfx));
  panel.appendChild(row('Manual Aim', aim));

  // Mode toggles — only visible after unlock
  if (meta.unlockedHyper) {
    const hyperBtn = document.createElement('button');
    hyperBtn.type = 'button';
    function paintHyper() { hyperBtn.textContent = (getMeta().optHyper ? 'On · 🔥' : 'Off'); }
    paintHyper();
    hyperBtn.style.cssText = toggleStyle('#ff7a7a');
    hyperBtn.addEventListener('click', () => { setOption('optHyper', !getMeta().optHyper); paintHyper(); });
    panel.appendChild(row('Hyper Mode', hyperBtn));
  }
  if (meta.unlockedEndless) {
    const endBtn = document.createElement('button');
    endBtn.type = 'button';
    function paintEnd() { endBtn.textContent = (getMeta().optEndless ? 'On · ♾' : 'Off'); }
    paintEnd();
    endBtn.style.cssText = toggleStyle(C.cyan);
    endBtn.addEventListener('click', () => { setOption('optEndless', !getMeta().optEndless); paintEnd(); });
    panel.appendChild(row('Endless', endBtn));
  }
  // Boss Rush — unlocks alongside Hyper (first victory). Compressed schedule:
  // mini-bosses at 25/75/135s, final boss at 200s, with ambient swarm pared
  // back to ~4 enemies so the focus is the boss fights.
  if (meta.unlockedHyper) {
    const brBtn = document.createElement('button');
    brBtn.type = 'button';
    function paintBR() { brBtn.textContent = (getMeta().optBossRush ? 'On · ⚔' : 'Off'); }
    paintBR();
    brBtn.style.cssText = toggleStyle('#ff7a7a');
    brBtn.addEventListener('click', () => { setOption('optBossRush', !getMeta().optBossRush); paintBR(); });
    panel.appendChild(row('Boss Rush', brBtn));
  }

  _optionsPanel.appendChild(title);
  _optionsPanel.appendChild(panel);
  _optionsPanel.appendChild(close);
  _root.appendChild(_optionsPanel);

  state.time.paused = true;
}

export function hideOptions() {
  if (!_optionsPanel) return;
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
      icon.style.cssText = 'font-size: 24px;';
      icon.textContent = entry.icon || '★';
      const lvl = document.createElement('div');
      lvl.style.cssText = `font-size: 10px; color: ${evolved ? C.amber : C.cyan}; letter-spacing: 1px;`;
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
    padding: 14px 18px; min-width: 280px;
    font-family: ${F.body};
    color: ${C.text}; pointer-events: none; z-index: 65;
    transform: translateX(120%); transition: transform 0.4s ease-out;
    display: flex; gap: 14px; align-items: center;
  `;
  _achToast.innerHTML = `
    <div style="font-size:38px;filter:drop-shadow(0 3px 8px rgba(0,0,0,0.5));">${def.icon}</div>
    <div>
      <div style="font-family:${F.display};font-size:10px;color:${C.amber};letter-spacing:0.36em;text-transform:uppercase;">Achievement</div>
      <div style="font-family:${F.display};font-size:18px;font-weight:700;color:${C.text};letter-spacing:0.10em;margin-top:2px;">${escapeHtml(def.name)}</div>
      <div style="font-size:11.5px;opacity:0.78;margin-top:3px;line-height:1.45;">${escapeHtml(def.desc)}</div>
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
    padding: 14px 18px; min-width: 300px;
    font-family: ${F.body};
    color: ${C.text}; pointer-events: none; z-index: 66;
    transform: translateX(120%); transition: transform 0.4s ease-out;
    display: flex; gap: 14px; align-items: center;
  `;
  _secretToast.innerHTML = `
    <div style="font-size:38px;filter:drop-shadow(0 3px 10px rgba(200,123,255,0.45));">${def.icon}</div>
    <div>
      <div style="font-family:${F.display};font-size:10px;color:${purple};letter-spacing:0.36em;text-transform:uppercase;">★ Secret Found</div>
      <div style="font-family:${F.display};font-size:18px;font-weight:700;color:${C.text};letter-spacing:0.10em;margin-top:2px;">${escapeHtml(def.name)}</div>
      <div style="font-size:11.5px;opacity:0.78;margin-top:3px;line-height:1.45;">${escapeHtml(def.desc)}</div>
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
  if (_tutorial || !_root) return;
  _tutorial = document.createElement('div');
  _tutorial.style.cssText = `
    position: fixed; left: 50%; bottom: 110px;
    transform: translateX(-50%);
    background: rgba(6,16,8,0.92);
    border: 1px solid ${C.cyan};
    box-shadow: 0 0 16px rgba(68,255,204,0.55);
    padding: 16px 28px; min-width: 460px;
    font-family: ${F.body}; color: ${C.text};
    font-size: 13px; letter-spacing: 1px; line-height: 1.8;
    pointer-events: auto; z-index: 70;
    opacity: 0; transition: opacity 0.35s ease-out;
    text-align: left;
  `;
  _tutorial.innerHTML = `
    <div style="font-size:18px;color:${C.cyan};text-shadow:0 0 8px ${C.cyan};letter-spacing:4px;text-align:center;margin-bottom:10px;">CONTROLS</div>
    <div><span style="color:${C.amber}">WASD / Arrows</span> &mdash; Move</div>
    <div><span style="color:${C.amber}">Space</span> &mdash; Jump</div>
    <div><span style="color:${C.amber}">Shift</span> &mdash; Dash <span style="opacity:0.6">(unlocks via filler)</span></div>
    <div><span style="color:${C.amber}">Mouse wheel</span> &mdash; Zoom <span style="opacity:0.6">(unlocks via filler)</span></div>
    <div><span style="color:${C.amber}">ESC</span> &mdash; Options</div>
    <div style="text-align:center;margin-top:8px;opacity:0.7;font-size:11px;">[click or any key to dismiss]</div>
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
