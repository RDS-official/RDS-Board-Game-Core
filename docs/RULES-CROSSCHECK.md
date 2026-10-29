# 规则交叉验证（2E）

> 目的：把「官方规则」与两份第三方实现逐条比对，标出一致、冲突与仍未解决项。
> 本次验证发现了 1 处第三方审计的错误、修正了 2 处实现偏差，并暴露 4 处待决冲突。
>
> 验证日期：2026-10-29

---

## 1. 来源分级

| 级别 | 来源 | 说明 |
| --- | --- | --- |
| **一手** | 官方 2E 规则书文本（`camden/rulebook-io-faqs` 转录）<br>`data/rulebooks/betrayal-at-house-on-the-hill.md` | 规则书原文，含 Special Rooms 段落。**冲突时以它为准** |
| 二手 A | `Kazuto4869/Betrayal-game-online`<br>`betrayal-web/docs/audit/2e-room-effects.md` | 逐房间审计，明确标注了「对照规则书与砖面图」；砖面细则（规则书未载）依赖它 |
| 二手 B | `BachNewton/Novelty-World`<br>`src/projects/betrayal/data/rooms.ts` | 房间数据结构（楼层/门位/符号），无规则文本 |
| 参考 | 用户口述、既有实现 | 仅作对照，不作依据 |

规则书原文只能拿到文本转录，砖面图案与骰子表**不在规则书内** —— 这正是冲突集中的地方。

---

## 2. 逐项比对

### 2.1 移动与探索

| 规则 | 一手来源 | 我们的实现 | 判定 |
| --- | --- | --- | --- |
| 「Explorers can move a number of spaces up to their current Speed」 | ✅ 明确 | `movesLeft = Speed` | ✅ 一致（曾误改为掷骰，已回退） |
| 「Movement ends once a card is drawn」 | ✅ 明确 | 抽卡后 `movesLeft = 0` | ✅ |
| 「Monsters roll a number of dice equal to their Speed」 | ✅ 明确 | `npc.movesLeft = roll.sum` | ✅ |
| 抽到楼层不符的砖 → 弃置重抽 | ✅ 明确 | `allowedFloors` 过滤 + 弃置 | ✅ |
| 「Doors are always open except for the front door, which is always locked」 | ✅ 明确 | `frontDoorLocked` + `TRY_FRONT_DOOR` | ✅ |

### 2.2 四间「一次性收益房」—— **第三方审计有错**

| 来源 | 说法 |
| --- | --- |
| **规则书（一手）** | 「**Each player** can receive the benefit from each of these rooms **just once per game**. Monsters cannot use these rooms.」 |
| 二手 A | 「Once per game … **tile not spent / mark spent**」，持久化标为 `tile` —— 即**整局全局一次** |
| 我们的实现 | `customProps.roomBuffs` 按**玩家**记录，每人每房一次 |

**判定：以规则书为准 —— 按玩家计，不是按砖块计。** 二手 A 在此处读错了，我们的实现正确，无需修改。

同时确认房间名单是 **Chapel / Gymnasium / Larder / Library**：

| 房间 | 收益 | 我们此前 | 处理 |
| --- | --- | --- | --- |
| 健身房 Gymnasium | +1 速度 | ✅ | — |
| 图书馆 Library | +1 知识 | ✅ | — |
| 礼拜堂 Chapel | +1 神智 | ✅ | — |
| **食品储藏间 Larder** | +1 力量 | ❌ 错挂在**厨房** | ✅ 已移到 Larder，厨房取消 |

> 「怪物不能用这些房间」：`settleRoomEndTurnDebuff` 只对玩家调用，NPC 走 `endNpcTurn`，✅ 一致。

### 2.3 特殊房间

| 房间 | 一手规则书 | 我们的实现 | 判定 |
| --- | --- | --- | --- |
| 煤槽 Coal Chute | 「counts as one move … never end your turn on the Chute. **The Chute affects Traitors and monsters.**」 | 原先整段包在 `if (!traitor)` 里，**叛徒免疫** | ✅ **已修正**：挪出 traitor 分支 |
| 坍塌之室 Collapsed Room | 「Explorers after the first may ignore … Falling doesn't count as a move. Traitors and Monsters can move through without damage.」 | 仅非叛徒触发速度检定 | ✅ 一致 |
| 地窖/熔炉房 Crypt, Furnace Room | 「Monsters ignore the special rules of these rooms.」 | 回合结束扣血，NPC 不经过该路径 | ✅ 一致 |
| 楼座 Gallery | 「only choose to fall to the Ballroom if it is in play」 | `JUMP_DOWN` 需 Ballroom 存在 | ✅ |
| 屏障房 Vault / Tower / Chasm / Catacombs | 「You may attempt **once per turn** … Crossing doesn't count as a move. Monsters ignore barriers.」 | 部分实现 | ⚠️ 待补 |
| 阁楼/墓园/杂物间/五芒星堂 | 「If an explorer **fails his roll, he may choose to stay in the room and try again on his next turn instead of taking damage.**」 | **没有「留下重试」选项**，失败即扣血 | ❌ **偏离** |
| 神秘电梯 Mystic Elevator | 「once a turn … If there isn't a connecting door on the appropriate floor, leave the Elevator where it is … **Traitors and Monsters can use the Elevator without rolling**, but only once per Traitor/Monster set of turns」 | 每回合一次 ✅；**叛徒/怪物仍需掷骰** | ⚠️ 部分偏离 |

### 2.4 仍未解决的冲突（需要砖面图或你拍板）

**① 神秘电梯的骰子→楼层表**

| 来源 | 表 |
| --- | --- |
| 规则书 | 只写「若该层没有可连的门就留在原地；掷出同层可换同层另一个门」，**表印在砖上** |
| 二手 A | 4=任意层 / 3=二楼 / 2=一楼 / 1=地下室 / 0=地下室+受伤 |
| 我们的实现 | ≥3=任意层 / 2=同层 / 1=不动 / 0=受伤（按你口述） |

三份互不相同。规则书不载，我无法判定；需要砖面图或你的确认。

**② 地下湖的楼层**

| 来源 | 说法 |
| --- | --- |
| 规则书 | 「**If found on the upper floor**, the Lake collapses; put it and the explorer next to any door in the Basement.」→ 意味着**能出现在楼上** |
| 二手 A | 「basement only」（称 2E 已印正） |

我们目前是地下室单层。若按规则书，应允许二楼 —— 需要确认这是否是 1E 遗留表述。

**③ 房间名单差异**（非规则冲突，是内容完整性）

我们有、官方 2E 没有的：会客厅、书房、育婴室、观星室、亚麻储藏室、寡妇步道（**扩展开**）、工坊、实验室。
官方 2E 有、我们缺的：Abandoned Room、Charred Room、Organ Room、Statuary Corridor、Creaky/Dusty Hallway、Game Room、Chasm、Patio、Stairs from Basement、Research Laboratory。

这会影响剧本（`haunt` 的触发房引用）与卡组构成，属于独立的内容任务，本次未动。

---

## 3. 本次落地的改动

1. **13 间房补上 `floors`**（抽牌时按 `floors ?? [floor]` 过滤，此前全部按单层处理）
2. **buff 房从厨房改为食品储藏间**（依规则书名单）
3. **煤槽对叛徒生效**（依规则书明示）
4. 新增断言：`floors` 必须包含本砖基础楼层、四间收益房的属性映射正确、厨房无收益

---

## 4. 复核方式

```bash
pnpm test        # 含 "room floor lists are well formed" 等 153 项
pnpm test:matrix # 随机对局 + 回放哈希一致
```

新增或修改房间规则时，请：先查一手规则书 → 再看砖面细则（二手 A）→ 在本文档登记判定。
