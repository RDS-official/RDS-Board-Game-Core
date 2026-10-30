/* -------------------------------------------------------------------------- */
/* suite:splendor — moved verbatim from suite.ts */
/* -------------------------------------------------------------------------- */

import { UniversalGameEngine } from '@rds/kernel/engine';
import { canonicalize } from '@rds/kernel/serialize';
import { GAME_REGISTRY } from '@rds/games/registry';
import { SplendorRules } from '@rds/games/splendor/rules';
import { setupSplendor } from '@rds/games/splendor/setup';
import { test, assert, assertEqual } from '../testKit';
import { splendorPlace, splendorSeatModule, splendorEvolutionPair } from '../suiteHelpers';

/* 宝可梦璀璨宝石 (Pokémon Splendor)                                            */
/* -------------------------------------------------------------------------- */

test('fixture splendor: the bank is dealt by seat count and master balls are always five', () => {
  for (const [seats, perColor] of [[2, 4], [3, 5], [4, 7]] as const) {
    const state = setupSplendor(2024, seats);
    assertEqual(state.playerOrder.length, seats, `${seats}-seat table`);
    assertEqual(state.globalVars.playerCount, seats, `${seats}-seat count recorded`);
    for (const color of ['red', 'blue', 'black', 'pink', 'yellow']) {
      assertEqual(state.globalVars.bank[color], perColor, `${color} supply at ${seats} seats`);
    }
    assertEqual(state.globalVars.bank.purple, 5, `master balls are always 5 at ${seats} seats`);
  }
  assertEqual(setupSplendor(2024).playerOrder.length, 2, 'the default table is two seats');
});

test('fixture splendor: the same seed deals the same market', () => {
  const a = setupSplendor(99, 3);
  const b = setupSplendor(99, 3);
  const c = setupSplendor(100, 3);
  assertEqual(
    a.zones.zone_market_t1.orderedEntities.join(','),
    b.zones.zone_market_t1.orderedEntities.join(','),
    'same seed ⇒ same opening row'
  );
  assert(
    a.zones.zone_market_t1.orderedEntities.join(',') !== c.zones.zone_market_t1.orderedEntities.join(','),
    'a different seed deals a different row'
  );
  assertEqual(a.prngState, b.prngState, 'the shuffle state is deterministic');
});

test('fixture splendor: each level reveals four cards and hides its deck', () => {
  const state = setupSplendor(7, 2);
  for (const tier of [1, 2, 3]) {
    assertEqual(state.zones[`zone_market_t${tier}`].orderedEntities.length, 4, `level ${tier} row holds 4`);
    for (const id of state.zones[`zone_market_t${tier}`].orderedEntities) {
      assertEqual(state.entities[id].visibility.type, 'PUBLIC', `level ${tier} market card is public`);
    }
  }
  assertEqual(state.zones.zone_deck_s1.orderedEntities.length, 35 - 4, 'stage-1 deck after the opening');
  assertEqual(state.zones.zone_deck_s2.orderedEntities.length, 30 - 4, 'stage-2 deck after the opening');
  assertEqual(state.zones.zone_deck_s3.orderedEntities.length, 15 - 4, 'stage-3 deck after the opening');
  for (const id of state.zones.zone_deck_s1.orderedEntities) {
    assertEqual(state.entities[id].visibility.type, 'HIDDEN', 'deck cards stay face down');
  }
  assertEqual(state.zones.zone_rare.orderedEntities.length, 1, 'one rare Pokémon is revealed');
  assertEqual(state.zones.zone_legend.orderedEntities.length, 1, 'one legendary Pokémon is revealed');
});

test('fixture splendor: rare and legendary Pokémon need a master ball and cannot be reserved', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.splendor, 5);
  const raw = engine.getRawState();

  for (const zoneId of ['zone_rare', 'zone_legend']) {
    const cardId = raw.zones[zoneId].orderedEntities[0];
    const cost = raw.entities[cardId].components.custom!.cost as Record<string, number>;
    assert(cost.purple >= 1, `${zoneId} card lists a master ball`);

    // Every other ball at the cap still cannot pay for it.
    for (const color of ['red', 'blue', 'black', 'pink', 'yellow']) {
      raw.players.p1.customProps.tokens[color] = 2;
    }
    const unaffordable = engine
      .getLegalActions('p1')
      .filter(action => action.type === 'BUY_CARD' && action.entityId === cardId);
    assertEqual(unaffordable.length, 0, `${zoneId} is unaffordable without a master ball`);

    const reservable = engine
      .getLegalActions('p1')
      .filter(action => action.type === 'RESERVE_CARD' && action.entityId === cardId);
    assertEqual(reservable.length, 0, `${zoneId} cannot be reserved`);

    if (zoneId === 'zone_rare') {
      // With one master ball it becomes legal, and paying consumes it.
      const rareCost = cost;
      for (const [color, count] of Object.entries(rareCost)) {
        raw.players.p1.customProps.tokens[color] = count;
      }
      const buy = engine.dispatch({ type: 'BUY_CARD', playerId: 'p1', entityId: cardId });
      assert(buy.ok, `rare Pokémon is caught with a master ball (${buy.error ?? 'ok'})`);
      assertEqual(engine.getRawState().players.p1.customProps.tokens.purple, 0, 'the master ball is spent');
    }
  }
});

test('fixture splendor: master balls substitute for missing colours when buying', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.splendor, 5);
  const raw = engine.getRawState();
  const cardId = raw.zones.zone_market_t1.orderedEntities[0];
  const cost = raw.entities[cardId].components.custom!.cost as Record<string, number>;
  const total = Object.values(cost).reduce((sum, value) => sum + value, 0);

  // Master balls only — they stand in for every colour.
  const wild = Math.min(10, total);
  raw.players.p1.customProps.tokens.purple = wild;
  const buy = engine.dispatch({ type: 'BUY_CARD', playerId: 'p1', entityId: cardId });
  assert(buy.ok, `master balls pay for a card (${buy.error ?? 'ok'})`);
  assertEqual(engine.getRawState().players.p1.customProps.tokens.purple, wild - total, 'exactly the cost was spent');
});

test('fixture splendor: balls are conserved and never exceed ten', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.splendor, 2024);
  const raw = engine.getRawState();
  const supply = raw.globalVars.bank.red;

  assertEqual(raw.globalVars.bank.purple, 5, 'the master ball supply starts at five');
  const take = engine.getLegalActions('p1').find(action => action.type === 'TAKE_3_DIFF_GEMS');
  assert(!!take, 'taking balls is legal');
  assert(engine.dispatch(take!).ok, 'the take is accepted');
  assertEqual(engine.getRawState().globalVars.bank.red, supply - 1, 'the bank pays out');

  // Ten balls in hand leaves no room for another take.
  const player = engine.getRawState().players.p1;
  for (const color of ['red', 'blue', 'black', 'pink']) player.customProps.tokens[color] = 2;
  player.customProps.tokens.yellow = 2;
  assertEqual(
    Object.values(player.customProps.tokens).reduce<number>((sum, value) => sum + Number(value), 0),
    10,
    'the player holds ten balls'
  );
  const takes = engine
    .getLegalActions('p1')
    .filter(action => action.type === 'TAKE_3_DIFF_GEMS' || action.type === 'TAKE_2_SAME_GEMS');
  assertEqual(takes.length, 0, 'no take is offered at the cap');
});

test('fixture splendor: evolution buries the base Pokémon and costs no balls', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.splendor, 5);
  const raw = engine.getRawState();
  const { base, evolution } = splendorEvolutionPair(raw);
  const evoCost = base.components.custom!.evoCost as { color: string; count: number };

  splendorPlace(raw, base.id, 'zone_tableau_p1');
  splendorPlace(raw, evolution.id, 'zone_market_t2');
  raw.players.p1.customProps.bonuses = { red: 0, blue: 0, black: 0, pink: 0, yellow: 0, purple: 0 };
  raw.players.p1.customProps.bonuses[evoCost.color] = evoCost.count - 1;
  assertEqual(SplendorRules.evolutionOptions(raw, 'p1').length, 0, 'a missing bonus blocks the evolution');

  raw.players.p1.customProps.bonuses[evoCost.color] = evoCost.count;
  assertEqual(SplendorRules.evolutionOptions(raw, 'p1').length, 1, 'meeting the bonus unlocks one evolution');

  raw.players.p1.customProps.tokens = { red: 2, blue: 1, black: 0, pink: 0, yellow: 0, purple: 1 };
  const tokensBefore = canonicalize(raw.players.p1.customProps.tokens);
  const bankBefore = canonicalize(raw.globalVars.bank);
  const turnBefore = raw.turn;

  const evolve = engine.dispatch({ type: 'EVOLVE', playerId: 'p1', payload: { fromId: base.id, toId: evolution.id } });
  assert(evolve.ok, `evolution is accepted (${evolve.error ?? 'ok'})`);
  const next = engine.getRawState();

  assertEqual(canonicalize(next.players.p1.customProps.tokens), tokensBefore, 'evolution spends no balls');
  assertEqual(canonicalize(next.globalVars.bank), bankBefore, 'evolution does not touch the bank');
  assertEqual(next.turn, turnBefore, 'evolution does not consume the turn');
  assertEqual(next.activePlayerId, 'p1', 'evolution is not an action');
  assertEqual(next.globalVars.evolvedThisTurn, true, 'the once-per-turn flag is set');
  assertEqual(next.zones.zone_buried_p1.orderedEntities.join(','), base.id, 'the base Pokémon is buried');
  assertEqual(next.zones.zone_tableau_p1.orderedEntities.join(','), evolution.id, 'the evolution takes the field');
  assertEqual(
    (next.players.p1.customProps.buriedIds as string[]).join(','),
    base.id,
    'the buried card is recorded'
  );
  assertEqual(next.players.p1.score, next.entities[evolution.id].components.custom!.vp, 'only the evolution scores');
  assertEqual(
    SplendorRules.evolutionOptions(next, 'p1').length,
    0,
    'a second evolution in the same turn is refused'
  );
});

test('fixture splendor: an evolution still available at turn end resolves for free', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.splendor, 5);
  const raw = engine.getRawState();
  const { base, evolution } = splendorEvolutionPair(raw);
  const evoCost = base.components.custom!.evoCost as { color: string; count: number };

  splendorPlace(raw, base.id, 'zone_tableau_p1');
  splendorPlace(raw, evolution.id, 'zone_market_t2');
  raw.players.p1.customProps.bonuses[evoCost.color] = evoCost.count;
  assert(SplendorRules.evolutionOptions(raw, 'p1').length > 0, 'an evolution is waiting');

  const take = engine.getLegalActions('p1').find(action => action.type === 'TAKE_3_DIFF_GEMS');
  assert(!!take, 'a normal action is available');
  assert(engine.dispatch(take!).ok, 'the action is accepted');

  const next = engine.getRawState();
  assertEqual(next.zones.zone_buried_p1.orderedEntities.join(','), base.id, 'the evolution settled by itself');
  assertEqual(next.zones.zone_tableau_p1.orderedEntities.join(','), evolution.id, 'the evolution is on the field');
  assertEqual(next.globalVars.evolvedThisTurn, false, 'the flag is cleared for the next player');
});

test('fixture splendor: reaching the score goal plays out the round first', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.splendor, 5);
  const raw = engine.getRawState();

  // Build a tableau worth 15 VP, then catch a 5 VP Pokémon for the trigger.
  const pool = Object.values(raw.entities)
    .filter(card => card.zoneId.startsWith('zone_deck_s') && !card.components.custom?.evolvesTo)
    .sort((a, b) => Number(b.components.custom?.vp ?? 0) - Number(a.components.custom?.vp ?? 0));
  let vp = 0;
  for (const card of pool) {
    if (vp >= 15) break;
    splendorPlace(raw, card.id, 'zone_tableau_p1');
    vp += Number(card.components.custom?.vp ?? 0);
  }
  assert(vp >= 15, `the tableau is worth enough (${vp})`);
  const finisher = Object.values(raw.entities).find(
    card => card.zoneId === 'zone_deck_s3' && Number(card.components.custom?.vp ?? 0) >= 5
  );
  assert(!!finisher, 'a 5 VP stage-3 Pokémon is available');
  splendorPlace(raw, finisher!.id, 'zone_market_t3');
  for (const color of ['red', 'blue', 'black', 'pink', 'yellow']) {
    raw.players.p1.customProps.bonuses[color] = 10;
  }

  const buy = engine.dispatch({ type: 'BUY_CARD', playerId: 'p1', entityId: finisher!.id });
  assert(buy.ok, `the trigger card is caught (${buy.error ?? 'ok'})`);

  const afterBuy = engine.getRawState();
  assert(afterBuy.players.p1.score >= 18, `the player reached the goal (${afterBuy.players.p1.score})`);
  assertEqual(afterBuy.globalVars.lastRound, true, 'the final round is flagged');
  assertEqual(afterBuy.gameOver, false, 'the game does not stop on the spot');
  assertEqual(afterBuy.activePlayerId, 'p2', 'the next seat still plays');

  const lastTurn = engine.getLegalActions('p2').find(action => action.type !== 'END_TURN');
  assert(!!lastTurn, 'the last seat has a move');
  assert(engine.dispatch(lastTurn!).ok, 'the last seat plays');

  const ended = engine.getRawState();
  assertEqual(ended.gameOver, true, 'the game ends when the round wrapped');
  assertEqual(ended.winner, 'p1', 'the highest score wins');
  assert(/🏆/.test(ended.winnerReason ?? ''), 'the outcome explains itself');
  // Replay is asserted by the stochastic test below: this position is built by
  // writing into the raw state, so it is not an action-log position.
});

test('fixture splendor: ties break on buried Pokémon, then on cards in play', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.splendor, 5);
  const raw = engine.getRawState();
  raw.players.p1.score = 20;
  raw.players.p2.score = 20;
  raw.players.p1.customProps.buriedIds = ['b1'];
  raw.globalVars.finalRoundComplete = true;
  assertEqual(SplendorRules.checkWinCondition(raw).winner, 'p1', 'more buried Pokémon wins the tie');

  const equal = engine.getRawState();
  equal.players.p1.customProps.buriedIds = ['b1'];
  equal.players.p2.customProps.buriedIds = ['b2'];
  const fielded = Object.values(equal.entities)
    .filter(card => card.zoneId === 'zone_deck_s1' && card.components.custom?.pkmnTier === 'stage1')
    .slice(0, 2);
  for (const card of fielded) splendorPlace(equal, card.id, 'zone_tableau_p2');
  assertEqual(SplendorRules.checkWinCondition(equal).winner, 'p2', 'more cards in play breaks the tie');
});

test('fixture splendor: full games stay legal and replay bit-exactly at every seat count', () => {
  for (const seats of [2, 3, 4]) {
    for (const seed of [1, 99, 2024]) {
      const engine = new UniversalGameEngine(splendorSeatModule(seats), seed);
      let steps = 0;
      let rng = seed * 7919;
      const rand = (n: number): number => {
        rng = (rng * 1103515245 + 12345) & 0x7fffffff;
        return rng % n;
      };

      while (!engine.getRawState().gameOver && steps < 1500) {
        const focus = engine.getFocusActors();
        if (focus.length === 0) break;
        const legal = engine.getLegalActions(focus[0]);
        assert(legal.length > 0, `${seats}p seed ${seed}: the active seat always has a move`);
        // Prefer real actions so END_TURN stays an escape hatch.
        const real = legal.filter(action => action.type !== 'END_TURN');
        const pick = real.length > 0 ? real[rand(real.length)] : legal[0];
        const result = engine.dispatch(pick);
        assert(result.ok, `${seats}p seed ${seed}: ${pick.type} accepted (${result.error ?? 'ok'})`);
        steps += 1;
      }

      const state = engine.getRawState();
      assertEqual(state.gameOver, true, `${seats}p seed ${seed}: the game reaches an end in ${steps} steps`);
      assertEqual(state.playerOrder.length, seats, `${seats}p seed ${seed}: seat count`);

      // Ball conservation per colour, and the 10-ball cap.
      const perColor = seats === 2 ? 4 : seats === 3 ? 5 : 7;
      for (const color of ['red', 'blue', 'black', 'pink', 'yellow']) {
        const held = Object.values(state.players).reduce(
          (sum, player) => sum + Number(player.customProps.tokens[color] ?? 0),
          0
        );
        assertEqual(held + state.globalVars.bank[color], perColor, `${seats}p seed ${seed}: ${color} conserved`);
      }
      const masterBalls = Object.values(state.players).reduce(
        (sum, player) => sum + Number(player.customProps.tokens.purple ?? 0),
        0
      );
      assertEqual(masterBalls + state.globalVars.bank.purple, 5, `${seats}p seed ${seed}: master balls conserved`);

      for (const pid of state.playerOrder) {
        const player = state.players[pid];
        const held = Object.values(player.customProps.tokens).reduce<number>(
          (sum, value) => sum + Number(value),
          0
        );
        assert(held <= 10, `${seats}p seed ${seed}: ${pid} is within the 10-ball cap`);
        assertEqual(
          state.zones[`zone_hand_${pid}`].orderedEntities.length <= 3,
          true,
          `${seats}p seed ${seed}: ${pid} respects the reserve limit`
        );

        // Buried cards never linger and never score; the score equals the tableau.
        const buried = new Set((player.customProps.buriedIds as string[]) ?? []);
        const field = state.zones[`zone_tableau_${pid}`].orderedEntities;
        for (const id of field) assert(!buried.has(id), `${seats}p seed ${seed}: ${pid} has no buried card on the field`);
        const tableauVp = field.reduce(
          (sum, id) => sum + Number(state.entities[id]?.components.custom?.vp ?? 0),
          0
        );
        assertEqual(player.score, tableauVp, `${seats}p seed ${seed}: ${pid} score matches its tableau`);
      }

      const replay = engine.verifyReplay();
      assert(replay.ok, `${seats}p seed ${seed}: replay is bit-exact (${replay.errors.slice(0, 2).join(' | ')})`);
    }
  }
});

/* -------------------------------------------------------------------------- */
