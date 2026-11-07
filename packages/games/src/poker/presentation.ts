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
import type {
  MomentLedgerRow,
  MomentPresentationHints,
  MomentPresentationState,
  PlayerViewHints,
  RankedPlayerViewHint
} from '@rds/kernel/module';
import type { Player, ProjectedGameState } from '@rds/kernel/types';

const TIER_LABEL: Record<string, string> = { beginner: '初级', intermediate: '中级', advanced: '高级' };

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

interface PokerHandView {
  street?: string;
  pot?: number;
  streetBets?: Record<string, number>;
  currentBet?: number;
  buttonSeat?: number;
  handNo?: number;
  sbSeat?: number;
  bbSeat?: number;
  folded?: string[];
  allIn?: string[];
}

export function pokerPhaseLabel(state: ProjectedGameState): string {
  const hand = state.globalVars.hand as PokerHandView | undefined;
  if (!hand) return 'HAND OVER · 等待发牌';
  const street = hand.street ?? 'COMPLETE';
  if (street === 'COMPLETE') return `HAND OVER · 第 ${Number(hand.handNo ?? 0) + 1} 手待发`;
  const streetLabels: Record<string, string> = {
    PREFLOP: 'PRE-FLOP · 翻前',
    FLOP: 'FLOP · 翻牌圈',
    TURN: 'TURN · 转牌圈',
    RIVER: 'RIVER · 河牌圈'
  };
  const streetChips = Object.values(hand.streetBets ?? {}).reduce((sum, amount) => sum + Number(amount ?? 0), 0);
  const pot = Number(hand.pot ?? 0) + streetChips;
  const mine = Number(hand.streetBets?.[state.viewerId] ?? 0);
  const owed = Math.max(0, Number(hand.currentBet ?? 0) - (Number.isFinite(mine) ? mine : 0));
  return `${streetLabels[street] ?? street} · 底池 ${pot} · 需跟 ${owed}`;
}

export function pokerMissionLine(state: ProjectedGameState): string {
  const hand = state.globalVars.hand as { handNo?: number; buttonSeat?: number } | undefined;
  const config = state.globalVars.config as
    | { startingStack?: number; smallBlind?: number; bigBlind?: number }
    | undefined;
  const last = state.globalVars.lastHand as
    | { pots?: { amount: number; winners: string[] }[]; endedBy?: string }
    | null
    | undefined;
  const buttonId = state.playerOrder[Number(hand?.buttonSeat ?? 0)];
  const bits = [
    `盲注 ${Number(config?.smallBlind ?? 5)} / ${Number(config?.bigBlind ?? 10)}`,
    `初始 ${Number(config?.startingStack ?? 1000)}`,
    `第 ${Number(hand?.handNo ?? 0)} 手`,
    buttonId ? `庄家 ${state.players[buttonId]?.name ?? buttonId}` : null
  ].filter(Boolean) as string[];
  const pots = last?.pots ?? [];
  if (pots.length > 0) {
    const winners = [...new Set(pots.flatMap(pot => pot.winners.map(pid => state.players[pid]?.name ?? pid)))];
    const total = pots.reduce((sum, pot) => sum + Number(pot.amount ?? 0), 0);
    bits.push(`上一手：${winners.join(' / ')} 赢得 ${total}`);
  }
  return bits.join(' · ');
}

export function pokerPlayerView(player: Player, state: ProjectedGameState): PlayerViewHints {
  const hand = state.globalVars.hand as PokerHandView | undefined;
  const chips = Number(player.customProps.chips ?? 0);
  const seat = Number(player.customProps.seat ?? -1);
  const streetBet = Number(hand?.streetBets?.[player.id] ?? 0);
  const folded = hand?.folded?.includes(player.id) ?? false;
  const allIn = hand?.allIn?.includes(player.id) ?? false;
  const marks: string[] = [];
  if (hand?.buttonSeat === seat) marks.push('D 庄家');
  if (hand?.sbSeat === seat) marks.push('SB');
  if (hand?.bbSeat === seat) marks.push('BB');
  return {
    score: chips,
    scoreLabel: '筹码',
    pips: [
      { color: player.color, label: '筹码', short: '筹码', value: String(chips) },
      ...(streetBet > 0
        ? [{ color: '#e3b341', label: '本街已下注', short: '注', value: String(streetBet) }]
        : [])
    ],
    stats: [
      { label: '位置', value: marks.length > 0 ? marks.join(' · ') : '—' },
      {
        label: '状态',
        value: folded
          ? '🏳️ 已弃牌'
          : allIn
            ? '💥 全押'
            : chips <= 0
              ? '💀 已出局'
              : hand?.street === 'COMPLETE'
                ? '等待下一手'
                : '在手牌中'
      }
    ]
  };
}

export function pokerRankedPlayers(state: ProjectedGameState): RankedPlayerViewHint[] {
  const seats = state.globalVars.seats as { playerId: string; isAi: boolean; aiTier?: string }[] | undefined;
  const seatOf = new Map((seats ?? []).map(seat => [seat.playerId, seat]));
  const rows = state.playerOrder.map(playerId => {
    const player = state.players[playerId];
    const chips = Number(player?.customProps?.chips ?? 0);
    const seat = seatOf.get(playerId);
    const tier = seat?.aiTier;
    return {
      playerId,
      name: player?.name ?? playerId,
      value: chips,
      share: 0,
      isAi: !!seat?.isAi,
      tierLabel: tier ? TIER_LABEL[tier] ?? tier : undefined
    };
  });
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  for (const row of rows) row.share = total > 0 ? row.value / total : 0;
  return rows.sort((a, b) => b.value - a.value);
}
