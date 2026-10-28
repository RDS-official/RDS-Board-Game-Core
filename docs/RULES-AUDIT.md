# 官方规则一致性审计

> 目的：把《Betrayal at House on the Hill》（第二版）的核心规则逐条对照实现，
> 标出「一致 / 偏离 / 未实现」，并为可判定的规则补断言测试。
>
> 规则依据：[官方规则书整理（Lehi-Innovation/boardgame-rules）](https://github.com/Lehi-Innovation/boardgame-rules/blob/484028e5354456ad347f750e57d8470f05a67bc4/rules/betrayal-at-house-on-the-hill.md)
> 审计日期：2026-10-28。**范围**：核心回合循环规则；44 张房间与 50 个剧本的具体内容不在本次范围内。

---

## 1. 结论摘要

| 状态 | 数量 | 说明 |
| --- | --- | --- |
| ✅ 一致 | 9 | 有断言锁定 |
| ⚠️ 曾偏离，已修正 | 1 | 移动力曾按口述误改为掷骰（见 §3） |
| ⚠️ 一致但无断言 | 3 | 建议后续补测 |
| ❌ 未实现 | 0 | 大门上锁已实现 |
| ❌ 偏离 | 0 | 神秘电梯已按 2 骰规则修正 |

---

## 2. 逐条对照

### 2.1 回合结构

| 官方规则 | 实现 | 状态 |
| --- | --- | --- |
| 回合内可任意顺序：移动、发现房间、使用物品/预兆（各每回合一次）、按需掷骰、作祟后攻击一次 | `getPlayerLegalActions` 按阶段放行；`usedItems`/`attacksLeft` 限制次数 | ✅ |
| 发现房间抽到卡后**本回合必须停止移动** | 抽卡处 `movesLeft = 0`（rules.ts 776/1343/1361/1453/1462） | ✅ |

### 2.2 移动

| 官方规则 | 实现 | 状态 |
| --- | --- | --- |
| **「Move up to a number of spaces equal to your current Speed」——不掷骰** | `resetTurnResources`：`movesLeft = traitValue(player,'speed')` | ✅ **曾偏离，已修正** |
| 冰冻房间移动力减半（模块效果，非官方规则） | `frozen ? Math.max(1, floor(speed/2)) : speed` | 模块扩展，已标注 |

### 2.3 作祟检定

| 官方规则 | 实现 | 状态 |
| --- | --- | --- |
| 抽到预兆的回合结束时，**掷 6 颗骰**；总和 **小于** 全场已抽预兆数则作祟开始 | `hauntRoll`：`rollZeroDice(prngState, 6)`，`sum < omens` 触发 | ✅ |
| 作祟检定**不涉及任何属性** | 无 trait 参数 | ✅ |

> 注：用户曾反馈「应由玩家选属性」，与官方规则不符，未采纳（见对话记录）。

### 2.4 属性与死亡

| 官方规则 | 实现 | 状态 |
| --- | --- | --- |
| 属性不可超过角色卡印刷上限 | `applyTraitSteps`：`upper = track.length - 1`（force 或负向时） | ✅ |
| 任一属性到达骷髅符号即死亡 | `damagePlayer`：任一 `traitIndex === 0` 且已作祟 → 死亡 | ✅ |
| 死亡后物品掉落在所在房间 | `killPlayer` 掉落 + `itemSlotId` 放置 | ✅ |

### 2.5 攻击与伤害

| 官方规则 | 实现 | 状态 |
| --- | --- | --- |
| 作祟后每回合可攻击一次 | `attacksLeft` 门控（rules.ts 437-438） | ✅ |
| 攻击需与目标同房间 | 合法性检查 | ✅ |
| 攻守双方各掷力量骰，差值即伤害 | `attackPlayer` 掷双方 Might | ✅ |
| **物理伤害由防御方选择减速度或力量**；精神伤害选知识或神智 | 伤害分配走 `decision` 窗口（`combat opens a damage-allocation decision`） | ✅ |
| 护甲先减伤 | `armor reduces physical damage before allocation` | ✅ |

### 2.6 特殊房间

| 官方规则 | 实现 | 状态 |
| --- | --- | --- |
| 大门始终锁着（除剧本另说） | `globalVars.frontDoorLocked` + 门厅 `frontDoor: 'N'`：锁定时该方向不给 `EXPLORE_DOOR`，改为 `TRY_FRONT_DOOR`（提示前门纹丝不动）；作祟后可由剧本解锁 | ✅ **已实现** |
| 大楼梯直通二楼平台 | `grand_staircase` special=STAIRS + 连接 | ✅ |
| 地下室楼梯经暗门通往门厅 | 有对应实现（`STAIRS` 标签 + 规则） | ✅ 无断言 |
| 坍塌之室：**仅发现者**需掷速度 | `rollTraitCheck(..., 'speed', threshold 5)` 仅对进入者 | ✅ |
| 煤槽：滑落算 1 步；**回合不可停在煤槽** | `enterRoom` 中 `COAL_CHUTE`：进入即受伤（有绳免伤）并**立刻转移到地下平台**，因此结构上不可能停在煤槽 | ✅ 无断言 |
| 神秘电梯：**单门**；进入时**掷 2 骰**（≥3 任意层 / =2 同层 / =1 不动 / =0 受 1 点物理伤害） | 门已改为单门；`USE_ELEVATOR` 先掷 2 骰再按上述四档结算 | ✅ **已修正** |

### 2.7 物品

| 官方规则 | 实现 | 状态 |
| --- | --- | --- |
| 每件物品每回合限用一次 | `usedThisTurn` / `markUsed` | ✅ |
| 可与同房间探索者交换（需双方同意） | `PROPOSE_ITEM_TRADE` / `ACCEPT_TRADE` | ✅ |
| 可丢下、可拾取 | `drop` / `PICK_UP_ITEM` / 房间物品槽 | ✅ |

---

## 3. 本次审计修正的偏离

**移动力被误改为掷骰**（我在上一轮按用户口述实现，与官方规则冲突）：

```diff
- const speedRoll = rollTraitCheck(state, playerId, 'speed', { reason: '移动力' });
- player.customProps.movesLeft = Math.max(1, speedRoll.total);
+ player.customProps.movesLeft = frozen ? Math.max(1, Math.floor(speed / 2)) : speed;
```

同时移除了 `scenarios.ts` 中 6 处 `movesLeft = 4` 硬编码 —— 那些覆盖会盖掉速度值，属于夹具便利而非规则。

---

## 4. 新增断言测试（`packages/harness/src/suite.ts`）

| 测试 | 锁定的规则 |
| --- | --- |
| `rules: movement equals the Speed value and rolls no dice` | 移动力 = 速度值，且 `resetTurnResources` **不消耗 PRNG** |
| `rules: a trait can be raised but never above the printed maximum` | 属性增益钳制在轨道顶端 |
| `rules: a trait that reaches the skull kills the explorer` | 属性归零即死亡 |
| `rules: the haunt roll is six dice compared against the omen count` | 6 颗骰；预兆 0 必不触發、预兆 13 必触發 |
| `rules: an attack is available once per turn and only after the haunt` | 攻击次数门控 |

`pnpm test` 由 141 增至 **146**。

---

## 5. 尚未覆盖 / 建议后续

1. **大门上锁**：官方规则要求大门在作祟前始终锁着。当前没有门锁状态，任何剧本都能从前门离开。需要产品决策是否实现。
2. ~~神秘电梯的 2 骰~~ **已修正**（见 §7）。
3. **大楼梯 / 地下室暗门 / 煤槽**：实现存在但无断言，建议补三条测试。
4. **房间与剧本内容**（44 房间文本效果、50 个剧本目标）未审计：这些是模块内容而非核心规则，需要单独的内容审计。

---

## 6. 如何复核

```bash
pnpm test          # 含 §4 的 5 条规则断言
pnpm test:matrix   # 随机对局 + 回放哈希一致性
```

新增规则时请同时：在本文档登记、在 `suite.ts` 补断言、并确认断言在旧实现下会失败（非空转）。

---

## 7. 测试期发现的三个实现 bug（2026-10-28）

### 7.1 「滴血之声」忽略了「无窗房间」条件

卡面原文：「每当你的回合开始**且处于无窗房间**，须通过神智 5+ 否则失去 1 点神智」。

实现是**无条件每回合检定**，于是在花园（`outside` 标签，有窗）也照常触发。已按 `tags.includes('outside')` 豁免室外房间。

### 7.2 神秘电梯

- **门数**：原为 `['E','W']` 两个出口，改为单门 `['E']`。
- **移动**：先掷 2 骰再决定行为 —— ≥3 任意楼层、=2 仅同层、=1 不动、=0 受 1 点物理伤害，结果写入 `globalVars.lastElevatorRoll`。
- **电梯砖跟随移动**：成功后电梯**房间砖**搬到目标房间的空门口格（原格清空），并重新连边；玩家进入电梯砖。移动前会清理旧边与邻居邻接表，避免 `TOPOLOGY_INVALID`。

### 7.3 高亮无法恢复（表现层）

`Scene.applyHighlights` 直接修改材质的 `emissive`。**房间网格共享材质实例**，所以高亮一个房间会点亮所有共用该材质的房间；还原时又按 mesh 逐个把「原值」写回共享材质，互相覆盖，最终整座宅子停在点亮状态。

改为**逐 mesh 克隆材质**：高亮时记录原材质引用并换成克隆，还原时把引用换回去并 dispose 克隆。共享材质因此不会被污染。

实测：高亮单间 → 只有该房间发光；清除后 → 全部归零。

---

## 8. 房规：回合结束房间加成（非官方，按需求实现）

| 房间 | 加成 | 规则 |
| --- | --- | --- |
| 健身房 | 永久 +1 速度 | 回合结束时停留在此，每名探索者**每局一次** |
| 图书馆 | 永久 +1 知识 | 同上 |
| 礼拜堂 | 永久 +1 神智 | 同上 |
| 厨房 | 永久 +1 力量 | 同上 |

实现：`RoomDef.endTurnBuff` + `settleRoomEndTurnDebuff`；领取记录写在
`customProps.roomBuffs`（房间 id 列表），重复停留不会二次生效。加成走
`applyTraitSteps(..., { force: true })`，因此可以超过绿色起始值但不会超过轨道上限。

> **这不是官方规则。** 官方规则书里没有「回合结束留在某房间永久加属性」的条目，
> 本仓库的四个房间原始文本也只是风味描述。此功能按用户要求作为房规加入。
