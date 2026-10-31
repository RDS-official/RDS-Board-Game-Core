# 参与开发

面向第一次 clone 这个仓库的人。目标：**十分钟内跑起来，并且知道改完之后怎么证明没改坏。**

---

## 1. 环境

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20 | 仓库用 ESM + 顶层 await |
| pnpm | 12.14.0 | `package.json` 的 `packageManager` 已锁定，装了 corepack 可以自动拉 |

```bash
pnpm install
pnpm run dev        # http://127.0.0.1:5173/
```

浏览器端是 Three.js + HUD 的可视化调试器；内核本身不依赖浏览器，可以用 Vite SSR 直接在 Node 里跑（见 `scripts/test-core.mjs`）。

### 字体

界面与画布共用一个中文字体：**阿里巴巴普惠体 Regular**（`public/fonts/Alibaba-PuHuiTi-Regular.woff`，免费商用）。

- DOM 侧通过 [styles.css](apps/web/src/ui/styles.css) 的 `@font-face` 引入，`--font-ui` / `--font-display` 都以它打头；
- Canvas 侧（房间地板、卡牌、指示牌、数字片）统一走 [apps/web/src/render/fonts.ts](apps/web/src/render/fonts.ts) 导出的 `CANVAS_FONT_STACK`，**不要**再写字面量 `"Segoe UI"`，否则贴图与 HUD 会用到不同字形；
- 画布贴图只画一次并进缓存，所以 `main.ts` 用 `ensureCanvasFontsReady()` 把首次绘制卡在字体解码之后；缺字体时会降级到系统字体而不是白屏。

换字体时改三处：把 woff 放进 `public/fonts/`、改 `@font-face` 与 `--font-ui`、改 `fonts.ts` 里的 `UI_FONT_FAMILY`。

### 截图与 UI 测试需要无头浏览器

`scripts/shoot*.mjs` 与 `scripts/test-ui-matrix.mjs` 会按下面的顺序找浏览器：

1. 环境变量 `CHROME_PATH`
2. 系统安装的 Chrome（Windows / macOS / Linux 的常见路径）
3. Playwright 自带的 Chromium

所以只要 `pnpm install` 后执行过一次 `npx playwright install chromium`，**任何平台上都能直接跑**；机器上有 Chrome 也可以完全不装。

它们都会**自己起停 dev server**，不需要你另外开一个终端。端口可以用 `BASE_URL` 覆盖：

```bash
BASE_URL=http://127.0.0.1:6000/ pnpm shots
```

---

## 2. 验证矩阵

改完之后按影响面选择，全绿再提 PR。

| 命令 | 覆盖 | 何时必跑 |
| --- | --- | --- |
| `pnpm test` | 内核一致性 244 例 + 分层边界检查 | 任何改动 |
| `pnpm docs:check` | 文档路径有效性（旧 `src/` 布局引用、失效链接） | 动任何 `.md` / 目录结构 |
| `pnpm test:matrix` | 六款夹具 × 多 seed × 全场景黑盒 + 回放哈希 | 动 `packages/kernel/src` 或任一 `packages/games/src/*` |
| `pnpm test:ui` | Playwright 流程矩阵（拖拽/旋转/落定/悬停） | 动 `apps/web/src/render`、`apps/web/src/ui`、`packages/app/src` 契约 |
| `pnpm probe:layout` | 47 个房间的家具布局与**门位冲突**（必须 0） | 动 `props.ts` / `roomLayout.ts` / 房间摆件清单 |
| `pnpm probe:overlap` | 房间几何是否越过板块 footprint（**z-fighting 回归**） | 动 `roomTile.ts`、新增贴墙构件 |
| `tsc --noEmit` + `pnpm build` | 类型与生产构建 | 提交前 |

### 两条硬约束（踩过坑）

1. **单块房间的几何必须落在自身 ±1.42 内**。棋盘格距 2.86、板块边长 2.84，相邻板块净距只有 0.02；越界就会进入邻块并与邻块共面，产生 z-fighting 闪烁。新增贴墙/贴角构件后跑 `pnpm probe:overlap`。
2. **家具不允许堵门，也不允许切断门之间的连通**。布局引擎会做门廊禁区 + AABB 互斥 + 连通性洪水填充；跑 `pnpm probe:layout` 确认门位冲突为 0。

---

## 3. 截图不进仓库

`shots/` 已在 `.gitignore` 中。需要图的时候现场生成：

```bash
pnpm shots            # 全部套件（core / betrayal / rooms / card）
pnpm shots rooms      # 只跑名称匹配的
```

生成的文件是**验证用的临时产物**，不要提交。文档里提到的 `shots/xxx.png` 都是这些文件名。

---

## 4. 分层边界（会被测试拦住）

```
apps/web/src/ui        只 import ../app/contracts
packages/app/src       拥有引擎，向 UI 暴露 DTO
packages/kernel/src      纯 JSON 状态 + 纯函数转移，不存函数/时间/随机
packages/games/src/*   只实现 setup / legalActions / reduce / outcome
apps/web/src/render    Three.js 表现层，不写核心状态
```

`pnpm test` 内含静态检查：UI 一旦 import `core/games/render/net/ai` 就失败。改 UI 时如果发现"必须拿到引擎内部数据"，正确做法是**扩展 `contracts.ts` 的 DTO**，而不是把依赖接进 UI。

---

## 5. 提交前自检

```bash
pnpm test && pnpm test:matrix && pnpm test:ui
pnpm probe:layout && pnpm probe:overlap
node node_modules/typescript/bin/tsc --noEmit && pnpm build
```

- 新增规则/卡牌/剧本 → 同步更新 [docs/BETRAYAL.md](docs/BETRAYAL.md) 的覆盖表；
- 修掉一个手测问题 → 在 [docs/SIMULATOR-AUDIT.md](docs/SIMULATOR-AUDIT.md) 登记 `SA-xx`，保留复现描述；
- 涉及内核表达力的缺陷 → 写进 [docs/KERNEL-EXPRESSION.md](docs/KERNEL-EXPRESSION.md)，不要在单款游戏里打补丁。
