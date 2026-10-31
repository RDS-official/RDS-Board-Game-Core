/**
 * Betrayal at House on the Hill — initial position s0.
 *
 * Starting board: Entrance Hall / Foyer / Grand Staircase (ground),
 * Upper Landing, Basement Landing. Three explorers by default (up to six
 * characters are available for scenarios and tests).
 */

import { ECSManager } from '@rds/kernel/ecs';
import { DeterministicPRNG } from '@rds/kernel/prng';
import { Entity, GameState, Player } from '@rds/kernel/types';
import {
  EVENT_DEFS,
  Floor,
  FLOOR_META,
  ITEM_DEFS,
  OMEN_DEFS,
  ROOM_DECK_IDS,
  ROOM_DEFS,
  TraitKey,
  TRAIT_KEYS
} from './cards';
import { addRoomNode, connectRooms, FLOOR_ANCHORS, makeCardEntity, resetTurnResources } from './helpers';

export interface CharacterDef {
  id: string;
  name: string;
  en: string;
  color: string;
  avatar: string;
  tracks: Record<TraitKey, number[]>;
  startIndex: Record<TraitKey, number>;
}

export const CHARACTERS: CharacterDef[] = [
  {
    id: 'ox',
    name: '公牛奥克斯',
    en: 'Ox Bellows',
    color: '#e53935',
    avatar: '🛡️',
    tracks: {
      speed: [0, 1, 2, 3, 3, 4, 4, 5],
      might: [0, 2, 3, 4, 4, 5, 5, 6],
      sanity: [0, 1, 1, 2, 2, 3, 3, 4],
      knowledge: [0, 1, 1, 2, 2, 3, 3, 4]
    },
    startIndex: { speed: 5, might: 5, sanity: 5, knowledge: 5 }
  },
  {
    id: 'rhinehardt',
    name: '莱因哈特神父',
    en: 'Father Rhinehardt',
    color: '#1e88e5',
    avatar: '✝️',
    tracks: {
      speed: [0, 1, 2, 2, 3, 3, 4, 4],
      might: [0, 1, 1, 2, 2, 3, 3, 4],
      sanity: [0, 2, 3, 4, 5, 5, 6, 7],
      knowledge: [0, 2, 3, 4, 4, 5, 5, 6]
    },
    startIndex: { speed: 4, might: 3, sanity: 4, knowledge: 3 }
  },
  {
    id: 'zoe',
    name: '佐伊·英格斯特罗姆',
    en: 'Zoe Ingstrom',
    color: '#43a047',
    avatar: '👧',
    tracks: {
      speed: [0, 2, 3, 4, 4, 5, 5, 6],
      might: [0, 1, 1, 2, 2, 2, 3, 3],
      sanity: [0, 2, 3, 4, 4, 5, 5, 6],
      knowledge: [0, 2, 3, 4, 4, 5, 5, 6]
    },
    startIndex: { speed: 3, might: 3, sanity: 3, knowledge: 4 }
  },
  {
    id: 'brandon',
    name: '布兰登·贾斯珀斯',
    en: 'Brandon Jaspers',
    color: '#8e24aa',
    avatar: '🧢',
    tracks: {
      speed: [0, 1, 2, 3, 3, 4, 4, 5],
      might: [0, 2, 3, 4, 4, 5, 5, 6],
      sanity: [0, 1, 2, 2, 3, 3, 4, 4],
      knowledge: [0, 1, 2, 3, 3, 4, 4, 5]
    },
    startIndex: { speed: 5, might: 4, sanity: 4, knowledge: 4 }
  },
  {
    id: 'missy',
    name: '米西·杜布尔德',
    en: 'Missy Dubourde',
    color: '#f06292',
    avatar: '🩰',
    tracks: {
      speed: [0, 2, 3, 4, 5, 5, 6, 7],
      might: [0, 1, 1, 2, 2, 2, 3, 3],
      sanity: [0, 2, 3, 3, 4, 4, 5, 5],
      knowledge: [0, 1, 2, 3, 3, 4, 4, 5]
    },
    startIndex: { speed: 4, might: 3, sanity: 4, knowledge: 4 }
  },
  {
    id: 'flash',
    name: '闪电威廉姆斯',
    en: 'Flash Williams',
    color: '#ffb300',
    avatar: '⚡',
    tracks: {
      speed: [0, 2, 3, 4, 5, 5, 6, 7],
      might: [0, 2, 3, 4, 4, 5, 5, 6],
      sanity: [0, 1, 1, 2, 2, 3, 3, 4],
      knowledge: [0, 1, 2, 2, 3, 3, 4, 4]
    },
    startIndex: { speed: 3, might: 3, sanity: 3, knowledge: 4 }
  }
];

export const DEFAULT_ROSTER = ['ox', 'rhinehardt', 'zoe'];

function traitsFromTracks(character: CharacterDef): Record<TraitKey, number> {
  return Object.fromEntries(
    TRAIT_KEYS.map(trait => [trait, character.tracks[trait][character.startIndex[trait]]])
  ) as Record<TraitKey, number>;
}

export function makePlayer(character: CharacterDef, playerId: string, roomId: string): Player {
  return {
    id: playerId,
    name: character.name,
    color: character.color,
    avatar: character.avatar,
    score: 0,
    alive: true,
    role: 'EXPLORER',
    handZoneId: `zone_hand_${playerId}`,
    customProps: {
      character: character.id,
      en: character.en,
      tracks: character.tracks,
      traitIndex: { ...character.startIndex },
      startIndex: { ...character.startIndex },
      traits: traitsFromTracks(character),
      currentRoomId: roomId,
      floor: 'GROUND',
      movesLeft: traitsFromTracks(character).speed,
      attacksLeft: 0,
      usedItems: [],
      effects: [],
      maskWorn: false,
      controlled: false,
      immuneMindControl: false,
      resonance: false
    }
  };
}

function addCardDeck(
  state: GameState,
  zoneId: string,
  type: 'EVENT' | 'ITEM' | 'OMEN',
  order: string[],
  faceOf: (defId: string) => { name: string; en: string; desc: string; companion?: boolean; tradeable?: boolean },
  extraOf: (defId: string) => Record<string, unknown> = () => ({})
): GameState {
  for (const defId of order) {
    const face = faceOf(defId);
    const entity = makeCardEntity(
      `${type.toLowerCase()}_${defId}`,
      zoneId,
      defId,
      type,
      face,
      { ...extraOf(defId), companion: !!face.companion, tradeable: face.tradeable ?? true }
    );
    state = ECSManager.addEntity(state, entity);
  }
  return state;
}

export function setupBetrayal(seed: number = 42, roster: string[] = DEFAULT_ROSTER): GameState {
  let cursor = seed >>> 0;

  const eventShuffle = DeterministicPRNG.shuffle(cursor, Object.keys(EVENT_DEFS));
  cursor = eventShuffle.nextSeed;
  const itemShuffle = DeterministicPRNG.shuffle(cursor, Object.keys(ITEM_DEFS));
  cursor = itemShuffle.nextSeed;
  const omenShuffle = DeterministicPRNG.shuffle(cursor, Object.keys(OMEN_DEFS));
  cursor = omenShuffle.nextSeed;
  const roomShuffle = DeterministicPRNG.shuffle(cursor, ROOM_DECK_IDS);
  cursor = roomShuffle.nextSeed;

  const characters = roster
    .map(id => CHARACTERS.find(character => character.id === id))
    .filter((character): character is CharacterDef => !!character);

  const players: Record<string, Player> = {};
  const playerOrder: string[] = [];
  characters.forEach((character, index) => {
    const playerId = `p${index + 1}`;
    players[playerId] = makePlayer(character, playerId, 'room_entrance_hall');
    playerOrder.push(playerId);
  });

  let state: GameState = {
    gameId: 'betrayal',
    seed,
    seq: 0,
    clock: 0,
    round: 1,
    turn: 1,
    activePlayerId: playerOrder[0] ?? 'p1',
    phase: 'EXPLORATION',
    players,
    playerOrder,
    entities: {},
    zones: {},
    mapGraph: {
      nodes: {},
      edges: {},
      topology: {
        kind: 'graph',
        adjacency: 'both',
        directed: true,
        weighted: false,
        geometry: 'grid',
        geometrySpec: {
          cellSize: 2.86,
          origin: [0, 0.05, 0],
          gridOrigin: [2, 2],
          layerAxis: 'x',
          layerMode: 'auto',
          layerSpacing: 3
        },
        layers: [
          { id: 'BASEMENT', name: '地下室', index: 0, tag: 'B' },
          { id: 'GROUND', name: '一楼', index: 1, tag: '1F' },
          { id: 'UPPER', name: '二楼', index: 2, tag: '2F' }
        ]
      }
    },
    globalVars: {
      hauntTriggered: false,
      haunt: null,
      omensRevealed: 0,
      omenNames: [],
      roomDeckTotal: roomShuffle.result.length,
      pendingHauntRoll: null,
      frostRooms: [],
      lastRoll: null,
      lastNarration: '',
      floorAnchors: FLOOR_ANCHORS
    },
    interruptStack: [],
    pendingDecisions: [],
    activeHooks: [],
    prngState: cursor,
    actionLog: [],
    winner: null,
    gameOver: false
  };

  /* ------------------------------ board ---------------------------------- */
  const place = (defId: string, col: number, row: number, rotation = 0): string => {
    const def = ROOM_DEFS[defId];
    const nodeId = `room_${defId}`;
    addRoomNode(state, def, col, row, rotation, nodeId);
    return nodeId;
  };

  place('entrance_hall', 2, 0);
  place('foyer', 2, 1);
  place('grand_staircase', 2, 2);
  place('upper_landing', 2, 2);
  place('basement_landing', 2, 2);

  connectRooms(state, 'room_entrance_hall', 'room_foyer', 'DOOR', 'S');
  connectRooms(state, 'room_foyer', 'room_grand_staircase', 'DOOR', 'S');
  connectRooms(state, 'room_grand_staircase', 'room_upper_landing', 'STAIRS', '上');
  connectRooms(state, 'room_grand_staircase', 'room_basement_landing', 'STAIRS', '下');

  /* ------------------------------ zones ---------------------------------- */
  const zoneSpecs: [string, string, 'DECK' | 'DISCARD' | 'BOARD', [number, number, number]][] = [
    ['zone_event_deck', '事件牌堆', 'DECK', [-12, 0.06, 9.2]],
    ['zone_item_deck', '物品牌堆', 'DECK', [-6.5, 0.06, 9.2]],
    ['zone_omen_deck', '预兆牌堆', 'DECK', [-1, 0.06, 9.2]],
    ['zone_event_discard', '事件弃牌堆', 'DISCARD', [4.5, 0.06, 9.2]],
    ['zone_item_discard', '物品弃牌堆', 'DISCARD', [10, 0.06, 9.2]],
    ['zone_omen_discard', '预兆弃牌堆', 'DISCARD', [15.5, 0.06, 9.2]],
    ['zone_room_deck', '房间板块堆', 'DECK', [-12, 0.06, 7.4]],
    ['zone_room_discard', '房间板块弃置', 'DISCARD', [-6.5, 0.06, 7.4]],
    ['zone_room_placed', '已放置板块', 'BOARD', [16.0, 0.06, 3.8]],
    ['zone_monsters', '怪物区', 'BOARD', [15.5, 0.06, 6.5]]
  ];

  for (const [id, name, type, anchor] of zoneSpecs) {
    state = ECSManager.createZone(
      state,
      id,
      name,
      type,
      type === 'BOARD' ? { type: 'PUBLIC' } : { type: 'HIDDEN' },
      undefined,
      type === 'BOARD' ? 'ROW' : 'STACK',
      anchor
    );
  }

  for (const [index, playerId] of playerOrder.entries()) {
    state = ECSManager.createZone(
      state,
      `zone_hand_${playerId}`,
      `${players[playerId].name} · 物品与预兆`,
      'HAND',
      { type: 'PUBLIC' },
      playerId,
      'ROW',
      [-12 + index * 4.5, 0.13, 6.4]
    );
  }

  /* ------------------------------ decks ---------------------------------- */
  state = addCardDeck(
    state,
    'zone_event_deck',
    'EVENT',
    eventShuffle.result,
    defId => ({ name: EVENT_DEFS[defId].name, en: EVENT_DEFS[defId].en, desc: EVENT_DEFS[defId].desc, tradeable: false }),
    defId => ({ canonical: EVENT_DEFS[defId].canonical, category: EVENT_DEFS[defId].category })
  );

  state = addCardDeck(
    state,
    'zone_item_deck',
    'ITEM',
    itemShuffle.result,
    defId => ({
      name: ITEM_DEFS[defId].name,
      en: ITEM_DEFS[defId].en,
      desc: ITEM_DEFS[defId].desc,
      tradeable: ITEM_DEFS[defId].tradeable
    }),
    defId => ({ charges: ITEM_DEFS[defId].charges ?? 0, kind: ITEM_DEFS[defId].kind, stealable: ITEM_DEFS[defId].stealable !== false })
  );

  state = addCardDeck(
    state,
    'zone_omen_deck',
    'OMEN',
    omenShuffle.result,
    defId => ({
      name: OMEN_DEFS[defId].name,
      en: OMEN_DEFS[defId].en,
      desc: OMEN_DEFS[defId].desc,
      companion: !!OMEN_DEFS[defId].companion,
      tradeable: OMEN_DEFS[defId].tradeable
    })
  );

  for (const defId of roomShuffle.result) {
    const def = ROOM_DEFS[defId];
    const entity: Entity = {
      id: `roomtile_${defId}`,
      type: 'TILE',
      zoneId: 'zone_room_deck',
      visibility: { type: 'HIDDEN' },
      components: {
        cardFace: {
          title: def.name,
          type: 'ROOM',
          desc: def.text,
          color: FLOOR_META[def.floor].color
        },
        custom: { roomDefId: defId, floor: def.floor, zh: def.name }
      }
    };
    state = ECSManager.addEntity(state, entity);
  }


  // Official rule: the front door stays locked until a haunt opens it.
  state.globalVars.frontDoorLocked = true;

  resetTurnResources(state, state.activePlayerId);

  return state;
}

/** Total tile count helper used by tests and docs. */
export const ROOM_TILE_TOTAL = Object.keys(ROOM_DEFS).length;
export const FLOOR_TOTALS: Record<Floor, number> = {
  GROUND: Object.values(ROOM_DEFS).filter(room => room.floor === 'GROUND').length,
  UPPER: Object.values(ROOM_DEFS).filter(room => room.floor === 'UPPER').length,
  BASEMENT: Object.values(ROOM_DEFS).filter(room => room.floor === 'BASEMENT').length
};
