import { RulePipeline } from './aop';
import {
  evaluateWindow,
  orderedSubmissions,
  projectDecision,
  resolveDecision,
  submitDecision,
  topDecision
} from './decisions';
import { checkInvariants, KernelInvariantError } from './invariants';
import { MapGraphManager } from './graph';
import { GameModule, ReduceContext, SpatialQuery } from './module';
import { CognitiveObserver, ProjectionRedactor } from './observer';
import { RuleRegistry } from './rules';
import { DeterministicPRNG } from './prng';
import { canonicalize, hashState } from './serialize';
import { InterruptStackManager } from './stack';
import { validateActionShape } from './validation';
import {
  Action,
  ActorId,
  DecisionWindow,
  DispatchResult,
  GameState,
  Npc,
  NodeId,
  Player,
  PlayerId,
  ProjectedGameState,
  SelectionCandidate,
  SelectionSpec,
  StackFrame,
  SYSTEM_ACTOR,
  VisualEventType,
  VisualTraceEvent
} from './types';

export interface EngineOptions {
  /** Reject illegal actions and validate state invariants after every transition. */
  strict?: boolean;
  /** Named scenario from module.scenarios; replayable and serialized in logs. */
  scenario?: string;
}

export interface ReplayReport {
  ok: boolean;
  expectedHash: string;
  actualHash: string;
  steps: number;
  errors: string[];
}

export interface ExportedLog {
  moduleId: string;
  seed: number;
  scenario?: string;
  actions: Action[];
  stateHash: string;
  /** Absent on legacy logs; current logs always write both. */
  schemaVersion?: number;
  engineVersion?: number;
}

/** Bump when scheduling/legality semantics change; logs are rejected, not migrated. */
export const ENGINE_VERSION = 3;

/**
 * Deterministic, observable, replayable kernel.
 *
 * s_{t+1} = T_{K_t}(s_t, a_t) is applied through a single pipeline:
 *   validate → decision window → response window → AOP → reduce → outcome → log
 */
export class UniversalGameEngine {
  private readonly module: GameModule;
  private readonly rules: RuleRegistry;
  private readonly pipeline: RulePipeline;
  private readonly strict: boolean;
  private readonly projectRedactor: ProjectionRedactor;

  private state: GameState;
  private scenario?: string;
  /** Full accepted action history (survives time-machine rewinds). */
  private history: Action[] = [];
  private currentViewer: PlayerId | 'GOD' = 'GOD';
  /** Optional per-room secret; when set, hidden-entity aliases become HMAC-keyed (S5). */
  private aliasSecret?: string;
  private silent = false;

  private visualListeners: ((events: VisualTraceEvent[]) => void)[] = [];
  private stateChangeListeners: ((state: ProjectedGameState) => void)[] = [];

  constructor(module: GameModule, seed = 42, options: EngineOptions = {}) {
    this.module = module;
    this.rules = new RuleRegistry(module.hooks);
    this.pipeline = new RulePipeline(this.rules);
    this.strict = options.strict ?? true;
    this.projectRedactor = module.project ?? {};
    this.scenario = options.scenario;

    const initial = this.initialState(seed, options.scenario);
    this.state = { ...initial, seed, seq: 0, clock: initial.clock ?? 0, gameId: module.meta.id };

    const dependencyErrors = this.rules.dependencyErrors();
    if (dependencyErrors.length > 0) {
      throw new Error(`Invalid rule dependency graph: ${dependencyErrors.join('; ')}`);
    }

    if (this.strict) this.validateInitialState();
  }
  private initialState(seed: number, scenario?: string): GameState {
    if (!scenario) return this.module.setup(seed);
    const factory = this.module.scenarios?.[scenario];
    if (!factory) {
      throw new Error(`Unknown scenario "${scenario}" for game ${this.module.meta.id}`);
    }
    return factory.setup(seed);
  }

  /* ------------------------------------------------------------------ */
  /* Introspection                                                       */
  /* ------------------------------------------------------------------ */

  public getModule(): GameModule {
    return this.module;
  }

  public getScenario(): string | undefined {
    return this.scenario;
  }

  public getRules(): RuleRegistry {
    return this.rules;
  }

  public getRawState(): GameState {
    return this.state;
  }

  public getSeed(): number {
    return this.state.seed;
  }

  /** Full accepted action history (cursor-independent). */
  public getHistory(): Action[] {
    return [...this.history];
  }

  public getStateHash(): string {
    return hashState(this.state);
  }

  public getViewer(): PlayerId | 'GOD' {
    return this.currentViewer;
  }

  /** Per-room random secret for HMAC virtual aliases (REVIEW.md S5); never serialized. */
  public setAliasSecret(secret: string): void {
    this.aliasSecret = secret;
  }

  public setViewer(viewer: PlayerId | 'GOD'): void {
    this.currentViewer = viewer;
    this.notifyStateChange();
  }

  public getProjectedState(): ProjectedGameState {
    return this.getProjectedStateFor(this.currentViewer);
  }

  /** Project for an arbitrary viewer without changing the engine's own view. */
  public getProjectedStateFor(viewer: PlayerId | 'GOD'): ProjectedGameState {
    return CognitiveObserver.projectState(
      this.state,
      viewer,
      (s, p) => this.legalActionsFor(s, p),
      this.projectRedactor,
      this.aliasSecret
    );
  }

  public getActiveActorId(): ActorId {
    return this.state.activeActorId ?? this.state.activePlayerId;
  }

  public getActor(actorId: ActorId): Player | Npc | undefined {
    return this.state.players[actorId] ?? this.state.npcs?.[actorId];
  }

  public getActorName(actorId: ActorId): string {
    return this.getActor(actorId)?.name ?? actorId;
  }

  public getSpatialQuery(): SpatialQuery | undefined {
    return this.module.spatial;
  }

  public getSpatialNeighbors(nodeId: NodeId, actorId?: ActorId): NodeId[] {
    return this.module.spatial?.neighbors(this.state, nodeId, actorId) ?? MapGraphManager.neighborsOf(this.state.mapGraph, nodeId);
  }

  public getSpatialFloor(nodeId: NodeId): string | undefined {
    if (this.module.spatial?.floorAt) return this.module.spatial.floorAt(this.state, nodeId);
    const node = this.state.mapGraph.nodes[nodeId];
    return node?.layer ?? (node?.props?.floor as string | undefined);
  }

  public getSpatialDistance(from: NodeId, to: NodeId, actorId?: ActorId): number {
    if (this.module.spatial?.distance) return this.module.spatial.distance(this.state, from, to, actorId);
    return this.defaultSpatialDistance(from, to, actorId);
  }

  public getSpatialReachable(from: NodeId, budget: number, actorId?: ActorId): Map<NodeId, number> {
    if (this.module.spatial?.reachable) return this.module.spatial.reachable(this.state, from, budget, actorId);
    return this.defaultSpatialReachable(from, budget, actorId);
  }

  public getLineOfSight(from: NodeId, to: NodeId): boolean {
    return this.module.spatial?.lineOfSight?.(this.state, from, to) ?? false;
  }

  private defaultSpatialDistance(from: NodeId, to: NodeId, actorId?: ActorId): number {
    return this.defaultSpatialReachable(from, Infinity, actorId).get(to) ?? Infinity;
  }

  private defaultSpatialReachable(from: NodeId, budget: number, actorId?: ActorId): Map<NodeId, number> {
    const distances = new Map<NodeId, number>();
    if (!this.state.mapGraph.nodes[from]) return distances;
    const graphAdjacency = MapGraphManager.adjacencyList(this.state.mapGraph);
    distances.set(from, 0);
    const queue: NodeId[] = [from];
    while (queue.length > 0) {
      queue.sort((a, b) => (distances.get(a) ?? 0) - (distances.get(b) ?? 0));
      const current = queue.shift()!;
      const currentCost = distances.get(current)!;
      for (const to of this.getSpatialNeighbors(current, actorId)) {
        const edgeCost = graphAdjacency.get(current)?.find(entry => entry.to === to)?.cost ?? 1;
        const step = this.module.spatial
          ? this.module.spatial.cost(this.state, current, to, actorId)
          : edgeCost;
        if (!Number.isFinite(step) || step <= 0) continue;
        const next = currentCost + step;
        if (next > budget) continue;
        if (next < (distances.get(to) ?? Infinity)) {
          distances.set(to, next);
          queue.push(to);
        }
      }
    }
    return distances;
  }

  /** Focus set P(s): whoever must act now (players and NPCs). */
  public getFocusActors(): ActorId[] {
    const decision = topDecision(this.state);
    if (decision && decision.status === 'OPEN') {
      return decision.participants.filter(pid => decision.submissions[pid] === undefined);
    }

    const frame = InterruptStackManager.peek(this.state);
    if (frame && frame.status === 'WAITING_INPUT' && frame.responseWindow) {
      const eligible = frame.responseWindow.eligibleActors ?? frame.responseWindow.eligiblePlayers;
      return eligible.filter(
        pid => !frame.responseWindow!.pendingResponses[pid] || frame.responseWindow!.pendingResponses[pid] === 'PENDING'
      );
    }

    return this.state.gameOver ? [] : [this.getActiveActorId()];
  }

  /** Backwards-compatible player-only focus. */
  public getFocusPlayers(): PlayerId[] {
    return this.getFocusActors().filter(id => !!this.state.players[id]);
  }

  public getLegalActions(actorId: ActorId): Action[] {
    return this.legalActionsFor(this.state, actorId);
  }

  private legalActionsFor(state: GameState, actorId: ActorId): Action[] {
    if (state.gameOver || !this.getActor(actorId)) return [];

    const decision = topDecision(state);
    if (decision && decision.status === 'OPEN' && decision.participants.includes(actorId)) {
      if (decision.submissions[actorId] !== undefined) return [];
      return this.module.legalActions(state, actorId);
    }

    return this.module.legalActions(state, actorId);
  }

  /* ------------------------------------------------------------------ */
  /* Events                                                              */
  /* ------------------------------------------------------------------ */

  public onVisualEvent(listener: (events: VisualTraceEvent[]) => void): () => void {
    this.visualListeners.push(listener);
    return () => {
      this.visualListeners = this.visualListeners.filter(l => l !== listener);
    };
  }

  public onStateChange(listener: (state: ProjectedGameState) => void): () => void {
    this.stateChangeListeners.push(listener);
    return () => {
      this.stateChangeListeners = this.stateChangeListeners.filter(l => l !== listener);
    };
  }

  private emitVisual(events: VisualTraceEvent[]): void {
    if (this.silent || events.length === 0) return;
    this.visualListeners.forEach(listener => listener(events));
  }

  private notifyStateChange(): void {
    if (this.silent) return;
    const projected = this.getProjectedState();
    this.stateChangeListeners.forEach(listener => listener(projected));
  }

  /* ------------------------------------------------------------------ */
  /* Dispatch                                                            */
  /* ------------------------------------------------------------------ */

  public dispatch(action: Action): DispatchResult {
    return this.run(action);
  }

  private fail(error: string, events: VisualTraceEvent[] = []): DispatchResult {
    return { ok: false, error, events, stateHash: this.getStateHash() };
  }

  private run(action: Action): DispatchResult {
    const events: VisualTraceEvent[] = [];

    if (this.state.gameOver) return this.fail('game is over');
    if (!action || typeof action.type !== 'string') return this.fail('malformed action');

    // Kernel control action: advance the logical clock (deterministic timeouts).
    if (action.type === '__TICK__') {
      return this.advanceClock(Number((action.payload as { ticks?: number } | undefined)?.ticks ?? 1));
    }

    const actorId = this.actorIdOf(action);
    const actor = this.getActor(actorId);
    if (!actor) {
      return this.fail(`unknown actor: ${actorId}`);
    }
    if (
      'kind' in actor &&
      actor.kind === 'NPC' &&
      actor.controllerId &&
      this.currentViewer !== 'GOD' &&
      this.currentViewer !== actor.controllerId
    ) {
      return this.fail(`viewer ${this.currentViewer} cannot control NPC ${actorId}`);
    }

    const shapeErrors = validateActionShape(action, this.module.actionSchemas ?? {});
    if (shapeErrors.length > 0) {
      return this.fail(`invalid action shape — ${shapeErrors.join('; ')}`);
    }

    const payloadErrors = this.module.validatePayload?.(
      this.state,
      action,
      (action.payload as Record<string, unknown> | undefined) ?? {}
    ) ?? [];
    if (payloadErrors.length > 0) {
      return this.fail(`invalid payload — ${payloadErrors.join('; ')}`);
    }

    // Dispatching after a rewind forks the timeline: drop the abandoned future.
    if (this.history.length !== this.state.actionLog.length) {
      this.history = this.history.slice(0, this.state.actionLog.length);
    }

    // 1. Secret / simultaneous decision window
    const decision = topDecision(this.state);
    if (decision && decision.status === 'OPEN' && decision.participants.includes(actorId)) {
      return this.commitDecision(decision, action, events);
    }

    // 2. Interrupt-stack response window
    const frame = InterruptStackManager.peek(this.state);
    if (
      frame &&
      frame.status === 'WAITING_INPUT' &&
      (frame.responseWindow?.eligibleActors ?? frame.responseWindow?.eligiblePlayers ?? []).includes(actorId)
    ) {
      return this.resolveResponse(action, frame, events);
    }

    // 3. Regular turn action
    if (this.strict && !this.isLegal(action)) {
      return this.fail(`illegal action "${action.type}" for ${actorId} in phase ${this.state.phase}`);
    }

    return this.applyCore(action, events);
  }

  private actorIdOf(action: Action): ActorId {
    return action.actorId ?? action.playerId;
  }

  public getSelectionCandidates(actorId: ActorId, spec: SelectionSpec): SelectionCandidate[] {
    if (this.module.resolveSelection) {
      return this.module.resolveSelection(this.state, actorId, spec);
    }
    return this.defaultSelectionCandidates(actorId, spec);
  }

  private defaultSelectionCandidates(actorId: ActorId, spec: SelectionSpec): SelectionCandidate[] {
    const projected = this.getProjectedState();
    switch (spec.source) {
      case 'node':
      case 'room':
        return Object.values(projected.mapGraph.nodes)
          .filter(node => (spec.source === 'room' ? node.type === 'ROOM' : true))
          .map(node => ({ id: node.id, label: String(node.props?.name ?? node.id) }));
      case 'edge':
        return Object.values(projected.mapGraph.edges).map(edge => ({ id: edge.id, label: edge.id }));
      case 'entity':
        return Object.values(projected.entities)
          .filter((entity): entity is typeof entity & { id: string } => !!entity.id && !entity.isMasked)
          .map(entity => ({
            id: entity.id,
            label: entity.components?.cardFace?.title ?? entity.id
          }));
      case 'actor':
      case 'player':
        return [
          ...(projected.playerOrder ?? []).map(id => ({ id, label: projected.players[id]?.name ?? id })),
          ...Object.values(projected.npcs ?? {})
            .filter((npc): npc is typeof npc & { id: string } => !!npc.id)
            .map(npc => ({ id: npc.id, label: npc.name }))
        ];
      case 'zone':
        return Object.values(projected.zones).map(zone => ({ id: zone.id, label: zone.name }));
      case 'hand': {
        if (this.currentViewer !== 'GOD' && this.currentViewer !== actorId) return [];
        const zone = projected.zones[`zone_hand_${actorId}`];
        return (zone?.orderedEntities ?? [])
          .map(id => projected.entities[id])
          .filter((entity): entity is NonNullable<typeof entity> & { id: string } => !!entity?.id && !entity.isMasked)
          .map(entity => ({
            id: entity.id,
            label: entity.components?.cardFace?.title ?? entity.id
          }));
      }
      case 'deck':
        return [];
      default:
        return [];
    }
  }

  private isLegal(action: Action): boolean {
    const actorId = this.actorIdOf(action);
    const legal = this.module.legalActions(this.state, actorId);
    const key = canonicalize(action);
    return legal.some(candidate => {
      if (canonicalize(candidate) === key) return true;
      if (!this.sameBinding(candidate, action)) return false;
      if ((candidate.fields?.length ?? 0) > 0) return true;
      if (candidate.selection) return this.validateSelection(candidate, action);
      return false;
    });
  }

  private validateSelection(candidate: Action, action: Action): boolean {
    const spec = candidate.selection;
    if (!spec) return false;
    const targets = action.targets ?? [];
    if (!Array.isArray(targets)) return false;
    if (spec.distinct !== false && new Set(targets).size !== targets.length) return false;
    if (targets.length < spec.min || targets.length > spec.max) return false;
    if (this.module.validateSelection) {
      return this.module.validateSelection(this.state, candidate, targets, this.actorIdOf(action)).length === 0;
    }
    const allowed = new Set(this.getSelectionCandidates(this.actorIdOf(action), spec).map(entry => entry.id));
    return targets.every(target => allowed.has(target));
  }

  /**
   * Field-form actions carry their parameter schema in `fields`; the concrete
   * payload is supplied by the UI (or a bot) later, so legality compares the
   * action binding and lets action-schema validation check the payload.
   */
  private sameBinding(a: Action, b: Action): boolean {
    return (
      a.type === b.type &&
      this.actorIdOf(a) === this.actorIdOf(b) &&
      a.entityId === b.entityId &&
      a.fromZoneId === b.fromZoneId &&
      a.toZoneId === b.toZoneId &&
      a.targetNodeId === b.targetNodeId &&
      a.targetEdgeId === b.targetEdgeId &&
      a.targetPlayerId === b.targetPlayerId
    );
  }

  /** AOP + reduce + after-triggers + follow-ups. No logging, no notify. */
  private reduceWithPipeline(
    state: GameState,
    action: Action,
    ctx: ReduceContext,
    events: VisualTraceEvent[],
    depth = 0
  ): { state: GameState; cancelled: boolean } {
    if (depth > 8) {
      events.push(this.event(ctx, 'STACK_CANCEL', 'Follow-up chain depth exceeded', 200));
      return { state, cancelled: true };
    }

    const result = this.pipeline.processAction(action, state);
    for (const message of result.messages) {
      events.push(this.event(ctx, 'RULE_MUTATE', message, 300));
    }

    if (result.cancelled) {
      events.push(this.event(ctx, 'STACK_CANCEL', `${action.type} cancelled by rule hook`, 300));
      return { state, cancelled: true };
    }

    let next = this.module.reduce(state, result.finalAction, ctx);

    const after = this.pipeline.triggerAfter(result.finalAction, next);
    for (const message of after.messages) {
      events.push(this.event(ctx, 'RULE_MUTATE', message, 300));
    }

    const chained = [...result.followUpActions, ...after.chainedActions];
    for (const followUp of chained) {
      const chainedResult = this.reduceWithPipeline(next, followUp, ctx, events, depth + 1);
      next = chainedResult.state;
    }

    return { state: next, cancelled: false };
  }

  private makeContext(nextSeq: number, events: VisualTraceEvent[]): ReduceContext {
    let counter = 0;
    return {
      seq: nextSeq,
      id: (kind: string) => `${kind}_s${nextSeq}_${(++counter).toString(36)}`,
      trace: event => events.push(event),
      roll: (spec, seed) => {
        const roll = DeterministicPRNG.rollFaces(seed, spec);
        return {
          result: { spec, rolls: roll.rolls, total: roll.sum },
          nextSeed: roll.nextSeed
        };
      }
    };
  }

  private applyCore(action: Action, events: VisualTraceEvent[]): DispatchResult {
    const seq = this.state.seq + 1;
    const ctx = this.makeContext(seq, events);

    const { state: reduced, cancelled } = this.reduceWithPipeline(this.state, action, ctx, events);
    if (cancelled) {
      // Intercepted actions do not advance the transition counter and are not
      // logged, so replay stays aligned with the live state.
      this.emitVisual(events);
      this.notifyStateChange();
      return { ok: true, events, stateHash: this.getStateHash(), action };
    }

    const finalized = this.finalizeTransition(reduced, seq, action, events, ctx);
    if (!finalized.ok) return finalized.result;
    this.history.push(action);
    return { ok: true, events, stateHash: this.getStateHash(), action };
  }

  /** Attach default logical-clock deadlines to open decisions / response windows. */
  private stampDeadlines(state: GameState): GameState {
    const decisionTtl = this.module.timing?.decision ?? 8;
    const responseTtl = this.module.timing?.response ?? 8;
    let changed = false;

    const pendingDecisions = state.pendingDecisions.map(window => {
      if (window.status === 'OPEN' && window.deadline === undefined) {
        changed = true;
        return { ...window, deadline: state.clock + decisionTtl };
      }
      return window;
    });

    const interruptStack = state.interruptStack.map(frame => {
      if (frame.status === 'WAITING_INPUT' && frame.responseWindow && frame.responseWindow.deadline === undefined) {
        changed = true;
        return {
          ...frame,
          responseWindow: { ...frame.responseWindow, deadline: state.clock + responseTtl }
        };
      }
      return frame;
    });

    return changed ? { ...state, pendingDecisions, interruptStack } : state;
  }

  /**
   * Advance the logical clock and deterministically time out expired windows.
   * The tick itself is an action in the log, so replay reproduces timeouts
   * without relying on wall-clock timers.
   */
  private advanceClock(rawTicks: number): DispatchResult {
    const ticks = Math.max(1, Math.min(100, Math.floor(Number.isFinite(rawTicks) ? rawTicks : 1)));
    const events: VisualTraceEvent[] = [];
    const seq = this.state.seq + 1;
    const ctx = this.makeContext(seq, events);

    let next = this.stampDeadlines({ ...this.state, clock: this.state.clock + ticks, seq });

    for (let guard = 0; guard < 16; guard++) {
      const dueWindow = next.pendingDecisions.find(
        window =>
          window.status === 'OPEN' &&
          ((window.deadline !== undefined && window.deadline <= next.clock) ||
            window.participants.some(
              pid =>
                window.submissions[pid] === undefined &&
                window.participantDeadlines?.[pid] !== undefined &&
                window.participantDeadlines[pid] <= next.clock
            ))
      );

      if (dueWindow) {
        const wholeWindow = dueWindow.deadline !== undefined && dueWindow.deadline <= next.clock;
        const duePlayers = wholeWindow
          ? dueWindow.participants.filter(pid => dueWindow.submissions[pid] === undefined)
          : dueWindow.participants.filter(
              pid =>
                dueWindow.submissions[pid] === undefined &&
                dueWindow.participantDeadlines?.[pid] !== undefined &&
                dueWindow.participantDeadlines[pid] <= next.clock
            );

        for (const playerId of duePlayers) {
          events.push(
            this.event(
              ctx,
              'DECISION_TIMEOUT',
              wholeWindow
                ? `决策窗口超时 · ${dueWindow.title}`
                : `${this.getActorName(playerId)} 决策超时 · ${dueWindow.title}`,
              900
            )
          );
          next = submitDecision(next, dueWindow.id, playerId, 'PASS').state;
        }

        const updated = next.pendingDecisions.find(window => window.id === dueWindow.id);
        const ready = updated ? updated.status === 'READY' || evaluateWindow(updated).ready : false;
        if (updated && (wholeWindow || ready)) {
          next = this.resolveOpenDecision(next, updated, ctx, events).state;
        }
        next = this.stampDeadlines(next);
        continue;
      }

      // Response windows are attached to the top stack frame.
      const top = next.interruptStack[next.interruptStack.length - 1];
      const deadline = top?.responseWindow?.deadline;
      if (
        !top ||
        top.status !== 'WAITING_INPUT' ||
        deadline === undefined ||
        deadline > next.clock
      ) {
        break;
      }

      events.push(this.event(ctx, 'STACK_TIMEOUT', `响应窗口超时 · ${top.title}`, 900));

      const eligible = top.responseWindow!.eligibleActors ?? top.responseWindow!.eligiblePlayers;
      for (const actorId of eligible) {
        const response = next.interruptStack[next.interruptStack.length - 1].responseWindow!.pendingResponses[actorId];
        if (!response || response === 'PENDING') {
          next = InterruptStackManager.submitResponse(next, top.id, actorId, 'PASS').state;
        }
      }

      // All eligible players passed: pop and resolve the frame payload.
      const popped = InterruptStackManager.pop(next);
      next = popped.state;
      const effect = popped.poppedFrame?.actionPayload ?? null;
      if (effect) next = this.reduceWithPipeline(next, effect, ctx, events).state;
      next = this.stampDeadlines(next);
    }

    const tickAction: Action = {
      type: '__TICK__',
      playerId: SYSTEM_ACTOR,
      payload: { ticks }
    };

    next = { ...next, actionLog: [...next.actionLog, tickAction] };
    next = this.expireEffects(next);

    const outcome = this.module.outcome(next);
    if (outcome.gameOver) {
      next = { ...next, gameOver: true, winner: outcome.winner, winnerReason: outcome.reason };
    }

    if (this.strict) {
      const violations = checkInvariants(next, this.rules);
      if (violations.length > 0) {
        return this.fail(`state invariant violation after tick — ${violations[0].code}: ${violations[0].message}`, events);
      }
    }

    this.state = next;
    this.history.push(tickAction);
    this.emitVisual(events);
    this.notifyStateChange();
    return { ok: true, events, stateHash: this.getStateHash(), action: tickAction };
  }

  private finalizeTransition(
    candidate: GameState,
    seq: number,
    loggedAction: Action,
    events: VisualTraceEvent[],
    ctx: ReduceContext
  ): { ok: true } | { ok: false; result: DispatchResult } {
    candidate = this.expireEffects(candidate);
    candidate = this.stampDeadlines(candidate);
    let next: GameState = {
      ...candidate,
      seq,
      actionLog: [...candidate.actionLog, loggedAction]
    };

    const outcome = this.module.outcome(next);
    if (outcome.gameOver) {
      next = { ...next, gameOver: true, winner: outcome.winner, winnerReason: outcome.reason };
      events.push(
        this.event(ctx, 'ANNOUNCEMENT', outcome.reason ?? `Game over — winner: ${String(outcome.winner)}`, 1600)
      );
    }

    if (this.strict) {
      const violations = checkInvariants(next, this.rules);
      if (violations.length > 0) {
        const detail = violations.map(v => `${v.code}: ${v.message}`).join('; ');
        return {
          ok: false,
          result: this.fail(`state invariant violation after "${loggedAction.type}" — ${detail}`, events)
        };
      }
    }

    this.state = next;
    this.emitVisual(events);
    this.notifyStateChange();
    return { ok: true };
  }

  /** Remove effects whose turn/clock/phase window has ended. */
  private expireEffects(state: GameState): GameState {
    if (!state.effects || state.effects.length === 0) return state;
    const active = state.effects.filter(effect => {
      const expiry = effect.expiresAt;
      if (!expiry) return true;
      if (expiry.turn !== undefined && state.turn > expiry.turn) return false;
      if (expiry.clock !== undefined && state.clock > expiry.clock) return false;
      if (expiry.phase !== undefined && state.phase !== expiry.phase) return false;
      return true;
    });
    if (active.length === state.effects.length) return state;
    return { ...state, effects: active };
  }

  private commitDecision(decision: DecisionWindow, action: Action, events: VisualTraceEvent[]): DispatchResult {
    if (this.strict && !this.isLegal(action)) {
      return this.fail(`illegal decision submission "${action.type}"`, events);
    }

    const actorId = this.actorIdOf(action);
    const submission = submitDecision(this.state, decision.id, actorId, action);
    if (!submission.accepted) return this.fail(submission.error ?? 'submission rejected', events);

    const seq = this.state.seq + 1;
    const ctx = this.makeContext(seq, events);

    let next = submission.state;
    const secretDecision = submission.window?.secret ?? decision.secret;
    events.push(
      this.event(
        ctx,
        'DECISION_COMMIT',
        `${this.getActorName(actorId)} ${secretDecision ? 'committed secretly' : 'submitted'}`,
        400
      )
    );

    let decisionResolved = false;
    if (submission.ready) {
      const resolved = this.resolveOpenDecision(next, submission.window ?? decision, ctx, events);
      next = resolved.state;
      decisionResolved = true;
    }

    next = {
      ...next,
      seq,
      actionLog: [...next.actionLog, action]
    };

    next = this.stampDeadlines(next);

    const outcome = this.module.outcome(next);
    if (outcome.gameOver) {
      next = { ...next, gameOver: true, winner: outcome.winner, winnerReason: outcome.reason };
    }

    if (this.strict) {
      const violations = checkInvariants(next, this.rules);
      if (violations.length > 0) {
        return this.fail(`state invariant violation after decision commit — ${violations[0].code}: ${violations[0].message}`, events);
      }
    }

    this.state = next;
    this.history.push(action);
    this.emitVisual(events);
    this.notifyStateChange();

    return { ok: true, events, stateHash: this.getStateHash(), action, decisionResolved };
  }

  private resolveOpenDecision(
    state: GameState,
    window: DecisionWindow,
    ctx: ReduceContext,
    events: VisualTraceEvent[]
  ): { state: GameState } {
    const reveal = orderedSubmissions(window);
    events.push(
      this.event(
        ctx,
        'DECISION_REVEAL',
        `${window.title} — revealing ${reveal.length} submissions`,
        1200
      )
    );

    let current = state;
    for (const entry of reveal) {
      const submission = entry.submission;
      if (submission === 'PASS' || submission === 'COMMITTED') continue;
      const reduced = this.reduceWithPipeline(current, submission, ctx, events);
      if (!reduced.cancelled) current = reduced.state;
    }

    const marked = resolveDecision(current, window.id);
    current = marked.state;

    if (this.module.onDecisionResolved && marked.window) {
      current = this.module.onDecisionResolved(current, marked.window, ctx);
    }

    return { state: current };
  }

  private resolveResponse(action: Action, frame: StackFrame, events: VisualTraceEvent[]): DispatchResult {
    const responsePayload = action.type === 'PASS' ? 'PASS' : action;
    const actorId = this.actorIdOf(action);
    const submission = InterruptStackManager.submitResponse(this.state, frame.id, actorId, responsePayload);

    const seq = this.state.seq + 1;
    const ctx = this.makeContext(seq, events);

    let next = submission.state;
    events.push(
      this.event(ctx, 'STACK_PUSH', `${this.getActorName(actorId)}: ${action.type}`, 250)
    );

    if (submission.resolved || submission.shortCircuitedAction) {
      const popped = InterruptStackManager.pop(next);
      next = popped.state;

      if (popped.poppedFrame) {
        events.push(this.event(ctx, 'STACK_POP', `Resolved: ${popped.poppedFrame.title}`, 350));

        const chosen =
          submission.shortCircuitedAction ??
          Object.values(popped.poppedFrame.responseWindow?.pendingResponses ?? {}).find(
            r => r !== 'PASS' && r !== 'PENDING'
          );

        const effect: Action | null =
          chosen && typeof chosen !== 'string'
            ? (chosen as Action)
            : popped.poppedFrame.actionPayload ?? null;

        if (effect) {
          const reduced = this.reduceWithPipeline(next, effect, ctx, events);
          next = reduced.state;
        }
      }
    }

    next = { ...next, seq, actionLog: [...next.actionLog, action] };

    next = this.stampDeadlines(next);

    const outcome = this.module.outcome(next);
    if (outcome.gameOver) next = { ...next, gameOver: true, winner: outcome.winner };

    if (this.strict) {
      const violations = checkInvariants(next, this.rules);
      if (violations.length > 0) {
        return this.fail(`state invariant violation after response — ${violations[0].code}: ${violations[0].message}`, events);
      }
    }

    this.state = next;
    this.history.push(action);
    this.emitVisual(events);
    this.notifyStateChange();
    return { ok: true, events, stateHash: this.getStateHash(), action };
  }

  private event(ctx: ReduceContext, type: VisualEventType, title: string, durationMs: number): VisualTraceEvent {
    return { id: ctx.id('evt'), type, title, durationMs };
  }

  /* ------------------------------------------------------------------ */
  /* Replay & event sourcing                                             */
  /* ------------------------------------------------------------------ */

  public exportLog(): ExportedLog {
    const head = this.replayState(this.history).state;
    return {
      moduleId: this.module.meta.id,
      seed: this.state.seed,
      scenario: this.scenario,
      actions: [...this.history],
      stateHash: hashState(head),
      schemaVersion: this.module.meta.schemaVersion ?? 1,
      engineVersion: this.module.meta.engineVersion ?? ENGINE_VERSION
    };
  }

  private replayState(
    actions: Action[],
    seed = this.state.seed,
    scenario = this.scenario
  ): { state: GameState; errors: string[] } {
    const shadow = new UniversalGameEngine(this.module, seed, { strict: false, scenario });
    shadow.silent = true;
    const errors: string[] = [];

    for (const action of actions) {
      const result = shadow.dispatch(action);
      if (!result.ok && result.error) errors.push(result.error);
    }

    shadow.state = { ...shadow.state, actionLog: [...actions] };
    return { state: shadow.state, errors };
  }

  public replayTo(step: number): ReplayReport {
    const target = Math.max(0, Math.min(step, this.history.length));
    const actions = this.history.slice(0, target);
    const before = this.getStateHash();

    const { state, errors } = this.replayState(actions);
    this.state = state;
    this.notifyStateChange();

    return {
      ok: errors.length === 0,
      expectedHash: before,
      actualHash: this.getStateHash(),
      steps: target,
      errors
    };
  }

  public rewindToStep(step: number): ReplayReport {
    return this.replayTo(step);
  }

  public verifyReplay(): ReplayReport {
    const expected = this.getStateHash();
    const atHead = this.state.actionLog.length === this.history.length;
    const { state, errors } = this.replayState(this.history);
    const actual = hashState(state);

    if (errors.length === 0 && atHead && actual !== expected) {
      errors.push('replayed state hash differs from live state');
    }
    if (!atHead) {
      errors.push('engine is rewound; replay compares against the log head, not the current cursor');
    }

    return {
      ok: errors.length === 0,
      expectedHash: expected,
      actualHash: actual,
      steps: this.history.length,
      errors
    };
  }

  /** Replace the current state with a replay of an exported log. */
  public loadLog(payload: ExportedLog): ReplayReport {
    if (payload.moduleId !== this.module.meta.id) {
      throw new Error(`Log belongs to ${payload.moduleId}, engine is ${this.module.meta.id}`);
    }

    const expectedSchema = this.module.meta.schemaVersion ?? 1;
    const expectedEngine = this.module.meta.engineVersion ?? ENGINE_VERSION;
    const versionErrors: string[] = [];
    if (payload.schemaVersion === undefined || payload.engineVersion === undefined) {
      versionErrors.push('legacy log without schema/engine version; migration is not automatic');
    }
    if (payload.schemaVersion !== undefined && payload.schemaVersion !== expectedSchema) {
      versionErrors.push(`log schema ${payload.schemaVersion} != module schema ${expectedSchema}; migration is not automatic`);
    }
    if (payload.engineVersion !== undefined && payload.engineVersion !== expectedEngine) {
      versionErrors.push(`log engine ${payload.engineVersion} != engine ${expectedEngine}; migration is not automatic`);
    }
    if (versionErrors.length > 0) {
      return {
        ok: false,
        expectedHash: payload.stateHash,
        actualHash: this.getStateHash(),
        steps: 0,
        errors: versionErrors
      };
    }

    this.scenario = payload.scenario;
    const { state, errors } = this.replayState(payload.actions, payload.seed, payload.scenario);
    this.state = state;
    this.history = [...payload.actions];
    this.notifyStateChange();

    const actual = hashState(state);
    if (errors.length === 0 && payload.stateHash && actual !== payload.stateHash) {
      errors.push('replayed state does not match the hash recorded in the log');
    }

    return {
      ok: errors.length === 0,
      expectedHash: payload.stateHash,
      actualHash: actual,
      steps: payload.actions.length,
      errors
    };
  }

  /* ------------------------------------------------------------------ */

  private validateInitialState(): void {
    const violations = [
      ...checkInvariants(this.state, this.rules),
      ...MapGraphManager.validateDeclaration(
        this.module.meta.capabilities?.topologySpec,
        this.state.mapGraph.topology
      ).map(message => ({ code: 'topology_declaration', message }))
    ];
    if (violations.length > 0) {
      throw new KernelInvariantError(violations);
    }
  }
}
