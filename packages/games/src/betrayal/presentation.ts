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

/**
 * Category band, plate tone and seal glyph for 山屋's own card taxonomy.
 *
 * The HUD only understands opaque tone tokens (danger / treasure / event /
 * place …); the mapping from OMEN / ITEM / EVENT / ROOM to those tokens — and the
 * Chinese band text — is the mansion's vocabulary, so it lives here.
 */
const CARD_STYLES: Record<string, { badge: string; tone: string; seal: string }> = {
  OMEN: { badge: '预兆 · OMEN', tone: 'danger', seal: '👁' },
  ITEM: { badge: '遗物 · ITEM', tone: 'treasure', seal: '◆' },
  EVENT: { badge: '事件 · EVENT', tone: 'event', seal: '✦' },
  ROOM: { badge: '房间 · ROOM', tone: 'place', seal: '⌂' }
};

/** Presentation for one card's `custom` bag; unclassified cards keep the neutral plate. */
export function betrayalCardStyle(custom: Record<string, unknown>): {
  badge?: string;
  tone?: string;
  seal?: string;
} {
  const key = String(custom.cardType ?? '');
  return CARD_STYLES[key] ?? {};
}
