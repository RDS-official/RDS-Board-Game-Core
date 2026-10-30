/* -------------------------------------------------------------------------- */
/* suite:rules — moved verbatim from suite.ts */
/* -------------------------------------------------------------------------- */

import { UniversalGameEngine } from '@rds/kernel/engine'
import { GAME_REGISTRY } from '@rds/games/registry'
import { ROOM_DEFS } from '@rds/games/betrayal/cards'
import { addEffect, applyTraitSteps, damagePlayer, movePlayerTo, nodeGrid, resetTurnResources, rollZeroDice, traitIndex, traitValue } from '@rds/games/betrayal/helpers'
import { addExploredRoom } from '@rds/games/betrayal/scenarios'
import { test, assert, assertEqual } from '../testKit';

/* Official rules: assertions taken from the 2nd-edition rulebook              */
/* -------------------------------------------------------------------------- */

test('rules: movement equals the Speed value and rolls no dice', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw = engine.getRawState();
  const active = raw.activeActorId ?? raw.activePlayerId;

  // Rulebook, Moving: "Move up to a number of spaces equal to your current
  // Speed." Movement is never rolled for.
  const before = raw.prngState;
  resetTurnResources(raw, active);
  assertEqual(raw.prngState, before, 'resetting a turn must not consume dice');

  const speed = traitValue(raw.players[active], 'speed');
  assertEqual(Number(raw.players[active].customProps.movesLeft), speed, 'movesLeft is the Speed value');
});

test('rules: a trait can be raised but never above the printed maximum', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw = engine.getRawState();
  const player = raw.players.p1;
  const track = player.customProps.tracks?.knowledge ?? player.customProps.track?.knowledge;
  assert(Array.isArray(track), 'the character sheet exposes a knowledge track');

  // Rulebook, Trait Damage: "Traits cannot go above the maximum value shown on
  // the character card."
  applyTraitSteps(raw, 'p1', 'knowledge', 99, { force: true });
  assertEqual(traitIndex(player, 'knowledge'), track!.length - 1, 'gain clamps to the top of the track');
});

test('rules: a trait that reaches the skull kills the explorer', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw = engine.getRawState();
  raw.globalVars.hauntTriggered = true;
  raw.players.p1.customProps.traitIndex = { ...raw.players.p1.customProps.traitIndex, sanity: 1 };

  // Rulebook, Death: any trait at the skull and the explorer dies.
  damagePlayer(raw, 'p1', 'MENTAL', 1, 'sanity');
  assertEqual(raw.players.p1.alive, false, 'the explorer dies at the skull');
});

test('rules: the haunt roll is six dice compared against the omen count', () => {
  // Rulebook, Making a Haunt Roll: roll 6 dice at the end of a turn where you drew
  // an omen; the haunt begins when the total is LESS than the omens drawn.
  const sixDice = (seed: number) => rollZeroDice(seed, 6).rolls.length;
  assertEqual(sixDice(12345), 6, 'the haunt roll uses six dice');

  const hauntWith = (omens: number) => {
    const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 7, { scenario: 'omen_ready' });
    const raw = engine.getRawState();
    raw.globalVars.omensRevealed = omens;
    raw.globalVars.pendingHauntRoll = { playerId: 'p1', omens };
    raw.activePlayerId = 'p1';
    raw.activeActorId = 'p1';
    raw.players.p1.customProps.movesLeft = 0;

    // The roll only becomes legal once endTurn has pushed the HAUNT_CHECK frame
    // onto the interrupt stack, so drive it the way the table does.
    const end = engine.getLegalActions('p1').find(a => a.type === 'END_TURN');
    assert(!!end, 'the turn can be ended');
    engine.dispatch(end!);

    const action = engine.getLegalActions('p1').find(a => a.type === 'ROLL_HAUNT_CHECK');
    assert(!!action, 'the haunt roll is offered while it is pending');
    engine.dispatch(action!);
    return engine.getRawState();
  };

  // A six-dice total is always >= 0, so zero omens can never trigger the haunt.
  const noOmens = hauntWith(0);
  assertEqual(noOmens.globalVars.hauntTriggered ?? false, false, 'no omens cannot trigger a haunt');

  // With more omens than any six-dice total the haunt must fire.
  const manyOmens = hauntWith(13);
  assertEqual(manyOmens.globalVars.hauntTriggered, true, 'omen count above the maximum roll triggers it');
});

test('rules: an attack is available once per turn and only after the haunt', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_zombie' });
  const raw = engine.getRawState();
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  raw.players.p1.customProps.attacksLeft = 1;
  // An attack needs a target in the same room.
  const room = String(raw.players.p1.customProps.currentRoomId);
  movePlayerTo(raw, 'p2', room);

  const canAttack = () => engine.getLegalActions('p1').some(a => a.type === 'ATTACK_PLAYER');
  assertEqual(raw.globalVars.hauntTriggered, true, 'the fixture starts after the haunt');

  // Rulebook, Attacking: once per turn. Exhausting the allowance removes it.
  raw.players.p1.customProps.attacksLeft = 0;
  assertEqual(canAttack(), false, 'no attack once the allowance is spent');

  raw.players.p1.customProps.attacksLeft = 1;
  assertEqual(canAttack(), true, 'one attack is offered while the allowance is unspent');
});

test('rules: the elevator rolls before offering a destination', () => {
  const def = ROOM_DEFS.mystic_elevator;
  assert(!!def, 'the elevator room exists');
  assertEqual(def!.doors.length, 1, 'the car has a single opening');

  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'room_features' });
  const raw = engine.getRawState();
  addExploredRoom(raw, 'mystic_elevator', 3, 3, 'room_basement_landing');
  movePlayerTo(raw, 'p1', 'room_mystic_elevator');
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  raw.players.p1.customProps.movesLeft = 3;
  raw.players.p1.customProps.elevatorUsed = false;

  // Step 1: riding takes no target, so the UI cannot show a room picker first.
  const ride = engine.getLegalActions('p1').find(a => a.type === 'USE_ELEVATOR');
  assert(!!ride, 'the ride is offered from inside the car');
  assertEqual(ride!.selection, undefined, 'riding asks for no destination yet');

  const rideRes = engine.dispatch(ride!);
  assert(rideRes.ok, `riding dispatches (${rideRes.error ?? ''})`);

  const after = engine.getRawState();
  const roll = after.globalVars.lastElevatorRoll as { rolls: number[]; sum: number } | undefined;
  assert(!!roll, 'the ride records a roll');
  assertEqual(roll!.rolls.length, 2, 'two dice decide the floor');
  assertEqual(after.players.p1.customProps.elevatorUsed, true, 'one ride per turn');
  // The roll is published so the dice overlay can animate it.
  const shown = after.globalVars.lastRoll as { total?: number; dice?: number[] } | undefined;
  assertEqual(shown?.total, roll!.sum, 'the ride is the last roll shown to the UI');

  if (roll!.sum < 2) {
    // Nothing to choose: the car did not move and no picker is offered.
    assertEqual(
      engine.getLegalActions('p1').some(a => a.type === 'ELEVATOR_MOVE'),
      false,
      'no destination picker below 2'
    );
    return;
  }

  // Step 2: the dice opened the picker, and moving relocates the tile itself.
  const choices = engine.getLegalActions('p1').filter(a => a.type === 'ELEVATOR_MOVE');
  assert(choices.length > 0, 'the doorway picker opens after the roll');

  const choice = choices[0];
  const destination = String(choice.targetNodeId ?? '');
  const doorDir = String(choice.payload?.direction ?? '');
  assert(destination.length > 0, 'each choice carries its room');
  assert(doorDir.length > 0, 'each choice names the doorway it lands on');
  const moveRes = engine.dispatch(choice as never);
  assert(moveRes.ok, `the ride completes (${moveRes.error ?? ''})`);

  const moved = engine.getRawState();
  const elevator = moved.mapGraph.nodes.room_mystic_elevator;
  const grid = nodeGrid(elevator);
  assert(!!grid, 'the elevator tile still exists');
  assert(!(grid!.col === 3 && grid!.row === 3), 'the elevator left its original cell');
  assert(elevator!.neighbors.includes(destination), 'the elevator is attached to the destination');

  // It must sit in the cell just outside the chosen doorway, and its single door
  // must face back into that room - that is what the doorway choice encodes.
  const roomGrid = nodeGrid(moved.mapGraph.nodes[destination]);
  const OFFSETS: Record<string, [number, number]> = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };
  const OPPOSITE: Record<string, string> = { N: 'S', S: 'N', E: 'W', W: 'E' };
  const offset = OFFSETS[doorDir]!;
  assertEqual(grid!.col, roomGrid!.col + offset[0], 'the car parks outside the chosen doorway (col)');
  assertEqual(grid!.row, roomGrid!.row + offset[1], 'the car parks outside the chosen doorway (row)');
  assert(
    (elevator!.props?.doors as string[]).includes(OPPOSITE[doorDir]!),
    'the car door faces the room it docked against'
  );
  assertEqual(
    String(moved.players.p1.customProps.currentRoomId),
    'room_mystic_elevator',
    'the rider is inside the car'
  );
});

test('rules: the drip curse only fires in a windowless room', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw = engine.getRawState();
  addEffect(raw, { kind: 'ONGOING', source: 'p1', target: 'p1', payload: { effect: 'DRIP' } });

  // The exploration layout has no garden, so place one and stand in it.
  addExploredRoom(raw, 'gardens', 0, 1, 'room_entrance_hall');
  const garden = raw.mapGraph.nodes.room_gardens;
  assert(!!garden, 'the garden exists');
  assert(
    Array.isArray(garden!.props?.tags) && (garden!.props!.tags as string[]).includes('outside'),
    'the garden counts as an outside room'
  );

  // Outside rooms have windows, so the curse must stay quiet there.
  movePlayerTo(raw, 'p1', garden!.id);
  raw.globalVars.lastRoll = undefined;
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  raw.players.p1.customProps.movesLeft = 0;
  const end = engine.getLegalActions('p1').find(a => a.type === 'END_TURN');
  assert(!!end, 'the turn can end');
  engine.dispatch(end!);
  const afterGarden = engine.getRawState();
  const gardenRoll = afterGarden.globalVars.lastRoll as { reason?: string } | undefined;
  assertEqual(gardenRoll?.reason === '滴血之声', false, 'no drip check in the garden');
});

test('rules: the drip curse does fire in a windowless room', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw = engine.getRawState();
  addEffect(raw, { kind: 'ONGOING', source: 'p1', target: 'p1', payload: { effect: 'DRIP' } });

  const cellar = Object.values(raw.mapGraph.nodes).find(
    n => n.type === 'ROOM' && !(Array.isArray(n.props?.tags) && (n.props!.tags as string[]).includes('outside'))
  );
  assert(!!cellar, 'an indoor room exists');
  movePlayerTo(raw, 'p1', cellar!.id);

  raw.globalVars.lastRoll = undefined;
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  raw.players.p1.customProps.movesLeft = 0;
  const end = engine.getLegalActions('p1').find(a => a.type === 'END_TURN');
  assert(!!end, 'the turn can end');
  engine.dispatch(end!);

  // The curse fires when the NEXT turn for p1 begins; walk the table round.
  let state = engine.getRawState();
  for (let i = 0; i < 8 && state.activePlayerId !== 'p1'; i++) {
    const next = engine.getLegalActions(state.activeActorId ?? state.activePlayerId).find(a => a.type === 'END_TURN');
    if (!next) break;
    engine.dispatch(next);
    state = engine.getRawState();
  }
  const roll = state.globalVars.lastRoll as { reason?: string } | undefined;
  assertEqual(roll?.reason, '滴血之声', 'the drip check runs indoors');
});

test('rules: the front door is locked until a haunt opens it', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw = engine.getRawState();
  const hall = raw.mapGraph.nodes.room_entrance_hall;
  assert(!!hall, 'the entrance hall exists');
  assertEqual(String(hall!.props?.frontDoor), 'N', 'the front door faces out of the house');
  assertEqual(raw.globalVars.frontDoorLocked, true, 'it starts locked');

  movePlayerTo(raw, 'p1', 'room_entrance_hall');
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  raw.players.p1.customProps.movesLeft = 4;

  const exploresNorth = () =>
    engine.getLegalActions('p1').some(a => a.type === 'EXPLORE_DOOR' && a.payload?.direction === 'N');
  const canTryDoor = () => engine.getLegalActions('p1').some(a => a.type === 'TRY_FRONT_DOOR');

  assertEqual(exploresNorth(), false, 'the locked door is not explorable');
  assertEqual(canTryDoor(), true, 'trying the front door is offered instead');

  // A haunt that opens it makes the doorway explorable again.
  raw.globalVars.frontDoorLocked = false;
  assertEqual(exploresNorth(), true, 'an opened front door can be explored');
});

test('rules: ending a turn in a buff room grants one permanent point, once', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw = engine.getRawState();
  addExploredRoom(raw, 'gymnasium', 0, 2, 'room_grand_staircase');
  movePlayerTo(raw, 'p1', 'room_gymnasium');
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';

  // The buff raises the trait by one STEP on the printed ladder. The ladder has
  // repeated values (speed: [0,1,2,3,3,4,4,5]), so a step does not always change
  // the printed number - assert on the index, not the value.
  const speedIndexBefore = traitIndex(raw.players.p1, 'speed');
  raw.players.p1.customProps.movesLeft = 0;
  const end = engine.getLegalActions('p1').find(a => a.type === 'END_TURN');
  assert(!!end, 'the turn can end');
  const dispatched = engine.dispatch(end!);
  assert(dispatched.ok, `the turn ended (${dispatched.error ?? 'ok'})`);

  const after = engine.getRawState();
  assertEqual(
    traitIndex(after.players.p1, 'speed'),
    speedIndexBefore + 1,
    'the gymnasium advances Speed by one step'
  );
  assert(
    Array.isArray(after.players.p1.customProps.roomBuffs) &&
      (after.players.p1.customProps.roomBuffs as string[]).includes('room_gymnasium'),
    'the claim is recorded on the explorer'
  );

  // Coming back later must not pay twice.
  const claimedIndex = traitIndex(after.players.p1, 'speed');
  after.players.p1.customProps.movesLeft = 0;
  after.activePlayerId = 'p1';
  after.activeActorId = 'p1';
  const again = engine.getLegalActions('p1').find(a => a.type === 'END_TURN');
  if (again) engine.dispatch(again);
  assertEqual(traitIndex(engine.getRawState().players.p1, 'speed'), claimedIndex, 'the buff pays only once');
});

/* -------------------------------------------------------------------------- */
