import type { UiAction } from '@rds/app/contracts';
import { type ActionCard, deriveActionCards } from './actionCards.ts';
import { type HandLayoutCard, handLayout } from './handLayout.ts';

/**
 * View-model for the unified action hand (docs/INTERACTION-REDESIGN.md §3.3).
 *
 * This is the **layout half** of the hand skeleton: it turns a list of actions
 * into a fanned row of positioned cards, reusing the existing fisheye
 * {@link handLayout} so the hand keeps the "never overflow, never leave a hole"
 * guarantee the 3D seat row already relies on. It is pure and DOM-free, so the
 * geometry can be asserted in a browserless probe; a later phase maps these
 * numbers onto DOM transforms only.
 *
 * Nothing here decides *how* a card runs — that is `actionCards.ts`. This file
 * only answers "where does each card sit, at what tilt, with what badge".
 */

/** A short glyph on the card corner hinting what playing it needs. */
export type ActionBadge =
  /** Directly playable. */
  | ''
  /** Needs a target. */
  | '◎'
  /** Needs a form / amount. */
  | '#'
  /** Enters board placement. */
  | '⌖';

export interface ActionHandOptions {
  /** Width of the hand strip, in the same unit as `cardWidth`. */
  containerWidth: number;
  /** Width of one card at scale 1. */
  cardWidth: number;
  /** Pointer position along the row, 0 = left edge, 1 = right edge. */
  focusX?: number | null;
  /** 0 = uniform, 1 = full fisheye. */
  focusStrength?: number;
  /** Card under the pointer: gets the lift and the top layer. */
  hoverIndex?: number | null;
  /** Max fan tilt at the row ends, in degrees. Defaults to 9. */
  maxTiltDeg?: number;
  /** Keep cards full-size and let overlap absorb the count (Hearthstone feel). */
  lockCardWidth?: boolean;
}

export interface ActionHandCardView {
  card: ActionCard;
  index: number;
  /** Centre offset from the row's middle, same unit as `containerWidth`. */
  x: number;
  scale: number;
  /** Higher draws in front. */
  z: number;
  /** 0..1 lift hint. */
  lift: number;
  /** Fan tilt in degrees: negative on the left, positive on the right. */
  angle: number;
  /** Corner badge for the card's intake mode. */
  badge: ActionBadge;
}

export interface ActionHandView {
  cards: ActionHandCardView[];
  count: number;
  /** Active focus index in the row, or null when the hand is empty. */
  focusIndex: number | null;
}

/** Map a card's intake mode to the tiny corner badge. */
export function badgeFor(card: ActionCard): ActionBadge {
  switch (card.targetMode) {
    case 'selection':
      return '◎';
    case 'fields':
      return '#';
    case 'placement':
      return '⌖';
    default:
      return '';
  }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Lay out a hand from raw actions.
 *
 * `angle` is derived from each card's position relative to the row centre (not
 * the focus), so the fan always spreads symmetrically outward from the middle;
 * the fisheye only changes the *gaps*, not the tilt direction.
 */
export function layoutActionHand(actions: readonly UiAction[], opts: ActionHandOptions): ActionHandView {
  return layoutCards(deriveActionCards(actions), opts);
}

/**
 * Lay out an already-derived set of cards (used by the probe and by callers
 * that already hold `ActionCard`s).
 */
export function layoutCards(cards: readonly ActionCard[], opts: ActionHandOptions): ActionHandView {
  const count = cards.length;
  if (count === 0) {
    return { cards: [], count: 0, focusIndex: null };
  }

  const layout = handLayout({
    count,
    containerWidth: opts.containerWidth,
    cardWidth: opts.cardWidth,
    focusX: opts.focusX ?? null,
    focusStrength: opts.focusStrength ?? 1,
    hoverIndex: opts.hoverIndex ?? null,
    lockCardWidth: opts.lockCardWidth,
  });

  const maxTilt = opts.maxTiltDeg ?? 9;
  const half = opts.containerWidth / 2;

  const view: ActionHandCardView[] = layout.cards.map((placed: HandLayoutCard) => {
    const ratio = half > 0 ? clamp(placed.offset / half, -1, 1) : 0;
    return {
      card: cards[placed.index],
      index: placed.index,
      x: placed.offset,
      scale: placed.scale,
      z: placed.z,
      lift: placed.lift,
      angle: ratio * maxTilt,
      badge: badgeFor(cards[placed.index]),
    };
  });

  const focusIndex = opts.hoverIndex ?? (layout.cursorIndex === null ? null : Math.round(layout.cursorIndex));

  return { cards: view, count, focusIndex };
}
