/**
 * Codex / Bestiary — persistent discovery log of everything the player has met
 * in the wild. Vampire-Survivors-style: each entry is hidden behind a "???"
 * silhouette until the player encounters / kills / picks / evolves it.
 *
 * Persists into meta.codex (managed via getMeta/saveMeta from meta.js):
 *   meta.codex = { enemies: {}, weapons: {}, passives: {}, evolutions: {}, secrets: {} }
 * Each inner map is keyed by id → { discovered:true, kills?, picks?, firstSeenAt }.
 *
 * Public API:
 *   notifyEnemySeen(id), notifyEnemyKilled(id),
 *   notifyWeaponPicked(id), notifyPassivePicked(id),
 *   notifyEvolutionAchieved(id), notifySecretFound(id),
 *   showCodex(), hideCodex(), isCodexOpen(),
 *   LORE  (id-keyed flavor strings; exported for tests/debug)
 */

import { getMeta, saveMeta } from './meta.js';

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
};

// ── Persistent state helpers ────────────────────────────────────────────────
function _section(key) {
  const meta = getMeta();
  if (!meta.codex) meta.codex = { enemies: {}, weapons: {}, passives: {}, evolutions: {}, secrets: {} };
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

// ── Codex modal ─────────────────────────────────────────────────────────────
let _modal = null;
let _activeTab = 'enemies';
let _expanded = null;          // { tab, id } if a card is opened

export function isCodexOpen() { return !!_modal; }

export function hideCodex() {
  if (!_modal) return;
  if (_modal.parentNode) _modal.parentNode.removeChild(_modal);
  _modal = null;
  _expanded = null;
}

export function showCodex() {
  if (_modal) return;
  // Lazy-resolve registries so this module doesn't pull three.js at import time.
  Promise.all([
    import('./config.js'),
    import('./weapons/index.js'),
    import('./meta.js'),
  ]).then(([cfg, weapons, metaMod]) => {
    _buildModal({
      ENEMY_TIERS: cfg.ENEMY_TIERS,
      REGISTRY: weapons.REGISTRY,
      EVOLUTIONS: weapons.EVOLUTIONS,
      PASSIVES: weapons.PASSIVES,
      SECRETS: metaMod.SECRETS,
    });
  });
}

function _buildModal({ ENEMY_TIERS, REGISTRY, EVOLUTIONS, PASSIVES, SECRETS }) {
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
    { id: 'enemies',    label: 'Enemies' },
    { id: 'weapons',    label: 'Weapons' },
    { id: 'passives',   label: 'Passives' },
    { id: 'secrets',    label: 'Secrets' },
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
    b.onclick = () => { _activeTab = t.id; _expanded = null; repaint(); };
    tabBar.appendChild(b);
    tabBtns[t.id] = b;
  }

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
    // Tab highlight
    for (const t of TABS) {
      const b = tabBtns[t.id];
      const on = t.id === _activeTab;
      b.style.borderColor = on ? C.cyan : C.edge;
      b.style.color = on ? C.cyan : C.text;
      b.style.boxShadow = on
        ? `0 0 0 1px ${C.cyan} inset, 0 8px 22px rgba(0,0,0,0.5)`
        : `0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 20px rgba(0,0,0,0.5)`;
    }
    body.innerHTML = '';
    const entries = _entriesForTab(_activeTab, { ENEMY_TIERS, REGISTRY, EVOLUTIONS, PASSIVES, SECRETS });
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

  // ESC to close
  const onKey = (e) => {
    if (!_modal) return;
    if (e.code === 'Escape') {
      e.stopPropagation();
      if (_expanded) { _expanded = null; repaint(); }
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
      if (_expanded) { _expanded = null; repaint(); }
      else hideCodex();
    }
  };
  window.addEventListener('keydown', winKey, true);

  repaint();
}

// Map current tab to an array of entries:
//   { id, name, icon, lore, discovered, kills?, picks?, statLine }
function _entriesForTab(tab, { ENEMY_TIERS, REGISTRY, EVOLUTIONS, PASSIVES, SECRETS }) {
  const meta = getMeta();
  const codex = meta.codex || {};
  if (tab === 'enemies') {
    const sec = codex.enemies || {};
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
          ['HP',      t.hp],
          ['Speed',   t.spd],
          ['Damage',  t.dmg],
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
  const statsRows = (ent.stats || []).map(([k, v]) => `
    <div style="font-family:${F.body};font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(245,239,225,0.62);">${_esc(k)}</div>
    <div style="font-family:${F.mono};font-size:13px;color:${C.amber};text-align:right;">${_esc(v)}</div>
  `).join('');
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

function _truncate(s, n) {
  s = String(s || '');
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}
