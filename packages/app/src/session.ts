import { UniversalGameEngine } from '@rds/kernel/engine';
import { describeActionView } from './actionText';
import { applyActionCooldowns } from './actionCooldown';
import { buildEntityInspectNotice, buildMoment, buildNodeDiscoveryView, resolveDefaultViewer } from './inspect';
import { buildObserverRoster } from './observers';
import { GameModule } from '@rds/kernel/module';
import { Action, ActorId, GameState, PlayerId, ProjectedGameState, SelectionCandidate, SelectionSpec, VisualTraceEvent,
  type EffectInstance
} from '@rds/kernel/types';
import { topDecision } from '@rds/kernel/decisions';
import { InterruptStackManager } from '@rds/kernel/stack';
import {
  BoardPick,
  GamePresenter,
  GameSnapshot,
  UiAction,
  UiActionField,
  UiHandCard,
  UiPrompt,
  UiRisk,
  UiSurface,
  UiVerb,
  UiChipRank,
  UiDecision,
  UiDiscoveryView,
  UiHistoryEntry,
  UiHistoryKind,
  UiHook,
  UiMoment,
  UiMomentAction,
  UiNotice,
  UiNpc,
  UiPlacement,
  UiPlacementDoorConnection,
  UiPlayer,
  UiReplay,
  UiSpatialInfo,
  UiStackFrame,
  UiTraitChange,
  ViewerId,
  UiRoll,
  type UiEffect
} from './contracts';

/** Visual event type → activity-feed bucket. */
const EVENT_KIND: Record<string, UiHistoryKind> = {
  DAMAGE_EFFECT: 'damage',
  DICE_ROLL: 'dice',
  CARD_DRAW: 'card',
  CARD_DISCARD: 'card',
  CARD_PLAY: 'card',
  EXPLORE_ROOM: 'explore',
  MOVE_OBJECT: 'move',
  RULE_MUTATE: 'haunt',
  DECISION_REVEAL: 'system',
  DECISION_TIMEOUT: 'system',
  STACK_TIMEOUT: 'system',
  STACK_PUSH: 'combat',
  STACK_POP: 'combat',
  STACK_CANCEL: 'combat',
  BUILD_OBJECT: 'system',
  TOKEN_TRANSFER: 'system',
  ANNOUNCEMENT: 'system'
};

const EVENT_ICON: Record<string, string> = {
  DAMAGE_EFFECT: '🩸',
  DICE_ROLL: '🎲',
  CARD_DRAW: '🃏',
  CARD_DISCARD: '🗑',
  CARD_PLAY: '✨',
  EXPLORE_ROOM: '🚪',
  MOVE_OBJECT: '👣',
  RULE_MUTATE: '☠',
  DECISION_REVEAL: '💥',
  DECISION_TIMEOUT: '⏱',
  STACK_TIMEOUT: '⏱',
  STACK_PUSH: '⚔',
  STACK_POP: '⚔',
  STACK_CANCEL: '⛔',
  BUILD_OBJECT: '🏗',
  TOKEN_TRANSFER: '◆',
  ANNOUNCEMENT: '❖'
};

/** How many feed lines the presenter keeps before dropping the oldest. */
const HISTORY_LIMIT = 60;

export interface BoundAction {
  ui: UiAction;
  action?: Action;
  highlight?: string[];
  type?: string;
  idKey?: 'targetEdgeId' | 'targetNodeId' | 'entityId';
  /**
   * 目标塌缩后的候选表：候选 id（targetPlayerId）→ 那条具体合法动作。
   *
   * 一张「杀」在合法动作里其实有 N 条（每个目标一条）。手牌只显示一张，玩家在
   * 径向选择器里点谁，就派发哪一条——合法性仍由引擎判定，UI 不自造规则。
   */
  targetVariants?: Map<string, Action>;
  /** 动作族塌缩：family key → 具体合法动作。 */
  variantVariants?: Map<string, Action>;
}

/**
 * 面板动作携带的自由元数据（由各游戏的呈现层写入）。
 *
 * 这里以前是 15 处 `(pick.metadata as any)`，等于放弃类型检查；现在集中成一个
 * 结构化类型，读不到的键统一走索引签名（issue #234）。
 */
interface PickMetadata {
  intent?: string;
  type?: string;
  feature?: string;
  action?: string;
  targetRoomId?: string;
  targetName?: string;
  direction?: string;
  [key: string]: unknown;
}

interface ActiveBoardGroup {
  type: string;
  idKey: 'targetEdgeId' | 'targetNodeId' | 'entityId';
  targets: string[];
}

/** 读面板动作的元数据；缺失时给空对象，避免到处判空。 */
const metaOf = (pick: { metadata?: unknown }): PickMetadata => (pick.metadata ?? {}) as PickMetadata;

const EVENT_ICONS: Record<string, string> = {
  CARD_DRAW: '🎴',
  CARD_PLAY: '✧',
  CARD_DISCARD: '🗂️',
  DICE_ROLL: '🎲',
  TOKEN_TRANSFER: '◈',
  BUILD_OBJECT: '🔨',
  MOVE_OBJECT: '➜',
  EXPLORE_ROOM: '🚪',
  STACK_PUSH: '⤒',
  STACK_POP: '⤓',
  STACK_CANCEL: '⊘',
  STACK_TIMEOUT: '⏱',
  DECISION_TIMEOUT: '⏱',
  RULE_MUTATE: '☠',
  DAMAGE_EFFECT: '✸',
  DECISION_OPEN: '🔓',
  DECISION_COMMIT: '🔒',
  DECISION_REVEAL: '💥'
};

/**
 * Application layer: owns the engine, translates its read models into UI DTOs,
 * and exposes only the presenter contract. The UI never imports the engine.
 */
export class UniversalSession implements GamePresenter {
  private readonly engine: UniversalGameEngine;
  private readonly module: GameModule;
  private readonly unsubscribers: (() => void)[] = [];
  private readonly scenario?: string;

  private revision = 0;
  private snapshot!: GameSnapshot;
  private bound: BoundAction[] = [];
  /** 内置 AI 的下一步定时器：按游戏声明的节奏逐步派发它的具体动作。 */
  private aiTimer: ReturnType<typeof setTimeout> | null = null;
  /** 周期性规则（观察者低保）的驱动定时器；内核本身无时钟。 */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** 各动作类型第一次变得可用的时刻，用于动作冷却（结算后 20 秒才能开下一手）。 */
  private readonly actionSeenAt = new Map<string, number>();
  private activeBoardGroup?: ActiveBoardGroup;
  private armedPlacement?: { entityId: string };
  private placementRotation?: number;
  private lastReplay?: UiReplay;

  private listeners = new Set<(snapshot: GameSnapshot) => void>();
  private noticeListeners = new Set<(notice: UiNotice) => void>();
  private visualListeners = new Set<(events: VisualTraceEvent[]) => void>();
  /**
   * 离开牌桌的收尾工作由装配根提供（回到大厅 / 回到登录入口）。规则层不认识
   * 「大厅」，所以幕布上的「退出牌桌」按钮只是把这件事交给宿主。
   */
  private onLeaveTable?: () => void;

  /** Newest-first activity feed; trimmed to HISTORY_LIMIT. */
  private history: UiHistoryEntry[] = [];
  private historySeq = 0;
  /** Last seen trait indexes per player, used to detect pips moving. */
  private lastTraitIndex = new Map<string, Record<string, number>>();
  /** Trait notices collected during rebuild, flushed after publish. */
  private pendingTraitNotices: UiNotice[] = [];

  /**
   * @param engine 可选注入已有引擎（中期项 A2）：房主联机时 UniversalSession
   *               与权威 GameRoom 共用同一个实例，HUD 的 dispatch 直接就是
   *               权威状态跃迁，无需二次重放同步。
   * @param seats  可选座位数：本地/单机演示时按 URL 的 `?seats=` 指定人数，
   *               避免"2 人房间摆了 4 个座位"这类空座位死局。
   */
  constructor(
    module: GameModule,
    seed = 1,
    scenario?: string,
    engine?: UniversalGameEngine,
    seats?: number
  ) {
    this.module = module;
    this.scenario = scenario;
    const engineOptions = {
      ...(scenario ? { scenario } : {}),
      ...(seats === undefined ? {} : { seats }),
      // 声明了 AI 节奏的游戏交给本会话逐步驱动 AI，否则内核内联推进。
      ...(module.driver?.aiActionDelayMs ? { autoAi: false } : {})
    };
    this.engine =
      engine ??
      new UniversalGameEngine(
        module,
        seed,
        Object.keys(engineOptions).length > 0 ? engineOptions : undefined
      );

    // 单人桌开局先绑定「主角座位」：声明走能力（`presentation.defaultViewer`），
    // 通用层不认识任何游戏的座位结构。注入引擎的路径（联机房主）座位由房间
    // 决定，调用方会显式 `setViewer`，这里不能抢。绑定放在订阅之前，因此开局
    // 仍然只有一次 rebuild、revision 从 0 起算——视角是初始状态，不是一次变更。
    if (!engine) this.bindDefaultViewer();

    this.unsubscribers.push(
      this.engine.onStateChange(() => {
        this.revision += 1;
        this.lastReplay = undefined;
        this.rebuild();
        this.publish();
        this.scheduleAiTurn();
      })
    );

    this.unsubscribers.push(
      this.engine.onVisualEvent(events => {
        for (const listener of this.visualListeners) listener(events);
        for (const event of events) {
          this.recordHistory(event);
          this.emitEventNotice(event.type, event.title, event.durationMs);
        }
      })
    );

    this.rebuild();
    // 开局若先轮到 AI（例如房间补位），也从这里启动节奏。
    this.scheduleAiTurn();
    this.startHeartbeat();
  }

  /**
   * Bind the table to the seat the game declares as the local protagonist.
   *
   * 单人桌默认开在上帝视角，可玩起来主角只有一个。没声明、声明的人不在桌上，
   * 都保持原视角——静默失败比把镜头绑到不存在的座位上好。
   */
  private bindDefaultViewer(): void {
    const seat = resolveDefaultViewer(this.module, this.engine.getRawState(), undefined);
    if (seat) this.engine.setViewer(seat);
  }

  /* ------------------------------------------------------------------ */
  /* GamePresenter                                                       */
  /* ------------------------------------------------------------------ */

  public getSnapshot(): GameSnapshot {
    return this.snapshot;
  }

  /** Discovery view for a map node, resolved by the game presentation hints. */
  public nodeDetail(nodeId: string): UiDiscoveryView | null {
    return buildNodeDiscoveryView(this.snapshot.board.mapGraph.nodes[nodeId], { module: this.module });
  }

  /**
   * 幕布按 (revision, viewer) 记忆（issue #222）。
   *
   * HUD 每帧都会问一次 `moment()`，而 `describeMoment` 是游戏自定义函数（可能遍历
   * 整张牌桌）。同一帧里重复计算纯属浪费，这里缓存到下一次状态变化为止。
   */
  private momentCache?: { revision: number; viewer: string; value: UiMoment | null };

  /** Full-screen beat declared by the game (a haunt starting), or null. */
  public moment(): UiMoment | null {
    const viewerKey = String(this.snapshot?.viewer ?? '');
    if (this.momentCache && this.momentCache.revision === this.revision && this.momentCache.viewer === viewerKey) {
      return this.momentCache.value;
    }
    // The snapshot's board is already the viewer's projection, so the curtain
    // reads the same masked cards the table shows — no second projection pass.
    const state = this.snapshot.board;
    const moment = buildMoment(state, this.snapshot.mission, {
      module: this.module,
      viewer: this.snapshot.viewer,
      handOf: playerId => projectedHandOf(state, playerId)
    });
    const value = moment ? this.resolveMomentActions(moment) : null;
    this.momentCache = { revision: this.revision, viewer: viewerKey, value };
    return value;
  }

  /** 宿主接管「退出牌桌」：单机是回到入口页，联机是回到大厅。 */
  public setLeaveTableHandler(handler: () => void): void {
    this.onLeaveTable = handler;
  }

  /**
   * 幕布按钮落到具体能力。
   *
   * `actionTypes` 是内核动作类型，取**当前合法**的第一个派发；一个都不合法时
   * 按钮置灰并显示冷却提示，绝不发一个会被拒的动作。`leave` 交给宿主。
   */
  public performMomentAction(id: string): { ok: boolean; error?: string } {
    const button = this.moment()?.actions?.find(action => action.id === id);
    return this.takeMomentButton(button, this.onLeaveTable);
  }

  /** 按钮 → 能力（见 `takeMomentButton`）。 */
  private takeMomentButton(
    button: UiMomentAction | undefined,
    leave: (() => void) | undefined
  ): { ok: boolean; error?: string } {
    return takeMomentButton(button, this.bound, leave, id => this.perform(id));
  }

  /** 把游戏声明的按钮与当前合法动作对齐（见 `resolveMomentButtons`）。 */
  private resolveMomentActions(moment: UiMoment): UiMoment {
    return resolveMomentButtons(moment, this.bound);
  }

  /** Localised role name from the game, or null when it has no such role. */
  public roleLabel(role: string): string | null {
    return this.module.presentation?.roleLabel?.(role) ?? null;
  }

  /** The map node a player stands on, from the game's own hint. */
  public playerNodeId(playerId: string): string | null {
    const hint = this.module.presentation?.playerNode;
    if (!hint) return null;
    const raw = this.engine.getRawState();
    return hint((raw.players[playerId]?.customProps ?? {}) as Record<string, unknown>);
  }

  /** Non-player figures on the map, as declared by the game. */
  public castMembers(): { nodeId: string; label: string }[] {
    const hint = this.module.presentation?.castMember;
    if (!hint) return [];
    const out: { nodeId: string; label: string }[] = [];
    for (const entity of Object.values(this.engine.getRawState().entities ?? {})) {
      const cast = hint((entity?.components?.custom ?? {}) as Record<string, unknown>);
      if (cast) out.push(cast);
    }
    return out;
  }

  /** Loot summary for a room, or null when it holds nothing. */
  public roomLoot(roomId: string): { label: string; count: number } | null {
    const hint = this.module.presentation?.roomLoot;
    if (!hint) return null;
    return hint(
      Object.values(this.engine.getRawState().entities ?? {}).map(entity => ({
        zoneId: entity?.zoneId,
        custom: (entity?.components?.custom ?? {}) as Record<string, unknown>
      })),
      roomId
    );
  }

  /** Badge for a game token, or null when the game does not know it. */
  public tokenBadge(token: string): { label: string; glyph?: string } | null {
    return this.module.presentation?.tokenBadge?.(token) ?? null;
  }

  /** Localised trait name, or null when the game has no such trait. */
  public traitLabel(traitKey: string): string | null {
    return this.module.presentation?.describeTrait?.(traitKey)?.label ?? null;
  }

  public subscribe(listener: (snapshot: GameSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  public onNotice(listener: (notice: UiNotice) => void): () => void {
    this.noticeListeners.add(listener);
    return () => this.noticeListeners.delete(listener);
  }

  /** Forward kernel visual events to a renderer/animation port. */
  public onVisualEvent(listener: (events: VisualTraceEvent[]) => void): () => void {
    this.visualListeners.add(listener);
    return () => this.visualListeners.delete(listener);
  }

  /**
   * 观察席「重新上桌」：向引擎申请换桌，座位由游戏随机挑一个 AI，本轮结束后
   * 才真正落座。这里只负责把申请发出去，扣筹码、换座位都在 reduce 里。
   */
  public rejoinTable(playerId: string): { ok: boolean; error?: string } {
    const action = this.engine
      .getLegalActions(playerId)
      .find(entry => entry.type === 'OBSERVER_REJOIN');
    if (!action) return { ok: false, error: '还不能上桌：等低保攒够买入，或已在本轮排队' };
    const result = this.engine.dispatch(action);
    return result.ok ? { ok: true } : { ok: false, error: result.error ?? '重新上桌失败' };
  }

  public perform(
    actionId: string,
    payload?: Record<string, unknown>,
    targets?: string[]
  ): { ok: boolean; error?: string } {
    // 玩家（含上帝视角替 AI 出手）一旦自己动手，就取消排好的 AI 自动步，
    // 否则 5 秒后 AI 会替同一座位再走一步。
    if (this.aiTimer !== null) {
      clearTimeout(this.aiTimer);
      this.aiTimer = null;
    }
    const bound = this.bound.find(entry => entry.ui.id === actionId);
    if (!bound) return { ok: false, error: `unknown action: ${actionId}` };

    // 冷却未走完就拒绝：结算是给人读的，不是点一下就跳过。
    if (bound.ui.cooldownMs && bound.ui.cooldownMs > 0) {
      return { ok: false, error: `还需 ${Math.ceil(bound.ui.cooldownMs / 1000)} 秒才能开下一手` };
    }

    if (bound.highlight && !bound.action) {
      if (bound.type && bound.idKey) {
        this.activeBoardGroup = { type: bound.type, idKey: bound.idKey, targets: bound.highlight };
      }
      this.emit({
        kind: 'event',
        icon: '✧',
        title: `已高亮 ${bound.highlight.length} 个合法位置，请在 3D 桌面上点击目标`,
        durationMs: 2800
      });
      return { ok: true };
    }
    this.activeBoardGroup = undefined;

    if (!bound.action) return { ok: false, error: 'action has no dispatch payload' };

    const action: Action = { ...bound.action };
    if (payload && Object.keys(payload).length > 0) {
      action.payload = { ...(bound.action.payload ?? {}), ...payload };
    }
    if (targets && bound.variantVariants) {
      const key = [...targets].sort().join('|');
      const chosen = bound.variantVariants.get(key);
      if (!chosen) return { ok: false, error: '无效的动作族选择' };
      return this.dispatch({
        ...chosen,
        ...(payload ? { payload: { ...(chosen.payload ?? {}), ...payload } } : {})
      });
    }
    if (targets && targets.length === 1 && bound.targetVariants?.has(targets[0])) {
      // 目标塌缩的卡片：用玩家选中的目标换回那条具体动作再派发。
      const chosen = bound.targetVariants.get(targets[0]) as Action;
      return this.dispatch({ ...chosen, ...(payload ? { payload: { ...(chosen.payload ?? {}), ...payload } } : {}) });
    }
    if (targets && targets.length > 0) action.targets = targets;

    return this.dispatch(action);
  }

  public pickTarget(pick: BoardPick): { handled: boolean; message?: string } {
    if (this.armedPlacement) {
      if (pick.kind !== 'node') {
        return { handled: false, message: '请点击高亮的房间节点' };
      }
      const entityId = this.armedPlacement.entityId;
      this.armedPlacement = undefined;
      const result = this.placeEntityAtNode(entityId, pick.id);
      return { handled: result.ok, message: result.error };
    }
    const focus = this.engine.getFocusActors();
    const actor =
      this.engine.getViewer() !== 'GOD'
        ? this.engine.getViewer()
        : focus[0] ?? this.engine.getActiveActorId();
    const legal = this.engine.getLegalActions(actor);

    // In-world placement rotation / confirmation gizmos
    if (this.snapshot.placement) {
      if (pick.id === 'placement_rotate' || metaOf(pick).intent === 'rotate') {
        this.rotatePlacement(1);
        return { handled: true };
      }
      if (pick.id === 'placement_confirm' || metaOf(pick).intent === 'confirm') {
        const res = this.confirmPlacement();
        return { handled: res.ok, message: res.error };
      }
    }

    // In-world actionable room feature (currently the vault)
    if (metaOf(pick).type === 'ROOM_FEATURE') {
      const feature = String(metaOf(pick).feature ?? '');
      const action = legal.find(
        a => a.type === 'ROOM_FEATURE' && String(a.payload?.feature ?? '') === feature
      );
      if (!action) return { handled: false, message: '当前无法触发该房间特性' };
      const res = this.dispatch(action);
      return { handled: res.ok, message: res.error };
    }

    // In-world special traversal badge (stairs / drop / rappel / lift)
    if (metaOf(pick).type === 'SPECIAL_MOVE') {
      const action = String(metaOf(pick).action ?? '');
      const targetRoomId = String(metaOf(pick).targetRoomId ?? '');
      const targetName = metaOf(pick).targetName ?? '目标房间';

      if (action === 'USE_ELEVATOR') {
        // The ride rolls first. Arming a board group here used to highlight every
        // explored room before any dice were thrown; now the roll happens, and the
        // destination picker opens as its own ELEVATOR_MOVE action afterwards.
        const elevator = legal.find(a => a.type === 'USE_ELEVATOR');
        if (!elevator) return { handled: false, message: '电梯本回合已使用' };
        const ride = this.dispatch({ ...elevator });
        if (!ride.ok) return { handled: false, message: ride.error ?? '无法启动电梯' };
        this.emit({
          kind: 'event',
          icon: '🛗',
          title: '神秘电梯启动 · 先掷骰再决定去向',
          durationMs: 2600
        });
        return { handled: true };
      }
      const special = legal.find(a => a.type === action);
      if (!special) {
        return { handled: false, message: `当前无法执行该特殊移动` };
      }
      // Selection-bound actions must keep their exact binding: adding a
      // targetNodeId the legal action does not carry makes the engine reject it.
      const payload =
        action === 'CLIMB_UP' && targetRoomId
          ? { ...special, targetNodeId: targetRoomId }
          : { ...special };
      const res = this.dispatch(payload);
      if (res.ok) {
        this.emit({
          kind: 'event',
          icon: action === 'JUMP_DOWN' ? '⬇' : '🪢',
          title:
            action === 'JUMP_DOWN' ? `纵身跃下，落入【${targetName}】` : `沿绳索攀上【${targetName}】`,
          durationMs: 2600,
          roomId: targetRoomId
        });
      }
      return { handled: res.ok, message: res.error };
    }

    // In-world room navigation arrow hotspot (moving to adjacent room)
    if (metaOf(pick).type === 'ROOM_NAV') {
      const targetRoomId = String(metaOf(pick).targetRoomId ?? '');
      const targetName = metaOf(pick).targetName ?? '相邻房间';
      const moveAction = legal.find(
        a =>
          a.type === 'MOVE_TO_ROOM' &&
          (a.targetNodeId === targetRoomId ||
            (a.selection?.scope as { neighbors?: string[] } | undefined)?.neighbors?.includes(targetRoomId))
      );
      if (moveAction) {
        const res = this.dispatch({
          ...moveAction,
          targets: [targetRoomId]
        });
        if (res.ok) {
          this.emit({
            kind: 'event',
            icon: '🚪',
            title: `走入了【${targetName}】`,
            durationMs: 1800,
            roomId: targetRoomId
          });
        }
        return { handled: res.ok, message: res.error };
      }
      const moveNpcAction = legal.find(a => a.type === 'MOVE_NPC' && a.targetNodeId === targetRoomId);
      if (moveNpcAction) {
        const res = this.dispatch(moveNpcAction);
        return { handled: res.ok, message: res.error };
      }
    }

    // In-world door exploration hotspot
    if (metaOf(pick).type === 'DOOR') {
      const dir = metaOf(pick).direction;
      const meta = metaOf(pick);
      if (meta?.elevator) {
        // The elevator pick names a doorway, so match on room + direction.
        const rideAction = legal.find(
          a =>
            a.type === 'ELEVATOR_MOVE' &&
            a.targetNodeId === meta.roomId &&
            a.payload?.direction === meta.direction
        );
        if (!rideAction) return { handled: false, message: '这里停不了电梯' };
        const res = this.dispatch(rideAction);
        return { handled: res.ok, message: res.error };
      }
      const exploreAction = legal.find(a => a.type === 'EXPLORE_DOOR' && a.payload?.direction === dir);
      if (exploreAction) {
        const res = this.dispatch(exploreAction);
        return { handled: res.ok, message: res.error };
      }
    }

    // Direct entity/board interaction from 3D viewport clicks
    const isDirectInteract = metaOf(pick).intent === 'interact';
    if (isDirectInteract && !this.activeBoardGroup) {
      if (pick.kind === 'node') {
        const directMoveAction = legal.find(
          a =>
            a.type === 'MOVE_TO_ROOM' &&
            (a.targetNodeId === pick.id ||
              (a.selection?.scope as { neighbors?: string[] } | undefined)?.neighbors?.includes(pick.id))
        );
        if (directMoveAction) {
          // Selection-bound actions carry their target in `targets`; adding a
          // targetNodeId would change the canonical binding and be rejected.
          const res = this.dispatch({
            ...directMoveAction,
            targets: [pick.id]
          });
          return { handled: res.ok, message: res.error };
        }
        const directNpcAction = legal.find(a => a.type === 'MOVE_NPC' && a.targetNodeId === pick.id);
        if (directNpcAction) {
          const res = this.dispatch(directNpcAction);
          return { handled: res.ok, message: res.error };
        }
      } else if (pick.kind === 'entity') {
        const directCombatAction =
          legal.find(a => a.type === 'ATTACK_MONSTER' && a.entityId === pick.id) ??
          legal.find(a => a.type === 'ATTACK_HERO' && a.targetPlayerId === pick.id) ??
          legal.find(a => a.type === 'SLAP' && a.targetPlayerId === pick.id);
        if (directCombatAction) {
          const res = this.dispatch(directCombatAction);
          return { handled: res.ok, message: res.error };
        }
      }
    }

    // Entity clicks are inspection first unless the action dock explicitly
    // selected a board-targeting action (e.g. pick up from the room pile).
    if (pick.kind === 'entity' && !this.activeBoardGroup) {
      const notice = buildEntityInspectNotice(this.snapshot.board.entities[pick.id], {
        snapshot: this.snapshot,
        module: this.module
      });
      if (notice) {
        this.emit(notice);
        return { handled: true };
      }
    }

    // Board clicks are inspection-first. Moving/building requires the player
    // to arm a targeting action from the dock; a stray node/edge click must
    // never dispatch a legal action implicitly.
    if ((pick.kind === 'node' || pick.kind === 'edge') && !this.activeBoardGroup) {
      const node = this.snapshot.board.mapGraph.nodes[pick.id];
      const edge = this.snapshot.board.mapGraph.edges[pick.id];
      const isRoom = pick.kind === 'node' && node?.type === 'ROOM';
      const title =
        pick.kind === 'node'
          ? String(node?.props?.name ?? node?.type ?? '节点')
          : String(edge?.id ?? '边');
      this.emit({
        kind: 'event',
        icon: isRoom ? '🏚' : '🔍',
        title: isRoom ? `察看了 ${title}` : `已选中 ${title}`,
        detail: isRoom
          ? '房间档案已更新；点 ◎ 可拉近镜头观察陈设。'
          : '这是查看操作；移动/建造请先从动作栏选择动作。',
        durationMs: 2600,
        roomId: isRoom ? pick.id : undefined
      });
      return { handled: true };
    }

    const match = (() => {
      if (this.activeBoardGroup) {
        return legal.find(
          action =>
            action.type === this.activeBoardGroup!.type &&
            action[this.activeBoardGroup!.idKey] === pick.id
        );
      }
      if (pick.kind === 'dice') {
        return legal.find(a => a.type === 'ROLL_DICE') ?? legal.find(a => a.type === 'ROLL_HAUNT_CHECK');
      }
      if (pick.kind === 'node') {
        return (
          legal.find(a => a.type === 'SETUP_SETTLEMENT' && a.targetNodeId === pick.id) ??
          legal.find(a => a.type === 'BUILD_SETTLEMENT' && a.targetNodeId === pick.id) ??
          legal.find(a => a.type === 'UPGRADE_CITY' && a.targetNodeId === pick.id) ??
          legal.find(a => a.type === 'MOVE_TO_ROOM' && a.targetNodeId === pick.id) ??
          legal.find(a => a.type === 'MOVE_NPC' && a.targetNodeId === pick.id) ??
          legal.find(a => a.type === 'MOVE_ROBBER' && a.targetNodeId === pick.id)
        );
      }
      if (pick.kind === 'edge') {
        return (
          legal.find(a => a.type === 'SETUP_ROAD' && a.targetEdgeId === pick.id) ??
          legal.find(a => a.type === 'BUILD_ROAD' && a.targetEdgeId === pick.id) ??
          legal.find(a => a.type === 'BUILD_ROAD_FREE' && a.targetEdgeId === pick.id)
        );
      }
      return (
        legal.find(a => a.entityId === pick.id) ??
        (() => {
          const selectionAction = legal.find(
            action =>
              !!action.selection &&
              this.engine
                .getSelectionCandidates(action.actorId ?? action.playerId, action.selection)
                .some(candidate => candidate.id === pick.id)
          );
          return selectionAction ? { ...selectionAction, targets: [pick.id] } : undefined;
        })()
      );
    })();

    if (!match) {
      const message = '该对象当前不是合法目标。可先在动作栏选择动作，桌面会高亮全部候选位置。';
      this.emit({ kind: 'error', icon: '◌', title: message, durationMs: 2800 });
      return { handled: false, message };
    }

    this.activeBoardGroup = undefined;
    const result = this.dispatch(match);
    return { handled: result.ok, message: result.error };
  }

  /** 联机对局传入每房随机的别名密钥，隐藏实体虚拟 ID 改为 HMAC。 */
  public setAliasSecret(secret: string): void {
    this.engine.setAliasSecret(secret);
  }

  public setViewer(viewer: ViewerId): void {
    // Targeting is viewer-scoped; switching seats must not leave stale highlights.
    this.activeBoardGroup = undefined;
    this.engine.setViewer(viewer);
  }

  /**
   * 阶段一：联机身份映射。房主开局前一次性把 hub 昵称/头像写进内核 Player
   * （仅展示字段，不触碰任何规则），snapshot 会把它同步给所有房客。
   */
  public renamePlayer(id: PlayerId, name: string, avatarUrl?: string): void {
    const player = this.engine.getRawState().players[id];
    if (!player || !name) return;
    player.name = String(name).slice(0, 24);
    if (avatarUrl) player.avatarUrl = avatarUrl;
    this.rebuild();
    this.publish();
  }

  private placementStorageKey(defId: string): string {
    return `dsh:placement:${this.module.meta.id}:${this.engine.getSeed()}:${this.scenario ?? ''}:${defId}`;
  }

  private readStoredRotation(defId: string): number | undefined {
    try {
      if (typeof sessionStorage === 'undefined') return undefined;
      const raw = sessionStorage.getItem(this.placementStorageKey(defId));
      if (!raw) return undefined;
      const value = Number(JSON.parse(raw).rotation);
      return Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private storeRotation(defId: string, rotation: number): void {
    try {
      if (typeof sessionStorage === 'undefined') return;
      sessionStorage.setItem(this.placementStorageKey(defId), JSON.stringify({ rotation }));
    } catch {
      // Storage is an enhancement; placement still works without it.
    }
  }

  private clearStoredRotation(defId: string): void {
    try {
      if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(this.placementStorageKey(defId));
    } catch {
      // ignore
    }
  }

  public rotatePlacement(direction: 1 | -1 = 1): void {
    const placement = this.snapshot.placement;
    if (!placement || placement.rotations.length === 0) return;
    const index = placement.rotations.indexOf(placement.rotation);
    const next = (index + direction + placement.rotations.length) % placement.rotations.length;
    this.placementRotation = placement.rotations[next];
    this.storeRotation(placement.defId, this.placementRotation);
    this.rebuild();
    this.publish();
  }

  public confirmPlacement(): { ok: boolean; error?: string } {
    const placement = this.snapshot.placement;
    if (!placement) return { ok: false, error: 'no pending room placement' };
    const bound = this.bound.find(entry => entry.action?.type === 'PLACE_ROOM');
    if (!bound) return { ok: false, error: 'placement action is not legal' };
    const result = this.perform(bound.ui.id, { rotation: String(placement.rotation) });
    if (result.ok) {
      this.clearStoredRotation(placement.defId);
      this.placementRotation = undefined;
    }
    return result;
  }

  /**
   * Resolve a drag/drop target node to the first legal slot action for the
   * entity. Rules remain module-owned; this only selects a bound UI action.
   */
  public placeEntityAtNode(entityId: string, nodeId?: string): { ok: boolean; error?: string } {    const raw = this.engine.getRawState();
    const entity = raw.entities[entityId];
    if (!entity) return { ok: false, error: `unknown entity: ${entityId}` };
    const actorId = entity.ownerId ?? raw.activeActorId ?? raw.activePlayerId;
    const actor = raw.players[actorId] ?? raw.npcs?.[actorId];
    const currentRoomId = String(actor?.customProps?.currentRoomId ?? actor?.customProps?.roomId ?? '');
    const targetRoomId = nodeId || currentRoomId;
    const trySlots = (roomId: string) => {
      const slots = Object.values(raw.mapGraph.slots ?? {}).filter(slot => {
        if (slot.nodeId !== roomId) return false;
        if (slot.accepts?.entityTypes && !slot.accepts.entityTypes.includes(entity.type)) return false;
        return true;
      });
      for (const slot of slots) {
        const bound = this.bound.find(
          entry =>
            entry.action?.type === 'PLACE_ENTITY' &&
            entry.action.entityId === entityId &&
            entry.action.targetSlotId === slot.id
        );
        if (bound) return this.perform(bound.ui.id);
      }
      return undefined;
    };

    const direct = trySlots(targetRoomId);
    if (direct) return direct;
    // Items are only legal in the actor's current room; if the pointer landed
    // on an overlapping/other room, fall back to the owner's room.
    if (currentRoomId && targetRoomId !== currentRoomId) {
      const fallback = trySlots(currentRoomId);
      if (fallback) return fallback;
    }
    return { ok: false, error: '该实体没有可放置到目标房间的合法位置' };
  }

  /** Valid node targets for drag-start highlighting. */
  public getPlacementTargets(entityId: string): { nodeId: string; slotId: string; label: string }[] {
    const raw = this.engine.getRawState();
    const entity = raw.entities[entityId];
    if (!entity) return [];
    const targets: { nodeId: string; slotId: string; label: string }[] = [];
    for (const slot of Object.values(raw.mapGraph.slots ?? {})) {
      if (!slot.nodeId) continue;
      if (slot.accepts?.entityTypes && !slot.accepts.entityTypes.includes(entity.type)) continue;
      const bound = this.bound.find(
        entry =>
          entry.action?.type === 'PLACE_ENTITY' &&
          entry.action.entityId === entityId &&
          entry.action.targetSlotId === slot.id
      );
      if (!bound) continue;
      const node = raw.mapGraph.nodes[slot.nodeId];
      targets.push({
        nodeId: slot.nodeId,
        slotId: slot.id,
        label: String(node?.props?.name ?? slot.nodeId)
      });
    }
    return targets;
  }

  public armPlacement(actionId: string): { ok: boolean; error?: string } {
    const bound = this.bound.find(entry => entry.ui.id === actionId);
    if (!bound?.action || bound.action.type !== 'PLACE_ENTITY' || !bound.action.entityId) {
      return { ok: false, error: '该动作不支持目标点选' };
    }
    this.armedPlacement = { entityId: bound.action.entityId };
    this.emit({ kind: 'event', icon: '◎', title: '请点击高亮的目标房间', durationMs: 2200 });
    return { ok: true };
  }

  public cancelPlacement(): void {
    this.armedPlacement = undefined;
  }

  public rewind(step: number): void {
    this.engine.rewindToStep(step);
  }

  public verifyReplay(): void {
    const report = this.engine.verifyReplay();
    this.lastReplay = {
      ok: report.ok,
      steps: report.steps,
      errors: report.errors,
      expectedHash: report.expectedHash,
      actualHash: report.actualHash
    };
    this.rebuild();
    this.publish();
  }

  public advanceClock(ticks = 1): void {
    const result = this.engine.dispatch({
      type: '__TICK__',
      playerId: 'SYSTEM',
      payload: { ticks }
    });
    if (!result.ok) {
      this.emit({ kind: 'error', icon: '⏱', title: result.error ?? 'clock advance rejected', durationMs: 3000 });
    }
  }

  /**
   * 让内置 AI 按游戏声明的节奏出手。
   *
   * AI 与真人同一条管线：`legalActions` 直接给出它这一步要做的具体动作，这里
   * 只按 `aiActionDelayMs` 的节奏派发。每次状态变化后重排定时器，于是 AI 与 AI
   * 之间保持可读的间隔，真人看得清每一步。
   */
  private scheduleAiTurn(): void {
    if (this.aiTimer !== null) {
      clearTimeout(this.aiTimer);
      this.aiTimer = null;
    }
    const delay = this.module.driver?.aiActionDelayMs;
    if (!delay) return;
    const state = this.engine.getRawState();
    const actor = this.automatedFocusActor(state);
    if (!actor) return;
    if (this.engine.getLegalActions(actor).length === 0) return;
    this.aiTimer = setTimeout(() => {
      this.aiTimer = null;
      // 这 1.2 秒里状态可能已经变了（真人先手、换座、牌局结束），到点重新问一次。
      const live = this.engine.getRawState();
      const liveActor = this.automatedFocusActor(live);
      if (!liveActor) {
        this.scheduleAiTurn();
        return;
      }
      const action = this.engine.getLegalActions(liveActor)[0];
      if (!action) return;
      this.engine.dispatch(action);
      this.scheduleAiTurn();
    }, delay);
  }

  /**
   * The automated actor that currently owns the input.
   *
   * A response window can focus the strike target while the active player is
   * still the attacker, so looking only at `activePlayerId` would let an AI
   * target sit on a Dodge/Peach prompt forever.
   */
  private automatedFocusActor(state: ReturnType<UniversalGameEngine['getRawState']>): string | undefined {
    const isAutomated = this.module.driver?.isAutomated;
    if (!isAutomated) return undefined;
    const focus = this.engine.getFocusActors() as string[];
    const focused = focus.find(actorId => isAutomated(state, actorId));
    if (focused) return focused;
    const active = this.engine.getActiveActorId();
    return active && isAutomated(state, active) ? active : undefined;
  }

  /**
   * 驱动游戏声明的周期性规则（观察者低保等）。
   *
   * 内核不做时钟：这里是唯一按真实时间推进的地方，派发的动作照常进 actionLog，
   * 所以「第几拍发了多少低保」在回放里仍是确定的。
   */
  private startHeartbeat(): void {
    const heartbeat = this.module.driver?.heartbeat;
    if (!heartbeat || this.heartbeatTimer !== null) return;
    this.heartbeatTimer = setInterval(() => {
      const state = this.engine.getRawState();
      if (state.gameOver) return;
      const action = heartbeat.action(state);
      if (!action) return;
      this.engine.dispatch(action);
    }, heartbeat.intervalMs);
    // Node 里（测试/无头导出）不要因为这个定时器阻止进程退出。
    this.heartbeatTimer.unref?.();
  }

  public dispose(): void {
    if (this.aiTimer !== null) {
      clearTimeout(this.aiTimer);
      this.aiTimer = null;
    }
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.unsubscribers.forEach(unsubscribe => {
      unsubscribe();
    });
    this.unsubscribers.length = 0;
    this.listeners.clear();
    this.noticeListeners.clear();
    this.visualListeners.clear();
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  private dispatch(action: Action): { ok: boolean; error?: string } {
    const result = this.engine.dispatch(action);
    if (!result.ok) {
      const error = result.error ?? 'action rejected by the kernel';
      this.emit({ kind: 'error', icon: '⚠', title: error, durationMs: 4200 });
      return { ok: false, error };
    }
    return { ok: true };
  }

  /**
   * Append one kernel visual event to the activity feed.
   *
   * The feed is presentation state, not game state: it is rebuilt from the
   * event stream and never written back into the engine.
   */
  private recordHistory(event: VisualTraceEvent): void {
    const kind = EVENT_KIND[event.type] ?? 'system';
    const state = this.engine.getProjectedState();
    const entry: UiHistoryEntry = {
      id: `h${++this.historySeq}`,
      kind,
      icon: EVENT_ICON[event.type] ?? EVENT_ICONS[event.type] ?? '•',
      title: event.title,
      // 打出的牌/摸到的牌：让"落桌回响"能画出真实卡面（别人出牌也看得见）。
      entityId:
        (event.payload?.entityId as string | undefined) ??
        (kind === 'card' ? event.targetId : undefined),
      round: state.round,
      turn: state.turn,
      critical: kind === 'haunt' || /死亡|作祟/.test(event.title)
    };
    if (event.sourceId) {
      const who = state.players[event.sourceId] ?? state.npcs?.[event.sourceId];
      if (who) {
        entry.actorName = who.name;
        entry.actorColor = (who as { color?: string }).color;
      }
    }
    this.history.unshift(entry);
    if (this.history.length > HISTORY_LIMIT) this.history.length = HISTORY_LIMIT;
  }

  /**
   * Compare trait ladders against the previous rebuild and turn any movement
   * into an emphatic notice. Driven by state, so every path that damages a
   * character (combat, events, haunts, manual effects) reports consistently.
   */
  private collectTraitChanges(raw: ReturnType<UniversalGameEngine['getRawState']>): void {
    const traitsOf = this.module.presentation?.traits;
    if (!traitsOf) return;
    const describeTrait = this.module.presentation?.describeTrait;
    for (const player of Object.values(raw.players ?? {})) {
      const indexes = traitsOf((player.customProps ?? {}) as Record<string, unknown>);
      if (!indexes) continue;
      const previous = this.lastTraitIndex.get(player.id);
      this.lastTraitIndex.set(player.id, { ...indexes });
      if (!previous) continue;

      for (const [trait, to] of Object.entries(indexes)) {
        const from = previous[trait];
        if (from === undefined || from === to) continue;
        const delta = to - from;
        const meta = describeTrait?.(trait);
        const label = meta?.label ?? trait;
        const mental = (meta?.damageKind ?? 'PHYSICAL') === 'MENTAL';
        const change: UiTraitChange = {
          playerId: player.id,
          playerName: player.name,
          traitKey: trait,
          traitLabel: label,
          from,
          to,
          delta,
          damageKind: delta < 0 ? (mental ? 'MENTAL' : 'PHYSICAL') : undefined,
          lethal: !player.alive || to === 0
        };
        const sign = delta > 0 ? '+' : '';
        this.history.unshift({
          id: `h${++this.historySeq}`,
          kind: delta < 0 ? 'damage' : 'heal',
          icon: delta < 0 ? '🩸' : '✚',
          title: `${player.name} ${label} ${sign}${delta}`,
          detail: `${from} → ${to}`,
          round: this.engine.getProjectedState().round,
          turn: this.engine.getProjectedState().turn,
          actorName: player.name,
          actorColor: player.color,
          delta,
          traitLabel: label,
          critical: change.lethal
        });
        this.pendingTraitNotices.push({
          kind: delta < 0 ? 'error' : 'event',
          icon: delta < 0 ? '🩸' : '✚',
          title: `${label} ${sign}${delta}`,
          detail: `${player.name} · ${from} → ${to}${change.lethal ? ' · 濒死！' : ''}`,
          durationMs: delta < 0 ? 4200 : 3000,
          trait: change
        });
      }
    }
  }

  private emit(notice: UiNotice): void {
    this.noticeListeners.forEach(listener => {
      listener(notice);
    });
  }

  private emitEventNotice(type: string, title: string, durationMs: number): void {
    if (type === 'ANNOUNCEMENT') {
      this.emit({ kind: 'announce', icon: '❖', title, durationMs });
      return;
    }
    if (type === 'RULE_MUTATE') {
      this.emit({ kind: 'announce', icon: '☠', title, durationMs: durationMs || 1600, tabHint: 'HOOKS' });
      return;
    }
    if (type === 'DECISION_REVEAL') {
      this.emit({ kind: 'announce', icon: '💥', title, durationMs: durationMs || 1600 });
      return;
    }
    if (type === 'DECISION_TIMEOUT' || type === 'STACK_TIMEOUT') {
      this.emit({ kind: 'announce', icon: '⏱', title, durationMs: durationMs || 1600, tabHint: 'STACK' });
      return;
    }
    this.emit({ kind: 'event', icon: EVENT_ICONS[type] ?? '•', title, durationMs: 3600 });
  }

  private publish(): void {
    this.listeners.forEach(listener => {
      listener(this.snapshot);
    });
    // Trait banners must land after the snapshot so the HUD animates the
    // already-updated ladder rather than the previous value.
    if (this.pendingTraitNotices.length > 0) {
      const queued = this.pendingTraitNotices;
      this.pendingTraitNotices = [];
      for (const notice of queued) this.emit(notice);
    }
  }

  private rebuild(): void {
    const state = this.engine.getProjectedState();
    const raw = this.engine.getRawState();
    const module = this.module;
    this.activeBoardGroup = undefined;

    const focusActors = this.engine.getFocusActors();
    const focus = focusActors.filter(id => !!raw.players[id]);
    const actor =
      this.engine.getViewer() !== 'GOD'
        ? this.engine.getViewer()
        : focusActors[0] ?? this.engine.getActiveActorId();

    const openDecision = state.pendingDecisions.find(w => w.status === 'OPEN');
    const acting = openDecision
      ? openDecision.participants.filter(pid => openDecision.submissions[pid] === undefined)
      : [actor];

    // 谁在行动，和「我能做什么」是两件事：视角绑定到某名玩家之后，`acting`
    // 是他自己的合法动作范围（入座 / 准备 / 结算），而牌桌上真正轮到的人是
    // `focusActors`。操作栏第一行写的是后者——否则轮到 AI 时栏里会写「行动者
    // 玩家 1」，玩家以为该自己出手，桌子却没有动作可选。对局已结束时没有
    // 行动者，退回视角本人（旧行为），免得写出一个空的「行动者」。
    const turnActors =
      focusActors.length > 0 ? focusActors : [this.engine.getActiveActorId() ?? actor];

    const legal = acting.flatMap(pid => this.engine.getLegalActions(pid));
    this.bound = buildActionsView(state, legal, (actorId, spec) =>
      this.engine.getSelectionCandidates(actorId, spec)
    );
    // DEBUG_* 是调试动作（例如一键全员准备），只在上帝视角出现。
    if (this.engine.getViewer() !== 'GOD') {
      this.bound = this.bound.filter(entry => !String(entry.action?.type ?? entry.ui.actionType ?? '').startsWith('DEBUG_'));
    }

    // 动作冷却（游戏声明 `actionCooldownMs`）：一手刚结束先留出阅读时间，再允许
    // 开下一手。时钟只存在于驱动层，内核保持无时钟、可回放。
    // 首帧（revision 0）不设冷却：开局那一次 START_HAND 本来就该立刻可用。
    const cooldowns = this.revision === 0 ? undefined : module.driver?.actionCooldownMs;
    applyActionCooldowns(this.bound, cooldowns, this.actionSeenAt, Date.now());

    const actorName =
      turnActors.length > 1
        ? `${turnActors.length} 个行动者待提交`
        : this.engine.getActorName(turnActors[0] ?? actor);

    const seat = buildSeatViews(
      state,
      this.bound,
      this.engine.getViewer(),
      focus,
      this.engine.getActiveActorId(),
      state.activePlayerId
    );

    this.snapshot = {
      revision: this.revision,
      gameId: module.meta.id,
      gameName: module.meta.name,
      capabilities: { ...module.meta.capabilities },
      schemaCount: Object.keys(module.actionSchemas ?? {}).length,
      dependencyErrors: this.engine.getRules().dependencyErrors(),
      // `this.scenario` is undefined while a table plays its plain setup, which
      // is the first declared scenario for a module that ships several. Marking
      // it selected keeps the picker honest instead of showing no active choice.
      scenarios: (() => {
        const entries = Object.entries(module.scenarios ?? {});
        const plain = this.scenario ?? entries[0]?.[0];
        return entries.map(([id, scenario]) => ({
          id,
          description: scenario.description ?? id,
          selected: id === plain
        }));
      })(),

      phaseLabel: phaseLabelOf(state, module.presentation),
      mission: missionLineOf(state, module.presentation),
      round: state.round,
      turn: state.turn,
      clock: state.clock,
      actorName,
      focus,
      focusActors,
      viewer: this.engine.getViewer(),
      viewers: [
        { id: 'GOD', name: '全知上帝视角' },
        ...state.playerOrder.map(pid => ({ id: pid, name: state.players[pid]?.name ?? pid }))
      ],

      players: buildPlayersView(
        state,
        focus,
        raw.effects,
        module.statModifiers ? (actorId: string) => module.statModifiers!(raw, actorId) : undefined,
        module.presentation
      ),
      npcs: buildNpcsView(state, focusActors, id => this.engine.getActorName(id)),
      observers: buildObserverRoster(state, pid =>
        this.engine.getLegalActions(pid).some(action => action.type === 'OBSERVER_REJOIN')
      ),
      actions: this.bound.map(entry => entry.ui),
      legalCount: legal.length,
      hand: seat.hand,
      equip: seat.equip,
      reveal: seat.reveal,
      commands: seat.commands,
      prompt: seat.prompt,

      stackDepth: state.interruptStack.length,
      stack: buildStackView(state, id => this.engine.getActorName(id)),
      decision: openDecision
        ? buildDecisionView(state, openDecision, id => this.engine.getActorName(id))
        : undefined,
      openDecisions: state.pendingDecisions.filter(w => w.status === 'OPEN').length,

      hooks: this.buildHooks(state),
      history: this.history,
      spatial: this.buildSpatial(state, actor),
      placement: this.buildPlacement(raw, actor),
      log: {
        entries: state.actionLog.map((action, index) => ({
          index,
          playerId: action.playerId,
          type: action.type,
          targetId: action.targetPlayerId
        })),
        cursor: raw.actionLog.length,
        total: this.engine.getHistory().length,
        seed: this.engine.getSeed(),
        hash: this.engine.getStateHash(),
        replay: this.lastReplay
      },
      board: state,

      chipRanking: this.buildChipRanking(state),
      gameOver: state.gameOver,
      winnerLabel: state.gameOver
        ? Array.isArray(state.winner)
          ? state.winner.map(id => this.engine.getActorName(id)).join(' / ')
          : state.winner
          ? this.engine.getActorName(state.winner)
          : ''
        : '',
      winnerReason: state.gameOver ? state.winnerReason : undefined,
      lastRoll: this.buildLastRoll(state),
      blockedReason: this.buildBlockedReason(raw)
    };

    // Diff trait ladders last: the snapshot above already carries the new
    // values, so the emitted notice and the rendered ladder never disagree.
    this.collectTraitChanges(raw);
  }



  /**
   * Most recent trait check, for the dice animation. `lastRoll` lives in
   * `globalVars` and persists until the next check, so the stamp includes the
   * action cursor: that makes two identical totals in a row distinguishable.
   */
  /**
   * Explain why the active explorer cannot move or explore.
   *
   * Every branch below is a legitimate rule that silently removes every action
   * except END_TURN; without this the dock shows one card and the player assumes
   * the game is stuck.
   */
  private buildBlockedReason(raw: ReturnType<UniversalGameEngine['getRawState']>): string | undefined {
    const actorId = String(raw.activePlayerId ?? '');
    const player = raw.players[actorId];
    if (!player) return undefined;
    if (!player.alive) return '角色已死亡';
    const props = (player.customProps ?? {}) as Record<string, unknown>;
    if (props.controlled) return '被精神控制，正被迫走向飞船';
    if (props.skipActions) return '本回合无法行动（回合开始时的检定失败）';
    if (Number(props.movesLeft ?? 0) <= 0) return '本回合已无剩余移动力（探索并抽牌会结束移动）';
    return undefined;
  }

  private buildLastRoll(state: ProjectedGameState): UiRoll | undefined {
    const roll = state.globalVars?.lastRoll as
      | {
          dice?: number[];
          total?: number;
          threshold?: number;
          success?: boolean;
          trait?: string;
          traitValue?: number;
          seq?: number;
          effect?: string;
          reason?: string;
          label?: string;
        }
      | undefined;
    if (!roll || !Array.isArray(roll.dice) || typeof roll.total !== 'number') return undefined;
    return {
      dice: [...roll.dice],
      total: roll.total,
      threshold: roll.threshold,
      success: roll.success,
      trait: roll.trait,
      traitValue: typeof roll.traitValue === 'number' ? roll.traitValue : undefined,
      seq: typeof roll.seq === 'number' ? roll.seq : undefined,
      effect: roll.effect,
      reason: roll.reason,
      label: roll.label,
      stamp: `${roll.seq ?? 0}:${roll.trait ?? ''}:${roll.total}:${roll.dice.join(',')}`
    };
  }

  private buildPlacement(
    raw: ReturnType<UniversalGameEngine['getRawState']>,
    actor?: string
  ): UiPlacement | undefined {
    const pending = raw.globalVars.pendingRoomPlacement as
      | { defId: string; rotations?: number[] }
      | undefined;
    if (!pending) {
      this.placementRotation = undefined;
      return undefined;
    }
    const rotations = pending.rotations ?? [0];
    if (this.placementRotation === undefined || !rotations.includes(this.placementRotation)) {
      const stored = this.readStoredRotation(pending.defId);
      this.placementRotation =
        stored !== undefined && rotations.includes(stored) ? stored : rotations[0];
    }
    return buildPlacementView(raw, this.engine.getViewer(), actor, this.placementRotation);
  }

  /* ------------------------------------------------------------------ */
  /* Players                                                             */
  /* ------------------------------------------------------------------ */





  /**
   * 筹码排行（德州扑克）：按筹码占全桌总量的比例降序。
   *
   * 只用投影状态里的筹码字段（public 信息），不读牌堆或别人的底牌；
   * 其他游戏没有筹码概念，返回 undefined 让 HUD 不渲染这个面板。
   */
  private buildChipRanking(state: ProjectedGameState): UiChipRank[] | undefined {
    const rows = this.module.presentation?.rankedPlayers?.(state);
    if (!rows) return undefined;
    return rows.map(row => ({
      playerId: row.playerId,
      name: row.name,
      chips: row.value,
      share: row.share,
      isAi: row.isAi ?? false,
      tierLabel: row.tierLabel
    }));
  }

  private buildSpatial(state: ProjectedGameState, actor?: string): UiSpatialInfo | undefined {
    const floors = state.mapGraph.topology?.layers ?? [];
    if (floors.length === 0) return undefined;
    // Which node the active player stands on is game vocabulary: the hint
    // reads the custom bag, the shell never learns the key.
    const hints = this.module.presentation;
    const raw = this.engine.getRawState();
    const playerRoom =
      actor && hints?.playerNode
        ? hints.playerNode((raw.players[actor]?.customProps ?? {}) as Record<string, unknown>) ?? undefined
        : undefined;
    const npcRoom = actor ? raw.npcs?.[actor]?.customProps?.roomId : undefined;
    const activeNodeId = String(playerRoom ?? npcRoom ?? '') || undefined;
    return {
      floors,
      title: hints?.mapTitle,
      activeNodeId,
      activeFloor: activeNodeId ? this.engine.getSpatialFloor(activeNodeId) : undefined
    };
  }





  /* ------------------------------------------------------------------ */
  /* Actions                                                             */
  /* ------------------------------------------------------------------ */




  /* ------------------------------------------------------------------ */
  /* Stack / decisions / hooks                                           */
  /* ------------------------------------------------------------------ */







  private buildHooks(state: ProjectedGameState): UiHook[] {
    const registry = this.engine.getRules();

    return state.activeHooks.map(instance => {
      const impl = registry.get(instance.hookId);
      return {
        instanceId: instance.instanceId,
        hookId: instance.hookId,
        name: impl?.name ?? instance.hookId,
        stage: impl?.stage ?? 'UNKNOWN',
        priority: impl?.priority ?? 0,
        description: impl?.description ?? '实现未注册：状态中只保存 hookId。',
        ownerName: instance.ownerId
          ? this.engine.getActorName(instance.ownerId)
          : undefined,
        params:
          instance.params && Object.keys(instance.params).length > 0
            ? JSON.stringify(instance.params)
            : '—'
      };
    });
  }

}

/* -------------------------------------------------------------------------- */
/* Pure projection → DTO view builders.                                        */
/* Shared by UniversalSession (host/local) and NetSession (network guest).     */
/* -------------------------------------------------------------------------- */

export function phaseLabelOf(
  state: ProjectedGameState,
  presentation?: GameModule['presentation']
): string {
  const openDecision = state.pendingDecisions.find(window => window.status === 'OPEN');
  if (openDecision) {
    return openDecision.secret ? 'SECRET DECISION · 同步盲提' : 'DECISION · 等待提交';
  }
  if (state.interruptStack.length > 0) return 'INTERRUPT RESOLUTION · 响应结算';
  return presentation?.phaseLabel?.(state) ?? state.phase;
}

export function missionLineOf(
  state: ProjectedGameState,
  presentation?: GameModule['presentation']
): string | undefined {
  return presentation?.missionLine?.(state);
}

export function buildPlayersView(
  state: ProjectedGameState,
  focus: string[],
  effectsOverride?: EffectInstance[],
  statModifiers?: (actorId: string) => Record<string, number>,
  presentation?: GameModule['presentation']
): UiPlayer[] {
    const focusSet = new Set(focus);

    return state.playerOrder.map(pid => {
      const player = state.players[pid];
      const handCount = state.zones[`zone_hand_${pid}`]?.orderedEntities.length ?? 0;
      const equipCount = state.zones[`zone_equip_${pid}`]?.orderedEntities.length ?? 0;

      const effects: UiEffect[] = [];
      const source =
        state.effects && state.effects.length > 0 ? state.effects : effectsOverride ?? [];
      for (const effect of source) {
        if (effect.target !== pid) continue;
        const visibility = effect.visibility?.type ?? 'PUBLIC';
        if (visibility !== 'PUBLIC') continue;
        const payload = (effect.payload ?? {}) as { effect?: string; label?: string; detail?: string };
        const id = payload.effect ?? effect.kind;
        effects.push({
          id,
          label: payload.label ?? id,
          detail: payload.detail,
          tone: effect.kind === 'ONGOING' ? 'bad' : 'neutral'
        });
      }
      const flags: { key: string; label: string; detail: string }[] = [
        { key: 'banished', label: '被放逐', detail: '无法行动，等待剧本推进' },
        { key: 'abducted', label: '已被掳走', detail: '被拖入飞船，已出局' },
        { key: 'controlled', label: '被控制', detail: '被迫走向飞船' },
        { key: 'skipActions', label: '本回合无法行动', detail: '跳过本回合的动作' }
      ];
      for (const flag of flags) {
        if (!player?.customProps?.[flag.key]) continue;
        effects.push({ id: flag.key, label: flag.label, detail: flag.detail, tone: 'bad' });
      }

      const base: UiPlayer = {
        id: pid,
        name: player?.name ?? pid,
        color: player?.color ?? '#8b93a1',
        avatar: player?.avatar ?? '👤',
        avatarUrl: player?.avatarUrl,
        score: player?.score ?? 0,
        scoreLabel: 'VP',
        alive: player?.alive ?? true,
        roleLabel: player?.role ? presentation?.roleLabel?.(player.role) ?? player.role : undefined,
        roleClass: player?.role?.toLowerCase(),
        isFocus: focusSet.has(pid) && (player?.alive ?? true),
        stats: [],
        pips: [],
        effects
      };

      if (!player) return base;

      const hint = presentation?.playerView?.(player, state, {
        viewer: state.viewerId,
        handCount,
        equipCount,
        isFocus: base.isFocus,
        modifiers: statModifiers?.(pid) ?? {}
      });
      if (hint) {
        if (hint.score !== undefined) base.score = hint.score;
        if (hint.scoreLabel !== undefined) base.scoreLabel = hint.scoreLabel;
        if (hint.hp !== undefined) base.hp = hint.hp;
        if (hint.stats !== undefined) base.stats = hint.stats;
        if (hint.pips !== undefined) base.pips = hint.pips;
        if (hint.effects?.length) base.effects = [...(base.effects ?? []), ...hint.effects];
      }
      return base;
    });
  }

export function buildNpcsView(
  state: ProjectedGameState,
  focusActors: string[],
  actorName: (actorId: ActorId) => string
): UiNpc[] {    const focusSet = new Set(focusActors);
    return Object.values(state.npcs ?? {}).map(npc => {
      const entity = npc.entityId ? state.entities[npc.entityId] : undefined;
      const custom = entity?.components?.custom ?? {};
      const controller = npc.controllerId ? actorName(npc.controllerId) : undefined;
      const statusLabels: Record<string, string> = {
        ACTIVE: '活动',
        DEAD: '死亡',
        ELIMINATED: '已消灭',
        SPECTATOR: '放逐'
      };
      const stats = [
        { label: '状态', value: statusLabels[npc.status] ?? npc.status },
        ...(controller ? [{ label: '控制者', value: controller }] : []),
        ...(custom.stunned ? [{ label: '状态', value: '💫 击晕' }] : []),
        ...(custom.carryingGirl ? [{ label: '携带', value: '小女孩' }] : [])
      ];
      return {
        id: npc.id,
        name: npc.name,
        color: npc.color,
        avatar: npc.avatar,
        status: npc.status,
        controllerName: controller,
        isFocus: focusSet.has(npc.id),
        stats
      };
    });
  }

type ActionSurfaceMeta = {
  surface: UiSurface;
  verb: UiVerb;
  source: NonNullable<UiAction['source']>;
  slot?: number;
  risk?: UiRisk;
  confirm?: 'none' | 'timed' | 'modal';
};

/** 游戏是否正在向这个 actor 提问（响应窗口 / 待提交决策 / 待选择）。 */
function isPromptStateFor(state: ProjectedGameState, action: Action): boolean {
  const actorId = action.actorId ?? action.playerId;
  const frame = state.interruptStack[state.interruptStack.length - 1];
  if (frame?.status === 'WAITING_INPUT' && frame.responseWindow) {
    const eligible = frame.responseWindow.eligibleActors ?? frame.responseWindow.eligiblePlayers ?? [];
    if (eligible.includes(actorId)) return true;
  }
  const window = state.pendingDecisions.find(w => w.status === 'OPEN');
  if (window?.participants.includes(actorId) && window.submissions[actorId] === undefined) return true;
  const choice = state.globalVars.pendingChoice as { playerId?: string } | undefined;
  return choice?.playerId === actorId;
}

function isAmountField(field: UiActionField): boolean {
  return field.widget === 'slider' || field.kind === 'number';
}

function zoneTypeOf(state: ProjectedGameState, entityId?: string): string | undefined {
  const entity = entityId ? state.entities[entityId] : undefined;
  return entity?.zoneId ? state.zones[entity.zoneId]?.type : undefined;
}

function verbForEntityAction(action: Action): UiVerb {
  if (action.type === 'EQUIP_CARD') return 'equip';
  if (action.type === 'DISCARD_CARD' || action.type === 'DROP_ITEM') return 'discard';
  if (action.type.includes('TRADE')) return 'trade';
  if (action.type === 'PICK_UP_ITEM') return 'pick';
  if (action.type.startsWith('ATTACK_')) return 'attack';
  if (action.type === 'USE_ITEM' || action.type === 'USE_SKILL') return 'use';
  if (action.type.startsWith('PLAY_') || action.type === 'EXECUTE_DAMAGE') return 'play';
  return 'use';
}

function verbForBoardAction(action: Action): UiVerb {
  if (action.type.startsWith('BUILD_') || action.type.startsWith('SETUP_') || action.type === 'UPGRADE_CITY') {
    return 'build';
  }
  if (
    action.type.startsWith('MOVE_') ||
    action.type === 'CLIMB_UP' ||
    action.type === 'ELEVATOR_MOVE' ||
    action.type === 'JUMP_DOWN'
  ) {
    return 'move';
  }
  if (action.type.startsWith('ATTACK_')) return 'attack';
  if (action.type === 'EXPLORE_DOOR' || action.type === 'PLACE_ROOM') return 'explore';
  if (action.type === 'PICK_UP_ITEM') return 'pick';
  return 'use';
}

function verbForCommand(action: Action): UiVerb {
  if (action.type === 'END_TURN' || action.type === 'END_NPC_TURN' || action.type === 'FINISH_TURN') {
    return 'end-turn';
  }
  if (action.type === 'ROLL_DICE') return 'roll';
  if (action.type === 'DRAW' || action.type === 'DRAW_CARDS' || action.type === 'DRAW_PHASE') return 'draw';
  if (action.type === 'READY' || action.type === 'READY_UP' || action.type === 'START_HAND' || action.type === 'START_TURN') {
    return 'ready';
  }
  if (action.type === 'PASS') return 'pass';
  return 'confirm';
}

function commandSlotOf(action: Action): number {
  if (action.type === 'END_TURN' || action.type === 'END_NPC_TURN' || action.type === 'FINISH_TURN') return 4;
  if (action.type === 'ROLL_DICE' || action.type === 'DRAW' || action.type === 'DRAW_CARDS') return 0;
  if (action.type === 'READY' || action.type === 'READY_UP' || action.type === 'START_HAND' || action.type === 'START_TURN') {
    return 3;
  }
  if (action.type === 'PASS') return 2;
  return 1;
}

/**
 * 能力分类：同一套规则覆盖所有游戏，不写 gameId。
 *
 * 顺序很重要：游戏提问 → 实体区域 → 棋盘目标 → 数值 → 回合指令 → 兜底情境。
 * 动作带实体但在手牌时，即使它带 fields（例如需要选数量的卡），仍然属于
 * hand：数量面板是它的二级输入，不是另一个操作面。
 */
function classifyAction(state: ProjectedGameState, action: Action): ActionSurfaceMeta {
  if (isPromptStateFor(state, action) || action.type === 'DISCARD_CARD') {
    const verb: UiVerb =
      action.type === 'PASS'
        ? 'pass'
        : action.type === 'RESOLVE_CHOICE'
          ? 'choose'
          : action.type === 'DISCARD_CARD'
            ? 'discard'
            : 'respond';
    return { surface: 'prompt', verb, source: { kind: 'prompt' } };
  }

  const zoneType = zoneTypeOf(state, action.entityId);
  if (zoneType === 'HAND') {
    return {
      surface: 'hand',
      verb: verbForEntityAction(action),
      source: { kind: 'entity', id: action.entityId }
    };
  }
  if (zoneType === 'EQUIP' || zoneType === 'JUDGE') {
    return {
      surface: 'equip',
      verb: verbForEntityAction(action),
      source: { kind: 'entity', id: action.entityId }
    };
  }
  if (zoneType === 'TABLEAU') {
    return {
      surface: 'tableau',
      verb: verbForEntityAction(action),
      source: { kind: 'entity', id: action.entityId }
    };
  }
  if (zoneType === 'BOARD' || zoneType === 'MARKET' || zoneType === 'DECK' || zoneType === 'DISCARD') {
    return {
      surface: 'context',
      verb: verbForBoardAction(action),
      source: { kind: 'board', id: action.entityId }
    };
  }

  if (action.targetNodeId || action.targetEdgeId) {
    return {
      surface: 'context',
      verb: verbForBoardAction(action),
      source: { kind: 'board', id: action.targetNodeId ?? action.targetEdgeId }
    };
  }

  if (!action.entityId && !action.selection && action.fields?.some(isAmountField)) {
    return { surface: 'amount', verb: 'confirm', source: { kind: 'global' } };
  }

  if (!action.entityId && !action.selection && !action.fields?.length) {
    const risk: UiRisk =
      action.type === 'ALL_IN' ? 'irreversible' : action.type === 'END_TURN' ? 'costly' : 'safe';
    return {
      surface: 'command',
      verb: verbForCommand(action),
      source: { kind: 'global' },
      slot: commandSlotOf(action),
      risk,
      confirm: action.type === 'ALL_IN' ? 'timed' : 'none'
    };
  }

  return { surface: 'context', verb: 'use', source: { kind: 'global' } };
}

/** 回合指令轨：去重、固定槽位、END_TURN 永远最后。 */
export function buildCommandView(bound: readonly BoundAction[], owner?: string): UiAction[] {
  const commands = bound
    .filter(entry => entry.ui.surface === 'command')
    .filter(entry => !owner || !entry.action || entry.action.playerId === owner || entry.action.actorId === owner);
  const seen = new Set<string>();
  const unique = commands.filter(entry => {
    if (seen.has(entry.ui.id)) return false;
    seen.add(entry.ui.id);
    return true;
  });
  const orderedByPreference = [...unique].sort(
    (a, b) =>
      (a.ui.slot ?? 1) - (b.ui.slot ?? 1) ||
      String(a.ui.actionType ?? '').localeCompare(String(b.ui.actionType ?? '')) ||
      a.ui.id.localeCompare(b.ui.id)
  );
  const endTurn = orderedByPreference.find(entry => entry.ui.verb === 'end-turn');
  const rest = orderedByPreference.filter(entry => entry !== endTurn);
  // 先不在这里截断：UI 用「前 4 + 更多」保证不丢动作；等交易/数值面板
  // 接管 Splendor 这类组合动作后，再恢复严格 ≤5。
  const ordered = [...rest.slice(0, 23), ...(endTurn ? [endTurn] : [])];
  ordered.forEach((entry, index) => {
    entry.ui.slot = index;
  });
  return ordered.map(entry => entry.ui);
}
/** 把当前响应/决策动作收成一条 prompt；不是响应状态时返回 undefined。 */
export function buildPromptView(
  bound: readonly BoundAction[],
  state: ProjectedGameState
): UiPrompt | undefined {
  const window = state.pendingDecisions.find(w => w.status === 'OPEN');
  const frame = state.interruptStack[state.interruptStack.length - 1];
  const eligible = frame?.responseWindow
    ? (frame.responseWindow.eligibleActors ?? frame.responseWindow.eligiblePlayers ?? [])
    : [];
  const focus =
    state.viewerId !== 'GOD'
      ? state.viewerId
      : state.activeActorId ?? window?.participants[0] ?? eligible[0] ?? state.playerOrder[0];
  const options = bound
    .filter(entry => entry.ui.surface === 'prompt')
    .filter(entry => !focus || !entry.action || entry.action.playerId === focus || entry.action.actorId === focus)
    .map(entry => entry.ui);
  if (options.length === 0) return undefined;
  const promptId = `prompt:${state.seq}:${options.map(option => option.id).join(',')}`;
  for (const option of options) option.promptId = promptId;
  const payload = (window?.payload ?? {}) as { kind?: string };
  const pass = options.find(option => option.verb === 'pass');
  return {
    id: promptId,
    kind:
      frame?.responseWindow
        ? 'response'
        : payload.kind === 'discard'
          ? 'discard'
          : window?.secret
            ? 'secret'
            : 'choice',
    title: frame?.title ?? window?.title ?? '请选择',
    description: frame?.description ?? window?.description,
    options,
    allowPass: !!pass,
    passActionId: pass?.id,
    secret: window?.secret
  };
}
function entityTitle(state: ProjectedGameState, entityId: string): string {
  const entity = state.entities[entityId];
  const face = entity?.components?.cardFace;
  const custom = (entity?.components?.custom ?? {}) as Record<string, unknown>;
  return String(
    custom.actionLabel ?? custom.zh ?? custom.name ?? face?.title ?? entity?.type ?? '未知卡牌'
  );
}

function cardOf(
  state: ProjectedGameState,
  bound: readonly BoundAction[],
  entityId: string,
  zone: UiHandCard['zone']
): UiHandCard {
  const verbs = bound
    .filter(entry => entry.ui.entityId === entityId)
    .filter(
      entry =>
        entry.ui.surface === 'hand' ||
        entry.ui.surface === 'equip' ||
        entry.ui.surface === 'tableau' ||
        // 响应窗口里的【闪】/【桃】/弃牌仍然属于那张实体牌：把它挂到卡上，
        // 玩家可以直接点牌响应；同时 prompt 托盘仍然列出所有合法选项。
        entry.ui.surface === 'prompt'
    )
    .map(entry => entry.ui);
  return {
    entityId,
    zone,
    title: entityTitle(state, entityId),
    playable: verbs.length > 0,
    readOnly: verbs.length === 0,
    reason: undefined,
    verbs
  };
}

function cardsInZone(
  state: ProjectedGameState,
  bound: readonly BoundAction[],
  zoneId: string | undefined,
  zone: UiHandCard['zone']
): UiHandCard[] {
  if (!zoneId) return [];
  const ids = state.zones[zoneId]?.orderedEntities ?? [];
  return ids
    .filter(id => !!state.entities[id] && !state.entities[id]?.isMasked)
    .map(id => cardOf(state, bound, id, zone));
}

/** 实体手牌/装备/展示卡：只从实体区域取，不从动作表取。 */
export function buildHandView(
  state: ProjectedGameState,
  bound: readonly BoundAction[],
  owner: string | undefined
): { hand: UiHandCard[]; equip: UiHandCard[]; reveal: UiHandCard[] } {
  if (!owner) return { hand: [], equip: [], reveal: [] };
  return {
    hand: cardsInZone(state, bound, `zone_hand_${owner}`, 'HAND'),
    equip: [
      ...cardsInZone(state, bound, `zone_equip_${owner}`, 'EQUIP'),
      ...cardsInZone(state, bound, `zone_tableau_${owner}`, 'TABLEAU'),
      ...cardsInZone(state, bound, `zone_judge_${owner}`, 'JUDGE')
    ],
    reveal: cardsInZone(state, bound, `zone_reveal_${owner}`, 'REVEAL')
  };
}

/**
 * 一个座位能看到的四层视图：实体手牌 / 装备展示 / 回合指令轨 / 应答托盘。
 *
 * 单机（UniversalSession）与联机（NetSession）必须走同一个函数：以前联机自己
 * 拼 snapshot，漏掉了 hand / commands / prompt，于是开房间里手牌区直接隐藏。
 */
export function buildSeatViews(
  state: ProjectedGameState,
  bound: readonly BoundAction[],
  viewer: string,
  focus: readonly string[],
  activeActorId: string | undefined,
  activePlayerId: string | undefined
): {
  handOwner: string | undefined;
  hand: UiHandCard[];
  equip: UiHandCard[];
  reveal: UiHandCard[];
  commands: UiAction[];
  prompt: UiPrompt | undefined;
} {
  const handOwner = viewer === 'GOD' ? (focus[0] ?? activeActorId ?? activePlayerId) : viewer;
  const cards = buildHandView(state, bound, handOwner);
  return {
    handOwner,
    hand: cards.hand,
    equip: cards.equip,
    reveal: cards.reveal,
    commands: buildCommandView(bound, handOwner),
    prompt: buildPromptView(bound, state)
  };
}

export function buildActionsView(
  state: ProjectedGameState,
  actions: Action[],
  getSelectionCandidates: (actorId: ActorId, spec: SelectionSpec) => SelectionCandidate[]
): BoundAction[] {
    const bound: BoundAction[] = [];
    const groups = new Map<string, { action: Action; ids: string[] }>();
    // 动作族：同一个 family.id 的具体动作（例如所有三色组合）只占一个 UI 槽位。
    const familyBuckets = new Map<string, { first: Action; variants: Map<string, Action> }>();
    for (const action of actions) {
      const family = action.family;
      if (!family) continue;
      const bucketKey = `${action.actorId ?? action.playerId}|${family.id}`;
      const bucket = familyBuckets.get(bucketKey) ?? { first: action, variants: new Map() };
      if (!bucket.variants.has(family.key)) bucket.variants.set(family.key, action);
      familyBuckets.set(bucketKey, bucket);
    }

    const boardGroups: Record<
      string,
      {
        idKey?: 'targetEdgeId' | 'targetNodeId' | 'entityId';
        icon: string;
        label: string;
        hint: string;
        tone: UiAction['tone'];
        /** 覆盖默认的「N 处可选」后缀（宝可梦捕捉/保留只说张数）。 */
        countLabel?: (count: number) => string;
      }
    > = {
      BUILD_ROAD: { idKey: 'targetEdgeId', icon: '🛣️', label: '修建道路', hint: '点击桌面高亮边位 · 1木 1砖', tone: 'normal' },
      SETUP_ROAD: { idKey: 'targetEdgeId', icon: '🛣️', label: '铺设起始道路', hint: '点击与定居点相连的边位', tone: 'primary' },
      BUILD_SETTLEMENT: { idKey: 'targetNodeId', icon: '🏠', label: '建立定居点', hint: '点击高亮顶点 · +1VP', tone: 'primary' },
      SETUP_SETTLEMENT: { idKey: 'targetNodeId', icon: '🏠', label: '选择起始定居点', hint: '点击高亮顶点 · 免费', tone: 'primary' },
      UPGRADE_CITY: { idKey: 'targetNodeId', icon: '🏰', label: '升级为城市', hint: '点击高亮定居点 · +1VP', tone: 'primary' },
      MOVE_ROBBER: { idKey: 'targetNodeId', icon: '🦹', label: '移动强盗', hint: '点击一块非当前地块', tone: 'danger' },
      USE_ELEVATOR: { icon: '🛗', label: '乘坐神秘电梯', hint: '先掷 2 骰决定去向', tone: 'primary' },
      ELEVATOR_MOVE: { icon: '🛗', label: '电梯停靠', hint: '点击任意空门口的黄色箭头', tone: 'primary' },
      ROOM_EXIT_CHECK: { icon: '🚪', label: '尝试离开', hint: '通过检定才能走出这个房间', tone: 'normal' },
      EXIT_STAY: { icon: '🛑', label: '留下，下回合再试', hint: '不受伤，本回合不再移动', tone: 'normal' },
      EXIT_PAY: { icon: '💥', label: '承受损伤强行离开', hint: '失去 1 点属性后走出房间', tone: 'danger' },
      CLIMB_UP: { idKey: 'targetNodeId', icon: '🪜', label: '沿麻绳攀上', hint: '点击上方楼座/露台的房间', tone: 'normal' },
      PICK_UP_ITEM: { idKey: 'entityId', icon: '🫳', label: '拾取物品堆', hint: '点击房间中的卡牌', tone: 'normal' },
      MOVE_NPC: { idKey: 'targetNodeId', icon: '👹', label: '怪物移动', hint: '点击高亮房间 · 消耗怪物移动力', tone: 'danger' },
      // 宝可梦璀璨宝石：捕捉市场 / 保留区的宝可梦。只有 splendor 产出 BUY_CARD。
      BUY_CARD: {
        idKey: 'entityId',
        icon: '⚡',
        label: '捕捉宝可梦',
        hint: '点击高亮卡牌 · 支付精灵球',
        tone: 'primary',
        countLabel: count => `${count} 只可捕捉`
      },
      // 明牌保留：点高亮卡牌直接收进保留区。按阶盲抽没有 entityId，走下面
      // 的独立动作按钮，不会吞进这个高亮组。
      RESERVE_CARD: {
        idKey: 'entityId',
        icon: '🎒',
        label: '保留卡牌',
        hint: '点击高亮卡牌 · 并获得 1 个大师球',
        tone: 'normal',
        countLabel: count => `${count} 张可保留`
      }
    };

    for (const action of actions) {
      const group = boardGroups[action.type];
      if (!group?.idKey) continue;
      const id = action[group.idKey];
      if (!id) continue;
      const bucket = groups.get(action.type) ?? { action, ids: [] };
      bucket.ids.push(id);
      groups.set(action.type, bucket);
    }

    for (const [type, bucket] of groups) {
      const config = boardGroups[type];
      const meta = classifyAction(state, bucket.action);
      bound.push({
        ui: {
          id: `a${bound.length}`,
          actionType: type,
          icon: config.icon,
          label: `${config.label} · ${
            config.countLabel ? config.countLabel(bucket.ids.length) : `${bucket.ids.length} 处可选`
          }`,
          hint: config.hint,
          tone: config.tone,
          surface: meta.surface,
          verb: meta.verb,
          source: meta.source,
          ...(meta.slot !== undefined ? { slot: meta.slot } : {}),
          highlightIds: bucket.ids
        },
        highlight: bucket.ids,
        type,
        idKey: config.idKey
      });
    }
    for (const bucket of familyBuckets.values()) {
      const family = bucket.first.family;
      if (!family) continue;
      const meta = classifyAction(state, bucket.first);
      bound.push({
        ui: {
          id: `a${bound.length}`,
          actionType: family.id,
          group: 'command',
          surface: meta.surface,
          verb: meta.verb,
          source: meta.source,
          ...(meta.slot !== undefined ? { slot: meta.slot } : {}),
          icon: family.icon ?? '🎯',
          label: family.label,
          hint: family.hint ?? '',
          tone: 'primary',
          selectionLabel: '选择颜色',
          selection: {
            spec: { source: 'player', min: family.min, max: family.max },
            candidates: family.options.map(option => ({
              id: option.id,
              label: option.label,
              icon: option.icon
            }))
          }
        },
        action: bucket.first,
        variantVariants: bucket.variants
      });
    }

    const actorNameOf = (id: string): string =>
      state.players[id]?.name ??
      (state.npcs as Record<string, { name?: string } | undefined> | undefined)?.[id]?.name ??
      id;

    /**
     * 手牌分区：从动作形态推导，不看游戏名。
     * 实体在手牌/装备区 → 牌；技能 → 技能；装备动作 → 装（仍归到牌）；其余 → 命令。
     */
    const groupOf = (action: Action): UiAction['group'] => {
      if (action.type === 'USE_SKILL') return 'skill';
      if (action.type === 'EQUIP_CARD') return 'equip';
      const entity = action.entityId ? state.entities[action.entityId] : undefined;
      const zone = entity?.zoneId ? state.zones[entity.zoneId] : undefined;
      if (entity && (zone?.type === 'HAND' || zone?.type === 'EQUIP')) return 'card';
      if (action.entityId) return 'card';
      return 'command';
    };

    // ---- 目标塌缩 ------------------------------------------------------
    // 同一张牌只因为 `targetPlayerId` 不同而产生的多条合法动作，合并成一张卡：
    // 手牌里「杀」永远只有一张，选谁交给径向选择器 / 二级菜单（而且候选就是引擎
    // 认可的合法目标，选错会被引擎驳回，UI 不自造规则）。
    // 只合并"目标维度单一"的动作：payload 带额外目标（方天画戟 extraTargetIds、
    // 借刀 victimId、铁索 targetIds）或自带 selection 的动作保持原样，否则会丢信息。
    const TARGET_ONLY_KEYS = ['extraTargetIds', 'victimId', 'targetIds'];
    const mergeKeyOf = (action: Action): string | null => {
      if (!action.targetPlayerId || action.selection) return null;
      const payload = { ...(action.payload ?? {}) };
      for (const key of TARGET_ONLY_KEYS) {
        if (key in payload) return null;
      }
      return `${action.actorId ?? action.playerId}|${action.type}|${action.entityId ?? ''}|${
        action.targetNodeId ?? ''
      }|${action.targetEdgeId ?? ''}|${JSON.stringify(payload)}`;
    };

    const seen = new Set<string>();
    const mergeBuckets = new Map<string, { first: Action; targets: Map<string, Action> }>();
    const ordered: Action[] = [];
    for (const action of actions) {
      // 动作族已在上方合并成一个选择器，不再逐条出按钮。
      if (action.family) continue;
      // 被高亮组吸收的动作不再单独出按钮。唯一的例外是「有 idKey 但这条动作
      // 恰好没带该字段」——目前仅 splendor 的按阶盲抽 RESERVE_CARD（没有
      // entityId），它必须继续落到独立按钮分支。
      const group = boardGroups[action.type];
      const groupKey = group?.idKey;
      const absorbed = !!group && (!groupKey || !!action[groupKey]);
      if (absorbed) continue;

      const mergeKey = mergeKeyOf(action);
      if (mergeKey) {
        const bucket = mergeBuckets.get(mergeKey);
        const targetId = action.targetPlayerId as string;
        if (bucket) {
          if (!bucket.targets.has(targetId)) bucket.targets.set(targetId, action);
          continue;
        }
        mergeBuckets.set(mergeKey, { first: action, targets: new Map([[targetId, action]]) });
        ordered.push(action);
        continue;
      }

      // 宝可梦璀璨宝石的 RESERVE_CARD 有两种形态：指定明牌（entityId）或按阶
      // 盲抽（payload.fromTier）。旧实现把所有保留动作塌缩成一个按钮，导致只能
      // 保留第一张/第一阶；这里按「阶段 + 具体卡牌」区分，未知形态再退回按阶。
      const reserveKey = `${action.entityId ?? ''}|${String(action.payload?.fromTier ?? '')}`;
      const dedupeKey = `${action.actorId ?? action.playerId}:${
        action.type === 'RESERVE_CARD'
          ? `${action.type}:${reserveKey}`
          : `${action.type}:${action.entityId ?? ''}:${action.targetNodeId ?? ''}:${
              action.targetEdgeId ?? ''
            }:${JSON.stringify(action.payload ?? {})}`
      }`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      ordered.push(action);
    }

    for (const action of ordered) {
      const mergeKey = mergeKeyOf(action);
      const bucket = mergeKey ? mergeBuckets.get(mergeKey) : undefined;
      const collapsed = !!bucket && bucket.targets.size > 1;
      // 单目标也把目标名去掉（「杀」就是「杀」），但保留一键直达，不逼玩家多点一次。
      const silentTarget = !!bucket && bucket.targets.size === 1;
      const labelSource =
        collapsed || silentTarget ? { ...action, targetPlayerId: undefined } : action;
      const view = describeActionView(state, labelSource);
      if (!view) continue;
      const label = (collapsed || silentTarget ? view.label.trim().replace(/[·→\s]+$/u, '') : view.label) || view.label;

      const selection = collapsed
        ? {
            spec: { source: 'player' as const, min: 1, max: 1 },
            candidates: [...(bucket as { targets: Map<string, Action> }).targets.keys()].map(id => ({
              id,
              label: actorNameOf(id)
            }))
          }
        : action.selection
          ? {
              spec: action.selection,
              candidates: getSelectionCandidates(action.actorId ?? action.playerId, action.selection).map(
                candidate => ({ id: candidate.id, label: candidate.label, icon: candidate.icon })
              )
            }
          : undefined;

      const placementNodeId =
        action.type === 'PLACE_ENTITY' && action.targetSlotId
          ? state.mapGraph.slots?.[action.targetSlotId]?.nodeId
          : undefined;

      const meta = classifyAction(state, action);
      bound.push({
        ui: {
          id: `a${bound.length}`,
          actionType: action.type,
          group: groupOf(action),
          surface: meta.surface,
          verb: meta.verb,
          source: meta.source,
          ...(meta.slot !== undefined ? { slot: meta.slot } : {}),
          ...(meta.risk ? { risk: meta.risk } : {}),
          ...(meta.confirm ? { confirm: meta.confirm } : {}),
          icon: view.icon,
          label,
          hint: view.hint,
          tone: view.tone,
          selection,
          fields: action.fields as UiAction['fields'],
          ...(placementNodeId ? { highlightIds: [placementNodeId] } : {}),
          ...(action.type === 'PLACE_ENTITY' && action.entityId
            ? { placementEntityId: action.entityId }
            : {}),
          ...(action.entityId ? { entityId: action.entityId } : {})
        },
        action: collapsed ? (bucket as { first: Action }).first : action,
        ...(collapsed ? { targetVariants: (bucket as { targets: Map<string, Action> }).targets } : {})
      });
    }

    // 同名不同牌：塌缩之后两张「出【杀】」看着一样，用牌面标题补上身份。
    // 只在"真的撞名"时才加后缀，绝大多数动作保持原来的短标签。
    const labelCounts = new Map<string, number>();
    for (const entry of bound) labelCounts.set(entry.ui.label, (labelCounts.get(entry.ui.label) ?? 0) + 1);
    for (const entry of bound) {
      if ((labelCounts.get(entry.ui.label) ?? 0) < 2) continue;
      const entityId = entry.ui.entityId;
      const title = entityId
        ? (state.entities[entityId]?.components?.cardFace?.title as string | undefined)
        : undefined;
      if (title && !entry.ui.label.includes(title)) {
        entry.ui.label = entry.ui.label + ' · ' + title;
      }
    }

    // Never truncate the dock; keep END_TURN last so a long list cannot bury it.
    const endTurn = bound.find(entry => entry.action?.type === 'END_TURN');
    return endTurn ? [...bound.filter(entry => entry !== endTurn), endTurn] : bound;
  }

export function buildStackView(
  state: ProjectedGameState,
  actorName: (actorId: ActorId) => string
): UiStackFrame[] {
    return [...state.interruptStack].reverse().map(frame => ({
      id: frame.id,
      title: frame.title,
      description: frame.description,
      status: frame.status,
      sourceName: actorName(frame.sourcePlayerId),
      targetName: frame.targetPlayerId
        ? actorName(frame.targetPlayerId)
        : undefined,
      window: frame.responseWindow
        ? {
            priority: !!frame.responseWindow.priorityArbitration,
            deadline: frame.responseWindow.deadline,
            remaining:
              frame.responseWindow.deadline === undefined
                ? undefined
                : Math.max(0, frame.responseWindow.deadline - state.clock),
            eligible: (frame.responseWindow.eligibleActors ?? frame.responseWindow.eligiblePlayers).map(pid => {
              const response = frame.responseWindow!.pendingResponses[pid];
              return {
                id: pid,
                name: actorName(pid),
                pending: !response || response === 'PENDING'
              };
            })
          }
        : undefined
    }));
  }

export function buildDecisionView(
  state: ProjectedGameState,
  window: ProjectedGameState['pendingDecisions'][number],
  actorName: (actorId: ActorId) => string
): UiDecision {
    return {
      id: window.id,
      title: window.title,
      description: window.description ?? '',
      secret: window.secret,
      policyLabel:
        window.policy.type === 'PRIORITY'
          ? `PRIORITY ≥ ${window.policy.shortCircuitAt}`
          : 'ALL COMMITTED',
      deadline: window.deadline,
      remaining:
        window.deadline === undefined ? undefined : Math.max(0, window.deadline - state.clock),
      participants: window.participants.map(pid => ({
        id: pid,
        name: actorName(pid),
        committed: window.submissions[pid] !== undefined
      }))
    };
  }

export function buildHooksView(
  state: ProjectedGameState,
  lookup: (hookId: string) => { name: string; stage: string; priority: number; description: string } | undefined,
  actorName: (actorId: ActorId) => string
): UiHook[] {
    return state.activeHooks.map(instance => {
      const impl = lookup(instance.hookId);
      return {
        instanceId: instance.instanceId,
        hookId: instance.hookId,
        name: impl?.name ?? instance.hookId,
        stage: impl?.stage ?? 'UNKNOWN',
        priority: impl?.priority ?? 0,
        description: impl?.description ?? '实现未注册：状态中只保存 hookId。',
        ownerName: instance.ownerId
          ? actorName(instance.ownerId)
          : undefined,
        params:
          instance.params && Object.keys(instance.params).length > 0
            ? JSON.stringify(instance.params)
            : '—'
      };
    });
  }

export type PlacementSource = Pick<ProjectedGameState, 'globalVars' | 'mapGraph'>;

/** Build the pending-room-tile DTO from any state carrying globalVars + mapGraph. */
export function buildPlacementView(
  state: PlacementSource,
  viewer: ViewerId,
  actor: string | undefined,
  rotation: number
): UiPlacement | undefined {
    const pending = state.globalVars.pendingRoomPlacement as
      | {
          playerId?: string;
          fromRoomId?: string;
          dir?: string;
          defId: string;
          name?: string;
          en?: string;
          floor?: string;
          col?: number;
          row?: number;
          position?: [number, number, number];
          rotations?: number[];
          localDoors?: string[];
          color?: string;
          cost?: number;
          symbol?: string;
          text?: string;
          special?: string;
          tags?: string[];
        }
      | undefined;
    if (!pending) return undefined;
    if (viewer !== 'GOD' && pending.playerId !== viewer && pending.playerId !== actor) {
      return undefined;
    }
    const currentRotation = rotation;
    const DIR_ORDER = ['N', 'E', 'S', 'W'];
    const rotateDir = (dir: string, turns: number) => {
      const idx = DIR_ORDER.indexOf(dir);
      if (idx < 0) return dir;
      return DIR_ORDER[(idx + turns) % 4];
    };
    const OPPOSITES: Record<string, string> = { N: 'S', S: 'N', E: 'W', W: 'E' };
    const DELTAS: Record<string, [number, number]> = {
      N: [0, -1],
      S: [0, 1],
      E: [1, 0],
      W: [-1, 0]
    };
    const DIR_ZH: Record<string, string> = { N: '北门', E: '东门', S: '南门', W: '西门' };

    const rawDoors = (pending.localDoors ?? []) as string[];
    const rotatedDoors = rawDoors.map(d => rotateDir(d, currentRotation));
    const connections: UiPlacementDoorConnection[] = ['N', 'E', 'S', 'W'].map(dir => {
      const hasDoor = rotatedDoors.includes(dir);
      const [dc, dr] = DELTAS[dir] ?? [0, 0];
      const targetCol = Number(pending.col ?? 0) + dc;
      const targetRow = Number(pending.row ?? 0) + dr;

      const neighbor = Object.values(state.mapGraph.nodes).find(node => {
        const p = node.props;
        return (
          node.type === 'ROOM' &&
          p?.floor === pending.floor &&
          Number(p?.col) === targetCol &&
          Number(p?.row) === targetRow
        );
      });

      if (!hasDoor) {
        return {
          dir,
          dirZh: DIR_ZH[dir],
          connected: false,
          status: 'open'
        };
      }

      if (!neighbor) {
        return {
          dir,
          dirZh: DIR_ZH[dir],
          connected: false,
          status: 'open'
        };
      }

      const neighborDoors = Array.isArray(neighbor.props?.doors) ? neighbor.props.doors : [];
      const connects = neighborDoors.includes(OPPOSITES[dir]);
      return {
        dir,
        dirZh: DIR_ZH[dir],
        neighborRoomId: neighbor.id,
        neighborRoomName: String(neighbor.props?.name ?? ''),
        connected: connects,
        status: connects ? 'connected' : 'blocked'
      };
    });

    return {
      defId: pending.defId,
      name: pending.name ?? pending.defId,
      en: pending.en,
      floor: pending.floor ?? '',
      col: Number(pending.col ?? 0),
      row: Number(pending.row ?? 0),
      position: pending.position ?? [0, 0.15, 0],
      rotations: pending.rotations ?? [0],
      rotation,
      doors: pending.localDoors ?? [],
      color: pending.color ?? '#3e2723',
      cost: pending.cost,
      symbol: pending.symbol,
      text: pending.text,
      special: pending.special,
      tags: pending.tags,
      fromRoomId: pending.fromRoomId,
      entryDir: pending.dir,
      connections
    };
}

/**
 * What a viewer may read in one player's hand zone.
 *
 * Readable faces come from the *projection*, so a card the viewer may not see is
 * simply not there; the count of those is reported separately so a settlement can
 * paint card backs instead of pretending the seat is empty-handed.
 */
export function projectedHandOf(
  state: ProjectedGameState,
  playerId: string
): { cards: string[]; hidden: number } {
  const zone = state.zones[`zone_hand_${playerId}`];
  if (!zone) return { cards: [], hidden: 0 };
  const cards: string[] = [];
  let hidden = 0;
  for (const id of zone.orderedEntities) {
    const entity = state.entities[id];
    const title = entity?.components?.cardFace?.title;
    if (entity && entity.isMasked !== true && typeof title === 'string' && title) cards.push(title);
    else hidden += 1;
  }
  return { cards, hidden };
}

/**
 * Resolve one pressed moment button into a capability.
 *
 * The curtain only reports an id; this is where it becomes either a kernel
 * action (the first of the button's `actionTypes` that is legal now) or the
 * host's "leave the table". Anything else is refused rather than guessed.
 */
export function takeMomentButton(
  button: UiMomentAction | undefined,
  bound: readonly BoundAction[],
  leave: (() => void) | undefined,
  dispatch: (actionId: string) => { ok: boolean; error?: string }
): { ok: boolean; error?: string } {
  if (!button) return { ok: false, error: '未知的结算按钮' };
  if (!button.enabled) return { ok: false, error: button.hint ?? '现在还不能这么做' };
  // 按**按钮声明的优先级**找，而不是按绑定顺序找：结算按钮的 actionTypes 是
  // `['READY', 'START_HAND', 'FORCE_START']`，但绑定表里 FORCE_START 可能排前面，
  // 按绑定顺序找就会永远先命中 FORCE_START——绕过 READY 与冷却（issue #177）。
  const target = (button.actionTypes ?? [])
    .map(type =>
      bound.find(candidate => String(candidate.ui.actionType ?? candidate.action?.type ?? '') === type)
    )
    .find(candidate => !!candidate);
  if (target) return dispatch(target.ui.id);
  if (button.leave) {
    if (!leave) return { ok: false, error: '当前入口不支持离开牌桌' };
    leave();
    return { ok: true };
  }
  return { ok: false, error: '该动作现在不可用' };
}

/**
 * Align a moment's declared buttons with the actions that are legal right now.
 *
 * Both sessions do the same thing, and the rule is small but easy to get wrong:
 * an action button is only live when one of its `actionTypes` is in the current
 * action table *and* that entry is not cooling down; a `leave` button needs no
 * kernel action at all — it is the host's capability, so it is always live.
 */
export function resolveMomentButtons(moment: UiMoment, bound: readonly BoundAction[]): UiMoment {
  if (!moment.actions?.length) return moment;
  return {
    ...moment,
    actions: moment.actions.map(button => {
      if (button.leave) return { ...button, enabled: true };
      const legal = bound.find(candidate =>
        (button.actionTypes ?? []).includes(String(candidate.ui.actionType ?? candidate.action?.type ?? ''))
      );
      const cooling = legal?.ui.cooldownMs && legal.ui.cooldownMs > 0 ? legal.ui.cooldownMs : 0;
      return {
        ...button,
        enabled: !!legal && cooling === 0,
        hint: !legal ? button.hint : cooling > 0 ? `冷却中 · ${Math.ceil(cooling / 1000)} 秒` : undefined
      };
    })
  };
}

/** Focus set P(s) computed from a (projected) state alone — no engine needed. */
export function focusActorsOf(state: ProjectedGameState): ActorId[] {
  const raw = state as unknown as GameState;
  const decision = topDecision(raw);
  if (decision && decision.status === 'OPEN') {
    return decision.participants.filter(pid => decision.submissions[pid] === undefined);
  }
  const frame = InterruptStackManager.peek(raw);
  if (frame && frame.status === 'WAITING_INPUT' && frame.responseWindow) {
    const eligible = frame.responseWindow.eligibleActors ?? frame.responseWindow.eligiblePlayers;
    return eligible.filter(
      pid => !frame.responseWindow!.pendingResponses[pid] || frame.responseWindow!.pendingResponses[pid] === 'PENDING'
    );
  }
  return state.gameOver ? [] : [state.activeActorId ?? state.activePlayerId];
}

/** Actor display name from a (projected) state alone. */
export function actorNameOf(state: ProjectedGameState, actorId: ActorId): string {
  return state.players[actorId]?.name ?? state.npcs?.[actorId]?.name ?? actorId;
}
