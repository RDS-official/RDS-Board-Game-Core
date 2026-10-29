import { ECSManager } from '@rds/kernel/ecs';
import { ReduceContext } from '@rds/kernel/module';
import { Action, Entity, GameState, Player, PlayerId } from '@rds/kernel/types';
import {
  dealTopCard,
  MASTER_BALL,
  MAX_RESERVES,
  MAX_TOKENS,
  POKEBALL_COLORS,
  SPLENDOR_TIERS,
  SPLENDOR_ZONES,
  SplendorTier,
  TOKEN_COLORS,
  WIN_SCORE
} from './setup';

/**
 * 宝可梦璀璨宝石 (Pokémon Splendor) — reducer.
 *
 * Everything here is a pure function of (state, action): no clock reads, no
 * `Math.random`, no class instances. The only entropy in the module is
 * `state.prngState`, folded once by `setupSplendor`.
 *
 * Action set
 *   TAKE_3_DIFF_GEMS  收服 1–3 种不同色的精灵球（不含大师球）
 *   TAKE_2_SAME_GEMS  同色双取（该色供应 ≥ 4）
 *   BUY_CARD          捕捉市场 / 保留区的宝可梦
 *   RESERVE_CARD      保留（附赠 1 颗大师球，上限 3 张）
 *   EVOLVE            进化：免费，不消耗行动，每回合 1 次
 */

/* -------------------------------------------------------------------------- */
/* Card helpers                                                               */
/* -------------------------------------------------------------------------- */

interface CardMeta {
  id: string;
  name: string;
  vp: number;
  bonus: string | null;
  bonusCount: number;
  cost: Record<string, number>;
  evolvesTo: string | null;
  evoCost: { color: string; count: number } | null;
  requiresMasterBall: boolean;
}

function cardMeta(entity: Entity): CardMeta {
  const custom = entity.components.custom ?? {};
  const face = entity.components.cardFace;
  const evoCost = custom.evoCost as { color?: unknown; count?: unknown } | null | undefined;
  return {
    id: entity.id,
    name: String(custom.name ?? face?.title ?? entity.id),
    vp: Number(custom.vp ?? face?.score ?? 0),
    bonus: typeof custom.bonus === 'string' && custom.bonus !== 'none' ? custom.bonus : null,
    bonusCount: Number(custom.bonusCount ?? 1),
    cost: (custom.cost ?? face?.cost ?? {}) as Record<string, number>,
    evolvesTo: typeof custom.evolvesTo === 'string' ? custom.evolvesTo : null,
    evoCost:
      evoCost && typeof evoCost.color === 'string' && typeof evoCost.count === 'number'
        ? { color: evoCost.color, count: evoCost.count }
        : null,
    requiresMasterBall: custom.requiresMasterBall === true
  };
}

function emptyGems(): Record<string, number> {
  const gems: Record<string, number> = {};
  for (const color of POKEBALL_COLORS) gems[color] = 0;
  return gems;
}

function gemBag(source: Record<string, number> | undefined): Record<string, number> {
  const gems = emptyGems();
  for (const color of POKEBALL_COLORS) gems[color] = Math.max(0, Math.floor(Number(source?.[color] ?? 0)));
  return gems;
}

/** Ball tokens currently held (master balls included — they count to the cap). */
function tokenTotal(tokens: Record<string, number>): number {
  return POKEBALL_COLORS.reduce((sum, color) => sum + Math.max(0, Number(tokens[color] ?? 0)), 0);
}

/**
 * Payment plan for one card.
 *
 * Card bonuses discount their own colour. Master balls (purple) are the wild
 * substitute — but a card whose printed cost lists purple (rare / legendary /
 * mega) can only be caught by actually handing master balls over, so that
 * portion is reserved before any substitution happens.
 *
 * Returns `null` when the player cannot pay.
 */
function paymentPlan(
  cost: Record<string, number>,
  tokens: Record<string, number>,
  bonuses: Record<string, number>
): { tokens: Record<string, number>; masterBallsPaid: number } | null {
  const requiredMaster = Math.max(0, Math.floor(Number(cost[MASTER_BALL] ?? 0)));
  const heldMaster = Math.max(0, Number(tokens[MASTER_BALL] ?? 0));
  if (heldMaster < requiredMaster) return null;

  let masterUsed = requiredMaster;
  const paid = gemBag(tokens);

  for (const color of TOKEN_COLORS) {
    const raw = Math.max(0, Math.floor(Number(cost[color] ?? 0)));
    const discount = Math.max(0, Math.floor(Number(bonuses[color] ?? 0)));
    const net = Math.max(0, raw - discount);
    const used = Math.min(paid[color], net);
    paid[color] -= used;

    let short = net - used;
    if (short > 0) {
      const wild = Math.min(heldMaster - masterUsed, short);
      masterUsed += wild;
      short -= wild;
    }
    if (short > 0) return null;
  }

  paid[MASTER_BALL] = heldMaster - masterUsed;
  return { tokens: paid, masterBallsPaid: masterUsed };
}

/** Market row → the deck that refills it. Rare / legendary rows have their own piles. */
const ROW_SOURCE: Record<string, { deckZoneId: string; marketZoneId: string }> = {};
for (const tier of SPLENDOR_TIERS) {
  ROW_SOURCE[SPLENDOR_ZONES.market(tier)] = {
    deckZoneId: SPLENDOR_ZONES.deck(tier),
    marketZoneId: SPLENDOR_ZONES.market(tier)
  };
}
ROW_SOURCE[SPLENDOR_ZONES.rare] = {
  deckZoneId: SPLENDOR_ZONES.rareDeck,
  marketZoneId: SPLENDOR_ZONES.rare
};
ROW_SOURCE[SPLENDOR_ZONES.legend] = {
  deckZoneId: SPLENDOR_ZONES.legendDeck,
  marketZoneId: SPLENDOR_ZONES.legend
};

/** Public rows a card may be caught from (plus the player's own reserve). */
function isPublicRow(zoneId: string): boolean {
  return !!ROW_SOURCE[zoneId];
}

/** Rows that accept a reservation — rare / legendary Pokémon cannot be reserved. */
function isReservableRow(zoneId: string): boolean {
  return SPLENDOR_TIERS.some(tier => zoneId === SPLENDOR_ZONES.market(tier));
}

/** Zones an evolution target may be taken from (market rows or own reserve). */
function isEvolutionSource(state: GameState, zoneId: string, playerId: PlayerId): boolean {
  return isPublicRow(zoneId) || zoneId === SPLENDOR_ZONES.hand(playerId);
}

/** Refill a market row after a card left it. An empty deck leaves the row short. */
function refillRow(state: GameState, marketZoneId: string): GameState {
  const source = ROW_SOURCE[marketZoneId];
  if (!source) return state;
  const deck = state.zones[source.deckZoneId];
  if (!deck || deck.orderedEntities.length === 0) return state;
  return dealTopCard(state, source.deckZoneId, source.marketZoneId);
}

function withVisibility(state: GameState, entityId: string, visibility: Entity['visibility']): GameState {
  const entity = state.entities[entityId];
  if (!entity) return state;
  return { ...state, entities: { ...state.entities, [entityId]: { ...entity, visibility } } };
}

function zoneIds(state: GameState, zoneId: string): string[] {
  return state.zones[zoneId]?.orderedEntities ?? [];
}

/**
 * Derive score + permanent bonuses from the tableau.
 *
 * Evolution buries cards and swaps in a stronger one, so the totals are
 * recomputed from the field instead of being patched incrementally — that keeps
 * "buried cards no longer score or grant a bonus" true by construction.
 */
function settleTableau(
  state: GameState,
  playerId: PlayerId
): { score: number; bonuses: Record<string, number>; cardIds: string[] } {
  const bonuses = emptyGems();
  const cardIds: string[] = [];
  let score = 0;

  for (const id of zoneIds(state, SPLENDOR_ZONES.tableau(playerId))) {
    const entity = state.entities[id];
    if (!entity) continue;
    const meta = cardMeta(entity);
    score += meta.vp;
    cardIds.push(id);
    if (meta.bonus) bonuses[meta.bonus] = (bonuses[meta.bonus] ?? 0) + meta.bonusCount;
  }
  // Master balls never act as a permanent bonus.
  bonuses[MASTER_BALL] = 0;

  return { score, bonuses, cardIds };
}

/** Recompute and store score / bonuses for one player. */
function applySettlement(state: GameState, playerId: PlayerId): GameState {
  const player = state.players[playerId];
  if (!player) return state;
  const settled = settleTableau(state, playerId);
  return {
    ...state,
    players: {
      ...state.players,
      [playerId]: {
        ...player,
        score: settled.score,
        customProps: {
          ...player.customProps,
          bonuses: settled.bonuses,
          purchasedCards: settled.cardIds
        }
      }
    }
  };
}

function withPlayer(state: GameState, playerId: PlayerId, patch: Record<string, unknown>): GameState {
  const player = state.players[playerId];
  if (!player) return state;
  return {
    ...state,
    players: {
      ...state.players,
      [playerId]: { ...player, customProps: { ...player.customProps, ...patch } }
    }
  };
}

function withGlobal(state: GameState, patch: Record<string, unknown>): GameState {
  return { ...state, globalVars: { ...state.globalVars, ...patch } };
}

/** All `size`-element subsets of `items`, in a deterministic order. */
function combinations<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0 || size > items.length) return [];
  if (size === 1) return items.map(item => [item]);
  const out: T[][] = [];
  for (let i = 0; i <= items.length - size; i++) {
    for (const tail of combinations(items.slice(i + 1), size - 1)) {
      out.push([items[i], ...tail]);
    }
  }
  return out;
}

export const COLOR_LABELS: Record<string, string> = {
  red: '红球',
  blue: '蓝球',
  black: '黑球',
  pink: '粉球',
  yellow: '黄球',
  purple: '大师球'
};

function labelOf(color: string): string {
  return COLOR_LABELS[color] ?? color;
}

/* -------------------------------------------------------------------------- */
/* Rules                                                                      */
/* -------------------------------------------------------------------------- */

export class SplendorRules {
  /* ------------------------------------------------------------------ */
  /* Legality                                                            */
  /* ------------------------------------------------------------------ */

  public static getLegalActions(state: GameState, playerId: PlayerId): Action[] {
    if (state.gameOver) return [];
    if (state.activePlayerId !== playerId) return [];
    const player = state.players[playerId];
    if (!player) return [];

    const tokens = gemBag(player.customProps.tokens);
    const bonuses = gemBag(player.customProps.bonuses);
    const bank = gemBag(state.globalVars.bank);
    const held = tokenTotal(tokens);
    const actions: Action[] = [];

    /* 1 · taking balls -------------------------------------------------- */
    //
    // 3 different colours is the norm; fewer only when the bank cannot cover
    // three colours, or when the 10-ball cap leaves room for less.
    const available = TOKEN_COLORS.filter(color => bank[color] > 0);
    const wanted = Math.min(3, available.length);
    const sizes: number[] = [];
    for (let size = wanted; size >= 1; size--) {
      if (held + size <= MAX_TOKENS) {
        sizes.push(size);
        break;
      }
    }
    for (const size of sizes) {
      for (const combo of combinations(available, size)) {
        actions.push({ type: 'TAKE_3_DIFF_GEMS', playerId, payload: { gems: combo } });
      }
    }

    for (const color of TOKEN_COLORS) {
      if (bank[color] >= 4 && held + 2 <= MAX_TOKENS) {
        actions.push({ type: 'TAKE_2_SAME_GEMS', playerId, payload: { gem: color } });
      }
    }

    /* 2 · catching cards ------------------------------------------------ */
    for (const [zoneId] of Object.entries(ROW_SOURCE)) {
      for (const card of ECSManager.getEntitiesInZone(state, zoneId)) {
        const meta = cardMeta(card);
        if (!paymentPlan(meta.cost, tokens, bonuses)) continue;
        actions.push({ type: 'BUY_CARD', playerId, entityId: card.id });
      }
    }
    for (const card of ECSManager.getEntitiesInZone(state, SPLENDOR_ZONES.hand(playerId))) {
      const meta = cardMeta(card);
      if (!paymentPlan(meta.cost, tokens, bonuses)) continue;
      actions.push({ type: 'BUY_CARD', playerId, entityId: card.id });
    }

    /* 3 · reserving ----------------------------------------------------- */
    if (zoneIds(state, SPLENDOR_ZONES.hand(playerId)).length < MAX_RESERVES) {
      for (const tier of SPLENDOR_TIERS) {
        const marketZoneId = SPLENDOR_ZONES.market(tier);
        for (const card of ECSManager.getEntitiesInZone(state, marketZoneId)) {
          actions.push({ type: 'RESERVE_CARD', playerId, entityId: card.id });
        }
        // Blind draw from the top of the level deck.
        if (zoneIds(state, SPLENDOR_ZONES.deck(tier)).length > 0) {
          actions.push({ type: 'RESERVE_CARD', playerId, payload: { fromTier: tier } });
        }
      }
    }

    /* 4 · evolution (free, once per turn) -------------------------------- */
    if (!state.globalVars.evolvedThisTurn) {
      for (const evolution of SplendorRules.evolutionOptions(state, playerId)) {
        actions.push({ type: 'EVOLVE', playerId, payload: evolution });
      }
    }

    /* 5 · deadlock escape ------------------------------------------------- */
    //
    // A player can genuinely run out of options: 10 balls in hand (so nothing
    // may be taken), 3 reserves, and no card they can pay for. Splendor has no
    // pass, but a table with no legal move would freeze forever, so the turn
    // may be handed over — and only then, never as a shortcut.
    if (actions.length === 0) {
      actions.push({ type: 'END_TURN', playerId });
    }

    return actions;
  }

  /**
   * Every legal `{fromId, toId}` evolution for a player.
   *
   * Requires: a base Pokémon on the field, its evolution card sitting in a
   * central row or in this player's reserve, and this player's bonus count in
   * the evolution colour at least `evoCost.count`.
   */
  public static evolutionOptions(state: GameState, playerId: PlayerId): { fromId: string; toId: string }[] {
    const player = state.players[playerId];
    if (!player) return [];
    const bonuses = gemBag(player.customProps.bonuses);
    const options: { fromId: string; toId: string }[] = [];

    for (const fromId of zoneIds(state, SPLENDOR_ZONES.tableau(playerId))) {
      const from = state.entities[fromId];
      if (!from) continue;
      const fromMeta = cardMeta(from);
      if (!fromMeta.evolvesTo || !fromMeta.evoCost) continue;
      if (bonuses[fromMeta.evoCost.color] < fromMeta.evoCost.count) continue;

      for (const zoneId of [
        SPLENDOR_ZONES.market(1),
        SPLENDOR_ZONES.market(2),
        SPLENDOR_ZONES.market(3),
        SPLENDOR_ZONES.hand(playerId)
      ]) {
        if (!isEvolutionSource(state, zoneId, playerId)) continue;
        for (const target of ECSManager.getEntitiesInZone(state, zoneId)) {
          if (cardMeta(target).name !== fromMeta.evolvesTo) continue;
          options.push({ fromId, toId: target.id });
        }
      }
    }
    return options;
  }

  /* ------------------------------------------------------------------ */
  /* Reduce                                                              */
  /* ------------------------------------------------------------------ */

  public static applyAction(state: GameState, action: Action, ctx: ReduceContext): GameState {
    switch (action.type) {
      case 'TAKE_3_DIFF_GEMS':
        return SplendorRules.takeDifferent(state, action, ctx);
      case 'TAKE_2_SAME_GEMS':
        return SplendorRules.takeSame(state, action, ctx);
      case 'BUY_CARD':
        return SplendorRules.buyCard(state, action, ctx);
      case 'RESERVE_CARD':
        return SplendorRules.reserveCard(state, action, ctx);
      case 'EVOLVE':
        return SplendorRules.evolve(state, action, ctx);
      case 'END_TURN':
        return SplendorRules.endTurn(state, action, ctx);
      default:
        return state;
    }
  }

  /** Deadlock escape: hand the turn over without acting (see `getLegalActions`). */
  private static endTurn(state: GameState, action: Action, ctx: ReduceContext): GameState {
    const player = state.players[action.playerId];
    if (!player) return state;
    return SplendorRules.advanceTurn(state, action.playerId, ctx);
  }

  /* ---- taking balls -------------------------------------------------- */

  private static takeDifferent(state: GameState, action: Action, ctx: ReduceContext): GameState {
    const pId = action.playerId;
    const player = state.players[pId];
    if (!player) return state;

    const raw = action.payload?.gems;
    if (!Array.isArray(raw)) return state;
    const gems = raw.filter((gem): gem is string => typeof gem === 'string');
    // 1–3 distinct colours, master balls are reserved for reserving.
    if (gems.length < 1 || gems.length > 3) return state;
    if (new Set(gems).size !== gems.length) return state;
    if (gems.some(gem => !TOKEN_COLORS.includes(gem as never))) return state;

    const tokens = gemBag(player.customProps.tokens);
    const bank = gemBag(state.globalVars.bank);
    if (gems.some(gem => bank[gem] < 1)) return state;
    if (tokenTotal(tokens) + gems.length > MAX_TOKENS) return state;

    for (const gem of gems) {
      bank[gem] -= 1;
      tokens[gem] += 1;
    }

    let next = withPlayer(state, pId, { tokens });
    next = withGlobal(next, { bank });

    ctx.trace({
      id: `take_3_${ctx.id('g')}`,
      type: 'TOKEN_TRANSFER',
      title: `${player.name} 收服 ${gems.length} 颗精灵球：${gems.map(labelOf).join(' / ')}`,
      durationMs: 400
    });

    return SplendorRules.advanceTurn(next, pId, ctx);
  }

  private static takeSame(state: GameState, action: Action, ctx: ReduceContext): GameState {
    const pId = action.playerId;
    const player = state.players[pId];
    if (!player) return state;

    const gem = action.payload?.gem;
    if (typeof gem !== 'string' || !TOKEN_COLORS.includes(gem as never)) return state;

    const bank = gemBag(state.globalVars.bank);
    if (bank[gem] < 4) return state;

    const tokens = gemBag(player.customProps.tokens);
    if (tokenTotal(tokens) + 2 > MAX_TOKENS) return state;

    bank[gem] -= 2;
    tokens[gem] += 2;

    let next = withPlayer(state, pId, { tokens });
    next = withGlobal(next, { bank });

    ctx.trace({
      id: `take_2_${ctx.id('g')}`,
      type: 'TOKEN_TRANSFER',
      title: `${player.name} 收服 2 颗精灵球：${labelOf(gem)} ×2`,
      durationMs: 400
    });

    return SplendorRules.advanceTurn(next, pId, ctx);
  }

  /* ---- catching cards ------------------------------------------------ */

  private static buyCard(state: GameState, action: Action, ctx: ReduceContext): GameState {
    const pId = action.playerId;
    const player = state.players[pId];
    const cardId = action.entityId;
    if (!player || !cardId) return state;

    const card = state.entities[cardId];
    if (!card) return state;
    const fromZone = card.zoneId;
    if (!isPublicRow(fromZone) && fromZone !== SPLENDOR_ZONES.hand(pId)) return state;

    const meta = cardMeta(card);
    const tokens = gemBag(player.customProps.tokens);
    const bonuses = gemBag(player.customProps.bonuses);
    const plan = paymentPlan(meta.cost, tokens, bonuses);
    if (!plan) return state;

    const bank = gemBag(state.globalVars.bank);
    for (const color of POKEBALL_COLORS) {
      const spent = tokens[color] - plan.tokens[color];
      if (spent > 0) bank[color] += spent;
    }

    let next = withPlayer(state, pId, { tokens: plan.tokens });
    next = withGlobal(next, { bank });
    next = withVisibility(next, cardId, { type: 'PUBLIC' });
    next = ECSManager.moveEntity(next, cardId, SPLENDOR_ZONES.tableau(pId));
    next = applySettlement(next, pId);
    next = refillRow(next, fromZone);

    ctx.trace({
      id: `buy_${ctx.id('g')}`,
      type: 'BUILD_OBJECT',
      title:
        `${player.name} 捕捉了 [${meta.name}]（+${meta.vp} VP` +
        `${meta.bonus ? ` · +${meta.bonusCount} ${labelOf(meta.bonus)}加成` : ''}）` +
        `${plan.masterBallsPaid > 0 ? ` · 支付 ${plan.masterBallsPaid} 大师球` : ''}`,
      durationMs: 500
    });

    next = SplendorRules.markLastRound(next, ctx);
    return SplendorRules.advanceTurn(next, pId, ctx);
  }

  /* ---- reserving ----------------------------------------------------- */

  private static reserveCard(state: GameState, action: Action, ctx: ReduceContext): GameState {
    const pId = action.playerId;
    const player = state.players[pId];
    if (!player) return state;

    const handZoneId = SPLENDOR_ZONES.hand(pId);
    if (zoneIds(state, handZoneId).length >= MAX_RESERVES) return state;

    let cardId: string | null = null;
    let fromRow: string | null = null;

    if (typeof action.entityId === 'string' && action.entityId) {
      const card = state.entities[action.entityId];
      if (!card) return state;
      // Rare / legendary Pokémon can only be caught on the spot — never reserved.
      if (!isReservableRow(card.zoneId)) return state;
      cardId = card.id;
      fromRow = card.zoneId;
    } else {
      const tier = Number(action.payload?.fromTier);
      if (!SPLENDOR_TIERS.includes(tier as SplendorTier)) return state;
      const deck = state.zones[SPLENDOR_ZONES.deck(tier as SplendorTier)];
      if (!deck || deck.orderedEntities.length === 0) return state;
      cardId = deck.orderedEntities[0];
      fromRow = null; // blind draw: the market row keeps its card
    }

    const card = state.entities[cardId];
    if (!card) return state;
    const meta = cardMeta(card);

    let next = withVisibility(state, cardId, { type: 'OWNER_ONLY', ownerId: pId });
    next = ECSManager.moveEntity(next, cardId, handZoneId);

    // Reserving always hands over one master ball, if the bank still has one
    // and the 10-ball cap leaves room for it.
    const tokens = gemBag(player.customProps.tokens);
    const bank = gemBag(next.globalVars.bank);
    let gainedMasterBall = false;
    if (bank[MASTER_BALL] > 0 && tokenTotal(tokens) < MAX_TOKENS) {
      bank[MASTER_BALL] -= 1;
      tokens[MASTER_BALL] += 1;
      gainedMasterBall = true;
    }

    next = withPlayer(next, pId, { tokens });
    next = withGlobal(next, { bank });
    if (fromRow) next = refillRow(next, fromRow);

    ctx.trace({
      id: `reserve_${ctx.id('g')}`,
      type: 'CARD_DRAW',
      title: `${player.name} 保留了 [${meta.name}]${gainedMasterBall ? '，并获得 1 颗大师球' : ''}`,
      durationMs: 400
    });

    return SplendorRules.advanceTurn(next, pId, ctx);
  }

  /* ---- evolution (free action) --------------------------------------- */

  private static evolve(state: GameState, action: Action, ctx: ReduceContext): GameState {
    const pId = action.playerId;
    if (!state.players[pId]) return state;

    const fromId = action.payload?.fromId;
    const toId = action.payload?.toId;
    if (typeof fromId !== 'string' || typeof toId !== 'string') return state;
    if (!SplendorRules.canEvolve(state, pId, fromId, toId)) return state;

    let next = SplendorRules.resolveEvolution(state, pId, fromId, toId, ctx);
    // Evolution is a free action: the turn and the action budget are untouched.
    next = SplendorRules.markLastRound(next, ctx);
    return next;
  }

  private static canEvolve(state: GameState, playerId: PlayerId, fromId: string, toId: string): boolean {
    if (state.globalVars.evolvedThisTurn) return false;
    const player = state.players[playerId];
    if (!player) return false;

    const from = state.entities[fromId];
    const to = state.entities[toId];
    if (!from || !to) return false;
    if (from.zoneId !== SPLENDOR_ZONES.tableau(playerId)) return false;
    if (!isEvolutionSource(state, to.zoneId, playerId)) return false;

    const fromMeta = cardMeta(from);
    if (!fromMeta.evolvesTo || !fromMeta.evoCost) return false;
    if (fromMeta.evolvesTo !== cardMeta(to).name) return false;

    // Evolution is paid with permanent card bonuses only — never with balls.
    const bonuses = gemBag(player.customProps.bonuses);
    return bonuses[fromMeta.evoCost.color] >= fromMeta.evoCost.count;
  }

  /**
   * Apply one evolution: the base Pokémon is buried (it stops scoring and stops
   * granting a bonus), the evolution takes its place on the field with its own
   * VP + bonus.
   */
  private static resolveEvolution(
    state: GameState,
    playerId: PlayerId,
    fromId: string,
    toId: string,
    ctx: ReduceContext
  ): GameState {
    const player = state.players[playerId];
    if (!player) return state;
    const fromMeta = cardMeta(state.entities[fromId]);
    const toMeta = cardMeta(state.entities[toId]);

    const buriedIds: string[] = [...(player.customProps.buriedIds ?? []), fromId];
    // The evolution card leaves the market row (or the reserve) behind.
    const fromRow = state.entities[toId]?.zoneId ?? null;

    let next = withVisibility(state, fromId, { type: 'PUBLIC' });
    next = ECSManager.moveEntity(next, fromId, SPLENDOR_ZONES.buried(playerId));
    next = withVisibility(next, toId, { type: 'PUBLIC' });
    next = ECSManager.moveEntity(next, toId, SPLENDOR_ZONES.tableau(playerId));
    if (fromRow) next = refillRow(next, fromRow);

    next = applySettlement(next, playerId);
    next = withPlayer(next, playerId, { buriedIds });
    next = withGlobal(next, { evolvedThisTurn: true });

    ctx.trace({
      id: `evolve_${ctx.id('g')}`,
      type: 'ANNOUNCEMENT',
      title:
        `✨ ${player.name} 的 [${fromMeta.name}] 进化为 [${toMeta.name}]` +
        `（+${toMeta.vp} VP · 免费，不消耗行动）`,
      durationMs: 800
    });

    return next;
  }

  /* ------------------------------------------------------------------ */
  /* Turn bookkeeping                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Close the current player's turn.
   *
   * Before the seat passes, a forced (unique) evolution is settled automatically:
   * that is the "回合结束自动结算" half of the evolution rule — the action is
   * optional, but when there is exactly one evolution available there is no
   * choice to make, so it resolves for free.
   */
  private static advanceTurn(state: GameState, currentPId: PlayerId, ctx: ReduceContext): GameState {
    let next = SplendorRules.settleEndOfTurnEvolution(state, currentPId, ctx);

    const order = next.playerOrder;
    const currentIdx = order.indexOf(currentPId);
    const nextIdx = (currentIdx + 1) % order.length;

    const globalVars: Record<string, any> = { ...next.globalVars, evolvedThisTurn: false };
    let round = next.round;
    if (nextIdx === 0) {
      round += 1;
      // The final round ends once play returns to the starting seat.
      if (globalVars.lastRound) globalVars.finalRoundComplete = true;
    }

    next = {
      ...next,
      round,
      turn: next.turn + 1,
      activePlayerId: order[nextIdx],
      globalVars
    };

    ctx.trace({
      id: `turn_splendor_${ctx.id('g')}`,
      type: 'ANNOUNCEMENT',
      title: `轮到 ${next.players[order[nextIdx]]?.name ?? order[nextIdx]}`,
      durationMs: 300
    });

    return next;
  }

  /**
   * Auto-resolve the end-of-turn evolution.
   *
   * Evolution never costs the player anything (it is paid with bonuses that are
   * already on the table and strictly raises VP), so leaving it unplayed can
   * only be an oversight. There is no choice left to make once the tie is broken
   * deterministically: highest evolution VP first, then the lowest card id.
   */
  private static settleEndOfTurnEvolution(state: GameState, playerId: PlayerId, ctx: ReduceContext): GameState {
    if (state.globalVars.evolvedThisTurn) return state;
    const options = SplendorRules.evolutionOptions(state, playerId);
    if (options.length === 0) return state;

    const ranked = options
      .map(option => ({ option, vp: Number(state.entities[option.toId]?.components.custom?.vp ?? 0) }))
      .sort((a, b) => b.vp - a.vp || (a.option.toId < b.option.toId ? -1 : a.option.toId > b.option.toId ? 1 : 0));

    const { fromId, toId } = ranked[0].option;
    if (!SplendorRules.canEvolve(state, playerId, fromId, toId)) return state;
    return SplendorRules.resolveEvolution(state, playerId, fromId, toId, ctx);
  }

  /** First player to reach the score goal triggers the final round. */
  private static markLastRound(state: GameState, ctx: ReduceContext): GameState {
    if (state.globalVars.lastRound) return state;
    const target = Number(state.globalVars.scoreToWin ?? WIN_SCORE);
    const reached = Object.values(state.players).some(player => player.score >= target);
    if (!reached) return state;

    ctx.trace({
      id: `last_round_${ctx.id('g')}`,
      type: 'ANNOUNCEMENT',
      title: `🏁 有人达到 ${target} 分 — 本轮结束后结算`,
      durationMs: 900
    });

    return withGlobal(state, { lastRound: true });
  }

  /* ------------------------------------------------------------------ */
  /* Outcome                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Highest score wins; ties break on buried Pokémon, then on cards in play.
   * The game only ends once the final round has been played out.
   */
  public static checkWinCondition(
    state: GameState
  ): { gameOver: boolean; winner: PlayerId | null; reason?: string } {
    if (!state.globalVars.finalRoundComplete) return { gameOver: false, winner: null };

    const ranking = state.playerOrder.map(pid => {
      const player = state.players[pid];
      return {
        pid,
        score: player?.score ?? 0,
        buried: (player?.customProps.buriedIds ?? []).length,
        fielded: zoneIds(state, SPLENDOR_ZONES.tableau(pid)).length
      };
    });
    ranking.sort((a, b) => b.score - a.score || b.buried - a.buried || b.fielded - a.fielded);

    const best = ranking[0];
    if (!best) return { gameOver: true, winner: null, reason: '牌桌已清空' };

    return {
      gameOver: true,
      winner: best.pid,
      reason:
        `🏆 ${state.players[best.pid]?.name ?? best.pid} 以 ${best.score} 分获胜` +
        `（埋没 ${best.buried} · 场上 ${best.fielded}）`
    };
  }
}
