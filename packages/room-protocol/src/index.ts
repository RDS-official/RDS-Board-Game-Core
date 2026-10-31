/** rds-room/1 — Hub ↔ 桌游客户端共享协议类型。与 RDS-Board-Core src/net 对齐。 */
export const PROTOCOL_VERSION = 'rds-room/1';

/** RFC6902 子集，与内核 net/patch.ts 的 PatchOp 同形。 */
export interface PatchOp { op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test'; path: string; value?: unknown; from?: string; }

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
  players: { id: string; name: string; displayName?: string; avatarUrl?: string }[]; createdAt: number;
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
