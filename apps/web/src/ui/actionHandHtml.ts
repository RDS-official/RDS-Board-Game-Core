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

/** One card's face. `kind` picks the visual family; `badge` flags its intake. */
export function actionCardFaceHtml(card: ActionCard, view: ActionHandCardView): string {
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

  return (
    `<button class="ah-card" type="button" data-action-id="${escapeHtml(card.id)}"` +
    ` data-index="${view.index}" data-kind="${escapeHtml(card.kind)}"` +
    ` data-target-mode="${escapeHtml(card.targetMode)}"` +
    ` style="${style}" aria-label="${aria}" title="${aria}">` +
    `<span class="ah-face ah-${escapeHtml(card.kind)}">` +
    `<span class="ah-ico" aria-hidden="true">${escapeHtml(card.icon)}</span>` +
    `<span class="ah-label">${label}</span>` +
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
export function actionHandHtml(view: ActionHandView): string {
  if (view.count === 0) return '';
  return view.cards.map((card) => actionCardFaceHtml(card.card, card)).join('');
}
