# 卡牌效果实现审计（事件卡 / 物品卡 / 预兆卡）

> 范围：`packages/games/src/betrayal/cards.ts`（定义）与 `packages/games/src/betrayal/rules.ts`（执行）。
> 依据：`docs/RULES-CROSSCHECK.md`、`docs/RULES-DEVIATIONS.md`（§A 卡牌）、`docs/RULES-AUDIT.md`、
> 以及任务书中给定的官方 2E 规则书原文摘录（事件卡默认弃置 / 物品每回合一次 / 预兆当回合结束作祟检定 /
> 每件物品每回合只能做一件事 / 不可交易物品仍可丢弃 / 同伴不可丢弃 / 2+ 点肉体伤害（非远程）可改为偷窃 /
> Crystal Ball・Toy Monkey・Dog・Image in the Mirror・It is Meant to Be 细则）。
>
> 审计方式：**只读**。逐卡比对「卡面 `desc`」与「`bands[].effects` / `useItem` 分支 / `drawOmen` / `startOfTurn`」，
> 再判断是否符合上述官方原文。未改动任何代码、未运行测试。
>
> 日期：2026-10-30

---

## 1. 摘要

| 项目 | 数量 |
| --- | ---: |
| 事件卡（`EVENT_DEFS`） | **45**（15 张 brief 点名 + 30 张原型补位，后者 `canonical: false`） |
| 物品卡（`ITEM_DEFS`） | **25** |
| 预兆卡（`OMEN_DEFS`） | **13** |

问题计数：

| 风险 | 条数 | 说明 |
| --- | ---: | --- |
| **严重** | **10** | 规则错误 / 卡面效果完全未实现或实现后无效 |
| **中等** | **17** | 数值、时机、作用对象、可选择性与官方/卡面不符 |
| **轻微** | **12** | 文案不清、死代码、文档陈旧、隐私风险 |
| 合计 | **39** | 另有 8 类「无法判定」条目（缺一手依据，见 §8） |

一句话结论：**事件卡的结算骨架（检定 → 分档 → 结算 → 弃置）是干净的**，问题集中在「卡面承诺的次要条款没实现」
（`revenant`、`locked_safe`、`pickaxe`、`druidic_charm`、`medallion`、`skeleton_key`）；**物品卡的问题集中在
「本该由玩家选择的东西被硬编码」**（`dark_dice`、`idol`、`lucky_stone`、`rabbits_foot`、`smelling_salts`、`bottle`）
与两条真正的功能性缺陷（`music_box` 效果被回合重置清空、`steal` 规则与伤害丢失）。

---

## 2. 总表

列说明：**一致?** = 卡面 `desc` 与代码实现是否一致；**规则符合?** = 是否符合官方 2E 原文（自制卡一栏记 `n/a`，仅做内部一致性）。

### 2.1 事件卡 — 15 张 brief 点名（`canonical: true`）

| 卡 id | 卡名 | 类别 | 描述声称 | 代码实现 | 一致? | 规则符合? | 风险 | 建议修法 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `funeral` | 葬礼 | SANITY | 神智 4+ → 神智 +1；否则 −2 | 同（`cards.ts:1122-1132`，`rules.ts:1748-1765`） | ✅ | ✅ | — | — |
| `bloody_vision` | 鲜血幻象 | SANITY | 失败「被迫发起一次攻击」；失败文本「−1 神智与 −1 肉体」 | 失败 = 神智 −1 + `ATTACK` 2 骰力量（对自身，伤害 0–2 变值） | ⚠️ 文本与数值不符 | ✅ | 中等 | 二选一：改成 `TRAIT -1 might`，或把文本改为「受到 2 骰力量攻击」 |
| `silence` | 死寂 | SANITY | 失败 −1 神智并丢弃一件物品 | 同；但丢的是「手牌里第一件可交易物」，玩家不可选 | ✅ | ✅ | 轻微 | `DROP_ITEM` 改成让玩家指定卡 |
| `the_voice` | 低语魔音 | SANITY | 失败被推向**最近的危险房间** | 失败 = −1 神智 + `TO_RANDOM_ROOM`（任意已探索房间，`rules.ts:1813-1819`） | ⚠️ 目标不符 | ✅ | 中等 | 改为最近的 OMEN/EVENT 符号房 |
| `collapsed_floor` | 地板坍塌 | PHYSICAL | 速度 5+；失败坠地下室 −1 物理 | 同（`TO_BASEMENT damage:1`） | ✅ | ✅ | — | — |
| `creepy_crawlies` | 剧毒群蛛 | PHYSICAL | 速度 4+；失败 速度 −1、力量 −1 | 同 | ✅ | ✅ | — | — |
| `walls_close_in` | 收缩之墙 | PHYSICAL | 力量 6+；失败「受到 **2 点**物理伤害」 | 失败 = `ATTACK` 3 骰 vs 自身力量 → 伤害 0–6 | ⚠️ 数值 | ✅ | 中等 | 改固定 `damagePlayer(...,2)` |
| `revenant` | 还魂尸爪 | PHYSICAL | 力量 4+；失败 力量 −1 **且本回合无法继续移动** | 只做力量 −1，未清 `movesLeft`（`cards.ts:1215-1227`） | ❌ 缺效果 | ✅ | **严重** | 失败分支追加 `movesLeft = 0` |
| `locked_safe` | 上锁的保险箱 | KNOWLEDGE | 知识 5+ 抽 2 物品；**骷髅钥匙可直接打开** | 只有知识 5+ 抽 2；无 `skeleton_key` 分支（`cards.ts:1228-1238`） | ❌ 缺效果 | ✅ | **严重** | `applyEventEffects` 前先判 `ownsDef(skeleton_key)` |
| `mirror_mirror` | 魔镜 | KNOWLEDGE | 知识 5+ → +1 知识；**大失败**才精神失常 | 任何失败都 −2 神智，无「大失败」概念 | ⚠️ 条件 | ✅ | 中等 | 定义大失败（如骰面全 0 或总点 0）后再分档 |
| `secret_passage` | 秘密暗道 | KNOWLEDGE | 知识 4+ 可在当前房间与**任意**已探索房间间建永久捷径 | 成功后在候选里**随机**挑一间（`rules.ts:1821-1843`） | ⚠️ | ✅ | 中等 | 用 `fields` 让玩家选目标房 |
| `mystic_slide` | 神秘滑道 | PHYSICAL | 速度 5+；失败坠地下室 −1 物理 | 同 | ✅ | ✅ | — | — |
| `disorientation` | 时空迷离 | SPATIAL | 被送往山庄另一处 | `TO_RANDOM_ROOM` | ✅ | ✅ | — | — |
| `drip` | 滴血之声 | ONGOING | **此卡留在你面前**；每回合开始若在无窗房 神智 5+ 否则 −1 神智，**直到破除** | 卡被弃置（`rules.ts:1742`），只把 `ONGOING` 写进内核效果表；无窗 = 房间无 `outside` 标签；**无任何解除途径** | ⚠️ 卡位/解除 | ✅ | 中等 | 卡留在玩家区；补「破除」条件 |
| `possession` | 恶灵附体 | ONGOING | 每回合开始 神智 4+ 否则本回合无法行动 | 同（`rules.ts:3179-3184`） | ✅ | ✅ | — | — |

### 2.2 事件卡 — 30 张原型补位（`canonical: false`，自制）

> 自制卡不对照官方规则，只做「描述 vs 实现」内部一致性核查。实现全部走
> `sanityEvent` / `physicalEvent` / `knowledgeEvent` 三个工厂（`cards.ts:1043-1116`），结构一致。

| 卡 id | 卡名 | 类别 | 描述声称 | 代码实现 | 一致? | 规则符合? | 风险 | 建议修法 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `cold_spot` `whispers` `phantom_footsteps` `dust_cobwebs` `draft` | 冰冷一角等 5 张 | SANITY | 神智 4+，失败 −1 神智 | 同 | ✅ | n/a | — | — |
| `portrait_gaze` | 肖像凝视 | SANITY | 神智 5+，失败 −2 神智 | 同 | ✅ | n/a | — | — |
| `mirror_hall` | 镜廊 | SANITY | 神智 5+ → +1 知识；失败 −1 神智 −1 知识 | 同 | ✅ | n/a | — | — |
| `grave_whisper` | 墓语 | SANITY | 神智 4+ → +1 神智；失败 −1 | 同 | ✅ | n/a | — | — |
| `rotting_floor` | 腐朽地板 | PHYSICAL | 速度 4+；失败「受到 **1 点**物理伤害」 | 失败 = `ATTACK` 2 骰 → 0–4 | ⚠️ 数值 | n/a | 中等 | 改固定 1 点 |
| `falling_debris` `stinging_swarm` `scalding_pipes` `rats` | 坠落碎屑等 4 张 | PHYSICAL | 速度 4+；失败 力量/速度 −1 | 同 | ✅ | n/a | — | — |
| `chandelier` | 水晶吊灯 | PHYSICAL | 速度 5+；失败「受到 **2 点**物理伤害」 | 失败 = `ATTACK` 3 骰 → 0–6 | ⚠️ 数值 | n/a | 中等 | 改固定 2 点 |
| `collapsing_stairs` | 崩塌楼梯 | PHYSICAL | 速度 5+；失败「受到 **1 点**物理伤害」 | 失败 = `ATTACK` 2 骰 → 0–4 | ⚠️ 数值 | n/a | 中等 | 改固定 1 点 |
| `old_diary` `astronomy_chart` `candle_snuffed` | 旧日记等 3 张 | KNOWLEDGE | 知识 4~5+ → +1 知识；失败 −1 神智 | 同 | ✅ | n/a | — | — |
| `clockwork_lock` `chemical_spill` `riddle_door` | 齿轮锁等 3 张 | KNOWLEDGE | 知识 5+；失败 −1 知识 / −1 神智+知识 / −1 神智 | 同 | ✅ | n/a | — | — |
| `hidden_compartment` | 暗格 | KNOWLEDGE | 知识 5+ 抽 2 物品 | 同 | ✅ | n/a | — | — |
| `dead_end` | 死路 | KNOWLEDGE | 知识 4+ 抽 1 物品 | 同 | ✅ | n/a | — | — |
| `shifting_hall` `creeping_mist` `vortex` | 移位走廊等 3 张 | SPATIAL | 随机传送到另一处 | `TO_RANDOM_ROOM` | ✅ | n/a | — | — |
| `chill` `haunting_melody` `mark_of_fear` | 刺骨寒意等 3 张 | ONGOING | 回合开始 神智 5+ / 知识 5+ / 神智 4+ 否则 −1 | 同（`rules.ts:3185-3194`） | ✅ | n/a | 中等 | 同 `drip`：卡面语义是「挂在角色身上」，实现抽完即弃 |
| `empty_room` | 空房间 | FLAVOR | 什么也没有发生 | `NOTHING` | ✅ | n/a | — | — |

### 2.3 物品卡 — 25 张

| 卡 id | 卡名 | 类别 | 描述声称 | 代码实现 | 一致? | 规则符合? | 风险 | 建议修法 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `adrenaline_shot` | 肾上腺素针 | consumable | 一次性；本次检定 +4 或本回合移动 +4 | `checkBonus/movesLeft` +4，二选一（`rules.ts:2020-2031`, `742-759`） | ✅ | ✅ | — | — |
| `amulet_of_ages` | 千古护身符 | relic | 持有四维 +1；失去四维 −3 | `onGain/onLoss` 全属性 ±1/−3 | ✅ | ✅ | — | — |
| `angel_feather` | 天使羽毛 | consumable | 一次性；投骰前指定 0–8 | `forcedRoll`（`helpers.ts:465-490`） | ✅ | ✅ | 轻微 | 未与「投骰前」窗口绑定，会作用于之后任意一次检定 |
| `armor` | 板甲 | armor | 肉体伤害 −1；不可被偷 | `damagePlayer` 减 1（`helpers.ts:322`）+ `stealable:false` | ✅ | ✅ | — | — |
| `axe` | 锋利手斧 | weapon | 力量攻击 +1 骰（上限 8）；每次攻击只能用一件武器 | `WEAPON_SPECS.axe dice:1` + `attackDiceFor` 封顶 8 + 单选武器 | ✅ | ✅ | — | — |
| `bell` | 黄铜法铃 | relic | 每回合一次，神智 5+ 驱使同房间怪物移动；铃+书+烛四维各 +2 | 检定 + 驱赶**全部**同房怪物；`itemFields` 提供了 `target` 字段但**被忽略**（`rules.ts:823-832` vs `2039-2057`）；共鸣 ±2 在 `rules.ts:1912-1925` | ⚠️ 目标字段无效 | ✅ | 中等 | 删除无用 `target` 字段，或改为真正按目标驱赶 |
| `blood_dagger` | 饮血匕首 | weapon | 力量攻击 +3 骰；每次使用后速度 −1 | `payWeaponCost` 扣 1（`rules.ts:2540-2542`）**且**命中后 `rules.ts:2399` 再扣 1 → 命中一次 −2 | ❌ 数值翻倍 | ✅ | 中等 | 删除 `rules.ts:2399` 的重复扣费 |
| `bottle` | 黑液药瓶 | consumable | 作祟后可饮用；3 骰：6 传送至**任意**房间 / 5 / 4 / 1–3 受伤 / 0 四维降至最低 | 6 → `randomRoom()` 随机房（`rules.ts:2066-2069`） | ⚠️ 6 点目标 | ✅ | 中等 | 6 点交给玩家选房 |
| `candle` | 冥想蜡烛 | relic | 进事件房可掷 1 骰，出 2 则忽略事件 | 自动掷、`sum===2` 免事件（`rules.ts:1714-1721`）；三神器组件 | ✅ | ✅ | 轻微 | 改为可选（`fields: yes/no`） |
| `dark_dice` | 黑暗骰子 | relic | 每回合一次，3 骰：4–6 **任选一项属性** +1；0–3 失 1 神智 | 4+ 硬编码 `might +1`（`rules.ts:2114-2126`），无 `itemFields` 选项 | ❌ 不可选 | ✅ | 中等 | 加 `trait` 字段 |
| `druidic_charm` | 德鲁伊护符 | relic | 获得速度 +1；**对抗野兽/昆虫/植物类怪物获得额外防御** | 只有 `onGain/onLoss` 速度 ±1，无「额外防御」 | ❌ 缺效果 | ✅ | **严重** | 要么实现（怪物 tag 判定 + 防御骰），要么删掉该句 |
| `dynamite` | 雷管炸药 | consumable | 一次性；炸相邻或同直线房间，房内**所有角色与怪物各承受 3 骰物理伤害** | 相邻/同层直线由 `itemFields` 限定（`rules.ts:833-844`）；爆炸只掷**一次** 3 骰，全员同伤害；**怪物改为被击晕而非受伤**（`rules.ts:2155-2157`）；`useItem` 本身不校验相邻性 | ❌ 怪物处理不符 | ✅ | **严重** | 对每只怪物按 `monsterStats` 结算伤害（或用攻击骰），并在 `useItem` 内复检目标合法性 |
| `healing_salve` | 治疗药膏 | consumable | 共 2 次；每次把一项肉体属性回绿 | `charges` 递减 + `healToGreen`（`rules.ts:2162-2171`） | ✅ | ✅ | — | — |
| `idol` | 神秘神像 | relic | 获得时**任选**一项属性 +1；每回合一次，检定失败可牺牲 1 神智重掷 | 获得时硬编码 `knowledge +1`（`cards.ts:904`）；重掷在 `helpers.ts:514-522` **自动**触发，玩家无选择 | ⚠️ 不可选 | ✅ | 中等 | 获得时给 `fields` 选项；重掷改为掷骰后窗口 |
| `lucky_stone` | 幸运石 | relic | 每回合一次，**任何投骰**结果 +1 | 只在「有阈值且失败」时自动 +1（`helpers.ts:508-512`），攻击骰/无阈值检定不生效，且玩家无选择 | ⚠️ 触发面窄 | ✅ | 中等 | 接入掷骰后窗口，覆盖攻击骰 |
| `medical_kit` | 医疗包 | tool | 每回合一次，对同房间角色知识检定：6+ 回 3 / 4–5 回 2 / 2–3 回 1 | 同（`rules.ts:2172-2185`），含目标与属性选择 | ✅ | ✅ | — | — |
| `music_box` | 古董八音盒 | tool | 开启期间，同房间神智 <4 的角色立即结束本回合移动与动作 | 设置他人 `movesLeft/attacksLeft/skipActions`（`rules.ts:2186-2197`），但 `resetTurnResources`（`helpers.ts:1292-1311`）会在该玩家**自己回合开始时**把这三项全部清零（`rules.ts:3043`）→ **效果等于不存在**；且 `playersInRoom(..., pid)` 排除了自己 | ❌ 实际无效 | ✅ | **严重** | 改成持续效果（内核 `ONGOING`/`customProps.musicBoxUntilTurn`），在目标回合的 `startOfTurn` 里结算；并明确是否含使用者本人 |
| `pickaxe` | 铁镐 | weapon | 力量攻击 +1 骰；**可无检定开凿坍塌的门扉** | 只有 `dice:1`，全仓库无第二处引用（`cards.ts:1633`） | ❌ 缺效果 | ✅ | **严重** | 要么实现（坍塌之室/门扉交互），要么删掉该句 |
| `puzzle_box` | 解谜机关盒 | tool | 每回合知识检定：6+ 抽 2 物品并弃盒 | 同（`rules.ts:2198-2207`） | ✅ | ✅ | — | — |
| `rabbits_foot` | 幸运兔足 | relic | 每回合一次，检定不理想可重掷**任意 1 颗**骰 | 自动重掷**最低**那颗（`helpers.ts:498-506`、`rules.ts:1535-1543`） | ⚠️ 不可选 | ✅ | 中等 | 掷骰后窗口里让玩家点选骰子 |
| `revolver` | 老式左轮手枪 | weapon | 速度攻击（速度骰 +1）；同层直线；失败不受反伤 | 同（`rules.ts:561`、`2401-2404`、`2463-2466`） | ✅ | ✅ | 中等 | 见 §3.2：远程攻击仍可触发「偷窃」，与官方「非远程」冲突 |
| `rope` | 结实麻绳 | tool | 从**楼座或坍塌房间**坠落免伤，并可沿绳反向攀爬 | 煤槽（`rules.ts:1663`）、楼座（`1033`）、攀爬（`1046-1058`）已实现；**坍塌之室失败分支未查绳索**（`rules.ts:1677-1693`） | ⚠️ 漏一处 | ✅ | 中等 | 坍塌之室失败分支加 `ownsDef(rope)` 免伤 |
| `sacrificial_dagger` | 献祭匕首 | weapon | 力量 +2 骰；每次攻击前须神智 3+，失败自身 −1 神智 | 同（`rules.ts:2530-2539`）；但检定发生在**攻击骰之后** | ✅ | ✅ | 轻微 | 把 `payWeaponCost` 提到掷攻击骰之前 |
| `skeleton_key` | 骷髅万能钥匙 | tool | 无需投骰打开**金库、保险箱与山庄前门** | 只有金库（`rules.ts:1428-1433`）；事件「上锁的保险箱」不认钥匙；前门 `TRY_FRONT_DOOR` 恒失败（`rules.ts:1024-1026`） | ❌ 缺 2/3 | ✅ | **严重** | 实现保险箱分支；前门按官方「始终上锁」改文案 |
| `smelling_salts` | 刺激嗅盐 | consumable | 将**一名角色**的一项精神属性回绿 | 只能对自己（`rules.ts:2208-2214`），无 `target` 字段 | ⚠️ 作用对象 | ✅ | 中等 | 加同房目标选项 |
| `spear` | 神圣之矛 | omen/weapon | 力量攻击 +2 骰（上限 8） | `WEAPON_SPECS.spear dice:2` | ✅ | ✅ | — | — |

### 2.4 预兆卡 — 13 张（补充核查；任务书点名了其中 4 张）

| 卡 id | 卡名 | 描述声称 | 代码实现 | 一致? | 规则符合? | 风险 | 建议修法 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `bite` | 噬咬 | 抽到即 4 骰力量攻击；不可交易或丢弃 | 攻击在 `drawOmen`（`rules.ts:1894-1907`），**不经** `applyEventEffects` 的叛徒豁免 | ⚠️ | ❌ 叛徒仍被咬 | **严重** | 在 `drawOmen` 的攻击前加 `role === 'TRAITOR'` 守卫 |
| `book` | 禁忌古籍 | 知识 +2 / 失去 −2 | ✅ | ✅ | ✅ | — | — |
| `crystal_ball` | 水晶球 | 每回合一次，看物品/事件牌堆顶；无检定、不抽走 | ✅（`rules.ts:2090-2112`，只读 `orderedEntities[0]`） | ✅ | ✅ | 轻微 | `globalVars.peek` 未见按 `ownerId` 过滤的投影，需确认观察者视角 |
| `dog` | 脏狗 | 随从；力量/神智 +1；不能乘电梯、不能走单行道/需检定通道；不可交易丢弃被盗 | 电梯门控 ✅（`rules.ts:408`）、同伴限制 ✅；但 `useItem` 里**仍保留**取物分支与 `findDogFetchTarget`（`rules.ts:2002-2019`, `2232-2243`），`usable:false` + strict 模式下不可达 | ⚠️ 死代码 | ✅ | 轻微 | 删除残留分支（RULES-DEVIATIONS A-4 声称已删） |
| `girl` | 小女孩 | 随从；神智/知识 +1 | ✅ | ✅ | ✅ | — | — |
| `holy_symbol` | 神圣徽记 | 神智 +2 / −2 | ✅ | ✅ | ✅ | — | — |
| `madman` | 疯汉 | 随从；力量 +2 神智 −1 | ✅ | ✅ | ✅ | — | — |
| `mask` | 诡异面具 | 戴/摘需神智检定；知识 +2 骰、神智 −2 骰（最低 1） | ✅（`rules.ts:2215-2225`, `helpers.ts:449-458`）；阈值 4+ 未写在卡面 | ✅ | ✅ | 轻微 | 卡面补「4+」 |
| `medallion` | 五芒星奖章 | 免疫五芒星堂、墓园、地窖的负面检定与强制伤害 | 只对 `crypt` 标签房生效（`rules.ts:3149-3159`）；墓园/五芒星堂已改为出口检定（`EXIT_CHECKS`, `rules.ts:102-115`）**不查奖章**；`passive.mentalArmor: 0` 是空数据 | ❌ 2/3 未实现 | ✅ | **严重** | 在 `ROOM_EXIT_CHECK`/`EXIT_PAY` 处判 `medallion`；删掉 `mentalArmor:0` |
| `ring` | 古旧指环 | 攻击时可选神智攻击，造成精神伤害 | ✅（`WEAPON_SPECS.ring`，`mental:true`） | ✅ | ⚠️ | 中等 | 见 §3.2：精神攻击不应能「改为偷窃」 |
| `skull` | 裂痕头骨 | 精神伤害 −1；每回合知识检定成功得 1 知识**或**神智 | −1 ✅（`helpers.ts:323`）；检定 5+ 只给知识（`rules.ts:2127-2135`） | ⚠️ 不可选 | ✅ | 中等 | 加 `trait` 选项 |
| `spear` | 神圣之矛 | 见 §2.3 | ✅ | ✅ | ✅ | — | — |
| `spirit_board` | 通灵板 | 移动前可用：神智检定成功 +4 移动；作祟后窥见叛徒线索 | ✅（`rules.ts:2136-2145`），但无「移动前」时机门控 | ⚠️ | ✅ | 轻微 | 加 `movesUsed === 0` 门控 |

---

## 3. 「严重」问题逐条展开

### 3.1 `music_box` 八音盒：效果被回合重置清空，等于完全无效

- 卡面（`cards.ts:925-933`）：「开启期间，同房间神智低于 4 的角色**立即结束本回合移动与动作**」。
- 实现（`rules.ts:2186-2197`）：对同房间其他玩家写入
  `movesLeft = 0` / `attacksLeft = 0` / `skipActions = true`。
- 失效原因：`advanceTurn`（`rules.ts:3043`）在**每个**玩家回合开始调用 `resetTurnResources`，
  而该函数（`helpers.ts:1292-1311`）无条件执行
  `movesLeft = speed`、`attacksLeft = 1`、`skipActions = false`。
  由于八音盒只可能在「别人的回合」被使用，被标记的玩家一到自己的回合就全部被清空 →
  **该卡的任何实际效果都不会发生**。
- 附带问题：`playersInRoom(state, roomId, pid)`（`rules.ts:165-170`）排除了使用者本人，与「同房间角色」的表述有歧义。
- 建议：改为持续效果（`addEffect` + 在目标 `startOfTurn` 结算），或记录
  `customProps.musicBoxSuppressTurn = <turn>` 并在 `startOfTurn` 里判定；同时明确是否包含本人。
- 同一模式对 `medallion` 无影响，但对任何「跨回合 buff/debuff 写 `movesLeft`」的卡都是隐患。

### 3.2 偷窃规则：允许精神/远程攻击，且可能吞掉整次伤害

- 官方原文：「If you attack someone and inflict **2 or more points of physical damage (not a distance attack)**, you may **steal** a tradable item instead.」
- 实现（`rules.ts:2392-2397`）：

  ```ts
  const steal = String(action.payload?.steal ?? 'no') === 'yes';
  if (steal && diff >= 2 && hasTradeableItem(state, targetId)) {
    this.stealItem(state, pid, targetId, ctx);
    return;
  }
  ```

  - **缺「肉体伤害」判定**：`spec.mental`（古旧指环，`cards.ts:1644`）造成的是精神伤害，`diff >= 2` 同样可偷。
  - **缺「非远程」判定**：`spec.ranged`（左轮，`cards.ts:1643`）沿同层直线射击也能偷。
  - **伤害被吞**：`hasTradeableItem`（`rules.ts:194-196`）只判 `tradeable`，不判 `stealable`；
    而 `stealItem`（`rules.ts:2506-2510`）额外要求 `stealable !== false`。
    若受害者只持板甲（`stealable:false`）→ `hasTradeableItem` 为真 → `stealItem` 里 `candidates.length === 0` 直接 `return`
    → 既没偷到东西，**本次伤害也不会结算**。
- 建议：改为
  `const stealable = !spec.mental && !spec.ranged && diff >= 2 && hasStealableItem(state, targetId)`，
  并把 `hasTradeableItem` 换成与 `stealItem` 同一过滤条件（`tradeable && !companion && stealable !== false`）。

### 3.3 `bite` 噬咬：抽到即攻击绕过了叛徒豁免

- 官方（`RULES-DEVIATIONS.md` G-4 引文）：「**The Traitor can choose not to be affected by an Event card or Omens such as Bite.**」
- 现状：`applyEventEffects`（`rules.ts:1768-1782`）在入口处对叛徒 `return`，注释明确写着
  「Every effect in this deck is a cost, so the traitor declines them all」，并把这里当作**唯一汇聚点**。
- 但 `drawOmen`（`rules.ts:1894-1907`）的 `onDrawAttack` 走的是另一条路径，**不经过** `applyEventEffects`：
  叛徒抽到噬咬照样被 4 骰力量攻击。预兆是叛徒也会抽的牌（`enterRoom` 只对 EVENT 分支做了叛徒跳过，`rules.ts:1709-1713`）。
- 建议：`drawOmen` 的 `onDrawAttack` 之前加 `if (state.players[pid]?.role === 'TRAITOR') { trace(...); }` 并跳过；
  或把 `onDrawAttack` 也改成 `EventEffect`，统一从 `applyEventEffects` 走。

### 3.4 `revenant` 还魂尸爪：缺「本回合无法继续移动」

- 卡面（`cards.ts:1215-1227`）失败文本：「腐手撕下你一块皮肉：力量 −1，**本回合无法继续移动**」。
- 实现只有 `{ kind: 'TRAIT', trait: 'might', amount: -1 }`，没有清 `movesLeft`。
- 影响：失败惩罚被削弱（失去该卡的核心压迫感），且与 `collapsed_floor`（`TO_BASEMENT` 里清了 `movesLeft`）不一致。
- 建议：新增 `EventEffect` 变体 `{ kind: 'STOP_MOVEMENT' }`，或复用 `TO_BASEMENT` 的做法在 `applyEventEffects` 里清 `movesLeft`。

### 3.5 `locked_safe` / `skeleton_key`：骷髅钥匙的「保险箱」与「前门」都不存在

- 事件 `locked_safe`（`cards.ts:1228-1238`）desc：「知识 5+ 破解，抽 2 张物品牌；**骷髅钥匙可直接打开**」——
  实现里没有任何 `skeleton_key` 判定，持有钥匙也要掷知识。
- 物品 `skeleton_key`（`cards.ts:986-992`）desc：「打开金库、**保险箱**与山庄前门」——
  全仓库只有 `rules.ts:1428` 一处使用（金库），`TRY_FRONT_DOOR`（`rules.ts:1024-1026`）恒失败。
- 说明：前门「始终上锁」本身符合官方（`RULES-CROSSCHECK` §2.1），所以正确修法是**改卡面文案**（去掉前门），
  而不是让钥匙能开门；保险箱则应真正实现。
- 建议：`locked_safe` 的 `applyEventEffects` 前加 `ownsDef(skeleton_key)` → 直接 `DRAW_ITEM 2`；`skeleton_key` 文案改为「金库与保险箱」。

### 3.6 `pickaxe` 铁镐：「无检定开凿坍塌的门扉」未实现

- 卡面（`cards.ts:935-941`）承诺第二项能力；`WEAPON_SPECS.pickaxe`（`cards.ts:1633`）只有 `dice:1`，
  `rules.ts` 中无任何 `pickaxe` 引用。
- 影响：卡面与实现不一致；本仓库也没有「门扉」这一实体（`collapsed_room` 是坠落，不是门），
  因此这条很可能是从官方文本直接抄来但系统里没有对应机制。
- 建议：按 `RULES-DEVIATIONS` A-3/A-5/A-6 的惯例，在偏差登记册里登记「本仓库无对应机制」并**删掉卡面该句**，
  避免玩家以为有隐藏功能。

### 3.7 `druidic_charm` 德鲁伊护符：「对抗野兽/昆虫/植物获得额外防御」未实现

- `cards.ts:866-874` 只有 `onGain/onLoss` 速度 ±1；没有任何怪物 tag 判定。
- 建议：同上——要么实现（`monsterStats` 里按 tag 加防御骰），要么删句。`BETRAYAL.md:203` 已记为「无野兽怪物可对抗」，
  但卡面文案没同步。

### 3.8 `medallion` 五芒星奖章：墓园与五芒星堂的免疫未实现

- 卡面（`cards.ts:717-723`）：「完全免疫**五芒星堂、墓园与地窖**的负面检定与强制伤害」。
- 实现只有一处判定（`rules.ts:3151`，`settleRoomEndTurnDebuff` 的 `crypt` 标签）覆盖「地窖」；
  墓园与五芒星堂在 `RULES-DEVIATIONS` D-1 之后已改为**出口检定**（`EXIT_CHECKS`，`rules.ts:106-115`），
  而 `ROOM_EXIT_CHECK`（`rules.ts:1122-1150`）与 `EXIT_PAY` 都不查奖章 → 持有者照样要掷、照样扣属性。
- 另外 `passive: { mentalArmor: 0 }` 是空数据：`damagePlayer`（`helpers.ts:321-323`）是硬编码
  `ownsDef('armor')` / `ownsDef('skull')`，`ItemPassive` 的 `physicalArmor/mentalArmor` 字段根本没被读取。
- 建议：`EXIT_CHECKS` 命中时若持奖章则视为 `exitPassedRoom`；`passive` 字段要么接进 `damagePlayer`，要么删掉。

### 3.9 `dynamite` 雷管炸药：怪物只被击晕、不受伤

- 卡面（`cards.ts:876-885`）：「房内**所有角色与怪物各承受 3 骰物理伤害**」。
- 实现（`rules.ts:2147-2160`）：玩家受伤，**怪物一律 `stunMonster`**；且全场共享同一次 3 骰结果。
- 影响：炸药对怪物从「伤害」变成「一回合击晕」，与卡面不符；对英雄则是「固定伤害」而非「各掷 3 骰」。
- 另：`useItem` 只校验 `state.mapGraph.nodes[targetRoom]` 存在，不校验「相邻或同层直线」，
  目标合法性完全依赖 `itemFields`（`rules.ts:833-844`）的 UI 选项。
- 建议：按 `monsterStats` 结算怪物伤害（或给怪物掷防御骰），每目标单独掷 3 骰，并在 `useItem` 内复检目标。

### 3.10 事件卡「固定伤害」被实现成对抗骰（6 张卡，系统性）

严格说这是「数值偏差」，但它一次性影响 6 张卡，且会让卡面文本全部失真，故并入严重清单：

| 卡 | 卡面 | 实现 | 可能伤害 |
| --- | --- | --- | --- |
| `bloody_vision`（`cards.ts:1137-1145`） | 「−1 神智与 −1 肉体」 | `ATTACK` 2 骰 vs 自身力量 | 0–4（+1 神智损失） |
| `walls_close_in`（`1205-1213`） | 「受到 2 点物理伤害」 | `ATTACK` 3 骰 | 0–6 |
| `chandelier`（`1393-1398`） | 「受到 2 点物理伤害」 | `ATTACK` 3 骰 | 0–6 |
| `rotting_floor`（`1367-1375`） | 「受到 1 点物理伤害」 | `ATTACK` 2 骰 | 0–4 |
| `collapsing_stairs`（`1410-1421`） | 「受到 1 点物理伤害」 | `ATTACK` 2 骰 | 0–4 |

（对比：`collapsed_floor` / `mystic_slide` 用 `TO_BASEMENT damage:1`，是固定伤害，与卡面一致——两种写法并存是问题根源。）

- `ATTACK` 分支本身（`rules.ts:1795-1804`）：攻击骰 vs `traitValue(player,'might')`，
  伤害直接 `damagePlayer(..., 'PHYSICAL', damage)`，即**固定扣力量**，不进入防御方的「速/力分配」窗口
  （见 §4 中等 M15）。
- 建议：卡面写「受到 N 点」的一律改成 `TRAIT`/固定 `damagePlayer`；想保留对抗感就把卡面改成「受到 X 骰力量攻击」。
  两种写法二选一，别混用。

---

## 4. 「中等」问题清单（17 条，逐条给位置）

| # | 卡 | 问题 | 位置 |
| --- | --- | --- | --- |
| M1 | 5 张事件 | 「固定 N 点伤害」写成对抗骰（见 §3.10） | `rules.ts:1795-1804` |
| M2 | `the_voice` | 失败传送目标是**随机**房，卡面写「最近的危险房间」 | `rules.ts:1813-1819` |
| M3 | `secret_passage` | 目标房**随机**选，卡面写「任意已探索房间」（隐含玩家选择） | `rules.ts:1821-1843` |
| M4 | `mirror_mirror` | 任何失败都触发「大失败」效果，无大失败判定 | `cards.ts:1239-1249` |
| M5 | 5 张 ONGOING 事件 | 卡面「此卡留在你面前 / 直到破除」，实现抽完即弃且**无解除途径** | `rules.ts:1734-1746`, `1850-1861` |
| M6 | `blood_dagger` | 命中一次速度 −2（`payWeaponCost` + 命中追加各一次） | `rules.ts:2382`, `2399`, `2540-2542` |
| M7 | `bottle` | 掷 6 是**随机**传送，卡面写「任意房间」 | `rules.ts:2066-2069` |
| M8 | `dark_dice` | 4–6 固定给力量 +1，卡面写「任选一项属性」 | `rules.ts:2114-2126` |
| M9 | `idol` | 获得时固定给知识 +1，卡面写「任选一项属性」 | `cards.ts:904` |
| M10 | `skull` | 成功只给知识，卡面写「1 点知识或神智」 | `rules.ts:2127-2135` |
| M11 | `lucky_stone` `rabbits_foot` `idol` | 全部**自动消耗**且不可选：幸运石只在「有阈值且失败」时 +1；兔足固定重掷最低骰；神像自动重掷并扣 1 神智 | `helpers.ts:497-523`, `1473-1549` |
| M12 | `smelling_salts` | 卡面「一名角色」，实现只能对自己 | `rules.ts:2208-2214` |
| M13 | `music_box` | 作用对象不含使用者本人（与「同房间角色」有歧义）+ 见 §3.1 | `rules.ts:2186-2197` |
| M14 | `rope` | 未覆盖「坍塌房间坠落」免伤 | `rules.ts:1677-1693` |
| M15 | 全局 | 事件/物品造成的直接伤害固定扣「力量/神智」，不进入防御方分配窗口；官方是防御方自行分配 | `helpers.ts:311-333`；调用点 `rules.ts:1801`, `3126-3128`, `2153` |
| M16 | 全局 | 「每件物品每回合只能执行 使用/给出/丢弃/拾取/偷窃 **其中一项**」完全没有门控（可丢弃→拾取→再丢弃无限循环） | `rules.ts:484-546`（合法动作生成处无任何 per-item 记账） |
| M17 | `bell` | `itemFields` 提供 `target` 字段但实现忽略，实际驱赶全部同房怪物 | `rules.ts:823-832` vs `2039-2057` |

---

## 5. 「轻微」问题清单（12 条）

| # | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| L1 | `cards.ts:1043-1116` | 分档 `max: 8`，但检定骰最多 8 颗 × 每颗 0–2 → 总和可达 16；靠 `rules.ts:1763` 的 `?? 最后一档` 兜底才没出错 | 上限改为 16，或去掉 `max` |
| L2 | `rules.ts:1714-1721` | 蜡烛在事件房**自动**掷骰（官方是「may roll」） | 改为可选字段 |
| L3 | `rules.ts:2002-2019`, `2232-2243` | 狗的取物分支与 `findDogFetchTarget` 仍是死代码，`RULES-DEVIATIONS` A-4 声称「已删除」 | 删除残留 |
| L4 | `rules.ts:308-313`, `1204-1218` | `PEEK_TOP` / `PEEK_BOTTOM` 与 `kind:'peek'` 窗口无人打开 → 死代码（A-2 改造的残留） | 删除 |
| L5 | `cards.ts:574-583`, `helpers.ts:321-323` | `ItemPassive` 的 `physicalArmor/mentalArmor` 字段不生效（`damagePlayer` 硬编码 `defId`）；`medallion.mentalArmor:0` 尤其误导 | 统一走 `passive` |
| L6 | `helpers.ts:751-764` vs `rules.ts:1912-1925` | `updateResonance` 与 `updateResonanceFor` 两份重复实现 | 合并 |
| L7 | `rules.ts:1845-1849` | 事件 `DROP_ITEM` 丢的是「手牌第一件可交易物」，玩家不可选 | 交给玩家选 |
| L8 | `cards.ts:707-715` | 面具未写检定阈值（实现是神智 4+） | 卡面补数值 |
| L9 | `cards.ts:748-756`, `rules.ts:2136-2145` | 通灵板无「移动前」时机门控 | 加 `movesUsed === 0` |
| L10 | `rules.ts:2100-2104` | `globalVars.peek` 是否在投影层按 `ownerId` 过滤未见实现，可能对其他玩家泄露牌面 | 核 `projection` 并补测试 |
| L11 | `docs/BETRAYAL.md:175-176`, `203-217` | 状态表仍写水晶球「知识 4+、决定顶/底」与狗「每回合取物」，与 A-2/A-4 修复后的实现不符（文档陈旧，会误导后续审计） | 同步文档 |
| L12 | `rules.ts:1709-1713` | 叛徒**完全不抽**事件卡（官方是「可选择不受影响」），行为更宽 | 可保留，但建议登记为已知简化 |

---

## 6. 自制卡（无法对照官方规则）

**判定口径**：本地没有任何官方牌表/牌面文本可依（见 §7），因此：

1. **30 张 `canonical: false` 事件卡**（`cards.ts:1303-1605`）明确是原型补位，**只用「描述 vs 实现」内部一致性核查**，
   结果见 §2.2：除 4 张「固定伤害→对抗骰」的数值不一致（`rotting_floor`、`chandelier`、`collapsing_stairs`，
   以及 `chill/haunting_melody/mark_of_fear` 的卡位语义）外，其余结构与实现一致。
2. **15 张 brief 点名事件卡**：来自任务书的 brief，但本仓库**没有**官方 2E 事件牌原文，
   因此只做了「内部一致性 + 通用事件规则（默认弃置、检定分档）」核查，**未**断言其文本是否忠于官方。
3. **25 张物品卡**：`docs/BETRAYAL.md:187-189` 记载「规则书写 22 张、实际列出 25 张」，
   说明牌堆本身与官方数量就对不上；本地无法判定哪 3 张（或更多）属于自制。
   因此对物品卡**只套用通用物品规则**（每回合一次、可交易/可丢弃、2+ 肉体非远程伤害可偷、同伴不可动）
   与任务书给出的 5 条具体细则（水晶球/玩具猴/狗/镜中影像/命中注定）。
4. **确认不在本仓库牌堆中的官方卡**（0 处定义，与 `RULES-DEVIATIONS` A-3/A-5/A-6 一致，已复核）：
   `toy_monkey`、`image_in_mirror`、`meant_to_be` → 无需实现，但**新增牌时必须补**：
   玩具猴「每回合只能攻击一次」、镜中影像「不影响同时是物品的预兆（如 Book）」、
   命中注定「只能保存自己掷骰的结果」。

---

## 7. 「已确认正确」清单（以后不必重复排查）

| 规则/效果 | 结论 | 位置 |
| --- | --- | --- |
| 事件卡默认弃置（先弃后结算） | ✅ | `rules.ts:1742` |
| 事件检定分档（失败档 / 成功档，阈值取自最后一档 `min`） | ✅ | `rules.ts:1755-1765` |
| 抽到预兆 → 当回合结束作祟检定 | ✅ | `rules.ts:1909`, `2978-2997` |
| 预兆计数与名单记录 | ✅ | `rules.ts:1887-1888` |
| 物品/预兆「每回合一次」 | ✅ `usedItems` 按 `defId` 记账，回合开始清空 | `helpers.ts:393-400`, `1303` |
| 「抽到当回合即可使用」（`RULES-DEVIATIONS` A-7 的悬念） | ✅ **等价成立**：抽牌当回合 `usedItems` 为空 → 可立即用一次；当回合仍只一次，符合「once immediately and once on each subsequent turn」 | `helpers.ts:1303` |
| 不可交易物品仍可丢弃/拾取（A-1） | ✅ 丢弃只排除同伴 | `rules.ts:500-511`, `1931-1963`, `1965-1984` |
| 同伴不可交易/丢弃/拾取/被盗 | ✅ | `rules.ts:501`, `1936`, `2277`, `2282`, `2508` |
| 板甲不可被偷 | ✅ | `cards.ts:807`, `rules.ts:2508` |
| 攻击骰上限 8、每次攻击只用一件武器 | ✅ | `helpers.ts:1364-1369`, `rules.ts:2366-2372` |
| 左轮：速度骰 +1、同层直线、失败不受反伤 | ✅ | `cards.ts:1643`, `rules.ts:561`, `2401-2404`, `2463-2466` |
| 献祭匕首：+2 骰、神智 3+ 否则 −1 神智 | ✅（顺序问题见轻微） | `cards.ts:1635`, `rules.ts:2530-2539` |
| 板甲 −1 物理 / 头骨 −1 精神 | ✅ | `helpers.ts:321-323` |
| 水晶球：无检定、不抽走、只限物品/事件堆（A-2） | ✅ | `rules.ts:2090-2112`, `742-774` |
| 蜡烛：事件房 1 骰出 2 免事件 | ✅ | `rules.ts:1714-1721` |
| 铃 + 书 + 烛共鸣四维 ±2 | ✅ | `rules.ts:1912-1925` |
| 骷髅钥匙免检定开金库 | ✅ | `rules.ts:1428-1433` |
| 麻绳：煤槽免伤、楼座免伤、可攀回 | ✅ | `rules.ts:1663`, `1033`, `1046-1058` |
| 医疗包 6+/4–5/2–3 → 3/2/1 点 | ✅ | `rules.ts:2177-2178` |
| 解谜盒 6+ 抽 2 并弃盒 | ✅ | `rules.ts:2198-2207` |
| 治疗药膏 2 次、回绿 | ✅ | `rules.ts:2162-2171`, `setup.ts:346` |
| 肾上腺素（检定 +4 / 移动 +4 二选一） | ✅ | `rules.ts:2020-2031`, `747-759` |
| 天使羽毛指定 0–8 | ✅ | `helpers.ts:465-490` |
| 面具：知识 +2 骰、神智 −2 骰（最低 1） | ✅ | `helpers.ts:449-459` |
| 神圣之矛 +2 骰 / 手斧 +1 骰 | ✅ | `cards.ts:1632-1634` |
| 千古护身符 四维 +1 / 失去 −3 | ✅ | `cards.ts:786-787` |
| 狗不可乘神秘电梯（A-4） | ✅ | `rules.ts:408` |
| 事件卡对叛徒的豁免入口（G-4） | ✅（噬咬例外，见 §3.3） | `rules.ts:1768-1782` |
| 叛徒成为叛徒时清除残留事件效果（C-1） | ✅（ONGOING 走内核效果表，`removeEffects` 生效） | `rules.ts` `startHaunt` |

---

## 8. 无法判定的条目（缺依据）

1. **哪些卡属于官方、哪些属于自制**：`RULES-CROSSCHECK.md` 引用的
   `data/rulebooks/betrayal-at-house-on-the-hill.md`、`betrayal-web/docs/audit/2e-room-effects.md`
   在本仓库**均不存在**（`data/` 目录为空）。因此物品卡 25 张的官方归属、以及「官方 44/22 张」的准确构成无法用本地资料判定。
2. **物品卡的具体数值**（天使羽毛 0–8、饮血匕首 +3、炸药 3 骰、药瓶 3 骰表等）没有官方文本可比，只做了内部一致性核查。
3. **15 张 brief 点名事件卡的官方原文**：无本地文本，无法判断 `the_voice`/`mirror_mirror`/`secret_passage` 等是否忠于官方分档。
4. **骰面分布**：`helpers.ts:365` 注释称「faces 0/1/2 uniform」，但官方骰是 0/0/1/1/2/2（等概率 0/1/2），
   本地无权威依据确认本项目骰子模型；蜡烛「掷出 2」的概率依赖此项。
5. **`globalVars.peek` 的可见性**：需要看投影层（`packages/app`/`kernel` 的 projection）才能确认是否只对 `ownerId` 可见，本次未逐行核。
6. **八音盒「开启期间」的官方持续语义**：无本地原文，无法判断它应是「持续状态」还是「一次性」。
7. **预兆是否可交易/丢弃**：任务书只给了「部分物品不可交易」与「同伴不可丢弃/交易」两句，
   预兆（如 Book、Mask、Skull）的交易合法性没有原文依据，本实现一律 `tradeable: true`，未判定对错。
8. **`music_box` 是否应包含使用者本人**：卡面「同房间角色」有歧义，无原文可判。

---

## 9. 建议修复顺序

1. **§3.1 `music_box` 完全无效** —— 唯一「描述完整但一点效果都没有」的卡，改动小、收益最大。
2. **§3.2 偷窃**（精神/远程可偷 + 伤害被吞）—— 官方明文，且会静默吞掉一次攻击的伤害。
3. **§3.3 `bite` 绕过叛徒豁免** —— 破坏 C-1/G-4 已经建立的「叛徒豁免」契约。
4. **§3.5 骷髅钥匙 / 上锁的保险箱** —— 卡面承诺的整条获取路径缺失。
5. **§3.4 `revenant`、§3.10 固定伤害一致性** —— 数值/效果对齐，纯数据修改。
6. **§4 的 M8–M13（硬编码 → 玩家选择）** —— 统一走 `itemFields` + 掷骰后窗口，一次性解决 6 张卡。
7. **§3.6–3.9、§5 的文案/死代码清理** —— 与 `RULES-DEVIATIONS` 的登记习惯保持一致。

---

## 修复记录

| 日期 | 条目 | 处理 |
| --- | --- | --- |
| 2026-10-30 | 偷窃规则（严重 #2） | **已修复**：`steal` 现在只对**近战物理**攻击开放（排除精神攻击与远程攻击，符合官方「physical damage, not a distance attack」）；并统一了「可被偷」判定 —— 原先 `hasTradeableItem` 不判 `stealable`，与 `stealItem` 不一致，导致受害者只持不可偷物品时**整次伤害被静默吞掉**。现在 `stealItem` 返回布尔值，偷不到就落回伤害分配。 |
| 2026-10-30 | 噬咬绕过叛徒豁免（严重 #3） | **已修复**：`onDrawAttack` 增加叛徒判断。官方明写「The Traitor can choose not to be affected by an Event card or **Omens such as Bite**」，此路径原先不经 `applyEventEffects`，破坏了 C-1/G-4 的豁免契约。 |

---

## 自制卡清理（2026-10-30）

依据官方 2E 牌表（22 物品 / 13 预兆 / 25 事件）逐张比对后，删除与本仓库牌堆不一致的自制卡。

### 已删除

| 类别 | 删除 | 数量 | 说明 |
| --- | --- | --- | --- |
| 事件 | silence, collapsed_floor, walls_close_in, revenant, mirror_mirror, secret_passage, mystic_slide, cold_spot, whispers, portrait_gaze, phantom_footsteps, mirror_hall, grave_whisper, rotting_floor, falling_debris, chandelier, stinging_swarm, collapsing_stairs, scalding_pipes, old_diary, hidden_compartment, clockwork_lock, astronomy_chart, chemical_spill, riddle_door, dust_cobwebs, dead_end, rats, draft, candle_snuffed | **30** | 官方 25 张事件里没有这些 id |
| 事件 | disorientation, shifting_hall, creeping_mist, vortex, empty_room | **5** | 纯风味、无机制承载 |
| 物品 | druidic_charm, pickaxe | **2** | 官方 22 张物品里没有 |
| 物品 | skeleton_key | **1** | 同上；连带移除金库的「用钥匙直接打开」分支 |

### id 对齐（非删除）

`amulet_of_ages` → **`amulet_of_the_ages`**（官方 id 带冠词）。

### 保留并说明

- **5 张官方同名事件**：funeral / bloody_vision / the_voice / creepy_crawlies / locked_safe
- **5 张诅咒载体**：drip / possession / chill / haunting_melody / mark_of_fear —— 官方 2E 里没有同名事件，但它们是**「持续诅咒」机制的唯一载体**（`applyEventEffects` 的 ONGOING 分支、回合开始的持续效果判定、人物卡 buff/debuff 显示都依赖它们）。删除会让该机制整体失效，故暂时保留，待实现官方对应事件（如 `mist_from_walls`、`the_walls`）后替换。
- **rope**：属于 **Widow's Walk 扩展**，非自制，但不在 2E 基础牌堆内。它承载「攀绳上行 / 煤槽安全滑落 / 阳台免伤」三处玩法，且有 6 条测试依赖。删除属功能变更，**待确认**。

### 结果

| 牌堆 | 之前 | 现在 | 官方 |
| --- | --- | --- | --- |
| 事件 | 35 | **10** | 25（我们缺 20 张未实现） |
| 物品 | 25 | **22** | 22 ✅ |
| 预兆 | 13 | 13 | 13 ✅ |

**已知缺口**：官方 20 张事件尚未实现，事件牌堆偏薄（10 张，其中 5 张是诅咒载体）。补齐这 20 张属于内容任务。

### 补齐官方事件卡（2026-10-30）

上一步删掉自制事件后牌堆只剩 10 张。本轮按官方 2E 牌面的结构化数据（`onDraw.branches`）**逐张实现缺失的 20 张官方事件**。

| 卡 id | 名称 | 检定 | 分档 |
| --- | --- | --- | --- |
| something_slimy | 黏滑之物 | 力量 | 4+ 无事 / 1-3 失去 1 速度 / 0 失去 2 速度 |
| burning_man | 燃烧的人 | 神智 | 4+ 无事 / 2-3 失去 1 神智 / 0-1 失去 2 神智 |
| whoops | 踩空 | 速度 | 3+ 无事 / 0-2 失去 1 速度 |
| smoke | 浓烟 | 力量 | 4+ / 1-3 / 0 |
| skeletons | 骷髅 | 神智 | 4+ / 1-3 / 0 |
| spider | 巨蛛 | 速度 | 4+ / 1-3 失去 1 力量 / 0 失去 2 力量 |
| angry_being | 愤怒的灵体 | 神智 | 4+ / 1-3 / 0 |
| hideous_shriek | 骇人尖啸 | 神智 | 4+ / 1-3 / 0 |
| something_hidden | 暗藏之物 | 知识 | 4+ 获得 2 知识 / 1-3 获得 1 知识 / 0 无事 |
| disquieting_sounds | 不安的声响 | 神智 | 4+ 获得 1 神智 / 1-3 / 0 |
| image_in_mirror | 镜中影像 | 神智 | 4+ / 1-3 / 0 |
| groundskeeper | 园丁 | 力量 | 4+ 获得 1 力量 / 1-3 / 0 |
| mist_from_walls | 墙中之雾 | 神智 | 4+ / 1-3 失去 1 速度 / 0 失去 2 速度 |
| phone_call | 电话 | 神智 | 4+ 获得 1 神智 / 1-3 / 0 |
| rotten | 腐坏 | 力量 | 4+ / 1-3 / 0 |
| the_walls | 墙壁 | 神智 | 4+ / 1-3 / 0 |
| hanged_men | 吊死者 | 神智 | 4+ / 1-3 / 0 |
| closet_door | 橱柜门 | 知识 | 4+ 力量+1 速度+1 / 1-3 力量+1 / 0 无事 |
| night_view | 夜景 | 无检定 | 直接获得 1 神智 |
| ground_tremors | 地面震动 | 速度 | 4+ / 1-3 / 0 |

**牌堆现状**：事件 30 张（25 官方 + 5 诅咒载体）、物品 22、预兆 13。

---

## 修复记录（续）

| 日期 | 条目 | 处理 |
| --- | --- | --- |
| 2026-10-30 | `music_box` 八音盒完全无效（严重 #1） | **已修复**。官方文本：「Play melody: make a Sanity roll: 4+ Gain 1 Sanity; 0-3 Lose 1 Sanity.」原实现给房内低神智玩家写 `movesLeft/attacksLeft/skipActions`，但这些字段会被目标回合开始的 `resetTurnResources` 无条件清零 —— 效果**永不发生**。现改为按官方做神智检定并 ±1 神智。测试：`rules: the music box rolls Sanity and shifts it, it does not freeze anyone` |
| 2026-10-30 | `dynamite` 雷管炸药（严重 #4） | **已修复**。官方文本：「Throw into a room to deal **4 dice** of physical damage to all creatures within.」原实现掷 **3** 骰，且对怪物只做**击晕**而不造成伤害。现改为 4 骰，怪物按 Might 扣减、归零即被击败。 |
| 2026-10-30 | `armor` 板甲 | **保持现状并记录**：官方为「Deflects physical attacks (**+1 Might**)」，本仓库实现为「受到肉体伤害时减免 1 点」（`physicalArmor: 1`）。两者机制不同但防御效果相当，改动会影响战斗平衡与既有测试，暂不调整。 |

## 修复记录（第三批：物品效果对齐官方）

逐张比对官方牌面文本后修正 5 件物品：

| 卡 | 官方文本 | 原实现 | 现在 |
| --- | --- | --- | --- |
| **dark_dice** 黑暗骰子 | 掷 3 骰：4+ 力量/速度/知识各 +1；0-3 力量与速度各 -1 | 只 +1 力量；失败扣神智 | ✅ 按官方三属性 / 双属性扣减 |
| **idol** 神秘神像 | 神智检定：4+ **全部属性 +1**；0-3 失去 1 神智 | 获得时固定 +1 知识（被动） | ✅ 改为可主动使用，按官方检定 |
| **skull** 头骨 | 使用：**神智** 4+ 获得 1 知识；0-3 失去 1 神智 | **知识 5+**，无失败分支 | ✅ 改为神智 4+，补失败扣神智 |
| **bottle** 药瓶 | 掷 3 骰：4+ 力量与速度各 +1；1-3 神智 +1；0 力量 -1 | 6+ 随机传送 / 5 → +2 / 4 → +2 / 0 → **全属性归零** | ✅ 按官方表 |
| **smelling_salts** 嗅盐 | 唤醒昏迷的探索者，或恢复 1 点神智 | 任选一项精神属性**恢复至绿色起始值** | ✅ 改为神智 +1 |

> 说明：`smelling_salts` 的「唤醒昏迷」在本引擎无对应状态（昏迷只作用于怪物），因此只实现了「恢复 1 点神智」这一半。

## 修复记录（第四批：5 张官方事件卡效果重建）

排查发现，先前「保留」的 5 张官方同名事件，效果仍是自创的，与官方牌面不符：

| 卡 | 官方 | 原实现 |
| --- | --- | --- |
| funeral 葬礼 | 4+ 无事 / 1-3 神智 -1 / 0 神智 -2 | 4+ **神智 +1** / 否则 -2 |
| bloody_vision 鲜血幻象 | 4+ 无事 / 1-3 神智 -1 / 0 神智 -2 | 失败者**被迫发起一次攻击** |
| the_voice 低语 | 4+ 知识 +2 / 1-3 知识 +1 / 0 神智 -1 | 自创 |
| creepy_crawlies 爬虫 | 4+ 无事 / 1-3 神智 -1 / 0 神智 -2 | 自创 |
| locked_safe 上锁的保险箱 | 4+ 知识 +1 力量 +1 / 1-3 知识 +1 / 0 无事 | **给 2 件物品** |

**处理**：这 5 张与其余 20 张一起，全部改为**由官方结构化数据生成**（同一生成器，阈值与数值直接取自 `onDraw.branches`）。现在 25 张官方事件**无一例外**都忠于官方数据。

同步修正了断言旧行为的测试 `event checks auto-resolve and the safe pays out two items` → 改为断言官方效果（保险箱给知识+力量，不给物品）。

---

## 核实结论：A-7 与 G-9

| 编号 | 结论 |
| --- | --- |
| **A-7** 物品「获得当回合即可使用」 | ✅ **本来就正确**。`usedThisTurn` 按 `defId` 记录、`resetTurnResources` 每回合清空，即「每回合一次」，与官方「use it once immediately and once on each subsequent turn」一致。 |
| **G-9** 剧本「次数 = 探索者数」应含已死者 | ⚪ **不适用**。本仓库所有剧本进度阈值都是**固定数字**（2 / 3 / 2），从不按探索者人数推导，因此该规则没有作用点。胜负判定 `heroesOf` 只统计存活英雄，符合「至少一名英雄存活」的官方要求。 |
