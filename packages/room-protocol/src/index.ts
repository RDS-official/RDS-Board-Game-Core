/** rds-room/1 — Hub ↔ 桌游客户端共享协议类型。与 RDS-Board-Core src/net 对齐。 */
export const PROTOCOL_VERSION = 'rds-room/1';

/**
 * RFC6902 子集 —— **只声明真正实现的那三个操作**（issue #218）。
 *
 * 之前这里多声明了 `move` / `copy` / `test`，但 `packages/net/src/patch.ts` 只实现
 * add/remove/replace：协议上说支持、实际收到就崩。现在两边收敛到同一子集，并用
 * `packages/harness/src/suites/patchParity.ts` 做类型级一致性校验。
 */
export interface PatchOp {
  op: 'add' | 'remove' | 'replace';
  path: string;
  value?: unknown;
}

/** Host→Guest，与内核 GameRoom.RoomUpdate 同形。 */
export interface RoomUpdateMessage {
  t: 'room-update';
  viewer: string;
  revision: number;
  baseRevision: number;
  full: boolean;
  state?: unknown;
  patches?: PatchOp[];
}

/** DataChannel 上 Guest↔Host 的全部消息。 */
export type RoomChannelMessage =
  | { t: 'join'; viewer: string; token?: string }
  | { t: 'submit'; action: { type: string; playerId?: string; actorId?: string; payload?: unknown; targets?: unknown[] } }
  | { t: 'snapshot' }
  | { t: 'delta'; sinceRevision: number }
  | RoomUpdateMessage
  | { t: 'error'; message: string }
  | { t: 'bye' };

/** Hub /ws 信令消息。 */
export type SignalMessage =
  | { t: 'join-room'; roomId: string }
  | { t: 'leave-room' }
  | { t: 'hello'; selfId: string; peers: string[] }
  | { t: 'peer-join'; peerId: string }
  | { t: 'peer-leave'; peerId: string }
  | { t: 'sdp'; to: string; from: string; sdp: unknown }
  | { t: 'ice'; to: string; from: string; candidate: unknown }
  /** 大厅实时频道（Phase B）：订阅房间列表变更推送 */
  | { t: 'lobby-sub' }
  | { t: 'lobby-unsub' }
  /** 任意房间字段变化 → 推给 lobby 订阅者与房间组成员 */
  | { t: 'room-updated'; room: HubRoomInfo }
  /** Phase 2: room online presence (broadcast on room-group membership change; online = deduped userIds currently connected) */
  | { t: 'presence'; roomId: string; online: string[] }
  /** Room text chat (server relays in-group only, no persistence) */
  | { t: 'lobby-chat'; roomId: string; text: string }
  | { t: 'lobby-chat'; roomId: string; from: string; name: string; text: string; at: number };

/** Hub REST 上的房间/游戏 DTO。 */
export interface HubGameInfo {
  id: string; name: string; minPlayers: number; maxPlayers: number; clientUrl: string; protocol: string;
  /** 货架卡展示用：预计时长（分钟）与主题色（缺省由前端兜底）。 */
  durationMin?: number; accent?: string;
  /** 可选开局变体（映射 kernel scenarios 的用户可选项；缺省=标准）。 */
  variants?: { id: string; label: string }[];
  /**
   * 该玩法是否允许房主添加内置 AI 补位（德州扑克为 true）。
   * 大厅据此显示「添加 AI」控件。
   */
  aiSeats?: boolean;
}
export interface HubRoomInfo {
  id: string; name: string; gameId: string; hostId: string; hostName: string;
  status: 'open' | 'playing' | 'closed'; maxPlayers: number;
  /**
   * 玩家列表，按**座位序号**升序；`seat` 是连续序号（0 起），也就是建局时的
   * p1..pN（`seat === 0` → `p1`）。
   *
   * 不能拿数组下标当座位：数组是「加入顺序」，掉线重连、退出再加入都会把人追加
   * 到末尾。座位号由服务端维护（离开者的号会被保留），大厅展示、`?playerId=`
   * 深链、座位 → 账号映射都只认 `seat`。
   */
  players: { id: string; name: string; displayName?: string; avatarUrl?: string; seat: number }[];
  createdAt: number;
  /** Phase B：准备制。已按「就绪」的玩家 id 集合。 */
  readyPlayers?: string[];
  /** 私密房：列表可见但加入需房间码（code 仅回传给房主）。 */
  isPrivate?: boolean; code?: string;
  /** 开局变体（透传给游戏客户端 ?scenario=）。 */
  scenarioId?: string;
  /**
   * 房主添加的内置 AI 座位数（德州扑克等支持 AI 补位的玩法）。
   * 这些座位不占真人名额，开局时由游戏夹具按等级编制填入。
   */
  aiSeats?: number;
}
