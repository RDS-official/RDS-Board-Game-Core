import crypto from 'node:crypto';
import { GameRoom, RoomUpdate } from '@rds/net/room';
import { GAME_REGISTRY } from '@rds/games/registry';
import { GameModule } from '@rds/kernel/module';
import { Action, DispatchResult, PlayerId } from '@rds/kernel/types';

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
  seed?: number;
}

export interface MatchSeatInfo {
  userId: string;
  seat: PlayerId;
  name: string;
}

const MAX_SEATS = 10;

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
  private disposed = false;

  constructor(options: MatchOptions) {
    const module = GAME_REGISTRY[options.gameId];
    if (!module) throw new Error('未知游戏：' + options.gameId);
    this.module = module;
    this.roomId = options.roomId;
    this.gameId = options.gameId;
    this.scenario = options.scenario;
    this.seed = options.seed ?? randomSeed32();
    this.room = new GameRoom(
      module,
      this.seed,
      undefined,
      options.scenario,
      undefined,
      {
        hostActors: [], // 服务端没有任何「本地房主」，全部走 viewer 校验
        ...(options.seats === undefined ? {} : { seats: options.seats })
      }
    );

    // 座位数必须与房间里的真人一致：夹具可能不支持该人数（固定阵容的夹具会
    // 忽略 seats 请求），这时宁可开局失败，也不要摆出无人控制的空座位。
    if (options.seats !== undefined) {
      const wanted = Math.min(options.seats, MAX_SEATS);
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

  public get moduleId(): string {
    return this.module.meta.id;
  }

  public seatOf(userId: string): PlayerId | undefined {
    return this.seats.get(userId);
  }

  public seatList(): MatchSeatInfo[] {
    const out: MatchSeatInfo[] = [];
    for (const [userId, seat] of this.seats) {
      out.push({ userId, seat, name: this.room.engine.getActorName(seat) });
    }
    return out;
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
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.listeners.clear();
    this.attached.clear();
    this.room.dispose();
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
      if (!this.needsClock()) return;
      this.room.submitUnchecked({ type: '__TICK__', playerId: 'SYSTEM', payload: { ticks: 1 } });
    }, intervalMs);
    this.tickTimer.unref?.();
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

/** 座位表是否与给定玩家顺序一致（只比较 userId）。 */
function sameSeats(match: ServerMatch, players: MatchPlayerSeed[]): boolean {
  const seats = match.seatList();
  if (seats.length !== Math.min(players.length, MAX_SEATS)) return false;
  return seats.every((seat, index) => seat.userId === players[index]?.userId);
}

/** 房间 → 对局映射。房间关闭或重开时销毁对局。 */
export class MatchManager {
  private readonly matches = new Map<string, ServerMatch>();

  public get(roomId: string): ServerMatch | undefined {
    return this.matches.get(roomId);
  }

  /** 取得已有对局；不存在则按房间玩家顺序创建（中心模式不需要房主在场）。 */
  public ensure(options: MatchOptions): ServerMatch {
    const existing = this.matches.get(options.roomId);
    if (existing) {
      // 开局前（尚无任何真实跃迁）玩家名单可能仍在变化：按最新座位表重建，
      // 避免先进入的玩家把后来者挡在座位表外。一旦产生 revision 就不再重建。
      if (existing.revision === 0 && !sameSeats(existing, options.players)) {
        existing.dispose();
        this.matches.delete(options.roomId);
      } else {
        return existing;
      }
    }
    const match = new ServerMatch(options);
    this.matches.set(options.roomId, match);
    return match;
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
}
