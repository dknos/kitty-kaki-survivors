/**
 * 3D character-select carousel (Iter 31).
 *
 * Self-contained WebGLRenderer + scene that hosts real GLB models of every
 * character on a sliding rail. Selected char centers + spins; flanking
 * chars sit small + still. Click a flanking char or arrow button to rotate
 * selection. Locked chars render dimmed silhouettes so the slot still reads.
 *
 * Critical contracts:
 *   - Materials MUST be cloned before tinting. The GLB cache shares materials
 *     across clones; mutating in-place would pollute the in-game hero.
 *   - Disposal: destroy() must release renderer, geometries owned here, and
 *     cloned materials. Geometries returned by SkeletonUtils.clone share buffer
 *     refs with the cache — never dispose those; only dispose materials we made.
 *   - Lazy: lights/meshes built on construct, RAF gated by `_visible` flag.
 */
import * as THREE from 'three';
import { cloneCached, lazyLoadGLTF, BASE } from './assets.js';

const RAIL_SPACING   = 2.6;      // x distance between adjacent char slots
const SLOT_SCALE     = 0.6;      // base scale of un-selected chars
const SELECTED_SCALE = 1.0;      // selected char scale
const SLIDE_LERP     = 8;        // higher = snappier rail
const SPIN_RATE      = 0.6;      // selected char spin (rad/s)
const PLATFORM_Y     = 0;

// Hero auto-fit target height — must match HERO.targetHeight so carousel
// preview reads at the same scale as in-game.
const TARGET_HEIGHT  = 1.4;

const C_AMBER = '#ffd27f';
const C_TEXT  = '#f5efe1';
const C_LOCK  = 'rgba(245,239,225,0.45)';
const F_DISP  = 'Cinzel, "Crimson Text", Georgia, serif';
const F_BODY  = '"Crimson Text", Georgia, serif';

/**
 * @param {HTMLElement} host - container the carousel mounts into
 * @param {Object} opts
 * @param {(charId:string)=>void} opts.onSelect - fires when selection changes
 * @param {string} [opts.initialId] - which item to focus initially
 * @param {Array} opts.items - roster array: {id, name, icon, glb?, tint?, scaleMul?, desc?, signatureName?, signatureDesc?, unlock?}
 * @param {(item:any)=>boolean} [opts.isUnlocked] - per-item lock predicate; defaults to all unlocked
 * @param {(item:any)=>string} [opts.formatLockHint] - override lock-hint text
 */
export function createCharCarousel(host, opts) {
  const onSelect = opts.onSelect || (() => {});
  const items = (opts.items || []).slice();
  const isUnlocked = opts.isUnlocked || (() => true);
  const formatLockHintFn = opts.formatLockHint || _formatLockHint;
  if (items.length === 0) throw new Error('charCarousel: items must be non-empty');
  // Keep `chars` alias to minimize diff against existing internal references.
  const chars = items;
  let selectedIdx = Math.max(0, chars.findIndex(c => c.id === opts.initialId));
  if (selectedIdx < 0) selectedIdx = 0;

  // ── Layout shell ────────────────────────────────────────────────────
  const wrap = document.createElement('div');
  wrap.style.cssText = `
    position: relative; display: flex; flex-direction: column; align-items: center;
    width: 100%; max-width: 760px; margin: 12px auto 0;
    pointer-events: auto;
  `;
  wrap.addEventListener('click', (e) => { e.stopPropagation(); });
  wrap.addEventListener('mousedown', (e) => { e.stopPropagation(); });
  wrap.addEventListener('pointerdown', (e) => { e.stopPropagation(); });

  // Stage row: [ ‹ ]  [ canvas stage ]  [ › ]
  const stageRow = document.createElement('div');
  stageRow.style.cssText = `
    display: flex; align-items: center; gap: 8px;
    width: 100%; pointer-events: auto;
  `;
  wrap.appendChild(stageRow);

  const mkArrow = (dir) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = dir < 0 ? '‹' : '›';
    b.setAttribute('aria-label', dir < 0 ? 'Previous character' : 'Next character');
    b.style.cssText = `
      flex: 0 0 auto;
      width: 52px; height: 52px; border-radius: 26px;
      background: linear-gradient(180deg, rgba(20,28,22,0.92), rgba(8,14,12,0.96));
      border: 1px solid rgba(255,210,127,0.55);
      color: ${C_AMBER}; font-size: 32px; line-height: 44px; font-weight: 700;
      cursor: pointer; user-select: none;
      box-shadow: 0 6px 16px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,210,127,0.12);
      pointer-events: auto;
      display: flex; align-items: center; justify-content: center;
      padding: 0;
      transition: background 0.15s, transform 0.1s;
    `;
    b.addEventListener('mouseenter', () => { b.style.background = 'linear-gradient(180deg, rgba(30,40,32,0.95), rgba(14,22,18,0.98))'; });
    b.addEventListener('mouseleave', () => { b.style.background = 'linear-gradient(180deg, rgba(20,28,22,0.92), rgba(8,14,12,0.96))'; });
    b.addEventListener('mousedown', (e) => { e.stopPropagation(); b.style.transform = 'translateY(1px)'; });
    b.addEventListener('mouseup', () => { b.style.transform = 'translateY(0)'; });
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      advance(dir);
    });
    return b;
  };
  const prevBtn = mkArrow(-1);
  const nextBtn = mkArrow(+1);

  const stage = document.createElement('div');
  stage.style.cssText = `
    position: relative; flex: 1 1 auto; aspect-ratio: 16 / 9; max-height: min(280px, 32vh);
    min-width: 0;
    border: 1px solid rgba(127,255,228,0.18);
    border-radius: 12px;
    background:
      radial-gradient(ellipse at center, rgba(40,60,52,0.55) 0%, rgba(8,14,12,0.92) 70%),
      linear-gradient(180deg, rgba(22,32,26,0.92), rgba(8,14,12,0.96));
    box-shadow: 0 18px 40px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.04);
    overflow: hidden;
  `;

  stageRow.appendChild(prevBtn);
  stageRow.appendChild(stage);
  stageRow.appendChild(nextBtn);

  // Pip indicator strip
  const pipRow = document.createElement('div');
  pipRow.style.cssText = `
    position: absolute; bottom: 10px; left: 0; right: 0;
    display: flex; gap: 8px; justify-content: center; pointer-events: none;
    z-index: 3;
  `;
  stage.appendChild(pipRow);

  // Info panel below the stage
  const info = document.createElement('div');
  info.style.cssText = `
    margin-top: 8px; padding: 8px 18px; min-height: 70px;
    border: 1px solid rgba(127,255,228,0.18);
    border-radius: 10px;
    background: linear-gradient(180deg, rgba(22,32,26,0.92), rgba(8,14,12,0.96));
    width: 100%; max-width: 760px; box-sizing: border-box;
    color: ${C_TEXT}; pointer-events: auto;
  `;
  wrap.appendChild(info);

  host.appendChild(wrap);

  // ── THREE init ──────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.8));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.style.cssText = `
    position: absolute; inset: 0; width: 100%; height: 100%; display: block;
    z-index: 1;
  `;
  stage.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 16/9, 0.1, 50);
  camera.position.set(0, 1.6, 5.2);
  camera.lookAt(0, 0.9, 0);

  // Lights — match in-game readability
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xfff3cc, 1.1);
  key.position.set(2.5, 4, 3);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x7fffe4, 0.45);
  rim.position.set(-3, 2, -2);
  scene.add(rim);

  // Platform disc — anchors the row visually
  const platformGeo = new THREE.CylinderGeometry(1.4, 1.5, 0.12, 48);
  const platformMat = new THREE.MeshStandardMaterial({
    color: 0x182a22, metalness: 0.3, roughness: 0.6,
    emissive: 0x0d1a14, emissiveIntensity: 0.4,
  });
  const platform = new THREE.Mesh(platformGeo, platformMat);
  platform.position.set(0, -0.06, 0);
  scene.add(platform);

  // Rail group — slides horizontally to center the selected char
  const rail = new THREE.Group();
  scene.add(rail);

  // Per-char slot data
  /** @type {Array<{char:any, group:THREE.Group, unlocked:boolean, ownedMats:THREE.Material[]}>} */
  const slots = [];

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const unlocked = !!isUnlocked(ch);
    const slot = new THREE.Group();
    slot.position.x = i * RAIL_SPACING;

    const key = ch.glb ? `hero_${ch.id}` : 'hero';
    const ownedMats = [];

    // iter 33y — lazy mount. Only the currently-selected avatar is preloaded
    // at boot; the rest are fetched on demand here. We share the build path
    // between eager (cache hit) and lazy (post-fetch) so the rendered look is
    // identical either way.
    function _buildAndAdd(mesh) {
      const rawBox = new THREE.Box3().setFromObject(mesh);
      const rawSize = rawBox.getSize(new THREE.Vector3());
      const autoFit = rawSize.y > 1e-6 ? TARGET_HEIGHT / rawSize.y : 1;
      mesh.scale.setScalar(autoFit * (ch.scaleMul || 1));
      mesh.position.set(0, 0, 0);
      const tint = new THREE.Color(ch.tint != null ? ch.tint : 0xffffff);
      const lockTint = new THREE.Color(0x303030);
      mesh.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = false;
        o.frustumCulled = false;
        if (!o.material) return;
        const arr = Array.isArray(o.material) ? o.material : [o.material];
        const cloned = arr.map(m => {
          const c = m.clone();
          if (c.color) {
            if (!unlocked) c.color.multiply(lockTint);
            else if (ch.tint && ch.tint !== 0xffffff) c.color.multiply(tint);
          }
          if (!unlocked) {
            if (c.emissive) c.emissive.setHex(0x000000);
            c.transparent = true;
            c.opacity = 0.55;
          }
          ownedMats.push(c);
          return c;
        });
        o.material = arr.length === 1 ? cloned[0] : cloned;
      });
      slot.add(mesh);
    }

    const mesh = cloneCached(key) || cloneCached('hero');
    if (mesh) {
      _buildAndAdd(mesh);
    } else {
      // Fallback cone — same approach as initHero's GLB-fail branch.
      // When the cache miss is because the avatar GLB hasn't been fetched
      // yet (iter 33y lazy preload), kick off the fetch and swap the cone
      // for the real mesh when it arrives.
      const fb = new THREE.Mesh(
        new THREE.ConeGeometry(0.4, 1.2, 12),
        new THREE.MeshStandardMaterial({
          color: unlocked ? 0x7fffe4 : 0x303030, roughness: 0.7,
        }),
      );
      fb.position.y = 0.6;
      ownedMats.push(fb.material);
      slot.add(fb);

      if (ch.glb) {
        lazyLoadGLTF(`hero_${ch.id}`, BASE + ch.glb).then((ok) => {
          if (!ok) return;
          const real = cloneCached(`hero_${ch.id}`);
          if (!real) return;
          slot.remove(fb);
          try { fb.material.dispose(); } catch (_) {}
          try { fb.geometry.dispose(); } catch (_) {}
          _buildAndAdd(real);
        });
      }
    }

    // Lock pip overlay — small ring above the head for locked chars. Sprite
    // would be cleaner but a flat disc reads fine at small scale.
    if (!unlocked) {
      const lockGeo = new THREE.RingGeometry(0.18, 0.28, 24);
      const lockMat = new THREE.MeshBasicMaterial({
        color: 0xff6655, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
      });
      const lockRing = new THREE.Mesh(lockGeo, lockMat);
      lockRing.position.set(0, 1.7, 0);
      lockRing.rotation.x = -Math.PI * 0.35;
      slot.add(lockRing);
      ownedMats.push(lockMat);
    }

    rail.add(slot);
    slots.push({ char: ch, group: slot, unlocked, ownedMats });
  }

  // ── Resize handling ────────────────────────────────────────────────
  const resize = () => {
    const r = stage.getBoundingClientRect();
    const w = Math.max(320, r.width | 0);
    const h = Math.max(180, r.height | 0);
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(stage);

  // ── Click-to-select on canvas ──────────────────────────────────────
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const onCanvasClick = (ev) => {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    // Hit-test slot groups in nearest-first order
    const hits = raycaster.intersectObjects(rail.children, true);
    if (!hits.length) return;
    for (const h of hits) {
      // walk up to find the slot group
      let o = h.object;
      while (o && o.parent !== rail) o = o.parent;
      if (!o) continue;
      const idx = rail.children.indexOf(o);
      if (idx >= 0 && idx !== selectedIdx) {
        setSelection(idx);
        return;
      }
    }
  };
  renderer.domElement.addEventListener('click', onCanvasClick);

  // ── Selection api ──────────────────────────────────────────────────
  function setSelection(idx) {
    idx = ((idx % chars.length) + chars.length) % chars.length;
    if (idx === selectedIdx) { paintInfo(); paintPips(); return; }
    selectedIdx = idx;
    paintInfo();
    paintPips();
    try { onSelect(chars[selectedIdx].id); } catch (_) {}
  }
  function advance(dir) {
    setSelection(selectedIdx + dir);
  }

  // ── Info panel rendering ───────────────────────────────────────────
  function paintInfo() {
    const ch = chars[selectedIdx];
    const unlocked = slots[selectedIdx].unlocked;
    const nameColor = unlocked ? C_AMBER : C_LOCK;
    const titleText = unlocked ? ch.name : `${ch.name} (Locked)`;
    const sigBlock = (unlocked && ch.signatureName)
      ? `<div style="margin-top:8px;color:#7fffe4;font-family:${F_DISP};font-size:13px;letter-spacing:0.18em;">◆ ${escapeHtml(ch.signatureName)}</div>
         <div style="margin-top:2px;opacity:0.85;font-size:13px;line-height:1.45;">${escapeHtml(ch.signatureDesc || '')}</div>`
      : '';
    const descBlock = unlocked
      ? `<div style="margin-top:6px;opacity:0.82;font-size:13px;line-height:1.4;">${escapeHtml(ch.desc || '')}</div>`
      : `<div style="margin-top:6px;opacity:0.7;font-size:13px;line-height:1.4;">${escapeHtml(formatLockHintFn(ch.unlock || ch))}</div>`;
    info.innerHTML = `
      <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;">
        <span style="font-size:22px;">${unlocked ? (ch.icon || '◇') : '🔒'}</span>
        <span style="font-family:${F_DISP};font-size:20px;letter-spacing:0.18em;color:${nameColor};">${escapeHtml(titleText)}</span>
      </div>
      ${descBlock}
      ${sigBlock}
    `;
  }

  function paintPips() {
    pipRow.innerHTML = '';
    for (let i = 0; i < chars.length; i++) {
      const dot = document.createElement('div');
      const active = i === selectedIdx;
      const unlocked = slots[i].unlocked;
      dot.style.cssText = `
        width: ${active ? 10 : 7}px; height: ${active ? 10 : 7}px;
        border-radius: 50%;
        background: ${active ? C_AMBER : (unlocked ? 'rgba(245,239,225,0.45)' : 'rgba(255,102,85,0.6)')};
        transition: all 0.18s ease;
        box-shadow: ${active ? `0 0 8px ${C_AMBER}` : 'none'};
      `;
      pipRow.appendChild(dot);
    }
  }

  paintInfo();
  paintPips();

  // ── Wheel + keyboard nav ────────────────────────────────────────────
  let wheelAcc = 0;
  const onWheel = (e) => {
    if (!stage.matches(':hover')) return;
    e.preventDefault();
    wheelAcc += e.deltaY;
    while (wheelAcc >= 60)  { advance(+1); wheelAcc -= 60; }
    while (wheelAcc <= -60) { advance(-1); wheelAcc += 60; }
  };
  stage.addEventListener('wheel', onWheel, { passive: false });

  const onKey = (e) => {
    if (!_visible) return;
    if (e.key === 'ArrowLeft')  { e.preventDefault(); advance(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); advance(+1); }
  };
  window.addEventListener('keydown', onKey);

  // ── RAF loop ────────────────────────────────────────────────────────
  let _visible = true;
  let _raf = 0;
  let lastT = performance.now();
  // Target rail offset (so selected char sits at world x=0)
  let railX = -selectedIdx * RAIL_SPACING;
  rail.position.x = railX;

  function tick() {
    if (!_visible) return;
    _raf = requestAnimationFrame(tick);
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;

    // Slide rail toward target
    const targetX = -selectedIdx * RAIL_SPACING;
    railX += (targetX - railX) * Math.min(1, SLIDE_LERP * dt);
    rail.position.x = railX;

    // Per-slot scale + spin
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i].group;
      const isSelected = i === selectedIdx;
      // Distance-based scale falloff (selected = SELECTED_SCALE, far = SLOT_SCALE)
      const dist = Math.abs(i - selectedIdx);
      const targetScale = isSelected ? SELECTED_SCALE
                        : Math.max(0.42, SLOT_SCALE - dist * 0.08);
      const cur = slot.scale.x;
      const ns = cur + (targetScale - cur) * Math.min(1, 6 * dt);
      slot.scale.setScalar(ns);

      // Selected char spins; others gently face center
      if (isSelected) {
        slot.rotation.y += SPIN_RATE * dt;
      } else {
        // Drift back to face camera (rotation.y → 0)
        slot.rotation.y *= Math.max(0, 1 - 4 * dt);
      }

      // Fade off-screen chars
      slot.visible = dist <= 3;
    }

    renderer.render(scene, camera);
  }
  _raf = requestAnimationFrame(tick);

  // ── Public API ──────────────────────────────────────────────────────
  return {
    setSelection: (id) => {
      const idx = chars.findIndex(c => c.id === id);
      if (idx >= 0) setSelection(idx);
    },
    show: () => { _visible = true; lastT = performance.now(); _raf = requestAnimationFrame(tick); },
    hide: () => { _visible = false; if (_raf) cancelAnimationFrame(_raf); _raf = 0; },
    destroy: () => {
      _visible = false;
      if (_raf) cancelAnimationFrame(_raf);
      ro.disconnect();
      stage.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
      renderer.domElement.removeEventListener('click', onCanvasClick);
      // Dispose only materials we cloned. Geometries from the cache stay shared.
      for (const s of slots) {
        for (const m of s.ownedMats) {
          try { m.dispose(); } catch (_) {}
        }
      }
      try { platformGeo.dispose(); } catch (_) {}
      try { platformMat.dispose(); } catch (_) {}
      try { renderer.dispose(); } catch (_) {}
      try { renderer.forceContextLoss(); } catch (_) {}
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    },
  };
}

function _formatLockHint(unlock) {
  if (!unlock) return '';
  if (typeof unlock !== 'string') return 'Locked.';
  if (unlock.startsWith('sigils:')) {
    const n = parseInt(unlock.slice(7), 10);
    return Number.isFinite(n) ? `Earn ${n} sigils to unlock.` : 'Earn sigils to unlock.';
  }
  if (unlock.startsWith('flag:')) {
    const f = unlock.slice(5);
    if (f === 'unlockedClockwork') return 'Clear Boss Rush on Twilight Hollow to unlock.';
    return `Unlock: ${f}`;
  }
  return `Unlock: ${unlock}`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
