import { CognitiveObserver } from '@rds/kernel/observer';
import type { Action, GameState, PlayerId } from '@rds/kernel/types';
import { cardCode, cardSubtype, handIdsOf, nextAlivePlayer, propsOf } from './helpers';
import type { SgsSeatAssignment } from './types';

/**
 * Built-in Sanguosha AI.
 *
 * The driver only needs one concrete action per automated step. This module
 * chooses it from the same legal-action list a human receives; it never mutates
 * state and never reads another seat's hidden hand. Role knowledge comes from
 * the projection, so hidden identities remain hidden even from the bot.
 */
export function isAiSeat(state: GameState, playerId: PlayerId): boolean {
  const seats = state.globalVars.seats as SgsSeatAssignment[] | undefined;
  return !!seats?.find(seat => seat.playerId === playerId)?.isAi;
}

function cardValue(state: GameState, entityId?: string): number {
  if (!entityId) return 0;
  const code = cardCode(state.entities[entityId]);
  if (code === 'tao') return 100;
  if (code === 'shan') return 90;
  if (code === 'wuzhong') return 80;
  if (code === 'sha' || code === 'huosha' || code === 'leisha') return 70;
  if (code === 'jiu') return 55;
  if (cardSubtype(state.entities[entityId]) === 'EQUIP') return 45;
  return 40;
}

function targetPriority(state: GameState, view: GameState, actor: PlayerId, target?: PlayerId): number {
  if (!target || target === actor || !state.players[target]?.alive) return 0;
  const mode = String(state.globalVars.mode ?? 'identity');
  const actorRole = view.players[actor]?.role;
  const targetRole = view.players[target]?.role;
  let score = 0;

  if (mode === 'team') {
    score += actorRole && targetRole && actorRole !== targetRole ? 30 : -25;
  } else if (mode === 'kill_next') {
    score += nextAlivePlayer(state, actor) === target ? 40 : 0;
  } else if (actorRole === 'REBEL' && targetRole === 'LORD') {
    score += 35;
  } else if (actorRole === 'LOYALIST' && targetRole === 'LORD') {
    score -= 35;
  } else if (actorRole === 'LORD') {
    // The lord only knows that they are the lord; other roles stay hidden.
    score += targetRole === undefined ? 4 : 0;
  }

  const hp = Number(propsOf(state, target).hp ?? 0);
  const maxHp = Number(propsOf(state, target).maxHp ?? 4);
  score += Math.max(0, maxHp - hp) * 2;
  return score;
}

function chooseResponse(state: GameState, view: GameState, actions: Action[]): Action {
  const pass = actions.find(action => action.type === 'PASS') ?? actions[actions.length - 1];
  const peaches = actions.filter(action => action.type === 'PLAY_PEACH');
  if (peaches.length > 0) return peaches[0];

  const wuxie = actions.find(action => action.type === 'PLAY_WUXIE');
  if (wuxie) {
    const pending = state.globalVars.pendingTrick as { targetIds?: string[] } | undefined;
    const targetIds = pending?.targetIds ?? [];
    if (targetIds.includes(actionPlayer(wuxie))) return wuxie;
  }

  return (
    actions.find(action => action.type === 'JUDGE_BAGUA') ??
    actions.find(action => action.type === 'PLAY_DODGE') ??
    actions.find(action => action.type === 'PLAY_STRIKE') ??
    pass
  );
}

function actionPlayer(action: Action): PlayerId {
  return action.playerId;
}

function chooseDiscard(state: GameState, actions: Action[]): Action {
  return [...actions].sort((a, b) => cardValue(state, a.entityId) - cardValue(state, b.entityId))[0];
}

function choosePlay(state: GameState, view: GameState, actions: Action[]): Action {
  const choice = actions.find(action => action.type === 'RESOLVE_CHOICE');
  if (choice) return choice;
  const end = actions.find(action => action.type === 'END_TURN');
  const scored = actions
    .filter(action => action.type !== 'END_TURN')
    .map(action => ({ action, score: scorePlayAction(state, view, action) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score <= 0) return end ?? actions[0];
  return best.action;
}

function scorePlayAction(state: GameState, view: GameState, action: Action): number {
  const subtype = cardSubtype(action.entityId ? state.entities[action.entityId] : undefined);
  const target = action.targetPlayerId;
  switch (action.type) {
    case 'PLAY_PEACH':
      return 100;
    case 'EQUIP_CARD':
      return 85;
    case 'PLAY_STRIKE':
      return 70 + targetPriority(state, view, action.playerId, target);
    case 'USE_SKILL': {
      const skill = String(action.payload?.skill ?? '');
      const base: Record<string, number> = {
        kurou: 90,
        zhiheng: 78,
        wusheng: 72,
        longdan: 72,
        qixi: 65,
        qingnang: 62,
        guose: 55,
        jieyin: 45,
        lijian: 45,
        rende: 18
      };
      return (base[skill] ?? 30) + targetPriority(state, view, action.playerId, target);
    }
    case 'PLAY_CARD': {
      const base: Record<string, number> = {
        EX_NIHILO: 95,
        HARVEST: 88,
        PEACH_GARDEN: propsOf(state, action.playerId).hp < propsOf(state, action.playerId).maxHp ? 80 : 20,
        BARBARIAN: 78,
        ARROW: 78,
        DISMANTLE: 68,
        SNATCH: 72,
        DUEL: 66,
        BORROW_SWORD: 60,
        FIRE_ATTACK: 58,
        IRON_CHAIN: 45
      };
      if (action.payload?.recast === true) return 20;
      const score = base[subtype] ?? 30;
      return score + targetPriority(state, view, action.playerId, target);
    }
    default:
      return 0;
  }
}

export function chooseSanguoshaAiAction(state: GameState, playerId: PlayerId, actions: Action[]): Action | undefined {
  if (actions.length === 0) return undefined;
  if (actions.length === 1) return actions[0];
  const view = CognitiveObserver.projectState(state, playerId, undefined, undefined, undefined) as unknown as GameState;
  const top = state.interruptStack[state.interruptStack.length - 1];
  if (top?.status === 'WAITING_INPUT' && top.responseWindow) {
    return chooseResponse(state, view, actions);
  }
  if (state.phase === 'DISCARD') return chooseDiscard(state, actions);
  if (state.globalVars.pendingChoice) {
    return actions.find(action => action.type === 'RESOLVE_CHOICE') ?? actions[0];
  }
  if (state.phase === 'PLAY') return choosePlay(state, view, actions);
  return actions[0];
}

/** Keep the import alive for callers that want a quick hand-size check. */
export function aiHandCount(state: GameState, playerId: PlayerId): number {
  return handIdsOf(state, playerId).length;
}
