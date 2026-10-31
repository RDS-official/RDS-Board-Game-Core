import { RuleHookImpl } from './rules';
import { ProjectionRedactor } from './observer';
import { Action, ActorId, DecisionWindow, DiceSpec, GameOutcome, GameState, MapGraphNode, NodeId, RollResult, SelectionCandidate, SelectionSpec, TopologySpec, VisualTraceEvent } from './types';
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
  /**
   * false 时由驱动方逐步派发内置 AI 的动作（配合 `aiActionDelayMs`），
   * 内核不再在一次 reduce 里替 AI 把整个回合走完。
   */
  autoAi?: boolean;
  /**
   * How many of those seats are humans; the rest may be filled by the
   * fixture's built-in AI. Fixtures without AI ignore it.
   */
  humans?: number;
  /**
   * How many built-in AI seats to add on top of the human seats. Fixtures
   * without AI ignore it.
   */
  aiSeats?: number;
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
 * How a game wants one map node presented when it first appears.
 *
 * The generic layer detects *that* a node appeared; only the game knows whether
 * that is a room being explored, a station opening, or nothing worth a cutscene
 * at all (return null). Every string here is the game's own vocabulary.
 */
export interface NodePresentationHints {
  /** Headline. */
  title: string;
  /** Secondary line, e.g. a printed English name. */
  subtitle?: string;
  /** Category band text, localised by the game. */
  badge?: string;
  /** Opaque visual tone token; the view layer maps it onto one of its plates. */
  tone?: string;
  /** Optional decorative glyph. */
  seal?: string;
  desc?: string;
  /** Label/value rows, in the game's own vocabulary. */
  sections?: { label: string; value: string }[];
  /** Footer line under the sheet, e.g. where the node came from. */
  footer?: string;
  /** Present as a full-screen discovery moment instead of a peripheral sheet. */
  reveal?: boolean;
}

/** Display metadata for one trait ladder (betrayal's speed/might/sanity/knowledge). */
export interface TraitPresentationHints {
  /** Localised trait name, e.g. “速度”. */
  label: string;
  /** One-character glyph for the compact ladder (“速”). */
  short?: string;
  /** Ladder colour; the view layer paints whatever it is given. */
  color?: string;
  /** Printed track length (pips 0..max). */
  max?: number;
  /** Which damage flavour a loss reads as; the HUD only has two vignettes. */
  damageKind?: 'PHYSICAL' | 'MENTAL';
}

/**
 * The slice of a projection a moment declaration may read.
 *
 * Moments are the game's own beats — a haunt starting, a finale, a vote. The
 * generic layer can only observe that the projection changed; what the beat is
 * called and what it says is declared here.
 */
export interface MomentPresentationState {
  globalVars: Record<string, unknown>;
  /** The persistent objective line currently shown to the player. */
  mission?: string;
  players: Record<string, { name: string; role?: string; alive?: boolean }>;
}

/** A full-screen beat the game wants announced once. */
export interface MomentPresentationHints {
  /** Identity used for de-duplication: a new key plays a new curtain. */
  key: string;
  /** Small kicker above the title. */
  kicker?: string;
  /** Serial line under the kicker (“HAUNT No.05”). */
  caption?: string;
  title: string;
  /** Story paragraph. */
  story?: string;
  /** Named cast lines, e.g. the traitor reveal. */
  cast?: { label: string; name: string }[];
  /** Objective line shown at the bottom. */
  objective?: string;
  /** How long the curtain stays up. */
  durationMs?: number;
  /**
   * 幕布不自动消失：由游戏在状态变化时撤下（例如结算画面要等所有人准备）。
   * 点击仍然可以手动关闭。
   */
  hold?: boolean;
}

/**
 * Optional presentation hints a game may declare.
 *
 * The kernel never reads these — they exist so a shared view layer (packages/app,
 * apps/web) can describe and render *every* game without a single game-id branch.
 * Whatever is specific to one game's cards (vocabulary, preview policy) is
 * declared here, inside that game's own package, instead of inside the generic
 * inspection code.
 */
export interface GamePresentationHints {
  /**
   * The board already previews card faces on hover, so a click on a card must
   * not open a second, differently-styled detail sheet for the same card.
   */
  cardPreviewOnHover?: boolean;
  /**
   * Player-facing fact rows for a card's `components.custom` bag
   * ("类别: 武器", "剩余次数: 2", ...). Games supply their own vocabulary; the
   * view layer has no built-in card taxonomy. Must be pure: called per notice.
   */
  cardFacts?: (custom: Record<string, unknown>) => { label: string; value: string }[];
  /**
   * How this game wants a card presented: the localised category band ("预兆 ·
   * OMEN"), an opaque visual tone token the HUD maps onto one of its neutral
   * plates, and an optional decorative glyph. Everything the view layer needs in
   * order not to guess a taxonomy from a game's identity. Must be pure.
   */
  cardStyle?: (custom: Record<string, unknown>) => {
    badge?: string;
    tone?: string;
    seal?: string;
  };
  /**
   * How to present a map node that has just appeared (a newly explored room, an
   * opened station, ...). Return null for nodes that deserve no discovery
   * moment — the generic layer has no vocabulary for nodes of its own, and
   * `node.props` belong to the game. Must be pure.
   */
  describeNode?: (node: MapGraphNode) => NodePresentationHints | null;
  /**
   * Display metadata for one trait ladder key. Return null for keys this game
   * does not treat as a trait; the app layer then keeps the raw key. Must be pure.
   */
  describeTrait?: (traitKey: string) => TraitPresentationHints | null;
  /**
   * Current trait values for one player, read out of `components.custom`
   * (betrayal keeps a `traitIndex`). Null means “this player has no ladders”.
   * The app layer diffs successive projections to animate damage. Must be pure.
   */
  traits?: (custom: Record<string, unknown>) => Record<string, number> | null;
  /**
   * A full-screen beat to announce once, or null when nothing is happening.
   * Must be pure.
   */
  describeMoment?: (state: MomentPresentationState) => MomentPresentationHints | null;
  /**
   * Localised name for a role token. Return null when the game has no such role;
   * the view layer never maps a role itself. Must be pure.
   */
  roleLabel?: (role: string) => string | null;
  /**
   * How long the driver should let a built-in AI think before its next action,
   * in milliseconds. A fixture that resolves its AI inline (inside one reduce)
   * leaves the table no time to follow what happened; declaring this makes the
   * app/server drive the AI one step at a time, at a watchable pace.
   */
  aiActionDelayMs?: number;
  /**
   * Minimum delay (ms) before an action type may be taken again, measured from
   * the moment it first became available. Used for settle pauses: a hand has just
   * finished and the table needs a beat before the next one is dealt. The driver
   * enforces it; the kernel itself stays clock-free.
   */
  actionCooldownMs?: Record<string, number>;
  /**
   * Title of the map overview panel in the game's own vocabulary.
   * A plain string, not a function — see definePresentation.
   */
  mapTitle?: string;
  /**
   * The map node a player stands on, from that player's custom bag, or null
   * when the player is off the map (banished, eliminated). The view layer
   * never reads game-specific keys itself. Must be pure.
   */
  playerNode?: (custom: Record<string, unknown>) => string | null;
  /**
   * A non-player figure on the map (a monster, a neutral), or null when the
   * entity is no cast member. Must be pure.
   */
  castMember?: (custom: Record<string, unknown>) => { nodeId: string; label: string } | null;
  /**
   * Loot summary for a room, from the entity list, or null when the room
   * holds nothing worth a chip. Must be pure.
   */
  roomLoot?: (
    entities: { zoneId?: string; custom?: Record<string, unknown> }[],
    roomId: string
  ) => { label: string; count: number } | null;
  /**
   * Badge (label + optional glyph) for a game token like a room symbol, or
   * null when the token is unknown. Must be pure.
   */
  tokenBadge?: (token: string) => { label: string; glyph?: string } | null;
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
  /**
   * Optional presentation hints: capability declarations for the shared view
   * layer. Rules never read this; a UI consults it so one generic renderer can
   * serve every game without branching on the game id.
   */
  presentation?: GamePresentationHints;
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

/**
 * Authoring helper for `GameModule.presentation`.
 *
 * Declarations are data plus pure functions, called per frame by the view layer;
 * a stray object or a typo would otherwise fail late and far from its cause. This
 * fails at module load, next to the declaration that caused it.
 */
export function definePresentation(hints: GamePresentationHints): GamePresentationHints {
  for (const [key, value] of Object.entries(hints)) {
    if (key === 'mapTitle') {
      if (typeof value !== 'string') throw new TypeError('presentation.mapTitle must be a string');
      continue;
    }
    if (key === 'cardPreviewOnHover') {
      if (typeof value !== 'boolean') throw new TypeError('presentation.cardPreviewOnHover must be a boolean');
      continue;
    }
    if (key === 'aiActionDelayMs') {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new TypeError('presentation.aiActionDelayMs must be a non-negative number');
      }
      continue;
    }
    if (key === 'actionCooldownMs') {
      if (!value || typeof value !== "object") {
        throw new TypeError('presentation.actionCooldownMs must be a record of milliseconds');
      }
      for (const ms of Object.values(value as Record<string, unknown>)) {
        if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
          throw new TypeError('presentation.actionCooldownMs values must be non-negative numbers');
        }
      }
      continue;
    }
    if (typeof value !== 'function') throw new TypeError(`presentation.${key} must be a pure function`);
  }
  return hints;
}
