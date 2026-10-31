# 质量门禁与 Lint 方案

> 触发来源：中期项 14「接入 lint」。
> 当前状态：**Phase 0（docs:check）与 Phase 1（Biome lint）已落地**；Phase 2（CI 阻断）与 Phase 3（结构性规则 / 全仓格式化）待做。
> 基线快照：2026-10-31 / `main 6ce4e9e` —— `pnpm test` 239 passed、`pnpm lint` 0 error / 231 warn / 130 info（224 files）。改动门禁后请同步更新本文与 AGENTS.md / README.md / CONTRIBUTING.md 里的数字。
> 结论一句话：用 **Biome 2.6.4** 做 lint + format（解析器独立、兼容 TS7、全仓 <1s），Phase 1 只接 lint 且只要求 **0 error**，
> 全仓格式化留作独立的纯格式 PR，避免巨型 diff 淹没 review。

---

## 1. 现状：已有的门禁

| 门禁 | 命令 | 覆盖 | CI 中执行 |
| --- | --- | --- | --- |
| 内核一致性 + 分层边界 | `pnpm test` | 239 例 + UI/app/kernel 静态 import 边界 | ✅ `deploy.yml` |
| Biome lint | `pnpm lint` | 全仓静态检查，0 error 为门槛（231 warn / 130 info 基线不阻断） | 本地必跑；CI 阻断待 Phase 2 |
| 黑盒矩阵 | `pnpm test:matrix` | 六夹具 × 多 seed × 回放哈希（当前 68 seed 对局 / 25 场景 / 4200 动作） | 手工（改动 kernel/games 时） |
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

### Phase 2：CI 阻断（单独 PR）
- `deploy.yml` 在 `pnpm docs:check` 之后加 `pnpm lint`（此时已是 0 error，可直接全仓阻断）；
- 若担心历史分支回退，可先 `biome lint --changed`，稳定后切全仓。

### Phase 3（可选）
- 全仓格式化 PR：`pnpm format`（建议同时把 `lineEnding` 与 git 换行策略对齐，避免 CRLF 噪声）；
- 结构性规则：`max-lines: warn(1200)`（`suite.ts` 拆分后应满足）；
- 需要仓库专属 AST 规则时再补 ESLint，而非替换 Biome。

## 8. 验收（Phase 1 实测结果）

1. `pnpm lint` 0 error —— ✅（231 warn / 130 info，退出码 0）；
2. `tsc --noEmit` 0 error —— ✅；
3. `pnpm test` 239/239 全绿 —— ✅；
4. `pnpm test:server`、`pnpm docs:check`、`pnpm build` 全绿 —— ✅；
5. 未改动任何游戏逻辑/内核语义：全部修复为括号/等价改写 —— ✅。
