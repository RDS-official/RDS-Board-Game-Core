# 交互逻辑审查与业界操作调研

> 目的：在为「优化操作交互体验」动手之前，先把**现状交互链路**讲清楚，再把**业界常见操作范式**归纳成可对照的模式库，最后做差距分析并给出优先级路线。
>
> 性质：**只做审查与调研，不改代码。**
> 审查基线：`main`（2026-11），代码引用以 `文件:行号` 标注，行号可能随重构漂移，符号名为准。
> 最近核对：2026-11-08（实现状态见 §10）。

---

## 0. 结论先行（TL;DR）

1. **底子不差**。项目已经有一套清晰的三层交互：3D 棋盘拾取（raycaster + OrbitControls）→ 会话动作调度（`session.pickTarget`）→ DOM HUD（动作扇形 / 手持出牌 / 浮层仲裁）。相册式「悬停预览 → 点击详情 → 参数确认」和「拖拽落点高亮」都已实现，且遵循了「板上直接操作而非把动作全塞进按钮」的正确方向。
2. **真正的短板在“手感与可发现性”，不在“功能有无”**：
   - 手势语义**不统一**（点击=执行还是看详情，取决于 metadata；同一次点击在热点与普通对象上行为不同）；
   - **破坏性动作缺二次确认**，简单动作点一下就执行，误触即生效；
   - **拖拽不可取消**（无 Esc 取消），触控端缺手势反馈；
   - **快捷键几乎不可发现**（数字键、Enter、方向键没有 UI 提示）；
   - **选择/目标的两段式流程**（动作 → 选目标 → 确认）在 UI 上偏隐式。
3. **业界共识（BGA UX 指南）与本项目高度契合**：中央=共享动作、上下=全局信息、面板=私有资源；主操作区不可被遮挡；每步失败都必须说明原因；破坏性动作优先“限时确认”而非“无限撤销”。本项目的差距主要集中在**反馈质量**与**输入一致性**这两块。

---

## 1. 审查范围与方法

| 层 | 关键文件 | 关注点 |
| --- | --- | --- |
| 3D 输入 | `apps/web/src/render/raycaster.ts`、`apps/web/src/render/scene.ts` | 拾取、悬停、拖拽、OrbitControls 与拖拽抢事件 |
| 会话调度 | `apps/web/src/main.ts`、`packages/app/src/session.ts`、`packages/app/src/contracts.ts` | 点击语义、动作执行、选择/目标、放置模式 |
| DOM HUD | `apps/web/src/ui/hud.ts`（约 4470 行）、`handLayout.ts`、`dice-overlay.ts` | 动作扇形、手持出牌、浮层、抽屉、键盘 |
| 浮层仲裁 | `apps/web/src/ui/overlay.ts` | peek/pinned/modal 的强弱序与唯一性 |
| 已有评审 | `docs/UI-ARCHITECTURE.md`、`docs/UI-RESPONSIVE-PLAN.md`、`docs/UI-HAND-SLOT-NOTES.md`、`docs/BACKLOG.md` | 已修/已定边界，避免重复造轮子 |

方法：静态阅读 + `Select-String` 全量清点事件监听（123 处 `addEventListener`）、指针/键盘/滚轮/拖拽回调，再与公开的棋牌/桌游 UX 规范对照。

---

## 2. 现状交互架构

### 2.1 三层数据流

```
 ┌────────────── 3D 棋盘（canvas）──────────────┐
 │ OrbitControls：左键旋转 / 右键平移 / 滚轮缩放   │
 │ BoardRaycaster：pointerdown/move/up/cancel     │
 │   hover → emissive 高亮 + cursor               │
 │   6px 阈值 → drag / drop                       │
 └───────────────┬───────────────────────────────┘
                 │ InteractiveObjectData{type,id,metadata}
                 ▼
 ┌────────────── 会话层 session.ts ───────────────┐
 │ pickTarget(pick)：热点→执行 / 普通对象→inspect  │
 │ dispatch(action)：动作→引擎reduce→快照+视觉事件 │
 │ armedPlacement / placement 旋转·确认           │
 └───────────────┬───────────────────────────────┘
                 │ GameSnapshot（DTO）+ VisualTraceEvent
                 ▼
 ┌────────────── DOM HUD（hud.ts）────────────────┐
 │ 动作扇形 fisheye / 手持出牌 / 详情 / 骰子 / 决策│
 │ OverlayArbiter：peek < pinned < modal 唯一仲裁   │
 │ 抽屉·菜单·Tab焦点陷阱·Esc                       │
 └────────────────────────────────────────────────┘
```

### 2.2 关键机制（审查要点）

**A. 拾取与悬停**（`raycaster.ts`）
- 只拾取**可见层级**的 mesh（`isHierarchyVisible`，第 96–103 行），隐藏楼层不会被命中——与 SA-93 楼层隔离一致。
- 悬停高亮用「克隆材质 + 换回」避免污染共享调色板（第 234–262 行），这是正确的工程处理。
- cursor 由类型决定：`ZONE → grab`，其余 `pointer`（第 147 行）。

**B. 拖拽**
- 起拖阈值 **6px**（第 119 行），并 `setPointerCapture`，保证指针移出 canvas 或松开在 HUD 上也能收到 drop（第 180–185 行）。这是一个易被忽略但很关键的细节。
- 按 `pointerdown` 立即 `controls.enabled=false`（`scene.ts:884`），避免 OrbitControls 抢走前几个像素——解决“拖牌变成转镜头”的经典冲突。
- `ZONE`（牌堆）拖拽**只做表现**、不触发 click/detail（第 206–212 行；`UI-HAND-SLOT-NOTES.md` 亦有记录）。
- `metadata.draggable === false` 可让表面“可点不可拖”（第 159–164 行），用于只读手牌叠加层。

**C. 点击语义**（`main.ts:906 handleBoardPick` → `session.ts:443 pickTarget`）
- 命中 **动作热点**（`ROOM_NAV` / `DOOR` / `SPECIAL_MOVE` / `ROOM_FEATURE` / 座位）→ **直接执行**（`session.ts:472–560`）。
- 普通实体/节点 → **inspect-first**（先看档案，`session.ts:621–634`），不直接改状态。这是 BACKLOG P1 明确改过的行为。
- 座位牌 → 打开玩家卡（`main.ts:914`）。

**D. 动作扇形与手持出牌**（`hud.ts`）
- 扇形是**鱼眼**布局：指针位置决定哪几个间隙张开（`handLayout.ts` 纯函数，归一化密度、永不溢出）。
- 手持出牌区把「点击=详情 / 长按=执行 / 滚轮·拖拽·方向键=切换」压在一个控件上：
  - 长按 **500ms** 执行简单动作（`HAND_LONG_PRESS_MS`，第 68 行）；
  - 按后移动 > **14px** 取消（`HAND_PRESS_CANCEL_PX`，第 69 行）；
  - 横向拖拽每 **40px** 一步（第 70 行），滚轮累计 **24px** 一步（第 72 行）；
  - 切换后抑制一次 click 防止误触（`suppressHandClick`，第 3613 行）。

**E. 键盘**（`main.ts:957 wireKeyboard`、`hud.ts:2087`）
- `Esc`：closePayload / closeAbout / cancelPlacement / setHighlight(null)（`main.ts:960`）；同时 HUD 侧关闭过场/菜单/抽屉（`hud.ts:2088`）。
- `i/I`：切换数学 inspector（`main.ts:968`）。
- `1–9`：直接执行第 N 个动作（`main.ts:973`）。
- 手持牌匾聚焦时：`←/→` 切换、`Enter` 执行/打开详情（`hud.ts:3473–3482`）。
- 菜单/抽屉内 `Tab` 做焦点陷阱（`hud.ts:2110`）。

**F. 浮层仲裁**（`overlay.ts`）
- 三条不变量：同 key 唯一、强度序 `peek<pinned<modal`、弱条目不驱逐强条目。悬停预览（peek）不会顶掉玩家点开的详情卡（pinned/modal）。这是本项目交互一致性的“压舱石”，优化时应继续复用它而非另起通道。

---

## 3. 现存操作清单（能力矩阵）

| # | 操作 | 触发方式 | 作用对象 | 反馈 | 代码位置 |
| --- | --- | --- | --- | --- | --- |
| 1 | 旋转/平移/缩放镜头 | 鼠标左/右/滚轮、触控手势 | 全局 | 阻尼平滑 | `scene.ts:861` |
| 2 | 悬停预览 | 指针悬停 | 房间/门/卡/座位/骰/牌堆 | peek 芯片 + 高亮 | `main.ts:158` |
| 3 | 点击热点执行 | 单击 | 导航箭头/门/特殊移动/房间特性 | 事件条 + 动画 | `session.ts:472` |
| 4 | 点击详情 | 单击 | 普通实体/节点 | inspect 卡片 | `session.ts:621` |
| 5 | 拖牌放置 | 拖动 >6px 到节点 | 实体 | 落点高亮 + 回弹 | `raycaster.ts:119`,`main.ts:239` |
| 6 | 拖动合牌 | 拖到同类牌堆 | 实体 | toast「已合入」 | `main.ts:241` |
| 7 | 卡牌自由摆放 | 无合法目标时拖动 | CARD | toast「仅本视图」 | `main.ts:266` |
| 8 | 牌堆拖动 | 拖动 ZONE | 牌堆 | 桌沿裁剪 | `main.ts:174` |
| 9 | 扇形悬停放大 | 指针在 dock 移动 | 动作卡 | fisheye 重排 | `hud.ts:4274` |
| 10 | 点击动作卡 | 单击 | 动作 | 简单走执行/参数开详情 | `hud.ts:4340` |
| 11 | 手持切换 | 滚轮/拖拽/←→ | 手持区 | 卡位滚动 | `hud.ts:3485` |
| 12 | 长按执行 | 500ms | 简单动作 | 环形进度 | `hud.ts:3533` |
| 13 | 数字键执行 | 1–9 | 第 N 个动作 | 直接派发 | `main.ts:973` |
| 14 | 放置旋转/确认 | 面板按钮或世界 gizmo | 房间预览 | 预览网格 | `hud.ts:4339`,`session.ts:460` |
| 15 | 撤销上一步 | 菜单按钮 | 日志游标 | toast | `hud.ts:2218` |
| 16 | 骰子过场推进 | 点击/Enter/Space；Esc 关闭 | 检定 | 分阶段动画 | `dice-overlay.ts:230` |
| 17 | 抽屉/菜单 | 顶栏按钮 | 面板 | 滑出+scrim | `hud.ts:2087` |
| 18 | 机位/音效/诊断/检查器 | 顶栏按钮、`i` | 全局 | 即时 | `hud.ts:2192` |

> 结论：**操作覆盖面已经相当完整**，常见“选择—目标—确认 / 拖放 / 悬停看牌 / 撤销 / 镜头”都在。下一步不是“补功能”，而是“磨一致性 + 手感 + 可发现性”。

---

## 4. 已经做对的、值得保留的设计

1. **板上直接操作**：热点点击在地图上完成移动/开门，而不是把它们塞进底部按钮——符合 BGA「Do not replace board-component actions with Action Bar buttons」。
2. **唯一浮层仲裁**（`OverlayArbiter`）：从源头消灭“悬停芯片顶掉详情卡”的经典 bug，且是纯状态机、可单测。
3. **悬停高亮不污染共享材质**（克隆/还原），避免整屋亮起。
4. **拖拽 pointer capture + 起拖前禁用 OrbitControls**：正确处理了“拖拽 vs 转镜头”的争用。
5. **鱼眼归一化布局**（`handLayout.ts`）：无论牌多牌少、指标在左在右都不溢出、不留洞，比“等距+截断”稳健得多。
6. **长按环形进度 + 移动取消**：给“长按”一个可视化承诺，避免无反馈的暗手势。
7. **inspect-first**：普通点击先看档案，避免误改状态——是对的方向。

---

## 5. 业界常见操作模式库（调研结论）

> 主要依据 [BGA Studio UX Guidelines](https://en.doc.boardgamearena.com/BGA_Studio_Guidelines)（官方 PDF：[Guidelines_UX.pdf](https://doc.studio.boardgamearena.com/assets/framework-documentation/guidelines/Guidelines_UX.pdf)），辅以数字卡牌/桌游实现案例。

### 5.1 选择与目标（Selection / Targeting）
- **两段式**：先选动作/牌，再点目标，最后确认；选目标过程中**持续高亮全部合法目标**，非法目标置灰并说明原因。BGA：*“Highlight valid options so the awaited action is obvious; show consequences visually before the player commits.”*
- **取消路径必须显式**：右键/Esc/点空白处取消当前选择。
- **多选计数**：需要 N 个目标时显示“已选 2/3”。

### 5.2 拖放（Drag & Drop）
- 拖动时**落点吸附/高亮**、显示插入点（手牌重排用 gap indicator）。
- 允许**放错回弹**并给一句原因。
- 参考 [Hand Overhaul（Dustin's Designer Den）](https://dustinsdesignerden.com/news/hand-overhaul)：手牌可拖入/拖出、可左右重排、拖动时对手看到“模糊幽灵牌”以保持信息不对称、手牌缩放 50%–200% 与 X/Y 偏移可按浏览器持久化。

### 5.3 手牌与牌堆
- **鱼眼/放大悬停**看牌（本项目已有）；**双击/长按放大**看全卡。
- **自动排序 / 分组 / 偏好持久化**（按费用、类型、花色），并能手动覆盖。
- **手牌区可缩放**（设置项），避免大屏小卡或小屏挤爆。

### 5.4 上下文操作
- **右键上下文菜单**（PC）/ **长按上下文菜单**（移动）承载次要动作（查看、弃置、标记）。
- 与「长按执行」冲突时，用**菜单而非直接执行**更安全（长按用于“更多”，而非“确定”）。

### 5.5 确认 / 撤销（BGA 明确立场）
- **破坏性/不可逆动作**（结束回合、弃牌、提交资源）优先 **限时确认 5–8 秒**，而不是无限撤销。
- **撤销**只在“一个回合多于 2 个动作”时提供；**不要每个动作都挂一个撤销**。
- **不要** Undo + Reset + Confirm 三层叠加以致过度校验；**不要用撤销掩盖误点**——应修布局（更大目标、更清晰高亮）。

### 5.6 反馈（Feedback）
- **沉默不可接受**：每个失败动作必须有**文字原因**（配图标，不能只靠颜色）。
- 动画 **0.5s、最多 0.8s**，只解释“什么动了、去哪了、为什么重要”，不装饰。
- 音效是加分项，必须先有视觉提示；不得“仅靠声音传达信息”。

### 5.7 布局与可访问性
- **中央=共享动作 / 上下=全局信息 / 面板=私有资源**；主操作区不可被浮层遮挡。
- 触控目标 **≥32px，目标 40–44px**；窄屏宁可滚动不要缩小。
- 对比度 ≥4.5:1；**颜色必须配图标/形状**（色盲安全）。
- 键盘可达、`focus-visible` 可见，不依赖 hover。

### 5.8 回合与多人
- 动作栏始终显示**当前状态**：轮到谁/在等谁/你能做什么。
- 计时器、旁观、回放、刷新后恢复临时 UI（当前回合、待处理动作、已选组件）。

---

## 6. 差距分析（Current vs Pattern）

> 分级：**P0** = 易造成误操作/困惑，建议优先；**P1** = 明显影响手感；**P2** = 打磨项。

| 编号 | 差距 | 现状证据 | 业界做法 | 级别 |
| --- | --- | --- | --- | --- |
| G1 | **点击语义不统一**：点热点=执行、点普通对象=看详情，玩家需靠悬停文案推测 | `session.ts:472` vs `:621` | 用统一“可执行与否”的视觉语言（高亮/光标/图标）区分，并不隐藏“这一下会不会真的生效” | P0 |
| G2 | **破坏性动作无二次确认**：简单动作点击即执行（含数字键、长按） | `hud.ts:3446`,`:3609`,`main.ts:973` | 限时确认（5–8s）或“执行前后果预览” | P0 |
| G3 | **拖放不可取消**：起拖后没有 Esc/右键取消路径，只能松手后回弹 | `raycaster.ts` 无 cancel-by-key | 拖拽中 Esc 取消并复原 | P1 |
| G4 | **快捷键不可发现**：数字键/Enter/←→ 没有任何常驻提示或帮助面板 | 仅 `hud.ts:4266` 一句“数字键直接执行” | 快捷键清单（? 键）+ 首次出现时提示 | P1 |
| G5 | **手势冲突/歧义**：同一控件上长按=执行、点击=详情、拖动=切换，三者边界对新手不直观 | `hud.ts:3501–3611` | 长按改为“更多操作”，执行收敛到单击/确认 | P1 |
| G6 | **目标选择两段式偏隐式**：动作→选目标→确认缺少强引导与计数 | `hud.ts:1454` 仅 toast 提示数量 | 持续高亮合法目标 + 已选 n/N + 明确取消 | P1 |
| G7 | **移动端能力缺位**：手持出牌区在 <1200px 直接隐藏，移动端只剩扇形；无触觉反馈 | `UI-HAND-SLOT-NOTES.md:11`；无 `navigator.vibrate` | 移动端手势清单化 + 轻触觉 | P1 |
| G8 | **手牌/动作无排序与分组**：顺序完全跟随引擎 `actions` | `hud.ts` 直接按 `snapshot.actions` | 自动排序/分组、可按偏好覆盖 | P2 |
| G9 | **无右键上下文菜单**：右键仅用于“取消长按” | `hud.ts:3460` | 右键/长按菜单承载次要动作 | P2 |
| G10 | **撤销语义单一**：只有 rewind 上一步，且对“不可逆”动作也可能撤销 | `hud.ts:2218` | 区分“可撤销小步”与“需确认的破坏步” | P2 |
| G11 | **错误反馈只在 toast**：缺少“就近高亮出错对象” | `pushToast` 多处 | 错误点标注 + 一句人话 | P2 |
| G12 | **键盘全局监听边界**：`1–9` 已挡 `input`，但未挡 `select`/`contenteditable` | `main.ts:958` | 统一“可编辑区域”判断 | P2 |
| G13 | **无首次引导/教练层**：新玩家靠 `showAnnouncement` 一句欢迎 | `main.ts:947` | 分步 coach mark / 提示气泡 | P2 |

---

## 7. 优化方向建议（按优先级）

### 原则
1. **一个手势只表达一件事**：执行、查看、切换尽量分到不同输入，不靠“时长/方向”猜意图。
2. **可执行性先于可发现性**：能点的先看起来能点（高亮/光标/角标），再谈快捷键。
3. **破坏性动作“慢一拍”**：确认或后果预览，优于事后撤销。
4. **失败必须说话**：每个被拒绝的动作给“为什么 + 怎么办”。
5. **沿用既有基建**：浮层一律走 `OverlayArbiter`；布局不新起绝对定位；差异化由 `GamePresentationHints` 声明，不写 `if (gameId)`。

### 路线（建议分 PR，单一意图）

- **PR-1 · 点击语义统一（P0, 先做）**
  - 抽出“这次点击会执行/会查看”的判定，在悬停阶段就用不同光标/图标/边框色表达；
  - 热点与普通对象统一走 `peek → 决定 cursor 与 aria 描述`。
- **PR-2 · 破坏性动作确认与后果预览（P0）**
  - 为简单动作引入“可逆/不可逆”标记；不可逆走限时确认条；
  - 复用 `dice-overlay` 的“点击跳过/Enter 推进”范式，不新造模态。
- **PR-3 · 拖放可取消 + 落点语义增强（P1）**
  - 拖拽中 Esc/右键取消并复原；
  - 落点显示“放置/合入/无效”三态颜色与图标。
- **PR-4 · 快捷键帮助层（P1）**
  - `?` 打开快捷键清单；首屏一次性提示；把 `←→ / Enter / 数字 / i / Esc` 收进同一份“键位表”常量。
- **PR-5 · 手持/手势再设计（P1）**
  - 长按从“执行”改为“更多”；执行收敛到单击或确认；
  - 移动端给出对应手势（轻触看、双击打、长按更多）。
- **PR-6 · 目标选择引导（P1）**
  - 选目标时持续高亮全部候选、置灰非法项并说明、显示 `n/N`、显式取消。
- **PR-7 · 可发现性与打磨（P2）**
  - 手牌排序/分组、右键菜单、就近错误标注、首次引导。

### 验收（建议与现有探针体系对齐）

- 沿用 `probe:ui` / `probe:a11y` / `test:ui` 的口径，新增/扩展断言：
  - 时间：从“看到动作”到“完成一次合法动作”的步骤数与点击次数（可用 Playwright 计时）；
  - 误操作率：破坏性动作在确认机制下“误触即生效”次数为 0；
  - 可发现性：快捷键清单可被打开、所有可交互元素有可访问名称；
  - 触控：在 390/820 档，主要动作完成不依赖 hover、目标 ≥44px。
- 埋点（轻量）：记录“动作被拒绝的原因分布”与“停留在某阶段超时的次数”——BGA 的原话是“玩家卡在某个阶段，就是设计警告”。

---

## 8. 风险与边界

- 项目已明确 **AI-22：3D 只做摘要、长文在 DOM 详情**——优化交互时不要给 3D 卡面加长文渲染。
- 手持出牌区是 **<1200px 隐藏**的既定设计，移动端增强应放在扇形/抽屉，而不是强行恢复手持区。
- 不要引入新的组件框架：`UI-ARCHITECTURE.md` Phase 3 已选 **B 方案（零依赖键控更新）**，交互改造继续在现有 DOM 结构上做，避免回归面骤增。
- 动画必须遵守 `prefers-reduced-motion`（`a11y.css` 已有全局压制）。

---

## 9. 实现状态（2026-11-08 核对）

> 本节的每一条都对应代码与一条可复跑的探针；"部分"表示主路径已解、边界仍留着。

| 差距 | 状态 | 交付物 | 怎么验 |
| --- | --- | --- | --- |
| G1 点击语义不统一 | **已解**：统一手牌三手势分工——单击=看详情/执行、拖出=打、Esc 取消 | `apps/web/src/ui/cardHand/cardHand.ts`、`hud.ts` 的 `activateHandCard` / `playHandCard` | `pnpm probe:unified-hand`、`pnpm probe:card-hand` |
| G2 破坏性动作无确认 | **部分**：可直接执行的动作仍需拖出/单击才发；需要目标或数量的动作一律先进选择器或表单，不 dispatch | `cardHand.ts`、`hud.ts`（`playHandCard` 返回 false 即回弹） | `pnpm probe:unified-hand-numeric` |
| G3 拖放不可取消 | **已解**：松手在区外、`pointercancel`、窗口失焦都走弹簧回弹，且把拖拽速度灌进弹簧 | `cardHand.ts`（`releaseBack`） | `pnpm probe:card-hand`（"non-playable card springs home"） |
| G4 快捷键不可发现 | **已解**：`ui/keymap.ts` 单一键位表 → `?` 清单 + 首屏一次提示 + ☰ 菜单 ⌨ 入口 | `ui/keymap.ts`、`ui/shortcutHelp.ts`、`hud.ts#openShortcutHelp` | `pnpm probe:keymap`、`pnpm probe:shortcut-help` |
| G5 一手势多义 | **已解**（统一手牌内）：手势按"看 / 打 / 取消"分离，不再靠时长猜意图 | `cardHand.ts` | `pnpm probe:card-hand`（拖拽跟手 1:1、回弹 2px 内归位） |
| G6 目标选择偏隐式 | **部分**：拖出即弹径向选择器（锚点=松手点）；非法分区预置灰仍未做 | `radialPicker.ts`、`hud.ts#openRadialPicker` | `pnpm probe:unified-hand` |
| G7 移动端缺位 | **部分**：<1200px 底部横滑带 + 触控手势（`touch-action:none`、大 slop/外扩容差）；底部抽屉仍未做 | `layout-shell.css`、`cardHand.ts` | `pnpm probe:unified-hand`（390 档） |
| G8 手牌排序/分组 | 未做 | — | — |
| G9 右键上下文菜单 | 未做（拖拽中右键只用于取消） | — | — |
| G10 撤销语义单一 | 未做 | — | — |
| G11 错误只在 toast | **部分**：出牌区三态高亮（valid/invalid）+ 回弹，失败仍靠 toast | `cardHand.ts`（`data-drop`）、`layout-shell.css` | `pnpm probe:card-hand` |
| G12 键盘边界 | **已解**：`isEditableTarget` 覆盖 input/textarea/select/contenteditable，Esc 例外 | `ui/keymap.ts` | `pnpm probe:keymap`、`pnpm probe:shortcut-help` |
| G13 首次引导 | **部分**：快捷键首屏提示一次（`rds.shortcuts.hinted`）；无分步 coach mark | `hud.ts#maybeHintShortcuts` | — |

### 9.1 对应原路线（§7）

| 原 PR | 状态 |
| --- | --- |
| PR-1 点击语义统一 | 已解（统一手牌 + `CardHand` 手势分离） |
| PR-2 破坏性动作确认 | 部分（选择/表单前置；尚无"限时确认条"） |
| PR-3 拖放可取消 | 已解 |
| PR-4 快捷键帮助层 | 已解 |
| PR-5 手持/手势再设计 | 部分（旧 `#hand-slot` 仍保留，统一模式下桌面隐藏） |
| PR-6 目标选择引导 | 部分（径向选择器已上线；非法项预置灰未做） |
| PR-7 可发现性与打磨 | 未做（G8/G9/G10/G13 的剩余部分） |

### 9.2 手感参数（`cardHand.ts` 的默认值，调参即调手感）

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `hoverMs` | 170 | hover 过渡时长（150–200 最跟手） |
| `hoverLift` / `hoverScale` | 16px / 1.1 | 上浮与放大 |
| `neighbourPush` | 12px | 邻居让位幅度，改弹簧目标而非位置 |
| `spring` | 240 / 26 | 阻尼比 ≈0.84：有回弹但不过冲 |
| `returnSpring` | 210 / 23 | 回弹专用；松手速度灌进速度项 |
| `slopPx` | 6 | 起拖阈值（触屏建议 8–10） |
| `tiltPerPx` / `tiltMaxDeg` | 0.35 / 9 | 甩动倾斜 |
| `zonePadding` / `zoneExitPadding` | 14 / 4 | 出牌区滞回，边界不闪 |
| `flyMs` / `flyScale` | 260ms / 0.8 | 打出飞桌 |

## 10. 参考链接

- [BGA Studio Guidelines（UX/UI）](https://en.doc.boardgamearena.com/BGA_Studio_Guidelines)　官方 PDF：[Guidelines_UX.pdf](https://doc.studio.boardgamearena.com/assets/framework-documentation/guidelines/Guidelines_UX.pdf)
- [Hand Overhaul · Dustin's Designer Den](https://dustinsdesignerden.com/news/hand-overhaul)（手牌拖拽/重排/缩放/隐私幽灵）
- 项目内既有评审：[UI-ARCHITECTURE.md](UI-ARCHITECTURE.md)、[UI-RESPONSIVE-PLAN.md](UI-RESPONSIVE-PLAN.md)、[UI-HAND-SLOT-NOTES.md](UI-HAND-SLOT-NOTES.md)、[BACKLOG.md](BACKLOG.md)
