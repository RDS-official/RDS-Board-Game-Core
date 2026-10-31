/**
 * 德州扑克的结算幕布。
 *
 * 一手结束时牌桌需要「读完成绩」：谁赢、多少钱、靠什么牌型。这些文案属于本包，
 * 通用层只负责按 `key` 播一次幕布（见 `MomentPresentationHints`）。
 *
 * 牌面本身不用在这里讲：摊牌时规则层已经把存活玩家的牌设成 PUBLIC，并在
 * `afterHand` 里留在桌上，幕布落幕后仍能对着牌桌核对。
 */
import type { MomentPresentationHints, MomentPresentationState } from '@rds/kernel/module';

interface SettlementHand {
  handNo?: number;
  street?: string;
}

interface SettlementResult {
  handNo: number;
  endedBy: 'SHOWDOWN' | 'FOLD';
  pots: { amount: number; winners: string[]; label: string }[];
  showdown: { playerId: string; label: string; cards: string[] }[];
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

  const story = showdown
    ? last.showdown
        .map(line => `${name(line.playerId)} ${line.label}${line.cards.length ? `（${line.cards.join(' ')}）` : ''}`)
        .join(' · ')
    : '其余玩家全部弃牌，赢家可选择亮牌或保留。';

  return {
    key: `poker:settle:${last.handNo}:${last.endedBy}`,
    kicker: `第 ${last.handNo} 手 · 结算`,
    caption: showdown ? '摊牌' : '弃牌结束',
    title: `${winners.map(name).join(' / ')} 赢得 ${total}`,
    story: pots ? `${story} · ${pots}` : story,
    cast: winners.map(pid => ({ label: '赢家', name: name(pid) })),
    objective: '每人点击「准备」后开下一手 · 结算满 20 秒才允许开局',
    durationMs: 4200
  };
}
