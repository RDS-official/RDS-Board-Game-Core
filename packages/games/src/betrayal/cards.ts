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
    id: 'drawing_room',
    name: '会客厅',
    en: 'Drawing Room',
    floor: 'GROUND',
    doors: ['N', 'E', 'W'],
    symbol: 'EVENT',
    text: '褪色的沙发围着一架积灰的钢琴。'
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
    id: 'study',
    name: '书房',
    en: 'Study',
    floor: 'GROUND',
    doors: ['N', 'W'],
    symbol: 'EVENT',
    tags: ['books'],
    text: '写字台上摊着一封写到一半的信。'
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
    id: 'garden',
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
    id: 'nursery',
    name: '育婴室',
    en: 'Nursery',
    floor: 'UPPER',
    doors: ['N', 'E'],
    symbol: 'ITEM',
    tags: ['child'],
    text: '摇椅还在前后晃动，摇篮里空无一物。'
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
    id: 'linen_closet',
    name: '亚麻储藏室',
    en: 'Linen Closet',
    floor: 'UPPER',
    doors: ['E', 'S'],
    symbol: 'ITEM',
    text: '叠得整整齐齐的床单上落着灰。'
  },
  {
    id: 'widow_walk',
    name: '寡妇步道',
    en: "Widow's Walk",
    floor: 'UPPER',
    doors: ['N', 'W'],
    symbol: 'OMEN',
    tags: ['high'],
    text: '屋顶边缘的窄道，只能容一人侧身通过。'
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
    id: 'pentagram_chamber',
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
    id: 'vault',
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
    id: 'workshop',
    name: '工坊',
    en: 'Workshop',
    floor: 'BASEMENT',
    doors: ['S', 'E'],
    symbol: 'ITEM',
    text: '工作台上散落着半成品与沾血的工具。'
  },
  {
    id: 'laboratory',
    name: '实验室',
    en: 'Laboratory',
    floor: 'BASEMENT',
    doors: ['N', 'E'],
    symbol: 'ITEM',
    tags: ['science'],
    text: '玻璃器皿里培养着不该存在的东西。'
  },
  {
    id: 'operating_lab',
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
        desc: '每回合一次，神智 5+ 可驱使同房间的怪物移动。与古籍、蜡烛集齐时四维各 +2，拆散则各 -2。',
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
        desc: '进入事件房间时可掷 1 骰，掷出 2 则忽略事件。也是三神器配件之一。',
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
        desc: '获得时任选一项属性 +1。每回合一次，检定失败时可牺牲 1 神智重掷所有骰。',
        kind: 'relic',
        tradeable: true,
        onGain: [{ trait: 'knowledge', amount: 1 }]
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
      sanityEvent(
        'funeral',
        '葬礼',
        'Funeral',
        '你看见自己躺在开盖的棺材里。神智检定：4+ 意志坚定，神智 +1；否则精神重创，神智 -2。',
        '你认出那只是自己的倒影，+1 神智。',
        '棺中的“你”睁开眼，你失去 2 点神智。',
        [{ kind: 'TRAIT', trait: 'sanity', amount: 1 }],
        [{ kind: 'TRAIT', trait: 'sanity', amount: -2 }],
        true
      ),
      sanityEvent(
        'bloody_vision',
        '鲜血幻象',
        'Bloody Vision',
        '墙壁渗出温热的血。神智检定：失败者陷入疯狂，被迫发起一次攻击。',
        '你稳住呼吸，血墙褪去。',
        '你在狂乱中抓伤自己，失去 1 点神智与 1 点肉体。',
        [{ kind: 'NOTHING' }],
        [
          { kind: 'TRAIT', trait: 'sanity', amount: -1 },
          { kind: 'ATTACK', dice: 2, trait: 'might', damage: 'PHYSICAL' }
        ],
        true
      ),
      sanityEvent(
        'the_voice',
        '低语魔音',
        'The Voice',
        '耳边响起自戕的低语。神智 4+ 抵御，否则被推向最近的危险房间。',
        '你捂住耳朵，低语退去。',
        '你不由自主地走向黑暗，失去 1 点神智。',
        [{ kind: 'NOTHING' }],
        [
          { kind: 'TRAIT', trait: 'sanity', amount: -1 },
          { kind: 'TO_RANDOM_ROOM' }
        ],
        true
      ),
      physicalEvent(
        'creepy_crawlies',
        '剧毒群蛛',
        'Creepy Crawlies',
        '天花板泼洒下潮水般的毒虫。速度检定 4+ 规避。',
        '你踩灭最后一只毒虫。',
        '毒液入血：速度 -1、力量 -1。',
        [{ kind: 'NOTHING' }],
        [
          { kind: 'TRAIT', trait: 'speed', amount: -1 },
          { kind: 'TRAIT', trait: 'might', amount: -1 }
        ],
        true
      ),
      knowledgeEvent(
        'locked_safe',
        '上锁的保险箱',
        'Locked Safe',
        '墙角嵌着密码铁箱。知识 5+ 破解，抽 2 张物品牌；骷髅钥匙可直接打开。',
        '锁簧轻响，箱门弹开。',
        '你试遍了所有组合，箱子纹丝不动。',
        [{ kind: 'DRAW_ITEM', count: 2 }],
        [{ kind: 'NOTHING' }],
        true
      ),
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
