import type { ActionTone, UiAction, UiActionField, UiActionSelection } from '@rds/app/contracts';

/**
 * Presentation-side derivation of a UI *action* into a *card*.
 *
 * The HUD used to feed `snapshot.actions` into three separate surfaces (the side
 * hand plaque, the dock's held stage and the dock's fan), each re-deciding for
 * itself how an action should be executed. This module is the single place that
 * answers "what kind of card is this, and how does it run?", so the upcoming
 * unified hand can render and route from one model instead of three.
 *
 * Everything here is **pure and dependency-free**: no DOM, no presenter, no
 * game-specific branching. The derivation only reads the declarative fields on
 * `UiAction` (`selection` / `fields` / `highlightIds` / `placementEntityId` /
 * `entityId`), which is exactly the capability-over-identity rule the repo
 * enforces (`AGENTS.md` §3.1) — adding a game never means touching this file.
 */

/** How a card looks. Three shapes share one gesture; only the face differs. */
export type ActionCardKind =
  /** Backed by a physical board entity — renders the real card art. */
  | 'entity'
  /** A pure command (end turn, roll, move, draw…) — icon face. */
  | 'command'
  /** Needs a numeric amount (chips / coins / tokens) — amount affordance. */
  | 'numeric';

/** How a card reaches the engine. One mode per card, checked in this order. */
export type ActionTargetMode =
  /** No input required: play it and it resolves. */
  | 'none'
  /** Executes, but first highlights board targets (legacy `highlightIds`). */
  | 'highlight'
  /** Player must pick target(s) — radial picker / second-level menu. */
  | 'selection'
  /** Arms board placement: pick a highlighted slot node afterwards. */
  | 'placement'
  /** Player must fill a payload form (amounts, enums, …). */
  | 'fields';

/**
 * The single derived model consumed by the unified hand.
 *
 * It is intentionally a *superset* of the fields the current HUD needs, so a
 * behaviour-preserving migration (P1) can read from it without changing any
 * execution path, while later phases render directly from it.
 */
export interface ActionCard {
  id: string;
  actionType?: string;
  kind: ActionCardKind;
  targetMode: ActionTargetMode;
  icon: string;
  label: string;
  hint: string;
  tone: ActionTone;
  cooldownMs?: number;
  entityId?: string;
  highlightIds?: string[];
  placementEntityId?: string;
  selection?: UiActionSelection;
  fields?: UiActionField[];
}

/** Where an execution should be routed once a card is played. */
export type ExecutionRoute =
  /** Open the payload / target form first. */
  | 'payload'
  /** Arm placement mode and wait for a slot click. */
  | 'placement'
  /** Fire the action straight away (optionally highlighting board targets). */
  | 'execute';

/** A field that asks for an amount, rather than a discrete choice. */
function isAmountField(field: UiActionField): boolean {
  return field.widget === 'slider' || field.kind === 'number';
}

/**
 * Derive a card from one action.
 *
 * `targetMode` precedence mirrors the legacy `runAction` branch order exactly
 * (see `apps/web/src/ui/hud.ts`), so refactoring those onto this model cannot
 * change behaviour:
 *   - a target selection or a payload form routes to the payload sheet first
 *     (the legacy code checked `fields || selection` before placement),
 *   - then board placement (its own board mode),
 *   - then a board-highlight action (still non-trivial: opens the detail),
 *   - otherwise it is directly executable.
 */
export function deriveActionCard(action: UiAction): ActionCard {
  const targetMode: ActionTargetMode = action.selection
    ? 'selection'
    : action.fields?.length
      ? 'fields'
      : action.placementEntityId
        ? 'placement'
        : action.highlightIds?.length
          ? 'highlight'
          : 'none';

  const kind: ActionCardKind = action.entityId
    ? 'entity'
    : action.fields?.some(isAmountField)
      ? 'numeric'
      : 'command';

  return {
    id: action.id,
    actionType: action.actionType,
    kind,
    targetMode,
    icon: action.icon,
    label: action.label,
    hint: action.hint,
    tone: action.tone,
    cooldownMs: action.cooldownMs,
    entityId: action.entityId,
    highlightIds: action.highlightIds,
    placementEntityId: action.placementEntityId,
    selection: action.selection,
    fields: action.fields,
  };
}

/** Derive the whole hand in one pass, preserving input order (the hand order). */
export function deriveActionCards(actions: readonly UiAction[]): ActionCard[] {
  return actions.map(deriveActionCard);
}

/**
 * Route a derived card to the execution channel.
 *
 * Kept separate from {@link deriveActionCard} so the routing rule can be tested
 * and later swapped (e.g. when selection grows a radial picker) without
 * re-deriving the card.
 */
export function executionRoute(card: ActionCard): ExecutionRoute {
  switch (card.targetMode) {
    case 'selection':
    case 'fields':
      return 'payload';
    case 'placement':
      return 'placement';
    default:
      // 'none' and 'highlight' both fire immediately; 'highlight' just adds a
      // board glow beforehand.
      return 'execute';
  }
}

/** An action is "simple" when it can be played with no further input. */
export function isSimpleCard(card: ActionCard): boolean {
  return card.targetMode === 'none';
}

/** Convenience for callers that still hold a raw action. */
export function isSimpleAction(action: UiAction): boolean {
  return isSimpleCard(deriveActionCard(action));
}
