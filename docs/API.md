# 后端接口清单（Hub REST + `/ws` 对局通道）

面向前端对接的一份**可核对的接口总表**。所有条目都对着代码逐条核对，权威来源写在每一节末尾；
文档与代码冲突时以代码为准，并请顺手修这份文档。

> **先读这一句**：牌局（含德州扑克）**不是 REST 接口**。
> REST 只负责账号、大厅、房间与战绩查询；牌桌状态与出牌动作全部走 `/ws` 上的
> `match-*` 消息。没有 `/api/poker/deal`、`/api/poker/bet` 这类端点，
> 也不需要——发牌、下注、开下一手都是内核动作，由客户端在 WS 上提交。
>
> 见 [§4 对局通道](#4-对局通道ws)。

## 1. 通用约定

| 项 | 约定 |
|---|---|
| 基址 | 与页面同源（生产 `http://117.72.60.103:8787/`）；开发走 Vite 代理 |
| 鉴权 | `Authorization: Bearer <token>`，token 由 `POST /api/auth/login` 下发 |
| 请求体 | `Content-Type: application/json`（头像上传除外） |
| 成功响应 | 直接是数据本身，**不套 `{ data: ... }` 信封** |
| 失败响应 | `{ "error": "<中文或英文原因>" }` + 4xx/5xx 状态码 |
| 注册 | 已关闭，`POST /api/auth/register` 恒返回 403，账号由管理员分配 |

**写操作有同源校验**：带 `Origin` 头的非只读请求（`POST` / `PUT` / `DELETE`）必须同源，
或列在环境变量 `ALLOWED_ORIGINS`（逗号或空白分隔）里，否则返回 403
（`{ "error": "跨站请求被拒绝" }`）。`GET` / `HEAD` / `OPTIONS` 不受影响。

本地前端不在同源时，二选一：给服务端配 `ALLOWED_ORIGINS=http://localhost:5173`，
或者用 Vite 代理把 `/api` 与 `/ws` 指到后端。

## 2. 鉴权与账号

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| POST | `/api/auth/login` | `{ name, password }` | `{ token, user: { id, name, role } }` |
| POST | `/api/auth/register` | — | 恒 `403`（注册已关闭） |
| GET | `/api/auth/me` | — | `{ sub, name, role }`（轻量身份，不含昵称头像） |
| GET | `/api/me` | — | `UserProfile`（见下） |
| PUT | `/api/me` | `{ displayName }` | `{ user: UserProfile }` |
| PUT | `/api/me/password` | `{ oldPassword, newPassword }` | `{ ok: true }` |
| PUT | `/api/me/avatar` | 原始二进制 + `Content-Type: image/png\|jpeg\|webp` | `{ avatarUrl }` |
| GET | `/avatars/:file` | — | 图片字节流 |

`UserProfile`：

```ts
{
  id: string; name: string; displayName: string;
  role?: 'admin' | 'user'; avatarUrl?: string;
  sanguoshaPoints?: number;
  sanguoshaCareer?: { games: number; wins: number };
}
```

登录细节：

- 同一 `IP + 用户名` 15 分钟内失败 10 次 → `429`（`尝试过于频繁，请 15 分钟后再试`）。
- 账号被禁用 → `401`，错误文案明确说明是禁用而非密码错误。
- 头像限制：≤300KB，只收 png/jpeg/webp，会校验文件头；超限返回 400 并说明原因。

## 3. 大厅与房间

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| GET | `/api/games` | — | `HubGameInfo[]` |
| GET | `/api/rooms` | — | `HubRoomInfo[]` |
| POST | `/api/rooms` | `{ name, gameId, maxPlayers?, isPrivate?, scenarioId? }` | `HubRoomInfo` |
| GET | `/api/rooms/:id` | — | `HubRoomInfo`（需登录） |
| POST | `/api/rooms/:id/join` | `{ code? }` | `HubRoomInfo` |
| POST | `/api/rooms/:id/leave` | — | `{ ok: true }` |
| POST | `/api/rooms/:id/status` | `{ status: 'open' \| 'playing' \| 'closed' }` | `HubRoomInfo` |
| POST | `/api/rooms/:id/ready` | `{ ready: boolean }` | `HubRoomInfo` |
| POST | `/api/rooms/:id/kick` | `{ target }` | `HubRoomInfo` |
| POST | `/api/rooms/:id/host` | `{ target }` | `HubRoomInfo` |
| POST | `/api/rooms/:id/ai` | `{ aiSeats }` | `HubRoomInfo` |
| GET | `/api/rooms/:id/match` | — | `{ roomId, gameId, revision, seats, attached }`（房间成员可见） |

`HubGameInfo`：

```ts
{
  id: string; name: string;
  minPlayers: number; maxPlayers: number;
  clientUrl: string; protocol: string;      // protocol 恒为 'rds-room/1'
  durationMin?: number; accent?: string;
  variants?: { id: string; label: string }[];
  aiSeats?: boolean;                        // 该玩法是否允许房主加 AI 补位
}
```

`HubRoomInfo`：

```ts
{
  id: string; name: string; gameId: string;
  hostId: string; hostName: string;
  status: 'open' | 'playing' | 'closed';
  maxPlayers: number;
  players: { id: string; name: string; displayName?: string; avatarUrl?: string; seat: number }[];
  createdAt: number;
  readyPlayers?: string[];
  isPrivate?: boolean;
  code?: string;          // 私密房加入码，只回传给房主
  scenarioId?: string;    // 开局变体，透传给游戏客户端的 ?scenario=
  aiSeats?: number;       // 房主添加的 AI 补位数量
}
```

两个容易踩的点：

1. **`players` 按座位号升序，`seat` 是 0 起的连续序号**，`seat === 0` 就是 `p1`。
   数组下标是「加入顺序」，掉线重连的人会排到末尾，**不要用下标当座位**。
2. `code` 只有房主能拿到；房客加入私密房要在 `join` 里带 `code`。

## 4. 对局通道（`/ws`）

牌桌的唯一数据通道。连接：`ws(s)://<host>/ws?token=<jwt>`。

**一个连接上跑着两个通道**，互不干扰：

| 通道 | 消息 | 用途 |
|---|---|---|
| 信令（P2P 兼容 / 大厅实时） | `join-room`、`sdp`、`ice`、`peer-*`、`presence`、`lobby-*`、`room-updated` | WebRTC 协商与大厅推送 |
| 中心模式对局（默认） | `match-*` | 服务器权威牌局 |

### 4.1 加入牌局

```
→ { t: 'join-room', roomId }        // 信令层校验成员资格，非成员被 close(4003)
→ { t: 'match-join', roomId }
← { t: 'match-seat', roomId, seat } // 座位由服务器分配，客户端不能自报
← { t: 'room-update', update }      // 首次是全量快照
← { t: 'match-state', roomId, gameId, revision, seats }
```

### 4.2 出牌与同步

```
→ { t: 'match-submit', action }     // 提交一个内核动作
→ { t: 'match-snapshot' }           // 主动要全量
→ { t: 'match-delta' }              // 主动要增量
← { t: 'room-update', update }      // 每次状态变化推一次
← { t: 'error', message }           // 动作被拒（带原因）
← { t: 'match-state', roomId, closed: true }  // 房间已关闭
```

`action` 是内核动作对象，形如
`{ type: string, playerId?: string, actorId?: string, entityId?: string, targetPlayerId?: string, payload?: object }`。
**合法动作列表来自投影**，前端负责把用户选择映射回其中**某一条**，不要自己拼字段：
多拼一个字段就会因为 canonical 绑定不一致而被服务端拒绝。

`RoomUpdate`：

```ts
{
  viewer: PlayerId | 'GOD';
  revision: number;
  baseRevision: number;
  full: boolean;                 // true = 全量快照，false = 增量
  state?: ProjectedGameState;    // full 时给出
  patches: PatchOp[];            // 增量补丁（add / remove / replace）
}
```

要点：

- **投影是按座位裁剪的**：每个客户端只收到自己的 `viewer` 视角，隐藏信息不会下发。
- 同一用户重连会顶掉旧连接（避免 SDP 发给死端、delta 推给旧 socket）。
- 重连后座位不变；客户端会重新 `match-snapshot`，因此不要假设 `revision` 连续。

## 5. 德州扑克专属

### 5.1 全服排行（公开，无需登录）

`GET /api/poker/leaderboard`

```ts
{
  rows: GlobalPokerRow[];
  rooms: number;       // 当前托管对局数
  updatedAt: number;   // 毫秒时间戳
}
```

`GlobalPokerRow`：

```ts
{
  userId: string; name: string; avatarUrl?: string; isAi?: boolean;
  chips: number;       // 余额 + 桌上筹码（总身价）
  bankroll: number;    // 其中未上桌的部分
  onTable: number;     // 其中正在桌上的部分（多桌相加）
  peakChips: number;   // 历史峰值
  share: number;       // 0..1，占全服总筹码比例
  roomId?: string;     // 正在玩时才有
  seat?: string;       // 正在玩时才有，如 'p3'
  stats: {
    // 原始计数
    hands: number; won: number; vpip: number; sawFlop: number;
    showdowns: number; showdownWins: number;
    netChips: number;  // 累计净输赢（赢回 - 投入）
    bestPot: number;   // 单手提走的最大底池
    updatedAt: number; // 最近一手时间，0 = 从未打过
    // 服务端算好的比率，前端不要再除一遍
    winRate: number; vpipRate: number; sawFlopRate: number;
    showdownRate: number; showdownWinRate: number;
  };
}
```

**匿名访问会被打码**：未登录时 `name` 是打码昵称且 `userId` 为空串（防账号枚举）。
排行榜要展示完整行就必须带 token。

> 名字里带 `ai:` 前缀的是内置 AI 账号，`isAi: true`。

### 5.2 单账号战绩

`GET /api/poker/account/:id`

- `:id` 传账号 id；传 `me` 表示当前登录账号。
- 返回单个 `GlobalPokerRow`（同上）。
- 账号不存在 → 404；`me` 未登录 → 401。

### 5.3 德州在大厅里的元数据

- `GET /api/games` 的 poker 条目：`minPlayers: 2`、`maxPlayers: 10`、`aiSeats: true`。
- 可选变体（`variants`）：

| `id` | 含义 |
|---|---|
| `ai_table_6` | 1 真人 + 5 AI（入门桌） |
| `ai_table_10` | 1 真人 + 9 AI（满桌） |
| `seats_2` | 单挑 |
| `seats_4` | 4 人桌 |
| `seats_6` | 6 人桌 |
| `seats_10` | 10 人满桌 |
| `short_stack` | 短码演示（4 人） |

- 房主加 AI：`POST /api/rooms/:id/ai`，`{ aiSeats: n }`。AI 座位**不占真人名额**。

### 5.4 德州没有的东西

避免照着别的项目猜接口：

- 没有「发牌 / 下注 / 加注 / 弃牌」的 REST 端点——都是 WS 上的 `match-submit`。
- 没有单独的「牌桌状态」REST——牌桌状态只在 `room-update` 的投影里。
- 没有公开的房间内筹码明细接口——只有 `/api/poker/*` 的聚合身价与战绩。
- 观察者（输光后旁观）也是投影里的字段，不是独立接口。

## 6. 运维与排障

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 健康检查；账本或存储损坏时返回 `degraded` 并附备份路径 |
| GET | `/api/match/stats` | 托管对局数量；房间号仅管理员可见（防房间枚举） |
| POST | `/api/diagnostics` | 前端诊断日志上报（≤限制大小，超频 429，成功 204） |
| GET | `/api/diagnostics/recent` | 最近日志，**仅在 `HUB_DEBUG_LOGS=1` 时可用**，否则 404 |

## 7. 管理后台

全部 `/api/admin/*` 需管理员身份（非管理员 403，未登录 401）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/users` | 用户列表 + 统计 |
| POST | `/api/admin/users` | 建号 |
| PUT | `/api/admin/users/:id` | 改昵称 / 角色 / 禁用 |
| POST | `/api/admin/users/:id/password` | `{ password }` 重置密码 |
| DELETE | `/api/admin/users/:id` | 删号（系统管理员与自己的账号不可删） |

## 8. 联调与验证

| 脚本 | 验证内容 |
|---|---|
| `node scripts/verify-centre-mode.mjs` | 真服务端 + 双 WS：座位分配、双端独立投影、伪造 actor 被拒、动作跨端传播、关房释放 |
| `node scripts/verify-centre-mode-browser.mjs` | 两个真实浏览器标签按大厅 URL 契约加入同一房间并渲染 |
| `node ./node_modules/tsx/dist/cli.mjs apps/server/src/selftest.ts` | 服务端单元自检（含座位 / 伪造 / 释放断言） |

相关文档：[LOBBY-INTEGRATION.md](LOBBY-INTEGRATION.md)（大厅与权威位置）、
[NET-SYNC-NOTES.md](NET-SYNC-NOTES.md)（同步语义）、[POKER.md](POKER.md)（德州规则与账本）。

## 9. 权威来源

| 内容 | 文件 |
|---|---|
| REST 路由 | `apps/server/src/index.ts` |
| 对局 WS 通道 | `apps/server/src/matchBroker.ts` |
| 信令 WS 通道 | `apps/server/src/signal.ts` |
| 房间 DTO | `packages/room-protocol/src/index.ts` |
| 德州排行与账本 | `apps/server/src/pokerLeaderboard.ts`、`apps/server/src/pokerLedger.ts` |
| 德州战绩结构 | `packages/games/src/poker/stats.ts` |
| 动作被拒内核校验 | `packages/kernel/src/engine.ts` |
| 客户端传输层 | `packages/net/src/server-transport.ts` |

改接口时请同步改这份文档：`pnpm docs:check` 会校验文中路径与链接是否还有效。
