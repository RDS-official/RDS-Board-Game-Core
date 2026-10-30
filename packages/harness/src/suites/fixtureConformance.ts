/* -------------------------------------------------------------------------- */
/* suite:fixtureConformance — moved verbatim from suite.ts */
/* -------------------------------------------------------------------------- */

import { RulePipeline } from '@rds/kernel/aop';
import { UniversalGameEngine } from '@rds/kernel/engine';
import { checkInvariants } from '@rds/kernel/invariants';
import { CognitiveObserver } from '@rds/kernel/observer';
import { RuleHookImpl, RuleRegistry } from '@rds/kernel/rules';
import { Action, ProjectedGameState } from '@rds/kernel/types';
import { validateActionShape } from '@rds/kernel/validation';
import { GAME_MODULES, GAME_REGISTRY } from '@rds/games/registry';
import { withDefaultPayload } from '@rds/kernel/actionPayload';
import { describeActionView } from '@rds/app/actionText';
import { setLocale } from '@rds/app/i18n';
import { test, assert, assertEqual } from '../testKit';
import { emptyState, crossFieldModule, playRandom } from '../suiteHelpers';

/* 3. Fixture conformance                                                      */
/* -------------------------------------------------------------------------- */

for (const module of GAME_MODULES) {
  test(`fixture ${module.meta.id}: initialises under strict invariants`, () => {
    const engine = new UniversalGameEngine(module, 2024);
    const state = engine.getRawState();
    assert(state.playerOrder.length > 0, 'has players');
    assertEqual(state.gameId, module.meta.id, 'gameId matches module');
    assertEqual(state.seed, 2024, 'seed recorded');

    const focus = engine.getFocusPlayers();
    assert(focus.length > 0, 'has a focus set');
    assert(engine.getLegalActions(focus[0]).length > 0, 'focus player has legal actions');

    const violations = checkInvariants(state, engine.getRules());
    assertEqual(violations.length, 0, `initial state invariants (${violations.map(v => v.code).join(',')})`);
  });

  test(`fixture ${module.meta.id}: random play + bit-exact replay`, () => {
    const engine = new UniversalGameEngine(module, 424242);
    const { applied, errors } = playRandom(engine, 18);
    assert(applied > 0, 'at least one action applied');
    assertEqual(errors.length, 0, `no dispatch errors (${errors.slice(0, 2).join(' | ')})`);

    const replay = engine.verifyReplay();
    assert(replay.ok, `replay mismatch (${replay.errors.slice(0, 2).join(' | ')})`);
  });

  test(`fixture ${module.meta.id}: projections never leak hidden card faces`, () => {
    const engine = new UniversalGameEngine(module, 777);
    playRandom(engine, 8);

    const raw = engine.getRawState();
    const hiddenTitles = new Set(
      Object.values(raw.entities)
        .filter(e => !CognitiveObserver.isVisibleTo(e.visibility, 'GOD', e.ownerId) && e.components.cardFace)
        .map(e => e.components.cardFace!.title)
    );

    for (const pid of raw.playerOrder) {
      const view = CognitiveObserver.projectState(raw, pid, (s, p) => engine.getLegalActions(p));
      for (const entity of Object.values(view.entities)) {
        if (entity.isMasked && entity.components?.cardFace?.title) {
          assert(!hiddenTitles.has(entity.components.cardFace.title), `view ${pid} leaked a hidden title`);
        }
      }
      for (const zone of Object.values(view.zones)) {
        for (const id of zone.orderedEntities) {
          assert(!!view.entities[id], `view ${pid} zone ${zone.id} references missing projected entity ${id}`);
        }
      }
    }
  });
}

test('validation: cross-field payload hooks reject inconsistent requests', () => {
  const engine = new UniversalGameEngine(crossFieldModule, 3);
  const invalid = engine.dispatch({ type: 'COMBO', playerId: 'p1', payload: { a: 5, b: 2 } });
  assert(!invalid.ok && /b must be greater than a/.test(invalid.error ?? ''), 'cross-field rejection');
  const valid = engine.dispatch({ type: 'COMBO', playerId: 'p1', payload: { a: 1, b: 2 } });
  assert(valid.ok, `cross-field acceptance: ${valid.error}`);
});

test('i18n: action labels flow through the locale registry', () => {
  const state = emptyState('i18n') as unknown as ProjectedGameState;
  const roll: Action = { type: 'ROLL_DICE', playerId: 'p1' };
  setLocale('zh');
  assertEqual(describeActionView(state, roll)?.label, '掷骰子', 'Chinese action label');
  setLocale('en');
  assertEqual(describeActionView(state, roll)?.label, 'Roll dice', 'English action label');
  setLocale('zh');
});

test('validation: conditional defaults skip hidden payload fields', () => {
  const action: Action = {
    type: 'COND',
    playerId: 'p1',
    fields: [
      { key: 'mode', label: 'Mode', kind: 'enum', options: [{ value: 'no', label: 'No' }], default: 'no' },
      {
        key: 'extra',
        label: 'Extra',
        kind: 'number',
        default: 7,
        dependsOn: { key: 'mode', equals: 'yes' }
      }
    ]
  };
  const payload = withDefaultPayload(action).payload as Record<string, unknown>;
  assertEqual(payload.mode, 'no', 'base default filled');
  assertEqual(payload.extra, undefined, 'hidden field default skipped');
});

test('validation: schemas reject malformed actions before legality', () => {
  const catan = new UniversalGameEngine(GAME_REGISTRY.catan, 3);
  const missingField = catan.dispatch({ type: 'BUILD_ROAD', playerId: 'p1' });
  assert(!missingField.ok && /targetEdgeId/.test(missingField.error ?? ''), 'missing required field rejected');

  const splendor = new UniversalGameEngine(GAME_REGISTRY.splendor, 3);
  const badGem = splendor.dispatch({
    type: 'TAKE_2_SAME_GEMS',
    playerId: 'p1',
    payload: { gem: 'opal' }
  });
  assert(!badGem.ok && /payload\.gem/.test(badGem.error ?? ''), 'enum violation rejected');

  const dune = new UniversalGameEngine(GAME_REGISTRY.dune_mahjong, 3);
  dune.dispatch({ type: 'OPEN_BATTLE_WINDOW', playerId: 'p1' });
  const badTroops = dune.dispatch({
    type: 'COMMIT_BATTLE_DIAL',
    playerId: 'p1',
    payload: { troops: 999, leaderStr: 5, weapon: 'Crysknife' }
  });
  assert(!badTroops.ok && /payload\.troops/.test(badTroops.error ?? ''), 'range violation rejected');
});

test('validation: schemas do not decide semantic legality', () => {
  const schemas = {
    PING: { type: 'PING', payload: { n: { kind: 'integer' as const, required: true } } }
  };

  assertEqual(
    validateActionShape({ type: 'PING', playerId: 'p1', payload: { n: 2 } }, schemas).length,
    0,
    'well-formed action passes shape validation'
  );
  assert(
    validateActionShape({ type: 'PING', playerId: 'p1', payload: { n: 1.5 } }, schemas).length > 0,
    'integer constraint enforced'
  );
  assert(
    validateActionShape({ type: 'UNKNOWN', playerId: 'p1' }, schemas).length === 0,
    'unknown action types fall back to structural checks'
  );
});

test('rule graph: missing dependencies and cycles are rejected', () => {
  const base: RuleHookImpl = {
    id: 'base',
    name: 'base',
    stage: 'FILTER_MODIFY',
    priority: 5,
    description: '',
    predicate: () => false,
    handler: () => ({ type: 'CONTINUE' })
  };
  const dependent: RuleHookImpl = {
    ...base,
    id: 'dependent',
    name: 'dependent',
    priority: 50,
    requires: ['base']
  };
  const acyclic = new RuleRegistry([dependent, base]);
  assertEqual(acyclic.dependencyErrors().length, 0, 'acyclic graph accepted');

  const order = acyclic.order(acyclic.all()).map(impl => impl.id);
  assert(order.indexOf('base') < order.indexOf('dependent'), 'dependency runs before dependent');

  const missing = new RuleRegistry([dependent]);
  assert(
    missing.dependencyErrors().some(e => e.includes('unknown hook')),
    'missing dependency reported'
  );

  const cyclicA: RuleHookImpl = { ...base, id: 'a', requires: ['b'] };
  const cyclicB: RuleHookImpl = { ...base, id: 'b', requires: ['a'] };
  const cyclic = new RuleRegistry([cyclicA, cyclicB]);
  assert(
    cyclic.dependencyErrors().some(e => e.includes('cycle')),
    'cycle reported'
  );
});

test('rule graph: activation requires active prerequisites', () => {
  const impls: RuleHookImpl[] = [
    {
      id: 'root',
      name: 'root',
      stage: 'FILTER_MODIFY',
      priority: 1,
      description: '',
      predicate: () => false,
      handler: () => ({ type: 'CONTINUE' })
    },
    {
      id: 'leaf',
      name: 'leaf',
      stage: 'FILTER_MODIFY',
      priority: 2,
      description: '',
      requires: ['root'],
      predicate: () => false,
      handler: () => ({ type: 'CONTINUE' })
    }
  ];

  const pipeline = new RulePipeline(new RuleRegistry(impls));
  let state = emptyState();

  let threw = false;
  try {
    pipeline.activate(state, 'leaf', 'leaf-1');
  } catch {
    threw = true;
  }
  assert(threw, 'leaf cannot activate without root');

  state = pipeline.activate(state, 'root', 'root-1');
  state = pipeline.activate(state, 'leaf', 'leaf-1');
  assertEqual(state.activeHooks.length, 2, 'both hooks active');

  state = pipeline.deactivate(state, 'root-1');
  assertEqual(state.activeHooks.length, 1, 'deactivation removes only the requested instance');
});

test('fixture dune_mahjong: secret simultaneous decision resolves atomically', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.dune_mahjong, 31);

  const open = engine.dispatch({ type: 'OPEN_BATTLE_WINDOW', playerId: 'p1' });
  assert(open.ok, `open window failed: ${open.error}`);
  assertEqual(engine.getFocusPlayers().sort().join(','), 'p1,p2', 'both houses must commit');

  const p1Action = engine.getLegalActions('p1').find(a => a.type === 'COMMIT_BATTLE_DIAL');
  assert(p1Action, 'p1 can commit a dial');
  const p1Commit = engine.dispatch(p1Action!);
  assert(p1Commit.ok, `p1 commit failed: ${p1Commit.error}`);

  // p2's projection must not see p1's dial
  const p2View = CognitiveObserver.projectState(engine.getRawState(), 'p2');
  const window = p2View.pendingDecisions.find(w => w.status === 'OPEN');
  assert(!!window, 'decision window is open');
  assertEqual(window!.submissions.p1, 'COMMITTED', 'p1 submission is collapsed for p2');

  const p2Action = engine.getLegalActions('p2').find(a => a.type === 'COMMIT_BATTLE_DIAL');
  assert(p2Action, 'p2 can commit a dial');
  const p2Commit = engine.dispatch(p2Action!);
  assert(p2Commit.ok, `p2 commit failed: ${p2Commit.error}`);
  assert(p2Commit.decisionResolved, 'second commit resolves the window');

  const state = engine.getRawState();
  assert(!!state.globalVars.revealedBattleResult, 'battle result revealed');
  assertEqual(
    state.pendingDecisions.filter(w => w.status === 'OPEN').length,
    0,
    'no decision window left open'
  );
  assert(engine.verifyReplay().ok, 'decision flow is replayable');
});

test('fixture sanguosha: interrupt stack resolves through hidden information', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.sanguosha, 88);
  const strike = engine.getLegalActions('p1').find(a => a.type === 'PLAY_STRIKE');
  assert(strike, 'p1 has a Strike');

  const played = engine.dispatch(strike!);
  assert(played.ok, `strike failed: ${played.error}`);

  const stack = engine.getRawState().interruptStack;
  assertEqual(stack.length, 1, 'strike pushes one frame');
  assertEqual(stack[0].type, 'STRIKE_RESOLUTION', 'top frame is the strike resolution');
  assertEqual(engine.getFocusPlayers().join(','), 'p2', 'target is the focus');

  const pass = engine.getLegalActions('p2').find(a => a.type === 'PASS');
  assert(pass, 'target can pass');
  const resolved = engine.dispatch(pass!);
  assert(resolved.ok, `pass failed: ${resolved.error}`);

  const state = engine.getRawState();
  assertEqual(state.interruptStack.length, 0, 'stack is empty after resolution');
  assertEqual(state.players.p2.customProps.hp, 3, 'unanswered strike deals 1 damage');
  assert(engine.verifyReplay().ok, 'interrupt flow is replayable');
});

/* -------------------------------------------------------------------------- */
