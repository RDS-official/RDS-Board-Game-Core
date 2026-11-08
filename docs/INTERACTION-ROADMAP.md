# 交互改造收尾计划（2026-11-08）

> 本文件是"剩余目标"的可执行清单，对应 [INTERACTION-AUDIT.md](INTERACTION-AUDIT.md) §9 的未完成项。
> 执行顺序按"影响面 × 风险"排，每条都写明验收口径；做完一条就把状态改掉，不留"口头完成"。

## 0. 四条新需求（用户 2026-11-08 补充）

| 编号 | 需求 | 落点 |
| --- | --- | --- |
| N1 | 别人打出的动作卡也要在地图上落一张**真实卡面** | 出牌回响 `.hand-play-echo` 接入 `ports.entityCardArt` |
| N2 | 手牌 >N 张改**翻页**，不与拖拽抢手势 | `ui/cardHand` 分页 + 手牌条翻页器 |
| N3 | 一张牌就是一张牌："杀"不再裂成"杀曹操/杀关羽"，目标走二级菜单/多目标环，规则之外的目标准入即驳回 | `packages/app` 目标塌缩 + 径向选择器 |
| N4 | 手牌按**牌类分区**：普通牌 / 技能牌 / 物品牌 / 命令卡 | `UiAction.group` + 手牌排序与色标 |

## 1. 任务清单（2026-11-08 全部落地）

| # | 任务 | 交付物 | 验收 |
| --- | --- | --- | --- |
| A1 | ✅ 目标塌缩 | `session.ts#buildActionsView` / `BoundAction.targetVariants` / `perform` | `probe:card-hand`（2 张杀 / 0 个目标名） |
| A2 | ✅ 目标选择只走合法集合 | 径向选择器 + `perform(targets)` | `probe:unified-hand` 33 项 |
| B1 | ✅ 手牌分区 | `contracts.UiAction.group` + `hud` 排序/色标 | `probe:card-hand`（card→equip→skill→command） |
| C1 | ✅ 翻页 | `cardHand.ts#setPage/mountPage` + `#hand-pager` | `probe:card-hand`（8/8 挂载、2/2 翻页） |
| D1 | ✅ 回响带真实卡面 | `UiHistoryEntry.entityId` + `.hpe-face` | `probe:card-hand`（data:image/png） |
| E1 | ✅ 审计收口 | `INTERACTION-AUDIT` §9.3 + 本文件 | `verify:changed` 8/8 |

## 2. 不做（明确边界）

- 不做滚动手势：与拖拽冲突正是本次要消灭的问题（用户明确要求）。
- 不引入新框架：仍是零依赖 DOM + 单 rAF。
- 不给 3D 卡面加长文（AI-22 边界不变）。
