import { openDecision } from '@rds/kernel/decisions';
import { ReduceContext } from '@rds/kernel/module';
import { DeterministicPRNG } from '@rds/kernel/prng';
import { Action, DecisionWindow, GameState, PlayerId } from '@rds/kernel/types';
import { CATAN_RESOURCES, CatanResource } from './setup';
import {
  COSTS,
  addDevCardToHand,
  bankOf,
  buildingsOf,
  buildingAtVertex,
  canAfford,
  discardDevCard,
  discardHalf,
  distanceRuleOk,
  edgeConnectsToPlayer,
  grantResources,
  normalize,
  payCost,
  placeBuilding,
  placeRoad,
  playersAdjacentToHex,
  portRatio,
  resourcesOf,
  setBank,
  totalResources,
  vertexTouchesOwnRoad
} from './helpers';

const DEV_ACTION: Record<string, string> = {
  knight: 'PLAY_KNIGHT',
  road_building: 'PLAY_ROAD_BUILDING',
  year_of_plenty: 'PLAY_YEAR_OF_PLENTY',
  monopoly: 'PLAY_MONOPOLY'
};

const RESOURCE_LABELS: Record<CatanResource, string> = {
  wood: '木材',
  brick: '砖',
  sheep: '羊毛',
  wheat: '麦',
  ore: '矿'
};

const RESOURCE_OPTIONS = CATAN_RESOURCES.map(resource => ({
  value: resource,
  label: RESOURCE_LABELS[resource]
}));

export class CatanRules {
  public static getLegalActions(state: GameState, playerId: PlayerId): Action[] {
    if (state.gameOver) return [];

    const window = state.pendingDecisions.find(w => w.status === 'OPEN');
    if (window) {
      if (!window.participants.includes(playerId) || window.submissions[playerId] !== undefined) return [];
      if (window.payload?.kind === 'discard') return [{ type: 'DISCARD_HALF', playerId }];
      if (window.payload?.kind === 'trade') {
        const offer = state.globalVars.tradeOffer as {
          from: PlayerId;
          give: CatanResource;
          want: CatanResource;
        } | null;
        const canAccept =
          !!offer &&
          resourcesOf(state.players[playerId])[offer.want] >= 1 &&
          resourcesOf(state.players[offer.from])[offer.give] >= 1;
        return canAccept
          ? [
              { type: 'ACCEPT_TRADE', playerId },
              { type: 'REJECT_TRADE', playerId }
            ]
          : [{ type: 'REJECT_TRADE', playerId }];
      }
      return [];
    }

    if (state.activePlayerId !== playerId) return [];
    const actions: Action[] = [];

    switch (state.phase) {
      case 'SETUP_SETTLEMENT':
        for (const node of Object.values(state.mapGraph.nodes)) {
          if (node.type === 'VERTEX' && !node.occupantEntityId && distanceRuleOk(state, node.id)) {
            actions.push({ type: 'SETUP_SETTLEMENT', playerId, targetNodeId: node.id });
          }
        }
        break;

      case 'SETUP_ROAD': {
        const last = state.globalVars.setupLastVertex as string | null;
        if (!last) break;
        for (const edge of Object.values(state.mapGraph.edges)) {
          if (!edge.occupantEntityId && (edge.from === last || edge.to === last)) {
            actions.push({ type: 'SETUP_ROAD', playerId, targetEdgeId: edge.id });
          }
        }
        break;
      }

      case 'ROLL':
        actions.push({ type: 'ROLL_DICE', playerId });
        break;

      case 'ACTION':
        actions.push(...this.actionPhaseActions(state, playerId));
        break;

      case 'MOVE_ROBBER': {
        const current = state.globalVars.robberHexId as string;
        for (const node of Object.values(state.mapGraph.nodes)) {
          if (node.type === 'HEX' && node.id !== current) {
            actions.push({ type: 'MOVE_ROBBER', playerId, targetNodeId: node.id });
          }
        }
        break;
      }

      case 'STEAL': {
        const hexId = state.globalVars.robberHexId as string;
        for (const pid of playersAdjacentToHex(state, hexId)) {
          if (pid !== playerId && totalResources(state.players[pid]) > 0) {
            actions.push({ type: 'STEAL_FROM', playerId, targetPlayerId: pid });
          }
        }
        break;
      }

      case 'ROAD_BUILDING':
        for (const edge of Object.values(state.mapGraph.edges)) {
          if (!edge.occupantEntityId && edgeConnectsToPlayer(state, playerId, edge.id)) {
            actions.push({ type: 'BUILD_ROAD_FREE', playerId, targetEdgeId: edge.id });
          }
        }
        actions.push({ type: 'SKIP_ROAD_BUILDING', playerId });
        break;
    }

    return actions;
  }

  private static actionPhaseActions(state: GameState, playerId: PlayerId): Action[] {
    const actions: Action[] = [];
    const player = state.players[playerId];

    if (canAfford(state, playerId, COSTS.road)) {
      for (const edge of Object.values(state.mapGraph.edges)) {
        if (!edge.occupantEntityId && edgeConnectsToPlayer(state, playerId, edge.id)) {
          actions.push({ type: 'BUILD_ROAD', playerId, targetEdgeId: edge.id });
        }
      }
    }

    if (canAfford(state, playerId, COSTS.settlement)) {
      for (const node of Object.values(state.mapGraph.nodes)) {
        if (node.type !== 'VERTEX' || !distanceRuleOk(state, node.id)) continue;
        if (vertexTouchesOwnRoad(state, playerId, node.id)) {
          actions.push({ type: 'BUILD_SETTLEMENT', playerId, targetNodeId: node.id });
        }
      }
    }

    if (canAfford(state, playerId, COSTS.city)) {
      for (const settlement of buildingsOf(state, playerId, 'SETTLEMENT')) {
        const nodeId = settlement.components.spatial?.nodeId;
        if (nodeId) actions.push({ type: 'UPGRADE_CITY', playerId, targetNodeId: nodeId });
      }
    }

    const deck = state.zones.zone_dev_deck?.orderedEntities ?? [];
    if (deck.length > 0 && canAfford(state, playerId, COSTS.dev)) {
      actions.push({ type: 'BUY_DEV_CARD', playerId });
    }

    for (const entityId of state.zones[`zone_dev_${playerId}`]?.orderedEntities ?? []) {
      const card = state.entities[entityId];
      const devType = card?.components.custom?.devType as string | undefined;
      const boughtTurn = Number(card?.components.custom?.boughtTurn ?? 0);
      if (!devType || !DEV_ACTION[devType] || devType === 'vp') continue;
      if (boughtTurn >= state.turn) continue;

      const fields =
        devType === 'year_of_plenty'
          ? [
              { key: 'a', label: '第一项资源', kind: 'enum' as const, options: RESOURCE_OPTIONS, default: 'wood' },
              { key: 'b', label: '第二项资源', kind: 'enum' as const, options: RESOURCE_OPTIONS, default: 'brick' }
            ]
          : devType === 'monopoly'
          ? [
              {
                key: 'resource',
                label: '垄断资源',
                kind: 'enum' as const,
                options: RESOURCE_OPTIONS,
                default: 'wood'
              }
            ]
          : undefined;

      actions.push({ type: DEV_ACTION[devType], playerId, entityId, fields });
    }

    const bankTrade = this.bankTradeAction(state, playerId);
    if (bankTrade) actions.push(bankTrade);

    if (state.playerOrder.length > 1 && totalResources(player) > 0) {
      actions.push({
        type: 'PROPOSE_TRADE',
        playerId,
        fields: this.tradeFields(state, playerId)
      });
    }

    actions.push({ type: 'END_TURN', playerId });
    return actions;
  }

  private static bankTradeAction(state: GameState, playerId: PlayerId): Action | null {
    const bag = resourcesOf(state.players[playerId]);
    const bank = bankOf(state);
    const gives = CATAN_RESOURCES.filter(res => bag[res] >= portRatio(state, playerId, res));
    const wants = CATAN_RESOURCES.filter(res => bank[res] > 0);
    if (gives.length === 0 || wants.length === 0) return null;

    const giveOptions = RESOURCE_OPTIONS.filter(option => gives.includes(option.value as CatanResource));
    const wantOptions = RESOURCE_OPTIONS.filter(option => wants.includes(option.value as CatanResource));

    return {
      type: 'BANK_TRADE',
      playerId,
      fields: [
        {
          key: 'give',
          label: '支付资源',
          kind: 'enum',
          options: giveOptions,
          default: giveOptions[0]?.value
        },
        {
          key: 'want',
          label: '获得资源',
          kind: 'enum',
          options: wantOptions,
          default: wantOptions.find(option => option.value !== giveOptions[0]?.value)?.value
        }
      ]
    };
  }

  private static tradeFields(state: GameState, playerId: PlayerId): Action['fields'] {
    const bag = resourcesOf(state.players[playerId]);
    const owned = CATAN_RESOURCES.filter(res => bag[res] > 0);
    const giveOptions = RESOURCE_OPTIONS.filter(option => owned.includes(option.value as CatanResource));
    return [
      {
        key: 'give',
        label: '你付出',
        kind: 'enum',
        options: giveOptions,
        default: giveOptions[0]?.value
      },
      {
        key: 'want',
        label: '你想要',
        kind: 'enum',
        options: RESOURCE_OPTIONS,
        default: RESOURCE_OPTIONS.find(option => option.value !== giveOptions[0]?.value)?.value
      }
    ];
  }

  public static applyAction(state: GameState, action: Action, ctx: ReduceContext): GameState {
    const trace = ctx.trace;
    const s: GameState = JSON.parse(JSON.stringify(state));
    const pid = action.playerId;

    switch (action.type) {
      case 'SETUP_SETTLEMENT': {
        const nodeId = action.targetNodeId!;
        placeBuilding(s, pid, nodeId, 'SETTLEMENT', ctx.id('settlement'));
        s.globalVars.setupLastVertex = nodeId;
        s.phase = 'SETUP_ROAD';

        if (Number(s.globalVars.setupIndex ?? 0) >= s.playerOrder.length) {
          for (const hexId of s.mapGraph.nodes[nodeId]?.props?.hexIds ?? []) {
            const resource = s.mapGraph.nodes[hexId]?.props?.resource as CatanResource | 'desert';
            if (resource && resource !== 'desert') grantResources(s, pid, resource, 1);
          }
        }

        trace({ id: ctx.id('evt'), type: 'BUILD_OBJECT', title: `${s.players[pid].name} placed a starting settlement`, durationMs: 400 });
        break;
      }

      case 'SETUP_ROAD': {
        placeRoad(s, pid, action.targetEdgeId!, ctx.id('road'));
        const order = s.globalVars.setupOrder as string[];
        const index = Number(s.globalVars.setupIndex ?? 0) + 1;
        s.globalVars.setupIndex = index;
        s.globalVars.setupLastVertex = null;

        if (index >= order.length) {
          s.phase = 'ROLL';
          s.activePlayerId = order[0];
          s.turn = 1;
          s.round = 1;
          normalize(s);
        } else {
          s.activePlayerId = order[index];
          s.phase = 'SETUP_SETTLEMENT';
        }

        trace({ id: ctx.id('evt'), type: 'BUILD_OBJECT', title: `${s.players[pid].name} placed a starting road`, durationMs: 350 });
        break;
      }

      case 'ROLL_DICE': {
        const roll = DeterministicPRNG.rollDice(s.prngState, 2, 6);
        s.prngState = roll.nextSeed;
        s.globalVars.lastDiceRoll = roll.rolls;
        s.globalVars.diceSum = roll.sum;

        trace({
          id: ctx.id('evt'),
          type: 'DICE_ROLL',
          title: `${s.players[pid].name} rolled [${roll.rolls.join(', ')}] = ${roll.sum}`,
          payload: { rolls: roll.rolls, sum: roll.sum },
          durationMs: 800
        });

        if (roll.sum === 7) {
          const victims = s.playerOrder.filter(other => totalResources(s.players[other]) > 7);
          if (victims.length > 0) {
            const opened = openDecision(
              s,
              {
                kind: 'SIMULTANEOUS',
                title: 'Rolled 7 — discard half your resources',
                description: 'Every player with more than 7 resource cards discards half (rounded down).',
                participants: victims,
                secret: false,
                policy: { type: 'ALL_COMMITTED' },
                payload: { kind: 'discard' }
              },
              ctx.id('discard')
            );
            Object.assign(s, opened.state);
            s.phase = 'DISCARD';
          } else {
            s.phase = 'MOVE_ROBBER';
          }
        } else {
          this.produce(s, roll.sum, ctx);
          s.phase = 'ACTION';
        }
        break;
      }

      case 'DISCARD_HALF': {
        const discarded = discardHalf(s, pid);
        const summary = Object.entries(discarded)
          .filter(([, amount]) => amount > 0)
          .map(([res, amount]) => `${amount} ${res}`)
          .join(', ');
        trace({ id: ctx.id('evt'), type: 'CARD_DISCARD', title: `${s.players[pid].name} discarded ${summary || 'nothing'}`, durationMs: 400 });
        break;
      }

      case 'MOVE_ROBBER': {
        this.moveRobber(s, action.targetNodeId!, ctx);
        break;
      }

      case 'STEAL_FROM': {
        this.steal(s, pid, action.targetPlayerId!, ctx);
        s.phase = 'ACTION';
        break;
      }

      case 'BUILD_ROAD': {
        payCost(s, pid, COSTS.road);
        placeRoad(s, pid, action.targetEdgeId!, ctx.id('road'));
        normalize(s);
        trace({ id: ctx.id('evt'), type: 'BUILD_OBJECT', title: `${s.players[pid].name} built a road`, durationMs: 350 });
        break;
      }

      case 'BUILD_SETTLEMENT': {
        payCost(s, pid, COSTS.settlement);
        placeBuilding(s, pid, action.targetNodeId!, 'SETTLEMENT', ctx.id('settlement'));
        normalize(s);
        trace({ id: ctx.id('evt'), type: 'BUILD_OBJECT', title: `${s.players[pid].name} founded a settlement (+1 VP)`, durationMs: 450 });
        break;
      }

      case 'UPGRADE_CITY': {
        payCost(s, pid, COSTS.city);
        const building = buildingAtVertex(s, action.targetNodeId!);
        if (building && building.ownerId === pid && building.components.building?.type === 'SETTLEMENT') {
          building.components.building = { type: 'CITY', color: s.players[pid].color };
        }
        normalize(s);
        trace({ id: ctx.id('evt'), type: 'BUILD_OBJECT', title: `${s.players[pid].name} upgraded a settlement to a city (+1 VP)`, durationMs: 500 });
        break;
      }

      case 'BUY_DEV_CARD': {
        payCost(s, pid, COSTS.dev);
        const deck = s.zones.zone_dev_deck.orderedEntities;
        const cardId = deck[deck.length - 1];
        if (cardId) addDevCardToHand(s, pid, cardId, s.turn);
        normalize(s);
        trace({ id: ctx.id('evt'), type: 'CARD_DRAW', title: `${s.players[pid].name} bought a development card`, durationMs: 450 });
        break;
      }

      case 'PLAY_KNIGHT': {
        discardDevCard(s, action.entityId!);
        const player = s.players[pid];
        player.customProps = { ...player.customProps, knightsPlayed: Number(player.customProps.knightsPlayed ?? 0) + 1 };
        normalize(s);
        s.phase = 'MOVE_ROBBER';
        trace({ id: ctx.id('evt'), type: 'CARD_PLAY', title: `${player.name} played a Knight — move the robber`, durationMs: 500 });
        break;
      }

      case 'PLAY_ROAD_BUILDING': {
        discardDevCard(s, action.entityId!);
        s.globalVars.freeRoads = 2;
        s.phase = 'ROAD_BUILDING';
        trace({ id: ctx.id('evt'), type: 'CARD_PLAY', title: `${s.players[pid].name} played Road Building — two free roads`, durationMs: 500 });
        break;
      }

      case 'BUILD_ROAD_FREE': {
        placeRoad(s, pid, action.targetEdgeId!, ctx.id('road'));
        s.globalVars.freeRoads = Math.max(0, Number(s.globalVars.freeRoads ?? 0) - 1);
        normalize(s);
        if (Number(s.globalVars.freeRoads) === 0) s.phase = 'ACTION';
        trace({ id: ctx.id('evt'), type: 'BUILD_OBJECT', title: `${s.players[pid].name} placed a free road`, durationMs: 350 });
        break;
      }

      case 'SKIP_ROAD_BUILDING': {
        s.globalVars.freeRoads = 0;
        s.phase = 'ACTION';
        trace({ id: ctx.id('evt'), type: 'ANNOUNCEMENT', title: `${s.players[pid].name} placed no more roads`, durationMs: 250 });
        break;
      }

      case 'PLAY_YEAR_OF_PLENTY': {
        const card = s.entities[action.entityId!];
        const inHand = s.zones[`zone_dev_${pid}`]?.orderedEntities.includes(action.entityId!);
        if (!card || !inHand || card.components.custom?.devType !== 'year_of_plenty') break;

        const picks = [action.payload?.a, action.payload?.b].filter(
          (value): value is CatanResource => CATAN_RESOURCES.includes(value)
        );
        if (picks.length === 0) break;

        discardDevCard(s, action.entityId!);
        let gained = 0;
        for (const resource of picks) gained += grantResources(s, pid, resource, 1);
        trace({
          id: ctx.id('evt'),
          type: 'CARD_PLAY',
          title: `${s.players[pid].name} played Year of Plenty — gained ${gained} resources`,
          durationMs: 500
        });
        break;
      }

      case 'PLAY_MONOPOLY': {
        const card = s.entities[action.entityId!];
        const inHand = s.zones[`zone_dev_${pid}`]?.orderedEntities.includes(action.entityId!);
        if (!card || !inHand || card.components.custom?.devType !== 'monopoly') break;

        const resource = action.payload?.resource as CatanResource;
        if (!CATAN_RESOURCES.includes(resource)) break;

        discardDevCard(s, action.entityId!);
        let taken = 0;
        for (const other of s.playerOrder) {
          if (other === pid) continue;
          const bag = resourcesOf(s.players[other]);
          if (bag[resource] > 0) {
            taken += bag[resource];
            bag[resource] = 0;
            s.players[other].customProps = { ...s.players[other].customProps, resources: bag };
          }
        }
        if (taken > 0) {
          const bag = resourcesOf(s.players[pid]);
          bag[resource] += taken;
          s.players[pid].customProps = { ...s.players[pid].customProps, resources: bag };
        }
        trace({
          id: ctx.id('evt'),
          type: 'TOKEN_TRANSFER',
          title: `${s.players[pid].name} monopolised ${taken} ${resource}`,
          durationMs: 500
        });
        break;
      }

      case 'BANK_TRADE': {
        const give = action.payload?.give as CatanResource;
        const want = action.payload?.want as CatanResource;
        if (!CATAN_RESOURCES.includes(give) || !CATAN_RESOURCES.includes(want)) break;

        const ratio = portRatio(s, pid, give);
        const bag = resourcesOf(s.players[pid]);
        const bank = bankOf(s);
        if (bag[give] < ratio || bank[want] <= 0 || give === want) break;

        bag[give] -= ratio;
        bank[give] += ratio;
        bag[want] += 1;
        bank[want] -= 1;
        s.players[pid].customProps = { ...s.players[pid].customProps, resources: bag };
        setBank(s, bank);
        trace({
          id: ctx.id('evt'),
          type: 'TOKEN_TRANSFER',
          title: `${s.players[pid].name} traded ${ratio} ${give} for 1 ${want}`,
          durationMs: 350
        });
        break;
      }

      case 'PROPOSE_TRADE': {
        const give = action.payload?.give as CatanResource;
        const want = action.payload?.want as CatanResource;
        if (!CATAN_RESOURCES.includes(give) || !CATAN_RESOURCES.includes(want) || give === want) break;

        const bag = resourcesOf(s.players[pid]);
        if (bag[give] < 1) break;

        s.globalVars.tradeOffer = { from: pid, give, want };
        const others = s.playerOrder.filter(other => other !== pid);
        const opened = openDecision(
          s,
          {
            kind: 'VOTE',
            title: `${s.players[pid].name} proposes 1 ${give} → 1 ${want}`,
            description: 'First acceptance in seat order executes; later responses are ignored.',
            participants: others,
            secret: false,
            policy: { type: 'FIRST_ACCEPT', acceptTypes: ['ACCEPT_TRADE'] },
            payload: { kind: 'trade' }
          },
          ctx.id('trade')
        );
        Object.assign(s, opened.state);
        s.phase = 'TRADE_PENDING';
        trace({
          id: ctx.id('evt'),
          type: 'ANNOUNCEMENT',
          title: `${s.players[pid].name} offers 1 ${give} for 1 ${want}`,
          durationMs: 400
        });
        break;
      }

      case 'ACCEPT_TRADE': {
        const offer = s.globalVars.tradeOffer as { from: string; give: string; want: string } | null;
        if (!offer) break;
        const proposer = resourcesOf(s.players[offer.from]);
        const accepter = resourcesOf(s.players[pid]);
        const give = offer.give as CatanResource;
        const want = offer.want as CatanResource;
        if (proposer[give] < 1 || accepter[want] < 1) break;

        proposer[give] -= 1;
        proposer[want] += 1;
        accepter[want] -= 1;
        accepter[give] += 1;
        s.players[offer.from].customProps = { ...s.players[offer.from].customProps, resources: proposer };
        s.players[pid].customProps = { ...s.players[pid].customProps, resources: accepter };
        s.globalVars.tradeOffer = null;
        trace({ id: ctx.id('evt'), type: 'TOKEN_TRANSFER', title: `${s.players[pid].name} accepted: 1 ${give} ⇄ 1 ${want}`, durationMs: 450 });
        break;
      }

      case 'REJECT_TRADE': {
        trace({ id: ctx.id('evt'), type: 'ANNOUNCEMENT', title: `${s.players[pid].name} rejected the trade`, durationMs: 250 });
        break;
      }

      case 'END_TURN': {
        const index = s.playerOrder.indexOf(pid);
        const next = (index + 1) % s.playerOrder.length;
        s.activePlayerId = s.playerOrder[next];
        s.phase = 'ROLL';
        s.turn += 1;
        if (next === 0) s.round += 1;
        trace({ id: ctx.id('evt'), type: 'ANNOUNCEMENT', title: `${s.players[s.activePlayerId].name}'s turn`, durationMs: 250 });
        break;
      }
    }

    return s;
  }

  public static onDecisionResolved(state: GameState, window: DecisionWindow): GameState {
    const s: GameState = JSON.parse(JSON.stringify(state));
    if (window.payload?.kind === 'discard' && s.phase === 'DISCARD') s.phase = 'MOVE_ROBBER';
    if (window.payload?.kind === 'trade' && s.phase === 'TRADE_PENDING') {
      s.globalVars.tradeOffer = null;
      s.phase = 'ACTION';
    }
    return s;
  }

  private static produce(state: GameState, sum: number, ctx: ReduceContext): void {
    const hexes = Object.values(state.mapGraph.nodes).filter(
      node => node.type === 'HEX' && node.props.diceNumber === sum && !node.props.hasRobber
    );

    for (const hex of hexes) {
      const resource = hex.props.resource as CatanResource | 'desert';
      if (!resource || resource === 'desert') continue;

      for (const node of Object.values(state.mapGraph.nodes)) {
        if (node.type !== 'VERTEX' || !node.props?.hexIds?.includes(hex.id) || !node.occupantEntityId) continue;
        const building = state.entities[node.occupantEntityId];
        if (!building?.ownerId) continue;
        const type = building.components.building?.type;
        if (type !== 'SETTLEMENT' && type !== 'CITY') continue;

        const granted = grantResources(state, building.ownerId, resource, type === 'CITY' ? 2 : 1);
        if (granted > 0) {
          ctx.trace({
            id: ctx.id('evt'),
            type: 'TOKEN_TRANSFER',
            title: `${state.players[building.ownerId].name} +${granted} ${resource}`,
            durationMs: 300
          });
        }
      }
    }
  }

  private static moveRobber(state: GameState, hexId: string, ctx: ReduceContext): void {
    const previous = state.globalVars.robberHexId as string;
    if (previous && state.mapGraph.nodes[previous]) state.mapGraph.nodes[previous].props.hasRobber = false;
    if (state.mapGraph.nodes[hexId]) state.mapGraph.nodes[hexId].props.hasRobber = true;
    state.globalVars.robberHexId = hexId;

    const targets = playersAdjacentToHex(state, hexId).filter(
      pid => pid !== state.activePlayerId && totalResources(state.players[pid]) > 0
    );
    state.phase = targets.length > 0 ? 'STEAL' : 'ACTION';
    ctx.trace({ id: ctx.id('evt'), type: 'MOVE_OBJECT', title: `${state.players[state.activePlayerId].name} moved the robber`, durationMs: 450 });
  }

  private static steal(state: GameState, thiefId: PlayerId, victimId: PlayerId, ctx: ReduceContext): void {
    const victim = state.players[victimId];
    const bag = resourcesOf(victim);
    const pool: CatanResource[] = [];
    for (const res of CATAN_RESOURCES) for (let i = 0; i < bag[res]; i++) pool.push(res);
    if (pool.length === 0) return;

    const roll = DeterministicPRNG.nextInt(state.prngState, 0, pool.length - 1);
    state.prngState = roll.nextSeed;
    const stolen = pool[roll.value];

    bag[stolen] -= 1;
    victim.customProps = { ...victim.customProps, resources: bag };
    const thiefBag = resourcesOf(state.players[thiefId]);
    thiefBag[stolen] += 1;
    state.players[thiefId].customProps = { ...state.players[thiefId].customProps, resources: thiefBag };

    ctx.trace({ id: ctx.id('evt'), type: 'TOKEN_TRANSFER', title: `${state.players[thiefId].name} stole 1 ${stolen} from ${victim.name}`, durationMs: 450 });
  }

  public static checkWinCondition(state: GameState): { gameOver: boolean; winner: PlayerId | null } {
    for (const player of Object.values(state.players)) {
      if (player.score >= 10) return { gameOver: true, winner: player.id };
    }
    return { gameOver: false, winner: null };
  }
}
