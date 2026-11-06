import { escapeHtml } from '../htmlEscape';
import { html, raw, setHtml } from '../ui/dom/html';

export interface WebGLSupportResult {
  supported: boolean;
  version?: 'webgl2' | 'webgl';
  error?: string;
  detail?: string;
}

/**
 * Probes the current browser environment for WebGL / WebGL2 context availability.
 * Catches sandboxed/disabled GPU scenarios before Three.js throws unhandled errors.
 */
export function checkWebGLSupport(): WebGLSupportResult {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { supported: false, error: 'Environment is not a browser window' };
  }

  const canvas = document.createElement('canvas');

  // 1. Try WebGL2 first
  try {
    const gl2 = canvas.getContext('webgl2');
    if (gl2) {
      return { supported: true, version: 'webgl2' };
    }
  } catch (err) {
    // Continue to probe WebGL 1
  }

  // 2. Try WebGL 1
  try {
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl) {
      return { supported: true, version: 'webgl' };
    }
  } catch (err) {
    const msg = (err as Error)?.message || String(err);
    return {
      supported: false,
      error: 'WebGL context initialization threw an error',
      detail: msg
    };
  }

  return {
    supported: false,
    error: 'WebGL not supported or hardware acceleration is disabled',
    detail: 'Failed to create both webgl2 and webgl contexts on canvas'
  };
}

/**
 * Displays a friendly gothic-styled modal overlay when WebGL cannot be initialized.
 */
export function renderWebGLErrorModal(detail?: string): void {
  // Hide boot screen if still present
  const bootScreen = document.getElementById('boot-screen');
  if (bootScreen) {
    bootScreen.style.display = 'none';
  }

  // Remove any previous error modal if exists
  const existing = document.getElementById('webgl-error-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'webgl-error-overlay';
  overlay.className = 'webgl-error-overlay';

  setHtml(overlay, html`
    <div class="webgl-error-card">
      <div class="webgl-error-icon">⚠️</div>
      <h2 class="webgl-error-title">无法启动 3D 渲染引擎 (WebGL)</h2>
      <p class="webgl-error-desc">
        当前浏览器无法创建 WebGL 绘图上下文，通常是由于<strong>浏览器硬件加速未开启</strong>或显卡驱动异常所致。
      </p>

      <div class="webgl-error-steps">
        <div class="step-item">
          <span class="step-badge">1</span>
          <div class="step-text">
            <strong>开启浏览器硬件加速</strong>
            <p>前往浏览器设置（Chrome / Edge：<code>设置 -> 系统与性能 -> 使用图形加速 / 硬件加速</code>），将其开启后彻底重启浏览器。</p>
          </div>
        </div>
        <div class="step-item">
          <span class="step-badge">2</span>
          <div class="step-text">
            <strong>检查 WebGL 状态</strong>
            <p>在地址栏输入 <code>chrome://gpu</code> 查看 WebGL 状态；或访问 <code>chrome://flags/#ignore-gpu-blocklist</code> 尝试强制启用 GPU 渲染。</p>
          </div>
        </div>
        <div class="step-item">
          <span class="step-badge">3</span>
          <div class="step-text">
            <strong>远程桌面或虚拟机环境</strong>
            <p>若通过远程桌面 (RDP / VNC) 访问，部分环境默认禁用物理 GPU，请在具备图形硬件加速的本地浏览器中打开。</p>
          </div>
        </div>
      </div>

      ${raw(detail
          ? `<details class="webgl-error-technical">
              <summary>查看详细错误信息</summary>
              <pre>${escapeHtml(detail)}</pre>
            </details>`
          : '')}

      <div class="webgl-error-actions">
        <button class="webgl-retry-btn" onclick="window.location.reload()">重新检查并刷新</button>
        <a class="webgl-link-btn" href="https://get.webgl.org/" target="_blank" rel="noopener noreferrer">访问 WebGL 官方测试页</a>
      </div>
    </div>
  `);

  document.body.appendChild(overlay);
}


