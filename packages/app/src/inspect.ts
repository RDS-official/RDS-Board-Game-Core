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
 * game itself.
 */
import type { GameModule } from '@rds/kernel/module';
import type { Entity } from '@rds/kernel/types';
import { entityDetailKey } from './contracts';
import type { GameSnapshot, UiDetailView, UiNotice } from './contracts';

/** A projected entity as the view layer receives it (kernel ProjectedGameState). */
export type InspectableEntity = Partial<Entity> & { isMasked?: boolean };

export interface EntityInspectContext {
  /** Current snapshot: the detail view offers shortcuts to the entity's actions. */
  snapshot: Pick<GameSnapshot, 'actions'>;
  module: GameModule;
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
