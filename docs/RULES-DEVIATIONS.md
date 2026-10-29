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

### A-2 水晶球行为与官方不符 ★ 已核实

- **官方原文**：「The **Crystal Ball** can only be used to look through **undrawn Item and Event cards**.」
- **实现**：`rules.ts:1929` 先做**知识 4+ 检定**，通过后 `takeTopCard` 把牌**抽出牌堆**，再弹决策「留原处或移牌堆底」。
- **偏差**：①官方无检定；②官方是「查看未抽的牌」，不是「抽出并重新放置」；③牌堆顶牌离开牌堆会改变后续抽牌顺序。
- **修法**：改为纯查看（不消耗牌），去掉检定与放置决策。

### A-3 玩具猴的每回合一次攻击未实现 ★ 已核实

- **官方原文**：「The **Toy Monkey** can only attack once per turn.」
- **实现**：全仓库无 `toy_monkey` 逻辑（0 处命中）。
- **修法**：攻击合法性加门控。

### A-4 狗的行为完全不符 ★ 已核实

- **官方原文**：「The **Dog** can't go through one-way passages, any passage like the Revolving Wall that requires a roll, or use the Mystic Elevator. His movement is not slowed by monsters.」
- **实现**：`rules.ts:1841` 把狗做成「自动捡回 6 步内的一堆物品」的取物技能；上述四条限制均无。
- **偏差**：能力本身是自创的，且缺失全部限制。
- **修法**：改为官方语义（同伴，跟随主人，禁止单行道/需检定通道/电梯，不被怪物减速）。

### A-5 镜中影像（Image in the Mirror）未实现 ★ 已核实

- **官方原文**：「The **Image in the Mirror** Omen card **does not affect omens that are also items**, such as the Book.」
- **实现**：无对应逻辑。
- **修法**：复制/镜像类效果需排除「同时是物品的预兆」。

### A-6 「It is Meant to Be」未实现 ★ 已核实

- **官方原文**：「The **It is Meant to Be** only allows you to save a result for a die roll **you** make.」
- **实现**：无对应逻辑。
- **修法**：结果暂存仅限自己掷的骰。

### A-7 物品「获得当回合即可使用」待核实 ⚠️

- **官方原文**：「he may use it **once immediately and once on each subsequent turn**」。
- **实现**：`usedItems` 每回合重置，语义上应已覆盖；但「抽到当回合的立即使用」是否与「当回合的正常使用」区分，尚未逐行确认。
- **修法**：若未区分则无需改动；确认后登记结论。

---

## B. 死亡 / 眩晕

### B-1 死亡后同伴的归属未转移 ⚠️ 待核实

- **官方原文**：「If an explorer dies put an Item Token in the room **along with any Companion token**. Any other explorer that enters the room **gains custody of the companion** and may pick up the items.」
- **实现**：物品掉落已有测试覆盖；**同伴的转交**未见实现。
- **修法**：死亡时同伴留房间，其他探索者进入即取得归属。

### B-2 昏迷怪物获胜应免伤 ⚠️ 待核实

- **官方原文**：「**If a stunned monster is attacked and wins, it deals no damage.**」
- **实现**：有多处 `stunned` 判断（605 / 2263 / 2903 / 2923），但未见「获胜免伤」分支。
- **修法**：昏迷怪物攻击结算时若胜出，伤害置 0。

---

## C. 叛徒 / 怪物特权

### C-1 成为叛徒时未清除自身残留事件效果 ✅ **已修复**

- **官方原文**：「**When you become a traitor, prior lingering bad effects from Event cards disappear.**」
- **实现**：`startHaunt`（`rules.ts:2497`）未调用任何清除；全文件无 `removeEffects` 调用。
- **影响**：叛徒仍受「滴血之声」等持续事件折磨。
- **修法（已实施）**：`startHaunt` 设定角色后立即 `removeEffects` 掉叛徒的 ONGOING 效果，并清空 legacy `customProps.effects`。
- **测试**：`rules: becoming the traitor clears lingering event effects`

### C-2 神秘电梯对叛徒/怪物应免掷 ★ 已核实

- **官方原文**：「**Traitors and Monsters can use the Elevator without rolling**, but only once per Traitor/Monster set of turns.」
- **实现**：`USE_ELEVATOR` 对所有角色一律掷 2 骰。
- **修法**：叛徒与怪物走免掷分支（仍需每回合一次）。

### C-3 房间有害文本对叛徒/怪物的豁免不全 ⚠️ 待核实

- **官方原文**：「Traitors and monsters can use any beneficial text on a room tile … while **ignoring any harmful text**（Collapsed Room、Gallery、Furnace Room、Crypt、Junk Room、回合结束类效果）。」
- **实现**：坍塌之室、熔炉房、地窖等有 `!traitor` 分支；**杂物间**等未见豁免。
- **修法**：统一一张「有害房间」表，叛徒/怪物跳过。

---

## D. 房间规则（已在 CROSSCHECK 登记，此处汇总）

### D-1 失败后可留下重试，未实现 ★ 已核实

- **官方原文**：「**If an explorer fails his roll, he may choose to stay in the room and try again on his next turn instead of taking damage.**」（Attic / Graveyard / Junk Room / Pentagram Chamber，以及屏障房）
- **实现**：失败即结算伤害，无「留下重试」选项。
- **影响**：所有屏障类与四个「失败即伤害」房间的手感偏硬。
- **修法**：失败后弹出「留下重试 / 承受伤害」二选一。

### D-2 屏障房的「每回合一次尝试」未实现 ★ 已核实

- **官方原文**：「You may attempt **once per turn** to make the trait roll to be able to cross the room.」「Crossing the barrier doesn't count as a move.」
- **实现**：部分房间是进入即检定，没有「每回合一次」与「过屏障不计步」。
- **修法**：按屏障房统一处理。

### D-3 地下湖楼层存疑 ⚠️ 待定

- **官方原文**：「If found on the **upper floor**, the Lake collapses; put it and the explorer next to any door in the Basement.」
- **冲突**：二手审计称 2E 已印为地下室单层。
- **当前**：地下室单层。需砖面图定夺。

---

## E. 内容完整性（非规则偏差，但会影响剧本）

### E-1 房间名单与官方 2E 不一致

- **我们有、官方无**：会客厅、书房、育婴室、观星室、亚麻储藏室、寡妇步道（扩展开）、工坊、实验室。
- **官方有、我们缺**：Abandoned Room、Charred Room、Organ Room、Statuary Corridor、Creaky Hallway、Dusty Hallway、Game Room、Chasm、Patio、Stairs from Basement、Research Laboratory。
- **影响**：剧本（`haunts.ts`）按房名触发，缺房会导致对应剧本无法触发。

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

### G-4 叛徒不能选择不受事件卡影响 ★ 已核实

- **官方原文**：「**The Traitor can choose not to be affected by an Event card or Omens such as Bite.**」
- **实现**：无叛徒对事件/预兆的豁免开关。
- **修法**：叛徒遇事件效果时提供「忽略」选项。

### G-5 昏迷怪物被完全禁止行动 ✅ **已修复**

- **官方原文**：「a stunned monster **can't slow an explorer's movement**, but **a Traitor may still move the monster**. At the end of the monster's turn flip it back.」
- **实现**：`rules.ts:605` `if (custom.stunned) return [{ type: 'END_NPC_TURN', ... }]` —— 昏迷即只能结束回合，无法移动。
- **修法（已实施）**：昏迷只禁用 `ATTACK_HERO`，`MOVE_NPC` 照常提供；`endNpcTurn` 已有 `stunTurns` 翻回逻辑。
- **测试**：`rules: a stunned monster still moves but cannot attack`

### G-6 怪物攀爬煤槽/坍塌之室/楼座应免检定 ✅ **本来就正确**

- **官方原文**：「**Monsters, but not traitors**, are able to climb up the Coal Chute, Collapsed Room, and Gallery **without making a roll**.」
- **实现**：无怪物专用豁免。
- **核实结论**：`moveNpc` 只调用 `moveMonster`，**从不经过 `enterRoom`**，因此怪物本来就不会触发煤槽/坍塌之室/楼座的检定 —— 已符合规则，无需改动。

### G-7 怪物不能携带物品 ⚠️ 待核实

- **官方原文**：「**Monsters can't explore new rooms or carry items** unless the Haunt says otherwise. If a monster allowed to carry items is stunned, he drops all items.」
- **实现**：无通用限制；仅木乃伊「抱女孩」的特例字段。
- **修法**：确认 NPC 是否本就没有手牌区；若有则需显式禁止。

### G-8 首位玩家应由生日决定 ⚠️ 待核实

- **官方原文**：「The explorer who has the **next birthday** starts first, with turns proceeding clockwise.」
- **实现**：固定 `playerOrder[0]`。
- **修法**：按角色卡生日排序（属体验项，非平衡项）。

### G-9 剧本「次数 = 探索者数」应含已死亡者 ⚠️ 待核实

- **官方原文**：「If a scenario states that something must be done a number of times equal to the number of explorers, this **includes those who get killed**.」
- **修法**：核对各剧本计数是否用了「存活人数」。

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
