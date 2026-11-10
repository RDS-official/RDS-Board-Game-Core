/**
 * 牌桌音效的**纯映射**：动作/结算 → 该响哪一声。
 *
 * 这里只做「字符串 → 枚举」，不认识 Web Audio，也不认识 DOM：音效本身没法写进
 * 断言，能测的是这层映射。渲染层（`apps/web/src/render/audio.ts`）负责发声，
 * 组合根（`apps/web/src/main.ts`）负责把投影差集喂进来。
 *
 * 动作文案来自扑克夹具的 `hand.lastActions`（座位牌面上那行短句）：
 * `跟注 10` / `加注到 40` / `全押 120` / `弃牌` / `过牌` / `小盲 5` / `大盲 10`。
 * 只有前四种有声音——盲注是系统动作，过牌没有筹码移动。
 */
export type BettingCue = 'call' | 'raise' | 'allIn' | 'fold';

export function bettingCueFor(sign: string): BettingCue | null {
  if (sign.startsWith('跟注')) return 'call';
  if (sign.startsWith('加注到')) return 'raise';
  if (sign.startsWith('全押')) return 'allIn';
  if (sign.startsWith('弃牌')) return 'fold';
  return null;
}

/**
 * 和上一帧比较，找出这一帧新发生的下注动作。
 *
 * 用差集而不是「整表重放」：重连补帧、切视角、重复快照都会带着同一张表，
 * 重放会让同一手牌反复出声。
 */
export function bettingCueDeltas(
  previous: ReadonlyMap<string, string> | undefined,
  next: Record<string, string>
): { playerId: string; cue: BettingCue }[] {
  const out: { playerId: string; cue: BettingCue }[] = [];
  for (const [playerId, sign] of Object.entries(next)) {
    if (previous?.get(playerId) === sign) continue;
    const cue = bettingCueFor(sign);
    if (cue) out.push({ playerId, cue });
  }
  return out;
}

/**
 * 结算该响赢还是输。
 *
 * 口径（产品确认）：**只看有没有赢下底池**——赢家列表里有自己就响赢，没有就响输
 * （弃牌、被压、边池只分到零都算输）。观察席（不在座位上）不响。
 */
export function settlementCue(
  winners: readonly string[],
  viewer: string,
  seated: boolean
): 'win' | 'lose' | null {
  if (!seated || viewer === 'GOD') return null;
  return winners.includes(viewer) ? 'win' : 'lose';
}
