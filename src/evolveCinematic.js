/**
 * Weapon evolve cinematic — PHASE 1 P1J (2026-05-17).
 *
 * 1.0s camera punch-in + gold burst + slot-7 cream banner when a Forest
 * Evolution Coffin (cohort 7, src/forestCoffins.js) dispatches a base
 * weapon → superweapon evolution. Sits next to the cohort-23 boss intro
 * cinematic (src/bossIntroCinematic.js) and reuses that module's camera-
 * override pattern (write camera.position + camera.zoom + lookAt AFTER the
 * per-frame hero-follow lerp in main.js).
 *
 * ── Trigger ────────────────────────────────────────────────────────────────
 * Called from src/forestCoffins.js _dispatchEvolution success path with
 * `triggerEvolveCinematic(evolvedId, basePos)` where basePos is the coffin's
 * world position {x,y,z}. Once per dispatch — re-entrant calls while
 * `_active` is set short-circuit (matches bossIntro semantics). NOT once
 * per run: two coffins opened sequentially → two cinematics.
 *
 * ── Sequence (1.0s, no slo-mo) ─────────────────────────────────────────────
 * Slo-mo was SKIPPED (spec FALLBACK chosen). Wiring a shared time scale
 * would touch every weapon tick + enemies.js + hero.js — invasive and out
 * of scope for the 250-400 line budget. The cinematic plays at normal
 * game speed; 1.0s is short enough to feel like a punctuation mark, not a
 * pause. Documented as deviation in final report.
 *
 *   T=0.00-0.25s : ease-in. Camera lerps from current hero-follow pos to
 *                  coffin anchor: coffinPos + (+8, +6, +8). Zoom 1.0 → 1.2.
 *                  Burst ring scales 0.5 → 2.0. Banner slides in.
 *   T=0.25-0.75s : hold on coffin. Burst ring continues expanding 2.0 → 3.5.
 *                  Banner pulses at full opacity.
 *   T=0.75-1.00s : ease-out. Camera lerps back to hero-follow target,
 *                  zoom 1.2 → 1.0. Burst ring 3.5 → 4.0, opacity fades.
 *                  Banner fades.
 *   T=1.00s+     : sequence complete; banner+burst hidden; camera/zoom
 *                  restored; _active cleared.
 *
 * ── Camera control ─────────────────────────────────────────────────────────
 * Orthographic camera — no FOV, use camera.zoom for punch-in. main.js
 * ticks us AFTER tickBossIntroCinematic (which itself runs after the hero-
 * follow + frustum bake), so the LAST writer to camera each frame is us.
 * That gives evolve-cinematic priority over boss-intro automatically.
 *
 * ── Conflict with bossIntroCinematic (cohort 23) ───────────────────────────
 * If a boss intro is already mid-play (`state.run._bossIntroActive === true`)
 * when an evolve trigger fires, we DENY the evolve cinematic outright
 * (skip the visual, but still play the chime + show the banner via the
 * coffin's existing showBanner from forestCoffins._dispatchEvolution).
 *
 * The spec offered "queue + retry next frame" — rejected as invasive:
 * keeping a pending-trigger queue would require per-frame dequeue logic +
 * a stale-position concern (coffin pos doesn't move, but the player has
 * already grabbed the weapon — replaying a cinematic 1.5s later feels
 * disjoint). Skipping cleanly is better player feedback than a delayed
 * replay. Logged as deviation.
 *
 * ── Burst mesh ─────────────────────────────────────────────────────────────
 * Single pre-allocated THREE.Mesh (RingGeometry r=1, scale-driven per
 * frame). Slot-7 gold (#ffd86b) additive + AdditiveBlending + BLOOM_LAYER —
 * matches the forestCoffins sparkle ring treatment for visual continuity.
 * The geometry sits at coffin position, y=0.5 (slightly above ground), flat
 * (rotation.x = -PI/2). Zero per-frame allocation in tick.
 *
 * ── DOM banner ─────────────────────────────────────────────────────────────
 * Single banner element (#kk-evolve-cin-banner) with its own style sheet.
 * z-index 110 — above HUD (70), above boss bars (65), above boss intro
 * banner (90), below the end-of-run summary (130). Slot-7 cream color
 * (#ffd86b) with bold pulse animation. Text: "EVOLVED: {WEAPON_NAME}".
 *
 * ── Palette (slot-locked, no new hex constants) ────────────────────────────
 *   burst ring : slot-7 cream/gold #ffd86b (matches roomboss banner color
 *                + forestCoffins sparkle ring slot-6 gold family)
 *   banner txt : slot-7 cream #ffd86b
 *
 * ── Public API ─────────────────────────────────────────────────────────────
 *   loadEvolveCinematic(scene, state, camera)
 *   tickEvolveCinematic(state, dt, camera)
 *   triggerEvolveCinematic(weaponId, pos)
 *   disposeEvolveCinematic()
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from './postfx.js';

// ── Palette (existing slot-7 — no new hex constants) ───────────────────────
const SLOT7_CREAM_HEX = 0xffd86b;
const SLOT7_CREAM_CSS = '#ffd86b';

// ── Sequence timings (1.0s total) ──────────────────────────────────────────
const T_EASE_IN  = 0.25;
const T_HOLD_END = 0.75;
const T_TOTAL    = 1.00;
const T_EASE_OUT = T_TOTAL - T_HOLD_END;

// ── Camera anchor offset (coffin-shoulder) ─────────────────────────────────
// Camera default position relative to hero is (+40, +60, +40). For the
// evolve cinematic we move it closer to the coffin — coffinPos + (+8, +6,
// +8) — tighter framing than the boss intro (which uses +12, +6, +12)
// because the coffin is smaller than a boss and the burst ring needs to
// fill the frame.
const CAM_OFFSET_X = 8;
const CAM_OFFSET_Y = 6;
const CAM_OFFSET_Z = 8;
// Ortho zoom punch-in: 1.0 → 1.2 → 1.0 over the sequence. A hair stronger
// than the boss intro (1.15) since the evolve moment is more singular.
const ZOOM_TARGET  = 1.20;

// ── Burst ring scale schedule ──────────────────────────────────────────────
// Base RingGeometry built at radius=1; we drive scale per frame so the ring
// expands 0.5 → 4.0 over the 1.0s sequence (visually the spec's
// "r=0.5 → r=4.0 over 1s" without re-baking geometry).
const BURST_SCALE_START  = 0.5;
const BURST_SCALE_MIDHI  = 3.5;  // at T_HOLD_END
const BURST_SCALE_END    = 4.0;  // at T_TOTAL
const BURST_Y            = 0.5;  // slightly above ground

// ── DOM ids ────────────────────────────────────────────────────────────────
const BANNER_ID = 'kk-evolve-cin-banner';
const STYLE_ID  = 'kk-evolve-cin-style';

// ── Friendly-name fallback table (REGISTRY isn't exported from weapons/index.js) ─
// Inline the two known evolutions; any other id falls back to upper-snake-
// cased label so a future evolution flowing through the same trigger still
// reads reasonably.
const FRIENDLY_NAMES = {
  chain_storm:   'CHAIN STORM',
  frost_eternal: 'FROST ETERNAL',
};

// ── Module state ───────────────────────────────────────────────────────────
let _scene       = null;
let _stateRef    = null;
let _cameraRef   = null;
let _styleEl     = null;
let _bannerEl    = null;
let _burstMesh   = null;     // single pre-allocated RingGeometry mesh
let _burstGeom   = null;     // tracked for dispose
let _burstMat    = null;     // tracked for dispose
let _disposables = [];       // [geom, mat] refs

// Active sequence record. null while idle.
let _active      = null;

// Lazy sfx ref (audio.js pulls WebAudio refs; lazy import keeps the smoke
// harness clean — mirrors bossIntroCinematic).
let _sfx = null;

// ── Lifecycle ──────────────────────────────────────────────────────────────

/**
 * Idempotent. Builds the burst mesh + banner DOM + style once and stashes
 * scene/state/camera refs. Safe to call repeatedly across stage swaps;
 * dispose() flips state back to null so a re-load rebuilds cleanly.
 *
 * @param {THREE.Scene} scene
 * @param {Object} state
 * @param {THREE.OrthographicCamera} camera
 */
export function loadEvolveCinematic(scene, state, camera) {
  _scene     = scene || null;
  _stateRef  = state || null;
  _cameraRef = camera || (state && state.camera) || null;
  _ensureStyle();
  _ensureBanner();
  _ensureBurstMesh();
  // Lazy sfx import — runtime only. Static would land in the smoke harness
  // and pull the audio.js graph (with WebAudio refs) into node.
  if (!_sfx) {
    import('./audio.js').then((m) => { _sfx = m.sfx; }).catch(() => {});
  }
}

/**
 * Per-frame tick. Drives the active sequence's camera override + burst
 * mesh scaling + banner opacity. Safe to call every frame, every stage;
 * bails fast when no sequence is active. Tick is called AFTER
 * tickBossIntroCinematic in main.js so writes to camera.position +
 * camera.zoom override BOTH the hero-follow and the boss-intro override
 * during the 1.0s evolve sequence (evolve takes priority by virtue of
 * being the LAST writer per frame).
 *
 * @param {Object} state
 * @param {number} dt — real seconds (NOT logicDt — cinematic plays at real
 *                      wall-clock speed regardless of any future game pause).
 * @param {THREE.OrthographicCamera} camera
 */
export function tickEvolveCinematic(state, dt, camera) {
  if (!state || !state.run) return;
  if (!_active) return;
  const cam = camera || _cameraRef || state.camera;
  if (!cam) return;

  _active.elapsed += dt;
  const t = _active.elapsed;

  const heroPos = (state.hero && state.hero.pos) ? state.hero.pos : { x: 0, y: 0, z: 0 };
  const bp = _active.basePos;

  // Cinematic camera target = above-coffin shoulder.
  const cinTargetX = bp.x + CAM_OFFSET_X;
  const cinTargetY = bp.y + CAM_OFFSET_Y + 60; // +60 baseline like hero-follow
  const cinTargetZ = bp.z + CAM_OFFSET_Z;

  // Hero-follow target (what we ease BACK to during the exit phase).
  const heroTargetX = heroPos.x + 40;
  const heroTargetY = 60;
  const heroTargetZ = heroPos.z + 40;

  let targetX, targetY, targetZ, targetZoom, burstScale, burstOpacity, bannerOp;
  if (t < T_EASE_IN) {
    // Phase A — ease in. Camera lerps from start toward coffin; burst grows.
    const k = _ease(t / T_EASE_IN);
    targetX = _lerp(_active.startCamX, cinTargetX, k);
    targetY = _lerp(_active.startCamY, cinTargetY, k);
    targetZ = _lerp(_active.startCamZ, cinTargetZ, k);
    targetZoom = _lerp(_active.startZoom, ZOOM_TARGET, k);
    burstScale = _lerp(BURST_SCALE_START, 2.0, k);
    burstOpacity = _lerp(0.9, 1.0, k);
    bannerOp = k;
  } else if (t < T_HOLD_END) {
    // Phase B — hold on coffin. Burst continues expanding 2.0 → 3.5.
    const k = (t - T_EASE_IN) / (T_HOLD_END - T_EASE_IN);
    targetX = cinTargetX;
    targetY = cinTargetY;
    targetZ = cinTargetZ;
    targetZoom = ZOOM_TARGET;
    burstScale = _lerp(2.0, BURST_SCALE_MIDHI, k);
    burstOpacity = 1.0;
    bannerOp = 1.0;
  } else if (t < T_TOTAL) {
    // Phase C — ease out. Camera lerps back toward hero; burst + banner fade.
    const k = _ease((t - T_HOLD_END) / T_EASE_OUT);
    targetX = _lerp(cinTargetX, heroTargetX, k);
    targetY = _lerp(cinTargetY, heroTargetY, k);
    targetZ = _lerp(cinTargetZ, heroTargetZ, k);
    targetZoom = _lerp(ZOOM_TARGET, _active.startZoom, k);
    burstScale = _lerp(BURST_SCALE_MIDHI, BURST_SCALE_END, k);
    burstOpacity = 1.0 - k;
    bannerOp = 1.0 - k;
  } else {
    // Phase D — sequence complete.
    _finishSequence(state, cam);
    return;
  }

  // Write camera. We are the LAST override per frame (after hero-follow +
  // tickBossIntroCinematic), so set absolute values.
  cam.position.x = targetX;
  cam.position.y = targetY;
  cam.position.z = targetZ;
  // Aim at coffin during ease-in + hold; lerp aim toward hero during ease-out.
  if (t < T_HOLD_END) {
    cam.lookAt(bp.x, 0, bp.z);
  } else {
    const k = _ease((t - T_HOLD_END) / T_EASE_OUT);
    const aimX = _lerp(bp.x, heroPos.x, k);
    const aimZ = _lerp(bp.z, heroPos.z, k);
    cam.lookAt(aimX, 0, aimZ);
  }
  if (typeof cam.zoom === 'number') {
    cam.zoom = targetZoom;
    if (typeof cam.updateProjectionMatrix === 'function') cam.updateProjectionMatrix();
  }

  // Burst mesh — single pre-allocated mesh, scale-driven (no allocation).
  if (_burstMesh) {
    _burstMesh.scale.setScalar(burstScale);
    if (_burstMat && _burstMat.opacity !== burstOpacity) {
      _burstMat.opacity = burstOpacity;
    }
  }

  // Banner opacity — guard against churn.
  if (_bannerEl && bannerOp !== _active.lastBannerOpacity) {
    _bannerEl.style.opacity = String(bannerOp);
    _active.lastBannerOpacity = bannerOp;
  }
}

/**
 * Public trigger. Idempotent per-dispatch via `_active` (re-entrant calls
 * while a sequence is mid-play short-circuit silently — matches the
 * cohort-23 bossIntro semantics).
 *
 * @param {string} weaponId — evolved superweapon id (e.g. 'chain_storm')
 * @param {{x:number, y:number, z:number}} pos — coffin world position
 */
export function triggerEvolveCinematic(weaponId, pos) {
  const state = _stateRef;
  if (!state || !state.run) return;
  if (typeof weaponId !== 'string' || weaponId.length === 0) return;
  if (!pos || typeof pos.x !== 'number' || typeof pos.z !== 'number') return;

  // FALLBACK — boss intro is mid-play. Deny + log; play the chime so the
  // player still gets audio feedback that the evolution dispatched. The
  // coffin's own showBanner('★ COFFIN OPENED: ...') still fires upstream.
  if (state.run._bossIntroActive === true) {
    try { if (_sfx && _sfx.evolutionChime) _sfx.evolutionChime(); } catch (_) {}
    return;
  }

  // Re-entry guard — a second dispatch firing while we're still playing
  // the first cinematic gets the chime but no visual.
  if (_active) {
    try { if (_sfx && _sfx.evolutionChime) _sfx.evolutionChime(); } catch (_) {}
    return;
  }

  const cam = _cameraRef || state.camera;
  if (!cam) {
    // No camera — banner-only fallback so the player still sees feedback.
    _showBanner(_friendlyName(weaponId));
    try { if (_sfx && _sfx.evolutionChime) _sfx.evolutionChime(); } catch (_) {}
    // Auto-clear after 1s so the banner doesn't stick.
    setTimeout(() => { if (_bannerEl) _bannerEl.style.opacity = '0'; }, 1000);
    return;
  }

  // CRITICAL: stamp _evolveCinematicActive SYNCHRONOUSLY before any setup
  // so a same-frame double-dispatch race sees the flag.
  state.run._evolveCinematicActive = true;

  // Build the active sequence record.
  _active = {
    weaponId,
    basePos: { x: pos.x, y: (typeof pos.y === 'number' ? pos.y : 0), z: pos.z },
    elapsed: 0,
    startCamX: cam.position.x,
    startCamY: cam.position.y,
    startCamZ: cam.position.z,
    startZoom: (typeof cam.zoom === 'number' ? cam.zoom : 1),
    lastBannerOpacity: -1,
  };

  // Place + show the burst mesh at the coffin position.
  if (_burstMesh) {
    _burstMesh.position.set(_active.basePos.x, BURST_Y, _active.basePos.z);
    _burstMesh.scale.setScalar(BURST_SCALE_START);
    _burstMesh.visible = true;
    if (_burstMat) _burstMat.opacity = 0.9;
  }

  // Banner.
  _showBanner(_friendlyName(weaponId));

  // SFX — evolution chime (already wired in cohort 13 / audio.js).
  try { if (_sfx && _sfx.evolutionChime) _sfx.evolutionChime(); } catch (_) {}
}

/**
 * Tear down DOM + burst mesh, drop refs, clear active sequence. Idempotent —
 * safe across stage swaps. Mirrors disposeBossIntroCinematic shape.
 */
export function disposeEvolveCinematic() {
  const banner = document.getElementById(BANNER_ID);
  if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
  const style = document.getElementById(STYLE_ID);
  if (style && style.parentNode) style.parentNode.removeChild(style);
  // Pull the burst mesh out of whatever scene it's parented to.
  if (_burstMesh) {
    if (_burstMesh.parent) _burstMesh.parent.remove(_burstMesh);
  }
  // Dispose tracked geom/mat.
  for (let i = 0; i < _disposables.length; i++) {
    const d = _disposables[i];
    try { d.dispose && d.dispose(); } catch (_) {}
  }
  _disposables = [];
  _bannerEl  = null;
  _styleEl   = null;
  _burstMesh = null;
  _burstGeom = null;
  _burstMat  = null;
  _active    = null;
  _scene     = null;
  _stateRef  = null;
  _cameraRef = null;
}

// ── Internals ──────────────────────────────────────────────────────────────

function _finishSequence(state, cam) {
  if (state && state.run) state.run._evolveCinematicActive = false;
  if (_bannerEl) _bannerEl.style.opacity = '0';
  if (_burstMesh) {
    _burstMesh.visible = false;
    _burstMesh.scale.setScalar(BURST_SCALE_START);
  }
  // Restore zoom to start value — hero-follow lerp doesn't touch zoom so a
  // lingering punch-in would persist otherwise.
  if (cam && typeof cam.zoom === 'number' && _active && typeof _active.startZoom === 'number') {
    cam.zoom = _active.startZoom;
    if (typeof cam.updateProjectionMatrix === 'function') cam.updateProjectionMatrix();
  }
  // Don't snap camera position back — the next frame's hero-follow lerp
  // will re-converge naturally. Matches the bossIntro tail behavior.
  _active = null;
}

function _ease(x) {
  // Smoothstep (3x^2 - 2x^3) — symmetric ease-in-out in [0,1].
  const k = Math.max(0, Math.min(1, x));
  return k * k * (3 - 2 * k);
}

function _lerp(a, b, k) {
  return a + (b - a) * k;
}

function _friendlyName(weaponId) {
  if (FRIENDLY_NAMES[weaponId]) return FRIENDLY_NAMES[weaponId];
  // Fallback: upper-snake → upper-space (e.g. 'foo_bar' → 'FOO BAR').
  return String(weaponId).replace(/_/g, ' ').toUpperCase();
}

function _ensureBurstMesh() {
  if (_burstMesh || !_scene) return;
  // RingGeometry(innerRadius, outerRadius, segments). r=1 base + per-frame
  // scale so we don't re-bake geometry to drive the expansion. inner=0.85
  // gives the ring a chunky 15%-of-radius thickness that reads well at
  // sub-1.0 scale during the very first frames.
  _burstGeom = new THREE.RingGeometry(0.85, 1.0, 48);
  _burstMat  = new THREE.MeshBasicMaterial({
    color: SLOT7_CREAM_HEX,
    transparent: true, opacity: 0.0,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  _burstMesh = new THREE.Mesh(_burstGeom, _burstMat);
  // Flat on the ground plane (RingGeometry is XY by default; rotate to XZ).
  _burstMesh.rotation.x = -Math.PI / 2;
  _burstMesh.position.set(0, BURST_Y, 0);
  _burstMesh.scale.setScalar(BURST_SCALE_START);
  _burstMesh.visible = false;
  // Bloom: matches forestCoffins sparkle ring + boss-intro slot-7 treatment.
  if (BLOOM_LAYER != null) _burstMesh.layers.enable(BLOOM_LAYER);
  _burstMesh.name = '__evolveCinematicBurst';
  _scene.add(_burstMesh);
  _disposables.push(_burstGeom);
  _disposables.push(_burstMat);
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
      top: 18%;
      transform: translate(-50%, -120%);
      pointer-events: none;
      z-index: 110;
      font-family: monospace, 'Courier New', Courier;
      font-size: 30px;
      font-weight: 900;
      letter-spacing: 0.20em;
      padding: 12px 26px;
      background: linear-gradient(180deg, rgba(10,14,18,0.78), rgba(4,8,12,0.86));
      border-top: 1px solid rgba(0,0,0,0.85);
      border-bottom: 1px solid rgba(0,0,0,0.85);
      box-shadow: 0 10px 30px rgba(0,0,0,0.55);
      white-space: nowrap;
      opacity: 0;
      color: ${SLOT7_CREAM_CSS};
      text-shadow: 0 2px 14px rgba(0,0,0,0.65), 0 0 22px ${SLOT7_CREAM_CSS}66;
      transition: transform 0.18s cubic-bezier(0.2, 0.9, 0.3, 1.2);
    }
    #${BANNER_ID}.kk-ec-show {
      transform: translate(-50%, 0);
      animation: kk-ec-pulse 0.5s ease-out 1;
    }
    @keyframes kk-ec-pulse {
      0%   { transform: translate(-50%, 0) scale(1.0); }
      40%  { transform: translate(-50%, 0) scale(1.08); }
      100% { transform: translate(-50%, 0) scale(1.0); }
    }
  `;
  document.head.appendChild(s);
  _styleEl = s;
}

function _ensureBanner() {
  if (document.getElementById(BANNER_ID)) {
    _bannerEl = document.getElementById(BANNER_ID);
    return;
  }
  const el = document.createElement('div');
  el.id = BANNER_ID;
  el.textContent = '';
  const root = document.getElementById('ui-root') || document.body;
  if (root) root.appendChild(el);
  _bannerEl = el;
}

function _showBanner(weaponName) {
  _ensureStyle();
  _ensureBanner();
  if (!_bannerEl) return;
  _bannerEl.textContent = `EVOLVED: ${weaponName}`;
  // Restart pulse animation by toggling class.
  _bannerEl.classList.remove('kk-ec-show');
  // Force reflow so the animation restarts on back-to-back fires.
  // eslint-disable-next-line no-unused-expressions
  void _bannerEl.offsetWidth;
  _bannerEl.classList.add('kk-ec-show');
  _bannerEl.style.opacity = '1';
}
