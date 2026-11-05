/**
 * 把游戏声明的动作冷却写进动作视图（`ui.cooldownMs`）。
 *
 * 时钟只存在于驱动层：内核保持无时钟、可回放；这里只是给 UI 一个"还要等多久"。
 * 单机（`UniversalSession`）与联机（`NetSession`）必须共用同一份实现，否则同一张
 * 桌子在两种入口下的冷却规则会不一样（issue #198）。
 *
 * `seenAt` 由调用方持有：第一次看到某个动作类型时记下时刻，之后按声明时长递减；
 * 类型从视图里消失时清掉记录，避免下一手沿用旧的计时。
 */
export interface CooldownBound {
  ui: { actionType?: string; cooldownMs?: number };
}

export function applyActionCooldowns<T extends CooldownBound>(
  bound: T[],
  cooldowns: Record<string, number> | undefined,
  seenAt: Map<string, number>,
  now: number
): T[] {
  if (!cooldowns) return bound;
  const live = new Set<string>();
  for (const entry of bound) {
    const type = entry.ui.actionType;
    if (!type || cooldowns[type] === undefined) continue;
    live.add(type);
    if (!seenAt.has(type)) seenAt.set(type, now);
    const remaining = (seenAt.get(type) as number) + cooldowns[type] - now;
    if (remaining > 0) entry.ui.cooldownMs = remaining;
    else delete entry.ui.cooldownMs;
  }
  for (const type of [...seenAt.keys()]) if (!live.has(type)) seenAt.delete(type);
  return bound;
}
