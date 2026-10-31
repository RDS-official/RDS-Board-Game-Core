# 可选开发与后续待办

> **本文件只记录「还没做」的事。** 已完成的问题按时间记在
> [SIMULATOR-AUDIT.md](SIMULATOR-AUDIT.md)（SA-xx）与
> [ARCHITECTURE-ISSUES.md](ARCHITECTURE-ISSUES.md)（AI-xx）里，不要在这里重复。
>
> 最近一次核对：2026-10-31（main `6ce4e9e`）。核对手法见 §7，**任何一条待办在动手前都应先按 §7 复核一次**——
> 本文件历史上出现过把已修问题挂成待办的情况。

---

## 0. 用户已确认的边界（2026-10）

1. **全量重建保留**：当前实体规模下作为 correctness-first 兜底，只做已完成的生命周期/阴影/预览优化。
2. **不构建真实 WebSocket/HTTP 服务器**：保留 `RoomTransport` / `RoomHttpAdapter` seam。
   后续 `packages/net/src/webrtc-transport.ts` 由另一位贡献者引入，属于浏览器 P2P，不属于服务端。
3. **i18n 不追求全量**：动作文案已 locale 化；静态 UI/chrome 留待办。
4. **游戏夹具只需功能完备**：保证 UI/应用层兼容性；官方版图、完整规则细节属于可选项。
5. **山屋滑梯/坍塌/熔炉保持"进入即触发"**：不新增"从上层主动滑下去"的主动动作
   （原版规则里煤槽没有该选项，避免自行发明规则）。已由 SA-89 提供前置 `⚠` 危险标记与触发反馈。

---

## 1. 渲染性能：已有基线，暂不优化

`BACKLOG` 曾把"实现通用 diff"列为待办并给出判据。**2026-10-24 已按该判据实测结案**：

```js
__boardGameApp.scene.getRenderStats()
// { calls, triangles, geometries, textures, lastSyncMs }
```

实测（`haunt_mummy` 开局，连续 20 次移动）：

| 指标 | 开局 | 20 次移动后 | 判据 | 结论 |
| --- | --- | --- | --- | --- |
| `geometries` | 252 | **252** | 不应单调增长 | ✅ 恒定 |
| `textures` | 37 | **37** | 不应持续增长 | ✅ 恒定 |
| `objects` | 69 | **69** | — | ✅ 恒定 |
| `lastSyncMs` | 偏大（首帧含建板，实测 168~306ms 波动） | **7.2 ~ 8.3ms** | < 16ms 可接受 | ✅ |
| `calls` | 373 | 689 | 记录基线 | 两个楼层场景各绘制一遍的固定开销，非泄漏 |

逐步采样显示 `calls` 在 373 / 689 之间摆动而非单调上升。**结论：不实现通用 diff / 对象池。**

若将来房间数或实体数显著增长导致 `lastSyncMs` 越过 16ms，优先做**静态棋盘层缓存（按 `mapGraph` 签名）**，而不是全对象 diff。

---

## 2. 内核表达力 Wave 3（AI-25 / K8·K9·K12·K14）

按 [KERNEL-EXPRESSION.md](KERNEL-EXPRESSION.md) 推进。**不要和表现层改造混在一个 PR 里。**

---

## 3. i18n TODO

- `actionText` + `app/i18n` 已覆盖动作标签；
- 静态 HUD/chrome 文案仍为中文硬编码；
- 后续若做多语言：把 HUD 固定文案抽 key、为 `phaseLabel`/任务目标/物品与房间名准备内容字典；
- **不要把翻译表放进 core / game state。**

## 4. 网络 TODO

- `RoomTransport` 接口与 `RoomHttpAdapter` 已就绪；
- 真实 WebSocket/HTTP server、连接管理、重连、背压不在当前范围；
- 部署时需补：鉴权 token 生命周期、多客户端广播、断线重连的 `revision/delta` 恢复；
- 浏览器侧 P2P 见 [LOBBY-INTEGRATION.md](LOBBY-INTEGRATION.md)（另一位贡献者的 `packages/net/src/webrtc-transport.ts`）。

## 5. 游戏夹具可选项（不影响内核/UI 兼容性）

- Catan 官方版图与全部规则细节；
- 更多山屋剧本、完整 50 个 haunt（当前 5 个：HAUNT #1/#3/#5/#6/#10）；
- 三国杀/沙丘/璀璨宝石的完整卡表与规则；
- 房间/卡牌官方美术。

## 6. 已明确不做（won't fix / 已结案）

| 项 | 结论 |
| --- | --- |
| AI-24 两阶段检定窗口 | 已实现（SA-104）：内核新增 `RollWindow` 原语（DECLARE → ROLL → REACT → RESOLVED），金库检定在拥有幸运道具时走通两阶段；无道具时保持单次结算，旧行为与回放哈希不变 |
| AI-23 山屋效果生命周期迁到 `EffectInstance` | 已实现（SA-100）：持续诅咒（DRIP/POSSESSION/CHILL/HAUNTING_MELODY/MARK_OF_FEAR）改由 `GameState.effects` 承载，模块只解释 `payload.effect`；`addEffect`/`removeEffects`/`effectsOn`/`ongoingEffectKinds` 统一入口，旧 `customProps.effects` 保留只读兼容 |
| 测试环境 502 噪音 | 已修：`test-ui-matrix` / `probe-overlap` 过滤 `/healthz` dev 代理噪音（仅白名单该条，真实错误仍报红） |
| `rotation-flow` 采样时机 | 已修：改用 `waitForFunction(controls.enabled)` 确定性等待补间结束 |
| AI-21 / AI-27 楼层隔离与小地图 | 已实现（SA-93）：3D 楼层过滤（draw call -56%~-74%）、raycaster 排除隐藏层、HUD 建筑切片小地图全联动 |
| AI-20 `placementRotation` 持久化 | 已实现：`session.ts` 用 `sessionStorage`（键含 game/seed/scenario/defId），无需再做 |
| AI-22 3D 卡面长描述截断 | 观点已定：DOM 卡牌详情为主，3D 只做摘要，不做长文渲染 |
| AI-26 全量重建改 diff | §1 实测未超预算，暂不做 |
| `BACKLOG` 旧 §5 的 4 个 P0 | 全部已修（见 §7 复核记录），从待办移除 |

---

## 7. 如何复核一条待办是否仍然成立

文档会漂移，**动手前先复核**。典型手法：

```bash
# 1) 待办声称"某处缺少 X" -> 先在源码里搜是否已存在
Select-String -Path packages/*/src/**/*.ts,apps/*/src/**/*.ts -Pattern "<符号名>"

# 2) 待办号称"未校验/未拒绝" -> 先看有没有对应的回归测试
Select-String -Path packages/harness/src/suite.ts -Pattern "<关键词>"

# 3) 性能类待办 -> 按 §1 跑一次 getRenderStats 再判断

# 4) 全量自检（口径见 AGENTS.md）
pnpm test && pnpm test:matrix && pnpm test:ui
pnpm probe:layout && pnpm probe:overlap
node node_modules/typescript/bin/tsc --noEmit && pnpm build
```

### 2026-10-24 的复核记录（旧「优先修复」整节 → 现已全部结案）

旧 §5 曾列出这些"待修复的框架性问题"，逐条核对结果：

| 旧待办 | 实际状态 | 证据 |
| --- | --- | --- |
| P0 `PLACE_ROOM` 非法旋转仍被接受 | 已修 | `registry.ts` `validatePayload`；`suite.ts` `invalid PLACE_ROOM rotation is rejected before reducer` |
| P0 隐藏节点 ID 从 `customProps/globalVars` 泄露 | 已修 | `suite.ts` `projections never leak hidden card faces` + `fixtures do not leak hidden ids after random play` |
| P0 NPC `controllerId` 无权限校验 | 已修 | `engine.ts` 校验 `controllerId`；`suite.ts` `non-controller denied` |
| P0 模块 `topologySpec` 与 `mapGraph.topology` 未交叉校验 | 已修 | `graph.ts` `validateTopology`；`suite.ts` `graph: directed/weighted topology queries and validation` |
| P1 selection 候选直接读 raw state | 已修 | 候选统一走 viewer projection |
| P1 棋盘目标模式是 session 隐式状态 | 已修 | `setViewer` / `rebuild` 清理 |
| P1 动作栏 24 条上限截断 | 已修 | 取消截断，`END_TURN` 固定最后 |
| P1 手牌 >7 张 3D 重叠 | 已修 | 手牌自适应 `cardScale` + step |
| P1 无目标模式点击 node/edge 直接执行 | 已修 | 改 inspect-first |
| P2 超长布局没有小地图/视口框 | 已修 | 见 SA-93：3D 楼层隔离 + 洋馆小地图 |
