import { RuleRegistry } from './rules';
import { MapGraphManager } from './graph';
import { OccupancyIndex } from './occupancy';
import { isSerializableState } from './serialize';
import { FollowUpFrame, GameState } from './types';

export interface InvariantViolation {
  code: string;
  message: string;
}

export class KernelInvariantError extends Error {
  constructor(public readonly violations: InvariantViolation[]) {
    super(`State invariant violation: ${violations.map(v => `${v.code} — ${v.message}`).join('; ')}`);
    this.name = 'KernelInvariantError';
  }
}

/**
 * Structural invariants every module state must satisfy.
 * These are checked after each transition while `strict` is enabled.
 */
export function checkInvariants(state: GameState, rules: RuleRegistry): InvariantViolation[] {
  const errors: InvariantViolation[] = [];
  const push = (code: string, message: string) => errors.push({ code, message });

  const checkContinuation = (owner: string, frames?: FollowUpFrame[]) => {
    for (const frame of frames ?? []) {
      if (!frame?.action || typeof frame.action.type !== 'string') {
        push('FOLLOW_UP_BAD_ACTION', `${owner} has a follow-up without an action type`);
      }
      if (!Number.isInteger(frame?.depth) || frame.depth < 0) {
        push('FOLLOW_UP_BAD_DEPTH', `${owner} has a follow-up with an invalid depth`);
      }
    }
  };

  /* Players ------------------------------------------------------------- */
  const order = state.playerOrder;
  if (order.length === 0) push('PLAYERS_EMPTY', 'playerOrder is empty');
  if (new Set(order).size !== order.length) push('PLAYERS_DUPLICATE', 'playerOrder contains duplicates');

  for (const pid of order) {
    if (!state.players[pid]) push('PLAYER_MISSING', `playerOrder references missing player ${pid}`);
  }

  if (!state.players[state.activePlayerId]) {
    push('ACTIVE_PLAYER_MISSING', `activePlayerId ${state.activePlayerId} is not a player`);
  }

  /* Actors / NPCs --------------------------------------------------------- */
  const activeActorId = state.activeActorId ?? state.activePlayerId;
  if (!state.players[activeActorId] && !state.npcs?.[activeActorId]) {
    push('ACTIVE_ACTOR_MISSING', `activeActorId ${activeActorId} is not a player or NPC`);
  }

  for (const [id, npc] of Object.entries(state.npcs ?? {})) {
    if (npc.id !== id) push('NPC_ID_MISMATCH', `npc key ${id} != npc.id ${npc.id}`);
    if (npc.kind !== 'NPC') push('NPC_KIND_INVALID', `npc ${id} has kind ${npc.kind}`);
    if (!['ACTIVE', 'DEAD', 'ELIMINATED', 'SPECTATOR'].includes(npc.status)) {
      push('NPC_STATUS_INVALID', `npc ${id} has status ${npc.status}`);
    }
    if (npc.entityId && !state.entities[npc.entityId]) {
      push('NPC_ENTITY_MISSING', `npc ${id} references missing entity ${npc.entityId}`);
    }
    if (npc.controllerId && !state.players[npc.controllerId] && !state.npcs?.[npc.controllerId]) {
      push('NPC_CONTROLLER_MISSING', `npc ${id} controller ${npc.controllerId} does not exist`);
    }
    if (state.players[id]) push('ACTOR_ID_COLLISION', `npc ${id} collides with a player id`);
  }

  if (state.actorOrder) {
    if (new Set(state.actorOrder).size !== state.actorOrder.length) {
      push('ACTOR_ORDER_DUPLICATE', 'actorOrder contains duplicates');
    }
    for (const id of state.actorOrder) {
      if (!state.players[id] && !state.npcs?.[id]) {
        push('ACTOR_ORDER_UNKNOWN', `actorOrder references unknown actor ${id}`);
      }
    }
    if (!state.actorOrder.includes(activeActorId)) {
      push('ACTOR_ORDER_MISSING_ACTIVE', `actorOrder does not include active actor ${activeActorId}`);
    }
  }

  /* Entities and zones --------------------------------------------------- */
  let entityCount = 0;
  for (const [id, entity] of Object.entries(state.entities)) {
    entityCount++;
    if (entity.id !== id) push('ENTITY_ID_MISMATCH', `entity key ${id} != entity.id ${entity.id}`);
    if (!state.zones[entity.zoneId]) push('ENTITY_ZONE_MISSING', `entity ${id} lives in missing zone ${entity.zoneId}`);
  }

  const seenEntities = new Set<string>();
  for (const [zoneId, zone] of Object.entries(state.zones)) {
    const localSeen = new Set<string>();
    for (const entityId of zone.orderedEntities) {
      if (localSeen.has(entityId)) push('ZONE_DUPLICATE_ENTITY', `zone ${zoneId} contains ${entityId} twice`);
      localSeen.add(entityId);

      if (seenEntities.has(entityId)) {
        push('ENTITY_MULTI_ZONE', `entity ${entityId} appears in more than one zone`);
      }
      seenEntities.add(entityId);

      const entity = state.entities[entityId];
      if (!entity) {
        push('ZONE_DANGLING_ENTITY', `zone ${zoneId} references missing entity ${entityId}`);
      } else if (entity.zoneId !== zoneId) {
        push('ENTITY_ZONE_DESYNC', `entity ${entityId}.zoneId=${entity.zoneId} but is listed in ${zoneId}`);
      }
    }
  }

  for (const id of Object.keys(state.entities)) {
    if (!seenEntities.has(id)) push('ENTITY_ORPHAN', `entity ${id} is not listed in any zone`);
  }

  /* Map graph ------------------------------------------------------------ */
  for (const [nodeId, node] of Object.entries(state.mapGraph.nodes)) {
    if (node.id !== nodeId) push('NODE_ID_MISMATCH', `node key ${nodeId} != node.id ${node.id}`);
    if (node.position.some(v => !Number.isFinite(v))) push('NODE_BAD_POSITION', `node ${nodeId} has non-finite position`);
    for (const neighbor of node.neighbors) {
      if (!state.mapGraph.nodes[neighbor]) push('NODE_DANGLING_NEIGHBOR', `node ${nodeId} -> missing neighbor ${neighbor}`);
    }
  }
  for (const [edgeId, edge] of Object.entries(state.mapGraph.edges)) {
    if (edge.id !== edgeId) push('EDGE_ID_MISMATCH', `edge key ${edgeId} != edge.id ${edge.id}`);
    if (!state.mapGraph.nodes[edge.from]) push('EDGE_DANGLING_FROM', `edge ${edgeId} from missing node ${edge.from}`);
    if (!state.mapGraph.nodes[edge.to]) push('EDGE_DANGLING_TO', `edge ${edgeId} to missing node ${edge.to}`);
  }

  for (const error of MapGraphManager.validateTopology(state.mapGraph)) {
    push('TOPOLOGY_INVALID', error);
  }

  const effectIds = new Set<string>();
  for (const effect of state.effects ?? []) {
    if (effectIds.has(effect.id)) push('EFFECT_DUPLICATE_ID', `effect ${effect.id} is duplicated`);
    effectIds.add(effect.id);
    if (!state.players[effect.source] && !state.npcs?.[effect.source]) {
      push('EFFECT_UNKNOWN_SOURCE', `effect ${effect.id} source ${effect.source} does not exist`);
    }
    if (!state.players[effect.target] && !state.npcs?.[effect.target] && !state.entities[effect.target]) {
      push('EFFECT_UNKNOWN_TARGET', `effect ${effect.id} target ${effect.target} does not exist`);
    }
    if (effect.expiresAt?.turn !== undefined && !Number.isFinite(effect.expiresAt.turn)) {
      push('EFFECT_INVALID_EXPIRY', `effect ${effect.id} has invalid turn expiry`);
    }
    if (effect.expiresAt?.clock !== undefined && !Number.isFinite(effect.expiresAt.clock)) {
      push('EFFECT_INVALID_EXPIRY', `effect ${effect.id} has invalid clock expiry`);
    }
  }

  /* Two-phase roll windows (K4) ------------------------------------------ */
  const rollWindowIds = new Set<string>();
  for (const window of state.rollWindows ?? []) {
    if (rollWindowIds.has(window.id)) {
      push('ROLL_WINDOW_DUPLICATE_ID', `roll window ${window.id} is duplicated`);
    }
    rollWindowIds.add(window.id);

    const actorKnown = (id: string) => !!state.players[id] || !!state.npcs?.[id];
    if (!actorKnown(window.actorId)) {
      push('ROLL_WINDOW_UNKNOWN_ACTOR', `roll window ${window.id} actor ${window.actorId} unknown`);
    }
    for (const slot of [...window.declares, ...window.reacts]) {
      if (!actorKnown(slot.actorId)) {
        push('ROLL_WINDOW_UNKNOWN_SLOT', `roll window ${window.id} slot actor ${slot.actorId} unknown`);
      }
      for (const picked of slot.picked) {
        if (!slot.options.includes(picked)) {
          push('ROLL_WINDOW_BAD_PICK', `roll window ${window.id} picked ${picked} not in its options`);
        }
      }
      if (new Set(slot.picked).size !== slot.picked.length) {
        push('ROLL_WINDOW_DUPLICATE_PICK', `roll window ${window.id} picked ${slot.actorId} twice`);
      }
    }
    if (window.phase === 'DECLARE' && window.result) {
      push('ROLL_WINDOW_PREMATURE_RESULT', `roll window ${window.id} has a result while still declaring`);
    }
    if (window.result && !Number.isFinite(window.result.total)) {
      push('ROLL_WINDOW_BAD_RESULT', `roll window ${window.id} has a non-finite total`);
    }
  }

  /* Interrupt stack Σ ---------------------------------------------------- */
  const frameIds = new Set<string>();
  for (const frame of state.interruptStack) {
    if (frameIds.has(frame.id)) push('STACK_DUPLICATE_FRAME', `duplicate stack frame id ${frame.id}`);
    frameIds.add(frame.id);

    if (frame.responseWindow) {
      const window = frame.responseWindow;
      if (new Set(window.eligiblePlayers).size !== window.eligiblePlayers.length) {
        push('STACK_DUPLICATE_ELIGIBLE', `frame ${frame.id} lists duplicate eligible players`);
      }
      for (const pid of window.eligiblePlayers) {
        if (!state.players[pid] && !state.npcs?.[pid]) {
          push('STACK_UNKNOWN_PLAYER', `frame ${frame.id} eligible actor ${pid} unknown`);
        }
        if (!(pid in window.pendingResponses)) {
          push('STACK_MISSING_RESPONSE', `frame ${frame.id} missing pending response for ${pid}`);
        }
      }
      for (const pid of Object.keys(window.pendingResponses)) {
        if (!window.eligiblePlayers.includes(pid)) {
          push('STACK_EXTRA_RESPONSE', `frame ${frame.id} has response for ineligible ${pid}`);
        }
      }
    }

    if (frame.actionPayload && typeof frame.actionPayload === 'object') {
      if (typeof frame.actionPayload.type !== 'string') push('STACK_BAD_PAYLOAD', `frame ${frame.id} payload has no action type`);
    }

    checkContinuation(`frame ${frame.id}`, frame.followUpContinuation);
  }

  /* Decision windows ----------------------------------------------------- */
  for (const window of state.pendingDecisions) {
    if (new Set(window.participants).size !== window.participants.length) {
      push('DECISION_DUPLICATE_PARTICIPANT', `decision ${window.id} has duplicate participants`);
    }
    for (const pid of window.participants) {
      if (!state.players[pid] && !state.npcs?.[pid]) {
        push('DECISION_UNKNOWN_PLAYER', `decision ${window.id} references unknown actor ${pid}`);
      }
    }
    for (const pid of Object.keys(window.submissions)) {
      if (!window.participants.includes(pid)) {
        push('DECISION_EXTRA_SUBMISSION', `decision ${window.id} submission from non-participant ${pid}`);
      }
    }

    checkContinuation(`decision ${window.id}`, window.followUpContinuation);
  }

  /* Rule hooks ----------------------------------------------------------- */
  const hookIds = new Set<string>();
  for (const hook of state.activeHooks) {
    if (hookIds.has(hook.instanceId)) push('HOOK_DUPLICATE_INSTANCE', `duplicate hook instance ${hook.instanceId}`);
    hookIds.add(hook.instanceId);
    if (!rules.has(hook.hookId)) push('HOOK_UNKNOWN_IMPL', `active hook ${hook.hookId} has no registered implementation`);
  }

  /* Counters ------------------------------------------------------------- */
  if (!Number.isInteger(state.seq) || state.seq < 0) push('SEQ_INVALID', 'seq must be a non-negative integer');
  if (!Number.isInteger(state.clock) || state.clock < 0) push('CLOCK_INVALID', 'clock must be a non-negative integer');
  if (!Number.isInteger(state.round) || state.round < 0) push('ROUND_INVALID', 'round must be a non-negative integer');
  if (!Number.isInteger(state.turn) || state.turn < 0) push('TURN_INVALID', 'turn must be a non-negative integer');
  if (!Number.isInteger(state.prngState)) push('PRNG_INVALID', 'prngState must be an integer');

  for (const window of state.pendingDecisions) {
    if (window.deadline !== undefined && (!Number.isInteger(window.deadline) || window.deadline < 0)) {
      push('DECISION_DEADLINE_INVALID', `decision ${window.id} has an invalid deadline`);
    }
    for (const [pid, deadline] of Object.entries(window.participantDeadlines ?? {})) {
      if (!window.participants.includes(pid)) {
        push('DECISION_DEADLINE_PARTICIPANT', `decision ${window.id} has a deadline for non-participant ${pid}`);
      }
      if (!Number.isInteger(deadline) || deadline < 0) {
        push('DECISION_DEADLINE_INVALID', `decision ${window.id} has an invalid participant deadline`);
      }
    }
  }
  for (const frame of state.interruptStack) {
    const deadline = frame.responseWindow?.deadline;
    if (deadline !== undefined && (!Number.isInteger(deadline) || deadline < 0)) {
      push('STACK_DEADLINE_INVALID', `frame ${frame.id} has an invalid deadline`);
    }
  }

  if (entityCount !== Object.keys(state.entities).length) {
    push('ENTITY_COUNT_MISMATCH', 'entity count drifted');
  }

  for (const message of OccupancyIndex.validate(state)) {
    push('SLOT_INVALID', message);
  }

  /* Serializability ------------------------------------------------------ */
  const serializable = isSerializableState(state);
  if (!serializable.ok) push('STATE_NOT_SERIALIZABLE', serializable.error || 'state is not JSON serializable');

  return errors;
}

export function assertInvariants(state: GameState, rules: RuleRegistry): void {
  const violations = checkInvariants(state, rules);
  if (violations.length > 0) throw new KernelInvariantError(violations);
}
