import type { RadialCandidate, RadialWheel } from './radialPicker.ts';
import { hitTestWheel } from './radialPicker.ts';

/**
 * Interaction controller for the radial target picker (docs/INTERACTION-REDESIGN.md §4, §8).
 *
 * Pure state machine: it owns *which* segment/centre is focused and turns a
 * pointer position or a key press into a {@link PickerIntent}. The DOM layer
 * (later) only wires real events to these functions and paints the returned
 * state — so the whole decision path is unit-testable without a browser, and the
 * geometric hit-test (also pure) stays the single source of truth.
 *
 * Keyboard focus order is `segments 0…n-1, then the centre`. This gives the
 * centre circle a first-class keyboard/reader equivalent instead of it being a
 * pointer-only area.
 */

export type PickerFocus = { kind: 'none' } | { kind: 'segment'; index: number } | { kind: 'center' };

export interface PickerState {
  wheel: RadialWheel;
  focus: PickerFocus;
}

export type PickerIntent =
  | { type: 'pick'; index: number; candidate: RadialCandidate }
  | { type: 'center' }
  | { type: 'cancel' };

export function createPickerState(wheel: RadialWheel): PickerState {
  return { wheel, focus: { kind: 'none' } };
}

/** Update focus from a pointer offset (relative to the wheel centre). */
export function pointAt(state: PickerState, dx: number, dy: number): PickerState {
  const hit = hitTestWheel(state.wheel, dx, dy);
  if (hit.zone === 'center') return { ...state, focus: { kind: 'center' } };
  if (hit.zone === 'segment') return { ...state, focus: { kind: 'segment', index: hit.index } };
  return { ...state, focus: { kind: 'none' } };
}

/** Ring of selectable slots: every segment, then the centre. */
function ringSize(wheel: RadialWheel): number {
  return wheel.count + 1;
}

function slotToFocus(slot: number, wheel: RadialWheel): PickerFocus {
  return slot >= wheel.count ? { kind: 'center' } : { kind: 'segment', index: slot };
}

function focusToSlot(focus: PickerFocus): number | null {
  if (focus.kind === 'segment') return focus.index;
  if (focus.kind === 'center') return Number.POSITIVE_INFINITY; // resolved by caller with wheel
  return null;
}

/**
 * Move keyboard focus. `dir` is +1 (next) or −1 (previous) and wraps. With no
 * current focus, `+1` starts at the first segment and `−1` starts at the centre
 * (the last slot), which matches how a fresh Tab into a menu usually behaves.
 */
export function moveFocus(state: PickerState, dir: 1 | -1): PickerState {
  const { wheel } = state;
  if (wheel.count === 0) return state;
  const size = ringSize(wheel);
  let slot: number;
  if (state.focus.kind === 'none') {
    slot = dir > 0 ? 0 : size - 1;
  } else {
    const current = state.focus.kind === 'center' ? wheel.count : state.focus.index;
    slot = (((current + dir) % size) + size) % size;
  }
  return { ...state, focus: slotToFocus(slot, wheel) };
}

/** Convenience: focus a specific segment (used when a pointer hovers an option). */
export function focusSegment(state: PickerState, index: number): PickerState {
  if (index < 0 || index >= state.wheel.count) return state;
  return { ...state, focus: { kind: 'segment', index } };
}

export function focusCenter(state: PickerState): PickerState {
  return { ...state, focus: { kind: 'center' } };
}

/**
 * Turn the current focus into an intent. Returns `null` when nothing is focused
 * (an Enter with no selection should do nothing, not cancel the picker).
 */
export function confirmFocus(state: PickerState): PickerIntent | null {
  const { wheel, focus } = state;
  if (focus.kind === 'segment') {
    const candidate = wheel.segments[focus.index]?.candidate;
    if (!candidate) return null;
    return { type: 'pick', index: focus.index, candidate };
  }
  if (focus.kind === 'center') return { type: 'center' };
  return null;
}

/** Escape / backdrop → cancel. */
export function cancelPicker(): PickerIntent {
  return { type: 'cancel' };
}

/** Index of the focused segment for `aria-activedescendant`, or null. */
export function activeSegmentIndex(state: PickerState): number | null {
  return state.focus.kind === 'segment' ? state.focus.index : null;
}

/** Stable option id for the accessible list (index → id, centre → `-center`). */
export function optionId(state: PickerState, prefix = 'rp'): string | null {
  const slot = focusToSlot(state.focus);
  if (slot === null) return null;
  return slot === Number.POSITIVE_INFINITY ? `${prefix}-opt-center` : `${prefix}-opt-${slot}`;
}
