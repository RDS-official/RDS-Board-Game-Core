import { RuleHookImpl } from './rules';
import { ProjectionRedactor } from './observer';
import { Action, ActorId, DecisionWindow, DiceSpec, GameOutcome, GameState, NodeId, RollResult, SelectionCandidate, SelectionSpec, TopologySpec, VisualTraceEvent } from './types';
import { ActionSchemaMap } from './validation';

/** Per-transition helpers handed to a module's reducer. */
export interface ReduceContext {
  /** Deterministic id factory; never use Date.now / Math.random in reducers. */
  id: (kind: string) => string;
  /** Emit a visual trace event (ignored by headless replay). */
  trace: (event: VisualTraceEvent) => void;
  /** Transition counter of the incoming state. */
  seq: number;
  /**
   * Roll arbitrary dice faces deterministically. The reducer must persist
   * `nextSeed` into `state.prngState`; the helper never mutates state.
   */
  roll: (spec: DiceSpec, seed: number) => { result: RollResult; nextSeed: number };
}

export interface GameCapabilities {
  /** |P(s)| > 1: simultaneous or secret decisions are possible. */
  simultaneousMoves: boolean;
  hiddenInformation: boolean;
  interruptStack: boolean;
  dynamicRules: boolean;
  /** NPC / monster actors participate in turn order. */
  nonPlayerActors?: boolean;
  /** Module uses GameState.effects and kernel expiry. */
  effects?: boolean;
  /** Short label kept for UI/back-compat; prefer topologySpec. */
  topology: 'none' | 'hex-dual' | 'graph' | 'ring' | 'grid';
  /** Structured topology contract; see TopologySpec. */
  topologySpec?: TopologySpec;
}

export interface GameMeta {
  id: string;
  name: string;
  description: string;
  version: string;
  /** State-structure version; logs from other schemas are rejected. */
  schemaVersion?: number;
  /** Kernel scheduling/legality version; mismatched logs are rejected. */
  engineVersion?: number;
  capabilities: GameCapabilities;
}

/** A named, deterministic initial position used by tests, demos and replays. */
export interface GameScenario {
  description?: string;
  setup: (seed: number, options?: GameSetupOptions) => GameState;
}

/**
 * Optional setup arguments.
 *
 * The kernel owns only the *shape* of the request; whether a fixture honours it
 * is the fixture's business. Fixtures with a fixed roster ignore `seats`, and
 * the caller can tell by comparing `playerOrder.length` with what it asked for
 * (see `apps/server/src/match.ts`) — that is how a room refuses to deal more
 * seats than it has players, or fewer seats than the game needs.
 */
export interface GameSetupOptions {
  /** How many seats the table should have. */
  seats?: number;
}

/**
 * 一个可独立启停的规则/内容扩展包。
 *
 * 内核把它当纯元数据处理：校验组合、展开依赖闭包、派生回放 scenario（见
 * `@rds/kernel/expansions`）。扩展真正解锁的卡牌、技能与规则钩子由游戏模块
 * 自己读取 `state.globalVars.expansions` 后决定，内核不介入规则本身。
 */
export interface GameExpansion {
  /** 稳定 id，回放日志依赖，不可改名 */
  id: string;
  /** 显示名，如 '军争篇' */
  name: string;
  description?: string;
  /** 依赖的其他扩展 id（必须同时启用） */
  requires?: string[];
  /** 与之互斥的扩展 id（不可同时启用） */
  conflicts?: string[];
  /** 该扩展是否默认启用 */
  defaultEnabled?: boolean;
}

/**
 * Optional spatial semantics. The kernel only stores the topology graph;
 * walls, doors, line of sight and floor rules stay in the module (or renderer).
 */
export interface SpatialQuery {
  /** Outgoing neighbors for an actor; defaults to MapGraphManager.neighborsOf. */
  neighbors(state: GameState, nodeId: NodeId, actorId?: ActorId): NodeId[];
  /** Cost to traverse from → to; Infinity when blocked. */
  cost(state: GameState, from: NodeId, to: NodeId, actorId?: ActorId): number;
  /** Shortest-path distance; defaults to a Dijkstra over `cost`. */
  distance?(state: GameState, from: NodeId, to: NodeId, actorId?: ActorId): number;
  /** Nodes within budget; defaults to a Dijkstra over `cost`. */
  reachable?(state: GameState, from: NodeId, budget: number, actorId?: ActorId): Map<NodeId, number>;
  /** Walls/doors/height blocking; absent means no line-of-sight support. */
  lineOfSight?(state: GameState, from: NodeId, to: NodeId): boolean;
  /** Layer/floor id for a node. */
  floorAt?(state: GameState, nodeId: NodeId): string | undefined;
}

/**
 * The framework contract a game plugin must satisfy.
 * Games are fixtures: they exercise the kernel, not the other way round.
 */
export interface GameModule {
  meta: GameMeta;
  /** Named start positions selectable via EngineOptions.scenario. */
  scenarios?: Record<string, GameScenario>;
  /**
   * 本游戏支持的扩展包。缺省表示该游戏无扩展。
   *
   * 组合合法性用 `validateExpansionSelection` 校验，回放用的 scenario 可用
   * `deriveExpansionScenarios` 自动派生；模块自身不必为每种组合写一份 setup。
   */
  expansions?: Record<string, GameExpansion>;
  /** Rule hook implementations referenced by ActiveRuleHook.hookId. */
  hooks: RuleHookImpl[];
  /** Optional structural schemas for actions (validated before legality). */
  actionSchemas?: ActionSchemaMap;
  /** Optional semantic payload validation (cross-field constraints). */
  validatePayload?: (state: GameState, action: Action, payload: Record<string, unknown>) => string[];
  /** Optional module-level redaction for projection-only fields. */
  project?: ProjectionRedactor;
  /** Candidate provider for declarative SelectionSpec targets. */
  resolveSelection?: (state: GameState, actorId: ActorId, spec: SelectionSpec) => SelectionCandidate[];
  /** Semantic validation for submitted targets (after schema checks). */
  validateSelection?: (state: GameState, candidate: Action, targets: string[], actorId: ActorId) => string[];
  /**
   * Optional derived stat modifiers for the presentation layer.
   *
   * A game that grants standing bonuses ("+1 Might while carried") exposes them
   * here so any UI can show base + modifier without knowing the game's stat
   * names. Must be a pure function of state: it is called per snapshot and the
   * result is never stored back into the state.
   *
   * See docs/ENGINE-PASSIVE-MODIFIERS.md for the rationale.
   */
  statModifiers?: (state: GameState, actorId: ActorId) => Record<string, number>;
  /** Optional spatial semantics (walls, doors, LOS, floors). */
  spatial?: SpatialQuery;
  /** Logical-clock TTLs (in ticks) applied to decisions / response windows. */
  timing?: { decision?: number; response?: number };
  setup: (seed: number, options?: GameSetupOptions) => GameState;
  legalActions: (state: GameState, actorId: ActorId) => Action[];
  reduce: (state: GameState, action: Action, ctx: ReduceContext) => GameState;
  outcome: (state: GameState) => GameOutcome;
  /**
   * Optional custom resolution for a completed decision window.
   * Default kernel behaviour: apply submissions in policy order via reduce().
   */
  resolveDecision?: (state: GameState, window: DecisionWindow, ctx: ReduceContext) => GameState;

  /** Called after a decision window resolves; may open the next window. */
  onDecisionResolved?: (state: GameState, window: DecisionWindow, ctx: ReduceContext) => GameState;
}

export function defineGame(module: GameModule): GameModule {
  if (!module.meta?.id) throw new Error('Game module requires meta.id');
  if (typeof module.setup !== 'function') throw new Error(`Game ${module.meta.id} requires setup()`);
  if (typeof module.reduce !== 'function') throw new Error(`Game ${module.meta.id} requires reduce()`);
  return module;
}
