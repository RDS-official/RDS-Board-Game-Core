/**
 * 手牌弧形布局：纯函数、确定性、任意张数不溢出。
 *
 * 坐标口径（与 cardHand.ts 的 CSS 约定一致）：
 * - `x` 是相对手牌条中心的水平偏移（px，右正）；
 * - `y` 是相对底边的垂直偏移（px，**上负下正**，因此中间最高时为负值）；
 * - `z` 越大越靠前；`rotationDeg` 绕卡片底部中点旋转（CSS `transform-origin: 50% 100%`）。
 */

export interface ArcLayoutOptions {
  /** 手牌条可用宽度（px）。 */
  handWidth: number;
  /** 卡宽（px），用于算"满排需要多少宽度"。 */
  cardWidth: number;
  /** 理想中心距（px）：张数少时的手感。 */
  spacing: number;
  /** 最小中心距（px）：再挤也留这么多，保证还能认出牌。 */
  minSpacing: number;
  /** 扇面总角度（deg）。 */
  arcDeg: number;
  /** 中间抬起的高度（px）：中间最高、两侧落底，形成"托在手里"的弧线。 */
  risePx: number;
  /** 最边缘卡的整体缩放（1 = 不缩）。 */
  edgeScale: number;
  /** 两侧留白（px）。 */
  lateralPad: number;
  /** 卡面朝圆心的旋转系数（0 = 全部竖直，1 = 完全发散）。 */
  rotFactor: number;
}

export const DEFAULT_ARC_LAYOUT: ArcLayoutOptions = {
  handWidth: 900,
  cardWidth: 108,
  spacing: 92,
  minSpacing: 34,
  arcDeg: 20,
  risePx: 10,
  edgeScale: 0.92,
  lateralPad: 12,
  rotFactor: 0.9
};

export interface ArcSlot {
  x: number;
  y: number;
  rotationDeg: number;
  scale: number;
  z: number;
}

/**
 * 把 `count` 张牌摆成一条弧。
 *
 * 压缩策略分两段，这也是"张数再多也不糊"的关键：
 * 1. 中心距随张数压缩，且永远不超过"刚好排得下"的 `span / (count - 1)`；
 * 2. 挤到低于 `minSpacing` 时**整体缩小**（`globalScale`），让重叠之后仍分得清每张牌。
 */
export function arcLayout(count: number, options: Partial<ArcLayoutOptions> = {}): ArcSlot[] {
  const config: ArcLayoutOptions = { ...DEFAULT_ARC_LAYOUT, ...options };
  if (count <= 0) return [];
  const usable = Math.max(config.cardWidth, config.handWidth - config.lateralPad * 2);
  const span = Math.max(0, usable - config.cardWidth);
  // rawStep 是"刚好排得下"的中心距：它永远是硬上限，宁可让牌重叠，也不让边缘跑出屏幕。
  const rawStep = count <= 1 ? 0 : span / (count - 1);
  const step = count <= 1 ? 0 : Math.min(config.spacing, rawStep);
  // 挤到低于 minSpacing 时整体缩小，保证重叠之后仍能认出每张牌。
  const globalScale = count <= 1 ? 1 : Math.max(0.6, Math.min(1, step / config.minSpacing));
  const mid = (count - 1) / 2;

  const slots: ArcSlot[] = [];
  for (let index = 0; index < count; index += 1) {
    const t = count === 1 ? 0 : (index - mid) / mid; // -1 .. 1
    const edge = Math.abs(t);
    slots.push({
      x: step * (index - mid),
      // 中间抬起，两侧落到底边：不向下溢出，也避免和底栏打架。
      y: -config.risePx * (1 - t * t),
      rotationDeg: (config.arcDeg / 2) * t * config.rotFactor,
      scale: globalScale * (1 - (1 - config.edgeScale) * edge),
      z: Math.round(100 - edge * 40)
    });
  }
  return slots;
}
