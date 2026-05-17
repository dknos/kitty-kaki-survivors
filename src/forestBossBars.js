/**
 * FOREST-V2-A11 Boss HP Bars (2026-05-17)
 *
 * Top-center HTML overlay that surfaces the HP of currently-active threats:
 * mini-bosses, elites, the final boss, and the 30:00 Reaper. Sits just below
 * the forestHud clock/reaper-countdown stack (HUD root: top:8px, reaper banner
 * ends ~64-70px), so our root anchors at top:80px so the two overlays never
 * overlap regardless of pulse animation.
 *
 * === Threats tracked ===
 *   enemy.isMiniBoss              → label = glbKey.toUpperCase(), amber (slot-5)
 *   enemy.isFinalBoss             → label = glbKey.toUpperCase(), bright gold (slot-7)
 *   enemy.elite (and not the      → label = glbKey.toUpperCase(), gold (slot-6)
 *      above two)
 *   enemy._isNemesis or glbKey ==
 *      '__nemesis__'              → label = 'NEMESIS', amber (treated as elite-class
 *                                    visually; spec said elite uses slot-6, but the
 *                                    Nemesis is `elite: true` in config.js:600 so it
 *                                    falls through the elite branch naturally)
 *   Reaper (no enemy obj; tracked  → label = 'REAPER', red (existing #ff2020 — same
 *      via state.run flags)         hex used by NEMESIS_TIER.glowColor + reaper tint;
 *                                    explicitly NOT a new palette constant. Per
 *                                    docs/FOREST_VISUAL_STYLE.md the forest palette
 *                                    has no red, but Reaper's tint overlay
 *                                    (forestReaper.js kk-reaper-tint) already breaks
 *                                    that rule deliberately for the "INVINCIBLE"
 *                                    danger read — we follow the same precedent.)
 *
 * === Naming decision (grep result) ===
 * Enemies have ONE string identifier field: `glbKey` (src/enemies.js:377).
 * No name / displayName / kind / enemyType / tier field exists. Per spec
 * fallback, we capitalize the glbKey (e.g. "giant" → "GIANT", "mantis" →
 * "MANTIS"). Color already encodes tier, so a redundant "(MINIBOSS)" suffix
 * is omitted. Nemesis sentinel ('__nemesis__') is hard-mapped to 'NEMESIS'.
 *
 * === Reaper tracking decision ===
 * forestReaper.js exports no mesh getter. We synthesise a virtual target
 * from the per-run flags it already publishes:
 *   alive ⇔ state.run._reaperSpawned === true
 *           && state.run._reaperOutlastedFired !== true
 *           && state.gameOver !== true
 * No HP is shown (Reaper is invincible by design) — bar background only,
 * label rendered red, the "fill" portion stays empty.
 *
 * === Priority + cap ===
 * Max 3 rows visible at once. Sort (most-threatening first):
 *   1. Reaper           (synthetic; never has a row prior to spawn)
 *   2. Final boss       (isFinalBoss)
 *   3. Mini-boss        (isMiniBoss)
 *   4. Elite            (elite && !isMiniBoss && !isFinalBoss)
 * Within the same tier, insertion order wins (matches state.enemies.active
 * iteration order — stable and natural for the player).
 *
 * === Row lifecycle ===
 *   ALIVE        — every tick: lerp _displayRatio toward target ratio with
 *                  k = 1 - exp(-dt*8) for a smooth ~125ms ease. Update HP
 *                  text only when the integer floor changes.
 *   DYING        — set when target.hp <= 0 OR enemy spliced from
 *                  state.enemies.active (death detected by `alive === false`
 *                  or by indexOf check after each tick). Row persists 1.5s,
 *                  applies the `kk-bb-flash` keyframe (white pulse) and
 *                  opacity fade. After 1.5s, freed and hidden.
 *   FREE         — row.display='none'; ready for re-use by next active target.
 *
 * === DOM strategy ===
 * Pre-allocate exactly 3 row divs at load time (3 = max visible). Show/hide
 * via style.display rather than create/destroy. Each row caches its last
 * displayed text + ratio so the per-frame work in the common case is just
 * a few number comparisons + maybe a textContent and a style.width write.
 *
 * === Palette lock ===
 *   slot-5 amber (#e89c4a) — mini-boss fill
 *   slot-6 gold  (#d9a648) — elite fill
 *   slot-7 cream (#ffd86b) — final-boss fill (same constant as forestReaper
 *                            banner color; already in repo)
 *   #ff2020              — Reaper label red (matches NEMESIS_TIER.glowColor
 *                            + forestReaper tint; not a new constant)
 *   #1a1814              — bar track (dark slot-0); already used by repo bgs
 *
 * === z-index ===
 * z-index: 65 — sits just under the HUD (z-index 70 from forestHud.js header)
 * so any HUD overlap (pause modal etc.) layers correctly.
 *
 * === Lifecycle ===
 *   loadForestBossBars(scene, state) — idempotent. Builds CSS + root + 3 rows.
 *                                      Gated upstream by state._bossBarsLoaded.
 *   tickForestBossBars(state, dt)    — per-frame. Collects active targets,
 *                                      sorts + caps, lerps fills, updates rows.
 *   disposeForestBossBars()          — removes root + style by id. Idempotent.
 *
 * NB: This module owns ONLY DOM. The scene parameter is accepted to mirror
 * the loadFoo(scene, state) sibling-loader convention but is never used.
 */

// ── Palette (existing constants — see header) ──────────────────────────────
const SLOT5_AMBER_CSS = '#e89c4a'; // mini-boss
const SLOT6_GOLD_CSS  = '#d9a648'; // elite
const SLOT7_CREAM_CSS = '#ffd86b'; // final boss (matches forestReaper banner)
const REAPER_RED_CSS  = '#ff2020'; // Reaper label (matches NEMESIS glow + tint)
const TRACK_CSS       = '#1a1814'; // dark track
const TRACK_BORDER    = 'rgba(0,0,0,0.85)';

// ── Tunables ───────────────────────────────────────────────────────────────
const MAX_ROWS        = 3;
const ROW_WIDTH_PX    = 360;
const BAR_HEIGHT_PX   = 14;
const NAME_FONT_PX    = 12;
const HP_FONT_PX      = 12;
const DEATH_FLASH_SEC = 1.5;
const FILL_LERP_K     = 8; // 1 - exp(-dt*K); ~125ms time-constant

// ── DOM ids ────────────────────────────────────────────────────────────────
const ROOT_ID  = 'kk-forest-bossbars';
const STYLE_ID = 'kk-forest-bossbars-style';
const ROW_CLS  = 'kk-bb-row';

// ── Module state ───────────────────────────────────────────────────────────
let _root    = null;
let _styleEl = null;
/** @type {Array<{
 *   el: HTMLDivElement,
 *   nameEl: HTMLDivElement,
 *   trackEl: HTMLDivElement,
 *   fillEl: HTMLDivElement,
 *   hpEl: HTMLDivElement,
 *   target: any,           // enemy ref OR the string 'reaper' sentinel
 *   displayRatio: number,  // lerped 0..1
 *   dying: boolean,
 *   dyingAt: number,       // state.time.real timestamp
 *   lastName: string,
 *   lastHp: string,
 *   lastTier: string,      // 'mini'|'elite'|'final'|'reaper'
 *   lastWidthPct: number,
 *   lastOpacity: number,
 * }>}
 */
const _rows = [];
let _lastVisible = true;

// Reusable scratch — keyed by tier rank for priority sort (lower = more
// important / drawn first).
const TIER_REAPER = 0;
const TIER_FINAL  = 1;
const TIER_MINI   = 2;
const TIER_ELITE  = 3;

// Scratch buffer reused across ticks (avoid per-frame allocation).
const _scratch = [];

// ─────────────────────────────────────────────────────────────────────────────
// CSS + DOM bootstrap
// ─────────────────────────────────────────────────────────────────────────────
function _ensureStyle() {
  if (_styleEl && document.getElementById(STYLE_ID)) return;
  if (document.getElementById(STYLE_ID)) {
    _styleEl = document.getElementById(STYLE_ID);
    return;
  }
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = [
    '#' + ROOT_ID + ' {',
    '  position: fixed; top: 80px; left: 50%;',
    '  transform: translateX(-50%);',
    '  pointer-events: none; z-index: 65;',
    '  display: flex; flex-direction: column; gap: 4px;',
    '  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;',
    '  -webkit-font-smoothing: antialiased;',
    '  user-select: none;',
    '}',
    '#' + ROOT_ID + ' .' + ROW_CLS + ' {',
    '  display: none;',                    // hidden until claimed by a target
    '  width: ' + ROW_WIDTH_PX + 'px;',
    '  align-items: center;',
    '  gap: 8px;',
    '  padding: 2px 6px;',
    '  background: rgba(0,0,0,0.42);',
    '  border: 1px solid ' + TRACK_BORDER + ';',
    '  box-sizing: border-box;',
    '  opacity: 1;',
    '}',
    '#' + ROOT_ID + ' .' + ROW_CLS + '.kk-bb-show {',
    '  display: flex;',
    '}',
    '#' + ROOT_ID + ' .kk-bb-name {',
    '  flex: 0 0 96px;',
    '  font-size: ' + NAME_FONT_PX + 'px; font-weight: 700;',
    '  letter-spacing: 0.10em; text-transform: uppercase;',
    '  color: #c7b89a;',                   // slot-1 bone — same as HUD counters
    '  text-shadow: 0 0 4px rgba(0,0,0,0.85), 0 1px 2px rgba(0,0,0,0.7);',
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;',
    '}',
    '#' + ROOT_ID + ' .kk-bb-name.kk-bb-name-reaper {',
    '  color: ' + REAPER_RED_CSS + ';',
    '}',
    '#' + ROOT_ID + ' .kk-bb-track {',
    '  flex: 1 1 auto;',
    '  position: relative;',
    '  height: ' + BAR_HEIGHT_PX + 'px;',
    '  background: ' + TRACK_CSS + ';',
    '  border: 1px solid ' + TRACK_BORDER + ';',
    '  overflow: hidden;',
    '  box-sizing: border-box;',
    '}',
    '#' + ROOT_ID + ' .kk-bb-fill {',
    '  position: absolute; left: 0; top: 0; bottom: 0;',
    '  width: 0%;',
    '  background: ' + SLOT5_AMBER_CSS + ';',
    '  transition: none;',
    '}',
    '#' + ROOT_ID + ' .kk-bb-hp {',
    '  flex: 0 0 90px;',
    '  font-size: ' + HP_FONT_PX + 'px; font-weight: 700;',
    '  letter-spacing: 0.06em;',
    '  color: #c7b89a;',
    '  text-shadow: 0 0 4px rgba(0,0,0,0.85), 0 1px 2px rgba(0,0,0,0.7);',
    '  text-align: right; white-space: nowrap;',
    '}',
    '#' + ROOT_ID + ' .' + ROW_CLS + '.kk-bb-dying {',
    '  animation: kk-bb-flash 0.25s ease-in-out 0s 6 alternate;',
    '}',
    '@keyframes kk-bb-flash {',
    '  0%   { filter: brightness(1.0); }',
    '  100% { filter: brightness(2.0) saturate(1.4); }',
    '}',
  ].join('\n');
  document.head.appendChild(s);
  _styleEl = s;
}

function _ensureRoot() {
  const existing = document.getElementById(ROOT_ID);
  if (existing) {
    _root = existing;
    // Re-adopt rows if dispose missed (defensive) — but the safer path is to
    // wipe and rebuild so our cached refs stay consistent.
    if (existing.parentNode) existing.parentNode.removeChild(existing);
    _root = null;
  }
  const root = document.createElement('div');
  root.id = ROOT_ID;
  _root = root;

  _rows.length = 0;
  for (let i = 0; i < MAX_ROWS; i++) {
    const row = document.createElement('div');
    row.className = ROW_CLS;

    const nameEl = document.createElement('div');
    nameEl.className = 'kk-bb-name';
    nameEl.textContent = '';

    const trackEl = document.createElement('div');
    trackEl.className = 'kk-bb-track';

    const fillEl = document.createElement('div');
    fillEl.className = 'kk-bb-fill';
    trackEl.appendChild(fillEl);

    const hpEl = document.createElement('div');
    hpEl.className = 'kk-bb-hp';
    hpEl.textContent = '';

    row.appendChild(nameEl);
    row.appendChild(trackEl);
    row.appendChild(hpEl);
    root.appendChild(row);

    _rows.push({
      el: row,
      nameEl,
      trackEl,
      fillEl,
      hpEl,
      target: null,
      displayRatio: 0,
      dying: false,
      dyingAt: 0,
      lastName: '',
      lastHp: '',
      lastTier: '',
      lastWidthPct: -1,
      lastOpacity: 1,
    });
  }
  document.body.appendChild(root);
  _lastVisible = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Target classification
// ─────────────────────────────────────────────────────────────────────────────
function _tierOf(enemy) {
  if (!enemy) return -1;
  if (enemy.isFinalBoss) return TIER_FINAL;
  if (enemy.isMiniBoss)  return TIER_MINI;
  if (enemy.elite)       return TIER_ELITE;
  return -1;
}

function _fillColorForTier(tier) {
  if (tier === TIER_FINAL) return SLOT7_CREAM_CSS;
  if (tier === TIER_MINI)  return SLOT5_AMBER_CSS;
  if (tier === TIER_ELITE) return SLOT6_GOLD_CSS;
  return SLOT5_AMBER_CSS; // Reaper has empty fill, color irrelevant
}

function _tierKey(tier) {
  if (tier === TIER_REAPER) return 'reaper';
  if (tier === TIER_FINAL)  return 'final';
  if (tier === TIER_MINI)   return 'mini';
  return 'elite';
}

function _nameForEnemy(enemy) {
  // Spec fallback: glbKey is the only string identifier in the enemy record
  // (see header). Hard-map the procedural Nemesis sentinel; everything else
  // gets ALL-CAPS glbKey.
  if (!enemy) return '';
  const k = enemy.glbKey;
  if (k === '__nemesis__' || enemy._isNemesis) return 'NEMESIS';
  if (typeof k === 'string' && k.length > 0) return k.toUpperCase();
  // Last-resort labels by tier — keeps the bar useful even if the enemy
  // skipped glbKey for some bespoke spawn path.
  if (enemy.isFinalBoss) return 'FINAL BOSS';
  if (enemy.isMiniBoss)  return 'MINIBOSS';
  if (enemy.elite)       return 'ELITE';
  return '???';
}

function _reaperAlive(state) {
  if (!state || !state.run) return false;
  if (state.gameOver === true) return false;
  if (state.run._reaperSpawned !== true) return false;
  if (state.run._reaperOutlastedFired === true) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Row management
// ─────────────────────────────────────────────────────────────────────────────
function _findRowFor(target) {
  for (let i = 0; i < _rows.length; i++) {
    if (_rows[i].target === target) return _rows[i];
  }
  return null;
}

function _firstFreeRow() {
  for (let i = 0; i < _rows.length; i++) {
    if (!_rows[i].target) return _rows[i];
  }
  return null;
}

function _releaseRow(row) {
  row.target = null;
  row.dying = false;
  row.dyingAt = 0;
  row.displayRatio = 0;
  if (row.lastWidthPct !== 0) {
    row.fillEl.style.width = '0%';
    row.lastWidthPct = 0;
  }
  if (row.lastOpacity !== 1) {
    row.el.style.opacity = '1';
    row.lastOpacity = 1;
  }
  row.el.classList.remove('kk-bb-show');
  row.el.classList.remove('kk-bb-dying');
}

function _applyTierStyling(row, tier) {
  const key = _tierKey(tier);
  if (row.lastTier === key) return;
  row.lastTier = key;
  // Fill color
  const color = _fillColorForTier(tier);
  row.fillEl.style.background = color;
  // Name color — Reaper goes red, everything else stays bone (default class).
  if (tier === TIER_REAPER) {
    row.nameEl.classList.add('kk-bb-name-reaper');
  } else {
    row.nameEl.classList.remove('kk-bb-name-reaper');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Visibility / target collection
// ─────────────────────────────────────────────────────────────────────────────
function _shouldShow(state) {
  if (!state) return false;
  if (state.started !== true) return false;
  if (state.gameOver === true) return false;
  if (!state.run || !state.run.stage || state.run.stage.id !== 'forest') return false;
  return true;
}

function _collectTargets(state) {
  _scratch.length = 0;
  // Reaper first (synthetic).
  if (_reaperAlive(state)) {
    _scratch.push({ tier: TIER_REAPER, enemy: null });
  }
  // Real enemies — single pass.
  const arr = (state.enemies && state.enemies.active) ? state.enemies.active : null;
  if (arr) {
    for (let i = 0; i < arr.length; i++) {
      const e = arr[i];
      if (!e || e.alive === false) continue;
      const tier = _tierOf(e);
      if (tier < 0) continue;
      // Map enemy tier (TIER_MINI/FINAL/ELITE) into the sort tier directly.
      _scratch.push({ tier, enemy: e });
    }
  }
  // Stable sort by tier ascending (lower tier rank = higher priority).
  // Array.sort is in-place; for tiny N (typically 1-5) this is negligible.
  _scratch.sort(_tierCmp);
  return _scratch;
}

function _tierCmp(a, b) {
  return a.tier - b.tier;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────
export function loadForestBossBars(_scene, _state) {
  _ensureStyle();
  _ensureRoot();
}

export function tickForestBossBars(state, dt) {
  if (!_root) return;

  const show = _shouldShow(state);
  if (show !== _lastVisible) {
    _root.style.visibility = show ? 'visible' : 'hidden';
    _lastVisible = show;
  }
  if (!show) {
    // Free any active rows so a stage swap doesn't leave stale bars.
    for (let i = 0; i < _rows.length; i++) {
      if (_rows[i].target) _releaseRow(_rows[i]);
    }
    return;
  }

  const now = (state.time && typeof state.time.real === 'number') ? state.time.real : 0;
  const targets = _collectTargets(state);

  // Cap at MAX_ROWS — drop the lowest-priority overflow (already at the tail
  // after sort).
  const desiredN = Math.min(targets.length, MAX_ROWS);

  // ── 1. Reconcile dying / freed rows ───────────────────────────────────
  // For each row currently holding a target: detect death (enemy.alive=false,
  // hp<=0, spliced from state.enemies.active, or — for the Reaper sentinel —
  // _reaperAlive flipped false). Mark dying if not already; free after 1.5s.
  const activeArr = (state.enemies && state.enemies.active) ? state.enemies.active : null;
  for (let i = 0; i < _rows.length; i++) {
    const row = _rows[i];
    if (!row.target) continue;

    let dead = false;
    if (row.target === 'reaper') {
      // Sentinel — query the synthetic predicate.
      dead = !_reaperAlive(state);
    } else {
      const e = row.target;
      if (!e || e.alive === false || (typeof e.hp === 'number' && e.hp <= 0)) {
        dead = true;
      } else if (activeArr && activeArr.indexOf(e) < 0) {
        // Spliced out of the active array (despawn or fully removed).
        dead = true;
      }
    }

    if (dead && !row.dying) {
      row.dying = true;
      row.dyingAt = now;
      row.el.classList.add('kk-bb-dying');
    }
    if (row.dying && (now - row.dyingAt) >= DEATH_FLASH_SEC) {
      _releaseRow(row);
    }
  }

  // ── 2. Claim rows for active (non-dying-already-rowed) targets ────────
  // Build a quick "already-rowed" set without allocating: scan rows[].
  for (let ti = 0; ti < desiredN; ti++) {
    const tgt = targets[ti];
    const targetKey = (tgt.tier === TIER_REAPER) ? 'reaper' : tgt.enemy;
    const existing = _findRowFor(targetKey);
    if (existing) continue;
    const row = _firstFreeRow();
    if (!row) break; // saturated; lower-priority targets get no bar this frame
    row.target = targetKey;
    row.dying = false;
    row.dyingAt = 0;
    row.displayRatio = (tgt.tier === TIER_REAPER) ? 0 : _ratioFor(tgt.enemy);
    row.lastWidthPct = -1; // force first paint
    row.lastName = '';
    row.lastHp = '';
    row.lastTier = '';     // force tier reapply
    row.lastOpacity = 1;
    row.el.style.opacity = '1';
    row.el.classList.add('kk-bb-show');
    row.el.classList.remove('kk-bb-dying');
    _applyTierStyling(row, tgt.tier);
  }

  // ── 3. Per-row per-frame update ───────────────────────────────────────
  // Lerp fill toward target ratio; update text only on change. Death-flash
  // opacity is driven here (linear fade across 1.5s).
  const kLerp = 1 - Math.exp(-Math.max(0, dt) * FILL_LERP_K);
  for (let i = 0; i < _rows.length; i++) {
    const row = _rows[i];
    if (!row.target) continue;

    const isReaper = (row.target === 'reaper');
    const tier = isReaper ? TIER_REAPER : _tierOf(row.target);

    // Re-apply tier styling defensively — e.g. a mini-boss being promoted
    // to elite mid-fight (unlikely but cheap to guard).
    _applyTierStyling(row, tier);

    // Name
    const name = isReaper ? 'REAPER' : _nameForEnemy(row.target);
    if (name !== row.lastName) {
      row.nameEl.textContent = name;
      row.lastName = name;
    }

    // HP text + bar width
    if (isReaper) {
      // Empty fill, "INVINCIBLE" label on the right.
      const hpText = 'INVINCIBLE';
      if (hpText !== row.lastHp) {
        row.hpEl.textContent = hpText;
        row.hpEl.style.color = REAPER_RED_CSS;
        row.lastHp = hpText;
      }
      const widthPct = 0;
      if (widthPct !== row.lastWidthPct) {
        row.fillEl.style.width = '0%';
        row.lastWidthPct = widthPct;
      }
    } else {
      const e = row.target;
      const ratioTarget = row.dying ? 0 : _ratioFor(e);
      // Lerp toward target; on dying we still ease down so the bar drains.
      row.displayRatio += (ratioTarget - row.displayRatio) * kLerp;
      const pct = Math.max(0, Math.min(100, row.displayRatio * 100));
      // Quantise to 0.5% so we don't churn the layout every frame on tiny
      // float drift. (Math.round * 2 / 2 → nearest 0.5)
      const pctRounded = Math.round(pct * 2) * 0.5;
      if (pctRounded !== row.lastWidthPct) {
        row.fillEl.style.width = pctRounded + '%';
        row.lastWidthPct = pctRounded;
      }
      // HP numeric — show floored integers; suppress when dying past 0.
      const hpNow = Math.max(0, Math.floor(e.hp));
      const hpMax = Math.max(0, Math.floor(e.hpMax || 0));
      const hpText = hpNow + ' / ' + hpMax;
      if (hpText !== row.lastHp) {
        row.hpEl.textContent = hpText;
        // Color stays bone — only Reaper deviates.
        row.lastHp = hpText;
      }
    }

    // Death-flash fade — keyframe handles brightness pulses; we drive a
    // linear opacity drop to 0 across the 1.5s so the row visibly leaves
    // even on cards where filter:brightness fails.
    if (row.dying) {
      const k = Math.max(0, Math.min(1, (now - row.dyingAt) / DEATH_FLASH_SEC));
      const op = 1 - k;
      // Quantise to 0.05 so we don't write opacity every frame.
      const opQ = Math.round(op * 20) / 20;
      if (opQ !== row.lastOpacity) {
        row.el.style.opacity = String(opQ);
        row.lastOpacity = opQ;
      }
    }
  }
}

function _ratioFor(enemy) {
  if (!enemy) return 0;
  const max = (typeof enemy.hpMax === 'number' && enemy.hpMax > 0) ? enemy.hpMax : 1;
  const hp  = (typeof enemy.hp    === 'number') ? enemy.hp : 0;
  return Math.max(0, Math.min(1, hp / max));
}

export function disposeForestBossBars() {
  const root = document.getElementById(ROOT_ID);
  if (root && root.parentNode) root.parentNode.removeChild(root);
  const style = document.getElementById(STYLE_ID);
  if (style && style.parentNode) style.parentNode.removeChild(style);
  _root = null;
  _styleEl = null;
  _rows.length = 0;
  _scratch.length = 0;
  _lastVisible = true;
}
