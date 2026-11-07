/** 极简 JSON 文件存储。接口按同步 KV 设计，未来可原样换 SQLite。 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.ts';

export interface UserRecord {
  id: string; name: string; passHash: string; salt: string; createdAt: number;
  /** 阶段一：用户资料。displayName=对外昵称（缺省用登录名）；avatarExt/avatarRev=头像文件扩展与版本号（缓存击穿用）。 */
  displayName?: string; avatarExt?: 'png' | 'jpg' | 'webp'; avatarRev?: number;
  /** 账号角色：admin / user */
  role?: 'admin' | 'user';
  /** 账号是否被管理员禁用 */
  disabled?: boolean;
  /** 令牌世代：改密/重置密码时 +1，使该用户所有已签发 JWT 立即失效（缺省视为 0） */
  tokenEpoch?: number;
  /** 三国杀积分：由服务端权威对局结算，零和增减。 */
  sanguoshaPoints?: number;
  /** 三国杀生涯：场次 / 胜场（排行榜与个人资料展示）。 */
  sanguoshaCareer?: { games: number; wins: number };
  /** 已结算的房间（防止重连 / 重建对局重复加减分）。 */
  sanguoshaSettled?: Record<string, number>;
}
export interface RoomRecord {
  id: string; name: string; gameId: string; hostId: string; status: 'open' | 'playing' | 'closed';
  maxPlayers: number; players: string[]; createdAt: number;
  /** Phase B（旧数据可能缺省） */
  readyPlayers?: string[]; isPrivate?: boolean; code?: string; scenarioId?: string;
  /** 阶段三：房间回收（旧数据可能缺省，清扫按 createdAt 兜底） */
  lastActivity?: number; firstEmptyAt?: number;
  /** 房主添加的内置 AI 座位数（旧数据缺省 = 0）。 */
  aiSeats?: number;
  /** 账号 → 固定座位序号（旧数据缺省：按 players 顺序推导）。 */
  seatIndex?: Record<string, number>;
}

interface DbShape { users: UserRecord[]; rooms: RoomRecord[]; }

const FILE = path.join(DATA_DIR, 'hub.json');

/** 解析结果：损坏时带原因，不在这里做 IO（便于单测）。 */
export function parseDb(text: string): { ok: true; data: DbShape } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(text) as DbShape;
    if (!parsed || !Array.isArray(parsed.users) || !Array.isArray(parsed.rooms)) {
      return { ok: false, error: 'bad shape: users/rooms must be arrays' };
    }
    return { ok: true, data: parsed };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 存储降级状态（issue #202）。
 *
 * 损坏时不再 `process.exit(1)`：进程直接死掉 = 站点整体不可用，而且运维只能从
 * 日志里翻原因。现在改成「备份 + 只读降级」：进程继续跑，`/healthz` 报 degraded，
 * 所有写请求 503，等运维从备份恢复后重启。
 */
let degraded: { backup: string; error: string } | null = null;

export function hubStorageHealth(): { ok: boolean; backup?: string } {
  return degraded ? { ok: false, backup: degraded.backup } : { ok: true };
}

function load(): DbShape {
  let text: string;
  try {
    text = fs.readFileSync(FILE, 'utf-8');
  } catch {
    return { users: [], rooms: [] }; // 首次启动：文件还不存在
  }
  const parsed = parseDb(text);
  if (parsed.ok) return parsed.data;

  // 解析失败绝不能静默回空库（下一次 save 会覆盖全部数据）。
  const bak = FILE + '.corrupt.' + Date.now();
  try { fs.copyFileSync(FILE, bak); } catch { /* 只读文件系统等极端情况：仍然降级 */ }
  console.error('[hub] hub.json 损坏，进入只读降级（备份 → ' + bak + '）：', parsed.error);
  degraded = { backup: bak, error: parsed.error };
  return { users: [], rooms: [] };
}

let db: DbShape = load();

/** 落盘次数（测试用：证明批量更新被合并成一次写）。 */
let writeCount = 0;
export function storageWriteCount(): number {
  return writeCount;
}

export function save(): void {
  // 降级期间绝不落盘：内存里是空库，写回去等于把损坏文件覆盖成空数据。
  if (degraded) return;
  cancelRoomFlush();
  writeNow();
}

function writeNow(): void {
  if (degraded) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, FILE);
  writeCount += 1;
}

/* -------------------------------------------------------------------------- */
/* 房间写入合并（issue #201）                                                   */
/* -------------------------------------------------------------------------- */
/**
 * `hub.json` 是全量同步写：500 个用户 + 500 个房间约 145 KB，**每次 save 1.5–2.3 ms**。
 * 房间的 `joinRoom` / `setReady` / 活动时间会高频触发它，等于每个大厅请求都重写整库。
 *
 * 这里把**房间**的写入合并成 25 ms 一次批量落盘：房间状态是可重建的临时数据，25 ms
 * 的丢失窗口可以接受；而**用户**（注册、改密、角色）仍然立即落盘，因为那是不可重建的。
 *
 * 进程退出、崩溃前都会 flush，不会把最后 25 ms 的房间变更丢在内存里。
 */
const ROOM_FLUSH_MS = 25;
let roomTimer: ReturnType<typeof setTimeout> | null = null;

function cancelRoomFlush(): void {
  if (roomTimer) {
    clearTimeout(roomTimer);
    roomTimer = null;
  }
}

function scheduleRoomFlush(): void {
  if (degraded || roomTimer) return;
  roomTimer = setTimeout(() => {
    roomTimer = null;
    writeNow();
  }, ROOM_FLUSH_MS);
  roomTimer.unref?.();
}

/** 立即把待写内容落盘（测试、退出钩子用）。 */
export function flushStorage(): void {
  if (!roomTimer) return;
  cancelRoomFlush();
  writeNow();
}

/** 是否有房间写入还在等待（测试用）。 */
export function hasPendingStorageWrite(): boolean {
  return roomTimer !== null;
}

process.once('exit', () => {
  if (roomTimer) {
    cancelRoomFlush();
    writeNow();
  }
});

export const users = {
  all: () => db.users,
  byName: (name: string) => db.users.find(u => u.name === name),
  byId: (id: string) => db.users.find(u => u.id === id),
  add(u: UserRecord) { db.users.push(u); save(); },
  update(id: string, patch: Partial<UserRecord>) {
    const u = db.users.find(x => x.id === id);
    if (u) Object.assign(u, patch);
    save();
    return u;
  },
  remove(id: string) {
    const idx = db.users.findIndex(x => x.id === id);
    if (idx >= 0) {
      db.users.splice(idx, 1);
      save();
      return true;
    }
    return false;
  },
};

export const rooms = {
  all: () => db.rooms,
  byId: (id: string) => db.rooms.find(r => r.id === id),
  add(r: RoomRecord) { db.rooms.push(r); scheduleRoomFlush(); },
  update(id: string, patch: Partial<RoomRecord>) {
    const r = db.rooms.find(x => x.id === id);
    if (r) Object.assign(r, patch);
    scheduleRoomFlush();
    return r;
  },
  remove(id: string) { db.rooms = db.rooms.filter(r => r.id !== id); scheduleRoomFlush(); },
};
