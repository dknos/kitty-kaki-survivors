/**
 * Ascension Evolution FX — Punch List #1 (2026-05-16).
 *
 * Plays a 1.2s world-space "Ascension burst" the instant a weapon evolves,
 * plus a 30s emissive rim ring on the owner (player) so the build's high-
 * water mark stays visible for the rest of the run. Single source of truth
 * for the evolve visual — `weapons/index.js:applyEvolution()` is the only
 * caller of `spawnEvolveBurst()`.
 *
 * Constraints (from the task brief / docs/PUNCH_LIST_2026-05-16.md item #1):
 *   - 1.2s burst lifespan, hard auto-dispose
 *   - 30s rim lifespan, hard auto-clear
 *   - ≤ 80 instances total across burst + sigil pools (cap is global,
 *     not per-burst). If a fresh evolve would exceed the cap, the new
 *     burst is dropped wholesale — a partial spawn reads worse than nothing.
 *   - Palette is pulled from the active stage's locked 8-color set
 *     (see docs/{FOREST,TWILIGHT,CINDER,VOID}_VISUAL_STYLE.md). Every hex
 *     literal in this file appears in at least one of those tables.
 *   - World-space only — no postfx changes, no new render target. All
 *     emissive billboards/meshes tag BLOOM_LAYER directly so the existing
 *     bloom-only composer picks them up.
 *   - No new textures — reuses `glowWhite`, `ringCyan`, `flashStar` from
 *     `src/particleTextures.js`.
 *
 * Public API:
 *   spawnEvolveBurst(scene, position, stageId) → handle | null
 *     scene: THREE.Scene (from `state.hero.mesh.parent`)
 *     position: { x, z } world coords (typically `state.hero.pos`)
 *     stageId: 'forest' | 'twilight' | 'cinder' | 'void' (defaults to forest)
 *
 *   tickEvolveBursts(dt) — per-frame; advance, fade, dispose.
 *   disposeAllEvolveBursts(scene) — hard cleanup on stage/run teardown.
 *   _debugActiveInstanceCount() — testing hook.
 */
import * as THREE from 'three';
import { tex } from '../particleTextures.js';
import { BLOOM_LAYER } from '../postfx.js';
import { FLAT_X_QUAT } from '../fxLayers.js';

// ─── Palette table ──────────────────────────────────────────────────────────
// Burst (radial glow billboards), sigil (rotating ring icons), rim (30s ring
// attached to player). Slot numbers below reference the per-stage palette
// table in the matching docs/<STAGE>_VISUAL_STYLE.md file. Cross-check via
//   grep -nE "0x[0-9a-f]{6}" src/fx/evolveBurst.js
// against those tables before merging — palette drift is the #1 audit risk.
const PALETTE = {
  forest: {
    burst: 0x7df0c4, // slot 4 — bio-glow primary mint
    sigil: 0xa8e6ff, // slot 8 — chain-lightning cyan-white
    rim:   0x3ecf9a, // slot 5 — bio-glow secondary
  },
  twilight: {
    burst: 0xffcd5b, // slot 7 — fountain glow peak (single-frame in style, used here as the burst hot color)
    sigil: 0xa8e6ff, // slot 8 — movement-boost aura cyan
    rim:   0xa98030, // slot 6 — gold dim
  },
  cinder: {
    burst: 0xffd24a, // slot 7 — ballista glow active (warm gold)
    sigil: 0xffb86b, // slot 8 — repair progress aura
    rim:   0xff5522, // slot 4 — ember orange hot
  },
  void: {
    burst: 0x7fffff, // slot 6 — portal cyan active
    sigil: 0xa8b8ff, // slot 8 — star points
    rim:   0x00d4ff, // slot 5 — portal cyan idle
  },
};

function _paletteFor(stageId) {
  return PALETTE[stageId] || PALETTE.forest;
}

// ─── Tunables ───────────────────────────────────────────────────────────────
const BURST_COUNT      = 12;   // radial glow billboards per evolve
const SIGIL_COUNT      = 6;    // orbiting sigil icons per evolve
const INSTANCES_PER    = BURST_COUNT + SIGIL_COUNT; // 18 — well under 80 cap
const INSTANCE_CAP     = 80;   // total instances across all active bursts+sigils
const BURST_LIFE       = 1.2;  // seconds — total burst envelope
const SIGIL_SCALE_IN   = 0.4;  // seconds for sigil scale 0 → 1
const RIM_LIFE         = 30.0; // seconds — owner rim duration
const BURST_RADIUS     = 4.0;  // world units — outer radius at peak
const BURST_Y          = 1.0;  // world Y — chest-height for the glory burst
const SIGIL_RADIUS_END = 1.6;  // world units — sigil orbit radius at end of scale-in
const SIGIL_Y          = 1.4;  // world Y — slightly above burst plane
const SIGIL_SIZE       = 0.45; // world units — sigil quad side
const SIGIL_ROT_SPEED  = 1.8;  // radians/sec — full ring rotation
const RIM_INNER_R      = 0.95; // world units — rim ring inner radius around hero
const RIM_LINE_W       = 0.10; // world units — rim ring line weight (target 0.06-0.10 per style)

// ─── Module state ───────────────────────────────────────────────────────────
// Each entry is one full Ascension instance (burst + sigils + rim handle).
// We keep them separate so dispose can reach the rim mesh attached to the
// hero group while still cleanly removing the burst group from the scene.
const _bursts = []; // { group, burstMeshes, sigilMeshes, t, rim? }
const _rims   = []; // { mesh, mat, geo, t, life, owner }  — separate so rim outlives burst

// Reuse the shared flat-decal quaternion (fxLayers.js, line 42). Same value
// as a per-axis setFromAxisAngle would yield; pulled in for consistency with
// fx.js / chainFx.js patterns and to avoid one extra Quaternion alloc.
const _flatX = FLAT_X_QUAT;

/**
 * Build a single billboard-style emissive plane. Additive blend + bloom
 * layer tag is the canonical "this glows" recipe (see chainFx.js + fx.js).
 */
function _makeGlowPlane(color, texName, size) {
  const geo = new THREE.PlaneGeometry(size, size);
  const mat = new THREE.MeshBasicMaterial({
    color,
    map: tex(texName) || null,
    transparent: true,
    opacity: 1.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.layers.enable(BLOOM_LAYER);
  return { mesh, mat, geo };
}

/**
 * Build the 30s rim ring (TorusGeometry, additive, bloom on). Attached to
 * the hero group so it follows the player without a per-frame position copy.
 */
function _makeRimRing(color) {
  // Torus on the XZ plane (rotated -90° around X via _flatX). Radius =
  // inner radius + half line width so the visual reads as RIM_INNER_R.
  const radius = RIM_INNER_R + RIM_LINE_W * 0.5;
  const tube = RIM_LINE_W * 0.5;
  const geo = new THREE.TorusGeometry(radius, tube, 8, 48);
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.8,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.quaternion.copy(_flatX);
  mesh.position.y = 0.05;        // hover just above the ground
  mesh.frustumCulled = false;
  mesh.layers.enable(BLOOM_LAYER);
  return { mesh, mat, geo };
}

/**
 * Count live burst+sigil meshes across all active Ascension instances.
 * Rim meshes are NOT counted against the 80 cap (single small ring,
 * orders of magnitude under the "particle overdraw" risk the cap exists
 * to prevent).
 */
function _activeInstanceCount() {
  let n = 0;
  for (const b of _bursts) {
    n += b.burstMeshes.length;
    n += b.sigilMeshes.length;
  }
  return n;
}

/**
 * Spawn one Ascension burst at the given world position. Returns the
 * handle (mostly for tests; gameplay callers can fire-and-forget — the
 * tick loop handles cleanup). Returns null if the cap would be exceeded
 * or if scene/position are missing — better silent no-op than a partial
 * spawn that reads as broken.
 */
export function spawnEvolveBurst(scene, position, stageId) {
  if (!scene || !position) return null;
  if (_activeInstanceCount() + INSTANCES_PER > INSTANCE_CAP) return null;

  const palette = _paletteFor(stageId);
  const baseX = position.x || 0;
  const baseZ = position.z || 0;

  const group = new THREE.Group();
  group.position.set(baseX, 0, baseZ);
  scene.add(group);

  // ── Burst: 12 glow billboards arranged radially, expanding outward.
  // Each is rotated to face up (flat on XZ-ish plane) so they read as a
  // flat glory disc when seen from the iso camera but still pick up the
  // bloom strongly because they're additive.
  const burstMeshes = [];
  for (let i = 0; i < BURST_COUNT; i++) {
    const angle = (i / BURST_COUNT) * Math.PI * 2;
    const { mesh, mat, geo } = _makeGlowPlane(palette.burst, 'glowWhite', 1.2);
    mesh.quaternion.copy(_flatX);
    mesh.position.set(0, BURST_Y, 0); // start at center; tick expands radially
    mesh.userData.angle = angle;
    mesh.userData.mat = mat;
    mesh.userData.geo = geo;
    group.add(mesh);
    burstMeshes.push(mesh);
  }

  // ── Sigils: 6 small rotating icons orbiting outward. Scale 0 → 1 over
  // SIGIL_SCALE_IN seconds (0.4s) then hold full size while opacity fades.
  // We use the flashStar texture as the "sigil" sprite — it's the closest
  // existing 4-pointed glyph in particleTextures.js. (No new textures per
  // task constraint.)
  const sigilMeshes = [];
  for (let i = 0; i < SIGIL_COUNT; i++) {
    const angle = (i / SIGIL_COUNT) * Math.PI * 2;
    const { mesh, mat, geo } = _makeGlowPlane(palette.sigil, 'flashStar', SIGIL_SIZE);
    mesh.quaternion.copy(_flatX);
    mesh.position.set(0, SIGIL_Y, 0);
    mesh.scale.set(0.0001, 0.0001, 0.0001); // start invisibly small
    mesh.userData.angle = angle;
    mesh.userData.mat = mat;
    mesh.userData.geo = geo;
    group.add(mesh);
    sigilMeshes.push(mesh);
  }

  const burstHandle = {
    group,
    burstMeshes,
    sigilMeshes,
    t: 0,
  };
  _bursts.push(burstHandle);

  // ── Rim: separate handle so it can outlive the 1.2s burst envelope.
  // Attached to scene root with absolute follow on the player (set in tick)
  // rather than parented to state.hero.mesh — keeps disposal symmetric with
  // the burst pipeline and survives heroGroup recreate (rebuildHero).
  const rimBuild = _makeRimRing(palette.rim);
  rimBuild.mesh.position.set(baseX, 0.05, baseZ);
  scene.add(rimBuild.mesh);
  _rims.push({
    mesh: rimBuild.mesh,
    mat: rimBuild.mat,
    geo: rimBuild.geo,
    t: 0,
    life: RIM_LIFE,
  });

  return burstHandle;
}

/**
 * Per-frame tick. Mirrors the chainFx.js update pattern:
 *   - integrate t by dt
 *   - if k >= 1: dispose + splice
 *   - else: animate scale/position/opacity
 *
 * Burst envelope (1.2s total):
 *   0.00 - 0.20s: explosive growth, full bright (k_grow)
 *   0.20 - 1.20s: fade out radially while continuing to drift outward
 *
 * Sigil envelope:
 *   0.00 - 0.40s: scale 0 → 1 (eased), orbit angle advances
 *   0.40 - 1.20s: hold full scale, opacity fades to 0 over the remaining time
 *
 * Rim: linear opacity fade from 0.80 to 0.0 over RIM_LIFE seconds.
 * Position follows `state.hero.pos` each tick via lazy require (avoids
 * import cycle between fx/ and state).
 */
export function tickEvolveBursts(dt) {
  // ── Bursts + sigils ──
  for (let i = _bursts.length - 1; i >= 0; i--) {
    const b = _bursts[i];
    b.t += dt;
    const k = b.t / BURST_LIFE;
    if (k >= 1) {
      _disposeBurst(b);
      _bursts.splice(i, 1);
      continue;
    }

    // Burst expansion: position lerps from center to BURST_RADIUS, opacity
    // ramps 0 → 1 in the first 15% then fades 1 → 0. Visual contract:
    // "1.2s window must feel punchy" — front-load brightness, trail-fade.
    const burstK = k;
    const opacity = burstK < 0.15
      ? burstK / 0.15
      : Math.max(0, 1 - (burstK - 0.15) / 0.85);
    const radius = BURST_RADIUS * burstK;
    const scale = 1.0 + burstK * 0.8; // slight grow while fading
    for (const m of b.burstMeshes) {
      const ang = m.userData.angle;
      m.position.x = Math.cos(ang) * radius;
      m.position.z = Math.sin(ang) * radius;
      m.scale.set(scale, scale, scale);
      m.userData.mat.opacity = opacity;
    }

    // Sigil ring: scale-in (eased cubic) for first SIGIL_SCALE_IN seconds,
    // then orbit + fade. Rotation rate is shared so the ring reads as one
    // unit rather than 6 independent sprites.
    const sigilT = b.t;
    const scaleK = Math.min(1, sigilT / SIGIL_SCALE_IN);
    const sigilScale = scaleK < 1
      ? (1 - Math.pow(1 - scaleK, 3))         // ease-out cubic
      : 1.0;
    const sigilOpacity = sigilT < SIGIL_SCALE_IN
      ? scaleK
      : Math.max(0, 1 - (sigilT - SIGIL_SCALE_IN) / (BURST_LIFE - SIGIL_SCALE_IN));
    const ringRot = sigilT * SIGIL_ROT_SPEED;
    for (const m of b.sigilMeshes) {
      const ang = m.userData.angle + ringRot;
      m.position.x = Math.cos(ang) * SIGIL_RADIUS_END;
      m.position.z = Math.sin(ang) * SIGIL_RADIUS_END;
      const s = sigilScale * SIGIL_SIZE / SIGIL_SIZE; // explicit unit-scale
      m.scale.set(s, s, s);
      m.userData.mat.opacity = sigilOpacity;
    }
  }

  // ── Rims (independent timer, lives 30s) ──
  // Lazy hero-pos lookup so this module stays cycle-free; state.hero.pos is
  // the same vec the camera + weapons read each frame.
  let heroX = 0, heroZ = 0;
  let havePos = false;
  try {
    // eslint-disable-next-line global-require
    const stateMod = _stateRef || (typeof window !== 'undefined' && window.__kk_state__);
    const heroPos = stateMod && stateMod.hero && stateMod.hero.pos;
    if (heroPos) { heroX = heroPos.x || 0; heroZ = heroPos.z || 0; havePos = true; }
  } catch (_) { /* no-op: rim will sit at spawn position if state unreachable */ }

  for (let i = _rims.length - 1; i >= 0; i--) {
    const r = _rims[i];
    r.t += dt;
    const k = r.t / r.life;
    if (k >= 1) {
      _disposeRim(r);
      _rims.splice(i, 1);
      continue;
    }
    if (havePos) {
      r.mesh.position.x = heroX;
      r.mesh.position.z = heroZ;
    }
    // Linear opacity fade 0.80 → 0.0; subtle pulse so the rim breathes
    // rather than looking like a static decal.
    const pulse = 0.92 + 0.08 * Math.sin(r.t * 3.0);
    r.mat.opacity = 0.80 * (1 - k) * pulse;
  }
}

function _disposeBurst(b) {
  if (b.group && b.group.parent) b.group.parent.remove(b.group);
  for (const m of b.burstMeshes) {
    try { m.userData.geo && m.userData.geo.dispose(); } catch (_) {}
    try { m.userData.mat && m.userData.mat.dispose(); } catch (_) {}
  }
  for (const m of b.sigilMeshes) {
    try { m.userData.geo && m.userData.geo.dispose(); } catch (_) {}
    try { m.userData.mat && m.userData.mat.dispose(); } catch (_) {}
  }
  b.burstMeshes.length = 0;
  b.sigilMeshes.length = 0;
}

function _disposeRim(r) {
  if (r.mesh && r.mesh.parent) r.mesh.parent.remove(r.mesh);
  try { r.geo && r.geo.dispose(); } catch (_) {}
  try { r.mat && r.mat.dispose(); } catch (_) {}
}

/**
 * Hard cleanup — drop every live burst + rim immediately. Call on stage
 * teardown / run reset so we don't leak meshes when the scene swaps under
 * us. Mirrors `disposeAllChainArcs` in chainFx.js.
 */
export function disposeAllEvolveBursts(scene) {
  for (const b of _bursts) _disposeBurst(b);
  _bursts.length = 0;
  for (const r of _rims) _disposeRim(r);
  _rims.length = 0;
}

// ─── State accessor wiring ──────────────────────────────────────────────────
// To follow the player without a static `import { state } from '../state.js'`
// (which would create an import cycle once weapons/index.js imports us),
// `setEvolveBurstStateRef(state)` is called once at boot. Cheap, idiomatic,
// matches how other modules (forestAmber, voidTeleportPads) take state via
// their public APIs.
let _stateRef = null;
export function setEvolveBurstStateRef(s) { _stateRef = s || null; }

// ─── Debug / test hook ──────────────────────────────────────────────────────
export function _debugActiveInstanceCount() { return _activeInstanceCount(); }
export function _debugActiveRimCount() { return _rims.length; }
