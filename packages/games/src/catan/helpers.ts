import { Entity, GameState, PlayerId } from '@rds/kernel/types';
import { CATAN_RESOURCES, CatanPort, CatanResource } from './setup';

export type ResourceBag = Record<CatanResource, number>;

export const COSTS: Record<string, Partial<ResourceBag>> = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { wheat: 2, ore: 3 },
  dev: { sheep: 1, wheat: 1, ore: 1 }
};

export function emptyBag(): ResourceBag {
  return { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
}

export function resourcesOf(player: { customProps: Record<string, unknown> } | undefined): ResourceBag {
  const raw = (player?.customProps?.resources ?? {}) as Partial<Record<CatanResource, number>>;
  return {
    wood: Number(raw.wood ?? 0),
    brick: Number(raw.brick ?? 0),
    sheep: Number(raw.sheep ?? 0),
    wheat: Number(raw.wheat ?? 0),
    ore: Number(raw.ore ?? 0)
  };
}

export function totalResources(player: { customProps: Record<string, unknown> }): number {
  const raw = (player.customProps.resources ?? {}) as Partial<Record<CatanResource, number>>;
  return CATAN_RESOURCES.reduce((sum, res) => sum + Number(raw[res] ?? 0), 0);
}

export function bankOf(state: GameState): ResourceBag {
  const raw = state.globalVars.bank ?? {};
  return {
    wood: Number(raw.wood ?? 0),
    brick: Number(raw.brick ?? 0),
    sheep: Number(raw.sheep ?? 0),
    wheat: Number(raw.wheat ?? 0),
    ore: Number(raw.ore ?? 0)
  };
}

export function setBank(state: GameState, bank: ResourceBag): void {
  state.globalVars.bank = bank;
}

/**
 * Add resources, limited by the finite bank. Returns how many were actually added.
 *
 * `ctx` 可选：传入时把这次获取记进收益流水（宪章 C-7）。加在两个资源总闸上，
 * 覆盖面最广 —— 掷骰产出、港口兑换、强盗抢夺都走这里。
 */
export function grantResources(
  state: GameState,
  pid: PlayerId,
  res: CatanResource,
  amount: number,
  ctx?: { reward: (actorId: string, kind: string, amount: number, reason: string) => void }
): number {
  if (amount <= 0) return 0;
  const player = state.players[pid];
  if (!player) return 0;
  const bank = bankOf(state);
  const available = Math.min(amount, bank[res]);
  if (available <= 0) return 0;

  const bag = resourcesOf(player);
  bag[res] += available;
  player.customProps = { ...player.customProps, resources: bag };
  bank[res] -= available;
  setBank(state, bank);
  ctx?.reward(pid, `resource:${res}`, available, `获得 ${available} ${res}（来源：掷骰/兑换/抢夺）`);
  return available;
}

export function canAfford(state: GameState, pid: PlayerId, cost: Partial<ResourceBag>): boolean {
  const bag = resourcesOf(state.players[pid]);
  return Object.entries(cost).every(([res, amount]) => bag[res as CatanResource] >= (amount ?? 0));
}

export function payCost(state: GameState, pid: PlayerId, cost: Partial<ResourceBag>): boolean {
  if (!canAfford(state, pid, cost)) return false;
  const player = state.players[pid];
  const bag = resourcesOf(player);
  const bank = bankOf(state);

  for (const [res, amount] of Object.entries(cost)) {
    const key = res as CatanResource;
    bag[key] -= amount ?? 0;
    bank[key] += amount ?? 0;
  }

  player.customProps = { ...player.customProps, resources: bag };
  setBank(state, bank);
  return true;
}

export function returnResources(state: GameState, pid: PlayerId, returned: Partial<ResourceBag>): void {
  const player = state.players[pid];
  if (!player) return;
  const bag = resourcesOf(player);
  const bank = bankOf(state);
  for (const [res, amount] of Object.entries(returned)) {
    const key = res as CatanResource;
    bag[key] += amount ?? 0;
    bank[key] += amount ?? 0;
  }
  player.customProps = { ...player.customProps, resources: bag };
  setBank(state, bank);
}

export function buildingsOf(state: GameState, pid: PlayerId, type?: 'SETTLEMENT' | 'CITY' | 'ROAD'): Entity[] {
  return Object.values(state.entities).filter(
    entity =>
      entity.ownerId === pid &&
      entity.type === 'BUILDING' &&
      entity.components.building &&
      (!type || entity.components.building.type === type)
  );
}

export function buildingAtVertex(state: GameState, nodeId: string): Entity | undefined {
  const occupant = state.mapGraph.nodes[nodeId]?.occupantEntityId;
  if (!occupant) return undefined;
  return state.entities[occupant];
}

export function distanceRuleOk(state: GameState, nodeId: string): boolean {
  const node = state.mapGraph.nodes[nodeId];
  if (!node || node.occupantEntityId) return false;
  return node.neighbors.every(neighborId => !state.mapGraph.nodes[neighborId]?.occupantEntityId);
}

export function vertexTouchesOwnRoad(state: GameState, pid: PlayerId, nodeId: string): boolean {
  return Object.values(state.mapGraph.edges).some(edge => {
    if (edge.from !== nodeId && edge.to !== nodeId) return false;
    if (!edge.occupantEntityId) return false;
    const road = state.entities[edge.occupantEntityId];
    return road?.ownerId === pid && road.components.building?.type === 'ROAD';
  });
}

export function edgeConnectsToPlayer(state: GameState, pid: PlayerId, edgeId: string): boolean {
  const edge = state.mapGraph.edges[edgeId];
  if (!edge) return false;
  for (const nodeId of [edge.from, edge.to]) {
    const building = buildingAtVertex(state, nodeId);
    if (building?.ownerId === pid) return true;
    if (vertexTouchesOwnRoad(state, pid, nodeId)) return true;
  }
  return false;
}

export function placeBuilding(
  state: GameState,
  pid: PlayerId,
  nodeId: string,
  type: 'SETTLEMENT' | 'CITY',
  entityId: string
): Entity {
  const node = state.mapGraph.nodes[nodeId];
  const player = state.players[pid];
  const entity: Entity = {
    id: entityId,
    type: 'BUILDING',
    zoneId: 'zone_board',
    ownerId: pid,
    visibility: { type: 'PUBLIC' },
    components: {
      building: { type, color: player.color },
      spatial: { x: node.position[0], y: 0.2, z: node.position[2], nodeId }
    }
  };

  state.entities[entityId] = entity;
  state.zones.zone_board.orderedEntities.push(entityId);
  node.occupantEntityId = entityId;
  return entity;
}

export function placeRoad(state: GameState, pid: PlayerId, edgeId: string, entityId: string): Entity {
  const edge = state.mapGraph.edges[edgeId];
  const from = state.mapGraph.nodes[edge.from];
  const to = state.mapGraph.nodes[edge.to];
  const player = state.players[pid];

  const entity: Entity = {
    id: entityId,
    type: 'BUILDING',
    zoneId: 'zone_board',
    ownerId: pid,
    visibility: { type: 'PUBLIC' },
    components: {
      building: { type: 'ROAD', color: player.color },
      spatial: {
        x: (from.position[0] + to.position[0]) / 2,
        y: 0.19,
        z: (from.position[2] + to.position[2]) / 2,
        nodeId: edgeId
      }
    }
  };

  state.entities[entityId] = entity;
  state.zones.zone_board.orderedEntities.push(entityId);
  edge.occupantEntityId = entityId;
  return entity;
}

export function playersAdjacentToHex(state: GameState, hexId: string): PlayerId[] {
  const owners = new Set<PlayerId>();
  for (const [nodeId, node] of Object.entries(state.mapGraph.nodes)) {
    if (node.type !== 'VERTEX') continue;
    if (!node.props?.hexIds?.includes(hexId)) continue;
    const building = buildingAtVertex(state, nodeId);
    if (building?.ownerId) owners.add(building.ownerId);
  }
  return [...owners];
}

/** Deterministic "discard half, largest stacks first" used by the 7-roll window. */
export function discardHalf(state: GameState, pid: PlayerId): ResourceBag {
  const player = state.players[pid];
  const bag = resourcesOf(player);
  const total = totalResources(player);
  let remaining = Math.floor(total / 2);
  const discarded = emptyBag();

  while (remaining > 0) {
    let best: CatanResource | null = null;
    for (const res of CATAN_RESOURCES) {
      if (bag[res] <= 0) continue;
      if (!best || bag[res] > bag[best]) best = res;
    }
    if (!best) break;
    bag[best] -= 1;
    discarded[best] += 1;
    remaining -= 1;
  }

  player.customProps = { ...player.customProps, resources: bag };
  const bank = bankOf(state);
  for (const res of CATAN_RESOURCES) bank[res] += discarded[res];
  setBank(state, bank);
  return discarded;
}

/**
 * Longest continuous road (edge trail, opponent buildings block traversal).
 * The board is small, so a bounded DFS from every own road endpoint is enough.
 */
export function longestRoadLength(state: GameState, pid: PlayerId): number {
  const roads = buildingsOf(state, pid, 'ROAD');

  const adjacency = new Map<string, { to: string; edgeId: string }[]>();
  for (const road of roads) {
    const edgeId = road.components.spatial?.nodeId;
    if (!edgeId) continue;
    const edge = state.mapGraph.edges[edgeId];
    if (!edge) continue;
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
    adjacency.get(edge.from)!.push({ to: edge.to, edgeId });
    adjacency.get(edge.to)!.push({ to: edge.from, edgeId });
  }

  const blocked = new Set<string>();
  for (const node of Object.values(state.mapGraph.nodes)) {
    if (node.type !== 'VERTEX' || !node.occupantEntityId) continue;
    const building = state.entities[node.occupantEntityId];
    if (building && building.ownerId !== pid && building.components.building?.type !== 'ROAD') {
      blocked.add(node.id);
    }
  }

  let best = 0;
  let visits = 0;
  const MAX_VISITS = 20000;

  const walk = (nodeId: string, used: Set<string>, length: number): void => {
    visits += 1;
    if (visits > MAX_VISITS) return;
    if (length > best) best = length;
    for (const step of adjacency.get(nodeId) ?? []) {
      if (used.has(step.edgeId) || blocked.has(step.to)) continue;
      used.add(step.edgeId);
      walk(step.to, used, length + 1);
      used.delete(step.edgeId);
    }
  };

  for (const start of adjacency.keys()) {
    walk(start, new Set(), 0);
    if (visits > MAX_VISITS) break;
  }

  return best;
}

export function updateLongestRoad(state: GameState): void {
  const lengths = new Map<PlayerId, number>();
  for (const pid of state.playerOrder) lengths.set(pid, longestRoadLength(state, pid));

  const eligible = [...lengths.entries()].filter(([, length]) => length >= 5);
  if (eligible.length === 0) {
    state.globalVars.longestRoadOwner = null;
    return;
  }

  const max = Math.max(...eligible.map(([, length]) => length));
  const current = state.globalVars.longestRoadOwner as string | null;
  if (current && (lengths.get(current) ?? 0) === max) return; // holder keeps ties

  const winner = eligible.find(([, length]) => length === max);
  state.globalVars.longestRoadOwner = winner ? winner[0] : null;
}

export function updateLargestArmy(state: GameState): void {
  const counts = state.playerOrder.map(pid => ({
    pid,
    knights: Number(state.players[pid]?.customProps.knightsPlayed ?? 0)
  }));

  const eligible = counts.filter(entry => entry.knights >= 3);
  if (eligible.length === 0) {
    state.globalVars.largestArmyOwner = null;
    return;
  }

  const max = Math.max(...eligible.map(entry => entry.knights));
  const current = state.globalVars.largestArmyOwner as string | null;
  const currentKnights = current ? Number(state.players[current]?.customProps.knightsPlayed ?? 0) : 0;
  if (current && currentKnights === max) return;

  state.globalVars.largestArmyOwner = eligible.find(entry => entry.knights === max)?.pid ?? null;
}

export function recomputeScores(state: GameState): void {
  const longestOwner = state.globalVars.longestRoadOwner as string | null;
  const armyOwner = state.globalVars.largestArmyOwner as string | null;

  for (const pid of state.playerOrder) {
    const player = state.players[pid];
    if (!player) continue;

    const settlements = buildingsOf(state, pid, 'SETTLEMENT').length;
    const cities = buildingsOf(state, pid, 'CITY').length;
    const vpCards = Object.values(state.entities).filter(
      entity =>
        entity.ownerId === pid &&
        entity.components.custom?.devType === 'vp' &&
        entity.zoneId === `zone_dev_${pid}`
    ).length;

    player.score =
      settlements +
      cities * 2 +
      vpCards +
      (longestOwner === pid ? 2 : 0) +
      (armyOwner === pid ? 2 : 0);
  }
}

export function normalize(state: GameState): void {
  updateLongestRoad(state);
  updateLargestArmy(state);
  recomputeScores(state);
}

export function portRatio(state: GameState, pid: PlayerId, give: CatanResource): number {
  let ratio = 4;
  const ports = (state.globalVars.ports ?? []) as CatanPort[];

  for (const port of ports) {
    const ownsAccess = port.vertices.some(vertexId => buildingAtVertex(state, vertexId)?.ownerId === pid);
    if (!ownsAccess) continue;
    if (port.type === '2:1' && port.resource === give) ratio = Math.min(ratio, 2);
    if (port.type === '3:1') ratio = Math.min(ratio, 3);
  }

  return ratio;
}

export function addDevCardToHand(state: GameState, pid: PlayerId, entityId: string, turn: number): boolean {
  const entity = state.entities[entityId];
  if (!entity) return false;

  const fromZoneId = entity.zoneId;
  const fromZone = state.zones[fromZoneId];
  if (fromZone) fromZone.orderedEntities = fromZone.orderedEntities.filter(id => id !== entityId);

  entity.zoneId = `zone_dev_${pid}`;
  entity.visibility = { type: 'OWNER_ONLY', ownerId: pid };
  entity.ownerId = pid;
  entity.components.custom = { ...(entity.components.custom ?? {}), boughtTurn: turn };

  const zone = state.zones[`zone_dev_${pid}`];
  if (zone) zone.orderedEntities.push(entityId);
  return true;
}

export function discardDevCard(state: GameState, entityId: string): void {
  const entity = state.entities[entityId];
  if (!entity) return;
  const zone = state.zones[entity.zoneId];
  if (zone) zone.orderedEntities = zone.orderedEntities.filter(id => id !== entityId);

  entity.zoneId = 'zone_dev_discard';
  entity.visibility = { type: 'PUBLIC' };
  state.zones.zone_dev_discard.orderedEntities.push(entityId);
}
