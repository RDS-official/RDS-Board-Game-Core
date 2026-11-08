import { openDecision } from '@rds/kernel/decisions';
import { ReduceContext } from '@rds/kernel/module';
import { InterruptStackManager } from '@rds/kernel/stack';
import { Action, DecisionWindow, GameState, PlayerId, StackFrame, } from '@rds/kernel/types';

/**
 * 宪章 C-7：加分同时记账。
 *
 * 分数只经这一处改写，保证 `state.rewards` 能回答"这一分从哪条规则来"。
 * 返回新状态，不原地修改。
 */
function awardScore(
  state: GameState,
  playerId: PlayerId,
  amount: number,
  ctx: ReduceContext,
  reason: string
): GameState {
  const player = state.players[playerId];
  if (!player) return state;
  ctx.reward(playerId, 'score', amount, reason);
  return {
    ...state,
    players: { ...state.players, [playerId]: { ...player, score: player.score + amount } }
  };
}

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
            // 宪章 C-3：双方押注同时生效，顺序不该由内核决定。
            // 结算走 applySimultaneous()，一次拿到两份 dial 再比。
            policy: { type: 'SIMULTANEOUS' },
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

        // 只负责记录。胜负由 applySimultaneous() 在窗口结算时一次性判定 ——
        // 之前的实现在这里"等第二个人提交时开打"，等于让后提交者掌握结算时机。
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
        // 宪章 C-7：胡牌 +20 是真实增量收益，要能回答"这一分从哪来"。
        nextState = awardScore(nextState, pId, 20, ctx, '胡牌（优先级 30，即时短路获胜）');
        break;
      }

      case 'MAHJONG_PENG': {
        trace({
          id: `peng_${ctx.id('g')}`,
          type: 'ANNOUNCEMENT',
          title: `🀄 【碰 PENG!】 ${nextState.players[pId].name} claimed triplet (Priority 20)!`,
          durationMs: 600
        });
        nextState = awardScore(nextState, pId, 5, ctx, '碰（优先级 20，刻子）');
        break;
      }

      case 'MAHJONG_CHI': {
        trace({
          id: `chi_${ctx.id('g')}`,
          type: 'ANNOUNCEMENT',
          title: `🀄 【吃 CHI!】 ${nextState.players[pId].name} claimed sequence (Priority 10)!`,
          durationMs: 600
        });
        nextState = awardScore(nextState, pId, 2, ctx, '吃（优先级 10，顺子）');
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

  /**
   * 宪章 C-3：战斗之轮的多重集结算。
   *
   * 双方的 dial 同时生效 —— 不看谁先提交、也不看数组顺序。平局按
   * "阿特雷迪斯防守方优先"（房规：同分守方胜），因此结果只由两份 dial 决定，
   * 与提交时序无关。
   *
   * 这与旧实现的差别是**可审计性**：旧代码在第二个 `COMMIT_BATTLE_DIAL`
   * 的分支里内联结算，谁后提交谁触发了结算；现在结算点固定在内核的窗口
   * 解析阶段，且输入是完整的两份 dial。
   */
  public static applySimultaneous(
    state: GameState,
    actions: { actorId: string; action: Action }[],
    ctx: ReduceContext
  ): GameState {
    const dials: Record<string, { troops: number; leaderStr: number }> = {
      ...((state.globalVars.committedDials as Record<string, { troops: number; leaderStr: number }>) ?? {})
    };

    for (const entry of actions) {
      if (entry.action.type !== 'COMMIT_BATTLE_DIAL') continue;
      const payload = entry.action.payload as { troops?: unknown; leaderStr?: unknown } | undefined;
      const troops = Number(payload?.troops ?? 0);
      const leaderStr = Number(payload?.leaderStr ?? 0);
      if (!Number.isFinite(troops) || !Number.isFinite(leaderStr)) continue;
      dials[entry.actorId] = { troops: Math.max(0, troops), leaderStr };
    }

    let nextState: GameState = {
      ...state,
      globalVars: { ...state.globalVars, committedDials: dials }
    };

    const a = dials.p1;
    const b = dials.p2;
    if (!a || !b) return nextState;

    const p1Total = a.troops + a.leaderStr;
    const p2Total = b.troops + b.leaderStr;
    // 同分守方（p1）胜，与提交顺序无关。
    const winnerId = p1Total >= p2Total ? 'p1' : 'p2';

    nextState = {
      ...nextState,
      globalVars: {
        ...nextState.globalVars,
        revealedBattleResult: { p1Score: p1Total, p2Score: p2Total, winnerId },
        committedDials: {}
      },
      players: {
        ...nextState.players,
        p1: {
          ...nextState.players.p1,
          customProps: {
            ...nextState.players.p1.customProps,
            troops: Math.max(0, Number(nextState.players.p1.customProps?.troops ?? 0) - a.troops)
          }
        },
        p2: {
          ...nextState.players.p2,
          customProps: {
            ...nextState.players.p2.customProps,
            troops: Math.max(0, Number(nextState.players.p2.customProps?.troops ?? 0) - b.troops)
          }
        },
        [winnerId]: {
          ...nextState.players[winnerId]
        }
      }
    };
    // 宪章 C-7：战斗之轮的胜者 +5 是真实增量收益。
    nextState = awardScore(nextState, winnerId, 5, ctx, `战斗之轮获胜（${p1Total} : ${p2Total}）`);

    ctx.trace({
      id: `dune_reveal_${ctx.id('g')}`,
      type: 'ANNOUNCEMENT',
      title: `💥 DIALS REVEALED! Atreides: ${p1Total} vs Harkonnen: ${p2Total}! Winner: ${nextState.players[winnerId].name}!`,
      durationMs: 1200
    });

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
