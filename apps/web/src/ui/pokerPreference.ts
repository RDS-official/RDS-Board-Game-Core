/**
 * 德州扑克视图偏好设置（极简 2D 俯视 vs 3D 拟真桌面）。
 * 存储在 localStorage 中，也可在个人资料设置弹窗与对局顶部随时切换。
 */

const POKER_VIEW_KEY = 'rds_poker_view_mode';

export type PokerViewMode = '2d' | '3d';

type Listener = (mode: PokerViewMode) => void;
const listeners = new Set<Listener>();

export function getPokerViewMode(): PokerViewMode {
  // 1. URL 参数最高优先级（便于测试和深链指定：?poker_view=2d 或 ?poker_view=3d）
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('poker_view');
    if (fromUrl === '2d' || fromUrl === '3d') return fromUrl;

    // 自动化单机测试夹具（如 probe-poker-table.mjs 传 ?game=poker 且无 hub）缺省使用 3D
    // 以保证现有 3D 场景测试断言（网格/家具/材质）不受影响
    if (params.has('game') && !params.has('hub') && !localStorage.getItem(POKER_VIEW_KEY)) {
      return '3d';
    }
  } catch {}

  // 2. 本地存储
  try {
    const stored = localStorage.getItem(POKER_VIEW_KEY);
    if (stored === '3d') return '3d';
    if (stored === '2d') return '2d';
  } catch {}

  // 3. 默认走 3D 拟真桌面：极简 2D 由玩家在个人资料设置里显式开启
  return '3d';
}

export function setPokerViewMode(mode: PokerViewMode): void {
  try {
    localStorage.setItem(POKER_VIEW_KEY, mode);
  } catch {}
  for (const fn of listeners) {
    try { fn(mode); } catch (e) { console.error('[pokerPreference] listener error', e); }
  }
}

export function onPokerViewModeChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
