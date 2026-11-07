import type { PlayerViewHints } from '@rds/kernel/module';
import type { Player, ProjectedGameState } from '@rds/kernel/types';

export function dunePhaseLabel(state: ProjectedGameState): string {
  return state.globalVars.battleMode === 'MAHJONG'
    ? 'PRIORITY CLAIM · 抢断窗口'
    : 'SIMULTANEOUS COMMIT · 同步盲提';
}

export function dunePlayerView(player: Player, state: ProjectedGameState): PlayerViewHints {
  const openWindow = state.pendingDecisions.find(window => window.status === 'OPEN');
  const submitted = openWindow
    ? openWindow.submissions[player.id] !== undefined
    : !!state.globalVars.committedDials?.[player.id];
  return {
    pips: [
      { color: '#e0922f', label: '香料', short: '香料', value: String(player.customProps.spice ?? 0) },
      { color: '#8b93a1', label: '军团', short: '军团', value: String(player.customProps.troops ?? 0) }
    ],
    stats: [{ label: String(player.customProps.leader ?? '将领'), value: submitted ? '🔒 已锁定转盘' : '⚪ 未提交' }]
  };
}
