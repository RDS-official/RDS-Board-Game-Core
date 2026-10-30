import { ECSManager } from '@rds/kernel/ecs';
import { ReduceContext } from '@rds/kernel/module';
import { Action, Entity, GameState, Player, PlayerId } from '@rds/kernel/types';
import {
  dealTopCard,
  MASTER_BALL,
  MAX_MEGA_TOKENS_PER_PLAYER,
  MAX_RESERVES,
  MAX_TOKENS,
  MEGA_WIN_SCORE,
  POKEBALL_COLORS,
  POKEMART_TIERS,
  PokemartTier,
  SPLENDOR_TIERS,
  SPLENDOR_ZONES,
  SplendorTier,
  SplendorVariant,
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
 *   BUY_CARD          捕捉市场 / 保留区的宝可梦（Poké Mart 卡可带 captureOpts）
 *   RESERVE_CARD      保留（附赠 1 颗大师球，上限 3 张）
 *   EVOLVE            进化：免费，不消耗行动，每回合 1 次
 *   TAKE_MEGA_TOKEN   拿取 Mega 代币（消耗整个行动）
 *   MEGA_EVOLVE       超级进化：消耗代币 + 支付 Mega 卡成本，每回合 1 次
 *
 * Expansion rule sets are gated on `globalVars.variant`, which setup persists so
 * a replay always agrees with the table that was dealt.
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
  /** `stage1` … `stage3`, `rare`, `legend`, `mega`, `pmL1` … `pmL3`. */
  tier: string;
  /** Base level (1–3) the card belongs to; 0 for rare / legendary / Mega / unknown. */
  baseTier: number;
  /** Poké Mart effect code, or null for a plain Pokémon card. */
  effect: string | null;
  effectParam: Record<string, unknown> | null;
  /** The base Pokémon a Mega card super-evolves from. */
  megaFrom: string | null;
}

const EMPTY_META: CardMeta = {
  id: '',
  name: '',
  vp: 0,
  bonus: null,
  bonusCount: 1,
  cost: {},
  evolvesTo: null,
  evoCost: null,
  requiresMasterBall: false,
  tier: '',
  baseTier: 0,
  effect: null,
  effectParam: null,
  megaFrom: null
};

function cardMeta(entity: Entity | undefined): CardMeta {
  if (!entity) return EMPTY_META;
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
    requiresMasterBall: custom.requiresMasterBall === true,
    tier: typeof custom.pkmnTier === 'string' ? custom.pkmnTier : '',
    baseTier: Number(custom.baseTier ?? 0) || 0,
    effect: typeof custom.effect === 'string' && custom.effect ? custom.effect : null,
    effectParam: (custom.effectParam as Record<string, unknown> | null | undefined) ?? null,
    megaFrom: typeof custom.megaFrom === 'string' && custom.megaFrom ? custom.megaFrom : null
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
 * `virtualMaster` adds that many master-ball-equivalents which are *not* tokens
 * (a Poké Mart POKÉDEX card is worth 2 when discarded). Virtual balls are spent
 * first and any leftover is wasted, so they never reduce the real master bill
 * for a card that prints a purple cost... they do: the caller discards the
 * physical card when the payment succeeds.
 *
 * Returns `null` when the player cannot pay.
 */
function paymentPlan(
  cost: Record<string, number>,
  tokens: Record<string, number>,
  bonuses: Record<string, number>,
  virtualMaster = 0
): { tokens: Record<string, number>; masterBallsPaid: number; virtualMasterUsed: number } | null {
  const requiredMaster = Math.max(0, Math.floor(Number(cost[MASTER_BALL] ?? 0)));
  const heldMaster = Math.max(0, Number(tokens[MASTER_BALL] ?? 0));
  const virtual = Math.max(0, Math.floor(virtualMaster));
  if (heldMaster + virtual < requiredMaster) return null;

  // Master balls (real + virtual) available for wild substitution.
  const masterBudget = heldMaster + virtual;
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
      const wild = Math.min(masterBudget - masterUsed, short);
      masterUsed += wild;
      short -= wild;
    }
    if (short > 0) return null;
  }

  // Spend virtual (free) masters first: they are consumed either way.
  const virtualMasterUsed = Math.min(virtual, masterUsed);
  const realMasterUsed = masterUsed - virtualMasterUsed;
  paid[MASTER_BALL] = heldMaster - realMasterUsed;
  return { tokens: paid, masterBallsPaid: realMasterUsed, virtualMasterUsed };
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
// Poké Mart rows refill from their own per-level deck.
for (const martTier of POKEMART_TIERS) {
  ROW_SOURCE[SPLENDOR_ZONES.pokemart(martTier)] = {
    deckZoneId: SPLENDOR_ZONES.pokemartDeckOf(martTier),
    marketZoneId: SPLENDOR_ZONES.pokemart(martTier)
  };
}

/* -------------------------------------------------------------------------- */
/* Variant helpers                                                            */
/* -------------------------------------------------------------------------- */

/** The rule set this position was dealt under (persisted by setup). */
function variantOf(state: GameState): SplendorVariant {
  const raw = state.globalVars.variant as Partial<SplendorVariant> | undefined;
  return {
    mega: raw?.mega === true,
    pokemart: raw?.pokemart === true
  };
}

function megaEnabled(state: GameState): boolean {
  return variantOf(state).mega;
}

function pokemartEnabled(state: GameState): boolean {
  return variantOf(state).pokemart;
}

/** Is this card a Poké Mart card (as opposed to a Pokémon)? */
function isMartCard(meta: CardMeta): boolean {
  return (POKEMART_TIERS as readonly string[]).includes(meta.tier);
}

/**
 * The bonus colour a card actually contributes for its owner.
 *
 * Poké Mart `copy` / `copy_free` cards carry no printed colour; they borrow the
 * colour of the card they were associated with at capture time (`assoc`). A card
 * with neither a printed colour nor an association (POKÉDEX, an unassociated
 * copy card) contributes nothing at all.
 */
function effectiveBonusColor(meta: CardMeta, assoc: Record<string, string> | undefined): string | null {
  const borrowed = assoc?.[meta.id];
  const color = borrowed ?? meta.bonus;
  if (!color || !TOKEN_COLORS.includes(color as never)) return null;
  return color;
}

/** Public rows a card may be caught from (plus the player's own reserve). */
function isPublicRow(zoneId: string): boolean {
  return !!ROW_SOURCE[zoneId];
}

/** Rows that accept a reservation — rare / legendary Pokémon cannot be reserved. */
function isReservableRow(zoneId: string): boolean {
  return (
    SPLENDOR_TIERS.some(tier => zoneId === SPLENDOR_ZONES.market(tier)) ||
    POKEMART_TIERS.some(tier => zoneId === SPLENDOR_ZONES.pokemart(tier))
  );
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
  const assoc = (state.players[playerId]?.customProps.assoc ?? {}) as Record<string, string>;
  let score = 0;

  for (const id of zoneIds(state, SPLENDOR_ZONES.tableau(playerId))) {
    const entity = state.entities[id];
    if (!entity) continue;
    const meta = cardMeta(entity);
    score += meta.vp;
    cardIds.push(id);
    // A `copy` card contributes the colour it borrowed; a colourless card
    // (POKÉDEX, or an unassociated copy card) contributes nothing.
    const color = effectiveBonusColor(meta, assoc);
    if (color) bonuses[color] = (bonuses[color] ?? 0) + meta.bonusCount;
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
/* Poké Mart helpers                                                          */
/* -------------------------------------------------------------------------- */

/** Zones a Poké Mart `free` / `copy_free` card may take a free card from. */
function freeTakeTiers(parentMeta: CardMeta): string[] {
  // The card data names the level below (`pmL2_or_stage2`); fall back to the
  // level-derived rule when a card omits it.
  const declared = parentMeta.effectParam?.freeFromTier;
  if (typeof declared === 'string' && declared) {
    // `pmL2_or_stage2` names both a Poké Mart level and its base level, and the
    // card may come from either row — keep both tokens and de-duplicate.
    const tiers = declared
      .split('_or_')
      .map(part => part.trim())
      .filter((token, index, all) => {
        const known =
          token === 'stage1' || token === 'stage2' || token === 'stage3' ||
          token === 'pmL1' || token === 'pmL2' || token === 'pmL3';
        return known && all.indexOf(token) === index;
      });
    if (tiers.length > 0) return tiers;
  }
  if (parentMeta.tier === 'pmL2') return ['stage1', 'pmL1'];
  if (parentMeta.tier === 'pmL3') return ['stage2', 'pmL2'];
  return [];
}

/** Zone ids of every row a given tier tag may appear in (for free takes). */
function zonesForTierTag(tier: string): string[] {
  switch (tier) {
    case 'stage1':
      return [SPLENDOR_ZONES.market(1)];
    case 'stage2':
      return [SPLENDOR_ZONES.market(2)];
    case 'stage3':
      return [SPLENDOR_ZONES.market(3)];
    case 'pmL1':
      return [SPLENDOR_ZONES.pokemart('pmL1')];
    case 'pmL2':
      return [SPLENDOR_ZONES.pokemart('pmL2')];
    case 'pmL3':
      return [SPLENDOR_ZONES.pokemart('pmL3')];
    default:
      return [];
  }
}

/**
 * A board card that a Poké Mart `copy` / `copy_free` card can borrow a colour
 * from: it must be on the tableau and must actually contribute a colour.
 */
function copyCandidates(state: GameState, playerId: PlayerId): string[] {
  const assoc = (state.players[playerId]?.customProps.assoc ?? {}) as Record<string, string>;
  return zoneIds(state, SPLENDOR_ZONES.tableau(playerId)).filter(id => {
    const entity = state.entities[id];
    if (!entity) return false;
    return effectiveBonusColor(cardMeta(entity), assoc) !== null;
  });
}

/** Board cards of one colour — what a REPEL (`discard_buy`) may sacrifice. */
function discardCandidates(state: GameState, playerId: PlayerId, color: string): string[] {
  const assoc = (state.players[playerId]?.customProps.assoc ?? {}) as Record<string, string>;
  return zoneIds(state, SPLENDOR_ZONES.tableau(playerId)).filter(id => {
    const entity = state.entities[id];
    if (!entity) return false;
    return effectiveBonusColor(cardMeta(entity), assoc) === color;
  });
}

/** Board POKÉDEX cards — each is worth 2 virtual master balls when discarded. */
function pokedexCandidates(state: GameState, playerId: PlayerId): string[] {
  return zoneIds(state, SPLENDOR_ZONES.tableau(playerId)).filter(id => {
    const entity = state.entities[id];
    if (!entity) return false;
    const meta = cardMeta(entity);
    return isMartCard(meta) && meta.effect === 'colorless_master';
  });
}

/**
 * Validated `captureOpts` for one capture.
 *
 * `opts` is the wire payload (`payload.captureOpts`) and is untrusted: every
 * field is re-checked against the position before anything is applied. The
 * result carries the concrete cards to discard, the assoc colour to record and
 * the ordered list of free takes (already recursively planned).
 */
interface CaptureChoice {
  /** Board card the new `copy` card borrows its colour from (null when absent). */
  assocColor: string | null;
  /** POKÉDEX cards consumed as virtual master balls. */
  spendPokedex: string[];
  /** `discard_buy`: owned cards sacrificed instead of paying balls. */
  discardCards: string[];
  /** `free` / `copy_free`: the free cards taken, in order, with assoc colours. */
  freeSteps: { freeId: string; assoc: string | null }[];
}

function emptyChoice(): CaptureChoice {
  return { assocColor: null, spendPokedex: [], discardCards: [], freeSteps: [] };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringArray(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  return value.every(item => typeof item === 'string') ? (value as string[]) : null;
}

/**
 * Validate the free-take chain of a `free` / `copy_free` capture.
 *
 * The engine mirrors upstream: the free card comes from the level below, its own
 * effect resolves as well, and a chain may therefore nest. Recursion is bounded
 * by `depth` and by `seen` (a card can never be taken twice), so a loop in the
 * data can never hang a reducer.
 */
function planFreeTakes(
  state: GameState,
  playerId: PlayerId,
  parentMeta: CardMeta,
  opts: Record<string, unknown>,
  depth = 0,
  seen: Record<string, true> = {}
): { ok: true; steps: { freeId: string; assoc: string | null }[] } | { ok: false; error: string } {
  if (depth > 4) return { ok: false, error: '免费取卡层级过深' };
  const tiers = freeTakeTiers(parentMeta);
  if (tiers.length === 0) return { ok: true, steps: [] };

  const rawFreeId = opts.freeTakeId;
  if (rawFreeId === undefined || rawFreeId === null) {
    // A free take is mandatory while a legal card exists; otherwise it fizzles.
    const any = tiers.some(tier =>
      zonesForTierTag(tier).some(zoneId =>
        ECSManager.getEntitiesInZone(state, zoneId).some(card => freeTakeable(state, playerId, cardMeta(card)))
      )
    );
    return any ? { ok: false, error: '请选择要免费获得的卡（freeTakeId）' } : { ok: true, steps: [] };
  }
  if (typeof rawFreeId !== 'string') return { ok: false, error: '免费取卡参数无效' };
  const freeId = rawFreeId;
  if (seen[freeId]) return { ok: false, error: '免费取卡重复' };

  const entity = state.entities[freeId];
  if (!entity) return { ok: false, error: '免费卡不存在' };
  const freeMeta = cardMeta(entity);
  if (tiers.indexOf(freeMeta.tier) < 0) return { ok: false, error: '免费卡必须是可选等级中的面朝上卡' };
  if (!isPublicRow(entity.zoneId) || !zonesForTierTag(freeMeta.tier).includes(entity.zoneId)) {
    return { ok: false, error: '免费卡必须是可选等级中的面朝上卡' };
  }
  if (!freeTakeable(state, playerId, freeMeta)) return { ok: false, error: `免费卡「${freeMeta.name}」不可获得` };

  const sub = asRecord(opts.freeOpts) ?? {};
  let assoc: string | null = null;
  if (freeMeta.effect === 'copy' || freeMeta.effect === 'copy_free') {
    const resolved = resolveCopyTarget(state, playerId, sub.copyTargetId);
    if ('error' in resolved) return resolved;
    assoc = resolved.color;
  }

  let steps: { freeId: string; assoc: string | null }[] = [{ freeId, assoc }];
  if (freeMeta.effect === 'free' || freeMeta.effect === 'copy_free') {
    const nextSeen = { ...seen, [freeId]: true as const };
    const nested = planFreeTakes(state, playerId, freeMeta, sub, depth + 1, nextSeen);
    if ('error' in nested) return nested;
    steps = steps.concat(nested.steps);
  }
  return { ok: true, steps };
}

/**
 * Can `meta` actually be taken right now as a free card?
 *
 * `tiers` is the parent's resolved `freeTakeTiers`. A card is free only when it
 * actually sits in one of those rows: without the check a stone that takes
 * level-2 cards could also lift a level-3 one, which the printed cards forbid.
 */
function freeTakeable(
  state: GameState,
  playerId: PlayerId,
  meta: CardMeta,
  tiers?: readonly string[]
): boolean {
  if (tiers && tiers.length > 0) {
    const row = state.entities[meta.id]?.zoneId ?? '';
    if (!tiers.some(tier => zonesForTierTag(tier).includes(row))) return false;
  }
  if (!isMartCard(meta)) return true;
  // A `copy` card needs an owned colour to borrow; anything else resolves alone.
  if (meta.effect === 'copy' || meta.effect === 'copy_free') {
    return copyCandidates(state, playerId).length > 0;
  }
  return true;
}

/** Resolve an explicit (or defaulted) `copy` target into its borrowed colour. */
function resolveCopyTarget(
  state: GameState,
  playerId: PlayerId,
  rawTarget: unknown
): { color: string } | { ok: false; error: string } {
  const candidates = copyCandidates(state, playerId);
  if (candidates.length === 0) return { ok: false, error: '进化石需要你已有一张带奖励的卡' };
  const assoc = (state.players[playerId]?.customProps.assoc ?? {}) as Record<string, string>;
  const colorOf = (id: string): string => {
    const meta = cardMeta(state.entities[id]);
    return effectiveBonusColor(meta, assoc) ?? '';
  };
  if (rawTarget === undefined || rawTarget === null) return { color: colorOf(candidates[0]) };
  if (typeof rawTarget !== 'string') return { ok: false, error: '关联目标参数无效' };
  if (candidates.indexOf(rawTarget) < 0) {
    return { ok: false, error: '关联目标必须是你已有的带奖励的卡' };
  }
  return { color: colorOf(rawTarget) };
}

/** Validate a REPEL (`discard_buy`) choice: exactly `discardCount` cards of the colour. */
function resolveDiscardBuy(
  state: GameState,
  playerId: PlayerId,
  meta: CardMeta,
  rawChosen: unknown
): { ok: true; discarded: string[] } | { ok: false; error: string } {
  const param = meta.effectParam ?? {};
  const color = String(param.discardColor ?? '');
  const need = Math.max(1, Math.floor(Number(param.discardCount ?? 2)));
  const owned = color ? discardCandidates(state, playerId, color) : [];
  if (owned.length < need) {
    return {
      ok: false,
      error: `需要弃掉 ${need} 张${labelOf(color)}卡，但你只有 ${owned.length} 张`
    };
  }
  if (rawChosen === undefined || rawChosen === null) return { ok: true, discarded: owned.slice(0, need) };
  const chosen = stringArray(rawChosen);
  if (!chosen) return { ok: false, error: '弃牌选择必须是卡牌数组' };
  if (chosen.length === 0) return { ok: true, discarded: owned.slice(0, need) };
  if (chosen.length !== need) return { ok: false, error: `必须弃掉 ${need} 张` };
  if (new Set(chosen).size !== chosen.length) return { ok: false, error: '弃牌不能重复选择同一张卡' };
  for (const id of chosen) {
    if (owned.indexOf(id) < 0) return { ok: false, error: '所选弃牌颜色不符或不属于你' };
  }
  return { ok: true, discarded: chosen };
}

/** Validate `payload.captureOpts` against the position, before any mutation. */
function resolveCaptureChoice(
  state: GameState,
  playerId: PlayerId,
  meta: CardMeta,
  rawOpts: unknown
): { ok: true; choice: CaptureChoice } | { ok: false; error: string } {
  const provided = rawOpts === undefined || rawOpts === null ? {} : asRecord(rawOpts);
  if (!provided) return { ok: false, error: '捕捉参数无效' };
  // A missing choice means "engine picks": every field of `captureOpts` is
  // optional, so a caller (or a UI form that was submitted empty) still gets a
  // resolving capture instead of a silent no-op.
  const opts: Record<string, unknown> = needsCaptureChoice(meta)
    ? { ...defaultCaptureOpts(state, playerId, meta) }
    : {};
  for (const [key, value] of Object.entries(provided)) {
    if (value === undefined || value === null) continue;
    opts[key] = value;
  }
  const choice = emptyChoice();

  // POKÉDEX: each discarded card is worth 2 virtual master balls for this buy.
  const spend = stringArray(opts.spendPokedex);
  if (!spend) return { ok: false, error: '图鉴消耗必须是卡牌数组' };
  if (new Set(spend).size !== spend.length) return { ok: false, error: '图鉴不能重复消耗同一张卡' };
  const dex = pokedexCandidates(state, playerId);
  for (const id of spend) {
    if (dex.indexOf(id) < 0) return { ok: false, error: '无效的图鉴消耗' };
  }
  choice.spendPokedex = spend as string[];

  // copy / copy_free: borrow a colour from an owned card that already has one.
  if (meta.effect === 'copy' || meta.effect === 'copy_free') {
    const resolved = resolveCopyTarget(state, playerId, opts.copyTargetId);
    if ('error' in resolved) return { ok: false, error: resolved.error };
    choice.assocColor = resolved.color;
  }

  // discard_buy: pay with cards instead of balls.
  if (meta.effect === 'discard_buy') {
    const resolved = resolveDiscardBuy(state, playerId, meta, opts.discardCards);
    if ('error' in resolved) return { ok: false, error: resolved.error };
    choice.discardCards = resolved.discarded;
  }

  // free / copy_free: plan the whole (possibly recursive) free-take chain.
  if (meta.effect === 'free' || meta.effect === 'copy_free') {
    const planned = planFreeTakes(state, playerId, meta, opts, 0);
    if ('error' in planned) return { ok: false, error: planned.error };
    choice.freeSteps = planned.steps;
  }

  return { ok: true, choice };
}

/**
 * Score a face-up card for "which free card is best" so a bot (and the UI's
 * default choice) plays something reasonable without a search.
 */
function freeCardValue(meta: CardMeta): number {
  return meta.vp * 3 + meta.bonusCount * 2 + (meta.evolvesTo ? 1 : 0);
}

/** Every face-up card a `free` / `copy_free` capture may take right now. */
function freeTakeCandidates(state: GameState, playerId: PlayerId, parentMeta: CardMeta): CardMeta[] {
  const out: CardMeta[] = [];
  const seen = new Set<string>();
  for (const tier of freeTakeTiers(parentMeta)) {
    for (const zoneId of zonesForTierTag(tier)) {
      for (const entity of ECSManager.getEntitiesInZone(state, zoneId)) {
        if (seen.has(entity.id)) continue;
        const meta = cardMeta(entity);
        if (!freeTakeable(state, playerId, meta)) continue;
        seen.add(entity.id);
        out.push(meta);
      }
    }
  }
  return out;
}

/** The best instant free card, or null when the effect must fizzle. */
function bestFreeCard(state: GameState, playerId: PlayerId, parentMeta: CardMeta): CardMeta | null {
  const candidates = freeTakeCandidates(state, playerId, parentMeta);
  if (candidates.length === 0) return null;
  const assoc = (state.players[playerId]?.customProps.assoc ?? {}) as Record<string, string>;
  const bonuses = gemBag(state.players[playerId]?.customProps.bonuses);
  let best = candidates[0];
  let bestScore = -Infinity;
  for (const meta of candidates) {
    // Prefer a colour the player is already deep in, so a `double` or a plain
    // bonus card compounds instead of scattering.
    const color = effectiveBonusColor(meta, assoc);
    const depth = color ? bonuses[color] : 0;
    const score = freeCardValue(meta) + depth * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = meta;
    }
  }
  return best;
}

/**
 * Default `{freeTakeId, freeOpts}` for one `free` / `copy_free` capture,
 * recursing through chained free takes (bounded so a cycle cannot spin).
 */
function defaultFreeOpts(
  state: GameState,
  playerId: PlayerId,
  parentMeta: CardMeta,
  depth = 0,
  seen: Record<string, true> = {}
): Record<string, unknown> | null {
  if (depth > 4) return null;
  const candidates = freeTakeCandidates(state, playerId, parentMeta).filter(meta => !seen[meta.id]);
  if (candidates.length === 0) return null;

  for (const candidate of candidates) {
    const opts: Record<string, unknown> = { freeTakeId: candidate.id };
    if (candidate.effect === 'copy' || candidate.effect === 'copy_free') {
      const copyTargets = copyCandidates(state, playerId);
      if (copyTargets.length === 0) continue;
      opts.copyTargetId = copyTargets[0];
    }
    if (candidate.effect === 'free' || candidate.effect === 'copy_free') {
      const nested = defaultFreeOpts(state, playerId, candidate, depth + 1, { ...seen, [candidate.id]: true });
      if (nested) opts.freeOpts = nested;
    }
    // Validate the whole chain before offering it: a chain that cannot resolve
    // is not a legal capture, so try the next candidate.
    const planned = planFreeTakes(state, playerId, parentMeta, opts, 0, seen);
    if ('error' in planned) continue;
    return opts;
  }
  return null;
}

/**
 * The engine's default `captureOpts` for one card: what the game would choose
 * if the player simply said "capture this".
 *
 * Every field is optional, so this is both the value used by legal actions and
 * the fallback that fills in whatever a caller left out.
 */
function defaultCaptureOpts(
  state: GameState,
  playerId: PlayerId,
  meta: CardMeta
): Record<string, unknown> {
  const opts: Record<string, unknown> = {};
  const player = state.players[playerId];
  if (!player) return opts;

  // POKÉDEX first: it is the only way a player short of master balls can pay.
  const tokens = gemBag(player.customProps.tokens);
  const bonuses = gemBag(player.customProps.bonuses);
  if (!paymentPlan(meta.cost, tokens, bonuses)) {
    const dex = pokedexCandidates(state, playerId);
    for (let count = 1; count <= dex.length; count++) {
      if (paymentPlan(meta.cost, tokens, bonuses, count * 2)) {
        opts.spendPokedex = dex.slice(0, count);
        break;
      }
    }
  }

  // copy / copy_free borrow a colour from an owned card that has one.
  if (meta.effect === 'copy' || meta.effect === 'copy_free') {
    const candidates = copyCandidates(state, playerId);
    if (candidates.length > 0) opts.copyTargetId = candidates[0];
  }

  // free / copy_free take a concrete free card; a chain nests `freeOpts`.
  if (meta.effect === 'free' || meta.effect === 'copy_free') {
    const freeOpts = defaultFreeOpts(state, playerId, meta);
    if (freeOpts) Object.assign(opts, freeOpts);
  }

  return opts;
}

/** Does capturing this card require a choice that changes the outcome? */
function needsCaptureChoice(meta: CardMeta): boolean {
  return (
    meta.effect === 'copy' ||
    meta.effect === 'copy_free' ||
    meta.effect === 'free' ||
    meta.effect === 'discard_buy'
  );
}

/** Move a board card out of the game (REPEL / POKÉDEX discard). */
function discardFromTableau(state: GameState, playerId: PlayerId, cardId: string): GameState {
  const entity = state.entities[cardId];
  if (!entity) return state;
  let next = ECSManager.moveEntity(state, cardId, SPLENDOR_ZONES.discarded);
  next = withVisibility(next, cardId, { type: 'PUBLIC' });
  const player = next.players[playerId];
  if (!player) return next;
  const assoc = { ...((player.customProps.assoc ?? {}) as Record<string, string>) };
  delete assoc[cardId];
  return withPlayer(next, playerId, { assoc });
}

/** Apply the planned free takes: each lands on the tableau and resolves itself. */
function applyFreeTakes(
  state: GameState,
  playerId: PlayerId,
  steps: { freeId: string; assoc: string | null }[],
  ctx: ReduceContext,
  playerName: string
): GameState {
  let next = state;
  for (const step of steps) {
    const entity = next.entities[step.freeId];
    if (!entity) continue;
    const meta = cardMeta(entity);
    const fromRow = entity.zoneId;
    next = ECSManager.moveEntity(next, step.freeId, SPLENDOR_ZONES.tableau(playerId));
    next = withVisibility(next, step.freeId, { type: 'PUBLIC' });
    if (step.assoc) {
      const player = next.players[playerId];
      const assoc = { ...((player?.customProps.assoc ?? {}) as Record<string, string>) };
      assoc[step.freeId] = step.assoc;
      next = withPlayer(next, playerId, { assoc });
    }
    next = refillRow(next, fromRow);
    ctx.trace({
      id: `free_${ctx.id('g')}`,
      type: 'CARD_DRAW',
      title:
        `${playerName} 免费获得 [${meta.name}]` +
        `${step.assoc ? `（关联${labelOf(step.assoc)}）` : ''}`,
      durationMs: 400
    });
  }
  return next;
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
    //
    // Every card that can be paid for is offered once. A Poké Mart card whose
    // effect needs a choice carries a fully-resolved `payload.captureOpts`, so
    // the action is directly executable (by the UI or by a bot) without a
    // second round-trip; `buyCard` re-validates it either way.
    for (const [zoneId] of Object.entries(ROW_SOURCE)) {
      for (const card of ECSManager.getEntitiesInZone(state, zoneId)) {
        const action = SplendorRules.captureAction(state, playerId, card);
        if (action) actions.push(action);
      }
    }
    for (const card of ECSManager.getEntitiesInZone(state, SPLENDOR_ZONES.hand(playerId))) {
      const action = SplendorRules.captureAction(state, playerId, card);
      if (action) actions.push(action);
    }

    /* 3 · reserving ----------------------------------------------------- */
    if (zoneIds(state, SPLENDOR_ZONES.hand(playerId)).length < MAX_RESERVES) {
      const rows: { row: string; deck: string | null; fromTier: unknown }[] = SPLENDOR_TIERS.map(tier => ({
        row: SPLENDOR_ZONES.market(tier),
        deck: SPLENDOR_ZONES.deck(tier),
        fromTier: tier
      }));
      // Poké Mart rows reserve exactly like their base level (blind draws too).
      if (pokemartEnabled(state)) {
        for (const martTier of POKEMART_TIERS) {
          rows.push({
            row: SPLENDOR_ZONES.pokemart(martTier),
            deck: SPLENDOR_ZONES.pokemartDeckOf(martTier),
            fromTier: martTier
          });
        }
      }
      for (const entry of rows) {
        for (const card of ECSManager.getEntitiesInZone(state, entry.row)) {
          actions.push({ type: 'RESERVE_CARD', playerId, entityId: card.id });
        }
        // Blind draw from the top of that level's deck.
        if (entry.deck && zoneIds(state, entry.deck).length > 0) {
          actions.push({ type: 'RESERVE_CARD', playerId, payload: { fromTier: entry.fromTier } });
        }
      }
    }

    /* 4 · evolution (free, once per turn) -------------------------------- */
    if (!state.globalVars.evolvedThisTurn) {
      for (const evolution of SplendorRules.evolutionOptions(state, playerId)) {
        actions.push({ type: 'EVOLVE', playerId, payload: evolution });
      }
    }

    /* 5 · Mega Evolution (expansion) -------------------------------------- */
    if (megaEnabled(state)) {
      // Spending the whole action on a Mega token is a real move — it is the
      // only way to reach the 20-point goal, so a bot must be able to plan it.
      const heldMega = Number(player.customProps.megaToken ?? 0);
      const poolMega = Number(state.globalVars.megaTokens ?? 0);
      if (heldMega < MAX_MEGA_TOKENS_PER_PLAYER && poolMega > 0) {
        actions.push({ type: 'TAKE_MEGA_TOKEN', playerId });
      }
      if (!state.globalVars.evolvedThisTurn && heldMega >= 1) {
        for (const option of SplendorRules.megaEvolveOptions(state, playerId)) {
          actions.push({ type: 'MEGA_EVOLVE', playerId, payload: option });
        }
      }
    }

    /* 6 · deadlock escape ------------------------------------------------- */
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
   * One directly-executable `BUY_CARD` for `card`, or `null` when it is not
   * affordable / not capturable right now.
   *
   * Poké Mart effects that need a choice get their defaults resolved here
   * (cheapest legal colour to copy, the least valuable cards to sacrifice, the
   * best free card to take). `payload.captureOpts` is still re-validated in
   * `buyCard`, so a hand-written action with different choices stays legal too.
   */
  public static captureAction(state: GameState, playerId: PlayerId, card: Entity): Action | null {
    const meta = cardMeta(card);
    const player = state.players[playerId];
    if (!player) return null;

    // REPEL pays with cards, never with balls.
    if (meta.effect === 'discard_buy') {
      const param = meta.effectParam ?? {};
      const color = String(param.discardColor ?? '');
      const need = Math.max(1, Math.floor(Number(param.discardCount ?? 2)));
      const owned = color ? discardCandidates(state, playerId, color) : [];
      if (owned.length < need) return null;
      return {
        type: 'BUY_CARD',
        playerId,
        entityId: card.id,
        payload: { captureOpts: { discardCards: owned.slice(0, need) } }
      };
    }

    const tokens = gemBag(player.customProps.tokens);
    const bonuses = gemBag(player.customProps.bonuses);
    const opts = defaultCaptureOpts(state, playerId, meta);
    const planned = resolveCaptureChoice(state, playerId, meta, opts);
    if ('error' in planned) return null;
    // The card must be affordable *including* the POKÉDEX the default plan
    // spends. Offering an action the reducer would refuse turns a "legal" move
    // into a silent no-op, so it is filtered out here instead.
    if (!paymentPlan(meta.cost, tokens, bonuses, planned.choice.spendPokedex.length * 2)) return null;

    const action: Action = { type: 'BUY_CARD', playerId, entityId: card.id };
    const choice = planned.choice;
    // Start from the very options that were just validated: they already carry
    // the nested free chain (`freeTakeId` / `freeOpts` / `copyTargetId`).
    const captureOpts: Record<string, unknown> = { ...opts };
    if (choice.spendPokedex.length > 0) captureOpts.spendPokedex = choice.spendPokedex;
    if (choice.discardCards.length > 0) captureOpts.discardCards = choice.discardCards;
    // The assoc colour is not a payload field: it is always re-derived from
    // `copyTargetId`, which is the stable, checkable choice.
    if (choice.assocColor !== null && captureOpts.copyTargetId === undefined) {
      captureOpts.copyTargetId = copyCandidates(state, playerId)[0];
    }
    if (Object.keys(captureOpts).length > 0) action.payload = { captureOpts };
    else if (needsCaptureChoice(meta) || pokedexCandidates(state, playerId).length > 0) {
      // A choice-less capture (a plain Pokémon, or an effect that resolved with
      // no options) still has to advertise the form: that is what tells the
      // kernel's strict gate "the reducer validates this payload" instead of
      // demanding byte-identical canonical equality. An explicit empty object
      // keeps the direct path working for bots and board clicks.
      action.payload = { captureOpts: {} };
    }
    if (needsCaptureChoice(meta) || pokedexCandidates(state, playerId).length > 0) {
      // The form is deliberately left empty: every field of `captureOpts` is
      // optional, and the reducer fills whatever the player omits with the very
      // defaults enumerated above. Submitting an untouched form therefore plays
      // the recommended capture.
      action.fields = [
        { key: 'captureOpts', label: '效果选择（留空即用推荐选择）', kind: 'json', required: false }
      ];
    }
    return action;
  }

  /**
   * Legal Mega super-evolutions for a player: they must hold a Mega token, own
   * the base Pokémon named by `megaFrom`, and be able to pay the Mega card.
   */
  public static megaEvolveOptions(
    state: GameState,
    playerId: PlayerId
  ): { megaId: string; fromId: string }[] {
    if (!megaEnabled(state)) return [];
    if (state.globalVars.evolvedThisTurn) return [];
    const player = state.players[playerId];
    if (!player) return [];
    if (Number(player.customProps.megaToken ?? 0) < 1) return [];

    const tokens = gemBag(player.customProps.tokens);
    const bonuses = gemBag(player.customProps.bonuses);
    const board = zoneIds(state, SPLENDOR_ZONES.tableau(playerId));
    const options: { megaId: string; fromId: string }[] = [];

    for (const megaId of zoneIds(state, SPLENDOR_ZONES.megaOffer)) {
      const mega = state.entities[megaId];
      if (!mega) continue;
      const megaMeta = cardMeta(mega);
      if (!megaMeta.megaFrom) continue;
      const fromId = board.find(id => cardMeta(state.entities[id]).name === megaMeta.megaFrom);
      if (!fromId) continue;
      if (!paymentPlan(megaMeta.cost, tokens, bonuses)) continue;
      options.push({ megaId, fromId });
    }
    return options;
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
      case 'TAKE_MEGA_TOKEN':
        return SplendorRules.takeMegaToken(state, action, ctx);
      case 'MEGA_EVOLVE':
        return SplendorRules.megaEvolve(state, action, ctx);
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

    // Poké Mart: validate every player choice before touching the position, so
    // a rejected capture leaves no partial state behind.
    const resolved = resolveCaptureChoice(state, pId, meta, action.payload?.captureOpts);
    if ('error' in resolved) return state;
    const choice = resolved.choice;

    // REPEL (`discard_buy`) pays no balls at all: it sacrifices owned cards.
    if (meta.effect === 'discard_buy') {
      let next = SplendorRules.takeFromSource(state, pId, cardId, fromZone);
      for (const discardedId of choice.discardCards) {
        next = discardFromTableau(next, pId, discardedId);
      }
      next = applySettlement(next, pId);
      ctx.trace({
        id: `buy_${ctx.id('g')}`,
        type: 'BUILD_OBJECT',
        title:
          `${player.name} 用 [${meta.name}] 交换（弃掉 ${choice.discardCards.length} 张` +
          `${labelOf(String(meta.effectParam?.discardColor ?? ''))}卡 · +${meta.vp} VP）`,
        durationMs: 500
      });
      next = SplendorRules.markLastRound(next, ctx);
      return SplendorRules.advanceTurn(next, pId, ctx);
    }

    const plan = paymentPlan(meta.cost, tokens, bonuses, choice.spendPokedex.length * 2);
    if (!plan) return state;

    const bank = gemBag(state.globalVars.bank);
    for (const color of POKEBALL_COLORS) {
      const spent = tokens[color] - plan.tokens[color];
      if (spent > 0) bank[color] += spent;
    }

    let next = withPlayer(state, pId, { tokens: plan.tokens });
    next = withGlobal(next, { bank });
    // Discarded POKÉDEX cards leave the game with the virtual masters they paid.
    for (const dexId of choice.spendPokedex) next = discardFromTableau(next, pId, dexId);
    next = SplendorRules.takeFromSource(next, pId, cardId, fromZone);
    if (choice.assocColor) {
      const assoc = { ...((next.players[pId]?.customProps.assoc ?? {}) as Record<string, string>) };
      assoc[cardId] = choice.assocColor;
      next = withPlayer(next, pId, { assoc });
    }
    next = applySettlement(next, pId);

    const extras = [
      choice.spendPokedex.length > 0 ? `弃 ${choice.spendPokedex.length} 张图鉴抵 ${choice.spendPokedex.length * 2} 大师球` : null,
      choice.assocColor ? `关联${labelOf(choice.assocColor)}` : null,
      plan.masterBallsPaid > 0 ? `支付 ${plan.masterBallsPaid} 大师球` : null
    ].filter(Boolean);

    ctx.trace({
      id: `buy_${ctx.id('g')}`,
      type: 'BUILD_OBJECT',
      title:
        `${player.name} 捕捉了 [${meta.name}]（+${meta.vp} VP` +
        `${meta.bonus ? ` · +${meta.bonusCount} ${labelOf(meta.bonus)}加成` : ''}` +
        `${extras.length ? ` · ${extras.join(' · ')}` : ''}）`,
      durationMs: 500
    });

    // Free takes resolve after the capture itself, then settle again: a free
    // card can move the score and the bonuses.
    if (choice.freeSteps.length > 0) {
      next = applyFreeTakes(next, pId, choice.freeSteps, ctx, player.name);
      next = applySettlement(next, pId);
    }

    next = SplendorRules.markLastRound(next, ctx);
    return SplendorRules.advanceTurn(next, pId, ctx);
  }

  /** Lift a captured card off its row / reserve and put it on the tableau. */
  private static takeFromSource(state: GameState, pId: PlayerId, cardId: string, fromZone: string): GameState {
    let next = ECSManager.moveEntity(state, cardId, SPLENDOR_ZONES.tableau(pId));
    next = withVisibility(next, cardId, { type: 'PUBLIC' });
    return refillRow(next, fromZone);
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
      // Blind draw: `fromTier` is either a base level (1–3) or a Poké Mart level.
      const rawTier = action.payload?.fromTier;
      let deckZoneId: string | null = null;
      if (typeof rawTier === 'number' && SPLENDOR_TIERS.includes(rawTier as SplendorTier)) {
        deckZoneId = SPLENDOR_ZONES.deck(rawTier as SplendorTier);
      } else if (
        typeof rawTier === 'string' &&
        pokemartEnabled(state) &&
        (POKEMART_TIERS as readonly string[]).includes(rawTier)
      ) {
        deckZoneId = SPLENDOR_ZONES.pokemartDeckOf(rawTier as PokemartTier);
      }
      if (!deckZoneId) return state;
      const deck = state.zones[deckZoneId];
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

  /* ---- Mega Evolution (expansion) ------------------------------------ */

  /**
   * Take one Mega token from the shared pool.
   *
   * This costs the whole turn (unlike a free evolution), and a player may never
   * hold more than one token at a time, so it is a real main action.
   */
  private static takeMegaToken(state: GameState, action: Action, ctx: ReduceContext): GameState {
    if (!megaEnabled(state)) return state;
    const pId = action.playerId;
    const player = state.players[pId];
    if (!player) return state;
    if (state.activePlayerId !== pId) return state;

    const held = Number(player.customProps.megaToken ?? 0);
    if (held >= MAX_MEGA_TOKENS_PER_PLAYER) return state;
    const pool = Number(state.globalVars.megaTokens ?? 0);
    if (pool < 1) return state;

    let next = withGlobal(state, { megaTokens: pool - 1 });
    next = withPlayer(next, pId, { megaToken: held + 1 });

    ctx.trace({
      id: `mega_token_${ctx.id('g')}`,
      type: 'TOKEN_TRANSFER',
      title: `${player.name} 获得了 1 个 Mega 代币（本回合行动结束）`,
      durationMs: 500
    });

    return SplendorRules.advanceTurn(next, pId, ctx);
  }

  /**
   * Super-evolve a base Pokémon into a Mega.
   *
   * Requires the Mega token (which returns to the shared pool), the base Pokémon
   * on the tableau, and the Mega card's cost paid with balls (bonuses discount,
   * master balls substitute). It shares `evolvedThisTurn` with the ordinary
   * evolution, so a turn still holds at most one evolution.
   */
  private static megaEvolve(state: GameState, action: Action, ctx: ReduceContext): GameState {
    if (!megaEnabled(state)) return state;
    const pId = action.playerId;
    const player = state.players[pId];
    if (!player) return state;

    const megaId = action.payload?.megaId;
    const fromId = action.payload?.fromId;
    if (typeof megaId !== 'string') return state;

    const candidates = SplendorRules.megaEvolveOptions(state, pId).filter(option => option.megaId === megaId);
    const option =
      typeof fromId === 'string' ? candidates.find(candidate => candidate.fromId === fromId) : candidates[0];
    if (!option) return state;

    const mega = state.entities[option.megaId];
    const base = state.entities[option.fromId];
    if (!mega || !base) return state;
    const megaMeta = cardMeta(mega);
    const baseMeta = cardMeta(base);

    const tokens = gemBag(player.customProps.tokens);
    const bonuses = gemBag(player.customProps.bonuses);
    const plan = paymentPlan(megaMeta.cost, tokens, bonuses);
    if (!plan) return state;

    const bank = gemBag(state.globalVars.bank);
    for (const color of POKEBALL_COLORS) {
      const spent = tokens[color] - plan.tokens[color];
      if (spent > 0) bank[color] += spent;
    }

    const buriedIds: string[] = [...(player.customProps.buriedIds ?? []), option.fromId];

    let next = withPlayer(state, pId, { tokens: plan.tokens, megaToken: 0, buriedIds });
    next = withGlobal(next, {
      bank,
      // The token goes back to the shared pool.
      megaTokens: Number(state.globalVars.megaTokens ?? 0) + 1,
      evolvedThisTurn: true
    });
    // The base Pokémon is buried; the Mega card leaves the offer for good.
    next = withVisibility(next, option.fromId, { type: 'PUBLIC' });
    next = ECSManager.moveEntity(next, option.fromId, SPLENDOR_ZONES.buried(pId));
    next = withVisibility(next, option.megaId, { type: 'PUBLIC' });
    next = ECSManager.moveEntity(next, option.megaId, SPLENDOR_ZONES.tableau(pId));
    next = applySettlement(next, pId);

    ctx.trace({
      id: `mega_evolve_${ctx.id('g')}`,
      type: 'ANNOUNCEMENT',
      title:
        `✨ ${player.name} 将 [${baseMeta.name}] 超级进化为 [${megaMeta.name}]` +
        `（+${megaMeta.vp} VP · 消耗 Mega 代币` +
        `${plan.masterBallsPaid > 0 ? ` · 支付 ${plan.masterBallsPaid} 大师球` : ''}）`,
      durationMs: 800
    });

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
    // The end-of-turn evolution can push a player past the goal on its own (it
    // strictly raises VP), so the trigger has to be re-checked here: `buyCard`
    // and `evolve` both run before the seat passes, but this settlement runs
    // *inside* the hand-over. Missing it left a reach-goal-by-evolution table
    // without a final round — the game then simply played on.
    next = SplendorRules.markLastRound(next, ctx);

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

  /**
   * With Mega Evolution the goal is stricter than raw points: 20 VP **and** at
   * least one bonus of every colour **and** a Mega card in play. A rival with
   * more points but no Mega does not win.
   */
  public static hasMegaWin(state: GameState, playerId: PlayerId): boolean {
    const player = state.players[playerId];
    if (!player) return false;
    if (Number(player.score ?? 0) < MEGA_WIN_SCORE) return false;
    const bonuses = gemBag(player.customProps.bonuses);
    for (const color of TOKEN_COLORS) {
      if (bonuses[color] <= 0) return false;
    }
    return zoneIds(state, SPLENDOR_ZONES.tableau(playerId)).some(
      id => cardMeta(state.entities[id]).tier === 'mega'
    );
  }

  /** Has `playerId` met the win condition of this position's rule set? */
  public static hasReachedGoal(state: GameState, playerId: PlayerId): boolean {
    if (megaEnabled(state)) return SplendorRules.hasMegaWin(state, playerId);
    const player = state.players[playerId];
    if (!player) return false;
    return Number(player.score ?? 0) >= Number(state.globalVars.scoreToWin ?? WIN_SCORE);
  }

  /** First player to reach the goal triggers the final round. */
  private static markLastRound(state: GameState, ctx: ReduceContext): GameState {
    if (state.globalVars.lastRound) return state;
    const reached = state.playerOrder.some(pid => SplendorRules.hasReachedGoal(state, pid));
    if (!reached) return state;

    ctx.trace({
      id: `last_round_${ctx.id('g')}`,
      type: 'ANNOUNCEMENT',
      title: megaEnabled(state)
        ? `🏁 有人达成 ${MEGA_WIN_SCORE} 分 + 六色奖励 + Mega 在場 — 本轮结束后结算`
        : `🏁 有人达到 ${Number(state.globalVars.scoreToWin ?? WIN_SCORE)} 分 — 本轮结束后结算`,
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
   *
   * With Mega Evolution only a player who actually satisfies the stricter goal
   * is eligible; the pool falls back to everyone only in the pathological case
   * where nobody qualified, so a table can never end without a winner.
   */
  public static checkWinCondition(
    state: GameState
  ): { gameOver: boolean; winner: PlayerId | null; reason?: string } {
    if (!state.globalVars.finalRoundComplete) return { gameOver: false, winner: null };

    let pool = [...state.playerOrder];
    if (megaEnabled(state)) {
      const qualified = pool.filter(pid => SplendorRules.hasMegaWin(state, pid));
      if (qualified.length > 0) pool = qualified;
    }

    const ranking = pool.map(pid => {
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
