/* -------------------------------------------------------------------------- */
/* suite:engine — moved verbatim from suite.ts */
/* -------------------------------------------------------------------------- */

import { UniversalGameEngine } from '@rds/kernel/engine';
import { test, assert, assertEqual } from '../testKit';
import { counterModule, scenarioModule, selectionModule, diceModule, npcModule, followUpModule, decisionFollowUpModule, responseFollowUpModule, lockedDecisionModule } from '../suiteHelpers';

/* 2. Generic engine behaviour                                                 */
/* -------------------------------------------------------------------------- */

test('engine: selection actions validate concrete targets', () => {
  const engine = new UniversalGameEngine(selectionModule, 3);
  const action = engine.getLegalActions('p1').find(candidate => candidate.type === 'PICK_NODE');
  assert(!!action?.selection, 'selection spec is exposed');
  const candidates = engine.getSelectionCandidates('p1', action!.selection!);
  assertEqual(candidates.map(candidate => candidate.id).join(','), 'n1,n2', 'candidates come from the graph');

  const rejected = engine.dispatch({ ...action!, targets: ['missing'] });
  assert(!rejected.ok, 'unknown target rejected');
  const empty = engine.dispatch({ ...action!, targets: [] });
  assert(!empty.ok, 'min target count enforced');

  const accepted = engine.dispatch({ ...action!, targets: ['n2'] });
  assert(accepted.ok, `valid target accepted: ${accepted.error}`);
  assertEqual(engine.getRawState().globalVars.picked, 'n2', 'targets reached the reducer');
});

test('engine: custom dice faces (0/1/2) roll through ReduceContext', () => {
  const engine = new UniversalGameEngine(diceModule, 12);
  assert(engine.dispatch({ type: 'ROLL_CUSTOM', playerId: 'p1' }).ok, 'custom roll accepted');
  const state = engine.getRawState();
  const rolls = state.globalVars.rolls as number[];
  assertEqual(rolls.length, 6, 'six dice');
  assert(rolls.every(value => value >= 0 && value <= 2), 'faces are 0/1/2');
  assertEqual(rolls.reduce((sum, value) => sum + value, 0), state.globalVars.total, 'total matches faces');
  assert(engine.verifyReplay().ok, 'custom dice replay exactly');
});

test('engine: NPCs are actors but not players', () => {
  const engine = new UniversalGameEngine(npcModule, 5);
  assertEqual(engine.getFocusActors().join(','), 'npc1', 'NPC is the focus actor');
  assertEqual(engine.getFocusPlayers().length, 0, 'NPC is not a player focus');

  const action = engine.getLegalActions('npc1').find(candidate => candidate.type === 'NPC_ACT');
  assert(!!action, 'NPC has legal actions');
  assert(engine.dispatch(action!).ok, 'NPC action dispatches');
  assertEqual(engine.getRawState().globalVars.npcActions, 1, 'NPC reducer ran');

  const view = engine.getProjectedStateFor('p2');
  assertEqual(view.npcs?.npc1?.name, 'Test Monster', 'NPC is projected');
  assertEqual(view.actorOrder?.join(','), 'p1,npc1', 'visible actors remain in order');
  assert(engine.verifyReplay().ok, 'NPC action replays');
});

test('engine: named scenarios replay through export/load', () => {  const engine = new UniversalGameEngine(scenarioModule, 9, { scenario: 'rich' });
  assertEqual(engine.getScenario(), 'rich', 'scenario recorded');
  assertEqual(engine.getRawState().globalVars.ticks, 40, 'scenario setup applied');

  assert(engine.dispatch({ type: 'TICK', playerId: 'p1' }).ok, 'tick accepted');
  assertEqual(engine.getRawState().globalVars.ticks, 41, 'scenario state advanced');

  const log = engine.exportLog();
  assertEqual(log.scenario, 'rich', 'scenario exported in the log');

  const restored = new UniversalGameEngine(scenarioModule, 1);
  const report = restored.loadLog(log);
  assert(report.ok, `restore failed: ${report.errors.join(' | ')}`);
  assertEqual(restored.getScenario(), 'rich', 'scenario restored');
  assertEqual(restored.getStateHash(), engine.getStateHash(), 'restored hash matches');

  let threw = false;
  try {
    new UniversalGameEngine(scenarioModule, 1, { scenario: 'missing' });
  } catch {
    threw = true;
  }
  assert(threw, 'unknown scenario is rejected');
  assert(engine.verifyReplay().ok, 'scenario replay is bit-exact');
});

test('engine: exportLog hashes the live state without replaying the log', () => {
  const engine = new UniversalGameEngine(counterModule, 5);
  for (let i = 0; i < 5; i++) engine.dispatch({ type: 'TICK', playerId: 'p1' });
  const log = engine.exportLog();
  // 导出日志里的 stateHash 必须就是当前状态的哈希：以前是重放整条 history 再算，
  // 结果一样但要 O(N)，日志越长越慢（issue #208）。
  assertEqual(log.stateHash, engine.getStateHash(), 'exported hash equals the live state hash');
  assertEqual(log.actions.length, 5, 'every action is still exported');
});

test('engine: incompatible log versions are rejected, not migrated', () => {
  const engine = new UniversalGameEngine(counterModule, 5);
  engine.dispatch({ type: 'TICK', playerId: 'p1' });
  const log = engine.exportLog();
  assertEqual(log.schemaVersion, 1, 'schema version written');
  assertEqual(log.engineVersion, 3, 'engine version written');

  const clone = new UniversalGameEngine(counterModule, 5);
  const mismatch = clone.loadLog({ ...log, engineVersion: 999 });
  assert(!mismatch.ok, 'engine mismatch rejected');
  assert(mismatch.errors.some(error => error.includes('migration is not automatic')), 'clear version error');

  const schemaMismatch = clone.loadLog({ ...log, schemaVersion: 999 });
  assert(!schemaMismatch.ok, 'schema mismatch rejected');
  assert(clone.loadLog(log).ok, 'matching versions still replay');
});

test('engine: follow-up chains deeper than eight settle in order', () => {
  const engine = new UniversalGameEngine(followUpModule, 7);
  const action = engine.getLegalActions('p1').find(candidate => candidate.type === 'CHAIN');
  assert(!!action, 'chain action is legal');

  const result = engine.dispatch({ ...action!, payload: { remaining: 12 } });
  assert(result.ok, `deep chain accepted: ${result.error}`);
  const order = engine.getRawState().globalVars.order as string[];
  assertEqual(order.length, 12, 'all twelve links ran');
  assertEqual(order[0], 't12', 'root action ran first');
  assertEqual(order[11], 't1', 'the last follow-up settled last');
  assert(engine.verifyReplay().ok, 'deep chain replays bit-exactly');
});

test('engine: follow-up siblings settle depth-first', () => {
  const engine = new UniversalGameEngine(followUpModule, 7);
  const action = engine.getLegalActions('p1').find(candidate => candidate.type === 'CHAIN');
  assert(!!action, 'chain action is legal');

  const result = engine.dispatch({ ...action!, payload: { mode: 'tree', node: 'A' } });
  assert(result.ok, `tree chain accepted: ${result.error}`);
  assertEqual(
    (engine.getRawState().globalVars.order as string[]).join(','),
    'A,A1,B',
    'A1 settles before its sibling B'
  );
});

test('engine: a runaway follow-up chain is rejected atomically', () => {
  const engine = new UniversalGameEngine(followUpModule, 7, {
    maxFollowUpActions: 5,
    maxFollowUpDepth: 16
  });
  const before = engine.getStateHash();
  const action = engine.getLegalActions('p1').find(candidate => candidate.type === 'CHAIN');
  assert(!!action, 'chain action is legal');

  const result = engine.dispatch({ ...action!, payload: { remaining: 99 } });
  assert(!result.ok, 'over-budget chain is rejected');
  assert((result.error ?? '').includes('follow-up chain'), 'error names the follow-up chain');
  assertEqual(engine.getStateHash(), before, 'no partial state was committed');
  assertEqual(engine.getHistory().length, 0, 'the root action was not logged');
  assertEqual((engine.getRawState().globalVars.order as string[]).length, 0, 'no link ran');
});

test('engine: a follow-up chain that nests too deeply is rejected atomically', () => {
  const engine = new UniversalGameEngine(followUpModule, 7, {
    maxFollowUpActions: 256,
    maxFollowUpDepth: 3
  });
  const before = engine.getStateHash();
  const action = engine.getLegalActions('p1').find(candidate => candidate.type === 'CHAIN');
  assert(!!action, 'chain action is legal');

  const result = engine.dispatch({ ...action!, payload: { remaining: 10 } });
  assert(!result.ok, 'over-deep chain is rejected');
  assert((result.error ?? '').includes('depth limit'), 'error names the depth limit');
  assertEqual(engine.getStateHash(), before, 'no partial state was committed');
});

test('engine: a follow-up chain pauses on a decision window and resumes', () => {
  const engine = new UniversalGameEngine(decisionFollowUpModule, 3);
  const start = engine.getLegalActions('p1').find(candidate => candidate.type === 'START');
  assert(!!start, 'start action is legal');
  const first = engine.dispatch(start!);
  assert(first.ok, `start accepted: ${first.error}`);

  let order = engine.getRawState().globalVars.order as string[];
  assertEqual(order.join(','), 'start,open', 'the follow-up after the choice waits');
  const window = engine.getRawState().pendingDecisions.find(candidate => candidate.status === 'OPEN');
  assert(!!window, 'decision window is open');
  assertEqual(window!.followUpContinuation?.length, 1, 'remaining follow-up is parked on the window');

  const choose = engine.getLegalActions('p1').find(candidate => candidate.type === 'CHOOSE');
  assert(!!choose, 'decision submission is legal');
  const second = engine.dispatch(choose!);
  assert(second.ok, `choice accepted: ${second.error}`);

  order = engine.getRawState().globalVars.order as string[];
  assertEqual(order.join(','), 'start,open,choose,after', 'engine resumes the parked follow-up');
  assertEqual(
    engine.getRawState().pendingDecisions.filter(candidate => candidate.status === 'OPEN').length,
    0,
    'no decision left open'
  );
  assert(engine.verifyReplay().ok, 'suspended chain replays bit-exactly');
});

test('engine: a follow-up chain pauses on an interrupt window and resumes', () => {
  const engine = new UniversalGameEngine(responseFollowUpModule, 3);
  const start = engine.getLegalActions('p1').find(candidate => candidate.type === 'START');
  assert(!!start, 'start action is legal');
  const first = engine.dispatch(start!);
  assert(first.ok, `start accepted: ${first.error}`);

  let order = engine.getRawState().globalVars.order as string[];
  assertEqual(order.join(','), 'start,push', 'the follow-up after the response waits');
  const frame = engine.getRawState().interruptStack[0];
  assert(!!frame, 'interrupt frame is on the stack');
  assertEqual(frame!.followUpContinuation?.length, 1, 'remaining follow-up is parked on the frame');

  const pass = engine.getLegalActions('p1').find(candidate => candidate.type === 'PASS');
  assert(!!pass, 'response is legal');
  const second = engine.dispatch(pass!);
  assert(second.ok, `response accepted: ${second.error}`);

  order = engine.getRawState().globalVars.order as string[];
  assertEqual(order.join(','), 'start,push,after', 'engine resumes the parked follow-up');
  assertEqual(engine.getRawState().interruptStack.length, 0, 'stack is empty');
  assert(engine.verifyReplay().ok, 'response-suspended chain replays bit-exactly');
});

test('engine: non-participants cannot act through an open decision', () => {
  const engine = new UniversalGameEngine(lockedDecisionModule, 1);
  assertEqual(engine.getLegalActions('p1').length, 0, 'non-participant sees no legal actions');
  const result = engine.dispatch({ type: 'SNEAK', playerId: 'p1' });
  assert(!result.ok, 'non-participant action is rejected');
  assert((result.error ?? '').includes('only its participants'), 'rejection explains the open window');
  assertEqual(engine.getRawState().globalVars.sneaked, false, 'state did not change');
});

/* -------------------------------------------------------------------------- */

test('engine: hitting the clock cascade limit is reported, not silent', async () => {
  const { defineGame } = await import('@rds/kernel/module');
  const { emptyState } = await import('../suiteHelpers.ts');
  const { openDecision } = await import('@rds/kernel/decisions');
  const { CLOCK_CASCADE_LIMIT, UniversalGameEngine } = await import('@rds/kernel/engine');

  // 20 个同时到期的窗口：每次循环只解算一个，必然撞上 16 层上限。
  const manyWindows = defineGame({
    meta: {
      id: 'cascade_fixture',
      name: 'Cascade fixture',
      description: '20 due decision windows',
      version: '1.0.0',
      capabilities: {
        simultaneousMoves: true,
        hiddenInformation: false,
        interruptStack: false,
        dynamicRules: false,
        topology: 'none'
      }
    },
    hooks: [],
    setup: seed => {
      let state = emptyState('cascade_fixture', seed);
      for (let i = 0; i < 20; i++) {
        const opened = openDecision(
          state,
          {
            kind: 'VOTE',
            title: `window ${i}`,
            participants: ['p1'],
            secret: false,
            policy: { type: 'ALL_COMMITTED' },
            participantDeadlines: { p1: 1 }
          },
          `w${i}`
        );
        state = opened.state;
      }
      return { ...state, phase: 'WAIT' };
    },
    legalActions: () => [],
    reduce: state => state,
    outcome: () => ({ gameOver: false, winner: null })
  });

  const engine = new UniversalGameEngine(manyWindows, 1);
  const result = engine.dispatch({ type: '__TICK__', playerId: 'SYSTEM', payload: { ticks: 1 } });
  assert(result.ok, `tick accepted: ${result.error ?? ''}`);
  const limitEvent = result.events.find(event => event.type === 'CLOCK_CASCADE_LIMIT');
  assert(!!limitEvent, 'the cascade limit emits a visible event');
  assert(String(limitEvent?.title).includes(String(CLOCK_CASCADE_LIMIT)), 'the message names the limit');
  assert(
    engine.getRawState().pendingDecisions.some(window => window.status === 'OPEN'),
    'windows beyond the limit stay open for the next tick'
  );
});


test('seating: declared seat ranges match what every fixture actually deals', async () => {
  const { GAME_REGISTRY } = await import('@rds/games/registry');
  const { seatRangeOf, seatsAccepted } = await import('@rds/kernel/seating');

  for (const [id, module] of Object.entries(GAME_REGISTRY)) {
    const range = seatRangeOf(module);
    const dealt = module.setup(1).playerOrder.length;
    assertEqual(range.default ?? range.min, dealt, `${id}: declared default seats match setup()`);
    assert(range.min <= dealt && dealt <= range.max, `${id}: dealt seats stay inside [min,max]`);

    for (const [scenarioId, scenario] of Object.entries(module.scenarios ?? {})) {
      const scenarioRange = seatRangeOf(module, scenarioId);
      const scenarioDealt = scenario.setup(1).playerOrder.length;
      assertEqual(
        scenarioRange.default ?? scenarioRange.min,
        scenarioDealt,
        `${id}/${scenarioId}: scenario seats match setup()`
      );
      assert(seatsAccepted(module, scenarioId, scenarioDealt).ok, `${id}/${scenarioId}: its own seat count is accepted`);
    }
  }

  // 可变化人数的玩法：区间内接受、区间外拒绝；固定变体不受影响。
  const poker = GAME_REGISTRY.poker;
  for (const n of [2, 4, 6, 10]) assert(seatsAccepted(poker, undefined, n).ok, `poker accepts ${n}`);
  assert(!seatsAccepted(poker, undefined, 1).ok && !seatsAccepted(poker, undefined, 11).ok, 'poker rejects outside 2..10');
  assert(seatsAccepted(poker, 'short_stack', 4).ok, 'short_stack accepts its 4 seats');
  assert(!seatsAccepted(poker, 'short_stack', 6).ok, 'short_stack rejects 6 seats');
  assert(!seatsAccepted(GAME_REGISTRY.catan, undefined, 4).ok, 'catan is fixed at 3');

  // 没声明 seatRange 的存量模组走遗留探测。
  const legacy = { ...GAME_REGISTRY.catan, meta: { ...GAME_REGISTRY.catan.meta, seatRange: undefined } };
  assertEqual(seatRangeOf(legacy as never).default, 3, 'an undeclared module falls back to probing setup()');
});


test('clock: needsClock is decided by the kernel, not re-derived by the driver', async () => {
  const { UniversalGameEngine, needsClock } = await import('@rds/kernel/engine');
  const { deadlineModule } = await import('../suiteHelpers.ts');

  const engine = new UniversalGameEngine(deadlineModule, 11);
  assertEqual(needsClock(engine.getRawState()), false, 'nothing is due one tick away at clock 0');

  assert(engine.dispatch({ type: '__TICK__', playerId: 'SYSTEM', payload: { ticks: 1 } }).ok, 'tick accepted');
  assertEqual(engine.getRawState().clock, 1, 'clock advanced');
  // 参与者 p1 的截止时间是 2：再推一拍就会到期，驱动方应当继续走时钟。
  assertEqual(needsClock(engine.getRawState()), true, 'a participant deadline one tick away keeps the clock needed');

  assert(engine.dispatch({ type: '__TICK__', playerId: 'SYSTEM', payload: { ticks: 1 } }).ok, 'second tick accepted');
  const window = engine.getRawState().pendingDecisions[0];
  assertEqual(window.submissions['p1'], 'PASS', 'the player whose deadline passed was auto-passed');
  assertEqual(window.submissions['p2'], undefined, 'the other player is still on the clock');
});

