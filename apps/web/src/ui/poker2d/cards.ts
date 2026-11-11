/**
 * 德州扑克 UI 纯表现层卡牌解析与牌力评估。
 * 遵循架构分层隔离规则：UI 层不直接依赖 @rds/games 或 @rds/kernel。
 */

export type Suit = 's' | 'h' | 'd' | 'c';

export interface PokerCard {
  id: string;
  suit: Suit;
  rank: number; // 2..14 (14 = Ace)
}

export const SUIT_SYMBOL: Record<Suit, string> = {
  s: '♠',
  h: '♥',
  d: '♦',
  c: '♣'
};

const RANK_LABELS: Record<number, string> = {
  11: 'J',
  12: 'Q',
  13: 'K',
  14: 'A'
};

export function rankLabel(rank: number): string {
  return RANK_LABELS[rank] ?? String(rank);
}

/** 从实体 ID (card_s14) 或卡面文本 (A♠) 解析出扑克牌 */
export function parseCard(raw: string): PokerCard | null {
  if (!raw) return null;
  const matchId = /^card_([shdc])(\d{1,2})$/.exec(raw);
  if (matchId) {
    return { id: raw, suit: matchId[1] as Suit, rank: Number(matchId[2]) };
  }

  const matchText = /^([2-9]|10|[JQKA])([♠♥♦♣])$/.exec(raw);
  if (matchText) {
    const rStr = matchText[1];
    const sSym = matchText[2];
    const rank = rStr === 'A' ? 14 : rStr === 'K' ? 13 : rStr === 'Q' ? 12 : rStr === 'J' ? 11 : Number(rStr);
    const suit = sSym === '♠' ? 's' : sSym === '♥' ? 'h' : sSym === '♦' ? 'd' : 'c';
    return { id: `card_${suit}${rank}`, suit, rank };
  }

  return null;
}

/** 5 张手牌的基础评估 */
function evaluateFive(cards: PokerCard[]): { category: number; tiebreak: number[]; label: string } {
  const ranks = cards.map(c => c.rank).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);

  const isFlush = suits.every(s => s === suits[0]);

  // 计算连续顺子（A 可做 1：A-2-3-4-5）
  let isStraight = false;
  let straightHigh = 0;
  if (ranks[0] - ranks[4] === 4 && new Set(ranks).size === 5) {
    isStraight = true;
    straightHigh = ranks[0];
  } else if (ranks[0] === 14 && ranks[1] === 5 && ranks[2] === 4 && ranks[3] === 3 && ranks[4] === 2) {
    // Wheel (A-2-3-4-5)
    isStraight = true;
    straightHigh = 5;
  }

  // 牌点频次统计
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const byCount = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  if (isStraight && isFlush) {
    if (straightHigh === 14) return { category: 9, tiebreak: [14], label: '皇家同花顺' };
    return { category: 8, tiebreak: [straightHigh], label: `同花顺 (${rankLabel(straightHigh)}领衔)` };
  }

  if (byCount[0][1] === 4) {
    return { category: 7, tiebreak: [byCount[0][0], byCount[1][0]], label: `四条 ${rankLabel(byCount[0][0])}` };
  }

  if (byCount[0][1] === 3 && byCount[1][1] === 2) {
    return { category: 6, tiebreak: [byCount[0][0], byCount[1][0]], label: `葫芦 (${rankLabel(byCount[0][0])}满${rankLabel(byCount[1][0])})` };
  }

  if (isFlush) {
    return { category: 5, tiebreak: ranks, label: `同花 (${SUIT_SYMBOL[suits[0]]})` };
  }

  if (isStraight) {
    return { category: 4, tiebreak: [straightHigh], label: `顺子 (${rankLabel(straightHigh)}领衔)` };
  }

  if (byCount[0][1] === 3) {
    return { category: 3, tiebreak: [byCount[0][0], byCount[1][0], byCount[2][0]], label: `三条 ${rankLabel(byCount[0][0])}` };
  }

  if (byCount[0][1] === 2 && byCount[1][1] === 2) {
    return { category: 2, tiebreak: [byCount[0][0], byCount[1][0], byCount[2][0]], label: `两对 (${rankLabel(byCount[0][0])}和${rankLabel(byCount[1][0])})` };
  }

  if (byCount[0][1] === 2) {
    return { category: 1, tiebreak: [byCount[0][0], ...ranks.filter(r => r !== byCount[0][0])], label: `一对 ${rankLabel(byCount[0][0])}` };
  }

  return { category: 0, tiebreak: ranks, label: `高牌 ${rankLabel(ranks[0])}` };
}

/** 从 5~7 张牌中求最大组合的牌型 */
export function evaluateBestHand(cards: PokerCard[]): string {
  if (cards.length < 5) {
    if (cards.length >= 2) {
      if (cards[0].rank === cards[1].rank) return `底牌一对 ${rankLabel(cards[0].rank)}`;
      const h = Math.max(cards[0].rank, cards[1].rank);
      return `起手牌 ${rankLabel(h)} 领衔`;
    }
    return '';
  }

  // 组合枚举：C(N, 5)
  const len = cards.length;
  let best: { category: number; tiebreak: number[]; label: string } | null = null;

  const compare = (a: { category: number; tiebreak: number[] }, b: { category: number; tiebreak: number[] }) => {
    if (a.category !== b.category) return a.category - b.category;
    for (let i = 0; i < Math.min(a.tiebreak.length, b.tiebreak.length); i++) {
      if (a.tiebreak[i] !== b.tiebreak[i]) return a.tiebreak[i] - b.tiebreak[i];
    }
    return 0;
  };

  const comb = (start: number, chosen: PokerCard[]) => {
    if (chosen.length === 5) {
      const val = evaluateFive(chosen);
      if (!best || compare(val, best) > 0) best = val;
      return;
    }
    for (let i = start; i < len; i++) {
      chosen.push(cards[i]);
      comb(i + 1, chosen);
      chosen.pop();
    }
  };

  comb(0, []);
  return best ? (best as { label: string }).label : '';
}
