# 架构问题与合并优化清单

> 持续更新。原则：先修规则/投影边界，再合并重复的表现逻辑；不在 core 里写 UI 特例。
>
> **2026-11 全量审查**：第 0 节是 AR-1…AR-49 台账（问题报告见 [ARCHITECTURE-REVIEW-2026-11.md](ARCHITECTURE-REVIEW-2026-11.md)，形式化失效分析见 [KERNEL-CHARTER.md](KERNEL-CHARTER.md)）。

## 0. 2026-11 全量审查台账（AR-1 … AR-49）

> 来源：[ARCHITECTURE-REVIEW-2026-11.md](ARCHITECTURE-REVIEW-2026-11.md)（问题清单）+ [KERNEL-CHARTER.md](KERNEL-CHARTER.md)（形式化失效分析）。
> 本节按严重度排列，**已实现**的条目在合并修复后应移入 §1 并把「状态」改为「已修复」。
> 状态取值：`待修` / `进行中` / `已修复` / `已登记偏离`（在 [RULES-DEVIATIONS.md](RULES-DEVIATIONS.md) 中登记理由与到期日）。

### 0.1 S0 · 正确性 / 安全致命

| ID | 问题 | 证据 | 建议 | 状态 |
| --- | --- | --- | --- | --- |
| AR-1 | 中心模式虚拟别名未加密钥，隐藏实体 id 可被穷举还原 | `packages/kernel/src/observer.ts` 的 `getVirtualAlias()`（53-59 行）缺省走 FNV-1a 32 位；`packages/app/src/netSession.ts:221` 是唯一 `setAliasSecret` 调用点（仅 P2P 房主侧）；`apps/server/src/match.ts` 构造 `GameRoom` 时未设置 | `ServerMatch` 构造后 `this.room.engine.setAliasSecret(crypto.randomBytes(32).toString('hex'))`；补"中心模式别名必须是 HMAC 形式"的回归测试 | 待修 |
| AR-2 | ~~德扑 AI 从权威 raw state 决策~~ | ~~`rules.ts` 传 `state` 给 `choosePokerAction`~~ | ✅ **已修复**：`choosePokerAction(view: ProjectedGameState)`，`rules.ts` 经 `decisionView()` 投影；`deriveNoise(view)` 不再读 `prngState`；测试见 `harness/src/suites/charter.ts` 的 C-5 两例（含「抹掉对手筹码决策不变」断言） | 已修复 |
| AR-3 | 认证态存 localStorage + Bearer，token 还会进入 URL 查询串 | `apps/web/src/lobby/lobby.ts:749` 写 localStorage、`lobby.ts:1062` 把 token 放进 `gameQuery`；`apps/web/src/lobby/api.ts:3` | 短期 token 移出 URL（一次性 ticket + postMessage）；中期换 `HttpOnly; Secure; SameSite=Lax` cookie | 待修 |
| AR-4 | 状态变更接口无 CSRF / Origin 防护 | `apps/server/src/index.ts` 的 `/api/rooms/:id/{join,status,ready,kick,host,ai}` 只校验 Bearer | `/api/*` 非 GET 请求加 `Sec-Fetch-Site` / `Origin` 白名单中间件 | 待修 |

### 0.2 S1 · 严重

| ID | 问题 | 证据 | 建议 | 状态 |
| --- | --- | --- | --- | --- |
| AR-5 | 内核 / 游戏层与 Node 平台耦合 | `tsconfig.json` 用绝对 `paths`；`packages/games/src/splendor/pokemonData.json` 内嵌 2777 行资源；`apps/server/src/storage.ts` / `config.ts` 的 `node:fs` / `process.env` 经 registry 反向侵入 games 包 | kernel 只允许 `import type` + 自研纯函数；资源外置 `data/`；`tsconfig` 改相对 paths 或拆包级 `package.json` | 待修 |
| AR-6 | 持久化是全量 JSON 同步写，用户与房间共用 `hub.json` | `apps/server/src/storage.ts` 每次 `update()` 都 `JSON.stringify` 整个 DB 并 `writeFileSync`；`ecosystem.config.cjs` 写死 `instances:1` | SQLite（`better-sqlite3` / `node:sqlite`）单表 upsert；过渡期拆文件 + 异步写队列 + fsync | 待修 |
| AR-7 | `hub.json` 解析失败直接 `process.exit(1)` | `apps/server/src/storage.ts` 的 `load()` catch 分支 | 备份后进只读模式 + 健康检查 / 恢复入口；原子写保证不出现半截 JSON | 待修 |
| AR-8 | 登录限速非原子，且 `scryptSync` 阻塞事件循环 | `apps/server/src/index.ts` 的 `loginFails`（读→`login()`→写回），`storage.ts` / `auth.ts` 的 `scryptSync` | `crypto.scrypt` 异步版；限速改令牌桶 + LRU；Per-IP 登录并发闸 | 待修 |
| AR-9 | `ServerMatch` 直接改写权威状态（昵称 / 头像） | `apps/server/src/match.ts:155` 的 `target.name = ...` | 改走 `globalVars.roster` 或独立展示层，在投影阶段合成 | 待修 |
| AR-10 | 扑克账本无事务（扣款 → 构造 → 失败补偿） | `apps/server/src/match.ts` 的 `MatchManager.ensure()` / `fundSeats()` / `refundBuyIns()`，`ServerMatch.dispose()` 的 `refundTableStakes()` | append-only ledger + 幂等 key（roomId + seat + handNo + kind），启动对账 | 待修 |

### 0.3 S2 · 中等

| ID | 问题 | 证据 | 建议 | 状态 |
| --- | --- | --- | --- | --- |
| AR-11 | 内核 invariant 对 `globalVars` / `custom` 全盲，61 条检查码全是结构一致性 | `packages/kernel/src/invariants.ts`（`grep -c chip` 为 0） | 新增 `GameModule.checkInvariants?`，strict 模式统一调用（宪章 C-6） | 待修 |
| AR-12 | `advanceClock` 有未文档化的 16 次级联上限，超限静默退出 | `packages/kernel/src/engine.ts` 的 `advanceClock()` | 改可配置预算 + 超限 `fail()` + 结构化事件 | 待修 |
| AR-13 | `exportLog()` 每次全量重放只为取 head hash | `packages/kernel/src/engine.ts` 的 `exportLog()` | 直接 `hashState(this.state)`；每 50 步存检查点 | 待修 |
| AR-14 | `replayTo` 无检查点，时间机器是 O(N) | `packages/kernel/src/engine.ts` 的 `replayState()` / `replayTo()` | 同上（检查点表） | 待修 |
| AR-15 | 动作合法性每次都全量 `canonicalize` 比较 | `packages/kernel/src/engine.ts` 的 `isLegal()` | 结构化比较先做 O(1) 索引，深比较仅兜底 | 待修 |
| AR-16 | 钩子 handler 异常被静默吞掉，strict 下规则静默失效 | `packages/kernel/src/aop.ts` 的 `safeHandler()` | strict 模式升级为 dispatch 失败并上报 | 待修 |
| AR-17 | `GameRoom.setCurrentViewer` 用可变字段传参（隐式并发） | `packages/net/src/room.ts` 的 `submit()` + `apps/server/src/match.ts` 的 `submit()` | `submit(action, viewer)` 显式传参，删除 `setCurrentViewer` | 待修 |
| AR-18 | 投影对 players / npcs / effects 做深拷贝 | `packages/kernel/src/observer.ts` 的 `projectState()` | 结构化共享 + 只拷脱敏字段 | 待修 |
| AR-19 | 座位数推导有 3 份实现 | `apps/server/src/rooms.ts` 的 `fixtureSeats()` / `seatsSupport()`、`apps/server/src/match.ts` 的 `ServerMatch`、`packages/app/src/netSession.ts` | `meta.seatRange` 声明式契约，三处统一读取 | 待修 |
| AR-20 | 渲染层每次动作全量重建 3D 场景 | `apps/web/src/render/scene.ts` 的 `syncState()` 用 `actionLog.length` 作 boardKey | 按实体 id 增量 reconcile（`dom/keyed.ts` 的 3D 版） | 待修 |
| AR-21 | 65 处 `innerHTML`，转义函数复制 4 份 | `apps/web/src/ui/hud.ts`、`lobby/lobby.ts`、`admin/admin.ts`、`main.ts` 各有 `esc*` | 抽 `html` tagged-template；CI grep 禁止裸 `innerHTML =` | 待修 |
| AR-22 | `session.ts` God Object（`rebuild()` 一个函数做 7 件事） | `packages/app/src/session.ts` 的 `rebuild()`（约 1091 行起） | 拆为纯 builder 库 + 薄壳，`netSession` 复用 | 待修 |
| AR-23 | `patch` 协议声明 `move/copy/test` 但未实现 | `packages/room-protocol/src/index.ts` 的 `PatchOp` vs `packages/net/src/patch.ts` | 协议收敛到实现子集，或补齐实现并加类型-实现一致性校验 | 待修 |
| AR-24 | 客户端不校验 `baseRevision`，乱序 delta 会打错基线 | `packages/net/src/server-transport.ts` | 校验 `baseRevision === this.revision`，否则请求快照 | 待修 |
| AR-25 | 应用层重复实现"是否需要 tick" | `apps/server/src/match.ts` 的 `needsClock()` vs 内核 `stampDeadlines()` | 内核暴露 `needsClock()`，驱动方只读 | 待修 |
| AR-26 | 每个对局两个 `setInterval`（tick + AI pump） | `apps/server/src/match.ts` 的 `startClock()` / `startAiPump()` | 全局时间轮 + 单一定时器 | 待修 |
| AR-27 | 每帧每快照调用 `presentation.describeMoment` / `cardFacts` | `packages/app/src/session.ts` 的 `rebuild()` | 按 revision memo | 待修 |

### 0.4 S3 · 工程债

| ID | 问题 | 证据 | 建议 | 状态 |
| --- | --- | --- | --- | --- |
| AR-28 | 单 `package.json` 冒充 monorepo，无 workspace、无包级依赖声明 | `find -name package.json` 只有根 | `pnpm-workspace.yaml` + 每包 `package.json` | 待修 |
| AR-29 | 包名拼写错误 | `package.json` 的 `"name": "borad_game"` | 改 `rds-board-core` | 待修 |
| AR-30 | `lucide` 依赖未被使用 | 全仓无 import | 删除依赖 | 待修 |
| AR-31 | 构建期执行 `git` 且失败回退硬编码贡献者列表 | `vite.config.ts` 的 `gitInfo` IIFE | 移到构建脚本产物；回退显式写 `unknown` | 待修 |
| AR-32 | `HUB_SECRET` / `ADMIN_PASSWORD` 多处弱默认值，`.env.example` 写了真实口令 | `ecosystem.config.cjs`、`Dockerfile`、`apps/server/src/config.ts`、`.env.example` | 生产环境无默认值，配置缺失硬拒启；示例文件只写占位符 | 待修 |
| AR-33 | 自检脚本断言默认口令可登录 | `apps/server/src/selftest.ts` | 用随机生成口令做自检 | 待修 |
| AR-34 | `SignalHub` 顶掉旧连接时不清理 `MatchBroker` 订阅 | `apps/server/src/signal.ts` 的 `accept()` + `matchBroker.attach()` | 统一 `ConnectionRegistry` 管理连接生命周期 | 待修 |
| AR-35 | 诊断指纹全局共享而非按 IP 分桶，`includes` O(128) | `apps/server/src/index.ts` 的 `DIAG_FINGERPRINTS` | Map + 按 IP 分桶 | 待修 |
| AR-36 | 扑克排行未鉴权即可枚举账号昵称 | `apps/server/src/index.ts` 的 `/api/poker/leaderboard` | 加登录要求或分页脱敏 | 待修 |
| AR-37 | 中心模式下仍生成 `hostSeed` / `aliasSecret`，并 bootstrap 固定 seed=42 占位引擎 | `packages/app/src/netSession.ts:193-245` | 分支收敛，删死代码 | 待修 |
| AR-38 | 50 个脚本，`probe/verify/shoot/test` 四套前缀职责重叠 | `scripts/` | 收敛为统一 CLI（如 `pnpm qa --gate=...`） | 待修 |
| AR-39 | 显式 `any`：server 56 / web 49 / games 29 / app 21 | `rg '\bany\b'` 统计 | `noExplicitAny` 从 warn 升 error，逐包清零 | 待修 |
| AR-40 | CSS 5427 行且关闭了 `noDescendingSpecificity` / `noImportantStyles` | `biome.json` | 至少 `apps/web/src/ui/tokens/*.css` 保留检查 | 待修 |
| AR-41 | 大厅可达游戏 5 个，`GAME_REGISTRY` 有 6 个（`dune_mahjong` 未上架） | `packages/games/src/registry.ts` vs `apps/server/src/games.ts` | 由 registry 生成 `GAMES` 清单，消除两份真相 | 待修 |
| AR-42 | 注释密度高且混入历史决策记录（"审查报告 Sx / AI-xx"），代码与注释双轨 | 全仓 | 历史决策迁到本文档，代码注释只留"为什么" | 待修 |

### 0.5 M · 多模组形式化失效（宪章落地项）

> 完整论证见 [KERNEL-CHARTER.md](KERNEL-CHARTER.md)。这些是**架构改造**，不按 bug 修，按阶段推进。

| ID | 问题 | 证据 | 建议 | 状态 |
| --- | --- | --- | --- | --- |
| AR-43 | 只有 1/6 模组用全了内核五类原语，规则逻辑下沉到 47 个 `globalVars` key | `KERNEL-CHARTER.md` §1.1 / §1.2 的使用率矩阵 | 🔶 **部分修复**：内核已有 `meta.stateSchema.globalVars` + `CHARTER_C9_UNDECLARED_GLOBAL_VAR` 检查，poker 已登记 7 个 key；其余 5 个模组待登记；CI 使用率矩阵未做 | 进行中 |
| AR-44 | `𝒯` 是万能函数，一次 `reduce` 可含 8~64 次逻辑转移 | `packages/games/src/poker/rules.ts:605` 的 `advanceAi()`（内部 `for … < 64`）、同文件 `settle()` 的 `for … < 8` | 宪章 C-2 单步转移；阶段 2 引入 `transition(state, actions[], ctx)` | 待修 |
| AR-45 | 并发被降维成串行，多人同时决策顺序敏感 | `Action` 单 actor；`packages/kernel/src/engine.ts` 的 `resolveOpenDecision()` 串行 `reduce` | 宪章 C-3，新增 `SIMULTANEOUS` 决策策略，`𝒯` 接受动作多重集 | 🔶 **部分修复**：内核已有 `SIMULTANEOUS` 策略 + `applySimultaneous()`，dune / catan 已迁移；poker / betrayal 待补 |
| AR-46 | 随机源未收口，模组可绕过 `ctx.roll()` | `packages/games/src/betrayal/helpers.ts` 的 `drawRoomCandidate()`、`packages/games/src/poker/ai.ts` 的 `noise()` | 宪章 C-4，`reduce` 不再注入 PRNG 静态方法，随机只能走 `ctx.roll()` | ✅ **已修复**：betrayal 弃牌堆重洗改为推进 `prngState`；`charter C-4` 覆盖全部运行期调用点 |
| AR-47 | `ℛ` 与 `𝒯` 完全耦合，收益事后反推、无法审计 | ~~`poker/rules.ts` 的 `showdown()` 直接 `setChips()`~~ | 🔶 **部分修复（2026-11）**：内核已有 `ReduceContext.reward()` + 只追加的 `state.rewards`，poker 的摊牌派池 / 弃牌取胜 / 观察者低保三处已记账，`charter C-7` 三例覆盖；其余 5 个模组待接入 | 进行中 |
| AR-48 | `capabilities` 四个布尔位在全仓只被 UI 读取，内核从不消费 | `apps/web/src/ui/mathInspector.ts:329-332` 是唯一读取点 | 要么让内核真正消费（调度 / 校验分支），要么从 `GameMeta` 移除并放入 `presentation` | 待修 |
| AR-49 | 钩子机制被绕开：`bagua_armor` 的 handler 只返回一句提示 | `packages/games/src/sanguosha/hooks.ts`；真正的判定手写在 `packages/games/src/sanguosha/rules.ts` 的 `JUDGE_BAGUA` 分支 | 🔶 **部分修复（2026-11）**：`charter C-8` 静态扫描各模组 `rules.ts` / `helpers.ts`，`presentation` 出现在转移路径上即失败（回归防线）；钩子表达力不足与物理拆分仍未解决 | 进行中 |

### 0.6 实施顺序（与审查报告 §10 一致）

1. **一周内止血**：AR-1、AR-2、AR-4、AR-3（部分）、AR-32、AR-8、AR-12。
2. **一至两月结构**：AR-20、AR-21、AR-13、AR-6、AR-19、AR-17、AR-28、AR-11（宪章阶段 1）。
3. **一季以上架构**：AR-44 / AR-45 / AR-47 / AR-49（宪章阶段 2–3）、运行时状态外置、AR-48。

---

## 1. 已确认并修复

| ID | 问题 | 本质原因 | 处理 |
| --- | --- | --- | --- |
| AI-01 | `PLACE_ROOM` 非法旋转被 dispatch 接受 | payload 只做枚举校验，未校验当前 pending 的合法朝向 | Betrayal 增加 `validatePayload`，非法旋转在 reducer 前拒绝 |
| AI-02 | NPC 动作任意客户端可提交 | actor 存在性校验 ≠ 控制权校验 | engine 校验 NPC `controllerId`；GOD 显式放行 |
| AI-03 | 模块声明 `topologySpec` 与实际图不一致 | 声明数据和 setup 数据是两份手工副本 | 启动时比较 kind/adjacency/directed/geometry/layers；修正山屋/三国杀声明 |
| AI-04 | 选择器候选读 raw state | 候选生成和投影是两条路径 | 候选统一从当前 viewer 的 projection 生成；对手手牌返回空 |
| AI-05 | 无目标模式点击 node/edge 直接执行 | UI 回退匹配了任意 legal action | 改为 inspect-first；必须从动作栏进入 targeting |
| AI-06 | 切换视角后残留棋盘目标模式 | `activeBoardGroup` 是 session 隐式状态 | `setViewer` / `rebuild` 清理；后续可暴露到 snapshot UI state |
| AI-07 | 动作栏 24 条截断 | 线性截断 | 取消截断，`END_TURN` 固定最后 |
| AI-08 | 隐藏 ID 可能从 custom props 泄漏 | 实体投影和自定义字段投影分离 | 增加全夹具/多 seed 投影泄漏回归；后续若模块新增公开字段继续扫描 |
| AI-09 | 手牌 >7 重叠 | 固定卡宽/固定步长 | 手牌按数量自适应 `cardScale` + step，目前最多 10 张仍保持间距 |
| AI-10 | 拖实体时相机晃动 | OrbitControls 与实体拖拽共用 pointer | 实体 drag 期间禁用 controls |
| AI-11 | 实体拖动越飞越高、放置无法落定 | Three.js raycast 忽略 `visible=false` 导致 `surfaceYAt` 反复击中正在拖拽的实体自身形成正反馈高度累加；松手时也以此高空位置作为目标 | `surfaceYAt` 使用 Set 树形过滤排除被拖实体及其所有子网格；拖动高度稳定在下方表面 +0.45；松手执行 220ms ease-out 下落动画并落定到支撑面 |
| AI-12 | 楼层固定偏移导致叠压 | 表现层写死 offset | `layerMode: auto` 按当前层包围盒计算 |
| AI-13 | 拖动释放到 HUD/画布外丢失 pointerup | 相机锁死、卡牌停留空中 | entity pointer capture + 统一 release/cancel；pointerdown 立即锁相机 |
| AI-14 | 新实体 settle 前 matrixWorld 未更新 | 射线读到旧位置，丢弃牌落入桌面/地板下 | 射线前强制 `scene.updateMatrixWorld(true)`；新增丢弃落定回归 |
| AI-15 | 房间物品视觉锚点重复计算 | zone_room 与 slot 两套语义；renderer 硬编码偏移 | 模块提供 `PlacementSlot.local/visual`，renderer 只做坐标/布局消费；不再按 `zone_room_*` 猜位置 |
| AI-16 | 全量重建时相机可能被自动取景重置 | `syncState` 重建与相机 fit 策略绑定 | 相机属于 renderer；仅显式布局变化/用户请求才 fit，丢弃/新实体保持当前 camera/target |
| AI-17 | 放置房间时相机反复 fit，放置后停在高位 | 相机 fit 与 placement 旋转耦合；缺少 placement 前相机快照 | 相机归 renderer：placement 开始保存 pose 并缓动抬高，旋转不 fit，结束/取消缓动恢复 |
| AI-28 | 房主侧存在两个引擎：HUD 的 `UniversalSession` 与权威 `GameRoom` 镜像，靠 append-only 日志尾部重放保持同步 | 两个独立状态机 + 微任务尾部同步，任何丢步/重放错位都会造成双端分歧 | **已实现（中期项 A2，PR #67）**：`GameRoom` 构造器接受可注入引擎（`net/room.ts:86`），房主侧只创建一个 `UniversalGameEngine` 交给 `GameRoom` 与 `UniversalSession` 共用（`app/netSession.ts:204-211`）；`revision` 只在引擎状态哈希变化时推进，delta 推送统一由 `GameRoom.onChange` 驱动；`BridgedRoom` / `syncing` / 尾部重放已全部删除（全仓 grep 无残留） |
| AI-29 | 房客可抢先占据他人座位：`seatOwners` 仅用于 presence 展示，座位分配是先到先得 | 传输层座位与 hub 身份无绑定，抢座后可提交他人 actor 的动作 | **已实现（中期项 A3，PR #67）**：`WebRtcHostTransport` 接收 `seatOwners`，已绑定座位只允许其 hub userId 加入、同一 peer 只能持一个座位且 `submit` 的 actor 必须等于自身座位（`net/webrtc-transport.ts:163`）；房间侧再用 `GameRoom.setAuthorizer` 二次校验（`net/room.ts:106`）；未绑定座位保持先到先得。大厅（Hub）路径为服务器权威：座位由服务端分配、actor 绑定本人座位 |
| AI-31 | 「查看卡牌详情」有两份实现（`app/session.ts` 与 `app/netSession.ts`），且用 `meta.id === 'splendor'` 这种游戏名字决定要不要再开一张详情卡；悬浮预览与点击详情两个通道互不知情、谁后到谁赢 | 同一张卡在单机与联机下表现不同（联机必弹第二张大山屋风格大卡），每加一款游戏都要改通用层 | **Step 0 已实现**：`packages/kernel/src/module.ts` 新增 `GamePresentationHints`（`cardPreviewOnHover` / `cardFacts`），`packages/app/src/inspect.ts` 收敛为唯一实现并被两个 session 共用，游戏词汇与预览策略由 `games/src/registry.ts` 中各游戏自己的 `presentation` 声明（山屋 facts 在 `betrayal/presentation.ts`）；回归见 `suites/presentation.ts`。**Step 1 已实现**：`UiCardDetail` 换成中性 `UiDetailView`（`badge` / `tone` / `seal` / `sections`，见 `packages/app/src/contracts.ts`），`GamePresentationHints` 增 `cardStyle`（山屋的牌型带文本落在 `betrayal/presentation.ts`）；`apps/web/src/ui/overlay.ts` 的 `OverlayArbiter` 用 `peek < pinned < modal` 仲裁悬浮芯片与详情大卡，同一 `key` 只有一个视图、指针漂移不再灭口玩家点开的卡；`apps/web/src/ui/cardArt.ts` 改由 `tone` 驱动配色（不再认识 OMEN/ITEM 等游戏词）。**Step 2a 已实现**：`GamePresentationHints` 增 `describeNode`，声明统一由 `packages/kernel/src/module.ts` 的 `definePresentation()` 写出（键类型错误在模块加载时抛 `TypeError`），`packages/app/src/inspect.ts` 的 `buildNodeDiscoveryView` 把游戏给的 `NodePresentationHints` 变成中性 `UiDetailView`；`apps/web/src/ui/hud.ts` 的 `maybeRevealRoom` 换成 `maybeRevealNode`——通用层只判断「出现了没见过的 `node.id`」，房间档案（楼层/已连通门位/符号/「新房间已加入洋馆布局」/全屏揭示）整体搬进 `packages/games/src/betrayal/presentation.ts` 的 `betrayalDescribeNode`，通用层不再含山屋词汇；顺带修掉 `scripts/render-card-faces.mjs` 仍在用的 `kind`→`tone` 漂移。**Step 2b-1 已实现**：`GamePresentationHints` 增 `describeTrait` / `traits` / `describeMoment` / `roleLabel`；`packages/app/src/session.ts` 删掉 `TRAIT_LABEL` / `TRAIT_COLOR` / `ROLE_LABELS` 三张通用层词表，玩家卡的四条阶梯与身份名改为向游戏索取（`buildPlayersView` 增 `presentation` 参数，`netSession` 一并传入）；山屋的阶梯元数据、`叛徒/英雄/探索者` 与作祟序曲搬进 `betrayal/presentation.ts`（`betrayalDescribeTrait` / `betrayalTraits` / `betrayalRoleLabel` / `betrayalDescribeMoment`），三国杀的身份名搬进新建的 `sanguosha/presentation.ts`；`apps/web/src/ui/hud.ts` 删掉 `HUD_TRAIT_SHORT`，作祟过场 `maybeShowHaunt` 换成完全中性的 `maybeShowMoment`（只按 `key` 去重，幕布上每个字来自 `MomentPresentationHints`，样式类 `.haunt-cine` / `.hc-*` 一并改为 `.moment-cine` / `.mc-*`）。剩余：Step 2b-2（`hud.ts` 的 minimap 楼层 tab 与 `floorLabel`、「洋馆总览」、room card 的 `props.floor` / `doors` / `symbol` 与「遗物 ×N」、placement 预览符号、MEEPLE 的 `custom.monster`、`zone_room_` 前缀——这些不只是文案而是结构假设，需把「地图分层」与「区域前缀」也抬成内核能力）；Step 3 结构性 lint（通用层禁游戏术语）+ 跨游戏隔离测试（含把 Step 1 用过的临时浏览器探针固化成常驻脚本并入 `test:ui`） |

## 2. 重复相似特性（需要合并）

| 重复点 | 现状 | 最优方案 |
| --- | --- | --- |
| 卡牌布局 | `renderHand` / `renderSeatCards` / `renderCardEntity` / `renderCardPile` 各自写 fan/stack/scale 公式 | 抽 `render/cardLayout.ts`：输入 count/zone/frame，输出位移、旋转、scale、层高；渲染器只消费布局结果 |
| 牌堆/分组 | `spatialLayout: STACK/FAN`、`buildCardGroups`、`fanZoneId` 三套概念 | 统一为 `CardGroupView`：逻辑分组 key + 布局模式 + 可见数量；`spatialLayout` 只作默认值 |
| 楼层位置 | `gridToWorld` 静态 offset、`adjustPlacement` 动态 offset、projection auto offset | 单一投影入口；placement preview 直接使用 projection 后的锚点，不再二次修正 |
| 目标匹配 | session 内 `match` 的 if/else、动作栏 highlight、模块 legal action | 动作声明 `targetKind`（node/edge/entity/slot）；UI 只按元数据匹配，不再硬编码 action type |
| 拓扑声明 | module.meta.topologySpec 与 setup.mapGraph.topology 两份 | 从同一 topology factory 生成；短期保留启动校验 |
| 验证脚本 | flow/probe/shoot/test-matrix/test-ui-matrix | `test-all` 编排：core → matrix → ui matrix；旧脚本只保留手工诊断 |
| 隐藏信息 | 实体 alias、节点移除、customProps 扫描 | 投影阶段统一 `IdRemap`；禁止模块在公开字段保存 raw hidden id |

## 3. 尚未完成（非 TBD）

> 与 [BACKLOG.md](BACKLOG.md) 保持一致：这里只留**架构层**的未完成项，
> 表现层/性能/i18n 的待办在 BACKLOG。最近核对：2026-10-28。

| ID | 问题 | 建议 |
| --- | --- | --- |
| AI-25 | K8/K9/K12/K14 Wave 3 | 按 KERNEL-EXPRESSION 推进，不混入 fixture 特例，不与表现层同 PR |
| AI-30 | 服务端权威反作弊（对抗恶意房主） | **确认边界外**（[BACKLOG.md](BACKLOG.md) §0.2：不构建真实服务端）。P2P 下房主是信任对等体；当前缓解=内核结构/合法性校验、隐藏信息只经投影离开房主、座位绑定 + actor 校验 + 非法动作不改状态。若要抗恶意房主，需把 `GameRoom` 跑成独立服务端进程（seam 已就绪），届时另立 RFC。 |

### 已结案（不再跟踪）

| ID | 原待办 | 结论 |
| --- | --- | --- |
| AI-24 | 无两阶段检定窗口 | 已实现（SA-104）：`packages/kernel/src/rollWindow.ts` 提供通用 `RollWindowManager`（open/pick/record/amend/resolve），内核只管生命周期，选项 id 留在模块侧；山屋金库检定接入 |
| AI-23 | `EffectInstance` 槽位已在 core 就绪，山屋物品/击晕仍用模块自写的 `customProps` | 已实现（SA-100）：持续诅咒迁入 `GameState.effects`，模块仅解释 `payload.effect`；`addEffect`/`removeEffects`/`effectsOn`/`ongoingEffectKinds` 为统一入口，旧 `customProps.effects` 保留只读兼容，回放哈希不变 |
| AI-21 / AI-27 | 楼层选择已有相机聚焦，尚未真正隐藏其他层/小地图 | 已实现（SA-93）：3D 楼层过滤（draw call -56%~-74%）、raycaster 排除隐藏层、HUD 建筑切片小地图全联动 |
| AI-20 | `placementRotation` 只在 session 内存 | 已实现：`session.ts` 用 `sessionStorage` 持久化（键含 game/seed/scenario/defId） |
| AI-22 | 3D 卡面长描述截断 | 观点已定：DOM 卡牌详情为主，3D 只做摘要，不做长文渲染 |
| AI-26 | 全量重建是 correctness-first | 按 BACKLOG §1 的实测判据未超预算（`lastSyncMs` 8.3ms、geometry/texture 恒定），暂不做 diff/对象池 |

## 4. 验证入口

统一走 `pnpm` 脚本，口径见 [AGENTS.md](../AGENTS.md)：

```bash
pnpm test           # 内核一致性 + 分层边界
pnpm test:matrix    # 六夹具 × 多 seed × 全场景黑盒
pnpm test:ui        # Playwright UI 流程矩阵
pnpm probe:layout   # 家具布局与门位冲突
pnpm probe:overlap  # 房间几何 z-fighting 回归
node node_modules/typescript/bin/tsc --noEmit
pnpm build
```
