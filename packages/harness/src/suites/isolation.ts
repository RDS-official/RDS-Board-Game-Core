/* -------------------------------------------------------------------------- */
/* suite:isolation — cross-game isolation (Step 3)                            */
/* -------------------------------------------------------------------------- */

import { GAME_REGISTRY } from '@rds/games/registry';
import { UniversalSession } from '@rds/app/session';
import { UniversalGameEngine } from '@rds/kernel/engine';
import { test, assert, assertEqual } from '../testKit';

/** Player counts each fixture is happy with; sessions must all coexist. */
const SEATS: Record<string, number> = {
  catan: 3,
  sanguosha: 5,
  splendor: 3,
  betrayal: 5,
  dune_mahjong: 4,
  poker: 4
};

test('isolation: all registry games coexist without crosstalk', () => {
  const sessions = Object.entries(GAME_REGISTRY).map(([id, mod]) => ({
    id,
    session: new UniversalSession(mod, SEATS[id] ?? 4)
  }));
  assertEqual(sessions.length, 6, 'six games are registered');

  // Drive each session one step where an action exists, so lazy module state
  // (card dictionaries, RNG streams, presentation hint tables) is touched.
  for (const { id, session } of sessions) {
    const action = session.getSnapshot().actions[0];
    if (action) assert(session.perform(action.id).ok, `action accepted in ${id}`);
  }

  // After all games ran interleaved, every snapshot still reports its own
  // identity and nothing foreign leaked in.
  const serialized = new Map(sessions.map(({ id, session }) => [id, JSON.stringify(session.getSnapshot())]));
  for (const { id, session } of sessions) {
    const snap = session.getSnapshot();
    assertEqual(snap.gameId, id, `gameId intact after interleaved play: ${id}`);
    const blob = serialized.get(id) ?? '';
    for (const other of sessions) {
      if (other.id === id) continue;
      assert(!blob.includes(`"gameId":"${other.id}"`), `${id} snapshot does not mention ${other.id}`);
    }
  }

  // Betrayal's private vocabulary must not surface in other games' snapshots.
  for (const { id, session } of sessions) {
    if (id === 'betrayal') continue;
    const blob = JSON.stringify(session.getSnapshot());
    for (const word of ['洋馆总览', '预兆', 'zone_room_', '地下室']) {
      assert(!blob.includes(word), `${id} snapshot free of betrayal vocabulary: ${word}`);
    }
  }

  for (const { session } of sessions) session.dispose();
});

test('isolation: same seed reproduces the same state regardless of creation order', () => {
  const runBetrayal = () => {
    const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 1234, { scenario: 'exploration', seats: 5 });
    const state = JSON.stringify(engine.getRawState());
    return state;
  };

  // Baseline: betrayal alone.
  const alone = runBetrayal();

  // Interleaved: create another game first, run it, then betrayal — a
  // shared/module-level mutable seed or card dictionary would drift here.
  const poker = new UniversalGameEngine(GAME_REGISTRY.poker, 99, { seats: 4 });
  const pokerAction = poker.getLegalActions('p1')[0];
  if (pokerAction) poker.dispatch(pokerAction);
  const interleaved = runBetrayal();

  assertEqual(alone.length, interleaved.length, 'betrayal state size stable across creation order');
  assertEqual(alone, interleaved, 'betrayal state identical across creation order');
});

test('isolation: optional presenter ports stay empty for games that do not opt in', () => {
  for (const [id, mod] of Object.entries(GAME_REGISTRY)) {
    if (id === 'betrayal') continue;
    const session = new UniversalSession(mod, SEATS[id] ?? 4);
    assertEqual(session.castMembers?.().length ?? 0, 0, `castMembers empty for ${id}`);
    const anyNode = session.playerNodeId?.('p1');
    assert(anyNode === undefined || anyNode === null, `playerNodeId not leaked into ${id}`);
    const snap = session.getSnapshot();
    assert(!snap.spatial?.title, `no map title outside betrayal: ${id}`);
    session.dispose();
  }
});
