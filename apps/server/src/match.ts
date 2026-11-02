import crypto from 'node:crypto';
import { GameRoom, RoomUpdate } from '@rds/net/room';
import { GAME_REGISTRY } from '@rds/games/registry';
import { GameModule } from '@rds/kernel/module';
import { Action, DispatchResult, GameState, PlayerId } from '@rds/kernel/types';
import type { PokerHandResult } from '@rds/games/poker/rules';
import { leaveSeat, settleHand, takeSeat } from './pokerSettle.ts';
import { peekAccount, tryGrantAiRelief } from './pokerLedger.ts';
import { POKER_AI_NAMES, getAiHeroName } from '@rds/games/poker/seating';

/**
 * 服务端权威对局（中心模式）。
 *
 * 与 P2P 模式的区别只在权威位置：这里由服务器持有唯一的 `GameRoom`
 * （一个引擎实例 + 每座位投影），客户端（原来意义上的房主与房客）都只是
 * 「读取自己投影、提交动作」的普通客户端。内核与夹具零改动，
 * `GameRoom` 这层 `RoomTransport` seam 正是为此预留的（见
 * docs/LOBBY-INTEGRATION.md 反作弊边界 A1）。
 *
 * 座位分配由服务器决定：大厅房间的玩家顺序即 p1..pN，客户端无法自报座位，
 * 因此伪造他人身份、抢座、偷看隐藏信息在结构上不可能发生。
 */

export interface MatchPlayerSeed {
  userId: string;
  name: string;
  avatarUrl?: string;
}

export interface MatchOptions {
  roomId: string;
  gameId: string;
  scenario?: string;
  /** 按大厅房间的玩家顺序生成座位 p1..pN。 */
  players: MatchPlayerSeed[];
  /**
   * 桌面座位数 = 房间里的真人数量。
   *
   * 缺省时退回夹具默认配置（历史行为）；传入后由夹具决定是否支持该人数，
   * 不支持就抛错，避免"2 人房间摆了 4 个座位、回合卡在无人控制的 p4"。
   */
  seats?: number;
  /**
   * 房主添加的内置 AI 补位数量。AI 不占真人名额，实际桌面座位 =
   * `seats + aiSeats`（由夹具裁剪到支持范围）。
   */
  aiSeats?: number;
  seed?: number;
  /**
   * 每个真人座位的买入（顺序同 `players`）。缺省 = 夹具的标准买入。
   *
   * 由 `MatchManager` 按账号余额决定并**先扣款**，因此引擎的初始筹码与账本
   * 一次对齐：桌上的筹码就是账号已经兑换出来的部分，下桌时按剩余退回。
   */
  stacks?: number[];
}

export interface MatchSeatInfo {
  userId: string;
  seat: PlayerId;
  name: string;
  /** 该座位是内置 AI（无 hub userId，用 `ai:<seat>` 占位）。 */
  isAi?: boolean;
}

const MAX_SEATS = 10;

/** 标准买入：与夹具默认 1000 一致；余额不足时按余额买（`MIN_BUY_IN` 以下不截断）。 */
const POKER_BUY_IN = 1000;
/** 上桌的最低买入，防止 0 筹码账号占住座位。 */
const MIN_BUY_IN = 100;

function randomSeed32(): number {
  return crypto.randomBytes(4).readUInt32BE(0);
}

export class ServerMatch {
  public readonly roomId: string;
  public readonly gameId: string;
  public readonly scenario?: string;
  public readonly seed: number;

  private readonly module: GameModule;
  private readonly room: GameRoom;
  private readonly seats = new Map<string, PlayerId>();
  private readonly attached = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private tickTimer: NodeJS.Timeout | null = null;
  /** AI 节奏泵的定时器与上一次出手时刻。 */
  private aiTimer?: ReturnType<typeof setInterval>;
  private lastAiAt = 0;
  /** 结算开始的时刻：等满冷却就自动替全桌发下一手。 */
  private settleAt = 0;
  /** 上一次派发周期规则（观察者低保）的时刻。 */
  private lastHeartbeatAt = 0;
  private disposed = false;

  constructor(options: MatchOptions) {
    const module = GAME_REGISTRY[options.gameId];
    if (!module) throw new Error('未知游戏：' + options.gameId);
    this.module = module;
    this.roomId = options.roomId;
    this.gameId = options.gameId;
    this.scenario = options.scenario;
    this.seed = options.seed ?? randomSeed32();
    // 真人座位按账号余额买入；AI 补位座位不在 stacks 数组里，由夹具补标准买入。
    const buyIns = (options.stacks ?? []).slice(0, Math.max(1, options.seats ?? 0)).map(amount =>
      Math.max(0, Math.round(Number(amount) || 0))
    );
    this.room = new GameRoom(
      module,
      this.seed,
      undefined,
      options.scenario,
      undefined,
      {
        hostActors: [], // 服务端没有任何「本地房主」，全部走 viewer 校验
        // 桌面座位 = 真人 + AI 补位；`humans` 让夹具知道哪几个座位是真人，
        // 其余按等级编制填入内置 AI。
        ...(options.seats === undefined
          ? {}
          : {
              // 总座位 = 真人 + AI 补位；夹具按 humans 决定哪几座是真人，
              // 其余按等级编制填入内置 AI（见 poker/seating.ts）。
              seats: Math.min(options.seats + (options.aiSeats ?? 0), MAX_SEATS),
              humans: options.seats,
              aiSeats: options.aiSeats ?? 0,
              // 真人座位的买入来自账号余额（见 MatchManager）；AI 补位不传，
              // 由夹具按标准买入填。
              ...(buyIns.length > 0 ? { stacks: buyIns } : {})
            }),
        // AI 交给房间按游戏声明的节奏驱动，真人才能看清每一步。
        ...(module.driver?.aiActionDelayMs ? { autoAi: false } : {})
      }
    );

    // ---- AR-1：中心模式的虚拟别名必须有密钥 --------------------------------
    //
    // `CognitiveObserver.getVirtualAlias()` 在没有 aliasSecret 时退化为
    // FNV-1a 32 位哈希 —— 隐藏实体的 id 可被穷举还原（32 位空间，几秒钟）。
    // P2P 房主侧本来就会生成密钥，但中心模式（服务端权威）一直没有设置，
    // 等于把德扑的牌面、山屋的房间排列暴露给了任何能遍历 id 的客户端。
    //
    // 必须是每房随机、每房不同：同一密钥跨房复用会让别名在不同房间之间
    // 变成可关联的指纹。也必须在任何投影之前设置，否则弱别名会先进缓存。
    this.room.engine.setAliasSecret(crypto.randomBytes(32).toString('hex'));

    // 座位数必须覆盖房间里的真人：夹具可能不支持该人数（固定阵容的夹具会
    // 忽略 seats 请求），这时宁可开局失败，也不要摆出无人控制的空座位。
    if (options.seats !== undefined) {
      const wanted = Math.min(options.seats + (options.aiSeats ?? 0), MAX_SEATS);
      const dealt = this.room.engine.getRawState().playerOrder.length;
      if (dealt !== wanted) {
        this.room.dispose();
        throw new Error(`${module.meta.name} 不支持 ${wanted} 人：该玩法固定 ${dealt} 个座位`);
      }
    }

    // 座位 p1..pN 由大厅玩家顺序决定，并写入展示用昵称/头像（只改展示字段）。
    const rawState = this.room.engine.getRawState();
    options.players.slice(0, MAX_SEATS).forEach((player, index) => {
      const seat = `p${index + 1}` as PlayerId;
      this.seats.set(player.userId, seat);
      const target = rawState.players[seat];
      if (!target) return;
      if (player.name) target.name = String(player.name).slice(0, 24);
      if (player.avatarUrl) target.avatarUrl = player.avatarUrl;
    });

    this.room.onChange(() => {
      // 每手结束先把事实记进账号账本，再推给订阅者：客户端看到结算画面的同一刻，
      // 账本已经是这一手之后的状态，刷新排行榜不会读到旧数据。
      this.settleLatestHand();
      for (const listener of this.listeners) {
        try {
          listener();
        } catch {
          // 单个订阅者（已断开的 socket 等）不影响其他人
        }
      }
    });

    this.startClock();
  }

  /**
   * 把最新一手的结果记进账号账本。
   *
   * 去重交给 `settleHand`（房间 + 手数），这里只负责把座位翻译成账号——
   * 内置 AI / 补位 AI 没有账号，自然被跳过。非扑克玩法没有 `lastHand`，
   * 调用会在类型判断处直接返回。
   */
  private settleLatestHand(): void {
    if (this.module.meta.id !== 'poker') return;
    const raw = this.room.engine.getRawState();
    const lastHand = raw.globalVars.lastHand as PokerHandResult | undefined;
    if (!lastHand?.players?.length) return;
    settleHand(this.roomId, lastHand.handNo, lastHand.players, seat => this.userOf(seat));
  }

  /** 座位 → 账号 id（内置 AI 座位映射到其专属 AI 账号，如 ai:hero:...）。 */
  public userOf(seat: string): string | undefined {
    for (const [userId, claimed] of this.seats) {
      if (claimed === seat) return userId;
    }
    // 检查是否为 AI 座位
    if (this.module.meta.id === 'poker') {
      const raw = this.room.engine.getRawState();
      const aiSeats = (raw.globalVars.seats as { playerId: string; isAi: boolean }[] | undefined) ?? [];
      const matchAi = aiSeats.find(s => s.playerId === seat && s.isAi);
      if (matchAi) {
        const actorName = this.room.engine.getActorName(seat);
        // 从名称中提取武将名字，例如 "初级 AI · 诸葛亮" -> "诸葛亮"
        const hero = POKER_AI_NAMES.find(h => actorName.includes(h));
        if (hero) return `ai:hero:${hero}`;
        const ordinal = Number((seat.match(/\d+/) ?? ['1'])[0]) || 1;
        return `ai:hero:${getAiHeroName(ordinal - 1)}`;
      }
    }
    return undefined;
  }

  public get moduleId(): string {
    return this.module.meta.id;
  }

  /**
   * 权威状态的只读快照。
   *
   * 只给服务端内部记账用（筹码排行、下桌退余额）。**不要**把它塞进任何发给
   * 客户端的消息：投影仍走 `snapshotFor` / `deltaFor`，隐藏信息不外泄。
   */
  public rawState(): GameState {
    return this.room.engine.getRawState();
  }

  public seatOf(userId: string): PlayerId | undefined {
    return this.seats.get(userId);
  }

  /**
   * 桌面全部座位（含内置 AI）。
   *
   * AI 座位没有 hub userId，用 `ai:<seat>` 作为占位 id，这样观测端点能如实
   * 反映「这张桌子有几个座位」，而不只是有几个真人。
   */
  public seatList(): MatchSeatInfo[] {
    const raw = this.room.engine.getRawState();
    const aiSeats = new Set(
      ((raw.globalVars.seats as { playerId: string; isAi: boolean }[] | undefined) ?? [])
        .filter(seat => seat.isAi)
        .map(seat => seat.playerId)
    );
    const bySeat = new Map<string, string>();
    for (const [userId, seat] of this.seats) bySeat.set(String(seat), userId);

    return raw.playerOrder.map(seat => {
      const isAi = aiSeats.has(seat);
      return {
        userId: isAi ? `ai:${seat}` : bySeat.get(seat) ?? `unknown:${seat}`,
        seat,
        name: this.room.engine.getActorName(seat),
        isAi
      };
    });
  }

  /** 记录该用户已连接（推送 delta 用），返回其座位投影。 */
  public attach(userId: string): RoomUpdate | { error: string } {
    const seat = this.seats.get(userId);
    if (!seat) return { error: '你不在本局座位表中' };
    if (!this.attached.has(userId)) {
      this.attached.add(userId);
      this.room.join(seat);
    }
    return this.room.snapshot(seat);
  }

  public detach(userId: string): void {
    if (!this.attached.delete(userId)) return;
    const seat = this.seats.get(userId);
    if (seat) this.room.leave(seat);
  }

  public attachedUsers(): string[] {
    return [...this.attached];
  }

  public snapshotFor(userId: string): RoomUpdate | { error: string } {
    const seat = this.seats.get(userId);
    if (!seat) return { error: '你不在本局座位表中' };
    return this.room.snapshot(seat);
  }

  public deltaFor(userId: string): RoomUpdate | { error: string } {
    const seat = this.seats.get(userId);
    if (!seat) return { error: '你不在本局座位表中' };
    return this.room.delta(seat);
  }

  /** 客户端提交动作：actor 必须是自己座位，内核 action 校验照常兜底。 */
  public submit(userId: string, action: Action): DispatchResult {
    const seat = this.seats.get(userId);
    if (!seat) return this.reject('你不在本局座位表中');
    if (!action || typeof action !== 'object' || typeof action.type !== 'string') {
      return this.reject('malformed action');
    }
    if (action.type.startsWith('__')) return this.reject('invalid action');
    // 驱动方动作（低保心跳）只能由服务器定时器派发，客户端不得伪造。
    if (this.module.driver?.driverActions?.includes(action.type)) return this.reject('invalid action');
    const actor = String(action.actorId ?? action.playerId ?? '');
    if (actor !== seat) return this.reject(`actor does not match viewer: ${actor || '(missing)'}`);
    this.room.setCurrentViewer(seat);
    try {
      return this.room.submit(action);
    } finally {
      this.room.setCurrentViewer(undefined);
    }
  }

  public onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public get revision(): number {
    return this.room.getRevision();
  }

  public isOver(): boolean {
    const state = this.room.engine.getRawState();
    return !!state.gameOver;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // 对局结束 = 下桌：把每个账号还留在桌上的筹码退回余额。放在清理定时器之前，
    // 这样即使后面的清理抛错，账本也已经结平（余额不会凭空蒸发）。
    this.refundTableStakes();
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    if (this.aiTimer) {
      clearInterval(this.aiTimer);
      this.aiTimer = undefined;
    }
    }
    this.listeners.clear();
    this.attached.clear();
    this.room.dispose();
  }

  /**
   * 下桌退款：把每个座位当前的桌上筹码退回账号余额（真人与 AI）。
   *
   * 只在整局释放时调用一次（房间关闭 / 重开 / 进程退出前的清理），
   * 不跟着断线走——断线重连的玩家还坐在那张桌上，筹码不该被退两次。
   */
  private refundTableStakes(): void {
    if (this.module.meta.id !== 'poker') return;
    let raw: GameState;
    try {
      raw = this.room.engine.getRawState();
    } catch {
      return; // 引擎已经不可读（异常关闭路径）：没有可退的账
    }
    const seen = new Set<string>();
    // 1. 真人座位退款
    for (const [userId, seat] of this.seats) {
      const chips = Number(raw.players?.[seat]?.customProps?.chips);
      if (!Number.isFinite(chips) || chips <= 0) continue;
      seen.add(userId);
      leaveSeat(userId, chips, this.roomId);
    }
    // 2. AI 座位退款
    const aiSeats = (raw.globalVars.seats as { playerId: string; isAi: boolean }[] | undefined) ?? [];
    for (const ai of aiSeats) {
      if (!ai.isAi) continue;
      const aiUserId = this.userOf(ai.playerId);
      if (!aiUserId || seen.has(aiUserId)) continue;
      seen.add(aiUserId);
      const chips = Number(raw.players?.[ai.playerId]?.customProps?.chips);
      if (!Number.isFinite(chips) || chips <= 0) continue;
      leaveSeat(aiUserId, chips, this.roomId);
    }
    this.seats.clear();
  }

  private reject(error: string): DispatchResult {
    return { ok: false, error, events: [], stateHash: this.room.engine.getStateHash() };
  }

  /**
   * 逻辑时钟由服务器统一推进：只有当存在带截止时间的开放决策窗口 / 响应窗口时
   * 才 tick，因此没有超时风险的回合不会被无意义地推进。
   */
  private startClock(): void {
    const intervalMs = Number(process.env.MATCH_TICK_MS ?? 1000);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    this.tickTimer = setInterval(() => {
      if (this.disposed) return;
      this.pulseHeartbeat(Date.now());
      if (!this.needsClock()) return;
      this.room.submitUnchecked({ type: '__TICK__', playerId: 'SYSTEM', payload: { ticks: 1 } });
    }, intervalMs);
    this.tickTimer.unref?.();
    this.startAiPump();
  }

  /**
   * 周期规则（观察者低保）：由游戏模块声明节奏，服务器负责按真实时间派发。
   * 内核保持无时钟，动作照常进 actionLog，因此回放仍可复现。
   */
  private pulseHeartbeat(now: number): void {
    const heartbeat = this.module.driver?.heartbeat;
    if (!heartbeat) return;
    if (now - this.lastHeartbeatAt < heartbeat.intervalMs) return;
    const action = heartbeat.action(this.room.engine.getRawState());
    if (!action) return;
    this.lastHeartbeatAt = now;
    this.room.submitUnchecked(action);
  }

  /**
   * 内置 AI 的节奏泵。
   *
   * 房间用 `autoAi: false` 建引擎时，`isAutomated` 标出 AI 座位，具体动作来自它
   * 自己的合法动作表，由这里按 `driver.aiActionDelayMs`（德州 = 5s）逐个
   * 派发：真人能看清 AI 的每一次跟注/加注，而不是一瞬间跳过整轮。
   */
  private startAiPump(): void {
    const delay = this.module.driver?.aiActionDelayMs;
    if (!delay) return;
    const step = Math.max(100, Math.min(delay, 500));
    // 结算兜底：一手结束后等满冷却仍有人没点「准备」，服务器就替全桌开下一手。
    // 真人点准备仍照常提前开局；掉线/走开的玩家不再能把整张桌子卡死。
    const settleGateMs = this.module.driver?.actionCooldownMs?.START_HAND ?? 20000;
    this.aiTimer = setInterval(() => {
      if (this.disposed) return;
      const now = Date.now();
      const engine = this.room.engine;
      const state = engine.getRawState();
      if (state.gameOver) return;
      const actor = engine.getActiveActorId();
      // AI 与真人同一条管线：`isAutomated` 说出谁由机器控制，具体动作直接来自
      // 它自己的合法动作表（结算阶段就是「开下一手」），因此全桌 AI 也能继续打。
      const automated = !!actor && !!this.module.driver?.isAutomated?.(state, actor);
      const action = automated && actor ? engine.getLegalActions(actor)[0] : undefined;
      if (action) {
        if (now - this.lastAiAt < delay) return;
        this.lastAiAt = now;
        this.room.submitUnchecked(action);
        return;
      }
      // 没有 AI 要动：结算态且冷却已满就直接发下一手。
      const hand = state.globalVars.hand as { street?: string } | undefined;
      if (hand?.street !== 'COMPLETE') {
        this.settleAt = 0;
        return;
      }
      if (!this.settleAt) {
        this.settleAt = now;
        return;
      }
      if (now - this.settleAt < settleGateMs) return;
      const seat = state.playerOrder.find(
        pid => Number(state.players[pid]?.customProps?.chips ?? 0) > 0
      );
      if (!seat) return;
      this.settleAt = 0;
      engine.dispatch({ type: 'FORCE_START', playerId: seat });
    }, step);
    this.aiTimer.unref?.();
  }

  private needsClock(): boolean {
    const state = this.room.engine.getRawState();
    if (state.gameOver) return false;
    const clock = state.clock;
    const pending = state.pendingDecisions.some(
      window =>
        window.status === 'OPEN' &&
        ((window.deadline !== undefined && window.deadline <= clock + 1) ||
          window.participants.some(
            pid =>
              window.submissions[pid] === undefined &&
              window.participantDeadlines?.[pid] !== undefined &&
              window.participantDeadlines[pid] <= clock + 1
          ))
    );
    if (pending) return true;
    const top = state.interruptStack[state.interruptStack.length - 1];
    return !!top?.responseWindow?.deadline && top.responseWindow.deadline <= clock + 1;
  }
}

/**
 * 座位表是否与给定配置一致：真人顺序 + 实际桌面座位数都要匹配。
 *
 * 只比较真人会漏掉 AI 补位——房主刚加了 5 个 AI，座位总数变了却仍复用旧对局，
 * 结果 AI 永远上不了桌。
 */
function sameSeats(match: ServerMatch, options: MatchOptions): boolean {
  const seats = match.seatList();
  const humans = Math.min(options.players.length, MAX_SEATS);
  const wanted = Math.min(humans + (options.aiSeats ?? 0), MAX_SEATS);
  if (seats.length !== wanted) return false;
  return options.players
    .slice(0, humans)
    .every((player, index) => seats[index]?.userId === player.userId);
}

/** 房间 → 对局映射。房间关闭或重开时销毁对局。 */
export class MatchManager {
  private readonly matches = new Map<string, ServerMatch>();

  public get(roomId: string): ServerMatch | undefined {
    return this.matches.get(roomId);
  }

  /**
   * 取得已有对局；不存在则按房间玩家顺序创建（中心模式不需要房主在场）。
   *
   * 扑克房间的真人座位在这里**按账号余额兑换买入**：`takeSeat` 先扣款，
   * 再把扣到的金额作为初始筹码交给引擎。余额不足时扣到 0——账号上不了桌的
   * 情况由 `takeSeat` 返回 0 表达，房间侧拿到 0 筹码座位会立刻转观察者，
   * 不会凭空造出「借钱入座」的牌局。
   */
  public ensure(options: MatchOptions): ServerMatch {
    const existing = this.matches.get(options.roomId);
    if (existing) {
      // 开局前（尚无任何真实跃迁）玩家名单可能仍在变化：按最新座位表重建，
      // 避免先进入的玩家把后来者挡在座位表外。一旦产生 revision 就不再重建。
      if (existing.revision === 0 && !sameSeats(existing, options)) {
        // 旧对局作废：它扣掉的买入要退回，玩家不能因为「换了个座位」被扣两次钱。
        existing.dispose();
        this.matches.delete(options.roomId);
      } else {
        return existing;
      }
    }
    const funded = this.fundSeats(options, options.stacks);
    let match: ServerMatch;
    try {
      match = new ServerMatch(funded);
    } catch (error) {
      // 开局失败（座位数不符、夹具拒绝等）必须把刚扣的买入退回去：否则每次
      // 失败的进入都会静默吞掉一笔筹码，而且账本上看不出发生过什么。
      this.refundBuyIns(funded);
      throw error;
    }
    this.matches.set(options.roomId, match);
    return match;
  }

  /**
   * 给座位备好买入：真人按账号余额扣款，AI 检查救济金与买入资格。
   *
   * 筹码不足（低于 MIN_BUY_IN 100）的 AI 不加入对局。
   */
  private fundSeats(options: MatchOptions, provided: number[] | undefined): MatchOptions {
    const module = GAME_REGISTRY[options.gameId];
    if (module?.meta.id !== 'poker') return options;
    if (provided) return options;

    const humans = options.players.length;
    const requestedAi = options.aiSeats ?? 0;
    let allowedAi = 0;
    const aiStacks: number[] = [];

    // 检查并扣减 AI 补位筹码
    for (let i = 0; i < requestedAi; i++) {
      const hero = getAiHeroName(humans + i);
      const aiUserId = `ai:hero:${hero}`;
      let acct = peekAccount(aiUserId);

      // 如果筹码不足 MIN_BUY_IN，尝试领取救济金（半小时最多 2 次）
      if (acct.chips < MIN_BUY_IN) {
        tryGrantAiRelief(aiUserId);
        acct = peekAccount(aiUserId);
      }

      // 如果仍不足 MIN_BUY_IN，则不加入对局
      if (acct.chips < MIN_BUY_IN) {
        continue;
      }

      allowedAi++;
      const wanted = Math.min(acct.chips, POKER_BUY_IN);
      const funded = Math.max(0, Math.round(Number(acct.atTable?.[options.roomId] ?? 0)));
      const charged = funded > 0 ? takeSeat(aiUserId, funded, options.roomId) : takeSeat(aiUserId, wanted, options.roomId);
      aiStacks.push(charged);
    }

    const humanStacks = options.players.slice(0, MAX_SEATS).map(player => {
      const account = peekAccount(player.userId);
      const funded = Math.max(0, Math.round(Number(account.atTable?.[options.roomId] ?? 0)));
      if (funded > 0) return takeSeat(player.userId, funded, options.roomId);
      const wanted = Math.min(account.chips, Math.max(MIN_BUY_IN, Math.min(account.chips, POKER_BUY_IN)));
      return takeSeat(player.userId, wanted, options.roomId);
    });

    const stacks = [...humanStacks, ...aiStacks];
    return {
      ...options,
      aiSeats: allowedAi,
      stacks
    };
  }

  /** 开局失败时退掉已扣的买入（按 `funded.stacks` 退还真人与 AI）。 */
  private refundBuyIns(funded: MatchOptions): void {
    if (!funded.stacks?.length) return;
    const humans = funded.players.length;
    funded.players.slice(0, MAX_SEATS).forEach((player, index) => {
      const charged = Number(funded.stacks?.[index] ?? 0);
      if (charged > 0) leaveSeat(player.userId, charged, funded.roomId);
    });
    // 退还 AI
    const aiCount = funded.aiSeats ?? 0;
    for (let i = 0; i < aiCount; i++) {
      const hero = getAiHeroName(humans + i);
      const aiUserId = `ai:hero:${hero}`;
      const charged = Number(funded.stacks?.[humans + i] ?? 0);
      if (charged > 0) leaveSeat(aiUserId, charged, funded.roomId);
    }
  }

  public close(roomId: string): boolean {
    const match = this.matches.get(roomId);
    if (!match) return false;
    match.dispose();
    this.matches.delete(roomId);
    return true;
  }

  public closeAll(): void {
    for (const match of this.matches.values()) match.dispose();
    this.matches.clear();
  }

  public get size(): number {
    return this.matches.size;
  }

  /** 正在托管的对局（排行聚合、运维观察用；只读遍历）。 */
  public list(): ServerMatch[] {
    return [...this.matches.values()];
  }
}
