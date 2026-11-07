import { escapeHtml } from '../htmlEscape.ts';
import type { ActionCard } from './actionCards';
import type { ActionHandCardView, ActionHandView } from './actionHand';

/**
 * DOM markup for the unified action hand (docs/INTERACTION-REDESIGN.md §3.3).
 *
 * A pure string builder: it takes the {@link ActionHandView} the layout module
 * already computed and emits the fanned card buttons. Keeping it DOM-free means
 * the markup can be asserted in a browserless probe (`probe-action-hand-html`),
 * and the HUD only has to `setHtml()` it.
 *
 * Every interpolated value goes through the shared `escapeHtml`; numeric style
 * values are formatted, never interpolated raw from user data.
 */

function num(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '0';
  return Number(value.toFixed(digits)).toString();
}

/**
 * Presenter icons are either a glyph (emoji/text) or a complete inline `<svg>`
 * (poker's action icons are SVG). Only a well-formed `<svg>…</svg>` is inserted
 * as markup; every other string is escaped, so a stray attribute fragment can
 * never become a tag.
 */
export function iconHtml(icon: string): string {
  const trimmed = icon.trim();
  if (/^<svg[\s>][\s\S]*<\/svg>$/i.test(trimmed)) return trimmed;
  return escapeHtml(icon);
}

/** One card's face. `kind` picks the visual family; `badge` flags its intake. */
export function actionCardFaceHtml(card: ActionCard, view: ActionHandCardView, art?: string): string {
  const label = escapeHtml(card.label);
  const hint = card.hint ? escapeHtml(card.hint) : '';
  const aria = hint ? `${label} · ${hint}` : label;
  const badge = view.badge
    ? `<span class="ah-badge" aria-hidden="true">${escapeHtml(view.badge)}</span>`
    : '';
  const cool =
    card.cooldownMs && card.cooldownMs > 0
      ? `<span class="ah-cool">${Math.ceil(card.cooldownMs / 1000)}s</span>`
      : '';
  const style =
    `--x:${num(view.x)}px;--s:${num(view.scale, 3)};--r:${num(view.angle, 2)}deg;` +
    `--z:${num(view.z, 0)};--lift:${num(view.lift, 3)}`;
  const face = art
    ? `<img class="ah-art" src="${escapeHtml(art)}" alt="" draggable="false" />` +
      `<span class="ah-action-label">${label}</span>`
    : `<span class="ah-ico" aria-hidden="true">${iconHtml(card.icon)}</span>` +
      `<span class="ah-label">${label}</span>`;

  return (
    `<button class="ah-card${art ? ' ah-with-art' : ''}" type="button" data-action-id="${escapeHtml(card.id)}"` +
    ` data-index="${view.index}" data-kind="${escapeHtml(card.kind)}"` +
    ` data-target-mode="${escapeHtml(card.targetMode)}"` +
    ` style="${style}" aria-label="${aria}" title="${aria}">` +
    `<span class="ah-face ah-${escapeHtml(card.kind)}">` +
    face +
    badge +
    cool +
    `</span>` +
    `</button>`
  );
}

/**
 * The whole hand. Returns an empty string for an empty hand so callers can hide
 * the container instead of painting an empty shell.
 */
export function actionHandHtml(
  view: ActionHandView,
  artForCard?: (card: ActionCard) => string | undefined
): string {
  if (view.count === 0) return '';
  return view.cards.map((card) => actionCardFaceHtml(card.card, card, artForCard?.(card.card))).join('');
}
