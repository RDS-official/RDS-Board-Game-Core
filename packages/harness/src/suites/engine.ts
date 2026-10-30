/* -------------------------------------------------------------------------- */
/* suite:engine — moved verbatim from suite.ts */
/* -------------------------------------------------------------------------- */

import { UniversalGameEngine } from '@rds/kernel/engine';
import { test, assert, assertEqual } from '../testKit';
import { counterModule, scenarioModule, selectionModule, diceModule, npcModule } from '../suiteHelpers';

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

/* -------------------------------------------------------------------------- */
