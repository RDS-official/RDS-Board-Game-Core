import type { MapGraphNode, ProjectedGameState, SelectionSpec, SpatialFrame, TopologySpec } from '@rds/kernel/types';

/**
 * UI-facing contracts.
 *
 * The UI (HUD + inspector) must not import the engine, game modules, audio or
 * the renderer. It only receives these DTOs from a `GamePresenter` and calls
 * back through the presenter / presentation ports.
 */

export type ViewerId = string;
export type BoardState = ProjectedGameState;

export type ActionTone = 'primary' | 'danger' | 'normal';

/**
 * Presentation projection port.
 *
 * Core stores logical coordinates only. A port maps one node into renderer
 * world space; it may be registered per `positionSpace` (grid/hex/custom/...).
 * The renderer consumes ports, never game-specific coordinate switches.
 */
export interface ProjectionContext {
  gameId: string;
  topology?: TopologySpec;
  frames?: Record<string, SpatialFrame>;
  /** Auto floor layout offsets, keyed by logical layer index. */
  layerOffsets?: Record<number, number>;
  viewport?: { width: number; height: number };
}

export interface ProjectedTransform {
  position: [number, number, number];
  /** Optional visual yaw; renderer may ignore it for tile semantics. */
  rotation?: number;
  /** Optional visual scale; renderer may ignore it for tile semantics. */
  scale?: number;
}

export interface ProjectionPort {
  readonly id: string;
  project(node: MapGraphNode, context: ProjectionContext): ProjectedTransform;
}

export interface UiActionField {
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
  dependsOn?: {
    key: string;
    equals?: string | number | boolean;
    truthy?: boolean;
  };
}

export interface UiSelectionCandidate {
  id: string;
  label: string;
  icon?: string;
}

export interface UiActionSelection {
  spec: SelectionSpec;
  candidates: UiSelectionCandidate[];
}

export interface UiAction {
  id: string;
  /** Underlying kernel action type (also present for board-group shortcuts). */
  actionType?: string;
  icon: string;
  label: string;
  hint: string;
  tone: ActionTone;
  /** When present, the action is a board-targeting mode: click the highlighted objects. */
  highlightIds?: string[];
  /** Entity placement mode: arm the action, then click a highlighted slot node. */
  placementEntityId?: string;
  /** Entity this action directly operates on (card sheet shortcuts). */
  entityId?: string;
  /** Declarative target picker; the presenter sends the selected ids as `targets`. */
  selection?: UiActionSelection;
  /** When present, the UI must collect these fields and send them as payload. */
  fields?: UiActionField[];
}

/** One buff or debuff currently attached to a player. */
export interface UiEffect {
  id: string;
  label: string;
  detail?: string;
  /** 'bad' paints it as a curse, 'good' as a boon. */
  tone?: 'good' | 'bad' | 'neutral';
}

export interface UiPlayer {
  id: string;
  name: string;
  color: string;
  avatar: string;
  /** 联机身份头像（hub /avatars/…），缺省回退 emoji avatar。 */
  avatarUrl?: string;
  score: number;
  scoreLabel: string;
  alive: boolean;
  roleLabel?: string;
  roleClass?: string;
  isFocus: boolean;
  stats: { label: string; value: string }[];
  /** Active buffs and debuffs, shown when the character card is opened. */
  effects?: UiEffect[];
  pips: {
    color: string;
    label: string;
    value: string;
    short?: string;
    icon?: string;
    /** Track length when the game uses a printed 0..max ladder. */
    max?: number;
    /** Printed starting position, rendered as a hollow marker. */
    start?: number;
    /** Standing bonus from carried cards, shown next to the value. */
    modifier?: number;
  }[];
  hp?: { current: number; max: number };
}

export interface UiNpc {
  id: string;
  name: string;
  color: string;
  avatar: string;
  status: string;
  controllerName?: string;
  isFocus: boolean;
  stats: { label: string; value: string }[];
}

export interface UiStackFrame {
  id: string;
  title: string;
  description: string;
  status: string;
  sourceName: string;
  targetName?: string;
  window?: {
    priority: boolean;
    deadline?: number;
    remaining?: number;
    eligible: { id: string; name: string; pending: boolean }[];
  };
}

export interface UiDecision {
  id: string;
  title: string;
  description: string;
  secret: boolean;
  policyLabel: string;
  deadline?: number;
  remaining?: number;
  participants: { id: string; name: string; committed: boolean }[];
}

export interface UiHook {
  instanceId: string;
  hookId: string;
  name: string;
  stage: string;
  priority: number;
  description: string;
  ownerName?: string;
  params: string;
}

export interface UiLogEntry {
  index: number;
  playerId: string;
  type: string;
  targetId?: string;
}

/* -------------------------------------------------------------------------- */
/* Recent activity feed                                                        */
/* -------------------------------------------------------------------------- */

export type UiHistoryKind =
  | 'damage'
  | 'heal'
  | 'trait'
  | 'move'
  | 'explore'
  | 'card'
  | 'dice'
  | 'combat'
  | 'haunt'
  | 'system';

/** One line in the "recent events" feed; newest first. */
export interface UiHistoryEntry {
  id: string;
  kind: UiHistoryKind;
  icon: string;
  title: string;
  detail?: string;
  /** Turn stamp so the player can tell when it happened. */
  round?: number;
  turn?: number;
  actorName?: string;
  actorColor?: string;
  /** Signed magnitude for numeric effects (-2 damage / +1 heal). */
  delta?: number;
  /** Trait display name when the entry is a trait change. */
  traitLabel?: string;
  /** Deaths and haunt turns stay pinned with emphasis. */
  critical?: boolean;
}

export interface UiReplay {
  ok: boolean;
  steps: number;
  errors: string[];
  expectedHash: string;
  actualHash: string;
}

export interface GameLog {
  entries: UiLogEntry[];
  cursor: number;
  total: number;
  seed: number;
  hash: string;
  replay?: UiReplay;
}

export interface UiCapabilities {
  simultaneousMoves: boolean;
  hiddenInformation: boolean;
  interruptStack: boolean;
  dynamicRules: boolean;
  nonPlayerActors?: boolean;
  topology: string;
  topologySpec?: {
    kind: string;
    adjacency: string;
    directed?: boolean;
    weighted?: boolean;
    geometry?: string;
    geometrySpec?: { cellSize?: number; hexOrientation?: 'pointy' | 'flat'; origin?: [number, number, number] };
    layers?: { id: string; name: string; index: number }[];
  };
}

export interface UiSpatialInfo {
  floors: { id: string; name: string; index: number }[];
  activeNodeId?: string;
  activeFloor?: string;
}

export interface UiPlacementDoorConnection {
  dir: 'N' | 'S' | 'E' | 'W' | string;
  dirZh: string;
  neighborRoomId?: string;
  neighborRoomName?: string;
  connected: boolean;
  status: 'connected' | 'blocked' | 'open';
}

export interface UiPlacement {
  defId: string;
  name: string;
  en?: string;
  floor: string;
  col: number;
  row: number;
  position: [number, number, number];
  rotations: number[];
  rotation: number;
  doors: string[];
  color: string;
  cost?: number;
  symbol?: string;
  text?: string;
  special?: string;
  tags?: string[];
  fromRoomId?: string;
  entryDir?: string;
  connections?: UiPlacementDoorConnection[];
}

export interface GameSnapshot {
  revision: number;
  gameId: string;
  gameName: string;
  capabilities: UiCapabilities;
  schemaCount: number;  dependencyErrors: string[];
  /** Selectable starting positions for the current game (empty = default only). */
  scenarios?: UiScenarioOption[];

  phaseLabel: string;
  /** Optional persistent objective line (Betrayal haunts, scenario missions). */
  mission?: string;
  round: number;
  turn: number;
  clock: number;
  actorName: string;
  focus: string[];
  /** Focus actors including NPCs. */
  focusActors: string[];
  viewer: ViewerId;
  viewers: { id: string; name: string }[];

  players: UiPlayer[];
  npcs: UiNpc[];
  actions: UiAction[];
  legalCount: number;

  stackDepth: number;
  stack: UiStackFrame[];
  decision?: UiDecision;
  openDecisions: number;

  hooks: UiHook[];
  log: GameLog;
  /** Newest-first ring buffer of recent events and actions. */
  history: UiHistoryEntry[];
  board: BoardState;
  spatial?: UiSpatialInfo;
  /** Drawn room tile awaiting orientation. */
  placement?: UiPlacement;

  gameOver: boolean;
  winnerLabel: string;
  /** Why the outcome fired, shown in the end-of-game overlay. */
  winnerReason?: string;
  /**
   * The most recent trait check, so the UI can animate the dice. Stays put
   * between rolls; consumers must diff it rather than assume it is fresh.
   */
  lastRoll?: UiRoll;
  /**
   * Why the acting explorer has no move/explore actions right now, in the player's
   * words. Empty when they can act normally. The dock uses it so "I cannot move"
   * always comes with a reason instead of a single silent END_TURN card.
   */
  blockedReason?: string;
}

/** One resolved dice roll, in the shape the UI needs to draw it. */
export interface UiRoll {
  /** Individual die faces, in roll order. */
  dice: number[];
  total: number;
  threshold?: number;
  success?: boolean;
  /** Trait the check used, for the caption. */
  trait?: string;
  /** The explorer's value in that trait before any bonuses. */
  traitValue?: number;
  /** What this check is for, in the player's words (shown before the dice). */
  effect?: string;
  /** Module tag for what the check was for (e.g. 'vault'). */
  reason?: string;
  /** Player-facing name of the thing being checked. */
  label?: string;
  /** Monotonic per-check counter; only moves when a check is actually rolled. */
  seq?: number;
  /** Stable stamp so the UI can tell one roll from the next. */
  stamp: string;
}

export type NoticeKind = 'announce' | 'event' | 'error';

/**
 * Overlay keys. The HUD keeps at most one overlay per key, so a hover preview and
 * a pinned sheet that share a key can never show two pictures of one subject.
 */
export function entityDetailKey(id: string): string {
  return `entity:${id}`;
}

export function nodeDetailKey(id: string): string {
  return `node:${id}`;
}

/** Key for a subject that has no board id (e.g. the dice cup). */
export function fixedDetailKey(name: string): string {
  return `fixed:${name}`;
}

/** One key/value row of a detail view. */
export interface UiDetailSection {
  label: string;
  value: string;
}

/** A shortcut rendered on the detail view (entity-centric actions). */
export interface UiDetailAction {
  id: string;
  icon: string;
  label: string;
}

/**
 * Game-agnostic description of one thing the player is inspecting.
 *
 * This used to be `UiCardDetail`, which carried 山屋's own card taxonomy
 * (OMEN / ITEM / EVENT / ROOM) in a DTO shared by every fixture. The taxonomy now
 * travels as data: `badge` is the already-localised band the game wants printed,
 * `tone` is an opaque visual token the HUD maps onto one of its neutral plates,
 * and `seal` is an optional decorative glyph.
 *
 * `key` identifies the subject (e.g. `entity:<id>`). The HUD keeps at most one
 * overlay per key, so a hover preview and a pinned sheet can never show two
 * different pictures of the same thing.
 */
export interface UiDetailView {
  key: string;
  title: string;
  /** Secondary line, typically the card's printed English name. */
  subtitle?: string;
  /** Category band text, localised by the game. */
  badge?: string;
  /** Opaque style token; unknown tokens fall back to the neutral plate. */
  tone?: string;
  /** Optional decorative glyph drawn beside the plate. */
  seal?: string;
  desc?: string;
  /** The subject's own artwork when the game ships one. */
  art?: string;
  sections: UiDetailSection[];
  actions: UiDetailAction[];
}

/** Structured trait movement attached to notices so the UI can animate it. */
export interface UiTraitChange {
  playerId: string;
  playerName: string;
  traitKey: string;
  traitLabel: string;
  from: number;
  to: number;
  /** Signed: negative loses pips. */
  delta: number;
  /** Physical/mental only when the change was damage. */
  damageKind?: 'PHYSICAL' | 'MENTAL';
  lethal?: boolean;
}

export interface UiNotice {
  kind: NoticeKind;
  icon: string;
  title: string;
  detail?: string;
  durationMs?: number;
  /** Optional tab to focus when this notice arrives. */
  tabHint?: 'G' | 'STACK' | 'FACTIONS' | 'HOOKS' | 'TIME';
  /** When present the HUD opens a detail overlay for this subject. */
  view?: UiDetailView;
  /** Board inspection target: the HUD pins the room dossier to this node. */
  roomId?: string;
  /** Trait movement to emphasise with a burst + banner. */
  trait?: UiTraitChange;
}

export type BoardPickKind = 'node' | 'edge' | 'entity' | 'dice';

export interface BoardPick {
  kind: BoardPickKind;
  id: string;
  metadata?: unknown;
}

export type CameraView = 'iso' | 'top' | 'seat';

/**
 * Presentation ports implemented by the composition root (main.ts).
 * Keeps camera/audio/panel concerns out of the presenter and UI.
 */
export interface PresentationPorts {
  setCamera(view: CameraView): void;
  setSound(enabled: boolean): void;
  isSoundOn(): boolean;
  toggleInspector(): void;
  /** Highlight board candidates for a targeting action (null clears). */
  highlightBoard(ids: string[] | null): void;
  /** Cinematic close-up on one board node (room inspection). */
  focusRoom?(nodeId: string): void;
  /** Return to the wide board framing after a close-up. */
  clearRoomFocus?(): void;
  /** 3D burst + match SFX for a trait movement (damage flash, heal sparkle). */
  showTraitChange?(change: UiTraitChange): void;
  /** Focus and isolate a specific floor ('ALL' frames the whole house). */
  setFloor?(floorId: string): void;
}

/** Application boundary used by the UI. */
export interface GamePresenter {
  getSnapshot(): GameSnapshot;
  subscribe(listener: (snapshot: GameSnapshot) => void): () => void;
  onNotice(listener: (notice: UiNotice) => void): () => void;

  /** Execute an action by its UI id (1:1 with the snapshot's action list). */
  perform(actionId: string, payload?: Record<string, unknown>, targets?: string[]): { ok: boolean; error?: string };

  /** Arm a PLACE_ENTITY action; the next highlighted node click resolves the slot. */
  armPlacement(actionId: string): { ok: boolean; error?: string };

  /** Cancel an armed placement without changing state. */
  cancelPlacement(): void;

  /** Map a click on the 3D board to a legal action, if any. */
  pickTarget(pick: BoardPick): { handled: boolean; message?: string };

  /** Rotate / confirm a preloaded room tile without opening a modal. */
  rotatePlacement(direction?: 1 | -1): void;
  confirmPlacement(): { ok: boolean; error?: string };

  setViewer(viewer: ViewerId): void;
  rewind(step: number): void;
  verifyReplay(): void;
  /** Advance the kernel's logical clock; expired windows resolve deterministically. */
  advanceClock(ticks: number): void;
  dispose(): void;
}

export interface GameTab {
  id: string;
  icon: string;
  name: string;
}

/** Static presentation catalog; labels are marketing copy, not domain data. */
export const GAME_TABS: GameTab[] = [
  { id: 'catan', icon: '🏝️', name: '卡坦岛' },
  { id: 'sanguosha', icon: '⚔️', name: '三国杀' },
  { id: 'splendor', icon: '💎', name: '璀璨宝石' },
  { id: 'betrayal', icon: '🕯️', name: '山屋惊魂' },
  { id: 'dune_mahjong', icon: '🀄', name: '沙丘 & 麻将' },
  { id: 'poker', icon: '♠️', name: '德州扑克' }
];

/** One selectable starting position of the current game. */
export interface UiScenarioOption {
  id: string;
  description: string;
  selected: boolean;
}
