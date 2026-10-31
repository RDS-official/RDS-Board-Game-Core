import { rooms, users } from './storage.ts';
import { profileOf } from './auth.ts';
import { randomId } from './config.ts';
import { gameById } from './games.ts';
import { GAME_REGISTRY } from '@rds/games/registry';
import type { HubRoomInfo } from '@rds/room-protocol';

interface RoomRec {
  id: string; name: string; gameId: string; hostId: string;
  status: 'open' | 'playing' | 'closed'; maxPlayers: number;
  players: string[]; createdAt: number;
  /** 房主添加的内置 AI 座位数（目前只有德州扑克支持；开局时由夹具补齐）。 */
  aiSeats?: number;
  /** Phase B */
  readyPlayers: string[];      // 已就绪玩家 id（开局时清空）
  isPrivate: boolean;
  code: string;                // 私密房加入码（6 位大写）
  scenarioId?: string;         // 开局变体
  /** 阶段三：房间回收 */
  lastActivity: number;        // 最近一次状态变更（changed() 触碰）
  firstEmptyAt?: number;       // 全员离线起点（有人上线即清零）
}

/** 房间字段变化 → 推送钩子（index.ts 注入 SignalHub 广播；rooms.ts 不反向依赖 ws）。 */
export let onRoomChanged: (room: HubRoomInfo) => void = () => {};
export function setRoomChangedHook(hook: (room: HubRoomInfo) => void): void { onRoomChanged = hook; }

function genCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

function toInfo(r: RoomRec, opts: { includeCode?: boolean } = {}): HubRoomInfo {
  const host = users.byId(r.hostId);
  const info: HubRoomInfo = {
    id: r.id, name: r.name, gameId: r.gameId,
    hostId: r.hostId, hostName: host?.name ?? '?', status: r.status,
    maxPlayers: r.maxPlayers,
    players: r.players.map(pid => {
      const p = profileOf(pid);
      return p ? { id: pid, name: p.name, displayName: p.displayName, avatarUrl: p.avatarUrl } : { id: pid, name: '?' };
    }),
    createdAt: r.createdAt,
    readyPlayers: [...(r.readyPlayers ?? [])],
    isPrivate: r.isPrivate ?? false,
    scenarioId: r.scenarioId,
    aiSeats: r.aiSeats ?? 0,
  };
  if (opts.includeCode && r.code) info.code = r.code;
  return info;
}

function changed(r: RoomRec, opts: { includeCode?: boolean } = {}): HubRoomInfo {
  // 阶段三：任何房间变更都算「有动作」，供回收清扫的 6h 兜底计时。
  r.lastActivity = Date.now();
  rooms.update(r.id, { lastActivity: r.lastActivity });
  const info = toInfo(r, opts);
  onRoomChanged(info);
  return info;
}

export function getRoomInfo(roomId: string, viewerId?: string): HubRoomInfo | { error: string } {
  const r = rooms.byId(roomId) as RoomRec | undefined;
  if (!r) return { error: '房间不存在' };
  return toInfo(r, { includeCode: viewerId === r.hostId });
}

export function listRooms(): HubRoomInfo[] {
  return rooms.all()
    .filter(r => r.status !== 'closed')
    .map(r => toInfo(r as RoomRec)) as HubRoomInfo[];
}

export interface CreateRoomOpts { maxPlayers?: number; isPrivate?: boolean; scenarioId?: string; }

/**
 * Seats a room will actually be dealt.
 *
 * The kernel's `setup` only takes a seed, so a fixture's player count is fixed
 * per scenario. Reading it back from the fixture (one throwaway `setup(1)`)
 * keeps the room cap in sync with the seats that exist — the alternative is a
 * room that accepts players the engine has no seat for (REVIEW.md S9).
 */
function fixtureSeats(gameId: string, scenarioId?: string): number | undefined {
  const module = GAME_REGISTRY[gameId];
  if (!module) return undefined;
  const factory = scenarioId ? module.scenarios?.[scenarioId]?.setup : module.setup;
  if (!factory) return undefined;
  try {
    return factory(1).playerOrder.length;
  } catch {
    return undefined;
  }
}

export function createRoom(userId: string, name: string, gameId: string, opts: CreateRoomOpts = {}): HubRoomInfo | { error: string } {
  const game = gameById(gameId);
  if (!game) return { error: '未知游戏：' + gameId };
  const variantOk = !opts.scenarioId || game.variants?.some(v => v.id === opts.scenarioId);
  if (!variantOk) return { error: '未知开局变体' };
  // 房间上限：夹具支持 game.maxPlayers 这种人数（可变人数玩法）就用它，
  // 否则退回夹具固定座位数（卡坦岛 3、璀璨宝石 2、山屋 3）。
  const ceiling = seatsSupport(gameId, opts.scenarioId, game.maxPlayers).ok
    ? game.maxPlayers
    : (fixtureSeats(gameId, opts.scenarioId) ?? game.maxPlayers);
  const maxPlayers = Math.min(Math.max(opts.maxPlayers ?? ceiling, game.minPlayers), ceiling);
  const id = randomId('r_');
  const rec: RoomRec = {
    id, name: (name || '未命名房间').slice(0, 40), gameId, hostId: userId,
    status: 'open', maxPlayers,
    players: [userId], createdAt: Date.now(), lastActivity: Date.now(),
    readyPlayers: [userId],          // 房主默认就绪
    isPrivate: !!opts.isPrivate,
    code: genCode(),
    scenarioId: opts.scenarioId,
  };
  rooms.add(rec);
  return changed(rec, { includeCode: true });
}

export function joinRoom(userId: string, roomId: string, code?: string): HubRoomInfo | { error: string } {
  const r = rooms.byId(roomId) as RoomRec | undefined;
  if (!r) return { error: '房间不存在' };
  if (r.status !== 'open') return { error: '房间不可加入（' + r.status + '）' };
  if (!r.players.includes(userId)) {
    if (r.players.length >= r.maxPlayers) return { error: '房间已满' };
    if (r.isPrivate && (!code || code.toUpperCase() !== r.code)) return { error: '房间码不正确' };
    r.players.push(userId);
    rooms.update(roomId, { players: r.players, readyPlayers: r.readyPlayers ?? [] });
  }
  return changed(r, { includeCode: userId === r.hostId });
}

export function leaveRoom(userId: string, roomId: string) {
  const r = rooms.byId(roomId) as RoomRec | undefined;
  if (!r) return { error: '房间不存在' };
  const players = r.players.filter(p => p !== userId);
  const readyPlayers = (r.readyPlayers ?? []).filter(p => players.includes(p));
  if (players.length === 0) {
    rooms.remove(roomId);
    onRoomChanged({ id: roomId, name: r.name, gameId: r.gameId, hostId: '', hostName: '', status: 'closed', maxPlayers: r.maxPlayers, players: [], createdAt: r.createdAt });
    return { id: roomId, closed: true } as unknown as HubRoomInfo;
  }
  const hostId = r.hostId === userId ? players[0] : r.hostId;
  rooms.update(roomId, { players, readyPlayers, hostId });
  const after = rooms.byId(roomId)! as RoomRec;
  return changed(after);
}

/**
 * Can this fixture deal exactly `wanted` seats?
 *
 * Asks the fixture itself (`setup(1, { seats })`): variable-table games honour
 * the request, fixed-roster ones return their own count and the mismatch is the
 * answer. This is what keeps a room from starting with seats nobody sits in.
 */
function seatsSupport(
  gameId: string,
  scenarioId: string | undefined,
  wanted: number
): { ok: boolean; dealt: number } {
  const module = GAME_REGISTRY[gameId];
  const factory = scenarioId ? module?.scenarios?.[scenarioId]?.setup : module?.setup;
  if (!factory) return { ok: false, dealt: 0 };
  try {
    const dealt = factory(1, { seats: wanted }).playerOrder.length;
    return { ok: dealt === wanted, dealt };
  } catch {
    return { ok: false, dealt: 0 };
  }
}

export function setRoomStatus(hostId: string, roomId: string, status: 'open' | 'playing' | 'closed') {
  const r = rooms.byId(roomId) as RoomRec | undefined;
  if (!r) return { error: '房间不存在' };
  if (r.hostId !== hostId) return { error: '只有房主可以操作' };
  if (status === 'playing') {
    // 开局前核对人数：桌面座位 = 真人 + 房主添加的 AI 补位。支持可变人数的玩法
    // （德州扑克 2–10 人）按当前人数发牌；固定阵容的玩法（卡坦岛 3 人、
    // 璀璨宝石 2 人、山屋 3 人）则必须凑齐，否则会出现"空座位永远等不到人"的死局。
    const totalSeats = r.players.length + (r.aiSeats ?? 0);
    const support = seatsSupport(r.gameId, r.scenarioId, totalSeats);
    if (!support.ok) {
      const needed = support.dealt > 0 ? `${support.dealt} 人` : '固定人数';
      return { error: `该玩法需要 ${needed}开局，当前房间 ${r.players.length} 人${r.aiSeats ? ` + ${r.aiSeats} AI` : ''}` };
    }
    // 支持 AI 补位的玩法要求至少达到最低开局人数，AI 就是用来补齐这个缺口的。
    const game = gameById(r.gameId);
    const min = game?.minPlayers ?? 1;
    if (totalSeats < min) {
      return { error: `至少需要 ${min} 个座位开局，可以添加 AI 补位` };
    }
  }
  const patch: Partial<RoomRec> = { status };
  if (status === 'playing') patch.readyPlayers = [];   // 开局清就绪态
  if (status === 'open') patch.readyPlayers = [hostId]; // 回到准备页：房主重新就绪
  rooms.update(roomId, patch);
  return changed(rooms.byId(roomId)! as RoomRec);
}

/** Phase B：玩家就绪/取消就绪。 */
export function setReady(userId: string, roomId: string, ready: boolean) {
  const r = rooms.byId(roomId) as RoomRec | undefined;
  if (!r) return { error: '房间不存在' };
  if (!r.players.includes(userId)) return { error: '你不在该房间内' };
  if (r.status !== 'open') return { error: '对局进行中不能更改就绪状态' };
  const readyPlayers = ready
    ? [...new Set([...(r.readyPlayers ?? []), userId])]
    : (r.readyPlayers ?? []).filter(p => p !== userId);
  rooms.update(roomId, { readyPlayers });
  return changed(rooms.byId(roomId)! as RoomRec);
}

/** Phase B：房主请离玩家。 */
export function kickPlayer(hostId: string, roomId: string, targetId: string) {
  const r = rooms.byId(roomId) as RoomRec | undefined;
  if (!r) return { error: '房间不存在' };
  if (r.hostId !== hostId) return { error: '只有房主可以操作' };
  if (targetId === hostId) return { error: '不能请离自己' };
  if (!r.players.includes(targetId)) return { error: '该玩家不在房间内' };
  return leaveRoom(targetId, roomId);
}

/** Phase B：转移房主。 */
export function transferHost(hostId: string, roomId: string, targetId: string) {
  const r = rooms.byId(roomId) as RoomRec | undefined;
  if (!r) return { error: '房间不存在' };
  if (r.hostId !== hostId) return { error: '只有房主可以操作' };
  if (!r.players.includes(targetId)) return { error: '该玩家不在房间内' };
  rooms.update(roomId, { hostId: targetId });
  return changed(rooms.byId(roomId)! as RoomRec);
}

/**
 * 阶段三：房间回收清扫（index.ts 每 60s 调一次）。
 * 规则：全员离线超过 10 分钟，或 6 小时无任何动作 → 关房（closed 会经 changed()
 * 广播给房间组成员与大厅订阅者）。返回本次被关闭的房间 id 列表。
 */
/**
 * 房主增删内置 AI 座位（目前只有支持 AI 补位的玩法：德州扑克）。
 *
 * AI 不占真人名额：`players` 仍只记真人，`aiSeats` 是额外补位的数量，
 * 开局时由夹具按等级编制填入（见 packages/games/src/poker/seating.ts）。
 */
export function setAiSeats(hostId: string, roomId: string, aiSeats: number) {
  const r = rooms.byId(roomId) as RoomRec | undefined;
  if (!r) return { error: '房间不存在' };
  if (r.hostId !== hostId) return { error: '只有房主可以操作' };
  if (r.status !== 'open') return { error: '对局进行中不能调整 AI' };
  const game = gameById(r.gameId);
  if (!game?.aiSeats) return { error: '该玩法不支持添加 AI' };
  const ceiling = Math.max(0, (game.maxPlayers ?? 0) - r.players.length);
  const wanted = Math.min(ceiling, Math.max(0, Math.floor(aiSeats)));
  rooms.update(roomId, { aiSeats: wanted });
  return changed(rooms.byId(roomId)! as RoomRec);
}

export function sweepRooms(onlineOf: (roomId: string) => string[]): string[] {
  const closedIds: string[] = [];
  const now = Date.now();
  for (const rec of rooms.all()) {
    const r = rec as RoomRec;
    if (r.status === 'closed') {
      // REVIEW.md 短期项 10：closed 房间保留 24h（客户端还能看到状态），之后物理清理。
      if (now - (r.lastActivity ?? r.createdAt) > 24 * 3600 * 1000) rooms.remove(r.id);
      continue;
    }
    if (onlineOf(r.id).length > 0) {
      if (r.firstEmptyAt) rooms.update(r.id, { firstEmptyAt: undefined });
      continue;
    }
    if (!r.firstEmptyAt) {
      rooms.update(r.id, { firstEmptyAt: now });
      continue;
    }
    const emptyMs = now - r.firstEmptyAt;
    const idleMs = now - (r.lastActivity ?? r.createdAt);
    if (emptyMs > 10 * 60 * 1000 || idleMs > 6 * 3600 * 1000) {
      rooms.update(r.id, { status: 'closed', firstEmptyAt: undefined });
      closedIds.push(r.id);
      changed(rooms.byId(r.id)! as RoomRec);
    }
  }
  return closedIds;
}
