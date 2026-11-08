import { html, setHtml } from './ui/dom/html';
/**
 * 联机开局过渡遮罩：从「房主开局」到牌局首帧渲染之间，用全屏加载动效
 * 掩盖 大厅 → 游戏外壳(main chunk 加载/WebFont 解码/场景首绘) 的中间态。
 * show() 在 shell enterGameView 注入；hide() 在 main.ts 字体就绪首绘后调用。
 */
const MIN_VISIBLE_MS = 600;
/**
 * 启动看门狗：牌桌没在这么长时间内把 `__boardGameApp` 挂上，就说明启动链路断了
 * （chunk 加载失败 / 构造抛错 / 字体探测卡死）。过去这种情况只会留一个永远转的
 * spinner——玩家看不到原因，也没法自救，所以超时后必须换成可读的错误 + 重试。
 */
const STARTUP_TIMEOUT_MS = 12_000;
let shownAt = 0;
let watchdog = 0;

export function showGameLoading(): void {
  if (document.getElementById('game-loading')) return;
  shownAt = Date.now();
  const ov = document.createElement('div');
  ov.id = 'game-loading';
  setHtml(
    ov,
    html`<div class="gl-spinner"></div>
    <div class="gl-title">游戏加载中</div>
    <div class="gl-sub">正在同步牌局与渲染桌面…</div>`
  );
  const s = ov.style;
  s.position = 'fixed'; s.inset = '0'; s.zIndex = '9999';
  s.display = 'flex'; s.flexDirection = 'column'; s.alignItems = 'center'; s.justifyContent = 'center';
  s.gap = '14px'; s.background = '#0d1117'; s.color = '#d9b45b';
  s.fontFamily = '"Alibaba PuHuiTi", system-ui, sans-serif';
  s.transition = 'opacity .45s ease';
  const spin = document.createElement('style');
  spin.textContent = [
    '#game-loading .gl-spinner{width:54px;height:54px;border-radius:50%;',
    'border:3px solid rgba(217,180,91,.18);border-top-color:#d9b45b;animation:gl-rot 1s linear infinite}',
    '#game-loading .gl-title{font-size:20px;letter-spacing:2px}',
    '#game-loading .gl-sub{font-size:13px;color:#8b949e}',
    '#game-loading .gl-retry{margin-top:6px;padding:8px 20px;border-radius:8px;',
    'border:1px solid rgba(217,180,91,.5);background:rgba(217,180,91,.16);color:#f3e6c8;',
    'font-size:14px;cursor:pointer}',
    '#game-loading .gl-sub{max-width:min(520px,80vw);text-align:center;line-height:1.6}',
    '@keyframes gl-rot{to{transform:rotate(360deg)}}'
  ].join('');
  ov.appendChild(spin);
  document.body.appendChild(ov);

  window.clearTimeout(watchdog);
  watchdog = window.setTimeout(() => watchStartup(), STARTUP_TIMEOUT_MS);
}

/** 看门狗到期：牌桌还没起来就把遮罩换成可读的失败态。 */
function watchStartup(): void {
  const ov = document.getElementById('game-loading');
  if (!ov) return;
  if ((window as unknown as { __boardGameApp?: unknown }).__boardGameApp) return;
  failGameLoading('牌桌在 12 秒内没有就绪。请打开控制台（F12）看第一条红色报错，然后重试。');
}

/** 明确的启动失败（chunk 加载失败 / 构造抛错）：不要假装还在加载。 */
export function failGameLoading(message: string): void {
  window.clearTimeout(watchdog);
  let ov = document.getElementById('game-loading');
  if (!ov) {
    showGameLoading();
    ov = document.getElementById('game-loading');
  }
  if (!ov) return;
  setHtml(
    ov,
    html`<div class="gl-title">启动失败</div>
    <div class="gl-sub">${message}</div>
    <button class="gl-retry" type="button">重新加载</button>`
  );
  ov.querySelector('.gl-retry')?.addEventListener('click', () => location.reload());
}

export function hideGameLoading(): void {
  window.clearTimeout(watchdog);
  watchdog = 0;
  const ov = document.getElementById('game-loading');
  if (!ov) return;
  const elapsed = Date.now() - shownAt;
  const fade = () => {
    ov.style.opacity = '0';
    setTimeout(() => ov.remove(), 480);
  };
  if (elapsed >= MIN_VISIBLE_MS) fade();
  else setTimeout(fade, MIN_VISIBLE_MS - elapsed);
}
