/* -------------------------------------------------------------------------- */
/* suite:kernelRollWindow — moved verbatim from suite.ts */
/* -------------------------------------------------------------------------- */

import { UniversalGameEngine } from '@rds/kernel/engine';
import { checkInvariants } from '@rds/kernel/invariants';
import { RollWindowManager } from '@rds/kernel/rollWindow';
import { GAME_REGISTRY } from '@rds/games/registry';
import { test, assert, assertEqual } from '../testKit';

test('kernel: roll window splits a check into declare, roll and react phases', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'trade_ready' });
  const state = engine.getRawState();

  const opened = RollWindowManager.open(state, {
    id: 'rw_unit',
    label: '单元检定',
    actorId: 'p1',
    phase: 'DECLARE',
    declares: [{ actorId: 'p1', options: ['feather'], picked: [] }],
    reacts: [{ actorId: 'p1', options: ['stone', 'foot'], picked: [] }],
    payload: { kind: 'UNIT' }
  });
  state.rollWindows = opened.rollWindows;

  const window = RollWindowManager.current(state);
  assert(!!window, 'the window is current');
  assertEqual(window!.phase, 'DECLARE', 'starts in the declare phase');
  assertEqual(RollWindowManager.optionsFor(window!, 'p1').join(','), 'feather', 'declare options are offered');

  // A phase-inappropriate option is rejected.
  assert(!RollWindowManager.pick(state, 'p1', 'stone').ok, 'react options are not offered before the roll');

  // Declaring a modifier is recorded, and cannot be repeated.
  const declared = RollWindowManager.pick(state, 'p1', 'feather');
  assert(declared.ok, 'declaring a modifier is accepted');
  state.rollWindows = declared.state.rollWindows;
  assert(!RollWindowManager.pick(state, 'p1', 'feather').ok, 'the same modifier cannot be declared twice');
  assertEqual(RollWindowManager.optionsFor(RollWindowManager.current(state)!, 'p1').length, 0, 'declare list drained');

  // Rolling stores the result and moves to REACT.
  const rolled = RollWindowManager.record(state, { dice: [1, 2], total: 3, threshold: 6, success: false });
  assert(rolled.ok, 'recording the dice is accepted');
  state.rollWindows = rolled.state.rollWindows;
  assertEqual(RollWindowManager.current(state)!.phase, 'REACT', 'advances to the react phase');
  assertEqual(RollWindowManager.current(state)!.result!.total, 3, 'the result is stored');
  assert(!RollWindowManager.record(state, { dice: [1], total: 1 }).ok, 'cannot roll twice');

  // Reacting amends the result in place and stays in REACT for stacking.
  const reacted = RollWindowManager.pick(state, 'p1', 'stone');
  assert(reacted.ok, 'reacting is accepted');
  state.rollWindows = reacted.state.rollWindows;
  const amended = RollWindowManager.amend(state, { dice: [1, 2], total: 4, threshold: 6, success: false });
  assert(amended.ok, 'the result can be amended');
  state.rollWindows = amended.state.rollWindows;
  assertEqual(RollWindowManager.current(state)!.phase, 'REACT', 'still reacting after an amendment');

  // Resolving closes the window and hands the choices back.
  const closed = RollWindowManager.resolve(state);
  assertEqual(closed.declared.join(','), 'feather', 'declared options are reported');
  assertEqual(closed.reacted.join(','), 'stone', 'reacted options are reported');
  assertEqual((closed.state.rollWindows ?? []).length, 0, 'the window is popped');
  assert(!RollWindowManager.isPending(closed.state), 'nothing is pending afterwards');
});

test('kernel: roll windows reject malformed state', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'trade_ready' });
  const state = engine.getRawState();

  const opened = RollWindowManager.open(state, {
    id: 'rw_bad',
    label: '坏窗口',
    actorId: 'p1',
    phase: 'DECLARE',
    // 'ghost' never picked anything offered to it.
    declares: [{ actorId: 'p1', options: ['a'], picked: ['b'] }],
    reacts: [{ actorId: 'nobody', options: [], picked: [] }]
  });
  state.rollWindows = opened.rollWindows;

  const codes = checkInvariants(state, engine.getRules()).map(v => v.code);
  assert(codes.includes('ROLL_WINDOW_BAD_PICK'), 'a pick outside the offered options is rejected');
  assert(codes.includes('ROLL_WINDOW_UNKNOWN_SLOT'), 'an unknown slot actor is rejected');
});
