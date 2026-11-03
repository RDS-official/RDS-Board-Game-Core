# 德州扑克 (Texas Hold'em) · 设计与接入方案

> 状态：**已实现并合并**（`packages/games/src/poker/`，2026-10-31）。本文保留设计原貌；
> 与实现的落地差异：座位数由房型决定（2–10，按房间实际人数发牌）、补上 TDA 45
> 累计短全押重开的最小加注，以及弃牌/手尾收牌进 `zone_muck` 的收尾流程。
> 目标读者：内核 / 夹具 / 表现层维护者
> 相关文档：[ARCHITECTURE.md](ARCHITECTURE.md)（分层与模块契约）、[CORE.md](CORE.md)（形式化模型）、[QUALITY-GATES.md](QUALITY-GATES.md)（必跑自检）

---

## 0. 摘要

在 `packages/games/src/poker/` 新增第六款夹具 **德州扑克（无限注）**，完全复用现有内核（纯 JSON 状态 + 纯函数 reducer + 投影 + 回放），不新增任何内核能力。

- 初始筹码 **1000**，盲注 **SB 5 / BB 10**（100BB 深度），默认 **4 人桌**；`scenarios` 提供 2 / 6 / 10 人桌与"短码演示"。
- **任意玩家筹码归零即结束整局**（按需求原文），胜者为剩余筹码最多者。
- 10 种牌型 + 边池 + 平分 + 短全押不重开叫注，全部在夹具内实现。
- 表现层只做"轻量增强"：复用通用环桌 / 手牌扇形 / 卡牌渲染，新增底池与筹码标签、公共牌整行排布。

---

## 1. 范围

### 1.1 必须实现（本期）

| 项 | 说明 |
| --- | --- |
| 52 张牌 | 无鬼牌；点数 A-K-Q-J-10…2，花色 ♠♥♦♣ |
| 人数 | 2–10；默认 4 人。`setup(seed, { seats })` 按调用方要的人数发牌（联机时 = 房间人数），`scenarios` 只是固定人数的演示/变体 |
| 盲注 | 小盲 = 大盲的一半（5 / 10），庄家位顺时针轮转 |
| 街道 | Pre-Flop → Flop → Turn → River → Showdown |
| 动作 | 弃牌 Fold / 过牌 Check / 跟注 Call / 加注 Raise / 全押 All-in |
| 牌型 | 皇家同花顺、同花顺、四条、葫芦、同花、顺子、三条、两对、一对、高牌 |
| 边池 | 多层边池，未跟注部分自动退回 |
| 平分 | 同牌型平分，奇数筹码按庄家左手顺位发放 |
| 终局 | 任意玩家筹码归零 → 立即结束，筹码最多者胜 |
| 隐藏信息 | 底牌仅本人可见；弃牌进暗弃区；摊牌才翻牌 |
| 确定性 | 洗牌走 `DeterministicPRNG`，回放哈希逐位一致 |

### 1.2 本期不做（明确排除）

- 锦标赛结构（涨盲、名次奖励）、保险、Straddle、Ante、Run-it-twice。
- 现金桌买入/补码（`REBUY`）——终局规则是"输光即结束"，补码与之冲突。
- 完整 AI 对手（现有 `RandomPolicy` 足以驱动矩阵测试与演示）。
- 网战房号体系改造（沿用现有 `apps/server/src/games.ts` 清单）。

---

## 2. 架构落位

严格遵循 `AGENTS.md` 的分层硬约束：内核零改动，游戏逻辑只在夹具，UI 只看 DTO。

| 层 | 文件 | 变更 |
| --- | --- | --- |
| 内核 `packages/kernel` | — | **零改动**（`DeterministicPRNG` / `ECSManager` / `CognitiveObserver` 已够用） |
| 夹具 `packages/games/src/poker/` | `cards.ts` `handEval.ts` `betting.ts` `setup.ts` `rules.ts` | 新增 |
| 注册表 `packages/games/src/registry.ts` | — | 注册 `pokerModule` |
| 应用 `packages/app/src` | `contracts.ts` `actionText.ts` `session.ts` `layout.ts` | 新增 `poker` 分支 |
| 渲染 `apps/web/src/render/scene.ts` | — | 公共牌整行排布 + 牌桌/底池/筹码标签 |
| 服务端 `apps/server/src/games.ts` | — | 房间清单加 `poker` 与人数变体 |
| 测试 | `packages/harness/src/suites/poker.ts`、`scripts/test-ui-matrix.mjs` | 新增 |

形式模型映射（沿用 `ARCHITECTURE.md` §1.1）：

- `s0` = `setupPoker(seed)` / `scenarios`；
- `A` = `FOLD | CHECK | CALL | RAISE | ALL_IN | START_HAND`；
- `L` = `PokerRules.getLegalActions`（只给当前行动者）；
- `T` = `PokerRules.applyAction`（纯函数，一次 reduce 内可连续推进多条街）；
- `O` = `CognitiveObserver`（底牌 `OWNER_ONLY`）；
- `R` = `PokerRules.checkWinCondition`。

---

## 3. 状态模型

### 3.1 座位与玩家

`playerOrder = ['p1' … 'pN']`，`p1` 为 seat 0，顺时针递增（与 `SEAT` 节点 `positionSpace: 'ring'` 的 `[seatIndex]` 一致）。

```ts
// players[pid]
{
  id, name: '玩家 1', color, avatar: '🂡',
  score: 1000,                       // = 筹码，HUD 直接显示
  alive: true,
  handZoneId: 'zone_hand_p1',
  customProps: {
    seat: 0,
    chips: 1000,                     // 权威筹码数
    inHand: false,                   // 本手是否参与
    folded: false,
    allIn: false,
    busted: false
  }
}
```

> 筹码只存 `customProps.chips`，`player.score` 作为镜像同写（HUD 与 `outcome` 都用 `score`）。
> 不变式：`score === chips`（在夹具内部维护，测试覆盖）。

### 3.2 牌与区域

52 张牌在 `setup` 时一次性建好，**永远存在于某个 zone**（满足 `ENTITY_ORPHAN` 不变式），每手重洗只重排 `zone_deck.orderedEntities`。

牌实体：

```ts
{
  id: 'card_s14',                    // card_<suit><rank>，s=s♠ h♥ d♦ c♣
  type: 'CARD',
  zoneId: 'zone_deck',
  visibility: { type: 'HIDDEN' },
  components: {
    cardFace: { title: 'A♠', suit: '♠', rank: 14, color: '#212121' },
    custom: { rank: 14, suit: 's', code: 'As' }
  }
}
```

区域（zone）：

| zone | 类型 | 可见性 | 布局 | 锚点 |
| --- | --- | --- | --- | --- |
| `zone_deck` | DECK | `HIDDEN` | STACK | 桌角 `[-6.2, 0.06, -3.4]` |
| `zone_hand_p{N}` | HAND | `OWNER_ONLY(ownerId)` | FAN | 各座位环上内侧 |
| `zone_board` | BOARD | `PUBLIC` | ROW | 桌面中心 `[0, 0.16, 0]` |
| `zone_burn` | DISCARD | `HIDDEN` | STACK | 桌角 `[-5.2, 0.06, -3.4]` |
| `zone_muck` | DISCARD | `HIDDEN` | STACK | 桌角 `[-4.2, 0.06, -3.4]` |

约定：**`zone_deck.orderedEntities[0]` 是牌堆顶**（发牌从头部取）。弃牌进 `zone_muck` 且可见性保持 `HIDDEN`（真实扑克的 muck，任何人不该看到弃牌）。

### 3.3 `globalVars` 契约

```ts
globalVars = {
  config: { startingStack: 1000, smallBlind: 5, bigBlind: 10 },
  hand: {
    handNo: 1,
    street: 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER' | 'COMPLETE',
    buttonSeat: 0,                  // playerOrder 下标
    sbSeat: 1,
    bbSeat: 2,
    pot: 0,                         // 已归集的底池（不含本街未归集注）
    currentBet: 0,                  // 本街最高投入
    lastRaiseSize: 10,              // 最小加注增量
    streetBets: { p1: 0, p2: 10, … },
    handBets:   { p1: 0, p2: 10, … },   // 本手累计投入（边池依据）
    actedSinceRaise: ['p2'],        // 自上次完整加注后已行动者
    folded: [], allIn: [],
    community: ['card_d7', …],      // 0..5 张
    lastAggressor: 'p2',
    // 本街每家最新动作（立牌上的徽章）；换街清空
    lastActions: { p2: '加注到 40', p3: '弃牌', p4: '跟注 10' }
  },
  lastHand: {                       // 上一手结算结果，供 HUD / 日志展示
    handNo: 1,
    pots: [{ amount: 240, winners: ['p3'], label: '葫芦 K 带 7' }],
    showdown: [{ playerId: 'p3', label: '葫芦', cards: ['K♠','K♥'] }, …],
    endedBy: 'SHOWDOWN' | 'FOLD'
  },
  log: [ '…' ]                      // 最多保留 40 条中文播报
}
```

> **不把底牌 id 写进 `globalVars`**：底牌永远是 `zone_hand_*` 里的实体，投影时自动打码；`globalVars` 只放公开信息（底池、注额、街、庄家位）。因此 `project.globalVars` 可以缺省不实现——这是本设计刻意保持的简单点。

### 3.4 不变量

- 每个 `card_*` 恰好在一个 zone 的 `orderedEntities` 中，且 `entity.zoneId` 与之一致（内核已校验）。
- `pot >= 0`，`chips >= 0`，`streetBets[p] <= handBets[p]`。
- `community.length ∈ {0,3,4,5}`。
- `hand.street === 'PREFLOP'` 时 `community.length === 0`，依此类推。
- `score === chips`。

---

## 4. 牌型评估 `handEval.ts`

纯函数、无状态、无随机：

```ts
export interface HandValue { category: number; tiebreak: number[]; label: string }
export function evaluateFive(cards: Card[]): HandValue;
export function evaluateSeven(cards: Card[]): HandValue;   // 21 组合取最大
export function compareHands(a: HandValue, b: HandValue): number;
```

- `category`：`8` 同花顺（含皇家）→ `0` 高牌（与需求列表顺序一致）。
- `tiebreak`：`[主牌组, …踢脚]` 的降序数组，直接字典序比较。
- A 可作 1：`A-2-3-4-5` 为顺子，`tiebreak[0] = 5`；`A-K-Q-J-10` 同花 → `label = '皇家同花顺'`。
- `label`：中文牌型名（`皇家同花顺 / 同花顺 / 四条 / 葫芦 / 同花 / 顺子 / 三条 / 两对 / 一对 / 高牌`），供播报与 HUD。

实现方式：`evaluateSeven` 枚举 `C(7,5)=21` 组，逐组 `evaluateFive` 取最大——比查表法慢但**可读、可测、状态无关**，单次摊牌 21 次比较，性能无虞。

---

## 5. 下注引擎 `betting.ts`

### 5.1 合法动作（仅当前行动者）

设 `toCall = hand.currentBet - hand.streetBets[me]`，`stack = chips`：

| 条件 | 产出 |
| --- | --- |
| 总是 | `FOLD` |
| `toCall === 0` | `CHECK` |
| `0 < toCall < stack` | `CALL`（`payload.amount = toCall`） |
| `0 < toCall && toCall >= stack` | `ALL_IN`（跟到底） |
| `stack > toCall` 且 `!actedSinceRaise.includes(me)` | `RAISE`（`fields.amount` = "加注到"，`min = minRaiseTo`，`max = streetBets[me] + stack`，`step = bigBlind`，`default = minRaiseTo`） |
| `stack > toCall` | `ALL_IN`（推全部） |

`minRaiseTo = currentBet + lastRaiseSize`；若 `minRaiseTo > 全押上限`，则只剩 `ALL_IN`（短全押）。

`RAISE` 用**声明式 `fields`**（`kind: 'number'`），UI 已有数字输入控件，无需新增交互；`withDefaultPayload` 会给 bots 填 `default`，矩阵测试可自动推进。

### 5.2 加注规则

- 完整加注（`raiseTo - currentBet >= lastRaiseSize`）：`lastRaiseSize = raiseTo - currentBet`，清空 `actedSinceRaise`，把加注者写入。
- 短全押（不足最小加注）：**不**更新 `lastRaiseSize`，**不**清空 `actedSinceRaise`（已行动者只能跟/弃，不能再加注）——标准 NLHE 行为；但**多次**短全押的增量会累加到 `shortRaiseAccum`，累计达到 `lastRaiseSize` 时按 TDA 45 重新打开叫注。
- `currentBet = max(currentBet, raiseTo)`；`handBets[p] += delta`，`chips -= delta`。

### 5.3 一圈结束条件（加注必须全桌平注才发牌）

**硬规则：任何一次加注都不会自己把牌发到下一街。** 一圈只有在"所有还能行动的座位都已补齐到 `currentBet`（平注），且自上次完整加注后都行动过"时才结束；在此之前，其他座位必须依次选择**跟注 / 弃牌 / 再加注**。

```
live = 未弃牌者
可行动者 = live 中未全押者
if (live.length === 1)                        → 直接结算（不摊牌）
if (可行动者.length <= 1 && 其 streetBets 已等于 currentBet) → 收注，推进下一条街
if (∀p ∈ 可行动者: streetBets[p] === currentBet && actedSinceRaise 覆盖全部可行动者) → 收注，推进
```

推进时：把 `streetBets` 全部并入 `pot`、清零 `streetBets`、`currentBet = 0`、`lastRaiseSize = bigBlind`、`actedSinceRaise = []`，然后按街发牌（含烧牌）。

行动顺序：

- Pre-Flop：`UTG = BB 左手`（2 人桌时 = 庄家/小盲先动）。
- Post-Flop：`庄家左手第一个未弃牌者`。

### 5.4 边池与平分

收注后按 `handBets` 分层建池（纯函数 `buildPots`）：

```
levels = 去重(handBets 中 > 0 的值) 升序
逐层：amount = (level - prev) * 该层贡献人数
      eligible = 该层贡献者中未弃牌者
合并 eligible 集合相同的相邻层
```

- 最高层只有 1 人贡献 → 该层即"未被跟注的注"，等价于自动退回，无需特判。
- 每个池只在 `eligible` 内比牌；同分平分（`Math.floor`），余数筹码从**庄家左手顺时针**第一位符合条件的赢家开始各发 1。
- `pot` 归零后写 `lastHand`、播报、清手牌到 `zone_muck`、公共牌回 `zone_deck`。

### 5.5 官方规则对照（TDA / WSOP 逐条自查）

> 说明：本机网络取不到 pokerTDA.com / wsop.com / Wikipedia 的正文（分别被 521、404 与连接拦截），下表依据 **TDA 2022 规则手册** 的条文编号与通行 NLHE 规则整理。若你手上有更新的条文，欢迎指出偏差，我会立刻对齐。

| # | 官方规则 | 依据 | 本实现 |
| --- | --- | --- | --- |
| 1 | 下注轮只在全员**平注**（或全押）后才结束，加注本身不发牌 | 下注轮定义 | ✅ `isRoundComplete`（`actedSinceRaise` + 每人 `streetBets == currentBet`） |
| 2 | 加注额不得低于本轮此前的最大**完整**下注/加注 | TDA 43 | ✅ `minRaiseTo = currentBet + lastRaiseSize` |
| 3 | 不足额全押**不**为已行动者重开叫注（他们只能跟/弃） | TDA 43 | ✅ `mayRaise = !actedSinceRaise.includes(me)` |
| 4 | **多次**短全押累加达到一个完整加注时，叫注重新打开 | TDA 45 *Multiple Short All-Ins* | ✅ `shortRaiseAccum`（本轮补齐） |
| 5 | 尚未行动者始终保留完整加注权 | TDA 43 | ✅ |
| 6 | 大盲短码时，最低跟注额仍是**完整大盲**（多出部分进边池） | TDA 30 | ✅ 发牌时 `currentBet = bigBlind` 恒定 |
| 7 | 翻后首次下注不得低于大盲 | 通行 NLHE | ✅ 每街 `lastRaiseSize` 重置为 BB |
| 8 | 单挑：庄家下小盲、翻前先行动、翻后最后行动 | 通行 HU 规则 | ✅ `startHand` 的 `liveCount === 2` 分支 |
| 9 | 翻后由庄家左手第一个未弃牌者先行动 | 通行 | ✅ `actorSeatFrom(buttonSeat)` |
| 10 | 翻牌/转牌/河牌前各烧 1 张 | TDA 推荐流程 | ✅ `zone_burn`（暗置） |
| 11 | 未被跟注的部分退回 | 通行 | ✅ `buildPots` 顶层单贡献者 |
| 12 | 平分余数筹码给庄家左手最近的赢家 | TDA 68 *Odd Chips* | ✅ `splitAmount` + `seatDistance` |
| 13 | 全员全押后剩余公共牌自动发完并摊牌 | 通行 | ✅ `settle` 循环 |
| 14 | 摊牌由最后加注者先亮牌 | TDA 64 | ⚠️ **简化**：所有存活手牌同时亮出（模拟器/教学更直观，不改变胜负） |
| 15 | 弃牌后不得再查看/亮出该手牌 | 通行 | ✅ 进 `zone_muck`（`HIDDEN`） |
| 16 | 无注在身时允许弃牌（不鼓励） | TDA 84 | ✅ `FOLD` 始终可用 |

**与官方规则的刻意差异（仅第 14 条）**：摊牌一次性亮出全部存活手牌，不做"输家可 muck 不亮"的处理。其余 15 条与条文一致。

---

## 6. 流程状态机

```
            START_HAND
HAND_OVER ─────────────► PREFLOP ──┬─► FLOP ──┬─► TURN ──┬─► RIVER ──┬─► HAND_OVER
   ▲                               │          │           │           │
   │                          全员弃牌/仅剩 1 人（任意街）              │
   └───────────────────────────────┴──────────┴───────────┴───────────┘
                        摊牌结算 / 提前收池
```

- `state.phase` ∈ `HAND_OVER | PREFLOP | FLOP | TURN | RIVER`，`state.activePlayerId` 恒为**当前该行动的人**（`HAND_OVER` 时为下一手 UTG）。
- `START_HAND`：重洗 52 张 → 移庄 → 收盲注 → 各发 2 张 → 置 `PREFLOP`。
- 一次 `reduce` 内允许"结算 + 推进"多次连续发生（例如河牌全押直接摊牌），全部同步完成，保持状态机单调、可回放。
- `HAND_OVER` 时给 UTG 一个 `START_HAND`，让玩家先看清上一手结果再开下一手（也保证 `RandomPolicy` 有动作可推进）。

---

## 7. 终局规则与观察者席位

牌局**不再因为有人输光而结束**。输光的人转成观察者，座位由补位 AI 接手，牌桌
始终满员；观察者攒够买入就能重新上桌。

### 7.1 破产 → 观察者 → AI 补位

每手结算（`afterHand`）后：

1. `chips === 0` 的座位逐个处理：
   - **真人**：写入 `globalVars.observers.list`（`playerId / seatIndex / stipendSeconds /
     pendingSeat / sinceHand`），玩家本身保留在 `state.players` 里但 `status = 'SPECTATOR'`、
     `alive = false`，并退出 `playerOrder`。
   - **AI**：直接退场（记录删除）。
2. 座位换上一名补位 AI（id 形如 `p4a1`，序号存在 `observers.aiSerial`），带
   `config.startingStack` 重新买入；`globalVars.seats`、座位节点 `props.playerId`、
   `zone_hand_*` 扇形位置一起换到新 occupant。
3. `playerOrder` 长度不变，庄家/盲注/行动顺序继续按座位环走。

### 7.2 低保

- 观察者筹码 `< 100` 时，每满 **60 秒** +**10** 筹码（`POKER_OBSERVER`）。
- 内核没有时钟：节奏由 `GameModule.heartbeat`（20 秒一拍）声明，`UniversalSession`
  与 `ServerMatch` 各自派发 `OBSERVER_TICK{seconds}`。动作进 `actionLog`，回放仍然确定。
- `OBSERVER_TICK` 是 `driverActions`：不出现在任何玩家的动作表里，服务端入口直接拒绝。

### 7.3 重新上桌

- 观察者筹码 ≥ 一个大盲时可派发 `OBSERVER_REJOIN`。
- 换桌目标用 `DeterministicPRNG` 从当前 AI 座位里随机挑，写进 `pendingSeat`。
- **本轮结束才生效**：请求发生在牌局中，就在下一次 `afterHand` 落座；请求发生在
  结算态（`street === 'COMPLETE'`）时本轮已经结束，立即落座。
- 落座时观察者带着自己的筹码顶替该 AI 座位；被顶替的 AI 退场。

### 7.4 开局座位次序

`setupPoker` 用状态种子洗 `roster`（身份 + 筹码 + AI 等级绑定在人身上），再依次落到
0..N-1 号座位；`playerOrder` 因此就是座位环。`shuffleSeats: false` 留给需要精确
座位号的测试剧本（`pokerScenario` 默认关掉）。

---

## 8. 隐藏信息与投影

- 底牌 `visibility: OWNER_ONLY`，`zone_hand_pN` 同样 `OWNER_ONLY`。
- 投影时 `CognitiveObserver` 会把不可见实体换成 `v_id_xxx` 别名 + `cardFace.title = 'Hidden'`，因此**其他玩家的底牌不会泄漏**（`fixtureConformance` 的"projections never leak hidden card faces"用例自动覆盖）。
- 摊牌：`reduce` 内把参与摊牌玩家的底牌 `visibility` 改为 `PUBLIC`（不移动实体，只改可见性），随后结算。
- 弃牌：移到 `zone_muck` 并保持 `HIDDEN`。
- **已知可接受泄漏**：`zone_deck.orderedEntities` 的顺序在投影里以别名单形式可见。由于别名不含花色/点数信息，且任何被揭示的牌在摊牌后本就是公开信息，判定为不可利用；与现有 `betrayal` 牌堆处理方式一致。若后续需要，可在内核加"zone 顺序脱敏"，本期不做。

---

## 9. 确定性与回放

- 洗牌：`DeterministicPRNG.shuffle(state.prngState, deckIds)` → `state.prngState = nextSeed`。**禁止** `Math.random`。
- 发牌/移动：`ECSManager.moveEntity`（纯函数）。
- 播报 id：`ctx.id('poker')`。
- 状态只含 JSON：无类实例、无闭包、无 Map/Set。
- 目标：`pnpm test:matrix` 三个种子 + 全部场景，`verifyReplay()` 全绿。

---

## 10. 表现层

### 10.1 应用层 `packages/app/src`

| 文件 | 变更 |
| --- | --- |
| `contracts.ts` | `GAME_TABS` 增加 `{ id: 'poker', icon: '♠️', name: '德州扑克' }` |
| `actionText.ts` | `FOLD/CHECK/CALL/RAISE/ALL_IN/START_HAND` 的中文图标、文案、`fields` 透传（跟注金额、加注到多少写进 label/hint） |
| `session.ts` | `phaseLabelOf`：`PREFLOP · 底池 240 · 需跟 20 · 大盲 10`；`missionLineOf`：盲注与庄家位；`buildPlayersView`：`scoreLabel='筹码'`，`pips` 显示筹码 / 本街已下注，`stats` 显示 `D / SB / BB` 位置标记与"弃牌 / 全押"状态 |
| `layout.ts` | `poker: { padding: 6, cameraDirection: [0.02, 0.82, 0.58], minDistance: 14 }`（俯视感更强） |

### 10.2 渲染层 `apps/web/src/render/scene.ts` 与 `procedural/`

复用已有能力：`SEAT` 环（座位用显式世界坐标，见 §14.2）、`HAND` 扇形手牌、`CARD` 牌面网格。新增：

1. **公共牌整行排布**：非房间 `BOARD` 分支支持最多 5 张、整行居中，并按**手牌同级尺寸**渲染——半尺寸牌面在斜视角下点数会糊成噪点。
2. **牌桌**：毛毡椭圆（`pokerClothTexture`：编织纤维 + 中心光池 + 边缘压暗，单张贴图不重复）、深色护边、黄铜圈。
3. **筹码**：`procedural/chipMesh.ts`——单枚 = 圆柱 + 彩绘顶面（白边条 + 面值），500/100/25/5 四种面值（刻意不用 1000：深码会缩成单枚金币，看起来"桌上没筹码"）、每堆最多 10 枚；每个座位渲染**筹码堆**（剩余）与**本街注堆**，桌心渲染**底池堆**（`POT · 底池 N` 标签在其上方）。
4. **座位立牌**：`procedural/seatPlate.ts`——实物摆件：**黑色磨砂金属圆盘**底座（同心车削纹 + 黄铜槽）+ **卡牌尺寸的木板**后仰立在上面（0.86 × 1.24，与桌面上的牌同尺寸）。牌面按木种贴图（头像圆章 + 昵称 + 两行详情 + **动作徽章**）；圆章优先画玩家真头像（`avatarUrl`，圆形裁切 + cover，图片异步到货后只重绘圆章），没有真头像时用 emoji 兜底（AI 座位是花色），行动中玩家的牌有黄铜描边与 ▶ 标记；**点击立牌打开玩家详情面板**（角色、筹码、状态、属性轨、增益），名字不再重复画 DOM 标签。立牌**逐帧朝相机偏航**，再叠加按座位 id 哈希的 **±30° 随机偏移**——完全对准会像列队、看不出桌面结构，哈希保证重建同步后角度不跳变。大小盲的立牌木种不同：大盲**松木**、小盲**红松**、其余黑桃木（深胡桃）。
   - **悬停放大**：指针停在立牌上时，`buildActorDetailView`（`packages/app/src/inspect.ts`，只读 `UiPlayer`、不认识任何 gameId）把座位投影成中性 `UiDetailView`，`Hud.showSeatPeek` 用仲裁器的 `peek` 槽画成**独立浮窗**（高度 = 视口 1/3，宽度按 0.86 : 1.24 的牌面比例）。浮窗固定放在指针旁 26px 处并夹在视口内，绝不压在指针下——否则会「盖住光标 → 悬停结束 → 浮窗关闭」自激抖动。
   - **弃牌标记常驻**：某座位一旦弃牌，徽章在整个牌局（所有街）保持显示，不再随换街清空；换手才重置。
5. **无反光牌面**：扑克牌用 `MeshBasicMaterial`（贴图即所见）。桌面由强顶光 + ACES 色调映射驱动，Standard/Lambert 纸面在斜视角会被高光或曝白糊掉；无光照材质保证任何机位都能读清点数与花色（纹理同时调暗为 `#f2eddc` 防削顶）。
6. **动画**（`animatePokerDeltas`：对比上一帧投影快照触发，每段 2–4s）：
   - **发牌**：底牌从牌堆逐一弧线飞向各座位（错峰自适应人数 + 翻滚），总时长约 2.4–3s；
   - **翻牌**：公共牌背面飞到槽位、落位前 30% 翻面（rotate.x -π → 0）；翻牌三张错峰 ≈2s，转/河单张 ≈2s；
   - **下注**：加注/跟注把一叠筹码从座位弧线飞进底池（错峰 80ms），同时 `+金额` 标签升起淡出，≈2.4s；
   - 动画对象每次同步前 `clearPokerFx` 清空，新的同步干净重置演出；`animationQueue.animate(..., delayMs)` 提供错峰。
6. 弃牌区/牌堆沿用通用 STACK 渲染。

> 渲染层只读投影状态，不参与规则；`layoutForGame` 与 `gameId` 分支都保持在 app/render 层，符合边界检查。

### 10.2.1 座位视角（每个玩家的默认机位）

- `BoardGameScene.setSeatView({ playerId | seatIndex })`：沿「桌心 → 立牌」的延长线
  退到立牌外侧 `max(7, rx × 1.05)`、抬到 `2 + back × 0.29` 的高度，视线落在自己立牌
  顶沿稍往里一点（`seat − outward × 2.6`，y = 0.7）。立牌占画面中下部，牌桌在它上方
  展开——和真人坐在桌边的视野一致。
- 取景量是**相对立牌**的常数，不用椭圆桌的绝对半径：长轴座位和短轴座位看到的立牌
  大小一致，不会出现「有的座位贴脸、有的退太远」。
- **谁是我**：单机牌桌不再默认开在上帝视角。`presentation.defaultViewer` 把
  「本桌第一个真人座位」报给通用层（`pokerDefaultViewer`，读 `globalVars.seats`
  的 `isAi` 标记；全 AI 桌 / 已进观察席的座位返回 null），`UniversalSession`
  开局即绑定它——首帧的投影、`ownHand` 与操作栏因此都属于本人，revision 仍从 0
  起算（绑定是初始状态，不是一次变更）。联机座位由服务器下发，`NetSession`
  只认权威结果，这条声明不参与。
- 默认机位：`viewer !== 'GOD'` 时打开房间直接坐在自己的座位上；切换认知滤镜到某名
  玩家也会跟过去。上帝视角保持 2.5D 等轴，「座位」按钮在上帝视角下逐个座位轮播，
  方便逐个座位目视检查。观察者没有座位，镜头停在自己坐过的那一侧。
- **行动者 ≠ 视角**：操作栏第一行的 `actorName` 读 `focusActors`（真正轮到的人），
  不是视角本人。绑定视角之后如果仍按视角写，轮到 AI 时会显示「行动者 玩家 1」，
  玩家会以为该自己出手；`|ℒ|` 保持「我能做什么」的语义，两者不再互相冒充。
- **座位变了镜头就跟着走**：观察者回桌换到另一座、补位 AI 顶座、入座等都会让
  `seatViewKey`（`viewer@座位号` / `viewer@obs原座位`）变化，于是重新取景；
  同一个座位不会因为普通状态更新而重置，玩家自己拖出来的角度会保留。

#### 10.2.1.1 公共牌正对观察者（PR2）

镜头坐到自己那一侧以后，公共牌仍然沿世界坐标的正北朝向铺开 —— 于是除「恰好朝北」
的那一座以外，其余座位看到的牌都是歪的：p1 座位上实测倾角 −85°（横躺着看），
p6 座位是 180°（上下颠倒），牌面宽度只剩 16–33px。这不是镜头问题，是**牌行自己的
朝向**问题：一块摊平的牌只有一条「上」方向，而座位是从自己那一侧看它的。

- 能力声明：`LayoutHints.boardFacesViewer`（`packages/app/src/layout.ts`，扑克声明为
  `true`）。渲染层只问「这一行牌该不该跟着观察者」，不问「这是哪款游戏」——
  `apps/web/src/render/scene.ts` 的 `boardViewerBearing()` 是唯一的入口，`render`
  目录里没有一处按 `gameId` 决定朝向。
- 纯布局函数：`apps/web/src/render/boardFacing.ts` 的 `boardRowFrame()`。给定观察者
  座位朝向 `out`（桌心 → 座位，单位向量）：
  - 牌行沿该座位的**切线** `axis = (outZ, −outX)` 排布（间距仍是 `BOARD_ROW_PITCH`
    = 0.98，整行宽度不变）；
  - 每张牌偏航 `yaw = atan2(outX, outZ)`，即牌面顶端朝**离开**观察者的方向；
  - `out = (0, 1)` 退化成 `yaw = 0`、`axis = (1, 0)`，正是旧的固定朝向。
  函数是纯的，座位无关、单位无关，`packages/harness` 直接import 断言，不需要浏览器。
- 生效条件（三条同时成立，否则保持旧画面）：游戏声明了能力、`viewerId` 不是 `'GOD'`、
  该观众有投影后的 SEAT 节点。上帝视角、观察席、没有座位概念的游戏都走旧路径，
  调试与截图脚本看到的仍是原样。
- 动画配合：发牌不再把 `rotation.y` 写成绝对值，而是从「该牌自己的静止朝向」
  （`mesh.userData.restYaw`：手牌 = 自己座位的朝向，公共牌 = 当前观察者朝向）起转，
  落地正好停在牌行的朝向上；翻牌用 `rotation.order = 'YXZ'`，绕牌自己的长轴翻，
  于是行首行尾的牌不会侧翻。
- 可读性下限（探针硬断言）：座位上 `|倾角| ≤ 15°`、牌面宽度 `≥ 60px`（1400×900）。
  实测 6 个座位全部 `0–12°`、`82–99px`；改动前是 `−85…180°`、`16–33px`。
- 回归：`pnpm probe:board`（`scripts/probe-board-facing.mjs`，真实浏览器逐座位投影，
  屏幕空间测倾角与宽度）；纯布局数学在 `test:core` 的 `presentation` 用例里。

#### 10.2.1.2 自己的手牌不被操作区盖住（PR3）

手牌行铺在自己座位前方的桌面上（`HAND_ROW_DEPTH`），而动作坞压在画布左下：桌面端
占 `1/7 … 4/7` 宽（`#142`），1200px 以下变成整条底部抽屉，手机上又收成窄条。实测
（7 个视口 × 扑克 / 三国杀）：**5–6 个视口里每张手牌被盖住 65–100%**，玩家等于是
隔着动作按钮看自己的底牌。

- 深度不是常数，是**按帧求解**的：`apps/web/src/render/handRowDepth.ts` 的
  `solveHandRowDepth()`。从「偏好深度」（2.0）往里收，返回第一个投影能避开所有
  HUD 占位的深度——也就是**仍能避开的最大深度**，手牌因此停在离自己座位最近的位置，
  只退到刚好够用的地方，不会被推到桌心。求解器纯函数，屏幕空间进、世界单位出。
- HUD 的真实占位由 `hud.reservedScreenBoxes()` 量出（动作坞 / 手持区 / 玩家栏 /
  事件流 / 房间卡，隐藏的滑出面板不计），经 `scene.setReservedScreenBoxes()` 下推。
  按 DOM 实测而不是写死断点，是因为同一份 CSS 在 1024×768（整宽抽屉）与
  390×844（窄条）下差别极大。
- **镜头一动就重算**：深度取决于机位——等轴视角下手牌投影在桌面中部，座位视角下才
  落到 dock 上。只在快照时求解会把发牌那一刻（镜头还在等轴）的答案冻住，所以
  `refreshHandDepthsForCamera()` 在相机矩阵变化时重解一次。这是本 PR 里唯一一个
  非显然的坑：先按快照求解，测出来仍是 96%。
- 实测（扑克 + 三国杀 × 7 视口）：全部 `0%` 遮挡，牌宽 `36–70px`；关闭这条能力后
  同一探针立刻在 11 项上失败（`48–100%`）。
- 回归：`pnpm probe:hand:view`（`scripts/probe-hand-visibility.mjs`，真实浏览器逐视口
  投影求交）；求解器数学在 `test:core` 的 `presentation` 用例里。

### 10.3 操作区图标与牌面同源

动作坞不再用 emoji：`actionText.ts` 为扑克动作返回**内联 SVG**（30×30），与 3D 牌面同一套调色板（象牙 `#f2eddc`、墨黑 `#15161a`、赌场红 `#c8102e`、黄铜 `#c9a24a`、毛毡绿 `#17603a`）与同一母题——小牌面（点数+花色、红黑同 3D 牌）、背面红格纹、白边条筹码与筹码堆。六个动作各一枚：发牌（双牌扇）、弃牌（划线牌）、过牌（毛毡勾）、跟注（牌+筹码）、加注（筹码堆+箭头）、全押（发光筹码堆）。

> 分层约束下 UI 不能引用 render 层，故图标是 app 层的矢量镜像；两边调色板常量必须同步修改。

### 10.4 UI 层 `apps/web/src/ui`

动作坞（含数字 `fields` 表单）、手牌区、玩家卡（`pips`）均为通用实现。观察席是唯一
新增的通用面板：`GameSnapshot.observers`（`UiObserver`）给出名字、筹码、下一笔低保
倒计时和换桌状态，按钮走 `GamePresenter.rejoinTable(playerId)`；没有观察者概念的
游戏不返回这个字段，面板整块隐藏。

---

## 11. 联机与服务端

`apps/server/src/games.ts` 增加：

```ts
{
  id: 'poker', name: '德州扑克', minPlayers: 2, maxPlayers: 10,
  clientUrl: '/games/rds-board-core/', protocol: 'rds-room/1', durationMin: 40,
  accent: '#4ec9b0',
  variants: [
    { id: 'seats_2', label: '单挑（2 人）' },
    { id: 'seats_6', label: '6 人桌' },
    { id: 'seats_10', label: '10 人满桌' }
  ]
}
```

`variants.id` 直接映射到 `module.scenarios`，房间创建时以 `scenarioId` 透传给 `UniversalGameEngine`（与 betrayal 的 `exploration` 变体同一条链路）。

---

## 12. 测试与验收

### 12.1 新增 `packages/harness/src/suites/poker.ts`

| 用例 | 断言 |
| --- | --- |
| 牌型表 | 10 类牌型各一条固定牌面 → `category/label` 正确；A-5 轮子顺；皇家同花顺 |
| 踢脚比较 | 同牌型不同踢脚的大小关系（一对 A vs 一对 K、两对、葫芦） |
| 最小加注 | `minRaiseTo` 计算；不足额 `RAISE` 被 `validatePayload` 拒绝 |
| 加注必须平注 | 加注到 60 后，按钮跟、小盲跟，**大盲还欠 50** → 仍是翻前、无公共牌；大盲补齐才发翻牌（`a raise keeps the street open until every seat has matched it`） |
| 短全押也必须补齐 | 全押只比当前注多 5 时，其余两个座位都要各补 5 才发翻牌（`a short all-in still has to be matched before the next street`） |
| 短全押 | 短全押后已行动者不再获得 `RAISE` |
| 短全押累加 | 两次各 +5 的短全押凑满一个大盲 → 叫注重开（TDA 45）；单次 +5 不重开 |
| 边池 | 3 人不同筹码全押 → 池分层与归属正确 |
| 平分 | 同牌型 → 均分；奇数筹码归庄家左手 |
| 未跟注退回 | 一方超额下注无人跟 → 退还 |
| 盲注轮转 | 连续两手 `buttonSeat` 前进 1，SB/BB 正确 |
| 输光终局 | 短码场景打到底 → `gameOver`、`winner` 为筹码最多者 |
| 隐藏投影 | 非摊牌状态下对手底牌 `isMasked`，`cardFace.title === 'Hidden'` |
| 确定性 | 同种子两次对局 `getStateHash()` 相同；`verifyReplay()` 通过 |

### 12.2 现有自动覆盖（新增夹具后自动纳入）

- `fixtureConformance`：初始不变式、随机对局 + 逐位回放、投影不泄漏隐藏牌面。
- `bots`：`RandomPolicy` 25 步无错误。
- `sessionRoom`：投影不泄漏真实 id。
- `scripts/test-matrix.mjs`：3 种子 × 全部场景，回放一致。

### 12.3 必跑自检（提交前）

```bash
pnpm test            # 含新增 poker 用例
pnpm test:matrix     # 新夹具进入随机对局矩阵
pnpm test:ui         # 新增 poker 屏幕
pnpm probe:board     # 逐座位验证公共牌正对观察者且可读（§10.2.1.1）
pnpm probe:hand:view # 逐视口验证自己的手牌不被操作区盖住（§10.2.1.2）
pnpm docs:check      # 本文链接有效
pnpm lint
node node_modules/typescript/bin/tsc --noEmit && pnpm run build
```

`probe:layout` / `probe:overlap` 不涉及（不改 `roomTile.ts`）。

---

## 13. 文件清单与工作量

| # | 文件 | 类型 | 预估 |
| --- | --- | --- | --- |
| 1 | `packages/games/src/poker/cards.ts` | 新增 | 60 行 |
| 2 | `packages/games/src/poker/handEval.ts` | 新增 | 180 行 |
| 3 | `packages/games/src/poker/betting.ts` | 新增 | 200 行 |
| 4 | `packages/games/src/poker/setup.ts` | 新增 | 220 行 |
| 5 | `packages/games/src/poker/rules.ts` | 新增 | 420 行 |
| 6 | `packages/games/src/registry.ts` | 改 | +60 行 |
| 7 | `packages/app/src/{contracts,actionText,session,layout}.ts` | 改 | +160 行 |
| 8 | `apps/web/src/render/scene.ts` | 改 | +120 行 |
| 9 | `apps/server/src/games.ts` | 改 | +15 行 |
| 10 | `packages/harness/src/suites/poker.ts` + `suite.ts` | 新增/改 | +320 行 |
| 11 | `scripts/test-ui-matrix.mjs` | 改 | +3 行 |
| 12 | `docs/POKER.md`、`docs/ARCHITECTURE.md` | 新增/改 | 本文 |

分支：`users/xhopo/add-texas-holdem`（禁止直推 `main`，走 PR）。

---

## 14. 已确认的设计选择（评审通过）

| # | 议题 | 结论 |
| --- | --- | --- |
| Q1 | 终局判定 | **任一玩家筹码归零立即结束，筹码最多者胜**（并列则并列胜）。判定基准是"一手结算完成后 `chips === 0`"，所以全押过程中筹码暂时为 0 不会误触发终局 |
| Q2 | 桌型与注额 | 默认 **4 人 · 1000 筹码 · SB5 / BB10**；`scenarios` 提供 **2~10 人全档位**（`seats_2` … `seats_10`）+ `short_stack`（短码演示，用于验证终局） |
| Q3 | 下注结构 | **无限注 NLHE**：`RAISE` 可加注到筹码上限，短全押不重开叫注 |
| Q4 | 表现层投入 | **轻量增强**：复用环桌 / 手牌扇形 / 卡牌渲染，新增底池与筹码标签、公共牌整行排布 |

### 14.1 场景清单

| scenario | 人数 | 说明 |
| --- | --- | --- |
| （默认 `setup`） | 4 | 1000 筹码，SB5 / BB10 |
| `seats_2` | 2 | 单挑：庄家即小盲，翻前先行动 |
| `seats_3` … `seats_10` | 3–10 | 满档位覆盖，牌桌椭圆半径随人数放大 |
| `short_stack` | 4 | p4 只有 60 筹码，数手内必然触发"输光即结束"，供矩阵与 UI 测试 |

### 14.2 座位环的实现约定

内核 `spatialProjection` 的 `positionSpace: 'ring'` 用固定 90° 步长投影，**最多只能摆 4 个座位**。因此 poker 的 `SEAT` 节点直接写**世界坐标**（`position: [x, 0.1, z]`，按人数算椭圆），
`topology` 仍声明 `kind: 'ring' / adjacency: 'neighbors'` 供邻接与标签使用。渲染层 `seatFrame` 读 `node.position[0]/[2]`，天然支持 2–10 人。

---

## 15. 里程碑

1. **M1 规则内核**：`cards/handEval/betting` + 单元测试全绿（不含 UI）。
2. **M2 夹具接入**：`setup/rules/registry` + `pnpm test`、`pnpm test:matrix` 全绿。
3. **M3 表现层**：app DTO + scene 牌桌/底池 + `pnpm test:ui` 全绿。
4. **M4 收尾**：`docs/POKER.md` 定稿、`ARCHITECTURE.md` 夹具表更新、`lint`/`tsc`/`build` 全绿，开 PR。

---

## 16. AI 与真人同一条动作管线（2026-11-01）

### 16.1 为什么改

旧实现里 AI 有一条专用通道 `AI_ACT`：驱动方只认这一个类型，而结算阶段（准备 /
开下一手）给的是 `READY` / `START_HAND`，于是：

- 全桌都是 AI（真人都进了观察席）时，没有任何人派发 `START_HAND`，牌局停摆，
  观察者也就等不到「本轮结束」再回桌；
- `EngineOptions` 里没有 `autoAi` 字段，`UniversalSession` / `ServerMatch` 传的
  `autoAi: false` 被静默丢弃，场景（`seats_6` 等房间变体）里 AI 仍然由内核一次性
  打完整条街——这就是「AI 动作太快、5 秒延迟不生效」的根因。

### 16.2 现在的规则

- `GameModule.isAutomated(state, actorId)` 声明谁由机器控制（德州 = `isAiSeat`）。
- AI 的 `legalActions` **直接给出它这一步要做的具体动作**（`choosePokerAction`），
  和真人完全同构；结算阶段给 `START_HAND`（全员就位时）或不给（等真人准备）。
- 驱动方（`UniversalSession.scheduleAiTurn` / `ServerMatch.startAiPump`）只做三件事：
  问「当前行动者是不是机器」→ 取它的第一个合法动作 → 按
  `presentation.aiActionDelayMs`（德州 5000ms）派发。AI 的每一次跟注、加注、开下一手
  都间隔 5 秒。
- 内核内联模式（`autoAi: true`，测试与夹具默认）走同一个 `choosePokerAction` +
  `applyHuman`，所以两种模式的状态序列一致；`EngineOptions.autoAi` 现在会透传到
  `setup` 与场景。

### 16.3 座位编制必须按座位号排列（2026-11-01 线上事故）

`globalVars.seats[i]` **必须**就是 `playerOrder[i]` 那一座的编制。开局洗座之后
`playerOrder` 是洗过的，而 `seats` 当时还是「编制顺序」，两者一错位：

- 补位 AI / 观察者回桌按座位号替换 `seats[seat]`，会把「谁是 AI」整体挪一位；
- `isAiSeat` 于是对真正的 AI 返回 false（或对真人返回 true）——驱动方以为该座位
  是真人，AI 管线当场停摆；观察者刚回桌就卡在「轮到我但没有任何动作」。
- 现在 `setupPoker` 直接写 `seats: dealt.result.map(entry => entry.assignment)`，
  与 `playerOrder` 同序；回归用例覆盖「破产补位 + 观察者回桌后 seats 仍逐座对齐」。
---

## 17. 结算界面（2026-11-01）

### 17.1 需求与落位

一手结束后牌桌要能「读完成绩」：每名玩家的**手牌**、**最大牌型**、**输赢筹码**，
以及两个按钮——**继续下一局** / **退出牌桌**。

这不是德州专属结构，所以按既有分层拆成三层，通用层不认识任何扑克词汇：

| 层 | 变的东西 | 文件 |
| --- | --- | --- |
| 内核契约 | 幕布可带 `ledger`（每人一行）与 `actions`（按钮能力）；`MomentPresentationState` 增 `seats` / `viewer` | `packages/kernel/src/module.ts` |
| 应用 | `UiMomentRow` / `UiMomentAction`；`buildMoment` 把投影里的座位、可见底牌、合法动作喂给游戏声明；`GamePresenter.performMomentAction(id)` | `packages/app/src/{contracts,inspect,session,netSession}.ts` |
| 游戏 | 账本内容与按钮含义（读哪几张牌、算净输赢、按钮派发什么） | `packages/games/src/poker/presentation.ts` |
| 视图 | 按中性 DTO 画幕布、账本、按钮；点击只上报按钮 id | `apps/web/src/ui/hud.ts`、`styles.css` |

### 17.2 账本只显示「投影允许看到」的牌

`seats[].cards` 来自 `projectedHandOf(state, playerId)`——投影里被掩码的牌不会出现，
只以 `hidden` 张数出现。于是：

- **摊牌**：全员存活手牌已经被规则层设成 PUBLIC，账本显示两家（或 N 家）的底牌 + 牌型；
- **弃牌结束**：底牌进暗弃区（`HIDDEN`），账本不显示任何手牌，只写「已弃牌 / 未亮牌」，
  赢家按规则可以选择明牌（`SHOW`）后才亮出来；
- 任何视角都拿不到别人的暗牌，结算画面因此不会成为泄漏通道（`poker: a settlement
  offers continue and leave, and never leaks a folded hand` 用例守着）。

输赢筹码是**净变化**：`赢得的边池总额 − 本手累计投入`（`hand.handBets`），不是余额。

### 17.3 两个按钮是「能力」，不是文案

- **继续下一局**：声明 `actionTypes: ['READY', 'START_HAND', 'FORCE_START']`，由
  presenter 取**当前合法**的第一个派发。全员已就位时是直接发牌；有人没准备时退回到
  「替自己准备」；最后才是「不等了」。没得按时按钮置灰并显示提示（通常会提示 20 秒
  冷却），绝不发一个会被内核拒掉的动作。
- **退出牌桌**：`leave: true`。离开牌桌不是内核动作，而是**宿主能力**——
  `UniversalSession` / `NetSession` 的 `setLeaveTableHandler()` 由装配根注入：
  联机回大厅（房主顺手关房），单机回入口页。规则层因此仍然不认识大厅与 URL。

幕布声明 `hold: true`：结算停留在玩家按下按钮为止，不像作祟过场那样自己淡出
（`durationMs` 只用于非 hold 的幕布）。同一个 `key` 也会重绘，因为按钮会随冷却从灰
变亮——旧实现只在 `key` 变化时重画，按钮会永远停在第一次渲染的样子。

---

## 18. 账号账本与全服排行（2026-11-01）

### 18.1 两个排行回答两个问题

牌桌右上角的面板分两个页签，**不合成一张表**：

| 页签 | 数据源 | 回答的问题 |
| --- | --- | --- |
| 本桌 | 引擎投影 `player.customProps.chips` | 这一桌现在谁筹码多 |
| 全服 | 服务端账本 `apps/server/src/pokerLedger.ts` | 这个账号一共还有多少、打得怎么样 |

单机 / P2P 模式没有账号体系：`GamePresenter.fetchAccountRanking` 不实现或返回
`undefined`，HUD 只留「本桌」页签，不会出现一个永远空着的全服页。

点「全服」里的任意一行弹出生涯战绩卡（手数 / 胜率 / 入池率 / 看翻牌 / 摊牌率 /
摊牌胜率 / 净输赢 / 最大底池 / 峰值筹码）。

### 18.2 筹码口径：余额 + 桌上

- 账号余额 `chips` = **还能带上桌的筹码**，新账号默认 5000。
- 上桌买入由余额扣款，扣到的金额就是桌上初始筹码（不被夹具的 1000 覆盖）。
- 下桌（房间关闭 / 对局释放）按桌上剩余退款，账本不会凭空生钱也不会丢钱。
- 全服排行 `chips = 余额 + 桌上筹码`，与「本桌」面板同一批数字。
- **幂等**：`takeSeat(userId, amount, roomId)` 按房间去重。服务端重启会重建对局，
  同一房间重复扣款会让玩家白掉一笔筹码，因此账本记录 `atTable[roomId]`，
  重入时沿用已押金额；`leaveSeat` 同样幂等，重复释放不会退两次钱。
  开局失败（座位数不符等）必须退款——`MatchManager.ensure` 抓异常后调用
  `refundBuyIns`，自检覆盖这条路径。

### 18.3 逐手事实由规则层写、生涯折叠由服务端做

规则层（`packages/games/src/poker/stats.ts`）只写清**这一手**：

```ts
hand.dealt             // 本手真的被发到牌的座位（观察者不在其中）
hand.preflopVoluntary  // 翻前自愿投钱（跟注/加注/全押，下盲注不算）
hand.sawFlop           // 翻牌发出时仍在牌局里
lastHand.players[]     // 每座位的 PokerHandFact
```

`lastHand.players` 随状态序列化与回放一起走，所以服务端读到的和回放算出来的完全一致。
服务端 `apps/server/src/pokerSettle.ts` 负责跨手那一半：

- 折叠成生涯累计 `PokerCareer`（纯函数 `foldPokerFact`）；
- 按「房间 + 手数」去重：`ServerMatch` 在重连 / 快照重放时会多次看到同一个
  `lastHand`，账本只认第一次，否则胜率与余额都会虚增；
- 内置 AI / 补位 AI 座位没有账号，自然被跳过。

口径（弹窗脚注同文）：

- **入池率 VPIP** = 翻前自愿投钱手数 / 参与手数（盲注不算）；
- **胜率** = 赢下至少一个底池的手数 / 参与手数；
- **摊牌胜率** = 摊牌中赢下的手数 / 摊牌手数。

### 18.4 每次买入都是初始位置的一部分

`GameSetupOptions.stacks`（→ `PokerConfig.stacks` → `setupPoker`）让每个座位带自己的
买入开局。它和 `seats` 一样属于**初始位置**：`exportLog` / `loadLog` / `replayState`
都带上 `stacks`，否则买入不同的两局会重放成同一手。`pokerScenario` 也透传它——
剧本曾经只转发 `autoAi`，换人买入会被静默退回 1000。

### 18.5 账本落盘

`DATA_DIR/poker-ledger.json`，与 `hub.json` 分开：账本每手都写，混进房间表会让
整份房间列表反复落盘；损坏时只重置战绩、不阻断开服（先备份为 `.corrupt.<ts>`）。
删除账号时 `removeAccount` 一并清账，同名新账号不会继承旧战绩。
