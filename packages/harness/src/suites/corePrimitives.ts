/* -------------------------------------------------------------------------- */
/* suite:corePrimitives — moved verbatim from suite.ts */
/* -------------------------------------------------------------------------- */

import { RulePipeline } from '@rds/kernel/aop';
import { ECSManager } from '@rds/kernel/ecs';
import { MapGraphManager } from '@rds/kernel/graph';
import { OccupancyIndex } from '@rds/kernel/occupancy';
import { applyPlaceEntityAction, makePlaceEntityAction } from '@rds/kernel/placement';
import { UniversalGameEngine } from '@rds/kernel/engine';
import { DeterministicPRNG } from '@rds/kernel/prng';
import { RuleHookImpl, RuleRegistry } from '@rds/kernel/rules';
import { canonicalize, hashString } from '@rds/kernel/serialize';
import { InterruptStackManager } from '@rds/kernel/stack';
import { StackFrame } from '@rds/kernel/types';
import { GAME_REGISTRY } from '@rds/games/registry';
import { projectNodePosition } from '@rds/web/render/spatialProjection';
import { applyFrameTransform, computeAutoLayerOffsets, ProjectionRegistry } from '@rds/web/render/projectionPort';
import { buildCardGroups } from '@rds/web/render/cardGroups';
import { layoutLabels } from '@rds/web/render/labels/labelLayout';
import { test, assert, assertEqual } from '../testKit';
import { emptyState, withZone, selectionModule } from '../suiteHelpers';

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
