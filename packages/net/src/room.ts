import { UniversalGameEngine, ExportedLog, ReplayReport } from '@rds/kernel/engine';
import { GameModule } from '@rds/kernel/module';
import { Action, DispatchResult, PlayerId, ProjectedGameState } from '@rds/kernel/types';
import { applyPatch, diffJson, PatchOp } from './patch';

/**
 * Server-authoritative room adapter.
 *
 * The room owns one engine instance and never hands raw state to clients:
 * each viewer receives its own projection O(s, i) plus incremental patches.
 * This is the seam where a Durable Object / Phoenix Channel / Tokio actor
 * would sit; the kernel itself stays transport-agnostic.
 *
 * 中期项 A2：引擎可以注入（第 5 参）。房主侧把同一个 UniversalGameEngine
 * 同时交给本房间和 UniversalSession，因此 HUD 的每一次 dispatch 都直接
 * 作用于权威状态，不再需要「本地引擎 → 重放 action 到镜像房间」的双引擎
 * 同步。虚构、偏离、丢步这三类分歧从结构上不可能发生。
 */

export interface RoomUpdate {
  viewer: PlayerId | 'GOD';
  revision: number;
  baseRevision: number;
  full: boolean;
  state?: ProjectedGameState;
  patches: PatchOp[];
}

interface ViewerCache {
  revision: number;
  projection: unknown;
}

export interface RoomJoinOptions {
  token?: string;
}

/** 房主本地调用的 actor 授权（见构造器 options.hostActors）。 */
export interface GameRoomOptions {
  hostActors?: PlayerId[] | 'ALL';
}

export type RoomAuthorizer = (viewer: PlayerId | 'GOD', token?: string) => boolean;

/** Transport-neutral room port; HTTP/WebSocket adapters implement the same shape. */
export interface RoomTransport {
  join(viewer: PlayerId | 'GOD', token?: string): RoomUpdate;
  leave(viewer: PlayerId | 'GOD'): void;
  submit(action: Action): DispatchResult;
  snapshot(viewer: PlayerId | 'GOD'): RoomUpdate;
  delta(viewer: PlayerId | 'GOD'): RoomUpdate;
}

export class GameRoom implements RoomTransport {
  public readonly engine: UniversalGameEngine;
  private revision = 0;
  private caches = new Map<string, ViewerCache>();
  private authorizer?: RoomAuthorizer;
  private readonly changeListeners = new Set<() => void>();
  private currentViewer?: PlayerId | 'GOD';
  private lastSeenHash: string;
  /** 引擎每次真实状态变化后 revision +1（同一状态重复通知不会虚增）。 */
  private readonly unobserveState: () => void;

  /**
   * @param engine 可注入共享引擎（房主侧与 UniversalSession 共享同一实例）。
   *               不传则房间自己新建一个（纯服务端 / 脚本 / 测试路径）。
   */
  /**
   * @param options.hostActors 允许房主（本地调用方）代行的 actor 集合。
   *   缺省=只允许房主自己的座位；传入 `'ALL'` 表示不限制（房主承担全部操作的
   *   单机/热座模式）；也可显式给出座位列表。房客的动作永远只允许自己的座位，
   *   该配置只影响房主本地调用。
   */
  constructor(
    module: GameModule,
    seed = 1,
    authorizer?: RoomAuthorizer,
    scenario?: string,
    engine?: UniversalGameEngine,
    private readonly options: GameRoomOptions = {}
  ) {
    this.engine = engine ?? new UniversalGameEngine(module, seed, scenario ? { scenario } : undefined);
    this.authorizer = authorizer;
    this.lastSeenHash = this.engine.getStateHash();
    this.unobserveState = this.engine.onStateChange(() => this.onEngineStateChange());
  }

  /** 替换/清除座位授权器（联机座位绑定在运行期才拿得到 seatOwners）。 */
  public setAuthorizer(authorizer?: RoomAuthorizer): void {
    this.authorizer = authorizer;
  }

  /** 任何真实状态跃迁之后触发（房主用它把 delta 推给房客）。 */
  public onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /** 切断与引擎的连接（房间被丢弃时调用，防止监听泄漏）。 */
  public dispose(): void {
    this.unobserveState();
    this.changeListeners.clear();
    this.caches.clear();
  }

  private onEngineStateChange(): void {
    // 引擎对 setViewer 之类「只看不改变规则状态」的操作也会发通知；
    // 只有状态哈希真正变化才推进 revision，保证 revision 与 action log 对齐。
    const hash = this.engine.getStateHash();
    if (hash === this.lastSeenHash) return;
    this.lastSeenHash = hash;
    this.revision += 1;
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch {
        // A failing subscriber (e.g. a closed channel) must not break dispatch.
      }
    }
  }

  public getRevision(): number {
    return this.revision;
  }

  public join(viewer: PlayerId | 'GOD', token?: string): RoomUpdate {
    if (this.authorizer && !this.authorizer(viewer, token)) {
      throw new Error(`unauthorized room viewer: ${viewer}`);
    }
    this.caches.set(viewer, {
      revision: this.revision,
      projection: this.projectionJson(viewer)
    });
    return {
      viewer,
      revision: this.revision,
      baseRevision: this.revision,
      full: true,
      state: this.engine.getProjectedStateFor(viewer),
      patches: []
    };
  }

  public leave(viewer: PlayerId | 'GOD'): void {
    this.caches.delete(viewer);
  }

  /** 房间层提交：校验 actor 归属后转发引擎（房客路径最终也走这里）。 */
  public submit(action: Action): DispatchResult {
    const viewer = this.currentViewer;
    if (viewer && viewer !== 'GOD' && !this.isActorAllowed(viewer, action)) {
      return {
        ok: false,
        error: `actor does not match viewer: ${String(action.actorId ?? action.playerId)}`,
        events: [],
        stateHash: this.engine.getStateHash()
      };
    }
    return this.submitUnchecked(action);
  }

  /** 房主本地路径：信任调用方（HUD 只生成合法动作），只推进状态并通知订阅者。 */
  public submitUnchecked(action: Action): DispatchResult {
    // revision 由引擎状态通知推进（见 onEngineStateChange），这里不再手动 +1：
    // 房主本地 dispatch 与房客远程 submit 走的是同一条路径，计数语义一致。
    return this.engine.dispatch(action);
  }

  /** 标记当前正在提交的 viewer（房客路径进入 submit 前设置）。 */
  public setCurrentViewer(viewer: PlayerId | 'GOD' | undefined): void {
    this.currentViewer = viewer;
  }

  private isActorAllowed(viewer: PlayerId | 'GOD', action: Action): boolean {
    const actor = String(action.actorId ?? action.playerId ?? viewer);
    if (this.options.hostActors === 'ALL') return true;
    if (Array.isArray(this.options.hostActors) && this.options.hostActors.includes(viewer as PlayerId)) return true;
    return actor === viewer;
  }

  /** Projection for a specific viewer without changing the room's own viewer. */
  public snapshot(viewer: PlayerId | 'GOD'): RoomUpdate {
    const state = this.engine.getProjectedStateFor(viewer);
    return {
      viewer,
      revision: this.revision,
      baseRevision: this.revision,
      full: true,
      state,
      patches: []
    };
  }

  /** Legal actions for a room client; clients still map these to UiAction DTOs. */
  public actions(viewer: PlayerId | 'GOD'): Action[] {
    return this.engine.getProjectedStateFor(viewer).legalActions;
  }

  /**
   * Incremental update o_{i,t-1} → o_{i,t}.
   * Hidden information never appears in a patch because the diff is computed on
   * the scrubbed projection, not on the raw state.
   */
  public delta(viewer: PlayerId | 'GOD'): RoomUpdate {
    const current = this.projectionJson(viewer);
    const cache = this.caches.get(viewer);

    if (!cache) {
      this.caches.set(viewer, { revision: this.revision, projection: current });
      return {
        viewer,
        revision: this.revision,
        baseRevision: this.revision,
        full: true,
        state: this.engine.getProjectedStateFor(viewer),
        patches: []
      };
    }

    const patches = diffJson(cache.projection, current);
    const baseRevision = cache.revision;

    if (patches.length > 0) {
      this.caches.set(viewer, { revision: this.revision, projection: current });
    }

    return {
      viewer,
      revision: this.revision,
      baseRevision,
      full: false,
      patches
    };
  }

  /** Applies a delta exactly as a client would, for tests and replay tooling. */
  public applyClientDelta(previous: unknown, update: RoomUpdate): unknown {
    return applyPatch(previous, update.patches);
  }

  /** Serializable room checkpoint: seed + append-only action log. */
  public exportState(): ExportedLog & { revision: number } {
    return { ...this.engine.exportLog(), revision: this.revision };
  }

  /** Restore a room from a checkpoint (replay-through, not a raw state dump). */
  public restore(payload: ExportedLog & { revision?: number }): ReplayReport {
    const report = this.engine.loadLog({
      moduleId: payload.moduleId,
      seed: payload.seed,
      scenario: payload.scenario,
      actions: payload.actions,
      stateHash: payload.stateHash,
      schemaVersion: payload.schemaVersion,
      engineVersion: payload.engineVersion
    });
    this.revision = payload.revision ?? payload.actions.length;
    this.lastSeenHash = this.engine.getStateHash();
    this.caches.clear();
    return report;
  }

  private projectionJson(viewer: PlayerId | 'GOD'): unknown {
    return JSON.parse(JSON.stringify(this.engine.getProjectedStateFor(viewer)));
  }
}
