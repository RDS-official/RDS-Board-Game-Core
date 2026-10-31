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

一条铁律：**`main` 只接受经由 PR 的 Squash 合并**。本地合并、直推、merge commit 三者任意一个出现，
「可追溯」与「可回滚」同时失效。本节规则是为了让每次上线都能用一条 `git revert` 精确还原。

### 2.1 分支命名与生命周期
- **禁止直接向 `main` 分支提交或推送代码**（唯一例外见 §2.6 紧急流程）。
- 每次开发任务，必须基于最新的 `origin/main` 检出专属开发分支：
  ```
  users/<name>/<feature-or-fix-description>
  ```
  > 例如：`users/zooter/optimize-catan-ai`、`users/xhopo/fix-poker-settle-timer`
- `<task-name>` 用**小写连字符、单一意图**，禁止 `fix`、`wip`、`test`、`update` 这类无语义名。
  一个分支只做一件事；想顺手重构，另开分支。
- **寿命 ≤ 3 天，改动 ≤ 400 行**；契约类改动（§3.1 的公共文件）≤ 150 行。超出就拆成多个 PR。
- 每天开工先 `git fetch --prune`，分支上 `git rebase origin/main`；
  **禁止把 `main` 合并进功能分支**（`git merge origin/main` 会制造交叉历史，让 squash 回滚失效）。
- 只有自己的 `users/*` 分支允许 `git push --force-with-lease` 改写历史；
  `main` 与别人的分支**一律禁止强推**。
- 提交身份必须唯一：`git config user.name` / `user.email` 固定为本人常用账号，不要在同一个仓库里
  混用多个身份（否则 blame、CODEOWNERS、归属统计全部失真）。

### 2.2 开发与验证流程
1. **同步主分支**（只做快进，避免本地 main 漂移）：
   ```bash
   git switch main
   git pull --ff-only
   ```
2. **创建用户开发分支**：
   ```bash
   git switch -c users/<name>/<task-name>
   ```
3. **本地开发并自检**（参见 §3.2 验证矩阵，提 PR 前必须 `pnpm verify:all` 全绿）。
4. **提交并推送至开发分支**：
   ```bash
   git add <modified-files>
   git commit -m "feat/fix(scope): describe changes"
   git push -u origin users/<name>/<task-name>
   ```
5. **创建 Pull Request 到 `main` 分支**，标题带类型前缀，正文至少写四项：改了什么 / 是否动了公共契约 /
   跑过哪些闸门（贴命令）/ revert 这个 PR 是否安全：
   ```bash
   gh pr create --base main --head users/<name>/<task-name> --title "fix(scope): ..." --body "..."
   ```
6. **合并**：只用 §2.3 的标准动作，合并完立刻执行 §2.4 的清理。

### 2.3 合并方式：只允许 Squash Merge（唯一标准动作）

- 仓库设置必须锁定为「只允许 Squash」：关闭 Merge commit 与 Rebase merge，开启合并后自动删分支。
  管理员一次性执行（仓库名以 `git remote -v` 为准）：
  ```bash
  gh api -X PATCH repos/RDS-official/RDS-Board-Game-Core \
    -f allow_squash_merge=true -f allow_merge_commit=false -f allow_rebase_merge=false \
    -f delete_branch_on_merge=true -f allow_update_branch=true
  ```
- **唯一允许的合并命令**：
  ```bash
  gh pr merge <PR号> --squash --delete-branch
  ```
- **禁止** `gh pr merge --merge` / `--rebase`；**禁止**在本地 `git checkout main && git merge users/...`
  之后 `git push`；**禁止**在 `main` 上手工制造 `Merge branch 'users/...' into main`
  或 `Merge origin/main into main` 这类提交。
- Squash 提交标题沿用 PR 标题，**必须带 PR 编号**：
  ```
  fix(poker): 结算幕布不再提前消失 (#96)
  ```
- 为什么只许 Squash：一个 PR 在 `main` 上恰好留下**一个** commit，于是
  `git revert <sha>` 能精确撤销整件事、不多不少；历史是一条可读的直线，事故复盘时能顺着
  PR 号直接找到当时的动机、审查与验证记录。Merge commit 模式下，回滚需要 `revert -m 1`，
  一旦中间又合过别的分支就会连带回滚别人的代码。

### 2.4 合并后清理分支（必做，不是可选）

远端由 `gh pr merge --delete-branch` 与仓库级 `delete_branch_on_merge` 自动删除；本地手动收尾：

```bash
git switch main
git pull --ff-only
git branch -D users/<name>/<task-name>   # squash 后原 commit 不在 main 上，-d 会误报未合并，属正常
git fetch --prune                        # 清掉远端已删分支留下的 tracking ref
```

- 删除前必须确认该 PR 已是 `MERGED`，未合并的分支**永远不许删**：
  ```bash
  gh pr view <PR号> --json state,mergedAt
  ```
- 一次性清账（列出所有「PR 已合并」的远端 `users/*` 分支，人工过目后再删）：
  ```bash
  comm -12 \
    <(gh pr list --state merged --limit 500 --json headRefName --jq '.[].headRefName' | sort -u) \
    <(git for-each-ref --format='%(refname:lstrip=3)' 'refs/remotes/origin/users/' | sort -u)
  ```
- 本地长期不用的分支同样清掉；`git branch` 里出现已合并分支即视为未完成收尾。

### 2.5 可追溯与可还原（回滚）

每个 PR 必须满足三条可还原性，缺一条就不许合并：

1. **单一意图**：一个 squash commit 只做一件事。夹带顺手重构 = 事后无法只回滚其中一半。
2. **标题带 PR 号**：出问题能 `gh pr view <PR号> --json title,body,reviews` 还原当时的决策。
3. **正文写回滚影响面**：动到状态 schema、持久化文件、部署脚本、环境变量时，必须明确写
   「revert 是否安全 / 需要配套的数据迁移吗」；写不清就说明自己也没把握，先别合。

**回滚也走 PR**（保住 CI 与追溯链，回滚本身同样是可追溯的一次变更）：

```bash
git switch main && git pull --ff-only
git switch -c users/<name>/revert-<原PR号>
git revert --no-edit <squash-commit-sha>
pnpm verify:changed
git push -u origin users/<name>/revert-<原PR号>
gh pr create --base main --title "revert: 撤销 #<原PR号>（原因）" --body "..."
gh pr merge <新PR号> --squash --delete-branch
```

- **线上还原不需要登录服务器**：两条部署链路都监听 `main` 的 push（见 `docs/DEPLOY.md`），
  回滚 PR 合入后自动重新部署回退态；AWS 侧执行的是 `git reset --hard origin/main`，
  服务器工作区会自己对齐。
- **禁止**用 `git reset --hard` + 强推 `main` 回滚：会重写公共历史，所有人的分支与 PR 全部失联。
- **禁止**直接 `git revert -m 1 <merge-commit>`：这正是 §2.3 只允许 Squash 的原因之一。

### 2.6 紧急流程（唯一可以绕开评审的场景）

- 仅限**生产已经故障**且**CI 本身也在挂**：允许直接 push `main` 修复，但必须
  在 30 分钟内向团队说明「原因 / 影响面 / 后续补测动作」，并补一个说明性 PR 或 issue 留档。
- 故障恢复后立即回到 §2.3 的正常流程，不得把直推当成常态。
- 涉及凭据、鉴权的线上问题时，优先**降级而非硬修**（参照 §4 第 7 条）。

### 2.7 自动部署与上线机制 (CI/CD)
- 生产环境配置了 **GitHub Webhook 自动化流水线**：
  - 目标端点：`https://rdsbg.zooter.eu.org/api/github-webhook`
- **自动触发条件**：
  - 只有当变更**经由 §2.3 的 Squash 合并进入 `main`** 时，AWS 服务器才会触发自动化拉取与部署。
    直接 push `main` 仅在 §2.6 紧急流程下允许，同样会触发部署。
  - 服务器会自动执行：`git reset --hard origin/main` -> `pnpm install` -> `pnpm run build` -> `pm2 reload rds-board-core` -> `sudo systemctl reload caddy`。
  - 用户专属分支（`users/*`）的提交不会干扰生产环境运行。
- 因此**合并即上线**：PR 里的「回滚方式」一栏不是形式主义，是线上事故时唯一能照抄的步骤。

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

**能力优先于身份**：通用层（`packages/app`、`apps/web`)不得用 `meta.id === '<gameId>'` 或某款游戏的专有术语来决定表现；需要差异化时由游戏在 `GameModule.presentation`（`packages/kernel/src/module.ts` 的 `GamePresentationHints`：`cardPreviewOnHover` / `cardFacts` / `cardStyle` / `describeNode` / `describeTrait` / `traits` / `describeMoment` / `roleLabel`）里声明能力，框架给默认实现；声明统一用 `definePresentation()` 写，键的类型错误在加载时就抛 `TypeError`。回归守卫在 `packages/harness/src/suites/presentation.ts`。

**详情视图是中性结构**：`packages/app/src/contracts.ts` 的 `UiDetailView`（`key` / `title` / `subtitle` / `badge` / `tone` / `seal` / `desc` / `art` / `sections` / `actions`）不认识任何游戏词汇：类别文本走 `badge`（游戏本地化）、配色走不透明的 `tone` token（`danger` / `treasure` / `event` / `place`，由 `apps/web/src/ui/detailView.ts` 映射成 `--ink` / `--ribbon`）、装饰 glyph 走 `seal`、事实行走 `sections`（来自 `GamePresentationHints.cardFacts`）。新增表现一律加字段/加能力，不加 `if (gameId)`。

**浮层唯一仲裁**：`apps/web/src/ui/overlay.ts` 的 `OverlayArbiter` 是悬浮芯片（`peek`）与详情大卡（`pinned` / `modal`）的唯一状态源，两个通道都只向它申请、都只从它绘制。三条不变量：①同一 `key`（`entityDetailKey` / `nodeDetailKey` / `fixedDetailKey`）在屏上只有一个视图；②强度序 `peek < pinned < modal`，弱条目永不能驱逐强条目（指针漂移不能顶掉玩家点开的卡）；③条目只因显式关闭或更强条目接管而消失。新增任何浮层都要走 `arbiter.open()`，不要再直接操作 `#hover-hint` / `#card-sheet-layer` 的 DOM。

**发现时刻由游戏声明**：地图上新出现一个节点时，通用层只能判断「有新的 `node.id`」这一件事（`apps/web/src/ui/hud.ts` 的 `maybeRevealNode`：首帧只登记布局，之后把新 id 交给 `presenter.nodeDetail(nodeId)`）。给玩家看什么——房间档案的标题、副标题、事实行、脚注、是否全屏揭示——全部来自游戏的 `GamePresentationHints.describeNode`，经 `packages/app/src/inspect.ts` 的 `buildNodeDiscoveryView` 变成中性 `UiDetailView`。没声明 `describeNode` 的游戏不会弹任何过场，也不会因为没有房间概念而报错。

**数值阶梯与过场也由游戏声明**：角色卡上的四条阶梯、身份名、全屏过场都不是通用层知识。①`describeTrait(traitKey)` 给出一个阶梯的显示名、pip 简称、颜色、格数与伤害性质（`damageKind: 'MENTAL' | 'PHYSICAL'`，决定这一格掉的是神智还是体力）；②`traits(custom)` 从玩家自己的 `customProps` 里枚举出阶梯键值，通用层不再知道 `traitIndex` 这种字段名；③`describeMoment(state)` 把一个投影切片（`globalVars` + `mission` + 玩家名/身份）变成过场幕布（`key` / `kicker` / `caption` / `title` / `story` / `cast` / `objective` / `durationMs`），HUD 只按 `key` 记住「已经播过」，没声明就没有过场；④`roleLabel(role)` 把身份 token 变成中文名，角色卡与玩家栏共用。`apps/web/src/ui/hud.ts` 因此不含任何阶梯简称表、身份名或过场文案，pip 闪烁按不透明的 `pip.key`（`data-trait-key`）定位行。

### 3.2 必跑验证矩阵

**日常内循环**（改完就测，~50 秒）：

```bash
pnpm verify:changed   # 只跑本次 diff 可能影响的闸门（映射见下表），并发执行
pnpm test:ui          # 动了 UI/渲染时另跑（21 屏 worker 池 + 卡面 overlay 探针，~3 分钟）
```

**提交前 / 提 PR 前**（全绿）：

```bash
pnpm verify:all       # core + matrix + overlap + lint/structure + tsc/build + docs + UI + card-overlay，全部并发，~3.5 分钟
```

单条闸门（需要单独定位时）：

```bash
# 1. 必跑：内核 263 项一致性测试与架构边界静态检查（分片并行：CORE_SHARDS，默认 3）
pnpm test:core:parallel

# 2. 动了 packages/kernel/src 或 packages/games/src/* 时必跑：黑盒随机对局与回放哈希（按模块并行）
pnpm test:matrix:parallel

# 3. 动了 apps/web/src/render/procedural 时必跑：房间家具连通性与门位冲突（门位冲突数必须为 0）
pnpm probe:layout

# 4. 动了 roomTile.ts 或新增贴墙贴角构件时必跑：包围盒 z-fighting 几何硬约束检测（≤ ±1.42）
pnpm probe:overlap

# 5. 动了 UI、渲染交互时必跑：Playwright UI 矩阵（UI_WORKERS 控制并发，UI_SMOKE=1 只跑每游戏首屏）
pnpm test:ui

# 6. 必跑：文档路径有效性（旧 src/ 布局引用 / 失效链接）
pnpm docs:check

# 7. 必跑：Biome lint（0 error；当前基线 231 warning / 131 info 不阻断）
pnpm lint

# 8. 必跑：TypeScript 类型检查与生产编译构建
node node_modules/typescript/bin/tsc --noEmit && pnpm run build
```

---

## 4. 禁止事项（Anti-Hallucination & Safety）

1. **禁止直接操作 `main` 分支**：严禁 `git commit` 或 `git push` 直接打在 `main` 上，所有代码必须经由 `users/<name>/xxxx` 分支提 PR（紧急场景见 §2.6）。
2. **禁止非 Squash 的合并方式**：禁止 `gh pr merge --merge` / `--rebase`、禁止本地 `git merge users/...` 后推 `main`、禁止在 `main` 上制造 `Merge branch 'users/...' into main` 或 `Merge origin/main into main`。唯一标准动作是 §2.3 的 `gh pr merge <PR号> --squash --delete-branch`。
3. **禁止合并后不清理分支**：PR 合并即删分支（远端 + 本地 + `git fetch --prune`）。未确认 `MERGED` 的分支一律不许删；确认已合并的分支一律不许留。
4. **禁止重写公共历史**：`main` 与别人的 `users/*` 分支禁止 `git push --force` / `git reset --hard` 回滚；回滚必须走 §2.5 的 revert PR，禁止 `git revert -m 1 <merge-commit>`。
5. **禁止将生成图提交至仓库**：`shots/` 目录属于临时验证生成物，已被 `.gitignore` 忽略，严禁强行 `git add -f shots/`。
6. **禁止破坏状态纯粹性**：`GameState` 必须始终可进行 `JSON.stringify` 规范化序列化与 FNV-1a 哈希计算，严禁将类实例、回调函数存入状态中。
7. **禁止修改 Webhook 鉴权核心配置**：除非有特定需求，严禁改动 AWS 部署脚本 `/home/ubuntu/deploy-webhook/deploy-rds.sh` 及 Caddy 中的 Webhook 路由转发规则。
