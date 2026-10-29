import { Action, ProjectedGameState } from '@rds/kernel/types';
import { UiAction } from './contracts';
import { translateText } from './i18n';

/**
 * 宝可梦璀璨宝石 (Pokémon Splendor) 词汇表。
 *
 * `TAKE_3_DIFF_GEMS` / `TAKE_2_SAME_GEMS` / `BUY_CARD` / `RESERVE_CARD` /
 * `EVOLVE` 这五个动作类型由 splendor 夹具独占产出，所以这里可以放心地按
 * 宝可梦语义描述：币种是六色精灵球，`purple` 即大师球（万能替代色）。
 */
const BALL_ZH: Record<string, string> = {
  red: '红',
  blue: '蓝',
  black: '黑',
  pink: '粉',
  yellow: '黄',
  purple: '紫'
};

/** 单色精灵球图标；`purple` 用紫球表现大师球。 */
const BALL_ICON: Record<string, string> = {
  red: '🔴',
  blue: '🔵',
  black: '⚫',
  pink: '💗',
  yellow: '🟡',
  purple: '🟣'
};

const ballZh = (gem: unknown): string => BALL_ZH[String(gem ?? '')] ?? '精灵';
const ballIcon = (gem: unknown): string => BALL_ICON[String(gem ?? '')] ?? '⚪';

/** `payload.gems` 是任意输入，收窄成颜色字符串数组后再渲染。 */
const ballList = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((gem): gem is string => typeof gem === 'string') : [];

function describeActionZh(
  state: ProjectedGameState,
  action: Action
): { icon: string; label: string; hint: string; tone: UiAction['tone']; fields?: UiAction['fields'] } | null {
    const name = (id?: string) => (id ? state.players[id]?.name ?? id : '');
    const card = (id?: string) => {
      if (!id) return '未知卡牌';
      const entity = state.entities[id];
      return (
        (entity?.components?.custom?.zh as string | undefined) ??
        (entity?.components?.custom?.name as string | undefined) ??
        entity?.components?.cardFace?.title ??
        '未知卡牌'
      );
    };
    /**
     * Splendor card detail. Evolution hints live in `custom` (`evolvesTo` /
     * `evoCost`), so the label can explain the requirement without re-deriving
     * the rules here.
     */
    const cardInfo = (
      id?: string
    ): { name: string; reward: string; evo: { color: string; count: number } | null } => {
      const entity = id ? state.entities[id] : undefined;
      const custom = (entity?.components?.custom ?? {}) as Record<string, unknown>;
      const bonus = typeof custom.bonus === 'string' && custom.bonus !== 'none' ? custom.bonus : null;
      const bonusCount = Number(custom.bonusCount ?? 1);
      const vp = Number(custom.vp ?? entity?.components?.cardFace?.score ?? 0);
      const rawEvo = custom.evoCost as { color?: unknown; count?: unknown } | null | undefined;
      const reward = [
        vp > 0 ? `+${vp} 分` : null,
        bonus ? `+${bonusCount} ${ballZh(bonus)}色加成` : null
      ]
        .filter(Boolean)
        .join(' · ');
      return {
        name: card(id),
        reward,
        evo:
          rawEvo && typeof rawEvo.color === 'string' && typeof rawEvo.count === 'number'
            ? { color: rawEvo.color, count: rawEvo.count }
            : null
      };
    };

    switch (action.type) {
      case 'ROLL_DICE':
        return { icon: '🎲', label: '掷骰子', hint: '2D6 · 自然随机源 c', tone: 'primary' };
      case 'PROPOSE_TRADE':
        return {
          icon: '🤝',
          label: '发起玩家交易',
          hint: '1:1 · 首个接受的玩家成交',
          tone: 'normal',
          fields: action.fields
        };
      case 'END_TURN':
        return { icon: '⌛', label: '结束回合', hint: '移交行动权', tone: 'normal' };
      case 'PLAY_STRIKE':
        return { icon: '⚔️', label: `出【杀】→ ${name(action.targetPlayerId)}`, hint: '开启【闪】响应窗口', tone: 'primary' };
      case 'PLAY_DODGE':
        return { icon: '🛡️', label: '出【闪】', hint: '抵消此【杀】', tone: 'primary' };
      case 'JUDGE_BAGUA':
        return { icon: '☯️', label: '发动【八卦阵】', hint: '判定红牌即视为闪', tone: 'primary' };
      case 'PLAY_PEACH':
        return { icon: '🍑', label: '出【桃】', hint: '回复 1 点体力', tone: 'primary' };
      case 'PLAY_WUXIE':
        return { icon: '📜', label: '打出【无懈可击】', hint: '压栈反制 · 可被再反制', tone: 'primary' };
      case 'PASS':
        return { icon: '⊘', label: '放弃响应', hint: 'Pass · 让栈顶结算', tone: 'danger' };
      case 'DRAW_CARDS':
        return { icon: '🎴', label: '摸 2 张牌', hint: '从牌堆抽取', tone: 'normal' };
      /* ---- 宝可梦璀璨宝石 (Pokémon Splendor) ---------------------------- */
      case 'TAKE_3_DIFF_GEMS': {
        // 1–3 colours: the bank may not cover three, and the 10-ball cap bites.
        // Each legal combination is its own action, so the colours go into the
        // label — otherwise ten identical buttons are indistinguishable.
        const gems = ballList(action.payload?.gems);
        const count = gems.length > 0 ? gems.length : 3;
        return {
          icon: '🥎',
          label: `拿走 ${count} 个不同颜色的精灵球${
            gems.length > 0 ? ` · ${gems.map(ballZh).join('/')}` : ''
          }`,
          hint: `共 ${count} 颗，每色各 1 颗 · 大师球不可直取`,
          tone: 'primary'
        };
      }
      case 'TAKE_2_SAME_GEMS': {
        const gem = action.payload?.gem;
        const color = typeof gem === 'string' && BALL_ZH[gem] ? `${ballZh(gem)}色` : '同色';
        return {
          icon: ballIcon(gem),
          label: `拿走 2 个${color}精灵球`,
          hint: '同色双取 · 该色银行需 ≥ 4 颗',
          tone: 'normal'
        };
      }
      case 'BUY_CARD': {
        const info = cardInfo(action.entityId);
        return {
          icon: '⚡',
          label: `捕捉宝可梦 [${info.name}]`,
          hint: `支付精灵球${info.reward ? ` · ${info.reward}` : ''}`,
          tone: 'primary',
          fields: action.fields
        };
      }
      case 'RESERVE_CARD': {
        const tier = action.payload?.fromTier;
        const info = cardInfo(action.entityId);
        return {
          icon: '🎒',
          // Blind draw from the level deck: no card id, only a tier.
          label: tier !== undefined && tier !== null ? `从第 ${String(tier)} 阶牌堆盲抽保留` : `保留卡牌 [${info.name}]`,
          hint: '并获得 1 个大师球 · 上限 3 张',
          tone: 'normal'
        };
      }
      case 'EVOLVE': {
        const from = cardInfo(action.payload?.fromId);
        const to = cardInfo(action.payload?.toId);
        return {
          icon: '🧬',
          label: `进化：${from.name} → ${to.name}`,
          hint: `免费 · 不消耗行动 · 每回合 1 次${
            from.evo ? ` · 需 ${from.evo.count} 个${ballZh(from.evo.color)}色加成` : ''
          }`,
          tone: 'primary'
        };
      }
      case 'EXPLORE_DOOR':
        return { icon: '🚪', label: `探索房门 · ${action.payload?.direction ?? ''}`, hint: '抽房间板块，再选择朝向', tone: 'primary' };
      case 'PLACE_ROOM':
        return {
          icon: '🧭',
          label: `放置「${action.payload?.defName ?? '房间板块'}」`,
          hint: '旋转板块，把门接到入口方向；相邻门会自动连通',
          tone: 'primary',
          fields: action.fields
        };
      case 'MOVE_TO_ROOM':
        return { icon: '🚶', label: '移动至相邻房间', hint: '在弹窗中选择目标房间', tone: 'normal' };
      case 'ROOM_FEATURE':
        return action.payload?.feature === 'VAULT'
          ? { icon: '🗄', label: '撬开金库', hint: '知识检定 6 或使用骷髅钥匙 · 获得 2 件物品', tone: 'primary' }
          : { icon: '✦', label: '使用房间特性', hint: '触发当前房间的特殊效果', tone: 'normal' };
      case 'MOVE_NPC':
        return { icon: '👹', label: '怪物移动', hint: '在弹窗中选择目标房间', tone: 'danger' };
      /* ---- two-phase check window (K4) -------------------------------- */
      case 'DECLARE_CHECK':
        return {
          icon: '✧',
          label: `声明修正 · ${String(action.payload?.label ?? action.payload?.option ?? '')}`,
          hint: '掷骰前使用，影响本次检定的骰数或结果',
          tone: 'normal'
        };
      case 'ROLL_CHECK':
        return { icon: '🎲', label: '掷骰检定', hint: '掷出骰子后再决定是否使用幸运道具', tone: 'primary' };
      case 'CHECK_REACTION':
        return {
          icon: '🍀',
          label: `检定响应 · ${String(action.payload?.label ?? action.payload?.option ?? '')}`,
          hint: '掷骰后使用，可重掷最低骰或追加修正',
          tone: 'normal'
        };
      case 'RESOLVE_CHECK':
        return { icon: '✓', label: '结算检定', hint: '按当前结果结算，不再使用道具', tone: 'normal' };
      case 'ROLL_HAUNT_CHECK':
        return { icon: '🕯️', label: '进行作祟检定', hint: '6 颗 0/1/2 骰 · 总和低于预兆数则作祟', tone: 'danger' };
      case 'ATTACK_COMBAT':
        return { icon: '🩸', label: `攻击 ${name(action.targetPlayerId)}`, hint: '力量对抗掷骰', tone: 'danger' };
      case 'ATTACK_PLAYER':
        return {
          icon: '⚔️',
          label: `攻击 ${name(action.targetPlayerId)}`,
          hint: '武器与偷窃在参数中选择 · 平局无伤',
          tone: 'danger',
          fields: action.fields
        };
      case 'ATTACK_MONSTER':
        return {
          icon: '👹',
          label: `攻击 ${card(action.entityId)}`,
          hint: '胜负差为伤害 · 胜出击晕怪物',
          tone: 'danger',
          fields: action.fields
        };
      case 'ATTACK_HERO':
        return {
          icon: '👹',
          label: `怪物攻击 ${name(action.targetPlayerId)}`,
          hint: '同房间英雄 · 由叛徒操控',
          tone: 'danger'
        };
      case 'END_NPC_TURN':
        return { icon: '⌛', label: '结束怪物回合', hint: '交给下一只怪物 / 下一位英雄', tone: 'normal' };
      case 'SLAP':
        return { icon: '👋', label: `拍醒 ${name(action.targetPlayerId)}`, hint: '力量对抗 · 成功后永久免疫控制', tone: 'primary' };
      case 'ALLOCATE_DAMAGE':
        return {
          icon: '🩸',
          label: '选择承受伤害的属性',
          hint: '肉体伤害扣力量或速度 · 精神伤害扣神智或知识',
          tone: 'danger',
          fields: action.fields
        };
      case 'USE_ITEM':
        return { icon: '🎒', label: `使用「${card(action.entityId)}」`, hint: '每件物品每回合一次', tone: 'primary', fields: action.fields };
      case 'DROP_ITEM':
        return {
          icon: '🫸',
          label: `丢下「${card(action.entityId)}」`,
          hint: '在房间形成物品堆；只有一件时按钮直接执行',
          tone: 'normal'
        };
      case 'PICK_UP_ITEM':
        return { icon: '🫳', label: `拾取「${card(action.entityId)}」`, hint: '从当前房间的物品堆取走', tone: 'normal' };
      case 'PLACE_ENTITY':
        return {
          icon: '📍',
          label: `放置「${card(action.entityId)}」`,
          hint: '吸附到合法 node/edge/slot',
          tone: 'primary'
        };
      case 'PROPOSE_ITEM_TRADE':
        return {
          icon: '🤝',
          label: '提出同房间交易',
          hint: '同房间玩家首个接受者成交',
          tone: 'normal',
          fields: action.fields
        };
      case 'ACCEPT_TRADE':
        return { icon: '✅', label: '接受交易', hint: '交换双方物品', tone: 'primary' };
      case 'REJECT_TRADE':
        return { icon: '✖️', label: '拒绝交易', hint: '不交换', tone: 'danger' };
      case 'USE_ELEVATOR':
        return { icon: '🛗', label: '乘神秘电梯', hint: '移动到任意已探索房间', tone: 'primary' };
      case 'JUMP_DOWN':
        return { icon: '🪜', label: '沿楼座跳下舞厅', hint: '有麻绳则无伤，否则 1 点坠落伤害', tone: 'danger' };
      case 'CLIMB_UP':
        return { icon: '🪜', label: '沿麻绳攀上楼座', hint: '需持有麻绳 · 消耗 1 点移动力', tone: 'normal' };
      case 'SEAL_RITUAL':
        return { icon: '📜', label: '破译神圣符文', hint: '知识 5+ · 进度 2/2 封印木乃伊', tone: 'primary' };
      case 'SEARCH_BONES':
        return { icon: '🦴', label: '搜寻怨灵遗骨', hint: '知识 4+ · 每回合一次', tone: 'normal' };
      case 'CHANT':
        return { icon: '🕯️', label: '安魂咏唱', hint: '神智 5+ · 进度 3/3 超度怨灵', tone: 'primary' };
      case 'DESTROY_BEACON':
        return { icon: '💥', label: '炸毁飞船信标', hint: '所有巨眼已被摧毁', tone: 'danger' };
      case 'BREW_HOLY_WATER':
        return { icon: '⚗️', label: '调配圣水', hint: '知识 4+ · 获得净化圣水', tone: 'primary' };
      case 'SANCTIFY_HOUSE':
        return { icon: '✨', label: '注入圣水池圣化', hint: '知识/神智 4+ · 进度 2/2 净化全宅', tone: 'primary' };
      case 'FORGE_SILVER':
        return { icon: '⚔️', label: '打造银制武器', hint: '力量 4+ · 获得银色子弹', tone: 'primary' };
      case 'SUPPRESS_CURSE':
        return { icon: '🌕', label: '月相压制仪式', hint: '知识 4+ · 进度 3/3 驱散狼人诅咒', tone: 'primary' };
      case 'PEEK_TOP':
        return { icon: '🔮', label: '将顶牌留在牌堆顶', hint: '水晶球窥视', tone: 'normal' };
      case 'PEEK_BOTTOM':
        return { icon: '🔮', label: '将顶牌置于牌堆底', hint: '水晶球窥视', tone: 'normal' };
      case 'COMMIT_BATTLE_DIAL':
        return {
          icon: '🔒',
          label: `锁定战斗转盘 · 兵 ${action.payload?.troops ?? '?'}`,
          hint: `将领 ${action.payload?.leaderStr ?? '?'} · ${action.payload?.weapon ?? '武器'}`,
          tone: 'primary'
        };
      case 'OPEN_BATTLE_WINDOW':
        return { icon: '🎛️', label: '开启秘密战斗窗口', hint: '双方同步盲提 · |𝒫(s)| > 1', tone: 'primary' };
      case 'TRIGGER_MAHJONG_DISCARD':
        return { icon: '🀄', label: '打出 [九条]', hint: '开启吃/碰/胡抢断栈', tone: 'primary' };
      case 'MAHJONG_HU':
        return { icon: '🀄', label: '【胡】优先级 30', hint: '立即短路截断全场', tone: 'danger' };
      case 'MAHJONG_PENG':
        return { icon: '🀄', label: '【碰】优先级 20', hint: '刻子成组', tone: 'primary' };
      case 'MAHJONG_CHI':
        return { icon: '🀄', label: '【吃】优先级 10', hint: '顺子成组', tone: 'normal' };
      case 'SWITCH_TO_MAHJONG_DEMO':
        return { icon: '↺', label: '切换到麻将抢断演示', hint: '优先级短路', tone: 'normal' };
      case 'SWITCH_TO_DUNE_DEMO':
        return { icon: '↺', label: '切换到沙丘盲提演示', hint: '同步提交', tone: 'normal' };
      case 'BUY_DEV_CARD':
        return { icon: '📜', label: '购买发展卡', hint: '1羊 1麦 1矿 · 当回合不可打出', tone: 'primary' };
      case 'PLAY_KNIGHT':
        return { icon: '🐎', label: '打出【骑士】', hint: '移动强盗并偷取 1 资源', tone: 'primary' };
      case 'PLAY_ROAD_BUILDING':
        return { icon: '🛣️', label: '打出【修路】', hint: '免费放置 2 条道路', tone: 'primary' };
      case 'PLAY_YEAR_OF_PLENTY':
        return { icon: '🌟', label: '打出【丰饶】', hint: '从银行取 2 个资源', tone: 'primary' };
      case 'PLAY_MONOPOLY':
        return { icon: '💰', label: '打出【垄断】', hint: '夺取一种资源', tone: 'primary' };
      case 'STEAL_FROM':
        return { icon: '🦹', label: `偷取 ${name(action.targetPlayerId)}`, hint: '随机 1 张资源', tone: 'danger' };
      case 'BANK_TRADE':
        return {
          icon: '🏦',
          label: '银行 / 港口交易',
          hint: '4:1，拥有港口可 3:1 / 2:1',
          tone: 'normal',
          fields: action.fields
        };
      case 'ACCEPT_TRADE':
        return { icon: '✅', label: `接受交易 · ${name(action.playerId)}`, hint: '1:1 交换', tone: 'primary' };
      case 'REJECT_TRADE':
        return { icon: '✖️', label: `拒绝交易 · ${name(action.playerId)}`, hint: '不交换', tone: 'danger' };
      case 'SKIP_ROAD_BUILDING':
        return { icon: '⏭️', label: '不再放置道路', hint: '结束修路卡结算', tone: 'normal' };
      case 'DISCARD_HALF':
        return {
          icon: '🗑️',
          label: `弃置一半 · ${name(action.playerId)}`,
          hint: '超过 7 张时强制弃牌',
          tone: 'danger'
        };
      default:
        return { icon: '•', label: action.type, hint: '合法动作', tone: 'normal' };
    }
  
}

export function describeActionView(
  state: ProjectedGameState,
  action: Action
): { icon: string; label: string; hint: string; tone: UiAction['tone']; fields?: UiAction['fields'] } | null {
  const view = describeActionZh(state, action);
  if (!view) return null;
  return { ...view, label: translateText(view.label), hint: translateText(view.hint) };
}