import type { GameState, PlayerId } from '@rds/kernel/types';

export interface SgsOutcome {
  gameOver: boolean;
  winner: PlayerId | PlayerId[] | null;
  reason?: string;
}

export interface SgsDeathProbe {
  victimId: PlayerId;
  killerId: PlayerId | null;
  /** The killer's next living seat *before* the victim was removed. */
  nextOfKiller?: PlayerId | null;
}

function modeOf(state: GameState): string {
  return String(state.globalVars.mode ?? 'identity');
}

export function checkSanguoshaWin(state: GameState, death?: SgsDeathProbe): SgsOutcome {
  const players = state.playerOrder.map(pid => ({ pid, player: state.players[pid] })).filter(entry => !!entry.player);
  if (players.length === 0) return { gameOver: false, winner: null };

  // `checkDeath` may have already decided the village-rule instant win; the
  // kernel asks `outcome()` again after the same transition, so preserve it.
  const finalWinner = state.globalVars.finalWinner;
  if (finalWinner !== undefined && finalWinner !== null) {
    return {
      gameOver: true,
      winner: finalWinner as PlayerId | PlayerId[],
      reason: String(state.globalVars.finalReason ?? '胜负已分')
    };
  }

  const mode = modeOf(state);
  const alive = players.filter(entry => entry.player.alive);

  if (mode === 'kill_next') {
    // A killer wins the instant their next living seat dies under their blade.
    // The caller passes the seat order from *before* the victim was removed.
    if (death?.killerId && death.victimId) {
      const next = death.nextOfKiller ?? null;
      if (next === death.victimId && state.players[death.killerId]?.alive) {
        return {
          gameOver: true,
          winner: death.killerId,
          reason: `${state.players[death.killerId]?.name ?? death.killerId} 杀死了下家`
        };
      }
    }
    if (alive.length === 1) {
      return { gameOver: true, winner: alive[0].pid, reason: '最后一名生还者获胜' };
    }
    return { gameOver: false, winner: null };
  }

  if (mode === 'team') {
    const teamA = players.filter(entry => entry.player.role === 'TEAM_A');
    const teamB = players.filter(entry => entry.player.role === 'TEAM_B');
    const aAlive = teamA.filter(entry => entry.player.alive);
    const bAlive = teamB.filter(entry => entry.player.alive);
    if (aAlive.length === 0 && bAlive.length > 0) {
      // The whole camp wins, including teammates who died before the final blow.
      return { gameOver: true, winner: teamB.map(entry => entry.pid), reason: '蓝方全灭，赤方获胜' };
    }
    if (bAlive.length === 0 && aAlive.length > 0) {
      return { gameOver: true, winner: teamA.map(entry => entry.pid), reason: '赤方全灭，蓝方获胜' };
    }
    if (aAlive.length === 0 && bAlive.length === 0) {
      return { gameOver: true, winner: null, reason: '双方同时全灭' };
    }
    return { gameOver: false, winner: null };
  }

  const lord = players.find(entry => entry.player.role === 'LORD');
  const rebels = players.filter(entry => entry.player.role === 'REBEL');
  const loyalists = players.filter(entry => entry.player.role === 'LOYALIST');
  const spies = players.filter(entry => entry.player.role === 'SPY');

  if (!lord) return { gameOver: true, winner: null, reason: '身份局缺少主公' };

  const rebelsAlive = rebels.filter(entry => entry.player.alive);
  const spiesAlive = spies.filter(entry => entry.player.alive);

  if (!lord.player.alive) {
    if (alive.length === 1 && alive[0].player.role === 'SPY') {
      return {
        gameOver: true,
        winner: alive[0].pid,
        reason: '主公阵亡，内奸成为最后的生还者'
      };
    }
    return {
      gameOver: true,
      winner: rebels.map(entry => entry.pid),
      reason: '主公阵亡，反贼获胜'
    };
  }

  if (rebelsAlive.length === 0 && spiesAlive.length === 0) {
    return {
      gameOver: true,
      winner: [...loyalists, lord].map(entry => entry.pid),
      reason: '反贼与内奸均已肃清，主公与忠臣获胜'
    };
  }

  return { gameOver: false, winner: null };
}
