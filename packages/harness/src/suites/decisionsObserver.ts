/* -------------------------------------------------------------------------- */
/* suite:decisionsObserver — moved verbatim from suite.ts */
/* -------------------------------------------------------------------------- */

import { openDecision, projectDecision, resolveDecision, submitDecision } from '@rds/kernel/decisions';
import { ECSManager } from '@rds/kernel/ecs';
import { checkInvariants } from '@rds/kernel/invariants';
import { CognitiveObserver } from '@rds/kernel/observer';
import { RuleRegistry } from '@rds/kernel/rules';
import { Action } from '@rds/kernel/types';
import { test, assert, assertEqual } from '../testKit';
import { emptyState, withZone } from '../suiteHelpers';

test('decisions: secret submissions stay hidden until reveal', () => {
  let state = emptyState();
  const opened = openDecision(
    state,
    {
      kind: 'SIMULTANEOUS',
      title: 'secret',
      participants: ['p1', 'p2'],
      secret: true,
      policy: { type: 'ALL_COMMITTED' }
    },
    'd1'
  );
  state = opened.state;

  const first = submitDecision(state, 'd1', 'p1', { type: 'BID', playerId: 'p1', payload: { amount: 5 } });
  assert(first.accepted && !first.ready, 'first submission must not resolve');
  state = first.state;

  const p2View = projectDecision(state.pendingDecisions[0], 'p2');
  assertEqual(p2View.submissions.p1, 'COMMITTED', 'secret submission is masked');
  assertEqual(projectDecision(state.pendingDecisions[0], 'GOD').submissions.p1, (first.window as any).submissions.p1, 'god sees the action');

  const second = submitDecision(state, 'd1', 'p2', { type: 'BID', playerId: 'p2', payload: { amount: 9 } });
  assert(second.ready, 'all committed resolves the window');

  const resolved = resolveDecision(second.state, 'd1');
  assertEqual(resolved.window?.status, 'RESOLVED', 'window is resolved');
  assertEqual(resolved.window?.reveal?.p1 && (resolved.window.reveal.p1 as any).payload.amount, 5, 'reveal contains submissions');
});

test('decisions: priority policy short-circuits and orders submissions', () => {
  let state = openDecision(
    emptyState(),
    {
      kind: 'BIDDING',
      title: 'claims',
      participants: ['p1', 'p2'],
      secret: false,
      policy: { type: 'PRIORITY', priorities: { HU: 30, PENG: 20, CHI: 10 }, shortCircuitAt: 30 }
    },
    'd2'
  ).state;

  state = submitDecision(state, 'd2', 'p1', { type: 'CHI', playerId: 'p1' }).state;
  const hu = submitDecision(state, 'd2', 'p2', { type: 'HU', playerId: 'p2' });
  assert(hu.ready, 'HU must short-circuit regardless of the other submission');
});

test('decisions: FIRST_ACCEPT resolves on the first acceptance only', () => {
  let state = openDecision(
    emptyState(),
    {
      kind: 'VOTE',
      title: 'trade',
      participants: ['p1', 'p2', 'p3'],
      secret: false,
      policy: { type: 'FIRST_ACCEPT', acceptTypes: ['ACCEPT'] }
    },
    'd3'
  ).state;

  const reject = submitDecision(state, 'd3', 'p1', { type: 'REJECT', playerId: 'p1' });
  assert(!reject.ready, 'a rejection alone does not resolve');
  state = reject.state;

  const accept = submitDecision(state, 'd3', 'p2', { type: 'ACCEPT', playerId: 'p2' });
  assert(accept.ready, 'first acceptance short-circuits');
  assertEqual(accept.window?.status, 'READY', 'window becomes READY');

  const resolved = resolveDecision(accept.state, 'd3');
  assert(!!resolved.window, 'window resolved');
  assertEqual(resolved.window!.status, 'RESOLVED', 'status RESOLVED');

  const revealP1 = resolved.window!.reveal?.p1;
  const revealP2 = resolved.window!.reveal?.p2;
  assert(
    revealP1 !== undefined && revealP1 !== 'PASS' && revealP1 !== 'COMMITTED' && revealP1.type === 'REJECT',
    'earlier rejection is kept for audit'
  );
  assert(
    revealP2 !== undefined && revealP2 !== 'PASS' && revealP2 !== 'COMMITTED' && revealP2.type === 'ACCEPT',
    'acceptance is applied'
  );
  assertEqual(resolved.window!.reveal?.p3, undefined, 'later participants are not required');
});

test('decisions: FIRST_ACCEPT resolves after all rejections', () => {
  let state = openDecision(
    emptyState(),
    {
      kind: 'VOTE',
      title: 'trade',
      participants: ['p1', 'p2'],
      secret: false,
      policy: { type: 'FIRST_ACCEPT', acceptTypes: ['ACCEPT'] }
    },
    'd4'
  ).state;

  const first = submitDecision(state, 'd4', 'p1', { type: 'REJECT', playerId: 'p1' });
  assert(!first.ready, 'one rejection is not enough');
  const second = submitDecision(first.state, 'd4', 'p2', { type: 'REJECT', playerId: 'p2' });
  assert(second.ready, 'all rejections resolve the window');
});

test('observer: hidden cards are scrubbed, aliased and zone-remapped', () => {
  let state = withZone(emptyState(), 'deck', { type: 'HIDDEN' });
  state = ECSManager.addEntity(state, {
    id: 'secret-1',
    type: 'CARD',
    zoneId: 'deck',
    visibility: { type: 'HIDDEN' },
    components: { cardFace: { title: 'The Traitor', suit: '♠', rank: 'A' } }
  });

  const p1View = CognitiveObserver.projectState(state, 'p1');
  const alias = p1View.zones.deck.orderedEntities[0];
  assert(alias !== 'secret-1', 'hidden entity must be aliased');
  assertEqual(p1View.entities[alias]?.isMasked, true, 'hidden entity is masked');
  assert(p1View.entities[alias]?.components?.cardFace?.title !== 'The Traitor', 'hidden title must not leak');
  assertEqual(p1View.maskedEntityCount, 1, 'masked counter');

  const again = CognitiveObserver.projectState(state, 'p1');
  assertEqual(again.zones.deck.orderedEntities[0], alias, 'alias must be stable for a viewer');

  const godView = CognitiveObserver.projectState(state, 'GOD');
  assertEqual(godView.entities['secret-1']?.components?.cardFace?.title, 'The Traitor', 'GOD sees the truth');
});

test('observer: legal actions with scope.players survive projection (TDZ regression)', () => {
  const state = emptyState();
  const action = {
    type: 'PICK_TARGET',
    playerId: 'p1',
    selection: { prompt: 'choose', scope: { players: ['p1', 'p2', 'ghost'] } }
  } as unknown as Action;
  const view = CognitiveObserver.projectState(state, 'p1', () => [action]);
  assert(view.legalActions.length === 1, 'scope.players action must not throw (REVIEW TDZ)');
  const scope = (view.legalActions[0].selection as { scope?: { players?: string[] } } | undefined)?.scope;
  assertEqual(JSON.stringify(scope?.players), JSON.stringify(['p1', 'p2']), 'unknown players filtered from scope');
});

test('observer: aliasSecret switches aliases to keyed HMAC (S5)', () => {
  let state = withZone(emptyState(), 'deck', { type: 'HIDDEN' });
  state = ECSManager.addEntity(state, {
    id: 'roomtile_dining',
    type: 'CARD',
    zoneId: 'deck',
    visibility: { type: 'HIDDEN' },
    components: { cardFace: { title: 'X', suit: 's', rank: 'r' } }
  });
  CognitiveObserver.resetAliases();
  const plain = CognitiveObserver.projectState(state, 'p1').zones.deck.orderedEntities[0];
  const keyed = CognitiveObserver.projectState(state, 'p1', undefined, undefined, 'secret-alpha').zones.deck.orderedEntities[0];
  const keyedAgain = CognitiveObserver.projectState(state, 'p1', undefined, undefined, 'secret-alpha').zones.deck.orderedEntities[0];
  const keyedOther = CognitiveObserver.projectState(state, 'p1', undefined, undefined, 'secret-beta').zones.deck.orderedEntities[0];
  assert(keyed !== plain, 'keyed alias differs from legacy FNV alias');
  assert(/^v_id_[0-9a-f]{16}$/.test(keyed), 'keyed alias is a 64-bit HMAC slice');
  assertEqual(keyedAgain, keyed, 'keyed alias stable within one secret');
  assert(keyedOther !== keyed, 'different secret yields different alias (not invertible by table)');
});

test('invariants: valid state passes, corrupted states are rejected', () => {
  const rules = new RuleRegistry([]);
  const state = withZone(emptyState(), 'a');
  assertEqual(checkInvariants(state, rules).length, 0, 'fresh state is valid');

  const duplicate = {
    ...state,
    zones: { a: { ...state.zones.a, orderedEntities: ['x', 'x'] } }
  };
  const dupCodes = checkInvariants(duplicate, rules).map(v => v.code);
  assert(dupCodes.includes('ZONE_DUPLICATE_ENTITY'), `duplicate zone entries detected (${dupCodes.join(',')})`);

  const dangling = {
    ...state,
    zones: { a: { ...state.zones.a, orderedEntities: ['ghost'] } }
  };
  assert(
    checkInvariants(dangling, rules).some(v => v.code === 'ZONE_DANGLING_ENTITY'),
    'dangling entity detected'
  );

  const unknownHook = {
    ...state,
    activeHooks: [{ instanceId: 'i', hookId: 'missing', visibility: { type: 'PUBLIC' as const } }]
  };
  assert(
    checkInvariants(unknownHook, rules).some(v => v.code === 'HOOK_UNKNOWN_IMPL'),
    'unknown hook implementation detected'
  );
});

/* -------------------------------------------------------------------------- */
