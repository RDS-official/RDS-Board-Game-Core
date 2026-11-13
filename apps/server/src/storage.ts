/**
 * 用户与房间的持久化：SQLite（`DATA_DIR/hub.sqlite`，见 `db.ts`）。
 *
 * 对外接口保持「同步 KV」风格不变（`users.byId()` / `rooms.update()`），换掉的只是
 * 底下那层：以前每次改动重写整份 `hub.json`，现在一次改动只写一行。
 *
 * 旧数据迁移：首次启动时如果 `hub.json` 还在且库里没有账号，就把整份导入并把它改名
 * 成 `hub.json.imported.<ts>`（保留备份，不删）。解析失败时按 issue #202 的方案处理：
 * 备份 + 只读降级（`/healthz` 报 degraded，写请求 503），绝不静默覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.ts';
import { stmt, txn } from './db.ts';

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

/** 旧版整份文件；只用于一次性迁移。 */
const LEGACY_FILE = path.join(DATA_DIR, 'hub.json');

/** 解析结果：损坏时带原因，不在这里做 IO（便于单测与迁移前校验）。 */
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
 * 迁移源损坏或数据库打不开时都不再 `process.exit(1)`：进程直接死掉 = 站点整体不可用，
 * 而且运维只能从日志里翻原因。现在改成「备份 + 只读降级」：进程继续跑，`/healthz`
 * 报 degraded，所有写请求 503，等运维从备份恢复后重启。
 */
let degraded: { backup: string; error: string } | null = null;

export function hubStorageHealth(): { ok: boolean; backup?: string } {
  return degraded ? { ok: false, backup: degraded.backup } : { ok: true };
}

/** 已提交的写语句数（测试用：证明一次改动只写一行、不再重写整库）。 */
let writeCount = 0;
export function storageWriteCount(): number {
  return writeCount;
}

function degrade(backup: string, error: string): void {
  degraded = { backup, error };
  console.error('[hub] 存储进入只读降级（备份 → ' + (backup || '无') + '）：' + error);
}

/* -------------------------------------------------------------------------- */
/* 行 → 记录                                                                    */
/* -------------------------------------------------------------------------- */
function userFromRow(row: { json: string }): UserRecord {
  return JSON.parse(row.json) as UserRecord;
}

function roomFromRow(row: { json: string }): RoomRecord {
  return JSON.parse(row.json) as RoomRecord;
}

function insertUser(u: UserRecord): void {
  stmt('INSERT INTO users(id, name, created_at, json) VALUES(?, ?, ?, ?)').run(
    u.id,
    u.name,
    Number(u.createdAt ?? Date.now()),
    JSON.stringify(u)
  );
  writeCount += 1;
}

function insertRoom(r: RoomRecord): void {
  stmt('INSERT INTO rooms(id, status, created_at, json) VALUES(?, ?, ?, ?)').run(
    r.id,
    String(r.status ?? 'open'),
    Number(r.createdAt ?? Date.now()),
    JSON.stringify(r)
  );
  writeCount += 1;
}

/* -------------------------------------------------------------------------- */
/* 旧 hub.json → SQLite（只在库中无账号时执行一次）                                */
/* -------------------------------------------------------------------------- */
function importLegacyHubJson(): void {
  if (!fs.existsSync(LEGACY_FILE)) return;
  const row = stmt('SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM rooms) AS n').get() as
    | { n: number }
    | undefined;
  if (Number(row?.n ?? 0) > 0) return; // 已经迁过：旧文件留着也不动它

  let text: string;
  try {
    text = fs.readFileSync(LEGACY_FILE, 'utf-8');
  } catch (error) {
    degrade('', '读取 hub.json 失败：' + String(error));
    return;
  }
  const parsed = parseDb(text);
  if (!parsed.ok) {
    const bak = LEGACY_FILE + '.corrupt.' + Date.now();
    try {
      fs.copyFileSync(LEGACY_FILE, bak);
    } catch {
      /* 只读文件系统等极端情况：仍然降级 */
    }
    degrade(bak, parsed.error);
    return;
  }
  txn(() => {
    for (const user of parsed.data.users) insertUser(user);
    for (const room of parsed.data.rooms) insertRoom(room);
  });
  const done = LEGACY_FILE + '.imported.' + Date.now();
  try {
    fs.renameSync(LEGACY_FILE, done);
    console.log(
      '[hub] 已把 hub.json 导入 SQLite（' + parsed.data.users.length + ' 账号 / ' +
        parsed.data.rooms.length + ' 房间），旧文件改名 → ' + done
    );
  } catch (error) {
    // 改名失败不是致命问题：库里已经有数据，下次启动的「库非空」判断会跳过导入。
    console.error('[hub] hub.json 导入成功但改名失败，下次启动不会重复导入：', String(error));
  }
}

try {
  importLegacyHubJson();
} catch (error) {
  degrade('', String(error));
}

/* -------------------------------------------------------------------------- */
/* 账号                                                                        */
/* -------------------------------------------------------------------------- */
export const users = {
  all: (): UserRecord[] =>
    degraded ? [] : (stmt('SELECT json FROM users ORDER BY created_at').all() as { json: string }[]).map(userFromRow),
  byName: (name: string): UserRecord | undefined => {
    if (degraded) return undefined;
    const row = stmt('SELECT json FROM users WHERE name = ? ORDER BY created_at LIMIT 1').get(name) as
      | { json: string }
      | undefined;
    return row ? userFromRow(row) : undefined;
  },
  byId: (id: string): UserRecord | undefined => {
    if (degraded) return undefined;
    const row = stmt('SELECT json FROM users WHERE id = ?').get(id) as { json: string } | undefined;
    return row ? userFromRow(row) : undefined;
  },
  add(u: UserRecord) {
    if (degraded) return;
    insertUser(u);
  },
  update(id: string, patch: Partial<UserRecord>) {
    if (degraded) return undefined;
    const row = stmt('SELECT json FROM users WHERE id = ?').get(id) as { json: string } | undefined;
    if (!row) return undefined;
    const next = { ...userFromRow(row), ...patch };
    stmt('UPDATE users SET name = ?, json = ? WHERE id = ?').run(next.name, JSON.stringify(next), id);
    writeCount += 1;
    return next;
  },
  remove(id: string) {
    if (degraded) return false;
    const info = stmt('DELETE FROM users WHERE id = ?').run(id);
    if (Number(info.changes) === 0) return false;
    writeCount += 1;
    return true;
  }
};

/* -------------------------------------------------------------------------- */
/* 房间                                                                        */
/* -------------------------------------------------------------------------- */
export const rooms = {
  all: (): RoomRecord[] =>
    degraded ? [] : (stmt('SELECT json FROM rooms ORDER BY created_at').all() as { json: string }[]).map(roomFromRow),
  byId: (id: string): RoomRecord | undefined => {
    if (degraded) return undefined;
    const row = stmt('SELECT json FROM rooms WHERE id = ?').get(id) as { json: string } | undefined;
    return row ? roomFromRow(row) : undefined;
  },
  add(r: RoomRecord) {
    if (degraded) return;
    insertRoom(r);
  },
  update(id: string, patch: Partial<RoomRecord>) {
    if (degraded) return undefined;
    const row = stmt('SELECT json FROM rooms WHERE id = ?').get(id) as { json: string } | undefined;
    if (!row) return undefined;
    const next = { ...roomFromRow(row), ...patch };
    stmt('UPDATE rooms SET status = ?, json = ? WHERE id = ?').run(String(next.status ?? 'open'), JSON.stringify(next), id);
    writeCount += 1;
    return next;
  },
  remove(id: string) {
    if (degraded) return;
    stmt('DELETE FROM rooms WHERE id = ?').run(id);
    writeCount += 1;
  }
};
