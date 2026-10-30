import { ECSManager } from '@rds/kernel/ecs';
import { ReduceContext } from '@rds/kernel/module';
import { DeterministicPRNG } from '@rds/kernel/prng';
import { InterruptStackManager } from '@rds/kernel/stack';
import { Action, GameState, PlayerId, StackFrame, } from '@rds/kernel/types';

export class SanguoshaRules {
  public static getLegalActions(state: GameState, playerId: PlayerId): Action[] {
    if (state.gameOver) return [];

    // Check if there is an active interrupt stack frame with a response window waiting for this player
    const topFrame = InterruptStackManager.peek(state);
    if (topFrame && topFrame.status === 'WAITING_INPUT' && topFrame.responseWindow) {
      if (topFrame.responseWindow.eligiblePlayers.includes(playerId)) {
        const reactions: Action[] = [];
        const hand = ECSManager.getEntitiesInZone(state, `zone_hand_${playerId}`);

        if (topFrame.type === 'STRIKE_RESOLUTION') {
          // Player can play Dodge
          const dodgeCard = hand.find(c => c.components.cardFace?.title.includes('Dodge'));
          if (dodgeCard) {
            reactions.push({
              type: 'PLAY_DODGE',
              playerId,
              entityId: dodgeCard.id
            });
          }

          // If player has Eight Trigrams armor equipped
          const equipZone = ECSManager.getEntitiesInZone(state, `zone_equip_${playerId}`);
          const hasBagua = equipZone.some(e => e.components.cardFace?.title.includes('Eight Trigrams'));
          if (hasBagua) {
            reactions.push({
              type: 'JUDGE_BAGUA',
              playerId
            });
          }

          // Can always pass and take damage
          reactions.push({
            type: 'PASS',
            playerId
          });
        } else if (topFrame.type === 'DYING_RESCUE') {
          // Can play Peach to rescue
          const peachCard = hand.find(c => c.components.cardFace?.title.includes('Peach'));
          if (peachCard) {
            reactions.push({
              type: 'PLAY_PEACH',
              playerId,
              entityId: peachCard.id
            });
          }
          reactions.push({
            type: 'PASS',
            playerId
          });
        } else if (topFrame.type === 'TRICK_RESOLUTION' || topFrame.type === 'WUXIE_RESOLUTION') {
          // Can play Wu Xie Ke Ji to cancel!
          const wuxieCard = hand.find(c => c.components.cardFace?.title.includes('Wu Xie'));
          if (wuxieCard) {
            reactions.push({
              type: 'PLAY_WUXIE',
              playerId,
              entityId: wuxieCard.id
            });
          }
          reactions.push({
            type: 'PASS',
            playerId
          });
        }

        return reactions;
      }
      return [];
    }

    // Standard turn actions if active player
    if (state.activePlayerId !== playerId) return [];

    const actions: Action[] = [];
    const hand = ECSManager.getEntitiesInZone(state, `zone_hand_${playerId}`);
    const otherPlayers = state.playerOrder.filter(id => id !== playerId && state.players[id].alive);

    // Check hand cards
    hand.forEach(card => {
      const face = card.components.cardFace;
      if (!face) return;

      if (face.title.includes('Strike')) {
        otherPlayers.forEach(targetId => {
          actions.push({
            type: 'PLAY_STRIKE',
            playerId,
            entityId: card.id,
            targetPlayerId: targetId
          });
        });
      } else if (face.title.includes('Peach')) {
        const player = state.players[playerId];
        if (player.customProps.hp < player.customProps.maxHp) {
          actions.push({
            type: 'PLAY_PEACH',
            playerId,
            entityId: card.id
          });
        }
      } else if (face.title.includes('Dismantle')) {
        otherPlayers.forEach(targetId => {
          actions.push({
            type: 'PLAY_DISMANTLE',
            playerId,
            entityId: card.id,
            targetPlayerId: targetId
          });
        });
      } else if (face.title.includes('Snatch')) {
        otherPlayers.forEach(targetId => {
          actions.push({
            type: 'PLAY_SNATCH',
            playerId,
            entityId: card.id,
            targetPlayerId: targetId
          });
        });
      } else if (face.title.includes('Barbarian')) {
        actions.push({
          type: 'PLAY_BARBARIAN',
          playerId,
          entityId: card.id
        });
      }
    });

    // Draw cards action if needed
    actions.push({
      type: 'DRAW_CARDS',
      playerId
    });

    // End turn
    actions.push({
      type: 'END_TURN',
      playerId
    });

    return actions;
  }

  public static applyAction(
    state: GameState,
    action: Action,
    ctx: ReduceContext
  ): GameState {
    const trace = ctx.trace;
    let nextState = { ...state };
    const pId = action.playerId;
    const player = nextState.players[pId];

    switch (action.type) {
      case 'PLAY_STRIKE': {
        const targetId = action.targetPlayerId || 'p2';
        const target = nextState.players[targetId];

        // Move Strike card to discard
        if (action.entityId) {
          nextState = ECSManager.moveEntity(nextState, action.entityId, 'zone_discard');
        }

        trace({
          id: `strike_${ctx.id('g')}`,
          type: 'CARD_PLAY',
          title: `${player.name} played [Strike (杀)] targeting ${target.name}`,
          durationMs: 500
        });

        // Push STRIKE_RESOLUTION frame onto Sigma_stack with response window for target
        const strikeFrame: StackFrame = {
          id: `frame_strike_${ctx.id('g')}`,
          type: 'STRIKE_RESOLUTION',
          title: `Strike on ${target.name}`,
          description: `${target.name} must play Dodge or use Eight Trigrams armor, or take 1 damage.`,
          sourcePlayerId: pId,
          targetPlayerId: targetId,
          actionPayload: {
            type: 'EXECUTE_DAMAGE',
            playerId: targetId,
            payload: { amount: 1, sourcePlayerId: pId }
          },
          responseWindow: {
            eligiblePlayers: [targetId],
            pendingResponses: { [targetId]: 'PENDING' }
          },
          status: 'WAITING_INPUT'
        };

        nextState = InterruptStackManager.push(nextState, strikeFrame);
        trace({
          id: `stack_strike_${ctx.id('g')}`,
          type: 'STACK_PUSH',
          title: `[Σ_stack] Pushed: Strike on ${target.name}`,
          durationMs: 400
        });
        break;
      }

      case 'PLAY_DODGE': {
        if (action.entityId) {
          nextState = ECSManager.moveEntity(nextState, action.entityId, 'zone_discard');
        }
        trace({
          id: `dodge_${ctx.id('g')}`,
          type: 'CARD_PLAY',
          title: `${player.name} played [Dodge (闪)]! Strike negated!`,
          durationMs: 500
        });
        break;
      }

      case 'JUDGE_BAGUA': {
        // Judge top card of deck
        const { value: judgeVal, nextSeed } = DeterministicPRNG.nextInt(nextState.prngState, 1, 100);
        nextState.prngState = nextSeed;
        const isRed = judgeVal <= 50; // 50% probability red suit

        if (isRed) {
          trace({
            id: `bagua_success_${ctx.id('g')}`,
            type: 'ANNOUNCEMENT',
            title: `八卦阵 Ba Gua Judgement RED: Dodge successful!`,
            durationMs: 600
          });
        } else {
          trace({
            id: `bagua_fail_${ctx.id('g')}`,
            type: 'ANNOUNCEMENT',
            title: `八卦阵 Ba Gua Judgement BLACK: Failed to dodge!`,
            durationMs: 600
          });
          // Fall through to take damage
          if (player.customProps.hp > 0) {
            player.customProps.hp -= 1;
            player.score = player.customProps.hp;
            nextState.players = { ...nextState.players, [pId]: player };
          }
        }
        break;
      }

      case 'EXECUTE_DAMAGE': {
        const victimId = action.playerId;
        const victim = { ...nextState.players[victimId] };
        victim.customProps.hp = Math.max(0, victim.customProps.hp - (action.payload?.amount || 1));
        victim.score = victim.customProps.hp;
        nextState.players = { ...nextState.players, [victimId]: victim };

        trace({
          id: `dmg_${ctx.id('g')}`,
          type: 'DAMAGE_EFFECT',
          title: `${victim.name} took 1 damage! HP: ${victim.customProps.hp}/${victim.customProps.maxHp}`,
          durationMs: 600
        });

        // If HP <= 0, push DYING_RESCUE frame onto Sigma_stack!
        if (victim.customProps.hp <= 0) {
          const dyingFrame: StackFrame = {
            id: `frame_dying_${ctx.id('g')}`,
            type: 'DYING_RESCUE',
            title: `濒死 Dying: ${victim.name}`,
            description: `${victim.name} is dying! Anyone can play Peach to rescue.`,
            sourcePlayerId: victimId,
            targetPlayerId: victimId,
            actionPayload: { type: 'CHECK_DEATH', playerId: victimId },
            responseWindow: {
              eligiblePlayers: nextState.playerOrder.filter(id => nextState.players[id].alive),
              pendingResponses: Object.fromEntries(
                nextState.playerOrder.filter(id => nextState.players[id].alive).map(id => [id, 'PENDING'])
              )
            },
            status: 'WAITING_INPUT'
          };
          nextState = InterruptStackManager.push(nextState, dyingFrame);

          trace({
            id: `stack_dying_${ctx.id('g')}`,
            type: 'STACK_PUSH',
            title: `[Σ_stack] Pushed: Dying Rescue for ${victim.name}`,
            durationMs: 400
          });
        }
        break;
      }

      case 'CHECK_DEATH': {
        const dyingId = action.playerId;
        const victim = nextState.players[dyingId];
        if (victim && victim.customProps.hp <= 0) {
          victim.alive = false;
          nextState.players = { ...nextState.players, [dyingId]: victim };
          trace({
            id: `death_${ctx.id('g')}`,
            type: 'ANNOUNCEMENT',
            title: `💀 ${victim.name} (${victim.role}) has died!`,
            durationMs: 800
          });
        }
        break;
      }

      case 'PLAY_PEACH': {
        if (action.entityId) {
          nextState = ECSManager.moveEntity(nextState, action.entityId, 'zone_discard');
        }
        const targetId = action.targetPlayerId || pId;
        const target = { ...nextState.players[targetId] };
        target.customProps.hp = Math.min(target.customProps.maxHp, target.customProps.hp + 1);
        target.score = target.customProps.hp;
        nextState.players = { ...nextState.players, [targetId]: target };

        trace({
          id: `peach_${ctx.id('g')}`,
          type: 'CARD_PLAY',
          title: `${player.name} played [Peach (桃)] on ${target.name}! HP: ${target.customProps.hp}`,
          durationMs: 500
        });
        break;
      }

      case 'PLAY_DISMANTLE':
      case 'PLAY_SNATCH': {
        if (action.entityId) {
          nextState = ECSManager.moveEntity(nextState, action.entityId, 'zone_discard');
        }
        const cardName = action.type === 'PLAY_DISMANTLE' ? 'Dismantle (过河拆桥)' : 'Snatch (顺手牵羊)';
        const targetId = action.targetPlayerId || 'p2';
        const target = nextState.players[targetId];

        trace({
          id: `trick_${ctx.id('g')}`,
          type: 'CARD_PLAY',
          title: `${player.name} cast [${cardName}] on ${target.name}`,
          durationMs: 500
        });

        // Push trick onto interrupt stack with Wu Xie Ke Ji response window for ALL players!
        const alivePlayers = nextState.playerOrder.filter(id => nextState.players[id].alive);
        const trickFrame: StackFrame = {
          id: `frame_trick_${ctx.id('g')}`,
          type: 'TRICK_RESOLUTION',
          title: `${cardName} on ${target.name}`,
          description: `Any player may play [Wu Xie Ke Ji] to counter this trick card!`,
          sourcePlayerId: pId,
          targetPlayerId: targetId,
          actionPayload: {
            type: 'RESOLVE_TRICK_STEAL_OR_DISCARD',
            playerId: pId,
            payload: { sourceId: pId, targetId, isSnatch: action.type === 'PLAY_SNATCH' }
          },
          responseWindow: {
            eligiblePlayers: alivePlayers,
            pendingResponses: Object.fromEntries(alivePlayers.map(id => [id, 'PENDING']))
          },
          status: 'WAITING_INPUT'
        };

        nextState = InterruptStackManager.push(nextState, trickFrame);
        trace({
          id: `stack_trick_${ctx.id('g')}`,
          type: 'STACK_PUSH',
          title: `[Σ_stack] Pushed: ${cardName} (Wu Xie window opened)`,
          durationMs: 400
        });
        break;
      }

      case 'PLAY_WUXIE': {
        if (action.entityId) {
          nextState = ECSManager.moveEntity(nextState, action.entityId, 'zone_discard');
        }

        trace({
          id: `wuxie_${ctx.id('g')}`,
          type: 'CARD_PLAY',
          title: `${player.name} yelled: [Wu Xie Ke Ji (无懈可击)]! Negating prior card!`,
          durationMs: 500
        });

        // Pop the negated frame or push nested counter-window!
        const top = InterruptStackManager.peek(nextState);
        if (top) {
          // Recursive counter: push a WUXIE_RESOLUTION frame allowing another counter-counter!
          const alivePlayers = nextState.playerOrder.filter(id => nextState.players[id].alive);
          const wuxieFrame: StackFrame = {
            id: `frame_wuxie_${ctx.id('g')}`,
            type: 'WUXIE_RESOLUTION',
            title: `Counter [Wu Xie Ke Ji] of ${player.name}`,
            description: `Can anyone counter this [Wu Xie Ke Ji] with another [Wu Xie Ke Ji]?`,
            sourcePlayerId: pId,
            actionPayload: null, // Successfully counters the underneath trick if not countered itself
            responseWindow: {
              eligiblePlayers: alivePlayers,
              pendingResponses: Object.fromEntries(alivePlayers.map(id => [id, 'PENDING']))
            },
            status: 'WAITING_INPUT'
          };
          nextState = InterruptStackManager.push(nextState, wuxieFrame);
        }
        break;
      }

      case 'RESOLVE_TRICK_STEAL_OR_DISCARD': {
        const sId = action.payload.sourceId;
        const tId = action.payload.targetId;
        const targetHand = ECSManager.getEntitiesInZone(nextState, `zone_hand_${tId}`);
        if (targetHand.length > 0) {
          const stolen = targetHand[0];
          const destZone = action.payload.isSnatch ? `zone_hand_${sId}` : 'zone_discard';
          nextState = ECSManager.moveEntity(nextState, stolen.id, destZone);
          trace({
            id: `trick_done_${ctx.id('g')}`,
            type: 'CARD_DISCARD',
            title: `${action.payload.isSnatch ? 'Stole' : 'Discarded'} a card from ${nextState.players[tId].name}`,
            durationMs: 400
          });
        }
        break;
      }

      case 'DRAW_CARDS': {
        // Draw 2 cards from deck to hand
        const deck = ECSManager.getEntitiesInZone(nextState, 'zone_deck');
        for (let i = 0; i < 2 && deck.length > i; i++) {
          nextState = ECSManager.moveEntity(nextState, deck[i].id, `zone_hand_${pId}`);
        }
        trace({
          id: `draw_${ctx.id('g')}`,
          type: 'CARD_DRAW',
          title: `${player.name} drew 2 cards`,
          durationMs: 400
        });
        break;
      }

      case 'END_TURN': {
        const alivePlayers = nextState.playerOrder.filter(id => nextState.players[id].alive);
        const currentIdx = alivePlayers.indexOf(pId);
        const nextIdx = (currentIdx + 1) % alivePlayers.length;
        nextState.activePlayerId = alivePlayers[nextIdx];
        if (nextIdx === 0) nextState.round += 1;
        nextState.turn += 1;

        trace({
          id: `turn_sgs_${ctx.id('g')}`,
          type: 'ANNOUNCEMENT',
          title: `Next Turn: ${nextState.players[nextState.activePlayerId].name}`,
          durationMs: 300
        });
        break;
      }
    }

    return nextState;
  }

  public static checkWinCondition(state: GameState): { gameOver: boolean; winner: PlayerId | PlayerId[] | null } {
    const lordAlive = state.players.p1?.alive;
    const rebelsAlive = state.players.p3?.alive;
    const loyalistAlive = state.players.p2?.alive;
    const spyAlive = state.players.p4?.alive;

    if (!lordAlive) {
      if (!rebelsAlive && !loyalistAlive && spyAlive) {
        return { gameOver: true, winner: 'p4' }; // Spy wins if last man standing
      }
      return { gameOver: true, winner: 'p3' }; // Rebels win
    }

    if (!rebelsAlive && !spyAlive) {
      return { gameOver: true, winner: ['p1', 'p2'] }; // Lord & Loyalist win
    }

    return { gameOver: false, winner: null };
  }
}
