/**
 * 德州扑克的账号账本：筹码余额（buy-in 钱包）与生涯战绩。
 *
 * 与 `hub.json`（用户 / 房间）分开落一个文件，理由有三：
 *  1. 账本写入极其频繁（每手一次），和房间列表共用一次 `JSON.stringify` 会把
 *     整份房间表重复写盘；
 *  2. 账本损坏时只该影响「战绩」，不该连登录都被 `process.exit` 带走；
 *  3. 删除账号时账本是独立一份，可以按 userId 直接清理，不牵动用户表结构。
 *
 * 接口保持和 `storage.ts` 一样的同步 KV 风格，将来换 SQLite 时替换实现即可。
 *
 * 并发安全：Node 单线程 + 同步读写，同一 tick 内不会交错；写入走 temp + rename，
 * 崩溃时只会丢掉最后一次更新，不会留下半截 JSON。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PokerCareer } from '@rds/games/poker/stats';
import { EMPTY_POKER_CAREER } from '@rds/games/poker/stats';
import { DATA_DIR } from './config.ts';

/** 一名账号的扑克账本。 */
export interface PokerAccount {
  userId: string;
  name?: string;
  isAi?: boolean;
  /** 可带上桌的筹码余额；全局只此一份，桌上筹码是它的「已兑换」部分。 */
  chips: number;
  /** 生涯峰值余额，排行榜上作为资历展示。 */
  peakChips: number;
  /** 生涯累计战绩（口径见 packages/games/src/poker/stats.ts）。 */
  career: PokerCareer;
  /** 已结算进账本的最后手数（按房间 + 手数去重，重连 / 重放不重复计数）。 */
  settledHands?: Record<string, number>;
  /**
   * 当前押在哪张桌上的筹码（房间号 → 已兑换的买入）。
   *
   * 这是**幂等的唯一依据**：同一房间重复 `ensure()`（服务端重启、对局重建、
   * 重连）不能二次扣款；房间真正释放时才按这张表退款并清空。
   */
  atTable?: Record<string, number>;
  /** AI 领取低保历史记录（时间戳毫秒数列表，用于计算半小时内领取次数）。 */
  reliefTimestamps?: number[];
}

export interface PokerLedgerShape {
  version: 1;
  accounts: Record<string, PokerAccount>;
}

/** 上桌买入的下限，避免 0 筹码账号占着座位。 */
export const MIN_BUY_IN = 100;

/** 新账号的默认筹码：够玩几轮标准买入，又不至于让排行榜全是同一个数。 */
export const STARTING_BANKROLL = 5000;

const FILE = path.join(DATA_DIR, 'poker-ledger.json');

function emptyAccount(userId: string): PokerAccount {
  return {
    userId,
    chips: STARTING_BANKROLL,
    peakChips: STARTING_BANKROLL,
    career: { ...EMPTY_POKER_CAREER },
    settledHands: {}
  };
}

function normalize(raw: unknown): PokerLedgerShape {
  const shape = raw as Partial<PokerLedgerShape> | null;
  if (!shape || typeof shape !== 'object' || !shape.accounts || typeof shape.accounts !== 'object') {
    return { version: 1, accounts: {} };
  }
  const accounts: Record<string, PokerAccount> = {};
  for (const [userId, entry] of Object.entries(shape.accounts)) {
    const record = entry as Partial<PokerAccount> | undefined;
    if (!record || typeof record !== 'object' || !userId) continue;
    accounts[userId] = {
      userId,
      name: typeof record.name === 'string' ? record.name : undefined,
      isAi: !!record.isAi,
      chips: Number.isFinite(Number(record.chips)) ? Math.max(0, Math.round(Number(record.chips))) : STARTING_BANKROLL,
      peakChips: Number.isFinite(Number(record.peakChips))
        ? Math.max(0, Math.round(Number(record.peakChips)))
        : STARTING_BANKROLL,
      career: { ...EMPTY_POKER_CAREER, ...(record.career ?? {}) },
      settledHands: record.settledHands && typeof record.settledHands === 'object' ? { ...record.settledHands } : {},
      atTable: record.atTable && typeof record.atTable === 'object' ? { ...record.atTable } : {},
      reliefTimestamps: Array.isArray(record.reliefTimestamps) ? record.reliefTimestamps.filter(t => typeof t === 'number') : []
    };
  }
  return { version: 1, accounts };
}

function load(): PokerLedgerShape {
  let text: string;
  try {
    text = fs.readFileSync(FILE, 'utf-8');
  } catch {
    return { version: 1, accounts: {} }; // 首次启动：还没有账本
  }
  try {
    return normalize(JSON.parse(text));
  } catch (error) {
    // 与 hub.json 不同，账本损坏不该挡住开服：先备份，再从空账本继续，
    // 玩家的生涯战绩可以重算，站点不可用不行。
    const backup = `${FILE}.corrupt.${Date.now()}`;
    try {
      fs.copyFileSync(FILE, backup);
    } catch {
      /* 只读文件系统等极端情况：仍然继续，只是没留备份 */
    }
    console.error('[poker-ledger] 账本损坏，已备份并重置（备份 → ' + backup + '）：', String(error));
    degraded = { backup, error: String(error) };
    return { version: 1, accounts: {} };
  }
}

let ledger: PokerLedgerShape = load();

/**
 * 账本是否在启动时损坏过。损坏会备份原文件并从空账本继续（站点可用优先），
 * 但必须让运维看得见 —— 否则就是"余额悄悄回滚"（issue #187）。
 */
let degraded: { backup: string; error: string } | null = null;

export function ledgerHealth(): { ok: boolean; backup?: string } {
  return degraded ? { ok: false, backup: degraded.backup } : { ok: true };
}

/**
 * 账本是否处于「损坏后只读降级」。
 *
 * 损坏时仍然开服（站点可用优先），但**不再接受任何写操作**：记账结果无法落盘，
 * 继续收筹码等于让玩家赢一把空气。写接口统一返回 503，等运维从备份恢复
 * （issue #187 方案 A）。
 */
export function isLedgerDegraded(): boolean {
  return degraded !== null;
}

/** 仅测试用：把账本切到降级态，验证只读行为。 */
export function __setLedgerDegradedForTest(backup = 'test-backup'): void {
  degraded = { backup, error: 'test' };
}

/** 仅测试用：恢复健康态。 */
export function __resetLedgerDegradedForTest(): void {
  degraded = null;
}

function save(): void {
  // 降级期间不落盘：内存里的改动只用于本次请求的展示，重启即丢。
  if (degraded) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 1));
  fs.renameSync(tmp, FILE);
}

/** 取得账号账本；账号还没有记录时按默认余额开一个（并落盘）。 */
export function accountOf(userId: string): PokerAccount {
  const existing = ledger.accounts[userId];
  if (existing) return existing;
  const created = emptyAccount(userId);
  ledger.accounts[userId] = created;
  save();
  return created;
}

/** 救济金金额与半小时限制规则 */
export const RELIEF_AMOUNT = 1000;
export const RELIEF_WINDOW_MS = 30 * 60 * 1000; // 30 分钟
export const MAX_RELIEF_PER_WINDOW = 2; // 最多 2 次

/**
 * 尝试为筹码不足的 AI 发放救济金。
 * 规则：半小时内最多领取 2 次，每次发放 1000 筹码。
 * 返回是否成功领取救济金以及当前筹码。
 */
export function tryGrantAiRelief(userId: string, now = Date.now()): { granted: boolean; chips: number } {
  let granted = false;
  let finalChips = 0;
  updateAccount(userId, current => {
    const history = (current.reliefTimestamps ?? []).filter(t => now - t < RELIEF_WINDOW_MS);
    if (history.length >= MAX_RELIEF_PER_WINDOW) {
      finalChips = current.chips;
      return { ...current, reliefTimestamps: history };
    }
    // 允许领取救济金
    granted = true;
    const newChips = current.chips + RELIEF_AMOUNT;
    finalChips = newChips;
    return {
      ...current,
      chips: newChips,
      peakChips: Math.max(current.peakChips, newChips),
      reliefTimestamps: [...history, now]
    };
  });
  return { granted, chips: finalChips };
}

/** 只读查询：没有记录时返回默认账本，但**不写盘**（排行榜轮询走这条路径）。 */
export function peekAccount(userId: string): PokerAccount {
  return ledger.accounts[userId] ?? emptyAccount(userId);
}

export function allAccounts(): PokerAccount[] {
  return Object.values(ledger.accounts);
}

export function updateAccount(userId: string, patch: (account: PokerAccount) => PokerAccount): PokerAccount {
  const current = accountOf(userId);
  const next = patch({
    ...current,
    career: { ...current.career },
    settledHands: { ...current.settledHands },
    atTable: { ...current.atTable }
  });
  next.peakChips = Math.max(Number(next.peakChips ?? 0), Number(next.chips ?? 0));
  ledger.accounts[userId] = next;
  save();
  return next;
}

/** 账号被删除时清掉它的账本（管理员删号路径调用）。 */
export function removeAccount(userId: string): boolean {
  if (!ledger.accounts[userId]) return false;
  delete ledger.accounts[userId];
  save();
  return true;
}

/** 测试用：把文件内容灌回去（不落盘）。 */
export function resetLedgerForTests(shape: PokerLedgerShape = { version: 1, accounts: {} }): void {
  ledger = normalize(shape);
}
