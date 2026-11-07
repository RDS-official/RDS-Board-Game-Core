import type { PlayerViewHints } from '@rds/kernel/module';
import type { Player, ProjectedGameState } from '@rds/kernel/types';

/** Six Poké Ball colours; purple is the wild master ball. */
const POKEBALLS: { id: string; short: string; label: string; color: string }[] = [
  { id: 'red', short: '红', label: '红色精灵球', color: '#e53935' },
  { id: 'blue', short: '蓝', label: '蓝色精灵球', color: '#1e88e5' },
  { id: 'black', short: '黑', label: '黑色精灵球', color: '#212121' },
  { id: 'pink', short: '粉', label: '粉色精灵球', color: '#ec407a' },
  { id: 'yellow', short: '黄', label: '黄色精灵球', color: '#fdd835' },
  { id: 'purple', short: '紫', label: '大师球', color: '#8e24aa' }
];

const MASTER_BALL = 'purple';

export function splendorPhaseLabel(state: ProjectedGameState): string {
  const evolved = state.globalVars.evolvedThisTurn === true;
  const lastRound = state.globalVars.lastRound === true;
  return [
    'TRAINER TURN · 训练家行动',
    `目标 ${Number(state.globalVars.scoreToWin ?? 18)} 分`,
    evolved ? '本回合已进化' : '可进化 1 次',
    lastRound ? '终局回合' : null
  ]
    .filter(Boolean)
    .join(' · ');
}

export function splendorPlayerView(player: Player, state: ProjectedGameState): PlayerViewHints {
  const bonuses = (player.customProps.bonuses ?? {}) as Record<string, number>;
  const tokens = (player.customProps.tokens ?? {}) as Record<string, number>;
  const tokenTotal = POKEBALLS.reduce((sum, ball) => sum + Number(tokens[ball.id] ?? 0), 0);
  const fielded = state.zones[`zone_tableau_${player.id}`]?.orderedEntities.length ?? 0;
  const handCount = state.zones[`zone_hand_${player.id}`]?.orderedEntities.length ?? 0;
  return {
    pips: POKEBALLS.map(ball => ({
      color: ball.color,
      label: ball.id === MASTER_BALL ? `${ball.label}（持有）` : `${ball.label}（加成）`,
      short: ball.short,
      value: String((ball.id === MASTER_BALL ? tokens[ball.id] : bonuses[ball.id]) ?? 0)
    })),
    stats: [
      { label: '精灵球 / 大师球', value: `${tokenTotal - Number(tokens[MASTER_BALL] ?? 0)} / ${Number(tokens[MASTER_BALL] ?? 0)}` },
      { label: '宝可梦 / 保留', value: `${fielded} / ${handCount}` }
    ]
  };
}
