import { ReduceContext } from '@rds/kernel/module';
import { Action, DecisionWindow, GameState, PlayerId } from '@rds/kernel/types';
import { getSanguoshaLegalActions } from './legal';
import { checkSanguoshaWin } from './outcome';
import { applySanguoshaAction, resolveSanguoshaDecision, resolveSanguoshaFollowUp } from './resolve';

/**
 * Public rules facade for the Sanguosha fixture.
 *
 * The implementation is split into pure modules:
 *   - `legal.ts`     turns a state into concrete, replayable actions;
 *   - `resolve.ts`   applies exactly one logical transition (plus follow-up
 *                    actions parked on the kernel stack/decision window);
 *   - `helpers.ts`   state-preserving card/zone/hp primitives;
 *   - `outcome.ts`   identity-mode victory conditions.
 *
 * Nothing in `GameState` is a class instance or closure, so the kernel can hash,
 * rewind and replay every transition bit-exactly.
 */
export class SanguoshaRules {
  public static getLegalActions(state: GameState, playerId: PlayerId): Action[] {
    return getSanguoshaLegalActions(state, playerId);
  }

  public static applyAction(state: GameState, action: Action, ctx: ReduceContext): GameState {
    return applySanguoshaAction(state, action, ctx);
  }

  public static resolveFollowUp(state: GameState, ctx: ReduceContext): Action[] {
    return resolveSanguoshaFollowUp(state, ctx);
  }

  public static onDecisionResolved(state: GameState, window: DecisionWindow, ctx: ReduceContext): GameState {
    return resolveSanguoshaDecision(state, window, ctx);
  }

  public static checkWinCondition(state: GameState): { gameOver: boolean; winner: PlayerId | PlayerId[] | null; reason?: string } {
    return checkSanguoshaWin(state);
  }
}
