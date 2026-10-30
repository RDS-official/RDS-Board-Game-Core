import type { Entity, GameState } from '@rds/kernel/types';

/**
 * 52-card deck vocabulary for the Texas Hold'em fixture.
 *
 * A card is identified by `card_<suit><rank>` (e.g. `card_s14` = A♠), so the
 * entity id itself is the card — no lookup table has to be kept in the state,
 * and a log replayed months later still decodes to the same card.
 */

/** Suits in deck order. `s` ♠ / `h` ♥ / `d` ♦ / `c` ♣. */
export type Suit = 's' | 'h' | 'd' | 'c';

export const SUITS: readonly Suit[] = ['s', 'h', 'd', 'c'];

export const SUIT_SYMBOL: Record<Suit, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };

export const SUIT_COLOR: Record<Suit, string> = {
  s: '#212121',
  h: '#d32f2f',
  d: '#d32f2f',
  c: '#212121'
};

/** Ranks 2..14; 14 is the ace, which may also act as 1 inside A-2-3-4-5. */
export const RANKS: readonly number[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

export interface Card {
  id: string;
  suit: Suit;
  rank: number;
}

const RANK_LABELS: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

export function rankLabel(rank: number): string {
  return RANK_LABELS[rank] ?? String(rank);
}

export function cardId(suit: Suit, rank: number): string {
  return `card_${suit}${rank}`;
}

/** Human-readable face, e.g. `A♠`. */
export function cardText(card: Card): string {
  return `${rankLabel(card.rank)}${SUIT_SYMBOL[card.suit]}`;
}

/** All 52 cards in a fixed order; the shuffle decides the actual deal. */
export function fullDeck(): Card[] {
  const cards: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      cards.push({ id: cardId(suit, rank), suit, rank });
    }
  }
  return cards;
}

/** Card entity for a fresh deck; `visibility` is always HIDDEN while in the pile. */
export function deckEntity(card: Card, zoneId: string): Entity {
  return {
    id: card.id,
    type: 'CARD',
    zoneId,
    visibility: { type: 'HIDDEN' },
    components: {
      cardFace: {
        title: cardText(card),
        suit: SUIT_SYMBOL[card.suit],
        rank: card.rank,
        color: SUIT_COLOR[card.suit]
      },
      custom: { rank: card.rank, suit: card.suit, code: `${rankLabel(card.rank)}${card.suit}` }
    }
  };
}

/** Decode a card from its entity; `null` when the entity is not a playing card. */
export function cardOfEntity(entity: Entity | undefined): Card | null {
  if (entity?.type !== 'CARD') return null;
  const custom = entity.components.custom as { rank?: unknown; suit?: unknown } | undefined;
  const rank = Number(custom?.rank);
  const suit = String(custom?.suit ?? '');
  if (!Number.isInteger(rank) || !SUITS.includes(suit as Suit)) return null;
  return { id: entity.id, suit: suit as Suit, rank };
}

/** Decode a card from an entity id alone (log-friendly). */
export function cardOfId(id: string): Card | null {
  const match = /^card_([shdc])(\d{1,2})$/.exec(id);
  if (!match) return null;
  const suit = match[1] as Suit;
  const rank = Number(match[2]);
  if (!RANKS.includes(rank)) return null;
  return { id, suit, rank };
}

/** Cards currently sitting in a zone, in zone order. */
export function cardsInZone(state: GameState, zoneId: string): Card[] {
  const zone = state.zones[zoneId];
  if (!zone) return [];
  return zone.orderedEntities
    .map(id => cardOfEntity(state.entities[id]))
    .filter((card): card is Card => card !== null);
}

/** Cards owned by one seat (hole cards). */
export function holeCards(state: GameState, playerId: string): Card[] {
  return cardsInZone(state, `zone_hand_${playerId}`);
}
