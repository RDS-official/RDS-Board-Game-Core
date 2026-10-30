# 被动修正（Passive Modifiers）引擎层审查

> 结论先说：**这是一个引擎层缺口，不只是板甲一张卡的 bug。**
> 现有 `ItemDef.passive` 字段是**死数据** —— 全仓库没有任何代码读取它。
> 本文给出通用设计并说明为什么这样改能同时服务其它桌游。

---

## 1. 现状：一个从未被读取的字段

`packages/games/src/betrayal/cards.ts` 声明了：

```ts
physicalArmor?: number;
mentalArmor?: number;
ranged?: boolean;
```

并在 4 张卡上填了值：

| 卡 | 声明 | 实际效果 |
| --- | --- | --- |
| `armor` 板甲 | `passive: { physicalArmor: 1 }` | **无** |
| `medallion` 护符 | `passive: { mentalArmor: 1 }` | **无** |
| `ring` 指环 | `passive: { mentalArmor: 0 }` | **无**（且值为 0，即使被读也无效果） |
| `revolver` 左轮 | `passive: { ranged: true }` | **无**（真正生效的是 `WEAPON_SPECS.revolver.ranged`） |

验证方式：

```
git grep -rn "\.passive" -- packages/ apps/     # 零结果
git grep -rn "physicalArmor" -- packages/ apps/ # 仅 cards.ts 的定义与赋值
```

也就是说：**卡面写着「减免 1 点肉体伤害」，但代码里没有任何一行实现它。**
玩家捡到板甲，什么都不会发生。

### 为什么这不是「改一张卡」就能解决的

官方牌面里有大量**持续生效**的修正：

| 措辞 | 卡 | 语义 |
| --- | --- | --- |
| `+1 Might` | armor | 携带期间，力量检定骰 +1 |
| `+1 Sanity, +1 Speed` | angel_feather | 携带期间 |
| `+1 Speed, +1 Knowledge` | pickpocket_gloves | 携带期间 |
| `+1 to Might, Speed, Sanity, and Knowledge while you carry this` | amulet_of_the_ages | 携带期间，四维全 +1 |
| `+1 Sanity` | medallion / ring | 携带期间 |
| `+1 Speed on draw` | rabbits_foot | **一次性**，获得时 |

对照另一类措辞：

| 措辞 | 卡 | 语义 |
| --- | --- | --- |
| `Gain 2 Knowledge` | book | **一次性**，获得时 |
| `Gain +2 Sanity` | holy_symbol | **一次性**，获得时 |
| `Gain +1 Might and +1 Sanity` | dog | **一次性**，获得时 |

**结论：官方牌面本身区分两种修正 ——「携带期间持续」与「获得时一次性」。**
本仓库只有后者（`onGain`），前者完全没有承载机制。

---

## 2. 为什么不该放进内核

`packages/kernel` 是通用内核：它知道 `Player`、`Entity`、`Zone`、`EffectInstance`，
但**不知道什么叫「力量」**。把 `might/speed/sanity/knowledge` 写进内核，
等于把《山屋惊魂》的属性体系硬编码进通用框架 —— 这正是分层要避免的。

内核已有的正确抽象是 `EffectInstance`：

```ts
export interface EffectInstance {
  id: string;
  kind: string;          // 模块自定义，内核只做生命周期管理
  source: ActorId;
  target: string;
  tags?: string[];
  payload?: JsonRecord;  // 模块自定义
  ...
}
```

注释写得很清楚：**「Module-interpreted effects/modifiers; kernel owns only lifecycle.」**
所以修正的**语义**归模块，**生命周期与可见性**归内核。这个分工是对的，不用改。

---

## 3. 三种候选方案

### 方案 A：模块内派生属性（推荐）

模块声明修正，并在读取属性时聚合。

```ts
// cards.ts —— 声明
{ id: 'armor', modifiers: [{ trait: 'might', delta: 1 }] }

// helpers.ts —— 聚合
export function traitModifiers(state, playerId): Record<TraitKey, number>
export function effectiveTrait(state, playerId, trait): number   // 基础值 + 修正
```

- ✅ 内核零改动，分层不被破坏
- ✅ 纯函数、可序列化、可回放（修正由状态推导，不新增状态）
- ✅ 任何模块都能照抄这套模式
- ⚠️ 所有取值点必须改用 `effectiveTrait`，否则又变成死数据
- ⚠️ UI 需要同时显示「基础值」与「修正后」

### 方案 B：内核级 modifier 效果

把修正做成 `EffectInstance { kind: 'MODIFIER' }`，内核提供 `effectiveStat()`。

- ❌ 内核必须知道「属性」是什么 → 通用性被破坏
- ❌ 每个模块的属性名不同（力量 / 攻击力 / HP），内核无法统一
- ✅ 生命周期自动管理（过期、可见性）

### 方案 C：钩子注入

模块注册 `statModifiers` 钩子，引擎在计算时回调。

- ⚠️ 回调不可序列化，与「状态必须可 `JSON.stringify`」的硬约束冲突
- ✅ 表达力最强（可写任意逻辑）
- ❌ 对当前需求是过度设计

### 选型

**方案 A**。理由：需求是「线性加减的静态修正」，A 足够；A 保持内核纯粹、
状态可序列化、回放哈希不变；C 的灵活性用不上，却要付出可序列化的代价。

---

## 4. 落地设计

### 4.1 数据契约（模块层）

```ts
/** 携带期间持续生效的属性修正。与 onGain（获得时一次性）严格区分。 */
modifiers?: { trait: TraitKey; delta: number }[];
```

同时**删除**死字段 `passive`（`physicalArmor` / `mentalArmor` / `ranged`），
其中 `ranged` 的真实语义已由 `WEAPON_SPECS.ranged` 承担。

### 4.2 聚合函数（模块层，纯函数）

```ts
export function traitModifiers(state: GameState, playerId: PlayerId): Record<TraitKey, number>
```

来源优先级（相加，不互斥）：

1. **携带的物品/预兆**：手牌区 + 装备区里每张卡声明的 `modifiers`
2. **临时状态**：`customProps.traitModifiers`（供剧本/效果临时加减，回合结束清理）
3. **内核效果**：`state.effects` 中 `payload.traitDelta` 形式的持续修正

### 4.3 读取点

| 读取点 | 改法 |
| --- | --- |
| `rollTraitCheck` 的骰数 | `count += traitModifiers(...)[trait]` |
| 攻击骰、防御骰 | 同上 |
| UI 属性条 | 显示基础值 + `+1` 徽章（`UiPlayer.pips` 增加 `modifier` 字段） |

### 4.4 为什么这样能服务更多桌游

**可复用的不是「力量」这个名字，而是三条约束：**

1. **声明式修正**：卡牌/道具只声明 `{ 目标, 增减 }`，不写代码
2. **一次性 vs 持续** 的显式区分（`onGain` vs `modifiers`）——
   这是所有卡牌游戏都会遇到的语义分叉
3. **修正由状态推导，不进状态** —— 保证任何模块都能安全回放

任何模块只要把自己的属性名映射成 `modifiers` 的 `trait` 字段，
就能复用同一套聚合与 UI 展示逻辑。内核仍然不需要知道任何属性名。

### 4.5 展示层契约（app 层，跨游戏）

```ts
/** 一个属性在界面上的呈现：基础值 + 修正明细。 */
export interface UiStatModifier {
  label: string;      // '板甲'
  delta: number;      // +1
}
```

`UiPlayer.pips` 增加 `modifier?: number` 与 `modifierSources?: UiStatModifier[]`，
任何模块只要填这两个字段，UI 就能画出「3 +1 = 4」的效果。

---

## 5. 影响面与风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 回放哈希变化 | 修正由状态推导，**不新增状态字段**，哈希不变 | `test:matrix` 回放校验 |
| 数值平衡变化 | 板甲从「减伤 1」变成「力量 +1」，防御方式不同 | 记录在偏差登记册 |
| UI 不一致 | 属性条若只显示基础值，玩家看不到加成 | 同批实现 `modifier` 展示 |
| 遗漏读取点 | 未改用 `effectiveTrait` 的路径会看不到修正 | 用测试锁定（检定骰数包含修正） |

---

## 6. 实施顺序

1. 本设计文档（本文）
2. `modifiers` 契约 + `traitModifiers` / `effectiveTrait` 聚合
3. `rollTraitCheck` 与攻击/防御骰接入
4. 逐卡迁移：`armor`、`angel_feather`、`pickpocket_gloves`（新增）、`amulet_of_the_ages`、`medallion`、`ring`
5. UI 展示修正徽章
6. 删除死字段 `passive`

---

## 7. 与本仓库既有决策的关系

- `lucky_stone` / `rabbits_foot` 的重掷机制是**有意的房规偏离**（用户确认保留），
  不属于本设计的迁移范围。
- `rope` 属 Widow's Walk 扩展，非 2E 基础牌，保留并单独标注。

## 修复记录（第七批：UI 显示携带修正）

板甲改成「携带期间力量 +1」后，人物卡仍只显示基础值「力量 5」，玩家会疑惑为什么掷了 6 颗。

### 通用做法（不绑定《山屋惊魂》）

1. **内核新增纯钩子** `GameModule.statModifiers?: (state, actorId) => Record<string, number>`
   —— 任何桌游只要实现它，UI 就能显示「基础值 + 修正」，内核仍然不需要知道任何属性名。
2. **`UiPlayer.pips[].modifier`** —— 跨游戏的展示契约。
3. **背叛模块**用 `traitModifiers()` 实现该钩子。
4. **人物卡**在属性值旁显示 `+1` / `-1` 徽章。

浏览器实测：持板甲时显示「力 5 **+1**」，其余属性无徽章，`pageErrors: 0`。
