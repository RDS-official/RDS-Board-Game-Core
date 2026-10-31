/**
 * Shared board-entity inspection (the "you clicked a card" notice).
 *
 * UniversalSession (单机) and NetSession (联机) each carried their own copy of this
 * logic; they drifted, and the networked copy lost the facts/artwork while keeping
 * a second card sheet, so the same card behaved differently depending on how the
 * table was joined. One implementation now serves both.
 *
 * Nothing here may know a game id: card vocabulary and the hover-preview policy
 * come from GameModule.presentation hints declared by the game itself.
 */
import type { GameModule } from '@rds/kernel/module';
import type { Entity } from '@rds/kernel/types';
import type { GameSnapshot, UiCardDetail, UiNotice } from './contracts';

/** A projected entity as the view layer receives it (kernel ProjectedGameState). */
export type InspectableEntity = Partial<Entity> & { isMasked?: boolean };

export interface EntityInspectContext {
  /** Current snapshot: the card sheet offers shortcuts to the entity's actions. */
  snapshot: Pick<GameSnapshot, 'actions'>;
  module: GameModule;
}

/**
 * Build the inspection notice for a clicked entity, or null when it has no card
 * face (the caller then falls through to its other pick handling).
 *
 * The toast always describes the card. The framed sheet is skipped when the card
 * is still face-down (nothing to reveal) or when the game already previews faces
 * on hover — two previews for one card read as two different cards.
 */
export function buildEntityInspectNotice(
  entity: InspectableEntity | undefined,
  context: EntityInspectContext
): UiNotice | null {
  const face = entity?.components?.cardFace;
  if (!entity || !face) return null;

  const custom = (entity.components?.custom ?? {}) as Record<string, unknown>;
  const hints = context.module.presentation ?? {};
  const masked = entity.isMasked === true;
  const sheet: UiCardDetail | undefined =
    masked || hints.cardPreviewOnHover
      ? undefined
      : {
          title: face.title,
          en: String(custom.en ?? ''),
          kind: String(face.type ?? custom.cardType ?? 'ITEM'),
          desc: String(face.desc ?? ''),
          color: String(face.color ?? ''),
          // Imported decks carry their own face; the sheet shows it rather than
          // inventing a plate drawing for it.
          art: typeof face.imageUrl === 'string' && face.imageUrl ? face.imageUrl : undefined,
          facts: hints.cardFacts?.(custom) ?? [],
          actions: context.snapshot.actions
            .filter(action => action.entityId === entity.id || action.placementEntityId === entity.id)
            .map(action => ({ id: action.id, icon: action.icon, label: action.label }))
            .slice(0, 6)
        };

  return {
    kind: 'event',
    icon: masked ? '🂠' : '🃏',
    title: masked ? '未揭示的卡牌' : face.title,
    detail: masked ? '需要先揭示这张牌。' : face.desc,
    durationMs: 6500,
    card: sheet
  };
}
