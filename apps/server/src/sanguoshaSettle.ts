/**
 * Sanguosha account settlement.
 *
 * The game module owns the point table; this adapter only folds the final
 * per-seat deltas into the user record. A room is settled at most once per
 * account, so reconnects and server-side match rebuilds cannot double-charge.
 */
import { users } from './storage.ts';

export interface SanguoshaSettleResult {
  settled: string[];
}

export function settleSanguosha(
  roomId: string,
  deltas: Record<string, number>,
  winnerIds: readonly string[],
  seatToUser: (playerId: string) => string | undefined,
  now = Date.now()
): SanguoshaSettleResult {
  const winners = new Set(winnerIds);
  const settled: string[] = [];
  for (const [seat, rawDelta] of Object.entries(deltas)) {
    const delta = Math.round(Number(rawDelta) || 0);
    if (delta === 0) continue;
    const userId = seatToUser(seat);
    if (!userId || userId.startsWith('ai:')) continue;
    const record = users.byId(userId);
    if (!record) continue;
    if (record.sanguoshaSettled?.[roomId]) continue;
    users.update(userId, {
      sanguoshaPoints: Math.round(Number(record.sanguoshaPoints ?? 0) + delta),
      sanguoshaCareer: {
        games: Math.max(0, Number(record.sanguoshaCareer?.games ?? 0)) + 1,
        wins: Math.max(0, Number(record.sanguoshaCareer?.wins ?? 0)) + (winners.has(seat) ? 1 : 0)
      },
      sanguoshaSettled: { ...(record.sanguoshaSettled ?? {}), [roomId]: now }
    });
    settled.push(userId);
  }
  return { settled };
}
