/**
 * 诊断日志的安装层（仅浏览器）。
 *
 * 把三样东西接起来：
 * 1. 全局异常钩子（`error` / `unhandledrejection`）
 * 2. 动作面包屑（最近发过哪些动作、哪些被内核拒绝）
 * 3. 一键导出 + 致命错误自动上报
 *
 * 核心模块保持纯函数（见 ./log.ts），这里只做副作用装配。
 */

import {
  buildBundle,
  createBreadcrumbs,
  createLogRing,
  type Breadcrumb,
  type DiagnosticBundle,
  type LogEntry,
  type LogLevel,
  type LogRing
} from './log';

export interface DiagnosticsOptions {
  /** 构建标识，便于对照代码版本。 */
  build: string;
  /** 上报端点；留空则只本地保存。 */
  endpoint?: string;
  /** 状态摘要提供者：只在导出时调用，避免每帧开销。 */
  stateSummary?: () => unknown;
  /** 缓冲上限。 */
  limit?: number;
}

export interface Diagnostics {
  log: LogRing;
  breadcrumbs: ReturnType<typeof createBreadcrumbs>;
  /** 记录一次动作结果。 */
  action(name: string, ok: boolean, error?: string): void;
  /** 组装当前诊断包。 */
  bundle(fatal?: { message: string; stack?: string }): DiagnosticBundle;
  /** 导出为 JSON 文本。 */
  toJSON(): string;
  /** 下载为文件（浏览器环境）。 */
  download(): void;
  /** 上报到服务端；失败静默，绝不因日志再抛异常。 */
  report(fatal?: { message: string; stack?: string }): void;
  entries(): LogEntry[];
  clear(): void;
}

const BUILD_FALLBACK = 'dev';

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '{"error":"bundle not serialisable"}';
  }
}

/**
 * 安装诊断系统。可重复调用（重复安装会返回同一实例）。
 */
export function installDiagnostics(options: DiagnosticsOptions): Diagnostics {
  const globalKey = '__rdsDiagnostics';
  const existing = (window as unknown as Record<string, unknown>)[globalKey] as Diagnostics | undefined;
  if (existing) return existing;

  const log = createLogRing(options.limit ?? 400);
  const breadcrumbs = createBreadcrumbs(120);
  const build = options.build || BUILD_FALLBACK;

  const env = () => ({
    href: location.href,
    ua: navigator.userAgent,
    lang: navigator.language,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    dpr: window.devicePixelRatio,
    online: navigator.onLine,
    // 内存压力常与卡顿相关，有就记，没有就算了。
    heap: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize
  });

  const bundle = (fatal?: { message: string; stack?: string }): DiagnosticBundle => {
    let state: unknown;
    try {
      state = options.stateSummary?.();
    } catch (error) {
      state = { error: String(error) };
    }
    return buildBundle({
      build,
      env: env(),
      logs: log.entries(),
      breadcrumbs: breadcrumbs.list() as Breadcrumb[],
      state,
      fatal
    });
  };

  const toJSON = () => safeStringify(bundle());

  const download = () => {
    try {
      const text = toJSON();
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      anchor.href = url;
      anchor.download = `rds-diagnostics-${stamp}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (error) {
      log.push('error', 'diagnostics', '导出诊断包失败', { error: String(error) });
    }
  };

  const report = (fatal?: { message: string; stack?: string }) => {
    if (!options.endpoint) return;
    try {
      const payload = safeStringify(bundle(fatal));
      // keepalive 让页面崩溃/关闭时也有机会送达。
      void fetch(options.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
        keepalive: true
      }).catch(() => {
        /* 上报失败就算了，绝不递归 */
      });
    } catch {
      /* 同上 */
    }
  };

  const api: Diagnostics = {
    log,
    breadcrumbs,
    action: (name, ok, error) => {
      breadcrumbs.add(name, ok, error);
      if (!ok) log.push('warn', 'session', `动作被拒绝：${name}`, { error });
    },
    bundle,
    toJSON,
    download,
    report,
    entries: () => log.entries(),
    clear: () => {
      log.clear();
      breadcrumbs.clear();
    }
  };

  // ---- 全局异常 ----
  window.addEventListener('error', event => {
    const message = event.message || 'unknown error';
    log.push('error', 'window', message, {
      source: event.filename,
      line: event.lineno,
      column: event.colno,
      stack: (event.error as Error | undefined)?.stack
    });
    report({ message, stack: (event.error as Error | undefined)?.stack });
  });

  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason as { message?: string; stack?: string } | undefined;
    const message = reason?.message ?? String(event.reason);
    log.push('error', 'promise', `未处理的 Promise 拒绝：${message}`, { stack: reason?.stack });
    report({ message, stack: reason?.stack });
  });

  // 关键级别同时镜像到控制台，方便开发时直接看到。
  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    log.push('error', 'console', args.map(String).join(' '));
    originalError(...args);
  };
  const originalWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    log.push('warn', 'console', args.map(String).join(' '));
    originalWarn(...args);
  };

  log.push('info', 'diagnostics', '诊断系统已启用', { build });

  (window as unknown as Record<string, unknown>)[globalKey] = api;
  return api;
}

/** 便捷取用：未安装时返回 undefined，调用方不必判空两次。 */
export function diagnostics(): Diagnostics | undefined {
  return (window as unknown as Record<string, unknown>).__rdsDiagnostics as Diagnostics | undefined;
}

export type { LogLevel };
