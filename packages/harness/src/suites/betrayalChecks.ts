/* -------------------------------------------------------------------------- */
/* suite:betrayalChecks — moved verbatim from suite.ts */
/* -------------------------------------------------------------------------- */

import { UniversalGameEngine } from '@rds/kernel/engine';
import { RollWindowManager } from '@rds/kernel/rollWindow';
import { GAME_REGISTRY } from '@rds/games/registry';
import { addEffect, damagePlayer, effectsOn, movePlayerTo, ongoingEffectKinds, removeEffects } from '@rds/games/betrayal/helpers';
import { grantItem } from '@rds/games/betrayal/scenarios';
import { test, assert, assertEqual } from '../testKit';
import { playRandom, betrayalCardInHand, resolvePendingDamage
} from '../suiteHelpers';

test('fixture betrayal: a vault check with luck items becomes a two-phase window', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'room_features' });
  const raw = engine.getRawState();
  // p1 starts in the vault; hand them a post-roll luck item so there is a choice.
  grantItem(raw, 'p1', 'lucky_stone');
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';

  const feature = engine.getLegalActions('p1').find(a => a.type === 'ROOM_FEATURE');
  assert(!!feature, 'the vault is pokable');
  assert(engine.dispatch(feature!).ok, 'opening the vault check is accepted');

  // Phase 1: the window is open and the table is gated on it.
  let state = engine.getRawState();
  const window = RollWindowManager.current(state);
  assert(!!window, 'a roll window opened');
  assertEqual(window!.phase, 'DECLARE', 'it starts in the declare phase');
  assertEqual(window!.payload?.kind, 'VAULT', 'the payload names the vault');

  const gated = engine.getLegalActions('p1').map(a => a.type).sort().join(',');
  assertEqual(gated, 'RESOLVE_CHECK,ROLL_CHECK', 'other actions are gated behind the window');

  // Phase 2: throw the dice.
  const roll = engine.getLegalActions('p1').find(a => a.type === 'ROLL_CHECK');
  assert(!!roll, 'the roll is offered');
  assert(engine.dispatch(roll!).ok, 'rolling is accepted');
  state = engine.getRawState();
  assertEqual(RollWindowManager.current(state)!.phase, 'REACT', 'the window moved to react');
  assert(typeof RollWindowManager.current(state)!.result?.total === 'number', 'a result was recorded');

  // Phase 3: react with the lucky stone, then resolve.
  const react = engine.getLegalActions('p1').find(a => a.type === 'CHECK_REACTION');
  assert(!!react, 'the lucky stone is offered as a reaction');
  assert(engine.dispatch(react!).ok, 'using the lucky stone is accepted');
  const resolve = engine.getLegalActions('p1').find(a => a.type === 'RESOLVE_CHECK');
  assert(!!resolve, 'resolve stays available');
  assert(engine.dispatch(resolve!).ok, 'resolving is accepted');

  state = engine.getRawState();
  assert(!RollWindowManager.isPending(state), 'the window is closed');
  assert(
    engine.getLegalActions('p1').some(a => a.type !== 'RESOLVE_CHECK' && a.type !== 'ROLL_CHECK'),
    'normal actions return after the window closes'
  );
});

test('fixture betrayal: a vault check without luck items stays a single dispatch', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'room_features' });
  const raw = engine.getRawState();
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';

  const feature = engine.getLegalActions('p1').find(a => a.type === 'ROOM_FEATURE');
  assert(engine.dispatch(feature!).ok, 'the vault check resolves inline');
  assert(
    !RollWindowManager.isPending(engine.getRawState()),
    'no window is opened when there is nothing to decide'
  );
});

test('fixture betrayal: ongoing curses live on the kernel effect list', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'trade_ready' });
  const raw = engine.getRawState();

  // Two *different* curses on one explorer must coexist, not overwrite.
  addEffect(raw, { kind: 'ONGOING', source: 'p1', target: 'p1', payload: { effect: 'DRIP' } });
  addEffect(raw, { kind: 'ONGOING', source: 'p1', target: 'p1', payload: { effect: 'CHILL' } });
  assertEqual(ongoingEffectKinds(raw, 'p1').sort().join(','), 'CHILL,DRIP', 'both curses are active');

  // Re-applying the same curse is idempotent rather than stacking duplicates.
  addEffect(raw, { kind: 'ONGOING', source: 'p1', target: 'p1', payload: { effect: 'DRIP' } });
  assertEqual(ongoingEffectKinds(raw, 'p1').length, 2, 're-applying does not duplicate');

  // Curses are stored on the kernel list, not in scattered customProps.
  assertEqual(raw.effects?.length, 2, 'kernel effect list owns the instances');
  assertEqual(
    (raw.players.p1.customProps.effects ?? []).length,
    0,
    'no new entries land in customProps.effects'
  );

  // Effects survive canonical serialization (replay hash covers them).
  const snapshot = JSON.stringify(raw.effects);
  assert(snapshot.includes('DRIP') && snapshot.includes('CHILL'), 'effects are plain JSON');

  // Removal is scoped and reports a count.
  assertEqual(removeEffects(raw, effect => effect.target === 'p1' && effect.kind === 'ONGOING'), 2, 'both removed');
  assertEqual(ongoingEffectKinds(raw, 'p1').length, 0, 'effect list drained');

  // Legacy `customProps.effects` still reads, so pre-migration logs replay.
  raw.players.p1.customProps.effects = ['MARK_OF_FEAR'];
  assertEqual(ongoingEffectKinds(raw, 'p1').join(','), 'MARK_OF_FEAR', 'legacy field is folded in');
  assertEqual(effectsOn(raw, 'p1').length, 1, 'legacy entry surfaces as an instance');
});

test('fixture betrayal: death drops the hand into an item pile', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_mummy' });
  const state = engine.getRawState();
  const handBefore = state.zones.zone_hand_p2.orderedEntities.length;
  assert(handBefore >= 2, 'p2 holds the girl and a rope');

  damagePlayer(state, 'p2', 'PHYSICAL', 20, 'might');
  assertEqual(state.players.p2.alive, false, 'p2 died at 0 might');
  assertEqual(state.zones.zone_hand_p2.orderedEntities.length, 0, 'hand emptied');

  const pile = state.zones.zone_room_room_catacombs;
  assert(!!pile, 'item pile zone created in the room');
  assert(
    pile.orderedEntities.some(id => state.entities[id].components.custom?.defId === 'girl'),
    'companion waits in the room'
  );
  assert(
    pile.orderedEntities.some(id => state.entities[id].components.custom?.defId === 'rope'),
    'item forms the pile'
  );
});

test('fixture betrayal: rope allows a safe drop and the only way back up', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw = engine.getRawState();
  movePlayerTo(raw, 'p2', 'room_balcony');
  raw.activePlayerId = 'p2';
  raw.activeActorId = 'p2';
  raw.players.p2.customProps.movesLeft = 4;

  const jump = engine.getLegalActions('p2').find(action => action.type === 'JUMP_DOWN');
  assert(!!jump, 'balcony overlooks the ballroom');
  assert(engine.dispatch(jump!).ok, 'jump accepted');
  assertEqual(engine.getRawState().players.p2.customProps.currentRoomId, 'room_ballroom', 'landed in the ballroom');
  assertEqual(engine.getRawState().players.p2.customProps.traits.might, 2, 'rope prevents fall damage');

  engine.getRawState().players.p2.customProps.movesLeft = 4;
  const climb = engine.getLegalActions('p2').find(action => action.type === 'CLIMB_UP');
  assert(!!climb, 'rope allows climbing back up');
  assert(engine.dispatch(climb!).ok, 'climb accepted');
  assertEqual(engine.getRawState().players.p2.customProps.currentRoomId, 'room_balcony', 'returned to the balcony');
});

test('fixture betrayal: consent trade swaps items and replays exactly', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'trade_ready' });
  const state = engine.getRawState();
  const axe = betrayalCardInHand(state, 'p1', 'axe')!;
  const rope = betrayalCardInHand(state, 'p2', 'rope')!;
  assert(!!axe && !!rope, 'both trade goods exist');

  assert(
    engine.dispatch({ type: 'PROPOSE_ITEM_TRADE', playerId: 'p1', payload: { give: axe, want: rope } }).ok,
    'trade proposed'
  );
  assertEqual(engine.getFocusPlayers().join(','), 'p2', 'partner must respond');
  const accept = engine.getLegalActions('p2').find(action => action.type === 'ACCEPT_TRADE');
  assert(!!accept, 'acceptance offered');
  assert(engine.dispatch(accept!).ok, 'trade accepted');

  const after = engine.getRawState();
  assertEqual(betrayalCardInHand(after, 'p1', 'rope'), rope, 'p1 received the rope');
  assertEqual(betrayalCardInHand(after, 'p2', 'axe'), axe, 'p2 received the axe');
  assert(engine.verifyReplay().ok, 'trade flow replays bit-exactly');
});

test('fixture betrayal: projections hide the opposing objective and the room deck order', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_mummy' });
  const heroView = engine.getProjectedStateFor('p2');
  const traitorView = engine.getProjectedStateFor('p1');

  assert(!!(heroView.globalVars.hauntObjectives as any)?.hero, 'hero sees the hero objective');
  assertEqual((heroView.globalVars.hauntObjectives as any)?.traitor, undefined, 'hero cannot see the traitor objective');
  assert(!!(traitorView.globalVars.hauntObjectives as any)?.traitor, 'traitor sees their objective');
  assertEqual((traitorView.globalVars.hauntObjectives as any)?.hero, undefined, 'traitor cannot see the hero objective');
  assertEqual('roomDeck' in heroView.globalVars, false, 'room deck order is hidden');
  assert(Number(heroView.globalVars.roomDeckCount) > 0, 'deck count remains public');
});

test('fixture betrayal: mummy ritual and eye beacon reach the victory conditions', () => {
  const mummyEngine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_mummy' });
  const mummyState = mummyEngine.getRawState();
  movePlayerTo(mummyState, 'p3', 'room_catacombs');
  mummyState.activePlayerId = 'p3';
  mummyState.activeActorId = 'p3';
  mummyState.globalVars.haunt.progress = 1;
  mummyState.players.p3.customProps.forcedRoll = { value: 8 };
  const seal = mummyEngine.getLegalActions('p3').find(action => action.type === 'SEAL_RITUAL');
  assert(!!seal, 'seal ritual available at the sarcophagus');
  assert(mummyEngine.dispatch(seal!).ok, 'seal accepted');
  assertEqual(mummyEngine.getRawState().gameOver, true, 'second seal ends the game');
  assertEqual((mummyEngine.getRawState().winner as string[]).includes('p2'), true, 'heroes win');

  const eyeEngine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_eye' });
  const eyeState = eyeEngine.getRawState();
  Object.values(eyeState.entities)
    .filter(entity => entity.components.custom?.monster === 'EYE')
    .forEach(entity => {
      entity.components.custom = { ...(entity.components.custom ?? {}), destroyed: true };
    });
  movePlayerTo(eyeState, 'p3', 'room_tower');
  eyeState.activePlayerId = 'p3';
  eyeState.activeActorId = 'p3';
  const beacon = eyeEngine.getLegalActions('p3').find(action => action.type === 'DESTROY_BEACON');
  assert(!!beacon, 'beacon exposed after both eyes are destroyed');
  assert(eyeEngine.dispatch(beacon!).ok, 'beacon destroyed');
  assertEqual(eyeEngine.getRawState().gameOver, true, 'destroying the beacon ends the game');
  assertEqual((eyeEngine.getRawState().winner as string[]).includes('p2'), true, 'heroes win the eye haunt');
});

test('fixture betrayal: monsters are NPC actors with their own turn', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_mummy' });
  assertEqual(engine.getFocusPlayers().join(','), 'p2', 'hero starts');
  assert(engine.dispatch({ type: 'END_TURN', playerId: 'p2' }).ok, 'p2 ends');
  resolvePendingDamage(engine);
  assert(engine.dispatch({ type: 'END_TURN', playerId: 'p3' }).ok, 'p3 ends');
  resolvePendingDamage(engine);
  assert(engine.dispatch({ type: 'END_TURN', playerId: 'p1' }).ok, 'traitor ends');
  resolvePendingDamage(engine);

  const focusActors = engine.getFocusActors();
  assertEqual(focusActors.length, 1, 'one NPC focus');
  assert(focusActors[0].startsWith('npc_'), 'focus is the monster NPC');
  assertEqual(engine.getFocusPlayers().length, 0, 'NPC does not appear as a player');

  const npcId = focusActors[0];
  const legal = engine.getLegalActions(npcId);
  assert(legal.some(action => action.type === 'MOVE_NPC'), 'NPC can move directly');
  assert(legal.some(action => action.type === 'END_NPC_TURN'), 'NPC can end its turn');
  assertEqual(engine.getRawState().npcs?.[npcId]?.controllerId, 'p1', 'traitor controls the monster');

  assert(engine.dispatch({ type: 'END_NPC_TURN', playerId: npcId, actorId: npcId }).ok, 'NPC turn ends');
  assertEqual(engine.getFocusPlayers().join(','), 'p2', 'control returns to the next hero');
  assert(engine.verifyReplay().ok, 'NPC turns replay bit-exactly');
});

test('fixture betrayal: random play through a haunt stays legal and replayable', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 424242, { scenario: 'haunt_mummy' });
  const { applied, errors } = playRandom(engine, 24);
  assert(applied > 5, 'scenario progressed');
  assertEqual(errors.length, 0, `no dispatch errors (${errors.slice(0, 2).join(' | ')})`);
  assert(engine.verifyReplay().ok, `scenario replay mismatch (${engine.verifyReplay().errors.join(' | ')})`);
});
