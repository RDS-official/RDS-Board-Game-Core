/* -------------------------------------------------------------------------- */
/* suite:expansions — moved verbatim from suite.ts */
/* -------------------------------------------------------------------------- */

import { UniversalGameEngine } from '@rds/kernel/engine';
import { DEFAULT_MAX_COMBINATIONS, defaultExpansions, deriveExpansionScenarios, expansionScenarioId, expansionsOf, resolveExpansions, stampExpansions, validateExpansionSelection } from '@rds/kernel/expansions';
import { defineGame, GameExpansion } from '@rds/kernel/module';
import { DeterministicPRNG } from '@rds/kernel/prng';
import { canonicalize, hashString } from '@rds/kernel/serialize';
import { GameState } from '@rds/kernel/types';
import { test, assert, assertEqual } from '../testKit';
import { emptyState, counterModule, deadlineModule, EXPANSION_FIXTURE } from '../suiteHelpers';

/* Game expansions                                                             */
/* -------------------------------------------------------------------------- */

test('expansions: resolveExpansions closes over requires and sorts', () => {
  assertEqual(resolveExpansions(EXPANSION_FIXTURE, ['military']).join(','), 'military,standard', 'base is pulled in');
  assertEqual(
    resolveExpansions(EXPANSION_FIXTURE, ['wind']).join(','),
    'military,standard,wind',
    'transitive requires are expanded'
  );
  assertEqual(
    resolveExpansions(EXPANSION_FIXTURE, ['mountain', 'military']).join(','),
    'military,mountain,standard',
    'input order is irrelevant'
  );
  assertEqual(
    resolveExpansions(EXPANSION_FIXTURE, ['wind', 'wind', 'military']).join(','),
    'military,standard,wind',
    'duplicates collapse'
  );
  assertEqual(resolveExpansions(EXPANSION_FIXTURE, []).length, 0, 'an empty selection resolves to nothing');
  assertEqual(resolveExpansions(undefined, []).length, 0, 'a game without expansions resolves to nothing');

  // The resolved list is the canonical form: sorting by code unit, not locale.
  const resolved = resolveExpansions(EXPANSION_FIXTURE, ['mountain', 'forest', 'wind']);
  assertEqual(resolved.join(','), [...resolved].sort().join(','), 'result is sorted');
  assertEqual(resolved.join(','), resolveExpansions(EXPANSION_FIXTURE, resolved).join(','), 'resolution is idempotent');
});

test('expansions: a missing dependency is rejected', () => {
  const broken: Record<string, GameExpansion> = {
    standard: { id: 'standard', name: '标准包' },
    military: { id: 'military', name: '军争篇', requires: ['standard'] },
    wind: { id: 'wind', name: '风包', requires: ['standard', 'fire'] }
  };

  const errors = validateExpansionSelection(broken, ['wind']);
  assertEqual(errors.length, 1, 'exactly one dependency error');
  assert(errors[0].includes('"wind"') && errors[0].includes('"fire"'), `error names both ends — got ${errors[0]}`);

  assert(validateExpansionSelection(broken, ['military']).length === 0, 'satisfied dependencies validate');

  let threw = false;
  try {
    resolveExpansions(broken, ['wind']);
  } catch (error) {
    threw = true;
    assert((error as Error).message.includes('unknown expansion "fire"'), 'resolution throws with the missing id');
  }
  assert(threw, 'resolution cannot return a list for a missing dependency');
});

test('expansions: conflicting combinations are rejected', () => {
  assertEqual(validateExpansionSelection(EXPANSION_FIXTURE, ['fire']).length, 0, 'one side alone is legal');
  assertEqual(validateExpansionSelection(EXPANSION_FIXTURE, ['forest']).length, 0, 'the other side alone is legal');

  const both = validateExpansionSelection(EXPANSION_FIXTURE, ['fire', 'forest']);
  assertEqual(both.length, 1, 'the pair conflicts exactly once');
  assert(both[0].includes('"fire"') && both[0].includes('"forest"'), `error names both sides — got ${both[0]}`);

  // The conflict lives on `fire` alone; the reverse direction is not declared,
  // yet the pair must still be rejected and reported once.
  const oneSided: Record<string, GameExpansion> = {
    a: { id: 'a', name: 'A', conflicts: ['b'] },
    b: { id: 'b', name: 'B' }
  };
  assertEqual(validateExpansionSelection(oneSided, ['a', 'b']).length, 1, 'one declared side is enough');

  // A conflict with a pack that is not enabled is not an error.
  const distant: Record<string, GameExpansion> = {
    a: { id: 'a', name: 'A', conflicts: ['c'] },
    b: { id: 'b', name: 'B' },
    c: { id: 'c', name: 'C' }
  };
  assertEqual(validateExpansionSelection(distant, ['a', 'b']).length, 0, 'an absent conflict target is harmless');

  // Conflicts are checked over the closure, so a required pack still collides.
  const viaDependency: Record<string, GameExpansion> = {
    standard: { id: 'standard', name: '标准包', conflicts: ['forest'] },
    military: { id: 'military', name: '军争篇', requires: ['standard'] },
    forest: { id: 'forest', name: '林包' }
  };
  assert(
    validateExpansionSelection(viaDependency, ['military', 'forest']).length > 0,
    'a conflict on an implicitly required pack still fires'
  );
});

test('expansions: circular and self-referential dependencies are rejected', () => {
  const circular: Record<string, GameExpansion> = {
    a: { id: 'a', name: 'A', requires: ['b'] },
    b: { id: 'b', name: 'B', requires: ['c'] },
    c: { id: 'c', name: 'C', requires: ['a'] }
  };
  const cycleErrors = validateExpansionSelection(circular, ['a']);
  assert(cycleErrors.length > 0, 'a three-node cycle is rejected');
  assert(cycleErrors.some(error => error.includes('circular')), `error says circular — got ${cycleErrors.join(' | ')}`);
  assert(cycleErrors.some(error => error.includes('a -> b -> c -> a') || error.includes('c -> a')), 'the cycle is named');

  let threw = false;
  try {
    resolveExpansions(circular, ['a']);
  } catch (error) {
    threw = true;
    assert((error as Error).message.includes('circular'), 'resolution refuses a cycle');
  }
  assert(threw, 'resolution cannot terminate a cycle');

  const self: Record<string, GameExpansion> = { a: { id: 'a', name: 'A', requires: ['a'] } };
  const selfErrors = validateExpansionSelection(self, ['a']);
  assertEqual(selfErrors.length, 1, 'a self-dependency is reported once');
  assert(selfErrors[0].includes('requires itself'), `error says self — got ${selfErrors[0]}`);

  const selfConflict: Record<string, GameExpansion> = { a: { id: 'a', name: 'A', conflicts: ['a'] } };
  const selfConflictErrors = validateExpansionSelection(selfConflict, ['a']);
  assert(
    selfConflictErrors.some(error => error.includes('conflicts with itself')),
    'a self-conflict is reported as such'
  );

  // A broken definition that is not selected must not fail a legal selection.
  const dormant: Record<string, GameExpansion> = {
    base: { id: 'base', name: '标准包' },
    broken: { id: 'broken', name: '坏包', requires: ['broken'] }
  };
  assertEqual(validateExpansionSelection(dormant, ['base']).length, 0, 'unselected definitions are not validated');
});

test('expansions: unknown ids are rejected', () => {
  const unknown = validateExpansionSelection(EXPANSION_FIXTURE, ['nope']);
  assertEqual(unknown.length, 1, 'one unknown id, one error');
  assert(unknown[0].includes('"nope"'), `error names the id — got ${unknown[0]}`);

  assertEqual(
    validateExpansionSelection(EXPANSION_FIXTURE, ['military', 'nope']).length,
    1,
    'a legal id beside an unknown one still fails'
  );
  assert(
    validateExpansionSelection(undefined, ['nope']).length > 0,
    'a game without expansions rejects any id'
  );

  assertEqual(validateExpansionSelection(EXPANSION_FIXTURE, []).length, 0, 'the empty selection is always legal');
  assertEqual(validateExpansionSelection(undefined, []).length, 0, 'a game without expansions has one legal selection');

  let threw = false;
  try {
    resolveExpansions(EXPANSION_FIXTURE, ['nope']);
  } catch {
    threw = true;
  }
  assert(threw, 'resolution throws on an unknown id');
});

test('expansions: defaultExpansions is dependency-closed and sorted', () => {
  assertEqual(defaultExpansions(EXPANSION_FIXTURE).join(','), 'standard', 'flagged defaults are selected');
  assertEqual(defaultExpansions(undefined).length, 0, 'a game without expansions defaults to nothing');
  assertEqual(defaultExpansions({ a: { id: 'a', name: 'A' } }).length, 0, 'nothing is default unless flagged');

  const closure: Record<string, GameExpansion> = {
    standard: { id: 'standard', name: '标准包' },
    military: { id: 'military', name: '军争篇', requires: ['standard'], defaultEnabled: true }
  };
  assertEqual(
    defaultExpansions(closure).join(','),
    'military,standard',
    'a default pack drags in its dependencies'
  );
  assertEqual(validateExpansionSelection(closure, defaultExpansions(closure)).length, 0, 'defaults are legal');

  // An undefined dependency in a default must not throw — the table still boots.
  const brokenDefault: Record<string, GameExpansion> = {
    military: { id: 'military', name: '军争篇', requires: ['missing'], defaultEnabled: true }
  };
  assertEqual(defaultExpansions(brokenDefault).join(','), 'military', 'an unresolved default degrades gracefully');
});

test('expansions: scenario ids are stable and readable', () => {
  assertEqual(expansionScenarioId([]), 'base', 'the empty selection is "base"');
  assertEqual(expansionScenarioId(['military']), 'military', 'a single pack is its own id');
  assertEqual(expansionScenarioId(['wind', 'military']), 'military+wind', 'sorted, joined with +');
  assertEqual(expansionScenarioId(['military', 'wind']), 'military+wind', 'input order does not matter');
  assertEqual(expansionScenarioId(['wind', 'wind']), 'wind', 'duplicates are dropped');
  assertEqual(expansionScenarioId(['wind', '']), 'wind', 'blanks are dropped');
  assertEqual(expansionScenarioId(['b', 'a']), 'a+b', 'code-unit order, not insertion order');

  // The same combination must produce the same id across calls — a replay log
  // keyed on it would otherwise stop matching.
  const combo = Object.keys(EXPANSION_FIXTURE).reverse();
  assertEqual(expansionScenarioId(combo), expansionScenarioId([...combo].sort()), 'the id is order-free');
  assertEqual(
    expansionScenarioId(resolveExpansions(EXPANSION_FIXTURE, ['wind'])),
    'military+standard+wind',
    'a resolved closure has a readable id'
  );
});

test('expansions: deriveExpansionScenarios emits only legal combinations', () => {
  const derived = deriveExpansionScenarios(EXPANSION_FIXTURE, enabled => ({
    ...emptyState('expansion_fixture', 42),
    globalVars: { ticks: 0, expansions: enabled }
  }));

  const ids = Object.keys(derived);
  assert(ids.includes('base'), 'the empty combination is always present');
  assert(ids.includes('military+standard'), 'a legal combination is present');
  assert(ids.includes('military+standard+wind'), 'a transitively closed combination is present');
  assert(
    !ids.includes('military') && !ids.includes('wind'),
    'a non-closed subset gets no id of its own (it would duplicate its closure)'
  );
  assert(!ids.includes('fire+forest+standard'), 'a conflicting combination is absent');
  assert(
    !ids.includes('fire+forest+military+standard'),
    'a conflicting pair stays absent even beside other legal packs'
  );

  // Every emitted scenario must pass the validator, and its id must match its
  // own enabled set — that bijection is what makes replays readable.
  for (const [id, scenario] of Object.entries(derived)) {
    const state = scenario.setup(42);
    const enabled = state.globalVars.expansions as string[];
    assertEqual(validateExpansionSelection(EXPANSION_FIXTURE, enabled).length, 0, `${id} is legal`);
    assertEqual(expansionScenarioId(enabled), id, `${id} round-trips through its id`);
    assertEqual(resolveExpansions(EXPANSION_FIXTURE, enabled).join(','), [...enabled].join(','), `${id} is closed`);
  }

  // Sanguosha's real shape: 6 packs are 64 subsets, of which only the closed
  // and non-conflicting ones survive. Deriving that count from an independent
  // brute force is the actual assertion — a number typed by hand would only
  // pin today's fixture.
  const allIds = Object.keys(EXPANSION_FIXTURE).sort();
  const legalCombinations: string[] = [];
  for (let mask = 0; mask < 2 ** allIds.length; mask += 1) {
    const subset = allIds.filter((_, index) => (mask & (1 << index)) !== 0);
    const set = new Set(subset);
    const closed = subset.every(id => (EXPANSION_FIXTURE[id].requires ?? []).every(r => set.has(r)));
    if (!closed) continue;
    const clean = subset.every(id => (EXPANSION_FIXTURE[id].conflicts ?? []).every(c => !set.has(c)));
    if (!clean) continue;
    legalCombinations.push(expansionScenarioId(subset));
  }
  assertEqual(
    ids.join(','),
    legalCombinations.sort().join(','),
    `every legal closed combination is derived, and nothing else — got ${ids.join(', ')}`
  );
  assert(ids.length < 2 ** allIds.length, 'conflicts and closures do prune the powerset');
  assertEqual(ids.join(','), [...ids].sort().join(','), 'keys are sorted for a stable dropdown');

  // Descriptions are built from the display names, not the ids.
  assertEqual(derived['base'].description, '基础游戏', 'the base scenario has its own description');
  assertEqual(derived['military+standard'].description, '军争篇 · 标准包', 'descriptions join the display names');
  assertEqual(derived['fire+standard'].description, '火包 · 标准包', 'a legal single pack is described');

  // The setup callback receives a copy, so a caller cannot corrupt the scenario.
  const first = derived['military+standard'].setup(1);
  first.globalVars.expansions.push('mutated');
  assertEqual(
    (derived['military+standard'].setup(1).globalVars.expansions as string[]).includes('mutated'),
    false,
    'each setup call gets its own list'
  );

  // No expansions declared: exactly one scenario, the base game.
  const bare = deriveExpansionScenarios(undefined, enabled => ({
    ...emptyState('bare_fixture', 42),
    globalVars: { expansions: enabled }
  }));
  assertEqual(Object.keys(bare).join(','), 'base', 'a game without expansions derives only "base"');
});

test('expansions: deriveExpansionScenarios guards the powerset', () => {
  // Six independent packs enumerate exactly the default ceiling: allowed.
  const six: Record<string, GameExpansion> = {};
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) six[id] = { id, name: id.toUpperCase() };
  assertEqual(2 ** Object.keys(six).length, DEFAULT_MAX_COMBINATIONS, 'the fixture sits exactly on the cap');
  assertEqual(
    Object.keys(deriveExpansionScenarios(six, _enabled => emptyState('cap_fixture'))).length,
    DEFAULT_MAX_COMBINATIONS,
    'the powerset is enumerated when it fits'
  );

  const seven: Record<string, GameExpansion> = { ...six, g: { id: 'g', name: 'G' } };
  let threw = false;
  try {
    deriveExpansionScenarios(seven, enabled => emptyState('cap_fixture'));
  } catch (error) {
    threw = true;
    const message = (error as Error).message;
    assert(message.includes('128') && message.includes('64'), `error states both numbers — got ${message}`);
    assert(message.includes('maxCombinations'), 'error names the guard');
  }
  assert(threw, 'one pack past the cap throws instead of silently truncating');

  // The guard is a ceiling on candidates, not on legal combinations: a smaller
  // explicit budget is honored even when few combinations survive.
  let budgetThrew = false;
  try {
    deriveExpansionScenarios(six, enabled => emptyState('cap_fixture'), { maxCombinations: 63 });
  } catch {
    budgetThrew = true;
  }
  assert(budgetThrew, 'an explicit budget below the powerset throws');

  // A curated subset stays derivable at the default cap.
  const curated = deriveExpansionScenarios(seven, enabled => emptyState('cap_fixture'), {
    maxCombinations: 256
  });
  assertEqual(Object.keys(curated).length, 128, 'a raised budget enumerates the full powerset');

  let invalidBudget = false;
  try {
    deriveExpansionScenarios(EXPANSION_FIXTURE, enabled => emptyState('cap_fixture'), { maxCombinations: 0 });
  } catch {
    invalidBudget = true;
  }
  assert(invalidBudget, 'a non-positive budget is rejected');
});

test('expansions: ids that collide with the scenario-id grammar are rejected', () => {
  // `base` is the id of the empty combination, so a pack with that id would give
  // `[]` and `['base']` the same scenario key — a replay could not tell them
  // apart. The same holds for the `+` separator.
  let reserved = false;
  try {
    deriveExpansionScenarios(
      { base: { id: 'base', name: 'Base' }, other: { id: 'other', name: 'Other' } },
      enabled => emptyState('grammar_fixture')
    );
  } catch (error) {
    reserved = true;
    assert((error as Error).message.includes('reserved'), `error says reserved — got ${(error as Error).message}`);
  }
  assert(reserved, 'an expansion named "base" cannot be derived');

  let separator = false;
  try {
    deriveExpansionScenarios({ 'a+b': { id: 'a+b', name: 'A plus B' } }, enabled => emptyState('grammar_fixture'));
  } catch (error) {
    separator = true;
    assert((error as Error).message.includes('separator'), 'error explains the separator collision');
  }
  assert(separator, 'an expansion id containing "+" cannot be derived');

  // `expansionScenarioId` itself stays total — it is the derivation that refuses.
  assertEqual(expansionScenarioId(['a', 'b']), 'a+b', 'the separator still joins ordinary ids');
});

test('expansions: stampExpansions records the set without touching the state', () => {
  const before = emptyState('stamp_fixture', 7);
  before.globalVars = { ticks: 3 };

  const stamped = stampExpansions(before, ['wind', 'alpha', 'alpha']);
  assertEqual((stamped.globalVars.expansions as string[]).join(','), 'alpha,wind', 'ids are sorted and de-duplicated');
  assertEqual(stamped.globalVars.ticks, 3, 'existing globalVars are preserved');
  assertEqual(before.globalVars.expansions, undefined, 'the input state is not mutated');
  assert(stamped !== before, 'a new state object is returned');

  assertEqual(expansionsOf(stamped).join(','), 'alpha,wind', 'the stamp reads back');
  assertEqual(expansionsOf(before).length, 0, 'an unstamped state reads as no expansions');
  assertEqual(stamped.seq, before.seq, 'stamping is not a transition');

  // The stamp must keep the state JSON-clean and hash-stable.
  const roundTripped = JSON.parse(JSON.stringify(stamped)) as GameState;
  assertEqual(JSON.stringify(roundTripped), JSON.stringify(stamped), 'the stamped state survives JSON');
  assertEqual(hashString(canonicalize(roundTripped)), hashString(canonicalize(stamped)), 'the hash is unchanged by JSON');

  // A second stamp replaces rather than appends.
  assertEqual(
    (stampExpansions(stamped, ['fire']).globalVars.expansions as string[]).join(','),
    'fire',
    're-stamping replaces the set'
  );
});

test('expansions: a derived scenario replays bit-exactly through the engine', () => {
  // The whole point of a stable scenario id: a log written under `base+military`
  // must restore the same position on another machine.
  const module = defineGame({
    ...counterModule,
    meta: { ...counterModule.meta, id: 'expansion_fixture', name: 'Expansion fixture' },
    expansions: EXPANSION_FIXTURE,
    // A derived setup builds one position per combination; stamping the ids into
    // globalVars is what a real module would do so the rules can read them back.
    scenarios: deriveExpansionScenarios(EXPANSION_FIXTURE, enabled => {
      const state = emptyState('expansion_fixture', 42);
      // `ticks` keeps the fixture playable: counterModule offers TICK below 100.
      return stampExpansions({ ...state, globalVars: { ...state.globalVars, ticks: 0 } }, enabled);
    }),
    // Expansion ids are part of the position, so the reducer must carry them
    // through — a module that rebuilt globalVars from scratch would drop the
    // stamp, and the replay would no longer describe the same table.
    reduce: (state, action, ctx) => {
      if (action.type !== 'TICK') return state;
      const { value, nextSeed } = DeterministicPRNG.next(state.prngState);
      return {
        ...state,
        prngState: nextSeed,
        globalVars: { ...state.globalVars, ticks: (state.globalVars.ticks as number) + 1, last: value }
      };
    }
  });

  const id = expansionScenarioId(resolveExpansions(EXPANSION_FIXTURE, ['wind']));
  assertEqual(id, 'military+standard+wind', 'the derived id is the replay key');

  const engine = new UniversalGameEngine(module, 9, { scenario: id });
  assertEqual(engine.getScenario(), id, 'the engine records the scenario');
  assertEqual(
    (engine.getRawState().globalVars.expansions as string[]).join(','),
    'military,standard,wind',
    'the scenario stamped its expansions'
  );
  assert(engine.dispatch({ type: 'TICK', playerId: 'p1' }).ok, 'the position is playable');
  assertEqual(expansionsOf(engine.getRawState()).join(','), 'military,standard,wind', 'the stamp survives a transition');

  const log = engine.exportLog();
  assertEqual(log.scenario, id, 'the log carries the scenario id');

  const restored = new UniversalGameEngine(module, 1);
  const report = restored.loadLog(log);
  assert(report.ok, `restore failed: ${report.errors.join(' | ')}`);
  assertEqual(restored.getStateHash(), engine.getStateHash(), 'the restored hash matches');
  assertEqual(expansionsOf(restored.getRawState()).join(','), 'military,standard,wind', 'expansions survive the log');
});

test('engine: effects expire and are projected by visibility', () => {
  const engine = new UniversalGameEngine(counterModule, 5);
  const raw = engine.getRawState();
  raw.effects = [
    { id: 'e_expired', kind: 'buff', source: 'p1', target: 'p1', expiresAt: { turn: 0 } },
    { id: 'e_public', kind: 'buff', source: 'p1', target: 'p1', expiresAt: { turn: 3 } },
    { id: 'e_hidden', kind: 'curse', source: 'p1', target: 'p1', visibility: { type: 'HIDDEN' } }
  ];

  assert(engine.dispatch({ type: 'TICK', playerId: 'p1' }).ok, 'tick accepted');
  const state = engine.getRawState();
  assert(!state.effects?.some(effect => effect.id === 'e_expired'), 'expired effect removed');
  assert(state.effects?.some(effect => effect.id === 'e_public'), 'active effect retained');

  const view = engine.getProjectedStateFor('p1');
  assert(view.effects?.some(effect => effect.id === 'e_public'), 'public effect projected');
  assert(!view.effects?.some(effect => effect.id === 'e_hidden'), 'hidden effect removed');
});

test('engine: per-participant deadlines expire independently', () => {
  const engine = new UniversalGameEngine(deadlineModule, 3);

  assert(engine.dispatch({ type: '__TICK__', playerId: 'SYSTEM', payload: { ticks: 2 } }).ok, 'first tick');
  let window = engine.getRawState().pendingDecisions.find(w => w.id === 'w1');
  assertEqual(window?.status, 'OPEN', 'window still waits for p2');
  assertEqual(window?.submissions.p1, 'PASS', 'p1 timed out at its own deadline');
  assertEqual(window?.submissions.p2, undefined, 'p2 has not timed out yet');

  assert(engine.dispatch({ type: '__TICK__', playerId: 'SYSTEM', payload: { ticks: 3 } }).ok, 'second tick');
  window = engine.getRawState().pendingDecisions.find(w => w.id === 'w1');
  assertEqual(window?.status, 'RESOLVED', 'window resolves when the last deadline passes');
  assertEqual(window?.reveal?.p2, 'PASS', 'p2 timed out independently');

  assert(engine.verifyReplay().ok, 'per-player deadline replay is bit-exact');
});

test('engine: illegal actions are rejected without mutating state', () => {
  const engine = new UniversalGameEngine(counterModule, 5);
  const before = engine.getStateHash();

  const wrongPlayer = engine.dispatch({ type: 'TICK', playerId: 'p2' });
  assert(!wrongPlayer.ok, 'wrong player must be rejected');

  const illegal = engine.dispatch({ type: 'NOPE', playerId: 'p1' });
  assert(!illegal.ok, 'unknown action must be rejected');

  assertEqual(engine.getStateHash(), before, 'rejected actions must not change state');
});

test('engine: deterministic replay reproduces the exact state hash', () => {
  const engine = new UniversalGameEngine(counterModule, 77);
  for (let i = 0; i < 12; i++) {
    const result = engine.dispatch({ type: 'TICK', playerId: 'p1' });
    assert(result.ok, `tick ${i} failed: ${result.error}`);
  }

  const liveHash = engine.getStateHash();
  const report = engine.verifyReplay();
  assert(report.ok, `replay must match (${report.errors.join(' | ')})`);
  assertEqual(report.actualHash, liveHash, 'replayed hash equals live hash');

  const exported = engine.exportLog();
  const clone = new UniversalGameEngine(counterModule, 1);
  const loadReport = clone.loadLog(exported);
  assert(loadReport.ok, 'loading an exported log must verify');
  assertEqual(clone.getStateHash(), liveHash, 'loaded state matches the source hash');
});

test('engine: time machine rewinds and replays forward', () => {
  const engine = new UniversalGameEngine(counterModule, 9);
  for (let i = 0; i < 6; i++) engine.dispatch({ type: 'TICK', playerId: 'p1' });
  const full = engine.getStateHash();

  engine.replayTo(2);
  assertEqual((engine.getRawState().globalVars.ticks as number), 2, 'rewind restores step 2');
  assertEqual(engine.getRawState().actionLog.length, 2, 'log is truncated');

  const report = engine.replayTo(6);
  assert(report.ok, 'forward replay succeeds');
  assertEqual(engine.getStateHash(), full, 'forward replay returns to the original hash');
});

/* -------------------------------------------------------------------------- */
