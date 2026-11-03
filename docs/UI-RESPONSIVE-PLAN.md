# UI 响应式改造计划（全游戏壳层）
> 审计日期：2026-11-03 · 分支：`users/xhopo/ui-responsive-plan` · 场景：`?game=poker&scenario=seats_4`，4 人桌，真人 `p1` 开局后测。
> 约束：本计划只新增文档与审计脚本，不改产品代码。所有数字来自 [`scripts/probe-responsive-audit.mjs`](../scripts/probe-responsive-audit.mjs) 的实际运行，完整 JSON 与截图为 gitignored 的 `shots/responsive/`。

## 0. 结论摘要
- 14 个视口全部出现在实际 DOM 测量中；**0 个视口达到可发布标准**：5 个判定「不可用」，9 个判定「受限」。
- 页面级 `documentElement` 横向溢出全部为 0，但这是 `overflow: clip` 掩盖后的结果；1920×1080 与 2560×1080 的右信息栏实际分别有 7% 与 30% 被裁到视口外。
- 当前最严重的结构问题不是单个卡片，而是三套断点与最近追加的「桌面 1/7 面板」规则互相冲突：平板永久占据左角色栏，桌面却把左右栏压成 1/7 高；手机横屏（844×390 / 915×412）落入平板分支，常驻栏 + dock 合计覆盖 70% / 69% 的视口。
- 出牌区 `#hand-slot` 仅 5/14 个视口可见（≥1200 的 5 个桌面），其余 9 个视口无手持出牌区；手机展开 dock 后 4 张动作卡初始全部重叠在 `x=1`。

## 1. 测试方法与矩阵
### 1.1 运行方式
使用现有 `scripts/lib/soloserver.mjs` 的 `ensureSoloServer()` 启动/复用 `http://127.0.0.1:5180/`，用 `scripts/lib/browser.mjs` 的 `launchChromium()` 启动 Playwright Chromium。每页加载 `?game=poker&scenario=seats_4`，点击 `#boot-enter`（若存在），通过 `window.__boardGameApp.session.engine.dispatch({type:'START_HAND', playerId: engine.getActiveActorId()})` 开手；等待 1.8s 后测量并截图。

### 1.2 视口矩阵
| 设备/用途 | 视口（CSS px） | dsf | isMobile |
| --- | --- | ---: | --- |
| iPhone SE 竖屏 | 320×568 | 2 | 是 |
| iPhone 13 竖屏 | 390×844 | 3 | 是 |
| iPhone 13 横屏 | 844×390 | 3 | 是 |
| Android 竖屏 | 412×915 | 1 | 是 |
| Android 横屏 | 915×412 | 1 | 是 |
| iPad 竖屏 | 768×1024 | 1 | 否 |
| iPad 横屏 | 1024×768 | 1 | 否 |
| iPad Pro 11 | 1180×820 | 1 | 否 |
| HD 笔记本 | 1280×720 | 1 | 否 |
| 1366 笔记本 | 1366×768 | 1 | 否 |
| 1440 笔记本 | 1440×900 | 1 | 否 |
| FHD 桌面 | 1920×1080 | 1 | 否 |
| 超宽屏 | 2560×1080 | 1 | 否 |
| 竖置高平板 | 1024×1366 | 1 | 否 |

截图：`shots/responsive/<w>x<h>-<name>.png`；每页另存 `-side-open/-rail-open/-dock-open` 状态图。截图是 device pixel 尺寸，本文引用的是 CSS px。

### 1.3 测量口径
- 选择器：`.topbar`、`#player-rail`、`#side-column`、`#action-dock`、`#hand-slot`、`#canvas-container`、`#announce`、`.payload-layer`、`.activity-feed`、`.chip-ranking`、`.observer-rail`、`.room-card`、`.mansion-minimap`。
- 每项记录 bounding rect、计算样式 `display/visibility`、祖先是否隐藏、`scrollWidth/clientWidth`、`scrollHeight/clientHeight`、`clippedX/clippedY`。`visibleRect`/`visibleFraction` 还扣除了祖先 `overflow: auto|hidden` 与视口本身造成的裁切；这能识别「rect 在视口里，但被可滚动父容器裁掉」的情况。
- 文字裁切：统计 `.pc`、`.rank-row`、`.act` 中 `scrollWidth > clientWidth+1` 或 `scrollHeight > clientHeight+1` 的可见元素。仓库中不存在 `.rank-row`（实测 0 个）；扑克实际行是 `.cr-row`（`apps/web/src/ui/hud.ts:1794`），脚本同时采集 `.cr-row` 与 `.ob-row`。
- 重叠：`dock×rail`、`dock×side`、`dock×hand`、`dock×board`、`topbar×board` 的面积（px²）与交集矩形。`board` 是覆盖全视口的 `#canvas-container`，因此 `dock×board`/`topbar×board` 分别等于 dock/topbar 面积，属于全屏 canvas 的预期叠放；真正需要警惕的是 `dock×rail/side/hand`。
- 浮层覆盖率：可见的 topbar、rail、side、dock、hand、announce、payload 面积之和除以 `vw*vh`；按需求使用「sum of areas」，不是并集，面板互相重叠时会重复计入。

### 1.4 原始结果（默认壳层，未打开抽屉）
缩写：`d×r/d×s/d×h` = `dock×rail/side/hand`；三项实测全部为 0。表格最后一列按「是否阻断主操作」分级，详见 §2。

| 视口 | topbar h | dock rect (`x,y w×h`) | rail (`w×h`) | side (`w×h`) | 横向溢出 | 关键遮挡 / 覆盖率 | 是否可用 |
| --- | ---: | --- | --- | --- | ---: | --- | --- |
| 320×568 | 57 | 0,472 320×96 | 隐藏 | 隐藏 | 0 | 无面板互遮；覆盖 27% | 不可用 |
| 390×844 | 57 | 0,748 390×96 | 隐藏 | 隐藏 | 0 | 无面板互遮；覆盖 18% | 不可用 |
| 844×390 | 57 | 168,167.2 676×202.8 | 140×325 | 隐藏 | 0 | 无面板互遮；覆盖 70% | 不可用 |
| 412×915 | 57 | 0,819 412×96 | 隐藏 | 隐藏 | 0 | 无面板互遮；覆盖 17% | 不可用 |
| 915×412 | 57 | 172.7,177.8 742.3×214.2 | 144.7×347 | 隐藏 | 0 | 无面板互遮；覆盖 69% | 不可用 |
| 768×1024 | 57 | 168,788.3 600×215.7 | 140×947 | 隐藏 | 0 | 无面板互遮；覆盖 39% | 受限 |
| 1024×768 | 57 | 192.3,531.1 831.7×216.9 | 164.3×703 | 隐藏 | 0 | 无面板互遮；覆盖 45% | 受限 |
| 1180×820 | 57 | 229,583 920×217 | 170×743 | 隐藏 | 0 | 无面板互遮；覆盖 41% | 受限 |
| 1280×720 | 68 | 182.8,467.9 548.6×232.1 | 182.8×102.8 | 182.8×102.8 | 0 | 无面板互遮；覆盖 23% | 受限 |
| 1366×768 | 68 | 195.1,530.9 585.4×217.1 | 195.1×109.7 | 195.1×109.7 | 0 | 无面板互遮；覆盖 20% | 受限 |
| 1440×900 | 68 | 205.7,662.9 617.1×217.1 | 205.7×128.6 | 205.7×128.6 | 0 | 无面板互遮；覆盖 18% | 受限 |
| 1920×1080 | 68 | 274.3,842.9 822.8×217.1 | 274.3×154.3 | 274.3×154.3（可见 93%） | 0 | 无面板互遮；覆盖 16% | 受限 |
| 2560×1080 | 68 | 365.7,842.9 1097.1×217.1 | 365.7×154.3 | 365.7×154.3（可见 70%） | 0 | 无面板互遮；覆盖 16% | 受限 |
| 1024×1366 | 57 | 192.3,1129.1 831.7×216.9 | 164.3×1289 | 隐藏 | 0 | 无面板互遮；覆盖 32% | 受限 |

补充：横向溢出全为 0 不代表安全；`layout-shell.css:499-501` 给 `.app-shell` 设置了 `overflow: clip`，会把越界面板直接裁掉。1920/2560 的 side 原始宽度为 274.3/365.7，但视口内只能看到 254/254（93%/70%）。

## 2. 问题清单
### P1（阻断/严重）
**P1-1 横屏手机被当成平板：常驻角色栏 + dock 吞掉 70% 视口。**

- 现象：844×390 的 rail 为 `140×325` 且常驻，dock 为 `676×202.8`，浮层覆盖率 70%；915×412 为 `144.7×347` / `742.3×214.2`，覆盖率 69%。两处 `#hand-slot` 均隐藏，4 张 `.pc` 全部内容裁切。
- 根因：现有断点只按宽度。`layout-shell.css:170` 的 `@media (max-width:1199px)` 让 768–1199 仍保留 rail 列（`176-181` 行），只有 `@media (max-width:767px)`（`217` 行）才把 rail 改成 fixed slide-over（`232-254`）。844/915 宽度越过 767，因此永远进不了手机分支，也没有横屏高度条件兜底。
- 影响：横屏手机上棋盘只剩很窄的可视区域，Dock 直接盖住桌面下沿；这是最优先要拆掉的组合。

**P1-2 桌面 1/7 面板上限把左右栏压成一条窄带。**

- 现象：1280×720 的 rail / side 均为 `182.8×102.8`；side 的 `scrollHeight/clientHeight = 305/103`，排行只露出 48.3%，近期动态可见比例为 0%。1920×1080 两端面板 `274.3×154.3`，side `287/154`，动态仍为 0%。2560×1080 两端 `365.7×154.3`，排行可见 50.3%，动态为 0%。
- 根因：最近追加的紧凑桌面规则 `layout-shell.css:841-845` 设置 `--panel-cap-w: calc(100vw / 7)`、`--panel-cap-h: calc(100vh / 7)`；`904-910` 又强制左右栏 `width: var(--panel-cap-w); max-height: var(--panel-cap-h); overflow-y: auto`。1/7 高与信息量完全不匹配。
- 影响：桌面用户必须在一个 100–154px 高的滚动窗口里读玩家卡和排行；“常驻”变成了“常驻但不可读”。

**P1-3 出牌区 `#hand-slot` 在 1200 以下全部消失。**

- 现象：`handSlotVisible` 只在 1280/1366/1440/1920/2560 为 true，9/14 视口为 false；768×1024、1024×768、1180×820、1024×1366 以及全部手机都没有手持出牌区。
- 根因：`.hand-slot` 默认 `display:none`（`dock-fan.css:420-423`），只在 `@media (min-width:1200px)` 里 `display:block`（`layout-shell.css:115-128`）；没有 tablet/phone 的替代表示。
- 影响：触屏/平板用户无法查看当前选中的牌、无法执行长按确认类出牌操作；这属于功能缺口，不是装饰差异。

**P1-4 手机展开 dock 后，4 张动作卡初始全部重叠在 `x=1`。**

- 现象：320/390/412 三台竖屏手机，展开后的 dock 高度分别为 292.4/292.4/292.5px，但 4 个 `.act` 的 rect 依次全部是 `x=1, y=487/763/834`；只有最上面一张可点。相同页面移动指针后，320 的四张变为 `x=68.3/84/155.4/175.7`，说明布局函数能算，只是打开时没算。
- 根因：`hud.ts:3463-3472` 的 dock-toggle 处理只改 `data-dock` / `aria-expanded`，不调用 `layoutActionFan()`；`hud.ts:3447` 只在 `pointermove` 调用、`3454` 只在 `resize` 调用。fan 在折叠时是 `display:none`，初始 `clientWidth=0`，所以打开前也没有可用的布局结果。
- 影响：首屏动作选择直接坏掉，且不是视觉小瑕疵——用户会以为没有其他动作。

**P1-5 右信息栏在超宽桌面溢出视口右侧。**

- 现象：1920 的 side 原始宽度 274.3，但可见宽度只有 254（7% 被裁）；2560 原始宽度 365.7，可见只有 254（30% 被裁）。桌面排行可见比例只有 48.3%–67.1%（2560 为 50.3%），排行榜百分比区域被截断。
- 根因：`--panel-cap-w` 随 `100vw/7` 增大（`layout-shell.css:843`），但 `--side-w` 上限仍是 254px（`layout-shell.css:25`），网格列宽（`layout-shell.css:34`）没有跟随；`margin-right: 20px`（`layout-shell.css:79`）又把右边界推出视口。父层 `overflow: clip` 只负责把错误藏起来。
- 影响：越宽的桌面越读不到右侧数据，和「大屏更舒适」的目标相反。

### P2（功能受损/工作量大）
**P2-1 所有常驻角色栏的玩家卡都在纵向裁切，平板姓名被压成「玩…」。**

- 现象：只要 rail 可见，4 张 `.pc` 的 `clipped` 都为 4。768×1024 的卡片 `140×104`，内容 `scrollHeight/clientHeight = 114/102`，`.pc-name` 可用宽仅 19.3px（`truncated=true`）；844×390 为 18.8px，915×412 为 23px。1280 的卡片高 72，内容 132/70。
- 根因：`hud.ts:58` 定义 `PLAYER_CARD_HEIGHT=104`，`hud.ts:2416` 计算 `max(72, min(104, round(rail.clientHeight/2)))`，`2441` 把固定高度写进卡片；而 `.pc` 是 `overflow:hidden`（`styles.css:563`），姓名又被 `white-space:nowrap + text-overflow:ellipsis`（`styles.css:644-652`）。平板 `@media` 只给 rail `clamp(160,18vw,190)`（`layout-shell.css:172`），远小于卡片所需宽度。
- 影响：玩家识别、筹码、位置等关键信息在平板不可读；这不是「空间不够」的合理降级，因为仅 4 人桌也裁。

**P2-2 手机 dock 折叠态只有 96px，首屏内容本身已被裁。**

- 现象：320/390/412 的 collapsed dock `scrollHeight/clientHeight = 115/95`，首屏只露出把手和「当前目标」上半段；320 展开后 dock 高 292.4，浮层覆盖率达到 61.5%（默认 26.9%）。
- 根因：`layout-shell.css:285-291` 在折叠时隐藏 `.dock-fan` 并设 `max-height: 96px`；`271-282` 仍保留了完整的面板 padding、背景与内容。若再用绝对定位把底部文字压进去，就会裁字。
- 影响：用户必须多点一次才看见动作，折叠态又没有足够的摘要信息；这是移动端操作成本与内容完整性的双重损失。

**P2-3 右栏是「一个堆叠滚动条」，不是可扫读的信息栏；抽屉也缺少真正的模态语义。**

- 现象：844×390 的打开态 side `287×325`，内容 `336/325`，底部 11px 被裁；320 抽屉 `275×503`，排行 + 动态 + 目标全部纵向堆叠。默认桌面 1280 的 side 内动态始终不可见（`visibleFraction=0`）。
- 根因：`hud.ts:1366-1376` 只把 `.room-card/.mansion-minimap/.chip-ranking/.observer-rail/.activity-feed` 依次塞进一个 side column；没有 tablist/tabpanel。抽屉打开逻辑在 `hud.ts:1444-1453`，DOM 中没有 scrim/backdrop 元素，只有 `Escape` 处理（`1398-1418`），也未看到焦点陷阱。
- 影响：排行、动态、观察席争夺同一纵向空间；抽屉打开时背景仍可交互，键盘焦点可逃到被遮挡区域。

**P2-4 3D 相机的取景仍按整块 canvas 计算，没有扣除常驻栏/抽屉。**

- 现象：844×390 的浮层覆盖率达到 70%，但相机仍按整个 844×390 canvas 的 aspect 取景；1024×768 覆盖率 45%、768×1024 为 39%，棋盘主体与 dock/rail 相互挤压。桌面 1280 的 side/rail 只有 1/7 高虽然不挡中心，但也没有为信息栏留出安全边界。
- 根因：`scene.ts:1208-1212` 的 `framingScale()` 只看 `window.innerWidth`；`scene.ts:2788-2844` 的 fit 只用 camera aspect 与 board bounds；`scene.ts:4993-4999` 的 `onResize()` 直接按 `container.clientWidth/Height` 更新。整个渲染层不知道 rail/side/dock 的占位。
- 影响：抽屉一开，主体被覆盖；在小横屏上这不是「视觉差一点」，而是桌面主体不可见。

### P3（需顺手补齐）
**P3-1 窄屏顶栏的「角色」直出、「信息」藏在菜单里，不一致且没有横向安全区。**

- 现象：390×844 顶栏 57px，实际可见 𝒢 +「☰ 菜单」+「▤ 角色」，没有信息入口；点开菜单才能看到 `.topbar-actions` 里的信息开关。桌面 1/7 顶栏也只剩 𝒢 + 菜单。
- 根因：`hud.ts:1331` 的 rail toggle 在 `.topbar-actions` 之外，而 `hud.ts:1356` 的 side toggle 在 `.topbar-actions` 之内；`layout-shell.css:943-945` 在 <1200 把整个 `.topbar-actions` 设为 `display:none`，因此两个入口命运不同。手机顶栏 padding 只有 `0 var(--space-2)`（`layout-shell.css:530-533`），没有 `env(safe-area-inset-left/right)`。
- 影响：入口发现性差；横屏刘海/圆角可能吞掉右侧按钮。

**P3-2 触控目标：桌面 activity feed header 仅 34px 高。**

- 现象：1280/1366/1440/1920/2560 的 `touchTargets.under44 = 1`，唯一元素是 `.af-head`（高 34px、宽 272–364px）。
- 根因：触控保底规则 `layout-phase0.css:62-75` 只在 `max-width:820px` 或 `pointer:coarse` 生效；桌面宽屏的 `.af-head` 没有 44px 下限。
- 影响：触控笔记本/混合设备上难以准确展开动态；不改布局也能修，但应纳入验收阈值。

## 3. 设计目标与断点体系
### 3.1 目标
1. 任意视口 `documentElement.horizontalOverflow === 0`，且所有常驻面板 `visibleFraction === 1`；不用 `overflow: clip` 掩盖越界。
2. 默认壳层（抽屉全关）浮层覆盖率 ≤25%；抽屉只允许一次开一个，打开时必须有 scrim，且棋盘安全区域 ≥55%。
3. `.pc`、`.rank-row/.cr-row`、`.act` 的 `clipped` 全部为 0；角色姓名不得被压到 1–2 个字，卡片最小可用宽度 248px。
4. 所有动作卡在打开 dock 后横向分离、全部可点；触控目标 ≥44×44px。
5. ≥900px 必须有手持出牌表示；≥1200 保留竖版 hand-slot，900–1199 使用横向缩略。

### 3.2 四档断点
| 档位 | 宽度 | topbar 高 | 左角色栏 | 右信息栏 | dock 几何 |
| --- | --- | ---: | --- | --- | --- |
| compact | <600 | 52px | 抽屉 `min(320px,92vw)` | 抽屉 `min(340px,94vw)` | 底部 sheet；折叠 64px；展开 `min(62dvh,560px)`；动作行横滑 |
| phone | 600–899 | 56px | 抽屉 `min(340px,88vw)` | 抽屉 `min(360px,92vw)` | 底部 12px；宽 `calc(100% - 24px)`；折叠 72px；展开 max 58dvh |
| tablet | 900–1199 | 60px | 抽屉 `min(360px,78vw)` | 抽屉 `min(380px,84vw)` | 底部 16px；宽 `min(860px, calc(100% - 32px))`；max-height 212px |
| desktop | ≥1200 | 64px | 常驻 `clamp(200px,15vw,236px)` | 常驻 `clamp(248px,16vw,288px)` | `left: calc(100vw/7)`；`width: calc(3*100vw/7)`；max-height 240px |

补充规则：

- **面板只在桌面常驻，其余一律抽屉**：`<1200` 时 rail 与 side 都不参与网格，仅 `position: fixed` 的 drawer；`900–1199` 的平板不例外。
- **横屏手机优先规则**：`@media (orientation: landscape) and (max-height: 520px)` 强制走 phone/compact 的底部 dock 方案；不得因为宽度 844/915 落入 tablet。此条直接修复 P1-1。
- 桌面取消 `--panel-cap-w/h` 的 1/7 上限；左右栏最大高度统一为 `calc(100dvh - var(--topbar-h) - 2 * var(--shell-edge))`，内容自滚动。
- `--topbar-h` 只作为高度 token，不再由 1/7 面板宽度参与计算；桌面顶栏恢复整行，窄屏才用 `𝒢+☰`。
- 抽屉宽 = `min(设计宽度, 视口 - 24px)`；所有 drawer 内边距 16px，卡片最小宽度 248px。

## 4. 逐区域改造方案
### 4.1 顶栏
已完成的窄屏收敛保留：`<1200` 只显示 `𝒢 + ☰`，隐藏 `.brand-text`、`.game-switch`、`.topbar-actions`（现有 `layout-shell.css:933-971`）。补充：

- 抽屉菜单按「局内」「视图」「面板」「工具」分区：局内含游戏页签/场景；视图含机位与滤镜；面板含角色/信息/观察；工具含撤销/音效/诊断/关于。当前手机把 rail toggle 放在外面、side toggle 放在 menu 内（P3-1），统一移入「面板」区。
- 桌面 ≥1200 恢复整行 64px 顶栏，显示品牌、游戏页签、场景/滤镜和动作群；不设 `width: 100vw/7`（`layout-shell.css:849` 当前值必须去掉）。
- 横屏安全区：顶栏左右 padding 用 `max(var(--space-2), env(safe-area-inset-left/right))`；若为 standalone PWA，高度再叠加 `env(safe-area-inset-top)`。当前只有 dock 有 `env(safe-area-inset-bottom)`（`layout-shell.css:275`）。

### 4.2 左角色栏
- `<1200` 全部改为滑出抽屉：默认关闭，`translateX(-100%)`，宽按 §3.2；打开时加 24px 左侧安全边距、全高 `overflow-y:auto; overscroll-behavior: contain`，并锁定背景滚动。
- 抽屉内禁止鱼眼绝对定位：卡片改为普通纵向列表，`height:auto; min-height:112px; overflow:visible`，`.pc-head` 用 `grid-template-columns: 34px minmax(120px,1fr) auto`；`.pc-score` 的「筹码」标签 `white-space:nowrap`。这直接消除 `hud.ts:2416` 的固定高度裁切和 `.pc-name` 19.3px 截断（P2-1）。
- 桌面保留鱼眼堆叠作为可选的 10 人模式，但每卡最小高度 132px、角色栏可滚动；若人数 ≤4，直接普通列表。`PLAYER_CARD_HEIGHT` 与 `layoutPlayerRail` 的固定高度必须改成分支逻辑，不得再把 104 写死。
- 关闭按钮、`aria-expanded`、焦点返回触发按钮；打开时 `#canvas-container` 的交互禁用。

### 4.3 右信息栏
- `<1200` 同样改为右侧抽屉；`900–1199` 不再保留常驻 side。
- 抽屉内改成分页签：`排行` / `动态` / `观察` / `房间`（房间/小地图只在当前游戏有对应内容时显示）。排行、动态各自滚动，tab 用 `role=tablist/tab`，选中态持久化到会话内存；不再把所有面板纵向堆到一个 325px 高的容器里。
- 桌面 side 使用 §3.2 宽度，`max-height: calc(100dvh - ...)`；所有子面板 `flex:0 0 auto`。1920/2560 必须恢复 100% 可见宽度（修复 P1-5）。
- 排行表 `.cr-row` 使用 `minmax(0,1fr)` 名称列和右对齐数字；不允许整行被 `overflow:hidden` 裁掉。轮次/百分比列在窄抽屉里改为第二行，而不是缩字。

### 4.4 动作栏 dock
- 桌面保持 `1/7 → 4/7`（`layout-shell.css:103-112` 的几何不变），但高度交给内容，最大 240px；`--dock-reserve` 应参与约束，不再让 dock 进入 rail/side 轨道。
- 平板（900–1199）改为底部横滑 dock：`position: fixed; left:16px; right:16px; bottom:16px; width:auto; max-height:212px`；动作行用 flex + `overflow-x:auto; scroll-snap-type:x proximity`，每个 `.act` 至少 76×68，去掉绝对 `translate` 鱼眼（`dock-fan.css:362-387`）。
- 手机（<900）保留底部抽屉，但折叠高度 ≤72px、展开 ≤58dvh（compact 档 ≤62dvh）；`padding-bottom: max(8px, env(safe-area-inset-bottom))`，左右也加 `env(safe-area-inset-left/right)`。打开 dock 时必须在下一帧调用 fan 布局或直接 flex 排布；这是 P1-4 的根因修复。
- 动作行横向滑动时保持当前目标摘要固定在顶部；不把“四张牌叠在 x=1”作为初始状态。

### 4.5 手持出牌区 hand-slot
- ≥1200：保留现有竖版 3:4 卡匣（`layout-shell.css:115-128`），宽度 `clamp(160px,11vw,260px)`，与 dock 同一底部基线。
- 900–1199：改为横向缩略卡，放在 dock 上方或 dock 右端的安全区内，建议 `width:min(360px,44vw); height:120px`；图标、动作名、计数横排，点击展开详情。不要用 `display:none` 结束。
- <900：不单独占浮层，合并进 dock 的「当前选中动作」卡：dock 顶部显示同一个 `hs-card` 的 icon/label/count，长按 1.5s 仍有效。取舍是失去「浏览动作时同时看到手持牌」的持续可见性，但避免在 568px 高的屏幕上再叠 200px 卡匣；用 `aria-live` 播报当前选中动作。
- 所有档位都要保留 `aria-label`、`tabindex`、长按取消距离与键盘等价操作；隐藏时不能只是 `display:none`，应先确认替代操作存在。

### 4.6 3D 棋盘视野
- 给 `BoardGameScene` 增加 `setContentInsets({top,left,right,bottom})` 或等价方法；抽屉状态变化时由 `hud.ts` 通知 scene。
- `fitCameraToBoard()` 用「content rect」的宽高而不是整 canvas 的 `camera.aspect`；取景目标中心按可用区域中心偏移，保持棋盘主体落在 scrim/抽屉之外。可参考现有 `scene.ts:2788-2844` 的 fov 公式，但输入改为安全矩形。
- `onResize()`（`scene.ts:4993-4999`）继续全画布渲染，但相机 fit 额外读取 insets；抽屉打开时相机只做小幅 shift/zoom，禁止瞬间跳到新位置。桌面抽屉不常驻，只有平板/手机需要补偿。
- 验收时以「安全矩形内棋盘中心 + dock/rail 外沿」人工截图复核，并检查默认覆盖率 ≤25%。

## 5. 交互与可访问性
- **焦点顺序**：触发按钮 → drawer 关闭按钮 → tablist → 当前 tab 内容 → 卡片；drawer 打开时给背景 `inert`，关闭后把焦点还给触发按钮。当前 `syncShellAria()` 只同步 `aria-expanded`（`hud.ts:708-717`），不足以表达 drawer 关系，补 `aria-controls`、`aria-label`、`role=dialog`（抽屉）。
- **Esc / 遮罩**：现有 Escape 关闭 menu、rail、side（`hud.ts:1398-1418`），但没有 backdrop 元素；新增统一 `.shell-scrim`，点击遮罩关闭，点击抽屉内部不关闭。menu 与 drawer 不能同时打开。
- **reduced motion**：已有全局 `prefers-reduced-motion`（`a11y.css:39-64`），新增的 drawer/camera/动画必须沿用；相机补偿和 drawer transform 改为无动画状态，不保留半开位置。
- **触控目标**：所有按钮、tab、关闭按钮、`.act`、`.af-head` 至少 44×44；当前 `.af-head` 34px 是实测回归（P3-2）。手机 dock 动作卡最小 76×68，满足 44。
- **横屏安全区**：topbar 左右、dock 左右/底部、rail/side 底部均处理 `env(safe-area-inset-*)`；不可只给 dock 底部做（现有 `layout-shell.css:275` 仅覆盖底部）。
- **选中态与提示**：fan/卡片不能只靠 hover 显示信息；当前 fan-hint 已处理（`dock-fan.css:11-42`），需保持键盘 focus 也触发提示。

## 6. 实施分期（4 个 PR，单一意图）
### PR 1 · 断点与壳层（约 150–250 行）
- 文件：`apps/web/src/ui/layout-shell.css`、`apps/web/src/ui/hud.ts`（`applyShellLayout`、`data-*` 同步）、`apps/web/src/ui/styles.css`（scrim）。
- 内容：删除桌面 1/7 cap；落地四档 token；<1200 强制 rail/side 抽屉；加入 landscape-phone 覆盖规则；修正 side 宽度/越界；加 backdrop。
- 验收：14 视口 `document.horizontalOverflow=0` 且所有常驻面板 `visibleFraction=1`；默认覆盖率 ≤25%；rail/side 在 <1200 默认隐藏；rail 宽 <600 时不产生横向滚动。

### PR 2 · 玩家卡与信息分页（约 100–180 行）
- 文件：`apps/web/src/ui/layout-shell.css`、`apps/web/src/ui/styles.css`、`apps/web/src/ui/hud.ts`（`renderPlayers`、`layoutPlayerRail`、side tabs）。
- 内容：卡片最小宽度 248px、去固定高度、去掉平板鱼眼；右栏分页签（排行/动态/观察/房间）。
- 验收：所有视口 `.pc` clipped=0、`.pc-name` truncated=0 且可用宽 ≥120px；`.cr-row/.ob-row` clipped=0；任意抽屉内 `scrollHeight ≤ clientHeight × 1.05`，超出时单 tab 自己滚动。

### PR 3 · dock 与 hand-slot（约 150–250 行）
- 文件：`apps/web/src/ui/dock-fan.css`、`apps/web/src/ui/layout-shell.css`、`apps/web/src/ui/hud.ts`（`layoutActionFan`、dock toggle、hand）。
- 内容：桌面保留 1/7→4/7；平板/手机横滑 dock；打开 dock 后立即布局；hand-slot 的三档表现（竖版/横向/合并）。
- 验收：所有视口 dock 打开时 `.act` 的 `uniqueX == visible` 且全部 `fullyInViewport`；`.act` clipped=0；手机折叠态 ≥44px 可点；≥900 的 `handSlotVisible=true`；触控 under44=0。

### PR 4 · 相机、焦点和安全区（约 100–180 行）
- 文件：`apps/web/src/render/scene.ts`、`apps/web/src/ui/hud.ts`、`apps/web/src/ui/a11y.css`、`apps/web/src/ui/layout-shell.css`。
- 内容：`setContentInsets`、相机 fit 补偿；scrim/inert/focus trap；safe-area；reduced-motion 检查。
- 验收：各 drawer 打开时棋盘主体在安全矩形内；ESC/遮罩关闭；焦点不离开打开抽屉；`prefers-reduced-motion` 下无过渡；横屏 topbar/dock 不碰刘海。

每个 PR 完成后跑：

```text
node scripts/probe-responsive-audit.mjs
node node_modules/typescript/bin/tsc --noEmit
node node_modules/@biomejs/biome/bin/biome lint . --diagnostic-level=error
node scripts/verify.mjs --changed
```

## 7. 验收脚本
```text
node scripts/probe-responsive-audit.mjs
```

- 脚本使用 `ensureSoloServer()`，默认端口 5180；若已有 solo server 则复用。输出 14 个视口的状态行、最后的 JSON table，并写入：
  - `shots/responsive/responsive-audit.json`：完整 JSON（每个面板的 rect/visibleRect/scroll/clip、文字裁切、overlap、coverage、action metrics、drawer 补充状态）。
  - `shots/responsive/<w>x<h>-<name>.png`：默认壳层截图；另有 `-side-open.png`、`-rail-open.png`、`-dock-open.png` 证据图。
- 读字段：
  - `panels.<key>.rect` 是原始 CSS px；`visibleRect`/`visibleFraction` 才代表真正可见区域（已合并祖先 overflow 裁切）。
  - `clippedY` / `scrollHeight/clientHeight` 看是否是滚动容器裁切；`.pc` 的裁切会是 `clipped=true` 且 `scrollHeight > clientHeight`。
  - `textClipping['.pc'] / ['.act'] / ['.cr-row']` 是元素数；`.rank-row` 在仓库不存在，结果恒为 0，不能当作通过依据。
  - `overlapPairs`：`dock×rail/side/hand` 必须为 0；`dock×board` / `topbar×board` 是 canvas 全屏所致，不能机械判失败。
  - `coverage.ratio` 是面板面积和，默认目标 ≤0.25；`handSlotVisible` 用于检查 900+ 档。
  - `verdict` 是当前审计的保守阈值：coverage >65%、dock 不可用、动作卡同 x 或 panel-panel 重叠 >1000px² 会判「不可用」；其余为「受限」或「可用」。
- 当前基线：5 个不可用（320×568、390×844、844×390、412×915、915×412），9 个受限，0 个通过。首轮 PR 应先把「不可用」清零，再逐步收紧到全部「可用」。

## 待确认

- PR 1 实施后，1280/1366/1440 的默认浮层覆盖率为 31%/29%/27%，仍高于 §3.1 的 ≤25% 目标。这不是断点/抽屉问题：四档与 <1200 抽屉均已落地，剩余面积来自 §3 要求的 `min(42vh, 420px)` 常驻面板与尚未改造的桌面 dock / hand-slot（PR 3）。是否接受该阶段性超标，待 PR 3 收口？
- 为让 844×390 / 915×412 的默认覆盖率 ≤25%，横屏 phone 档将 topbar 压到 48px、折叠 dock 设为 520×72；这与 §3.2 表中 phone 的 56px topbar / 全宽 dock 不完全一致。若坚持表格原值，需要另找约 3–5% 的面积预算。
- tablet（900–1199）的 dock 在 PR 1 中默认折叠为 72px 抓手、展开上限 212px；最终 tablet dock 交互仍留给 PR 3 确认。
- PR 2 后 320×568 的角色抽屉内容高 592px（4 张 132–134px 卡片 + 间距），抽屉可视高 516px，因此角色栏自身滚动约 76px；`.pc` 本体 `clipped=0`。§6 PR 2 的「抽屉 scrollHeight ≤ clientHeight × 1.05」按字面不满足，但角色卡列表与信息分页不同，是否接受该滚动？
- PR 2 的桌面鱼眼只在 >4 人时启用；4 人及以下改为普通列表。1920×1080 下 4×142px 卡片超出 `--panel-cap-h: 420px` 而滚动。若要求 4 人桌面也不滚动，需要提高桌面面板高度上限或压缩卡面，待确认。
- 1280 宽桌面 rail 的卡片可用宽为 158.8px、`.pc-name` 97px：高于 80px 下限，但低于 §6 PR 2 写的 120px 目标。这是桌面 1/7 宽度上限的直接结果；是否接受，或留待调整桌面 rail 宽度？
- 信息分页只包含「排行 / 近况 / 观察席」；`room-card` / `mansion-minimap` 保持分页之外。非扑克局默认的「排行」为空，是否要在无排行数据时自动回退到「近况」？当前按需求保持默认「排行」。
