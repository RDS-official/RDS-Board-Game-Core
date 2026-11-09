import { assertCharterSurface } from '@rds/kernel/charter';
import { defineDriver, defineGame, definePresentation, GameModule } from '@rds/kernel/module';
import { GameOutcome } from '@rds/kernel/types';
import { BETRAYAL_HOOKS } from './betrayal/hooks';
import {
  BETRAYAL_MAP_TITLE,
  betrayalCardFacts,
  betrayalCardStyle,
  betrayalCastMember,
  betrayalDescribeMoment,
  betrayalDescribeNode,
  betrayalDescribeTrait,
  betrayalMissionLine,
  betrayalPhaseLabel,
  betrayalPlayerNode,
  betrayalPlayerView,
  betrayalRoleLabel,
  betrayalRoomLoot,
  betrayalTokenBadge,
  betrayalTraits
} from './betrayal/presentation';
import { BetrayalRules } from './betrayal/rules';
import { BETRAYAL_SCENARIOS } from './betrayal/scenarios';
import { BETRAYAL_SPATIAL } from './betrayal/spatial';
import { setupBetrayal } from './betrayal/setup';
import { traitModifiers } from './betrayal/helpers';
import { CatanRules } from './catan/rules';
import { setupCatan } from './catan/setup';
import { CATAN_SCENARIOS } from './catan/scenarios';
import { catanPhaseLabel, catanPlayerView } from './catan/presentation';
import { DuneMahjongRules } from './dune_mahjong/rules';
import { dunePhaseLabel, dunePlayerView } from './dune_mahjong/presentation';
import {
  checkBetrayalInvariants,
  checkCatanInvariants,
  checkDuneInvariants,
  checkSanguoshaInvariants,
  checkSplendorInvariants
} from './invariants/semantic';
import { setupDuneMahjong } from './dune_mahjong/setup';
import { PokerRules } from './poker/rules';
import { pokerScenario, setupPoker } from './poker/setup';
import {
  pokerDefaultViewer,
  pokerMissionLine,
  pokerPhaseLabel,
  pokerPlayerView,
  pokerRankedPlayers,
  pokerSettlementMoment
} from './poker/presentation';
import { isAiSeat as isPokerAiSeat, POKER_TABLE } from './poker/seating';
import { SANGUOSHA_HOOKS } from './sanguosha/hooks';
import {
  sanguoshaCardFacts,
  sanguoshaCardStyle,
  sanguoshaDefaultViewer,
  sanguoshaDescribeMoment,
  sanguoshaMissionLine,
  sanguoshaPhaseLabel,
  sanguoshaPlayerView,
  sanguoshaRoleLabel
} from './sanguosha/presentation';
import { isAiSeat } from './sanguosha/ai';
import { SanguoshaRules } from './sanguosha/rules';
import { SANGUOSHA_CUSTOM_PROPS, SANGUOSHA_GLOBAL_VARS } from './sanguosha/schema';
import type { SgsPendingChoice } from './sanguosha/types';
import { sanguoshaScenario, setupSanguosha } from './sanguosha/setup';
import { SplendorRules } from './splendor/rules';
import { setupSplendor } from './splendor/setup';
import { splendorPhaseLabel, splendorPlayerView } from './splendor/presentation';

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
    // 座位数契约（issue #214）：卡坦岛标准局支持 3–4 人，默认仍按 3 人发牌。
    seatRange: { min: 3, max: 4, default: 3, variable: true },
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
    },
    /**
     * C-9 扩展字段收口：本模组会往自由形状字段里写这些 key。
     * 未登记的 key 出现，内核记 CHARTER_C9_UNDECLARED_GLOBAL_VAR。
     */
    stateSchema: {
      globalVars: ['bank', 'diceSum', 'freeRoads', 'largestArmyOwner', 'lastDiceRoll', 'longestRoadOwner', 'ports', 'resourcePicks', 'robberHexId', 'robberReason', 'setupIndex', 'setupLastVertex', 'setupOrder', 'tradeGive', 'tradeOffer'],
      customProps: ['knightsPlayed', 'resources']
    }
  },
  // C-6：规则层守恒/边界断言，内核每次转移后调用（不阻断，只记录）。
  checkInvariants: state => checkCatanInvariants(state),
  presentation: definePresentation({
    phaseLabel: catanPhaseLabel,
    playerView: catanPlayerView
  }),
  // C-7：资源获取经 ctx.reward() 记账（掷骰产出 / 港口兑换 / 强盗抢夺）。
  charter: { requiresRewardLedger: true },
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
    DISCARD_HALF: {
      type: 'DISCARD_HALF',
      payload: {
        wood: { kind: 'integer', min: 0 },
        brick: { kind: 'integer', min: 0 },
        sheep: { kind: 'integer', min: 0 },
        wheat: { kind: 'integer', min: 0 },
        ore: { kind: 'integer', min: 0 }
      }
    },
    ACCEPT_TRADE: { type: 'ACCEPT_TRADE', allowPayload: false },
    REJECT_TRADE: { type: 'REJECT_TRADE', allowPayload: false },
    END_TURN: { type: 'END_TURN', allowPayload: false }
  },
  setup: (seed, options) => setupCatan(seed, options),
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
  validatePayload: (state, action, payload) => CatanRules.validatePayload(state, action, payload),
  legalActions: (state, playerId) => CatanRules.getLegalActions(state, playerId),
  reduce: (state, action, ctx) => CatanRules.applyAction(state, action, ctx),
  // 宪章 C-3：掷 7 的"各弃一半"多方同时结算。
  applySimultaneous: (state, actions, ctx) => CatanRules.applySimultaneous(state, actions, ctx),
  onDecisionResolved: (state, window) => CatanRules.onDecisionResolved(state, window),
  outcome: state => toOutcome(CatanRules.checkWinCondition(state))
});

/**
 * 三国杀 (Sanguosha) — 标准身份局。
 *
 * The fixture is intentionally a full tabletop loop rather than a single
 * interrupt demo: all six phases run as explicit automatic follow-ups, the
 * 108-card standard deck (and an optional military deck) is represented as ECS
 * cards, and every response/decision is a normal kernel action that replays
 * bit-exactly.
 */
export const sanguoshaModule: GameModule = defineGame({
  meta: {
    id: 'sanguosha',
    name: '三国杀 (Sanguosha)',
    description: '4/5/8人身份局 · 4人2v2 · 2–8人杀下家 · AI补位 · 积分 · 108张牌 · 六阶段 · 17名武将',
    version: '2.1.0',
    schemaVersion: 3,
    // 2–8 座：身份局标准 5/8 人、4 人对抗、以及任意人数的杀下家村规。
    seatRange: { min: 2, max: 8, default: 4, variable: true },
    capabilities: {
      simultaneousMoves: false,
      hiddenInformation: true,
      interruptStack: true,
      dynamicRules: true,
      topology: 'ring',
      topologySpec: { kind: 'ring', adjacency: 'neighbors', geometry: 'ring' },
    },
    /**
     * C-9 扩展字段收口：本模组会往自由形状字段里写这些 key。
     * 未登记的 key 出现，内核记 CHARTER_C9_UNDECLARED_GLOBAL_VAR。
     */
    stateSchema: {
      globalVars: [...SANGUOSHA_GLOBAL_VARS],
      customProps: [...SANGUOSHA_CUSTOM_PROPS]
    }
  },
  // C-6：规则层守恒/边界断言，内核每次转移后调用（不阻断，只记录）。
  checkInvariants: state => checkSanguoshaInvariants(state),
  // C-7：伤害、回复、击杀反贼的收益都经 ctx.reward() 留下理由。
  // C-5：AI 决策收口到投影状态（preferAiAction() 先投影，chooseSanguoshaAiAction 只收投影）。
  charter: { requiresRewardLedger: true, requiresProjection: true },
  // 身份 token（主公/忠臣/反贼/内奸）、牌面分类与终局幕布都是本包词汇。
  presentation: definePresentation({
    roleLabel: sanguoshaRoleLabel,
    cardFacts: sanguoshaCardFacts,
    cardStyle: sanguoshaCardStyle,
    describeMoment: sanguoshaDescribeMoment,
    phaseLabel: sanguoshaPhaseLabel,
    missionLine: sanguoshaMissionLine,
    playerView: sanguoshaPlayerView,
    // 单机开局坐在第一个真人座位上；否则 GOD 视角会把 AI 手牌全画出来。
    defaultViewer: sanguoshaDefaultViewer
  }),
  hooks: SANGUOSHA_HOOKS,
  timing: { decision: 6, response: 4 },
  driver: defineDriver({
    // AI seats are marked in `globalVars.seats`; the app/server driver dispatches
    // their legal action at a readable pace (same pipeline as humans).
    isAutomated: (state, actorId) => isAiSeat(state, actorId),
    aiActionDelayMs: 1200
  }),
  project: {
    player: (player, viewer, state) => {
      if (viewer === 'GOD' || player.id === viewer) return player;
      // 阵营/村规模式的身份本来就是公开信息；身份局里主公身份始终公开。
      if (String(state.globalVars.mode ?? 'identity') !== 'identity') return player;
      // 阵亡与终局后的身份公开。
      if (!player.alive || state.gameOver || player.role === 'LORD') return player;
      return { ...player, role: undefined, secretRole: undefined };
    },
    globalVars: (vars, _state, viewer) => {
      const choice = vars.pendingChoice as SgsPendingChoice | undefined;
      if (!choice || viewer === 'GOD' || choice.playerId === viewer) return vars;
      // The choosing player's hand options must not leak faces (or even entity
      // ids) to the rest of the table. Public equipment/judgement options stay
      // visible; hand options collapse to an opaque label.
      return {
        ...vars,
        pendingChoice: {
          ...choice,
          options: choice.options.map(option =>
            option.zone === 'HAND'
              ? { id: option.id, label: option.label, zone: option.zone }
              : { id: option.id, label: option.label, zone: option.zone, cardId: option.cardId }
          )
        }
      };
    }
  },
  actionSchemas: {
    PLAY_STRIKE: {
      type: 'PLAY_STRIKE',
      fields: { entityId: { kind: 'string', required: true }, targetPlayerId: { kind: 'string' } }
    },
    PLAY_DODGE: { type: 'PLAY_DODGE', fields: { entityId: { kind: 'string', required: true } } },
    PLAY_PEACH: {
      type: 'PLAY_PEACH',
      fields: { entityId: { kind: 'string', required: true }, targetPlayerId: { kind: 'string' } }
    },
    PLAY_WUXIE: { type: 'PLAY_WUXIE', fields: { entityId: { kind: 'string', required: true } } },
    PLAY_CARD: {
      type: 'PLAY_CARD',
      fields: { entityId: { kind: 'string', required: true }, targetPlayerId: { kind: 'string' } }
    },
    EQUIP_CARD: { type: 'EQUIP_CARD', fields: { entityId: { kind: 'string', required: true } } },
    USE_SKILL: {
      type: 'USE_SKILL',
      fields: { entityId: { kind: 'string' }, targetPlayerId: { kind: 'string' } }
    },
    DISCARD_CARD: { type: 'DISCARD_CARD', fields: { entityId: { kind: 'string', required: true } } },
    RESOLVE_CHOICE: { type: 'RESOLVE_CHOICE', fields: { entityId: { kind: 'string' } } },
    JUDGE_BAGUA: { type: 'JUDGE_BAGUA' },
    PASS: { type: 'PASS', allowPayload: false },
    END_TURN: { type: 'END_TURN', allowPayload: false },
    START_TURN: { type: 'START_TURN', allowPayload: false },
    LUOSHEN_STEP: { type: 'LUOSHEN_STEP', allowPayload: false },
    RESOLVE_JUDGE: { type: 'RESOLVE_JUDGE', allowPayload: false },
    DRAW_PHASE: { type: 'DRAW_PHASE', allowPayload: false },
    FINISH_DISCARD: { type: 'FINISH_DISCARD', allowPayload: false },
    FINISH_TURN: { type: 'FINISH_TURN', allowPayload: false },
    RESOLVE_PENDING_TRICK: { type: 'RESOLVE_PENDING_TRICK', allowPayload: false },
    EXECUTE_DAMAGE: { type: 'EXECUTE_DAMAGE' },
    CHECK_DEATH: { type: 'CHECK_DEATH', allowPayload: false },
    DUEL_DAMAGE: { type: 'DUEL_DAMAGE', allowPayload: false },
    MASS_TRICK_NEXT: { type: 'MASS_TRICK_NEXT', allowPayload: false },
    BORROW_SWORD_FAIL: { type: 'BORROW_SWORD_FAIL', allowPayload: false },
    CONTINUE_STRIKE_QUEUE: { type: 'CONTINUE_STRIKE_QUEUE', allowPayload: false },
    DRAW_CARDS: { type: 'DRAW_CARDS', allowPayload: false }
  },
  scenarios: {
    classic: {
      seats: 4,
      description: '经典四人局 · 标准108张 · 刘关曹吕',
      setup: sanguoshaScenario('classic')
    },
    identity_5: {
      seats: 5,
      description: '标准5人身份局 · 1主1忠2反1内 · 随机选将',
      setup: sanguoshaScenario('warlords', 'identity', 5)
    },
    identity_8: {
      seats: 8,
      description: '标准8人身份局 · 1主2忠4反1内 · 随机选将',
      setup: sanguoshaScenario('warlords', 'identity', 8)
    },
    team_4: {
      seats: 4,
      description: '4人对抗 · 2v2赤蓝阵营 · 随机选将',
      setup: sanguoshaScenario('warlords', 'team', 4)
    },
    kill_next: {
      description: '杀下家村规 · 2–8人 · 杀死下家立即获胜',
      setup: sanguoshaScenario('warlords', 'kill_next')
    },
    warlords: {
      seats: 4,
      description: '群雄逐鹿 · 17名武将随机选将 · 标准108张',
      setup: sanguoshaScenario('warlords', 'identity', 4)
    },
    military: {
      seats: 4,
      description: '军争篇 · 标准牌堆 + 火杀/雷杀/酒/铁索/火攻/兵粮',
      setup: sanguoshaScenario('military', 'identity', 4)
    },
    military_warlords: {
      seats: 4,
      description: '军争群雄 · 军争牌堆 + 随机选将',
      setup: sanguoshaScenario('military_warlords', 'identity', 4)
    },
    ai_standard_4: {
      seats: 4,
      description: '单机入门 · 1真人 + 3 AI · 经典4人身份局',
      setup: (seed, options) =>
        setupSanguosha(seed, {
          ...(options ?? {}),
          variant: 'classic',
          mode: 'identity',
          seats: 4,
          humans: 1,
          aiSeats: 3
        })
    }
  },
  setup: (seed, options) => setupSanguosha(seed, options),
  legalActions: (state, playerId) => SanguoshaRules.getLegalActions(state, playerId),
  reduce: (state, action, ctx) => SanguoshaRules.applyAction(state, action, ctx),
  resolveFollowUp: (state, ctx) => SanguoshaRules.resolveFollowUp(state, ctx),
  onDecisionResolved: (state, window, ctx) => SanguoshaRules.onDecisionResolved(state, window, ctx),
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
    // 座位数契约（issue #214）：与 setup 的 playerOrder 保持一致，由回归用例守着。
    seatRange: { min: 2, max: 2 },
    schemaVersion: 2,
    capabilities: {
      simultaneousMoves: false,
      // The stage decks are face-down piles: card order is hidden information.
      hiddenInformation: true,
      interruptStack: false,
      dynamicRules: false,
      topology: 'none',
      topologySpec: { kind: 'none', adjacency: 'none', geometry: 'none' }
    },
    /**
     * C-9 扩展字段收口：本模组会往自由形状字段里写这些 key。
     * 未登记的 key 出现，内核记 CHARTER_C9_UNDECLARED_GLOBAL_VAR。
     */
    stateSchema: {
      globalVars: ['bank', 'evolvedThisTurn', 'finalRoundComplete', 'lastRound', 'maxReserves', 'maxTokens', 'megaTokens', 'playerCount', 'scoreToWin', 'variant'],
      customProps: ['assoc', 'bonuses', 'buriedIds', 'megaToken', 'purchasedCards', 'tokens']
    }
  },
  // C-6：规则层守恒/边界断言，内核每次转移后调用（不阻断，只记录）。
  checkInvariants: state => checkSplendorInvariants(state),
  // C-5：没有机器决策入口（无 isAutomated）。牌堆与储备区靠实体 visibility
  // （HIDDEN / OWNER_ONLY）由内核投影遮罩，不另做 project()。
  // C-7：分数由 settleTableau() 从场面整表重算，不是累加收益，账本记的是增量，
  // 硬塞只会把同一分反复记一遍。到期日是复核日，不是承诺接入的日期。
  charter: {
    deviations: [
      {
        clause: 'C-5',
        reason: '无机器决策入口；隐藏信息由实体 visibility 交给内核投影遮罩',
        expires: '2027-05-08'
      },
      {
        clause: 'C-7',
        reason: '分数由场面派生重算（settleTableau 整表求和），没有可记账的增量收益',
        expires: '2027-05-08'
      }
    ]
  },
  // The market row already previews faces on hover; a click must not open a
  // second card view for the same card.
  presentation: definePresentation({
    cardPreviewOnHover: true,
    phaseLabel: splendorPhaseLabel,
    playerView: splendorPlayerView
  }),
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
    // 座位数契约（issue #214）：与 setup 的 playerOrder 保持一致，由回归用例守着。
    seatRange: { min: 3, max: 3 },
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
    },
    /**
     * C-9 扩展字段收口：本模组会往自由形状字段里写这些 key。
     * 未登记的 key 出现，内核记 CHARTER_C9_UNDECLARED_GLOBAL_VAR。
     */
    stateSchema: {
      globalVars: ['elevatorRide', 'elevatorRoomId', 'floorAnchors', 'frontDoorLocked', 'frostRooms', 'haunt', 'hauntObjectives', 'hauntTriggered', 'lastElevatorRoll', 'lastNarration', 'lastRoll', 'omenNames', 'omensRevealed', 'peek', 'pendingDamage', 'pendingExit', 'pendingHauntRoll', 'pendingRoomPlacement', 'rollSeq', 'roomDeckTotal', 'tradeOffer'],
      customProps: ['abducted', 'attacksLeft', 'banished', 'brewUsed', 'chantUsed', 'character', 'checkBonus', 'controlled', 'currentRoomId', 'effects', 'elevatorUsed', 'en', 'exitPassedRoom', 'floor', 'forcedRoll', 'forgeUsed', 'immuneMindControl', 'maskWorn', 'movesLeft', 'resonance', 'ritualUsed', 'rolledThisTurn', 'roomBuffs', 'roomId', 'sanctifyUsed', 'searchUsed', 'skipActions', 'startIndex', 'suppressUsed', 'tracks', 'traitIndex', 'traitModifiers', 'traits', 'usedItems']
    }
  },
  // C-6：规则层守恒/边界断言，内核每次转移后调用（不阻断，只记录）。
  checkInvariants: state => checkBetrayalInvariants(state),
  // C-7：本作没有筹码或分数型收益，胜负由剧本目标判定；player.score 恒为 0。
  charter: {
    deviations: [
      {
        clause: 'C-7',
        reason: '无筹码或分数型收益，胜负由剧本目标判定，不存在可记账的增量',
        expires: '2027-05-08'
      }
    ]
  },
  // 山屋的卡牌词汇（武器/护甲/预兆…）、派生的详情行、新房间档案、四条数值阶梯、
  // 身份名与作祟序曲都由本包声明；通用层只负责摆放。
  presentation: definePresentation({
    cardFacts: betrayalCardFacts,
    cardStyle: betrayalCardStyle,
    describeNode: betrayalDescribeNode,
    describeTrait: betrayalDescribeTrait,
    traits: betrayalTraits,
    describeMoment: betrayalDescribeMoment,
    phaseLabel: betrayalPhaseLabel,
    missionLine: betrayalMissionLine,
    playerView: betrayalPlayerView,
    roleLabel: betrayalRoleLabel,
    mapTitle: BETRAYAL_MAP_TITLE,
    playerNode: betrayalPlayerNode,
    castMember: betrayalCastMember,
    roomLoot: betrayalRoomLoot,
    tokenBadge: betrayalTokenBadge
  }),
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
    // 前门被锁时的「试着开前门」（`legalActions` 在 frontDoorLocked 时给出）。
    TRY_FRONT_DOOR: { type: 'TRY_FRONT_DOOR', allowPayload: false },
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
    // 座位数契约（issue #214）：与 setup 的 playerOrder 保持一致，由回归用例守着。
    seatRange: { min: 3, max: 3 },
    capabilities: {
      simultaneousMoves: true,
      hiddenInformation: true,
      interruptStack: true,
      dynamicRules: false,
      topology: 'none',
      topologySpec: { kind: 'none', adjacency: 'none', geometry: 'none' },
    },
    /**
     * C-9 扩展字段收口：本模组会往自由形状字段里写这些 key。
     * 未登记的 key 出现，内核记 CHARTER_C9_UNDECLARED_GLOBAL_VAR。
     */
    stateSchema: {
      globalVars: ['battleMode', 'committedDials', 'mahjongTileDiscarded', 'mahjongTileDiscarder', 'revealedBattleResult'],
      customProps: ['committedDial', 'faction', 'leader', 'spice', 'troops']
    }
  },
  // C-6：规则层守恒/边界断言，内核每次转移后调用（不阻断，只记录）。
  checkInvariants: state => checkDuneInvariants(state),
  // C-7：胡 / 碰 / 吃与战斗之轮的胜者加分都经 ctx.reward() 记账。
  charter: { requiresRewardLedger: true },
  presentation: definePresentation({
    phaseLabel: dunePhaseLabel,
    playerView: dunePlayerView
  }),
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
  // 宪章 C-3：战斗之轮的双 dial 多重集一次性结算，顺序不影响结果。
  applySimultaneous: (state, actions, ctx) => DuneMahjongRules.applySimultaneous(state, actions as never, ctx),
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
    description: '无限注德州扑克 · 52 张牌 · 2–10 人 · 边池 / 平分 · 输光转观察者',
    version: '1.0.0',
    // 座位数契约（issue #214）：与 setup 的 playerOrder 保持一致，由回归用例守着。
    seatRange: { min: 2, max: 10, default: 6, variable: true },
    capabilities: {
      simultaneousMoves: false,
      hiddenInformation: true,
      interruptStack: false,
      dynamicRules: false,
      topology: 'ring',
      topologySpec: { kind: 'ring', adjacency: 'neighbors', geometry: 'ring' }
    },
    /**
     * C-9 扩展字段收口：德扑只往 `globalVars` 里写这 7 个 key。
     * 未登记的 key 出现，内核会记一条 `CHARTER_C9_UNDECLARED_GLOBAL_VAR`。
     */
    stateSchema: {
      globalVars: ['config', 'hand', 'lastHand', 'log', 'observers', 'seating', 'seats']
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
    ALL_IN: { type: 'ALL_IN', allowPayload: false },
    // 座位流程：入座 → 准备（全员准备后 START_HAND 才放行）。
    TAKE_SEAT: { type: 'TAKE_SEAT', allowPayload: false },
    READY_UP: { type: 'READY_UP', allowPayload: false },
    // 免等待开下一手（服务端在结算幕布超时后派发）。
    FORCE_START: { type: 'FORCE_START', allowPayload: false },
    // 一手结束后的收尾：准备下一手 / 亮牌 / 埋牌。三者都在 `legalActions`
    // 的 COMPLETE 分支里给出，但历史上没进代数声明（C-1 缺口）。
    READY: { type: 'READY', allowPayload: false },
    SHOW: { type: 'SHOW', allowPayload: false },
    MUCK: { type: 'MUCK', allowPayload: false },
    // 单机夹具用的调试动作：一键让所有座位就绪。
    DEBUG_READY_ALL: { type: 'DEBUG_READY_ALL', allowPayload: false },
    // 观察者席位：重新上桌申请 + 驱动方心跳（低保结算）。
    OBSERVER_REJOIN: { type: 'OBSERVER_REJOIN', allowPayload: false },
    OBSERVER_TICK: { type: 'OBSERVER_TICK', payload: { seconds: { kind: 'integer', min: 0 } } }
  },
  scenarios: {
    seats_2: { seats: 2,
 description: '单挑（2 人）', setup: pokerScenario(2) },
    seats_3: { seats: 3,
 description: '3 人桌', setup: pokerScenario(3) },
    seats_4: { seats: 4,
 description: '4 人桌', setup: pokerScenario(4) },
    seats_5: { seats: 5,
 description: '5 人桌', setup: pokerScenario(5) },
    seats_6: { seats: 6,
 description: '6 人桌', setup: pokerScenario(6) },
    seats_7: { seats: 7,
 description: '7 人桌', setup: pokerScenario(7) },
    seats_8: { seats: 8,
 description: '8 人桌', setup: pokerScenario(8) },
    seats_9: { seats: 9,
 description: '9 人桌', setup: pokerScenario(9) },
    seats_10: { seats: 10,
 description: '10 人满桌', setup: pokerScenario(10) },
    short_stack: {
      seats: 4,
      description: '短码演示（玩家 4 只有 60 筹码，输光后转观察者）',
      setup: pokerScenario(4, { stacks: [1000, 1000, 1000, 60] })
    },
    /** 默认桌：1 名真人 + 5 个内置 AI（入门桌）/ 1 真人 + 9 AI（满桌）。 */
    ai_table_6: {
      seats: 6,
      description: '1 真人 + 5 AI（入门桌）',
      setup: (seed: number, options?: { autoAi?: boolean }) =>
        setupPoker(seed, {
          seats: 6,
          humans: 1,
          ...(options?.autoAi === undefined ? {} : { autoAi: options.autoAi })
        })
    },
    ai_table_10: {
      seats: 10,
      description: '1 真人 + 9 AI（满桌）',
      setup: (seed: number, options?: { autoAi?: boolean }) =>
        setupPoker(seed, {
          seats: 10,
          humans: 1,
          ...(options?.autoAi === undefined ? {} : { autoAi: options.autoAi })
        })
    }
  },
  /**
   * 座位规则：
   *  - 调用方显式给出座位数（联机房间按真人数量）时，这些座位全是真人；
   *  - 未指定时用默认桌：1 名真人 + 内置 AI 补齐到 6 人（单人也能开一桌）。
   * 两种情况都走「入座 → 准备 → 开局」流程。
   */
  setup: (seed, options) =>
    setupPoker(seed, {
      // 总座位 = 调用方要的座位数（联机房间 = 真人 + AI），缺省用最低 6 人桌。
      seats: options?.seats ?? POKER_TABLE.minPlayers,
      humans: options?.humans ?? options?.seats ?? 1,
      // 房主在大厅添加的 AI 补位数；缺省时由 planSeats 补到 6 人。
      ...(options?.aiSeats === undefined ? {} : { aiSeats: options.aiSeats }),
      // 每个座位的买入：账号余额兑换筹码后按座位号传入（缺省 = 标准 1000）。
      ...(options?.stacks === undefined ? {} : { stacks: options.stacks }),
      ...(options?.autoAi === undefined ? {} : { autoAi: options.autoAi })
    }),
  presentation: definePresentation({
    // 结算幕布：每手结束播一次（key 含手数与结束方式，天然去重）。
    describeMoment: state => pokerSettlementMoment(state),
    // 单机开局坐在第一个真人座位上：默认停在 GOD 视角会把全部底牌与牌堆顺序
    // 直接画给玩家（issue #189）。中心模式的查看者由服务器绑定，不受影响。
    defaultViewer: state => pokerDefaultViewer(state),
    phaseLabel: pokerPhaseLabel,
    missionLine: pokerMissionLine,
    playerView: pokerPlayerView,
    rankedPlayers: pokerRankedPlayers
  }),
  /**
   * C-8：`𝒦_driver` —— 全部驱动方语义集中在这里。
   *
   * 之前这些字段散落在 GameModule 顶层（`driverActions` / `isAutomated` /
   * `heartbeat`）以及 `presentation` 里（`aiActionDelayMs` / `actionCooldownMs`），
   * 规则、展示、驱动三者混在一起，无法分别演进。
   */
  driver: defineDriver({
    /** 只由驱动方心跳派发的动作：玩家永远看不到，客户端入口也会拒绝。 */
    driverActions: ['OBSERVER_TICK', 'SETTLE_STEP'],
    /**
     * 内置 AI 座位。驱动方按 `aiActionDelayMs` 代它们派发动作；`legalActions`
     * 直接给出具体动作，AI 和真人因此走的是同一条管线（结算阶段也一样）。
     */
    isAutomated: (state, actorId) => isPokerAiSeat(state, actorId),
    /**
     * 观察者低保心跳：内核没有时钟，驱动方（app / server）每 20 秒派一拍，
     * PokerRules 把这些秒数累计成「满 60 秒 +10 筹码」。桌上没有观察者时不派发。
     */
    heartbeat: {
      intervalMs: 20_000,
      action: state => {
        const observers = (state.globalVars.observers as { list?: { playerId: string }[] } | undefined)
          ?.list;
        if (!Array.isArray(observers) || observers.length === 0) return null;
        return {
          type: 'OBSERVER_TICK',
          playerId: observers[0].playerId,
          payload: { seconds: 20 }
        };
      }
    },
    // 内置 AI 每步至少 5 秒，真人跟得上牌桌；驱动方据此逐步派发它的具体动作。
    aiActionDelayMs: 5000,
    // 一手刚结束，先让牌桌读完结算，20 秒后才允许开下一手。
    actionCooldownMs: { START_HAND: 20000 },
    // 真人 30 秒不出手就由服务端代打：能过牌就过牌，否则弃牌。
    // 掉线、锁屏、走开都不再能把整张桌子卡死（issue #190）。
    decisionDeadlineMs: 30_000,
    timeoutAction: legal => {
      // 能免费过牌就过牌，否则弃牌 —— 绝不替玩家跟注花钱。
      const check = legal.find(action => action.type === 'CHECK');
      if (check) return check;
      return legal.find(action => action.type === 'FOLD') ?? null;
    }
  }),
  legalActions: (state, playerId) => PokerRules.getLegalActions(state, playerId),
  validatePayload: (state, action, payload) => PokerRules.validatePayload(state, action, payload),
  reduce: (state, action, ctx) => PokerRules.applyAction(state, action, ctx),
  // 宪章 C-2：只声明规则上的结算步；AI 由内核 pump 逐步派发。
  resolveFollowUp: (state, ctx) => PokerRules.resolveFollowUp(state, ctx),
  outcome: state => toOutcome(PokerRules.checkWinCondition(state)),
  // C-6：规则层守恒断言（筹码守恒 / 底池一致性 / 手号单调），内核每次转移后调用。
  checkInvariants: state => PokerRules.checkInvariants(state),
  /**
   * C-5：AI 决策收口到投影状态（`decisionView()` → `choosePokerAction`）。
   * C-2 偏离登记：`applyAction()` 内联驱动 AI（`advanceAi`，上限 64 次）并在
   * `settle()` 里连续关街 / 发牌 / 摊牌，一次 `reduce` 可推进 8~64 次逻辑转移。
   * 移除条件：驱动方改为按 `driver.aiActionDelayMs` 逐步派发
   * （`autoAi: false`），且 `settle()` 拆成 follow-up action。
   */
  charter: {
    requiresProjection: true,
    // C-7：所有筹码增减都经 ctx.reward() 记账（摊牌 / 弃牌取胜 / 观察者低保）。
    requiresRewardLedger: true,
    // C-2 偏离已于 2026-11 移除：`advanceAi` 的 64 次循环删除、`settle()` 拆成单步
    // （多步由 `SETTLE_STEP` 经内核 follow-up 逐步派发），现在一次 reduce 只产生
    // 一次逻辑跃迁，不需要再登记偏离。
    deviations: []
  }
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

// 正式模组的加载期门槛。夹具不进这张表，所以不会被误伤。
for (const gameModule of GAME_MODULES) assertCharterSurface(gameModule);
