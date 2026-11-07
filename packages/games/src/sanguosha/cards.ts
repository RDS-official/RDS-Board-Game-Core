import type { SgsCardCustom, SgsCardMeta, SgsCardSeed } from './types';

/**
 * Sanguosha card catalogue.
 *
 * The catalogue is data only; every rule that reacts to a card lives in the
 * game module's reducer/helpers. Card faces carry enough information for the
 * generic inspector (title, suit, rank, category band, rules text) and for the
 * replay hash (nothing here is generated at runtime).
 */

type MetaInput = Omit<SgsCardMeta, 'category' | 'subtype' | 'zh' | 'en' | 'desc' | 'code'>;

function basic(code: string, subtype: SgsCardMeta['subtype'], zh: string, en: string, desc: string, element: SgsCardMeta['element'] = 'NORMAL'): SgsCardMeta {
  return { code, zh, en, category: 'BASIC', subtype, desc, element };
}

function trick(code: string, subtype: SgsCardMeta['subtype'], zh: string, en: string, desc: string): SgsCardMeta {
  return { code, zh, en, category: 'TRICK', subtype, desc };
}

function delayed(code: string, subtype: SgsCardMeta['subtype'], zh: string, en: string, desc: string): SgsCardMeta {
  return { code, zh, en, category: 'DELAYED', subtype, desc };
}

function equip(code: string, subtype: SgsCardMeta['subtype'], zh: string, en: string, desc: string, input: MetaInput): SgsCardMeta {
  return { ...input, code, zh, en, category: 'EQUIP', subtype, desc, equipSlot: input.equipSlot };
}

const STRIKE_DESC = '出牌阶段限一次，对攻击范围内一名角色使用。目标需打出【闪】，否则受到1点伤害。';
const FIRE_STRIKE_DESC = '出牌阶段限一次，对攻击范围内一名角色使用。目标需打出【闪】，否则受到1点火焰伤害。';
const THUNDER_STRIKE_DESC = '出牌阶段限一次，对攻击范围内一名角色使用。目标需打出【闪】，否则受到1点雷电伤害。';

export const CARD_LIBRARY: Record<string, SgsCardMeta> = {
  sha: basic('sha', 'STRIKE', '杀', 'Strike', STRIKE_DESC),
  huosha: basic('huosha', 'STRIKE', '火杀', 'Fire Strike', FIRE_STRIKE_DESC, 'FIRE'),
  leisha: basic('leisha', 'STRIKE', '雷杀', 'Thunder Strike', THUNDER_STRIKE_DESC, 'THUNDER'),
  shan: basic('shan', 'DODGE', '闪', 'Dodge', '当以你为目标的【杀】生效前，抵消之。'),
  tao: basic('tao', 'PEACH', '桃', 'Peach', '出牌阶段，回复一名已受伤角色1点体力；或在濒死结算中救助一名角色。'),
  jiu: basic('jiu', 'WINE', '酒', 'Wine', '出牌阶段限一次，本回合下一张【杀】伤害+1；或于濒死时回复1点体力。'),
  guohe: trick('guohe', 'DISMANTLE', '过河拆桥', 'Dismantle', '弃置一名区域里有牌的其他角色区域里的一张牌。'),
  shunshou: trick('shunshou', 'SNATCH', '顺手牵羊', 'Snatch', '获得距离为1的一名区域里有牌的其他角色区域里的一张牌。'),
  juedou: trick('juedou', 'DUEL', '决斗', 'Duel', '由目标开始，其与你轮流打出【杀】，未打出者受到对方造成的1点伤害。'),
  jiedao: trick('jiedao', 'BORROW_SWORD', '借刀杀人', 'Borrowed Sword', '令一名装备武器的角色对其攻击范围内另一名角色使用【杀】，否则获得其武器。'),
  wuzhong: trick('wuzhong', 'EX_NIHILO', '无中生有', 'Ex Nihilo', '摸两张牌。'),
  wuxie: trick('wuxie', 'NULLIFY', '无懈可击', 'Nullification', '抵消一张锦囊牌或另一张【无懈可击】。'),
  nanman: trick('nanman', 'BARBARIAN', '南蛮入侵', 'Barbarian Invasion', '所有其他角色需打出【杀】，否则受到1点伤害。'),
  wanjian: trick('wanjian', 'ARROW', '万箭齐发', 'Arrow Barrage', '所有其他角色需打出【闪】，否则受到1点伤害。'),
  taoyuan: trick('taoyuan', 'PEACH_GARDEN', '桃园结义', 'Peach Garden', '所有角色回复1点体力；未受伤的角色不受影响。'),
  wugu: trick('wugu', 'HARVEST', '五谷丰登', 'Harvest', '亮出等同目标数的牌，每名目标获得其中一张，剩余置入弃牌堆。'),
  tiesuo: trick('tiesuo', 'IRON_CHAIN', '铁索连环', 'Iron Chain', '选择一至两名角色，令其横置或重置；此牌可重铸。'),
  huogong: trick('huogong', 'FIRE_ATTACK', '火攻', 'Fire Attack', '目标展示一张手牌，你可弃置同花色手牌，对其造成1点火焰伤害。'),
  lebu: delayed('lebu', 'INDULGENCE', '乐不思蜀', 'Indulgence', '目标判定；若结果不为红桃，其跳过出牌阶段。'),
  shandian: delayed('shandian', 'LIGHTNING', '闪电', 'Lightning', '目标判定；若结果为黑桃2~9，其受到3点雷电伤害，否则将此牌移至下家判定区。'),
  bingliang: delayed('bingliang', 'SUPPLY_SHORTAGE', '兵粮寸断', 'Supply Shortage', '目标判定；若结果不为梅花，其跳过摸牌阶段。'),

  zhuge: equip('zhuge', 'WEAPON', '诸葛连弩', 'Zhuge Crossbow', '出牌阶段，你可以使用任意张【杀】。', { equipSlot: 'WEAPON', range: 1 }),
  qinggang: equip('qinggang', 'WEAPON', '青釭剑', 'Qinggang Sword', '锁定技，你的【杀】无视目标防具。', { equipSlot: 'WEAPON', range: 2 }),
  cixiong: equip('cixiong', 'WEAPON', '雌雄双股剑', 'Male and Female Swords', '当你使用【杀】指定异性角色为目标后，其弃置一张手牌，或令你摸一张牌。', { equipSlot: 'WEAPON', range: 2 }),
  hanbing: equip('hanbing', 'WEAPON', '寒冰剑', 'Frost Sword', '当你使用【杀】造成伤害时，可以防止此伤害，改为弃置目标两张牌。', { equipSlot: 'WEAPON', range: 2 }),
  guding: equip('guding', 'WEAPON', '古锭刀', 'Ancient Scimitar', '锁定技，当你使用【杀】造成伤害时，若目标没有手牌，此伤害+1。', { equipSlot: 'WEAPON', range: 2 }),
  guanshi: equip('guanshi', 'WEAPON', '贯石斧', 'Stone Cleaver', '当你使用的【杀】被【闪】抵消时，可以弃置两张牌，令此【杀】依然造成伤害。', { equipSlot: 'WEAPON', range: 3 }),
  qinglong: equip('qinglong', 'WEAPON', '青龙偃月刀', 'Green Dragon Crescent Blade', '当你使用的【杀】被【闪】抵消时，可以对同一目标使用一张【杀】。', { equipSlot: 'WEAPON', range: 3 }),
  zhangba: equip('zhangba', 'WEAPON', '丈八蛇矛', 'Serpent Spear', '你可以将两张手牌当【杀】使用或打出。', { equipSlot: 'WEAPON', range: 3 }),
  fangtian: equip('fangtian', 'WEAPON', '方天画戟', 'Sky Piercer', '当你使用最后一张手牌【杀】时，可以额外选择至多两个目标。', { equipSlot: 'WEAPON', range: 4 }),
  qilin: equip('qilin', 'WEAPON', '麒麟弓', 'Qilin Bow', '当你使用【杀】造成伤害时，可以弃置目标装备区里的一张坐骑牌。', { equipSlot: 'WEAPON', range: 5 }),
  zhuque: equip('zhuque', 'WEAPON', '朱雀羽扇', 'Vermilion Feather Fan', '你可以将一张普通【杀】当火【杀】使用。', { equipSlot: 'WEAPON', range: 4 }),
  bagua: equip('bagua', 'ARMOR', '八卦阵', 'Eight Trigrams', '当你需要使用或打出【闪】时，可以进行判定；若为红色，视为你使用或打出一张【闪】。', { equipSlot: 'ARMOR', hookId: 'bagua_armor' }),
  renwang: equip('renwang', 'ARMOR', '仁王盾', 'Renwang Shield', '锁定技，黑色【杀】对你无效。', { equipSlot: 'ARMOR' }),
  tengjia: equip('tengjia', 'ARMOR', '藤甲', 'Vine Armor', '锁定技，普通【杀】、南蛮入侵、万箭齐发对你无效；你受到火焰伤害时，此伤害+1。', { equipSlot: 'ARMOR' }),
  baiyin: equip('baiyin', 'ARMOR', '白银狮子', 'Silver Lion', '锁定技，你每次受到伤害时，至多承受1点；你失去装备区里的此牌时，回复1点体力。', { equipSlot: 'ARMOR' }),
  jueying: equip('jueying', 'HORSE_PLUS', '绝影', 'Shadow Runner', '其他角色计算与你的距离+1。', { equipSlot: 'HORSE_PLUS' }),
  zhuahuang: equip('zhuahuang', 'HORSE_PLUS', '爪黄飞电', 'Yellow Lightning', '其他角色计算与你的距离+1。', { equipSlot: 'HORSE_PLUS' }),
  dilu: equip('dilu', 'HORSE_PLUS', '的卢', 'Dilu', '其他角色计算与你的距离+1。', { equipSlot: 'HORSE_PLUS' }),
  hualiu: equip('hualiu', 'HORSE_PLUS', '骅骝', 'Hualiu', '其他角色计算与你的距离+1。', { equipSlot: 'HORSE_PLUS' }),
  dawan: equip('dawan', 'HORSE_MINUS', '大宛', 'Dawan', '你计算与其他角色的距离-1。', { equipSlot: 'HORSE_MINUS' }),
  chitu: equip('chitu', 'HORSE_MINUS', '赤兔', 'Red Hare', '你计算与其他角色的距离-1。', { equipSlot: 'HORSE_MINUS' }),
  zixing: equip('zixing', 'HORSE_MINUS', '紫骍', 'Zixing', '你计算与其他角色的距离-1。', { equipSlot: 'HORSE_MINUS' })
};

const rankLabel = (rank: number): string => {
  if (rank === 1) return 'A';
  if (rank === 11) return 'J';
  if (rank === 12) return 'Q';
  if (rank === 13) return 'K';
  return String(rank);
};

function seeds(code: string, suit: string, ranks: number[]): SgsCardSeed[] {
  return ranks.map(rank => ({ code, suit, rank }));
}

/** Standard 108-card deck (53 basic + 35 tricks + 20 equipment). */
export const STANDARD_DECK: SgsCardSeed[] = [
  ...seeds('sha', '♠', [7, 8, 8, 9, 9, 10, 10]),
  ...seeds('sha', '♣', [2, 3, 4, 5, 6, 7, 8, 8, 9, 9, 10, 10, 11, 11]),
  ...seeds('sha', '♥', [10, 10, 11]),
  ...seeds('sha', '♦', [6, 7, 8, 9, 10, 13]),
  ...seeds('shan', '♥', [2, 2, 13]),
  ...seeds('shan', '♦', [2, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 11]),
  ...seeds('tao', '♥', [3, 4, 6, 7, 8, 9, 12]),
  ...seeds('tao', '♦', [2]),

  ...seeds('guohe', '♠', [3, 4, 12]),
  ...seeds('guohe', '♣', [3, 4]),
  ...seeds('guohe', '♥', [12]),
  ...seeds('shunshou', '♠', [3, 4, 11]),
  ...seeds('shunshou', '♦', [3, 4]),
  ...seeds('wuzhong', '♥', [7, 8, 9, 11]),
  ...seeds('juedou', '♠', [1]),
  ...seeds('juedou', '♣', [1]),
  ...seeds('juedou', '♦', [1]),
  ...seeds('jiedao', '♣', [12, 13]),
  ...seeds('nanman', '♠', [7, 13]),
  ...seeds('nanman', '♣', [7]),
  ...seeds('wanjian', '♥', [1]),
  ...seeds('taoyuan', '♥', [1]),
  ...seeds('wugu', '♥', [3, 4]),
  ...seeds('wuxie', '♠', [11]),
  ...seeds('wuxie', '♣', [12]),
  ...seeds('wuxie', '♥', [13]),
  ...seeds('lebu', '♠', [6]),
  ...seeds('lebu', '♥', [6]),
  ...seeds('lebu', '♣', [6]),
  ...seeds('shandian', '♠', [1]),
  ...seeds('shandian', '♥', [12]),

  ...seeds('zhuge', '♣', [1]),
  ...seeds('zhuge', '♦', [1]),
  ...seeds('qinggang', '♠', [6]),
  ...seeds('cixiong', '♠', [2]),
  ...seeds('hanbing', '♠', [2]),
  ...seeds('guanshi', '♦', [5]),
  ...seeds('qinglong', '♠', [5]),
  ...seeds('zhangba', '♠', [12]),
  ...seeds('fangtian', '♦', [12]),
  ...seeds('qilin', '♥', [5]),
  ...seeds('bagua', '♠', [2]),
  ...seeds('bagua', '♣', [2]),
  ...seeds('renwang', '♣', [2]),
  ...seeds('jueying', '♠', [5]),
  ...seeds('zhuahuang', '♥', [13]),
  ...seeds('dilu', '♣', [5]),
  ...seeds('hualiu', '♦', [13]),
  ...seeds('dawan', '♠', [13]),
  ...seeds('chitu', '♥', [5]),
  ...seeds('zixing', '♦', [13])
];

/** Military-expansion additions (54 cards); used by the `military` scenarios. */
export const MILITARY_DECK: SgsCardSeed[] = [
  ...seeds('huosha', '♥', [4, 7, 10]),
  ...seeds('huosha', '♦', [4, 5]),
  ...seeds('leisha', '♠', [4, 5, 6, 7, 8]),
  ...seeds('leisha', '♣', [5, 6, 7, 8]),
  ...seeds('jiu', '♠', [3, 9]),
  ...seeds('jiu', '♣', [3, 9]),
  ...seeds('jiu', '♦', [9]),
  ...seeds('shan', '♥', [8, 9, 11, 12]),
  ...seeds('shan', '♦', [6, 7, 8, 10, 11]),
  ...seeds('tao', '♥', [5, 6]),
  ...seeds('tao', '♦', [3, 12]),
  ...seeds('wuxie', '♠', [13]),
  ...seeds('wuxie', '♣', [13]),
  ...seeds('wuxie', '♥', [1]),
  ...seeds('wuxie', '♦', [12]),
  ...seeds('tiesuo', '♠', [11, 12]),
  ...seeds('tiesuo', '♣', [10, 11, 12, 13]),
  ...seeds('huogong', '♥', [2, 3]),
  ...seeds('huogong', '♦', [12]),
  ...seeds('bingliang', '♠', [10]),
  ...seeds('bingliang', '♣', [4]),
  ...seeds('tengjia', '♠', [2]),
  ...seeds('tengjia', '♣', [2]),
  ...seeds('guding', '♠', [1]),
  ...seeds('zhuque', '♦', [1]),
  ...seeds('baiyin', '♣', [1])
];

export function cardCustom(meta: SgsCardMeta, suit: string, rank: number): SgsCardCustom {
  return {
    code: meta.code,
    category: meta.category,
    subtype: meta.subtype,
    zh: meta.zh,
    en: meta.en,
    desc: meta.desc,
    suit,
    rank,
    color: suit === '♥' || suit === '♦' ? 'red' : 'black',
    ...(meta.element ? { element: meta.element } : {}),
    ...(meta.equipSlot ? { equipSlot: meta.equipSlot } : {}),
    ...(meta.range !== undefined ? { range: meta.range } : {}),
    ...(meta.hookId ? { hookId: meta.hookId } : {})
  };
}

export function cardTitle(meta: SgsCardMeta, suit: string, rank: number, serial?: string): string {
  const base = `${meta.zh} ${suit}${rankLabel(rank)}`;
  // Physical decks contain identical suit/rank copies. A short printed serial
  // keeps every entity's face distinct, which matters for hidden-information
  // audits and card overlays that must never confuse two copies.
  return serial ? `${base} ·${serial.slice(-3)}` : base;
}

export function suitIsRed(suit: string): boolean {
  return suit === '♥' || suit === '♦';
}

export function suitColor(suit: string): string {
  return suitIsRed(suit) ? '#c62828' : '#212121';
}

export function rankText(rank: number): string {
  return rankLabel(rank);
}

export function isStrikeCode(code: string): boolean {
  return code === 'sha' || code === 'huosha' || code === 'leisha';
}

export function isStrikeSubtype(subtype: string): boolean {
  return subtype === 'STRIKE';
}
