/**
 * 弹簧积分器：手牌回弹 / 邻居让位 / 布局迁移的唯一运动来源。
 *
 * 为什么自己算而不用 CSS transition：手牌的 transform 由 **一个 rAF 循环独占**
 * （见 cardHand.ts）。一旦同一个属性同时有 CSS transition 和 JS 写入，两者会互相
 * 覆盖，肉眼看到的正是"跳一下"。所以所有位移都走弹簧，CSS 只负责阴影这类 paint-only
 * 属性。
 *
 * 数值是半隐式 Euler + 子步：掉帧或后台标签页切回来时 dt 会突然变大，不夹子步的话
 * 弹簧会一帧飞出屏幕（"偶发跳变"的真凶）。
 */

export interface SpringConfig {
  stiffness: number;
  damping: number;
  mass: number;
}

export interface SpringState {
  value: number;
  velocity: number;
}

export const spring = (value = 0): SpringState => ({ value, velocity: 0 });

/** 推进一帧；收敛后吸附到目标并返回 true（rAF 据此停机）。 */
export function springStep(
  state: SpringState,
  target: number,
  config: SpringConfig,
  dt: number,
  epsilon = 0.01
): boolean {
  const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
  const h = dt / steps;
  for (let i = 0; i < steps; i += 1) {
    const accel = ((target - state.value) * config.stiffness - state.velocity * config.damping) / config.mass;
    state.velocity += accel * h;
    state.value += state.velocity * h;
  }
  if (Math.abs(target - state.value) < epsilon && Math.abs(state.velocity) < epsilon * 10) {
    state.value = target;
    state.velocity = 0;
    return true;
  }
  return false;
}

/** 阻尼比：<1 有回弹（物理感），≈1 干脆停住。只用于挑参数与单测，不参与运行时。 */
export const dampingRatio = (config: SpringConfig): number =>
  config.damping / (2 * Math.sqrt(config.stiffness * config.mass));
