import type { GameState, PlayerId } from '@rds/kernel/types';
import type { Action } from '@rds/kernel/types';
import { toCall, minRaiseTo, mayRaise, type BettingState } from './betting';
import { cardOfEntity, holeCards, type Card } from './cards';
import { evaluateSeven, evaluateFive } from './handEval';
import { AI_PROFILE, aiTierOf, type PokerAiTier } from './seating';

/**
 * 内置 AI 策略（德州扑克）。
 *
 * 约束：策略是**状态 → 动作**的纯函数，不持有随机数实例（内核禁止把可变
 * 随机源放进状态）。随机性来自 `state.prngState` 派生的决定论哈希，
 * 因此同一份状态 + 同一个 seed 永远给出同一个动作，replay 完全可复现。
 *
 * 三档差异只体现在两个参数上（见 seating.ts 的 AI_PROFILE）：
 *  - `aggression`：拿到强牌时加注的频率与幅度；
 *  - `looseness`：愿意用多宽的起手牌继续看牌。
 */

/** 从状态派生的确定性 0..1 小数（不污染 prngState，只读）。 */
function noise(state: GameState, playerId: PlayerId, salt: number): number {
  const key = `${state.prngState}:${state.seq}:${state.turn}:${playerId}:${salt}:${state.globalVars.hand?.handNo ?? 0}`;
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash / 4294967296;
}

type Strength = 'trash' | 'weak' | 'medium' | 'strong' | 'monster';

/**
 * 牌力估计：翻前按起手牌粗分，翻后按当前最佳成手牌分档。
 * 只看自己的底牌 + 公共牌（合法信息），不窥探牌堆。
 */
function strengthOf(state: GameState, playerId: PlayerId): { strength: Strength; score: number } {
  const hole = holeCards(state, playerId);
  if (hole.length === 0) return { strength: 'trash', score: 0 };

  const hand = state.globalVars.hand as (BettingState & { community: string[] }) | undefined;
  const community: Card[] = (hand?.community ?? [])
    .map((id: string) => cardOfEntity(state.entities[id]))
    .filter((card): card is Card => card !== null);

  // 翻前：只按底牌强度（对子 > 高牌相连 > 高牌）。
  if (community.length === 0) {
    const [a, b] = hole;
    const pair = a.rank === b.rank;
    const high = Math.max(a.rank, b.rank);
    const low = Math.min(a.rank, b.rank);
    const suited = a.suit === b.suit;
    const connected = Math.abs(a.rank - b.rank) <= 2;

    if (pair && high >= 10) return { strength: 'strong', score: 0.86 };
    if (pair && high >= 7) return { strength: 'medium', score: 0.62 };
    if (pair) return { strength: 'weak', score: 0.45 };
    if (high === 14 && low >= 10) return { strength: suited || connected ? 'strong' : 'medium', score: suited ? 0.8 : 0.6 };
    if (high >= 12 && suited) return { strength: 'medium', score: 0.58 };
    if (high >= 13) return { strength: 'weak', score: 0.42 };
    if (suited && connected) return { strength: 'weak', score: 0.38 };
    return { strength: 'trash', score: 0.16 };
  }

  // 翻后：走真实牌型评估。category 是 0..8：
  // 0 高牌 · 1 一对 · 2 两对 · 3 三条 · 4 顺子 · 5 同花 · 6 葫芦 · 7 四条 · 8 同花顺
  const all = [...hole, ...community];
  const value = all.length >= 7 ? evaluateSeven(all) : evaluateFive(all.slice(0, 5));
  const category = value.category;
  if (category >= 6) return { strength: 'monster', score: 0.97 }; // 葫芦及以上
  if (category === 5) return { strength: 'monster', score: 0.93 }; // 同花
  if (category === 4) return { strength: 'strong', score: 0.89 }; // 顺子
  if (category === 3) return { strength: 'strong', score: 0.84 }; // 三条
  if (category === 2) return { strength: 'medium', score: 0.72 }; // 两对
  if (category === 1) {
    // 一对：顶对/超对更像真实价值，小对子要保守一点。
    const pairRank = value.tiebreak[0] ?? 0;
    return pairRank >= 10
      ? { strength: 'medium', score: 0.66 }
      : { strength: 'weak', score: 0.5 };
  }
  // 纯高牌：只有 A 高时才勉强算弱牌，其余按垃圾处理。
  const high = value.tiebreak[0] ?? 0;
  return high >= 13 ? { strength: 'weak', score: 0.36 } : { strength: 'trash', score: 0.22 };
}

/**
 * 选择动作。返回 null 表示「不行动」（调用方会跳过该座位）。
 * 一定会返回一个合法动作，绝不返回非法动作——合法性由内核兜底校验。
 */
export function choosePokerAction(state: GameState, playerId: PlayerId): Action | null {
  const hand = state.globalVars.hand as
    | (BettingState & { street: string; folded: string[]; allIn: string[] })
    | undefined;
  if (!hand) return null;
  if (hand.street === 'COMPLETE') {
    // 本手结束：由当前主动作玩家开下一手；AI 直接开。
    return state.activePlayerId === playerId ? { type: 'START_HAND', playerId } : null;
  }
  if (state.activePlayerId !== playerId) return null;
  if (hand.folded.includes(playerId) || hand.allIn.includes(playerId)) return null;

  const tier: PokerAiTier = aiTierOf(state, playerId) ?? 'intermediate';
  const profile = AI_PROFILE[tier];
  const chips = Number(state.players[playerId]?.customProps?.chips ?? 0);
  if (chips <= 0) return null;

  const owed = toCall(hand, playerId);
  const { strength, score } = strengthOf(state, playerId);
  const roll = noise(state, playerId, 1);
  const raiseRoll = noise(state, playerId, 2);

  // 决策：垃圾牌大多弃牌，除非免费看牌。
  if (strength === 'trash') {
    if (owed <= 0) return { type: 'CHECK', playerId };
    const bluff = roll < profile.aggression * 0.12;
    if (bluff && mayRaise(hand, playerId)) {
      const minimum = minRaiseTo(hand);
      const maxRaiseTo = (hand.streetBets[playerId] ?? 0) + chips;
      if (minimum <= maxRaiseTo) {
        const target = Math.min(maxRaiseTo, minimum);
        return { type: 'RAISE', playerId, payload: { amount: Math.round(target) } };
      }
    }
    return { type: 'FOLD', playerId };
  }

  // 弱牌：便宜的跟注可以进，否则弃。
  if (strength === 'weak') {
    if (owed <= 0) return { type: 'CHECK', playerId };
    const cheap = owed <= Math.max(1, Math.round(chips * 0.06));
    if (cheap || roll < profile.looseness * 0.6) {
      if (owed >= chips) return { type: 'ALL_IN', playerId };
      return { type: 'CALL', playerId, payload: { amount: owed } };
    }
    return { type: 'FOLD', playerId };
  }

  // 中/强/怪物牌：以加注为主，激进程度决定加注频率。
  const wantsRaise = raiseRoll < profile.aggression;
  const maxRaiseTo = (hand.streetBets[playerId] ?? 0) + chips;
  const minimum = minRaiseTo(hand);

  if (wantsRaise && mayRaise(hand, playerId) && minimum <= maxRaiseTo) {
    // 强度越高，加注越往底池倍数走；高级 AI 更敢做大尺寸。
    const potSize = Object.values(hand.streetBets).reduce((sum, value) => sum + value, 0);
    const scale = strength === 'monster' ? 1.6 : strength === 'strong' ? 1.1 : 0.7;
    const sized = Math.round((potSize || hand.bigBlind * 2) * scale);
    const target = Math.max(minimum, Math.min(maxRaiseTo, sized));
    // 接近全押就直接推光，省得留一条零碎筹码。
    if (maxRaiseTo - target < hand.bigBlind) return { type: 'ALL_IN', playerId };
    return { type: 'RAISE', playerId, payload: { amount: target } };
  }

  if (owed <= 0) return { type: 'CHECK', playerId };
  if (owed >= chips) return { type: 'ALL_IN', playerId };
  return { type: 'CALL', playerId, payload: { amount: owed } };
}

/**
 * 「全服排名」用的筹码占比数据。
 *
 * 注：这是**本桌**的筹码占比。真正的「全服」跨局排名需要服务端持久化，
 * 见 apps/server 的 match 层；夹具层只提供本桌的实时数据，作为 UI 的
 * 默认来源与离线单机时的降级显示。
 */
export interface ChipShare {
  playerId: string;
  name: string;
  chips: number;
  share: number;
  isAi: boolean;
  tierLabel?: string;
}

export function chipShares(state: GameState): ChipShare[] {
  const raw = state.globalVars.seats as
    | { playerId: string; isAi: boolean; aiTier?: PokerAiTier }[]
    | undefined;
  const seated = new Map((raw ?? []).map(seat => [seat.playerId, seat]));
  const rows = state.playerOrder.map(playerId => {
    const player = state.players[playerId];
    const chips = Number(player?.customProps?.chips ?? 0);
    const seat = seated.get(playerId);
    const tier = seat?.aiTier;
    return {
      playerId,
      name: player?.name ?? playerId,
      chips,
      share: 0,
      isAi: !!seat?.isAi,
      tierLabel: tier ? AI_PROFILE[tier].label : undefined
    };
  });
  const total = rows.reduce((sum, row) => sum + row.chips, 0);
  for (const row of rows) row.share = total > 0 ? row.chips / total : 0;
  return rows.sort((a, b) => b.chips - a.chips);
}
