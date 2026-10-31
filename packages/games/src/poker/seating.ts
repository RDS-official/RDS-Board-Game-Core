import type { GameState, PlayerId } from '@rds/kernel/types';

/**
 * 座位 / 就绪 / AI 补位（德州扑克）。
 *
 * 设计约束：内核只有 `setup(seed)`，没有「加入座位」这种外部事件通道，
 * 因此座位管理只能是**夹具层的一次性配置 + 局内动作**：
 *
 *  - `setupPoker` 按配置决定真人座位与 AI 座位（AI 数量 0–10，等级分布固定）；
 *  - `state.globalVars.seating` 记录真人是否已入座、是否已准备；
 *  - 全员准备后 `START_HAND` 才被放行（见 `PokerRules.getLegalActions`）。
 *
 * 这样「玩家点击入座 → 显示准备按钮 → 全员准备开局」是一条纯状态机路径，
 * 不需要内核新增 API，也不会破坏 replay/序列化。
 */

export type PokerAiTier = 'beginner' | 'intermediate' | 'advanced';

/**
 * 内置 AI 编制：10 个座位 = 1 初级 + 4 中级 + 5 高级。
 *
 * 顺序刻意从**弱到强**排：人少的桌先取用初级与中级，满桌才坐满 5 个高级，
 * 这样「6 人桌」不会一上来全是高级 AI。
 */
export const POKER_AI_ROSTER: readonly PokerAiTier[] = [
  'beginner',
  'intermediate',
  'intermediate',
  'intermediate',
  'intermediate',
  'advanced',
  'advanced',
  'advanced',
  'advanced',
  'advanced'
];

/** 编制校验：1 初级 + 4 中级 + 5 高级，合计 10。 */
export const POKER_AI_MIX = { beginner: 1, intermediate: 4, advanced: 5 } as const;

/** AI 按等级取的不同风格参数（越大越激进）。 */
export const AI_PROFILE: Record<PokerAiTier, { label: string; aggression: number; looseness: number }> = {
  beginner: { label: '初级', aggression: 0.18, looseness: 0.62 },
  intermediate: { label: '中级', aggression: 0.42, looseness: 0.4 },
  advanced: { label: '高级', aggression: 0.72, looseness: 0.24 }
};

export const POKER_TABLE = {
  /** 一桌至少 6 人；真人不足时用 AI 补到 6。 */
  minPlayers: 6,
  maxPlayers: 10
} as const;

export interface SeatAssignment {
  playerId: PlayerId;
  isAi: boolean;
  aiTier?: PokerAiTier;
  aiLabel?: string;
}

export interface SeatingState {
  /** 真人座位（本夹具固定为 p1，联机时由服务端按房间顺序决定）。 */
  humanSeats: PlayerId[];
  aiSeats: PlayerId[];
  /** 真人是否已入座（点了「入座」）。 */
  seated: Record<string, boolean>;
  /** 已准备的座位。全员准备后开局。 */
  ready: Record<string, boolean>;
  /** 本手是否已经开始过（用于「还没入座不许开局」的判断）。 */
  started: boolean;
}

/**
 * 计算本桌的实际编制：`humans` 个真人 + AI 补位到 `target`。
 * AI 按 POKER_AI_ROSTER 的顺序取用，保证等级分布稳定可测。
 */
export function planSeats(humans: number, target: number = POKER_TABLE.minPlayers): {
  total: number;
  seats: SeatAssignment[];
} {
  const humanCount = Math.max(1, Math.floor(humans));
  const total = Math.min(
    POKER_TABLE.maxPlayers,
    Math.max(POKER_TABLE.minPlayers, Math.floor(target), humanCount)
  );
  const aiCount = Math.max(0, total - humanCount);
  const seats: SeatAssignment[] = [];
  for (let index = 0; index < humanCount; index++) {
    seats.push({ playerId: `p${index + 1}`, isAi: false });
  }
  for (let index = 0; index < aiCount; index++) {
    const tier = POKER_AI_ROSTER[index % POKER_AI_ROSTER.length];
    seats.push({
      playerId: `p${humanCount + index + 1}`,
      isAi: true,
      aiTier: tier,
      aiLabel: `${AI_PROFILE[tier].label} AI`
    });
  }
  return { total, seats };
}

/** 从状态里读座位编制（缺省视为全真人，兼容旧对局与测试）。 */
export function seatsOf(state: GameState): SeatAssignment[] {
  const seating = state.globalVars.seating as SeatingState | undefined;
  const raw = state.globalVars.seats as SeatAssignment[] | undefined;
  if (raw && raw.length > 0) return raw;
  if (seating) {
    return [
      ...seating.humanSeats.map(playerId => ({ playerId, isAi: false })),
      ...seating.aiSeats.map(playerId => ({ playerId, isAi: true }))
    ];
  }
  return state.playerOrder.map(playerId => ({ playerId, isAi: false }));
}

export function isAiSeat(state: GameState, playerId: PlayerId): boolean {
  const raw = state.globalVars.seats as SeatAssignment[] | undefined;
  if (raw) return !!raw.find(seat => seat.playerId === playerId)?.isAi;
  const npc = state.npcs?.[playerId];
  return !!npc;
}

export function aiTierOf(state: GameState, playerId: PlayerId): PokerAiTier | undefined {
  const raw = state.globalVars.seats as SeatAssignment[] | undefined;
  return raw?.find(seat => seat.playerId === playerId)?.aiTier;
}

/** 真人座位是否已入座。 */
export function isSeated(state: GameState, playerId: PlayerId): boolean {
  const seating = state.globalVars.seating as SeatingState | undefined;
  if (!seating) return true; // 旧对局 / 测试：没有座位概念，视为已入座
  return !!seating.seated[playerId];
}

export function isReady(state: GameState, playerId: PlayerId): boolean {
  const seating = state.globalVars.seating as SeatingState | undefined;
  if (!seating) return true;
  return !!seating.ready[playerId];
}

export function seatingOf(state: GameState): SeatingState | undefined {
  return state.globalVars.seating as SeatingState | undefined;
}
