/**
 * Shared board-entity inspection (the "you clicked a card" notice).
 *
 * UniversalSession (单机) and NetSession (联机) each carried their own copy of this
 * logic; they drifted, and the networked copy lost the facts/artwork while keeping
 * a second card sheet, so the same card behaved differently depending on how the
 * table was joined. One implementation now serves both.
 *
 * Nothing here may know a game id: card vocabulary, category band and the
 * hover-preview policy come from GameModule.presentation hints declared by the
 * game itself. The same rule governs map nodes: the discovery sheet for a newly
 * explored room is built from the describeNode hints, never from the HUD. Full-screen
 * beats (a haunt starting) follow the same rule through describeMoment.
 */
import type { GameModule, MomentPresentationState } from '@rds/kernel/module';
import type { Entity, MapGraphNode } from '@rds/kernel/types';
import { actorDetailKey, entityDetailKey, nodeDetailKey } from './contracts';
import type { GameSnapshot, UiDetailView, UiDiscoveryView, UiMoment, UiNotice, ViewerId } from './contracts';

/** A projected entity as the view layer receives it (kernel ProjectedGameState). */
export type InspectableEntity = Partial<Entity> & { isMasked?: boolean };

export interface EntityInspectContext {
  /** Current snapshot: the detail view offers shortcuts to the entity's actions. */
  snapshot: Pick<GameSnapshot, 'actions'>;
  module: GameModule;
}

/**
 * Build the neutral detail view for a seat, or null when the snapshot has no
 * such player.
 *
 * The board draws a plaque per seat; hovering it opens this enlarged view. It
 * only ever reads `UiPlayer`, so it works for any game with seats and never
 * needs to know which one it is looking at.
 */
export function buildActorDetailView(
  snapshot: Pick<GameSnapshot, 'players'>,
  playerId: string
): UiDetailView | null {
  const player = snapshot.players.find(entry => entry.id === playerId);
  if (!player) return null;
  return {
    key: actorDetailKey(player.id),
    title: player.name,
    subtitle: player.roleLabel,
    badge: `${player.scoreLabel} ${player.score}`,
    tone: 'treasure',
    seal: player.avatar,
    sections: [
      ...player.stats.map(stat => ({ label: stat.label, value: stat.value })),
      ...player.pips.map(pip => ({
        label: pip.label,
        value: `${pip.value}${pip.modifier ? ` (${pip.modifier > 0 ? '+' : ''}${pip.modifier})` : ''}`
      }))
    ],
    actions: []
  };
}

/**
 * Build the neutral detail view for an entity, or null when it has no card face.
 *
 * Everything game-specific arrives through `GameModule.presentation`: the fact
 * rows, the localised category band and the visual tone. The view layer never
 * maps a card onto its own taxonomy.
 */
export function buildEntityDetailView(
  entity: InspectableEntity | undefined,
  context: EntityInspectContext
): UiDetailView | null {
  const face = entity?.components?.cardFace;
  if (!entity || !face) return null;

  const custom = (entity.components?.custom ?? {}) as Record<string, unknown>;
  const hints = context.module.presentation ?? {};
  const style = hints.cardStyle?.(custom) ?? {};
  return {
    key: entityDetailKey(String(entity.id)),
    title: face.title,
    subtitle: String(custom.en ?? ''),
    badge: style.badge ?? (face.type ? String(face.type) : undefined),
    tone: style.tone,
    seal: style.seal,
    desc: String(face.desc ?? ''),
    // Imported decks carry their own face; the sheet shows it rather than
    // inventing a plate drawing for it.
    art: typeof face.imageUrl === 'string' && face.imageUrl ? face.imageUrl : undefined,
    sections: hints.cardFacts?.(custom) ?? [],
    actions: context.snapshot.actions
      .filter(action => action.entityId === entity.id || action.placementEntityId === entity.id)
      .map(action => ({ id: action.id, icon: action.icon, label: action.label }))
      .slice(0, 6)
  };
}

/**
 * Build the inspection notice for a clicked entity, or null when it has no card
 * face (the caller then falls through to its other pick handling).
 *
 * The toast always describes the card. The overlay is skipped when the card is
 * still face-down (nothing to reveal) or when the game already previews faces on
 * hover — two previews for one card read as two different cards.
 */
export function buildEntityInspectNotice(
  entity: InspectableEntity | undefined,
  context: EntityInspectContext
): UiNotice | null {
  const face = entity?.components?.cardFace;
  if (!entity || !face) return null;

  const masked = entity.isMasked === true;
  const hints = context.module.presentation ?? {};
  const view = masked || hints.cardPreviewOnHover ? undefined : buildEntityDetailView(entity, context) ?? undefined;

  return {
    kind: 'event',
    icon: masked ? '🂠' : '🃏',
    title: masked ? '未揭示的卡牌' : face.title,
    detail: masked ? '需要先揭示这张牌。' : face.desc,
    durationMs: 6500,
    view
  };
}

export interface NodeInspectContext {
  module: GameModule;
}

/**
 * Build the neutral discovery view for a map node, or null when the game has
 * nothing to say about it.
 *
 * Rooms, stations and track spaces all arrive here; what they are called, which
 * rows describe them and how loudly to announce them is declared by the game via
 * presentation.describeNode. A game without those hints never gets a cutscene,
 * rather than getting one in another game vocabulary.
 */
export function buildNodeDiscoveryView(
  node: MapGraphNode | undefined,
  context: NodeInspectContext
): UiDiscoveryView | null {
  if (!node) return null;
  const hints = context.module.presentation?.describeNode?.(node);
  if (!hints) return null;
  return {
    view: {
      key: nodeDetailKey(String(node.id)),
      title: hints.title,
      subtitle: hints.subtitle,
      badge: hints.badge,
      tone: hints.tone,
      seal: hints.seal,
      desc: hints.desc,
      sections: hints.sections ?? [],
      actions: []
    },
    footer: hints.footer,
    reveal: hints.reveal
  };
}

export interface MomentInspectContext {
  module: GameModule;
  /**
   * The viewer the moment is built for. `undefined` means nobody in particular
   * (the full-information seat), which is also what older call sites want.
   */
  viewer?: ViewerId;
  /**
   * What the viewer may currently see in one player's hand, already localised.
   *
   * A settlement has to show every seat's cards, and only the projection knows
   * whether a given hand is still face down. Handing the resolved faces in keeps
   * that decision out of the game declaration: a card the viewer may not read
   * simply never appears here, so a moment cannot leak it.
   */
  handOf?: (playerId: string) => { cards: string[]; hidden: number };
}

/** The board slice a moment may read (a projected state satisfies it). */
export interface MomentBoard {
  globalVars?: Record<string, unknown>;
  players?: Record<string, { name?: string; role?: string; alive?: boolean; score?: number } | undefined>;
  playerOrder?: string[];
}

/**
 * The slice of a projection a presentation declaration may read.
 *
 * Curtains and "which seat am I" declarations read the same facts, so both go
 * through this one trim: a declaration can never walk the whole state, and a new
 * declaration cannot quietly widen what the view layer hands out.
 */
export function momentSlice(
  board: MomentBoard,
  mission: string | undefined,
  viewer: ViewerId | undefined,
  handOf?: (playerId: string) => { cards: string[]; hidden: number }
): MomentPresentationState {
  const players: Record<string, { name: string; role?: string; alive?: boolean }> = {};
  for (const [id, player] of Object.entries(board.players ?? {})) {
    if (!player) continue;
    players[id] = { name: player.name ?? id, role: player.role, alive: player.alive };
  }
  // Table order, including the seats no longer in the hand: a settlement lists
  // the whole table, and the declaration should not have to guess the order.
  const order = board.playerOrder?.length ? [...board.playerOrder] : Object.keys(board.players ?? {});
  const seats = order.flatMap(playerId => {
    const player = board.players?.[playerId];
    if (!player) return [];
    const hand = handOf?.(playerId);
    return [
      {
        playerId,
        name: player.name ?? playerId,
        score: Number(player.score ?? 0),
        cards: hand?.cards,
        hidden: hand?.hidden
      }
    ];
  });
  return { globalVars: board.globalVars ?? {}, mission, viewer, seats, players };
}

/**
 * The seat the local player should watch the table from, if the game declares one.
 *
 * A single-player table opens on the full-information seat so a designer can see
 * everything; a playable game, though, has exactly one protagonist. The game says
 * who that is (`presentation.defaultViewer`), the presenter applies it once at
 * boot, and the viewer switch stays available — so this is a starting point, not a
 * lock. An id that is not on the table is ignored rather than silently binding a
 * spectator camera to a seat that no longer exists.
 */
export function resolveDefaultViewer(
  module: GameModule,
  board: MomentBoard,
  mission: string | undefined
): ViewerId | null {
  const declare = module.presentation?.defaultViewer;
  if (!declare) return null;
  const seat = declare(momentSlice(board, mission, undefined));
  if (!seat) return null;
  return board.players?.[seat] ? seat : null;
}

/**
 * Build the neutral curtain for a game-declared beat, or null.
 *
 * The HUD keeps the “already played” bookmark by `key` and paints the returned
 * lines; nothing here knows what a haunt is. The projection is trimmed to the
 * slice the declaration may read, so a moment rule cannot walk the whole state.
 */
export function buildMoment(
  board: MomentBoard,
  mission: string | undefined,
  context: MomentInspectContext
): UiMoment | null {
  const describe = context.module.presentation?.describeMoment;
  if (!describe) return null;
  const viewer = context.viewer;
  const moment = describe(momentSlice(board, mission, viewer, context.handOf));
  if (!moment) return null;
  return {
    key: moment.key,
    kicker: moment.kicker,
    caption: moment.caption,
    title: moment.title,
    story: moment.story,
    cast: moment.cast,
    objective: moment.objective,
    ledger: moment.ledger?.map(row => ({ ...row, self: !!viewer && row.key === viewer })),
    actions: moment.actions?.map(action => ({
      id: action.id,
      label: action.label,
      tone: action.tone,
      actionTypes: action.actionTypes,
      leave: action.leave,
      // Resolution against the legal actions is the presenter's job; until then
      // the button claims nothing (a leave button never needs an action).
      enabled: !!action.leave,
      hint: action.unavailableHint
    })),
    durationMs: moment.durationMs,
    hold: moment.hold
  };
}
