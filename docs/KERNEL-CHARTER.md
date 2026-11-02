# 九元组可执行化宪章（Kernel Charter）

> 本文档是 `G = ⟨𝒩, 𝒮, s₀, 𝒜, ℒ, 𝒯, 𝒪, ℛ, 𝒦⟩` 从"词汇表"升级为"可执行约束"的设计基准。
> 它回答一个问题：**为什么七个游戏模组里只有 `betrayal` 用全了内核原语，其余六个把规则写进了 `globalVars`？**
> 结论是：不是九元组的数学不够，而是其中两个成员（𝒯、𝒦）在实现层被设计成了"万能函数"，其余成员的约束因此失去强制力。

本文档是 [ARCHITECTURE-REVIEW-2026-11.md](ARCHITECTURE-REVIEW-2026-11.md) 的附录 C，与 [ARCHITECTURE-ISSUES.md](ARCHITECTURE-ISSUES.md) 的多模组审查章节配套阅读。

---

## 0. 结论摘要

| 元组成员 | 代码落位 | 形式化程度 | 主要侵蚀 |
| --- | --- | --- | --- |
| 𝒩 参与者 | `players` / `npcs` / `actorOrder` | ✅ 结构化 | 健康 |
| 𝒮 状态空间 | `GameState`（22 字段） | ⚠️ 半结构化 | `globalVars: any` + `custom: any` |
| s₀ 初始位 | `module.setup()` | ⚠️ 只是函数 | 无契约（返回什么就是什么） |
| 𝒜 动作空间 | `Action { type: string; payload?: any }` | ⚠️ 半结构化 | `payload: any` + 字符串 type 无代数 |
| ℒ 合法动作 | `module.legalActions()` | ❌ 只是函数 | 无完备性 / 一致性约束 |
| 𝒯 转移 | `module.reduce(): GameState` | ❌ **万能函数** | 一次调用可含 8~64 次逻辑转移 |
| 𝒪 观察 | `CognitiveObserver.projectState()` | ✅ 较好 | 只认识 `VisibilityRule`，不认识 custom 语义 |
| ℛ 收益 | `module.outcome()` | ❌ 只是函数 | 与 𝒯 完全耦合，事后反推 |
| 𝒦 元规则 | `activeHooks` + `presentation` + `globalVars` | ❌ 大杂烩 | 规则 / 展示 / 状态混杂 |

**一句话**：九元组作为**词汇表**是够用的；作为**约束系统**失败了，因为没有一条约束规定"𝒦 能看见什么"、"𝒯 能改变什么"、"`any` 在 𝒮 里算什么"。

---

## 1. 现状证据

### 1.1 内核原语使用率矩阵

对 `packages/games/src/<game>/*.ts` 逐模块统计内核五类形式化原语的引用（`openDecision` / `InterruptStackManager` / `RollWindowManager` / `state.effects` / `GameModule.hooks`），以及 `globalVars` 出现次数：

| 游戏 | 决策窗口 Σ | 中断栈 Σ_stack | 掷骰窗 K4 | effects | 钩子 K_t | `globalVars` 出现 |
| --- | --- | --- | --- | --- | --- | --- |
| catan | ✓ | ✗ | ✗ | ✗ | ✗ | 37 |
| splendor | ✗ | ✗ | ✗ | ✗ | ✗ | 27 |
| betrayal | ✓ | ✓ | ✓ | ✓ | ✓ | 93 |
| poker | ✗ | ✗ | ✗ | ✗ | ✗ | 30 |
| sanguosha | ✗ | ✓ | ✗ | ✗ | ✓（名义） | 1 |
| dune_mahjong | ✓ | ✓ | ✗ | ✗ | ✗ | 11 |

**只有一个模组用全了内核原语。** 重启后若要重现这张表：

```sh
for g in catan splendor betrayal poker sanguosha dune_mahjong; do
  f=$(ls packages/games/src/$g/*.ts)
  printf "%-14s decisions=%s stack=%s rollwin=%s effects=%s hooks=%s globalVars=%s\n" "$g" \
    "$(grep -l openDecision $f | wc -l)" \
    "$(grep -l InterruptStackManager $f | wc -l)" \
    "$(grep -l RollWindowManager $f | wc -l)" \
    "$(grep -l 'state.effects\|addEffect' $f | wc -l)" \
    "$(grep -l hooks $f | wc -l)" \
    "$(grep -c globalVars $f | awk -F: '{s+=\$2} END {print s}')"
done
```

### 1.2 逃逸口的规模

`packages/kernel/src/types.ts` 中 `GameState.globalVars: Record<string, any>` 与 `Player.customProps / Entity.components.custom: Record<string, any>` 是全仓唯一的"任意形状"落点。实测其中活跃的 key：

```
hauntTriggered / tradeOffer / rollSeq / omensRevealed / bank / pendingRoomPlacement /
elevatorRide / seats / pendingExit / pendingDamage / hauntObjectives / hand / seating /
freeRoads / setupLastVertex / setupIndex / robberHexId / longestRoadOwner /
largestArmyOwner / observers / megaTokens / lastHand / frostRooms / committedDials /
battleMode / variant / scoreToWin / log / frontDoorLocked / finalRoundComplete /
revealedBattleResult / ports / playerCount / mahjongTileDiscarded / lastElevatorRoll / …
```

共 47 个 key，**没有一个被内核认识**。`components.custom` 里另有 `monster / stunned / carryingGirl / devType / destroyed / pkmnTier / evolvesTo / sanity / might / incorporeal / dead / traitIndex` 等。

### 1.3 `capabilities` 声明无人读取

`GameModule.meta.capabilities` 的 `simultaneousMoves / hiddenInformation / interruptStack / dynamicRules` 四个布尔位，在全仓的读取点只有一处：

```
apps/web/src/ui/mathInspector.ts:329-332   # 渲染成 UI 小标签
```

内核的调度、合法性、投影路径**从不读取它们**。能力位是给人看的，不是给机器用的 —— 这正是"九元组约束只存在于文档"的直接证据。

### 1.4 语义不变量完全缺席

`packages/kernel/src/invariants.ts` 的全部检查码（61 条）：

```
PLAYERS_* / NPC_* / ACTOR_* / ENTITY_* / ZONE_* / NODE_* / EDGE_* / TOPOLOGY_INVALID /
EFFECT_* / ROLL_WINDOW_* / STACK_* / DECISION_* / HOOK_* /
SEQ_ / CLOCK_ / ROUND_ / TURN_ / PRNG_ / SLOT_INVALID / STATE_NOT_SERIALIZABLE
```

**全部是结构一致性，没有一条语义守恒。** 直接验证：

```sh
grep -c "chip" packages/kernel/src/invariants.ts   # → 0
grep -nE "hand|chips|trait|room|monster" packages/kernel/src/invariants.ts   # → 无输出
```

因此 `strict: true` 的"内核保证"实际覆盖面只有结构层；"筹码守恒"、"血量归零必须 dead"、"手牌数 ≤ 上限"这类**规则正确性从未被内核校验过**。

---

## 2. 失效模式（附代码证据）

### F-1 `𝒯` 是万能函数，单步转移假设被打破

```ts
// packages/kernel/src/module.ts:469
reduce: (state: GameState, action: Action, ctx: ReduceContext) => GameState;
```

签名上没有任何类型级约束能保证它"只改变与该动作相关的部分"。德扑直接利用了这一点：

```ts
// packages/games/src/poker/rules.ts:605
public static applyAction(state, action, ctx) {
  return this.advanceAi(this.applyHuman(state, action, ctx), ctx);  // 内联推进，上限 64 次
}

// packages/games/src/poker/rules.ts:908
private static settle(state, ctx) {
  for (let guard = 0; guard < 8; guard++) {   // 一次 reduce 可关街、发牌、再关街、直至摊牌
    ...
    if (hand.street === 'RIVER') return this.showdown(next, ctx);
    next = this.collectBets(next);
    next = this.dealNextStreet(next, ctx);
  }
}
```

**影响**：一次 `reduce` 可包含 8~64 次逻辑转移。回放依然确定（seed 一致），但**合法性校验、中断拦截、审计日志的粒度全部失效**——内核无法在 64 次内联 AI 动作之间插入任何逻辑，也无法为其中任意一步做 invariant 检查。

### F-2 并发被降维成串行

```ts
// packages/kernel/src/types.ts  Action —— 单个 actor
interface Action { type: string; playerId: string; payload?: any; }

// packages/kernel/src/engine.ts  resolveOpenDecision —— 串行 reduce
for (const entry of orderedSubmissions(window)) {
  const reduced = this.reduceWithPipeline(current, submission, ctx, events);
}
```

**影响**：德扑边池、卡坦贸易竞标、山屋协同投票这类"多人同时生效"的规则，全部表现为**顺序敏感**。`𝒯` 的输入在数学上应是动作多重集（`𝒜*` 或 `×ᵢ 𝒜ᵢ`），实现里却是单动作流。

### F-3 随机源未被收口

内核提供 `ctx.roll()`（`engine.ts` 的 `makeContext`），但模组可以绕过：

```ts
// packages/games/src/betrayal/helpers.ts  drawRoomCandidate
DeterministicPRNG.shuffle((state.seed ?? 42) + items.length + attempts * 19, ...)

// packages/games/src/poker/ai.ts  noise()
let hash = 2166136261 >>> 0;
for (...) { hash ^= key.charCodeAt(index); hash = Math.imul(hash, 16777619) >>> 0; }
```

**影响**：内核的 `prngState` 只保证"输入相同 → 输出相同"，不保证"取随机的方式可达/可审计"。Chance node 没有被建成强制类型。

### F-4 `ℛ` 与 `𝒯` 完全耦合

`outcome(state)` 只读转移完成后的状态；收益在转移内部就被写死：

```ts
// poker/rules.ts:1179  showdown 里直接改筹码
next = setChips(next, pid, chipsOf(next, pid) + amount);

// catan/rules.ts  建造时直接改 score
```

**影响**：没有"这一步为什么得分"的独立审计口；作弊检测只能对比前后状态，无法回答"哪条规则给了这一分"。

### F-5 `𝒦` 语义边界从未定义 —— AI 读 raw state 的根源

```ts
// packages/games/src/poker/ai.ts
// 约束：策略是状态 → 动作的纯函数……只看自己的底牌 + 公共牌（合法信息），不窥探牌堆
function strengthOf(state: GameState, playerId: PlayerId) { ... }

// poker/rules.ts:478  合法动作直接给出 AI 的具体动作
const decided = choosePokerAction(state, playerId);
```

`choosePokerAction` 的入参是 **raw `GameState`**，不是 `ProjectedGameState`。九元组从未规定"𝒦 只能看见 `𝒪(s, i)`"，因此一个"只读自己底牌"的 AI 可以合法地读到对手筹码、牌堆顺序、下一张待发牌——只要它不写出来。

### F-6 钩子机制被绕开

```ts
// packages/games/src/sanguosha/hooks.ts  —— 名义上是八阵图判定
handler: () => ({
  type: 'CONTINUE',
  message: 'Eight Trigrams is active — the target may judge for a Dodge.'
})
```

这个钩子**只返回一句提示，不做任何判定**；真正的八阵图逻辑手写在 `rules.ts` 的 `JUDGE_BAGUA` 分支里。当 `𝒦` 的表达力不足以描述一条规则时，模组作者的实际反应是**把规则写回 reducer** —— 这不是模组作者的问题，是框架没给出口。

---

## 3. 宪章：9 条硬性约束

以下约束是内核演进的"是非标准"。任何新模组、任何内核改动，都必须能对照本节回答"满足 / 不满足"。

### C-1 动作代数（𝒜）

- `Action.type` 必须在 `GameModule.actionSchemas` 中声明，且 `payload` 必须有结构化 schema（禁止裸 `any`）。
- 若动作需要自由形状参数，必须显式标注 `payloadShape: 'free'`，并在 `docs/RULES-DEVIATIONS.md` 登记理由。

### C-2 单步转移（𝒯）

- `reduce` 一次调用**只允许产生一次**逻辑状态跃迁。
- 需要多步推进的规则（发牌、关街、结算）必须表达为 **follow-up action**（内核已有 LIFO 队列），或由驱动方按 `isAutomated` 逐步派发。
- 禁止在 `reduce` 内循环调用自身或内联驱动 AI。

### C-3 并发表达（𝒜*）

- 多人同时决策必须走 `pendingDecisions`，且其结算语义在 `DecisionPolicy` 中显式声明（`FIRST_ACCEPT` / `PRIORITY` / `SIMULTANEOUS`）。
- 新增 `SIMULTANEOUS` 策略：所有提交在同一转移内以动作多重集形式进入 `reduce`，由模组一次性消费，不允许"先到先得"的隐式串行。

### C-4 随机收口（chance node）

- `reduce` 签名**不注入** `DeterministicPRNG` 静态方法；随机只能通过 `ctx.roll(spec, seed)` 获取，且 `nextSeed` 必须写回 `state.prngState`。
- `ai.ts` 类的确定性噪声须命名为 `deriveNoise`，并接受投影状态作为输入。

### C-5 信息约束（𝒪）

- 任何"代机器决策"的函数（`isAutomated` 指向的 AI、`resolveSelection`、`statModifiers`）**只能接受 `ProjectedGameState`**。
- 内核在 `dispatch` 时校验：动作所引用的实体 / 节点 / 边必须在 `𝒪(s, actor)` 中可见。

### C-6 语义不变量（𝒮_semantic）

- `GameModule` 新增 `checkInvariants?(state: GameState): string[]`。
- 内核在 strict 模式统一调用；违规记录为结构化审计事件，而不是静默拒绝整次 dispatch。

### C-7 收益独立（ℛ）

- 状态跃迁产生的收益改动必须经过 `ctx.reward(actor, kind, amount, reason)` 的记账口，落进 `state.rewards`（只追加）。
- `outcome()` 仍是纯函数，但**必须能解释**最后一步收益来源（与 `rewards` 对照）。

### C-8 元规则分区（𝒦）

- `𝒦_rule`：`hooks`、`actionSchemas`、`validatePayload`、`resolveSelection`、`statModifiers` —— 只影响规则。
- `𝒦_view`：`presentation` —— 只影响呈现，**不得出现在任何状态跃迁路径上**。
- `𝒦_driver`：`timing`、`heartbeat`、`driverActions`、`isAutomated`、`actionCooldownMs` —— 只接受驱动方语义。
- 三者物理分离到不同接口字段，禁止混在一个对象里。

### C-9 扩展字段收口（𝒮）

- `globalVars` / `customProps` / `components.custom` **必须**在模块内声明类型并在 `meta.stateSchema` 中登记 key 集合。
- 内核据此做"未登记 key 出现即违规"的检查（避免规则悄悄长出内核不知道的状态）。

---

## 4. 分阶段落地

> **2026-11 实际进度**：C-1 ~ C-9 全部有可执行断言，且**已覆盖全部 6 个模组**。阶段 0 ~ 阶段 3 全部落地，包括 C-8 的物理分离（`𝒦_view` / `𝒦_driver` 不再混在同一个字段上）。
> 内核侧新增 `packages/kernel/src/charter.ts`（宪章执行器）与
> `packages/harness/src/suites/charter.ts`（12 条可执行断言）。
> 下面各阶段保留原计划，✅ 标记已完成项。

### 已完成（2026-11，本次实现）

| 条款 | 落地内容 | 验证 |
| --- | --- | --- |
| C-1 | `checkCharter()` 检查动作类型是否在 `actionSchemas` 中声明；探针在全仓扫出并补齐 8 个漏登记类型（`DRAW_CARDS` / `END_TURN` / `TRY_FRONT_DOOR` / `READY` / `SHOW` / `MUCK` / `FORCE_START` / `DEBUG_READY_ALL`） | `charter C-1` 两例 |
| C-2 | `observeTransitions()` 用 `turn` 增量作可观测代理，记录 `CHARTER_C2_MULTI_TRANSITION`；poker 经 `module.charter.deviations` 机器登记偏离，到期 2027-03-31 | `charter C-2` 两例 |
| C-5 | `choosePokerAction(view: ProjectedGameState)`；`poker/rules.ts` 经 `decisionView()` 先投影再决策；`deriveNoise(view)` 不再读 `prngState`；`ProjectedGameState.ownHand` 提供「自己的手牌」合法视图 | `charter C-5` 两例 |
| C-6 | `GameModule.checkInvariants()` + `engine.getViolations()`，**不阻断**转移。**全部 6 个模组**已落地：poker 筹码整除性 / 底池一致性 / 手号单调；catan 资源供给不超发；splendor 宝可球守恒；sanguosha 血量边界；dune 兵力与押注；betrayal 属性整数与房间存在性 | `charter C-6` 五例（含反向验证） |
| C-9 | `GameModule.meta.stateSchema.globalVars` + `customProps`；未登记 key 报 `CHARTER_C9_UNDECLARED_GLOBAL_VAR`；**全部 6 个模组**均已登记 | `charter C-9` 三例 |
| C-3 | 新增 `DecisionPolicy: { type: 'SIMULTANEOUS' }` 与 `GameModule.applySimultaneous()`；决策窗口结算时把动作**多重集**一次交给模组，内核不排序；未声明合并语义的模组退回串行并记 `CHARTER_C3_SERIALIZED`。dune 战斗之轮、catan 掷 7 弃牌已迁移 | `charter C-3` 四例 |
| C-4 | 运行期 `DeterministicPRNG` 调用必须推进 `prngState`；修掉 betrayal `drawRoomCandidate()` 用 `seed + items.length + attempts * 19` 拼假随机源的问题 | `charter C-4` 一例 |
| C-7 | `ReduceContext.reward()` + `GameState.rewards`（只追加）；reduce 期间模组拿到的是累积缓冲区，转移落地时由内核一次性写入，记账口本身不是新的可变逃逸口。poker（摊牌派池 / 弃牌取胜 / 观察者低保）与 catan（资源获取，加在 `grantResources()` 总闸上，覆盖掷骰产出 / 港口兑换 / 强盗抢夺）已接入 | `charter C-7` 四例 |
| C-8 | `𝒦_view` / `𝒦_driver` **物理分离**：驱动方语义（`aiActionDelayMs` / `actionCooldownMs` / `heartbeat` / `driverActions` / `isAutomated`）从 `GameModule` 顶层与 `presentation` 全部收进新的 `GameModule.driver`（`defineDriver()` 加载时校验）；另有静态扫描确保 `presentation` 不出现在 `rules.ts` / `helpers.ts` 的转移路径上 | `charter C-8` 五例 |

**C-6 实战成绩**：筹码守恒断言上线后立刻抓到一条真实记账问题——
`handBets` 记录的是整手累计投入，**已结算进 `pot` 的部分仍留在其中**，
因此守恒式必须写成 `在手 + pot + 当前街道 streetBets = 总额`，而不能直接加
`handBets`。没有这条语义不变量，这类错误只会在玩家发现「钱不对了」时暴露。

### 4.1 决策窗口审计（2026-11）

`applySimultaneous()` 只对**多人同时生效**的窗口有意义。对每个模组的实际窗口做一次
审计，避免为了"用上某个能力"而硬造场景：

| 模组 | 窗口 | 参与者 | 策略 | 需要 `applySimultaneous`？ |
| --- | --- | --- | --- | --- |
| catan | 掷 7 各弃一半 | 受害者（多人） | `SIMULTANEOUS` | ✅ 已实现（互不耦合） |
| catan | 交易提议 | 同房间其他玩家 | `FIRST_ACCEPT` | ❌ 先到先得是**玩法本身** |
| dune_mahjong | 战斗之轮 | p1 / p2 | `SIMULTANEOUS` | ✅ 已实现（平局守方胜） |
| betrayal | 交易提议 | 同房间其他玩家 | `FIRST_ACCEPT` | ❌ 同上 |
| betrayal | 伤害分摊 | **单人** | `ALL_COMMITTED` | ❌ 单人窗口无"同时"可言 |
| poker | **无决策窗口** | — | — | ❌ 下注是逐人表态，本质串行 |

**结论**：`poker` 与 `betrayal` **不需要** `applySimultaneous`。给它们硬加窗口会改变
发牌/流程语义，属于为形式化而形式化 —— 那正是本宪章要反对的做法。真正需要这条约束的
两个场景已经迁移完毕；日后若出现新的多人同时窗口，照 catan / dune 的写法补即可，
未声明时内核会记 `CHARTER_C3_SERIALIZED`，不会悄悄退化。

**catan 的交易窗口**是唯一有争议的一例：多人可同时接受，而实现是先到先得。
按项目决定保留该语义（抢单是玩法的一部分），因此**不**改代码，但登记在
[RULES-DEVIATIONS.md](RULES-DEVIATIONS.md) 的 C-3 条目里，说明这是有意为之而非疏漏。

### 4.2 全模组迁移记录（2026-11）

第一批只覆盖了 poker（示范），其余模组仍在绕过约束。第二批把 C-6 / C-7 / C-9 铺到全部 6 个模组：

| 模组 | C-9 声明 | C-6 语义不变量 | C-7 收益记账 |
| --- | --- | --- | --- |
| catan | 15 gv / 2 cp | 资源供给不超发（每种 ≤ 19） | ✅ `grantResources()` 总闸 |
| splendor | 10 gv / 6 cp | 宝可球守恒（持有 + 银行 ≤ 供给） | ⏳ 分数是派生值，无累加收益 |
| betrayal | 21 gv / 34 cp | 属性为整数；角色房间必须存在 | ⏳ 无筹码/分数型收益 |
| sanguosha | 2 gv / 4 cp | 血量 ∈ [0, maxHp] 且为整数 | ⏳ 同上 |
| dune_mahjong | 5 gv / 5 cp | 兵力非负；押注 ≤ 持有兵力 | ⏳ 同上 |
| poker | 7 gv / 8 cp | 筹码整除性 / 底池一致 / 手号单调 | ✅ 三处派发 |

**为什么 C-7 只铺了 2 个模组**：`state.rewards` 记的是"这次跃迁谁因为什么拿到多少"。
splendor / betryal / sanguosha 的分数是从场上实体派生的（每次重算整表），
没有"增量"，硬塞进流水账只会重复记录同一分。它们真正需要的是 C-6 的守恒断言，
那已经落地了。catan 与 poker 有真实的筹码/资源流动，所以接了记账口。

**C-9 的键集怎么来的**：多 seed 随机实跑（25 轮 × 260 步）取并集，再用源码静态扫描补漏。
验证标准不是"测试通过"，而是**跑 5000+ 步不出现 `CHARTER_C9_UNDECLARED_GLOBAL_VAR`**。

### 4.3 `𝒦` 三区分离的落点（C-8）

`GameModule` 上的字段现在按宪章 §3 的 C-8 分区：

| 分区 | 落点 | 字段 | 谁读 |
| --- | --- | --- | --- |
| `𝒦_rule` | 模块顶层 | `hooks` / `actionSchemas` / `validatePayload` / `resolveSelection` / `validateSelection` / `statModifiers` / `checkInvariants` | 内核 |
| `𝒦_view` | `GameModule.presentation` | `cardFacts` / `cardStyle` / `describeNode` / `describeTrait` / `traits` / `describeMoment` / `roleLabel` / `defaultViewer` / `mapTitle` / … | 视图层（HUD / 渲染） |
| `𝒦_driver` | `GameModule.driver` | `aiActionDelayMs` / `actionCooldownMs` / `heartbeat` / `driverActions` / `isAutomated` | 驱动方（app / server） |

**为什么这次拆分值得做**：`aiActionDelayMs` 不改变任何像素，只决定 AI 隔多久出手；
`heartbeat` 决定"每 20 秒派一拍"，与画面无关。它们原本住在 `presentation` 里，
导致"展示"与"驱动"无法分别演进 —— 想调 AI 节奏就得动展示层，反之亦然。

**迁移时的硬约束**：`definePresentation()` 现在对 `aiActionDelayMs` / `actionCooldownMs`
直接抛 `TypeError`，并提示改用 `defineDriver()`。这是有意的：旧写法必须报错，
否则两套并存，拆分等于没做。类型层面这两个键也从 `GamePresentationHints` 删除了，
`tsc` 会强制所有调用方搬完。

### 阶段 0（1 周）✅ 已完成：不改架构，先建立度量

1. 把 §1.1 的矩阵变成一个新的报告脚本（审查报告 [附录 B](ARCHITECTURE-REVIEW-2026-11.md#附录-b--审查复现命令) 已给出可直接落地的实现），在 CI 输出到构建日志（**不设门槛**，只做可见性）。
2. 在 `packages/kernel/src/module.ts` 中为 `GameModule` 增加 `checkInvariants?` / `meta.stateSchema?` 两个**可选**字段（**暂不启用**），让模组可以先声明。
3. 为 `docs/RULES-DEVIATIONS.md` 增加"宪章偏离登记"章节，模组可先登记："本模组内联 AI 推进，偏离 C-2，理由：…"。

### 阶段 1（1 个月）🔶 进行中：收紧最危险的两条（C-5 / C-6 德扑已落地，其余模组待接入）

1. **C-5 信息约束**（改动最小、收益最大）：
   - `ai.ts` 的 `choosePokerAction` 入参改为 `ProjectedGameState`；
   - `poker/rules.ts` 的 AI 分支改为先投影再决策；
   - 新增测试：断言 AI 的输出只依赖投影可见字段。
2. **C-6 语义不变量**：
   - 实现 `checkInvariants` 的调用点与失败上报（不阻断 dispatch，只记录 + 标记 `state.suspect`）；
   - 德扑先落地"筹码守恒"，山屋落地"怪物 ↔ entity 1:1"，卡坦落地"资源总量守恒"。

### 阶段 2（1 季度）：改造 `𝒯`

1. `reduce` 的签名保留，但新增 `transition(state, actions: Action[], ctx)`：内核在决策窗口结算时传入多重集。
2. 引入"内联 AI 推进"的官方替代：`driverActions` + 心跳逐步派发，删除 `advanceAi` / `settle` 的 for 循环。
3. 配置 `strict` 模式下"一次 reduce 只允许一次跃迁"的断言（按模组灰度开启）。

### 阶段 3（半年）：`ℛ` 独立与 `𝒦` 分区

1. 落地 `ctx.reward()` 与 `state.rewards`。
2. `presentation` 从 `GameModule` 拆到 `GameModule.view`，物理隔离。

---

## 5. 如何防止本宪章再次沦为文档

三条机械保障，缺一不可：

1. **可执行**：每条 C-x 都有对应的自动化检查（测试或 lint），在 `scripts/test-core.mjs` 的 architecture boundary 部分扩展。
2. **可观测**：报告脚本每次 CI 输出使用率矩阵，偏离趋势一眼可见。
3. **可登记**：偏离必须写进 `docs/RULES-DEVIATIONS.md` 并带理由与到期日；未登记的偏离在 CI 中报错（**新增模组**强制，**存量模组**灰度）。

> 没有这三条的"架构原则"只会变成下一份 `README`。
