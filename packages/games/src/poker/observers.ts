import { DeterministicPRNG } from '@rds/kernel/prng';
import type { GameState, PlayerId } from '@rds/kernel/types';
import { isAiSeat } from './seating';

/**
 * 观察者席位（德州扑克）。
 *
 * 输光筹码不再结束牌局：原玩家退出座位、变成观察者，座位立刻由补位 AI 接手，
 * 牌桌始终满员。观察者保留自己的筹码账（`players[pid].customProps.chips`），
 * 低于门槛时按分钟领低保，攒够一个大盲就能申请重新上桌——换桌请求要等本轮
 * 结束才生效，避免半手牌换人把底池和行动顺序打乱。
 *
 * 所有这些都只是 `globalVars.observers` 里的纯 JSON：内核不识时钟，低保由
 * `GameModule.heartbeat` 声明的驱动方心跳派发 `OBSERVER_TICK` 推进。
 */
export interface PokerObserver {
  playerId: PlayerId;
  /** 输光时坐的座位序号（0 基），观察席显示用。 */
  seatIndex: number;
  /** 距离下一次低保已经累计的秒数。 */
  stipendSeconds: number;
  /** 已申请换桌、等待本轮结束的目标座位；null = 没有申请。 */
  pendingSeat: number | null;
  /** 变成观察者时的手数。 */
  sinceHand: number;
}

export interface PokerObserverState {
  list: PokerObserver[];
  /** 补位 AI 的递增序号，保证 playerId 不重复。 */
  aiSerial: number;
  /**
   * 低保参数。写进状态而不是让通用层 import 扑克常量，观察席卡片因此不需要
   * 认识这款游戏。
   */
  stipend: { periodSeconds: number; amount: number; threshold: number };
}

export const POKER_OBSERVER = {
  /** 观察者筹码低于这个数才有低保。 */
  stipendThreshold: 100,
  /** 每次低保发放的筹码。 */
  stipendAmount: 10,
  /** 低保周期（秒）。 */
  stipendPeriodSeconds: 60,
  /** 重新上桌的最低买入（单位：大盲）。 */
  minBuyInBlinds: 1
} as const;

export function observerStateOf(state: GameState): PokerObserverState {
  const raw = state.globalVars.observers as PokerObserverState | undefined;
  if (raw && Array.isArray(raw.list)) {
    return {
      aiSerial: Number.isFinite(Number(raw.aiSerial)) ? Number(raw.aiSerial) : 0,
      list: raw.list,
      stipend: raw.stipend ?? {
        periodSeconds: POKER_OBSERVER.stipendPeriodSeconds,
        amount: POKER_OBSERVER.stipendAmount,
        threshold: POKER_OBSERVER.stipendThreshold
      }
    };
  }
  return {
    aiSerial: 0,
    list: [],
    stipend: {
      periodSeconds: POKER_OBSERVER.stipendPeriodSeconds,
      amount: POKER_OBSERVER.stipendAmount,
      threshold: POKER_OBSERVER.stipendThreshold
    }
  };
}

export function withObserverState(state: GameState, observers: PokerObserverState): GameState {
  return { ...state, globalVars: { ...state.globalVars, observers } };
}

export function observerOf(state: GameState, playerId: PlayerId): PokerObserver | undefined {
  return observerStateOf(state).list.find(entry => entry.playerId === playerId);
}

/**
 * 随机挑一个 AI 座位。用状态里的 PRNG，所以「随机」在回放里是确定的。
 */
export function pickAiSeat(state: GameState): { seat: number; nextSeed: number } | null {
  const candidates = state.playerOrder
    .map((pid, seat) => ({ pid, seat }))
    .filter(entry => isAiSeat(state, entry.pid));
  if (candidates.length === 0) return null;
  const shuffled = DeterministicPRNG.shuffle(state.prngState, candidates);
  return { seat: shuffled.result[0].seat, nextSeed: shuffled.nextSeed };
}
