import { DeterministicPRNG } from '@rds/kernel/prng';
import { Action, Entity, EntityId, GameState, PlayerId, ZoneId } from '@rds/kernel/types';
import { CARD_LIBRARY, cardCustom, cardTitle, isStrikeCode, isStrikeSubtype, rankText, suitColor, suitIsRed } from './cards';
import { SgsDuelContext, SgsMassTrickContext, SgsPlayerProps, SgsStrikeContext } from './types';

export const DECK_ZONE = 'zone_deck';
export const DISCARD_ZONE = 'zone_discard';
export const HAND_ZONE = (pid: PlayerId): ZoneId => `zone_hand_${pid}`;
export const EQUIP_ZONE = (pid: PlayerId): ZoneId => `zone_equip_${pid}`;
export const JUDGE_ZONE = (pid: PlayerId): ZoneId => `zone_judge_${pid}`;

export function propsOf(state: GameState, pid: PlayerId): SgsPlayerProps {
  return (state.players[pid]?.customProps ?? {}) as SgsPlayerProps;
}

export function setProps(state: GameState, pid: PlayerId, patch: Partial<SgsPlayerProps>): GameState {
  const player = state.players[pid];
  if (!player) return state;
  const props = { ...(player.customProps as SgsPlayerProps), ...patch };
  const hp = Math.max(0, Math.min(Number(props.maxHp ?? 1), Number(props.hp ?? 0)));
  props.hp = hp;
  return {
    ...state,
    players: {
      ...state.players,
      [pid]: { ...player, customProps: props, score: hp }
    }
  };
}

export function alivePlayers(state: GameState): PlayerId[] {
  return state.playerOrder.filter(pid => state.players[pid]?.alive);
}

export function handOf(state: GameState, pid: PlayerId): Entity[] {
  return entitiesInZone(state, HAND_ZONE(pid));
}

export function handIdsOf(state: GameState, pid: PlayerId): EntityId[] {
  return state.zones[HAND_ZONE(pid)]?.orderedEntities ?? [];
}

export function equipOf(state: GameState, pid: PlayerId): Entity[] {
  return entitiesInZone(state, EQUIP_ZONE(pid));
}

export function judgeOf(state: GameState, pid: PlayerId): Entity[] {
  return entitiesInZone(state, JUDGE_ZONE(pid));
}

export function entitiesInZone(state: GameState, zoneId: ZoneId): Entity[] {
  const zone = state.zones[zoneId];
  if (!zone) return [];
  return zone.orderedEntities.map(id => state.entities[id]).filter((entity): entity is Entity => !!entity);
}

export function cardCode(entity?: Entity | null): string {
  return String(entity?.components.custom?.code ?? '');
}

export function cardSubtype(entity?: Entity | null): string {
  return String(entity?.components.custom?.subtype ?? '');
}

export function cardSuit(entity?: Entity | null): string {
  return String(entity?.components.custom?.suit ?? '');
}

export function cardRank(entity?: Entity | null): number {
  return Number(entity?.components.custom?.rank ?? 0);
}

export function cardElement(entity?: Entity | null): 'NORMAL' | 'FIRE' | 'THUNDER' {
  const element = String(entity?.components.custom?.element ?? 'NORMAL');
  return element === 'FIRE' || element === 'THUNDER' ? element : 'NORMAL';
}

export function cardIsRed(entity?: Entity | null): boolean {
  return suitIsRed(cardSuit(entity));
}

export function isStrikeCard(entity?: Entity | null): boolean {
  return isStrikeSubtype(cardSubtype(entity)) || isStrikeCode(cardCode(entity));
}

export function hasSkill(state: GameState, pid: PlayerId, skillId: string): boolean {
  return (propsOf(state, pid).skills ?? []).includes(skillId);
}

export function isLord(state: GameState, pid: PlayerId): boolean {
  return state.players[pid]?.role === 'LORD';
}

export function hasEquipment(state: GameState, pid: PlayerId, code: string): boolean {
  return equipOf(state, pid).some(card => cardCode(card) === code);
}

export function equipmentOfSlot(state: GameState, pid: PlayerId, slot: string): Entity | undefined {
  return equipOf(state, pid).find(card => String(card.components.custom?.equipSlot ?? '') === slot);
}

export function weaponOf(state: GameState, pid: PlayerId): Entity | undefined {
  return equipmentOfSlot(state, pid, 'WEAPON');
}

export function armorOf(state: GameState, pid: PlayerId): Entity | undefined {
  return equipmentOfSlot(state, pid, 'ARMOR');
}

export function attackRangeOf(state: GameState, pid: PlayerId): number {
  const weapon = weaponOf(state, pid);
  return Math.max(1, Number(weapon?.components.custom?.range ?? 1));
}

export function seatDistance(state: GameState, from: PlayerId, to: PlayerId): number {
  const alive = alivePlayers(state);
  const a = alive.indexOf(from);
  const b = alive.indexOf(to);
  if (a < 0 || b < 0 || a === b) return 0;
  const direct = Math.abs(a - b);
  return Math.min(direct, alive.length - direct);
}

export function distanceBetween(state: GameState, from: PlayerId, to: PlayerId): number {
  let distance = seatDistance(state, from, to);
  if (distance === 0) return 0;
  if (hasEquipment(state, to, 'jueying') || hasEquipment(state, to, 'zhuahuang') || hasEquipment(state, to, 'dilu') || hasEquipment(state, to, 'hualiu')) {
    distance += 1;
  }
  if (hasEquipment(state, from, 'dawan') || hasEquipment(state, from, 'chitu') || hasEquipment(state, from, 'zixing')) {
    distance -= 1;
  }
  return Math.max(1, distance);
}

export function inAttackRange(state: GameState, from: PlayerId, to: PlayerId): boolean {
  return distanceBetween(state, from, to) <= attackRangeOf(state, from);
}

export function canUseStrike(state: GameState, pid: PlayerId): boolean {
  if (hasSkill(state, pid, 'paoxiao') || hasEquipment(state, pid, 'zhuge')) return true;
  return Number(propsOf(state, pid).strikesUsed ?? 0) < 1;
}

export function nextAlivePlayer(state: GameState, from: PlayerId): PlayerId | null {
  const order = state.playerOrder;
  const start = order.indexOf(from);
  if (start < 0) return null;
  for (let step = 1; step <= order.length; step += 1) {
    const pid = order[(start + step) % order.length];
    if (state.players[pid]?.alive) return pid;
  }
  return null;
}

/** Move one card and update the visibility rule to match its destination. */
export function moveCard(
  state: GameState,
  cardId: EntityId,
  targetZoneId: ZoneId,
  targetIndex?: number
): GameState {
  const card = state.entities[cardId];
  const targetZone = state.zones[targetZoneId];
  if (!card || !targetZone) return state;
  if (card.zoneId === targetZoneId && targetIndex === undefined) return state;

  const sourceZone = state.zones[card.zoneId];
  const sourceEntities = sourceZone
    ? sourceZone.orderedEntities.filter(id => id !== cardId)
    : [];
  const base = sourceZone?.id === targetZoneId ? sourceEntities : [...targetZone.orderedEntities];
  const targetEntities = [...base];
  if (typeof targetIndex === 'number' && targetIndex >= 0 && targetIndex <= targetEntities.length) {
    targetEntities.splice(targetIndex, 0, cardId);
  } else {
    targetEntities.push(cardId);
  }

  const visibility =
    targetZone.type === 'HAND' && targetZone.ownerId
      ? { type: 'OWNER_ONLY' as const, ownerId: targetZone.ownerId }
      : targetZone.type === 'DECK'
        ? { type: 'HIDDEN' as const }
        : { type: 'PUBLIC' as const };

  const moved: Entity = {
    ...card,
    zoneId: targetZoneId,
    visibility,
    ...(targetZone.ownerId ? { ownerId: targetZone.ownerId } : {})
  };

  const zones = {
    ...state.zones,
    ...(sourceZone ? { [sourceZone.id]: { ...sourceZone, orderedEntities: sourceEntities } } : {}),
    [targetZoneId]: { ...targetZone, orderedEntities: targetEntities }
  };

  return {
    ...state,
    entities: { ...state.entities, [cardId]: moved },
    zones,
    globalVars: { ...state.globalVars, drawDeckCount: zones[DECK_ZONE]?.orderedEntities.length ?? 0 }
  };
}

export function moveCards(state: GameState, cardIds: EntityId[], targetZoneId: ZoneId): GameState {
  return cardIds.reduce((next, cardId) => moveCard(next, cardId, targetZoneId), state);
}

/** Refill the draw pile from the discard pile. Deterministic shuffle only. */
export function reshuffleDiscardIntoDeck(state: GameState): GameState {
  const discardIds = state.zones[DISCARD_ZONE]?.orderedEntities ?? [];
  if (discardIds.length === 0) return state;
  const { result, nextSeed } = DeterministicPRNG.shuffle(state.prngState, discardIds);
  let next = state;
  const remainingDiscard = [...discardIds];
  const zones = { ...next.zones };
  zones[DECK_ZONE] = { ...zones[DECK_ZONE], orderedEntities: [...result] };
  zones[DISCARD_ZONE] = { ...zones[DISCARD_ZONE], orderedEntities: [] };
  const entities = { ...next.entities };
  for (const id of result) {
    const card = entities[id];
    if (!card) continue;
    entities[id] = { ...card, zoneId: DECK_ZONE, visibility: { type: 'HIDDEN' } };
    const idx = remainingDiscard.indexOf(id);
    if (idx >= 0) remainingDiscard.splice(idx, 1);
  }
  next = {
    ...next,
    entities,
    zones,
    prngState: nextSeed,
    globalVars: { ...next.globalVars, drawDeckCount: result.length }
  };
  return next;
}

export interface DrawResult {
  state: GameState;
  drawn: EntityId[];
}

/** Draw from the top of the deck (index 0), reshuffling the discard pile if needed. */
export function drawCards(state: GameState, pid: PlayerId, count: number): DrawResult {
  let next = state;
  const drawn: EntityId[] = [];
  for (let i = 0; i < Math.max(0, count); i += 1) {
    if ((next.zones[DECK_ZONE]?.orderedEntities.length ?? 0) === 0) {
      next = reshuffleDiscardIntoDeck(next);
    }
    const top = next.zones[DECK_ZONE]?.orderedEntities[0];
    if (!top) break;
    next = moveCard(next, top, HAND_ZONE(pid));
    drawn.push(top);
  }
  return { state: next, drawn };
}

export function discardCardIds(state: GameState, cardIds: EntityId[]): GameState {
  return moveCards(state, cardIds, DISCARD_ZONE);
}

export function randomCardFromPlayer(
  state: GameState,
  pid: PlayerId,
  source: 'HAND' | 'EQUIP' | 'JUDGE' | 'ANY',
  seed = state.prngState
): { state: GameState; cardId: EntityId | null; nextSeed: number } {
  const candidates: EntityId[] = [];
  if (source === 'HAND' || source === 'ANY') candidates.push(...handIdsOf(state, pid));
  if (source === 'EQUIP' || source === 'ANY') candidates.push(...(state.zones[EQUIP_ZONE(pid)]?.orderedEntities ?? []));
  if (source === 'JUDGE' || source === 'ANY') candidates.push(...(state.zones[JUDGE_ZONE(pid)]?.orderedEntities ?? []));
  if (candidates.length === 0) return { state, cardId: null, nextSeed: seed };
  const { value, nextSeed } = DeterministicPRNG.nextInt(seed, 0, candidates.length - 1);
  return { state, cardId: candidates[value], nextSeed };
}

/** Take a random card from a player's hand first, then equipment, then judge area. */
export function takeRandomCard(
  state: GameState,
  from: PlayerId,
  to: PlayerId,
  source: 'HAND' | 'EQUIP' | 'JUDGE' | 'ANY' = 'ANY'
): { state: GameState; cardId: EntityId | null; fromZoneId?: ZoneId } {
  const picked = randomCardFromPlayer(state, from, source);
  if (!picked.cardId) return { state, cardId: null };
  const fromZoneId = state.entities[picked.cardId]?.zoneId;
  return {
    state: moveCard({ ...picked.state, prngState: picked.nextSeed }, picked.cardId, HAND_ZONE(to)),
    cardId: picked.cardId,
    ...(fromZoneId ? { fromZoneId } : {})
  };
}

export interface JudgeResult {
  state: GameState;
  cardId: EntityId | null;
  suit: string;
  rank: number;
  red: boolean;
}

/** Draw a judgement card into the judge zone and expose its face. */
export function drawJudgeCard(state: GameState, pid: PlayerId): JudgeResult {
  let next = state;
  if ((next.zones[DECK_ZONE]?.orderedEntities.length ?? 0) === 0) {
    next = reshuffleDiscardIntoDeck(next);
  }
  const top = next.zones[DECK_ZONE]?.orderedEntities[0];
  if (!top) return { state: next, cardId: null, suit: '', rank: 0, red: false };
  next = moveCard(next, top, JUDGE_ZONE(pid));
  const card = next.entities[top];
  return {
    state: next,
    cardId: top,
    suit: cardSuit(card),
    rank: cardRank(card),
    red: cardIsRed(card)
  };
}

export function settleJudgeCard(state: GameState, cardId: EntityId | null): GameState {
  return cardId ? moveCard(state, cardId, DISCARD_ZONE) : state;
}

export function equipCard(state: GameState, pid: PlayerId, cardId: EntityId): GameState {
  const card = state.entities[cardId];
  if (!card) return state;
  const slot = String(card.components.custom?.equipSlot ?? '');
  if (!slot) return state;
  let next = discardCardIds(
    state,
    equipOf(state, pid)
      .filter(equipped => String(equipped.components.custom?.equipSlot ?? '') === slot)
      .map(equipped => equipped.id)
  );
  next = moveCard(next, cardId, EQUIP_ZONE(pid));
  return syncEquipmentHooks(next);
}

/** Rebuild equipment rule-hook descriptors from the cards actually equipped. */
export function syncEquipmentHooks(state: GameState): GameState {
  const hooks = [];
  for (const pid of state.playerOrder) {
    for (const card of equipOf(state, pid)) {
      const hookId = String(card.components.custom?.hookId ?? '');
      if (!hookId) continue;
      hooks.push({
        instanceId: `hook_${card.id}`,
        hookId,
        ownerId: pid,
        sourceEntityId: card.id,
        visibility: { type: 'PUBLIC' as const },
        params: {}
      });
    }
  }
  return { ...state, activeHooks: hooks };
}

export function createCardEntity(
  id: EntityId,
  seed: { code: string; suit: string; rank: number },
  zoneId: ZoneId,
  ownerId?: PlayerId
): Entity {
  const meta = CARD_LIBRARY[seed.code] ?? CARD_LIBRARY.sha;
  const title = cardTitle(meta, seed.suit, seed.rank, id);
  const custom = { ...cardCustom(meta, seed.suit, seed.rank), actionLabel: title };
  const isHand = zoneId.startsWith('zone_hand_');
  return {
    id,
    type: 'CARD',
    zoneId,
    ...(ownerId ? { ownerId } : {}),
    visibility: isHand && ownerId
      ? { type: 'OWNER_ONLY', ownerId }
      : zoneId === DECK_ZONE
        ? { type: 'HIDDEN' }
        : { type: 'PUBLIC' },
    components: {
      cardFace: {
        title,
        suit: seed.suit,
        rank: rankText(seed.rank),
        type: meta.category,
        desc: meta.desc,
        color: suitColor(seed.suit)
      },
      custom
    }
  };
}

export function allCardIds(state: GameState, pid: PlayerId): EntityId[] {
  return [
    ...handIdsOf(state, pid),
    ...(state.zones[EQUIP_ZONE(pid)]?.orderedEntities ?? []),
    ...(state.zones[JUDGE_ZONE(pid)]?.orderedEntities ?? [])
  ];
}

export function hasAnyCard(state: GameState, pid: PlayerId): boolean {
  return allCardIds(state, pid).length > 0;
}

export function resetTurnFlags(state: GameState, pid: PlayerId): GameState {
  return setProps(state, pid, {
    strikesUsed: 0,
    wineUsed: false,
    wineBonus: 0,
    rendeGiven: 0,
    rendeHealed: false,
    zhihengUsed: false,
    kurouUsed: false,
    qingnangUsed: false,
    jieyinUsed: false,
    lijianUsed: false,
    skipPlay: false,
    skipDraw: false
  });
}

export function clearResponseContext(state: GameState): GameState {
  const globalVars = { ...state.globalVars };
  delete globalVars.strike;
  delete globalVars.duel;
  delete globalVars.massTrick;
  delete globalVars.dying;
  return { ...state, globalVars };
}

export function strikeContext(state: GameState): SgsStrikeContext | undefined {
  return state.globalVars.strike as SgsStrikeContext | undefined;
}

export function duelContext(state: GameState): SgsDuelContext | undefined {
  return state.globalVars.duel as SgsDuelContext | undefined;
}

export function massTrickContext(state: GameState): SgsMassTrickContext | undefined {
  return state.globalVars.massTrick as SgsMassTrickContext | undefined;
}

export function actionCardId(action: Action): EntityId | undefined {
  return action.entityId ?? (action.payload?.cardId as EntityId | undefined);
}

/** Escape hatch used only by presentation helpers. */
export function cardLabel(state: GameState, cardId?: EntityId): string {
  if (!cardId) return '牌';
  const card = state.entities[cardId];
  // Use the printed face when available: physical copies can share a name and
  // suit/rank, and a choice list must not render two different cards alike.
  return String(
    card?.components.cardFace?.title ??
      card?.components.custom?.zh ??
      cardId
  );
}
