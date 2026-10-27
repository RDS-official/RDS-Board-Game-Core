# UI 架构升级方案

> 目标：从「一堆绝对定位的面板 + 手算偏移」升级为**可多端复用的分层设计系统**，
> 同时解决当前的字号过小与面板重叠。
>
> 本文是**方案**，不含实现。每个 Phase 都可独立合并、独立验收。
> 最近核对：2026-10-28。

---

## 1. 现状诊断（实测，非估算）

### 1.1 结构性问题：面板靠绝对定位 + 魔法偏移

右侧三块面板（房间档案、洋馆小地图、近期动态）全部 `position: absolute`，彼此不参与文档流，位置由**手写常数**决定：

```css
.room-card       { top: 88px; }
.mansion-minimap { top: 320px; }
#room-card[style*="none"] ~ .mansion-minimap { top: 88px; }
```

`top: 320px` 隐含假设「房间卡永远不超过 212px 高」。一旦房间卡内容变多（房间描述 + 在场者 + 物品/预兆行），高度越界就直接**压到小地图上**——这正是截图里看到的重叠。

> 用兄弟选择器 `[style*="none"]` 去猜一个面板的可见性，本身就是不可维护的写法：
> 任何内联样式写法变化都会静默失效。

### 1.2 字号低于可读下限

实测生效字号：

| 元素 | 当前 | 建议最小 |
| --- | --- | --- |
| 玩家名 `.pc-name` | 12.5px | 14px |
| 属性值 `.pc-row .v` | **10.5px** | 13px |
| 属性键 `.trait-key` | **10px** | 12px |
| 小地图房间名 `.mm-name` | 11px | 12.5px |
| 动态条目 `.af-text` | **10.5px** | 13px |
| 扇形说明条 `.fh-detail` | **10.5px** | 12.5px |
| 任务描述 `.al-desc` | 11px | 13px |

`styles.css` 里 **167 处硬编码 px 字号**，只有 **1 处** `clamp()`/`rem`。没有任何字号阶梯，改一处不知道会连带影响哪里。

### 1.3 移动端实际不可用

| 视口 | 行动坞 | 重叠 |
| --- | --- | --- |
| 1440×900 | 511×196 ✅ | 无 |
| 820×1180 | **0×495** ❌ | 无 |
| 390×844 | **0×495** ❌ | rail × 小地图 98px、rail × 动态 11px |

根因：

```css
.action-dock {
  width: min(920px, calc(100vw - 840px));  /* 390px 时算出 -450px */
  min-width: 470px;
}
```

视口窄于 840px 时宽度表达式为**负数**，被浏览器钳成 0，同时 `min-width` 又把内部卡片撑成竖排 → 高度 495px。

### 1.4 代码规模与技术债指标

| 指标 | 数值 | 含义 |
| --- | --- | --- |
| `styles.css` | 3818 行 | 单文件样式，无分层 |
| `hud.ts` | 1461 行 / 11 个 `render*` / **23 处 `innerHTML =`** | 手写字符串模板，全量重建 |
| `position: absolute` 规则 | **41 条** | 布局不参与文档流 |
| 硬编码 px 字号 | **167 处** | 无字号阶梯 |
| `clamp()` / `rem` | 1 处 | 无流体排版 |
| `@media` | 5 处 | 断点不成体系 |
| `@container` | **0 处** | 无组件级响应式 |

每次快照变化都整段重建 `innerHTML`，焦点/滚动/悬停状态因此反复丢失——这也是之前「轮询重置按钮焦点」那类问题的同源病根。

---

## 2. 业界方案调研

### 2.1 设计令牌（Design Tokens）是分层的基础

主流做法是把「颜色/间距/字号/圆角/阴影」抽成**三层令牌**，而不是散落的字面量：

- **primitive（原始层）**：`--gray-900`、`--space-2`、`--font-13`
- **semantic（语义层）**：`--surface-panel`、`--text-muted`、`--gap-panel`
- **component（组件层）**：`--dock-pad-y`、`--card-radius`

组件只消费 semantic/component 层，改主题只动 primitive。W3C DTCG 已把令牌格式标准化，可导出多端（Web / iOS / Android）。
参考：[Compound Design System · Naming Approach](https://compound.thephoenixgroup.com/latest/guidelines/foundations/tokens/naming-approach-sMf2dkF9)、[Design tokens and theming](https://github.com/sujeet-pro/sujeet.pro/blob/main/content/articles/design-tokens-and-theming/README.md)、[现代 CSS 颜色特性在设计系统中的用法](https://zeroheight.com/blog/leveraging-modern-css-color-features-in-your-design-system/)

### 2.2 响应式：容器查询为主，媒体查询定义外壳形态

2025 年的共识是**组件用容器查询、页面用媒体查询**：

- 面板宽度受侧栏影响而变，媒体查询只看视口会判断错；`@container` 让组件按**自身可用宽度**重排；
- 视口级断点只用来决定「外壳形态」（桌面三栏 / 平板两栏 / 手机单栏 + 底部抽屉）。

参考：[Intrinsic Responsiveness](https://github.com/digital-gravy/etch-docs/blob/f3e684e3cfe72e7d852ae854951ac7705c34fd7b/docs/docs/responsive-development/intrinsic-responsiveness.md)、[Responsive patterns（容器查询实践）](https://github.com/yonatangross/orchestkit/blob/main/src/skills/responsive-patterns/SKILL.md)

### 2.3 流体排版

用 `clamp()` 让字号随视口平滑变化，并设**下限**保证可读：

```css
--font-body: clamp(0.8125rem, 0.78rem + 0.16vw, 0.875rem); /* 13 → 14px */
```

这是替代「167 处固定 px」的标准手段，也是移动端不必再写一套字号的唯一办法。

### 2.4 组件化：Lit 而非重写为 React

| 方案 | 适配度 | 判断 |
| --- | --- | --- |
| **Lit 3** | 高 | 原生 Web Components、~5KB、纯 TS、可与现有 CSS 共存、**可逐个组件迁移** |
| React / Vue | 低 | 需引入虚拟 DOM + 构建链改造，1461 行手写模板要整体重写，风险最大 |
| 纯手写 vanilla | 中 | 无需新依赖，但要自己造响应式与生命周期，等于重造轮子 |

推荐 **Lit**，理由是可**渐进迁移**：先让 `hud.ts` 里的一个面板变成 Lit 元素，其余保持原样，两者可共存。它也不违反仓库的 `src/ui` 只 import `app/contracts` 的分层约束。
参考：[alien-lit — Lit 的响应式状态方案](https://saman-taghavi.github.io/alien-lit/examples/theming)

### 2.5 桌游/游戏 HUD 的既有经验

Board Game Arena 的 UX 指南给出的可迁移要点：**主要操作区不可被遮挡**、**触控目标要足够大**、**信息层级靠区域划分而非字号堆叠**。
参考：[BGA Studio Guidelines](https://en.doc.boardgamearena.com/BGA_Studio_Guidelines)、[BGA UX Use Case](http://en.doc.boardgamearena.com/images/5/57/Guidelines_UX_new_compressed.pdf)

### 2.6 触控与可访问性硬指标

- 触控目标 **≥ 44×44 CSS px**；
- 正文对比度 **≥ 4.5:1**（WCAG AA）；
- 移动端必须处理 `env(safe-area-inset-*)`（刘海/手势条）；
- 键盘可达：`focus-visible` 必须可见，不依赖 `hover`。
参考：[移动端设计规则](https://github.com/mrclrchtr/skills/blob/6062be05b8edef557a0cf7f8ff072e4fa1debb96/plugins/web-design-guidelines/references/core/mobile.md)、[觸控目標尺寸規則](https://law.moda.gov.tw/Download.ashx?FileID=244&id=FL096186&type=LAW)

---

## 3. 目标架构

### 3.1 分层（自下而上）

```
apps/web/src/ui/
├─ tokens/
│   ├─ primitives.css      # 原始层：色阶/间距/字号/圆角/时长
│   ├─ semantic.css        # 语义层：surface/text/border/gap/type
│   └─ themes.css          # 主题：slate（默认）/ gothic（山屋）
├─ primitives/             # 无业务语义的基础件
│   ├─ panel.ts            # 面板容器（标题/折叠/滚动）
│   ├─ chip.ts  meter.ts  button.ts  toast.ts
├─ components/             # 有业务语义的复合件
│   ├─ player-card.ts      # 角色卡（属性阶梯）
│   ├─ action-fan.ts       # 行动扇形手牌
│   ├─ minimap.ts          # 洋馆小地图
│   ├─ activity-feed.ts    # 近期动态
│   ├─ room-dossier.ts     # 房间档案
│   └─ action-detail.ts    # 动作详情弹层
├─ shells/
│   ├─ desktop-shell.ts    # 三栏：左角色 / 中棋盘 / 右信息
│   ├─ tablet-shell.ts     # 两栏：棋盘 + 可切换侧栏
│   └─ mobile-shell.ts     # 单栏：棋盘 + 底部抽屉
└─ hud.ts                  # 只剩「编排」：订阅快照 → 分发给组件
```

**关键约束**：`hud.ts` 不再产生任何 `innerHTML` 模板字符串，只做数据分发。组件各自负责自己的渲染与生命周期。

### 3.2 布局模型：CSS Grid 外壳 + 区域分配

用 Grid 的命名区域取代 41 条绝对定位：

```css
.app-shell {
  display: grid;
  height: 100dvh;
  grid-template-columns: var(--rail-w) 1fr var(--side-w);
  grid-template-rows: var(--topbar-h) 1fr auto;
  grid-template-areas:
    "topbar topbar topbar"
    "rail   board  side"
    "rail   dock   side";
  gap: var(--gap-shell);
}
```

好处：

- 面板高度由**内容**决定，彼此**不可能重叠**——重叠从「需要人工避免」变成「结构上不可能」；
- 侧栏可滚动（`overflow: auto` + `min-height: 0`），不再溢出压住别的面板；
- 换端只改 `grid-template-areas`，组件本身不动。

### 3.3 排版阶梯（流体 + 下限）

| 令牌 | 用途 | 值 |
| --- | --- | --- |
| `--font-xs` | 角标/键位 | `clamp(0.6875rem, 0.66rem + 0.1vw, 0.75rem)` → 11–12px |
| `--font-sm` | 次要说明 | `clamp(0.75rem, 0.72rem + 0.12vw, 0.8125rem)` → 12–13px |
| `--font-body` | 正文 | `clamp(0.8125rem, 0.78rem + 0.16vw, 0.875rem)` → 13–14px |
| `--font-title` | 面板标题 | `clamp(0.9375rem, 0.9rem + 0.2vw, 1.0625rem)` → 15–17px |

**硬性下限**：任何可见文字不低于 **12px**；正文不低于 **13px**。这条进 lint/回归。

### 3.4 间距与触控

- 间距阶梯 `--space-1..8`（4/6/8/12/16/20/24/32）；
- 所有可点元素 `min-height: 44px`（移动端），桌面端可降到 36px 但**只能靠断点降，不能默认小**；
- 移动端外壳加 `padding-bottom: env(safe-area-inset-bottom)`。

### 3.5 三端外壳形态

| 形态 | 断点 | 布局 | 行动栏 |
| --- | --- | --- | --- |
| 桌面 | ≥ 1200px | 左角色栏 / 中棋盘 / 右信息栏 | 底部横向扇形 |
| 平板 | 768–1199px | 中棋盘 + 右侧栏可折叠 | 底部横向扇形 |
| 手机 | < 768px | 单栏棋盘 | **底部抽屉**（上滑展开扇形，默认只露一行） |

手机端的行动栏从「常驻横条」改为「可上滑抽屉」，是因为 390px 宽放不下 10 张扇形卡——抽屉展开时占用棋盘空间，收起时只留一条手柄。

---

## 4. 迁移路线（每阶段可独立合并）

### Phase 0 · 止血 ✅ 已完成（2026-10-28）— 无需架构改动

先修两个当下可见的缺陷，为后续争取时间：

1. **面板重叠**：把右侧三块面板从「绝对定位 + 魔法偏移」改为**单一侧栏列**（`flex column` + `gap`），高度自然堆叠；
2. **移动端行动坞宽度归零**：`width: min(920px, calc(100vw - 840px))` 改为 `width: min(920px, max(320px, calc(100vw - 840px)))`，并给 `<768px` 一个兜底宽度；
3. **字号下限**：把实测 < 12px 的 7 处先提到 12–13px（不动全局）。

验收：三种视口下 `overlaps: none`、`dock width > 0`、无 < 12px 文字。

**实际落地**（比原计划多做了一步，因为探针暴露出真实规模）：

- 右侧三块面板包进单一 `.side-column`（flex 列 + gap），并删除 `#room-card[style*="none"]` 那条兄弟选择器猜测；
- 行动坞宽度改为 `min(920px, max(340px, calc(100vw - var(--dock-reserve))))`，并按棋盘带居中；
- 新增 `--rail-w`/`--side-w` 外壳令牌，用 `clamp()` 随视口缩放，并在 `max-aspect-ratio: 3/2`、`4/3` 两档主动收窄；
- **字号下限清扫**：`styles.css` 等文件里 **123 处**低于 12px 的 `font-size` 全部抬到 12/12.5px（原计划只处理 7 处，探针显示实际有 65 个可见元素低于下限）；
- 触控下限：窄屏下相机切换、图标按钮、小地图控件、楼层标签、动态标题统一 `min 44×44`。

**新增 `scripts/probe-ui-layout.mjs`（`pnpm probe:ui`）**，7 档视口断言面板不重叠/不溢出/字号 ≥12px/触控 ≥44px，其中包含 16:9、16:10、3:2、4:3 四种目标比例。

> 探针开发中发现的**测试基建缺陷**：所有浏览器脚本原本用 `ensureDevServer()` 复用 5173，
> 一旦本机跑着 Hub，统一外壳就进大厅、游戏 DOM 永不挂载，几何断言全部**空转假绿**。
> 已新增 `scripts/lib/soloserver.mjs` + `scripts/lib/vite-solo.config.mjs`（无 Hub 代理），
> 并把 17 个浏览器脚本统一切换过去；探针另加「必须真正进入游戏视图」的硬断言。

### Phase 1 · 设计令牌 ✅ 已完成（2026-10-28）

- 建 `tokens/primitives.css` + `semantic.css` + `themes.css`；
- 把 `styles.css` 里 167 处硬编码字号**机械替换**为令牌（可写脚本半自动）；
- 现有 `--gold/--muted/--faint` 等并入 semantic 层，保留别名避免一次性改完；
- 主题切换从 `[data-theme="gothic"]` 覆盖改为**主题只覆盖 semantic 层**。

验收：`styles.css` 中 `font-size: <数字>px` 数量为 0；gothic 主题视觉无回归。

**实际落地**：

- 新建 `apps/web/src/ui/tokens/`：`primitives.css`（色阶/间距/圆角/8 级流体字号/字重/时长/阴影）、`semantic.css`（surface/text/border/accent/status/type-role/gap，共 135 个令牌）、`themes.css`（**只覆盖语义层**，34 个主题可覆盖令牌）。
- **192 处** `font-size` 全部改为 `var(--type-*)`，CSS 中硬编码 px 字号归零。类型阶梯下限 12px、正文 14–15px。
- **160 处**组件规则从旧别名（`--text`/`--muted`/`--gold`/`--panel`/`--r-*` …）迁移到语义名，并**删除了别名块**。
- `theme-gothic.css` 从 70 行的组件级覆盖压缩到 6 行（只剩字体族）。顶栏/品牌标/角色卡/行动键/行动坞改为消费 `--gradient-chrome`/`--gradient-brand-mark`/`--gradient-card`/`--gradient-control`，**主题不再需要伸进组件选择器**。
- 顺带修掉 3 个**从未定义过**的令牌引用（`--gold-mid`、`--mono`、`--text-dim`，无 fallback，声明实际无效）。

**踩到的坑（重要）**：别名层 `--text: var(--text-primary)` 会**静默破坏主题切换** —— 自定义属性在声明它的作用域里只替换一次，主题在子元素覆盖 `--text-primary` 时别名仍持根作用域的值。实测 gothic 主题下 `.pc-name` 仍是 slate 色。这也是删除别名块的直接原因，而不是原计划的「保留别名慢慢改」。

**新增 `scripts/probe-design-tokens.mjs`（`pnpm probe:tokens`）**：断言无硬编码 px 字号、无「别名指向主题可覆盖令牌」、无无 fallback 的未定义引用。已用注入法验证该守卫**确实会报错**（不是空转）。

### Phase 2 · 外壳与布局 ✅ 已完成（2026-10-28）

- 实现 `app-shell` Grid 骨架 + 三种 shell；
- 右侧面板迁入 `side` 区域（消除重叠的结构性来源）；
- 移动端底部抽屉行动栏；
- 加 `@container` 到玩家卡与行动扇形（按自身宽度重排，而非看视口）。

验收：390 / 820 / 1440 三档 `overlaps: none` 且无溢出；触控目标 ≥ 44px。

**实际落地**：

- 新增 `apps/web/src/ui/layout-shell.css`：`.ui-layer.app-shell` 用命名区域 `topbar / rail / board / side` 布局，**面板成为网格项**，重叠从"需要人工避免"变为结构上不可能。
- `styles.css` 中 6 条面板定位（`.topbar`/`.player-rail`/`.room-card`/`.mansion-minimap`/`.activity-feed`/`.action-dock`）的 `position:absolute` 与 `top/left/right/bottom` **直接删除**——不是覆盖，是移除死代码。absolute 从 **41 → 34**，剩余 34 条全部是浮层、伪元素与提示框，**无一条用于面板定位**。
- 三种 shell：桌面（≥1200 三栏）、平板（768–1199 两栏 + 信息栏改为右侧滑出）、手机（<768 单栏 + 角色栏滑出 + 行动坞改为**底部抽屉**，默认只露 44px 手柄）。
- `@container` 用于角色栏与信息栏（`container-name: rail / side`），按**自身宽度**而非视口重排。
- 顶栏响应式：`scenario-switch`(260px) 与 `viewer-switch`(168px) 是溢出主因，窄屏收起标签并限宽；手机端这两个控件**迁移进信息面板**（`applyShellLayout()` 移动同一批 DOM 节点，监听器与取值都保留），不是删功能。

**踩到的两个坑**：

1. **抽屉关闭态让外壳变成横向滚动容器**：滑出面板用 `translateX(100%)` 停在视口外，使 `.ui-layer` 出现 `scrollWidth 1052 > clientWidth 820`；点开抽屉时浏览器把它横向滚动，**整个网格左移 398px**。用 `overflow: clip` 修掉。
2. **抽屉本就该覆盖棋盘**：探针原先对所有面板两两断言"不重叠"，滑出面板必然失败。已改为**只对静态面板**断言不重叠，浮层单独断言"在视口内"。

**探针升级**：`pnpm probe:ui` 现在测 **12 个状态**（7 档视口的默认态 + 窄屏的抽屉展开态），因为关闭的抽屉对探针不可见——只测默认态等于没测里面那些面板。

### Phase 3 · 组件化 ⏸ 待评审（方案已就绪）

> 需要引入 Lit 依赖（~5KB），属用户评审项。**方案已写入下方，评审通过后才动代码。**

#### 3.1 先看清楚：23 处 `innerHTML` 不是同一种东西

盘点 `apps/web/src/ui/hud.ts` 的 23 处赋值，它们分成两类，价值完全不同：

| 类别 | 处数 | 位置 | 每次快照重建？ | 有持久状态吗 |
| --- | --- | --- | --- | --- |
| **常驻面板** | 7 | `renderMinimap` `renderHistory` `renderRoomCard`×2 `renderPlayers` `renderDock`×3 | **是** | **有**：滚动位置、悬停、焦点、展开态 |
| 临时浮层 | 10 | `openPayloadForm`×2 `showCardSheet`×2 `maybeShowHaunt`×2 `openActionDetail`×2 `closePayload` | 否（按需重建） | 无 |
| 小型注入 | 6 | `pushToast` `showAnnouncement` `showHoverHint` `renderViewerSelect` `renderScenarioSelect` `renderSkeleton` | 部分 | 基本无 |

**结论**：真正的问题是「常驻面板每次快照整段重建」——它把滚动位置、悬停态、键盘焦点一起冲掉。临时浮层重建没有代价，不需要组件化。

**实测证据**（在 `exploration` 剧本、1680×1050 下触发一次快照更新）：

| 观测项 | 结果 |
| --- | --- |
| 活动流首个 `.af-row` 的 DOM 节点身份 | **变了**（`sameNode: false`） |
| 给节点打的 `data-probe-tag` 标记 | **丢失**（`tagSurvived: false`） |
| 焦点在 `.af-head` 上时触发更新 | 焦点落到 `body`（`focusLost: true`） |

也就是说：整段重建 → 标记丢失 → 滚动与焦点随之归零。这不是推测，是测出来的。

#### 3.2 三个选项

| 选项 | 做法 | 收益 | 代价 |
| --- | --- | --- | --- |
| **A. 引入 Lit** | Web Components + 响应式属性，逐组件替换 | 组件边界清晰、按字段更新、生态成熟 | 新增 ~5KB 运行时；团队需熟悉 Lit |
| **B. 无依赖：键控更新** | 保留手写模板，把「整段重建」改为「按 key 复用节点、只改变化的文本」 | **零依赖**，直接解决滚动/焦点丢失这个真实痛点 | 需要自己写一份约 120 行的复用逻辑；组件边界仍靠约定 |
| **C. 维持现状** | 不改 | 无风险 | 滚动/焦点丢失长期存在；`hud.ts` 继续变胖 |

**推荐顺序：先做 B 的第一步（收益确定、零依赖），再决定是否需要 A。** 理由：B 解决的是**用户能感知的问题**（列表滚动跳回顶部、悬停丢失、按钮失焦）；A 解决的是**代码组织问题**。前者优先级更高，且做完 B 之后 A 的必要性会明显下降。

#### 3.3 若选 B：分三步，每步可独立合并

**B1 · 活动流键控更新**（收益最高，改动最小）
- `renderHistory` 由「整段 `innerHTML`」改为：按条目 id 复用 `<li>`，只更新变化条目的文本与类名；
- 验收：新增动态时**滚动位置不跳**、悬停高亮不丢；`pnpm probe:ui` 全绿。

**B2 · 行动扇形键控更新**
- `renderDock` 的扇形卡片按 `action.id` 复用，避免每帧重建导致悬停抬起状态被打断；
- 验收：悬停时快照更新（如倒计时）不再打断抬起与说明条。

**B3 · 角色栏与信息栏**
- `renderPlayers` / `renderMinimap` / `renderRoomCard` 同样按 id 复用；
- 验收：`hud.ts` 中「每次快照必执行的重建型 `innerHTML`」归零（临时浮层不计）。

**B 的验收判据**：新增 `scripts/probe-dom-stability.mjs` —— 触发一次快照更新，断言活动流/角色栏/扇形的**节点身份不变**（同一个 `Element` 引用）、滚动位置不变、`document.activeElement` 不变。这条断言能直接锁住本类回归。

#### 3.4 若选 A：迁移顺序与拆分

1. **`action-fan`**（交互最复杂，先啃硬骨头）：吸收 `renderDock` 的 3 处赋值与悬停/抽屉逻辑；
2. **`player-card` + `player-rail`**：吸收 `renderPlayers`；
3. **`activity-feed`**：吸收 `renderHistory`（顺带天然解决滚动/焦点问题）；
4. **`minimap` / `room-dossier`**：吸收 `renderMinimap` / `renderRoomCard`；
5. `hud.ts` 收敛为「订阅快照 → 分发属性」，10 处临时浮层保持原样（无持久状态，不值得组件化）。

#### 3.5 回退方案

- A 与 B 都是**逐面板替换**，任一时刻未迁移的面板继续用旧代码，**不存在半成品状态**；
- 每个面板独立分支、独立 PR，出问题只回滚那一个；
- 引入 Lit 前先跑一遍基线（`pnpm test:ui` + `probe:ui` 的 12 个状态），迁移后逐面板比对。

#### 3.6 需要你决定

1. **走 B（零依赖，先解决滚动/焦点）还是走 A（引入 Lit，重构组件边界）？**
2. 若走 A，是否接受新增 ~5KB 运行时依赖？

在你回复前不会改动 `hud.ts` 的渲染方式，也不会安装任何依赖。

### Phase 4 · 可访问性与多端收口 ✅ 已完成（2026-10-28）

- 键盘全流程可达 + `focus-visible` 样式；
- 对比度达 WCAG AA；
- `prefers-reduced-motion` 时关闭动效；
- 令牌导出为 DTCG JSON，为未来原生端/桌面端（Electron/Tauri）预留。

**实际落地**：

- 新增 `apps/web/src/ui/a11y.css`：全局 `:focus-visible` 焦点环（用 `!important` 覆盖此前 5 处 `outline: none`；金色主按钮改用深色环以免看不见）、`prefers-reduced-motion: reduce` 下把动画/过渡压到 0.01ms 并移除抽屉位移、`.sr-only` 与 `.skip-link` 工具类。
- `hud.ts`：**Escape** 关闭任何打开的滑出面板并把焦点还给对应切换按钮；切换按钮同步 `aria-expanded`（此前只有 CSS 属性，读屏软件看不到状态）。
- 新增 `scripts/probe-a11y.mjs`（`pnpm probe:a11y`），**18 项断言**：
  - 对比度：9 类正文元素 × 2 档视口，正文 ≥4.5:1、大字 ≥3:1，背景用**图层合成**计算（渐变首色标按 alpha 叠加，而非直接当作不透明色）；
  - 可访问名称：所有可见 `button`/`select` 必须有 `aria-label`/`title`/文本；
  - 键盘可达：所有可交互元素 `tabIndex ≥ 0`；
  - 焦点环：**用真实 Tab 键**检测（`:focus-visible` 对程序化 `.focus()` 不一定匹配，这一点最初写成 `.focus()` 会假失败）；
  - Escape 关闭滑出面板；
  - `prefers-reduced-motion` 下**没有任何元素**仍有动画或过渡。
- 新增 `scripts/export-design-tokens.mjs`（`pnpm tokens:export` / `tokens:check`）：把三层 CSS 令牌导出为 **W3C DTCG** JSON（76 primitives / 50 semantic / 1 theme），供未来原生或桌面端复用同一份真值。`--check` 模式可放进 CI 防漂移。

**踩到的坑**：`--surface-panel` 与 `--surface-panel-solid` 会拆进同一个分组路径，朴素嵌套写入会**丢掉其中一个**（导出数从 41 变 50 才暴露）。已按 DTCG 的 `$root` 约定处理"既是叶子又是分组"的节点。

---

## 5. 测试策略调整

现有 `test-ui-matrix` 只验证「页面能开、点得动」，不足以守住布局。新增一个**布局探针**（`scripts/probe-ui-layout.mjs`），对 3–4 档视口断言：

| 断言 | 判据 |
| --- | --- |
| 面板互不重叠 | 任意两面板 AABB 交集 ≤ 4px |
| 无溢出 | 所有面板在视口内 |
| 字号下限 | 所有文本节点 computed font-size ≥ 12px |
| 触控目标 | 所有 `button`/`[role=button]` 尺寸 ≥ 44×44（移动档） |
| 对比度 | 正文前景/背景 ≥ 4.5:1 |

这套断言能**在 CI 里拦住**本次这类回归（重叠、宽度归零、字号过小），而不依赖人眼。

---

## 6. 取舍与风险

| 取舍 | 说明 |
| --- | --- |
| **不整体重写为 React** | 1461 行手写模板整体重写的回归面太大；Lit 可增量替换，任一时刻都能停在可用状态 |
| **Phase 0 先止血** | 重叠与移动端宽度归零是**当前可用性缺陷**，不应等架构改造完成 |
| **容器查询优先** | 面板宽度受侧栏影响，媒体查询会判断错；但外壳形态仍用媒体查询，两者分工明确 |
| **Lit 引入需评审** | 新增运行时依赖（~5KB）。若不接受，退路是「vanilla + 极小响应式工具」，Phase 0–2 完全不受影响 |
| **不追求像素级复刻现有外观** | 字号上调会改变密度，局部需要重新调间距；这是可读性的必要代价 |

---

## 7. 建议的下一步

1. **先做 Phase 0**（半天，纯修缺陷，风险最低，立刻可见效果）；
2. Phase 1 与 Phase 2 可以并行开工，但**令牌必须先落地**，否则 Grid 改造时又要硬编码一遍；
3. Phase 3 的框架选型（Lit vs vanilla）建议在 Phase 1 结束前定，因为它决定组件写法。

若认可本方案，我可以按 Phase 0 → 1 → 2 的顺序逐段提交 PR，每段都带对应的布局探针断言。
