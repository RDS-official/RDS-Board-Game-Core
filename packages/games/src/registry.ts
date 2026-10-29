import { defineGame, GameModule } from '@rds/kernel/module';
import { GameOutcome } from '@rds/kernel/types';
import { BETRAYAL_HOOKS } from './betrayal/hooks';
import { BetrayalRules } from './betrayal/rules';
import { BETRAYAL_SCENARIOS } from './betrayal/scenarios';
import { BETRAYAL_SPATIAL } from './betrayal/spatial';
import { setupBetrayal } from './betrayal/setup';
import { CatanRules } from './catan/rules';
import { setupCatan } from './catan/setup';
import { CATAN_SCENARIOS } from './catan/scenarios';
import { DuneMahjongRules } from './dune_mahjong/rules';
import { setupDuneMahjong } from './dune_mahjong/setup';
import { SANGUOSHA_HOOKS } from './sanguosha/hooks';
import { SanguoshaRules } from './sanguosha/rules';
import { setupSanguosha } from './sanguosha/setup';
import { SplendorRules } from './splendor/rules';
import { setupSplendor } from './splendor/setup';

/**
 * Game fixtures for kernel conformance testing.
 * Each module only supplies data + pure reducers; scheduling, hidden
 * information, interrupts, meta-rules and replay are kernel responsibilities.
 */

function toOutcome(result: {
  gameOver: boolean;
  winner: string | string[] | null;
  reason?: string;
}): GameOutcome {
  return {
    gameOver: result.gameOver,
    winner: result.winner,
    reason: result.gameOver ? result.reason ?? 'Victory condition met' : undefined
  };
}

export const catanModule: GameModule = defineGame({
  meta: {
    id: 'catan',
    name: '卡坦岛 (Catan)',
    description: '六边形对偶平面图、港口经济、发展卡与 10 分胜利',
    version: '1.0.0',
    capabilities: {
      simultaneousMoves: true,
      hiddenInformation: true,
      interruptStack: false,
      dynamicRules: false,
      topology: 'hex-dual',
      topologySpec: {
        kind: 'hex',
        adjacency: 'both',
        geometry: 'hex',
        geometrySpec: { cellSize: 2.15, hexOrientation: 'pointy' }
      },
    }
  },
  hooks: [],
  actionSchemas: {
    ROLL_DICE: { type: 'ROLL_DICE', allowPayload: false },
    SETUP_SETTLEMENT: { type: 'SETUP_SETTLEMENT', fields: { targetNodeId: { kind: 'string', required: true } } },
    SETUP_ROAD: { type: 'SETUP_ROAD', fields: { targetEdgeId: { kind: 'string', required: true } } },
    BUILD_ROAD: { type: 'BUILD_ROAD', fields: { targetEdgeId: { kind: 'string', required: true } } },
    BUILD_SETTLEMENT: { type: 'BUILD_SETTLEMENT', fields: { targetNodeId: { kind: 'string', required: true } } },
    UPGRADE_CITY: { type: 'UPGRADE_CITY', fields: { targetNodeId: { kind: 'string', required: true } } },
    BUILD_ROAD_FREE: { type: 'BUILD_ROAD_FREE', fields: { targetEdgeId: { kind: 'string', required: true } } },
    BUY_DEV_CARD: { type: 'BUY_DEV_CARD', allowPayload: false },
    PLAY_KNIGHT: { type: 'PLAY_KNIGHT', fields: { entityId: { kind: 'string', required: true } } },
    PLAY_ROAD_BUILDING: { type: 'PLAY_ROAD_BUILDING', fields: { entityId: { kind: 'string', required: true } } },
    PLAY_YEAR_OF_PLENTY: {
      type: 'PLAY_YEAR_OF_PLENTY',
      fields: { entityId: { kind: 'string', required: true } },
      payload: {
        a: { kind: 'string', required: true, enum: ['wood', 'brick', 'sheep', 'wheat', 'ore'] },
        b: { kind: 'string', required: true, enum: ['wood', 'brick', 'sheep', 'wheat', 'ore'] }
      }
    },
    PLAY_MONOPOLY: {
      type: 'PLAY_MONOPOLY',
      fields: { entityId: { kind: 'string', required: true } },
      payload: { resource: { kind: 'string', required: true, enum: ['wood', 'brick', 'sheep', 'wheat', 'ore'] } }
    },
    SKIP_ROAD_BUILDING: { type: 'SKIP_ROAD_BUILDING', allowPayload: false },
    MOVE_ROBBER: { type: 'MOVE_ROBBER', fields: { targetNodeId: { kind: 'string', required: true } } },
    STEAL_FROM: { type: 'STEAL_FROM', fields: { targetPlayerId: { kind: 'string', required: true } } },
    BANK_TRADE: {
      type: 'BANK_TRADE',
      payload: {
        give: { kind: 'string', required: true, enum: ['wood', 'brick', 'sheep', 'wheat', 'ore'] },
        want: { kind: 'string', required: true, enum: ['wood', 'brick', 'sheep', 'wheat', 'ore'] }
      }
    },
    PROPOSE_TRADE: {
      type: 'PROPOSE_TRADE',
      payload: {
        give: { kind: 'string', required: true, enum: ['wood', 'brick', 'sheep', 'wheat', 'ore'] },
        want: { kind: 'string', required: true, enum: ['wood', 'brick', 'sheep', 'wheat', 'ore'] }
      }
    },
    DISCARD_HALF: { type: 'DISCARD_HALF', allowPayload: false },
    ACCEPT_TRADE: { type: 'ACCEPT_TRADE', allowPayload: false },
    REJECT_TRADE: { type: 'REJECT_TRADE', allowPayload: false },
    END_TURN: { type: 'END_TURN', allowPayload: false }
  },
  setup: seed => setupCatan(seed),
  scenarios: CATAN_SCENARIOS,
  project: {
    player: (player, viewer, state) => {
      if (viewer === 'GOD' || player.id === viewer || state.gameOver) return player;
      const hiddenVp = Object.values(state.entities).filter(
        entity =>
          entity.ownerId === player.id &&
          entity.components.custom?.devType === 'vp' &&
          entity.zoneId === `zone_dev_${player.id}`
      ).length;
      return hiddenVp > 0 ? { ...player, score: Math.max(0, player.score - hiddenVp) } : player;
    }
  },
  legalActions: (state, playerId) => CatanRules.getLegalActions(state, playerId),
  reduce: (state, action, ctx) => CatanRules.applyAction(state, action, ctx),
  onDecisionResolved: (state, window) => CatanRules.onDecisionResolved(state, window),
  outcome: state => toOutcome(CatanRules.checkWinCondition(state))
});

export const sanguoshaModule: GameModule = defineGame({
  meta: {
    id: 'sanguosha',
    name: '三国杀 (Sanguosha)',
    description: '递归中断栈、身份暗置、装备/技能规则切面',
    version: '1.0.0',
    capabilities: {
      simultaneousMoves: false,
      hiddenInformation: true,
      interruptStack: true,
      dynamicRules: true,
      topology: 'ring',
      topologySpec: { kind: 'ring', adjacency: 'neighbors', geometry: 'ring' },
    }
  },
  hooks: SANGUOSHA_HOOKS,
  project: {
    player: (player, viewer, state) => {
      if (viewer === 'GOD' || player.id === viewer) return player;
      if (player.role === 'LORD') return player; // the Lord is public knowledge
      return { ...player, role: undefined, secretRole: undefined };
    }
  },
  actionSchemas: {
    PLAY_STRIKE: {
      type: 'PLAY_STRIKE',
      fields: { entityId: { kind: 'string', required: true }, targetPlayerId: { kind: 'string', required: true } }
    },
    PLAY_DODGE: { type: 'PLAY_DODGE', fields: { entityId: { kind: 'string', required: true } } },
    PLAY_PEACH: { type: 'PLAY_PEACH', fields: { entityId: { kind: 'string', required: true } } },
    PLAY_WUXIE: { type: 'PLAY_WUXIE', fields: { entityId: { kind: 'string', required: true } } },
    JUDGE_BAGUA: { type: 'JUDGE_BAGUA', allowPayload: false },
    PASS: { type: 'PASS', allowPayload: false }
  },
  setup: seed => setupSanguosha(seed),
  legalActions: (state, playerId) => SanguoshaRules.getLegalActions(state, playerId),
  reduce: (state, action, ctx) => SanguoshaRules.applyAction(state, action, ctx),
  outcome: state => toOutcome(SanguoshaRules.checkWinCondition(state))
});

export const splendorModule: GameModule = defineGame({
  meta: {
    id: 'splendor',
    name: '璀璨宝石 (Splendor)',
    description: '近似完全信息、永久费用修饰器、贵族自动结算',
    version: '1.0.0',
    capabilities: {
      simultaneousMoves: false,
      hiddenInformation: false,
      interruptStack: false,
      dynamicRules: false,
      topology: 'none',
      topologySpec: { kind: 'none', adjacency: 'none', geometry: 'none' },
    }
  },
  hooks: [],
  actionSchemas: {
    TAKE_3_DIFF_GEMS: { type: 'TAKE_3_DIFF_GEMS' },
    TAKE_2_SAME_GEMS: {
      type: 'TAKE_2_SAME_GEMS',
      payload: {
        gem: { kind: 'string', required: true, enum: ['diamond', 'sapphire', 'emerald', 'ruby', 'onyx'] }
      }
    },
    BUY_CARD: { type: 'BUY_CARD', fields: { entityId: { kind: 'string', required: true } } },
    RESERVE_CARD: { type: 'RESERVE_CARD', fields: { entityId: { kind: 'string', required: true } } }
  },
  setup: seed => setupSplendor(seed),
  legalActions: (state, playerId) => SplendorRules.getLegalActions(state, playerId),
  reduce: (state, action, ctx) => SplendorRules.applyAction(state, action, ctx),
  outcome: state => toOutcome(SplendorRules.checkWinCondition(state))
});

export const betrayalModule: GameModule = defineGame({
  meta: {
    id: 'betrayal',
    name: '山屋惊魂 (Betrayal)',
    description: '44 块可生长房间 · 四维属性轨道 · 13 预兆 / 25 物品 / 45 事件 · 三套完整作祟剧本',
    version: '2.2.0',
    schemaVersion: 3,
    engineVersion: 3,
    capabilities: {
      simultaneousMoves: false,
      hiddenInformation: true,
      interruptStack: true,
      dynamicRules: true,
      topology: 'graph',
      topologySpec: {
        kind: 'graph',
        adjacency: 'both',
        directed: true,
        weighted: false,
        geometry: 'grid',
        geometrySpec: { cellSize: 2.86, origin: [0, 0.05, 0] },
        layers: [
          { id: 'BASEMENT', name: '地下室', index: 0 },
          { id: 'GROUND', name: '一楼', index: 1 },
          { id: 'UPPER', name: '二楼', index: 2 }
        ]
      },
    }
  },
  hooks: BETRAYAL_HOOKS,
  timing: { decision: 6, response: 4 },
  scenarios: BETRAYAL_SCENARIOS,
  validatePayload: (state, action, payload) => {
    if (action.type === 'PLACE_ENTITY') {
      const pid = action.playerId ?? action.actorId;
      const roomId = String(state.players[pid]?.customProps.currentRoomId ?? '');
      if (!roomId) return ['the actor is not in a room'];
      const slot = state.mapGraph.slots?.[String(action.targetSlotId ?? '')];
      if (!slot || slot.nodeId !== roomId) {
        return ['discard target must be the actor current room'];
      }
      return [];
    }
    if (action.type !== 'PLACE_ROOM') return [];
    const pending = state.globalVars.pendingRoomPlacement as
      | { playerId: string; rotations: number[] }
      | null
      | undefined;
    if (!pending) return ['no room tile is awaiting placement'];
    if (pending.playerId !== (action.playerId ?? action.actorId)) return ['only the drawing player may place the tile'];
    const rotation = Number(payload.rotation);
    if (!Number.isInteger(rotation) || !pending.rotations.includes(rotation)) {
      return [`rotation ${String(payload.rotation)} is not legal for this tile`];
    }
    return [];
  },
  actionSchemas: {
    EXPLORE_DOOR: {
      type: 'EXPLORE_DOOR',
      payload: {
        direction: { kind: 'string', required: true, enum: ['N', 'S', 'E', 'W'] },
        rotation: { kind: 'string', enum: ['0', '1', '2', '3'] }
      }
    },
    PLACE_ROOM: {
      type: 'PLACE_ROOM',
      payload: {
        rotation: { kind: 'string', required: true, enum: ['0', '1', '2', '3'] },
        defName: { kind: 'string' }
      }
    },
    MOVE_TO_ROOM: { type: 'MOVE_TO_ROOM', fields: { targetNodeId: { kind: 'string' } } },
    // Riding rolls first; the destination is a separate ELEVATOR_MOVE step.
    USE_ELEVATOR: { type: 'USE_ELEVATOR', fields: {} },
    ELEVATOR_MOVE: { type: 'ELEVATOR_MOVE', fields: { targetNodeId: { kind: 'string', required: true } } },
    JUMP_DOWN: { type: 'JUMP_DOWN', allowPayload: false },
    CLIMB_UP: { type: 'CLIMB_UP', fields: { targetNodeId: { kind: 'string', required: true } } },
    USE_ITEM: {
      type: 'USE_ITEM',
      fields: { entityId: { kind: 'string', required: true } },
      payload: {
        mode: { kind: 'string' },
        target: { kind: 'string' },
        trait: { kind: 'string' },
        value: { kind: 'integer', min: 0, max: 8 },
        targetRoom: { kind: 'string' },
        deck: { kind: 'string', enum: ['zone_event_deck', 'zone_item_deck'] }
      }
    },
    DROP_ITEM: { type: 'DROP_ITEM', fields: { entityId: { kind: 'string', required: true } } },
    PICK_UP_ITEM: { type: 'PICK_UP_ITEM', fields: { entityId: { kind: 'string', required: true } } },
    PROPOSE_ITEM_TRADE: {
      type: 'PROPOSE_ITEM_TRADE',
      payload: {
        give: { kind: 'string', required: true },
        want: { kind: 'string' }
      }
    },
    ACCEPT_TRADE: { type: 'ACCEPT_TRADE', allowPayload: false },
    REJECT_TRADE: { type: 'REJECT_TRADE', allowPayload: false },
    ATTACK_PLAYER: {
      type: 'ATTACK_PLAYER',
      fields: { targetPlayerId: { kind: 'string', required: true } },
      payload: {
        weapon: { kind: 'string' },
        steal: { kind: 'string', enum: ['no', 'yes'] }
      }
    },
    ATTACK_MONSTER: {
      type: 'ATTACK_MONSTER',
      fields: { entityId: { kind: 'string', required: true } },
      payload: { weapon: { kind: 'string' } }
    },
    SLAP: { type: 'SLAP', fields: { targetPlayerId: { kind: 'string', required: true } } },
    ALLOCATE_DAMAGE: {
      type: 'ALLOCATE_DAMAGE',
      payload: { trait: { kind: 'string', required: true, enum: ['might', 'speed', 'sanity', 'knowledge'] } }
    },
    ROLL_HAUNT_CHECK: { type: 'ROLL_HAUNT_CHECK', allowPayload: false },
    SEAL_RITUAL: { type: 'SEAL_RITUAL', allowPayload: false },
    SEARCH_BONES: { type: 'SEARCH_BONES', allowPayload: false },
    CHANT: { type: 'CHANT', allowPayload: false },
    DESTROY_BEACON: { type: 'DESTROY_BEACON', allowPayload: false },
    BREW_HOLY_WATER: { type: 'BREW_HOLY_WATER', allowPayload: false },
    SANCTIFY_HOUSE: { type: 'SANCTIFY_HOUSE', allowPayload: false },
    FORGE_SILVER: { type: 'FORGE_SILVER', allowPayload: false },
    SUPPRESS_CURSE: { type: 'SUPPRESS_CURSE', allowPayload: false },
    PEEK_TOP: { type: 'PEEK_TOP', allowPayload: false },
    PEEK_BOTTOM: { type: 'PEEK_BOTTOM', allowPayload: false },
    FROSTBITE: { type: 'FROSTBITE', allowPayload: false },
    MOVE_NPC: { type: 'MOVE_NPC', fields: { targetNodeId: { kind: 'string', required: true } } },
    ATTACK_HERO: { type: 'ATTACK_HERO', fields: { targetPlayerId: { kind: 'string', required: true } } },
    END_NPC_TURN: { type: 'END_NPC_TURN', allowPayload: false },
    END_TURN: { type: 'END_TURN', allowPayload: false }
  },
  setup: seed => setupBetrayal(seed),
  project: {
    globalVars: (vars, state, viewer) => {
      const roomDeck = state.zones.zone_room_deck?.orderedEntities.length ?? 0;
      const peek = vars.peek as { ownerId?: string; title?: string } | null | undefined;
      const objectives = vars.hauntObjectives as { hero?: string; traitor?: string } | undefined;
      const isTraitor = state.players[viewer]?.role === 'TRAITOR';

      const {
        roomDeck: _roomDeck,
        roomDiscard: _roomDiscard,
        peek: _peek,
        hauntObjectives: _objectives,
        ...rest
      } = vars;

      void _roomDeck;
      void _roomDiscard;
      void _objectives;

      return {
        ...rest,
        roomDeckCount: roomDeck,
        ...(peek && peek.ownerId === viewer ? { peek } : {}),
        ...(objectives
          ? { hauntObjectives: isTraitor ? { traitor: objectives.traitor } : { hero: objectives.hero } }
          : {})
      };
    }
  },
  legalActions: (state, playerId) => BetrayalRules.getLegalActions(state, playerId),
  spatial: BETRAYAL_SPATIAL,
  resolveSelection: (state, _actorId, spec) => {
    if (spec.source !== 'node') return [];
    const ids = Array.isArray(spec.scope?.neighbors) ? (spec.scope!.neighbors as string[]) : [];
    return ids.map(id => ({
      id,
      label: String(state.mapGraph.nodes[id]?.props?.name ?? id)
    }));
  },
  reduce: (state, action, ctx) => BetrayalRules.applyAction(state, action, ctx),
  onDecisionResolved: (state, window) => BetrayalRules.onDecisionResolved(state, window),
  outcome: state => toOutcome(BetrayalRules.checkWinCondition(state))
});

export const duneMahjongModule: GameModule = defineGame({
  meta: {
    id: 'dune_mahjong',
    name: '沙丘 & 麻将 (Dune / Mahjong)',
    description: '秘密同步决策 |P(s)|>1、优先级仲裁与短路',
    version: '1.0.0',
    capabilities: {
      simultaneousMoves: true,
      hiddenInformation: true,
      interruptStack: true,
      dynamicRules: false,
      topology: 'none',
      topologySpec: { kind: 'none', adjacency: 'none', geometry: 'none' },
    }
  },
  hooks: [],
  timing: { decision: 8, response: 8 },
  project: {
    globalVars: (vars, _state, viewer) => {
      if (viewer === 'GOD') return vars;
      const { committedDials, ...rest } = vars as Record<string, unknown>;
      void committedDials;
      return rest;
    }
  },
  actionSchemas: {
    OPEN_BATTLE_WINDOW: { type: 'OPEN_BATTLE_WINDOW', allowPayload: false },
    COMMIT_BATTLE_DIAL: {
      type: 'COMMIT_BATTLE_DIAL',
      payload: {
        troops: { kind: 'integer', required: true, min: 0, max: 50 },
        leaderStr: { kind: 'integer', required: true, min: 0, max: 20 },
        weapon: { kind: 'string', required: true, enum: ['Crysknife', 'Lasgun', 'Shield'] }
      }
    },
    TRIGGER_MAHJONG_DISCARD: { type: 'TRIGGER_MAHJONG_DISCARD' },
    SWITCH_TO_MAHJONG_DEMO: { type: 'SWITCH_TO_MAHJONG_DEMO', allowPayload: false },
    SWITCH_TO_DUNE_DEMO: { type: 'SWITCH_TO_DUNE_DEMO', allowPayload: false },
    MAHJONG_HU: {
      type: 'MAHJONG_HU',
      payload: { priority: { kind: 'integer', required: true, min: 0, max: 100 } }
    },
    MAHJONG_PENG: {
      type: 'MAHJONG_PENG',
      payload: { priority: { kind: 'integer', required: true, min: 0, max: 100 } }
    },
    MAHJONG_CHI: {
      type: 'MAHJONG_CHI',
      payload: { priority: { kind: 'integer', required: true, min: 0, max: 100 } }
    },
    PASS: { type: 'PASS', allowPayload: false }
  },
  setup: seed => setupDuneMahjong(seed),
  legalActions: (state, playerId) => DuneMahjongRules.getLegalActions(state, playerId),
  reduce: (state, action, ctx) => DuneMahjongRules.applyAction(state, action, ctx),
  outcome: state => toOutcome(DuneMahjongRules.checkWinCondition(state))
});

export const GAME_REGISTRY: Record<string, GameModule> = {
  catan: catanModule,
  sanguosha: sanguoshaModule,
  splendor: splendorModule,
  betrayal: betrayalModule,
  dune_mahjong: duneMahjongModule
};

export const GAME_MODULES: GameModule[] = Object.values(GAME_REGISTRY);
