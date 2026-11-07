export type Easing = (t: number) => number;

/**
 * CSS `cubic-bezier(x1, y1, x2, y2)` 的等价 JS 实现。
 *
 * hover 过渡之所以不用 CSS，是因为 transform 必须只有一个写者（见 spring.ts 的说明）；
 * 这里把同一条曲线搬到 JS 里求值，视觉上等价，但不会和 rAF 抢属性。
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Easing {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number): number => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number): number => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number): number => (3 * ax * t + 2 * bx) * t + cx;

  const solveT = (x: number): number => {
    let t = x;
    for (let i = 0; i < 4; i += 1) {
      const delta = sampleX(t) - x;
      if (Math.abs(delta) < 1e-5) return t;
      const slope = slopeX(t);
      if (Math.abs(slope) < 1e-6) break;
      t -= delta / slope;
    }
    // Newton 不收敛时退回二分：曲线在 x 方向严格单调，因此一定有解。
    let low = 0;
    let high = 1;
    t = x;
    for (let i = 0; i < 20; i += 1) {
      const value = sampleX(t);
      if (Math.abs(value - x) < 1e-5) break;
      if (value < x) low = t;
      else high = t;
      t = (low + high) / 2;
    }
    return t;
  };

  return (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : sampleY(solveT(x)));
}

/** hover / 邻居让位 / 出场淡入：快起慢收，无过冲（对应 150–200ms）。 */
export const HOVER_EASE = cubicBezier(0.2, 0.8, 0.2, 1);
/** 打出飞桌：加速更陡、收尾干脆。 */
export const FLY_EASE = cubicBezier(0.2, 0.9, 0.2, 1);
