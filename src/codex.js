/**
 * Codex / Bestiary — persistent discovery log of everything the player has met
 * in the wild. Vampire-Survivors-style: each entry is hidden behind a "???"
 * silhouette until the player encounters / kills / picks / evolves it.
 *
 * Persists into meta.codex (managed via getMeta/saveMeta from meta.js):
 *   meta.codex = { enemies: {}, weapons: {}, passives: {}, evolutions: {}, secrets: {}, affixes: {} }
 * Most inner maps are keyed by id → { discovered:true, kills?, picks?, firstSeenAt }.
 * Affixes is a flat id → timestamp map (bare number, "first seen at" epoch ms).
 *
 * Public API:
 *   notifyEnemySeen(id), notifyEnemyKilled(id),
 *   notifyWeaponPicked(id), notifyPassivePicked(id),
 *   notifyEvolutionAchieved(id), notifySecretFound(id),
 *   notifyAffixSeen(id),
 *   showCodex(), hideCodex(), isCodexOpen(),
 *   LORE  (id-keyed flavor strings; exported for tests/debug)
 */

import { getMeta, saveMeta } from './meta.js';
import { sfx } from './audio.js';
import { hideTooltip } from './tooltips.js';

// ── Theme tokens (mirror ui.js so this module renders without coupling) ─────
const C = {
  text:    '#f5efe1',
  cyan:    '#7fffe4',
  magenta: '#ff7ad8',
  amber:   '#ffd27f',
  edge:    'rgba(255, 232, 188, 0.18)',
  ink:     'rgba(8, 14, 12, 0.86)',
};
const F = {
  display: '"Cinzel Decorative", "Cinzel", Georgia, serif',
  body:    '"Inter", "Segoe UI", system-ui, sans-serif',
  mono:    '"JetBrains Mono", "Consolas", monospace',
};

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Lore tables — short, atmospheric flavor (2-3 sentences each) ────────────
// Keep entries punchy. The wolf example in the task brief is the tonal target.
export const LORE = {
  // Enemies (keyed by ENEMY_TIERS.glb)
  zombie:      { name: 'Mushnub',      icon: '🧟', text: 'Shambling fungus-host. Slow, plentiful, and harmless alone — but the swarm composts the careless.' },
  goblin:      { name: 'Goblin',       icon: '👺', text: 'Wiry forest scavenger. Quicker than it looks; travels in skittish packs that probe your perimeter.' },
  skeleton:    { name: 'Skeleton',     icon: '💀', text: 'Bone-stitched and patient. Mid-pack threat that punishes any gap in your fire arc.' },
  orc:         { name: 'Orc',          icon: '🪓', text: 'Slab-shouldered bruiser. Hits like a wall; trades speed for staying power.' },
  demon:       { name: 'Demon',        icon: '👹', text: 'Sulfur-skinned and proud. Closes the gap fast and bites deep.' },
  robot:       { name: 'Sentinel',     icon: '🤖', text: 'Lacquered iron husk from a war nobody remembers. Tough plate, sluggish servo.' },
  mech:        { name: 'Mech',         icon: '🦾', text: 'Cracked exo-frame. Walking battery of pain — keep moving and kite.' },
  xeno:        { name: 'Xeno',         icon: '👽', text: 'Chitinous offworlder. Fast, brittle, and cooperative when in numbers.' },
  slime:       { name: 'Slime',        icon: '🟢', text: 'Acidic glob, unhurried. Soaks orbital damage; pop it before it pools.' },
  giant:       { name: 'Giant',        icon: '🗿', text: 'Elite. Mossy hill-walker with a grudge. Telegraphs hard and hits harder.' },
  dragon:      { name: 'Dragon',       icon: '🐉', text: 'Elite. Old, slow, and absolutely furious. Survive the first pass and you survive the rest.' },
  spider:      { name: 'Spider',       icon: '🕷️', text: 'Eight-legged sprinter. Glassy HP but closes faster than your reflex.' },
  wolf:        { name: 'Wolf',         icon: '🐺', text: 'Black timber pack-runner. Travels in groups, slowest of its breed but bites hardest at low health.' },
  wizard:      { name: 'Wizard',       icon: '🧙', text: 'Robed lobber. Stays back and rains projectiles — silence him first.' },
  ghost:       { name: 'Ghost',        icon: '👻', text: 'Lantern-eyed wisp. Phases through your line; only direct fire keeps it honest.' },
  ant:         { name: 'Ant',          icon: '🐜', text: 'Picnic-thief. Tiny on its own; deadly when the column finds your flank.' },
  beetle:      { name: 'Beetle',       icon: '🪲', text: 'Armored crawler. Plodding bruiser among the small things.' },
  ladybug:     { name: 'Ladybug',      icon: '🐞', text: 'Pretty and lethal. Don\'t let the polka dots fool you.' },
  grasshopper: { name: 'Grasshopper',  icon: '🦗', text: 'Hops your firing line. Throws off your aim more than your HP bar.' },
  butterfly:   { name: 'Butterfly',    icon: '🦋', text: 'Fragile flutterer. Hides among the swarm; pop one and the cloud thins.' },
  bee:         { name: 'Bee',          icon: '🐝', text: 'Pissed-off pollinator. Punches well above its weight class.' },
  cockroach:   { name: 'Cockroach',    icon: '🪳', text: 'Outlives most things. Fast, ugly, and shameless.' },
  wasp:        { name: 'Wasp',         icon: '🐝', text: 'Hover-strike specialist. Watch your kite path.' },
  caterpillar: { name: 'Caterpillar',  icon: '🐛', text: 'A meatball with feet. Slow, soaks damage, eats a clip.' },
  mantis:      { name: 'Mantis',       icon: '🦗', text: 'Patient ambusher. Closes silently and opens with a heavy strike.' },

  // Weapons (keyed by REGISTRY ids)
  orbitals:    { name: 'Orbitals',      icon: '⚪', text: 'Sworn rings of glass that orbit the wielder. Trace a clearing wherever you stand.' },
  autoaim:     { name: 'Volley',        icon: '🏹', text: 'Snap-firing volley that picks the nearest threat. The bow that never sleeps.' },
  chain:       { name: 'Chain',         icon: '⚡', text: 'A coil of stored lightning. Arcs across foes; loves a crowd.' },
  web:         { name: 'Web',           icon: '🕸️', text: 'Sticky silk traps. Slows the swarm and lets your other tools cook.' },
  frostbloom:  { name: 'Frostbloom',    icon: '❄️', text: 'A blossom of cold radiating outward. Numb everything you can reach.' },
  sigilbell:   { name: 'Sigil Bell',    icon: '🔔', text: 'A peal of rune-light. Hits in pulses that follow your heartbeat.' },

  // Passives
  spinach:     { name: 'Spinach',       icon: '🥬', text: 'More damage on everything you fire. The simplest gain there is.' },
  armor:       { name: 'Armor',         icon: '🛡️', text: 'Plate woven under the coat. Trims a sliver off every hit.' },
  wings:       { name: 'Wings',         icon: '🪶', text: 'Move faster, dodge cleaner. Speed is a weapon.' },
  tome:        { name: 'Tome',          icon: '📕', text: 'Compressed weapon math. Wider radii, longer beams.' },
  bracer:      { name: 'Bracer',        icon: '🏹', text: 'Faster projectiles, tighter arcs. Hits before they think to flinch.' },
  duration:    { name: 'Empty Tome',    icon: '📜', text: 'Effects linger. Webs hold, frost stays cold, sigils ring longer.' },
  hollow:      { name: 'Hollow Heart',  icon: '💗', text: 'More max HP. Capacity to absorb the small mistakes.' },
  pummarola:   { name: 'Pummarola',     icon: '🍅', text: 'Regenerate over time. Mistakes become temporary.' },
  crown:       { name: 'Crown',         icon: '👑', text: 'Gems pay more XP. Level faster, snowball harder.' },
  vampirism:   { name: 'Vampirism',     icon: '🩸', text: 'Drain HP on hit. The swarm becomes a buffet.' },
  echo:        { name: 'Echo',          icon: '🌀', text: 'Projectiles fork or repeat. The same shot, twice over.' },
  berserk:     { name: 'Berserk',       icon: '😤', text: 'Bigger damage when low HP. Reward for staying in the red.' },
  steadfast:   { name: 'Steadfast',     icon: '⛰️', text: 'Take less damage while standing still. Anchors are sometimes safest.' },
  greed:       { name: 'Greed',         icon: '💰', text: 'Bonus coins at run-end. Funds the next loadout.' },
  soullink:    { name: 'Soul Link',     icon: '🔗', text: 'Kills feed your weapons\' cooldown. The chain stays hot.' },

  // Evolutions (keyed by EVOLUTIONS[*].id)
  toxic_halo:  { name: 'Toxic Halo',    icon: '☠️', text: 'Orbitals become a slow-burning poison ring. Touch is a sentence.' },
  storm:       { name: 'Storm',         icon: '🌩️', text: 'Chain becomes a self-firing storm. Stand still and watch the sky work.' },
  glasswind:   { name: 'Glasswind',     icon: '🪟', text: 'Volleys multiply mid-flight, shattering into ice shards on impact.' },
  sanctum:     { name: 'Sanctum',       icon: '✨', text: 'Webs become a sanctuary — burning enemies inside, shielding you within.' },
  mirror_step: { name: 'Mirror Step',   icon: '👥', text: 'Dash leaves a magenta twin. It fires for you on the way out.' },

  // Affixes (keyed by AFFIX_POOL.id in enemyAffixes.js)
  volatile:  { name: 'Volatile',  icon: '💥', text: 'Its bones hum with a stored charge that lets go on death. Don\'t dash through — the corpse always gets the last word.' },
  vampiric:  { name: 'Vampiric',  icon: '🩸', text: 'Every wound it takes, it drinks back. Chip damage feeds the thing; burn it down or don\'t bother.' },
  leaping:   { name: 'Leaping',   icon: '🦘', text: 'Coiled and predatory, it reads your line before it jumps. The arc lands where you were — make sure that\'s nowhere.' },
  shielded:  { name: 'Shielded',  icon: '🛡️', text: 'A gilded rim of warding flickers along its hide, eating big hits whole. Sustained DPS strips it; the burst opener just bounces.' },
  swift:     { name: 'Swift',     icon: '💨', text: 'Lean, dry-boned, and faster than it has any right to be. Lead your shots — it\'s glassy if you can catch it.' },
  frosted:   { name: 'Frosted',   icon: '❄️', text: 'A breath of winter clings to its shoulders, sapping the warmth from anything close. Stay at the edge of its aura or you\'ll move like cold honey.' },

  // Weekly mutators (keyed by WEEKLY_MUTATORS[*].id in weeklyMutator.js).
  // Two-sentence wolf-tone flavor each. Surface in the codex Mutators tab.
  DOUBLE_SPAWNS:    { name: 'Hour of the Tide',      icon: '🌊', text: 'The grove forgets its restraint and pours the swarm out twice over. There is no quiet minute this week — every horizon you scan, the count has already doubled.' },
  HALF_HP_HALF_DMG: { name: 'Glass and Vellum',      icon: '🪶', text: 'Everything in the wood has grown brittle and slow to bruise — strikes split easier, but so does your skin. A duel of paper knives; whoever cuts faster wins.' },
  CHEST_LOCKDOWN:   { name: 'The Long Vault',        icon: '🔒', text: 'The chests have all sworn an oath of silence for the first five minutes. You earn nothing from the ground until the swarm has earned its right to be ignored.' },
  BOSS_PARADE:      { name: 'Procession of Wardens', icon: '🐗', text: 'A fourth crown arrives uninvited, and the wardens of the wood walk in single file. Three mini-bosses were already a tide; the fourth is the reckoning.' },
  NO_PASSIVES:      { name: 'Steelwright\'s Vow',    icon: '⚔️', text: 'A pact has been signed in the under-grove: only weapons may enter, no passive comforts. Every level-up is a blade choice — there is no growing softer.' },
  XP_FAMINE:        { name: 'Famine Moon',           icon: '🌑', text: 'The gems are dim and the kills feed thin — a thirty-percent tithe is taken from every soul you split. Patience or perish; there is no levelling out of this one.' },
};

// Affix tells — short counterplay hints used by the Legend overlay.
// Keep these one short sentence each, scannable in a glance.
const AFFIX_TELL = {
  volatile: { swatch: 'ring',    color: '#66ddff', counter: 'Don\'t dash through. Pull back, let the corpse pop, then collect.' },
  vampiric: { swatch: 'dot',     color: '#ff3344', counter: 'Burst it down — chip damage just feeds the heal.' },
  leaping:  { swatch: 'arc',     color: '#ff66ee', counter: 'Watch the magenta landing arc. Dash out of the marker.' },
  shielded: { swatch: 'flicker', color: '#ffd24a', counter: 'Sustained orbitals / chain melt it. Don\'t waste burst on the rim.' },
  swift:    { swatch: 'blur',    color: '#7fffe4', counter: 'Lead your shots. Glass cannon — opens up if you actually hit.' },
  frosted:  { swatch: 'motes',   color: '#88ddff', counter: 'Stay outside the aura. Kite around the edge, don\'t walk in.' },
};

// ── Persistent state helpers ────────────────────────────────────────────────
function _section(key) {
  const meta = getMeta();
  if (!meta.codex) meta.codex = { enemies: {}, weapons: {}, passives: {}, evolutions: {}, secrets: {}, affixes: {} };
  if (!meta.codex[key]) meta.codex[key] = {};
  return meta.codex[key];
}

function _touch(sectionKey, id) {
  if (!id) return null;
  const sec = _section(sectionKey);
  if (!sec[id]) {
    sec[id] = { discovered: true, firstSeenAt: Date.now() };
    saveMeta();
    return sec[id];
  }
  return sec[id];
}

export function notifyEnemySeen(id) {
  if (!id) return;
  const sec = _section('enemies');
  if (!sec[id]) {
    sec[id] = { discovered: true, kills: 0, firstSeenAt: Date.now() };
    saveMeta();
  }
}

export function notifyEnemyKilled(id) {
  if (!id) return;
  const sec = _section('enemies');
  const entry = sec[id] || (sec[id] = { discovered: true, kills: 0, firstSeenAt: Date.now() });
  entry.kills = (entry.kills || 0) + 1;
  // Throttle saves: only persist every 25 kills per id (kills are noisy).
  if (entry.kills % 25 === 0) saveMeta();
}

export function notifyWeaponPicked(id) {
  if (!id) return;
  const sec = _section('weapons');
  const entry = sec[id] || (sec[id] = { discovered: true, picks: 0, firstSeenAt: Date.now() });
  entry.picks = (entry.picks || 0) + 1;
  saveMeta();
}

export function notifyPassivePicked(id) {
  if (!id) return;
  const sec = _section('passives');
  const entry = sec[id] || (sec[id] = { discovered: true, picks: 0, firstSeenAt: Date.now() });
  entry.picks = (entry.picks || 0) + 1;
  saveMeta();
}

export function notifyEvolutionAchieved(id) {
  if (!id) return;
  _touch('evolutions', id);
}

export function notifySecretFound(id) {
  if (!id) return;
  _touch('secrets', id);
}

// Affix discovery — called from enemyAffixes.js on first trigger of each affix.
// Stores a bare epoch-ms timestamp (not a substructure) so a falsy check
// doubles as a discovery test.
export function notifyAffixSeen(id) {
  if (!id) return;
  const meta = getMeta();
  if (!meta.codex) meta.codex = { enemies: {}, weapons: {}, passives: {}, evolutions: {}, secrets: {}, affixes: {} };
  if (!meta.codex.affixes) meta.codex.affixes = {};
  if (meta.codex.affixes[id]) return;
  meta.codex.affixes[id] = Date.now();
  saveMeta();
}

// ── Codex modal ─────────────────────────────────────────────────────────────
let _modal = null;
let _activeTab = 'enemies';
let _expanded = null;          // { tab, id } if a card is opened
let _legendOpen = false;       // affix-tell legend overlay (1-screen visual key)

export function isCodexOpen() { return !!_modal; }

export function hideCodex() {
  if (!_modal) return;
  try { sfx.modalClose(); } catch (_) {}
  if (_modal.parentNode) _modal.parentNode.removeChild(_modal);
  _modal = null;
  _expanded = null;
  _legendOpen = false;
}

export function showCodex() {
  // Iter 21a — defensive tooltip hide on modal entry.
  try { hideTooltip(); } catch (_) {}
  if (_modal) return;
  try { sfx.modalOpen(); } catch (_) {}
  // Lazy-resolve registries so this module doesn't pull three.js at import time.
  // weeklyMutator.js is lazy too — if 9a hasn't landed yet the Mutators tab
  // just renders an empty list rather than crashing the whole codex.
  Promise.all([
    import('./config.js'),
    import('./weapons/index.js'),
    import('./meta.js'),
    import('./weeklyMutator.js').catch(() => ({ WEEKLY_MUTATORS: [] })),
  ]).then(([cfg, weapons, metaMod, weeklyMod]) => {
    _buildModal({
      ENEMY_TIERS: cfg.ENEMY_TIERS,
      REGISTRY: weapons.REGISTRY,
      EVOLUTIONS: weapons.EVOLUTIONS,
      PASSIVES: weapons.PASSIVES,
      SECRETS: metaMod.SECRETS,
      ACHIEVEMENTS: metaMod.ACHIEVEMENTS || [],
      achievementChain: typeof metaMod.achievementChain === 'function' ? metaMod.achievementChain : null,
      WEEKLY_MUTATORS: weeklyMod.WEEKLY_MUTATORS || [],
    });
  });
}

function _buildModal({ ENEMY_TIERS, REGISTRY, EVOLUTIONS, PASSIVES, SECRETS, ACHIEVEMENTS, achievementChain, WEEKLY_MUTATORS }) {
  const root = document.getElementById('ui-root') || document.body;
  _modal = document.createElement('div');
  _modal.style.cssText = `
    position: fixed; inset: 0;
    background:
      radial-gradient(ellipse at 50% 30%, rgba(127,255,228,0.06), transparent 60%),
      radial-gradient(ellipse at center, rgba(0,0,0,0.55), rgba(0,0,0,0.92) 80%);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    display: flex; flex-direction: column;
    align-items: center; justify-content: flex-start;
    padding: 40px 20px;
    pointer-events: auto;
    font-family: ${F.body};
    z-index: 130; overflow-y: auto;
  `;

  const title = document.createElement('div');
  title.style.cssText = `font-family: ${F.display}; font-size: 44px; font-weight: 900;
    letter-spacing: 0.20em; color: ${C.cyan};
    text-shadow: 0 2px 16px rgba(0,0,0,0.55), 0 0 24px rgba(127,255,228,0.22);
    margin-bottom: 6px;`;
  title.textContent = 'Codex';

  const subtitle = document.createElement('div');
  subtitle.style.cssText = `font-family: ${F.body}; font-size: 11px; letter-spacing: 0.32em;
    color: rgba(245,239,225,0.62); text-transform: uppercase; margin-bottom: 20px;`;
  subtitle.textContent = 'Discovery log — entries unlock the first time you see one';

  // Tab bar
  const tabBar = document.createElement('div');
  tabBar.style.cssText = `display:flex; gap:8px; margin-bottom: 22px; flex-wrap:wrap; justify-content:center;`;
  const TABS = [
    { id: 'enemies',      label: 'Enemies' },
    { id: 'weapons',      label: 'Weapons' },
    { id: 'passives',     label: 'Passives' },
    { id: 'affixes',      label: 'Affixes' },
    { id: 'achievements', label: 'Achievements' },
    { id: 'mutators',     label: 'Mutators' },
    { id: 'secrets',      label: 'Secrets' },
  ];
  const tabBtns = {};
  for (const t of TABS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t.label;
    b.style.cssText = `padding: 8px 18px; cursor: pointer;
      background: linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86));
      border: 1px solid ${C.edge}; border-radius: 8px;
      color: ${C.text};
      font-family: ${F.display}; font-size: 12px; font-weight: 700; letter-spacing: 0.28em;`;
    b.onclick = () => { _activeTab = t.id; _expanded = null; _legendOpen = false; repaint(); };
    tabBar.appendChild(b);
    tabBtns[t.id] = b;
  }

  // Legend button — visual key for affix tells (player-teaching surface).
  // Sits in the tab bar so it's discoverable on first open, but styled with a
  // magenta accent so it reads as an overlay action rather than a tab.
  const legendBtn = document.createElement('button');
  legendBtn.type = 'button';
  legendBtn.textContent = 'Legend';
  legendBtn.style.cssText = `padding: 8px 18px; cursor: pointer;
    background: linear-gradient(180deg, rgba(28,18,28,0.82), rgba(14,8,14,0.90));
    border: 1px solid ${C.magenta}; border-radius: 8px;
    color: ${C.magenta};
    font-family: ${F.display}; font-size: 12px; font-weight: 700; letter-spacing: 0.28em;
    margin-left: 6px;`;
  legendBtn.title = 'Visual key for elite / affix tells';
  legendBtn.onclick = () => { _legendOpen = !_legendOpen; _expanded = null; repaint(); };
  tabBar.appendChild(legendBtn);

  // Body container (grid OR expanded detail)
  const body = document.createElement('div');
  body.style.cssText = 'width:100%; max-width: 1180px;';

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close · Esc';
  close.style.cssText = `margin-top: 26px; padding: 10px 26px; cursor: pointer;
    background: linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86));
    border: 1px solid ${C.edge}; border-radius: 8px;
    color: ${C.cyan}; font-family: ${F.display}; font-size: 13px; font-weight: 700;
    letter-spacing: 0.28em;`;
  close.onclick = hideCodex;

  function repaint() {
    // Tab highlight (legend pin overrides active-tab styling — looks "on" only
    // when its overlay is showing).
    for (const t of TABS) {
      const b = tabBtns[t.id];
      const on = !_legendOpen && t.id === _activeTab;
      b.style.borderColor = on ? C.cyan : C.edge;
      b.style.color = on ? C.cyan : C.text;
      b.style.boxShadow = on
        ? `0 0 0 1px ${C.cyan} inset, 0 8px 22px rgba(0,0,0,0.5)`
        : `0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 20px rgba(0,0,0,0.5)`;
    }
    legendBtn.style.boxShadow = _legendOpen
      ? `0 0 0 1px ${C.magenta} inset, 0 8px 22px rgba(0,0,0,0.5)`
      : `0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 20px rgba(0,0,0,0.5)`;

    body.innerHTML = '';

    // Render priority: legend overlay > expanded detail > grid.
    if (_legendOpen) {
      body.appendChild(_renderLegend(() => { _legendOpen = false; repaint(); }));
      return;
    }

    // Achievements tab is rendered as a 3-column DAG, not a card grid — the
    // visual story is "what unlocks what", which the grid can't tell.
    if (_activeTab === 'achievements') {
      body.appendChild(_renderAchievementDAG(ACHIEVEMENTS, achievementChain));
      return;
    }

    const entries = _entriesForTab(_activeTab, { ENEMY_TIERS, REGISTRY, EVOLUTIONS, PASSIVES, SECRETS, WEEKLY_MUTATORS });
    if (_expanded && _expanded.tab === _activeTab) {
      const ent = entries.find(e => e.id === _expanded.id);
      if (ent) {
        body.appendChild(_renderDetail(ent, () => { _expanded = null; repaint(); }));
        return;
      }
      _expanded = null;
    }
    body.appendChild(_renderGrid(entries, (ent) => {
      if (!ent.discovered) return;
      _expanded = { tab: _activeTab, id: ent.id };
      repaint();
    }));
  }

  _modal.appendChild(title);
  _modal.appendChild(subtitle);
  _modal.appendChild(tabBar);
  _modal.appendChild(body);
  _modal.appendChild(close);
  root.appendChild(_modal);

  // ESC to close — legend overlay first, then expanded card, then the modal.
  const onKey = (e) => {
    if (!_modal) return;
    if (e.code === 'Escape') {
      e.stopPropagation();
      if (_legendOpen) { _legendOpen = false; repaint(); }
      else if (_expanded) { _expanded = null; repaint(); }
      else hideCodex();
    }
  };
  _modal.addEventListener('keydown', onKey);
  // Capture-phase listener so we can preempt the global Esc in main.js
  // (it would otherwise toggle the options panel).
  const winKey = (e) => {
    if (!_modal) { window.removeEventListener('keydown', winKey, true); return; }
    if (e.code === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      if (_legendOpen) { _legendOpen = false; repaint(); }
      else if (_expanded) { _expanded = null; repaint(); }
      else hideCodex();
    }
  };
  window.addEventListener('keydown', winKey, true);

  repaint();
}

// Stat-tier colors (used in the enemy detail panel). Red = dangerous, amber =
// tough, green = manageable. Bigger HP/DMG is worse for the player; bigger
// Speed is worse too (kite pressure). Colors are derived against the median
// of the live ENEMY_TIERS table so the scale stays calibrated if rebalancing
// shifts the roster.
const _STAT_COLORS = { red: '#ff6b6b', amber: '#ffd27f', green: '#7fffa8' };
function _median(arr) {
  if (!arr || !arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function _statTierColor(kind, value, median) {
  if (median <= 0 || typeof value !== 'number') return _STAT_COLORS.amber;
  const r = value / median;
  // HP / damage: 1.5× median = red (deadly outlier), >1× = amber, ≤1× = green.
  // Speed has a tighter scale — 1.3× = red, since 2.2→3.2 is a kite-killing jump.
  const redCut = (kind === 'spd') ? 1.30 : 1.50;
  if (r >= redCut) return _STAT_COLORS.red;
  if (r > 1.0)     return _STAT_COLORS.amber;
  return _STAT_COLORS.green;
}

// Map current tab to an array of entries:
//   { id, name, icon, lore, discovered, kills?, picks?, statLine }
// stats: array of [label, value] or [label, value, color] — color tints the
// value cell in the detail panel; falsy color falls back to C.amber.
function _entriesForTab(tab, { ENEMY_TIERS, REGISTRY, EVOLUTIONS, PASSIVES, SECRETS, WEEKLY_MUTATORS }) {
  const meta = getMeta();
  const codex = meta.codex || {};
  if (tab === 'enemies') {
    const sec = codex.enemies || {};
    // Roster-relative medians for the stat color tiering. Computed once per
    // tab open (this function is called inside repaint); cheap on ~25 entries.
    const medHp  = _median(ENEMY_TIERS.map(t => t.hp));
    const medSpd = _median(ENEMY_TIERS.map(t => t.spd));
    const medDmg = _median(ENEMY_TIERS.map(t => t.dmg));
    return ENEMY_TIERS.map(t => {
      const lore = LORE[t.glb] || { name: t.glb, icon: '❓', text: '' };
      const rec = sec[t.glb];
      return {
        id: t.glb,
        name: lore.name,
        icon: lore.icon,
        lore: lore.text,
        discovered: !!(rec && rec.discovered),
        kills: rec ? (rec.kills || 0) : 0,
        statLine: rec ? `Kills: ${rec.kills || 0}` : '',
        stats: [
          ['HP',      t.hp,  _statTierColor('hp',  t.hp,  medHp)],
          ['Speed',   t.spd, _statTierColor('spd', t.spd, medSpd)],
          ['Damage',  t.dmg, _statTierColor('dmg', t.dmg, medDmg)],
          ['Tier',    t.elite ? 'Elite' : (t.isMiniBoss ? 'Mini-boss' : 'Standard')],
        ],
      };
    });
  }
  if (tab === 'weapons') {
    const sec = codex.weapons || {};
    const list = [];
    for (const id of Object.keys(REGISTRY)) {
      const w = REGISTRY[id];
      const lore = LORE[id] || { name: w.name || id, icon: w.icon || '★', text: '' };
      const rec = sec[id];
      list.push({
        id,
        name: w.name || lore.name,
        icon: w.icon || lore.icon,
        lore: lore.text,
        discovered: !!(rec && rec.discovered),
        picks: rec ? (rec.picks || 0) : 0,
        statLine: rec ? `Picked ${rec.picks || 0}×` : '',
        stats: [
          ['Max Level', w.maxLevel || '—'],
        ],
      });
    }
    // Evolutions are presented alongside weapons (same tab, second row of cards)
    for (const base of Object.keys(EVOLUTIONS)) {
      const evo = EVOLUTIONS[base];
      const evoSec = codex.evolutions || {};
      const lore = LORE[evo.id] || { name: evo.name, icon: evo.icon, text: evo.desc };
      const rec = evoSec[evo.id];
      list.push({
        id: evo.id,
        name: '★ ' + (evo.name || lore.name),
        icon: evo.icon || lore.icon,
        lore: lore.text || evo.desc,
        discovered: !!(rec && rec.discovered),
        statLine: rec ? 'Achieved' : '',
        stats: [
          ['Type', 'Evolution'],
          ['Base', base],
        ],
      });
    }
    return list;
  }
  if (tab === 'passives') {
    const sec = codex.passives || {};
    return PASSIVES.map(p => {
      const lore = LORE[p.id] || { name: p.name, icon: p.icon, text: '' };
      const rec = sec[p.id];
      const seenMax = (meta.passivesSeen && meta.passivesSeen[p.id]) || 0;
      return {
        id: p.id,
        name: p.name,
        icon: p.icon,
        lore: lore.text,
        discovered: !!(rec && rec.discovered) || seenMax > 0,
        picks: rec ? (rec.picks || 0) : 0,
        statLine: seenMax > 0 ? `Best lifetime: Lv ${seenMax}/${p.maxLevel}` : (rec ? `Picked ${rec.picks || 0}×` : ''),
        stats: [
          ['Max Level', p.maxLevel],
          ['Picks',     rec ? (rec.picks || 0) : 0],
        ],
      };
    });
  }
  if (tab === 'affixes') {
    const sec = codex.affixes || {};
    // Order matches teaching priority — Volatile is the loudest "stop dashing" lesson,
    // so it sits first regardless of discovery order.
    const AFFIX_IDS = ['volatile', 'vampiric', 'leaping', 'shielded', 'swift', 'frosted'];
    return AFFIX_IDS.map(id => {
      const lore = LORE[id] || { name: id, icon: '❓', text: '' };
      const tell = AFFIX_TELL[id] || { color: '#ffffff', counter: '' };
      const seenAt = sec[id] || 0;
      const discovered = seenAt > 0;
      return {
        id,
        name: lore.name,
        icon: lore.icon,
        lore: lore.text,
        discovered,
        statLine: discovered ? 'Seen in the wild' : 'Unseen',
        stats: [
          ['Tell',        discovered ? tell.swatch : '???'],
          ['Counterplay', discovered ? tell.counter : '???'],
        ],
      };
    });
  }
  if (tab === 'mutators') {
    // Weekly mutators — always shown (no discovery gate). The 6 weekly rules
    // rotate by ISO week, so players want to know what they're walking into
    // even before they've encountered each one. Highlight the active week.
    const active = (meta.weeklyBest && meta.weeklyBest.mutatorId) || null;
    const list = Array.isArray(WEEKLY_MUTATORS) ? WEEKLY_MUTATORS : [];
    return list.map(m => {
      const lore = LORE[m.id] || { name: m.label || m.id, icon: '🌀', text: '' };
      const isActive = (m.id === active);
      return {
        id: m.id,
        name: lore.name,
        icon: lore.icon,
        lore: lore.text,
        discovered: true,
        statLine: isActive ? '★ This week' : (m.label || ''),
        stats: [
          ['Code',  m.id],
          ['Label', m.label || ''],
        ],
      };
    });
  }
  if (tab === 'secrets') {
    const sec = codex.secrets || {};
    const unlockedMap = meta.secrets || {};
    return SECRETS.map(s => {
      const rec = sec[s.id];
      const unlocked = !!(rec && rec.discovered) || !!unlockedMap[s.id];
      return {
        id: s.id,
        name: s.name,
        icon: s.icon,
        lore: unlocked ? s.desc : s.hint,
        discovered: unlocked,
        statLine: unlocked ? 'Unlocked' : 'Hidden',
        stats: [
          ['Condition', unlocked ? s.desc : '???'],
        ],
      };
    });
  }
  return [];
}

function _renderGrid(entries, onClick) {
  const grid = document.createElement('div');
  grid.style.cssText = `
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 12px;
    width: 100%;
  `;
  // Responsive fallback for narrow viewports
  if (window.innerWidth < 900) {
    grid.style.gridTemplateColumns = 'repeat(3, 1fr)';
  }
  if (window.innerWidth < 560) {
    grid.style.gridTemplateColumns = 'repeat(2, 1fr)';
  }
  for (const ent of entries) {
    grid.appendChild(_renderCard(ent, onClick));
  }
  return grid;
}

function _renderCard(ent, onClick) {
  const card = document.createElement('div');
  const accent = ent.discovered ? C.cyan : 'rgba(80,80,80,0.4)';
  const opacity = ent.discovered ? 1 : 0.55;
  card.style.cssText = `
    background: linear-gradient(180deg, rgba(20,28,22,0.94), rgba(8,14,12,0.96));
    border: 1px solid ${accent};
    border-radius: 10px;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 10px 24px rgba(0,0,0,0.55);
    padding: 14px 12px 12px;
    text-align: center;
    cursor: ${ent.discovered ? 'pointer' : 'default'};
    opacity: ${opacity};
    transition: transform 0.16s ease, border-color 0.16s ease;
    min-height: 132px;
    display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
  `;
  if (ent.discovered) {
    card.onclick = () => onClick(ent);
    card.addEventListener('mouseenter', () => { card.style.transform = 'translateY(-2px)'; card.style.borderColor = C.amber; });
    card.addEventListener('mouseleave', () => { card.style.transform = 'translateY(0)';   card.style.borderColor = accent; });
  }
  card.innerHTML = ent.discovered ? `
    <div style="font-size:38px;line-height:1;margin-bottom:8px;filter:drop-shadow(0 3px 6px rgba(0,0,0,0.5));">${_esc(ent.icon)}</div>
    <div style="font-family:${F.display};font-size:12px;letter-spacing:0.14em;font-weight:700;color:${C.text};margin-bottom:6px;">${_esc(ent.name)}</div>
    <div style="font-size:10.5px;line-height:1.4;color:rgba(245,239,225,0.72);">${_esc(_truncate(ent.lore, 80))}</div>
    ${ent.statLine ? `<div style="margin-top:auto;padding-top:6px;font-family:${F.mono};font-size:10px;color:${C.amber};letter-spacing:0.08em;">${_esc(ent.statLine)}</div>` : ''}
  ` : `
    <div style="font-size:38px;line-height:1;margin-bottom:8px;color:rgba(120,120,120,0.55);filter:blur(0.5px);">???</div>
    <div style="font-family:${F.display};font-size:12px;letter-spacing:0.14em;font-weight:700;color:rgba(120,120,120,0.7);margin-bottom:6px;">Undiscovered</div>
    <div style="font-size:10.5px;line-height:1.4;color:rgba(120,120,120,0.55);">Encounter this one in the wild to reveal.</div>
  `;
  return card;
}

function _renderDetail(ent, onBack) {
  const wrap = document.createElement('div');
  wrap.style.cssText = `
    max-width: 720px; margin: 0 auto;
    background: linear-gradient(180deg, rgba(20,28,22,0.94), rgba(8,14,12,0.96));
    border: 1px solid ${C.amber};
    border-radius: 12px;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 14px 36px rgba(0,0,0,0.55);
    padding: 28px 32px;
  `;
  const statsRows = (ent.stats || []).map((row) => {
    const k = row[0], v = row[1];
    const valColor = row[2] || C.amber;
    return `
    <div style="font-family:${F.body};font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(245,239,225,0.62);">${_esc(k)}</div>
    <div style="font-family:${F.mono};font-size:13px;color:${valColor};text-align:right;">${_esc(v)}</div>
  `;
  }).join('');
  wrap.innerHTML = `
    <div style="display:flex;align-items:center;gap:18px;margin-bottom:14px;">
      <div style="font-size:60px;line-height:1;filter:drop-shadow(0 3px 6px rgba(0,0,0,0.5));">${_esc(ent.icon)}</div>
      <div>
        <div style="font-family:${F.display};font-size:24px;letter-spacing:0.16em;font-weight:900;color:${C.amber};">${_esc(ent.name)}</div>
        <div style="font-family:${F.body};font-size:11px;letter-spacing:0.20em;text-transform:uppercase;color:rgba(245,239,225,0.55);margin-top:4px;">${_esc(ent.statLine || '')}</div>
      </div>
    </div>
    <div style="font-size:13.5px;line-height:1.65;color:rgba(245,239,225,0.85);margin-bottom:18px;">${_esc(ent.lore)}</div>
    <div style="display:grid;grid-template-columns: 1fr auto; column-gap:32px; row-gap:8px; align-items:baseline; padding-top:10px; border-top:1px solid ${C.edge};">
      ${statsRows}
    </div>
  `;
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.textContent = '◂ Back';
  backBtn.style.cssText = `margin-top: 22px; padding: 8px 22px; cursor: pointer;
    background: linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86));
    border: 1px solid ${C.edge}; border-radius: 8px;
    color: ${C.cyan}; font-family: ${F.display}; font-size: 12px; font-weight: 700;
    letter-spacing: 0.28em;`;
  backBtn.onclick = onBack;
  wrap.appendChild(backBtn);
  return wrap;
}

// ── Achievement DAG ────────────────────────────────────────────────────────
// 3-column tree: Tier 1 (left) → Tier 2 (middle) → Tier 3 (right). Dotted SVG
// lines connect each child to its `requires` parents. Locked nodes show "???"
// with the parent-name hint underneath. We render the columns first inside a
// CSS grid, THEN overlay an absolute-positioned SVG whose line endpoints are
// computed from each card's bounding rect — this way the SVG follows reflows
// without us recomputing during render.

function _renderAchievementDAG(ACHIEVEMENTS, achievementChain) {
  const wrap = document.createElement('div');
  wrap.style.cssText = `
    max-width: 1180px; margin: 0 auto;
    background: linear-gradient(180deg, rgba(20,28,22,0.94), rgba(8,14,12,0.96));
    border: 1px solid ${C.amber};
    border-radius: 12px;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 14px 36px rgba(0,0,0,0.55);
    padding: 22px 24px 24px;
    position: relative;
  `;

  const header = document.createElement('div');
  header.style.cssText = `display:flex; align-items:baseline; justify-content:space-between; margin-bottom: 14px;`;
  const meta = getMeta();
  const unlockedCount = (ACHIEVEMENTS || []).reduce((n, a) =>
    n + (meta.achievements && meta.achievements[a.id] ? 1 : 0), 0);
  header.innerHTML = `
    <div>
      <div style="font-family:${F.display};font-size:20px;letter-spacing:0.20em;font-weight:900;color:${C.amber};">Achievements</div>
      <div style="font-family:${F.body};font-size:10.5px;letter-spacing:0.22em;text-transform:uppercase;color:rgba(245,239,225,0.55);margin-top:4px;">
        Tier 1 → 2 → 3 · unlock parents to light up children
      </div>
    </div>
    <div style="font-family:${F.mono};font-size:11px;color:${C.amber};">${unlockedCount} / ${(ACHIEVEMENTS || []).length}</div>
  `;
  wrap.appendChild(header);

  // Group by tier. ACHIEVEMENTS without a tier field (pre-9a) default to tier 1
  // so partial-merge states still render coherently.
  const byTier = { 1: [], 2: [], 3: [] };
  for (const a of (ACHIEVEMENTS || [])) {
    const t = a.tier || 1;
    if (byTier[t]) byTier[t].push(a);
    else byTier[1].push(a);
  }

  // 3-column grid container
  const grid = document.createElement('div');
  grid.style.cssText = `
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 14px 36px;
    position: relative;
    z-index: 2;
  `;

  const columnHeader = (label, color) => {
    const h = document.createElement('div');
    h.style.cssText = `
      font-family: ${F.display}; font-size: 11px; letter-spacing: 0.32em;
      text-transform: uppercase; color: ${color};
      padding-bottom: 8px; margin-bottom: 4px;
      border-bottom: 1px solid ${C.edge};
      text-align: center;
    `;
    h.textContent = label;
    return h;
  };

  // Build 3 column wrappers
  const cols = [document.createElement('div'), document.createElement('div'), document.createElement('div')];
  for (const c of cols) c.style.cssText = 'display:flex; flex-direction:column; gap:10px;';
  cols[0].appendChild(columnHeader('Tier 1 · Foundations', C.cyan));
  cols[1].appendChild(columnHeader('Tier 2 · Pursuits',    C.amber));
  cols[2].appendChild(columnHeader('Tier 3 · Mastery',     C.magenta));

  // Card index by id so the line-drawing pass can look up DOM nodes.
  const cardById = {};

  const cardFor = (a) => {
    const unlocked = !!(meta.achievements && meta.achievements[a.id]);
    // Resolve parent names — for locked nodes we surface the requirement so
    // the player understands the dependency without opening another modal.
    const parents = Array.isArray(a.requires) ? a.requires : [];
    const parentNames = parents
      .map(pid => (ACHIEVEMENTS || []).find(x => x.id === pid))
      .filter(Boolean)
      .map(p => p.name);
    const card = document.createElement('div');
    card.dataset.achId = a.id;
    const accent = unlocked
      ? ((a.tier || 1) === 3 ? C.magenta : (a.tier || 1) === 2 ? C.amber : C.cyan)
      : 'rgba(120,120,120,0.45)';
    card.style.cssText = `
      background: linear-gradient(180deg, rgba(14,20,18,0.94), rgba(6,10,9,0.96));
      border: 1px solid ${accent};
      border-radius: 8px;
      padding: 10px 12px;
      display: grid;
      grid-template-columns: 32px 1fr;
      gap: 10px;
      align-items: center;
      opacity: ${unlocked ? 1 : 0.62};
      box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 6px 16px rgba(0,0,0,0.45);
    `;
    const icon = unlocked ? _esc(a.icon || '★') : '???';
    const title = unlocked ? _esc(a.name) : '???';
    const body = unlocked
      ? _esc(a.desc || '')
      : (parentNames.length
          ? `Requires: ${_esc(parentNames.join(' + '))}`
          : 'Hidden achievement');
    card.innerHTML = `
      <div style="font-size:22px; line-height:1; text-align:center; ${unlocked ? '' : 'color:rgba(120,120,120,0.55); font-family:' + F.mono + '; font-size:13px;'}">${icon}</div>
      <div>
        <div style="font-family:${F.display}; font-size:12.5px; letter-spacing:0.10em; font-weight:700; color:${unlocked ? C.text : 'rgba(180,180,180,0.65)'};">${title}</div>
        <div style="font-family:${F.body}; font-size:10.5px; color:rgba(245,239,225,0.65); margin-top:3px; line-height:1.35;">${body}</div>
      </div>
    `;
    cardById[a.id] = card;
    return card;
  };

  for (const a of byTier[1]) cols[0].appendChild(cardFor(a));
  for (const a of byTier[2]) cols[1].appendChild(cardFor(a));
  for (const a of byTier[3]) cols[2].appendChild(cardFor(a));

  grid.appendChild(cols[0]);
  grid.appendChild(cols[1]);
  grid.appendChild(cols[2]);
  wrap.appendChild(grid);

  // SVG overlay for parent → child dotted lines. We measure after the cards
  // are in the DOM tree; the parent wrap is position:relative so the SVG
  // (position:absolute) inherits the right reference frame. Re-measure on
  // window resize so the lines track reflows; cleared when the modal closes.
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.style.cssText = `
    position: absolute; inset: 0; pointer-events: none; z-index: 1;
  `;
  wrap.appendChild(svg);

  const drawLines = () => {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const wrapRect = wrap.getBoundingClientRect();
    svg.setAttribute('width',  String(wrapRect.width));
    svg.setAttribute('height', String(wrapRect.height));
    svg.setAttribute('viewBox', `0 0 ${wrapRect.width} ${wrapRect.height}`);
    for (const a of (ACHIEVEMENTS || [])) {
      const parents = Array.isArray(a.requires) ? a.requires : [];
      if (parents.length === 0) continue;
      const childCard = cardById[a.id];
      if (!childCard) continue;
      const cr = childCard.getBoundingClientRect();
      const cx = cr.left - wrapRect.left;
      const cy = cr.top + cr.height / 2 - wrapRect.top;
      const childUnlocked = !!(meta.achievements && meta.achievements[a.id]);
      for (const pid of parents) {
        const parentCard = cardById[pid];
        if (!parentCard) continue;
        const pr = parentCard.getBoundingClientRect();
        const px = pr.right - wrapRect.left;
        const py = pr.top + pr.height / 2 - wrapRect.top;
        // Smooth curve via cubic Bezier midpoints — reads as a tree connector
        // rather than a corridor of straight lines.
        const dx = (cx - px) * 0.5;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', `M${px},${py} C${px + dx},${py} ${cx - dx},${cy} ${cx},${cy}`);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', childUnlocked ? C.amber : 'rgba(180,180,180,0.32)');
        path.setAttribute('stroke-width', '1.4');
        path.setAttribute('stroke-dasharray', '3 4');
        path.setAttribute('opacity', childUnlocked ? '0.85' : '0.55');
        svg.appendChild(path);
      }
    }
  };
  // Defer measurement until after the wrap is in the DOM tree.
  setTimeout(drawLines, 0);
  // Resize listener — `drawLines` early-outs when `wrap` is no longer in the
  // DOM, so a stale listener costs one boundingClientRect call. We also poll
  // once per second to retire the listener when the modal closes; this is
  // cheaper than MutationObserver on document.body (which would fire on every
  // HUD update + damage number) and good enough for a modal whose lifetime is
  // typically seconds, not minutes.
  let resizeAttached = true;
  const onResize = () => {
    if (!wrap.isConnected) {
      if (resizeAttached) { window.removeEventListener('resize', onResize); resizeAttached = false; }
      return;
    }
    drawLines();
  };
  window.addEventListener('resize', onResize);
  const tidy = () => {
    if (!wrap.isConnected) {
      if (resizeAttached) { window.removeEventListener('resize', onResize); resizeAttached = false; }
      return;
    }
    setTimeout(tidy, 1000);
  };
  setTimeout(tidy, 1000);

  return wrap;
}

// ── Legend overlay ─────────────────────────────────────────────────────────
// 1-screen visual key for affix tells. Each row shows the in-game silhouette
// cue as a tiny inline SVG/CSS swatch, then the affix name + 1-line counter.
// Goal: a player who's seen one cyan ring should learn "explosive on death"
// without ever picking up the controller.

const LEGEND_ROWS = [
  { id: 'volatile', name: 'Volatile', tell: 'Cyan ring on the ground',     counter: 'Don\'t dash through. Let it pop, then collect.' },
  { id: 'vampiric', name: 'Vampiric', tell: 'Red threat-dot overhead',     counter: 'Burst it down. Chip damage just feeds the heal.' },
  { id: 'leaping',  name: 'Leaping',  tell: 'Magenta arc at landing site', counter: 'Dash out of the marker before windup ends.' },
  { id: 'shielded', name: 'Shielded', tell: 'Gold rim flickering',         counter: 'Sustain DPS, not burst. Orbitals strip it fast.' },
  { id: 'swift',    name: 'Swift',    tell: 'Faint trailing afterimage',   counter: 'Lead your shots. Fast but fragile.' },
  { id: 'frosted',  name: 'Frosted',  tell: 'Cyan motes drifting up',      counter: 'Stay outside the aura. Kite around the edge.' },
];

function _legendSwatch(id) {
  // Each tell renders as a 36×36 visual cell, styled to roughly match the
  // in-game silhouette so the eye learns the mapping in one glance.
  const sz = 36;
  if (id === 'volatile') {
    // Cyan ring on the ground (flat ellipse to read as a decal at iso angle).
    return `<svg viewBox="0 0 36 36" width="${sz}" height="${sz}" aria-hidden="true">
      <ellipse cx="18" cy="22" rx="14" ry="5" fill="none" stroke="#66ddff" stroke-width="2"
        style="filter: drop-shadow(0 0 4px #66ddff);"/>
      <ellipse cx="18" cy="22" rx="9" ry="3" fill="none" stroke="#66ddff" stroke-width="1" opacity="0.6"/>
    </svg>`;
  }
  if (id === 'vampiric') {
    // Red threat dot (matches the in-scene billboard above the enemy head).
    return `<svg viewBox="0 0 36 36" width="${sz}" height="${sz}" aria-hidden="true">
      <circle cx="18" cy="14" r="5" fill="#ff3344"
        style="filter: drop-shadow(0 0 5px #ff3344);"/>
      <circle cx="18" cy="14" r="2.4" fill="#ffffff" opacity="0.85"/>
      <path d="M14 22 L18 30 L22 22 Z" fill="#ff3344" opacity="0.35"/>
    </svg>`;
  }
  if (id === 'leaping') {
    // Magenta landing arc — crescent at the target point.
    return `<svg viewBox="0 0 36 36" width="${sz}" height="${sz}" aria-hidden="true">
      <path d="M4 12 Q18 -4 32 12" fill="none" stroke="#ff66ee" stroke-width="2"
        stroke-dasharray="2 2"
        style="filter: drop-shadow(0 0 4px #ff66ee);"/>
      <ellipse cx="32" cy="22" rx="6" ry="2" fill="none" stroke="#ff66ee" stroke-width="2"/>
    </svg>`;
  }
  if (id === 'shielded') {
    // Gold rim flicker around a silhouette.
    return `<svg viewBox="0 0 36 36" width="${sz}" height="${sz}" aria-hidden="true">
      <circle cx="18" cy="18" r="11" fill="none" stroke="#ffd24a" stroke-width="2"
        style="filter: drop-shadow(0 0 6px #ffd24a);"/>
      <circle cx="18" cy="18" r="11" fill="none" stroke="#fff9e6" stroke-width="0.7" opacity="0.8"/>
      <circle cx="18" cy="18" r="6"  fill="#231a14"/>
    </svg>`;
  }
  if (id === 'swift') {
    // Blurred afterimage — three offset silhouettes fading out.
    return `<svg viewBox="0 0 36 36" width="${sz}" height="${sz}" aria-hidden="true">
      <circle cx="10" cy="18" r="5" fill="#7fffe4" opacity="0.18"/>
      <circle cx="16" cy="18" r="5" fill="#7fffe4" opacity="0.40"/>
      <circle cx="24" cy="18" r="6" fill="#7fffe4"
        style="filter: drop-shadow(0 0 4px #7fffe4);"/>
    </svg>`;
  }
  if (id === 'frosted') {
    // Cyan motes drifting upward.
    return `<svg viewBox="0 0 36 36" width="${sz}" height="${sz}" aria-hidden="true">
      <polygon points="10,28 12,24 14,28 12,32" fill="#88ddff" opacity="0.85"/>
      <polygon points="18,22 20.5,17 23,22 20.5,27" fill="#88ddff" opacity="0.95"
        style="filter: drop-shadow(0 0 3px #88ddff);"/>
      <polygon points="26,14 27.5,11 29,14 27.5,17" fill="#88ddff" opacity="0.65"/>
      <polygon points="14,12 15,10 16,12 15,14" fill="#88ddff" opacity="0.55"/>
    </svg>`;
  }
  return '';
}

function _renderLegend(onBack) {
  const wrap = document.createElement('div');
  wrap.style.cssText = `
    max-width: 880px; margin: 0 auto;
    background: linear-gradient(180deg, rgba(20,28,22,0.94), rgba(8,14,12,0.96));
    border: 1px solid ${C.magenta};
    border-radius: 12px;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 14px 36px rgba(0,0,0,0.55);
    padding: 22px 26px 24px;
  `;

  const header = document.createElement('div');
  header.style.cssText = `display:flex; align-items:baseline; justify-content:space-between; margin-bottom: 14px;`;
  header.innerHTML = `
    <div>
      <div style="font-family:${F.display};font-size:20px;letter-spacing:0.20em;font-weight:900;color:${C.magenta};">Legend</div>
      <div style="font-family:${F.body};font-size:10.5px;letter-spacing:0.22em;text-transform:uppercase;color:rgba(245,239,225,0.55);margin-top:4px;">
        Read the tell before the trade
      </div>
    </div>
    <div style="font-family:${F.mono};font-size:10.5px;color:rgba(245,239,225,0.55);">Visual key</div>
  `;
  wrap.appendChild(header);

  const grid = document.createElement('div');
  // 2 columns × 3 rows on wide screens, single column at narrow widths so the
  // counterplay line never wraps awkwardly.
  const twoCol = window.innerWidth >= 720;
  grid.style.cssText = `
    display: grid;
    grid-template-columns: ${twoCol ? '1fr 1fr' : '1fr'};
    gap: 10px 14px;
  `;
  for (const row of LEGEND_ROWS) {
    const cell = document.createElement('div');
    cell.style.cssText = `
      display: grid;
      grid-template-columns: 48px 1fr;
      align-items: center;
      gap: 12px;
      padding: 10px 12px;
      background: linear-gradient(180deg, rgba(14,20,18,0.85), rgba(6,10,9,0.92));
      border: 1px solid ${C.edge};
      border-radius: 8px;
    `;
    cell.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;width:48px;height:48px;">
        ${_legendSwatch(row.id)}
      </div>
      <div>
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px;">
          <div style="font-family:${F.display};font-size:13px;letter-spacing:0.16em;font-weight:700;color:${C.amber};">${_esc(row.name.toUpperCase())}</div>
          <div style="font-family:${F.mono};font-size:10.5px;color:${C.cyan};">${_esc(row.tell)}</div>
        </div>
        <div style="font-family:${F.body};font-size:12px;line-height:1.4;color:rgba(245,239,225,0.82);">${_esc(row.counter)}</div>
      </div>
    `;
    grid.appendChild(cell);
  }
  wrap.appendChild(grid);

  const footer = document.createElement('div');
  footer.style.cssText = `display:flex;justify-content:space-between;align-items:center;margin-top:18px;`;
  footer.innerHTML = `
    <div style="font-family:${F.body};font-size:11px;letter-spacing:0.06em;color:rgba(245,239,225,0.55);">
      Elites in the late game roll one of these. Above difficulty 5, two can stack.
    </div>
  `;
  const back = document.createElement('button');
  back.type = 'button';
  back.textContent = '◂ Back';
  back.style.cssText = `padding: 8px 22px; cursor: pointer;
    background: linear-gradient(180deg, rgba(20,28,22,0.78), rgba(8,14,12,0.86));
    border: 1px solid ${C.edge}; border-radius: 8px;
    color: ${C.cyan}; font-family: ${F.display}; font-size: 12px; font-weight: 700;
    letter-spacing: 0.28em;`;
  back.onclick = onBack;
  footer.appendChild(back);
  wrap.appendChild(footer);
  return wrap;
}

function _truncate(s, n) {
  s = String(s || '');
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}
