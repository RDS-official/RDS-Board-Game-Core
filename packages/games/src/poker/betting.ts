/**
 * No-limit betting maths for the Texas Hold'em fixture.
 *
 * Everything here is a pure function of plain numbers and id arrays: no state
 * objects, no kernel imports. `rules.ts` owns the state shape and calls these.
 */

/** The subset of the hand state the betting maths needs. */
export interface BettingState {
  /** Highest street commitment so far. */
  currentBet: number;
  /** Size of the last full raise; also the minimum next raise increment. */
  lastRaiseSize: number;
  bigBlind: number;
  streetBets: Record<string, number>;
  /** Players that have acted since the last *full* raise. */
  actedSinceRaise: string[];
  folded: string[];
  allIn: string[];
}

export interface Pot {
  amount: number;
  /** Players still eligible to win this pot. */
  eligible: string[];
}

/** Chips still owed by `playerId` on the current street. */
export function toCall(hand: BettingState, playerId: string): number {
  return Math.max(0, hand.currentBet - (hand.streetBets[playerId] ?? 0));
}

/** Smallest legal "raise to" total for the current street. */
export function minRaiseTo(hand: BettingState): number {
  return hand.currentBet + hand.lastRaiseSize;
}

/**
 * A player may raise only if they have not acted since the last full raise.
 * An incomplete all-in raise therefore does not reopen the betting.
 */
export function mayRaise(hand: BettingState, playerId: string): boolean {
  return !hand.actedSinceRaise.includes(playerId);
}

/**
 * True once the current street has nothing left to decide.
 *
 * House rule, stated by the table: **a raise never opens the next street by
 * itself**. The round only closes when every seat that can still act has put in
 * exactly the current bet (平注) *and* has acted since the last full raise — so
 * a raise always forces the other seats to call, fold, or re-raise first.
 *
 * With a single player still able to act there is nobody to bet into, so the
 * street closes as soon as their commitment matches the current bet (they may
 * still need to call or fold first).
 */
export function isRoundComplete(hand: BettingState, live: readonly string[]): boolean {
  if (live.length <= 1) return true;
  const actors = live.filter(pid => !hand.allIn.includes(pid));
  if (actors.length === 0) return true;
  if (actors.length === 1) {
    return (hand.streetBets[actors[0]] ?? 0) >= hand.currentBet;
  }
  return actors.every(
    pid => (hand.streetBets[pid] ?? 0) >= hand.currentBet && hand.actedSinceRaise.includes(pid)
  );
}

/** Next seat index strictly after `seat` that satisfies `accept`. */
export function seatAfter(
  order: readonly string[],
  seat: number,
  accept: (playerId: string, index: number) => boolean
): number {
  for (let step = 1; step <= order.length; step++) {
    const index = (seat + step) % order.length;
    if (accept(order[index], index)) return index;
  }
  return seat;
}

/**
 * Split the hand's contributions into a main pot plus side pots.
 *
 * Each distinct contribution level forms a layer: everyone who put in at least
 * that much pays into it, and only the players who have not folded may win it.
 * A top layer with a single contributor is exactly the uncalled bet, so it is
 * refunded to that player without a special case.
 */
export function buildPots(handBets: Record<string, number>, folded: readonly string[]): Pot[] {
  const entries = Object.entries(handBets).filter(([, amount]) => amount > 0);
  const levels = [...new Set(entries.map(([, amount]) => amount))].sort((a, b) => a - b);
  const pots: Pot[] = [];
  let previous = 0;

  for (const level of levels) {
    const contributors = entries.filter(([, amount]) => amount >= level).map(([pid]) => pid);
    const amount = (level - previous) * contributors.length;
    previous = level;
    if (amount <= 0) continue;

    const eligible = contributors.filter(pid => !folded.includes(pid));
    if (eligible.length === 0) {
      // Defensive: dead money with no eligible player folds into the pot below.
      const last = pots[pots.length - 1];
      if (last) last.amount += amount;
      continue;
    }
    const previousPot = pots[pots.length - 1];
    if (previousPot && sameMembers(previousPot.eligible, eligible)) {
      previousPot.amount += amount;
    } else {
      pots.push({ amount, eligible });
    }
  }

  return pots;
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every(id => set.has(id));
}

/**
 * Split `amount` between `winners` as evenly as possible; the odd chips go to
 * the winners closest to the left of the button, which is the standard rule.
 */
export function splitAmount(
  amount: number,
  winners: readonly string[],
  order: readonly string[],
  buttonSeat: number
): Record<string, number> {
  const award: Record<string, number> = {};
  if (winners.length === 0 || amount <= 0) return award;

  const base = Math.floor(amount / winners.length);
  let remainder = amount - base * winners.length;
  for (const pid of winners) award[pid] = base;

  if (remainder > 0) {
    const ordered = [...winners].sort(
      (left, right) => seatDistance(order, buttonSeat, left) - seatDistance(order, buttonSeat, right)
    );
    for (const pid of ordered) {
      if (remainder === 0) break;
      award[pid] += 1;
      remainder--;
    }
  }
  return award;
}

/** Clockwise distance from the button (1 = small blind seat). */
function seatDistance(order: readonly string[], buttonSeat: number, playerId: string): number {
  const index = order.indexOf(playerId);
  if (index < 0) return Number.MAX_SAFE_INTEGER;
  return (index - buttonSeat + order.length) % order.length || order.length;
}
