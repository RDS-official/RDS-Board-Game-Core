import { escapeHtml } from '../htmlEscape.ts';
import type { RadialWheel } from './radialPicker';

/**
 * SVG markup for the radial target picker (docs/INTERACTION-REDESIGN.md §4.2).
 *
 * Pure string builder over the geometry from `radialPicker.ts`. Because each
 * sector path is the *same* `seg.path` the hit-test math is derived from, the
 * drawn shape and the clickable shape cannot drift apart. Escaped throughout;
 * numeric attributes are formatted, never raw.
 */

export interface RadialSvgOptions {
  /** Extra class on the root `<svg>`. */
  className?: string;
  /** Accessible name for the menu. */
  label?: string;
  /** Show candidate text labels. Defaults to true. */
  showLabels?: boolean;
  /** Centre caption. Defaults to '更多'. */
  centerLabel?: string;
}

function f(value: number): string {
  return Number.isFinite(value) ? Number(value.toFixed(2)).toString() : '0';
}

/** Render the wheel as one `<svg>`. Empty wheel → empty string. */
export function radialPickerSvg(wheel: RadialWheel, opts: RadialSvgOptions = {}): string {
  if (wheel.count === 0) return '';
  const R = f(wheel.radius);
  const cls = opts.className ? ` ${escapeHtml(opts.className)}` : '';
  const label = escapeHtml(opts.label ?? '选择目标');

  const paths = wheel.segments
    .map((seg) => {
      const style = seg.candidate.color ? ` style="--seg:${escapeHtml(seg.candidate.color)}"` : '';
      return (
        `<path class="rp-seg" data-seg-index="${seg.index}"` +
        ` data-candidate-id="${escapeHtml(seg.candidate.id)}" d="${seg.path}"${style}/>`
      );
    })
    .join('');

  const labels =
    opts.showLabels === false
      ? ''
      : wheel.segments
          .map(
            (seg) =>
              `<text class="rp-label" data-seg-index="${seg.index}" x="${f(seg.label[0])}"` +
              ` y="${f(seg.label[1])}" text-anchor="middle" dominant-baseline="middle">` +
              `${escapeHtml(seg.candidate.label)}</text>`,
          )
          .join('');

  const center =
    `<circle class="rp-center" data-zone="center" cx="0" cy="0" r="${f(wheel.innerRadius)}"/>` +
    `<text class="rp-center-label" x="0" y="0" text-anchor="middle" dominant-baseline="middle"` +
    ` aria-hidden="true">${escapeHtml(opts.centerLabel ?? '更多')}</text>`;

  return (
    `<svg class="rp-wheel${cls}" viewBox="${-wheel.radius} ${-wheel.radius} ${wheel.radius * 2} ${wheel.radius * 2}"` +
    ` role="menu" aria-label="${label}">` +
    `<g class="rp-segments">${paths}</g>` +
    center +
    `<g class="rp-labels">${labels}</g>` +
    `</svg>`
  );
}

export interface RadialListOptions {
  /** Id prefix for option ids (must match the `aria-activedescendant` used). */
  idPrefix?: string;
  /** Accessible name for the list. */
  label?: string;
  /** Centre caption (the "more" entry). */
  centerLabel?: string;
}

/**
 * Accessible linear equivalent of the wheel (docs/INTERACTION-REDESIGN.md §8).
 *
 * A pointer-geometry picker is hostile to keyboard and screen-reader users, so
 * the same candidates are exposed as a `listbox`: arrows move focus, Enter
 * commits. The DOM layer keeps this list visually hidden but present, and the
 * two stay in lock-step through the shared PickerState.
 */
export function radialPickerListHtml(
  wheel: RadialWheel,
  activeSegmentIndex: number | null,
  centerActive = false,
  opts: RadialListOptions = {},
): string {
  if (wheel.count === 0) return '';
  const prefix = opts.idPrefix ?? 'rp';
  const label = escapeHtml(opts.label ?? '选择目标');
  const centerLabel = escapeHtml(opts.centerLabel ?? '更多');

  const options = wheel.segments
    .map(
      (seg) =>
        `<li role="option" id="${prefix}-opt-${seg.index}" data-seg-index="${seg.index}"` +
        ` aria-selected="${activeSegmentIndex === seg.index}">${escapeHtml(seg.candidate.label)}</li>`,
    )
    .join('');
  const centerOption =
    `<li role="option" id="${prefix}-opt-center" data-zone="center"` +
    ` aria-selected="${centerActive}">${centerLabel}</li>`;

  return `<ul class="rp-list" role="listbox" aria-label="${label}">${options}${centerOption}</ul>`;
}
