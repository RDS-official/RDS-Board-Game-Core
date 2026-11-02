import { ECSManager } from '@rds/kernel/ecs';
import type { ReduceContext } from '@rds/kernel/module';
import { DeterministicPRNG } from '@rds/kernel/prng';
import { CognitiveObserver } from '@rds/kernel/observer';
import type { Action, GameState, Player, PlayerId, VisibilityRule } from '@rds/kernel/types';
import {
  buildPots,
  isRoundComplete,
  mayRaise,
  minRaiseTo,
  seatAfter,
  splitAmount,
  toCall,
  type BettingState
} from './betting';
import { cardOfEntity, cardText, holeCards, type Card } from './cards';
import { compareHands, evaluateSeven, type HandValue } from './handEval';
import { choosePokerAction } from './ai';
import { AI_PROFILE, POKER_AI_ROSTER, getAiHeroName, isAiSeat, seatingOf, type SeatAssignment, type SeatingState } from './seating';
import { observerOf, observerStateOf, POKER_OBSERVER, pickAiSeat, withObserverState, type PokerObserver } from './observers';
import { buildHandFacts, type PokerHandFact } from './stats';
import { createSeatPlayer, POKER_DEFAULTS, seatPosition } from './setup';

/**
 * 给 AI 座位构造 `𝒪(s, i)`（宪章 C-5 信息约束）。
 *
 * 与 `engine.getProjectedStateFor(seat)` 是同一份投影，只是这里不经过引擎
 * （`reduce` 内部拿不到 engine 实例）。投影把牌堆顺序、对手底牌、
 * `prngState` / `seed` 一并抹掉；AI 因此**在类型层面**读不到这些字段。
 */
function decisionView(state: GameState, seat: PlayerId) {
  return CognitiveObserver.projectState(state, seat, undefined, undefined, undefined);
}


/**
 * Texas Hold'em rules: legal actions, betting resolution, streets, showdown.
 *
 * Everything is a pure function of the JSON state. One `reduce` call may walk
 * several transitions (close a street, deal the flop, close again, show down),
 * which keeps the state machine monotone and replay-exact without extra clicks.
 */

export type PokerStreet = 'COMPLETE' | 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER';

export interface PokerHandState extends BettingState {
  handNo: number;
  street: PokerStreet;
  buttonSeat: number;
  sbSeat: number;
  bbSeat: number;
  /** Chips already collected from finished streets. */
  pot: number;
  /** Total chips each seat put in this hand (side-pot source of truth). */
  handBets: Record<string, number>;
  /**
   * Sum of the incomplete (all-in) raise increments since the last full raise.
   * TDA "Multiple Short All-Ins": once these add up to a full raise, the betting
   * reopens for the seats that had already acted.
   */
  shortRaiseAccum: number;
  community: string[];
  lastAggressor: string | null;
  /**
   * What each seat last did on the current street (过牌 / 跟注 20 / 加注到 40 /
   * 弃牌 / 全押 200). Cleared when the street closes; the renderer draws it as
   * the action sign beside each seat's standee.
   */
  lastActions: Record<string, string>;
  /**
   * 结算阶段仍然亮着的座位：摊牌时所有存活玩家必须亮牌，早结束（全部弃牌）时
   * 由赢家自己选择。结算画面据此保留牌面，下一手开始才收回牌堆。
   */
  revealed: string[];
  /** 已经点过「准备」的座位；全部存活座位都准备后才能开下一手。 */
  readyForNext: string[];
  /**
   * 本手实际被发到牌的座位。观察者与开局前就破产的座位不在其中——
   * 生涯统计只算「真的参与过这一手」的人，不把旁观时间摊进入池率。
   */
  dealt: string[];
  /** 翻前自愿投过钱的座位（跟注 / 加注 / 全押；下盲注不算）。 */
  preflopVoluntary: string[];
  /** 翻牌发出时仍在牌局里的座位（弃牌与旁观都不算）。 */
  sawFlop: string[];
}

export interface PokerPotResult {
  amount: number;
  winners: string[];
  label: string;
}

export interface PokerHandResult {
  handNo: number;
  endedBy: 'SHOWDOWN' | 'FOLD';
  pots: PokerPotResult[];
  showdown: { playerId: string; label: string; cards: string[] }[];
  /** 逐座位的本手事实（交给账号生涯统计折叠，见 poker/stats.ts）。 */
  players?: PokerHandFact[];
}

export interface PokerConfigValues {
  startingStack: number;
  smallBlind: number;
  bigBlind: number;
  /**
   * 由内核内联推进 AI（默认）。app/server 设为 false 时改由驱动方逐步派发具体动作，
   * 每个 AI 动作之间才有可感知的停顿。
   */
  autoAi: boolean;
}

const STREET_LABEL: Record<string, string> = {
  PREFLOP: '翻前',
  FLOP: '翻牌',
  TURN: '转牌',
  RIVER: '河牌',
  COMPLETE: '本手结束'
};

const LOG_LIMIT = 40;

/* -------------------------------------------------------------------------- */
/* State helpers                                                              */
/* -------------------------------------------------------------------------- */

function handOf(state: GameState): PokerHandState | undefined {
  return state.globalVars.hand as PokerHandState | undefined;
}

function configOf(state: GameState): PokerConfigValues {
  return (state.globalVars.config as PokerConfigValues | undefined) ?? { ...POKER_DEFAULTS };
}

function chipsOf(state: GameState, playerId: string): number {
  return Number(state.players[playerId]?.customProps?.chips ?? 0);
}

function nameOf(state: GameState, playerId: string | undefined): string {
  if (!playerId) return '—';
  return state.players[playerId]?.name ?? playerId;
}

function zeros(order: readonly string[]): Record<string, number> {
  return Object.fromEntries(order.map(pid => [pid, 0]));
}

function withHand(state: GameState, hand: PokerHandState): GameState {
  return { ...state, globalVars: { ...state.globalVars, hand } };
}

function patchPlayer(state: GameState, playerId: string, patch: (player: Player) => Player): GameState {
  const player = state.players[playerId];
  if (!player) return state;
  return { ...state, players: { ...state.players, [playerId]: patch(player) } };
}

function setChips(state: GameState, playerId: string, chips: number): GameState {
  const value = Math.max(0, Math.round(chips));
  return patchPlayer(state, playerId, player => ({
    ...player,
    score: value,
    customProps: { ...player.customProps, chips: value }
  }));
}

/** 「入座 → 准备」流程里，所有座位（AI 与真人）是否都已准备。 */
function allReady(state: GameState, seating: SeatingState): boolean {
  return state.playerOrder.every(
    pid => !!seating.seated[pid] && !!seating.ready[pid]
  );
}

function withSeating(state: GameState, seating: SeatingState): GameState {
  return { ...state, globalVars: { ...state.globalVars, seating } };
}

function setVisibility(state: GameState, entityId: string, visibility: VisibilityRule): GameState {
  const entity = state.entities[entityId];
  if (!entity) return state;
  return { ...state, entities: { ...state.entities, [entityId]: { ...entity, visibility } } };
}

function pushLog(state: GameState, text: string): GameState {
  const log = Array.isArray(state.globalVars.log) ? (state.globalVars.log as string[]) : [];
  return {
    ...state,
    globalVars: { ...state.globalVars, log: [...log, text].slice(-LOG_LIMIT) }
  };
}

/** Seats still contesting the pot. */
function livePlayers(state: GameState): string[] {
  const hand = handOf(state);
  if (!hand) return [];
  return state.playerOrder.filter(pid => !hand.folded.includes(pid));
}

/* -------------------------------------------------------------------------- */
/* 观察者席位 / 补位 AI                                                        */
/* -------------------------------------------------------------------------- */

function seatPlanOf(state: GameState): SeatAssignment[] | undefined {
  return state.globalVars.seats as SeatAssignment[] | undefined;
}

/** 把座位编制表里的第 `seat` 项换成新的控制者（真人 ↔ 补位 AI）。 */
function replaceSeatAssignment(
  state: GameState,
  seat: number,
  assignment: SeatAssignment
): GameState {
  const seats = seatPlanOf(state);
  if (!seats || !seats[seat]) return state;
  const nextSeats = [...seats];
  nextSeats[seat] = assignment;
  return { ...state, globalVars: { ...state.globalVars, seats: nextSeats } };
}

/** 座位牌上的名字与 occupant 一起换：立牌、玩家卡、详情都读这里。 */
function renameSeatNode(
  state: GameState,
  seat: number,
  playerId: string,
  name: string
): GameState {
  let changed = false;
  const nodes = { ...state.mapGraph.nodes };
  for (const [id, node] of Object.entries(nodes)) {
    if (node.type !== 'SEAT') continue;
    if (Number(node.props?.seatIndex) !== seat) continue;
    nodes[id] = { ...node, props: { ...node.props, playerId, name } };
    changed = true;
  }
  return changed ? { ...state, mapGraph: { ...state.mapGraph, nodes } } : state;
}

/** 手牌扇形跟随座位：换人之后发牌动画才不会还留在旧座位。 */
function ensureHandZone(state: GameState, playerId: string, seat: number): GameState {
  const zoneId = `zone_hand_${playerId}`;
  const [x, , z] = seatPosition(seat, state.playerOrder.length);
  const anchor: [number, number, number] = [x * 0.82, 0.12, z * 0.82];
  const existing = state.zones[zoneId];
  if (existing) {
    return { ...state, zones: { ...state.zones, [zoneId]: { ...existing, anchorPosition: anchor } } };
  }
  return ECSManager.createZone(
    state,
    zoneId,
    `${playerId} 底牌`,
    'HAND',
    { type: 'OWNER_ONLY', ownerId: playerId },
    playerId,
    'FAN',
    anchor
  );
}

/** 补位 AI 的 id：p1 → p1a1 → p1a2，永远不与现有玩家撞号。 */
function replacementAiId(playerId: string, serial: number): string {
  return `${playerId.replace(/a\d+$/, '')}a${serial}`;
}

/**
 * 结算后把空座补满。
 *
 * 真人的座位输光 → 本人转为观察者（保留筹码账，等低保），座位立即由补位 AI
 * 接手；AI 输光 → 直接换一个新的 AI。牌桌因此不会因为有人破产而散场。
 */
function refillBustedSeats(state: GameState): GameState {
  let next = state;
  const hand = handOf(next);
  const observers = observerStateOf(next);
  const list = [...observers.list];
  let aiSerial = observers.aiSerial;
  const order = [...next.playerOrder];
  const config = configOf(next);

  for (let seat = 0; seat < order.length; seat++) {
    const pid = order[seat];
    if (!pid || chipsOf(next, pid) > 0) continue;
    const wasAi = isAiSeat(next, pid);

    if (!wasAi) {
      const entry: PokerObserver = {
        playerId: pid,
        seatIndex: seat,
        stipendSeconds: 0,
        pendingSeat: null,
        sinceHand: hand?.handNo ?? 0
      };
      const existing = list.findIndex(item => item.playerId === pid);
      if (existing >= 0) list[existing] = entry;
      else list.push(entry);
      next = patchPlayer(next, pid, player => ({
        ...player,
        alive: false,
        status: 'SPECTATOR',
        customProps: {
          ...player.customProps,
          chips: 0,
          inHand: false,
          folded: false,
          allIn: false,
          busted: true
        }
      }));
      next = pushLog(
        next,
        `${nameOf(next, pid)} 输光筹码，转为观察者 · 筹码低于 ${POKER_OBSERVER.stipendThreshold} 时每分钟领 ${POKER_OBSERVER.stipendAmount} 低保`
      );
    }

    aiSerial += 1;
    const aiId = replacementAiId(pid, aiSerial);
    const tier = POKER_AI_ROSTER[(aiSerial - 1) % POKER_AI_ROSTER.length];
    const heroName = getAiHeroName(aiSerial + 5);
    const assignment: SeatAssignment = {
      playerId: aiId,
      isAi: true,
      aiTier: tier,
      aiLabel: `${AI_PROFILE[tier].label} AI`
    };
    const aiName = `${AI_PROFILE[tier].label} AI · ${heroName} (补位)`;
    const aiPlayer = createSeatPlayer(aiId, seat, config.startingStack, assignment, aiName);
    const players = { ...next.players, [aiId]: aiPlayer };
    if (wasAi) delete players[pid];
    next = {
      ...next,
      players,
      playerOrder: next.playerOrder.map((entry, index) => (index === seat ? aiId : entry))
    };
    next = replaceSeatAssignment(next, seat, assignment);
    next = renameSeatNode(next, seat, aiId, aiName);
    next = ensureHandZone(next, aiId, seat);
    next = pushLog(next, `${aiName} 接替第 ${seat + 1} 座 · 买入 ${config.startingStack}`);
  }

  return withObserverState(next, { ...observers, aiSerial, list });
}

/** 观察者真正坐回牌桌：接手目标座位，把补位 AI 请出去。 */
function swapObserverIn(state: GameState, entry: PokerObserver, seat: number): GameState {
  let next = state;
  const pid = entry.playerId;
  const outgoing = next.playerOrder[seat];
  if (!outgoing || outgoing === pid) return state;
  next = patchPlayer(next, pid, player => ({
    ...player,
    alive: true,
    status: 'ACTIVE',
    handZoneId: `zone_hand_${pid}`,
    customProps: {
      ...player.customProps,
      seat,
      inHand: false,
      folded: false,
      allIn: false,
      busted: false,
      isAi: false
    }
  }));
  const players = { ...next.players };
  delete players[outgoing];
  next = {
    ...next,
    players,
    playerOrder: next.playerOrder.map((id, index) => (index === seat ? pid : id)),
    activePlayerId: next.activePlayerId === outgoing ? pid : next.activePlayerId
  };
  next = replaceSeatAssignment(next, seat, { playerId: pid, isAi: false });
  next = renameSeatNode(next, seat, pid, nameOf(next, pid));
  next = ensureHandZone(next, pid, seat);
  return pushLog(
    next,
    `${nameOf(next, pid)} 重新上桌 · 第 ${seat + 1} 座 · 买入 ${chipsOf(next, pid)} 筹码`
  );
}

/** 把「等本轮结束」的换桌申请落到位（结算后调用）。 */
function applyObserverSwaps(state: GameState): GameState {
  const observers = observerStateOf(state);
  if (observers.list.length === 0) return state;
  let next = state;
  const remaining: PokerObserver[] = [];
  for (const entry of observers.list) {
    const seat = entry.pendingSeat;
    if (seat === null || seat === undefined) {
      remaining.push(entry);
      continue;
    }
    const occupant = next.playerOrder[seat];
    const seatIsAi = !!occupant && isAiSeat(next, occupant);
    if (!seatIsAi || chipsOf(next, entry.playerId) <= 0) {
      remaining.push({ ...entry, pendingSeat: null });
      continue;
    }
    next = swapObserverIn(next, entry, seat);
  }
  return withObserverState(next, { ...observers, list: remaining });
}

/** 低保：每满 `stipendPeriodSeconds` 秒、筹码仍低于门槛，就发一次。 */
function chargeObserverStipend(state: GameState, seconds: number, ctx: ReduceContext): GameState {
  const observers = observerStateOf(state);
  if (observers.list.length === 0 || seconds <= 0) return state;
  let next = state;
  const list = observers.list.map(entry => {
    const chips = chipsOf(next, entry.playerId);
    if (chips >= POKER_OBSERVER.stipendThreshold) return { ...entry, stipendSeconds: 0 };
    const total = entry.stipendSeconds + seconds;
    const grants = Math.floor(total / POKER_OBSERVER.stipendPeriodSeconds);
    if (grants > 0) {
      next = setChips(next, entry.playerId, chips + grants * POKER_OBSERVER.stipendAmount);
      // 宪章 C-7：补贴是收益，不是"凭空多出来的筹码"。
      ctx.reward(
        entry.playerId,
        'chips',
        grants * POKER_OBSERVER.stipendAmount,
        `观战 ${grants} 次低保（每次 ${POKER_OBSERVER.stipendAmount}）`
      );
      next = pushLog(
        next,
        `观察者 ${nameOf(next, entry.playerId)} 领取低保 ${grants * POKER_OBSERVER.stipendAmount} · 现有 ${chipsOf(
          next,
          entry.playerId
        )} 筹码`
      );
    }
    return { ...entry, stipendSeconds: total % POKER_OBSERVER.stipendPeriodSeconds };
  });
  return withObserverState(next, { ...observers, list });
}

/** Move the top card of the deck into `zoneId` and set its visibility. */
function dealTo(
  state: GameState,
  zoneId: string,
  visibility: VisibilityRule
): { state: GameState; cardId: string | null } {
  const cardId = state.zones.zone_deck?.orderedEntities[0];
  if (!cardId) return { state, cardId: null };
  const moved = ECSManager.moveEntity(state, cardId, zoneId);
  return { state: setVisibility(moved, cardId, visibility), cardId };
}

/* -------------------------------------------------------------------------- */
/* Rules                                                                      */
/* -------------------------------------------------------------------------- */

export class PokerRules {
  /* ---------------------------------------------------------------- */
  /* Legality                                                          */
  /* ---------------------------------------------------------------- */

  public static getLegalActions(state: GameState, playerId: PlayerId): Action[] {
    if (state.gameOver) return [];
    const hand = handOf(state);
    if (!hand) return [];

    // 观察者不在牌局里，只有一件事可做：攒够一个大盲就申请重新上桌。
    const observer = observerOf(state, playerId);
    if (observer) {
      const buyIn = configOf(state).bigBlind * POKER_OBSERVER.minBuyInBlinds;
      if (observer.pendingSeat !== null || chipsOf(state, playerId) < buyIn) return [];
      return [{ type: 'OBSERVER_REJOIN', playerId }];
    }

    // 内置 AI 不吃玩家的鼠标操作：它由 PokerBrain 驱动（见 ai.ts），
    // 对真人永远不提供合法动作，避免玩家代替 AI 出牌。
    if (isAiSeat(state, playerId) && playerId !== state.activePlayerId) return [];

    // 「入座 → 准备 → 开局」：真人座位需要先后完成入座与准备。
    // AI 座位开局即入座就绪，因此不提供任何操作。
    const seating = seatingOf(state);
    if (seating && !seating.started) {
      if (isAiSeat(state, playerId)) return [];
      if (!seating.seated[playerId]) return [{ type: 'TAKE_SEAT', playerId }];
      if (!seating.ready[playerId]) return [{ type: 'READY_UP', playerId }];
      return allReady(state, seating) ? [{ type: 'START_HAND', playerId }] : [];
    }

    if (hand.street === 'COMPLETE') {
      // 机器座位在结算阶段只做一件事：全员就位就发下一手，别替真人抢开。
      // 全桌都成了 AI（真人都进了观察席）时，牌局正是靠这一步继续下去的。
      if (isAiSeat(state, playerId)) {
        return this.everyoneReady(state, hand) ? [{ type: 'START_HAND', playerId }] : [];
      }
      return this.settlementActions(state, playerId, hand);
    }
    if (playerId !== state.activePlayerId) return [];
    if (hand.folded.includes(playerId) || hand.allIn.includes(playerId)) return [];

    // AI 与真人走同一条管线：直接给出它这一步要做的具体动作，驱动方原样派发，
    // 结算、准备、开下一手也走同一张动作表，不再有「AI 专用」的 AI_ACT。
    if (isAiSeat(state, playerId)) {
      const decided = choosePokerAction(decisionView(state, playerId), playerId);
      return decided ? [decided] : [];
    }

    const chips = chipsOf(state, playerId);
    const owed = toCall(hand, playerId);
    const actions: Action[] = [{ type: 'FOLD', playerId }];

    if (owed <= 0) {
      actions.push({ type: 'CHECK', playerId });
    } else if (owed < chips) {
      actions.push({ type: 'CALL', playerId, payload: { amount: owed } });
    }

    const maxRaiseTo = (hand.streetBets[playerId] ?? 0) + chips;
    const minimum = minRaiseTo(hand);
    if (owed < chips && mayRaise(hand, playerId) && maxRaiseTo >= minimum) {
      actions.push({
        type: 'RAISE',
        playerId,
        fields: [
          {
            key: 'amount',
            label: '加注到',
            kind: 'number',
            min: minimum,
            max: maxRaiseTo,
            step: configOf(state).bigBlind,
            default: minimum
          }
        ]
      });
    }

    if (chips > 0 && (owed > 0 || maxRaiseTo > hand.currentBet)) {
      actions.push({ type: 'ALL_IN', playerId });
    }

    return actions;
  }

  /**
   * What a seat may do once the hand is settled.
   *
   * Every surviving seat has to click 准备 before the next hand can be dealt —
   * a settlement is something to read, not a formality to skip. The winner of a
   * hand that ended early (everyone folded) may additionally choose whether to
   * show their cards; a hand that went to showdown has already shown them, which
   * is not a choice.
   */
  private static settlementActions(
    state: GameState,
    playerId: PlayerId,
    hand: PokerHandState
  ): Action[] {
    if (chipsOf(state, playerId) <= 0) return [];
    const actions: Action[] = [];
    const lastHand = state.globalVars.lastHand as PokerHandResult | undefined;
    const winner = lastHand?.endedBy === 'FOLD' ? lastHand.pots[0]?.winners[0] : undefined;
    if (winner === playerId && !hand.revealed.includes(playerId)) {
      actions.push({ type: 'SHOW', playerId });
      actions.push({ type: 'MUCK', playerId });
    }
    // 不等了：任何人（尤其房主）都能直接开下一手，避免个别座位没点准备把桌子卡死。
    actions.push({ type: 'FORCE_START', playerId });
    if (!hand.readyForNext.includes(playerId)) {
      actions.push({ type: 'READY', playerId });
      return actions;
    }
    const waiting = state.playerOrder.filter(
      pid => chipsOf(state, pid) > 0 && !this.isReadyFor(hand, state, pid)
    );
    if (waiting.length === 0) actions.push({ type: 'START_HAND', playerId });
    // 一键全员准备只属于单人调试桌：多真人房间里它等于替别人按准备，不给。
    const seatPlan = state.globalVars.seats as { isAi: boolean }[] | undefined;
    const humans = seatPlan ? seatPlan.filter(seat => !seat.isAi).length : 0;
    if (humans <= 1) actions.push({ type: 'DEBUG_READY_ALL', playerId });
    // 不等了：任何人（尤其房主）都能直接开下一手，避免个别座位没点准备就把桌子卡死。
    return actions;
  }

  /** 存活座位是否全部点过「准备」。 */
  /**
   * 该座位是否算「已就位」。
   *
   * AI 座位永远不会点准备按钮，所以不能只看 `readyForNext` 里有没有它——只要它是
   * AI 就直接算就位。这样无论发牌时有没有把 AI 预置进去，牌桌都不会被 AI 卡死。
   */
  private static isReadyFor(hand: PokerHandState, state: GameState, playerId: PlayerId): boolean {
    return hand.readyForNext.includes(playerId) || isAiSeat(state, playerId);
  }

  private static everyoneReady(state: GameState, hand: PokerHandState): boolean {
    return state.playerOrder.every(pid => chipsOf(state, pid) <= 0 || this.isReadyFor(hand, state, pid));
  }

  /** Cross-field validation for the declarative raise amount. */
  public static validatePayload(
    state: GameState,
    action: Action,
    payload: Record<string, unknown>
  ): string[] {
    if (action.type !== 'RAISE') return [];
    const hand = handOf(state);
    if (!hand) return ['no hand in progress'];
    const playerId = action.actorId ?? action.playerId;
    const amount = Number(payload.amount);
    if (!Number.isFinite(amount) || !Number.isInteger(amount)) return ['加注额必须是整数'];

    const chips = chipsOf(state, playerId);
    const maxRaiseTo = (hand.streetBets[playerId] ?? 0) + chips;
    const minimum = minRaiseTo(hand);
    if (amount > maxRaiseTo) return [`加注额超过筹码上限（最多加注到 ${maxRaiseTo}）`];
    if (amount <= hand.currentBet) return ['加注额必须高于当前注额'];
    if (amount < minimum && amount !== maxRaiseTo) return [`最小加注到 ${minimum}`];
    return [];
  }

  /* ---------------------------------------------------------------- */
  /* Transitions                                                       */
  /* ---------------------------------------------------------------- */

  public static applyAction(state: GameState, action: Action, ctx: ReduceContext): GameState {
    const hand = handOf(state);
    if (!hand) return state;
    // 每次真人动作落地后，让当前该出手的 AI 座位连续行动，直到轮到真人为止。
    // 内联在 reduce 里（而不是外部定时器）保证状态跃迁与 replay 完全一致。
    return this.advanceAi(this.applyHuman(state, action, ctx), ctx);
  }

  /**
   * 连续驱动 AI 座位。上限 64 次防止病态循环；AI 永远给出合法动作，
   * 由 `choosePokerAction` 保证，内核仍会再校验一次。
   */
  private static advanceAi(state: GameState, ctx: ReduceContext): GameState {
    // 外部驱动模式下每个 AI 动作由驱动方单独派发，内核不再内联推进。
    if (!configOf(state).autoAi) return state;
    let next = state;
    for (let guard = 0; guard < 64; guard++) {
      if (next.gameOver) return next;
      const active = next.activeActorId ?? next.activePlayerId;
      if (!active || !isAiSeat(next, active)) return next;
      const action = choosePokerAction(decisionView(next, active), active);
      if (!action) return next;
      const stepped = this.applyHuman(next, action, ctx);
      if (stepped === next) return next; // 动作被拒：停止推进，避免空转
      next = stepped;
    }
    return next;
  }

  private static applyHuman(state: GameState, action: Action, ctx: ReduceContext): GameState {
    const hand = handOf(state);
    if (!hand) return state;

    // 观察者的两件事：领低保（驱动方心跳派发）与申请重新上桌。
    if (action.type === 'OBSERVER_TICK') {
      const seconds = Math.floor(Number(action.payload?.seconds ?? 0));
      if (!Number.isFinite(seconds) || seconds <= 0) return state;
      return { ...chargeObserverStipend(state, Math.min(seconds, 3600), ctx), turn: state.turn + 1 };
    }

    if (action.type === 'OBSERVER_REJOIN') {
      const entry = observerOf(state, action.playerId);
      if (!entry || entry.pendingSeat !== null) return state;
      const buyIn = configOf(state).bigBlind * POKER_OBSERVER.minBuyInBlinds;
      if (chipsOf(state, action.playerId) < buyIn) return state;
      const picked = pickAiSeat(state);
      if (!picked) return state;
      const observers = observerStateOf(state);
      const list = observers.list.map(item =>
        item.playerId === entry.playerId ? { ...item, pendingSeat: picked.seat } : item
      );
      let next = withObserverState(
        { ...state, prngState: picked.nextSeed },
        { ...observers, list }
      );
      next = pushLog(
        next,
        `${nameOf(next, entry.playerId)} 申请重新上桌 · 等本轮结束后接手第 ${picked.seat + 1} 座`
      );
      // 本轮已经结束（结算态）就不必再等一手，立刻换人。
      if (handOf(next)?.street === 'COMPLETE') next = applyObserverSwaps(next);
      return { ...next, turn: state.turn + 1 };
    }

    // 「入座 → 准备」两个纯状态更新，不碰牌局。
    if (action.type === 'TAKE_SEAT' || action.type === 'READY_UP') {
      const seating = seatingOf(state);
      if (!seating || seating.started) return state;
      const playerId = action.playerId;
      if (isAiSeat(state, playerId)) return state;
      if (action.type === 'TAKE_SEAT') {
        return { ...withSeating(state, { ...seating, seated: { ...seating.seated, [playerId]: true } }), turn: state.turn + 1 };
      }
      // 必须先入座才能准备。
      if (!seating.seated[playerId]) return state;
      return { ...withSeating(state, { ...seating, ready: { ...seating.ready, [playerId]: true } }), turn: state.turn + 1 };
    }

    if (action.type === 'START_HAND') {
      const seating = seatingOf(state);
      if (seating && !seating.started) {
        // 只有全员准备后才允许真正开局；开局后座位流程永久关闭。
        if (!allReady(state, seating)) return state;
        state = withSeating(state, { ...seating, started: true });
      } else {
        // 每一手结束后的下一手同样要全员准备。
        if (hand.street !== 'COMPLETE') return state;
        if (!this.everyoneReady(state, hand)) return state;
      }
      const started = this.startHand(state, ctx);
      return { ...started, turn: state.turn + 1 };
    }

    // 结算阶段的三种纯状态更新：准备、亮牌、弃牌（不亮）。
    // 上帝视角/调试：一键让所有存活座位就位，省去逐个点「准备」。
    if (action.type === 'FORCE_START') {
      if (hand.street !== 'COMPLETE') return state;
      const solvent = state.playerOrder.filter(pid => chipsOf(state, pid) > 0);
      const forced = withHand(state, { ...hand, readyForNext: solvent });
      return { ...this.startHand(forced, ctx), turn: state.turn + 1 };
    }

    if (action.type === 'DEBUG_READY_ALL') {
      if (hand.street !== 'COMPLETE') return state;
      const solvent = state.playerOrder.filter(pid => chipsOf(state, pid) > 0);
      return { ...withHand(state, { ...hand, readyForNext: solvent }), turn: state.turn + 1 };
    }

    if (action.type === 'READY' || action.type === 'SHOW' || action.type === 'MUCK') {
      if (hand.street !== 'COMPLETE') return state;
      const playerId = action.playerId;
      if (chipsOf(state, playerId) <= 0) return state;
      if (action.type === 'READY') {
        if (hand.readyForNext.includes(playerId)) return state;
        const nextReady = [...hand.readyForNext, playerId];
        const nextHandState = { ...hand, readyForNext: nextReady };
        // 全员准备即自动发牌：不依赖某个座位再点一次「发下一手」，也不必赌
        // AI 恰好抓到 START_HAND。
        if (this.everyoneReady(state, nextHandState)) {
          return { ...this.startHand(withHand(state, nextHandState), ctx), turn: state.turn + 1 };
        }
        return { ...withHand(state, nextHandState), turn: state.turn + 1 };
      }
      const lastHand = state.globalVars.lastHand as PokerHandResult | undefined;
      const winner = lastHand?.endedBy === 'FOLD' ? lastHand.pots[0]?.winners[0] : undefined;
      if (winner !== playerId) return state;
      if (action.type === 'SHOW') {
        if (hand.revealed.includes(playerId)) return state;
        for (const card of holeCards(state, playerId)) {
          state = setVisibility(state, card.id, { type: 'PUBLIC' });
        }
        return {
          ...withHand(state, { ...hand, revealed: [...hand.revealed, playerId] }),
          turn: state.turn + 1
        };
      }
      // MUCK：不亮牌，只记一笔，避免反复提示。
      return {
        ...withHand(state, { ...hand, revealed: hand.revealed.filter(pid => pid !== playerId) }),
        turn: state.turn + 1
      };
    }


    if (hand.street === 'COMPLETE') return state;
    if (action.playerId !== state.activePlayerId) return state;

    const betted = this.applyBet(state, action, ctx);
    if (betted === state) return state;
    const settled = this.settle(betted, ctx);
    return { ...settled, turn: state.turn + 1 };
  }

  /** Apply one fold/check/call/raise and update the betting bookkeeping. */
  private static applyBet(state: GameState, action: Action, ctx: ReduceContext): GameState {
    const hand = handOf(state);
    if (!hand) return state;
    const playerId = action.playerId;
    const chips = chipsOf(state, playerId);
    const streetBets = { ...hand.streetBets };
    const handBets = { ...hand.handBets };

    let spent = 0;
    let raised = false;
    let reopened = false;
    let fullRaise = false;
    let shortRaiseAccum = hand.shortRaiseAccum;
    let label: string;

    switch (action.type) {
      case 'FOLD': {
        label = `${nameOf(state, playerId)} 弃牌`;
        break;
      }
      case 'CHECK': {
        label = `${nameOf(state, playerId)} 过牌`;
        break;
      }
      case 'CALL': {
        const amount = Math.min(toCall(hand, playerId), chips);
        spent = amount;
        streetBets[playerId] = (streetBets[playerId] ?? 0) + amount;
        handBets[playerId] = (handBets[playerId] ?? 0) + amount;
        label = `${nameOf(state, playerId)} 跟注 ${amount}`;
        break;
      }
      case 'RAISE':
      case 'ALL_IN': {
        const target =
          action.type === 'ALL_IN'
            ? (streetBets[playerId] ?? 0) + chips
            : Number(action.payload?.amount ?? 0);
        const delta = target - (streetBets[playerId] ?? 0);
        if (!Number.isFinite(target) || delta <= 0 || delta > chips) return state;
        spent = delta;
        streetBets[playerId] = target;
        handBets[playerId] = (handBets[playerId] ?? 0) + delta;
        const increment = target - hand.currentBet;
        raised = increment > 0;
        if (raised) {
          if (increment >= hand.lastRaiseSize) {
            // Full raise: the betting reopens and the minimum raise grows.
            reopened = true;
            fullRaise = true;
            shortRaiseAccum = 0;
          } else {
            // Short all-in (TDA "Multiple Short All-Ins"): several incomplete
            // raises in the same round may add up to a full raise, and then the
            // betting reopens for players who had already acted.
            shortRaiseAccum = hand.shortRaiseAccum + increment;
            if (shortRaiseAccum >= hand.lastRaiseSize) {
              // TDA 45 accumulated reopen: players may raise again, but the
              // minimum raise size stays at the previous FULL raise (the short
              // increments do not shrink lastRaiseSize).
              reopened = true;
              shortRaiseAccum = 0;
            }
          }
        }
        label = `${nameOf(state, playerId)} ${
          hand.currentBet > 0 ? (raised ? '加注到' : '全押跟注') : '下注'
        } ${target}`;
        break;
      }
      default:
        return state;
    }

    const remaining = chips - spent;
    const allIn = remaining === 0 ? [...new Set([...hand.allIn, playerId])] : hand.allIn;
    const folded = action.type === 'FOLD' ? [...new Set([...hand.folded, playerId])] : hand.folded;
    const actedSinceRaise = folded.includes(playerId)
      ? hand.actedSinceRaise.filter(pid => pid !== playerId)
      : reopened
        ? [playerId]
        : [...new Set([...hand.actedSinceRaise, playerId])];

    // The short form painted on this seat's board: what the table needs to read
    // at a glance, not the full log line.
    const sign =
      action.type === 'FOLD'
        ? '弃牌'
        : action.type === 'CHECK'
          ? '过牌'
          : action.type === 'CALL'
            ? `跟注 ${spent}`
            : remaining === 0
              ? `全押 ${streetBets[playerId]}`
              : `加注到 ${streetBets[playerId]}`;

    // 入池口径：翻前**自愿**投钱才算 VPIP。跟注/加注/全押都要在 `spent > 0`
    // 时才算数——零金额的过牌与跟注不变动作，不能把入池率算高。
    const voluntary =
      hand.street === 'PREFLOP' && spent > 0 && action.type !== 'FOLD'
        ? [...new Set([...hand.preflopVoluntary, playerId])]
        : hand.preflopVoluntary;

    const nextHand: PokerHandState = {
      ...hand,
      streetBets,
      handBets,
      allIn,
      folded,
      actedSinceRaise,
      shortRaiseAccum,
      lastActions: { ...hand.lastActions, [playerId]: sign },
      currentBet: raised ? Math.max(hand.currentBet, streetBets[playerId]) : hand.currentBet,
      lastRaiseSize: fullRaise ? streetBets[playerId] - hand.currentBet : hand.lastRaiseSize,
      lastAggressor: raised ? playerId : hand.lastAggressor,
      preflopVoluntary: voluntary
    };

    let next = setChips(state, playerId, remaining);
    next = withHand(next, nextHand);
    next = pushLog(next, label);

    if (action.type === 'FOLD') {
      // 弃牌即时进 muck 并保持 HIDDEN（docs/POKER.md：弃牌后不得再查看/亮出该手牌）
      for (const card of holeCards(state, playerId)) {
        next = ECSManager.moveEntity(next, card.id, 'zone_muck');
        next = setVisibility(next, card.id, { type: 'HIDDEN' });
      }
    }

    if (raised) {
      ctx.trace({
        id: ctx.id('poker'),
        type: 'TOKEN_TRANSFER',
        title: label,
        sourceId: playerId,
        payload: { amount: streetBets[playerId] },
        durationMs: 400
      });
    }
    return next;
  }

  /**
   * Close the street if the betting round is over, otherwise hand the action
   * to the next seat that can still act. Loops while several streets can be
   * closed in one transition (e.g. everyone all-in before the flop).
   *
   * A raise alone never deals the next street: `isRoundComplete` only reports
   * true once every seat that can still act has matched the current bet (平注)
   * and has acted since the last full raise.
   */
  private static settle(state: GameState, ctx: ReduceContext): GameState {
    let next = state;
    for (let guard = 0; guard < 8; guard++) {
      const hand = handOf(next);
      if (!hand) return next;
      const live = livePlayers(next);
      if (live.length <= 1) return this.finishByFold(next, ctx, live[0]);

      if (!isRoundComplete(hand, live)) {
        const seat = this.actorSeatFrom(next, this.seatOf(next, next.activePlayerId), false);
        return { ...next, activePlayerId: next.playerOrder[seat] };
      }

      if (hand.street === 'RIVER') return this.showdown(next, ctx);

      next = this.collectBets(next);
      next = this.dealNextStreet(next, ctx);

      const afterHand = handOf(next);
      if (!afterHand) return next;
      const actors = livePlayers(next).filter(pid => !afterHand.allIn.includes(pid));
      if (actors.length === 0) continue;

      const seat = this.actorSeatFrom(next, afterHand.buttonSeat, false);
      next = { ...next, activePlayerId: next.playerOrder[seat], phase: afterHand.street };
      if (isRoundComplete(afterHand, livePlayers(next))) continue;
      return next;
    }
    return next;
  }

  private static seatOf(state: GameState, playerId: string): number {
    return Math.max(0, state.playerOrder.indexOf(playerId));
  }

  /** First seat clockwise from `fromSeat` that can still act (folded/all-in skipped). */
  private static actorSeatFrom(state: GameState, fromSeat: number, inclusive: boolean): number {
    const hand = handOf(state);
    const accept = (pid: string) => !!hand && !hand.folded.includes(pid) && !hand.allIn.includes(pid);
    if (inclusive && accept(state.playerOrder[fromSeat])) return fromSeat;
    return seatAfter(state.playerOrder, fromSeat, accept);
  }

  private static collectBets(state: GameState): GameState {
    const hand = handOf(state);
    if (!hand) return state;
    const collected = Object.values(hand.streetBets).reduce((sum, amount) => sum + amount, 0);
    return withHand(state, {
      ...hand,
      pot: hand.pot + collected,
      streetBets: zeros(state.playerOrder),
      currentBet: 0,
      lastRaiseSize: hand.bigBlind,
      actedSinceRaise: [],
      shortRaiseAccum: 0,
      lastActions: {}
    });
  }

  private static dealNextStreet(state: GameState, ctx: ReduceContext): GameState {
    const hand = handOf(state);
    if (!hand) return state;
    const street = hand.street;
    const count = street === 'PREFLOP' ? 3 : 1;

    let next = dealTo(state, 'zone_burn', { type: 'HIDDEN' }).state;
    const community = [...hand.community];
    for (let index = 0; index < count; index++) {
      const dealt = dealTo(next, 'zone_board', { type: 'PUBLIC' });
      next = dealt.state;
      if (dealt.cardId) community.push(dealt.cardId);
    }

    const nextStreet: PokerStreet =
      street === 'PREFLOP' ? 'FLOP' : street === 'FLOP' ? 'TURN' : 'RIVER';
    const board = community
      .map(id => cardOfEntity(next.entities[id]))
      .filter((card): card is Card => card !== null)
      .map(cardText)
      .join(' ');

    next = withHand(next, { ...handOf(next)!, community, street: nextStreet });
    // 翻牌发出时还留在牌局里的座位，才算「看过翻牌」——弃牌的人已经不在其中。
    if (nextStreet === 'FLOP') {
      next = withHand(next, {
        ...(handOf(next) as PokerHandState),
        sawFlop: livePlayers(next)
      });
    }
    next = { ...next, phase: nextStreet };
    next = pushLog(next, `${STREET_LABEL[nextStreet]} · ${board}`);
    ctx.trace({
      id: ctx.id('poker'),
      type: 'CARD_PLAY',
      title: `${STREET_LABEL[nextStreet]} ${board}`,
      payload: { community },
      durationMs: 600
    });
    return next;
  }

  private static startHand(state: GameState, ctx: ReduceContext): GameState {
    const order = state.playerOrder;
    const config = configOf(state);
    let next = state;

    // 1. Every card goes back to the deck, face down.
    for (const entityId of Object.keys(next.entities)) {
      const entity = next.entities[entityId];
      if (entity?.type !== 'CARD') continue;
      if (entity.zoneId !== 'zone_deck') next = ECSManager.moveEntity(next, entityId, 'zone_deck');
      next = setVisibility(next, entityId, { type: 'HIDDEN' });
    }

    // 2. Deterministic reshuffle; the seed lives in the state.
    const shuffled = DeterministicPRNG.shuffle(next.prngState, next.zones.zone_deck.orderedEntities);
    next = {
      ...next,
      prngState: shuffled.nextSeed,
      zones: {
        ...next.zones,
        zone_deck: { ...next.zones.zone_deck, orderedEntities: shuffled.result }
      }
    };

    // 3. Reset seats for the new hand.
    for (const pid of order) {
      const chips = chipsOf(next, pid);
      next = patchPlayer(next, pid, player => ({
        ...player,
        customProps: { ...player.customProps, inHand: chips > 0, folded: false, allIn: false }
      }));
    }

    // 4. Move the button, then seat the blinds (heads-up: the button is the small blind).
    const hasChips = (pid: string) => chipsOf(next, pid) > 0;
    const liveCount = order.filter(hasChips).length;
    const previousButton = handOf(next)?.buttonSeat ?? order.length - 1;
    const buttonSeat = seatAfter(order, previousButton, hasChips);
    const sbSeat = liveCount === 2 ? buttonSeat : seatAfter(order, buttonSeat, hasChips);
    const bbSeat = seatAfter(order, sbSeat, hasChips);

    const handNo = (handOf(next)?.handNo ?? 0) + 1;
    const fresh: PokerHandState = {
      handNo,
      street: 'PREFLOP',
      buttonSeat,
      sbSeat,
      bbSeat,
      pot: 0,
      currentBet: config.bigBlind,
      lastRaiseSize: config.bigBlind,
      bigBlind: config.bigBlind,
      streetBets: zeros(order),
      handBets: zeros(order),
      actedSinceRaise: [],
      shortRaiseAccum: 0,
      lastActions: {},
      revealed: [],
      // AI 座位不需要点「准备」：它们开局即就绪，只有真人要按。
      readyForNext: order.filter(pid => isAiSeat(state, pid)),
      folded: [],
      allIn: [],
      community: [],
      lastAggressor: null,
      // 生涯统计的逐手事实：谁被发了牌 / 翻前自愿投钱 / 看到翻牌。
      dealt: [],
      preflopVoluntary: [],
      sawFlop: []
    };
    next = withHand(next, fresh);
    next = { ...next, phase: 'PREFLOP', round: handNo };

    // 5. Forced bets.
    next = this.postBlind(next, order[sbSeat], config.smallBlind);
    next = this.postBlind(next, order[bbSeat], config.bigBlind);
    // The blinds are the first thing each of those seats "did" this street, so
    // their boards start out saying so.
    const afterBlinds = handOf(next);
    if (afterBlinds) {
      next = withHand(next, {
        ...afterBlinds,
        lastActions: {
          [order[sbSeat]]: `小盲 ${afterBlinds.streetBets[order[sbSeat]] ?? config.smallBlind}`,
          [order[bbSeat]]: `大盲 ${afterBlinds.streetBets[order[bbSeat]] ?? config.bigBlind}`
        }
      });
    }

    // 6. Two hole cards each, one at a time clockwise from the small blind.
    const dealingSeats: number[] = [];
    for (let step = 0; step < order.length; step++) {
      const seat = (sbSeat + step) % order.length;
      if (next.players[order[seat]]?.customProps.inHand) dealingSeats.push(seat);
    }
    for (let roundIndex = 0; roundIndex < 2; roundIndex++) {
      for (const seat of dealingSeats) {
        const pid = order[seat];
        next = dealTo(next, `zone_hand_${pid}`, { type: 'OWNER_ONLY', ownerId: pid }).state;
      }
    }
    // 被发牌的座位进了本手的统计口径；观察者（没座位 / 没牌）永远不在其中。
    const dealtIds = dealingSeats.map(seat => order[seat]);
    next = withHand(next, { ...(handOf(next) as PokerHandState), dealt: dealtIds });

    // 7. First to act: heads-up the button (small blind) leads pre-flop,
    //    otherwise the seat left of the big blind.
    const firstSeat =
      liveCount === 2
        ? this.actorSeatFrom(next, buttonSeat, true)
        : this.actorSeatFrom(next, bbSeat, false);
    next = { ...next, activePlayerId: order[firstSeat] };

    next = pushLog(
      next,
      `第 ${handNo} 手 · 庄家 ${nameOf(next, order[buttonSeat])} · 小盲 ${nameOf(next, order[sbSeat])} · 大盲 ${nameOf(next, order[bbSeat])}`
    );
    ctx.trace({
      id: ctx.id('poker'),
      type: 'CARD_DRAW',
      title: `第 ${handNo} 手 · 庄家 ${nameOf(next, order[buttonSeat])}`,
      durationMs: 500
    });

    const startedHand = handOf(next);
    if (startedHand && isRoundComplete(startedHand, livePlayers(next))) {
      return this.settle(next, ctx);
    }
    return next;
  }

  private static postBlind(state: GameState, playerId: string, amount: number): GameState {
    const chips = chipsOf(state, playerId);
    const posted = Math.min(amount, chips);
    let next = setChips(state, playerId, chips - posted);
    const hand = handOf(next);
    if (!hand) return next;
    next = withHand(next, {
      ...hand,
      streetBets: { ...hand.streetBets, [playerId]: (hand.streetBets[playerId] ?? 0) + posted },
      handBets: { ...hand.handBets, [playerId]: (hand.handBets[playerId] ?? 0) + posted },
      allIn: posted === chips ? [...new Set([...hand.allIn, playerId])] : hand.allIn
    });
    return next;
  }

  private static showdown(state: GameState, ctx: ReduceContext): GameState {
    const hand = handOf(state);
    if (!hand) return state;
    const live = livePlayers(state);

    // Showdown reveals every surviving hand.
    let next = state;
    for (const pid of live) {
      for (const card of holeCards(next, pid)) {
        next = setVisibility(next, card.id, { type: 'PUBLIC' });
      }
    }

    const board = hand.community
      .map(id => cardOfEntity(next.entities[id]))
      .filter((card): card is Card => card !== null);
    const values = new Map<string, HandValue>();
    for (const pid of live) {
      values.set(pid, evaluateSeven([...holeCards(next, pid), ...board]));
    }

    const pots = buildPots(hand.handBets, hand.folded);
    const results: PokerPotResult[] = [];
    const awarded: Record<string, number> = {};
    for (const pot of pots) {
      const contenders = pot.eligible.filter(pid => values.has(pid));
      if (contenders.length === 0) continue;
      let best: HandValue | undefined;
      for (const pid of contenders) {
        const value = values.get(pid) as HandValue;
        if (!best || compareHands(value, best) > 0) best = value;
      }
      const winners = contenders.filter(pid => compareHands(values.get(pid) as HandValue, best as HandValue) === 0);
      const award = splitAmount(pot.amount, winners, next.playerOrder, hand.buttonSeat);
      for (const [pid, amount] of Object.entries(award)) {
        next = setChips(next, pid, chipsOf(next, pid) + amount);
        awarded[pid] = (awarded[pid] ?? 0) + amount;
        // 宪章 C-7：每一笔底池派发都留下"因为什么"。之前只能靠前后状态反推。
        ctx.reward(pid, 'chips', amount, `摊牌赢池 ${best?.label ?? ''}（池 ${pot.amount}，${winners.length} 人分）`);
      }
      results.push({ amount: pot.amount, winners, label: best?.label ?? '' });
    }

    const showdown = live.map(pid => ({
      playerId: pid,
      label: values.get(pid)?.label ?? '',
      cards: holeCards(next, pid).map(cardText)
    }));

    next = withHand(next, {
      ...(handOf(next) as PokerHandState),
      pot: 0,
      streetBets: zeros(next.playerOrder),
      currentBet: 0,
      street: 'COMPLETE',
      actedSinceRaise: [],
      shortRaiseAccum: 0,
      lastActions: {},
      // 走到摊牌就必须亮：牌面留在桌上，结算画面才看得清谁靠什么赢。
      revealed: [...live]
    });
    next = this.writeHandResult(next, {
      handNo: hand.handNo,
      endedBy: 'SHOWDOWN',
      pots: results,
      showdown,
      players: buildHandFacts({
        handNo: hand.handNo,
        endedBy: 'SHOWDOWN',
        order: next.playerOrder,
        dealt: hand.dealt ?? next.playerOrder,
        preflopVoluntary: hand.preflopVoluntary ?? [],
        sawFlop: hand.sawFlop ?? [],
        showdown: live,
        handBets: hand.handBets,
        awarded
      }).players
    });
    next = pushLog(
      next,
      `摊牌 · ${results
        .map(result => `${result.label} ${result.winners.map(pid => nameOf(next, pid)).join('/')} 赢得 ${result.amount}`)
        .join(' | ')}`
    );
    ctx.trace({
      id: ctx.id('poker'),
      type: 'ANNOUNCEMENT',
      title: `摊牌 · ${results.map(result => `${result.winners.map(pid => nameOf(next, pid)).join('/')} 赢 ${result.amount}`).join(' · ')}`,
      durationMs: 1400
    });
    return this.afterHand(next);
  }

  private static finishByFold(state: GameState, ctx: ReduceContext, winnerId?: string): GameState {
    const hand = handOf(state);
    if (!hand) return state;
    const total = hand.pot + Object.values(hand.streetBets).reduce((sum, amount) => sum + amount, 0);

    let next = state;
    if (winnerId) {
      next = setChips(next, winnerId, chipsOf(next, winnerId) + total);
      // 宪章 C-7：无人跟注时赢下整个池，同样要能解释这是"对手弃牌"而不是"牌力更强"。
      ctx.reward(winnerId, 'chips', total, `其余座位全部弃牌，赢下池 ${total}`);
    }

    next = withHand(next, {
      ...(handOf(next) as PokerHandState),
      pot: 0,
      streetBets: zeros(next.playerOrder),
      currentBet: 0,
      street: 'COMPLETE',
      actedSinceRaise: [],
      shortRaiseAccum: 0,
      lastActions: {},
      revealed: []
    });

    if (winnerId) {
      next = this.writeHandResult(next, {
        handNo: hand.handNo,
        endedBy: 'FOLD',
        pots: [{ amount: total, winners: [winnerId], label: '其余玩家弃牌' }],
        showdown: [],
        players: buildHandFacts({
          handNo: hand.handNo,
          endedBy: 'FOLD',
          order: next.playerOrder,
          dealt: hand.dealt ?? next.playerOrder,
          preflopVoluntary: hand.preflopVoluntary ?? [],
          sawFlop: hand.sawFlop ?? [],
          showdown: [],
          handBets: hand.handBets,
          awarded: { [winnerId]: total }
        }).players
      });
      next = pushLog(next, `${nameOf(next, winnerId)} 赢得底池 ${total}（其余玩家弃牌）`);
      ctx.trace({
        id: ctx.id('poker'),
        type: 'ANNOUNCEMENT',
        title: `${nameOf(next, winnerId)} 赢得底池 ${total}`,
        durationMs: 900
      });
    }
    return this.afterHand(next);
  }

  private static writeHandResult(state: GameState, result: PokerHandResult): GameState {
    return { ...state, globalVars: { ...state.globalVars, lastHand: result } };
  }

  /** Mark busted seats, hand the table back to the next seat that still has chips. */
  private static afterHand(state: GameState): GameState {
    const hand = handOf(state);
    if (!hand) return state;
    let next = state;
    // 收牌（docs/POKER.md）：未亮出的手牌进 muck 且 HIDDEN；已亮出的（摊牌、或早
    // 结束时赢家选择明牌）留在手牌区并保持 PUBLIC，直到下一手开始——否则结算画面
    // 上牌面会瞬间消失，玩家看不清是什么牌赢了。
    for (const pid of next.playerOrder) {
      if (hand.revealed.includes(pid)) continue;
      for (const card of holeCards(next, pid)) {
        next = ECSManager.moveEntity(next, card.id, 'zone_muck');
        next = setVisibility(next, card.id, { type: 'HIDDEN' });
      }
    }
    // 烧牌回牌堆；公共牌留在桌上——结算画面要看完整牌面，下一手 start 时统一收。
    for (const cardId of [...(next.zones.zone_burn?.orderedEntities ?? [])]) {
      next = ECSManager.moveEntity(next, cardId, 'zone_deck');
      next = setVisibility(next, cardId, { type: 'HIDDEN' });
    }
    for (const pid of next.playerOrder) {
      const chips = chipsOf(next, pid);
      if (chips <= 0) continue;
      next = patchPlayer(next, pid, player => ({
        ...player,
        alive: true,
        status: 'ACTIVE',
        customProps: { ...player.customProps, inHand: false, busted: false }
      }));
    }
    // 输光的座位立刻补人：真人转观察者、AI 换新 AI，牌桌不散场。
    next = refillBustedSeats(next);
    // 本轮结束：观察者的换桌申请现在生效。
    next = applyObserverSwaps(next);
    const seat = seatAfter(next.playerOrder, hand.buttonSeat, pid => chipsOf(next, pid) > 0);
    return { ...next, activePlayerId: next.playerOrder[seat], phase: 'HAND_OVER' };
  }

  /* ---------------------------------------------------------------- */
  /* Semantic invariants (charter C-6)                                 */
  /* ---------------------------------------------------------------- */

  /**
   * 规则层守恒断言（宪章 C-6）。
   *
   * 内核的 `invariants.ts` 只保证状态**形状**没坏（61 条全是结构一致性）；
   * 这几条保证**规则没被违反**。它们是德扑这套规则自己的"物理定律"：
   *
   *  1. **筹码守恒**：每个座位手上的筹码 + 已进底池的筹码 = 常量（初始总额）。
   *     这是最该有、却一直没有的一条 —— 任何一次分池 / 摊牌 / 观察者补贴的
   *     记账错误都会在这里暴露，而不是等玩家发现"钱不对了"。
   *  2. **底池非负**：`pot` 与每一份 `handBets` 都不能是负数。
   *  3. **底池一致性**：`pot` 应等于已完成街道上 `streetBets` 之和的累计 ——
   *     这里用更弱的可判定形式：`pot >= 0` 且不大于全场 `handBets` 总和。
   *  4. **手号单调**：`handNo` 不回退。
   *
   * 必须纯：只读 state，不改任何东西，不调用 outcome()。
   */
  public static checkInvariants(state: GameState): string[] {
    const out: string[] = [];

    const hand = handOf(state);
    const seats = state.playerOrder;

    for (const pid of seats) {
      const chips = Number(state.players[pid]?.customProps?.chips ?? 0);
      if (!Number.isFinite(chips) || chips < 0) {
        out.push(`poker: seat ${pid} has negative or non-finite chips (${chips})`);
      }
    }

    if (hand) {
      if (!Number.isFinite(hand.pot) || hand.pot < 0) {
        out.push(`poker: pot is negative or non-finite (${hand.pot})`);
      }
      for (const [pid, amount] of Object.entries(hand.handBets ?? {})) {
        if (!Number.isFinite(amount) || amount < 0) {
          out.push(`poker: handBets[${pid}] is negative or non-finite (${amount})`);
        }
      }
      const handBetsTotal = Object.values(hand.handBets ?? {}).reduce((sum, n) => sum + n, 0);
      if (hand.pot > handBetsTotal + 1e-9) {
        out.push(`poker: pot (${hand.pot}) exceeds total committed chips (${handBetsTotal})`);
      }

      /*
       * 筹码守恒（真正的物理定律）：
       *
       *     在手筹码 + 已完成街道的底池 + 当前街道未结算的下注 = 初始总额
       *
       * 注意**不能**用 `handBets` 当"已下注"：它记录的是整手累计投入，已经
       * 结算进 `pot` 的部分同时还留在 `handBets` 里（见 `collectBets()`），
       * 直接相加会把翻前的死钱算两遍。当前街道的钱只算 `streetBets`。
       */
      const inHands = seats.reduce((sum, pid) => {
        const chips = Number(state.players[pid]?.customProps?.chips ?? 0);
        return sum + (Number.isFinite(chips) ? chips : 0);
      }, 0);
      const streetUnsettled = Object.values(hand.streetBets ?? {}).reduce(
        (sum, n) => sum + (Number.isFinite(n) ? n : 0),
        0
      );
      const total = inHands + hand.pot + streetUnsettled;

      /*
       * 不假设总额是常量：破产座位会被补位 AI 顶替，每个新 AI 带着一份新的
       * `startingStack` 进场，所以总额**只增不减**。能断言的边界是：
       *
       *   下限：不超过每个座位一份初始筹码（否则说明凭空造钱）
       *   上限：破产补位最多让总额增长，但当前手牌 + 底池不该超过
       *         "初始总额 + 已补位人次 × 初始筹码"
       *
       * 补位次数从 `observers.aiSerial` 与 `lastHand` 推出太间接，这里用
       * 更朴素也更稳的口径：总额必须是 `startingStack` 的整数倍。
       * 任何半份筹码的漂移（分池取整错误、记账重复）都会破坏整除性。
       */
      const unit = POKER_DEFAULTS.startingStack;
      if (seats.length > 0 && Math.abs(total % unit) > 1e-6) {
        out.push(
          `poker: chip total ${total} is not a multiple of the ${unit}-chip buy-in — seats ${inHands} + pot ${hand.pot} + street ${streetUnsettled}`
        );
      }
      if (seats.length > 0 && total < unit) {
        out.push(`poker: chip total ${total} fell below one buy-in`);
      }
    }

    const lastHand = state.globalVars.lastHand as { handNo?: number } | undefined;
    if (hand && typeof lastHand?.handNo === 'number' && typeof hand.handNo === 'number') {
      if (hand.handNo < lastHand.handNo) {
        out.push(`poker: handNo regressed (${hand.handNo} < ${lastHand.handNo})`);
      }
    }

    return out;
  }

  /* ---------------------------------------------------------------- */
  /* Outcome                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * End condition.
   *
   * 牌局不再因为有人输光而结束：破产的座位由观察者机制接管——真人转观察者、
   * 座位由补位 AI 顶上，牌桌永远满员。这里保留 `Outcome` 的形状（房间生命周期
   * 仍需要一个「是否结束」的回答），但德州没有其它终止条件。
   */
  public static checkWinCondition(_state: GameState): {
    gameOver: boolean;
    winner: PlayerId | PlayerId[] | null;
    reason?: string;
  } {
    return { gameOver: false, winner: null };
  }
}
