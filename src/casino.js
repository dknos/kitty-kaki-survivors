/**
 * Casino — Seedy Tent gambling den (iter 22B).
 *
 * Two games:
 *   1. SLOT MACHINE — 3-reel RNG against the regular meta currency (Embers).
 *      6 symbols, weighted so the house edge averages ~5% over many spins.
 *      Three matching ★ = 25× bet; three matching anything else = 8× bet;
 *      two matching = 1.5× bet (refund-with-bonus); no match = 0× (loss).
 *      Pity rail: if the player would lose and their balance dips below 100
 *      Embers, the spin pays 1.2× bet instead. Surfaced honestly in the UI.
 *
 *   2. BOSS RUSH WAGER — player commits 100..1000 Embers + 1..3 mutator
 *      stacks (each +30% difficulty); the next Boss Rush run pays out
 *      wager × payoutMul on victory (2x / 4x / 8x for 1/2/3 stacks),
 *      forfeit on death. Settlement is deferred: the wager is stashed in
 *      localStorage at run start with a snapshot of the lifetime Boss
 *      Rush victory counter; on the next town entry (or casino open),
 *      we compare the current counter — if it grew, payout; if not, forfeit.
 *      This avoids touching main.js's gameOver path.
 *
 * No mid-modal mutation of state.run — wagers go through state.modes only.
 * RNG is Math.random() with no seed claims; the UI doesn't pretend otherwise.
 *
 * UI lives in ui.js (showCasinoMenu, showCasinoSlots, showBossRushWager).
 * This module owns: symbol table, weighted reels, payout resolution, the
 * wager stash + settle protocol, and a small toast helper for results.
 */
import { state } from './state.js';
import { getMeta, saveMeta } from './meta.js';
import { sfx } from './audio.js';

// ── Symbol table — 6 symbols with weights tuned to ~5% house edge ───────────
// House edge math (sketch, single bet=1):
//   p(3-match-star) = (w_star / W)^3 × 25
//   p(3-match-other) = sum_other (w/W)^3 × 8
//   p(2-match) = 3 × sum_x (w_x/W)^2 × (1 - w_x/W) × 1.5
//   E[payout]/bet ≈ 0.95 with weights below. Verified by 200k-spin Monte Carlo
//   sanity check during tuning (not shipped). Star is the rare anchor (w=3).
export const SLOT_SYMBOLS = [
  { id: 'star',   icon: '🌟', name: 'Star',      weight: 3 },
  { id: 'gem',    icon: '💎', name: 'Gem',       weight: 5 },
  { id: 'kitty',  icon: '🐱', name: 'Kitty',     weight: 6 },
  { id: 'flame',  icon: '🔥', name: 'Flame',     weight: 6 },
  { id: 'bolt',   icon: '⚡', name: 'Lightning', weight: 7 },
  { id: 'bone',   icon: '🦴', name: 'Bone',      weight: 8 },
];

const _TOTAL_WEIGHT = SLOT_SYMBOLS.reduce((s, x) => s + x.weight, 0);

export const SLOT_BETS = [10, 50, 250];
export const PITY_FLOOR = 100;        // below this, losing spins pay 1.2× as pity
export const PITY_MUL = 1.2;

// ── RNG ──────────────────────────────────────────────────────────────────────
/** Roll one reel — weighted pick from SLOT_SYMBOLS. */
export function rollReel() {
  let r = Math.random() * _TOTAL_WEIGHT;
  for (const s of SLOT_SYMBOLS) {
    r -= s.weight;
    if (r <= 0) return s;
  }
  return SLOT_SYMBOLS[SLOT_SYMBOLS.length - 1];
}

/** Roll three independent reels. Returns an array of 3 symbol defs. */
export function rollThreeReels() {
  return [rollReel(), rollReel(), rollReel()];
}

// ── Payout resolution ────────────────────────────────────────────────────────
/**
 * Resolve a 3-reel result vs. the player's bet. Returns:
 *   { tier, mult, payout, label, symbolId, pity }
 * tier: 'jackpot' | 'triple' | 'double' | 'loss' | 'pity'
 * Pity is only applied at the caller — see resolveSpin().
 */
export function resolveReels(reels) {
  const [a, b, c] = reels;
  if (a.id === b.id && b.id === c.id) {
    if (a.id === 'star') return { tier: 'jackpot', mult: 25, label: '★ ★ ★ JACKPOT!', symbolId: a.id };
    return { tier: 'triple', mult: 8, label: 'TRIPLE!', symbolId: a.id };
  }
  if (a.id === b.id || b.id === c.id || a.id === c.id) {
    return { tier: 'double', mult: 1.5, label: 'pair', symbolId: (a.id === b.id ? a.id : (b.id === c.id ? b.id : a.id)) };
  }
  return { tier: 'loss', mult: 0, label: 'no match', symbolId: null };
}

/**
 * Settle a single spin against the player's Embers balance. Bet is debited
 * up-front by the UI layer (so the modal can disable spin during animation);
 * we just compute the payout + bump lifetime counters. Returns the resolution
 * plus the final payout amount in Embers (may be adjusted by the pity rail).
 *
 * Inputs: bet (positive int), reels (3 SLOT_SYMBOLS entries).
 * Side effects: meta.embers credited with payout, lifetime tallies bumped.
 *
 * Pity rule: if a player would otherwise take a 0× loss and their POST-LOSS
 * balance would be below PITY_FLOOR, we award PITY_MUL × bet instead (a small
 * consolation that lets them play a couple more spins). UI must show this so
 * it doesn't feel like a cheat.
 */
export function resolveSpin(bet, reels) {
  const res = resolveReels(reels);
  const meta = getMeta();
  let payout = Math.floor(bet * res.mult);
  let pity = false;
  // Pity rail — only triggers on a true loss when balance is critical.
  if (res.tier === 'loss' && (meta.embers || 0) < PITY_FLOOR) {
    payout = Math.floor(bet * PITY_MUL);
    pity = true;
  }
  meta.embers = (meta.embers || 0) + payout;
  // Lifetime accounting — bump regardless of payout so the player's
  // gambling fingerprint is preserved across runs.
  meta.casinoLifetimeWagered = (meta.casinoLifetimeWagered || 0) + bet;
  meta.casinoLifetimeWon = (meta.casinoLifetimeWon || 0) + payout;
  if (res.tier === 'jackpot') {
    meta.casinoSlotsBigWins = (meta.casinoSlotsBigWins || 0) + 1;
  }
  saveMeta();
  return { ...res, payout, pity, bet };
}

// ── Boss Rush Wager ──────────────────────────────────────────────────────────
// LocalStorage shape:
//   kk_casino_wager_active: {
//     wagerAmount: int,        // 100..1000
//     stacks: int,             // 1..3
//     payoutMul: int,          // 2/4/8
//     mutators: [{id, label}], // for the death/victory toast
//     startedAt: ms timestamp,
//     clearsSnapshot: int,     // meta.casinoBossRushClears at wager start
//   }
const WAGER_KEY = 'kk_casino_wager_active';

export const BOSS_RUSH_MUTATORS = [
  { id: 'bloodlust', label: 'Bloodlust',  desc: 'Enemy DMG x1.4',    accent: '#ff5e5e' },
  { id: 'ironhide',  label: 'Iron Hide',  desc: 'Enemy HP x1.5',     accent: '#7fffe4' },
  { id: 'swiftdoom', label: 'Swift Doom', desc: 'Spawn rate x1.5',   accent: '#ffd27f' },
];

export function payoutMulForStacks(stacks) {
  if (stacks <= 0) return 0;
  if (stacks === 1) return 2;
  if (stacks === 2) return 4;
  return 8;     // stacks >= 3
}

/** True if a previous Boss Rush Wager is still open and unsettled. */
export function hasActiveWager() {
  try {
    return !!localStorage.getItem(WAGER_KEY);
  } catch (_) { return false; }
}

/** Read the raw wager record (or null). */
export function readWager() {
  try {
    const raw = localStorage.getItem(WAGER_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}

/**
 * Start a Boss Rush Wager. Validates inputs, debits Embers, flips state.modes
 * so the next run launches into Boss Rush automatically, and stashes the wager
 * record in localStorage with a snapshot of the current clears counter.
 *
 * Returns { ok, reason? } so the UI can show a specific error toast.
 * Reasons: 'unlocked' | 'already_active' | 'bad_stacks' | 'bad_amount' |
 *          'insufficient' | 'no_mutators'
 *
 * IMPORTANT: this does NOT start a run — it primes the wager. The UI closes
 * the modal and the player walks to the gate. main.js reads state.modes.bossRush
 * as it already does; the casinoWager flag rides alongside for the settlement
 * pass on the way back to town.
 */
export function startBossRushWager({ wagerAmount, stacks, mutators } = {}) {
  const meta = getMeta();
  if (!meta.unlockedVoid) return { ok: false, reason: 'unlocked' };
  if (hasActiveWager()) return { ok: false, reason: 'already_active' };
  const amt = Math.floor(Number(wagerAmount) || 0);
  if (!(amt >= 100 && amt <= 1000)) return { ok: false, reason: 'bad_amount' };
  if ((meta.embers || 0) < amt) return { ok: false, reason: 'insufficient' };
  const muts = Array.isArray(mutators) ? mutators.filter(Boolean) : [];
  if (!muts.length) return { ok: false, reason: 'no_mutators' };
  const stk = Math.max(1, Math.min(3, muts.length));
  if (typeof stacks === 'number' && stacks !== stk) return { ok: false, reason: 'bad_stacks' };
  // Debit the wager up-front — the player feels the cost the moment they
  // commit. Refund is what victory pays out (× payoutMul).
  meta.embers -= amt;
  meta.casinoLifetimeWagered = (meta.casinoLifetimeWagered || 0) + amt;
  saveMeta();
  const payoutMul = payoutMulForStacks(stk);
  const record = {
    wagerAmount: amt,
    stacks: stk,
    payoutMul,
    mutators: muts.map(m => ({ id: m.id, label: m.label })),
    startedAt: Date.now(),
    clearsSnapshot: meta.casinoBossRushClears || 0,
  };
  try { localStorage.setItem(WAGER_KEY, JSON.stringify(record)); } catch (_) {}
  // Set state.modes flags. We force Boss Rush ON for the next run; the rest
  // of the chassis (spawnDirector, etc.) reads bossRush as it already does.
  // casinoWager is a side-channel flag other code can read if it wants to.
  if (!state.modes) state.modes = {};
  state.modes.bossRush = true;
  state.modes.casinoWager = {
    wagerAmount: amt,
    stacks: stk,
    payoutMul,
    mutators: record.mutators,
  };
  // Also pre-flag meta.optBossRush so applyMetaUpgrades respects the choice
  // when the gate runs. The flag survives the run.
  meta.optBossRush = true;
  saveMeta();
  return { ok: true, record };
}

/**
 * Settle a pending wager. Called on town entry + on casino open. No-op if no
 * wager is stashed. If the lifetime Boss Rush clears counter grew since the
 * wager started, payout = wagerAmount × payoutMul; otherwise the wager is
 * forfeit. Either way the wager record is cleared and state.modes.casinoWager
 * is unset.
 *
 * Returns { result: 'won'|'forfeit'|'none', amount, record? } so the caller
 * can toast — town.enterTown() and the casino menu both call this.
 */
export function settlePendingWager() {
  const record = readWager();
  if (!record) {
    if (state.modes) state.modes.casinoWager = null;
    return { result: 'none', amount: 0 };
  }
  const meta = getMeta();
  const currentClears = meta.casinoBossRushClears || 0;
  const won = currentClears > (record.clearsSnapshot || 0);
  try { localStorage.removeItem(WAGER_KEY); } catch (_) {}
  if (state.modes) state.modes.casinoWager = null;
  if (won) {
    const payout = Math.floor((record.wagerAmount || 0) * (record.payoutMul || 0));
    meta.embers = (meta.embers || 0) + payout;
    meta.casinoLifetimeWon = (meta.casinoLifetimeWon || 0) + payout;
    saveMeta();
    _showCasinoToast(`🎰 WAGER WON · +${payout.toLocaleString()} 🔥`, '#ffd27f');
    try { sfx.levelUp && sfx.levelUp(); } catch (_) {}
    return { result: 'won', amount: payout, record };
  }
  _showCasinoToast('🎰 Wager forfeit.', '#ff5e5e');
  try { sfx.uiCancel && sfx.uiCancel(); } catch (_) {}
  return { result: 'forfeit', amount: 0, record };
}

/**
 * Manual cancel — refund the wager amount and clear the stash. Used if the
 * player closes the menu without commiting? (Currently no UI calls this;
 * exported in case a future Settings → "cancel pending wager" surfaces.)
 */
export function cancelPendingWager() {
  const record = readWager();
  if (!record) return false;
  const meta = getMeta();
  meta.embers = (meta.embers || 0) + (record.wagerAmount || 0);
  saveMeta();
  try { localStorage.removeItem(WAGER_KEY); } catch (_) {}
  if (state.modes) state.modes.casinoWager = null;
  return true;
}

// ── Small DOM toast helper — keeps casino.js free of ui.js coupling ─────────
// Mirrors town.js's _showBrazierToast in shape so the visual language is
// consistent. ~2.4s on screen, top-center, color-coded by outcome.
function _showCasinoToast(text, accent = '#ffd27f') {
  if (typeof document === 'undefined') return;
  const t = document.createElement('div');
  t.style.cssText = `
    position: fixed; left: 50%; top: 12%; transform: translateX(-50%);
    padding: 11px 26px; pointer-events: none; z-index: 110;
    background: linear-gradient(180deg, rgba(34,18,12,0.94), rgba(20,10,8,0.96));
    border: 1px solid ${accent};
    border-radius: 8px;
    font-family: 'Cinzel Decorative', serif; font-size: 14px;
    letter-spacing: 0.18em; text-transform: uppercase;
    color: ${accent};
    text-shadow: 0 0 10px ${accent}55;
    box-shadow: 0 8px 22px rgba(0,0,0,0.6), 0 0 24px ${accent}33;
  `;
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 2400);
}
