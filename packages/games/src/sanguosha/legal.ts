import { CognitiveObserver } from '@rds/kernel/observer';
import { Action, Entity, GameState, PlayerId } from '@rds/kernel/types';
import { cardCode, cardIsRed, cardSubtype, isStrikeCard } from './helpers';
import {
  alivePlayers,
  attackRangeOf,
  canUseStrike,
  cardSuit,
  distanceBetween,
  duelContext,
  equipmentOfSlot,
  handOf,
  hasAnyCard,
  hasEquipment,
  hasSkill,
  inAttackRange,
  isLord,
  massTrickContext,
  propsOf,
  strikeContext
} from './helpers';
import { chooseSanguoshaAiAction, isAiSeat } from './ai';
import { SgsPendingChoice } from './types';

/** Every action type this module may emit or consume, including automatic steps. */
export const SANGUOSHA_ACTION_TYPES = [
  'PLAY_STRIKE',
  'PLAY_DODGE',
  'PLAY_PEACH',
  'PLAY_WUXIE',
  'PLAY_CARD',
  'EQUIP_CARD',
  'USE_SKILL',
  'DISCARD_CARD',
  'RESOLVE_CHOICE',
  'JUDGE_BAGUA',
  'PASS',
  'END_TURN',
  'START_TURN',
  'LUOSHEN_STEP',
  'RESOLVE_JUDGE',
  'DRAW_PHASE',
  'FINISH_DISCARD',
  'FINISH_TURN',
  'RESOLVE_PENDING_TRICK',
  'EXECUTE_DAMAGE',
  'CHECK_DEATH',
  'DUEL_DAMAGE',
  'MASS_TRICK_NEXT',
  'BORROW_SWORD_FAIL',
  'CONTINUE_STRIKE_QUEUE',
  'DRAW_CARDS'
] as const;

export type SanguoshaActionType = (typeof SANGUOSHA_ACTION_TYPES)[number];

const CARD_ACTION = (pid: PlayerId, card: Entity, targetPlayerId?: PlayerId, payload?: Record<string, unknown>): Action => ({
  type: 'PLAY_CARD',
  playerId: pid,
  entityId: card.id,
  ...(targetPlayerId ? { targetPlayerId } : {}),
  ...(payload ? { payload } : {})
});

const SKILL_HINT: Record<string, string> = {
  rende: '将一张手牌交给一名其他角色；给出第二张牌时回复1点体力',
  zhiheng: '弃置一张牌，然后摸一张牌（每阶段限一次）',
  kurou: '失去1点体力，然后摸两张牌（每阶段限一次）',
  qingnang: '弃置一张手牌，令一名已受伤角色回复1点体力（每阶段限一次）',
  jieyin: '弃置两张手牌，令你与一名已受伤男性角色各回复1点体力（每阶段限一次）',
  lijian: '弃置一张牌，令两名男性角色进行决斗（每阶段限一次）'
};

function skillAction(
  pid: PlayerId,
  skill: string,
  name: string,
  hint: string,
  input: { entityId?: string; targetPlayerId?: string; payload?: Record<string, unknown> } = {}
): Action {
  return {
    type: 'USE_SKILL',
    playerId: pid,
    ...(input.entityId ? { entityId: input.entityId } : {}),
    ...(input.targetPlayerId ? { targetPlayerId: input.targetPlayerId } : {}),
    payload: {
      skill,
      skillName: name,
      hint,
      ...(input.payload ?? {})
    }
  };
}

function targetsForStrike(state: GameState, pid: PlayerId): PlayerId[] {
  return alivePlayers(state).filter(
    target =>
      target !== pid &&
      inAttackRange(state, pid, target) &&
      !(hasSkill(state, target, 'kongcheng') && (state.zones[`zone_hand_${target}`]?.orderedEntities.length ?? 0) === 0)
  );
}

function canTargetDuel(state: GameState, pid: PlayerId, target: PlayerId): boolean {
  return target !== pid && state.players[target]?.alive && !(hasSkill(state, target, 'kongcheng') && (state.zones[`zone_hand_${target}`]?.orderedEntities.length ?? 0) === 0);
}

function targetHasCards(state: GameState, pid: PlayerId): boolean {
  return hasAnyCard(state, pid);
}

function handHasCard(state: GameState, pid: PlayerId, cardId: string): Entity | undefined {
  return handOf(state, pid).find(card => card.id === cardId);
}

function playableCardActions(state: GameState, pid: PlayerId, card: Entity): Action[] {
  const code = cardCode(card);
  const subtype = cardSubtype(card);
  const actions: Action[] = [];
  const others = alivePlayers(state).filter(target => target !== pid);

  if (isStrikeCard(card)) {
    if (!canUseStrike(state, pid)) return [];
    const strikeTargets = targetsForStrike(state, pid);
    for (const target of strikeTargets) {
      actions.push({
        type: 'PLAY_STRIKE',
        playerId: pid,
        entityId: card.id,
        targetPlayerId: target
      });
      if (code === 'sha' && hasEquipment(state, pid, 'zhuque')) {
        actions.push({
          type: 'PLAY_STRIKE',
          playerId: pid,
          entityId: card.id,
          targetPlayerId: target,
          payload: { zhuque: true }
        });
      }
    }
    // Fangtian Halberd: the last hand card may add up to two targets.
    if (handOf(state, pid).length === 1 && hasEquipment(state, pid, 'fangtian')) {
      for (const primary of strikeTargets) {
        const extras = strikeTargets.filter(target => target !== primary);
        for (let i = 0; i < extras.length; i += 1) {
          actions.push({
            type: 'PLAY_STRIKE',
            playerId: pid,
            entityId: card.id,
            targetPlayerId: primary,
            payload: { extraTargetIds: [extras[i]] }
          });
          for (let j = i + 1; j < extras.length; j += 1) {
            actions.push({
              type: 'PLAY_STRIKE',
              playerId: pid,
              entityId: card.id,
              targetPlayerId: primary,
              payload: { extraTargetIds: [extras[i], extras[j]] }
            });
          }
        }
      }
    }
    return actions;
  }

  if (code === 'tao') {
    for (const target of [pid, ...others]) {
      const targetProps = propsOf(state, target);
      if (targetProps.hp < targetProps.maxHp) {
        actions.push({ type: 'PLAY_PEACH', playerId: pid, entityId: card.id, targetPlayerId: target });
      }
    }
    return actions;
  }

  if (code === 'jiu') {
    if (!propsOf(state, pid).wineUsed) {
      actions.push({ type: 'PLAY_CARD', playerId: pid, entityId: card.id, targetPlayerId: pid });
    }
    return actions;
  }

  switch (subtype) {
    case 'DISMANTLE':
      for (const target of others) {
        if (targetHasCards(state, target)) actions.push(CARD_ACTION(pid, card, target));
      }
      break;
    case 'SNATCH':
      for (const target of others) {
        if (
          targetHasCards(state, target) &&
          (distanceBetween(state, pid, target) <= 1 || hasSkill(state, pid, 'qicai')) &&
          !hasSkill(state, target, 'qianxun')
        ) {
          actions.push(CARD_ACTION(pid, card, target));
        }
      }
      break;
    case 'DUEL':
      for (const target of others) {
        if (canTargetDuel(state, pid, target)) actions.push(CARD_ACTION(pid, card, target));
      }
      break;
    case 'BORROW_SWORD':
      for (const target of others) {
        // Query the equipment slot, not a hard-coded weapon list: adding a new
        // weapon to the catalogue must not silently make Borrowed Sword unusable.
        if (!equipmentOfSlot(state, target, 'WEAPON')) continue;
        for (const victim of alivePlayers(state).filter(v => v !== target && v !== pid)) {
          if (inAttackRange(state, target, victim)) {
            actions.push(CARD_ACTION(pid, card, target, { victimId: victim }));
          }
        }
      }
      break;
    case 'EX_NIHILO':
      actions.push(CARD_ACTION(pid, card, pid));
      break;
    case 'BARBARIAN':
    case 'ARROW':
    case 'PEACH_GARDEN':
    case 'HARVEST':
      actions.push(CARD_ACTION(pid, card));
      break;
    case 'IRON_CHAIN': {
      for (const target of others) actions.push(CARD_ACTION(pid, card, target));
      for (let i = 0; i < others.length; i += 1) {
        for (let j = i + 1; j < others.length; j += 1) {
          actions.push(CARD_ACTION(pid, card, others[i], { targetIds: [others[i], others[j]] }));
        }
      }
      actions.push(CARD_ACTION(pid, card, undefined, { recast: true }));
      break;
    }
    case 'FIRE_ATTACK':
      for (const target of others) {
        if ((state.zones[`zone_hand_${target}`]?.orderedEntities.length ?? 0) > 0) {
          actions.push(CARD_ACTION(pid, card, target));
        }
      }
      break;
    case 'INDULGENCE':
      for (const target of others) {
        if (!hasSkill(state, target, 'qianxun')) actions.push(CARD_ACTION(pid, card, target));
      }
      break;
    case 'LIGHTNING':
      actions.push(CARD_ACTION(pid, card, pid));
      break;
    case 'SUPPLY_SHORTAGE':
      for (const target of others) {
        if (distanceBetween(state, pid, target) <= 1) actions.push(CARD_ACTION(pid, card, target));
      }
      break;
    default:
      break;
  }
  return actions;
}

function skillActions(state: GameState, pid: PlayerId): Action[] {
  const actions: Action[] = [];
  const props = propsOf(state, pid);
  const hand = handOf(state, pid);
  const others = alivePlayers(state).filter(target => target !== pid);
  const wounded = [pid, ...others].filter(target => propsOf(state, target).hp < propsOf(state, target).maxHp);

  if (hasSkill(state, pid, 'rende')) {
    for (const card of hand) {
      for (const target of others) {
        actions.push(skillAction(pid, 'rende', '仁德', SKILL_HINT.rende, { entityId: card.id, targetPlayerId: target }));
      }
    }
  }

  if (hasSkill(state, pid, 'wusheng') && canUseStrike(state, pid)) {
    for (const card of hand.filter(card => cardIsRed(card))) {
      for (const target of targetsForStrike(state, pid)) {
        actions.push(skillAction(pid, 'wusheng', '武圣', '将一张红色牌当【杀】使用', { entityId: card.id, targetPlayerId: target, payload: { asCard: 'sha' } }));
      }
    }
  }

  if (hasSkill(state, pid, 'longdan') && canUseStrike(state, pid)) {
    for (const card of hand.filter(card => cardCode(card) === 'shan')) {
      for (const target of targetsForStrike(state, pid)) {
        actions.push(skillAction(pid, 'longdan', '龙胆', '将一张【闪】当【杀】使用', { entityId: card.id, targetPlayerId: target, payload: { asCard: 'sha' } }));
      }
    }
  }

  if (hasSkill(state, pid, 'qixi')) {
    for (const card of hand.filter(card => String(card.components.custom?.color) === 'black')) {
      for (const target of others.filter(target => targetHasCards(state, target))) {
        actions.push(skillAction(pid, 'qixi', '奇袭', '将一张黑色牌当【过河拆桥】使用', { entityId: card.id, targetPlayerId: target, payload: { asCard: 'guohe' } }));
      }
    }
  }

  if (hasSkill(state, pid, 'guose')) {
    for (const card of hand.filter(card => cardSuit(card) === '♦')) {
      for (const target of others.filter(target => !hasSkill(state, target, 'qianxun'))) {
        actions.push(skillAction(pid, 'guose', '国色', '将一张方块牌当【乐不思蜀】使用', { entityId: card.id, targetPlayerId: target, payload: { asCard: 'lebu' } }));
      }
    }
  }

  if (hasSkill(state, pid, 'zhiheng') && !props.zhihengUsed) {
    for (const card of hand) {
      actions.push(skillAction(pid, 'zhiheng', '制衡', SKILL_HINT.zhiheng, { entityId: card.id }));
    }
  }

  if (hasSkill(state, pid, 'kurou') && !props.kurouUsed && props.hp > 1) {
    actions.push(skillAction(pid, 'kurou', '苦肉', SKILL_HINT.kurou));
  }

  if (hasSkill(state, pid, 'qingnang') && !props.qingnangUsed) {
    for (const card of hand) {
      for (const target of wounded) {
        actions.push(skillAction(pid, 'qingnang', '青囊', SKILL_HINT.qingnang, { entityId: card.id, targetPlayerId: target }));
      }
    }
  }

  if (hasSkill(state, pid, 'jieyin') && !props.jieyinUsed && hand.length >= 2) {
    for (let i = 0; i < hand.length; i += 1) {
      for (let j = i + 1; j < hand.length; j += 1) {
        for (const target of others.filter(target => propsOf(state, target).gender === 'MALE' && propsOf(state, target).hp < propsOf(state, target).maxHp)) {
          actions.push(
            skillAction(pid, 'jieyin', '结姻', SKILL_HINT.jieyin, {
              entityId: hand[i].id,
              targetPlayerId: target,
              payload: { cardIds: [hand[i].id, hand[j].id] }
            })
          );
        }
      }
    }
  }

  if (hasSkill(state, pid, 'lijian') && !props.lijianUsed) {
    const males = others.filter(target => propsOf(state, target).gender === 'MALE');
    for (const card of hand) {
      for (let i = 0; i < males.length; i += 1) {
        for (let j = 0; j < males.length; j += 1) {
          if (i === j) continue;
          actions.push(
            skillAction(pid, 'lijian', '离间', SKILL_HINT.lijian, {
              entityId: card.id,
              targetPlayerId: males[i],
              payload: { targetIds: [males[i], males[j]], cardIds: [card.id] }
            })
          );
        }
      }
    }
  }

  return actions;
}

function choiceActions(choice: SgsPendingChoice, pid: PlayerId): Action[] {
  if (choice.playerId !== pid) return [];
  return choice.options.map(option => ({
    type: 'RESOLVE_CHOICE',
    playerId: pid,
    ...(option.cardId ? { entityId: option.cardId } : {}),
    payload: {
      choiceId: choice.id,
      optionId: option.id,
      choiceLabel: option.label
    }
  }));
}

function responseActions(state: GameState, pid: PlayerId): Action[] {
  const frame = state.interruptStack[state.interruptStack.length - 1];
  if (!frame || frame.status !== 'WAITING_INPUT' || !frame.responseWindow) return [];
  const eligible = frame.responseWindow.eligibleActors ?? frame.responseWindow.eligiblePlayers;
  if (!eligible.includes(pid)) return [];
  const hand = handOf(state, pid);
  const pass: Action = { type: 'PASS', playerId: pid };
  const actions: Action[] = [];

  if (frame.type === 'STRIKE_RESOLUTION') {
    const context = strikeContext(state);
    if (!context) return [pass];
    const target = context.targetId;
    const isTarget = pid === target;
    const hujiaForTarget =
      !isTarget &&
      hasSkill(state, target, 'hujia') &&
      isLord(state, target) &&
      propsOf(state, pid).kingdom === 'WEI' &&
      propsOf(state, target).kingdom === 'WEI';

    if (isTarget || hujiaForTarget) {
      for (const card of hand.filter(card => cardCode(card) === 'shan')) {
        actions.push({ type: 'PLAY_DODGE', playerId: pid, entityId: card.id, ...(isTarget ? {} : { payload: { forPlayerId: target } }) });
      }
      if (isTarget && hasSkill(state, pid, 'longdan')) {
        for (const card of hand.filter(card => cardCode(card) === 'sha')) {
          actions.push({ type: 'PLAY_DODGE', playerId: pid, entityId: card.id, payload: { skill: 'longdan' } });
        }
      }
      if (isTarget && hasSkill(state, pid, 'qingguo')) {
        for (const card of hand.filter(card => String(card.components.custom?.color) === 'black')) {
          actions.push({ type: 'PLAY_DODGE', playerId: pid, entityId: card.id, payload: { skill: 'qingguo' } });
        }
      }
      if (isTarget && hasEquipment(state, target, 'bagua') && !context.armorIgnored && !context.baguaUsed) {
        actions.push({ type: 'JUDGE_BAGUA', playerId: pid });
      }
    }
    actions.push(pass);
    return actions;
  }

  if (frame.type === 'DUEL_RESOLUTION') {
    const context = duelContext(state);
    if (!context) return [pass];
    const responder = context.responder;
    const jijiangForResponder =
      pid !== responder &&
      hasSkill(state, responder, 'jijiang') &&
      isLord(state, responder) &&
      propsOf(state, pid).kingdom === 'SHU' &&
      propsOf(state, responder).kingdom === 'SHU';
    if (pid === responder || jijiangForResponder) {
      for (const card of hand.filter(card => isStrikeCard(card))) {
        actions.push({
          type: 'PLAY_STRIKE',
          playerId: pid,
          entityId: card.id,
          payload: { context: 'DUEL', ...(pid === responder ? {} : { forPlayerId: responder }) }
        });
      }
      if (pid === responder && hasSkill(state, pid, 'wusheng')) {
        for (const card of hand.filter(card => cardIsRed(card))) {
          actions.push({
            type: 'PLAY_STRIKE',
            playerId: pid,
            entityId: card.id,
            payload: { context: 'DUEL', skill: 'wusheng' }
          });
        }
      }
      if (pid === responder && hasSkill(state, pid, 'longdan')) {
        for (const card of hand.filter(card => cardCode(card) === 'shan')) {
          actions.push({
            type: 'PLAY_STRIKE',
            playerId: pid,
            entityId: card.id,
            payload: { context: 'DUEL', skill: 'longdan' }
          });
        }
      }
    }
    actions.push(pass);
    return actions;
  }

  if (frame.type === 'MASS_TRICK_RESOLUTION') {
    const context = massTrickContext(state);
    if (!context) return [pass];
    const target = context.targetIds[context.targetIndex];
    const jijiangForTarget =
      pid !== target &&
      hasSkill(state, target, 'jijiang') &&
      isLord(state, target) &&
      propsOf(state, pid).kingdom === 'SHU' &&
      propsOf(state, target).kingdom === 'SHU';
    const hujiaForTarget =
      pid !== target &&
      hasSkill(state, target, 'hujia') &&
      isLord(state, target) &&
      propsOf(state, pid).kingdom === 'WEI' &&
      propsOf(state, target).kingdom === 'WEI';
    if (pid === target || jijiangForTarget || hujiaForTarget) {
      if (context.kind === 'BARBARIAN') {
        for (const card of hand.filter(card => isStrikeCard(card))) {
          actions.push({
            type: 'PLAY_STRIKE',
            playerId: pid,
            entityId: card.id,
            payload: { context: 'MASS', ...(pid === target ? {} : { forPlayerId: target }) }
          });
        }
      } else {
        for (const card of hand.filter(card => cardCode(card) === 'shan')) {
          actions.push({
            type: 'PLAY_DODGE',
            playerId: pid,
            entityId: card.id,
            payload: { context: 'MASS', ...(pid === target ? {} : { forPlayerId: target }) }
          });
        }
      }
    }
    actions.push(pass);
    return actions;
  }

  if (frame.type === 'DYING_RESCUE') {
    const dying = state.globalVars.dying as { victimId?: PlayerId } | undefined;
    const victim = dying?.victimId;
    if (!victim) return [pass];
    for (const card of hand.filter(card => cardCode(card) === 'tao')) {
      actions.push({ type: 'PLAY_PEACH', playerId: pid, entityId: card.id, targetPlayerId: victim });
    }
    if (victim === pid) {
      for (const card of hand.filter(card => cardCode(card) === 'jiu')) {
        actions.push({ type: 'PLAY_PEACH', playerId: pid, entityId: card.id, targetPlayerId: victim, payload: { wine: true } });
      }
    }
    if (hasSkill(state, pid, 'jijiu') && state.activePlayerId !== pid) {
      for (const card of hand.filter(card => cardIsRed(card))) {
        actions.push({
          type: 'PLAY_PEACH',
          playerId: pid,
          entityId: card.id,
          targetPlayerId: victim,
          payload: { skill: 'jijiu' }
        });
      }
    }
    actions.push(pass);
    return actions;
  }

  if (frame.type === 'TRICK_RESOLUTION' || frame.type === 'WUXIE_RESOLUTION' || frame.type === 'JUDGE_TRICK_RESOLUTION') {
    for (const card of hand.filter(card => cardCode(card) === 'wuxie')) {
      actions.push({ type: 'PLAY_WUXIE', playerId: pid, entityId: card.id });
    }
    actions.push(pass);
    return actions;
  }

  if (frame.type === 'BORROW_SWORD_RESOLUTION') {
    const pending = state.globalVars.pendingTrick as { victimId?: PlayerId } | undefined;
    const victim = pending?.victimId;
    if (victim) {
      for (const card of hand.filter(card => isStrikeCard(card))) {
        actions.push({
          type: 'PLAY_STRIKE',
          playerId: pid,
          entityId: card.id,
          targetPlayerId: victim,
          payload: { context: 'BORROWED' }
        });
      }
    }
    actions.push(pass);
    return actions;
  }

  return [pass];
}

function preferAiAction(state: GameState, playerId: PlayerId, actions: Action[]): Action[] {
  if (!isAiSeat(state, playerId)) return actions;
  // 宪章 C-5：AI 只看自己的投影。与 poker 的 decisionView() 同一份投影，
  // 牌堆顺序、对手手牌、prngState / seed 在类型层面就读不到。
  const view = CognitiveObserver.projectState(state, playerId, undefined, undefined, undefined);
  const chosen = chooseSanguoshaAiAction(view, playerId, actions);
  return chosen ? [chosen] : [];
}

export function getSanguoshaLegalActions(state: GameState, playerId: PlayerId): Action[] {
  if (state.gameOver) return [];
  const frame = state.interruptStack[state.interruptStack.length - 1];
  if (frame && frame.status === 'WAITING_INPUT' && frame.responseWindow) {
    return preferAiAction(state, playerId, responseActions(state, playerId));
  }
  const pendingChoice = state.globalVars.pendingChoice as SgsPendingChoice | undefined;
  if (pendingChoice) {
    return preferAiAction(state, playerId, choiceActions(pendingChoice, playerId));
  }
  if (state.activePlayerId !== playerId) return [];
  const phase = state.phase;
  if (phase === 'DISCARD') {
    const hand = handOf(state, playerId);
    const limit = propsOf(state, playerId).hp;
    if (hand.length <= limit) return [];
    return preferAiAction(
      state,
      playerId,
      hand.map(card => ({ type: 'DISCARD_CARD', playerId, entityId: card.id }))
    );
  }
  if (phase !== 'PLAY') return [];
  if (propsOf(state, playerId).skipPlay) return [];

  const actions: Action[] = [];
  for (const card of handOf(state, playerId)) {
    const subtype = cardSubtype(card);
    if (subtype === 'WEAPON' || subtype === 'ARMOR' || subtype === 'HORSE_PLUS' || subtype === 'HORSE_MINUS' || subtype === 'TREASURE') {
      actions.push({ type: 'EQUIP_CARD', playerId, entityId: card.id });
      continue;
    }
    actions.push(...playableCardActions(state, playerId, card));
  }
  if (hasEquipment(state, playerId, 'zhangba') && canUseStrike(state, playerId)) {
    const hand = handOf(state, playerId);
    for (let i = 0; i < hand.length; i += 1) {
      for (let j = i + 1; j < hand.length; j += 1) {
        for (const target of targetsForStrike(state, playerId)) {
          actions.push({
            type: 'PLAY_STRIKE',
            playerId,
            entityId: hand[i].id,
            targetPlayerId: target,
            payload: { cardIds: [hand[i].id, hand[j].id], skill: 'zhangba' }
          });
        }
      }
    }
  }
  actions.push(...skillActions(state, playerId));
  actions.push({ type: 'END_TURN', playerId });
  return preferAiAction(state, playerId, actions);
}

export function canPlayCard(state: GameState, pid: PlayerId, cardId: string): boolean {
  const card = handHasCard(state, pid, cardId);
  if (!card) return false;
  return playableCardActions(state, pid, card).length > 0 || ['WEAPON', 'ARMOR', 'HORSE_PLUS', 'HORSE_MINUS', 'TREASURE'].includes(cardSubtype(card));
}

/** Distance helper exported for tests and presentation. */
export function effectiveAttackRange(state: GameState, pid: PlayerId): number {
  return attackRangeOf(state, pid);
}
