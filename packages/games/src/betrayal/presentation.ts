import type {
  MomentPresentationHints,
  MomentPresentationState,
  NodePresentationHints,
  PlayerViewContext,
  PlayerViewHints,
  TraitPresentationHints
} from '@rds/kernel/module';
import type { MapGraphNode, Player, ProjectedGameState } from '@rds/kernel/types';

/** Title of the map overview panel: this game is a house on the hill. */
export const BETRAYAL_MAP_TITLE = '洋馆总览';

/** The node a player stands on; a banished explorer is off the map. */
export function betrayalPlayerNode(custom: Record<string, unknown>): string | null {
  if (custom.banished) return null;
  const roomId = custom.currentRoomId;
  return typeof roomId === 'string' && roomId ? roomId : null;
}

/** Monsters are meeple entities flagged in their custom bag. */
export function betrayalCastMember(
  custom: Record<string, unknown>
): { nodeId: string; label: string } | null {
  if (!custom.monster || custom.destroyed) return null;
  const roomId = custom.roomId;
  if (typeof roomId !== 'string' || !roomId) return null;
  return { nodeId: roomId, label: typeof custom.name === 'string' && custom.name ? custom.name : '怪物' };
}

/** Items dropped in a room zone are the room's loot. */
export function betrayalRoomLoot(
  entities: { zoneId?: string; custom?: Record<string, unknown> }[],
  roomId: string
): { label: string; count: number } | null {
  const zoneId = 'zone_room_' + roomId;
  let count = 0;
  for (const entity of entities) {
    if (entity.zoneId === zoneId && entity.custom?.cardType === 'ITEM') count += 1;
  }
  return count > 0 ? { label: '遗物', count } : null;
}

const TOKEN_BADGES: Record<string, { label: string; glyph?: string }> = {
  OMEN: { label: '预兆', glyph: '👁' },
  ITEM: { label: '遗物', glyph: '◆' },
  EVENT: { label: '事件', glyph: '✦' }
};

/** Room symbol chips, in this game's printed vocabulary. */
export function betrayalTokenBadge(token: string): { label: string; glyph?: string } | null {
  return TOKEN_BADGES[token] ?? null;
}

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

/** The four printed trait ladders. */
const TRAIT_META: Record<string, TraitPresentationHints> = {
  speed: { label: '速度', short: '速', color: '#6aa6f5', max: 8, damageKind: 'PHYSICAL' },
  might: { label: '力量', short: '力', color: '#e0604e', max: 8, damageKind: 'PHYSICAL' },
  sanity: { label: '神智', short: '智', color: '#57c08b', max: 8, damageKind: 'MENTAL' },
  knowledge: { label: '知识', short: '识', color: '#b07bf0', max: 8, damageKind: 'MENTAL' }
};

/** Display metadata for one trait ladder key, or null for a foreign key. */
export function betrayalDescribeTrait(traitKey: string): TraitPresentationHints | null {
  return TRAIT_META[traitKey] ?? null;
}

/** Current trait values for one player, read out of the `traitIndex` bag. */
export function betrayalTraits(custom: Record<string, unknown>): Record<string, number> | null {
  const index = custom.traitIndex;
  if (!index || typeof index !== 'object') return null;
  return index as Record<string, number>;
}

/** Role tokens printed on the character cards. */
export function betrayalRoleLabel(role: string): string | null {
  if (role === 'TRAITOR') return '叛徒';
  if (role === 'HERO') return '英雄';
  if (role === 'EXPLORER') return '探索者';
  return null;
}

export function betrayalPhaseLabel(state: ProjectedGameState): string {
  const haunt = state.globalVars.haunt as
    | { number?: number; title?: string; progress?: number; eyesDestroyed?: number; bonesFound?: boolean }
    | null
    | undefined;
  if (!haunt) return `EXPLORATION · 探索阶段 · 预兆 ${Number(state.globalVars.omensRevealed ?? 0)}`;
  const bits = [`HAUNT #${haunt.number} · ${haunt.title}`];
  if (haunt.title?.includes('木乃伊')) bits.push(`封印 ${haunt.progress ?? 0}/2`);
  if (haunt.title?.includes('幽灵')) bits.push(`安魂 ${haunt.progress ?? 0}/3`);
  if (haunt.title?.includes('巨眼')) bits.push(`巨眼 ${haunt.eyesDestroyed ?? 0}/2`);
  return bits.join(' · ');
}

export function betrayalMissionLine(state: ProjectedGameState): string {
  const objectives = state.globalVars.hauntObjectives as { hero?: string; traitor?: string } | undefined;
  if (!objectives) {
    return `探索阶段 · 已揭示预兆 ${Number(state.globalVars.omensRevealed ?? 0)} 张 · 抽到预兆后结束回合触发作祟检定`;
  }
  if (state.viewerId === 'GOD') {
    return `英雄：${objectives.hero ?? '—'} ｜ 叛徒：${objectives.traitor ?? '—'}`;
  }
  const role = state.players[state.viewerId]?.role;
  return role === 'TRAITOR' ? `叛徒目标：${objectives.traitor ?? '—'}` : `英雄目标：${objectives.hero ?? '—'}`;
}

export function betrayalPlayerView(
  player: Player,
  state: ProjectedGameState,
  context: PlayerViewContext
): PlayerViewHints {
  const room = state.mapGraph.nodes[String(player.customProps.currentRoomId ?? '')];
  const traits = (player.customProps.traits ?? {}) as Record<string, number>;
  const hand = state.zones[`zone_hand_${player.id}`]?.orderedEntities ?? [];
  const omens = hand.filter(id => state.entities[id]?.components?.custom?.cardType === 'OMEN').length;
  const items = hand.length - omens;
  const floorNames: Record<string, string> = { BASEMENT: '地下室', GROUND: '一楼', UPPER: '二楼' };
  const start = (player.customProps.startIndex ?? {}) as Record<string, number>;
  const ladderKeys = Object.keys(traits).length > 0 ? Object.keys(traits) : Object.keys(start);
  return {
    score: omens,
    scoreLabel: '预兆',
    stats: [
      {
        label: '所在',
        value: `${room?.props?.name ?? '未知'} · ${floorNames[String(room?.props?.floor ?? '')] ?? ''}`
      },
      { label: '物品 / 预兆', value: `${items} / ${omens}` },
      { label: '移动力', value: String(Number(player.customProps.movesLeft ?? 0)) },
      ...(player.customProps.controlled ? [{ label: '状态', value: '👁️ 被精神控制' }] : []),
      ...(player.customProps.banished ? [{ label: '状态', value: '🛸 已被母舰接引' }] : []),
      ...(player.alive ? [] : [{ label: '状态', value: '💀 已死亡' }])
    ],
    pips: ladderKeys.map(key => {
      const meta = betrayalDescribeTrait(key);
      return {
        color: meta?.color ?? '#8b93a1',
        label: `${meta?.label ?? key}（初始 ${Number(start[key] ?? traits[key] ?? 0)}）`,
        short: meta?.short,
        key,
        value: String(traits[key] ?? '-'),
        max: meta?.max ?? 8,
        start: Number(start[key] ?? 0),
        modifier: Number(context.modifiers[key] ?? 0)
      };
    })
  };
}

interface BetrayalHauntState {
  id?: string;
  number?: number;
  title?: string;
  intro?: string;
  traitorId?: string;
}

/**
 * The haunt overture.
 *
 * The rules already flip `hauntTriggered` and write the role-filtered objective
 * into the mission line; this turns that state into the curtain the table sees.
 * The projection slice carries no rules objects, so a haunt cannot leak state.
 */
export function betrayalDescribeMoment(state: MomentPresentationState): MomentPresentationHints | null {
  const haunt = state.globalVars.haunt as BetrayalHauntState | null | undefined;
  if (!state.globalVars.hauntTriggered || !haunt?.id) return null;
  const traitor = haunt.traitorId ? state.players[haunt.traitorId] : undefined;
  return {
    key: String(haunt.id),
    kicker: '作祟开始 · THE HAUNT BEGINS',
    caption: `HAUNT No.${String(haunt.number ?? '?').padStart(2, '0')}`,
    title: String(haunt.title ?? '未知作祟'),
    story: haunt.intro ? String(haunt.intro) : undefined,
    cast: [{ label: '背叛者', name: traitor?.name ?? '尚未现身' }],
    objective: state.mission,
    durationMs: 9000
  };
}
