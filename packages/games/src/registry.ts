import { defineGame, GameModule } from '@rds/kernel/module';
import { GameOutcome } from '@rds/kernel/types';
import { BETRAYAL_HOOKS } from './betrayal/hooks';
import { betrayalCardFacts } from './betrayal/presentation';
import { BetrayalRules } from './betrayal/rules';
import { BETRAYAL_SCENARIOS } from './betrayal/scenarios';
import { BETRAYAL_SPATIAL } from './betrayal/spatial';
import { setupBetrayal } from './betrayal/setup';
import { traitModifiers } from './betrayal/helpers';
import { CatanRules } from './catan/rules';
import { setupCatan } from './catan/setup';
import { CATAN_SCENARIOS } from './catan/scenarios';
import { DuneMahjongRules } from './dune_mahjong/rules';
import { setupDuneMahjong } from './dune_mahjong/setup';
import { PokerRules } from './poker/rules';
import { pokerScenario, setupPoker } from './poker/setup';
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

/**
 * 宝可梦璀璨宝石 (Pokémon Splendor).
 *
 * Six Poké Ball colours, a bank dealt by seat count, three shuffled stage decks
 * with a four-card market row, master-ball-only rare / legendary Pokémon, and
 * free evolution that buries the base Pokémon.
 */
export const splendorModule: GameModule = defineGame({
  meta: {
    id: 'splendor',
    name: '宝可梦璀璨宝石 (Pokémon Splendor)',
    description: '六色精灵球 · 三阶宝可梦市场 · 大师球稀有捕捉 · 免费进化 · 18 分终局（可选超级进化 / 宝可梦商店扩展）',
    version: '2.1.0',
    schemaVersion: 2,
    capabilities: {
      simultaneousMoves: false,
      // The stage decks are face-down piles: card order is hidden information.
      hiddenInformation: true,
      interruptStack: false,
      dynamicRules: false,
      topology: 'none',
      topologySpec: { kind: 'none', adjacency: 'none', geometry: 'none' }
    }
  },
  // The market row already previews faces on hover; a click must not open a
  // second card view for the same card.
  presentation: { cardPreviewOnHover: true },
  hooks: [],
  actionSchemas: {
    TAKE_3_DIFF_GEMS: {
      type: 'TAKE_3_DIFF_GEMS',
      // 1–3 distinct non-master colours; cross-field checks live in the reducer.
      payload: { gems: { kind: 'array', required: true } }
    },
    TAKE_2_SAME_GEMS: {
      type: 'TAKE_2_SAME_GEMS',
      payload: {
        // Master balls are never taken from the bank — reserving awards them.
        gem: { kind: 'string', required: true, enum: ['red', 'blue', 'black', 'pink', 'yellow'] }
      }
    },
    BUY_CARD: {
      type: 'BUY_CARD',
      fields: { entityId: { kind: 'string', required: true } },
      // Poké Mart expansion: the capture's effect choices. Every field is
      // optional — a plain Pokémon capture and a no-choice effect need none of
      // them — and all of them are re-validated by the reducer.
      payload: {
        captureOpts: { kind: 'object' }
      }
    },
    RESERVE_CARD: {
      type: 'RESERVE_CARD',
      // Either a face-up card (`entityId`) or a blind draw from a level deck
      // (`payload.fromTier`: a base level 1–3, or a Poké Mart level id), so
      // neither may be mandatory on its own. The tier is deliberately typed
      // loosely here: it is a number for base decks and a string for Poké Mart
      // decks, and the reducer is the single place that decodes it.
      fields: { entityId: { kind: 'string' } }
    },
    EVOLVE: {
      type: 'EVOLVE',
      payload: {
        fromId: { kind: 'string', required: true },
        toId: { kind: 'string', required: true }
      }
    },
    // Mega Evolution: spend the whole action on a shared Mega token.
    TAKE_MEGA_TOKEN: { type: 'TAKE_MEGA_TOKEN', allowPayload: false },
    // Super-evolution: consumes the Mega token and counts as this turn's evolution.
    MEGA_EVOLVE: {
      type: 'MEGA_EVOLVE',
      payload: {
        megaId: { kind: 'string', required: true },
        fromId: { kind: 'string', required: true }
      }
    },
    // Only offered when a player has no other legal move (see getLegalActions).
    END_TURN: { type: 'END_TURN', allowPayload: false }
  },
  /**
   * Named start positions: the base game plus its two expansions, alone and in
   * combination. The kernel's `setup(seed)` contract carries no configuration,
   * so the variant is baked into each closure.
   */
  scenarios: {
    base: {
      description: '基础版',
      setup: (seed, options) => setupSplendor(seed, options?.seats ?? 2, { mega: false, pokemart: false })
    },
    mega: {
      description: '超级进化',
      setup: (seed, options) => setupSplendor(seed, options?.seats ?? 2, { mega: true, pokemart: false })
    },
    pokemart: {
      description: '宝可梦商店',
      setup: (seed, options) => setupSplendor(seed, options?.seats ?? 2, { mega: false, pokemart: true })
    },
    full: {
      description: '全扩展',
      setup: (seed, options) => setupSplendor(seed, options?.seats ?? 2, { mega: true, pokemart: true })
    }
  },
  setup: (seed, options) => setupSplendor(seed, options?.seats),
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
  // 山屋的卡牌词汇（武器/护甲/预兆…）与派生的详情行由本包声明。
  presentation: { cardFacts: betrayalCardFacts },
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
    ROOM_EXIT_CHECK: { type: 'ROOM_EXIT_CHECK', fields: {} },
    EXIT_STAY: { type: 'EXIT_STAY', fields: {} },
    EXIT_PAY: { type: 'EXIT_PAY', fields: {} },
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
  statModifiers: (state, playerId) => traitModifiers(state, playerId),
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

/**
 * 德州扑克 (Texas Hold'em).
 *
 * No-limit single-table poker: 52 cards, 2–10 seats, side pots and split pots.
 * A seat that loses every chip ends the session (see docs/POKER.md), so the
 * module needs no tournament ladder. Betting state lives in `globalVars.hand`;
 * hole cards stay ordinary entities in `zone_hand_*` so the kernel's projection
 * masks them for every other viewer.
 */
export const pokerModule: GameModule = defineGame({
  meta: {
    id: 'poker',
    name: "德州扑克 (Texas Hold'em)",
    description: '无限注德州扑克 · 52 张牌 · 2–10 人 · 边池 / 平分 · 输光即终局',
    version: '1.0.0',
    capabilities: {
      simultaneousMoves: false,
      hiddenInformation: true,
      interruptStack: false,
      dynamicRules: false,
      topology: 'ring',
      topologySpec: { kind: 'ring', adjacency: 'neighbors', geometry: 'ring' }
    }
  },
  hooks: [],
  actionSchemas: {
    START_HAND: { type: 'START_HAND', allowPayload: false },
    FOLD: { type: 'FOLD', allowPayload: false },
    CHECK: { type: 'CHECK', allowPayload: false },
    CALL: { type: 'CALL', payload: { amount: { kind: 'integer', min: 0 } } },
    // The legal range depends on the live stack, so bounds are checked in
    // PokerRules.validatePayload instead of the static schema.
    RAISE: { type: 'RAISE', payload: { amount: { kind: 'integer', min: 0 } } },
    ALL_IN: { type: 'ALL_IN', allowPayload: false }
  },
  scenarios: {
    seats_2: { description: '单挑（2 人）', setup: pokerScenario(2) },
    seats_3: { description: '3 人桌', setup: pokerScenario(3) },
    seats_4: { description: '4 人桌', setup: pokerScenario(4) },
    seats_5: { description: '5 人桌', setup: pokerScenario(5) },
    seats_6: { description: '6 人桌', setup: pokerScenario(6) },
    seats_7: { description: '7 人桌', setup: pokerScenario(7) },
    seats_8: { description: '8 人桌', setup: pokerScenario(8) },
    seats_9: { description: '9 人桌', setup: pokerScenario(9) },
    seats_10: { description: '10 人满桌', setup: pokerScenario(10) },
    short_stack: {
      description: '短码演示（玩家 4 只有 60 筹码，数手内触发终局）',
      setup: pokerScenario(4, { stacks: [1000, 1000, 1000, 60] })
    }
  },
  setup: (seed, options) => setupPoker(seed, { seats: options?.seats ?? 4 }),
  legalActions: (state, playerId) => PokerRules.getLegalActions(state, playerId),
  validatePayload: (state, action, payload) => PokerRules.validatePayload(state, action, payload),
  reduce: (state, action, ctx) => PokerRules.applyAction(state, action, ctx),
  outcome: state => toOutcome(PokerRules.checkWinCondition(state))
});

export const GAME_REGISTRY: Record<string, GameModule> = {
  catan: catanModule,
  sanguosha: sanguoshaModule,
  splendor: splendorModule,
  betrayal: betrayalModule,
  dune_mahjong: duneMahjongModule,
  poker: pokerModule
};

export const GAME_MODULES: GameModule[] = Object.values(GAME_REGISTRY);
