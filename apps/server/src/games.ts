import type { HubGameInfo } from '@rds/room-protocol';

/**
 * 游戏清单：新游戏接入 = 这里加一条（后续可改为 DB/远程 manifest）。
 * REVIEW.md S9：人数必须与夹具 setup 实际创建的座位一致，否则多出来的
 * 玩家会进入对局却没有任何合法动作（引擎里根本没有他的座位）。
 * 当前事实（packages/games/src 下各夹具 setup.ts 的 playerOrder/DEFAULT_ROSTER）：
 *   splendor p1-p2 / catan p1-p3 / betrayal DEFAULT_ROSTER 3 人。
 * 待内核支持 setup(seed, playerCount) 后再放宽到真实游戏人数。
 */
export const GAMES: HubGameInfo[] = [
  {
    id: 'splendor',
    name: '璀璨宝石',
    minPlayers: 2,
    maxPlayers: 2,
    clientUrl: '/games/rds-board-core/',
    protocol: 'rds-room/1',
    durationMin: 30,
    accent: '#7ee787',
  },
  {
    id: 'catan',
    name: '卡坦岛',
    minPlayers: 3,
    maxPlayers: 3,
    clientUrl: '/games/rds-board-core/',
    protocol: 'rds-room/1',
    durationMin: 60,
    accent: '#e3b341',
  },
  {
    id: 'betrayal',
    name: '山屋惊魂',
    minPlayers: 3,
    maxPlayers: 3,
    clientUrl: '/games/rds-board-core/',
    protocol: 'rds-room/1',
    durationMin: 60,
    accent: '#ff8b82',
    variants: [{ id: 'exploration', label: '预铺探索（半开局）' }],
  },
];
export const gameById = (id: string) => GAMES.find(g => g.id === id);
