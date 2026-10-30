# 质量门禁与 Lint 方案评估

> 触发来源：中期项 14「接入 lint」。本文先做**现状盘点 + 方案评估 + 分阶段落地计划**。
> 结论一句话：**先落 Biome（零配置即可用、与 tsc 解耦）做增量 lint/format，不一次性全仓改造**；
> 已在本次落地的补充门禁是 `pnpm docs:check`（文档路径有效性）。

---

## 1. 现状：已有的门禁

| 门禁 | 命令 | 覆盖 | CI 中执行 |
| --- | --- | --- | --- |
| 内核一致性 + 分层边界 | `pnpm test` | 206 例 + UI/app/kernel 静态 import 边界 | ✅ `deploy.yml` |
| 黑盒矩阵 | `pnpm test:matrix` | 五夹具 × 多 seed × 回放哈希 | 手工（改动 kernel/games 时） |
| 大厅自测 | `pnpm test:server` | Hub 房间/账号/私密房/座位 clamp | ✅ `deploy.yml` |
| 类型检查 | `tsc --noEmit` | 全仓类型 | CI 构建链路内 |
| 生产构建 | `pnpm build` | Vite 打包 | ✅ `deploy.yml` |
| 文档路径 | `pnpm docs:check` | 旧 `src/` 布局引用、失效文件链接 | ✅ `deploy.yml`（本次新增） |
| UI/布局/令牌/无障碍探针 | `pnpm probe:*` / `test:verify` / `test:ui` | 只在前端改动时跑 | 手工 |

## 2. 缺口

1. **没有 linter**：仓库没有 ESLint / Biome / oxlint，`package.json` 也无相应 devDependency。
   - 直接后果：未使用 import/变量、`==`、危险的非空断言、`any` 扩散、无用 `catch` 变量等
     只能靠 review 或 tsc（且 `noUnusedLocals` 未开启）发现；
   - `tsc --noEmit` 只做类型检查，不做风格/危险模式检查。
2. **没有 formatter**：缩进/引号/换行依赖人工对齐，长 diff 里常混入纯格式改动。
3. **巨型文件**：`packages/harness/src/suite.ts` 曾达 6.2k 行（已在中期项 14 拆分），
   说明「结构性约束」也需要工具辅助（如 `max-lines` warn）。

## 3. 候选方案对比

| 方案 | 速度 | TS7 兼容 | 规则覆盖 | 迁移成本 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **Biome 2.x**（Rust，lint+format 一体） | 极快（全仓 <1s 级） | 独立解析器，不依赖 tsc，天然兼容新 TS 语法 | 推荐规则集覆盖常见问题；插件生态弱于 ESLint | 低：单 binary + `biome.json`；可先只查改动文件 | ✅ **推荐** |
| ESLint 9 flat + typescript-eslint | 中（全仓数十秒） | 依赖 typescript-eslint 对 TS 版本的支持，TS 7 早期可能滞后 | 最全，可写仓库专属规则 | 中高：多包、多配置、需处理既有告警 | 规则需要复杂定制时再考虑 |
| oxlint | 最快 | 独立解析器 | 规则数少于前两者，TS 语义规则有限 | 低 | 可作为 pre-commit 快速档，不作为唯一 lint |
| 自研 AST 脚本 | — | 手写 TS API | 仅能量身定制少量规则 | 高 | 仅适合补充（如分层边界已由 `test-core` 静态检查实现） |

## 4. 推荐落地路线（分阶段，避免一次性大 diff）

### Phase 0（本次已做）
- 新增 `scripts/check-doc-paths.mjs` + `pnpm docs:check`，并接入 `deploy.yml`。
  它填补了「文档结构性正确性」这一层，也是 lint 之外最容易腐烂的路径引用问题。

### Phase 1：接入 Biome，只查增量（1 个 PR）
- `pnpm add -D @biomejs/biome`，提交 `biome.json`：
  - `formatter`：indentStyle space、indentWidth 2、lineWidth 110（贴合现状）；
  - `linter.rules.recommended: true`；
  - 覆盖项：`noExplicitAny: warn`（WebGL/three 边界存在合理 any）、
    `noNonNullAssertion: warn`、`noUnusedImports: error`（可自动修复）；
  - `files.ignore`: `dist`、`build`、`node_modules`、`shots`、`apps/server/data`。
- `package.json`：`lint`: `biome check .`、`lint:fix`: `biome check --write .`、
  `format`: `biome format --write .`。
- **先不接入 CI 阻断**：本地跑 `biome check` 建立基线、自动修复机械问题
  （未使用 import、格式），把剩余告警压到可接受数量并记入本文。

### Phase 2：CI 阻断（1 个 PR）
- `deploy.yml` 加 `pnpm lint` 步骤；
- 若全仓基线仍大，可先用 `biome check --changed`（仅 PR 改动文件）+ 每周全仓报告，
  稳定后切换为全仓阻断。

### Phase 3（可选）：结构性规则
- 规则化「巨型文件」：`max-lines: warn(1200)`（`suite.ts` 拆分后应满足）；
- 规则化分层边界：现有 `scripts/test-core.mjs` 的正则检查已覆盖，Biome 不重复实现；
- 若需要仓库专属规则（如「kernel 源码禁止 import @rds/*」更精确的 AST 判断），
  再引入 ESLint 作为补充而非替换。

## 5. 风险与注意事项

- **TS 7 兼容性**：typescript-eslint 可能滞后于 TS 7，因此首选解析器独立的 Biome；
- **一次性格式化会制造巨型 diff**：Phase 1 只对改动文件 `--write`，全仓格式化单独一个
  纯格式 PR（不夹逻辑改动），避免 review 失效；
- **规则不是越多越好**：`noExplicitAny`、`noNonNullAssertion` 先 `warn`，
  在 WebGL/three.js 边界保留逃生舱，避免为了过 lint 写出更糟的类型断言；
- **不要在 CI 里同时改 lint 与部署逻辑**：两步分开，便于回滚。

## 6. 验收（Phase 1 完成时）

1. `pnpm lint` 在干净仓上 0 error；
2. 告警数量记录在本文（目标：全仓 < 200 warn，且不新增 error）；
3. `pnpm lint` 不再改动任何游戏逻辑/内核语义（纯静态检查）；
4. `pnpm test` 206 / `pnpm docs:check` 全绿不受影响。
