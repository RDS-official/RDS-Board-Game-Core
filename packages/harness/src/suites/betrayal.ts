/* -------------------------------------------------------------------------- */
/* suite:betrayal — moved verbatim from suite.ts */
/* -------------------------------------------------------------------------- */

import { UniversalGameEngine } from '@rds/kernel/engine';
import { Action } from '@rds/kernel/types';
import { GAME_REGISTRY } from '@rds/games/registry';
import { withDefaultPayload } from '@rds/kernel/actionPayload';
import { EVENT_DEFS, ITEM_DEFS, OMEN_DEFS, ROOM_DEFS, ROOM_DECK_IDS, STARTING_ROOM_IDS } from '@rds/games/betrayal/cards';
import { resolveHauntId } from '@rds/games/betrayal/haunts';
import { connectAdjacentDoors, damagePlayer, hostilesInRoom, moveMonster, movePlayerTo, movementCost, ongoingEffectKinds, ownsDef, traitIndex } from '@rds/games/betrayal/helpers';
import { addExploredRoom, grantItem, grantOmen } from '@rds/games/betrayal/scenarios';
import { test, assert, assertEqual } from '../testKit';
import { findAttackSeed, betrayalCardInHand, stackRoomTiles, roomDiscardIds, placePendingRoom } from '../suiteHelpers';

/* Betrayal fixture: 44 rooms, 13 omens, 10 events, three full haunts          */
/* -------------------------------------------------------------------------- */

test('fixture betrayal: content tables and starting position', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 2024);
  const state = engine.getRawState();

  assertEqual(Object.keys(ROOM_DEFS).length, 48, '48 room tiles are defined');
  assertEqual(STARTING_ROOM_IDS.length, 5, 'five starting tiles');
  assertEqual(ROOM_DECK_IDS.length, 43, '43 tiles remain in the room deck');
  assertEqual(Object.keys(OMEN_DEFS).length, 13, '13 omens');
  assertEqual(Object.keys(ITEM_DEFS).length, 23, "the 22 official items plus the Widow's Walk rope");
  assertEqual(Object.keys(EVENT_DEFS).length, 30, '30 events: 25 official plus 5 curse carriers');
  assertEqual(
    Object.values(ROOM_DEFS).filter(room => !room.symbol).length,
    19,
    'fourteen deck rooms plus five starting rooms have no symbol'
  );

  assertEqual(Object.keys(state.mapGraph.nodes).length, 5, 'five starting rooms on the table');
  assertEqual(state.zones.zone_event_deck.orderedEntities.length, 30, 'event deck built');
  assertEqual(state.zones.zone_item_deck.orderedEntities.length, 23, 'item deck built');
  assertEqual(state.zones.zone_omen_deck.orderedEntities.length, 13, 'omen deck built');
  assertEqual(state.zones.zone_room_deck.orderedEntities.length, 43, 'room tile deck built');
  assertEqual(state.globalVars.roomDeckTotal, 43, 'room deck total recorded');

  const ox = state.players.p1;
  assertEqual(ox.customProps.traits.speed, 4, 'Ox speed');
  assertEqual(ox.customProps.traits.might, 5, 'Ox might');
  assertEqual(ox.customProps.traits.sanity, 3, 'Ox sanity');
  assertEqual(ox.customProps.traits.knowledge, 3, 'Ox knowledge');
  assertEqual(ox.customProps.traits.speed, ox.customProps.tracks.speed[ox.customProps.traitIndex.speed], 'trait value derives from the track');
  assertEqual(state.activePlayerId, 'p1', 'seat order starts with p1');
  assertEqual(engine.getFocusPlayers().join(','), 'p1', 'p1 is the focus');
});

test('fixture betrayal: exploration filters floors, rotates doors and stops on symbols', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 7);
  const raw = engine.getRawState();
  stackRoomTiles(raw, ['chapel', 'master_bedroom']);

  const explore = engine.getLegalActions('p1').find(
    action => action.type === 'EXPLORE_DOOR' && action.payload?.direction === 'E'
  );
  assert(!!explore, 'east door is explorable');
  assert(engine.dispatch(explore!).ok, 'explore accepted');
  assert(placePendingRoom(engine), 'room orientation resolved');

  const state = engine.getRawState();
  assert(!!state.mapGraph.nodes.room_chapel, 'matching ground tile placed');
  assert(roomDiscardIds(state).includes('master_bedroom'), 'wrong-floor tile discarded');
  assertEqual(state.players.p1.customProps.currentRoomId, 'room_chapel', 'player entered the new room');
  assertEqual(state.players.p1.customProps.movesLeft, 0, 'omen symbol forces a stop');
  assertEqual(state.globalVars.omensRevealed, 1, 'omen counter advanced');
  assert(!!state.globalVars.pendingHauntRoll, 'haunt roll is armed for end of turn');
  assert(
    state.zones.zone_hand_p1.orderedEntities.some(id => state.entities[id].components.custom?.cardType === 'OMEN'),
    'omen card moved to the explorer hand'
  );
});

test('fixture betrayal: drawn room waits for player-chosen orientation', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 11);
  const raw = engine.getRawState();
  stackRoomTiles(raw, ['chapel']);

  const explore = engine.getLegalActions('p1').find(
    action => action.type === 'EXPLORE_DOOR' && action.payload?.direction === 'E'
  );
  assert(!!explore, 'east door explorable');
  assert(engine.dispatch(explore!).ok, 'explore draws a tile');

  const pending = engine.getRawState().globalVars.pendingRoomPlacement as
    | { defId: string; rotations: number[] }
    | undefined;
  assert(!!pending, 'tile is pending orientation');
  assertEqual(pending!.defId, 'chapel', 'expected tile drawn');
  assert(!engine.getRawState().mapGraph.nodes.room_chapel, 'tile not placed yet');

  const place = engine.getLegalActions('p1').find(action => action.type === 'PLACE_ROOM');
  assert(!!place, 'orientation action offered');
  assert((place!.fields?.[0]?.options?.length ?? 0) > 0, 'rotation choices exposed');
  const rotation = Number(place!.fields![0].options![0].value);
  assert(engine.dispatch({ ...place!, payload: { rotation: String(rotation) } }).ok, 'orientation accepted');

  const state = engine.getRawState();
  assert(!!state.mapGraph.nodes.room_chapel, 'tile placed after choice');
  assertEqual(state.mapGraph.nodes.room_chapel.props.rotation, rotation, 'chosen rotation stored');
  assertEqual(state.globalVars.pendingRoomPlacement, null, 'pending orientation cleared');
});

test('fixture betrayal: adjacent doors connect beyond the explored room', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 12, { scenario: 'exploration' });
  const raw = engine.getRawState();
  raw.mapGraph.nodes.test_west = {
    id: 'test_west',
    type: 'ROOM',
    position: [0, 0, 0],
    neighbors: [],
    layer: 'GROUND',
    props: { floor: 'GROUND', col: 4, row: 4, doors: ['E'], name: '西室' }
  };
  raw.mapGraph.nodes.test_east = {
    id: 'test_east',
    type: 'ROOM',
    position: [1, 0, 0],
    neighbors: [],
    layer: 'GROUND',
    props: { floor: 'GROUND', col: 5, row: 4, doors: ['W'], name: '东室' }
  };

  const connected = connectAdjacentDoors(raw, 'test_east');
  assertEqual(connected, 1, 'one adjacent door connected');
  assert(raw.mapGraph.nodes.test_east.neighbors.includes('test_west'), 'east sees west');
  assert(raw.mapGraph.nodes.test_west.neighbors.includes('test_east'), 'west sees east');
  assert(!!raw.mapGraph.edges.edge_test_east_test_west, 'door edge created');
});

test('fixture betrayal: room placement is not clamped to a 5x5 grid', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 13);
  const raw = engine.getRawState();
  const entrance = raw.mapGraph.nodes.room_entrance_hall;
  entrance.props.col = 4;
  entrance.props.row = 0;
  entrance.position = [4, 0, 1];
  stackRoomTiles(raw, ['chapel']);

  const explore = engine.getLegalActions('p1').find(
    action => action.type === 'EXPLORE_DOOR' && action.payload?.direction === 'E'
  );
  assert(!!explore, 'east door is legal at the old grid edge');
  assert(engine.dispatch(explore!).ok, 'draw accepted');
  assert(placePendingRoom(engine), 'orientation resolved outside old grid');
  assertEqual(engine.getRawState().mapGraph.nodes.room_chapel.props.col, 5, 'room extends beyond old GRID_MAX');
});

test('fixture betrayal: haunt roll lives on the interrupt stack and starts the haunt', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 5);
  const raw = engine.getRawState();
  raw.globalVars.omensRevealed = 13;
  raw.globalVars.pendingHauntRoll = { playerId: 'p1', omens: 13 };
  stackRoomTiles(raw, ['chapel']);

  const explore = engine.getLegalActions('p1').find(action => action.type === 'EXPLORE_DOOR');
  assert(!!explore, 'explore available');
  assert(engine.dispatch(explore!).ok, 'explore accepted');
  assert(placePendingRoom(engine), 'room orientation resolved');

  const endTurn = engine.getLegalActions('p1').find(action => action.type === 'END_TURN');
  assert(!!endTurn, 'end turn available');
  assert(engine.dispatch(endTurn!).ok, 'end turn accepted');

  const frame = engine.getRawState().interruptStack[0];
  assertEqual(frame?.type, 'HAUNT_CHECK', 'haunt check pushed onto the stack');
  assertEqual(engine.getFocusPlayers().join(','), 'p1', 'revealer must roll');

  const roll = engine.getLegalActions('p1').find(action => action.type === 'ROLL_HAUNT_CHECK');
  assert(!!roll, 'haunt roll legal for the revealer');
  assert(engine.dispatch(roll!).ok, 'haunt roll accepted');

  const state = engine.getRawState();
  assertEqual(state.globalVars.hauntTriggered, true, 'haunt triggered');
  assertEqual(state.phase, 'HAUNT', 'phase switched');
  assertEqual(state.players.p1.role, 'TRAITOR', 'revealer became the traitor');
  assertEqual(state.players.p2.role, 'HERO', 'others are heroes');
  assertEqual(state.activePlayerId, 'p2', 'hero to the traitor left starts');
  assertEqual(state.activeHooks.length, 1, 'one haunt hook hot-injected');
  assert(!!state.globalVars.hauntObjectives, 'objectives stored as data');
  assertEqual(JSON.stringify(state.activeHooks).includes('handler'), false, 'hooks carry data only');
});

test('fixture betrayal: haunt chart maps omen + room to a scenario', () => {
  assertEqual(resolveHauntId('girl', 'room_catacombs', 'BASEMENT'), 'mummy', 'girl + catacombs = mummy');
  assertEqual(resolveHauntId('holy_symbol', 'room_balcony', 'UPPER'), 'floating_eye', 'holy symbol + balcony = eye');
  assertEqual(resolveHauntId('madman', 'room_crypt', 'BASEMENT'), 'phantom', 'madman + crypt = phantom');
  assertEqual(resolveHauntId('dog', 'room_kitchen', 'GROUND'), 'mummy', 'omen fallback');
  assertEqual(resolveHauntId('mask', 'room_kitchen', 'GROUND'), 'phantom', 'floor fallback');
});

test('fixture betrayal: mummy haunt sets up girl, sarcophagus and fire weakness', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_mummy' });
  const state = engine.getRawState();

  const mummy = Object.values(state.entities).find(entity => entity.components.custom?.monster === 'MUMMY');
  assert(!!mummy, 'mummy spawned');
  assertEqual(mummy!.components.custom!.might, 8, 'mummy might 8');
  assertEqual(mummy!.components.custom!.speed, 3, 'mummy speed 3');
  assertEqual(state.globalVars.haunt?.girlHolder, 'p2', 'girl starts with p2');
  assert(
    Object.values(state.entities).some(entity => entity.components.custom?.marker === 'SARCOPHAGUS'),
    'sarcophagus marker placed'
  );

  const hook = engine.getRules().get('haunt_mummy_fire');
  assert(!!hook, 'fire weakness hook registered');
  const action: Action = {
    type: 'ATTACK_MONSTER',
    playerId: 'p3',
    entityId: mummy!.id,
    payload: { weapon: 'fists' }
  };
  const context = {
    impl: hook!,
    instance: { instanceId: 'test', hookId: hook!.id, visibility: { type: 'PUBLIC' as const } },
    params: {}
  };
  assert(hook!.predicate(action, state, context), 'p3 attacks from the furnace room');
  const transformed = hook!.handler(action, state, context);
  assertEqual(transformed.type, 'MODIFY', 'fire modifies the attack');
  assertEqual(transformed.modifiedAction?.payload?.monsterMightPenalty, 4, 'mummy might drops to 4');

  const beforeHostiles = hostilesInRoom(state, 'p3', 'room_furnace_room');
  assertEqual(beforeHostiles, 0, 'mummy is in the catacombs, not the furnace');
});

test('fixture betrayal: combat opens a damage-allocation decision and applies it', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_mummy' });
  const raw = engine.getRawState();
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  raw.players.p1.customProps.attacksLeft = 1;
  raw.prngState = findAttackSeed(5, 2, diff => diff >= 2);

  const attack = engine.getLegalActions('p1').find(action => action.type === 'ATTACK_PLAYER' && action.targetPlayerId === 'p2');
  assert(!!attack, 'traitor can attack the girl holder');
  assert(engine.dispatch(withDefaultPayload(attack!)).ok, 'attack accepted');

  const decision = engine.getRawState().pendingDecisions.find(window => window.status === 'OPEN');
  assertEqual(decision?.payload?.kind, 'damage', 'damage decision opened');
  assertEqual(engine.getFocusPlayers().join(','), 'p2', 'defender chooses the trait');
  assertEqual(engine.getRawState().players.p2.customProps.traits.speed, 3, 'speed untouched before allocation');

  const allocate = engine.getLegalActions('p2').find(action => action.type === 'ALLOCATE_DAMAGE');
  assert(!!allocate, 'allocation action exposed');
  assert(engine.dispatch({ type: 'ALLOCATE_DAMAGE', playerId: 'p2', payload: { trait: 'speed' } }).ok, 'allocate accepted');

  const state = engine.getRawState();
  assert(state.players.p2.customProps.traits.speed < 3, 'damage applied to the chosen trait');
  assertEqual(state.players.p2.customProps.traits.might, 2, 'might untouched');
  assertEqual(state.pendingDecisions.filter(window => window.status === 'OPEN').length, 0, 'decision closed');
});

test('fixture betrayal: a 2+ damage hit can steal instead of wounding', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_mummy' });
  const raw = engine.getRawState();
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  raw.players.p1.customProps.attacksLeft = 1;
  raw.prngState = findAttackSeed(5, 2, diff => diff >= 2);

  const rope = betrayalCardInHand(raw, 'p2', 'rope');
  assert(!!rope, 'p2 holds a tradeable rope');
  const attack = engine.getLegalActions('p1').find(action => action.type === 'ATTACK_PLAYER' && action.targetPlayerId === 'p2');
  assert(!!attack, 'attack available');
  assert(
    engine.dispatch({ ...attack!, payload: { ...(attack!.payload ?? {}), weapon: 'fists', steal: 'yes' } }).ok,
    'stealing attack accepted'
  );

  const state = engine.getRawState();
  assertEqual(state.pendingDecisions.filter(window => window.status === 'OPEN').length, 0, 'no damage window');
  assertEqual(state.players.p2.customProps.traits.speed, 3, 'no wound was dealt');
  assertEqual(betrayalCardInHand(state, 'p2', 'rope'), undefined, 'rope left the victim');
  assert(!!betrayalCardInHand(state, 'p1', 'rope'), 'traitor took the rope');
});

test('fixture betrayal: armor reduces physical damage before allocation', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'trade_ready' });
  const state = engine.getRawState();
  grantItem(state, 'p2', 'armor');

  const before = state.players.p2.customProps.traits.might;
  const padded = damagePlayer(state, 'p2', 'PHYSICAL', 1, 'might');
  assertEqual(padded.applied, 0, 'armor absorbs the single point');
  assertEqual(state.players.p2.customProps.traits.might, before, 'might unchanged');

  const wounded = damagePlayer(state, 'p2', 'PHYSICAL', 3, 'might');
  assertEqual(wounded.applied, 2, 'armor only removes one point');
  assertEqual(state.players.p2.alive, true, 'father survives');
});

test('fixture betrayal: revolver shoots along a floor line and never suffers retaliation', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_phantom' });
  const raw = engine.getRawState();
  // (0,2) keeps the wine cellar on the same basement row as the catacombs at
  // (1,2) so the shot has a line, without landing on the stairwell cell (2,2).
  addExploredRoom(raw, 'wine_cellar', 0, 2, 'room_catacombs');
  movePlayerTo(raw, 'p1', 'room_wine_cellar');
  grantItem(raw, 'p2', 'revolver');
  raw.activePlayerId = 'p2';
  raw.activeActorId = 'p2';
  raw.players.p2.customProps.attacksLeft = 1;
  raw.prngState = findAttackSeed(4, 5, diff => diff < 0);

  const attack = engine.getLegalActions('p2').find(
    action => action.type === 'ATTACK_PLAYER' && action.targetPlayerId === 'p1'
  );
  assert(!!attack, 'catacombs and wine cellar share a line');
  assert(
    engine.dispatch({ ...attack!, payload: { weapon: 'revolver', steal: 'no' } }).ok,
    'ranged attack accepted'
  );

  const state = engine.getRawState();
  assertEqual(state.players.p2.customProps.traits.might, 2, 'missed shot does not wound the shooter');
  assertEqual(state.players.p1.customProps.traits.might, 5, 'target unaffected on a miss');
  assertEqual(state.players.p2.customProps.attacksLeft, 0, 'attack resource consumed');
});

test('fixture betrayal: fire + spear stuns the mummy and clears the obstacle penalty', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_mummy' });
  const raw = engine.getRawState();
  const mummy = Object.values(raw.entities).find(entity => entity.components.custom?.monster === 'MUMMY')!;
  moveMonster(raw, mummy.id, 'room_furnace_room');
  grantOmen(raw, 'p3', 'spear');
  raw.activePlayerId = 'p3';
  raw.activeActorId = 'p3';
  raw.players.p3.customProps.attacksLeft = 1;
  raw.prngState = findAttackSeed(4, 4, diff => diff > 0);

  assertEqual(hostilesInRoom(raw, 'p3', 'room_furnace_room'), 1, 'unstunned monster blocks movement');
  assertEqual(movementCost(raw, 'p3', 'room_furnace_room'), 2, 'leaving costs +1 per hostile');

  const attack = engine.getLegalActions('p3').find(action => action.type === 'ATTACK_MONSTER');
  assert(!!attack, 'spear attack available');
  assert(engine.dispatch(withDefaultPayload(attack!)).ok, 'attack accepted');

  const state = engine.getRawState();
  assertEqual(state.entities[mummy.id].components.custom?.stunned, true, 'mummy stunned');
  assertEqual(hostilesInRoom(state, 'p3', 'room_furnace_room'), 0, 'stunned monster no longer blocks');
  assertEqual(movementCost(state, 'p3', 'room_furnace_room'), 1, 'movement cost back to normal');
});

test('fixture betrayal: eyes cancel speed attacks and a slap breaks mind control', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_eye' });
  const raw = engine.getRawState();
  const eye = Object.values(raw.entities).find(entity => entity.components.custom?.monster === 'EYE')!;
  const ward = engine.getRules().get('haunt_eye_ward')!;
  const action: Action = {
    type: 'ATTACK_MONSTER',
    playerId: 'p3',
    entityId: eye.id,
    payload: { weapon: 'revolver' }
  };
  const context = {
    impl: ward,
    instance: { instanceId: 'test', hookId: ward.id, visibility: { type: 'PUBLIC' as const } },
    params: {}
  };
  assert(ward.predicate(action, raw, context), 'eye is attacked with a speed weapon');
  assertEqual(ward.handler(action, raw, context).type, 'CANCEL', 'eye cancels speed attacks');

  movePlayerTo(raw, 'p2', 'room_tower');
  raw.activePlayerId = 'p3';
  raw.activeActorId = 'p3';
  raw.players.p3.customProps.attacksLeft = 1;
  raw.prngState = findAttackSeed(2, 2, diff => diff > 0);
  const slap = engine.getLegalActions('p3').find(candidate => candidate.type === 'SLAP');
  assert(!!slap, 'slap available against a controlled ally');
  assert(engine.dispatch(slap!).ok, 'slap accepted');

  const state = engine.getRawState();
  assertEqual(state.players.p2.customProps.controlled, false, 'mind control broken');
  assertEqual(state.players.p2.customProps.immuneMindControl, true, 'permanent immunity granted');
});

test('fixture betrayal: phantom bones, frost trail and the requiem ritual', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_phantom' });
  const raw = engine.getRawState();
  raw.players.p2.customProps.forcedRoll = { value: 8 };
  const search = engine.getLegalActions('p2').find(action => action.type === 'SEARCH_BONES');
  assert(!!search, 'search available in the basement');
  assert(engine.dispatch(search!).ok, 'search accepted');
  assertEqual(engine.getRawState().globalVars.haunt?.bonesFound, true, 'bones found');

  const move = engine.getLegalActions('p2').find(
    action => action.type === 'MOVE_TO_ROOM'
  );
  assert(!!move, 'pentagram chamber is adjacent');
  assert(engine.dispatch({ ...move!, targets: ['room_the_pentagram_chamber'] }).ok, 'move accepted');
  const frost = engine.getRawState().globalVars.frostRooms as string[];
  assert(frost.includes('room_the_pentagram_chamber'), 'phantom frost hook marked the room');

  grantOmen(engine.getRawState(), 'p2', 'holy_symbol');
  const state = engine.getRawState();
  state.players.p2.customProps.forcedRoll = { value: 8 };
  const chant = engine.getLegalActions('p2').find(action => action.type === 'CHANT');
  assert(!!chant, 'requiem chant available with bones + holy symbol');
  assert(engine.dispatch(chant!).ok, 'chant accepted');
  assertEqual(engine.getRawState().globalVars.haunt?.progress, 1, 'ritual progress advanced');
});

test('fixture betrayal: zombie haunt brews holy water, sanctifies house and defeats the dead', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_zombie' });
  const raw = engine.getRawState();
  raw.players.p2.customProps.forcedRoll = { value: 8 };

  const brew = engine.getLegalActions('p2').find(action => action.type === 'BREW_HOLY_WATER');
  assert(!!brew, 'brew holy water available in laboratory');
  assert(engine.dispatch(brew!).ok, 'brew accepted');
  assert(ownsDef(engine.getRawState(), 'p2', 'holy_water'), 'p2 received holy water');

  const move = engine.getLegalActions('p2').find(action => action.type === 'MOVE_TO_ROOM');
  assert(!!move, 'movement available to pentagram chamber');
  assert(engine.dispatch({ ...move!, targets: ['room_the_pentagram_chamber'] }).ok, 'moved to pentagram chamber');

  engine.getRawState().players.p2.customProps.forcedRoll = { value: 8 };
  const sanctify = engine.getLegalActions('p2').find(action => action.type === 'SANCTIFY_HOUSE');
  assert(!!sanctify, 'sanctify house available with holy water at sanctuary');
  assert(engine.dispatch(sanctify!).ok, 'sanctify accepted');
  assertEqual(engine.getRawState().globalVars.haunt?.progress, 1, 'consecration progress advanced');
});

test('fixture betrayal: werewolf haunt forges silver bullets and suppresses lunar curse', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_werewolf' });
  const raw = engine.getRawState();
  raw.players.p2.customProps.forcedRoll = { value: 8 };

  const forge = engine.getLegalActions('p2').find(action => action.type === 'FORGE_SILVER');
  assert(!!forge, 'forge silver available in workshop');
  assert(engine.dispatch(forge!).ok, 'forge silver accepted');
  assert(ownsDef(engine.getRawState(), 'p2', 'silver_bullets'), 'p2 received silver bullets');

  movePlayerTo(engine.getRawState(), 'p2', 'room_observatory');
  engine.getRawState().players.p2.customProps.forcedRoll = { value: 8 };
  const suppress = engine.getLegalActions('p2').find(action => action.type === 'SUPPRESS_CURSE');
  assert(!!suppress, 'suppress curse available in observatory');
  assert(engine.dispatch(suppress!).ok, 'suppress curse accepted');
  assertEqual(engine.getRawState().globalVars.haunt?.progress, 1, 'moon suppression progress advanced');
});

test('fixture betrayal: event checks auto-resolve and the locked safe pays in traits', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 11);
  const raw = engine.getRawState();
  stackRoomTiles(raw, ['dining_room']);
  raw.players.p1.customProps.forcedRoll = { value: 8 };

  const deck = raw.zones.zone_event_deck;
  const safeId = deck.orderedEntities.find(id => raw.entities[id].components.custom?.defId === 'locked_safe')!;
  deck.orderedEntities = deck.orderedEntities.filter(id => id !== safeId);
  deck.orderedEntities.push(safeId);

  // Official Locked Safe: "4+ You crack the tumblers (Gain 1 Knowledge, Gain 1
  // Might)." It grants traits, not items - the old assertion encoded an invented
  // payout of two item cards.
  const before = {
    hand: raw.zones.zone_hand_p1.orderedEntities.length,
    knowledge: traitIndex(raw.players.p1, 'knowledge'),
    might: traitIndex(raw.players.p1, 'might')
  };
  const explore = engine.getLegalActions('p1').find(
    action => action.type === 'EXPLORE_DOOR' && action.payload?.direction === 'E'
  );
  assert(!!explore, 'dining room is reachable');
  assert(engine.dispatch(explore!).ok, 'explore accepted');
  assert(placePendingRoom(engine), 'room orientation resolved');

  const state = engine.getRawState();
  assert(!!state.mapGraph.nodes.room_dining_room, 'event room placed');
  assertEqual(state.zones.zone_hand_p1.orderedEntities.length, before.hand, 'no items are granted');
  assert(traitIndex(state.players.p1, 'knowledge') > before.knowledge, 'the safe grants Knowledge');
  assert(traitIndex(state.players.p1, 'might') > before.might, 'the safe grants Might');
});

test('fixture betrayal: an ONGOING event card registers a kernel effect instance', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 11);
  const raw = engine.getRawState();
  stackRoomTiles(raw, ['dining_room']);

  // Force the "Drip... Drip... Drip..." event to the top of the deck.
  const deck = raw.zones.zone_event_deck;
  const dripId = deck.orderedEntities.find(id => raw.entities[id].components.custom?.defId === 'drip')!;
  assert(!!dripId, 'drip event exists in the deck');
  deck.orderedEntities = deck.orderedEntities.filter(id => id !== dripId);
  deck.orderedEntities.push(dripId);

  const explore = engine.getLegalActions('p1').find(
    action => action.type === 'EXPLORE_DOOR' && action.payload?.direction === 'E'
  );
  assert(!!explore, 'dining room is reachable');
  assert(engine.dispatch(explore!).ok, 'explore accepted');
  assert(placePendingRoom(engine), 'room orientation resolved');

  const state = engine.getRawState();
  assertEqual(ongoingEffectKinds(state, 'p1').join(','), 'DRIP', 'DRIP became an active curse');
  assertEqual(
    (state.effects ?? []).filter(effect => effect.target === 'p1' && effect.kind === 'ONGOING').length,
    1,
    'one kernel effect instance carries the curse'
  );
  assertEqual(
    (state.players.p1.customProps.effects ?? []).length,
    0,
    'the legacy customProps array stays untouched'
  );
  assert(
    (state.effects ?? []).every(effect => effect.source === 'p1' || state.players[effect.source] || state.npcs?.[effect.source]),
    'effect sources resolve to real actors'
  );
});

test('fixture betrayal: equipment use respects once-per-turn and restores green values', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'trade_ready' });
  const raw = engine.getRawState();
  const salve = grantItem(raw, 'p1', 'healing_salve');
  damagePlayer(raw, 'p1', 'PHYSICAL', 4, 'might');
  assertEqual(raw.players.p1.customProps.traits.might, 2, 'wounded before healing');

  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  const use = engine.getLegalActions('p1').find(
    action => action.type === 'USE_ITEM' && action.entityId === salve.id
  );
  assert(!!use, 'salve is usable');
  assert(engine.dispatch({ ...use!, payload: { trait: 'might' } }).ok, 'salve used');

  const state = engine.getRawState();
  assertEqual(state.players.p1.customProps.traits.might, 5, 'restored to the green value');
  assertEqual(state.entities[salve.id].components.custom?.charges, 1, 'one charge left');
  assertEqual(
    engine.getLegalActions('p1').some(action => action.type === 'USE_ITEM' && action.entityId === salve.id),
    false,
    'item is exhausted for this turn'
  );
});

test('fixture betrayal: NPC movement actually relocates the monster and spends a move', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 11, { scenario: 'haunt_zombie' });

  // Walk turns until a zombie NPC has movement available.
  let npcId = '';
  for (let i = 0; i < 10 && !npcId; i++) {
    const s = engine.getRawState();
    const active = s.activeActorId ?? s.activePlayerId;
    const legal = engine.getLegalActions(active);
    if (s.npcs?.[active] && legal.some(action => action.type === 'MOVE_NPC')) {
      npcId = active;
      break;
    }
    const advance = legal.find(a => a.type === 'END_TURN') ?? legal.find(a => a.type === 'END_NPC_TURN');
    assert(!!advance, 'a turn-ending action exists while walking to the NPC turn');
    engine.dispatch(advance!);
  }
  assert(!!npcId, 'reached an NPC turn with movement');

  const before = engine.getRawState();
  const npc = before.npcs![npcId];
  const entityId = npc.entityId!;
  const fromRoom = String(before.entities[entityId].components.custom?.roomId ?? '');
  const movesBefore = Number(npc.customProps.movesLeft);
  assert(fromRoom.length > 0, 'monster starts in a real room');

  const move = engine.getLegalActions(npcId).find(action => action.type === 'MOVE_NPC')!;
  const target = String(move.targetNodeId);
  assert(engine.dispatch(move).ok, 'NPC move dispatch is accepted');

  const after = engine.getRawState();
  assertEqual(
    String(after.entities[entityId].components.custom?.roomId ?? ''),
    target,
    'the monster actually relocated to the target room'
  );
  assertEqual(
    Number(after.npcs![npcId].customProps.movesLeft),
    movesBefore - 1,
    'one movement point was spent'
  );
  assertEqual(
    String(after.npcs![npcId].customProps.roomId ?? ''),
    target,
    'the NPC record mirrors the entity room so the renderer can frame it'
  );
});

test('fixture betrayal: medical kit lets the healer choose which physical trait to restore', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'trade_ready' });
  const raw = engine.getRawState();
  const kit = grantItem(raw, 'p1', 'medical_kit');

  // Wound only the speed track; might keeps its green index.
  damagePlayer(raw, 'p1', 'PHYSICAL', 2, 'speed');
  const speedIdxBefore = raw.players.p1.customProps.traitIndex.speed;
  const mightIdxBefore = raw.players.p1.customProps.traitIndex.might;
  const greenIdx = raw.players.p1.customProps.startIndex.speed;
  assert(speedIdxBefore < greenIdx, 'speed is below its green value');
  assertEqual(mightIdxBefore, raw.players.p1.customProps.startIndex.might, 'might is untouched');

  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  raw.players.p1.customProps.forcedRoll = { value: 8 }; // knowledge 8 → heal 3 steps

  const use = engine.getLegalActions('p1').find(
    action => action.type === 'USE_ITEM' && action.entityId === kit.id
  );
  assert(!!use, 'medical kit is usable');
  const traitField = use!.fields?.find(field => field.key === 'trait');
  assert(!!traitField, 'the medical kit exposes a trait choice');
  assertEqual(
    (traitField!.options ?? []).map(option => option.value).join(','),
    'might,speed',
    'both physical tracks are offered'
  );

  assert(engine.dispatch({ ...use!, payload: { target: 'p1', trait: 'speed' } }).ok, 'kit used on speed');

  const after = engine.getRawState().players.p1.customProps;
  assertEqual(after.traitIndex.speed, greenIdx, 'the chosen track (speed) was restored to green');
  assertEqual(
    after.traitIndex.might,
    mightIdxBefore,
    'the previously hardcoded might track was left alone'
  );
});

test('fixture betrayal: a finished haunt reports the reason so the UI can end the game', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 11, { scenario: 'haunt_zombie' });
  const raw = engine.getRawState();

  // Take every hero out of the haunt.
  const heroes = Object.values(raw.players).filter(player => player.role !== 'TRAITOR');
  assert(heroes.length > 0, 'the haunt starts with heroes');
  for (const hero of heroes) {
    hero.alive = false;
    hero.customProps.banished = true;
  }

  // The outcome is evaluated on the next kernel transition.
  const active = raw.activeActorId ?? raw.activePlayerId;
  const advance = engine
    .getLegalActions(active)
    .find(action => action.type === 'END_TURN' || action.type === 'END_NPC_TURN');
  assert(!!advance, 'a turn-ending action is available');
  engine.dispatch(advance!);

  const state = engine.getRawState();
  assert(state.gameOver, 'the game reports gameOver once every hero is out');
  assert(!!state.winnerReason, 'a human-readable reason lands on the state');
  assert(
    String(state.winnerReason).includes('所有英雄'),
    `the reason names the condition (got ${state.winnerReason})`
  );

  // The reason must never contradict the roster: it may only fire when the
  // hero set is genuinely empty (alive + not the traitor + not banished).
  const livingHeroes = Object.values(state.players).filter(
    player => player.alive && player.role !== 'TRAITOR' && !player.customProps.banished
  );
  assertEqual(livingHeroes.length, 0, 'no explorer is still standing when the haunt is lost');
});

test('fixture betrayal: the all-heroes-out verdict can never fire over a living hero', () => {
  // A hero at 1 sanity must survive a turn-end sanity check that would only
  // wound — the haunt is lost only when the track actually reaches zero.
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_zombie' });
  const raw = engine.getRawState();

  const hero = Object.values(raw.players).find(player => player.role !== 'TRAITOR')!;
  assert(!!hero, 'a hero exists');
  // Stand the hero in the Crypt: it is the room that actually bites at turn end
  // (the Pentagram Chamber uses an exit roll instead, per the rulebook).
  // The fixture has no crypt, so place one on a free basement cell.
  const basement = Object.values(raw.mapGraph.nodes).filter(
    node => node.type === 'ROOM' && String(node.props?.floor) === 'BASEMENT'
  );
  const taken = new Set(basement.map(node => `${node.props?.col},${node.props?.row}`));
  let free = { col: 0, row: 3 };
  outer: for (let col = 0; col <= 6; col += 1) {
    for (let row = 0; row <= 6; row += 1) {
      if (!taken.has(`${col},${row}`)) {
        free = { col, row };
        break outer;
      }
    }
  }
  addExploredRoom(raw, 'crypt', free.col, free.row, 'room_basement_landing');
  const crypt = raw.mapGraph.nodes.room_crypt;
  assert(!!crypt, 'a crypt room exists');
  hero.customProps.currentRoomId = crypt!.id;
  hero.customProps.floor = String(crypt!.props?.floor ?? 'BASEMENT');

  // Force the sanity check to fail (value 0 → far below the threshold 4) but
  // keep the trait one step above death first.
  const sanityIdx = raw.players[hero.id].customProps.traitIndex;
  raw.players[hero.id].customProps.traitIndex = { ...sanityIdx, sanity: 1 };
  raw.players[hero.id].customProps.forcedRoll = { value: 0 };

  raw.activePlayerId = hero.id;
  raw.activeActorId = hero.id;
  const advance = engine
    .getLegalActions(hero.id)
    .find(action => action.type === 'END_TURN');
  assert(!!advance, 'the hero can end their turn');
  assert(engine.dispatch(advance!).ok, 'turn ended');

  const state = engine.getRawState();
  assertEqual(
    state.players[hero.id].alive,
    false,
    'a zeroed sanity track is lethal at turn end'
  );

  // Now every hero is out: the verdict may fire, and the roster agrees.
  const others = Object.values(state.players).filter(
    player => player.role !== 'TRAITOR' && player.id !== hero.id
  );
  for (const other of others) {
    other.alive = false;
    other.customProps.banished = true;
  }
  const active = state.activeActorId ?? state.activePlayerId;
  const advance2 = engine
    .getLegalActions(active)
    .find(action => action.type === 'END_TURN' || action.type === 'END_NPC_TURN');
  if (advance2) engine.dispatch(advance2!);
  const final = engine.getRawState();
  if (final.gameOver && String(final.winnerReason ?? '').includes('所有英雄')) {
    const stillStanding = Object.values(final.players).filter(
      player => player.alive && player.role !== 'TRAITOR' && !player.customProps.banished
    );
    assertEqual(stillStanding.length, 0, 'verdict only fires over an empty hero set');
  }
});
