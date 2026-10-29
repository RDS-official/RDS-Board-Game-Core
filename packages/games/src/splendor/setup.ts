import { ECSManager } from '@rds/kernel/ecs';
import { Entity, GameState, Player } from '@rds/kernel/types';
import pkmnData from './pokemonData.json';

/** Imported Pokémon Splendor card database (Ethan9123/pokemon-splendor). */
export const PKMN_DECK = {
  stage1: pkmnData.cards.filter(c => c.id.startsWith('s1_')),
  stage2: pkmnData.cards.filter(c => c.id.startsWith('s2_')),
  stage3: pkmnData.cards.filter(c => c.id.startsWith('s3_')),
  rare: pkmnData.cards.filter(c => c.id.startsWith('rr_')),
  legend: pkmnData.cards.filter(c => c.id.startsWith('lg_')),
  mega: pkmnData.megas,
  pokemart: pkmnData.pokemart
};

export type GemType = 'diamond' | 'sapphire' | 'emerald' | 'ruby' | 'onyx';

export const GEM_COLORS: Record<GemType | 'gold', string> = {
  diamond: '#e0f7fa',  // White/diamond shimmer
  sapphire: '#1e88e5', // Deep Blue
  emerald: '#43a047',  // Emerald Green
  ruby: '#e53935',     // Ruby Red
  onyx: '#212121',     // Black Onyx
  gold: '#ffb300'      // Gold wild
};

/**
 * Pokémon Splendor color mapping.
 *
 * The Pokémon Splendor deck (Ethan9123/pokemon-splendor) uses six gem
 * colors. They map onto the classic Splendor five tokens plus gold:
 *   red    -> ruby     (red Poké Ball)
 *   blue   -> sapphire (great ball blue)
 *   black  -> onyx     (black ball / ultra)
 *   pink   -> diamond  (pink ball)
 *   yellow -> gold     (yellow ball)
 *   purple -> emerald  (purple / master ball)
 */
export const PKMN_COLOR_TO_GEM: Record<string, GemType | 'gold'> = {
  red: 'ruby',
  blue: 'sapphire',
  black: 'onyx',
  pink: 'diamond',
  yellow: 'gold',
  purple: 'emerald'
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

export function setupSplendor(seed: number = 42): GameState {
  const players: Record<string, Player> = {
    p1: {
      id: 'p1',
      name: 'Merchant Aldo',
      color: '#e53935',
      avatar: '💎',
      score: 0,
      alive: true,
      handZoneId: 'zone_hand_p1',
      customProps: {
        tokens: { diamond: 0, sapphire: 1, emerald: 1, ruby: 1, onyx: 0, gold: 0 },
        bonuses: { diamond: 0, sapphire: 0, emerald: 0, ruby: 0, onyx: 0 },
        purchasedCards: []
      }
    },
    p2: {
      id: 'p2',
      name: 'Guildmaster Beatrice',
      color: '#1e88e5',
      avatar: '👑',
      score: 0,
      alive: true,
      handZoneId: 'zone_hand_p2',
      customProps: {
        tokens: { diamond: 1, sapphire: 0, emerald: 1, ruby: 0, onyx: 1, gold: 0 },
        bonuses: { diamond: 0, sapphire: 0, emerald: 0, ruby: 0, onyx: 0 },
        purchasedCards: []
      }
    }
  };

  const playerOrder = ['p1', 'p2'];

  let state: GameState = {
    gameId: 'splendor',
    seed,
    seq: 0,
    clock: 0,
    round: 1,
    turn: 1,
    activePlayerId: 'p1',
    phase: 'TURN',
    players,
    playerOrder,
    entities: {},
    zones: {},
    mapGraph: { nodes: {}, edges: {}, topology: { kind: 'none', adjacency: 'none', geometry: 'none' } },
    globalVars: {
      bank: { diamond: 4, sapphire: 4, emerald: 4, ruby: 4, onyx: 4, gold: 5 }
    },
    interruptStack: [],
    pendingDecisions: [],
    activeHooks: [],
    prngState: seed,
    actionLog: [],
    winner: null,
    gameOver: false
  };

  // Create Zones
  state = ECSManager.createZone(state, 'zone_market_t1', 'Tier 1 Cards', 'MARKET', { type: 'PUBLIC' }, undefined, 'ROW', [-3, 0.1, 1.5]);
  state = ECSManager.createZone(state, 'zone_market_t2', 'Tier 2 Cards', 'MARKET', { type: 'PUBLIC' }, undefined, 'ROW', [-3, 0.1, 0]);
  state = ECSManager.createZone(state, 'zone_market_t3', 'Tier 3 Cards', 'MARKET', { type: 'PUBLIC' }, undefined, 'ROW', [-3, 0.1, -1.5]);
  state = ECSManager.createZone(state, 'zone_nobles', 'Noble Patrons', 'MARKET', { type: 'PUBLIC' }, undefined, 'ROW', [-6, 0.1, 0]);

  playerOrder.forEach(pId => {
    state = ECSManager.createZone(state, `zone_hand_${pId}`, `${players[pId].name} Reserve`, 'HAND', {
      type: 'OWNER_ONLY',
      ownerId: pId
    }, pId);
    state = ECSManager.createZone(state, `zone_tableau_${pId}`, `${players[pId].name} Purchased Cards`, 'GRID', {
      type: 'PUBLIC'
    }, pId);
  });

  interface CardData {
    title: string;
    cost: Record<string, number>;
    gem: GemType;
    vp: number;
  }

  // Pre-generate Tier 1, 2, 3 cards
  const t1Cards: CardData[] = [
    { title: 'T1 Diamond Mine', cost: { sapphire: 1, emerald: 2, ruby: 1, onyx: 1 }, gem: 'diamond', vp: 0 },
    { title: 'T1 Sapphire Cutter', cost: { diamond: 1, emerald: 1, ruby: 1, onyx: 1 }, gem: 'sapphire', vp: 0 },
    { title: 'T1 Emerald Workshop', cost: { diamond: 2, sapphire: 1, ruby: 0, onyx: 2 }, gem: 'emerald', vp: 0 },
    { title: 'T1 Ruby Quarry', cost: { diamond: 1, sapphire: 2, emerald: 1, onyx: 1 }, gem: 'ruby', vp: 0 },
    { title: 'T1 Onyx Foundry', cost: { diamond: 2, sapphire: 2, emerald: 0, ruby: 1 }, gem: 'onyx', vp: 0 },
    { title: 'T1 High Diamond', cost: { sapphire: 2, emerald: 2, ruby: 0, onyx: 1 }, gem: 'diamond', vp: 1 }
  ];

  const t2Cards: CardData[] = [
    { title: 'T2 Diamond Trading Post', cost: { diamond: 2, sapphire: 3, onyx: 3 }, gem: 'diamond', vp: 1 },
    { title: 'T2 Sapphire Galleon', cost: { emerald: 4, ruby: 2, onyx: 1 }, gem: 'sapphire', vp: 2 },
    { title: 'T2 Emerald Merchant Guild', cost: { diamond: 3, ruby: 3, onyx: 2 }, gem: 'emerald', vp: 2 },
    { title: 'T2 Ruby Estate', cost: { diamond: 4, sapphire: 2, emerald: 1 }, gem: 'ruby', vp: 2 },
    { title: 'T2 Onyx Manor', cost: { sapphire: 4, emerald: 2, ruby: 1 }, gem: 'onyx', vp: 3 }
  ];

  const t3Cards: CardData[] = [
    { title: 'T3 Diamond Palace', cost: { sapphire: 3, emerald: 3, ruby: 5, onyx: 3 }, gem: 'diamond', vp: 4 },
    { title: 'T3 Sapphire Cathedral', cost: { diamond: 6, emerald: 3, ruby: 3 }, gem: 'sapphire', vp: 4 },
    { title: 'T3 Imperial Emerald Fortress', cost: { diamond: 3, sapphire: 3, ruby: 3, onyx: 5 }, gem: 'emerald', vp: 5 },
    { title: 'T3 Ruby Crown Treasury', cost: { diamond: 7, onyx: 3 }, gem: 'ruby', vp: 5 }
  ];

  const nobleTiles = [
    { title: 'Mary Stuart', requirements: { diamond: 4, sapphire: 4 }, vp: 3 },
    { title: 'King Henry VIII', requirements: { ruby: 4, onyx: 4 }, vp: 3 },
    { title: 'Francis I of France', requirements: { emerald: 3, sapphire: 3, diamond: 3 }, vp: 3 }
  ];

  // Add cards to zones
  t1Cards.forEach((c, idx) => {
    const entity: Entity = {
      id: `card_t1_${idx}`,
      type: 'CARD',
      zoneId: 'zone_market_t1',
      visibility: { type: 'PUBLIC' },
      components: {
        cardFace: {
          title: c.title,
          type: 'TIER_1',
          score: c.vp,
          cost: c.cost,
          desc: `+1 ${c.gem} permanent bonus, ${c.vp} VP`,
          color: GEM_COLORS[c.gem]
        },
        custom: { gem: c.gem, vp: c.vp, tier: 1, pkmnId: `t1_${idx}` }
      }
    };
    state = ECSManager.addEntity(state, entity);
  });

  t2Cards.forEach((c, idx) => {
    const entity: Entity = {
      id: `card_t2_${idx}`,
      type: 'CARD',
      zoneId: 'zone_market_t2',
      visibility: { type: 'PUBLIC' },
      components: {
        cardFace: {
          title: c.title,
          type: 'TIER_2',
          score: c.vp,
          cost: c.cost,
          desc: `+1 ${c.gem} permanent bonus, ${c.vp} VP`,
          color: GEM_COLORS[c.gem]
        },
        custom: { gem: c.gem, vp: c.vp, tier: 2, pkmnId: `t2_${idx}` }
      }
    };
    state = ECSManager.addEntity(state, entity);
  });

  t3Cards.forEach((c, idx) => {
    const entity: Entity = {
      id: `card_t3_${idx}`,
      type: 'CARD',
      zoneId: 'zone_market_t3',
      visibility: { type: 'PUBLIC' },
      components: {
        cardFace: {
          title: c.title,
          type: 'TIER_3',
          score: c.vp,
          cost: c.cost,
          desc: `+1 ${c.gem} permanent bonus, ${c.vp} VP`,
          color: GEM_COLORS[c.gem]
        },
        custom: { gem: c.gem, vp: c.vp, tier: 3, pkmnId: `t3_${idx}` }
      }
    };
    state = ECSManager.addEntity(state, entity);
  });

  nobleTiles.forEach((n, idx) => {
    const entity: Entity = {
      id: `noble_${idx}`,
      type: 'TILE',
      zoneId: 'zone_nobles',
      visibility: { type: 'PUBLIC' },
      components: {
        cardFace: {
          title: n.title,
          type: 'NOBLE',
          score: n.vp,
          desc: `Requires bonuses: ${Object.entries(n.requirements).map(([g, v]) => `${v} ${g}`).join(', ')}`
        },
        custom: { requirements: n.requirements, vp: n.vp, pkmnId: `noble_${idx}` }
      }
    };
    state = ECSManager.addEntity(state, entity);
  });

  return state;
}
