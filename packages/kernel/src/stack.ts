import { Action, ActorId, GameState, StackFrame, StackResponseWindow } from './types';

/**
 * LIFO Reactive Interrupt Call Stack (\Sigma_{stack})
 * Handles recursive response windows, counter-spells (Wu Xie Ke Ji),
 * and multi-player priority arbitration (Mahjong Hu > Gang/Peng > Chi).
 */

export class InterruptStackManager {
  public static push(state: GameState, frame: StackFrame): GameState {
    const updatedFrame: StackFrame = {
      ...frame,
      status: frame.responseWindow && frame.responseWindow.eligiblePlayers.length > 0
        ? 'WAITING_INPUT'
        : 'RESOLVING'
    };

    return {
      ...state,
      interruptStack: [...state.interruptStack, updatedFrame]
    };
  }

  public static peek(state: GameState): StackFrame | null {
    if (state.interruptStack.length === 0) return null;
    return state.interruptStack[state.interruptStack.length - 1];
  }

  public static pop(state: GameState): { state: GameState; poppedFrame: StackFrame | null } {
    if (state.interruptStack.length === 0) {
      return { state, poppedFrame: null };
    }

    const poppedFrame = state.interruptStack[state.interruptStack.length - 1];
    const newStack = state.interruptStack.slice(0, -1);

    return {
      state: {
        ...state,
        interruptStack: newStack
      },
      poppedFrame
    };
  }

  /**
   * Submit a player's reaction (or PASS) to the active response window
   */
  public static submitResponse(
    state: GameState,
    frameId: string,
    playerId: ActorId,
    response: 'PASS' | Action
  ): { state: GameState; resolved: boolean; shortCircuitedAction?: Action } {
    const stack = [...state.interruptStack];
    const frameIndex = stack.findIndex(f => f.id === frameId);
    if (frameIndex === -1) {
      return { state, resolved: false };
    }

    const frame = { ...stack[frameIndex] };
    if (!frame.responseWindow) {
      return { state, resolved: true };
    }

    const window: StackResponseWindow = {
      ...frame.responseWindow,
      pendingResponses: {
        ...frame.responseWindow.pendingResponses,
        [playerId]: response
      }
    };
    frame.responseWindow = window;
    stack[frameIndex] = frame;

    const updatedState = {
      ...state,
      interruptStack: stack
    };

    // Priority Arbitration Short-Circuit check (e.g. Mahjong: Hu=30 short-circuits Peng=20 or Chi=10)
    if (window.priorityArbitration && typeof response !== 'string') {
      const priority = (window.priorityMap && window.priorityMap[response.type]) || 0;
      const shortCircuitAt = window.shortCircuitAt ?? 30;
      if (priority >= shortCircuitAt) {
        return {
          state: updatedState,
          resolved: true,
          shortCircuitedAction: response
        };
      }
    }

    // Check if all eligible players have submitted response
    const allResponded = window.eligiblePlayers.every(
      pId => window.pendingResponses[pId] !== undefined && window.pendingResponses[pId] !== 'PENDING'
    );

    return {
      state: updatedState,
      resolved: allResponded
    };
  }

  public static isStackEmpty(state: GameState): boolean {
    return state.interruptStack.length === 0;
  }
}
