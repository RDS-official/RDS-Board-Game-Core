import type { Card } from './cards';

/**
 * 5-of-7 poker hand evaluation.
 *
 * Pure and stateless: `evaluateSeven` enumerates the 21 five-card subsets of
 * the 2 hole cards + 5 community cards and keeps the best one. Table-driven
 * lookup would be faster, but 21 comparisons per showdown is irrelevant next to
 * being obviously correct — and this module must never read the game state.
 */

export const HIGH_CARD = 0;
export const PAIR = 1;
export const TWO_PAIR = 2;
export const THREE_OF_A_KIND = 3;
export const STRAIGHT = 4;
export const FLUSH = 5;
export const FULL_HOUSE = 6;
export const FOUR_OF_A_KIND = 7;
export const STRAIGHT_FLUSH = 8;

const CATEGORY_LABEL: Record<number, string> = {
  [HIGH_CARD]: '高牌',
  [PAIR]: '一对',
  [TWO_PAIR]: '两对',
  [THREE_OF_A_KIND]: '三条',
  [STRAIGHT]: '顺子',
  [FLUSH]: '同花',
  [FULL_HOUSE]: '葫芦',
  [FOUR_OF_A_KIND]: '四条',
  [STRAIGHT_FLUSH]: '同花顺'
};

export interface HandValue {
  /** 0 (high card) … 8 (straight flush); higher wins. */
  category: number;
  /** Descending comparison keys inside the category. */
  tiebreak: number[];
  /** Chinese category name for broadcasts and the HUD. */
  label: string;
}

/**
 * Highest straight top-card among `ranks`, or 0 when there is no straight.
 * The ace counts both ways: `A-2-3-4-5` is a five-high straight.
 */
function straightHighOf(ranks: readonly number[]): number {
  const unique = new Set(ranks);
  if (unique.has(14)) unique.add(1);
  const sorted = [...unique].sort((a, b) => a - b);
  let run = 1;
  let best = 0;
  for (let i = 1; i < sorted.length; i++) {
    run = sorted[i] === sorted[i - 1] + 1 ? run + 1 : 1;
    if (run >= 5) best = sorted[i];
  }
  return best;
}

/** Rank groups, ordered by multiplicity first and rank second (both descending). */
function rankGroups(cards: readonly Card[]): [number, number][] {
  const counts = new Map<number, number>();
  for (const card of cards) counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
}

/** Kickers of a hand whose largest group is already consumed. */
function kickers(groups: readonly [number, number][], skip: number, take: number): number[] {
  return groups
    .slice(skip)
    .filter(([, count]) => count === 1)
    .map(([rank]) => rank)
    .sort((a, b) => b - a)
    .slice(0, take);
}

export function evaluateFive(cards: readonly Card[]): HandValue {
  if (cards.length !== 5) throw new Error(`evaluateFive needs 5 cards, got ${cards.length}`);
  const groups = rankGroups(cards);
  const ranks = cards.map(card => card.rank).sort((a, b) => b - a);
  const flush = cards.every(card => card.suit === cards[0].suit);
  const straightHigh = straightHighOf(ranks);

  if (flush && straightHigh > 0) {
    return {
      category: STRAIGHT_FLUSH,
      tiebreak: [straightHigh],
      label: straightHigh === 14 ? '皇家同花顺' : CATEGORY_LABEL[STRAIGHT_FLUSH]
    };
  }
  if (groups[0][1] === 4) {
    return {
      category: FOUR_OF_A_KIND,
      tiebreak: [groups[0][0], ...kickers(groups, 1, 1)],
      label: CATEGORY_LABEL[FOUR_OF_A_KIND]
    };
  }
  if (groups[0][1] === 3 && groups[1]?.[1] === 2) {
    return {
      category: FULL_HOUSE,
      tiebreak: [groups[0][0], groups[1][0]],
      label: CATEGORY_LABEL[FULL_HOUSE]
    };
  }
  if (flush) {
    return { category: FLUSH, tiebreak: ranks, label: CATEGORY_LABEL[FLUSH] };
  }
  if (straightHigh > 0) {
    return { category: STRAIGHT, tiebreak: [straightHigh], label: CATEGORY_LABEL[STRAIGHT] };
  }
  if (groups[0][1] === 3) {
    return {
      category: THREE_OF_A_KIND,
      tiebreak: [groups[0][0], ...kickers(groups, 1, 2)],
      label: CATEGORY_LABEL[THREE_OF_A_KIND]
    };
  }
  if (groups[0][1] === 2 && groups[1]?.[1] === 2) {
    return {
      category: TWO_PAIR,
      tiebreak: [groups[0][0], groups[1][0], ...kickers(groups, 2, 1)],
      label: CATEGORY_LABEL[TWO_PAIR]
    };
  }
  if (groups[0][1] === 2) {
    return {
      category: PAIR,
      tiebreak: [groups[0][0], ...kickers(groups, 1, 3)],
      label: CATEGORY_LABEL[PAIR]
    };
  }
  return { category: HIGH_CARD, tiebreak: ranks, label: CATEGORY_LABEL[HIGH_CARD] };
}

/** Compare two evaluated hands: >0 when `a` wins, <0 when `b` wins, 0 on a tie. */
export function compareHands(a: HandValue, b: HandValue): number {
  if (a.category !== b.category) return a.category - b.category;
  const length = Math.max(a.tiebreak.length, b.tiebreak.length);
  for (let i = 0; i < length; i++) {
    const left = a.tiebreak[i] ?? 0;
    const right = b.tiebreak[i] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

/** Best five-card hand out of the 5..7 cards available at showdown. */
export function evaluateSeven(cards: readonly Card[]): HandValue {
  if (cards.length < 5) throw new Error(`evaluateSeven needs at least 5 cards, got ${cards.length}`);
  if (cards.length === 5) return evaluateFive(cards);

  let best: HandValue | null = null;
  for (let a = 0; a < cards.length - 4; a++) {
    for (let b = a + 1; b < cards.length - 3; b++) {
      for (let c = b + 1; c < cards.length - 2; c++) {
        for (let d = c + 1; d < cards.length - 1; d++) {
          for (let e = d + 1; e < cards.length; e++) {
            const candidate = evaluateFive([cards[a], cards[b], cards[c], cards[d], cards[e]]);
            if (!best || compareHands(candidate, best) > 0) best = candidate;
          }
        }
      }
    }
  }
  return best as HandValue;
}
