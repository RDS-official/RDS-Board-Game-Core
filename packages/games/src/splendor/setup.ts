import { ECSManager } from '@rds/kernel/ecs';
import { DeterministicPRNG } from '@rds/kernel/prng';
import { Entity, GameState, Player } from '@rds/kernel/types';
import pkmnData from './pokemonData.json';

/**
 * 宝可梦璀璨宝石 (Pokémon Splendor) — setup.
 *
 * The fixture is a faithful port of the imported deck
 * (Ethan9123/pokemon-splendor) onto the kernel:
 *
 *  · six Poké Ball colours (red / blue / black / pink / yellow / purple);
 *    purple = master ball and acts as the wild substitute;
 *  · supply is dealt by seat count (2p → 4, 3p → 5, 4p → 7 of every colour,
 *    master balls are always 5);
 *  · each stage deck is shuffled with the kernel PRNG and four cards are
 *    revealed per market row; rare / legendary Pokémon are a single revealed
 *    card each and may only be caught with master balls;
 *  · the whole shuffling state lives in `prngState`, so a seed replays
 *    bit-exactly (`Math.random` is never used).
 */

/* -------------------------------------------------------------------------- */
/* Imported card database                                                     */
/* -------------------------------------------------------------------------- */

export interface PkmnEvoCost {
  color: string;
  count: number;
}

export interface PkmnCard {
  id: string;
  name: string;
  vp: number;
  bonus: string;
  bonusCount: number;
  cost: Record<string, number>;
  evolvesTo?: string | null;
  evoCost?: PkmnEvoCost | null;
  img: string;
}

export interface PkmnMegaCard {
  id: string;
  name: string;
  vp: number;
  bonus: string;
  bonusCount: number;
  cost: Record<string, number>;
  megaFrom: string;
  img: string;
}

export interface PkmnMartCard {
  id: string;
  name: string;
  tier: string;
  vp: number;
  bonus: string;
  bonusCount: number;
  cost: Record<string, number>;
  effect: string;
  effectParam: Record<string, unknown> | null;
  img: string;
}

/**
 * The six Poké Mart effects (five cards each, one per colour).
 *
 *  free             进化石   — take a free face-up Level-2 card after capture
 *  copy_free        神奇糖果 — associate + take a free face-up Level-1 card
 *  copy             技能机   — permanent bonus colour copied from an owned card
 *  colorless_master 图鉴     — no colour; discardable as 2 virtual master balls
 *  discard_buy      驱虫喷雾 — pay no balls; discard 2 owned cards of a colour
 *  double           药水     — no effect code needed: `bonusCount` already is 2
 */
export type PokemartEffect = 'free' | 'copy_free' | 'copy' | 'colorless_master' | 'discard_buy' | 'double';

/** Poké Mart levels → the base level whose row they sit next to. */
export const POKEMART_TIERS = ['pmL1', 'pmL2', 'pmL3'] as const;
export type PokemartTier = (typeof POKEMART_TIERS)[number];

interface RawPkmnData {
  cards: PkmnCard[];
  megas: PkmnMegaCard[];
  pokemart: PkmnMartCard[];
}

const RAW = pkmnData as unknown as RawPkmnData;

/** Imported Pokémon Splendor card database (Ethan9123/pokemon-splendor). */
export const PKMN_DECK = {
  stage1: RAW.cards.filter(c => c.id.startsWith('s1_')),
  stage2: RAW.cards.filter(c => c.id.startsWith('s2_')),
  stage3: RAW.cards.filter(c => c.id.startsWith('s3_')),
  rare: RAW.cards.filter(c => c.id.startsWith('rr_')),
  legend: RAW.cards.filter(c => c.id.startsWith('lg_')),
  mega: RAW.megas,
  pokemart: RAW.pokemart
};

/* -------------------------------------------------------------------------- */
/* Colours                                                                    */
/* -------------------------------------------------------------------------- */

/** The six canonical Poké Ball colours. */
export type PokeballColor = 'red' | 'blue' | 'black' | 'pink' | 'yellow' | 'purple';

/**
 * Colours that can appear on a card / in a token pouch.
 *
 * The classic Splendor names (`diamond`, `sapphire`, …) and `gold` are kept as
 * deprecated aliases so the renderer token meshes compiled against the old
 * fixture keep working while they migrate to the imported Poké Ball artwork.
 */
export type GemType = PokeballColor | 'diamond' | 'sapphire' | 'emerald' | 'ruby' | 'onyx' | 'gold';

/** Canonical ball order — rules iterate this, never `Object.keys`. */
export const POKEBALL_COLORS: PokeballColor[] = ['red', 'blue', 'black', 'pink', 'yellow', 'purple'];

/** Colours that can be taken from the bank (master balls move via reserve only). */
export const TOKEN_COLORS: PokeballColor[] = ['red', 'blue', 'black', 'pink', 'yellow'];

/** The wild substitute colour. */
export const MASTER_BALL: PokeballColor = 'purple';

export const GEM_COLORS: Record<GemType, string> = {
  red: '#e53935',
  blue: '#1e88e5',
  black: '#212121',
  pink: '#ec407a',
  yellow: '#fdd835',
  purple: '#8e24aa',
  // deprecated classic aliases (renderer back-compat)
  diamond: '#e0f7fa',
  sapphire: '#1e88e5',
  emerald: '#43a047',
  ruby: '#e53935',
  onyx: '#212121',
  gold: '#ffb300'
};

/**
 * Deck colour → token colour. Now an identity map (the fixture speaks the
 * ball colours directly); kept exported for the renderer's token lookup.
 */
export const PKMN_COLOR_TO_GEM: Record<string, string> = {
  red: 'red',
  blue: 'blue',
  black: 'black',
  pink: 'pink',
  yellow: 'yellow',
  purple: 'purple'
};

export const PKMN_BALL_IMAGE: Record<string, string> = {
  red: '/pokemon/balls/red.png',
  blue: '/pokemon/balls/blue.png',
  black: '/pokemon/balls/black.png',
  pink: '/pokemon/balls/pink.png',
  yellow: '/pokemon/balls/yellow.png',
  purple: '/pokemon/balls/purple.png'
};

export const PKMN_CARD_BACK: Record<string, string> = {
  stage1: '/pokemon/backs/stage1.webp',
  stage2: '/pokemon/backs/stage2.webp',
  stage3: '/pokemon/backs/stage3.webp',
  rare: '/pokemon/backs/rare.webp',
  legend: '/pokemon/backs/legend.webp',
  mega: '/pokemon/backs/stage3.webp',
  pmL1: '/pokemon/backs/pokemart-1.png',
  pmL2: '/pokemon/backs/pokemart-2.png',
  pmL3: '/pokemon/backs/pokemart-3.png'
};

/* -------------------------------------------------------------------------- */
/* Rule constants                                                             */
/* -------------------------------------------------------------------------- */

/** Stage decks, in market order. */
export type SplendorTier = 1 | 2 | 3;
export const SPLENDOR_TIERS: SplendorTier[] = [1, 2, 3];

export const WIN_SCORE = 18;
/** A player may never hold more balls than this (master balls included). */
export const MAX_TOKENS = 10;
export const MAX_RESERVES = 3;
export const MARKET_SIZE = 4;
/** Master balls in the bank, independent of the seat count. */
export const MASTER_BALL_SUPPLY = 5;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;

/** Mega Evolution: shared pool of Mega tokens (each player may hold at most 1). */
export const MEGA_TOKENS = 4;
/** A single player may never hold more than one Mega token. */
export const MAX_MEGA_TOKENS_PER_PLAYER = 1;
/** With Mega Evolution the goal becomes 20 VP + one bonus of every colour + a Mega in play. */
export const MEGA_WIN_SCORE = 20;
/** The Mega offer: every Mega card is revealed face-up and removed when taken. */
export const MEGA_OFFER_SIZE = 10;
/** Poké Mart: each level reveals this many cards next to its row. */
export const POKEMART_SLOTS = 2;

/** Bank supply per colour, by seat count (master balls are always 5). */
export const TOKEN_SUPPLY_BY_PLAYERS: Record<number, number> = { 2: 4, 3: 5, 4: 7 };

export function tokenSupplyFor(playerCount: number): Record<string, number> {
  const seats = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, Math.floor(playerCount) || MIN_PLAYERS));
  const perColor = TOKEN_SUPPLY_BY_PLAYERS[seats];
  const supply: Record<string, number> = {};
  for (const color of POKEBALL_COLORS) supply[color] = color === MASTER_BALL ? MASTER_BALL_SUPPLY : perColor;
  return supply;
}

/* -------------------------------------------------------------------------- */
/* Zone vocabulary (also used by rules + presenters)                          */
/* -------------------------------------------------------------------------- */

export const SPLENDOR_ZONES = {
  market: (tier: SplendorTier): string => `zone_market_t${tier}`,
  deck: (tier: SplendorTier): string => `zone_deck_s${tier}`,
  rare: 'zone_rare',
  legend: 'zone_legend',
  rareDeck: 'zone_deck_rare',
  legendDeck: 'zone_deck_legend',
  megaDeck: 'zone_deck_mega',
  /** Every Mega card is revealed here; a taken Mega leaves the offer for good. */
  megaOffer: 'zone_mega_offer',
  pokemartDeck: 'zone_deck_pokemart',
  /** One face-up Poké Mart row per level (2 cards each). */
  pokemart: (tier: PokemartTier): string => `zone_${tier}`,
  /** One face-down deck per Poké Mart level. */
  pokemartDeckOf: (tier: PokemartTier): string => `zone_deck_${tier}`,
  hand: (playerId: string): string => `zone_hand_${playerId}`,
  tableau: (playerId: string): string => `zone_tableau_${playerId}`,
  buried: (playerId: string): string => `zone_buried_${playerId}`,
  /** Cards discarded by the Poké Mart REPEL leave the game here. */
  discarded: 'zone_discarded'
};

/* -------------------------------------------------------------------------- */
/* Setup                                                                      */
/* -------------------------------------------------------------------------- */

const SEATS = [
  { id: 'p1', name: '小智', color: '#e53935', avatar: '⚡' },
  { id: 'p2', name: '小茂', color: '#1e88e5', avatar: '🧢' },
  { id: 'p3', name: '小霞', color: '#43a047', avatar: '💧' },
  { id: 'p4', name: '小刚', color: '#fb8c00', avatar: '🪨' }
];

type CardTierTag = 'stage1' | 'stage2' | 'stage3' | 'rare' | 'legend' | 'mega' | 'pmL1' | 'pmL2' | 'pmL3';

const TIER_LABEL: Record<CardTierTag, string> = {
  stage1: 'STAGE_1',
  stage2: 'STAGE_2',
  stage3: 'STAGE_3',
  rare: 'RARE',
  legend: 'LEGEND',
  mega: 'MEGA',
  pmL1: 'POKEMART_1',
  pmL2: 'POKEMART_2',
  pmL3: 'POKEMART_3'
};

/** Base level a Poké Mart card is displayed next to (and reserved as). */
const POKEMART_BASE_TIER: Record<'pmL1' | 'pmL2' | 'pmL3', SplendorTier> = {
  pmL1: 1,
  pmL2: 2,
  pmL3: 3
};

function zeroGems(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const color of POKEBALL_COLORS) out[color] = 0;
  return out;
}

function toCardEntity(
  card: PkmnCard | PkmnMegaCard | PkmnMartCard,
  tag: CardTierTag,
  zoneId: string,
  visibility: Entity['visibility']
): Entity {
  const bonus = card.bonus && card.bonus !== 'none' ? card.bonus : null;
  const tierIndex =
    tag === 'stage1' ? 1 : tag === 'stage2' ? 2 : tag === 'stage3' ? 3 : tag === 'mega' ? 4 : 0;
  const martTier = tag === 'pmL1' || tag === 'pmL2' || tag === 'pmL3' ? tag : null;
  const baseTier = martTier ? POKEMART_BASE_TIER[martTier] : tierIndex > 0 && tierIndex < 4 ? tierIndex : 0;
  const evo = 'evolvesTo' in card ? (card.evolvesTo ?? null) : null;
  const evoCost = 'evoCost' in card ? (card.evoCost ?? null) : null;
  const megaFrom = 'megaFrom' in card ? card.megaFrom : null;
  const effect = 'effect' in card ? card.effect : null;
  const effectParam = 'effectParam' in card ? (card.effectParam ?? null) : null;
  const cost = { ...zeroGems(), ...(card.cost ?? {}) };

  const desc = [
    bonus ? `+${card.bonusCount} ${bonus}` : null,
    card.vp > 0 ? `${card.vp} VP` : null,
    evoCost ? `进化需 ${evoCost.count} ${evoCost.color} 奖励` : null,
    evo ? `可进化为 ${evo}` : null,
    megaFrom ? `由 ${megaFrom} 超级进化` : null,
    effect ? `效果 ${effect}` : null
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    id: card.id,
    type: 'CARD',
    zoneId,
    visibility,
    components: {
      cardFace: {
        title: card.name,
        type: TIER_LABEL[tag],
        score: card.vp,
        cost,
        desc,
        color: bonus ? GEM_COLORS[bonus as GemType] : '#8b93a1',
        imageUrl: 'img' in card ? card.img : undefined
      },
      custom: {
        pkmnId: card.id,
        pkmnTier: tag,
        zh: card.name,
        name: card.name,
        tierIndex,
        /** Base level (1–3) this card belongs to; 0 for rare / legendary / Mega. */
        baseTier,
        vp: card.vp,
        bonus,
        bonusCount: card.bonusCount,
        cost,
        evolvesTo: evo,
        evoCost,
        megaFrom,
        effect,
        effectParam,
        // Master ball requirement: any card whose cost lists purple must be
        // paid with real master balls (rare / legendary / mega cards).
        requiresMasterBall: (cost.purple ?? 0) > 0
      }
    }
  };
}

/**
 * Rule variant ("edition") this position is dealt under.
 *
 * The imported deck carries two expansions — Mega Evolution and the Poké Mart —
 * whose rule sets are independent of each other. A variant names which of them a
 * table actually plays with, so the base game stays the default and an expansion
 * that is switched off never leaks a pile onto the table.
 */
export interface SplendorVariant {
  /** Mega Evolution: Mega tokens, super-evolution, the 20-point goal. */
  mega: boolean;
  /** Poké Mart: the shop row and its six capture effects. */
  pokemart: boolean;
}

/** The variant every unreferenced caller gets: the plain base game. */
export const BASE_VARIANT: SplendorVariant = { mega: false, pokemart: false };

/**
 * Build the initial position.
 *
 * `playerCount` is persisted into `globalVars.playerCount`; every rule reads the
 * seat count from there instead of hardcoding it. The exported signature stays
 * `setupSplendor(seed)` (2 seats) so existing callers keep working.
 *
 * `variant` selects the rule set. An expansion whose rules are not implemented
 * is never dealt: its deck and its cards are simply absent, so nothing inert is
 * left on the table for a player to click.
 */
export function setupSplendor(
  seed: number = 42,
  playerCount: number = MIN_PLAYERS,
  variant: SplendorVariant = BASE_VARIANT
): GameState {
  const seats = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, Math.floor(playerCount) || MIN_PLAYERS));
  let prngSeed = (seed >>> 0) || 1;

  const shuffled = <T>(items: readonly T[]): T[] => {
    const { result, nextSeed } = DeterministicPRNG.shuffle(prngSeed, items);
    prngSeed = nextSeed >>> 0;
    return result as T[];
  };

  const players: Record<string, Player> = {};
  const playerOrder: string[] = [];
  for (let i = 0; i < seats; i++) {
    const seat = SEATS[i];
    players[seat.id] = {
      id: seat.id,
      name: seat.name,
      color: seat.color,
      avatar: seat.avatar,
      score: 0,
      alive: true,
      handZoneId: SPLENDOR_ZONES.hand(seat.id),
      customProps: {
        tokens: zeroGems(),
        bonuses: zeroGems(),
        purchasedCards: [],
        buriedIds: [],
        /** Mega Evolution: 0 or 1 held Mega token (shared pool lives in globalVars). */
        megaToken: 0,
        /**
         * Poké Mart `copy` / `copy_free` cards: cardId → borrowed bonus colour.
         * A card with no entry uses its own printed colour (or none at all).
         */
        assoc: {}
      }
    };
    playerOrder.push(seat.id);
  }

  let state: GameState = {
    gameId: 'splendor',
    seed,
    seq: 0,
    clock: 0,
    round: 1,
    turn: 1,
    activePlayerId: playerOrder[0],
    phase: 'TURN',
    players,
    playerOrder,
    entities: {},
    zones: {},
    mapGraph: { nodes: {}, edges: {}, topology: { kind: 'none', adjacency: 'none', geometry: 'none' } },
    globalVars: {
      /** Ball supply, dealt by seat count (master balls are always 5). */
      bank: tokenSupplyFor(seats),
      playerCount: seats,
      /** Evolution is once per turn and free; reset when the turn passes. */
      evolvedThisTurn: false,
      /** Someone reached the goal — play out the current round, then score. */
      lastRound: false,
      finalRoundComplete: false,
      /** Base goal; Mega Evolution raises it to MEGA_WIN_SCORE. */
      scoreToWin: variant.mega ? MEGA_WIN_SCORE : WIN_SCORE,
      maxTokens: MAX_TOKENS,
      maxReserves: MAX_RESERVES,
      /** Shared Mega token pool (0 when the expansion is off). */
      megaTokens: variant.mega ? MEGA_TOKENS : 0,
      /** Rule set this table was dealt under; persist it so replays agree. */
      variant: { ...variant }
    },
    interruptStack: [],
    pendingDecisions: [],
    activeHooks: [],
    prngState: prngSeed,
    actionLog: [],
    winner: null,
    gameOver: false
  };

  /* ---- zones -------------------------------------------------------- */

  state = ECSManager.createZone(state, 'zone_market_t1', 'Level 1 Pokémon', 'MARKET', { type: 'PUBLIC' }, undefined, 'ROW', [-3, 0.1, 1.5]);
  state = ECSManager.createZone(state, 'zone_market_t2', 'Level 2 Pokémon', 'MARKET', { type: 'PUBLIC' }, undefined, 'ROW', [-3, 0.1, 0]);
  state = ECSManager.createZone(state, 'zone_market_t3', 'Level 3 Pokémon', 'MARKET', { type: 'PUBLIC' }, undefined, 'ROW', [-3, 0.1, -1.5]);
  state = ECSManager.createZone(state, SPLENDOR_ZONES.rare, 'Rare Pokémon', 'MARKET', { type: 'PUBLIC' }, undefined, 'ROW', [-7.6, 0.1, 1.0]);
  state = ECSManager.createZone(state, SPLENDOR_ZONES.legend, 'Legendary Pokémon', 'MARKET', { type: 'PUBLIC' }, undefined, 'ROW', [-7.6, 0.1, -1.0]);

  // Face-down piles. Hidden so the deck order never leaks through a projection.
  for (const tier of SPLENDOR_TIERS) {
    state = ECSManager.createZone(state, SPLENDOR_ZONES.deck(tier), `Level ${tier} Deck`, 'DECK', { type: 'HIDDEN' }, undefined, 'STACK', [-6, 0.06, 3.2 - tier * 1.2]);
  }
  state = ECSManager.createZone(state, SPLENDOR_ZONES.rareDeck, 'Rare Deck', 'DECK', { type: 'HIDDEN' }, undefined, 'STACK', [-8.4, 0.06, 0.0]);
  state = ECSManager.createZone(state, SPLENDOR_ZONES.legendDeck, 'Legendary Deck', 'DECK', { type: 'HIDDEN' }, undefined, 'STACK', [-8.4, 0.06, -2.0]);
  // Expansion zones exist only for a variant that actually plays them, so a
  // switched-off expansion never leaves an inert pile on the table.
  if (variant.mega) {
    // Every Mega card is revealed face-up in its own offer: a taken Mega leaves
    // the offer for good, so the pile is public and open-ended.
    state = ECSManager.createZone(state, SPLENDOR_ZONES.megaOffer, 'Mega Evolution Offer', 'MARKET', { type: 'PUBLIC' }, undefined, 'ROW', [-3.0, 0.1, -3.4]);
  }
  if (variant.pokemart) {
    // One face-down deck + one 2-card face-up row per Poké Mart level.
    POKEMART_TIERS.forEach((martTier, index) => {
      state = ECSManager.createZone(
        state,
        SPLENDOR_ZONES.pokemartDeckOf(martTier),
        `Poké Mart ${martTier} Deck`,
        'DECK',
        { type: 'HIDDEN' },
        undefined,
        'STACK',
        [-8.4, 0.06, -3.4 - index * 1.0]
      );
      state = ECSManager.createZone(
        state,
        SPLENDOR_ZONES.pokemart(martTier),
        `Poké Mart ${martTier}`,
        'MARKET',
        { type: 'PUBLIC' },
        undefined,
        'ROW',
        [1.6, 0.1, 2.5 - index * 2.4]
      );
    });
    // REPEL discards leave the game: they need a zone to rest in.
    state = ECSManager.createZone(state, SPLENDOR_ZONES.discarded, 'Discarded Cards', 'DISCARD', { type: 'PUBLIC' }, undefined, 'STACK', [-10.4, 0.06, -3.4]);
  }

  playerOrder.forEach(pId => {
    state = ECSManager.createZone(state, SPLENDOR_ZONES.hand(pId), `${players[pId].name} Reserve`, 'HAND', {
      type: 'OWNER_ONLY',
      ownerId: pId
    }, pId);
    state = ECSManager.createZone(state, SPLENDOR_ZONES.tableau(pId), `${players[pId].name} Caught Pokémon`, 'GRID', {
      type: 'PUBLIC'
    }, pId);
    state = ECSManager.createZone(state, SPLENDOR_ZONES.buried(pId), `${players[pId].name} Buried Pokémon`, 'DISCARD', {
      type: 'PUBLIC'
    }, pId);
  });

  /* ---- decks -------------------------------------------------------- */

  // A deck plan exists only when its zone does: an expansion that is not being
  // played contributes no zone and, therefore, no cards.
  const deckPlans: {
    tag: CardTierTag;
    deck: string;
    cards: (PkmnCard | PkmnMegaCard | PkmnMartCard)[];
    visibility?: Entity['visibility'];
  }[] = [
    { tag: 'stage1', deck: SPLENDOR_ZONES.deck(1), cards: PKMN_DECK.stage1 },
    { tag: 'stage2', deck: SPLENDOR_ZONES.deck(2), cards: PKMN_DECK.stage2 },
    { tag: 'stage3', deck: SPLENDOR_ZONES.deck(3), cards: PKMN_DECK.stage3 },
    { tag: 'rare', deck: SPLENDOR_ZONES.rareDeck, cards: PKMN_DECK.rare },
    { tag: 'legend', deck: SPLENDOR_ZONES.legendDeck, cards: PKMN_DECK.legend }
  ];
  if (variant.mega) {
    // The Mega cards are not a pile: they are dealt straight into the open
    // offer, so the whole expansion is visible from the first bid.
    deckPlans.push({ tag: 'mega', deck: SPLENDOR_ZONES.megaOffer, cards: PKMN_DECK.mega, visibility: { type: 'PUBLIC' } });
  }
  if (variant.pokemart) {
    for (const martTier of POKEMART_TIERS) {
      deckPlans.push({
        tag: martTier,
        deck: SPLENDOR_ZONES.pokemartDeckOf(martTier),
        cards: PKMN_DECK.pokemart.filter(card => card.tier === martTier)
      });
    }
  }

  for (const plan of deckPlans) {
    const ordered = shuffled(plan.cards);
    for (const card of ordered) {
      state = ECSManager.addEntity(
        state,
        toCardEntity(card, plan.tag, plan.deck, plan.visibility ?? { type: 'HIDDEN' })
      );
    }
  }

  /* ---- opening reveal ----------------------------------------------- */

  for (const tier of SPLENDOR_TIERS) {
    for (let i = 0; i < MARKET_SIZE; i++) {
      state = dealTopCard(state, SPLENDOR_ZONES.deck(tier), SPLENDOR_ZONES.market(tier));
    }
  }
  state = dealTopCard(state, SPLENDOR_ZONES.rareDeck, SPLENDOR_ZONES.rare);
  state = dealTopCard(state, SPLENDOR_ZONES.legendDeck, SPLENDOR_ZONES.legend);

  // Poké Mart: two face-up cards per level, dealt from that level's own deck.
  if (variant.pokemart) {
    for (const martTier of POKEMART_TIERS) {
      for (let i = 0; i < POKEMART_SLOTS; i++) {
        state = dealTopCard(
          state,
          SPLENDOR_ZONES.pokemartDeckOf(martTier),
          SPLENDOR_ZONES.pokemart(martTier)
        );
      }
    }
  }

  return state;
}

/**
 * Move the top card of `deckZoneId` to the end of `targetZoneId`, revealing it.
 * Deck order is shuffled once in setup, so this is a pure state transition.
 */
export function dealTopCard(state: GameState, deckZoneId: string, targetZoneId: string): GameState {
  const deck = state.zones[deckZoneId];
  if (!deck || deck.orderedEntities.length === 0) return state;
  const top = deck.orderedEntities[0];
  const revealed: GameState = {
    ...state,
    entities: {
      ...state.entities,
      [top]: { ...state.entities[top], visibility: { type: 'PUBLIC' } }
    }
  };
  return ECSManager.moveEntity(revealed, top, targetZoneId);
}
