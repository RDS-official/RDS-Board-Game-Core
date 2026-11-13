/**
 * SQLite 持久化（`node:sqlite`）：账号、房间、扑克账本都落在 `DATA_DIR/hub.sqlite`。
 *
 * 为什么换掉 JSON：`hub.json` / `poker-ledger.json` 都是「每次改动重写整份文件」，
 * 房间列表和大厅活动时间会高频触发它；数据量虽小（几百账号 + 几十房间），但没有
 * 事务、没有行级写入，也没法按条件查。SQLite 一个文件解决这三件事，且是 Node 内置
 * 模块，不引入原生依赖。
 *
 * 并发：PM2 单实例 + Node 单线程，同步 API 天然串行；WAL 让崩溃只丢最后一次未提交
 * 的写入，不会留下半截文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { DATA_DIR } from './config.ts';

export const DB_FILE = path.join(DATA_DIR, 'hub.sqlite');

/**
 * 载入 node:sqlite。
 *
 * 内置 sqlite 自 Node 22.5 起可用。旧版本上直接静态 import 会抛
 * ERR_UNKNOWN_BUILTIN_MODULE —— 那种报错看不出该修什么，所以这里换成一句
 * 可直接照做的说明（升级到 Node 22 即可）。
 */
async function loadSqlite(): Promise<typeof import('node:sqlite')> {
  try {
    return await import('node:sqlite');
  } catch (error) {
    throw new Error(
      '本服务把账号/房间/扑克账本存进 SQLite，需要 Node >= 22.5（内置 node:sqlite）。' +
        '当前运行时是 ' + process.version + '，加载 node:sqlite 失败：' + String(error)
    );
  }
}

const sqlite = await loadSqlite();

let instance: DatabaseSync | null = null;
const statements = new Map<string, StatementSync>();
let txnDepth = 0;

/** 建表语句：随功能只增不改（旧库靠 IF NOT EXISTS 平滑升级）。 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     json TEXT NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS users_name ON users(name)',
  `CREATE TABLE IF NOT EXISTS rooms (
     id TEXT PRIMARY KEY,
     status TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     json TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS poker_accounts (
     user_id TEXT PRIMARY KEY,
     chips INTEGER NOT NULL,
     peak_chips INTEGER NOT NULL,
     json TEXT NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS poker_accounts_chips ON poker_accounts(chips DESC)'
];

/** 打开（并初始化）数据库；同进程内只打开一次。 */
export function openDatabase(): DatabaseSync {
  if (instance) return instance;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new sqlite.DatabaseSync(DB_FILE);
  // WAL：读写不互相阻塞，崩溃后只回放已提交的事务。
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  for (const sql of SCHEMA) db.exec(sql);
  instance = db;
  return db;
}

/** 预编译语句缓存：同一个 SQL 只 prepare 一次。 */
export function stmt(sql: string): StatementSync {
  const cached = statements.get(sql);
  if (cached) return cached;
  const prepared = openDatabase().prepare(sql);
  statements.set(sql, prepared);
  return prepared;
}

/** 在一个事务里执行（嵌套调用复用外层事务）。 */
export function txn<T>(fn: () => T): T {
  const db = openDatabase();
  if (txnDepth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  txnDepth += 1;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 回滚失败只可能发生在连接已坏的情况，原始错误更重要 */
    }
    throw error;
  } finally {
    txnDepth -= 1;
  }
}

/** 退出前落一次 WAL 并关库，避免留下 -wal/-shm 文件。 */
process.once('exit', () => {
  if (!instance) return;
  try {
    instance.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    instance.close();
  } catch {
    /* 退出路径上关不掉也不影响正确性：WAL 会在下次打开时回放 */
  }
  instance = null;
});
