/**
 * 把手牌结算接进账号账本（服务端权威）。
 *
 * 分工：
 *  - 规则层（packages/games/src/poker/rules.ts）只写清**本手事实**：谁入池、
 *    谁看到翻牌、谁摊牌、谁赢了多少；
 *  - 这里负责**跨手、跨房间**的那一半：把事实折叠进账号生涯，并把桌上筹码
 *    记回账号台账。
 *
 * 为什么按「房间 + 手数」去重：`ServerMatch` 会在房间重建、断线重连、快照
 * 重放时反复观察到同一个 `lastHand`。账本只认第一次，否则胜率与余额都会虚增。
 *
 * 余额口径（与大厅「筹码排行」一致）：
 *  - 账号余额 = **还能带上桌的筹码**；
 *  - 上桌扣买入（`takeSeat`），下桌把桌上剩余退回（`leaveSeat`）；
 *  - 「全服排行」= 余额 + 正在桌上的筹码，两边不会凭空生钱，也不会丢钱。
 */
import type { PokerHandFact } from '@rds/games/poker/stats';
import { foldPokerFact } from '@rds/games/poker/stats';
import { accountOf, allAccounts, peekAccount, updateAccount } from './pokerLedger.ts';

/** 上桌买入的下限，避免 0 筹码账号占着座位。 */
export const MIN_BUY_IN = 100;

export interface SettleResult {
  handKey: string;
  /** 真正被记进生涯的账号。 */
  settled: string[];
}

/**
 * 记录一手牌。
 *
 * @param roomId  房间号：去重键的一半——同一账号可能同时在多张桌。
 * @param handNo  手数：去重键的另一半。
 * @param facts   规则层写进 `lastHand.players` 的逐座位事实。
 * @param seatToUser 座位 → 账号 id；内置 AI / 补位 AI 座位不在表里，直接跳过。
 */
export function settleHand(
  roomId: string,
  handNo: number,
  facts: readonly PokerHandFact[] | undefined,
  seatToUser: (playerId: string) => string | undefined,
  now = Date.now()
): SettleResult {
  const handKey = `${roomId}#${handNo}`;
  if (!facts || facts.length === 0 || !Number.isFinite(handNo)) return { handKey, settled: [] };

  const settled: string[] = [];
  for (const fact of facts) {
    const userId = seatToUser(fact.playerId);
    if (!userId) continue;
    const account = accountOf(userId);
    // 同一房间已经记过这一手（或更靠后的手数）：重连 / 重放不重复计数。
    if (Number(account.settledHands?.[roomId] ?? 0) >= handNo) continue;
    updateAccount(userId, current => ({
      ...current,
      career: foldPokerFact(current.career, fact, now),
      settledHands: { ...current.settledHands, [roomId]: handNo }
    }));
    settled.push(userId);
  }
  return { handKey, settled };
}

/**
 * 上桌：从余额里扣掉买入，返回真正扣到的筹码（余额不足时扣到 0）。
 *
 * 幂等：同一 `roomId` 已经押过筹码时直接返回那笔金额，不再扣第二次。
 * 服务端重启会把内存里的 `matches` 清空，但房间仍在、对局会重建——没有这层
 * 去重，每次重建都会再扣一笔买入，而旧桌上的筹码早已无人退款。
 */
export function takeSeat(userId: string, wanted: number, roomId: string): number {
  const amount = Math.max(0, Math.round(Number(wanted) || 0));
  let charged = 0;
  updateAccount(userId, current => {
    const already = current.atTable?.[roomId];
    if (already !== undefined) {
      charged = already;
      return current;
    }
    charged = Math.min(current.chips, amount);
    return {
      ...current,
      chips: current.chips - charged,
      atTable: { ...current.atTable, [roomId]: charged }
    };
  });
  return charged;
}

/**
 * 下桌：把桌上剩余筹码退回余额，并清掉该房间的押注记录。
 *
 * 幂等：房间已经退过款（`atTable` 里没有这个房间）就什么也不做，
 * 因此重复 dispose 不会把钱退两次。
 */
export function leaveSeat(userId: string, remaining: number, roomId: string): void {
  const returned = Math.max(0, Math.round(Number(remaining) || 0));
  updateAccount(userId, current => {
    if (current.atTable?.[roomId] === undefined) return current;
    const atTable = { ...current.atTable };
    delete atTable[roomId];
    return { ...current, chips: current.chips + returned, atTable };
  });
}

/**
 * 对局重建 / 进程重启后核对押注：确认这张桌已经为这些账号扣过款。
 *
 * 返回 `roomId` 里每个账号**已经**押下的金额（0 = 从没扣过）。调用方据此
 * 判断是该沿用旧买入，还是按新余额重新买入。
 */
export function stakesOnTable(roomId: string, userIds: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const userId of userIds) {
    const account = peekAccount(userId);
    out[userId] = Math.max(0, Math.round(Number(account.atTable?.[roomId] ?? 0)));
  }
  return out;
}

/** 房间彻底关闭：清掉该房间的去重账（桌已不在，手数记录没有意义了）。 */
export function forgetRoom(roomId: string): void {
  for (const account of allAccounts()) {
    const hasHands = account.settledHands?.[roomId] !== undefined;
    const hasStake = account.atTable?.[roomId] !== undefined;
    if (!hasHands && !hasStake) continue;
    updateAccount(account.userId, current => {
      const settledHands = { ...current.settledHands };
      delete settledHands[roomId];
      // atTable 由 leaveSeat 负责退款并清除；这里只兜底清掉残留的空记录。
      const atTable = { ...current.atTable };
      if (!atTable[roomId]) delete atTable[roomId];
      return { ...current, settledHands, atTable };
    });
  }
}
