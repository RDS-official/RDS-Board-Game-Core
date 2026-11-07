export type SgsKingdom = 'WEI' | 'SHU' | 'WU' | 'QUN';
export type SgsSkillKind = 'ACTIVE' | 'TRIGGERED' | 'PASSIVE' | 'LORD';

export interface SgsSkill {
  id: string;
  name: string;
  kind: SgsSkillKind;
  desc: string;
}

export interface SgsHero {
  id: string;
  name: string;
  en: string;
  kingdom: SgsKingdom;
  gender: 'MALE' | 'FEMALE';
  maxHp: number;
  avatar: string;
  skills: SgsSkill[];
}

/**
 * The playable standard-pack roster shipped by this fixture.
 *
 * Every skill printed below has a rule implementation in `rules.ts` or the
 * shared helpers; the roster deliberately excludes heroes whose second skill
 * would otherwise have to be a stub.
 */
export const SANGUOSHA_HEROES: SgsHero[] = [
  {
    id: 'liubei',
    name: '刘备',
    en: 'Liu Bei',
    kingdom: 'SHU',
    gender: 'MALE',
    maxHp: 4,
    avatar: '👑',
    skills: [
      { id: 'rende', name: '仁德', kind: 'ACTIVE', desc: '出牌阶段，你可以将一张手牌交给一名其他角色；你于此阶段给出第二张牌时回复1点体力。' },
      { id: 'jijiang', name: '激将', kind: 'LORD', desc: '主公技，当你需要使用或打出【杀】时，其他蜀势力角色可以替你打出【杀】。' }
    ]
  },
  {
    id: 'guanyu',
    name: '关羽',
    en: 'Guan Yu',
    kingdom: 'SHU',
    gender: 'MALE',
    maxHp: 4,
    avatar: '🐉',
    skills: [{ id: 'wusheng', name: '武圣', kind: 'ACTIVE', desc: '你可以将一张红色牌当【杀】使用或打出。' }]
  },
  {
    id: 'zhangfei',
    name: '张飞',
    en: 'Zhang Fei',
    kingdom: 'SHU',
    gender: 'MALE',
    maxHp: 4,
    avatar: '⚔️',
    skills: [{ id: 'paoxiao', name: '咆哮', kind: 'PASSIVE', desc: '锁定技，你使用【杀】无次数限制。' }]
  },
  {
    id: 'zhaoyun',
    name: '赵云',
    en: 'Zhao Yun',
    kingdom: 'SHU',
    gender: 'MALE',
    maxHp: 4,
    avatar: '🛡️',
    skills: [{ id: 'longdan', name: '龙胆', kind: 'ACTIVE', desc: '你可以将【杀】当【闪】、【闪】当【杀】使用或打出。' }]
  },
  {
    id: 'machao',
    name: '马超',
    en: 'Ma Chao',
    kingdom: 'SHU',
    gender: 'MALE',
    maxHp: 4,
    avatar: '🐎',
    skills: [{ id: 'tieqi', name: '铁骑', kind: 'TRIGGERED', desc: '当你使用【杀】指定目标后，你可以判定；若为红色，此【杀】不可被【闪】响应。' }]
  },
  {
    id: 'huangyueying',
    name: '黄月英',
    en: 'Huang Yueying',
    kingdom: 'SHU',
    gender: 'FEMALE',
    maxHp: 3,
    avatar: '⚙️',
    skills: [
      { id: 'jizhi', name: '集智', kind: 'TRIGGERED', desc: '当你使用一张非延时锦囊牌时，你可以摸一张牌。' },
      { id: 'qicai', name: '奇才', kind: 'PASSIVE', desc: '锁定技，你使用锦囊牌无距离限制。' }
    ]
  },
  {
    id: 'caocao',
    name: '曹操',
    en: 'Cao Cao',
    kingdom: 'WEI',
    gender: 'MALE',
    maxHp: 4,
    avatar: '🦅',
    skills: [
      { id: 'jianxiong', name: '奸雄', kind: 'TRIGGERED', desc: '当你受到伤害后，你可以获得造成此伤害的牌。' },
      { id: 'hujia', name: '护驾', kind: 'LORD', desc: '主公技，当你需要使用或打出【闪】时，其他魏势力角色可以替你打出【闪】。' }
    ]
  },
  {
    id: 'xiahoudun',
    name: '夏侯惇',
    en: 'Xiahou Dun',
    kingdom: 'WEI',
    gender: 'MALE',
    maxHp: 4,
    avatar: '🎯',
    skills: [{ id: 'ganglie', name: '刚烈', kind: 'TRIGGERED', desc: '当你受到伤害后，你可以判定；若结果不为红桃，伤害来源失去1点体力。' }]
  },
  {
    id: 'zhenji',
    name: '甄姬',
    en: 'Zhen Ji',
    kingdom: 'WEI',
    gender: 'FEMALE',
    maxHp: 3,
    avatar: '🌊',
    skills: [
      { id: 'qingguo', name: '倾国', kind: 'ACTIVE', desc: '你可以将一张黑色手牌当【闪】使用或打出。' },
      { id: 'luoshen', name: '洛神', kind: 'TRIGGERED', desc: '准备阶段，你可以亮出牌堆顶一张牌；若为黑色，你获得之并重复此流程。' }
    ]
  },
  {
    id: 'sunquan',
    name: '孙权',
    en: 'Sun Quan',
    kingdom: 'WU',
    gender: 'MALE',
    maxHp: 4,
    avatar: '🔱',
    skills: [
      { id: 'zhiheng', name: '制衡', kind: 'ACTIVE', desc: '出牌阶段限一次，你可以弃置一张牌，然后摸一张牌。' },
      { id: 'jiuyuan', name: '救援', kind: 'LORD', desc: '主公技，其他吴势力角色对你使用【桃】时，其摸一张牌。' }
    ]
  },
  {
    id: 'ganning',
    name: '甘宁',
    en: 'Gan Ning',
    kingdom: 'WU',
    gender: 'MALE',
    maxHp: 4,
    avatar: '🏴‍☠️',
    skills: [{ id: 'qixi', name: '奇袭', kind: 'ACTIVE', desc: '你可以将一张黑色牌当【过河拆桥】使用。' }]
  },
  {
    id: 'huanggai',
    name: '黄盖',
    en: 'Huang Gai',
    kingdom: 'WU',
    gender: 'MALE',
    maxHp: 4,
    avatar: '🔥',
    skills: [{ id: 'kurou', name: '苦肉', kind: 'ACTIVE', desc: '出牌阶段限一次，你可以失去1点体力，然后摸两张牌。' }]
  },
  {
    id: 'luxun',
    name: '陆逊',
    en: 'Lu Xun',
    kingdom: 'WU',
    gender: 'MALE',
    maxHp: 3,
    avatar: '📜',
    skills: [
      { id: 'qianxun', name: '谦逊', kind: 'PASSIVE', desc: '锁定技，你不能成为【顺手牵羊】和【乐不思蜀】的目标。' },
      { id: 'lianying', name: '连营', kind: 'TRIGGERED', desc: '当你失去最后的手牌时，你可以摸一张牌。' }
    ]
  },
  {
    id: 'sunshangxiang',
    name: '孙尚香',
    en: 'Sun Shangxiang',
    kingdom: 'WU',
    gender: 'FEMALE',
    maxHp: 3,
    avatar: '🏹',
    skills: [
      { id: 'jieyin', name: '结姻', kind: 'ACTIVE', desc: '出牌阶段限一次，你可以弃置两张手牌，令你与一名已受伤男性角色各回复1点体力。' },
      { id: 'xiaoji', name: '枭姬', kind: 'TRIGGERED', desc: '当你失去装备区里的一张牌时，你可以摸两张牌。' }
    ]
  },
  {
    id: 'huatuo',
    name: '华佗',
    en: 'Hua Tuo',
    kingdom: 'QUN',
    gender: 'MALE',
    maxHp: 3,
    avatar: '🌿',
    skills: [
      { id: 'jijiu', name: '急救', kind: 'ACTIVE', desc: '你的回合外，你可以将一张红色牌当【桃】使用。' },
      { id: 'qingnang', name: '青囊', kind: 'ACTIVE', desc: '出牌阶段限一次，你可以弃置一张手牌，令一名已受伤角色回复1点体力。' }
    ]
  },
  {
    id: 'lvbu',
    name: '吕布',
    en: 'Lü Bu',
    kingdom: 'QUN',
    gender: 'MALE',
    maxHp: 4,
    avatar: '🏇',
    skills: [{ id: 'wushuang', name: '无双', kind: 'PASSIVE', desc: '锁定技，当你使用【杀】时，目标需连续使用两张【闪】；当你进行【决斗】时，对方需连续打出两张【杀】。' }]
  },
  {
    id: 'diaochan',
    name: '貂蝉',
    en: 'Diao Chan',
    kingdom: 'QUN',
    gender: 'FEMALE',
    maxHp: 3,
    avatar: '🌸',
    skills: [
      { id: 'lijian', name: '离间', kind: 'ACTIVE', desc: '出牌阶段限一次，你可以弃置一张牌，令两名男性角色进行【决斗】。' },
      { id: 'biyue', name: '闭月', kind: 'TRIGGERED', desc: '结束阶段，你可以摸一张牌。' }
    ]
  }
];

const BY_ID = new Map(SANGUOSHA_HEROES.map(hero => [hero.id, hero]));

export const CLASSIC_HERO_IDS = ['liubei', 'guanyu', 'caocao', 'lvbu'] as const;

export function heroById(id: string): SgsHero | undefined {
  return BY_ID.get(id);
}

export function skillsOf(hero: SgsHero, includeLord = true): SgsSkill[] {
  return hero.skills.filter(skill => includeLord || skill.kind !== 'LORD');
}

export const KINGDOM_COLOR: Record<SgsKingdom, string> = {
  WEI: '#3b6fb6',
  SHU: '#3f8a4c',
  WU: '#b6453f',
  QUN: '#7b5aa6'
};

export const KINGDOM_LABEL: Record<SgsKingdom, string> = {
  WEI: '魏',
  SHU: '蜀',
  WU: '吴',
  QUN: '群'
};

export const GENDER_LABEL: Record<'MALE' | 'FEMALE', string> = {
  MALE: '男',
  FEMALE: '女'
};
