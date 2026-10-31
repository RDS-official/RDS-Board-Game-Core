/**
 * Networked session (lobby mode) — GamePresenter for rds-room/1 play.
 *
 * Two authority placements share ONE wire protocol and ONE projection pipeline:
 *
 *  - **centre mode** (`authority: 'server'`, 默认): the server owns the single
 *    engine (`apps/server/src/match.ts`). Every browser — including the old
 *    "host" — is a plain client that reads its own seat projection and submits
 *    actions. No browser holds authority, so a malicious peer cannot rewrite
 *    state, peek at hidden information or fabricate results.
 *  - **p2p mode** (`authority: 'p2p'`): the legacy host-browser-authoritative
 *    path (GameRoom + WebRtcHostTransport + startHostMesh), kept for
 *    compatibility and offline/direct play.
 *
 * Both paths render through the exact same pure view builders as
 * UniversalSession and consume the same `room-update` payload shape, so the HUD
 * code is identical. Local-only debug features (rewind / replay verification /
 * clock forcing) are no-ops with a notice for non-authoritative clients.
 */
import { UniversalGameEngine } from '@rds/kernel/engine';
import { GameModule } from '@rds/kernel/module';
import {
  Action,
  ActorId,
  EntityType,
  GameState,
  PlayerId,
  ProjectedGameState,
  SelectionCandidate,
  SelectionSpec,
  SelectionSpec as Spec,
  VisualTraceEvent
} from '@rds/kernel/types';
import { applyPatch } from '@rds/net/patch';
import { GameRoom, RoomUpdate } from '@rds/net/room';
import {
  HubSignaling,
  WebRtcGuestTransport,
  WebRtcHostTransport,
  openGuestChannel,
  startHostMesh
} from '@rds/net/webrtc-transport';
import { ServerMatchTransport } from '@rds/net/server-transport';
import {
  BoardPick,
  GamePresenter,
  GameSnapshot,
  UiHistoryEntry,
  UiNotice,
  UiSpatialInfo,
  ViewerId
} from './contracts';
import { buildEntityInspectNotice } from './inspect';
import {
  UniversalSession,
  BoundAction,
  actorNameOf,
  buildActionsView,
  buildDecisionView,
  buildHooksView,
  buildNpcsView,
  buildPlacementView,
  buildPlayersView,
  buildStackView,
  focusActorsOf,
  missionLineOf,
  phaseLabelOf
} from './session';

/** Cryptographically-random 32-bit helpers (S5/S6). */
function randomSeed32(): number {
  const c = globalThis.crypto;
  if (c?.getRandomValues) return c.getRandomValues(new Uint32Array(1))[0] >>> 0;
  return (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
}

function randomHex(byteLen: number): string {
  const buf = new Uint8Array(byteLen);
  const c = globalThis.crypto;
  if (c?.getRandomValues) c.getRandomValues(buf);
  else for (let i = 0; i < byteLen; i++) buf[i] = (Math.random() * 256) | 0;
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

export interface NetSessionOptions {
  /** Hub origin, e.g. https://hub.example (docs/LOBBY-INTEGRATION.md). */
  hub: string;
  roomId: string;
  token: string;
  role: 'host' | 'guest';
  /**
   * 权威位置：`server`（默认，中心模式：服务器持有唯一引擎）或 `p2p`
   * （旧行为：房主浏览器为权威）。两者共用同一套 URL 参数与消息契约。
   */
  authority?: 'server' | 'p2p';
  /** This browser's seat; the host's playerId is also its local viewer. */
  playerId: PlayerId;
  /** Guest only: hub userId of the host to dial. */
  hostId?: string;
  scenario?: string;
  /**
   * 桌面座位数。P2P 房主权威模式下由房主决定；缺省取 `roster` 的人数，
   * 再退回夹具默认配置。中心模式由服务器按房间人数决定，这里不生效。
   */
  seats?: number;
  /** Host only; guests ignore this (the host owns the seed). 未传时随机生成（S6）。 */
  seed?: number;
  /** 阶段一：座位 → hub 身份（昵称/头像）。房主开局时写进内核 Player，随 snapshot 同步全员。 */
  roster?: Partial<Record<PlayerId, { name: string; avatarUrl?: string }>>;
  /** 阶段二：座位 → hub userId。把 presence 的 userId 反映射回玩家卡片。 */
  seatOwners?: Partial<Record<PlayerId, string>>;
}

/** Minimal channel the guest transport needs (RTCDataChannel or loopback). */
interface GuestChannel {
  send(text: string): void;
  close?(): void;
}

/**
 * Networked GamePresenter. Construct synchronously (getSnapshot works before
 * the signaling connection resolves), then call \`start()\` to connect.
 */
export class NetSession implements GamePresenter {
  public readonly role: 'host' | 'guest';
  /** `server` = centre mode (authority in the server process); `p2p` = legacy host-browser authority. */
  public readonly authority: 'server' | 'p2p';
  /**
   * True only for the legacy P2P host: it owns the local engine and drives the
   * HUD straight from it. Every other case (centre-mode host AND guest) is a
   * pure projection consumer.
   */
  public readonly isLocalAuthority: boolean;
  /** 本客户端的座位。中心模式下由服务器下发（见 onServerSeat），其余情况来自 URL。 */
  public viewer: PlayerId;

  // --- Phase 2 hooks (set by the web layer before/after start()) ---
  /** Presence updates translated from hub userIds to playerIds (via seatOwners). */
  public onPresence?: (onlinePlayerIds: string[]) => void;
  /** Room was closed by the host (e.g. in-game exit): guests should leave. */
  public onRoomClosed?: () => void;
  /** 阶段三：房客频道断开 → 自动重拨。每次尝试前回调（遮罩文案用），成功后回调 onGuestReconnected。 */
  public onGuestReconnecting?: (attempt: number) => void;
  public onGuestReconnected?: () => void;

  private readonly module: GameModule;
  private readonly options: NetSessionOptions;
  private readonly listeners = new Set<(snapshot: GameSnapshot) => void>();
  private readonly noticeListeners = new Set<(notice: UiNotice) => void>();
  private readonly visualListeners = new Set<(events: VisualTraceEvent[]) => void>();
  // --- host state ---
  private readonly session?: UniversalSession;
  private room?: GameRoom;
  private hostTransport?: WebRtcHostTransport;

  // --- guest state ---
  private state?: ProjectedGameState;
  private guestTransport?: WebRtcGuestTransport;
  private netRevision = 0;
  private appliedRevision = -1;
  private snapshot?: GameSnapshot;
  private bound: BoundAction[] = [];
  private legal: Action[] = [];
  private history: UiHistoryEntry[] = [];
  private activeBoardGroup?: { type: string; idKey: 'targetEdgeId' | 'targetNodeId' | 'entityId'; targets: string[] };
  private armedPlacement?: { entityId: string };
  private placementRotation?: number;
  private readonly bootstrapDependencyErrors: string[] = [];

  // --- centre-mode (server-authoritative) transport ---
  private serverTransport?: ServerMatchTransport;

  // --- shared transport state ---
  private signaling?: HubSignaling;
  private pc?: RTCPeerConnection;
  private channel?: GuestChannel;
  private disposed = false;

  // --- host-only: random seed + alias secret, generated once per session (S5/S6) ---
  private readonly hostSeed: number;
  private readonly aliasSecret: string;

  constructor(module: GameModule, options: NetSessionOptions) {
    this.module = module;
    this.options = options;
    this.role = options.role;
    this.authority = options.authority ?? 'server';
    this.isLocalAuthority = options.role === 'host' && this.authority === 'p2p';
    this.viewer = options.playerId;

    this.hostSeed = options.seed ?? randomSeed32();
    this.aliasSecret = randomHex(32);

    if (this.isLocalAuthority) {
      const seed = this.hostSeed;
      // 中期项 A2：房主侧只有唯一一个权威引擎。HUD（UniversalSession）与
      // 权威房间（GameRoom）共用它，因此本地 dispatch 直接就是权威跃迁，
      // 不需要「本地引擎 → 重放 action 到镜像房间」的双引擎同步。
      // 座位数按房间人数发牌：2 人房间不该摆出 4 个无人控制的座位。
      const seats = options.seats ?? (options.roster ? Object.keys(options.roster).length : undefined);
      const engineOptions = {
        ...(options.scenario ? { scenario: options.scenario } : {}),
        ...(seats === undefined ? {} : { seats })
      };
      const engine = new UniversalGameEngine(
        module,
        seed,
        Object.keys(engineOptions).length > 0 ? engineOptions : undefined
      );
      engine.setAliasSecret(this.aliasSecret);
      const room = new GameRoom(module, seed, this.seatAuthorizer(), options.scenario, engine);
      const inner = new UniversalSession(module, seed, options.scenario, engine);
      inner.setViewer(options.playerId);
      // 开局前把 hub 身份写进内核 Player（展示字段），随 snapshot 同步给房客。
      if (options.roster) {
        for (const [pid, ident] of Object.entries(options.roster)) {
          if (ident?.name) inner.renamePlayer(pid as PlayerId, ident.name, ident.avatarUrl);
        }
      }
      this.room = room;
      this.session = inner;
      // delta 推送由 WebRtcHostTransport 构造时订阅 room.onChange 统一完成。
    } else {
      // Bootstrap a plausible viewer projection without keeping an engine.
      // The placeholder engine uses a FIXED public seed (never the host's real
      // one — the real seed would leak the shuffle order, S6); the first full
      // room-update from the host replaces this projection wholesale.
      const boot = new UniversalGameEngine(module, 42, options.scenario ? { scenario: options.scenario } : undefined);
      this.state = boot.getProjectedStateFor(options.playerId);
      this.bootstrapDependencyErrors = boot.getRules().dependencyErrors();
      this.rebuild();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  /** Connect to the authority. Safe to call once after construction. */
  public async start(): Promise<void> {
    if (this.disposed) return;
    try {
      if (this.authority === 'server') await this.startServerMatch();
      else if (this.role === 'host') await this.startHost();
      else await this.startGuest();
    } catch (error) {
      this.emitNotice({
        kind: 'error',
        icon: '⚠',
        title: '联机初始化失败',
        detail: String((error as Error)?.message ?? error),
        durationMs: 8000
      });
    }
  }

  /**
   * 中心模式：连接服务器权威对局。座位由服务器下发（与大厅玩家顺序一致），
   * 收到座位后以该 viewer 渲染投影；服务端断线时客户端自动重连并重新 join。
   */
  private async startServerMatch(): Promise<void> {
    const transport = new ServerMatchTransport(this.options.hub, this.options.roomId, this.options.token);
    this.serverTransport = transport;
    transport.on({
      onUpdate: update => this.applyUpdate(update),
      onSeat: seat => this.onServerSeat(seat),
      onError: message => {
        this.emitNotice({
          kind: 'error',
          icon: '⚠',
          title: '服务器拒绝了该操作',
          detail: message,
          durationMs: 4200
        });
      },
      onClosed: () => this.onRoomClosed?.(),
      onReconnecting: attempt => this.onGuestReconnecting?.(attempt),
      onReconnected: () => this.onGuestReconnected?.()
    });
    const { seat } = await transport.connect();
    this.onServerSeat(seat);
    transport.requestSnapshot();
  }

  /**
   * 服务器座位下发：客户端不允许自报座位，以服务器结果为准。
   * 座位在首次收到时写定，之后用于所有本地投影与动作构造。
   */
  private onServerSeat(seat: PlayerId): void {
    if (!seat || seat === this.viewer) return;
    this.viewer = seat;
    if (this.state) {
      this.rebuild();
      this.publish();
    }
  }

  private async startHost(): Promise<void> {
    const signaling = new HubSignaling(this.options.hub, this.options.token);
    this.signaling = signaling;
    await signaling.connect(this.options.roomId);
    this.wireSideChannel(signaling);
    const { transport } = this.buildHostRoom(signaling.selfId);
    startHostMesh(signaling, transport);
  }

  /** Create the host transport over the authoritative room (signaling-agnostic). */
  private buildHostRoom(selfId: string): { transport: WebRtcHostTransport } {
    const room = this.room;
    if (!room) throw new Error('host room is only available for role=host sessions');
    // 座位授权器在构造时已注入房间；这里只补上 fellows 的座位归属映射，
    // 让 guest 无法抢先加入别人的座位（中期项 A3）。
    const transport = new WebRtcHostTransport(
      room,
      selfId,
      () => {},
      undefined,
      this.options.seatOwners
    );
    this.hostTransport = transport;
    return { transport };
  }

  /**
   * 中期项 A3：座位 → hub userId 绑定。
   * 有绑定信息的座位只允许其 owner 加入（peerId 由 hub 签名校验，可当令牌用）；
   * 未绑定的座位保持既可以先到先得（兼容无 hub 身份的脚本/单机路径）。
   */
  private seatAuthorizer():
    | ((viewer: PlayerId | 'GOD', token?: string) => boolean)
    | undefined {
    const owners = this.options.seatOwners;
    if (!owners || Object.keys(owners).length === 0) return undefined;
    return (viewer, token) => {
      // GOD 能看到所有隐藏信息（手牌/身份），一旦有座位绑定就不许房客以 GOD 进房，
      // 否则任意人员都能借观众视角作弊。将来的观战模式需要单独下发脱敏投影。
      if (viewer === 'GOD') return false;
      const owner = owners[viewer as PlayerId];
      return !owner || owner === token;
    };
  }

  /** Host session without signaling: tests drive transport.acceptChannel(). */
  public static createLoopbackHost(
    module: GameModule,
    options: NetSessionOptions
  ): { session: NetSession; transport: WebRtcHostTransport } {
    const session = new NetSession(module, { ...options, role: 'host' });
    const { transport } = session.buildHostRoom('u_host_lo');
    return { session, transport };
  }

  private async startGuest(): Promise<void> {
    if (!this.options.hostId) throw new Error('guest role requires hostId');
    const signaling = new HubSignaling(this.options.hub, this.options.token);
    this.signaling = signaling;
    this.wireSideChannel(signaling);
    const hello = await signaling.connect(this.options.roomId);
    // 开局全员同时进入（自动跳转）时，房主的游戏信令连接可能尚未 join-room；
    // 此时拨号 SDP 会被 hub 静默丢弃。先等房主出现在房间里再拨号。
    if (!hello.peers.includes(this.options.hostId)) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 30000); // 兜底放行，交给拨号重试
        signaling.on({
          onPeerJoin: id => { if (id === this.options.hostId) { clearTimeout(timer); resolve(); } }
        });
      });
    }
    // 拨号重试：WebRTC 偶发失败（ICE/超时）时重拨最多 3 次
    let channel: RTCDataChannel | null = null;
    let pc: RTCPeerConnection | null = null;
    let lastError: unknown = new Error('guest channel failed');
    for (let attempt = 0; attempt < 3 && !channel; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1500));
      try {
        const dialed = await openGuestChannel(signaling, this.options.hostId);
        channel = dialed.channel; pc = dialed.pc;
      } catch (err) { lastError = err; }
    }
    if (!channel || !pc) throw lastError;
    this.wireGuestChannel(channel, pc);
  }

  /** Wire a freshly dialed guest data channel（首次拨号与重连共用；重挂后 host 侧会重发全量快照）。 */
  private wireGuestChannel(channel: RTCDataChannel, pc: RTCPeerConnection): void {
    this.pc = pc;
    this.channel = channel as unknown as GuestChannel;
    const transport = new WebRtcGuestTransport(text => this.sendToHost(text));
    channel.onmessage = ev => transport.receive(String((ev as MessageEvent).data));
    channel.onclose = () => this.onGuestDisconnected();
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'disconnected' || state === 'failed') this.onGuestDisconnected();
    };
    this.attachGuestTransport(transport);
  }

  /** Wire an already-connected guest transport (used by start() and tests). */
  public attachGuestTransport(transport: WebRtcGuestTransport): void {
    this.guestTransport = transport;
    transport.onUpdate = update => this.applyUpdate(update);
    transport.join(this.viewer);
  }

  private sendToHost(text: string): void {
    try {
      this.channel?.send(text);
    } catch {
      this.onGuestDisconnected();
    }
  }

  private guestReconnecting = false;
  private hostSeenOffline = false;

  /**
   * 阶段三：房客侧频道断开 → 自动重拨（host 侧 startHostMesh 本就接受新拨号，
   * 阶段二 E2E 已验证 guest 重进可同步）。每 2.5s 一次、最多 40 次（约 100s）；
   * 成功即重挂 transport 并由 transport.join 触发 host 全量快照；全部失败才提示错误。
   */
  private onGuestDisconnected(): void {
    if (this.disposed || this.role !== 'guest' || this.guestReconnecting) return;
    this.guestReconnecting = true;
    void (async () => {
      for (let attempt = 1; attempt <= 40; attempt++) {
        await new Promise(r => setTimeout(r, 2500));
        if (this.disposed) break;
        this.onGuestReconnecting?.(attempt);
        try {
          const dialed = await openGuestChannel(this.signaling!, this.options.hostId!);
          if (this.disposed) break;
          this.wireGuestChannel(dialed.channel, dialed.pc);
          this.guestReconnecting = false;
          this.onGuestReconnected?.();
          return;
        } catch { /* 继续下一次重试 */ }
      }
      this.guestReconnecting = false;
      this.emitNotice({
        kind: 'error',
        icon: '📡',
        title: '与房主的连接已断开',
        detail: '自动重连失败；本页面仍显示最后收到的局面，可刷新页面重试。',
        durationMs: 0
      });
    })();
  }

  /* ------------------------------------------------------------------ */
  /* Guest update pipeline                                               */
  /* ------------------------------------------------------------------ */

  private applyUpdate(update: RoomUpdate): void {
    if (this.isLocalAuthority) return;
    const updateError = (update as { error?: string }).error;
    if (updateError) {
      this.emitNotice({
        kind: 'error',
        icon: '⚠',
        title: '房主拒绝了该操作',
        detail: updateError,
        durationMs: 4200
      });
      return;
    }
    if (update.full) {
      this.state = update.state ?? this.state;
    } else if (update.patches && update.patches.length > 0) {
      if (this.appliedRevision >= 0 && update.baseRevision !== this.appliedRevision) {
        // Missed a delta (e.g. tab was suspended): resync with a full snapshot.
        this.guestTransport?.requestSnapshot();
        this.serverTransport?.requestSnapshot();
        return;
      }
      if (this.state) this.state = applyPatch(this.state, update.patches);
    }
    this.appliedRevision = update.revision;
    this.netRevision = update.revision;
    this.rebuild();
    this.publish();
  }

  /* ------------------------------------------------------------------ */
  /* GamePresenter                                                       */
  /* ------------------------------------------------------------------ */

  public getSnapshot(): GameSnapshot {
    return this.isLocalAuthority ? this.session!.getSnapshot() : this.snapshot!;
  }

  public subscribe(listener: (snapshot: GameSnapshot) => void): () => void {
    if (this.isLocalAuthority) return this.session!.subscribe(listener);
    this.listeners.add(listener);
    listener(this.snapshot!);
    return () => this.listeners.delete(listener);
  }

  public onNotice(listener: (notice: UiNotice) => void): () => void {
    if (this.isLocalAuthority) return this.session!.onNotice(listener);
    this.noticeListeners.add(listener);
    return () => this.noticeListeners.delete(listener);
  }

  /** No kernel events exist on guests; the host forwards its local engine's. */
  public onVisualEvent(listener: (events: VisualTraceEvent[]) => void): () => void {
    if (this.isLocalAuthority) return this.session!.onVisualEvent(listener);
    this.visualListeners.add(listener);
    return () => this.visualListeners.delete(listener);
  }

  public perform(
    actionId: string,
    payload?: Record<string, unknown>,
    targets?: string[]
  ): { ok: boolean; error?: string } {
    if (this.isLocalAuthority) return this.session!.perform(actionId, payload, targets);

    const bound = this.bound.find(entry => entry.ui.id === actionId);
    if (!bound) return { ok: false, error: `unknown action: ${actionId}` };

    if (bound.highlight && !bound.action) {
      if (bound.type && bound.idKey) {
        this.activeBoardGroup = { type: bound.type, idKey: bound.idKey, targets: bound.highlight };
      }
      this.emitNotice({
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
    if (targets && targets.length > 0) action.targets = targets;
    return this.submitAction(action);
  }

  public armPlacement(actionId: string): { ok: boolean; error?: string } {
    if (this.isLocalAuthority) return this.session!.armPlacement(actionId);
    const bound = this.bound.find(entry => entry.ui.id === actionId);
    if (!bound?.action || bound.action.type !== 'PLACE_ENTITY' || !bound.action.entityId) {
      return { ok: false, error: '该动作不支持目标点选' };
    }
    this.armedPlacement = { entityId: bound.action.entityId };
    this.emitNotice({ kind: 'event', icon: '◎', title: '请点击高亮的目标房间', durationMs: 2200 });
    return { ok: true };
  }

  public cancelPlacement(): void {
    if (this.isLocalAuthority) {
      this.session!.cancelPlacement();
      return;
    }
    this.armedPlacement = undefined;
  }

  public pickTarget(pick: BoardPick): { handled: boolean; message?: string } {
    if (this.isLocalAuthority) return this.session!.pickTarget(pick);
    return this.guestPickTarget(pick);
  }

  public rotatePlacement(direction: 1 | -1 = 1): void {
    if (this.isLocalAuthority) {
      this.session!.rotatePlacement(direction);
      return;
    }
    const placement = this.snapshot?.placement;
    if (!placement || placement.rotations.length === 0) return;
    const index = placement.rotations.indexOf(placement.rotation);
    this.placementRotation = placement.rotations[(index + direction + placement.rotations.length) % placement.rotations.length];
    this.rebuild();
    this.publish();
  }

  public confirmPlacement(): { ok: boolean; error?: string } {
    if (this.isLocalAuthority) return this.session!.confirmPlacement();
    const placement = this.snapshot?.placement;
    if (!placement) return { ok: false, error: 'no pending room placement' };
    const bound = this.bound.find(entry => entry.action?.type === 'PLACE_ROOM');
    if (!bound) return { ok: false, error: 'placement action is not legal' };
    return this.perform(bound.ui.id, { rotation: String(placement.rotation) });
  }

  public setViewer(viewer: ViewerId): void {
    if (this.isLocalAuthority) {
      this.session!.setViewer(viewer);
      return;
    }
    this.emitNotice({
      kind: 'event',
      icon: '🪑',
      title: '联机模式下座位固定',
      detail: `你的座位是 ${this.viewer}，不能切换视角。`,
      durationMs: 2600
    });
  }

  public rewind(step: number): void {
    this.emitNotice({
      kind: 'event',
      icon: '⏪',
      title: '联机模式下禁用回溯',
      detail: '回溯会破坏房主侧的权威状态，请在本地单机模式使用。',
      durationMs: 3200
    });
  }

  public verifyReplay(): void {
    this.emitNotice({
      kind: 'event',
      icon: '🔎',
      title: '联机模式下禁用回放校验',
      detail: '回放校验是本地调试功能；房主可在单机模式使用。',
      durationMs: 3200
    });
  }

  public advanceClock(ticks = 1): void {
    if (this.isLocalAuthority) {
      // Local dispatch tails into the room, so guests follow the tick.
      this.session!.advanceClock(ticks);
      return;
    }
    this.emitNotice({
      kind: 'event',
      icon: '⏱',
      title: '时钟由房主推进',
      detail: '联机模式下逻辑时钟只在房主侧推进。',
      durationMs: 2600
    });
  }

  /** Phase 2: presence + room lifecycle side channel (survives mesh handlers). */
  private wireSideChannel(signaling: HubSignaling): void {
    signaling.onSide({
      onPresence: online => {
        // 阶段三：房主掉线后回来时，旧频道大概率已死且 ICE 可能停在半死状态
        // （connectionState 迟迟不转 failed，onclose 不触发）。用 presence 做兜底：
        // 看到 host 上线→下线→再上线且频道未恢复，主动拆掉旧频道走重拨。
        if (this.role === 'guest' && this.options.hostId) {
          const hostOnline = online.includes(this.options.hostId);
          if (!hostOnline) {
            this.hostSeenOffline = true;
          } else if (this.hostSeenOffline) {
            this.hostSeenOffline = false;
            try { this.channel?.close?.(); } catch { /* already gone */ }
            try { this.pc?.close(); } catch { /* already gone */ }
            this.channel = undefined;
            this.pc = undefined;
            this.onGuestDisconnected();
          }
        }
        const owners = this.options.seatOwners;
        if (!owners || !this.onPresence) return;
        const seats = Object.entries(owners)
          .filter(([, uid]) => uid !== undefined && online.includes(uid))
          .map(([pid]) => pid);
        this.onPresence(seats);
      },
      onRoomUpdate: room => {
        if (room?.id === this.options.roomId && room.status === 'closed') this.onRoomClosed?.();
      }
    });
  }

  public dispose(): void {
    this.disposed = true;
    if (this.authority === 'p2p' && this.role === 'guest') {
      try { this.guestTransport?.bye(); } catch { /* channel already gone */ }
      try { this.channel?.close?.(); } catch { /* ignore */ }
      try { this.pc?.close(); } catch { /* ignore */ }
    }
    this.serverTransport?.close();
    this.hostTransport?.dispose();
    this.session?.dispose();
    this.room?.dispose();
    try { this.signaling?.close(); } catch { /* already closed */ }
    this.listeners.clear();
    this.noticeListeners.clear();
    this.visualListeners.clear();
  }

  /* ------------------------------------------------------------------ */
  /* main.ts extras (drag & drop placement)                              */
  /* ------------------------------------------------------------------ */

  public placeEntityAtNode(entityId: string, nodeId?: string): { ok: boolean; error?: string } {
    if (this.isLocalAuthority) return this.session!.placeEntityAtNode(entityId, nodeId);
    const state = this.state;
    if (!state) return { ok: false, error: 'not connected' };
    const actor = state.players[this.viewer];
    const currentRoomId = String(actor?.customProps?.currentRoomId ?? '');
    const trySlots = (roomId: string) => {
      const slots = Object.values(state.mapGraph.slots ?? {}).filter(slot => {
        if (slot.nodeId !== roomId) return false;
        if (slot.accepts?.entityTypes && !slot.accepts.entityTypes.includes(state.entities[entityId]?.type as EntityType)) return false;
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
    const targetRoomId = nodeId || currentRoomId;
    const direct = trySlots(targetRoomId);
    if (direct) return direct;
    if (currentRoomId && targetRoomId !== currentRoomId) {
      const fallback = trySlots(currentRoomId);
      if (fallback) return fallback;
    }
    return { ok: false, error: '该实体没有可放置到目标房间的合法位置' };
  }

  public getPlacementTargets(entityId: string): { nodeId: string; slotId: string; label: string }[] {
    if (this.isLocalAuthority) return this.session!.getPlacementTargets(entityId);
    const state = this.state;
    if (!state) return [];
    const targets: { nodeId: string; slotId: string; label: string }[] = [];
    for (const slot of Object.values(state.mapGraph.slots ?? {})) {
      if (!slot.nodeId) continue;
      if (slot.accepts?.entityTypes && !slot.accepts.entityTypes.includes(state.entities[entityId]?.type as EntityType)) continue;
      const bound = this.bound.find(
        entry =>
          entry.action?.type === 'PLACE_ENTITY' &&
          entry.action.entityId === entityId &&
          entry.action.targetSlotId === slot.id
      );
      if (!bound) continue;
      const node = state.mapGraph.nodes[slot.nodeId];
      targets.push({ nodeId: slot.nodeId, slotId: slot.id, label: String(node?.props?.name ?? slot.nodeId) });
    }
    return targets;
  }

  /* ------------------------------------------------------------------ */
  /* Guest internals                                                     */
  /* ------------------------------------------------------------------ */

  private submitAction(action: Action): { ok: boolean; error?: string } {
    // 中心模式：动作直接交给服务器权威引擎；P2P：交给房主。
    if (this.serverTransport) {
      this.serverTransport.submit(action);
      return { ok: true };
    }
    if (!this.guestTransport) {
      return { ok: false, error: '尚未连接对局服务器，操作未发送' };
    }
    // Optimistic accept: illegal actions are rejected by the authority and come
    // back as an error room-update (emitted as a notice in applyUpdate).
    this.guestTransport.submit(action);
    return { ok: true };
  }

  private resolveCandidates(actorId: ActorId, spec: SelectionSpec): SelectionCandidate[] {
    const state = this.state;
    if (!state) return [];
    if (this.module.resolveSelection) {
      try {
        return this.module.resolveSelection(state as unknown as GameState, actorId, spec);
      } catch {
        // Module expected raw-state bits the projection hides; fall through.
      }
    }
    return this.defaultCandidates(state, spec, actorId);
  }

  private defaultCandidates(state: ProjectedGameState, spec: Spec, actorId: ActorId): SelectionCandidate[] {
    switch (spec.source) {
      case 'node':
      case 'room':
        return Object.values(state.mapGraph.nodes)
          .filter(node => (spec.source === 'room' ? node.type === 'ROOM' : true))
          .map(node => ({ id: node.id, label: String(node.props?.name ?? node.id) }));
      case 'edge':
        return Object.values(state.mapGraph.edges).map(edge => ({ id: edge.id, label: edge.id }));
      case 'entity':
        return Object.values(state.entities)
          .filter((entity): entity is typeof entity & { id: string } => !!entity.id && !entity.isMasked)
          .map(entity => ({ id: entity.id, label: entity.components?.cardFace?.title ?? entity.id }));
      case 'actor':
      case 'player':
        return [
          ...(state.playerOrder ?? []).map(id => ({ id, label: state.players[id]?.name ?? id })),
          ...Object.values(state.npcs ?? {})
            .filter((npc): npc is typeof npc & { id: string } => !!npc.id)
            .map(npc => ({ id: npc.id, label: npc.name }))
        ];
      case 'zone':
        return Object.values(state.zones).map(zone => ({ id: zone.id, label: zone.name }));
      case 'hand': {
        if (this.viewer !== 'GOD' && this.viewer !== actorId) return [];
        const zone = state.zones[`zone_hand_${actorId}`];
        return (zone?.orderedEntities ?? [])
          .map(id => state.entities[id])
          .filter((entity): entity is NonNullable<typeof entity> & { id: string } => !!entity?.id && !entity.isMasked)
          .map(entity => ({ id: entity.id, label: entity.components?.cardFace?.title ?? entity.id }));
      }
      default:
        return [];
    }
  }

  private guestPickTarget(pick: BoardPick): { handled: boolean; message?: string } {
    const snapshot = this.snapshot;
    const state = this.state;
    if (!snapshot || !state) return { handled: false, message: '尚未连接房主' };

    if (this.armedPlacement) {
      if (pick.kind !== 'node') return { handled: false, message: '请点击高亮的房间节点' };
      const entityId = this.armedPlacement.entityId;
      this.armedPlacement = undefined;
      const result = this.placeEntityAtNode(entityId, pick.id);
      return { handled: result.ok, message: result.error };
    }

    const legal = this.legal;
    const actor = this.viewer !== 'GOD' ? this.viewer : focusActorsOf(state)[0] ?? state.activeActorId ?? state.activePlayerId;

    if (snapshot.placement) {
      if (pick.id === 'placement_rotate' || (pick.metadata as Record<string, unknown>)?.intent === 'rotate') {
        this.rotatePlacement(1);
        return { handled: true };
      }
      if (pick.id === 'placement_confirm' || (pick.metadata as Record<string, unknown>)?.intent === 'confirm') {
        const res = this.confirmPlacement();
        return { handled: res.ok, message: res.error };
      }
    }

    const meta = (pick.metadata ?? {}) as Record<string, unknown>;
    if (meta?.type === 'ROOM_NAV') {
      const targetRoomId = String(meta.targetRoomId ?? '');
      const targetName = String(meta.targetName ?? '相邻房间');
      const moveAction = legal.find(
        a =>
          a.type === 'MOVE_TO_ROOM' &&
          (a.targetNodeId === targetRoomId ||
            (a.selection?.scope as { neighbors?: string[] } | undefined)?.neighbors?.includes(targetRoomId))
      );
      if (moveAction) {
        const res = this.submitAction({ ...moveAction, targets: [targetRoomId] });
        if (res.ok) {
          this.emitNotice({ kind: 'event', icon: '🚪', title: `走入了【${targetName}】`, durationMs: 1800, roomId: targetRoomId });
        }
        return { handled: res.ok, message: res.error };
      }
      const moveNpcAction = legal.find(a => a.type === 'MOVE_NPC' && a.targetNodeId === targetRoomId);
      if (moveNpcAction) return { handled: this.submitAction(moveNpcAction).ok };
    }

    if (meta?.type === 'DOOR') {
      const dir = meta.direction;
      const exploreAction = legal.find(a => a.type === 'EXPLORE_DOOR' && a.payload?.direction === dir);
      if (exploreAction) return { handled: this.submitAction(exploreAction).ok };
    }

    const isDirectInteract = meta?.intent === 'interact';
    if (isDirectInteract && !this.activeBoardGroup) {
      if (pick.kind === 'node') {
        const directMoveAction = legal.find(
          a =>
            a.type === 'MOVE_TO_ROOM' &&
            (a.targetNodeId === pick.id ||
              (a.selection?.scope as { neighbors?: string[] } | undefined)?.neighbors?.includes(pick.id))
        );
        if (directMoveAction) {
          const res = this.submitAction({ ...directMoveAction, targetNodeId: pick.id, targets: [pick.id] });
          return { handled: res.ok, message: res.error };
        }
        const directNpcAction = legal.find(a => a.type === 'MOVE_NPC' && a.targetNodeId === pick.id);
        if (directNpcAction) return { handled: this.submitAction(directNpcAction).ok };
      } else if (pick.kind === 'entity') {
        const directCombatAction =
          legal.find(a => a.type === 'ATTACK_MONSTER' && a.entityId === pick.id) ??
          legal.find(a => a.type === 'ATTACK_HERO' && a.targetPlayerId === pick.id) ??
          legal.find(a => a.type === 'SLAP' && a.targetPlayerId === pick.id);
        if (directCombatAction) return { handled: this.submitAction(directCombatAction).ok };
      }
    }

    if (pick.kind === 'entity' && !this.activeBoardGroup) {
      const notice = buildEntityInspectNotice(state.entities[pick.id], {
        snapshot,
        module: this.module
      });
      if (notice) {
        this.emitNotice(notice);
        return { handled: true };
      }
    }

    if ((pick.kind === 'node' || pick.kind === 'edge') && !this.activeBoardGroup) {
      const node = state.mapGraph.nodes[pick.id];
      const edge = state.mapGraph.edges[pick.id];
      const isRoom = pick.kind === 'node' && node?.type === 'ROOM';
      const title = pick.kind === 'node' ? String(node?.props?.name ?? node?.type ?? '节点') : String(edge?.id ?? '边');
      this.emitNotice({
        kind: 'event',
        icon: isRoom ? '🏚' : '🔍',
        title: isRoom ? `察看了 ${title}` : `已选中 ${title}`,
        detail: isRoom ? '房间档案已更新。' : '这是查看操作；移动/建造请先从动作栏选择动作。',
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
            action => !!action.selection && this.resolveCandidates(action.actorId ?? action.playerId, action.selection).some(candidate => candidate.id === pick.id)
          );
          return selectionAction ? { ...selectionAction, targets: [pick.id] } : undefined;
        })()
      );
    })();

    if (!match) {
      const message = '该对象当前不是合法目标。可先在动作栏选择动作，桌面会高亮全部候选位置。';
      this.emitNotice({ kind: 'error', icon: '◌', title: message, durationMs: 2800 });
      return { handled: false, message };
    }

    this.activeBoardGroup = undefined;
    const result = this.submitAction(match);
    return { handled: result.ok, message: result.error };
  }

  private rebuild(): void {
    const state = this.state;
    if (!state) return;
    const module = this.module;
    const actorName = (id: ActorId) => actorNameOf(state, id);

    const focusActors = focusActorsOf(state);
    const focus = focusActors.filter(id => !!state.players[id]);
    const actor = this.viewer !== 'GOD' ? this.viewer : focusActors[0] ?? state.activeActorId ?? state.activePlayerId;

    const openDecision = state.pendingDecisions.find(w => w.status === 'OPEN');
    const acting = openDecision
      ? openDecision.participants.filter(pid => openDecision.submissions[pid] === undefined)
      : focusActors;

    // The projection's legalActions are always the viewer's own; show them
    // only when it is actually this viewer's turn to act.
    this.legal = acting.length === 0 || acting.includes(this.viewer) ? state.legalActions : [];
    this.bound = buildActionsView(state, this.legal, (actorId, spec) => this.resolveCandidates(actorId, spec));

    const actorNameLabel =
      acting.length > 1 ? `${acting.length} 个行动者待提交` : actorName(acting[0] ?? actor);

    const placement = buildPlacementView(state, this.viewer, actor, this.placementRotation ?? 0);
    if (!placement) this.placementRotation = undefined;
    else if (this.placementRotation === undefined) this.placementRotation = placement.rotation;

    // Guest activity feed: derive UiHistoryEntry from the authoritative actionLog
    // (visual trace events do not cross the wire).
    this.history = state.actionLog.slice(-60).map((action, i) => ({
      id: `n${state.actionLog.length - Math.min(60, state.actionLog.length) + i}`,
      kind: 'system' as const,
      icon: '•',
      title: `${actorName(action.actorId ?? action.playerId)}：${action.type}`,
      round: state.round,
      turn: state.turn,
      actorName: actorName(action.actorId ?? action.playerId)
    })).reverse();

    this.snapshot = {
      revision: this.netRevision,
      gameId: module.meta.id,
      gameName: module.meta.name,
      capabilities: { ...module.meta.capabilities },
      schemaCount: Object.keys(module.actionSchemas ?? {}).length,
      dependencyErrors: this.bootstrapDependencyErrors,

      phaseLabel: phaseLabelOf(state),
      mission: missionLineOf(state),
      round: state.round,
      turn: state.turn,
      clock: state.clock,
      actorName: actorNameLabel,
      focus,
      focusActors,
      viewer: this.viewer,
      viewers: [
        { id: 'GOD', name: '全知上帝视角' },
        ...state.playerOrder.map(pid => ({ id: pid, name: state.players[pid]?.name ?? pid }))
      ],

      players: buildPlayersView(state, focus),
      npcs: buildNpcsView(state, focusActors, actorName),
      actions: this.bound.map(entry => entry.ui),
      legalCount: this.legal.length,

      stackDepth: state.interruptStack.length,
      stack: buildStackView(state, actorName),
      decision: openDecision ? buildDecisionView(state, openDecision, actorName) : undefined,
      openDecisions: state.pendingDecisions.filter(w => w.status === 'OPEN').length,

      hooks: buildHooksView(state, () => undefined, actorName),
      history: this.history,
      spatial: this.buildSpatial(state, actor),
      placement,
      log: {
        entries: state.actionLog.map((action, index) => ({
          index,
          playerId: action.playerId,
          type: action.type,
          targetId: action.targetPlayerId
        })),
        cursor: state.actionLog.length,
        total: state.actionLog.length,
        seed: 0, // seed is host-owned and never sent to guests
        hash: ''
      },
      board: state,

      gameOver: state.gameOver,
      winnerLabel: state.gameOver
        ? Array.isArray(state.winner)
          ? state.winner.map(id => actorName(id)).join(' / ')
          : state.winner
          ? actorName(state.winner)
          : ''
        : '',
      winnerReason: state.gameOver ? state.winnerReason : undefined
    };
  }

  private buildSpatial(state: ProjectedGameState, actor?: string): UiSpatialInfo | undefined {
    const floors = state.mapGraph.topology?.layers ?? [];
    if (floors.length === 0) return undefined;
    const playerRoom = actor ? state.players[actor]?.customProps?.currentRoomId : undefined;
    const npcRoom = actor ? state.npcs?.[actor]?.customProps?.roomId : undefined;
    const activeNodeId = String(playerRoom ?? npcRoom ?? '') || undefined;
    let activeFloor: string | undefined;
    if (activeNodeId) {
      try {
        activeFloor = this.module.spatial?.floorAt?.(state as unknown as GameState, activeNodeId);
      } catch {
        activeFloor = undefined;
      }
      const node = state.mapGraph.nodes[activeNodeId];
      activeFloor = activeFloor ?? node?.layer ?? (node?.props?.floor as string | undefined);
    }
    return { floors, activeNodeId, activeFloor };
  }

  private emitNotice(notice: UiNotice): void {
    this.noticeListeners.forEach(listener => {
      listener(notice);
    });
  }

  private publish(): void {
    this.listeners.forEach(listener => {
      listener(this.snapshot!);
    });
  }
}
