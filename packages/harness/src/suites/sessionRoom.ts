/* -------------------------------------------------------------------------- */
/* suite:sessionRoom — moved verbatim from suite.ts */
/* -------------------------------------------------------------------------- */

import { MapGraphManager } from '@rds/kernel/graph'
import { UniversalGameEngine } from '@rds/kernel/engine'
import { canonicalize } from '@rds/kernel/serialize'
import { GAME_MODULES, GAME_REGISTRY } from '@rds/games/registry'
import { RandomPolicy, runPolicies } from '../policy'
import { GameRoom } from '@rds/net/room'
import { UniversalSession } from '@rds/app/session'
import { resolvePendingDamage } from '../suiteHelpers';
import { test, assert, assertEqual } from '../testKit';

test('room: checkpoints restore through replay', () => {
  const room = new GameRoom(GAME_REGISTRY.catan, 1);
  room.join('p1');

  for (let i = 0; i < 2; i++) {
    const focus = room.engine.getFocusPlayers()[0];
    const legal = room.engine.getLegalActions(focus);
    assert(legal.length > 0, 'legal action available');
    const action = legal.find(candidate => candidate.type !== 'PASS') ?? legal[0];
    assert(room.submit(action).ok, `action ${action.type} accepted`);
  }

  const checkpoint = room.exportState();
  const restored = new GameRoom(GAME_REGISTRY.catan, 999);
  const report = restored.restore(checkpoint);

  assert(report.ok, `restore failed: ${report.errors.join(' | ')}`);
  assertEqual(restored.engine.getStateHash(), room.engine.getStateHash(), 'restored hash matches original');
  assertEqual(restored.getRevision(), checkpoint.revision, 'revision restored');

  const delta = restored.delta('p1');
  assert(delta.full, 'first delta after restore is a full snapshot');
  assertEqual(restored.getRevision(), checkpoint.revision, 'delta does not bump revision');
});

test('kernel: invalid PLACE_ROOM rotation is rejected before reducer', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 2024);
  engine.getRawState().globalVars.pendingRoomPlacement = {
    playerId: 'p1',
    rotations: [0]
  };
  const result = engine.dispatch({
    type: 'PLACE_ROOM',
    playerId: 'p1',
    payload: { rotation: '1' }
  });
  assert(!result.ok, 'illegal rotation rejected');
  assert(String(result.error).includes('not legal'), 'explains the illegal rotation');
});

test('kernel: NPC actions require the controlling viewer', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_mummy' });
  for (const playerId of ['p2', 'p3', 'p1']) {
    assert(engine.dispatch({ type: 'END_TURN', playerId }).ok, `${playerId} ends turn`);
    resolvePendingDamage(engine);
  }
  const npc = engine.getFocusActors()[0];
  assert(!!npc, 'NPC has focus');
  engine.setViewer('p2');
  const denied = engine.dispatch({ type: 'END_NPC_TURN', playerId: npc, actorId: npc });
  assert(!denied.ok, 'non-controller denied');
  assert(String(denied.error).includes('cannot control'), 'permission error is explicit');
  engine.setViewer('p1');
  assert(engine.dispatch({ type: 'END_NPC_TURN', playerId: npc, actorId: npc }).ok, 'controller allowed');
});

test('kernel: declared topology must match the actual graph', () => {
  const errors = MapGraphManager.validateDeclaration(
    { kind: 'hex', adjacency: 'both', geometry: 'hex' },
    { kind: 'hex', adjacency: 'both', geometry: 'grid' }
  );
  assert(errors.some(error => error.includes('geometry')), 'geometry mismatch is reported');
  assertEqual(
    MapGraphManager.validateDeclaration(
      { kind: 'hex', adjacency: 'both', geometry: 'hex' },
      { kind: 'hex', adjacency: 'both', geometry: 'hex' }
    ).length,
    0,
    'matching declaration passes'
  );
});

test('presenter: node click without a targeting action is inspection only', () => {
  const session = new UniversalSession(GAME_REGISTRY.catan, 5);
  const node = Object.values(session.getSnapshot().board.mapGraph.nodes)[0];
  const before = session.getSnapshot().log.cursor;
  const result = session.pickTarget({ kind: 'node', id: node.id });
  assert(result.handled, 'node click handled');
  assertEqual(session.getSnapshot().log.cursor, before, 'node click did not dispatch');
  session.dispose();
});

test('projection: selection candidates use the viewer projection', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.sanguosha, 9);
  engine.setViewer('p1');
  const own = engine.getSelectionCandidates('p1', { source: 'hand', min: 1, max: 1 });
  assert(own.length > 0, 'own hand candidates are visible');
  engine.setViewer('p2');
  const other = engine.getSelectionCandidates('p1', { source: 'hand', min: 1, max: 1 });
  assertEqual(other.length, 0, 'opponent hand is not exposed');
  const hidden = Object.keys(engine.getRawState().entities).filter(
    id => !engine.getProjectedState().entities[id]
  );
  const candidates = engine.getSelectionCandidates('p1', { source: 'entity', min: 1, max: 1 });
  assert(!candidates.some(candidate => hidden.includes(candidate.id)), 'hidden entities are excluded');
});

test('presenter: switching viewer clears stale board targeting', () => {
  const session = new UniversalSession(GAME_REGISTRY.catan, 5);
  const group = session.getSnapshot().actions.find(action => action.highlightIds);
  assert(!!group, 'has board targeting action');
  assert(session.perform(group!.id).ok, 'targeting armed');
  const before = session.getSnapshot().log.cursor;
  session.setViewer('p2');
  const node = Object.values(session.getSnapshot().board.mapGraph.nodes)[0];
  const picked = session.pickTarget({ kind: 'node', id: node.id });
  assert(picked.handled, 'node click handled');
  assertEqual(session.getSnapshot().log.cursor, before, 'stale targeting did not dispatch');
  session.dispose();
});

test('projection: fixtures do not leak hidden ids after random play', () => {
  for (const module of GAME_MODULES) {
    const engine = new UniversalGameEngine(module, 31);
    const policies = Object.fromEntries(
      engine.getRawState().playerOrder.map((pid, index) => [pid, new RandomPolicy(31 + index, `leak-${pid}`)])
    );
    runPolicies(engine, policies, 30);
    const god = engine.getProjectedState();
    const hidden = [
      ...Object.keys(engine.getRawState().entities).filter(id => !god.entities[id]),
      ...Object.keys(engine.getRawState().mapGraph.nodes).filter(id => !god.mapGraph.nodes[id])
    ];
    for (const viewer of engine.getRawState().playerOrder) {
      const text = canonicalize(engine.getProjectedStateFor(viewer));
      const leaked = hidden.filter(id => text.includes(id));
      assertEqual(leaked.length, 0, `${module.meta.id}/${viewer} leaked ${leaked.slice(0, 3).join(',')}`);
    }
  }
});


/* -------------------------------------------------------------------------- */
