/**
 * 德州扑克的手牌事实与生涯统计（纯函数、纯 JSON）。
 *
 * 分两层：
 *
 *  - **一手的事实** `PokerHandFact`：这一手谁入过池、看没看翻牌、摊没摊牌、
 *    投入多少、赢回多少。由 `rules.ts` 在一手结算时写进 `lastHand.players`，
 *    随状态序列化与回放一起走，因此任何驱动方（服务端 / 单机）读到的事实都一致。
 *  - **生涯累计** `PokerCareer`：把一手的事实逐条折叠进账号档案。折叠是纯函数，
 *    服务端只在权威状态推进时调用，回放 / 重连不会重复计数（调用方按手数去重）。
 *
 * 口径（与业内常用定义一致，界面上会写明）：
 *  - 入池率 VPIP：**翻前自愿投钱**的手数 / 参与的手数。下盲注不算自愿。
 *  - 看翻牌率：翻牌发出时仍在牌局里的手数 / 参与的手数。
 *  - 摊牌率：走到摊牌的手数 / 参与的手数。
 *  - 胜率：赢下至少一个底池的手数 / 参与的手数。
 *  - 摊牌胜率：摊牌中赢下底池的手数 / 摊牌手数。
 */

/** 一手牌里某个座位的完整事实。 */
export interface PokerHandFact {
  playerId: string;
  /** 座位序号（0 基），观察席 / 座位卡显示用。 */
  seatIndex: number;
  /** 翻前是否自愿投钱（跟注 / 加注 / 全押），下盲注不算。 */
  vpip: boolean;
  /** 翻牌发出时是否仍在牌局里。 */
  sawFlop: boolean;
  /** 是否走到摊牌。 */
  wentToShowdown: boolean;
  /** 本手从底池赢回的筹码。 */
  wonAmount: number;
  /** 本手投入的筹码（含盲注）。 */
  invested: number;
  /** 是否赢下至少一个底池。 */
  won: boolean;
}

/** 一手牌的结算事实：谁赢、怎么结束、每个座位的数据。 */
export interface PokerHandFacts {
  handNo: number;
  endedBy: 'SHOWDOWN' | 'FOLD';
  players: PokerHandFact[];
}

/** 账号的生涯累计（服务端持久化，单机模式只用于本桌展示）。 */
export interface PokerCareer {
  hands: number;
  won: number;
  vpip: number;
  sawFlop: number;
  showdowns: number;
  showdownWins: number;
  /** 累计净输赢（赢回 - 投入）。 */
  netChips: number;
  /** 单手提走的最大底池。 */
  bestPot: number;
  /** 最近一手的时间戳（毫秒）；0 = 从未打过。 */
  updatedAt: number;
}

export const EMPTY_POKER_CAREER: PokerCareer = {
  hands: 0,
  won: 0,
  vpip: 0,
  sawFlop: 0,
  showdowns: 0,
  showdownWins: 0,
  netChips: 0,
  bestPot: 0,
  updatedAt: 0
};

/** 把一手的事实折叠进生涯累计。纯函数：不读时钟，`now` 由调用方给。 */
export function foldPokerFact(career: PokerCareer | undefined, fact: PokerHandFact, now: number): PokerCareer {
  const base = { ...EMPTY_POKER_CAREER, ...(career ?? {}) };
  return {
    hands: base.hands + 1,
    won: base.won + (fact.won ? 1 : 0),
    vpip: base.vpip + (fact.vpip ? 1 : 0),
    sawFlop: base.sawFlop + (fact.sawFlop ? 1 : 0),
    showdowns: base.showdowns + (fact.wentToShowdown ? 1 : 0),
    showdownWins: base.showdownWins + (fact.wentToShowdown && fact.won ? 1 : 0),
    netChips: base.netChips + (fact.wonAmount - fact.invested),
    bestPot: Math.max(base.bestPot, fact.wonAmount),
    updatedAt: Math.max(base.updatedAt, now)
  };
}

/** 展示用的比率；分母为 0 时返回 0（不是 NaN，界面不需要判空）。 */
export function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/** 结算所需的输入：规则层把一手的结果摊成纯数据再交给这里，避免重复口径。 */
export interface HandFactsInput {
  handNo: number;
  endedBy: 'SHOWDOWN' | 'FOLD';
  /** 座位环（`playerOrder`）：顺序决定 seatIndex。 */
  order: readonly string[];
  /** 本手拿到牌（有筹码、被发牌）的座位；旁观的观察者不在其中。 */
  dealt: readonly string[];
  /** 翻前自愿投过钱的座位。 */
  preflopVoluntary: readonly string[];
  /** 翻牌发出时仍在牌局里的座位。 */
  sawFlop: readonly string[];
  /** 走到摊牌的座位。 */
  showdown: readonly string[];
  /** 每个座位本手投入的筹码（含盲注）。 */
  handBets: Readonly<Record<string, number>>;
  /** 每个座位赢回的筹码。 */
  awarded: Readonly<Record<string, number>>;
}

/**
 * 把一手的结果摊成逐座位的统计事实。
 *
 * 只统计 `dealt` 里的座位：观察者、以及一手开始前就破产的座位不该被算成
 * 「参与过这手」——否则入池率与胜率会被旁观时间稀释。
 */
export function buildHandFacts(input: HandFactsInput): PokerHandFacts {
  const players: PokerHandFact[] = input.dealt.map(playerId => {
    const wonAmount = Math.max(0, Math.round(Number(input.awarded[playerId] ?? 0)));
    return {
      playerId,
      seatIndex: Math.max(0, input.order.indexOf(playerId)),
      vpip: input.preflopVoluntary.includes(playerId),
      sawFlop: input.sawFlop.includes(playerId),
      wentToShowdown: input.showdown.includes(playerId),
      wonAmount,
      invested: Math.max(0, Math.round(Number(input.handBets[playerId] ?? 0))),
      won: wonAmount > 0
    };
  });
  return { handNo: input.handNo, endedBy: input.endedBy, players };
}
