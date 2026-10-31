import type { NodePresentationHints } from '@rds/kernel/module';
import type { MapGraphNode } from '@rds/kernel/types';

/**
 * Presentation hints for 山屋惊魂 (Betrayal at House on the Hill).
 *
 * The card vocabulary (weapon / armor / relic / ...), the derived fact rows and
 * the room dossier the HUD shows all live here, next to the rules that produce
 * the `custom` bag and the node props, instead of inside the generic inspection
 * path in packages/app — and above all, instead of inside apps/web.
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

/* -------------------------------------------------------------------------- */
/* Map nodes: the mansion rooms                                                  */
/* -------------------------------------------------------------------------- */

/** Floor id to localised label; unlisted floors read as the ground floor. */
const FLOOR_LABELS: Record<string, string> = { BASEMENT: '地下室', UPPER: '二楼', GROUND: '一楼' };

/** Tile symbol printed on a room corner; rooms without one are quiet. */
const SYMBOL_LABELS: Record<string, string> = { OMEN: '预兆 👁', ITEM: '遗物 ◆', EVENT: '事件 ✦' };

/**
 * The discovery dossier for a freshly explored room.
 *
 * Floors, door positions and tile symbols are the vocabulary of this board; the
 * HUD only knows that a new node appeared and that the game now has something to
 * say about it. Returning null keeps a node quiet — doors and navigation arrows
 * travel the same path.
 */
export function betrayalDescribeNode(node: MapGraphNode): NodePresentationHints | null {
  if (node.type !== 'ROOM') return null;
  const props = (node.props ?? {}) as Record<string, unknown>;
  if (typeof props.name !== 'string' || !props.name) return null;
  const doors = Array.isArray(props.doors) ? props.doors.map(String) : [];
  return {
    title: props.name,
    subtitle: typeof props.en === 'string' ? props.en : undefined,
    tone: 'place',
    desc: typeof props.text === 'string' ? props.text : undefined,
    sections: [
      { label: '楼层', value: FLOOR_LABELS[String(props.floor ?? '')] ?? '一楼' },
      { label: '已连通门位', value: doors.join(' · ') || '无' },
      { label: '符号', value: SYMBOL_LABELS[String(props.symbol ?? '')] ?? '无符号' }
    ],
    footer: '新房间已加入洋馆布局',
    reveal: true
  };
}
