# 通用桌游内核 · 架构与模块实现

> 本文描述 **当前代码快照** 的实际实现，而不是规划稿。
> 形式化契约、扩展步骤与测试说明见 [CORE.md](./CORE.md)；本文侧重分层、模块职责、调用链与实现细节。
>
> 当前基线：`206 passed / 0 failed / 0 boundary violations`，`tsc --noEmit` 通过，`vite build` 通过。
> 山屋专项的规则覆盖与缺陷评估见 [BETRAYAL.md](BETRAYAL.md)。

---

## 目录

1. [系统定位](#1-系统定位)
2. [总体架构](#2-总体架构)
3. [数据模型](#3-数据模型)
4. [核心内核](#4-核心内核)
5. [应用层](#5-应用层)
6. [UI 层](#6-ui-层)
7. [渲染层](#7-渲染层)
8. [网络与持久化](#8-网络与持久化)
9. [AI 层](#9-ai-层)
10. [游戏夹具](#10-游戏夹具)
11. [组合根与启动流程](#11-组合根与启动流程)
12. [测试与质量保障](#12-测试与质量保障)
13. [扩展指南](#13-扩展指南)
14. [已知简化与技术债](#14-已知简化与技术债)
15. [文件索引](#15-文件索引)

---

## 1. 系统定位

产品是**通用桌游内核**，不是某一款桌游：

- `packages/kernel/src/` 提供与游戏无关的调度、隐藏信息、中断栈、动态规则、回放、校验；
- `packages/games/src/` 下的六款游戏是**一致性夹具**，证明内核能覆盖不同机制组合；
- `packages/app/src/` 把内核翻译成 UI 可消费的 DTO；
- `apps/web/src/ui/`、`apps/web/src/render/` 是可替换的调试器前端；
- `packages/net/src/`、`packages/harness/src/` 是内核之上的适配层。

### 1.1 形式模型到代码的映射

```
G = ⟨N, S, s0, A, L, T, O, R, K⟩
```

| 形式符号 | 代码位置 | 说明 |
| --- | --- | --- |
| `N` 玩家/NPC | `GameState.players` / `npcs` / `actorOrder` | 纯 JSON actor 记录 |
| `S` 状态 | `GameState` | 全部字段可序列化 |
| `s0` 初态 | `GameModule.setup` / `scenarios` | 种子确定，可命名场景 |
| `A` 动作 | `Action` | 类型 + 目标 + `payload` + 声明式 `fields` |
| `L` 合法动作 | `GameModule.legalActions` | 由模块实现，内核严格校验 |
| `T` 转移 | `UniversalGameEngine.dispatch` + `GameModule.reduce` | 单一管线，纯函数 reducer |
| `O` 观测 | `CognitiveObserver.projectState` | 按视角擦除/虚拟 ID/日志脱敏 |
| `R` 收益/胜负 | `GameModule.outcome` + `Player.score` | 模块定义胜利条件 |
| `K` 元规则 | `ActiveRuleHook` + `RuleRegistry` + `RulePipeline` | 数据挂载、实现注册、AOP 拦截 |

### 1.2 设计原则

1. **状态是纯 JSON**：无函数、类实例、`Date`、`Map`；规则实现不进入状态。
2. **确定性**：PRNG 种子化，ID 由 `ctx.id()` 生成，禁止 reducer 里使用 `Date.now()` / `Math.random()`。
3. **单一转移管线**：正常动作、决策提交、响应窗口、逻辑时钟、回放全部走同一套校验/结算/日志逻辑。
4. **观测在边界发生**：内核永远持有全量状态；只有投影后的 `ProjectedGameState` 能离开服务端。
5. **UI 与内核解耦**：UI 只 import `packages/app/src/contracts`；静态检查会在 `pnpm test` 中强制。
6. **夹具优先**：不为单一游戏在 core 开特例；游戏机制通过模块状态机与钩子表达。

---

## 2. 总体架构

### 2.1 分层与依赖

```
apps/web/src/main.ts  (composition root：创建 scene / session / HUD / inspector，接线 ports 与键盘)
        │
        ├──────────────▶ apps/web/src/ui  (hud.ts / mathInspector.ts)
        │                      ▲ GamePresenter(DTO) / PresentationPorts
        ▼                      │
packages/app/src  (contracts.ts DTO 契约 / session.ts Presenter 实现)
        │ owns engine
        ▼
packages/kernel/src  (UniversalGameEngine：engine / decisions / stack / aop / rules /
                      observer / invariants / serialize / validation / ecs / graph / prng / module)
        │
        ├──────────────▶ packages/games/src    (六款夹具：setup / legalActions / reduce / outcome)
        ├──────────────▶ packages/net/src      (room / patch / roomPresenter / webrtc-transport)
        ├──────────────▶ packages/harness/src  (一致性套件 + bot policy)
        └──────────────▶ apps/web/src/render   (Three.js 表现层，只消费投影状态)
```

依赖方向：

- `apps/web/src/ui` → `packages/app/src/contracts`（仅 DTO）；
- `packages/app/src` → `packages/kernel/src`；
- `apps/web/src/render` → `packages/kernel/src/types`（只消费投影状态）；
- `packages/net` / `packages/harness` / `packages/games` → `packages/kernel`；
- `apps/web/src/main.ts` 是唯一同时认识所有层的装配点。

**静态边界检查**（[scripts/test-core.mjs](../scripts/test-core.mjs)）：

- `apps/web/src/ui/**` 禁止引用 `core / games / render / net / ai`；
- `packages/app/src/**` 禁止引用 `ui / render`；
- 违规即测试失败。

### 2.2 一次玩家动作的完整链路

```
点击 HUD 按钮 / 键盘 1-9 / 桌面对象
        │
        ▼
BoardGameHUD.promptAction / click
        │  presenter.perform(actionId, payload?)
        ▼
UniversalSession.perform
        │  在 bound actions 中找回 Action，合并 payload
        ▼
UniversalGameEngine.dispatch(action)
        │
        ├─ 校验 action shape（ActionSchema）
        ├─ 决策窗口? → submitDecision → READY? → resolveDecision
        ├─ 响应窗口? → submitResponse → 栈顶结算
        └─ 普通动作 → isLegal → reduceWithPipeline
                         ├─ AOP FILTER_MODIFY
                         ├─ AOP BEFORE_REPLACE
                         ├─ module.reduce
                         ├─ AOP AFTER_TRIGGER
                         └─ followUpActions（递归，深度上限 8）
        │
        ▼
finalizeTransition
  stamp deadlines → outcome → invariants → state=next
  → history.push → visual events → notifyStateChange
        │
        ▼
UniversalSession.listener
  revision++ → rebuild snapshot → publish
        │
        ├─ HUD.render(snapshot)
        └─ main.bindSession: revision 变化 → scene.syncState(projection)
```

### 2.3 决策窗口链路

```
module.reduce 中 openDecision(...)
        │
        ▼
engine.finalizeTransition → stampDeadlines
        │  window.deadline = clock + timing.decision (默认 8)
        ▼
session.rebuild:
  openDecision 存在
  → acting = 未提交的参与者
  → 聚合所有 acting 的 legalActions（每人一份按钮）
  → 快照 decision + participants
        │
        ▼
参与者提交 ACCEPT / REJECT / DISCARD / COMMIT...
        │
        ├─ FIRST_ACCEPT：首个接受立即 READY
        ├─ ALL_COMMITTED：全部提交 READY
        └─ PRIORITY：达到阈值短路
        ▼
resolveDecision → 按策略顺序执行子动作
        → module.onDecisionResolved（可选）
        → 下一个阶段
```

### 2.4 逻辑时钟与超时链路

```
dispatch({ type: '__TICK__', playerId: 'SYSTEM', payload: { ticks } })
        │
        ▼
engine.advanceClock(ticks)
  clock += ticks
  stampDeadlines(next)
  loop:
    ├─ 找到有参与者到期的 OPEN 决策
    │    → 逐人 submitDecision(PASS)
    │    → ALL_COMMITTED 满员 / FIRST_ACCEPT 达成 → 结算
    ├─ 找到整窗 deadline 到期
    │    → 所有人 PASS → 结算
    ├─ 栈顶响应窗口 deadline 到期
    │    → 所有 eligible PASS → 弹栈 → 执行帧 payload
    └─ 没有到期项 → 退出
  写入 __TICK__ 日志 → outcome → invariants → notify
        │
        ▼
重放时同一 __TICK__ 产生同样的逐人超时
```

### 2.5 回放与恢复链路

```
Live Engine
  history: Action[]
  state: GameState
        │ exportLog()
        ▼
{ moduleId, seed, scenario?, actions, stateHash }
        │
        ├─ new Engine(module, seed, { scenario })
        │     shadow.dispatch(action) × N
        │     shadow.state.actionLog = actions
        ▼
hashState(shadow.state) === liveHash ?
        │
        ├─ verifyReplay(): 全量比对
        ├─ replayTo(step): 时间机器
        └─ loadLog(payload): 替换 live state/history
```

### 2.6 网络房间链路

```
GameRoom.join(viewer)   → 全量投影 + cache
GameRoom.submit(action) → engine.dispatch；成功则 revision++
GameRoom.delta(viewer)  → diffJson(cache, currentProjection)
                         → RFC6902 风格补丁
client.applyPatch(...)  → 重建 o_{i,t}
```

---

## 3. 数据模型

实现：[packages/kernel/src/types.ts](../packages/kernel/src/types.ts)

### 3.1 `GameState` 字段

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `gameId` | `string` | 模块 id |
| `seed` | `number` | 初始种子，回放保留 |
| `seq` | `number` | 成功转移计数器；`ctx.id()` 的确定性来源 |
| `clock` | `number` | 逻辑时钟；仅 `__TICK__` 推进 |
| `round` / `turn` | `number` | 回合/轮次 |
| `activePlayerId` | `PlayerId` | 兼容槽位；当前玩家 |
| `activeActorId` | `ActorId?` | 当前行动者（玩家或 NPC）；缺省 = `activePlayerId` |
| `phase` | `string` | 模块自定义阶段机 |
| `players` / `playerOrder` | `Record` / `array` | 玩家及座次 |
| `npcs` / `actorOrder` | `Record<ActorId, Npc>` / `ActorId[]` | NPC（怪物/中立单位）与含 NPC 的回合顺序 |
| `entities` / `zones` | `Record` | ECS 实体与容器 |
| `mapGraph` | `GameMapGraph` | 六边形/房间/座位的拓扑 |
| `globalVars` | `Record<string, any>` | 模块自定义全局变量（银行、港口、offer…） |
| `interruptStack` | `StackFrame[]` | LIFO 响应栈 |
| `pendingDecisions` | `DecisionWindow[]` | 同步/秘密决策窗口 |
| `activeHooks` | `ActiveRuleHook[]` | 数据化的规则钩子实例 |
| `effects?` | `EffectInstance[]` | 模块解释的效果/修正；内核只负责过期与可见性 |
| `prngState` | `number` | Mulberry32 当前状态 |
| `actionLog` | `Action[]` | 公开动作日志（投影时脱敏） |
| `winner` / `gameOver` | `ActorId \| ActorId[] \| null` / `boolean` | 结局 |

`mapGraph.topology` 是结构化的拓扑声明，`topology` 字符串只是 UI 兼容标签：

```ts
TopologySpec {
  kind: 'none' | 'graph' | 'grid' | 'hex' | 'ring' | 'linear' | 'custom'
  adjacency: 'edges' | 'neighbors' | 'both' | 'none'  // 哪个邻接来源是权威
  directed?: boolean
  weighted?: boolean
  geometry?: 'none' | 'grid' | 'hex' | 'free'
  layers?: { id, name, index }[]
}
MapGraphNode.layer?: string
MapGraphEdge.directed?: boolean / weight?: number / ports?: { from?, to? }
```

`MapGraphNode.position` 是**高维逻辑坐标**（`number[]`），`positionSpace` 显式声明坐标空间：

- 世界型：`positionSpace: 'world'`，`[x, y, z]`
- 网格型：`positionSpace: 'grid'`，`[col, row, layerIndex, ...]`
- 环形型：`positionSpace: 'ring'`，`[seatIndex]`
- 堆叠型：`positionSpace: 'stack'`，`[col, row, level]`
- 自定义：任意字符串 + 注册 `ProjectionPort`
- 缺省（旧状态/旧模块）：按 world 处理，避免把旧世界坐标误读为网格坐标

多板图/嵌套布局通过 `GameMapGraph.frames`：

```ts
interface SpatialFrame {
  id: string;
  parentId?: string;
  origin?: [number, number, number];
  rotationY?: number;
  scale?: number;
}
```

`MapGraphNode.frameId` 指向 frame；投影时按 parent 链组合 translation → rotationY → scale。frame 只属于拓扑/表现元数据，不改变内核规则。

UI 投影现在由 [render/projectionPort.ts](../apps/web/src/render/projectionPort.ts) 的 `ProjectionRegistry` 完成：

```ts
interface ProjectionPort {
  id: string;
  project(node, context): ProjectedTransform;
}
```

- 默认 port 支持 world / grid / ring / stack；
- 自定义 `positionSpace` 可用 `registry.register(space, port)` 接入；
- renderer 不再按 `gameId` 写空间分支；
- frame 链统一在 registry 应用；
- 两个节点投影到同一 XZ 时，按稳定顺序加径向 offset + 微小 Y 偏移，避免 3D 降维后完全重合；
- `layerMode: 'auto'` 时按当前各层节点的实际包围盒计算层偏移；楼层新增/移除/移动后自动重排（山屋）；
- 渲染器在 `syncState` 时一次性把高维坐标投影成显示坐标，其他绘制逻辑只读 XYZ。

**core 不包含相机/UI 布局**；`TopologySpec` 只描述几何与层，表现层 hints 在 [app/layout.ts](../packages/app/src/layout.ts)；`MapGraphManager.validateFrames` 校验 frame 环、缺失 parent/frame。

#### 坐标映射的兼容边界

当前框架**不是“所有桌游类型”的通用空间引擎**，而是覆盖一类：

| 能表达 | 说明 |
| --- | --- |
| 离散、回合制、有限状态 | 图/网格/环/无拓扑/3D 堆叠 |
| 卡牌、token、区域、隐藏信息 | zones + projection |
| 结果型随机与决策窗口 | PRNG + pendingDecisions |
| 开放房间网格 | 山屋；坐标可向任意方向扩展 |
| 六边形对偶图 | Catan |
| 环形座位 | 三国杀 |
| 多板图/嵌套坐标 | `frames` + `ProjectionPort` |
| 自定义几何 | 注册 `ProjectionPort`，不改内核 |

| 仍需扩展 | 原因 |
| --- | --- |
| 多格 polyomino、任意 ports | 只有 col/row 与部分 edge ports；需要占用集合/端口图 |
| 连续平面、物理摆放 | 这是表现/物理层，不是当前离散坐标模型 |
| 动态旋转/移动整块板 | frame 变换已可投影，但状态层没有 frame 动画/父子绑定语义 |
| 3D 堆叠的完整渲染 | 坐标和视觉 offset 已支持；堆叠块/遮挡/拾取仍需专用 mesh 策略 |

当前实现适合“山屋/Catan/三国杀 + 卡牌/区域类”以及可注册自定义 port 的扩展；“兼容全部桌游”仍然是不准确的。

#### DOM labels 与 PlacementSlot

- 标签由 `render/labels/LabelOverlay` 负责：DOM/SVG 覆盖层，按屏幕坐标做碰撞布局，leader line 指回锚点；
- 当前接入：房间名、玩家名牌、怪物名牌、房间物品堆数量、选中卡牌标题；
- 卡牌按 `zone + defId + faceUp + owner + visibility` 做**表现分组**，默认扇形；`×N` 徽章可拖整组，拖顶牌只拖一张；合并/分离不写 state；
- 卡牌标题默认只在选中/可交互时出现，避免手牌全部标签化；
- 标签不参与实体合法性，不修改逻辑坐标。

实体占位：
- `GameMapGraph.slots` + `PlacementSlot` 定义 slot 的 node/edge/zone、容量、`STACK/FAN/ROW`、overflow 和视觉间距；
- `Entity.components.spatial.slotId` 是主 slot；`OccupancyIndex` 从实体派生占用，不复制第二份状态；
- `OccupancyIndex.place/remove/validate` 提供通用容量/类型校验；
- 当前山屋 items/monsters 已写入 room slot；多 slot footprint 仍是 TBD；
- 拖拽到 room + 目标 ring + 点击目标 slot + 顶部“撤销上一步”已接 `PLACE_ENTITY`；手牌/房间物品扇形与顶层交互已接；无合法放置的卡牌可自由拖拽做仅本视图的视觉挪动，多 slot footprint 仍 TBD。

表现层物理：

- `render/physics.ts` 使用 **Rapier 3D**，仅对 token/dice 这类厚实体做视觉 settle；
- Rapier 动态 import，首次出现物理对象才加载 WASM；失败则静态渲染；
- 固定 `1/60` 步长、最多 3 步/帧、桌面静态 collider、sleep/damping；
- 物理结果不写 `GameState`、不参与 actionLog/撤销/回放；
- 卡牌继续走解析式堆叠/扇形，不进入物理引擎；
- 阴影质量（contact shadow/SSAO/PCSS）仍属于渲染层独立工作。

`MapGraphManager` 提供 `neighborsOf` / `adjacencyList` / `bfs` / `shortestPath` / `reachable` / `validateTopology`；`invariants` 会按 `adjacency` 模式校验邻接表与边表的一致性。墙体、视线、门端口匹配仍由模块/渲染层提供。

空间语义通过模块的 `SpatialQuery` 暴露，而不是塞进 `GameModule.meta`：

```ts
interface SpatialQuery {
  neighbors(state, nodeId, actorId?): NodeId[];
  cost(state, from, to, actorId?): number;
  distance?(state, from, to, actorId?): number;
  reachable?(state, from, budget, actorId?): Map<NodeId, number>;
  lineOfSight?(state, from, to): boolean;
  floorAt?(state, nodeId): string | undefined;
}
```

引擎提供 `getSpatialNeighbors` / `getSpatialReachable` / `getSpatialDistance` / `getLineOfSight` / `getSpatialFloor`。山屋的 `BETRAYAL_SPATIAL` 实现了单向门、幽灵穿墙、移动力代价、同层视线与楼层；Catan 的 `hex` 图仍由 `MapGraphManager` 生成，几何参数放在 `geometrySpec`。

### 3.2 实体与区域

```ts
Entity {
  id, type, zoneId, ownerId?, visibility,
  components: { cardFace?, spatial?, tokens?, dice?, building?, custom? }
}
```

- 实体类型：`CARD / TILE / TOKEN / DICE / MEEPLE / BUILDING / DIAL`；
- 可见性：`PUBLIC / OWNER_ONLY / SUBSET / HIDDEN`；
- 区域类型：`DECK / HAND / GRID / MARKET / DISCARD / EQUIP / JUDGE / BOARD / BANK / RESERVE`；
- 区域带 `orderedEntities`、`spatialLayout`、`anchorPosition`，渲染层据此排布；
- ECS 管理器维护“实体只属于一个区域”的双向一致性。

### 3.3 动作

```ts
Action {
  type: string
  playerId: string          // 兼容槽位
  actorId?: ActorId         // 新代码使用；玩家或 NPC
  entityId?, fromZoneId?, toZoneId?
  targetNodeId?, targetEdgeId?, targetPlayerId?
  payload?: any
  fields?: ActionFieldSpec[]
  selection?: SelectionSpec // 声明式目标选择
  targets?: string[]        // 提交后的具体目标
}
```

`fields` 是**声明式参数表单**：HUD 据此渲染下拉/数字/布尔输入；`selection` 是**声明式目标选择器**：HUD 从 `engine.getSelectionCandidates` 渲染候选，提交为 `targets`。动作合法性分三层：

1. `validateActionShape`：结构、枚举、范围、`targets` 数组结构；
2. `isLegal`：与模块 `legalActions` 的绑定匹配（带 `fields` 或 `selection` 的动作允许 payload/targets 后填）；
3. `module.validateSelection`：目标语义校验（是否同房间、是否可攻击等）。

### 3.4 决策窗口

```ts
DecisionWindow {
  id, kind, title, description?
  participants, submissions
  secret, policy, status
  deadline?, participantDeadlines?
  payload?, reveal?
}
```

策略：

| 策略 | 触发条件 | 执行范围 |
| --- | --- | --- |
| `ALL_COMMITTED` | 所有参与者提交 | 全部提交 |
| `FIRST_ACCEPT` | 任一提交命中 `acceptTypes` | 按座次执行到首个接受为止 |
| `PRIORITY` | 最高优先级 ≥ `shortCircuitAt` | 按优先级降序执行 |

### 3.5 栈帧

```ts
StackFrame {
  id, type, title, description, sourcePlayerId
  targetPlayerId?, entityId?
  actionPayload: Action | null
  responseWindow?
  status: PENDING | WAITING_INPUT | RESOLVING | RESOLVED | CANCELLED
}
```

响应窗口 `StackResponseWindow` 保存 `eligiblePlayers`/`eligibleActors`、`pendingResponses`、优先级映射、`deadline`。

### 3.6 投影状态

```ts
ProjectedGameState extends Omit<GameState, 'entities' | 'zones' | 'prngState' | 'seed'> {
  viewerId, entities, zones, legalActions, factionTopology, maskedEntityCount
}
```

渲染层与网络层都只消费该类型；`prngState` 与 `seed` 不离开服务端。`mapGraph` 也按节点/边 `visibility` 裁剪：隐藏节点、隐藏边、悬空邻居和引用隐藏目标的 legalActions 都会被过滤；`maskedNodeCount` / `maskedEdgeCount` 记录裁剪量。

---

## 4. 核心内核

目录：[packages/kernel/src](../packages/kernel/src)

### 4.1 `engine.ts` — 调度器

职责：

- 持有唯一 `GameState`；
- 校验动作形状与合法性；
- 路由到决策/响应/普通动作三条路径；
- 执行 AOP + reducer + outcome + invariants；
- 维护动作历史、哈希、回放、时间机器、日志导出；
- 维护观察者视角与投影；
- 发出视觉事件与状态变更通知。

#### 构造与场景

```ts
new UniversalGameEngine(module, seed, {
  strict?: boolean;   // 默认 true
  scenario?: string;  // module.scenarios 中的命名场景
})
```

- 构造函数会校验钩子依赖图；
- `strict` 下校验初始状态不变量；
- `scenario` 写入 `exportLog()`，回放/恢复自动使用。

#### `dispatch()` 路由顺序

1. 游戏结束 → 拒绝；
2. `__TICK__` → `advanceClock()`；
3. 未知玩家 → 拒绝；
4. `validateActionShape()`；
5. 若时间线被回退过，截断未来历史；
6. 顶层 OPEN 决策且提交者参与 → `commitDecision()`；
7. 栈顶 `WAITING_INPUT` 且提交者有响应权 → `resolveResponse()`；
8. 普通动作 → `isLegal()` + `applyCore()`。

#### 普通动作管线

```
reduceWithPipeline:
  FILTER_MODIFY   → 可修改/取消动作
  BEFORE_REPLACE  → 可取消/替换动作
  module.reduce
  AFTER_TRIGGER   → 可产生后续动作
  followUpActions → 递归（深度上限 8）
```

被规则取消的动作：

- 不递增 `seq`；
- 不写动作日志；
- 不进入历史；
- 但仍会发出视觉事件并通知 UI。

#### 转移收尾

`finalizeTransition()` 顺序：

1. `stampDeadlines()`：给 OPEN 决策/响应窗口补默认 TTL；
2. 写入 `seq` 与 `actionLog`；
3. `module.outcome()`；结束则写 `gameOver/winner` 并广播；
4. `checkInvariants()`（strict）；
5. 提交 `this.state`；
6. `emitVisual()` + `notifyStateChange()`；
7. 成功后 `history.push(action)`。

#### 对外 API

| 方法 | 作用 |
| --- | --- |
| `dispatch(action)` | 唯一写入口；按 `actorId ?? playerId` 路由 |
| `getLegalActions(actorId)` | 焦点 actor（玩家或 NPC）的合法动作（含决策/响应） |
| `getFocusActors()` / `getFocusPlayers()` | 当前应行动者（含 NPC）/ 仅玩家 |
| `getActiveActorId()` / `getActor(id)` / `getActorName(id)` | actor 解析 |
| `getSelectionCandidates(actorId, spec)` | 声明式选择器的候选 |
| `getSpatialNeighbors` / `getSpatialReachable` / `getSpatialDistance` | 模块 `SpatialQuery` 的可达性与代价查询 |
| `getLineOfSight` / `getSpatialFloor` | 墙体/视线与楼层查询 |
| `getProjectedState()` / `getProjectedStateFor(viewer)` | 投影状态（含 `npcs`） |
| `setViewer(viewer)` | 切换观察视角并通知 |
| `getRawState()` | **服务端/测试专用**，UI 不应调用 |
| `getStateHash()` | 规范化哈希 |
| `getHistory()` / `getSeed()` / `getScenario()` | 审计信息 |
| `exportLog()` | 种子 + 场景 + 动作 + 哈希 + schema/engine version |
| `verifyReplay()` | 全量重放并比对哈希 |
| `replayTo(step)` / `rewindToStep(step)` | 时间机器 |
| `loadLog(payload)` | 重放式恢复；版本不匹配拒绝 |
| `onVisualEvent(cb)` / `onStateChange(cb)` | 订阅 |

### 4.2 `module.ts` — 游戏插件契约

```ts
interface GameModule {
  meta: GameMeta;                 // schemaVersion / engineVersion
  scenarios?: Record<string, GameScenario>;
  hooks: RuleHookImpl[];
  actionSchemas?: ActionSchemaMap;
  project?: ProjectionRedactor;
  resolveSelection?(state, actorId, spec): SelectionCandidate[];
  validateSelection?(state, candidate, targets, actorId): string[];
  spatial?: SpatialQuery;
  timing?: { decision?: number; response?: number };
  setup(seed): GameState;
  legalActions(state, actorId): Action[];   // players and NPCs
  reduce(state, action, ctx): GameState;
  outcome(state): GameOutcome;
  resolveDecision?(state, window, ctx): GameState;
  onDecisionResolved?(state, window, ctx): GameState;
}
```

`ReduceContext`：

```ts
{ id(kind), trace(event), seq, roll(spec, seed) }
```

`roll` 返回任意骰面的确定性结果（含 0 面）；reducer 负责把 `nextSeed` 写回 `state.prngState`。

- `id` 用于生成实体/事件 id，保证回放一致；
- `trace` 只产生视觉事件，不影响状态；
- 模块可以返回新对象，也可以基于克隆状态修改。

### 4.3 `decisions.ts` — 决策协调

实现：

- `openDecision`：校验参与者唯一、非空；
- `submitDecision`：拒绝重复提交与非参与者；
- `evaluateWindow`：返回 `ready/shortCircuited`；
- `orderedSubmissions`：
  - `PRIORITY` 按优先级降序；
  - `FIRST_ACCEPT` 截断到首个接受；
  - 其他保持座次；
- `resolveDecision`：写 `reveal`，把窗口标为 `RESOLVED`，只保留最近 4 个已结束窗口；
- `projectDecision`：秘密窗口未结算时，其他参与者的提交折叠为 `COMMITTED`；
- `actionsInWindow`：查询某人的提交动作。

### 4.4 `stack.ts` — LIFO 响应栈

- `push`：有响应者则 `WAITING_INPUT`，否则直接 `RESOLVING`；
- `peek` / `pop`；
- `submitResponse`：
  - 写入 `pendingResponses`；
  - 检查优先级短路（如麻将胡 30 > 碰 20 > 吃 10）；
  - 所有 eligible 已响应则 `resolved`；
- 引擎在响应提交后弹栈并执行帧 `actionPayload`；超时则全员 `PASS` 后弹栈。

### 4.5 `aop.ts` + `rules.ts` — 动态规则

`RuleHookImpl` 包含：

```ts
{
  id, name, stage, priority, description,
  requires?: HookId[],
  predicate?, handler?
}
```

- `RuleRegistry` 负责注册、按 id 查找、依赖校验、拓扑排序；
- `RulePipeline.activate` 检查 `requires` 是否已激活，防止顺序错误；
- `processAction` 执行 `FILTER_MODIFY` / `BEFORE_REPLACE`；
- `triggerAfter` 执行 `AFTER_TRIGGER`；
- 所有钩子实现都在模块代码中，状态只保存 `hookId + params`。

### 4.6 `observer.ts` — 信息投影

投影步骤：

1. 根据 `VisibilityRule` 判断每个实体是否可见；
2. 隐藏实体替换为**会话稳定的虚拟 ID**（`v_id_*`）；
3. 擦除隐藏实体的私有组件（卡面、点数等）；
4. 区域列表同步重映射；
5. 秘密决策提交折叠为 `COMMITTED`；
6. 规则钩子按 `visibility` 过滤；
7. 阵营关系按视角计算；
8. 模块 `project.player/globalVars` 可进一步擦除身份、私有全局变量；
9. 动作日志只保留 `type / playerId / 公开目标`，剥离 `entityId` 与 `payload`。

`maskedEntityCount` 供 UI/网络判断遮蔽规模。

### 4.7 `invariants.ts` — 结构不变量

每次 strict 转移后检查：

- 玩家集合、座次、activePlayer；
- 实体 id 与区域双向一致、唯一归属、无悬空引用；
- 图节点/边端点与占位；
- 栈帧 id 唯一、响应者合法；
- 决策参与者、提交键、deadline 合法性；
- 活动钩子实现存在；
- 计数器类型、PRNG 类型；
- 状态可 JSON 往返且哈希稳定。

违例返回 `{code, message}`，strict 下拒绝转移且不改状态。

### 4.8 `serialize.ts` — 规范化与哈希

- `canonicalize`：排序对象键、拒绝函数/循环/非有限数；
- `hashString`：FNV-1a 64-bit，16 位十六进制；
- `hashState`：`hashString(canonicalize(state))`；
- `cloneState`：JSON 深拷贝；
- `isSerializableState`：JSON 往返一致性。

### 4.9 `validation.ts` + `actionPayload.ts`

- `ActionSchemaMap` 为每个动作声明 `fields` / `payload` / `allowPayload`；
- `validateActionShape` 只做结构校验，不做语义合法性；
- `withDefaultPayload(action)`：为带 `fields` 的动作填默认值（机器人/测试用）。

### 4.10 `ecs.ts` / `graph.ts` / `prng.ts`

| 模块 | 实现 |
| --- | --- |
| `ECSManager` | 创建区域、添加实体、移动实体（同区移动不重复）、更新组件、按区域查询 |
| `MapGraphManager` | 空图、节点/边、占位；`generateCatanHexDualGraph` 生成 19 六边形 + 54 顶点 + 72 边；房间图与圆桌座位也复用该结构 |
| `DeterministicPRNG` | Mulberry32；`next` / `nextInt` / `shuffle` / `rollDice`，全部纯函数返回 `nextSeed` |

---

## 5. 应用层

目录：[packages/app/src](../packages/app/src)

### 5.1 `contracts.ts` — UI 契约

UI 只认识以下 DTO：

| DTO | 内容 |
| --- | --- |
| `GameSnapshot` | 阶段、回合、时钟、焦点、玩家、动作、栈、决策、钩子、日志、投影棋盘 |
| `UiAction` | id、图标、标签、提示、语气、高亮目标、参数字段 |
| `UiActionField` | `enum` / `number`，选项、范围、默认值 |
| `UiPlayer` | 分数、角色、HP、pips、统计行 |
| `UiStackFrame` / `UiDecision` / `UiHook` | 栈帧、决策、规则钩子 |
| `UiLog` / `UiReplay` | 日志、游标、种子、哈希、重放结果 |
| `GamePresenter` | UI 唯一回调接口 |
| `PresentationPorts` | 相机、音效、检查器开关、桌面高亮 |

`GamePresenter`：

```ts
getSnapshot()
subscribe(listener)
onNotice(listener)
perform(actionId, payload?)
pickTarget(BoardPick)
setViewer(viewer)
rewind(step)
verifyReplay()
advanceClock(ticks)
dispose()
```

### 5.2 `session.ts` — Presenter 实现

`UniversalSession implements GamePresenter`，持有唯一引擎实例。

#### 启动

```ts
new UniversalSession(module, seed = 1, scenario?)
```

- 创建引擎；
- 订阅 `onStateChange`：`revision++`、清空重放结果、`rebuild()`、`publish()`；
- 订阅 `onVisualEvent`：转换为 UI notice（announce / event / error）。

#### `rebuild()` — 快照生成

1. `engine.getProjectedState()` 取得当前视角投影；
2. `engine.getRawState()` 仅用于日志游标与总步数；
3. 计算焦点与行动者；
4. 若存在 OPEN 决策：
   - `acting = 未提交的参与者`；
   - 聚合所有 acting 的合法动作（每人一份）；
   - `actorName` 显示“N 名玩家待提交”；
5. `buildActions()` 分组、去重、生成 UI 动作；
6. 构建玩家卡片、栈、决策、钩子、日志、棋盘；
7. 发布给 HUD/Inspector。

#### 动作绑定

- 桌面目标动作（建造、移动、偷取）按类型 + 目标 id 聚合成一个高亮按钮；
- HUD 点击高亮按钮 → `ports.highlightBoard(ids)`，用户在 3D 桌面点击 → `pickTarget()`；
- `pickTarget()` 将 `node/edge/entity/dice` 映射到合法动作并 dispatch；
- 普通动作直接 `perform()`；
- 带 `fields` 的动作由 HUD 表单收集 `payload`，`perform(actionId, payload)` 合并后 dispatch。

#### 去重与排序

- 去重键包含 `playerId + type + target + payload`，保证多参与者决策每人一份；
- 桌面目标动作按类型分组，避免几十个顶点生成几十个按钮；
- 最终动作数截断到 14 个，避免 dock 溢出。

#### 游戏相关翻译

应用层负责把领域状态翻译成 UI：

- 动作图标/中文标签/提示；
- 玩家卡片：Catan 资源/建筑/最长道路，三国杀 HP/手牌/装备，山屋四项属性，沙丘香料/军团；
- 阶段文案：Catan 的 ROLL/ACTION/DISCARD/ROBBER/STEAL/ROAD BUILDING/TRADE PENDING 等；
- 决策标题、参与者、策略标签；
- 日志脱敏后的行数据。

#### 其他方法

| 方法 | 行为 |
| --- | --- |
| `perform` | 查找绑定动作、合并 payload、dispatch、错误转 notice |
| `pickTarget` | 桌面点击 → 合法动作 |
| `setViewer` | 切换引擎视角并发布 |
| `rewind` | `engine.rewindToStep`，重建快照 |
| `verifyReplay` | 重放校验并写入 `lastReplay` |
| `advanceClock` | 发送 `__TICK__` 控制动作 |
| `dispose` | 取消所有订阅 |

---

## 6. UI 层

目录：[apps/web/src/ui](../apps/web/src/ui)

### 6.1 `hud.ts` — 头部、玩家栏、动作栏

骨架：

- 顶部品牌 + 六款游戏切换；
- `𝒪 滤镜` 视角选择；
- 相机（等轴/俯视/座位）、音效、数学检查器开关；
- 左侧玩家卡片栏；
- 底部动作 dock；
- 公告横幅、toast 栈；
- payload 表单层。

渲染逻辑：

- 只读 `GameSnapshot`，不 import 引擎/游戏/渲染；
- `renderPlayers`：玩家颜色、分数、角色、HP 段、资源 pips、统计行；
- `renderDock`：
  - 决策窗口 → 显示秘密/普通决策条与参与者提交状态；
  - 响应窗口 → 显示栈顶与 pending 玩家；
  - 动作按钮 → 图标、标签、提示、快捷键序号；
  - 带 `fields` 的动作 → 打开通用表单；
- `promptAction`：键盘 1-9 与点击共用入口；
- `openPayloadForm`：枚举下拉/数字输入，提交时 `presenter.perform(id, payload)`；
- `pushToast` / `showAnnouncement`：视觉通知，胜利时触发 confetti。

### 6.2 `mathInspector.ts` — 数学模型检查器

五个页签：

| 页签 | 内容 |
| --- | --- |
| `𝒢 九元组` | 公式、九元组实时绑定、当前局面、能力矩阵、`globalVars`、转移管线、投影比例 |
| `Σ 响应栈` | 栈高、栈帧、响应窗口、空栈说明与中断链示例 |
| `Φ 阵营` | 关系矩阵、角色投影、图例 |
| `𝒦 元规则` | 活动钩子、阶段、优先级、依赖实例 |
| `↺ 溯源` | 时间机器滑块、重放校验、动作日志 |

实现细节：

- 订阅 `GamePresenter`，自动刷新；
- 栈深增加时自动切到 `Σ`；
- 重放校验通过 `presenter.verifyReplay()`；
- 时钟 `⏱ / +8` 调用 `presenter.advanceClock()`；
- 所有数据来自 `GameSnapshot`，不直接读引擎。

### 6.3 `styles.css`

单文件设计系统：

- 深色桌游视觉、金色强调；
- HUD 玻璃面板、玩家卡、dock、toast、公告；
- 数学检查器公式、九元组网格、栈帧、矩阵、日志、时间轴；
- payload 表单与遮罩；
- 响应式尺寸与滚动。

---

## 7. 渲染层

目录：[apps/web/src/render](../apps/web/src/render)

### 7.1 `scene.ts`

职责：

- 初始化 Three.js scene / camera / renderer / OrbitControls / lights；
- 按游戏设置 framing（Catan 岛、三国杀圆桌、山屋房间、沙丘/麻将桌面）；
- `syncState(projectedState)`：
  1. 清空交互注册与上一帧棋盘对象；
  2. `renderMapGraph`：六边形地块、顶点、边、房间、座位；
  3. `renderEntities`：卡牌、token、建筑、骰子、手牌、装备、判定区、牌堆；
  4. `applyHighlights`；
- `setHighlight(ids)` 重新渲染并脉冲高亮；
- 交互对象注册到 `BoardRaycaster`，点击回调到 `main`；
- 游戏装饰：Catan 港口标签/发展牌堆、三国杀桌垫、Betrayal 作祟法阵、沙丘战斗轮盘/麻将桌。

渲染约定：

- 渲染层只接收 `ProjectedGameState`；隐藏实体已被 `isMasked` 擦除；
- 每次 revision 全量重建棋盘对象（简单、无残留；代价是较大对局的重绘成本）；
- 实体网格映射：`entityMeshes` / `nodeMeshes` / `edgeMeshes`。

### 7.2 程序化资源

| 文件 | 内容 |
| --- | --- |
| `procedural/hexTile.ts` | 六边形地形贴图/网格（森林、牧场、耕地、丘陵、矿山、沙漠） |
| `procedural/cardMesh.ts` | 卡牌正反面、标题/花色/费用/描述 |
| `procedural/diceMesh.ts` | D6 网格与点数 |
| `procedural/roomTile.ts` | 山屋房间地块 |
| `procedural/tokenMesh.ts` | 资源/筹码/标记 |
| `table.ts` | 木桌与绒布桌面纹理 |

### 7.3 `raycaster.ts`

- 注册交互网格与 `InteractiveObjectData`（`ENTITY/NODE/EDGE/DICE`）；
- 指针移动 hover 材质高亮；
- 点击回调；
- 与相机、DOM 尺寸同步。

### 7.4 `animationQueue.ts`

- 串行消费 `VisualTraceEvent`；
- 按事件类型播放音效、屏幕震动；
- `animateArc` 提供抛物线移动；
- 暴露 `onEventStart` / `onQueueDrained`；
- **当前装配状态**：`main.ts` 尚未把 `session` 的视觉事件接入 `scene.getAnimationQueue()`；动画队列是已实现但未接入的基础设施（详见技术债）。

### 7.5 `audio.ts`

- WebAudio 合成音效：抽牌、骰子、筹码、建造、作祟警报、胜利号角；
- `toggleSound` / `isSoundEnabled`；
- 由 `PresentationPorts.setSound` 控制。

---

## 8. 网络与持久化

目录：[packages/net/src](../packages/net/src)

### 8.1 `room.ts`

`GameRoom` 是权威房间适配器：

- 持有一个引擎（可选注入：房主侧与 `UniversalSession` 共用同一实例，见 §8.4）；
- 每个 viewer 独立投影缓存；
- `revision` 由引擎的真实状态跃迁推进——房主本地 dispatch 与房客远程 submit 走同一条路径；
- 对外只返回 `RoomUpdate`，不返回原始状态。

| 方法 | 行为 |
| --- | --- |
| `join(viewer, token?)` | 授权通过后全量投影 + 建立缓存 |
| `leave(viewer)` | 删除缓存 |
| `submit(action)` | `engine.dispatch`（revision 由状态通知推进，不再手工 +1） |
| `snapshot(viewer)` | 指定视角全量 |
| `delta(viewer)` | 基于缓存的投影 diff |
| `applyClientDelta(previous, update)` | 客户端应用补丁 |
| `onChange(listener)` | 任一真实状态跃迁后回调（transport 用它统一推送 delta） |
| `setAuthorizer(fn)` | 运行期替换座位授权器（座位绑定见 §8.4） |
| `exportState()` / `restore(payload)` | 引擎日志 + revision；重放式恢复（含 scenario） |

`revision` 用引擎状态哈希去重：`setViewer()` 之类「只看、不改规则状态」的通知不会虚增计数。
投影 diff 在**已脱敏的投影**上计算，因此隐藏信息不会出现在补丁里。

### 8.2 `patch.ts`

- `diffJson`：对象递归 diff；数组整体替换；根变化替换 `/`；
- `applyPatch`：RFC6902 风格 `add/replace/remove`；
- 转义 `~0` / `~1`。

### 8.3 持久化语义

检查点不是“状态 dump”，而是：

```
{ moduleId, seed, scenario?, actions, stateHash, revision }
```

恢复流程：

1. 用 `module + seed + scenario` 重建初态；
2. 逐条重放动作；
3. 校验哈希；
4. 恢复 revision，清空观察者缓存。

这保证跨进程/跨实例的可重建性，也避免“快照格式升级”导致的状态不兼容。

### 8.4 `webrtc-transport.ts`（浏览器 P2P）

- `WebRtcHostTransport`：把 DataChannel 桥到 `GameRoom`。构造时订阅 `room.onChange`，
  任一跃迁都向每个已入座 viewer 推送一次 per-viewer delta（不再由 submit 手工触发，避免重复推送）；
- `WebRtcGuestTransport`：不持引擎，只消费自己的投影 `O(s,i)`，`submit` 转发动作；
- **座位绑定**：`join` 时若配置了 `seatOwners`（座位 → hub userId），只有该 userId 能加入
  对应座位，避免房客抢先占座后以他人身份操作；未配置时保持「先到先得」（脚本/单机路径）。
  房间侧再用 `GameRoom.setAuthorizer` 二次校验，防御纵深；
- 同一 peer 只能持有一个座位；`submit` 的 `actorId` 必须等于该 peer 的座位；
- **单一权威引擎（中期项 A2）**：房主侧 `UniversalSession`（HUD）与 `GameRoom`（权威房间）
  共享同一个 `UniversalGameEngine`。HUD 的本地 dispatch 直接就是权威状态跃迁，
  同步链从「双引擎 + 尾部重放 action log」简化为「一次 dispatch + 一次 delta 推送」，
  两引擎分歧/丢步/重放错位在结构上不再可能；
- **反作弊边界**：房主是**信任对等体**——本仓库没有服务端权威引擎（见
  [BACKLOG.md](BACKLOG.md) §0.2 的确认边界）。内核仍对每个动作做结构与合法性校验，
  隐藏信息只经投影离开房主浏览器；要抵御恶意房主需要把 `GameRoom` 部署成真正的
  服务端进程（seam 已就绪，不在当前范围）。

---

## 9. AI 层

目录：[packages/harness/src](../packages/harness/src)

### 9.1 `policy.ts`

```ts
interface BotPolicy {
  id: string;
  choose(engine: UniversalGameEngine, playerId: PlayerId): Action | null;
}
```

- `RandomPolicy`：从合法动作中确定性随机选择；
- 自动用 `withDefaultPayload()` 填充参数字段，避免带 `fields` 的动作被 Schema 拒绝；
- `runPolicies(engine, policies, maxSteps)`：
  - 按焦点顺序让策略行动；
  - 记录非法动作错误；
  - 返回 `steps / errors / finished`。

AI 只看到 `engine.getLegalActions`，不直接读原始状态；这是后续接入 MCTS/ISMCTS 的接口边界。

---

## 10. 游戏夹具

目录：[packages/games/src](../packages/games/src)

### 10.1 注册表

[registry.ts](../packages/games/src/registry.ts) 用 `defineGame()` 注册五个模块：

| 模块 | topology | hidden | interrupt | simultaneous | dynamic rules | 主要机制 |
| --- | --- | --- | --- | --- | --- | --- |
| Catan | hex-dual | ✓ | – | ✓ | – | 蛇形布局、港口、银行、发展卡、强盗、最长道路/最大军队、隐藏 VP |
| Sanguosha | ring | ✓ | ✓ | – | ✓ | 递归响应栈、身份暗置、八卦阵钩子 |
| Splendor | none | – | – | – | – | 三阶市场、宝石 token、永久费用、贵族 |
| Betrayal | graph | ✓ | ✓ | – | ✓ | 44 房间、四维轨道、13 预兆/25 物品/45 事件、怪物、三剧本 |
| Dune / Mahjong | none | ✓ | ✓ | ✓ | – | 秘密同步盲提、优先级仲裁短路 |

Catan 已注册命名场景：

```ts
scenarios: {
  rich_action,   // 完成布局、p1 资源充足、手牌含丰饶/垄断
  trade_ready    // 完成布局、p1 木材、p2 砖
}
```

UI 可用 `?scenario=rich_action` 直达。

### 10.2 Catan 实现

文件：

- [setup.ts](../packages/games/src/catan/setup.ts)：19 地形、18 数字、9 港口、25 发展卡、银行、蛇形顺序；
- [helpers.ts](../packages/games/src/catan/helpers.ts)：资源/银行、建造、距离规则、港口比例、最长道路、最大军队、计分、发展卡迁移；
- [rules.ts](../packages/games/src/catan/rules.ts)：阶段机、合法动作、reducer、决策回调、胜利条件；
- [scenarios.ts](../packages/games/src/catan/scenarios.ts)：可重放测试场景。

#### 初始状态

- 3 名玩家；
- 19 张地形：4 木、4 羊、4 麦、3 砖、3 矿、1 沙漠；
- 18 个数字片（无 7），沙漠放强盗；
- 9 个港口：5 个资源专属 2:1 + 4 个通用 3:1；
- 银行每种资源 19；
- 发展牌堆 25 张：14 骑士、2 垄断、2 修路、2 丰饶、5 分数卡；
- 蛇形顺序 `p1,p2,p3,p3,p2,p1`。

#### 阶段

```
SETUP_SETTLEMENT → SETUP_ROAD → ... → ROLL → ACTION
                                           ├─ DISCARD（7 点决策窗口）
                                           ├─ MOVE_ROBBER → STEAL
                                           ├─ ROAD_BUILDING（修路卡）
                                           └─ TRADE_PENDING（FIRST_ACCEPT 交易）
```

#### 主要动作

| 分类 | 动作 |
| --- | --- |
| 布局 | `SETUP_SETTLEMENT` / `SETUP_ROAD` |
| 回合 | `ROLL_DICE` / `END_TURN` |
| 建造 | `BUILD_ROAD` / `BUILD_SETTLEMENT` / `UPGRADE_CITY` |
| 发展卡 | `BUY_DEV_CARD` / `PLAY_KNIGHT` / `PLAY_ROAD_BUILDING` / `PLAY_YEAR_OF_PLENTY` / `PLAY_MONOPOLY` |
| 强盗 | `DISCARD_HALF` / `MOVE_ROBBER` / `STEAL_FROM` |
| 修路卡 | `BUILD_ROAD_FREE` / `SKIP_ROAD_BUILDING` |
| 交易 | `BANK_TRADE` / `PROPOSE_TRADE` / `ACCEPT_TRADE` / `REJECT_TRADE` |

#### 规则实现要点

- **资源守恒**：生产、建造、银行交易、玩家交易、弃半、垄断都在玩家与银行间移动，总额恒为 95；
- **银行有限**：生产按银行库存截断；银行交易需要目标资源有库存；
- **港口比例**：`portRatio()` 检查玩家建筑是否占用港口两端顶点，返回 4/3/2；
- **7 点**：>7 张者打开 `DISCARD` 决策窗口，全部提交后进入 `MOVE_ROBBER`；
- **强盗**：移动后只对相邻、非当前玩家且有资源者进入 `STEAL`；
- **发展卡**：购买当回合不可打出；骑士计最大军队；修路卡进入两连免费道路；丰饶/垄断用单动作 + payload；
- **最长道路**：在自有道路图上做有界 DFS，对手建筑阻断，≥5 生效，平局保持原持有者；
- **最大军队**：骑士数 ≥3，平局保持原持有者；
- **计分**：定居点 1、城市 2、VP 卡 1、最长道路 2、最大军队 2；10 分胜利；
- **隐藏 VP**：模块 `project.player` 对非本人/非 GOD 扣掉隐藏分数卡，游戏结束时揭晓；
- **交易**：`FIRST_ACCEPT`，首个接受立即结算并回到 ACTION；
- **场景**：`rich_action` 与 `trade_ready` 可用于测试/演示。

#### 简化

| 简化 | 现状 |
| --- | --- |
| 弃半选择 | 自动按最大堆优先，不暴露逐张选择 UI |
| 玩家交易数量 | 固定 1:1 |
| 发展卡时机 | 仅 ACTION 阶段可打出（官方允许掷骰前） |
| 资源表示 | 计数器而非实体卡牌 |
| 港口布局 | 程序化均布在海岸边，不是固定官方港口位置 |
| 银行短缺 | 按库存截断，不实现“按座次分配” |
| 先手 | 固定 p1 |

### 10.3 Sanguosha 实现

文件：[setup.ts](../packages/games/src/sanguosha/setup.ts) · [rules.ts](../packages/games/src/sanguosha/rules.ts) · [hooks.ts](../packages/games/src/sanguosha/hooks.ts)

- 4 名玩家：主公、忠臣、反贼、内奸；
- 圆桌座位图 + 手牌/装备/判定区；
- 卡牌：杀、闪、桃、无懈可击、过河拆桥、顺手牵羊、南蛮入侵、八卦阵、青龙偃月刀；
- `PLAY_STRIKE` 入栈 `STRIKE_RESOLUTION`，目标可出闪/八卦/放弃；
- 伤害帧可链到 `CHECK_DEATH` / `DYING_RESCUE`（桃）；
- 锦囊与无懈可击可递归压栈；
- `bagua_armor` 是 `BEFORE_REPLACE` 钩子，在目标被【杀】时提示并可进入八卦判定；具体判定与“视为闪”的结算在 rules 中；
- 身份通过 `project.player` 对非主公/非本人擦除。

### 10.4 Splendor 实现

文件：[setup.ts](../packages/games/src/splendor/setup.ts) · [rules.ts](../packages/games/src/splendor/rules.ts)

- 2 名玩家；
- 三阶市场、贵族、宝石银行（含黄金）；
- 动作：取 3 种不同宝石、取 2 同色、购买、预留；
- 购买时扣费、增加永久宝石折扣、检查贵族访问；
- 15 分胜利。

### 10.5 Betrayal 实现

文件：[cards.ts](../packages/games/src/betrayal/cards.ts) · [haunts.ts](../packages/games/src/betrayal/haunts.ts) · [helpers.ts](../packages/games/src/betrayal/helpers.ts) · [setup.ts](../packages/games/src/betrayal/setup.ts) · [rules.ts](../packages/games/src/betrayal/rules.ts) · [scenarios.ts](../packages/games/src/betrayal/scenarios.ts) · [hooks.ts](../packages/games/src/betrayal/hooks.ts)

这是当前最完整的规则夹具（详见 [BETRAYAL.md](BETRAYAL.md)）：

- 44 块房间（5 起始 + 39 牌堆），房间板块是 `zone_room_deck` 的 TILE 实体；单一牌堆按楼层过滤、按门位旋转、按符号停步；
- 6 名角色、四维属性轨道、作祟前锁血、作祟后 0 点死亡、死亡物品堆；
- 13 张预兆 / 25 张物品 / 45 张事件（15 原始 + 30 原型补位）；
- 作祟检定走 `HAUNT_CHECK` 中断栈，超时自动掷骰；
- 3 个完整剧本（木乃伊 / 巨眼 / 怨灵），怪物是 NPC actor，叛徒逐只 `MOVE_NPC`/`ATTACK_HERO`/`END_NPC_TURN`；
- 伤害分配、交易、水晶球窥视走决策窗口；剧本钩子走 AOP；
- `MOVE_TO_ROOM` 使用 `SelectionSpec`（一个动作 + 候选房间），UI 弹选择器；探索拆成 `EXPLORE_DOOR`（抽板块）+ `PLACE_ROOM`（桌面预载、旋转/确认），相邻房间的双向门自动连通；
- 相机取景是表现层策略：`packages/app/src/layout.ts` 提供按游戏 id 的 padding/初始方向，renderer 只按图包围盒适配，不做 gameId 分支；
- 三层空间在表现层用分区呈现，对手目标由 `project.globalVars` 裁剪；
- 23 条专项测试覆盖探索、朝向选择、相邻门连通、战斗、偷窃、远程、麻绳、击晕、NPC 回合、三剧本胜负与回放。

实现山屋时发现的内核表达力缺口（非玩家行动者、批量掷骰、空间几何、派生属性、卡牌 DSL 等）集中记录在 [BETRAYAL.md 第 8 节](BETRAYAL.md#8-模拟器缺陷清单)；逐项改造方案与执行面见 [KERNEL-EXPRESSION.md](KERNEL-EXPRESSION.md)；持续维护的运行期问题清单见 [SIMULATOR-AUDIT.md](SIMULATOR-AUDIT.md)；已确认边界与可选开发见 [BACKLOG.md](BACKLOG.md)。

### 10.6 Dune / Mahjong 实现

文件：[setup.ts](../packages/games/src/dune_mahjong/setup.ts) · [rules.ts](../packages/games/src/dune_mahjong/rules.ts)

- 3 个家族，香料/军团/将领/武器；
- 沙丘模式：`OPEN_BATTLE_WINDOW` 打开秘密同步决策，双方提交 `COMMIT_BATTLE_DIAL`（不可见），全部提交后揭晓并结算；
- 麻将模式：打出九条触发吃/碰/胡响应栈，优先级 30/20/10，胡立即短路；
- 25 分胜利；
- 演示模式切换动作 `SWITCH_TO_DUNE_DEMO` / `SWITCH_TO_MAHJONG_DEMO`。

### 10.7 德州扑克实现

文件：[cards.ts](../packages/games/src/poker/cards.ts) · [handEval.ts](../packages/games/src/poker/handEval.ts) · [betting.ts](../packages/games/src/poker/betting.ts) · [setup.ts](../packages/games/src/poker/setup.ts) · [rules.ts](../packages/games/src/poker/rules.ts) · 设计说明见 [POKER.md](POKER.md)

- 52 张牌是 `card_<suit><rank>` 实体（`card_s14` = A♠），一手结束时全部回到 `zone_deck`，用 `DeterministicPRNG.shuffle(state.prngState, …)` 重洗并把 `nextSeed` 写回状态；
- 底牌是 `zone_hand_pN` 里的普通 CARD 实体（`OWNER_ONLY`），因此投影自动打码，夹具不需要 `project` 钩子；摊牌时把可见性改成 `PUBLIC`，弃牌进 `HIDDEN` 的 `zone_muck`；
- 下注状态放在 `globalVars.hand`（街、底池、`streetBets`/`handBets`、`currentBet`、`lastRaiseSize`、`actedSinceRaise`、弃牌/全押名单），只含公开信息；
- 动作：`START_HAND` / `FOLD` / `CHECK` / `CALL` / `RAISE`（声明式 `fields.amount` 数字输入）/ `ALL_IN`；
- 一次 `reduce` 内可以连续收注、发街、摊牌（全押后自动跑完剩余公共牌），状态机保持单调且可逐位回放；
- 边池由 `betting.buildPots` 按 `handBets` 分层计算，最高层只有一名贡献者时即为未跟注部分自动退回；平分余数按庄家左手顺位发放；
- 短全押（不足最小加注）不更新 `lastRaiseSize`、不清空 `actedSinceRaise`，已行动者不再获得加注权；
- 座位是 `SEAT` 节点 + 显式世界坐标（`spatialProjection` 的 `ring` 只支持 4 个 90° 步长座位），2–10 人按椭圆半径计算；
- 终局：一手结算后任一玩家 `chips === 0` 即 `gameOver`，筹码最多者胜（并列并列胜）。

---

## 11. 组合根与启动流程

实现：[apps/web/src/main.ts](../apps/web/src/main.ts)

### 11.1 启动

`index.html` 提供挂载点：

```html
<div id="canvas-container"></div>
<div id="hud-container" class="ui-layer"></div>
<div id="inspector-container" class="ui-layer"></div>
<div id="toast-container" class="toast-stack"></div>
<div id="boot-screen">…</div>
```

`BoardGameSimulatorApp` 构造：

1. 读取 `?scenario=`；
2. 创建 `BoardGameScene`；
3. 创建 `UniversalSession(module, 42, scenario)`；
4. 创建 `PresentationPorts`：
   - 相机 → `scene.setCameraPreset`；
   - 音效 → `BoardGameAudio`；
   - 检查器 → `toggleInspector`；
   - 高亮 → `scene.setHighlight`；
5. 创建 HUD 与 Inspector，传入同一 presenter；
6. 注册桌面点击 → `session.pickTarget`；
7. 订阅 session：revision 变化时 `scene.syncState`；
8. 启动画面、键盘绑定、调试句柄 `window.__boardGameApp`。

### 11.2 游戏切换

`switchGame(gameId)`：

1. `session.dispose()`；
2. 创建新 session；
3. HUD/Inspector `setPresenter`；
4. 重新绑定订阅；
5. `scene.setGameFraming` + `syncState`；
6. 相机复位、公告。

### 11.3 键盘

| 键 | 行为 |
| --- | --- |
| `1–9` | 触发动作栏第 N 个动作（带 fields 时打开表单） |
| `I` | 收起/展开检查器 |
| `Esc` | 关闭 payload 表单、清除桌面高亮 |

---

## 12. 测试与质量保障

### 12.1 运行方式

```bash
pnpm test      # Vite SSR 加载 TS 套件 + 边界检查
pnpm exec tsc --noEmit
pnpm build
```

测试运行器：[scripts/test-core.mjs](../scripts/test-core.mjs)

- 用 Vite `middlewareMode` 加载 `/packages/harness/src/suite.ts`；
- 逐条打印用例与耗时；
- 跑架构边界静态检查；
- 任一失败退出码为 1。

### 12.2 当前结果

```text
206 passed, 0 failed, 206 cases, 0 boundary violations
```

构成：

- 191 条显式用例（内核 + 应用层 + 网络 + 五个夹具专项）；
- 5 个夹具 × 3 条矩阵用例（初始化/随机回放/投影安全）= 15；
- 架构边界检查 1 组。

### 12.3 覆盖范围

| 类别 | 代表用例 |
| --- | --- |
| 基础设施 | 规范化哈希、PRNG、ECS 归属 |
| 决策 | 秘密提交、优先级短路、`FIRST_ACCEPT` 两种结局 |
| 栈/AOP | LIFO、优先级短路、四阶段修改/取消/后续动作 |
| 投影 | 虚拟 ID、区域重映射、秘密折叠、模块 redactor、日志脱敏 |
| 引擎 | 非法动作不改状态、确定性回放、时间机器、命名场景、逐人超时 |
| 校验 | Schema 结构校验与语义合法性的边界 |
| 规则图 | 缺失依赖、环、激活前置 |
| Catan | 蛇形布局、7 点强盗、费用/银行守恒、发展卡、交易、港口、隐藏 VP、胜利 |
| 山屋 | 探索/朝向选择/相邻门、楼层过滤、作祟栈、伤害分配、偷窃、远程、麻绳、击晕、NPC 回合、三剧本胜负、回放（23 条，见 [BETRAYAL.md](BETRAYAL.md)） |
| 其他夹具 | 沙丘秘密决策、三国杀响应栈、璀璨宝石 |
| 应用层 | DTO、按 id 执行、桌面拾取、视角、通知、payload 单步动作、时钟 |
| 网络 | 投影 diff 往返、隐藏信息不泄漏、非法动作不增 revision、检查点恢复 |

### 12.4 视觉验收脚本

- `node scripts/shoot.mjs`：跨游戏截图与 console error 捕获；
- `node scripts/sizes.mjs`：多分辨率布局截图；
- Playwright 可直接驱动 HUD 表单（如 `?scenario=rich_action` 的银行交易/丰饶）。

---

## 13. 扩展指南

### 13.1 新增一款游戏

1. 新建 `packages/games/src/<id>/setup.ts`：
   - 返回完整 `GameState`（`players / zones / entities / mapGraph / globalVars / pendingDecisions / activeHooks`）；
   - 所有随机性使用 `DeterministicPRNG`；
2. 新建 `rules.ts`：
   - 实现 `getLegalActions(state, playerId)`；
   - 实现纯 reducer `applyAction(state, action, ctx)`；
   - 实现 `checkWinCondition`；
   - 需要决策时调用 `openDecision`，需要响应时压栈；
3. 可选 `hooks.ts`：
   - 导出 `RuleHookImpl[]`；
   - 用 `requires` 声明依赖；
4. 可选 `scenarios.ts`：
   - 提供可重放测试起点；
5. 在 `registry.ts` 用 `defineGame()` 注册：
   - `meta/capabilities`；
   - `actionSchemas`；
   - `project`（隐藏字段）；
   - `timing`（决策/响应 TTL）；
   - `onDecisionResolved`；
6. 在 `suite.ts` 增加初始化、随机回放、投影安全与专项规则测试；
7. `pnpm test` 全绿。

### 13.2 新增决策策略

1. 在 `DecisionPolicy` 增加类型；
2. 在 `evaluateWindow` 增加 READY 判定；
3. 在 `orderedSubmissions` 定义执行顺序与截断；
4. 增加策略测试；
5. 检查超时逻辑：`advanceClock` 对 `READY` 的处理是否覆盖。

### 13.3 新增带参数动作

1. `Action.fields` 声明字段（enum/number、默认值、范围）；
2. `actionSchemas` 声明 `payload` 必填/枚举；
3. reducer 校验并消费 `payload`；
4. UI 自动渲染表单，无需改 HUD；
5. 机器人/测试用 `withDefaultPayload()`。

### 13.4 新增命名场景

```ts
scenarios: {
  my_scenario: {
    description: '...',
    setup: seed => buildState(seed)
  }
}
```

- `new Engine(module, seed, { scenario })`；
- `exportLog()` 自动记录；
- `loadLog()` / `GameRoom.restore()` 自动使用；
- UI 用 `?scenario=my_scenario` 直达。

---

## 14. 已知简化与技术债

### 14.1 游戏规则简化

- Catan：弃半自动、玩家交易固定 1:1、发展卡仅 ACTION、资源计数器、程序化港口、银行短缺截断；
- 三国杀/沙丘/璀璨宝石为演示级规则覆盖；山屋为 44 房间 + 三剧本的深度夹具，但仍不是商业规则全集（见 [BETRAYAL.md](BETRAYAL.md)）。

### 14.2 架构与运行时

| 项 | 现状 |
| --- | --- |
| 传输层 | `GameRoom` 是内存权威房间；有 `RoomTransport` + `RoomHttpAdapter` seam，但仍未接真实 WebSocket/HTTP 服务器 |
| 动画队列 | `main.ts` 已把 `session.onVisualEvent` 接到 `scene.enqueueAnimations`；逐事件动画/音效可播放 |
| 渲染同步 | 放置预览/旋转跳过棋盘重建；旧对象 dispose、阴影按需更新；当前实体规模保留全量重建作为 correctness-first 兜底，完整 diff 记录为后续 backlog |
| payload 表单 | 支持 `enum / number / boolean / string / json` + `dependsOn` 条件显隐；模块可用 `validatePayload` 做跨字段校验；嵌套对象/数组走 JSON 文本 |
| 决策超时 UI | 快照已暴露 `deadline / remaining`，HUD 显示 tick 倒计时 |
| 房间客户端 | `GameRoom.actions(viewer)` / `RoomPresenter` 已可生成 `UiAction` 并转发 submit；真正的网络客户端仍未接 |
| 鉴权 | `GameRoom` 构造时可注入 `RoomAuthorizer`，`join(viewer, token)` 拒绝未授权；默认不启用 |
| 本地化 | 动作标签走 `app/actionText.ts` + `app/i18n` locale registry；静态 UI/chrome 仍有中文硬编码 |
| Catan 场景 | `rich_action` 是确定性测试夹具；官方版图不属于内核契约 |

### 14.3 明确的边界

- UI 不得直接读 `getRawState()`；当前代码满足该边界，静态检查只覆盖 import；
- `window.__boardGameApp` 仅在 Vite `DEV` 下挂载，生产构建不暴露调试入口；
- `getRawState()` 仅供服务端、测试与调试工具；
- 动作日志的 `payload` 只在服务端日志中保留，投影日志永远剥离。

---

## 15. 文件索引

### 15.1 内核

| 文件 | 作用 |
| --- | --- |
| [core/types.ts](../packages/kernel/src/types.ts) | 全部状态/动作/栈/决策/钩子类型 |
| [core/engine.ts](../packages/kernel/src/engine.ts) | 调度、校验、决策/响应、时钟、回放 |
| [core/module.ts](../packages/kernel/src/module.ts) | `GameModule` / `ReduceContext` / `GameScenario` |
| [core/decisions.ts](../packages/kernel/src/decisions.ts) | 决策窗口与策略 |
| [core/stack.ts](../packages/kernel/src/stack.ts) | LIFO 响应栈 |
| [core/aop.ts](../packages/kernel/src/aop.ts) | 规则 AOP 管线 |
| [core/rules.ts](../packages/kernel/src/rules.ts) | 钩子注册表、依赖图、拓扑排序 |
| [core/observer.ts](../packages/kernel/src/observer.ts) | 信息投影与反作弊 |
| [core/invariants.ts](../packages/kernel/src/invariants.ts) | 结构不变量 |
| [core/serialize.ts](../packages/kernel/src/serialize.ts) | 规范化 JSON 与哈希 |
| [core/validation.ts](../packages/kernel/src/validation.ts) | 动作 Schema |
| [core/actionPayload.ts](../packages/kernel/src/actionPayload.ts) | 字段默认值填充 |
| [core/ecs.ts](../packages/kernel/src/ecs.ts) | 区域/实体管理 |
| [core/graph.ts](../packages/kernel/src/graph.ts) | 拓扑与 Catan 六边形双图 |
| [core/prng.ts](../packages/kernel/src/prng.ts) | Mulberry32 |
| [core/testing/suite.ts](../packages/harness/src/suite.ts) | 一致性测试套件 |

### 15.2 应用与 UI

| 文件 | 作用 |
| --- | --- |
| [app/contracts.ts](../packages/app/src/contracts.ts) | UI DTO / Presenter / Ports |
| [app/session.ts](../packages/app/src/session.ts) | Presenter 实现、快照构建、动作绑定 |
| [ui/hud.ts](../apps/web/src/ui/hud.ts) | 顶部/玩家栏/动作栏/表单 |
| [ui/mathInspector.ts](../apps/web/src/ui/mathInspector.ts) | 五页签数学检查器 |
| [ui/styles.css](../apps/web/src/ui/styles.css) | 设计系统 |

### 15.3 渲染/网络/AI

| 文件 | 作用 |
| --- | --- |
| [render/scene.ts](../apps/web/src/render/scene.ts) | Three.js 场景与状态同步 |
| [render/table.ts](../apps/web/src/render/table.ts) | 桌面/绒布 |
| [render/raycaster.ts](../apps/web/src/render/raycaster.ts) | 拾取与 hover |
| [render/animationQueue.ts](../apps/web/src/render/animationQueue.ts) | 视觉事件动画队列 |
| [render/audio.ts](../apps/web/src/render/audio.ts) | WebAudio 音效 |
| [render/procedural](../apps/web/src/render/procedural) | 六边形/卡牌/骰子/房间/筹码 |
| [net/room.ts](../packages/net/src/room.ts) | 权威房间与投影补丁 |
| [net/patch.ts](../packages/net/src/patch.ts) | JSON Patch |
| [ai/policy.ts](../packages/harness/src/policy.ts) | Bot 接口与随机策略 |

### 15.4 游戏与入口

| 文件 | 作用 |
| --- | --- |
| [games/registry.ts](../packages/games/src/registry.ts) | 六个模块注册与能力矩阵 |
| [games/catan](../packages/games/src/catan) | 卡坦岛 setup/helpers/rules/scenarios |
| [games/sanguosha](../packages/games/src/sanguosha) | 三国杀 setup/rules/hooks |
| [games/splendor](../packages/games/src/splendor) | 璀璨宝石 setup/rules |
| [games/betrayal](../packages/games/src/betrayal) | 山屋 cards/haunts/helpers/rules/setup/scenarios/hooks |
| [games/dune_mahjong](../packages/games/src/dune_mahjong) | 沙丘/麻将 setup/rules |
| [games/poker](../packages/games/src/poker) | 德州扑克 cards/handEval/betting/setup/rules |
| [main.ts](../apps/web/src/main.ts) | 组合根 |
| [scripts/test-core.mjs](../scripts/test-core.mjs) | 测试运行器与边界检查 |

---

## 16. 快速验收

```bash
pnpm install
pnpm test
pnpm exec tsc --noEmit
pnpm build
pnpm dev
```

浏览器打开：

```text
http://127.0.0.1:5173/
http://127.0.0.1:5173/?scenario=rich_action
http://127.0.0.1:5173/?scenario=trade_ready
```

验收关注点：

- HUD 动作栏是否随阶段变化；
- 数学检查器五个页签是否实时更新；
- 决策窗口是否按参与者生成按钮；
- payload 表单是否一步完成银行/交易/丰饶/垄断；
- 时间机器是否可回退与校验；
- 游戏切换后渲染/检查器是否重建；
- console 无 error。
