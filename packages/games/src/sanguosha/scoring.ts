import type { GameState, PlayerId } from '@rds/kernel/types';
import type { SanguoshaMode } from './types';

/**
 * Sanguosha table points.
 *
 * The table rules are deliberately data, not presentation copy: the server
 * folds the same deltas into the account ledger that the final curtain shows.
 * Keeping them in one module means a future "season" only changes this table.
 */
export const SANGUOSHA_SCORE = {
  standardWin: 500,
  standardLoss: -500,
  spyWin: 1000,
  teamWin: 500,
  teamLoss: -500,
  killNextWin: 250,
  killNextLoss: -250
} as const;

export const SANGUOSHA_MODE_LABELS: Record<SanguoshaMode, string> = {
  identity: '身份局',
  team: '4人对抗',
  kill_next: '杀下家'
};

export function sanguoshaModeOf(state: Pick<GameState, 'globalVars'>): SanguoshaMode {
  const mode = String(state.globalVars.mode ?? 'identity');
  return mode === 'team' || mode === 'kill_next' ? mode : 'identity';
}

export function winnerIdsOf(state: Pick<GameState, 'globalVars'>): PlayerId[] {
  const winner = state.globalVars.finalWinner ?? state.globalVars.winner;
  if (Array.isArray(winner)) return winner.map(String);
  return winner === null || winner === undefined ? [] : [String(winner)];
}

/**
 * Point delta for every seat at the final whistle.
 *
 * - Standard identity: winners +500, losers -500; a sole spy winner gets 1000.
 * - Four-player confrontation: the winning team gets +500 each, the other -500.
 * - Kill-your-next village rule: the killer +250, every other seat -250.
 *
 * The table is intentionally authoritative even where it is not zero-sum (the
 * spy's doubled win is a net table injection); callers must not "fix" it by
 * silently scaling the losers.
 */
export function sanguoshaScoreDeltas(
  state: Pick<GameState, 'globalVars' | 'players' | 'playerOrder'>,
  winner: PlayerId | PlayerId[] | null = (state.globalVars.finalWinner ?? null) as PlayerId | PlayerId[] | null
): Record<PlayerId, number> {
  const mode = sanguoshaModeOf(state);
  const winners = new Set(Array.isArray(winner) ? winner.map(String) : winner ? [String(winner)] : []);
  const deltas: Record<PlayerId, number> = {};
  for (const pid of state.playerOrder) deltas[pid] = 0;
  if (winners.size === 0) return deltas;

  if (mode === 'kill_next') {
    for (const pid of state.playerOrder) {
      deltas[pid] = winners.has(pid) ? SANGUOSHA_SCORE.killNextWin : SANGUOSHA_SCORE.killNextLoss;
    }
    return deltas;
  }

  if (mode === 'team') {
    for (const pid of state.playerOrder) {
      deltas[pid] = winners.has(pid) ? SANGUOSHA_SCORE.teamWin : SANGUOSHA_SCORE.teamLoss;
    }
    return deltas;
  }

  // Identity mode: a sole spy is the only seat allowed the doubled payout.
  const onlyWinner = winners.size === 1 ? [...winners][0] : undefined;
  const spyWin = !!onlyWinner && state.players[onlyWinner]?.role === 'SPY';
  for (const pid of state.playerOrder) {
    deltas[pid] = winners.has(pid)
      ? spyWin
        ? SANGUOSHA_SCORE.spyWin
        : SANGUOSHA_SCORE.standardWin
      : SANGUOSHA_SCORE.standardLoss;
  }
  return deltas;
}
