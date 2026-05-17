/**
 * Kitty Kaki Survivors — Main Menu v2
 *
 * Vanilla-DOM reimplementation of the Claude Design v2 handoff bundle
 * (survivor/project/menu-v2.{jsx,css}). The visual contract — hero scene SVGs,
 * dawn-tone palette, side nav, continue card, chapter rail, footer — is lifted
 * verbatim from the handoff; this module wires it into the existing game state
 * (STAGES, getMeta, selectedAvatar, kkStartRun) and the existing modals
 * (Codex, Grimoire, Quest Board, Options).
 *
 * Mount contract:
 *   showMenuV2()  — builds DOM under #ui-root, attaches resize-fit listener
 *   hideMenuV2()  — tears down DOM + listener
 *
 * The legacy `showStartScreen()` is preserved untouched in ui.js as a fallback
 * (re-enable by editing main.js boot path). `showStartScreen('Loading…')` is
 * still called pre-preload because menuV2 requires post-preload state
 * (carousel needs GLTF_CACHE.hero); the swap happens on the second
 * showStartScreen call ("Press Play to begin"), which we re-route.
 */

import { getMeta, selectedStage, setOption, selectedAvatar } from './meta.js';
import { STAGES, CHARACTERS, AVATARS } from './config.js';
import { createCharCarousel } from './charCarousel.js';
import { state } from './state.js';

// ─────────────────────────────────────────────────────────
// Tone palette — locked to "dawn" for v1.
// ─────────────────────────────────────────────────────────
const TONE = {
  hi:   '#ffd58a',
  mid:  '#e0954a',
  lo:   '#6b2a14',
  glow: 'rgba(255,180,100,.55)',
  rim:  '#ffe2a8',
  sky1: '#3a1f1c',
  sky2: '#0e0807',
};

// Per-stage palette + SVG art template. The handoff has 3 biomes; we extend to
// 4 by adding a violet `void` variant matching Catacomb Void.
const STAGE_ART = {
  forest: {
    bg: '#0c1815',
    accent: 'mistwood',
    tier: 'Chapter I',
    sub: 'Verdant Hollows',
    diff: 'Whisker',
    waves: 32,
  },
  twilight: {
    bg: '#180c08',
    accent: 'dungeon',
    tier: 'Chapter II',
    sub: 'Stoneveil Depths',
    diff: 'Veteran',
    waves: 48,
  },
  cinder: {
    bg: '#180a06',
    accent: 'cinder',
    tier: 'Chapter III',
    sub: 'Emberfall',
    diff: 'Elite',
    waves: 64,
  },
  void: {
    bg: '#0a0612',
    accent: 'void',
    tier: 'Chapter IV',
    sub: 'Catacomb Reach',
    diff: 'Nightmare',
    waves: 80,
  },
};

const NAV_ITEMS = [
  { id: 'play',       label: 'Embark',     glyph: '▶', kbd: 'Enter' },
  { id: 'characters', label: 'Heroes',     glyph: '✦', kbd: 'H' },
  { id: 'arsenal',    label: 'Arsenal',    glyph: '⚔', kbd: 'A' },
  { id: 'codex',      label: 'Codex',      glyph: '❡', kbd: 'C' },
  { id: 'town',       label: 'Town',       glyph: '◈', kbd: 'T' },
  { id: 'options',    label: 'Settings',   glyph: '✲', kbd: 'O' },
];

// ─────────────────────────────────────────────────────────
// Module state
// ─────────────────────────────────────────────────────────
let _menuRoot   = null;
let _stage      = null;
let _fitHandler = null;
let _styleEl    = null;
let _fontsEl    = null;
let _activeNav  = 'play';
let _carousel   = null;
let _overlay    = null;
let _selectedStageId = null;

// ─────────────────────────────────────────────────────────
// CSS + fonts injection
// ─────────────────────────────────────────────────────────
const CSS_URL = new URL('./menuV2.css', import.meta.url).href;
const FONTS_LINK = 'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;500;600;700;800;900&family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap';

function _injectStyles() {
  if (!document.getElementById('kkv2-style')) {
    _styleEl = document.createElement('link');
    _styleEl.id = 'kkv2-style';
    _styleEl.rel = 'stylesheet';
    _styleEl.href = CSS_URL;
    document.head.appendChild(_styleEl);
  }
  if (!document.getElementById('kkv2-fonts')) {
    const pre1 = document.createElement('link');
    pre1.rel = 'preconnect';
    pre1.href = 'https://fonts.googleapis.com';
    document.head.appendChild(pre1);
    const pre2 = document.createElement('link');
    pre2.rel = 'preconnect';
    pre2.href = 'https://fonts.gstatic.com';
    pre2.crossOrigin = 'anonymous';
    document.head.appendChild(pre2);
    _fontsEl = document.createElement('link');
    _fontsEl.id = 'kkv2-fonts';
    _fontsEl.rel = 'stylesheet';
    _fontsEl.href = FONTS_LINK;
    document.head.appendChild(_fontsEl);
  }
}

// ─────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────
export function initMenuV2() { _injectStyles(); }

export function showMenuV2() {
  _injectStyles();
  if (_menuRoot) return; // idempotent

  const uiRoot = document.getElementById('ui-root');
  if (!uiRoot) return;

  _menuRoot = document.createElement('div');
  _menuRoot.className = 'kkv2-root';

  _stage = document.createElement('div');
  _stage.className = 'kkv2-stage';

  // Init selected stage from meta (falls back to first STAGE)
  _selectedStageId = (getMeta() && getMeta().selectedStage) || STAGES[0].id;

  _buildHeroScene(_stage);
  _buildParticles(_stage);
  _buildVignetteAndGrain(_stage);
  _buildTopBar(_stage);
  _buildSideNav(_stage);
  _buildContinueCard(_stage);
  _buildChapterRail(_stage);
  _buildFooter(_stage);

  _menuRoot.appendChild(_stage);
  uiRoot.appendChild(_menuRoot);

  _fitStage();
  _fitHandler = _fitStage;
  window.addEventListener('resize', _fitHandler);
}

export function hideMenuV2() {
  if (_fitHandler) {
    window.removeEventListener('resize', _fitHandler);
    _fitHandler = null;
  }
  if (_carousel) { try { _carousel.destroy(); } catch (_) {} _carousel = null; }
  if (_overlay && _overlay.parentNode) { _overlay.parentNode.removeChild(_overlay); _overlay = null; }
  if (_menuRoot && _menuRoot.parentNode) _menuRoot.parentNode.removeChild(_menuRoot);
  _menuRoot = null;
  _stage = null;
}

export function isMenuV2Open() { return !!_menuRoot; }

// ─────────────────────────────────────────────────────────
// Scale-to-fit (matches React App.useEffect.fit())
// ─────────────────────────────────────────────────────────
function _fitStage() {
  if (!_stage) return;
  const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  _stage.style.transform = `translate(-50%, -50%) scale(${s})`;
}

// ─────────────────────────────────────────────────────────
// Scene
// ─────────────────────────────────────────────────────────
function _svg(html) {
  const wrap = document.createElement('div');
  wrap.innerHTML = html.trim();
  return wrap.firstElementChild;
}

function _buildHeroScene(parent) {
  const scene = document.createElement('div');
  scene.className = 'kkv2-scene';

  // sky gradient
  const sky = document.createElement('div');
  sky.className = 'kkv2-sky';
  sky.style.background = `radial-gradient(120% 70% at 62% 18%, ${TONE.sky1} 0%, ${TONE.sky2} 60%, #020303 100%)`;
  scene.appendChild(sky);

  // sun/moon halo
  const halo = document.createElement('div');
  halo.className = 'kkv2-halo';
  halo.style.background = `radial-gradient(circle, ${TONE.glow} 0%, transparent 65%)`;
  scene.appendChild(halo);

  const orb = document.createElement('div');
  orb.className = 'kkv2-orb';
  orb.style.background = `radial-gradient(circle at 38% 38%, ${TONE.rim} 0%, ${TONE.hi} 45%, ${TONE.mid} 100%)`;
  orb.style.boxShadow = `0 0 80px 20px ${TONE.glow}`;
  scene.appendChild(orb);

  // far ridge
  scene.appendChild(_svg(`
    <svg class="kkv2-layer kkv2-far" viewBox="0 0 1920 1080" preserveAspectRatio="none">
      <path fill="#1a0f0d" opacity="0.7" d="M0,640 L120,600 L260,640 L420,580 L600,620 L800,570 L1000,610 L1200,560 L1400,600 L1600,570 L1800,620 L1920,580 L1920,1080 L0,1080 Z" />
    </svg>
  `));

  // mid pines (procedural, like the JSX Array.from(26))
  let pineHtml = '';
  for (let i = 0; i < 26; i++) {
    const x = i * 78 + ((i * 17) % 23);
    const h = 220 + ((i * 41) % 180);
    const w = 32 + ((i * 11) % 22);
    const y = 740 - h;
    pineHtml += `<g transform="translate(${x},${y})"><path d="M${w/2},0 L${w*0.95},${h*0.35} L${w*0.72},${h*0.35} L${w*1.0},${h*0.7} L${w*0.75},${h*0.7} L${w},${h} L0,${h} L${w*0.25},${h*0.7} L0,${h*0.7} L${w*0.28},${h*0.35} L${w*0.05},${h*0.35} Z" /></g>`;
  }
  scene.appendChild(_svg(`
    <svg class="kkv2-layer kkv2-mid" viewBox="0 0 1920 1080" preserveAspectRatio="none">
      <g fill="#0c0807">${pineHtml}</g>
    </svg>
  `));

  // atmospheric haze
  const haze = document.createElement('div');
  haze.className = 'kkv2-haze';
  haze.style.background = `linear-gradient(180deg, transparent 0%, ${TONE.glow} 50%, transparent 100%)`;
  scene.appendChild(haze);

  // near branches
  scene.appendChild(_svg(`
    <svg class="kkv2-layer kkv2-branches" viewBox="0 0 1920 1080" preserveAspectRatio="none">
      <g fill="#020404">
        <path d="M0,0 L0,260 Q160,200 320,240 Q480,280 580,220 Q500,260 380,260 Q220,260 100,220 Q60,210 0,240 Z" />
        <path d="M1920,0 L1920,280 Q1760,220 1600,260 Q1440,300 1340,240 Q1420,280 1540,280 Q1700,280 1820,240 Q1860,230 1920,260 Z" />
      </g>
    </svg>
  `));

  // hero character splash (decorative)
  scene.appendChild(_buildHeroSilhouette());

  // ground mist
  const mist = document.createElement('div');
  mist.className = 'kkv2-mist';
  scene.appendChild(mist);

  // foreground rocks/grass
  let grassHtml = '';
  for (let i = 0; i < 50; i++) {
    const x = i * 40 + ((i * 13) % 23);
    const h = 10 + ((i * 7) % 22);
    const yBase = 950 + ((i * 5) % 30);
    const sway = (i % 2 ? 2 : -2);
    grassHtml += `<path d="M${x},${yBase} q${sway},-${h * 0.6} 0,-${h}" />`;
  }
  scene.appendChild(_svg(`
    <svg class="kkv2-layer kkv2-fg" viewBox="0 0 1920 1080" preserveAspectRatio="none">
      <g fill="#010202">
        <path d="M0,1080 L0,920 Q80,900 180,930 Q300,960 420,940 Q540,920 680,950 Q820,980 960,960 Q1100,940 1260,970 Q1420,1000 1580,980 Q1740,960 1920,990 L1920,1080 Z" />
      </g>
      <g stroke="#020303" stroke-width="2" stroke-linecap="round" fill="none" opacity="0.9">${grassHtml}</g>
    </svg>
  `));

  parent.appendChild(scene);
}

function _buildHeroSilhouette() {
  const wrap = document.createElement('div');
  wrap.className = 'kkv2-hero';

  const rim = document.createElement('div');
  rim.className = 'kkv2-hero-rim';
  rim.style.background = `radial-gradient(ellipse at 50% 35%, ${TONE.glow} 0%, transparent 55%)`;
  wrap.appendChild(rim);

  // SVG hero — lifted verbatim from HeroCharacter component
  wrap.appendChild(_svg(`
    <svg class="kkv2-hero-svg" viewBox="0 0 600 900" preserveAspectRatio="xMidYEnd meet">
      <defs>
        <linearGradient id="kkv2-hero-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#0c0807" />
          <stop offset="60%" stop-color="#050202" />
          <stop offset="100%" stop-color="#000000" />
        </linearGradient>
        <linearGradient id="kkv2-hero-rim" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="${TONE.rim}" stop-opacity="0" />
          <stop offset="50%" stop-color="${TONE.rim}" stop-opacity="0.65" />
          <stop offset="100%" stop-color="${TONE.rim}" stop-opacity="0" />
        </linearGradient>
        <radialGradient id="kkv2-hero-eye" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="${TONE.rim}" />
          <stop offset="60%" stop-color="${TONE.hi}" />
          <stop offset="100%" stop-color="${TONE.mid}" stop-opacity="0" />
        </radialGradient>
      </defs>

      <path fill="url(#kkv2-hero-body)" opacity="0.92"
        d="M180,300 Q120,420 110,560 Q100,720 160,860 L240,860 Q190,720 200,580 Q210,460 240,360 Z" />
      <path fill="url(#kkv2-hero-body)" opacity="0.92"
        d="M420,300 Q480,420 490,560 Q500,720 440,860 L360,860 Q410,720 400,580 Q390,460 360,360 Z" />

      <path fill="url(#kkv2-hero-body)"
        d="M220,340 Q210,300 230,260 Q250,220 280,210 L320,210 Q350,220 370,260 Q390,300 380,340 L400,420 Q420,500 410,580 Q400,660 380,730 L380,860 L220,860 L220,730 Q200,660 190,580 Q180,500 200,420 Z" />

      <path fill="#1a1210" stroke="${TONE.mid}" stroke-width="1.5"
        d="M180,350 Q170,330 190,310 L240,320 Q250,360 230,400 Q200,400 180,380 Z" />
      <path fill="#1a1210" stroke="${TONE.mid}" stroke-width="1.5"
        d="M420,350 Q430,330 410,310 L360,320 Q350,360 370,400 Q400,400 420,380 Z" />

      <g>
        <path fill="url(#kkv2-hero-body)" d="M210,180 L200,100 L260,160 Z" />
        <path fill="url(#kkv2-hero-body)" d="M390,180 L400,100 L340,160 Z" />
        <path fill="${TONE.lo}" opacity="0.55" d="M215,170 L210,125 L245,160 Z" />
        <path fill="${TONE.lo}" opacity="0.55" d="M385,170 L390,125 L355,160 Z" />
        <path fill="url(#kkv2-hero-body)"
          d="M220,200 Q210,160 240,140 L280,130 L320,130 L360,140 Q390,160 380,200 Q390,250 370,280 Q340,310 300,310 Q260,310 230,280 Q210,250 220,200 Z" />
        <ellipse cx="262" cy="220" rx="8" ry="14" fill="url(#kkv2-hero-eye)" />
        <ellipse cx="338" cy="220" rx="8" ry="14" fill="url(#kkv2-hero-eye)" />
        <ellipse cx="262" cy="220" rx="2.5" ry="9" fill="${TONE.rim}" />
        <ellipse cx="338" cy="220" rx="2.5" ry="9" fill="${TONE.rim}" />
        <g stroke="rgba(200,180,140,.18)" stroke-width="1" fill="none">
          <path d="M210,250 L160,245" />
          <path d="M210,260 L165,265" />
          <path d="M390,250 L440,245" />
          <path d="M390,260 L435,265" />
        </g>
        <path fill="rgba(0,0,0,.45)" d="M220,200 Q280,260 380,200 Q390,250 370,280 Q340,310 300,310 Q260,310 230,280 Q210,250 220,200 Z" />
      </g>

      <rect x="220" y="520" width="160" height="22" fill="#150e0c" stroke="${TONE.mid}" stroke-width="1" />
      <circle cx="300" cy="531" r="9" fill="${TONE.mid}" stroke="${TONE.hi}" stroke-width="1" />
      <circle cx="300" cy="531" r="3" fill="${TONE.rim}" />

      <g stroke="#0a0606" stroke-width="8" stroke-linecap="round" fill="none">
        <line x1="430" y1="180" x2="530" y2="720" />
      </g>
      <g stroke="${TONE.mid}" stroke-width="2" stroke-linecap="round" fill="none" opacity="0.7">
        <line x1="430" y1="180" x2="530" y2="720" />
      </g>
      <circle cx="424" cy="170" r="22" fill="url(#kkv2-hero-eye)" opacity="0.9" />
      <circle cx="424" cy="170" r="10" fill="${TONE.rim}" opacity="0.9" />
      <circle cx="424" cy="170" r="4" fill="#fff" />

      <path fill="none" stroke="url(#kkv2-hero-rim)" stroke-width="2.2" opacity="0.9"
        d="M220,200 Q210,160 240,140 L280,130 L320,130 L360,140 Q390,160 380,200" />
      <path fill="none" stroke="url(#kkv2-hero-rim)" stroke-width="2.2" opacity="0.9"
        d="M220,340 Q210,300 230,260 Q250,220 280,210" />
      <path fill="none" stroke="url(#kkv2-hero-rim)" stroke-width="2.2" opacity="0.9"
        d="M380,340 Q390,300 370,260 Q350,220 320,210" />
    </svg>
  `));

  return wrap;
}

function _buildParticles(parent) {
  const wrap = document.createElement('div');
  wrap.className = 'kkv2-particles';
  // 32 drifting motes
  for (let i = 0; i < 32; i++) {
    const left = Math.random() * 100;
    const top  = 30 + Math.random() * 60;
    const size = 1.5 + Math.random() * 3;
    const delay = Math.random() * 8;
    const dur = 6 + Math.random() * 8;
    const sway = 20 + Math.random() * 40;
    const p = document.createElement('div');
    p.className = 'kkv2-pcl';
    p.style.left = `${left}%`;
    p.style.top  = `${top}%`;
    p.style.width  = `${size}px`;
    p.style.height = `${size}px`;
    p.style.background = TONE.hi;
    p.style.boxShadow  = `0 0 ${size * 4}px ${size * 0.6}px ${TONE.glow}`;
    p.style.animationDelay    = `${delay}s`;
    p.style.animationDuration = `${dur}s`;
    p.style.setProperty('--sway', `${sway}px`);
    wrap.appendChild(p);
  }
  parent.appendChild(wrap);
}

function _buildVignetteAndGrain(parent) {
  const v = document.createElement('div');
  v.className = 'kkv2-vignette';
  parent.appendChild(v);
  const g = document.createElement('div');
  g.className = 'kkv2-grain';
  parent.appendChild(g);
}

// ─────────────────────────────────────────────────────────
// Top bar
// ─────────────────────────────────────────────────────────
function _buildTopBar(parent) {
  const header = document.createElement('header');
  header.className = 'kkv2-top';

  const lockup = document.createElement('div');
  lockup.className = 'kkv2-lockup';
  lockup.appendChild(_svg(`
    <svg class="kkv2-mark" viewBox="0 0 64 56" fill="none">
      <path d="M8,24 L4,4 L20,16 L44,16 L60,4 L56,24 Q56,46 32,52 Q8,46 8,24 Z" fill="currentColor" stroke="rgba(0,0,0,.4)" stroke-width="0.6" />
      <ellipse cx="22" cy="30" rx="2.2" ry="3.2" fill="#1a0f08" />
      <ellipse cx="42" cy="30" rx="2.2" ry="3.2" fill="#1a0f08" />
    </svg>
  `));
  const word = document.createElement('div');
  word.className = 'kkv2-wordmark';
  const wm = document.createElement('div');
  wm.className = 'kkv2-word-main';
  wm.textContent = 'KITTY KAKI';
  const ws = document.createElement('div');
  ws.className = 'kkv2-word-sub';
  ws.textContent = 'SURVIVORS';
  word.appendChild(wm);
  word.appendChild(ws);
  lockup.appendChild(word);

  const right = document.createElement('div');
  right.className = 'kkv2-top-right';

  // Account chip — uses real meta
  const meta = getMeta();
  const name = meta && meta.name ? meta.name : 'Player';
  // level proxy: prefer explicit meta.level, else derive from coins
  const level = (meta && meta.level) ? meta.level
              : (meta && meta.coins) ? Math.max(1, Math.floor(Math.sqrt(meta.coins / 10)))
              : 1;

  const acct = document.createElement('div');
  acct.className = 'kkv2-acct';
  const av = document.createElement('div');
  av.className = 'kkv2-acct-avatar';
  av.appendChild(_svg(`
    <svg viewBox="0 0 32 32">
      <circle cx="16" cy="13" r="6" fill="${TONE.mid}" />
      <path d="M4,32 Q4,20 16,20 Q28,20 28,32 Z" fill="${TONE.mid}" />
    </svg>
  `));
  const info = document.createElement('div');
  info.className = 'kkv2-acct-info';
  const an = document.createElement('div');
  an.className = 'kkv2-acct-name';
  an.textContent = name;
  const at = document.createElement('div');
  at.className = 'kkv2-acct-tag';
  at.textContent = `#KAKI · LVL ${level}`;
  info.appendChild(an);
  info.appendChild(at);
  acct.appendChild(av);
  acct.appendChild(info);

  const icons = document.createElement('div');
  icons.className = 'kkv2-icons';
  // 3 icon buttons — Settings, Inbox, Friends. Settings routes to showOptions.
  const settingsBtn = _iconBtn('⛭', 'Settings', true);
  settingsBtn.addEventListener('click', _openSettings);
  const inboxBtn = _iconBtn('✉', 'Inbox', false);
  const friendsBtn = _iconBtn('◴', 'Friends', false);
  icons.appendChild(settingsBtn);
  icons.appendChild(inboxBtn);
  icons.appendChild(friendsBtn);

  right.appendChild(acct);
  right.appendChild(icons);

  header.appendChild(lockup);
  header.appendChild(right);
  parent.appendChild(header);
}

function _iconBtn(glyph, label, withDot) {
  const b = document.createElement('button');
  b.className = 'kkv2-iconbtn';
  b.setAttribute('aria-label', label);
  b.type = 'button';
  if (withDot) {
    const d = document.createElement('span');
    d.className = 'kkv2-dot';
    b.appendChild(d);
  }
  const span = document.createElement('span');
  span.textContent = glyph;
  b.appendChild(span);
  return b;
}

// ─────────────────────────────────────────────────────────
// Side nav
// ─────────────────────────────────────────────────────────
function _buildSideNav(parent) {
  const nav = document.createElement('nav');
  nav.className = 'kkv2-nav';
  NAV_ITEMS.forEach(item => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'kkv2-navitem' + (item.id === _activeNav ? ' is-active' : '');
    btn.dataset.nav = item.id;
    btn.addEventListener('mouseenter', () => _setActive(item.id));
    btn.addEventListener('focus',      () => _setActive(item.id));
    btn.addEventListener('click', () => _dispatchNav(item.id));

    const rail = document.createElement('span');
    rail.className = 'kkv2-nav-rail';
    const glyph = document.createElement('span');
    glyph.className = 'kkv2-nav-glyph';
    glyph.textContent = item.glyph;
    const label = document.createElement('span');
    label.className = 'kkv2-nav-label';
    label.textContent = item.label;
    const kbd = document.createElement('span');
    kbd.className = 'kkv2-nav-kbd';
    kbd.textContent = item.kbd;
    btn.appendChild(rail);
    btn.appendChild(glyph);
    btn.appendChild(label);
    btn.appendChild(kbd);
    nav.appendChild(btn);
  });
  parent.appendChild(nav);
}

function _setActive(id) {
  _activeNav = id;
  if (!_stage) return;
  _stage.querySelectorAll('.kkv2-navitem').forEach(el => {
    el.classList.toggle('is-active', el.dataset.nav === id);
  });
}

function _dispatchNav(id) {
  switch (id) {
    case 'play':       _beginRun(); break;
    case 'characters': _openHeroes(); break;
    case 'arsenal':    _openArsenal(); break;
    case 'codex':      _openCodex(); break;
    case 'town':       _enterTownFromMenu(); break;
    case 'options':    _openSettings(); break;
  }
}

// ─────────────────────────────────────────────────────────
// Continue card
// ─────────────────────────────────────────────────────────
function _buildContinueCard(parent) {
  const card = document.createElement('div');
  card.className = 'kkv2-continue';

  const eyebrow = document.createElement('div');
  eyebrow.className = 'kkv2-cont-eyebrow';
  const rule = document.createElement('span');
  rule.className = 'kkv2-cont-rule';
  const eyeTxt = document.createElement('span');
  eyeTxt.textContent = 'New Run';
  eyebrow.appendChild(rule);
  eyebrow.appendChild(eyeTxt);

  // Stage + sub
  const stage = STAGES.find(s => s.id === _selectedStageId) || STAGES[0];
  const art = STAGE_ART[stage.id] || STAGE_ART.forest;
  const bio = document.createElement('div');
  bio.className = 'kkv2-cont-bio';
  const sub = document.createElement('div');
  sub.className = 'kkv2-cont-sub';
  sub.textContent = `${art.tier} · ${art.sub}`;
  const nm = document.createElement('div');
  nm.className = 'kkv2-cont-name';
  nm.textContent = stage.name;
  bio.appendChild(sub);
  bio.appendChild(nm);

  // Stats row — real meta-derived: best score, best time, total runs
  const meta = getMeta();
  const row = document.createElement('div');
  row.className = 'kkv2-cont-row';
  row.appendChild(_stat('Best', String(meta && meta.bestScore || 0)));
  row.appendChild(_stat('Time', _fmtTime((meta && meta.bestTime) || 0)));
  row.appendChild(_stat('Runs', String((meta && meta.runs) || 0)));

  // Begin Run button
  const btn = document.createElement('button');
  btn.className = 'kkv2-cont-btn';
  btn.type = 'button';
  const bg = document.createElement('span');
  bg.className = 'kkv2-cont-btn-glyph';
  bg.textContent = '▶';
  const bl = document.createElement('span');
  bl.textContent = 'Begin Run';
  const bk = document.createElement('span');
  bk.className = 'kkv2-cont-btn-kbd';
  bk.textContent = 'SPACE';
  btn.appendChild(bg);
  btn.appendChild(bl);
  btn.appendChild(bk);
  btn.addEventListener('click', _beginRun);

  card.appendChild(eyebrow);
  card.appendChild(bio);
  card.appendChild(row);
  card.appendChild(btn);

  card.dataset.role = 'continue';
  parent.appendChild(card);
}

function _stat(label, value) {
  const s = document.createElement('div');
  s.className = 'kkv2-cont-stat';
  const l = document.createElement('div');
  l.className = 'kkv2-cont-label';
  l.textContent = label;
  const v = document.createElement('div');
  v.className = 'kkv2-cont-val';
  v.textContent = value;
  s.appendChild(l);
  s.appendChild(v);
  return s;
}

function _refreshContinueCard() {
  if (!_stage) return;
  const old = _stage.querySelector('.kkv2-continue');
  if (old) old.parentNode.removeChild(old);
  _buildContinueCard(_stage);
}

// ─────────────────────────────────────────────────────────
// Chapter rail
// ─────────────────────────────────────────────────────────
function _buildChapterRail(parent) {
  const rail = document.createElement('section');
  rail.className = 'kkv2-rail';

  const head = document.createElement('div');
  head.className = 'kkv2-rail-head';

  const title = document.createElement('div');
  title.className = 'kkv2-rail-title';
  const eye = document.createElement('span');
  eye.className = 'kkv2-rail-eye';
  eye.textContent = 'Select a Chapter';
  const count = document.createElement('span');
  count.className = 'kkv2-rail-count';
  const meta = getMeta();
  const unlockedCount = STAGES.filter(s => _stageUnlocked(s, meta)).length;
  count.textContent = `${STAGES.length} chapters · ${unlockedCount} unlocked`;
  title.appendChild(eye);
  title.appendChild(count);

  const tabs = document.createElement('div');
  tabs.className = 'kkv2-rail-tabs';
  // Campaign active; other tabs visually styled but non-functional v1
  const tCampaign = _tab('Campaign', true);
  const tEndless  = _tab('Endless', false);
  const tDaily    = _tab('Daily', false);
  const tCoop     = _tab('Co-op', false, true);
  tabs.appendChild(tCampaign);
  tabs.appendChild(tEndless);
  tabs.appendChild(tDaily);
  tabs.appendChild(tCoop);

  head.appendChild(title);
  head.appendChild(tabs);
  rail.appendChild(head);

  // List of chapter cards from STAGES config
  const list = document.createElement('div');
  list.className = 'kkv2-rail-list';
  STAGES.forEach((stage, i) => {
    const art = STAGE_ART[stage.id] || STAGE_ART.forest;
    const unlocked = _stageUnlocked(stage, meta);
    const cleared = !!(meta && _stageCleared(stage, meta));
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'kkv2-chap'
      + (stage.id === _selectedStageId ? ' is-selected' : '')
      + (!unlocked ? ' is-locked' : '');
    card.dataset.stage = stage.id;

    const artBox = document.createElement('div');
    artBox.className = 'kkv2-chap-art';
    artBox.appendChild(_buildChapterArt(stage.id));
    const shade = document.createElement('div');
    shade.className = 'kkv2-chap-shade';
    artBox.appendChild(shade);
    if (!unlocked) {
      const lock = document.createElement('div');
      lock.className = 'kkv2-chap-lock';
      lock.textContent = '\u{1F512}';
      artBox.appendChild(lock);
    }
    if (cleared) {
      const cl = document.createElement('div');
      cl.className = 'kkv2-chap-cleared';
      cl.textContent = '✓ Cleared';
      artBox.appendChild(cl);
    }

    const body = document.createElement('div');
    body.className = 'kkv2-chap-body';
    const tier = document.createElement('div');
    tier.className = 'kkv2-chap-tier';
    tier.textContent = `${art.tier.toUpperCase()} · ${art.sub.toUpperCase()}`;
    const nameEl = document.createElement('div');
    nameEl.className = 'kkv2-chap-name';
    nameEl.textContent = stage.name;
    const metaRow = document.createElement('div');
    metaRow.className = 'kkv2-chap-meta';
    const diff = document.createElement('span');
    diff.className = 'kkv2-chap-diff';
    diff.textContent = art.diff;
    const sep = document.createElement('span');
    sep.className = 'kkv2-chap-sep';
    sep.textContent = '·';
    const waves = document.createElement('span');
    waves.className = 'kkv2-chap-waves';
    waves.textContent = `${art.waves} waves`;
    metaRow.appendChild(diff);
    metaRow.appendChild(sep);
    metaRow.appendChild(waves);
    body.appendChild(tier);
    body.appendChild(nameEl);
    body.appendChild(metaRow);

    card.appendChild(artBox);
    card.appendChild(body);

    if (unlocked) {
      card.addEventListener('click', () => _selectStage(stage.id));
    }
    list.appendChild(card);
  });
  rail.appendChild(list);
  parent.appendChild(rail);
}

function _tab(label, active, withDot) {
  const b = document.createElement('button');
  b.className = 'kkv2-tab' + (active ? ' is-active' : '');
  b.type = 'button';
  b.appendChild(document.createTextNode(label));
  if (withDot) {
    const d = document.createElement('span');
    d.className = 'kkv2-tab-dot';
    b.appendChild(d);
  }
  return b;
}

function _buildChapterArt(stageId) {
  // 4 stage-themed SVGs, each ~200x140 tile. Palettes match in-game stage tints.
  const templates = {
    forest: `
      <svg viewBox="0 0 200 140" preserveAspectRatio="xMidYMid slice">
        <rect width="200" height="140" fill="#0c1815" />
        <circle cx="160" cy="35" r="14" fill="#a89860" opacity="0.5" />
        <path d="M0,100 L40,80 L80,95 L120,75 L160,90 L200,80 L200,140 L0,140 Z" fill="#0a1a16" />
        <g fill="#020a08">
          <path d="M10,140 L20,80 L30,140 Z" />
          <path d="M40,140 L50,70 L60,140 Z" />
          <path d="M150,140 L160,75 L170,140 Z" />
        </g>
      </svg>`,
    twilight: `
      <svg viewBox="0 0 200 140" preserveAspectRatio="xMidYMid slice">
        <rect width="200" height="140" fill="#0a1018" />
        <circle cx="155" cy="38" r="16" fill="#6b88c0" opacity="0.5" />
        <path d="M0,108 L42,86 L84,102 L126,82 L168,98 L200,88 L200,140 L0,140 Z" fill="#06101a" />
        <g fill="#020610">
          <path d="M16,140 L26,80 L36,140 Z" />
          <path d="M64,140 L74,68 L84,140 Z" />
          <path d="M148,140 L158,76 L168,140 Z" />
        </g>
        <g fill="#9cb8ff" opacity="0.5">
          <circle cx="30" cy="20" r="1" /><circle cx="60" cy="14" r="0.8" />
          <circle cx="98" cy="22" r="1.2" /><circle cx="140" cy="10" r="0.8" />
          <circle cx="180" cy="18" r="1" />
        </g>
      </svg>`,
    cinder: `
      <svg viewBox="0 0 200 140" preserveAspectRatio="xMidYMid slice">
        <rect width="200" height="140" fill="#180a06" />
        <path d="M40,140 L40,40 Q60,20 100,20 Q140,20 160,40 L160,140 Z" fill="#0a0403" />
        <circle cx="100" cy="90" r="22" fill="#e09040" opacity="0.5" />
        <circle cx="100" cy="90" r="8" fill="#ffc080" />
        <g fill="#ff7a3a" opacity="0.55">
          <circle cx="60" cy="80" r="2" /><circle cx="140" cy="92" r="1.6" />
          <circle cx="80" cy="120" r="1.4" /><circle cx="130" cy="118" r="2.2" />
          <circle cx="48" cy="106" r="1.2" /><circle cx="156" cy="74" r="1.6" />
        </g>
      </svg>`,
    void: `
      <svg viewBox="0 0 200 140" preserveAspectRatio="xMidYMid slice">
        <rect width="200" height="140" fill="#0a0612" />
        <path d="M0,96 L200,96 L200,140 L0,140 Z" fill="#04020a" />
        <g fill="#06020e">
          <rect x="16" y="36" width="10" height="64" />
          <rect x="46" y="22" width="10" height="78" />
          <rect x="80" y="34" width="10" height="66" />
          <rect x="118" y="20" width="10" height="80" />
          <rect x="156" y="44" width="10" height="56" />
          <rect x="182" y="28" width="10" height="72" />
        </g>
        <g fill="#c87bff" opacity="0.45">
          <circle cx="50" cy="92" r="2.6" />
          <circle cx="124" cy="80" r="2" />
          <circle cx="160" cy="92" r="1.8" />
        </g>
      </svg>`,
  };
  const html = (templates[stageId] || templates.forest).trim();
  return _svg(html);
}

// Unlock predicate — mirrors the meta flag pattern used by STAGES config
function _stageUnlocked(stage, meta) {
  if (!stage.unlock) return true;
  if (!meta) return false;
  return !!meta[stage.unlock];
}

// Cleared = any per-stage best-time / first-victory flag would be ideal, but
// no canonical key exists. Heuristic: a stage is "cleared" if the next stage's
// unlock flag is set (since you unlock the next one by clearing this one).
function _stageCleared(stage, meta) {
  const idx = STAGES.findIndex(s => s.id === stage.id);
  if (idx < 0 || idx === STAGES.length - 1) return false;
  const next = STAGES[idx + 1];
  if (!next || !next.unlock) return false;
  return !!meta[next.unlock];
}

function _selectStage(stageId) {
  _selectedStageId = stageId;
  try { setOption('selectedStage', stageId); } catch (_) {}
  // Repaint selected card outlines + continue card
  if (_stage) {
    _stage.querySelectorAll('.kkv2-chap').forEach(el => {
      el.classList.toggle('is-selected', el.dataset.stage === stageId);
    });
  }
  _refreshContinueCard();
}

// ─────────────────────────────────────────────────────────
// Footer
// ─────────────────────────────────────────────────────────
function _buildFooter(parent) {
  const foot = document.createElement('footer');
  foot.className = 'kkv2-foot';

  const left = document.createElement('div');
  left.className = 'kkv2-foot-left';
  const ver = document.createElement('span');
  ver.className = 'kkv2-version';
  ver.textContent = _versionLabel();
  const sep = document.createElement('span');
  sep.className = 'kkv2-sep';
  sep.textContent = '·';
  const online = document.createElement('span');
  online.className = 'kkv2-online';
  const dot = document.createElement('span');
  dot.className = 'kkv2-online-dot';
  const ot = document.createElement('span');
  // No live player count source; show em-dash placeholder.
  const playerCount = (state && state.run && state.run.playerCount) || null;
  ot.textContent = playerCount ? `${playerCount.toLocaleString()} players online` : '— players online';
  online.appendChild(dot);
  online.appendChild(ot);
  left.appendChild(ver);
  left.appendChild(sep);
  left.appendChild(online);

  const right = document.createElement('div');
  right.className = 'kkv2-foot-right';
  right.appendChild(_key('↑↓', 'Navigate'));
  right.appendChild(_key('Enter', 'Confirm'));
  right.appendChild(_key('Tab', 'Switch panel'));
  right.appendChild(_key('Esc', 'Back'));

  foot.appendChild(left);
  foot.appendChild(right);
  parent.appendChild(foot);
}

function _key(kbdLabel, hint) {
  const w = document.createElement('span');
  w.className = 'kkv2-key';
  const k = document.createElement('kbd');
  k.textContent = kbdLabel;
  const t = document.createElement('span');
  t.textContent = hint;
  w.appendChild(k);
  w.appendChild(t);
  return w;
}

function _versionLabel() {
  // Try to read from window or a global; fall back to a static label.
  if (typeof window !== 'undefined' && window.KK_BUILD) return window.KK_BUILD;
  return 'v1.1 · menu v2';
}

function _fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────
// Action hooks
// ─────────────────────────────────────────────────────────
function _beginRun() {
  // Same entry point the legacy start screen uses.
  if (typeof window !== 'undefined' && typeof window.kkStartRun === 'function') {
    window.kkStartRun();
  }
}

function _openCodex() {
  import('./codex.js').then(m => { try { m.showCodex && m.showCodex(); } catch (_) {} }).catch(() => {});
}

function _openSettings() {
  import('./ui.js').then(m => { try { m.showOptions && m.showOptions(); } catch (_) {} }).catch(() => {});
}

function _openArsenal() {
  // "Weapons / passives tree" → Grimoire.
  import('./ui.js').then(m => { try { m.showGrimoire && m.showGrimoire(); } catch (_) {} }).catch(() => {});
}

function _enterTownFromMenu() {
  // Town hub — NPCs, casino, shop, character interactions. Calls the
  // window-exposed entry the legacy menu used. Hide the menu first so the
  // town world is visible.
  try { hideMenuV2(); } catch (_) {}
  try { if (typeof window.kkEnterTown === 'function') window.kkEnterTown(); }
  catch (e) { console.warn('[menuV2.town]', e); }
}

function _openHeroes() {
  if (_overlay) return;
  _overlay = document.createElement('div');
  _overlay.className = 'kkv2-overlay';

  const head = document.createElement('div');
  head.className = 'kkv2-overlay-head';
  const titleWrap = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'kkv2-overlay-title';
  title.textContent = 'Heroes';
  const sub = document.createElement('div');
  sub.className = 'kkv2-overlay-sub';
  sub.textContent = 'Choose the avatar that walks the Mistwood tonight.';
  titleWrap.appendChild(title);
  titleWrap.appendChild(sub);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'kkv2-overlay-close';
  closeBtn.textContent = 'ESC · Close';
  closeBtn.addEventListener('click', _closeHeroes);
  head.appendChild(titleWrap);
  head.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'kkv2-overlay-body';
  const host = document.createElement('div');
  host.className = 'kkv2-overlay-host';
  body.appendChild(host);

  _overlay.appendChild(head);
  _overlay.appendChild(body);
  _stage.appendChild(_overlay);

  _mountCarousel(host);
  // Esc closes overlay
  document.addEventListener('keydown', _heroEsc);
}

function _heroEsc(e) {
  if (e.key === 'Escape') _closeHeroes();
}

function _closeHeroes() {
  document.removeEventListener('keydown', _heroEsc);
  if (_carousel) { try { _carousel.destroy(); } catch (_) {} _carousel = null; }
  if (_overlay && _overlay.parentNode) _overlay.parentNode.removeChild(_overlay);
  _overlay = null;
}

function _mountCarousel(host) {
  // Lazy: GLTF_CACHE may not be ready yet. Try; if it errors, show placeholder.
  const meta = getMeta();
  const initialId = (meta && meta.selectedAvatar) || 'kitty';
  try {
    _carousel = createCharCarousel(host, {
      items: AVATARS,
      initialId,
      onSelect: (id) => {
        try { setOption('selectedAvatar', id); } catch (_) {}
        if (meta) meta.selectedAvatar = id;
      },
    });
  } catch (e) {
    const ph = document.createElement('div');
    ph.className = 'kkv2-overlay-placeholder';
    ph.textContent = 'Loading heroes…';
    host.appendChild(ph);
    // Retry once after a short delay (preloadAll usually wins inside ~1s)
    setTimeout(() => {
      if (!_overlay) return;
      host.innerHTML = '';
      try {
        _carousel = createCharCarousel(host, {
          items: AVATARS,
          initialId,
          onSelect: (id) => {
            try { setOption('selectedAvatar', id); } catch (_) {}
            if (meta) meta.selectedAvatar = id;
          },
        });
      } catch (e2) {
        const ph2 = document.createElement('div');
        ph2.className = 'kkv2-overlay-placeholder';
        ph2.textContent = 'Heroes unavailable in this build.';
        host.appendChild(ph2);
      }
    }, 800);
  }
}
