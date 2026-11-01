/**
 * 德州扑克的「全服」视图：账号余额排行 + 每桌筹码 + 生涯战绩。
 *
 * 两个层次刻意分开，因为它们的可信度不同：
 *  - **本桌**：引擎投影里的筹码，精确到座位，每手都在变；
 *  - **全服**：账号账本（余额）+ 正在桌上的筹码，只有手牌结算时才写一次，
 *    因此这里把两者相加，得到「这名账号现在一共还有多少筹码」。
 *
 * 本文件只做聚合，不写账本：写账本在 `pokerSettle.ts`，读账本在 `pokerLedger.ts`。
 * 这样排行榜接口永远是无副作用的读（`peekAccount` 不会给陌生账号开新档案）。
 */
import type { PokerCareer } from '@rds/games/poker/stats';
import { ratio } from '@rds/games/poker/stats';
import type { MatchManager, ServerMatch } from './match.ts';
import { accountOf, peekAccount, type PokerAccount } from './pokerLedger.ts';
import { profileOf } from './auth.ts';

/** 排行榜一行（全服）。 */
export interface GlobalPokerRow {
  userId: string;
  name: string;
  avatarUrl?: string;
  /** 余额 + 桌上筹码。 */
  chips: number;
  /** 其中还没兑换成桌上筹码的部分。 */
  bankroll: number;
  /** 其中正在桌上的部分（多桌会相加）。 */
  onTable: number;
  peakChips: number;
  /** 0..1，占全部账号筹码的比例。 */
  share: number;
  /** 当前所在的房间号与座位（没有在玩则为空）。 */
  roomId?: string;
  seat?: string;
  /** 生涯战绩（字段名与 `UiAccountRank.stats` 对齐，前端不再做适配）。 */
  stats: PokerCareer & {
    winRate: number;
    vpipRate: number;
    sawFlopRate: number;
    showdownRate: number;
    showdownWinRate: number;
  };
}

/** 一名账号正在桌上的筹码（跨房间相加）。 */
function tableStakes(matches: MatchManager, userId: string): { chips: number; roomId?: string; seat?: string } {
  let chips = 0;
  let roomId: string | undefined;
  let seat: string | undefined;
  for (const room of matches.list()) {
    const claimed = room.seatOf(userId);
    if (!claimed) continue;
    const row = tableChipsOf(room, claimed);
    if (row === undefined) continue;
    chips += row;
    roomId = roomId ?? room.roomId;
    seat = seat ?? claimed;
  }
  return { chips, roomId, seat };
}

/** 读一桌某座位的筹码；读不到就返回 undefined（房间正在重建等）。 */
function tableChipsOf(room: ServerMatch, seat: string): number | undefined {
  try {
    const raw = room.rawState();
    const chips = Number(raw.players?.[seat]?.customProps?.chips);
    return Number.isFinite(chips) ? Math.max(0, Math.round(chips)) : undefined;
  } catch {
    return undefined;
  }
}

function careerView(career: PokerCareer) {
  return {
    ...career,
    winRate: ratio(career.won, career.hands),
    vpipRate: ratio(career.vpip, career.hands),
    sawFlopRate: ratio(career.sawFlop, career.hands),
    showdownRate: ratio(career.showdowns, career.hands),
    showdownWinRate: ratio(career.showdownWins, career.showdowns)
  };
}

function rowOf(matches: MatchManager, account: PokerAccount, total: number): GlobalPokerRow {
  const profile = profileOf(account.userId);
  const stakes = tableStakes(matches, account.userId);
  const chips = Math.max(0, account.chips + stakes.chips);
  return {
    userId: account.userId,
    name: profile?.displayName ?? profile?.name ?? account.userId,
    avatarUrl: profile?.avatarUrl,
    chips,
    bankroll: account.chips,
    onTable: stakes.chips,
    peakChips: Math.max(account.peakChips, chips),
    share: total > 0 ? chips / total : 0,
    roomId: stakes.roomId,
    seat: stakes.seat,
    stats: careerView(account.career)
  };
}

/**
 * 全服排行。
 *
 * `userIds` 是要参与排行的账号（通常是全部注册账号）。没有账本记录的账号
 * 按默认余额展示——排行榜不该因为「没打过牌」就把人藏起来，那是大厅名单的事。
 */
export function rankAccounts(matches: MatchManager, userIds: readonly string[]): GlobalPokerRow[] {
  const accounts = userIds.map(userId => peekAccount(userId));
  const total = accounts.reduce((sum, account) => {
    const stakes = tableStakes(matches, account.userId);
    return sum + Math.max(0, account.chips + stakes.chips);
  }, 0);
  return accounts
    .map(account => rowOf(matches, account, total))
    .sort((a, b) => b.chips - a.chips || a.name.localeCompare(b.name));
}

/** 单名账号的行（弹窗详情用；不打牌的人也能查到自己的档案）。 */
export function rankAccount(matches: MatchManager, userId: string): GlobalPokerRow | undefined {
  const ids = [userId];
  return rankAccounts(matches, ids)[0];
}

/** 确保账号有账本记录（第一次看排行榜 / 第一次上桌时开档）。 */
export function ensureAccount(userId: string): PokerAccount {
  return accountOf(userId);
}
