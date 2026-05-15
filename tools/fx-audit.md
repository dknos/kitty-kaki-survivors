# FX Texture & Layer Audit

## TABLE A — Procedural Canvas Textures

| Name | File:Line Created | Size px | Callers (File:Line) | Current Layer |
|------|-------------------|---------|-------------------|---------------|
| glowWhite | particleTextures.js:948 | 128 | bossTelegraphs.js:159 (moteWhite) | World/Particle |
| glowCyan | particleTextures.js:949 | 128 | env.js:71 (Twilight twinkle) | World/Particle |
| glowGold | particleTextures.js:950 | 128 | weapons/orbitals.js (pickup halos) | World/Particle |
| glowRed | particleTextures.js:951 | 128 | stageHazards.js (Cinder effects) | World/Particle |
| sparkGold | particleTextures.js:952 | 128 | fx.js:76 (magnet spark) | World/Ground |
| sparkCyan | particleTextures.js:953 | 128 | fx.js:76 (magnet spark fallback) | World/Ground |
| smokeGray | particleTextures.js:954 | 128 | enemyProjectiles.js (projectile trails) | World/Particle |
| smokeDark | particleTextures.js:955 | 128 | damageNumbers.js (screen effects) | World/Particle |
| ringGold | particleTextures.js:956 (_makeLightningRing 512px) | 512 | fx.js:49 (kill ring), enemyTells.js (volatile) | World/Ground |
| ringCyan | particleTextures.js:957 | 128 | enemyTells.js (legacy fallback) | World/Ground |
| shockwave | particleTextures.js:958 (_makeShockwave 256px) | 256 | weapons/index.js (explosion FX) | World/Particle |
| flashStar | particleTextures.js:959 | 128 | enemyTells.js:967 (threat dot), bossTelegraphs.js (beacon) | World/Particle |
| emberWarm | particleTextures.js:960 | 128 | fx.js (elite kill ring color) | World/Particle |
| smokeWarm | particleTextures.js:961 | 128 | weapons (lava sprite) | World/Particle |
| webBraid | particleTextures.js:962 | 128 | web.js (web projectile) | World/Particle |
| twinkle | particleTextures.js:963 | 128 | chest.js:86 (chest halo), enemyTells.js (fallback) | World/Particle |
| twinkleGold | particleTextures.js:964 | 128 | fx.js:113 (kill ring pop), chest.js (golden twinkle) | World/Ground |
| twinklePink | particleTextures.js:965 | 128 | weapons/sigilbell.js (hex aura) | World/Particle |
| bunCap | particleTextures.js:966 | 128 | weapons/orbitals.js:172 (sesame decal) | World/Ground |
| cheeseSlice | particleTextures.js:967 | 128 | weapons/orbitals.js (cheese orbital decal) | World/Ground |
| cheeseToxic | particleTextures.js:968 | 128 | weapons/orbitals.js (toxic cheese decal) | World/Ground |
| pattyTop | particleTextures.js:969 | 128 | weapons/orbitals.js (patty decal) | World/Ground |
| heartSprite | particleTextures.js:970 | 128 | pickups (health restore) | World/Particle |
| starSprite | particleTextures.js:971 | 128 | pickups (magnet) | World/Particle |
| bombSprite | particleTextures.js:972 | 128 | pickups (bomb) | World/Particle |
| snowflake | particleTextures.js:973 | 128 | pickups (freeze), enemyTells.js:500+ (frost tells) | World/Particle |
| drumstick | particleTextures.js:974 | 128 | pickups (heal) | World/Particle |
| pollen | particleTextures.js:975 | 128 | stageHazards.js (Forest pollen cloud) | World/Particle |
| lavaPuddle | particleTextures.js:976 | 128 | stageHazards.js (Cinder lava pools) | World/Particle |
| wizardBolt | particleTextures.js:977 | 128 | weapons (wizard projectile) | World/Particle |
| fireBolt | particleTextures.js:978 | 128 | weapons (fire projectile) | World/Particle |
| iceBolt | particleTextures.js:979 | 128 | enemyProjectiles.js:29 (enemy frost projectile) | World/Particle |
| moteCyan | particleTextures.js:983 | 128 | bossTelegraphs.js (Engulf spiral), miniEvents.js (elite pack) | World/Particle |
| moteMagenta | particleTextures.js:984 | 128 | bossTelegraphs.js (Sonic cone motes) | World/Particle |
| moteAmber | particleTextures.js:985 | 128 | bossTelegraphs.js (Quake bar motes) | World/Particle |
| moteWhite | particleTextures.js:986 | 128 | bossTelegraphs.js:159 (fallback mote texture) | World/Particle |

## TABLE B — Floor-Layer Planes (Ground Decals)

| Effect Name | File:Line | Geometry + Size | Material Flags | RenderOrder | Rotation |
|-------------|-----------|-----------------|----------------|-------------|----------|
| Kill Ring | fx.js:48 | PlaneGeometry 2.0×2.0 | transparent, additive, depthWrite=false | -2 | -π/2 (flat) |
| Kill Ring Twinkle | fx.js:111 | PlaneGeometry 1.0×1.0 | transparent, additive, depthWrite=false | -2 | -π/2 (flat) |
| Magnet Spark | fx.js:75 | PlaneGeometry 0.6×0.6 | transparent, additive, depthWrite=false | -2 | -π/2 (flat) |
| Pickup Ring | fx.js:143 | PlaneGeometry 1.0×1.0 | transparent, additive, depthWrite=false, opacity=0.22 | -1 | -π/2 (flat) |
| Elite Wreath Ring | enemyTells.js:895,911 | PlaneGeometry 4.0×4.0 | transparent, additive, depthWrite=false | 4 | -π/2 (flat) |
| Volatile Explosive Ring | enemyTells.js:895,911 | PlaneGeometry 4.0×4.0 | transparent, additive, depthWrite=false | 4 | -π/2 (flat) |
| Frosted Crystal Ring | enemyTells.js:895,911 | PlaneGeometry 4.0×4.0 | transparent, additive, depthWrite=false | 4 | -π/2 (flat) |
| Shielded Herald Ring | enemyTells.js:895,911 | PlaneGeometry 4.0×4.0 | transparent, additive, depthWrite=false | 4 | -π/2 (flat) |
| Mini-Boss Blades Ring | enemyTells.js:895,911 | PlaneGeometry 4.0×4.0 | transparent, additive, depthWrite=false | 4 | -π/2 (flat) |
| Final Boss Claws Ring | enemyTells.js:895,911 | PlaneGeometry 4.0×4.0 | transparent, additive, depthWrite=false | 4 | -π/2 (flat) |
| Leap Marker | enemyTells.js:997,1011 | PlaneGeometry 4.0×4.0 | transparent, additive, depthWrite=false | 5 | -π/2 (flat), yaw spin per frame |
| Catacomb Entrance Rune | catacomb.js:296 | PlaneGeometry 1.56×1.56 | transparent, additive, depthWrite=false | (none) | -π/2 (pre-rotated), yaw 0.35 rad/s |
| Catacomb Stair Rune | catacomb.js:337 | PlaneGeometry 1.70×1.70 | transparent, additive, depthWrite=false | (none) | -π/2 (pre-rotated), yaw 0.45 rad/s |
| Blob Shadow | blobShadows.js:42 | PlaneGeometry 1.0×1.0 | MeshBasicMaterial, opacity varies | -1 | -π/2 (flat) |
| Cheese Orbital Decal | weapons/orbitals.js:183 | PlaneGeometry (cheeseSlice) | transparent, additive | 2 | -π/2 (flat) |
| Bun Orbital Decal | weapons/orbitals.js:172 | PlaneGeometry (bunCap) | transparent, additive | 3 | -π/2 (flat) |

## TABLE C — Portal / Dungeon-Entry Visuals

| Portal ID | Source File:Line | Geometry List | Particles? | Banner/Label? | Proximity Behaviour |
|-----------|------------------|---------------|-----------|---------------|-------------------|
| Catacomb Entrance | catacomb.js:259 | 4× BoxGeometry steps (stairs down), PlaneGeometry dark pit cap 2.4×2.4, 3× BoxGeometry frame stones, PlaneGeometry rune-ring 1.56×1.56 | None | E-prompt "Descend into the Catacomb" (DOM div at bottom-14%) | Show prompt when <2.2u dist; rune pulses opacity + rotates |
| Catacomb Exit Stairs | catacomb.js:318 | 3× BoxGeometry steps, PlaneGeometry rune-ring 1.70×1.70, arch GLB (kit_arch) | None | Exit via E (no explicit label) | Rune spins at 0.45 rad/s, no proximity feedback |
| Catacomb Chamber | catacomb.js:356 | PlaneGeometry floor 30×30, 4× BoxGeometry walls, GLB pillars (kit_pillar/alt/broken, 3 variants), GLB coffins (kit_coffin×2), GLB crypt (kit_crypt), GLB bones (kit_bone1/2/3×6), GLB torches (kit_torch_wall×4), rune-ring at stairs | PointLights (4 torches + 1 entrance + 1 stair = 6), emissive cone meshes (torches) | None | Torch lights flicker per tickCatacomb; rune glows via bloom layer |
| (No explicit arenaPortal or casino entry) | — | — | — | — | — |

## TABLE D — RenderOrder Usage

| File:Line | Object | RenderOrder | Reason |
|-----------|--------|-------------|--------|
| fx.js:71 | _ringInst (kill ring InstancedMesh) | -2 | "iter 33v — push behind hero + enemies. Transparent additive default-sorts AFTER opaque" |
| fx.js:97 | _sparkInst (magnet spark InstancedMesh) | -2 | Ground-rise sprites; keep behind hero/enemies |
| fx.js:130 | _ringTwinkleInst (kill ring twinkle pop) | -2 | Floor-layer pop, behind hero/enemies |
| fx.js:153 | _pickupRing (persistent pickup radius) | -1 | Below ground decals but still below opaque meshes |
| blobShadows.js:57 | _inst (shadow InstancedMesh) | -1 | "Render shadows BEFORE the colored meshes so transparency sorts cleanly" |
| bossTelegraphs.js:171 | _moteInst (mote particle pool) | 5 | Boss-telegraph particle layer (above enemy tells) |
| bossTelegraphs.js:339,357,374 | ring/mesh/bar per-windup meshes | 5 | Boss telegraph ground tells (Engulf/Sonic/Quake patterns) |
| enemyTells.js:911 | _ringsElite/Volatile/Frosted/Shielded/Mini/Final (6 family InstancedMesh) | 4 | Enemy ground rings (elite affixes) |
| enemyTells.js:953 | _rangedTells (ranged wind-up chevron InstancedMesh) | 5 | Enemy ranged charging tell (above rings, floats above head) |
| enemyTells.js:978 | _threatDots (threat-tier billboard InstancedMesh) | 6 | Mini-boss/final-boss danger dots (highest telegraph layer) |
| enemyTells.js:1011 | _leapMarkers (leap-target rune InstancedMesh) | 5 | Leap-affix ground tell (matches ranged tell height) |
| miniEvents.js:422 | inner (elite-pack ring inner) | 4 | Elite pack ring ground layer |
| miniEvents.js:423 | outline (elite-pack ring outline) | 5 | Elite pack ring bloom layer |
| miniEvents.js:537 | tellRing (elite-pack charging ring) | 5 | Elite pack wind-up tell |
| weapons/orbitals.js:174 | bunDecal (sesame bun orbital) | 3 | World-layer orbital food decal |
| weapons/orbitals.js:185 | toxicDecal (cheese orbital) | 2 | World-layer orbital food decal (lower priority) |

---

## Key Findings

**Floor-Layer Consistency:**
- Ground decals (kill rings, pickup ring, shadows) use renderOrder -2/-1, correctly sorted below opaque game objects.
- Enemy tells (ground rings, leaps) use renderOrder 4-6, inconsistent with kill rings (renderOrder=-2).
- **CONFLICT:** Kill rings (renderOrder=-2) and elite/volatile rings (renderOrder=4) may sort incorrectly when both visible.

**Canvas Texture Quality:**
- ringGold upgraded to 512×512 with lightning-fork branches (vs. legacy 128px radial gradient).
- 29 other procedural textures remain 128px canvas-drawn (spark, glow, mote-trails, pickup sprites).
- twinkle, bunCap, cheeseSlice, pattyTop, moteTrails are low-detail circle/cross/blob primitives (no high-freq detail).

**Portal Visuals:**
- Catacomb entry: stairs + dark pit + frame stones + spinning rune-ring + E-prompt DOM.
- Catacomb exit: stairs + spinning rune-ring + arch GLB overlay.
- No explicit "casino-entry portal" or "arenaPortal" object defined (casino entry is UI-driven via showCasinoMenu()).
- Catacomb runes use makeRuneRingTexture() (hand-painted band), not procedural canvas.

**Missing/Needs Audit:**
- Portal particle effects: no spawned particles at entry/exit (only visual geometry + lights).
- Proximity messaging: only Catacomb entrance shows DOM prompt; exit has no cue.
- Casino entry has no visual portal (menu-driven, not world-space).
