import type { PlayerViewHints } from '@rds/kernel/module';
import type { Player, ProjectedGameState } from '@rds/kernel/types';

const RESOURCES: Record<string, { icon: string; label: string; color: string }> = {
  wood: { icon: '🌲', label: '木材', color: '#3f9d5a' },
  brick: { icon: '🧱', label: '砖', color: '#c9603f' },
  sheep: { icon: '🐑', label: '羊毛', color: '#9bc94f' },
  wheat: { icon: '🌾', label: '麦', color: '#e0b23c' },
  ore: { icon: '⛏️', label: '矿', color: '#8b93a1' }
};

const PHASES: Record<string, string> = {
  SETUP_SETTLEMENT: 'SETUP · 选择起始定居点',
  SETUP_ROAD: 'SETUP · 铺设起始道路',
  ROLL: 'ROLL · 掷骰子',
  ACTION: 'ACTION · 建造 / 交易 / 发展卡',
  DISCARD: 'DISCARD · 七点弃牌',
  MOVE_ROBBER: 'ROBBER · 移动强盗',
  STEAL: 'STEAL · 选择偷取对象',
  ROAD_BUILDING: 'ROAD BUILDING · 免费修路',
  TRADE_PENDING: 'PLAYER TRADE · 等待回应'
};

export function catanPhaseLabel(state: ProjectedGameState): string {
  return PHASES[state.phase] ?? state.phase;
}

export function catanPlayerView(player: Player, state: ProjectedGameState): PlayerViewHints {
  const resources = (player.customProps.resources ?? {}) as Record<string, number>;
  const owned = Object.values(state.entities).filter(entity => entity?.ownerId === player.id && entity.components?.building);
  const devCount = state.zones[`zone_dev_${player.id}`]?.orderedEntities.length ?? 0;
  const knights = Number(player.customProps.knightsPlayed ?? 0);
  const longest = state.globalVars.longestRoadOwner === player.id;
  const army = state.globalVars.largestArmyOwner === player.id;
  return {
    pips: Object.entries(RESOURCES).map(([key, meta]) => ({
      color: meta.color,
      label: meta.label,
      icon: meta.icon,
      value: String(resources[key] ?? 0)
    })),
    stats: [
      {
        label: '建筑',
        value: `${owned.filter(entity => entity.components!.building!.type === 'SETTLEMENT').length} 村 · ${
          owned.filter(entity => entity.components!.building!.type === 'CITY').length
        } 城 · ${owned.filter(entity => entity.components!.building!.type === 'ROAD').length} 路`
      },
      { label: '发展卡 / 骑士', value: `${devCount} / ${knights}` },
      ...(longest || army
        ? [{ label: '特殊卡', value: `${longest ? '最长道路' : ''}${longest && army ? ' · ' : ''}${army ? '最大军队' : ''}` }]
        : [])
    ]
  };
}
