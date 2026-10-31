/**
 * Presentation hints for 山屋惊魂 (Betrayal at House on the Hill).
 *
 * The card vocabulary (weapon / armor / relic / ...) and the derived fact rows the
 * HUD shows live here, next to the rules that produce the `custom` bag, instead of
 * inside the generic inspection path in packages/app.
 */

const KIND_LABELS: Record<string, string> = {
  weapon: '武器',
  armor: '护甲',
  relic: '圣物',
  consumable: '消耗品',
  tool: '工具'
};

/** Fact rows for an item / omen / event card's `custom` bag. */
export function betrayalCardFacts(custom: Record<string, unknown>): { label: string; value: string }[] {
  const facts: { label: string; value: string }[] = [];
  if (custom.kind) facts.push({ label: '类别', value: KIND_LABELS[String(custom.kind)] ?? String(custom.kind) });
  if (typeof custom.charges === 'number' && custom.charges > 0) {
    facts.push({ label: '剩余次数', value: String(custom.charges) });
  }
  if (custom.tradeable === false) facts.push({ label: '交易', value: '不可交易' });
  if (custom.companion) facts.push({ label: '随从', value: '不可丢弃' });
  if (custom.stealable === false) facts.push({ label: '夺取', value: '不可被抢' });
  return facts;
}
