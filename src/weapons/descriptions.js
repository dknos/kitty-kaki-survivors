/**
 * Rich, flavorful descriptions for weapons + passives, used by tooltips.
 * Each entry returns a paragraph blurb that references actual numbers from
 * the level table (so they don't lie). Tags categorize the build niche.
 *
 * `weaponBlurb(id, level)`      -> { blurb, tags }
 * `passiveBlurb(id, level)`     -> { blurb, tags }
 * `weaponStatRows(id, level, prevLevel)` -> [{label, value, prev?}]
 * `passiveStatRows(id, level, prevLevel)` -> [{label, value, prev?}]
 *
 * These are the source of truth for the tooltip card body — kept here (and
 * not on the weapon module) so tweaking copy is a one-file edit.
 */
import { REGISTRY, PASSIVES } from './index.js';

// Vampire Survivors is hostile to new players because builds are opaque. The
// blurbs below are deliberately specific: each names the radius / damage /
// cadence the player should expect at the level being previewed.
const WEAPON_BLURBS = {
  orbitals: {
    flavor: 'Cheesy Burgers — Sacred orbs of cheese wheel around you, smashing whatever bumps into the ring.',
    body: (lv) => `${lv.count} burgers orbit at ${lv.radius.toFixed(1)}m for ${lv.dmg} damage per hit (${lv.dmgInterval}s re-hit window per enemy).`,
    tags: ['Orbit', 'AoE', 'Constant'],
  },
  autoaim: {
    flavor: 'Magic Missile — A shimmering bolt that hunts the nearest soul.',
    body: (lv) => `Fires ${lv.count} bolt${lv.count > 1 ? 's' : ''} every ${lv.cooldown.toFixed(2)}s at ${lv.speed}m/s, piercing ${lv.pierce} enem${lv.pierce > 1 ? 'ies' : 'y'} for ${lv.dmg} damage.`,
    tags: ['Projectile', 'Single-Target', 'Pierce'],
  },
  chain: {
    flavor: 'Chain Lightning — A jagged arc that leaps from prey to prey.',
    body: (lv) => `Strikes every ${lv.cooldown.toFixed(2)}s for ${lv.dmg} damage, then jumps to ${lv.chains} additional target${lv.chains > 1 ? 's' : ''} within ${lv.chainRadius.toFixed(1)}m (each jump deals ${Math.round(lv.falloff * 100)}% of the previous bolt).`,
    tags: ['Lightning', 'Chain', 'AoE'],
  },
  web: {
    flavor: 'Sticky Web — Tangling silk laid at your feet.',
    body: (lv) => `Drops a ${lv.radius.toFixed(1)}m web every ${lv.cooldown.toFixed(1)}s that lingers ${lv.duration.toFixed(1)}s, slowing anything inside to ${Math.round(lv.slowMul * 100)}% speed.`,
    tags: ['Trap', 'Slow', 'Zone'],
  },
  frostbloom: {
    flavor: 'Frostbloom — Crystallize the air around you. Pulses ice every cooldown, freezing nearby foes.',
    body: (lv) => `Every ${lv.cooldown.toFixed(2)}s, a ${lv.radius.toFixed(1)}m ring of frost detonates for ${lv.dmg} damage and freezes for ${lv.freezeDur.toFixed(2)}s. Frozen enemies take +25% damage from all sources.`,
    tags: ['Frost', 'AoE', 'CC'],
  },
  sigilbell: {
    flavor: 'Sigil Bell — A ringing glyph plants itself, hums, and then erupts.',
    body: (lv) => `Drops a sigil every ${lv.cooldown.toFixed(2)}s (up to ${lv.maxSigils} live at once). Each detonates after a brief pulse for ${lv.dmg} damage in a ${lv.radius.toFixed(1)}m blast that briefly stuns survivors.`,
    tags: ['Mine', 'AoE', 'Stun'],
  },
};

// Passive copy. Each line tells the player what the number actually does to
// their build (e.g. multiplicative damage stacks with weapon damage growth).
const PASSIVE_BLURBS = {
  spinach:   { flavor: 'Spinach — Pure ferocity. All outgoing damage swells.',                    tags: ['Damage'] },
  armor:     { flavor: 'Armor — Damage taken is multiplied down. Caps at 25% reduction.',         tags: ['Defense'] },
  wings:     { flavor: 'Wings — Lighter footfalls. Stack with Swift Boots and shop boots.',       tags: ['Mobility'] },
  tome:      { flavor: 'Tome — Cools every weapon down. Cap at 60% of base cooldown.',            tags: ['Cooldown'] },
  bracer:    { flavor: 'Bracer — Faster projectile travel; bolts close gaps before targets bolt.', tags: ['Projectile'] },
  duration:  { flavor: 'Empty Tome — Stretches every timed effect: webs, freezes, sigils, DoTs.', tags: ['Duration'] },
  hollow:    { flavor: 'Hollow Heart — A larger hit-pool; the bonus also heals you on pickup.',   tags: ['Defense', 'HP'] },
  pummarola: { flavor: 'Pummarola — Constant trickle regen. Stacks with house regen.',            tags: ['Regen'] },
  crown:     { flavor: 'Crown — Every gem grants more XP. Stacks with shop Quick Study.',         tags: ['XP'] },
  vampirism: { flavor: 'Vampirism — Steal life on kill, capped per kill so it scales by levels.', tags: ['Lifesteal'] },
  echo:      { flavor: 'Echo — Each shot has a chance to fire twice. Required for Glasswind.',    tags: ['Projectile', 'Evolution'] },
  berserk:   { flavor: 'Berserk — The closer to death, the harder the hits (kicks in at 50% HP).', tags: ['Damage', 'Risk'] },
  steadfast: { flavor: 'Steadfast — You knock harder, get knocked less. Required for Sanctum.',   tags: ['Knockback', 'Evolution'] },
  greed:     { flavor: 'Greed — Chests bleed more coin and ember on open.',                       tags: ['Economy'] },
  soullink:  { flavor: 'Soul Link — Wider gem pull, plus bonus XP per gem absorbed.',             tags: ['Pickup', 'XP'] },
};

// Shop-side flavor — short rationale for each permanent upgrade.
const SHOP_BLURBS = {
  hp:     { flavor: 'Iron Resolve — Bigger health pool from the moment you spawn.',     tags: ['Defense', 'Meta'] },
  magnet: { flavor: 'Lodestone — Permanently widens your XP-gem pickup radius.',         tags: ['Pickup', 'Meta'] },
  speed:  { flavor: 'Swift Boots — Permanent move speed; pairs hard with Wings.',        tags: ['Mobility', 'Meta'] },
  damage: { flavor: 'Sharpened — Multiplicative damage on every weapon you ever pick.',  tags: ['Damage', 'Meta'] },
  growth: { flavor: 'Quick Study — XP gain scales up; you level faster every run.',      tags: ['XP', 'Meta'] },
  luck:   { flavor: 'Lucky Charm — Slightly more chests roll into the world per run.',   tags: ['Economy', 'Meta'] },
};

// Filler one-shot picks (level-up reward when nothing better fits).
const FILLER_BLURBS = {
  heal:     { flavor: 'Field Rations — Bite of bread, sip of water. Instant +40 HP.',       tags: ['Heal'] },
  maxhp:    { flavor: 'Iron Resolve — +25 max HP and patches it onto your current HP too.', tags: ['HP'] },
  speed:    { flavor: 'Swift Boots — +10% move speed for the rest of the run.',             tags: ['Mobility'] },
  magnet:   { flavor: 'Magnet — Pickup radius grows 60%. Toxic Halo evolution counts this.', tags: ['Pickup', 'Evolution'] },
  cooldown: { flavor: 'Focus — Every weapon cools 8% faster. Storm evolution counts this.',  tags: ['Cooldown', 'Evolution'] },
  damage:   { flavor: 'Sharpened — +10% damage on everything you fire.',                    tags: ['Damage'] },
  zoomout:  { flavor: 'Bigger Picture — Camera can pull back another notch.',                tags: ['Utility'] },
  dash:     { flavor: 'Charge Dash — SHIFT teleport that batters foes aside (stronger per pick).', tags: ['Mobility', 'Damage'] },
};

const CHARACTER_BLURBS = {
  kitty:      { flavor: 'Kitty Kaki — The default cat. Balanced stats, starts with Cheesy Burgers as a constant melee aura.', tags: ['Balanced', 'Starter'] },
  boom:       { flavor: 'Boom — Glass cannon. Trades health for raw damage and a long-reach starter that loves crowds.',     tags: ['Damage', 'Fragile'] },
  webspinner: { flavor: 'Webspinner — A trapper. Slower on foot but pulls gems hard and opens with map-control silk.',         tags: ['Control', 'Slow'] },
  sniper:     { flavor: 'Sniper — Precise. Faster bolts, slightly more damage; thrives in long runs with positioning.',        tags: ['Range', 'Single-Target'] },
  phoenix:    { flavor: 'Phoenix Vow — A vow sworn in the last ember. When the heart stops, the ash speaks once — and the field answers in fire.', tags: ['Damage', 'Risk'] },
  clockwork:  { flavor: 'Clockwork — Wound to outlast. Each tick of the run-clock tightens the spring; given long enough, the gears chew anything.',  tags: ['Damage', 'Duration'] },
};

// ── Public API ──────────────────────────────────────────────────────────────

export function weaponBlurb(id, level) {
  const entry = REGISTRY[id];
  const b = WEAPON_BLURBS[id];
  if (!entry || !b) return null;
  const lvIdx = Math.max(0, Math.min((level || 1) - 1, entry.levels.length - 1));
  const lv = entry.levels[lvIdx];
  return {
    name: entry.name,
    icon: entry.icon,
    flavor: b.flavor,
    body: b.body(lv),
    tags: b.tags.slice(),
  };
}

export function passiveBlurb(id, level) {
  const def = PASSIVES.find(p => p.id === id);
  const b = PASSIVE_BLURBS[id];
  if (!def || !b) return null;
  return {
    name: def.name,
    icon: def.icon,
    flavor: b.flavor,
    body: def.desc(level || 1) + ` — Max Lv ${def.maxLevel}.`,
    tags: ['Passive', ...b.tags],
  };
}

export function shopBlurb(id, level, max) {
  const b = SHOP_BLURBS[id];
  if (!b) return null;
  return { flavor: b.flavor, tags: b.tags.slice(), level, max };
}

export function fillerBlurb(id) {
  return FILLER_BLURBS[id] || null;
}

export function characterBlurb(id) {
  return CHARACTER_BLURBS[id] || null;
}

// Build [{label, value, prev?}] rows for a weapon at a given level (with
// optional previous level to render arrow deltas).
export function weaponStatRows(id, level, prevLevel) {
  const entry = REGISTRY[id];
  if (!entry) return [];
  const cur = entry.levels[Math.max(0, Math.min((level || 1) - 1, entry.levels.length - 1))];
  const prev = prevLevel ? entry.levels[Math.max(0, Math.min(prevLevel - 1, entry.levels.length - 1))] : null;
  const fields = STAT_FIELDS[id] || [];
  const rows = [];
  for (const f of fields) {
    const v = cur[f.key];
    if (v == null) continue;
    rows.push({
      label: f.label,
      value: f.fmt ? f.fmt(v) : String(v),
      prev: prev ? (f.fmt ? f.fmt(prev[f.key]) : String(prev[f.key])) : undefined,
    });
  }
  return rows;
}

const STAT_FIELDS = {
  orbitals: [
    { key: 'count',       label: 'Orbs' },
    { key: 'dmg',         label: 'DMG' },
    { key: 'radius',      label: 'Radius', fmt: v => v.toFixed(1) + 'm' },
    { key: 'rotSpeed',    label: 'Spin',   fmt: v => v.toFixed(1) },
    { key: 'dmgInterval', label: 'Re-hit', fmt: v => v.toFixed(2) + 's' },
  ],
  autoaim: [
    { key: 'cooldown', label: 'CD',     fmt: v => v.toFixed(2) + 's' },
    { key: 'dmg',      label: 'DMG' },
    { key: 'count',    label: 'Volley' },
    { key: 'pierce',   label: 'Pierce' },
    { key: 'speed',    label: 'Speed' },
  ],
  chain: [
    { key: 'cooldown',    label: 'CD',     fmt: v => v.toFixed(2) + 's' },
    { key: 'dmg',         label: 'DMG' },
    { key: 'chains',      label: 'Chains' },
    { key: 'chainRadius', label: 'Range',  fmt: v => v.toFixed(1) + 'm' },
    { key: 'falloff',     label: 'Falloff', fmt: v => Math.round(v * 100) + '%' },
  ],
  web: [
    { key: 'cooldown', label: 'CD',       fmt: v => v.toFixed(1) + 's' },
    { key: 'duration', label: 'Lifetime', fmt: v => v.toFixed(1) + 's' },
    { key: 'radius',   label: 'Radius',   fmt: v => v.toFixed(1) + 'm' },
    { key: 'slowMul',  label: 'Slow',     fmt: v => Math.round((1 - v) * 100) + '%' },
  ],
  frostbloom: [
    { key: 'cooldown',  label: 'CD',     fmt: v => v.toFixed(2) + 's' },
    { key: 'dmg',       label: 'DMG' },
    { key: 'radius',    label: 'Radius', fmt: v => v.toFixed(1) + 'm' },
    { key: 'freezeDur', label: 'Freeze', fmt: v => v.toFixed(2) + 's' },
  ],
  sigilbell: [
    { key: 'cooldown',  label: 'CD',     fmt: v => v.toFixed(2) + 's' },
    { key: 'dmg',       label: 'DMG' },
    { key: 'radius',    label: 'Radius', fmt: v => v.toFixed(1) + 'm' },
    { key: 'maxSigils', label: 'Active' },
  ],
};

export function passiveStatRows(id, level, prevLevel) {
  const def = PASSIVES.find(p => p.id === id);
  if (!def) return [];
  const rows = [{ label: 'Level', value: `${level}/${def.maxLevel}` }];
  rows.push({
    label: 'Effect',
    value: def.desc(level),
    prev: prevLevel ? def.desc(prevLevel) : undefined,
  });
  return rows;
}
