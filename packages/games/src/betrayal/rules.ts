/**
 * Betrayal at House on the Hill — reducer and legality.
 *
 * The module owns every game rule; the kernel only schedules actions,
 * decisions, interrupts, projections and replay. Scenario state lives in
 * `globalVars.haunt`, monsters are ordinary MEEPLE entities and every random
 * draw goes through the kernel PRNG so logs replay bit-exactly.
 */

import { openDecision } from '@rds/kernel/decisions';
import { ECSManager } from '@rds/kernel/ecs';
import { OccupancyIndex } from '@rds/kernel/occupancy';
import { ReduceContext } from '@rds/kernel/module';
import { DeterministicPRNG } from '@rds/kernel/prng';
import { RollWindowManager } from '@rds/kernel/rollWindow';
import { InterruptStackManager } from '@rds/kernel/stack';
import { Action, DecisionWindow, Entity, GameState, PlayerId, StackFrame } from '@rds/kernel/types';
import {
  EVENT_DEFS,
  EventEffect,
  Floor,
  FLOOR_META,
  ITEM_DEFS,
  OMEN_DEFS,
  ROOM_DEFS,
  TraitKey,
  TRAIT_KEYS,
  TRAIT_META,
  WEAPON_SPECS,
  ONGOING_META
} from './cards';
import { HAUNT_DEFS, resolveHauntId } from './haunts';
import { BETRAYAL_SPATIAL } from './spatial';
import {
  actionLogLine,
  addEffect,
  addFrost,
  applyItemGain,
  applyItemLoss,
  applyOmenGain,
  applyOmenLoss,
  applyTraitSteps,
  attackDiceFor,
  cardDef,
  currentHaunt,
  damagePlayer,
  discardCard,
  drawCardTo,
  drawRoomCandidate,
  ensureRoomZone,
  findHandEntity,
  grantScenarioItem,
  gridToWorld,
  itemSlotId,
  handEntities,
  heroesOf,
  hostilesInRoom,
  itemLabel,
  killPlayer,
  leftOf,
  linkSpecialRooms,
  markUsed,
  monsterEntities,
  monsterRoomId,
  monsterStats,
  monstersInRoom,
  moveMonster,
  movePlayerTo,
  movementCost,
  nextEligiblePlayer,
  nodeGrid,
  ongoingEffectKinds,
  ownsDef,
  placeRoomCandidate,
  resetTurnResources,
  rollTraitCheck,
  rollZeroDice,
  roomName,
  sameFloorLine,
  spawnMonster,
  takeTopCard,
  tradeable,
  traitorOf,
  traitIndex,
  traitValue,
  usedThisTurn,
  weaponOptions,
  addRoomNode,
  connectRooms,
  validRotations,
  hasRolledThisTurn,
  removeEffects
} from './helpers';

/**
 * Rooms that charge a roll to LEAVE.
 *
 * Rulebook, Special Rooms: Attic, Graveyard, Junk Room and Pentagram Chamber say
 * "if an explorer fails his roll, he may choose to stay in the room and try again
 * on his next turn instead of taking damage". The check therefore gates movement
 * out of the room, not the end of the turn.
 */
const EXIT_CHECKS: Record<
  string,
  { trait: TraitKey; threshold: number; penalty: TraitKey; amount: number; reason: string }
> = {
  attic: { trait: 'speed', threshold: 3, penalty: 'might', amount: 1, reason: 'attic exit' },
  graveyard: { trait: 'sanity', threshold: 4, penalty: 'knowledge', amount: 1, reason: 'graveyard exit' },
  junk_room: { trait: 'might', threshold: 3, penalty: 'speed', amount: 1, reason: 'junk room exit' },
  pentagram_chamber: {
    trait: 'knowledge',
    threshold: 4,
    penalty: 'sanity',
    amount: 1,
    reason: 'pentagram chamber exit'
  }
};

const TRAIT_OPTIONS: Record<'PHYSICAL' | 'MENTAL', { value: TraitKey; label: string }[]> = {
  PHYSICAL: [
    { value: 'might', label: '力量' },
    { value: 'speed', label: '速度' }
  ],
  MENTAL: [
    { value: 'sanity', label: '神智' },
    { value: 'knowledge', label: '知识' }
  ]
};

const STEAL_OPTIONS = [
  { value: 'no', label: '正常造成伤害' },
  { value: 'yes', label: '伤害 ≥ 2 时改为偷窃' }
];

const TRAIT_OPTIONS_KEYS = TRAIT_KEYS;

function trace(
  ctx: ReduceContext,
  type: Parameters<ReduceContext['trace']>[0]['type'],
  title: string,
  durationMs = 400
): void {
  ctx.trace({ id: ctx.id('evt'), type, title, durationMs });
}

function activeRoom(state: GameState, playerId: PlayerId): string {
  return String(state.players[playerId]?.customProps.currentRoomId ?? '');
}

/**
 * Human label for a check-window option id.
 *
 * The kernel only carries opaque ids; the presentation layer must not import
 * game content, so the module ships the display name inside the action payload.
 */
function checkOptionLabel(option: string): string {
  const def = ITEM_DEFS[option as keyof typeof ITEM_DEFS];
  return def?.name ?? option;
}

function roomTags(state: GameState, roomId: string): string[] {
  const tags = state.mapGraph.nodes[roomId]?.props?.tags;
  return Array.isArray(tags) ? tags : [];
}

function playersInRoom(state: GameState, roomId: string, excludeId?: PlayerId): PlayerId[] {
  return state.playerOrder.filter(pid => {
    const player = state.players[pid];
    return pid !== excludeId && player?.alive && !player.customProps.banished && player.customProps.currentRoomId === roomId;
  });
}

function exploredRooms(state: GameState): string[] {
  return Object.values(state.mapGraph.nodes)
    .filter(node => node.type === 'ROOM')
    .map(node => node.id);
}

function randomRoom(state: GameState): string {
  const rooms = exploredRooms(state);
  if (rooms.length === 0) return '';
  const roll = DeterministicPRNG.nextInt(state.prngState, 0, rooms.length - 1);
  state.prngState = roll.nextSeed;
  return rooms[roll.value];
}

function heroFaction(state: GameState, playerId: PlayerId): boolean {
  return state.players[playerId]?.role !== 'TRAITOR';
}

function isHostile(state: GameState, playerId: PlayerId, targetId: PlayerId): boolean {
  return heroFaction(state, playerId) !== heroFaction(state, targetId);
}

function isStealable(entity: Entity | undefined): boolean {
  return (
    !!entity &&
    tradeable(entity) &&
    !entity.components.custom?.companion &&
    entity.components.custom?.stealable !== false
  );
}

function hasStealableItem(state: GameState, playerId: PlayerId): boolean {
  return handEntities(state, playerId).some(entity => isStealable(entity));
}

function cardName(state: GameState, entityId: string): string {
  return itemLabel(state.entities[entityId]);
}

/* -------------------------------------------------------------------------- */
/* Legality                                                                    */
/* -------------------------------------------------------------------------- */

export class BetrayalRules {
  public static getLegalActions(state: GameState, actorId: PlayerId): Action[] {
    if (state.gameOver) return [];

    // 0a. A two-phase check window gates everything else: whoever is entitled
    //     to declare/re-act must finish it before the table moves on.
    const rollWindow = RollWindowManager.current(state);
    if (rollWindow) {
      const inPhase = RollWindowManager.actorsFor(rollWindow).includes(actorId);
      const acts: Action[] = [];
      if (inPhase) {
        for (const option of RollWindowManager.optionsFor(rollWindow, actorId)) {
          acts.push({
            type: rollWindow.phase === 'DECLARE' ? 'DECLARE_CHECK' : 'CHECK_REACTION',
            playerId: actorId,
            payload: { windowId: rollWindow.id, option, label: checkOptionLabel(option) }
          });
        }
      }
      // Rolling is only offered while the declare phase is open.
      if (rollWindow.phase === 'DECLARE') {
        acts.push({ type: 'ROLL_CHECK', playerId: rollWindow.actorId, payload: { windowId: rollWindow.id } });
      }
      // Resolving is always legal so a window can never deadlock the table.
      acts.push({ type: 'RESOLVE_CHECK', playerId: rollWindow.actorId, payload: { windowId: rollWindow.id } });
      return acts;
    }

    const npc = state.npcs?.[actorId];
    if (npc) return this.getNpcLegalActions(state, npc);
    const player = state.players[actorId];
    if (!player) return [];
    const playerId = actorId;
    if (!player.alive) {
      return state.activePlayerId === actorId ? [{ type: 'END_TURN', playerId: actorId }] : [];
    }

    /* 0. A drawn room tile awaits orientation ------------------------- */
    const pending = state.globalVars.pendingRoomPlacement as
      | { playerId: string; rotations: number[]; defId: string }
      | undefined;
    if (pending) {
      if (pending.playerId !== playerId) return [];
      return [
        {
          type: 'PLACE_ROOM',
          playerId,
          payload: { defName: ROOM_DEFS[pending.defId]?.name ?? pending.defId },
          fields: [
            {
              key: 'rotation',
              label: '房间朝向',
              kind: 'enum',
              required: true,
              default: String(pending.rotations[0] ?? 0),
              options: pending.rotations.map(rotation => ({
                value: String(rotation),
                label: `${rotation * 90}°`
              }))
            }
          ]
        }
      ];
    }

    /* 1. Open decision window ------------------------------------------- */
    const window = [...state.pendingDecisions].reverse().find(entry => entry.status === 'OPEN');
    if (window) {
      if (!window.participants.includes(playerId) || window.submissions[playerId] !== undefined) return [];
      if (window.payload?.kind === 'damage') {
        const kind = window.payload.damageKind === 'MENTAL' ? 'MENTAL' : 'PHYSICAL';
        return [
          {
            type: 'ALLOCATE_DAMAGE',
            playerId,
            fields: [
              {
                key: 'trait',
                label: '承受伤害的属性',
                kind: 'enum',
                options: TRAIT_OPTIONS[kind],
                default: TRAIT_OPTIONS[kind][0].value
              }
            ]
          }
        ];
      }
      if (window.payload?.kind === 'trade') {
        const offer = state.globalVars.tradeOffer as
          | { from: PlayerId; giveEntityId: string; wantEntityId: string }
          | null
          | undefined;
        const actions: Action[] = [{ type: 'REJECT_TRADE', playerId }];
        if (offer) {
          const canAccept =
            offer.wantEntityId === '' ||
            (state.entities[offer.wantEntityId]?.ownerId === playerId &&
              handEntities(state, playerId).some(entity => entity.id === offer.wantEntityId));
          if (canAccept) actions.unshift({ type: 'ACCEPT_TRADE', playerId });
        }
        return actions;
      }
      if (window.payload?.kind === 'peek') {
        return [
          { type: 'PEEK_TOP', playerId },
          { type: 'PEEK_BOTTOM', playerId }
        ];
      }
      return [];
    }

    /* 2. Interrupt-stack response window --------------------------------- */
    const frame = InterruptStackManager.peek(state);
    if (frame && frame.status === 'WAITING_INPUT' && frame.responseWindow) {
      if (!frame.responseWindow.eligiblePlayers.includes(playerId)) return [];
      if (frame.type === 'HAUNT_CHECK') return [{ type: 'ROLL_HAUNT_CHECK', playerId }];
      return [];
    }

    /* 3. Turn ownership --------------------------------------------------- */
    if ((state.activeActorId ?? state.activePlayerId) !== playerId) return [];
    if (player.customProps.banished) {
      return player.role === 'TRAITOR' ? [{ type: 'END_TURN', playerId }] : [];
    }
    if (player.customProps.controlled) {
      return [{ type: 'END_TURN', playerId }];
    }

    const actions: Action[] = [];
    const roomId = activeRoom(state, playerId);
    const room = state.mapGraph.nodes[roomId];
    const movesLeft = Number(player.customProps.movesLeft ?? 0);

    if (player.customProps.skipActions) {
      actions.push({ type: 'END_TURN', playerId });
      return actions;
    }

    // A failed exit roll leaves the explorer with the rulebook's choice: stay and
    // retry next turn, or take the penalty and leave.
    const pendingExit = state.globalVars.pendingExit as
      | { playerId: PlayerId; roomId: string; penalty: TraitKey; amount: number }
      | null
      | undefined;
    if (pendingExit && pendingExit.playerId === playerId) {
      return [
        { type: 'EXIT_STAY', playerId },
        { type: 'EXIT_PAY', playerId }
      ];
    }

    /* 4. Movement --------------------------------------------------------- */
    const exitCheck = EXIT_CHECKS[String(roomId.replace(/^room_/, ''))];
    const exitBlocked =
      !!exitCheck &&
      player.role !== 'TRAITOR' &&
      String(player.customProps.exitPassedRoom ?? '') !== roomId;
    if (exitBlocked && movesLeft > 0) {
      // You cannot simply walk out: try the roll first. Everything else the room
      // offers (scenario actions, item use, …) stays available.
      actions.push({ type: 'ROOM_EXIT_CHECK', playerId });
    }

    if (movesLeft > 0 && room && !exitBlocked) {
      const reachable = room.neighbors.filter(neighbor => movementCost(state, playerId, roomId) <= movesLeft);
      if (reachable.length > 0) {
        actions.push({
          type: 'MOVE_TO_ROOM',
          playerId,
          selection: { source: 'node', scope: { neighbors: reachable }, min: 1, max: 1 }
        });
      }

      const doors = (room.props.doors ?? []) as ('N' | 'S' | 'E' | 'W')[];
      for (const dir of doors) {
        const offset = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }[dir];
        const grid = nodeGrid(room);
        if (!grid) continue;
        const col = grid.col + offset[0];
        const row = grid.row + offset[1];
        const occupied = Object.values(state.mapGraph.nodes).some(node => {
          const other = nodeGrid(node);
          return other && other.floor === grid.floor && other.col === col && other.row === row;
        });
        if (occupied) continue;

        // Official rule: the front door is always locked unless a haunt says
        // otherwise. It is the only doorway that leads out of the house.
        const isFrontDoor =
          room.props.special === 'FRONT_DOOR' && room.props.frontDoor === dir;
        if (isFrontDoor && state.globalVars.frontDoorLocked !== false) {
          actions.push({ type: 'TRY_FRONT_DOOR', playerId });
          continue;
        }

        actions.push({ type: 'EXPLORE_DOOR', playerId, payload: { direction: dir } });
      }

      // Riding the elevator is two steps: roll first, then choose where it stops.
      if (
        room.props.special === 'ELEVATOR' &&
        !player.customProps.elevatorUsed &&
        !ownsDef(state, playerId, 'dog')
      ) {
        actions.push({ type: 'USE_ELEVATOR', playerId });
      }

      // A finished roll opens the destination picker, limited by the dice.
      const ride = state.globalVars.elevatorRide as
        | { sum: number; fromFloor: string; allowSameFloorOnly: boolean }
        | null
        | undefined;
      if (room.props.special === 'ELEVATOR' && ride && ride.sum >= 2) {
        const targets = exploredRooms(state).filter(other => {
          if (other === roomId) return false;
          if (!ride.allowSameFloorOnly) return true;
          return String(state.mapGraph.nodes[other]?.props?.floor ?? '') === ride.fromFloor;
        });

        // One action per EMPTY DOORWAY, not per room: the doorway decides both
        // where the car lands and which way its single door faces, exactly like
        // placing a drawn room tile.
        const DOOR_OFFSET: Record<string, [number, number]> = {
          N: [0, -1],
          S: [0, 1],
          E: [1, 0],
          W: [-1, 0]
        };
        for (const target of targets) {
          const targetNode = state.mapGraph.nodes[target];
          const grid = nodeGrid(targetNode);
          if (!grid) continue;
          for (const dir of (targetNode.props?.doors ?? []) as string[]) {
            const offset = DOOR_OFFSET[dir];
            if (!offset) continue;
            const col = grid.col + offset[0];
            const row = grid.row + offset[1];
            const taken = Object.values(state.mapGraph.nodes).some(node => {
              if (node.type !== 'ROOM' || node.id === roomId) return false;
              const other = nodeGrid(node);
              return !!other && other.floor === grid.floor && other.col === col && other.row === row;
            });
            if (taken) continue;
            actions.push({
              type: 'ELEVATOR_MOVE',
              playerId,
              targetNodeId: target,
              payload: { direction: dir }
            });
          }
        }
      }

      if (room.props.special === 'BALCONY' || room.props.special === 'GALLERY') {
        const ballroom = Object.values(state.mapGraph.nodes).find(node => node.props?.name === '舞厅');
        if (ballroom && room.neighbors.includes(ballroom.id)) {
          actions.push({ type: 'JUMP_DOWN', playerId });
        }
      }

      if (ownsDef(state, playerId, 'rope')) {
        for (const edge of Object.values(state.mapGraph.edges)) {
          if (edge.type !== 'DROP' || edge.to !== roomId || !edge.props?.oneWay) continue;
          actions.push({ type: 'CLIMB_UP', playerId, targetNodeId: edge.from });
        }
      }

      // Optional room features the player can poke at instead of them firing
      // silently on entry. Only the vault is genuinely re-enterable.
      if (
        room.props.special === 'VAULT' &&
        !room.props?.opened &&
        !hasRolledThisTurn(state, playerId, 'vault')
      ) {
        actions.push({ type: 'ROOM_FEATURE', playerId, payload: { feature: 'VAULT' } });
      }
    }

    /* 5. Items, pickups, trade, dog -------------------------------------- */
    const hand = handEntities(state, playerId);
    for (const entity of hand) {
      const defId = cardDef(entity);
      const def = ITEM_DEFS[defId] ?? OMEN_DEFS[defId];
      if (!def || entity.components.custom?.cardType === 'EVENT') continue;

      const companion = !!entity.components.custom?.companion;
      const usable = 'usable' in def ? !!def.usable : false;
      if (usable && !usedThisTurn(state, playerId, defId)) {
        const fields = this.itemFields(state, playerId, defId);
        actions.push(fields && fields.length > 0
          ? { type: 'USE_ITEM', playerId, entityId: entity.id, fields }
          : { type: 'USE_ITEM', playerId, entityId: entity.id });
      }

      // Dropping only excludes companions; non-tradable items may still be dropped.
      if (!companion) {
        actions.push({ type: 'DROP_ITEM', playerId, entityId: entity.id });
        // Generic slot command, kept alongside the legacy drop action for old logs.
        actions.push({
          type: 'PLACE_ENTITY',
          playerId,
          actorId: playerId,
          entityId: entity.id,
          targetSlotId: itemSlotId(roomId)
        });
      }
    }

    const roomZone = state.zones[`zone_room_${roomId}`];
    for (const entityId of roomZone?.orderedEntities ?? []) {
      if (state.entities[entityId]?.components.custom?.marker) continue;
      actions.push({ type: 'PICK_UP_ITEM', playerId, entityId });
    }

    const others = playersInRoom(state, roomId, playerId);
    if (others.length > 0 && hand.some(entity => tradeable(entity) && !entity.components.custom?.companion)) {
      const giveOptions = hand
        .filter(entity => tradeable(entity) && !entity.components.custom?.companion)
        .map(entity => ({ value: entity.id, label: itemLabel(entity) }));
      const wantOptions: { value: string; label: string }[] = [{ value: '', label: '无条件赠予' }];
      for (const otherId of others) {
        for (const entity of handEntities(state, otherId)) {
          if (!tradeable(entity) || entity.components.custom?.companion) continue;
          wantOptions.push({ value: entity.id, label: `${itemLabel(entity)} · ${state.players[otherId].name}` });
        }
      }
      actions.push({
        type: 'PROPOSE_ITEM_TRADE',
        playerId,
        fields: [
          { key: 'give', label: '你付出', kind: 'enum', options: giveOptions, default: giveOptions[0]?.value },
          {
            key: 'want',
            label: '你索取',
            kind: 'enum',
            options: wantOptions,
            default: wantOptions[0]?.value
          }
        ]
      });
    }

    /* 6. Combat ----------------------------------------------------------- */
    const attacksLeft = Number(player.customProps.attacksLeft ?? 0);
    if (state.globalVars.hauntTriggered && attacksLeft > 0) {
      const weapons = weaponOptions(state, playerId);
      for (const otherId of state.playerOrder) {
        const other = state.players[otherId];
        if (otherId === playerId || !other?.alive || other.customProps.banished) continue;
        if (!isHostile(state, playerId, otherId)) continue;
        const targetRoom = activeRoom(state, otherId);
        const options = weapons.filter(option => {
          const spec = WEAPON_SPECS[option.value];
          if (!spec) return false;
          if (targetRoom === roomId) return true;
          return !!spec.ranged && sameFloorLine(state, roomId, targetRoom);
        });
        if (options.length === 0) continue;
        actions.push({
          type: 'ATTACK_PLAYER',
          playerId,
          targetPlayerId: otherId,
          fields: [
            { key: 'weapon', label: '武器', kind: 'enum', options, default: options[0].value },
            { key: 'steal', label: '偷窃', kind: 'enum', options: STEAL_OPTIONS, default: 'no' }
          ]
        });
      }

      for (const monster of monsterEntities(state)) {
        const custom = monster.components.custom ?? {};
        if (custom.destroyed) continue;
        const monsterRoom = String(custom.roomId ?? '');
        const options = weapons.filter(option => {
          const spec = WEAPON_SPECS[option.value];
          if (!spec) return false;
          if (monsterRoom === roomId) return true;
          return !!spec.ranged && sameFloorLine(state, roomId, monsterRoom);
        });
        if (options.length === 0) continue;
        actions.push({
          type: 'ATTACK_MONSTER',
          playerId,
          entityId: monster.id,
          fields: [{ key: 'weapon', label: '武器', kind: 'enum', options, default: options[0].value }]
        });
      }

      if (currentHaunt(state)?.id === 'floating_eye') {
        for (const otherId of playersInRoom(state, roomId, playerId)) {
          if (state.players[otherId].customProps.controlled) {
            actions.push({ type: 'SLAP', playerId, targetPlayerId: otherId });
          }
        }
      }
    }

    /* 7. Scenario actions -------------------------------------------------- */
    const haunt = currentHaunt(state);
    if (haunt) {
      if (haunt.id === 'mummy' && roomId === haunt.revealRoomId && haunt.progress < 2) {
        if (ownsDef(state, playerId, 'holy_symbol') || ownsDef(state, playerId, 'ring')) {
          if (!player.customProps.ritualUsed) actions.push({ type: 'SEAL_RITUAL', playerId });
        }
      }
      if (haunt.id === 'phantom') {
        if (!haunt.bonesFound && room?.props?.floor === 'BASEMENT' && !player.customProps.searchUsed) {
          actions.push({ type: 'SEARCH_BONES', playerId });
        }
        const atPentagram = room?.props?.special === null && roomTags(state, roomId).includes('pentagram');
        if (atPentagram && haunt.bonesFound && ownsDef(state, playerId, 'holy_symbol') && !player.customProps.chantUsed) {
          actions.push({ type: 'CHANT', playerId });
        }
      }
      if (haunt.id === 'floating_eye' && roomId === haunt.revealRoomId && !haunt.beaconDestroyed) {
        const eyesLeft = monsterEntities(state).filter(
          monster => monster.components.custom?.monster === 'EYE' && !monster.components.custom?.destroyed
        );
        if (eyesLeft.length === 0) actions.push({ type: 'DESTROY_BEACON', playerId });
      }
      if (haunt.id === 'living_dead') {
        const hasHolyWater = ownsDef(state, playerId, 'holy_water') || ownsDef(state, playerId, 'holy_symbol');
        const tags = roomTags(state, roomId);
        if (!hasHolyWater && (tags.includes('science') || tags.includes('food') || roomId.includes('laboratory') || roomId.includes('kitchen'))) {
          if (!player.customProps.brewUsed) actions.push({ type: 'BREW_HOLY_WATER', playerId });
        }
        const atSanctuary = tags.includes('pentagram') || roomId.includes('chapel');
        if (atSanctuary && hasHolyWater && !player.customProps.sanctifyUsed) {
          actions.push({ type: 'SANCTIFY_HOUSE', playerId });
        }
      }
      if (haunt.id === 'werewolf') {
        const tags = roomTags(state, roomId);
        if (tags.includes('science') || tags.includes('tools') || roomId.includes('workshop')) {
          if (!player.customProps.forgeUsed) actions.push({ type: 'FORGE_SILVER', playerId });
        }
        if (roomId.includes('observatory') || roomId.includes('tower') || tags.includes('high')) {
          if (!player.customProps.suppressUsed) actions.push({ type: 'SUPPRESS_CURSE', playerId });
        }
      }
    }

    actions.push({ type: 'END_TURN', playerId });
    return actions;
  }

  private static getNpcLegalActions(state: GameState, npc: NonNullable<GameState['npcs']>[string]): Action[] {
    if (state.gameOver) return [];
    if ((state.activeActorId ?? state.activePlayerId) !== npc.id) return [];
    if (npc.status !== 'ACTIVE') return [];

    const entity = npc.entityId ? state.entities[npc.entityId] : undefined;
    const custom = entity?.components.custom ?? {};
    if (!entity || custom.destroyed) return [];
    // Rulebook, Death and Stuns: a stunned monster "can't slow an explorer's
    // movement, but a Traitor may still move the monster". So it keeps its moves
    // and loses only its attacks; it flips back at the end of its turn.
    const stunned = !!custom.stunned;

    const roomId = String(custom.roomId ?? '');
    const actions: Action[] = [];
    if (Number(npc.customProps.movesLeft ?? 0) > 0) {
      for (const target of BETRAYAL_SPATIAL.neighbors(state, roomId, npc.id)) {
        actions.push({ type: 'MOVE_NPC', playerId: npc.id, actorId: npc.id, targetNodeId: target });
      }
    }
    if (!stunned && Number(npc.customProps.attacksLeft ?? 0) > 0) {
      for (const targetId of playersInRoom(state, roomId)) {
        if (state.players[targetId].role === 'TRAITOR') continue;
        actions.push({ type: 'ATTACK_HERO', playerId: npc.id, actorId: npc.id, targetPlayerId: targetId });
      }
    }
    actions.push({ type: 'END_NPC_TURN', playerId: npc.id, actorId: npc.id });
    return actions;
  }

  private static moveNpc(state: GameState, npcId: string, targetRoomId: string, ctx: ReduceContext): void {
    const npc = state.npcs?.[npcId];
    if (!npc || npc.status !== 'ACTIVE' || !npc.entityId) return;
    if ((state.activeActorId ?? state.activePlayerId) !== npcId) return;
    if (Number(npc.customProps.movesLeft ?? 0) <= 0) return;

    // The monster entity is the single source of truth for the occupied room.
    // Reading `npc.customProps.roomId` here used to return '' (that field was
    // never initialised), so every NPC move silently no-oped while the kernel
    // still reported success — the traitor clicked "怪物移动" and nothing moved.
    const fromRoomId = monsterRoomId(state, npc.entityId);
    if (!fromRoomId) return;
    if (!BETRAYAL_SPATIAL.neighbors(state, fromRoomId, npc.id).includes(targetRoomId)) return;

    moveMonster(state, npc.entityId, targetRoomId);
    npc.customProps.movesLeft = Number(npc.customProps.movesLeft) - 1;
    // Mirror the entity room onto the NPC record so the renderer's actor
    // lookups (nav arrows, camera follow) resolve for monsters exactly as they
    // do for players.
    npc.customProps.roomId = targetRoomId;
    const entity = state.entities[npc.entityId];
    const custom = entity?.components.custom ?? {};
    if (custom.monster === 'PHANTOM') addFrost(state, targetRoomId);

    if (custom.monster === 'MUMMY' && !custom.carryingGirl) {
      const zone = state.zones[`zone_room_${targetRoomId}`];
      const girl = (zone?.orderedEntities ?? [])
        .map(id => state.entities[id])
        .find(entity2 => entity2 && cardDef(entity2) === 'girl');
      if (girl) {
        custom.carryingGirl = true;
        const haunt = currentHaunt(state);
        if (haunt) haunt.girlHolder = npcId;
        girl.ownerId = undefined;
        const next = ECSManager.moveEntity(state, girl.id, 'zone_monsters');
        state.entities = next.entities;
        state.zones = next.zones;
        trace(ctx, 'RULE_MUTATE', '木乃伊从物品堆中抱起了小女孩', 800);
      }
    }

    trace(ctx, 'MOVE_OBJECT', `${npc.name} 移动至 ${roomName(state, targetRoomId)}`, 500);
  }

  private static npcAttack(state: GameState, npcId: string, targetId: string, ctx: ReduceContext): void {
    const npc = state.npcs?.[npcId];
    if (!npc || npc.status !== 'ACTIVE' || !npc.entityId) return;
    if ((state.activeActorId ?? state.activePlayerId) !== npcId) return;
    if (Number(npc.customProps.attacksLeft ?? 0) <= 0) return;

    const entity = state.entities[npc.entityId];
    const target = state.players[targetId];
    if (!entity || !target?.alive) return;
    if (String(entity.components.custom?.roomId ?? '') !== String(target.customProps.currentRoomId ?? '')) return;
    if (target.role === 'TRAITOR') return;

    npc.customProps.attacksLeft = Math.max(0, Number(npc.customProps.attacksLeft) - 1);
    this.monsterAttack(state, entity, targetId, ctx);
  }

  private static itemFields(state: GameState, playerId: PlayerId, defId: string): Action['fields'] {
    const roomId = activeRoom(state, playerId);
    const roommates = [playerId, ...playersInRoom(state, roomId, playerId)];

    switch (defId) {
      case 'adrenaline_shot':
        return [
          {
            key: 'mode',
            label: '使用方式',
            kind: 'enum',
            options: [
              { value: 'check', label: '本次检定 +4' },
              { value: 'move', label: '本回合移动 +4' }
            ],
            default: 'check'
          }
        ];
      case 'angel_feather':
        return [{ key: 'value', label: '指定骰点 (0–8)', kind: 'number', min: 0, max: 8, step: 1, default: 8 }];
      case 'crystal_ball':
        return [
          {
            key: 'deck',
            label: '窥视牌堆',
            kind: 'enum',
            options: [
              { value: 'zone_event_deck', label: '事件牌堆' },
              { value: 'zone_item_deck', label: '物品牌堆' }
            ],
            default: 'zone_event_deck'
          }
        ];
      case 'healing_salve':
        return [
          {
            key: 'trait',
            label: '恢复的肉体属性',
            kind: 'enum',
            options: [
              { value: 'might', label: '力量' },
              { value: 'speed', label: '速度' }
            ],
            default: 'might'
          }
        ];
      case 'smelling_salts':
        return [
          {
            key: 'trait',
            label: '恢复的精神属性',
            kind: 'enum',
            options: [
              { value: 'sanity', label: '神智' },
              { value: 'knowledge', label: '知识' }
            ],
            default: 'sanity'
          }
        ];
      case 'medical_kit':
        // "恢复 X 点肉体": 肉体 covers both physical tracks, so the healer picks
        // which one to restore — same contract as 治疗药膏.
        return [
          {
            key: 'target',
            label: '目标',
            kind: 'enum',
            options: roommates.map(id => ({ value: id, label: state.players[id].name })),
            default: playerId
          },
          {
            key: 'trait',
            label: '恢复的肉体属性',
            kind: 'enum',
            options: [
              { value: 'might', label: '力量' },
              { value: 'speed', label: '速度' }
            ],
            default: 'might'
          }
        ];
      case 'bell':
        return [
          {
            key: 'target',
            label: '目标',
            kind: 'enum',
            options: roommates.map(id => ({ value: id, label: state.players[id].name })),
            default: playerId
          }
        ];
      case 'dynamite': {
        const options = exploredRooms(state)
          .filter(roomId2 => {
            if (roomId2 === roomId) return false;
            const node = state.mapGraph.nodes[roomId2];
            return node?.neighbors.includes(roomId) || sameFloorLine(state, roomId, roomId2);
          })
          .map(roomId2 => ({ value: roomId2, label: roomName(state, roomId2) }));
        return options.length > 0
          ? [{ key: 'targetRoom', label: '投掷目标房间', kind: 'enum', options, default: options[0].value }]
          : [];
      }
      default:
        return [];
    }
  }

  /* ------------------------------------------------------------------ */
  /* Reduce                                                             */
  /* ------------------------------------------------------------------ */

  public static applyAction(state: GameState, action: Action, ctx: ReduceContext): GameState {
    const s: GameState = JSON.parse(JSON.stringify(state));
    const pid = action.playerId;

    switch (action.type) {
      case 'MOVE_TO_ROOM':
        this.move(s, pid, action.targetNodeId ?? action.targets?.[0] ?? '', ctx);
        break;
      case 'EXPLORE_DOOR':
        this.explore(
          s,
          pid,
          String(action.payload?.direction ?? 'N') as 'N' | 'S' | 'E' | 'W',
          ctx,
          action.payload?.rotation === undefined ? undefined : Number(action.payload.rotation)
        );
        break;
      case 'PLACE_ROOM':
        this.placeDrawnRoom(s, pid, Number(action.payload?.rotation ?? -1), ctx);
        break;
      case 'USE_ELEVATOR': {
        const player = s.players[pid];
        if (player.customProps.elevatorUsed) break;
        const fromFloor = String(s.mapGraph.nodes[activeRoom(s, pid)]?.props?.floor ?? '');

        // Rulebook, Mystic Elevator: "Traitors and Monsters can use the Elevator
        // without rolling, but only once per Traitor/Monster set of turns."
        if (player.role === 'TRAITOR') {
          player.customProps.elevatorUsed = true;
          s.globalVars.elevatorRide = { sum: 3, fromFloor, allowSameFloorOnly: false };
          trace(ctx, 'ANNOUNCEMENT', '叛徒无需掷骰，电梯随其心意移动 —— 选择目的地', 600);
          break;
        }

        // Step 1 of the ride: the dice decide what is possible, so they are rolled
        // before any destination is offered. The result stays in state and the
        // picker opens on the next legal-action pass.
        //   >= 3  any room with an open door, any floor
        //   == 2  same floor only
        //   == 1  nothing happens
        //   == 0  the car drops: 1 physical damage
        const roll = rollZeroDice(s.prngState, 2);
        s.prngState = roll.nextSeed;
        s.globalVars.lastElevatorRoll = { rolls: roll.rolls, sum: roll.sum };
        player.customProps.elevatorUsed = true;

        // Also publish it as the last roll so the dice overlay animates the ride.
        s.globalVars.rollSeq = Number(s.globalVars.rollSeq ?? 0) + 1;
        s.globalVars.lastRoll = {
          playerId: pid,
          dice: roll.rolls,
          total: roll.sum,
          seq: Number(s.globalVars.rollSeq ?? 0),
          reason: 'elevator',
          effect: '3+ 任意楼层 · 2 仅同层 · 1 不动 · 0 受伤'
        };
        trace(ctx, 'DICE_ROLL', `🛗 神秘电梯 [${roll.rolls.join('+')}] = ${roll.sum}`, 700);

        if (roll.sum === 0) {
          s.globalVars.elevatorRide = null;
          damagePlayer(s, pid, 'PHYSICAL', 1);
          trace(ctx, 'DAMAGE_EFFECT', `电梯骤然下坠，${player.name} 受到 1 点物理伤害`, 600);
          break;
        }
        if (roll.sum === 1) {
          s.globalVars.elevatorRide = null;
          trace(ctx, 'ANNOUNCEMENT', '电梯纹丝不动，门又关上了', 500);
          break;
        }

        s.globalVars.elevatorRide = {
          sum: roll.sum,
          fromFloor,
          allowSameFloorOnly: roll.sum === 2
        };
        trace(
          ctx,
          'ANNOUNCEMENT',
          roll.sum === 2 ? '电梯只在同一层滑动 —— 选择本层目的地' : '电梯随你心意移动 —— 选择目的地',
          600
        );
        break;
      }
      case 'ELEVATOR_MOVE': {
        const player = s.players[pid];
        const ride = s.globalVars.elevatorRide as
          | { sum: number; fromFloor: string; allowSameFloorOnly: boolean }
          | null
          | undefined;
        const targetId = action.targetNodeId ?? action.targets?.[0] ?? '';
        s.globalVars.elevatorRide = null;
        if (!ride || !targetId || !s.mapGraph.nodes[targetId]) {
          trace(ctx, 'ANNOUNCEMENT', '电梯停在一片虚空前，无处可去', 500);
          break;
        }

        // The car travels with you: the elevator tile is placed at the chosen
        // EMPTY DOORWAY and rotated so its single door faces the room, exactly
        // like a drawn room tile. The old cell is vacated by the re-place.
        const elevatorId = activeRoom(s, pid);
        const targetRoom = s.mapGraph.nodes[targetId];
        const tGrid = nodeGrid(targetRoom);
        if (!tGrid) break;

        const OFFSETS: Record<string, [number, number]> = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };
        const OPPOSITE: Record<string, string> = { N: 'S', S: 'N', E: 'W', W: 'E' };
        const dir = String(action.payload?.direction ?? '');
        const offset = OFFSETS[dir];
        if (!offset) {
          trace(ctx, 'ANNOUNCEMENT', '没有指定门口，电梯无法停靠', 500);
          break;
        }
        const col = tGrid.col + offset[0];
        const row = tGrid.row + offset[1];
        const taken = Object.values(s.mapGraph.nodes).some(node => {
          if (node.type !== 'ROOM' || node.id === elevatorId) return false;
          const g = nodeGrid(node);
          return !!g && g.floor === tGrid.floor && g.col === col && g.row === row;
        });
        if (taken) {
          trace(ctx, 'ANNOUNCEMENT', '那个门口已经站了房间，电梯无法停靠', 500);
          break;
        }

        // The car's door must face back toward the room it docked against.
        const entryDoor = OPPOSITE[dir] as 'N' | 'S' | 'E' | 'W';
        const rotation = validRotations(ROOM_DEFS.mystic_elevator.doors, entryDoor)[0] ?? 0;

        // Drop the old connections, move the tile, then hook it to the target.
        // The neighbour's adjacency list has to be cleaned too, or the topology
        // invariant reports a neighbour without an edge.
        for (const edge of Object.values(s.mapGraph.edges)) {
          if (edge.from !== elevatorId && edge.to !== elevatorId) continue;
          const otherId = edge.from === elevatorId ? edge.to : edge.from;
          const other = s.mapGraph.nodes[otherId];
          if (other) other.neighbors = other.neighbors.filter(id => id !== elevatorId);
          delete s.mapGraph.edges[edge.id];
        }
        const elevatorNode = s.mapGraph.nodes[elevatorId];
        if (elevatorNode) elevatorNode.neighbors = [];

        // The car adopts the DESTINATION's floor. addRoomNode derives the layer
        // from the definition, and the elevator's definition says basement, so
        // riding up to the second floor used to drop the tile into the basement
        // at the same column/row - colliding with a basement room or stranding
        // the rider on the wrong floor.
        const targetFloor = String(targetRoom.props?.floor ?? 'BASEMENT') as Floor;
        // Respect the tile's own floor list instead of assuming it may go anywhere.
        const elevatorFloors = ROOM_DEFS.mystic_elevator.floors ?? [ROOM_DEFS.mystic_elevator.floor];
        if (!elevatorFloors.includes(targetFloor)) {
          trace(ctx, 'ANNOUNCEMENT', '电梯到不了那一层', 500);
          break;
        }
        addRoomNode(
          s,
          { ...ROOM_DEFS.mystic_elevator, floor: targetFloor },
          col,
          row,
          rotation,
          elevatorId
        );
        connectRooms(s, elevatorId, targetId, 'DOOR');
        s.globalVars.elevatorRoomId = elevatorId;

        movePlayerTo(s, pid, elevatorId);
        player.customProps.movesLeft = Math.max(0, Number(player.customProps.movesLeft ?? 1) - 1);
        trace(ctx, 'MOVE_OBJECT', `🛗 ${player.name} 乘神秘电梯抵达 ${roomName(s, targetId)}，电梯砖随之移动`, 500);
        this.enterRoom(s, pid, elevatorId, ctx, false);
        break;
      }
      case 'TRY_FRONT_DOOR':
        trace(ctx, 'ANNOUNCEMENT', '前门纹丝不动 —— 作祟结束前，谁也离不开这座宅子', 700);
        break;
      case 'JUMP_DOWN': {
        const ballroom = Object.values(s.mapGraph.nodes).find(node => node.props?.name === '舞厅');
        const player = s.players[pid];
        if (!ballroom) break;
        movePlayerTo(s, pid, ballroom.id);
        player.customProps.movesLeft = 0;
        const rope = ownsDef(s, pid, 'rope');
        // Rulebook, Traitor and Monster Powers: a traitor uses the beneficial text
        // of a room while ignoring its harmful text, so the Gallery drop is free
        // for them and only the movement applies.
        if (!rope && player.role !== 'TRAITOR') {
          damagePlayer(s, pid, 'PHYSICAL', 1);
          trace(ctx, 'DAMAGE_EFFECT', `${player.name} 从楼座坠落，受到 1 点伤害`, 500);
        } else {
          trace(ctx, 'MOVE_OBJECT', `${player.name} 沿麻绳滑入舞厅`, 500);
        }
        this.enterRoom(s, pid, ballroom.id, ctx, false);
        break;
      }
      case 'CLIMB_UP': {
        const player = s.players[pid];
        const targetNodeId = action.targetNodeId ?? '';
        const edge = Object.values(s.mapGraph.edges).find(
          item => item.type === 'DROP' && item.to === activeRoom(s, pid) && item.from === targetNodeId
        );
        if (!player || !edge || !ownsDef(s, pid, 'rope')) break;
        if (Number(player.customProps.movesLeft ?? 0) <= 0) break;
        player.customProps.movesLeft = Number(player.customProps.movesLeft) - 1;
        movePlayerTo(s, pid, targetNodeId);
        trace(ctx, 'MOVE_OBJECT', `${player.name} 沿麻绳攀回 ${roomName(s, targetNodeId)}`, 500);
        this.enterRoom(s, pid, targetNodeId, ctx, false);
        break;
      }
      case 'USE_ITEM':
        this.useItem(s, pid, action.entityId ?? '', action, ctx);
        break;
      case 'DROP_ITEM':
        this.dropItem(s, pid, action.entityId ?? '', ctx);
        break;
      case 'PLACE_ENTITY':
        if (action.targetSlotId !== itemSlotId(activeRoom(s, pid))) break;
        this.dropItem(s, pid, action.entityId ?? '', ctx);
        break;
      case 'PICK_UP_ITEM':
        this.pickUpItem(s, pid, action.entityId ?? '', ctx);
        break;
      case 'ROOM_FEATURE':
        this.useRoomFeature(s, pid, String(action.payload?.feature ?? ''), ctx);
        break;
      /* ---- two-phase check window (K4) -------------------------------- */
      case 'DECLARE_CHECK': {
        const picked = RollWindowManager.pick(s, pid, String(action.payload?.option ?? ''));
        if (!picked.ok) {
          trace(ctx, 'ANNOUNCEMENT', picked.error ?? '无法声明该修正', 300);
          break;
        }
        s.rollWindows = picked.state.rollWindows;
        trace(ctx, 'ANNOUNCEMENT', `已声明修正：${String(action.payload?.option ?? '')}`, 400);
        break;
      }
      case 'ROLL_CHECK':
        this.rollOpenWindow(s, String(action.payload?.windowId ?? ''), ctx);
        break;
      case 'CHECK_REACTION': {
        const option = String(action.payload?.option ?? '');
        const picked = RollWindowManager.pick(s, pid, option);
        if (!picked.ok) {
          trace(ctx, 'ANNOUNCEMENT', picked.error ?? '无法使用该道具', 300);
          break;
        }
        s.rollWindows = picked.state.rollWindows;
        this.applyReaction(s, pid, option, ctx);
        break;
      }
      case 'RESOLVE_CHECK':
        this.resolveOpenWindow(s, ctx);
        break;
      case 'PROPOSE_ITEM_TRADE':
        this.proposeTrade(s, pid, action, ctx);
        break;
      case 'ACCEPT_TRADE':
        this.acceptTrade(s, pid, ctx);
        break;
      case 'REJECT_TRADE':
        trace(ctx, 'ANNOUNCEMENT', `${s.players[pid]?.name ?? pid} 拒绝交易`, 250);
        break;
      case 'ATTACK_PLAYER':
        this.attackPlayer(s, pid, action, ctx);
        break;
      case 'ATTACK_MONSTER':
        this.attackMonster(s, pid, action, ctx);
        break;
      case 'SLAP':
        this.slap(s, pid, action.targetPlayerId ?? '', ctx);
        break;
      case 'ROOM_EXIT_CHECK': {
        const roomId = activeRoom(s, pid);
        const check = EXIT_CHECKS[String(roomId.replace(/^room_/, ''))];
        if (!check) break;
        const result = rollTraitCheck(s, pid, check.trait, {
          threshold: check.threshold,
          reason: check.reason,
          effect: `成功：可以离开；失败：留下重试，或失去 1 点${TRAIT_META[check.penalty].zh}后离开`
        });
        trace(
          ctx,
          'DICE_ROLL',
          `${roomName(s, roomId)} 出口检定 ${result.total} vs ${check.threshold}`,
          600
        );
        if (result.success) {
          s.players[pid].customProps.exitPassedRoom = roomId;
          trace(ctx, 'ANNOUNCEMENT', `${s.players[pid].name} 顺利离开${roomName(s, roomId)}`, 400);
        } else {
          s.globalVars.pendingExit = {
            playerId: pid,
            roomId,
            penalty: check.penalty,
            amount: check.amount
          };
          trace(ctx, 'ANNOUNCEMENT', '出口被阻 —— 留下重试，或承受伤害强行离开', 600);
        }
        break;
      }
      case 'EXIT_STAY': {
        const pending = s.globalVars.pendingExit as { playerId: PlayerId } | null | undefined;
        if (!pending || pending.playerId !== pid) break;
        s.globalVars.pendingExit = null;
        // Staying means this turn's movement is over; next turn the roll is free again.
        s.players[pid].customProps.movesLeft = 0;
        trace(ctx, 'ANNOUNCEMENT', `${s.players[pid].name} 决定留下，下回合再试`, 500);
        break;
      }
      case 'EXIT_PAY': {
        const pending = s.globalVars.pendingExit as
          | { playerId: PlayerId; roomId: string; penalty: TraitKey; amount: number }
          | null
          | undefined;
        if (!pending || pending.playerId !== pid) break;
        s.globalVars.pendingExit = null;
        applyTraitSteps(s, pid, pending.penalty, -pending.amount);
        s.players[pid].customProps.exitPassedRoom = pending.roomId;
        trace(
          ctx,
          'DAMAGE_EFFECT',
          `${s.players[pid].name} 承受 1 点${TRAIT_META[pending.penalty].zh}损伤，强行离开`,
          600
        );
        break;
      }
      case 'ALLOCATE_DAMAGE':
        this.allocateDamage(s, pid, String(action.payload?.trait ?? ''), ctx);
        break;
      case 'SEAL_RITUAL':
        this.sealRitual(s, pid, ctx);
        break;
      case 'SEARCH_BONES':
        this.searchBones(s, pid, ctx);
        break;
      case 'CHANT':
        this.chant(s, pid, ctx);
        break;
      case 'DESTROY_BEACON':
        this.destroyBeacon(s, pid, ctx);
        break;
      case 'BREW_HOLY_WATER':
        this.brewHolyWater(s, pid, ctx);
        break;
      case 'SANCTIFY_HOUSE':
        this.sanctifyHouse(s, pid, ctx);
        break;
      case 'FORGE_SILVER':
        this.forgeSilver(s, pid, ctx);
        break;
      case 'SUPPRESS_CURSE':
        this.suppressCurse(s, pid, ctx);
        break;
      case 'PEEK_TOP':
        s.globalVars.peek = null;
        trace(ctx, 'ANNOUNCEMENT', '水晶球：将顶牌留在牌堆顶', 300);
        break;
      case 'PEEK_BOTTOM': {
        const peek = s.globalVars.peek as { deck?: string } | null;
        if (peek?.deck && s.zones[peek.deck]?.orderedEntities.length > 1) {
          const zone = s.zones[peek.deck];
          const top = zone.orderedEntities.pop()!;
          zone.orderedEntities.unshift(top);
        }
        s.globalVars.peek = null;
        trace(ctx, 'ANNOUNCEMENT', '水晶球：将顶牌置于牌堆底', 300);
        break;
      }
      case 'ROLL_HAUNT_CHECK':
        this.hauntRoll(s, pid, ctx);
        break;
      case 'MOVE_NPC':
        this.moveNpc(s, pid, action.targetNodeId ?? '', ctx);
        break;
      case 'ATTACK_HERO':
        this.npcAttack(s, pid, action.targetPlayerId ?? '', ctx);
        break;
      case 'END_NPC_TURN':
        this.endNpcTurn(s, pid, ctx);
        break;
      case 'END_TURN':
        this.endTurn(s, pid, ctx);
        break;
      case 'FROSTBITE':
        addFrost(s, activeRoom(s, pid));
        break;
      default:
        break;
    }

    // A dead explorer cannot keep the turn. The kernel has no spectator state,
    // so the module hands the turn to the next eligible actor immediately.
    const active = s.players[s.activePlayerId];
    if (active && !active.alive && !s.gameOver) {
      this.advanceTurn(s, ctx);
    }

    return s;
  }

  /* ------------------------------------------------------------------ */
  /* Movement & discovery                                                */
  /* ------------------------------------------------------------------ */

  private static move(state: GameState, pid: PlayerId, targetRoomId: string, ctx: ReduceContext): void {
    const player = state.players[pid];
    const from = activeRoom(state, pid);
    const room = state.mapGraph.nodes[from];
    if (!player || !room || !targetRoomId) return;
    if (!room.neighbors.includes(targetRoomId)) return;

    const cost = movementCost(state, pid, from);
    const movesLeft = Number(player.customProps.movesLeft ?? 0);
    if (cost > movesLeft) return;

    player.customProps.movesLeft = movesLeft - cost;
    movePlayerTo(state, pid, targetRoomId);
    trace(ctx, 'MOVE_OBJECT', `${player.name} 进入 ${roomName(state, targetRoomId)}`, 320);
    this.enterRoom(state, pid, targetRoomId, ctx, false);
  }

  private static explore(
    state: GameState,
    pid: PlayerId,
    dir: 'N' | 'S' | 'E' | 'W',
    ctx: ReduceContext,
    rotation?: number
  ): void {
    const player = state.players[pid];
    const from = activeRoom(state, pid);
    if (!player) return;

    const cost = movementCost(state, pid, from);
    if (Number(player.customProps.movesLeft ?? 0) < cost) return;

    const candidate = drawRoomCandidate(state, from, dir);
    if (!candidate) {
      trace(ctx, 'ANNOUNCEMENT', '该楼层的房间板块已全部探索完毕', 400);
      return;
    }

    // Legacy/test path: caller supplied the orientation explicitly.
    if (rotation !== undefined) {
      const placed = placeRoomCandidate(state, candidate, rotation);
      if (!placed) {
        trace(ctx, 'ANNOUNCEMENT', '该朝向无法接上入口门', 400);
        return;
      }
      this.finishPlacement(state, pid, placed, cost, candidate.discarded, ctx);
      return;
    }

    // Interactive path: draw, expose the valid rotations, wait for PLACE_ROOM.
    state.globalVars.pendingRoomPlacement = {
      playerId: pid,
      fromRoomId: from,
      dir,
      tileId: candidate.tileId,
      defId: candidate.def.id,
      col: candidate.col,
      row: candidate.row,
      rotations: candidate.rotations,
      discarded: candidate.discarded,
      cost,
      name: candidate.def.name,
      en: candidate.def.en,
      floor: candidate.floor,
      position: gridToWorld(candidate.floor, candidate.col, candidate.row),
      localDoors: candidate.def.doors,
      color: FLOOR_META[candidate.floor].color,
      symbol: candidate.def.symbol,
      text: candidate.def.text,
      special: candidate.def.special,
      tags: candidate.def.tags
    };
    trace(
      ctx,
      'CARD_DRAW',
      `🃏 ${player.name} 抽到「${candidate.def.name}」，请选择房间朝向（${candidate.rotations.length} 种）`,
      650
    );
  }

  /** Complete an explore action after the tile is physically placed. */
  private static finishPlacement(
    state: GameState,
    pid: PlayerId,
    placed: { def: { name: string }; nodeId: string; connections: number },
    cost: number,
    discarded: string[],
    ctx: ReduceContext
  ): void {
    const player = state.players[pid];
    if (!player) return;
    player.customProps.movesLeft = Number(player.customProps.movesLeft ?? 1) - cost;
    movePlayerTo(state, pid, placed.nodeId);
    trace(
      ctx,
      'EXPLORE_ROOM',
      `🚪 ${player.name} 发现「${placed.def.name}」${discarded.length > 0 ? `（弃置 ${discarded.length} 块不匹配板块）` : ''}${
        placed.connections > 0 ? ` · 打通 ${placed.connections} 扇相邻门` : ''
      }`,
      650
    );
    this.enterRoom(state, pid, placed.nodeId, ctx, true);
  }

  /** Resolve a pending drawn tile once the player picks a rotation. */
  private static placeDrawnRoom(state: GameState, pid: PlayerId, rotation: number, ctx: ReduceContext): void {
    const pending = state.globalVars.pendingRoomPlacement as
      | {
          playerId: string;
          fromRoomId: string;
          dir: 'N' | 'S' | 'E' | 'W';
          tileId: string;
          defId: string;
          col: number;
          row: number;
          floor: Floor;
          rotations: number[];
          discarded: string[];
          cost: number;
        }
      | undefined;
    if (!pending || pending.playerId !== pid) return;
    const def = ROOM_DEFS[pending.defId];
    if (!def) {
      state.globalVars.pendingRoomPlacement = null;
      return;
    }
    if (!pending.rotations.includes(rotation)) {
      trace(ctx, 'ANNOUNCEMENT', '该朝向无法接上入口门，请选择其他朝向', 400);
      return;
    }
    const nodeId = `room_${pending.defId}`;
    if (state.mapGraph.nodes[nodeId]) {
      trace(ctx, 'ANNOUNCEMENT', `「${def.name}」已在洋馆中，无需重复放置`, 400);
      state.globalVars.pendingRoomPlacement = null;
      return;
    }
    const placed = placeRoomCandidate(
      state,
      {
        def,
        tileId: pending.tileId,
        fromRoomId: pending.fromRoomId,
        dir: pending.dir,
        col: pending.col,
        row: pending.row,
        floor: pending.floor,
        rotations: pending.rotations,
        discarded: pending.discarded
      },
      rotation
    );
    if (!placed) {
      trace(ctx, 'ANNOUNCEMENT', '该朝向无法接上入口门，请选择其他朝向', 400);
      return;
    }
    state.globalVars.pendingRoomPlacement = null;
    this.finishPlacement(state, pid, placed, pending.cost, pending.discarded, ctx);
  }

  /**
   * Cracking the vault: the skeleton key opens it outright, otherwise the
   * player rolls knowledge. Shared by the on-entry trigger and the explicit
   * ROOM_FEATURE click so both paths stay identical.
   */
  private static crackVault(
    state: GameState,
    pid: PlayerId,
    ctx: ReduceContext,
    player: { name: string }
  ): void {
    const room = state.mapGraph.nodes[activeRoom(state, pid)];
    if (!room || room.props?.opened) return;

    const declares = this.checkDeclareOptions(state, pid);
    const reacts = this.checkReactOptions(state, pid);

    // Nothing to decide: keep the single-dispatch path so ordinary play is
    // unchanged and no extra clicks are forced.
    if (declares.length === 0 && reacts.length === 0) {
      const check = rollTraitCheck(state, pid, 'knowledge', {
        threshold: 6,
        reason: 'vault', label: '金库',
        effect: '成功：撬开金库并取走 2 件物品；失败：锁芯纹丝不动'
      });
      trace(ctx, 'DICE_ROLL', `金库 · 知识检定 ${check.total} vs 6`, 600);
      this.settleVault(state, pid, ctx, player, check.success === true, check.total);
      return;
    }

    // Two-phase: declare modifiers, throw, then react to the result.
    const opened = RollWindowManager.open(state, {
      id: `roll_vault_${pid}_${state.turn}_${state.seq}`,
      label: '金库 · 知识检定',
      actorId: pid,
      phase: 'DECLARE',
      declares: [{ actorId: pid, options: declares, picked: [] }],
      reacts: [{ actorId: pid, options: reacts, picked: [] }],
      payload: { kind: 'VAULT', roomId: room.id, threshold: 6, trait: 'knowledge' }
    });
    state.rollWindows = opened.rollWindows;
    trace(ctx, 'ANNOUNCEMENT', `🔐 ${player.name} 开始撬金库：可先声明修正，掷骰后再决定是否用幸运道具`, 600);
  }

  /** Pre-roll modifiers the explorer may declare before the dice are thrown. */
  private static checkDeclareOptions(state: GameState, pid: PlayerId): string[] {
    const options: string[] = [];
    if (ownsDef(state, pid, 'angel_feather')) options.push('angel_feather');
    return options;
  }

  /** Post-roll responses offered once the result is known. */
  private static checkReactOptions(state: GameState, pid: PlayerId): string[] {
    const options: string[] = [];
    if (ownsDef(state, pid, 'rabbits_foot') && !usedThisTurn(state, pid, 'rabbits_foot')) {
      options.push('rabbits_foot');
    }
    if (ownsDef(state, pid, 'lucky_stone') && !usedThisTurn(state, pid, 'lucky_stone')) {
      options.push('lucky_stone');
    }
    return options;
  }

  /** Throw the dice for an open window and move it into the REACT phase. */
  private static rollOpenWindow(state: GameState, windowId: string, ctx: ReduceContext): void {
    const window = RollWindowManager.current(state);
    if (!window || window.id !== windowId) return;

    const pid = window.actorId as PlayerId;
    const payload = (window.payload ?? {}) as { trait?: TraitKey; threshold?: number };
    const trait = (payload.trait ?? 'knowledge') as TraitKey;
    const threshold = Number(payload.threshold ?? 6);

    // Declared modifiers are applied before the throw (angel feather pins it).
    const declared = window.declares.flatMap(slot => slot.picked);
    if (declared.includes('angel_feather')) {
      state.players[pid].customProps.forcedRoll = { value: 8 };
      this.consumeDef(state, pid, 'angel_feather', ctx);
    }

    const check = rollTraitCheck(state, pid, trait, {
      threshold,
      reason: window.label,
      allowLuck: false,
      effect: window.payload?.kind === 'VAULT'
        ? `成功：达到 ${threshold} 即撬开金库；失败：这次没能撬开`
        : `达到 ${threshold} 即成功`
    });
    trace(ctx, 'DICE_ROLL', `${window.label} ${check.total} vs ${threshold}`, 600);

    const recorded = RollWindowManager.record(state, {
      dice: check.dice,
      total: check.total,
      threshold,
      success: check.total >= threshold
    });
    state.rollWindows = recorded.state.rollWindows;
  }

  /** Spend a post-roll luck item and amend the stored result. */
  private static applyReaction(
    state: GameState,
    pid: PlayerId,
    option: string,
    ctx: ReduceContext
  ): void {
    const window = RollWindowManager.current(state);
    if (!window?.result) return;

    let result = { ...window.result };
    if (option === 'lucky_stone') {
      result = { ...result, total: result.total + 1 };
      markUsed(state, pid, 'lucky_stone');
      trace(ctx, 'ANNOUNCEMENT', '幸运石让结果 +1', 400);
    } else if (option === 'rabbits_foot') {
      const lowest = result.dice.indexOf(Math.min(...result.dice));
      const reroll = rollZeroDice(state.prngState, 1);
      state.prngState = reroll.nextSeed;
      const dice = [...result.dice];
      dice[lowest] = reroll.rolls[0];
      result = { ...result, dice, total: dice.reduce((sum, value) => sum + value, 0) };
      markUsed(state, pid, 'rabbits_foot');
      trace(ctx, 'DICE_ROLL', `幸运兔足重掷最低骰 → ${result.total}`, 500);
    }
    result.success = result.threshold === undefined ? undefined : result.total >= result.threshold;

    const amended = RollWindowManager.amend(state, result);
    state.rollWindows = amended.state.rollWindows;
  }

  /** Close the window and apply its outcome. */
  private static resolveOpenWindow(state: GameState, ctx: ReduceContext): void {
    const closed = RollWindowManager.resolve(state);
    state.rollWindows = closed.state.rollWindows;
    const window = closed.window;
    if (!window) return;

    const pid = window.actorId as PlayerId;
    const player = state.players[pid];
    if (!player) return;
    const payload = (window.payload ?? {}) as { kind?: string };

    if (payload.kind === 'VAULT') {
      const success = window.result?.success === true;
      const total = window.result?.total ?? 0;
      if (!window.result) {
        trace(ctx, 'ANNOUNCEMENT', `${player.name} 放弃了撬锁`, 400);
        return;
      }
      this.settleVault(state, pid, ctx, player, success, total);
    }
  }

  /** Shared vault payoff for the inline and windowed paths. */
  private static settleVault(
    state: GameState,
    pid: PlayerId,
    ctx: ReduceContext,
    player: { name: string },
    success: boolean,
    total: number
  ): void {
    const room = state.mapGraph.nodes[activeRoom(state, pid)];
    if (!room || room.props?.opened) return;
    if (success) {
      room.props.opened = true;
      this.drawItems(state, pid, 2, ctx);
      trace(ctx, 'CARD_DRAW', `${player.name} 打开了金库（检定 ${total}）`, 600);
    } else {
      trace(ctx, 'ANNOUNCEMENT', `锁芯纹丝不动（检定 ${total} vs 6），这次没能撬开金库`, 500);
    }
  }

  /** Consume one copy of a definition from the explorer's hand. */
  private static consumeDef(state: GameState, pid: PlayerId, defId: string, ctx: ReduceContext): void {
    const entity = handEntities(state, pid).find(candidate => cardDef(candidate) === defId);
    if (entity) this.consume(state, pid, entity.id, ctx);
  }

  /** Explicit "poke the room" action; currently only the vault opts in. */
  private static useRoomFeature(
    state: GameState,
    pid: PlayerId,
    feature: string,
    ctx: ReduceContext
  ): void {
    const player = state.players[pid];
    const room = state.mapGraph.nodes[activeRoom(state, pid)];
    if (!player || !room) return;
    if (feature === 'VAULT' && room.props?.special === 'VAULT') {
      this.crackVault(state, pid, ctx, player);
    }
  }

  /** Room effects, symbol card draw and forced stop. */
  private static enterRoom(
    state: GameState,
    pid: PlayerId,
    roomId: string,
    ctx: ReduceContext,
    justExplored: boolean
  ): void {
    const player = state.players[pid];
    const room = state.mapGraph.nodes[roomId];
    if (!player || !room) return;

    const traitor = player.role === 'TRAITOR';
    const special = room.props?.special as string | null;
    const tags = roomTags(state, roomId);

    // Rulebook, Death and Stuns: when an explorer dies their companion token is
    // left in the room, and "any other explorer that enters the room gains
    // custody of the companion". Unowned companions lying here are claimed now.
    const roomZone = state.zones[`zone_room_${roomId}`];
    for (const entityId of [...(roomZone?.orderedEntities ?? [])]) {
      const entity = state.entities[entityId];
      if (!entity?.components.custom?.companion) continue;
      if (entity.ownerId) continue;
      // A zone can list an entity whose zoneId points elsewhere (a stale listing
      // left by an earlier move). Moving it would create a duplicate zone entry,
      // which the kernel rejects, so only claim entities that really are here.
      if (entity.zoneId && entity.zoneId !== roomZone?.id) continue;
      const hand = state.zones[`zone_hand_${pid}`];
      if (!hand) continue;
      entity.ownerId = pid;
      // Strip any stale listing first: a card can be left registered in the deck
      // zone it was drawn from, and moving it without cleaning that up produces a
      // duplicate zone entry the kernel rejects.
      for (const zone of Object.values(state.zones)) {
        if (zone.id === hand.id) continue;
        const at = zone.orderedEntities.indexOf(entityId);
        if (at >= 0) zone.orderedEntities.splice(at, 1);
      }
      const next = ECSManager.moveEntity(state, entityId, hand.id);
      state.entities = next.entities;
      state.zones = next.zones;
      trace(ctx, 'ANNOUNCEMENT', `${player.name} 收留了${itemLabel(entity)}`, 450);
    }

    // Rulebook, Special Rooms: "The Chute affects Traitors and monsters." This
    // used to sit behind `if (!traitor)`, so a traitor slid through untouched.
    if (special === 'COAL_CHUTE') {
      const hasRope = ownsDef(state, pid, 'rope');
      if (!hasRope) {
        damagePlayer(state, pid, 'PHYSICAL', 1);
        trace(ctx, 'DAMAGE_EFFECT', `${player.name} 从煤槽滑下擦伤（1 点物理伤害）`, 500);
      } else {
        trace(ctx, 'ANNOUNCEMENT', `${player.name} 借助绳索安全滑落煤槽`, 500);
      }
      if (state.mapGraph.nodes.room_basement_landing) {
        movePlayerTo(state, pid, 'room_basement_landing');
        trace(ctx, 'MOVE_OBJECT', `${player.name} 滑落至地下平台`, 500);
      }
    }

    if (!traitor) {
      if (special === 'COLLAPSED') {
        const check = rollTraitCheck(state, pid, 'speed', {
          threshold: 5,
          reason: 'collapsed room', label: '坍塌之室',
          effect: '成功：安全滑下；失败：受到 2 点物理伤害'
        });
        trace(ctx, 'DICE_ROLL', `坍塌之室 · 速度检定 ${check.total} vs 5`, 600);
        if (!check.success) {
          damagePlayer(state, pid, 'PHYSICAL', 1);
          if (state.mapGraph.nodes.room_basement_landing) {
            movePlayerTo(state, pid, 'room_basement_landing');
          }
          player.customProps.movesLeft = 0;
          trace(ctx, 'DAMAGE_EFFECT', `${player.name} 坠入地下室平台（1 点物理伤害）`, 700);
          return;
        }
      }
    }

    // Beneficial room functions are available to the traitor as well.
    if (special === 'VAULT' && !room.props?.opened) {
      this.crackVault(state, pid, ctx, player);
    }

    if (!justExplored || room.props?.resolved) return;

    const symbol = room.props?.symbol as 'EVENT' | 'ITEM' | 'OMEN' | null;
    if (!symbol) return;

    room.props.resolved = true;
    player.customProps.movesLeft = 0;

    if (symbol === 'EVENT') {
      if (traitor) {
        trace(ctx, 'ANNOUNCEMENT', `${player.name} 是叛徒，不屑于抽事件牌`, 300);
        return;
      }
      this.drawEvent(state, pid, roomId, ctx);
      return;
    }

    if (symbol === 'ITEM') {
      this.drawItems(state, pid, 1, ctx);
      return;
    }

    this.drawOmen(state, pid, ctx);
  }

  private static drawEvent(state: GameState, pid: PlayerId, roomId: string, ctx: ReduceContext): void {
    const card = takeTopCard(state, 'zone_event_deck');
    if (!card) {
      trace(ctx, 'ANNOUNCEMENT', '事件牌堆已空', 300);
      return;
    }
    const defId = cardDef(card);
    const def = EVENT_DEFS[defId];
    discardCard(state, card.id, 'zone_event_discard');
    if (!def) return;

    const player = state.players[pid];
    trace(ctx, 'CARD_DRAW', `🎴 ${player.name} 抽到事件「${def.name}」`, 700);

    if (!def.check) {
      const band = def.bands[0];
      this.applyEventEffects(state, pid, roomId, band.effects, ctx);
      trace(ctx, 'ANNOUNCEMENT', band.text, 600);
      return;
    }

    const successThreshold = def.bands.length > 1 ? def.bands[def.bands.length - 1].min : 0;
    const check = rollTraitCheck(state, pid, def.check, { threshold: successThreshold, reason: def.name });
    trace(
      ctx,
      'DICE_ROLL',
      `${def.name} · ${TRAIT_META[def.check].zh}检定 [${check.dice.join('+')}] = ${check.total}`,
      700
    );
    const band = def.bands.find(entry => check.total >= entry.min && check.total <= entry.max) ?? def.bands[def.bands.length - 1];
    this.applyEventEffects(state, pid, roomId, band.effects, ctx);
    trace(ctx, 'ANNOUNCEMENT', band.text, 700);
  }

  private static applyEventEffects(
    state: GameState,
    pid: PlayerId,
    roomId: string,
    effects: EventEffect[],
    ctx: ReduceContext
  ): void {
    // Rulebook, Traitor and Monster Powers: "The Traitor can choose not to be
    // affected by an Event card or Omens such as Bite." Every effect in this deck
    // is a cost, so the traitor declines them all.
    const acting = state.players[pid];
    if (acting?.role === 'TRAITOR') {
      trace(ctx, 'ANNOUNCEMENT', `${acting.name} 身为叛徒，选择不受事件卡影响`, 500);
      return;
    }

    for (const effect of effects) {
      switch (effect.kind) {
        case 'TRAIT':
          applyTraitSteps(state, pid, effect.trait, effect.amount, { force: true });
          break;
        case 'DRAW_ITEM':
          this.drawItems(state, pid, effect.count, ctx);
          break;
        case 'DRAW_OMEN':
          this.drawOmen(state, pid, ctx);
          break;
        case 'ATTACK': {
          const attack = rollZeroDice(state.prngState, effect.dice);
          state.prngState = attack.nextSeed;
          const defense = rollZeroDice(state.prngState, Math.max(1, traitValue(state.players[pid], 'might')));
          state.prngState = defense.nextSeed;
          const damage = Math.max(0, attack.sum - defense.sum);
          if (damage > 0) damagePlayer(state, pid, effect.damage, damage);
          trace(ctx, 'DICE_ROLL', `袭击 [${attack.rolls.join('+')}]=${attack.sum} vs 防御 ${defense.sum}`, 600);
          break;
        }
        case 'TO_BASEMENT': {
          if (state.mapGraph.nodes.room_basement_landing) {
            movePlayerTo(state, pid, 'room_basement_landing');
            state.players[pid].customProps.movesLeft = 0;
            if (effect.damage > 0) damagePlayer(state, pid, 'PHYSICAL', effect.damage);
          }
          break;
        }
        case 'TO_RANDOM_ROOM': {
          const target = randomRoom(state);
          if (target) {
            movePlayerTo(state, pid, target);
            state.players[pid].customProps.movesLeft = 0;
          }
          break;
        }
        case 'SECRET_PASSAGE': {
          const candidates = exploredRooms(state).filter(id => id !== roomId);
          if (candidates.length > 0) {
            const roll = DeterministicPRNG.nextInt(state.prngState, 0, candidates.length - 1);
            state.prngState = roll.nextSeed;
            const edgeId = `edge_${roomId}_${candidates[roll.value]}`;
            if (!state.mapGraph.edges[edgeId]) {
              const from = state.mapGraph.nodes[roomId];
              const to = state.mapGraph.nodes[candidates[roll.value]];
              if (from && to) {
                from.neighbors.push(to.id);
                to.neighbors.push(from.id);
                state.mapGraph.edges[edgeId] = {
                  id: edgeId,
                  from: from.id,
                  to: to.id,
                  type: 'SECRET_PASSAGE',
                  props: { label: '密道' }
                };
              }
            }
          }
          break;
        }
        case 'DROP_ITEM': {
          const item = handEntities(state, pid).find(entity => tradeable(entity) && !entity.components.custom?.companion);
          if (item) this.dropItem(state, pid, item.id, ctx);
          break;
        }
        case 'ONGOING': {
          // Kernel-owned lifecycle: the module only names the curse, the kernel
          // stores id/expiry/visibility so it survives replay and projection.
          addEffect(state, {
            kind: 'ONGOING',
            source: pid,
            target: pid,
            payload: {
              effect: effect.effect,
              label: ONGOING_META[effect.effect]?.zh ?? effect.effect,
              detail: ONGOING_META[effect.effect]?.detail ?? ''
            },
            tags: ['ongoing', effect.effect]
          });
          break;
        }
        case 'NOTHING':
          break;
      }
    }
  }

  private static drawItems(state: GameState, pid: PlayerId, count: number, ctx: ReduceContext): void {
    for (let i = 0; i < count; i++) {
      const card = drawCardTo(state, 'zone_item_deck', `zone_hand_${pid}`, { type: 'PUBLIC' });
      if (!card) return;
      const defId = cardDef(card);
      card.ownerId = pid;
      applyItemGain(state, pid, defId);
      trace(ctx, 'CARD_DRAW', `🎁 ${state.players[pid].name} 获得物品「${itemLabel(card)}」`, 450);
    }
    this.updateResonanceFor(state, pid);
  }

  private static drawOmen(state: GameState, pid: PlayerId, ctx: ReduceContext): void {
    const card = drawCardTo(state, 'zone_omen_deck', `zone_hand_${pid}`, { type: 'PUBLIC' });
    if (!card) return;
    const defId = cardDef(card);
    const def = OMEN_DEFS[defId];
    card.ownerId = pid;

    state.globalVars.omensRevealed = Number(state.globalVars.omensRevealed ?? 0) + 1;
    state.globalVars.omenNames = [...(state.globalVars.omenNames ?? []), def?.name ?? defId];
    applyOmenGain(state, pid, defId);
    this.updateResonanceFor(state, pid);

    trace(ctx, 'CARD_DRAW', `🕯️ ${state.players[pid].name} 抽到预兆「${def?.name ?? defId}」（第 ${state.globalVars.omensRevealed} 张）`, 700);

    // Rulebook, Traitor and Monster Powers: "The Traitor can choose not to be
    // affected by an Event card or Omens such as Bite." This omen's on-draw attack
    // bypassed the event-effect guard, so a traitor still took the bite.
    const omenBitesTraitor = state.players[pid]?.role === 'TRAITOR';
    if (def?.onDrawAttack && !omenBitesTraitor) {
      const attack = rollZeroDice(state.prngState, def.onDrawAttack.dice);
      state.prngState = attack.nextSeed;
      const defense = rollZeroDice(state.prngState, Math.max(1, traitValue(state.players[pid], 'might')));
      state.prngState = defense.nextSeed;
      const damage = Math.max(0, attack.sum - defense.sum);
      if (damage > 0) damagePlayer(state, pid, 'PHYSICAL', damage, 'might');
      trace(
        ctx,
        'DICE_ROLL',
        `噬咬袭击 [${attack.rolls.join('+')}]=${attack.sum} vs 力量防御 ${defense.sum} → ${damage} 伤害`,
        700
      );
    }

    state.globalVars.pendingHauntRoll = { playerId: pid, omens: state.globalVars.omensRevealed };
  }

  private static updateResonanceFor(state: GameState, pid: PlayerId): void {
    const complete =
      ownsDef(state, pid, 'bell') && ownsDef(state, pid, 'book') && ownsDef(state, pid, 'candle');
    const player = state.players[pid];
    if (!player || complete === !!player.customProps.resonance) return;
    player.customProps.resonance = complete;
    for (const trait of TRAIT_KEYS) {
      const result = applyTraitSteps(state, pid, trait, complete ? 2 : -2, { force: true });
      if (result.dead) {
        killPlayer(state, pid);
        return;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Cards & items                                                       */
  /* ------------------------------------------------------------------ */

  private static dropItem(state: GameState, pid: PlayerId, entityId: string, ctx: ReduceContext): void {
    const entity = state.entities[entityId];
    const player = state.players[pid];
    if (!entity || !player) return;
    if (!handEntities(state, pid).some(item => item.id === entityId)) return;
    if (entity.components.custom?.companion) return;

    // The destination is owned by the game module: the discard must land in
    // the actor's current room, never in a client/renderer-selected room.
    const roomId = activeRoom(state, pid);
    const room = state.mapGraph.nodes[roomId];
    if (!roomId || !room) return;

    // Validate/commit the slot before applying item loss. If placement fails,
    // the card must remain in hand with its owner and inventory untouched.
    const zone = ensureRoomZone(state, roomId);
    const placed = OccupancyIndex.place(state, entityId, itemSlotId(roomId));
    if (!placed.ok) return;
    state.entities = placed.state.entities;

    const defId = cardDef(entity);
    applyItemLoss(state, pid, defId);
    applyOmenLoss(state, pid, defId);
    const detached = state.entities[entityId];
    if (!detached) return;
    detached.ownerId = undefined;
    detached.visibility = { type: 'PUBLIC' };
    const next = ECSManager.moveEntity(state, entityId, zone.id);
    state.entities = next.entities;
    state.zones = next.zones;
    this.updateResonanceFor(state, pid);
    trace(ctx, 'CARD_DISCARD', `${player.name} 丢下「${itemLabel(entity)}」`, 350);
  }

  private static pickUpItem(state: GameState, pid: PlayerId, entityId: string, ctx: ReduceContext): void {
    const entity = state.entities[entityId];
    const player = state.players[pid];
    if (!entity || !player) return;
    if (entity.zoneId !== `zone_room_${activeRoom(state, pid)}`) return;

    const defId = cardDef(entity);
    entity.ownerId = pid;
    const hand = state.zones[`zone_hand_${pid}`];
    if (!hand) return;
    const cleared = OccupancyIndex.remove(state, entityId);
    state.entities = cleared.entities;
    const next = ECSManager.moveEntity(state, entityId, hand.id);
    state.entities = next.entities;
    state.zones = next.zones;
    applyItemGain(state, pid, defId);
    applyOmenGain(state, pid, defId);
    this.updateResonanceFor(state, pid);
    trace(ctx, 'TOKEN_TRANSFER', `${player.name} 捡起「${itemLabel(entity)}」`, 350);
  }

  private static useItem(state: GameState, pid: PlayerId, entityId: string, action: Action, ctx: ReduceContext): void {
    const entity = state.entities[entityId];
    const player = state.players[pid];
    if (!entity || !player) return;
    if (!handEntities(state, pid).some(item => item.id === entityId)) return;

    const defId = cardDef(entity);
    const item = ITEM_DEFS[defId];
    const omen = OMEN_DEFS[defId];
    const def = item ?? omen;
    if (!def) return;
    if (usedThisTurn(state, pid, defId)) return;

    const roomId = activeRoom(state, pid);

    switch (defId) {
      case 'dog': {
        // Dog fetches one item pile card within six graph steps.
        const target = this.findDogFetchTarget(state, pid);
        if (!target) {
          trace(ctx, 'ANNOUNCEMENT', '脏狗找不到可带回的物品', 300);
          return;
        }
        const hand = state.zones[`zone_hand_${pid}`];
        if (!hand) return;
        target.ownerId = pid;
            const next = ECSManager.moveEntity(state, target.id, hand.id);
        state.entities = next.entities;
        state.zones = next.zones;
        applyItemGain(state, pid, cardDef(target));
        markUsed(state, pid, defId);
        trace(ctx, 'TOKEN_TRANSFER', `🐕 脏狗带回「${itemLabel(target)}」`, 500);
        break;
      }
      case 'adrenaline_shot': {
        const mode = String(action.payload?.mode ?? 'check');
        if (mode === 'move') {
          player.customProps.movesLeft = Number(player.customProps.movesLeft ?? 0) + 4;
          trace(ctx, 'ANNOUNCEMENT', `${player.name} 注射肾上腺素，移动力 +4`, 400);
        } else {
          player.customProps.checkBonus = Number(player.customProps.checkBonus ?? 0) + 4;
          trace(ctx, 'ANNOUNCEMENT', `${player.name} 注射肾上腺素，下次检定 +4`, 400);
        }
        this.consume(state, pid, entityId, ctx);
        break;
      }
      case 'angel_feather': {
        const value = Math.max(0, Math.min(8, Number(action.payload?.value ?? 8)));
        player.customProps.forcedRoll = { value };
        trace(ctx, 'ANNOUNCEMENT', `${player.name} 使用天使羽毛，指定下次掷骰为 ${value}`, 400);
        this.consume(state, pid, entityId, ctx);
        break;
      }
      case 'bell': {
        // Official: "Ring the brass bell once per turn to calm your nerves and gain
        // 1 Sanity." The old version rolled Sanity 5+ to shove monsters around.
        applyTraitSteps(state, pid, 'sanity', 1, { force: true });
        trace(ctx, 'ANNOUNCEMENT', `${player.name} 摇响法铃，神智 +1`, 350);
        markUsed(state, pid, defId);
        break;
      }
      case 'bottle': {
        // Official: "Drink it: roll 3 dice. 4+ Invigorating elixir (Gain 1 Might,
        // Speed); 1-3 Bitter tonic (Gain 1 Sanity); 0 Poison (Lose 1 Might)."
        const roll = rollZeroDice(state.prngState, 3);
        state.prngState = roll.nextSeed;
        trace(ctx, 'DICE_ROLL', `药瓶 [${roll.rolls.join('+')}] = ${roll.sum}`, 600);
        if (roll.sum >= 4) {
          applyTraitSteps(state, pid, 'might', 1, { force: true });
          applyTraitSteps(state, pid, 'speed', 1, { force: true });
          trace(ctx, 'ANNOUNCEMENT', '提神药液：力量与速度各 +1', 450);
        } else if (roll.sum >= 1) {
          applyTraitSteps(state, pid, 'sanity', 1, { force: true });
          trace(ctx, 'ANNOUNCEMENT', '苦涩补剂：神智 +1', 450);
        } else {
          applyTraitSteps(state, pid, 'might', -1, { force: true });
          trace(ctx, 'ANNOUNCEMENT', '毒液：力量 -1', 450);
        }
        this.consume(state, pid, entityId, ctx);
        break;
      }
      case 'crystal_ball': {
        // Rulebook, Using Items and Omens: "The Crystal Ball can only be used to
        // look through undrawn Item and Event cards." It is a pure look: no trait
        // roll, and the card is NOT taken off the deck (taking it would silently
        // reorder every later draw, which the previous version did).
        const requested = String(action.payload?.deck ?? 'zone_event_deck');
        const peekDeck = requested === 'zone_item_deck' ? 'zone_item_deck' : 'zone_event_deck';
        const zone = state.zones[peekDeck];
        const topId = zone?.orderedEntities?.[0];
        const top = topId ? state.entities[topId] : undefined;
        state.globalVars.peek = {
          deck: peekDeck,
          title: top ? itemLabel(top) : '空',
          ownerId: pid
        };
        trace(
          ctx,
          'ANNOUNCEMENT',
          `🔮 水晶球映出${peekDeck === 'zone_item_deck' ? '物品' : '事件'}牌堆顶：${state.globalVars.peek.title}`,
          600
        );
        markUsed(state, pid, defId);
        break;
      }
      case 'idol': {
        // Official: "Make a Sanity roll: 4+ Divine blessing (+1 to all traits!);
        // 0-3 Dark curse (Lose 1 Sanity)."
        const check = rollTraitCheck(state, pid, 'sanity', {
          threshold: 4,
          reason: 'idol',
          label: '神秘神像',
          effect: '成功：全部属性 +1；失败：失去 1 点神智'
        });
        if (check.success) {
          for (const trait of ['might', 'speed', 'knowledge', 'sanity'] as TraitKey[]) {
            applyTraitSteps(state, pid, trait, 1, { force: true });
          }
          trace(ctx, 'DICE_ROLL', `神像：神智检定 ${check.total} vs 4，全部属性 +1`, 500);
        } else {
          applyTraitSteps(state, pid, 'sanity', -1, { force: true });
          trace(ctx, 'DICE_ROLL', `神像：神智检定 ${check.total} vs 4，神智 -1`, 500);
        }
        markUsed(state, pid, defId);
        break;
      }
      case 'dark_dice': {
        // Official: "Roll 3 dice: 4+ Dark boon grants +1 Might, Speed, Knowledge;
        // 0-3 The dark dice demand payment (Lose 1 Might and 1 Speed)."
        const roll = rollZeroDice(state.prngState, 3);
        state.prngState = roll.nextSeed;
        if (roll.sum >= 4) {
          for (const trait of ['might', 'speed', 'knowledge'] as TraitKey[]) {
            applyTraitSteps(state, pid, trait, 1, { force: true });
          }
          trace(ctx, 'DICE_ROLL', `黑暗骰子 [${roll.rolls.join('+')}] = ${roll.sum}：力量、速度、知识各 +1`, 500);
        } else {
          applyTraitSteps(state, pid, 'might', -1, { force: true });
          applyTraitSteps(state, pid, 'speed', -1, { force: true });
          trace(ctx, 'DICE_ROLL', `黑暗骰子 [${roll.rolls.join('+')}] = ${roll.sum}：力量与速度各 -1`, 500);
        }
        markUsed(state, pid, defId);
        break;
      }
      case 'skull': {
        // Official: "Use to commune with the dead: roll Sanity 4+ Gain 1 Knowledge;
        // 0-3 Lose 1 Sanity." The old version rolled Knowledge 5+ and had no
        // failure branch at all.
        const check = rollTraitCheck(state, pid, 'sanity', {
          threshold: 4,
          reason: 'skull',
          label: '头骨',
          effect: '成功：获得 1 点知识；失败：失去 1 点神智'
        });
        if (check.success) {
          applyTraitSteps(state, pid, 'knowledge', 1, { force: true });
          trace(ctx, 'DICE_ROLL', `头骨：神智检定 ${check.total} vs 4，知识 +1`, 450);
        } else {
          applyTraitSteps(state, pid, 'sanity', -1, { force: true });
          trace(ctx, 'DICE_ROLL', `头骨：神智检定 ${check.total} vs 4，神智 -1`, 450);
        }
        markUsed(state, pid, defId);
        break;
      }
      case 'spirit_board': {
        const check = rollTraitCheck(state, pid, 'sanity', { threshold: 5, reason: 'spirit board', label: '通灵板' });
        if (check.success) {
          player.customProps.movesLeft = Number(player.customProps.movesLeft ?? 0) + 4;
          const haunt = currentHaunt(state);
          const hint = haunt ? `叛徒的目标：${HAUNT_DEFS[haunt.id]?.traitorObjective ?? '未知'}` : '亡灵指出了尚未被发现的房间。';
          trace(ctx, 'ANNOUNCEMENT', `🪦 通灵板：${hint}（本回合移动 +4）`, 700);
        }
        markUsed(state, pid, defId);
        break;
      }
      case 'dynamite': {
        const targetRoom = String(action.payload?.targetRoom ?? '');
        if (!state.mapGraph.nodes[targetRoom]) return;
        const blast = rollZeroDice(state.prngState, 4);
        state.prngState = blast.nextSeed;
        for (const occupant of playersInRoom(state, targetRoom)) {
          damagePlayer(state, occupant, 'PHYSICAL', blast.sum);
        }
        for (const monster of monstersInRoom(state, targetRoom)) {
          // Damage, not a stun: monsters carry a Might value and are defeated when
          // it runs out.
          const stats = monsterStats(monster);
          const nextMight = stats.might - blast.sum;
          if (nextMight <= 0) {
            this.hitMonster(state, monster, ctx);
          } else {
            monster.components.custom = { ...(monster.components.custom ?? {}), might: nextMight };
          }
        }
        trace(ctx, 'DAMAGE_EFFECT', `💥 炸药在 ${roomName(state, targetRoom)} 爆炸（${blast.sum} 点物理伤害）`, 800);
        this.consume(state, pid, entityId, ctx);
        break;
      }
      case 'healing_salve': {
        const trait = (action.payload?.trait as TraitKey) ?? 'might';
        this.healToGreen(state, pid, trait);
        const charges = Number(entity.components.custom?.charges ?? 2) - 1;
        entity.components.custom = { ...(entity.components.custom ?? {}), charges };
        trace(ctx, 'ANNOUNCEMENT', `${player.name} 使用治疗药膏（剩余 ${charges} 次）`, 350);
        if (charges <= 0) this.consume(state, pid, entityId, ctx);
        markUsed(state, pid, defId);
        break;
      }
      case 'medical_kit': {
        const target = String(action.payload?.target ?? pid);
        const trait = (action.payload?.trait as TraitKey) ?? 'might';
        if (target !== pid && activeRoom(state, target) !== roomId) return;
        if (!state.players[target]?.alive) return;
        const check = rollTraitCheck(state, pid, 'knowledge', { reason: 'medical kit', label: '医疗包' });
        const heal = check.total >= 6 ? 3 : check.total >= 4 ? 2 : check.total >= 2 ? 1 : 0;
        if (heal > 0) {
          for (let i = 0; i < heal; i++) this.healToGreen(state, target, trait);
        }
        trace(ctx, 'ANNOUNCEMENT', `医疗包：知识检定 ${check.total}，恢复 ${heal} 点肉体（${TRAIT_META[trait].zh}）`, 500);
        markUsed(state, pid, defId);
        break;
      }
      case 'music_box': {
        // Official text: "Play melody: make a Sanity roll: 4+ Soothing tune (Gain 1
        // Sanity); 0-3 Agonizing discord (Lose 1 Sanity)." The old version zeroed
        // movesLeft/attacksLeft/skipActions on nearby low-sanity players, but
        // resetTurnResources clears those at the target's turn start, so it did
        // nothing at all.
        const check = rollTraitCheck(state, pid, 'sanity', {
          threshold: 4,
          reason: 'music box',
          label: '八音盒',
          effect: '成功：旋律安抚心神，神智 +1；失败：刺耳的不和谐音，神智 -1'
        });
        applyTraitSteps(state, pid, 'sanity', check.success ? 1 : -1, { force: true });
        trace(ctx, 'DICE_ROLL', `八音盒：神智检定 ${check.total} vs 4`, 600);
        markUsed(state, pid, defId);
        break;
      }
      case 'puzzle_box': {
        const check = rollTraitCheck(state, pid, 'knowledge', { threshold: 6, reason: 'puzzle box', label: '谜盒' });
        if (check.success) {
          this.drawItems(state, pid, 2, ctx);
          this.consume(state, pid, entityId, ctx);
        }
        trace(ctx, 'DICE_ROLL', `机关盒：知识检定 ${check.total} vs 6`, 500);
        markUsed(state, pid, defId);
        break;
      }
      case 'smelling_salts': {
        // Official: "Wake a stunned explorer or restore 1 Sanity." The old version
        // healed a chosen trait all the way back to its green value, which is a
        // different (and far stronger) card.
        applyTraitSteps(state, pid, 'sanity', 1, { force: true });
        trace(ctx, 'ANNOUNCEMENT', `${player.name} 嗅了嗅盐，神智 +1`, 350);
        this.consume(state, pid, entityId, ctx);
        break;
      }
      case 'mask': {
        const check = rollTraitCheck(state, pid, 'sanity', { threshold: 4, reason: 'mask', label: '面具' });
        if (check.success) {
          player.customProps.maskWorn = !player.customProps.maskWorn;
          trace(ctx, 'ANNOUNCEMENT', `面具${player.customProps.maskWorn ? '戴上' : '摘下'}了`, 400);
        } else {
          damagePlayer(state, pid, 'MENTAL', 1);
        }
        markUsed(state, pid, defId);
        break;
      }
      default:
        trace(ctx, 'ANNOUNCEMENT', `「${def.name}」没有可主动使用的效果`, 300);
        break;
    }
  }

  private static findDogFetchTarget(state: GameState, pid: PlayerId): Entity | null {
    const origin = activeRoom(state, pid);
    const distance = graphDistances(state, origin);
    const candidates = Object.values(state.entities).filter(entity => {
      if (!entity.zoneId.startsWith('zone_room_')) return false;
      const roomId = entity.zoneId.replace('zone_room_', '');
      const steps = distance.get(roomId);
      if (steps === undefined || steps > 6) return false;
      return true;
    });
    return candidates[0] ?? null;
  }

  private static consume(state: GameState, pid: PlayerId, entityId: string, ctx: ReduceContext): void {
    discardCard(state, entityId, 'zone_item_discard');
    trace(ctx, 'CARD_DISCARD', `${state.players[pid]?.name ?? pid} 消耗了「${itemLabel(state.entities[entityId])}」`, 300);
  }

  private static checkDeath(state: GameState, pid: PlayerId): void {
    if (!state.globalVars.hauntTriggered) return;
    const player = state.players[pid];
    if (!player) return;
    if (TRAIT_KEYS.some(trait => traitIndex(player, trait) === 0)) {
      killPlayer(state, pid);
    }
  }

  private static healToGreen(state: GameState, pid: PlayerId, trait: TraitKey): void {
    const player = state.players[pid];
    if (!player) return;
    const target = Number(player.customProps.startIndex?.[trait] ?? 0);
    const current = traitIndex(player, trait);
    if (target > current) applyTraitSteps(state, pid, trait, target - current);
  }

  /* ------------------------------------------------------------------ */
  /* Trade                                                               */
  /* ------------------------------------------------------------------ */

  private static proposeTrade(state: GameState, pid: PlayerId, action: Action, ctx: ReduceContext): void {
    const giveEntityId = String(action.payload?.give ?? '');
    const wantEntityId = String(action.payload?.want ?? '');
    const give = state.entities[giveEntityId];
    const player = state.players[pid];
    if (!give || !player || !handEntities(state, pid).some(entity => entity.id === giveEntityId)) return;
    if (!tradeable(give) || give.components.custom?.companion) return;

    if (wantEntityId) {
      const want = state.entities[wantEntityId];
      if (!want || !want.ownerId || want.ownerId === pid) return;
      if (!tradeable(want) || want.components.custom?.companion) return;
      if (state.players[want.ownerId]?.customProps.currentRoomId !== activeRoom(state, pid)) return;
    }

    const participants = playersInRoom(state, activeRoom(state, pid), pid);
    if (participants.length === 0) return;

    state.globalVars.tradeOffer = { from: pid, giveEntityId, wantEntityId };
    const opened = openDecision(
      state,
      {
        kind: 'VOTE',
        title: `${player.name} 提出交易`,
        description: '同房间玩家中第一个接受者成交；无人接受则交易搁置。',
        participants,
        secret: false,
        policy: { type: 'FIRST_ACCEPT', acceptTypes: ['ACCEPT_TRADE'] },
        payload: { kind: 'trade' }
      },
      ctx.id('trade')
    );
    state.pendingDecisions = opened.state.pendingDecisions;
    trace(ctx, 'ANNOUNCEMENT', `${player.name} 拿出「${itemLabel(give)}」提出交易`, 450);
  }

  private static acceptTrade(state: GameState, pid: PlayerId, ctx: ReduceContext): void {
    const offer = state.globalVars.tradeOffer as
      | { from: PlayerId; giveEntityId: string; wantEntityId: string }
      | null
      | undefined;
    if (!offer) return;
    const giveaway = state.entities[offer.giveEntityId];
    const wanted = offer.wantEntityId ? state.entities[offer.wantEntityId] : null;
    if (!giveaway) return;
    const accepter = state.players[pid];
    const proposer = state.players[offer.from];
    if (!accepter || !proposer) return;

    const proposerHand = state.zones[`zone_hand_${offer.from}`];
    const accepterHand = state.zones[`zone_hand_${pid}`];
    if (!proposerHand || !accepterHand) return;

    applyItemLoss(state, offer.from, cardDef(giveaway));
    applyOmenLoss(state, offer.from, cardDef(giveaway));
    giveaway.ownerId = pid;
    let next = ECSManager.moveEntity(state, giveaway.id, accepterHand.id);
    state.entities = next.entities;
    state.zones = next.zones;
    applyItemGain(state, pid, cardDef(giveaway));
    applyOmenGain(state, pid, cardDef(giveaway));

    if (wanted && wanted.ownerId === pid) {
      applyItemLoss(state, pid, cardDef(wanted));
      applyOmenLoss(state, pid, cardDef(wanted));
      wanted.ownerId = offer.from;
      next = ECSManager.moveEntity(state, wanted.id, proposerHand.id);
      state.entities = next.entities;
      state.zones = next.zones;
      applyItemGain(state, offer.from, cardDef(wanted));
      applyOmenGain(state, offer.from, cardDef(wanted));
    }

    this.updateResonanceFor(state, pid);
    this.updateResonanceFor(state, offer.from);
    state.globalVars.tradeOffer = null;
    trace(
      ctx,
      'TOKEN_TRANSFER',
      `${accepter.name} 接受了 ${proposer.name} 的交易${wanted ? `（换出「${itemLabel(wanted)}」）` : ''}`,
      500
    );
  }

  /* ------------------------------------------------------------------ */
  /* Combat                                                              */
  /* ------------------------------------------------------------------ */

  private static attackPlayer(state: GameState, pid: PlayerId, action: Action, ctx: ReduceContext): void {
    const player = state.players[pid];
    const targetId = action.targetPlayerId ?? '';
    const target = state.players[targetId];
    if (!player || !target || !target.alive) return;
    if (Number(player.customProps.attacksLeft ?? 0) <= 0) return;

    const weaponId = String(action.payload?.weapon ?? 'fists');
    const spec = WEAPON_SPECS[weaponId] ?? WEAPON_SPECS.fists;
    const sameRoom = activeRoom(state, pid) === activeRoom(state, targetId);
    const rangedLine = !!spec.ranged && sameFloorLine(state, activeRoom(state, pid), activeRoom(state, targetId));
    if (!sameRoom && !rangedLine) return;

    let dice = attackDiceFor(player, weaponId);
    const attackRoll = rollZeroDice(state.prngState, dice);
    state.prngState = attackRoll.nextSeed;

    const defenseTrait: TraitKey = spec.mental ? 'sanity' : 'might';
    const defenseDice = Math.max(1, traitValue(target, defenseTrait));
    const defenseRoll = rollZeroDice(state.prngState, defenseDice);
    state.prngState = defenseRoll.nextSeed;

    player.customProps.attacksLeft = Math.max(0, Number(player.customProps.attacksLeft ?? 1) - 1);
    this.payWeaponCost(state, pid, weaponId, ctx);

    trace(
      ctx,
      'DICE_ROLL',
      `${player.name} 用${spec.name}攻击 ${target.name} · [${attackRoll.rolls.join('+')}]=${attackRoll.sum} vs [${defenseRoll.rolls.join('+')}]=${defenseRoll.sum}`,
      750
    );

    const diff = attackRoll.sum - defenseRoll.sum;
    if (diff > 0) {
      const wantsSteal = String(action.payload?.steal ?? 'no') === 'yes';
      const maySteal = !spec.mental && !spec.ranged;
      if (wantsSteal && maySteal && diff >= 2 && hasStealableItem(state, targetId)) {
        if (this.stealItem(state, pid, targetId, ctx)) return;
      }
      // Anything that cannot actually be stolen falls through to damage rather
      // than silently discarding the hit.
      this.openDamageWindow(state, targetId, diff, spec.mental ? 'MENTAL' : 'PHYSICAL', ctx, player.name);
      if (weaponId === 'blood_dagger') applyTraitSteps(state, pid, 'speed', -1);
    } else if (diff < 0) {
      if (spec.ranged) {
        trace(ctx, 'ANNOUNCEMENT', `${target.name} 反击落空——远程攻击不受反伤`, 350);
        return;
      }
      damagePlayer(state, pid, spec.mental ? 'MENTAL' : 'PHYSICAL', -diff);
      trace(ctx, 'DAMAGE_EFFECT', `${target.name} 反击 ${player.name}，造成 ${-diff} 点伤害`, 600);
    } else {
      trace(ctx, 'ANNOUNCEMENT', '双方势均力敌，无人受伤', 300);
    }
  }

  private static attackMonster(state: GameState, pid: PlayerId, action: Action, ctx: ReduceContext): void {
    const player = state.players[pid];
    const monster = state.entities[action.entityId ?? ''];
    if (!player || !monster || !monster.components.custom?.monster) return;
    if (monster.components.custom.destroyed) return;
    if (Number(player.customProps.attacksLeft ?? 0) <= 0) return;
    if (monster.components.custom.stunned) {
      if (monster.components.custom.monster === 'EYE') {
        player.customProps.attacksLeft = Math.max(0, Number(player.customProps.attacksLeft ?? 1) - 1);
        this.hitMonster(state, monster, ctx);
      } else {
        trace(ctx, 'ANNOUNCEMENT', `${monster.components.custom.name} 已被击晕，无法再次攻击`, 300);
      }
      return;
    }

    const weaponId = String(action.payload?.weapon ?? 'fists');
    const spec = WEAPON_SPECS[weaponId] ?? WEAPON_SPECS.fists;
    const monsterRoom = String(monster.components.custom.roomId ?? '');
    const sameRoom = monsterRoom === activeRoom(state, pid);
    const rangedLine = !!spec.ranged && sameFloorLine(state, activeRoom(state, pid), monsterRoom);
    if (!sameRoom && !rangedLine) return;

    const attackRoll = rollZeroDice(state.prngState, attackDiceFor(player, weaponId));
    state.prngState = attackRoll.nextSeed;

    const stats = monsterStats(monster);
    const penalty = Number(action.payload?.monsterMightPenalty ?? 0);
    const defenseTrait: TraitKey = spec.mental ? 'sanity' : 'might';
    const defenseValue = Math.max(1, (spec.mental ? stats.sanity : stats.might) - penalty);
    const defenseRoll = rollZeroDice(state.prngState, defenseValue);
    state.prngState = defenseRoll.nextSeed;

    player.customProps.attacksLeft = Math.max(0, Number(player.customProps.attacksLeft ?? 1) - 1);
    this.payWeaponCost(state, pid, weaponId, ctx);

    const diff = attackRoll.sum - defenseRoll.sum;
    trace(
      ctx,
      'DICE_ROLL',
      `${player.name} 攻击 ${monster.components.custom.name} · [${attackRoll.rolls.join('+')}]=${attackRoll.sum} vs [${defenseRoll.rolls.join('+')}]=${defenseRoll.sum}`,
      750
    );

    if (diff > 0) {
      if (monster.components.custom.immunePhysical && !spec.mental) {
        trace(ctx, 'ANNOUNCEMENT', `${monster.components.custom.name} 是虚体，物理武器穿身而过`, 450);
        return;
      }
      this.hitMonster(state, monster, ctx);
    } else if (diff < 0) {
      if (spec.ranged) {
        trace(ctx, 'ANNOUNCEMENT', '远程攻击失败，怪物无法反击', 300);
        return;
      }
      // Rulebook, Death and Stuns: "If a stunned monster is attacked and wins, it
      // deals no damage."
      if (monster.components.custom.stunned) {
        trace(ctx, 'ANNOUNCEMENT', '昏迷的怪物虽然挡住了攻击，却无力反击', 350);
        return;
      }
      damagePlayer(state, pid, monster.components.custom.attack === 'MENTAL' ? 'MENTAL' : 'PHYSICAL', -diff);
    } else {
      trace(ctx, 'ANNOUNCEMENT', '攻击被挡下', 300);
    }
  }

  private static hitMonster(state: GameState, monster: Entity, ctx: ReduceContext): void {
    const custom = monster.components.custom ?? {};
    if (custom.monster === 'EYE' && custom.stunned) {
      custom.destroyed = true;
      custom.stunned = false;
      const npc = Object.values(state.npcs ?? {}).find(entry => entry.entityId === monster.id);
      if (npc) npc.status = 'ELIMINATED';
      const haunt = currentHaunt(state);
      if (haunt) haunt.eyesDestroyed = Number(haunt.eyesDestroyed ?? 0) + 1;
      trace(ctx, 'DAMAGE_EFFECT', `💥 巨眼的晶状体碎裂，被彻底摧毁`, 900);
      if (haunt && Number(haunt.eyesDestroyed) >= 2) {
        trace(ctx, 'RULE_MUTATE', '所有巨眼已被摧毁，飞船信标暴露！', 900);
      }
      return;
    }
    this.stunMonster(state, monster);
  }

  private static stunMonster(state: GameState, monster: Entity): void {
    monster.components.custom = {
      ...(monster.components.custom ?? {}),
      stunned: true,
      stunTurns: monster.components.custom?.monster === 'EYE' ? 2 : 1
    };
    traceIdle(state, `${monster.components.custom.name} 被击晕，翻面`);
  }

  private static stealItem(state: GameState, thiefId: PlayerId, victimId: PlayerId, ctx: ReduceContext): boolean {
    const candidates = handEntities(state, victimId).filter(entity => isStealable(entity));
    if (candidates.length === 0) return false;
    const roll = DeterministicPRNG.nextInt(state.prngState, 0, candidates.length - 1);
    state.prngState = roll.nextSeed;
    const stolen = candidates[roll.value];
    const thiefHand = state.zones[`zone_hand_${thiefId}`];
    if (!thiefHand) return false;

    applyItemLoss(state, victimId, cardDef(stolen));
    applyOmenLoss(state, victimId, cardDef(stolen));
    stolen.ownerId = thiefId;
    const next = ECSManager.moveEntity(state, stolen.id, thiefHand.id);
    state.entities = next.entities;
    state.zones = next.zones;
    applyItemGain(state, thiefId, cardDef(stolen));
    applyOmenGain(state, thiefId, cardDef(stolen));
    this.updateResonanceFor(state, thiefId);
    this.updateResonanceFor(state, victimId);
    trace(ctx, 'TOKEN_TRANSFER', `🩸 ${state.players[thiefId].name} 抢走了「${itemLabel(stolen)}」`, 500);
    return true;
  }

  private static payWeaponCost(state: GameState, pid: PlayerId, weaponId: string, ctx: ReduceContext): void {
    const spec = WEAPON_SPECS[weaponId];
    if (!spec) return;
    if (spec.requiresSanityCheck) {
      const check = rollTraitCheck(state, pid, 'sanity', { threshold: spec.requiresSanityCheck, reason: '献祭匕首' });
      if (!check.success) {
        damagePlayer(state, pid, 'MENTAL', 1);
        trace(ctx, 'DAMAGE_EFFECT', '献祭匕首吸取了使用者的神智（-1）', 400);
      }
    }
    if (spec.selfCost) {
      applyTraitSteps(state, pid, spec.selfCost.trait, spec.selfCost.amount);
    }
  }

  private static slap(state: GameState, pid: PlayerId, targetId: string, ctx: ReduceContext): void {
    const target = state.players[targetId];
    const player = state.players[pid];
    if (!target || !player || !target.customProps.controlled) return;
    if (Number(player.customProps.attacksLeft ?? 0) <= 0) return;

    const attack = rollZeroDice(state.prngState, Math.max(1, traitValue(player, 'might')));
    state.prngState = attack.nextSeed;
    const defense = rollZeroDice(state.prngState, Math.max(1, traitValue(target, 'might')));
    state.prngState = defense.nextSeed;
    player.customProps.attacksLeft = Math.max(0, Number(player.customProps.attacksLeft ?? 1) - 1);

    if (attack.sum > defense.sum) {
      target.customProps.controlled = false;
      target.customProps.immuneMindControl = true;
      trace(ctx, 'ANNOUNCEMENT', `👋 ${player.name} 一巴掌打醒了 ${target.name}，其永久免疫心智控制`, 700);
    } else {
      trace(ctx, 'ANNOUNCEMENT', `${player.name} 没能唤醒 ${target.name}`, 400);
    }
  }

  private static openDamageWindow(
    state: GameState,
    playerId: PlayerId,
    amount: number,
    kind: 'PHYSICAL' | 'MENTAL',
    ctx: ReduceContext,
    source: string
  ): void {
    state.globalVars.pendingDamage = { playerId, amount, kind, source };
    const opened = openDecision(
      state,
      {
        kind: 'SIMULTANEOUS',
        title: `${state.players[playerId].name} 承受 ${amount} 点${kind === 'PHYSICAL' ? '肉体' : '精神'}伤害`,
        description: `来自 ${source}。选择要扣减的属性。`,
        participants: [playerId],
        secret: false,
        policy: { type: 'ALL_COMMITTED' },
        payload: { kind: 'damage', amount, damageKind: kind }
      },
      ctx.id('damage')
    );
    state.pendingDecisions = opened.state.pendingDecisions;
  }

  private static allocateDamage(state: GameState, pid: PlayerId, trait: string, ctx: ReduceContext): void {
    const pending = state.globalVars.pendingDamage as
      | { playerId: PlayerId; amount: number; kind: 'PHYSICAL' | 'MENTAL' }
      | null
      | undefined;
    if (!pending || pending.playerId !== pid) return;

    const allowed = TRAIT_OPTIONS[pending.kind].map(option => option.value);
    const chosen = allowed.includes(trait as TraitKey) ? (trait as TraitKey) : allowed[0];
    const result = damagePlayer(state, pid, pending.kind, pending.amount, chosen);
    state.globalVars.pendingDamage = null;
    trace(
      ctx,
      'DAMAGE_EFFECT',
      `${state.players[pid]?.name ?? pid} 在 ${TRAIT_META[chosen].zh} 上承受 ${result.applied} 点伤害${result.dead ? ' —— 死亡！' : ''}`,
      700
    );
    if (result.dead) trace(ctx, 'RULE_MUTATE', `${state.players[pid]?.name ?? pid} 死亡，物品散落一地`, 800);
  }

  /* ------------------------------------------------------------------ */
  /* Haunt                                                               */
  /* ------------------------------------------------------------------ */

  private static hauntRoll(state: GameState, pid: PlayerId, ctx: ReduceContext): void {
    const pending = state.globalVars.pendingHauntRoll as { playerId: PlayerId; omens: number } | null;
    const omens = Number(pending?.omens ?? state.globalVars.omensRevealed ?? 0);
    const roll = rollZeroDice(state.prngState, 6);
    state.prngState = roll.nextSeed;
    state.globalVars.lastHauntRoll = { rolls: roll.rolls, sum: roll.sum, omens };

    trace(
      ctx,
      'DICE_ROLL',
      `作祟检定 [${roll.rolls.join('+')}] = ${roll.sum} vs 预兆 ${omens}`,
      800
    );

    state.globalVars.pendingHauntRoll = null;

    if (roll.sum < omens) {
      const roomId = activeRoom(state, pid);
      const floor = (state.mapGraph.nodes[roomId]?.props?.floor ?? 'GROUND') as Floor;
      const lastOmen = [...(state.globalVars.omenNames ?? [])].pop();
      const heldOmen = handEntities(state, pid).find(entity => entity.components.custom?.cardType === 'OMEN');
      const omenId =
        Object.keys(OMEN_DEFS).find(id => OMEN_DEFS[id].name === lastOmen) ??
        (heldOmen ? cardDef(heldOmen) : 'girl');
      const hauntId = resolveHauntId(omenId, roomId, floor);
      this.startHaunt(state, pid, hauntId, roomId, ctx);
      return;
    }

    trace(ctx, 'ANNOUNCEMENT', '山庄暂时恢复了寂静……', 500);
    this.advanceTurn(state, ctx);
  }

  public static beginHaunt(
    state: GameState,
    revealerId: PlayerId,
    hauntId: string,
    roomId: string,
    ctx: ReduceContext
  ): void {
    this.startHaunt(state, revealerId, hauntId, roomId, ctx);
  }

  private static startHaunt(state: GameState, revealerId: PlayerId, hauntId: string, roomId: string, ctx: ReduceContext): void {
    const def = HAUNT_DEFS[hauntId];
    const traitor = state.players[revealerId];
    if (!def || !traitor) return;

    state.globalVars.hauntTriggered = true;
    state.phase = 'HAUNT';

    for (const pid of state.playerOrder) {
      const player = state.players[pid];
      if (!player) continue;
      player.role = pid === revealerId ? 'TRAITOR' : player.role === 'TRAITOR' ? 'HERO' : 'HERO';
    }

    // Rulebook, Traitor and Monster Powers: "When you become a traitor, prior
    // lingering bad effects from Event cards disappear." Curses like the drip used
    // to keep gnawing at the traitor for the rest of the game.
    removeEffects(state, effect => effect.target === revealerId && effect.kind === 'ONGOING');
    if (state.players[revealerId]) state.players[revealerId].customProps.effects = [];

    const haunt = {
      id: hauntId,
      number: def.number,
      title: def.title,
      intro: def.intro ?? '',
      traitorId: revealerId,
      revealRoomId: roomId,
      monsterIds: [] as string[],
      progress: 0,
      bonesFound: false,
      beaconDestroyed: false,
      eyesDestroyed: 0,
      girlHolder: undefined as string | undefined,
      mummyDelivered: false
    };
    state.globalVars.haunt = haunt;
    state.globalVars.hauntObjectives = { hero: def.heroObjective, traitor: def.traitorObjective };
    state.globalVars.frostRooms = [];

    // Scenario markers.
    if (hauntId === 'mummy') {
      this.spawnMarker(state, roomId, 'SARCOPHAGUS', '石棺', ctx);
      const girlHolder = state.playerOrder.find(id => state.players[id].role === 'HERO' && ownsDef(state, id, 'girl'));
      haunt.girlHolder = girlHolder ?? undefined;
      if (!girlHolder) this.spawnGirl(state, roomId, ctx);
    }
    if (hauntId === 'floating_eye') {
      this.spawnMarker(state, roomId, 'SHIP', '飞船信标', ctx);
      traitor.customProps.banished = true;
    }

    const npcIds: string[] = [];
    if (def.monster) {
      const template = def.monster;
      for (let i = 0; i < template.count; i++) {
        const monster = spawnMonster(
          state,
          roomId,
          template.kind,
          {
            name: template.count > 1 ? `${template.name} ${i + 1}` : template.name,
            might: template.might,
            speed: template.speed,
            sanity: template.sanity,
            attack: template.attack,
            control: template.control,
            incorporeal: template.incorporeal,
            immunePhysical: template.immunePhysical,
            immuneSpeedAttacks: template.immuneSpeedAttacks,
            color: template.color
          },
          ctx
        );
        const npcId = `npc_${monster.id}`;
        state.npcs = {
          ...(state.npcs ?? {}),
          [npcId]: {
            id: npcId,
            kind: 'NPC',
            name: String(monster.components.custom?.name ?? template.name),
            color: template.color,
            avatar: template.kind === 'MUMMY' ? '🧟' : template.kind === 'EYE' ? '👁️' : '👻',
            status: 'ACTIVE',
            controllerId: revealerId,
            entityId: monster.id,
            visibility: { type: 'PUBLIC' },
            customProps: { monsterKind: template.kind, roomId, movesLeft: 0, attacksLeft: 0 }
          }
        };
        npcIds.push(npcId);
        haunt.monsterIds.push(npcId);
        if (hauntId === 'mummy' && i === 0) {
          monster.components.custom = { ...(monster.components.custom ?? {}), carryingGirl: false };
        }
      }
    }

    // Turn order: players up to the traitor, then the traitor's monsters, then
    // the remaining heroes. The haunt starts with the hero after the traitor.
    const traitorIndex = Math.max(0, state.playerOrder.indexOf(revealerId));
    state.actorOrder = [
      ...state.playerOrder.slice(0, traitorIndex + 1),
      ...npcIds,
      ...state.playerOrder.slice(traitorIndex + 1)
    ];

    for (const [index, spec] of def.hooks.entries()) {
      state.activeHooks.push({
        instanceId: `hook_${hauntId}_${index}_${index}`,
        hookId: spec.hookId,
        ownerId: revealerId,
        visibility: { type: 'PUBLIC' },
        params: spec.params ?? {}
      });
    }

    state.activePlayerId = leftOf(state, revealerId);
    state.activeActorId = state.activePlayerId;
    state.turn += 1;
    resetTurnResources(state, state.activePlayerId);
    state.players[state.activePlayerId].customProps.ritualUsed = false;

    trace(ctx, 'RULE_MUTATE', `🔥 作祟降临 · 第 ${def.number} 号剧本「${def.title}」 · 叛徒：${traitor.name}`, 1600);
    trace(ctx, 'ANNOUNCEMENT', `英雄目标：${def.heroObjective}`, 1400);
    actionLogLine(state, `作祟 #${def.number} ${def.title} — 叛徒 ${traitor.name}`);
  }

  private static spawnMarker(state: GameState, roomId: string, marker: string, label: string, ctx: ReduceContext): Entity {
    const zone = ensureRoomZone(state, roomId);
    const entity: Entity = {
      id: ctx.id(`marker_${marker.toLowerCase()}`),
      type: 'CARD',
      zoneId: zone.id,
      visibility: { type: 'PUBLIC' },
      components: {
        cardFace: { title: label, type: 'MARKER', desc: label, color: '#d9b45b' },
        custom: { marker, zh: label, tradeable: false }
      }
    };
    const next = ECSManager.addEntity(state, entity);
    state.entities = next.entities;
    state.zones = next.zones;
    return state.entities[entity.id];
  }

  private static spawnGirl(state: GameState, roomId: string, ctx: ReduceContext): void {
    const zone = ensureRoomZone(state, roomId);
    const entity: Entity = {
      id: ctx.id('omen_girl'),
      type: 'CARD',
      zoneId: zone.id,
      visibility: { type: 'PUBLIC' },
      components: {
        cardFace: { title: '小女孩', type: 'OMEN', desc: OMEN_DEFS.girl.desc, color: '#b07bf0' },
        custom: { defId: 'girl', cardType: 'OMEN', zh: '小女孩', companion: true, tradeable: false }
      }
    };
    const next = ECSManager.addEntity(state, entity);
    state.entities = next.entities;
    state.zones = next.zones;
    state.globalVars.omensRevealed = Number(state.globalVars.omensRevealed ?? 0) + 1;
    state.globalVars.omenNames = [...(state.globalVars.omenNames ?? []), '小女孩'];
    trace(ctx, 'CARD_DRAW', `小女孩出现在 ${roomName(state, roomId)}`, 500);
  }

  private static sealRitual(state: GameState, pid: PlayerId, ctx: ReduceContext): void {
    const haunt = currentHaunt(state);
    const player = state.players[pid];
    if (!haunt || haunt.id !== 'mummy' || !player) return;
    if (player.customProps.ritualUsed) return;
    if (activeRoom(state, pid) !== haunt.revealRoomId) return;
    if (!ownsDef(state, pid, 'holy_symbol') && !ownsDef(state, pid, 'ring')) return;

    player.customProps.ritualUsed = true;
    const check = rollTraitCheck(state, pid, 'knowledge', { threshold: 5, reason: '封印木乃伊' });
    trace(ctx, 'DICE_ROLL', `神圣符文破译 · 知识 [${check.dice.join('+')}] = ${check.total} vs 5`, 800);
    if (check.success) {
      haunt.progress = Number(haunt.progress ?? 0) + 1;
      trace(ctx, 'RULE_MUTATE', `封印进度 ${haunt.progress}/2`, 900);
    } else {
      damagePlayer(state, pid, 'MENTAL', 1);
      trace(ctx, 'DAMAGE_EFFECT', '符文反噬，神智 -1', 500);
    }
  }

  private static searchBones(state: GameState, pid: PlayerId, ctx: ReduceContext): void {
    const haunt = currentHaunt(state);
    const player = state.players[pid];
    if (!haunt || haunt.id !== 'phantom' || !player) return;
    player.customProps.searchUsed = true;
    const check = rollTraitCheck(state, pid, 'knowledge', { threshold: 4, reason: '寻找遗骨' });
    trace(ctx, 'DICE_ROLL', `搜寻遗骨 · 知识 ${check.total} vs 4`, 700);
    if (check.success) {
      haunt.bonesFound = true;
      state.globalVars.bonesRoomId = activeRoom(state, pid);
      trace(ctx, 'RULE_MUTATE', `🦴 ${player.name} 在 ${roomName(state, activeRoom(state, pid))} 找到了怨灵的遗骨`, 900);
    }
  }

  private static chant(state: GameState, pid: PlayerId, ctx: ReduceContext): void {
    const haunt = currentHaunt(state);
    const player = state.players[pid];
    if (!haunt || haunt.id !== 'phantom' || !player) return;
    if (player.customProps.chantUsed) return;
    if (!roomTags(state, activeRoom(state, pid)).includes('pentagram')) return;
    if (!haunt.bonesFound || !ownsDef(state, pid, 'holy_symbol')) return;

    player.customProps.chantUsed = true;
    const check = rollTraitCheck(state, pid, 'sanity', { threshold: 5, reason: '安魂咏唱' });
    trace(ctx, 'DICE_ROLL', `安魂咏唱 · 神智 [${check.dice.join('+')}] = ${check.total} vs 5`, 900);
    if (check.success) {
      haunt.progress = Number(haunt.progress ?? 0) + 1;
      trace(ctx, 'RULE_MUTATE', `安魂仪式进度 ${haunt.progress}/3`, 900);
    } else {
      damagePlayer(state, pid, 'MENTAL', 1);
      trace(ctx, 'DAMAGE_EFFECT', '怨灵的哀嚎撕裂心智，神智 -1', 500);
    }
  }

  private static destroyBeacon(state: GameState, pid: PlayerId, ctx: ReduceContext): void {
    const haunt = currentHaunt(state);
    if (!haunt || haunt.id !== 'floating_eye') return;
    const eyesLeft = monsterEntities(state).filter(
      monster => monster.components.custom?.monster === 'EYE' && !monster.components.custom?.destroyed
    );
    if (eyesLeft.length > 0) return;
    haunt.beaconDestroyed = true;
    trace(ctx, 'RULE_MUTATE', `💥 ${state.players[pid].name} 炸毁了飞船信标，母舰开始坠落！`, 1200);
  }

  private static brewHolyWater(state: GameState, pid: PlayerId, ctx: ReduceContext): void {
    const player = state.players[pid];
    if (!player) return;
    player.customProps.brewUsed = true;
    const check = rollTraitCheck(state, pid, 'knowledge', {
      threshold: 4,
      reason: '配制圣水',
      effect: '成功：获得一瓶圣水；失败：材料白费'
    });
    trace(ctx, 'DICE_ROLL', `调配圣水 · 知识 [${check.dice.join('+')}] = ${check.total} vs 4`, 800);
    if (check.success) {
      grantScenarioItem(state, pid, 'holy_water', {
        name: '圣水',
        en: 'Holy Water',
        desc: '在五芒星堂倒入圣水池完成圣化仪式；或对亡者投掷造成净化。',
        kind: 'relic'
      });
      trace(ctx, 'RULE_MUTATE', `⚗️ 【${player.name}】在实验台成功调配出了【圣水】！`, 900);
    } else {
      trace(ctx, 'ANNOUNCEMENT', `⚗️ 【${player.name}】调配圣水失败，试管中的液体蒸发了。`, 600);
    }
  }

  private static sanctifyHouse(state: GameState, pid: PlayerId, ctx: ReduceContext): void {
    const player = state.players[pid];
    const haunt = currentHaunt(state);
    if (!player || !haunt || haunt.id !== 'living_dead') return;
    player.customProps.sanctifyUsed = true;
    const check = rollTraitCheck(state, pid, 'knowledge', {
      threshold: 4,
      reason: '圣化洋馆',
      effect: '成功：圣化进度 +1（需 2 次）；失败：仪式中断'
    });
    trace(ctx, 'DICE_ROLL', `圣水池注圣 · 知识 [${check.dice.join('+')}] = ${check.total} vs 4`, 900);
    if (check.success) {
      haunt.progress = Number(haunt.progress ?? 0) + 1;
      trace(ctx, 'RULE_MUTATE', `✨ 【${player.name}】将圣水倒入圣水池！（圣化进度：${haunt.progress}/2）`, 1000);
    } else {
      damagePlayer(state, pid, 'MENTAL', 1);
      trace(ctx, 'DAMAGE_EFFECT', '阴风骤起扑灭了烛光，神智 -1', 500);
    }
  }

  private static forgeSilver(state: GameState, pid: PlayerId, ctx: ReduceContext): void {
    const player = state.players[pid];
    if (!player) return;
    player.customProps.forgeUsed = true;
    const check = rollTraitCheck(state, pid, 'might', {
      threshold: 4,
      reason: '打造银弹',
      effect: '成功：得到银弹；失败：银料报废'
    });
    trace(ctx, 'DICE_ROLL', `打造银弹 · 力量 [${check.dice.join('+')}] = ${check.total} vs 4`, 800);
    if (check.success) {
      grantScenarioItem(state, pid, 'silver_bullets', {
        name: '银色子弹',
        en: 'Silver Bullets',
        desc: '受祝福的纯银弹药。对狼人进行攻击时力量骰额外 +3。',
        kind: 'weapon'
      });
      trace(ctx, 'RULE_MUTATE', `⚔️ 【${player.name}】成功铸造了对付狂兽的【银色子弹】！`, 900);
    } else {
      trace(ctx, 'ANNOUNCEMENT', `坩埚火候不足，银弹浇筑失败。`, 600);
    }
  }

  private static suppressCurse(state: GameState, pid: PlayerId, ctx: ReduceContext): void {
    const player = state.players[pid];
    const haunt = currentHaunt(state);
    if (!player || !haunt || haunt.id !== 'werewolf') return;
    player.customProps.suppressUsed = true;
    const check = rollTraitCheck(state, pid, 'knowledge', { threshold: 4, reason: '月相压制' });
    trace(ctx, 'DICE_ROLL', `月相压制 · 知识 [${check.dice.join('+')}] = ${check.total} vs 4`, 900);
    if (check.success) {
      haunt.progress = Number(haunt.progress ?? 0) + 1;
      trace(ctx, 'RULE_MUTATE', `🌕 【${player.name}】引导星光压制满月诅咒！（压制进度：${haunt.progress}/3）`, 1000);
    } else {
      damagePlayer(state, pid, 'PHYSICAL', 1);
      trace(ctx, 'DAMAGE_EFFECT', '狼人感应到了星象干扰发出怒嚎，力量震荡受到 1 点创伤', 500);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Turn flow & monsters                                                */
  /* ------------------------------------------------------------------ */

  private static endTurn(state: GameState, pid: PlayerId, ctx: ReduceContext): void {
    // Settle room debuffs for explorers ending their turn in hazardous rooms (Furnace, Crypt, Pentagram, etc.)
    this.settleRoomEndTurnDebuff(state, pid, ctx);

    const pending = state.globalVars.pendingHauntRoll as { playerId: PlayerId; omens: number } | null;
    if (pending && pending.playerId === pid && !state.globalVars.hauntTriggered) {
      const frame: StackFrame = {
        id: ctx.id('haunt_frame'),
        type: 'HAUNT_CHECK',
        title: '作祟检定',
        description: `${state.players[pid].name} 必须掷 6 颗骰：总和 < ${pending.omens} 则作祟爆发。`,
        sourcePlayerId: pid,
        actionPayload: { type: 'ROLL_HAUNT_CHECK', playerId: pid },
        responseWindow: {
          eligiblePlayers: [pid],
          pendingResponses: { [pid]: 'PENDING' }
        },
        status: 'WAITING_INPUT'
      };
      const pushed = InterruptStackManager.push(state, frame);
      state.interruptStack = pushed.interruptStack;
      trace(ctx, 'STACK_PUSH', '⚠️ 预兆在低语，作祟检定被推入响应栈', 600);
      return;
    }

    if (state.globalVars.hauntTriggered && (state.players[pid]?.role === 'TRAITOR' || state.players[pid]?.customProps.banished)) {
      // Monsters are NPC actors with their own turns now; nothing auto-runs here.
      trace(ctx, 'ANNOUNCEMENT', '怪物回合由叛徒逐只操控', 250);
    }

    this.advanceTurn(state, ctx);
  }

  private static nextEligibleActor(state: GameState, fromId: string): string {
    const order = state.actorOrder ?? state.playerOrder;
    const start = Math.max(0, order.indexOf(fromId));
    for (let i = 1; i <= order.length; i++) {
      const candidate = order[(start + i) % order.length];
      const player = state.players[candidate];
      if (player) {
        if (player.alive && !player.customProps.banished) return candidate;
        continue;
      }
      const npc = state.npcs?.[candidate];
      if (npc && npc.status === 'ACTIVE') return candidate;
    }
    return fromId;
  }

  private static advanceTurn(state: GameState, ctx: ReduceContext, depth = 0): void {
    const order = state.actorOrder ?? state.playerOrder;
    const current = state.activeActorId ?? state.activePlayerId;
    const next = this.nextEligibleActor(state, current);
    const currentIndex = order.indexOf(current);
    const nextIndex = order.indexOf(next);

    state.activeActorId = next;
    state.turn += 1;
    if (nextIndex >= 0 && nextIndex <= currentIndex) state.round += 1;

    const npc = state.npcs?.[next];
    if (npc) {
      if (npc.controllerId && state.players[npc.controllerId]) state.activePlayerId = npc.controllerId;
      this.startNpcTurn(state, npc, ctx);
      trace(ctx, 'ANNOUNCEMENT', `— ${npc.name}（NPC · ${npc.controllerId ? state.players[npc.controllerId]?.name ?? npc.controllerId : '剧本'} 控制）的回合 —`, 300);
      return;
    }

    state.activePlayerId = next;
    resetTurnResources(state, next);
    state.players[next].customProps.ritualUsed = false;
    state.players[next].customProps.chantUsed = false;
    state.players[next].customProps.searchUsed = false;
    state.players[next].customProps.elevatorUsed = false;
    state.players[next].customProps.brewUsed = false;
    state.players[next].customProps.sanctifyUsed = false;
    state.players[next].customProps.forgeUsed = false;
    state.players[next].customProps.suppressUsed = false;

    this.startOfTurn(state, next, ctx);
    trace(ctx, 'ANNOUNCEMENT', `— ${state.players[next].name} 的回合 —`, 300);

    if (!state.players[next].alive && depth < 4) {
      this.advanceTurn(state, ctx, depth + 1);
    }
  }

  private static startNpcTurn(
    state: GameState,
    npc: NonNullable<GameState['npcs']>[string],
    ctx: ReduceContext
  ): void {
    const entity = npc.entityId ? state.entities[npc.entityId] : undefined;
    const custom = entity?.components.custom ?? {};
    npc.customProps = { ...(npc.customProps ?? {}), movesLeft: 0, attacksLeft: 0 };
    if (!entity || custom.destroyed || npc.status !== 'ACTIVE') return;
    if (custom.stunned) {
      trace(ctx, 'ANNOUNCEMENT', `${npc.name} 仍处于击晕状态，跳过本回合`, 400);
      return;
    }
    const stats = monsterStats(entity);
    const roll = rollZeroDice(state.prngState, Math.max(1, stats.speed));
    state.prngState = roll.nextSeed;
    npc.customProps.movesLeft = roll.sum;
    npc.customProps.attacksLeft = 1;
    trace(ctx, 'DICE_ROLL', `${npc.name} 速度骰 [${roll.rolls.join('+')}] = ${roll.sum}`, 500);
  }

  private static endNpcTurn(state: GameState, npcId: string, ctx: ReduceContext): void {
    const npc = state.npcs?.[npcId];
    if (!npc?.entityId) {
      this.advanceTurn(state, ctx);
      return;
    }
    const entity = state.entities[npc.entityId];
    const custom = entity?.components.custom ?? {};
    if (custom.stunned) {
      const turns = Number(custom.stunTurns ?? 1) - 1;
      custom.stunTurns = turns;
      if (turns <= 0) {
        custom.stunned = false;
        trace(ctx, 'ANNOUNCEMENT', `${npc.name} 恢复了行动`, 350);
      }
    }
    const haunt = currentHaunt(state);
    if (
      haunt?.id === 'mummy' &&
      custom.monster === 'MUMMY' &&
      custom.carryingGirl &&
      String(custom.roomId) === haunt.revealRoomId
    ) {
      haunt.mummyDelivered = true;
      trace(ctx, 'RULE_MUTATE', '木乃伊把小女孩放入石棺——封印完成！', 1400);
    }
    this.advanceTurn(state, ctx);
  }

  /**
   * Room debuffs that specifically take effect only when ending the turn in that room
   * (Furnace room, Pentagram Chamber, Crypt, Graveyard, etc.).
   */
  private static settleRoomEndTurnDebuff(state: GameState, pid: PlayerId, ctx: ReduceContext): void {
    const player = state.players[pid];
    if (!player || !player.alive || player.role === 'TRAITOR') return;
    const roomId = activeRoom(state, pid);
    const room = state.mapGraph.nodes[roomId];
    if (!room) return;

    const special = room.props?.special as string | null;
    const tags = roomTags(state, roomId);

    // 1. 熔炉房：回合结束停留在此受到 1 点物理伤害（仅穿行无伤）
    if (special === 'FURNACE') {
      damagePlayer(state, pid, 'PHYSICAL', 1);
      trace(ctx, 'DAMAGE_EFFECT', `🔥 ${player.name} 在熔炉房结束回合，被高温灼伤（1 点物理伤害）`, 500);
    }

    // House rule: some rooms reward ending your turn in them with a permanent +1,
    // once per explorer per game. Recorded per room so re-entering never re-pays.
    const buff = room.props?.endTurnBuff as 'speed' | 'might' | 'sanity' | 'knowledge' | undefined;
    if (buff) {
      const claimed = new Set<string>((player.customProps.roomBuffs as string[]) ?? []);
      if (!claimed.has(roomId)) {
        claimed.add(roomId);
        player.customProps.roomBuffs = [...claimed];
        applyTraitSteps(state, pid, buff, 1, { force: true });
        trace(
          ctx,
          'ANNOUNCEMENT',
          `💪 ${player.name} 在${String(room.props.name)}练有所成：永久 +1 ${TRAIT_META[buff].zh}`,
          700
        );
      }
    }

    // 2. 邪恶/不洁房间：回合结束停留在此进行神智检定
    if (tags.includes('crypt')) {
      if (!ownsDef(state, pid, 'medallion')) {
        const check = rollTraitCheck(state, pid, 'sanity', { threshold: 4, reason: 'unholy room', label: '不洁房间' });
        trace(ctx, 'DICE_ROLL', `${room.props.name} · 神智检定 ${check.total} vs 4`, 600);
        if (!check.success) {
          damagePlayer(state, pid, 'MENTAL', 1);
          trace(ctx, 'DAMAGE_EFFECT', `👻 ${room.props.name} 的阴冷寒气侵蚀 ${player.name}（1 点精神伤害）`, 500);
        }
      }
    }
  }

  private static startOfTurn(state: GameState, pid: PlayerId, ctx: ReduceContext): void {
    const player = state.players[pid];
    if (!player) return;

    // Ongoing curses live on the kernel effect list; `ongoingEffectKinds` also
    // folds in the legacy `customProps.effects` array so old logs still replay.
    for (const effect of ongoingEffectKinds(state, pid)) {
      if (effect === 'DRIP') {
        // Card text: the check happens at the start of your turn while you are in
        // a *windowless* room. Outside rooms (garden, balcony, patio) have windows,
        // so they are exempt - previously this fired every turn anywhere.
        const dripRoom = activeRoom(state, pid);
        const hasWindows = roomTags(state, dripRoom).includes('outside');
        if (!hasWindows) {
          const check = rollTraitCheck(state, pid, 'sanity', { threshold: 5, reason: '滴血之声' });
          if (!check.success) damagePlayer(state, pid, 'MENTAL', 1);
        }
      } else if (effect === 'POSSESSION') {
        const check = rollTraitCheck(state, pid, 'sanity', { threshold: 4, reason: '恶灵附体' });
        if (!check.success) {
          player.customProps.skipActions = true;
          trace(ctx, 'ANNOUNCEMENT', `${player.name} 被恶灵夺走身体，本回合无法行动`, 700);
        }
      } else if (effect === 'CHILL') {
        const check = rollTraitCheck(state, pid, 'sanity', { threshold: 5, reason: '刺骨寒意' });
        if (!check.success) damagePlayer(state, pid, 'MENTAL', 1);
      } else if (effect === 'HAUNTING_MELODY') {
        const check = rollTraitCheck(state, pid, 'knowledge', { threshold: 5, reason: '萦绕旋律' });
        if (!check.success) applyTraitSteps(state, pid, 'knowledge', -1);
      } else if (effect === 'MARK_OF_FEAR') {
        const check = rollTraitCheck(state, pid, 'sanity', { threshold: 4, reason: '恐惧印记' });
        if (!check.success) damagePlayer(state, pid, 'MENTAL', 1);
      }
    }

    if (player.customProps.controlled) {
      const haunt = currentHaunt(state);
      if (!haunt) return;
      const target = haunt.revealRoomId;
      if (activeRoom(state, pid) === target) {
        player.alive = false;
        player.customProps.abducted = true;
        player.customProps.controlled = false;
        trace(ctx, 'RULE_MUTATE', `🛸 ${player.name} 被拖入飞船，消失在地球之外`, 1100);
        this.dropAll(state, pid);
        return;
      }
      const path = shortestPath(state, activeRoom(state, pid), target);
      if (path.length > 1) {
        movePlayerTo(state, pid, path[1]);
        trace(ctx, 'MOVE_OBJECT', `${player.name} 目光空洞地走向飞船`, 600);
      }
      player.customProps.movesLeft = 0;
      player.customProps.attacksLeft = 0;
      player.customProps.skipActions = true;
    }
  }

  private static dropAll(state: GameState, pid: PlayerId): void {
    const player = state.players[pid];
    if (!player) return;
    const hand = state.zones[`zone_hand_${pid}`];
    if (!hand) return;
    const zone = ensureRoomZone(state, activeRoom(state, pid));
    for (const entityId of [...hand.orderedEntities]) {
      const entity = state.entities[entityId];
      if (!entity) continue;
      entity.ownerId = undefined;
      const next = ECSManager.moveEntity(state, entityId, zone.id);
      state.entities = next.entities;
      state.zones = next.zones;
    }
  }

  /** @deprecated Kept for reference; monsters now run as NPC actors. */
  private static monsterPhase(state: GameState, ctx: ReduceContext): void {
    const monsters = monsterEntities(state).filter(monster => !monster.components.custom?.destroyed);
    if (monsters.length === 0) return;

    trace(ctx, 'ANNOUNCEMENT', '👹 怪物回合', 400);

    for (const monster of monsters) {
      const custom = monster.components.custom ?? {};
      if (custom.stunned) {
        const turns = Number(custom.stunTurns ?? 1) - 1;
        custom.stunTurns = turns;
        if (turns <= 0) {
          custom.stunned = false;
          trace(ctx, 'ANNOUNCEMENT', `${custom.name} 恢复了行动`, 350);
        }
        continue;
      }

      const haunt = currentHaunt(state);
      if (!haunt) continue;
      const roomId = String(custom.roomId ?? '');
      const stats = monsterStats(monster);

      if (custom.monster === 'MUMMY' && !custom.carryingGirl) {
        const roomZone = state.zones[`zone_room_${roomId}`];
        const girl = (roomZone?.orderedEntities ?? [])
          .map(id => state.entities[id])
          .find(entity => entity && cardDef(entity) === 'girl');
        if (girl) {
          custom.carryingGirl = true;
          haunt.girlHolder = monster.id;
          girl.ownerId = undefined;
          const next = ECSManager.moveEntity(state, girl.id, 'zone_monsters');
          state.entities = next.entities;
          state.zones = next.zones;
          trace(ctx, 'RULE_MUTATE', '木乃伊从物品堆中抱起了小女孩', 800);
        }
      }

      const targetRoom =
        custom.monster === 'MUMMY' && custom.carryingGirl
          ? haunt.revealRoomId
          : this.nearestHeroRoom(state, roomId, custom.monster);

      const stepRoll = rollZeroDice(state.prngState, Math.max(1, stats.speed));
      state.prngState = stepRoll.nextSeed;
      const steps = stepRoll.sum;

      const path = shortestPath(state, roomId, targetRoom, custom.incorporeal === true);
      const maxSteps = Math.min(steps, path.length - 1);
      for (let i = 1; i <= maxSteps; i++) {
        moveMonster(state, monster.id, path[i]);
        if (custom.monster === 'PHANTOM') addFrost(state, path[i]);
      }

      const currentRoom = String(monster.components.custom?.roomId ?? '');
      trace(ctx, 'MOVE_OBJECT', `${custom.name} 移动 ${Math.max(0, maxSteps)} 步至 ${roomName(state, currentRoom)}`, 450);

      if (custom.monster === 'MUMMY' && custom.carryingGirl && currentRoom === haunt.revealRoomId) {
        haunt.mummyDelivered = true;
        trace(ctx, 'RULE_MUTATE', '木乃伊把小女孩放入石棺——封印完成！', 1400);
        return;
      }

      const victims = playersInRoom(state, currentRoom).filter(id => state.players[id].role !== 'TRAITOR');
      const victimId = victims[0];
      if (!victimId) continue;

      this.monsterAttack(state, monster, victimId, ctx);
    }
  }

  private static nearestHeroRoom(state: GameState, fromRoomId: string, monsterKind: string): string {
    const heroes = state.playerOrder.filter(
      id => state.players[id]?.alive && state.players[id].role !== 'TRAITOR' && !state.players[id].customProps.banished
    );
    let best = fromRoomId;
    let bestDistance = Infinity;
    for (const heroId of heroes) {
      const roomId = activeRoom(state, heroId);
      const distance = shortestPath(state, fromRoomId, roomId, monsterKind === 'PHANTOM').length;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = roomId;
      }
    }
    return best;
  }

  private static monsterAttack(state: GameState, monster: Entity, victimId: PlayerId, ctx: ReduceContext): void {
    const custom = monster.components.custom ?? {};
    const stats = monsterStats(monster);
    const victim = state.players[victimId];
    if (!victim) return;

    const attackDice = rollZeroDice(state.prngState, Math.max(1, stats.might));
    state.prngState = attackDice.nextSeed;

    const mental = custom.attack === 'MENTAL';
    const defenseTrait: TraitKey = mental ? 'sanity' : 'might';
    const defense = rollZeroDice(state.prngState, Math.max(1, traitValue(victim, defenseTrait)));
    state.prngState = defense.nextSeed;

    trace(
      ctx,
      'DICE_ROLL',
      `${custom.name} 攻击 ${victim.name} · [${attackDice.rolls.join('+')}]=${attackDice.sum} vs [${defense.rolls.join('+')}]=${defense.sum}`,
      700
    );

    if (attackDice.sum > defense.sum) {
      const diff = attackDice.sum - defense.sum;
      if (custom.monster === 'EYE' && custom.control) {
        if (!victim.customProps.immuneMindControl) {
          victim.customProps.controlled = true;
          trace(ctx, 'RULE_MUTATE', `👁️ ${victim.name} 被巨眼夺走了心智`, 900);
        }
      } else if (custom.monster === 'MUMMY') {
        const girlHolder = currentHaunt(state)?.girlHolder;
        const girl = handEntities(state, victimId).find(entity => cardDef(entity) === 'girl');
        damagePlayer(state, victimId, 'PHYSICAL', diff, 'might');
        if (girlHolder === victimId) {
          const haunt = currentHaunt(state);
          if (haunt) haunt.girlHolder = monster.id;
          custom.carryingGirl = true;
          if (girl) {
            girl.ownerId = undefined;
            const next = ECSManager.moveEntity(state, girl.id, 'zone_monsters');
            state.entities = next.entities;
            state.zones = next.zones;
          }
          trace(ctx, 'RULE_MUTATE', '木乃伊夺走了小女孩，开始走向石棺', 1100);
        }
      } else {
        damagePlayer(state, victimId, mental ? 'MENTAL' : 'PHYSICAL', diff);
      }
    } else if (defense.sum > attackDice.sum) {
      this.stunMonster(state, monster);
      trace(ctx, 'ANNOUNCEMENT', `${victim.name} 击退了 ${custom.name}，怪物被击晕`, 600);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Outcomes & decision cleanup                                          */
  /* ------------------------------------------------------------------ */

  public static onDecisionResolved(state: GameState, window: DecisionWindow): GameState {
    const s: GameState = JSON.parse(JSON.stringify(state));

    if (window.payload?.kind === 'damage') {
      const pending = s.globalVars.pendingDamage as
        | { playerId: PlayerId; amount: number; kind: 'PHYSICAL' | 'MENTAL' }
        | null;
      if (pending) {
        const traits = TRAIT_OPTIONS[pending.kind];
        damagePlayer(s, pending.playerId, pending.kind, pending.amount, traits[0].value);
        s.globalVars.pendingDamage = null;
      }
    }

    if (window.payload?.kind === 'trade') {
      s.globalVars.tradeOffer = null;
    }

    if (window.payload?.kind === 'peek') {
      s.globalVars.peek = null;
    }

    return s;
  }

  public static checkWinCondition(state: GameState): { gameOver: boolean; winner: PlayerId | PlayerId[] | null; reason?: string } {
    if (!state.globalVars.hauntTriggered) return { gameOver: false, winner: null };

    const haunt = currentHaunt(state);
    const heroes = heroesOf(state);
    const traitor = traitorOf(state);

    if (!haunt) return { gameOver: false, winner: null };

    const allHeroesOut = heroes.length === 0;

    if (haunt.id === 'mummy') {
      if (Number(haunt.progress ?? 0) >= 2) {
        return { gameOver: true, winner: heroes, reason: '石棺重新封印，木乃伊归于尘土' };
      }
      if (haunt.mummyDelivered) {
        return { gameOver: true, winner: traitor, reason: '木乃伊带走了小女孩' };
      }
    }

    if (haunt.id === 'phantom') {
      if (Number(haunt.progress ?? 0) >= 3) {
        return { gameOver: true, winner: heroes, reason: '安魂仪式完成，怨灵消散' };
      }
    }

    if (haunt.id === 'floating_eye') {
      if (haunt.beaconDestroyed) {
        return { gameOver: true, winner: heroes, reason: '飞船信标被炸毁，母舰坠入云层' };
      }
    }

    if (haunt.id === 'living_dead') {
      if (Number(haunt.progress ?? 0) >= 2) {
        return { gameOver: true, winner: heroes, reason: '圣水净化了洋馆，死者重归安息' };
      }
    }

    if (haunt.id === 'werewolf') {
      if (Number(haunt.progress ?? 0) >= 3) {
        return { gameOver: true, winner: heroes, reason: '月相压制仪式完成，狼人诅咒被彻底驱散' };
      }
      const werewolfLeft = monsterEntities(state).filter(
        monster => monster.components.custom?.monster === 'WEREWOLF' && !monster.components.custom?.destroyed
      );
      if (werewolfLeft.length === 0) {
        return { gameOver: true, winner: heroes, reason: '银器贯穿了狂兽的心脏，狼人倒在血泊中' };
      }
    }

    if (allHeroesOut) {
      return { gameOver: true, winner: traitor, reason: '所有英雄都已死亡或被带走' };
    }

    if (traitor && !state.players[traitor]?.alive && haunt.id !== 'floating_eye') {
      return { gameOver: true, winner: heroes, reason: '叛徒死亡' };
    }

    return { gameOver: false, winner: null };
  }
}

/* -------------------------------------------------------------------------- */
/* Local utilities                                                             */
/* -------------------------------------------------------------------------- */

function traceIdle(state: GameState, text: string): void {
  state.globalVars.lastNarration = text;
}

function graphDistances(state: GameState, from: string): Map<string, number> {
  const distances = new Map<string, number>();
  if (!state.mapGraph.nodes[from]) return distances;
  distances.set(from, 0);
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const distance = distances.get(current)!;
    for (const neighbor of state.mapGraph.nodes[current]?.neighbors ?? []) {
      if (!distances.has(neighbor)) {
        distances.set(neighbor, distance + 1);
        queue.push(neighbor);
      }
    }
  }
  return distances;
}

function shortestPath(state: GameState, from: string, to: string, throughWalls = false): string[] {
  if (from === to) return [from];
  if (!state.mapGraph.nodes[from] || !state.mapGraph.nodes[to]) return [from];

  const previous = new Map<string, string>();
  const seen = new Set<string>([from]);
  const queue = [from];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === to) break;

    const node = state.mapGraph.nodes[current];
    const neighbors = new Set<string>(node?.neighbors ?? []);

    if (throughWalls) {
      const grid = nodeGrid(node);
      if (grid) {
        for (const other of Object.values(state.mapGraph.nodes)) {
          const otherGrid = nodeGrid(other);
          if (!otherGrid || otherGrid.floor !== grid.floor) continue;
          const distance = Math.abs(otherGrid.col - grid.col) + Math.abs(otherGrid.row - grid.row);
          if (distance === 1) neighbors.add(other.id);
        }
      }
    }

    for (const neighbor of [...neighbors].sort()) {
      if (seen.has(neighbor)) continue;
      seen.add(neighbor);
      previous.set(neighbor, current);
      queue.push(neighbor);
    }
  }

  if (!seen.has(to)) return [from];
  const path = [to];
  let cursor = to;
  while (cursor !== from) {
    const parent = previous.get(cursor);
    if (!parent) break;
    path.unshift(parent);
    cursor = parent;
  }
  return path;
}

void TRAIT_OPTIONS_KEYS;
