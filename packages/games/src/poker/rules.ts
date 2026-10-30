import { ECSManager } from '@rds/kernel/ecs';
import type { ReduceContext } from '@rds/kernel/module';
import { DeterministicPRNG } from '@rds/kernel/prng';
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
import { POKER_DEFAULTS } from './setup';

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
  community: string[];
  lastAggressor: string | null;
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
}

export interface PokerConfigValues {
  startingStack: number;
  smallBlind: number;
  bigBlind: number;
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

    if (hand.street === 'COMPLETE') {
      return playerId === state.activePlayerId ? [{ type: 'START_HAND', playerId }] : [];
    }
    if (playerId !== state.activePlayerId) return [];
    if (hand.folded.includes(playerId) || hand.allIn.includes(playerId)) return [];

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

    if (action.type === 'START_HAND') {
      const started = this.startHand(state, ctx);
      return { ...started, turn: state.turn + 1 };
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
        raised = true;
        reopened = increment >= hand.lastRaiseSize;
        label = `${nameOf(state, playerId)} ${hand.currentBet > 0 ? '加注到' : '下注'} ${target}`;
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

    const nextHand: PokerHandState = {
      ...hand,
      streetBets,
      handBets,
      allIn,
      folded,
      actedSinceRaise,
      currentBet: raised ? Math.max(hand.currentBet, streetBets[playerId]) : hand.currentBet,
      lastRaiseSize: reopened ? streetBets[playerId] - hand.currentBet : hand.lastRaiseSize,
      lastAggressor: raised ? playerId : hand.lastAggressor
    };

    let next = setChips(state, playerId, remaining);
    next = withHand(next, nextHand);
    next = pushLog(next, label);

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
      actedSinceRaise: []
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
      folded: [],
      allIn: [],
      community: [],
      lastAggressor: null
    };
    next = withHand(next, fresh);
    next = { ...next, phase: 'PREFLOP', round: handNo };

    // 5. Forced bets.
    next = this.postBlind(next, order[sbSeat], config.smallBlind);
    next = this.postBlind(next, order[bbSeat], config.bigBlind);

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
      actedSinceRaise: []
    });
    next = this.writeHandResult(next, { handNo: hand.handNo, endedBy: 'SHOWDOWN', pots: results, showdown });
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
    if (winnerId) next = setChips(next, winnerId, chipsOf(next, winnerId) + total);

    next = withHand(next, {
      ...(handOf(next) as PokerHandState),
      pot: 0,
      streetBets: zeros(next.playerOrder),
      currentBet: 0,
      street: 'COMPLETE',
      actedSinceRaise: []
    });

    if (winnerId) {
      next = this.writeHandResult(next, {
        handNo: hand.handNo,
        endedBy: 'FOLD',
        pots: [{ amount: total, winners: [winnerId], label: '其余玩家弃牌' }],
        showdown: []
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
    for (const pid of next.playerOrder) {
      const chips = chipsOf(next, pid);
      next = patchPlayer(next, pid, player => ({
        ...player,
        alive: chips > 0,
        status: chips > 0 ? 'ACTIVE' : 'ELIMINATED',
        customProps: { ...player.customProps, inHand: false, busted: chips <= 0 }
      }));
    }
    const seat = seatAfter(next.playerOrder, hand.buttonSeat, pid => chipsOf(next, pid) > 0);
    return { ...next, activePlayerId: next.playerOrder[seat], phase: 'HAND_OVER' };
  }

  /* ---------------------------------------------------------------- */
  /* Outcome                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * End condition: the hand settles, then any seat sitting on zero chips ends
   * the whole session. Checking only between hands keeps an all-in shove from
   * looking like a bust while the hand is still live.
   */
  public static checkWinCondition(state: GameState): {
    gameOver: boolean;
    winner: PlayerId | PlayerId[] | null;
    reason?: string;
  } {
    const hand = handOf(state);
    if (hand?.street !== 'COMPLETE') return { gameOver: false, winner: null };

    const busted = state.playerOrder.filter(pid => chipsOf(state, pid) <= 0);
    if (busted.length === 0) return { gameOver: false, winner: null };

    const solvent = state.playerOrder.filter(pid => chipsOf(state, pid) > 0);
    if (solvent.length === 0) {
      return { gameOver: true, winner: null, reason: '所有玩家都已输光筹码' };
    }
    const best = Math.max(...solvent.map(pid => chipsOf(state, pid)));
    const winners = solvent.filter(pid => chipsOf(state, pid) === best);
    return {
      gameOver: true,
      winner: winners.length === 1 ? winners[0] : winners,
      reason: `${nameOf(state, busted[0])} 输光筹码，牌局结束 · ${winners
        .map(pid => nameOf(state, pid))
        .join(' / ')} 以 ${best} 筹码领先`
    };
  }
}
