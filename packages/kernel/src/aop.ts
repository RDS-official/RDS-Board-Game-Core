import { ActiveRuleHook, Action, ActionTransformation, GameState, HookId, HookStage } from './types';
import { ActivateHookOptions, HookContext, RuleRegistry } from './rules';

export interface PipelineExecutionResult {
  finalAction: Action;
  cancelled: boolean;
  intercepted: boolean;
  followUpActions: Action[];
  messages: string[];
}

export interface AfterTriggerResult {
  chainedActions: Action[];
  messages: string[];
}

/**
 * AOP onion pipeline over the active rule hooks of the current state.
 *
 * Stage order:
 *   FILTER_MODIFY  → mutate action constants (discounts, damage bonuses)
 *   BEFORE_REPLACE → cancel or replace the action (armor, skill interception)
 *   AFTER_TRIGGER  → chain follow-up actions after resolution
 *
 * Implementations are looked up by `hookId` in the module's RuleRegistry, so
 * `GameState.activeHooks` stays plain data.
 */
export class RulePipeline {
  constructor(private readonly rules: RuleRegistry) {}

  /** Attach a hook instance to the state (hot-injection). */
  public activate(
    state: GameState,
    hookId: HookId,
    instanceId: string,
    options: ActivateHookOptions = {}
  ): GameState {
    const impl = this.rules.require(hookId);
    for (const dependency of impl.requires ?? []) {
      if (!state.activeHooks.some(h => h.hookId === dependency)) {
        throw new Error(`Cannot activate ${hookId}: required hook ${dependency} is not active`);
      }
    }
    if (state.activeHooks.some(h => h.instanceId === instanceId)) {
      throw new Error(`Hook instance already active: ${instanceId}`);
    }

    const instance: ActiveRuleHook = {
      instanceId,
      hookId,
      ownerId: options.ownerId,
      sourceEntityId: options.sourceEntityId,
      visibility: options.visibility ?? { type: 'PUBLIC' },
      params: options.params ?? {}
    };

    return { ...state, activeHooks: [...state.activeHooks, instance] };
  }

  public deactivate(state: GameState, instanceId: string): GameState {
    return { ...state, activeHooks: state.activeHooks.filter(h => h.instanceId !== instanceId) };
  }

  private ordered(state: GameState, stage: HookStage): {
    instance: ActiveRuleHook;
    ctx: HookContext;
  }[] {
    const activeImpls = state.activeHooks
      .map(instance => this.rules.get(instance.hookId))
      .filter((impl): impl is NonNullable<typeof impl> => !!impl);

    const rank = new Map<HookId, number>();
    this.rules.order(activeImpls).forEach((impl, index) => {
      rank.set(impl.id, index);
    });

    const out: { instance: ActiveRuleHook; ctx: HookContext }[] = [];

    for (const instance of state.activeHooks) {
      const impl = this.rules.get(instance.hookId);
      if (!impl || impl.stage !== stage) continue;
      out.push({ instance, ctx: { impl, instance, params: instance.params ?? {} } });
    }

    out.sort((a, b) => (rank.get(a.ctx.impl.id) ?? 0) - (rank.get(b.ctx.impl.id) ?? 0));
    return out;
  }

  public processAction(action: Action, state: GameState): PipelineExecutionResult {
    let currentAction: Action = { ...action };
    const followUpActions: Action[] = [];
    const messages: string[] = [];

    // Stage 1 — FILTER_MODIFY
    for (const { ctx } of this.ordered(state, 'FILTER_MODIFY')) {
      if (!this.safePredicate(ctx.impl.predicate, currentAction, state, ctx, messages)) continue;
      const transformation = this.safeHandler(ctx.impl.handler, currentAction, state, ctx, messages);
      if (!transformation) continue;

      if (transformation.type === 'MODIFY' && transformation.modifiedAction) {
        currentAction = transformation.modifiedAction;
      }
      if (transformation.type === 'CANCEL') {
        messages.push(`[${ctx.impl.name}] cancelled`);
        return { finalAction: currentAction, cancelled: true, intercepted: true, followUpActions, messages };
      }
      if (transformation.followUpActions) followUpActions.push(...transformation.followUpActions);
      if (transformation.message) messages.push(`[${ctx.impl.name}] ${transformation.message}`);
    }

    // Stage 2 — BEFORE_REPLACE
    for (const { ctx } of this.ordered(state, 'BEFORE_REPLACE')) {
      if (!this.safePredicate(ctx.impl.predicate, currentAction, state, ctx, messages)) continue;
      const transformation = this.safeHandler(ctx.impl.handler, currentAction, state, ctx, messages);
      if (!transformation) continue;

      if (transformation.type === 'CANCEL') {
        messages.push(`[${ctx.impl.name}] ${transformation.message ?? 'cancelled'}`);
        return { finalAction: currentAction, cancelled: true, intercepted: true, followUpActions, messages };
      }
      if (transformation.type === 'REPLACE' && transformation.modifiedAction) {
        messages.push(`[${ctx.impl.name}] ${transformation.message ?? 'replaced action'}`);
        return {
          finalAction: transformation.modifiedAction,
          cancelled: false,
          intercepted: true,
          followUpActions: [...followUpActions, ...(transformation.followUpActions ?? [])],
          messages
        };
      }
      if (transformation.followUpActions) followUpActions.push(...transformation.followUpActions);
      if (transformation.message) messages.push(`[${ctx.impl.name}] ${transformation.message}`);
    }

    return { finalAction: currentAction, cancelled: false, intercepted: false, followUpActions, messages };
  }

  public triggerAfter(action: Action, state: GameState): AfterTriggerResult {
    const chainedActions: Action[] = [];
    const messages: string[] = [];

    for (const { ctx } of this.ordered(state, 'AFTER_TRIGGER')) {
      if (!this.safePredicate(ctx.impl.predicate, action, state, ctx, messages)) continue;
      const transformation = this.safeHandler(ctx.impl.handler, action, state, ctx, messages);
      if (!transformation) continue;

      if (transformation.followUpActions) chainedActions.push(...transformation.followUpActions);
      if (transformation.message) messages.push(`[${ctx.impl.name}] ${transformation.message}`);
    }

    return { chainedActions, messages };
  }

  private safePredicate(
    predicate: HookContext['impl']['predicate'],
    action: Action,
    state: GameState,
    ctx: HookContext,
    messages: string[]
  ): boolean {
    try {
      return predicate(action, state, ctx);
    } catch (err) {
      messages.push(`[${ctx.impl.id}] predicate threw: ${(err as Error).message}`);
      return false;
    }
  }

  private safeHandler(
    handler: HookContext['impl']['handler'],
    action: Action,
    state: GameState,
    ctx: HookContext,
    messages: string[]
  ): ActionTransformation | null {
    try {
      return handler(action, state, ctx);
    } catch (err) {
      messages.push(`[${ctx.impl.id}] handler threw: ${(err as Error).message}`);
      return null;
    }
  }
}
