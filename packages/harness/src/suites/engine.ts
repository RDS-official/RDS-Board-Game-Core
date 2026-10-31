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
