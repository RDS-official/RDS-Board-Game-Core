/**
 * Betrayal at House on the Hill — content tables.
 *
 * Everything in this file is *data*. The reducer interprets it; no state is
 * stored here and nothing is mutated. Keeping the 44 rooms / 13 omens /
 * 25 items / 45 events declarative means the kernel never needs to know about
 * Betrayal, and the tables can be replaced per printing without touching the
 * engine or the UI.
 *
 * Deck notes (see docs/BETRAYAL.md):
 *  - The brief states "22 items" but enumerates 25; all 25 are implemented.
 *  - The brief names 15 event cards; the remaining 30 slots are archetype
 *    fillers so the deck maths (45) hold. They are marked `canonical: false`.
 */

export type Floor = 'GROUND' | 'UPPER' | 'BASEMENT';
export type DoorDir = 'N' | 'S' | 'E' | 'W';
export type TraitKey = 'speed' | 'might' | 'sanity' | 'knowledge';
export type DamageKind = 'PHYSICAL' | 'MENTAL';
export type CardType = 'EVENT' | 'ITEM' | 'OMEN';

export const TRAIT_KEYS: TraitKey[] = ['speed', 'might', 'sanity', 'knowledge'];

export const TRAIT_META: Record<TraitKey, { zh: string; short: string; color: string; kind: DamageKind }> = {
  speed: { zh: '速度', short: '速', color: '#6aa6f5', kind: 'PHYSICAL' },
  might: { zh: '力量', short: '力', color: '#e0604e', kind: 'PHYSICAL' },
  sanity: { zh: '神智', short: '智', color: '#57c08b', kind: 'MENTAL' },
  knowledge: { zh: '知识', short: '识', color: '#b07bf0', kind: 'MENTAL' }
};

/* -------------------------------------------------------------------------- */
/* Rooms — 44 tiles, 5 of them starting tiles                                  */
/* -------------------------------------------------------------------------- */

export type RoomSpecial =
  | 'FRONT_DOOR'
  | 'STAIRS'
  | 'COLLAPSED'
  | 'COAL_CHUTE'
  | 'GALLERY'
  | 'BALCONY'
  | 'ELEVATOR'
  | 'CHASM'
  | 'VAULT'
  | 'FURNACE';

export interface RoomDef {
  id: string;
  name: string;
  en: string;
  floor: Floor;
  /** Allowed floors for placing this tile; if omitted, defaults to [floor]. */
  floors?: Floor[];
  /** Local door layout; the tile may be rotated when placed. */
  doors: DoorDir[];
  symbol?: 'EVENT' | 'ITEM' | 'OMEN';
  special?: RoomSpecial;
  /** Free-form tags consumed by haunts (fire, pentagram, crypt, ...). */
  tags?: string[];
  /** Direction of the front door on a FRONT_DOOR room (locked before the haunt). */
  frontDoor?: DoorDir;
  /**
   * House rule: ending your turn here permanently raises this trait by 1, once
   * per explorer per game. Not part of the official rules; enabled by request.
   */
  endTurnBuff?: 'speed' | 'might' | 'sanity' | 'knowledge';
  text: string;
}

const ROOM_LIST: RoomDef[] = [
  /* ------------------------------ GROUND (13) ----------------------------- */
  {
    id: 'entrance_hall',
    name: '门厅',
    en: 'Entrance Hall',
    floor: 'GROUND',
    doors: ['N', 'S', 'E'],
    special: 'FRONT_DOOR',
    frontDoor: 'N',
    tags: ['start', 'exit'],
    text: '山庄正门在此。前门被某种力量锁死，作祟结束前无法离开。'
  },
  {
    id: 'foyer',
    name: '前厅',
    en: 'Foyer',
    floor: 'GROUND',
    doors: ['N', 'S', 'E', 'W'],
    tags: ['start'],
    text: '挑高的前厅，湿冷的穿堂风从四面八方涌来。'
  },
  {
    id: 'grand_staircase',
    name: '大楼梯',
    en: 'Grand Staircase',
    floor: 'GROUND',
    doors: ['N', 'S'],
    special: 'STAIRS',
    tags: ['start', 'stairs'],
    text: '通往二楼与地下室的宏伟楼梯。'
  },
  {
    id: 'kitchen',
    name: '厨房',
    en: 'Kitchen',
    floor: 'GROUND',
    floors: ['BASEMENT', 'GROUND'],
    doors: ['N', 'E'],
    symbol: 'ITEM',
    tags: ['food'],
    text: '锈蚀的刀具与发霉的食材。',
  },
  {
    id: 'dining_room',
    name: '餐厅',
    en: 'Dining Room',
    floor: 'GROUND',
    doors: ['N', 'S', 'W'],
    symbol: 'EVENT',
    text: '长桌上摆着永远不会腐败的晚宴。'
  },
  {
    id: 'library',
    name: '图书馆',
    en: 'Library',
    floor: 'GROUND',
    floors: ['GROUND', 'UPPER'],
    doors: ['N', 'S', 'E'],
    symbol: 'ITEM',
    tags: ['books'],
    text: '直抵天花板的书架，藏着家族的秘密。',
    endTurnBuff: 'knowledge',
  },
  {
    id: 'conservatory',
    name: '温室',
    en: 'Conservatory',
    floor: 'GROUND',
    floors: ['GROUND', 'UPPER'],
    doors: ['S', 'E', 'W'],
    symbol: 'OMEN',
    tags: ['plants'],
    text: '玻璃穹顶下，藤蔓在不该生长的地方疯长。'
  },
  {
    id: 'chapel',
    name: '礼拜堂',
    en: 'Chapel',
    floor: 'GROUND',
    floors: ['GROUND', 'UPPER'],
    doors: ['N', 'E'],
    symbol: 'OMEN',
    tags: ['holy'],
    text: '彩窗上的圣徒全都背对着你。',
    endTurnBuff: 'sanity',
  },
  {
    id: 'gardens',
    name: '花园',
    en: 'Gardens',
    floor: 'GROUND',
    doors: ['N', 'S'],
    symbol: 'EVENT',
    tags: ['plants', 'outside'],
    text: '枯死的树篱围出一个听不见虫鸣的庭院。'
  },
  {
    id: 'graveyard',
    name: '墓园',
    en: 'Graveyard',
    floor: 'GROUND',
    doors: ['E', 'W'],
    symbol: 'OMEN',
    tags: ['graveyard', 'death'],
    text: '墓碑上的名字都被风雨磨平，只有一座新坟没有刻字。'
  },
  {
    id: 'gymnasium',
    name: '健身房',
    en: 'Gymnasium',
    floor: 'GROUND',
    floors: ['BASEMENT', 'GROUND', 'UPPER'],
    doors: ['N', 'E', 'S'],
    symbol: 'ITEM',
    text: '生锈的器械仍保持着被人使用过的角度。',
    endTurnBuff: 'speed',
  },

  /* ------------------------------- UPPER (15) ----------------------------- */
  {
    id: 'upper_landing',
    name: '二楼平台',
    en: 'Upper Landing',
    floor: 'UPPER',
    doors: ['N', 'S'],
    special: 'STAIRS',
    tags: ['start', 'stairs'],
    text: '楼梯尽头的长廊，墙上挂满被划花脸孔的肖像。'
  },
  {
    id: 'master_bedroom',
    name: '主卧',
    en: 'Master Bedroom',
    floor: 'UPPER',
    doors: ['N', 'S', 'W'],
    symbol: 'ITEM',
    text: '四柱床上铺着从未整理的被褥。'
  },
  {
    id: 'attic',
    name: '阁楼',
    en: 'Attic',
    floor: 'UPPER',
    doors: ['S', 'W'],
    symbol: 'OMEN',
    tags: ['dark'],
    text: '低矮的横梁下堆满了蒙尘的旧物。'
  },
  {
    id: 'balcony',
    name: '二楼露台',
    en: 'Balcony',
    floor: 'UPPER',
    doors: ['N', 'E'],
    symbol: 'OMEN',
    special: 'BALCONY',
    tags: ['outside', 'edge'],
    text: '俯瞰舞厅的二楼露台，栏杆早已朽坏。'
  },
  {
    id: 'tower',
    name: '塔楼',
    en: 'Tower',
    floor: 'UPPER',
    doors: ['S', 'E'],
    symbol: 'OMEN',
    tags: ['high'],
    text: '旋转的石阶通向山庄最高处，风声像有人在哭。'
  },
  {
    id: 'bedroom',
    name: '客房',
    en: 'Bedroom',
    floor: 'UPPER',
    doors: ['N', 'W'],
    symbol: 'EVENT',
    text: '客床的枕头上有新鲜的泪痕。'
  },
  {
    id: 'bloody_room',
    name: '血染之室',
    en: 'Bloody Room',
    floor: 'UPPER',
    floors: ['GROUND', 'UPPER'],
    doors: ['S', 'E'],
    symbol: 'EVENT',
    tags: ['blood'],
    text: '墙壁、地板与天花板都被喷溅状的血覆盖。'
  },
  {
    id: 'gallery',
    name: '楼座',
    en: 'Gallery',
    floor: 'UPPER',
    doors: ['N', 'S', 'E'],
    special: 'GALLERY',
    tags: ['edge'],
    text: '环绕舞厅的木质楼座，俯视下去令人眩晕。'
  },
  {
    id: 'collapsed_room',
    name: '坍塌之室',
    en: 'Collapsed Room',
    floor: 'UPPER',
    floors: ['GROUND', 'UPPER'],
    doors: ['N', 'W'],
    special: 'COLLAPSED',
    tags: ['collapse'],
    text: '整片地板塌陷成一个黑洞，直通地下。'
  },
  {
    id: 'observatory',
    name: '观星室',
    en: 'Observatory',
    floor: 'UPPER',
    doors: ['S', 'E'],
    tags: ['high', 'science'],
    text: '黄铜望远镜对准一片没有星星的天空。'
  },
  {
    id: 'junk_room',
    name: '杂物间',
    en: 'Junk Room',
    floor: 'UPPER',
    floors: ['BASEMENT', 'GROUND', 'UPPER'],
    doors: ['N', 'W'],
    text: '破家具与旧箱子堆得几乎无法通行。'
  },
  {
    id: 'ballroom',
    name: '舞厅',
    en: 'Ballroom',
    floor: 'GROUND',
    doors: ['N', 'S', 'E'],
    tags: ['ballroom'],
    text: '巨大的水晶灯下，舞池里没有一丝灰尘。'
  },

  /* ----------------------------- BASEMENT (16) ---------------------------- */
  {
    id: 'basement_landing',
    name: '地下平台',
    en: 'Basement Landing',
    floor: 'BASEMENT',
    doors: ['N', 'E'],
    special: 'STAIRS',
    tags: ['start', 'stairs'],
    text: '地下室的入口，霉味与铁锈味混在一起。'
  },
  {
    id: 'catacombs',
    name: '地下墓穴',
    en: 'Catacombs',
    floor: 'BASEMENT',
    doors: ['N', 'S', 'W'],
    symbol: 'OMEN',
    tags: ['crypt', 'catacombs', 'death'],
    text: '墙龛里层层叠叠地安放着家族成员的骸骨。'
  },
  {
    id: 'crypt',
    name: '地窖',
    en: 'Crypt',
    floor: 'BASEMENT',
    doors: ['N', 'E'],
    symbol: 'OMEN',
    tags: ['crypt', 'death'],
    text: '石棺横陈，棺盖内侧布满抓痕。'
  },
  {
    id: 'the_pentagram_chamber',
    name: '五芒星堂',
    en: 'Pentagram Chamber',
    floor: 'BASEMENT',
    doors: ['S', 'W'],
    symbol: 'OMEN',
    tags: ['pentagram', 'ritual'],
    text: '地面刻着巨大的五芒星，凹槽里是黑色的蜡。'
  },
  {
    id: 'furnace_room',
    name: '熔炉房',
    en: 'Furnace Room',
    floor: 'BASEMENT',
    doors: ['N', 'E'],
    symbol: 'EVENT',
    special: 'FURNACE',
    tags: ['fire', 'heat'],
    text: '巨大的铸铁熔炉仍在燃烧，热浪扭曲了空气。'
  },
  {
    id: 'coal_chute',
    name: '煤槽',
    en: 'Coal Chute',
    floor: 'BASEMENT',
    doors: ['S', 'W'],
    special: 'COAL_CHUTE',
    tags: ['chute'],
    text: '从地面直通地下的铁皮滑槽，边缘全是煤灰。'
  },
  {
    id: 'the_vault',
    name: '金库',
    en: 'Vault',
    floor: 'BASEMENT',
    floors: ['BASEMENT', 'UPPER'],
    doors: ['N', 'E'],
    special: 'VAULT',
    tags: ['vault', 'locked'],
    text: '厚重的钢门与转盘锁，门缝里透出冷气。'
  },
  {
    id: 'wine_cellar',
    name: '酒窖',
    en: 'Wine Cellar',
    floor: 'BASEMENT',
    doors: ['S', 'E'],
    text: '一排排酒架上落满灰尘，某些瓶子已经空了。'
  },
  {
    id: 'storeroom',
    name: '储藏室',
    en: 'Storeroom',
    floor: 'BASEMENT',
    floors: ['BASEMENT', 'UPPER'],
    doors: ['N', 'W'],
    symbol: 'ITEM',
    text: '罐头、工具与不知用途的箱子堆到天花板。'
  },
  {
    id: 'research_laboratory',
    name: '实验室',
    en: 'Laboratory',
    floor: 'BASEMENT',
    doors: ['N', 'E'],
    symbol: 'ITEM',
    tags: ['science'],
    text: '玻璃器皿里培养着不该存在的东西。'
  },
  {
    id: 'operating_laboratory',
    name: '手术室',
    en: 'Operating Laboratory',
    floor: 'BASEMENT',
    floors: ['BASEMENT', 'UPPER'],
    doors: ['S', 'W'],
    symbol: 'EVENT',
    tags: ['science', 'blood'],
    text: '手术台上绑着皮带，无影灯还亮着。'
  },
  {
    id: 'servants_quarters',
    name: '仆人房',
    en: "Servants' Quarters",
    floor: 'BASEMENT',
    floors: ['BASEMENT', 'UPPER'],
    doors: ['N', 'S'],
    symbol: 'EVENT',
    text: '狭窄的床铺排成一列，所有私人物品都不见了。'
  },
  {
    id: 'larder',
    name: '食品储藏间',
    en: 'Larder',
    floor: 'BASEMENT',
    doors: ['E', 'W'],
    tags: ['food'],
    text: '挂着风干肉的储藏间，苍蝇不知从何处而来。',
    endTurnBuff: 'might',
  },
  {
    id: 'underground_lake',
    name: '地下湖',
    en: 'Underground Lake',
    floor: 'BASEMENT',
    doors: ['N', 'S'],
    symbol: 'EVENT',
    tags: ['water'],
    text: '漆黑的水面一直延伸到岩壁深处。'
  },
  {
    id: 'mystic_elevator',
    name: '神秘电梯',
    en: 'Mystic Elevator',
    floor: 'BASEMENT',
    // The car is the one tile that belongs on every floor: it is drawn from the
    // deck on any level and it relocates between levels when ridden.',
    floors: ['BASEMENT', 'GROUND', 'UPPER'],
    // One door only: the elevator is a dead end you ride out of.
    doors: ['E'],
    special: 'ELEVATOR',
    tags: ['elevator'],
    text: '一个没有缆绳的电梯，按钮上刻着不存在的楼层。'
  }
,
  {
    id: 'stairs_from_basement',
    name: '地下室楼梯',
    en: 'Stairs from Basement',
    floor: 'BASEMENT',
    doors: ['N', 'S'],
    special: 'STAIRS',
    tags: ['stairs'],
    text: '通往门厅的暗门，只有发现它之后才能使用。'
  },
  {
    id: 'patio',
    name: '露台',
    en: 'Patio',
    floor: 'GROUND',
    doors: ['N', 'S', 'W'],
    symbol: 'EVENT',
    tags: ['outside'],
    text: '石板铺就的露台，雨后的水洼映着没有星光的夜。'
  },
  {
    id: 'abandoned_room',
    name: '废弃房间',
    en: 'Abandoned Room',
    floor: 'GROUND',
    floors: ['BASEMENT', 'GROUND'],
    doors: ['N', 'E', 'S', 'W'],
    symbol: 'OMEN',
    text: '家具被白布覆盖，像一排沉默的送葬者。'
  },
  {
    id: 'charred_room',
    name: '焦黑之室',
    en: 'Charred Room',
    floor: 'GROUND',
    floors: ['GROUND', 'UPPER'],
    doors: ['N', 'E', 'S', 'W'],
    symbol: 'OMEN',
    tags: ['fire'],
    text: '墙壁烧得焦黑，空气里仍有烟味。'
  },
  {
    id: 'organ_room',
    name: '管风琴室',
    en: 'Organ Room',
    floor: 'GROUND',
    floors: ['BASEMENT', 'GROUND', 'UPPER'],
    doors: ['S', 'W'],
    symbol: 'EVENT',
    tags: ['music'],
    text: '巨大的管风琴占据了整面墙，琴管里传出呼吸声。'
  },
  {
    id: 'statuary_corridor',
    name: '雕像长廊',
    en: 'Statuary Corridor',
    floor: 'GROUND',
    floors: ['BASEMENT', 'GROUND', 'UPPER'],
    doors: ['N', 'S'],
    symbol: 'EVENT',
    text: '一排大理石雕像，每一尊的脸都朝向你的方向。'
  },
  {
    id: 'creaky_hallway',
    name: '吱呀走廊',
    en: 'Creaky Hallway',
    floor: 'GROUND',
    floors: ['BASEMENT', 'GROUND', 'UPPER'],
    doors: ['N', 'E', 'S', 'W'],
    text: '每一块地板都在你脚下叫出声来。'
  },
  {
    id: 'dusty_hallway',
    name: '积尘走廊',
    en: 'Dusty Hallway',
    floor: 'GROUND',
    floors: ['BASEMENT', 'GROUND', 'UPPER'],
    doors: ['N', 'E', 'S', 'W'],
    text: '厚厚的灰尘上只有你自己的脚印。'
  },
  {
    id: 'game_room',
    name: '游戏室',
    en: 'Game Room',
    floor: 'GROUND',
    floors: ['BASEMENT', 'GROUND', 'UPPER'],
    doors: ['N', 'S', 'W'],
    symbol: 'EVENT',
    text: '台球桌上摆着一局未下完的棋。'
  },
  {
    id: 'chasm',
    name: '裂隙',
    en: 'Chasm',
    floor: 'BASEMENT',
    doors: ['E', 'W'],
    special: 'CHASM',
    tags: ['edge'],
    text: '地板裂开一道深不见底的口子。'
  }
];

export const ROOM_DEFS: Record<string, RoomDef> = Object.fromEntries(ROOM_LIST.map(room => [room.id, room]));

export const STARTING_ROOMS: Record<Floor, string> = {
  GROUND: 'entrance_hall',
  UPPER: 'upper_landing',
  BASEMENT: 'basement_landing'
};

/** Tiles that begin on the table and are therefore not in the room deck. */
export const STARTING_ROOM_IDS = [
  'entrance_hall',
  'foyer',
  'grand_staircase',
  'upper_landing',
  'basement_landing'
];

export const ROOM_DECK_IDS = ROOM_LIST.filter(room => !STARTING_ROOM_IDS.includes(room.id)).map(room => room.id);

export const FLOOR_META: Record<Floor, { zh: string; index: number; color: string }> = {
  BASEMENT: { zh: '地下室', index: 0, color: '#3d4d5c' },
  GROUND: { zh: '一楼', index: 1, color: '#6b4e39' },
  UPPER: { zh: '二楼', index: 2, color: '#58456d' }
};

/* -------------------------------------------------------------------------- */
/* Omens — 13                                                                  */
/* -------------------------------------------------------------------------- */

export interface TraitGrant {
  trait: TraitKey;
  amount: number;
}

export interface OmenDef {
  id: string;
  name: string;
  en: string;
  desc: string;
  /** Companions can never be traded, dropped or stolen. */
  companion?: boolean;
  tradeable: boolean;
  onGain?: TraitGrant[];
  onLoss?: TraitGrant[];
  /** Immediate hostile effect applied when the card is drawn. */
  onDrawAttack?: { dice: number; trait: TraitKey };
  usable?: boolean;
  useKind?: ItemUseKind;
  passive?: ItemPassive;
}

export interface ItemPassive {
  physicalArmor?: number;
  mentalArmor?: number;
  knowledgeDice?: number;
  sanityDice?: number;
  speedDice?: number;
  mightDice?: number;
  ranged?: boolean;
  revealTraitor?: boolean;
}

export type ItemUseKind =
  | 'ADRENALINE'
  | 'ANGEL_FEATHER'
  | 'BELL'
  | 'BOTTLE'
  | 'CRYSTAL_BALL'
  | 'DARK_DICE'
  | 'DIVINING'
  | 'DYNAMITE'
  | 'HEAL_PHYSICAL'
  | 'HEAL_MENTAL'
  | 'MEDICAL_KIT'
  | 'MUSIC_BOX'
  | 'PUZZLE_BOX'
  | 'SPIRIT_BOARD'
  | 'TOGGLE_MASK';

export interface ItemDef {
  id: string;
  name: string;
  en: string;
  desc: string;
  kind: 'weapon' | 'armor' | 'relic' | 'consumable' | 'tool';
  tradeable: boolean;
  /** Armor cannot be stolen; it may still be traded by consent. */
  stealable?: boolean;
  passive?: ItemPassive;
  charges?: number;
  usable?: boolean;
  consumable?: boolean;
  useKind?: ItemUseKind;
  onGain?: TraitGrant[];
  onLoss?: TraitGrant[];
}

export const OMEN_DEFS: Record<string, OmenDef> = Object.fromEntries(
  (
    [
      {
        id: 'bite',
        name: '噬咬',
        en: 'Bite',
        desc: '不可名状之物从暗处扑出。右侧玩家代掷 4 颗骰对你进行一次力量攻击。此卡留在你面前作为预兆，不可交易或丢弃。',
        tradeable: false,
        onDrawAttack: { dice: 4, trait: 'might' }
      },
      {
        id: 'book',
        name: '禁忌古籍',
        en: 'Book',
        desc: '获得时知识 +2；失去此书时知识 -2。',
        tradeable: true,
        onGain: [{ trait: 'knowledge', amount: 2 }],
        onLoss: [{ trait: 'knowledge', amount: -2 }]
      },
      {
        id: 'crystal_ball',
        name: '水晶球',
        en: 'Crystal Ball',
        desc: '每回合一次：查看物品或事件牌堆顶牌。无需检定，也不会把牌抽走。',
        tradeable: true,
        usable: true,
        useKind: 'CRYSTAL_BALL'
      },
      {
        id: 'dog',
        name: '脏狗',
        en: 'Dog',
        desc: '随从。获得时力量与神智各 +1；失去时各 -1。狗跟随主人，不能乘神秘电梯、不能走单行道或需要检定的通道。不可交易、丢弃或被盗。',
        companion: true,
        tradeable: false,
        onGain: [
          { trait: 'might', amount: 1 },
          { trait: 'sanity', amount: 1 }
        ],
        onLoss: [
          { trait: 'might', amount: -1 },
          { trait: 'sanity', amount: -1 }
        ],
        usable: false,
      },
      {
        id: 'girl',
        name: '小女孩',
        en: 'Girl',
        desc: '随从。获得时神智与知识各 +1；失去时各 -1。许多驱邪与献祭剧本的关键实体。不可交易、丢弃或被盗。',
        companion: true,
        tradeable: false,
        onGain: [
          { trait: 'sanity', amount: 1 },
          { trait: 'knowledge', amount: 1 }
        ],
        onLoss: [
          { trait: 'sanity', amount: -1 },
          { trait: 'knowledge', amount: -1 }
        ]
      },
      {
        id: 'holy_symbol',
        name: '神圣徽记',
        en: 'Holy Symbol',
        desc: '获得时神智 +2；失去时神智 -2。对抗恶魔、幽灵与吸血鬼的防御圣物。',
        tradeable: true,
        onGain: [{ trait: 'sanity', amount: 2 }],
        onLoss: [{ trait: 'sanity', amount: -2 }]
      },
      {
        id: 'madman',
        name: '疯汉',
        en: 'Madman',
        desc: '随从。获得时力量 +2、神智 -1；失去时力量 -2、神智 +1。不可交易、丢弃或被盗。',
        companion: true,
        tradeable: false,
        onGain: [
          { trait: 'might', amount: 2 },
          { trait: 'sanity', amount: -1 }
        ],
        onLoss: [
          { trait: 'might', amount: -2 },
          { trait: 'sanity', amount: 1 }
        ]
      },
      {
        id: 'mask',
        name: '诡异面具',
        en: 'Mask',
        desc: '戴上或摘下需神智检定。佩戴期间知识检定 +2 骰，神智检定 -2 骰（最低 1 骰）。',
        tradeable: true,
        usable: true,
        useKind: 'TOGGLE_MASK'
      },
      {
        id: 'medallion',
        name: '五芒星奖章',
        en: 'Medallion',
        desc: '佩戴者完全免疫五芒星堂、墓园与地窖的负面检定与强制伤害。',
        tradeable: true,
        passive: { mentalArmor: 0 }
      },
      {
        id: 'ring',
        name: '古旧指环',
        en: 'Ring',
        desc: '发起攻击时可选择以神智代替力量进行神智攻击，造成精神伤害。',
        tradeable: true
      },
      {
        id: 'skull',
        name: '裂痕头骨',
        en: 'Skull',
        desc: '受到精神伤害时减少 1 点。每回合一次可进行知识检定与亡魂沟通，成功获得 1 点知识或神智。',
        tradeable: true,
        passive: { mentalArmor: 1 },
        usable: true,
        useKind: 'DIVINING'
      },
      {
        id: 'spear',
        name: '神圣之矛',
        en: 'Spear',
        desc: '双手近战武器。力量攻击额外 +2 骰（上限 8）。',
        tradeable: true
      },
      {
        id: 'spirit_board',
        name: '通灵板',
        en: 'Spirit Board',
        desc: '移动前可使用：神智检定，成功则本回合移动力 +4；作祟后可窥见叛徒的隐秘线索。',
        tradeable: true,
        usable: true,
        useKind: 'SPIRIT_BOARD'
      }
    ] as OmenDef[]
  ).map(def => [def.id, def])
);

/* -------------------------------------------------------------------------- */
/* Items — 25 listed in the brief (which says 22; see docs)                    */
/* -------------------------------------------------------------------------- */

export const ITEM_DEFS: Record<string, ItemDef> = Object.fromEntries(
  (
    [
      {
        id: 'adrenaline_shot',
        name: '肾上腺素针',
        en: 'Adrenaline Shot',
        desc: '一次性。使用后本次检定 +4，或本回合移动力 +4。',
        kind: 'consumable',
        tradeable: true,
        usable: true,
        consumable: true,
        useKind: 'ADRENALINE'
      },
      {
        id: 'amulet_of_the_ages',
        name: '千古护身符',
        en: 'Amulet of the Ages',
        desc: '持有期间四维全部 +1；失去时四维全部 -3。',
        kind: 'relic',
        tradeable: true,
        onGain: TRAIT_KEYS.map(trait => ({ trait, amount: 1 })),
        onLoss: TRAIT_KEYS.map(trait => ({ trait, amount: -3 }))
      },
      {
        id: 'angel_feather',
        name: '天使羽毛',
        en: 'Angel Feather',
        desc: '一次性。投骰前指定结果为 0–8 的任意数字，无需掷骰。',
        kind: 'consumable',
        tradeable: true,
        usable: true,
        consumable: true,
        useKind: 'ANGEL_FEATHER'
      },
      {
        id: 'armor',
        name: '板甲',
        en: 'Armor',
        desc: '受到肉体伤害时直接减免 1 点。不可被偷窃。',
        kind: 'armor',
        tradeable: true,
        stealable: false,
        passive: { physicalArmor: 1 }
      },
      {
        id: 'axe',
        name: '锋利手斧',
        en: 'Axe',
        desc: '力量攻击 +1 骰（上限 8）。每次攻击只能使用一件武器。',
        kind: 'weapon',
        tradeable: true
      },
      {
        id: 'bell',
        name: '黄铜法铃',
        en: 'Bell',
        desc: '每回合一次：摇响法铃安抚心神，获得 1 点神智。与古籍、蜡烛集齐时四维各 +2，拆散则各 -2。',
        kind: 'relic',
        tradeable: true,
        usable: true,
        useKind: 'BELL'
      },
      {
        id: 'blood_dagger',
        name: '饮血匕首',
        en: 'Blood Dagger',
        desc: '力量攻击 +3 骰（上限 8）；每次使用后速度 -1。',
        kind: 'weapon',
        tradeable: true
      },
      {
        id: 'bottle',
        name: '黑液药瓶',
        en: 'Bottle',
        desc: '作祟后可饮用。掷 3 骰：6 传送至任意房间；5 力量与速度 +2；4 知识与神智 +2；1–3 受伤；0 四维降至最低。',
        kind: 'consumable',
        tradeable: true,
        usable: true,
        consumable: true,
        useKind: 'BOTTLE'
      },
      {
        id: 'candle',
        name: '冥想蜡烛',
        en: 'Candle',
        desc: '获得时知识 +1、神智 +1。也是三神器配件之一。',
        onGain: [
          { trait: 'knowledge', amount: 1 },
          { trait: 'sanity', amount: 1 }
        ],
        kind: 'relic',
        tradeable: true
      },
      {
        id: 'dark_dice',
        name: '黑暗骰子',
        en: 'Dark Dice',
        desc: '每回合一次，掷 3 骰：4–6 任选一项属性 +1；0–3 失去 1 神智。',
        kind: 'relic',
        tradeable: true,
        usable: true,
        useKind: 'DARK_DICE'
      },

      {
        id: 'dynamite',
        name: '雷管炸药',
        en: 'Dynamite',
        desc: '一次性。炸毁相邻或同直线的一个房间，房内所有角色与怪物各承受 3 骰物理伤害。',
        kind: 'consumable',
        tradeable: true,
        usable: true,
        consumable: true,
        useKind: 'DYNAMITE'
      },
      {
        id: 'healing_salve',
        name: '治疗药膏',
        en: 'Healing Salve',
        desc: '共 2 次。每次将一项肉体属性恢复至初始绿色数值。',
        kind: 'consumable',
        tradeable: true,
        usable: true,
        charges: 2,
        useKind: 'HEAL_PHYSICAL'
      },
      {
        id: 'idol',
        name: '神秘神像',
        en: 'Idol',
        desc: '每回合一次：神智检定。4+ 神恩降临，全部属性 +1；失败则黑暗诅咒，失去 1 点神智。',
        kind: 'relic',
        tradeable: true,
        usable: true,
        useKind: 'DIVINING'
      },
      {
        id: 'lucky_stone',
        name: '幸运石',
        en: 'Lucky Stone',
        desc: '每回合一次，任何投骰结果 +1。',
        kind: 'relic',
        tradeable: true
      },
      {
        id: 'medical_kit',
        name: '医疗包',
        en: 'Medical Kit',
        desc: '每回合一次，对同房间角色进行知识检定：6+ 恢复 3 点肉体，4–5 恢复 2 点，2–3 恢复 1 点。',
        kind: 'tool',
        tradeable: true,
        usable: true,
        useKind: 'MEDICAL_KIT'
      },
      {
        id: 'music_box',
        name: '古董八音盒',
        en: 'Music Box',
        desc: '开启期间，同房间神智低于 4 的角色立即结束本回合移动与动作。',
        kind: 'tool',
        tradeable: true,
        usable: true,
        useKind: 'MUSIC_BOX'
      },

      {
        id: 'puzzle_box',
        name: '解谜机关盒',
        en: 'Puzzle Box',
        desc: '每回合可进行知识检定：6+ 立即抽 2 张物品牌并弃置盒子。',
        kind: 'tool',
        tradeable: true,
        usable: true,
        useKind: 'PUZZLE_BOX'
      },
      {
        id: 'rabbits_foot',
        name: '幸运兔足',
        en: "Rabbit's Foot",
        desc: '每回合一次，检定不理想时可重掷其中任意 1 颗骰子。',
        kind: 'relic',
        tradeable: true
      },
      {
        id: 'revolver',
        name: '老式左轮手枪',
        en: 'Revolver',
        desc: '使用速度攻击（速度骰 +1）。可射击同楼层直线上任意房间；失败时不受反伤。',
        kind: 'weapon',
        tradeable: true,
        passive: { ranged: true }
      },
      {
        id: 'rope',
        name: '结实麻绳',
        en: 'Rope',
        desc: '从楼座或坍塌房间坠落时不受伤害，并可沿绳索反向攀爬。',
        kind: 'tool',
        tradeable: true
      },
      {
        id: 'sacrificial_dagger',
        name: '献祭匕首',
        en: 'Sacrificial Dagger',
        desc: '力量攻击 +2 骰；每次攻击前须神智 3+，失败则自身失去 1 点神智。',
        kind: 'weapon',
        tradeable: true
      },

      {
        id: 'smelling_salts',
        name: '刺激嗅盐',
        en: 'Smelling Salts',
        desc: '将一名角色的一项精神属性恢复至初始绿色数值。',
        kind: 'consumable',
        tradeable: true,
        usable: true,
        useKind: 'HEAL_MENTAL'
      }
    ] as ItemDef[]
  ).map(def => [def.id, def])
);

/* -------------------------------------------------------------------------- */
/* Events — 45 (15 named in the brief + 30 archetype slots)                    */
/* -------------------------------------------------------------------------- */

export type EventEffect =
  | { kind: 'TRAIT'; trait: TraitKey; amount: number }
  | { kind: 'DRAW_ITEM'; count: number }
  | { kind: 'DRAW_OMEN'; count: number }
  | { kind: 'ATTACK'; dice: number; trait: TraitKey; damage: DamageKind }
  | { kind: 'TO_BASEMENT'; damage: number }
  | { kind: 'TO_RANDOM_ROOM' }
  | { kind: 'SECRET_PASSAGE' }
  | { kind: 'DROP_ITEM' }
  | { kind: 'ONGOING'; effect: OngoingEffect }
  | { kind: 'NOTHING' };

export type OngoingEffect = 'DRIP' | 'POSSESSION' | 'CHILL' | 'HAUNTING_MELODY' | 'MARK_OF_FEAR';

/** Player-facing name and one-line effect for each lingering curse. */
export const ONGOING_META: Record<OngoingEffect, { zh: string; detail: string }> = {
  DRIP: { zh: '滴血之声', detail: '回合开始时若在无窗房间，神智 5+ 否则失去 1 点神智' },
  POSSESSION: { zh: '恶灵附体', detail: '回合开始时神智 4+，否则本回合无法行动' },
  CHILL: { zh: '刺骨寒意', detail: '回合开始时神智 5+，否则失去 1 点神智' },
  HAUNTING_MELODY: { zh: '萦绕旋律', detail: '回合开始时知识 5+，否则失去 1 点知识' },
  MARK_OF_FEAR: { zh: '恐惧印记', detail: '回合开始时神智 4+，否则失去 1 点神智' }
};

export interface EventBand {
  min: number;
  max: number;
  effects: EventEffect[];
  text: string;
}

export interface EventDef {
  id: string;
  name: string;
  en: string;
  category: 'SANITY' | 'PHYSICAL' | 'KNOWLEDGE' | 'SPATIAL' | 'ONGOING' | 'FLAVOR';
  desc: string;
  canonical: boolean;
  check?: TraitKey;
  bands: EventBand[];
}

const sanityEvent = (
  id: string,
  name: string,
  en: string,
  desc: string,
  successText: string,
  failText: string,
  success: EventEffect[],
  fail: EventEffect[],
  canonical = false
): EventDef => ({
  id,
  name,
  en,
  category: 'SANITY',
  desc,
  canonical,
  check: 'sanity',
  bands: [
    { min: 0, max: 3, effects: fail, text: failText },
    { min: 4, max: 8, effects: success, text: successText }
  ]
});

const physicalEvent = (
  id: string,
  name: string,
  en: string,
  desc: string,
  successText: string,
  failText: string,
  success: EventEffect[],
  fail: EventEffect[],
  canonical = false,
  check: TraitKey = 'speed',
  threshold = 4
): EventDef => ({
  id,
  name,
  en,
  category: 'PHYSICAL',
  desc,
  canonical,
  check,
  bands: [
    { min: 0, max: threshold - 1, effects: fail, text: failText },
    { min: threshold, max: 8, effects: success, text: successText }
  ]
});

const knowledgeEvent = (
  id: string,
  name: string,
  en: string,
  desc: string,
  successText: string,
  failText: string,
  success: EventEffect[],
  fail: EventEffect[],
  canonical = false,
  threshold = 5
): EventDef => ({
  id,
  name,
  en,
  category: 'KNOWLEDGE',
  desc,
  canonical,
  check: 'knowledge',
  bands: [
    { min: 0, max: threshold - 1, effects: fail, text: failText },
    { min: threshold, max: 8, effects: success, text: successText }
  ]
});

export const EVENT_DEFS: Record<string, EventDef> = Object.fromEntries(
  (
    [
      /* ------------------------- canonical from the brief ------------------- */
      {
        id: 'drip',
        name: '滴血之声',
        en: 'Drip... Drip... Drip...',
        category: 'ONGOING',
        desc: '此卡留在你面前。每当你的回合开始且处于无窗房间，须通过神智 5+ 否则失去 1 点神智，直到破除。',
        canonical: true,
        bands: [{ min: 0, max: 0, effects: [{ kind: 'ONGOING', effect: 'DRIP' }], text: '滴水声从此只为你响起。' }]
      },
      {
        id: 'possession',
        name: '恶灵附体',
        en: 'Possession',
        category: 'ONGOING',
        desc: '此卡挂在角色身上。每回合开始须神智 4+ 夺回身体控制权，否则本回合无法行动。',
        canonical: true,
        bands: [{ min: 0, max: 0, effects: [{ kind: 'ONGOING', effect: 'POSSESSION' }], text: '某种冰冷的东西钻进了你的身体。' }]
      },

      /* ------------------------- archetype fillers ------------------------- */
      {
        id: 'chill',
        name: '刺骨寒意',
        en: 'Bone Chill',
        category: 'ONGOING',
        desc: '寒意附着在你身上。每回合开始神智 5+，否则失去 1 点神智。',
        bands: [{ min: 0, max: 0, effects: [{ kind: 'ONGOING', effect: 'CHILL' }], text: '你呼出的白雾久久不散。' }]
      },
      {
        id: 'haunting_melody',
        name: '萦绕旋律',
        en: 'Haunting Melody',
        category: 'ONGOING',
        desc: '一段旋律在脑中循环。每回合开始知识 5+，否则无法集中精神（失去 1 点知识）。',
        bands: [{ min: 0, max: 0, effects: [{ kind: 'ONGOING', effect: 'HAUNTING_MELODY' }], text: '旋律停不下来。' }]
      },
      {
        id: 'mark_of_fear',
        name: '恐惧印记',
        en: 'Mark of Fear',
        category: 'ONGOING',
        desc: '你被某种东西标记了。每回合开始神智 4+，否则失去 1 点神智。',
        bands: [{ min: 0, max: 0, effects: [{ kind: 'ONGOING', effect: 'MARK_OF_FEAR' }], text: '你感到无数目光落在背上。' }]
      },

      {
        id: 'something_slimy',
        name: '黏滑之物',
        en: 'Something Slimy',
        category: 'PHYSICAL',
        desc: 'Something cold and gelatinous brushes against your legs! Make a Might roll: 4+ You pull away safely. 1-3 It clings to you (Lose 1 Speed). 0 It drags you down (Lose 2 Speed).',
        canonical: true,
        check: 'might',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'NOTHING' }], text: '4-8：无事发生' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'speed', amount: -1 }], text: '1-3：失去 1 点速度' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'speed', amount: -2 }], text: '0：失去 2 点速度' }
        ]
      },
      {
        id: 'burning_man',
        name: '燃烧的人',
        en: 'Burning Man',
        category: 'SANITY',
        desc: 'A figure engulfed in raging flames rushes screaming past you! Make a Sanity roll: 4+ You stand firm. 2-3 You reel in terror (Lose 1 Sanity). 0-1 You scream in panic (Lose 2 Sanity).',
        canonical: true,
        check: 'sanity',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'NOTHING' }], text: '4-8：无事发生' },
          { min: 2, max: 3, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -1 }], text: '2-3：失去 1 点神智' },
          { min: 0, max: 1, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -2 }], text: '0-1：失去 2 点神智' }
        ]
      },
      {
        id: 'whoops',
        name: '踩空',
        en: 'Whoops!',
        category: 'PHYSICAL',
        desc: 'You trip over a broken floorboard! Make a Speed roll: 3+ You regain balance. 0-2 You crash painfully (Lose 1 Speed).',
        canonical: true,
        check: 'speed',
        bands: [
          { min: 3, max: 8, effects: [{ kind: 'NOTHING' }], text: '3-8：无事发生' },
          { min: 0, max: 2, effects: [{ kind: 'TRAIT', trait: 'speed', amount: -1 }], text: '0-2：失去 1 点速度' }
        ]
      },
      {
        id: 'smoke',
        name: '浓烟',
        en: 'Smoke',
        category: 'PHYSICAL',
        desc: 'Thick acrid smoke fills your lungs. Make a Might roll: 4+ You cough but push through. 1-3 You choke (Lose 1 Might). 0 You collapse coughing (Lose 2 Might).',
        canonical: true,
        check: 'might',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'NOTHING' }], text: '4-8：无事发生' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'might', amount: -1 }], text: '1-3：失去 1 点力量' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'might', amount: -2 }], text: '0：失去 2 点力量' }
        ]
      },
      {
        id: 'skeletons',
        name: '骷髅',
        en: 'Skeletons',
        category: 'SANITY',
        desc: 'Skeletal hands reach out from the walls trying to pull you into the dark! Make a Sanity roll: 4+ Nerves of steel. 1-3 Panic sets in (Lose 1 Sanity). 0 Terrified (Lose 2 Sanity).',
        canonical: true,
        check: 'sanity',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'NOTHING' }], text: '4-8：无事发生' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -1 }], text: '1-3：失去 1 点神智' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -2 }], text: '0：失去 2 点神智' }
        ]
      },
      {
        id: 'spider',
        name: '巨蛛',
        en: 'Spider',
        category: 'PHYSICAL',
        desc: 'A hairy spider the size of a dinner plate drops onto your shoulder! Make a Speed roll: 4+ You dodge swiftly. 1-3 It bites your arm (Lose 1 Might). 0 Venom courses through you (Lose 2 Might).',
        canonical: true,
        check: 'speed',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'NOTHING' }], text: '4-8：无事发生' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'might', amount: -1 }], text: '1-3：失去 1 点力量' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'might', amount: -2 }], text: '0：失去 2 点力量' }
        ]
      },
      {
        id: 'angry_being',
        name: '愤怒的灵体',
        en: 'Angry Being',
        category: 'SANITY',
        desc: 'A furious specter bellows in rage, chilling you to the bone! Make a Sanity roll: 4+ You endure the roar. 1-3 Chilled to the soul (Lose 1 Sanity). 0 Paralyzing dread (Lose 2 Sanity).',
        canonical: true,
        check: 'sanity',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'NOTHING' }], text: '4-8：无事发生' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -1 }], text: '1-3：失去 1 点神智' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -2 }], text: '0：失去 2 点神智' }
        ]
      },
      {
        id: 'hideous_shriek',
        name: '骇人尖啸',
        en: 'Hideous Shriek',
        category: 'SANITY',
        desc: 'An ear-splitting shriek pierces the dark corridors! Make a Sanity roll: 4+ You cover your ears in time. 1-3 Piercing ringing (Lose 1 Sanity). 0 Eardrums burst (Lose 2 Sanity).',
        canonical: true,
        check: 'sanity',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'NOTHING' }], text: '4-8：无事发生' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -1 }], text: '1-3：失去 1 点神智' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -2 }], text: '0：失去 2 点神智' }
        ]
      },
      {
        id: 'something_hidden',
        name: '暗藏之物',
        en: 'Something Hidden',
        category: 'KNOWLEDGE',
        desc: 'You notice a secret hollow in the paneling containing ancient research! Make a Knowledge roll: 4+ Ancient occult treatise (Gain 2 Knowledge). 1-3 Useful blueprints (Gain 1 Knowledge). 0 The text has rotted away.',
        canonical: true,
        check: 'knowledge',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'TRAIT', trait: 'knowledge', amount: 2 }], text: '4-8：获得 2 点知识' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'knowledge', amount: 1 }], text: '1-3：获得 1 点知识' },
          { min: 0, max: 0, effects: [{ kind: 'NOTHING' }], text: '0：无事发生' }
        ]
      },
      {
        id: 'disquieting_sounds',
        name: '不安的声响',
        en: 'Disquieting Sounds',
        category: 'SANITY',
        desc: 'Wet footsteps shuffle behind you! Make a Sanity roll: 4+ You master your fears (Gain 1 Sanity). 1-3 Creeping paranoia (Lose 1 Sanity). 0 Total panic (Lose 2 Sanity).',
        canonical: true,
        check: 'sanity',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: 1 }], text: '4-8：获得 1 点神智' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -1 }], text: '1-3：失去 1 点神智' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -2 }], text: '0：失去 2 点神智' }
        ]
      },
      {
        id: 'image_in_mirror',
        name: '镜中影像',
        en: 'Image in the Mirror',
        category: 'SANITY',
        desc: 'Your reflection turns and laughs cruelly before decaying into dust! Make a Sanity roll: 4+ You recognize the trick. 1-3 Shaken (Lose 1 Sanity). 0 Broken psyche (Lose 2 Sanity).',
        canonical: true,
        check: 'sanity',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'NOTHING' }], text: '4-8：无事发生' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -1 }], text: '1-3：失去 1 点神智' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -2 }], text: '0：失去 2 点神智' }
        ]
      },
      {
        id: 'groundskeeper',
        name: '园丁',
        en: 'Groundskeeper',
        category: 'PHYSICAL',
        desc: 'A hulking phantom in muddy overalls strikes with a rusty shovel! Make a Might roll: 4+ You deflect the shovel (Gain 1 Might). 1-3 A glancing blow (Lose 1 Might). 0 Heavy blow (Lose 2 Might).',
        canonical: true,
        check: 'might',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'TRAIT', trait: 'might', amount: 1 }], text: '4-8：获得 1 点力量' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'might', amount: -1 }], text: '1-3：失去 1 点力量' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'might', amount: -2 }], text: '0：失去 2 点力量' }
        ]
      },
      {
        id: 'mist_from_walls',
        name: '墙中之雾',
        en: 'Mist from the Walls',
        category: 'SANITY',
        desc: 'Freezing mist seeps through cracks, numbing your legs! Make a Sanity roll: 4+ You hold your breath. 1-3 Shivering cold (Lose 1 Speed). 0 Frostbite (Lose 2 Speed).',
        canonical: true,
        check: 'sanity',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'NOTHING' }], text: '4-8：无事发生' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'speed', amount: -1 }], text: '1-3：失去 1 点速度' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'speed', amount: -2 }], text: '0：失去 2 点速度' }
        ]
      },
      {
        id: 'phone_call',
        name: '电话',
        en: 'Phone Call',
        category: 'SANITY',
        desc: 'An antique rotary phone rings. A dead loved one whispers your name! Make a Sanity roll: 4+ A loving message calms you (Gain 1 Sanity). 1-3 Chilling sobs (Lose 1 Sanity). 0 A prophecy of doom (Lose 2 Sanity).',
        canonical: true,
        check: 'sanity',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: 1 }], text: '4-8：获得 1 点神智' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -1 }], text: '1-3：失去 1 点神智' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -2 }], text: '0：失去 2 点神智' }
        ]
      },
      {
        id: 'rotten',
        name: '腐坏',
        en: 'Rotten',
        category: 'PHYSICAL',
        desc: 'Foul fungal stench fills the room! Make a Might roll: 4+ You fight off nausea. 1-3 You retch violently (Lose 1 Might). 0 Choking spores (Lose 2 Might).',
        canonical: true,
        check: 'might',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'NOTHING' }], text: '4-8：无事发生' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'might', amount: -1 }], text: '1-3：失去 1 点力量' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'might', amount: -2 }], text: '0：失去 2 点力量' }
        ]
      },
      {
        id: 'the_walls',
        name: '墙壁',
        en: 'The Walls',
        category: 'SANITY',
        desc: 'Blood begins weeping from the plaster seams! Make a Sanity roll: 4+ You ignore the gore. 1-3 Sickened (Lose 1 Sanity). 0 Hysterical horror (Lose 2 Sanity).',
        canonical: true,
        check: 'sanity',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'NOTHING' }], text: '4-8：无事发生' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -1 }], text: '1-3：失去 1 点神智' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -2 }], text: '0：失去 2 点神智' }
        ]
      },
      {
        id: 'hanged_men',
        name: '吊死者',
        en: 'Hanged Men',
        category: 'SANITY',
        desc: 'Gallows ropes swing from the ceiling with shadowy figures! Make a Sanity roll: 4+ You remain steady. 1-3 Shudder in dread (Lose 1 Sanity). 0 Terrifying hallucination (Lose 2 Sanity).',
        canonical: true,
        check: 'sanity',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'NOTHING' }], text: '4-8：无事发生' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -1 }], text: '1-3：失去 1 点神智' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -2 }], text: '0：失去 2 点神智' }
        ]
      },
      {
        id: 'closet_door',
        name: '橱柜门',
        en: 'Closet Door',
        category: 'KNOWLEDGE',
        desc: 'A cupboard door swings open, revealing a stash of old medical supplies! Make a Knowledge roll: 4+ Pristine apothecary restoratives (Gain 1 Might, Gain 1 Speed). 1-3 Clean bandages and salves (Gain 1 Might). 0 Empty jars.',
        canonical: true,
        check: 'knowledge',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'TRAIT', trait: 'might', amount: 1 }, { kind: 'TRAIT', trait: 'speed', amount: 1 }], text: '4-8：获得 1 点力量，获得 1 点速度' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'might', amount: 1 }], text: '1-3：获得 1 点力量' },
          { min: 0, max: 0, effects: [{ kind: 'NOTHING' }], text: '0：无事发生' }
        ]
      },
      {
        id: 'night_view',
        name: '夜景',
        en: 'Night View',
        category: 'SANITY',
        desc: 'A window reveals the majestic moonlit estate, calming your racing heart. Gain 1 Sanity.',
        canonical: true,
        bands: [{ min: 0, max: 8, effects: [], text: '无事发生' }]
      },
      {
        id: 'ground_tremors',
        name: '地面震动',
        en: 'Ground Tremors',
        category: 'PHYSICAL',
        desc: 'The foundations shake violently as if something massive is stirring beneath! Make a Speed roll: 4+ You keep your footing. 1-3 You stumble hard (Lose 1 Speed). 0 You crash violently to the floor (Lose 2 Speed).',
        canonical: true,
        check: 'speed',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'NOTHING' }], text: '4-8：无事发生' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'speed', amount: -1 }], text: '1-3：失去 1 点速度' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'speed', amount: -2 }], text: '0：失去 2 点速度' }
        ]
      },
      {
        id: 'something_slimy',
        name: '黏滑之物',
        en: 'Something Slimy',
        category: 'PHYSICAL',
        desc: 'Something cold and gelatinous brushes against your legs! Make a Might roll: 4+ You pull away safely. 1-3 It clings to you (Lose 1 Speed). 0 It drags you down (Lose 2 Speed).',
        canonical: true,
        check: 'might',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'NOTHING' }], text: '4-8：无事发生' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'speed', amount: -1 }], text: '1-3：失去 1 点速度' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'speed', amount: -2 }], text: '0：失去 2 点速度' }
        ]
      },
      {
        id: 'burning_man',
        name: '燃烧的人',
        en: 'Burning Man',
        category: 'SANITY',
        desc: 'A figure engulfed in raging flames rushes screaming past you! Make a Sanity roll: 4+ You stand firm. 2-3 You reel in terror (Lose 1 Sanity). 0-1 You scream in panic (Lose 2 Sanity).',
        canonical: true,
        check: 'sanity',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'NOTHING' }], text: '4-8：无事发生' },
          { min: 2, max: 3, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -1 }], text: '2-3：失去 1 点神智' },
          { min: 0, max: 1, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -2 }], text: '0-1：失去 2 点神智' }
        ]
      },
      {
        id: 'whoops',
        name: '踩空',
        en: 'Whoops!',
        category: 'PHYSICAL',
        desc: 'You trip over a broken floorboard! Make a Speed roll: 3+ You regain balance. 0-2 You crash painfully (Lose 1 Speed).',
        canonical: true,
        check: 'speed',
        bands: [
          { min: 3, max: 8, effects: [{ kind: 'NOTHING' }], text: '3-8：无事发生' },
          { min: 0, max: 2, effects: [{ kind: 'TRAIT', trait: 'speed', amount: -1 }], text: '0-2：失去 1 点速度' }
        ]
      },
      {
        id: 'smoke',
        name: '浓烟',
        en: 'Smoke',
        category: 'PHYSICAL',
        desc: 'Thick acrid smoke fills your lungs. Make a Might roll: 4+ You cough but push through. 1-3 You choke (Lose 1 Might). 0 You collapse coughing (Lose 2 Might).',
        canonical: true,
        check: 'might',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'NOTHING' }], text: '4-8：无事发生' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'might', amount: -1 }], text: '1-3：失去 1 点力量' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'might', amount: -2 }], text: '0：失去 2 点力量' }
        ]
      },
      {
        id: 'skeletons',
        name: '骷髅',
        en: 'Skeletons',
        category: 'SANITY',
        desc: 'Skeletal hands reach out from the walls trying to pull you into the dark! Make a Sanity roll: 4+ Nerves of steel. 1-3 Panic sets in (Lose 1 Sanity). 0 Terrified (Lose 2 Sanity).',
        canonical: true,
        check: 'sanity',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'NOTHING' }], text: '4-8：无事发生' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -1 }], text: '1-3：失去 1 点神智' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -2 }], text: '0：失去 2 点神智' }
        ]
      },
      {
        id: 'spider',
        name: '巨蛛',
        en: 'Spider',
        category: 'PHYSICAL',
        desc: 'A hairy spider the size of a dinner plate drops onto your shoulder! Make a Speed roll: 4+ You dodge swiftly. 1-3 It bites your arm (Lose 1 Might). 0 Venom courses through you (Lose 2 Might).',
        canonical: true,
        check: 'speed',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'NOTHING' }], text: '4-8：无事发生' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'might', amount: -1 }], text: '1-3：失去 1 点力量' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'might', amount: -2 }], text: '0：失去 2 点力量' }
        ]
      },
      {
        id: 'angry_being',
        name: '愤怒的灵体',
        en: 'Angry Being',
        category: 'SANITY',
        desc: 'A furious specter bellows in rage, chilling you to the bone! Make a Sanity roll: 4+ You endure the roar. 1-3 Chilled to the soul (Lose 1 Sanity). 0 Paralyzing dread (Lose 2 Sanity).',
        canonical: true,
        check: 'sanity',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'NOTHING' }], text: '4-8：无事发生' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -1 }], text: '1-3：失去 1 点神智' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -2 }], text: '0：失去 2 点神智' }
        ]
      },
      {
        id: 'hideous_shriek',
        name: '骇人尖啸',
        en: 'Hideous Shriek',
        category: 'SANITY',
        desc: 'An ear-splitting shriek pierces the dark corridors! Make a Sanity roll: 4+ You cover your ears in time. 1-3 Piercing ringing (Lose 1 Sanity). 0 Eardrums burst (Lose 2 Sanity).',
        canonical: true,
        check: 'sanity',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'NOTHING' }], text: '4-8：无事发生' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -1 }], text: '1-3：失去 1 点神智' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -2 }], text: '0：失去 2 点神智' }
        ]
      },
      {
        id: 'something_hidden',
        name: '暗藏之物',
        en: 'Something Hidden',
        category: 'KNOWLEDGE',
        desc: 'You notice a secret hollow in the paneling containing ancient research! Make a Knowledge roll: 4+ Ancient occult treatise (Gain 2 Knowledge). 1-3 Useful blueprints (Gain 1 Knowledge). 0 The text has rotted away.',
        canonical: true,
        check: 'knowledge',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'TRAIT', trait: 'knowledge', amount: 2 }], text: '4-8：获得 2 点知识' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'knowledge', amount: 1 }], text: '1-3：获得 1 点知识' },
          { min: 0, max: 0, effects: [{ kind: 'NOTHING' }], text: '0：无事发生' }
        ]
      },
      {
        id: 'locked_safe',
        name: '上锁的保险箱',
        en: 'Locked Safe',
        category: 'KNOWLEDGE',
        desc: 'An iron safe embedded in the brickwork. Make a Knowledge roll: 4+ You crack the tumblers (Gain 1 Knowledge, Gain 1 Might). 1-3 You study the mechanism (Gain 1 Knowledge). 0 The lock is rusted solid.',
        canonical: true,
        check: 'knowledge',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'TRAIT', trait: 'knowledge', amount: 1 }, { kind: 'TRAIT', trait: 'might', amount: 1 }], text: '4-8：获得 1 点知识，获得 1 点力量' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'knowledge', amount: 1 }], text: '1-3：获得 1 点知识' },
          { min: 0, max: 0, effects: [{ kind: 'NOTHING' }], text: '0：无事发生' }
        ]
      },
      {
        id: 'disquieting_sounds',
        name: '不安的声响',
        en: 'Disquieting Sounds',
        category: 'SANITY',
        desc: 'Wet footsteps shuffle behind you! Make a Sanity roll: 4+ You master your fears (Gain 1 Sanity). 1-3 Creeping paranoia (Lose 1 Sanity). 0 Total panic (Lose 2 Sanity).',
        canonical: true,
        check: 'sanity',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: 1 }], text: '4-8：获得 1 点神智' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -1 }], text: '1-3：失去 1 点神智' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -2 }], text: '0：失去 2 点神智' }
        ]
      },
      {
        id: 'image_in_mirror',
        name: '镜中影像',
        en: 'Image in the Mirror',
        category: 'SANITY',
        desc: 'Your reflection turns and laughs cruelly before decaying into dust! Make a Sanity roll: 4+ You recognize the trick. 1-3 Shaken (Lose 1 Sanity). 0 Broken psyche (Lose 2 Sanity).',
        canonical: true,
        check: 'sanity',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'NOTHING' }], text: '4-8：无事发生' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -1 }], text: '1-3：失去 1 点神智' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -2 }], text: '0：失去 2 点神智' }
        ]
      },
      {
        id: 'groundskeeper',
        name: '园丁',
        en: 'Groundskeeper',
        category: 'PHYSICAL',
        desc: 'A hulking phantom in muddy overalls strikes with a rusty shovel! Make a Might roll: 4+ You deflect the shovel (Gain 1 Might). 1-3 A glancing blow (Lose 1 Might). 0 Heavy blow (Lose 2 Might).',
        canonical: true,
        check: 'might',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'TRAIT', trait: 'might', amount: 1 }], text: '4-8：获得 1 点力量' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'might', amount: -1 }], text: '1-3：失去 1 点力量' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'might', amount: -2 }], text: '0：失去 2 点力量' }
        ]
      },
      {
        id: 'mist_from_walls',
        name: '墙中之雾',
        en: 'Mist from the Walls',
        category: 'SANITY',
        desc: 'Freezing mist seeps through cracks, numbing your legs! Make a Sanity roll: 4+ You hold your breath. 1-3 Shivering cold (Lose 1 Speed). 0 Frostbite (Lose 2 Speed).',
        canonical: true,
        check: 'sanity',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'NOTHING' }], text: '4-8：无事发生' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'speed', amount: -1 }], text: '1-3：失去 1 点速度' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'speed', amount: -2 }], text: '0：失去 2 点速度' }
        ]
      },
      {
        id: 'the_voice',
        name: '低语',
        en: 'The Voice',
        category: 'SANITY',
        desc: 'A sweet, disembodied whisper shares hidden truths of the house. Make a Sanity roll: 4+ You absorb the arcane secrets (Gain 2 Knowledge). 1-3 You learn a useful secret (Gain 1 Knowledge). 0 Maddening babble (Lose 1 Sanity).',
        canonical: true,
        check: 'sanity',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'TRAIT', trait: 'knowledge', amount: 2 }], text: '4-8：获得 2 点知识' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'knowledge', amount: 1 }], text: '1-3：获得 1 点知识' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -1 }], text: '0：失去 1 点神智' }
        ]
      },
      {
        id: 'phone_call',
        name: '电话',
        en: 'Phone Call',
        category: 'SANITY',
        desc: 'An antique rotary phone rings. A dead loved one whispers your name! Make a Sanity roll: 4+ A loving message calms you (Gain 1 Sanity). 1-3 Chilling sobs (Lose 1 Sanity). 0 A prophecy of doom (Lose 2 Sanity).',
        canonical: true,
        check: 'sanity',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: 1 }], text: '4-8：获得 1 点神智' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -1 }], text: '1-3：失去 1 点神智' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -2 }], text: '0：失去 2 点神智' }
        ]
      },
      {
        id: 'rotten',
        name: '腐坏',
        en: 'Rotten',
        category: 'PHYSICAL',
        desc: 'Foul fungal stench fills the room! Make a Might roll: 4+ You fight off nausea. 1-3 You retch violently (Lose 1 Might). 0 Choking spores (Lose 2 Might).',
        canonical: true,
        check: 'might',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'NOTHING' }], text: '4-8：无事发生' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'might', amount: -1 }], text: '1-3：失去 1 点力量' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'might', amount: -2 }], text: '0：失去 2 点力量' }
        ]
      },
      {
        id: 'the_walls',
        name: '墙壁',
        en: 'The Walls',
        category: 'SANITY',
        desc: 'Blood begins weeping from the plaster seams! Make a Sanity roll: 4+ You ignore the gore. 1-3 Sickened (Lose 1 Sanity). 0 Hysterical horror (Lose 2 Sanity).',
        canonical: true,
        check: 'sanity',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'NOTHING' }], text: '4-8：无事发生' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -1 }], text: '1-3：失去 1 点神智' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -2 }], text: '0：失去 2 点神智' }
        ]
      },
      {
        id: 'hanged_men',
        name: '吊死者',
        en: 'Hanged Men',
        category: 'SANITY',
        desc: 'Gallows ropes swing from the ceiling with shadowy figures! Make a Sanity roll: 4+ You remain steady. 1-3 Shudder in dread (Lose 1 Sanity). 0 Terrifying hallucination (Lose 2 Sanity).',
        canonical: true,
        check: 'sanity',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'NOTHING' }], text: '4-8：无事发生' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -1 }], text: '1-3：失去 1 点神智' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -2 }], text: '0：失去 2 点神智' }
        ]
      },
      {
        id: 'funeral',
        name: '葬礼',
        en: 'Funeral',
        category: 'SANITY',
        desc: 'You see mourners gathered around a mahogany casket bearing your own photo! Make a Sanity roll: 4+ You dispel the macabre vision. 1-3 Morbid dread (Lose 1 Sanity). 0 Crushing despair (Lose 2 Sanity).',
        canonical: true,
        check: 'sanity',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'NOTHING' }], text: '4-8：无事发生' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -1 }], text: '1-3：失去 1 点神智' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -2 }], text: '0：失去 2 点神智' }
        ]
      },
      {
        id: 'creepy_crawlies',
        name: '爬虫',
        en: 'Creepy Crawlies',
        category: 'SANITY',
        desc: 'Thousands of centipedes and beetles drop from the ceiling onto you! Make a Sanity roll: 4+ You brush them off unflinchingly. 1-3 Repulsed and bitten (Lose 1 Sanity). 0 Swarmed in darkness (Lose 2 Sanity).',
        canonical: true,
        check: 'sanity',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'NOTHING' }], text: '4-8：无事发生' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -1 }], text: '1-3：失去 1 点神智' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -2 }], text: '0：失去 2 点神智' }
        ]
      },
      {
        id: 'closet_door',
        name: '橱柜门',
        en: 'Closet Door',
        category: 'KNOWLEDGE',
        desc: 'A cupboard door swings open, revealing a stash of old medical supplies! Make a Knowledge roll: 4+ Pristine apothecary restoratives (Gain 1 Might, Gain 1 Speed). 1-3 Clean bandages and salves (Gain 1 Might). 0 Empty jars.',
        canonical: true,
        check: 'knowledge',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'TRAIT', trait: 'might', amount: 1 }, { kind: 'TRAIT', trait: 'speed', amount: 1 }], text: '4-8：获得 1 点力量，获得 1 点速度' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'might', amount: 1 }], text: '1-3：获得 1 点力量' },
          { min: 0, max: 0, effects: [{ kind: 'NOTHING' }], text: '0：无事发生' }
        ]
      },
      {
        id: 'bloody_vision',
        name: '鲜血幻象',
        en: 'Bloody Vision',
        category: 'SANITY',
        desc: 'The entire room suddenly appears drenched in fresh arterial blood, then vanishes! Make a Sanity roll: 4+ You look away in time. 1-3 Heart palpitations (Lose 1 Sanity). 0 Overcome with gore (Lose 2 Sanity).',
        canonical: true,
        check: 'sanity',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'NOTHING' }], text: '4-8：无事发生' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -1 }], text: '1-3：失去 1 点神智' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'sanity', amount: -2 }], text: '0：失去 2 点神智' }
        ]
      },
      {
        id: 'night_view',
        name: '夜景',
        en: 'Night View',
        category: 'SANITY',
        desc: 'A window reveals the majestic moonlit estate, calming your racing heart. Gain 1 Sanity.',
        canonical: true,
        bands: [{ min: 0, max: 8, effects: [], text: '无事发生' }]
      },
      {
        id: 'ground_tremors',
        name: '地面震动',
        en: 'Ground Tremors',
        category: 'PHYSICAL',
        desc: 'The foundations shake violently as if something massive is stirring beneath! Make a Speed roll: 4+ You keep your footing. 1-3 You stumble hard (Lose 1 Speed). 0 You crash violently to the floor (Lose 2 Speed).',
        canonical: true,
        check: 'speed',
        bands: [
          { min: 4, max: 8, effects: [{ kind: 'NOTHING' }], text: '4-8：无事发生' },
          { min: 1, max: 3, effects: [{ kind: 'TRAIT', trait: 'speed', amount: -1 }], text: '1-3：失去 1 点速度' },
          { min: 0, max: 0, effects: [{ kind: 'TRAIT', trait: 'speed', amount: -2 }], text: '0：失去 2 点速度' }
        ]
      },
    ] as EventDef[]
  ).map(def => [def.id, def])
);

export const EVENT_DECK_IDS = Object.keys(EVENT_DEFS);
export const ITEM_DECK_IDS = Object.keys(ITEM_DEFS);
export const OMEN_DECK_IDS = Object.keys(OMEN_DEFS);

/* -------------------------------------------------------------------------- */
/* Weapons                                                                     */
/* -------------------------------------------------------------------------- */

export interface WeaponSpec {
  id: string;
  name: string;
  trait: 'might' | 'speed' | 'sanity';
  dice: number;
  ranged?: boolean;
  mental?: boolean;
  /** Cost paid by the attacker after the attack resolves. */
  selfCost?: { trait: TraitKey; amount: number };
  requiresSanityCheck?: number;
}

export const WEAPON_SPECS: Record<string, WeaponSpec> = {
  fists: { id: 'fists', name: '徒手', trait: 'might', dice: 0 },
  axe: { id: 'axe', name: '锋利手斧', trait: 'might', dice: 1 },
  pickaxe: { id: 'pickaxe', name: '铁镐', trait: 'might', dice: 1 },
  spear: { id: 'spear', name: '神圣之矛', trait: 'might', dice: 2 },
  sacrificial_dagger: { id: 'sacrificial_dagger', name: '献祭匕首', trait: 'might', dice: 2, requiresSanityCheck: 3 },
  blood_dagger: {
    id: 'blood_dagger',
    name: '饮血匕首',
    trait: 'might',
    dice: 3,
    selfCost: { trait: 'speed', amount: -1 }
  },
  revolver: { id: 'revolver', name: '老式左轮手枪', trait: 'speed', dice: 1, ranged: true },
  ring: { id: 'ring', name: '古旧指环', trait: 'sanity', dice: 0, mental: true }
};

/** Dice cap printed on every weapon card. */
export const MAX_ATTACK_DICE = 8;
