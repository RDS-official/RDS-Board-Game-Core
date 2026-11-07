import type { MomentPresentationHints, MomentPresentationState } from '@rds/kernel/module';
import type { SgsCardCustom } from './types';

const ROLE_LABELS: Record<string, string> = {
  LORD: '主公',
  LOYALIST: '忠臣',
  REBEL: '反贼',
  SPY: '内奸',
  TEAM_A: '赤方',
  TEAM_B: '蓝方',
  KILL_NEXT: '杀下家'
};

const MODE_LABELS: Record<string, string> = {
  identity: '身份局',
  team: '4人对抗',
  kill_next: '杀下家村规'
};

const CATEGORY_LABELS: Record<string, string> = {
  BASIC: '基本牌',
  TRICK: '锦囊牌',
  DELAYED: '延时锦囊',
  EQUIP: '装备牌'
};

const SUBTYPE_LABELS: Record<string, string> = {
  STRIKE: '杀',
  DODGE: '闪',
  PEACH: '桃',
  WINE: '酒',
  DISMANTLE: '过河拆桥',
  SNATCH: '顺手牵羊',
  DUEL: '决斗',
  BORROW_SWORD: '借刀杀人',
  EX_NIHILO: '无中生有',
  NULLIFY: '无懈可击',
  BARBARIAN: '南蛮入侵',
  ARROW: '万箭齐发',
  PEACH_GARDEN: '桃园结义',
  HARVEST: '五谷丰登',
  IRON_CHAIN: '铁索连环',
  FIRE_ATTACK: '火攻',
  INDULGENCE: '乐不思蜀',
  LIGHTNING: '闪电',
  SUPPLY_SHORTAGE: '兵粮寸断',
  WEAPON: '武器',
  ARMOR: '防具',
  HORSE_PLUS: '+1坐骑',
  HORSE_MINUS: '-1坐骑',
  TREASURE: '宝物'
};

const EQUIP_SLOT_LABELS: Record<string, string> = {
  WEAPON: '武器槽',
  ARMOR: '防具槽',
  HORSE_PLUS: '+1坐骑槽',
  HORSE_MINUS: '-1坐骑槽',
  TREASURE: '宝物槽'
};

export function sanguoshaRoleLabel(role: string): string | null {
  return ROLE_LABELS[role] ?? null;
}

/** Local first-person seat: the first human in the table assignment. */
export function sanguoshaDefaultViewer(state: MomentPresentationState): string | null {
  const seats = state.globalVars.seats as { playerId?: string; isAi?: boolean }[] | undefined;
  const human = seats?.find(seat => !seat.isAi && seat.playerId);
  return human?.playerId ?? Object.keys(state.players)[0] ?? null;
}

export function sanguoshaCardFacts(custom: Record<string, unknown>): { label: string; value: string }[] {
  const card = custom as Partial<SgsCardCustom>;
  const facts: { label: string; value: string }[] = [];
  if (card.category) facts.push({ label: '类别', value: CATEGORY_LABELS[card.category] ?? card.category });
  if (card.subtype) facts.push({ label: '牌名', value: SUBTYPE_LABELS[card.subtype] ?? card.subtype });
  if (card.suit || card.rank) facts.push({ label: '花色 / 点数', value: `${card.suit ?? ''}${card.rank ?? ''}` });
  if (card.equipSlot) facts.push({ label: '装备位', value: EQUIP_SLOT_LABELS[card.equipSlot] ?? card.equipSlot });
  if (card.range !== undefined) facts.push({ label: '攻击范围', value: String(card.range) });
  if (card.element && card.element !== 'NORMAL') facts.push({ label: '伤害属性', value: card.element === 'FIRE' ? '火焰' : '雷电' });
  return facts;
}

export function sanguoshaCardStyle(custom: Record<string, unknown>): {
  badge?: string;
  tone?: string;
  seal?: string;
} {
  const card = custom as Partial<SgsCardCustom>;
  const category = card.category ? CATEGORY_LABELS[card.category] ?? card.category : '游戏牌';
  const subtype = card.subtype ? SUBTYPE_LABELS[card.subtype] ?? card.subtype : '';
  const tone = card.category === 'EQUIP' ? 'treasure' : card.category === 'BASIC' ? 'danger' : card.category === 'DELAYED' ? 'place' : 'event';
  const seal = card.category === 'BASIC' ? '武' : card.category === 'EQUIP' ? '器' : card.category === 'DELAYED' ? '候' : '谋';
  return {
    badge: subtype ? `${category} · ${subtype}` : category,
    tone,
    seal
  };
}

export function sanguoshaDescribeMoment(state: MomentPresentationState): MomentPresentationHints | null {
  const finalWinner = state.globalVars.finalWinner;
  if (finalWinner === undefined || finalWinner === null) return null;
  const winnerIds = Array.isArray(finalWinner) ? finalWinner.map(String) : [String(finalWinner)];
  const winnerNames = winnerIds.map(pid => state.players[pid]?.name ?? pid);
  const reason = String(state.globalVars.finalReason ?? '已分出胜负');
  const mode = String(state.globalVars.mode ?? 'identity');
  const modeLabel = MODE_LABELS[mode] ?? '身份局';
  const deltas = (state.globalVars.scoreDeltas ?? {}) as Record<string, number>;
  const cast = Object.entries(state.players).map(([pid, player]) => {
    const delta = Number(deltas[pid] ?? 0);
    return {
      label: `${ROLE_LABELS[player.role ?? ''] ?? player.role ?? '身份'}${player.alive ? '' : ' · 阵亡'}${
        delta === 0 ? '' : ` · ${delta > 0 ? '+' : ''}${delta} 分`
      }`,
      name: player.name ?? pid
    };
  });
  const ledger = Object.entries(state.players).map(([pid, player]) => {
    const delta = Number(deltas[pid] ?? 0);
    return {
      key: pid,
      name: player.name ?? pid,
      tag: winnerIds.includes(pid) ? '胜' : '负',
      detail: ROLE_LABELS[player.role ?? ''] ?? player.role ?? '身份',
      value: `${delta > 0 ? '+' : ''}${delta}`,
      tone: delta > 0 ? ('gain' as const) : delta < 0 ? ('loss' as const) : ('neutral' as const)
    };
  });
  return {
    key: `sanguosha-final-${winnerIds.join('-')}-${reason}`,
    kicker: `三国杀 · ${modeLabel}`,
    caption: 'FINAL VERDICT',
    title: '胜负已分',
    story: `${winnerNames.join('、')} 达成了${mode === 'identity' ? '自己的身份目标' : mode === 'team' ? '阵营目标' : '杀下家目标'}。${reason}`,
    cast,
    ledger,
    objective: reason,
    durationMs: 12_000,
    hold: true
  };
}
