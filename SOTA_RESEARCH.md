# KK Survivors — SOTA Research (May 2026)

Stack target: THREE.js 0.160+ via importmap, no bundler, GitHub Pages. Goal: punch above weight with techniques that ship in a single iteration.

---

## 1. GPU Particle Systems (WebGL2 / WebGPU)

**Resources**
- [Field Guide to TSL and WebGPU — Maxime Heckel](https://blog.maximeheckel.com/posts/field-guide-to-tsl-and-webgpu/) — the canonical 2025 reference for compute + node materials.
- [GPGPU particles with TSL & WebGPU — Wawa Sensei](https://wawasensei.dev/courses/react-three-fiber/lessons/tsl-gpgpu) — hands-on 100k+ particle code using `instancedArray`.
- [three.js webgpu_tsl_compute_attractors_particles example](https://threejs.org/examples/webgpu_tsl_compute_attractors_particles.html) — official, copy-pasteable.
- [Codrops GPGPU dreamy particles (WebGL2 fallback)](https://tympanus.net/codrops/2024/12/19/crafting-a-dreamy-particle-effect-with-three-js-and-gpgpu/) — for the no-WebGPU path via `GPUComputationRenderer`.

**Applicability.** A horde game lives or dies on projectile + hit-spark counts. TSL `instancedArray` keeps particle state on the GPU across frames, eliminating the per-frame upload that caps WebGL CPU particle systems around 5–10k. Reported gains: 10k @ 30ms CPU → 100k @ <2ms GPU (≈150x).

**Iteration ship.** Add a `three/webgpu` entry with automatic WebGL2 fallback. Build one `Particles` system backed by a TSL compute kernel (position, velocity, lifetime in `instancedArray`); render as `Sprite`-style billboards via `InstancedMesh`. Use it for: bullet trails, blood, XP-gem shimmer, damage numbers. Target 20k live particles as a stretch.

---

## 2. Procedural Enemy / Level Generation

**Resources**
- [mxgmn/WaveFunctionCollapse](https://github.com/mxgmn/WaveFunctionCollapse) — reference impl + tile constraint patterns; ports to JS exist.
- [Graph-based WFC for roguelites (IEEE 2024)](https://ieeexplore.ieee.org/document/10547926/) — adapts WFC for rooms-and-doors rather than pixel tiles.
- [PCG Benchmark — arXiv 2503.21474](https://arxiv.org/abs/2503.21474) — 12 standard PCG tasks, useful for sanity-checking generators.
- [PCG + LLM survey — arXiv 2410.15644](https://arxiv.org/html/2410.15644v1) — current state of learned generators.

**Applicability.** A horde arena doesn't need full dungeons, but biome decoration (rocks, props, hazard zones) and enemy spawn patterns benefit massively from constraint-based gen. Pure WFC handles tile decoration; for "wave choreography" (enemy mix per minute), a small markov / weighted-grammar approach beats neural models for a static-site deploy.

**Iteration ship.** Two generators: (a) a 200-line JS WFC over a 32x32 ground tile palette for arena decoration variants per run; (b) a JSON-defined wave grammar with weighted-random rules ("after 3min, mix archer + swarmer at 0.7/0.3"). Skip neural PCG until WebGPU compute is everywhere — ship cost too high.

---

## 3. Lightweight AI for Hordes

**Resources**
- [jlfwong/gpu-boids](https://github.com/jlfwong/gpu-boids) — GLSL transform-feedback boids, ~5k agents on a laptop.
- [WebGPU.com BOIDS showcase](https://www.webgpu.com/showcase/antlii-boids-emergent-flocking-behavior/) — modern parametric flocking reference.
- [zakkgcm/3dboids (three.js)](https://github.com/zakkgcm/3dboids) — three.js-native starting point.

**Applicability.** Brotato/VS-style enemies don't need GOAP. A flocking layer (separation + cohesion + seek-player) gives the visual richness of "they push each other / clump around you" that makes 500 enemies feel alive. Tier 2 = utility AI scoring on a small set (charge, retreat, ranged) for elite enemies, evaluated every N frames per agent.

**Iteration ship.** Per-frame: GPU boids compute pass over the enemy `instancedArray` (separation radius, seek-player vector, max-speed clamp). Per 250ms: CPU utility scoring only on elites (~10 entities). One shared `InstancedMesh` per enemy archetype; matrix update in the same compute pass.

---

## 4. Stylized PBR / NPR

**Resources**
- [Custom Toon Shader in three.js — maya-ndljk](https://www.maya-ndljk.com/blog/threejs-basic-toon-shader) — clean step-shading walkthrough.
- [three.js forum: smooth cartoon style with outlines](https://discourse.threejs.org/t/how-to-create-this-smooth-cartoon-style-with-outlines-in-three-js/60862) — current consensus on outline approaches.
- [Three.js OutlinePass + post FX](https://medium.com/@coderfromnineteen/three-js-post-processing-outline-effect-6dff6a2fe3c0) — production recipe.

**Applicability.** A cohesive NPR look hides low-poly assets, masks z-fighting on hundreds of enemies, and dodges PBR's cost. Three pillars: (1) `MeshToonMaterial` + custom ramp tex for 3-band shading, (2) inverted-hull outlines per archetype (cheap, no post pass, scales with `InstancedMesh`), (3) one post-process: a screen-space Sobel edge on depth+normal for world geometry only, plus a Bayer-dither vignette for mood.

**Iteration ship.** Replace all enemy materials with `MeshToonMaterial` + a shared 4-band gradient map. Add inverted-hull outline as a second instanced draw per archetype (front-face culled, scale 1.03). One `EffectComposer` chain: `RenderPass` → custom dither/vignette pass. Skip OutlinePass — it doesn't scale to 500 instanced enemies.

---

## 5. Browser Audio Synthesis

**Resources**
- [chr15m/jsfxr](https://github.com/chr15m/jsfxr) — sfxr port; 10 presets (laser, explosion, coin) directly usable for VS-style sfx.
- [Tone.js](https://tonejs.github.io/) — Transport + Pattern for procedural background music.
- [DEV: Procedural audio with Web Audio API (2025)](https://dev.to/hexshift/how-to-create-procedural-audio-effects-in-javascript-with-web-audio-api-199e) — zero-dep synth patterns.

**Applicability.** Hordes need *thousands* of sfx triggers — sample playback chokes on memory and channel count. Synthesized sfx are 0 KB ship cost and can be parameterized per hit (pitch by damage, decay by enemy size). For music, a Tone.js `Pattern` over 2–3 seeded scales gives infinite background loops sized in KB not MB.

**Iteration ship.** Wrap jsfxr in an `AudioPool` (16 voices, voice-stealing by age). Procedurally generate 8 hit/explode/pickup variants at boot, store as `AudioBuffer`s. Music: Tone.js with one synth + one drum, a 4-bar pattern picked from a seed per run. Total audio bundle: <50 KB.

---

## 6. Save / Leaderboards Without a Backend

**Resources**
- [Cloudflare D1 free tier — 5GB, 5M reads/day, 100k writes/day](https://developers.cloudflare.com/d1/) — fits any indie leaderboard.
- [The $0 Infrastructure Stack — Cloudflare free tier gist](https://gist.github.com/garyblankenship/27a4c57eca4aa5d659ee3c509668b66d) — concrete patterns.
- [Cloudflare Workers KV free tier](https://www.cloudflare.com/developer-platform/products/d1/) — for hot top-100 cache.

**Applicability.** GitHub Pages hosts the static client; Cloudflare Workers handles writes. Local save = `localStorage` JSON (existing player code). Leaderboard write path: Worker validates HMAC-signed run + writes to D1; read path: KV cache of top-100, refreshed by cron. GitHub Gist as DB works for <100 daily players but rate-limits hard — don't.

**Iteration ship.** One Worker, two routes: `POST /run` (HMAC-validate score+seed+duration, insert into D1), `GET /top` (return KV-cached JSON). Client signs runs with a build-time secret rotated weekly via GitHub Action. Cost: $0 unless we hit 100k DAU.

---

## 7. Multiplayer / Hangout Over WebRTC

**Resources**
- [geckos.io](https://github.com/geckosio/geckos.io) — UDP-over-WebRTC client/server with rooms; battle-tested for HTML5 games.
- [netplayjs (rameshvarun)](https://github.com/rameshvarun/netplayjs) — rollback netcode + WebRTC, true P2P, no server.
- [WebGameDev WebRTC guide](https://www.webgamedev.com/backend/webrtc) — current best-practices doc.

**Applicability.** For a Club-Penguin-style lobby/hangout (cosmetic positions + chat, not authoritative combat), full P2P via PeerJS-style signaling is enough — one host per room, ≤8 peers, position broadcast at 10 Hz. Combat stays single-player so rollback complexity is avoided. Signaling can be a tiny Cloudflare Worker (same one as leaderboards) holding offer/answer SDPs in KV with 60s TTL.

**Iteration ship.** Hangout-only mode: between-run lobby room, P2P via PeerJS, 8 peers max, broadcast `{x,z,emote}` at 100ms. Reuse the leaderboard Worker for signaling. Defer netcoded co-op combat — design first, ship cosmetics.

---

## 8. WebGPU Migration Path

**Resources**
- [WebGPU + Three.js Migration Guide 2026 (utsubo)](https://www.utsubo.com/blog/webgpu-threejs-migration-guide) — covers r171 cutover.
- [What's New in Three.js 2026](https://www.utsubo.com/blog/threejs-2026-what-changed) — feature matrix.
- [three.js Migration Guide wiki](https://github.com/mrdoob/three.js/wiki/Migration-Guide) — official.

**Applicability.** Since r171 (Sept 2025) `import * as THREE from 'three/webgpu'` ships a production WebGPU renderer with automatic WebGL2 fallback. Coverage is ≈95% of users on WebGPU, the rest fall back transparently. Caveats: `WebGLCubeRenderTarget` → `CubeRenderTarget`, shadow bias values need re-tuning (often lower), `OutlinePass` and some `examples/jsm/postprocessing` are not yet WebGPU-native — use TSL `PostProcessing` instead.

**Iteration ship.** Bump three.js to 0.171+ in the importmap. Swap renderer behind a `?renderer=webgpu` query flag first; default to WebGL2 for one iteration to validate visuals across browsers. Replace any cube render targets, retune shadow bias, port the post chain to TSL. Once visuals match, flip default to WebGPU — fallback path keeps the long tail working.

---

## Priority Stack for Next Iteration

1. **r171 + WebGPU flag** (unlocks topics 1, 3 at scale).
2. **TSL compute particles** (visual win, replaces existing system).
3. **GPU boids for enemy movement** (gameplay feel win).
4. **Toon material + inverted-hull outlines** (cohesive look, cheap).
5. **jsfxr AudioPool + Tone.js music** (kills sample bundle).
6. **Cloudflare Worker + D1 leaderboard** (retention loop).
7. WFC arena decoration — nice-to-have.
8. WebRTC hangout lobby — defer until 5 is stable.
