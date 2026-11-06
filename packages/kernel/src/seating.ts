import type { GameModule, SeatRange } from './module';

/**
 * 座位数解析：**唯一**真相（issue #214）。
 *
 * 以前三处各自推导：房间上限读 `setup(1).playerOrder.length`、开局核对调
 * `setup(1,{seats})` 比较长度、联机默认用 roster 人数。三份实现只要有一份
 * 猜错，就会出现「房间收 9 人、夹具只发 6 座」的死局。
 *
 * 解析优先级：
 * 1. 变体声明 `scenarios[id].seats`（poker 的 seats_2 / short_stack…）；
 * 2. 模组声明 `meta.seatRange`；
 * 3. 遗留探测：跑一次 `setup(1)` 数 `playerOrder`，当作固定人数。
 */
export function seatRangeOf(module: GameModule, scenarioId?: string): SeatRange {
  const declared = module.meta.seatRange;
  const scenarioSeats = scenarioId ? module.scenarios?.[scenarioId]?.seats : undefined;

  if (scenarioSeats !== undefined) {
    // 变体固定人数：即使模组本身可变化，变体也按声明的座数开。
    return { min: scenarioSeats, max: scenarioSeats, default: scenarioSeats, variable: false };
  }
  if (declared) {
    return {
      min: declared.min,
      max: declared.max,
      default: declared.default ?? declared.min,
      variable: !!declared.variable
    };
  }
  const probed = probeSeats(module, scenarioId);
  return probed === undefined
    ? { min: 1, max: 1, default: 1, variable: false }
    : { min: probed, max: probed, default: probed, variable: false };
}

/** 请求 `wanted` 人开局能否被夹具接受；`dealt` 是实际会发出的座位数。 */
export function seatsAccepted(
  module: GameModule,
  scenarioId: string | undefined,
  wanted: number
): { ok: boolean; dealt: number } {
  const range = seatRangeOf(module, scenarioId);
  const defaultSeats = range.default ?? range.min;
  if (range.variable) {
    const clamped = Math.max(range.min, Math.min(range.max, wanted));
    return { ok: wanted >= range.min && wanted <= range.max, dealt: clamped };
  }
  return { ok: wanted === defaultSeats, dealt: defaultSeats };
}

/** 遗留模组的探测：跑一次默认 setup，数实际座位。失败返回 undefined。 */
function probeSeats(module: GameModule, scenarioId?: string): number | undefined {
  const factory = scenarioId ? module.scenarios?.[scenarioId]?.setup : module.setup;
  if (!factory) return undefined;
  try {
    return factory(1).playerOrder.length;
  } catch {
    return undefined;
  }
}
