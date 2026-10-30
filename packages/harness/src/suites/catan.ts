/* -------------------------------------------------------------------------- */
/* suite:catan — moved verbatim from suite.ts */
/* -------------------------------------------------------------------------- */

import { UniversalGameEngine } from '@rds/kernel/engine'
import { DeterministicPRNG } from '@rds/kernel/prng'
import { GAME_REGISTRY } from '@rds/games/registry'
import { normalize, placeBuilding, placeRoad, portRatio } from '@rds/games/catan/helpers'
import { withDefaultPayload } from '@rds/kernel/actionPayload'
import { test, assert, assertEqual } from '../testKit';
import { playCatanSetup } from '../suiteHelpers';

test('fixture catan: snake setup, distance rule and phase gating', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.catan, 7);
  const initial = engine.getRawState();

  assertEqual(initial.phase, 'SETUP_SETTLEMENT', 'starts in setup');
  assertEqual((initial.globalVars.setupOrder as string[]).join(','), 'p1,p2,p3,p3,p2,p1', 'snake draft order');

  playCatanSetup(engine);
  const state = engine.getRawState();

  assertEqual(state.phase, 'ROLL', 'setup ends in roll phase');
  assertEqual(state.activePlayerId, 'p1', 'first player starts');

  for (const pid of state.playerOrder) {
    const own = Object.values(state.entities).filter(e => e.ownerId === pid && e.components.building);
    assertEqual(own.filter(e => e.components.building!.type === 'SETTLEMENT').length, 2, `${pid} has 2 settlements`);
    assertEqual(own.filter(e => e.components.building!.type === 'ROAD').length, 2, `${pid} has 2 roads`);
    assertEqual(state.players[pid].score, 2, `${pid} scores 2 from setup`);
  }

  assertEqual(engine.getLegalActions('p1').map(a => a.type).join(','), 'ROLL_DICE', 'only roll before action');
  assert(!engine.dispatch({ type: 'END_TURN', playerId: 'p1' }).ok, 'cannot end turn before rolling');
  assert(engine.verifyReplay().ok, 'setup replay is bit-exact');
});

test('fixture catan: rolling 7 opens robber flow and replay stays exact', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.catan, 3);
  playCatanSetup(engine);

  let sawSeven = false;
  for (let turn = 0; turn < 80; turn++) {
    if (engine.getRawState().gameOver) break;
    const state = engine.getRawState();
    if (state.phase !== 'ROLL') break;

    const pid = state.activePlayerId;
    assert(engine.dispatch({ type: 'ROLL_DICE', playerId: pid }).ok, 'roll accepted');
    if (Number(engine.getRawState().globalVars.diceSum) === 7) {
      sawSeven = true;
      break;
    }
    assert(engine.dispatch({ type: 'END_TURN', playerId: pid }).ok, 'end turn accepted');
  }

  assert(sawSeven, 'seed reaches a seven within 80 turns');

  let state = engine.getRawState();
  if (state.phase === 'DISCARD') {
    const window = state.pendingDecisions.find(w => w.status === 'OPEN');
    assert(!!window, 'discard window opened');
    for (const pid of window!.participants) {
      const result = engine.dispatch({ type: 'DISCARD_HALF', playerId: pid });
      assert(result.ok, `discard accepted for ${pid}`);
    }
    state = engine.getRawState();
  }

  assertEqual(state.phase, 'MOVE_ROBBER', 'seven leads to robber movement');
  const mover = state.activePlayerId;
  const previousHex = state.globalVars.robberHexId;
  const move = engine.getLegalActions(mover).find(a => a.type === 'MOVE_ROBBER');
  assert(!!move, 'robber move is legal');
  assert(engine.dispatch(move!).ok, 'robber moved');

  state = engine.getRawState();
  assert(state.globalVars.robberHexId !== previousHex, 'robber changed hex');

  if (state.phase === 'STEAL') {
    const steal = engine.getLegalActions(mover).find(a => a.type === 'STEAL_FROM');
    assert(!!steal, 'steal target available');
    assert(engine.dispatch(steal!).ok, 'steal accepted');
    state = engine.getRawState();
  }

  assertEqual(state.phase, 'ACTION', 'turn continues after robber');
  assert(engine.verifyReplay().ok, 'robber flow replay is bit-exact');
});

test('fixture catan: build costs, dev cards and bank conservation', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.catan, 21);
  playCatanSetup(engine);

  let state = engine.getRawState();
  state.phase = 'ACTION';
  state.turn = 5;
  state.activePlayerId = 'p1';

  for (const res of ['wood', 'brick', 'sheep', 'wheat', 'ore'] as const) {
    const current = Number(state.players.p1.customProps.resources[res] ?? 0);
    state.players.p1.customProps.resources[res] = 10;
    state.globalVars.bank[res] -= 10 - current;
  }

  const resourceTotal = () =>
    Object.values(engine.getRawState().players).reduce(
      (sum, player) =>
        sum + ['wood', 'brick', 'sheep', 'wheat', 'ore'].reduce((n, r) => n + Number(player.customProps.resources[r] ?? 0), 0),
      0
    ) + ['wood', 'brick', 'sheep', 'wheat', 'ore'].reduce((n, r) => n + Number(engine.getRawState().globalVars.bank[r] ?? 0), 0);

  const beforeTotal = resourceTotal();
  assertEqual(beforeTotal, 95, 'bank + hands always total 95');

  const road = engine.getLegalActions('p1').find(a => a.type === 'BUILD_ROAD');
  assert(!!road, 'road buildable with resources');
  assert(engine.dispatch(road!).ok, 'road built');
  state = engine.getRawState();
  assertEqual(state.players.p1.customProps.resources.wood, 9, 'road cost paid in wood');
  assertEqual(state.players.p1.customProps.resources.brick, 9, 'road cost paid in brick');
  assertEqual(resourceTotal(), 95, 'costs return to bank');

  const buy = engine.getLegalActions('p1').find(a => a.type === 'BUY_DEV_CARD');
  assert(!!buy, 'dev card buyable');
  assert(engine.dispatch(buy!).ok, 'dev card bought');

  state = engine.getRawState();
  const hand = state.zones.zone_dev_p1.orderedEntities;
  assertEqual(hand.length, 1, 'dev card moved to hand');
  const card = state.entities[hand[0]];
  const devType = card.components.custom?.devType as string;
  assertEqual(card.components.custom?.boughtTurn, 5, 'purchase turn recorded');
  assertEqual(resourceTotal(), 95, 'dev purchase conserves resources');
  assertEqual(
    engine.getLegalActions('p1').some(a => a.type.startsWith('PLAY_') && a.entityId === card.id),
    false,
    'freshly bought card is not playable this turn'
  );

  // Freshly bought cards cannot be played this turn.
  state.turn = 6;
  const playable = engine.getLegalActions('p1').find(
    a => a.type.startsWith('PLAY_') && a.entityId === card.id
  );
  if (devType === 'vp') {
    assert(!playable, 'VP cards have no play action');
    assert(engine.getRawState().players.p1.score >= 3, 'VP card counts toward score');
  } else {
    assert(!!playable, `card ${devType} playable next turn`);
    assert(engine.dispatch(withDefaultPayload(playable!)).ok, `card ${devType} played`);

    state = engine.getRawState();
    if (state.phase === 'MOVE_ROBBER') {
      const move = engine.getLegalActions('p1').find(a => a.type === 'MOVE_ROBBER');
      assert(!!move, 'knight opens robber move');
      assert(engine.dispatch(move!).ok, 'knight robber moved');
      state = engine.getRawState();
      if (state.phase === 'STEAL') {
        const steal = engine.getLegalActions('p1').find(a => a.type === 'STEAL_FROM');
        if (steal) engine.dispatch(steal);
      }
    } else if (state.phase === 'ROAD_BUILDING') {
      for (let i = 0; i < 2; i++) {
        const free = engine.getLegalActions('p1').find(a => a.type === 'BUILD_ROAD_FREE');
        assert(!!free, 'free road available');
        assert(engine.dispatch(free!).ok, 'free road placed');
      }
      assertEqual(engine.getRawState().phase, 'ACTION', 'road building returns to action');
    } else {
      assertEqual(
        engine.getRawState().phase,
        'ACTION',
        `${devType} resolves in one payload action`
      );
    }

    assertEqual(engine.getRawState().zones.zone_dev_p1.orderedEntities.length, 0, 'played card left hand');
    assertEqual(resourceTotal(), 95, 'card effects conserve resources');
  }

  // This scenario injects resources into the fixture to reach the economy
  // branches quickly, so replay verification does not apply here; the two
  // black-box Catan tests above cover bit-exact replay end to end.
});

test('fixture catan: player trade, bank trade, bonuses and victory', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.catan, 33);
  playCatanSetup(engine);

  let state = engine.getRawState();
  state.phase = 'ACTION';
  state.activePlayerId = 'p1';
  state.turn = 5;

  // --- player-to-player trade through a decision window -----------------
  state.players.p1.customProps.resources = { wood: 1, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  state.players.p2.customProps.resources = { wood: 0, brick: 1, sheep: 0, wheat: 0, ore: 0 };
  state.players.p3.customProps.resources = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };

  assert(
    engine.dispatch({ type: 'PROPOSE_TRADE', playerId: 'p1', payload: { give: 'wood', want: 'brick' } }).ok,
    'one-step offer opens'
  );
  assertEqual(engine.getRawState().phase, 'TRADE_PENDING', 'window waits for responses');

  const p2Accept = engine.getLegalActions('p2').find(a => a.type === 'ACCEPT_TRADE');
  assert(!!p2Accept, 'other player can accept');
  assert(engine.dispatch(p2Accept!).ok, 'p2 accepts');

  state = engine.getRawState();
  assertEqual(state.phase, 'ACTION', 'first acceptance closes the window immediately');
  assertEqual(state.players.p1.customProps.resources.brick, 1, 'p1 received brick');
  assertEqual(state.players.p1.customProps.resources.wood, 0, 'p1 gave wood');
  assertEqual(state.players.p2.customProps.resources.wood, 1, 'p2 received wood');

  // --- bank trade (4:1 without a matching harbour) ----------------------
  state.players.p1.customProps.resources = { wood: 4, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  assert(
    engine.dispatch({ type: 'BANK_TRADE', playerId: 'p1', payload: { give: 'wood', want: 'ore' } }).ok,
    'bank trade is one action'
  );
  state = engine.getRawState();
  assertEqual(state.phase, 'ACTION', 'bank trade returns to action');
  assertEqual(state.players.p1.customProps.resources.wood, 0, '4 wood paid');
  assertEqual(state.players.p1.customProps.resources.ore, 1, '1 ore received');

  // --- synthetic board for longest road / largest army / victory --------
  for (const node of Object.values(state.mapGraph.nodes)) {
    if (node.type === 'VERTEX') node.occupantEntityId = undefined;
  }
  for (const edge of Object.values(state.mapGraph.edges)) edge.occupantEntityId = undefined;
  state.zones.zone_board.orderedEntities = [];
  state.entities = Object.fromEntries(
    Object.entries(state.entities).filter(([, entity]) => entity.type === 'CARD')
  );

  const edges = Object.values(state.mapGraph.edges);
  let tip = edges[0].to;
  placeRoad(state, 'p1', edges[0].id, 'test_road_0');
  let placed = 1;
  for (const edge of edges) {
    if (placed >= 5) break;
    if (edge.occupantEntityId) continue;
    if (edge.from !== tip && edge.to !== tip) continue;
    tip = edge.from === tip ? edge.to : edge.from;
    placeRoad(state, 'p1', edge.id, `test_road_${placed}`);
    placed += 1;
  }
  assertEqual(placed, 5, 'five-road chain placed');

  state.players.p1.customProps.knightsPlayed = 3;
  normalize(state);
  assertEqual(state.globalVars.longestRoadOwner, 'p1', 'longest road awarded at 5');
  assertEqual(state.globalVars.largestArmyOwner, 'p1', 'largest army awarded at 3 knights');
  assertEqual(state.players.p1.score, 2 + 2, 'both special cards score 2 VP each');

  // --- victory at 10 VP -------------------------------------------------
  state.entities = Object.fromEntries(
    Object.entries(state.entities).filter(([, entity]) => entity.type === 'CARD')
  );
  state.zones.zone_board.orderedEntities = [];
  for (const node of Object.values(state.mapGraph.nodes)) {
    if (node.type === 'VERTEX') node.occupantEntityId = undefined;
  }

  const vertices = Object.values(state.mapGraph.nodes).filter(node => node.type === 'VERTEX');
  for (let i = 0; i < 5; i++) {
    placeBuilding(state, 'p1', vertices[i].id, 'SETTLEMENT', `test_settlement_${i}`);
  }
  for (let i = 0; i < 3; i++) {
    placeBuilding(state, 'p1', vertices[5 + i].id, 'CITY', `test_city_${i}`);
  }
  normalize(state);
  assert(state.players.p1.score >= 10, 'synthetic board reaches 10 VP');

  state.phase = 'ACTION';
  state.activePlayerId = 'p1';
  state.turn = 9;
  const end = engine.getLegalActions('p1').find(a => a.type === 'END_TURN');
  assert(!!end, 'end turn available');
  const finish = engine.dispatch(end!);
  assert(finish.ok, 'final action accepted');
  assertEqual(engine.getRawState().gameOver, true, 'game ends at 10 VP');
  assertEqual(engine.getRawState().winner, 'p1', 'winner recorded');
});

test('fixture catan: black-box random play never stalls or corrupts state', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.catan, 99);
  let steps = 0;

  while (!engine.getRawState().gameOver && steps < 300) {
    const focus = engine.getFocusPlayers();
    assert(focus.length > 0, `no focus player at step ${steps}`);

    let dispatched = false;
    for (const pid of focus) {
      const legal = engine.getLegalActions(pid);
      if (legal.length === 0) continue;
      const action = withDefaultPayload(legal[steps % legal.length]);
      const result = engine.dispatch(action);
      assert(result.ok, `step ${steps} (${action.type}) rejected: ${result.error}`);
      dispatched = true;
      break;
    }
    assert(dispatched, `step ${steps} had no dispatchable action`);
    steps += 1;
  }

  assert(steps > 20, 'random play progresses through setup and turns');
  assert(engine.verifyReplay().ok, 'long Catan replay is bit-exact');
});

test('fixture catan: forced seven discards half and resolves through the window', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.catan, 44);
  playCatanSetup(engine);

  const state = engine.getRawState();
  state.phase = 'ROLL';
  state.activePlayerId = 'p1';

  let seed = 1;
  while (DeterministicPRNG.rollDice(seed, 2, 6).sum !== 7) seed += 1;
  state.prngState = seed;

  const total = () =>
    Object.values(engine.getRawState().players).reduce(
      (sum, p) =>
        sum + ['wood', 'brick', 'sheep', 'wheat', 'ore'].reduce((n, r) => n + Number(p.customProps.resources[r] ?? 0), 0),
      0
    ) + ['wood', 'brick', 'sheep', 'wheat', 'ore'].reduce((n, r) => n + Number(engine.getRawState().globalVars.bank[r] ?? 0), 0);

  const before = total();
  const oldBag = { ...state.players.p1.customProps.resources };
  for (const res of ['wood', 'brick', 'sheep', 'wheat', 'ore'] as const) {
    state.globalVars.bank[res] += Number(oldBag[res] ?? 0);
  }
  state.players.p1.customProps.resources = { wood: 9, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  state.globalVars.bank.wood -= 9;
  assertEqual(total(), before, 'resource injection is conservative');

  assert(engine.dispatch({ type: 'ROLL_DICE', playerId: 'p1' }).ok, 'seven rolled');
  assertEqual(engine.getRawState().phase, 'DISCARD', 'discard window opened');

  const discard = engine.getLegalActions('p1').find(a => a.type === 'DISCARD_HALF');
  assert(!!discard, 'discard action available');
  assert(engine.dispatch(discard!).ok, 'discard accepted');

  const after = engine.getRawState();
  assertEqual(after.phase, 'MOVE_ROBBER', 'robber phase after discard');
  assertEqual(after.players.p1.customProps.resources.wood, 5, 'half of 9 rounded down discarded');
  assertEqual(total(), before, 'discard returns cards to the bank');
});

test('fixture catan: harbours change bank trade ratios', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.catan, 55);
  playCatanSetup(engine);
  const state = engine.getRawState();

  const ports = state.globalVars.ports as {
    vertices: [string, string];
    resource?: string;
  }[];

  let chosen: (typeof ports)[number] | null = null;
  let vertexId = '';
  for (const port of ports) {
    for (const vertex of port.vertices) {
      if (!state.mapGraph.nodes[vertex]?.occupantEntityId) {
        chosen = port;
        vertexId = vertex;
        break;
      }
    }
    if (chosen) break;
  }

  assert(!!chosen, 'a free harbour vertex exists');
  placeBuilding(state, 'p1', vertexId, 'SETTLEMENT', 'port_test_settlement');

  const specific = chosen!.resource as 'wood' | 'brick' | 'sheep' | 'wheat' | 'ore' | undefined;
  if (specific) {
    assertEqual(portRatio(state, 'p1', specific), 2, '2:1 harbour matches its resource');
    const other = (['wood', 'brick', 'sheep', 'wheat', 'ore'] as const).find(r => r !== specific)!;
    assertEqual(portRatio(state, 'p1', other), 4, 'other resources still trade 4:1');
  } else {
    assertEqual(portRatio(state, 'p1', 'wood'), 3, '3:1 harbour gives 3:1');
  }
});

test('fixture catan: hidden VP cards are redacted from opponents', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.catan, 77);
  playCatanSetup(engine);

  const state = engine.getRawState();
  const vp = Object.values(state.entities).find(entity => entity.components.custom?.devType === 'vp');
  assert(!!vp, 'deck contains a VP card');

  const deck = state.zones[vp!.zoneId];
  deck.orderedEntities = deck.orderedEntities.filter(id => id !== vp!.id);
  vp!.zoneId = 'zone_dev_p1';
  vp!.ownerId = 'p1';
  vp!.visibility = { type: 'OWNER_ONLY', ownerId: 'p1' };
  state.zones.zone_dev_p1.orderedEntities.push(vp!.id);
  normalize(state);

  const godScore = engine.getProjectedStateFor('GOD').players.p1.score;
  const publicScore = engine.getProjectedStateFor('p2').players.p1.score;
  const ownScore = engine.getProjectedStateFor('p1').players.p1.score;

  assertEqual(publicScore, godScore - 1, 'opponents cannot see the hidden VP card');
  assertEqual(ownScore, godScore, 'owner sees their own score');

  state.gameOver = true;
  assertEqual(engine.getProjectedStateFor('p2').players.p1.score, godScore, 'scores reveal at game end');
});
