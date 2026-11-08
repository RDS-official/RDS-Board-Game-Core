/* -------------------------------------------------------------------------- */
/* suite:sessionRoom — moved verbatim from suite.ts */
/* -------------------------------------------------------------------------- */

import { MapGraphManager } from '@rds/kernel/graph'
import { UniversalGameEngine } from '@rds/kernel/engine'
import { canonicalize } from '@rds/kernel/serialize'
import { GAME_MODULES, GAME_REGISTRY } from '@rds/games/registry'
import { RandomPolicy, runPolicies } from '../policy'
import { GameRoom } from '@rds/net/room'
import { UniversalSession, buildActionsView, buildSeatViews, resolveBoundAction } from '@rds/app/session'
import type { BoundAction } from '@rds/app/session'
import type { Action } from '@rds/kernel/types'
import type { UiAction } from '@rds/app/contracts'
import { NetSession } from '@rds/app/netSession'
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

test('presenter: a collapsed card action resolves to the chosen target', () => {
  // 一张【杀】在合法动作里是「每个目标一条」。手牌只显示一张，UI 把它塌缩成
  // 一个按钮（targetVariants）。玩家在轮盘里选谁，就必须换回谁的那条具体动作：
  // 曾经联机版把 `targets` 贴在「第一个目标」那条动作上，于是既改了 canonical
  // 绑定又没换目标，权威一律判非法 —— 症状是「出杀永远被服务器拒绝」。
  const toP2: Action = { type: 'PLAY_CARD', playerId: 'p1', entityId: 'card_sha', targetPlayerId: 'p2' };
  const toP3: Action = { type: 'PLAY_CARD', playerId: 'p1', entityId: 'card_sha', targetPlayerId: 'p3' };
  const bound: BoundAction = {
    ui: { id: 'a0' } as UiAction,
    action: toP2,
    targetVariants: new Map([
      ['p2', toP2],
      ['p3', toP3]
    ])
  };

  const picked = resolveBoundAction(bound, undefined, ['p3']);
  assertEqual(picked.action?.targetPlayerId, 'p3', 'the chosen target replaces the collapsed first target');
  assertEqual(picked.action?.targets, undefined, 'no synthetic targets array is attached');
  assertEqual(canonicalize(picked.action), canonicalize(toP3), 'dispatches exactly a legal action');

  const unknown = resolveBoundAction(bound, undefined, ['p9']);
  assert(!!unknown.error, 'a target outside the collapsed set is refused locally');
  assertEqual(unknown.action, undefined, 'nothing is dispatched for an invalid pick');

  // 没有塌缩的动作照旧直接派发，payload 合并不能丢。
  const plain: BoundAction = { ui: { id: 'a1' } as UiAction, action: { type: 'END_TURN', playerId: 'p1' } };
  const merged = resolveBoundAction(plain, { note: 'x' });
  assertEqual(merged.action?.type, 'END_TURN', 'plain actions still dispatch');
  assertEqual(merged.action?.payload?.note, 'x', 'payload is merged in');
});

test('projection: selection candidates use the viewer projection', () => {  const engine = new UniversalGameEngine(GAME_REGISTRY.sanguosha, 9);
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

test('presenter: a net seat snapshot carries the same hand as a local seat', () => {
  // 回归：NetSession.rebuild 曾经只投影 actions，hand / commands / prompt 永远是
  // undefined，于是联机房里手牌区 data-enabled=0 被隐藏（手机上尤其明显）。
  const engine = new UniversalGameEngine(GAME_REGISTRY.poker, 777);
  const seating = engine.getRawState().globalVars.seating as
    | { started: boolean; aiSeats: string[] }
    | undefined;
  if (seating && !seating.started) {
    const aiSeats = new Set(seating.aiSeats);
    for (const pid of engine.getRawState().playerOrder) {
      if (aiSeats.has(pid)) continue;
      engine.dispatch({ type: 'TAKE_SEAT', playerId: pid });
      engine.dispatch({ type: 'READY_UP', playerId: pid });
    }
  }
  // 全员就绪只让 START_HAND 合法，真正发牌要再走一步。
  const starter = engine.getActiveActorId() ?? engine.getRawState().playerOrder[0];
  const dealt = engine.dispatch({ type: 'START_HAND', playerId: starter });
  assert(dealt.ok, `START_HAND accepted: ${dealt.error ?? ''}`);
  assertEqual(
    engine.getRawState().zones.zone_hand_p1.orderedEntities.length,
    2,
    'the seat was dealt two hole cards'
  );

  const projected = engine.getProjectedStateFor('p1');
  const legal = engine.getLegalActions('p1');
  const bound = buildActionsView(projected, legal, (actorId, spec) =>
    engine.getSelectionCandidates(actorId, spec)
  );
  const seat = buildSeatViews(
    projected,
    bound,
    'p1',
    ['p1'],
    projected.activeActorId,
    projected.activePlayerId
  );
  assertEqual(seat.hand.length, 2, 'own hole cards are visible in the seat view');

  // 同一份投影走联机的 rebuild：快照里必须带手牌与指令轨。
  const net = new NetSession(GAME_REGISTRY.poker, {
    hub: 'ws://127.0.0.1:1/ws',
    roomId: 'room_test',
    token: 'token_test',
    role: 'host',
    authority: 'server',
    playerId: 'p1'
  });
  (net as unknown as { applyUpdate(update: unknown): void }).applyUpdate({
    full: true,
    viewer: 'p1',
    revision: 1,
    state: projected
  });
  const snapshot = net.getSnapshot();
  assertEqual(snapshot.hand?.length ?? 0, 2, 'net snapshot carries the physical hand');
  assert(
    (snapshot.commands?.length ?? 0) > 0,
    'net snapshot carries the command rail'
  );
  assertEqual(
    (snapshot.hand ?? []).map(card => card.title).join('|'),
    seat.hand.map(card => card.title).join('|'),
    'net and local seat views agree'
  );
  net.dispose();
});
