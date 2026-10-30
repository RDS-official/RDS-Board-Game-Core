/**
 * 诊断日志核心（浏览器与服务端共用）。
 *
 * 设计目标：出问题时能拿到「当时到底发生了什么」，而不是只有一句 `console.error`。
 *
 * 三条硬约束：
 * 1. **纯函数**：环形缓冲、脱敏、打包都不碰 DOM 与网络，便于单测。
 * 2. **脱敏优先**：任何形如 password / token / authorization / secret 的键
 *    在落盘前一律替换为 `[redacted]`，避免日志变成凭据泄漏渠道。
 * 3. **有界**：缓冲与落盘都有上限，异常风暴不会撑爆内存或磁盘。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  /** ISO 时间戳。 */
  t: string;
  level: LogLevel;
  /** 模块名，例如 'session' / 'render' / 'net'。 */
  scope: string;
  msg: string;
  /** 结构化附加信息，已脱敏。 */
  data?: unknown;
}

export interface LogRing {
  push(level: LogLevel, scope: string, msg: string, data?: unknown): LogEntry;
  entries(): LogEntry[];
  clear(): void;
  size(): number;
}

const SECRET_KEY = /^(password|passwd|pwd|token|access_token|refresh_token|authorization|secret|apikey|api_key|cookie)$/i;

/**
 * 递归脱敏。只处理普通对象与数组；函数、类实例一律转成字符串，
 * 保证结果永远可以 `JSON.stringify`。
 */
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

/** 有界环形缓冲。满了丢最旧的，保证内存恒定。 */
export function createLogRing(limit = 400): LogRing {
  const buffer: LogEntry[] = [];
  const max = Math.max(1, limit);

  return {
    push(level, scope, msg, data) {
      const entry: LogEntry = {
        t: new Date().toISOString(),
        level,
        scope,
        msg: String(msg),
        data: data === undefined ? undefined : redact(data)
      };
      buffer.push(entry);
      if (buffer.length > max) buffer.splice(0, buffer.length - max);
      return entry;
    },
    entries: () => buffer.slice(),
    clear: () => {
      buffer.length = 0;
    },
    size: () => buffer.length
  };
}

/** 面包屑：记录最近做过什么动作，卡死时最有用。 */
export interface Breadcrumb {
  t: string;
  action: string;
  ok: boolean;
  error?: string;
}

export function createBreadcrumbs(limit = 120) {
  const items: Breadcrumb[] = [];
  const max = Math.max(1, limit);
  return {
    add(action: string, ok: boolean, error?: string): void {
      items.push({ t: new Date().toISOString(), action: String(action).slice(0, 200), ok, error });
      if (items.length > max) items.splice(0, items.length - max);
    },
    list: () => items.slice(),
    clear: () => {
      items.length = 0;
    }
  };
}

export interface DiagnosticBundle {
  /** 报告生成时间。 */
  at: string;
  /** 构建/版本标识，便于对照代码。 */
  build: string;
  /** 运行环境摘要。 */
  env: Record<string, unknown>;
  /** 最近的日志。 */
  logs: LogEntry[];
  /** 最近的动作面包屑。 */
  breadcrumbs: Breadcrumb[];
  /** 状态摘要（哈希、阶段、当前玩家等），不含完整状态以控制体积。 */
  state?: unknown;
  /** 未捕获异常的摘要。 */
  fatal?: { message: string; stack?: string };
}

/** 组装诊断包，保证可 JSON 序列化且有界。 */
export function buildBundle(input: {
  build: string;
  env: Record<string, unknown>;
  logs: LogEntry[];
  breadcrumbs: Breadcrumb[];
  state?: unknown;
  fatal?: { message: string; stack?: string };
}): DiagnosticBundle {
  return {
    at: new Date().toISOString(),
    build: input.build,
    env: redact(input.env) as Record<string, unknown>,
    logs: input.logs.slice(-400),
    breadcrumbs: input.breadcrumbs.slice(-120),
    state: input.state === undefined ? undefined : redact(input.state),
    fatal: input.fatal
  };
}
