/* -------------------------------------------------------------------------- */
/* suite:room — moved verbatim from suite.ts */
/* -------------------------------------------------------------------------- */

import { UniversalGameEngine } from '@rds/kernel/engine';
import { CognitiveObserver } from '@rds/kernel/observer';
import { canonicalize } from '@rds/kernel/serialize';
import { Action } from '@rds/kernel/types';
import { GAME_REGISTRY } from '@rds/games/registry';
import { GameRoom } from '@rds/net/room';
import { RoomHttpAdapter } from '@rds/net/http';
import { RoomPresenter } from '@rds/net/roomPresenter';
import { test, assert, assertEqual } from '../testKit';

test('room: presenter exposes UiActions and dispatches through the server room', () => {
  const room = new GameRoom(GAME_REGISTRY.sanguosha, 57);
  const presenter = new RoomPresenter(room, 'p1');
  const first = presenter.join();
  assert(first.actions.length > 0, 'room presenter exposes UiActions');
  assert(first.actions[0].label.length > 0, 'UiAction has a label');

  const result = presenter.perform(first.actions[0].id);
  assert(result.ok, `room presenter dispatch failed: ${result.error}`);
  const refreshed = presenter.refresh();
  assert(refreshed.revision > first.revision, 'room revision advances');
});

test('room: HTTP-shaped transport handles join, actions and actor mismatch', () => {
  const room = new GameRoom(GAME_REGISTRY.sanguosha, 55, (viewer, token) => viewer === 'p1' && token === 'secret');
  const http = new RoomHttpAdapter(room);

  assertEqual(http.handle({ method: 'POST', path: '/join', viewer: 'p2', token: 'x' }).status, 401, 'unauthorized join');
  assertEqual(http.handle({ method: 'POST', path: '/join', viewer: 'p1', token: 'secret' }).status, 200, 'authorized join');
  assertEqual(http.handle({ method: 'GET', path: '/actions', viewer: 'p1' }).status, 200, 'actions endpoint');

  const action = (http.handle({ method: 'GET', path: '/actions', viewer: 'p1' }).body as Action[])[0];
  assert(!!action, 'has a projected action');
  const mismatch = http.handle({ method: 'POST', path: '/submit', viewer: 'p2', action });
  assertEqual(mismatch.status, 403, 'viewer cannot submit another actor action');
  const accepted = http.handle({ method: 'POST', path: '/submit', viewer: 'p1', action });
  assertEqual(accepted.status, 200, 'authorized actor submits');
});

test('room: joins are authorized when an authorizer is supplied', () => {
  const room = new GameRoom(GAME_REGISTRY.sanguosha, 55, (viewer, token) => viewer === 'p1' && token === 'secret');
  let rejected = false;
  try {
    room.join('p2', 'wrong');
  } catch {
    rejected = true;
  }
  assert(rejected, 'unauthorized join is rejected');
  assert(!!room.join('p1', 'secret').state, 'authorized join returns a projection');
  assert(room.actions('p1').length > 0, 'room exposes projected legal actions');
});

test('room: projection patches round-trip exactly', () => {
  const room = new GameRoom(GAME_REGISTRY.sanguosha, 55);
  const joined = room.join('p2');
  assert(joined.full && !!joined.state, 'join returns a full snapshot');

  const strike = room.engine.getLegalActions('p1').find(a => a.type === 'PLAY_STRIKE');
  assert(!!strike, 'p1 can strike');
  const submitted = room.submit(strike!);
  assert(submitted.ok, `room submit failed: ${submitted.error}`);
  assertEqual(room.getRevision(), 1, 'revision increments once per accepted action');

  const delta = room.delta('p2');
  assert(!delta.full && delta.patches.length > 0, 'delta contains patches');

  const rebuilt = room.applyClientDelta(joined.state, delta);
  const latest = room.snapshot('p2').state;
  assertEqual(canonicalize(rebuilt), canonicalize(latest), 'patched client state equals server projection');
});

test('room: hidden information never appears in patches', () => {
  const room = new GameRoom(GAME_REGISTRY.sanguosha, 56);
  const joined = room.join('p2');

  const strike = room.engine.getLegalActions('p1').find(a => a.type === 'PLAY_STRIKE');
  assert(!!strike, 'p1 can strike');
  room.submit(strike!);

  const delta = room.delta('p2');
  const patchText = JSON.stringify(delta.patches);

  const raw = room.engine.getRawState();
  const hiddenTitles = Object.values(raw.entities)
    .filter(entity => !CognitiveObserver.isVisibleTo(entity.visibility, 'p2', entity.ownerId))
    .map(entity => entity.components.cardFace?.title)
    .filter((title): title is string => !!title);

  assert(hiddenTitles.length > 0, 'fixture has hidden cards');
  for (const title of hiddenTitles) {
    assert(!patchText.includes(title), `patch leaked hidden card title: ${title}`);
  }

  const rebuilt = room.applyClientDelta(joined.state, delta);
  assert(!!rebuilt, 'patch applies cleanly without hidden data');
});

test('room: an injected engine is the single source of truth (A2)', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.catan, 3);
  const room = new GameRoom(GAME_REGISTRY.catan, 3, undefined, undefined, engine);
  const seen: number[] = [];
  room.onChange(() => seen.push(room.getRevision()));

  assertEqual(room.getRevision(), 0, 'fresh room starts at revision 0');

  const focus = engine.getFocusPlayers()[0];
  const legal = engine.getLegalActions(focus);
  const action = legal.find(candidate => candidate.type !== 'PASS') ?? legal[0];
  assert(!!action && engine.dispatch(action).ok, 'host-side dispatch accepted');

  assertEqual(room.getRevision(), 1, 'direct engine dispatch advances the room revision');
  assertEqual(seen.length, 1, 'room emits one change per state transition');
  assertEqual(room.snapshot('p1').revision, 1, 'viewers see the shared revision');

  engine.setViewer('p2');
  assertEqual(room.getRevision(), 1, 'a viewer-only notification does not inflate the revision');
  assertEqual(seen.length, 1, 'no change event for a viewer-only notification');
});

test('room: illegal actions do not advance the revision', () => {
  const room = new GameRoom(GAME_REGISTRY.catan, 3);
  room.join('p1');

  const before = room.getRevision();
  const illegal = room.submit({ type: 'ROLL_DICE', playerId: 'p2' });
  assert(!illegal.ok, 'out-of-turn action rejected');
  assertEqual(room.getRevision(), before, 'revision unchanged on rejection');
});

test('room: secret decision submissions are collapsed in deltas', () => {
  const room = new GameRoom(GAME_REGISTRY.dune_mahjong, 9);
  room.join('p2');

  room.submit({ type: 'OPEN_BATTLE_WINDOW', playerId: 'p1' });
  const commit = room.engine.getLegalActions('p1').find(a => a.type === 'COMMIT_BATTLE_DIAL');
  assert(!!commit, 'p1 can commit');
  room.submit(commit!);

  const delta = room.delta('p2');
  const patchText = JSON.stringify(delta.patches);

  const projected = room.engine.getProjectedStateFor('p2');
  const window = projected.pendingDecisions.find(w => w.status === 'OPEN');
  assert(!!window, 'window is still open');
  assertEqual(window!.submissions.p1, 'COMMITTED', 'projection collapses the submission');
  assert(patchText.includes('COMMITTED'), 'p2 is told a submission exists');

  const raw = room.engine.getRawState();
  const rawWindow = raw.pendingDecisions.find(w => w.status === 'OPEN');
  const rawSubmission = rawWindow?.submissions.p1;
  assert(!!rawSubmission && rawSubmission !== 'PASS' && rawSubmission !== 'COMMITTED', 'server keeps the real payload');
  assert(
    !patchText.includes(JSON.stringify(rawSubmission)),
    'the raw submission object must never reach the client patch'
  );
});

test('net: centre-mode sessions never mint host-only secrets', async () => {
  const { NetSession } = await import('@rds/app/netSession');
  const { GAME_REGISTRY } = await import('@rds/games/registry');
  const base = { hub: 'http://127.0.0.1:9', roomId: 'r_net', token: 't', playerId: 'p1' as const };
  // 中心模式客户端从不建权威引擎：seed / aliasSecret 都是房主专属，构造时不该生成。
  const guest = new NetSession(GAME_REGISTRY.poker, { ...base, role: 'guest', authority: 'server' } as never);
  assertEqual((guest as unknown as { hostSeed?: number }).hostSeed, undefined, 'centre-mode guest has no host seed');
  assertEqual((guest as unknown as { aliasSecret?: string }).aliasSecret, undefined, 'centre-mode guest has no alias secret');
  guest.dispose();
});


test('net: action cooldowns are shared by solo and networked sessions', async () => {
  const { applyActionCooldowns } = await import('@rds/app/actionCooldown');
  const seen = new Map<string, number>();
  type Probe = { ui: { actionType?: string; cooldownMs?: number } };
  const view: Probe[] = [{ ui: { actionType: 'START_HAND' } }, { ui: { actionType: 'FOLD' } }];
  const cooldowns = { START_HAND: 20_000 };

  applyActionCooldowns(view, cooldowns, seen, 1_000);
  assertEqual(view[0].ui.cooldownMs, 20_000, 'the declared cooldown lands on the action');
  assertEqual(view[1].ui.cooldownMs, undefined, 'actions without a declaration stay free');

  applyActionCooldowns(view, cooldowns, seen, 11_000);
  assertEqual(view[0].ui.cooldownMs, 10_000, 'the cooldown counts down with the clock');

  applyActionCooldowns(view, cooldowns, seen, 30_000);
  assertEqual(view[0].ui.cooldownMs, undefined, 'an expired cooldown is removed, not left at 0');

  // 动作从视图里消失后，下一次出现要重新计时，而不是沿用旧时间戳。
  const onlyFold: Probe[] = [{ ui: { actionType: 'FOLD' } }];
  applyActionCooldowns(onlyFold, cooldowns, seen, 40_000);
  applyActionCooldowns(view, cooldowns, seen, 50_000);
  assertEqual(view[0].ui.cooldownMs, 20_000, 'a returning action restarts its cooldown');
});


test('net: submit takes the viewer explicitly so concurrent requests cannot swap identity', async () => {
  const { GameRoom } = await import('@rds/net/room');
  const { counterModule } = await import('../suiteHelpers.ts');
  const room = new GameRoom(counterModule, 7);
  // 房间上残留一个旧 viewer，不能影响显式传入的身份。
  room.setCurrentViewer('p2');
  const asP1 = room.submit({ type: 'TICK', playerId: 'p1' }, 'p1');
  assertEqual(asP1.ok, true, 'the explicitly passed viewer is accepted');
  const stolen = room.submit({ type: 'TICK', playerId: 'p1' }, 'p2');
  assertEqual(stolen.ok, false, 'another viewer cannot act as p1');
  room.setCurrentViewer(undefined);
  room.dispose();
});

