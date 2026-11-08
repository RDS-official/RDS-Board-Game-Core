import { ECSManager } from '@rds/kernel/ecs';
import { MapGraphManager } from '@rds/kernel/graph';
import type { GameSetupOptions } from '@rds/kernel/module';
import { DeterministicPRNG } from '@rds/kernel/prng';
import { Entity, GameState, Player } from '@rds/kernel/types';

export type CatanResource = 'wood' | 'brick' | 'sheep' | 'wheat' | 'ore';
export type CatanPortType = '3:1' | '2:1';

export const CATAN_RESOURCES: CatanResource[] = ['wood', 'brick', 'sheep', 'wheat', 'ore'];

export const RESOURCE_COLORS: Record<CatanResource | 'desert', string> = {
  wood: '#2e7d32',
  brick: '#c62828',
  sheep: '#8bc34a',
  wheat: '#fbc02d',
  ore: '#78909c',
  desert: '#d7ccc8'
};

export interface CatanPort {
  id: string;
  edgeId: string;
  type: CatanPortType;
  resource?: CatanResource;
  vertices: [string, string];
  position: [number, number, number];
}

export function setupCatan(seed: number = 42, options?: GameSetupOptions): GameState {
  let prngSeed = seed;

  // Base Catan seats three or four players. Fixed-roster callers that ask for
  // anything outside that range are clamped here; `seatsAccepted()` is what
  // refuses the room before setup ever runs.
  const requestedSeats = Number(options?.seats ?? 3);
  const seats = Number.isFinite(requestedSeats)
    ? Math.max(3, Math.min(4, Math.floor(requestedSeats)))
    : 3;
  const requestedHumans = Number(options?.humans ?? seats);
  const humans = Number.isFinite(requestedHumans)
    ? Math.max(1, Math.min(seats, Math.floor(requestedHumans)))
    : seats;

  const seatBlueprints = [
    { id: 'p1', name: 'Player 1 (Red)', color: '#e53935', avatar: '🔴' },
    { id: 'p2', name: 'Player 2 (Blue)', color: '#1e88e5', avatar: '🔵' },
    { id: 'p3', name: 'Player 3 (Orange)', color: '#fb8c00', avatar: '🟠' },
    { id: 'p4', name: 'Player 4 (Green)', color: '#43a047', avatar: '🟢' }
  ];
  const playerOrder = seatBlueprints.slice(0, seats).map(entry => entry.id);
  const players: Record<string, Player> = {};
  playerOrder.forEach((pid, index) => {
    const seated = seatBlueprints[index];
    players[pid] = {
      id: pid,
      name: seated.name,
      color: seated.color,
      avatar: seated.avatar,
      score: 0,
      alive: true,
      ...(index >= humans ? { isAI: true } : {}),
      handZoneId: `zone_dev_${pid}`,
      customProps: {
        resources: { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 },
        knightsPlayed: 0
      }
    };
  });

  const mapGraph = MapGraphManager.generateCatanHexDualGraph(2.15);
  mapGraph.topology = {
    kind: 'hex',
    adjacency: 'both',
    geometry: 'hex',
    geometrySpec: { cellSize: 2.15, hexOrientation: 'pointy' }
  };

  const resourcePool: (CatanResource | 'desert')[] = [
    'wood', 'wood', 'wood', 'wood',
    'brick', 'brick', 'brick',
    'sheep', 'sheep', 'sheep', 'sheep',
    'wheat', 'wheat', 'wheat', 'wheat',
    'ore', 'ore', 'ore',
    'desert'
  ];
  const numberChits = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];

  const shuffledResources = DeterministicPRNG.shuffle(prngSeed, resourcePool);
  prngSeed = shuffledResources.nextSeed;
  const shuffledNumbers = DeterministicPRNG.shuffle(prngSeed, numberChits);
  prngSeed = shuffledNumbers.nextSeed;

  const hexNodes = Object.values(mapGraph.nodes).filter(node => node.type === 'HEX');
  let numberIndex = 0;
  let robberHexId = '';

  hexNodes.forEach((node, index) => {
    const resource = shuffledResources.result[index] ?? 'wood';
    const diceNumber = resource === 'desert' ? 0 : shuffledNumbers.result[numberIndex++] ?? 6;
    node.props = {
      ...node.props,
      resource,
      diceNumber,
      hasRobber: resource === 'desert'
    };
    if (resource === 'desert') robberHexId = node.id;
  });

  // Harbours: nine coastal edges, five 2:1 and four 3:1.
  const coastEdges = Object.values(mapGraph.edges)
    .filter(edge => {
      const from = mapGraph.nodes[edge.from];
      const to = mapGraph.nodes[edge.to];
      return from && to && (from.props.hexIds?.length ?? 0) < 3 && (to.props.hexIds?.length ?? 0) < 3;
    })
    .map(edge => {
      const from = mapGraph.nodes[edge.from];
      const to = mapGraph.nodes[edge.to];
      const x = (from.position[0] + to.position[0]) / 2;
      const z = (from.position[2] + to.position[2]) / 2;
      return { edge, x, z, angle: Math.atan2(z, x) };
    })
    .sort((a, b) => a.angle - b.angle);

  const portTypes: (CatanResource | null)[] = ['wood', 'brick', 'sheep', 'wheat', 'ore', null, null, null, null];
  const shuffledPorts = DeterministicPRNG.shuffle(prngSeed, portTypes);
  prngSeed = shuffledPorts.nextSeed;

  const ports: CatanPort[] = [];
  const count = coastEdges.length;
  for (let i = 0; i < 9 && count > 0; i++) {
    const pick = coastEdges[Math.floor((i * count) / 9) % count];
    const resource = shuffledPorts.result[i] ?? null;
    const length = Math.max(0.001, Math.hypot(pick.x, pick.z));
    const outward = 1.15;
    ports.push({
      id: `port_${i}`,
      edgeId: pick.edge.id,
      type: resource ? '2:1' : '3:1',
      resource: resource ?? undefined,
      vertices: [pick.edge.from, pick.edge.to],
      position: [pick.x + (pick.x / length) * outward, 0.35, pick.z + (pick.z / length) * outward]
    });
  }

  const setupOrder = [...playerOrder, ...[...playerOrder].reverse()];

  let state: GameState = {
    gameId: 'catan',
    seed: prngSeed,
    seq: 0,
    clock: 0,
    round: 1,
    turn: 1,
    activePlayerId: setupOrder[0],
    phase: 'SETUP_SETTLEMENT',
    players,
    playerOrder,
    entities: {},
    zones: {},
    mapGraph,
    globalVars: {
      bank: { wood: 19, brick: 19, sheep: 19, wheat: 19, ore: 19 },
      ports,
      robberHexId,
      lastDiceRoll: [0, 0],
      diceSum: 0,
      setupOrder,
      setupIndex: 0,
      setupLastVertex: null,
      tradeOffer: null,
      tradeGive: null,
      resourcePicks: 0,
      freeRoads: 0,
      longestRoadOwner: null,
      largestArmyOwner: null,
      robberReason: null
    },
    interruptStack: [],
    pendingDecisions: [],
    activeHooks: [],
    prngState: prngSeed,
    actionLog: [],
    winner: null,
    gameOver: false
  };

  playerOrder.forEach(pid => {
    state = ECSManager.createZone(state, `zone_dev_${pid}`, `${players[pid].name} Development Cards`, 'HAND', {
      type: 'OWNER_ONLY',
      ownerId: pid
    }, pid);
  });

  state = ECSManager.createZone(state, 'zone_board', 'Island Board', 'BOARD', { type: 'PUBLIC' });
  state = ECSManager.createZone(state, 'zone_dev_deck', 'Development Deck', 'DECK', { type: 'HIDDEN' }, undefined, 'STACK', [7.6, 0.06, 3.2]);
  state = ECSManager.createZone(state, 'zone_dev_discard', 'Development Discard', 'DISCARD', { type: 'PUBLIC' }, undefined, 'STACK', [6.2, 0.06, 3.2]);

  const devDeck: { devType: 'knight' | 'monopoly' | 'road_building' | 'year_of_plenty' | 'vp'; title: string; desc: string }[] = [
    ...Array.from({ length: 14 }, () => ({
      devType: 'knight' as const,
      title: 'Knight',
      desc: 'Move the robber and steal 1 resource. Counts toward Largest Army.'
    })),
    ...Array.from({ length: 2 }, () => ({
      devType: 'monopoly' as const,
      title: 'Monopoly',
      desc: 'Take all of one resource from every other player.'
    })),
    ...Array.from({ length: 2 }, () => ({
      devType: 'road_building' as const,
      title: 'Road Building',
      desc: 'Place two roads for free.'
    })),
    ...Array.from({ length: 2 }, () => ({
      devType: 'year_of_plenty' as const,
      title: 'Year of Plenty',
      desc: 'Take any two resources from the bank.'
    })),
    ...['Market', 'Town Hall', 'Cathedral', 'University', 'Library'].map(title => ({
      devType: 'vp' as const,
      title,
      desc: 'Victory point card worth 1 VP.'
    }))
  ];

  const shuffledDev = DeterministicPRNG.shuffle(prngSeed, devDeck);
  prngSeed = shuffledDev.nextSeed;

  shuffledDev.result.forEach((card, index) => {
    const entity: Entity = {
      id: `dev_${index}`,
      type: 'CARD',
      zoneId: 'zone_dev_deck',
      visibility: { type: 'HIDDEN' },
      components: {
        cardFace: { title: card.title, type: 'DEVELOPMENT', desc: card.desc },
        custom: { devType: card.devType, vp: card.devType === 'vp' ? 1 : 0 }
      }
    };
    state = ECSManager.addEntity(state, entity);
  });

  return state;
}
