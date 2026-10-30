import { projectDecision } from './decisions';
import { hmacSha256Hex } from './sha256';
import {
  Action,
  Entity,
  FactionRelation,
  GameState,
  Npc,
  Player,
  PlayerId,
  ProjectedGameState,
  VisibilityRule
} from './types';

/**
 * Optional module-level redaction hooks. They run on the projection path and
 * exist so modules can hide custom data that the generic observer cannot know
 * about (secret role fields, private global variables, …).
 */
export interface ProjectionRedactor {
  globalVars?: (
    vars: Record<string, unknown>,
    state: GameState,
    viewer: PlayerId | 'GOD'
  ) => Record<string, unknown>;
  player?: (player: Player, viewer: PlayerId | 'GOD', state: GameState) => Player;
}

/**
 * Information observation & cognitive filter O(s, i).
 *
 * Anti-cheat guarantees:
 *  - hidden entities never leave the server with their private components;
 *  - hidden entities are re-keyed with session-stable virtual ids;
 *  - zone listings are re-keyed consistently;
 *  - secret decision submissions collapse to COMMITTED.
 */
export class CognitiveObserver {
  private static aliasCache: Record<string, Record<string, string>> = {};

  public static resetAliases(): void {
    this.aliasCache = {};
  }

  public static getVirtualAlias(viewerId: string, realId: string, aliasSecret?: string): string {
    const cacheKey = aliasSecret ? `${aliasSecret}::${viewerId}` : viewerId;
    if (!this.aliasCache[cacheKey]) this.aliasCache[cacheKey] = {};
    if (!this.aliasCache[cacheKey][realId]) {
      if (aliasSecret) {
        const mac = hmacSha256Hex(aliasSecret, `${viewerId}::${realId}`);
        this.aliasCache[cacheKey][realId] = `v_id_${mac.slice(0, 16)}`;
      } else {
        let hash = 2166136261;
        const seedText = `${viewerId}::${realId}`;
        for (let i = 0; i < seedText.length; i++) {
          hash ^= seedText.charCodeAt(i);
          hash = Math.imul(hash, 16777619);
        }
        this.aliasCache[cacheKey][realId] = `v_id_${(hash >>> 0).toString(36)}`;
      }
    }
    return this.aliasCache[cacheKey][realId];
  }

  public static isVisibleTo(visibility: VisibilityRule, viewerId: PlayerId | 'GOD', ownerId?: PlayerId): boolean {
    if (viewerId === 'GOD') return true;
    switch (visibility.type) {
      case 'PUBLIC':
        return true;
      case 'OWNER_ONLY':
        return visibility.ownerId === viewerId || ownerId === viewerId;
      case 'SUBSET':
        return visibility.playerIds.includes(viewerId);
      case 'HIDDEN':
        return false;
      default:
        return false;
    }
  }

  public static projectState(
    state: GameState,
    viewerId: PlayerId | 'GOD',
    legalActionProvider?: (s: GameState, pId: PlayerId) => Action[],
    redactor?: ProjectionRedactor,
    aliasSecret?: string
  ): ProjectedGameState {
    const projectedEntities: Record<string, Partial<Entity> & { isMasked?: boolean }> = {};
    const idRemap: Record<string, string> = {};
    let maskedCount = 0;

    for (const entity of Object.values(state.entities)) {
      if (this.isVisibleTo(entity.visibility, viewerId, entity.ownerId)) {
        idRemap[entity.id] = entity.id;
        projectedEntities[entity.id] = { ...entity, isMasked: false };
      } else {
        maskedCount++;
        const virtualId = this.getVirtualAlias(viewerId, entity.id, aliasSecret);
        idRemap[entity.id] = virtualId;
        projectedEntities[virtualId] = {
          id: virtualId,
          type: entity.type,
          zoneId: entity.zoneId,
          ownerId: entity.ownerId,
          visibility: entity.visibility,
          components: {
            spatial: entity.components.spatial,
            cardFace: entity.components.cardFace
              ? { title: 'Hidden', type: 'UNKNOWN', desc: 'face-down' }
              : undefined,
            dice: entity.components.dice
              ? { value: 0, sides: entity.components.dice.sides, isRolling: entity.components.dice.isRolling }
              : undefined
          },
          isMasked: true
        };
      }
    }

    const projectedZones: GameState['zones'] = {};
    for (const zone of Object.values(state.zones)) {
      projectedZones[zone.id] = {
        ...zone,
        orderedEntities: zone.orderedEntities.map(id => idRemap[id] ?? this.getVirtualAlias(viewerId, id, aliasSecret))
      };
    }

    const visibleNodeIds = new Set<string>();
    const projectedNodes: GameState['mapGraph']['nodes'] = {};
    let maskedNodeCount = 0;
    for (const [id, node] of Object.entries(state.mapGraph.nodes)) {
      const visibility = node.visibility ?? { type: 'PUBLIC' as const };
      if (!this.isVisibleTo(visibility, viewerId)) {
        maskedNodeCount++;
        continue;
      }
      visibleNodeIds.add(id);
      projectedNodes[id] = { ...node, neighbors: [] };
    }
    for (const [id, node] of Object.entries(projectedNodes)) {
      node.neighbors = state.mapGraph.nodes[id].neighbors.filter(neighbor => visibleNodeIds.has(neighbor));
    }

    const projectedEdges: GameState['mapGraph']['edges'] = {};
    let maskedEdgeCount = 0;
    for (const [id, edge] of Object.entries(state.mapGraph.edges)) {
      const visibility = edge.visibility ?? { type: 'PUBLIC' as const };
      if (
        !this.isVisibleTo(visibility, viewerId) ||
        !visibleNodeIds.has(edge.from) ||
        !visibleNodeIds.has(edge.to)
      ) {
        maskedEdgeCount++;
        continue;
      }
      projectedEdges[id] = { ...edge };
    }

    const projectedMapGraph: GameState['mapGraph'] = {
      nodes: projectedNodes,
      edges: projectedEdges,
      topology: state.mapGraph.topology
    };

    const factionTopology: Record<PlayerId, Record<PlayerId, FactionRelation>> = {};
    for (const p1 of state.playerOrder) {
      factionTopology[p1] = {};
      for (const p2 of state.playerOrder) {
        factionTopology[p1][p2] = this.evaluateFactionRelation(state, p1, p2, viewerId);
      }
    }

    const projectedPlayers: Record<PlayerId, Player> = {};
    for (const [id, player] of Object.entries(state.players)) {
      const scrubbed = redactor?.player && viewerId !== 'GOD' ? redactor.player(player, viewerId, state) : player;
      projectedPlayers[id] = JSON.parse(JSON.stringify(scrubbed)) as Player;
    }

    const legalActions =
      viewerId !== 'GOD' && legalActionProvider ? legalActionProvider(state, viewerId) : [];
    const visibleEdgeIds = new Set(Object.keys(projectedEdges));
    const filteredLegalActions = legalActions
      .filter(
        action =>
          (!action.targetNodeId || visibleNodeIds.has(action.targetNodeId)) &&
          (!action.targetEdgeId || visibleEdgeIds.has(action.targetEdgeId)) &&
          (!action.entityId || !!projectedEntities[action.entityId])
      )
      .map(action => {
        if (!action.selection?.scope) return action;
        const scope = { ...action.selection.scope };
        if (Array.isArray(scope.neighbors)) {
          scope.neighbors = scope.neighbors.filter(id => visibleNodeIds.has(String(id)));
        }
        if (Array.isArray(scope.entities)) {
          scope.entities = scope.entities.filter(id => !!projectedEntities[String(id)]);
        }
        if (Array.isArray(scope.players)) {
          scope.players = scope.players.filter(id => !!projectedPlayers[String(id)]);
        }
        return { ...action, selection: { ...action.selection, scope } };
      });

    const projectedNpcs: Record<string, Npc> = {};
    for (const [id, npc] of Object.entries(state.npcs ?? {})) {
      const visibility = npc.visibility ?? { type: 'PUBLIC' as const };
      if (!this.isVisibleTo(visibility, viewerId, npc.controllerId)) continue;
      projectedNpcs[id] = JSON.parse(JSON.stringify(npc)) as Npc;
    }

    const actorOrder =
      viewerId === 'GOD'
        ? state.actorOrder
        : state.actorOrder?.filter(id => !!projectedPlayers[id] || !!projectedNpcs[id]);    const activeActorId =
      viewerId === 'GOD' || !state.activeActorId
        ? state.activeActorId
        : projectedPlayers[state.activeActorId] || projectedNpcs[state.activeActorId]
        ? state.activeActorId
        : undefined;

    const projectedVars =
      redactor?.globalVars && viewerId !== 'GOD'
        ? redactor.globalVars(state.globalVars, state, viewerId)
        : state.globalVars;

    const projectedEffects = (state.effects ?? [])
      .filter(effect => this.isVisibleTo(effect.visibility ?? { type: 'PUBLIC' }, viewerId))
      .map(effect => JSON.parse(JSON.stringify(effect)));

    return {
      gameId: state.gameId,
      seq: state.seq,
      clock: state.clock,
      round: state.round,
      turn: state.turn,
      activePlayerId: state.activePlayerId,
      activeActorId,
      phase: state.phase,
      players: projectedPlayers,
      playerOrder: state.playerOrder,
      npcs: projectedNpcs,
      actorOrder,
      entities: projectedEntities,
      zones: projectedZones,
      mapGraph: projectedMapGraph,
      effects: projectedEffects,
      globalVars: projectedVars,
      interruptStack: state.interruptStack,
      pendingDecisions: state.pendingDecisions.map(w => projectDecision(w, viewerId)),
      activeHooks: state.activeHooks.filter(h => this.isVisibleTo(h.visibility, viewerId, h.ownerId)),
      // The action log is public audit data. Entity ids and payloads are stripped:
      // payloads can contain secret bids, and real entity ids would defeat the
      // virtual-alias scheme. Clients only need type / actor / public targets.
      actionLog: state.actionLog.map(action => ({
        type: action.type,
        playerId: action.playerId,
        ...(action.actorId ? { actorId: action.actorId } : {}),
        ...(action.targetPlayerId ? { targetPlayerId: action.targetPlayerId } : {}),
        ...(action.targetNodeId ? { targetNodeId: action.targetNodeId } : {}),
        ...(action.targetEdgeId ? { targetEdgeId: action.targetEdgeId } : {})
      })),
      winner: state.winner,
      gameOver: state.gameOver,
      // The outcome reason is public once the game ends; the UI needs it to
      // explain why the table stopped instead of showing a bare "no actions".
      ...(state.gameOver && state.winnerReason ? { winnerReason: state.winnerReason } : {}),
      viewerId,
      legalActions: filteredLegalActions,
      factionTopology,
      maskedEntityCount: maskedCount,
      maskedNodeCount,
      maskedEdgeCount
    };
  }

  public static evaluateFactionRelation(
    state: GameState,
    pA: PlayerId,
    pB: PlayerId,
    viewerId: PlayerId | 'GOD'
  ): FactionRelation {
    if (pA === pB) return 'ALLIED';

    const playerA = state.players[pA];
    const playerB = state.players[pB];
    if (!playerA || !playerB) return 'NEUTRAL';

    if (playerA.role && playerB.role) {
      if (playerA.role === 'LORD' && playerB.role === 'LOYALIST') return 'ALLIED';
      if (playerA.role === 'LORD' && playerB.role === 'REBEL') return 'HOSTILE';
      if (playerA.role === 'REBEL' && playerB.role === 'REBEL') return 'ALLIED';
      if (playerA.role === 'REBEL' && playerB.role === 'LOYALIST') return 'HOSTILE';

      if (viewerId !== 'GOD' && pA !== viewerId && pB !== viewerId) {
        if (playerA.secretRole || playerB.secretRole) return 'UNKNOWN';
      }
    }

    if (state.globalVars.hauntTriggered) {
      const traitorA = playerA.role === 'TRAITOR';
      const traitorB = playerB.role === 'TRAITOR';
      if (traitorA && traitorB) return 'ALLIED';
      if (traitorA !== traitorB) return 'HOSTILE';
      return 'ALLIED';
    }

    if (playerA.role === 'LANDLORD' || playerB.role === 'LANDLORD') {
      return playerA.role === playerB.role ? 'ALLIED' : 'HOSTILE';
    }

    return 'NEUTRAL';
  }
}
