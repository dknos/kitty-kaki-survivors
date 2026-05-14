/**
 * First-run guided tutorial. Six soft stages that introduce the core loop
 * without dropping the player into a wall of text. Skippable any time.
 *
 * Stage flow:
 *   1. Movement (pauses the game until the player has moved >5 units)
 *   2. Combat awareness (auto-advances after 3 kills)
 *   3. XP / level-up (auto-advances on first level-up)
 *   4. Evolution hint + weapon-panel highlight (auto-advances after 20s)
 *   5. Survival timer (shown at the 3-min mark, advances after 20s)
 *   6. Town / shop hint at run end — flips meta.tutorialDone = true
 *
 * State lives in this module (not state.js) since it's transient UI state.
 * It survives pause/menu but is reset by initTutorial() whenever the player
 * returns to town mid-run.
 */

import { state } from './state.js';
import { getMeta, saveMeta } from './meta.js';

const DEFAULTS = {
  active: false,
  stage: 0,
  movedDistance: 0,
  kills: 0,
  lastHeroX: 0,
  lastHeroZ: 0,
  stageStartTime: 0,    // real-time the current card was shown
  seenEnemy: false,
  card: /** @type {HTMLDivElement|null} */ (null),
  weaponGlow: /** @type {HTMLElement|null} */ (null),
};

const T = { ...DEFAULTS };

const Z_INDEX = 78;     // above HUD (60s) and most overlays, below modals (80+)

function _removeCard() {
  if (T.card && T.card.parentNode) T.card.parentNode.removeChild(T.card);
  T.card = null;
}

function _clearWeaponGlow() {
  if (T.weaponGlow) {
    T.weaponGlow.style.boxShadow = T.weaponGlow.dataset._kkPrevShadow || '';
    delete T.weaponGlow.dataset._kkPrevShadow;
    T.weaponGlow = null;
  }
}

function _markDone() {
  const meta = getMeta();
  meta.tutorialDone = true;
  meta.seenTutorial = true;        // keep the legacy flag aligned
  saveMeta();
}

function _endTutorial() {
  T.active = false;
  _removeCard();
  _clearWeaponGlow();
  // If gameplay was paused for stage 1, release it.
  if (state.time && state.time.paused && T._didPause) {
    state.time.paused = false;
  }
  T._didPause = false;
}

function _showCard({ title, body, pauseGame = false, highlightWeapons = false }) {
  _removeCard();
  const div = document.createElement('div');
  div.id = 'kk-tutorial-card';
  div.style.cssText = `
    position: fixed; left: 50%; top: 50%;
    transform: translate(-50%, -50%);
    width: 360px; padding: 22px 26px 18px 26px;
    background: rgba(8,12,14,0.92);
    border: 1px solid rgba(120,220,200,0.55);
    border-radius: 10px;
    box-shadow: 0 0 24px rgba(68,255,204,0.35), inset 0 1px 0 rgba(255,255,255,0.07);
    color: #e9f6ef; font-family: 'Inter', sans-serif;
    z-index: ${Z_INDEX}; pointer-events: none;
    opacity: 0; transition: opacity 0.28s ease;
    text-align: center;
  `;
  const titleHtml = title
    ? `<div style="font-family:'Cinzel Decorative',serif;font-size:14px;letter-spacing:0.32em;color:#7fffe4;text-transform:uppercase;margin-bottom:10px;">${title}</div>`
    : '';
  div.innerHTML = `
    ${titleHtml}
    <div style="font-size:14px;line-height:1.55;letter-spacing:0.04em;color:#dfeae3;">
      ${body}
    </div>
    <div style="margin-top:14px;font-size:10px;letter-spacing:0.22em;opacity:0.55;text-transform:uppercase;">
      Stage ${T.stage} / 6
    </div>
  `;
  document.body.appendChild(div);
  requestAnimationFrame(() => { div.style.opacity = '1'; });
  T.card = div;

  // Stage 1 pauses, stages 2-6 do not.
  T._didPause = false;
  if (pauseGame && state.time) {
    state.time.paused = true;
    T._didPause = true;
  } else if (state.time && state.time.paused && !pauseGame) {
    // Coming from stage 1 → resume.
    state.time.paused = false;
  }

  if (highlightWeapons) {
    // Try common weapon-panel selectors; fall back gracefully if none found.
    const panel =
      document.querySelector('#kk-weapons') ||
      document.querySelector('#kk-weapon-panel') ||
      document.querySelector('[data-kk="weapons"]') ||
      document.querySelector('#kk-hud-weapons');
    if (panel) {
      T.weaponGlow = panel;
      panel.dataset._kkPrevShadow = panel.style.boxShadow || '';
      panel.style.boxShadow = '0 0 0 2px rgba(255,210,74,0.9), 0 0 18px rgba(255,210,74,0.7)';
    }
  } else {
    _clearWeaponGlow();
  }

  T.stageStartTime = (state.time && state.time.real) || 0;
}

function _gotoStage(n) {
  T.stage = n;
  switch (n) {
    case 1:
      _showCard({
        title: 'Step One',
        body: `<div style="font-size:30px;letter-spacing:0.6em;margin-bottom:8px;">
          <span style="display:inline-block;animation:kkArrowPulse 0.9s infinite alternate;">↑</span>
          <span style="display:inline-block;animation:kkArrowPulse 0.9s infinite alternate;animation-delay:0.15s;">←</span>
          <span style="display:inline-block;animation:kkArrowPulse 0.9s infinite alternate;animation-delay:0.3s;">↓</span>
          <span style="display:inline-block;animation:kkArrowPulse 0.9s infinite alternate;animation-delay:0.45s;">→</span>
        </div>
        Move with <b>WASD</b> or the left stick.`,
        pauseGame: false,
      });
      _ensureArrowKeyframes();
      break;
    case 2:
      _showCard({
        title: 'Step Two',
        body: `Stay alive — enemies chase you.<br/>You <b>auto-attack</b> on your own.`,
      });
      break;
    case 3:
      _showCard({
        title: 'Step Three',
        body: `Pick up <b style="color:#7fffe4;">gems</b> → level up → choose an upgrade.`,
      });
      break;
    case 4:
      _showCard({
        title: 'Step Four',
        body: `Combine <b>6 of a weapon</b> to evolve it.<br/>Watch the synergy list.`,
        highlightWeapons: true,
      });
      break;
    case 5:
      _showCard({
        title: 'Step Five',
        body: `Survive the timer.<br/>A <b style="color:#ff7a7a;">boss</b> arrives at 10 minutes.`,
      });
      break;
    case 6:
      _showCard({
        title: 'Last Tip',
        body: `Spend <b style="color:#ffd24a;">coins</b> in the shop between runs.<br/>Try a different character.`,
      });
      _markDone();
      // Stage 6 auto-dismisses after a short read.
      setTimeout(() => {
        if (T.stage === 6) _endTutorial();
      }, 8000);
      break;
    default:
      _endTutorial();
  }
}

let _arrowCssInjected = false;
function _ensureArrowKeyframes() {
  if (_arrowCssInjected) return;
  _arrowCssInjected = true;
  const s = document.createElement('style');
  s.textContent = `@keyframes kkArrowPulse { from { opacity: 0.35; transform: translateY(0); } to { opacity: 1; transform: translateY(-3px); } }`;
  document.head.appendChild(s);
}

/**
 * Start the tutorial flow for a fresh run. No-op if the player has already
 * completed it. Must be called at run start (after resetState) so that the
 * "first time they start a run" trigger lines up.
 */
export function initTutorial() {
  // Reset transient state regardless — covers the "back to town mid-run" case.
  Object.assign(T, DEFAULTS);
  _removeCard();
  _clearWeaponGlow();
  // Defensive: clean up any orphan skip button from older builds.
  const orphan = document.getElementById('kk-tutorial-skip');
  if (orphan && orphan.parentNode) orphan.parentNode.removeChild(orphan);

  const meta = getMeta();
  if (meta.tutorialDone) {
    T.active = false;
    return;
  }
  T.active = true;
  T.lastHeroX = state.hero && state.hero.pos ? state.hero.pos.x : 0;
  T.lastHeroZ = state.hero && state.hero.pos ? state.hero.pos.z : 0;
  // Show stage 1 immediately on run start (Vampire-Survivors-ish gentle intro).
  _gotoStage(1);
}

/**
 * Per-frame tick. Wired in main.js inside the run-mode logic phase.
 * Watches hero movement (for stage 1 auto-advance), the world for first
 * visible enemy (stage 2 reveal), and the timed advances for stages 4 & 5.
 */
export function tickTutorial(s, dt) {
  if (!T.active) return;

  const hero = s.hero;
  if (hero && hero.pos) {
    const dx = hero.pos.x - T.lastHeroX;
    const dz = hero.pos.z - T.lastHeroZ;
    const d = Math.sqrt(dx * dx + dz * dz);
    // Filter out teleports / scene swaps (>50 units in one frame = not real movement)
    if (d > 0 && d < 50) T.movedDistance += d;
    T.lastHeroX = hero.pos.x;
    T.lastHeroZ = hero.pos.z;
  }

  switch (T.stage) {
    case 1:
      if (T.movedDistance > 5) {
        // Hand-off to stage 2 when first enemy is on the field; otherwise wait.
        if (s.enemies && s.enemies.active && s.enemies.active.some(e => e && e.alive && e.mesh && e.mesh.visible)) {
          _gotoStage(2);
        } else {
          // Brief idle card — let stage 2 trigger as soon as one shows up.
          _removeCard();
          T.stage = 1.5;
        }
      }
      break;
    case 1.5:
      if (s.enemies && s.enemies.active && s.enemies.active.some(e => e && e.alive && e.mesh && e.mesh.visible)) {
        _gotoStage(2);
      }
      break;
    case 4: {
      // Auto-advance after a 20s read so the player gets back to playing.
      const now = (s.time && s.time.real) || 0;
      if (now - T.stageStartTime > 20) {
        // Only jump to stage 5 once the 3-min timer hits — otherwise wait silently.
        _removeCard();
        _clearWeaponGlow();
        T.stage = 4.5;
      }
      break;
    }
    case 4.5:
      if (s.time && s.time.game >= 180) _gotoStage(5);
      break;
    case 5: {
      const now = (s.time && s.time.real) || 0;
      if (now - T.stageStartTime > 20) {
        // Stage 6 fires on run end — go quiet until then.
        _removeCard();
        T.stage = 5.5;
      }
      break;
    }
  }

  // Stage 5 trigger fallback: if we're somewhere in 2-3 territory and the
  // game timer hits 3:00, surface stage 5 over whatever's currently up.
  if (T.stage >= 2 && T.stage < 5 && s.time && s.time.game >= 180) {
    _gotoStage(5);
  }
}

/**
 * External event hook. Called from gameplay code at the moment of the event.
 * Known events: 'enemyKill', 'gemPickup', 'levelUp', 'runEnd', 'movedDistance'.
 */
export function notifyTutorialEvent(eventName, payload) {
  if (!T.active && eventName !== 'runEnd') return;
  switch (eventName) {
    case 'enemyKill':
      if (T.stage === 2) {
        T.kills += 1;
        if (T.kills >= 3) _gotoStage(3);
      }
      break;
    case 'gemPickup':
      // Stage 3's card mentions gems, but we don't advance off the pickup —
      // we wait for the actual level-up below. This keeps the player from
      // overshooting the lesson on the same frame as the message.
      break;
    case 'levelUp':
      if (T.stage === 3 && (state.hero ? state.hero.level >= 2 : true)) {
        _gotoStage(4);
      }
      break;
    case 'runEnd':
      // Only show stage 6 if the player hasn't already passed it.
      if (T.active && T.stage < 6) {
        _gotoStage(6);
      } else if (!getMeta().tutorialDone) {
        _markDone();
      }
      break;
    case 'movedDistance':
      if (payload && typeof payload.distance === 'number') {
        T.movedDistance += payload.distance;
      }
      break;
  }
}
