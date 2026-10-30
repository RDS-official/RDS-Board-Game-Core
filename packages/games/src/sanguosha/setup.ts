import { ECSManager } from '@rds/kernel/ecs';
import { Entity, GameState, Player } from '@rds/kernel/types';

export function setupSanguosha(seed: number = 42): GameState {
  let prngSeed = seed;

  // 1. Players & Roles
  // Lord (p1), Loyalist (p2), Rebel (p3), Spy (p4)
  const players: Record<string, Player> = {
    p1: {
      id: 'p1',
      name: 'Liu Bei (Lord)',
      color: '#e53935',
      avatar: '👑',
      score: 4, // Max HP
      alive: true,
      role: 'LORD',
      secretRole: 'LORD',
      handZoneId: 'zone_hand_p1',
      customProps: { hp: 4, maxHp: 4, hero: 'Liu Bei', characterSkill: 'Rende (Benevolence)' }
    },
    p2: {
      id: 'p2',
      name: 'Guan Yu (Loyalist)',
      color: '#43a047',
      avatar: '⚔️',
      score: 4,
      alive: true,
      role: 'LOYALIST',
      secretRole: 'LOYALIST',
      handZoneId: 'zone_hand_p2',
      customProps: { hp: 4, maxHp: 4, hero: 'Guan Yu', characterSkill: 'Wusheng (Martial Sage)' }
    },
    p3: {
      id: 'p3',
      name: 'Cao Cao (Rebel)',
      color: '#1e88e5',
      avatar: '🗡️',
      score: 4,
      alive: true,
      role: 'REBEL',
      secretRole: 'REBEL',
      handZoneId: 'zone_hand_p3',
      customProps: { hp: 4, maxHp: 4, hero: 'Cao Cao', characterSkill: 'Jianxiong' }
    },
    p4: {
      id: 'p4',
      name: 'Lu Bu (Spy)',
      color: '#8e24aa',
      avatar: '🏹',
      score: 4,
      alive: true,
      role: 'SPY',
      secretRole: 'SPY',
      handZoneId: 'zone_hand_p4',
      customProps: { hp: 4, maxHp: 4, hero: 'Lu Bu', characterSkill: 'Wushuang (Matchless)' }
    }
  };

  const playerOrder = ['p1', 'p2', 'p3', 'p4'];

  // Map graph for circular seating distance: high-dimensional [seatIndex].
  const mapGraph = {
    nodes: {
      seat_p1: { id: 'seat_p1', type: 'SEAT' as const, position: [0], positionSpace: 'ring' as const, neighbors: ['seat_p2', 'seat_p4'], props: { playerId: 'p1', seatIndex: 0 } },
      seat_p2: { id: 'seat_p2', type: 'SEAT' as const, position: [1], positionSpace: 'ring' as const, neighbors: ['seat_p1', 'seat_p3'], props: { playerId: 'p2', seatIndex: 1 } },
      seat_p3: { id: 'seat_p3', type: 'SEAT' as const, position: [2], positionSpace: 'ring' as const, neighbors: ['seat_p2', 'seat_p4'], props: { playerId: 'p3', seatIndex: 2 } },
      seat_p4: { id: 'seat_p4', type: 'SEAT' as const, position: [3], positionSpace: 'ring' as const, neighbors: ['seat_p3', 'seat_p1'], props: { playerId: 'p4', seatIndex: 3 } }
    },
    edges: {},
    topology: {
      kind: 'ring' as const,
      adjacency: 'neighbors' as const,
      geometry: 'ring' as const,
      geometrySpec: { radiusX: 8.9, radiusZ: 5.6, origin: [0, 0.1, 0] as [number, number, number] }
    }
  };

  let state: GameState = {
    gameId: 'sanguosha',
    seed: prngSeed,
    seq: 0,
    clock: 0,
    round: 1,
    turn: 1,
    activePlayerId: 'p1',
    phase: 'ACTION_PHASE',
    players,
    playerOrder,
    entities: {},
    zones: {},
    mapGraph,
    globalVars: {
      drawDeckCount: 40,
      hasPlayedStrikeThisTurn: false
    },
    interruptStack: [],
    pendingDecisions: [],
    activeHooks: [],
    prngState: prngSeed,
    actionLog: [],
    winner: null,
    gameOver: false
  };

  // Create Zones
  state = ECSManager.createZone(state, 'zone_deck', 'Draw Pile', 'DECK', { type: 'HIDDEN' }, undefined, 'STACK', [-7.4, 0.06, -5.2]);
  state = ECSManager.createZone(state, 'zone_discard', 'Discard Pile', 'DISCARD', { type: 'PUBLIC' }, undefined, 'STACK', [-5.5, 0.06, -5.2]);

  playerOrder.forEach((pId, idx) => {
    state = ECSManager.createZone(state, `zone_hand_${pId}`, `${players[pId].name} Hand`, 'HAND', {
      type: 'OWNER_ONLY',
      ownerId: pId
    }, pId, 'FAN');

    state = ECSManager.createZone(state, `zone_equip_${pId}`, `${players[pId].name} Equipment`, 'EQUIP', {
      type: 'PUBLIC'
    }, pId, 'ROW');

    state = ECSManager.createZone(state, `zone_judge_${pId}`, `${players[pId].name} Judgement`, 'JUDGE', {
      type: 'PUBLIC'
    }, pId, 'ROW');
  });

  // Pre-generate deck of cards
  const cardBlueprints = [
    { title: 'Strike (杀)', type: 'BASIC', suit: '♠', rank: '7', color: '#212121', desc: 'Attack a target in range. Deal 1 damage unless dodged.' },
    { title: 'Strike (杀)', type: 'BASIC', suit: '♥', rank: '8', color: '#d32f2f', desc: 'Attack a target in range. Deal 1 damage unless dodged.' },
    { title: 'Strike (杀)', type: 'BASIC', suit: '♣', rank: '9', color: '#212121', desc: 'Attack a target in range. Deal 1 damage unless dodged.' },
    { title: 'Strike (杀)', type: 'BASIC', suit: '♦', rank: '10', color: '#d32f2f', desc: 'Attack a target in range. Deal 1 damage unless dodged.' },
    { title: 'Dodge (闪)', type: 'BASIC', suit: '♦', rank: '2', color: '#d32f2f', desc: 'Negate an incoming Strike.' },
    { title: 'Dodge (闪)', type: 'BASIC', suit: '♥', rank: 'K', color: '#d32f2f', desc: 'Negate an incoming Strike.' },
    { title: 'Peach (桃)', type: 'BASIC', suit: '♥', rank: '3', color: '#d32f2f', desc: 'Recover 1 HP or rescue a dying player.' },
    { title: 'Peach (桃)', type: 'BASIC', suit: '♦', rank: '12', color: '#d32f2f', desc: 'Recover 1 HP or rescue a dying player.' },
    { title: 'Wu Xie Ke Ji (无懈可击)', type: 'TRICK', suit: '♣', rank: 'Q', color: '#212121', desc: 'Interrupt & cancel any trick card or another Wu Xie Ke Ji on the stack!' },
    { title: 'Wu Xie Ke Ji (无懈可击)', type: 'TRICK', suit: '♥', rank: 'J', color: '#d32f2f', desc: 'Interrupt & cancel any trick card or another Wu Xie Ke Ji on the stack!' },
    { title: 'Dismantle (过河拆桥)', type: 'TRICK', suit: '♠', rank: '3', color: '#212121', desc: 'Discard 1 card from any player.' },
    { title: 'Snatch (顺手牵羊)', type: 'TRICK', suit: '♦', rank: '3', color: '#d32f2f', desc: 'Steal 1 card from an adjacent player.' },
    { title: 'Barbarian Invasion (南蛮入侵)', type: 'TRICK', suit: '♠', rank: '7', color: '#212121', desc: 'All other players must play a Strike or take 1 damage.' },
    { title: 'Eight Trigrams (八卦阵)', type: 'ARMOR', suit: '♠', rank: '2', color: '#212121', desc: 'When you need to Dodge, judge top deck card: if Red, count as Dodge!' },
    { title: 'Green Dragon Crescent Blade (青龙偃月刀)', type: 'WEAPON', suit: '♠', rank: '5', color: '#212121', desc: 'Range 3. When your Strike is dodged, you may play another Strike.' }
  ];

  // Deal 4 initial cards to each player's hand
  let cardCounter = 0;
  playerOrder.forEach(pId => {
    for (let c = 0; c < 4; c++) {
      const bp = cardBlueprints[cardCounter % cardBlueprints.length];
      const cardEntity: Entity = {
        id: `card_${cardCounter}`,
        type: 'CARD',
        zoneId: `zone_hand_${pId}`,
        ownerId: pId,
        visibility: { type: 'OWNER_ONLY', ownerId: pId },
        components: {
          cardFace: { ...bp }
        }
      };
      state = ECSManager.addEntity(state, cardEntity);
      cardCounter++;
    }
  });

  // Put remainder into draw deck
  for (let c = cardCounter; c < 30; c++) {
    const bp = cardBlueprints[c % cardBlueprints.length];
    const cardEntity: Entity = {
      id: `card_${c}`,
      type: 'CARD',
      zoneId: 'zone_deck',
      visibility: { type: 'HIDDEN' },
      components: {
        cardFace: { ...bp }
      }
    };
    state = ECSManager.addEntity(state, cardEntity);
  }

  // Pre-equip Guan Yu with Green Dragon Blade and Liu Bei with Eight Trigrams
  const baGuaCard: Entity = {
    id: 'equip_bagua_p1',
    type: 'CARD',
    zoneId: 'zone_equip_p1',
    ownerId: 'p1',
    visibility: { type: 'PUBLIC' },
    components: {
      cardFace: { title: 'Eight Trigrams (八卦阵)', type: 'ARMOR', suit: '♠', rank: '2', color: '#212121', desc: 'Judge red for Dodge' }
    }
  };
  state = ECSManager.addEntity(state, baGuaCard);

  // Register AOP rule hook instance (implementation lives in hooks.ts)
  state = {
    ...state,
    activeHooks: [
      {
        instanceId: 'bagua_p1',
        hookId: 'bagua_armor',
        ownerId: 'p1',
        visibility: { type: 'PUBLIC' },
        params: {}
      }
    ]
  };

  return state;
}
