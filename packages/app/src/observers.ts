import type { ProjectedGameState } from '@rds/kernel/types';
import type { UiObserver } from './contracts';

/**
 * 观察席 DTO。
 *
 * 通用层不认识「德州扑克」：观察席、低保参数、换桌目标全部来自
 * `globalVars.observers` 这个纯 JSON 结构，游戏没声明就返回 undefined，HUD 也
 * 就不画观察席卡片。`canRejoin` 由调用方给出（会话能问到引擎的合法动作，联机
 * 客户端只知道自己那一份），避免这里猜规则。
 */
interface RawObserver {
  playerId: string;
  seatIndex?: number;
  stipendSeconds?: number;
  pendingSeat?: number | null;
}

interface RawObserverState {
  list?: RawObserver[];
  stipend?: { periodSeconds?: number; amount?: number; threshold?: number };
}

export function buildObserverRoster(
  state: ProjectedGameState,
  canRejoin?: (playerId: string) => boolean
): UiObserver[] | undefined {
  const raw = state.globalVars.observers as RawObserverState | undefined;
  if (!raw || !Array.isArray(raw.list) || raw.list.length === 0) return undefined;
  const period = Math.max(1, Number(raw.stipend?.periodSeconds ?? 60));
  const amount = Math.max(0, Number(raw.stipend?.amount ?? 0));
  return raw.list.map(entry => {
    const player = state.players[entry.playerId];
    const chips = Number(player?.customProps?.chips ?? 0);
    const pendingSeat = entry.pendingSeat;
    return {
      playerId: entry.playerId,
      name: player?.name ?? entry.playerId,
      seatIndex: entry.seatIndex,
      chips,
      stipendInSeconds: Math.max(0, Math.round(period - Number(entry.stipendSeconds ?? 0))),
      stipendAmount: amount,
      pendingLabel:
        pendingSeat === null || pendingSeat === undefined ? undefined : `第 ${pendingSeat + 1} 座`,
      canRejoin: canRejoin ? canRejoin(entry.playerId) : chips > 0
    };
  });
}
