import { RuleHookImpl } from '@rds/kernel/rules';

/**
 * Equipment rule aspects.
 *
 * The live state stores only `{ hookId, ownerId, sourceEntityId, params }`.
 * `syncEquipmentHooks()` rebuilds these descriptors whenever a card enters or
 * leaves an equipment zone. The reducer itself contains a generic judgement
 * executor and does not know the name "八阵图".
 */
export const SANGUOSHA_HOOKS: RuleHookImpl[] = [
  {
    id: 'bagua_armor',
    name: 'Eight Trigrams Defense',
    stage: 'BEFORE_REPLACE',
    priority: 50,
    description:
      'When the owner judges for a Dodge, a red judgement counts as a Dodge and a black one lets the strike through.',
    predicate: (action, _state, ctx) =>
      action.type === 'JUDGE_BAGUA' &&
      (ctx.instance.ownerId === undefined || action.playerId === ctx.instance.ownerId),
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
