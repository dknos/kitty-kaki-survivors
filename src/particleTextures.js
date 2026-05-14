/**
 * Procedural particle textures. Generated once via canvas → DataTexture.
 * Cheaper and more reliable than shipping PNGs:
 *  - No CDN dependency
 *  - Single asset preload step
 *  - Exact look matches the game aesthetic
 *
 * Each texture is 128×128 RGBA, mipmapped, with anisotropy where useful.
 */
import * as THREE from 'three';

const SIZE = 128;
const _cache = {};

function _ctx() {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  return c.getContext('2d');
}

function _toTex(canvasCtx) {
  const tex = new THREE.CanvasTexture(canvasCtx.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Radial soft glow — bright center fading to alpha 0. */
function _makeGlow(color = '#ffffff') {
  const ctx = _ctx();
  const cx = SIZE / 2, cy = SIZE / 2;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, SIZE * 0.5);
  g.addColorStop(0.00, color);
  g.addColorStop(0.25, color);
  g.addColorStop(0.55, color + '88');
  g.addColorStop(1.00, color + '00');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SIZE, SIZE);
  return _toTex(ctx);
}

/** Spark — bright pinpoint core with cross-pattern flares. */
function _makeSpark(color = '#fff7a8') {
  const ctx = _ctx();
  const cx = SIZE / 2, cy = SIZE / 2;
  // Soft core
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, SIZE * 0.35);
  core.addColorStop(0.00, '#ffffff');
  core.addColorStop(0.20, color);
  core.addColorStop(1.00, color + '00');
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, SIZE, SIZE);
  // Plus-shaped flare overlay
  ctx.globalCompositeOperation = 'lighter';
  const flare = ctx.createLinearGradient(0, cy, SIZE, cy);
  flare.addColorStop(0, color + '00');
  flare.addColorStop(0.5, '#ffffff');
  flare.addColorStop(1, color + '00');
  ctx.fillStyle = flare;
  ctx.fillRect(0, cy - 2, SIZE, 4);
  const flare2 = ctx.createLinearGradient(cx, 0, cx, SIZE);
  flare2.addColorStop(0, color + '00');
  flare2.addColorStop(0.5, '#ffffff');
  flare2.addColorStop(1, color + '00');
  ctx.fillStyle = flare2;
  ctx.fillRect(cx - 2, 0, 4, SIZE);
  ctx.globalCompositeOperation = 'source-over';
  return _toTex(ctx);
}

/** Smoke puff — irregular cloud blob with noise. */
function _makeSmoke(color = '#cfd4dc') {
  const ctx = _ctx();
  const img = ctx.createImageData(SIZE, SIZE);
  const cx = SIZE / 2, cy = SIZE / 2;
  // Color base
  const cR = parseInt(color.slice(1, 3), 16);
  const cG = parseInt(color.slice(3, 5), 16);
  const cB = parseInt(color.slice(5, 7), 16);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = (x - cx) / (SIZE * 0.45);
      const dy = (y - cy) / (SIZE * 0.45);
      const r = Math.sqrt(dx * dx + dy * dy);
      // Multi-octave noise for cloud feel
      const n = (Math.sin(x * 0.4) + Math.cos(y * 0.45) + Math.sin((x + y) * 0.31)) * 0.08;
      const falloff = Math.max(0, 1 - r + n);
      const alpha = Math.max(0, Math.min(1, Math.pow(falloff, 1.8)));
      const i = (y * SIZE + x) * 4;
      img.data[i + 0] = cR;
      img.data[i + 1] = cG;
      img.data[i + 2] = cB;
      img.data[i + 3] = Math.floor(alpha * 220);
    }
  }
  ctx.putImageData(img, 0, 0);
  return _toTex(ctx);
}

/** Ring — a thin glowing torus seen face-on. */
function _makeRing(color = '#ffe14a') {
  const ctx = _ctx();
  const cx = SIZE / 2, cy = SIZE / 2;
  const g = ctx.createRadialGradient(cx, cy, SIZE * 0.30, cx, cy, SIZE * 0.48);
  g.addColorStop(0.00, color + '00');
  g.addColorStop(0.45, color + '00');
  g.addColorStop(0.70, color + 'ff');
  g.addColorStop(0.85, color + 'aa');
  g.addColorStop(1.00, color + '00');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SIZE, SIZE);
  return _toTex(ctx);
}

/** Shockwave — thick double-edge ring for explosions. */
function _makeShockwave(color = '#ffd078') {
  const ctx = _ctx();
  const cx = SIZE / 2, cy = SIZE / 2;
  // Outer wider band
  const g1 = ctx.createRadialGradient(cx, cy, SIZE * 0.30, cx, cy, SIZE * 0.50);
  g1.addColorStop(0.00, color + '00');
  g1.addColorStop(0.55, color + '00');
  g1.addColorStop(0.78, color + 'ff');
  g1.addColorStop(0.92, color + 'aa');
  g1.addColorStop(1.00, color + '00');
  ctx.fillStyle = g1;
  ctx.fillRect(0, 0, SIZE, SIZE);
  // Inner thin hot edge
  ctx.globalCompositeOperation = 'lighter';
  const g2 = ctx.createRadialGradient(cx, cy, SIZE * 0.36, cx, cy, SIZE * 0.42);
  g2.addColorStop(0.00, '#ffffff00');
  g2.addColorStop(0.55, '#ffffffff');
  g2.addColorStop(1.00, '#ffffff00');
  ctx.fillStyle = g2;
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.globalCompositeOperation = 'source-over';
  return _toTex(ctx);
}

/** Multi-point flash star — hot white core with 6 long flares. */
function _makeFlashStar(color = '#fff4c8') {
  const ctx = _ctx();
  const cx = SIZE / 2, cy = SIZE / 2;
  // Hot soft core
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, SIZE * 0.30);
  core.addColorStop(0.00, '#ffffff');
  core.addColorStop(0.35, color);
  core.addColorStop(1.00, color + '00');
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, SIZE, SIZE);
  // 6 streaks rotated around center
  ctx.globalCompositeOperation = 'lighter';
  ctx.translate(cx, cy);
  for (let s = 0; s < 6; s++) {
    ctx.save();
    ctx.rotate((s * Math.PI) / 3);
    const lg = ctx.createLinearGradient(-SIZE * 0.48, 0, SIZE * 0.48, 0);
    lg.addColorStop(0.00, color + '00');
    lg.addColorStop(0.45, color + 'ff');
    lg.addColorStop(0.50, '#ffffff');
    lg.addColorStop(0.55, color + 'ff');
    lg.addColorStop(1.00, color + '00');
    ctx.fillStyle = lg;
    ctx.fillRect(-SIZE * 0.48, -1.5, SIZE * 0.96, 3);
    ctx.restore();
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  return _toTex(ctx);
}

/**
 * Twinkle sparkle — small 4-point bright cross on transparent.
 * Designed as an additive billboard overlay (XP gems, pickup halos, treasure).
 * Distinct from `_makeSpark` (6-flare star): this one is a compact "plink".
 */
function _makeTwinkle(color = '#fff9e6') {
  const ctx = _ctx();
  const cx = SIZE / 2, cy = SIZE / 2;
  ctx.clearRect(0, 0, SIZE, SIZE);
  // Tight hot core
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, SIZE * 0.18);
  core.addColorStop(0.00, '#ffffff');
  core.addColorStop(0.45, color);
  core.addColorStop(1.00, color + '00');
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, SIZE, SIZE);
  // 4-arm cross flare (vertical + horizontal)
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 2; i++) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((i * Math.PI) / 2);
    const lg = ctx.createLinearGradient(-SIZE * 0.45, 0, SIZE * 0.45, 0);
    lg.addColorStop(0.00, color + '00');
    lg.addColorStop(0.46, color + 'cc');
    lg.addColorStop(0.50, '#ffffff');
    lg.addColorStop(0.54, color + 'cc');
    lg.addColorStop(1.00, color + '00');
    ctx.fillStyle = lg;
    ctx.fillRect(-SIZE * 0.45, -1.2, SIZE * 0.9, 2.4);
    ctx.restore();
  }
  ctx.globalCompositeOperation = 'source-over';
  return _toTex(ctx);
}

/**
 * Sesame bun cap — a tan circle with 5 darker sesame seed ovals and a soft
 * highlight on upper-left. Designed as a top-down decal painted onto the
 * burger's dome bun so it reads as food, not a primitive sphere.
 */
function _makeBunCap() {
  const ctx = _ctx();
  const cx = SIZE / 2, cy = SIZE / 2;
  ctx.clearRect(0, 0, SIZE, SIZE);
  // Bun body — warm tan radial w/ baked highlight upper-left
  const body = ctx.createRadialGradient(cx - 22, cy - 28, 6, cx, cy, SIZE * 0.50);
  body.addColorStop(0.00, '#fbd8a0');
  body.addColorStop(0.30, '#e8b170');
  body.addColorStop(0.85, '#b87a3a');
  body.addColorStop(1.00, '#7c4e22');
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(cx, cy, SIZE * 0.48, 0, Math.PI * 2);
  ctx.fill();
  // Ink outline (style bible — 4px primary)
  ctx.strokeStyle = '#231a14';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(cx, cy, SIZE * 0.46, 0, Math.PI * 2);
  ctx.stroke();
  // 5 sesame seeds — small bone-tan ovals on warm rotation
  const seeds = [
    [-0.05, -0.30, 0.10],
    [ 0.22, -0.10, -0.20],
    [-0.22, -0.05, 0.35],
    [ 0.05,  0.18, 0.00],
    [-0.12,  0.25, -0.15],
  ];
  for (const [sx, sy, rot] of seeds) {
    ctx.save();
    ctx.translate(cx + sx * SIZE * 0.5, cy + sy * SIZE * 0.5);
    ctx.rotate(rot);
    // Seed body
    ctx.fillStyle = '#fff4d0';
    ctx.beginPath();
    ctx.ellipse(0, 0, 6, 3.2, 0, 0, Math.PI * 2);
    ctx.fill();
    // Seed shadow (2px secondary line per style bible)
    ctx.strokeStyle = '#231a14';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, 0, 6, 3.2, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  // Soft glaze highlight (upper-left, per style bible "one shadow angle")
  ctx.fillStyle = 'rgba(255, 249, 230, 0.30)';
  ctx.beginPath();
  ctx.ellipse(cx - 18, cy - 20, 14, 7, -0.35, 0, Math.PI * 2);
  ctx.fill();
  return _toTex(ctx);
}

/**
 * Cheese drip decal — square cheese slice with 3 wavy drips off the side and
 * an ink outline. Used as a top-down overlay over the burger patty so the
 * cheese reads as a real slice, not a flat box.
 */
function _makeCheeseSlice(color = '#ffc23a') {
  const ctx = _ctx();
  ctx.clearRect(0, 0, SIZE, SIZE);
  const cx = SIZE / 2, cy = SIZE / 2;
  const half = SIZE * 0.38;
  // Slice body — wavy bottom edge to suggest melt
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx - half, cy - half);
  ctx.lineTo(cx + half, cy - half);
  ctx.lineTo(cx + half, cy + half * 0.35);
  // Three drips along the bottom
  ctx.bezierCurveTo(cx + half * 0.45, cy + half * 0.75, cx + half * 0.30, cy + half * 0.70, cx + half * 0.18, cy + half * 0.95);
  ctx.bezierCurveTo(cx,                cy + half * 0.45, cx - half * 0.18, cy + half * 0.85, cx - half * 0.35, cy + half * 0.55);
  ctx.bezierCurveTo(cx - half * 0.55, cy + half * 0.30, cx - half * 0.85, cy + half * 0.65, cx - half,        cy + half * 0.20);
  ctx.closePath();
  ctx.fill();
  // Ink outline
  ctx.strokeStyle = '#231a14';
  ctx.lineWidth = 4;
  ctx.stroke();
  // Highlight streak across upper-left
  ctx.fillStyle = 'rgba(255, 249, 230, 0.35)';
  ctx.beginPath();
  ctx.ellipse(cx - half * 0.45, cy - half * 0.45, half * 0.32, 4, -0.3, 0, Math.PI * 2);
  ctx.fill();
  return _toTex(ctx);
}

/**
 * Patty stripe decal — dark brown grill marks on a warm brown disc.
 * Painted onto the patty cylinder's top face.
 */
function _makePattyTop() {
  const ctx = _ctx();
  ctx.clearRect(0, 0, SIZE, SIZE);
  const cx = SIZE / 2, cy = SIZE / 2;
  // Body
  ctx.fillStyle = '#3e1f0e';
  ctx.beginPath();
  ctx.arc(cx, cy, SIZE * 0.46, 0, Math.PI * 2);
  ctx.fill();
  // Char-grill mottle (4 darker random patches)
  ctx.fillStyle = '#231108';
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const r = SIZE * (0.10 + Math.random() * 0.25);
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    ctx.beginPath();
    ctx.arc(x, y, 3 + Math.random() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  // 3 lighter grill marks (warm sear)
  ctx.strokeStyle = '#7a3a18';
  ctx.lineWidth = 5;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.moveTo(cx - SIZE * 0.4, cy - SIZE * 0.18 + i * SIZE * 0.18);
    ctx.lineTo(cx + SIZE * 0.4, cy - SIZE * 0.18 + i * SIZE * 0.18);
    ctx.stroke();
  }
  // Ink ring
  ctx.strokeStyle = '#231a14';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(cx, cy, SIZE * 0.44, 0, Math.PI * 2);
  ctx.stroke();
  return _toTex(ctx);
}

/**
 * Heart sprite (top-down) — sakura pink heart with bone highlight and
 * 4px ink outline. Painted onto the heart pickup quad as a billboard halo.
 */
function _makeHeartSprite(color = '#ff3a78') {
  const ctx = _ctx();
  ctx.clearRect(0, 0, SIZE, SIZE);
  const cx = SIZE / 2, cy = SIZE / 2;
  // Heart path (centered, top notch)
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(SIZE * 0.42, SIZE * 0.42);
  ctx.beginPath();
  ctx.moveTo(0, -0.45);
  ctx.bezierCurveTo(-1.0, -1.05, -1.4, -0.05, 0, 0.95);
  ctx.bezierCurveTo(1.4, -0.05, 1.0, -1.05, 0, -0.45);
  ctx.closePath();
  // Body fill
  ctx.fillStyle = color;
  ctx.fill();
  // Outline (4px in original space = scaled appropriately)
  ctx.lineWidth = 0.10;
  ctx.strokeStyle = '#231a14';
  ctx.stroke();
  // Highlight oval upper-left
  ctx.fillStyle = 'rgba(255, 249, 230, 0.6)';
  ctx.beginPath();
  ctx.ellipse(-0.35, -0.30, 0.20, 0.10, -0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  return _toTex(ctx);
}

/**
 * Star sprite — 5-point pointy star with ink outline and warm highlight.
 * Used as the magnet-pickup billboard overlay.
 */
function _makeStarSprite(color = '#ffd24a') {
  const ctx = _ctx();
  ctx.clearRect(0, 0, SIZE, SIZE);
  const cx = SIZE / 2, cy = SIZE / 2;
  const outer = SIZE * 0.42;
  const inner = SIZE * 0.18;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = (i % 2 === 0) ? outer : inner;
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#231a14';
  ctx.stroke();
  // Highlight oval upper-left
  ctx.fillStyle = 'rgba(255, 249, 230, 0.55)';
  ctx.beginPath();
  ctx.ellipse(cx - 14, cy - 14, 10, 5, -0.4, 0, Math.PI * 2);
  ctx.fill();
  return _toTex(ctx);
}

/**
 * Bomb sprite — black sphere with a curved fuse + spark dot. Top-down.
 */
function _makeBombSprite() {
  const ctx = _ctx();
  ctx.clearRect(0, 0, SIZE, SIZE);
  const cx = SIZE / 2, cy = SIZE / 2;
  // Body radial w/ highlight
  const body = ctx.createRadialGradient(cx - 12, cy - 14, 4, cx, cy, SIZE * 0.42);
  body.addColorStop(0.00, '#5a5a64');
  body.addColorStop(0.45, '#2a2a32');
  body.addColorStop(1.00, '#0a0a10');
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(cx, cy, SIZE * 0.40, 0, Math.PI * 2);
  ctx.fill();
  // Outline
  ctx.strokeStyle = '#231a14';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(cx, cy, SIZE * 0.40, 0, Math.PI * 2);
  ctx.stroke();
  // Fuse curve to upper-right
  ctx.strokeStyle = '#c98a3a';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(cx + SIZE * 0.30, cy - SIZE * 0.18);
  ctx.bezierCurveTo(cx + SIZE * 0.42, cy - SIZE * 0.30, cx + SIZE * 0.48, cy - SIZE * 0.34, cx + SIZE * 0.40, cy - SIZE * 0.40);
  ctx.stroke();
  // Spark at tip
  const spark = ctx.createRadialGradient(cx + SIZE * 0.40, cy - SIZE * 0.40, 0, cx + SIZE * 0.40, cy - SIZE * 0.40, SIZE * 0.10);
  spark.addColorStop(0.00, '#ffffff');
  spark.addColorStop(0.40, '#ff9a3a');
  spark.addColorStop(1.00, 'rgba(255,154,58,0)');
  ctx.fillStyle = spark;
  ctx.fillRect(cx + SIZE * 0.28, cy - SIZE * 0.50, SIZE * 0.30, SIZE * 0.30);
  return _toTex(ctx);
}

/**
 * Snowflake sprite — 6-arm crystalline shape for the freeze pickup.
 */
function _makeSnowflakeSprite(color = '#a8e6ff') {
  const ctx = _ctx();
  ctx.clearRect(0, 0, SIZE, SIZE);
  const cx = SIZE / 2, cy = SIZE / 2;
  // Soft halo background
  const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, SIZE * 0.5);
  halo.addColorStop(0.00, color + '88');
  halo.addColorStop(0.50, color + '22');
  halo.addColorStop(1.00, color + '00');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, SIZE, SIZE);
  // 6 crystal arms
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = '#ffffff';
  ctx.lineCap = 'round';
  for (let a = 0; a < 6; a++) {
    ctx.save();
    ctx.rotate((a * Math.PI) / 3);
    // Main spoke
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -SIZE * 0.40);
    ctx.stroke();
    // Branches at 60% and 80%
    ctx.lineWidth = 2;
    for (const r of [SIZE * 0.22, SIZE * 0.32]) {
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(-r * 0.22, -r - r * 0.22);
      ctx.moveTo(0, -r);
      ctx.lineTo( r * 0.22, -r - r * 0.22);
      ctx.stroke();
    }
    ctx.restore();
  }
  // Hot core
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(0, 0, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  return _toTex(ctx);
}

/**
 * Drumstick sprite (chicken leg) — warm brown with bone highlight.
 * Top-down silhouette for the heal pickup.
 */
function _makeDrumstickSprite() {
  const ctx = _ctx();
  ctx.clearRect(0, 0, SIZE, SIZE);
  const cx = SIZE / 2, cy = SIZE / 2;
  // Drumstick meat (round) — warm tan
  const meat = ctx.createRadialGradient(cx - 12, cy + 4, 4, cx, cy + 6, SIZE * 0.36);
  meat.addColorStop(0.00, '#f0c886');
  meat.addColorStop(0.50, '#c8884a');
  meat.addColorStop(1.00, '#7c4a1e');
  ctx.fillStyle = meat;
  ctx.beginPath();
  ctx.ellipse(cx, cy + 6, SIZE * 0.32, SIZE * 0.30, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#231a14';
  ctx.stroke();
  // Bone (small cylinder upper)
  ctx.fillStyle = '#fff4d0';
  ctx.beginPath();
  ctx.ellipse(cx, cy - SIZE * 0.28, SIZE * 0.07, SIZE * 0.16, 0, 0, Math.PI * 2);
  ctx.fill();
  // Bone knobs (two ovals at the top)
  ctx.beginPath();
  ctx.ellipse(cx - 8, cy - SIZE * 0.40, 6, 7, -0.3, 0, Math.PI * 2);
  ctx.ellipse(cx + 8, cy - SIZE * 0.40, 6, 7,  0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#231a14';
  ctx.stroke();
  // Meat-to-bone seam
  ctx.beginPath();
  ctx.moveTo(cx - SIZE * 0.08, cy - SIZE * 0.18);
  ctx.lineTo(cx + SIZE * 0.08, cy - SIZE * 0.18);
  ctx.stroke();
  return _toTex(ctx);
}

/**
 * Pollen — soft cyan-cream dandelion fluff. Multi-blob noise for the
 * Forest stage hazard.
 */
function _makePollen(color = '#cfeaff') {
  const ctx = _ctx();
  const img = ctx.createImageData(SIZE, SIZE);
  const cx = SIZE / 2, cy = SIZE / 2;
  const cR = parseInt(color.slice(1, 3), 16);
  const cG = parseInt(color.slice(3, 5), 16);
  const cB = parseInt(color.slice(5, 7), 16);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = (x - cx) / (SIZE * 0.45);
      const dy = (y - cy) / (SIZE * 0.45);
      const r = Math.sqrt(dx * dx + dy * dy);
      // Two-octave warble — fluffy speckle
      const n = (Math.sin(x * 0.55 + y * 0.32) * 0.5 + Math.cos((x + y) * 0.21) * 0.5) * 0.10;
      const falloff = Math.max(0, 1 - r + n);
      const alpha = Math.max(0, Math.min(1, Math.pow(falloff, 1.5)));
      // Speckle dots: small high-frequency dots on top
      const speckle = ((Math.sin(x * 1.7) * Math.cos(y * 1.7)) > 0.6) ? 0.25 : 0;
      const a = Math.min(1, alpha + speckle * falloff);
      const i = (y * SIZE + x) * 4;
      img.data[i + 0] = cR;
      img.data[i + 1] = cG;
      img.data[i + 2] = cB;
      img.data[i + 3] = Math.floor(a * 200);
    }
  }
  ctx.putImageData(img, 0, 0);
  return _toTex(ctx);
}

/**
 * Lava puddle — radial molten center, dark crust ring, jagged crack accents.
 * Used by Cinder hazard + lava cracks decor.
 */
function _makeLavaPuddle() {
  const ctx = _ctx();
  const cx = SIZE / 2, cy = SIZE / 2;
  ctx.clearRect(0, 0, SIZE, SIZE);
  // Outer dark crust ring
  const crust = ctx.createRadialGradient(cx, cy, SIZE * 0.30, cx, cy, SIZE * 0.50);
  crust.addColorStop(0.00, 'rgba(0,0,0,0)');
  crust.addColorStop(0.55, 'rgba(0,0,0,0)');
  crust.addColorStop(0.78, '#2a0e08');
  crust.addColorStop(0.95, '#0a0402');
  crust.addColorStop(1.00, 'rgba(0,0,0,0)');
  ctx.fillStyle = crust;
  ctx.fillRect(0, 0, SIZE, SIZE);
  // Molten interior — hot center, fade outward
  const lava = ctx.createRadialGradient(cx, cy, 0, cx, cy, SIZE * 0.46);
  lava.addColorStop(0.00, '#fff0a8');
  lava.addColorStop(0.25, '#ffae3a');
  lava.addColorStop(0.55, '#ff5a1a');
  lava.addColorStop(0.85, '#a02808');
  lava.addColorStop(1.00, 'rgba(0,0,0,0)');
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = lava;
  ctx.beginPath();
  ctx.arc(cx, cy, SIZE * 0.46, 0, Math.PI * 2);
  ctx.fill();
  // Crack veins — bright zigzags from center
  ctx.strokeStyle = '#ffd070';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  for (let v = 0; v < 5; v++) {
    const a = (v / 5) * Math.PI * 2 + Math.random() * 0.4;
    ctx.beginPath();
    let x = cx, y = cy;
    for (let step = 0; step < 5; step++) {
      const segLen = SIZE * 0.08 + Math.random() * SIZE * 0.04;
      const aa = a + (Math.random() - 0.5) * 0.7;
      x += Math.cos(aa) * segLen;
      y += Math.sin(aa) * segLen;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
  return _toTex(ctx);
}

/**
 * Wizard bolt — magenta-violet motion sprite. Tear-drop teardrop trail.
 */
function _makeWizardBolt(color = '#ff66ee') {
  const ctx = _ctx();
  ctx.clearRect(0, 0, SIZE, SIZE);
  const cx = SIZE / 2, cy = SIZE / 2;
  // Hot core
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, SIZE * 0.34);
  core.addColorStop(0.00, '#ffffff');
  core.addColorStop(0.35, color);
  core.addColorStop(0.85, color + '44');
  core.addColorStop(1.00, color + '00');
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, SIZE, SIZE);
  // Crackle arms — 3 short electric branches off center
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.8;
  for (let a = 0; a < 3; a++) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((a / 3) * Math.PI * 2 + Math.random() * 0.4);
    let x = 0, y = 0;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    for (let s = 0; s < 4; s++) {
      x += (Math.random() - 0.3) * 8;
      y -= 4 + Math.random() * 4;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }
  ctx.globalCompositeOperation = 'source-over';
  return _toTex(ctx);
}

/** Woven web — radial spokes + concentric strands, slight noise jitter. */
function _makeWeb(color = '#e8f4ff') {
  const ctx = _ctx();
  const cx = SIZE / 2, cy = SIZE / 2;
  // Faint background haze so the disc reads at any zoom
  const haze = ctx.createRadialGradient(cx, cy, 0, cx, cy, SIZE * 0.50);
  haze.addColorStop(0.00, color + '40');
  haze.addColorStop(0.70, color + '20');
  haze.addColorStop(1.00, color + '00');
  ctx.fillStyle = haze;
  ctx.fillRect(0, 0, SIZE, SIZE);

  ctx.lineCap = 'round';
  ctx.strokeStyle = color + 'd0';
  // 12 radial spokes
  ctx.lineWidth = 1.2;
  for (let s = 0; s < 12; s++) {
    const a = (s / 12) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * SIZE * 0.48, cy + Math.sin(a) * SIZE * 0.48);
    ctx.stroke();
  }
  // 4 concentric loops with tiny sag between spokes (decagonal arcs)
  const rings = [0.15, 0.27, 0.38, 0.47];
  for (const rN of rings) {
    const r = SIZE * rN;
    ctx.beginPath();
    for (let s = 0; s <= 12; s++) {
      const a = (s / 12) * Math.PI * 2;
      const jitter = 1 - 0.06 * Math.sin(a * 3 + rN * 9);
      const px = cx + Math.cos(a) * r * jitter;
      const py = cy + Math.sin(a) * r * jitter;
      if (s === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  // Bright center node
  const node = ctx.createRadialGradient(cx, cy, 0, cx, cy, 6);
  node.addColorStop(0, '#ffffff');
  node.addColorStop(1, color + '00');
  ctx.fillStyle = node;
  ctx.fillRect(cx - 8, cy - 8, 16, 16);
  return _toTex(ctx);
}

export function initParticleTextures() {
  if (_cache.glowWhite) return;
  _cache.glowWhite  = _makeGlow('#ffffff');
  _cache.glowCyan   = _makeGlow('#7fffd4');
  _cache.glowGold   = _makeGlow('#ffd24a');
  _cache.glowRed    = _makeGlow('#ff5555');
  _cache.sparkGold  = _makeSpark('#ffe14a');
  _cache.sparkCyan  = _makeSpark('#7fffe4');
  _cache.smokeGray  = _makeSmoke('#b8c0ca');
  _cache.smokeDark  = _makeSmoke('#3a3a44');
  _cache.ringGold   = _makeRing('#ffe14a');
  _cache.ringCyan   = _makeRing('#7fffd4');
  _cache.shockwave  = _makeShockwave('#ffd078');
  _cache.flashStar  = _makeFlashStar('#fff4c8');
  _cache.emberWarm  = _makeSpark('#ff9a3a');
  _cache.smokeWarm  = _makeSmoke('#6b4d3a');
  _cache.webBraid   = _makeWeb('#e8f4ff');
  _cache.twinkle    = _makeTwinkle('#fff9e6');
  _cache.twinkleGold= _makeTwinkle('#ffd24a');
  _cache.twinklePink= _makeTwinkle('#ffb8d4');
  _cache.bunCap     = _makeBunCap();
  _cache.cheeseSlice= _makeCheeseSlice('#ffc23a');
  _cache.cheeseToxic= _makeCheeseSlice('#a8ff3a');
  _cache.pattyTop   = _makePattyTop();
  _cache.heartSprite= _makeHeartSprite('#ff3a78');
  _cache.starSprite = _makeStarSprite('#ffd24a');
  _cache.bombSprite = _makeBombSprite();
  _cache.snowflake  = _makeSnowflakeSprite('#a8e6ff');
  _cache.drumstick  = _makeDrumstickSprite();
  _cache.pollen     = _makePollen('#cfeaff');
  _cache.lavaPuddle = _makeLavaPuddle();
  _cache.wizardBolt = _makeWizardBolt('#ff66ee');
  _cache.fireBolt   = _makeWizardBolt('#ff8855');
  _cache.iceBolt    = _makeWizardBolt('#88ddff');
}

export function tex(name) {
  return _cache[name] || null;
}
