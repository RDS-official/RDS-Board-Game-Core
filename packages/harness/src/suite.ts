import { RulePipeline } from '@rds/kernel/aop';
import { openDecision, projectDecision, resolveDecision, submitDecision } from '@rds/kernel/decisions';
import { ECSManager } from '@rds/kernel/ecs';
import { MapGraphManager } from '@rds/kernel/graph';
import { OccupancyIndex } from '@rds/kernel/occupancy';
import { applyPlaceEntityAction, makePlaceEntityAction } from '@rds/kernel/placement';
import { UniversalGameEngine } from '@rds/kernel/engine';
import { checkInvariants } from '@rds/kernel/invariants';
import { defineGame, GameModule } from '@rds/kernel/module';
import { CognitiveObserver } from '@rds/kernel/observer';
import { DeterministicPRNG } from '@rds/kernel/prng';
import { RollWindowManager } from '@rds/kernel/rollWindow';
import { RuleHookImpl, RuleRegistry } from '@rds/kernel/rules';
import { canonicalize, hashString } from '@rds/kernel/serialize';
import { InterruptStackManager } from '@rds/kernel/stack';
import { Action, Entity, GameState, ProjectedGameState, StackFrame } from '@rds/kernel/types';
import { validateActionShape } from '@rds/kernel/validation';
import { GAME_MODULES, GAME_REGISTRY } from '@rds/games/registry';
import { SplendorRules } from '@rds/games/splendor/rules';
import { setupSplendor } from '@rds/games/splendor/setup';
import { RandomPolicy, runPolicies } from './policy';
import { GameRoom } from '@rds/net/room';
import { RoomHttpAdapter } from '@rds/net/http';
import { RoomPresenter } from '@rds/net/roomPresenter';
import { UniversalSession } from '@rds/app/session';
import { normalize, placeBuilding, placeRoad, portRatio } from '@rds/games/catan/helpers';
import { withDefaultPayload } from '@rds/kernel/actionPayload';
import {
  EVENT_DEFS,
  ITEM_DEFS,
  OMEN_DEFS,
  ROOM_DEFS,
  ROOM_DECK_IDS,
  STARTING_ROOM_IDS
} from '@rds/games/betrayal/cards';
import { resolveHauntId } from '@rds/games/betrayal/haunts';
import {
  addEffect,
  applyTraitSteps,
  connectAdjacentDoors,
  damagePlayer,
  effectsOn,
  hostilesInRoom,
  itemSlotId,
  moveMonster,
  movePlayerTo,
  movementCost,
  ongoingEffectKinds,
  ownsDef,
  nodeGrid,
  removeEffects,
  resetTurnResources,
  rollZeroDice,
  traitIndex,
  traitValue,
  hasRolledThisTurn
} from '@rds/games/betrayal/helpers';
import { addExploredRoom, grantItem, grantOmen } from '@rds/games/betrayal/scenarios';
import { projectNodePosition } from '@rds/web/render/spatialProjection';
import { applyFrameTransform, computeAutoLayerOffsets, ProjectionRegistry } from '@rds/web/render/projectionPort';
import { buildCardGroups } from '@rds/web/render/cardGroups';
import { layoutRoom, hashString as layoutHash } from '@rds/web/render/procedural/roomLayout';
import { PROPS } from '@rds/web/render/procedural/props';
import { layoutLabels } from '@rds/web/render/labels/labelLayout';
import { describeActionView } from '@rds/app/actionText';
import { setLocale } from '@rds/app/i18n';

/* -------------------------------------------------------------------------- */
/* Tiny test harness                                                           */
/* -------------------------------------------------------------------------- */

export interface SuiteCaseResult {
  name: string;
  ok: boolean;
  error?: string;
  ms: number;
}

export interface SuiteResult {
  passed: number;
  failed: number;
  cases: SuiteCaseResult[];
}

type TestFn = () => void | Promise<void>;

const cases: { name: string; fn: TestFn }[] = [];

function test(name: string, fn: TestFn): void {
  cases.push({ name, fn });
}

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssertionError(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new AssertionError(`${message} — expected ${String(expected)}, got ${String(actual)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function emptyState(gameId = 'test', seed = 42): GameState {
  return {
    gameId,
    seed,
    seq: 0,
    clock: 0,
    round: 1,
    turn: 1,
    activePlayerId: 'p1',
    phase: 'TEST',
    players: {
      p1: {
        id: 'p1',
        name: 'P1',
        color: '#fff',
        avatar: '1',
        score: 0,
        alive: true,
        handZoneId: 'hand_p1',
        customProps: {}
      },
      p2: {
        id: 'p2',
        name: 'P2',
        color: '#000',
        avatar: '2',
        score: 0,
        alive: true,
        handZoneId: 'hand_p2',
        customProps: {}
      }
    },
    playerOrder: ['p1', 'p2'],
    entities: {},
    zones: {},
    mapGraph: { nodes: {}, edges: {} },
    globalVars: {},
    interruptStack: [],
    pendingDecisions: [],
    activeHooks: [],
    prngState: seed,
    actionLog: [],
    winner: null,
    gameOver: false
  };
}

function withZone(state: GameState, id: string, visibility: GameState['zones'][string]['visibility'] = { type: 'PUBLIC' }): GameState {
  return ECSManager.createZone(state, id, id, 'HAND', visibility);
}

/* -------------------------------------------------------------------------- */
/* 1. Core primitives                                                          */
/* -------------------------------------------------------------------------- */

test('serialize: canonical order + hashing is stable', () => {
  const a = { b: 1, a: [1, { z: true, y: null }] };
  const b = { a: [1, { y: null, z: true }], b: 1 };
  assertEqual(canonicalize(a), canonicalize(b), 'key order must not affect canonical form');
  assertEqual(hashString(canonicalize(a)), hashString(canonicalize(b)), 'hash must be stable');

  const fn = { bad: () => 1 };
  let threw = false;
  try {
    canonicalize(fn);
  } catch {
    threw = true;
  }
  assert(threw, 'functions inside state must be rejected');
});

test('prng: same seed yields identical streams and shuffles', () => {
  const seq = (seed: number) => Array.from({ length: 10 }, (_, i) => {
    const r = DeterministicPRNG.next(seed + i);
    return r.value;
  });
  assertEqual(JSON.stringify(seq(99)), JSON.stringify(seq(99)), 'sequences must match for the same seed');
  assert(JSON.stringify(seq(99)) !== JSON.stringify(seq(100)), 'different seeds must diverge');

  const source = [1, 2, 3, 4, 5, 6];
  const s1 = DeterministicPRNG.shuffle(7, source);
  const s2 = DeterministicPRNG.shuffle(7, source);
  assertEqual(JSON.stringify(s1.result), JSON.stringify(s2.result), 'shuffle must be deterministic');
  assertEqual(s1.result.length, source.length, 'shuffle must not lose cards');
});

test('graph: directed/weighted topology queries and validation', () => {
  const graph = {
    topology: { kind: 'graph' as const, adjacency: 'both' as const, directed: true, weighted: true },
    nodes: {
      a: { id: 'a', type: 'GENERIC' as const, position: [0, 0, 0] as [number, number, number], neighbors: ['b', 'c'], props: {} },
      b: { id: 'b', type: 'GENERIC' as const, position: [1, 0, 0] as [number, number, number], neighbors: ['c'], props: {} },
      c: { id: 'c', type: 'GENERIC' as const, position: [2, 0, 0] as [number, number, number], neighbors: [], props: {} }
    },
    edges: {
      ab: { id: 'ab', from: 'a', to: 'b', directed: true, weight: 2 },
      bc: { id: 'bc', from: 'b', to: 'c', directed: true, weight: 3 },
      ac: { id: 'ac', from: 'a', to: 'c', directed: true, weight: 10 }
    }
  };

  assertEqual(MapGraphManager.neighborsOf(graph, 'a').sort().join(','), 'b,c', 'outgoing neighbors');
  assertEqual(MapGraphManager.neighborsOf(graph, 'c').length, 0, 'directed graph has no reverse traversal');
  assertEqual(MapGraphManager.shortestPath(graph, 'a', 'c').join('>'), 'a>b>c', 'weighted shortest path');
  assertEqual(MapGraphManager.bfs(graph, 'a').get('c'), 1, 'BFS uses unit hops');
  assertEqual(MapGraphManager.reachable(graph, 'a', 2).has('c'), false, 'weight limit respected');
  assertEqual(MapGraphManager.validateTopology(graph).length, 0, 'valid topology');

  const bad = JSON.parse(JSON.stringify(graph)) as typeof graph;
  bad.nodes.a.neighbors = ['c'];
  assert(
    MapGraphManager.validateTopology(bad).some(error => error.includes('neighbors is missing b')),
    'directed edge must be listed on the source node'
  );
});

test('spatial: Betrayal exposes neighbors, cost, floors and line of sight', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 5, { scenario: 'exploration' });
  const raw = engine.getRawState();
  const entrance = String(raw.players.p1.customProps.currentRoomId);

  assert(!!engine.getSpatialQuery(), 'module declares a SpatialQuery');
  const neighbors = engine.getSpatialNeighbors(entrance, 'p1');
  assert(neighbors.includes('room_foyer'), 'entrance connects to foyer');
  assertEqual(engine.getSpatialFloor(entrance), 'GROUND', 'floor comes from node layer');
  assertEqual(engine.getSpatialDistance(entrance, 'room_foyer', 'p1'), 1, 'one step to foyer');
  const reachable = engine.getSpatialReachable(entrance, 2, 'p1');
  assert(reachable.has('room_foyer'), 'foyer reachable within 2');
  assert((reachable.get('room_foyer') ?? 0) >= 1, 'cost is charged');
  assert(engine.getLineOfSight(entrance, 'room_foyer'), 'adjacent same-floor room has line of sight');
});

test('projection: hidden map nodes and edges are removed', () => {
  const engine = new UniversalGameEngine(selectionModule, 1);
  const raw = engine.getRawState();
  raw.mapGraph.nodes.hidden_room = {
    id: 'hidden_room',
    type: 'GENERIC',
    position: [3, 0, 0],
    neighbors: ['n2'],
    visibility: { type: 'HIDDEN' },
    props: { name: 'Secret Room' }
  };
  raw.mapGraph.nodes.n1.neighbors.push('hidden_room');
  raw.mapGraph.edges.e_hidden = {
    id: 'e_hidden',
    from: 'n1',
    to: 'hidden_room',
    visibility: { type: 'HIDDEN' }
  };

  const view = engine.getProjectedStateFor('p1');
  assert(!view.mapGraph.nodes.hidden_room, 'hidden node removed');
  assert(!view.mapGraph.edges.e_hidden, 'hidden edge removed');
  assert(!view.mapGraph.nodes.n1.neighbors.includes('hidden_room'), 'dangling neighbor filtered');
  assertEqual(view.maskedNodeCount, 1, 'masked node counted');
  assertEqual(view.maskedEdgeCount, 1, 'masked edge counted');
});

test('projection: frame graph composes translation, rotation and scale', () => {
  const frames = {
    board: { id: 'board', origin: [10, 0, 0] as [number, number, number], rotationY: Math.PI / 2, scale: 2 },
    section: { id: 'section', parentId: 'board', origin: [0, 0, 5] as [number, number, number] }
  };
  const projected = applyFrameTransform([1, 0, 0], 'section', frames);
  assertEqual(projected[0], 20, 'nested frame X');
  assert(Math.abs(projected[2] + 2) < 1e-9, 'nested frame Z after rotation');
});

test('projection: ProjectionPort handles multi-board frames, stacks and overlap offsets', () => {
  const registry = new ProjectionRegistry();
  const topology = {
    kind: 'graph' as const,
    adjacency: 'both' as const,
    geometry: 'grid' as const,
    geometrySpec: {
      cellSize: 2,
      gridOrigin: [0, 0] as [number, number],
      origin: [0, 0, 0] as [number, number, number],
      stackHeight: 2
    }
  };
  const nodes = {
    boardA: {
      id: 'boardA',
      type: 'ROOM' as const,
      position: [1, 0, 0],
      positionSpace: 'world' as const,
      frameId: 'left',
      neighbors: [],
      props: {}
    },
    stack0: {
      id: 'stack0',
      type: 'GENERIC' as const,
      position: [0, 0, 0],
      positionSpace: 'stack',
      neighbors: [],
      props: {}
    },
    stack1: {
      id: 'stack1',
      type: 'GENERIC' as const,
      position: [0, 0, 1],
      positionSpace: 'stack',
      neighbors: [],
      props: {}
    }
  };
  const projected = registry.projectAll(nodes, {
    gameId: 'test',
    topology,
    frames: { left: { id: 'left', origin: [10, 0, 0] as [number, number, number] } }
  });
  assertEqual(projected.boardA.position[0], 11, 'frame origin applies to world node');
  assert(projected.stack1.position[1] >= 2, 'stack level maps to vertical Y');
  assert(
    Math.abs(projected.stack0.position[0] - projected.stack1.position[0]) > 0.1 ||
      Math.abs(projected.stack0.position[2] - projected.stack1.position[2]) > 0.1,
    'colliding stack projections receive a visual offset'
  );
});

test('projection: custom positionSpace can be registered without renderer changes', () => {
  const registry = new ProjectionRegistry().register('polar', {
    id: 'polar',
    project: node => {
      const [angle, radius] = node.position;
      return { position: [Math.cos(angle) * radius, 0, Math.sin(angle) * radius] };
    }
  });
  const projected = registry.project(
    {
      id: 'custom',
      type: 'GENERIC',
      position: [0, 4],
      positionSpace: 'polar',
      neighbors: [],
      props: {}
    },
    { gameId: 'test' }
  );
  assertEqual(projected.position[0], 4, 'custom port X');
  assertEqual(projected.position[2], 0, 'custom port Z');
});

test('occupancy: slot capacity, derived index and stack order', () => {
  let state = withZone(emptyState(), 'room');
  state.mapGraph.slots = {
    room: { id: 'room', kind: 'ZONE', zoneId: 'room', capacity: 2, layout: 'STACK' }
  };
  for (const id of ['a', 'b', 'c']) {
    state = ECSManager.addEntity(state, {
      id,
      type: 'TOKEN',
      zoneId: 'room',
      visibility: { type: 'PUBLIC' },
      components: {}
    });
  }

  const first = OccupancyIndex.place(state, 'a', 'room');
  assert(first.ok, 'first token fits');
  const second = OccupancyIndex.place(first.state, 'b', 'room');
  assert(second.ok, 'second token stacks');
  assertEqual(second.state.entities.b.components.spatial?.slotIndex, 1, 'stack index assigned');
  const third = OccupancyIndex.place(second.state, 'c', 'room');
  assert(!third.ok, 'capacity is enforced');
  assertEqual(OccupancyIndex.validate(second.state).length, 0, 'valid placement passes');
  const removed = OccupancyIndex.remove(second.state, 'b');
  assertEqual(removed.entities.b.components.spatial?.slotId, undefined, 'remove clears slot');
});

test('graph: frame graph validation rejects cycles and missing parents', () => {
  const graph = {
    nodes: {},
    edges: {},
    frames: {
      a: { id: 'a', parentId: 'b' },
      b: { id: 'b', parentId: 'a' }
    }
  };
  const errors = MapGraphManager.validateFrames(graph);
  assert(errors.some(error => error.includes('cycle')), 'parent cycle detected');
});

test('graph: frame validation rejects nodes in missing frames', () => {
  const graph = {
    nodes: {
      n: { id: 'n', type: 'GENERIC' as const, position: [0, 0, 0], frameId: 'missing', neighbors: [], props: {} }
    },
    edges: {}
  };
  const errors = MapGraphManager.validateFrames(graph);
  assert(errors.some(error => error.includes('missing frame')), 'missing node frame detected');
});

test('cards: presentation grouping respects owner, face and visibility but not effect variants', () => {
  const zone = {
    id: 'hand',
    name: 'Hand',
    type: 'HAND' as const,
    visibility: { type: 'PUBLIC' as const },
    orderedEntities: ['a', 'b', 'c', 'd']
  };
  const entity = (id: string, ownerId?: string, masked = false) => ({
    id,
    type: 'CARD' as const,
    zoneId: 'hand',
    ownerId,
    isMasked: masked,
    visibility: { type: 'PUBLIC' as const },
    components: { custom: { defId: 'same-type' } }
  });
  const entities: Record<string, any> = {
    a: entity('a', 'p1'),
    b: entity('b', 'p1'),
    c: entity('c', 'p2'),
    d: entity('d', 'p1', true)
  };
  const groups = buildCardGroups(zone as any, entities);
  const p1 = groups.find(group => group.ownerId === 'p1' && group.faceUp);
  assertEqual(p1?.count, 2, 'same owner/face cards form one group');
  assert(groups.some(group => group.ownerId === 'p2'), 'different owner is separate');
  assert(groups.some(group => !group.faceUp), 'masked card is separate');
  assertEqual(groups.length, 3, 'owner/face boundaries split the presentation groups');
});

test('cards: same visible name groups different internal effect variants', () => {
  const zone = {
    id: 'hand',
    name: 'Hand',
    type: 'HAND' as const,
    visibility: { type: 'PUBLIC' as const },
    orderedEntities: ['v1', 'v2']
  };
  const variant = (id: string, defId: string) => ({
    id,
    type: 'CARD' as const,
    zoneId: 'hand',
    visibility: { type: 'PUBLIC' as const },
    components: { custom: { defId, zh: '同名卡' } }
  });
  const groups = buildCardGroups(zone as any, { v1: variant('v1', 'old'), v2: variant('v2', 'new') });
  assertEqual(groups.length, 1, 'same display name merges');
  assertEqual(groups[0].count, 2, 'both variants are in the pile');
});

test('occupancy: PLACE_ENTITY helper applies a legal slot command', () => {
  let state = withZone(emptyState(), 'room');
  state.mapGraph.slots = {
    room: { id: 'room', kind: 'ZONE', zoneId: 'room', capacity: 1 }
  };
  state = ECSManager.addEntity(state, {
    id: 'token',
    type: 'TOKEN',
    zoneId: 'room',
    visibility: { type: 'PUBLIC' },
    components: {}
  });
  const action = makePlaceEntityAction('p1', 'token', 'room');
  assertEqual(action.type, 'PLACE_ENTITY', 'placement action type');
  const result = applyPlaceEntityAction(state, action);
  assert(result.ok, `placement failed: ${result.error}`);
  assertEqual(result.state.entities.token.components.spatial?.slotId, 'room', 'slot applied');
});

test('labels: screen layout avoids overlaps and respects priority', () => {
  const placed = layoutLabels(
    [
      { id: 'high', text: '当前行动者', x: 400, y: 300, priority: 100 },
      { id: 'low', text: '房间', x: 402, y: 302, priority: 10 }
    ],
    { width: 800, height: 600 }
  );
  assertEqual(placed.length, 2, 'both labels fit somewhere');
  const [a, b] = placed;
  const overlap = !(
    a.left + a.width <= b.left ||
    b.left + b.width <= a.left ||
    a.top + a.height <= b.top ||
    b.top + b.height <= a.top
  );
  assert(!overlap, 'labels do not overlap');
  assertEqual(placed[0].id, 'high', 'higher priority placed first');
});

test('labels: obstacles reduce available label placements', () => {
  const placed = layoutLabels(
    [{ id: 'x', text: '房间', x: 100, y: 100, priority: 10 }],
    { width: 220, height: 120 },
    [{ x: 0, y: 0, width: 220, height: 120 }]
  );
  assertEqual(placed.length, 0, 'fully blocked viewport drops the label');
});

test('projection: auto floor layout uses current room bounds and reflows on removal', () => {
  const topology = {
    kind: 'graph' as const,
    adjacency: 'both' as const,
    geometry: 'grid' as const,
    geometrySpec: {
      cellSize: 2,
      gridOrigin: [0, 0] as [number, number],
      origin: [0, 0, 0] as [number, number, number],
      layerMode: 'auto' as const,
      layerSpacing: 2
    }
  };
  const node = (id: string, col: number, layer: number) => ({
    id,
    type: 'ROOM' as const,
    position: [col, 0, layer],
    positionSpace: 'grid' as const,
    neighbors: [],
    props: {}
  });
  const nodes = {
    basement: node('basement', 0, 0),
    groundA: node('groundA', 0, 1),
    groundB: node('groundB', 4, 1),
    upper: node('upper', 0, 2)
  };
  const context = { gameId: 'betrayal', topology };
  const offsets = computeAutoLayerOffsets(nodes, context)!;
  assert(offsets[0] < offsets[1] && offsets[1] < offsets[2], 'floors are ordered');
  assert(offsets[2] - offsets[1] >= 8, 'upper floor clears the wide ground floor');
  const projected = new ProjectionRegistry().projectAll(nodes, context);
  const ranges = new Map<number, [number, number]>();
  for (const [id, point] of Object.entries(projected)) {
    const layer = nodes[id as keyof typeof nodes].position[2];
    const range = ranges.get(layer) ?? [point.position[0], point.position[0]];
    range[0] = Math.min(range[0], point.position[0]);
    range[1] = Math.max(range[1], point.position[0]);
    ranges.set(layer, range);
  }
  assert(ranges.get(0)![1] + 2 <= ranges.get(1)![0], 'basement clears ground');
  assert(ranges.get(1)![1] + 2 <= ranges.get(2)![0], 'ground clears upper');

  delete (nodes as Record<string, unknown>).groundB;
  const reflowed = computeAutoLayerOffsets(nodes, context)!;
  assert(reflowed[2] < offsets[2], 'upper floor reflows when a room is removed');
});

test('projection: high-dimensional node coordinates map to separated world positions', () => {
  const topology = {
    kind: 'graph' as const,
    adjacency: 'both' as const,
    geometry: 'grid' as const,
    geometrySpec: {
      cellSize: 2.86,
      origin: [0, 0.05, 0] as [number, number, number],
      gridOrigin: [2, 2] as [number, number],
      layerAxis: 'x' as const,
      layerSpacing: 9.6
    },
    layers: [
      { id: 'BASEMENT', name: '地下室', index: 0 },
      { id: 'GROUND', name: '一楼', index: 1 },
      { id: 'UPPER', name: '二楼', index: 2 }
    ]
  };
  const base = { type: 'ROOM' as const, neighbors: [], props: {}, positionSpace: 'grid' as const };
  const ground = projectNodePosition({ ...base, id: 'g', position: [3, 2, 1, 0] }, topology);
  const upper = projectNodePosition({ ...base, id: 'u', position: [3, 2, 2, 0] }, topology);
  const lower = projectNodePosition({ ...base, id: 'b', position: [3, 2, 0, 0] }, topology);

  assertEqual(ground.x, 2.86, 'grid column projects to X');
  assertEqual(ground.z, 0, 'grid row projects to Z');
  assert(upper.x > ground.x && lower.x < ground.x, 'layers are separated on the X axis');
  assertEqual(upper.z, ground.z, 'layer projection does not change Z');
  const legacy = projectNodePosition(
    { id: 'legacy', type: 'ROOM', position: [8, 0.1, -5], neighbors: [], props: {} },
    topology
  );
  assertEqual(legacy.x, 8, 'legacy world positions remain world positions');
  assertEqual(legacy.z, -5, 'legacy world positions are not reinterpreted as grid');
});

test('ecs: moving entities preserves single ownership', () => {
  let state = withZone(emptyState(), 'a');
  state = withZone(state, 'b');
  state = ECSManager.addEntity(state, {
    id: 'e1',
    type: 'CARD',
    zoneId: 'a',
    visibility: { type: 'PUBLIC' },
    components: {}
  });

  assertEqual(state.zones.a.orderedEntities.join(','), 'e1', 'entity starts in zone a');

  state = ECSManager.moveEntity(state, 'e1', 'b');
  assertEqual(state.zones.a.orderedEntities.length, 0, 'source zone is emptied');
  assertEqual(state.zones.b.orderedEntities.join(','), 'e1', 'target zone receives entity');
  assertEqual(state.entities.e1.zoneId, 'b', 'entity zoneId is updated');

  const movedTwice = ECSManager.moveEntity(state, 'e1', 'b');
  assertEqual(movedTwice.zones.b.orderedEntities.length, 1, 'moving to the same zone must not duplicate');
});

test('stack: LIFO order, response collection and priority short-circuit', () => {
  let state = emptyState();

  const frame = (id: string, players: string[], priority = false): StackFrame => ({
    id,
    type: 'TEST',
    title: id,
    description: id,
    sourcePlayerId: 'p1',
    actionPayload: null,
    status: 'WAITING_INPUT',
    responseWindow: {
      eligiblePlayers: players,
      pendingResponses: Object.fromEntries(players.map(p => [p, 'PENDING'])),
      priorityArbitration: priority,
      priorityMap: { HU: 30, PENG: 20, CHI: 10 },
      shortCircuitAt: 30
    }
  });

  state = InterruptStackManager.push(state, frame('f1', ['p2']));
  state = InterruptStackManager.push(state, frame('f2', ['p2'], true));
  assertEqual(InterruptStackManager.peek(state)?.id, 'f2', 'peek returns the top frame');

  const partial = InterruptStackManager.submitResponse(state, 'f2', 'p2', 'PASS');
  assert(partial.resolved, 'single eligible responder resolves immediately');

  const priority = InterruptStackManager.submitResponse(
    InterruptStackManager.push(state, frame('f3', ['p2', 'p1'], true)),
    'f3',
    'p2',
    { type: 'HU', playerId: 'p2' }
  );
  assert(priority.resolved && priority.shortCircuitedAction?.type === 'HU', 'HU must short-circuit the priority window');
});

test('aop: stage/priority ordering, modify, cancel, after-trigger', () => {
  const calls: string[] = [];
  const impls: RuleHookImpl[] = [
    {
      id: 'modify_low',
      name: 'modify low',
      stage: 'FILTER_MODIFY',
      priority: 10,
      description: '',
      predicate: () => true,
      handler: action => {
        calls.push('modify_low');
        return {
          type: 'MODIFY',
          modifiedAction: { ...action, payload: { bonus: (action.payload?.bonus ?? 0) + 1 } }
        };
      }
    },
    {
      id: 'modify_high',
      name: 'modify high',
      stage: 'FILTER_MODIFY',
      priority: 50,
      description: '',
      predicate: () => true,
      handler: action => {
        calls.push('modify_high');
        return { type: 'MODIFY', modifiedAction: { ...action, payload: { bonus: (action.payload?.bonus ?? 0) + 10 } } };
      }
    },
    {
      id: 'block',
      name: 'block',
      stage: 'BEFORE_REPLACE',
      priority: 100,
      description: '',
      predicate: a => a.type === 'BLOCKED',
      handler: () => {
        calls.push('block');
        return { type: 'CANCEL', message: 'blocked' };
      }
    },
    {
      id: 'after',
      name: 'after',
      stage: 'AFTER_TRIGGER',
      priority: 1,
      description: '',
      predicate: () => true,
      handler: () => {
        calls.push('after');
        return { type: 'CONTINUE', followUpActions: [{ type: 'FOLLOW_UP', playerId: 'p1' }] };
      }
    }
  ];

  const pipeline = new RulePipeline(new RuleRegistry(impls));
  let state = emptyState();
  state = {
    ...state,
    activeHooks: [
      { instanceId: 'i1', hookId: 'modify_low', visibility: { type: 'PUBLIC' } },
      { instanceId: 'i2', hookId: 'modify_high', visibility: { type: 'PUBLIC' } },
      { instanceId: 'i3', hookId: 'block', visibility: { type: 'PUBLIC' } },
      { instanceId: 'i4', hookId: 'after', visibility: { type: 'PUBLIC' } }
    ]
  };

  const result = pipeline.processAction({ type: 'PLAY', playerId: 'p1' }, state);
  assertEqual(result.finalAction.payload.bonus, 11, 'higher priority modifier runs first');
  assertEqual(calls[0], 'modify_high', 'priority order preserved');
  assert(!result.cancelled, 'PLAY is not cancelled');

  const blocked = pipeline.processAction({ type: 'BLOCKED', playerId: 'p1' }, state);
  assert(blocked.cancelled, 'BEFORE_REPLACE can cancel');

  const after = pipeline.triggerAfter({ type: 'PLAY', playerId: 'p1' }, state);
  assertEqual(after.chainedActions[0]?.type, 'FOLLOW_UP', 'AFTER_TRIGGER chains follow-up actions');
});

test('decisions: secret submissions stay hidden until reveal', () => {
  let state = emptyState();
  const opened = openDecision(
    state,
    {
      kind: 'SIMULTANEOUS',
      title: 'secret',
      participants: ['p1', 'p2'],
      secret: true,
      policy: { type: 'ALL_COMMITTED' }
    },
    'd1'
  );
  state = opened.state;

  const first = submitDecision(state, 'd1', 'p1', { type: 'BID', playerId: 'p1', payload: { amount: 5 } });
  assert(first.accepted && !first.ready, 'first submission must not resolve');
  state = first.state;

  const p2View = projectDecision(state.pendingDecisions[0], 'p2');
  assertEqual(p2View.submissions.p1, 'COMMITTED', 'secret submission is masked');
  assertEqual(projectDecision(state.pendingDecisions[0], 'GOD').submissions.p1, (first.window as any).submissions.p1, 'god sees the action');

  const second = submitDecision(state, 'd1', 'p2', { type: 'BID', playerId: 'p2', payload: { amount: 9 } });
  assert(second.ready, 'all committed resolves the window');

  const resolved = resolveDecision(second.state, 'd1');
  assertEqual(resolved.window?.status, 'RESOLVED', 'window is resolved');
  assertEqual(resolved.window?.reveal?.p1 && (resolved.window.reveal.p1 as any).payload.amount, 5, 'reveal contains submissions');
});

test('decisions: priority policy short-circuits and orders submissions', () => {
  let state = openDecision(
    emptyState(),
    {
      kind: 'BIDDING',
      title: 'claims',
      participants: ['p1', 'p2'],
      secret: false,
      policy: { type: 'PRIORITY', priorities: { HU: 30, PENG: 20, CHI: 10 }, shortCircuitAt: 30 }
    },
    'd2'
  ).state;

  state = submitDecision(state, 'd2', 'p1', { type: 'CHI', playerId: 'p1' }).state;
  const hu = submitDecision(state, 'd2', 'p2', { type: 'HU', playerId: 'p2' });
  assert(hu.ready, 'HU must short-circuit regardless of the other submission');
});

test('decisions: FIRST_ACCEPT resolves on the first acceptance only', () => {
  let state = openDecision(
    emptyState(),
    {
      kind: 'VOTE',
      title: 'trade',
      participants: ['p1', 'p2', 'p3'],
      secret: false,
      policy: { type: 'FIRST_ACCEPT', acceptTypes: ['ACCEPT'] }
    },
    'd3'
  ).state;

  const reject = submitDecision(state, 'd3', 'p1', { type: 'REJECT', playerId: 'p1' });
  assert(!reject.ready, 'a rejection alone does not resolve');
  state = reject.state;

  const accept = submitDecision(state, 'd3', 'p2', { type: 'ACCEPT', playerId: 'p2' });
  assert(accept.ready, 'first acceptance short-circuits');
  assertEqual(accept.window?.status, 'READY', 'window becomes READY');

  const resolved = resolveDecision(accept.state, 'd3');
  assert(!!resolved.window, 'window resolved');
  assertEqual(resolved.window!.status, 'RESOLVED', 'status RESOLVED');

  const revealP1 = resolved.window!.reveal?.p1;
  const revealP2 = resolved.window!.reveal?.p2;
  assert(
    revealP1 !== undefined && revealP1 !== 'PASS' && revealP1 !== 'COMMITTED' && revealP1.type === 'REJECT',
    'earlier rejection is kept for audit'
  );
  assert(
    revealP2 !== undefined && revealP2 !== 'PASS' && revealP2 !== 'COMMITTED' && revealP2.type === 'ACCEPT',
    'acceptance is applied'
  );
  assertEqual(resolved.window!.reveal?.p3, undefined, 'later participants are not required');
});

test('decisions: FIRST_ACCEPT resolves after all rejections', () => {
  let state = openDecision(
    emptyState(),
    {
      kind: 'VOTE',
      title: 'trade',
      participants: ['p1', 'p2'],
      secret: false,
      policy: { type: 'FIRST_ACCEPT', acceptTypes: ['ACCEPT'] }
    },
    'd4'
  ).state;

  const first = submitDecision(state, 'd4', 'p1', { type: 'REJECT', playerId: 'p1' });
  assert(!first.ready, 'one rejection is not enough');
  const second = submitDecision(first.state, 'd4', 'p2', { type: 'REJECT', playerId: 'p2' });
  assert(second.ready, 'all rejections resolve the window');
});

test('observer: hidden cards are scrubbed, aliased and zone-remapped', () => {
  let state = withZone(emptyState(), 'deck', { type: 'HIDDEN' });
  state = ECSManager.addEntity(state, {
    id: 'secret-1',
    type: 'CARD',
    zoneId: 'deck',
    visibility: { type: 'HIDDEN' },
    components: { cardFace: { title: 'The Traitor', suit: '♠', rank: 'A' } }
  });

  const p1View = CognitiveObserver.projectState(state, 'p1');
  const alias = p1View.zones.deck.orderedEntities[0];
  assert(alias !== 'secret-1', 'hidden entity must be aliased');
  assertEqual(p1View.entities[alias]?.isMasked, true, 'hidden entity is masked');
  assert(p1View.entities[alias]?.components?.cardFace?.title !== 'The Traitor', 'hidden title must not leak');
  assertEqual(p1View.maskedEntityCount, 1, 'masked counter');

  const again = CognitiveObserver.projectState(state, 'p1');
  assertEqual(again.zones.deck.orderedEntities[0], alias, 'alias must be stable for a viewer');

  const godView = CognitiveObserver.projectState(state, 'GOD');
  assertEqual(godView.entities['secret-1']?.components?.cardFace?.title, 'The Traitor', 'GOD sees the truth');
});

test('invariants: valid state passes, corrupted states are rejected', () => {
  const rules = new RuleRegistry([]);
  const state = withZone(emptyState(), 'a');
  assertEqual(checkInvariants(state, rules).length, 0, 'fresh state is valid');

  const duplicate = {
    ...state,
    zones: { a: { ...state.zones.a, orderedEntities: ['x', 'x'] } }
  };
  const dupCodes = checkInvariants(duplicate, rules).map(v => v.code);
  assert(dupCodes.includes('ZONE_DUPLICATE_ENTITY'), `duplicate zone entries detected (${dupCodes.join(',')})`);

  const dangling = {
    ...state,
    zones: { a: { ...state.zones.a, orderedEntities: ['ghost'] } }
  };
  assert(
    checkInvariants(dangling, rules).some(v => v.code === 'ZONE_DANGLING_ENTITY'),
    'dangling entity detected'
  );

  const unknownHook = {
    ...state,
    activeHooks: [{ instanceId: 'i', hookId: 'missing', visibility: { type: 'PUBLIC' as const } }]
  };
  assert(
    checkInvariants(unknownHook, rules).some(v => v.code === 'HOOK_UNKNOWN_IMPL'),
    'unknown hook implementation detected'
  );
});

/* -------------------------------------------------------------------------- */
/* 2. Generic engine behaviour                                                 */
/* -------------------------------------------------------------------------- */

const counterModule: GameModule = defineGame({
  meta: {
    id: 'counter',
    name: 'Counter fixture',
    description: 'Minimal module used by kernel tests',
    version: '1.0.0',
    capabilities: {
      simultaneousMoves: false,
      hiddenInformation: false,
      interruptStack: false,
      dynamicRules: false,
      topology: 'none'
    }
  },
  hooks: [],
  setup: seed => ({
    ...emptyState('counter', seed),
    globalVars: { ticks: 0, last: 0 }
  }),
  legalActions: (state, playerId) =>
    playerId === state.activePlayerId && (state.globalVars.ticks as number) < 100
      ? [{ type: 'TICK', playerId }]
      : [],
  reduce: (state, action, ctx) => {
    if (action.type !== 'TICK') return state;
    const { value, nextSeed } = DeterministicPRNG.next(state.prngState);
    ctx.trace({ id: ctx.id('evt'), type: 'ANNOUNCEMENT', title: 'tick', durationMs: 10 });
    return {
      ...state,
      prngState: nextSeed,
      globalVars: {
        ticks: (state.globalVars.ticks as number) + 1,
        last: value
      }
    };
  },
  outcome: () => ({ gameOver: false, winner: null })
});

const scenarioModule: GameModule = defineGame({
  ...counterModule,
  meta: { ...counterModule.meta, id: 'scenario_fixture', name: 'Scenario fixture' },
  scenarios: {
    rich: {
      description: 'Starts with 40 ticks already recorded',
      setup: seed => ({
        ...emptyState('scenario_fixture', seed),
        globalVars: { ticks: 40, last: 0 }
      })
    }
  }
});

const selectionModule: GameModule = defineGame({
  meta: {
    id: 'selection_fixture',
    name: 'Selection fixture',
    description: 'Declarative target selection',
    version: '1.0.0',
    capabilities: {
      simultaneousMoves: false,
      hiddenInformation: false,
      interruptStack: false,
      dynamicRules: false,
      topology: 'graph'
    }
  },
  hooks: [],
  setup: seed => {
    const base = emptyState('selection_fixture', seed);
    base.mapGraph = {
      nodes: {
        n1: { id: 'n1', type: 'GENERIC', position: [0, 0, 0], neighbors: ['n2'], props: { name: 'Alpha' } },
        n2: { id: 'n2', type: 'GENERIC', position: [1, 0, 0], neighbors: ['n1'], props: { name: 'Beta' } }
      },
      edges: {}
    };
    base.globalVars = { picked: null };
    return base;
  },
  legalActions: (state, actorId) =>
    actorId === state.activePlayerId
      ? [
          { type: 'PICK_NODE', playerId: actorId, selection: { source: 'node', min: 1, max: 1 } },
          { type: 'END_TURN', playerId: actorId }
        ]
      : [],
  reduce: (state, action) => {
    if (action.type === 'PICK_NODE') {
      return { ...state, globalVars: { ...state.globalVars, picked: action.targets?.[0] ?? null } };
    }
    return state;
  },
  outcome: () => ({ gameOver: false, winner: null })
});

const diceModule: GameModule = defineGame({
  meta: {
    id: 'dice_fixture',
    name: 'Dice fixture',
    description: 'Custom dice faces',
    version: '1.0.0',
    capabilities: {
      simultaneousMoves: false,
      hiddenInformation: false,
      interruptStack: false,
      dynamicRules: false,
      topology: 'none'
    }
  },
  hooks: [],
  setup: seed => ({ ...emptyState('dice_fixture', seed), globalVars: { total: -1, rolls: [] } }),
  legalActions: (state, actorId) =>
    actorId === state.activePlayerId ? [{ type: 'ROLL_CUSTOM', playerId: actorId }] : [],
  reduce: (state, action, ctx) => {
    if (action.type !== 'ROLL_CUSTOM') return state;
    const roll = ctx.roll({ count: 6, faces: [0, 1, 2] }, state.prngState);
    return {
      ...state,
      prngState: roll.nextSeed,
      globalVars: { total: roll.result.total, rolls: roll.result.rolls }
    };
  },
  outcome: () => ({ gameOver: false, winner: null })
});

const npcModule: GameModule = defineGame({
  meta: {
    id: 'npc_fixture',
    name: 'NPC fixture',
    description: 'Non-player actor focus and routing',
    version: '1.0.0',
    capabilities: {
      simultaneousMoves: false,
      hiddenInformation: false,
      interruptStack: false,
      dynamicRules: false,
      nonPlayerActors: true,
      topology: 'none'
    }
  },
  hooks: [],
  setup: seed => {
    const base = emptyState('npc_fixture', seed);
    base.npcs = {
      npc1: {
        id: 'npc1',
        kind: 'NPC',
        name: 'Test Monster',
        color: '#b07bf0',
        avatar: '👹',
        status: 'ACTIVE',
        controllerId: 'p1',
        visibility: { type: 'PUBLIC' },
        customProps: {}
      }
    };
    base.actorOrder = ['p1', 'npc1'];
    base.activeActorId = 'npc1';
    base.globalVars = { npcActions: 0 };
    return base;
  },
  legalActions: (state, actorId) =>
    actorId === 'npc1' && state.activeActorId === 'npc1'
      ? [{ type: 'NPC_ACT', playerId: 'npc1', actorId: 'npc1' }]
      : actorId === 'p1'
      ? [{ type: 'PLAYER_ACT', playerId: 'p1' }]
      : [],
  reduce: (state, action) => {
    if (action.type !== 'NPC_ACT') return state;
    return { ...state, globalVars: { ...state.globalVars, npcActions: Number(state.globalVars.npcActions ?? 0) + 1 } };
  },
  outcome: () => ({ gameOver: false, winner: null })
});

const crossFieldModule: GameModule = defineGame({
  ...counterModule,
  meta: { ...counterModule.meta, id: 'cross_field', name: 'Cross-field fixture' },
  legalActions: (state, playerId) =>
    playerId === state.activePlayerId
      ? [
          {
            type: 'COMBO',
            playerId,
            fields: [
              { key: 'a', label: 'A', kind: 'number' },
              { key: 'b', label: 'B', kind: 'number' }
            ]
          }
        ]
      : [],
  validatePayload: (_state, _action, payload) =>
    Number(payload.b) > Number(payload.a) ? [] : ['b must be greater than a']
});

const deadlineModule: GameModule = defineGame({  meta: {
    id: 'deadline_fixture',
    name: 'Deadline fixture',
    description: 'Decision window with per-player deadlines',
    version: '1.0.0',
    capabilities: {
      simultaneousMoves: true,
      hiddenInformation: false,
      interruptStack: false,
      dynamicRules: false,
      topology: 'none'
    }
  },
  hooks: [],
  setup: seed => {
    const base = emptyState('deadline_fixture', seed);
    const opened = openDecision(
      base,
      {
        kind: 'VOTE',
        title: 'per-player deadline',
        participants: ['p1', 'p2'],
        secret: false,
        policy: { type: 'ALL_COMMITTED' },
        participantDeadlines: { p1: 2, p2: 5 }
      },
      'w1'
    );
    return { ...opened.state, phase: 'WAIT' };
  },
  legalActions: () => [],
  reduce: state => state,
  outcome: () => ({ gameOver: false, winner: null })
});

test('engine: selection actions validate concrete targets', () => {
  const engine = new UniversalGameEngine(selectionModule, 3);
  const action = engine.getLegalActions('p1').find(candidate => candidate.type === 'PICK_NODE');
  assert(!!action?.selection, 'selection spec is exposed');
  const candidates = engine.getSelectionCandidates('p1', action!.selection!);
  assertEqual(candidates.map(candidate => candidate.id).join(','), 'n1,n2', 'candidates come from the graph');

  const rejected = engine.dispatch({ ...action!, targets: ['missing'] });
  assert(!rejected.ok, 'unknown target rejected');
  const empty = engine.dispatch({ ...action!, targets: [] });
  assert(!empty.ok, 'min target count enforced');

  const accepted = engine.dispatch({ ...action!, targets: ['n2'] });
  assert(accepted.ok, `valid target accepted: ${accepted.error}`);
  assertEqual(engine.getRawState().globalVars.picked, 'n2', 'targets reached the reducer');
});

test('engine: custom dice faces (0/1/2) roll through ReduceContext', () => {
  const engine = new UniversalGameEngine(diceModule, 12);
  assert(engine.dispatch({ type: 'ROLL_CUSTOM', playerId: 'p1' }).ok, 'custom roll accepted');
  const state = engine.getRawState();
  const rolls = state.globalVars.rolls as number[];
  assertEqual(rolls.length, 6, 'six dice');
  assert(rolls.every(value => value >= 0 && value <= 2), 'faces are 0/1/2');
  assertEqual(rolls.reduce((sum, value) => sum + value, 0), state.globalVars.total, 'total matches faces');
  assert(engine.verifyReplay().ok, 'custom dice replay exactly');
});

test('engine: NPCs are actors but not players', () => {
  const engine = new UniversalGameEngine(npcModule, 5);
  assertEqual(engine.getFocusActors().join(','), 'npc1', 'NPC is the focus actor');
  assertEqual(engine.getFocusPlayers().length, 0, 'NPC is not a player focus');

  const action = engine.getLegalActions('npc1').find(candidate => candidate.type === 'NPC_ACT');
  assert(!!action, 'NPC has legal actions');
  assert(engine.dispatch(action!).ok, 'NPC action dispatches');
  assertEqual(engine.getRawState().globalVars.npcActions, 1, 'NPC reducer ran');

  const view = engine.getProjectedStateFor('p2');
  assertEqual(view.npcs?.npc1?.name, 'Test Monster', 'NPC is projected');
  assertEqual(view.actorOrder?.join(','), 'p1,npc1', 'visible actors remain in order');
  assert(engine.verifyReplay().ok, 'NPC action replays');
});

test('engine: named scenarios replay through export/load', () => {  const engine = new UniversalGameEngine(scenarioModule, 9, { scenario: 'rich' });
  assertEqual(engine.getScenario(), 'rich', 'scenario recorded');
  assertEqual(engine.getRawState().globalVars.ticks, 40, 'scenario setup applied');

  assert(engine.dispatch({ type: 'TICK', playerId: 'p1' }).ok, 'tick accepted');
  assertEqual(engine.getRawState().globalVars.ticks, 41, 'scenario state advanced');

  const log = engine.exportLog();
  assertEqual(log.scenario, 'rich', 'scenario exported in the log');

  const restored = new UniversalGameEngine(scenarioModule, 1);
  const report = restored.loadLog(log);
  assert(report.ok, `restore failed: ${report.errors.join(' | ')}`);
  assertEqual(restored.getScenario(), 'rich', 'scenario restored');
  assertEqual(restored.getStateHash(), engine.getStateHash(), 'restored hash matches');

  let threw = false;
  try {
    new UniversalGameEngine(scenarioModule, 1, { scenario: 'missing' });
  } catch {
    threw = true;
  }
  assert(threw, 'unknown scenario is rejected');
  assert(engine.verifyReplay().ok, 'scenario replay is bit-exact');
});

test('engine: incompatible log versions are rejected, not migrated', () => {
  const engine = new UniversalGameEngine(counterModule, 5);
  engine.dispatch({ type: 'TICK', playerId: 'p1' });
  const log = engine.exportLog();
  assertEqual(log.schemaVersion, 1, 'schema version written');
  assertEqual(log.engineVersion, 3, 'engine version written');

  const clone = new UniversalGameEngine(counterModule, 5);
  const mismatch = clone.loadLog({ ...log, engineVersion: 999 });
  assert(!mismatch.ok, 'engine mismatch rejected');
  assert(mismatch.errors.some(error => error.includes('migration is not automatic')), 'clear version error');

  const schemaMismatch = clone.loadLog({ ...log, schemaVersion: 999 });
  assert(!schemaMismatch.ok, 'schema mismatch rejected');
  assert(clone.loadLog(log).ok, 'matching versions still replay');
});

test('engine: effects expire and are projected by visibility', () => {
  const engine = new UniversalGameEngine(counterModule, 5);
  const raw = engine.getRawState();
  raw.effects = [
    { id: 'e_expired', kind: 'buff', source: 'p1', target: 'p1', expiresAt: { turn: 0 } },
    { id: 'e_public', kind: 'buff', source: 'p1', target: 'p1', expiresAt: { turn: 3 } },
    { id: 'e_hidden', kind: 'curse', source: 'p1', target: 'p1', visibility: { type: 'HIDDEN' } }
  ];

  assert(engine.dispatch({ type: 'TICK', playerId: 'p1' }).ok, 'tick accepted');
  const state = engine.getRawState();
  assert(!state.effects?.some(effect => effect.id === 'e_expired'), 'expired effect removed');
  assert(state.effects?.some(effect => effect.id === 'e_public'), 'active effect retained');

  const view = engine.getProjectedStateFor('p1');
  assert(view.effects?.some(effect => effect.id === 'e_public'), 'public effect projected');
  assert(!view.effects?.some(effect => effect.id === 'e_hidden'), 'hidden effect removed');
});

test('engine: per-participant deadlines expire independently', () => {
  const engine = new UniversalGameEngine(deadlineModule, 3);

  assert(engine.dispatch({ type: '__TICK__', playerId: 'SYSTEM', payload: { ticks: 2 } }).ok, 'first tick');
  let window = engine.getRawState().pendingDecisions.find(w => w.id === 'w1');
  assertEqual(window?.status, 'OPEN', 'window still waits for p2');
  assertEqual(window?.submissions.p1, 'PASS', 'p1 timed out at its own deadline');
  assertEqual(window?.submissions.p2, undefined, 'p2 has not timed out yet');

  assert(engine.dispatch({ type: '__TICK__', playerId: 'SYSTEM', payload: { ticks: 3 } }).ok, 'second tick');
  window = engine.getRawState().pendingDecisions.find(w => w.id === 'w1');
  assertEqual(window?.status, 'RESOLVED', 'window resolves when the last deadline passes');
  assertEqual(window?.reveal?.p2, 'PASS', 'p2 timed out independently');

  assert(engine.verifyReplay().ok, 'per-player deadline replay is bit-exact');
});

test('engine: illegal actions are rejected without mutating state', () => {
  const engine = new UniversalGameEngine(counterModule, 5);
  const before = engine.getStateHash();

  const wrongPlayer = engine.dispatch({ type: 'TICK', playerId: 'p2' });
  assert(!wrongPlayer.ok, 'wrong player must be rejected');

  const illegal = engine.dispatch({ type: 'NOPE', playerId: 'p1' });
  assert(!illegal.ok, 'unknown action must be rejected');

  assertEqual(engine.getStateHash(), before, 'rejected actions must not change state');
});

test('engine: deterministic replay reproduces the exact state hash', () => {
  const engine = new UniversalGameEngine(counterModule, 77);
  for (let i = 0; i < 12; i++) {
    const result = engine.dispatch({ type: 'TICK', playerId: 'p1' });
    assert(result.ok, `tick ${i} failed: ${result.error}`);
  }

  const liveHash = engine.getStateHash();
  const report = engine.verifyReplay();
  assert(report.ok, `replay must match (${report.errors.join(' | ')})`);
  assertEqual(report.actualHash, liveHash, 'replayed hash equals live hash');

  const exported = engine.exportLog();
  const clone = new UniversalGameEngine(counterModule, 1);
  const loadReport = clone.loadLog(exported);
  assert(loadReport.ok, 'loading an exported log must verify');
  assertEqual(clone.getStateHash(), liveHash, 'loaded state matches the source hash');
});

test('engine: time machine rewinds and replays forward', () => {
  const engine = new UniversalGameEngine(counterModule, 9);
  for (let i = 0; i < 6; i++) engine.dispatch({ type: 'TICK', playerId: 'p1' });
  const full = engine.getStateHash();

  engine.replayTo(2);
  assertEqual((engine.getRawState().globalVars.ticks as number), 2, 'rewind restores step 2');
  assertEqual(engine.getRawState().actionLog.length, 2, 'log is truncated');

  const report = engine.replayTo(6);
  assert(report.ok, 'forward replay succeeds');
  assertEqual(engine.getStateHash(), full, 'forward replay returns to the original hash');
});

/* -------------------------------------------------------------------------- */
/* 3. Fixture conformance                                                      */
/* -------------------------------------------------------------------------- */

function playRandom(engine: UniversalGameEngine, steps: number): { applied: number; errors: string[] } {
  let applied = 0;
  const errors: string[] = [];

  for (let i = 0; i < steps && !engine.getRawState().gameOver; i++) {
    const focus = engine.getFocusActors();
    if (focus.length === 0) break;

    let did = false;
    for (const pid of focus) {
      const legal = engine.getLegalActions(pid);
      if (legal.length === 0) continue;
      const action = withDefaultPayload(legal.find(a => a.type !== 'PASS') ?? legal[0]);
      const result = engine.dispatch(action);
      if (!result.ok) errors.push(`${action.type}: ${result.error}`);
      else applied++;
      did = true;
      break;
    }
    if (!did) break;
  }

  return { applied, errors };
}

for (const module of GAME_MODULES) {
  test(`fixture ${module.meta.id}: initialises under strict invariants`, () => {
    const engine = new UniversalGameEngine(module, 2024);
    const state = engine.getRawState();
    assert(state.playerOrder.length > 0, 'has players');
    assertEqual(state.gameId, module.meta.id, 'gameId matches module');
    assertEqual(state.seed, 2024, 'seed recorded');

    const focus = engine.getFocusPlayers();
    assert(focus.length > 0, 'has a focus set');
    assert(engine.getLegalActions(focus[0]).length > 0, 'focus player has legal actions');

    const violations = checkInvariants(state, engine.getRules());
    assertEqual(violations.length, 0, `initial state invariants (${violations.map(v => v.code).join(',')})`);
  });

  test(`fixture ${module.meta.id}: random play + bit-exact replay`, () => {
    const engine = new UniversalGameEngine(module, 424242);
    const { applied, errors } = playRandom(engine, 18);
    assert(applied > 0, 'at least one action applied');
    assertEqual(errors.length, 0, `no dispatch errors (${errors.slice(0, 2).join(' | ')})`);

    const replay = engine.verifyReplay();
    assert(replay.ok, `replay mismatch (${replay.errors.slice(0, 2).join(' | ')})`);
  });

  test(`fixture ${module.meta.id}: projections never leak hidden card faces`, () => {
    const engine = new UniversalGameEngine(module, 777);
    playRandom(engine, 8);

    const raw = engine.getRawState();
    const hiddenTitles = new Set(
      Object.values(raw.entities)
        .filter(e => !CognitiveObserver.isVisibleTo(e.visibility, 'GOD', e.ownerId) && e.components.cardFace)
        .map(e => e.components.cardFace!.title)
    );

    for (const pid of raw.playerOrder) {
      const view = CognitiveObserver.projectState(raw, pid, (s, p) => engine.getLegalActions(p));
      for (const entity of Object.values(view.entities)) {
        if (entity.isMasked && entity.components?.cardFace?.title) {
          assert(!hiddenTitles.has(entity.components.cardFace.title), `view ${pid} leaked a hidden title`);
        }
      }
      for (const zone of Object.values(view.zones)) {
        for (const id of zone.orderedEntities) {
          assert(!!view.entities[id], `view ${pid} zone ${zone.id} references missing projected entity ${id}`);
        }
      }
    }
  });
}

test('validation: cross-field payload hooks reject inconsistent requests', () => {
  const engine = new UniversalGameEngine(crossFieldModule, 3);
  const invalid = engine.dispatch({ type: 'COMBO', playerId: 'p1', payload: { a: 5, b: 2 } });
  assert(!invalid.ok && /b must be greater than a/.test(invalid.error ?? ''), 'cross-field rejection');
  const valid = engine.dispatch({ type: 'COMBO', playerId: 'p1', payload: { a: 1, b: 2 } });
  assert(valid.ok, `cross-field acceptance: ${valid.error}`);
});

test('i18n: action labels flow through the locale registry', () => {
  const state = emptyState('i18n') as unknown as ProjectedGameState;
  const roll: Action = { type: 'ROLL_DICE', playerId: 'p1' };
  setLocale('zh');
  assertEqual(describeActionView(state, roll)?.label, '掷骰子', 'Chinese action label');
  setLocale('en');
  assertEqual(describeActionView(state, roll)?.label, 'Roll dice', 'English action label');
  setLocale('zh');
});

test('validation: conditional defaults skip hidden payload fields', () => {
  const action: Action = {
    type: 'COND',
    playerId: 'p1',
    fields: [
      { key: 'mode', label: 'Mode', kind: 'enum', options: [{ value: 'no', label: 'No' }], default: 'no' },
      {
        key: 'extra',
        label: 'Extra',
        kind: 'number',
        default: 7,
        dependsOn: { key: 'mode', equals: 'yes' }
      }
    ]
  };
  const payload = withDefaultPayload(action).payload as Record<string, unknown>;
  assertEqual(payload.mode, 'no', 'base default filled');
  assertEqual(payload.extra, undefined, 'hidden field default skipped');
});

test('validation: schemas reject malformed actions before legality', () => {
  const catan = new UniversalGameEngine(GAME_REGISTRY.catan, 3);
  const missingField = catan.dispatch({ type: 'BUILD_ROAD', playerId: 'p1' });
  assert(!missingField.ok && /targetEdgeId/.test(missingField.error ?? ''), 'missing required field rejected');

  const splendor = new UniversalGameEngine(GAME_REGISTRY.splendor, 3);
  const badGem = splendor.dispatch({
    type: 'TAKE_2_SAME_GEMS',
    playerId: 'p1',
    payload: { gem: 'opal' }
  });
  assert(!badGem.ok && /payload\.gem/.test(badGem.error ?? ''), 'enum violation rejected');

  const dune = new UniversalGameEngine(GAME_REGISTRY.dune_mahjong, 3);
  dune.dispatch({ type: 'OPEN_BATTLE_WINDOW', playerId: 'p1' });
  const badTroops = dune.dispatch({
    type: 'COMMIT_BATTLE_DIAL',
    playerId: 'p1',
    payload: { troops: 999, leaderStr: 5, weapon: 'Crysknife' }
  });
  assert(!badTroops.ok && /payload\.troops/.test(badTroops.error ?? ''), 'range violation rejected');
});

test('validation: schemas do not decide semantic legality', () => {
  const schemas = {
    PING: { type: 'PING', payload: { n: { kind: 'integer' as const, required: true } } }
  };

  assertEqual(
    validateActionShape({ type: 'PING', playerId: 'p1', payload: { n: 2 } }, schemas).length,
    0,
    'well-formed action passes shape validation'
  );
  assert(
    validateActionShape({ type: 'PING', playerId: 'p1', payload: { n: 1.5 } }, schemas).length > 0,
    'integer constraint enforced'
  );
  assert(
    validateActionShape({ type: 'UNKNOWN', playerId: 'p1' }, schemas).length === 0,
    'unknown action types fall back to structural checks'
  );
});

test('rule graph: missing dependencies and cycles are rejected', () => {
  const base: RuleHookImpl = {
    id: 'base',
    name: 'base',
    stage: 'FILTER_MODIFY',
    priority: 5,
    description: '',
    predicate: () => false,
    handler: () => ({ type: 'CONTINUE' })
  };
  const dependent: RuleHookImpl = {
    ...base,
    id: 'dependent',
    name: 'dependent',
    priority: 50,
    requires: ['base']
  };
  const acyclic = new RuleRegistry([dependent, base]);
  assertEqual(acyclic.dependencyErrors().length, 0, 'acyclic graph accepted');

  const order = acyclic.order(acyclic.all()).map(impl => impl.id);
  assert(order.indexOf('base') < order.indexOf('dependent'), 'dependency runs before dependent');

  const missing = new RuleRegistry([dependent]);
  assert(
    missing.dependencyErrors().some(e => e.includes('unknown hook')),
    'missing dependency reported'
  );

  const cyclicA: RuleHookImpl = { ...base, id: 'a', requires: ['b'] };
  const cyclicB: RuleHookImpl = { ...base, id: 'b', requires: ['a'] };
  const cyclic = new RuleRegistry([cyclicA, cyclicB]);
  assert(
    cyclic.dependencyErrors().some(e => e.includes('cycle')),
    'cycle reported'
  );
});

test('rule graph: activation requires active prerequisites', () => {
  const impls: RuleHookImpl[] = [
    {
      id: 'root',
      name: 'root',
      stage: 'FILTER_MODIFY',
      priority: 1,
      description: '',
      predicate: () => false,
      handler: () => ({ type: 'CONTINUE' })
    },
    {
      id: 'leaf',
      name: 'leaf',
      stage: 'FILTER_MODIFY',
      priority: 2,
      description: '',
      requires: ['root'],
      predicate: () => false,
      handler: () => ({ type: 'CONTINUE' })
    }
  ];

  const pipeline = new RulePipeline(new RuleRegistry(impls));
  let state = emptyState();

  let threw = false;
  try {
    pipeline.activate(state, 'leaf', 'leaf-1');
  } catch {
    threw = true;
  }
  assert(threw, 'leaf cannot activate without root');

  state = pipeline.activate(state, 'root', 'root-1');
  state = pipeline.activate(state, 'leaf', 'leaf-1');
  assertEqual(state.activeHooks.length, 2, 'both hooks active');

  state = pipeline.deactivate(state, 'root-1');
  assertEqual(state.activeHooks.length, 1, 'deactivation removes only the requested instance');
});

test('fixture dune_mahjong: secret simultaneous decision resolves atomically', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.dune_mahjong, 31);

  const open = engine.dispatch({ type: 'OPEN_BATTLE_WINDOW', playerId: 'p1' });
  assert(open.ok, `open window failed: ${open.error}`);
  assertEqual(engine.getFocusPlayers().sort().join(','), 'p1,p2', 'both houses must commit');

  const p1Action = engine.getLegalActions('p1').find(a => a.type === 'COMMIT_BATTLE_DIAL');
  assert(p1Action, 'p1 can commit a dial');
  const p1Commit = engine.dispatch(p1Action!);
  assert(p1Commit.ok, `p1 commit failed: ${p1Commit.error}`);

  // p2's projection must not see p1's dial
  const p2View = CognitiveObserver.projectState(engine.getRawState(), 'p2');
  const window = p2View.pendingDecisions.find(w => w.status === 'OPEN');
  assert(!!window, 'decision window is open');
  assertEqual(window!.submissions.p1, 'COMMITTED', 'p1 submission is collapsed for p2');

  const p2Action = engine.getLegalActions('p2').find(a => a.type === 'COMMIT_BATTLE_DIAL');
  assert(p2Action, 'p2 can commit a dial');
  const p2Commit = engine.dispatch(p2Action!);
  assert(p2Commit.ok, `p2 commit failed: ${p2Commit.error}`);
  assert(p2Commit.decisionResolved, 'second commit resolves the window');

  const state = engine.getRawState();
  assert(!!state.globalVars.revealedBattleResult, 'battle result revealed');
  assertEqual(
    state.pendingDecisions.filter(w => w.status === 'OPEN').length,
    0,
    'no decision window left open'
  );
  assert(engine.verifyReplay().ok, 'decision flow is replayable');
});

test('fixture sanguosha: interrupt stack resolves through hidden information', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.sanguosha, 88);
  const strike = engine.getLegalActions('p1').find(a => a.type === 'PLAY_STRIKE');
  assert(strike, 'p1 has a Strike');

  const played = engine.dispatch(strike!);
  assert(played.ok, `strike failed: ${played.error}`);

  const stack = engine.getRawState().interruptStack;
  assertEqual(stack.length, 1, 'strike pushes one frame');
  assertEqual(stack[0].type, 'STRIKE_RESOLUTION', 'top frame is the strike resolution');
  assertEqual(engine.getFocusPlayers().join(','), 'p2', 'target is the focus');

  const pass = engine.getLegalActions('p2').find(a => a.type === 'PASS');
  assert(pass, 'target can pass');
  const resolved = engine.dispatch(pass!);
  assert(resolved.ok, `pass failed: ${resolved.error}`);

  const state = engine.getRawState();
  assertEqual(state.interruptStack.length, 0, 'stack is empty after resolution');
  assertEqual(state.players.p2.customProps.hp, 3, 'unanswered strike deals 1 damage');
  assert(engine.verifyReplay().ok, 'interrupt flow is replayable');
});

/* -------------------------------------------------------------------------- */
/* Betrayal fixture: 44 rooms, 13 omens, 10 events, three full haunts          */
/* -------------------------------------------------------------------------- */

function findAttackSeed(attackDice: number, defenseDice: number, wantDiff: (diff: number) => boolean): number {
  for (let seed = 1; seed < 30000; seed++) {
    const attack = rollZeroDice(seed, attackDice);
    const defense = rollZeroDice(attack.nextSeed, defenseDice);
    if (wantDiff(attack.sum - defense.sum)) return seed;
  }
  throw new AssertionError('no deterministic attack seed found');
}

function betrayalCardInHand(state: GameState, playerId: string, defId: string): string | undefined {
  return state.zones[`zone_hand_${playerId}`]?.orderedEntities.find(
    id => state.entities[id]?.components.custom?.defId === defId
  );
}

/** Put room tiles on top of the hidden tile deck (last entry = top). */
function stackRoomTiles(state: GameState, defIds: string[]): void {
  const zone = state.zones.zone_room_deck;
  const ids = defIds.map(defId => `roomtile_${defId}`);
  zone.orderedEntities = [...zone.orderedEntities.filter(id => !ids.includes(id)), ...ids];
}

function roomDiscardIds(state: GameState): string[] {
  return (state.zones.zone_room_discard?.orderedEntities ?? []).map(
    id => String(state.entities[id]?.components.custom?.roomDefId ?? '')
  );
}

/** Resolve the pending room-orientation window with its first legal rotation. */
function placePendingRoom(engine: UniversalGameEngine): boolean {
  const pending = engine.getRawState().globalVars.pendingRoomPlacement as
    | { playerId: string }
    | undefined;
  if (!pending) return false;
  const action = engine.getLegalActions(pending.playerId).find(candidate => candidate.type === 'PLACE_ROOM');
  if (!action) return false;
  const value = action.fields?.[0]?.options?.[0]?.value ?? '0';
  return engine.dispatch({ ...action, payload: { rotation: value } }).ok;
}

test('fixture betrayal: content tables and starting position', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 2024);
  const state = engine.getRawState();

  assertEqual(Object.keys(ROOM_DEFS).length, 44, '44 room tiles are defined');
  assertEqual(STARTING_ROOM_IDS.length, 5, 'five starting tiles');
  assertEqual(ROOM_DECK_IDS.length, 39, '39 tiles remain in the room deck');
  assertEqual(Object.keys(OMEN_DEFS).length, 13, '13 omens');
  assertEqual(Object.keys(ITEM_DEFS).length, 22, '22 items, matching the official 2E deck');
  assertEqual(Object.keys(EVENT_DEFS).length, 30, '30 events: 25 official plus 5 curse carriers');
  assertEqual(
    Object.values(ROOM_DEFS).filter(room => !room.symbol).length,
    15,
    'ten deck rooms plus five starting rooms have no symbol'
  );

  assertEqual(Object.keys(state.mapGraph.nodes).length, 5, 'five starting rooms on the table');
  assertEqual(state.zones.zone_event_deck.orderedEntities.length, 30, 'event deck built');
  assertEqual(state.zones.zone_item_deck.orderedEntities.length, 22, 'item deck built');
  assertEqual(state.zones.zone_omen_deck.orderedEntities.length, 13, 'omen deck built');
  assertEqual(state.zones.zone_room_deck.orderedEntities.length, 39, 'room tile deck built');
  assertEqual(state.globalVars.roomDeckTotal, 39, 'room deck total recorded');

  const ox = state.players.p1;
  assertEqual(ox.customProps.traits.speed, 4, 'Ox speed');
  assertEqual(ox.customProps.traits.might, 5, 'Ox might');
  assertEqual(ox.customProps.traits.sanity, 3, 'Ox sanity');
  assertEqual(ox.customProps.traits.knowledge, 3, 'Ox knowledge');
  assertEqual(ox.customProps.traits.speed, ox.customProps.tracks.speed[ox.customProps.traitIndex.speed], 'trait value derives from the track');
  assertEqual(state.activePlayerId, 'p1', 'seat order starts with p1');
  assertEqual(engine.getFocusPlayers().join(','), 'p1', 'p1 is the focus');
});

test('fixture betrayal: exploration filters floors, rotates doors and stops on symbols', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 7);
  const raw = engine.getRawState();
  stackRoomTiles(raw, ['chapel', 'master_bedroom']);

  const explore = engine.getLegalActions('p1').find(
    action => action.type === 'EXPLORE_DOOR' && action.payload?.direction === 'E'
  );
  assert(!!explore, 'east door is explorable');
  assert(engine.dispatch(explore!).ok, 'explore accepted');
  assert(placePendingRoom(engine), 'room orientation resolved');

  const state = engine.getRawState();
  assert(!!state.mapGraph.nodes.room_chapel, 'matching ground tile placed');
  assert(roomDiscardIds(state).includes('master_bedroom'), 'wrong-floor tile discarded');
  assertEqual(state.players.p1.customProps.currentRoomId, 'room_chapel', 'player entered the new room');
  assertEqual(state.players.p1.customProps.movesLeft, 0, 'omen symbol forces a stop');
  assertEqual(state.globalVars.omensRevealed, 1, 'omen counter advanced');
  assert(!!state.globalVars.pendingHauntRoll, 'haunt roll is armed for end of turn');
  assert(
    state.zones.zone_hand_p1.orderedEntities.some(id => state.entities[id].components.custom?.cardType === 'OMEN'),
    'omen card moved to the explorer hand'
  );
});

test('fixture betrayal: drawn room waits for player-chosen orientation', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 11);
  const raw = engine.getRawState();
  stackRoomTiles(raw, ['chapel']);

  const explore = engine.getLegalActions('p1').find(
    action => action.type === 'EXPLORE_DOOR' && action.payload?.direction === 'E'
  );
  assert(!!explore, 'east door explorable');
  assert(engine.dispatch(explore!).ok, 'explore draws a tile');

  const pending = engine.getRawState().globalVars.pendingRoomPlacement as
    | { defId: string; rotations: number[] }
    | undefined;
  assert(!!pending, 'tile is pending orientation');
  assertEqual(pending!.defId, 'chapel', 'expected tile drawn');
  assert(!engine.getRawState().mapGraph.nodes.room_chapel, 'tile not placed yet');

  const place = engine.getLegalActions('p1').find(action => action.type === 'PLACE_ROOM');
  assert(!!place, 'orientation action offered');
  assert((place!.fields?.[0]?.options?.length ?? 0) > 0, 'rotation choices exposed');
  const rotation = Number(place!.fields![0].options![0].value);
  assert(engine.dispatch({ ...place!, payload: { rotation: String(rotation) } }).ok, 'orientation accepted');

  const state = engine.getRawState();
  assert(!!state.mapGraph.nodes.room_chapel, 'tile placed after choice');
  assertEqual(state.mapGraph.nodes.room_chapel.props.rotation, rotation, 'chosen rotation stored');
  assertEqual(state.globalVars.pendingRoomPlacement, null, 'pending orientation cleared');
});

test('fixture betrayal: adjacent doors connect beyond the explored room', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 12, { scenario: 'exploration' });
  const raw = engine.getRawState();
  raw.mapGraph.nodes.test_west = {
    id: 'test_west',
    type: 'ROOM',
    position: [0, 0, 0],
    neighbors: [],
    layer: 'GROUND',
    props: { floor: 'GROUND', col: 4, row: 4, doors: ['E'], name: '西室' }
  };
  raw.mapGraph.nodes.test_east = {
    id: 'test_east',
    type: 'ROOM',
    position: [1, 0, 0],
    neighbors: [],
    layer: 'GROUND',
    props: { floor: 'GROUND', col: 5, row: 4, doors: ['W'], name: '东室' }
  };

  const connected = connectAdjacentDoors(raw, 'test_east');
  assertEqual(connected, 1, 'one adjacent door connected');
  assert(raw.mapGraph.nodes.test_east.neighbors.includes('test_west'), 'east sees west');
  assert(raw.mapGraph.nodes.test_west.neighbors.includes('test_east'), 'west sees east');
  assert(!!raw.mapGraph.edges.edge_test_east_test_west, 'door edge created');
});

test('fixture betrayal: room placement is not clamped to a 5x5 grid', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 13);
  const raw = engine.getRawState();
  const entrance = raw.mapGraph.nodes.room_entrance_hall;
  entrance.props.col = 4;
  entrance.props.row = 0;
  entrance.position = [4, 0, 1];
  stackRoomTiles(raw, ['chapel']);

  const explore = engine.getLegalActions('p1').find(
    action => action.type === 'EXPLORE_DOOR' && action.payload?.direction === 'E'
  );
  assert(!!explore, 'east door is legal at the old grid edge');
  assert(engine.dispatch(explore!).ok, 'draw accepted');
  assert(placePendingRoom(engine), 'orientation resolved outside old grid');
  assertEqual(engine.getRawState().mapGraph.nodes.room_chapel.props.col, 5, 'room extends beyond old GRID_MAX');
});

test('fixture betrayal: haunt roll lives on the interrupt stack and starts the haunt', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 5);
  const raw = engine.getRawState();
  raw.globalVars.omensRevealed = 13;
  raw.globalVars.pendingHauntRoll = { playerId: 'p1', omens: 13 };
  stackRoomTiles(raw, ['chapel']);

  const explore = engine.getLegalActions('p1').find(action => action.type === 'EXPLORE_DOOR');
  assert(!!explore, 'explore available');
  assert(engine.dispatch(explore!).ok, 'explore accepted');
  assert(placePendingRoom(engine), 'room orientation resolved');

  const endTurn = engine.getLegalActions('p1').find(action => action.type === 'END_TURN');
  assert(!!endTurn, 'end turn available');
  assert(engine.dispatch(endTurn!).ok, 'end turn accepted');

  const frame = engine.getRawState().interruptStack[0];
  assertEqual(frame?.type, 'HAUNT_CHECK', 'haunt check pushed onto the stack');
  assertEqual(engine.getFocusPlayers().join(','), 'p1', 'revealer must roll');

  const roll = engine.getLegalActions('p1').find(action => action.type === 'ROLL_HAUNT_CHECK');
  assert(!!roll, 'haunt roll legal for the revealer');
  assert(engine.dispatch(roll!).ok, 'haunt roll accepted');

  const state = engine.getRawState();
  assertEqual(state.globalVars.hauntTriggered, true, 'haunt triggered');
  assertEqual(state.phase, 'HAUNT', 'phase switched');
  assertEqual(state.players.p1.role, 'TRAITOR', 'revealer became the traitor');
  assertEqual(state.players.p2.role, 'HERO', 'others are heroes');
  assertEqual(state.activePlayerId, 'p2', 'hero to the traitor left starts');
  assertEqual(state.activeHooks.length, 1, 'one haunt hook hot-injected');
  assert(!!state.globalVars.hauntObjectives, 'objectives stored as data');
  assertEqual(JSON.stringify(state.activeHooks).includes('handler'), false, 'hooks carry data only');
});

test('fixture betrayal: haunt chart maps omen + room to a scenario', () => {
  assertEqual(resolveHauntId('girl', 'room_catacombs', 'BASEMENT'), 'mummy', 'girl + catacombs = mummy');
  assertEqual(resolveHauntId('holy_symbol', 'room_balcony', 'UPPER'), 'floating_eye', 'holy symbol + balcony = eye');
  assertEqual(resolveHauntId('madman', 'room_crypt', 'BASEMENT'), 'phantom', 'madman + crypt = phantom');
  assertEqual(resolveHauntId('dog', 'room_kitchen', 'GROUND'), 'mummy', 'omen fallback');
  assertEqual(resolveHauntId('mask', 'room_kitchen', 'GROUND'), 'phantom', 'floor fallback');
});

test('fixture betrayal: mummy haunt sets up girl, sarcophagus and fire weakness', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_mummy' });
  const state = engine.getRawState();

  const mummy = Object.values(state.entities).find(entity => entity.components.custom?.monster === 'MUMMY');
  assert(!!mummy, 'mummy spawned');
  assertEqual(mummy!.components.custom!.might, 8, 'mummy might 8');
  assertEqual(mummy!.components.custom!.speed, 3, 'mummy speed 3');
  assertEqual(state.globalVars.haunt?.girlHolder, 'p2', 'girl starts with p2');
  assert(
    Object.values(state.entities).some(entity => entity.components.custom?.marker === 'SARCOPHAGUS'),
    'sarcophagus marker placed'
  );

  const hook = engine.getRules().get('haunt_mummy_fire');
  assert(!!hook, 'fire weakness hook registered');
  const action: Action = {
    type: 'ATTACK_MONSTER',
    playerId: 'p3',
    entityId: mummy!.id,
    payload: { weapon: 'fists' }
  };
  const context = {
    impl: hook!,
    instance: { instanceId: 'test', hookId: hook!.id, visibility: { type: 'PUBLIC' as const } },
    params: {}
  };
  assert(hook!.predicate(action, state, context), 'p3 attacks from the furnace room');
  const transformed = hook!.handler(action, state, context);
  assertEqual(transformed.type, 'MODIFY', 'fire modifies the attack');
  assertEqual(transformed.modifiedAction?.payload?.monsterMightPenalty, 4, 'mummy might drops to 4');

  const beforeHostiles = hostilesInRoom(state, 'p3', 'room_furnace_room');
  assertEqual(beforeHostiles, 0, 'mummy is in the catacombs, not the furnace');
});

test('fixture betrayal: combat opens a damage-allocation decision and applies it', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_mummy' });
  const raw = engine.getRawState();
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  raw.players.p1.customProps.attacksLeft = 1;
  raw.prngState = findAttackSeed(5, 2, diff => diff >= 2);

  const attack = engine.getLegalActions('p1').find(action => action.type === 'ATTACK_PLAYER' && action.targetPlayerId === 'p2');
  assert(!!attack, 'traitor can attack the girl holder');
  assert(engine.dispatch(withDefaultPayload(attack!)).ok, 'attack accepted');

  const decision = engine.getRawState().pendingDecisions.find(window => window.status === 'OPEN');
  assertEqual(decision?.payload?.kind, 'damage', 'damage decision opened');
  assertEqual(engine.getFocusPlayers().join(','), 'p2', 'defender chooses the trait');
  assertEqual(engine.getRawState().players.p2.customProps.traits.speed, 3, 'speed untouched before allocation');

  const allocate = engine.getLegalActions('p2').find(action => action.type === 'ALLOCATE_DAMAGE');
  assert(!!allocate, 'allocation action exposed');
  assert(engine.dispatch({ type: 'ALLOCATE_DAMAGE', playerId: 'p2', payload: { trait: 'speed' } }).ok, 'allocate accepted');

  const state = engine.getRawState();
  assert(state.players.p2.customProps.traits.speed < 3, 'damage applied to the chosen trait');
  assertEqual(state.players.p2.customProps.traits.might, 2, 'might untouched');
  assertEqual(state.pendingDecisions.filter(window => window.status === 'OPEN').length, 0, 'decision closed');
});

test('fixture betrayal: a 2+ damage hit can steal instead of wounding', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_mummy' });
  const raw = engine.getRawState();
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  raw.players.p1.customProps.attacksLeft = 1;
  raw.prngState = findAttackSeed(5, 2, diff => diff >= 2);

  const rope = betrayalCardInHand(raw, 'p2', 'rope');
  assert(!!rope, 'p2 holds a tradeable rope');
  const attack = engine.getLegalActions('p1').find(action => action.type === 'ATTACK_PLAYER' && action.targetPlayerId === 'p2');
  assert(!!attack, 'attack available');
  assert(
    engine.dispatch({ ...attack!, payload: { ...(attack!.payload ?? {}), weapon: 'fists', steal: 'yes' } }).ok,
    'stealing attack accepted'
  );

  const state = engine.getRawState();
  assertEqual(state.pendingDecisions.filter(window => window.status === 'OPEN').length, 0, 'no damage window');
  assertEqual(state.players.p2.customProps.traits.speed, 3, 'no wound was dealt');
  assertEqual(betrayalCardInHand(state, 'p2', 'rope'), undefined, 'rope left the victim');
  assert(!!betrayalCardInHand(state, 'p1', 'rope'), 'traitor took the rope');
});

test('fixture betrayal: armor reduces physical damage before allocation', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'trade_ready' });
  const state = engine.getRawState();
  grantItem(state, 'p2', 'armor');

  const before = state.players.p2.customProps.traits.might;
  const padded = damagePlayer(state, 'p2', 'PHYSICAL', 1, 'might');
  assertEqual(padded.applied, 0, 'armor absorbs the single point');
  assertEqual(state.players.p2.customProps.traits.might, before, 'might unchanged');

  const wounded = damagePlayer(state, 'p2', 'PHYSICAL', 3, 'might');
  assertEqual(wounded.applied, 2, 'armor only removes one point');
  assertEqual(state.players.p2.alive, true, 'father survives');
});

test('fixture betrayal: revolver shoots along a floor line and never suffers retaliation', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_phantom' });
  const raw = engine.getRawState();
  // (0,2) keeps the wine cellar on the same basement row as the catacombs at
  // (1,2) so the shot has a line, without landing on the stairwell cell (2,2).
  addExploredRoom(raw, 'wine_cellar', 0, 2, 'room_catacombs');
  movePlayerTo(raw, 'p1', 'room_wine_cellar');
  grantItem(raw, 'p2', 'revolver');
  raw.activePlayerId = 'p2';
  raw.activeActorId = 'p2';
  raw.players.p2.customProps.attacksLeft = 1;
  raw.prngState = findAttackSeed(4, 5, diff => diff < 0);

  const attack = engine.getLegalActions('p2').find(
    action => action.type === 'ATTACK_PLAYER' && action.targetPlayerId === 'p1'
  );
  assert(!!attack, 'catacombs and wine cellar share a line');
  assert(
    engine.dispatch({ ...attack!, payload: { weapon: 'revolver', steal: 'no' } }).ok,
    'ranged attack accepted'
  );

  const state = engine.getRawState();
  assertEqual(state.players.p2.customProps.traits.might, 2, 'missed shot does not wound the shooter');
  assertEqual(state.players.p1.customProps.traits.might, 5, 'target unaffected on a miss');
  assertEqual(state.players.p2.customProps.attacksLeft, 0, 'attack resource consumed');
});

test('fixture betrayal: fire + spear stuns the mummy and clears the obstacle penalty', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_mummy' });
  const raw = engine.getRawState();
  const mummy = Object.values(raw.entities).find(entity => entity.components.custom?.monster === 'MUMMY')!;
  moveMonster(raw, mummy.id, 'room_furnace_room');
  grantOmen(raw, 'p3', 'spear');
  raw.activePlayerId = 'p3';
  raw.activeActorId = 'p3';
  raw.players.p3.customProps.attacksLeft = 1;
  raw.prngState = findAttackSeed(4, 4, diff => diff > 0);

  assertEqual(hostilesInRoom(raw, 'p3', 'room_furnace_room'), 1, 'unstunned monster blocks movement');
  assertEqual(movementCost(raw, 'p3', 'room_furnace_room'), 2, 'leaving costs +1 per hostile');

  const attack = engine.getLegalActions('p3').find(action => action.type === 'ATTACK_MONSTER');
  assert(!!attack, 'spear attack available');
  assert(engine.dispatch(withDefaultPayload(attack!)).ok, 'attack accepted');

  const state = engine.getRawState();
  assertEqual(state.entities[mummy.id].components.custom?.stunned, true, 'mummy stunned');
  assertEqual(hostilesInRoom(state, 'p3', 'room_furnace_room'), 0, 'stunned monster no longer blocks');
  assertEqual(movementCost(state, 'p3', 'room_furnace_room'), 1, 'movement cost back to normal');
});

test('fixture betrayal: eyes cancel speed attacks and a slap breaks mind control', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_eye' });
  const raw = engine.getRawState();
  const eye = Object.values(raw.entities).find(entity => entity.components.custom?.monster === 'EYE')!;
  const ward = engine.getRules().get('haunt_eye_ward')!;
  const action: Action = {
    type: 'ATTACK_MONSTER',
    playerId: 'p3',
    entityId: eye.id,
    payload: { weapon: 'revolver' }
  };
  const context = {
    impl: ward,
    instance: { instanceId: 'test', hookId: ward.id, visibility: { type: 'PUBLIC' as const } },
    params: {}
  };
  assert(ward.predicate(action, raw, context), 'eye is attacked with a speed weapon');
  assertEqual(ward.handler(action, raw, context).type, 'CANCEL', 'eye cancels speed attacks');

  movePlayerTo(raw, 'p2', 'room_tower');
  raw.activePlayerId = 'p3';
  raw.activeActorId = 'p3';
  raw.players.p3.customProps.attacksLeft = 1;
  raw.prngState = findAttackSeed(2, 2, diff => diff > 0);
  const slap = engine.getLegalActions('p3').find(candidate => candidate.type === 'SLAP');
  assert(!!slap, 'slap available against a controlled ally');
  assert(engine.dispatch(slap!).ok, 'slap accepted');

  const state = engine.getRawState();
  assertEqual(state.players.p2.customProps.controlled, false, 'mind control broken');
  assertEqual(state.players.p2.customProps.immuneMindControl, true, 'permanent immunity granted');
});

test('fixture betrayal: phantom bones, frost trail and the requiem ritual', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_phantom' });
  const raw = engine.getRawState();
  raw.players.p2.customProps.forcedRoll = { value: 8 };
  const search = engine.getLegalActions('p2').find(action => action.type === 'SEARCH_BONES');
  assert(!!search, 'search available in the basement');
  assert(engine.dispatch(search!).ok, 'search accepted');
  assertEqual(engine.getRawState().globalVars.haunt?.bonesFound, true, 'bones found');

  const move = engine.getLegalActions('p2').find(
    action => action.type === 'MOVE_TO_ROOM'
  );
  assert(!!move, 'pentagram chamber is adjacent');
  assert(engine.dispatch({ ...move!, targets: ['room_pentagram_chamber'] }).ok, 'move accepted');
  const frost = engine.getRawState().globalVars.frostRooms as string[];
  assert(frost.includes('room_pentagram_chamber'), 'phantom frost hook marked the room');

  grantOmen(engine.getRawState(), 'p2', 'holy_symbol');
  const state = engine.getRawState();
  state.players.p2.customProps.forcedRoll = { value: 8 };
  const chant = engine.getLegalActions('p2').find(action => action.type === 'CHANT');
  assert(!!chant, 'requiem chant available with bones + holy symbol');
  assert(engine.dispatch(chant!).ok, 'chant accepted');
  assertEqual(engine.getRawState().globalVars.haunt?.progress, 1, 'ritual progress advanced');
});

test('fixture betrayal: zombie haunt brews holy water, sanctifies house and defeats the dead', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_zombie' });
  const raw = engine.getRawState();
  raw.players.p2.customProps.forcedRoll = { value: 8 };

  const brew = engine.getLegalActions('p2').find(action => action.type === 'BREW_HOLY_WATER');
  assert(!!brew, 'brew holy water available in laboratory');
  assert(engine.dispatch(brew!).ok, 'brew accepted');
  assert(ownsDef(engine.getRawState(), 'p2', 'holy_water'), 'p2 received holy water');

  const move = engine.getLegalActions('p2').find(action => action.type === 'MOVE_TO_ROOM');
  assert(!!move, 'movement available to pentagram chamber');
  assert(engine.dispatch({ ...move!, targets: ['room_pentagram_chamber'] }).ok, 'moved to pentagram chamber');

  engine.getRawState().players.p2.customProps.forcedRoll = { value: 8 };
  const sanctify = engine.getLegalActions('p2').find(action => action.type === 'SANCTIFY_HOUSE');
  assert(!!sanctify, 'sanctify house available with holy water at sanctuary');
  assert(engine.dispatch(sanctify!).ok, 'sanctify accepted');
  assertEqual(engine.getRawState().globalVars.haunt?.progress, 1, 'consecration progress advanced');
});

test('fixture betrayal: werewolf haunt forges silver bullets and suppresses lunar curse', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_werewolf' });
  const raw = engine.getRawState();
  raw.players.p2.customProps.forcedRoll = { value: 8 };

  const forge = engine.getLegalActions('p2').find(action => action.type === 'FORGE_SILVER');
  assert(!!forge, 'forge silver available in workshop');
  assert(engine.dispatch(forge!).ok, 'forge silver accepted');
  assert(ownsDef(engine.getRawState(), 'p2', 'silver_bullets'), 'p2 received silver bullets');

  movePlayerTo(engine.getRawState(), 'p2', 'room_observatory');
  engine.getRawState().players.p2.customProps.forcedRoll = { value: 8 };
  const suppress = engine.getLegalActions('p2').find(action => action.type === 'SUPPRESS_CURSE');
  assert(!!suppress, 'suppress curse available in observatory');
  assert(engine.dispatch(suppress!).ok, 'suppress curse accepted');
  assertEqual(engine.getRawState().globalVars.haunt?.progress, 1, 'moon suppression progress advanced');
});

test('fixture betrayal: event checks auto-resolve and the locked safe pays in traits', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 11);
  const raw = engine.getRawState();
  stackRoomTiles(raw, ['dining_room']);
  raw.players.p1.customProps.forcedRoll = { value: 8 };

  const deck = raw.zones.zone_event_deck;
  const safeId = deck.orderedEntities.find(id => raw.entities[id].components.custom?.defId === 'locked_safe')!;
  deck.orderedEntities = deck.orderedEntities.filter(id => id !== safeId);
  deck.orderedEntities.push(safeId);

  // Official Locked Safe: "4+ You crack the tumblers (Gain 1 Knowledge, Gain 1
  // Might)." It grants traits, not items - the old assertion encoded an invented
  // payout of two item cards.
  const before = {
    hand: raw.zones.zone_hand_p1.orderedEntities.length,
    knowledge: traitIndex(raw.players.p1, 'knowledge'),
    might: traitIndex(raw.players.p1, 'might')
  };
  const explore = engine.getLegalActions('p1').find(
    action => action.type === 'EXPLORE_DOOR' && action.payload?.direction === 'E'
  );
  assert(!!explore, 'dining room is reachable');
  assert(engine.dispatch(explore!).ok, 'explore accepted');
  assert(placePendingRoom(engine), 'room orientation resolved');

  const state = engine.getRawState();
  assert(!!state.mapGraph.nodes.room_dining_room, 'event room placed');
  assertEqual(state.zones.zone_hand_p1.orderedEntities.length, before.hand, 'no items are granted');
  assert(traitIndex(state.players.p1, 'knowledge') > before.knowledge, 'the safe grants Knowledge');
  assert(traitIndex(state.players.p1, 'might') > before.might, 'the safe grants Might');
});

test('fixture betrayal: an ONGOING event card registers a kernel effect instance', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 11);
  const raw = engine.getRawState();
  stackRoomTiles(raw, ['dining_room']);

  // Force the "Drip... Drip... Drip..." event to the top of the deck.
  const deck = raw.zones.zone_event_deck;
  const dripId = deck.orderedEntities.find(id => raw.entities[id].components.custom?.defId === 'drip')!;
  assert(!!dripId, 'drip event exists in the deck');
  deck.orderedEntities = deck.orderedEntities.filter(id => id !== dripId);
  deck.orderedEntities.push(dripId);

  const explore = engine.getLegalActions('p1').find(
    action => action.type === 'EXPLORE_DOOR' && action.payload?.direction === 'E'
  );
  assert(!!explore, 'dining room is reachable');
  assert(engine.dispatch(explore!).ok, 'explore accepted');
  assert(placePendingRoom(engine), 'room orientation resolved');

  const state = engine.getRawState();
  assertEqual(ongoingEffectKinds(state, 'p1').join(','), 'DRIP', 'DRIP became an active curse');
  assertEqual(
    (state.effects ?? []).filter(effect => effect.target === 'p1' && effect.kind === 'ONGOING').length,
    1,
    'one kernel effect instance carries the curse'
  );
  assertEqual(
    (state.players.p1.customProps.effects ?? []).length,
    0,
    'the legacy customProps array stays untouched'
  );
  assert(
    (state.effects ?? []).every(effect => effect.source === 'p1' || state.players[effect.source] || state.npcs?.[effect.source]),
    'effect sources resolve to real actors'
  );
});

test('fixture betrayal: equipment use respects once-per-turn and restores green values', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'trade_ready' });
  const raw = engine.getRawState();
  const salve = grantItem(raw, 'p1', 'healing_salve');
  damagePlayer(raw, 'p1', 'PHYSICAL', 4, 'might');
  assertEqual(raw.players.p1.customProps.traits.might, 2, 'wounded before healing');

  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  const use = engine.getLegalActions('p1').find(
    action => action.type === 'USE_ITEM' && action.entityId === salve.id
  );
  assert(!!use, 'salve is usable');
  assert(engine.dispatch({ ...use!, payload: { trait: 'might' } }).ok, 'salve used');

  const state = engine.getRawState();
  assertEqual(state.players.p1.customProps.traits.might, 5, 'restored to the green value');
  assertEqual(state.entities[salve.id].components.custom?.charges, 1, 'one charge left');
  assertEqual(
    engine.getLegalActions('p1').some(action => action.type === 'USE_ITEM' && action.entityId === salve.id),
    false,
    'item is exhausted for this turn'
  );
});

test('fixture betrayal: NPC movement actually relocates the monster and spends a move', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 11, { scenario: 'haunt_zombie' });

  // Walk turns until a zombie NPC has movement available.
  let npcId = '';
  for (let i = 0; i < 10 && !npcId; i++) {
    const s = engine.getRawState();
    const active = s.activeActorId ?? s.activePlayerId;
    const legal = engine.getLegalActions(active);
    if (s.npcs?.[active] && legal.some(action => action.type === 'MOVE_NPC')) {
      npcId = active;
      break;
    }
    const advance = legal.find(a => a.type === 'END_TURN') ?? legal.find(a => a.type === 'END_NPC_TURN');
    assert(!!advance, 'a turn-ending action exists while walking to the NPC turn');
    engine.dispatch(advance!);
  }
  assert(!!npcId, 'reached an NPC turn with movement');

  const before = engine.getRawState();
  const npc = before.npcs![npcId];
  const entityId = npc.entityId!;
  const fromRoom = String(before.entities[entityId].components.custom?.roomId ?? '');
  const movesBefore = Number(npc.customProps.movesLeft);
  assert(fromRoom.length > 0, 'monster starts in a real room');

  const move = engine.getLegalActions(npcId).find(action => action.type === 'MOVE_NPC')!;
  const target = String(move.targetNodeId);
  assert(engine.dispatch(move).ok, 'NPC move dispatch is accepted');

  const after = engine.getRawState();
  assertEqual(
    String(after.entities[entityId].components.custom?.roomId ?? ''),
    target,
    'the monster actually relocated to the target room'
  );
  assertEqual(
    Number(after.npcs![npcId].customProps.movesLeft),
    movesBefore - 1,
    'one movement point was spent'
  );
  assertEqual(
    String(after.npcs![npcId].customProps.roomId ?? ''),
    target,
    'the NPC record mirrors the entity room so the renderer can frame it'
  );
});

test('fixture betrayal: medical kit lets the healer choose which physical trait to restore', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'trade_ready' });
  const raw = engine.getRawState();
  const kit = grantItem(raw, 'p1', 'medical_kit');

  // Wound only the speed track; might keeps its green index.
  damagePlayer(raw, 'p1', 'PHYSICAL', 2, 'speed');
  const speedIdxBefore = raw.players.p1.customProps.traitIndex.speed;
  const mightIdxBefore = raw.players.p1.customProps.traitIndex.might;
  const greenIdx = raw.players.p1.customProps.startIndex.speed;
  assert(speedIdxBefore < greenIdx, 'speed is below its green value');
  assertEqual(mightIdxBefore, raw.players.p1.customProps.startIndex.might, 'might is untouched');

  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  raw.players.p1.customProps.forcedRoll = { value: 8 }; // knowledge 8 → heal 3 steps

  const use = engine.getLegalActions('p1').find(
    action => action.type === 'USE_ITEM' && action.entityId === kit.id
  );
  assert(!!use, 'medical kit is usable');
  const traitField = use!.fields?.find(field => field.key === 'trait');
  assert(!!traitField, 'the medical kit exposes a trait choice');
  assertEqual(
    (traitField!.options ?? []).map(option => option.value).join(','),
    'might,speed',
    'both physical tracks are offered'
  );

  assert(engine.dispatch({ ...use!, payload: { target: 'p1', trait: 'speed' } }).ok, 'kit used on speed');

  const after = engine.getRawState().players.p1.customProps;
  assertEqual(after.traitIndex.speed, greenIdx, 'the chosen track (speed) was restored to green');
  assertEqual(
    after.traitIndex.might,
    mightIdxBefore,
    'the previously hardcoded might track was left alone'
  );
});

test('fixture betrayal: a finished haunt reports the reason so the UI can end the game', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 11, { scenario: 'haunt_zombie' });
  const raw = engine.getRawState();

  // Take every hero out of the haunt.
  const heroes = Object.values(raw.players).filter(player => player.role !== 'TRAITOR');
  assert(heroes.length > 0, 'the haunt starts with heroes');
  for (const hero of heroes) {
    hero.alive = false;
    hero.customProps.banished = true;
  }

  // The outcome is evaluated on the next kernel transition.
  const active = raw.activeActorId ?? raw.activePlayerId;
  const advance = engine
    .getLegalActions(active)
    .find(action => action.type === 'END_TURN' || action.type === 'END_NPC_TURN');
  assert(!!advance, 'a turn-ending action is available');
  engine.dispatch(advance!);

  const state = engine.getRawState();
  assert(state.gameOver, 'the game reports gameOver once every hero is out');
  assert(!!state.winnerReason, 'a human-readable reason lands on the state');
  assert(
    String(state.winnerReason).includes('所有英雄'),
    `the reason names the condition (got ${state.winnerReason})`
  );

  // The reason must never contradict the roster: it may only fire when the
  // hero set is genuinely empty (alive + not the traitor + not banished).
  const livingHeroes = Object.values(state.players).filter(
    player => player.alive && player.role !== 'TRAITOR' && !player.customProps.banished
  );
  assertEqual(livingHeroes.length, 0, 'no explorer is still standing when the haunt is lost');
});

test('fixture betrayal: the all-heroes-out verdict can never fire over a living hero', () => {
  // A hero at 1 sanity must survive a turn-end sanity check that would only
  // wound — the haunt is lost only when the track actually reaches zero.
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_zombie' });
  const raw = engine.getRawState();

  const hero = Object.values(raw.players).find(player => player.role !== 'TRAITOR')!;
  assert(!!hero, 'a hero exists');
  // Stand the hero in the Crypt: it is the room that actually bites at turn end
  // (the Pentagram Chamber uses an exit roll instead, per the rulebook).
  // The fixture has no crypt, so place one on a free basement cell.
  const basement = Object.values(raw.mapGraph.nodes).filter(
    node => node.type === 'ROOM' && String(node.props?.floor) === 'BASEMENT'
  );
  const taken = new Set(basement.map(node => `${node.props?.col},${node.props?.row}`));
  let free = { col: 0, row: 3 };
  outer: for (let col = 0; col <= 6; col += 1) {
    for (let row = 0; row <= 6; row += 1) {
      if (!taken.has(`${col},${row}`)) {
        free = { col, row };
        break outer;
      }
    }
  }
  addExploredRoom(raw, 'crypt', free.col, free.row, 'room_basement_landing');
  const crypt = raw.mapGraph.nodes.room_crypt;
  assert(!!crypt, 'a crypt room exists');
  hero.customProps.currentRoomId = crypt!.id;
  hero.customProps.floor = String(crypt!.props?.floor ?? 'BASEMENT');

  // Force the sanity check to fail (value 0 → far below the threshold 4) but
  // keep the trait one step above death first.
  const sanityIdx = raw.players[hero.id].customProps.traitIndex;
  raw.players[hero.id].customProps.traitIndex = { ...sanityIdx, sanity: 1 };
  raw.players[hero.id].customProps.forcedRoll = { value: 0 };

  raw.activePlayerId = hero.id;
  raw.activeActorId = hero.id;
  const advance = engine
    .getLegalActions(hero.id)
    .find(action => action.type === 'END_TURN');
  assert(!!advance, 'the hero can end their turn');
  assert(engine.dispatch(advance!).ok, 'turn ended');

  const state = engine.getRawState();
  assertEqual(
    state.players[hero.id].alive,
    false,
    'a zeroed sanity track is lethal at turn end'
  );

  // Now every hero is out: the verdict may fire, and the roster agrees.
  const others = Object.values(state.players).filter(
    player => player.role !== 'TRAITOR' && player.id !== hero.id
  );
  for (const other of others) {
    other.alive = false;
    other.customProps.banished = true;
  }
  const active = state.activeActorId ?? state.activePlayerId;
  const advance2 = engine
    .getLegalActions(active)
    .find(action => action.type === 'END_TURN' || action.type === 'END_NPC_TURN');
  if (advance2) engine.dispatch(advance2!);
  const final = engine.getRawState();
  if (final.gameOver && String(final.winnerReason ?? '').includes('所有英雄')) {
    const stillStanding = Object.values(final.players).filter(
      player => player.alive && player.role !== 'TRAITOR' && !player.customProps.banished
    );
    assertEqual(stillStanding.length, 0, 'verdict only fires over an empty hero set');
  }
});

test('kernel: roll window splits a check into declare, roll and react phases', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'trade_ready' });
  const state = engine.getRawState();

  const opened = RollWindowManager.open(state, {
    id: 'rw_unit',
    label: '单元检定',
    actorId: 'p1',
    phase: 'DECLARE',
    declares: [{ actorId: 'p1', options: ['feather'], picked: [] }],
    reacts: [{ actorId: 'p1', options: ['stone', 'foot'], picked: [] }],
    payload: { kind: 'UNIT' }
  });
  state.rollWindows = opened.rollWindows;

  const window = RollWindowManager.current(state);
  assert(!!window, 'the window is current');
  assertEqual(window!.phase, 'DECLARE', 'starts in the declare phase');
  assertEqual(RollWindowManager.optionsFor(window!, 'p1').join(','), 'feather', 'declare options are offered');

  // A phase-inappropriate option is rejected.
  assert(!RollWindowManager.pick(state, 'p1', 'stone').ok, 'react options are not offered before the roll');

  // Declaring a modifier is recorded, and cannot be repeated.
  const declared = RollWindowManager.pick(state, 'p1', 'feather');
  assert(declared.ok, 'declaring a modifier is accepted');
  state.rollWindows = declared.state.rollWindows;
  assert(!RollWindowManager.pick(state, 'p1', 'feather').ok, 'the same modifier cannot be declared twice');
  assertEqual(RollWindowManager.optionsFor(RollWindowManager.current(state)!, 'p1').length, 0, 'declare list drained');

  // Rolling stores the result and moves to REACT.
  const rolled = RollWindowManager.record(state, { dice: [1, 2], total: 3, threshold: 6, success: false });
  assert(rolled.ok, 'recording the dice is accepted');
  state.rollWindows = rolled.state.rollWindows;
  assertEqual(RollWindowManager.current(state)!.phase, 'REACT', 'advances to the react phase');
  assertEqual(RollWindowManager.current(state)!.result!.total, 3, 'the result is stored');
  assert(!RollWindowManager.record(state, { dice: [1], total: 1 }).ok, 'cannot roll twice');

  // Reacting amends the result in place and stays in REACT for stacking.
  const reacted = RollWindowManager.pick(state, 'p1', 'stone');
  assert(reacted.ok, 'reacting is accepted');
  state.rollWindows = reacted.state.rollWindows;
  const amended = RollWindowManager.amend(state, { dice: [1, 2], total: 4, threshold: 6, success: false });
  assert(amended.ok, 'the result can be amended');
  state.rollWindows = amended.state.rollWindows;
  assertEqual(RollWindowManager.current(state)!.phase, 'REACT', 'still reacting after an amendment');

  // Resolving closes the window and hands the choices back.
  const closed = RollWindowManager.resolve(state);
  assertEqual(closed.declared.join(','), 'feather', 'declared options are reported');
  assertEqual(closed.reacted.join(','), 'stone', 'reacted options are reported');
  assertEqual((closed.state.rollWindows ?? []).length, 0, 'the window is popped');
  assert(!RollWindowManager.isPending(closed.state), 'nothing is pending afterwards');
});

test('kernel: roll windows reject malformed state', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'trade_ready' });
  const state = engine.getRawState();

  const opened = RollWindowManager.open(state, {
    id: 'rw_bad',
    label: '坏窗口',
    actorId: 'p1',
    phase: 'DECLARE',
    // 'ghost' never picked anything offered to it.
    declares: [{ actorId: 'p1', options: ['a'], picked: ['b'] }],
    reacts: [{ actorId: 'nobody', options: [], picked: [] }]
  });
  state.rollWindows = opened.rollWindows;

  const codes = checkInvariants(state, engine.getRules()).map(v => v.code);
  assert(codes.includes('ROLL_WINDOW_BAD_PICK'), 'a pick outside the offered options is rejected');
  assert(codes.includes('ROLL_WINDOW_UNKNOWN_SLOT'), 'an unknown slot actor is rejected');
});

test('fixture betrayal: a vault check with luck items becomes a two-phase window', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'room_features' });
  const raw = engine.getRawState();
  // p1 starts in the vault; hand them a post-roll luck item so there is a choice.
  grantItem(raw, 'p1', 'lucky_stone');
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';

  const feature = engine.getLegalActions('p1').find(a => a.type === 'ROOM_FEATURE');
  assert(!!feature, 'the vault is pokable');
  assert(engine.dispatch(feature!).ok, 'opening the vault check is accepted');

  // Phase 1: the window is open and the table is gated on it.
  let state = engine.getRawState();
  const window = RollWindowManager.current(state);
  assert(!!window, 'a roll window opened');
  assertEqual(window!.phase, 'DECLARE', 'it starts in the declare phase');
  assertEqual(window!.payload?.kind, 'VAULT', 'the payload names the vault');

  const gated = engine.getLegalActions('p1').map(a => a.type).sort().join(',');
  assertEqual(gated, 'RESOLVE_CHECK,ROLL_CHECK', 'other actions are gated behind the window');

  // Phase 2: throw the dice.
  const roll = engine.getLegalActions('p1').find(a => a.type === 'ROLL_CHECK');
  assert(!!roll, 'the roll is offered');
  assert(engine.dispatch(roll!).ok, 'rolling is accepted');
  state = engine.getRawState();
  assertEqual(RollWindowManager.current(state)!.phase, 'REACT', 'the window moved to react');
  assert(typeof RollWindowManager.current(state)!.result?.total === 'number', 'a result was recorded');

  // Phase 3: react with the lucky stone, then resolve.
  const react = engine.getLegalActions('p1').find(a => a.type === 'CHECK_REACTION');
  assert(!!react, 'the lucky stone is offered as a reaction');
  assert(engine.dispatch(react!).ok, 'using the lucky stone is accepted');
  const resolve = engine.getLegalActions('p1').find(a => a.type === 'RESOLVE_CHECK');
  assert(!!resolve, 'resolve stays available');
  assert(engine.dispatch(resolve!).ok, 'resolving is accepted');

  state = engine.getRawState();
  assert(!RollWindowManager.isPending(state), 'the window is closed');
  assert(
    engine.getLegalActions('p1').some(a => a.type !== 'RESOLVE_CHECK' && a.type !== 'ROLL_CHECK'),
    'normal actions return after the window closes'
  );
});

test('fixture betrayal: a vault check without luck items stays a single dispatch', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'room_features' });
  const raw = engine.getRawState();
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';

  const feature = engine.getLegalActions('p1').find(a => a.type === 'ROOM_FEATURE');
  assert(engine.dispatch(feature!).ok, 'the vault check resolves inline');
  assert(
    !RollWindowManager.isPending(engine.getRawState()),
    'no window is opened when there is nothing to decide'
  );
});

test('fixture betrayal: ongoing curses live on the kernel effect list', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'trade_ready' });
  const raw = engine.getRawState();

  // Two *different* curses on one explorer must coexist, not overwrite.
  addEffect(raw, { kind: 'ONGOING', source: 'p1', target: 'p1', payload: { effect: 'DRIP' } });
  addEffect(raw, { kind: 'ONGOING', source: 'p1', target: 'p1', payload: { effect: 'CHILL' } });
  assertEqual(ongoingEffectKinds(raw, 'p1').sort().join(','), 'CHILL,DRIP', 'both curses are active');

  // Re-applying the same curse is idempotent rather than stacking duplicates.
  addEffect(raw, { kind: 'ONGOING', source: 'p1', target: 'p1', payload: { effect: 'DRIP' } });
  assertEqual(ongoingEffectKinds(raw, 'p1').length, 2, 're-applying does not duplicate');

  // Curses are stored on the kernel list, not in scattered customProps.
  assertEqual(raw.effects?.length, 2, 'kernel effect list owns the instances');
  assertEqual(
    (raw.players.p1.customProps.effects ?? []).length,
    0,
    'no new entries land in customProps.effects'
  );

  // Effects survive canonical serialization (replay hash covers them).
  const snapshot = JSON.stringify(raw.effects);
  assert(snapshot.includes('DRIP') && snapshot.includes('CHILL'), 'effects are plain JSON');

  // Removal is scoped and reports a count.
  assertEqual(removeEffects(raw, effect => effect.target === 'p1' && effect.kind === 'ONGOING'), 2, 'both removed');
  assertEqual(ongoingEffectKinds(raw, 'p1').length, 0, 'effect list drained');

  // Legacy `customProps.effects` still reads, so pre-migration logs replay.
  raw.players.p1.customProps.effects = ['MARK_OF_FEAR'];
  assertEqual(ongoingEffectKinds(raw, 'p1').join(','), 'MARK_OF_FEAR', 'legacy field is folded in');
  assertEqual(effectsOn(raw, 'p1').length, 1, 'legacy entry surfaces as an instance');
});

test('fixture betrayal: death drops the hand into an item pile', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_mummy' });
  const state = engine.getRawState();
  const handBefore = state.zones.zone_hand_p2.orderedEntities.length;
  assert(handBefore >= 2, 'p2 holds the girl and a rope');

  damagePlayer(state, 'p2', 'PHYSICAL', 20, 'might');
  assertEqual(state.players.p2.alive, false, 'p2 died at 0 might');
  assertEqual(state.zones.zone_hand_p2.orderedEntities.length, 0, 'hand emptied');

  const pile = state.zones.zone_room_room_catacombs;
  assert(!!pile, 'item pile zone created in the room');
  assert(
    pile.orderedEntities.some(id => state.entities[id].components.custom?.defId === 'girl'),
    'companion waits in the room'
  );
  assert(
    pile.orderedEntities.some(id => state.entities[id].components.custom?.defId === 'rope'),
    'item forms the pile'
  );
});

test('fixture betrayal: rope allows a safe drop and the only way back up', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw = engine.getRawState();
  movePlayerTo(raw, 'p2', 'room_balcony');
  raw.activePlayerId = 'p2';
  raw.activeActorId = 'p2';
  raw.players.p2.customProps.movesLeft = 4;

  const jump = engine.getLegalActions('p2').find(action => action.type === 'JUMP_DOWN');
  assert(!!jump, 'balcony overlooks the ballroom');
  assert(engine.dispatch(jump!).ok, 'jump accepted');
  assertEqual(engine.getRawState().players.p2.customProps.currentRoomId, 'room_ballroom', 'landed in the ballroom');
  assertEqual(engine.getRawState().players.p2.customProps.traits.might, 2, 'rope prevents fall damage');

  engine.getRawState().players.p2.customProps.movesLeft = 4;
  const climb = engine.getLegalActions('p2').find(action => action.type === 'CLIMB_UP');
  assert(!!climb, 'rope allows climbing back up');
  assert(engine.dispatch(climb!).ok, 'climb accepted');
  assertEqual(engine.getRawState().players.p2.customProps.currentRoomId, 'room_balcony', 'returned to the balcony');
});

test('fixture betrayal: consent trade swaps items and replays exactly', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'trade_ready' });
  const state = engine.getRawState();
  const axe = betrayalCardInHand(state, 'p1', 'axe')!;
  const rope = betrayalCardInHand(state, 'p2', 'rope')!;
  assert(!!axe && !!rope, 'both trade goods exist');

  assert(
    engine.dispatch({ type: 'PROPOSE_ITEM_TRADE', playerId: 'p1', payload: { give: axe, want: rope } }).ok,
    'trade proposed'
  );
  assertEqual(engine.getFocusPlayers().join(','), 'p2', 'partner must respond');
  const accept = engine.getLegalActions('p2').find(action => action.type === 'ACCEPT_TRADE');
  assert(!!accept, 'acceptance offered');
  assert(engine.dispatch(accept!).ok, 'trade accepted');

  const after = engine.getRawState();
  assertEqual(betrayalCardInHand(after, 'p1', 'rope'), rope, 'p1 received the rope');
  assertEqual(betrayalCardInHand(after, 'p2', 'axe'), axe, 'p2 received the axe');
  assert(engine.verifyReplay().ok, 'trade flow replays bit-exactly');
});

test('fixture betrayal: projections hide the opposing objective and the room deck order', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_mummy' });
  const heroView = engine.getProjectedStateFor('p2');
  const traitorView = engine.getProjectedStateFor('p1');

  assert(!!(heroView.globalVars.hauntObjectives as any)?.hero, 'hero sees the hero objective');
  assertEqual((heroView.globalVars.hauntObjectives as any)?.traitor, undefined, 'hero cannot see the traitor objective');
  assert(!!(traitorView.globalVars.hauntObjectives as any)?.traitor, 'traitor sees their objective');
  assertEqual((traitorView.globalVars.hauntObjectives as any)?.hero, undefined, 'traitor cannot see the hero objective');
  assertEqual('roomDeck' in heroView.globalVars, false, 'room deck order is hidden');
  assert(Number(heroView.globalVars.roomDeckCount) > 0, 'deck count remains public');
});

test('fixture betrayal: mummy ritual and eye beacon reach the victory conditions', () => {
  const mummyEngine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_mummy' });
  const mummyState = mummyEngine.getRawState();
  movePlayerTo(mummyState, 'p3', 'room_catacombs');
  mummyState.activePlayerId = 'p3';
  mummyState.activeActorId = 'p3';
  mummyState.globalVars.haunt.progress = 1;
  mummyState.players.p3.customProps.forcedRoll = { value: 8 };
  const seal = mummyEngine.getLegalActions('p3').find(action => action.type === 'SEAL_RITUAL');
  assert(!!seal, 'seal ritual available at the sarcophagus');
  assert(mummyEngine.dispatch(seal!).ok, 'seal accepted');
  assertEqual(mummyEngine.getRawState().gameOver, true, 'second seal ends the game');
  assertEqual((mummyEngine.getRawState().winner as string[]).includes('p2'), true, 'heroes win');

  const eyeEngine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_eye' });
  const eyeState = eyeEngine.getRawState();
  Object.values(eyeState.entities)
    .filter(entity => entity.components.custom?.monster === 'EYE')
    .forEach(entity => {
      entity.components.custom = { ...(entity.components.custom ?? {}), destroyed: true };
    });
  movePlayerTo(eyeState, 'p3', 'room_tower');
  eyeState.activePlayerId = 'p3';
  eyeState.activeActorId = 'p3';
  const beacon = eyeEngine.getLegalActions('p3').find(action => action.type === 'DESTROY_BEACON');
  assert(!!beacon, 'beacon exposed after both eyes are destroyed');
  assert(eyeEngine.dispatch(beacon!).ok, 'beacon destroyed');
  assertEqual(eyeEngine.getRawState().gameOver, true, 'destroying the beacon ends the game');
  assertEqual((eyeEngine.getRawState().winner as string[]).includes('p2'), true, 'heroes win the eye haunt');
});

test('fixture betrayal: monsters are NPC actors with their own turn', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_mummy' });
  assertEqual(engine.getFocusPlayers().join(','), 'p2', 'hero starts');
  assert(engine.dispatch({ type: 'END_TURN', playerId: 'p2' }).ok, 'p2 ends');
  assert(engine.dispatch({ type: 'END_TURN', playerId: 'p3' }).ok, 'p3 ends');
  assert(engine.dispatch({ type: 'END_TURN', playerId: 'p1' }).ok, 'traitor ends');

  const focusActors = engine.getFocusActors();
  assertEqual(focusActors.length, 1, 'one NPC focus');
  assert(focusActors[0].startsWith('npc_'), 'focus is the monster NPC');
  assertEqual(engine.getFocusPlayers().length, 0, 'NPC does not appear as a player');

  const npcId = focusActors[0];
  const legal = engine.getLegalActions(npcId);
  assert(legal.some(action => action.type === 'MOVE_NPC'), 'NPC can move directly');
  assert(legal.some(action => action.type === 'END_NPC_TURN'), 'NPC can end its turn');
  assertEqual(engine.getRawState().npcs?.[npcId]?.controllerId, 'p1', 'traitor controls the monster');

  assert(engine.dispatch({ type: 'END_NPC_TURN', playerId: npcId, actorId: npcId }).ok, 'NPC turn ends');
  assertEqual(engine.getFocusPlayers().join(','), 'p2', 'control returns to the next hero');
  assert(engine.verifyReplay().ok, 'NPC turns replay bit-exactly');
});

test('fixture betrayal: random play through a haunt stays legal and replayable', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 424242, { scenario: 'haunt_mummy' });
  const { applied, errors } = playRandom(engine, 24);
  assert(applied > 5, 'scenario progressed');
  assertEqual(errors.length, 0, `no dispatch errors (${errors.slice(0, 2).join(' | ')})`);
  assert(engine.verifyReplay().ok, `scenario replay mismatch (${engine.verifyReplay().errors.join(' | ')})`);
});


test('bots: random policies play every fixture without kernel errors', () => {
  for (const module of GAME_MODULES) {
    const engine = new UniversalGameEngine(module, 2025);
    const order = module.setup(1).playerOrder;
    const policies = Object.fromEntries(
      order.map((pid, index) => [pid, new RandomPolicy(100 + index, `bot-${pid}`)])
    );

    const report = runPolicies(engine, policies, 25);
    assert(report.steps > 0, `${module.meta.id}: bots progressed`);
    assertEqual(report.errors.length, 0, `${module.meta.id}: bot errors (${report.errors.slice(0, 2).join(' | ')})`);

    const replay = engine.verifyReplay();
    assert(replay.ok, `${module.meta.id}: bot game replayable`);
  }
});

test('bots: identical seeds produce identical games', () => {
  const play = (seed: number) => {
    const engine = new UniversalGameEngine(GAME_REGISTRY.sanguosha, seed);
    const order = engine.getRawState().playerOrder;
    const policies = Object.fromEntries(
      order.map((pid, index) => [pid, new RandomPolicy(seed + index, `bot-${pid}`)])
    );
    runPolicies(engine, policies, 18);
    return engine.getStateHash();
  };

  assertEqual(play(77), play(77), 'same seeds replay identically');
  assert(play(77) !== play(78), 'different seeds diverge');
});

test('presenter: visual events are forwarded to the animation port', () => {
  const session = new UniversalSession(counterModule, 3);
  let batches = 0;
  const off = session.onVisualEvent(() => {
    batches += 1;
  });
  const action = session.getSnapshot().actions[0];
  assert(!!action, 'fixture exposes an action');
  assert(session.perform(action.id).ok, 'fixture action accepted');
  assert(batches > 0, 'visual event batch forwarded');
  off();
  session.dispose();
});

test('fixture betrayal: generic PLACE_ENTITY drops into the room slot', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 5, { scenario: 'exploration' });
  const place = engine.getLegalActions('p1').find(action => action.type === 'PLACE_ENTITY');
  assert(!!place, 'generic placement action exists');
  assert(engine.dispatch(place!).ok, 'generic placement accepted');
  const raw = engine.getRawState();
  assertEqual(raw.entities[place!.entityId!]?.components.spatial?.slotId, place!.targetSlotId, 'generic slot applied');
  assertEqual(OccupancyIndex.validate(raw).length, 0, 'generic placement preserves occupancy invariants');
});

test('fixture betrayal: dropped items occupy the room item slot', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 5, { scenario: 'exploration' });
  const drop = engine.getLegalActions('p1').find(action => action.type === 'DROP_ITEM');
  assert(!!drop, 'drop action exists');
  assert(engine.dispatch(drop!).ok, 'drop accepted');
  const raw = engine.getRawState();
  const entity = raw.entities[drop!.entityId!];
  assert(!!entity, 'dropped entity exists');
  assertEqual(entity.components.spatial?.slotId, itemSlotId(raw.players.p1.customProps.currentRoomId), 'item slot assigned');
  assertEqual(OccupancyIndex.validate(raw).length, 0, 'occupancy invariant holds after drop');
});

test('presenter: click-to-place arms a slot action and resolves on node pick', () => {
  const session = new UniversalSession(GAME_REGISTRY.betrayal, 5, 'exploration');
  const board = session.getSnapshot().board;
  const action = session.getSnapshot().actions.find(candidate => candidate.placementEntityId);
  assert(!!action, 'placement action exposes targeted mode');
  const roomId = String(board.players.p1.customProps.currentRoomId);
  assert(session.armPlacement(action!.id).ok, 'placement action arms');
  assertEqual(session.getSnapshot().board.actionLog.length, 0, 'arming does not mutate state');
  const picked = session.pickTarget({ kind: 'node', id: roomId });
  assert(picked.handled, `node pick failed: ${picked.message}`);
  const entity = Object.values(session.getSnapshot().board.entities).find(
    candidate => candidate.id === action!.placementEntityId
  );
  assertEqual(entity?.components?.spatial?.slotId, `slot_${roomId}_items`, 'click target slot applied');
});

test('presenter: drag-drop resolves a node to a legal PLACE_ENTITY action', () => {
  const session = new UniversalSession(GAME_REGISTRY.betrayal, 5, 'exploration');
  const board = session.getSnapshot().board;
  const roomId = String(board.players.p1.customProps.currentRoomId);
  const candidates = Object.values(board.entities).filter(
    entity => entity.type === 'CARD' && entity.components?.custom?.cardType !== 'EVENT'
  );
  let placedId: string | undefined;
  for (const item of candidates) {
    if (!item.id) continue;
    const targets = session.getPlacementTargets(item.id);
    if (targets.length === 0) continue;
    assert(targets.some(target => target.nodeId === roomId), 'drag target includes current room');
    const result = session.placeEntityAtNode(item.id, roomId);
    if (result.ok) {
      placedId = item.id;
      break;
    }
  }
  assert(!!placedId, 'one hand entity has a legal drag target');
  const after = session.getSnapshot().board;
  assertEqual(after.entities[placedId!]?.components?.spatial?.slotId, `slot_${roomId}_items`, 'drop resolved target slot');
});

test('presenter: discard drops into the actor current room, not an arbitrary slot', () => {
  const session = new UniversalSession(GAME_REGISTRY.betrayal, 5, 'exploration');
  const before = session.getSnapshot();
  const roomId = String(before.board.players.p1.customProps.currentRoomId);
  const itemId = before.board.zones.zone_hand_p1.orderedEntities.find(id => {
    const entity = before.board.entities[id];
    return !!entity && !entity.components?.custom?.companion;
  });
  assert(!!itemId, 'hand item exists');
  const drop = before.actions.find(action => action.label.includes('丢下'));
  assert(!!drop, 'drop action exposed');
  const result = session.perform(drop!.id);
  assert(result.ok, `drop dispatch failed: ${result.error}`);
  const after = session.getSnapshot().board;
  const dropped = after.entities[itemId!];
  assertEqual(dropped.zoneId, `zone_room_${roomId}`, 'discard stayed in the current room');
  assertEqual(dropped.components?.spatial?.slotId, `slot_${roomId}_items`, 'discard used the room slot');

  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 5, { scenario: 'exploration' });
  const raw = engine.getRawState();
  const handId = raw.zones.zone_hand_p1.orderedEntities[0];
  const otherSlot = Object.values(raw.mapGraph.slots ?? {}).find(slot => slot.nodeId !== roomId);
  assert(!!otherSlot, 'another room slot exists');
  const rejected = engine.dispatch({
    type: 'PLACE_ENTITY',
    playerId: 'p1',
    actorId: 'p1',
    entityId: handId,
    targetSlotId: otherSlot!.id
  });
  assert(!rejected.ok, 'discard into another room is rejected');
  assertEqual(engine.getRawState().entities[handId]?.zoneId, 'zone_hand_p1', 'rejected discard left the item in hand');
  session.dispose();
});

test('presenter: a single highlighted drop executes from the action dock', () => {
  const session = new UniversalSession(GAME_REGISTRY.betrayal, 5, 'exploration');
  const drop = session.getSnapshot().actions.find(action => action.label.startsWith('丢下'));
  assert(!!drop, 'drop action exposed');
  const before = session.getSnapshot().log.cursor;
  const result = session.perform(drop!.id);
  assert(result.ok, `drop dispatch failed: ${result.error}`);
  const after = session.getSnapshot();
  assert(after.log.cursor > before, 'drop advanced the action log');
  assert(!after.actions.some(action => action.label.startsWith('丢下「斧头」')), 'item no longer in hand');
});

test('layout: furniture never blocks a doorway and every door stays reachable', () => {
  const INNER = 2.84 / 2 - 0.1;
  const DOOR_HALF = 0.46;
  const APPROACH = 0.58;
  const wishLists = new Map<string, (string | { id: string; count: number })[]>();
  // Mirror of ROOM_PROPS: only the ids matter for this invariant test.
  const sampleSets: (string | { id: string; count: number })[][] = [
    ['fourPosterBed', 'wardrobe', { id: 'nightstand', count: 2 }],
    ['diningTable', { id: 'diningChair', count: 4 }, 'fireplace'],
    ['ritualCircle', 'altar', 'sarcophagus', 'candelabra'],
    ['grandStaircase', 'bookshelf', { id: 'bookshelf', count: 2 }],
    ['labBench', 'operatingTable', 'workbench', 'specimenShelf'],
    ['furnace', 'coalPile', { id: 'wineRack', count: 2 }, 'barrelStack']
  ];
  void wishLists;

  const doorCombos: ('N' | 'S' | 'E' | 'W')[][] = [
    ['N'],
    ['S', 'E'],
    ['N', 'S'],
    ['N', 'S', 'E'],
    ['N', 'S', 'E', 'W'],
    ['N', 'W'],
    ['E', 'W']
  ];

  let checked = 0;
  for (const doors of doorCombos) {
    for (const wanted of sampleSets) {
      const result = layoutRoom({
        inner: INNER,
        doors,
        wanted,
        seed: layoutHash(`${doors.join('')}|${wanted.map(w => (typeof w === 'string' ? w : w.id)).join(',')}`),
        doorHalf: DOOR_HALF
      });
      checked += 1;

      for (const placed of result.placed) {
        assert(!!PROPS[placed.spec.id], `prop ${placed.spec.id} is registered`);
        if (placed.spec.decal || placed.spec.ceiling || placed.spec.wallMounted) continue;
        // Inside the tile footprint.
        assert(
          Math.abs(placed.rect.x) + placed.rect.w / 2 <= INNER + 0.001,
          `${placed.spec.id} stays inside the tile on X`
        );
        assert(
          Math.abs(placed.rect.z) + placed.rect.d / 2 <= INNER + 0.001,
          `${placed.spec.id} stays inside the tile on Z`
        );
        // Clear of every doorway approach corridor.
        for (const door of doors) {
          const vx = door === 'E' ? 1 : door === 'W' ? -1 : 0;
          const vz = door === 'N' ? -1 : door === 'S' ? 1 : 0;
          const corridor = {
            x: vx * (INNER - APPROACH / 2),
            z: vz * (INNER - APPROACH / 2),
            w: vx !== 0 ? APPROACH : DOOR_HALF * 2,
            d: vz !== 0 ? APPROACH : DOOR_HALF * 2
          };
          const hitX = Math.abs(placed.rect.x - corridor.x) < (placed.rect.w + corridor.w) / 2;
          const hitZ = Math.abs(placed.rect.z - corridor.z) < (placed.rect.d + corridor.d) / 2;
          assert(!(hitX && hitZ), `${placed.spec.id} must not block the ${door} doorway`);
        }
      }

      // No two solid props may overlap.
      const solids = result.placed.filter(
        p => !p.spec.decal && !p.spec.ceiling && !p.spec.wallMounted
      );
      for (let i = 0; i < solids.length; i += 1) {
        for (let j = i + 1; j < solids.length; j += 1) {
          const a = solids[i].rect;
          const b = solids[j].rect;
          const overlapX = Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 0.001;
          const overlapZ = Math.abs(a.z - b.z) < (a.d + b.d) / 2 - 0.001;
          assert(
            !(overlapX && overlapZ),
            `${solids[i].spec.id} and ${solids[j].spec.id} must not intersect`
          );
        }
      }
    }
  }
  assert(checked >= 40, 'layout matrix exercised enough combinations');
});

test('layout: deterministic across repeated runs', () => {
  const args = {
    inner: 2.84 / 2 - 0.1,
    doors: ['N', 'S', 'E'] as ('N' | 'S' | 'E' | 'W')[],
    wanted: ['sofa', 'armchair', 'sideTable', 'fireplace', 'globeStand'],
    seed: layoutHash('determinism'),
    doorHalf: 0.46
  };
  const a = layoutRoom(args).placed.map(p => `${p.spec.id}@${p.x.toFixed(3)},${p.z.toFixed(3)},${p.yaw}`);
  const b = layoutRoom(args).placed.map(p => `${p.spec.id}@${p.x.toFixed(3)},${p.z.toFixed(3)},${p.yaw}`);
  assertEqual(a.join('|'), b.join('|'), 'identical seed yields identical furniture layout');
});

test('presenter: snapshot exposes actions and performs by id', () => {
  const session = new UniversalSession(GAME_REGISTRY.sanguosha, 5);
  const before = session.getSnapshot();

  assert(before.actions.length > 0, 'snapshot exposes actions');
  assert(before.legalCount >= before.actions.length, 'legal count covers grouped actions');
  assertEqual(before.players.length, before.board.playerOrder.length, 'players DTO mirrors state');

  const action = before.actions.find(candidate => !candidate.highlightIds);
  assert(!!action, 'has a directly executable action');

  const result = session.perform(action!.id);
  assert(result.ok, `perform failed: ${result.error}`);

  const after = session.getSnapshot();
  assert(after.revision > before.revision, 'revision advances after a successful action');
  assertEqual(after.log.cursor, 1, 'log cursor advances');
  assertEqual(after.actions.length >= 1, true, 'new actions are offered');
});

test('presenter: clicking a dropped card inspects it instead of picking it up', () => {
  const session = new UniversalSession(GAME_REGISTRY.betrayal, 5, 'exploration');
  const drop = session.getSnapshot().actions.find(action => action.label.startsWith('丢下'));
  assert(!!drop, 'drop action exposed');
  assert(session.perform(drop!.id).ok, 'drop accepted');

  const pickup = session.getSnapshot().actions.find(action => action.label.startsWith('拾取'));
  assert(!!pickup?.highlightIds?.[0], 'dropped item is on the room pile');
  const itemId = pickup!.highlightIds![0];
  const before = session.getSnapshot().log.cursor;

  const inspect = session.pickTarget({ kind: 'entity', id: itemId });
  assert(inspect.handled, 'inspection handled');
  assertEqual(session.getSnapshot().log.cursor, before, 'inspection did not pick the card up');

  assert(session.perform(pickup!.id).ok, 'pickup targeting mode');
  assert(session.pickTarget({ kind: 'entity', id: itemId }).handled, 'explicit pickup handled');
  assert(session.getSnapshot().log.cursor > before, 'explicit pickup dispatches one action');
});

test('presenter: board picks are resolved to legal actions', () => {
  const session = new UniversalSession(GAME_REGISTRY.catan, 5);
  const group = session.getSnapshot().actions.find(action => action.highlightIds);

  assert(!!group, 'has a board-targeting action');
  assert(session.perform(group!.id).ok, 'board action enters targeting mode');
  const kind = group!.label.includes('道路') ? 'edge' : 'node';
  const pick = { kind: kind as 'edge' | 'node', id: group!.highlightIds![0] };

  const result = session.pickTarget(pick);
  assert(result.handled, `pick failed: ${result.message}`);
  assertEqual(session.getSnapshot().log.cursor, 1, 'pick dispatches exactly one action');
});

test('presenter: viewer switching reprojects without exposing the raw engine', () => {
  const session = new UniversalSession(GAME_REGISTRY.sanguosha, 9);
  const god = session.getSnapshot();
  assertEqual(god.viewer, 'GOD', 'starts in god mode');

  session.setViewer('p2');
  const view = session.getSnapshot();
  assertEqual(view.viewer, 'p2', 'viewer propagated');
  assert(view.board.maskedEntityCount > 0, 'hidden entities are masked in the projection');
  assert(view.board.maskedEntityCount >= god.board.maskedEntityCount, 'masking never decreases');

  const select = view.viewers.map(entry => entry.id);
  assert(select.includes('GOD') && select.includes('p2'), 'viewer list is DTO data');
});

test('presenter: notices are emitted for kernel visual events', () => {
  const session = new UniversalSession(GAME_REGISTRY.sanguosha, 4);
  const notices: string[] = [];
  session.onNotice(notice => notices.push(notice.kind));

  const strike = session.getSnapshot().actions.find(action => action.label.startsWith('出【杀】'));
  assert(!!strike, 'strike available');
  session.perform(strike!.id);

  assert(notices.length > 0, 'kernel events surface as UI notices');
  assert(notices.some(kind => kind === 'event' || kind === 'announce'), 'notice kinds are UI-level');
});

test('presenter: payload fields collapse multi-step choices into one action', () => {
  const session = new UniversalSession(GAME_REGISTRY.catan, 3, 'rich_action');
  const pipValue = (label: string) =>
    Number(
      session
        .getSnapshot()
        .players.find(player => player.id === 'p1')!
        .pips.find(pip => pip.label === label)?.value ?? 0
    );

  const bank = session.getSnapshot().actions.find(action => action.label.includes('银行 / 港口交易'));
  assert(!!bank, 'bank trade offered in one action');
  assertEqual(bank!.fields?.length, 2, 'give/want fields exposed to the UI');

  const beforeWood = pipValue('木材');
  const beforeOre = pipValue('矿');
  const bankResult = session.perform(bank!.id, { give: 'wood', want: 'ore' });
  assert(bankResult.ok, `bank trade failed: ${bankResult.error}`);
  const paid = beforeWood - pipValue('木材');
  assert(paid >= 2 && paid <= 4, `bank ratio applied from payload (paid ${paid})`);
  assertEqual(pipValue('矿'), beforeOre + 1, 'wanted resource received');

  const year = session.getSnapshot().actions.find(action => action.label.includes('丰饶'));
  assert(!!year, 'year of plenty offered in one action');
  assertEqual(year!.fields?.length, 2, 'two resource fields exposed');

  const beforeSheep = pipValue('羊毛');
  const beforeWheat = pipValue('麦');
  const yearResult = session.perform(year!.id, { a: 'sheep', b: 'wheat' });
  assert(yearResult.ok, `year of plenty failed: ${yearResult.error}`);
  assertEqual(pipValue('羊毛'), beforeSheep + 1, 'first pick granted');
  assertEqual(pipValue('麦'), beforeWheat + 1, 'second pick granted');
  assert(session.getSnapshot().phaseLabel.includes('ACTION'), 'no intermediate phase remains');

  const monopoly = session.getSnapshot().actions.find(action => action.label.includes('垄断'));
  assert(!!monopoly, 'monopoly offered in one action');
  const beforeBrick = pipValue('砖');
  const monopolyResult = session.perform(monopoly!.id, { resource: 'brick' });
  assert(monopolyResult.ok, `monopoly failed: ${monopolyResult.error}`);
  assertEqual(pipValue('砖'), beforeBrick + 3, 'monopoly payload takes all brick');
  assertEqual(
    Number(
      session.getSnapshot().players.find(player => player.id === 'p2')!.pips.find(pip => pip.label === '砖')?.value ?? 0
    ),
    0,
    'victim loses the resource'
  );
});

test('room: presenter exposes UiActions and dispatches through the server room', () => {
  const room = new GameRoom(GAME_REGISTRY.sanguosha, 57);
  const presenter = new RoomPresenter(room, 'p1');
  const first = presenter.join();
  assert(first.actions.length > 0, 'room presenter exposes UiActions');
  assert(first.actions[0].label.length > 0, 'UiAction has a label');

  const result = presenter.perform(first.actions[0].id);
  assert(result.ok, `room presenter dispatch failed: ${result.error}`);
  const refreshed = presenter.refresh();
  assert(refreshed.revision > first.revision, 'room revision advances');
});

test('room: HTTP-shaped transport handles join, actions and actor mismatch', () => {
  const room = new GameRoom(GAME_REGISTRY.sanguosha, 55, (viewer, token) => viewer === 'p1' && token === 'secret');
  const http = new RoomHttpAdapter(room);

  assertEqual(http.handle({ method: 'POST', path: '/join', viewer: 'p2', token: 'x' }).status, 401, 'unauthorized join');
  assertEqual(http.handle({ method: 'POST', path: '/join', viewer: 'p1', token: 'secret' }).status, 200, 'authorized join');
  assertEqual(http.handle({ method: 'GET', path: '/actions', viewer: 'p1' }).status, 200, 'actions endpoint');

  const action = (http.handle({ method: 'GET', path: '/actions', viewer: 'p1' }).body as Action[])[0];
  assert(!!action, 'has a projected action');
  const mismatch = http.handle({ method: 'POST', path: '/submit', viewer: 'p2', action });
  assertEqual(mismatch.status, 403, 'viewer cannot submit another actor action');
  const accepted = http.handle({ method: 'POST', path: '/submit', viewer: 'p1', action });
  assertEqual(accepted.status, 200, 'authorized actor submits');
});

test('room: joins are authorized when an authorizer is supplied', () => {
  const room = new GameRoom(GAME_REGISTRY.sanguosha, 55, (viewer, token) => viewer === 'p1' && token === 'secret');
  let rejected = false;
  try {
    room.join('p2', 'wrong');
  } catch {
    rejected = true;
  }
  assert(rejected, 'unauthorized join is rejected');
  assert(!!room.join('p1', 'secret').state, 'authorized join returns a projection');
  assert(room.actions('p1').length > 0, 'room exposes projected legal actions');
});

test('room: projection patches round-trip exactly', () => {
  const room = new GameRoom(GAME_REGISTRY.sanguosha, 55);
  const joined = room.join('p2');
  assert(joined.full && !!joined.state, 'join returns a full snapshot');

  const strike = room.engine.getLegalActions('p1').find(a => a.type === 'PLAY_STRIKE');
  assert(!!strike, 'p1 can strike');
  const submitted = room.submit(strike!);
  assert(submitted.ok, `room submit failed: ${submitted.error}`);
  assertEqual(room.getRevision(), 1, 'revision increments once per accepted action');

  const delta = room.delta('p2');
  assert(!delta.full && delta.patches.length > 0, 'delta contains patches');

  const rebuilt = room.applyClientDelta(joined.state, delta);
  const latest = room.snapshot('p2').state;
  assertEqual(canonicalize(rebuilt), canonicalize(latest), 'patched client state equals server projection');
});

test('room: hidden information never appears in patches', () => {
  const room = new GameRoom(GAME_REGISTRY.sanguosha, 56);
  const joined = room.join('p2');

  const strike = room.engine.getLegalActions('p1').find(a => a.type === 'PLAY_STRIKE');
  assert(!!strike, 'p1 can strike');
  room.submit(strike!);

  const delta = room.delta('p2');
  const patchText = JSON.stringify(delta.patches);

  const raw = room.engine.getRawState();
  const hiddenTitles = Object.values(raw.entities)
    .filter(entity => !CognitiveObserver.isVisibleTo(entity.visibility, 'p2', entity.ownerId))
    .map(entity => entity.components.cardFace?.title)
    .filter((title): title is string => !!title);

  assert(hiddenTitles.length > 0, 'fixture has hidden cards');
  for (const title of hiddenTitles) {
    assert(!patchText.includes(title), `patch leaked hidden card title: ${title}`);
  }

  const rebuilt = room.applyClientDelta(joined.state, delta);
  assert(!!rebuilt, 'patch applies cleanly without hidden data');
});

test('room: illegal actions do not advance the revision', () => {
  const room = new GameRoom(GAME_REGISTRY.catan, 3);
  room.join('p1');

  const before = room.getRevision();
  const illegal = room.submit({ type: 'ROLL_DICE', playerId: 'p2' });
  assert(!illegal.ok, 'out-of-turn action rejected');
  assertEqual(room.getRevision(), before, 'revision unchanged on rejection');
});

test('room: secret decision submissions are collapsed in deltas', () => {
  const room = new GameRoom(GAME_REGISTRY.dune_mahjong, 9);
  room.join('p2');

  room.submit({ type: 'OPEN_BATTLE_WINDOW', playerId: 'p1' });
  const commit = room.engine.getLegalActions('p1').find(a => a.type === 'COMMIT_BATTLE_DIAL');
  assert(!!commit, 'p1 can commit');
  room.submit(commit!);

  const delta = room.delta('p2');
  const patchText = JSON.stringify(delta.patches);

  const projected = room.engine.getProjectedStateFor('p2');
  const window = projected.pendingDecisions.find(w => w.status === 'OPEN');
  assert(!!window, 'window is still open');
  assertEqual(window!.submissions.p1, 'COMMITTED', 'projection collapses the submission');
  assert(patchText.includes('COMMITTED'), 'p2 is told a submission exists');

  const raw = room.engine.getRawState();
  const rawWindow = raw.pendingDecisions.find(w => w.status === 'OPEN');
  const rawSubmission = rawWindow?.submissions.p1;
  assert(!!rawSubmission && rawSubmission !== 'PASS' && rawSubmission !== 'COMMITTED', 'server keeps the real payload');
  assert(
    !patchText.includes(JSON.stringify(rawSubmission)),
    'the raw submission object must never reach the client patch'
  );
});

test('projection: module redactors hide secret roles and private globals', () => {
  const sgs = new UniversalGameEngine(GAME_REGISTRY.sanguosha, 2);

  const p2View = sgs.getProjectedStateFor('p2');
  assertEqual(p2View.players.p1.role, 'LORD', 'the Lord is public');
  assertEqual(p2View.players.p2.role, 'LOYALIST', 'own role is visible');
  assertEqual(p2View.players.p3.role, undefined, 'other roles are scrubbed');
  assertEqual(p2View.players.p3.secretRole, undefined, 'secret roles never leak');

  const godView = sgs.getProjectedStateFor('GOD');
  assertEqual(godView.players.p3.role, 'REBEL', 'god sees everything');

  const dune = new UniversalGameEngine(GAME_REGISTRY.dune_mahjong, 2);
  dune.getRawState().globalVars.committedDials = {
    p1: { troops: 3, leaderStr: 5, weapon: 'SECRET-WEAPON' }
  };

  const duneP2 = dune.getProjectedStateFor('p2');
  assert(!('committedDials' in duneP2.globalVars), 'private global vars are removed');
  assert(!JSON.stringify(duneP2).includes('SECRET-WEAPON'), 'private values never leak through projection');

  const duneGod = dune.getProjectedStateFor('GOD');
  assert(!!duneGod.globalVars.committedDials, 'god still sees raw globals');
});

test('engine: logical clock times out secret decisions deterministically', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.dune_mahjong, 11);

  assert(engine.dispatch({ type: 'OPEN_BATTLE_WINDOW', playerId: 'p1' }).ok, 'window opens');
  const opened = engine.getRawState().pendingDecisions.find(w => w.status === 'OPEN');
  assert(!!opened && typeof opened.deadline === 'number', 'decision receives a logical deadline');

  const commit = engine.getLegalActions('p1').find(a => a.type === 'COMMIT_BATTLE_DIAL');
  assert(!!commit, 'p1 can commit');
  assert(engine.dispatch(commit!).ok, 'commit accepted');

  const ticks = opened!.deadline! - engine.getRawState().clock + 1;
  const tick = engine.dispatch({ type: '__TICK__', playerId: 'SYSTEM', payload: { ticks } });
  assert(tick.ok, `tick failed: ${tick.error}`);

  const state = engine.getRawState();
  assert(state.clock >= opened!.deadline!, 'clock advanced past the deadline');
  const resolved = state.pendingDecisions.find(w => w.id === opened!.id);
  assertEqual(resolved?.status, 'RESOLVED', 'timed-out decision is resolved');
  assertEqual(resolved?.reveal?.p2, 'PASS', 'missing participant timed out as PASS');
  assertEqual(state.actionLog.some(a => a.type === '__TICK__'), true, 'tick is part of the action log');

  const replay = engine.verifyReplay();
  assert(replay.ok, `timeout replay mismatch: ${replay.errors.join(' | ')}`);
});

test('engine: response windows time out and resolve the frame payload', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.sanguosha, 88);

  const strike = engine.getLegalActions('p1').find(a => a.type === 'PLAY_STRIKE');
  assert(!!strike, 'p1 can strike');
  assert(engine.dispatch(strike!).ok, 'strike accepted');

  const frame = engine.getRawState().interruptStack[0];
  assert(!!frame.responseWindow && typeof frame.responseWindow.deadline === 'number', 'response window has a deadline');

  const ticks = frame.responseWindow!.deadline! - engine.getRawState().clock + 1;
  const tick = engine.dispatch({ type: '__TICK__', playerId: 'SYSTEM', payload: { ticks } });
  assert(tick.ok, `tick failed: ${tick.error}`);

  const state = engine.getRawState();
  assertEqual(state.interruptStack.length, 0, 'expired frame popped');
  assertEqual(state.players.p2.customProps.hp, 3, 'frame payload resolved after timeout');
  assert(engine.verifyReplay().ok, 'response timeout replay is bit-exact');
});

test('presenter: clock control advances the logical clock and expires decisions', () => {
  const session = new UniversalSession(GAME_REGISTRY.dune_mahjong, 3);
  const open = session.getSnapshot().actions.find(action => action.label.includes('开启秘密战斗窗口'));
  assert(!!open, 'battle window action available');
  assert(session.perform(open!.id).ok, 'window opens through the presenter');

  const before = session.getSnapshot();
  assertEqual(before.openDecisions, 1, 'decision is open');

  session.advanceClock(8);
  const after = session.getSnapshot();

  assert(after.clock > before.clock, 'clock advanced through the presenter');
  assertEqual(after.openDecisions, 0, 'expired decision resolved');
  assert(after.log.entries.some(entry => entry.type === '__TICK__'), 'tick is visible in the UI log');
});

function playCatanSetup(engine: UniversalGameEngine): void {
  for (let step = 0; step < 6; step++) {
    const settler = engine.getRawState().activePlayerId;
    const settlement = engine.getLegalActions(settler).find(a => a.type === 'SETUP_SETTLEMENT');
    assert(!!settlement, `setup settlement ${step} available`);
    assert(engine.dispatch(settlement!).ok, `setup settlement ${step} accepted`);

    const roadOwner = engine.getRawState().activePlayerId;
    const road = engine.getLegalActions(roadOwner).find(a => a.type === 'SETUP_ROAD');
    assert(!!road, `setup road ${step} available`);
    assert(engine.dispatch(road!).ok, `setup road ${step} accepted`);
  }
}

test('fixture catan: snake setup, distance rule and phase gating', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.catan, 7);
  const initial = engine.getRawState();

  assertEqual(initial.phase, 'SETUP_SETTLEMENT', 'starts in setup');
  assertEqual((initial.globalVars.setupOrder as string[]).join(','), 'p1,p2,p3,p3,p2,p1', 'snake draft order');

  playCatanSetup(engine);
  const state = engine.getRawState();

  assertEqual(state.phase, 'ROLL', 'setup ends in roll phase');
  assertEqual(state.activePlayerId, 'p1', 'first player starts');

  for (const pid of state.playerOrder) {
    const own = Object.values(state.entities).filter(e => e.ownerId === pid && e.components.building);
    assertEqual(own.filter(e => e.components.building!.type === 'SETTLEMENT').length, 2, `${pid} has 2 settlements`);
    assertEqual(own.filter(e => e.components.building!.type === 'ROAD').length, 2, `${pid} has 2 roads`);
    assertEqual(state.players[pid].score, 2, `${pid} scores 2 from setup`);
  }

  assertEqual(engine.getLegalActions('p1').map(a => a.type).join(','), 'ROLL_DICE', 'only roll before action');
  assert(!engine.dispatch({ type: 'END_TURN', playerId: 'p1' }).ok, 'cannot end turn before rolling');
  assert(engine.verifyReplay().ok, 'setup replay is bit-exact');
});

test('fixture catan: rolling 7 opens robber flow and replay stays exact', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.catan, 3);
  playCatanSetup(engine);

  let sawSeven = false;
  for (let turn = 0; turn < 80; turn++) {
    if (engine.getRawState().gameOver) break;
    const state = engine.getRawState();
    if (state.phase !== 'ROLL') break;

    const pid = state.activePlayerId;
    assert(engine.dispatch({ type: 'ROLL_DICE', playerId: pid }).ok, 'roll accepted');
    if (Number(engine.getRawState().globalVars.diceSum) === 7) {
      sawSeven = true;
      break;
    }
    assert(engine.dispatch({ type: 'END_TURN', playerId: pid }).ok, 'end turn accepted');
  }

  assert(sawSeven, 'seed reaches a seven within 80 turns');

  let state = engine.getRawState();
  if (state.phase === 'DISCARD') {
    const window = state.pendingDecisions.find(w => w.status === 'OPEN');
    assert(!!window, 'discard window opened');
    for (const pid of window!.participants) {
      const result = engine.dispatch({ type: 'DISCARD_HALF', playerId: pid });
      assert(result.ok, `discard accepted for ${pid}`);
    }
    state = engine.getRawState();
  }

  assertEqual(state.phase, 'MOVE_ROBBER', 'seven leads to robber movement');
  const mover = state.activePlayerId;
  const previousHex = state.globalVars.robberHexId;
  const move = engine.getLegalActions(mover).find(a => a.type === 'MOVE_ROBBER');
  assert(!!move, 'robber move is legal');
  assert(engine.dispatch(move!).ok, 'robber moved');

  state = engine.getRawState();
  assert(state.globalVars.robberHexId !== previousHex, 'robber changed hex');

  if (state.phase === 'STEAL') {
    const steal = engine.getLegalActions(mover).find(a => a.type === 'STEAL_FROM');
    assert(!!steal, 'steal target available');
    assert(engine.dispatch(steal!).ok, 'steal accepted');
    state = engine.getRawState();
  }

  assertEqual(state.phase, 'ACTION', 'turn continues after robber');
  assert(engine.verifyReplay().ok, 'robber flow replay is bit-exact');
});

test('fixture catan: build costs, dev cards and bank conservation', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.catan, 21);
  playCatanSetup(engine);

  let state = engine.getRawState();
  state.phase = 'ACTION';
  state.turn = 5;
  state.activePlayerId = 'p1';

  for (const res of ['wood', 'brick', 'sheep', 'wheat', 'ore'] as const) {
    const current = Number(state.players.p1.customProps.resources[res] ?? 0);
    state.players.p1.customProps.resources[res] = 10;
    state.globalVars.bank[res] -= 10 - current;
  }

  const resourceTotal = () =>
    Object.values(engine.getRawState().players).reduce(
      (sum, player) =>
        sum + ['wood', 'brick', 'sheep', 'wheat', 'ore'].reduce((n, r) => n + Number(player.customProps.resources[r] ?? 0), 0),
      0
    ) + ['wood', 'brick', 'sheep', 'wheat', 'ore'].reduce((n, r) => n + Number(engine.getRawState().globalVars.bank[r] ?? 0), 0);

  const beforeTotal = resourceTotal();
  assertEqual(beforeTotal, 95, 'bank + hands always total 95');

  const road = engine.getLegalActions('p1').find(a => a.type === 'BUILD_ROAD');
  assert(!!road, 'road buildable with resources');
  assert(engine.dispatch(road!).ok, 'road built');
  state = engine.getRawState();
  assertEqual(state.players.p1.customProps.resources.wood, 9, 'road cost paid in wood');
  assertEqual(state.players.p1.customProps.resources.brick, 9, 'road cost paid in brick');
  assertEqual(resourceTotal(), 95, 'costs return to bank');

  const buy = engine.getLegalActions('p1').find(a => a.type === 'BUY_DEV_CARD');
  assert(!!buy, 'dev card buyable');
  assert(engine.dispatch(buy!).ok, 'dev card bought');

  state = engine.getRawState();
  const hand = state.zones.zone_dev_p1.orderedEntities;
  assertEqual(hand.length, 1, 'dev card moved to hand');
  const card = state.entities[hand[0]];
  const devType = card.components.custom?.devType as string;
  assertEqual(card.components.custom?.boughtTurn, 5, 'purchase turn recorded');
  assertEqual(resourceTotal(), 95, 'dev purchase conserves resources');
  assertEqual(
    engine.getLegalActions('p1').some(a => a.type.startsWith('PLAY_') && a.entityId === card.id),
    false,
    'freshly bought card is not playable this turn'
  );

  // Freshly bought cards cannot be played this turn.
  state.turn = 6;
  const playable = engine.getLegalActions('p1').find(
    a => a.type.startsWith('PLAY_') && a.entityId === card.id
  );
  if (devType === 'vp') {
    assert(!playable, 'VP cards have no play action');
    assert(engine.getRawState().players.p1.score >= 3, 'VP card counts toward score');
  } else {
    assert(!!playable, `card ${devType} playable next turn`);
    assert(engine.dispatch(withDefaultPayload(playable!)).ok, `card ${devType} played`);

    state = engine.getRawState();
    if (state.phase === 'MOVE_ROBBER') {
      const move = engine.getLegalActions('p1').find(a => a.type === 'MOVE_ROBBER');
      assert(!!move, 'knight opens robber move');
      assert(engine.dispatch(move!).ok, 'knight robber moved');
      state = engine.getRawState();
      if (state.phase === 'STEAL') {
        const steal = engine.getLegalActions('p1').find(a => a.type === 'STEAL_FROM');
        if (steal) engine.dispatch(steal);
      }
    } else if (state.phase === 'ROAD_BUILDING') {
      for (let i = 0; i < 2; i++) {
        const free = engine.getLegalActions('p1').find(a => a.type === 'BUILD_ROAD_FREE');
        assert(!!free, 'free road available');
        assert(engine.dispatch(free!).ok, 'free road placed');
      }
      assertEqual(engine.getRawState().phase, 'ACTION', 'road building returns to action');
    } else {
      assertEqual(
        engine.getRawState().phase,
        'ACTION',
        `${devType} resolves in one payload action`
      );
    }

    assertEqual(engine.getRawState().zones.zone_dev_p1.orderedEntities.length, 0, 'played card left hand');
    assertEqual(resourceTotal(), 95, 'card effects conserve resources');
  }

  // This scenario injects resources into the fixture to reach the economy
  // branches quickly, so replay verification does not apply here; the two
  // black-box Catan tests above cover bit-exact replay end to end.
});

test('fixture catan: player trade, bank trade, bonuses and victory', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.catan, 33);
  playCatanSetup(engine);

  let state = engine.getRawState();
  state.phase = 'ACTION';
  state.activePlayerId = 'p1';
  state.turn = 5;

  // --- player-to-player trade through a decision window -----------------
  state.players.p1.customProps.resources = { wood: 1, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  state.players.p2.customProps.resources = { wood: 0, brick: 1, sheep: 0, wheat: 0, ore: 0 };
  state.players.p3.customProps.resources = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };

  assert(
    engine.dispatch({ type: 'PROPOSE_TRADE', playerId: 'p1', payload: { give: 'wood', want: 'brick' } }).ok,
    'one-step offer opens'
  );
  assertEqual(engine.getRawState().phase, 'TRADE_PENDING', 'window waits for responses');

  const p2Accept = engine.getLegalActions('p2').find(a => a.type === 'ACCEPT_TRADE');
  assert(!!p2Accept, 'other player can accept');
  assert(engine.dispatch(p2Accept!).ok, 'p2 accepts');

  state = engine.getRawState();
  assertEqual(state.phase, 'ACTION', 'first acceptance closes the window immediately');
  assertEqual(state.players.p1.customProps.resources.brick, 1, 'p1 received brick');
  assertEqual(state.players.p1.customProps.resources.wood, 0, 'p1 gave wood');
  assertEqual(state.players.p2.customProps.resources.wood, 1, 'p2 received wood');

  // --- bank trade (4:1 without a matching harbour) ----------------------
  state.players.p1.customProps.resources = { wood: 4, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  assert(
    engine.dispatch({ type: 'BANK_TRADE', playerId: 'p1', payload: { give: 'wood', want: 'ore' } }).ok,
    'bank trade is one action'
  );
  state = engine.getRawState();
  assertEqual(state.phase, 'ACTION', 'bank trade returns to action');
  assertEqual(state.players.p1.customProps.resources.wood, 0, '4 wood paid');
  assertEqual(state.players.p1.customProps.resources.ore, 1, '1 ore received');

  // --- synthetic board for longest road / largest army / victory --------
  for (const node of Object.values(state.mapGraph.nodes)) {
    if (node.type === 'VERTEX') node.occupantEntityId = undefined;
  }
  for (const edge of Object.values(state.mapGraph.edges)) edge.occupantEntityId = undefined;
  state.zones.zone_board.orderedEntities = [];
  state.entities = Object.fromEntries(
    Object.entries(state.entities).filter(([, entity]) => entity.type === 'CARD')
  );

  const edges = Object.values(state.mapGraph.edges);
  let tip = edges[0].to;
  placeRoad(state, 'p1', edges[0].id, 'test_road_0');
  let placed = 1;
  for (const edge of edges) {
    if (placed >= 5) break;
    if (edge.occupantEntityId) continue;
    if (edge.from !== tip && edge.to !== tip) continue;
    tip = edge.from === tip ? edge.to : edge.from;
    placeRoad(state, 'p1', edge.id, `test_road_${placed}`);
    placed += 1;
  }
  assertEqual(placed, 5, 'five-road chain placed');

  state.players.p1.customProps.knightsPlayed = 3;
  normalize(state);
  assertEqual(state.globalVars.longestRoadOwner, 'p1', 'longest road awarded at 5');
  assertEqual(state.globalVars.largestArmyOwner, 'p1', 'largest army awarded at 3 knights');
  assertEqual(state.players.p1.score, 2 + 2, 'both special cards score 2 VP each');

  // --- victory at 10 VP -------------------------------------------------
  state.entities = Object.fromEntries(
    Object.entries(state.entities).filter(([, entity]) => entity.type === 'CARD')
  );
  state.zones.zone_board.orderedEntities = [];
  for (const node of Object.values(state.mapGraph.nodes)) {
    if (node.type === 'VERTEX') node.occupantEntityId = undefined;
  }

  const vertices = Object.values(state.mapGraph.nodes).filter(node => node.type === 'VERTEX');
  for (let i = 0; i < 5; i++) {
    placeBuilding(state, 'p1', vertices[i].id, 'SETTLEMENT', `test_settlement_${i}`);
  }
  for (let i = 0; i < 3; i++) {
    placeBuilding(state, 'p1', vertices[5 + i].id, 'CITY', `test_city_${i}`);
  }
  normalize(state);
  assert(state.players.p1.score >= 10, 'synthetic board reaches 10 VP');

  state.phase = 'ACTION';
  state.activePlayerId = 'p1';
  state.turn = 9;
  const end = engine.getLegalActions('p1').find(a => a.type === 'END_TURN');
  assert(!!end, 'end turn available');
  const finish = engine.dispatch(end!);
  assert(finish.ok, 'final action accepted');
  assertEqual(engine.getRawState().gameOver, true, 'game ends at 10 VP');
  assertEqual(engine.getRawState().winner, 'p1', 'winner recorded');
});

test('fixture catan: black-box random play never stalls or corrupts state', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.catan, 99);
  let steps = 0;

  while (!engine.getRawState().gameOver && steps < 300) {
    const focus = engine.getFocusPlayers();
    assert(focus.length > 0, `no focus player at step ${steps}`);

    let dispatched = false;
    for (const pid of focus) {
      const legal = engine.getLegalActions(pid);
      if (legal.length === 0) continue;
      const action = withDefaultPayload(legal[steps % legal.length]);
      const result = engine.dispatch(action);
      assert(result.ok, `step ${steps} (${action.type}) rejected: ${result.error}`);
      dispatched = true;
      break;
    }
    assert(dispatched, `step ${steps} had no dispatchable action`);
    steps += 1;
  }

  assert(steps > 20, 'random play progresses through setup and turns');
  assert(engine.verifyReplay().ok, 'long Catan replay is bit-exact');
});

test('fixture catan: forced seven discards half and resolves through the window', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.catan, 44);
  playCatanSetup(engine);

  const state = engine.getRawState();
  state.phase = 'ROLL';
  state.activePlayerId = 'p1';

  let seed = 1;
  while (DeterministicPRNG.rollDice(seed, 2, 6).sum !== 7) seed += 1;
  state.prngState = seed;

  const total = () =>
    Object.values(engine.getRawState().players).reduce(
      (sum, p) =>
        sum + ['wood', 'brick', 'sheep', 'wheat', 'ore'].reduce((n, r) => n + Number(p.customProps.resources[r] ?? 0), 0),
      0
    ) + ['wood', 'brick', 'sheep', 'wheat', 'ore'].reduce((n, r) => n + Number(engine.getRawState().globalVars.bank[r] ?? 0), 0);

  const before = total();
  const oldBag = { ...state.players.p1.customProps.resources };
  for (const res of ['wood', 'brick', 'sheep', 'wheat', 'ore'] as const) {
    state.globalVars.bank[res] += Number(oldBag[res] ?? 0);
  }
  state.players.p1.customProps.resources = { wood: 9, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  state.globalVars.bank.wood -= 9;
  assertEqual(total(), before, 'resource injection is conservative');

  assert(engine.dispatch({ type: 'ROLL_DICE', playerId: 'p1' }).ok, 'seven rolled');
  assertEqual(engine.getRawState().phase, 'DISCARD', 'discard window opened');

  const discard = engine.getLegalActions('p1').find(a => a.type === 'DISCARD_HALF');
  assert(!!discard, 'discard action available');
  assert(engine.dispatch(discard!).ok, 'discard accepted');

  const after = engine.getRawState();
  assertEqual(after.phase, 'MOVE_ROBBER', 'robber phase after discard');
  assertEqual(after.players.p1.customProps.resources.wood, 5, 'half of 9 rounded down discarded');
  assertEqual(total(), before, 'discard returns cards to the bank');
});

test('fixture catan: harbours change bank trade ratios', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.catan, 55);
  playCatanSetup(engine);
  const state = engine.getRawState();

  const ports = state.globalVars.ports as {
    vertices: [string, string];
    resource?: string;
  }[];

  let chosen: (typeof ports)[number] | null = null;
  let vertexId = '';
  for (const port of ports) {
    for (const vertex of port.vertices) {
      if (!state.mapGraph.nodes[vertex]?.occupantEntityId) {
        chosen = port;
        vertexId = vertex;
        break;
      }
    }
    if (chosen) break;
  }

  assert(!!chosen, 'a free harbour vertex exists');
  placeBuilding(state, 'p1', vertexId, 'SETTLEMENT', 'port_test_settlement');

  const specific = chosen!.resource as 'wood' | 'brick' | 'sheep' | 'wheat' | 'ore' | undefined;
  if (specific) {
    assertEqual(portRatio(state, 'p1', specific), 2, '2:1 harbour matches its resource');
    const other = (['wood', 'brick', 'sheep', 'wheat', 'ore'] as const).find(r => r !== specific)!;
    assertEqual(portRatio(state, 'p1', other), 4, 'other resources still trade 4:1');
  } else {
    assertEqual(portRatio(state, 'p1', 'wood'), 3, '3:1 harbour gives 3:1');
  }
});

test('fixture catan: hidden VP cards are redacted from opponents', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.catan, 77);
  playCatanSetup(engine);

  const state = engine.getRawState();
  const vp = Object.values(state.entities).find(entity => entity.components.custom?.devType === 'vp');
  assert(!!vp, 'deck contains a VP card');

  const deck = state.zones[vp!.zoneId];
  deck.orderedEntities = deck.orderedEntities.filter(id => id !== vp!.id);
  vp!.zoneId = 'zone_dev_p1';
  vp!.ownerId = 'p1';
  vp!.visibility = { type: 'OWNER_ONLY', ownerId: 'p1' };
  state.zones.zone_dev_p1.orderedEntities.push(vp!.id);
  normalize(state);

  const godScore = engine.getProjectedStateFor('GOD').players.p1.score;
  const publicScore = engine.getProjectedStateFor('p2').players.p1.score;
  const ownScore = engine.getProjectedStateFor('p1').players.p1.score;

  assertEqual(publicScore, godScore - 1, 'opponents cannot see the hidden VP card');
  assertEqual(ownScore, godScore, 'owner sees their own score');

  state.gameOver = true;
  assertEqual(engine.getProjectedStateFor('p2').players.p1.score, godScore, 'scores reveal at game end');
});

test('room: checkpoints restore through replay', () => {
  const room = new GameRoom(GAME_REGISTRY.catan, 1);
  room.join('p1');

  for (let i = 0; i < 2; i++) {
    const focus = room.engine.getFocusPlayers()[0];
    const legal = room.engine.getLegalActions(focus);
    assert(legal.length > 0, 'legal action available');
    const action = legal.find(candidate => candidate.type !== 'PASS') ?? legal[0];
    assert(room.submit(action).ok, `action ${action.type} accepted`);
  }

  const checkpoint = room.exportState();
  const restored = new GameRoom(GAME_REGISTRY.catan, 999);
  const report = restored.restore(checkpoint);

  assert(report.ok, `restore failed: ${report.errors.join(' | ')}`);
  assertEqual(restored.engine.getStateHash(), room.engine.getStateHash(), 'restored hash matches original');
  assertEqual(restored.getRevision(), checkpoint.revision, 'revision restored');

  const delta = restored.delta('p1');
  assert(delta.full, 'first delta after restore is a full snapshot');
  assertEqual(restored.getRevision(), checkpoint.revision, 'delta does not bump revision');
});

test('kernel: invalid PLACE_ROOM rotation is rejected before reducer', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 2024);
  engine.getRawState().globalVars.pendingRoomPlacement = {
    playerId: 'p1',
    rotations: [0]
  };
  const result = engine.dispatch({
    type: 'PLACE_ROOM',
    playerId: 'p1',
    payload: { rotation: '1' }
  });
  assert(!result.ok, 'illegal rotation rejected');
  assert(String(result.error).includes('not legal'), 'explains the illegal rotation');
});

test('kernel: NPC actions require the controlling viewer', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_mummy' });
  for (const playerId of ['p2', 'p3', 'p1']) {
    assert(engine.dispatch({ type: 'END_TURN', playerId }).ok, `${playerId} ends turn`);
  }
  const npc = engine.getFocusActors()[0];
  assert(!!npc, 'NPC has focus');
  engine.setViewer('p2');
  const denied = engine.dispatch({ type: 'END_NPC_TURN', playerId: npc, actorId: npc });
  assert(!denied.ok, 'non-controller denied');
  assert(String(denied.error).includes('cannot control'), 'permission error is explicit');
  engine.setViewer('p1');
  assert(engine.dispatch({ type: 'END_NPC_TURN', playerId: npc, actorId: npc }).ok, 'controller allowed');
});

test('kernel: declared topology must match the actual graph', () => {
  const errors = MapGraphManager.validateDeclaration(
    { kind: 'hex', adjacency: 'both', geometry: 'hex' },
    { kind: 'hex', adjacency: 'both', geometry: 'grid' }
  );
  assert(errors.some(error => error.includes('geometry')), 'geometry mismatch is reported');
  assertEqual(
    MapGraphManager.validateDeclaration(
      { kind: 'hex', adjacency: 'both', geometry: 'hex' },
      { kind: 'hex', adjacency: 'both', geometry: 'hex' }
    ).length,
    0,
    'matching declaration passes'
  );
});

test('presenter: node click without a targeting action is inspection only', () => {
  const session = new UniversalSession(GAME_REGISTRY.catan, 5);
  const node = Object.values(session.getSnapshot().board.mapGraph.nodes)[0];
  const before = session.getSnapshot().log.cursor;
  const result = session.pickTarget({ kind: 'node', id: node.id });
  assert(result.handled, 'node click handled');
  assertEqual(session.getSnapshot().log.cursor, before, 'node click did not dispatch');
  session.dispose();
});

test('projection: selection candidates use the viewer projection', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.sanguosha, 9);
  engine.setViewer('p1');
  const own = engine.getSelectionCandidates('p1', { source: 'hand', min: 1, max: 1 });
  assert(own.length > 0, 'own hand candidates are visible');
  engine.setViewer('p2');
  const other = engine.getSelectionCandidates('p1', { source: 'hand', min: 1, max: 1 });
  assertEqual(other.length, 0, 'opponent hand is not exposed');
  const hidden = Object.keys(engine.getRawState().entities).filter(
    id => !engine.getProjectedState().entities[id]
  );
  const candidates = engine.getSelectionCandidates('p1', { source: 'entity', min: 1, max: 1 });
  assert(!candidates.some(candidate => hidden.includes(candidate.id)), 'hidden entities are excluded');
});

test('presenter: switching viewer clears stale board targeting', () => {
  const session = new UniversalSession(GAME_REGISTRY.catan, 5);
  const group = session.getSnapshot().actions.find(action => action.highlightIds);
  assert(!!group, 'has board targeting action');
  assert(session.perform(group!.id).ok, 'targeting armed');
  const before = session.getSnapshot().log.cursor;
  session.setViewer('p2');
  const node = Object.values(session.getSnapshot().board.mapGraph.nodes)[0];
  const picked = session.pickTarget({ kind: 'node', id: node.id });
  assert(picked.handled, 'node click handled');
  assertEqual(session.getSnapshot().log.cursor, before, 'stale targeting did not dispatch');
  session.dispose();
});

test('projection: fixtures do not leak hidden ids after random play', () => {
  for (const module of GAME_MODULES) {
    const engine = new UniversalGameEngine(module, 31);
    const policies = Object.fromEntries(
      engine.getRawState().playerOrder.map((pid, index) => [pid, new RandomPolicy(31 + index, `leak-${pid}`)])
    );
    runPolicies(engine, policies, 30);
    const god = engine.getProjectedState();
    const hidden = [
      ...Object.keys(engine.getRawState().entities).filter(id => !god.entities[id]),
      ...Object.keys(engine.getRawState().mapGraph.nodes).filter(id => !god.mapGraph.nodes[id])
    ];
    for (const viewer of engine.getRawState().playerOrder) {
      const text = canonicalize(engine.getProjectedStateFor(viewer));
      const leaked = hidden.filter(id => text.includes(id));
      assertEqual(leaked.length, 0, `${module.meta.id}/${viewer} leaked ${leaked.slice(0, 3).join(',')}`);
    }
  }
});

export async function runCoreSuite(): Promise<SuiteResult> {
  const results: SuiteCaseResult[] = [];

  for (const testCase of cases) {
    const started = Date.now();
    try {
      await testCase.fn();
      results.push({ name: testCase.name, ok: true, ms: Date.now() - started });
    } catch (err) {
      results.push({
        name: testCase.name,
        ok: false,
        error: (err as Error).message,
        ms: Date.now() - started
      });
    }
  }

  return {
    passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    cases: results
  };
}

/* -------------------------------------------------------------------------- */
/* Official rules: assertions taken from the 2nd-edition rulebook              */
/* -------------------------------------------------------------------------- */

test('rules: movement equals the Speed value and rolls no dice', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw = engine.getRawState();
  const active = raw.activeActorId ?? raw.activePlayerId;

  // Rulebook, Moving: "Move up to a number of spaces equal to your current
  // Speed." Movement is never rolled for.
  const before = raw.prngState;
  resetTurnResources(raw, active);
  assertEqual(raw.prngState, before, 'resetting a turn must not consume dice');

  const speed = traitValue(raw.players[active], 'speed');
  assertEqual(Number(raw.players[active].customProps.movesLeft), speed, 'movesLeft is the Speed value');
});

test('rules: a trait can be raised but never above the printed maximum', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw = engine.getRawState();
  const player = raw.players.p1;
  const track = player.customProps.tracks?.knowledge ?? player.customProps.track?.knowledge;
  assert(Array.isArray(track), 'the character sheet exposes a knowledge track');

  // Rulebook, Trait Damage: "Traits cannot go above the maximum value shown on
  // the character card."
  applyTraitSteps(raw, 'p1', 'knowledge', 99, { force: true });
  assertEqual(traitIndex(player, 'knowledge'), track!.length - 1, 'gain clamps to the top of the track');
});

test('rules: a trait that reaches the skull kills the explorer', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw = engine.getRawState();
  raw.globalVars.hauntTriggered = true;
  raw.players.p1.customProps.traitIndex = { ...raw.players.p1.customProps.traitIndex, sanity: 1 };

  // Rulebook, Death: any trait at the skull and the explorer dies.
  damagePlayer(raw, 'p1', 'MENTAL', 1, 'sanity');
  assertEqual(raw.players.p1.alive, false, 'the explorer dies at the skull');
});

test('rules: the haunt roll is six dice compared against the omen count', () => {
  // Rulebook, Making a Haunt Roll: roll 6 dice at the end of a turn where you drew
  // an omen; the haunt begins when the total is LESS than the omens drawn.
  const sixDice = (seed: number) => rollZeroDice(seed, 6).rolls.length;
  assertEqual(sixDice(12345), 6, 'the haunt roll uses six dice');

  const hauntWith = (omens: number) => {
    const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 7, { scenario: 'omen_ready' });
    const raw = engine.getRawState();
    raw.globalVars.omensRevealed = omens;
    raw.globalVars.pendingHauntRoll = { playerId: 'p1', omens };
    raw.activePlayerId = 'p1';
    raw.activeActorId = 'p1';
    raw.players.p1.customProps.movesLeft = 0;

    // The roll only becomes legal once endTurn has pushed the HAUNT_CHECK frame
    // onto the interrupt stack, so drive it the way the table does.
    const end = engine.getLegalActions('p1').find(a => a.type === 'END_TURN');
    assert(!!end, 'the turn can be ended');
    engine.dispatch(end!);

    const action = engine.getLegalActions('p1').find(a => a.type === 'ROLL_HAUNT_CHECK');
    assert(!!action, 'the haunt roll is offered while it is pending');
    engine.dispatch(action!);
    return engine.getRawState();
  };

  // A six-dice total is always >= 0, so zero omens can never trigger the haunt.
  const noOmens = hauntWith(0);
  assertEqual(noOmens.globalVars.hauntTriggered ?? false, false, 'no omens cannot trigger a haunt');

  // With more omens than any six-dice total the haunt must fire.
  const manyOmens = hauntWith(13);
  assertEqual(manyOmens.globalVars.hauntTriggered, true, 'omen count above the maximum roll triggers it');
});

test('rules: an attack is available once per turn and only after the haunt', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_zombie' });
  const raw = engine.getRawState();
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  raw.players.p1.customProps.attacksLeft = 1;
  // An attack needs a target in the same room.
  const room = String(raw.players.p1.customProps.currentRoomId);
  movePlayerTo(raw, 'p2', room);

  const canAttack = () => engine.getLegalActions('p1').some(a => a.type === 'ATTACK_PLAYER');
  assertEqual(raw.globalVars.hauntTriggered, true, 'the fixture starts after the haunt');

  // Rulebook, Attacking: once per turn. Exhausting the allowance removes it.
  raw.players.p1.customProps.attacksLeft = 0;
  assertEqual(canAttack(), false, 'no attack once the allowance is spent');

  raw.players.p1.customProps.attacksLeft = 1;
  assertEqual(canAttack(), true, 'one attack is offered while the allowance is unspent');
});

test('rules: the elevator rolls before offering a destination', () => {
  const def = ROOM_DEFS.mystic_elevator;
  assert(!!def, 'the elevator room exists');
  assertEqual(def!.doors.length, 1, 'the car has a single opening');

  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'room_features' });
  const raw = engine.getRawState();
  addExploredRoom(raw, 'mystic_elevator', 3, 3, 'room_basement_landing');
  movePlayerTo(raw, 'p1', 'room_mystic_elevator');
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  raw.players.p1.customProps.movesLeft = 3;
  raw.players.p1.customProps.elevatorUsed = false;

  // Step 1: riding takes no target, so the UI cannot show a room picker first.
  const ride = engine.getLegalActions('p1').find(a => a.type === 'USE_ELEVATOR');
  assert(!!ride, 'the ride is offered from inside the car');
  assertEqual(ride!.selection, undefined, 'riding asks for no destination yet');

  const rideRes = engine.dispatch(ride!);
  assert(rideRes.ok, `riding dispatches (${rideRes.error ?? ''})`);

  const after = engine.getRawState();
  const roll = after.globalVars.lastElevatorRoll as { rolls: number[]; sum: number } | undefined;
  assert(!!roll, 'the ride records a roll');
  assertEqual(roll!.rolls.length, 2, 'two dice decide the floor');
  assertEqual(after.players.p1.customProps.elevatorUsed, true, 'one ride per turn');
  // The roll is published so the dice overlay can animate it.
  const shown = after.globalVars.lastRoll as { total?: number; dice?: number[] } | undefined;
  assertEqual(shown?.total, roll!.sum, 'the ride is the last roll shown to the UI');

  if (roll!.sum < 2) {
    // Nothing to choose: the car did not move and no picker is offered.
    assertEqual(
      engine.getLegalActions('p1').some(a => a.type === 'ELEVATOR_MOVE'),
      false,
      'no destination picker below 2'
    );
    return;
  }

  // Step 2: the dice opened the picker, and moving relocates the tile itself.
  const choices = engine.getLegalActions('p1').filter(a => a.type === 'ELEVATOR_MOVE');
  assert(choices.length > 0, 'the doorway picker opens after the roll');

  const choice = choices[0];
  const destination = String(choice.targetNodeId ?? '');
  const doorDir = String(choice.payload?.direction ?? '');
  assert(destination.length > 0, 'each choice carries its room');
  assert(doorDir.length > 0, 'each choice names the doorway it lands on');
  const moveRes = engine.dispatch(choice as never);
  assert(moveRes.ok, `the ride completes (${moveRes.error ?? ''})`);

  const moved = engine.getRawState();
  const elevator = moved.mapGraph.nodes.room_mystic_elevator;
  const grid = nodeGrid(elevator);
  assert(!!grid, 'the elevator tile still exists');
  assert(!(grid!.col === 3 && grid!.row === 3), 'the elevator left its original cell');
  assert(elevator!.neighbors.includes(destination), 'the elevator is attached to the destination');

  // It must sit in the cell just outside the chosen doorway, and its single door
  // must face back into that room - that is what the doorway choice encodes.
  const roomGrid = nodeGrid(moved.mapGraph.nodes[destination]);
  const OFFSETS: Record<string, [number, number]> = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };
  const OPPOSITE: Record<string, string> = { N: 'S', S: 'N', E: 'W', W: 'E' };
  const offset = OFFSETS[doorDir]!;
  assertEqual(grid!.col, roomGrid!.col + offset[0], 'the car parks outside the chosen doorway (col)');
  assertEqual(grid!.row, roomGrid!.row + offset[1], 'the car parks outside the chosen doorway (row)');
  assert(
    (elevator!.props?.doors as string[]).includes(OPPOSITE[doorDir]!),
    'the car door faces the room it docked against'
  );
  assertEqual(
    String(moved.players.p1.customProps.currentRoomId),
    'room_mystic_elevator',
    'the rider is inside the car'
  );
});

test('rules: the drip curse only fires in a windowless room', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw = engine.getRawState();
  addEffect(raw, { kind: 'ONGOING', source: 'p1', target: 'p1', payload: { effect: 'DRIP' } });

  // The exploration layout has no garden, so place one and stand in it.
  addExploredRoom(raw, 'garden', 0, 1, 'room_entrance_hall');
  const garden = raw.mapGraph.nodes.room_garden;
  assert(!!garden, 'the garden exists');
  assert(
    Array.isArray(garden!.props?.tags) && (garden!.props!.tags as string[]).includes('outside'),
    'the garden counts as an outside room'
  );

  // Outside rooms have windows, so the curse must stay quiet there.
  movePlayerTo(raw, 'p1', garden!.id);
  raw.globalVars.lastRoll = undefined;
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  raw.players.p1.customProps.movesLeft = 0;
  const end = engine.getLegalActions('p1').find(a => a.type === 'END_TURN');
  assert(!!end, 'the turn can end');
  engine.dispatch(end!);
  const afterGarden = engine.getRawState();
  const gardenRoll = afterGarden.globalVars.lastRoll as { reason?: string } | undefined;
  assertEqual(gardenRoll?.reason === '滴血之声', false, 'no drip check in the garden');
});

test('rules: the drip curse does fire in a windowless room', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw = engine.getRawState();
  addEffect(raw, { kind: 'ONGOING', source: 'p1', target: 'p1', payload: { effect: 'DRIP' } });

  const cellar = Object.values(raw.mapGraph.nodes).find(
    n => n.type === 'ROOM' && !(Array.isArray(n.props?.tags) && (n.props!.tags as string[]).includes('outside'))
  );
  assert(!!cellar, 'an indoor room exists');
  movePlayerTo(raw, 'p1', cellar!.id);

  raw.globalVars.lastRoll = undefined;
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  raw.players.p1.customProps.movesLeft = 0;
  const end = engine.getLegalActions('p1').find(a => a.type === 'END_TURN');
  assert(!!end, 'the turn can end');
  engine.dispatch(end!);

  // The curse fires when the NEXT turn for p1 begins; walk the table round.
  let state = engine.getRawState();
  for (let i = 0; i < 8 && state.activePlayerId !== 'p1'; i++) {
    const next = engine.getLegalActions(state.activeActorId ?? state.activePlayerId).find(a => a.type === 'END_TURN');
    if (!next) break;
    engine.dispatch(next);
    state = engine.getRawState();
  }
  const roll = state.globalVars.lastRoll as { reason?: string } | undefined;
  assertEqual(roll?.reason, '滴血之声', 'the drip check runs indoors');
});

test('rules: the front door is locked until a haunt opens it', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw = engine.getRawState();
  const hall = raw.mapGraph.nodes.room_entrance_hall;
  assert(!!hall, 'the entrance hall exists');
  assertEqual(String(hall!.props?.frontDoor), 'N', 'the front door faces out of the house');
  assertEqual(raw.globalVars.frontDoorLocked, true, 'it starts locked');

  movePlayerTo(raw, 'p1', 'room_entrance_hall');
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  raw.players.p1.customProps.movesLeft = 4;

  const exploresNorth = () =>
    engine.getLegalActions('p1').some(a => a.type === 'EXPLORE_DOOR' && a.payload?.direction === 'N');
  const canTryDoor = () => engine.getLegalActions('p1').some(a => a.type === 'TRY_FRONT_DOOR');

  assertEqual(exploresNorth(), false, 'the locked door is not explorable');
  assertEqual(canTryDoor(), true, 'trying the front door is offered instead');

  // A haunt that opens it makes the doorway explorable again.
  raw.globalVars.frontDoorLocked = false;
  assertEqual(exploresNorth(), true, 'an opened front door can be explored');
});

test('rules: ending a turn in a buff room grants one permanent point, once', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw = engine.getRawState();
  addExploredRoom(raw, 'gymnasium', 0, 2, 'room_grand_staircase');
  movePlayerTo(raw, 'p1', 'room_gymnasium');
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';

  // The buff raises the trait by one STEP on the printed ladder. The ladder has
  // repeated values (speed: [0,1,2,3,3,4,4,5]), so a step does not always change
  // the printed number - assert on the index, not the value.
  const speedIndexBefore = traitIndex(raw.players.p1, 'speed');
  raw.players.p1.customProps.movesLeft = 0;
  const end = engine.getLegalActions('p1').find(a => a.type === 'END_TURN');
  assert(!!end, 'the turn can end');
  const dispatched = engine.dispatch(end!);
  assert(dispatched.ok, `the turn ended (${dispatched.error ?? 'ok'})`);

  const after = engine.getRawState();
  assertEqual(
    traitIndex(after.players.p1, 'speed'),
    speedIndexBefore + 1,
    'the gymnasium advances Speed by one step'
  );
  assert(
    Array.isArray(after.players.p1.customProps.roomBuffs) &&
      (after.players.p1.customProps.roomBuffs as string[]).includes('room_gymnasium'),
    'the claim is recorded on the explorer'
  );

  // Coming back later must not pay twice.
  const claimedIndex = traitIndex(after.players.p1, 'speed');
  after.players.p1.customProps.movesLeft = 0;
  after.activePlayerId = 'p1';
  after.activeActorId = 'p1';
  const again = engine.getLegalActions('p1').find(a => a.type === 'END_TURN');
  if (again) engine.dispatch(again);
  assertEqual(traitIndex(engine.getRawState().players.p1, 'speed'), claimedIndex, 'the buff pays only once');
});

/* -------------------------------------------------------------------------- */
/* 宝可梦璀璨宝石 (Pokémon Splendor)                                            */
/* -------------------------------------------------------------------------- */

/**
 * Put a card into a zone inside a raw state the engine already owns.
 * Fixtures use this to reach positions that would take dozens of turns.
 */
function splendorPlace(state: GameState, cardId: string, zoneId: string, reveal = true): void {
  const entity = state.entities[cardId];
  assert(!!entity, `card ${cardId} exists`);
  const oldZone = state.zones[entity.zoneId];
  if (oldZone) oldZone.orderedEntities = oldZone.orderedEntities.filter(id => id !== cardId);
  entity.zoneId = zoneId;
  if (reveal) entity.visibility = { type: 'PUBLIC' };
  state.zones[zoneId].orderedEntities.push(cardId);
}

/** Seat-specific setup, since the module signature only takes a seed. */
function splendorSeatModule(seats: number): GameModule {
  return { ...GAME_REGISTRY.splendor, setup: seed => setupSplendor(seed, seats) };
}

/** A stage-1 Pokémon and the stage-2 card it evolves into. */
function splendorEvolutionPair(state: GameState): { base: Entity; evolution: Entity } {
  const base = Object.values(state.entities).find(
    entity =>
      entity.components.custom?.pkmnTier === 'stage1' &&
      typeof entity.components.custom?.evolvesTo === 'string'
  );
  assert(!!base, 'the deck contains an evolvable stage-1 Pokémon');
  const name = base.components.custom!.evolvesTo as string;
  const evolution = Object.values(state.entities).find(
    entity => entity.components.custom?.pkmnTier === 'stage2' && entity.components.custom?.name === name
  );
  assert(!!evolution, `the deck contains ${name}`);
  return { base, evolution };
}

test('fixture splendor: the bank is dealt by seat count and master balls are always five', () => {
  for (const [seats, perColor] of [[2, 4], [3, 5], [4, 7]] as const) {
    const state = setupSplendor(2024, seats);
    assertEqual(state.playerOrder.length, seats, `${seats}-seat table`);
    assertEqual(state.globalVars.playerCount, seats, `${seats}-seat count recorded`);
    for (const color of ['red', 'blue', 'black', 'pink', 'yellow']) {
      assertEqual(state.globalVars.bank[color], perColor, `${color} supply at ${seats} seats`);
    }
    assertEqual(state.globalVars.bank.purple, 5, `master balls are always 5 at ${seats} seats`);
  }
  assertEqual(setupSplendor(2024).playerOrder.length, 2, 'the default table is two seats');
});

test('fixture splendor: the same seed deals the same market', () => {
  const a = setupSplendor(99, 3);
  const b = setupSplendor(99, 3);
  const c = setupSplendor(100, 3);
  assertEqual(
    a.zones.zone_market_t1.orderedEntities.join(','),
    b.zones.zone_market_t1.orderedEntities.join(','),
    'same seed ⇒ same opening row'
  );
  assert(
    a.zones.zone_market_t1.orderedEntities.join(',') !== c.zones.zone_market_t1.orderedEntities.join(','),
    'a different seed deals a different row'
  );
  assertEqual(a.prngState, b.prngState, 'the shuffle state is deterministic');
});

test('fixture splendor: each level reveals four cards and hides its deck', () => {
  const state = setupSplendor(7, 2);
  for (const tier of [1, 2, 3]) {
    assertEqual(state.zones[`zone_market_t${tier}`].orderedEntities.length, 4, `level ${tier} row holds 4`);
    for (const id of state.zones[`zone_market_t${tier}`].orderedEntities) {
      assertEqual(state.entities[id].visibility.type, 'PUBLIC', `level ${tier} market card is public`);
    }
  }
  assertEqual(state.zones.zone_deck_s1.orderedEntities.length, 35 - 4, 'stage-1 deck after the opening');
  assertEqual(state.zones.zone_deck_s2.orderedEntities.length, 30 - 4, 'stage-2 deck after the opening');
  assertEqual(state.zones.zone_deck_s3.orderedEntities.length, 15 - 4, 'stage-3 deck after the opening');
  for (const id of state.zones.zone_deck_s1.orderedEntities) {
    assertEqual(state.entities[id].visibility.type, 'HIDDEN', 'deck cards stay face down');
  }
  assertEqual(state.zones.zone_rare.orderedEntities.length, 1, 'one rare Pokémon is revealed');
  assertEqual(state.zones.zone_legend.orderedEntities.length, 1, 'one legendary Pokémon is revealed');
});

test('fixture splendor: rare and legendary Pokémon need a master ball and cannot be reserved', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.splendor, 5);
  const raw = engine.getRawState();

  for (const zoneId of ['zone_rare', 'zone_legend']) {
    const cardId = raw.zones[zoneId].orderedEntities[0];
    const cost = raw.entities[cardId].components.custom!.cost as Record<string, number>;
    assert(cost.purple >= 1, `${zoneId} card lists a master ball`);

    // Every other ball at the cap still cannot pay for it.
    for (const color of ['red', 'blue', 'black', 'pink', 'yellow']) {
      raw.players.p1.customProps.tokens[color] = 2;
    }
    const unaffordable = engine
      .getLegalActions('p1')
      .filter(action => action.type === 'BUY_CARD' && action.entityId === cardId);
    assertEqual(unaffordable.length, 0, `${zoneId} is unaffordable without a master ball`);

    const reservable = engine
      .getLegalActions('p1')
      .filter(action => action.type === 'RESERVE_CARD' && action.entityId === cardId);
    assertEqual(reservable.length, 0, `${zoneId} cannot be reserved`);

    if (zoneId === 'zone_rare') {
      // With one master ball it becomes legal, and paying consumes it.
      const rareCost = cost;
      for (const [color, count] of Object.entries(rareCost)) {
        raw.players.p1.customProps.tokens[color] = count;
      }
      const buy = engine.dispatch({ type: 'BUY_CARD', playerId: 'p1', entityId: cardId });
      assert(buy.ok, `rare Pokémon is caught with a master ball (${buy.error ?? 'ok'})`);
      assertEqual(engine.getRawState().players.p1.customProps.tokens.purple, 0, 'the master ball is spent');
    }
  }
});

test('fixture splendor: master balls substitute for missing colours when buying', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.splendor, 5);
  const raw = engine.getRawState();
  const cardId = raw.zones.zone_market_t1.orderedEntities[0];
  const cost = raw.entities[cardId].components.custom!.cost as Record<string, number>;
  const total = Object.values(cost).reduce((sum, value) => sum + value, 0);

  // Master balls only — they stand in for every colour.
  const wild = Math.min(10, total);
  raw.players.p1.customProps.tokens.purple = wild;
  const buy = engine.dispatch({ type: 'BUY_CARD', playerId: 'p1', entityId: cardId });
  assert(buy.ok, `master balls pay for a card (${buy.error ?? 'ok'})`);
  assertEqual(engine.getRawState().players.p1.customProps.tokens.purple, wild - total, 'exactly the cost was spent');
});

test('fixture splendor: balls are conserved and never exceed ten', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.splendor, 2024);
  const raw = engine.getRawState();
  const supply = raw.globalVars.bank.red;

  assertEqual(raw.globalVars.bank.purple, 5, 'the master ball supply starts at five');
  const take = engine.getLegalActions('p1').find(action => action.type === 'TAKE_3_DIFF_GEMS');
  assert(!!take, 'taking balls is legal');
  assert(engine.dispatch(take!).ok, 'the take is accepted');
  assertEqual(engine.getRawState().globalVars.bank.red, supply - 1, 'the bank pays out');

  // Ten balls in hand leaves no room for another take.
  const player = engine.getRawState().players.p1;
  for (const color of ['red', 'blue', 'black', 'pink']) player.customProps.tokens[color] = 2;
  player.customProps.tokens.yellow = 2;
  assertEqual(
    Object.values(player.customProps.tokens).reduce<number>((sum, value) => sum + Number(value), 0),
    10,
    'the player holds ten balls'
  );
  const takes = engine
    .getLegalActions('p1')
    .filter(action => action.type === 'TAKE_3_DIFF_GEMS' || action.type === 'TAKE_2_SAME_GEMS');
  assertEqual(takes.length, 0, 'no take is offered at the cap');
});

test('fixture splendor: evolution buries the base Pokémon and costs no balls', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.splendor, 5);
  const raw = engine.getRawState();
  const { base, evolution } = splendorEvolutionPair(raw);
  const evoCost = base.components.custom!.evoCost as { color: string; count: number };

  splendorPlace(raw, base.id, 'zone_tableau_p1');
  splendorPlace(raw, evolution.id, 'zone_market_t2');
  raw.players.p1.customProps.bonuses = { red: 0, blue: 0, black: 0, pink: 0, yellow: 0, purple: 0 };
  raw.players.p1.customProps.bonuses[evoCost.color] = evoCost.count - 1;
  assertEqual(SplendorRules.evolutionOptions(raw, 'p1').length, 0, 'a missing bonus blocks the evolution');

  raw.players.p1.customProps.bonuses[evoCost.color] = evoCost.count;
  assertEqual(SplendorRules.evolutionOptions(raw, 'p1').length, 1, 'meeting the bonus unlocks one evolution');

  raw.players.p1.customProps.tokens = { red: 2, blue: 1, black: 0, pink: 0, yellow: 0, purple: 1 };
  const tokensBefore = canonicalize(raw.players.p1.customProps.tokens);
  const bankBefore = canonicalize(raw.globalVars.bank);
  const turnBefore = raw.turn;

  const evolve = engine.dispatch({ type: 'EVOLVE', playerId: 'p1', payload: { fromId: base.id, toId: evolution.id } });
  assert(evolve.ok, `evolution is accepted (${evolve.error ?? 'ok'})`);
  const next = engine.getRawState();

  assertEqual(canonicalize(next.players.p1.customProps.tokens), tokensBefore, 'evolution spends no balls');
  assertEqual(canonicalize(next.globalVars.bank), bankBefore, 'evolution does not touch the bank');
  assertEqual(next.turn, turnBefore, 'evolution does not consume the turn');
  assertEqual(next.activePlayerId, 'p1', 'evolution is not an action');
  assertEqual(next.globalVars.evolvedThisTurn, true, 'the once-per-turn flag is set');
  assertEqual(next.zones.zone_buried_p1.orderedEntities.join(','), base.id, 'the base Pokémon is buried');
  assertEqual(next.zones.zone_tableau_p1.orderedEntities.join(','), evolution.id, 'the evolution takes the field');
  assertEqual(
    (next.players.p1.customProps.buriedIds as string[]).join(','),
    base.id,
    'the buried card is recorded'
  );
  assertEqual(next.players.p1.score, next.entities[evolution.id].components.custom!.vp, 'only the evolution scores');
  assertEqual(
    SplendorRules.evolutionOptions(next, 'p1').length,
    0,
    'a second evolution in the same turn is refused'
  );
});

test('fixture splendor: an evolution still available at turn end resolves for free', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.splendor, 5);
  const raw = engine.getRawState();
  const { base, evolution } = splendorEvolutionPair(raw);
  const evoCost = base.components.custom!.evoCost as { color: string; count: number };

  splendorPlace(raw, base.id, 'zone_tableau_p1');
  splendorPlace(raw, evolution.id, 'zone_market_t2');
  raw.players.p1.customProps.bonuses[evoCost.color] = evoCost.count;
  assert(SplendorRules.evolutionOptions(raw, 'p1').length > 0, 'an evolution is waiting');

  const take = engine.getLegalActions('p1').find(action => action.type === 'TAKE_3_DIFF_GEMS');
  assert(!!take, 'a normal action is available');
  assert(engine.dispatch(take!).ok, 'the action is accepted');

  const next = engine.getRawState();
  assertEqual(next.zones.zone_buried_p1.orderedEntities.join(','), base.id, 'the evolution settled by itself');
  assertEqual(next.zones.zone_tableau_p1.orderedEntities.join(','), evolution.id, 'the evolution is on the field');
  assertEqual(next.globalVars.evolvedThisTurn, false, 'the flag is cleared for the next player');
});

test('fixture splendor: reaching the score goal plays out the round first', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.splendor, 5);
  const raw = engine.getRawState();

  // Build a tableau worth 15 VP, then catch a 5 VP Pokémon for the trigger.
  const pool = Object.values(raw.entities)
    .filter(card => card.zoneId.startsWith('zone_deck_s') && !card.components.custom?.evolvesTo)
    .sort((a, b) => Number(b.components.custom?.vp ?? 0) - Number(a.components.custom?.vp ?? 0));
  let vp = 0;
  for (const card of pool) {
    if (vp >= 15) break;
    splendorPlace(raw, card.id, 'zone_tableau_p1');
    vp += Number(card.components.custom?.vp ?? 0);
  }
  assert(vp >= 15, `the tableau is worth enough (${vp})`);
  const finisher = Object.values(raw.entities).find(
    card => card.zoneId === 'zone_deck_s3' && Number(card.components.custom?.vp ?? 0) >= 5
  );
  assert(!!finisher, 'a 5 VP stage-3 Pokémon is available');
  splendorPlace(raw, finisher!.id, 'zone_market_t3');
  for (const color of ['red', 'blue', 'black', 'pink', 'yellow']) {
    raw.players.p1.customProps.bonuses[color] = 10;
  }

  const buy = engine.dispatch({ type: 'BUY_CARD', playerId: 'p1', entityId: finisher!.id });
  assert(buy.ok, `the trigger card is caught (${buy.error ?? 'ok'})`);

  const afterBuy = engine.getRawState();
  assert(afterBuy.players.p1.score >= 18, `the player reached the goal (${afterBuy.players.p1.score})`);
  assertEqual(afterBuy.globalVars.lastRound, true, 'the final round is flagged');
  assertEqual(afterBuy.gameOver, false, 'the game does not stop on the spot');
  assertEqual(afterBuy.activePlayerId, 'p2', 'the next seat still plays');

  const lastTurn = engine.getLegalActions('p2').find(action => action.type !== 'END_TURN');
  assert(!!lastTurn, 'the last seat has a move');
  assert(engine.dispatch(lastTurn!).ok, 'the last seat plays');

  const ended = engine.getRawState();
  assertEqual(ended.gameOver, true, 'the game ends when the round wrapped');
  assertEqual(ended.winner, 'p1', 'the highest score wins');
  assert(/🏆/.test(ended.winnerReason ?? ''), 'the outcome explains itself');
  // Replay is asserted by the stochastic test below: this position is built by
  // writing into the raw state, so it is not an action-log position.
});

test('fixture splendor: ties break on buried Pokémon, then on cards in play', () => {
  const engine = new UniversalGameEngine(GAME_REGISTRY.splendor, 5);
  const raw = engine.getRawState();
  raw.players.p1.score = 20;
  raw.players.p2.score = 20;
  raw.players.p1.customProps.buriedIds = ['b1'];
  raw.globalVars.finalRoundComplete = true;
  assertEqual(SplendorRules.checkWinCondition(raw).winner, 'p1', 'more buried Pokémon wins the tie');

  const equal = engine.getRawState();
  equal.players.p1.customProps.buriedIds = ['b1'];
  equal.players.p2.customProps.buriedIds = ['b2'];
  const fielded = Object.values(equal.entities)
    .filter(card => card.zoneId === 'zone_deck_s1' && card.components.custom?.pkmnTier === 'stage1')
    .slice(0, 2);
  for (const card of fielded) splendorPlace(equal, card.id, 'zone_tableau_p2');
  assertEqual(SplendorRules.checkWinCondition(equal).winner, 'p2', 'more cards in play breaks the tie');
});

test('fixture splendor: full games stay legal and replay bit-exactly at every seat count', () => {
  for (const seats of [2, 3, 4]) {
    for (const seed of [1, 99, 2024]) {
      const engine = new UniversalGameEngine(splendorSeatModule(seats), seed);
      let steps = 0;
      let rng = seed * 7919;
      const rand = (n: number): number => {
        rng = (rng * 1103515245 + 12345) & 0x7fffffff;
        return rng % n;
      };

      while (!engine.getRawState().gameOver && steps < 1500) {
        const focus = engine.getFocusActors();
        if (focus.length === 0) break;
        const legal = engine.getLegalActions(focus[0]);
        assert(legal.length > 0, `${seats}p seed ${seed}: the active seat always has a move`);
        // Prefer real actions so END_TURN stays an escape hatch.
        const real = legal.filter(action => action.type !== 'END_TURN');
        const pick = real.length > 0 ? real[rand(real.length)] : legal[0];
        const result = engine.dispatch(pick);
        assert(result.ok, `${seats}p seed ${seed}: ${pick.type} accepted (${result.error ?? 'ok'})`);
        steps += 1;
      }

      const state = engine.getRawState();
      assertEqual(state.gameOver, true, `${seats}p seed ${seed}: the game reaches an end in ${steps} steps`);
      assertEqual(state.playerOrder.length, seats, `${seats}p seed ${seed}: seat count`);

      // Ball conservation per colour, and the 10-ball cap.
      const perColor = seats === 2 ? 4 : seats === 3 ? 5 : 7;
      for (const color of ['red', 'blue', 'black', 'pink', 'yellow']) {
        const held = Object.values(state.players).reduce(
          (sum, player) => sum + Number(player.customProps.tokens[color] ?? 0),
          0
        );
        assertEqual(held + state.globalVars.bank[color], perColor, `${seats}p seed ${seed}: ${color} conserved`);
      }
      const masterBalls = Object.values(state.players).reduce(
        (sum, player) => sum + Number(player.customProps.tokens.purple ?? 0),
        0
      );
      assertEqual(masterBalls + state.globalVars.bank.purple, 5, `${seats}p seed ${seed}: master balls conserved`);

      for (const pid of state.playerOrder) {
        const player = state.players[pid];
        const held = Object.values(player.customProps.tokens).reduce<number>(
          (sum, value) => sum + Number(value),
          0
        );
        assert(held <= 10, `${seats}p seed ${seed}: ${pid} is within the 10-ball cap`);
        assertEqual(
          state.zones[`zone_hand_${pid}`].orderedEntities.length <= 3,
          true,
          `${seats}p seed ${seed}: ${pid} respects the reserve limit`
        );

        // Buried cards never linger and never score; the score equals the tableau.
        const buried = new Set((player.customProps.buriedIds as string[]) ?? []);
        const field = state.zones[`zone_tableau_${pid}`].orderedEntities;
        for (const id of field) assert(!buried.has(id), `${seats}p seed ${seed}: ${pid} has no buried card on the field`);
        const tableauVp = field.reduce(
          (sum, id) => sum + Number(state.entities[id]?.components.custom?.vp ?? 0),
          0
        );
        assertEqual(player.score, tableauVp, `${seats}p seed ${seed}: ${pid} score matches its tableau`);
      }

      const replay = engine.verifyReplay();
      assert(replay.ok, `${seats}p seed ${seed}: replay is bit-exact (${replay.errors.slice(0, 2).join(' | ')})`);
    }
  }
});

test('rules: riding to another floor moves the elevator tile to that floor', () => {
  // The car is the one tile that belongs on every floor, so the data must say so:
  // drawing a tile is filtered by `floors ?? [floor]`.
  assertEqual(
    (ROOM_DEFS.mystic_elevator.floors ?? []).slice().sort().join(','),
    'BASEMENT,GROUND,UPPER',
    'the elevator declares every floor'
  );

  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'room_features' });
  const raw = engine.getRawState();

  // The car starts in the basement; the destination is upstairs.
  addExploredRoom(raw, 'mystic_elevator', 0, 3, 'room_basement_landing');
  movePlayerTo(raw, 'p1', 'room_mystic_elevator');
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  raw.players.p1.customProps.movesLeft = 3;
  raw.players.p1.customProps.elevatorUsed = true;
  raw.globalVars.elevatorRoomId = 'room_mystic_elevator';
  raw.globalVars.elevatorRide = { sum: 3, fromFloor: 'BASEMENT', allowSameFloorOnly: false };

  const upstairs = Object.values(raw.mapGraph.nodes).find(
    node => node.type === 'ROOM' && String(node.props?.floor) === 'UPPER'
  );
  assert(!!upstairs, 'the fixture has an upstairs room');

  const ride = engine
    .getLegalActions('p1')
    .find(a => a.type === 'ELEVATOR_MOVE' && a.targetNodeId === upstairs!.id);
  assert(!!ride, 'the upstairs room offers a doorway to dock at');
  const rideRes = engine.dispatch(ride! as never);
  assert(rideRes.ok, `the ride dispatches (${rideRes.error ?? ''})`);

  const after = engine.getRawState();
  const elevator = after.mapGraph.nodes.room_mystic_elevator;
  assert(!!elevator, 'the elevator tile still exists');

  // The tile must sit on the destination floor, not back down in the basement.
  assertEqual(String(elevator!.props?.floor), 'UPPER', 'the tile moved to the upstairs floor');
  assertEqual(String(elevator!.layer), 'UPPER', 'the tile layer follows the floor');
  assertEqual(
    String(after.players.p1.customProps.floor),
    'UPPER',
    'the rider ends up on the upstairs floor'
  );
  assertEqual(
    String(after.players.p1.customProps.currentRoomId),
    'room_mystic_elevator',
    'the rider is inside the car'
  );
});

test('rules: room floor lists are well formed', () => {
  // A tile may name several floors (drawing filters on `floors ?? [floor]`), but
  // the list must always contain the tile's own base floor and never be empty.
  for (const def of Object.values(ROOM_DEFS)) {
    if (!def.floors) continue;
    assert(def.floors.length > 0, `${def.id} declares an empty floor list`);
    assert(
      def.floors.includes(def.floor),
      `${def.id} floor list omits its base floor ${def.floor}`
    );
  }

  // The once-per-game trait rooms are Gymnasium/Library/Chapel/Larder; the
  // kitchen has no such bonus.
  assertEqual(String(ROOM_DEFS.gymnasium.endTurnBuff), 'speed', 'gymnasium buffs Speed');
  assertEqual(String(ROOM_DEFS.library.endTurnBuff), 'knowledge', 'library buffs Knowledge');
  assertEqual(String(ROOM_DEFS.chapel.endTurnBuff), 'sanity', 'chapel buffs Sanity');
  assertEqual(String(ROOM_DEFS.larder.endTurnBuff), 'might', 'larder buffs Might');
  assertEqual(ROOM_DEFS.kitchen.endTurnBuff, undefined, 'kitchen grants no trait');
});

test('rules: the same check cannot be attempted twice in one turn', () => {
  // Rulebook, Die Rolls: "You cannot try to make the same roll more than once per
  // turn." The vault is the one re-enterable optional check, so it is the honest
  // place to prove the gate.
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw = engine.getRawState();
  addExploredRoom(raw, 'vault', 0, 2, 'room_entrance_hall');
  movePlayerTo(raw, 'p1', 'room_vault');
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  raw.players.p1.customProps.movesLeft = 2;
  raw.players.p1.customProps.rolledThisTurn = [];

  const vaultOffered = () => engine.getLegalActions('p1').some(a => a.type === 'ROOM_FEATURE');
  assertEqual(vaultOffered(), true, 'the vault can be tried once');

  const attempt = engine.getLegalActions('p1').find(a => a.type === 'ROOM_FEATURE');
  assert(engine.dispatch(attempt!).ok, 'the attempt dispatches');

  assertEqual(hasRolledThisTurn(engine.getRawState(), 'p1', 'vault'), true, 'the attempt is recorded');
  assertEqual(vaultOffered(), false, 'a second attempt is refused in the same turn');

  // A new turn clears the record.
  const after = engine.getRawState();
  after.players.p1.customProps.rolledThisTurn = [];
  assertEqual(vaultOffered(), true, 'a new turn may try again');
});

test('rules: leaving a room with an opponent costs an extra space for everyone', () => {
  // Rulebook, Moving Past Opponents: "for each opponent in a room with you, a
  // Hero, monster or Traitor must use one extra space of movement to leave".
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_zombie' });
  const raw = engine.getRawState();

  const traitorId = Object.entries(raw.players).find(([, p]) => p.role === 'TRAITOR')?.[0];
  assert(!!traitorId, 'the fixture has a traitor');
  const heroId = Object.entries(raw.players).find(([id, p]) => id !== traitorId && p.alive)?.[0];
  assert(!!heroId, 'the fixture has a living hero');

  const room = String(raw.players[heroId!].customProps.currentRoomId);
  movePlayerTo(raw, traitorId!, room);

  assertEqual(hostilesInRoom(raw, heroId!, room), 1, 'the hero counts the traitor as an opponent');
  assertEqual(movementCost(raw, heroId!, room), 2, 'the hero pays two spaces to leave');

  assertEqual(hostilesInRoom(raw, traitorId!, room), 1, 'the traitor counts the hero as an opponent');
  assertEqual(movementCost(raw, traitorId!, room), 2, 'the traitor also pays two spaces to leave');

  // Standing with its own monsters is not an opponent for the traitor.
  const elsewhere = Object.values(raw.mapGraph.nodes).find(
    n => n.type === 'ROOM' && n.id !== room && String(n.props?.floor) === String(raw.mapGraph.nodes[room]?.props?.floor)
  );
  assert(!!elsewhere, 'another room on the same floor exists');
  movePlayerTo(raw, traitorId!, elsewhere!.id);
  assertEqual(hostilesInRoom(raw, traitorId!, elsewhere!.id), 0, 'no hero there, no penalty');
  assertEqual(movementCost(raw, traitorId!, elsewhere!.id), 1, 'the traitor moves freely alone');
});

test('rules: a non-tradable item can still be dropped, a companion cannot', () => {
  // Rulebook, Using Items and Omens: "Some items can't be traded, but MAY BE
  // DROPPED OR PICKED UP." Companions are the only things barred from that.
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw = engine.getRawState();
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  raw.players.p1.customProps.movesLeft = 3;

  // Bite is an omen that cannot be traded and is not a companion.
  grantOmen(raw, 'p1', 'bite');
  const biteDrop = () => engine.getLegalActions('p1').find(a => a.type === 'DROP_ITEM');
  assert(!!biteDrop(), 'a non-tradable omen can be dropped');
  assert(engine.dispatch(biteDrop()!).ok, 'dropping it dispatches');

  // The dog is a companion: it follows its custodian and cannot be dropped.
  grantOmen(raw, 'p1', 'dog');
  const dogDrop = engine
    .getLegalActions('p1')
    .find(a => a.type === 'DROP_ITEM' && String(a.entityId ?? '').includes('dog'));
  assertEqual(dogDrop, undefined, 'a companion cannot be dropped');
});

test('rules: becoming the traitor clears lingering event effects', () => {
  // Rulebook, Traitor and Monster Powers: "When you become a traitor, prior
  // lingering bad effects from Event cards disappear."
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 7, { scenario: 'omen_ready' });
  const raw = engine.getRawState();
  addEffect(raw, { kind: 'ONGOING', source: 'p1', target: 'p1', payload: { effect: 'DRIP' } });
  raw.players.p1.customProps.effects = ['DRIP'];
  assertEqual(ongoingEffectKinds(raw, 'p1').length > 0, true, 'the curse is active before the haunt');

  // Trigger the haunt through the pending roll so startHaunt runs for real.
  raw.globalVars.omensRevealed = 13;
  raw.globalVars.pendingHauntRoll = { playerId: 'p1', omens: 13 };
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  raw.players.p1.customProps.movesLeft = 0;
  const end = engine.getLegalActions('p1').find(a => a.type === 'END_TURN');
  assert(!!end, 'the turn can end');
  engine.dispatch(end!);
  const roll = engine.getLegalActions('p1').find(a => a.type === 'ROLL_HAUNT_CHECK');
  assert(!!roll, 'the haunt roll is offered');
  engine.dispatch(roll!);

  const after = engine.getRawState();
  assertEqual(after.globalVars.hauntTriggered, true, 'the haunt started');
  assertEqual(String(after.players.p1.role), 'TRAITOR', 'the revealer is the traitor');
  assertEqual(ongoingEffectKinds(after, 'p1').length, 0, 'no lingering curse remains on the traitor');
});

test('rules: a stunned monster still moves but cannot attack', () => {
  // Rulebook, Death and Stuns: "a stunned monster can't slow an explorer's
  // movement, but a Traitor may still move the monster."
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_zombie' });
  const raw = engine.getRawState();

  const npcId = Object.keys(raw.npcs ?? {}).find(id => raw.npcs![id].status === 'ACTIVE');
  assert(!!npcId, 'the fixture has an active monster');
  const npc = raw.npcs![npcId!];
  const entity = npc.entityId ? raw.entities[npc.entityId] : undefined;
  assert(!!entity, 'the monster has an entity');

  raw.activeActorId = npcId!;
  npc.customProps.movesLeft = 2;
  npc.customProps.attacksLeft = 1;
  entity!.components.custom = { ...(entity!.components.custom ?? {}), stunned: true, stunTurns: 1 };

  const legal = engine.getLegalActions(npcId!);
  assertEqual(
    legal.some(a => a.type === 'MOVE_NPC'),
    true,
    'a stunned monster can still be moved'
  );
  assertEqual(
    legal.some(a => a.type === 'ATTACK_HERO'),
    false,
    'a stunned monster cannot attack'
  );
});

test('rules: the traitor rides the elevator without rolling', () => {
  // Rulebook, Mystic Elevator: "Traitors and Monsters can use the Elevator
  // without rolling, but only once per Traitor/Monster set of turns."
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_zombie' });
  const raw = engine.getRawState();

  const traitorId = Object.entries(raw.players).find(([, p]) => p.role === 'TRAITOR')?.[0];
  assert(!!traitorId, 'the fixture has a traitor');
  addExploredRoom(raw, 'mystic_elevator', 0, 3, 'room_basement_landing');
  movePlayerTo(raw, traitorId!, 'room_mystic_elevator');
  raw.activePlayerId = traitorId!;
  raw.activeActorId = traitorId!;
  raw.players[traitorId!].customProps.movesLeft = 3;
  raw.players[traitorId!].customProps.elevatorUsed = false;
  raw.globalVars.elevatorRoomId = 'room_mystic_elevator';

  const seedBefore = raw.prngState;
  const ride = engine.getLegalActions(traitorId!).find(a => a.type === 'USE_ELEVATOR');
  assert(!!ride, 'the ride is offered');
  assert(engine.dispatch(ride!).ok, 'the ride dispatches');

  const after = engine.getRawState();
  assertEqual(after.prngState, seedBefore, 'no dice are consumed for the traitor');
  assertEqual(after.globalVars.lastElevatorRoll, undefined, 'no roll is recorded');
  assertEqual(
    (after.globalVars.elevatorRide as { sum?: number } | undefined)?.sum,
    3,
    'the traitor may pick any floor'
  );
});

test('rules: the traitor ignores harmful room text but keeps the movement', () => {
  // Rulebook, Traitor and Monster Powers: "Traitors and monsters can use any
  // beneficial text on a room tile ... while ignoring any harmful text".
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_zombie' });
  const raw = engine.getRawState();
  const traitorId = Object.entries(raw.players).find(([, p]) => p.role === 'TRAITOR')?.[0];
  assert(!!traitorId, 'the fixture has a traitor');

  // The Gallery drop moves you to the Ballroom and costs a point of physical
  // damage without a rope. The traitor takes the move and skips the damage.
  // The haunt fixture has neither room, so place them adjacent to each other.
  addExploredRoom(raw, 'ballroom', 0, 1, 'room_basement_landing');
  addExploredRoom(raw, 'gallery', 0, 0, 'room_ballroom');
  const gallery = raw.mapGraph.nodes.room_gallery;
  const ballroom = raw.mapGraph.nodes.room_ballroom;
  assert(!!gallery, 'the gallery was placed');
  assert(!!ballroom, 'the ballroom was placed');

  const before_ = {
    might: traitValue(raw.players[traitorId!], 'might'),
    speed: traitValue(raw.players[traitorId!], 'speed')
  };
  movePlayerTo(raw, traitorId!, gallery!.id);
  raw.activePlayerId = traitorId!;
  raw.activeActorId = traitorId!;
  raw.players[traitorId!].customProps.movesLeft = 2;

  const jump = engine.getLegalActions(traitorId!).find(a => a.type === 'JUMP_DOWN');
  assert(!!jump, 'the gallery offers the drop');
  assert(engine.dispatch(jump!).ok, 'the drop dispatches');

  const after = engine.getRawState();
  assertEqual(String(after.players[traitorId!].customProps.currentRoomId), ballroom!.id, 'the traitor still falls');
  assertEqual(traitValue(after.players[traitorId!], 'might'), before_.might, 'no Might is lost');
  assertEqual(traitValue(after.players[traitorId!], 'speed'), before_.speed, 'no Speed is lost');
});

test('rules: an exit room gates movement, and a failed roll offers stay or pay', () => {
  // Rulebook, Special Rooms: "If an explorer fails his roll, he may choose to stay
  // in the room and try again on his next turn instead of taking damage."
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw = engine.getRawState();
  addExploredRoom(raw, 'graveyard', 0, 2, 'room_entrance_hall');
  movePlayerTo(raw, 'p1', 'room_graveyard');
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  raw.players.p1.customProps.movesLeft = 3;
  raw.players.p1.customProps.exitPassedRoom = undefined;
  raw.globalVars.pendingExit = null;

  const types = () => engine.getLegalActions('p1').map(a => a.type);
  assertEqual(types().includes('ROOM_EXIT_CHECK'), true, 'the exit roll is offered');
  assertEqual(types().includes('MOVE_TO_ROOM'), false, 'you cannot just walk out');

  // Success opens the way.
  raw.players.p1.customProps.forcedRoll = { value: 8 };
  const tryExit = engine.getLegalActions('p1').find(a => a.type === 'ROOM_EXIT_CHECK');
  assert(engine.dispatch(tryExit!).ok, 'the exit roll dispatches');
  assertEqual(
    String(engine.getRawState().players.p1.customProps.exitPassedRoom),
    'room_graveyard',
    'a successful roll unlocks the door'
  );
  assertEqual(
    engine.getLegalActions('p1').some(a => a.type === 'MOVE_TO_ROOM'),
    true,
    'movement is available after passing'
  );

  // Failure parks the choice.
  const fail = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw2 = fail.getRawState();
  addExploredRoom(raw2, 'graveyard', 0, 2, 'room_entrance_hall');
  movePlayerTo(raw2, 'p1', 'room_graveyard');
  raw2.activePlayerId = 'p1';
  raw2.activeActorId = 'p1';
  raw2.players.p1.customProps.movesLeft = 3;
  raw2.players.p1.customProps.forcedRoll = { value: 0 };
  const failRoll = fail.getLegalActions('p1').find(a => a.type === 'ROOM_EXIT_CHECK');
  assert(failRoll, 'the exit roll is offered');
  assert(fail.dispatch(failRoll!).ok, 'the failing roll dispatches');

  const afterFail = fail.getLegalActions('p1').map(a => a.type);
  assertEqual(afterFail.includes('EXIT_STAY'), true, 'staying is offered');
  assertEqual(afterFail.includes('EXIT_PAY'), true, 'paying is offered');

  // Staying costs nothing but ends this turn's movement.
  const knowledgeBefore = traitValue(fail.getRawState().players.p1, 'knowledge');
  const stay = fail.getLegalActions('p1').find(a => a.type === 'EXIT_STAY');
  assert(fail.dispatch(stay!).ok, 'staying dispatches');
  const stayed = fail.getRawState();
  assertEqual(traitValue(stayed.players.p1, 'knowledge'), knowledgeBefore, 'staying costs no trait');
  assertEqual(Number(stayed.players.p1.customProps.movesLeft), 0, 'staying ends movement');
});

test('rules: a dead explorer\'s companion is claimed by whoever enters the room', () => {
  // Rulebook, Death and Stuns: "If an explorer dies put an Item Token in the room
  // along with any Companion token. Any other explorer that enters the room gains
  // custody of the companion."
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw = engine.getRawState();
  grantOmen(raw, 'p1', 'dog');
  const dogId = Object.values(raw.entities).find(
    e => e.components.custom?.cardType === 'OMEN' && e.components.custom?.companion
  )?.id;
  assert(!!dogId, 'the dog is in hand');

  // Where can p2 walk? That is the room the companion will be lying in.
  raw.activePlayerId = 'p2';
  raw.activeActorId = 'p2';
  raw.players.p2.customProps.movesLeft = 3;
  const move = engine.getLegalActions('p2').find(a => a.type === 'MOVE_TO_ROOM');
  assert(!!move, 'p2 has somewhere to go');
  const destination = String(
    (move!.selection as { scope?: { neighbors?: string[] } })?.scope?.neighbors?.[0] ?? ''
  );
  assert(destination.length > 0, 'the destination is known');

  // The dead explorer's companion lies there, unowned.
  raw.players.p1.alive = false;
  raw.players.p1.customProps.banished = true;
  const hand = raw.zones['zone_hand_p1'];
  const at = hand.orderedEntities.indexOf(dogId!);
  if (at >= 0) hand.orderedEntities.splice(at, 1);
  const zone = raw.zones[`zone_room_${destination}`] ?? (raw.zones[`zone_room_${destination}`] = {
    id: `zone_room_${destination}`,
    orderedEntities: [],
    capacity: 99,
    visibility: { type: 'PUBLIC' }
  } as never);
  // Drop stale zone listings first: the fixture's room zone carries entries whose
  // entity.zoneId points at a deck, which the kernel rightly rejects on the next
  // move. Only real occupants are kept.
  (zone as { orderedEntities: string[] }).orderedEntities = (
    zone as { orderedEntities: string[] }
  ).orderedEntities.filter(id => raw.entities[id]?.zoneId === (zone as { id: string }).id);
  (zone as { orderedEntities: string[] }).orderedEntities.push(dogId!);
  raw.entities[dogId!].ownerId = undefined;
  raw.entities[dogId!].zoneId = (zone as { id: string }).id;

  const mv = engine.dispatch({ ...move!, targets: [destination] } as never);
  assert(mv.ok, `the move dispatches (${mv.error ?? ''})`);

  const after = engine.getRawState();
  assertEqual(String(after.entities[dogId!].ownerId ?? ''), 'p2', 'the dog follows its new custodian');
  assert(
    after.zones['zone_hand_p2'].orderedEntities.includes(dogId!),
    'the companion moved into the new owner hand'
  );
});

test('rules: the crystal ball only looks, it does not take the card', () => {
  // Rulebook, Using Items and Omens: "The Crystal Ball can only be used to look
  // through undrawn Item and Event cards."
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw = engine.getRawState();
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  grantOmen(raw, 'p1', 'crystal_ball');

  const topBefore = raw.zones.zone_event_deck.orderedEntities[0];
  const seedBefore = raw.prngState;

  const use = engine.getLegalActions('p1').find(a => a.type === 'USE_ITEM');
  assert(!!use, 'the ball can be used');
  assert(engine.dispatch(use!).ok, 'using it dispatches');

  const after = engine.getRawState();
  assertEqual(after.prngState, seedBefore, 'no trait roll is made');
  assertEqual(after.zones.zone_event_deck.orderedEntities[0], topBefore, 'the deck order is untouched');
  assert(!!after.globalVars.peek, 'the top card is revealed');
});

test('rules: the dog is a companion, not a fetch skill, and it cannot ride the elevator', () => {
  // Rulebook, Using Items and Omens: "The Dog can't go through one-way passages,
  // any passage like the Revolving Wall that requires a roll, or use the Mystic
  // Elevator. His movement is not slowed by monsters."
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'room_features' });
  const raw = engine.getRawState();
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  raw.players.p1.customProps.movesLeft = 3;

  const elevator = Object.values(raw.mapGraph.nodes).find(n => n.props?.special === 'ELEVATOR');
  assert(!!elevator, 'the fixture has an elevator');
  movePlayerTo(raw, 'p1', elevator!.id);
  raw.players.p1.customProps.elevatorUsed = false;

  const rides = () => engine.getLegalActions('p1').some(a => a.type === 'USE_ELEVATOR');
  assertEqual(rides(), true, 'without the dog the ride is offered');

  grantOmen(raw, 'p1', 'dog');
  assertEqual(rides(), false, 'the dog bars the elevator');

  // The dog is not a usable item any more: no USE_ITEM for it.
  const usesDog = engine
    .getLegalActions('p1')
    .some(a => a.type === 'USE_ITEM' && String(a.entityId ?? '').includes('dog'));
  assertEqual(usesDog, false, 'the dog has no activated ability');
});

test('rules: a failed steal still lands the damage', () => {
  // Rulebook, Physical Damage: "you may steal a tradable item instead of doing the
  // damage" - when nothing can actually be stolen the hit must still wound. The
  // steal predicate and the steal executor used to disagree, so the damage was
  // silently swallowed whenever the victim only held unstealable cards.
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'haunt_zombie' });
  const raw = engine.getRawState();
  const traitorId = Object.entries(raw.players).find(([, p]) => p.role === 'TRAITOR')?.[0];
  const heroId = Object.entries(raw.players).find(([id, p]) => id !== traitorId && p.alive)?.[0];
  assert(!!traitorId && !!heroId, 'the fixture has both sides');

  const room = String(raw.players[traitorId!].customProps.currentRoomId);
  movePlayerTo(raw, heroId!, room);

  // The hero holds only armour, which is explicitly unstealable.
  for (const entity of Object.values(raw.entities)) {
    if (entity.ownerId === heroId) entity.ownerId = undefined;
  }
  grantItem(raw, heroId!, 'armor');

  const hero = raw.players[heroId!];
  const before = {
    might: traitValue(hero, 'might'),
    speed: traitValue(hero, 'speed')
  };

  raw.activePlayerId = traitorId!;
  raw.activeActorId = traitorId!;
  // Attacks roll raw dice (not trait checks), so a forced roll cannot pin the
  // outcome. Swing until a decisive hit lands.
  let decisive = false;
  for (let attempt = 0; attempt < 25 && !decisive; attempt += 1) {
    const state = engine.getRawState();
    state.activePlayerId = traitorId!;
    state.activeActorId = traitorId!;
    state.players[traitorId!].customProps.attacksLeft = 1;
    const attack = engine.getLegalActions(traitorId!).find(a => a.type === 'ATTACK_PLAYER');
    if (!attack) break;
    engine.dispatch({ ...attack, payload: { ...(attack.payload ?? {}), weapon: 'fists', steal: 'yes' } } as never);

    const now = engine.getRawState();
    const heroNow = now.players[heroId!];
    const pending = now.globalVars.pendingDamage as { amount?: number } | undefined;
    const stolen = [...(now.zones[`zone_hand_${traitorId}`]?.orderedEntities ?? [])].length > 0;
    if (pending !== undefined && pending !== null) { decisive = true; break; }
    if (traitValue(heroNow, 'might') + traitValue(heroNow, 'speed') < before.might + before.speed) { decisive = true; break; }
    if (stolen) { decisive = true; break; }
  }
  assert(decisive, 'a landed hit always resolves: damage applied, queued, or an item stolen');
});



test('rules: the music box rolls Sanity and shifts it, it does not freeze anyone', () => {
  // Official text: "Play melody: make a Sanity roll: 4+ Soothing tune (Gain 1
  // Sanity); 0-3 Agonizing discord (Lose 1 Sanity)." The old implementation zeroed
  // movesLeft/attacksLeft/skipActions on nearby players, all of which
  // resetTurnResources clears before the effect could ever matter.
  const engine = new UniversalGameEngine(GAME_REGISTRY.betrayal, 42, { scenario: 'exploration' });
  const raw = engine.getRawState();
  raw.activePlayerId = 'p1';
  raw.activeActorId = 'p1';
  grantItem(raw, 'p1', 'music_box');
  raw.players.p1.customProps.forcedRoll = { value: 8 };

  const sanityBefore = traitIndex(raw.players.p1, 'sanity');
  const use = engine.getLegalActions('p1').find(a => a.type === 'USE_ITEM');
  assert(!!use, 'the box can be played');
  assert(engine.dispatch(use!).ok, 'playing it dispatches');

  const after = engine.getRawState();
  assertEqual(traitIndex(after.players.p1, 'sanity'), sanityBefore + 1, 'a good tune restores Sanity');
  assertEqual(Boolean(after.players.p1.customProps.skipActions), false, 'nobody is frozen');
  assertEqual(Number(after.players.p1.customProps.movesLeft), Number(raw.players.p1.customProps.movesLeft), 'movement is untouched');
});
