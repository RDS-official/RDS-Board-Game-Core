import { RuleHookImpl } from '@rds/kernel/rules';

/**
 * Sanguosha rule aspects.
 *
 * 实现住在这里，状态里只放 `ActiveRuleHook` 描述符（hookId + owner + params），
 * 因此 `GameState` 始终是 JSON 可序列化的。
 *
 * ## 八阵图（`bagua_armor`）：声明式规则的样板
 *
 * 旧实现：钩子只返回一句提示，真正判定手写在 `rules.ts` 的 `case 'JUDGE_BAGUA'`
 * 分支里 —— 钩子形同虚设（AR-49）。
 *
 * 新实现：钩子接管**判定**这一步。它不改变游戏流程（攻击照旧进栈、目标照旧
 * 有「出闪 / 用八卦 / 挨打」三个选择），只在目标选择"用八卦阵"时把这次判定
 * 的**规则参数**声明出来：
 *
 *   - `redIsDodge`：判红牌算闪避成功；
 *   - `damageOnFail`：判黑则承受 1 点伤害；
 *   - `successMeans`：成功意味着这一刀被闪掉。
 *
 * `rules.ts` 只保留一个**通用判定执行器**：掷骰、按参数解释结果、结算后果。
 * 它不认识"八阵图"，换成"乐不思蜀"或任何其它判定牌，改的是钩子而不是 reducer。
 */
export const SANGUOSHA_HOOKS: RuleHookImpl[] = [
  {
    id: 'bagua_armor',
    name: 'Eight Trigrams Defense',
    stage: 'BEFORE_REPLACE',
    priority: 50,
    description:
      'When the owner judges for a Dodge, a red judgement counts as a Dodge and a black one lets the strike through.',
    /**
     * 拦 `JUDGE_BAGUA`：只有当发起判定的正是这件护甲的主人时才介入。
     *
     * 注意**不是**拦 `PLAY_STRIKE`：攻击照旧进栈并开放响应窗口，目标仍然可以
     * 选择出闪、用八卦、或直接挨打。钩子介入的是"决定用八卦之后"那一步。
     */
    predicate: (action, _state, ctx) =>
      action.type === 'JUDGE_BAGUA' &&
      (ctx.instance.ownerId === undefined || action.playerId === ctx.instance.ownerId),
    /**
     * MODIFY：把这次判定的规则参数写进 payload，交给通用执行器。
     *
     * 用 MODIFY 而不是 REPLACE —— 判定动作本身不变，变的是它的**语义参数**。
     * 这样 reducer 仍然按同一个入口执行，钩子负责"这条规则怎么判定"。
     */
    handler: (action, _state, ctx) => {
      const params = ctx.params as {
        damageOnFail?: unknown;
        redIsDodge?: unknown;
      };
      const damage = Number(params.damageOnFail ?? 1);
      return {
        type: 'MODIFY',
        modifiedAction: {
          ...action,
          payload: {
            ...(action.payload ?? {}),
            // 钩子声明的规则；reducer 只按这些值执行。
            redIsDodge: params.redIsDodge !== false,
            damageOnFail: Number.isFinite(damage) && damage >= 0 ? damage : 1,
            successMeans: 'DODGE',
            ruleId: ctx.instance.hookId
          }
        },
        message: 'Eight Trigrams: red judges a Dodge, black lets the strike through.'
      };
    }
  }
];
