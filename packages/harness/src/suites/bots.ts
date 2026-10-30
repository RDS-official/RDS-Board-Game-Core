/* -------------------------------------------------------------------------- */
/* suite:bots — moved verbatim from suite.ts */
/* -------------------------------------------------------------------------- */

import { UniversalGameEngine } from '@rds/kernel/engine';
import { GAME_MODULES, GAME_REGISTRY } from '@rds/games/registry';
import { RandomPolicy, runPolicies } from '../policy';
import { test, assert, assertEqual } from '../testKit';

test('bots: random policies play every fixture without kernel errors', () => {
  for (const module of GAME_MODULES) {
    const engine = new UniversalGameEngine(module, 2025);
    const order = module.setup(1).playerOrder;
    const policies = Object.fromEntries(
      order.map((pid, index) => [pid, new RandomPolicy(100 + index, `bot-${pid}`)])
    );

    const report = runPolicies(engine, policies, 25);
    assert(report.steps > 0, `${module.meta.id}: bots progressed`);
    assertEqual(report.errors.length, 0, `${module.meta.id}: bot errors (${report.errors.slice(0, 2).join(' | ')})`);

    const replay = engine.verifyReplay();
    assert(replay.ok, `${module.meta.id}: bot game replayable`);
  }
});

test('bots: identical seeds produce identical games', () => {
  const play = (seed: number) => {
    const engine = new UniversalGameEngine(GAME_REGISTRY.sanguosha, seed);
    const order = engine.getRawState().playerOrder;
    const policies = Object.fromEntries(
      order.map((pid, index) => [pid, new RandomPolicy(seed + index, `bot-${pid}`)])
    );
    runPolicies(engine, policies, 18);
    return engine.getStateHash();
  };

  assertEqual(play(77), play(77), 'same seeds replay identically');
  assert(play(77) !== play(78), 'different seeds diverge');
});
