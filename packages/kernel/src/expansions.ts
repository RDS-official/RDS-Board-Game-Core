import { GameExpansion, GameScenario } from './module';
import { GameState } from './types';

/**
 * Game expansion (DLC / rule pack) algebra.
 *
 * A game that ships optional content declares its packs as
 * `GameModule.expansions`; the kernel treats them as pure metadata only. This
 * module answers the three questions a UI, a lobby or a replay needs:
 *
 * 1. is this combination legal?      → `validateExpansionSelection`
 * 2. what does it actually enable?  → `resolveExpansions` (dependency closure)
 * 3. what do I call it in a replay? → `expansionScenarioId` / `deriveExpansionScenarios`
 *
 * Everything here is pure and deterministic: no `Date`, no `Math.random`, no
 * locale-sensitive sorting. A combination must map to the same scenario id on
 * every machine, or replays stop matching.
 *
 * The **record key** is the canonical expansion id. `GameExpansion.id` is the
 * same id written down for standalone use; when the two disagree the key wins,
 * because that is what `Record` lookup, dependency resolution and replay logs
 * all go through.
 */

export interface ExpansionSelection {
  enabled: string[];
}

/** `globalVars` key `stampExpansions` writes the enabled ids into. */
export const EXPANSIONS_GLOBAL_VAR = 'expansions';

/** Scenario id used for "no expansions enabled" (reserved, see below). */
export const BASE_SCENARIO_ID = 'base';

/**
 * Default safety ceiling for `deriveExpansionScenarios`.
 *
 * Six expansions (Sanguosha: base / military / wind / fire / forest / mountain
 * / 一将成名 …) already enumerate 2^6 = 64 subsets, which is exactly this cap.
 * Past it the caller should generate a scenario set from an explicit list
 * instead of asking for the full powerset.
 */
export const DEFAULT_MAX_COMBINATIONS = 64;

/**
 * Code-unit ordering — deliberately NOT `localeCompare`, whose result depends on
 * the host ICU build. Replay determinism requires the same order everywhere.
 */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Drop blanks, de-duplicate, sort. The canonical shape of any id list. */
function sortedUnique(ids: readonly string[] | undefined): string[] {
  return Array.from(new Set((ids ?? []).filter(id => typeof id === 'string' && id.length > 0))).sort(compareIds);
}

interface ClosureWalk {
  /** Every id reachable through `requires` that actually exists, sorted. */
  ids: string[];
  /** Referenced ids with no definition, sorted. */
  unknown: string[];
  /** One representative path per detected cycle, in discovery order. */
  cycles: string[][];
  /** dependent id → the dependency ids it asked for that do not exist. */
  missing: Map<string, string[]>;
}

/**
 * Walk `requires` edges from `seeds`.
 *
 * Deliberately total: it never throws, so both the validating (report) and the
 * resolving (throw) callers can share one traversal. Cycles are recorded rather
 * than followed, and a missing dependency is recorded against its dependent.
 */
function walkRequires(expansions: Record<string, GameExpansion>, seeds: readonly string[]): ClosureWalk {
  const visited = new Set<string>();
  const unknown = new Set<string>();
  const cycles: string[][] = [];
  const cycleKeys = new Set<string>();
  const missing = new Map<string, string[]>();
  const stack: string[] = [];

  const visit = (id: string): void => {
    if (stack.includes(id)) {
      // Back edge: the slice from the first occurrence to here is the cycle.
      const cycle = [...stack.slice(stack.indexOf(id)), id];
      // Canonical de-dup key: the member set, independent of entry point.
      const key = sortedUnique(cycle).join('+');
      if (!cycleKeys.has(key)) {
        cycleKeys.add(key);
        cycles.push(cycle);
      }
      return;
    }
    if (visited.has(id)) return;

    const expansion = expansions[id];
    if (!expansion) {
      unknown.add(id);
      return;
    }

    stack.push(id);
    for (const dependency of sortedUnique(expansion.requires)) {
      if (!expansions[dependency]) {
        // Recorded on the dependent so the error names both sides.
        missing.set(id, [...(missing.get(id) ?? []), dependency]);
      }
      visit(dependency);
    }
    stack.pop();
    visited.add(id);
  };

  for (const seed of sortedUnique(seeds)) visit(seed);

  return {
    ids: Array.from(visited).sort(compareIds),
    unknown: Array.from(unknown).sort(compareIds),
    cycles,
    missing
  };
}

/**
 * Check a selection for the four ways it can be wrong: an id nobody defines, a
 * dependency that is not pulled in, a pair that conflicts, and a definition that
 * points at itself (or loops).
 *
 * Validation runs over the **dependency closure**, not just the literal list, so
 * `{ military }` where military requires base is checked as `{ base, military }`
 * — a conflict declared on the required pack still fires.
 *
 * @returns error messages; an empty array means the selection is legal.
 */
export function validateExpansionSelection(
  expansions: Record<string, GameExpansion> | undefined,
  selected: readonly string[]
): string[] {
  const map = expansions ?? {};
  const requested = sortedUnique(selected);
  if (requested.length === 0) return [];

  const walk = walkRequires(map, requested);
  const enabled = new Set(walk.ids);
  const errors: string[] = [];

  // 1. Unknown ids: either selected directly, or required by a known expansion.
  for (const id of walk.unknown) {
    const dependents = walk.ids.filter(parent => (map[parent].requires ?? []).includes(id));
    errors.push(
      dependents.length > 0
        ? `expansion "${dependents.sort(compareIds).join('", "')}" requires unknown expansion "${id}"`
        : `unknown expansion "${id}"`
    );
  }

  // 2. Cycles. A one-member loop is reported by the self-reference check below
  //    as "requires itself", so it is not repeated here as a cycle.
  for (const cycle of walk.cycles) {
    if (new Set(cycle).size < 2) continue;
    errors.push(`circular expansion dependency: ${cycle.join(' -> ')}`);
  }

  // 3. Definitions that reference themselves. Scoped to enabled packs, so an
  //    unrelated broken definition cannot fail an otherwise fine selection.
  for (const id of walk.ids) {
    const expansion = map[id];
    if ((expansion.requires ?? []).includes(id)) errors.push(`expansion "${id}" requires itself`);
    if ((expansion.conflicts ?? []).includes(id)) errors.push(`expansion "${id}" conflicts with itself`);
  }

  // 4. Conflicts inside the closure. A conflict with a pack that is not enabled
  //    is harmless, so only enabled pairs are reported; each pair once.
  const reportedPairs = new Set<string>();
  for (const id of walk.ids) {
    for (const other of sortedUnique(map[id].conflicts)) {
      if (other === id || !enabled.has(other)) continue;
      const key = [id, other].sort(compareIds).join('|');
      if (reportedPairs.has(key)) continue;
      reportedPairs.add(key);
      errors.push(`expansions "${id}" and "${other}" conflict and cannot be enabled together`);
    }
  }

  return errors;
}

/**
 * Expand a selection through its `requires` edges.
 *
 * @returns the enabled ids **including** every required pack, sorted by code
 * unit so the same input always yields the same list (and therefore the same
 * scenario id and state hash).
 * @throws when the selection references an unknown id or contains a dependency
 * cycle — there is no sensible list to return in either case. Use
 * `validateExpansionSelection` first when you want the errors instead.
 */
export function resolveExpansions(
  expansions: Record<string, GameExpansion> | undefined,
  selected: readonly string[]
): string[] {
  const map = expansions ?? {};
  const walk = walkRequires(map, selected);

  if (walk.cycles.length > 0) {
    throw new Error(`Cannot resolve expansions: circular dependency ${walk.cycles.map(c => c.join(' -> ')).join('; ')}`);
  }
  if (walk.unknown.length > 0) {
    const unknownSet = new Set(walk.unknown);
    const problems: string[] = [];
    for (const parent of walk.ids) {
      for (const dependency of walk.missing.get(parent) ?? []) {
        if (unknownSet.has(dependency)) problems.push(`"${parent}" requires unknown expansion "${dependency}"`);
        unknownSet.delete(dependency);
      }
    }
    for (const id of walk.unknown) {
      if (unknownSet.has(id)) problems.push(`unknown expansion "${id}"`);
    }
    throw new Error(`Cannot resolve expansions: ${problems.join('; ')}`);
  }

  return walk.ids;
}

/**
 * The selection a fresh table gets when the player does not choose.
 *
 * Defaults are dependency-closed, so `base` is included automatically when a
 * default pack requires it. The walk is non-throwing: a default that points at
 * an undefined pack simply contributes what exists. Pass the result through
 * `validateExpansionSelection` if you need that reported.
 */
export function defaultExpansions(expansions: Record<string, GameExpansion> | undefined): string[] {
  const map = expansions ?? {};
  const seeds = Object.keys(map)
    .filter(id => map[id]?.defaultEnabled === true)
    .sort(compareIds);
  if (seeds.length === 0) return [];
  return walkRequires(map, seeds).ids;
}

/**
 * Derive the stable, human-readable scenario id for a combination.
 *
 * `[]` → `'base'`, `['military']` → `'military'`,
 * `['military', 'wind']` → `'military+wind'`. Input order is irrelevant; the
 * output is sorted and de-duplicated, which is what makes it safe to key a
 * replay log on.
 *
 * `'base'` is reserved for the empty combination, so an expansion may not be
 * called `base` and ids must not contain `'+'` (the separator);
 * `deriveExpansionScenarios` rejects such a module rather than emit an
 * ambiguous key.
 */
export function expansionScenarioId(enabled: readonly string[]): string {
  const ids = sortedUnique(enabled);
  return ids.length === 0 ? BASE_SCENARIO_ID : ids.join('+');
}

/** Reasons an expansion id cannot be used as a scenario key. */
function expansionIdProblems(ids: readonly string[]): string[] {
  const problems: string[] = [];
  for (const id of ids) {
    if (id === BASE_SCENARIO_ID) {
      problems.push(
        `expansion id "${id}" is reserved: "${BASE_SCENARIO_ID}" is the scenario id of the empty combination`
      );
    }
    if (id.includes('+')) {
      problems.push(`expansion id "${id}" contains "+", which is the combination separator`);
    }
  }
  return problems;
}

export interface DeriveExpansionOptions {
  /**
   * Refuse to enumerate more than this many candidate combinations. Guards
   * against a module quietly declaring a dozen packs and asking for 4096
   * scenarios. Defaults to `DEFAULT_MAX_COMBINATIONS`.
   */
  maxCombinations?: number;
  /** Description used for the `'base'` scenario. Defaults to `'基础游戏'`. */
  baseDescription?: string;
}

/**
 * Derive one `GameScenario` per **legal, dependency-closed** expansion
 * combination, so a fixed log of `?scenario=base+military` keeps replaying
 * exactly the same table forever.
 *
 * Only closed combinations are emitted: a subset whose closure pulls in more
 * packs is skipped, because it would otherwise produce the same setup under
 * two different ids (`{military}` and `{base, military}`). This keeps the
 * invariant *scenario id ↔ enabled set* a bijection, which is what the replay
 * log relies on.
 *
 * The empty combination always yields `'base'`.
 *
 * @param setup called with the sorted, resolved id list to build the position.
 * Its result must stay JSON-serializable, like any other `GameState`.
 * @throws when the powerset (2^n) exceeds `maxCombinations`.
 */
export function deriveExpansionScenarios(
  expansions: Record<string, GameExpansion> | undefined,
  setup: (enabled: string[]) => GameState,
  options: DeriveExpansionOptions = {}
): Record<string, GameScenario> {
  const map = expansions ?? {};
  const ids = Object.keys(map).sort(compareIds);
  const max = options.maxCombinations ?? DEFAULT_MAX_COMBINATIONS;

  // A module whose ids collide with the scenario id grammar would produce two
  // different combinations under one key, so a log could not tell them apart.
  const idProblems = expansionIdProblems(ids);
  if (idProblems.length > 0) {
    throw new Error(`deriveExpansionScenarios: ${idProblems.join('; ')}`);
  }

  if (!Number.isFinite(max) || max < 1) {
    throw new Error(`deriveExpansionScenarios: maxCombinations must be a positive integer, got ${String(max)}`);
  }

  const total = 2 ** ids.length;
  if (total > max) {
    throw new Error(
      `deriveExpansionScenarios: ${ids.length} expansions enumerate ${total} combinations, ` +
        `which exceeds maxCombinations (${max}). Pass a larger maxCombinations or derive a curated subset.`
    );
  }

  const derived: Record<string, GameScenario> = {};

  for (let mask = 0; mask < total; mask += 1) {
    // No bitmask: `1 << index` wraps past 31 packs, and a caller may legitimately
    // raise the budget. String keys are exact for any count.
    const subset = ids.filter((_, index) => Math.floor(mask / 2 ** index) % 2 === 1);

    // A closed subset resolves to itself; anything else is represented by the
    // superset that closes it, so it must not get an id of its own.
    let resolved: string[];
    try {
      resolved = resolveExpansions(map, subset);
    } catch {
      continue;
    }
    if (resolved.length !== subset.length) continue;
    if (validateExpansionSelection(map, subset).length > 0) continue;

    const id = expansionScenarioId(subset);
    if (derived[id]) continue;

    const names = subset.map(expansionId => map[expansionId].name || expansionId);
    derived[id] = {
      description: names.length > 0 ? names.join(' · ') : options.baseDescription ?? '基础游戏',
      setup: seed => setup([...subset])
    };
  }

  // Same key order on every machine, so a scenario dropdown is stable too.
  const ordered: Record<string, GameScenario> = {};
  for (const id of Object.keys(derived).sort(compareIds)) ordered[id] = derived[id];
  return ordered;
}

/**
 * Record the enabled expansion ids on a state, for replays and the UI.
 *
 * Returned as a **new** state: the kernel never mutates a position in place, and
 * this stays pure so it can be called from a scenario `setup`.
 *
 * Stamping is opt-in rather than done inside every `setup`, so adding this
 * contract changes no existing game's behaviour or state hash.
 */
export function stampExpansions(state: GameState, enabled: readonly string[]): GameState {
  return {
    ...state,
    globalVars: { ...state.globalVars, [EXPANSIONS_GLOBAL_VAR]: sortedUnique(enabled) }
  };
}

/** Read the ids `stampExpansions` wrote; `[]` when the state predates them. */
export function expansionsOf(state: GameState): string[] {
  const stamped = state.globalVars?.[EXPANSIONS_GLOBAL_VAR];
  return Array.isArray(stamped) ? sortedUnique(stamped as string[]) : [];
}
