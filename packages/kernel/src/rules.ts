import {
  Action,
  ActionTransformation,
  ActiveRuleHook,
  GameState,
  HookId,
  HookStage,
  JsonRecord,
  VisibilityRule
} from './types';

/**
 * Runtime implementation of a rule hook (a "rule aspect").
 *
 * Implementations live in the game module's rule catalog — never inside the
 * game state. State only stores `ActiveRuleHook` descriptors (hookId + params),
 * which keeps the game state serializable and replayable.
 */
export interface RuleHookImpl {
  id: HookId;
  name: string;
  stage: HookStage;
  /** Higher priority runs first within a stage. */
  priority: number;
  description: string;
  /** Other hooks that must already be active before this one can be attached. */
  requires?: HookId[];
  predicate: (action: Action, state: GameState, ctx: HookContext) => boolean;
  handler: (action: Action, state: GameState, ctx: HookContext) => ActionTransformation;
}

export interface HookContext {
  impl: RuleHookImpl;
  instance: ActiveRuleHook;
  params: JsonRecord;
}

export interface ActivateHookOptions {
  ownerId?: string;
  sourceEntityId?: string;
  visibility?: VisibilityRule;
  params?: JsonRecord;
}

export class RuleRegistry {
  private readonly impls = new Map<HookId, RuleHookImpl>();

  constructor(impls: RuleHookImpl[] = []) {
    for (const impl of impls) this.register(impl);
  }

  public register(impl: RuleHookImpl): this {
    if (this.impls.has(impl.id)) {
      throw new Error(`Rule hook already registered: ${impl.id}`);
    }
    this.impls.set(impl.id, impl);
    return this;
  }

  public get(hookId: HookId): RuleHookImpl | undefined {
    return this.impls.get(hookId);
  }

  public require(hookId: HookId): RuleHookImpl {
    const impl = this.impls.get(hookId);
    if (!impl) throw new Error(`Unknown rule hook: ${hookId}`);
    return impl;
  }

  public has(hookId: HookId): boolean {
    return this.impls.has(hookId);
  }

  public all(): RuleHookImpl[] {
    return [...this.impls.values()];
  }

  public ids(): HookId[] {
    return [...this.impls.keys()];
  }

  /**
   * Validates the static hook dependency graph:
   *  - every `requires` id must be registered;
   *  - the graph must be acyclic.
   */
  public dependencyErrors(): string[] {
    const errors: string[] = [];
    const state = new Map<HookId, 'visiting' | 'done'>();

    for (const impl of this.impls.values()) {
      for (const dep of impl.requires ?? []) {
        if (!this.impls.has(dep)) errors.push(`${impl.id} requires unknown hook ${dep}`);
      }
    }

    const visit = (id: HookId, trail: HookId[]) => {
      const mark = state.get(id);
      if (mark === 'done') return;
      if (mark === 'visiting') {
        errors.push(`hook dependency cycle: ${[...trail, id].join(' -> ')}`);
        return;
      }
      state.set(id, 'visiting');
      const impl = this.impls.get(id);
      for (const dep of impl?.requires ?? []) {
        if (this.impls.has(dep)) visit(dep, [...trail, id]);
      }
      state.set(id, 'done');
    };

    for (const id of this.impls.keys()) visit(id, []);
    return [...new Set(errors)];
  }

  /**
   * Topologically sorts implementations (dependencies first), using priority
   * descending as the tie-breaker. Falls back to priority order when the graph
   * contains a cycle (callers should run dependencyErrors() first).
   */
  public order(impls: RuleHookImpl[]): RuleHookImpl[] {
    const byId = new Map(impls.map(impl => [impl.id, impl]));
    const remaining = new Set(byId.keys());
    const ordered: RuleHookImpl[] = [];

    while (remaining.size > 0) {
      const ready = [...remaining]
        .map(id => byId.get(id)!)
        .filter(impl => (impl.requires ?? []).every(dep => !remaining.has(dep)))
        .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

      if (ready.length === 0) {
        // cycle: degrade gracefully to priority order
        const fallback = [...remaining]
          .map(id => byId.get(id)!)
          .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
        ordered.push(...fallback);
        break;
      }

      ordered.push(...ready);
      ready.forEach(impl => {
        remaining.delete(impl.id);
      });
    }

    return ordered;
  }
}

/** Deterministic per-transition id factory (no Date.now / random in state). */
export class IdFactory {
  private counter = 0;

  constructor(private readonly prefix: string) {}

  public next(kind: string): string {
    this.counter += 1;
    return `${this.prefix}_${kind}_${this.counter.toString(36)}`;
  }
}
