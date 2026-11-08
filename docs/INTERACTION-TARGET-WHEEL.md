# 目标轮盘（Target Wheel）实现说明

> 对应 [INTERACTION-AUDIT.md](INTERACTION-AUDIT.md) §9.4 与 [INTERACTION-REDESIGN.md](INTERACTION-REDESIGN.md) §4。
> 拖拽驱动：从手牌里拖出一张"需要选目标"的卡时，全屏浮出被切成多块的多边形轮盘。

## 1. 交互

```
拖出手牌（越过 6px slop）
  ├─ 该动作不需要目标 → 不弹轮盘（数量类：先打出，再弹数值二级菜单）
  └─ 需要目标 → 目标轮盘浮现（磨砂全屏叠加，直径 ≈ 0.82 × 屏幕短边）
        指针在某个分区 → 该分区高亮（头像环加粗 + 名字加亮），**卡片缩小到 0.4**（让出提示位）
        指针在中心圆 → 中心高亮，**卡片放大回"屏幕 1/3"**（看清自己打出去的牌）
        指针在轮盘外 → 全部压暗，**卡片放大**
        松手：
          ├ 分区 → 对该目标 dispatch（卡飞桌 + 落桌回响）
          ├ 中心圆 → 卡片回弹 + 打开二级菜单（参数表单）
          └ 轮盘外 → 卡片回弹，什么都不发生
```

候选只来自 `action.selection.candidates`，也就是引擎认可的合法目标；真送进去非法目标也会被引擎驳回。

## 2. 几何

- **顶点数 = 候选数**，外轮廓是顶点连线成的多边形，中心是圆（`r0 = 0.26R`）。
- 扇区 = 中心圆上的内弧 + 两条脊柱 + 外侧直边；相邻扇区**共享边界**，因此并集恰好覆盖
  「多边形 − 中心圆」，无缝隙无重叠。
- 角度：`θ_i = start + i·(2π/n) + jitter_i`，其中 `jitter` **零均值**且 `|jitter| ≤ 7.5%·step`
  → 每块角宽偏差 ≤ ±15%，面积差 < 15%（"看起来随机、量起来近似等分"）。
- 半径：`R_i = R + jitterR_i·R`，`|jitterR| ≤ 8%`，只让轮廓不呆板。
- 抖动来自 **12 组常量表**（`JITTER`）+ `seed = hash(candidateIds)`：O(n) 查表，n=8 时几何 <20µs，
  且同一次拖拽只算一次（拖动中不重建，杜绝"看着在这个区、判在另一个区"）。
- 命中测试与渲染共用同一份 `θ[]/R[]`；`r < r0` → 中心，`r > 1.12R` → 轮盘外（取消）。

## 3. 视觉

| 元素 | 取值 |
| --- | --- |
| 叠加层 | `radial-gradient` 深色 + `backdrop-filter: blur(18px) saturate(150%)`（磨砂，桌面可辨但不抢戏） |
| 扇区 | 白色 5.5% 打底；高亮 = 玩家色 26% + 该色 70% 描边（1.5px）；其余分区降到 50% 不透明度 |
| 头像 | 44–56px 圆牌（`avatarUrl` 或首字），环色 = 玩家色，高亮时环宽 2→3 |
| 名字/提示 | 名字 14px；`hint` 12px（"距离 1 · 手牌 3"之类，缺省不占位） |
| 中心圆 | 深色玻璃 + 金色 35% 描边；高亮 = 金 26% 填充 + 80% 描边 |
| 动效 | 出现 140ms 淡入 + 0.96→1；高亮 90ms；`prefers-reduced-motion` 全 0 |

金色只用于"更多/确认"，玩家色只用于"是谁"；高亮同时有填充 + 描边 + 字重，颜色不是唯一编码。

## 4. 组件

```
radialPicker.ts       几何（等分扇区 + 常量表抖动 + 命中，纯函数）
radialPickerHtml.ts   SVG（扇区 path + 头像 pin + 隐藏 listbox），纯字符串
radialPickerModel.ts  focus/intent 状态机（键盘与读屏等价物）
radialPickerOverlay.ts DOM 浮层：mode 'click' | 'drag'，setPointer / resolveAt / zoneAt
cardHand/cardHand.ts  三个钩子 onDragStart / onDragMove / onDragEnd + dragScaleAt
hud.ts                beginTargetWheel / playHandCard 结算 / dragScaleAt
```

拖拽模式下轮盘不接指针（pointer capture 仍在手牌条），因此不会出现"浮层抢走拖拽"的经典 bug；
点击路径（触屏/键盘回退）仍走 `mode:'click'`，尺寸小一号。

## 5. 可调参数

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| 半径系数 | 0.41 × 屏幕短边 | 轮盘大小（直径 0.82 短边） |
| `innerRatio` | 0.26 | 中心圆占比 |
| `jitterAngle` | 0.075 | 轮廓随机度；>0.12 开始出现明显不均 |
| `jitterRadius` | 0.08 | 外轮廓不规则度 |
| 分区内缩放 | 0.4 | 悬在分区上时卡片缩到 40% |
| 中心/轮盘外缩放 | 1.0 | 即"屏幕 1/3"那档 |
| 缩放过渡 | 120ms | 过界来回不跳变 |

## 6. 验证

`pnpm probe:target-wheel`（149 项）：角宽 ±15%、角度总和 = 2π、determinism、命中与渲染同源；
浏览器侧：拖出浮轮盘、磨砂层、每区一头像、占比 > 0.6 短边、分区高亮唯一、卡片 120→322→131 的
缩放切换、分区松手 dispatch、中心开表单、轮盘外取消，以及 `probe:card-hand`（70 项）与
`probe:unified-hand`（33 项）的回归。
