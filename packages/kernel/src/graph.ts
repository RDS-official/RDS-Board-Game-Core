import { EntityId, GameMapGraph, MapGraphEdge, MapGraphNode, NodeId } from './types';
/**
 * Universal Map Graph Topology G_map = (V, E_grid)
 * Implements hex dual graphs (Catan), dynamic multi-floor expansion graphs (Betrayal),
 * and circular seating distance graphs (Sanguosha).
 */

export class MapGraphManager {
  public static createEmptyGraph(): GameMapGraph {
    return {
      nodes: {},
      edges: {}
    };
  }

  public static addNode(
    graph: GameMapGraph,
    node: MapGraphNode
  ): GameMapGraph {
    return {
      ...graph,
      nodes: {
        ...graph.nodes,
        [node.id]: node
      }
    };
  }

  public static addEdge(
    graph: GameMapGraph,
    edge: MapGraphEdge
  ): GameMapGraph {
    const fromNode = graph.nodes[edge.from];
    const toNode = graph.nodes[edge.to];

    const updatedNodes = { ...graph.nodes };
    if (fromNode && !fromNode.neighbors.includes(edge.to)) {
      updatedNodes[edge.from] = {
        ...fromNode,
        neighbors: [...fromNode.neighbors, edge.to]
      };
    }
    if (!edge.directed && toNode && !toNode.neighbors.includes(edge.from)) {
      updatedNodes[edge.to] = {
        ...toNode,
        neighbors: [...toNode.neighbors, edge.from]
      };
    }

    return {
      ...graph,
      nodes: updatedNodes,
      edges: {
        ...graph.edges,
        [edge.id]: edge
      }
    };
  }

  public static setOccupant(
    graph: GameMapGraph,
    nodeOrEdgeId: string,
    occupantEntityId?: EntityId
  ): GameMapGraph {
    if (graph.nodes[nodeOrEdgeId]) {
      return {
        ...graph,
        nodes: {
          ...graph.nodes,
          [nodeOrEdgeId]: {
            ...graph.nodes[nodeOrEdgeId],
            occupantEntityId
          }
        }
      };
    }
    if (graph.edges[nodeOrEdgeId]) {
      return {
        ...graph,
        edges: {
          ...graph.edges,
          [nodeOrEdgeId]: {
            ...graph.edges[nodeOrEdgeId],
            occupantEntityId
          }
        }
      };
    }
    return graph;
  }

  /* ------------------------------------------------------------------ */
  /* Topology queries                                                     */
  /* ------------------------------------------------------------------ */

  /** Outgoing neighbors, respecting the declared adjacency authority. */
  public static neighborsOf(graph: GameMapGraph, nodeId: NodeId): NodeId[] {
    const node = graph.nodes[nodeId];
    if (!node) return [];
    const adjacency = graph.topology?.adjacency ?? 'both';
    if (adjacency === 'none') return [];
    if (adjacency === 'neighbors') return [...node.neighbors];

    const result = new Set<NodeId>(adjacency === 'edges' ? [] : node.neighbors);
    for (const edge of Object.values(graph.edges)) {
      if (edge.from === nodeId) result.add(edge.to);
      else if (!edge.directed && edge.to === nodeId) result.add(edge.from);
    }
    return [...result];
  }

  /** Adjacency list with edge weights (default 1). */
  public static adjacencyList(graph: GameMapGraph): Map<NodeId, { to: NodeId; cost: number }[]> {
    const list = new Map<NodeId, { to: NodeId; cost: number }[]>();
    for (const node of Object.values(graph.nodes)) list.set(node.id, []);
    const adjacency = graph.topology?.adjacency ?? 'both';

    if (adjacency === 'neighbors') {
      for (const node of Object.values(graph.nodes)) {
        const entries = list.get(node.id)!;
        for (const to of node.neighbors) {
          if (!entries.some(entry => entry.to === to)) entries.push({ to, cost: 1 });
        }
      }
      return list;
    }

    if (adjacency === 'both') {
      for (const node of Object.values(graph.nodes)) {
        const entries = list.get(node.id)!;
        for (const to of node.neighbors) {
          if (!entries.some(entry => entry.to === to)) entries.push({ to, cost: 1 });
        }
      }
    }

    // Edge costs override the unit-cost neighbor fallback when both exist.
    for (const edge of Object.values(graph.edges)) {
      const cost = Number.isFinite(edge.weight) && (edge.weight ?? 0) > 0 ? Number(edge.weight) : 1;
      const add = (from: NodeId, to: NodeId) => {
        const entries = list.get(from);
        if (!entries) return;
        const existing = entries.find(entry => entry.to === to);
        if (existing) existing.cost = cost;
        else entries.push({ to, cost });
      };
      add(edge.from, edge.to);
      if (!edge.directed) add(edge.to, edge.from);
    }
    return list;
  }

  /** Breadth-first distances (unit cost), respecting directed edges. */
  public static bfs(graph: GameMapGraph, from: NodeId): Map<NodeId, number> {
    const distances = new Map<NodeId, number>();
    if (!graph.nodes[from]) return distances;
    distances.set(from, 0);
    const queue: NodeId[] = [from];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const distance = distances.get(current)!;
      for (const to of this.neighborsOf(graph, current)) {
        if (distances.has(to)) continue;
        distances.set(to, distance + 1);
        queue.push(to);
      }
    }
    return distances;
  }

  /** Dijkstra shortest path; returns [] when unreachable. */
  public static shortestPath(graph: GameMapGraph, from: NodeId, to: NodeId): NodeId[] {
    if (!graph.nodes[from] || !graph.nodes[to]) return [];
    if (from === to) return [from];

    const adjacency = this.adjacencyList(graph);
    const distances = new Map<NodeId, number>([[from, 0]]);
    const previous = new Map<NodeId, NodeId>();
    const visited = new Set<NodeId>();

    while (visited.size < Object.keys(graph.nodes).length) {
      let current: NodeId | null = null;
      let best = Infinity;
      for (const [id, distance] of distances) {
        if (!visited.has(id) && distance < best) {
          best = distance;
          current = id;
        }
      }
      if (current === null) break;
      if (current === to) break;
      visited.add(current);
      for (const entry of adjacency.get(current) ?? []) {
        const next = best + entry.cost;
        if (next < (distances.get(entry.to) ?? Infinity)) {
          distances.set(entry.to, next);
          previous.set(entry.to, current);
        }
      }
    }

    if (!distances.has(to)) return [];
    const path: NodeId[] = [to];
    let cursor = to;
    while (cursor !== from) {
      const parent = previous.get(cursor);
      if (!parent) return [];
      path.unshift(parent);
      cursor = parent;
    }
    return path;
  }

  /** All nodes within `maxCost` (inclusive), using Dijkstra. */
  public static reachable(graph: GameMapGraph, from: NodeId, maxCost: number): Map<NodeId, number> {
    const adjacency = this.adjacencyList(graph);
    const distances = new Map<NodeId, number>([[from, 0]]);
    const queue: NodeId[] = [from];
    while (queue.length > 0) {
      queue.sort((a, b) => (distances.get(a) ?? 0) - (distances.get(b) ?? 0));
      const current = queue.shift()!;
      const currentCost = distances.get(current)!;
      for (const entry of adjacency.get(current) ?? []) {
        const next = currentCost + entry.cost;
        if (next > maxCost) continue;
        if (next < (distances.get(entry.to) ?? Infinity)) {
          distances.set(entry.to, next);
          queue.push(entry.to);
        }
      }
    }
    return distances;
  }

  /**
   * Validate the optional frame tree used by multi-board / nested layouts.
   * Frames are logical transforms; the kernel does not apply them.
   */
  public static validateFrames(graph: GameMapGraph): string[] {
    const errors: string[] = [];
    const frames = graph.frames ?? {};
    for (const [id, frame] of Object.entries(frames)) {
      if (frame.id !== id) errors.push(`frame key ${id} != frame.id ${frame.id}`);
      if (frame.parentId && !frames[frame.parentId]) {
        errors.push(`frame ${id} references missing parent ${frame.parentId}`);
      }
      const seen = new Set<string>([id]);
      let parentId = frame.parentId;
      while (parentId) {
        if (seen.has(parentId)) {
          errors.push(`frame ${id} has a parent cycle`);
          break;
        }
        seen.add(parentId);
        parentId = frames[parentId]?.parentId;
      }
    }
    for (const [id, node] of Object.entries(graph.nodes)) {
      if (node.frameId && !frames[node.frameId]) {
        errors.push(`node ${id} references missing frame ${node.frameId}`);
      }
    }
    return errors;
  }

  /**
   * Structural topology validation. Returns human-readable errors.
   * Adjacency mode decides whether node.neighbors and the edge table must agree.
   */
  /** Compare a module's declared capabilities with the actual graph metadata. */
  public static validateDeclaration(
    declared: GameMapGraph['topology'],
    actual: GameMapGraph['topology']
  ): string[] {
    if (!declared) return [];
    if (!actual) return ['module declares topologySpec but mapGraph.topology is missing'];
    const errors: string[] = [];
    if (declared.kind !== actual.kind) {
      errors.push(`topology kind ${actual.kind} != declared ${declared.kind}`);
    }
    if (declared.adjacency && declared.adjacency !== actual.adjacency) {
      errors.push(`topology adjacency ${actual.adjacency ?? 'undefined'} != declared ${declared.adjacency}`);
    }
    if (declared.directed !== undefined && declared.directed !== actual.directed) {
      errors.push(`topology directed ${actual.directed ?? 'undefined'} != declared ${declared.directed}`);
    }
    if (declared.geometry && declared.geometry !== actual.geometry) {
      errors.push(`topology geometry ${actual.geometry ?? 'undefined'} != declared ${declared.geometry}`);
    }
    if (declared.layers) {
      const declaredLayers = declared.layers.map(layer => `${layer.id}:${layer.index}`).join(',');
      const actualLayers = (actual.layers ?? []).map(layer => `${layer.id}:${layer.index}`).join(',');
      if (declaredLayers !== actualLayers) {
        errors.push(`topology layers [${actualLayers}] != declared [${declaredLayers}]`);
      }
    }
    return errors;
  }

  public static validateTopology(graph: GameMapGraph): string[] {
    const errors: string[] = [...this.validateFrames(graph)];
    const spec = graph.topology;
    // Without an explicit spec, only structural checks run; an implicit "both"
    // would reject seat rings that intentionally use neighbors without edges.
    const adjacency = spec?.adjacency ?? 'neighbors';
    const layers = new Set((spec?.layers ?? []).map(layer => layer.id));

    const seen = new Set<string>();
    for (const [id, edge] of Object.entries(graph.edges)) {
      if (edge.id !== id) errors.push(`edge key ${id} != edge.id ${edge.id}`);
      const from = graph.nodes[edge.from];
      const to = graph.nodes[edge.to];
      if (!from) errors.push(`edge ${id} references missing from ${edge.from}`);
      if (!to) errors.push(`edge ${id} references missing to ${edge.to}`);
      if (edge.weight !== undefined && (!Number.isFinite(edge.weight) || edge.weight <= 0)) {
        errors.push(`edge ${id} has invalid weight ${String(edge.weight)}`);
      }
      const key = edge.directed ? `${edge.from}->${edge.to}` : [edge.from, edge.to].sort().join('--');
      if (seen.has(key)) errors.push(`duplicate edge ${key}`);
      seen.add(key);
      if (spec?.directed === false && edge.directed) {
        errors.push(`edge ${id} is directed but topology.directed is false`);
      }

      const requireNeighborLists = adjacency === 'both' || adjacency === 'edges';
      if (requireNeighborLists && from) {
        if (!from.neighbors.includes(edge.to)) errors.push(`edge ${id}: ${edge.from}.neighbors is missing ${edge.to}`);
      }
      if (requireNeighborLists && !edge.directed && to) {
        if (!to.neighbors.includes(edge.from)) errors.push(`edge ${id}: ${edge.to}.neighbors is missing ${edge.from}`);
      }
    }

    for (const node of Object.values(graph.nodes)) {
      if (node.layer && layers.size > 0 && !layers.has(node.layer)) {
        errors.push(`node ${node.id} has unknown layer ${node.layer}`);
      }
      for (const neighbor of node.neighbors) {
        if (!graph.nodes[neighbor]) {
          errors.push(`node ${node.id} references missing neighbor ${neighbor}`);
          continue;
        }
        if (adjacency === 'edges' || adjacency === 'both') {
          const hasEdge = Object.values(graph.edges).some(
            edge =>
              (edge.from === node.id && edge.to === neighbor) ||
              (!edge.directed && edge.from === neighbor && edge.to === node.id)
          );
          if (!hasEdge) {
            errors.push(`node ${node.id} neighbor ${neighbor} has no edge (adjacency=${adjacency})`);
          }
        }
      }
    }
    return errors;
  }

  /** Helper: Generate a classic Catan 19-Hex Dual Graph
   * - 19 Hex Faces (axial or cartesian)
   * - 54 Vertices (Settlement spots)
   * - 72 Edges (Road paths)
   */
  public static generateCatanHexDualGraph(hexRadius: number = 2.4): GameMapGraph {
    const graph: GameMapGraph = { nodes: {}, edges: {} };

    // Hex axial coordinates (q, r) for standard 3-4-5-4-3 layout (radius 2)
    const hexCoords: { q: number; r: number; id: string }[] = [];
    let hexIndex = 0;
    for (let q = -2; q <= 2; q++) {
      const r1 = Math.max(-2, -q - 2);
      const r2 = Math.min(2, -q + 2);
      for (let r = r1; r <= r2; r++) {
        hexCoords.push({ q, r, id: `hex_${hexIndex++}` });
      }
    }

    // Convert axial (q, r) to 3D world position (X, Z on table plane, Y = 0)
    // Flat-topped or pointy-topped hexes: let's use pointy-topped
    const sqrt3 = Math.sqrt(3);
    const hexCenters: Record<string, [number, number, number]> = {};

    hexCoords.forEach(h => {
      const x = hexRadius * (sqrt3 * h.q + (sqrt3 / 2) * h.r);
      const z = hexRadius * (1.5 * h.r);
      hexCenters[h.id] = [x, 0.05, z];

      // Add hex node
      graph.nodes[h.id] = {
        id: h.id,
        type: 'HEX',
        position: [x, 0.05, z],
        neighbors: [],
        props: { q: h.q, r: h.r }
      };
    });

    // Helper: Spatial merge to robustly merge shared vertices across hexes without float roundoff errors
    const vertexList: { id: string; pos: [number, number, number]; hexIds: string[] }[] = [];
    const edgeMap = new Map<string, { id: string; from: string; to: string }>();

    let eCounter = 0;

    // For each hex, calculate its 6 vertex positions
    hexCoords.forEach(h => {
      const [cx, , cz] = hexCenters[h.id];
      const hexVertexIds: string[] = [];

      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 180) * (60 * i - 30);
        const vx = cx + hexRadius * Math.cos(angle);
        const vz = cz + hexRadius * Math.sin(angle);

        let vInfo = vertexList.find(v => Math.hypot(v.pos[0] - vx, v.pos[2] - vz) < 0.05);
        if (!vInfo) {
          const vId = `vert_${vertexList.length}`;
          vInfo = { id: vId, pos: [vx, 0.1, vz], hexIds: [h.id] };
          vertexList.push(vInfo);
        } else {
          if (!vInfo.hexIds.includes(h.id)) vInfo.hexIds.push(h.id);
        }
        hexVertexIds.push(vInfo.id);
      }

      // Add edges between consecutive vertices around this hex
      for (let i = 0; i < 6; i++) {
        const v1 = hexVertexIds[i];
        const v2 = hexVertexIds[(i + 1) % 6];
        const edgeKey = [v1, v2].sort().join('__');

        if (!edgeMap.has(edgeKey)) {
          const eId = `edge_${eCounter++}`;
          edgeMap.set(edgeKey, { id: eId, from: v1, to: v2 });
        }
      }
    });

    // Populate graph with vertices
    vertexList.forEach(v => {
      graph.nodes[v.id] = {
        id: v.id,
        type: 'VERTEX',
        position: v.pos,
        neighbors: [],
        props: { hexIds: v.hexIds }
      };
    });

    // Populate graph with edges
    edgeMap.forEach(e => {
      graph.edges[e.id] = {
        id: e.id,
        from: e.from,
        to: e.to,
        type: 'ROAD_SLOT',
        props: {}
      };

      // Connect neighbor lists
      const nodeA = graph.nodes[e.from];
      const nodeB = graph.nodes[e.to];
      if (nodeA && !nodeA.neighbors.includes(e.to)) nodeA.neighbors.push(e.to);
      if (nodeB && !nodeB.neighbors.includes(e.from)) nodeB.neighbors.push(e.from);
    });

    return graph;
  }

  /**
   * Helper: Circular Seating Distance for Sanguosha
   * d(i, j) = min(|i - j|, n - |i - j|) + offensiveHorse - defensiveHorse
   */
  public static calculateCircularDistance(
    seatIndexA: number,
    seatIndexB: number,
    totalPlayers: number,
    horseOffensiveModifier: number = 0,
    horseDefensiveModifier: number = 0
  ): number {
    const rawDiff = Math.abs(seatIndexA - seatIndexB);
    const naturalDistance = Math.min(rawDiff, totalPlayers - rawDiff);
    const effectiveDistance = naturalDistance + horseOffensiveModifier + horseDefensiveModifier;
    return Math.max(1, effectiveDistance);
  }
}
