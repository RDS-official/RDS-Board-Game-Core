# 模拟器本体优化审计

> 目标：把“手测/黑盒/回放发现的问题”从一次性修复变成**持续收集的模拟器质量清单**。
> 规则夹具（Catan / Betrayal / …）只是触发器；这里记录的是内核、应用层、渲染层、交互层需要长期优化的问题。
>
> 基线：`257 passed / 0 failed / 0 boundary violations`（`node scripts/test-core.mjs`）。

---

## 1. 记录协议

每个问题必须有：

| 字段 | 说明 |
| --- | --- |
| ID | `SA-xx`，稳定不复用 |
| 严重度 | P0 阻断规则 / P1 明显错误或误导 / P2 体验/可维护性 |
| 来源 | 手测、黑盒测试、回放、投影/不变量、代码审计 |
| 现象 | 可复现的最小描述 |
| 根因 | 内核 / 模块 / 应用 / 渲染 / UI 接口 |
| 状态 | 已修复 / 部分 / 待办 / 设计取舍 |
| 验证 | 对应测试、脚本或截图 |

新增问题先登记，再决定是否本轮修。修复后保留记录，不删除历史。

---

## 2. 本轮已修复

| ID | 严重度 | 问题 | 根因 | 修复 | 验证 |
| --- | --- | --- | --- | --- | --- |
| SA-01 | P1 | 抽到房间板块后自动选第一个朝向，玩家不能决定方向 | 模块 reducer 内 `findRotation` 自动落板块 | 拆成 `EXPLORE_DOOR`（抽牌，存 `pendingRoomPlacement`）+ `PLACE_ROOM`（玩家选合法旋转） | `drawn room waits for player-chosen orientation` |
| SA-02 | P1 | 丢弃物品按钮没有真正落到房间物品堆 | `DROP_ITEM` 被当成“高亮后点 3D 卡牌”的分组；手牌卡片渲染在原点，难以点中 | 每件物品一个独立“丢下”按钮；手牌区增加锚点；房间物品堆可拾取 | `a single highlighted drop executes...`、UI flow |
| SA-03 | P1 | 新房间只连接探索来源房间；与已有相邻房间的门不连通 | `exploreFromRoom` 只调用一次 `connectRooms` | `connectAdjacentDoors` 扫描同层四邻，双方门相对即建立无向边；反向边去重；写 `ports` | `adjacent doors connect beyond the explored room` |
| SA-04 | P1 | 旧实现把房间网格限制在 5×5，边缘方向无法继续摆放，和实体规则不符 | 模块内 `GRID_MAX` 边界校验 | 移除固定边界；房间坐标可任意扩展，39 块牌堆限制规模；相机按包围盒取景 | `room placement is not clamped to a 5x5 grid` |
| SA-05 | P0 | 新房间与来源房间产生正反两条边，invariant `duplicate edge` 拒绝落板块 | `connectRooms` 只按固定方向 id 去重，未检查反向 id | `connectRooms` 同时检查正/反向边；已有单向边升级为无向门 | 全量 131 用例 |
| SA-06 | P1 | 点击掉落的卡牌会直接拾取，无法查看物品效果 | `pickTarget` 对任何实体点击都匹配第一个 `entityId` 合法动作 | 无“目标模式”时实体点击改为**查看**；先点“拾取物品堆”再点卡牌才拾取 | `clicking a dropped card inspects it instead of picking it up` |
| SA-07 | P2 | 物品卡面文字被截断，功能说明不完整 | 卡面固定 7 行、20px | 长文本缩小一次并允许 10 行；点击实体弹出含完整 `desc` 的 toast | 渲染截图 + 手测 |
| SA-08 | P2 | 朝向选择弹窗遮挡桌面，落点不可见 | 用通用 payload modal 处理 `PLACE_ROOM` | 桌面预载半透明房间 + 底部“旋转房间 / 确认放置”；不再打开 modal | `shots/betrayal-room-preview.png` |
| SA-09 | P2 | 怪物回合由叛徒 reducer 自动跑，玩家无法逐只操控 | 没有非玩家行动者 | `Npc` actor + `actorOrder` + `MOVE_NPC`/`ATTACK_HERO`/`END_NPC_TURN` | `monsters are NPC actors...` |
| SA-10 | P1 | 房间牌堆顺序/身份可能通过 `globalVars` 泄露 | 字符串数组不在 observer 的实体投影体系内 | 房间板块改为 `zone_room_deck` TILE 实体；observer 裁剪隐藏节点/边 | `projection: hidden map nodes...` |
| SA-11 | P1 | 空间查询分散在山屋私有 helper，无法被选择器/UI 复用 | `GameModule` 只有 `topology` 标签 | `TopologySpec` + `SpatialQuery` + `MapGraphManager` 图算法 + 引擎访问器 | `SpatialQuery`/graph 测试 |
| SA-12 | P1 | 效果/持续修正没有生命周期，模块各自手写 | 没有通用 effect 槽位 | `GameState.effects`、`EffectInstance`、turn/clock/phase 过期、可见性投影、invariants | `effects expire and are projected...` |
| SA-13 | P1 | 动态长条布局会把房间挤出镜头，或诱导重排逻辑坐标 | 相机固定 preset，不按图包围盒取景 | 保留逻辑坐标；渲染层按节点/预览包围盒自动拉远相机（`fitCameraToBoard`） | 手测长排房间 |
| SA-14 | P1 | 曾把 camera/layout hints 放进 `GameCapabilities`，污染核心契约 | 表现策略与几何拓扑没有分层 | 移到 `packages/app/src/layout.ts`；renderer 只接收结构化 `LayoutHints`，不再按 gameId 分支 | `tsc`/手测 |
| SA-41 | P1 | 全量重建棋盘对象时只 remove，不 dispose geometry/material；阴影贴图每帧更新 | Three.js 生命周期与阴影更新策略缺失 | `clearBoardObjects` 释放几何/材质（共享纹理缓存保留）；`shadowMap.autoUpdate=false`，仅棋盘变化时 `needsUpdate` | UI flow / 构建 |
| SA-44 | P1 | 坐标语义升级后，旧会话里的 world position 被新 grid 投影误读，房间视觉重合 | 节点没有声明坐标空间 | `MapGraphNode.positionSpace` 显式标注；缺省按 legacy world 处理 | `legacy world positions remain world positions` |
| SA-45 | P1 | 楼层水平间距 9.6 小于楼层底板宽 12.6，一楼/二楼地板与边缘房间发生视觉重叠 | 表现层固定 offset，未考虑楼层实际宽度 | 山屋改为 `layerMode: 'auto'`，按当前楼层包围盒动态计算层偏移；底板/标签/camera 同步重算 | `projection: auto floor layout...`、`shots/betrayal-auto-floors.png` |
| SA-46 | P1 | 拖拽实体时 OrbitControls 同时旋转相机，视角晃动 | card drag 与 camera orbit 共用 pointer | 实体 drag 开始 `controls.enabled=false`，结束恢复 | UI drag test: camera unchanged |
| SA-47 | P2 | 同类型卡牌没有视觉分组/数量徽章 | 所有卡牌平铺/各自布局 | `render/cardGroups.ts` 按 zone+name+face+owner+visibility 做表现分组；默认扇形、×N 徽章、拖徽章整组、拖顶牌单张；纯视觉不写 state | `cards: presentation grouping...` |
| SA-48 | P2 | token/骰子穿模、阴影不自然 | 无物理，3D 结果只靠静态位置 | 表现层 Rapier 3D：懒加载、固定步长、桌面 collider、仅 token/dice；不写核心状态；阴影改进另立任务 | physics probe: body falls from y=2 to table, 0 console error |
| SA-49 | P1 | 拖动实体越飞越高、放置无法落定 | Three.js raycast 忽略 `visible=false` 导致 `surfaceYAt` 反复击中正在拖拽的实体自身形成正反馈高度累加；松手时也以此高空位置作为目标 | `surfaceYAt` 使用 Set 树形过滤排除被拖实体及其所有子网格；拖动高度稳定在下方表面 +0.45；松手执行 220ms ease-out 下落动画并落定到支撑面 | UI matrix `betrayal:drag-settle-flow`: 15 次往复拖动 heldRange=[0.31, 0.47]，松手后 settledY=0.08 |

---

## 3. 动态布局策略

这是本模拟器必须长期遵守的边界：

### 3.1 逻辑坐标不因镜头/桌面大小而重排

`MapGraphNode.position` / grid `col,row` 是规则状态的一部分，门位、相邻门自动连通、回放哈希都依赖它。
**不能**因为“这一排放不下”就把已有房间挪到第二排或压缩坐标，否则：

- 门的方向与相邻关系会变成假的；
- 玩家已建立的桌面心智地图被破坏；
- 回放/截图/日志中的位置不再可信。

### 3.2 放不下时按优先级处理

| 优先级 | 手段 | 说明 |
| --- | --- | --- |
| 1 | **相机自动取景** | `fitCameraToBoard` 按所有房间 + 待放置预览的包围盒拉远、重新居中；不改变逻辑坐标 |
| 2 | **楼层隔离** | 多楼层只显示当前楼层（K14）；山屋三层横向铺开时尤其需要 |
| 3 | **模块边界拒绝** | 目标格已占用或房间牌堆耗尽时，合法动作阶段不生成 `EXPLORE_DOOR` |
| 4 | **规则级扩展** | 若某游戏规则允许扩建/新翼/任意坐标，由模块扩展 `mapGraph` 和 `TopologySpec`；内核不自动 wrap |
| 5 | **总览/小地图** | 超大地图用缩略图 + 视口框导航；仍不改变状态坐标 |

### 3.3 山屋的具体答案

- 山屋房间是**开放桌面布局**，不是固定 5×5；一排放满只会受 39 块牌堆限制，不会因为“超出网格”而被拒绝。
- 如果目标格已有房间，探索动作本来就不会生成；应走其他门、楼梯或另一层。
- 镜头会把整层/整桌拉远；如果仍太宽，应使用楼层隔离，而不是移动房间。
- 当前已实现相机自动取景；楼层隔离/小地图仍属于 K14。

### 3.3.1 硬约束：单个房间板块的几何必须落在自身 footprint 内

这是**渲染正确性约束**，不是美术偏好：

| 量 | 值 | 含义 |
| --- | --- | --- |
| 板块边长 | 2.84 | 地板 slab 与所有装饰的最大外沿 |
| 板块半宽 `HALF` | 1.42 | 任何顶点 `|x|`、`|z|` 不得超过它 |
| 棋盘格距 | 2.86 | 房间中心间距 |
| 相邻板块近边 | 1.44 | 因此留出 **0.02** 净距 |

一旦某件装饰越过 `HALF`，它就会进入邻块的 0~0.02 缝隙，并在**与邻块共面的水平面**（基座顶面 `y=0.03`、门楣、线脚）产生 z-fighting 闪烁。
历史上正是以下四处越界（最远 +0.025）：

- 基座外沿 `size + 0.04`；
- 门槛铜板 `THICK + 0.05`；
- 门楣黄铜压条 `THICK + 0.07`；
- 屋顶线脚 `len + 0.012`（两端各出挑 0.006）。

回归方式是**几何测量**而不是盯图：
`node scripts/probe-overlap.mjs` 会遍历所有已放置房间的合并网格，逐顶点换算世界坐标并断言 `ext ≤ 1.42`。
新增任何贴墙 / 贴角的构件后都应跑一次。

### 3.4 分层边界
- **core**：只处理 `GameMapGraph`、`TopologySpec`、`nodes/edges` 与通用图算法；
  - 不存相机位置、缩放、padding、UI 布局。
- **app**：`packages/app/src/layout.ts` 维护“游戏 id → 演示取景 hints”的映射；
  - 这是产品表现策略，不是游戏语义。
- **render**：定义自己的 `LayoutHints` 结构，按节点包围盒取景；
  - 不按 `gameId` 分支，不读 `GameCapabilities` 里的相机字段。
- **module**：只提供逻辑坐标（`MapGraphNode.position` / grid col,row），不提供镜头。

后续若加 `bounds`/`layout` 契约，也只应放在 `TopologySpec`（几何边界）或 app/render（表现），不能把“镜头怎么摆”塞回 `GameModule`。

---

## 4. 待办清单

### P0：规则正确性/状态一致性

| ID | 问题 | 影响 | 建议 |
| --- | --- | --- | --- |
| SA-20 | ✅ 已修复：`PLACE_ROOM` 非法旋转 | payload 只校验枚举，未校验 pending 合法朝向 | Betrayal `validatePayload` 在 reducer 前拒绝；回归 `PLACE_ROOM rejects illegal rotation` |
| SA-21 | ✅ 已修复（回归覆盖）：隐藏节点/实体 ID 可能从公开字段泄漏 | 实体投影与自定义字段投影分离 | 增加全夹具 + 多 seed 投影泄漏测试；fixtures 当前 0 泄漏 |
| SA-22 | ✅ 已修复：NPC 动作缺少控制权校验 | 只校验 actor 存在 | engine 校验 `controllerId`；GOD 放行；回归 `NPC actions require controlling viewer` |
| SA-23 | ✅ 已修复：topologySpec 与 mapGraph.topology 未交叉校验 | 声明与 setup 两份手工数据 | 启动校验 kind/adjacency/directed/geometry/layers；修正山屋/三国杀声明 |

### P1：表达力/交互

| ID | 问题 | 影响 | 建议 |
| --- | --- | --- | --- |
| SA-24 | ✅ 已修复：选择候选读 raw state | 候选生成绕过投影 | 候选统一走当前 viewer projection；对手手牌返回空 |
| SA-25 | ✅ 已修复：棋盘目标模式是隐式 session 状态 | 切换视角/重建可能残留高亮 | `setViewer` / `rebuild` 清理；后续可暴露到 snapshot UI state |
| SA-26 | ✅ 已修复：动作栏 24 条截断 | 线性截断 | 取消截断，END_TURN 固定最后 |
| SA-27 | ✅ 已修复：手牌 >7 重叠 | 固定卡宽/步长 | 按数量自适应 cardScale/step；10 张仍保持间距 |
| SA-28 | ✅ 已修复：无目标模式 node/edge 直接执行 | UI 回退匹配任意 legal action | inspect-first；必须从动作栏 targeting |
| SA-29 | ✅ 已修复：预览旋转刷新丢失 | 仅 session 内存 | 按 game/seed/scenario/defId 写入 sessionStorage，仅表现层 |
| SA-30 | Catan/Sanguosha 未实现 `SpatialQuery` | 引擎空间访问器回退到通用图，无法表达港口/座位特殊规则 | 按需补模块实现；无空间语义时显式 `topologySpec.kind='none'` |

### P2：体验/可维护性

| ID | 问题 | 影响 | 建议 |
| --- | --- | --- | --- |
| SA-31 | 物品卡面仍是固定像素排版，极长描述仍可能截断 | 文本完整性 | 以 DOM 卡牌详情为主，3D 卡面只做摘要 |
| SA-32 | ✅ 已修复 | 预览不说明合法朝向 | 面板只显示当前角度 | 显示合法朝向数量与角度列表 |
| SA-33 | `PLACE_ROOM` 只支持单选旋转，未支持“先看板块再决定抽/弃” | 规则差异 | 若规则要求可弃置，增加 `DISCARD_TILE` 动作 |
| SA-34 | ✅ 已修复 | UI 流程覆盖不足 | 旧脚本只跑主路径 | 新增全夹具 UI matrix；后续补三次旋转/多物品专项 |
| SA-35 | `docs/BETRAYAL.md` 的规则覆盖表与实现细节仍会随内容增加漂移 | 文档可信度 | 每次新增卡牌/剧本同步 `content tables` 测试与矩阵 |
| SA-36 | K3 effect 槽位尚未迁移山屋物品/击晕 | 内核能力空转 | 把 `customProps.effects`、`stunTurns` 迁到 `EffectInstance`，保留兼容读取 |
| SA-37 | K4 两阶段检定窗口未做 | 幸运石/掷后反应仍自动 | 增加 `RollWindow`：修正声明 → 掷骰 → 掷后响应 |
| SA-38 | K8 secrets / K9 批量 / K12 DSL / K14 楼层 | RFC 剩余波次 | 按 `KERNEL-EXPRESSION.md` 的 Wave 3 推进 |
| SA-39 | 超长布局只有自动拉远，没有小地图/视口框 | 房间多时导航困难 | 总览模式 + 点击小地图跳转；不重排逻辑坐标 |
| SA-40 | 部分修复：楼层只能全部平铺 | 横向宽度浪费 | HUD 楼层按钮 + `scene.focusFloor` 相机聚焦；renderer 尚未隐藏其他层 |
| SA-42 | ✅ 已修复 | 开放房间网格可超出静态桌垫/楼层底板 | 楼层底板按实际房间包围盒动态计算宽深与中心 |
| SA-43 | 无合法探索时 UI 不解释原因 | 玩家不知道是牌堆空、门位不匹配还是目标被占 | 在动作栏显示“此方向无可放置板块/目标已占用” |
| SA-50 | P1 | 拖动释放到 HUD/画布外后卡牌悬空、相机锁死 | pointerup 只监听 canvas，释放到 HUD 时 drop/end 回调丢失 | entity pointerdown `setPointerCapture`；释放/取消统一收尾；pointerdown 立即禁用 OrbitControls | UI probe: release over HUD → y=0.08, controls=true |
| SA-51 | P1 | 丢弃牌后卡牌穿到房间底板下方 | 新建 mesh 尚未渲染，`matrixWorld` 仍为旧矩阵，`surfaceYAt` 误把桌面当支撑面 | 射线查询前 `scene.updateMatrixWorld(true)`；丢弃后落到房间顶面 | UI matrix `betrayal:discard-settle`: cardY=0.125, surfaceY=0.110 |
| SA-52 | P1 | 丢弃牌房间正确但视觉锚点由 renderer 二次推断 | 房间 zone 与 PlacementSlot 已存在，renderer 仍用 `+0.16/+0.48` 硬编码 | module 的 `PlacementSlot.local/visual` 成为唯一表现契约；renderer 按 slot 的 local/layout/gap/height/scale 绘制 | UI `betrayal:discard-settle`；同房间丢弃测试 |
| SA-53 | P1 | 房间放置时相机在每次旋转后重新取景，放置后又停在高位 | fitSignature 含预览 position/rotation；放置结束直接 fit 新图 | 放置开始时记录原相机，缓慢抬高取景；旋转不再触发 fit；确认/取消后 650ms 回到原相机 | UI matrix `betrayal:rotation-flow`: 30.7→34.7→30.7，旋转相机不变 |
| SA-54 | P1 | 房间缺乏空间感，扁平贴图无法传达山屋洋馆质感 | 仅单一 flat box 贴图，缺少建筑立面与内部摆设 | 实现 2.5D 切角双向墙体（北西高面+东南低切角）与门位门框，根据房间类型自动生成大楼梯、书架、实验台、石棺、熔炉、金库、四柱床等特色 3D 摆设 | 视觉截屏 + 129 用例通过 |
| SA-55 | P1 | 房间发现与放置生硬突兀，朝向选择依赖底部菜单 | 缺乏物理落地动效；旋转操作需在底栏点击 | 新增 380ms 缓动下落撞击落定动效；在 3D 预览板块上方渲染可直接点击的旋转环与确认绿盘 | `renderLoop` 动态缓动 |
| SA-56 | P1 | 交互重度依赖底部动作坞菜单，破坏桌游实体操控手感 | 早期安全策略（SA-28）将非 targeting 状态一刀切拦截为 inspect | 重构为上下文智能实体点击路由：点击相邻房间直接走、点击门位直接开、点击实体直接互动/攻击，同时保留安全检阅机制 | 全量 129 用例通过 |
| SA-57 | P1 | 卡牌素材过于现代扁平，不契合古旧诡秘洋馆基调 | 通用现代化单色边框与平铺背景 | 全面重构为焦边古旧泛黄羊皮纸、血渍暗斑、奥术暗纹水印、哥特双金边花框、专属预兆/遗物/事件徽记与古魔导书压金箔卡背 | 3D 场景与卡牌渲染测试 |
| SA-58 | P1 | 音效过于简陋且无动态音乐，游戏沉浸感不足 | 仅 6 种基础单音，无声景机制 | 构建全自研 Web Audio 动态声景音乐引擎：三层楼独立环境音（座钟/次低音深渊/破窗阴风）+ 5 大作祟专属动态 BGM + 全套战术音效（脚步/转轴/石板/武器） | 0 外部文件依赖，实时流式生成 |
| SA-59 | P1 | 剧本数量与剧情深度不足 | 仅 3 个初始剧本点名 | 完善现存 3 剧本叙事文案，新增 #3「活死人之夜」（圣水调配/圣化仪式/僵尸潮）与 #5「月圆狂兽」（打造银弹/月相压制/嗜血扑击）两大剧本 | 黑盒矩阵 35 seed-runs 2980 动作 100% 通过 |
| SA-60 | P0 | **相邻房间墙体/基座互相插入并出现渲染闪烁（z-fighting）** | 底座外沿用 `size+0.04`、门槛板 `THICK+0.05`、门楣横梁 `THICK+0.07`、屋顶线脚 `len+0.012`，几何最远到 ±1.445；而棋盘格距 2.86、板块半宽 1.42，相邻板块近边在 1.44 —— 两块基座在 `y∈[0,0.03]` 上共面重叠 0.005~0.025 | 全部收进板块footprint：底座 `size-0.02`、门槛与门楣取 `THICK`、线脚去掉 0.012 出挑、角柱内缩到 ±1.335。`scripts/probe-overlap.mjs` 实测 14 个房间包围盒均 ≤ ±1.420，相邻板块留 0.02 净距 | `node scripts/probe-overlap.mjs` → `No room bleeds past its tile footprint.` |
| SA-61 | P1 | 玩家/怪物棋子比例失控，一人多高盖住家具 | 通用 meeple 高约 0.9，而室内净高仅 0.42 | 新增 `TokenMeshBuilder.createCharacterMiniature()`：圆底座+黄铜圈、锥形斗篷、头部与帽檐，总高约 0.29；叛徒带兜帽与余烬眼、怪物加驼背与红光眼；站位改到房间中心 0.3 半径内 | 主卧/图书馆截图；棋子不再遮挡床与扶手椅 |
| SA-62 | P1 | 相机自动取景距离过于保守，整桌只占画面约一半 | `max(span)*1.22+6`，与 FOV/宽高比无关 | 改为按真实垂直/水平 FOV 反解距离（Z 向按俯角压缩），并保留"不主动拉近用户已选距离" | 整桌截图棋盘占满画幅 |
| SA-63 | P1 | 三维内核检查器默认展开，遮挡三分之一棋盘 | 面板 `collapsed=false` | 改为默认折叠，按钮不再默认高亮；`I` 键仍可展开 | HUD 截图 |
| SA-64 | P1 | 全屋无局部照明，暗房间里家具细节不可读 | 仅全局平行光 + 中央吊灯 | 新增跟随相机焦点的"检视灯"：随相机距离在紧凑聚光与大面积洗墙之间插值，并按 `1/d²` 补偿强度 | 房间特写与整桌截图 |
| SA-65 | P1 | 家具会挡门口 / 堵死通道 | 早期硬编码摆件无门位概念 | 新增 `render/procedural/roomLayout.ts`：门廊禁区（0.92×0.58）+ 精确 AABB 互斥 + 连通性洪水填充（每个门必须互相可达），座椅围绕主桌生成 | `layout: furniture never blocks a doorway...`、`probe-layout.mjs` 0 门位冲突 |
| SA-66 | P2 | 墙面完全空置，房间缺少"宅邸"的居住感 | 只有家具，没有任何壁面陈设 | 新增壁挂陈设 `portrait`（鎏金画框+暗色肖像）、`sconce`（黄铜壁烛+火光晕）、`tapestry`（织锦+纹章）；由 `decorateWalls()` 沿无门墙段确定性悬挂，遇高柜只挂高处壁烛，遇窗户自动让位 | 主卧/舞厅特写；`probe-overlap` 仍 0 越界 |
| SA-67 | P2 | 玩家看不到当前房间的叙事与在场者 | 房间文本 `props.text` 只存在状态里，UI 没有出口 | 新增右上「房间档案」面板：中/英文名、楼层徽章、门位罗盘、印刷描述、在场英雄/怪物/遗物；`◎` 按钮经 `PresentationPorts.focusRoom` 触发镜头特写 | 整桌截图（BALLROOM 卡片）与 UI 矩阵 |
| SA-68 | P1 | 节流帧下卡牌/房间落定动画停在半空，卡片陷进地板 | `settleCard` / 房间落定完全依赖 rAF 推进补间 | 帧循环超过 120ms 未 tick 时判定为节流，直接落定到目标高度（正常帧率仍保留缓动） | UI 矩阵 `betrayal:discard-settle` cardY=0.330 > surfaceY=0.315 |
| SA-69 | P2 | 点击卡牌只能看到一个纯文本 toast，卡面信息（类别/次数/可交易）全部丢失 | `pickTarget` 对实体只发 `title + desc` 字符串 | `UiNotice` 增加可选 `card: UiCardDetail`；HUD 渲染**做旧羊皮纸卡牌浮层**：牌型色带（预兆=酒红/遗物=赭金/事件=铅灰）、火漆印章、英文副标题、描述正文、事实表（类别/剩余次数/不可交易/随从） | `scripts/shoot-card.mjs` 三种牌型均 `sheet=open` |
| SA-70 | P2 | HUD 是冷调深蓝石板色，与山屋的烛光羊皮纸基调冲突 | 全站共用一套 slate 主题 | 新增 `theme-gothic.css`：`[data-theme="gothic"]` 覆盖 `--ink/--panel/--text/--muted` 等变量，并单独调校顶栏、游戏胶囊、角色卡、动作坞；HUD 按 `gameId === 'betrayal'` 自动挂载 | 舞厅/卡牌截图；其他四款游戏不受影响 |
| SA-71 | P1 | 枝形吊灯悬在半空（洋馆剖面没有天花板），读起来像穿模 | `chandelier` 是 `ceiling` 摆件，固定挂在 y=0.95 | 重构为**落地六臂烛台**：三脚底座、车削灯柱、环形灯盘、六条托臂与烛焰，高 0.7；改为 CENTER 摆件参与布局碰撞 | 舞厅截图；`probe-layout` 166 placed |
| SA-72 | P2 | 衣柜是一整块封闭方块，近看没有任何信息量 | 双门全闭，内部为空 | 衣柜重做：柜体分板 + 内部隔板与挂衣杆 + 三件外衣 + 叠放织物；**右门以 26° 半开**露出内部，开门方向纳入占地深度（depth 0.4）避免与邻件穿插 | 主卧/客房特写；`probe-overlap` 0 越界 |
| SA-73 | P1 | 点击房间只是弹一条 toast，右侧房间档案不会跟随 | 检查操作不产生 state 变更，HUD 只在快照刷新时重绘 | `UiNotice` 增加 `roomId`；点击房间房间即"钉住"档案并立即重绘（不依赖快照），角色换房时自动解除钉住 | `scripts/tmp-pin` 实测 舞厅 → 点击门厅 → 卡片切到门厅，`◎` 镜头移入 |
| SA-74 | P2 | 门厅是每局第一眼看到的房间，但只有 4 件小摆设，空旷 | 起始房间与普通房间共用同一套摆件清单 | 新增 `addFrontDoor()`：石质门套 + 大理石过梁 + 黄铜压顶 + 双扇实木门（竖向拼缝、铁铆钉阵、双铁门环、中央锁梁与黄铜锁芯），高度超出剖切矮墙以暗示楼层继续 | 门厅特写；`probe-overlap` 0 越界 |
| SA-75 | P2 | 书柜三层层层都是等高同色的书脊，读起来像贴图不像书 | `bookRow()` 生成等宽等高的书列 | 书柜重做分层内容：底层密排 + 一本斜靠；中层短列 + 横放书堆 + 黄铜书立 + 大理石胸像；顶层稀疏 + 铜烛台 + 横放卷轴；另加顶部线脚 | 图书馆特写 |
| SA-76 | P2 | 三间卧室陈设雷同（床 + 衣柜 + 床头柜） | 缺少年代感的梳妆家具 | 新增 `chestOfDrawers`：四层抽屉（黄铜拉手 + 锁孔）、顶部倾斜镜（乌木框 + 暗玻璃 + 双侧立柱）、香水瓶与发刷；接入 master_bedroom / bedroom / nursery | `probe-layout` 三个房间均 5/5 落位 |
| SA-77 | P2 | 鼠标悬停房间没有任何提示，玩家不知道能不能点 | `onInteractiveHover` 在 main.ts 里被接成空函数 | 新增顶部悬浮芯片 `showHoverHint()`：悬停房间显示"房名 · 点击查看房间档案"，悬停门位/卡牌/骰子各有对应文案 | `scripts/tmp-hover` 实测 `on:true text:舞厅点击查看房间档案` |
| SA-78 | P1 | **悬停任一房间会让整桌所有房间一起发亮** | 房间按材质合并且共享全局调色板，`applyHoverHighlight` 直接改 `material.emissive`，等于改了所有引用者 | 悬停时对 `userData.shared` 材质做**克隆替换**（记录 original 以便换回，克隆随 hover 结束 dispose）；非共享材质仍走原地 tint | `tsc` + UI 矩阵；悬停不再外溢 |
| SA-79 | P2 | 探索出新房间时只有一行日志，缺一个"翻开板块"的仪式感 | 房间揭示没有任何表现层反馈 | 新增房间揭示浮层 `maybeRevealRoom()`：HUD 自己 diff 房间 id 集合（首帧只登记不演出），新板块以居中羊皮纸卡呈现——房名/英文名/印刷描述/楼层/已连通门位/符号，配 `room-reveal-in` 入场动画与 7s 自动收起；切夹具时重置已知集合 | `scripts/tmp-reveal` 实测 `rooms 14 → 15, reveal:true, 花园 / 房间·ROOM / N·S / 事件 ✦` |
| SA-80 | P2 | 作祟触发的瞬间只有音效和一行文字，缺少整局最重要转折的呈现 | 无作祟过场层 | 新增全屏过场层 `maybeShowMoment()`（Step 2b-1 起幕布文案由游戏的 `describeMoment` 声明）：暗红径向晕影 + 闪烁的 `THE HAUNT BEGINS` + `HAUNT No.xx` + 大字标题 + 分隔菱形 + 背叛者姓名 + 当前视角目标（`mission` 已按角色投影）+ 点击/9s 关闭。剧本直开时首帧只登记不重播 | 过渡触发实测 `木乃伊苏醒 / 背叛者·公牛奥克斯 / 目标文案` |
| SA-81 | P1 | 摆放房间时布局变化（楼层自适应偏移、底板扩展、门位连通与UI展示）滞后到放置完成才更新 | `computeAutoLayerOffsets`、`projectForDisplay` 以及 `floorAnchorsFor` 只计算已落入图中的节点，预览中的待放房间被忽略；且旋转时 boardKey 不变跳过底板重绘 | 1. 投影时注入虚拟预览节点 `__placement_preview__`，楼层自适应偏移与桌面底板在预览阶段即完整容纳新房间，落块确认时零跳变零突兀；2. 3D 与 UI 实时计算并高亮门位连通（动态翡翠连通踏板、门洞光环、探索箭头、面墙阻挡标记）；3. 预览阶段 HUD 房间档案与底栏实时呈现待放房间详情与旋转罗盘 | `scripts/verify-placement-live.mjs` 实测通过；UI 矩阵通过 |
| SA-82 | P0 | 剧本预置房间未从房间牌堆剔除，导致探索时重复抽取已存在房间，放置时被拒绝并误报「该朝向无法接上入口门」 | 剧本 `addExploredRoom` 仅向地图图结构添加节点，未将实体从 `zone_room_deck` 移出；且 `drawRoomCandidate` 未校验节点是否已存在于地图中；`rules.placeDrawnRoom` 将所有放置失败一律误报为门位朝向错误 | 1. `addExploredRoom` 自动将预置板块从牌堆移至 `zone_room_placed`；2. `drawRoomCandidate` 抽牌时检测地图节点存在性，已存在则自动移出并跳过；3. `placeDrawnRoom` 准确校验并提示重名房间，避免误导玩家朝向问题 | 实测二楼平台南门探索成功抽中新房间并顺利落块；全量测试矩阵通过 |
| SA-83 | P1 | 卡坦岛六边形网格方向错位30°，且浮点哈希分流导致 7 处共面重复顶点与 13 条重叠交替道路 | 1. `HexTileBuilder` 误加 `rotation.y = Math.PI / 6`，使尖顶朝向的六边形几何偏转成平顶，导致相邻板块尖角互相切入 0.288 空间穿模；2. `generateCatanHexDualGraph` 的 `roundKey` 在 `z=-1.075` 处产生 `±5e-16` 浮点误差分别舍入到 `-1.07` 和 `-1.08`，导致 54 个顶点被分裂成 61 个，道路从 72 变成 85 条产生交叉重叠 | 1. 移除 `HexTileBuilder` 多余的 30° 旋转，使 3D 网格角点精准对齐图顶点与正北；2. 改用空间距离阈值（`< 0.05`）聚类顶点，顶点精准回归 54 个、道路 72 条，完全消除了道路重叠与定居点交替问题 | 单元测试通过；`scripts/tmp-test-catan-fixed.mjs` 断言 54 顶点/72 边；UI 矩阵通过 |
| SA-84 | P1 | 山屋惊魂移动房间依赖动作栏菜单弹窗，缺少实体级直觉导航 | 移动动作仅挂在 HUD 动作栏，3D 房间门洞无直观引导，点击房间仅触发查看 | 1. 为当前行动者所在房间的所有门孔生成地面高亮导航标记（已连通门展示翡翠色双向光斑与箭头、未开启门展示金色探索箭头）；2. 点击地面箭头或门框直接走入相邻房间（`MOVE_TO_ROOM`）或开启探索，无需再从底部菜单选择；3. 悬停显示直接走入提示，保留非门位区域的点击查看功能 | `scripts/verify-nav-arrows.mjs` 实测三步连环走位；UI 矩阵通过 |
| SA-85 | P1 | 事件与人物行动发生过即消失，玩家无法回看"刚才发生了什么" | 内核 `VisualTraceEvent` 只做即时 toast，没有留存任何历史 | 新增近期动态面板 `renderHistory()`：session 侧维护 60 条环形缓冲 `snapshot.history`（事件流 + 属性变化），HUD 右下角渲染可按类别着色的行（伤害红/移动蓝/探索金/卡牌紫/作祟深红），带回合戳 `R1·T2`、数值增量徽章与可折叠头部；点击标题在 3 行摘要与 18 条完整列表间切换 | `scripts/verify-feedback.mjs` 断言 `history=1 rows=1` 且折叠生效 |
| SA-86 | P1 | 受伤/属性变化只有一条小 toast，视觉与听觉强度远不足以让玩家察觉 | 伤害反馈仅靠 `DAMAGE_EFFECT` 文字提示；属性阶梯是静态渲染，变化瞬间无任何动效 | 新增五重反馈闭环：1. session 在 `rebuild()` 末尾 diff 每名角色的 `traitIndex`，产出带 `from/to/delta/damageKind/lethal` 的结构化 `UiTraitChange`（在快照发布后投递，保证 HUD 动画作用于新数值）；2. 全屏边缘染色（物理血红 / 精神紫 / 治疗绿）+ 角色卡横向抖动与描边脉冲；3. 对应属性阶梯的实心格闪红、数值徽标放大回落；4. 角色卡上浮 `神智 -2` 徽章，同时通过 `PresentationPorts.showTraitChange` 在 3D 缩影头顶投射世界坐标浮动数字（随相机每帧重投影）；5. 音效按物理/精神/治疗分别触发 `playCombat` / `playItemPickup` | `scripts/verify-feedback.mjs` 实测 `screen-hit mental / trait-hit / flash-down / trait-burst 神智 -2 / label-burst 神智 -2 / feed kind-damage` 全为真 |
| SA-87 | P1 | 地面导航箭头只覆盖同层相邻门位，跨楼层与房间特性移动仍须回到底部菜单 | `addSpecialTraversalHints` 不存在；楼梯是同格跨层边（`STAIRS`）、露台/楼座是单向 `DROP` 边、煤槽需绳索回攀、神秘电梯可达任意已探索房间，这些都不在同层 grid-delta 判定范围内 | 新增 `addSpecialTraversalHints()`：在行动者所在房间渲染发光徽章——`⬆上楼/⬇下楼`（STAIRS 边）、`⬇跳下`（DROP，落到舞厅）、`🪢攀绳`（持绳回攀）、`🛗乘电梯`（启动停靠面板）；并把 `pickTarget` 的 `SPECIAL_MOVE` 分支接上 `JUMP_DOWN` / `CLIMB_UP` / `USE_ELEVATOR`。徽章门槛与规则一致：跳跃/楼梯/攀绳/电梯都需剩余移动力，与内核 `if (movesLeft > 0)` 判定对齐，避免"看得见却点不动" | `scripts/verify-special-moves.mjs` 实测 `stairs badges=3 up/down → room_upper_landing/UPPER`、`balcony jump → room_ballroom/GROUND`、`elevator badge=true`；电梯停靠面板另有 13 处可选目标 |
| SA-88 | P1 | 点击房间走入相邻房间被内核拒绝（`illegal action "MOVE_TO_ROOM"`） | `pickTarget` 在派发 selection 绑定动作时额外附加了 `targetNodeId`，改变了 canonical binding，`sameBinding` 比对失败 | 改为只传 `targets`；特殊移动同理，仅 `CLIMB_UP` 这种规则本身要求 `targetNodeId` 的动作才附带该字段 | `scripts/verify-feedback.mjs` / `verify-nav-arrows.mjs` / `verify-special-moves.mjs` 三处均实测通过 |
| SA-89 | P2 | 金库只能靠「进入房间」被动触发，房间特性没有可点击入口；煤槽/坍塌这类入内危险在踏入前完全不可见 | 「VAULT」的开锁逻辑写死在 enterRoom() 的进入副作用里，玩家无法主动再试；「COAL_CHUTE」/「COLLAPSED」/「FURNACE」只在踩进去之后才造成伤害，没有任何前置提示 | 1. 抽出 crackVault() 供进入触发与主动点击共用，并新增 ROOM_FEATURE 动作（未开启金库房放出，useRoomFeature() 处理），检定掷骰与「锁芯纹丝不动」失败提示都进事件流；2. 3D 场景为未开启金库挂「🗄 撬开金库」可点击徽章，为煤槽/坍塌/熔炉挂 ⚠ 被动危险标记；3. 新增 room_features 剧本（煤槽+金库+神秘电梯+坍塌之室同场，刻意不给绳索与骷髅钥匙）使这些特性可演示与自动化验证 | scripts/verify-special-moves.mjs 的 features 段实测 badge/label/click 全为真；pnpm test:matrix 因新剧本从 35 seed-runs 扩到 37、2980 → 3180 actions 仍全绿 |
| SA-90 | P2 | 确认放置房间后镜头只是「切回原位」，人物已走进新房间但画面仍盯着旧构图 | endPlacementCamera() 直接 copy 回 prePlacementCamera 的 pose 并 return，没有任何跟随逻辑；而 actorFocusPoint 若读 meeple 会拿到尚未重建的旧坐标（renderEntities 在 endPlacementCamera 之后才跑） | 1. 回位仍用瞬时切（保留后台标签掉帧时不悬在半空的保证），随后用 panToKeepBearing() 做 420ms 平移动画：保持 bearing 与相机→目标距离不变，只把 orbit target 滑到人物所在房间（读投影态节点而非 meeple，避开重建时序）；2. skipFitUntil 同步延长，避免自动取景与 pan 抢镜；3. 同步更新 UI 矩阵 rotation-flow 断言：从「pose 必须完全一致」改为「高度回位 + 已平移到人物」 | scripts/verify-placement-camera.mjs 实测 distance 36.026→36.026、bearing dot=1.00000、target 落在 room_garden、中段采样证明在动画；test:ui 输出 cameraY=22.3→26.3→22.5 pan=0.42 |
| SA-91 | P2 | 角色在房间之间走动时镜头纹丝不动，人物可能直接走出视野 | 摄像机只在「放置房间结束」时跟随一次（SA-90），普通 MOVE_TO_ROOM / 特殊移动 / 电梯都没有跟随逻辑 | 新增 followActorIfMoved()：每次 syncState 记录 lastActorRoomId，行动者换房且当前没有镜头补间、且已越过 skipFitUntil 时，用同一个 panToKeepBearing() 做 460ms 平移（保持 bearing 与相机→目标距离）；首帧只登记不演出，避免开局就把镜头从整盘取景拉到人物身上 | scripts/verify-actor-follow.mjs 以插桩方式断言两次行走各产生一次 pan、落点分别为前厅(0,-2.86)与大楼梯(0,0)、距离 36.026 不变、bearing dot=1.00000、闲置 sync 不漂移；test:ui 与 verify-placement-camera 均回归通过 |
| SA-92 | P2 | 放置新房间时镜头拉远到整盘取景，玩家看不清正要摆放的那块板 | beginPlacementCamera() 先调 fitCameraToBoard() 按整盘包围盒取景再抬高 12%，待放板块在画面里很小，门位朝向难以辨认 | 改为以**待放房间为中心**取景：orbit target 直接落在 preview 坐标，沿玩家当前 bearing 收紧臂长（≤15）并抬高视点（相机 y 不低于原高度 +3.4，且方向向量 y 分量至少 0.72 以形成俯视），旋转时不再重设相机 | scripts/verify-placement-framing.mjs 实测 target=previewPos、cameraY 21.71→26.81、dist 36.03→28.84、旋转不重设、确认后控制权归还并平移回人物；test:ui cameraY=22.3→27.4→22.5 |
| SA-93 | P1 | 楼层选择只有相机移动，不可见楼层仍在 3D 渲染且缺乏全局小地图（AI-21/AI-27） | 1. 3D 场景缺乏楼层隔离机制，三层同时渲染相互穿插/遮挡且浪费 draw call；2. 缺乏洋馆三层建筑总览视口与角色位置指引 | 1. 在 scene.ts 实现 3D 楼层隔离过滤（setVisibleFloor/applyFloorFilter）：为房间、门、箭头、标记、地毯、底板与实体标记楼层，单层模式下隐藏其他楼层，同时 raycaster 严格过滤层级可见性防止拾取穿透；2. 在 hud.ts 实现洋馆总览小地图组件（mansion-minimap）：按 2F/1F/B 建筑立面切片呈现 SVG 微缩房间蓝图、探索者与怪物位置点，支持展开/收起；3. 小地图与底部 floor-tabs 双向 100% 联动，点击即平滑对焦并隔离该楼层，角色跨层移动时自动跟随切换楼层 | scripts/verify-floor-isolation.mjs 实测：切至 GROUND 绘制调用从 549 降至 238（-56.6%），切至 UPPER 降至 140（-74.5%），其他层全部隐藏且无法被拾取，恢复 ALL 全部恢复 549，小地图与底栏完全同步；全部 7 项测试矩阵通过 |
| SA-94 | P1 | 从大楼梯上二楼后二楼平台没有下楼箭头，同理地下平台也没有上楼箭头 | `addSpecialTraversalHints` 遍历图边时硬编码了 `if (from !== nodeId) continue`，而 `connectRooms` 建立的楼梯边是双向无向边（`edge_room_grand_staircase_room_upper_landing` 的 `from` 是一楼大楼梯），导致角色在二楼（`to === nodeId`）时完全匹配不到边，无法生成下楼箭头；且旧代码用 `other.props.floor === 'UPPER'` 判断上下，导致地下室回一楼时方向会被误判为下楼 | 1. 重构边双向匹配：若 `from === nodeId` 目标为 `to`，若 `to === nodeId` 且无向则目标为 `from`；2. 建立 `FLOOR_LEVEL: BASEMENT=0, GROUND=1, UPPER=2` 绝对层级判定，精准判定 `targetLevel > currentLevel` 为上楼、反之为下楼；3. 将徽章文本 sprite 也一并注册入交互拾取，扩大点击命中范围；4. 扩展 `scripts/verify-special-moves.mjs`：增加大楼梯 ↔ 二楼平台双向往返、大楼梯 ↔ 地下平台双向往返端到端实测断言 | `scripts/verify-special-moves.mjs` 实测：`hasDownFromUpper=true -> room_grand_staircase/GROUND`，`hasUpFromBasement=true -> room_grand_staircase/GROUND`，全量测试矩阵全绿 |
| SA-95 | P1 | 切换游戏时 3D 棋盘与部分 UI 不自动刷新，且浏览器 URL/Title 不更新 | `scene.ts` 中计算 `boardKey` 遗漏了 `gameId`（仅使用 viewer:log:clock:placing:highlights），导致卡坦岛、三国杀、山屋等不同游戏初始状态（log=0, clock=0）算出的 `boardKey` 完全相同，`syncState` 判定 `!boardChanged` 直接跳过重绘；且切换游戏时未通过 `history.replaceState` 同步 `?game=` 参数 | 1. `boardKey` 前缀显式纳入 `state.gameId`；2. 增加 `scene.resetForNewGame()` 在切换游戏时彻底清理缓存 key 与楼层状态；3. `switchGame` 与 `restartScenario` 动态更新浏览器 URL 参数与 `document.title`；4. `hud.setPresenter` 自动清理前一游戏的卡牌详情层（`#card-sheet-layer`）与浮层状态 | `scripts/verify-switch-and-placement-camera.mjs` 完整实测 Catan -> Sanguosha -> Betrayal -> Catan 环路切换，3D 网格数量（73 -> 4 -> 5 -> 73）与 URL/Title 100% 自动同步，零残留 |
| SA-96 | P2 | 放置房间确认后镜头先突兀跳切回开门前旧位置再平移，破坏视线连贯性 | `endPlacementCamera()` 强制调用 `camera.position.copy(previous.position)` 和 `controls.target.copy(previous.target)`（即放置前老房间视点），然后再调用 `panToKeepBearing` 平移到新房间角色，产生明显的倒退跳切顿挫 | 彻底移除倒退回 `previous.position/target` 的跳切逻辑：以新房间角色位置（`focus`）为观察中心，应用进入放置前的视距与相机相对高度差（`normalOffset`），从设置房间时的拉高俯视点直接平滑过渡拉近落定到新房间角色，视线始终聚焦新房间，无任何跳退顿挫 | `scripts/verify-switch-and-placement-camera.mjs` 实测：确认放置后 target 保持在新房间角色（误差 0.00），与旧房间距离 2.86（证明从未跳回旧位置），相机高度从俯视 26.6 平滑拉近落定至常规 21.71，控制权自动恢复 |
| SA-97 | P1 | 上帝视角或换人时镜头不自动对焦到下一个行动者所在位置 | `followActorIfMoved` 未追踪 `lastActorId`，且行动者读法仅支持玩家未覆盖怪物（`npcs`）；遇到 `skipFitUntil` 计时器时过早覆盖了 `lastActorRoomId`，导致后续帧判定为无变化而放弃对焦 | 1. 显式记录并追踪 `lastActorId`，行动者切换事件（回合交接）享受最高对焦优先级，平滑飞向新行动者房间；2. 行动者查找同时支持 `state.players` 与 `state.npcs`；3. 未换人但换房遇到动画锁定时暂缓消费房间，保证重试不漏帧；4. 单层隔离模式下跨楼层交接自动切换当前层 | `scripts/verify-room-rules-and-turn-camera.mjs` 实测：p1 -> p2 距离 0.00，p2 -> p3 距离 0.00 零误差自动平移对齐 |
| SA-98 | P1 | 房间 debuff 生效时机混淆（进入即生效 vs 停留结束回合生效 vs 离开限制） | 旧实现将熔炉灼伤、邪恶房间神智检定全部错误塞在 `enterRoom` 里，导致角色仅仅路过或穿行就被扣血，严重违背实体桌游规则；煤槽也仅给伤害未实现滑梯效果 | 1. 严格区分为三大生效时机：【进入生效】坍塌之室速度检定坠落、煤槽（无绳扣血并真正滑落至地下平台）；【停留结束回合生效】新增 `settleRoomEndTurnDebuff` 并在 `endTurn` 调用，熔炉房仅在停留结束回合时灼伤（路过免伤），五芒星/地窖等仅在停留结束回合时神智检定；【离开限制】门厅大门作祟前锁死；2. 3D 危险标记精细化为「停留灼伤/滑落地下室/入内速度检定」 | `scripts/verify-room-rules-and-turn-camera.mjs` 实测：进熔炉房 might=5 保持不变，在熔炉房点击结束回合 might 从 5 降至 4；进煤槽滑落至地下平台 |
| SA-99 | P1 | 误导性历史文案「没有对应朝向板块」导致朝向误解，且牌堆抽空后未重洗弃牌堆导致无法探索 | 历史遗留文案 `没有可用的 ${dir} 向板块` 严重误导玩家以为卡牌指定了固定朝向，实际朝向完全由 0/90/180/270 旋转决定；且抽到其他楼层被弃置的板块从未重洗回牌堆，牌堆抽空后即便有空位也无法继续探索 | 1. 修正文案为精准描述「该楼层的房间板块已全部探索完毕」；2. 增加弃牌堆自动重洗机制（Reshuffle）：当 `zone_room_deck` 抽空且弃牌堆有牌时，自动通过确定性 PRNG 洗回牌堆；3. `RoomDef` 支持多楼层放置配置（`floors`） | `scripts/verify-room-rules-and-turn-camera.mjs` 实测：牌堆被抽空后进行探索，弃牌堆 34 张牌自动重洗回牌堆并成功开启探索，错误为 0 |
| SA-100 | P1 | 山屋持续诅咒（滴血之声/恶灵附体/刺骨寒意/萦绕旋律/恐惧印记）以散装字符串数组存在 `customProps.effects`，内核 `EffectInstance` 槽位形同虚设：无过期、无可见性投影、无统一增删入口 | 模块自写 `player.customProps.effects = [...new Set(...)]`，读取端手写 if/else 链；内核已具备 `GameState.effects` + `expireEffects()` + `observer` 可见性投影，但无任何模块使用 | 1. 新增统一入口 `addEffect`（id 由 kind + payload.effect + target 派生，重复施加幂等、不同诅咒共存）、`removeEffects`（按谓词批量移除并返回计数）、`effectsOn`（合并内核列表与旧字段）、`ongoingEffectKinds`；2. 事件卡 `ONGOING` 分支改为写 `GameState.effects`，模块只解释 `payload.effect`；3. `startOfTurn` 改读 `ongoingEffectKinds`，旧 `customProps.effects` 保留只读兼容，保证迁移前日志可重放；4. 新增两条回归：单元级（两种诅咒共存/重复施加幂等/移除计数/旧字段兼容）与端到端（`drip` 事件卡经真实探索流程注册内核效果实例） | `pnpm test` 由 131 升至 **133 passed / 0 failed / 0 boundary violations**；`pnpm test:matrix` 3166 actions 回放哈希不变；`tsc` 0 错误；`pnpm build` 通过；山屋端到端 `verify-special-moves` 与 `verify-room-rules-and-turn-camera` 均通过 |
| SA-101 | P0 | 活死人剧本中怪物（NPC）完全无法移动：点击「怪物移动」返回成功但怪物纹丝不动，且怪物回合没有地面导航箭头 | `moveNpc` 的守卫读取 `npc.customProps.roomId`，但该字段在 NPC 注册时从未初始化（恒为 `undefined` → 空串 → `neighbors("")` 返回 `[]` → 守卫恒 false → 静默 return）；而合法性检查 `getNpcLegalActions` 读的是实体的 `custom.roomId`，两处事实来源不一致。渲染层同样读 `activeActor.customProps.roomId` 定位怪物，因此怪物回合也画不出导航箭头、镜头无法跟随 | 1. 以**怪物实体为唯一事实来源**：新增 `monsterRoomId()`，`moveNpc` 守卫改读实体房间；2. 移动后把目标房间回写到 `npc.customProps.roomId`，并在 NPC 注册时初始化为出生房间，使渲染层的行动者查找对怪物与玩家一致；3. 新增回归 `NPC movement actually relocates the monster and spends a move`（实体房间真的变了 + 移动力 -1 + NPC 记录同步）与端到端 `verify-zombie-fixes.mjs` | `pnpm test` 136 通过；`verify-zombie-fixes.mjs` 实测 `entityRoom === npcRoom === room_pentagram_chamber`、`navHotspots=6`；`test:matrix` 因怪物真正参与行动，动作数由 3166 变为 3089（预期行为变化，回放哈希仍一致） |
| SA-102 | P0 | 活死人剧本中所有英雄死亡后游戏卡死：右侧动态已提示「所有英雄都已死亡或被带走」，但底部动作坞只显示「暂无可执行的合法动作 — 等待其他玩家」，玩家误以为流程卡住 | `checkWinCondition` 确实返回 `gameOver` 并推送了 ANNOUNCEMENT，但**终局覆盖层只对网络对局实现**（`main.ts` 中 `snapshot.gameOver && this.netOptions`）；单机/GOD 模式下 `gameOver` 为真却没有任何呈现，动作坞落入通用空态文案 | 1. 内核在结局触发时把 `outcome.reason` 写入新增可选字段 `GameState.winnerReason`（tick / finalizeTransition / 决策三条路径），并经 `observer` 投影到快照；2. `main.ts` 新增 `showLocalGameOverOverlay()`：显示胜者 + 结局原因 + 「再来一局 / 关闭」，用 `activeScenario` 记住当前剧本以便重开；3. 动作坞在 `gameOver` 时改显示「对局已结束 — 胜者：X · 原因」；4. 新增回归 `a finished haunt reports the reason so the UI can end the game` 与端到端断言 | `verify-zombie-fixes.mjs` 实测 `gameOver=true`、`winnerReason="所有英雄都已死亡或被带走"`、`overlay=true`、底栏文案为「🏁对局已结束 — 胜者：公牛奥克斯 · 所有英雄都已死亡或被带走」 |
| SA-103 | P1 | 医疗包（Medical Kit）恢复肉体时无法选择加到哪个属性，永远只加力量 | `itemFields` 中 `medical_kit` 与 `bell` 共用同一分支，只暴露 `target` 字段；reducer 里把属性写死为 `might`。同类的治疗药膏（`healing_salve`）与嗅盐（`smelling_salts`）都已提供 `trait` 选择，医疗包是唯一遗漏 | 1. 拆分 `medical_kit` 与 `bell` 的字段定义，医疗包在 `target` 之外新增 `trait` 枚举（力量 / 速度）；2. reducer 读取 `payload.trait` 并传入 `healToGreen`，提示文案带上实际恢复的属性名；3. 新增回归 `medical kit lets the healer choose which physical trait to restore`（断言字段暴露两条肉体轨道、选择速度后速度索引恢复到绿色、力量保持不变） | `pnpm test` 136 通过（+3 新回归）；实测选择速度后 `traitIndex.speed` 3→5（回到绿色），`might` 不变；`tsc` 0 错误；`test:ui` 13 屏全绿 |
| SA-104 | P1 | 检定是原子一次派发：掷骰前无法声明修正、掷骰后无法响应，幸运道具（幸运石/幸运兔足/天使羽毛）由内部策略**自动**消耗，玩家失去选择权（AI-24） | `rollTraitCheck()` 把「掷前加成」与「掷后补救」全压进同一次 dispatch，注释直言「Manual timing is collapsed into an automatic policy」；内核虽有中断栈但那是为响应牌设计的，不适用于「同一检定内的两阶段」 | 1. 新增内核通用原语 `packages/kernel/src/rollWindow.ts`：`RollWindowManager` 提供 `open / current / optionsFor / actorsFor / pick / record / amend / resolve`，阶段 `DECLARE → REACT → RESOLVED`；内核只保存生命周期与记账，**选项 id 及其效果全部留在模块侧**；2. `GameState.rollWindows?: RollWindow[]` + `invariants` 校验（重复 id、未知 actor、选项越界、重复选取、DECLARE 阶段不得已有结果、非有限 total）；3. 山屋接入：金库知识检定在**拥有幸运道具时**开启窗口——`DECLARE` 可声明天使羽毛、`ROLL_CHECK` 掷骰、`CHECK_REACTION` 用幸运石/兔足、`RESOLVE_CHECK` 结算；**无道具时保持原单次结算**，旧行为与回放哈希不变；4. 窗口存在期间 `getLegalActions` 只放行窗口动作，且 `RESOLVE_CHECK` 恒可用，保证不会死锁牌桌；5. 动作文案使用模块在 payload 里附带的 `label`，表现层不引入游戏内容 | `pnpm test` 137 → **141 passed / 0 failed / 0 boundary violations**（新增 4 条：内核两阶段生命周期、坏状态拒绝、有道具走两阶段、无道具单次结算）；`pnpm test:matrix` 3166→3089 actions 不变（与上一版一致）且回放哈希全绿；`scripts/verify-roll-window.mjs` 实测 UI 三阶段：`掷骰检定/结算检定` → `检定响应 · 幸运石/结算检定` → 恢复常规动作，动态流依次为「开始撬金库」「知识检定 3 vs 6」「幸运石让结果 +1」「锁芯纹丝不动（检定 4 vs 6）」 |
| SA-105 | P1 | 表现层没有设计令牌：颜色/字号/间距/圆角全是散落字面量，`styles.css` 里 167 处硬编码 px 字号、全文仅 1 处 `clamp()`，主题靠 70 行组件级 `[data-theme="gothic"] .xxx` 覆盖，改一处无法预判影响面（AI-24 之后的 UI 架构升级 Phase 1） | 组件直接写死数值，没有分层；主题必须伸进每个组件选择器才能换肤，新增组件就得再补一段 gothic 覆盖 | 1. 新建 `apps/web/src/ui/tokens/`：`primitives.css`（色阶/间距/圆角/8 级流体字号/字重/时长/阴影）→ `semantic.css`（surface/text/border/accent/status/type-role/gap，135 个令牌）→ `themes.css`（**只覆盖语义层**，34 个主题可覆盖令牌）；2. 192 处 `font-size` 全部改为 `var(--type-*)`，CSS 硬编码 px 字号归零，阶梯下限 12px；3. 160 处组件规则从旧别名迁移到语义名并删除别名块；4. `theme-gothic.css` 由 70 行组件覆盖压缩到 6 行，顶栏/品牌标/角色卡/行动键/行动坞改为消费 `--gradient-*` 语义令牌；5. 修掉 3 个从未定义的令牌引用（`--gold-mid`/`--mono`/`--text-dim`，无 fallback 故声明无效） | `pnpm test` 141 passed / 0 failed；`pnpm test:matrix` 3089 actions 回放哈希全绿；`pnpm test:ui` 13 屏 78 点击全绿；`pnpm probe:ui` 7 档视口（16:9/16:10/3:2/4:3/平板竖屏/手机）全绿；新增 `pnpm probe:tokens` 断言无 px 字号、无「别名指向主题可覆盖令牌」、无未定义引用，并用注入法验证该守卫会真实报错；实测主题切换生效（gothic `.pc-name` = rgb(239,230,212)，slate = rgb(237,239,243)） |
| SA-106 | P1 | 面板布局靠绝对定位 + 手算偏移：41 条 `position:absolute`，右侧三块面板各写死 `top`（小地图假设房间卡 ≤212px），且行动坞 `width: min(920px, calc(100vw - 840px))` 在窄于 840px 时算出负值被钳成 0，实测 iPad/iPhone 上为 0×495（UI 架构升级 Phase 2） | 面板不参与文档流，位置靠人手算，内容一高就重叠；宽度表达式含视口减法，窄屏必然为负；没有 shell 概念，三端形态无从表达 | 1. 新增 `apps/web/src/ui/layout-shell.css`：`.ui-layer.app-shell` 用 CSS Grid 命名区域 `topbar/rail/board/side`，面板成为网格项；2. 直接**删除** `styles.css` 中 6 条面板定位的 `position:absolute` 与 `top/left/right/bottom`（不是覆盖，是移除死代码），absolute 41 → 34 且剩余全部为浮层/伪元素/提示框；3. 三种 shell：桌面三栏 / 平板两栏+右侧滑出 / 手机单栏+角色栏滑出+行动坞底部抽屉；4. `@container` 按面板自身宽度重排；5. 顶栏响应式，手机端把 `scenario-switch`/`viewer-switch` **迁移**进信息面板（同一批 DOM 节点，监听器保留） | `pnpm test` 141 passed / 0 failed；`pnpm test:matrix` 3089 actions 回放哈希不变；`pnpm test:ui` 13 屏 78 点击全绿；`pnpm probe:ui` **12 个状态**全绿（7 档视口默认态 + 窄屏抽屉展开态，覆盖 16:9/16:10/3:2/4:3/平板竖屏/手机）；`pnpm probe:tokens` 通过；`tsc` 0 错误；`pnpm build` 通过 |
| SA-107 | P1 | 无障碍缺口：全文 **0 处** `prefers-reduced-motion`（28 个 `@keyframes` 无条件播放）、5 处 `outline: none` 无替代焦点指示、滑出面板无法用键盘关闭、`aria-expanded` 从未同步；令牌只有 CSS 形态，未来原生/桌面端无法复用（UI 架构升级 Phase 4） | 无障碍从未纳入自检矩阵，回归无人拦截；令牌是 CSS 变量，跨端需要另建一份数据源 | 1. 新增 `apps/web/src/ui/a11y.css`：全局 `:focus-visible` 焦点环（`!important` 覆盖既有 `outline:none`，金色主按钮改深色环）、`prefers-reduced-motion: reduce` 下动画/过渡压到 0.01ms 并移除抽屉位移、`.sr-only`/`.skip-link`；2. `hud.ts`：Escape 关闭滑出面板并归还焦点，切换按钮同步 `aria-expanded`；3. 新增 `pnpm probe:a11y`（18 项断言：对比度、可访问名称、tabIndex、真实 Tab 焦点环、Escape、reduced-motion）；4. 新增 `pnpm tokens:export` / `tokens:check`，把三层令牌导出为 W3C DTCG JSON | `pnpm probe:a11y` 18 项全绿（2 档视口 + reduced-motion）；`pnpm test` 141 passed；`pnpm test:matrix` 3089 actions 回放哈希不变；`pnpm test:ui` 13 屏 78 点击全绿；`pnpm probe:ui` 12 状态全绿；`pnpm probe:tokens` 通过；`tsc` 0 错误；`pnpm build` 通过；DTCG 导出 76 primitives / 50 semantic / 1 theme，`tokens:check` 通过 |
| SA-108 | P1 | 13 个 `scripts/verify-*.mjs` 端到端脚本**不在任何自检矩阵里**，随行动栏改版集体腐烂无人察觉（实跑：2 个直接失败、5 个状态不明）。同时 `pnpm tokens:check` 因比较行尾而报假过期（CRLF 文件 vs LF 生成） | 端到端脚本靠人工记得去跑；断言依赖「卡片有文本」「点击即执行」等已被推翻的交互假设；`--check` 直接比较原始字符串 | 1. 新增 `scripts/lib/actions.mjs`：`actionSelector` 按 `data-fan-label` 或可见文本双匹配，`clickAction`/`clickDockAction` 自动处理详情面板那一步；2. 修复 24 处文本定位、6 个「点完即断言」的脚本、`verify-roll-window` 读 `.act-label` 的断言；3. `verify-action-fan` 阈值改为对照改造前基线（349px/13.1%）而非 Phase 0 的绝对像素；4. `verify-placement-framing` 改为等待预览出现+相机静止后采样（原固定 sleep 在新增详情面板步骤后采到动画中途）；5. `tokens:check` 归一化行尾后再比较；6. 新增 `pnpm test:verify`（`scripts/run-verify.mjs`）把 13 个脚本纳入一等检查 | `pnpm test:verify` **13/13 通过**（逐个耗时可见）；runner 用注入必败脚本验证会真实报错；`tokens:check` 双向验证（内容一致→up to date；改令牌→stale）；`pnpm test` 141 passed；`pnpm test:matrix` 3089 actions 回放哈希不变；`pnpm test:ui` 13 屏 78 点击；`probe:ui` 12 状态；`probe:a11y` 18 项；`probe:layout`/`probe:overlap`/`probe:tokens` 全绿；`tsc`/`build` 通过 |
| SA-109 | P1 | 常驻面板每次快照用 `innerHTML` 整段重建，把浏览器持有的状态一并丢弃：实测活动流首行节点身份改变、标记属性丢失、焦点从 `.af-head` 落到 `body`（UI 架构升级 Phase 3 · B 方案） | 手写模板最省事的写法就是整段替换；面板里的滚动、悬停、焦点因此每帧归零 | 1. 新增 `apps/web/src/ui/dom/keyed.ts`（约 120 行，零依赖）：`reconcileKeyed` 按 key 复用节点、`reconcileKeyedPreservingScroll` 额外保持视口内容不动；2. **B1** 活动流：表头只建一次、行按 `entry.id` 复用；3. **B2** 行动扇形：行动坞骨架只建一次、卡片按 `action.id` 复用、监听器改委派只绑一次；4. **B3** 角色栏按 id 复用，小地图与房间卡改内容哈希守卫 | `pnpm probe:dom` 19 项全绿；`hud.ts` 17 处 `innerHTML` 中**无一处**是每次快照必执行的持久面板重建（12 处临时浮层 + 5 处有守卫的一次性骨架），`renderPlayers`/`renderMinimap` 已完全从列表消失；B1 实测视口 drift **0px**；B2/B3 断言用 stash 回旧实现验证均会失败；`test:verify` 13/13、`test` 141、`test:matrix` 3089 actions、`test:ui` 13 屏、`probe:ui` 12 状态、`probe:a11y` 18 项、`probe:tokens`/`layout`/`overlap` 全绿 |
| SA-110 | P1 | 键控协调器的三个实现缺陷，都由 `test:verify` 抓到而非人工发现：(1) 复用行同 key 内容变化时保留**旧内容**（动作 `a6` 从「结束回合」变「丢下「幸运石」」，DOM 仍显示「结束回合」）；(2) 改比 `outerHTML` 后**过严**，外部属性改动即判为内容变化，破坏复用；(3) 就地替换后位置游标悬空，抛 `insertBefore: node is not a child of this node` | 用「存哈希」做内容比较但未保证每次创建/刷新都写入 sig；`outerHTML` 天然包含外部添加的类名与属性；替换节点后未同步维护游标 | 1. 回到哈希比较，且**创建与刷新时都写入 sig**；2. 替换时若游标指向被移除节点则改指向新节点；3. `insertBefore` 前校验游标仍是容器子节点，否则置空；4. `probe:dom` 的扇形断言改用「快照未变的重复渲染」——`END_TURN` 会真的改变动作列表，卡片被替换属正确行为 | `verify-roll-window` 恢复通过（动作列表正确、金库两阶段窗口正常）；`probe:dom` 19 项全绿；三个缺陷均用「stash 回旧实现 → 断言失败」验证判别力；全量矩阵全绿 |

**SA-107 附注（探针自身的两个 bug）**：(1) 对比度最初把半透明渐变的**首个色标直接当背景色**，不做 alpha 合成，于是报出 `1.59:1` 这类假失败——改为从元素向上收集所有背景图层后由外向内混合；(2) 焦点环最初用程序化 `.focus()` 检测，而 `:focus-visible` 对非键盘触发的聚焦不一定匹配，导致假失败——改为真实按 Tab 键。另外 `--surface-panel` 与 `--surface-panel-solid` 在 DTCG 导出时会拆进同一分组路径，朴素嵌套写入丢掉其中一个（语义令牌数 41→50 才暴露），已按 DTCG `$root` 约定修复。 |

**SA-106 附注（两个坑）**：(1) 滑出面板用 `translateX(100%)` 停在视口外，使 `.ui-layer` 成为横向滚动容器（`scrollWidth 1052 > clientWidth 820`），点开抽屉时浏览器横向滚动导致**整个网格左移 398px**——用 `overflow: clip` 修掉；(2) 探针原对所有面板两两断言不重叠，但滑出面板必然覆盖棋盘，已改为**只对静态面板**断言不重叠、浮层单独断言在视口内；同时探针改为**必须测量抽屉展开态**，否则关闭的抽屉对探针不可见、断言空转。 |

**SA-105 附注（别名坑）**：原计划「保留 `--text`/`--muted` 等别名慢慢迁移」，实测发现别名会**静默破坏主题**——自定义属性在声明作用域内只替换一次，主题在子元素覆盖 `--text-primary` 时 `--text` 仍持根作用域值，gothic 下角色名仍是 slate 色。因此改为一次性迁移全部引用并删除别名块，并把该模式写入 `probe:tokens` 守卫。 |

---

## 5. 设计取舍（不当作 bug）

| 项 | 取舍 |
| --- | --- |
| 内核不存 3D 墙体/网格几何 | `TopologySpec` + `SpatialQuery` 只提供图与语义；墙体/端口在模块/渲染层 |
| 房间朝向不自动选择 | 玩家必须显式 `PLACE_ROOM`；超时策略暂未定义 |
| 掉落物品不是隐藏信息 | 山屋物品明置；`DROP_ITEM` 进入公开房间物品堆 |
| 无自动迁移 | `ENGINE_VERSION=3`；旧日志直接拒绝 |
| 单人 GOD 模式无权限层 | NPC controller 校验留给网络层 |

---

## 6. 持续验证方式

```bash
pnpm test              # 内核一致性 + 边界检查（257 例）
pnpm test:matrix       # 六夹具 × 多 seed × 全场景黑盒
pnpm test:ui           # Playwright UI 流程矩阵（含拖拽/旋转/落定）
pnpm probe:layout      # 47 房间家具布局与门位冲突
pnpm probe:overlap     # 房间几何是否越过板块 footprint（z-fighting 回归）
node node_modules/typescript/bin/tsc --noEmit
pnpm build
```

截图**不入库**，`shots/` 已在 `.gitignore` 中：

```bash
pnpm shots             # 自动起停 dev server，生成全部验证截图
pnpm shots betrayal    # 只跑名称匹配的套件
```

渲染 profiling：在浏览器 console 执行 `__boardGameApp.scene.getRenderStats()`；判据与后续可选开发见 [BACKLOG.md](BACKLOG.md)。

新增手测问题时：

1. 先在这里登记 `SA-xx`；
2. 尽量写一个最小黑盒/内核测试；
3. 修复后把状态改为“已修复”，保留复现描述；
4. 如果属于设计取舍，写入第 4 节，而不是删除。

---

## 7. ARCHITECTURE §14 追踪项

这里对应 [ARCHITECTURE.md](ARCHITECTURE.md) 第 14 节，自动化任务逐项推进；复杂项留在 backlog，不假装完成。

| ID | 架构项 | 状态 | 说明 |
| --- | --- | --- | --- |
| A-01 | 传输层 / WebSocket/HTTP | ✅ 设计边界 | `RoomTransport` + `RoomHttpAdapter` 已提供可接服务器的 seam；真实部署/WS 服务器属于外层，不放进内核 |
| A-02 | 动画队列未接入 | ✅ 已修复 | `session.onVisualEvent` → `scene.enqueueAnimations` → `TransactionalAnimationQueue` |
| A-03 | 每帧全量重建棋盘对象 | ✅ 设计取舍 | 放置预览已跳过重建；旧对象 dispose、阴影按需更新。当前实体规模下保留全量重建作为 correctness-first 兜底，通用 diff 记录为 A-16 |
| A-04 | payload 表单能力 | ✅ 已修复 | enum/number/boolean/string/json + `dependsOn` 条件显隐 + `validatePayload` 跨字段校验；嵌套数据走 JSON |
| A-05 | 决策超时 UI | ✅ 已修复 | `UiDecision/UiStackFrame` 暴露 deadline/remaining，HUD 显示 tick 倒计时 |
| A-06 | Room 客户端 UiAction | ✅ 已修复 | `RoomPresenter` 将投影动作 + `describeActionView` 映射为 `UiAction`，并可按 id 提交到 `GameRoom` |
| A-07 | 房间鉴权 | ✅ 已修复 | 可注入 `RoomAuthorizer`；`join(viewer, token)` 拒绝未授权；HTTP adapter 再校验 actor |
| A-08 | i18n | ✅ 设计边界 | 游戏动作标签走 `app/actionText.ts` + `app/i18n` locale registry；静态 UI/chrome 属于独立产品文案，不阻塞内核 |
| A-09 | Catan 场景布局 | ✅ 设计取舍 | `rich_action` 是确定性测试夹具；官方版图不属于内核契约 |
| A-10 | 调试 raw state 访问 | ✅ 已修复 | `window.__boardGameApp` 仅在 Vite DEV 挂载；生产构建不暴露 |
| A-11 | 高维 position / UI 投影 | ✅ 已修复 | `node.position: number[]`；`render/spatialProjection.ts` 映射为 XYZ，层沿轴分离 |

新增复杂项：

| ID | 问题 | 处理 |
| --- | --- | --- |
| A-12 | payload 跨字段约束/条件字段 | ✅ 已修复 | `validatePayload` + `ActionFieldSpec.dependsOn`；HUD 条件显隐，bot 默认值跳过隐藏字段 |
| A-13 | 全量渲染对象池化 | ✅ 设计取舍 | 当前实体规模下不做通用对象池；放置预览、dispose、阴影按需更新已优化；完整 scene diff 见 A-16 |
| A-14 | 房间客户端完整 Presenter | ✅ 已修复 | `packages/net/src/roomPresenter.ts` 复用 `actionText`，暴露 UiAction 并转发 submit |
| A-15 | 高维坐标的统一约定 | ✅ 设计取舍 | world/grid/ring 投影都支持；Catan 保留 world，不强制迁移 |
| A-16 | 通用 scene diff / 对象池 | ⏳ 复杂 backlog | 仅在 profiling 证明全量重建成为瓶颈时再做；需要 diff ownership、dispose、raycast 清理 |
| A-17 | 可插拔 ProjectionPort | ✅ 已实现 | `ProjectionRegistry` + `ProjectionPort`；默认 world/grid/ring/stack，自定义 space 可注册 |
| A-18 | frame graph / 多板图 / 3D 堆叠 | ✅ 已实现 | core `SpatialFrame`/`frameId`/`frames` + projection 组合、stack 坐标与重叠 offset；专用堆叠 mesh/遮挡属于玩法表现可选项 |
| A-19 | DOM 标签避让 | ✅ 已实现 | `render/labels` 的 DOM/SVG overlay + 纯 2D layout；房间/玩家/怪物/选中卡牌/堆叠数量，HUD 安全区避让 |
| A-20 | PlacementSlot / OccupancyIndex | ✅ 已实现 | core slot + 派生 occupancy + 容量/类型校验；山屋 room items/monsters 已接入 |
| A-21 | 拖拽/点击通用放置 action | ✅ 已修复 | `PLACE_ENTITY` + 拖拽目标 ring + 点击目标 slot + 撤销 + 手牌/房间物品扇形与顶层交互已接；无合法动作的卡牌可用自由拖拽做仅本视图的视觉挪动；多 slot footprint 仍 TBD |

