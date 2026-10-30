/* -------------------------------------------------------------------------- */
/* suite:clock — moved verbatim from suite.ts */
/* -------------------------------------------------------------------------- */

import { UniversalGameEngine } from '@rds/kernel/engine';
import { GAME_REGISTRY } from '@rds/games/registry';
import { UniversalSession } from '@rds/app/session';
import { test, assert, assertEqual } from '../testKit';

test('projection: module redactors hide secret roles and private globals', () => {
  const sgs = new UniversalGameEngine(GAME_REGISTRY.sanguosha, 2);

  const p2View = sgs.getProjectedStateFor('p2');
  assertEqual(p2View.players.p1.role, 'LORD', 'the Lord is public');
  assertEqual(p2View.players.p2.role, 'LOYALIST', 'own role is visible');
  assertEqual(p2View.players.p3.role, undefined, 'other roles are scrubbed');
  assertEqual(p2View.players.p3.secretRole, undefined, 'secret roles never leak');

  const godView = sgs.getProjectedStateFor('GOD');
  assertEqual(godView.players.p3.role, 'REBEL', 'god sees everything');

  const dune = new UniversalGameEngine(GAME_REGISTRY.dune_mahjong, 2);
  dune.getRawState().globalVars.committedDials = {
    p1: { troops: 3, leaderStr: 5, weapon: 'SECRET-WEAPON' }
  };

  const duneP2 = dune.getProjectedStateFor('p2');
  assert(!('committedDials' in duneP2.globalVars), 'private global vars are removed');
  assert(!JSON.stringify(duneP2).includes('SECRET-WEAPON'), 'private values never leak through projection');

  const duneGod = dune.getProjectedStateFor('GOD');
  assert(!!duneGod.globalVars.committedDials, 'god still sees raw globals');
});

test('engine: logical clock times out secret decisions deterministically', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.dune_mahjong, 11);

  assert(engine.dispatch({ type: 'OPEN_BATTLE_WINDOW', playerId: 'p1' }).ok, 'window opens');
  const opened = engine.getRawState().pendingDecisions.find(w => w.status === 'OPEN');
  assert(!!opened && typeof opened.deadline === 'number', 'decision receives a logical deadline');

  const commit = engine.getLegalActions('p1').find(a => a.type === 'COMMIT_BATTLE_DIAL');
  assert(!!commit, 'p1 can commit');
  assert(engine.dispatch(commit!).ok, 'commit accepted');

  const ticks = opened!.deadline! - engine.getRawState().clock + 1;
  const tick = engine.dispatch({ type: '__TICK__', playerId: 'SYSTEM', payload: { ticks } });
  assert(tick.ok, `tick failed: ${tick.error}`);

  const state = engine.getRawState();
  assert(state.clock >= opened!.deadline!, 'clock advanced past the deadline');
  const resolved = state.pendingDecisions.find(w => w.id === opened!.id);
  assertEqual(resolved?.status, 'RESOLVED', 'timed-out decision is resolved');
  assertEqual(resolved?.reveal?.p2, 'PASS', 'missing participant timed out as PASS');
  assertEqual(state.actionLog.some(a => a.type === '__TICK__'), true, 'tick is part of the action log');

  const replay = engine.verifyReplay();
  assert(replay.ok, `timeout replay mismatch: ${replay.errors.join(' | ')}`);
});

test('engine: response windows time out and resolve the frame payload', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.sanguosha, 88);

  const strike = engine.getLegalActions('p1').find(a => a.type === 'PLAY_STRIKE');
  assert(!!strike, 'p1 can strike');
  assert(engine.dispatch(strike!).ok, 'strike accepted');

  const frame = engine.getRawState().interruptStack[0];
  assert(!!frame.responseWindow && typeof frame.responseWindow.deadline === 'number', 'response window has a deadline');

  const ticks = frame.responseWindow!.deadline! - engine.getRawState().clock + 1;
  const tick = engine.dispatch({ type: '__TICK__', playerId: 'SYSTEM', payload: { ticks } });
  assert(tick.ok, `tick failed: ${tick.error}`);

  const state = engine.getRawState();
  assertEqual(state.interruptStack.length, 0, 'expired frame popped');
  assertEqual(state.players.p2.customProps.hp, 3, 'frame payload resolved after timeout');
  assert(engine.verifyReplay().ok, 'response timeout replay is bit-exact');
});

test('presenter: clock control advances the logical clock and expires decisions', () => {
  const session = new UniversalSession(GAME_REGISTRY.dune_mahjong, 3);
  const open = session.getSnapshot().actions.find(action => action.label.includes('开启秘密战斗窗口'));
  assert(!!open, 'battle window action available');
  assert(session.perform(open!.id).ok, 'window opens through the presenter');

  const before = session.getSnapshot();
  assertEqual(before.openDecisions, 1, 'decision is open');

  session.advanceClock(8);
  const after = session.getSnapshot();

  assert(after.clock > before.clock, 'clock advanced through the presenter');
  assertEqual(after.openDecisions, 0, 'expired decision resolved');
  assert(after.log.entries.some(entry => entry.type === '__TICK__'), 'tick is visible in the UI log');
});
