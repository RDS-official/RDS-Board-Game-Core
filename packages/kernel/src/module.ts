import { RuleHookImpl } from './rules';
import { ProjectionRedactor } from './observer';
import { Action, ActorId, DecisionWindow, DiceSpec, GameOutcome, GameState, MapGraphNode, NodeId, PlayerId, RollResult, SelectionCandidate, SelectionSpec, TopologySpec, VisualTraceEvent } from './types';
import { ActionSchemaMap } from './validation';
import type { CharterDeviation } from './charter';

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
  /**
   * 宪章 C-7：记一笔收益。写到 `state.rewards`（只追加），**不直接改状态**。
   *
   * 用途是把"谁因为什么拿到多少"与"状态怎么变"解耦：模组照旧改 chips / score，
   * 但同时在记账口留下一行理由，`outcome()` 与结算摘要据此解释得分来源。
   *
   * 必须在 reduce 内调用（上下文只在转移期间有效）。
   */
  reward: (actorId: ActorId, kind: string, amount: number, reason: string) => void;
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
  /**
   * 座位数契约（issue #214）。
   *
   * 在这之前，"这座游戏能坐几个人"只能靠跑一遍 `setup(1)` 数 `playerOrder`，
   * 于是房间上限、联机默认座位、服务端开局核对各自猜了一遍。声明之后，三处
   * 统一读这一份；未声明的存量模组仍走遗留探测（见 `seatRangeOf`）。
   */
  seatRange?: SeatRange;
  /**
   * C-9 扩展字段收口：声明本模块会往自由形状字段里写哪些 key。
   *
   * 内核据此做"未登记 key 出现即违规"的检查 —— 这条是防止规则悄悄长出
   * 内核不认识的状态的唯一手段。未声明则不做检查（存量模组灰度）。
   */
  stateSchema?: {
    /** `state.globalVars` 允许的 key 集合。 */
    globalVars?: readonly string[];
    /** `player.customProps` / `entity.components.custom` 允许的 key 集合。 */
    customProps?: readonly string[];
  };
}

/** 座位数契约：最少/最多/默认，以及是否支持任意人数（issue #214）。 */
export interface SeatRange {
  /** 最少开局人数（含 AI 补位）。 */
  min: number;
  /** 最多座位数。 */
  max: number;
  /** 不传 `seats` 时夹具实际发几座；缺省 = `min`。 */
  default?: number;
  /** true = 支持 `[min,max]` 任意人数；否则只支持 `default`。 */
  variable?: boolean;
}

/** A named, deterministic initial position used by tests, demos and replays. */
export interface GameScenario {
  description?: string;
  /** 该变体固定发几座；缺省沿用 `meta.seatRange`（issue #214）。 */
  seats?: number;
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
   * false 时由驱动方逐步派发内置 AI 的动作（配合 `driver.aiActionDelayMs`），
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
  /**
   * 每个座位的起始筹码（按座位号索引，可以短于座位数）。只有筹码类玩法
   * （德州扑克）读取它，其它夹具忽略。
   *
   * 这是**初始位置**的一部分，不是运行期补丁：同一 seed + 同一 stacks 必须
   * 重放出同一状态。账号余额决定买入时因此不必改写引擎状态，`exportLog`
   * 把 stacks 一起带走，回放逐位一致。
   */
  stacks?: number[];
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
  /**
   * Whose eyes this moment is built for ('GOD' on the full-information seat).
   * A settlement screen needs it to decide whether a folded hand may be shown.
   */
  viewer?: string;
  /**
   * Every seat in table order, including the ones that are no longer in the
   * hand (observers, busted seats). A settlement lists the whole table, not
   * just the survivors.
   */
  seats?: MomentSeat[];
  players: Record<string, { name: string; role?: string; alive?: boolean }>;
}

/**
 * One seat of the table as a moment declaration reads it.
 *
 * Kept separate from `players` because a settlement needs things a name does
 * not carry: what the seat is worth now, whether it folded, and which cards it
 * is allowed to show. All of it is public information — the projection has
 * already masked anything the viewer may not read.
 */
export interface MomentSeat {
  playerId: string;
  name: string;
  /** The kernel score (chips, points, coins — whatever the game counts). */
  score: number;
  /** Cards this seat may show right now, already printed by the game. */
  cards?: string[];
  /** Cards the seat still holds but is not allowed to show (a face-down hand). */
  hidden?: number;
}

export interface MomentLedgerRow {
  /** Stable id for reconcile; a row without one falls back to its index. */
  key?: string;
  /** The seat (or pot) this row is about. */
  name: string;
  /** Small marker painted beside the name (庄家 / 赢家 / 观察席). */
  tag?: string;
  /** Cards to paint in the row, already localised by the game. */
  cards?: string[];
  /** Number of face-down cards to paint after the visible ones. */
  hidden?: number;
  /** Secondary line under the name, e.g. the made hand. */
  detail?: string;
  /** Right-hand number (net chips, points won, …). */
  value?: string;
  /** Which way the number reads; unknown tokens paint neutral. */
  tone?: 'gain' | 'loss' | 'neutral';
}

/**
 * A button painted on a moment's curtain.
 *
 * `actionTypes` names kernel actions the curtain may take, most preferred
 * first. The view dispatches the first one that is legal *now*, so a button can
 * never send an illegal action; when none is legal it stays disabled and shows
 * `unavailableHint` (a cooldown, usually).
 *
 * `leave` is the other capability, and it is deliberately not an action: asking
 * to leave the table is host vocabulary (back to the lobby, or back to the entry
 * screen) and belongs to whoever composed the presenter, not to the rules.
 */
export interface MomentActionHints {
  id: string;
  label: string;
  actionTypes?: string[];
  /** Ask the host to take this viewer away from the table. */
  leave?: boolean;
  tone?: 'primary' | 'normal' | 'danger';
  /** Painted on the button while nothing in `actionTypes` is legal. */
  unavailableHint?: string;
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
  /**
   * A per-seat table under the story (a settlement, a scoreboard, a vote).
   * The game decides the columns' words and order; the curtain only paints.
   */
  ledger?: MomentLedgerRow[];
  /** Buttons under the ledger. A moment without any keeps the plain curtain. */
  actions?: MomentActionHints[];
  /** How long the curtain stays up. */
  durationMs?: number;
  /**
   * 手动关闭保护期（毫秒）：幕布出现后这段时间内，遮罩、Esc 和幕布上的
   * 按钮都不得关闭它；倒计时结束后恢复所有关闭方式。游戏状态自行撤下幕布
   * （例如结算后自动发下一手）不受此锁影响。
   */
  closeLockMs?: number;
  /**
   * 幕布不自动消失：由游戏在状态变化时撤下（例如结算画面要等所有人准备）。
   * 点击仍然可以手动关闭——点幕布本身关闭，点按钮执行对应能力。
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
/**
 * 宪章 C-8：`𝒦_driver` —— 只影响**驱动节奏**的声明。
 *
 * 这些字段由 app / server 的定时器读取，用来决定"什么时候派发下一个动作"。
 * 它们**不属于**展示层：`aiActionDelayMs` 不改变任何像素，只决定 AI 隔多久出手。
 * 历史上它们混在 `GamePresentationHints` 里，导致"展示"与"驱动"无法分别演进。
 */
export interface GameDriverHints {
  /**
   * How long (ms) each built-in AI seat should pause before its move, when the
   * module wants a watchable pace instead of an instant reply. 0 / undefined
   * means "let the kernel advance automated seats inline".
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
   * 驱动方心跳：内核自己没有时钟，凡是「每 N 毫秒发生一次」的规则（观察者的
   * 低保、定期补给等）都由 app / server 的定时器按这里声明的节奏派发一个动作。
   * `action(state)` 返回 null 表示这一拍不需要派发（例如桌上没有观察者），
   * 驱动方跳过即可。动作本身仍走正常的 reduce 路径，因此回放完全确定。
   */
  /**
   * 真人决策超时（issue #190）。声明后，驱动方在「当前行动者是真人」且超过该
   * 毫秒数仍未出手时，用 `timeoutAction` 代打一次；不声明则永不代打。
   */
  decisionDeadlineMs?: number;
  /**
   * 超时代打策略：由游戏自己从合法动作里挑一个（例如优先 CHECK，其次 FOLD）。
   * 返回 null 表示"这一拍无法代打"，驱动方保持等待。
   */
  timeoutAction?: (legal: Action[], state: GameState, playerId: PlayerId) => Action | null;
  heartbeat?: {
    intervalMs: number;
    action: (state: GameState) => Action | null;
  };
  /**
   * 只允许驱动方派发的动作类型（心跳等）。它们不进入 `legalActions`，因此
   * 严格模式下的合法性校验按声明放行；面向客户端的入口必须拒绝这些类型。
   */
  driverActions?: readonly string[];
  /**
   * 由机器控制的角色（AI 座位）。
   *
   * 驱动方（app / server）据此按 `driver.aiActionDelayMs` 代它派发动作。
   * AI 与真人走同一条 `legalActions → dispatch` 管线：`legalActions` 直接给出它
   * 这一步要做的具体动作，因此结算阶段（准备 / 开下一手）也不会漏。
   */
  isAutomated?: (state: GameState, actorId: ActorId) => boolean;
}

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
   * Which seat the local player sits in before anyone chooses otherwise, or null
   * when the game has no notion of "my seat".
   *
   * 单人演示桌默认是上帝视角，可对局类游戏的主角其实只有一个：坐在自己位子
   * 上、从牌桌对面看牌桌的那个人。这一条把「第一人称视角属于某一名玩家」这件事
   * 提升为能力声明，通用层因此不必知道任何游戏的座位结构，也能开局即入座。
   * 联机座位由服务器下发，驱动方只把它当缺省值，不覆盖权威结果。
   * 必须纯：只读投影切片，不写回状态。返回的 id 不在 `players` 里时驱动方忽略。
   */
  defaultViewer?: (state: MomentPresentationState) => PlayerId | null;
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
  /**
   * C-6 语义不变量：规则层面的守恒 / 一致性断言（筹码守恒、怪物与实体 1:1 …）。
   *
   * 与 `kernel/src/invariants.ts` 的结构性检查互补：那边保证"状态形状没坏"，
   * 这边保证"规则没被违反"。返回人类可读的违规描述，空数组表示通过。
   * 内核在 strict 模式下每次转移后调用；违规**不阻断**转移，只记录到
   * `engine.getViolations()` 并在 `DispatchResult.violations` 中带回。
   *
   * 必须纯：不得修改 state，不得调用 `outcome()` / 随机数。
   */
  checkInvariants?: (state: GameState) => string[];
  /**
   * 本模块对宪章的**显式偏离登记**（C-x）。与 `docs/RULES-DEVIATIONS.md` 对应。
   * 未登记就偏离的条款，内核会按违规记录。
   */
  charter?: {
    deviations?: readonly CharterDeviation[];
    /**
     * 声明本模块的机器决策入口已收口到投影状态（C-5）。
     * 声明后，`engine.getProjectedStateFor()` 的 AI 分支会做运行期断言。
     */
    requiresProjection?: boolean;
    /**
     * 声明本模组已把收益改动接进 `ctx.reward()`（C-7）。
     * 声明后内核校验 `state.rewards` 的条目完整性：必须有 actor / kind /
     * 非零 amount / 非空 reason —— 没理由的收益等于没记账。
     */
    requiresRewardLedger?: boolean;
  };
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
  /**
   * 宪章 C-8：`𝒦_driver` —— 驱动节奏声明（AI 出手间隔、动作冷却）。
   *
   * 从 `presentation` 里拆出来的：这两者影响的是**什么时候派发下一个动作**，
   * 不是渲染什么。app / server 读它，内核与视图都不读。
   */
  driver?: GameDriverHints;
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
  /**
   * 宪章 C-3：`SIMULTANEOUS` 决策窗口的结算入口。
   *
   * `actions` 是**动作多重集**（`{ actorId, action }`），数组顺序不代表发生
   * 顺序 —— 模组必须一次性消费，自己决定如何合并（平局打破、边池、竞标…）。
   *
   * 未声明时内核退化为"按座位序逐条 reduce"，并记一条
   * `CHARTER_C3_SERIALIZED` 偏离：语义仍然确定，但顺序敏感。
   */
  /**
   * 宪章 C-2：一次 `reduce` 结束后，声明"接下来还有哪些自动步"。
   *
   * 这是替代"在 reduce 里写 `for` 循环推进 AI / 连续结算"的官方出口。
   * 内核拿到动作后会**作为独立的一次 dispatch 执行**（每步都进 history，回放可重现）。
   */
  resolveFollowUp?: (state: GameState, ctx: ReduceContext) => Action[];

  applySimultaneous?: (
    state: GameState,
    actions: { actorId: ActorId; action: Action }[],
    ctx: ReduceContext
  ) => GameState;

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
/**
 * Authoring helper for `GameModule.driver` (charter C-8, `𝒦_driver`).
 *
 * 与 `definePresentation` 同样的理由：声明在模块加载时就校验，错误不会飘到
 * 几秒后的某个定时器里才炸。
 */
export function defineDriver(hints: GameDriverHints): GameDriverHints {
  for (const [key, value] of Object.entries(hints)) {
    if (key === 'aiActionDelayMs') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new TypeError('driver.aiActionDelayMs must be a non-negative number');
      }
      continue;
    }
    if (key === 'actionCooldownMs') {
      if (!value || typeof value !== 'object') {
        throw new TypeError('driver.actionCooldownMs must be a record of milliseconds');
      }
      for (const ms of Object.values(value as Record<string, unknown>)) {
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
          throw new TypeError('driver.actionCooldownMs values must be non-negative numbers');
        }
      }
      continue;
    }
    if (key === 'driverActions') {
      if (!Array.isArray(value) || value.some(t => typeof t !== 'string')) {
        throw new TypeError('driver.driverActions must be a list of action type strings');
      }
      continue;
    }
    if (key === 'heartbeat') {
      if (!value || typeof value !== 'object') {
        throw new TypeError('driver.heartbeat must be an object');
      }
      const beat = value as { intervalMs?: unknown; action?: unknown };
      if (typeof beat.intervalMs !== 'number' || !Number.isFinite(beat.intervalMs) || beat.intervalMs <= 0) {
        throw new TypeError('driver.heartbeat.intervalMs must be a positive number');
      }
      if (typeof beat.action !== 'function') {
        throw new TypeError('driver.heartbeat.action must be a function');
      }
      continue;
    }
    if (key === 'decisionDeadlineMs') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new TypeError('driver.decisionDeadlineMs must be a positive number');
      }
      continue;
    }
    if (key === 'timeoutAction') {
      if (typeof value !== 'function') {
        throw new TypeError('driver.timeoutAction must be a function');
      }
      continue;
    }
    if (key === 'isAutomated') {
      if (typeof value !== 'function') {
        throw new TypeError('driver.isAutomated must be a pure predicate');
      }
      continue;
    }
    throw new TypeError(`driver.${key} is not a driver declaration`);
  }
  return hints;
}

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
    if (key === 'aiActionDelayMs' || key === 'actionCooldownMs') {
      // 宪章 C-8：这两个是驱动方语义（𝒦_driver），不属于展示。
      // 仍然接受旧写法以免一次性打断所有调用方，但明确告诉作者该搬去哪。
      throw new TypeError(
        `presentation.${key} is a driver concern (charter C-8) — declare it on GameModule.driver via defineDriver() instead`
      );
    }
    if (typeof value !== 'function') throw new TypeError(`presentation.${key} must be a pure function`);
  }
  return hints;
}
