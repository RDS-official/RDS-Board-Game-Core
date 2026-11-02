# 架构审查报告 · 2026-11

> **审查方式**：全部结论来自对源码的直接阅读（`packages/*`、`apps/*`、根配置与脚本），**未把 README / docs 中的自我描述当作判断依据**。代码注释被当作"作者意图声明"对照实现验证，凡注释与实现不一致处均已标注。
>
> **审查范围**：约 7.9 万行 TS/CSS（不含资源），409 个文件。静态分析 + 逐模块通读。**未执行构建与测试**（审查环境无 node/pnpm），也未做规则正确性验证（如卡坦最长路、山屋 50 个 haunt 分支、德扑边池计算需要实际对局才能验证）。
>
> **配套文档**：
> - [KERNEL-CHARTER.md](KERNEL-CHARTER.md) —— 九元组可执行化宪章（架构改造的设计基准）
> - [ARCHITECTURE-ISSUES.md](ARCHITECTURE-ISSUES.md) —— 存量问题台账（本文档已把审查结论合并进该文件）

---

## 目录

- [0. 结论与评分](#0-结论与评分)
- [1. 代码测绘](#1-代码测绘)
- [2. 架构剖析](#2-架构剖析)
- [3. 架构优点](#3-架构优点)
- [4. 问题清单](#4-问题清单)
  - [S0 · 正确性 / 安全致命](#s0--正确性--安全致命)
  - [S1 · 严重](#s1--严重)
  - [S2 · 中等](#s2--中等)
  - [S3 · 工程债](#s3--工程债)
  - [M · 多模组形式化失效](#m--多模组形式化失效)
- [5. 分层与依赖纪律](#5-分层与依赖纪律)
- [6. 数据与协议演进](#6-数据与协议演进)
- [7. 性能与可伸缩性](#7-性能与可伸缩性)
- [8. 安全专项](#8-安全专项)
- [9. 可测试性与可维护性](#9-可测试性与可维护性)
- [10. 修改建议与实施路线](#10-修改建议与实施路线)
- [附录 A · 最小可行修复（一周内）](#附录-a--最小可行修复一周内)
- [附录 B · 审查复现命令](#附录-b--审查复现命令)

---

## 0. 结论与评分

这不是一个"桌游实现"，而是一个**通用博弈运行时**：形式化状态机 + 规则插件 + 正交投影 + 事件溯源回放，承载 7 个规则差异极大的游戏，同时提供单机 / P2P / 中心模式三种权威形态，外加 3D 物理桌面。

**内核是可打磨成范式的设计；游戏夹具在信息隔离与规则可校验性上有洞；服务端与持久化停留在"能跑不能扩"；前端渲染是"能看不能扛"。**

| 维度 | 评分 | 说明 |
| --- | --- | --- |
| 架构愿景与抽象质量 | **A** | 形式化状态、AOP 钩子、认知投影、LIFO 续延、传输无关房间——抽象选得准且真的落地了 |
| 分层纪律 | **A−** | CI 机械守护 import 边界，实测无违规；扣分在"同一概念多处实现" |
| 内核实现质量 | **B+** | 管线严谨、错误路径覆盖好；扣分在 invariant 盲区、隐式上限、canonicalize 性能税、平台纯净性未达成 |
| 游戏规则实现 | **B−** | 7 个游戏覆盖度惊人；扣分在 AI 信息越权、`custom` 逃逸口、规则状态不可校验 |
| 服务端与持久化 | **C+** | 安全细节到位，但存储与并发模型无法横向扩展，账本无事务 |
| 前端渲染 | **C** | 3D 表现力强，但每次动作全量重建场景 + 巨型文件 + 65 处 `innerHTML` |
| 可测试性 | **A−** | 20 个 suite、门禁体系成熟；扣分在缺 property-based 与内核语义断言 |
| 可维护性 | **C+** | 巨型文件、注释双轨、50 个脚本、单 `package.json` 冒充 monorepo |
| 安全性 | **B−** | 基本功扎实，但中心模式别名密钥缺失与 token 存放方式是硬伤 |
| **综合** | **B+** | |

**真正的资产**：`packages/kernel` 的转移管线 + 投影管线 + 回放闭环，以及 CI 里的 import 边界断言。这两样可以被抽象成方法论复用。
**真正需要重写的不是内核**，而是服务端的运行时状态模型（单进程内存 + 全量 JSON 写）与渲染层的更新策略（全量重建）。

---

## 1. 代码测绘

```
根目录（单 package.json，无 pnpm workspace —— 见 S3-1）
├─ packages/kernel/src        5,685 行  形式化内核
│   engine / aop / rules / decisions / stack / observer / graph / ecs /
│   occupancy / placement / rollWindow / expansions / invariants /
│   serialize / sha256 / prng / validation / module / types
├─ packages/games/src        ~16,000 行 游戏夹具（catan / splendor / betrayal /
│   poker / sanguosha / dune_mahjong + registry）
├─ packages/app/src           5,237 行  呈现适配（session / netSession / contracts /
│   inspect / actionText / observers / layout）
├─ packages/net/src           1,081 行  房间与传输（room / patch / webrtc / server-transport）
├─ packages/room-protocol/src   ~90 行  共享协议 DTO（rds-room/1）
├─ apps/server/src            3,291 行  Hub（Hono + ws）
└─ apps/web/src              ~16,650 行  Three.js 渲染 + HUD + 大厅 + 后台
```

真实依赖方向（源码 import 实测）：

```
apps/web ──► packages/app ──► packages/kernel ◄── packages/net
    │                                                    ▲
    └────────────────────────────────────────────────────┘
apps/server ──► packages/games ──► packages/kernel
            └──► packages/net(GameRoom) + packages/room-protocol
```

`scripts/test-core.mjs` 中的**源码级 import 断言**（UI 不得 import kernel/games/net/render；app 不得 import web/render；kernel 不得 import 任何 `@rds/*`）是全仓最强的架构治理手段。

---

## 2. 架构剖析

### 2.1 状态模型

`GameState`（`packages/kernel/src/types.ts`）是纯 JSON：players / npcs / entities / zones / mapGraph / interruptStack / pendingDecisions / activeHooks / effects / rollWindows / prngState / actionLog / clock / seq。

`serialize.ts` 的 `canonicalize` 强制 key 排序、拒绝函数 / 循环引用 / 非有限数——设计正确，是回放可复现的前提。

`activeHooks` 只存 `{hookId, params}` 描述符，实现放在 `RuleRegistry`：**规则逻辑不进状态**，正确。

**但** `globalVars / customProps / components.custom` 三个 `Record<string, any>` 是全仓唯一的任意形状落点，实测 47 个活跃 key 无一被内核认识（详见 [KERNEL-CHARTER.md §1.2](KERNEL-CHARTER.md)）。

### 2.2 转移管线

`packages/kernel/src/engine.ts` 的 `run()` 顺序，每个分支都判定"谁有权在此时行动"：

```
gameOver → __TICK__ 旁路 → actor 存在性 → NPC 控制权 → action shape →
payload 语义 → 开放决策窗口 → 响应窗口 → 严格合法性 → applyCore
```

`reduceWithPipeline` 用**显式 LIFO 工作栈**代替递归，配 `maxFollowUpActions=256` / `maxFollowUpDepth=64` 预算，遇输入窗口时 `parkContinuation` 挂起、窗口结算后 `resumeFollowUpQueue` 恢复。**这是全仓最有价值的架构决策**：把安全上限变成显式预算，把"半结算"状态也纳入回放。

### 2.3 规则钩子（AOP）

`aop.ts` 三阶段洋葱（`FILTER_MODIFY → BEFORE_REPLACE → AFTER_TRIGGER`），`RuleRegistry.order()` 做依赖拓扑排序 + priority 降序，`safePredicate / safeHandler` 用 try/catch 把规则异常降级为"跳过 + 记消息"。

设计正确，但**静默吞异常**在生产 strict 模式下等于"规则静默失效"，比崩溃更难排查（见 S2-6）。

### 2.4 信息投影

`CognitiveObserver.projectState` 是全仓第二大亮点：不可见实体不下发原始 components、换 viewer 维度虚拟 id、zone 列表同步重映射、秘密决策折叠为 `COMMITTED`、`actionLog` 剥掉 payload、`legalActions` 与 selection scope 按可见性裁剪。

`net/room.ts` 的 delta 在**已脱敏投影**上做 diff，保证隐藏信息不出现在 patch 里。

**致命缺口**：`aliasSecret` 只在 P2P 房主侧设置（`packages/app/src/netSession.ts:221`），`apps/server/src` 无任何 `setAliasSecret` 调用 —— 中心模式用 FNV-1a 32 位无盐别名（`packages/kernel/src/observer.ts:45` 的 else 分支），可被枚举还原（见 S0-1）。

### 2.5 确定性、回放与哈希

PRNG 用 mulberry32，`roll / shuffle` 纯函数返回 `nextSeed`。哈希用 FNV-1a 64；别名用自研 SHA-256 / HMAC（`kernel/src/sha256.ts`，为让 kernel 不依赖 `node:crypto`）。

`loadLog` 做 moduleId + schemaVersion + engineVersion 三重校验，**版本不一致直接拒绝而非自动迁移**——成熟的事件溯源做法。

问题：`exportLog()` 实现为 `replayState(this.history).state`，每次导出全量重放（见 S2-8）。

### 2.6 呈现与渲染

`packages/app` 的 `GamePresenter` / `GameSnapshot` / `Ui*` DTO + 纯函数 builder（`buildPlayersView / buildActionsView / buildDecisionView / buildStackView / buildHooksView / buildPlacementView / buildNpcsView`），配 `GameModule.presentation` 把游戏特有词汇声明成纯函数 —— **正确的"呈现即投影"设计**。

但 `session.ts`（2244 行）已成 God Object，`netSession.ts`（1302 行）复制了其中相当一部分；`hud.ts` 3216 行、`scene.ts` 4954 行、`styles.css` 5427 行。

### 2.7 网络与权威位置

三种权威形态共用 `RoomUpdate`（`full` + `patches`）消费逻辑，`netSession` 与 P2P 复用同一 presenter —— `RoomTransport` 抽象正确。

中心模式：服务器持唯一 `GameRoom`，座位由服务器按大厅玩家顺序分配，`submit` 强制 `actor === seat`、拒绝 `__` 前缀与 `driverActions`。边界干净，但 `fundSeats → new ServerMatch → refundBuyIns` 是**无事务的补偿事务**（见 S1-6）。

### 2.8 服务端

Hono + 原生 `ws`。手写 JWT（HS256）+ `tokenEpoch` 吊销 + scrypt 口令，安全细节比很多"上了框架"的项目更克制（`signals.ts` 的长度先比、`clientIp` 的 loopback 判定 XFF、生产缺 `HUB_SECRET` 拒启、昵称白名单）。

但持久化是"全量 JSON 同步写"，认证态存 localStorage（见 S1-2 / S0-3）。

---

## 3. 架构优点

1. **内核边界清晰且被 CI 机械守护**（源码级 import 断言）。
2. **状态纯 JSON + 序列化-回放-哈希闭环**，版本拒绝而非静默迁移。
3. **LIFO 显式工作栈 + 挂起续延**，是整份代码最专业的抽象。
4. **AOP 规则钩子 + 依赖 DAG 拓扑排序**，横切规则与 reducer 解耦。
5. **认知投影作为唯一出网通道**，delta 在脱敏投影上做 diff。
6. **传输无关的房间端口**（`RoomTransport`），三种权威形态共用 presenter。
7. **呈现声明化**（`GameModule.presentation` 一组纯函数），通用 UI 零 game-id 分支。
8. **不变量检查 + strict 模式**、`ENGINE_VERSION` / `schemaVersion` 双版本门禁。
9. **服务端安全细节到位**（timingSafeEqual、tokenEpoch、loopback XFF 判定、生产密钥强校验、头像 magic-byte + 文件名白名单）。
10. **自研零依赖 SHA-256 / HMAC** 以满足 kernel 平台纯净性目标。

---

## 4. 问题清单

> 严重度：**S0** 正确性 / 安全致命 → **S1** 严重 → **S2** 中等 → **S3** 工程债 → **M** 多模组形式化失效。
> 每条给出：证据（文件:行）、影响、修复建议（R-x 编号与 [ARCHITECTURE-ISSUES.md](ARCHITECTURE-ISSUES.md) 的风险台账一一对应）。

### S0 · 正确性 / 安全致命

#### S0-1 中心模式虚拟别名未加密钥，反作弊核心失效

- **证据**：`packages/kernel/src/observer.ts` 的 `getVirtualAlias()`（无密钥分支在 53-59 行），`aliasSecret` 缺省时退化为 FNV-1a 32 位；`packages/app/src/netSession.ts:221` 是**唯一**调用 `engine.setAliasSecret` 的地方且只在 P2P 房主侧；`apps/server/src/match.ts:110` 构造 `GameRoom` 时未设置。
- **影响**：服务端权威模式（默认 `authority:'server'`）下隐藏实体 id 可被字典穷举还原 → 看清对手手牌 / 牌库 / 未探索房间。
- **修复**：`ServerMatch` 构造后 `this.room.engine.setAliasSecret(crypto.randomBytes(32).toString('hex'))`；补一条"中心模式别名必须是 HMAC 形式"的回归测试。

#### S0-2 德扑 AI 从权威状态决策

- **证据**：`packages/games/src/poker/rules.ts:478` `choosePokerAction(state, playerId)` 传入 raw `GameState`；`packages/games/src/poker/ai.ts:44` `strengthOf(state, playerId)` 同样读 raw state。
- **影响**：AI 与真人客户端不在同一信息通道；当前实现"恰好"只读自己底牌，但结构上可以读到对手筹码、牌堆顺序、待发牌。
- **修复**：AI 入参改为 `ProjectedGameState`；补"AI 可见信息 ⊆ 投影信息"断言。

#### S0-3 认证态存 localStorage + Bearer，变更接口无 CSRF / Origin 防护

- **证据**：`apps/web/src/lobby/lobby.ts:749` `localStorage.setItem('token', ...)`；`apps/web/src/lobby/api.ts:3`；`apps/server/src/index.ts` 的 `/api/rooms/:id/{join,status,ready,kick,host,ai}` 全部只校验 Bearer。
- **影响**：XSS 一次即账号长期失守（7 天有效）；token 还会被写进地址栏（`lobby.ts:1062` `gameQuery` 的 `q.set('token', ...)`），进入浏览器历史与 Referer。
- **修复**：短期给 `/api/*` 变更接口加 `Sec-Fetch-Site` / `Origin` 白名单；中期换 `HttpOnly; Secure; SameSite=Lax` cookie + 双提交 CSRF；token 移出 URL（改一次性 ticket + postMessage）。

### S1 · 严重

#### S1-1 内核 / 游戏层与 Node 平台耦合

- **证据**：`tsconfig.json` 的 `paths` 用绝对路径（`tsconfig.json`）；`packages/games/src/splendor/pokemonData.json`（2777 行资源）内嵌进包；`apps/server/src/storage.ts` / `config.ts` 的 `node:fs` / `process.env` 经由 registry 反向侵入 games 包。
- **影响**："内核平台纯净"叙事不成立；未来复用到 Worker / 浏览器 / 多进程需大改。
- **修复**：kernel 只允许 `import type` + 自研纯函数；资源数据外置 `data/` 并在 setup 注入；`tsconfig` 改相对 paths 或为各包独立声明 `package.json`。

#### S1-2 持久化是全量 JSON 同步写，且用户与房间共用一份文件

- **证据**：`apps/server/src/storage.ts` 每个 `users.update` / `rooms.update` 都 `save()` → `JSON.stringify` 整个 `{users, rooms}` → `writeFileSync` 临时文件 + rename。
- **影响**：O(用户数 + 房间数) 写放大；事件循环上同步写；多实例必互相覆盖（`ecosystem.config.cjs` 写死 `instances:1`，是用部署约束掩盖架构缺陷）。
- **修复**：SQLite（`better-sqlite3` 或 `node:sqlite`）单表 upsert；或先拆 `users.json` / `rooms.json` + 异步写队列 + fsync + 备份轮转。长期 Postgres。

#### S1-3 `hub.json` 损坏即 `process.exit(1)`

- **证据**：`apps/server/src/storage.ts` 的 `load()` catch 分支 `process.exit(1)`。
- **影响**：一个字节损坏 = 服务不可启动，无只读降级路径。
- **修复**：备份后进入只读模式提供健康检查与恢复入口；用 WAL / 原子写保证不会出现半截 JSON。

#### S1-4 登录限速非原子 + `scryptSync` 阻塞事件循环

- **证据**：`apps/server/src/index.ts` 的 `loginFails`：读 `count` → `login()`（内含 `scryptSync`）→ 写回；`diagnosticsHits` / `DIAG_FINGERPRINTS` 同样无界。
- **影响**：`scryptSync` 每次 ~100ms 级 CPU 阻塞，并发登录即可打满单核（CPU DoS）；限速表在并发下可被绕过。
- **修复**：`crypto.scrypt` 异步版；限速改令牌桶 + LRU（或 Redis）；登录路径加 Per-IP 并发闸。

#### S1-5 `ServerMatch` 直接改写权威状态

- **证据**：`apps/server/src/match.ts:155` 构造后直接 `target.name = ...` / `target.avatarUrl = ...`。
- **影响**："展示数据"与"规则状态"共用一份状态树，绕过 reducer 后 `assignment` 无法回放。
- **修复**：昵称 / 头像走 `state.globalVars.roster` 或独立的 `presentationOverlay`，在投影阶段合成。

#### S1-6 扑克账本无事务

- **证据**：`apps/server/src/match.ts` 的 `MatchManager.ensure` → `fundSeats`（`takeSeat` 扣款）→ `new ServerMatch` → catch `refundBuyIns`；`dispose()` 里 `refundTableStakes()`。
- **影响**：崩溃 / 异常退出路径下账本不平；AI 救济金与买入同表，容易出现"AI 无限救济"。
- **修复**：append-only ledger + 幂等 key（roomId + seat + handNo + kind），启动时对账；余额是派生值。

### S2 · 中等

| ID | 问题 | 证据 | 修复 |
| --- | --- | --- | --- |
| S2-1 | 内核 invariant 对 `custom/globalVars` 全盲，61 条检查码全是结构一致性 | `packages/kernel/src/invariants.ts` | 增加 `GameModule.checkInvariants?`（宪章 C-6） |
| S2-2 | `advanceClock` 有未文档化的 16 次级联上限，超限静默退出 | `packages/kernel/src/engine.ts` 的 `for (guard = 0; guard < 16; guard++)` | 改可配置预算 + 超限 `fail()` + 结构化事件 |
| S2-3 | `exportLog()` 每次全量重放只为取 head hash | `packages/kernel/src/engine.ts` 的 `exportLog()` | 直接 `hashState(this.state)`；每 50 步存检查点 |
| S2-4 | `replayTo` 无检查点，时间机器是 O(N) | 同上 | 同上 |
| S2-5 | 动作合法性每次都全量 `canonicalize` 比较 | `packages/kernel/src/engine.ts` 的 `isLegal()` | 结构化比较先做 O(1) 索引，深比较仅兜底 |
| S2-6 | 钩子 handler 异常被静默吞掉，strict 下规则静默失效 | `packages/kernel/src/aop.ts` 的 `safeHandler()` | strict 模式升级为 dispatch 失败 |
| S2-7 | `GameRoom.setCurrentViewer` 用可变字段传参（隐式并发） | `packages/net/src/room.ts` 的 `submit()` + `apps/server/src/match.ts` 的 `submit()` | `submit(action, viewer)` 显式传参 |
| S2-8 | 投影对 players / npcs / effects 做 `JSON.parse(JSON.stringify())` 深拷贝 | `packages/kernel/src/observer.ts` 的 `projectState()` | 结构化共享 + 只拷脱敏字段 |
| S2-9 | 座位数推导有 3 份实现 | `apps/server/src/rooms.ts` 的 `fixtureSeats()` / `seatsSupport()`、`apps/server/src/match.ts` 的 `ServerMatch`、`packages/app/src/netSession.ts` | `meta.seatRange` 声明式契约（宪章 C-9 的兄弟条款） |
| S2-10 | 渲染层每次动作全量重建 3D 场景 | `apps/web/src/render/scene.ts` 的 `syncState()` 的 `boardKey = actionLog.length` | 按实体 id 增量 reconcile |
| S2-11 | HUD / UI 65 处 `innerHTML`，转义函数复制 4 份 | `hud.ts` / `lobby.ts` / `admin.ts` / `main.ts` 各一份 `esc*` | 抽 `html` tagged-template，CI grep 禁止裸 `innerHTML =` |
| S2-12 | `session.ts` God Object（`rebuild()` 一个函数做 7 件事） | `packages/app/src/session.ts` 的 `rebuild()`（约 1091 行） | 拆分为纯 builder 库 + 薄壳 |
| S2-13 | `patch` 协议声明 `move/copy/test` 但只用 `add/remove/replace` | `packages/room-protocol/src/index.ts` vs `packages/net/src/patch.ts` | 协议收敛到实现子集，或补齐实现 |
| S2-14 | 客户端不校验 `baseRevision`，乱序 delta 会静默打错基线 | `packages/net/src/server-transport.ts` | 校验 `baseRevision === this.revision`，否则请求快照 |
| S2-15 | 应用层重复实现"是否需要 tick" | `apps/server/src/match.ts` 的 `needsClock()` vs `engine.stampDeadlines` | 内核暴露 `needsClock()`，驱动方只读 |
| S2-16 | 单一 `setInterval` per 对局（tick + AI pump） | `apps/server/src/match.ts` 的 `startClock()` / `startAiPump()` | 全局时间轮 + 单一定时器 |
| S2-17 | 每帧每快照调用 `presentation.describeMoment/cardFacts` | `packages/app/src/session.ts` 的 `rebuild()` | 按 revision memo |

### S3 · 工程债

| ID | 问题 | 证据 | 修复 |
| --- | --- | --- | --- |
| S3-1 | 单 `package.json` 冒充 monorepo，无 workspace、无包级依赖声明 | `find -name package.json` 只有根 | `pnpm-workspace.yaml` + 每包 `package.json` |
| S3-2 | 包名拼写错误 | `package.json` `"name": "borad_game"` | 改 `rds-board-core` |
| S3-3 | `lucide` 依赖未使用 | 全仓无 import | 删除 |
| S3-4 | 构建期执行 `git` 且失败回退**硬编码贡献者列表** | `vite.config.ts` | 移到构建脚本产物；回退显式 "unknown" |
| S3-5 | `HUB_SECRET` / `ADMIN_PASSWORD` 在多处有弱默认值 | `ecosystem.config.cjs`、`Dockerfile`、`apps/server/src/config.ts`、`.env.example` | 生产无默认值，硬拒启 |
| S3-6 | `.env.example` 写了真实可用默认口令 | `.env.example` `ADMIN_PASSWORD=kgnb666` | 只写占位符 |
| S3-7 | 自检脚本断言默认口令可登录 | `apps/server/src/selftest.ts` | 用随机生成口令自检 |
| S3-8 | `SignalHub` 顶掉旧连接时不清理 `MatchBroker` 订阅 | `apps/server/src/signal.ts` + `matchBroker.attach` | 统一 `ConnectionRegistry` 管理生命周期 |
| S3-9 | 诊断指纹全局共享而非按 IP 分桶，`includes` O(128) | `apps/server/src/index.ts` 的 `DIAG_FINGERPRINTS` | Map + 分桶 |
| S3-10 | 扑克排行未鉴权即可枚举账号昵称 | `apps/server/src/index.ts` 的 `/api/poker/leaderboard` | 加登录要求或分页脱敏 |
| S3-11 | 中心模式下仍生成 `hostSeed` / `aliasSecret`，并 bootstrap 固定 seed=42 占位引擎 | `packages/app/src/netSession.ts:193-245` | 分支收敛，删死代码 |
| S3-12 | 50 个脚本，`probe/verify/shoot/test` 四套前缀职责重叠 | `scripts/` | 收敛为统一 CLI（`pnpm qa --gate=...`） |
| S3-13 | 大量显式 `any`：server 56 / web 49 / games 29 / app 21 | `rg '\bany\b'` 统计 | `noExplicitAny` 从 warn 升 error，逐包清零 |
| S3-14 | CSS 5427 行且关闭了 `noDescendingSpecificity` / `noImportantStyles` | `biome.json` | 至少 `tokens/*.css` 保留检查 |
| S3-15 | 大厅可达游戏 5 个，`GAME_REGISTRY` 有 6 个（`dune_mahjong` 未上架） | `packages/games/src/registry.ts` vs `apps/server/src/games.ts` | 由 registry 生成 `GAMES` 清单 |
| S3-16 | 注释密度极高且混入历史决策记录（"审查报告 Sx / AI-xx"），代码与注释双轨 | 全仓 | 历史决策迁到本文件 / `ARCHITECTURE-ISSUES.md`，代码只留"为什么" |

### M · 多模组形式化失效

> 完整论证见 [KERNEL-CHARTER.md](KERNEL-CHARTER.md)。此处只列结论与措施。

#### M-1 只有 1/6 模组用全了内核原语

内核五类原语（决策窗口 / 中断栈 / 掷骰窗 / effects / 钩子）的使用率：`betrayal` 全用，其余模组大面积闲置，规则逻辑下沉到 47 个 `globalVars` key 与 `components.custom`。

**措施**：引入 `meta.stateSchema` 登记 key 集合 + CI 输出使用率矩阵（宪章 C-9、阶段 0）。

#### M-2 `𝒯` 是万能函数，单步转移假设被打破

`reduce` 一次调用可含 8~64 次逻辑转移（`packages/games/src/poker/rules.ts:605` 调 `advanceAi`，其内 `for` 上限 64；同文件 `settle()` 的 `for` 上限 8）。合法性校验、中断拦截、审计日志的粒度全部失效。

**措施**：宪章 C-2（单步转移）+ 阶段 2 引入 `transition(state, actions[], ctx)`。

#### M-3 并发被降维成串行

`Action` 是单 actor，决策窗口结算时串行 `reduce`（`packages/kernel/src/engine.ts` 的 `resolveOpenDecision()`）。德扑边池、卡坦竞标、山屋投票全部表现为顺序敏感。

**措施**：宪章 C-3，新增 `SIMULTANEOUS` 决策策略。

#### M-4 随机源未被收口

模组可绕过 `ctx.roll()` 直接调 `DeterministicPRNG.shuffle(seed + ...)`（`packages/games/src/betrayal/helpers.ts` 的 `drawRoomCandidate()`）或自写哈希（`packages/games/src/poker/ai.ts` 的 `noise()`）。

**措施**：宪章 C-4，`reduce` 不再注入 PRNG 静态方法。

#### M-5 `ℛ` 与 `𝒯` 完全耦合

收益在转移内部写死（`poker/rules.ts` `setChips`、`catan/rules.ts` 建造加分），`outcome()` 只能事后反推，无法回答"哪条规则给了这一分"。

**措施**：宪章 C-7，`ctx.reward()` + `state.rewards`。

#### M-6 `capabilities` 声明无人读取

`simultaneousMoves / hiddenInformation / interruptStack / dynamicRules` 在全仓只被 `apps/web/src/ui/mathInspector.ts:329-332` 读来做 UI 标签。

**措施**：要么让内核真正消费（用于调度 / 校验分支），要么从 `GameMeta` 移除，改为纯展示字段放到 `presentation`。

#### M-7 钩子机制被绕开

`sanguosha/hooks.ts` 的 `bagua_armor` handler 只返回一句提示，真正的判定手写在 `rules.ts` 的 `JUDGE_BAGUA` 分支里。

**措施**：宪章 C-8（`𝒦` 分区）+ 阶段 3 把 haunt / 技能改造成声明式规则表 + 通用解释器。

---

## 5. 分层与依赖纪律

| 层 | 边界声明 | 实际执行 | 评价 |
| --- | --- | --- | --- |
| kernel | 不得 import 任何 `@rds/*` | CI 断言 + 实测无 import | ✅ 优秀（平台纯净性另见 S1-1） |
| games | 只依赖 kernel | 实测符合 | ✅ 好 |
| app | 不依赖 web/render | CI 断言 | ✅ 好（God Object 见 S2-12） |
| net | 不依赖 app | 实测无 | ✅ 好 |
| web/ui | 不依赖 kernel/games/net/render | CI 断言 | ✅ 好（innerHTML 见 S2-11） |
| server | 依赖 games/net/protocol | 实测符合 | ⚠️ 座位数推导重复（S2-9） |

**真正的风险不在"谁 import 谁"，而在"同一概念有多个实现"**：座位数（3 处）、是否需要 tick（2 处）、权威状态与展示状态共用树（2 处）、转义函数（4 处）、`esc / escText / escHtml`（3 处）。

---

## 6. 数据与协议演进

- `ENGINE_VERSION=3` + `schemaVersion` 双门禁，日志**拒绝而非迁移**。对可复现性是正确取舍，但意味着每次规则语义变更都会让历史日志不可用。当前无 `migrations/`，也无"按版本分派 reducer"的能力。
- `room-protocol` 的 `PatchOp` 声明了 `move/copy/test`，`net/patch.ts` 只实现三种（S2-13）。
- `diffJson` 对数组整体替换；根节点 `'/'` 的 replace 语义靠巧合与 `applyPatch` 对上，无显式契约。
- `RoomUpdate.baseRevision` 在客户端未被用于乱序检测（S2-14）。

**建议**：`engineVersion → module 版本 → reducer 实现表` 三级分派，让老日志可读；协议收敛到实现子集并在 CI 里做类型-实现一致性校验。

---

## 7. 性能与可伸缩性

| 热点 | 成本 | 频率 | 建议 |
| --- | --- | --- | --- |
| `syncState` 全量重建场景 | 高 | 每次动作 | 增量 reconcile（S2-10） |
| 每座位投影 + JSON 深拷贝 | 中 | 每次 revision × 座位数 | 结构化共享（S2-8） |
| `isLegal` 全量 canonicalize | 中 | 每次 dispatch | 索引化（S2-5） |
| `exportLog` 全量重放 | 高 | 每次导出 | 检查点（S2-3） |
| `hub.json` 全量写 | 中 | 每次变更 | SQLite（S1-2） |
| `scryptSync` 阻塞 | 高 | 每次登录 | 异步 scrypt（S1-4） |
| `setInterval` per 对局 | 低但线性 | 持续 | 时间轮（S2-16） |

**可伸缩性结论**：当前是**单进程、单实例、内存态**（`matches` / `clients` / `loginFails` / `aliasCache` 全在进程内）。多副本的前置条件是先把「对局状态、订阅关系、限速、账本」四类内存态外置——这是一次专项工程，不是小改。

---

## 8. 安全专项

**已做对的**：手写 JWT 的长度先比 + `timingSafeEqual`；`tokenEpoch` 吊销；scrypt 加盐；生产缺 `HUB_SECRET` 拒启；`X-Forwarded-For` 仅 loopback 信任；昵称白名单；头像 magic-byte + 大小上限 + 文件名校验；WS 入组校验成员资格；`maxPayload: 128KB`；`submit` 强制 `actor === seat` 且拒绝 `__` / `driverActions`。

**风险**：

| 风险 | 见 | 影响 | 修复 |
| --- | --- | --- | --- |
| localStorage token + URL 传递 + 无 CSRF | S0-3 | XSS 一次长期失守 | HttpOnly cookie + CSRF + ticket |
| 中心模式别名可反查 | S0-1 | 隐藏信息泄露 | `setAliasSecret` |
| AI 用 raw state 决策 | S0-2 / M-6 | 规则不公平 | 投影化 AI 输入 |
| 弱默认口令 | S3-5/6/7 | 部署即被接管 | 无默认值，硬拒启 |
| 登录 CPU DoS | S1-4 | 单核打满 | 异步 scrypt + 并发闸 |
| 扑克排行账号枚举 | S3-10 | 中 | 需登录 |
| 错误信息回显细节 | `ServerMatch.submit` 返回 `actor does not match viewer: xxx` | 低 | 生产脱敏 |

---

## 9. 可测试性与可维护性

**可测试性（强）**：`packages/harness` 20 个 suite（约 6000 行）；`scripts/lib/gates.mjs` 做时间 / 内存门禁；`scripts/verify.mjs` 按 diff 选门禁；`apps/server/src/selftest.ts` 用 `HUB_DATA_DIR` 临时目录隔离；`net/room.ts` 提供 `applyClientDelta` 供测试模拟客户端。

**可维护性（弱）**：巨型文件（`scene.ts` 4954 / `styles.css` 5427 / `hud.ts` 3216 / `betrayal/rules.ts` 3586 / `session.ts` 2244 / `cardMesh.ts` 2223 / `betrayal/cards.ts` 1872）；注释双轨（S3-16）；50 个脚本无统一入口；无 `CHANGELOG` / 迁移记录，`ENGINE_VERSION` 靠手改。

---

## 10. 修改建议与实施路线

### 10.1 短期（1–2 周，止血）

| 序 | 项 | 对应 | 工作量 |
| --- | --- | --- | --- |
| 1 | 中心模式设置 `aliasSecret` | S0-1 | 5 行 + 1 测试 |
| 2 | AI 决策改为投影输入 | S0-2 | 1 个函数改造 + 断言 |
| 3 | `/api/*` 变更接口加 `Sec-Fetch-Site` / Origin 白名单 | S0-3 | 1 中间件 |
| 4 | token 移出 URL 查询串 | S0-3 | 大厅 + 入口路由 |
| 5 | 删除所有默认口令，生产缺配置硬拒启 | S3-5/6/7 | 配置层 |
| 6 | `scryptSync → scrypt`，限速表改 LRU + 并发闸 | S1-4 | 1 天 |
| 7 | `advanceClock` 的 16 次上限改为显式错误 | S2-2 | 半天 |

### 10.2 中期（1–2 月，结构）

| 序 | 项 | 对应 |
| --- | --- | --- |
| 8 | 渲染层增量 reconcile（`syncState` 按 key diff） | S2-10 |
| 9 | 抽 `html` 模板标签替换 65 处 `innerHTML` | S2-11 |
| 10 | 回放检查点 + `exportLog` 不再重放 | S2-3 / S2-4 |
| 11 | SQLite 单表 upsert + 只读降级恢复 | S1-2 / S1-3 |
| 12 | `meta.seatRange` 声明式契约，消除三处座位推导 | S2-9 |
| 13 | `GameRoom.submit(action, viewer)` 显式传参 | S2-7 |
| 14 | 真正 monorepo 化（workspace + 包级 package.json + 相对 paths） | S3-1 |
| 15 | 落地宪章阶段 0 / 阶段 1（度量 + C-5 + C-6） | M-1 / M-4 / S2-1 |

### 10.3 长期（1 季度 +，架构）

| 序 | 项 | 对应 |
| --- | --- | --- |
| 16 | 运行时状态外置（对局 / 订阅 / 限速 / 账本），支持多副本 | §7 |
| 17 | 落地宪章阶段 2（`transition(state, actions[])`、删除内联 AI 推进） | M-2 / M-3 |
| 18 | 落地宪章阶段 3（`ctx.reward()` + `𝒦` 分区） | M-5 / M-7 |
| 19 | 内核可验证化：`checkInvariants` + property-based 随机对局测试 | S2-1 / §9 |
| 20 | 规则版本分派（老日志可读），把"拒绝而非迁移"升级为"可重放的历史" | §6 |
| 21 | AI 公平性变成内核级约束（`dispatch` 校验动作引用的实体在 `𝒪(s, actor)` 中可见） | M-6 |

### 10.4 若只能做三件事

按 ROI 排序：

1. **补 `aliasSecret` + AI 投影化**（一天，堵住两个安全 / 公平性洞）。
2. **渲染增量 reconcile**（体验与性能双赢，且是 HUD 抖动的根因之一）。
3. **存储换 SQLite + 幂等账本**（为多副本铺路）。

---

## 附录 A · 最小可行修复（一周内）

以下改动都很小，但每一条都直接关闭一个 S0 / S1：

**A-1 中心模式别名密钥**（`apps/server/src/match.ts`，构造 `GameRoom` 之后）

```ts
// 中心模式：别名必须用每房间随机密钥做 HMAC，否则 32 位 FNV 别名可被穷举反查
this.room.engine.setAliasSecret(crypto.randomBytes(32).toString('hex'));
```

**A-2 AI 只吃投影**（`packages/games/src/poker/rules.ts` 的 AI 分支）

```ts
// 现状：choosePokerAction(state, playerId)
// 改为：先投影，再决策——AI 与真人客户端因此走同一条信息通道
const view = CognitiveObserver.projectState(state, playerId);
const decided = choosePokerAction(view, playerId);
```

**A-3 变更接口的 Origin 闸**（`apps/server/src/index.ts`）

```ts
app.use('/api/*', async (c, next) => {
  if (c.req.method !== 'GET') {
    const site = c.req.header('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') {
      return c.json({ error: 'cross-site request rejected' }, 403);
    }
  }
  await next();
});
```

**A-4 生产密钥硬拒启**（`apps/server/src/config.ts`）

```ts
function adminPassword(): string {
  if (env.ADMIN_PASSWORD) return env.ADMIN_PASSWORD;
  if (env.NODE_ENV === 'production') {
    throw new Error('[hub] 生产环境必须通过 ADMIN_PASSWORD 提供初始管理员口令');
  }
  return 'dev-only-password';
}
```

**A-5 tick 上限显式化**（`packages/kernel/src/engine.ts` 的 `advanceClock()`）

```ts
for (let guard = 0; guard < MAX_CLOCK_CASCADE; guard++) { /* ... */ }
// 循环结束后：
if (guard === MAX_CLOCK_CASCADE) {
  return this.fail(`clock cascade exceeded ${MAX_CLOCK_CASCADE} windows`, events);
}
```

---

## 附录 B · 审查复现命令

```sh
# 内核原语使用率矩阵（§1.1 / M-1）
for g in catan splendor betrayal poker sanguosha dune_mahjong; do
  f=$(ls packages/games/src/$g/*.ts)
  echo "$g decisions=$(grep -l openDecision $f | wc -l) stack=$(grep -l InterruptStackManager $f | wc -l) rollwin=$(grep -l RollWindowManager $f | wc -l) effects=$(grep -l 'state.effects\|addEffect' $f | wc -l) hooks=$(grep -l hooks $f | wc -l) vars=$(grep -c globalVars $f | awk -F: '{s+=$2} END {print s}')"
done

# 逃逸口 key 清单（§1.2）
grep -rhoE "globalVars\.[a-zA-Z_]+" packages/games/src | sort | uniq -c | sort -rn

# 语义不变量缺席（§1.4）
grep -c "chip" packages/kernel/src/invariants.ts

# capabilities 只有 UI 在读（M-6）
grep -rn "simultaneousMoves\|dynamicRules" packages/kernel/src apps/web/src

# 别名密钥只在 P2P 侧设置（S0-1）
grep -rn "setAliasSecret" packages apps

# innerHTML 分布（S2-11）
grep -rc "innerHTML" apps/web/src --include=*.ts | grep -v ':0'
```

> 上述命令均可直接复现，不依赖构建产物。
