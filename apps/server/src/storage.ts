/** 极简 JSON 文件存储。接口按同步 KV 设计，未来可原样换 SQLite。 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.ts';

export interface UserRecord {
  id: string; name: string; passHash: string; salt: string; createdAt: number;
  /** 阶段一：用户资料。displayName=对外昵称（缺省用登录名）；avatarExt/avatarRev=头像文件扩展与版本号（缓存击穿用）。 */
  displayName?: string; avatarExt?: 'png' | 'jpg' | 'webp'; avatarRev?: number;
}
export interface RoomRecord {
  id: string; name: string; gameId: string; hostId: string; status: 'open' | 'playing' | 'closed';
  maxPlayers: number; players: string[]; createdAt: number;
  /** Phase B（旧数据可能缺省） */
  readyPlayers?: string[]; isPrivate?: boolean; code?: string; scenarioId?: string;
  /** 阶段三：房间回收（旧数据可能缺省，清扫按 createdAt 兜底） */
  lastActivity?: number; firstEmptyAt?: number;
}

interface DbShape { users: UserRecord[]; rooms: RoomRecord[]; }

const FILE = path.join(DATA_DIR, 'hub.json');

function load(): DbShape {
  let text: string;
  try {
    text = fs.readFileSync(FILE, 'utf-8');
  } catch {
    return { users: [], rooms: [] }; // 首次启动：文件还不存在
  }
  try {
    const parsed = JSON.parse(text) as DbShape;
    if (!parsed || !Array.isArray(parsed.users) || !Array.isArray(parsed.rooms)) throw new Error('bad shape');
    return parsed;
  } catch (err) {
    // REVIEW.md 短期项 10：解析失败绝不能静默回空库（下一次 save 会覆盖全部数据）。
    // 先留备份，再拒绝启动，交给运维修复后重启。
    const bak = FILE + '.corrupt.' + Date.now();
    try { fs.copyFileSync(FILE, bak); } catch { /* 只读文件系统等极端情况：仍然退出 */ }
    console.error('[hub] hub.json 损坏，为避免覆盖已退出（备份 → ' + bak + '）：', String(err));
    process.exit(1);
  }
}

let db: DbShape = load();

export function save(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, FILE);
}

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
};

export const rooms = {
  all: () => db.rooms,
  byId: (id: string) => db.rooms.find(r => r.id === id),
  add(r: RoomRecord) { db.rooms.push(r); save(); },
  update(id: string, patch: Partial<RoomRecord>) {
    const r = db.rooms.find(x => x.id === id);
    if (r) Object.assign(r, patch);
    save();
    return r;
  },
  remove(id: string) { db.rooms = db.rooms.filter(r => r.id !== id); save(); },
};
