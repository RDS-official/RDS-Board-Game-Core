# 内核表达缺陷分析与改造方案（RFC）

> 触发来源：山屋惊魂完整实现。实现过程中反复出现的“只能绕过、无法自然表达”集中在五类：**行动者、参数选择、效果生命周期、随机检定、空间几何**。
> 本文最初只做分析；**Wave 0 与 Wave 1 已按确认的四项取舍落地**，当前基线 `206 passed / 0 failed / 0 boundary violations`。
> 关联文档：[BETRAYAL.md](BETRAYAL.md) 第 8 节（具体缺陷现象）、[ARCHITECTURE.md](ARCHITECTURE.md)（现有分层）。

---

## 0. 结论摘要

### 0.1 一句话结论

严格说，内核并不缺“图灵完备性”：`GameState` 是任意 JSON、reducer 是任意纯函数、`globalVars/customProps/payload` 都是开放袋子，**任何有限规则都能被编码**。真正的缺陷是**契约层的语义错位**：

1. **行动者语义错位**：`activePlayerId`、`getFocusPlayers`、`legalActions(playerId)`、`winner` 都把“行动者”等同于“玩家”，怪物/中立单位只能伪装成玩家或被模块自动执行。
2. **参数协议错位**：`ActionFieldSpec` 只有 `enum/number`，无法声明“选实体/房间/玩家/多选”，只能为每个候选生成一个 Action。
3. **效果生命周期错位**：没有 `EffectInstance`/`Modifier`/`equipment` 的标准存储、过期和投影，状态被塞进 `customProps` 并由 reducer 手工维护。
4. **随机检定协议错位**：没有“先收集修正、再统一掷骰、再响应”的标准阶段；批量掷骰只能靠自定义 `resolveDecision` 拼。
5. **空间/内容契约错位**：`MapGraph` 只有邻接，没有墙/门/楼层几何；卡牌效果没有 DSL，内容扩展等于写 switch。

### 0.2 推荐顺序

| 波次 | 内容 | 目的 | 预估 |
| --- | --- | --- | --- |
| **Wave 0** | 选择参数（K2）、批量目标（K9）、骰面（K10）、日志/胜负（K11）、山屋房间牌堆实体化（K6） | 不改状态语义，先消除 UI/内容层的硬伤 | 4–6 人日 |
| **Wave 1** | 行动者层（K1）+ 淘汰/旁观（K7）+ NPC UI/AI（K15） | 解决最根本的语义错位，怪物/中立单位一等公民 | 8–12 人日 |
| **Wave 2** | 效果/修正/装备/时限（K3）+ 检定窗口（K4） | 解决状态生命周期与随机时序 | 8–12 人日 |
| **Wave 3** | 秘密通道（K8）、空间契约（K5）、效果 DSL（K12）、楼层表现（K14） | 内容规模化与空间表达 | 10–15 人日 |

**不建议**把山屋的 `traits/omens/haunt` 或 3D 房间几何写进内核；内核只应提供**通用槽位与生命周期**，语义留在模块。

### 0.3 三个关键取舍

1. **NPC 是 Actor，还是 pseudo-player？** 已确认：`Actor`，不伪装成 `Player`。
2. **效果/装备放内核还是模块？** 已确认：内核只存通用槽位与过期规则，语义解释放模块。
3. **空间几何放内核吗？** 已确认：不放；核心只提供通用图算法，几何数据由模块/渲染层提供。
4. **兼容策略？** 已确认：不做自动迁移；日志带 `schemaVersion/engineVersion`，不匹配直接拒绝。

### 0.4 本轮实施状态

| ID | 状态 | 落地内容 |
| --- | --- | --- |
| **K1** | ✅ 已实现 | `ActorId`/`Npc`/`ActorStatus`、`npcs`、`activeActorId`、`actorOrder`、`Action.actorId`、`getFocusActors`、NPC 投影/UI；山屋怪物是 NPC，叛徒逐只 `MOVE_NPC`/`ATTACK_HERO`/`END_NPC_TURN` |
| **K2** | ✅ 已实现 | `SelectionSpec`、`Action.targets`、`module.resolveSelection/validateSelection`、`engine.getSelectionCandidates`、HUD 选择器、`perform(..., targets)`；山屋 `MOVE_TO_ROOM` 已迁移 |
| **K6** | ✅ 山屋已实现 | 房间板块改为 `zone_room_deck` 的 TILE 实体；投影复用 observer；`roomDeckCount` 由 zone 长度派生 |
| **K10** | ✅ 核心已实现 | `DiceSpec`、`DeterministicPRNG.rollFaces`、`ReduceContext.roll`；0/1/2 骰测试；renderer 的 0 面骰仍待补 |
| **K11** | ◐ 部分 | `ENGINE_VERSION=3`、`GameMeta.schemaVersion/engineVersion`、`exportLog/loadLog` 拒绝不匹配；`GameOutcome` 扩展尚未做 |
| **K7** | ◐ 部分 | `Npc.status` + `actorOrder` + NPC 跳过；玩家仍用 `alive/banished` |
| **K3** | ◐ 部分 | `GameState.effects`、`EffectInstance`、turn/clock/phase 过期、可见性投影、invariants 已落地；山屋物品/击晕尚未迁移到 EffectInstance |
| **K4** | ⏳ 部分 | 已有 `DiceSpec`/`ctx.roll`；两阶段检定窗口未做 |
| **K5** | ✅ 契约已实现 | `TopologySpec`（有向/加权/分层/邻接权威/geometrySpec）、`SpatialQuery`、`MapGraphManager` 图算法、`mapGraph` 可见性投影、模块实现（山屋单向/穿墙/移动力/同层视线/楼层） |
| **K8** | ⏳ 待做 | 类型化 secrets/日志投影未做；隐藏 topology 已按节点/边 visibility 裁剪 |
| **K9** | ⏳ 部分 | `targets: string[]` 可承载多选；未迁移山屋的批量物品动作 |
| **K12** | ⏳ 待做 | 卡牌 effect DSL 未做 |
| **K14** | ⏳ 待做 | 楼层 DTO/切换未做 |

---

## 1. 评估框架

### 1.1 什么叫“表达缺陷”

把“表达”拆成五层，避免把所有不便都叫内核缺陷：

| 层 | 问题 | 例子 | 是否内核问题 |
| --- | --- | --- | --- |
| **语义** | 状态/契约把不同概念混为一谈 | 怪物不是玩家但必须有回合 | 是 |
| **协议** | 能编码，但没有标准交互契约 | 选房间只能枚举 44 个 Action | 是（契约） |
| **生命周期** | 能存，但过期/触发/投影要手写 | 诅咒、击晕、装备 | 部分 |
| **呈现** | 内核能算，UI 无法表达 | 多选、楼层、骰面 0 | 部分是 |
| **内容** | 规则能写，但每张牌都要改代码 | 45 事件/25 物品 | 模块架构 |

### 1.2 评估维度

| 维度 | 含义 |
| --- | --- |
| 语义严重度 | 会不会导致错误状态、错误胜负、错误投影 |
| 发生频率 | 现有 5 个夹具与未来游戏的命中率 |
| 改动面 | 触及的文件/层数 |
| 可逆性 | 是否能增量上线、是否破坏旧日志 |
| 测试成本 | 需要新增的夹具/回放/投影用例 |

### 1.3 内核必须守住的不变量

任何改造都不能破坏：

1. `GameState` 纯 JSON；无函数、类、`Date`、`Map/Set`。
2. 转移只依赖 `(state, action)`；随机只来自 `state.prngState`。
3. 同一 module/seed/scenario/actionLog → 同一 hash。
4. 投影 `O(s,i)` 在服务端完成；隐藏信息不进 patch。
5. 单一路径：`validate → decision → response → AOP → reduce → finalize`。
6. 模块只提供数据 + 纯函数；内核不出现游戏名分支。
7. UI 不 import core/games/render/net/ai；app 不 import ui/render。

---

## 2. 缺陷总表

编号与 [BETRAYAL.md 第 8 节](BETRAYAL.md#8-模拟器缺陷清单) 对应，但这里按“内核契约”重新归类。

| ID | 缺陷 | 类型 | 严重度 | 频率 | 改动面 | 现有绕法 |
| --- | --- | --- | ---: | ---: | ---: | --- |
| **K1** | 非玩家行动者没有身份/回合/合法动作 | 语义 | 5 | 3 | 5 | 怪物在叛徒 `END_TURN` 内自动跑 |
| **K2** | 动作参数只能 enum/number，不能选实体/房间/多选 | 协议 | 4 | 5 | 3 | 每个候选生成一个 Action；上限 24 + 钉住 END_TURN |
| **K3** | 没有 Effect/Modifier/装备/时限标准层 | 生命周期 | 4 | 4 | 4 | `customProps.effects` 字符串 + 回合开始 switch；物品直接改属性 |
| **K4** | 没有批量掷骰/掷后响应阶段 | 协议 | 3 | 3 | 3 | 自动结算；幸运道具自动修正 |
| **K5** | `MapGraph` 无墙/门/楼层几何 | 语义/呈现 | 3 | 2 | 5 | 同行同列占位、单向 DROP、网格 BFS |
| **K6** | 隐藏牌堆只有 ECS 区域一种形态 | 协议 | 2 | 3 | 2 | 房间牌堆放 `globalVars` + 手写 redactor |
| **K7** | 没有淘汰/放逐/旁观状态机 | 语义 | 3 | 2 | 3 | 自动 `advanceTurn` + 死者 `END_TURN` 兜底 |
| **K8** | 秘密目标/私有日志没有类型化通道 | 协议 | 2 | 2 | 2 | `project.globalVars` 手写裁剪 |
| **K9** | 物品转移只能一件一次 | 协议 | 2 | 3 | 1 | 多次 `DROP/PICK/TRADE` |
| **K10** | 骰子只有 `1..sides`，不能 0 面/自定义面 | 协议 | 1 | 2 | 1 | 模块 `rollZeroDice` |
| **K11** | `GameOutcome` 只有 winner/reason；日志脱敏过度 | 语义/呈现 | 1 | 3 | 2 | 字符串 reason；日志只剩 type/actor |
| **K12** | 卡牌效果没有 DSL/注册表 | 内容 | 3 | 4 | 4 | 45/25/13 全手写 switch |
| **K13** | 动作上限/分组丢字段（表现层） | 呈现 | 2 | 5 | 2 | 24 条 + 钉 END_TURN；怪物攻击不分组 |
| **K14** | 多楼层只是横向分区 | 呈现 | 2 | 3 | 3 | 三层 x 偏移 + 楼层标签 |

> K7 是 K1 的子问题；K13/K14 不是内核 API，但会反过来逼迫内核生成更多/更粗的动作，所以列入路线图。

---

## 3. 逐项分析

## 3.1 K1：非玩家行动者（P0）

### 3.1.1 现象与根因

山屋的怪物：

- 在叛徒回合结束后行动；
- 由叛徒（或剧本）控制移动/攻击；
- 有击晕、控制、携带女孩等状态；
- 不是玩家，没有手牌、没有 `playerOrder` 席位。

当前内核的假设：

```ts
interface GameState {
  activePlayerId: PlayerId;
  playerOrder: PlayerId[];
}
interface Action { playerId: PlayerId; }
engine.getFocusPlayers(): PlayerId[];
module.legalActions(state, playerId: PlayerId): Action[];
```

因此怪物只能：

1. 伪装成 `Player`（污染玩家列表/投影/胜负）；
2. 在某个玩家动作的 reducer 里自动执行（当前做法）；
3. 由外部控制器在回合外 dispatch（不可回放/不可投影）。

三者都不是“表达”，而是“绕过”。

### 3.1.2 方案对比

| 方案 | 做法 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- | --- |
| A. 完整 Actor 层 | `Actor` 基类 + `Player`/`Npc`；`activeActorId`、`actorOrder`、`Action.actorId`、`focusActors` | 语义正确；NPC 可拥有合法动作/回合/胜负 | 改动面最大；所有类型/引擎/UI/测试要迁移 | **推荐，分阶段** |
| B. Pseudo-player | 怪物塞进 `players`，`isNpc=true` | 改动最小；复用 focus/legal/UI | 玩家 DTO/投影/胜负/座位全污染；隐藏不了 | 不推荐 |
| C. NpcController 外挂 | 模块提供 `npcActions()`，引擎自动 dispatch | 不动状态模型 | 仍无回合/焦点；控制器不在回放内；UI 无法交互 | 仅作为过渡 |
| D. 模块内 actor 表 | `globalVars.actors` + 自定义调度 | 内核零改动 | 焦点/合法动作/超时/投影全部模块重写；内核无法复用 | 不推荐 |

### 3.1.3 推荐设计（A-lite）

不重写 `Player`，采用**加法式 Actor 层**：

```ts
export type ActorId = string;
export type ActorKind = 'PLAYER' | 'NPC' | 'SYSTEM';
export type ActorStatus = 'ACTIVE' | 'DEAD' | 'ELIMINATED' | 'SPECTATOR';

export interface Npc {
  id: ActorId;
  kind: 'NPC';
  name: string;
  color: string;
  avatar: string;
  status: ActorStatus;
  /** 控制者（例如叛徒）；null 表示剧本 AI。 */
  controllerId?: string;
  /** 若 NPC 同时是实体（怪物/标记），只在这里引用，避免位置/状态双写。 */
  entityId?: EntityId;
  /** 没有实体时使用；有 entityId 时由实体承载位置。 */
  zoneId?: string;
  customProps: Record<string, any>;
}

interface GameState {
  // 原有字段保持不变
  players: Record<PlayerId, Player>;
  playerOrder: PlayerId[];
  activePlayerId: PlayerId;

  // 新增，全部可选，缺省时行为与现在完全一致
  npcs?: Record<ActorId, Npc>;
  activeActorId?: ActorId;      // 缺省 = activePlayerId
  actorOrder?: ActorId[];       // 缺省 = playerOrder
}

interface Action {
  /**
   * 兼容槽位。PlayerId 与 ActorId 在类型上都是 string；旧代码/旧日志继续用它。
   * NPC 动作建议写 actorId；playerId 可填控制者（审计）或 NPC id（兼容）。
   */
  playerId: string;
  actorId?: ActorId;
}
```

引擎内部统一解析：

```ts
function actorOf(action: Action): ActorId {
  return action.actorId ?? action.playerId;
}
function isPlayerActor(state: GameState, id: ActorId): id is PlayerId {
  return !!state.players[id];
}
```

### 3.1.4 执行面细化

| 执行面 | 当前 | 修改 | 兼容/测试 |
| --- | --- | --- | --- |
| `core/types.ts` | `PlayerId`、`playerOrder`、`activePlayerId`、`Action.playerId`、`DecisionWindow.participants: PlayerId[]`、`StackResponseWindow.eligiblePlayers` | 增加 `ActorId`、`ActorKind`、`ActorStatus`、`Npc`、`GameState.npcs/activeActorId/actorOrder`、`Action.actorId`；`participants` 改 `ActorId[]`；`eligiblePlayers` 保留并增加 `eligibleActors?` | 旧状态不含新字段；默认解析到玩家；hash 不变 |
| `core/engine.ts` | `legalActionsFor(state, playerId)`、`getFocusPlayers`、`run` 的玩家校验、`commitDecision`、`resolveResponse`、`finalizeTransition`、`getProjectedStateFor` | 增加 `getFocusActors()`；`getFocusPlayers()` 过滤 `kind==='PLAYER'`；`run` 校验 actor 存在；决策/响应按 `actorId` 路由；`outcome.winner` 接受 ActorId | 旧 API 保留；新 API 默认等价 |
| `core/module.ts` | `legalActions(state, playerId)`；`GameCapabilities` | 签名改 `actorId: ActorId`（类型别名兼容）；增加 `onActorTurn?`、`capabilities.nonPlayerActors` | 5 个模块无需改签名 |
| `core/decisions.ts` | `participants: PlayerId[]`、`projectDecision` | 类型改 `ActorId[]`；`projectDecision` 按 actor 投影；提交校验 actor | 玩家 ID 是 ActorId 子集 |
| `core/stack.ts` | `eligiblePlayers`、`pendingResponses` | 增加 `eligibleActors`/`pendingResponses` 仍按字符串；`submitResponse` 接受 ActorId | 旧字段保留 |
| `core/aop.ts` / `rules.ts` | `HookContext.instance.ownerId: PlayerId`、action.playerId | `ownerId?: ActorId`；predicate 可看 actor；hook 可修改 NPC 动作 | 现有 hook 不受影响 |
| `core/observer.ts` | 只投影 players；`factionTopology` 只玩家 | 投影 `npcs`（PUBLIC/OWNER_ONLY）、`actorTopology`；`viewer` 仍是 PlayerId|'GOD' | NPC 默认公开；隐藏 NPC 用 visibility |
| `core/invariants.ts` | 校验 playerOrder/activePlayer | 校验 `actorOrder`、`activeActorId`、NPC 引用；允许 NPC 无 handZone | 新增 `NPC_MISSING` 等 code |
| `core/serialize.ts` | 纯 JSON | 不需要改；`Npc` 也只含 JSON | 回放 hash 包含 npcs |
| `core/validation.ts` | `Action.playerId` 结构校验 | 增加 `actorId` 可选结构校验；`actorId` 优先 | 旧 action 仍通过 |
| `core/actionPayload.ts` | 按 fields 填默认 | 选择型字段需要候选解析（见 K2） | NPC 动作同样适用 |
| `app/contracts.ts` | `UiPlayer`、`GameSnapshot.players/focus` | 增加 `UiActor`/`UiNpc`；`GameSnapshot.actors`、`focusActors`；保留 players/focus 兼容 | HUD 可渐进迁移 |
| `app/session.ts` | `buildPlayers`、`actorName`、`perform`、`pickTarget`、`buildActions` | 构建 actors；`perform` 按 snapshot action 的 actor 查找；`pickTarget` 用 `focusActors`；NPC 动作进入动作栏 | 玩家视角不变 |
| `ui/hud.ts` | 玩家 rail、行动者、决策参与者 | 渲染 NPC 卡（控制者、击晕、剧本标记）；行动者显示 actor；决策参与者显示 NPC | 用 `actors` 优先，`players` 回退 |
| `ui/mathInspector.ts` | `|N|` 玩家数、玩家矩阵 | `|N| = players + npcs` 或分开显示；阵营矩阵包含 NPC | 标签说明 |
| `ui/styles.css` | 玩家卡样式 | NPC 卡变体（虚线边框/控制者色） | 纯样式 |
| `render/scene.ts` | 怪物用 MEEPLE 绘制 | 泛化为 NPC 渲染；按 `npcs` 或 entity custom 读取位置；控制者高亮 | 现有怪物渲染可保留 |
| `net/room.ts` / `patch.ts` | 投影 diff | 无需改；`ProjectedGameState.npcs` 自动进 diff；补测试 | 隐藏 NPC 不泄漏 |
| `ai/policy.ts` | `BotPolicy.choose(engine, playerId)`、`runPolicies` 按玩家 | 改为 `choose(engine, actorId)`；`runPolicies` 按 focusActors；`controllerId` 映射到控制者策略 | 旧策略签名兼容（string） |
| `core/testing/suite.ts` | 无 NPC 夹具 | 新增 `npc_fixture`：一个玩家 + 一个 NPC，NPC 有合法动作/回合；Betrayal 怪物改为 NPC | 回放/投影/超时 |
| `scripts/test-core.mjs` | 81 用例 | 新增边界检查：NPC 不能被当作玩家投影；actorId 路由 | 保持 0 boundary |

### 3.1.5 状态迁移与回放

- **旧状态**没有 `npcs/activeActorId/actorOrder`，引擎解析默认值；hash 不变。
- **新状态**包含 `npcs`；`actionLog` 新 action 带 `actorId`；旧日志仍按 `playerId` 回放。
- `exportLog` 增加 `schemaVersion`（见 6.1）；旧日志在旧版本回放。
- `winner` 从 `PlayerId` 扩为 `ActorId`；`winnerLabel` 查 actors。

### 3.1.6 测试与验收

1. 通用 NPC 夹具：NPC 是 focus、能 dispatch、能触发决策/响应、能被投影。
2. 山屋怪物改为 NPC：叛徒回合后可对每只怪物发 `MOVE_NPC`/`ATTACK_NPC`（替代自动 BFS）。
3. 回放：NPC 动作在 log 中；`verifyReplay` 一致。
4. 投影：玩家看不到隐藏 NPC；NPC 的 `controllerId` 按剧本可见性。
5. 超时：NPC 决策窗口超时按 PASS 处理；焦点回到控制者。

### 3.1.7 风险

- 类型别名 `ActorId = string` 会让编译器无法区分 Player/NPC，必须靠运行时 `isPlayerActor`；这是为了兼容性付出的代价。
- `getFocusPlayers` 的旧语义会被 `getFocusActors` 取代；调用点要逐步迁移，避免“只拿到玩家，漏掉 NPC”。
- 胜负/UI/日志的 winner 类型变化会影响 `session.buildSnapshot` 的 `winnerLabel`；需要兼容数组/字符串。

---

## 3.2 K2：类型化选择参数（P0/P1）

### 3.2.1 现象

山屋一回合的合法动作：

- 4 个探索方向；
- N 个相邻房间；
- 每件物品 1 个 `USE_ITEM`；
- 每个怪物/玩家 1 个攻击；
- 交易、仪式、结束回合。

`ActionFieldSpec` 只有：

```ts
kind: 'enum' | 'number';
```

所以“选房间”“选怪物”“选多件物品”只能：

1. 为每个候选生成一个 Action（当前）；
2. 用 `payload` 传 raw ID，但 UI 无法渲染，schema 也无法校验。

这导致了一个真实事故：动作上限 14 把 `END_TURN` 截掉；怪物攻击分组后丢失武器字段。

### 3.2.2 方案对比

| 方案 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| A. 扩展字段 kind | `entity/node/player/actor/zone/hand/multi` + `source/scope` | UI 可直接渲染选择器；动作数恒定 | 需要 presenter 解析候选；schema 动态校验 |
| B. 独立 SelectionSpec | `Action.selection` + `Action.targets` | 语义清晰；支持多选/约束 | 引擎 `isLegal` 要改；旧模块要迁移 |
| C. 维持枚举 | 每候选一个 Action | 零内核改动 | 动作爆炸；UI 截断；分组丢字段 |
| D. 让 UI 猜 payload | 前端根据 type 拼 | 不改内核 | 契约泄漏；无法校验；bot 不可用 |

**推荐：A + B 的组合**——字段声明用 `selection`，实际提交用 `targets`：

```ts
export type SelectionSource = 'entity' | 'node' | 'actor' | 'player' | 'zone' | 'hand' | 'room' | 'deck';

export interface SelectionSpec {
  source: SelectionSource;
  /** 由 presenter 解释的 JSON 过滤条件（不能含函数）。 */
  scope?: Record<string, unknown>;
  min: number;
  max: number;
  distinct?: boolean;
}

export interface ActionFieldSpec {
  key: string;
  label: string;
  kind: 'enum' | 'number' | 'boolean' | 'selection';
  selection?: SelectionSpec;
  // 旧字段保留
  options?: { value: string; label: string }[];
}

export interface Action {
  // ...
  selection?: SelectionSpec;
  targets?: string[];
}
```

### 3.2.3 执行面细化

| 执行面 | 修改 |
| --- | --- |
| `types.ts` | `SelectionSource`、`SelectionSpec`、`ActionFieldSpec.kind` 扩展、`Action.selection/targets` |
| `module.ts` | 可选 `resolveSelection?(state, actorId, spec): SelectionCandidate[]`；`validateSelection?(state, action, targets): string[]` |
| `engine.ts` | `isLegal` 不再只比 `sameBinding`：候选动作的 `selection` 与提交的 `targets` 分离校验；`getSelectionCandidates(actorId, selection)` 暴露给 bot/UI |
| `validation.ts` | `targets` 结构校验（array<string>、长度、去重）；动态候选由 module 校验，不塞进 schema |
| `actionPayload.ts` | `withDefaultPayload` 对 selection 不填默认；新增 `fillFirstTargets` 供 bot |
| `app/contracts.ts` | `UiActionField` 增加 `selection`；`UiSelectionOption`；`GameSnapshot` 增加 `selectionCandidates`（按 action id） |
| `app/session.ts` | `buildActions` 不再按候选拆分；`bindAction` 保留 `selection`；`pickTarget` 支持多选；`perform` 合并 `targets` |
| `ui/hud.ts` | 参数表单渲染实体/房间/玩家选择器；多选 chips；搜索/过滤；确认前校验 min/max |
| `ui/mathInspector.ts` | `|L|` 语义改为“动作数”而不是“候选数”；展示 selection spec |
| `render/scene.ts` | 高亮候选集合；多选时保留已选高亮；取消选择 |
| `net/room.ts` | payload 含 `targets`；patch 只传公开候选 |
| `ai/policy.ts` | `engine.getSelectionCandidates` + 策略选第一个/随机；`withDefaultPayload` 不适用 selection |
| `core/testing/suite.ts` | 新夹具：一个 `MOVE_TO` selection 动作，候选 3 个；bot 可玩；动作数不随候选增长 |
| `games/*` | 逐步替换：山屋 `ATTACK_*`/`USE_ITEM`/`PICK_UP_ITEM`；Catan 建造可保留旧式（兼容） |

### 3.2.4 兼容策略

- `Action.fields` 旧式枚举仍然有效；`selection` 是新增可选分支。
- 现有模块不改也能运行；山屋先迁移 3 个高频动作（攻击/使用物品/拾取）。
- `isLegal` 保留旧 `sameBinding` 路径，新增 selection 路径。
- 动作数下降后，`session` 的 24 条上限可降回 12–14，`END_TURN` 钉住逻辑保留作为防御。

### 3.2.5 验收

1. 一个动作 + 3 个候选，而不是 3 个动作。
2. 提交 `targets` 不在候选 → 拒绝且状态不变。
3. `END_TURN` 永远可见。
4. 山屋攻击怪物可在同一按钮里切换目标与武器。
5. 现有 81 条用例 + 边界检查通过。

---

## 3.3 K3：效果 / 修正 / 装备 / 时限（P1）

### 3.3.1 现象

山屋需要：

- 持续诅咒（Drip/Possession）：回合开始检定，直到破除；
- 击晕：直到下一个怪物回合结束；
- 装备：每件武器/护甲，攻击时选一件；
- 属性修正：Amulet +1/-3、Book +2/-2、Mask 戴/摘；
- 房间霜冻：进入后速度减半；
- 剧本进度：封印/安魂次数。

当前实现：

- 物品直接改 `traitIndex`；
- 持续效果是 `customProps.effects: string[]`；
- 击晕是 `monster.custom.stunTurns`；
- 装备是手牌 + payload 枚举；
- 时限靠 reducer 手写。

### 3.3.2 方案对比

| 方案 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| A. 内核全量 Effect 引擎 | 内核定义 trigger/duration/stacking，自动执行 | 统一 | 内核要知道“回合/阶段/属性”语义，容易游戏化 |
| B. 内核薄存储 + 模块解释 | `EffectInstance[]` + 过期字段；模块 `onTurnStart/onPhase` 解释 | 语义留模块；内核管投影/过期/校验 | 需要模块实现触发 |
| C. 模块自管 | 继续 `customProps` | 零内核改动 | 类型/投影/测试重复 |
| D. 通用 ECS Effect 组件 | 效果挂实体 | 复用 ECS | 玩家不是实体；装备/状态仍要额外层 |

**推荐 B**：

```ts
export interface EffectInstance {
  id: string;
  kind: string;                 // 模块定义
  sourceId?: ActorId | EntityId;
  targetId: ActorId | EntityId;
  data?: Record<string, unknown>;
  visibility: VisibilityRule;
  duration?: {
    turns?: number;             // 剩余回合
    untilPhase?: string;        // 到某阶段结束
    untilTurn?: number;         // 绝对回合
  };
  stackable?: boolean;
}

export interface StatModifier {
  id: string;
  targetId: ActorId;
  stat: string;                 // 模块定义，如 'might'
  delta: number;
  sourceId?: EntityId;
  duration?: EffectInstance['duration'];
}

interface GameState {
  effects?: EffectInstance[];
  modifiers?: StatModifier[];
}
```

装备：

```ts
interface Player {
  // ...
  equipment?: Record<string, EntityId[]>; // slot -> entities
}
```

> 如果 K1 的 Actor 层落地，装备槽应上移到 Actor 基类/`Npc`；在 A-lite 过渡期，玩家用 `Player.equipment`，NPC 用 `Npc.customProps.equipment`，不要双写同一件实体。

内核只负责：

- 存储、校验引用、投影（按 visibility）；
- 在 `__TICK__`/阶段切换时递减 `turns`、清理过期；
- 提供 `module.onEffectsExpired?` 回调（可选）。

模块负责：

- `kind` 的语义（Drip 检什么、Mask 改哪些骰）；
- 触发时机（回合开始/进入房间/攻击前）；
- 派生属性计算（`effectiveTrait = track[index] + sum(modifiers)`）。

### 3.3.3 执行面细化

| 执行面 | 修改 |
| --- | --- |
| `types.ts` | `EffectInstance`、`StatModifier`、`Player.equipment?`、`GameState.effects/modifiers` |
| `module.ts` | `onEffectsTick?`、`onEffectsExpired?`、`deriveStats?`（可选，避免内核知道属性名） |
| `engine.ts` | `advanceClock`/`finalizeTransition` 调用 `expireEffects`；`stampDeadlines` 不变；`checkInvariants` 前清理 |
| `decisions.ts`/`stack.ts` | 无直接改动；效果可影响合法动作（模块读 effects） |
| `observer.ts` | 投影 effects/modifiers：PUBLIC/OWNER_ONLY/SUBSET；隐藏效果不泄漏 |
| `invariants.ts` | effect target 存在；duration 非负；modifier stat 字符串；equipment 实体存在且唯一 |
| `serialize.ts` | 纯 JSON；effect id 确定性生成 |
| `validation.ts` | 效果不经过 action schema；模块 `addEffect` 校验 |
| `session.ts` | 玩家 stats 显示 active effects/装备；phaseLabel 可显示“被控制/霜冻” |
| `ui/hud.ts` | 玩家卡状态 chips；装备槽；effect 倒计时 |
| `ui/mathInspector.ts` | 新 tab 或 HOOKS 内展示 effects/modifiers |
| `render/scene.ts` | 状态图标（霜冻/控制/击晕） |
| `net/room.ts` | effects 投影进 diff；隐藏效果不泄漏 |
| `ai/policy.ts` | 策略可读 effects 做决策 |
| `games/betrayal` | 替换 `customProps.effects`、`stunTurns`、物品直接改轨道；`deriveStats` 计算四维 |
| `core/testing/suite.ts` | 效果 3 回合过期；装备转移；隐藏效果投影；回放 |

### 3.3.4 兼容

- 旧模块不设置 `effects/modifiers`，状态不含字段；hash 不变。
- 山屋迁移可以分两步：先加 `effects` 替代字符串；再把物品轨道改为 modifiers。
- `equipment` 可选；旧手牌模型继续可用。

---

## 3.4 K4：批量掷骰 / 掷后响应（P1，可模块化）

### 3.4.1 先澄清：这是不是内核缺陷？

严格说，**不是硬缺口**。当前内核已经允许：

1. `openDecision` 打开多人窗口；
2. 每个参与者提交 `ROLL_MODIFIER` 动作；
3. 模块 `resolveDecision` 自定义：一次性读所有提交、用 PRNG 掷骰、写 `globalVars.rollResults`；
4. 再打开一个 `AFTER_ROLL` 决策窗口，让玩家决定是否用幸运石；
5. `onDecisionResolved` 应用结果。

所以“批量掷骰 + 掷后响应”可以用现有契约拼出来。真正缺的是：

- 标准 `DiceSpec`/`RollResult` 类型；
- `ReduceContext.roll()` 统一入口（避免每个模块自己写 0/1/2 骰）；
- UI 的掷骰结果/骰面展示；
- 超时/秘密揭晓的默认策略。

### 3.4.2 推荐：核心 helper + 模块 pattern，而不是硬编码 RollStage

```ts
// core/dice.ts
export interface DiceSpec { count: number; faces: number[]; }
export interface RollResult {
  id: string;
  actorId: ActorId;
  spec: DiceSpec;
  rolls: number[];
  total: number;
  revealed: boolean;
}

export interface ReduceContext {
  // ...
  roll: (spec: DiceSpec) => { result: RollResult; nextPrngState: number };
}
```

模块模式：

```ts
// 1) open decision (payload.kind='roll', participants)
// 2) legalActions -> [ROLL_MODIFIER, PASS]
// 3) module.resolveDecision:
//    for each submission: read modifier, ctx.roll(spec), apply item cost
//    state.globalVars.rollResults = ...
// 4) module.onDecisionResolved: open AFTER_ROLL window if needed
// 5) AFTER_ROLL submissions -> apply outcome
```

### 3.4.3 执行面

| 执行面 | 修改 |
| --- | --- |
| `core/types.ts` | `DiceSpec`、`RollResult`（或放 `core/dice.ts`） |
| `core/prng.ts` | `rollFaces(seed, faces)`；保留 `rollDice` 兼容 |
| `core/module.ts` | `ReduceContext.roll`；可选 `module.resolveRoll?` |
| `core/engine.ts` | `makeContext` 注入 `roll`；无新调度阶段 |
| `core/decisions.ts` | `DecisionWindow.payload.kind='roll'` 约定；`resolveDecision` 仍由模块覆盖 |
| `core/observer.ts` | `RollResult.revealed` 控制投影；秘密骰先 `COMMITTED` |
| `core/validation.ts` | `ROLL_MODIFIER` schema；骰面枚举校验 |
| `app/contracts.ts` | `UiRoll`（骰子、总和、阈值、成功/失败） |
| `session.ts` | 读取 `rollResults`；行动栏显示“掷骰/修正” |
| `hud.ts` | 掷骰结果条；骰子动画触发 |
| `render/scene.ts` | 支持 0/1/2 面骰（见 K10） |
| `net/room.ts` | 隐藏骰结果不泄漏；揭晓后 patch |
| `ai/policy.ts` | 修正策略 |
| `games/betrayal` | 作祟检定、事件检定、Bite 代掷；幸运道具改为显式 AFTER_ROLL |
| `tests` | 多人掷骰、秘密骰、超时、回放 |

### 3.4.4 验收

- 固定 seed 下，批量掷骰结果确定；
- 秘密骰在揭晓前不出现在 patch；
- 超时自动 PASS，窗口继续；
- 回放一致。

---

## 3.5 K5：空间几何（P2，内核只提供拓扑契约）

> **本轮进展**：`GameCapabilities.topologySpec`、`GameMapGraph.topology`、`MapGraphEdge.directed/weight/ports`、`MapGraphNode.layer/visibility` 已落地；`graph.ts` 提供 `neighborsOf`、`adjacencyList`、`bfs`、`shortestPath`、`reachable`、`validateTopology`。模块通过 `SpatialQuery` 提供墙体/门/LOS/楼层语义；`mapGraph` 投影会裁剪隐藏节点、隐藏边和悬空邻居。仍不把 3D 几何放进内核状态。

### 3.5.1 现象

`MapGraph` 修复前只有：

```ts
interface MapGraphNode { position; neighbors; props; }
interface MapGraphEdge { from; to; type; props?; }
```

山屋需要：

- 门位匹配/旋转；
- 墙段阻挡；
- 左轮同层直线视线；
- 楼座/露台单向坠落；
- 怨灵穿墙；
- 三层空间。

当前全部是模块启发式。

### 3.5.2 方案对比

| 方案 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| A. 内核几何引擎 | 墙/门/体积/射线 | 统一 | 内核巨大；多数游戏不需要 |
| B. 模块 `SpatialQuery` 契约 | 模块提供 `lineOfSight/canTraverse`；渲染读 props | 语义留游戏；可复用图算法 | 每个游戏自己实现 |
| C. 纯模块 helper | 当前 | 零内核改动 | 重复 BFS/LOS |
| D. 3D 物理 | Three.js 射线 | 精确 | 与纯 JSON 状态/回放冲突 |

**推荐 B**：

```ts
// core/module.ts
export interface SpatialQuery {
  lineOfSight?(state: GameState, from: NodeId, to: NodeId): boolean;
  canTraverse?(state: GameState, from: NodeId, to: NodeId, actorId: ActorId): boolean;
  floors?(state: GameState): string[];
}
```

内核只提供 `core/graph.ts` 的通用算法：

```ts
export function bfs(graph, from, options): string[];
export function dijkstra(graph, from, weight): Map<string, number>;
export function reachable(graph, from, maxCost): Map<string, number>;
```

### 3.5.3 执行面

| 执行面 | 修改 |
| --- | --- |
| `core/graph.ts` | 泛化 BFS/Dijkstra/可达集；支持有向边/权重/条件 |
| `core/module.ts` | 可选 `spatial?: SpatialQuery` |
| `engine` | 不调用空间；仅作为模块能力 |
| `observer` | 楼层/可见房间作为投影数据 |
| `session` | Board DTO 增加 `floors`、`activeFloor`、`tiles` |
| `ui/hud` | 楼层切换器；当前楼层标签 |
| `render/scene.ts` | 按楼层显隐；剖面/垂直堆叠；高亮当前楼层 |
| `games/betrayal` | 用 `SpatialQuery` 替换 `sameFloorLine`/手写 BFS；门位/墙段进 `props` |
| `tests` | 墙阻挡、单向边、跨楼层、LOS |

### 3.5.4 结论

**不要把 3D 几何放进内核状态**。内核最多提供“有向/加权图算法 + SpatialQuery 契约”；墙/门/楼层是模块数据，渲染是表现层。

---

## 3.6 K6：隐藏牌堆（P2，优先模块修复）

### 3.6.1 现象

- 卡牌牌堆是 `HIDDEN` 区域，observer 会虚拟 ID + 遮罩；
- 房间板块是 `globalVars.roomDeck: string[]`，observer 不认识，只能 `project.globalVars` 手写删除。

### 3.6.2 方案

| 方案 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| A. 内核 `HiddenDeck<T>` | 新状态字段 + 投影 | 通用 | 新状态语义；hash/回放；多数牌堆已是实体区域 |
| B. 房间板块实体化 | 39 个 TILE 实体放 `zone_room_deck`，翻出后建 node | 复用现有 observer/别名/弃牌 | 模块改动，但最干净 |
| C. 继续 redactor | 手写 | 零改动 | 容易漏 |

**推荐 B**：山屋房间板块改为实体；`zone_room_deck` HIDDEN，`zone_room_discard` PUBLIC（顶牌），抽到后从实体 `custom.roomDefId` 建节点并移动到 `zone_board_tiles`。这样不需要 `globalVars.roomDeck`，observer 自动处理。

如果未来有多个游戏需要非实体隐藏序列，再考虑 A。

### 3.6.3 执行面

| 执行面 | 修改 |
| --- | --- |
| `games/betrayal/setup.ts` | 创建 39 个 TILE 实体；不再写 `roomDeck` |
| `games/betrayal/rules.ts` | 从 `zone_room_deck` 抽顶；弃置到 `zone_room_discard`；建 node |
| `observer` | 无需改；HIDDEN 区域自动遮罩 |
| `session/render` | 牌堆 UI 显示剩余数；桌面可显示房间牌堆 |
| `tests` | 投影不泄漏房间顺序；回放 |
| `project.globalVars` | 删除 `roomDeck` 分支 |

---

## 3.7 K7：淘汰 / 放逐 / 旁观（并入 K1）

- `ActorStatus = ACTIVE | DEAD | ELIMINATED | SPECTATOR`。
- `getFocusActors` 过滤 `ELIMINATED/SPECTATOR`；`DEAD` 仍可被目标/交易引用。
- `playerOrder` 保留历史；`actorOrder` 决定回合。
- UI：死者卡灰显；旁观者不进行动栏；`winner` 可包含阵营。
- 山屋：`banished` 用 `status='SPECTATOR'` + `controllerId`；被绑架英雄 `ELIMINATED`；不再占回合槽位触发怪物阶段（怪物本身是 NPC，见 K1）。

执行面与 K1 重叠：types、engine focus、session、HUD、render、tests。

---

## 3.8 K8：秘密目标 / 私有日志（P2）

### 3.8.1 方案

```ts
interface SecretRecord {
  id: string;
  audience: ActorId[];
  payload: JsonRecord;
  kind: string;
}
interface GameState { secrets?: SecretRecord[]; }
```

- observer 删除非 audience 的 secrets；
- `Action.log` 增加 `public?: JsonRecord`、`private?: Record<ActorId, JsonRecord>`；
- `GameModule.projectActionLog?(action, viewer): JsonRecord`。

### 3.8.2 执行面

| 执行面 | 修改 |
| --- | --- |
| types | `SecretRecord`、`Action.log`、`GameState.secrets` |
| observer | 过滤 secrets；日志投影钩子 |
| engine | 日志写入不再只存 action 原样；保留 state hash 用原 action |
| session | 日志 DTO 显示 public/private |
| room | patch 不含秘密 |
| tests | 秘密目标不泄漏；日志可审计 |

---

## 3.9 K9：批量目标（P1，低风险）

```ts
interface Action {
  entityIds?: EntityId[];
  targets?: string[];
}
```

- 校验：array、长度、去重、模块 `validateSelection`；
- UI：多选 chips；
- 山屋：一次丢弃/拾取多件、交易多件；
- 兼容：单件动作保留。

执行面：types、validation、actionPayload、session、HUD、render、tests、games。

---

## 3.10 K10：骰面（P2，低风险）

```ts
interface DiceSpec { count: number; faces: number[]; }
interface DiceComponent { value: number; faces: number[]; ... }
```

- `prng.rollFaces(seed, faces)`；
- `ReduceContext.roll(spec)`；
- renderer：0/1/2 面纹理，`setFaceUp` 支持 0；
- UI：骰子结果条显示面值；
- 测试：0 面、任意面、回放。

---

## 3.11 K11：胜负与日志（P2，低风险）

```ts
interface GameOutcome {
  gameOver: boolean;
  winner: ActorId | ActorId[] | null;
  winners?: ActorId[];
  losers?: ActorId[];
  reason?: string;
  objectives?: { id: string; owner: ActorId; progress: number; target: number }[];
}
```

- `winner` 保留；新字段可选；
- `session.winnerLabel` 支持数组/阵营；
- `Action.log` 公私分离（K8）；
- 测试：多阵营胜负、平局、剧本进度。

---

## 3.12 K12：卡牌效果 DSL（P2/P3，模块优先）

### 3.12.1 结论

这是**模块架构问题**，不是内核语义问题。内核不应知道“神智检定”“木乃伊”。

推荐模块内解释器：

```ts
// game module
type EffectOp =
  | { op: 'trait'; target: 'self'|'room'|'all'; trait: string; delta: number }
  | { op: 'check'; trait: string; threshold: number; onSuccess: EffectOp[]; onFail: EffectOp[] }
  | { op: 'draw'; deck: string; count: number }
  | { op: 'move'; to: string }
  | { op: 'attack'; dice: number; kind: string }
  | { op: 'effect'; kind: string; duration?: ... };

interface CardDef { id; text; ops: EffectOp[]; }
```

模块注册 `EffectRegistry`：

```ts
interface GameModule {
  effects?: Record<string, (state, op, ctx) => GameState>;
}
```

内核只提供 `ReduceContext`/PRNG/决策；不新增游戏名词。

### 3.12.2 执行面

| 执行面 | 修改 |
| --- | --- |
| `games/betrayal/cards.ts` | 事件/物品/预兆改为 `ops` 数据 |
| `games/betrayal/effects.ts` | 操作注册表 + 解释器 |
| `rules.ts` | 抽取 draw/check/attack 原语；删除 switch |
| `tests` | 每个 op 单测 + 卡牌表快照 |
| `docs` | 卡牌文本 ↔ op 对照 |

---

## 3.13 K13/K14：表现层反向压力（P2）

- K13：动作上限、分组丢字段、payload 只能顶层。Wave 0 先用 K2 解决；`END_TURN` 钉住保留。
- K14：楼层横向分区。Wave 3 用 `floors/activeFloor` DTO + renderer 楼层显隐/剖面；不要让内核存 3D 坐标。

执行面：session、contracts、HUD、renderer、CSS。

---

## 4. 方案对比总表

| ID | 方案 A | 方案 B | 方案 C | 推荐 | 兼容性 | 主要风险 |
| --- | --- | --- | --- | --- | --- | --- |
| K1 | 完整 Actor | pseudo-player | 外挂控制器 | A-lite | 高（可选字段） | 类型/焦点迁移 |
| K2 | selection 字段 | 独立 SelectionSpec | 枚举 Action | A+B | 高 | UI/bot 解析 |
| K3 | 内核 Effect 引擎 | 薄存储 + 模块解释 | 模块自管 | B | 高 | 过期/投影 |
| K4 | RollStage | helper + pattern | 自动结算 | helper | 高 | 时序/秘密 |
| K5 | 内核几何 | SpatialQuery | 模块 helper | B | 高 | 每游戏实现 |
| K6 | HiddenDeck | 房间实体化 | redactor | B | 高 | 模块改动 |
| K7 | status 状态机 | dead 跳过 | 自动 advance | A | 高 | UI/胜负 |
| K8 | secrets | redactor | 不建模 | A | 高 | 泄漏 |
| K9 | targets[] | 多次动作 | 不支持 | A | 高 | 校验 |
| K10 | faces[] | min=0 | 模块 | A | 高 | 渲染 |
| K11 | Outcome 扩展 | reason 字符串 | 不改 | A | 高 | UI |
| K12 | 模块 DSL | 内核 DSL | 手写 | 模块 DSL | 高 | 内容迁移 |

---

## 5. 分波次路线图与验收

### Wave 0（4–6 人日）：不改状态语义

1. K2 selection 字段 + K9 targets。
2. K10 dice faces + `ReduceContext.roll`。
3. K11 outcome/log 扩展（可选）。
4. K6 山屋房间实体化。
5. K13 动作上限/分组修复收尾。

验收：

- 山屋动作数从 20+ 降到 ≤10；
- `END_TURN` 永远存在；
- 0/1/2 骰可渲染/回放；
- 房间牌堆顺序不泄漏；
- 81 + 新用例全绿。

### Wave 1（8–12 人日）：Actor 层

1. types 增加 Npc/ActorId/status；
2. engine focusActors、路由、winner；
3. decisions/stack/aop/observer/invariants；
4. session/HUD/inspector/render/AI；
5. 山屋怪物改 NPC；新增通用 NPC 夹具。

验收：

- NPC 是 focus，可 dispatch、可回放；
- 叛徒可逐只控制怪物；
- 隐藏 NPC 不泄漏；
- 81 + NPC 用例全绿。

### Wave 2（8–12 人日）：Effect/Modifier + Roll

1. EffectInstance/Modifier/equipment；
2. engine 过期/投影/不变量；
3. 山屋诅咒/击晕/装备迁移；
4. Roll helper + 两阶段检定；
5. UI 状态 chips/骰子结果。

验收：

- “直到下一怪物回合”可配置；
- 修正可叠加/移除；
- 秘密骰不泄漏；
- 回放一致。

### Wave 3（10–15 人日）：秘密/空间/DSL/楼层

1. secrets + 日志投影；
2. SpatialQuery + graph 泛化；
3. 山屋房间实体/门位/墙段；
4. 卡牌 ops 解释器；
5. 楼层 DTO + renderer 显隐。

验收：

- 左轮墙体阻挡；
- 楼层切换；
- 卡牌表可数据驱动扩展；
- 文档/测试齐全。

---

## 6. 迁移与兼容策略

### 6.1 版本

```ts
interface GameMeta {
  schemaVersion: number;   // 状态结构
  engineVersion: number;   // 调度语义
}
interface ExportedLog {
  schemaVersion?: number;
  engineVersion?: number;
  // ...
}
```

- `loadLog`：版本不匹配 → 明确错误，不做隐式迁移。
- 旧日志用旧版本回放；新字段全部可选。

### 6.2 状态 hash

- 新增可选字段不写入 → 旧状态 hash 不变。
- 一旦模块开始写 `npcs/effects`，hash 变化是预期；测试更新快照。
- 不把“派生值”（如 `traits`）同时存两份；只存基础值 + modifiers，避免 hash 漂移。

### 6.3 UI/网络

- `GameSnapshot` 只增字段；旧 UI 回退到 `players/focus`。
- `ProjectedGameState` 增 `npcs/effects`；`patch.ts` 自动 diff，无需改算法。
- 隐藏 NPC/效果/骰结果必须在 projection 阶段删除，不进 patch。

### 6.4 机器人

- `BotPolicy.choose(engine, actorId)`；旧策略字符串兼容。
- selection 型动作需要 `engine.getSelectionCandidates`。
- NPC 策略通过 `controllerId` 映射；无控制器时用 `NpcPolicy`（随机/剧本）。

---

## 7. 测试矩阵

| 层 | 新增用例 |
| --- | --- |
| Actor | NPC focus、NPC dispatch、NPC 决策/响应、回放、投影、胜负 |
| Selection | 一个动作多候选、targets 校验、bot、UI 快照 |
| Effect | 3 回合过期、装备转移、叠加、隐藏效果、回放 |
| Roll | 固定 seed、秘密骰、超时、掷后响应、0 面 |
| Spatial | 墙阻挡、单向边、跨楼层、LOS |
| HiddenDeck | 房间顺序不泄漏、弃牌、回放 |
| Outcome | 多阵营、平局、进度 |
| Compat | 旧状态无新字段、旧日志拒绝/回放 |
| Boundary | UI 不 import core；app 不 import ui/render |

验收命令保持不变：

```bash
node scripts/test-core.mjs
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build
```

---

## 8. 不建议做的修改

1. **不要把山屋的 `traits/omens/haunt` 放进 `GameState` 顶层**。这会污染其他四个夹具和 UI DTO。
2. **不要把 50 个剧本写成内核分支**。剧本是模块数据/ reducer。
3. **不要做通用 3D 物理/几何内核**。用 `SpatialQuery` + 渲染层。
4. **不要用 `Map/Set/class` 存状态**。纯 JSON 是可回放/可哈希的底线。
5. **不要引入 wall-clock 计时器**。继续逻辑时钟 `__TICK__`；超时由 UI 推进。
6. **不要让 UI 解析游戏规则**。selection 的候选过滤必须来自 presenter/module。

---

## 9. 需要确认的三个取舍

1. **NPC 是否一等公民？** 推荐是；如果只想先修山屋，可用 `NpcController` 过渡，但不要长期保留。
2. **效果语义放哪？** 推荐内核只存 `EffectInstance`，模块解释；如果坚持“内核全自动”，需要定义通用 trigger/duration 语言，成本翻倍。
3. **兼容策略？** 推荐“新增可选字段 + 旧日志版本拒绝”，不做自动迁移；否则回放测试会长期不稳定。

---

## 10. 结论

山屋暴露的不是“内核算不出来”，而是“内核把玩家当成了唯一行动者、把参数当成了枚举、把状态当成了开放袋子”。修复顺序应该是：

```text
选择参数（K2/K9/K10）
  → 行动者（K1/K7）
  → 效果生命周期（K3）
  → 检定协议（K4）
  → 秘密/空间/DSL（K8/K5/K12）
```

先做 Wave 0，可以在不改状态语义的前提下把山屋的 UI/动作数/骰面/牌堆问题解决；Wave 1 才是真正的内核演进。两者都应保持 81 条基线全绿，并用新增 NPC/selection/effect/roll 夹具逐步替换模块里的绕过逻辑。
