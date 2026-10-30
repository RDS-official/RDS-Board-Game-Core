/**
 * Betrayal rule helpers: trait tracks, dice, damage, exploration, cards,
 * monsters and turn bookkeeping. All functions are deterministic and only
 * touch plain JSON state.
 */

import { ECSManager } from '@rds/kernel/ecs';
import { OccupancyIndex } from '@rds/kernel/occupancy';
import { ReduceContext } from '@rds/kernel/module';
import { DeterministicPRNG } from '@rds/kernel/prng';
import {
  Action,
  ActorId,
  EffectExpiry,
  EffectInstance,
  Entity,
  GameState,
  JsonRecord,
  MapGraphNode,
  PlayerId,
  VisibilityRule,
  Zone
} from '@rds/kernel/types';
import {
  CardType,
  DoorDir,
  EVENT_DEFS,
  Floor,
  FLOOR_META,
  ITEM_DEFS,
  MAX_ATTACK_DICE,
  OMEN_DEFS,
  OmenDef,
  RoomDef,
  ROOM_DEFS,
  TraitKey,
  TRAIT_KEYS,
  WEAPON_SPECS
} from './cards';

/* -------------------------------------------------------------------------- */
/* Effects (kernel-owned lifecycle)                                            */
/* -------------------------------------------------------------------------- */

/**
 * Ongoing curses an event card can leave on an explorer.
 *
 * These are the module's *timed modifiers*: the kernel stores them in
 * `GameState.effects` (owning id/expiry/visibility) and the module only
 * interprets `payload.effect` at its own `startOfTurn` hook.
 */
export const ONGOING_EFFECT_KINDS = [
  'DRIP',
  'POSSESSION',
  'CHILL',
  'HAUNTING_MELODY',
  'MARK_OF_FEAR'
] as const;

export type OngoingEffectKind = (typeof ONGOING_EFFECT_KINDS)[number];

export interface EffectSpec {
  kind: string;
  source: ActorId;
  /** PlayerId, NpcId or EntityId. */
  target: string;
  payload?: JsonRecord;
  tags?: string[];
  expiresAt?: EffectExpiry;
  visibility?: VisibilityRule;
}

/**
 * Register (or refresh) a module effect on the kernel-owned effect list.
 *
 * The id is derived from `kind` + `target` (plus `payload.effect` when present),
 * so re-applying the same curse to the same explorer is idempotent while two
 * *different* curses on one explorer stay separate instances.
 */
export function addEffect(state: GameState, spec: EffectSpec): EffectInstance {
  const variant = String((spec.payload as { effect?: unknown } | undefined)?.effect ?? '');
  const id = `eff_${spec.kind}${variant ? `_${variant}` : ''}_${spec.target}`;
  const instance: EffectInstance = {
    id,
    kind: spec.kind,
    source: spec.source,
    target: spec.target,
    ...(spec.payload ? { payload: spec.payload } : {}),
    ...(spec.tags ? { tags: spec.tags } : {}),
    ...(spec.expiresAt ? { expiresAt: spec.expiresAt } : {}),
    visibility: spec.visibility ?? { type: 'PUBLIC' }
  };
  const list = state.effects ?? [];
  const existing = list.findIndex(effect => effect.id === id);
  state.effects = existing >= 0
    ? list.map((effect, index) => (index === existing ? instance : effect))
    : [...list, instance];
  return instance;
}

/** Drop every effect matching the predicate; returns how many were removed. */
export function removeEffects(
  state: GameState,
  predicate: (effect: EffectInstance) => boolean
): number {
  const list = state.effects ?? [];
  const kept = list.filter(effect => !predicate(effect));
  const removed = list.length - kept.length;
  if (removed > 0) state.effects = kept;
  return removed;
}

/**
 * Every effect currently targeting `targetId`.
 *
 * Reads the kernel list first, then folds in the legacy
 * `customProps.effects: string[]` so logs produced before the migration still
 * replay identically. Legacy entries are surfaced as synthetic instances with
 * `id: 'legacy_<KIND>'` and `payload.effect = KIND`.
 */
export function effectsOn(state: GameState, targetId: string): EffectInstance[] {
  const modern = (state.effects ?? []).filter(effect => effect.target === targetId);

  const legacyKinds = (state.players[targetId]?.customProps?.effects ?? []) as string[];
  if (!Array.isArray(legacyKinds) || legacyKinds.length === 0) return modern;

  const seen = new Set(
    modern.map(effect => String((effect.payload as { effect?: string } | undefined)?.effect ?? effect.kind))
  );
  const legacy: EffectInstance[] = legacyKinds
    .filter(kind => !seen.has(kind))
    .map(kind => ({
      id: `legacy_${kind}_${targetId}`,
      kind: 'ONGOING',
      source: targetId as ActorId,
      target: targetId,
      payload: { effect: kind, legacy: true },
      visibility: { type: 'PUBLIC' as const }
    }));
  return [...modern, ...legacy];
}

/** Ongoing-curse kinds active on `targetId`, merged modern + legacy. */
export function ongoingEffectKinds(state: GameState, targetId: string): string[] {
  return effectsOn(state, targetId)
    .filter(effect => effect.kind === 'ONGOING')
    .map(effect => String((effect.payload as { effect?: string } | undefined)?.effect ?? ''))
    .filter((kind): kind is string => kind.length > 0);
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                      */
/* -------------------------------------------------------------------------- */

/** Apply an ECS return value back onto the mutable reducer scratch state. */
export function commit(state: GameState, next: GameState): GameState {
  state.entities = next.entities;
  state.zones = next.zones;
  state.mapGraph = next.mapGraph;
  return state;
}

export const ROOM_SIZE = 2.84;
export const ROOM_SPACING = 2.86;
// The physical mansion is an open table layout, not a fixed 5x5 board.
// Coordinates may extend in any direction; the deck size bounds the map.

const FLOOR_OFFSET: Record<Floor, number> = {
  BASEMENT: -14,
  GROUND: 0,
  UPPER: 14
};

export const FLOOR_ANCHORS: Record<Floor, [number, number, number]> = {
  BASEMENT: [FLOOR_OFFSET.BASEMENT, 0.05, 0],
  GROUND: [FLOOR_OFFSET.GROUND, 0.05, 0],
  UPPER: [FLOOR_OFFSET.UPPER, 0.05, 0]
};

export function gridToWorld(floor: Floor, col: number, row: number): [number, number, number] {
  return [FLOOR_OFFSET[floor] + (col - 2) * ROOM_SPACING, 0.05, (row - 2) * ROOM_SPACING];
}

export function doorDelta(dir: DoorDir): [number, number] {
  switch (dir) {
    case 'N':
      return [0, -1];
    case 'S':
      return [0, 1];
    case 'E':
      return [1, 0];
    case 'W':
      return [-1, 0];
  }
}

export function opposite(dir: DoorDir): DoorDir {
  return dir === 'N' ? 'S' : dir === 'S' ? 'N' : dir === 'E' ? 'W' : 'E';
}

export function rotateDoor(dir: DoorDir, quarterTurns: number): DoorDir {
  const order: DoorDir[] = ['N', 'E', 'S', 'W'];
  const index = (order.indexOf(dir) + quarterTurns) % 4;
  return order[index];
}

export function rotateDoors(doors: DoorDir[], quarterTurns: number): DoorDir[] {
  return doors.map(dir => rotateDoor(dir, quarterTurns));
}

/** Choose the first rotation that lets the tile accept the entry door. */
export function findRotation(doors: DoorDir[], entryDoor: DoorDir): number | null {
  for (let rotation = 0; rotation < 4; rotation++) {
    if (rotateDoors(doors, rotation).includes(entryDoor)) return rotation;
  }
  return null;
}

export function nodeGrid(node: MapGraphNode | undefined): { col: number; row: number; floor: Floor } | null {
  if (!node) return null;
  const col = Number(node.props?.col);
  const row = Number(node.props?.row);
  const floor = node.props?.floor as Floor | undefined;
  if (!Number.isFinite(col) || !Number.isFinite(row) || !floor) return null;
  return { col, row, floor };
}

/* -------------------------------------------------------------------------- */
/* Trait tracks                                                                */
/* -------------------------------------------------------------------------- */

export function tracksOf(player: { customProps: Record<string, any> }): Record<TraitKey, number[]> {
  return player.customProps.tracks as Record<TraitKey, number[]>;
}

export function traitIndex(player: { customProps: Record<string, any> }, trait: TraitKey): number {
  const index = Number(player.customProps.traitIndex?.[trait]);
  return Number.isFinite(index) ? index : 0;
}

export function traitValue(player: { customProps: Record<string, any> }, trait: TraitKey): number {
  const track = tracksOf(player)?.[trait] ?? [0];
  const index = Math.max(0, Math.min(track.length - 1, traitIndex(player, trait)));
  return track[index] ?? 0;
}

export function traitValues(player: { customProps: Record<string, any> }): Record<TraitKey, number> {
  return {
    speed: traitValue(player, 'speed'),
    might: traitValue(player, 'might'),
    sanity: traitValue(player, 'sanity'),
    knowledge: traitValue(player, 'knowledge')
  };
}


/**
 * Trait bonuses that apply right now.
 *
 * Sums three sources: carried cards that declare `modifiers`, the temporary
 * `customProps.traitModifiers` bucket that scenarios and effects use, and any
 * kernel effect carrying a `traitDelta` payload. Everything is derived from
 * state, so replays stay deterministic — nothing is cached on the player.
 *
 * See docs/ENGINE-PASSIVE-MODIFIERS.md for why this lives in the module rather
 * than in the kernel.
 */
export function traitModifiers(state: GameState, playerId: PlayerId): Record<TraitKey, number> {
  const totals: Record<TraitKey, number> = { speed: 0, might: 0, sanity: 0, knowledge: 0 };
  const player = state.players[playerId];
  if (!player) return totals;

  for (const entity of handEntities(state, playerId)) {
    const defId = cardDef(entity);
    const def = ITEM_DEFS[defId] ?? OMEN_DEFS[defId];
    for (const modifier of def?.modifiers ?? []) {
      if (modifier.trait in totals) totals[modifier.trait] += modifier.delta;
    }
  }

  const temporary = (player.customProps.traitModifiers ?? {}) as Partial<Record<TraitKey, number>>;
  for (const trait of TRAIT_KEYS) totals[trait] += Number(temporary[trait] ?? 0);

  for (const effect of state.effects ?? []) {
    if (effect.target !== playerId) continue;
    const payload = (effect.payload ?? {}) as { trait?: TraitKey; traitDelta?: number };
    if (payload.trait && payload.traitDelta && payload.trait in totals) {
      totals[payload.trait] += Number(payload.traitDelta);
    }
  }

  return totals;
}

/** The trait value the rules actually use: printed value plus active modifiers. */
export function effectiveTrait(state: GameState, playerId: PlayerId, trait: TraitKey): number {
  const player = state.players[playerId];
  if (!player) return 0;
  return traitValue(player, trait) + traitModifiers(state, playerId)[trait];
}

export function minTraitIndex(track: number[], haunt: boolean): number {
  if (haunt) return 0;
  const index = track.findIndex(value => value >= 1);
  return index < 0 ? 1 : index;
}

export interface TraitDeltaResult {
  applied: number;
  dead: boolean;
}

/**
 * Move a trait along its printed track. Positive steps heal (capped at the
 * character's green starting value unless `force`), negative steps wound.
 */
export function applyTraitSteps(
  state: GameState,
  playerId: PlayerId,
  trait: TraitKey,
  steps: number,
  opts: { force?: boolean } = {}
): TraitDeltaResult {
  const player = state.players[playerId];
  if (!player) return { applied: 0, dead: false };

  const track = tracksOf(player)?.[trait];
  if (!track) return { applied: 0, dead: false };

  const haunt = !!state.globalVars.hauntTriggered;
  const current = traitIndex(player, trait);
  const start = Number(player.customProps.startIndex?.[trait] ?? track.length - 1);
  const lower = minTraitIndex(track, haunt);
  const upper = opts.force || steps < 0 ? track.length - 1 : start;

  const next = Math.max(lower, Math.min(upper, current + steps));
  player.customProps.traitIndex = { ...(player.customProps.traitIndex ?? {}), [trait]: next };
  player.customProps.traits = {
    ...(player.customProps.traits ?? {}),
    [trait]: track[next]
  };

  return { applied: next - current, dead: haunt && next === 0 };
}

export interface DamageResult {
  applied: number;
  dead: boolean;
  trait: TraitKey;
  reducedBy: number;
}

/**
 * Apply physical/mental damage. Physical damage defaults to Might and mental
 * damage to Sanity; an explicit trait lets the defender choose.
 */
export function damagePlayer(
  state: GameState,
  playerId: PlayerId,
  kind: 'PHYSICAL' | 'MENTAL',
  amount: number,
  trait?: TraitKey
): DamageResult {
  const player = state.players[playerId];
  if (!player || !player.alive || amount <= 0) return { applied: 0, dead: false, trait: trait ?? 'might', reducedBy: 0 };

  let reduction = 0;
  if (kind === 'PHYSICAL' && ownsDef(state, playerId, 'armor')) reduction += 1;
  if (kind === 'MENTAL' && ownsDef(state, playerId, 'skull')) reduction += 1;

  const target: TraitKey = trait ?? (kind === 'PHYSICAL' ? 'might' : 'sanity');
  const total = Math.max(0, amount - reduction);
  const result = applyTraitSteps(state, playerId, target, -total);

  const dead = result.dead || TRAIT_KEYS.some(key => traitIndex(player, key) === 0 && !!state.globalVars.hauntTriggered);
  if (dead) killPlayer(state, playerId);

  return { applied: Math.abs(result.applied), dead, trait: target, reducedBy: reduction };
}

export function killPlayer(state: GameState, playerId: PlayerId): void {
  const player = state.players[playerId];
  if (!player || !player.alive) return;

  player.alive = false;
  player.customProps = { ...(player.customProps ?? {}), deathRoomId: player.customProps.currentRoomId, controlled: false };
  dropAllItems(state, playerId);
}

/** Move every card in a dead player's hand into the room's item pile. */
export function dropAllItems(state: GameState, playerId: PlayerId): void {
  const player = state.players[playerId];
  if (!player) return;
  const hand = state.zones[`zone_hand_${playerId}`];
  if (!hand) return;

  const roomId = player.customProps.currentRoomId as string;
  const zone = ensureRoomZone(state, roomId);
  for (const entityId of [...hand.orderedEntities]) {
    const entity = state.entities[entityId];
    if (!entity) continue;
    entity.visibility = { type: 'PUBLIC' };
    commit(state, ECSManager.moveEntity(state, entityId, zone.id));
  }
}

/* -------------------------------------------------------------------------- */
/* Dice                                                                        */
/* -------------------------------------------------------------------------- */

/** Betrayal dice have faces 0 / 1 / 2 (uniform). */
export function rollZeroDice(seed: number, count: number): { rolls: number[]; sum: number; nextSeed: number } {
  const rolls: number[] = [];
  let currentSeed = seed;
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const { value, nextSeed } = DeterministicPRNG.nextInt(currentSeed, 0, 2);
    rolls.push(value);
    sum += value;
    currentSeed = nextSeed;
  }
  return { rolls, sum, nextSeed: currentSeed };
}

export function ownsDef(state: GameState, playerId: PlayerId, defId: string): boolean {
  return handEntities(state, playerId).some(entity => entity.components.custom?.defId === defId);
}

export function handEntities(state: GameState, playerId: PlayerId): Entity[] {
  const zone = state.zones[`zone_hand_${playerId}`];
  if (!zone) return [];
  return zone.orderedEntities.map(id => state.entities[id]).filter((entity): entity is Entity => !!entity);
}

export function findHandEntity(state: GameState, playerId: PlayerId, defId: string): Entity | undefined {
  return handEntities(state, playerId).find(entity => entity.components.custom?.defId === defId);
}

export function usedThisTurn(state: GameState, playerId: PlayerId, defId: string): boolean {
  return (state.players[playerId]?.customProps.usedItems ?? []).includes(defId);
}

export function markUsed(state: GameState, playerId: PlayerId, defId: string): void {
  const player = state.players[playerId];
  player.customProps.usedItems = [...(player.customProps.usedItems ?? []), defId];
}

export interface CheckOptions {
  extraDice?: number;
  threshold?: number;
  reason?: string;
  /** Player-facing name of the thing being checked (card, action or room). */
  label?: string;
  allowLuck?: boolean;
  /**
   * What this check is for, in the player's words ("成功：撬开金库并取走 2 件物品").
   * Display-only: the dice overlay shows it before the dice land. The module owns
   * the wording so the presentation layer never imports game content.
   */
  effect?: string;
}

export interface CheckResult {
  total: number;
  dice: number[];
  count: number;
  threshold?: number;
  success?: boolean;
  modifiers: string[];
}

/**
 * Trait check with automatic luck-item handling (Lucky Stone, Rabbit's Foot,
 * Idol, Angel Feather). Manual timing is collapsed into an automatic policy so
 * a single dispatch stays deterministic and replayable.
 */
export function rollTraitCheck(
  state: GameState,
  playerId: PlayerId,
  trait: TraitKey,
  options: CheckOptions = {}
): CheckResult {
  const player = state.players[playerId];
  const modifiers: string[] = [];

  const baseValue = traitValue(player, trait);
  state.globalVars.rollSeq = Number(state.globalVars.rollSeq ?? 0) + 1;
  if (options.reason) {
    const attempted = new Set<string>((player.customProps.rolledThisTurn as string[]) ?? []);
    attempted.add(options.reason);
    player.customProps.rolledThisTurn = [...attempted];
  }
  let count = baseValue;
  // Carried-card bonuses such as Armor's "+1 Might" (docs/ENGINE-PASSIVE-MODIFIERS.md).
  const passiveBonus = traitModifiers(state, playerId)[trait];
  if (passiveBonus !== 0) {
    count += passiveBonus;
    modifiers.push(`被动 ${passiveBonus > 0 ? '+' : ''}${passiveBonus}`);
  }
  count += Number(player.customProps.checkBonus ?? 0);
  count += Number(options.extraDice ?? 0);

  if (ownsDef(state, playerId, 'mask') && player.customProps.maskWorn) {
    if (trait === 'knowledge') {
      count += 2;
      modifiers.push('面具 +2 骰');
    }
    if (trait === 'sanity') {
      count -= 2;
      modifiers.push('面具 -2 骰');
    }
  }
  count = Math.max(1, Math.min(MAX_ATTACK_DICE, count));

  if (player.customProps.checkBonus) {
    player.customProps.checkBonus = 0;
  }

  const forced = player.customProps.forcedRoll as { value: number } | undefined;
  if (forced) {
    player.customProps.forcedRoll = undefined;
    modifiers.push('天使羽毛指定结果');
    const total = Math.max(0, Math.min(8, Number(forced.value)));
    const result: CheckResult = {
      total,
      dice: [total],
      count,
      threshold: options.threshold,
      success: options.threshold === undefined ? undefined : total >= options.threshold,
      modifiers
    };
    state.globalVars.lastRoll = {
      playerId,
      trait,
      traitValue: baseValue,
      seq: Number(state.globalVars.rollSeq ?? 0),
      effect: options.effect,
    label: options.label,
      ...result,
      reason: options.reason ?? 'check'
    };
    return result;
  }

  const rolled = rollZeroDice(state.prngState, count);
  state.prngState = rolled.nextSeed;
  let dice = [...rolled.rolls];
  let total = rolled.sum;

  if (options.threshold !== undefined && total < options.threshold && options.allowLuck !== false) {
    if (ownsDef(state, playerId, 'rabbits_foot') && !usedThisTurn(state, playerId, 'rabbits_foot')) {
      const lowest = dice.indexOf(Math.min(...dice));
      const reroll = rollZeroDice(state.prngState, 1);
      state.prngState = reroll.nextSeed;
      dice[lowest] = reroll.rolls[0];
      total = dice.reduce((sum, value) => sum + value, 0);
      markUsed(state, playerId, 'rabbits_foot');
      modifiers.push('幸运兔足重掷');
    }

    if (total < options.threshold && ownsDef(state, playerId, 'lucky_stone') && !usedThisTurn(state, playerId, 'lucky_stone')) {
      total += 1;
      markUsed(state, playerId, 'lucky_stone');
      modifiers.push('幸运石 +1');
    }

    if (total < options.threshold && ownsDef(state, playerId, 'idol') && !usedThisTurn(state, playerId, 'idol')) {
      const reroll = rollZeroDice(state.prngState, count);
      state.prngState = reroll.nextSeed;
      dice = reroll.rolls;
      total = reroll.sum;
      markUsed(state, playerId, 'idol');
      damagePlayer(state, playerId, 'MENTAL', 1, 'sanity');
      modifiers.push('神像重掷（-1 神智）');
    }
  }

  const result: CheckResult = {
    total,
    dice,
    count,
    threshold: options.threshold,
    success: options.threshold === undefined ? undefined : total >= options.threshold,
    modifiers
  };
  state.globalVars.lastRoll = {
    playerId,
    trait,
    traitValue: baseValue,
      seq: Number(state.globalVars.rollSeq ?? 0),
    effect: options.effect,
    label: options.label,
    ...result,
    reason: options.reason ?? 'check'
  };
  return result;
}

/* -------------------------------------------------------------------------- */
/* Items & cards                                                               */
/* -------------------------------------------------------------------------- */

export function cardDef(entity: Entity | undefined): string {
  return String(entity?.components.custom?.defId ?? '');
}

export function cardType(entity: Entity | undefined): CardType | undefined {
  return entity?.components.custom?.cardType as CardType | undefined;
}

export function isCompanion(entity: Entity | undefined): boolean {
  return !!entity?.components.custom?.companion;
}

export function tradeable(entity: Entity | undefined): boolean {
  return !!entity?.components.custom?.tradeable;
}

export function itemLabel(entity: Entity | undefined): string {
  return entity?.components.custom?.zh ?? entity?.components.cardFace?.title ?? '未知卡牌';
}

export function itemSlotId(roomId: string): string {
  return `slot_${roomId}_items`;
}

export function monsterSlotId(roomId: string): string {
  return `slot_${roomId}_monsters`;
}

export function tokenSlotId(roomId: string): string {
  return `slot_${roomId}_tokens`;
}

/** Declare the three generic room piles; safe to call before the node exists. */
export function ensureRoomSlots(state: GameState, roomId: string): void {
  state.mapGraph.slots ??= {};
  const slots = state.mapGraph.slots;
  if (!slots[itemSlotId(roomId)]) {
    slots[itemSlotId(roomId)] = {
      id: itemSlotId(roomId),
      kind: 'NODE',
      nodeId: roomId,
      accepts: { entityTypes: ['CARD'] },
      capacity: 99,
      // Presentation contract: the module owns the room-item anchor and fan
      // spacing; the renderer must not invent a second room anchor.
      layout: 'FAN',
      local: { position: [0.38, 0.07, 0.48] },
      overflow: 'OFFSET',
      visual: { height: 0.01, gap: 0.58, maxOffset: 0.5, scale: 0.3 }
    };
  }
  if (!slots[monsterSlotId(roomId)]) {
    slots[monsterSlotId(roomId)] = {
      id: monsterSlotId(roomId),
      kind: 'NODE',
      nodeId: roomId,
      accepts: { entityTypes: ['MEEPLE'] },
      capacity: 99,
      layout: 'ROW',
      overflow: 'OFFSET',
      visual: { gap: 0.55 }
    };
  }
  if (!slots[tokenSlotId(roomId)]) {
    slots[tokenSlotId(roomId)] = {
      id: tokenSlotId(roomId),
      kind: 'NODE',
      nodeId: roomId,
      accepts: { entityTypes: ['TOKEN'] },
      capacity: 99,
      layout: 'STACK',
      overflow: 'OFFSET',
      visual: { height: 0.03, gap: 0.12 }
    };
  }
}

export function ensureRoomZone(state: GameState, roomId: string): Zone {
  ensureRoomSlots(state, roomId);
  const id = `zone_room_${roomId}`;
  const existing = state.zones[id];
  if (existing) return existing;

  const node = state.mapGraph.nodes[roomId];
  const position = node
    ? gridToWorld(node.props.floor as Floor, Number(node.props.col), Number(node.props.row))
    : ([0, 0.12, 0] as [number, number, number]);
  const next = ECSManager.createZone(
    state,
    id,
    `${node?.props?.name ?? roomId} · 物品堆`,
    'BOARD',
    { type: 'PUBLIC' },
    undefined,
    'ROW',
    [position[0], 0.16, position[2]]
  );
  state.zones = next.zones;
  return state.zones[id];
}

export function takeTopCard(state: GameState, deckZoneId: string): Entity | null {
  const deck = state.zones[deckZoneId];
  if (!deck || deck.orderedEntities.length === 0) return null;
  const entityId = deck.orderedEntities[deck.orderedEntities.length - 1];
  return state.entities[entityId] ?? null;
}

export function drawCardTo(
  state: GameState,
  deckZoneId: string,
  targetZoneId: string,
  visibility: Entity['visibility']
): Entity | null {
  const card = takeTopCard(state, deckZoneId);
  if (!card) return null;
  card.visibility = visibility;
  commit(state, ECSManager.moveEntity(state, card.id, targetZoneId));
  return state.entities[card.id] ?? null;
}

export function discardCard(state: GameState, entityId: string, discardZoneId: string): void {
  const entity = state.entities[entityId];
  if (!entity) return;
  entity.visibility = { type: 'PUBLIC' };
  commit(state, ECSManager.moveEntity(state, entityId, discardZoneId));
}

/** Make a card entity for a deck (face-down until drawn). */
export function makeCardEntity(
  id: string,
  zoneId: string,
  defId: string,
  type: CardType,
  face: { name: string; en: string; desc: string },
  extra: Record<string, unknown>
): Entity {
  return {
    id,
    type: 'CARD',
    zoneId,
    visibility: { type: 'HIDDEN' },
    components: {
      cardFace: {
        title: face.name,
        type,
        desc: face.desc,
        suit: type,
        color: type === 'OMEN' ? '#b07bf0' : type === 'ITEM' ? '#57c08b' : '#e0922f'
      },
      custom: {
        defId,
        cardType: type,
        en: face.en,
        zh: face.name,
        ...extra
      }
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Omens                                                                       */
/* -------------------------------------------------------------------------- */

export function omenDef(defId: string): OmenDef | undefined {
  return OMEN_DEFS[defId];
}

export function applyOmenGain(state: GameState, playerId: PlayerId, defId: string): void {
  const def = OMEN_DEFS[defId];
  if (!def?.onGain) return;
  for (const grant of def.onGain) applyTraitSteps(state, playerId, grant.trait, grant.amount, { force: true });
}

export function applyOmenLoss(state: GameState, playerId: PlayerId, defId: string): void {
  const def = OMEN_DEFS[defId];
  if (!def?.onLoss) return;
  for (const grant of def.onLoss) {
    const result = applyTraitSteps(state, playerId, grant.trait, grant.amount, { force: true });
    if (result.dead) killPlayer(state, playerId);
  }
}

export function applyItemGain(state: GameState, playerId: PlayerId, defId: string): void {
  const def = ITEM_DEFS[defId];
  if (!def?.onGain) return;
  for (const grant of def.onGain) applyTraitSteps(state, playerId, grant.trait, grant.amount, { force: true });
}

export function applyItemLoss(state: GameState, playerId: PlayerId, defId: string): void {
  const def = ITEM_DEFS[defId];
  if (!def?.onLoss) return;
  for (const grant of def.onLoss) {
    const result = applyTraitSteps(state, playerId, grant.trait, grant.amount, { force: true });
    if (result.dead) killPlayer(state, playerId);
  }
}

/** Bell + Book + Candle: +2 to every trait while the set is held together. */
export function updateResonance(state: GameState, playerId: PlayerId): void {
  const player = state.players[playerId];
  if (!player) return;
  const complete =
    ownsDef(state, playerId, 'bell') && ownsDef(state, playerId, 'book') && ownsDef(state, playerId, 'candle');
  const active = !!player.customProps.resonance;
  if (complete === active) return;

  player.customProps.resonance = complete;
  for (const trait of TRAIT_KEYS) {
    applyTraitSteps(state, playerId, trait, complete ? 2 : -2, { force: true });
  }
  if (player.alive === false) return;
}

/* -------------------------------------------------------------------------- */
/* Rooms & exploration                                                         */
/* -------------------------------------------------------------------------- */

export function addRoomNode(
  state: GameState,
  def: RoomDef,
  col: number,
  row: number,
  rotation: number,
  nodeId: string
): MapGraphNode {
  ensureRoomSlots(state, nodeId);

  // Two rooms on one floor may not share a grid cell: the renderer would draw
  // both tiles in the same place. Re-placing the SAME node (moving it) is fine.
  const layerIndex = FLOOR_META[def.floor].index;
  for (const other of Object.values(state.mapGraph.nodes)) {
    if (other.type !== 'ROOM' || other.id === nodeId) continue;
    if (other.position[2] === layerIndex && other.position[0] === col && other.position[1] === row) {
      throw new Error(
        `room grid collision: ${nodeId} wants (${col},${row}) on ${def.floor}, \`but ${other.id} is already there`
      );
    }
  }
  const node: MapGraphNode = {
    id: nodeId,
    type: 'ROOM',
    // High-dimensional logical coordinate: [col, row, layerIndex].
    position: [col, row, FLOOR_META[def.floor].index],
    positionSpace: 'grid',
    neighbors: [],
    layer: def.floor,
    props: {
      name: def.name,
      en: def.en,
      floor: def.floor,
      floorIndex: FLOOR_META[def.floor].index,
      col,
      row,
      rotation,
      doors: rotateDoors(def.doors, rotation),
      localDoors: def.doors,
      symbol: def.symbol ?? null,
      special: def.special ?? null,
      tags: def.tags ?? [],
      frontDoor: def.frontDoor ?? null,
      endTurnBuff: def.endTurnBuff ?? null,
      explored: true,
      color: FLOOR_META[def.floor].color,
      text: def.text
    }
  };
  state.mapGraph.nodes[nodeId] = node;
  return node;
}

export function connectRooms(state: GameState, fromId: string, toId: string, type = 'DOOR', label?: string): string {
  const from = state.mapGraph.nodes[fromId];
  const to = state.mapGraph.nodes[toId];
  if (!from || !to) return '';

  if (!from.neighbors.includes(toId)) from.neighbors.push(toId);
  if (!to.neighbors.includes(fromId)) to.neighbors.push(fromId);

  const edgeId = `edge_${fromId}_${toId}`;
  const reverseId = `edge_${toId}_${fromId}`;
  const existing = state.mapGraph.edges[edgeId] ?? state.mapGraph.edges[reverseId];
  if (existing) {
    // A normal door supersedes an older one-way drop between the same rooms.
    if (existing.directed) {
      existing.directed = undefined;
      existing.type = type;
      existing.props = { ...(existing.props ?? {}), label };
      if (!to.neighbors.includes(fromId)) to.neighbors.push(fromId);
    }
    return existing.id;
  }

  state.mapGraph.edges[edgeId] = { id: edgeId, from: fromId, to: toId, type, props: { label } };
  return edgeId;
}

/** Directional connection: only `from` may traverse to `to`. */
export function connectOneWay(state: GameState, fromId: string, toId: string, type = 'DROP', label?: string): string {
  const from = state.mapGraph.nodes[fromId];
  const to = state.mapGraph.nodes[toId];
  if (!from || !to) return '';

  if (!from.neighbors.includes(toId)) from.neighbors.push(toId);

  const edgeId = `edge_${fromId}_${toId}`;
  if (!state.mapGraph.edges[edgeId]) {
    state.mapGraph.edges[edgeId] = {
      id: edgeId,
      from: fromId,
      to: toId,
      type,
      directed: true,
      props: { label, oneWay: true }
    };
  }
  return edgeId;
}

export interface RoomDrawResult {
  state: GameState;
  def: RoomDef | null;
  rotation: number;
  nodeId?: string;
  discarded: string[];
}

/** A drawn tile waiting for the player to choose its quarter-turn rotation. */
export interface RoomPlacementCandidate {
  def: RoomDef;
  tileId: string;
  fromRoomId: string;
  dir: DoorDir;
  col: number;
  row: number;
  floor: Floor;
  /** Valid quarter turns (0..3) that put a door on the entry side. */
  rotations: number[];
  discarded: string[];
}

/** All quarter turns that expose a door toward the entry side. */
export function validRotations(doors: DoorDir[], entryDoor: DoorDir): number[] {
  return [0, 1, 2, 3].filter(rotation => rotateDoors(doors, rotation).includes(entryDoor));
}

/**
 * Draw the first floor-matching tile and return it *without placing it*.
 * The caller offers `rotations` to the player, then calls placeRoomCandidate.
 */
export function drawRoomCandidate(
  state: GameState,
  currentRoomId: string,
  dir: DoorDir
): RoomPlacementCandidate | null {
  const current = state.mapGraph.nodes[currentRoomId];
  const grid = nodeGrid(current);
  if (!grid) return null;

  const [dc, dr] = doorDelta(dir);
  const col = grid.col + dc;
  const row = grid.row + dr;

  const occupied = Object.values(state.mapGraph.nodes).some(node => {
    const other = nodeGrid(node);
    return other && other.floor === grid.floor && other.col === col && other.row === row;
  });
  if (occupied) return null;

  const entryDoor = opposite(dir);
  const discarded: string[] = [];
  let attempts = 0;

  const reshuffleDiscard = () => {
    const deck = state.zones.zone_room_deck;
    const discard = state.zones.zone_room_discard;
    if (deck && deck.orderedEntities.length === 0 && discard && discard.orderedEntities.length > 0) {
      const items = [...discard.orderedEntities];
      for (const tid of items) {
        commit(state, ECSManager.moveEntity(state, tid, 'zone_room_deck'));
      }
      const shuffled = DeterministicPRNG.shuffle(
        (state.seed ?? 42) + items.length + attempts * 19,
        state.zones.zone_room_deck.orderedEntities
      );
      state.zones.zone_room_deck.orderedEntities = shuffled.result;
    }
  };

  while (attempts < 64) {
    attempts += 1;
    const deck = state.zones.zone_room_deck;
    if (!deck || deck.orderedEntities.length === 0) {
      reshuffleDiscard();
      if (!deck || deck.orderedEntities.length === 0) break;
    }

    const tileId = deck.orderedEntities[deck.orderedEntities.length - 1];
    const tile = state.entities[tileId];
    const defId = String(tile?.components.custom?.roomDefId ?? '');
    const def = ROOM_DEFS[defId];
    if (!tile || !def) {
      if (tile) commit(state, ECSManager.moveEntity(state, tileId, 'zone_room_discard'));
      continue;
    }

    const nodeId = `room_${defId}`;
    if (state.mapGraph.nodes[nodeId]) {
      // Room tile is already on the board (e.g. pre-placed by scenario or previously explored).
      commit(state, ECSManager.moveEntity(state, tileId, 'zone_room_placed'));
      continue;
    }

    const allowedFloors = def.floors ?? [def.floor];
    if (!allowedFloors.includes(grid.floor)) {
      discarded.push(defId);
      commit(state, ECSManager.moveEntity(state, tileId, 'zone_room_discard'));
      continue;
    }

    const rotations = validRotations(def.doors, entryDoor);
    if (rotations.length === 0) {
      discarded.push(defId);
      commit(state, ECSManager.moveEntity(state, tileId, 'zone_room_discard'));
      continue;
    }

    return {
      def,
      tileId,
      fromRoomId: currentRoomId,
      dir,
      col,
      row,
      floor: grid.floor,
      rotations,
      discarded
    };
  }
  return null;
}

/**
 * Place a drawn tile at the chosen rotation and connect it to every adjacent
 * room whose door faces back. This is the missing geometric auto-link: a new
 * room is not only connected to the room it was explored from.
 */
export function connectAdjacentDoors(state: GameState, nodeId: string): number {
  const node = state.mapGraph.nodes[nodeId];
  const grid = nodeGrid(node);
  if (!node || !grid) return 0;
  const doors = (node.props.doors ?? []) as DoorDir[];
  let connected = 0;

  for (const dir of doors) {
    const [dc, dr] = doorDelta(dir);
    const neighbor = Object.values(state.mapGraph.nodes).find(other => {
      const otherGrid = nodeGrid(other);
      return (
        other.id !== nodeId &&
        otherGrid &&
        otherGrid.floor === grid.floor &&
        otherGrid.col === grid.col + dc &&
        otherGrid.row === grid.row + dr
      );
    });
    if (!neighbor) continue;
    const neighborDoors = (neighbor.props.doors ?? []) as DoorDir[];
    if (!neighborDoors.includes(opposite(dir))) continue;
    const already =
      node.neighbors.includes(neighbor.id) ||
      !!state.mapGraph.edges[`edge_${nodeId}_${neighbor.id}`] ||
      !!state.mapGraph.edges[`edge_${neighbor.id}_${nodeId}`];
    if (already) continue;
    const edgeId = connectRooms(state, nodeId, neighbor.id, 'DOOR', dir);
    const edge = state.mapGraph.edges[edgeId];
    if (edge) edge.ports = { from: dir, to: opposite(dir) };
    connected += 1;
  }
  return connected;
}

export function placeRoomCandidate(
  state: GameState,
  candidate: RoomPlacementCandidate,
  rotation: number
): { def: RoomDef; nodeId: string; connections: number } | null {
  if (!candidate.rotations.includes(rotation)) return null;
  const nodeId = `room_${candidate.def.id}`;
  if (state.mapGraph.nodes[nodeId]) return null;

  const placedDef: RoomDef = { ...candidate.def, floor: candidate.floor ?? candidate.def.floor };
  const node = addRoomNode(state, placedDef, candidate.col, candidate.row, rotation, nodeId);
  const entryEdge = connectRooms(state, candidate.fromRoomId, nodeId, 'DOOR', candidate.dir);
  const entry = state.mapGraph.edges[entryEdge];
  if (entry) entry.ports = { from: candidate.dir, to: opposite(candidate.dir) };
  const tile = state.entities[candidate.tileId];
  if (tile) {
    tile.visibility = { type: 'PUBLIC' };
    node.props.tileEntityId = candidate.tileId;
    commit(state, ECSManager.moveEntity(state, candidate.tileId, 'zone_room_placed'));
  }
  const connections = connectAdjacentDoors(state, nodeId);
  linkSpecialRooms(state);
  return { def: candidate.def, nodeId, connections };
}

/**
 * Legacy helper: draw + auto-place at the first legal rotation. New UI uses
 * drawRoomCandidate + PLACE_ROOM so the player chooses the orientation.
 */
export function exploreFromRoom(
  state: GameState,
  currentRoomId: string,
  dir: DoorDir,
  _ctx: ReduceContext
): RoomDrawResult {
  const candidate = drawRoomCandidate(state, currentRoomId, dir);
  if (!candidate) return { state, def: null, rotation: 0, discarded: [] };
  const rotation = candidate.rotations[0];
  const placed = placeRoomCandidate(state, candidate, rotation);
  if (!placed) return { state, def: null, rotation: 0, discarded: candidate.discarded };
  return {
    state,
    def: placed.def,
    rotation,
    nodeId: placed.nodeId,
    discarded: candidate.discarded
  };
}

/** Balcony/Gallery overlook the Ballroom; add the vertical shortcut. */
export function linkSpecialRooms(state: GameState): void {
  const balcony = Object.values(state.mapGraph.nodes).find(node => node.props?.special === 'BALCONY');
  const gallery = Object.values(state.mapGraph.nodes).find(node => node.props?.special === 'GALLERY');
  const ballroom = Object.values(state.mapGraph.nodes).find(node => node.props?.name === '舞厅');
  if (!ballroom) return;
  for (const node of [balcony, gallery]) {
    if (node && !node.neighbors.includes(ballroom.id)) {
      connectOneWay(state, node.id, ballroom.id, 'DROP', '俯瞰');
    }
  }
}

export function movePlayerTo(state: GameState, playerId: PlayerId, roomId: string): void {
  const player = state.players[playerId];
  const room = state.mapGraph.nodes[roomId];
  if (!player || !room) return;
  player.customProps.currentRoomId = roomId;
  player.customProps.floor = room.props.floor;
}

/**
 * Opponents sharing the room, used for the movement penalty.
 *
 * Rulebook, Moving Past Opponents: "for each opponent in a room with you, a Hero,
 * monster or Traitor must use one extra space of movement to leave that room.
 * Stunned monsters don't slow an explorer's move in this way."
 *
 * A hero's opponents are the traitor plus unstunned monsters. The traitor's
 * opponents are the heroes - the monsters are its allies, and counting them (as
 * this used to) made the traitor pay for standing next to its own minions.
 */
export function hostilesInRoom(state: GameState, playerId: PlayerId, roomId: string): number {
  const player = state.players[playerId];
  if (!player) return 0;
  const haunt = !!state.globalVars.hauntTriggered;
  if (!haunt) return 0;

  let count = 0;
  const others = Object.entries(state.players).filter(([id]) => id !== playerId);

  if (player.role === 'TRAITOR') {
    for (const [, other] of others) {
      if (!other.alive || other.role === 'TRAITOR' || other.customProps.banished) continue;
      if (other.customProps.currentRoomId === roomId) count += 1;
    }
    return count;
  }

  for (const monster of monstersInRoom(state, roomId)) {
    if (!monster.components.custom?.stunned) count += 1;
  }
  const traitor = others.find(([, other]) => other.role === 'TRAITOR' && other.alive)?.[1];
  if (traitor && !traitor.customProps.banished && traitor.customProps.currentRoomId === roomId) count += 1;
  return count;
}

export function movementCost(state: GameState, playerId: PlayerId, fromRoomId: string): number {
  const player = state.players[playerId];
  if (!player) return 1;
  return 1 + hostilesInRoom(state, playerId, fromRoomId);
}

/* -------------------------------------------------------------------------- */
/* Monsters                                                                    */
/* -------------------------------------------------------------------------- */

export function monsterEntities(state: GameState): Entity[] {
  return Object.values(state.entities).filter(entity => entity.components.custom?.monster);
}

/** The room a monster entity currently occupies (single source of truth). */
export function monsterRoomId(state: GameState, entityId: string): string {
  return String(state.entities[entityId]?.components.custom?.roomId ?? '');
}

export function monstersInRoom(state: GameState, roomId: string): Entity[] {
  return monsterEntities(state).filter(entity => entity.components.custom?.roomId === roomId && !entity.components.custom?.dead);
}

export function monsterStats(entity: Entity): { might: number; speed: number; sanity: number } {
  return {
    might: Number(entity.components.custom?.might ?? 1),
    speed: Number(entity.components.custom?.speed ?? 1),
    sanity: Number(entity.components.custom?.sanity ?? 1)
  };
}

export function spawnMonster(
  state: GameState,
  roomId: string,
  kind: string,
  stats: { name: string; might: number; speed: number; sanity: number; attack: 'PHYSICAL' | 'MENTAL'; control?: boolean; incorporeal?: boolean; immunePhysical?: boolean; immuneSpeedAttacks?: boolean; color: string },
  ctx: ReduceContext
): Entity {
  const room = state.mapGraph.nodes[roomId];
  const world = room
    ? gridToWorld(room.props.floor as Floor, Number(room.props.col), Number(room.props.row))
    : ([0, 0, 0] as [number, number, number]);
  const id = ctx.id(`monster_${kind.toLowerCase()}`);
  const entity: Entity = {
    id,
    type: 'MEEPLE',
    zoneId: 'zone_monsters',
    visibility: { type: 'PUBLIC' },
    components: {
      spatial: {
        x: world[0] + 0.7,
        y: 0.12,
        z: world[2] + 0.5
      },
      custom: {
        monster: kind,
        name: stats.name,
        might: stats.might,
        speed: stats.speed,
        sanity: stats.sanity,
        attack: stats.attack,
        control: !!stats.control,
        incorporeal: !!stats.incorporeal,
        immunePhysical: !!stats.immunePhysical,
        immuneSpeedAttacks: !!stats.immuneSpeedAttacks,
        stunned: false,
        roomId,
        color: stats.color,
        carryingGirl: false
      }
    }
  };
  const next = ECSManager.addEntity(state, entity);
  state.entities = next.entities;
  state.zones = next.zones;
  ensureRoomSlots(state, roomId);
  const placed = OccupancyIndex.place(state, id, monsterSlotId(roomId));
  if (placed.ok) state.entities = placed.state.entities;
  return state.entities[id];
}

export function moveMonster(state: GameState, entityId: string, roomId: string): void {
  const monster = state.entities[entityId];
  const room = state.mapGraph.nodes[roomId];
  if (!monster || !room) return;
  const world = gridToWorld(room.props.floor as Floor, Number(room.props.col), Number(room.props.row));
  monster.components.custom = { ...(monster.components.custom ?? {}), roomId };
  monster.components.spatial = {
    ...(monster.components.spatial ?? { x: 0, y: 0.12, z: 0 }),
    x: world[0] + 0.7,
    y: 0.12,
    z: world[2] + 0.5
  };
  ensureRoomSlots(state, roomId);
  const placed = OccupancyIndex.place(state, entityId, monsterSlotId(roomId));
  if (placed.ok) state.entities = placed.state.entities;
}

/* -------------------------------------------------------------------------- */
/* Line of sight (Revolver)                                                    */
/* -------------------------------------------------------------------------- */

export function sameFloorLine(state: GameState, fromRoomId: string, toRoomId: string): boolean {
  const from = state.mapGraph.nodes[fromRoomId];
  const to = state.mapGraph.nodes[toRoomId];
  const a = nodeGrid(from);
  const b = nodeGrid(to);
  if (!a || !b || a.floor !== b.floor) return false;
  if (a.col !== b.col && a.row !== b.row) return false;
  if (a.col === b.col && a.row === b.row) return true;

  const stepCol = Math.sign(b.col - a.col);
  const stepRow = Math.sign(b.row - a.row);
  let col = a.col + stepCol;
  let row = a.row + stepRow;
  while (col !== b.col || row !== b.row) {
    const occupied = Object.values(state.mapGraph.nodes).some(node => {
      const grid = nodeGrid(node);
      return grid && grid.floor === a.floor && grid.col === col && grid.row === row;
    });
    if (!occupied) return false;
    col += stepCol;
    row += stepRow;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Turn bookkeeping                                                            */
/* -------------------------------------------------------------------------- */

export function frostRooms(state: GameState): string[] {
  return (state.globalVars.frostRooms ?? []) as string[];
}

export function addFrost(state: GameState, roomId: string): void {
  const rooms = new Set(frostRooms(state));
  rooms.add(roomId);
  state.globalVars.frostRooms = [...rooms];
}

/**
 * Rulebook, Die Rolls: "You cannot try to make the same roll more than once per
 * turn." Optional checks are gated on this; automatic room effects are not, since
 * the player is not choosing to re-roll there.
 */
export function hasRolledThisTurn(state: GameState, playerId: PlayerId, reason: string): boolean {
  const player = state.players[playerId];
  if (!player) return false;
  return ((player.customProps.rolledThisTurn as string[]) ?? []).includes(reason);
}

export function resetTurnResources(state: GameState, playerId: PlayerId): void {
  const player = state.players[playerId];
  if (!player) return;
  const frozen = frostRooms(state).includes(player.customProps.currentRoomId);
  const speed = traitValue(player, 'speed');

  // Official rule (Betrayal 2nd ed, Moving): "Move up to a number of spaces equal
  // to your current Speed." No dice are rolled for movement. Frost is a module
  // effect that halves it.
  player.customProps.movesLeft = frozen ? Math.max(1, Math.floor(speed / 2)) : speed;
  player.customProps.attacksLeft = state.globalVars.hauntTriggered ? 1 : 0;
  player.customProps.usedItems = [];
  player.customProps.checkBonus = 0;
  player.customProps.forcedRoll = undefined;
  player.customProps.movesUsed = 0;
  player.customProps.skipActions = false;
  // Rulebook, Die Rolls: "You cannot try to make the same roll more than once per
  // turn." This holds the check reasons already attempted this turn.
  player.customProps.rolledThisTurn = [];
}

export function nextEligiblePlayer(state: GameState, fromId: PlayerId): PlayerId {
  const order = state.playerOrder;
  const start = Math.max(0, order.indexOf(fromId));
  for (let i = 1; i <= order.length; i++) {
    const candidate = order[(start + i) % order.length];
    const player = state.players[candidate];
    if (!player || !player.alive) continue;
    // A banished traitor (the Floating Eye haunt) keeps a turn slot purely to
    // run the monster phase, but cannot act as a body.
    if (player.customProps.banished && player.role !== 'TRAITOR') continue;
    return candidate;
  }
  return state.activePlayerId;
}

export function leftOf(state: GameState, playerId: PlayerId): PlayerId {
  return nextEligiblePlayer(state, playerId);
}

export function heroesOf(state: GameState): PlayerId[] {
  return state.playerOrder.filter(id => state.players[id]?.alive && state.players[id]?.role !== 'TRAITOR' && !state.players[id]?.customProps.banished);
}

export function traitorOf(state: GameState): PlayerId | null {
  const traitor = Object.values(state.players).find(player => player.role === 'TRAITOR');
  return traitor?.id ?? null;
}

/* -------------------------------------------------------------------------- */
/* Deck helpers                                                                */
/* -------------------------------------------------------------------------- */

export function shuffledDefs(seed: number, ids: string[]): { seed: number; ids: string[] } {
  const result = DeterministicPRNG.shuffle(seed, ids);
  return { seed: result.nextSeed, ids: result.result };
}

export function defName(defId: string): string {
  return OMEN_DEFS[defId]?.name ?? ITEM_DEFS[defId]?.name ?? EVENT_DEFS[defId]?.name ?? defId;
}

export function weaponOptions(state: GameState, playerId: PlayerId): { value: string; label: string }[] {
  const options = [{ value: 'fists', label: '徒手（力量）' }];
  for (const entity of handEntities(state, playerId)) {
    const defId = cardDef(entity);
    const spec = WEAPON_SPECS[defId];
    if (spec) options.push({ value: defId, label: spec.name });
  }
  return options;
}

export function attackDiceFor(player: { customProps: Record<string, any> }, weaponId: string): number {
  const spec = WEAPON_SPECS[weaponId] ?? WEAPON_SPECS.fists;
  const trait = spec.trait;
  const base = traitValue(player, trait as TraitKey);
  return Math.min(MAX_ATTACK_DICE, Math.max(1, base + spec.dice));
}

export function actionFields(fields: Action['fields']): Action['fields'] {
  return fields;
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                        */
/* -------------------------------------------------------------------------- */

export function roomName(state: GameState, roomId: string | undefined): string {
  if (!roomId) return '未知房间';
  return state.mapGraph.nodes[roomId]?.props?.name ?? roomId;
}

export function floorName(state: GameState, roomId: string | undefined): string {
  const floor = state.mapGraph.nodes[roomId ?? '']?.props?.floor as Floor | undefined;
  return floor ? FLOOR_META[floor].zh : '未知楼层';
}

export function allExploredRooms(state: GameState): MapGraphNode[] {
  return Object.values(state.mapGraph.nodes).filter(node => node.type === 'ROOM');
}

export function actionLogLine(state: GameState, text: string): void {
  state.globalVars.lastNarration = text;
}

export interface HauntState {
  id: string;
  number: number;
  title: string;
  traitorId: PlayerId;
  revealRoomId: string;
  monsterIds: string[];
  progress: number;
  girlHolder?: string;
  bonesFound?: boolean;
  beaconDestroyed?: boolean;
  eyesDestroyed?: number;
  mummyDelivered?: boolean;
}

export function currentHaunt(state: GameState): HauntState | null {
  return (state.globalVars.haunt as HauntState | null | undefined) ?? null;
}

export function grantScenarioItem(
  state: GameState,
  playerId: PlayerId,
  defId: string,
  meta: { name: string; en: string; desc: string; kind?: 'weapon' | 'relic' | 'armor' | 'consumable' | 'tool' }
): Entity {
  const entity = makeCardEntity(
    `scenario_item_${playerId}_${defId}_${(state.seq ?? 0).toString(36)}`,
    `zone_hand_${playerId}`,
    defId,
    'ITEM',
    { name: meta.name, en: meta.en, desc: meta.desc },
    { tradeable: true, charges: 0, kind: meta.kind ?? 'relic', stealable: true }
  );
  entity.visibility = { type: 'PUBLIC' };
  entity.ownerId = playerId;
  const next = ECSManager.addEntity(state, entity);
  state.entities = next.entities;
  state.zones = next.zones;
  return state.entities[entity.id];
}

