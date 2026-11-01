import './lobby/lobby.css';
import { showGameLoading } from './gameLoading';
import { canEnterNetGame, netEntryOf, stripNetParamsFromUrl } from './entryRoute.ts';

/**
 * 统一外壳（unified shell）：单一 SPA 同时承载「联机大厅」、「后台管理」与「游戏本体」。
 * 启动二态探测：同源 /healthz 在 500ms 内应答 → 大厅/管理模式；否则 → 本地单机模式。
 *
 * 入口顺序固定为「登录页 → 选择游戏/加入房间 → 牌桌」：
 * URL 带网络对局参数只表示「想深链进桌」，进桌前还必须验证参数里的会话真的
 * 有效（`entryRoute.ts`）；验证不过就清掉参数退回登录页，绝不跳过登录。
 */

function isAdminRoute(): boolean {
  const p = new URLSearchParams(location.search);
  return location.pathname.endsWith('/admin') || location.hash === '#admin' || p.has('admin') || p.get('view') === 'admin';
}

async function hubAlive(): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 500);
    const res = await fetch('/healthz', { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return false;
    // SPA fallback（如 vite dev）会对任意路径回 200 HTML——必须验证 JSON 体
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('application/json')) return false;
    const body = await res.json();
    return body?.ok === true;
  } catch { return false; }
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
  await import('./main.ts');
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
  // 1) 深链进桌：参数齐全且会话确实有效才放行；否则清掉参数，走正常登录入口。
  //    这里不能用「有参数就直接进」——过期/伪造 token，或上一次对局残留在
  //    地址栏里的参数，都会把玩家塞进一张死桌，登录页被整个跳过。
  const net = netEntryOf(location.search);
  if (net) {
    if (await canEnterNetGame(net)) return enterGameView(net.query);
    stripNetParamsFromUrl();
  }

  // 2) 同源探测 Hub
  const alive = await hubAlive();
  if (!alive) {
    // 本地单机模式：隐藏大厅，直接启动游戏外壳
    return enterGameView('');
  }

  // 3) 管理后台路由
  if (isAdminRoute()) {
    return enterAdminView();
  }

  // 4) 默认大厅模式：未登录先给登录页，登录成功由 lobby 自己落到首页
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
