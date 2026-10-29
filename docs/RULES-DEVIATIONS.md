# 规则偏差登记册

> 目的：把「与官方 2E 规则不一致」的项**逐条登记**，统一修正时按此清单推进。
> 每条都标注**依据**、**位置**、**严重度**与**是否已核实**（避免把猜测当结论）。
>
> 依据来源见 `docs/RULES-CROSSCHECK.md`（一手 = 官方 2E 规则书文本）。
> 登记日期：2026-10-29

**状态说明**：`已核实` = 已读代码确认；`待核实` = 依据成立但尚未逐行确认实现。

---

## A. 卡牌规则（本轮新发现）

### A-1 不可交易的物品无法丢弃 ✅ **已修复**

- **官方原文**：「Some items can't be traded, but **may be dropped or picked up**.」
- **实现**：`rules.ts:446` `if (!companion && tradeable(entity))` 才推送 `DROP_ITEM` —— 不可交易物品既不能交易也不能丢弃。
- **影响**：卡手牌、无法腾出物品位。
- **修法（已实施）**：`DROP_ITEM` 的合法性判定与 `dropItem` 处理器都改为只排除同伴，交易仍用 `tradeable`。
- **测试**：`rules: a non-tradable item can still be dropped, a companion cannot`（不可交易的「咬伤」可丢；同伴「狗」不可丢）

### A-2 水晶球行为与官方不符 ✅ **已修复**

- **官方原文**：「The **Crystal Ball** can only be used to look through **undrawn Item and Event cards**.」
- **实现**：`rules.ts:1929` 先做**知识 4+ 检定**，通过后 `takeTopCard` 把牌**抽出牌堆**，再弹决策「留原处或移牌堆底」。
- **偏差**：①官方无检定；②官方是「查看未抽的牌」，不是「抽出并重新放置」；③牌堆顶牌离开牌堆会改变后续抽牌顺序。
- **修法（已实施）**：去掉知识检定与「留顶/移底」决策；只读取牌堆顶牌写入 `globalVars.peek` 供 UI 展示，**不抽走、不改变抽牌顺序**。卡面描述同步改为「无需检定，也不会把牌抽走」。
- **测试**：`rules: the crystal ball only looks, it does not take the card`（断言 PRNG 未消耗、牌堆顺序不变、peek 已记录）

### A-3 玩具猴的每回合一次攻击 —— ⚪ **卡牌不在本仓库牌堆中**

- **官方原文**：「The **Toy Monkey** can only attack once per turn.」
- **核实结论**：`toy_monkey` 在 `cards.ts` 中**不存在**（全仓库 0 处定义）。规则本身成立，但本仓库没有这张牌，无需实现；将来加入该卡时再补门控。

### A-4 狗的行为完全不符 ✅ **已修复**

- **官方原文**：「The **Dog** can't go through one-way passages, any passage like the Revolving Wall that requires a roll, or use the Mystic Elevator. His movement is not slowed by monsters.」
- **实现**：`rules.ts:1841` 把狗做成「自动捡回 6 步内的一堆物品」的取物技能；上述四条限制均无。
- **偏差**：能力本身是自创的，且缺失全部限制。
- **修法（已实施）**：
  - 删除自创的「每回合派狗取物」能力（`usable: false`，并移除其专属 `USE_ITEM` 分支）
  - 持有狗时**禁止使用神秘电梯**（官方明示）
  - 卡面描述改写为官方语义：随从、跟随主人、不能乘电梯 / 走单行道 / 走需检定通道
- **保留**：获得时力量与神智各 +1、失去时各 −1（这部分原本正确）
- **未实现**：「不被怪物减速」—— 狗的移动本就跟随主人，没有独立移动力，无对应机制
- **测试**：`rules: the dog is a companion, not a fetch skill, and it cannot ride the elevator`

### A-5 镜中影像（Image in the Mirror）—— ⚪ **卡牌不在本仓库牌堆中**

- **官方原文**：「The **Image in the Mirror** Omen card **does not affect omens that are also items**, such as the Book.」
- **核实结论**：`image_in_mirror` 在 `cards.ts` 中不存在，无需实现。

### A-6 「It is Meant to Be」—— ⚪ **卡牌不在本仓库牌堆中**

- **官方原文**：「The **It is Meant to Be** only allows you to save a result for a die roll **you** make.」
- **核实结论**：`meant_to_be` 在 `cards.ts` 中不存在，无需实现。

### A-7 物品「获得当回合即可使用」✅ **本来就正确**

- **官方原文**：「he may use it **once immediately and once on each subsequent turn**」。
- **实现**：`usedItems` 每回合重置，语义上应已覆盖；但「抽到当回合的立即使用」是否与「当回合的正常使用」区分，尚未逐行确认。
- **核实结论**：`usedThisTurn` 按 `defId` 记录、`resetTurnResources` 每回合清空 —— 即「每回合一次」，与官方「use it once immediately and once on each subsequent turn」一致，无需改动。

---

## B. 死亡 / 眩晕

### B-1 死亡后同伴的归属未转移 ✅ **已修复**

- **官方原文**：「If an explorer dies put an Item Token in the room **along with any Companion token**. Any other explorer that enters the room **gains custody of the companion** and may pick up the items.」
- **实现**：物品掉落已有测试覆盖；**同伴的转交**未见实现。
- **核实结果**：`dropAll` 已把同伴一并放进房间（规则前半句本来就对），缺的是「进入者取得归属」。
- **修法（已实施）**：`enterRoom` 进入时收取房间内**无主**的同伴；转交前清理所有 zone 的残留登记（同一实体被多个 zone 列出会让内核抛 `ENTITY_MULTI_ZONE`）。
- **测试**：`rules: a dead explorer's companion is claimed by whoever enters the room`

### B-2 昏迷怪物获胜应免伤 ✅ **已修复**

- **官方原文**：「**If a stunned monster is attacked and wins, it deals no damage.**」
- **实现**：有多处 `stunned` 判断（605 / 2263 / 2903 / 2923），但未见「获胜免伤」分支。
- **修法（已实施）**：`attackMonster` 的「怪物胜出」分支加入昏迷判断，伤害直接跳过。
- **说明**：攻击路径本已阻止重复攻击昏迷怪物，因此这是**防御性**补强，让规则在代码里显式成立。

---

## C. 叛徒 / 怪物特权

### C-1 成为叛徒时未清除自身残留事件效果 ✅ **已修复**

- **官方原文**：「**When you become a traitor, prior lingering bad effects from Event cards disappear.**」
- **实现**：`startHaunt`（`rules.ts:2497`）未调用任何清除；全文件无 `removeEffects` 调用。
- **影响**：叛徒仍受「滴血之声」等持续事件折磨。
- **修法（已实施）**：`startHaunt` 设定角色后立即 `removeEffects` 掉叛徒的 ONGOING 效果，并清空 legacy `customProps.effects`。
- **测试**：`rules: becoming the traitor clears lingering event effects`

### C-2 神秘电梯对叛徒/怪物应免掷 ✅ **已修复**

- **官方原文**：「**Traitors and Monsters can use the Elevator without rolling**, but only once per Traitor/Monster set of turns.」
- **实现**：`USE_ELEVATOR` 对所有角色一律掷 2 骰。
- **修法（已实施）**：叛徒走免掷分支，直接打开「任意楼层」目的地选择；`elevatorUsed` 仍保证每回合一次。
- **测试**：`rules: the traitor rides the elevator without rolling`（同时断言 PRNG 未被消耗）

### C-3 房间有害文本对叛徒/怪物的豁免不全 ✅ **已修复**

- **官方原文**：「Traitors and monsters can use any beneficial text on a room tile … while **ignoring any harmful text**（Collapsed Room、Gallery、Furnace Room、Crypt、Junk Room、回合结束类效果）。」
- **实现**：坍塌之室、熔炉房、地窖等有 `!traitor` 分支；**杂物间**等未见豁免。
- **核实结果**：坍塌之室、熔炉房、地窖、墓园、五芒星堂原本就在 `!traitor` 守卫内（已豁免）；**遗漏的是楼座** —— `JUMP_DOWN` 对叛徒照扣 1 点物理伤害。
- **修法（已实施）**：楼座的坠落伤害对叛徒免除，移动仍然生效（正是「用其利、避其害」）。
- **测试**：`rules: the traitor ignores harmful room text but keeps the movement`
- **说明**：本仓库没有 Chasm / Tower / Junk Room 特殊房，无需额外豁免。

---

## D. 房间规则（已在 CROSSCHECK 登记，此处汇总）

### D-1 失败后可留下重试 ✅ **已修复**

- **官方原文**：「**If an explorer fails his roll, he may choose to stay in the room and try again on his next turn instead of taking damage.**」（Attic / Graveyard / Junk Room / Pentagram Chamber，以及屏障房）
- **实现**：失败即结算伤害，无「留下重试」选项。
- **影响**：所有屏障类与四个「失败即伤害」房间的手感偏硬。
- **修法（已实施）**：
  - 新增出口检定表（阁楼 Speed3+/墓园 Sanity4+/杂物间 Might3+/五芒星堂 Knowledge4+）
  - 处于这些房间时**移动被门控**：只能先掷 `ROOM_EXIT_CHECK`（其余动作如剧本仪式照常可用）
  - 成功 → 记录 `exitPassedRoom`，本回合可自由离开
  - 失败 → 提供两个动作：`EXIT_STAY`（不受伤、本回合不再移动）或 `EXIT_PAY`（扣 1 点对应属性后离开）
  - **顺带修正**：墓园与五芒星堂原先被错误地做成「回合结束神智检定」，现已改为出口检定；地窖保留回合结束精神伤害
- **测试**：`rules: an exit room gates movement, and a failed roll offers stay or pay`

### D-2 屏障房的「每回合一次尝试」✅ **已修复（本仓库模型下）**

- **官方原文**：「You may attempt **once per turn** to make the trait roll to be able to cross the room.」「Crossing the barrier doesn't count as a move.」
- **实现**：部分房间是进入即检定，没有「每回合一次」与「过屏障不计步」。
- **已实施**：`exitPassedRoom` 每回合在 `resetTurnResources` 清空，因此每个房间每回合只能尝试一次，符合「once per turn」。
- **不适用部分**：本仓库没有把 Vault/Tower/Chasm/Catacombs 建模成「两侧」的屏障房，因此「过屏障不计步」没有对应概念，未实现。

### D-3 地下湖楼层 ✅ **已定案：地下室单层**

- **官方原文**：「If found on the **upper floor**, the Lake collapses; put it and the explorer next to any door in the Basement.」
- **冲突**：二手审计称 2E 已印为地下室单层。
- **决定（默认，可推翻）**：保持**地下室单层**。理由：二手审计称 2E 已按单层印正，且规则书那句是 1E 遗留表述，缺乏砖面证据支持多层。
- **已加断言锁定**：`rules: the underground lake is a basement-only tile` —— 将来若要改回多层，必须显式改测试，不会悄悄漂移。

---

## E. 内容完整性（非规则偏差，但会影响剧本）

### E-1 房间名单与官方 2E 不一致 ✅ **已对齐（部分待定）**

- **我们有、官方无**：会客厅、书房、育婴室、观星室、亚麻储藏室、寡妇步道（扩展开）、工坊、实验室。
- **官方有、我们缺**：Abandoned Room、Charred Room、Organ Room、Statuary Corridor、Creaky Hallway、Dusty Hallway、Game Room、Chasm、Patio、Stairs from Basement、Research Laboratory。
- **影响**：剧本（`haunts.ts`）按房名触发，缺房会导致对应剧本无法触发。
- **已实施**：5 处 id 重命名对齐官方；按官方门位/楼层/符号补齐 10 间缺失房间（房间 44 → 54）。
- **已删除 6 间无机制的自制房**：widow_walk、drawing_room、study、nursery、linen_closet、workshop（相关剧本触发房与狼人剧本已同步改用官方房间）。
- **保留 observatory**：承载「观星室升降梯」机制，删除会移除玩法 —— 有意保留并在此标注。
- **最终**：房间 48 间 = 官方 47 + observatory，官方房间**零缺失**。

---

## F. 已确认**正确**的项（无需修改，避免重复排查）

| 规则 | 结论 |
| --- | --- |
| 作祟检定：6 骰，总和 < 已抽预兆数则触发 | ✅ 与规则书一致 |
| 作祟前属性最低只能到最低值，不致死 | ✅ `minTraitIndex(haunt)` |
| 移动力 = 速度值，不掷骰 | ✅（曾误改，已回退） |
| 抽卡后本回合停止移动 | ✅ |
| 怪物掷骰决定移动力 | ✅ |
| 前门始终上锁 | ✅ |
| 四间收益房：按**玩家**各一次，怪物不能用 | ✅（二手审计此处有误） |
| 煤槽对叛徒与怪物同样生效 | ✅（已修） |
| 事件卡默认弃置，持续效果进内核效果表 | ✅ |
| 抽到预兆 → 当回合结束作祟检定 | ✅ |
| 物理伤害：差值即为伤害，防御方自行分配速/力 | ✅ |
| 精神伤害：分配知/智 | ✅ |
| 攻击造成 2+ 物理伤害（非远程）可改为偷窃 | ✅ |
| 远程攻击（左轮）沿门线直射；被防御方击败则无伤 | ✅ |
| 昏迷怪物不增加离开房间的移动消耗 | ✅ `hostilesInRoom` 已排除 stunned |
| 英雄胜利需至少一名英雄存活 | ✅ |

---

## G. 全量审查新增（Setup / Die Rolls / Attacks / Haunt）

逐节读完整本规则书后新发现的问题。

### G-1 同一检定每回合只能尝试一次 ✅ **已修复**

- **官方原文**：「**You cannot try to make the same roll more than once per turn.** Also, you cannot make more than one roll of a particular category specified in a scenario per turn.」
- **实现**：无任何「本回合已掷过同类检定」的门控（全仓库无 `rolledThisTurn` 类状态）。
- **影响**：玩家可以反复重掷同一个检定直到通过，直接破坏概率设计。
- **修法（已实施）**：`rollTraitCheck` 把 `reason` 写入 `customProps.rolledThisTurn`；新增 `hasRolledThisTurn()` 门控；`resetTurnResources` 每回合清空。宝库（唯一可重复进入的可选检定）已接门控。
- **测试**：`rules: the same check cannot be attempted twice in one turn`
- **遗留**：其它可选检定（如谜盒）若有独立入口，后续接入同一门控。

### G-2 叛徒离开有对手的房间不付额外移动力 ✅ **已修复**

- **官方原文**：「After the Haunt starts, for each opponent in a room with you, a **Hero, monster or Traitor** must use one extra space of movement to leave that room.」
- **实现**：`helpers.ts:1117` `if (!player || player.role === 'TRAITOR') return 1;` —— 叛徒恒定 1 步。
- **修法（已实施）**：移除 `movementCost` 的叛徒豁免；英雄与叛徒都按对手数加价。

### G-3 叛徒的「对手」统计错成自己人 ✅ **已修复**

- **实现**：`hostilesInRoom`（`helpers.ts:1108`）只在 `isHero` 时统计叛徒；对叛徒本人**只统计怪物**，而怪物是叛徒的盟友。
- **正确语义**：叛徒的对手是英雄；英雄的对手是叛徒 + 怪物。
- **修法（已实施）**：按角色分派 —— 叛徒统计房间内**英雄**，英雄统计叛徒 + 未昏迷怪物。测试同时覆盖「叛徒独处时无加价」。

### G-4 叛徒不能选择不受事件卡影响 ✅ **已修复**

- **官方原文**：「**The Traitor can choose not to be affected by an Event card or Omens such as Bite.**」
- **实现**：无叛徒对事件/预兆的豁免开关。
- **修法（已实施）**：`applyEventEffects` 是所有事件/预兆效果的**唯一汇聚点**，在入口处对叛徒直接返回并留痕。
- **测试覆盖**：结构性保证（单点守卫）+ 代码路径；未写独立断言，因为事件卡由随机种子决定、难以稳定命中「有害且只影响该玩家」的样本。登记为**已知测试缺口**。

### G-5 昏迷怪物被完全禁止行动 ✅ **已修复**

- **官方原文**：「a stunned monster **can't slow an explorer's movement**, but **a Traitor may still move the monster**. At the end of the monster's turn flip it back.」
- **实现**：`rules.ts:605` `if (custom.stunned) return [{ type: 'END_NPC_TURN', ... }]` —— 昏迷即只能结束回合，无法移动。
- **修法（已实施）**：昏迷只禁用 `ATTACK_HERO`，`MOVE_NPC` 照常提供；`endNpcTurn` 已有 `stunTurns` 翻回逻辑。
- **测试**：`rules: a stunned monster still moves but cannot attack`

### G-6 怪物攀爬煤槽/坍塌之室/楼座应免检定 ✅ **本来就正确**

- **官方原文**：「**Monsters, but not traitors**, are able to climb up the Coal Chute, Collapsed Room, and Gallery **without making a roll**.」
- **实现**：无怪物专用豁免。
- **核实结论**：`moveNpc` 只调用 `moveMonster`，**从不经过 `enterRoom`**，因此怪物本来就不会触发煤槽/坍塌之室/楼座的检定 —— 已符合规则，无需改动。

### G-7 怪物不能携带物品 ✅ **本来就正确**

- **官方原文**：「**Monsters can't explore new rooms or carry items** unless the Haunt says otherwise. If a monster allowed to carry items is stunned, he drops all items.」
- **实现**：无通用限制；仅木乃伊「抱女孩」的特例字段。
- **核实结论**：`getNpcLegalActions` 只提供 `MOVE_NPC` / `ATTACK_HERO` / `END_NPC_TURN`，**没有** `USE_ITEM` / `PICK_UP_ITEM` / `DROP_ITEM`；手牌区也按玩家 id 建（`zone_hand_<playerId>`），NPC 从未获得手牌。已符合规则。

### G-8 首位玩家应由生日决定 ⚪ **不实现（缺数据）**

- **官方原文**：「The explorer who has the **next birthday** starts first, with turns proceeding clockwise.」
- **实现**：固定 `playerOrder[0]`。
- **决定**：**不实现**。官方角色数据集（12 名角色）只含属性轨道与起始值，**没有生日字段**；生日印在实体角色卡上，本仓库无从获取。编造生日会让「谁先手」看起来有依据实则随机，不如保持固定顺序并如实说明。

### G-9 剧本「次数 = 探索者数」应含已死亡者 ⚪ **不适用**

- **官方原文**：「If a scenario states that something must be done a number of times equal to the number of explorers, this **includes those who get killed**.」
- **核实结论**：本仓库所有剧本进度阈值都是**固定数字**（2 / 3 / 2），从不按探索者人数推导，该规则无作用点。胜负判定只统计存活英雄，符合「至少一名英雄存活」。

---

## 修正优先级建议

1. **G-1**（同一检定每回合只能试一次）—— **最严重**：当前可反复重掷直到通过，直接破坏全部概率设计
2. **G-2 / G-3**（叛徒的移动加价与对手统计）—— 战斗节奏核心，且 G-3 把盟友算成对手
3. **A-1**（不可交易物品不能丢弃）—— 明确的可用性 bug，改动最小
4. **C-1**（叛徒不清残留事件）—— 影响剧本平衡
5. **D-1 / D-2**（失败可重试、屏障每回合一次）—— 官方明确，影响所有屏障房手感
6. **G-5 / G-6**（昏迷怪物仍可移动、怪物攀爬免检定）—— 怪物操作手感
7. **C-2 / C-3 / G-4**（叛徒与怪物特权：免掷电梯、房间有害文本、事件豁免）
8. **A-2 ~ A-6**（特殊卡牌语义）—— 需要逐张卡对照设计
9. **B-1 / B-2 / G-7 / G-8 / G-9**（死亡同伴、昏迷免伤、怪物携物、首位玩家、剧本计数）—— 先核实再改
10. **E-1**（房间名单）—— 独立内容任务，需与剧本一并规划
