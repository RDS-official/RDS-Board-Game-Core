# 内核契约与扩展指南

> 本项目的产品是**通用桌游内核**：确定性状态转移、信息投影、中断栈、动态规则、回放与不变量校验。
> `packages/games/src/*` 下的五款游戏只是**一致性测试夹具**，用来证明内核足以覆盖从德式策略到美式剧情、从顺序回合到同步盲提的各种机制。

---

## 1. 内核边界

```
┌──────────────────────────────────────────────────────────────┐
│                         GameModule（夹具）                    │
│  setup(seed) · legalActions(s,p) · reduce(s,a,ctx) · outcome │
│  hooks: RuleHookImpl[]                                       │
└───────────────────────────────┬──────────────────────────────┘
                                │ 纯函数
┌───────────────────────────────▼──────────────────────────────┐
│                        UniversalGameEngine                    │
│  validate → decision window → response window → AOP → reduce  │
│  → outcome → invariants → hash → log → events                 │
├──────────────────────────────────────────────────────────────┤
│ RuleRegistry  DecisionCoordinator  InterruptStack  Observer    │
│ Canonical JSON  FNV-1a hash  Invariants  Replay/Event Sourcing │
└──────────────────────────────────────────────────────────────┘
```

内核不依赖 DOM、Three.js、网络或全局时间；`reduce` 之外的一切调度都由内核负责。

---

## 2. 状态契约 `GameState`

状态必须是**纯 JSON**：无函数、无类实例、无 `Date`、无循环引用、无 `undefined` 依赖。

| 字段 | 含义 |
| --- | --- |
| `seed` | 初始种子，回放使用 |
| `seq` | 状态转移计数器，也是确定性 ID 的来源 |
| `entities` / `zones` | ECS 存储；每个实体恰好属于一个区域 |
| `mapGraph` | 空间拓扑 `G_map` |
| `interruptStack` | LIFO 响应栈 `Σ_stack` |
| `pendingDecisions` | 并发/秘密决策窗口 `Δ` |
| `activeHooks` | 动态规则的**数据描述**（`hookId + owner + params`） |
| `prngState` | 当前 PRNG 状态（自然节点 `c`） |
| `actionLog` | 已接受的动作（游标） |

两个关键约束：

1. **规则实现不在状态里**。状态只保存 `hookId`，实现在模块的 `hooks` 数组 / `RuleRegistry` 中。这样状态可哈希、可持久化、可跨进程传输。
2. **禁止 `Date.now()` / `Math.random()`**。ID 通过 `ReduceContext.id(kind)` 生成（`kind_s<seq>_<n>`），随机只来自 `state.prngState`。

---

## 3. 模块契约 `GameModule`

```ts
interface GameModule {
  meta: {
    id: string;
    name: string;
    description: string;
    version: string;
    capabilities: {
      simultaneousMoves: boolean;
      hiddenInformation: boolean;
      interruptStack: boolean;
      dynamicRules: boolean;
      topology: 'none' | 'hex-dual' | 'graph' | 'ring';
    };
  };
  hooks: RuleHookImpl[];
  setup(seed: number): GameState;
  legalActions(state: GameState, playerId: PlayerId): Action[];
  reduce(state: GameState, action: Action, ctx: ReduceContext): GameState;
  outcome(state: GameState): GameOutcome;
  onDecisionResolved?(state, window, ctx): GameState;
}
```

`ReduceContext` 提供：

- `ctx.id(kind)`：确定性唯一 ID；
- `ctx.trace(event)`：视觉事件（无副作用的旁路输出）；
- `ctx.seq`：本次转移序号。

用一个 `defineGame()` 注册即可：

```ts
export const myModule = defineGame({ ... });
GAME_REGISTRY[id] = myModule;
```

---

## 4. 一次 `dispatch` 的完整顺序

`UniversalGameEngine.dispatch(action)`：

1. **形状与主体校验**：动作类型、玩家存在性；
2. **时间线分支**：若当前处于回放游标之后，丢弃被放弃的未来；
3. **秘密决策窗口**：若存在 OPEN 窗口且玩家是参与者 → 收集提交；达到策略条件时按序原子结算；
4. **响应窗口**：若栈顶帧 `WAITING_INPUT` 且玩家有响应权 → 收集响应；全部响应或高优先级短路后弹栈结算；
5. **合法性**：`canonicalize(action)` 必须命中 `ℒ(s,i)`；
6. **AOP 前置**：`FILTER_MODIFY` → `BEFORE_REPLACE`；
7. **纯函数 reduce**；
8. **AOP 后置**：`AFTER_TRIGGER` 与 follow-up 链（深度上限 8）；
9. **胜负判定**；
10. **不变量校验**（strict 模式失败则拒绝提交）；
11. **写入日志、计算哈希、派发视觉事件、通知订阅者**。

拒绝路径保证状态不变；被规则取消的动作不递增 `seq`、不写日志，因此回放严格对齐。

---

## 5. 并发与秘密决策 `Δ`

`DecisionCoordinator` 支持三类策略：

- `ALL_COMMITTED`：所有参与者提交后才揭晓（沙丘战斗转盘、卡坦弃牌）；
- `FIRST_ACCEPT`：任一参与者提交 `acceptTypes` 中的动作即短路；按座次只执行到首个接受为止（卡坦交易）；
- `PRIORITY`：动作带优先级，达到阈值立即短路（麻将胡 > 碰 > 吃）。

每个窗口可以设置整体 `deadline`，也可以给每个参与者单独的 `participantDeadlines`；逻辑时钟推进时逐人自动提交 `PASS`，先到期者先退出，窗口在最后一人到期或达到接受条件时结算。

投影 `𝒪` 会：

- 隐藏秘密窗口中的具体提交，只暴露 `COMMITTED`；
- 在窗口结算后把 `reveal` 写入状态，供审计与回放。

响应窗口是“附着在栈帧上的决策”，共享同一套仲裁语义。

---

## 6. 信息投影 `𝒪(s,i)`

`CognitiveObserver.projectState(state, viewer)` 保证：

1. 不可见实体擦除私有组件；
2. 不可见实体使用**会话稳定**的虚拟 ID（`v_id_xxx`）；
3. 区域列表同步重映射，避免悬空引用；
4. 秘密决策提交折叠为 `COMMITTED`；
5. 规则钩子按 `visibility` 过滤；
6. 阵营矩阵按视角计算；
7. **动作日志脱敏**：只保留 `type / actor / 公开目标`，剥离 `entityId` 与 `payload`——否则秘密出价与真实实体 ID 会从日志侧信道泄漏；
8. **模块级 redactor**：`module.project.player` / `project.globalVars` 可擦除身份、私有全局变量等通用观察者无法识别的自定义字段。

这些性质由一致性测试覆盖（`projections never leak hidden card faces`、`room: hidden information never appears in patches`、`room: secret decision submissions are collapsed in deltas`）。

---

## 7. 不变量

`checkInvariants()` 检查 30+ 条结构性质，包括：

- 玩家集合与 `activePlayerId`；
- 实体/区域的双向一致性、唯一归属、悬空引用；
- 图节点的邻居与边端点；
- 栈帧 ID 唯一、响应集合合法；
- 决策参与者与提交键；
- 活动钩子的实现可解析；
- 计数器类型、PRNG 类型；
- 状态 JSON 可序列化且往返稳定。

strict 模式下每个转移后都会检查；夹具的初始状态也会被检查。

---

## 8. 确定性、哈希与回放

- `canonicalize()` 对对象键排序，`hashString()` 使用 FNV-1a 64；
- `engine.getStateHash()` 返回 16 位十六进制；
- `engine.getHistory()` 保存完整动作历史（回放游标不影响它）；
- `replayTo(n)`：从 `s₀` 重放前 n 步；
- `verifyReplay()`：重放完整历史并比较哈希；
- `exportLog()` / `loadLog()`：JSON 事件溯源快照。

回放使用与实时完全相同的 `dispatch` 管线（包括决策、栈与 AOP），因此不是“重新 reduce”，而是“重新推演”。

---

## 9. 夹具与能力矩阵

| 夹具 | topology | hidden | interrupts | simultaneous | dynamic rules |
| --- | --- | --- | --- | --- | --- |
| Catan | hex-dual | ✓ | – | ✓ | – |
| Sanguosha | ring | ✓ | ✓ | – | ✓ |
| Splendor | none | – | – | – | – |
| Betrayal | graph | ✓ | ✓ | – | ✓ |
| Dune / Mahjong | none | ✓ | ✓ | ✓ | – |

Catan 夹具额外覆盖：蛇形初始布局、有限银行、港口 2:1/3:1、7 点弃牌/强盗/偷取、25 张发展卡、最长道路/最大军队、10 分胜利，以及对手不可见的 VP 分数卡（模块 redactor）。

山屋夹具额外覆盖：44 房间/三层楼层过滤/门位旋转、四维属性轨道与死亡物品堆、13 预兆/25 物品/45 事件、作祟中断帧、伤害分配决策、交易窗口、NPC 怪物回合与击晕、三个完整剧本；规则覆盖与内核缺口见 [BETRAYAL.md](BETRAYAL.md)，改造状态见 [KERNEL-EXPRESSION.md](KERNEL-EXPRESSION.md)。

夹具只实现规则；所有调度、隐藏信息、中断、热注入与回放均由内核完成。

---

## 9. 动作 Schema

模块可声明 `actionSchemas`，在**合法性之前**做结构校验：

```ts
actionSchemas: {
  COMMIT_BATTLE_DIAL: {
    type: 'COMMIT_BATTLE_DIAL',
    payload: {
      troops:    { kind: 'integer', required: true, min: 0, max: 50 },
      leaderStr: { kind: 'integer', required: true, min: 0, max: 20 },
      weapon:    { kind: 'string',  required: true, enum: ['Crysknife', 'Lasgun', 'Shield'] }
    }
  }
}
```

- 只校验已声明类型的动作；未声明类型退化为头部结构校验；
- 语义合法性仍在 `legalActions`；
- 校验发生在决策/响应路由之前，避免畸形提交进入秘密窗口。

实现：[validation.ts](../packages/kernel/src/validation.ts)。

---

## 10. 钩子依赖图

`RuleHookImpl.requires` 声明前置钩子：

- `RuleRegistry.dependencyErrors()` 检测缺失依赖与环；
- `RulePipeline.activate()` 要求前置钩子已处于活动状态；
- 执行顺序按“依赖优先 + 优先级降序”，避免同阶段内依赖倒挂。

```ts
{ id: 'haunt_attack_bonus', requires: ['haunt_base'], priority: 100, ... }
```

---

## 11. Bot 接口

`packages/harness/src/policy.ts` 提供最小策略接口与 `RandomPolicy`：

```ts
interface BotPolicy {
  id: string;
  choose(engine, playerId): Action | null;
}
```

- 只允许通过 `getLegalActions` + `dispatch` 交互，和人类玩家走同一条严格路径；
- `runPolicies(engine, policies, maxSteps)` 驱动焦点集，可用于回归、压测与后续 ISMCTS 接入；
- 固定种子 + 固定策略种子 ⇒ 完全可复现的对局。

---

## 12. 房间与投影差分（网络适配层）

`packages/net/src/room.ts` 是服务端权威房间的参考实现：

```ts
class GameRoom {
  submit(action): DispatchResult;
  join(viewer): RoomUpdate;            // 全量快照
  delta(viewer): RoomUpdate;           // 增量 RFC 6902 patch
}
```

- 只有被接受的动作才递增 `revision`；
- 差分在**投影**上计算，因此隐藏信息不会进入补丁；
- `applyClientDelta(previous, update)` 在客户端重建状态，测试保证与服务端投影逐字节一致；
- `exportState()` / `restore()`：种子 + 动作日志的检查点，恢复走完整重放而不是状态 dump；
- 这一层可以直接替换为 Durable Object / Phoenix Channel / Tokio actor，内核不变。

---

## 13. UI / 应用层边界

依赖方向是单向的：

```
apps/web/src/main.ts (composition root)
   │  creates
   ▼
UniversalSession (packages/app/src)  ──implements──▶  GamePresenter (DTOs)
   │  owns engine                              ▲
   ▼                                           │ subscribe / perform
UniversalGameEngine (packages/kernel/src)      │      UI (apps/web/src/ui)
                                               │
                                               ▼
                                   PresentationPorts (camera / audio / highlight)
```

- `apps/web/src/ui/**` **禁止 import** `core`、`games`、`render`、`net`、`ai`；
- `packages/app/src/**` **禁止 import** `ui`、`render`；
- UI 只消费 `GameSnapshot` / `UiAction` / `UiPlayer` / `UiHook` / `UiLog` 等 DTO；
- 动作标签、玩家卡片、阶段文案、日志脱敏全部在应用层生成；
- 动作若带声明式 `fields`，HUD 渲染通用表单，收集值通过 `perform(actionId, payload)` 回传；UI 不理解规则含义；
- 相机、音效、桌面高亮通过 `PresentationPorts` 回传，UI 不接触 Three.js 或引擎；
- 回放、重放校验、视角切换通过 `GamePresenter` 方法触发。

这条边界由 `scripts/test-core.mjs` 的 **Architecture boundary** 静态检查强制，并在 `pnpm test` 中失败即拒绝通过。

---

## 14. 逻辑时钟与超时

时间不进内核的 wall clock，而是显式的**逻辑时钟**：

- `GameState.clock` 只在内核控制动作 `{ type: '__TICK__', payload: { ticks } }` 时推进；
- 决策窗口与响应窗口在创建时由内核打上 `deadline = clock + TTL`（模块可用 `timing` 覆盖）；
- `__TICK__` 是日志中的正式动作，重放会以完全相同的顺序触发超时；
- 超时提交为 `PASS`，随后走与正常提交相同的结算与 `onDecisionResolved` 管线。

```ts
engine.dispatch({ type: '__TICK__', playerId: 'SYSTEM', payload: { ticks: 8 } });
```

UI 通过 `GamePresenter.advanceClock()` 触发，应用层只转发控制动作。

---

## 15. 可重放测试场景

夹具可以声明命名场景：

```ts
scenarios: {
  rich_action: {
    description: 'Setup complete, p1 has resources',
    setup: seed => buildRichState(seed)
  }
}
```

- `new UniversalGameEngine(module, seed, { scenario: 'rich_action' })`；
- 场景名写入 `exportLog().scenario`，`loadLog()` 恢复时自动使用；
- 回放、房间检查点、断线恢复因此都能重建同一起点；
- UI 可用 `?scenario=rich_action` 直达，用于人工验收。

---

## 16. 一致性测试

```bash
pnpm test          # 131 个内核 + 应用层用例 + 边界检查
pnpm test:core     # 同上
```

覆盖：

- 序列化/哈希稳定性与非法值检测；
- PRNG 确定性与洗牌；
- ECS 唯一归属；
- 栈 LIFO、响应收集、优先级短路；
- AOP 阶段/优先级/修改/取消/连锁；
- 秘密决策隐藏、原子揭晓、优先级策略；
- 投影遮蔽、虚拟 ID、区域重映射、动作日志脱敏；
- 不变量对损坏状态的拒绝；
- 非法动作不改状态；
- 确定性回放与日志载入；
- 时间机器前进/后退；
- 动作 Schema 的必填/枚举/范围校验；
- 钩子依赖图（缺失、环、激活前置、排序）；
- 五个夹具的初始化、随机对局、回放、投影安全；
- Catan：蛇形布局、7 点强盗流、建筑费用/银行守恒、玩家与港口交易、发展卡、弃半、最长道路/最大军队、隐藏 VP、10 分胜利；
- Bot 随机对局、同种子复现；
- 房间投影差分往返、隐藏信息不泄漏、秘密提交折叠、非法动作不递增 revision；
- 房间检查点导出/恢复（replay-through）；
- 模块级 redactor：秘密身份、私有全局变量；
- 逻辑时钟与决策超时、超时回放；
- 玩家级 deadline 独立到期；
- FIRST_ACCEPT 首个接受短路；
- 命名场景的导出/恢复与回放；
- Action.fields 参数表单到 payload 的端到端链路；
- 沙丘秘密决策流程、三国杀中断流程、山屋 23 条规则覆盖（探索/朝向/相邻门/战斗/作祟/三剧本/NPC 回合）；
- 应用层 Presenter：快照 DTO、按 id 执行动作、payload 合并、桌面拾取、视角重投影、通知；
- UI/应用层/内核的 import 边界静态检查。

---

## 17. 扩展清单

新增一款游戏只需：

1. 新建 `packages/games/src/<id>/setup.ts`，返回带 `seed/seq/pendingDecisions/activeHooks` 的初态；
2. 新建 `packages/games/src/<id>/rules.ts`，实现 `legalActions` 与纯 `reduce`；
3. 若有动态规则，新建 `hooks.ts` 并导出 `RuleHookImpl[]`（可用 `requires` 声明依赖）；
4. 在 `packages/games/src/registry.ts` 用 `defineGame()` 注册能力矩阵与可选 `actionSchemas`；
5. 在 `packages/harness/src/suite.ts` 增加一条夹具测试（初始化、随机对局回放、投影安全）；
6. `pnpm test` 必须全绿。

---

## 18. 后续方向

- 断线重连与超时后的参与者替换语义；
- 钩子依赖的跨阶段约束与可视化；
- 基于 `BotPolicy` 的 ISMCTS / 神经网络策略；
- 房间层接入真实 WebSocket 与持久化（Action Log + Snapshot）；
- 将响应窗口统一为 `DecisionWindow` 的一种特化，进一步收敛栈与决策协调器；
- 为 `globalVars` 增加模块级可见性声明，杜绝自定义字段的侧信道。
