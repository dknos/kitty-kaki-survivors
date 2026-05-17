/**
 * Boss intro cinematic — PHASE 1 P1E (2026-05-17).
 *
 * 1.5s camera dolly + name banner when the FIRST miniboss / elite / room-boss /
 * Reaper of a run spawns. One-shot PER TIER per run (state.run._cinematicSeen).
 *
 * ── Trigger sources ────────────────────────────────────────────────────────
 *   • miniboss : end of enemies.spawnEnemy() — tier param 'miniboss' if
 *                enemy.isMiniBoss === true.
 *   • elite    : same site — tier 'elite' if enemy.elite && !isMiniBoss.
 *   • roomboss : enemies.spawnEnemy() runs BEFORE forestSealedDoors stamps
 *                enemy._isRoomBoss = true. So the spawn-site trigger cannot
 *                see roomboss state. Instead, tickBossIntroCinematic scans
 *                state.enemies.active each frame for an enemy with
 *                _isRoomBoss === true && !_cinematicSeen.roomboss. First hit
 *                fires the cinematic. The scan early-outs once
 *                _cinematicSeen.roomboss flips true.
 *   • reaper   : forestReaper.js calls triggerBossIntro(reaperMesh, 'reaper')
 *                right after state.run._reaperSpawned flips true.
 *
 * ── Camera control ─────────────────────────────────────────────────────────
 * Orthographic camera (state.camera) — no FOV, use camera.zoom for punch-in.
 * Tick is called AFTER the per-frame hero-follow lerp + updateProjectionMatrix
 * (main.js line ~2035), so writes to camera.position + camera.zoom +
 * updateProjectionMatrix() OVERRIDE the follow each frame. No edit to the
 * hero-follow lerp itself is needed.
 *
 *   T=0.0-0.3s : ease-in. Camera lerps from current hero-follow pos to a
 *                "behind-boss-shoulder" anchor: bossPos + (0, +6, +12) — the
 *                ortho-iso analog of "behind shoulder + slight high angle".
 *                camera.zoom slides 1.0 -> 1.15 (subtle punch-in; the spec
 *                says "FOV from default to default-5", which on an ortho rig
 *                means "zoom in slightly").
 *   T=0.3-1.2s : hold at boss-shoulder. Banner shown.
 *   T=1.2-1.5s : ease-out. Camera lerps back to hero pos + restored zoom.
 *                Banner fades.
 *
 * When the cinematic completes (or is force-disposed), camera.position +
 * camera.zoom are NOT explicitly snapped back — the per-frame hero-follow
 * lerp at main.js:2005 resumes and re-converges within ~10 frames at the
 * existing WORLD.cameraLerp rate. This avoids a hard pop.
 *
 * ── Enemy freeze ───────────────────────────────────────────────────────────
 * SPEC FALLBACK chosen. Editing enemies.js update loop or hero.js move loop
 * to respect state.run._bossIntroActive would exceed the per-file line
 * budget. So enemies + hero KEEP MOVING during the 1.5s cinematic. The flag
 * state.run._bossIntroActive is published anyway so future cohorts (or
 * subsystems already wired to check it) can opt in to freezing without
 * needing a re-plumb.
 *
 * Setting state.time.paused = true was rejected because main.js gates the
 * whole tick on it (line 1763) AND on pendingLevelUp / gameOver — our own
 * tick would never run and the cinematic would deadlock at T=0.
 *
 * ── DOM ────────────────────────────────────────────────────────────────────
 * Single banner element with its own id (#kk-boss-intro-banner) so it cannot
 * clobber the singleton ui.js showBanner() used by forestReaper's
 * 'REAPER APPROACHES' warn (29:30) or the sealed-door 'ROOM CLEARED' banner.
 * z-index 90 — above the showBanner (z 80) so when Reaper warn (29:30) is
 * still on screen and the Reaper actually spawns at 30:00, our cinematic
 * banner stacks ON TOP.
 *
 * ── Palette (slot-locked, no new hex constants) ────────────────────────────
 *   miniboss : slot-5 amber #e89c4a  (matches forestBossBars miniboss fill)
 *   elite    : slot-6 gold  #d9a648  (matches forestBossBars elite fill)
 *   roomboss : slot-7 cream #ffd86b  (matches forestBossBars final + reaper banner)
 *   reaper   : reaper red  #ff2020   (matches forestBossBars reaper label)
 *
 * ── Public API ─────────────────────────────────────────────────────────────
 *   loadBossIntroCinematic(scene, state, camera)
 *   tickBossIntroCinematic(state, dt, camera)
 *   triggerBossIntro(enemyOrMesh, tier)
 *   disposeBossIntroCinematic()
 */

// ── Palette (existing slot constants — see header) ─────────────────────────
const TIER_COLORS = {
  miniboss: '#e89c4a',
  elite:    '#d9a648',
  roomboss: '#ffd86b',
  reaper:   '#ff2020',
};

// ── Sequence timings ───────────────────────────────────────────────────────
const T_EASE_IN     = 0.30;
const T_HOLD_END    = 1.20;
const T_TOTAL       = 1.50;
const T_EASE_OUT    = T_TOTAL - T_HOLD_END;

// ── Camera anchor offset (boss-shoulder) ──────────────────────────────────
// Camera default position relative to hero is (+40, +60, +40) — see main.js
// l. 2005. For the cinematic we move it MUCH closer + a hair higher so the
// boss fills the frame: bossPos + (+12, +6, +12). Ortho-iso equivalent of
// "behind shoulder with a slight high angle".
const CAM_OFFSET_X = 12;
const CAM_OFFSET_Y = 6;
const CAM_OFFSET_Z = 12;

// Zoom punch-in: 1.0 -> 1.15 -> 1.0 over the sequence. Ortho-equivalent of
// the spec's "FOV from default to default-5" (~7% framing tightening).
const ZOOM_TARGET  = 1.15;

// ── DOM ids ────────────────────────────────────────────────────────────────
const BANNER_ID = 'kk-boss-intro-banner';
const STYLE_ID  = 'kk-boss-intro-style';

// ── Module state ───────────────────────────────────────────────────────────
let _styleEl     = null;
let _bannerEl    = null;
let _bannerLabel = null;
let _scene       = null;
let _stateRef    = null;
let _cameraRef   = null;

// Active sequence record. null while idle.
let _active      = null;

// Sfx import — lazy to dodge circulars in the module graph.
let _sfx = null;

// ── Lifecycle ──────────────────────────────────────────────────────────────

/**
 * Idempotent. Builds the banner DOM + style once and stashes scene/state/
 * camera refs. Safe to call repeatedly across stage swaps; dispose() flips
 * state back to null so a re-load rebuilds cleanly.
 */
export function loadBossIntroCinematic(scene, state, camera) {
  _scene     = scene || null;
  _stateRef  = state || null;
  _cameraRef = camera || (state && state.camera) || null;
  _ensureStyle();
  _ensureBanner();
  // Lazy sfx import — runtime only. Static would land in the smoke harness
  // and pull the audio.js graph (with WebAudio refs) into node.
  if (!_sfx) {
    import('./audio.js').then((m) => { _sfx = m.sfx; }).catch(() => {});
  }
}

/**
 * Per-frame tick. Drives the active sequence's camera lerp + banner state,
 * and (cheap) scans state.enemies.active for the FIRST untriggered room-boss
 * since spawnEnemy() runs before forestSealedDoors stamps _isRoomBoss.
 * Safe to call every frame, every stage; bails fast when nothing to do.
 */
export function tickBossIntroCinematic(state, dt, camera) {
  if (!state || !state.run) return;
  const cam = camera || _cameraRef || state.camera;
  if (!cam) return;

  // ── 1. roomboss scan — only while not yet fired this run ──────────────
  // Cheap: early-out once seen. Loop bound = state.enemies.active.length.
  const seen = state.run._cinematicSeen;
  if (seen && !seen.roomboss && state.enemies && Array.isArray(state.enemies.active)) {
    const act = state.enemies.active;
    for (let i = 0; i < act.length; i++) {
      const e = act[i];
      if (e && e._isRoomBoss === true && e.alive !== false) {
        triggerBossIntro(e, 'roomboss');
        break;
      }
    }
  }

  // ── 2. drive active sequence ──────────────────────────────────────────
  if (!_active) return;

  _active.elapsed += dt;
  const t = _active.elapsed;

  // Resolve current boss position each frame (boss may walk between phases).
  const bp = _resolvePos(_active.target) || _active.lastBossPos;
  if (bp) {
    _active.lastBossPos.x = bp.x;
    _active.lastBossPos.y = bp.y;
    _active.lastBossPos.z = bp.z;
  }
  const heroPos = (state.hero && state.hero.pos) ? state.hero.pos : { x: 0, y: 0, z: 0 };

  // Cinematic target = behind-boss-shoulder.
  const cinTargetX = _active.lastBossPos.x + CAM_OFFSET_X;
  const cinTargetY = _active.lastBossPos.y + CAM_OFFSET_Y + 60; // +60 baseline like hero-follow
  const cinTargetZ = _active.lastBossPos.z + CAM_OFFSET_Z;

  // Hero-follow target (what we ease BACK to during the exit phase).
  const heroTargetX = heroPos.x + 40;
  const heroTargetY = 60;
  const heroTargetZ = heroPos.z + 40;

  let targetX, targetY, targetZ, targetZoom;
  if (t < T_EASE_IN) {
    // Phase A — ease in.
    const k = _ease(t / T_EASE_IN);
    targetX = _lerp(_active.startCamX, cinTargetX, k);
    targetY = _lerp(_active.startCamY, cinTargetY, k);
    targetZ = _lerp(_active.startCamZ, cinTargetZ, k);
    targetZoom = _lerp(_active.startZoom, ZOOM_TARGET, k);
  } else if (t < T_HOLD_END) {
    // Phase B — hold on boss.
    targetX = cinTargetX;
    targetY = cinTargetY;
    targetZ = cinTargetZ;
    targetZoom = ZOOM_TARGET;
  } else if (t < T_TOTAL) {
    // Phase C — ease out back to hero-follow target.
    const k = _ease((t - T_HOLD_END) / T_EASE_OUT);
    targetX = _lerp(cinTargetX, heroTargetX, k);
    targetY = _lerp(cinTargetY, heroTargetY, k);
    targetZ = _lerp(cinTargetZ, heroTargetZ, k);
    targetZoom = _lerp(ZOOM_TARGET, _active.startZoom, k);
  } else {
    // Phase D — sequence complete.
    _finishSequence(state, cam);
    return;
  }

  // Write camera. The hero-follow lerp ran earlier in the frame; we are an
  // override, so we set absolute values (not lerp toward).
  cam.position.x = targetX;
  cam.position.y = targetY;
  cam.position.z = targetZ;
  // Aim at the boss for ease-in + hold; aim at hero for ease-out.
  if (t < T_HOLD_END) {
    cam.lookAt(_active.lastBossPos.x, 0, _active.lastBossPos.z);
  } else {
    const k = _ease((t - T_HOLD_END) / T_EASE_OUT);
    const aimX = _lerp(_active.lastBossPos.x, heroPos.x, k);
    const aimZ = _lerp(_active.lastBossPos.z, heroPos.z, k);
    cam.lookAt(aimX, 0, aimZ);
  }
  if (typeof cam.zoom === 'number') {
    cam.zoom = targetZoom;
    if (typeof cam.updateProjectionMatrix === 'function') cam.updateProjectionMatrix();
  }

  // Banner opacity: fade out across phase C; full opacity earlier.
  if (_bannerEl) {
    let op = 1;
    if (t >= T_HOLD_END) {
      op = Math.max(0, 1 - (t - T_HOLD_END) / T_EASE_OUT);
    }
    if (op !== _active.lastBannerOpacity) {
      _bannerEl.style.opacity = String(op);
      _active.lastBannerOpacity = op;
    }
  }
}

/**
 * Public trigger. Idempotent per-tier-per-run via state.run._cinematicSeen.
 * Safe to call from any spawn site; called sites (enemies.js spawnEnemy
 * tail + forestReaper spawn block) pass the enemy/mesh + tier label.
 *
 * @param {object} enemyOrMesh enemy record OR THREE.Object3D (Reaper group)
 * @param {'miniboss'|'elite'|'roomboss'|'reaper'} tier
 */
export function triggerBossIntro(enemyOrMesh, tier) {
  const state = _stateRef;
  if (!state || !state.run) return;
  if (!enemyOrMesh) return;
  if (tier !== 'miniboss' && tier !== 'elite' && tier !== 'roomboss' && tier !== 'reaper') return;

  // Init seen-map on first contact (defensive — resetState should have done it).
  if (!state.run._cinematicSeen) {
    state.run._cinematicSeen = { miniboss: false, elite: false, roomboss: false, reaper: false };
  }
  if (state.run._cinematicSeen[tier] === true) return; // already fired this run
  if (_active) return; // a different-tier cinematic is mid-play; spec says first-only same-frame

  // CRITICAL: stamp _seen + _bossIntroActive SYNCHRONOUSLY before any
  // setup — same-frame multi-spawn race depends on this.
  state.run._cinematicSeen[tier] = true;
  state.run._bossIntroActive     = true;

  const cam = _cameraRef || state.camera;
  if (!cam) {
    // No camera — still mark seen so we don't retry; banner-only fallback.
    _activeFallback(enemyOrMesh, tier);
    return;
  }

  // Resolve initial boss world pos for the camera anchor.
  const bp = _resolvePos(enemyOrMesh) || { x: 0, y: 0, z: 0 };

  _active = {
    target: enemyOrMesh,
    tier,
    elapsed: 0,
    startCamX: cam.position.x,
    startCamY: cam.position.y,
    startCamZ: cam.position.z,
    startZoom: (typeof cam.zoom === 'number' ? cam.zoom : 1),
    lastBossPos: { x: bp.x, y: bp.y, z: bp.z },
    lastBannerOpacity: -1,
  };

  // Banner label per spec: Reaper gets "INVINCIBLE: REAPER"; others
  // "ENCOUNTER: {glbKey.toUpperCase() || 'BOSS'}".
  let name = 'BOSS';
  if (enemyOrMesh && typeof enemyOrMesh.glbKey === 'string' && enemyOrMesh.glbKey.length > 0) {
    name = enemyOrMesh.glbKey.toUpperCase();
  }
  const label = (tier === 'reaper') ? 'INVINCIBLE: REAPER' : `ENCOUNTER: ${name}`;
  const color = TIER_COLORS[tier] || '#ffffff';
  _showBanner(label, color);

  // Sfx — reaper gets the dedicated reaper warn cue, others get bossWarn.
  try {
    if (_sfx) {
      if (tier === 'reaper' && _sfx.reaperWarn) _sfx.reaperWarn();
      else if (_sfx.bossWarn) _sfx.bossWarn();
    }
  } catch (_) {}
}

/**
 * Banner-only path used when the camera isn't available (defensive — should
 * never fire in normal play, but keeps the trigger contract honest).
 */
function _activeFallback(enemyOrMesh, tier) {
  let name = 'BOSS';
  if (enemyOrMesh && typeof enemyOrMesh.glbKey === 'string' && enemyOrMesh.glbKey.length > 0) {
    name = enemyOrMesh.glbKey.toUpperCase();
  }
  const label = (tier === 'reaper') ? 'INVINCIBLE: REAPER' : `ENCOUNTER: ${name}`;
  const color = TIER_COLORS[tier] || '#ffffff';
  _showBanner(label, color);
  // Auto-clear after 1.5s so the banner doesn't stick.
  setTimeout(() => {
    if (_bannerEl) _bannerEl.style.opacity = '0';
    if (_stateRef && _stateRef.run) _stateRef.run._bossIntroActive = false;
  }, 1500);
}

/**
 * Tear down DOM, drop refs, clear active sequence. Idempotent — safe across
 * stage swaps. Mirrors disposeForestBossBars shape.
 */
export function disposeBossIntroCinematic() {
  const banner = document.getElementById(BANNER_ID);
  if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
  const style = document.getElementById(STYLE_ID);
  if (style && style.parentNode) style.parentNode.removeChild(style);
  _bannerEl    = null;
  _bannerLabel = null;
  _styleEl     = null;
  _active      = null;
  _scene       = null;
  _stateRef    = null;
  _cameraRef   = null;
}

// ── Internals ──────────────────────────────────────────────────────────────

function _finishSequence(state, cam) {
  if (state && state.run) state.run._bossIntroActive = false;
  if (_bannerEl) _bannerEl.style.opacity = '0';
  // Don't snap camera back here — the next frame's hero-follow lerp + per-
  // frame frustum re-bake at main.js l.2030 will re-converge naturally.
  // Restoring zoom to the start value, however, IS safe and prevents a
  // lingering punch-in if the lerp doesn't re-write zoom.
  if (cam && typeof cam.zoom === 'number' && _active && typeof _active.startZoom === 'number') {
    cam.zoom = _active.startZoom;
    if (typeof cam.updateProjectionMatrix === 'function') cam.updateProjectionMatrix();
  }
  _active = null;
}

function _resolvePos(t) {
  if (!t) return null;
  // Enemy record shape: { mesh: THREE.Object3D, ... }
  if (t.mesh && t.mesh.position) return t.mesh.position;
  // Raw mesh / group.
  if (t.position) return t.position;
  return null;
}

function _ease(x) {
  // Smoothstep (3x^2 - 2x^3) — symmetric ease-in-out in [0,1].
  const k = Math.max(0, Math.min(1, x));
  return k * k * (3 - 2 * k);
}

function _lerp(a, b, k) {
  return a + (b - a) * k;
}

function _ensureStyle() {
  if (document.getElementById(STYLE_ID)) {
    _styleEl = document.getElementById(STYLE_ID);
    return;
  }
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    #${BANNER_ID} {
      position: fixed;
      left: 50%;
      top: 12%;
      transform: translate(-50%, -120%);
      pointer-events: none;
      z-index: 90;
      font-family: monospace, 'Courier New', Courier;
      font-size: 32px;
      font-weight: 900;
      letter-spacing: 0.18em;
      padding: 10px 24px;
      background: linear-gradient(180deg, rgba(10,14,18,0.78), rgba(4,8,12,0.86));
      border-top: 1px solid rgba(0,0,0,0.85);
      border-bottom: 1px solid rgba(0,0,0,0.85);
      box-shadow: 0 10px 30px rgba(0,0,0,0.55);
      white-space: nowrap;
      opacity: 0;
      transition: transform 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.2), opacity 0.18s ease-out;
      color: #fff;
    }
    #${BANNER_ID}.kk-bi-show {
      transform: translate(-50%, 0);
      opacity: 1;
    }
  `;
  document.head.appendChild(s);
  _styleEl = s;
}

function _ensureBanner() {
  if (document.getElementById(BANNER_ID)) {
    _bannerEl = document.getElementById(BANNER_ID);
    _bannerLabel = _bannerEl;
    return;
  }
  const el = document.createElement('div');
  el.id = BANNER_ID;
  el.textContent = '';
  const root = document.getElementById('ui-root') || document.body;
  if (root) root.appendChild(el);
  _bannerEl    = el;
  _bannerLabel = el;
}

function _showBanner(label, color) {
  _ensureStyle();
  _ensureBanner();
  if (!_bannerEl) return;
  _bannerEl.textContent = label;
  _bannerEl.style.color = color;
  _bannerEl.style.textShadow = `0 2px 14px rgba(0,0,0,0.65), 0 0 22px ${color}66`;
  // Trigger slide-in. Re-toggle the class so a back-to-back fire restarts
  // the transform animation.
  _bannerEl.classList.remove('kk-bi-show');
  // Force reflow to restart the transition.
  // eslint-disable-next-line no-unused-expressions
  void _bannerEl.offsetWidth;
  _bannerEl.classList.add('kk-bi-show');
  _bannerEl.style.opacity = '1';
}
