import './lobby/lobby.css';
import { failGameLoading, showGameLoading } from './gameLoading';
import { canEnterNetGame, netEntryOf, stripNetParamsFromUrl } from './entryRoute.ts';
import { html, setHtml } from './ui/dom/html';

/**
 * 统一外壳（unified shell）：单一 SPA 同时承载「联机大厅」、「后台管理」与「游戏本体」。
 *
 * 入口顺序固定为「登录页 → 选择游戏/加入房间 → 牌桌」：
 * URL 带网络对局参数只表示「想深链进桌」，进桌前还必须验证参数里的会话真的
 * 有效（`entryRoute.ts`）；验证不过就清掉参数退回登录页，绝不跳过登录。
 * 服务端未响应或断开时，弹出重试界面并持续自动重试，绝不静默降级到单机牌桌。
 */

function isAdminRoute(): boolean {
  const p = new URLSearchParams(location.search);
  return location.pathname.endsWith('/admin') || location.hash === '#admin' || p.has('admin') || p.get('view') === 'admin';
}

/** 探测 URL 中是否显式指定了游戏测试模式（如本地 Playwright / 自动化脚本启动的 ?game=xxx） */
function isExplicitDevGameRoute(): boolean {
  const p = new URLSearchParams(location.search);
  return p.has('game') && !p.has('hub');
}

async function hubAlive(timeoutMs = 6000, retries = 2): Promise<boolean> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      const res = await fetch('/healthz', { signal: ctl.signal });
      clearTimeout(t);
      if (res.ok) {
        const type = res.headers.get('content-type') ?? '';
        if (type.includes('application/json')) {
          const body = await res.json();
          if (body?.ok === true) return true;
        }
      }
    } catch {
      // 失败后等待 300ms 再重试下一轮
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 300));
      }
    }
  }
  return false;
}

let retryOverlayEl: HTMLElement | null = null;
let retryTimer: number | null = null;

function showServerConnectingOverlay(onRetry: () => void): void {
  if (retryOverlayEl) return;
  const overlay = document.createElement('div');
  overlay.id = 'server-connecting-overlay';
  setHtml(overlay, html`
    <div class="sco-card">
      <div class="sco-spinner"></div>
      <div class="sco-title">正在连接大厅服务器…</div>
      <div class="sco-desc">未能连接至大厅服务，请检查后端运行状态或网络连接。系统正在自动重试…</div>
      <div class="sco-actions">
        <button id="sco-retry-btn" class="sco-btn">立即重试</button>
      </div>
    </div>
  `);
  const style = document.createElement('style');
  style.textContent = `
    #server-connecting-overlay {
      position: fixed; inset: 0; z-index: 10000;
      background: rgba(13, 17, 23, 0.94); backdrop-filter: blur(8px);
      display: flex; align-items: center; justify-content: center;
      font-family: "Alibaba PuHuiTi", system-ui, sans-serif; color: #c9d1d9;
    }
    .sco-card {
      background: #161b22; border: 1px solid #30363d; border-radius: 12px;
      padding: 32px 28px; max-width: 440px; width: 90%; text-align: center;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6);
      display: flex; flex-direction: column; align-items: center; gap: 16px;
    }
    .sco-spinner {
      width: 44px; height: 44px; border-radius: 50%;
      border: 3px solid rgba(217, 180, 91, 0.2); border-top-color: #d9b45b;
      animation: sco-spin 1s linear infinite;
    }
    .sco-title { font-size: 19px; font-weight: 600; color: #d9b45b; letter-spacing: 0.5px; }
    .sco-desc { font-size: 14px; line-height: 1.6; color: #8b949e; }
    .sco-actions { margin-top: 8px; width: 100%; }
    .sco-btn {
      width: 100%; padding: 10px 18px; border: none; border-radius: 6px;
      background: #d9b45b; color: #0d1117; font-weight: 600; font-size: 14px;
      cursor: pointer; transition: filter 0.15s;
    }
    .sco-btn:hover { filter: brightness(1.1); }
    .sco-btn:active { transform: translateY(1px); }
    @keyframes sco-spin { to { transform: rotate(360deg); } }
  `;
  overlay.appendChild(style);
  document.body.appendChild(overlay);
  retryOverlayEl = overlay;

  overlay.querySelector('#sco-retry-btn')?.addEventListener('click', () => {
    onRetry();
  });
}

function hideServerConnectingOverlay(): void {
  if (retryTimer !== null) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
  if (retryOverlayEl) {
    retryOverlayEl.remove();
    retryOverlayEl = null;
  }
}

let gameStarted = false;
let lobbyHandle: { destroy(): void } | null = null;
let adminHandle: { destroy(): void } | null = null;

async function enterGameView(rawQuery: string): Promise<void> {
  // 入参可能带前导 '?'（boot 直传 location.search）——统一剥掉再拼，避免 '??' 破坏参数解析
  const query = rawQuery.replace(/^\?+/, '');
  if (gameStarted) {
    // 对局已在本页运行：带参数则整页重载以重建网络会话，否则忽略
    if (query) location.search = '?' + query;
    return;
  }
  gameStarted = true;
  // 联机开局：立即盖全屏加载动效，掩盖 main chunk 加载/字体解码/场景首绘的中间态
  if (query) showGameLoading();
  // 进入对局前销毁大厅与后台（关闭其 WebSocket 与轮询），避免同用户双连接残留在信令房间内
  lobbyHandle?.destroy();
  lobbyHandle = null;
  adminHandle?.destroy();
  adminHandle = null;

  const lobby = document.getElementById('lobby-root');
  if (lobby) lobby.hidden = true;
  const adminRoot = document.getElementById('admin-root');
  if (adminRoot) adminRoot.hidden = true;

  const app = document.getElementById('app');
  if (app) app.style.display = '';
  if (query) history.replaceState(null, '', '?' + query);
  try {
    await import('./main.ts');
  } catch (error) {
    // chunk 没加载下来 / main 顶层抛错：过去这里会静默 reject，玩家只看到永远转的
    // 加载遮罩。现在把原因摆到脸上，并给一键重试。
    console.error('[shell] failed to start the game view', error);
    gameStarted = false;
    failGameLoading((error as Error)?.message || String(error));
  }
}

async function enterAdminView(): Promise<void> {
  lobbyHandle?.destroy();
  lobbyHandle = null;
  const lobby = document.getElementById('lobby-root');
  if (lobby) lobby.hidden = true;

  const app = document.getElementById('app');
  if (app) app.style.display = 'none';

  const adminRoot = document.getElementById('admin-root')!;
  adminRoot.hidden = false;

  if (location.hash !== '#admin' && !location.pathname.endsWith('/admin')) {
    history.pushState(null, '', '#admin');
  }

  const { startAdmin } = await import('./admin/admin.ts');
  adminHandle = await startAdmin(adminRoot, {
    onReturnToLobby: () => {
      if (location.hash === '#admin') history.pushState(null, '', location.pathname);
      void enterLobbyView();
    },
  });
}

async function enterLobbyView(): Promise<void> {
  adminHandle?.destroy();
  adminHandle = null;
  const adminRoot = document.getElementById('admin-root');
  if (adminRoot) adminRoot.hidden = true;

  const app = document.getElementById('app');
  if (app) app.style.display = 'none';

  const lobbyEl = document.getElementById('lobby-root')!;
  lobbyEl.hidden = false;

  const { startLobby } = await import('./lobby/lobby.ts');
  lobbyHandle = await startLobby(
    lobbyEl,
    p => enterGameView(p.query),
    () => enterAdminView()
  );
}

async function boot(): Promise<void> {
  // 1) 显式自动化测试/特定夹具调试（Playwright / layout probe 传入 ?game=xxx）：允许直接进入对应场景
  if (isExplicitDevGameRoute()) {
    return enterGameView(location.search);
  }

  // 2) 深链进桌：参数齐全且会话确实有效才放行；否则清掉参数，走正常登录入口。
  //    这里不能用「有参数就直接进」——过期/伪造 token，或上一次对局残留在
  //    地址栏里的参数，都会把玩家塞进一张死桌，登录页被整个跳过。
  const net = netEntryOf(location.search);
  if (net) {
    if (await canEnterNetGame(net)) return enterGameView(net.query);
    stripNetParamsFromUrl();
  }

  // 3) 管理后台路由
  if (isAdminRoute()) {
    return enterAdminView();
  }

  // 4) 大厅模式：必须与服务器联通，绝不降级至单机牌桌
  const alive = await hubAlive();
  if (!alive) {
    // 隐藏可能暴露的 DOM
    const app = document.getElementById('app');
    if (app) app.style.display = 'none';

    showServerConnectingOverlay(async () => {
      const ok = await hubAlive(6000, 1);
      if (ok) {
        hideServerConnectingOverlay();
        stripNetParamsFromUrl();
        void enterLobbyView();
      }
    });

    // 轮询自动重试连接
    retryTimer = window.setInterval(async () => {
      const ok = await hubAlive(4000, 1);
      if (ok) {
        hideServerConnectingOverlay();
        stripNetParamsFromUrl();
        void enterLobbyView();
      }
    }, 2500);
    return;
  }

  hideServerConnectingOverlay();
  stripNetParamsFromUrl();
  return enterLobbyView();
}

window.addEventListener('hashchange', () => {
  if (isAdminRoute()) {
    if (!adminHandle) void enterAdminView();
  } else if (adminHandle) {
    void enterLobbyView();
  }
});

boot();
