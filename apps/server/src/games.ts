import type { HubGameInfo } from '@rds/room-protocol';

/**
 * 游戏清单：新游戏接入 = 这里加一条（后续可改为 DB/远程 manifest）。
 * 人数必须与夹具 setup 实际创建的座位一致，否则多出来的
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
  {
    // Seat counts live in the fixture scenarios; `rooms.ts` derives the room
    // cap from the selected scenario so a table can never be dealt more players
    // than it has seats.
    id: 'poker',
    name: '德州扑克',
    minPlayers: 2,
    maxPlayers: 10,
    clientUrl: '/games/rds-board-core/',
    protocol: 'rds-room/1',
    durationMin: 30,
    accent: '#4ec9b0',
    /** 支持房主在大厅直接添加内置 AI 补位。 */
    aiSeats: true,
    variants: [
      { id: 'ai_table_6', label: '1 真人 + 5 AI（入门桌）' },
      { id: 'ai_table_10', label: '1 真人 + 9 AI（满桌）' },
      { id: 'seats_2', label: '单挑（2 人）' },
      { id: 'seats_4', label: '4 人桌' },
      { id: 'seats_6', label: '6 人桌' },
      { id: 'seats_10', label: '10 人满桌' },
      { id: 'short_stack', label: '短码演示（4 人）' },
    ],
  },
  {
    // 三国杀：夹具默认 4 座（packages/games/src/sanguosha/setup.ts 的 playerOrder）。
    id: 'sanguosha',
    name: '三国杀',
    minPlayers: 4,
    maxPlayers: 4,
    clientUrl: '/games/rds-board-core/',
    protocol: 'rds-room/1',
    durationMin: 45,
    accent: '#d9a441',
  },
  {
    // 沙丘 & 麻将：夹具默认 3 座（packages/games/src/dune_mahjong/setup.ts 的 playerOrder）。
    // 之前只在 registry 里、没进大厅，等于「能跑但没人能开房」（issue #236）。
    id: 'dune_mahjong',
    name: '沙丘 & 麻将',
    minPlayers: 3,
    maxPlayers: 3,
    clientUrl: '/games/rds-board-core/',
    protocol: 'rds-room/1',
    durationMin: 60,
    accent: '#c08457',
  },
];
export const gameById = (id: string) => GAMES.find(g => g.id === id);
