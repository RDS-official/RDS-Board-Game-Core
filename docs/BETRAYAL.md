# 《山屋惊魂》机制实现与模拟器缺陷评估

> 本文对应代码：`packages/games/src/betrayal/*`（模块）、`packages/kernel/src/*`（内核）、`packages/app/src/session.ts`（呈现适配）、`apps/web/src/render/*`（桌面）。
> 当前基线：`244 passed / 0 failed / 0 boundary violations`；`tsc --noEmit` 通过。
> 定位：内核是产品，山屋是**高复杂度一致性夹具**。本文既记录规则覆盖，也记录在实现过程中被证伪的内核假设。

---

## 0. 摘要

《山屋惊魂》是本项目里第一个同时要求**动态拓扑、三层空间、隐藏牌堆、秘密目标、非玩家行动者、每回合多次检定、装备与随从、作祟剧本热注入**的规则集。实现后得到两个结论：

1. **内核的确定性、回放、投影、决策窗口和规则钩子足以承载它**，不需要为山屋改内核；
2. **内核缺少四个“一等公民”**：非玩家行动者、批量掷骰、空间几何、派生属性/持续效果。这四个缺口没有被“绕过”得很优雅，而是被模块层用自动化和启发式补齐了。第 8 节逐条评估。

当前覆盖：

| 维度 | 数量 | 状态 |
| --- | ---: | --- |
| 房间板块 | 44（5 起始 + 39 牌堆） | 全部数据化；门位/楼层/符号/特殊房间 |
| 预兆 | 13 | 13/13 实现；2 张有近似 |
| 物品 | 25（规则书写 22，实际列出 25） | 25/25 实现；10 张有近似 |
| 事件 | 45（规则书点名 15） | 15 张原始卡 + 30 张原型补位 |
| 剧本 | 5（#1 木乃伊 / #3 活死人之夜 / #5 月圆狂兽 / #6 巨眼 / #10 怨灵） | 完整胜利条件、NPC 怪物与特殊机制 |
| 决策窗口 | 伤害分配、交易、水晶球窥视 | 走 `pendingDecisions` |
| 中断栈 | 作祟检定 | `HAUNT_CHECK` 帧 + 超时自动掷骰 |
| 规则钩子 | 5 个剧本各 1 个 | `FILTER_MODIFY` / `BEFORE_REPLACE` / `AFTER_TRIGGER` |
| 测试 | 山屋专项（`suites/betrayal.ts` / `betrayalChecks.ts` / `rulesBetrayal.ts`）+ 内核/应用套件 | 244 total |

---

## 1. 形式模型映射

| 形式符号 | 山屋中的含义 | 实现位置 |
| --- | --- | --- |
| `N` | 3 名探索者（角色库 6 人） | `players` / `playerOrder` |
| `S` | 四维属性轨道 + 房间图 + 手牌 + 牌堆 + 作祟状态 | `GameState` |
| `s0` | 门厅/前厅/大楼梯 + 两层平台 + 洗牌 | `setupBetrayal()` |
| `A` | 移动、探索、用物品、交易、攻击、仪式、结束回合 | `Action` |
| `L` | 按当前房间、移动力、攻击次数、剧本进度生成 | `BetrayalRules.getLegalActions` |
| `T` | 纯 reducer；掷骰全部走 PRNG | `BetrayalRules.applyAction` |
| `O` | 隐藏牌堆、对手目标、房间牌堆顺序 | `project.globalVars` + `CognitiveObserver` |
| `R` | 三方剧本胜负 + 叛徒死亡/英雄全灭 | `checkWinCondition` |
| `K` | 剧本开始时热注入规则切面 | `activeHooks` + `BETRAYAL_HOOKS` |

山屋的 `S` 里没有函数、没有 `Date.now()`、没有 `Math.random()`：

```ts
globalVars: {
  hauntTriggered: boolean;
  haunt: { id, number, title, traitorId, revealRoomId, monsterIds, progress,
           girlHolder?, bonesFound?, beaconDestroyed?, eyesDestroyed?, mummyDelivered? } | null;
  omensRevealed: number;
  omenNames: string[];
  roomDeckTotal: number;
  pendingHauntRoll: { playerId, omens } | null;
  pendingDamage: { playerId, amount, kind, source } | null;
  frostRooms: string[];
  hauntObjectives: { hero, traitor };
  peek: { deck, title, ownerId } | null;
}
```

牌库不放在 `globalVars`，而是普通 ECS 区域（房间板块也已经是实体，不再有 `roomDeck` 字符串数组）：

| 区域 | 内容 | 可见性 |
| --- | --- | --- |
| `zone_event_deck` | 45 张事件 | `HIDDEN` |
| `zone_item_deck` | 25 张物品 | `HIDDEN` |
| `zone_omen_deck` | 13 张预兆 | `HIDDEN` |
| `zone_room_deck` | 39 块房间 TILE | `HIDDEN` |
| `zone_*_discard` | 弃牌/弃置堆 | `HIDDEN`（顶牌公开） |
| `zone_room_placed` | 已翻开的房间 TILE（与 mapGraph 节点一一对应） | `PUBLIC` |
| `zone_hand_pN` | 该玩家的物品/预兆 | `PUBLIC`（山屋的物品是明置的） |
| `zone_room_<roomId>` | 房间物品堆 | `PUBLIC` |
| `zone_monsters` | 怪物实体（MEEPLE） | `PUBLIC` |

---

## 2. 模块结构

```text
packages/games/src/betrayal/
├── cards.ts       44 房间 / 13 预兆 / 25 物品 / 45 事件 + 武器表
├── haunts.ts      3 个剧本定义 + 作祟表 + 回退规则
├── helpers.ts     属性轨道、0/1/2 骰、伤害、探索、卡牌、怪物、回合
├── setup.ts       起始局面、角色、洗牌、区域
├── rules.ts       合法动作 + reducer + 决策回调 + 胜负
├── hooks.ts       剧本规则切面（惧火/晶状护盾/霜冻足迹）
└── scenarios.ts   exploration / trade_ready / haunt_mummy / haunt_eye / haunt_phantom
```

模块之外只改了三处，且都是**表现层**：

| 文件 | 改动 |
| --- | --- |
| `packages/app/src/session.ts` | 山屋 DTO：属性 pips、目标条、动作文案、24 条动作上限并钉住 `END_TURN` |
| `apps/web/src/render/scene.ts` | 房间名/符号、三层分区、怪物 MEEPLE、物品堆锚点、作祟法阵 |
| `apps/web/src/render/procedural/roomTile.ts` | 房间顶面改为无光照贴图，保证远距离可读 |

### 2.1 动作清单

| 类别 | 动作 | 说明 |
| --- | --- | --- |
| 移动 | `MOVE_TO_ROOM` / `EXPLORE_DOOR` / `PLACE_ROOM` / `JUMP_DOWN` / `CLIMB_UP` / `USE_ELEVATOR` | `MOVE_TO_ROOM` 使用 `SelectionSpec`；`EXPLORE_DOOR` 抽板块后在桌面预载房间，用旋转/确认按钮选朝向 |
| 物品 | `USE_ITEM` / `DROP_ITEM` / `PICK_UP_ITEM` | 每件每回合一次；随从不可交易/丢弃；每件物品一个丢弃按钮，点击即进入房间物品堆 |
| 交易 | `PROPOSE_ITEM_TRADE` / `ACCEPT_TRADE` / `REJECT_TRADE` | `FIRST_ACCEPT` 决策窗口 |
| 战斗 | `ATTACK_PLAYER` / `ATTACK_MONSTER` / `SLAP` / `ALLOCATE_DAMAGE` | 伤害分配是单人决策窗口 |
| NPC | `MOVE_NPC` / `ATTACK_HERO` / `END_NPC_TURN` | 怪物是 NPC actor，由叛徒逐只操控 |
| 作祟 | `ROLL_HAUNT_CHECK` / `SEAL_RITUAL` / `SEARCH_BONES` / `CHANT` / `DESTROY_BEACON` | 检定帧 + 剧本进度 |
| 窥视 | `PEEK_TOP` / `PEEK_BOTTOM` | 水晶球决策 |
| 回合 | `END_TURN` | 触发作祟检定；怪物回合由 NPC actor 接管 |

### 2.2 决策、栈、钩子的分工

| 内核机制 | 山屋用法 |
| --- | --- |
| `pendingDecisions` + `ALL_COMMITTED` | 伤害分配（单人）、水晶球窥视（单人） |
| `pendingDecisions` + `FIRST_ACCEPT` | 同房间物品交易（多人响应，首个接受成交） |
| `interruptStack` + `HAUNT_CHECK` | 回合结束的作祟检定；超时自动掷骰 |
| `activeHooks` | 剧本开始注入：`haunt_mummy_fire`、`haunt_eye_ward`、`haunt_phantom_frost` |
| `project.globalVars` | 隐藏对手目标、水晶球窥视结果 |

---

## 3. 规则覆盖矩阵

图例：✅ 完整；◐ 机制存在但有近似；✖ 无法在该模拟器中表达；— 不适用。

### 3.1 核心系统

| 规则 | 状态 | 实现说明 |
| --- | --- | --- |
| 空间查询契约 | ✅ | `BETRAYAL_SPATIAL`：邻接、移动力代价、Dijkstra 可达、同层视线、楼层；幽灵穿墙在模块内 |
| 四维属性、角色轨道 | ✅ | 每人 4 条 8 格轨道；`traitIndex` + `tracks`；数值由轨道派生 |
| 作祟前锁血 | ✅ | `minTraitIndex` 取轨道中最低非 0 值；伤害不会致死 |
| 作祟后 0 点死亡 | ✅ | 任一轨道到 0 → `killPlayer` |
| 死亡物品堆 | ✅ | 手牌全部移入 `zone_room_<room>`；随从留在原地 |
| 移动力 = 速度 | ✅ | 回合开始 `movesLeft = speed` |
| 三层房间/楼层过滤 | ✅ | 单一房间堆；楼层不符或门位不匹配 → 弃置再抽 |
| 门位旋转 | ✅ | 抽到板块后由玩家选择 0/90/180/270；只展示能接上入口门的合法朝向 |
| 相邻门自动连通 | ✅ | 新板块与任意已存在的同层相邻房间，只要双方门相对就自动建立无向边（不只连接探索来源房间） |
| 符号房停步 | ✅ | 进入 EVENT/ITEM/OMEN 房后 `movesLeft = 0` |
| 事件/物品/预兆抽取 | ✅ | 事件即时结算并弃置；物品/预兆入手并结算即时效果 |
| 物品每回合一次 | ✅ | `customProps.usedItems` 按 defId 记录 |
| 同房间交易 | ◐ | 1 换 1 或无条件赠予；不支持多件打包 |
| 丢弃/拾取 | ◐ | 每次一件；物品堆按房间建区域 |
| 随从不可交易/丢弃/被盗 | ✅ | `companion` + `tradeable=false`；偷窃过滤 |
| 作祟检定 6 颗 0/1/2 骰 | ✅ | `rollZeroDice`；总和 < 预兆数触发 |
| 作祟表（预兆 × 房间） | ◐ | 精确表 + 预兆回退 + 楼层回退；仅 3 个剧本 |
| 阵营划分 | ✅ | 揭示者 `TRAITOR`，其余 `HERO` |
| 叛徒离开桌面读书 | ✖ | 社交协议；模拟器直接进入目标投影 |
| 叛徒免疫房间害处 | ◐ | 自动免疫，不能逐次选择“这次吃/不吃” |
| 叛徒不抽事件 | ✅ | 进入事件房直接标记已结算 |
| 近战对抗 | ✅ | 双方掷对应属性；高者胜；差值 = 伤害 |
| 伤害属性选择 | ✅ | 防守方通过决策窗口选择力量/速度或神智/知识 |
| 神智攻击 | ✅ | 指环切换；防守方神智；精神伤害 |
| 远程攻击 | ◐ | 左轮同层直线；直线用网格占位启发式，不含墙体 |
| 远程不受反伤 | ✅ | 攻击失败时射手不受伤害 |
| 偷窃（伤害 ≥ 2） | ✅ | 攻击参数 `steal=yes`；随机偷一件可偷物品 |
| 板甲不可偷 | ✅ | `stealable:false` |
| 怪物回合 | ✅ | 怪物是 `Npc` actor；叛徒结束回合后逐个接管 `MOVE_NPC` / `ATTACK_HERO` / `END_NPC_TURN` |
| 怪物移动 = 速度骰 | ✅ | NPC 回合开始掷 0/1/2 骰；每点移动力走一格；虚体可绕门 |
| 虚体穿墙 | ◐ | 怨灵按同层网格邻接移动，可绕过门；不是连续几何 |
| 击晕 | ✅ | 英雄胜出 → 翻面；NPC 回合跳过后恢复（巨眼为两回合） |
| 阻碍移动 | ✅ | 每有一个未击晕怪物/敌对叛徒，离开 +1 移动力 |
| 剧本胜利 | ✅ | 木乃伊封印 2 次 / 巨眼信标 / 怨灵安魂 3 次；叛徒对应条件 |

### 3.2 13 张预兆

| 预兆 | 状态 | 实现 |
| --- | --- | --- |
| 噬咬 Bite | ✅ | 抽到即 4 骰力量攻击；卡留手牌，不可交易 |
| 禁忌古籍 Book | ✅ | 知识 +2 / 失去 -2 |
| 水晶球 Crystal Ball | ◐ | 知识 4+；可选事件/物品堆，决定顶/底；1–3 失 1 神智，0 失 2 |
| 脏狗 Dog | ◐ | 力量/神智 +1；每回合可派狗取 6 步内物品堆第一件 |
| 小女孩 Girl | ✅ | 神智/知识 +1；木乃伊剧本关键实体 |
| 神圣徽记 Holy Symbol | ✅ | 神智 +2 / -2；封印与安魂必需 |
| 疯汉 Madman | ✅ | 力量 +2、神智 -1 / 逆向 |
| 诡异面具 Mask | ✅ | 神智检定切换；知识 +2 骰、神智 -2 骰（最低 1） |
| 五芒星奖章 Medallion | ✅ | 免疫五芒星堂/墓园/地窖负面 |
| 古旧指环 Ring | ✅ | 攻击时切换为神智攻击 |
| 裂痕头骨 Skull | ◐ | 精神伤害 -1；知识 5+ 得 1 知识（原规则可选情报/属性） |
| 神圣之矛 Spear | ✅ | 力量攻击 +2 骰，上限 8 |
| 通灵板 Spirit Board | ◐ | 神智 5+ → 本回合 +4 移动；作祟后给叛徒目标提示；未实现“自由摆放板块” |

### 3.3 25 张物品（规则书写“22 张”，实际列出 25 张）

> 这是规则文本自身的第一处不一致。实现以**逐条列出的 25 张**为准。

| 物品 | 状态 | 实现 |
| --- | --- | --- |
| 肾上腺素针 | ✅ | 本次检定 +4 / 本回合移动 +4 |
| 千古护身符 | ✅ | 四维 +1；失去时四维 -3 |
| 天使羽毛 | ✅ | 指定下次骰点 0–8 |
| 板甲 | ✅ | 肉体伤害 -1；不可偷 |
| 锋利手斧 | ✅ | 力量攻击 +1 骰 |
| 黄铜法铃 | ◐ | 神智 5+ 驱赶同房怪物；铃+书+烛四维 +2；不能驱赶英雄 |
| 饮血匕首 | ✅ | 力量攻击 +3 骰；每次攻击后速度 -1 |
| 黑液药瓶 | ◐ | 3 骰表；6 随机传送（原规则任意房间） |
| 冥想蜡烛 | ✅ | 事件房 1 骰出 2 忽略事件；三神器组件 |
| 黑暗骰子 | ◐ | 3 骰；4+ 力量 +1；否则神智 -1（原规则任选属性） |
| 德鲁伊护符 | ◐ | 速度 +1；无野兽怪物可对抗 |
| 雷管炸药 | ◐ | 目标房间 3 骰物理伤害；未实现炸墙 |
| 治疗药膏 | ✅ | 2 次；肉体属性回绿色 |
| 神秘神像 | ◐ | 知识 +1；失败自动重掷（花 1 神智） |
| 幸运石 | ◐ | 失败自动 +1 |
| 医疗包 | ✅ | 知识检定 6+/4+/2+ 回复 3/2/1 |
| 古董八音盒 | ✅ | 同房神智 <4 结束行动 |
| 铁镐 | ◐ | 力量 +1 骰；无坍塌门可开 |
| 解谜机关盒 | ✅ | 知识 6+ 抽 2 物品并弃盒 |
| 幸运兔足 | ◐ | 自动重掷最低骰 |
| 老式左轮手枪 | ◐ | 速度 +1 骰、同层直线、免反伤；直线不含墙体 |
| 结实麻绳 | ✅ | 楼座坠落免伤；可从舞厅攀回楼座 |
| 献祭匕首 | ✅ | 力量 +2 骰；攻击前神智 3+，失败失 1 神智 |
| 骷髅万能钥匙 | ◐ | 免检定开金库；前门无逃生剧本可开 |
| 刺激嗅盐 | ✅ | 精神属性回绿色 |

### 3.4 45 张事件

规则书点名 15 张；其余 30 个槽位用同构原型补足，`canonical` 字段标记来源：

| 类别 | 数量 | 代表卡 | 实现 |
| --- | ---: | --- | --- |
| 精神恐怖 | 12 | 葬礼、鲜血幻象、死寂、低语魔音 | 神智检定 + 属性/自伤/掉物品/随机移动 |
| 肉体陷阱 | 12 | 地板坍塌、剧毒群蛛、收缩之墙、还魂尸爪 | 速度/力量检定 + 伤害/属性损失/坠入地下室 |
| 知识解谜 | 10 | 上锁的保险箱、魔镜、秘密暗道 | 知识检定 + 抽物品/属性/建立捷径 |
| 空间异变 | 6+1 | 神秘滑道、时空迷离 | 坠入地下室 / 随机传送（未实现房间旋转） |
| 持续诅咒 | 5 | 滴血之声、恶灵附体 | 挂在角色身上，回合开始检定 |
| 氛围/空房 | 其余 | 灰尘与蛛网、鼠群、空房间 | 轻量检定 |

事件检定由 reducer 自动结算；幸运类道具（幸运石/兔足/神像/天使羽毛）在 `rollTraitCheck` 内自动修正。**代价**：玩家不能在看到骰点后再决定是否使用道具；这是内核缺少“掷骰后交互窗口”的直接后果。

### 3.5 三个剧本

| 剧本 | 叛徒 | 怪物 | 英雄胜利 | 叛徒胜利 | 特殊机制 |
| --- | --- | --- | --- | --- | --- |
| #1 木乃伊苏醒 | 大祭司 | 木乃伊（速3/力8/智5） | 石棺房 2 次知识 5+ 封印 | 木乃伊带女孩到石棺，或英雄全灭 | 女孩争夺、炉火降力、圣物/指环 |
| #6 巨眼降临 | 被接引登舰 | 2 只巨眼（速4/力4/智6） | 摧毁 2 眼 + 炸信标 | 所有英雄被绑架/死亡 | 叛徒移出桌面、精神控制、拍醒免疫、速度免疫 |
| #10 幽灵的拥抱 | 怨灵祭品 | 怨灵（速6/智6） | 找遗骨 + 圣徽 + 3 次神智 5+ 安魂 | 英雄全灭 | 虚体、物理免疫、精神攻击、霜冻房间、速度减半 |

---

## 4. 关键流程

### 4.1 探索

```text
EXPLORE_DOOR(player, dir)
  cost = 1 + hostilesInRoom(current)          // 英雄离开受阻房间
  if movesLeft < cost: reject
  loop:
    tile = zone_room_deck.pop()                // TILE entity, HIDDEN
    if tile.floor != current.floor: move to discard; continue
    rotations = [0..3] where a door faces opposite(dir)
    if none: move to discard; continue
    store pendingRoomPlacement(tile, rotations); wait for PLACE_ROOM
  PLACE_ROOM(rotation):
    validate rotation in rotations
    place node at grid + delta(dir); connect edge to source room
    connectAdjacentDoors(): for every same-floor grid neighbor
      if both rooms have facing doors -> connectRooms (undirected)
    move tile to zone_room_placed; node.props.tileEntityId = tile.id
  move player; movesLeft -= cost
  enterRoom():
    room special (furnace/collapsed/vault/...)
    if room has symbol and unresolved:
      draw event/item/omen
      movesLeft = 0
```

- 房间坐标：每层是**开放网格**，`col/row` 存在 `props`，可以向任意方向扩展；39 块房间牌堆是实际规模上限。`MapGraphNode.position` 保存高维逻辑坐标 `[col,row,layerIndex]`，由 render 层 `spatialProjection` 映射成世界坐标。`gridToWorld` 仍用于实体锚点（怪物/物品堆），相机按所有房间包围盒自动取景。
- 三层在表现层动态横向分区：按当前各层房间的包围盒计算层间距与底板尺寸，楼层增加/消失/移动后会重新排布；不再依赖固定 9.6 / 14 偏移。
- 楼梯用 `edge_<from>_<to> type=STAIRS` 连接大楼梯与两层平台。
- 楼座/露台到舞厅是**单向** `DROP` 边；`CLIMB_UP` 需要麻绳。

### 4.2 属性检定

```text
count = traitValue + checkBonus + extraDice
        + (mask ? knowledge +2 / sanity -2 : 0)
count = clamp(count, 1, 8)
roll count × d{0,1,2}; sum
if sum < threshold:
  rabbit's foot: reroll lowest die (once/turn)
  lucky stone: +1 (once/turn)
  idol: reroll whole check, pay 1 sanity (once/turn)
```

所有检定写入 `globalVars.lastRoll`，供 UI/日志读取；不使用 `Math.random()`。

### 4.3 战斗

```text
ATTACK_PLAYER(target, weapon, steal)
  sameRoom or (weapon.ranged and sameFloorLine)
  attackDice = traitValue(weapon.trait) + weapon.dice   // cap 8
  attack = roll(attackDice); defense = roll(defenderTrait)
  attacksLeft -= 1
  pay weapon cost (blood dagger -1 speed; sacrificial dagger sanity 3+)
  diff > 0:  steal? (diff>=2 and target has stealable item) -> steal
             else openDamageWindow(defender, diff, kind)
  diff < 0:  ranged ? no retaliation : damage attacker
  diff = 0:  nothing
```

伤害窗口：

```text
openDecision(kind=SIMULTANEOUS, participants=[defender], payload={kind:'damage'})
legalActions(defender) = [ALLOCATE_DAMAGE {trait}]
timeout -> onDecisionResolved 自动按第一个属性结算
```

`ALLOCATE_DAMAGE` 是**单人决策窗口**，因此防守方不需要是当前行动者；引擎的 `getFocusActors` 会自动把焦点切到防守方。

### 4.4 作祟检定

```text
END_TURN
  if pendingHauntRoll.playerId == active and not haunt:
    push HAUNT_CHECK frame
      eligible=[revealer]
      actionPayload = ROLL_HAUNT_CHECK（超时也自动掷）
    return
  advanceTurn()                    // 若下一个是 NPC，则进入 NPC 回合

ROLL_HAUNT_CHECK
  roll 6 × d{0,1,2}
  sum < omens ? startHaunt() : advanceTurn()
```

作祟开始：

1. `resolveHauntId(omen, room, floor)` 查表；
2. 揭示者 `TRAITOR`，其余 `HERO`；
3. 生成怪物（同时创建 `Npc` actor）与石棺/飞船标记；
4. `actorOrder = 叛徒及其之前的玩家 + NPC + 之后的玩家`；
5. 注入剧本钩子；
6. `activePlayerId = leftOf(traitor)`，`activeActorId = activePlayerId`；
7. 写入 `hauntObjectives`（投影时按阵营裁剪）。

### 4.5 怪物回合（NPC actor）

```text
advanceTurn 找到下一个 actor
  if actor is NPC:
    startNpcTurn: 若未击晕，掷 speed 个 0/1/2 骰 -> npc.movesLeft
                  attacksLeft = 1
    焦点 = NPC；叛徒通过 MOVE_NPC / ATTACK_HERO / END_NPC_TURN 操控
  if NPC stunned:
    只有 END_NPC_TURN；回合结束掷骰递减 stunTurns，到 0 复原
  MOVE_NPC: 邻接房间（怨灵：同层网格邻接）; 虚体留霜冻
  ATTACK_HERO: 同房间英雄；木乃伊抢女孩、巨眼控制、怨灵精神伤害
  END_NPC_TURN: advanceTurn；木乃伊带女孩到石棺则 traitor 胜
```

NPC 是正式的 `Actor`（`activeActorId`、`actorOrder`、`legalActions(actorId)`），不再在叛徒 reducer 内自动执行。

### 4.6 死亡与物品堆

```text
trait index -> 0 (post-haunt)
killPlayer:
  alive = false
  dropAllItems:
    every card in hand -> zone_room_<currentRoom>
    visibility = PUBLIC
    ownerId = undefined
```

随从（狗/女孩/疯汉）与普通物品都落在地上；下一位进入者可以拾取。女孩被木乃伊抢走时，卡牌移动到 `zone_monsters`，`haunt.girlHolder = monsterId`。

### 4.7 投影

| 数据 | 英雄视角 | 叛徒视角 | 上帝视角 |
| --- | --- | --- | --- |
| 对手目标 | 隐藏 | 隐藏英雄目标 | 双目标 |
| 房间牌堆顺序 | 隐藏，仅数量 | 同 | 完整 |
| 水晶球窥视结果 | 仅持有者 | 仅持有者 | 完整 |
| 事件/物品/预兆牌堆 | 虚拟 ID + 遮罩 | 同 | 真实 |
| 叛徒身份 | 公开 | 公开 | 公开 |
| 怪物 | 公开 | 公开 | 公开 |

---

## 5. 内容表统计

### 5.1 房间（44）

| 楼层 | 总数 | 起始 | 牌堆 | 符号分布 |
| --- | ---: | ---: | ---: | --- |
| 一楼 GROUND | 14 | 3（门厅/前厅/大楼梯） | 11 | 事件/物品/预兆混合 |
| 二楼 UPPER | 14 | 1（二楼平台） | 13 | 预兆偏多 |
| 地下室 BASEMENT | 16 | 1（地下平台） | 15 | 仪式/墓穴/熔炉 |
| 合计 | 44 | 5 | 39 | 事件 10 / 物品 9 / 预兆 10；10 间无符号 |

无符号房间（舞厅、楼座、坍塌之室、煤槽、神秘电梯、观星室、杂物间、金库、酒窖、食品储藏间）进入后**不抽牌、不停步**；其中金库/坍塌/煤槽/电梯仍有各自的房间规则。

特殊房间：金库（钥匙/知识 6+）、坍塌之室（速度 5+，否则坠入地下）、熔炉（1 伤害，叛徒免疫）、煤槽、楼座/露台（单向跳下）、神秘电梯（任意已探索房间）、墓园/地窖/五芒星堂（无奖章则神智 4+）。

### 5.2 牌堆

- 预兆 13；物品 25；事件 45。
- 事件中 `canonical: true` 15 张，`false` 30 张原型补位。
- 房间牌堆 39；起始 5 块不在牌堆。
- 每局洗牌全部走 `DeterministicPRNG.shuffle`，种子记录在 `state.seed`，回放可复现。

---

## 6. 场景与操作

| 场景 | URL | 内容 |
| --- | --- | --- |
| 探索 | `?game=betrayal&scenario=exploration` | 三层已铺 9 间房，玩家持斧/绳/医疗包/蜡烛/圣徽 |
| 作祟检定 | `?game=betrayal&scenario=omen_ready` | p1 已有 8 张预兆，结束回合进入 `HAUNT_CHECK` |
| 交易 | `?game=betrayal&scenario=trade_ready` | 三人前厅，p1 斧+幸运石，p2 绳+板甲 |
| 木乃伊 | `?game=betrayal&scenario=haunt_mummy` | 地下墓穴，女孩在 p2，圣徽在 p3 |
| 巨眼 | `?game=betrayal&scenario=haunt_eye` | 塔楼，p2 被控制，p3 自由 |
| 怨灵 | `?game=betrayal&scenario=haunt_phantom` | 五芒星堂，遗骨未找到 |

操作路径：

1. 底部动作栏点击“探索房门 · N/S/E/W”；
2. 点“移动至相邻房间 · N 处可选”，再点桌面高亮房间；
3. 点“攻击 …”打开参数表单（武器/偷窃）；
4. 点“提出同房间交易”选择付出/索取；
5. 伤害窗口出现时，防守方点击“选择承受伤害的属性”；
6. `END_TURN` 触发作祟检定或怪物回合；
7. 右侧检查器 `STACK / HOOKS / FACTIONS / TIME` 可观察帧、钩子、阵营、时钟。

---

## 7. 测试

`packages/harness/src/suite.ts` 新增 23 条山屋专项：

| 用例 | 覆盖 |
| --- | --- |
| content tables | 44/13/25/45/39、起始 5 房、属性轨道 |
| exploration | 楼层过滤、门位旋转、符号停步、预兆入栈 |
| haunt stack | 结束回合压栈、超时/主动掷骰、叛徒/英雄划分、钩子注入 |
| haunt chart | 精确表 + 回退 |
| mummy setup | 女孩、石棺、惧火钩子 |
| NPC turn | 怪物是 actor、独立焦点、逐只移动/结束回合、回放 |
| room orientation | `EXPLORE_DOOR` 抽牌 → 桌面预载房间 → 旋转/确认按钮 → `PLACE_ROOM` |
| adjacent doors | 新房间与所有同层相邻门自动建立双向边 |
| drop item | 单件物品从动作栏直接丢弃，手牌进入房间物品堆 |
| combat decision | 伤害窗口 + 属性分配 |
| steal | 伤害 ≥2 改为偷窃 |
| armor | 物理减伤 |
| revolver | 同层直线 + 免反伤 |
| rope | 楼座跳下免伤 + 攀回 |
| fire + spear | 炉火降力、击晕、阻碍解除 |
| eyes + slap | 速度攻击取消、拍醒免疫 |
| phantom | 遗骨、霜冻钩子、安魂进度 |
| event | 上锁保险箱抽 2 物品 |
| equipment | 药膏回绿、每回合一次、充能 |
| death | 手牌进入房间物品堆 |
| trade | 1:1 交换 + 回放 |
| projection | 对手目标/房间牌堆隐藏 |
| victory | 木乃伊封印 2 次 / 巨眼信标 |
| random play | 剧本内随机行动 + 位精确回放 |

运行：

```bash
node scripts/test-core.mjs          # 244 passed
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build
```

演示脚本：`node scripts/shoot-betrayal.mjs`（截图）、`node scripts/flow-betrayal.mjs`（UI 流程断言）。

---

## 8. 模拟器缺陷清单

这一节是本次实现最重要的产出之一：以下问题不是山屋的规则问题，而是**内核/表现层在设计山屋时暴露出的表达力缺口**。按严重度排序。逐项改造方案、方案对比与各执行面细化见 [KERNEL-EXPRESSION.md](KERNEL-EXPRESSION.md)。

### 8.1 P0：无法或只能扭曲表达的机制

#### D1. 非玩家行动者（怪物）没有回合

> **状态：已修复（Wave 1）**。内核新增 `ActorId`/`Npc`/`activeActorId`/`actorOrder`；山屋怪物是 NPC actor，叛徒通过 `MOVE_NPC`/`ATTACK_HERO` 逐只操控。

- **现象（修复前）**：`GameState.activePlayerId` 必须是 `players` 里的键；`getFocusPlayers` 只返回玩家；`legalActions(state, playerId)` 以玩家为单位。怪物无法拥有“怪物回合”，也无法由叛徒逐只选择移动/攻击。
- **当时绕法**：在叛徒 `END_TURN` 的 reducer 内直接跑 `monsterPhase`，用 BFS + 最近英雄 + 自动攻击。怪物行为是确定性的，但不是叛徒的策略选择。
- **现在的实现**：`Npc` + `actorOrder`；`startNpcTurn` 掷速度骰；`MOVE_NPC`/`ATTACK_HERO`/`END_NPC_TURN`；`getFocusActors` 把焦点切到 NPC。
- **仍待补**：NPC 控制者没有服务端权限校验；隐藏 NPC 的投影策略只是 PUBLIC/visibility 的最小子集。

#### D2. 批量掷骰 / 全桌检定缺失

- **现象**：没有“所有玩家各掷一次”或“每个人在看到骰点后决定是否使用幸运石”的原语。只有 `DecisionWindow`（提交动作）和 `StackFrame`（响应动作）。
- **本实现的绕法**：事件检定自动结算；幸运类道具在 `rollTraitCheck` 内自动修正；Bite 的“右侧玩家代掷”变成自动 4 骰。
- **后果**：玩家失去了“看到失败后再花资源”的时机；多人同时检定被序列化或省略。
- **建议**：增加 `RollGroup`：先收集所有参与者的修正/道具声明（秘密或公开），再一次性掷骰、统一揭示、按座位结算。

#### D3. 空间几何缺失（墙体/门/旋转/楼层）

- **现象（修复前）**：`MapGraph` 只有节点、邻接、2D 世界坐标；没有墙段、门端口、房间旋转后的边匹配、楼层体积。`sameFloorLine` 只能用“同行/同列且中间格子已有房间”近似视线；不同楼层投影到同一平面时会重合。
- **本实现的绕法**：门位旋转在模块内计算；楼层用三块横向区域；左轮视线用网格占位；楼座用单向 `DROP` 边；怨灵穿墙用网格邻接 BFS。
- **后果**：左轮可以穿过没有门的墙；房间板块朝向由算法决定而非玩家；炸药不能炸墙；三层不是垂直堆叠。
- **建议**：`Tile` 带 `ports`（每边门/墙/窗）、`rotation`、`floor`；`MapGraph` 边由端口匹配生成；提供 `lineOfSight(from,to)` 几何端口。

#### D4. 派生属性 / 装备槽 / 持续效果缺失

- **现象**：`Player.customProps` 是无类型袋子；没有 `base + modifiers[]` 的属性模型，没有装备槽，没有持续效果生命周期。
- **本实现的绕法**：
  - 物品在获得/失去时直接改 `traitIndex`（古籍、圣徽、护身符）；
  - 面具改成检定骰修正；
  - 持续诅咒存为 `customProps.effects: string[]`，回合开始手写检查；
  - 击晕用 `stunTurns` 手工计数；
  - “每次攻击只能使用一件武器”通过 payload 枚举强制。
- **后果**：物品转手、叠加、暂时增益、失去时的惩罚都容易出现边界错误；新增一张“持续到下一怪物回合”的卡需要改 reducer。
- **建议**：`Stats` 派生层 + `Modifier {source, target, delta, duration}`；`EffectInstance` 带 `expiresAt: {turn, phase}`；装备槽进入 ECS。

#### D5. 卡牌效果没有 DSL

- **现象**：45 事件、25 物品、13 预兆全部是 `cards.ts` 数据 + `rules.ts` 里的 `switch`。没有效果解释器。
- **后果**：内容扩展 = 改代码；卡牌文本与实现容易漂移；测试只能逐卡写。
- **建议**：把效果拆成 op 列表（`traitDelta`、`check`、`draw`、`move`、`attack`、`attachEffect`、`teleport`…），核心提供 `EffectInterpreter`，模块只提供表。

### 8.2 P1：表达力不足导致的近似

#### D6. `Action.fields` 只能 enum/number

> **状态：已修复（Wave 0/1）**。新增 `SelectionSpec` + `Action.targets`；山屋 `MOVE_TO_ROOM` 已改为一个动作 + 候选房间，UI 弹出多选/单选面板。

- **现象（修复前）**：无法声明“选择一个实体/房间/玩家/多选”。模块只能为每个候选生成一个 Action。
- **后果**：
  - 山屋一回合可能有 20+ 合法动作；
  - `buildActions` 原来上限 14，会把 `END_TURN` 截掉（已修为 24 并把 `END_TURN` 钉在末尾）；
  - 桌面分组会丢失每个目标的 fields（曾导致“攻击怪物”分组后无法选武器，已改为不分组）。
- **现在的实现**：`ActionFieldSpec.kind` 支持 selection；`module.resolveSelection`/`validateSelection`；HUD 选择器；`perform(actionId, payload, targets)`。
- **仍待补**：多选目标（`targets: string[]` 已支持，但山屋只用了单选）；候选过滤仍由模块手写。

#### D7. 隐藏牌堆只有 ECS 区域一种形态

> **状态：山屋已修复（Wave 0）**。房间板块改为 `zone_room_deck` 里的 TILE 实体；投影自动遮罩，不再手写 `roomDeck` redactor。

- **现象（修复前）**：卡牌可以放 `HIDDEN` zone，observer 会虚拟 ID + 遮罩；房间板块是 `globalVars.roomDeck` 里的字符串数组，observer 不认识。
- **当时的绕法**：`project.globalVars` 手写删除 `roomDeck`，只暴露 `roomDeckCount`。
- **现在的实现**：`zone_room_deck` / `zone_room_discard` / `zone_room_placed`；`roomDeckCount` 由 zone 长度公开。
- **仍待补**：内核仍没有通用 `HiddenDeck<T>`；其他非实体隐藏序列还会遇到同样问题。

#### D8. 淘汰 / 放逐 / 旁观没有状态机

> **状态：部分修复（Wave 1）**。`Npc.status` 与 `actorOrder` 已落地；玩家仍用 `alive`/`banished`。

- **现象**：`playerOrder` 不变；`activePlayerId` 可以指向死者；没有 spectator 概念。
- **当前绕法**：
  - 死者若正好是 active，reducer 末尾自动 `advanceTurn`；同时 `legalActions` 对死者仍返回 `END_TURN` 兜底；
  - 巨眼剧本的叛徒 `banished` 被 `nextEligibleActor` 跳过；怪物是 NPC，不再需要借叛徒回合触发；
  - 被绑架英雄 `alive=false` + `abducted=true`。
- **后果**：UI 仍显示死者卡片；`playerOrder` 不收缩；玩家没有 `status` 状态机。
- **建议**：统一 `ActorStatus` 到 Player；调度器跳过非 ACTIVE；focus 支持观察者。

#### D9. 秘密目标只有 globalVars redactor

- **现象**：`project.globalVars` 能按 viewer 裁剪，但没有“每个阵营一份秘密文本”的类型化通道。
- **本实现的绕法**：`hauntObjectives` 存两份，redactor 根据 `role` 只保留一份。
- **后果**：`haunt` 对象本身仍是全公开的；任何新增秘密字段都要手动加 redactor。
- **建议**：`secrets: { audience: PlayerId[] | Faction, payload }[]`，observer 统一裁剪。

#### D10. 多楼层只是表现层分区

- **现象**：三层横向排开，没有垂直堆叠、楼层切换、遮挡关系。
- **后果**：桌面很宽、标签小、相机远；玩家需要靠“地下室/一楼/二楼”标签辨认；未来做 3D 房屋会需要重写 renderer。
- **建议**：presenter 暴露 `floors` 与 `activeFloor`；renderer 支持楼层显隐/剖面；相机按楼层取景。

#### D11. 物品交互粒度过粗

- **现象**：一次只能用一个/丢一个/捡一个；交易只能 1:1 或赠予；不能多选。
- **后果**：山屋“可随时丢弃任意数量物品”“自由交易”被拆成多次动作；回合内动作数膨胀。
- **建议**：`entityIds: EntityId[]` 批量动作；`TradeOffer {give[], want[]}`。

#### D12. 骰面模型

- **现象**：`DeterministicPRNG.rollDice` 只支持 `1..sides`；山屋需要 0/1/2 面。`DiceMeshBuilder` 也没有 0 面。
- **本实现的绕法**：模块内 `rollZeroDice` 用 `nextInt(seed,0,2)`；UI 不渲染山屋骰。
- **建议**：`DiceSpec {faces: number[]}`；renderer 支持任意面纹理。

### 8.3 P2：体验/架构债

| 编号 | 问题 | 影响 | 建议 |
| --- | --- | --- | --- |
| D13 | `GameOutcome` 只有 winner/reason | 无法表达“英雄达成 2/2 封印但叛徒也达成”这类双条件，也没有阵营分数 | `winners/losers/objectives[]/scores` |
| D14 | 投影后的 actionLog 去掉 payload/entityId | 山屋的物品/交易/攻击日志在 UI 里只剩动作类型 | 按动作声明公开字段，或公私双日志 |
| D15 | `RandomPolicy` 不会评估山屋选择 | 机器人会随机攻击木乃伊、随机交易，不能作为平衡测试 | 启发式/蒙特卡洛策略端口 |
| D16 | 每次 revision 全量重建 Three.js 场景 | 房间/卡牌增多后帧率与拾取开销上升 | 差量 sync / 对象池 |
| D17 | 桌面可读性 | 深色场景 + 远相机，房间名偏小；三层横向排布 | 楼层切换、标签 LOD、局部补光 |
| D18 | 无角色选择 | 角色库 6 人，默认只上 3 人 | setup 参数化 roster + UI 选人 |
| D19 | 无“前门逃生”剧本 | 骷髅钥匙只能开金库 | 增加逃生剧本或通用 `EXIT` 目标 |
| D20 | 无墙体/炸药破墙 | 雷管只造成伤害 | 依赖 D3 几何 |

### 8.4 明确“无法模拟”的桌游机制

这些不是实现偷懒，而是媒介差异；记录在此，避免把“模拟器”误解为“完整替代实体桌游”。

| 机制 | 为什么无法模拟 | 本实现的处理 |
| --- | --- | --- |
| 叛徒/英雄分开读两本剧本 | 依赖玩家离开桌面、私下阅读、不能互看 | 直接把各自目标投影给对应阵营；没有“离桌”状态 |
| 桌面密谋、说谎、指控 | 社交行为，不在游戏状态里 | 不建模；只提供结构化交易/攻击 |
| 实体掷骰、洗牌、摸牌的手感 | 物理随机与手部操作 | 确定性 PRNG + 动画/日志代替 |
| 房间板块的物理朝向选择 | 实体上玩家可以旋转板块挑选朝向 | 自动选第一个合法朝向 |
| “任意数量”丢弃/拾取/交易 | 需要多选 UI 与批量动作 | 一次一件 |
| 自由摆放房间板块（通灵板） | 需要“从牌堆顶拿一块并放到任意门”的空间编辑器 | 改为 +4 移动 |
| 旋转/交换房间（时空迷离） | 会破坏已建立的邻接与门位 | 改为随机传送 |
| 叛徒逐只指挥怪物 | 已通过 NPC Actor 解决（D1） | `Npc` + `actorOrder` + `MOVE_NPC`/`ATTACK_HERO` |
| 精确视线/墙体阻挡 | 没有几何（D3） | 同行/同列 + 中间房间占位 |
| “直到下一个怪物回合结束” | 没有持续效果时钟（D4） | `stunTurns` 手工计数 |
| 全桌同时检定 | 没有批量掷骰（D2） | 自动结算或逐个窗口 |
| 50 个剧本的完整剧本手册 | 内容工程，不是引擎能力 | 只实现 3 个，其余回退 |

### 8.5 规则文本自身的不一致

实现时发现并记录的规则歧义（不是模拟器 bug）：

1. **物品数量**：文字写“22 张物品牌”，实际逐条列出 **25 张**。本实现按 25 张。
2. **事件数量**：写“45 张”，但只点名 15 张；剩余 30 张无文本。本实现用原型补位并标 `canonical:false`。
3. **房间数量**：写“44 块”，但未给完整清单；本实现按 5 起始 + 39 牌堆分配三层。
4. **剧本数量**：作祟表按 #1–#50 设计，但只给 3 个剧本；本实现只保证这 3 个，其他组合走回退。
5. **木乃伊胜利**：既有“封印石棺”，又有“以圣物摧毁木乃伊”；本实现把“摧毁”合并进封印仪式（2 次知识 5+），没有独立击杀路径。
6. **巨眼叛徒**：“移出桌面”但仍“全权操控巨眼”；现在用 `banished` 玩家 + 独立 NPC 怪物表达：叛徒没有身体回合，但仍是 NPC 的 `controllerId`。
7. **怪物可否被杀**：通用规则说“击败=击晕，不受伤”，巨眼剧本又要求“彻底摧毁”；本实现给巨眼加了“先击晕、再一击摧毁”的两段式特例。
8. **Bite 的“右侧玩家代掷”**：需要指定座位关系与代掷者；本实现自动结算，不区分代掷者。
9. **面具戴上/摘下的检定阈值**：原文只写“需进行神智检定”，未给难度；本实现取 4+。
10. **通灵板“自由摆放板块”**：未说明是否受楼层/门位限制；本实现改为移动力加成。

---

## 9. 近似实现明细（便于后续替换）

| 位置 | 近似 | 替换建议 |
| --- | --- | --- |
| `rollTraitCheck` | 幸运道具自动修正 | 引入掷骰后响应窗口（D2） |
| `MOVE_NPC` / `ATTACK_HERO` | 已由 NPC actor 表达 | 未来可加 NPC 策略/控制者权限 |
| `itemFields` | 每个候选生成一个字段选项 | 字段类型 `entity/node`（D6，部分已实现） |
| `sameFloorLine` | 同行/同列 + 占位 | 几何端口（D3） |
| `linkSpecialRooms` | 单向 DROP + CLIMB_UP | 端口/楼层几何（D3） |
| `project.globalVars` | 手写删除旧 `roomDeck`/`peek`（房间已实体化，只剩 peek） | HiddenDeck（D7） |
| `customProps.effects` | 字符串数组 + 回合开始 switch | EffectInstance（D4） |
| `tracks/traitIndex` | 获得/失去物品直接改轨道 | Modifier 派生层（D4） |
| `event` 30 张补位 | 原型卡 | 替换为正式印刷文本 |
| 剧本 3 个 | 手写 reducer 分支 | 剧本 DSL/脚本表 |

---

## 10. 结论

山屋的实现证明了内核的**确定性、投影、决策窗口、栈和规则钩子**是可复用的：81 条用例里，山屋没有要求内核新增任何 API。它也暴露了内核的边界：

- 当游戏出现**非玩家行动者**时，`activePlayerId` 模型不够；
- 当游戏出现**批量随机 + 事后决策**时，`Action` 模型不够；
- 当游戏出现**空间/墙体/楼层**时，`MapGraph` 不够；
- 当游戏出现**装备/持续效果/派生属性**时，`customProps` 不够；
- 当游戏出现**50 个剧本**时，硬编码 reducer 不够。

这五个“不够”是下一阶段内核演进的候选，而不是山屋模块应该继续打补丁的地方。山屋模块应保持为**规则夹具**：它验证内核，不定义内核。

---

## 附录 A：文件索引

| 文件 | 职责 |
| --- | --- |
| [cards.ts](../packages/games/src/betrayal/cards.ts) | 44 房间、13 预兆、25 物品、45 事件、武器 |
| [haunts.ts](../packages/games/src/betrayal/haunts.ts) | 剧本定义、作祟表、回退 |
| [helpers.ts](../packages/games/src/betrayal/helpers.ts) | 轨道/骰/伤害/探索/卡牌/怪物/回合 |
| [setup.ts](../packages/games/src/betrayal/setup.ts) | 角色、起始局面、洗牌 |
| [rules.ts](../packages/games/src/betrayal/rules.ts) | 合法动作、reducer、决策、胜负 |
| [hooks.ts](../packages/games/src/betrayal/hooks.ts) | 三个剧本钩子 |
| [scenarios.ts](../packages/games/src/betrayal/scenarios.ts) | 5 个命名场景 |
| [registry.ts](../packages/games/src/registry.ts) | 模块注册、schema、投影、计时 |
| [session.ts](../packages/app/src/session.ts) | 山屋 DTO/文案/动作上限 |
| [scene.ts](../apps/web/src/render/scene.ts) | 房间/怪物/物品堆/楼层标签 |
| [suite.ts](../packages/harness/src/suite.ts) | 23 条山屋专项测试 |

## 附录 B：状态不变量

- 所有实体都在某个 `zones` 里；怪物在 `zone_monsters`；标记物在房间物品堆。
- `playerOrder` 与 `players` 一致；死者仍在 `players`，但 `alive=false`。
- `pendingDecisions` 的参与者必须存在；伤害窗口的 payload 带 `damageKind`。
- `interruptStack` 的 `HAUNT_CHECK` 帧必须有 `responseWindow` 和自动 `actionPayload`。
- `haunt.monsterIds` 必须指向存在的怪物实体。
- `globalVars.roomDeckTotal` 等于 39；房间 TILE 只在 `zone_room_deck` / `zone_room_discard` / `zone_room_placed` 之一出现。
- `actorOrder` 只含玩家或 NPC；`activeActorId` 必须在 `actorOrder` 中；NPC 若绑定 entity，则 entity 必须存在。
- 怪物 NPC 的 `controllerId` 指向叛徒；`status='ELIMINATED'` 的 NPC 不再被 `nextEligibleActor` 选中。
