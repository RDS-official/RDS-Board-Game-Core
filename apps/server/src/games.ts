import type { HubGameInfo } from '@rds/room-protocol';
import { GAME_REGISTRY } from '@rds/games/registry';
import { seatRangeOf } from '@rds/kernel/seating';

/** Keep the lobby menu and the kernel scenario table in lockstep. */
function variantsOf(gameId: string): { id: string; label: string }[] | undefined {
  const scenarios = GAME_REGISTRY[gameId]?.scenarios;
  if (!scenarios) return undefined;
  const rows = Object.entries(scenarios).map(([id, scenario]) => ({
    id,
    label: scenario.description ?? id
  }));
  return rows.length > 0 ? rows : undefined;
}

function seatRangeOfGame(gameId: string): { minPlayers: number; maxPlayers: number } {
  const module = GAME_REGISTRY[gameId];
  const range = module ? seatRangeOf(module) : { min: 2, max: 4 };
  return { minPlayers: range.min, maxPlayers: range.max };
}

/**
 * 游戏清单：新游戏接入 = 这里加一条（后续可改为 DB/远程 manifest）。
 * 人数必须与夹具 setup 实际创建的座位一致，否则多出来的
 * 玩家会进入对局却没有任何合法动作（引擎里根本没有他的座位）。
 * 固定阵容的玩法仍由 `meta.seatRange` / scenario.seats 决定；三国杀、德州扑克等
 * 可变人数玩法由夹具读取 `setup(seed, { seats, humans, aiSeats })`。
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
    ...seatRangeOfGame('catan'),
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
    // 三国杀：2–8 座；标准身份局 5/8 人、4 人对抗与杀下家村规都由 scenario 声明。
    id: 'sanguosha',
    name: '三国杀',
    ...seatRangeOfGame('sanguosha'),
    clientUrl: '/games/rds-board-core/',
    protocol: 'rds-room/1',
    durationMin: 45,
    accent: '#d9a441',
    aiSeats: true,
    variants: variantsOf('sanguosha'),
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
