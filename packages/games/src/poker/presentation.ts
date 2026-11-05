/**
 * 德州扑克的结算幕布。
 *
 * 一手结束时牌桌需要「读完成绩」：谁赢、多少钱、靠什么牌型。这些文案属于本包，
 * 通用层只负责按 `key` 播一次幕布（见 `MomentPresentationHints`），并把游戏
 * 声明的 `ledger`（每人一行：手牌、最大牌型、输赢筹码）与两个按钮画出来。
 *
 * 牌面本身不用在这里讲：摊牌时规则层已经把存活玩家的牌设成 PUBLIC，并在
 * `afterHand` 里留在桌上，幕布落幕后仍能对着牌桌核对；早结束（弃牌）时赢家还
 * 可以选择亮牌，所以「这一行能看到什么牌」由传入的 `seats[].cards` 决定——那是
 * 投影过滤后的结果，看不到的牌只会以 `hidden` 张数出现。
 */
import type { MomentLedgerRow, MomentPresentationHints, MomentPresentationState } from '@rds/kernel/module';

interface SettlementHand {
  handNo?: number;
  street?: string;
  /** 本手累计投入，边池与输赢账都靠它。 */
  handBets?: Record<string, number>;
  /** 已弃牌的座位：他们的牌进了暗弃区，结算画面不该再亮出来。 */
  folded?: string[];
  /** 已亮牌的座位（摊牌全员，早结束只有主动明牌的赢家）。 */
  revealed?: string[];
  /** 每个座位这一手实际到手多少（分池后按人记）。 */
  awarded?: Record<string, number>;
}

interface SettlementResult {
  handNo: number;
  endedBy: 'SHOWDOWN' | 'FOLD';
  pots: { amount: number; winners: string[]; label: string }[];
  showdown: { playerId: string; label: string; cards: string[] }[];
}

/** 一手结束时，一手进账相对于投入的净变化。 */
function netOf(hand: SettlementHand, last: SettlementResult, playerId: string): number {
  const invested = Number(hand.handBets?.[playerId] ?? 0);
  // 平分底池时必须拿**分到自己名下的那一份**，不能把整个池算给每个赢家：
  // 之前按 pot.amount 累加，两个赢家平分 100 的池会各自显示 +100（合计 +200，
  // 但实际只派了 100）。`hand.awarded` 是 rules.ts 派发时逐人记的权威数字。
  const awarded = Number(hand.awarded?.[playerId]);
  const won = Number.isFinite(awarded)
    ? awarded
    : last.pots.reduce((sum, pot) => sum + (pot.winners.includes(playerId) ? pot.amount : 0), 0);
  return won - invested;
}

/**
 * 结算账本：牌桌上每一行都列出来（含观察席），赢家排前面。
 *
 * 每行给三件事——底牌、最大牌型、输赢筹码——这是玩家复盘一手牌的全部依据。
 * 底牌只显示**投影允许看到的**那些（`seat.cards`）：弃牌的人牌进暗弃区、早结束
 * 的赢家没明牌时也不亮，所以这里按「弃牌 / 未亮牌 / 明牌」分别说明，而不是画
 * 一排空牌让人以为是渲染坏了。
 */
function ledgerOf(state: MomentPresentationState, hand: SettlementHand, last: SettlementResult): MomentLedgerRow[] {
  const showdown = new Map(last.showdown.map(line => [line.playerId, line]));
  const winners = new Set(last.pots.flatMap(pot => pot.winners));
  const folded = new Set(hand.folded ?? []);
  const seats = state.seats ?? [];

  const rows: MomentLedgerRow[] = seats.map(seat => {
    const net = netOf(hand, last, seat.playerId);
    const line = showdown.get(seat.playerId);
    const hasCards = (seat.cards?.length ?? 0) > 0;
    const detail = line
      ? line.label
      : folded.has(seat.playerId)
        ? '已弃牌'
        : hasCards
          ? '明牌'
          : '未亮牌';
    return {
      key: seat.playerId,
      name: seat.name,
      tag: winners.has(seat.playerId) ? '赢家' : folded.has(seat.playerId) ? '弃牌' : undefined,
      cards: seat.cards,
      hidden: seat.hidden,
      detail,
      value: `${net > 0 ? '+' : ''}${net}`,
      tone: net > 0 ? 'gain' : net < 0 ? 'loss' : 'neutral'
    };
  });

  // 赢家在前，其余按输赢排：输最多的一眼就能找到。
  const rank = (row: MomentLedgerRow) => (row.tag === '赢家' ? 2 : row.tag === '弃牌' ? 0 : 1);
  return rows.sort((a, b) => rank(b) - rank(a) || Number(b.value ?? 0) - Number(a.value ?? 0));
}

export function pokerSettlementMoment(state: MomentPresentationState): MomentPresentationHints | null {
  const hand = state.globalVars.hand as SettlementHand | undefined;
  const last = state.globalVars.lastHand as SettlementResult | undefined;
  if (!hand || hand.street !== 'COMPLETE' || !last) return null;

  const name = (pid: string): string => state.players[pid]?.name ?? pid;
  const winners = [...new Set(last.pots.flatMap(pot => pot.winners))];
  const total = last.pots.reduce((sum, pot) => sum + pot.amount, 0);
  const showdown = last.endedBy === 'SHOWDOWN';

  // 边池会有多条成绩，逐条列出比只报总额有用。
  const pots = last.pots
    .map(pot => `${pot.label || '底池'} ${pot.amount} → ${pot.winners.map(name).join('/')}`)
    .join(' · ');

  return {
    key: `poker:settle:${last.handNo}:${last.endedBy}`,
    kicker: `第 ${last.handNo} 手 · 结算`,
    caption: showdown ? '摊牌' : '弃牌结束',
    title: `${winners.map(name).join(' / ')} 赢得 ${total}`,
    story: pots || undefined,
    cast: winners.map(pid => ({ label: '赢家', name: name(pid) })),
    ledger: ledgerOf(state, hand, last),
    actions: [
      // 「继续下一局」优先**只替自己准备**（牌桌等所有人），再次是直接发牌
      // （全员已就位），最后才是「不等了」的立即开始。
      {
        id: 'next-hand',
        label: '继续下一局',
        actionTypes: ['READY', 'START_HAND', 'FORCE_START'],
        tone: 'primary',
        unavailableHint: '本手还在结算中'
      },
      // 「退出牌桌」不是内核动作：交给宿主（回大厅 / 回入口页）。
      { id: 'leave-table', label: '退出牌桌', leave: true, tone: 'danger' }
    ],
    durationMs: 4200,
    // 一手的结果至少留 10 秒给所有座位读完；期间任何手动关闭都不生效。
    closeLockMs: 10000,
    // 结算要读到玩家自己按按钮为止：没有 20 秒冷却时也要停留，不能自己消失。
    hold: true
  };
}

/**
 * 单人牌桌上「我」坐哪一号：第一个真人座位。
 *
 * 德州扑克不是观察游戏——一个人的桌子也必须先决定**自己是哪只手**。座位编制
 * 写在 `globalVars.seats`（`isAi` 标记机器座位），这里只做一件事：把第一个
 * 真人座位报给通用层，让它开局就坐在那一侧。全 AI 的桌子（观察席演示）没有
 * 主角，返回 null 保持上帝视角。
 */
export function pokerDefaultViewer(state: MomentPresentationState): string | null {
  const seats = state.globalVars.seats as { playerId?: string; isAi?: boolean }[] | undefined;
  const seat = seats?.find(entry => entry && !entry.isAi)?.playerId;
  if (!seat) return null;
  // 已进观察席（输光、离桌）的人不再是主角：投影里没有他，绑过去只会空镜。
  return state.players[seat] ? seat : null;
}
