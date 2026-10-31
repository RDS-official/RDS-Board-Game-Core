/**
 * Universal board game kernel — formal model types.
 *
 * G = ⟨N, S, s0, A, L, T, O, R, K⟩
 *
 * The state is plain JSON (no functions, no class instances) so it can be
 * hashed, snapshotted, persisted and replayed bit-exactly.
 */

export type PlayerId = string;
export type ActorId = string;
export type ActorKind = 'PLAYER' | 'NPC';
export type ActorStatus = 'ACTIVE' | 'DEAD' | 'ELIMINATED' | 'SPECTATOR';
export type EntityId = string;
export type ZoneId = string;
export type NodeId = string;
export type EdgeId = string;
export type HookId = string;

/** Chance node (nature) pseudo-player. */
export const CHANCE_NODE: PlayerId = 'CHANCE_NODE_c';
/** Actor used by kernel-level control actions (logical clock). */
export const SYSTEM_ACTOR: PlayerId = 'SYSTEM';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = { [key: string]: JsonValue };

export type FactionRelation = 'ALLIED' | 'HOSTILE' | 'NEUTRAL' | 'UNKNOWN';

export interface Player {
  id: PlayerId;
  name: string;
  color: string;
  avatar: string;
  /** 联机身份：头像图片 URL（hub /avatars/…），仅展示用，不影响规则。 */
  avatarUrl?: string;
  score: number;
  alive: boolean;
  status?: ActorStatus;
  isAI?: boolean;
  role?: string;
  secretRole?: string;
  handZoneId: string;
  customProps: Record<string, any>;
}

/**
 * A non-player actor (monster, neutral unit, scripted NPC).
 *
 * NPCs are first-class actors for scheduling/legality/projection, but they are
 * not players: no hand zone, no seat, no player DTO. An NPC may reference an
 * entity that carries its spatial/visual data; position is stored once.
 */
export interface Npc {
  id: ActorId;
  kind: 'NPC';
  name: string;
  color: string;
  avatar: string;
  status: ActorStatus;
  /** Actor that issues this NPC's actions (e.g. the traitor); undefined = script AI. */
  controllerId?: ActorId;
  /** Entity that carries spatial/visual state, if any. */
  entityId?: EntityId;
  zoneId?: ZoneId;
  /** Defaults to PUBLIC. */
  visibility?: VisibilityRule;
  customProps: Record<string, any>;
}

export type VisibilityRule =
  | { type: 'PUBLIC' }
  | { type: 'OWNER_ONLY'; ownerId: PlayerId }
  | { type: 'SUBSET'; playerIds: PlayerId[] }
  | { type: 'HIDDEN' };

export type EntityType =
  | 'CARD'
  | 'TILE'
  | 'TOKEN'
  | 'DICE'
  | 'MEEPLE'
  | 'BUILDING'
  | 'DIAL';

export interface CardFace {
  title: string;
  suit?: string;
  rank?: number | string;
  type?: string;
  desc?: string;
  cost?: Record<string, number>;
  score?: number;
  skills?: HookId[];
  color?: string;
  imageUrl?: string;
}

export interface SpatialComponent {
  x: number;
  y: number;
  z: number;
  rotationX?: number;
  rotationY?: number;
  rotationZ?: number;
  nodeId?: string;
  floor?: number;
  /** Primary placement slot (multi-slot footprints are TBD). */
  slotId?: string;
  /** Derived/ordinal position inside a STACK/FAN slot. */
  slotIndex?: number;
}

export interface DiceComponent {
  value: number;
  sides: number;
  faces?: number[];
  isRolling?: boolean;
}

export interface Entity {
  id: EntityId;
  type: EntityType;
  zoneId: ZoneId;
  ownerId?: PlayerId;
  visibility: VisibilityRule;
  components: {
    cardFace?: CardFace;
    spatial?: SpatialComponent;
    tokens?: Record<string, number>;
    dice?: DiceComponent;
    building?: { type: 'SETTLEMENT' | 'CITY' | 'ROAD' | 'ROBBER' | 'MONSTER'; color: string };
    custom?: Record<string, any>;
  };
  virtualAliases?: Record<PlayerId, string>;
}

export type ZoneType =
  | 'DECK'
  | 'HAND'
  | 'GRID'
  | 'MARKET'
  | 'DISCARD'
  | 'EQUIP'
  | 'JUDGE'
  | 'BOARD'
  | 'BANK'
  | 'RESERVE';

export interface Zone {
  id: ZoneId;
  name: string;
  type: ZoneType;
  ownerId?: PlayerId;
  visibility: VisibilityRule;
  orderedEntities: EntityId[];
  spatialLayout?: 'STACK' | 'FAN' | 'ROW' | 'GRID' | 'HEX' | 'CIRCLE';
  anchorPosition?: [number, number, number];
}

/* -------------------------------------------------------------------------- */
/* Map topology G_map = (V, E_grid)                                            */
/* -------------------------------------------------------------------------- */

export type TopologyKind = 'none' | 'graph' | 'grid' | 'hex' | 'ring' | 'linear' | 'custom';
export type TopologyAdjacency = 'edges' | 'neighbors' | 'both' | 'none';

export interface TopologyLayer {
  id: string;
  name: string;
  index: number;
  /** Short tab label (B / 1F / 2F); optional game vocabulary. */
  tag?: string;
}

/**
 * Structured topology declaration. `kind` alone is a label; this spec tells
 * the kernel (and presenters) which adjacency source is authoritative, whether
 * edges are directed/weighted, and which layers exist.
 */
export interface TopologySpec {
  kind: TopologyKind;
  /** `neighbors` = node lists (seat rings), `edges` = edge table, `both` = synced. */
  adjacency: TopologyAdjacency;
  directed?: boolean;
  weighted?: boolean;
  geometry?: 'none' | 'grid' | 'hex' | 'ring' | 'free';
  /** Optional geometry metadata; never computed by the kernel. */
  geometrySpec?: {
    cellSize?: number;
    hexOrientation?: 'pointy' | 'flat';
    origin?: [number, number, number];
    /** Which 3D axis separates layers during UI projection. */
    layerAxis?: 'x' | 'y' | 'z';
    /** World-space distance between adjacent layers (fixed mode / minimum gap). */
    layerSpacing?: number;
    /** Auto lays floors out from their current occupied bounds instead of a fixed step. */
    layerMode?: 'fixed' | 'auto';
    /** Optional center cell for grid coordinates [col, row, layer]. */
    gridOrigin?: [number, number];
    /** Ring projection radii for [seatIndex] coordinates. */
    radiusX?: number;
    radiusZ?: number;
    /** Vertical spacing for [col, row, level] stack coordinates. */
    stackHeight?: number;
  };
  layers?: TopologyLayer[];
}

/**
 * A transform node for multi-board / nested-coordinate layouts.
 *
 * Frames form a tree. A node's logical point is transformed by its frame and
 * all ancestors during projection; the kernel only stores the tree, never a
 * camera or UI transform.
 */
export interface SpatialFrame {
  id: string;
  parentId?: string;
  /** Translation in the parent frame. */
  origin?: [number, number, number];
  /** Y-axis rotation in radians (board sections, player boards). */
  rotationY?: number;
  /** Uniform scale (nested mini-boards). */
  scale?: number;
  /** Free-form metadata for the presentation layer. */
  props?: Record<string, any>;
}

export interface MapGraphNode {
  id: NodeId;
  type: 'HEX' | 'VERTEX' | 'EDGE' | 'ROOM' | 'SEAT' | 'GENERIC';
  /**
   * High-dimensional logical coordinates. The kernel never assumes that
   * position[0..2] is a world XYZ; renderers project it through a mapping layer.
   * Current conventions:
   *   world:  [x, y, z]
   *   grid:   [col, row, layerIndex, ...]
   *   hex:    [x, 0, z] (dual graph already carries world positions)
   */
  position: number[];
  /** Explicit coordinate space; absent means legacy world coordinates. */
  positionSpace?: 'world' | 'grid' | 'ring' | 'stack' | 'custom' | (string & {});
  /** Optional frame in GameMapGraph.frames; inherited transforms are applied by UI projection. */
  frameId?: string;
  neighbors: NodeId[];
  /** Optional layer id (floor, plane, board section). */
  layer?: string;
  /** Defaults to PUBLIC. Hidden nodes are removed by the projection. */
  visibility?: VisibilityRule;
  occupantEntityId?: EntityId;
  props: Record<string, any>;
}

export interface MapGraphEdge {
  id: EdgeId;
  from: NodeId;
  to: NodeId;
  occupantEntityId?: EntityId;
  type?: string;
  /** Directed edges only appear in `from.neighbors`; reverse traversal is blocked. */
  directed?: boolean;
  /** Positive traversal cost; default 1. */
  weight?: number;
  /** Optional port/endpoint ids for door/wall matching. */
  ports?: { from?: string; to?: string };
  /** Defaults to PUBLIC; hidden edges are removed by the projection. */
  visibility?: VisibilityRule;
  props?: Record<string, any>;
}

export interface GameMapGraph {
  nodes: Record<NodeId, MapGraphNode>;
  edges: Record<EdgeId, MapGraphEdge>;
  topology?: TopologySpec;
  /** Optional multi-board / nested frame tree. */
  frames?: Record<string, SpatialFrame>;
  /** Optional generic placement slots (nodes, edges, zones, free anchors). */
  slots?: Record<string, PlacementSlot>;
}

export type SlotKind = 'NODE' | 'EDGE' | 'ZONE' | 'FREE';
export type SlotLayout = 'SINGLE' | 'STACK' | 'FAN' | 'ROW' | 'GRID';

/**
 * A logical placement anchor. Capacity/stacking are shared kernel vocabulary;
 * whether a particular entity may occupy the slot remains a module rule.
 */
export interface PlacementSlot {
  id: string;
  kind: SlotKind;
  nodeId?: NodeId;
  edgeId?: EdgeId;
  zoneId?: ZoneId;
  frameId?: string;
  local?: {
    position: [number, number, number];
    rotationY?: number;
  };
  accepts?: {
    entityTypes?: EntityType[];
    tags?: string[];
  };
  /** Defaults to 1. */
  capacity?: number;
  layout?: SlotLayout;
  /** Behavior when capacity is reached; default REJECT. */
  overflow?: 'OFFSET' | 'REJECT';
  visual?: {
    gap?: number;
    height?: number;
    maxOffset?: number;
    /** Uniform card/piece scale for this slot. */
    scale?: number;
  };
}

/* -------------------------------------------------------------------------- */
/* Generic effects / modifiers                                                 */
/* -------------------------------------------------------------------------- */

export interface EffectExpiry {
  /** Last turn on which the effect is active (inclusive). */
  turn?: number;
  /** Clock tick at which the effect expires (inclusive). */
  clock?: number;
  phase?: string;
}

/**
 * Generic, module-interpreted effect instance. The kernel only stores the
 * lifecycle and visibility; trait/card semantics stay in the module.
 */
export interface EffectInstance {
  id: string;
  kind: string;
  source: ActorId;
  /** ActorId or EntityId. */
  target: string;
  tags?: string[];
  payload?: JsonRecord;
  expiresAt?: EffectExpiry;
  visibility?: VisibilityRule;
}

/* -------------------------------------------------------------------------- */
/* Two-phase check window (K4)                                                 */
/* -------------------------------------------------------------------------- */

export type RollWindowPhase = 'DECLARE' | 'REACT' | 'RESOLVED';

/** One participant's choices in one phase. */
export interface RollWindowSlot {
  actorId: ActorId;
  /** Module-defined option ids this actor may pick (empty = phase is a no-op). */
  options: string[];
  /** Option ids actually picked, in pick order (deterministic). */
  picked: string[];
}

export interface RollWindowResult {
  dice: number[];
  total: number;
  threshold?: number;
  success?: boolean;
}

/**
 * A check split into the two moments the tabletop actually has: modifiers are
 * declared before the dice are thrown, responses are chosen after the result is
 * known. The kernel owns the lifecycle; option ids stay module-defined.
 */
export interface RollWindow {
  id: string;
  /** Module label, e.g. '金库 · 知识检定'. */
  label: string;
  /** Whose check this is. */
  actorId: ActorId;
  phase: RollWindowPhase;
  /** Pre-roll modifiers. */
  declares: RollWindowSlot[];
  /** Post-roll responses. */
  reacts: RollWindowSlot[];
  /** Filled once the dice are thrown (never present during DECLARE). */
  result?: RollWindowResult;
  /** Opaque module payload (room id, feature name, …). */
  payload?: JsonRecord;
}

/* -------------------------------------------------------------------------- */
/* Interrupt stack Σ_stack                                                     */
/* -------------------------------------------------------------------------- */

export interface StackResponseWindow {
  eligiblePlayers: ActorId[];
  pendingResponses: Record<ActorId, 'PENDING' | 'PASS' | Action>;
  /** Optional actor-level alias (NPCs included). Falls back to eligiblePlayers. */
  eligibleActors?: ActorId[];
  /** Priority arbitration (e.g. Mahjong: Hu 30 > Peng 20 > Chi 10). */
  priorityArbitration?: boolean;
  priorityMap?: Record<string, number>;
  /** Actions at or above this priority short-circuit the window. */
  shortCircuitAt?: number;
  /** Logical-clock deadline (inclusive). */
  deadline?: number;
  timeoutMs?: number;
}

export type StackFrameStatus = 'PENDING' | 'WAITING_INPUT' | 'RESOLVING' | 'RESOLVED' | 'CANCELLED';

export interface StackFrame {
  id: string;
  type: string;
  title: string;
  description: string;
  sourcePlayerId: PlayerId;
  targetPlayerId?: PlayerId;
  entityId?: EntityId;
  actionPayload: Action | null;
  responseWindow?: StackResponseWindow;
  status: StackFrameStatus;
  metadata?: Record<string, any>;
}

/* -------------------------------------------------------------------------- */
/* Dynamic meta-rules K_t                                                      */
/* -------------------------------------------------------------------------- */

export type HookStage = 'FILTER_MODIFY' | 'BEFORE_REPLACE' | 'AFTER_TRIGGER' | 'WIN_CONDITION';

export interface ActionTransformation {
  type: 'CONTINUE' | 'MODIFY' | 'REPLACE' | 'CANCEL';
  modifiedAction?: Action;
  followUpActions?: Action[];
  pushedStackFrames?: StackFrame[];
  message?: string;
}

/**
 * A *live* rule hook attached to the state. It only stores data: the actual
 * predicate/handler implementation lives in the module's RuleRegistry, keyed
 * by hookId. This keeps `GameState` serializable and replayable.
 */
export interface ActiveRuleHook {
  instanceId: string;
  hookId: HookId;
  ownerId?: PlayerId;
  sourceEntityId?: EntityId;
  visibility: VisibilityRule;
  params?: JsonRecord;
}

/* -------------------------------------------------------------------------- */
/* Simultaneous / secret decisions |P(s)| > 1                                  */
/* -------------------------------------------------------------------------- */

export type DecisionKind = 'SIMULTANEOUS' | 'BIDDING' | 'VOTE';

export type DecisionPolicy =
  | { type: 'ALL_COMMITTED' }
  | { type: 'FIRST_ACCEPT'; acceptTypes: string[] }
  | { type: 'PRIORITY'; priorities: Record<string, number>; shortCircuitAt: number };

export type DecisionSubmission = Action | 'PASS' | 'COMMITTED';

export interface DecisionWindow {
  id: string;
  kind: DecisionKind;
  title: string;
  description?: string;
  participants: ActorId[];
  submissions: Record<ActorId, DecisionSubmission | undefined>;
  /** Secret submissions are not visible to other players until reveal. */
  secret: boolean;
  policy: DecisionPolicy;
  status: 'OPEN' | 'READY' | 'RESOLVED' | 'CANCELLED';
  /** Logical-clock deadline (inclusive) for the whole window. */
  deadline?: number;
  /** Optional per-participant logical-clock deadlines (inclusive). */
  participantDeadlines?: Record<ActorId, number>;
  payload?: JsonRecord;
  reveal?: Record<PlayerId, DecisionSubmission>;
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                     */
/* -------------------------------------------------------------------------- */

export type SelectionSource =
  | 'entity'
  | 'node'
  | 'edge'
  | 'actor'
  | 'player'
  | 'zone'
  | 'hand'
  | 'room'
  | 'deck';

/**
 * Declarative target picker. The presenter resolves candidates against the
 * projected state; the submitted action carries concrete `targets`.
 */
export interface SelectionSpec {
  source: SelectionSource;
  /** Serializable filter interpreted by the presenter/module. */
  scope?: Record<string, unknown>;
  min: number;
  max: number;
  distinct?: boolean;
}

export interface SelectionCandidate {
  id: string;
  label: string;
  icon?: string;
  meta?: JsonRecord;
}

/* -------------------------------------------------------------------------- */
/* Dice                                                                        */
/* -------------------------------------------------------------------------- */

export interface DiceSpec {
  count: number;
  /** Arbitrary face values, e.g. [0,1,2] for Betrayal dice. */
  faces: number[];
}

export interface RollResult {
  spec: DiceSpec;
  rolls: number[];
  total: number;
}

export interface ActionFieldDependency {
  /** Field key this field depends on. */
  key: string;
  /** Show only when the dependency equals this value. */
  equals?: string | number | boolean;
  /** Show only when the dependency is truthy/falsy. */
  truthy?: boolean;
}

export interface ActionFieldSpec {
  key: string;
  label: string;
  kind: 'enum' | 'number' | 'boolean' | 'string' | 'json' | 'selection';
  options?: { value: string; label: string }[];
  selection?: SelectionSpec;
  min?: number;
  max?: number;
  step?: number;
  default?: string | number | boolean;
  required?: boolean;
  /** Optional conditional visibility (cross-field form constraint). */
  dependsOn?: ActionFieldDependency;
}

export interface Action {
  type: string;
  /** Legacy actor slot; PlayerId and ActorId are both strings. */
  playerId: string;
  /** Preferred actor slot for new code (players and NPCs). */
  actorId?: ActorId;
  entityId?: EntityId;
  fromZoneId?: ZoneId;
  toZoneId?: ZoneId;
  targetNodeId?: NodeId;
  targetEdgeId?: EdgeId;
  targetSlotId?: string;
  targetPlayerId?: PlayerId;
  payload?: any;
  /** Concrete targets for a `SelectionSpec`. */
  targets?: string[];
  /** Top-level target picker for actions with a single selection. */
  selection?: SelectionSpec;
  /**
   * Optional declarative parameter form. The UI renders these fields and sends
   * the collected values as `payload`; serializable and replay-safe.
   */
  fields?: ActionFieldSpec[];
}

/* -------------------------------------------------------------------------- */
/* Visual trace (decoupled from state)                                         */
/* -------------------------------------------------------------------------- */

export type VisualEventType =
  | 'CARD_DRAW'
  | 'CARD_PLAY'
  | 'CARD_DISCARD'
  | 'DICE_ROLL'
  | 'TOKEN_TRANSFER'
  | 'BUILD_OBJECT'
  | 'MOVE_OBJECT'
  | 'EXPLORE_ROOM'
  | 'STACK_PUSH'
  | 'STACK_POP'
  | 'STACK_CANCEL'
  | 'STACK_TIMEOUT'
  | 'DECISION_TIMEOUT'
  | 'RULE_MUTATE'
  | 'DAMAGE_EFFECT'
  | 'HIGHLIGHT_NODE'
  | 'DECISION_OPEN'
  | 'DECISION_COMMIT'
  | 'DECISION_REVEAL'
  | 'ANNOUNCEMENT';

export interface VisualTraceEvent {
  id: string;
  type: VisualEventType;
  title: string;
  sourceId?: string;
  targetId?: string;
  payload?: any;
  durationMs: number;
}

/* -------------------------------------------------------------------------- */
/* Complete state s_t                                                          */
/* -------------------------------------------------------------------------- */

export interface GameState {
  /** Module id this state belongs to. */
  gameId: string;
  /** Initial seed, kept for replay. */
  seed: number;
  /** Monotonic transition counter; also used to derive deterministic ids. */
  seq: number;
  /** Logical clock in ticks; advances only via explicit clock control actions. */
  clock: number;

  round: number;
  turn: number;
  activePlayerId: PlayerId;
  /** Active actor (player or NPC); defaults to activePlayerId. */
  activeActorId?: ActorId;
  phase: string;

  players: Record<PlayerId, Player>;
  playerOrder: PlayerId[];
  /** Non-player actors; absent for pure-player games. */
  npcs?: Record<ActorId, Npc>;
  /** Full turn order including NPCs; defaults to playerOrder. */
  actorOrder?: ActorId[];

  entities: Record<EntityId, Entity>;
  zones: Record<ZoneId, Zone>;
  mapGraph: GameMapGraph;
  /** Module-interpreted effects/modifiers; kernel owns only lifecycle. */
  effects?: EffectInstance[];
  globalVars: Record<string, any>;

  interruptStack: StackFrame[];
  pendingDecisions: DecisionWindow[];
  activeHooks: ActiveRuleHook[];
  /**
   * Two-phase check windows (declare → roll → react → resolve). The kernel owns
   * only the lifecycle and bookkeeping; option ids stay module-defined.
   */
  rollWindows?: RollWindow[];

  /** Current PRNG state (deterministic chance node c). */
  prngState: number;

  actionLog: Action[];
  winner: ActorId | ActorId[] | null;
  gameOver: boolean;
  /**
   * Human-readable reason the outcome fired (e.g. "所有英雄都已死亡或被带走").
   * Additive optional field: logs written before it existed replay unchanged.
   */
  winnerReason?: string;
}

/** Projected state o_{i,t} = O(s_t, i). */
export interface ProjectedGameState extends Omit<GameState, 'entities' | 'zones' | 'prngState' | 'seed'> {
  viewerId: PlayerId | 'GOD';
  entities: Record<EntityId, Partial<Entity> & { isMasked?: boolean }>;
  zones: Record<ZoneId, Zone>;
  legalActions: Action[];
  factionTopology: Record<PlayerId, Record<PlayerId, FactionRelation>>;
  maskedEntityCount: number;
  maskedNodeCount?: number;
  maskedEdgeCount?: number;
}

/* -------------------------------------------------------------------------- */
/* Kernel-facing result types                                                  */
/* -------------------------------------------------------------------------- */

export interface GameOutcome {
  gameOver: boolean;
  winner: ActorId | ActorId[] | null;
  winners?: ActorId[];
  losers?: ActorId[];
  reason?: string;
  objectives?: { id: string; owner: ActorId; progress: number; target: number }[];
}

export interface DispatchResult {
  ok: boolean;
  error?: string;
  action?: Action;
  events: VisualTraceEvent[];
  stateHash?: string;
  decisionOpened?: boolean;
  decisionResolved?: boolean;
}
