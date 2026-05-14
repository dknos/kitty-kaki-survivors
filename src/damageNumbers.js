/**
 * Floating damage numbers. Pooled DOM divs, projected from world → screen each frame.
 * Cheap (no extra draw calls, no canvas overlay), and survives bloom/postFX since
 * they live above the canvas.
 *
 * Tiered system — each pop is classified by amount (or explicit kind) and gets
 * a distinct size/color/motion so the screen READS at a glance:
 *   light      dmg < 10    small pale yellow, no shadow
 *   normal     10..29      medium warm tan
 *   heavy      30..79      large ember, drifts
 *   crit       >=80 or isCrit  xl sakura, pops 1.4x→1.0x
 *   heroDamage hero-taken  red, drifts right
 *   heal       heart/regen green, '+' prefix, gentle bob
 *
 * Style Bible palette only — no off-palette colors.
 */
import * as THREE from 'three';
import { state } from './state.js';

const POOL_SIZE = 48;            // hard cap, never grows
const LIFETIME = 0.7;
const HEAL_LIFETIME = 0.9;
const HERO_LIFETIME = 0.85;
const CRIT_POP_DUR = 0.18;       // seconds for 1.4x → 1.0x scale animation

const _pool = [];
const _active = [];
let _layer = null;
const _projected = new THREE.Vector3();

// Tier definitions — looked up by string key. `riseUnits` = px floated over lifetime.
const TIERS = {
  light: {
    color: '#f3e8cf', fontSize: 10, weight: 'normal',
    shadow: 'none',
    riseUnits: 22,     // ~1.0u/s * lifetime
    driftX: 0,
    bob: false, critPop: false, life: LIFETIME,
  },
  normal: {
    // Iter 24c: 15→18 so mid-range damage reads at a glance during swarm combat.
    // Crit/heavy still tower over it; the gap is preserved (18 vs 20 vs 26).
    color: '#d99b54', fontSize: 18, weight: 'bold',
    shadow: '1px 1px 0 #231a14',
    riseUnits: 28,     // ~1.2u/s
    driftX: 0,
    bob: false, critPop: false, life: LIFETIME,
  },
  heavy: {
    color: '#ff7a3a', fontSize: 20, weight: 'bold',
    shadow: '2px 2px 0 #231a14, -1px -1px 0 #231a14',
    riseUnits: 34,     // ~1.4u/s
    driftX: 18,        // horizontal jitter range (±9)
    bob: false, critPop: false, life: LIFETIME,
  },
  crit: {
    color: '#e8a3c7', fontSize: 26, weight: '900',
    shadow: '2px 2px 0 #231a14, -1px -1px 0 #231a14, 0 0 6px #e8a3c7',
    riseUnits: 40,     // ~1.6u/s
    driftX: 12,
    bob: false, critPop: true, life: LIFETIME,
  },
  heroDamage: {
    color: '#ff3344', fontSize: 22, weight: '900',
    shadow: '2px 2px 0 #231a14, -1px -1px 0 #231a14',
    riseUnits: 26,     // ~1.0u/s
    driftX: 16,        // rightward drift (positive only, see _spawn)
    driftRight: true,
    bob: false, critPop: false, life: HERO_LIFETIME,
  },
  heal: {
    color: '#8aaa6a', fontSize: 16, weight: 'bold',
    shadow: '1px 1px 0 #231a14',
    riseUnits: 24,     // ~1.0u/s
    driftX: 0,
    bob: true, critPop: false, life: HEAL_LIFETIME, prefix: '+',
  },
};

export function initDamageNumbers() {
  if (_layer) return;
  _layer = document.createElement('div');
  _layer.id = 'dmg-layer';
  Object.assign(_layer.style, {
    position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '15',
    overflow: 'hidden', fontFamily: "'Courier New', monospace",
    userSelect: 'none',
  });
  document.body.appendChild(_layer);

  for (let i = 0; i < POOL_SIZE; i++) {
    const el = document.createElement('div');
    el.style.position = 'absolute';
    el.style.willChange = 'transform, opacity';
    el.style.display = 'none';
    _layer.appendChild(el);
    _pool.push(el);
  }
}

function _fmt(n) {
  const v = Math.round(n);
  if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
  if (v >= 1000)    return (v / 1000).toFixed(1) + 'K';
  return v.toString();
}

function _classify(amount, hint) {
  if (hint && TIERS[hint]) return hint;
  // Auto-classify by amount. Honors state.run.lastWasCrit as a fallback flag.
  if (hint === 'crit' || (state.run && state.run.lastWasCrit === true)) return 'crit';
  const v = Math.abs(amount);
  if (v >= 80) return 'crit';
  if (v >= 30) return 'heavy';
  if (v >= 10) return 'normal';
  return 'light';
}

/**
 * Spawn a damage number at a world position.
 * Back-compat:
 *   spawnDamageNumber(worldPos, amount)
 *   spawnDamageNumber(worldPos, amount, true)       // boolean crit flag
 *   spawnDamageNumber(worldPos, amount, 'heavy')    // explicit tier
 *   spawnDamageNumber(worldPos, amount, 'auto')     // auto-classify
 */
export function spawnDamageNumber(worldPos, amount, kind) {
  let tierName;
  if (kind === true) tierName = 'crit';
  else if (kind === false || kind == null || kind === 'auto') tierName = _classify(amount);
  else tierName = _classify(amount, kind);
  _spawn(worldPos.x, worldPos.y + 1.5, worldPos.z, amount, tierName);
}

/** Spawn a hero-damage number above the hero. Red, bold, drifts right. */
export function spawnHeroDamageNumber(amount) {
  const p = state.hero && state.hero.pos;
  if (!p) return;
  _spawn(p.x, (p.y || 0) + 1.8, p.z, amount, 'heroDamage');
}

/** Spawn a heal number above the hero. Green, '+' prefix, gentle bob. */
export function spawnHealNumber(amount) {
  const p = state.hero && state.hero.pos;
  if (!p) return;
  _spawn(p.x, (p.y || 0) + 1.8, p.z, amount, 'heal');
}

function _spawn(wx, wy, wz, amount, tierName) {
  if (!_layer) return;
  const el = _pool.pop();
  if (!el) return;                 // pool exhausted — drop, never grow
  const tier = TIERS[tierName] || TIERS.normal;
  const prefix = tier.prefix || '';
  el.textContent = prefix + _fmt(amount);
  el.style.color = tier.color;
  el.style.fontSize = tier.fontSize + 'px';
  el.style.fontWeight = tier.weight;
  el.style.textShadow = tier.shadow;
  el.style.opacity = '1';
  el.style.display = 'block';
  // Drift: hero/heavy/crit get some horizontal motion. Hero is right-only.
  let drift;
  if (tier.driftRight) drift = 24 + Math.random() * tier.driftX;       // strictly right
  else if (tier.driftX > 0) drift = (Math.random() - 0.5) * tier.driftX;
  else drift = 0;
  _active.push({
    el, tier, tierName,
    x: wx, y: wy, z: wz,
    drift,
    t: 0,
  });
}

export function updateDamageNumbers(dt) {
  if (!_layer || !state.camera) return;
  const cam = state.camera;
  const W = window.innerWidth, H = window.innerHeight;
  for (let i = _active.length - 1; i >= 0; i--) {
    const d = _active[i];
    d.t += dt;
    const life = d.tier.life;
    if (d.t >= life) {
      d.el.style.display = 'none';
      d.el.style.transform = '';   // clear scale so next reuse starts clean
      _pool.push(d.el);
      _active.splice(i, 1);
      continue;
    }
    const k = d.t / life;
    _projected.set(d.x, d.y, d.z).project(cam);
    let sx = (_projected.x * 0.5 + 0.5) * W + d.drift * k;
    let sy = (-_projected.y * 0.5 + 0.5) * H - d.tier.riseUnits * k;
    // Heal: gentle upward bob (sine offset). 1 cycle over lifetime.
    if (d.tier.bob) sy += Math.sin(k * Math.PI * 2) * 3;
    // Crit pop: 1.4x → 1.0x over first 0.18s (CSS transform scale on top of translate).
    let scale = 1;
    if (d.tier.critPop && d.t < CRIT_POP_DUR) {
      const p = d.t / CRIT_POP_DUR;       // 0..1
      scale = 1.4 - 0.4 * p;
    }
    if (scale !== 1) {
      d.el.style.transform = `translate(${sx.toFixed(0)}px, ${sy.toFixed(0)}px) scale(${scale.toFixed(3)})`;
    } else {
      d.el.style.transform = `translate(${sx.toFixed(0)}px, ${sy.toFixed(0)}px)`;
    }
    d.el.style.opacity = (1 - k * k).toFixed(3);
  }
}
