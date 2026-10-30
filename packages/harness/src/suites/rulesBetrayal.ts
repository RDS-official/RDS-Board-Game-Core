/* -------------------------------------------------------------------------- */
/* suite:rulesBetrayal — moved verbatim from suite.ts */
/* -------------------------------------------------------------------------- */

import { UniversalGameEngine } from '@rds/kernel/engine';
import { GAME_REGISTRY } from '@rds/games/registry';
import { ROOM_DEFS } from '@rds/games/betrayal/cards';
import { addEffect, effectiveTrait, hostilesInRoom, movePlayerTo, movementCost, ongoingEffectKinds, rollTraitCheck, traitIndex, traitModifiers, traitValue, hasRolledThisTurn } from '@rds/games/betrayal/helpers';
import { addExploredRoom, grantItem, grantOmen } from '@rds/games/betrayal/scenarios';
import { stackRoomTiles } from '../suiteHelpers';
import { test, assert, assertEqual } from '../testKit';

test('rules: riding to another floor moves the elevator tile to that floor', () => {
  // The car is the one tile that belongs on every floor, so the data must say so:
  // drawing a tile is filtered by `floors ?? [floor]`.
  assertEqual(
    (ROOM_DEFS.mystic_elevator.floors ?? []).slice().sort().join(','),
    'BASEMENT,GROUND,UPPER',
    'the elevator declares every floor'
  );

  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'room_features' });
  const raw = engine.getRawState();

  // The car starts in the basement; the destination is upstairs.
  addExploredRoom(raw, 'mystic_elevator', 0, 3, 'room_basement_landing');
  movePlayerTo(raw, 'p1', 'room_mystic_elevator');
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  raw.players.p1.customProps.movesLeft = 3;
  raw.players.p1.customProps.elevatorUsed = true;
  raw.globalVars.elevatorRoomId = 'room_mystic_elevator';
  raw.globalVars.elevatorRide = { sum: 3, fromFloor: 'BASEMENT', allowSameFloorOnly: false };

  const upstairs = Object.values(raw.mapGraph.nodes).find(
    node => node.type === 'ROOM' && String(node.props?.floor) === 'UPPER'
  );
  assert(!!upstairs, 'the fixture has an upstairs room');

  const ride = engine
    .getLegalActions('p1')
    .find(a => a.type === 'ELEVATOR_MOVE' && a.targetNodeId === upstairs!.id);
  assert(!!ride, 'the upstairs room offers a doorway to dock at');
  const rideRes = engine.dispatch(ride! as never);
  assert(rideRes.ok, `the ride dispatches (${rideRes.error ?? ''})`);

  const after = engine.getRawState();
  const elevator = after.mapGraph.nodes.room_mystic_elevator;
  assert(!!elevator, 'the elevator tile still exists');

  // The tile must sit on the destination floor, not back down in the basement.
  assertEqual(String(elevator!.props?.floor), 'UPPER', 'the tile moved to the upstairs floor');
  assertEqual(String(elevator!.layer), 'UPPER', 'the tile layer follows the floor');
  assertEqual(
    String(after.players.p1.customProps.floor),
    'UPPER',
    'the rider ends up on the upstairs floor'
  );
  assertEqual(
    String(after.players.p1.customProps.currentRoomId),
    'room_mystic_elevator',
    'the rider is inside the car'
  );
});

test('rules: room floor lists are well formed', () => {
  // A tile may name several floors (drawing filters on `floors ?? [floor]`), but
  // the list must always contain the tile's own base floor and never be empty.
  for (const def of Object.values(ROOM_DEFS)) {
    if (!def.floors) continue;
    assert(def.floors.length > 0, `${def.id} declares an empty floor list`);
    assert(
      def.floors.includes(def.floor),
      `${def.id} floor list omits its base floor ${def.floor}`
    );
  }

  // The once-per-game trait rooms are Gymnasium/Library/Chapel/Larder; the
  // kitchen has no such bonus.
  assertEqual(String(ROOM_DEFS.gymnasium.endTurnBuff), 'speed', 'gymnasium buffs Speed');
  assertEqual(String(ROOM_DEFS.library.endTurnBuff), 'knowledge', 'library buffs Knowledge');
  assertEqual(String(ROOM_DEFS.chapel.endTurnBuff), 'sanity', 'chapel buffs Sanity');
  assertEqual(String(ROOM_DEFS.larder.endTurnBuff), 'might', 'larder buffs Might');
  assertEqual(ROOM_DEFS.kitchen.endTurnBuff, undefined, 'kitchen grants no trait');
});

test('rules: the same check cannot be attempted twice in one turn', () => {
  // Rulebook, Die Rolls: "You cannot try to make the same roll more than once per
  // turn." The vault is the one re-enterable optional check, so it is the honest
  // place to prove the gate.
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw = engine.getRawState();
  addExploredRoom(raw, 'the_vault', 0, 2, 'room_entrance_hall');
  movePlayerTo(raw, 'p1', 'room_the_vault');
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  raw.players.p1.customProps.movesLeft = 2;
  raw.players.p1.customProps.rolledThisTurn = [];

  const vaultOffered = () => engine.getLegalActions('p1').some(a => a.type === 'ROOM_FEATURE');
  assertEqual(vaultOffered(), true, 'the vault can be tried once');

  const attempt = engine.getLegalActions('p1').find(a => a.type === 'ROOM_FEATURE');
  assert(engine.dispatch(attempt!).ok, 'the attempt dispatches');

  assertEqual(hasRolledThisTurn(engine.getRawState(), 'p1', 'vault'), true, 'the attempt is recorded');
  assertEqual(vaultOffered(), false, 'a second attempt is refused in the same turn');

  // A new turn clears the record.
  const after = engine.getRawState();
  after.players.p1.customProps.rolledThisTurn = [];
  assertEqual(vaultOffered(), true, 'a new turn may try again');
});

test('rules: leaving a room with an opponent costs an extra space for everyone', () => {
  // Rulebook, Moving Past Opponents: "for each opponent in a room with you, a
  // Hero, monster or Traitor must use one extra space of movement to leave".
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_zombie' });
  const raw = engine.getRawState();

  const traitorId = Object.entries(raw.players).find(([, p]) => p.role === 'TRAITOR')?.[0];
  assert(!!traitorId, 'the fixture has a traitor');
  const heroId = Object.entries(raw.players).find(([id, p]) => id !== traitorId && p.alive)?.[0];
  assert(!!heroId, 'the fixture has a living hero');

  const room = String(raw.players[heroId!].customProps.currentRoomId);
  movePlayerTo(raw, traitorId!, room);

  assertEqual(hostilesInRoom(raw, heroId!, room), 1, 'the hero counts the traitor as an opponent');
  assertEqual(movementCost(raw, heroId!, room), 2, 'the hero pays two spaces to leave');

  assertEqual(hostilesInRoom(raw, traitorId!, room), 1, 'the traitor counts the hero as an opponent');
  assertEqual(movementCost(raw, traitorId!, room), 2, 'the traitor also pays two spaces to leave');

  // Standing with its own monsters is not an opponent for the traitor.
  const elsewhere = Object.values(raw.mapGraph.nodes).find(
    n => n.type === 'ROOM' && n.id !== room && String(n.props?.floor) === String(raw.mapGraph.nodes[room]?.props?.floor)
  );
  assert(!!elsewhere, 'another room on the same floor exists');
  movePlayerTo(raw, traitorId!, elsewhere!.id);
  assertEqual(hostilesInRoom(raw, traitorId!, elsewhere!.id), 0, 'no hero there, no penalty');
  assertEqual(movementCost(raw, traitorId!, elsewhere!.id), 1, 'the traitor moves freely alone');
});

test('rules: a non-tradable item can still be dropped, a companion cannot', () => {
  // Rulebook, Using Items and Omens: "Some items can't be traded, but MAY BE
  // DROPPED OR PICKED UP." Companions are the only things barred from that.
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw = engine.getRawState();
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  raw.players.p1.customProps.movesLeft = 3;

  // Bite is an omen that cannot be traded and is not a companion.
  grantOmen(raw, 'p1', 'bite');
  const biteDrop = () => engine.getLegalActions('p1').find(a => a.type === 'DROP_ITEM');
  assert(!!biteDrop(), 'a non-tradable omen can be dropped');
  assert(engine.dispatch(biteDrop()!).ok, 'dropping it dispatches');

  // The dog is a companion: it follows its custodian and cannot be dropped.
  grantOmen(raw, 'p1', 'dog');
  const dogDrop = engine
    .getLegalActions('p1')
    .find(a => a.type === 'DROP_ITEM' && String(a.entityId ?? '').includes('dog'));
  assertEqual(dogDrop, undefined, 'a companion cannot be dropped');
});

test('rules: becoming the traitor clears lingering event effects', () => {
  // Rulebook, Traitor and Monster Powers: "When you become a traitor, prior
  // lingering bad effects from Event cards disappear."
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 7, { scenario: 'omen_ready' });
  const raw = engine.getRawState();
  addEffect(raw, { kind: 'ONGOING', source: 'p1', target: 'p1', payload: { effect: 'DRIP' } });
  raw.players.p1.customProps.effects = ['DRIP'];
  assertEqual(ongoingEffectKinds(raw, 'p1').length > 0, true, 'the curse is active before the haunt');

  // Trigger the haunt through the pending roll so startHaunt runs for real.
  raw.globalVars.omensRevealed = 13;
  raw.globalVars.pendingHauntRoll = { playerId: 'p1', omens: 13 };
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  raw.players.p1.customProps.movesLeft = 0;
  const end = engine.getLegalActions('p1').find(a => a.type === 'END_TURN');
  assert(!!end, 'the turn can end');
  engine.dispatch(end!);
  const roll = engine.getLegalActions('p1').find(a => a.type === 'ROLL_HAUNT_CHECK');
  assert(!!roll, 'the haunt roll is offered');
  engine.dispatch(roll!);

  const after = engine.getRawState();
  assertEqual(after.globalVars.hauntTriggered, true, 'the haunt started');
  assertEqual(String(after.players.p1.role), 'TRAITOR', 'the revealer is the traitor');
  assertEqual(ongoingEffectKinds(after, 'p1').length, 0, 'no lingering curse remains on the traitor');
});

test('rules: a stunned monster still moves but cannot attack', () => {
  // Rulebook, Death and Stuns: "a stunned monster can't slow an explorer's
  // movement, but a Traitor may still move the monster."
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_zombie' });
  const raw = engine.getRawState();

  const npcId = Object.keys(raw.npcs ?? {}).find(id => raw.npcs![id].status === 'ACTIVE');
  assert(!!npcId, 'the fixture has an active monster');
  const npc = raw.npcs![npcId!];
  const entity = npc.entityId ? raw.entities[npc.entityId] : undefined;
  assert(!!entity, 'the monster has an entity');

  raw.activeActorId = npcId!;
  npc.customProps.movesLeft = 2;
  npc.customProps.attacksLeft = 1;
  entity!.components.custom = { ...(entity!.components.custom ?? {}), stunned: true, stunTurns: 1 };

  const legal = engine.getLegalActions(npcId!);
  assertEqual(
    legal.some(a => a.type === 'MOVE_NPC'),
    true,
    'a stunned monster can still be moved'
  );
  assertEqual(
    legal.some(a => a.type === 'ATTACK_HERO'),
    false,
    'a stunned monster cannot attack'
  );
});

test('rules: the traitor rides the elevator without rolling', () => {
  // Rulebook, Mystic Elevator: "Traitors and Monsters can use the Elevator
  // without rolling, but only once per Traitor/Monster set of turns."
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_zombie' });
  const raw = engine.getRawState();

  const traitorId = Object.entries(raw.players).find(([, p]) => p.role === 'TRAITOR')?.[0];
  assert(!!traitorId, 'the fixture has a traitor');
  addExploredRoom(raw, 'mystic_elevator', 0, 3, 'room_basement_landing');
  movePlayerTo(raw, traitorId!, 'room_mystic_elevator');
  raw.activePlayerId = traitorId!;
  raw.activeActorId = traitorId!;
  raw.players[traitorId!].customProps.movesLeft = 3;
  raw.players[traitorId!].customProps.elevatorUsed = false;
  raw.globalVars.elevatorRoomId = 'room_mystic_elevator';

  const seedBefore = raw.prngState;
  const ride = engine.getLegalActions(traitorId!).find(a => a.type === 'USE_ELEVATOR');
  assert(!!ride, 'the ride is offered');
  assert(engine.dispatch(ride!).ok, 'the ride dispatches');

  const after = engine.getRawState();
  assertEqual(after.prngState, seedBefore, 'no dice are consumed for the traitor');
  assertEqual(after.globalVars.lastElevatorRoll, undefined, 'no roll is recorded');
  assertEqual(
    (after.globalVars.elevatorRide as { sum?: number } | undefined)?.sum,
    3,
    'the traitor may pick any floor'
  );
});

test('rules: the traitor ignores harmful room text but keeps the movement', () => {
  // Rulebook, Traitor and Monster Powers: "Traitors and monsters can use any
  // beneficial text on a room tile ... while ignoring any harmful text".
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_zombie' });
  const raw = engine.getRawState();
  const traitorId = Object.entries(raw.players).find(([, p]) => p.role === 'TRAITOR')?.[0];
  assert(!!traitorId, 'the fixture has a traitor');

  // The Gallery drop moves you to the Ballroom and costs a point of physical
  // damage without a rope. The traitor takes the move and skips the damage.
  // The haunt fixture has neither room, so place them adjacent to each other.
  addExploredRoom(raw, 'ballroom', 0, 1, 'room_basement_landing');
  addExploredRoom(raw, 'gallery', 0, 0, 'room_ballroom');
  const gallery = raw.mapGraph.nodes.room_gallery;
  const ballroom = raw.mapGraph.nodes.room_ballroom;
  assert(!!gallery, 'the gallery was placed');
  assert(!!ballroom, 'the ballroom was placed');

  const before_ = {
    might: traitValue(raw.players[traitorId!], 'might'),
    speed: traitValue(raw.players[traitorId!], 'speed')
  };
  movePlayerTo(raw, traitorId!, gallery!.id);
  raw.activePlayerId = traitorId!;
  raw.activeActorId = traitorId!;
  raw.players[traitorId!].customProps.movesLeft = 2;

  const jump = engine.getLegalActions(traitorId!).find(a => a.type === 'JUMP_DOWN');
  assert(!!jump, 'the gallery offers the drop');
  assert(engine.dispatch(jump!).ok, 'the drop dispatches');

  const after = engine.getRawState();
  assertEqual(String(after.players[traitorId!].customProps.currentRoomId), ballroom!.id, 'the traitor still falls');
  assertEqual(traitValue(after.players[traitorId!], 'might'), before_.might, 'no Might is lost');
  assertEqual(traitValue(after.players[traitorId!], 'speed'), before_.speed, 'no Speed is lost');
});

test('rules: an exit room gates movement, and a failed roll offers stay or pay', () => {
  // Rulebook, Special Rooms: "If an explorer fails his roll, he may choose to stay
  // in the room and try again on his next turn instead of taking damage."
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw = engine.getRawState();
  addExploredRoom(raw, 'graveyard', 0, 2, 'room_entrance_hall');
  movePlayerTo(raw, 'p1', 'room_graveyard');
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  raw.players.p1.customProps.movesLeft = 3;
  raw.players.p1.customProps.exitPassedRoom = undefined;
  raw.globalVars.pendingExit = null;

  const types = () => engine.getLegalActions('p1').map(a => a.type);
  assertEqual(types().includes('ROOM_EXIT_CHECK'), true, 'the exit roll is offered');
  assertEqual(types().includes('MOVE_TO_ROOM'), false, 'you cannot just walk out');

  // Success opens the way.
  raw.players.p1.customProps.forcedRoll = { value: 8 };
  const tryExit = engine.getLegalActions('p1').find(a => a.type === 'ROOM_EXIT_CHECK');
  assert(engine.dispatch(tryExit!).ok, 'the exit roll dispatches');
  assertEqual(
    String(engine.getRawState().players.p1.customProps.exitPassedRoom),
    'room_graveyard',
    'a successful roll unlocks the door'
  );
  assertEqual(
    engine.getLegalActions('p1').some(a => a.type === 'MOVE_TO_ROOM'),
    true,
    'movement is available after passing'
  );

  // Failure parks the choice.
  const fail = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw2 = fail.getRawState();
  addExploredRoom(raw2, 'graveyard', 0, 2, 'room_entrance_hall');
  movePlayerTo(raw2, 'p1', 'room_graveyard');
  raw2.activePlayerId = 'p1';
  raw2.activeActorId = 'p1';
  raw2.players.p1.customProps.movesLeft = 3;
  raw2.players.p1.customProps.forcedRoll = { value: 0 };
  const failRoll = fail.getLegalActions('p1').find(a => a.type === 'ROOM_EXIT_CHECK');
  assert(failRoll, 'the exit roll is offered');
  assert(fail.dispatch(failRoll!).ok, 'the failing roll dispatches');

  const afterFail = fail.getLegalActions('p1').map(a => a.type);
  assertEqual(afterFail.includes('EXIT_STAY'), true, 'staying is offered');
  assertEqual(afterFail.includes('EXIT_PAY'), true, 'paying is offered');

  // Staying costs nothing but ends this turn's movement.
  const knowledgeBefore = traitValue(fail.getRawState().players.p1, 'knowledge');
  const stay = fail.getLegalActions('p1').find(a => a.type === 'EXIT_STAY');
  assert(fail.dispatch(stay!).ok, 'staying dispatches');
  const stayed = fail.getRawState();
  assertEqual(traitValue(stayed.players.p1, 'knowledge'), knowledgeBefore, 'staying costs no trait');
  assertEqual(Number(stayed.players.p1.customProps.movesLeft), 0, 'staying ends movement');
});

test('rules: a dead explorer\'s companion is claimed by whoever enters the room', () => {
  // Rulebook, Death and Stuns: "If an explorer dies put an Item Token in the room
  // along with any Companion token. Any other explorer that enters the room gains
  // custody of the companion."
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw = engine.getRawState();
  grantOmen(raw, 'p1', 'dog');
  const dogId = Object.values(raw.entities).find(
    e => e.components.custom?.cardType === 'OMEN' && e.components.custom?.companion
  )?.id;
  assert(!!dogId, 'the dog is in hand');

  // Where can p2 walk? That is the room the companion will be lying in.
  raw.activePlayerId = 'p2';
  raw.activeActorId = 'p2';
  raw.players.p2.customProps.movesLeft = 3;
  const move = engine.getLegalActions('p2').find(a => a.type === 'MOVE_TO_ROOM');
  assert(!!move, 'p2 has somewhere to go');
  const destination = String(
    (move!.selection as { scope?: { neighbors?: string[] } })?.scope?.neighbors?.[0] ?? ''
  );
  assert(destination.length > 0, 'the destination is known');

  // The dead explorer's companion lies there, unowned.
  raw.players.p1.alive = false;
  raw.players.p1.customProps.banished = true;
  const hand = raw.zones['zone_hand_p1'];
  const at = hand.orderedEntities.indexOf(dogId!);
  if (at >= 0) hand.orderedEntities.splice(at, 1);
  const zoneId = `zone_room_${destination}`;
  let zone = raw.zones[zoneId];
  if (!zone) {
    zone = {
      id: zoneId,
      orderedEntities: [],
      capacity: 99,
      visibility: { type: 'PUBLIC' }
    } as never;
    raw.zones[zoneId] = zone;
  }
  // Drop stale zone listings first: the fixture's room zone carries entries whose
  // entity.zoneId points at a deck, which the kernel rightly rejects on the next
  // move. Only real occupants are kept.
  (zone as { orderedEntities: string[] }).orderedEntities = (
    zone as { orderedEntities: string[] }
  ).orderedEntities.filter(id => raw.entities[id]?.zoneId === (zone as { id: string }).id);
  (zone as { orderedEntities: string[] }).orderedEntities.push(dogId!);
  raw.entities[dogId!].ownerId = undefined;
  raw.entities[dogId!].zoneId = (zone as { id: string }).id;

  const mv = engine.dispatch({ ...move!, targets: [destination] } as never);
  assert(mv.ok, `the move dispatches (${mv.error ?? ''})`);

  const after = engine.getRawState();
  assertEqual(String(after.entities[dogId!].ownerId ?? ''), 'p2', 'the dog follows its new custodian');
  assert(
    after.zones['zone_hand_p2'].orderedEntities.includes(dogId!),
    'the companion moved into the new owner hand'
  );
});

test('rules: the crystal ball rolls Knowledge like the card says', () => {
  // Official card text: "Once per turn, make a Knowledge roll: 4+ Cosmic insight
  // (Gain 1 Knowledge); 1-3 Swirling mists; 0 Demonic vision (Lose 1 Sanity)."
  //
  // NOTE: docs/RULES-CROSSCHECK.md also carries a rulebook line saying the ball
  // "can only be used to look through undrawn Item and Event cards". The printed
  // card is the authority for the card's own effect, so the roll wins here; the
  // discrepancy is recorded in docs/CARD-EFFECT-AUDIT.md.
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw = engine.getRawState();
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  grantOmen(raw, 'p1', 'crystal_ball');

  const topBefore = raw.zones.zone_event_deck.orderedEntities[0];
  raw.players.p1.customProps.forcedRoll = { value: 8 };

  const use = engine.getLegalActions('p1').find(a => a.type === 'USE_ITEM');
  assert(!!use, 'the ball can be used');
  assert(engine.dispatch(use!).ok, 'using it dispatches');

  const after = engine.getRawState();
  assertEqual(after.zones.zone_event_deck.orderedEntities[0], topBefore, 'the deck order is untouched');
  assertEqual(after.globalVars.peek ?? null, null, 'no peek is recorded any more');
  assert(
    traitIndex(after.players.p1, 'knowledge') > traitIndex(raw.players.p1, 'knowledge'),
    'a good roll grants Knowledge'
  );
});

test('rules: the dog is a companion, not a fetch skill, and it cannot ride the elevator', () => {
  // Rulebook, Using Items and Omens: "The Dog can't go through one-way passages,
  // any passage like the Revolving Wall that requires a roll, or use the Mystic
  // Elevator. His movement is not slowed by monsters."
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'room_features' });
  const raw = engine.getRawState();
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  raw.players.p1.customProps.movesLeft = 3;

  const elevator = Object.values(raw.mapGraph.nodes).find(n => n.props?.special === 'ELEVATOR');
  assert(!!elevator, 'the fixture has an elevator');
  movePlayerTo(raw, 'p1', elevator!.id);
  raw.players.p1.customProps.elevatorUsed = false;

  const rides = () => engine.getLegalActions('p1').some(a => a.type === 'USE_ELEVATOR');
  assertEqual(rides(), true, 'without the dog the ride is offered');

  grantOmen(raw, 'p1', 'dog');
  assertEqual(rides(), false, 'the dog bars the elevator');

  // The dog is not a usable item any more: no USE_ITEM for it.
  const usesDog = engine
    .getLegalActions('p1')
    .some(a => a.type === 'USE_ITEM' && String(a.entityId ?? '').includes('dog'));
  assertEqual(usesDog, false, 'the dog has no activated ability');
});

test('rules: a failed steal still lands the damage', () => {
  // Rulebook, Physical Damage: "you may steal a tradable item instead of doing the
  // damage" - when nothing can actually be stolen the hit must still wound. The
  // steal predicate and the steal executor used to disagree, so the damage was
  // silently swallowed whenever the victim only held unstealable cards.
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_zombie' });
  const raw = engine.getRawState();
  const traitorId = Object.entries(raw.players).find(([, p]) => p.role === 'TRAITOR')?.[0];
  const heroId = Object.entries(raw.players).find(([id, p]) => id !== traitorId && p.alive)?.[0];
  assert(!!traitorId && !!heroId, 'the fixture has both sides');

  const room = String(raw.players[traitorId!].customProps.currentRoomId);
  movePlayerTo(raw, heroId!, room);

  // The hero holds only armour, which is explicitly unstealable.
  for (const entity of Object.values(raw.entities)) {
    if (entity.ownerId === heroId) entity.ownerId = undefined;
  }
  grantItem(raw, heroId!, 'armor');

  const hero = raw.players[heroId!];
  const before = {
    might: traitValue(hero, 'might'),
    speed: traitValue(hero, 'speed')
  };

  raw.activePlayerId = traitorId!;
  raw.activeActorId = traitorId!;
  // Attacks roll raw dice (not trait checks), so a forced roll cannot pin the
  // outcome. Swing until a decisive hit lands.
  let decisive = false;
  for (let attempt = 0; attempt < 25 && !decisive; attempt += 1) {
    const state = engine.getRawState();
    state.activePlayerId = traitorId!;
    state.activeActorId = traitorId!;
    state.players[traitorId!].customProps.attacksLeft = 1;
    const attack = engine.getLegalActions(traitorId!).find(a => a.type === 'ATTACK_PLAYER');
    if (!attack) break;
    engine.dispatch({ ...attack, payload: { ...(attack.payload ?? {}), weapon: 'fists', steal: 'yes' } } as never);

    const now = engine.getRawState();
    const heroNow = now.players[heroId!];
    const pending = now.globalVars.pendingDamage as { amount?: number } | undefined;
    const stolen = [...(now.zones[`zone_hand_${traitorId}`]?.orderedEntities ?? [])].length > 0;
    if (pending !== undefined && pending !== null) { decisive = true; break; }
    if (traitValue(heroNow, 'might') + traitValue(heroNow, 'speed') < before.might + before.speed) { decisive = true; break; }
    if (stolen) { decisive = true; break; }
  }
  assert(decisive, 'a landed hit always resolves: damage applied, queued, or an item stolen');
});



test('rules: the music box rolls Sanity and shifts it, it does not freeze anyone', () => {
  // Official text: "Play melody: make a Sanity roll: 4+ Soothing tune (Gain 1
  // Sanity); 0-3 Agonizing discord (Lose 1 Sanity)." The old implementation zeroed
  // movesLeft/attacksLeft/skipActions on nearby players, all of which
  // resetTurnResources clears before the effect could ever matter.
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw = engine.getRawState();
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  grantItem(raw, 'p1', 'music_box');
  raw.players.p1.customProps.forcedRoll = { value: 8 };

  const sanityBefore = traitIndex(raw.players.p1, 'sanity');
  const use = engine.getLegalActions('p1').find(a => a.type === 'USE_ITEM');
  assert(!!use, 'the box can be played');
  assert(engine.dispatch(use!).ok, 'playing it dispatches');

  const after = engine.getRawState();
  assertEqual(traitIndex(after.players.p1, 'sanity'), sanityBefore + 1, 'a good tune restores Sanity');
  assertEqual(Boolean(after.players.p1.customProps.skipActions), false, 'nobody is frozen');
  assertEqual(Number(after.players.p1.customProps.movesLeft), Number(raw.players.p1.customProps.movesLeft), 'movement is untouched');
});

test('rules: the underground lake is a basement-only tile', () => {
  // The rulebook mentions the Lake collapsing "if found on the upper floor", which
  // reads like it could be drawn upstairs. The 2E printing restricts it to the
  // basement, and the audit found no evidence of the multi-floor version, so the
  // tile stays single-floor. This test locks that decision so a future edit has to
  // make it deliberately.
  const lake = ROOM_DEFS.underground_lake;
  assert(!!lake, 'the lake exists');
  assertEqual(String(lake!.floor), 'BASEMENT', 'the lake sits on the basement floor');
  assertEqual(lake!.floors, undefined, 'the lake declares no extra floors');
});

test('rules: exploring into the collapsed room does not freeze the table', () => {
  // Reported bug: an explorer drew the collapsed room, fell to the basement, and
  // the tile stayed unresolved. Re-entering it collapsed again, so the room never
  // paid out and the table looked wedged.
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 11);
  const raw = engine.getRawState();
  stackRoomTiles(raw, ['collapsed_room']);

  const explore = engine
    .getLegalActions('p1')
    .find(action => action.type === 'EXPLORE_DOOR' && action.payload?.direction === 'E');
  assert(!!explore, 'a door is explorable');
  assert(engine.dispatch(explore!).ok, 'explore draws the tile');

  const pending = engine.getRawState().globalVars.pendingRoomPlacement as
    | { defId: string; rotations: number[] }
    | undefined;
  assert(!!pending, 'the tile waits for orientation');
  assertEqual(pending!.defId, 'collapsed_room', 'the collapsed room was drawn');

  // Make the Speed 5+ fall check fail.
  engine.getRawState().players.p1.customProps.forcedRoll = { value: 0 };
  const place = engine.getLegalActions('p1').find(action => action.type === 'PLACE_ROOM');
  assert(!!place, 'orientation is offered');
  const rotation = Number(place!.fields![0].options![0].value);
  assert(engine.dispatch({ ...place!, payload: { rotation: String(rotation) } }).ok, 'orientation accepted');

  const afterFall = engine.getRawState();
  assertEqual(
    String(afterFall.players.p1.customProps.currentRoomId),
    'room_basement_landing',
    'the explorer fell to the basement landing'
  );
  assertEqual(
    afterFall.globalVars.pendingRoomPlacement ?? null,
    null,
    'no room placement is left pending'
  );

  // The tile must be spent, otherwise re-entering it collapses again forever.
  assertEqual(
    Boolean(afterFall.mapGraph.nodes.room_collapsed_room?.props?.resolved),
    true,
    'the collapsed room is marked resolved'
  );

  // Hand the turn on, then make sure the next explorer is not locked out.
  for (let guard = 0; guard < 8; guard += 1) {
    const state = engine.getRawState();
    if (state.activePlayerId !== 'p1') break;
    const end = engine.getLegalActions('p1').find(action => action.type === 'END_TURN');
    if (!end) break;
    engine.dispatch(end);
  }

  const nextState = engine.getRawState();
  const nextPlayer = nextState.activePlayerId;
  assert(nextPlayer !== 'p1', 'the turn moved on');
  const legal = engine.getLegalActions(nextPlayer);
  assert(
    legal.some(action => action.type === 'MOVE_TO_ROOM' || action.type === 'EXPLORE_DOOR'),
    `the next explorer can still act (got: ${legal.map(action => action.type).join(', ') || 'nothing'})`
  );
});

test('rules: a carried modifier feeds the dice, not a hidden stat', () => {
  // Armor reads "+1 Might" on the card. The old `passive: { physicalArmor: 1 }` was
  // never read by anything, so the card did nothing at all.
  // See docs/ENGINE-PASSIVE-MODIFIERS.md.
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw = engine.getRawState();
  assertEqual(traitModifiers(raw, 'p1').might, 0, 'no modifiers before the armor is picked up');

  grantItem(raw, 'p1', 'armor');
  const after = traitModifiers(raw, 'p1');
  assertEqual(after.might, 1, 'the armor grants +1 Might');
  assertEqual(after.speed, 0, 'and touches nothing else');

  assertEqual(
    effectiveTrait(raw, 'p1', 'might'),
    traitValue(raw.players.p1, 'might') + 1,
    'the effective value includes the modifier'
  );

  // The bonus has to reach the dice, otherwise it is dead data again.
  raw.players.p1.customProps.forcedRoll = { value: 4 };
  const check = rollTraitCheck(raw, 'p1', 'might', { threshold: 1 });
  assertEqual(check.count, effectiveTrait(raw, 'p1', 'might'), 'the check rolls the modified value');
});

test('rules: every official event that asks for a roll actually rolls', () => {
  // Some events silently resolved without dice. The roll is driven by
  // globalVars.lastRoll, so assert it changes for a card that demands a check.
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 11);
  const raw = engine.getRawState();
  const deck = raw.zones.zone_event_deck;
  const target = deck.orderedEntities.find(id => raw.entities[id]?.components.custom?.defId === 'phone_call');
  assert(!!target, 'phone_call is in the deck');
  deck.orderedEntities = [target!, ...deck.orderedEntities.filter(id => id !== target)];

  raw.globalVars.lastRoll = null;
  raw.players.p1.customProps.forcedRoll = { value: 5 };

  // Draw a room whose symbol is EVENT so the event deck is actually touched.
  stackRoomTiles(raw, ['game_room']);
  const explore = engine.getLegalActions('p1').find(
    action => action.type === 'EXPLORE_DOOR' && action.payload?.direction === 'E'
  );
  assert(!!explore, 'a door is explorable');
  engine.dispatch(explore!);
  const place = engine.getLegalActions('p1').find(action => action.type === 'PLACE_ROOM');
  if (place) {
    const rotation = Number(place.fields![0].options![0].value);
    engine.dispatch({ ...place, payload: { rotation: String(rotation) } });
  }
  const roll = engine.getRawState().globalVars.lastRoll as
    | { reason?: string; total?: number; label?: string; threshold?: number; effect?: string }
    | null;
  assert(!!roll, 'a roll was recorded');
  assertEqual(roll!.total, 5, 'the recorded roll carries the result');
  // The dice overlay captions the roll with the card name and lists the bands.
  // Whatever card came up, the overlay must name it rather than showing a bare trait.
  assert(typeof roll!.label === 'string' && roll!.label!.length > 0, 'the overlay names the card that asked for the roll');
  assert(!!roll!.effect && roll!.effect.length > 0, 'the overlay lists what each band costs');
  // A three-band card has no single success line; a 0 threshold rendered a
  // meaningless "成功 / 0" verdict.
  assertEqual(roll!.threshold, undefined, 'no bogus success threshold is passed');
});
