# 随机源审计（C-4）

> 范围：`catan`、`sanguosha`、`splendor`、`dune_mahjong` 四个模组。
> 审计基准：`origin/main` @ `c24a198`。
> 目的：找出运行期断言抓不到的随机源。断言只检查「调用了 `DeterministicPRNG` 却没推进 `prngState`」，抓不住绕过这个类的写法。

## 1. 扫什么

对四个模组的全部 `.ts` 做静态扫描，找三类东西：

1. `Math.random`、`Date.now`、`performance.now`、`new Date`、`crypto`；
2. 自写的哈希或取模（对照物是 poker 旧的 `noise()`，现已改名 `deriveNoise`）；
3. 用 `state.seed`、数组长度、循环计数拼出来的种子，且结果不写回 `prngState`。

扫描方式：逐文件正则加人工读上下文。取模本身非常常见（座位轮转、角度、坐标），只有「结果被当作随机数使用」才计入。

## 2. 结论

**四个模组里没有需要修改的随机源。** 不存在影响状态的旁路随机，也不存在需要改名 `deriveNoise` 的决策抖动。

| 模组 | `Math.random` 等旁路 | 自写哈希 / 取模 | 拼出且不写回的种子 | 判定 |
| --- | --- | --- | --- | --- |
| catan | 无 | 无 | 无 | 通过 |
| sanguosha | 无 | 无 | 无 | 通过 |
| splendor | 无 | 无 | 无 | 通过 |
| dune_mahjong | 无 | 无 | 无 | 通过（无随机） |

`packages/games/src` 里仅有的两处 `Math.random` 都在注释中（`splendor/setup.ts:20`、`splendor/rules.ts:26`），说明「这里不用它」。`scripts/check-rng.mjs` 只扫代码行，这两处不触发失败。

## 3. 调用点清单

每一个调用都读 `prngState`（setup 阶段读调用方传入的 seed），并把 `nextSeed` 写回。

### 3.1 catan

| 位置 | 调用 | 用途 | 写回 |
| --- | --- | --- | --- |
| `catan/setup.ts:89` | `shuffle` | 地形资源 | `prngSeed = nextSeed`，最终进 `prngState`（:183） |
| `catan/setup.ts:91` | `shuffle` | 数字筹码 | 同上 |
| `catan/setup.ts:127` | `shuffle` | 港口类型 | 同上 |
| `catan/setup.ts:228` | `shuffle` | 发展卡牌堆 | 同上 |
| `catan/rules.ts:404` | `rollDice` | 回合掷骰 | `s.prngState = roll.nextSeed`（:405） |
| `catan/rules.ts:754` | `nextInt` | 强盗抢资源 | `state.prngState = roll.nextSeed`（:755） |

`setup.ts:133` 的 `Math.floor((i * count) / 9)` 是把 9 个港口均匀摊到海岸边上，港口类型本身来自上面已洗过的 `shuffledPorts`。这是等距取位，不是随机。

### 3.2 sanguosha

| 位置 | 调用 | 用途 | 写回 |
| --- | --- | --- | --- |
| `sanguosha/setup.ts:61` | `shuffle` | 5 人以上局洗武将 | `nextSeed` 交回 `setupSanguosha`，写入 `prngState`（:186、:299） |
| `sanguosha/setup.ts:249` | `shuffle` | 洗牌堆 | `prngState = shuffled.nextSeed`（:250） |
| `sanguosha/helpers.ts:216` | `shuffle` | 弃牌堆洗回牌堆 | `prngState: nextSeed`（:234） |
| `sanguosha/helpers.ts:276` | `nextInt` | 从某家随机取一张牌 | 返回 `nextSeed`，调用方写回 |

`randomCardFromPlayer` 的两个调用方都写回了：`resolve.ts:198`（火攻展示）与 `resolve.ts:227`（过河拆桥 / 顺手牵羊取手牌）。判定抽牌 `drawJudgeCard` 取牌堆顶，不另取随机。

### 3.3 splendor

| 位置 | 调用 | 用途 | 写回 |
| --- | --- | --- | --- |
| `splendor/setup.ts:389` | `shuffle` | 各级牌堆洗牌 | 闭包内 `prngSeed = nextSeed >>> 0`（:390），最终进 `prngState`（:458） |

`rules.ts` 没有随机。分数由场面重算，不依赖随机。

### 3.4 dune_mahjong

全模组没有 `DeterministicPRNG` 调用，也没有旁路随机。`setup.ts:82` 把传入的 `seed` 原样写入 `prngState`，之后不再读取。战斗之轮的胜负由双方提交的 dial 决定，不是随机。

## 4. 现有守卫覆盖了什么、没覆盖什么

| 守卫 | 覆盖 | 不覆盖 |
| --- | --- | --- |
| `packages/harness/src/suites/charter.ts` 的 C-4 测试 | 运行期 `DeterministicPRNG.shuffle / nextInt / rollFaces` 必须在 10 行内写回 `prngState` | `setup.ts`、`scenarios.ts` 被显式跳过；`rollDice` 不在检查的方法列表里 |
| `scripts/check-rng.mjs` | `packages/games/src` 与 `packages/kernel/src` 代码行里的 `Math.random()` | 自写哈希、拼种子、注释之外的其它旁路 |

本次审计补上的正是这两处空白：setup 文件逐点核对过，`rollDice` 的唯一调用点（catan 掷骰）也核对过。

## 5. 不改代码的理由

文档要求把「确实影响状态」的旁路改成 `ctx.roll()`，把「只用于决策抖动」的改名 `deriveNoise`。四个模组里两类都是零，所以没有代码改动，相同种子的牌序不变，旧回放日志不受影响。

若后续要加守卫，候选是两条，本次不做：

- 把 `rollDice` 补进 C-4 测试的方法列表；
- 给 setup 文件加一条同类断言（setup 没有「前一个 `prngState`」，断言要按「`nextSeed` 最终写入初始状态」来写，不能照搬运行期的 10 行窗口）。
