# 架构问题与合并优化清单

> 持续更新。原则：先修规则/投影边界，再合并重复的表现逻辑；不在 core 里写 UI 特例。

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
| AI-31 | 「查看卡牌详情」有两份实现（`app/session.ts` 与 `app/netSession.ts`），且用 `meta.id === 'splendor'` 这种游戏名字决定要不要再开一张详情卡；悬浮预览与点击详情两个通道互不知情、谁后到谁赢 | 同一张卡在单机与联机下表现不同（联机必弹第二张大山屋风格大卡），每加一款游戏都要改通用层 | **Step 0 已实现**：`packages/kernel/src/module.ts` 新增 `GamePresentationHints`（`cardPreviewOnHover` / `cardFacts`），`packages/app/src/inspect.ts` 收敛为唯一实现并被两个 session 共用，游戏词汇与预览策略由 `games/src/registry.ts` 中各游戏自己的 `presentation` 声明（山屋 facts 在 `betrayal/presentation.ts`）；回归见 `suites/presentation.ts`。剩余：Step 1 中性 `DetailView` + `OverlayArbiter`（peek/pin 合一、modal 优先）；Step 2 `definePresentation` 注册表迁走山屋/宝石专有表现；Step 3 结构性 lint + 跨游戏隔离测试 |

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
