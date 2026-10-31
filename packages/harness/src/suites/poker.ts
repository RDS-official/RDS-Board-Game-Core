/* -------------------------------------------------------------------------- */
/* suite:poker — Texas Hold'em fixture                                        */
/* -------------------------------------------------------------------------- */

import { UniversalGameEngine } from '@rds/kernel/engine';
import { withDefaultPayload } from '@rds/kernel/actionPayload';
import type { GameState } from '@rds/kernel/types';
import { GAME_REGISTRY } from '@rds/games/registry';
import { buildPots, splitAmount } from '@rds/games/poker/betting';
import type { Card, Suit } from '@rds/games/poker/cards';
import { evaluateSeven } from '@rds/games/poker/handEval';
import type { PokerHandState } from '@rds/games/poker/rules';
import { assert, assertEqual, test } from '../testKit';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const RANK_CODES: Record<string, number> = { A: 14, K: 13, Q: 12, J: 11, T: 10 };

/** `As` → `card_s14`, matching the fixture's entity ids. */
function cardEntityId(code: string): string {
  const suit = code.slice(-1).toLowerCase();
  const rankText = code.slice(0, -1).toUpperCase();
  const rank = RANK_CODES[rankText] ?? Number(rankText);
  return `card_${suit}${rank}`;
}

function card(code: string): Card {
  const id = cardEntityId(code);
  const suit = code.slice(-1).toLowerCase() as Suit;
  const rankText = code.slice(0, -1).toUpperCase();
  return { id, suit, rank: RANK_CODES[rankText] ?? Number(rankText) };
}

/** Put specific cards on top of the deck, in the order they will be dealt. */
function stackDeck(state: GameState, codes: string[]): void {
  const ids = codes.map(cardEntityId);
  for (const id of ids) {
    const entity = state.entities[id];
    if (!entity || entity.zoneId === 'zone_deck') continue;
    const from = state.zones[entity.zoneId];
    if (from) from.orderedEntities = from.orderedEntities.filter(other => other !== id);
    entity.zoneId = 'zone_deck';
  }
  const zone = state.zones.zone_deck;
  zone.orderedEntities = [...ids, ...zone.orderedEntities.filter(id => !ids.includes(id))];
}

/** Swap the seat's hole cards for the given cards, wherever they currently sit. */
function giveHoleCards(state: GameState, playerId: string, codes: string[]): void {
  const zone = state.zones[`zone_hand_${playerId}`];
  codes.forEach((code, index) => {
    const wantedId = cardEntityId(code);
    const currentId = zone.orderedEntities[index];
    if (!currentId || currentId === wantedId) return;
    const wanted = state.entities[wantedId];
    const current = state.entities[currentId];
    if (!wanted || !current) return;
    const wantedZone = state.zones[wanted.zoneId];
    if (!wantedZone) return;
    const wantedIndex = wantedZone.orderedEntities.indexOf(wantedId);
    if (wantedIndex < 0) return;
    wantedZone.orderedEntities[wantedIndex] = currentId;
    zone.orderedEntities[index] = wantedId;
    wanted.zoneId = zone.id;
    current.zoneId = wantedZone.id;
  });
}

function setChips(state: GameState, playerId: string, chips: number): void {
  state.players[playerId].customProps.chips = chips;
  state.players[playerId].score = chips;
}

function hand(state: GameState): PokerHandState {
  return state.globalVars.hand as PokerHandState;
}

function startHand(engine: UniversalGameEngine): void {
  const actor = engine.getActiveActorId();
  const result = engine.dispatch({ type: 'START_HAND', playerId: actor });
  assert(result.ok, `START_HAND accepted: ${result.error ?? ''}`);
}

/** Dispatch the named action for whoever is on turn. */
function act(engine: UniversalGameEngine, type: string, payload?: Record<string, unknown>): void {
  const actor = engine.getActiveActorId();
  const result = engine.dispatch({ type, playerId: actor, ...(payload ? { payload } : {}) });
  assert(result.ok, `${type} by ${actor} accepted: ${result.error ?? ''}`);
}

/** Everyone still able to act checks or calls, until the street is decided. */
function callAround(engine: UniversalGameEngine, times: number): void {
  for (let i = 0; i < times; i++) {
    const legal = engine.getLegalActions(engine.getActiveActorId());
    const call = legal.find(action => action.type === 'CALL');
    const check = legal.find(action => action.type === 'CHECK');
    if (call) act(engine, 'CALL', call.payload as Record<string, unknown>);
    else if (check) act(engine, 'CHECK');
    else return;
  }
}

/* -------------------------------------------------------------------------- */
/* Hand evaluation                                                             */
/* -------------------------------------------------------------------------- */

test('poker: every hand category is recognised', () => {
  const cases: [string, string[]][] = [
    ['皇家同花顺', ['As', 'Ks', 'Qs', 'Js', '10s', '2h', '3d']],
    ['同花顺', ['9h', '8h', '7h', '6h', '5h', 'Ad', '2c']],
    ['四条', ['Qh', 'Qd', 'Qc', 'Qs', '7h', '3d', '2c']],
    ['葫芦', ['7h', '7d', '7c', 'Kh', 'Kd', '3s', '2c']],
    ['同花', ['Ah', 'Jh', '8h', '5h', '2h', 'Kd', 'Qs']],
    ['顺子', ['9h', '8d', '7c', '6s', '5h', 'Ad', 'Kc']],
    ['三条', ['Jh', 'Jd', 'Jc', '9s', '4h', '2d', '3c']],
    ['两对', ['Ah', 'Ad', '8c', '8s', '4h', '2d', '3c']],
    ['一对', ['Jh', 'Jd', '9c', '6s', '4h', '2d', '3c']],
    ['高牌', ['Ah', 'Jd', '9c', '6s', '4h', '2d', '3c']]
  ];
  for (const [label, codes] of cases) {
    const value = evaluateSeven(codes.map(card));
    assertEqual(value.label, label, `${codes.join(' ')} → ${label}`);
  }
});

test('poker: the ace plays low in the wheel and high in a broadway straight', () => {
  const wheel = evaluateSeven(['Ah', '2d', '3c', '4s', '5h', 'Kd', '9c'].map(card));
  assertEqual(wheel.label, '顺子', 'A-2-3-4-5 is a straight');
  assertEqual(wheel.tiebreak[0], 5, 'the wheel is five-high');

  const broadway = evaluateSeven(['Ah', 'Kd', 'Qc', 'Js', '10h', '2d', '3c'].map(card));
  assertEqual(broadway.tiebreak[0], 14, 'A-K-Q-J-10 is ace-high');
});

test('poker: kickers break ties inside a category', () => {
  const acePair = evaluateSeven(['Ah', 'Ad', '9c', '6s', '4h', '2d', '3c'].map(card));
  const kingPair = evaluateSeven(['Kh', 'Kd', '9c', '6s', '4h', '2d', '3c'].map(card));
  assert(acePair.tiebreak[0] > kingPair.tiebreak[0], 'pair of aces beats pair of kings');

  const flushHigh = evaluateSeven(['Ah', 'Jh', '8h', '5h', '2h', 'Kd', 'Qs'].map(card));
  const flushLow = evaluateSeven(['Kh', 'Jh', '8h', '5h', '2h', 'Ad', 'Qs'].map(card));
  assert(flushHigh.tiebreak[0] > flushLow.tiebreak[0], 'flush compares the top card');
});

/* -------------------------------------------------------------------------- */
/* Pot maths                                                                   */
/* -------------------------------------------------------------------------- */

test('poker: side pots layer by contribution and refund the uncalled bet', () => {
  const pots = buildPots({ p1: 100, p2: 300, p3: 300, p4: 50 }, ['p4']);
  assertEqual(pots.length, 2, 'two live layers');
  assertEqual(pots[0].amount, 350, 'main pot = 4 × 50 + 3 × 50');
  assertEqual(pots[0].eligible.join(','), 'p1,p2,p3', 'the folded seat cannot win the main pot');
  assertEqual(pots[1].amount, 400, 'side pot = 2 × 200');
  assertEqual(pots[1].eligible.join(','), 'p2,p3', 'only the two matching seats contest the side pot');

  const uncalled = buildPots({ p1: 100, p2: 10 }, []);
  assertEqual(uncalled.length, 2, 'the excess forms its own layer');
  assertEqual(uncalled[1].amount, 90, 'uncalled chips come back to the bettor');
  assertEqual(uncalled[1].eligible.join(','), 'p1', 'only the bettor is eligible');
});

test('poker: odd chips go to the first winner left of the button', () => {
  const award = splitAmount(25, ['p1', 'p2'], ['p1', 'p2', 'p3', 'p4'], 0);
  assertEqual(award.p2, 13, 'small blind seat takes the odd chip');
  assertEqual(award.p1, 12, 'button seat takes the remainder');
});

/* -------------------------------------------------------------------------- */
/* Blinds, order and legality                                                  */
/* -------------------------------------------------------------------------- */

test('poker: heads-up puts the button on the small blind and leads pre-flop', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.poker, 11, { scenario: 'seats_2' });
  startHand(engine);
  const state = engine.getRawState();
  const current = hand(state);

  assertEqual(current.buttonSeat, 0, 'first hand button is seat 0');
  assertEqual(current.sbSeat, 0, 'heads-up: the button posts the small blind');
  assertEqual(current.bbSeat, 1, 'heads-up: the other seat posts the big blind');
  assertEqual(current.streetBets.p1, 5, 'small blind posted');
  assertEqual(current.streetBets.p2, 10, 'big blind posted');
  assertEqual(engine.getActiveActorId(), 'p1', 'the button acts first heads-up');

  const legal = engine.getLegalActions('p1');
  const call = legal.find(action => action.type === 'CALL');
  assert(!!call, 'the small blind can call');
  assertEqual((call as { payload?: { amount?: number } }).payload?.amount, 5, 'call amount completes the blind');
});

test('poker: the seat left of the big blind leads a full ring', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.poker, 7, { scenario: 'seats_4' });
  startHand(engine);
  const current = hand(engine.getRawState());
  assertEqual(current.buttonSeat, 0, 'button on seat 0');
  assertEqual(current.sbSeat, 1, 'small blind left of the button');
  assertEqual(current.bbSeat, 2, 'big blind left of the small blind');
  assertEqual(engine.getActiveActorId(), 'p4', 'under the gun leads');
});

test('poker: raises below the minimum are rejected', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.poker, 7, { scenario: 'seats_4' });
  startHand(engine);
  const actor = engine.getActiveActorId();

  const tooSmall = engine.dispatch({ type: 'RAISE', playerId: actor, payload: { amount: 15 } });
  assert(!tooSmall.ok, 'a raise to 15 is below the 20 minimum');
  assert(/最小加注/.test(tooSmall.error ?? ''), `error explains the minimum: ${tooSmall.error}`);

  const aboveStack = engine.dispatch({ type: 'RAISE', playerId: actor, payload: { amount: 5000 } });
  assert(!aboveStack.ok, 'a raise beyond the stack is rejected');

  const legal = engine.dispatch({ type: 'RAISE', playerId: actor, payload: { amount: 20 } });
  assert(legal.ok, `a minimum raise is accepted: ${legal.error}`);
  assertEqual(hand(engine.getRawState()).currentBet, 20, 'the table is raised to 20');
});

test('poker: a short all-in raise does not reopen the betting', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.poker, 7, { scenario: 'seats_4' });
  const raw = engine.getRawState();
  setChips(raw, 'p4', 45);
  startHand(engine);

  act(engine, 'CALL', { amount: 10 }); // p4 completes the blind
  const raiser = engine.getActiveActorId();
  act(engine, 'RAISE', { amount: 40 }); // p1 raises to 40, increment 30
  act(engine, 'FOLD'); // p2
  act(engine, 'CALL', { amount: 30 }); // p3
  act(engine, 'ALL_IN'); // p4 shoves 45, increment 5 < 30

  assertEqual(hand(engine.getRawState()).currentBet, 45, 'the all-in still raises the amount to call');
  assertEqual(engine.getActiveActorId(), raiser, 'action returns to the original raiser');

  const legal = engine.getLegalActions(raiser).map(action => action.type);
  assert(!legal.includes('RAISE'), 'an incomplete raise does not reopen raising');
  assert(legal.includes('CALL'), 'the raiser may still call the difference');
  assert(legal.includes('FOLD'), 'the raiser may fold');
});

/* -------------------------------------------------------------------------- */
/* Showdown, split pot and end condition                                       */
/* -------------------------------------------------------------------------- */

test('poker: a shared royal flush splits the pot evenly', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.poker, 3, { scenario: 'seats_4' });
  startHand(engine);
  const raw = engine.getRawState();
  // Distinct hole cards so the stacked board never steals a dealt card.
  giveHoleCards(raw, 'p1', ['3c', '4c']);
  giveHoleCards(raw, 'p2', ['5c', '6c']);
  giveHoleCards(raw, 'p3', ['7d', '8d']);
  giveHoleCards(raw, 'p4', ['9c', 'Jd']);
  // burn, flop, burn, turn, burn, river
  stackDeck(raw, ['2c', 'As', 'Ks', 'Qs', '3d', 'Js', '4h', '10s']);

  callAround(engine, 4); // pre-flop
  callAround(engine, 4); // flop
  callAround(engine, 4); // turn
  callAround(engine, 4); // river

  const state = engine.getRawState();
  const result = state.globalVars.lastHand as {
    pots: { amount: number; winners: string[]; label: string }[];
    endedBy: string;
  };
  assertEqual(result.endedBy, 'SHOWDOWN', 'the hand went to showdown');
  assertEqual(result.pots.length, 1, 'a single pot with no all-ins');
  assertEqual(result.pots[0].amount, 40, 'four seats put in ten each');
  assertEqual(result.pots[0].winners.length, 4, 'the board plays for everyone');
  assertEqual(result.pots[0].label, '皇家同花顺', 'the shared board is a royal flush');
  for (const pid of state.playerOrder) {
    assertEqual(state.players[pid].customProps.chips, 1000, `${pid} got its chips back`);
  }
});

test('poker: everyone folding hands the pot to the last seat standing', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.poker, 13, { scenario: 'seats_4' });
  startHand(engine);
  act(engine, 'FOLD'); // p4
  act(engine, 'FOLD'); // p1
  act(engine, 'FOLD'); // p2

  const state = engine.getRawState();
  assertEqual(hand(state).street, 'COMPLETE', 'the hand is over after three folds');
  assertEqual(state.players.p3.customProps.chips, 1005, 'the big blind collects 5 + 10');
  assertEqual(state.players.p2.customProps.chips, 995, 'the small blind loses its blind');
  assertEqual(state.players.p1.customProps.chips, 1000, 'the button folded for free');
  const result = state.globalVars.lastHand as { endedBy: string };
  assertEqual(result.endedBy, 'FOLD', 'the hand ended without a showdown');
});

test('poker: the button moves clockwise and the blinds follow it', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.poker, 17, { scenario: 'seats_4' });
  startHand(engine);
  const first = hand(engine.getRawState());
  assertEqual(first.buttonSeat, 0, 'first hand button');

  act(engine, 'FOLD');
  act(engine, 'FOLD');
  act(engine, 'FOLD');
  assertEqual(hand(engine.getRawState()).street, 'COMPLETE', 'hand one is over');

  startHand(engine);
  const second = hand(engine.getRawState());
  assertEqual(second.buttonSeat, 1, 'the button moved one seat');
  assertEqual(second.sbSeat, 2, 'small blind follows the button');
  assertEqual(second.bbSeat, 3, 'big blind follows the small blind');
  assertEqual(second.handNo, 2, 'the hand counter advanced');
});

test('poker: a busted seat ends the game with the richest stack winning', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.poker, 23, { scenario: 'short_stack' });
  const raw = engine.getRawState();
  assertEqual(raw.players.p4.customProps.chips, 60, 'the short stack starts at 60');

  // The short seat loses an all-in to the deepest stack.
  startHand(engine);
  giveHoleCards(raw, 'p4', ['7c', '2d']);
  giveHoleCards(raw, 'p1', ['Ah', 'Ad']);
  stackDeck(raw, ['2c', 'Ac', '9h', '5s', '3d', 'Kd', '4h', '8h']);

  act(engine, 'ALL_IN'); // p4 shoves its last 60
  act(engine, 'CALL', { amount: 60 }); // p1 comes along
  act(engine, 'FOLD'); // p2
  act(engine, 'FOLD'); // p3

  const state = engine.getRawState();
  assertEqual(state.players.p4.customProps.chips, 0, 'the short stack is felted');
  assert(state.gameOver, 'the session ends as soon as a seat busts');
  assertEqual(state.winner, 'p1', 'the biggest remaining stack wins');
  assert(/输光筹码/.test(state.winnerReason ?? ''), `reason names the bust: ${state.winnerReason}`);
});

test('poker: a raise keeps the street open until every seat has matched it', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.poker, 41, { scenario: 'seats_4' });
  startHand(engine);

  // Under the gun raises to 60; the flop must not appear yet.
  act(engine, 'RAISE', { amount: 60 });
  assertEqual(hand(engine.getRawState()).street, 'PREFLOP', 'a raise cannot open the flop');

  // Button calls (50 more) — still pre-flop.
  callAround(engine, 1);
  assertEqual(hand(engine.getRawState()).street, 'PREFLOP', 'one caller is not a closed round');

  // Small blind calls (55 more) — the big blind still owes 50, so no deal.
  callAround(engine, 1);
  const waiting = engine.getRawState();
  assertEqual(hand(waiting).street, 'PREFLOP', 'the street stays open while the big blind owes chips');
  assertEqual(engine.getActiveActorId(), 'p3', 'the big blind still has to act');
  assertEqual(waiting.zones.zone_board.orderedEntities.length, 0, 'no community cards before the round closes');

  // Big blind matches, and only now does the flop come out.
  callAround(engine, 1);
  const dealt = engine.getRawState();
  assertEqual(hand(dealt).street, 'FLOP', 'the flop arrives once every seat has matched');
  assertEqual(dealt.zones.zone_board.orderedEntities.length, 3, 'three community cards dealt');
  assertEqual(hand(dealt).pot, 240, 'four seats put in 60 each');
  for (const pid of dealt.playerOrder) {
    assertEqual(hand(dealt).streetBets[pid], 0, `${pid} starts the flop with nothing owed`);
  }
});

test('poker: a short all-in still has to be matched before the next street', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.poker, 43, { scenario: 'seats_4' });
  const raw = engine.getRawState();
  setChips(raw, 'p4', 45);
  startHand(engine);

  act(engine, 'CALL', { amount: 10 }); // p4 completes the blind
  act(engine, 'RAISE', { amount: 40 }); // p1 raises, increment 30
  act(engine, 'FOLD'); // p2
  act(engine, 'CALL', { amount: 30 }); // p3
  act(engine, 'ALL_IN'); // p4 shoves 45: only 5 more than the current bet

  // The extra 5 chips are a real bet: the raiser has to call before the flop.
  assertEqual(hand(engine.getRawState()).street, 'PREFLOP', 'the short all-in keeps the round open');
  const legal = engine.getLegalActions(engine.getActiveActorId()).map(action => action.type);
  assert(legal.includes('CALL'), 'the raiser must call the remaining 5');
  assert(!legal.includes('RAISE'), 'but the incomplete raise does not reopen raising');

  callAround(engine, 1); // p1 calls the last 5
  const stillOpen = engine.getRawState();
  assertEqual(hand(stillOpen).street, 'PREFLOP', 'the big blind still owes the same 5');
  assertEqual(engine.getActiveActorId(), 'p3', 'the big blind is the last seat to match');

  callAround(engine, 1); // p3 calls the last 5
  const settled = engine.getRawState();
  assertEqual(hand(settled).street, 'FLOP', 'the flop only comes after everyone has called');
  assertEqual(hand(settled).pot, 140, '45 + 45 + 45 (all-in) + 5 (small blind folded)');
});

test('poker: two short all-ins that add up to a full raise reopen the betting', () => {
  // TDA "Multiple Short All-Ins": an incomplete raise on its own never reopens
  // the action, but several of them in the same round can add up to a full
  // raise — and then the seats that already acted may raise again.
  const engine = new UniversalGameEngine(GAME_REGISTRY.poker, 47, { scenario: 'seats_4' });
  const raw = engine.getRawState();
  setChips(raw, 'p4', 15);
  setChips(raw, 'p2', 20);
  startHand(engine);

  act(engine, 'ALL_IN'); // p4 shoves 15: only 5 over the big blind → short
  assertEqual(hand(engine.getRawState()).shortRaiseAccum, 5, 'the incomplete raise is banked');

  callAround(engine, 1); // p1 calls 15, so it has acted
  act(engine, 'ALL_IN'); // p2 shoves 20: 5 more, now 10 = a full raise

  const reopened = engine.getRawState();
  assertEqual(hand(reopened).shortRaiseAccum, 0, 'the accumulated short raises were consumed');
  assertEqual(hand(reopened).currentBet, 20, 'the amount to call is the last all-in');

  callAround(engine, 1); // p3 (big blind) calls the extra 10
  assertEqual(engine.getActiveActorId(), 'p1', 'the earlier caller faces the reopened action');
  const legal = engine.getLegalActions('p1').map(action => action.type);
  assert(legal.includes('RAISE'), 'a full raise worth of short all-ins reopens raising');
  assert(legal.includes('CALL'), 'and the seat may still just call the difference');
});

test('poker: an accumulated short-all-in reopen keeps the full-raise minimum', () => {
  // TDA 45 reopened action must NOT shrink the minimum raise: the two +5
  // short all-ins reopened the betting, but the last FULL raise was the big
  // blind (10), so the smallest raise is to 20 + 10 = 30 — not 20 + 5 = 25.
  const engine = new UniversalGameEngine(GAME_REGISTRY.poker, 53, { scenario: 'seats_4' });
  const raw = engine.getRawState();
  setChips(raw, 'p4', 15);
  setChips(raw, 'p2', 20);
  startHand(engine);

  act(engine, 'ALL_IN'); // p4 shoves 15 (+5 over the big blind)
  callAround(engine, 1); // p1 calls 15
  act(engine, 'ALL_IN'); // p2 shoves 20 (+5 more, 10 accumulated = full raise)
  callAround(engine, 1); // p3 completes to 20

  assertEqual(engine.getActiveActorId(), 'p1', 'p1 faces the reopened action');
  const tooSmall = engine.dispatch({ type: 'RAISE', playerId: 'p1', payload: { amount: 25 } });
  assert(!!tooSmall.error, 'a raise to 25 (last short increment as minimum) is rejected');
  act(engine, 'RAISE', { amount: 30 }); // 20 + lastRaiseSize 10 = the real minimum
  assertEqual(hand(engine.getRawState()).currentBet, 30, 'raising to the full-raise minimum works');
});

test('poker: one short all-in closes the street once everyone matches it', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.poker, 49, { scenario: 'seats_4' });
  const raw = engine.getRawState();
  setChips(raw, 'p4', 15);
  startHand(engine);

  act(engine, 'ALL_IN'); // p4 shoves 15: 5 over the big blind, short on its own
  assertEqual(hand(engine.getRawState()).shortRaiseAccum, 5, '5 chips are banked, not a full raise');
  callAround(engine, 1); // p1
  callAround(engine, 1); // p2
  callAround(engine, 1); // p3 completes to 15

  const flop = engine.getRawState();
  assertEqual(hand(flop).street, 'FLOP', 'matching the short all-in closes the round');
  assertEqual(hand(flop).pot, 60, 'four seats put in 15 each');
  assertEqual(hand(flop).shortRaiseAccum, 0, 'the accumulator resets with the street');
  assertEqual(engine.getActiveActorId(), 'p2', 'first live seat left of the button acts first after the flop');
  const legal = engine.getLegalActions('p2').map(action => action.type);
  assert(legal.includes('RAISE'), 'a new street restores full betting rights');
});

/* -------------------------------------------------------------------------- */
/* Hidden information and determinism                                          */
/* -------------------------------------------------------------------------- */

test('poker: hole cards are only visible to their owner', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.poker, 31, { scenario: 'seats_4' });
  startHand(engine);
  const raw = engine.getRawState();

  const mine = raw.zones.zone_hand_p1.orderedEntities;
  const theirs = raw.zones.zone_hand_p2.orderedEntities;
  const view = engine.getProjectedStateFor('p1');

  assertEqual(mine.length, 2, 'two hole cards dealt');
  for (const id of mine) {
    assertEqual(view.entities[id]?.isMasked, false, 'own card is readable');
  }
  for (const id of theirs) {
    const projected = view.entities[id];
    assert(projected === undefined || projected.isMasked === true, 'opponent card is masked');
    if (projected) {
      assertEqual(projected.components?.cardFace?.title, 'Hidden', 'masked face is blank');
    }
  }
});

test('poker: the same seed replays to the same state hash', () => {
  const play = (seed: number, scenario: string) => {
    const engine = new UniversalGameEngine(GAME_REGISTRY.poker, seed, { scenario });
    let steps = 0;
    while (steps < 60 && !engine.getRawState().gameOver) {
      const actor = engine.getActiveActorId();
      const legal = engine.getLegalActions(actor);
      if (legal.length === 0) break;
      const pick = legal.find(action => action.type === 'CALL') ?? legal[0];
      const result = engine.dispatch(withDefaultPayload(pick));
      if (!result.ok) break;
      steps++;
    }
    return { hash: engine.getStateHash(), steps, replay: engine.verifyReplay() };
  };

  const a = play(99, 'seats_4');
  const b = play(99, 'seats_4');
  assert(a.steps > 0, 'the game progressed');
  assertEqual(a.hash, b.hash, 'identical seeds produce identical states');
  assert(a.replay.ok, `replay verified: ${a.replay.errors.slice(0, 2).join(' | ')}`);
  assert(play(100, 'seats_4').hash !== a.hash, 'a different seed diverges');
});
