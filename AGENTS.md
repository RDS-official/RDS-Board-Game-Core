# AGENTS.md — RDS-Board-Core AI Agent 开发与协作规范

本文件是面向在此仓库中进行开发、重构或测试的 AI Agent 统一规范与准则。请在执行任何代码变更前仔细阅读并严格遵守。

---

## 1. 核心定位与技术栈

- **项目定位**：通用桌游内核框架（Universal Board Game Kernel）及基于 Three.js + Rapier 3D 物理引擎的 Web 可视化调试模拟器。
- **运行环境**：
  - Node.js ≥ 20（ESM 模块规范）
  - pnpm 12.x（本机 pnpm 路径：`/home/zooter/.npm-global/bin/pnpm`，已锁定构建依赖 `esbuild`）
  - TypeScript 7.x + Vite 8.x
- **生产服务**：
  - 公网站点：`https://rdsbg.zooter.eu.org/`
  - 架构：AWS Lightsail (Ubuntu 24.04) + PM2 (`rds-board-core`) + Caddy 反向代理 + 本地静态文件加速托管。

---

## 2. 分支规范与 Git 工作流（CRITICAL）

为保证生产环境与主分支的稳定，必须严格执行以下工作流：

### 2.1 分支命名规范
- **禁止直接向 `main` 分支提交或推送代码**。
- 每次开发任务，必须基于最新的 `origin/main` 检出专属开发分支：
  ```
  users/<name>/<feature-or-fix-description>
  ```
  > 例如：`users/zooter/optimize-catan-ai`、`users/zooter/fix-betrayal-door-render`

### 2.2 开发与验证流程
1. **拉取最新主分支代码**：
   ```bash
   git checkout main
   git pull origin main
   ```
2. **创建用户开发分支**：
   ```bash
   git checkout -b users/<name>/<task-name>
   ```
3. **本地开发并进行全面自检**（参见第 3 节自检矩阵）。
4. **提交并推送至开发分支**：
   ```bash
   git add <modified-files>
   git commit -m "feat/fix(scope): describe changes"
   git push -u origin users/<name>/<task-name>
   ```
5. **创建 Pull Request 到 `main` 分支**：
   ```bash
   gh pr create --base main --head users/<name>/<task-name> --title "..." --body "..."
   ```

### 2.3 自动部署与上线机制 (CI/CD)
- 生产环境配置了 **GitHub Webhook 自动化流水线**：
  - 目标端点：`https://rdsbg.zooter.eu.org/api/github-webhook`
- **自动触发条件**：
  - 只有当 PR 被审核合并（或直接 push）到 **`main` 分支** 时，AWS 服务器才会触发自动化拉取与部署。
  - 服务器会自动执行：`git reset --hard origin/main` -> `pnpm install` -> `pnpm run build` -> `pm2 reload rds-board-core` -> `sudo systemctl reload caddy`。
  - 用户专属分支（`users/*`）的提交不会干扰生产环境运行。

---

## 3. 架构分层与提交前自检矩阵

### 3.1 分层边界硬约束
```
apps/web/src/ui        只允许 import ../app/contracts（严禁 import core/games/render/net/ai）
packages/app/src       拥有游戏引擎，向 UI 暴露 DTO（Presenter 契约）
packages/kernel/src      纯 JSON 状态 + 纯函数转移（严禁保存不可序列化函数、私有闭包或随机数实例）
packages/games/src/*   六款夹具，仅实现 setup / legalActions / reduce / outcome（游戏词汇/预览策略走 presentation 声明）
apps/web/src/render    Three.js 表现层，负责几何体渲染与物理演算，不直接修改核心逻辑状态
```

**能力优先于身份**：通用层（`packages/app`、`apps/web`)不得用 `meta.id === '<gameId>'` 或某款游戏的专有术语来决定表现；需要差异化时由游戏在 `GameModule.presentation`（`packages/kernel/src/module.ts` 的 `GamePresentationHints`：`cardPreviewOnHover` / `cardFacts` / `cardStyle` / `describeNode`）里声明能力，框架给默认实现；声明统一用 `definePresentation()` 写，键的类型错误在加载时就抛 `TypeError`。回归守卫在 `packages/harness/src/suites/presentation.ts`。

**详情视图是中性结构**：`packages/app/src/contracts.ts` 的 `UiDetailView`（`key` / `title` / `subtitle` / `badge` / `tone` / `seal` / `desc` / `art` / `sections` / `actions`）不认识任何游戏词汇：类别文本走 `badge`（游戏本地化）、配色走不透明的 `tone` token（`danger` / `treasure` / `event` / `place`，由 `apps/web/src/ui/detailView.ts` 映射成 `--ink` / `--ribbon`）、装饰 glyph 走 `seal`、事实行走 `sections`（来自 `GamePresentationHints.cardFacts`）。新增表现一律加字段/加能力，不加 `if (gameId)`。

**浮层唯一仲裁**：`apps/web/src/ui/overlay.ts` 的 `OverlayArbiter` 是悬浮芯片（`peek`）与详情大卡（`pinned` / `modal`）的唯一状态源，两个通道都只向它申请、都只从它绘制。三条不变量：①同一 `key`（`entityDetailKey` / `nodeDetailKey` / `fixedDetailKey`）在屏上只有一个视图；②强度序 `peek < pinned < modal`，弱条目永不能驱逐强条目（指针漂移不能顶掉玩家点开的卡）；③条目只因显式关闭或更强条目接管而消失。新增任何浮层都要走 `arbiter.open()`，不要再直接操作 `#hover-hint` / `#card-sheet-layer` 的 DOM。

**发现时刻由游戏声明**：地图上新出现一个节点时，通用层只能判断「有新的 `node.id`」这一件事（`apps/web/src/ui/hud.ts` 的 `maybeRevealNode`：首帧只登记布局，之后把新 id 交给 `presenter.nodeDetail(nodeId)`）。给玩家看什么——房间档案的标题、副标题、事实行、脚注、是否全屏揭示——全部来自游戏的 `GamePresentationHints.describeNode`，经 `packages/app/src/inspect.ts` 的 `buildNodeDiscoveryView` 变成中性 `UiDetailView`。没声明 `describeNode` 的游戏不会弹任何过场，也不会因为没有房间概念而报错。

### 3.2 必跑验证矩阵
在提交代码或提 PR 前，必须在终端执行以下检查确保全绿：

```bash
# 1. 必跑：内核 247 项一致性测试与架构边界静态检查
pnpm test

# 2. 动了 packages/kernel/src 或 packages/games/src/* 时必跑：黑盒随机对局与回放哈希一致性测试
pnpm test:matrix

# 3. 动了 apps/web/src/render/procedural 时必跑：房间家具连通性与门位冲突（门位冲突数必须为 0）
pnpm probe:layout

# 4. 动了 roomTile.ts 或新增贴墙贴角构件时必跑：包围盒 z-fighting 几何硬约束检测（≤ ±1.42）
pnpm probe:overlap

# 5. 动了 UI、渲染交互时必跑：Playwright UI 矩阵测试
pnpm test:ui

# 6. 必跑：文档路径有效性（旧 src/ 布局引用 / 失效链接）
pnpm docs:check

# 7. 必跑：Biome lint（0 error；当前基线 231 warning / 130 info 不阻断）
pnpm lint

# 8. 必跑：TypeScript 类型检查与生产编译构建
node node_modules/typescript/bin/tsc --noEmit && pnpm run build
```

---

## 4. 禁止事项（Anti-Hallucination & Safety）

1. **禁止直接操作 `main` 分支**：严禁 `git commit` 或 `git push` 直接打在 `main` 上，所有代码必须经由 `users/<name>/xxxx` 分支提 PR。
2. **禁止将生成图提交至仓库**：`shots/` 目录属于临时验证生成物，已被 `.gitignore` 忽略，严禁强行 `git add -f shots/`。
3. **禁止破坏状态纯粹性**：`GameState` 必须始终可进行 `JSON.stringify` 规范化序列化与 FNV-1a 哈希计算，严禁将类实例、回调函数存入状态中。
4. **禁止修改 Webhook 鉴权核心配置**：除非有特定需求，严禁改动 AWS 部署脚本 `/home/ubuntu/deploy-webhook/deploy-rds.sh` 及 Caddy 中的 Webhook 路由转发规则。
