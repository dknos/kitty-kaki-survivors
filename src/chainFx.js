/**
 * Chain-lightning arc renderer — shared between src/weapons/chain.js and
 * stage interactables (forestAmber, etc.).
 *
 * **SilkStorm Arcs (Punch List #5, 2026-05-16):**
 * Upgraded from constant-radius TubeGeometry to **variable-width additive
 * ribbon meshes with time-evolving vertex noise** so chain arcs match the
 * Spider Web FX quality bar (line weight 0.06–0.10 world units, additive
 * blending, BLOOM_LAYER tagged, organic flicker).
 *
 * **Why a mesh pool, not InstancedMesh**:
 *   InstancedMesh shares one geometry across all instances — same vertex
 *   positions, only the per-instance matrix differs. Chain arcs need a
 *   different jagged path between different endpoint pairs every frame,
 *   so a single shared geometry cannot describe them all. The cheaper
 *   path is a **pool of N pre-allocated meshes**, each with its own
 *   reusable BufferGeometry whose position attribute is rewritten on
 *   spawn and each tick. Zero per-spawn allocation in the hot path.
 *
 *   (three/addons Line2 would also work and supports variable width,
 *   but adds an unused dependency surface and only Line2.setPositions
 *   rewrites — vertex noise still requires per-frame buffer churn.
 *   Mesh-pool is no more expensive and keeps us inside `three` core.)
 *
 * **Ribbon construction**:
 *   For each arc segment i (0..S) at parameter t = i/S, we generate
 *   two world-space vertices straddling the curve point by ±width(t)
 *   along the camera-perpendicular axis (we use the +Y axis as the
 *   "ribbon up" — the iso camera looks down-at-an-angle, so a vertical
 *   ribbon reads as a flat lightning bolt regardless of viewing angle).
 *   Width tapers via sin(t·π) so endpoints pinch like the Spider Web
 *   strands; vertex noise modulates outward by `noise(t, time)` for
 *   organic flicker each frame.
 *
 * **Pre-pool size**: ARC_POOL_CAP = 48 simultaneous arcs. Chain Lightning
 * Lv 8 fires up to 1 hero+8 chains = 9 arcs per volley, plus ~35% branch
 * forks ≈ 12. With the Storm evolution echo + concurrent forest amber
 * detonations (CHAIN_MAX = 3 per amber × up to 4 amber/frame = 12), 48
 * is a comfortable headroom over the "8+ concurrent" perf bar.
 *
 * Used by: src/weapons/chain.js, src/forestAmber.js. Ticked centrally
 * from src/main.js via tickChainArcs(dt).
 *
 * Public API (unchanged from pre-SilkStorm):
 *   spawnChainArc(scene, a, b, opts) → handle | null
 *     a, b: { x, z } endpoints (world coords)
 *     opts: {
 *       outerColor: 0xa8e6ff,     // glow ribbon color (default cyan-white)
 *       innerColor: 0xa8e6ff,     // core ribbon color (often same as outer)
 *       life: 0.4,                // fade duration in seconds
 *       segments: <auto>,         // arc subdivisions; auto from dist if omitted
 *       jitter: <auto>,           // perpendicular jitter; auto from dist if omitted
 *       y: 0.7,                   // world Y for arc midpoint
 *       outerRadius: 0.085,       // outer ribbon HALF-width (target 0.07–0.09 avg)
 *       innerRadius: 0.035,       // inner hot core HALF-width
 *       bloom: true,              // tag BLOOM_LAYER on both ribbons
 *     }
 *     Returns null if pool exhausted (graceful drop — a partial spawn
 *     reads worse than no spawn).
 *
 *   tickChainArcs(dt)
 *     Per-frame: integrate t, advance noise phase (vertex flicker),
 *     fade opacity, return slot to free pool when expired.
 *     Outer fades linearly (1-k); inner fades cubic (1-k²) so the hot
 *     core lingers — preserved from pre-SilkStorm visual identity.
 *
 *   disposeAllChainArcs(scene)
 *     Soft cleanup: hides every active arc and frees its slot. The
 *     pool meshes themselves stay attached to the scene (cheap — they
 *     have zero-opacity materials when idle). Pass scene=null after
 *     scene swap to skip the parent unbind.
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from './postfx.js';

// ─── Tunables ───────────────────────────────────────────────────────────────

// Pool cap — see header comment. Higher than the previous unbounded list
// (which was effectively whatever happened to be live) but bounded so we
// never spike under storm-evolution + amber-detonation overlap. Each slot
// owns two ribbon meshes (outer + inner) → 96 pre-allocated meshes total.
const ARC_POOL_CAP = 48;

// Ribbon vertex count — fixed per slot so the position buffer can be
// reused without reallocation. SEGMENTS+1 spine points × 2 (top/bottom)
// = (SEGMENTS+1)*2 vertices. With 12 segments → 26 vertices × 3 floats
// = 78 floats per ribbon × 2 (outer+inner) × 48 slots = 7488 floats =
// 30 KB resident, trivial.
const SEGMENTS = 12;
const VERTS_PER_RIBBON = (SEGMENTS + 1) * 2;

// Defaults — radii reduced from the pre-SilkStorm 0.14/0.05 to land
// inside the Spider Web standard's 0.06–0.10 world-unit line-weight
// window. Outer 0.085 is the midpoint of the 0.07–0.09 average band;
// inner 0.035 is the hot-core ratio (~0.4× outer, matching pre-refactor
// 0.05/0.14 = 0.36 ratio). Both consumers (chain.js, forestAmber.js)
// take these defaults — neither passes outerRadius/innerRadius.
const DEFAULT_Y           = 0.7;
const DEFAULT_LIFE        = 0.4;
const DEFAULT_OUTER_R     = 0.085;
const DEFAULT_INNER_R     = 0.035;
const DEFAULT_OUTER_COLOR = 0xa8e6ff;
const DEFAULT_INNER_COLOR = 0xa8e6ff;
const OUTER_OPACITY       = 0.55;
const INNER_OPACITY       = 1.0;

// Vertex-noise amplitude as a fraction of segment length. 0.18 reads as
// a clear electric flicker without losing the underlying jagged-path
// silhouette. Time phase is per-arc (slot.noisePhase) so two arcs spawned
// the same frame don't pulse in lockstep.
const NOISE_AMP_FRAC = 0.18;
// Noise time-domain rate. Higher = faster flicker. 28 Hz reads as
// "electricity" rather than "wave" without strobing on a 60 Hz frame.
const NOISE_RATE = 28.0;

// ─── Module state ───────────────────────────────────────────────────────────

// Pool: every slot is a pre-allocated handle. `live === false` means the
// slot is free and its meshes are hidden (zero opacity). Spawn finds the
// first free slot, rebuilds the spine, sets live=true. Tick fades + on
// expiry sets live=false.
//
// Slot shape:
//   {
//     live: bool,
//     t: number, life: number,
//     outerMesh, outerMat, outerGeo, outerPos: Float32Array,
//     innerMesh, innerMat, innerGeo, innerPos: Float32Array,
//     spine: Vector3[SEGMENTS+1],        // baked centerline (jitter applied)
//     noiseSeed: Float32Array(SEGMENTS+1), // per-vertex random phase for time-evolving offset
//     noisePhase: number,                  // per-arc time accumulator
//     outerR: number, innerR: number,
//     scene: THREE.Scene | null,           // for soft-remove on dispose
//   }
const _pool = [];
let _poolInitialized = false;

// Scratch vectors — reused inside the per-frame ribbon write to avoid
// any per-spawn / per-frame Vector3 allocation. Module-scope so they
// survive between calls without re-construction.
const _vSpine = new THREE.Vector3();
const _vPrev  = new THREE.Vector3();
const _vNext  = new THREE.Vector3();
const _vTan   = new THREE.Vector3();

// Ribbon "up" axis — vertices are extruded ±width along world +Y.
// Because the camera is iso looking down-and-along, a vertical ribbon
// reads as a flat lightning streak for any X/Z arc direction. Constant
// avoids per-frame Vector3 construction.
const RIBBON_UP_Y = 1.0;

/**
 * Lazily initialize the mesh pool. Called from spawnChainArc on first
 * use — we don't pay the allocation at module-load time because not
 * every run uses chain lightning or forest amber.
 *
 * Note: meshes are NOT attached to a scene here. They are attached on
 * first spawn (which gives us the scene reference) and stay attached
 * for the rest of the run, sitting at zero opacity when idle. Cheaper
 * than add/remove on every spawn cycle.
 */
function _initPool() {
  if (_poolInitialized) return;
  _poolInitialized = true;
  for (let i = 0; i < ARC_POOL_CAP; i++) {
    _pool.push(_makeSlot());
  }
}

/**
 * Build one pool slot — two ribbon meshes (outer + inner) with reusable
 * Float32Array position buffers. Geometry shape:
 *
 *   v0 ──── v2 ──── v4 ─── …   (top edge, +Y from spine)
 *   │  ╲    │  ╲    │
 *   │   ╲   │   ╲   │       triangles: (0,1,2)(2,1,3)(2,3,4)(4,3,5)…
 *   v1 ──── v3 ──── v5 ─── …   (bottom edge, -Y from spine)
 *
 * Indices are baked once at slot creation (they never change — only the
 * vertex positions are rewritten per-frame).
 */
function _makeSlot() {
  // Indices — fixed for SEGMENTS quads → 2*SEGMENTS triangles → 6*SEGMENTS index entries.
  const indices = new Uint16Array(SEGMENTS * 6);
  for (let s = 0; s < SEGMENTS; s++) {
    const v0 = s * 2;
    const v1 = v0 + 1;
    const v2 = v0 + 2;
    const v3 = v0 + 3;
    indices[s * 6 + 0] = v0;
    indices[s * 6 + 1] = v1;
    indices[s * 6 + 2] = v2;
    indices[s * 6 + 3] = v2;
    indices[s * 6 + 4] = v1;
    indices[s * 6 + 5] = v3;
  }

  // Build one ribbon (mesh + material + geometry + pos buffer).
  function buildRibbon(initialColor, initialOpacity) {
    const pos = new Float32Array(VERTS_PER_RIBBON * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    // Spider Web FX recipe: additive blending so multiple overlapping arcs
    // brighten, no depth write so they don't fight each other / scene.
    const mat = new THREE.MeshBasicMaterial({
      color: initialColor,
      transparent: true,
      opacity: initialOpacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide, // ribbon viewed from either side reads identically
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;     // arcs are tiny + short-lived; bypass cull cost
    mesh.layers.enable(BLOOM_LAYER); // join the bloom pass — non-negotiable per spec
    mesh.visible = false;            // start hidden (idle slot)
    return { mesh, mat, geo, pos };
  }

  const outer = buildRibbon(DEFAULT_OUTER_COLOR, 0);
  const inner = buildRibbon(DEFAULT_INNER_COLOR, 0);

  // Pre-allocate spine + noise buffers. SEGMENTS+1 Vector3s for the
  // centerline, SEGMENTS+1 floats for per-vertex random noise phase.
  const spine = new Array(SEGMENTS + 1);
  for (let i = 0; i < spine.length; i++) spine[i] = new THREE.Vector3();
  const noiseSeed = new Float32Array(SEGMENTS + 1);

  return {
    live: false,
    t: 0, life: DEFAULT_LIFE,
    outerMesh: outer.mesh, outerMat: outer.mat, outerGeo: outer.geo, outerPos: outer.pos,
    innerMesh: inner.mesh, innerMat: inner.mat, innerGeo: inner.geo, innerPos: inner.pos,
    spine,
    noiseSeed,
    noisePhase: 0,
    outerR: DEFAULT_OUTER_R,
    innerR: DEFAULT_INNER_R,
    scene: null,
  };
}

/**
 * Find the first free pool slot. Returns null if every slot is live —
 * caller drops the spawn (graceful, no allocation).
 */
function _findFreeSlot() {
  for (let i = 0; i < _pool.length; i++) {
    if (!_pool[i].live) return _pool[i];
  }
  return null;
}

/**
 * Bake the jagged centerline into slot.spine[]. Identical formula to
 * the pre-SilkStorm `_arcPoints` (perpendicular displacement tapered by
 * sin(t·π), with a small Y jitter for vertical wiggle). Spawn-time only
 * — the per-frame vertex noise on top of this is what supplies organic
 * flicker; the spine itself is fixed for the arc's life so the rough
 * shape stays consistent.
 */
function _bakeSpine(slot, a, b, jitter, y, useSegments) {
  // We allocate exactly SEGMENTS+1 spine points regardless of the
  // distance-derived `useSegments` so the pool buffers can be reused.
  // The opts.segments value is honored by re-mapping: visible "kinks"
  // are placed every `step` points; in-between spine points are linearly
  // interpolated so the silhouette matches the requested segment count
  // without growing the buffer.
  const spine = slot.spine;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.max(0.001, Math.hypot(dx, dz));
  const px = -dz / len;
  const pz =  dx / len;

  // Kink positions in [0..SEGMENTS]. useSegments may be < SEGMENTS for
  // short arcs (chain branches use 3 kinks). Each kink gets a fresh
  // jitter sample; in-between spine points lerp between adjacent kinks
  // so the silhouette honors the requested kink count.
  const kinks = Math.max(2, Math.min(SEGMENTS, useSegments));
  const kinkOff = new Array(kinks + 1);
  const kinkY   = new Array(kinks + 1);
  for (let k = 0; k <= kinks; k++) {
    const t = k / kinks;
    const taper = Math.sin(t * Math.PI);
    kinkOff[k] = (Math.random() * 2 - 1) * jitter * taper;
    kinkY[k]   = (Math.random() * 2 - 1) * jitter * 0.35 * taper;
  }

  for (let i = 0; i <= SEGMENTS; i++) {
    const t = i / SEGMENTS;
    // Find which kink-pair this spine point sits between.
    const kf = t * kinks;
    const k0 = Math.min(kinks - 1, Math.floor(kf));
    const k1 = k0 + 1;
    const lerpT = kf - k0;
    const off  = kinkOff[k0] * (1 - lerpT) + kinkOff[k1] * lerpT;
    const yJit = kinkY[k0]   * (1 - lerpT) + kinkY[k1]   * lerpT;
    spine[i].set(
      a.x + dx * t + px * off,
      y + yJit,
      a.z + dz * t + pz * off,
    );
  }

  // Per-vertex noise seed — fresh random phase per spawn so two arcs
  // spawned the same frame don't flicker in lockstep.
  for (let i = 0; i <= SEGMENTS; i++) {
    slot.noiseSeed[i] = Math.random() * Math.PI * 2;
  }
}

/**
 * Smooth deterministic noise for vertex flicker. We use a cheap
 * sin-product (NOT Perlin / simplex — we don't ship a noise lib and the
 * visual cost of a "real" noise function vs two sin() calls is zero for
 * a 13-vertex ribbon). The seed offset per vertex breaks any visible
 * sin-wave horizon; the time term gives organic motion.
 */
function _vertexNoise(seed, phase) {
  // Range roughly [-1, 1]. Two-frequency sin product breaks visible
  // periodicity to the eye.
  return Math.sin(seed + phase) * 0.6 + Math.sin(seed * 1.7 + phase * 0.6) * 0.4;
}

/**
 * Per-frame ribbon writer. Rewrites the position attribute for one
 * ribbon (outer or inner) from the slot's spine + time-evolving noise.
 *
 * Width is variable along the arc:
 *   width(t) = halfWidth * sin(t·π) * (0.85 + 0.30 * |noise(t, time)|)
 *
 * The sin(t·π) taper pinches both endpoints (anchor cleanly into the
 * casting hand / target), and the noise multiplier swells/contracts
 * along the length giving the "silk strand" thickness variation.
 *
 * Extrusion axis is world +Y — see RIBBON_UP_Y comment. The spine
 * already encodes XZ jitter, so the ribbon reads as a flat-but-jagged
 * lightning streak from the iso camera.
 */
function _writeRibbon(slot, pos, halfWidth, noisePhase, taperOpacity) {
  const spine = slot.spine;
  const seeds = slot.noiseSeed;
  const ampScale = halfWidth * NOISE_AMP_FRAC; // unused — width modulation is multiplicative; see comment
  // (ampScale is kept as a name so future maintainers know where to
  // change vertex-offset behavior. Current path modulates width, not
  // spine position — modulating spine here would fight the chain.js
  // branch-fork visual which relies on the spine staying anchored to
  // the source endpoint.)
  for (let i = 0; i <= SEGMENTS; i++) {
    const t = i / SEGMENTS;
    const taper = Math.sin(t * Math.PI);
    const n = _vertexNoise(seeds[i], noisePhase);
    // Width modulation — taper × (steady + noise wobble). Never goes
    // below 60% of taper so the inner core can't pinch to zero (which
    // would break the BufferGeometry triangle as a degenerate quad).
    const w = halfWidth * taper * Math.max(0.60, 0.85 + 0.30 * n);
    const sx = spine[i].x;
    const sy = spine[i].y;
    const sz = spine[i].z;
    const baseIdx = i * 6;
    // Top vertex (+Y by w)
    pos[baseIdx + 0] = sx;
    pos[baseIdx + 1] = sy + w * RIBBON_UP_Y;
    pos[baseIdx + 2] = sz;
    // Bottom vertex (-Y by w)
    pos[baseIdx + 3] = sx;
    pos[baseIdx + 4] = sy - w * RIBBON_UP_Y;
    pos[baseIdx + 5] = sz;
  }
  // ampScale referenced once to keep ESLint happy + signal intent. The
  // variable's nominal use is documented above.
  void ampScale;
}

/**
 * Spawn one chain arc between a and b. Reserves a pool slot, rebuilds
 * its spine + materials, makes it live. Returns the slot as the handle
 * (mostly for tests; production callers fire-and-forget).
 *
 * Returns null if the pool is exhausted (every slot live). Graceful drop
 * — better silent no-op than a half-rendered arc.
 */
export function spawnChainArc(scene, a, b, opts = {}) {
  if (!scene || !a || !b) return null;
  _initPool();

  const slot = _findFreeSlot();
  if (!slot) return null; // pool exhausted — drop this spawn

  // Distance-derived defaults match the pre-SilkStorm formula so the
  // silhouette stays familiar; callers can still override segments/jitter
  // explicitly if a stage wants a custom feel.
  const dist = Math.hypot(b.x - a.x, b.z - a.z);
  const useSegments = (opts.segments != null)
    ? opts.segments
    : Math.max(5, Math.min(10, Math.floor(dist / 1.2)));
  const jitter = (opts.jitter != null)
    ? opts.jitter
    : Math.min(1.1, 0.25 + dist * 0.06);

  const y           = opts.y           != null ? opts.y           : DEFAULT_Y;
  const life        = opts.life        != null ? opts.life        : DEFAULT_LIFE;
  const outerRadius = opts.outerRadius != null ? opts.outerRadius : DEFAULT_OUTER_R;
  const innerRadius = opts.innerRadius != null ? opts.innerRadius : DEFAULT_INNER_R;
  const outerColor  = opts.outerColor  != null ? opts.outerColor  : DEFAULT_OUTER_COLOR;
  const innerColor  = opts.innerColor  != null ? opts.innerColor  : DEFAULT_INNER_COLOR;
  const bloom       = opts.bloom       !== false;

  // Bake the centerline + per-vertex noise seeds.
  _bakeSpine(slot, a, b, jitter, y, useSegments);

  // Reset per-arc state.
  slot.t = 0;
  slot.life = life;
  slot.noisePhase = Math.random() * Math.PI * 2; // de-sync from sibling arcs
  slot.outerR = outerRadius;
  slot.innerR = innerRadius;
  slot.scene = scene;
  slot.live = true;

  // Material refresh — color may have changed from a previous lease.
  slot.outerMat.color.setHex(outerColor);
  slot.innerMat.color.setHex(innerColor);
  slot.outerMat.opacity = OUTER_OPACITY;
  slot.innerMat.opacity = INNER_OPACITY;

  // Bloom toggle — handled per-spawn since `opts.bloom: false` is rare
  // but supported (callers can suppress bloom for low-FX mode).
  if (bloom) {
    slot.outerMesh.layers.enable(BLOOM_LAYER);
    slot.innerMesh.layers.enable(BLOOM_LAYER);
  } else {
    slot.outerMesh.layers.disable(BLOOM_LAYER);
    slot.innerMesh.layers.disable(BLOOM_LAYER);
  }

  // Initial ribbon write — visible immediately on the spawn frame
  // rather than waiting for the next tick (which would cause a 1-frame
  // empty ribbon at full opacity, reading as a flash artifact).
  _writeRibbon(slot, slot.outerPos, slot.outerR, slot.noisePhase, 1.0);
  _writeRibbon(slot, slot.innerPos, slot.innerR, slot.noisePhase, 1.0);
  slot.outerGeo.attributes.position.needsUpdate = true;
  slot.innerGeo.attributes.position.needsUpdate = true;
  slot.outerGeo.computeBoundingSphere();
  slot.innerGeo.computeBoundingSphere();

  // Attach to scene if not already (first-spawn lazy attach — see
  // _initPool comment). Cheap: scene.add is a no-op if already child.
  if (slot.outerMesh.parent !== scene) {
    scene.add(slot.outerMesh);
    scene.add(slot.innerMesh);
  }
  slot.outerMesh.visible = true;
  slot.innerMesh.visible = true;

  return slot;
}

/**
 * Per-frame tick. Single call drains all active slots — main.js runs
 * this once after stage interactables so both chain.js (weapon) and
 * forestAmber (interactable) share the same fade pipeline.
 *
 * Per slot:
 *   1) advance lifetime t and noise phase
 *   2) if k >= 1: fade out + return slot to pool
 *   3) else: opacity fade + rewrite ribbon positions for flicker
 */
export function tickChainArcs(dt) {
  if (!_poolInitialized) return;
  for (let i = 0; i < _pool.length; i++) {
    const s = _pool[i];
    if (!s.live) continue;
    s.t += dt;
    const k = s.t / s.life;
    if (k >= 1) {
      // Soft return — hide, drop opacity, mark free. Meshes stay
      // attached to the scene (zero alloc on next reuse).
      s.live = false;
      s.outerMesh.visible = false;
      s.innerMesh.visible = false;
      s.outerMat.opacity = 0;
      s.innerMat.opacity = 0;
      continue;
    }
    // Advance noise phase — same NOISE_RATE for all slots so the FX
    // reads as one consistent material; per-vertex seeds break the
    // visible periodicity that would otherwise come from a shared rate.
    s.noisePhase += dt * NOISE_RATE;

    // Fade curves preserved from pre-SilkStorm:
    //   outer = linear (1-k) — soft halo fades evenly
    //   inner = (1-k²)        — hot core lingers, crisp tail
    s.outerMat.opacity = OUTER_OPACITY * (1 - k);
    s.innerMat.opacity = INNER_OPACITY * (1 - k * k);

    // Rewrite ribbon positions — time-evolving vertex noise modulates
    // ribbon width along the spine so the arc reads as electric flicker
    // rather than a static frozen tube.
    _writeRibbon(s, s.outerPos, s.outerR, s.noisePhase, 1.0);
    _writeRibbon(s, s.innerPos, s.innerR, s.noisePhase, 1.0);
    s.outerGeo.attributes.position.needsUpdate = true;
    s.innerGeo.attributes.position.needsUpdate = true;
    // Bounding sphere drift is small (vertex offsets <= radius), but
    // frustumCulled=false means we don't actually need to recompute it
    // every frame — skip for perf. Reset only when slot is reused.
  }
}

/**
 * Soft cleanup — frees every live slot immediately. Call on stage
 * teardown (e.g. forestAmber's clearForestAmber) so the next arena's
 * arcs spawn fresh.
 *
 * Pool meshes themselves are NOT disposed — they stay alive across
 * stage swaps for the rest of the run, which is the point of pooling.
 * If the caller wants them detached (e.g. scene rebuild), passing the
 * scene reference lets us remove them from the old scene; they'll
 * re-attach on the next spawnChainArc call to the new scene.
 */
export function disposeAllChainArcs(scene) {
  if (!_poolInitialized) return;
  for (let i = 0; i < _pool.length; i++) {
    const s = _pool[i];
    if (s.live) {
      s.live = false;
      s.outerMat.opacity = 0;
      s.innerMat.opacity = 0;
      s.outerMesh.visible = false;
      s.innerMesh.visible = false;
    }
    // Detach from the old scene if a scene was passed and the mesh is
    // currently parented under a different scene than the caller's.
    // Cheap no-op if the parent already matches.
    if (scene && s.outerMesh.parent && s.outerMesh.parent !== scene) {
      s.outerMesh.parent.remove(s.outerMesh);
      s.innerMesh.parent.remove(s.innerMesh);
      s.scene = null;
    }
  }
}

// Debug — count live slots without leaking the pool reference.
export function _debugActiveArcCount() {
  if (!_poolInitialized) return 0;
  let n = 0;
  for (let i = 0; i < _pool.length; i++) if (_pool[i].live) n++;
  return n;
}

// Debug — pool capacity (constant). Lets tests assert against the
// documented cap without re-importing the literal.
export function _debugPoolCap() { return ARC_POOL_CAP; }

// _vSpine / _vPrev / _vNext / _vTan are reserved for a future spine-
// curvature-aware ribbon extrusion (camera-facing normal). Current path
// uses fixed world +Y which reads correctly under the locked iso
// camera; if we ever add a free-look camera mode, the ribbon extrusion
// can switch to (tangent × cameraDir) without API churn.
void _vSpine; void _vPrev; void _vNext; void _vTan;
