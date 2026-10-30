import { openDecision } from '@rds/kernel/decisions';
import { ReduceContext } from '@rds/kernel/module';
import { InterruptStackManager } from '@rds/kernel/stack';
import { Action, DecisionWindow, GameState, PlayerId, StackFrame, } from '@rds/kernel/types';

export class DuneMahjongRules {
  public static readonly DECISION_ACTIONS = ['COMMIT_BATTLE_DIAL'];

  public static isDecisionAction(action: Action, _window: DecisionWindow): boolean {
    return this.DECISION_ACTIONS.includes(action.type);
  }

  private static commitOptions(playerId: PlayerId): Action[] {
    return [
      {
        type: 'COMMIT_BATTLE_DIAL',
        playerId,
        payload: { troops: 3, leaderStr: playerId === 'p1' ? 5 : 6, weapon: 'Crysknife' }
      },
      {
        type: 'COMMIT_BATTLE_DIAL',
        playerId,
        payload: { troops: 5, leaderStr: playerId === 'p1' ? 5 : 6, weapon: 'Lasgun' }
      }
    ];
  }

  public static getLegalActions(state: GameState, playerId: PlayerId): Action[] {
    if (state.gameOver) return [];

    // 1. Interrupt stack response window (Mahjong priority claims)
    const topFrame = InterruptStackManager.peek(state);
    if (topFrame && topFrame.status === 'WAITING_INPUT' && topFrame.responseWindow) {
      if (topFrame.responseWindow.eligiblePlayers.includes(playerId)) {
        const reactions: Action[] = [];
        if (playerId === 'p2') {
          reactions.push({ type: 'MAHJONG_CHI', playerId, payload: { priority: 10 } });
          reactions.push({ type: 'MAHJONG_HU', playerId, payload: { priority: 30 } });
        } else if (playerId === 'p3') {
          reactions.push({ type: 'MAHJONG_PENG', playerId, payload: { priority: 20 } });
          reactions.push({ type: 'MAHJONG_HU', playerId, payload: { priority: 30 } });
        }
        reactions.push({ type: 'PASS', playerId });
        return reactions;
      }
      return [];
    }

    // 2. Secret simultaneous decision window
    const openWindow = state.pendingDecisions.find(w => w.status === 'OPEN');
    if (openWindow) {
      if (!openWindow.participants.includes(playerId)) return [];
      if (openWindow.submissions[playerId] !== undefined) return [];
      return this.commitOptions(playerId);
    }

    // 3. Regular actions
    if (state.globalVars.battleMode === 'DUNE_COMBAT_WHEEL') {
      if (playerId !== state.activePlayerId) return [];
      return [
        { type: 'OPEN_BATTLE_WINDOW', playerId },
        { type: 'SWITCH_TO_MAHJONG_DEMO', playerId }
      ];
    }

    return [
      { type: 'TRIGGER_MAHJONG_DISCARD', playerId: state.activePlayerId },
      { type: 'SWITCH_TO_DUNE_DEMO', playerId: state.activePlayerId }
    ];
  }

  public static applyAction(
    state: GameState,
    action: Action,
    ctx: ReduceContext
  ): GameState {
    const trace = ctx.trace;
    let nextState = { ...state };
    const pId = action.playerId;

    switch (action.type) {
      case 'OPEN_BATTLE_WINDOW': {
        nextState.globalVars = { ...nextState.globalVars, committedDials: {} };
        const opened = openDecision(
          nextState,
          {
            kind: 'SIMULTANEOUS',
            title: 'Battle Wheel — secret dial commitment',
            description: 'Both Houses lock in troops, leader and weapon. Nothing is revealed until both commit.',
            participants: ['p1', 'p2'],
            secret: true,
            policy: { type: 'ALL_COMMITTED' },
            payload: { allowedTypes: ['COMMIT_BATTLE_DIAL'] }
          },
          ctx.id('decision')
        );
        nextState = opened.state;
        trace({
          id: ctx.id('evt'),
          type: 'DECISION_OPEN',
          title: 'Secret battle window opened — both players must commit',
          durationMs: 500
        });
        break;
      }

      case 'COMMIT_BATTLE_DIAL': {
        const dials = { ...(nextState.globalVars.committedDials || {}) };
        dials[pId] = action.payload;
        nextState.globalVars = { ...nextState.globalVars, committedDials: dials };

        trace({
          id: `dial_commit_${pId}_${ctx.id('g')}`,
          type: 'ANNOUNCEMENT',
          title: `🔒 ${nextState.players[pId].name} locked in secret Battle Dial [|P(s)| > 1]`,
          durationMs: 400
        });

        // Check if both p1 and p2 have committed dials
        if (dials.p1 && dials.p2) {
          const p1Total = dials.p1.troops + dials.p1.leaderStr;
          const p2Total = dials.p2.troops + dials.p2.leaderStr;
          const winnerId = p1Total >= p2Total ? 'p1' : 'p2';
          const loserId = winnerId === 'p1' ? 'p2' : 'p1';

          nextState.globalVars.revealedBattleResult = {
            p1Score: p1Total,
            p2Score: p2Total,
            winnerId
          };

          // Deduct sacrificed troops
          nextState.players.p1.customProps.troops -= dials.p1.troops;
          nextState.players.p2.customProps.troops -= dials.p2.troops;
          nextState.players[winnerId].score += 5;

          trace({
            id: `dune_reveal_${ctx.id('g')}`,
            type: 'ANNOUNCEMENT',
            title: `💥 DIALS REVEALED! Atreides: ${p1Total} vs Harkonnen: ${p2Total}! Winner: ${nextState.players[winnerId].name}!`,
            durationMs: 1200
          });

          // Reset committed dials for next round
          nextState.globalVars.committedDials = {};
        }
        break;
      }

      case 'TRIGGER_MAHJONG_DISCARD': {
        const tile = nextState.globalVars.mahjongTileDiscarded || '9 Bamboo (九条)';
        trace({
          id: `mahjong_discard_${ctx.id('g')}`,
          type: 'CARD_PLAY',
          title: `🀄 ${nextState.players[pId].name} discarded [${tile}] into river!`,
          durationMs: 500
        });

        // Push priority response frame with arbitration: Hu (30) > Gang/Peng (20) > Chi (10)
        const frame: StackFrame = {
          id: `frame_mahjong_${ctx.id('g')}`,
          type: 'MAHJONG_CLAIM',
          title: `Priority Claim for [${tile}]`,
          description: `Arbitration: 胡 (Hu: 30) > 碰 (Peng: 20) > 吃 (Chi: 10). High priority will short-circuit!`,
          sourcePlayerId: pId,
          actionPayload: null,
          responseWindow: {
            eligiblePlayers: ['p2', 'p3'],
            pendingResponses: { p2: 'PENDING', p3: 'PENDING' },
            priorityArbitration: true,
            priorityMap: {
              MAHJONG_HU: 30,
              MAHJONG_PENG: 20,
              MAHJONG_CHI: 10,
              PASS: 0
            }
          },
          status: 'WAITING_INPUT'
        };

        nextState = InterruptStackManager.push(nextState, frame);
        trace({
          id: `stack_mahjong_${ctx.id('g')}`,
          type: 'STACK_PUSH',
          title: `[Σ_stack] Priority Window: Waiting for P2 (Chi/Hu) and P3 (Peng/Hu)`,
          durationMs: 500
        });
        break;
      }

      case 'MAHJONG_HU': {
        trace({
          id: `hu_${ctx.id('g')}`,
          type: 'ANNOUNCEMENT',
          title: `🀄🀄🀄 【胡牌 HU!】 ${nextState.players[pId].name} claimed HU (Priority 30)! Instant Short-Circuit Victory!`,
          durationMs: 1200
        });
        nextState.players[pId].score += 20;
        break;
      }

      case 'MAHJONG_PENG': {
        trace({
          id: `peng_${ctx.id('g')}`,
          type: 'ANNOUNCEMENT',
          title: `🀄 【碰 PENG!】 ${nextState.players[pId].name} claimed triplet (Priority 20)!`,
          durationMs: 600
        });
        nextState.players[pId].score += 5;
        break;
      }

      case 'MAHJONG_CHI': {
        trace({
          id: `chi_${ctx.id('g')}`,
          type: 'ANNOUNCEMENT',
          title: `🀄 【吃 CHI!】 ${nextState.players[pId].name} claimed sequence (Priority 10)!`,
          durationMs: 600
        });
        nextState.players[pId].score += 2;
        break;
      }

      case 'SWITCH_TO_MAHJONG_DEMO': {
        nextState.globalVars.battleMode = 'MAHJONG';
        trace({
          id: `switch_mode_${ctx.id('g')}`,
          type: 'ANNOUNCEMENT',
          title: `Switched to Mahjong Priority Arbitration Demo`,
          durationMs: 400
        });
        break;
      }

      case 'SWITCH_TO_DUNE_DEMO': {
        nextState.globalVars.battleMode = 'DUNE_COMBAT_WHEEL';
        nextState.globalVars.committedDials = {};
        trace({
          id: `switch_dune_${ctx.id('g')}`,
          type: 'ANNOUNCEMENT',
          title: `Switched to Dune Simultaneous Battle Wheel Demo`,
          durationMs: 400
        });
        break;
      }
    }

    return nextState;
  }

  public static checkWinCondition(state: GameState): { gameOver: boolean; winner: PlayerId | null } {
    for (const p of Object.values(state.players)) {
      if (p.score >= 25) {
        return { gameOver: true, winner: p.id };
      }
    }
    return { gameOver: false, winner: null };
  }
}
