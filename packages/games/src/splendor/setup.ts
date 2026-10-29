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
  pokemartDeck: 'zone_deck_pokemart',
  hand: (playerId: string): string => `zone_hand_${playerId}`,
  tableau: (playerId: string): string => `zone_tableau_${playerId}`,
  buried: (playerId: string): string => `zone_buried_${playerId}`
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

type CardTierTag = 'stage1' | 'stage2' | 'stage3' | 'rare' | 'legend' | 'mega' | 'pokemart';

const TIER_LABEL: Record<CardTierTag, string> = {
  stage1: 'STAGE_1',
  stage2: 'STAGE_2',
  stage3: 'STAGE_3',
  rare: 'RARE',
  legend: 'LEGEND',
  mega: 'MEGA',
  pokemart: 'POKEMART'
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
  const tierIndex = tag === 'stage1' ? 1 : tag === 'stage2' ? 2 : tag === 'stage3' ? 3 : 0;
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
 * Build the initial position.
 *
 * `playerCount` is persisted into `globalVars.playerCount`; every rule reads the
 * seat count from there instead of hardcoding it. The exported signature stays
 * `setupSplendor(seed)` (2 seats) so existing callers keep working.
 */
export function setupSplendor(seed: number = 42, playerCount: number = MIN_PLAYERS): GameState {
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
        buriedIds: []
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
      /** Someone reached WIN_SCORE — play out the current round, then score. */
      lastRound: false,
      finalRoundComplete: false,
      scoreToWin: WIN_SCORE,
      maxTokens: MAX_TOKENS,
      maxReserves: MAX_RESERVES
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
  // Mega Evolution / Poké Mart are part of the imported deck but their rules
  // land in a later pass; they are stored as inert face-down piles.
  state = ECSManager.createZone(state, SPLENDOR_ZONES.megaDeck, 'Mega Evolution Deck', 'DECK', { type: 'HIDDEN' }, undefined, 'STACK', [-6.0, 0.06, -3.4]);
  state = ECSManager.createZone(state, SPLENDOR_ZONES.pokemartDeck, 'Poké Mart Deck', 'DECK', { type: 'HIDDEN' }, undefined, 'STACK', [-8.4, 0.06, -3.4]);

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

  const deckPlans: { tag: CardTierTag; deck: string; cards: (PkmnCard | PkmnMegaCard | PkmnMartCard)[] }[] = [
    { tag: 'stage1', deck: SPLENDOR_ZONES.deck(1), cards: PKMN_DECK.stage1 },
    { tag: 'stage2', deck: SPLENDOR_ZONES.deck(2), cards: PKMN_DECK.stage2 },
    { tag: 'stage3', deck: SPLENDOR_ZONES.deck(3), cards: PKMN_DECK.stage3 },
    { tag: 'rare', deck: SPLENDOR_ZONES.rareDeck, cards: PKMN_DECK.rare },
    { tag: 'legend', deck: SPLENDOR_ZONES.legendDeck, cards: PKMN_DECK.legend },
    { tag: 'mega', deck: SPLENDOR_ZONES.megaDeck, cards: PKMN_DECK.mega },
    { tag: 'pokemart', deck: SPLENDOR_ZONES.pokemartDeck, cards: PKMN_DECK.pokemart }
  ];

  for (const plan of deckPlans) {
    const ordered = shuffled(plan.cards);
    for (const card of ordered) {
      state = ECSManager.addEntity(state, toCardEntity(card, plan.tag, plan.deck, { type: 'HIDDEN' }));
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
