# Lobby 集成说明（RDS-Board-Hub ↔ RDS-Board-Core）

平台仓库：[RDS-Board-Hub](https://github.com/RDS-ZH/RDS-Board-Hub)（账号 / 房间大厅 / WebRTC 信令）。

本仓库默认以**中心模式（服务器权威）**运行：权威 `GameRoom` 跑在 Hub 服务端进程里
（`apps/server/src/match.ts`），浏览器只读取自己的投影并提交动作。旧的 P2P 直连
（房主浏览器权威）作为 `authority=p2p` 兼容路径保留，两者共用同一套 URL 参数与消息契约。

## 两种权威位置

| | 中心模式（默认） | P2P（`authority=p2p`） |
|---|---|---|
| 权威引擎 | 服务端进程（`ServerMatch`） | 房主浏览器（`GameRoom`） |
| 客户端数据通道 | 既有 `/ws`（`match-*` 消息） | WebRTC DataChannel |
| 座位来源 | 服务端按大厅玩家顺序下发 | 客户端自报 + hub 座位绑定 |
| 房主掉线 | 不影响对局 | 对局中断（房客进入等待） |
| 需要 `hostId` | 否 | 是（房客要拨号） |

对接文件：`packages/net/src/server-transport.ts`（中心模式）与
`packages/net/src/webrtc-transport.ts`（P2P 兼容）；内核与夹具零改动，`GameRoom`
这层 `RoomTransport` seam 正是为「权威搬进服务端」预留的。

## 启动参数（Hub / 大厅拉起游戏客户端）

```
?game=splendor&hub=wss://host/ws&roomId=r_xxx&token=<jwt>&role=host|guest&authority=server&playerId=p2
```

- `authority` 缺省为 `server`；大厅 `gameQuery()` 现在总是写入 `authority=server`。
- `role` 仅用于 UI 文案（谁是房主）；不再决定权威位置。
- `hostId` 只在 `authority=p2p` 且 `role=guest` 时需要。
- `roster` / `owners`（座位 → 昵称 / hub userId）继续透传，中心模式用于 seats 展示与 presence。
- `seats`（可选）：单机/演示时显式指定桌面人数；联机时以**房间里的真人数量**为准。

### 座位数 = 房间人数（S9 延伸）

桌面只摆真实存在的座位：`MatchBroker` 把 `room.players.length` 作为 `seats` 透传给
`GameRoom` → `UniversalGameEngine` → `module.setup(seed, { seats })`。

- 可变人数夹具（德州扑克 2–10、璀璨宝石 2–4）据此发牌；
- 固定阵容夹具（卡坦岛 3、山屋 3）忽略该参数，`MatchManager` 发现实际座位数与请求不符时
  **拒绝开局**并回 `{ t: 'error' }`（"该玩法需要 3 人"）；大厅 `setRoomStatus` 也会在
  点"开始"时先拦一次，避免出现「回合永远停在无人控制的 p4」这类死局。

## 消息契约（中心模式，走既有 `/ws`）

```
client → server : { t: 'join-room', roomId }        // 信令组（成员资格由 hub 校验）
                  { t: 'match-join', roomId }
                  { t: 'match-submit', action }
                  { t: 'match-snapshot' } | { t: 'match-delta' }
server → client : { t: 'match-seat', roomId, seat }  // 服务器分配的座位
                  { t: 'match-state', roomId, gameId, revision, seats }
                  { t: 'room-update', update }       // 与 rds-room/1 同形（full / patches）
                  { t: 'error', message }
```

`room-update` 与 P2P 的 `RoomUpdate` 完全同形，因此前端消费逻辑（`applyPatch` +
同一套纯视图构建器）两种模式共用，HUD 代码不需要分支。

## 安全

信令身份不可伪造：Hub 转发时强制 `from=JWT userId`。中心模式在此之上额外保证：

- **座位由服务器决定**（大厅玩家顺序 → `p1..pN`），客户端不能自报座位；
- **actor 必须等于自己座位**，否则服务端拒绝且不推进 `revision`；
- **内核控制通道不可达**：`__` 前缀动作（如 `__TICK__`）一律拒绝，逻辑时钟只由服务端推进；
- **投影天然脱敏**：每个连接只拿到 `O(s,i)`，隐藏信息与种子永不出服务器；
- **恶意房主不再成立**：浏览器不持有权威状态，改本地内存无法影响其他玩家。

### 反作弊边界（A1，如实记录）

中心模式把 [BACKLOG.md](BACKLOG.md) §0.2 中「需要独立服务端进程才能抵御恶意房主」的
前提落到了实处：

- ✅ 可防：伪造 actor / 抢座 / 伪造 GAME OVER / 提交非法动作 / 读取隐藏信息 /
  恶意房主改本地状态 / 篡改逻辑时钟 —— 服务端唯一权威 + 座位绑定 + 内核校验；
- ⚠️ 仍不可防：拥有 Hub 服务器 shell 权限者可直接改对局数据（运维边界，非协议问题）。

P2P 兼容路径的旧边界仍然成立（房主是信任对等体），仅在显式 `authority=p2p` 时生效。

## 观测与运维

- `GET /api/rooms/:id/match`：房间成员可查看该房间服务端对局概况（座位 / revision / 在线订阅者）。
- `GET /api/match/stats`：当前托管的对局数量与房间号（不含对局内容）。
- 房间状态置为 `closed` 或房间被清扫回收时，服务端对局（引擎 / 投影缓存 / 时钟定时器）立即释放。
- 逻辑时钟节流由 `MATCH_TICK_MS`（默认 1000ms）控制，且只在存在到期窗口时才推进。

## 验证

- `node scripts/verify-centre-mode.mjs`：真实服务端 + 两条 WebSocket，验证座位分配、
  双端独立投影、伪造 actor / 控制通道拒绝、动作跨客户端传播、房间关闭释放对局。
- `node scripts/verify-centre-mode-browser.mjs`：两个真实浏览器标签页按大厅 URL 契约加入
  同一房间，验证两端渲染、浏览器动作推进**服务端** revision、关掉房主标签页后客机不受影响。
- `node scripts/net-transport.mjs` / `node scripts/net-session.mjs`：P2P 兼容路径回归
  （显式 `authority: 'p2p'`）。
- `node ./node_modules/tsx/dist/cli.mjs apps/server/src/selftest.ts`：服务端单元自检
  （含中心模式座位 / 伪造 / 释放断言）。
