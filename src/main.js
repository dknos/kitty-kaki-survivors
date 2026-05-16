/**
 * Bootstrap + main RAF loop.
 * Order of operations is locked in the loop body below; modules fill the blanks.
 */
import * as THREE from 'three';
import { state, resetState } from './state.js';
import { WORLD, SPAWN, AVATARS, CHARACTERS, STAGES, archetypeForAvatar } from './config.js';
import { preloadAll, lazyLoadGLTF, disposeCachedGLTF, BASE, GLTF_CACHE } from './assets.js';
import { createComposer, resizeComposer, BLOOM_LAYER, applyAccessibilityOptions } from './postfx.js';
import { buildEnv } from './env.js';
import { unlockAudio, startMusic, setMusicTier, setVolume, setMasterVolume, setMusicVolume, setSfxVolume, suspendAudio, resumeAudio, sfx, playStageAmbient } from './audio.js';
import { getMeta, shopLevel, selectedCharacter, selectedAvatar, dailyChallengeConfig, equippedRelic, selectedStage, QUEST_TEMPLATES, weeklyMutatorConfig, commitWeeklyRun, setOption, SHOP_TREE, recordAvatarRun } from './meta.js';
import { applyWeeklyMutator } from './weeklyMutator.js';
import { recordRun } from './leaderboard.js';

// Module imports (filled in by parallel agents)
import { initInput, sampleInput, getZoom, resetZoom } from './input.js';
import { initHero, updateHero, updateDeathAnim, takeDamage as heroTakeDamage, rebuildHero } from './hero.js';
import { initEnemies, updateEnemies, prewarmPools } from './enemies.js';
import { initWeapons, tickWeapons, acquireWeapon, weaponChoices, _resetEvoAnnouncements, REGISTRY as WEAPON_REGISTRY } from './weapons/index.js';
import { tickChainArcs } from './chainFx.js';
import { tickEvolveBursts, disposeAllEvolveBursts, setEvolveBurstStateRef } from './fx/evolveBurst.js';
import { initDissolveBurst, tickDissolveBursts, disposeAllDissolveBursts, setDissolveBurstStateRef } from './fx/dissolveBurst.js';
import { tickVelocityVeils, disposeAllVelocityVeils } from './fx/ribbonTrail.js';
import { initProjectileVisuals, releaseProjectileVisuals } from './weapons/autoAim.js';
import { initXP, updateGems, applyLevelUpChoice } from './xp.js';
import { initSpawnDirector, tickSpawnDirector, secondsUntilNextMiniBoss } from './spawnDirector.js';
import { initUI, updateUI, showDeathScreen, showStartScreen, hideStartScreen, showOptions, hideOptions, isOptionsOpen, showBanner, hideShop, isShopOpen, hideGrimoire, isGrimoireOpen, showHouse, hideHouse, isHouseOpen, showQuestBoard, hideQuestBoard, isQuestBoardOpen, hideCredits, isCreditsOpen, showContextLossModal, hideContextLossModal, showCasinoMenu, showCasinoSlots, showCasinoParlay } from './ui.js';
import { showCodex, hideCodex, isCodexOpen } from './codex.js';
import { initDamageNumbers, updateDamageNumbers } from './damageNumbers.js';
import { initFX, updateFX, updatePickupRing } from './fx.js';
import { initVFXBurst, updateVFXBurst, resetVFXBurst } from './vfxBurst.js';
import { initChests, tickChests, resetChests, spawnAt as spawnChestAt } from './chest.js';
import { initBossTelegraphs, updateBossTelegraphs, resetBossTelegraphs } from './bossTelegraphs.js';
import { initDestructibles, resetDestructibles } from './destructibles.js';
import { initPerfHUD, updatePerfHUD, perfStart, perfMark } from './perfHUD.js';
import { initParticleTextures } from './particleTextures.js';
import { initPickups, tickPickups, resetPickups } from './pickups.js';
import { initBlobShadows, updateBlobShadows } from './blobShadows.js';
import { updateEnemyProjectiles } from './enemyProjectiles.js';
import { buildTown, enterTown, exitTown, tickTown, setGateHandler, setInteractionHandler } from './town.js';
import { buildInterior, enterInterior, exitInterior, tickInterior, setInteriorHandler } from './interior.js';
import { buildCasinoInterior, enterCasinoInterior, exitCasinoInterior, tickCasinoInterior, setCasinoInteriorHandler } from './casinoInterior.js';
import { buildCatacomb, tickCatacomb, tickCatacombEntrance, exitCatacomb, resetCatacomb } from './catacomb.js';
import { showSketchbook } from './sketchbook.js';
import { showYarnDart } from './yarndart.js';
import { showTeaSteep } from './teasteep.js';
import { initTotems, tickTotems, resetTotems } from './totems.js';
import { initPylons, tickPylons, resetPylons } from './pylons.js';
import { initBells, tickBells, resetBells } from './bells.js';
import { initEnemyTells, updateEnemyTells, resetEnemyTells } from './enemyTells.js';
import { initStageHazards, tickStageHazards, resetStageHazards, loadForestHazards, clearForestHazards, loadTwilightHazards, clearTwilightHazards, loadCinderHazards, clearCinderHazards, loadVoidHazards, clearVoidHazards } from './stageHazards.js';
import { applyStageRule, tickStageRule, clearStageRule } from './stageRules.js';
import { loadArenaDecor, clearArenaDecor } from './arenaDecor.js';
import { loadForestAmber, tickForestAmber, clearForestAmber } from './forestAmber.js';
import { tickPuzzleSystem } from './puzzleSystem.js';
import { detectRoom, FOREST_ROOMS } from './forestRooms.js';
import { loadTwilightFountains, tickTwilightFountains, clearTwilightFountains } from './twilightFountains.js';
import { loadCinderBallistas, tickCinderBallistas, clearCinderBallistas } from './cinderBallistas.js';
import { loadVoidTeleportPads, tickVoidTeleportPads, clearVoidTeleportPads } from './voidTeleportPads.js';
import { initMiniEvents, tickMiniEvents, resetMiniEvents, teardownMiniEvents } from './miniEvents.js';
import { initArenaProps, spawnArenaProps, tickArenaProps, resetArenaProps } from './arenaProps.js';
import { notifyTutorialEvent } from './tutorial.js';
// Iter 10b — perf soak benchmark. Side-effect import installs window.kkSoak
// so the soak is callable from the DevTools console without any UI hook.
import './perfSoak.js';

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const canvas = document.getElementById('game-canvas');
let W = window.innerWidth, H = window.innerHeight;
const ASPECT = () => W / H;

const renderer = new THREE.WebGLRenderer({
  canvas, antialias: false, powerPreference: 'high-performance',
  stencil: false, depth: true, alpha: false,
});
// iter 33z — DPR cap dropped 1.75 → 1.25. User report: render 21.84 ms / 41 FPS
// with 219 enemies; bloom-pass × 1.75² = 3.06× pixel cost dominated the budget.
// 1.25 cuts rasterized pixels ~50% vs 1.75 (1.25²/1.75² = 0.51). Visual hit on
// retina is mild because the camera is ortho — geometric edges are already
// post-AA'd by the bloom downsample chain.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
renderer.setSize(W, H);
renderer.outputColorSpace = THREE.SRGBColorSpace;
// ACES Filmic rolls highlights into warm tones — kills the "everything blooms" feel.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
// Soft shadow maps — enabled only for hero / chests / bosses (the "important"
// actors); swarm enemies keep blob shadows for perf (200 caster meshes would
// cost ~3-5ms/frame on a low-end machine).
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = true;
// renderer.info is now consumed by perfHUD.js (F3 overlay). We keep autoReset
// off and call `renderer.info.reset()` once per frame (before the bloom pass),
// so the counters accumulate across both passes — autoReset would reset
// between passes and leak the bloom-pass numbers.
renderer.info.autoReset = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color(WORLD.bgColor);
scene.fog = new THREE.Fog(WORLD.bgColor, WORLD.fogNear, WORLD.fogFar);

// Orthographic camera, isometric-ish (matches original game's TD view)
const camera = new THREE.OrthographicCamera(
  -WORLD.cameraDistance * ASPECT(), WORLD.cameraDistance * ASPECT(),
   WORLD.cameraDistance,            -WORLD.cameraDistance,
   0.1, 800
);
// Match original kitty-kaki forest camera offset (40, 60, 40 looking at origin).
camera.position.set(40, 60, 40);
camera.lookAt(0, 0, 0);

state.scene = scene; state.camera = camera; state.renderer = renderer;

// Post-FX composer (with selective-bloom layer pipeline)
const { composer, bloomComposer, bloomPass, postFXPass } = createComposer(renderer, scene, camera, W, H);
state.composer = composer; state.bloomComposer = bloomComposer;
state.bloomPass = bloomPass; state.postFXPass = postFXPass;

// Resize
window.addEventListener('resize', () => {
  W = window.innerWidth; H = window.innerHeight;
  renderer.setSize(W, H);
  const a = ASPECT();
  camera.left = -WORLD.cameraDistance * a; camera.right = WORLD.cameraDistance * a;
  camera.top = WORLD.cameraDistance;        camera.bottom = -WORLD.cameraDistance;
  camera.updateProjectionMatrix();
  resizeComposer(composer, bloomPass, postFXPass, W, H, bloomComposer);
});

// Render helper: bloom-only pass first (layer mask), then full scene.
const _bgBlack = new THREE.Color(0x000000);
function renderFrame() {
  // Reset renderer.info once per frame so perfHUD reads bloom+composite total.
  renderer.info.reset();
  // 1) Bloom-only render — mask to BLOOM_LAYER, black background, no fog
  const savedBg = scene.background;
  const savedFog = scene.fog;
  scene.background = _bgBlack;
  scene.fog = null;
  camera.layers.set(BLOOM_LAYER);
  bloomComposer.render();
  // 2) Restore + full scene composite
  scene.background = savedBg;
  scene.fog = savedFog;
  camera.layers.enableAll();
  composer.render();
}

// Unlock audio on first interaction
['click', 'touchstart', 'keydown'].forEach(ev =>
  window.addEventListener(ev, unlockAudio, { once: true })
);

// ── URL replay-seed parsing ──────────────────────────────────────────────────
// Format produced by leaderboard.makeSeed(): `<S>-<CC>-<MM>[-yy-mm-dd]` where
// S = stage first char, CC = char first two chars, MM = mode first two chars.
// We reverse the prefix tokens by matching against CHARACTERS/STAGES ids so a
// future renamed stage/char doesn't silently misroute. The date suffix is
// informational only — players can replay any day's seed, not just today's.
// Defensive: malformed seed = no-op + console.warn (do NOT throw on boot).
function _parseReplaySeedFromURL() {
  if (typeof window === 'undefined' || !window.location) return;
  const params = new URLSearchParams(window.location.search || '');
  const seed = params.get('seed');
  if (!seed) return;
  const parts = seed.split('-');
  if (parts.length < 3) { console.warn('[replaySeed] malformed (need 3+ tokens):', seed); return; }
  const [sTok, cTok, mTok] = parts;

  const stage = STAGES.find(s => (s.id || '').toUpperCase().startsWith(sTok));
  const char  = CHARACTERS.find(c => (c.id || '').toUpperCase().startsWith(cTok));
  if (!stage || !char) {
    console.warn('[replaySeed] unknown stage/char tokens:', sTok, cTok);
    return;
  }
  // Mode mapping (2-char prefix of the makeSeed mode string).
  // 'NM'→normal, 'HY'→hyper, 'EN'→endless, 'DA'→daily, 'BO'→boss-rush, 'WE'→weekly
  const MODE_MAP = { NM: 'normal', HY: 'hyper', EN: 'endless', DA: 'daily', BO: 'boss-rush', WE: 'weekly' };
  const mode = MODE_MAP[mTok] || 'normal';

  setOption('selectedStage', stage.id);
  setOption('selectedChar',  char.id);
  // We deliberately do NOT toggle optHyper/optDaily/etc here — letting the
  // user opt into a mode is a deliberate click. The selection just preloads
  // stage + character.
  state.replaySeed = { seed, stage: stage.id, character: char.id, mode };
}

// ── Async init ────────────────────────────────────────────────────────────────

async function boot() {
  // URL param `?seed=F-KI-NM-26-05-13` lets a player open a friend's run with
  // the stage + character + mode preselected. We DON'T start the run — just
  // stamp meta so the character picker reflects the seed, and stash a
  // state.replaySeed for 9c's "Replaying X's run" header.
  try { _parseReplaySeedFromURL(); } catch (e) { console.warn('[boot.replaySeed]', e); }

  showStartScreen('Loading…');
  initParticleTextures();   // synchronous canvas → texture, no network
  await preloadAll();
  // iter 33w — load the hand-painted FX manifest before initFX so synchronous
  // fxTex('ring_arcane') calls during init hit the WebP path, not the canvas
  // fallback. Texture image data still arrives async; the manifest fetch is
  // small (~1 KB) and happens in parallel with preloadAll above.
  try {
    const { fxAwait } = await import('./fxTextures.js');
    await fxAwait();
  } catch (e) {
    console.warn('[boot.fxTex]', e);
  }

  state.envGroup = buildEnv(scene, renderer);
  buildTown(scene);
  buildInterior(scene);
  buildCasinoInterior(scene);
  buildCatacomb(scene);

  initInput();
  initUI();
  initDamageNumbers();
  initFX(scene);
  // Ascension Evolution FX (Punch List #1) needs a state handle so the
  // 30s player rim can follow state.hero.pos without a static import cycle.
  setEvolveBurstStateRef(state);
  // Dissolve-to-Gold death FX (Punch List #3). Init the pre-pooled
  // InstancedMesh (cap 256, ZERO per-death allocation) and wire the state
  // handle so `state.run.lowFx` can short-circuit the spawn path. Must run
  // AFTER the scene exists (initFX above) and BEFORE initEnemies binds the
  // killEnemy hook (defensive; init is idempotent so order is forgiving).
  initDissolveBurst(scene);
  setDissolveBurstStateRef(state);
  initVFXBurst(scene);
  initTotems(scene);
  initPylons(scene);
  initBells(scene);
  initEnemyTells(scene);
  initStageHazards(scene);
  initMiniEvents(scene);
  initArenaProps(scene);
  initChests(scene);
  initPickups(scene);
  initBossTelegraphs(scene);
  initDestructibles(scene);
  initPerfHUD();
  initBlobShadows(scene);
  initHero(scene);
  initEnemies(scene);
  initWeapons();
  initProjectileVisuals(scene);
  initXP(scene);
  initSpawnDirector();

  prewarmPools();   // create pooled meshes off-screen (hides first-horde stall)

  resetState();
  resetZoom();      // every run starts fully zoomed in; powerup unlocks notches
  resetChests();
  resetPickups();
  applyMetaUpgrades();

  // Give the character's starting weapon (defaults to orbitals if none set).
  acquireWeapon(state.run.starterWeapon || 'orbitals');
  for (let i = 0; i < (state.run.cellarLv || 0); i++) acquireWeapon(state.run.starterWeapon || 'orbitals');

  showStartScreen('Press Play to begin');
  // ── Iter 10a — Apply saved options at boot ──
  const meta = getMeta();
  // Honor OS prefers-reduced-motion on FIRST boot only (sentinel:
  // optReduceMotionUserSet). After the user explicitly toggles the option,
  // their choice always wins over the OS hint.
  try {
    if (!meta.optReduceMotionUserSet
        && typeof window !== 'undefined'
        && typeof window.matchMedia === 'function') {
      const mm = window.matchMedia('(prefers-reduced-motion: reduce)');
      if (mm && mm.matches) {
        meta.optReduceMotion = true;
      }
    }
  } catch (_) {}
  // Mirror reduce-motion + reduced-flashing into state caches for per-frame reads.
  state._optReduceMotion   = !!meta.optReduceMotion;
  state._optReducedFlashing = !!meta.optReducedFlashing;
  // Shake multiplier: reduce-motion forces 0 regardless of optShake slider.
  state._optShakeMul = state._optReduceMotion ? 0 : Number(meta.optShake);
  // Audio mix split — push all three buses from meta. Legacy setVolume() is
  // a back-compat shim that aliases setMasterVolume; we call the explicit
  // setters here so the new keys win when both are present.
  setMasterVolume(meta.optMasterVolume != null ? meta.optMasterVolume : meta.optVolume);
  setMusicVolume(meta.optMusicVolume != null ? meta.optMusicVolume : (meta.optVolume * 0.6));
  setSfxVolume(meta.optSfxVolume != null ? meta.optSfxVolume : meta.optVolume);
  // Accessibility uniforms (chromatic gate + colorblind remap + high contrast).
  applyAccessibilityOptions(state.postFXPass, {
    reduceMotion: state._optReduceMotion,
    colorblind:   meta.optColorblind,
    highContrast: !!meta.optHighContrast,
  });
  // Font scale CSS var.
  try {
    if (typeof document !== 'undefined' && document.documentElement) {
      const fs = Number(meta.optFontScale);
      document.documentElement.style.setProperty('--kk-font-scale',
        Number.isFinite(fs) ? String(Math.max(0.6, Math.min(1.6, fs))) : '1');
    }
  } catch (_) {}
  // Visibility / focus handling — suspend the audio context when the tab is
  // hidden, resume + retrigger menu bed when it returns. menuBed itself is
  // auto-managed by audio.js's mode poller started inside unlockAudio().
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        suspendAudio();
      } else {
        resumeAudio();
      }
    });
  }

  const start = async () => {
    if (state.started && state.mode === 'run') return;
    // iter 33y — ensure the selected avatar GLB is loaded BEFORE rebuildHero
    // runs (which clones from GLTF_CACHE). If the user picked a non-default
    // avatar in the carousel and clicked Play before its lazy fetch landed,
    // we wait here and dispose all other hero_* cache entries to free VRAM.
    try { await _ensureSelectedAvatarLoaded(); } catch (_) {}
    try { _disposeUnselectedAvatars(); } catch (_) {}
    state.started = true;
    if (state.mode === 'town') exitTown();
    state.mode = 'run';
    // Mid-run flavor: arena props at run start, mini-events scheduler reset.
    resetMiniEvents();
    spawnArenaProps();
    // Iter 10b — Greed tier-4 capstone: idempotent across run-entry paths
    // (restartRun calls _primeRunStart which also calls this; first-from-menu
    // skips _primeRunStart and lands here directly). The guard inside the
    // helper prevents double-spawn.
    _maybeSpawnTreasureMapChest();
    // Player may have changed character on the picker — rebuild hero so the
    // placeholder tint reflects the current selection.
    rebuildHero(state.scene);
    hideStartScreen();
    state.run.startedAt = performance.now();
    if (meta.optMusic) startMusic();
    setMusicTier(0);
    if (state.modes && state.modes.bossRush) {
      showBanner('⚔ BOSS RUSH ⚔', 3.0, '#ff7a7a');
    } else if (state.modes && state.modes.daily) {
      showBanner('★ DAILY CHALLENGE ★', 3.0, '#c87bff');
    }
    // Tutorial disabled by user request — how-to-play.html covers new players.
  };
  setGateHandler(start);
  setInteractionHandler('house', () => enterInterior());
  setInteriorHandler('exit', () => { exitInterior(); enterTown(); });
  setInteriorHandler('house', () => showHouse());
  setInteriorHandler('sketch', () => showSketchbook());
  setInteriorHandler('yarn',   () => showYarnDart());
  setInteriorHandler('tea',    () => showTeaSteep());
  setInteriorHandler('computer', () => showQuestBoard());
  // Iter 33g — walkable casino interior. Town casino interactable now enters
  // a real room (sibling of the house) instead of opening the dashboard modal
  // directly. Stations inside route to the same modal sections.
  setInteractionHandler('casino', () => {
    // Settle any in-flight Boss Rush wager before entering (legacy code path).
    import('./casino.js')
      .then(({ settlePendingWager }) => { try { settlePendingWager(); } catch (_) {} })
      .catch(() => {});
    enterCasinoInterior();
  });
  setCasinoInteriorHandler('exit',   () => { exitCasinoInterior(); enterTown(); });
  setCasinoInteriorHandler('slots',  () => showCasinoSlots());
  setCasinoInteriorHandler('parlay', () => showCasinoParlay());
  setCasinoInteriorHandler('buffs',  () => showCasinoMenu('buffs'));
  setCasinoInteriorHandler('house',  () => showCasinoMenu('house'));
  window.kkStartRun = start;
  window.kkEnterTown = () => {
    hideStartScreen();
    enterTown();
    state.started = true;   // bypass start-screen idle render path
  };
  // Click/Space only triggers a run when on the start screen (menu mode).
  // In town mode they're no-ops — player uses E at the gate.
  // Iter 32e — explicit-button-only start. No Space hotkey, no window
  // click-to-start: Play (menu) → Start Run (select) is the only path.
  // Avoids accidental run starts and matches the redesigned UX.
  window.addEventListener('keydown', e => {
    if (e.code === 'Escape') {
      if (isQuestBoardOpen()) hideQuestBoard();
      else if (isHouseOpen()) hideHouse();
      else if (state.mode === 'interior') { exitInterior(); enterTown(); }
      else if (state.mode === 'casino_interior') { exitCasinoInterior(); enterTown(); }
      else if (state.mode === 'catacomb') { exitCatacomb(); }
      else if (isShopOpen()) hideShop();
      else if (isGrimoireOpen()) hideGrimoire();
      else if (typeof isCreditsOpen === 'function' && isCreditsOpen()) hideCredits();
      else if (typeof isCodexOpen === 'function' && isCodexOpen()) hideCodex();
      else if (isOptionsOpen()) hideOptions();
      else if (state.started && !state.gameOver) showOptions();
    }
  });

  // ── F1 hotkey: open Codex from anywhere except mid-modal ───────────────────
  // F1 is the universal "help / index" key — surfacing the Codex (which holds
  // the affix Legend, enemy bestiary, weapon recipes, etc.) without a click.
  // Only fires when no competing modal owns input.
  window.addEventListener('keydown', e => {
    if (e.code !== 'F1') return;
    // Skip if any major modal owns focus.
    if (isCodexOpen && isCodexOpen()) { hideCodex(); e.preventDefault(); return; }
    if ((typeof isCreditsOpen === 'function' && isCreditsOpen())
        || isShopOpen() || isGrimoireOpen() || isHouseOpen()
        || isOptionsOpen() || isQuestBoardOpen()) {
      return;
    }
    // Don't preempt browser dev help if the user holds modifiers.
    if (e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    showCodex();
  });

  // ── Iter 23a + Iter 27 — suppress browser context menu globally ───────────
  // Right-click is a gameplay input (e.g. homeDecor pickup) — players never
  // need the browser context menu inside the game. Canvas-only suppression
  // (iter 23a) missed right-clicks on overlay DOM (decorate palette, modals).
  // Window-level catch-all covers everything; per-element handlers in
  // homeDecor.js / casino.js etc. still run their own logic on top.
  canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); }, false);
  window.addEventListener('contextmenu', (e) => { e.preventDefault(); }, false);

  // ── WebGL context-loss / restored — canvas-level wiring ────────────────────
  // canvas is captured at module top (const canvas = ...). preventDefault on
  // the loss event lets the browser ATTEMPT a restore; without it the loss is
  // permanent. We pause logic, show a red modal, and on restore call the
  // rebuild stub (iter 10: safe-fallback page reload — see helper below).
  canvas.addEventListener('webglcontextlost', (e) => {
    console.error('[webgl] context lost');
    try { e.preventDefault(); } catch (_) {}
    if (state && state.time) state.time.paused = true;
    try { showContextLossModal(); } catch (err) { console.error(err); }
  }, false);

  canvas.addEventListener('webglcontextrestored', () => {
    console.warn('[webgl] context restored');
    try { rebuildAfterContextLoss(); } catch (err) { console.error(err); }
    try { hideContextLossModal(); } catch (_) {}
    if (state && state.time) state.time.paused = false;
  }, false);

  // Expose restart for the death-screen RETRY button. Avoids a full page reload
  // (which throws away the prewarmed pools + cached GLBs).
  window.kkRestart = restartRun;
  // After death, take the player to town instead of restarting the run.
  // Same state cleanup, then enter the hub for shop/house/statues access.
  window.kkReturnToTown = () => {
    _teardownActiveRun();
    _primeRunStart();        // hero is alive + statted up, ready for next gate-press
    enterTown();              // sets state.mode='town', positions hero at gate
    state._deathShown = false;
    state.started = true;     // bypass start-screen idle render path
    // Show an arrival toast surfacing what the run earned.
    if (window._kkLastRunSummary) _showTownArrivalToast(window._kkLastRunSummary);
  };
  // Return-to-main-menu — pauses any run, leaves town/interior/catacomb if
  // we're in one, drops back to the start screen so the player can rebind
  // character/stage/options before re-entering. Used by the death-screen and
  // pause-menu Return-to-Menu buttons (iter 29).
  window.kkReturnToMenu = () => {
    try { _teardownActiveRun(); } catch (_) {}
    // Exit any sub-mode so the start screen renders cleanly.
    try {
      if (state.mode === 'town')              exitTown();
      if (state.mode === 'interior')          exitInterior();
      if (state.mode === 'casino_interior')   exitCasinoInterior();
      if (state.mode === 'catacomb')          exitCatacomb();
    } catch (_) {}
    state.mode = 'menu';
    state.started = false;
    state._deathShown = false;
    state.time.paused = false;
    try { hideOptions(); } catch (_) {}
    showStartScreen('Press Play to begin');
  };
  window.__kkNextMiniBoss = secondsUntilNextMiniBoss;
  // Iter 17 — Helltide debug hook. Lets the player (and QA) force-trigger the
  // overlay event from DevTools. Returns true if it fired, false if a helltide
  // was already active or scene isn't ready.
  window.kkTriggerHelltide = () => {
    return import('./helltide.js').then(({ triggerHelltide }) => triggerHelltide());
  };
  window.kkEndHelltide = () => {
    return import('./helltide.js').then(({ endHelltide }) => endHelltide());
  };
}

function _teardownActiveRun() {
  // Tutorial: stage 6 (shop hint) fires on first death/run-end.
  try { notifyTutorialEvent('runEnd'); } catch (_) {}

  // Return active enemies to pools + hide them
  const active = state.enemies.active;
  for (let i = 0; i < active.length; i++) {
    const e = active[i];
    if (!e || !e.mesh) continue;
    e.alive = false;
    e.mesh.visible = false;
    if (e._tellRing) {
      if (e._tellRing.parent) e._tellRing.parent.remove(e._tellRing);
      e._tellRing = null;
    }
    // Totems, pylons, bells aren't pooled — unique geometries. Detach;
    // reset* functions clear their respective lists.
    if (e.isTotem || e.isPylon || e.isBell) {
      if (e.mesh.parent) e.mesh.parent.remove(e.mesh);
      continue;
    }
    const pool = state.enemies.pools[e.glbKey] || (state.enemies.pools[e.glbKey] = []);
    pool.push(e.mesh);
  }
  active.length = 0;
  if (state.enemies.spatial && typeof state.enemies.spatial.clear === 'function') {
    state.enemies.spatial.clear();
  }
  // iter 33u — projectile meshes are off-scene position handles; visuals
  // live in InstancedMesh slots and must be returned to the free pool.
  for (const p of state.projectiles.active) {
    try { releaseProjectileVisuals(p); } catch (_) {}
    if (p.mesh && p.mesh.parent) p.mesh.parent.remove(p.mesh);
  }
  state.projectiles.active.length = 0;
  // Clear enemy projectiles too
  for (const p of state.enemyProjectiles.active) {
    if (p.mesh && p.mesh.parent) p.mesh.parent.remove(p.mesh);
  }
  state.enemyProjectiles.active.length = 0;
  // Clear webs (visual is hidden by tickWebs since list is empty)
  if (state.webs && state.webs.list) state.webs.list.length = 0;

  // Tear down arena decor (re-built when the next run's stage tint applies).
  if (state.scene) clearArenaDecor(state.scene);
  // Stop the stage ambient bed — re-armed when the next run picks its stage.
  playStageAmbient(null);
  // Tear down forest amber alongside decor (no-op on non-forest stages).
  if (state.scene) clearForestAmber(state.scene);
  // Drop forest slow-zones too — paired with amber since both key off the
  // same hotspot JSON. No-op on non-forest stages.
  if (state.scene) clearForestHazards(state.scene);
  // Tear down twilight fountains (no-op on non-twilight stages). Mirrors
  // the forestAmber teardown shape; clear path also nulls
  // state.run.fountainSpeedBuff so the buff can't leak across runs.
  if (state.scene) clearTwilightFountains(state.scene);
  // Drop twilight slow-zones too — paired with fountains since both key off
  // the same hedge derivation. No-op on non-twilight stages.
  if (state.scene) clearTwilightHazards(state.scene);
  // Tear down cinder ballistas (no-op on non-cinder stages). Per-entity
  // activation flags live on _ballistas; wiping the array wipes the activation
  // state alongside it, so nothing leaks across runs.
  if (state.scene) clearCinderBallistas(state.scene);
  // Drop cinder slow-zones too — paired with ballistas since both key off the
  // same catapult derivation. No-op on non-cinder stages.
  if (state.scene) clearCinderHazards(state.scene);
  // Tear down void teleport pads (no-op on non-void stages). Per-entity
  // cooldown timestamps live on _pads; wiping the array wipes the cooldown
  // state alongside it, so nothing leaks across runs.
  if (state.scene) clearVoidTeleportPads(state.scene);
  // Drop any live Ascension burst + 30s player rim. Mirrors the chainFx
  // teardown shape; matters when the player dies mid-rim (would otherwise
  // ghost-attach a glowing ring to the next run's hero spawn position).
  if (state.scene) disposeAllEvolveBursts(state.scene);
  // Punch List #3 — drop any live dissolve burst slots so a stranded gold-
  // dust mote from the last enemy doesn't ghost into the next run's
  // pre-spawn camera frame. The InstancedMesh itself stays alive (it's
  // reused across runs — same shape as fx.js kill ring init pattern).
  if (state.scene) disposeAllDissolveBursts(state.scene);
  // Punch List #7 — Velocity Veil ribbon trail. Drop any live ribbon
  // segments + descriptors so a stranded fountain trail can't ghost into
  // the next run's hero spawn position. Mirrors the dissolveBurst teardown
  // shape — the InstancedMesh itself stays alive for re-use.
  if (state.scene) disposeAllVelocityVeils(state.scene);

  // Finalize Helltide BEFORE resetState wipes its state. teardownHelltide
  // reads state.run.helltideActive + helltideEmbersBanked to credit lifetime
  // stats; if resetState fires first those flags are gone and the credit
  // never happens (Codex review found this defeated the iter 20 fix).
  // teardownMiniEvents calls into teardownHelltide internally.
  teardownMiniEvents();

  // Reset core state (clears weapons, fillerCounts, etc.)
  resetState();
  resetZoom();
  resetChests();
  resetPickups();
  resetVFXBurst();
  resetTotems();
  resetPylons();
  resetBells();
  resetEnemyTells();
  resetStageHazards();
  clearStageRule(state);
  resetArenaProps();
  resetCatacomb();
  resetBossTelegraphs();
  resetDestructibles();
  initSpawnDirector();
  _resetEvoAnnouncements();
  _resetSecretChecks();
}

function _primeRunStart() {
  // Snapshot active quest progress so the town arrival toast can show
  // exactly how much each bounty advanced during the run that just ended.
  try {
    const meta = getMeta();
    const active = (meta.quests && meta.quests.active) || [];
    window._kkQuestSnapshot = active.map(q => ({ id: q.id, progress: q.progress || 0 }));
  } catch (_) { window._kkQuestSnapshot = []; }
  // Rebuild hero mesh so a newly-picked character's placeholder tint applies.
  rebuildHero(state.scene);
  applyMetaUpgrades();
  // Iter 10b — Greed tier-4 capstone fires here so the chest is in the world
  // BEFORE the spawn director starts the wave. The guard makes the call
  // idempotent across the menu→start path that ALSO calls it.
  _maybeSpawnTreasureMapChest();
  // Re-give the selected character's starter weapon (+ Cellar bonus levels)
  acquireWeapon(state.run.starterWeapon || 'orbitals');
  for (let i = 0; i < (state.run.cellarLv || 0); i++) acquireWeapon(state.run.starterWeapon || 'orbitals');
  // Restore hero visuals (death anim mutated opacity + scale)
  if (state.hero.mesh) {
    state.hero.mesh.traverse(o => {
      if (o.isMesh && o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) { if (m.opacity !== undefined) m.opacity = 1; }
      }
    });
  }
  // Activate the chosen stage's gameplay rule (per-stage modifier).
  try {
    const sid = state.run && state.run.stage && state.run.stage.id;
    if (sid) applyStageRule(sid, state);
  } catch (_) {}
}

// Tiny HTML escape so quest names don't break the toast if a future template
// happens to include a special character.
function escapeHtmlS(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Paper-styled arrival toast shown briefly after returning to town from a run.
// Surfaces what the previous run earned so the upgrade decision is easy.
function _showTownArrivalToast(s) {
  // Reuse an existing toast slot if there is one (dismiss-replace pattern)
  const old = document.getElementById('kk-town-arrival');
  if (old && old.parentNode) old.parentNode.removeChild(old);
  const div = document.createElement('div');
  div.id = 'kk-town-arrival';
  const lines = [];
  if (s.victory) lines.push(`<div style="font-family:'Cinzel Decorative',serif;font-size:13px;letter-spacing:0.28em;color:#ffd24a;text-transform:uppercase;margin-bottom:4px;">★ Victory</div>`);
  lines.push(`<div style="font-family:'Cinzel Decorative',serif;font-size:22px;font-weight:900;letter-spacing:0.12em;color:#231a14;">Welcome back to the village.</div>`);
  lines.push(`<div style="font-family:'Inter',sans-serif;font-size:13px;color:#5a4838;margin-top:6px;letter-spacing:0.08em;">From that hunt:</div>`);
  lines.push(`<div style="font-family:'JetBrains Mono',monospace;font-size:15px;color:#231a14;margin-top:4px;display:flex;gap:18px;justify-content:center;">
    <span>+${s.coinsEarned} 🪙</span>
    <span>+${s.embersEarned} 🔥</span>
    <span>${s.kills} kills</span>
    <span>${Math.floor(s.time/60)}:${String(Math.floor(s.time%60)).padStart(2,'0')}</span>
  </div>`);
  if (s.unlockedCinder) lines.push(`<div style="margin-top:8px;color:#ff7a3a;font-family:'Cinzel Decorative',serif;font-size:12px;letter-spacing:0.24em;">🜂 Cinder Caverns unlocked</div>`);
  if (s.unlockedHyper)  lines.push(`<div style="margin-top:6px;color:#ff5555;font-family:'Cinzel Decorative',serif;font-size:12px;letter-spacing:0.24em;">🔥 Hyper unlocked</div>`);
  if (s.unlockedEndless)lines.push(`<div style="margin-top:6px;color:#7fffe4;font-family:'Cinzel Decorative',serif;font-size:12px;letter-spacing:0.24em;">♾ Endless unlocked</div>`);
  // Quest progress deltas — diff against the snapshot taken at run start.
  try {
    const snap = window._kkQuestSnapshot || [];
    const snapMap = new Map(snap.map(q => [q.id, q.progress]));
    const meta = getMeta();
    const active = (meta.quests && meta.quests.active) || [];
    const rows = [];
    for (const q of active) {
      const before = snapMap.get(q.id) || 0;
      const delta = (q.progress || 0) - before;
      if (delta <= 0) continue;
      const tpl = QUEST_TEMPLATES.find(t => t.id === q.id);
      if (!tpl) continue;
      const ready = q.progress >= tpl.goal;
      const color = ready ? '#ffae6a' : '#5a8a3a';
      rows.push(`<div style="font-family:'JetBrains Mono',monospace;font-size:12px;color:${color};display:flex;justify-content:space-between;gap:14px;">
        <span style="opacity:0.78;">${tpl.icon} ${escapeHtmlS(tpl.name)}</span>
        <span>+${delta}  ${q.progress}/${tpl.goal}${ready ? '  ★' : ''}</span>
      </div>`);
    }
    if (rows.length > 0) {
      lines.push(`<div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(35,26,20,0.25);font-family:'Inter',sans-serif;font-size:11px;letter-spacing:0.22em;color:#5a4838;text-transform:uppercase;text-align:left;">Quest progress</div>`);
      lines.push(`<div style="margin-top:4px;display:flex;flex-direction:column;gap:2px;text-align:left;">${rows.join('')}</div>`);
    }
  } catch (_) {}
  div.innerHTML = lines.join('');
  div.style.cssText = `
    position: fixed; top: 8%; left: 50%; transform: translateX(-50%);
    padding: 18px 32px; pointer-events: none; z-index: 95;
    background: linear-gradient(180deg, rgba(243,232,207,0.96), rgba(217,202,170,0.95));
    border: 1px solid rgba(35,26,20,0.6); border-radius: 10px;
    box-shadow: 0 8px 28px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.55);
    text-align: center; min-width: 360px;
    opacity: 0; transform: translateX(-50%) translateY(-12px);
    transition: opacity 0.35s ease, transform 0.35s ease;
  `;
  document.body.appendChild(div);
  // Animate in
  requestAnimationFrame(() => {
    div.style.opacity = '1';
    div.style.transform = 'translateX(-50%) translateY(0)';
  });
  // Auto-dismiss after 5s
  setTimeout(() => {
    div.style.opacity = '0';
    div.style.transform = 'translateX(-50%) translateY(-12px)';
    setTimeout(() => { if (div.parentNode) div.parentNode.removeChild(div); }, 500);
  }, 5000);
}

async function restartRun() {
  // iter 33y — re-loading a non-default avatar is the most common reason a
  // restart would otherwise spawn the donor model; await the lazy fetch.
  try { await _ensureSelectedAvatarLoaded(); } catch (_) {}
  try { _disposeUnselectedAvatars(); } catch (_) {}
  _teardownActiveRun();
  _primeRunStart();
  resetMiniEvents();
  spawnArenaProps();
  state.mode = 'run';
  state._deathShown = false;
  state.started = true;
  state.run.startedAt = performance.now();
}

// iter 33y — hero-cache helpers.
async function _ensureSelectedAvatarLoaded() {
  const meta = getMeta();
  const id = meta.selectedAvatar || 'kitty';
  const av = AVATARS.find(a => a.id === id);
  if (!av || !av.glb) return;        // donor-model avatar — already loaded
  const key = `hero_${id}`;
  if (GLTF_CACHE[key]) return;
  await lazyLoadGLTF(key, BASE + av.glb);
}
function _disposeUnselectedAvatars() {
  const meta = getMeta();
  const sel = meta.selectedAvatar || 'kitty';
  for (const av of (AVATARS || [])) {
    if (av.id === sel || !av.glb) continue;
    disposeCachedGLTF(`hero_${av.id}`);
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

let _lastT = performance.now();
// Per-run one-shot secret-check guards (reset on restart via _resetSecretChecks)
let _checkedUntouchable = false;
let _checkedMarathon = false;
let _checkedHoarder = false;
export function _resetSecretChecks() {
  _checkedUntouchable = false;
  _checkedMarathon = false;
  _checkedHoarder = false;
}

// Apply the player's purchased shop upgrades to hero stats at run start.
// Called after resetState (which wipes mutators).
function applyMetaUpgrades() {
  const h = state.hero;
  const meta = getMeta();
  // Mode exclusivity — Weekly takes precedence over Daily/BossRush so a leaderboard
  // entry can't be tagged with two competing modifier sets. We *don't* mutate the
  // saved options (no setOption here) so the user's toggles persist when they
  // switch back; we just suppress the others for this run.
  const weeklyOn = !!(meta && meta.optWeekly);
  const dailyOn = !weeklyOn && !!(meta && meta.optDaily);
  // Iter 34 — Phase C: gameplay derives from the selected avatar's
  // baseArchetype, not from a separate "selectedChar" archetype pick. The
  // archetype lookup table (CHARACTERS) still holds the signature functions
  // until Phase D/F replaces them with per-avatar bespoke kits. Daily
  // challenge still uses the legacy archetype-id pool — it shuffles WHICH
  // archetype the run is locked to, so we override avatar.baseArchetype just
  // for this run.
  const avatar = selectedAvatar(AVATARS) || AVATARS[0];
  let char = archetypeForAvatar(avatar);
  let dailyCfg = null;
  if (dailyOn) {
    dailyCfg = dailyChallengeConfig(CHARACTERS.map(c => c.id));
    char = CHARACTERS.find(c => c.id === dailyCfg.character) || char;
  }
  if (char) {
    h.hpMax = char.hpMax || h.hpMax;
    h.hp = h.hpMax;
    for (const k of Object.keys(char.statMul || {})) {
      h.statMul[k] = (h.statMul[k] || 1) * char.statMul[k];
    }
    state.run.character = char.id;        // archetype id (legacy field; leaderboards read this)
    state.run.avatar    = avatar.id;      // canonical identity going forward
    // Iter 34 — Phase D: if the avatar's bespoke signature weapon module is
    // registered (cowboy/mothman/space in Phase D; rest in F), start the run
    // with that instead of the archetype's generic starter. WEAPON_REGISTRY
    // gates the swap so Phase-F-pending kits fall back cleanly.
    const sigId = avatar.signatureWeapon;
    const sigRegistered = !!(sigId && WEAPON_REGISTRY[sigId]);
    state.run.starterWeapon = sigRegistered ? sigId : char.starter;
    state.run.signatureWeapon = sigId || null;
    state.run.signatureRegistered = sigRegistered;
    if (typeof char.signature === 'function') {
      try { char.signature(state.run); } catch (e) { console.warn('[char.signature]', e); }
    }
  }
  state.run.daily = dailyOn ? dailyCfg : null;

  // Iter 9: weekly mutator stamps state.run.weekly* fields read by spawnDirector,
  // enemies.spawnEnemy, xp.js (gem-value mul), and weaponChoices (NO_PASSIVES).
  // Like Daily, weekly suppresses shop bonuses for a fair leaderboard.
  // _weeklyCommitted is a per-run one-shot guard for the run-end commit below.
  state.run._weeklyCommitted = false;
  if (weeklyOn) {
    const cfg = weeklyMutatorConfig();
    const mutator = applyWeeklyMutator(state.run, cfg.mutatorId);
    state.run.weekly = { weekKey: cfg.weekKey, mutatorId: cfg.mutatorId, mutatorLabel: cfg.mutatorLabel };
    if (!mutator) console.warn('[weekly] unknown mutator', cfg.mutatorId);
  } else {
    state.run.weekly = null;
  }

  // Fair-leaderboard gate: Daily AND Weekly both suppress shop/house/relic
  // bonuses so the run is character-only + active modifier (daily challenge
  // tweak or weekly mutator). Centralized so adding future leaderboard modes
  // is a one-liner.
  const runFair = dailyOn || weeklyOn;
  if (!runFair) {
    // Shop upgrades stack on top (skipped in daily/weekly for fair leaderboard)
    const hpLv = shopLevel('hp');
    if (hpLv > 0) { h.hpMax += 10 * hpLv; h.hp = h.hpMax; }
    const magLv = shopLevel('magnet');
    if (magLv > 0) h.statMul.magnet *= (1 + 0.15 * magLv);
    const spdLv = shopLevel('speed');
    if (spdLv > 0) h.statMul.moveSpeed *= (1 + 0.05 * spdLv);
    const dmgLv = shopLevel('damage');
    if (dmgLv > 0) h.statMul.dmg *= (1 + 0.05 * dmgLv);
  } else if (dailyOn) {
    // Daily modifier: apply a small thematic tweak so each day plays distinctly
    switch (dailyCfg.modifier) {
      case 'LOW HP':       h.hpMax = Math.max(30, Math.floor(h.hpMax * 0.6)); h.hp = h.hpMax; break;
      case 'SWARM DAY':    state.run.dailySpawnMul = 1.35; break;
      case 'HARDER SPAWNS':state.run.dailyHpMul = 1.5; break;
      case 'FAST CHESTS':  state.run.dailyChestMul = 0.5; break;
      // 'NO SHOP BONUSES' is the implicit default — already covered above.
    }
  }
  // Weekly mutator was already applied above (stamps state.run.weekly*); no
  // per-mutator dispatch here — readers in spawnDirector / xp / enemies do the work.

  // ── House upgrades (Embers currency) — apply regardless of daily mode since
  // they represent long-term home investment, not run-specific shop bonuses.
  // Some upgrades still respect daily/weekly for fairness (handled per-track below).
  const house = (meta.house || {});
  const kitchenLv  = house.kitchen  || 0;
  const cellarLv   = house.cellar   || 0;
  const gardenLv   = house.garden   || 0;
  const shrineLv   = house.shrine   || 0;
  const apoLv      = house.apothecary || 0;
  if (kitchenLv  > 0 && !runFair) { h.hpMax += 20 * kitchenLv; h.hp = h.hpMax; }
  // Cellar gets applied after acquireWeapon runs (see below). Stash on run.
  state.run.cellarLv = (cellarLv > 0 && !runFair) ? cellarLv : 0;
  if (gardenLv   > 0 && !runFair) state.run.heartPotency = 1 + 0.5 * gardenLv;
  if (shrineLv   > 0 && !runFair) h.rerolls += shrineLv;
  if (apoLv      > 0 && !runFair) h.regenPerSec += 0.5 * apoLv;

  // ── Shop Tree (iter 6 "Meta With Teeth") — bake each owned node's effect
  // into runState passive_* scalars + flags. Suppressed in daily/weekly for
  // the same fair-leaderboard reason as the flat shop bonuses above. Without
  // this loop the three tier-4 capstones (Phoenix / Overdrive / Treasure Map)
  // along with every lower-tier node would silently do nothing — see iter 10b
  // brief, "single biggest broken promise in the codebase".
  if (!runFair) {
    const ownedTree = meta.shopTree || {};
    for (const node of SHOP_TREE) {
      if (!ownedTree[node.id]) continue;
      try { node.effect(state.run); } catch (err) {
        console.warn('[shopTree effect]', node.id, err);
      }
    }
    // Phoenix tier-4 capstone cap: hard-limit revives at 6. Brief specs
    // `Math.min(6, passive_revives)` literally — the tuning row mentions
    // "4 base + 2 vault levels" but house.vault is the coin-bonus track
    // (max 3, +25%/lv end-of-run coins), unrelated to revives. The clamp
    // therefore lands at a flat 6, applied AFTER the loop so a future
    // node that adds revives still gets trimmed. Cheating-proof against
    // console pokes after applyMetaUpgrades returns? No — clamp only fires
    // at run prime — but brief explicitly tests via "console.set after
    // applyMetaUpgrades", confirming the clamp is a run-start trim, not a
    // per-frame ward.
    if ((state.run.passive_revives || 0) > 6) {
      state.run.passive_revives = 6;
    }
  }

  // Equipped relic affixes stack on top of shop/character (skipped in daily/weekly).
  if (!runFair) {
    const relic = equippedRelic();
    if (relic && relic.affixes) {
      for (const a of relic.affixes) {
        if (a.stat === 'hpMax') {
          h.hpMax += a.value;
          h.hp = h.hpMax;
        } else if (h.statMul && a.stat in h.statMul) {
          // Negative values (cooldown) compose multiplicatively against the
          // existing mul, so e.g. -0.15 → ×0.85.
          if (a.value < 0) h.statMul[a.stat] *= (1 + a.value);
          else             h.statMul[a.stat] *= (1 + a.value);
        }
      }
      state.run.equippedRelic = relic;
    }
  }

  // Iter 33e — apply casino permanent + queued temporary buffs. Stacks on
  // top of shop / relic / SHOP_TREE so casino doesn't no-op when those exist.
  import('./casino.js').then(({ applyCasinoBuffsOnRunStart }) => {
    try { applyCasinoBuffsOnRunStart(); } catch (_) {}
  });

  // Mode flags snapshot. Weekly is mutually exclusive with Daily/BossRush —
  // dailyOn was already gated above so the && !dailyOn guards subsume weekly.
  state.modes.hyper = !!(meta.unlockedHyper && meta.optHyper) && !dailyOn && !weeklyOn;
  state.modes.endless = !!(meta.unlockedEndless && meta.optEndless) && !dailyOn && !weeklyOn;
  state.modes.daily = dailyOn;
  state.modes.weekly = weeklyOn;
  // Boss Rush is gated by first-victory (same unlock as Hyper), and is
  // incompatible with Daily / Weekly (each picks its own modifier set).
  state.modes.bossRush = !!(meta.unlockedHyper && meta.optBossRush) && !dailyOn && !weeklyOn;

  // Stage selection — modifies enemy HP, final-boss timing, ground tint.
  // Daily / Weekly force stage 1 so the leaderboard is fair.
  const stage = (dailyOn || weeklyOn) ? STAGES[0] : selectedStage(STAGES);
  state.run.stage = stage;
  if (stage && stage.id !== 'forest') {
    state.run.stageHpMul = stage.enemyHpMul || 1;
    state.run.stageFinalBossAt = stage.finalBossAt || null;
  } else {
    state.run.stageHpMul = 1;
    state.run.stageFinalBossAt = null;
  }
  // Repaint the ground tint for the chosen stage.
  if (state.envGroup && state.envGroup.userData) {
    if (typeof state.envGroup.userData.applyStageTint === 'function') {
      state.envGroup.userData.applyStageTint(stage);
    }
  }
  // Per-stage instanced decor (trees / crystals / lava cracks / bones). Built
  // on top of the tint so each arena reads visually distinct, not just recolored.
  if (stage && state.scene) {
    loadArenaDecor(stage.id, state.scene);
    // Phase-2 swarm: forest-only Explosive Amber interactables. Fire-and-forget
    // — applyMetaUpgrades is sync; amber spawning a frame late is invisible to
    // the player. clearForestAmber is invariant: safe to no-op on non-forest.
    if (stage.id === 'forest') {
      loadForestAmber(state.scene).catch((e) => {
        console.warn('[main] loadForestAmber failed:', e);
      });
      // Swarm Phase 3: chokepoint slow-zones around amber hotspots — funnels
      // swarms into single-file lines through cluster gaps. Fire-and-forget;
      // enemies.js short-circuits on null until state.run.forestSlowZones is
      // published, so zones spawning a frame late is invisible.
      loadForestHazards(state.scene).catch((e) => {
        console.warn('[main] loadForestHazards failed:', e);
      });
      // Defensive: re-entering forest should drop any leftover twilight FX.
      clearTwilightFountains(state.scene);
      clearTwilightHazards(state.scene);
      clearCinderBallistas(state.scene);
      clearCinderHazards(state.scene);
      clearVoidTeleportPads(state.scene);
      clearVoidHazards(state.scene);
    } else if (stage.id === 'twilight') {
      // Phase-2 swarm: Blood/Light Fountains — proximity drink → 1.75× move
      // speed for 4s, 30s per-fountain cooldown. Fire-and-forget; hero.js
      // short-circuits on null until state.run.fountainSpeedBuff is published.
      loadTwilightFountains(state.scene).catch((e) => {
        console.warn('[main] loadTwilightFountains failed:', e);
      });
      // Swarm Phase 3: hedge-corridor slow-zones — funnel swarms into
      // single-file lines through hedge gaps. Fire-and-forget; enemies.js
      // short-circuits on null until state.run.twilightSlowZones is
      // published, so zones spawning a frame late is invisible.
      loadTwilightHazards(state.scene).catch((e) => {
        console.warn('[main] loadTwilightHazards failed:', e);
      });
      // Defensive: forest decor must be gone on twilight.
      clearForestAmber(state.scene);
      clearForestHazards(state.scene);
      clearCinderBallistas(state.scene);
      clearCinderHazards(state.scene);
      clearVoidTeleportPads(state.scene);
      clearVoidHazards(state.scene);
    } else if (stage.id === 'cinder') {
      // Phase-2 swarm: Cinder Ballistas — proximity-triggered 10s repair →
      // permanent auto-fire piercing bolts. Fire-and-forget; tickCinderBallistas
      // bails when _ballistas is empty so a frame-late spawn is invisible.
      loadCinderBallistas(state.scene).catch((e) => {
        console.warn('[main] loadCinderBallistas failed:', e);
      });
      // Swarm Phase 3: catapult slow-zones — funnel swarms AROUND the ruined
      // siege engines (figure-eight kiting per docs/CINDER_VISUAL_STYLE.md).
      // Fire-and-forget; enemies.js short-circuits on null until
      // state.run.cinderSlowZones is published, so zones spawning a frame
      // late is invisible.
      loadCinderHazards(state.scene).catch((e) => {
        console.warn('[main] loadCinderHazards failed:', e);
      });
      // Defensive: forest/twilight decor must be gone on cinder.
      clearForestAmber(state.scene);
      clearForestHazards(state.scene);
      clearTwilightFountains(state.scene);
      clearTwilightHazards(state.scene);
      clearVoidTeleportPads(state.scene);
      clearVoidHazards(state.scene);
    } else if (stage.id === 'void') {
      // Phase-2 swarm: Void Teleport Pads — proximity-triggered (≤1.2u) instant
      // pad-to-pad teleport with 6s per-pad cooldown + 0.4s iFrames on arrival.
      // Fire-and-forget; tickVoidTeleportPads bails when _pads is empty so a
      // frame-late spawn is invisible. Destination resolution: explicit
      // pairWith if set (suppressed if paired pad in cooldown), else nearest
      // OTHER non-cooldown pad. Suppressed teleports still consume the step
      // trigger via the origin's localStepGuard — player must step off and
      // back on to retry.
      loadVoidTeleportPads(state.scene).catch((e) => {
        console.warn('[main] loadVoidTeleportPads failed:', e);
      });
      // B3: Void chasm hazards — pre-existing tile-gap damage zones (5 dmg/s,
      // iframe-respecting so teleport-arrival doesn't punish). Fire-and-forget;
      // the per-frame check in tickStageHazards short-circuits on null until
      // state.run.voidChasms is published, so a frame-late load is invisible.
      // Mirrors the cinder lava pattern minus the arming flash — chasms are
      // visible geometry, not a telegraphed spawn.
      loadVoidHazards(state.scene).catch((e) => {
        console.warn('[main] loadVoidHazards failed:', e);
      });
      // Defensive: forest/twilight/cinder decor must be gone on void.
      clearForestAmber(state.scene);
      clearForestHazards(state.scene);
      clearTwilightFountains(state.scene);
      clearTwilightHazards(state.scene);
      clearCinderBallistas(state.scene);
      clearCinderHazards(state.scene);
    } else {
      // Defensive: stage transition from forest/twilight/cinder → other should
      // drop all. resetState() path already calls these via the block above,
      // but applyMetaUpgrades runs on stage select without a reset (mid-run).
      clearForestAmber(state.scene);
      clearForestHazards(state.scene);
      clearTwilightFountains(state.scene);
      clearTwilightHazards(state.scene);
      clearCinderBallistas(state.scene);
      clearCinderHazards(state.scene);
      clearVoidTeleportPads(state.scene);
      clearVoidHazards(state.scene);
    }
  }
  // Per-stage ambient bed (loop). `forest` and `twilight` ship ambient files
  // (assets/audio/forest/forest_ambient.ogg and audio/twilight/twilight_ambient.ogg);
  // other stages no-op until their packs land. Routed through the music
  // submaster so the Music Volume slider controls it. Stop on null/unknown stage.
  if (stage) {
    playStageAmbient(stage.id);
  } else {
    playStageAmbient(null);
  }
}

// ── Tier-4 Overdrive capstone tick (Power branch) ─────────────────────────
// Cycle: passive_overdrive=true → accumulate overdriveTimer until 60s, flip
// overdriveActive=true for 5s, then flip back and reset the timer. During
// the active window we stash + transient-multiply hero.statMul.cooldown
// (×0.667 ≈ +50% attack speed) and hero.statMul.dmg (×1.25 = +25% damage).
// Stash pattern guards against FP drift AND against death-mid-frenzy: if
// resetState clears state.run, the stash goes with it; we re-read fresh
// values on the next activation.
const OVERDRIVE_WAIT  = 60.0;
const OVERDRIVE_ACTIVE = 5.0;
const OVERDRIVE_CD_MUL = 0.667;
const OVERDRIVE_DMG_MUL = 1.25;
function _tickOverdrive(dt) {
  const r = state.run;
  if (!r.passive_overdrive) return;
  const h = state.hero;
  if (!r.overdriveActive) {
    r.overdriveTimer = (r.overdriveTimer || 0) + dt;
    if (r.overdriveTimer >= OVERDRIVE_WAIT) {
      // ── Activate ──
      r.overdriveActive = true;
      r.overdriveTimer = 0;
      r._overdrivePrevCD  = h.statMul.cooldown;
      r._overdrivePrevDmg = h.statMul.dmg;
      h.statMul.cooldown = h.statMul.cooldown * OVERDRIVE_CD_MUL;
      h.statMul.dmg      = h.statMul.dmg      * OVERDRIVE_DMG_MUL;
      // Amber screen tint: try the postfx uniform first (10a may add it),
      // otherwise fall back to a bloomBoost pulse so the player still sees
      // a frenzy flash. The bloomBoost decays at ×0.1/sec so a one-shot
      // here visibly lingers across the 5s window.
      if (state.postFXPass && state.postFXPass.uniforms && state.postFXPass.uniforms.uOverdriveTint) {
        state.postFXPass.uniforms.uOverdriveTint.value = 1.0;
      }
      state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.85);
      try { if (sfx && sfx.levelUp) sfx.levelUp(); } catch (_) {}
    }
  } else {
    r.overdriveTimer = (r.overdriveTimer || 0) + dt;
    if (r.overdriveTimer >= OVERDRIVE_ACTIVE) {
      // ── Deactivate ──
      r.overdriveActive = false;
      r.overdriveTimer = 0;
      // Restore from stash (not invert-multiply — FP drift is real).
      if (r._overdrivePrevCD != null)  h.statMul.cooldown = r._overdrivePrevCD;
      if (r._overdrivePrevDmg != null) h.statMul.dmg      = r._overdrivePrevDmg;
      r._overdrivePrevCD  = null;
      r._overdrivePrevDmg = null;
      if (state.postFXPass && state.postFXPass.uniforms && state.postFXPass.uniforms.uOverdriveTint) {
        state.postFXPass.uniforms.uOverdriveTint.value = 0.0;
      }
    } else {
      // Mid-active: keep nudging bloomBoost so the frenzy reads continuously
      // (it decays each frame; a small per-tick top-up is the safe path).
      state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.45);
    }
  }
}

// Iter 10b — Greed tier-4 capstone helper. Spawns one chest in front-right
// of the hero at run entry, exactly once per run. Guard via state.run flag
// so the two call sites (restartRun via _primeRunStart + start() for the
// first-from-menu path) don't double-spawn.
function _maybeSpawnTreasureMapChest() {
  if (!state.run.passive_treasureMap) return;
  if (state.run._treasureMapSpawned) return;
  state.run._treasureMapSpawned = true;
  try {
    spawnChestAt(state.hero.pos.x + 5, state.hero.pos.z + 5);
  } catch (err) { console.warn('[treasureMap spawn]', err); }
}

function applyShake(realDt) {
  if (state.fx.shake <= 0.001) return;
  const opt = (state._optShakeMul !== undefined) ? state._optShakeMul : 1.0;
  const s = state.fx.shake * opt;
  const t = state.time.real * 60;
  const k = 1.2 * s;
  camera.position.x += Math.sin(t * 1.7) * k;
  camera.position.z += Math.cos(t * 2.3) * k;
  state.fx.shake *= Math.pow(0.0008, realDt);
}

// ── FE-C3A — Forest room transition + camera lerp ──────────────────────────
// Module-local state for the room state machine. Driven each frame from the
// Forest tick block (which guards on state.run.stage.id === 'forest' so
// these stay quiescent on other stages).
//
//   _forestCamLerp.active:    true while a transition is animating
//   _forestCamLerp.elapsed:   seconds since transition began
//   _forestCamLerp.targetX/Z: room center the camera is settling toward
//
// The transition lifecycle (per FOREST_EXPANSION_PLAN §4 FE-C3A):
//   1. detectRoom(hero.pos.x, hero.pos.z) reports newRoomId != currentRoom
//   2. Set roomState='TRANSITIONING', currentRoom=newRoomId
//   3. Hide every InstancedMesh whose userData.roomId is set AND not in the
//      visible set {currentRoom, 'glade'}; show those that are.
//   4. Lerp camera toward room center for FOREST_CAM_LERP_SEC
//   5. After the lerp completes, settle roomState into 'ARENA' if the new
//      room is the glade hub, or 'IN_ROOM' otherwise. PUZZLE_ACTIVE is owned
//      by puzzleSystem.js and never set by this transition path.
const FOREST_CAM_LERP_SEC = 0.6;
const _forestCamLerp = {
  active: false,
  elapsed: 0,
  targetX: null,
  targetZ: null,
};

/**
 * Walk the per-room InstancedMesh tags installed by arenaDecor.js. Each child
 * with `userData.roomId` set gets .visible flipped to match the rule "show
 * only the current room + glade". The glade is always visible because it's
 * the hub backdrop the puzzle rooms "lean against" geometrically.
 *
 * Cheap: ~30 children traversal once per transition (NOT per frame).
 *
 * @param {string} currentRoomId
 */
function _applyForestRoomVisibility(currentRoomId) {
  const sc = state.scene;
  if (!sc) return;
  const decor = sc.getObjectByName('__arenaDecor');
  if (!decor) return;
  decor.traverse((o) => {
    const rid = o.userData && o.userData.roomId;
    if (!rid) return; // un-tagged decor (non-Forest, or props) — leave alone
    o.visible = (rid === currentRoomId) || (rid === 'glade');
  });
}

/**
 * Per-frame room transition driver. Called only on Forest stage. Cheap
 * fast-path when nothing is changing (detectRoom returns the same id every
 * frame for a stationary hero).
 *
 * @param {number} dt seconds since last frame
 */
function _tickForestRoomTransition(dt) {
  // Don't change rooms or run camera lerp while a puzzle is in flight — the
  // hero is locked to a puzzle room until it ends (win/fail/timeout) and the
  // boss force-return path in spawnDirector handles the override case.
  if (state.run && state.run.roomState === 'PUZZLE_ACTIVE') return;

  const hp = state.hero && state.hero.pos;
  if (!hp) return;
  const detected = detectRoom(hp.x, hp.z);
  const cur = (state.run && state.run.currentRoom) || 'glade';

  // detected may be null in no-man's-land between rooms — keep the last
  // known room so visibility doesn't flicker as the hero crosses a portal.
  if (detected && detected !== cur) {
    state.run.currentRoom = detected;
    state.run.roomState = 'TRANSITIONING';
    _applyForestRoomVisibility(detected);
    const room = FOREST_ROOMS[detected];
    if (room && room.center) {
      _forestCamLerp.active = true;
      _forestCamLerp.elapsed = 0;
      _forestCamLerp.targetX = room.center.x;
      _forestCamLerp.targetZ = room.center.z;
    }
  }

  // Advance the lerp clock. When it elapses, settle roomState into
  // 'ARENA' (glade hub) or 'IN_ROOM' (any puzzle room). Don't downgrade
  // PUZZLE_ACTIVE here — puzzleSystem owns that state.
  if (_forestCamLerp.active) {
    _forestCamLerp.elapsed += dt;
    if (_forestCamLerp.elapsed >= FOREST_CAM_LERP_SEC) {
      _forestCamLerp.active = false;
      _forestCamLerp.targetX = null;
      _forestCamLerp.targetZ = null;
      if (state.run.roomState !== 'PUZZLE_ACTIVE') {
        state.run.roomState = (state.run.currentRoom === 'glade') ? 'ARENA' : 'IN_ROOM';
      }
    }
  }
}

function frame(now) {
  const realDt = Math.min(0.05, (now - _lastT) / 1000);
  _lastT = now;
  state.time.real += realDt;

  // Interior mode — close iso camera over a small room.
  if (state.mode === 'interior') {
    sampleInput();
    updateHero(realDt);
    updateFX(realDt);
    updateVFXBurst(realDt);
    updatePickupRing();
    updateBlobShadows();
    tickInterior(realDt);
    // Tighter camera + frustum for the interior — frames the room intimately.
    const hp = state.hero.pos;
    camera.position.x += (hp.x + 18 - camera.position.x) * 0.18;
    camera.position.z += (hp.z + 18 - camera.position.z) * 0.18;
    camera.position.y = 32;
    camera.lookAt(hp.x, 0.7, hp.z);
    const _ia = ASPECT();
    const _ihalf = 9;
    camera.left = -_ihalf * _ia; camera.right = _ihalf * _ia;
    camera.top  =  _ihalf;       camera.bottom = -_ihalf;
    camera.updateProjectionMatrix();
    if (state.postFXPass) state.postFXPass.uniforms.time.value = state.time.real;
    renderFrame();
    requestAnimationFrame(frame);
    return;
  }

  // Casino interior — same camera shape as the house, slightly pulled back
  // so all 5 stations stay framed.
  if (state.mode === 'casino_interior') {
    sampleInput();
    updateHero(realDt);
    updateFX(realDt);
    updateVFXBurst(realDt);
    updatePickupRing();
    updateBlobShadows();
    tickCasinoInterior(realDt);
    const hp = state.hero.pos;
    camera.position.x += (hp.x + 20 - camera.position.x) * 0.16;
    camera.position.z += (hp.z + 20 - camera.position.z) * 0.16;
    camera.position.y = 34;
    camera.lookAt(hp.x, 0.7, hp.z);
    const _ca = ASPECT();
    const _chalf = 11;
    camera.left = -_chalf * _ca; camera.right = _chalf * _ca;
    camera.top  =  _chalf;       camera.bottom = -_chalf;
    camera.updateProjectionMatrix();
    if (state.postFXPass) state.postFXPass.uniforms.time.value = state.time.real;
    renderFrame();
    requestAnimationFrame(frame);
    return;
  }

  // Catacomb mode — full combat tick inside the dungeon sub-arena.
  // Same logic as the run branch, but:
  //   * no spawn director (catacomb manages its own mini-waves)
  //   * no totems/pylons/bells/destructibles (overworld objectives)
  //   * tighter iso camera (same offset shape as interior mode)
  if (state.mode === 'catacomb') {
    if (state.pendingLevelUp || state.gameOver || state.time.paused) {
      if (state.gameOver) {
        updateDeathAnim(realDt);
        updateDamageNumbers(realDt);
        applyShake(realDt);
      }
      if (state.postFXPass) state.postFXPass.uniforms.time.value = state.time.real;
      renderFrame();
      requestAnimationFrame(frame);
      return;
    }
    let logicDt = realDt;
    if (state.fx.hitStop > 0) {
      state.fx.hitStop = Math.max(0, state.fx.hitStop - realDt);
      logicDt = 0;
    }
    state.time.dt = logicDt;
    state.time.game += logicDt;

    // Clockwork "Tempo" signature: damage multiplier ramps with run-time.
    // Idempotent (function of state.time.game), safe to compute in any active branch.
    if (state.run.signature_tempo) {
      state.run.signature_tempoBonus = Math.min(
        state.run.signature_tempo.cap,
        state.run.signature_tempo.ratePerSec * state.time.game,
      );
    }

    sampleInput();
    updateHero(logicDt);
    updateEnemies(logicDt);
    tickWeapons(logicDt);
    updateGems(logicDt);
    updateFX(logicDt);
    updateVFXBurst(logicDt);
    updatePickupRing();
    updateEnemyProjectiles(logicDt);
    tickChests(logicDt);
    updateBossTelegraphs(logicDt);
    tickPickups(logicDt);
    updateBlobShadows();
    updateDamageNumbers(realDt);
    tickCatacomb(logicDt);

    state.fx.chromaticPulse *= Math.pow(0.05, realDt);
    state.fx.bloomBoost     *= Math.pow(0.10, realDt);

    // Tight iso camera (mirrors interior offset shape)
    const hp = state.hero.pos;
    camera.position.x += (hp.x + 22 - camera.position.x) * 0.16;
    camera.position.z += (hp.z + 22 - camera.position.z) * 0.16;
    camera.position.y = 38;
    camera.lookAt(hp.x, 0.6, hp.z);
    const _ca = ASPECT();
    const _chalf = 14;
    camera.left = -_chalf * _ca; camera.right = _chalf * _ca;
    camera.top  =  _chalf;       camera.bottom = -_chalf;
    camera.updateProjectionMatrix();

    applyShake(realDt);
    if (state.postFXPass) {
      state.postFXPass.uniforms.time.value = state.time.real;
      state.postFXPass.uniforms.chromatic.value = 0.0008 + state.fx.chromaticPulse * 0.004;
    }
    if (state.bloomPass) {
      const vfxMul = (getMeta().optVfx !== undefined ? getMeta().optVfx : 1.0);
      state.bloomPass.strength = (0.30 + state.fx.bloomBoost * 0.30) * vfxMul;
    }
    updateUI();
    renderFrame();
    updatePerfHUD();
    requestAnimationFrame(frame);
    return;
  }

  // Town hub mode — stripped-down tick: input + hero + fx + camera + render.
  if (state.mode === 'town') {
    sampleInput();
    updateHero(realDt);
    updateFX(realDt);
    updateVFXBurst(realDt);
    updatePickupRing();
    updateBlobShadows();
    tickTown(realDt);
    // Camera follows hero (same offset as in-game so the transition is seamless)
    const hp = state.hero.pos;
    camera.position.x += (hp.x + 40 - camera.position.x) * WORLD.cameraLerp;
    camera.position.z += (hp.z + 40 - camera.position.z) * WORLD.cameraLerp;
    camera.position.y = 60;
    camera.lookAt(hp.x, 0, hp.z);
    if (state.envGroup && state.envGroup.userData.sun) {
      const sun = state.envGroup.userData.sun;
      sun.position.set(hp.x + 60, 80, hp.z + 40);
      sun.target.position.set(hp.x, 0, hp.z);
      sun.target.updateMatrixWorld();
    }
    if (state.postFXPass) state.postFXPass.uniforms.time.value = state.time.real;
    renderFrame();
    requestAnimationFrame(frame);
    return;
  }

  if (!state.started) {
    renderFrame();
    requestAnimationFrame(frame);
    return;
  }

  if (state.pendingLevelUp || state.gameOver || state.time.paused) {
    // Frozen — render only. Death animation still ticks on real time.
    if (state.gameOver) {
      updateDeathAnim(realDt);
      updateDamageNumbers(realDt);
      applyShake(realDt);
      // ── Weekly run-end commit (iter 9). One-shot on gameOver transition.
      // 9a designed commitRunResults to forward `weekly: true`, but 9c's
      // showDeathScreen currently doesn't pass it — so we commit defensively
      // here from main.js per the brief's "run-end commit in main.js" mandate.
      // _weeklyCommitted (stamped false in applyMetaUpgrades) prevents the
      // per-frame loop from double-committing. Also records a leaderboard
      // entry with mode:'weekly' so the Hall of Records modal can list it.
      if (state.modes && state.modes.weekly && state.run && !state.run._weeklyCommitted) {
        state.run._weeklyCommitted = true;
        try {
          commitWeeklyRun({
            kills: state.run.kills,
            time: state.time.game,
            character: state.run.character,
            stage: state.run.stage ? state.run.stage.id : null,
          });
        } catch (e) { console.warn('[weekly.commit]', e); }
        try {
          recordRun({
            stage: state.run.stage ? state.run.stage.id : 'forest',
            char: state.run.character || 'kitty',
            mode: 'weekly',
            kills: state.run.kills,
            timeSurvived: state.time.game,
            level: state.hero.level,
            dmgDealt: state.run.dmgDealt,
            victory: !!state.victory,
          });
        } catch (e) { console.warn('[weekly.recordRun]', e); }
      }
    }
    if (state.postFXPass) state.postFXPass.uniforms.time.value = state.time.real;
    renderFrame();
    requestAnimationFrame(frame);
    return;
  }

  // Hit-stop: drain timer on real time, scale gameplay dt to 0 while active.
  // Damage numbers still tick on realDt so they don't visually stall.
  let logicDt = realDt;
  if (state.fx.hitStop > 0) {
    state.fx.hitStop = Math.max(0, state.fx.hitStop - realDt);
    logicDt = 0;
  }
  state.time.dt = logicDt;
  state.time.game += logicDt;

  // Clockwork "Tempo" signature: damage multiplier ramps with run-time.
  // Read by enemies.js damageEnemy(). Idempotent — function of state.time.game.
  if (state.run.signature_tempo) {
    state.run.signature_tempoBonus = Math.min(
      state.run.signature_tempo.cap,
      state.run.signature_tempo.ratePerSec * state.time.game,
    );
  }

  // ── Logic phase ── (iter 33o — perfMark wraps subsystems for breakdown).
  let _p;
  sampleInput();
  _p=perfStart(); updateHero(logicDt);            perfMark('hero', _p);
  _p=perfStart(); tickSpawnDirector(logicDt);     perfMark('spawnDir', _p);
  // Tier-4 Overdrive capstone (Power branch) — must tick BEFORE tickWeapons
  // so the stashed statMul multipliers apply within the same frame's weapon
  // cooldown reads (autoAim / chain / orbitals all read h.statMul.cooldown).
  _tickOverdrive(logicDt);
  _p=perfStart(); updateEnemies(logicDt);         perfMark('enemies', _p);
  _p=perfStart(); tickWeapons(logicDt);           perfMark('weapons', _p);
  _p=perfStart(); updateGems(logicDt);            perfMark('gems', _p);
  _p=perfStart(); updateFX(logicDt);              perfMark('fx', _p);
  _p=perfStart(); updateVFXBurst(logicDt);        perfMark('vfxBurst', _p);
  _p=perfStart(); updatePickupRing();             perfMark('pickupRing', _p);
  _p=perfStart(); updateEnemyProjectiles(logicDt);perfMark('eprojs', _p);
  _p=perfStart(); tickChests(logicDt);            perfMark('chests', _p);
  _p=perfStart(); updateBossTelegraphs(logicDt);  perfMark('bossTells', _p);
  _p=perfStart(); tickTotems(logicDt);            perfMark('totems', _p);
  _p=perfStart(); tickPylons(logicDt);            perfMark('pylons', _p);
  _p=perfStart(); tickBells(logicDt);             perfMark('bells', _p);
  _p=perfStart(); updateEnemyTells(logicDt);      perfMark('enemyTells', _p);
  _p=perfStart(); tickStageHazards(logicDt);      perfMark('hazards', _p);
  // Forest-only: Explosive Amber interactables (Phase-2 swarm). No-op on
  // other stages — tickForestAmber bails when _entities is empty.
  if (state.run && state.run.stage && state.run.stage.id === 'forest') {
    _p=perfStart(); tickForestAmber(logicDt, state); perfMark('forestAmber', _p);
    // FE-C3A — puzzle system tick + room transition detection. Puzzle tick
    // is a no-op when no puzzle is active. Room detection runs every frame
    // so a fast hero crossing portals doesn't strand a stale currentRoom.
    _p=perfStart(); tickPuzzleSystem(logicDt); perfMark('puzzleSystem', _p);
    _p=perfStart(); _tickForestRoomTransition(logicDt); perfMark('roomTransition', _p);
  }
  // Twilight-only: Blood/Light Fountains. No-op on other stages —
  // tickTwilightFountains bails when _fountains is empty.
  if (state.run && state.run.stage && state.run.stage.id === 'twilight') {
    _p=perfStart(); tickTwilightFountains(logicDt, state); perfMark('twilightFountains', _p);
  }
  // Cinder-only: Ballista Turret interactables. No-op on other stages —
  // tickCinderBallistas bails when _ballistas is empty.
  if (state.run && state.run.stage && state.run.stage.id === 'cinder') {
    _p=perfStart(); tickCinderBallistas(logicDt, state); perfMark('cinderBallistas', _p);
  }
  // Void-only: Teleport Pad interactables. No-op on other stages —
  // tickVoidTeleportPads bails when _pads is empty.
  if (state.run && state.run.stage && state.run.stage.id === 'void') {
    _p=perfStart(); tickVoidTeleportPads(logicDt, state); perfMark('voidTeleportPads', _p);
  }
  // A4 refactor: single shared chain-arc tick for ALL consumers (chain.js
  // weapon + forestAmber interactable). Runs AFTER both spawners so new arcs
  // get a clean t=0 first frame, matching the pre-refactor weapon behavior
  // byte-for-byte and matching the pre-refactor forest behavior within ~1%
  // opacity drift on frame 0 (life=0.4s, dt~0.016s → k≈0.04).
  _p=perfStart(); tickChainArcs(logicDt);         perfMark('chainArcs', _p);
  _p=perfStart(); tickEvolveBursts(logicDt);      perfMark('evolveBursts', _p);
  _p=perfStart(); tickDissolveBursts(logicDt);    perfMark('dissolveBursts', _p);
  // Punch List #7 — Velocity Veil ribbon trail + splash. Stage-agnostic
  // tick (only fires meaningful work while a veil descriptor is active;
  // descriptors only spawn on Twilight fountain drinks). Cap MAX_VEILS=4,
  // POOL_CAP=128 InstancedMesh slots, ZERO per-tick allocation.
  _p=perfStart(); tickVelocityVeils(logicDt);     perfMark('velocityVeils', _p);
  _p=perfStart(); tickStageRule(state, logicDt);  perfMark('stageRule', _p);
  _p=perfStart(); tickMiniEvents(logicDt);        perfMark('miniEvents', _p);
  _p=perfStart(); tickArenaProps(logicDt);        perfMark('arenaProps', _p);
  _p=perfStart(); tickPickups(logicDt);           perfMark('pickups', _p);
  _p=perfStart(); tickCatacombEntrance(logicDt);  perfMark('catacEntry', _p);
  _p=perfStart(); updateBlobShadows();            perfMark('blobs', _p);
  _p=perfStart(); updateDamageNumbers(realDt);    perfMark('dmgNums', _p);

  // FX decay (real time so feedback fades even during hit-stop)
  state.fx.chromaticPulse *= Math.pow(0.05, realDt);
  state.fx.bloomBoost     *= Math.pow(0.10, realDt);

  // Camera follow hero (lerp xz, keep height + offset matching original game)
  const hp = state.hero.pos;
  const camLerp = WORLD.cameraLerp;
  // FE-C3A — during a Forest room transition, drive the camera toward the
  // room center instead of toward the hero. Stronger lerp (0.18) so the
  // 0.6s window resolves into a visible "settle to room" motion rather than
  // hanging halfway. Falls through to the standard hero-follow when the
  // transition completes (_forestCamLerp.active flips false).
  if (state.run && state.run.stage && state.run.stage.id === 'forest'
      && _forestCamLerp.active && _forestCamLerp.targetX != null) {
    const tcx = _forestCamLerp.targetX;
    const tcz = _forestCamLerp.targetZ;
    camera.position.x += (tcx + 40 - camera.position.x) * 0.18;
    camera.position.z += (tcz + 40 - camera.position.z) * 0.18;
    camera.position.y = 60;
    camera.lookAt(tcx, 0, tcz);
  } else {
    camera.position.x += (hp.x + 40 - camera.position.x) * camLerp;
    camera.position.z += (hp.z + 40 - camera.position.z) * camLerp;
    camera.position.y = 60;
    camera.lookAt(hp.x, 0, hp.z);
  }

  // Sun + shadow-camera follow: keep the directional light at a fixed offset
  // from the hero so the 80-unit shadow frustum always contains the action.
  if (state.envGroup && state.envGroup.userData.sun) {
    const sun = state.envGroup.userData.sun;
    sun.position.set(hp.x + 60, 80, hp.z + 40);
    sun.target.position.set(hp.x, 0, hp.z);
    sun.target.updateMatrixWorld();
  }

  // Per-stage atmospheric particles (iter 15) — drift pollen/wisps/embers/
  // sparkles around the hero. Guarded for title-screen / town frames where
  // envGroup may exist but no stage is active.
  if (state.envGroup && typeof state.envGroup.userData.tickAtmosphere === 'function') {
    state.envGroup.userData.tickAtmosphere(realDt, state.hero);
  }

  applyShake(realDt);

  // Apply zoom — adjusts the orthographic frustum size each frame.
  const z = getZoom();
  const a = ASPECT();
  const half = WORLD.cameraDistance / z;
  camera.left = -half * a; camera.right = half * a;
  camera.top  =  half;     camera.bottom = -half;
  camera.updateProjectionMatrix();

  // Update post-FX uniforms
  if (state.postFXPass) {
    state.postFXPass.uniforms.time.value = state.time.real;
    state.postFXPass.uniforms.chromatic.value = 0.0008 + state.fx.chromaticPulse * 0.004;
  }
  if (state.bloomPass) {
    const vfxMul = (getMeta().optVfx !== undefined ? getMeta().optVfx : 1.0);
    state.bloomPass.strength = (0.30 + state.fx.bloomBoost * 0.30) * vfxMul;
  }

  // Music intensity: 0 in first 20s, 1 mid-game, 2 once final boss is up
  const hasFinalBoss = state.enemies.active.some(e => e.isFinalBoss);
  setMusicTier(hasFinalBoss ? 2 : (state.time.game > 20 ? 1 : 0));

  // Secret-unlock time checks (cheap; functions self-dedupe via meta.secrets)
  if (state.run.flawless && state.time.game >= 300 && !_checkedUntouchable) {
    _checkedUntouchable = true;
    import('./ui.js').then(({ trySecret }) => trySecret('untouchable_5min'));
  }
  if (state.time.game >= 1500 && !_checkedMarathon) {
    _checkedMarathon = true;
    import('./ui.js').then(({ trySecret }) => trySecret('marathon'));
  }
  if (!_checkedHoarder) {
    const m = getMeta();
    if (m.lifetime && (m.lifetime.coinsEverEarned || 0) >= 500) {
      _checkedHoarder = true;
      import('./ui.js').then(({ trySecret }) => trySecret('hoarder'));
    }
  }

  // Color grade: subtle red shadow tint during final boss (urgent vibe).
  if (state.postFXPass && state.postFXPass.uniforms.lift) {
    const liftU = state.postFXPass.uniforms.lift.value;
    const targetR = hasFinalBoss ? 0.05 : 0.00;
    const targetB = hasFinalBoss ? -0.02 : 0.02;
    liftU.x += (targetR - liftU.x) * 0.04;
    liftU.z += (targetB - liftU.z) * 0.04;
  }

  _p=perfStart(); updateUI();      perfMark('ui', _p);

  // FE-C3A — end-of-frame sweep for one-shot interact flag. hero.js sets it
  // when the player hits E or B-button; readers (puzzle/portal systems) see
  // it during the same frame's tick. Clearing here means a frame with no
  // reader still leaves a clean slate next frame. Safe to clear even when
  // not set (no-op assignment).
  if (state.input) state.input.interactPressed = false;

  _p=perfStart(); renderFrame();   perfMark('render', _p);
  updatePerfHUD();
  requestAnimationFrame(frame);
}

// ── WebGL context-loss rebuild stub ──────────────────────────────────────────
// Iter-10 safe fallback: a full re-init of the 12+ InstancedMesh systems
// (gems, blob shadows, ranged tells, threat dots, pickup halos, leap markers,
// kill rings, sparkle layers, projectile pools, particle textures, etc.) is
// risky and out-of-scope for the polish lock — the init helpers append to the
// scene and would duplicate rather than rebuild. The brief explicitly permits
// the safe fallback here. A real silent-restore path is iter 12 work.
//
// Hooked from main.js webglcontextrestored listener.
function rebuildAfterContextLoss() {
  console.error('[webgl] context restored — page reload required to recover (iter 10 safe fallback)');
  try {
    // Tiny delay so the user can see the "graphics disconnected" modal close
    // and the reload toast read as a deliberate recovery, not a crash.
    setTimeout(() => { try { window.location.reload(); } catch (_) {} }, 200);
  } catch (_) {
    try { window.location.reload(); } catch (_) {}
  }
}

boot().then(() => requestAnimationFrame(frame));
