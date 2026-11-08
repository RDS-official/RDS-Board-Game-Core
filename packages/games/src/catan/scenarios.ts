import { GameState, PlayerId } from '@rds/kernel/types';
import { setupCatan } from './setup';
import {
  addDevCardToHand,
  distanceRuleOk,
  normalize,
  placeBuilding,
  placeRoad
} from './helpers';

export interface CatanScenario {
  description?: string;
  /** These fixture positions deal a fixed three-seat table. */
  seats?: number;
  setup: (seed: number) => GameState;
}

function completeSetup(state: GameState): GameState {
  const vertices = Object.values(state.mapGraph.nodes)
    .filter(node => node.type === 'VERTEX')
    .map(node => node.id);
  const edges = Object.values(state.mapGraph.edges);

  const usedVertices = new Set<string>();
  const usedEdges = new Set<string>();
  let cursor = 0;

  for (const pid of state.playerOrder) {
    for (let placement = 0; placement < 2; placement++) {
      let vertex: string | null = null;
      while (cursor < vertices.length && !vertex) {
        const candidate = vertices[cursor++];
        if (usedVertices.has(candidate) || !distanceRuleOk(state, candidate)) continue;
        if ([...usedVertices].some(id => state.mapGraph.nodes[id].neighbors.includes(candidate))) continue;
        vertex = candidate;
      }
      if (!vertex) continue;

      usedVertices.add(vertex);
      placeBuilding(state, pid, vertex, 'SETTLEMENT', `scenario_settlement_${pid}_${placement}`);

      const edge = edges.find(
        candidate => !usedEdges.has(candidate.id) && (candidate.from === vertex || candidate.to === vertex)
      );
      if (edge) {
        usedEdges.add(edge.id);
        placeRoad(state, pid, edge.id, `scenario_road_${pid}_${placement}`);
      }
    }
  }

  state.globalVars.setupIndex = (state.globalVars.setupOrder as string[]).length;
  state.globalVars.setupLastVertex = null;
  state.activePlayerId = 'p1';
  state.phase = 'ACTION';
  state.turn = 2;
  state.round = 1;
  normalize(state);
  return state;
}

/** Replace a player's hand and move the delta through the bank (conservative). */
function setResources(state: GameState, pid: PlayerId, next: Record<string, number>): void {
  const player = state.players[pid];
  const current = player.customProps.resources as Record<string, number>;
  const bank = state.globalVars.bank as Record<string, number>;

  for (const resource of ['wood', 'brick', 'sheep', 'wheat', 'ore']) {
    const before = Number(current[resource] ?? 0);
    const after = Number(next[resource] ?? 0);
    bank[resource] -= after - before;
  }

  player.customProps = { ...player.customProps, resources: { ...next } };
}

export const CATAN_SCENARIOS: Record<string, CatanScenario> = {
  rich_action: {
    description: 'Setup complete, p1 has resources and a playable Year of Plenty',
    seats: 3,
    setup: (seed: number): GameState => {
      const state = completeSetup(setupCatan(seed));
      setResources(state, 'p1', { wood: 8, brick: 8, sheep: 8, wheat: 8, ore: 8 });
      setResources(state, 'p2', { wood: 0, brick: 3, sheep: 0, wheat: 0, ore: 0 });

      const deck = state.zones.zone_dev_deck.orderedEntities;
      const year = deck.find(id => state.entities[id]?.components.custom?.devType === 'year_of_plenty');
      if (year) addDevCardToHand(state, 'p1', year, 0);

      const monopoly = state.zones.zone_dev_deck.orderedEntities.find(
        id => state.entities[id]?.components.custom?.devType === 'monopoly'
      );
      if (monopoly) addDevCardToHand(state, 'p1', monopoly, 0);

      normalize(state);
      return state;
    }
  },

  trade_ready: {
    description: 'Setup complete, p1 has wood and p2 has brick',
    seats: 3,
    setup: (seed: number): GameState => {
      const state = completeSetup(setupCatan(seed));
      setResources(state, 'p1', { wood: 5, brick: 0, sheep: 0, wheat: 0, ore: 0 });
      setResources(state, 'p2', { wood: 0, brick: 5, sheep: 0, wheat: 0, ore: 0 });
      return state;
    }
  }
};
