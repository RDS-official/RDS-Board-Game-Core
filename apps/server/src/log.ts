/**
 * 服务端结构化日志。
 *
 * 目的：异常发生时能拿到**带上下文的日志**，而不是散落的 `console.error`。
 *
 * 约定：
 * - 每条日志一行 JSON（JSONL），便于 grep / jq / 后续接入采集。
 * - 同时写 stdout，PM2 也会收一份。
 * - 文件按天切分，并保留最近 N 天，避免磁盘被日志吃满。
 * - 写日志失败**绝不抛出**：日志系统不能成为新的故障源。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_DIR = path.join(DATA_DIR, 'logs');
const KEEP_DAYS = 14;
/** 单文件上限 16MB，超过就切到 `.1` 后缀。 */
const MAX_BYTES = 16 * 1024 * 1024;

const SECRET_KEY = /^(password|passwd|pwd|token|access_token|refresh_token|authorization|secret|apikey|api_key|cookie)$/i;

/** 递归脱敏，保证日志里不会留下凭据。 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'function') return '[function]';
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redact(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 60)) {
      out[key] = SECRET_KEY.test(key) ? '[redacted]' : redact(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function ensureDir(): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    /* 忽略：下面写文件时会再失败一次，同样被吞掉 */
  }
}

function fileFor(name: string): string {
  return path.join(LOG_DIR, `${name}-${today()}.jsonl`);
}

function append(name: string, line: string): void {
  try {
    ensureDir();
    const file = fileFor(name);
    // 超限就轮转一份，保留最近的历史便于回溯。
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      /* 文件还不存在 */
    }
    fs.appendFileSync(file, line + '\n');
  } catch {
    /* 日志失败不影响业务 */
  }
}

/** 清理过期日志，启动时调用一次即可。 */
export function pruneLogs(keepDays = KEEP_DAYS): void {
  try {
    const cutoff = Date.now() - keepDays * 24 * 3600 * 1000;
    for (const name of fs.readdirSync(LOG_DIR)) {
      const full = path.join(LOG_DIR, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {
        /* 单个文件失败无所谓 */
      }
    }
  } catch {
    /* 目录不存在 */
  }
}

function write(level: LogLevel, scope: string, msg: string, data?: unknown): void {
  const entry = {
    t: new Date().toISOString(),
    level,
    scope,
    msg,
    data: data === undefined ? undefined : redact(data)
  };
  const line = JSON.stringify(entry);
  const tag = `[${scope}]`;
  if (level === 'error') console.error(tag, msg, data ?? '');
  else if (level === 'warn') console.warn(tag, msg, data ?? '');
  else console.log(tag, msg, data ?? '');
  append('app', line);
}

export const log = {
  debug: (scope: string, msg: string, data?: unknown) => write('debug', scope, msg, data),
  info: (scope: string, msg: string, data?: unknown) => write('info', scope, msg, data),
  warn: (scope: string, msg: string, data?: unknown) => write('warn', scope, msg, data),
  error: (scope: string, msg: string, data?: unknown) => write('error', scope, msg, data)
};

/**
 * 保存一份客户端诊断包。
 *
 * 客户端在异常时会上报「最近日志 + 动作面包屑 + 状态摘要」，落盘后即可据此复现。
 */
export function saveDiagnostics(payload: unknown, meta: { ip?: string } = {}): void {
  const record = {
    t: new Date().toISOString(),
    ip: meta.ip,
    payload: redact(payload)
  };
  append('diagnostics', JSON.stringify(record));
}

/** 最近若干条应用日志，供自检/排障接口使用。 */
export function recentLogs(limit = 200): unknown[] {
  try {
    const file = fileFor('app');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-Math.max(1, limit)).map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
  } catch {
    return [];
  }
}

export const LOG_DIRECTORY = LOG_DIR;
