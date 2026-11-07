/**
 * C-9 declaration for the Sanguosha fixture.
 *
 * The kernel enforces `globalVars` exactly; keeping the list next to the module
 * means new rule state cannot silently grow outside the declared schema.
 */
export const SANGUOSHA_GLOBAL_VARS = [
  'drawDeckCount',
  'hasPlayedStrikeThisTurn',
  'mode',
  'variant',
  'playerCount',
  'seats',
  'pendingTrick',
  'wuxieCount',
  'strike',
  'duel',
  'massTrick',
  'pendingChoice',
  'strikeQueue',
  'dying',
  'lastDamage',
  'lastJudge',
  'finalWinner',
  'finalReason',
  'scoreDeltas',
  'turnOwner'
] as const;

export const SANGUOSHA_CUSTOM_PROPS = [
  // player state
  'hp',
  'maxHp',
  'points',
  'heroId',
  'heroName',
  'kingdom',
  'kingdomLabel',
  'gender',
  'genderLabel',
  'skills',
  'skillNames',
  'lordSkills',
  'chained',
  'skipPlay',
  'skipDraw',
  'wineBonus',
  'wineUsed',
  'rendeGiven',
  'rendeHealed',
  'zhihengUsed',
  'kurouUsed',
  'qingnangUsed',
  'jieyinUsed',
  'lijianUsed',
  'strikesUsed',
  'roleRevealed',
  'dying',
  'seatIndex',
  'isAi',
  'aiTier',
  // card state
  'code',
  'category',
  'subtype',
  'zh',
  'en',
  'desc',
  'actionLabel',
  'suit',
  'rank',
  'color',
  'element',
  'equipSlot',
  'range',
  'hookId'
] as const;
