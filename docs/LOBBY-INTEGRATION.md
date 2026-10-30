# Lobby 集成说明（RDS-Board-Hub ↔ RDS-Board-Core）

平台仓库：[RDS-Board-Hub](https://github.com/RDS-ZH/RDS-Board-Hub)（账号 / 房间大厅 / WebRTC 信令）。
本仓库的**唯一对接文件**是 `packages/net/src/webrtc-transport.ts`；内核与夹具零改动。

## 角色

- **Host（房主）**：本仓库前端以常规模式启动，`UniversalSession`（HUD）与权威
  `GameRoom` **共用同一个 `UniversalGameEngine`**（中期项 A2），再挂
  `WebRtcHostTransport` + `startHostMesh`，把 DataChannel 消息桥到 `GameRoom`。
  房主本地操作直接作用于权威状态，`GameRoom.onChange` 统一把各视角 delta 推给房客。
- **Guest**：不创建引擎。用 `WebRtcGuestTransport` 消费自己的投影 `O(s,i)` 并提交动作。

## 启动参数（Hub 拉起游戏客户端）

```
?game=splendor&hub=http://hub.example&roomId=r_xxx&token=<jwt>&role=host|guest&playerId=p2&hostId=u_xxx
```

- `role=host`：正常装配 App（现有 main.ts 流程），完成后 `HubSignaling.connect(roomId)`
  → `startHostMesh` → `WebRtcHostTransport(room, selfId, ...)`。
- `role=guest`：`openGuestChannel(signaling, hostId)` → `WebRtcGuestTransport`；
  UI 侧用 `session.ts` 的 viewer 机制渲染投影（只读动作仍经 host 校验）。

## 安全

- 信令身份不可伪造：Hub 转发时强制 `from=JWT userId`；
- **座位绑定（中期项 A3）**：`NetSessionOptions.seatOwners`（座位 → hub userId）会下发到
  `WebRtcHostTransport`；`join` 时只要该座位有 owner，就只有 owner 的 userId 能加入，
  其他人会收到 `seat is bound to another user`。房间侧 `GameRoom.setAuthorizer` 再校验一次。
  未配置 `seatOwners`（脚本/单机）时保持先到先得。
- 每个信令 peer 只能持有一个 viewer 座位，且每个座位只能被一个 peer 占用；
  `submit` 的 actor 必须等于该 peer 占据的 viewer；非法动作不改变 `revision`。
- 房客自报座位禁止 `GOD` 与 `__` 前缀；`submit` 禁止 `__TICK__` 等内核控制通道。

### 反作弊边界（A1，如实记录）

本仓库按 [BACKLOG.md](BACKLOG.md) §0.2 的确认边界**不构建真实服务端权威引擎**：
对局状态驻留在房主浏览器，房主是**信任对等体**。因此：

- ✅ 可防：房客伪造 actor / 抢座 / 伪造 GAME OVER / 提交非法动作 / 读取隐藏信息 ——
  内核结构校验 + 合法性校验 + `GameRoom` 投影 `O(s,i)` + 座位/actor 绑定；
- ⚠️ 不可防：**恶意房主**可以改本地状态、偷看全量状态或直接编造结果；
- 若要抵御恶意房主，必须把 `GameRoom` 部署为独立服务端进程（`RoomTransport` seam 已就绪），
  属于后续 RFC，不在当前范围。

## 验证

- `node scripts/net-transport.mjs`：用内存环回通道跑 Host↔Guest 全流程
  （join → 各自投影 → guest submit → 双端 revision 一致 → 隐藏信息不泄露）。
- 真实 P2P（Chromium 双页 Playwright + 本地 Hub）在 M2 验收时补充。
