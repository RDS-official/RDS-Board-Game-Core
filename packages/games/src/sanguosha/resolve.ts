import { openDecision } from '@rds/kernel/decisions';
import { ReduceContext } from '@rds/kernel/module';
import { InterruptStackManager } from '@rds/kernel/stack';
import { Action, DecisionWindow, EntityId, GameState, PlayerId, StackFrame, VisualEventType } from '@rds/kernel/types';
import { cardCode, cardElement, cardIsRed, cardSuit, cardSubtype, isStrikeCard } from './helpers';
import {
  DECK_ZONE,
  DISCARD_ZONE,
  EQUIP_ZONE,
  HAND_ZONE,
  JUDGE_ZONE,
  alivePlayers,
  allCardIds,
  canUseStrike,
  cardLabel,
  clearResponseContext,
  discardCardIds,
  drawCards,
  drawJudgeCard,
  duelContext,
  equipCard,
  equipmentOfSlot,
  equipOf,
  handIdsOf,
  handOf,
  hasEquipment,
  hasSkill,
  inAttackRange,
  isLord,
  judgeOf,
  massTrickContext,
  moveCard,
  nextAlivePlayer,
  propsOf,
  randomCardFromPlayer,
  resetTurnFlags,
  reshuffleDiscardIntoDeck,
  setProps,
  settleJudgeCard,
  strikeContext,
  syncEquipmentHooks
} from './helpers';
import { checkSanguoshaWin } from './outcome';
import { sanguoshaScoreDeltas } from './scoring';
import {
  SgsCardSubtype,
  SgsDuelContext,
  SgsMassTrickContext,
  SgsPendingChoice,
  SgsPendingChoiceOption,
  SgsPendingTrick,
  SgsStrikeContext,
  SgsStrikeQueue
} from './types';

const PROCESSING_ZONE = 'zone_judge_public';

function trace(ctx: ReduceContext, type: VisualEventType, title: string, durationMs = 400): void {
  ctx.trace({ id: ctx.id('evt'), type, title, durationMs });
}

function updateGlobal(state: GameState, patch: Record<string, unknown>): GameState {
  return { ...state, globalVars: { ...state.globalVars, ...patch } };
}

function clearGlobal(state: GameState, keys: string[]): GameState {
  const globalVars = { ...state.globalVars };
  for (const key of keys) delete globalVars[key];
  return { ...state, globalVars };
}

function responseWindow(state: GameState, players: PlayerId[]): StackFrame['responseWindow'] {
  const eligiblePlayers = [...new Set(players)].filter(pid => !!state.players[pid]?.alive);
  return {
    eligiblePlayers,
    pendingResponses: Object.fromEntries(eligiblePlayers.map(pid => [pid, 'PENDING' as const]))
  };
}

function pushFrame(state: GameState, frame: StackFrame): GameState {
  return InterruptStackManager.push(state, frame);
}

function currentHandCount(state: GameState, pid: PlayerId): number {
  return handIdsOf(state, pid).length;
}

function maybeLianying(state: GameState, pid: PlayerId, ctx: ReduceContext): GameState {
  if (!hasSkill(state, pid, 'lianying')) return state;
  if (currentHandCount(state, pid) !== 0) return state;
  const drawn = drawCards(state, pid, 1);
  if (drawn.drawn.length > 0) {
    trace(ctx, 'CARD_DRAW', `${state.players[pid]?.name ?? pid} 发动【连营】摸了一张牌`, 350);
  }
  return drawn.state;
}

function clearPendingChoice(state: GameState): GameState {
  return clearGlobal(state, ['pendingChoice']);
}

/**
 * A pending choice is a one-participant kernel DecisionWindow, not a response
 * frame. The kernel already provides the focus set, action submission,
 * timeout and replay semantics; the game only owns the option payload.
 */
function openChoiceDecision(state: GameState, ctx: ReduceContext, choice: SgsPendingChoice): GameState {
  if (choice.options.length === 0) return clearPendingChoice(state);
  const title =
    choice.kind === 'HARVEST_PICK'
      ? `【五谷丰登】：${state.players[choice.playerId]?.name ?? choice.playerId} 选牌`
      : choice.kind === 'FIRE_ATTACK_PICK'
        ? '【火攻】：是否弃置同花色牌'
        : `选择 ${state.players[choice.targetId]?.name ?? choice.targetId} 的一张牌`;
  // Fire Attack options are the source's own hand cards; the public decision
  // text must not spell them out. The owner still sees concrete labels in their
  // legal-action DTO, while other viewers only get an opaque description.
  const description =
    choice.kind === 'FIRE_ATTACK_PICK'
      ? '选择是否弃置一张与展示牌同花色的手牌'
      : choice.options.map(option => option.label).join(' / ');
  const opened = openDecision(
    state,
    {
      kind: 'SIMULTANEOUS',
      title,
      description,
      participants: [choice.playerId],
      secret: false,
      policy: { type: 'ALL_COMMITTED' },
      payload: { kind: 'sgs_choice', choiceId: choice.id }
    },
    ctx.id('choice_decision')
  );
  return updateGlobal(opened.state, { pendingChoice: choice });
}

function openDismantleChoice(
  state: GameState,
  ctx: ReduceContext,
  input: { sourceId: PlayerId; targetId: PlayerId; snatch: boolean }
): GameState {
  const options: SgsPendingChoiceOption[] = [];
  if (handIdsOf(state, input.targetId).length > 0) {
    options.push({ id: 'hand', label: '随机手牌', zone: 'HAND' });
  }
  for (const card of equipOf(state, input.targetId)) {
    options.push({ id: `equip:${card.id}`, label: cardLabel(state, card.id), cardId: card.id, zone: 'EQUIP' });
  }
  for (const card of judgeOf(state, input.targetId)) {
    options.push({ id: `judge:${card.id}`, label: cardLabel(state, card.id), cardId: card.id, zone: 'JUDGE' });
  }
  if (options.length === 0) return clearGlobal(state, ['pendingTrick', 'wuxieCount']);
  const choice: SgsPendingChoice = {
    id: ctx.id('choice'),
    playerId: input.sourceId,
    kind: 'DISMANTLE_PICK',
    sourceId: input.sourceId,
    targetId: input.targetId,
    snatch: input.snatch,
    options
  };
  return openChoiceDecision(clearGlobal(state, ['pendingTrick', 'wuxieCount']), ctx, choice);
}

function openHarvestChoice(state: GameState, ctx: ReduceContext, choice: SgsPendingChoice): GameState {
  const remaining = (choice.revealedCardIds ?? []).filter(id => !!state.entities[id]);
  if (remaining.length === 0) return clearPendingChoice(state);
  const targetIds = choice.targetIds ?? [];
  const targetIndex = choice.targetIndex ?? 0;
  const target = targetIds[targetIndex];
  if (!target || !state.players[target]?.alive) {
    let next = state;
    for (const id of remaining) next = moveCard(next, id, DISCARD_ZONE);
    return clearPendingChoice(next);
  }
  const nextChoice: SgsPendingChoice = {
    ...choice,
    id: ctx.id('choice'),
    playerId: target,
    targetId: target,
    targetIndex,
    revealedCardIds: remaining,
    options: remaining.map(id => ({ id: `harvest:${id}`, label: cardLabel(state, id), cardId: id }))
  };
  return openChoiceDecision(state, ctx, nextChoice);
}

function openFireAttackChoice(
  state: GameState,
  ctx: ReduceContext,
  sourceId: PlayerId,
  targetId: PlayerId
): GameState {
  const hand = handOf(state, targetId);
  if (hand.length === 0) return clearGlobal(state, ['pendingTrick', 'wuxieCount']);
  const picked = randomCardFromPlayer(state, targetId, 'HAND');
  let next = { ...picked.state, prngState: picked.nextSeed };
  if (!picked.cardId) return clearGlobal(next, ['pendingTrick', 'wuxieCount']);
  next = moveCard(next, picked.cardId, PROCESSING_ZONE);
  const revealed = next.entities[picked.cardId];
  const suit = cardSuit(revealed);
  const options: SgsPendingChoiceOption[] = [{ id: 'pass', label: '不弃牌，放弃伤害' }];
  for (const card of handOf(next, sourceId)) {
    if (cardSuit(card) === suit) {
      options.push({ id: `fire:${card.id}`, label: `弃置 ${cardLabel(next, card.id)}`, cardId: card.id, zone: 'HAND' });
    }
  }
  const choice: SgsPendingChoice = {
    id: ctx.id('choice'),
    playerId: sourceId,
    kind: 'FIRE_ATTACK_PICK',
    sourceId,
    targetId,
    options,
    revealedCardId: picked.cardId
  };
  trace(ctx, 'ANNOUNCEMENT', `${next.players[targetId]?.name ?? targetId} 展示了 ${cardLabel(next, picked.cardId)}`, 400);
  return openChoiceDecision(clearGlobal(next, ['pendingTrick', 'wuxieCount']), ctx, choice);
}

function applyDismantleChoice(state: GameState, ctx: ReduceContext, choice: SgsPendingChoice, option: SgsPendingChoiceOption): GameState {
  let next = state;
  let cardId = option.cardId ?? null;
  if (option.zone === 'HAND') {
    const picked = randomCardFromPlayer(next, choice.targetId, 'HAND');
    next = { ...picked.state, prngState: picked.nextSeed };
    cardId = picked.cardId;
  }
  if (cardId) {
    const wasEquipment = next.entities[cardId]?.zoneId === EQUIP_ZONE(choice.targetId);
    if (choice.snatch) {
      next = moveCard(next, cardId, HAND_ZONE(choice.sourceId));
      trace(ctx, 'CARD_PLAY', `${next.players[choice.sourceId]?.name ?? choice.sourceId} 获得了 ${next.players[choice.targetId]?.name ?? choice.targetId} 的一张牌`, 400);
    } else {
      next = discardWithXiaoji(next, ctx, choice.targetId, [cardId]);
      trace(ctx, 'CARD_DISCARD', `${next.players[choice.sourceId]?.name ?? choice.sourceId} 弃置了 ${next.players[choice.targetId]?.name ?? choice.targetId} 的一张牌`, 400);
    }
    if (wasEquipment) next = syncEquipmentHooks(next);
    next = maybeLianying(next, choice.targetId, ctx);
  }
  return clearPendingChoice(next);
}

function applyHarvestChoice(state: GameState, ctx: ReduceContext, choice: SgsPendingChoice, option: SgsPendingChoiceOption): GameState {
  if (!option.cardId || !state.entities[option.cardId]) return clearPendingChoice(state);
  let next = moveCard(state, option.cardId, HAND_ZONE(choice.playerId));
  const remaining = (choice.revealedCardIds ?? []).filter(id => id !== option.cardId);
  const targetIds = choice.targetIds ?? [];
  const nextIndex = (choice.targetIndex ?? 0) + 1;
  if (nextIndex >= targetIds.length) {
    for (const id of remaining) next = moveCard(next, id, DISCARD_ZONE);
    return clearPendingChoice(next);
  }
  return openHarvestChoice(next, ctx, {
    ...choice,
    targetIds,
    targetIndex: nextIndex,
    revealedCardIds: remaining
  });
}

function applyFireAttackChoice(state: GameState, ctx: ReduceContext, choice: SgsPendingChoice, option: SgsPendingChoiceOption): GameState {
  let next = state;
  const revealedId = choice.revealedCardId;
  if (option.id !== 'pass' && option.cardId && handIdsOf(next, choice.sourceId).includes(option.cardId)) {
    next = discardFromHand(next, choice.sourceId, option.cardId);
    if (revealedId && next.entities[revealedId]?.zoneId === PROCESSING_ZONE) {
      next = moveCard(next, revealedId, HAND_ZONE(choice.targetId));
    }
    next = doDamage(next, ctx, {
      sourceId: choice.sourceId,
      targetId: choice.targetId,
      amount: 1,
      element: 'FIRE',
      reason: '【火攻】'
    });
  } else if (revealedId && next.entities[revealedId]?.zoneId === PROCESSING_ZONE) {
    next = moveCard(next, revealedId, HAND_ZONE(choice.targetId));
  }
  return clearPendingChoice(next);
}

function resolveChoice(state: GameState, ctx: ReduceContext, action: Action): GameState {
  const choice = state.globalVars.pendingChoice as SgsPendingChoice | undefined;
  if (!choice || choice.playerId !== action.playerId) return state;
  const optionId = String(action.payload?.optionId ?? '');
  const option = choice.options.find(candidate => candidate.id === optionId);
  if (!option) return state;
  switch (choice.kind) {
    case 'DISMANTLE_PICK':
      return applyDismantleChoice(state, ctx, choice, option);
    case 'HARVEST_PICK':
      return applyHarvestChoice(state, ctx, choice, option);
    case 'FIRE_ATTACK_PICK':
      return applyFireAttackChoice(state, ctx, choice, option);
    default:
      return clearPendingChoice(state);
  }
}

function discardFromHand(state: GameState, pid: PlayerId, cardId: EntityId): GameState {
  if (!handIdsOf(state, pid).includes(cardId)) return state;
  return moveCard(state, cardId, DISCARD_ZONE);
}

function equipmentLost(discardedIds: EntityId[], equipmentIds: EntityId[]): number {
  return discardedIds.filter(id => equipmentIds.includes(id)).length;
}

function discardWithXiaoji(
  state: GameState,
  ctx: ReduceContext,
  owner: PlayerId,
  cardIds: EntityId[]
): GameState {
  const beforeEquipment = [...(state.zones[EQUIP_ZONE(owner)]?.orderedEntities ?? [])];
  let next = discardCardIds(state, cardIds);
  if (equipmentLost(cardIds, beforeEquipment) > 0 && hasSkill(next, owner, 'xiaoji')) {
    const drawn = drawCards(next, owner, 2);
    next = drawn.state;
    trace(ctx, 'CARD_DRAW', '【枭姬】失去装备后摸两张牌', 350);
  }
  return syncEquipmentHooks(next);
}

function strikeResponders(state: GameState, targetId: PlayerId): PlayerId[] {
  const responders = [targetId];
  if (hasSkill(state, targetId, 'hujia') && isLord(state, targetId)) {
    for (const ally of alivePlayers(state)) {
      if (ally === targetId || propsOf(state, ally).kingdom !== 'WEI') continue;
      if (handOf(state, ally).some(card => cardCode(card) === 'shan')) responders.push(ally);
    }
  }
  return responders;
}

function ensureStrikeWindow(state: GameState, ctx: ReduceContext, context: SgsStrikeContext): GameState {
  const next = updateGlobal(state, { strike: context });
  const target = next.players[context.targetId];
  const frame: StackFrame = {
    id: ctx.id('strike_frame'),
    type: 'STRIKE_RESOLUTION',
    title: `【杀】→ ${target?.name ?? context.targetId}`,
    description: `${target?.name ?? context.targetId} 需打出 ${context.dodgesNeeded - context.dodgesPlayed} 张【闪】，否则受到 ${context.amount} 点伤害。`,
    sourcePlayerId: context.sourceId,
    targetPlayerId: context.targetId,
    entityId: context.cardId,
    actionPayload: {
      type: 'EXECUTE_DAMAGE',
      playerId: context.targetId,
      payload: {
        sourceId: context.sourceId,
        targetId: context.targetId,
        amount: context.amount,
        element: context.element,
        cardId: context.cardId,
        reason: '杀',
        ignoreArmor: context.armorIgnored
      }
    },
    status: 'WAITING_INPUT'
  };
  frame.responseWindow = responseWindow(next, strikeResponders(next, context.targetId));
  return pushFrame(next, frame);
}

function dodgeSucceeded(state: GameState, ctx: ReduceContext, context: SgsStrikeContext): GameState {
  const nextPlayed = context.dodgesPlayed + 1;
  if (nextPlayed < context.dodgesNeeded) {
    return ensureStrikeWindow(state, ctx, { ...context, dodgesPlayed: nextPlayed });
  }
  trace(ctx, 'STACK_CANCEL', `${state.players[context.targetId]?.name ?? context.targetId} 抵消了【杀】`, 350);
  const sourceWeapon = equipmentOfSlot(state, context.sourceId, 'WEAPON');
  if (cardCode(sourceWeapon) === 'guanshi' && currentHandCount(state, context.sourceId) >= 2) {
    const spent = handIdsOf(state, context.sourceId).slice(0, 2);
    let next = discardCardIds(state, spent);
    trace(ctx, 'CARD_DISCARD', '【贯石斧】：弃置两张牌，令此【杀】依然造成伤害', 400);
    next = clearResponseContext(next);
    return doDamage(next, ctx, {
      sourceId: context.sourceId,
      targetId: context.targetId,
      amount: context.amount,
      element: context.element,
      cardId: context.cardId,
      reason: '【杀】·【贯石斧】'
    });
  }
  if (cardCode(sourceWeapon) === 'qinglong' && !context.qinglongUsed) {
    const followUp = handOf(state, context.sourceId).find(card => isStrikeCard(card));
    if (followUp) {
      let next = discardFromHand(state, context.sourceId, followUp.id);
      trace(ctx, 'CARD_PLAY', '【青龙偃月刀】：对同一目标再使用一张【杀】', 400);
      return beginStrike(next, ctx, context.sourceId, context.targetId, [followUp.id], {
        consumeLimit: false,
        qinglongUsed: true
      });
    }
  }
  return clearResponseContext(state);
}

function strikeAmount(state: GameState, sourceId: PlayerId, targetId: PlayerId, bonus: number): number {
  let amount = 1 + Math.max(0, bonus);
  const weapon = equipmentOfSlot(state, sourceId, 'WEAPON');
  if (cardCode(weapon) === 'guding' && currentHandCount(state, targetId) === 0) amount += 1;
  return amount;
}

function beginStrike(
  state: GameState,
  ctx: ReduceContext,
  sourceId: PlayerId,
  targetId: PlayerId,
  cardIds: EntityId[],
  options: {
    consumeLimit: boolean;
    element?: 'NORMAL' | 'FIRE' | 'THUNDER';
    qinglongUsed?: boolean;
    bonusOverride?: number;
  }
): GameState {
  const primary = state.entities[cardIds[0]];
  if (!primary) return state;
  const sourceProps = propsOf(state, sourceId);
  const targetProps = propsOf(state, targetId);
  const wineBonus = options.bonusOverride ?? Number(sourceProps.wineBonus ?? 0);
  trace(
    ctx,
    'CARD_PLAY',
    `${state.players[sourceId]?.name ?? sourceId} 对 ${state.players[targetId]?.name ?? targetId} 使用【${cardLabel(state, primary.id)}】`,
    400
  );
  let next = state;
  const element = options.element ?? cardElement(primary);

  if (options.consumeLimit) {
    next = setProps(next, sourceId, {
      strikesUsed: Number(sourceProps.strikesUsed ?? 0) + 1,
      wineBonus: 0
    });
    next = updateGlobal(next, { hasPlayedStrikeThisTurn: true });
  }

  const weapon = equipmentOfSlot(next, sourceId, 'WEAPON');
  const armorIgnored = cardCode(weapon) === 'qinggang';
  let noDodge = false;

  if (hasSkill(next, sourceId, 'tieqi')) {
    const judged = drawJudgeCard(next, sourceId);
    next = judged.state;
    if (judged.cardId) {
      trace(ctx, 'ANNOUNCEMENT', `【铁骑】判定：${judged.suit}${judged.rank} ${judged.red ? '红色，目标不可闪避' : '黑色'}`, 450);
      noDodge = judged.red;
      next = settleJudgeCard(next, judged.cardId);
      next = updateGlobal(next, {
        lastJudge: { playerId: sourceId, cardId: judged.cardId, suit: judged.suit, rank: judged.rank, red: judged.red, source: 'tieqi' }
      });
    }
  }

  if (cardCode(weapon) === 'cixiong' && targetProps.gender !== sourceProps.gender) {
    if (currentHandCount(next, targetId) > 0) {
      const picked = handIdsOf(next, targetId)[0];
      next = discardCardIds(next, [picked]);
      trace(ctx, 'CARD_DISCARD', `【雌雄双股剑】：${next.players[targetId]?.name ?? targetId} 弃置一张手牌`, 350);
    } else {
      next = drawCards(next, sourceId, 1).state;
      trace(ctx, 'CARD_DRAW', `【雌雄双股剑】：${next.players[sourceId]?.name ?? sourceId} 摸一张牌`, 350);
    }
  }

  const amount = strikeAmount(next, sourceId, targetId, wineBonus);
  const context: SgsStrikeContext = {
    sourceId,
    targetId,
    cardId: primary.id,
    element,
    amount,
    dodgesNeeded: hasSkill(next, sourceId, 'wushuang') ? 2 : 1,
    dodgesPlayed: 0,
    noDodge,
    armorIgnored,
    ...(options.qinglongUsed ? { qinglongUsed: true } : {}),
    cardIds: [...cardIds]
  };

  const armor = equipmentOfSlot(next, targetId, 'ARMOR');
  const armorCode = cardCode(armor);
  const blackStrike = String(primary.components.custom?.color ?? '') === 'black';
  if (!armorIgnored && armorCode === 'renwang' && blackStrike) {
    trace(ctx, 'STACK_CANCEL', `【仁王盾】：黑色【杀】对 ${next.players[targetId]?.name ?? targetId} 无效`, 450);
    return clearResponseContext(next);
  }
  if (!armorIgnored && armorCode === 'tengjia' && element === 'NORMAL') {
    trace(ctx, 'STACK_CANCEL', `【藤甲】：普通【杀】对 ${next.players[targetId]?.name ?? targetId} 无效`, 450);
    return clearResponseContext(next);
  }
  if (noDodge) {
    trace(ctx, 'ANNOUNCEMENT', `【铁骑】：${next.players[targetId]?.name ?? targetId} 不能使用【闪】`, 350);
    return doDamage(next, ctx, {
      sourceId,
      targetId,
      amount,
      element,
      cardId: primary.id,
      reason: '【杀】'
    });
  }
  return ensureStrikeWindow(next, ctx, context);
}

function continueStrikeQueue(state: GameState, ctx: ReduceContext): GameState {
  const queue = state.globalVars.strikeQueue as SgsStrikeQueue | undefined;
  if (!queue) return state;
  if (queue.index >= queue.targets.length) {
    return clearGlobal(state, ['strikeQueue']);
  }
  const target = queue.targets[queue.index];
  const nextQueue = { ...queue, index: queue.index + 1 };
  let next = clearGlobal(updateGlobal(state, { strikeQueue: nextQueue }), ['strike']);
  if (!next.players[target]?.alive) return continueStrikeQueue(next, ctx);
  const card = next.entities[queue.cardId];
  if (!card) return clearGlobal(next, ['strikeQueue']);
  return beginStrike(next, ctx, queue.sourceId, target, queue.cardIds, {
    consumeLimit: false,
    element: queue.element,
    bonusOverride: queue.bonus
  });
}

function doDamage(
  state: GameState,
  ctx: ReduceContext,
  input: {
    sourceId: PlayerId | null;
    targetId: PlayerId;
    amount: number;
    element: 'NORMAL' | 'FIRE' | 'THUNDER';
    cardId?: EntityId;
    reason: string;
    ignoreArmor?: boolean;
  }
): GameState {
  let next = state;
  const target = next.players[input.targetId];
  if (!target?.alive) return next;
  let amount = Math.max(0, Math.floor(input.amount));
  if (amount <= 0) return next;

  const damageCard = input.cardId ? next.entities[input.cardId] : undefined;
  if (input.sourceId && hasEquipment(next, input.sourceId, 'hanbing') && isStrikeCard(damageCard)) {
    const toDiscard = allCardIds(next, input.targetId).slice(0, 2);
    if (toDiscard.length > 0) {
      next = discardWithXiaoji(next, ctx, input.targetId, toDiscard);
      trace(ctx, 'CARD_DISCARD', `【寒冰剑】：防止伤害，改为弃置 ${target.name} 的两张牌`, 400);
      return next;
    }
  }

  const baiyin = !input.ignoreArmor && hasEquipment(next, input.targetId, 'baiyin');
  if (baiyin && amount > 1) {
    amount = 1;
    trace(ctx, 'ANNOUNCEMENT', `【白银狮子】将伤害减至1点`, 300);
  }
  const tengjia = !input.ignoreArmor && hasEquipment(next, input.targetId, 'tengjia');
  if (tengjia && input.element === 'FIRE') {
    amount += 1;
    trace(ctx, 'ANNOUNCEMENT', `【藤甲】令火焰伤害+1`, 300);
  }

  const before = Number(propsOf(next, input.targetId).hp);
  const hp = Math.max(0, before - amount);
  next = setProps(next, input.targetId, { hp });
  next = updateGlobal(next, {
    lastDamage: {
      sourceId: input.sourceId,
      targetId: input.targetId,
      amount,
      element: input.element,
      cardId: input.cardId ?? null,
      reason: input.reason
    }
  });
  if (before > 0) {
    ctx.reward(input.targetId, 'hp', -Math.min(before, amount), `${input.reason}${input.sourceId ? '伤害' : ''}`);
  }
  trace(
    ctx,
    'DAMAGE_EFFECT',
    `${target.name} 受到 ${amount} 点${input.element === 'FIRE' ? '火焰' : input.element === 'THUNDER' ? '雷电' : ''}伤害（${hp}/${Number(propsOf(next, input.targetId).maxHp)}）`,
    550
  );

  if (input.sourceId) {
    const sourceProps = propsOf(next, input.sourceId);
    if (hasSkill(next, input.targetId, 'jianxiong') && input.cardId) {
      const card = next.entities[input.cardId];
      if (card && card.zoneId === DISCARD_ZONE) {
        next = moveCard(next, input.cardId, HAND_ZONE(input.targetId));
        trace(ctx, 'CARD_DRAW', `【奸雄】：${next.players[input.targetId]?.name ?? input.targetId} 获得 ${cardLabel(next, input.cardId)}`, 350);
      }
    }
    if (sourceProps && hasEquipment(next, input.sourceId, 'qilin') && isStrikeCard(damageCard)) {
      const horse = equipmentOfSlot(next, input.targetId, 'HORSE_PLUS') ?? equipmentOfSlot(next, input.targetId, 'HORSE_MINUS');
      if (horse) {
        next = discardWithXiaoji(next, ctx, input.targetId, [horse.id]);
        trace(ctx, 'CARD_DISCARD', `【麒麟弓】：弃置 ${next.players[input.targetId]?.name ?? input.targetId} 的坐骑`, 350);
      }
    }
    if (hasSkill(next, input.targetId, 'ganglie')) {
      const judged = drawJudgeCard(next, input.targetId);
      next = judged.state;
      if (judged.cardId) {
        trace(ctx, 'ANNOUNCEMENT', `【刚烈】判定：${judged.suit}${judged.rank}`, 400);
        next = settleJudgeCard(next, judged.cardId);
        if (!judged.red) {
          next = loseHp(next, ctx, input.sourceId, 1, '【刚烈】');
        }
      }
    }
  }

  const chained = Boolean(propsOf(next, input.targetId).chained);
  if (chained && (input.element === 'FIRE' || input.element === 'THUNDER')) {
    next = setProps(next, input.targetId, { chained: false });
    for (const other of alivePlayers(next)) {
      if (other === input.targetId || !propsOf(next, other).chained) continue;
      next = setProps(next, other, { chained: false });
      trace(ctx, 'DAMAGE_EFFECT', `【铁索连环】将${input.element === 'FIRE' ? '火焰' : '雷电'}伤害传导至 ${next.players[other]?.name ?? other}`, 400);
      next = doDamage(next, ctx, {
        sourceId: input.sourceId,
        targetId: other,
        amount,
        element: input.element,
        cardId: input.cardId,
        reason: '【铁索连环】传导'
      });
    }
  }

  if (Number(propsOf(next, input.targetId).hp) <= 0) {
    next = openDying(next, ctx, {
      victimId: input.targetId,
      sourceId: input.sourceId,
      killerId: input.sourceId,
      cardId: input.cardId,
      reason: input.reason
    });
  }
  return next;
}

function loseHp(state: GameState, ctx: ReduceContext, pid: PlayerId, amount: number, reason: string): GameState {
  let next = state;
  const before = Number(propsOf(next, pid).hp);
  const hp = Math.max(0, before - amount);
  next = setProps(next, pid, { hp });
  if (before > 0) ctx.reward(pid, 'hp', -Math.min(before, amount), reason);
  trace(ctx, 'DAMAGE_EFFECT', `${next.players[pid]?.name ?? pid} 失去 ${Math.min(before, amount)} 点体力（${hp}）`, 450);
  if (hp <= 0) {
    next = openDying(next, ctx, { victimId: pid, sourceId: null, killerId: null, reason });
  }
  return next;
}

function heal(state: GameState, ctx: ReduceContext, pid: PlayerId, amount: number, reason: string): GameState {
  const props = propsOf(state, pid);
  if (!state.players[pid]?.alive || props.hp >= props.maxHp) return state;
  const healed = Math.min(amount, props.maxHp - props.hp);
  const next = setProps(state, pid, { hp: props.hp + healed });
  ctx.reward(pid, 'hp', healed, reason);
  trace(ctx, 'ANNOUNCEMENT', `${next.players[pid]?.name ?? pid} 回复 ${healed} 点体力（${props.hp + healed}/${props.maxHp}）`, 450);
  return next;
}

function canRescue(state: GameState, pid: PlayerId, victimId: PlayerId): boolean {
  if (!state.players[pid]?.alive) return false;
  const hand = handOf(state, pid);
  if (hand.some(card => cardCode(card) === 'tao')) return true;
  if (pid === victimId && hand.some(card => cardCode(card) === 'jiu')) return true;
  if (hasSkill(state, pid, 'jijiu') && state.activePlayerId !== pid && hand.some(card => cardIsRed(card))) return true;
  return false;
}

function openDying(
  state: GameState,
  ctx: ReduceContext,
  input: {
    victimId: PlayerId;
    sourceId: PlayerId | null;
    killerId: PlayerId | null;
    cardId?: EntityId;
    reason: string;
  }
): GameState {
  let next = setProps(state, input.victimId, { dying: true });
  next = updateGlobal(next, { dying: input });
  const rescuers = alivePlayers(next).filter(pid => canRescue(next, pid, input.victimId));
  if (rescuers.length === 0) {
    return checkDeath(next, ctx);
  }
  const frame: StackFrame = {
    id: ctx.id('dying_frame'),
    type: 'DYING_RESCUE',
    title: `濒死：${next.players[input.victimId]?.name ?? input.victimId}`,
    description: `${next.players[input.victimId]?.name ?? input.victimId} 体力为0，其他角色可使用【桃】救援。`,
    sourcePlayerId: input.sourceId ?? input.victimId,
    targetPlayerId: input.victimId,
    actionPayload: { type: 'CHECK_DEATH', playerId: input.victimId },
    status: 'WAITING_INPUT'
  };
  frame.responseWindow = responseWindow(next, rescuers);
  return pushFrame(next, frame);
}

function checkDeath(state: GameState, ctx: ReduceContext): GameState {
  const dying = state.globalVars.dying as
    | { victimId?: PlayerId; sourceId?: PlayerId | null; killerId?: PlayerId | null; reason?: string }
    | undefined;
  const victimId = dying?.victimId;
  if (!victimId) return state;
  if (Number(propsOf(state, victimId).hp) > 0) {
    return clearGlobal(setProps(state, victimId, { dying: false }), ['dying']);
  }
  const victim = state.players[victimId];
  if (!victim?.alive) return clearGlobal(state, ['dying']);

  const killerId = dying?.killerId ?? null;
  // Capture "who was my next seat" before the victim leaves the alive ring; the
  // village rule means exactly that seat, not the next living seat afterwards.
  const nextOfKiller = killerId ? nextAlivePlayer(state, killerId) : null;
  let next = setProps(state, victimId, { dying: false, roleRevealed: true });
  next = {
    ...next,
    players: { ...next.players, [victimId]: { ...next.players[victimId], alive: false } }
  };
  const cards = allCardIds(next, victimId);
  next = discardCardIds(next, cards);
  next = syncEquipmentHooks(next);
  trace(ctx, 'ANNOUNCEMENT', `💀 ${victim.name} 阵亡，身份为 ${victim.role ?? '未知'}`, 700);

  if (killerId && next.players[killerId]?.alive) {
    if (victim.role === 'REBEL') {
      const drawn = drawCards(next, killerId, 3);
      next = drawn.state;
      if (drawn.drawn.length > 0) ctx.reward(killerId, 'cards', drawn.drawn.length, `击杀反贼 ${victim.name}`);
      trace(ctx, 'CARD_DRAW', `${next.players[killerId]?.name ?? killerId} 击杀反贼，摸三张牌`, 450);
    } else if (victim.role === 'LOYALIST' && next.players[killerId]?.role === 'LORD') {
      next = discardCardIds(next, allCardIds(next, killerId));
      next = syncEquipmentHooks(next);
      trace(ctx, 'CARD_DISCARD', `主公杀死忠臣，弃置所有牌`, 450);
    }
  }

  next = clearResponseContext(next);
  const result = checkSanguoshaWin(next, { victimId, killerId, nextOfKiller });
  if (result.gameOver) {
    const deltas = sanguoshaScoreDeltas(next, result.winner);
    for (const pid of next.playerOrder) {
      next = setProps(next, pid, { points: Number(propsOf(next, pid).points ?? 0) + (deltas[pid] ?? 0) });
    }
    next = updateGlobal(next, {
      finalWinner: result.winner,
      finalReason: result.reason ?? '胜负已分',
      scoreDeltas: deltas
    });
  }
  return next;
}

function pushDuel(state: GameState, ctx: ReduceContext, sourceId: PlayerId, targetId: PlayerId): GameState {
  let next = clearGlobal(state, ['pendingTrick', 'wuxieCount']);
  const context: SgsDuelContext = {
    sourceId,
    targetId,
    responder: targetId,
    opponent: sourceId,
    strikesNeeded: hasSkill(next, targetId, 'wushuang') ? 1 : hasSkill(next, sourceId, 'wushuang') ? 2 : 1,
    strikesPlayed: 0
  };
  next = updateGlobal(next, { duel: context });
  return pushDuelFrame(next, ctx, context);
}

function duelResponders(state: GameState, context: SgsDuelContext): PlayerId[] {
  const responders = [context.responder];
  if (hasSkill(state, context.responder, 'jijiang') && isLord(state, context.responder)) {
    for (const ally of alivePlayers(state)) {
      if (ally !== context.responder && propsOf(state, ally).kingdom === 'SHU' && handOf(state, ally).some(card => isStrikeCard(card))) {
        responders.push(ally);
      }
    }
  }
  return responders;
}

function pushDuelFrame(state: GameState, ctx: ReduceContext, context: SgsDuelContext): GameState {
  const frame: StackFrame = {
    id: ctx.id('duel_frame'),
    type: 'DUEL_RESOLUTION',
    title: `【决斗】：${state.players[context.responder]?.name ?? context.responder}`,
    description: `需连续打出 ${context.strikesNeeded} 张【杀】，否则受到 ${state.players[context.opponent]?.name ?? context.opponent} 造成的1点伤害。`,
    sourcePlayerId: context.opponent,
    targetPlayerId: context.responder,
    actionPayload: { type: 'DUEL_DAMAGE', playerId: context.responder },
    status: 'WAITING_INPUT'
  };
  frame.responseWindow = responseWindow(state, duelResponders(state, context));
  return pushFrame(updateGlobal(state, { duel: context }), frame);
}

function duelNeededFor(state: GameState, responder: PlayerId, opponent: PlayerId): number {
  if (hasSkill(state, responder, 'wushuang')) return 1;
  return hasSkill(state, opponent, 'wushuang') ? 2 : 1;
}

function resolveDuelStrike(state: GameState, ctx: ReduceContext, action: Action): GameState {
  const context = duelContext(state);
  if (!context) return state;
  const actor = action.playerId;
  if (!action.entityId || !handIdsOf(state, actor).includes(action.entityId)) return state;
  const next = discardFromHand(state, actor, action.entityId);
  const played = context.strikesPlayed + 1;
  trace(ctx, 'CARD_PLAY', `${state.players[actor]?.name ?? actor} 打出【杀】响应决斗`, 350);
  if (played < context.strikesNeeded) {
    return pushDuelFrame(next, ctx, { ...context, strikesPlayed: played });
  }
  const updated: SgsDuelContext = {
    ...context,
    responder: context.opponent,
    opponent: context.responder,
    strikesPlayed: 0,
    strikesNeeded: duelNeededFor(next, context.opponent, context.responder)
  };
  return pushDuelFrame(next, ctx, updated);
}

function openMassTrickFrame(state: GameState, ctx: ReduceContext): GameState {
  const source = massTrickContext(state);
  if (!source) return state;
  const context = { ...source, targetIds: [...source.targetIds] };
  while (context.targetIndex < context.targetIds.length && !state.players[context.targetIds[context.targetIndex]]?.alive) {
    context.targetIndex += 1;
  }
  if (context.targetIndex >= context.targetIds.length) {
    return clearResponseContext(state);
  }
  const target = context.targetIds[context.targetIndex];
  const eligible = [target];
  if (hasSkill(state, target, 'jijiang') && isLord(state, target)) {
    for (const ally of alivePlayers(state)) {
      if (ally !== target && propsOf(state, ally).kingdom === 'SHU' && handOf(state, ally).some(card => isStrikeCard(card))) eligible.push(ally);
    }
  }
  if (hasSkill(state, target, 'hujia') && isLord(state, target)) {
    for (const ally of alivePlayers(state)) {
      if (ally !== target && propsOf(state, ally).kingdom === 'WEI' && handOf(state, ally).some(card => cardCode(card) === 'shan')) eligible.push(ally);
    }
  }
  const frame: StackFrame = {
    id: ctx.id('mass_frame'),
    type: 'MASS_TRICK_RESOLUTION',
    title: context.kind === 'BARBARIAN' ? `【南蛮入侵】：${state.players[target]?.name ?? target}` : `【万箭齐发】：${state.players[target]?.name ?? target}`,
    description: context.kind === 'BARBARIAN' ? '需打出一张【杀】，否则受到1点伤害。' : '需打出一张【闪】，否则受到1点伤害。',
    sourcePlayerId: context.sourceId,
    targetPlayerId: target,
    actionPayload: { type: 'MASS_TRICK_NEXT', playerId: target },
    status: 'WAITING_INPUT'
  };
  frame.responseWindow = responseWindow(state, eligible);
  return pushFrame(updateGlobal(state, { massTrick: context }), frame);
}

function advanceMassTrick(state: GameState, ctx: ReduceContext): GameState {
  const source = massTrickContext(state);
  if (!source) return state;
  const context = { ...source, targetIds: [...source.targetIds] };
  let next = state;
  while (context.targetIndex < context.targetIds.length) {
    const target = context.targetIds[context.targetIndex];
    if (!next.players[target]?.alive) {
      context.targetIndex += 1;
      continue;
    }
    return openMassTrickFrame({ ...next, globalVars: { ...next.globalVars, massTrick: context } }, ctx);
  }
  next = clearResponseContext(next);
  trace(ctx, 'ANNOUNCEMENT', '群体锦囊结算完毕', 300);
  return next;
}

function pushTrickWindow(state: GameState, ctx: ReduceContext): GameState {
  const pending = state.globalVars.pendingTrick as { wuxieCount?: number; kind?: string } | undefined;
  if (!pending) return state;
  const responders = alivePlayers(state).filter(pid => handOf(state, pid).some(card => cardCode(card) === 'wuxie'));
  if (responders.length === 0) {
    return resolveTrickEffect(state, ctx);
  }
  const frame: StackFrame = {
    id: ctx.id('trick_frame'),
    type: 'TRICK_RESOLUTION',
    title: `锦囊结算：${pending.kind ?? '锦囊'}`,
    description: '任何角色可以使用【无懈可击】抵消此锦囊；无懈可击本身也可被再次无懈。',
    sourcePlayerId: String((state.globalVars.pendingTrick as { sourceId?: string })?.sourceId ?? state.activePlayerId),
    actionPayload: { type: 'RESOLVE_PENDING_TRICK', playerId: state.activePlayerId },
    status: 'WAITING_INPUT'
  };
  frame.responseWindow = responseWindow(state, responders);
  return pushFrame(state, frame);
}

function startTrick(
  state: GameState,
  ctx: ReduceContext,
  sourceId: PlayerId,
  cardId: EntityId,
  kind: SgsCardSubtype,
  targetIds: PlayerId[],
  victimId?: PlayerId
): GameState {
  let next = state;
  const delayed = kind === 'INDULGENCE' || kind === 'LIGHTNING' || kind === 'SUPPLY_SHORTAGE';
  next = moveCard(next, cardId, delayed ? PROCESSING_ZONE : DISCARD_ZONE);
  next = updateGlobal(next, {
    pendingTrick: {
      kind,
      cardId,
      sourceId,
      targetIds: [...targetIds],
      targetIndex: 0,
      ...(victimId ? { victimId } : {}),
      wuxieCount: 0
    },
    wuxieCount: 0
  });
  if (hasSkill(next, sourceId, 'jizhi') && !delayed) {
    next = drawCards(next, sourceId, 1).state;
    trace(ctx, 'CARD_DRAW', '【集智】摸一张牌', 300);
  }
  next = maybeLianying(next, sourceId, ctx);
  return pushTrickWindow(next, ctx);
}

function resolveTrickEffect(state: GameState, ctx: ReduceContext): GameState {
  const pending = state.globalVars.pendingTrick as
    | {
        kind?: SgsCardSubtype;
        cardId?: EntityId;
        sourceId?: PlayerId;
        targetIds?: PlayerId[];
        targetIndex?: number;
        victimId?: PlayerId;
        wuxieCount?: number;
        judgeMode?: boolean;
      }
    | undefined;
  if (!pending?.kind || !pending.cardId || !pending.sourceId) return state;
  const sourceId = pending.sourceId;
  const targets = (pending.targetIds ?? []).filter(pid => state.players[pid]?.alive);
  let next = state;

  if (pending.judgeMode) {
    const judgePid = targets[0] ?? sourceId;
    const judged = resolveDelayedJudgment(next, ctx, judgePid, pending.cardId);
    return clearGlobal(judged, ['pendingTrick', 'wuxieCount']);
  }

  if (pending.kind === 'INDULGENCE' || pending.kind === 'LIGHTNING' || pending.kind === 'SUPPLY_SHORTAGE') {
    const target = targets[0];
    if (!target) {
      next = moveCard(next, pending.cardId, DISCARD_ZONE);
      return clearGlobal(next, ['pendingTrick', 'wuxieCount']);
    }
    next = moveCard(next, pending.cardId, JUDGE_ZONE(target));
    trace(ctx, 'CARD_PLAY', `${state.players[target]?.name ?? target} 的判定区置入一张延时锦囊`, 350);
    return clearGlobal(next, ['pendingTrick', 'wuxieCount']);
  }

  switch (pending.kind) {
    case 'DISMANTLE':
    case 'SNATCH': {
      const target = targets[0];
      if (!target || allCardIds(next, target).length === 0) {
        return clearGlobal(next, ['pendingTrick', 'wuxieCount']);
      }
      return openDismantleChoice(next, ctx, {
        sourceId,
        targetId: target,
        snatch: pending.kind === 'SNATCH'
      });
    }
    case 'DUEL': {
      const target = targets[0];
      if (!target) return clearGlobal(next, ['pendingTrick', 'wuxieCount']);
      return pushDuel(next, ctx, sourceId, target);
    }
    case 'BORROW_SWORD': {
      const target = targets[0];
      if (!target) return clearGlobal(next, ['pendingTrick', 'wuxieCount']);
      const weapon = equipmentOfSlot(next, target, 'WEAPON');
      if (!weapon) return clearGlobal(next, ['pendingTrick', 'wuxieCount']);
      const frame: StackFrame = {
        id: ctx.id('borrow_frame'),
        type: 'BORROW_SWORD_RESOLUTION',
        title: `【借刀杀人】：${next.players[target]?.name ?? target}`,
        description: '需对指定角色使用一张【杀】，否则将武器交给借刀者。',
        sourcePlayerId: sourceId,
        targetPlayerId: target,
        actionPayload: { type: 'BORROW_SWORD_FAIL', playerId: target },
        status: 'WAITING_INPUT'
      };
      frame.responseWindow = responseWindow(next, [target]);
      return pushFrame(next, frame);
    }
    case 'EX_NIHILO': {
      const target = targets[0] ?? sourceId;
      next = drawCards(next, target, 2).state;
      trace(ctx, 'CARD_DRAW', `${state.players[target]?.name ?? target} 摸两张牌`, 350);
      return clearGlobal(next, ['pendingTrick', 'wuxieCount']);
    }
    case 'BARBARIAN':
    case 'ARROW': {
      const context: SgsMassTrickContext = {
        kind: pending.kind,
        cardId: pending.cardId,
        sourceId,
        targetIds: targets,
        targetIndex: 0
      };
      next = clearGlobal(updateGlobal(next, { massTrick: context }), ['pendingTrick', 'wuxieCount']);
      return advanceMassTrick(next, ctx);
    }
    case 'PEACH_GARDEN': {
      for (const target of targets) next = heal(next, ctx, target, 1, '【桃园结义】');
      return clearGlobal(next, ['pendingTrick', 'wuxieCount']);
    }
    case 'HARVEST': {
      const count = Math.max(1, targets.length);
      const revealed: EntityId[] = [];
      for (let i = 0; i < count; i += 1) {
        if ((next.zones[DECK_ZONE]?.orderedEntities.length ?? 0) === 0) {
          next = reshuffleDiscardIntoDeck(next);
          if ((next.zones[DECK_ZONE]?.orderedEntities.length ?? 0) === 0) break;
        }
        const top = next.zones[DECK_ZONE]?.orderedEntities[0];
        if (!top) break;
        next = moveCard(next, top, PROCESSING_ZONE);
        revealed.push(top);
      }
      const choice: SgsPendingChoice = {
        id: ctx.id('choice'),
        playerId: targets[0] ?? sourceId,
        kind: 'HARVEST_PICK',
        sourceId,
        targetId: targets[0] ?? sourceId,
        targetIds: targets,
        targetIndex: 0,
        revealedCardIds: revealed,
        options: []
      };
      next = clearGlobal(next, ['pendingTrick', 'wuxieCount']);
      return openHarvestChoice(next, ctx, choice);
    }
    case 'IRON_CHAIN': {
      for (const target of targets) {
        const props = propsOf(next, target);
        next = setProps(next, target, { chained: !props.chained });
      }
      trace(ctx, 'ANNOUNCEMENT', '【铁索连环】横置/重置目标角色', 350);
      return clearGlobal(next, ['pendingTrick', 'wuxieCount']);
    }
    case 'FIRE_ATTACK': {
      const target = targets[0];
      if (!target) return clearGlobal(next, ['pendingTrick', 'wuxieCount']);
      return openFireAttackChoice(next, ctx, sourceId, target);
    }
    default:
      return clearGlobal(next, ['pendingTrick', 'wuxieCount']);
  }
}

function resolveWuxieChain(state: GameState, ctx: ReduceContext): GameState {
  const pending = state.globalVars.pendingTrick as {
    wuxieCount?: number;
    cardId?: EntityId;
    judgeMode?: boolean;
  } | undefined;
  if (!pending) return state;
  if ((pending.wuxieCount ?? 0) % 2 === 1) {
    let next = state;
    if (pending.cardId && (next.entities[pending.cardId]?.zoneId === PROCESSING_ZONE || pending.judgeMode)) {
      next = moveCard(next, pending.cardId, DISCARD_ZONE);
    }
    trace(ctx, 'STACK_CANCEL', '【无懈可击】抵消了此锦囊', 450);
    return clearGlobal(next, ['pendingTrick', 'wuxieCount']);
  }
  return resolveTrickEffect(state, ctx);
}

function pushWuxieCounterIfNeeded(state: GameState, ctx: ReduceContext): GameState {
  const pending = state.globalVars.pendingTrick as { sourceId?: PlayerId } | undefined;
  const responders = alivePlayers(state).filter(pid =>
    handOf(state, pid).some(card => cardCode(card) === 'wuxie')
  );
  if (responders.length === 0) return resolveWuxieChain(state, ctx);
  const frame: StackFrame = {
    id: ctx.id('wuxie_frame'),
    type: 'WUXIE_RESOLUTION',
    title: '【无懈可击】响应',
    description: '可以再次使用【无懈可击】反制上一张无懈可击。',
    sourcePlayerId: pending?.sourceId ?? state.activePlayerId,
    actionPayload: { type: 'RESOLVE_PENDING_TRICK', playerId: state.activePlayerId },
    status: 'WAITING_INPUT'
  };
  frame.responseWindow = responseWindow(state, responders);
  return pushFrame(state, frame);
}

function useTrickCard(
  state: GameState,
  ctx: ReduceContext,
  sourceId: PlayerId,
  cardId: EntityId,
  kind: SgsCardSubtype,
  targetIds: PlayerId[],
  victimId?: PlayerId
): GameState {
  return startTrick(state, ctx, sourceId, cardId, kind, targetIds, victimId);
}

function handlePlayCard(state: GameState, ctx: ReduceContext, action: Action): GameState {
  const actor = action.playerId;
  const cardId = action.entityId;
  if (!cardId) return state;
  const card = state.entities[cardId];
  if (!card || card.zoneId !== HAND_ZONE(actor)) return state;
  const code = cardCode(card);
  const subtype = cardSubtype(card);
  const targetIds = [
    ...(action.targetPlayerId ? [action.targetPlayerId] : []),
    ...(Array.isArray(action.payload?.targetIds) ? action.payload.targetIds.map(String) : [])
  ].filter((pid, index, list) => list.indexOf(pid) === index);

  if (code === 'tiesuo' && action.payload?.recast === true) {
    let next = discardFromHand(state, actor, cardId);
    next = drawCards(next, actor, 1).state;
    trace(ctx, 'CARD_DISCARD', `${state.players[actor]?.name ?? actor} 重铸【铁索连环】并摸一张牌`, 350);
    return next;
  }

  if (code === 'tao') {
    const target = targetIds[0] ?? actor;
    if (!state.players[target]?.alive) return state;
    let next = discardFromHand(state, actor, cardId);
    next = heal(next, ctx, target, 1, '【桃】');
    if (hasSkill(next, target, 'jiuyuan') && isLord(next, target) && propsOf(next, actor).kingdom === 'WU' && actor !== target) {
      next = drawCards(next, actor, 1).state;
      trace(ctx, 'CARD_DRAW', '【救援】摸一张牌', 300);
    }
    return maybeLianying(next, actor, ctx);
  }

  if (code === 'jiu') {
    let next = discardFromHand(state, actor, cardId);
    next = setProps(next, actor, { wineBonus: 1, wineUsed: true });
    trace(ctx, 'CARD_PLAY', `${state.players[actor]?.name ?? actor} 使用【酒】，下一张【杀】伤害+1`, 350);
    return maybeLianying(next, actor, ctx);
  }

  if (isStrikeCard(card)) {
    const target = targetIds[0];
    if (!target) return state;
    let next = discardCardIds(state, [cardId]);
    return beginStrike(next, ctx, actor, target, [cardId], { consumeLimit: true });
  }

  switch (subtype) {
    case 'DISMANTLE':
    case 'SNATCH':
    case 'DUEL':
    case 'BORROW_SWORD':
    case 'EX_NIHILO':
    case 'BARBARIAN':
    case 'ARROW':
    case 'PEACH_GARDEN':
    case 'HARVEST':
    case 'IRON_CHAIN':
    case 'FIRE_ATTACK':
    case 'INDULGENCE':
    case 'LIGHTNING':
    case 'SUPPLY_SHORTAGE': {
      let resolvedTargets = targetIds;
      if (subtype === 'EX_NIHILO') resolvedTargets = [actor];
      if (subtype === 'PEACH_GARDEN' || subtype === 'HARVEST') resolvedTargets = alivePlayers(state);
      if (subtype === 'BARBARIAN' || subtype === 'ARROW') resolvedTargets = alivePlayers(state).filter(pid => pid !== actor);
      if (subtype === 'LIGHTNING' || subtype === 'INDULGENCE' || subtype === 'SUPPLY_SHORTAGE') resolvedTargets = [targetIds[0] ?? actor];
      return useTrickCard(state, ctx, actor, cardId, subtype, resolvedTargets, action.payload?.victimId as PlayerId | undefined);
    }
    default:
      return state;
  }
}

function handleUseSkill(state: GameState, ctx: ReduceContext, action: Action): GameState {
  const actor = action.playerId;
  const skill = String(action.payload?.skill ?? '');
  const cardId = action.entityId;
  const targetId = action.targetPlayerId;
  const prop = propsOf(state, actor);

  switch (skill) {
    case 'rende': {
      if (!cardId || !targetId || !handIdsOf(state, actor).includes(cardId)) return state;
      let next = moveCard(state, cardId, HAND_ZONE(targetId));
      const given = Number(prop.rendeGiven ?? 0) + 1;
      next = setProps(next, actor, { rendeGiven: given });
      if (given >= 2 && !prop.rendeHealed) {
        next = setProps(next, actor, { rendeHealed: true });
        next = heal(next, ctx, actor, 1, '【仁德】');
      }
      trace(ctx, 'CARD_PLAY', `${state.players[actor]?.name ?? actor} 发动【仁德】将一张牌交给 ${state.players[targetId]?.name ?? targetId}`, 350);
      return maybeLianying(next, actor, ctx);
    }
    case 'wusheng':
    case 'longdan': {
      if (!cardId || !targetId || !handIdsOf(state, actor).includes(cardId)) return state;
      const card = state.entities[cardId];
      if (skill === 'wusheng' && !cardIsRed(card)) return state;
      if (skill === 'longdan' && cardCode(card) !== 'shan') return state;
      if (!canUseStrike(state, actor)) return state;
      let next = discardCardIds(state, [cardId]);
      next = beginStrike(next, ctx, actor, targetId, [cardId], { consumeLimit: true });
      return maybeLianying(next, actor, ctx);
    }
    case 'qixi': {
      if (!cardId || !targetId) return state;
      const card = state.entities[cardId];
      if (!card || String(card.components.custom?.color) !== 'black') return state;
      return useTrickCard(state, ctx, actor, cardId, 'DISMANTLE', [targetId]);
    }
    case 'guose': {
      if (!cardId || !targetId) return state;
      const card = state.entities[cardId];
      if (!card || cardSuit(card) !== '♦') return state;
      return useTrickCard(state, ctx, actor, cardId, 'INDULGENCE', [targetId]);
    }
    case 'zhiheng': {
      if (!cardId || prop.zhihengUsed || !handIdsOf(state, actor).includes(cardId)) return state;
      let next = discardFromHand(state, actor, cardId);
      next = setProps(next, actor, { zhihengUsed: true });
      next = drawCards(next, actor, 1).state;
      trace(ctx, 'CARD_DRAW', `${state.players[actor]?.name ?? actor} 发动【制衡】`, 300);
      return maybeLianying(next, actor, ctx);
    }
    case 'kurou': {
      if (prop.kurouUsed) return state;
      let next = setProps(state, actor, { kurouUsed: true });
      next = loseHp(next, ctx, actor, 1, '【苦肉】');
      next = drawCards(next, actor, 2).state;
      trace(ctx, 'CARD_DRAW', `${state.players[actor]?.name ?? actor} 发动【苦肉】摸两张牌`, 350);
      return next;
    }
    case 'qingnang': {
      if (!cardId || !targetId || prop.qingnangUsed || !handIdsOf(state, actor).includes(cardId)) return state;
      let next = discardFromHand(state, actor, cardId);
      next = setProps(next, actor, { qingnangUsed: true });
      next = heal(next, ctx, targetId, 1, '【青囊】');
      return maybeLianying(next, actor, ctx);
    }
    case 'jieyin': {
      if (prop.jieyinUsed) return state;
      const ids: string[] = Array.isArray(action.payload?.cardIds) ? action.payload.cardIds.map(String) : [];
      if (ids.length !== 2 || !ids.every((id: string) => handIdsOf(state, actor).includes(id))) return state;
      if (!targetId) return state;
      let next = discardCardIds(state, ids);
      next = setProps(next, actor, { jieyinUsed: true });
      next = heal(next, ctx, actor, 1, '【结姻】');
      next = heal(next, ctx, targetId, 1, '【结姻】');
      return maybeLianying(next, actor, ctx);
    }
    case 'lijian': {
      if (!cardId || prop.lijianUsed) return state;
      const ids = Array.isArray(action.payload?.targetIds) ? action.payload.targetIds.map(String) : [];
      if (ids.length !== 2) return state;
      if (!handIdsOf(state, actor).includes(cardId)) return state;
      let next = discardFromHand(state, actor, cardId);
      next = setProps(next, actor, { lijianUsed: true });
      trace(ctx, 'CARD_PLAY', `${state.players[actor]?.name ?? actor} 发动【离间】`, 350);
      next = pushDuel(next, ctx, ids[0], ids[1]);
      return next;
    }
    default:
      return state;
  }
}

function handleEquip(state: GameState, ctx: ReduceContext, action: Action): GameState {
  const actor = action.playerId;
  const cardId = action.entityId;
  if (!cardId || !handIdsOf(state, actor).includes(cardId)) return state;
  const card = state.entities[cardId];
  const slot = String(card?.components.custom?.equipSlot ?? '');
  if (!slot) return state;
  const previous = equipmentOfSlot(state, actor, slot);
  let next = state;
  if (previous) {
    next = discardWithXiaoji(next, ctx, actor, [previous.id]);
  }
  next = equipCard(next, actor, cardId);
  trace(ctx, 'CARD_PLAY', `${state.players[actor]?.name ?? actor} 装备 ${cardLabel(next, cardId)}`, 350);
  return maybeLianying(next, actor, ctx);
}

function handleDiscard(state: GameState, ctx: ReduceContext, action: Action): GameState {
  const actor = action.playerId;
  const cardId = action.entityId;
  if (state.phase !== 'DISCARD' || state.activePlayerId !== actor) return state;
  if (handIdsOf(state, actor).length <= Number(propsOf(state, actor).hp)) return state;
  if (!cardId || !handIdsOf(state, actor).includes(cardId)) return state;
  let next = discardFromHand(state, actor, cardId);
  trace(ctx, 'CARD_DISCARD', `${state.players[actor]?.name ?? actor} 弃置 ${cardLabel(next, cardId)}`, 300);
  next = maybeLianying(next, actor, ctx);
  return next;
}

function handleDyingPeach(state: GameState, ctx: ReduceContext, action: Action): GameState {
  const actor = action.playerId;
  const cardId = action.entityId;
  if (!cardId || !handIdsOf(state, actor).includes(cardId)) return state;
  const card = state.entities[cardId];
  const isWine = cardCode(card) === 'jiu';
  const isJijiu = action.payload?.skill === 'jijiu';
  const target = action.targetPlayerId ?? actor;
  let next = discardFromHand(state, actor, cardId);
  next = heal(next, ctx, target, 1, isWine ? '【酒】' : isJijiu ? '【急救】' : '【桃】');
  if (Number(propsOf(next, target).hp) > 0) {
    next = clearGlobal(setProps(next, target, { dying: false }), ['dying']);
  }
  return next;
}

function handlePlayPeach(state: GameState, ctx: ReduceContext, action: Action): GameState {
  if (state.globalVars.dying) return handleDyingPeach(state, ctx, action);
  const actor = action.playerId;
  const cardId = action.entityId;
  if (!cardId || !handIdsOf(state, actor).includes(cardId)) return state;
  const target = action.targetPlayerId ?? actor;
  let next = discardFromHand(state, actor, cardId);
  next = heal(next, ctx, target, 1, '【桃】');
  if (hasSkill(next, target, 'jiuyuan') && isLord(next, target) && propsOf(next, actor).kingdom === 'WU' && actor !== target) {
    next = drawCards(next, actor, 1).state;
    trace(ctx, 'CARD_DRAW', '【救援】摸一张牌', 300);
  }
  return next;
}

function handleWuxie(state: GameState, ctx: ReduceContext, action: Action): GameState {
  const actor = action.playerId;
  const cardId = action.entityId;
  if (!cardId || !handIdsOf(state, actor).includes(cardId)) return state;
  let next = discardFromHand(state, actor, cardId);
  const pending = next.globalVars.pendingTrick as { wuxieCount?: number } | undefined;
  if (!pending) return next;
  const count = Number(pending.wuxieCount ?? 0) + 1;
  next = updateGlobal(next, {
    pendingTrick: { ...pending, wuxieCount: count },
    wuxieCount: count
  });
  trace(ctx, 'CARD_PLAY', `${state.players[actor]?.name ?? actor} 打出【无懈可击】`, 400);
  return pushWuxieCounterIfNeeded(next, ctx);
}

function handleMassResponse(state: GameState, ctx: ReduceContext): GameState {
  const context = massTrickContext(state);
  if (!context) return state;
  const next = { ...context, targetIndex: context.targetIndex + 1 };
  return advanceMassTrick(updateGlobal(state, { massTrick: next }), ctx);
}

function handleBorrowedStrike(state: GameState, ctx: ReduceContext, action: Action): GameState {
  const actor = action.playerId;
  const cardId = action.entityId;
  const victim = action.targetPlayerId;
  if (!cardId || !victim || !handIdsOf(state, actor).includes(cardId)) return state;
  let next = moveCard(state, cardId, DISCARD_ZONE);
  next = clearGlobal(next, ['pendingTrick', 'wuxieCount']);
  trace(ctx, 'CARD_PLAY', `${state.players[actor]?.name ?? actor} 响应【借刀杀人】出【杀】`, 350);
  return beginStrike(next, ctx, actor, victim, [cardId], { consumeLimit: false });
}

function handleStrikeAction(state: GameState, ctx: ReduceContext, action: Action): GameState {
  if (state.globalVars.duel && action.payload?.context === 'DUEL') {
    return resolveDuelStrike(state, ctx, action);
  }
  if (state.globalVars.massTrick && action.payload?.context === 'MASS') {
    const actor = action.playerId;
    if (!action.entityId || !handIdsOf(state, actor).includes(action.entityId)) return state;
    const next = discardFromHand(state, actor, action.entityId);
    return handleMassResponse(next, ctx);
  }
  if (action.payload?.context === 'BORROWED') {
    return handleBorrowedStrike(state, ctx, action);
  }
  const actor = action.playerId;
  const target = action.targetPlayerId;
  if (!target || !action.entityId || !handIdsOf(state, actor).includes(action.entityId)) return state;
  const card = state.entities[action.entityId];
  const extraIds: string[] = Array.isArray(action.payload?.cardIds)
    ? action.payload.cardIds.map(String).filter((id: string) => handIdsOf(state, actor).includes(id))
    : [];
  const cardIds = [...new Set([action.entityId, ...extraIds])];
  if (cardIds.length === 2 && hasEquipment(state, actor, 'zhangba')) {
    // two arbitrary hand cards are treated as one virtual Strike
  } else if (!isStrikeCard(card)) {
    return state;
  }
  if (!canUseStrike(state, actor)) return state;
  const element = action.payload?.zhuque === true && cardCode(card) === 'sha' ? 'FIRE' : undefined;
  const extraTargets = Array.isArray(action.payload?.extraTargetIds)
    ? action.payload.extraTargetIds.map(String)
    : [];
  if (extraTargets.length > 0) {
    const firstTargets = [target, ...extraTargets];
    const targets = [...new Set(firstTargets)];
    if (
      cardIds.length !== 1 ||
      handIdsOf(state, actor).length !== 1 ||
      !hasEquipment(state, actor, 'fangtian') ||
      targets.length < 2 ||
      targets.some(pid => pid === actor || !state.players[pid]?.alive || !inAttackRange(state, actor, pid))
    ) {
      return state;
    }
    const bonus = Number(propsOf(state, actor).wineBonus ?? 0);
    let next = discardCardIds(state, [action.entityId]);
    next = updateGlobal(next, {
      strikeQueue: {
        sourceId: actor,
        cardId: action.entityId,
        cardIds: [action.entityId],
        element: element ?? cardElement(card),
        targets,
        index: 1,
        bonus
      } satisfies SgsStrikeQueue
    });
    next = beginStrike(next, ctx, actor, targets[0], [action.entityId], {
      consumeLimit: true,
      ...(element ? { element } : {})
    });
    return maybeLianying(next, actor, ctx);
  }
  let next = discardCardIds(state, cardIds);
  next = beginStrike(next, ctx, actor, target, cardIds, { consumeLimit: true, ...(element ? { element } : {}) });
  return maybeLianying(next, actor, ctx);
}

function handleDodgeAction(state: GameState, ctx: ReduceContext, action: Action): GameState {
  const actor = action.playerId;
  const cardId = action.entityId;
  if (!cardId || !handIdsOf(state, actor).includes(cardId)) return state;
  const played = state.entities[cardId];
  const skill = action.payload?.skill;
  if (skill === 'qingguo' && String(played?.components.custom?.color) !== 'black') return state;
  if (skill === 'longdan' && cardCode(played) !== 'sha') return state;
  if (!skill && cardCode(played) !== 'shan') return state;
  let next = discardFromHand(state, actor, cardId);
  if (state.globalVars.massTrick) {
    trace(ctx, 'CARD_PLAY', `${state.players[actor]?.name ?? actor} 打出【闪】响应群体锦囊`, 300);
    return handleMassResponse(next, ctx);
  }
  const context = strikeContext(state);
  if (!context) return next;
  trace(ctx, 'CARD_PLAY', `${state.players[actor]?.name ?? actor} 打出【闪】`, 300);
  return dodgeSucceeded(next, ctx, context);
}

function handleBagua(state: GameState, ctx: ReduceContext, action: Action): GameState {
  const pid = action.playerId;
  const judged = drawJudgeCard(state, pid);
  let next = judged.state;
  if (!judged.cardId) return next;
  const redIsDodge = action.payload?.redIsDodge !== false;
  const success = redIsDodge ? judged.red : !judged.red;
  const damageOnFail = Math.max(0, Number(action.payload?.damageOnFail ?? 1));
  next = updateGlobal(next, {
    lastJudge: { playerId: pid, cardId: judged.cardId, suit: judged.suit, rank: judged.rank, red: judged.red, source: 'bagua' }
  });
  trace(
    ctx,
    'ANNOUNCEMENT',
    `【八卦阵】判定：${judged.suit}${judged.rank} ${success ? '红色，视为闪' : '黑色，判定失败'}`,
    500
  );
  next = settleJudgeCard(next, judged.cardId);
  const context = strikeContext(next);
  if (!context) {
    if (!success && damageOnFail > 0) {
      next = doDamage(next, ctx, { sourceId: null, targetId: pid, amount: damageOnFail, element: 'NORMAL', reason: '【八卦阵】判定失败' });
    }
    return next;
  }
  if (success) {
    return dodgeSucceeded(next, ctx, context);
  }
  return ensureStrikeWindow(updateGlobal(next, { strike: { ...context, baguaUsed: true } }), ctx, { ...context, baguaUsed: true });
}

function startTurn(state: GameState, ctx: ReduceContext): GameState {
  const pid = state.activePlayerId;
  let next = resetTurnFlags(state, pid);
  next = setProps(next, pid, { skipPlay: false, skipDraw: false });
  next = updateGlobal(next, { turnOwner: pid });
  const name = state.players[pid]?.name ?? pid;
  trace(ctx, 'ANNOUNCEMENT', `${name} 的回合开始`, 350);

  // 宪章 C-2：洛神可能连抽多张判定牌。旧实现在一次 reduce 里循环最多 12 次，
  // 每次都是一次逻辑跃迁。现在只记下剩余次数，由 LUOSHEN_STEP 经 follow-up
  // 逐步派发，每次只亮一张；上限仍是 12 张，规则不变。
  if (hasSkill(next, pid, 'luoshen')) {
    next = updateGlobal(next, { luoshenLeft: LUOSHEN_MAX_REVEALS });
  }

  return { ...next, phase: 'JUDGE' };
}

/** 与旧循环的 `guard < 12` 一致：一次准备阶段最多亮 12 张。 */
const LUOSHEN_MAX_REVEALS = 12;

/** 洛神的一步：亮一张判定牌。黑色收入手牌并继续，红色、牌堆耗尽或满 12 张则结束。 */
function luoshenStep(state: GameState, ctx: ReduceContext): GameState {
  const pid = state.activePlayerId;
  const left = Number(state.globalVars.luoshenLeft ?? 0);
  const judged = drawJudgeCard(state, pid);
  let next = judged.state;
  if (!judged.cardId) return clearGlobal(next, ['luoshenLeft']);
  trace(ctx, 'ANNOUNCEMENT', `【洛神】亮出 ${judged.suit}${judged.rank}`, 300);
  if (judged.red) {
    next = settleJudgeCard(next, judged.cardId);
    return clearGlobal(next, ['luoshenLeft']);
  }
  next = moveCard(next, judged.cardId, HAND_ZONE(pid));
  return left - 1 > 0 ? updateGlobal(next, { luoshenLeft: left - 1 }) : clearGlobal(next, ['luoshenLeft']);
}

function resolveDelayedJudgment(state: GameState, ctx: ReduceContext, pid: PlayerId, cardId: EntityId): GameState {
  let next = state;
  const card = next.entities[cardId];
  if (!card || card.zoneId !== JUDGE_ZONE(pid)) return { ...next, phase: 'JUDGE' };
  const subtype = cardSubtype(card);
  if (subtype !== 'INDULGENCE' && subtype !== 'LIGHTNING' && subtype !== 'SUPPLY_SHORTAGE') {
    return { ...next, phase: 'JUDGE' };
  }
  const judged = drawJudgeCard(next, pid);
  next = judged.state;
  if (!judged.cardId) return { ...next, phase: 'JUDGE' };
  next = updateGlobal(next, {
    lastJudge: { playerId: pid, cardId: judged.cardId, suit: judged.suit, rank: judged.rank, red: judged.red, source: subtype }
  });
  trace(ctx, 'ANNOUNCEMENT', `判定 ${cardLabel(next, cardId)}：${judged.suit}${judged.rank}`, 400);

  if (subtype === 'INDULGENCE') {
    if (!judged.red || judged.suit !== '♥') {
      next = setProps(next, pid, { skipPlay: true });
      trace(ctx, 'ANNOUNCEMENT', `【乐不思蜀】生效：跳过出牌阶段`, 400);
    }
    next = moveCard(next, cardId, DISCARD_ZONE);
  } else if (subtype === 'SUPPLY_SHORTAGE') {
    if (judged.suit !== '♣') {
      next = setProps(next, pid, { skipDraw: true });
      trace(ctx, 'ANNOUNCEMENT', `【兵粮寸断】生效：跳过摸牌阶段`, 400);
    }
    next = moveCard(next, cardId, DISCARD_ZONE);
  } else {
    const hit = judged.suit === '♠' && judged.rank >= 2 && judged.rank <= 9;
    if (hit) {
      next = moveCard(next, cardId, DISCARD_ZONE);
      trace(ctx, 'DAMAGE_EFFECT', `【闪电】命中：3点雷电伤害`, 450);
      next = doDamage(next, ctx, { sourceId: null, targetId: pid, amount: 3, element: 'THUNDER', cardId: judged.cardId, reason: '【闪电】' });
    } else {
      const nextPid = nextAlivePlayer(next, pid);
      next = nextPid ? moveCard(next, cardId, JUDGE_ZONE(nextPid)) : moveCard(next, cardId, DISCARD_ZONE);
      trace(ctx, 'ANNOUNCEMENT', `【闪电】未命中：移至下家判定区`, 350);
    }
  }
  next = settleJudgeCard(next, judged.cardId);
  return { ...next, phase: 'JUDGE' };
}

function resolveJudgePhase(state: GameState, ctx: ReduceContext): GameState {
  const pid = state.activePlayerId;
  const cardId = (state.zones[JUDGE_ZONE(pid)]?.orderedEntities ?? []).find(id => {
    const subtype = cardSubtype(state.entities[id]);
    return subtype === 'INDULGENCE' || subtype === 'LIGHTNING' || subtype === 'SUPPLY_SHORTAGE';
  });
  if (!cardId) return { ...state, phase: 'DRAW' };
  const responders = alivePlayers(state).filter(playerId =>
    handOf(state, playerId).some(card => cardCode(card) === 'wuxie')
  );
  if (responders.length === 0) {
    return resolveDelayedJudgment(state, ctx, pid, cardId);
  }
  const pending: SgsPendingTrick = {
    kind: cardSubtype(state.entities[cardId]) as SgsCardSubtype,
    cardId,
    sourceId: pid,
    targetIds: [pid],
    targetIndex: 0,
    judgeMode: true,
    wuxieCount: 0
  };
  const frame: StackFrame = {
    id: ctx.id('judge_frame'),
    type: 'JUDGE_TRICK_RESOLUTION',
    title: `判定区锦囊：${cardLabel(state, cardId)}`,
    description: '任何角色可在判定生效前使用【无懈可击】抵消此延时锦囊。',
    sourcePlayerId: pid,
    targetPlayerId: pid,
    actionPayload: { type: 'RESOLVE_PENDING_TRICK', playerId: pid },
    status: 'WAITING_INPUT'
  };
  frame.responseWindow = responseWindow(state, responders);
  return pushFrame(updateGlobal(state, { pendingTrick: pending, wuxieCount: 0 }), frame);
}

function drawPhase(state: GameState, ctx: ReduceContext): GameState {
  const pid = state.activePlayerId;
  const props = propsOf(state, pid);
  let next = state;
  if (props.skipDraw) {
    next = setProps(next, pid, { skipDraw: false });
    trace(ctx, 'ANNOUNCEMENT', `${state.players[pid]?.name ?? pid} 跳过摸牌阶段`, 350);
  } else {
    const count = 2 + (hasSkill(next, pid, 'yingzi') ? 1 : 0);
    const drawn = drawCards(next, pid, count);
    next = drawn.state;
    trace(ctx, 'CARD_DRAW', `${state.players[pid]?.name ?? pid} 摸 ${drawn.drawn.length} 张牌`, 350);
  }
  if (propsOf(next, pid).skipPlay) {
    trace(ctx, 'ANNOUNCEMENT', `${state.players[pid]?.name ?? pid} 跳过出牌阶段`, 350);
    return { ...next, phase: 'DISCARD' };
  }
  return { ...next, phase: 'PLAY' };
}

function endTurn(state: GameState, ctx: ReduceContext): GameState {
  const pid = state.activePlayerId;
  trace(ctx, 'ANNOUNCEMENT', `${state.players[pid]?.name ?? pid} 结束出牌阶段`, 300);
  return { ...state, phase: 'DISCARD' };
}

function finishDiscard(state: GameState, ctx: ReduceContext): GameState {
  const pid = state.activePlayerId;
  let next = { ...state, phase: 'END' };
  trace(ctx, 'ANNOUNCEMENT', `${state.players[pid]?.name ?? pid} 进入结束阶段`, 300);
  if (hasSkill(next, pid, 'biyue')) {
    next = drawCards(next, pid, 1).state;
    trace(ctx, 'CARD_DRAW', '【闭月】摸一张牌', 300);
  }
  return next;
}

function finishTurn(state: GameState, ctx: ReduceContext): GameState {
  const current = state.activePlayerId;
  const nextPid = nextAlivePlayer(state, current);
  if (!nextPid) {
    return updateGlobal(state, { finalWinner: null, finalReason: '场上已无存活角色' });
  }
  const currentIndex = state.playerOrder.indexOf(current);
  const nextIndex = state.playerOrder.indexOf(nextPid);
  return {
    ...state,
    activePlayerId: nextPid,
    phase: 'TURN_START',
    turn: state.turn + 1,
    round: state.round + (nextIndex <= currentIndex ? 1 : 0),
    globalVars: { ...state.globalVars, hasPlayedStrikeThisTurn: false }
  };
}

function handleAutoAction(state: GameState, ctx: ReduceContext, action: Action): GameState {
  switch (action.type) {
    case 'START_TURN':
      return startTurn(state, ctx);
    case 'LUOSHEN_STEP':
      return luoshenStep(state, ctx);
    case 'RESOLVE_JUDGE':
      return resolveJudgePhase(state, ctx);
    case 'DRAW_PHASE':
      return drawPhase(state, ctx);
    case 'FINISH_DISCARD':
      return finishDiscard(state, ctx);
    case 'FINISH_TURN':
      return finishTurn(state, ctx);
    case 'RESOLVE_PENDING_TRICK':
      return resolveWuxieChain(state, ctx);
    case 'EXECUTE_DAMAGE': {
      const payload = action.payload ?? {};
      return doDamage(clearResponseContext(state), ctx, {
        sourceId: (payload.sourceId as PlayerId | undefined) ?? null,
        targetId: String(payload.targetId ?? action.playerId),
        amount: Number(payload.amount ?? 1),
        element: (payload.element as 'NORMAL' | 'FIRE' | 'THUNDER' | undefined) ?? 'NORMAL',
        cardId: payload.cardId as EntityId | undefined,
        reason: String(payload.reason ?? '伤害'),
        ignoreArmor: payload.ignoreArmor === true
      });
    }
    case 'CHECK_DEATH':
      return checkDeath(state, ctx);
    case 'DUEL_DAMAGE': {
      const context = duelContext(state);
      if (!context) return state;
      const next = clearResponseContext(state);
      trace(ctx, 'DAMAGE_EFFECT', `${state.players[context.responder]?.name ?? context.responder} 未打出足够的【杀】`, 350);
      return doDamage(next, ctx, {
        sourceId: context.opponent,
        targetId: context.responder,
        amount: 1,
        element: 'NORMAL',
        reason: '【决斗】',
      });
    }
    case 'CONTINUE_STRIKE_QUEUE':
      return continueStrikeQueue(state, ctx);
    case 'BORROW_SWORD_FAIL': {
      const pending = state.globalVars.pendingTrick as
        | { sourceId?: PlayerId; targetIds?: PlayerId[]; cardId?: EntityId }
        | undefined;
      const target = pending?.targetIds?.[0];
      const sourceId = pending?.sourceId;
      if (!target || !sourceId) return clearGlobal(state, ['pendingTrick', 'wuxieCount']);
      const weapon = equipmentOfSlot(state, target, 'WEAPON');
      let next = state;
      if (weapon) {
        next = moveCard(next, weapon.id, HAND_ZONE(sourceId));
        next = syncEquipmentHooks(next);
        if (hasSkill(next, target, 'xiaoji')) {
          next = drawCards(next, target, 2).state;
          trace(ctx, 'CARD_DRAW', '【枭姬】失去武器后摸两张牌', 350);
        }
        trace(ctx, 'CARD_PLAY', `${state.players[sourceId]?.name ?? sourceId} 获得 ${state.players[target]?.name ?? target} 的武器`, 400);
      }
      return clearGlobal(next, ['pendingTrick', 'wuxieCount']);
    }
    case 'MASS_TRICK_NEXT': {
      const context = massTrickContext(state);
      if (!context) return state;
      const target = context.targetIds[context.targetIndex];
      let next = state;
      if (target && next.players[target]?.alive) {
        const armor = equipmentOfSlot(next, target, 'ARMOR');
        const armorCode = cardCode(armor);
        if (armorCode !== 'tengjia') {
          next = doDamage(next, ctx, {
            sourceId: context.sourceId,
            targetId: target,
            amount: 1,
            element: 'NORMAL',
            cardId: context.cardId,
            reason: context.kind === 'BARBARIAN' ? '【南蛮入侵】' : '【万箭齐发】'
          });
        } else {
          trace(ctx, 'STACK_CANCEL', `【藤甲】令群体锦囊对 ${next.players[target]?.name ?? target} 无效`, 350);
        }
      }
      return advanceMassTrick(updateGlobal(next, { massTrick: { ...context, targetIndex: context.targetIndex + 1 } }), ctx);
    }
    case 'DRAW_CARDS':
      return drawCards(state, action.playerId, 2).state;
    default:
      return state;
  }
}

export function resolveSanguoshaDecision(state: GameState, window: DecisionWindow, ctx: ReduceContext): GameState {
  if (window.payload?.kind !== 'sgs_choice') return state;
  const choice = state.globalVars.pendingChoice as SgsPendingChoice | undefined;
  if (!choice || choice.id !== String(window.payload.choiceId)) return state;
  const fallback = choice.options[0];
  if (!fallback) return clearPendingChoice(state);
  return resolveChoice(state, ctx, {
    type: 'RESOLVE_CHOICE',
    playerId: choice.playerId,
    ...(fallback.cardId ? { entityId: fallback.cardId } : {}),
    payload: { choiceId: choice.id, optionId: fallback.id, choiceLabel: fallback.label }
  });
}

export function applySanguoshaAction(state: GameState, action: Action, ctx: ReduceContext): GameState {
  switch (action.type) {
    case 'PLAY_STRIKE':
      return handleStrikeAction(state, ctx, action);
    case 'PLAY_DODGE':
      return handleDodgeAction(state, ctx, action);
    case 'PLAY_PEACH':
      return handlePlayPeach(state, ctx, action);
    case 'PLAY_WUXIE':
      return handleWuxie(state, ctx, action);
    case 'PLAY_CARD':
      return handlePlayCard(state, ctx, action);
    case 'EQUIP_CARD':
      return handleEquip(state, ctx, action);
    case 'USE_SKILL':
      return handleUseSkill(state, ctx, action);
    case 'DISCARD_CARD':
      return handleDiscard(state, ctx, action);
    case 'RESOLVE_CHOICE':
      return resolveChoice(state, ctx, action);
    case 'JUDGE_BAGUA':
      return handleBagua(state, ctx, action);
    case 'END_TURN':
      return endTurn(state, ctx);
    case 'PASS':
      return state;
    default:
      return handleAutoAction(state, ctx, action);
  }
}

export function resolveSanguoshaFollowUp(state: GameState, _ctx: ReduceContext): Action[] {
  if (state.gameOver) return [];
  if (state.globalVars.pendingChoice) return [];
  const top = InterruptStackManager.peek(state);
  if (top && top.status === 'WAITING_INPUT' && top.responseWindow) return [];
  if (state.pendingDecisions.some(window => window.status === 'OPEN')) return [];
  if (state.globalVars.strikeQueue) {
    return [{ type: 'CONTINUE_STRIKE_QUEUE', playerId: state.activePlayerId }];
  }
  switch (state.phase) {
    case 'TURN_START':
      return [{ type: 'START_TURN', playerId: state.activePlayerId }];
    case 'JUDGE':
      // 洛神未判定完之前，判定阶段的延时锦囊先等着。
      return Number(state.globalVars.luoshenLeft ?? 0) > 0
        ? [{ type: 'LUOSHEN_STEP', playerId: state.activePlayerId }]
        : [{ type: 'RESOLVE_JUDGE', playerId: state.activePlayerId }];
    case 'DRAW':
      return [{ type: 'DRAW_PHASE', playerId: state.activePlayerId }];
    case 'DISCARD':
      return currentHandCount(state, state.activePlayerId) <= Number(propsOf(state, state.activePlayerId).hp)
        ? [{ type: 'FINISH_DISCARD', playerId: state.activePlayerId }]
        : [];
    case 'END':
      return [{ type: 'FINISH_TURN', playerId: state.activePlayerId }];
    default:
      return [];
  }
}
