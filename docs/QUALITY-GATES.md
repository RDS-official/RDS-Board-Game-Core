# 质量门禁与 Lint 方案

> 触发来源：中期项 14「接入 lint」。
> 当前状态：**Phase 0（docs:check）与 Phase 1（Biome lint）已落地**；Phase 2（CI 阻断）与 Phase 3（结构性规则 / 全仓格式化）待做。
> 基线快照：2026-10-31 / `main 6cb7f11` —— `pnpm test` 257 passed、`pnpm lint` 0 error / 231 warn / 131 info（231 files）。改动门禁后请同步更新本文与 AGENTS.md / README.md / CONTRIBUTING.md 里的数字。
> 结论一句话：用 **Biome 2.6.4** 做 lint + format（解析器独立、兼容 TS7、全仓 <1s），Phase 1 只接 lint 且只要求 **0 error**，
> 全仓格式化留作独立的纯格式 PR，避免巨型 diff 淹没 review。

---

## 1. 现状：已有的门禁

| 门禁 | 命令 | 覆盖 | CI 中执行 |
| --- | --- | --- | --- |
| 内核一致性 + 分层边界 | `pnpm test` | 257 例 + UI/app/kernel 静态 import 边界 | ✅ `deploy.yml` |
| Biome lint | `pnpm lint` | 全仓静态检查，0 error 为门槛（231 warn / 130 info 基线不阻断） | 本地必跑；CI 阻断待 Phase 2 |
| 黑盒矩阵 | `pnpm test:matrix` | 六夹具 × 多 seed × 回放哈希（当前 81 seed 对局 / 36 场景 / 4869 动作；三国杀场景按 1 seed × 60 步收敛） | 手工（改动 kernel/games 时） |
| 大厅自测 | `pnpm test:server` | Hub 房间/账号/私密房/座位 clamp | ✅ `deploy.yml` |
| 类型检查 | `tsc --noEmit` | 全仓类型 | CI 构建链路内 |
| 生产构建 | `pnpm build` | Vite 打包 | ✅ `deploy.yml` |
| 文档路径 | `pnpm docs:check` | 旧 `src/` 布局引用、失效文件链接 | ✅ `deploy.yml` |
| UI/布局/令牌/无障碍探针 | `pnpm probe:*` / `test:verify` / `test:ui` | 只在前端改动时跑 | 手工 |

## 2. 缺口与解决状态

1. ~~**没有 linter**~~ → **已解决（Phase 1）**：Biome 2.6.4，`pnpm lint` 0 error。
2. ~~**没有 formatter**~~ → **配置就绪、尚未启用**：`biome.json` 已写好 formatter 段，
   `pnpm format` / `pnpm format:check` 已加入 scripts，但 Phase 1 刻意不跑全仓格式化（见 §5 风险）。
3. **巨型文件**：`packages/harness/src/suite.ts` 曾达 6.2k 行（已在中期项 14 拆成 18 个 `suites/` 模块）；
   结构性规则（`max-lines`）留待 Phase 3。

## 3. 候选方案对比（选型结论）

| 方案 | 速度 | TS7 兼容 | 规则覆盖 | 迁移成本 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **Biome 2.x**（Rust，lint+format 一体） | 极快（全仓 <1s） | 独立解析器，不依赖 tsc，天然兼容新 TS 语法 | 推荐规则集覆盖常见问题；插件生态弱于 ESLint | 低：单 binary + `biome.json` | ✅ **已采用** |
| ESLint 9 flat + typescript-eslint | 中（全仓数十秒） | 依赖 typescript-eslint 对 TS 版本的支持，TS7 早期可能滞后 | 最全，可写仓库专属规则 | 中高 | 仅在需要仓库专属 AST 规则时补充 |
| oxlint | 最快 | 独立解析器 | 规则数少于前两者 | 低 | 可作 pre-commit 快速档，非唯一 lint |
| 自研 AST 脚本 | — | 手写 TS API | 仅能量身定制少量规则 | 高 | 仅作补充（分层边界已由 `scripts/test-core.mjs` 实现） |

## 4. Phase 1 实际落地（本 PR）

### 4.1 依赖与配置

- devDependency：`@biomejs/biome@^2.6.4`（`pnpm add -D` 时必须
  `npm_config_manage_package_manager_versions=false`，否则 devEngines 会把 pnpm 12 下载一遍）。
- `biome.json`（仓库根）关键项：
  - `vcs.useIgnoreFile: true`（复用 `.gitignore`，不再手写 ignore 列表）；
  - `files.includes: ["**", "!build"]`（`build/design-tokens.json` 是 tracked 生成物，不参与 lint；
    Biome 2 的 `useBiomeIgnoreFolder` 规则要求目录忽略写成 `!build` 而非 `!build/**`）；
  - `linter.rules.preset: "recommended"`（Biome 2.6 起 `rules.recommended: true` 已废弃）；
  - 覆盖：`correctness.noUnusedImports: "error"`、`suspicious.noExplicitAny: "warn"`。
- 关闭的既有规则及理由（大仓既有写法，开启会产生大量与本次目标无关的噪声）：

  | 规则 | 关闭理由 |
  | --- | --- |
  | `complexity.noThisInStatic` | 既有静态工厂方法内合法使用 `this`（返回本类静态成员），改动无收益 |
  | `complexity.noStaticOnlyClass` | 既有 `*Rules`/`*Checks` 静态命名空间类，是全仓既定组织方式 |
  | `complexity.noImportantStyles` | `apps/web` 样式里有刻意的 `!important` 优先级覆盖 |
  | `style.noNonNullAssertion` | 渲染/内核边界存在大量已论证的非空断言，改写成断言函数只会更啰嗦 |
  | `style.useImportType` | 既有代码统一用普通 import 引入类型，切换是纯风格 diff |
  | `style.noDescendingSpecificity` | UI 样式表选择器顺序是既有设计，非缺陷 |

### 4.2 为什么 `lint` 脚本用 `biome lint .` 而不是 `biome check .`

`biome check` = lint + format + assist。若直接用它，全仓 196 个文件会被 formatter 重排
（当前工作区是 CRLF、formatter 配置为 LF，逐文件全量 diff），一个「接 lint」的 PR 会变成
「接 lint + 全仓格式化」的巨型 PR，review 完全失效。

因此 Phase 1：
- `lint` → `biome lint .`（只做静态检查，0 error 即通过）；
- `lint:fix` → `biome lint --write --unsafe .`（只自动修 lint 可修项）；
- `format` / `format:check` → 已配置，**不进 CI、不作为门禁**，留给 Phase 3 的纯格式化 PR。

### 4.3 本次修复内容（语义全部不变）

- 机械修复：`biome lint --write --unsafe --only=correctness/noUnusedImports .` → 清理 13 个文件的未使用 import。
- 手工修复 20 处 error 级问题，均为「花括号包体 / 等价改写」：
  - `useIterableCallbackReturn` 19 处（`forEach` 回调隐式返回值）：`packages/kernel/src/{aop,rules,engine}.ts`、
    `packages/app/src/{session,netSession}.ts`、`apps/web` 7 个文件（渲染/大厅/HUD 等）；
  - `noDuplicateCase` 2 处：`packages/app/src/actionText.ts` 的 ACCEPT_TRADE / REJECT_TRADE 重复 case（死代码）；
  - `noVoidTypeReturn` 2 处：`packages/app/src/netSession.ts` 的 `return this.session.cancelPlacement()`；
  - `noAssignInExpressions` 3 处：`packages/kernel/src/prng.ts`、`packages/harness/src/suites/rulesBetrayal.ts`、
    `scripts/probe-ui-layout.mjs`；
  - `noUnsafeOptionalChaining` 1 处：`packages/harness/src/suites/rules.ts`；
  - `noImplicitAnyLet` 1 处：`packages/net/src/webrtc-transport.ts`；
  - `useButtonType` 1 处：`index.html` 的启动按钮。

## 5. 当前基线（2026-10，`pnpm lint`）

- **0 error / 231 warning / 130 info**（224 files，~200ms）。
- warning 分布（不阻断，作为后续清理清单）：
  `noExplicitAny` 90、`noUnusedVariables` 40、`useOptionalChain` 27、
  `noUnusedFunctionParameters` 9、`noUnusedPrivateClassMembers` 7、`useConst` 4、`useMathMinMax` 2。
- info 分布：`useTemplate` 78、`useLiteralKeys` 6、`useExponentiationOperator` 4、
  `noUselessEscapeInRegex` 2、`noUselessConstructor` 1、`useShorthandFunctionType` 1。
- 原始基线（未收敛的 `recommended` 全量 `check`）为 1592 diagnostics（196 format + 1396 lint），
  本次已把 error 清零，warn/info 保留。

## 6. 风险与注意事项

- **TS7 兼容性**：typescript-eslint 可能滞后于 TS7，故选解析器独立的 Biome；
- **一次性格式化会制造巨型 diff**：全仓格式化必须单独一个纯格式 PR（不夹逻辑改动）；
- **规则不是越多越好**：`noExplicitAny`、`noNonNullAssertion` 保持 warn/关闭，
  在 WebGL/three.js 边界保留逃生舱，避免为了过 lint 写出更糟的类型断言；
- **不要在 CI 里同时改 lint 与部署逻辑**：Phase 2 单独 PR；
- 工作区 CRLF vs 仓库 LF（`core.autocrlf=true`）会让 `format:check` 对所有文件报 diff，
  这是环境现象而非代码问题，也是 Phase 1 不启用 formatter 门禁的直接原因。

## 7. 后续阶段

### Phase 2：CI 阻断 ✅ **已落地**（`.github/workflows/ci.yml`）

PR 的必过 check 是汇总 job **`gate`**（`main` 分支保护已要求它）；`ci` 通过后
`auto-merge.yml` 自动 squash 合并并补触发一次 `deploy.yml`。完整说明见 §10。

### Phase 3（进行中）
- 全仓格式化 PR：`pnpm format`（建议同时把 `lineEnding` 与 git 换行策略对齐，避免 CRLF 噪声）—— 待做；
- 结构性规则：Biome 2.6.4 未开放可配置的 max-lines 规则，已由 `scripts/check-structure.mjs` 承接（非空行 1200 预算，随 verify 的 lint 门禁运行；当前为信息模式打印超标清单，设 `STRUCTURE_STRICT=1` 即变硬门禁，待 9 个超标大文件拆分后收紧）；
- 卡面 overlay 探针：`scripts/probe-card-overlay.mjs`（五款卡牌游戏 × 6 项断言：单实例、显式关闭清空、快速循环不涨 DOM、9s 自动关闭后无幽灵重开、无控制台错误），已并入 `pnpm test:ui` 与 verify 的 UI 门禁；
- 需要仓库专属 AST 规则时再补 ESLint，而非替换 Biome。

## 8. 验收（Phase 1 实测结果）

1. `pnpm lint` 0 error —— ✅（231 warn / 130 info，退出码 0）；
2. `tsc --noEmit` 0 error —— ✅；
3. `pnpm test` 257/257 全绿 —— ✅；
4. `pnpm test:server`、`pnpm docs:check`、`pnpm build` 全绿 —— ✅；
5. 未改动任何游戏逻辑/内核语义：全部修复为括号/等价改写 —— ✅。

---

## 9. 回归提速与 time / memory 门禁（2026-10-31）

一套完整回归原本要 ~16 分钟，其中 Playwright UI 矩阵占 85%。现在：

| 命令 | 覆盖 | 实测耗时 |
| --- | --- | --- |
| `pnpm verify` | core(3 分片) ∥ matrix(3 并发) ∥ probe:overlap ∥ lint+structure ∥ tsc+build ∥ docs，全部并发 | **~53s**（原顺序 ~2 分钟） |
| `pnpm verify:all` | 上面 + UI 矩阵 + probe:card-overlay | **~3.5 分钟**（原 ~16 分钟） |
| `pnpm verify:changed` | 只跑本次 diff 可能影响的闸门（按 AGENTS.md §3.2 映射） | **~47s** |
| `pnpm test:core:parallel` | 内核 253 例按用例下标分片（`CORE_SHARDS`，默认 3） | 42s → **26s** |
| `pnpm test:matrix:parallel` | 六个夹具各一进程（`MATRIX_PARALLEL`，默认 3） | 70s → **43s** |
| `pnpm test:ui` | 21 屏 worker 池（`UI_WORKERS`，默认 min(6, 核数-1)）+ 卡面 overlay 探针 | ~14min → **~3min** |

UI 矩阵的三个提速点（都不是砍覆盖）：

1. **并行**：一屏一 page，worker 池跑；超过 6 个 worker 反而变慢（vite 服务端成为瓶颈）。
2. **事件驱动等待**：`domcontentloaded` + 轮询 `session.revision` 取代 `networkidle` 与固定 sleep。此前每步点击后都等 revision 变化，但扇形卡第一步只开详情面板不派发动作，于是**每步白等 4s 超时**（6 步 ≈ 24s/屏）；改成按真实交互链（扇形卡 → `#ad-run` → 表单提交）后，单步从 ~5s 降到 ~0.5s。
3. **减少往返**：一次 `page.evaluate` 探测所有浮层，取代四次 `locator.count()`；`click({ force: true })` 跳过 hover 动画导致的稳定性等待。

### time / memory 门禁

`scripts/lib/gates.mjs`：每个套件结束时打印一行 `GATE <name>` 并按预算判定，超时或超内存即失败（退出码 1）。

| 套件 | 时间预算 | 内存预算（Node RSS） |
| --- | --- | --- |
| core | 120s | 900MB |
| matrix | 180s | 900MB |
| ui | 720s | 1400MB（另打印浏览器 JS heap 峰值） |

- 预算是实测值的 ~2 倍，机器噪声不会误伤；真正的回归（多了一层 O(n²)、每次用例重新加载夹具、引擎泄漏）会立刻被抓到。
- 覆盖：`GATE_SCALE=2` 整体放宽（慢 CI），或 `GATE_UI_MS` / `GATE_CORE_MB` 等单项覆盖。
- 内核套件还支持 `SUITE_SHARDS`/`SUITE_SHARD` 分片；矩阵支持 `MATRIX_MODULES`、`MATRIX_SEEDS`、`MATRIX_FAST=1`；UI 支持 `UI_ONLY=<regex>`、`UI_SMOKE=1`、`UI_TIMING=1`（打印每屏 boot/交互耗时）。

## 10. 现场排查：操作栏抖动（2026-11-01）

动作栏（`#action-dock`）的抖动只在特定显示器（高 DPI、120Hz）上肉眼可见，靠看代码
猜不出来，所以留了一条可带走的证据链：

- URL 加 `?docktrace=1`：左下角常驻计数器，每 0.5s 刷新
  `render / layout / shape / cards / move` 五类事件每秒发生多少次，以及鱼眼容器的
  `cw`（宽度）和 `span`（牌排实际跨度）。抖的时候看一眼：
  - `cards/shape` 在跳 → 是 DOM 在被反复重建（键控/顺序问题）；
  - `layout` 在跳而 `move` 不动 → 是布局输入在变（宽度/焦点被别的东西改了）；
  - 全部接近 0 但画面仍在闪 → 是合成层/过渡问题（CSS），不在 DOM。
- 控制台：`__dockTrace()` 直接取时间线（最近 160 条 + 计数器）。
- 「⤓ 导出诊断日志」里也带 `dock` 段：把 JSON 发回来即可定位。

同时做了三处硬化：指针移动期间关掉卡片位移过渡（`markFanMoving`，避免 120Hz 下
每次 pointermove 都打断 120ms 过渡）、`--fan-x` 半像素对齐、布局结果未变时不再写
样式（`data-fan-layout` 签名）。

### 10.1 根因（2026-11-01 定位并修复）

探针显示抖动时 `render / cards / shape` 几乎不增长（DOM 没有重建），`layout` 只在
指针移动时增加——症状是**纯 CSS**：

`a11y.css` 的 reduced-motion 块里有

```css
@media (prefers-reduced-motion: reduce) {
  .dock-fan .act:hover, .dock-fan .act:focus-visible { transform: none !important; }
}
```

而牌的水平位置当时正是靠 `transform: translateX(var(--fan-x))` 表达的。于是：
悬停 → `transform: none` → 牌弹回行首（左移约 300px）→ 指针不在牌上 → hover 失效
→ transform 恢复 → 牌弹回指针下 → 又悬停……约 **12Hz 的自激循环**，肉眼就是整排在
闪。与 DPI、刷新率、窗口大小完全无关，所以此前「动画/亚像素」方向的修补都无效。

修复两层：

1. 牌的水平位置改走独立的 `translate` 属性（`translate: var(--fan-x) 0`），`transform`
   只负责抬升与缩放——任何 hover / 主题 / 无障碍规则改 `transform` 都不会再影响位置；
2. `a11y.css` 里那条规则改成 `transform: scale(var(--fan-scale, 1)) !important`：
   减少动态效果只取消「抬升」，不再抹掉定位与缩放。

复现/验收方法：把指针停在动作牌中央 1 秒，`mouseover / mouseout` 应各为 0 次，牌的
`getBoundingClientRect().x` 不应跳变（修复前是 12Hz、±307px）。
---

## 11. CI 门禁与自动合并（2026-11-02）

两个 workflow：**`ci.yml`（必过门禁）** 与 **`auto-merge.yml`（合并器）**。
`deploy.yml` 保持原样，负责把 `main` 送上生产。

### 11.1 `ci.yml` 跑什么

分 job 而不是一个大 job：失败时一眼看出是「类型挂了」还是「UI 挂了」，静态检查
几十秒出结果，不用等浏览器。

| job | 何时跑 | 内容 | 超时 |
| --- | --- | --- | --- |
| `changes` | 总是 | 用 `git diff --name-only base...head` 分类改动面 | 5 min |
| `static` | 有代码或文档改动 | `pnpm lint` → `check-structure` → `tsc + build` → `docs:check` | 15 min |
| `core` | 任何代码改动 | `test-core-parallel`（3 分片，含分层边界） | 15 min |
| `matrix` | `packages/{kernel,games,harness}` | `MATRIX_FAST=1`（每夹具 1 seed，抓回放哈希） | 20 min |
| `server` | `apps/server/` | `pnpm test:server` | 10 min |
| `ui` | `apps/web` / `packages/app` / `.css` / 几何 | `UI_SMOKE=1`（每游戏首屏）+ Playwright Chromium | 25 min |
| `gate` | 总是 | 汇总：任一 job 失败则失败；`skipped` 视为「不适用」 | 5 min |

**哪些是精简的、为什么**：

| 本地全量 | CI 用的 | 理由 |
| --- | --- | --- |
| `pnpm verify:all`（8 闸门） | 同一批闸门，但按 diff 裁剪 | 只动 `.md` 的 PR 不该跑 Playwright |
| 矩阵 72 seed-runs / 27 场景 | `MATRIX_FAST=1`，每夹具 1 seed | 回放哈希与非法动作在单 seed 就会暴露；多 seed 留在本地 |
| `pnpm test:ui`（21 屏 + card-overlay） | `UI_SMOKE=1`（每游戏首屏） | 抓启动崩溃与首屏报错是最有价值的部分；深度 flow 留在本地 |
| `pnpm probe:overlap` / `probe:layout` | **不跑** | 只在动 `render/procedural` 时有意义，且需真实 WebGL；本地必跑（§5） |
| `pnpm probe:board` | **不跑** | 逐座位投影验证公共牌朝向与可读性；只在动 `render/scene.ts`、`layout.ts` 或扑克牌桌时才有意义（§POKER 10.2.1.1） |
| `pnpm probe:hand:view` | **不跑** | 逐视口投影验证自己的手牌不被操作区盖住；只在动 `render/scene.ts`、`hud.ts` 或 dock 布局时才有意义（§POKER 10.2.1.2） |

`GATE_SCALE=1.5` 把 `scripts/lib/gates.mjs` 的时长预算放大 1.5 倍：runner 是 2 核
共享机，软件渲染比开发机慢，不放大会因为「慢」而不是「错」失败。

### 11.2 分支保护

`main` 已要求必过 check **`gate`**（`strict: true`，即必须基于最新 main），
`enforce_admins: true`。**这意味着连管理员也不能直推 main**——AGENTS.md §2.1 的
「禁止直推」从约定变成了服务端强制（§2.6 紧急流程因此需要先临时摘掉保护）。

### 11.3 `auto-merge.yml`

`ci` 成功（`workflow_run` 触发）后，对同一次运行的 PR：

1. 必须是 `OPEN`、目标是 `main`、非草稿、**非 fork**、`MERGEABLE`；
2. `headRefOid` 必须等于这次 ci 检验的 head（期间有人 push 就等下一轮）；
3. 重新 `gh pr checks` 确认 `gate` 是 `SUCCESS`（不信缓存）；
4. `gh pr merge --squash --delete-branch`；
5. 合并成功后 **显式 `gh workflow run deploy.yml`**。

第 5 步不是多余的：GitHub 规定 **`GITHUB_TOKEN` 执行的操作不会触发新的 workflow**，
所以机器人合并产生的 push 不会唤醒 `deploy.yml`（京东云 rsync 链路）。

fork PR 一律不自动合并——任何人都能开 fork PR，自动合并等于把 main 的写权限交出去。

### 11.4 本地等价命令

```bash
pnpm verify:fast      # 内循环：类型 + lint + 核心（~30s）
pnpm verify:changed   # 提 PR 前：按 diff 裁剪（CI 跑的是同一套）
pnpm verify:all       # 合并前最终全量（CI 不跑的那部分在这里）
```
