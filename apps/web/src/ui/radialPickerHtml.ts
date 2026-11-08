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
  const cls = opts.className ? ` ${escapeHtml(opts.className)}` : '';
  const label = escapeHtml(opts.label ?? '选择目标');

  const paths = wheel.segments
    .map((seg) => {
      const style = seg.candidate.color ? ` style="--seg:${escapeHtml(seg.candidate.color)}"` : '';
      return (
        `<path class="rp-seg" data-seg-index="${seg.index}"` +
        ` data-candidate-id="${escapeHtml(seg.candidate.id)}" d="${seg.path}"` +
        (seg.candidate.disabled ? ' data-disabled="1"' : '') +
        `${style}/>`
      );
    })
    .join('');

  // 每个分区上的"人"：头像圆牌 + 名字 + 一行规则提示（设计 v2 §1.3）。
  // 头像/提示是**区分是谁**的主信息，颜色只做辅助（色盲安全：还有描边与字重）。
  const labels =
    opts.showLabels === false
      ? ''
      : wheel.segments
          .map((seg) => {
            const candidate = seg.candidate;
            const color = escapeHtml(candidate.color ?? '#9fb0c6');
            const x = f(seg.label[0]);
            const y = f(seg.label[1]);
            const avatarY = f(seg.label[1] - 20);
            const ring = 23;
            const initial = (candidate.label ?? '?').trim().slice(0, 1).toUpperCase();
            const face = candidate.avatar
              ? `<image class="rp-avatar" href="${escapeHtml(candidate.avatar)}" x="${f(seg.label[0] - ring)}"` +
                ` y="${f(seg.label[1] - 20 - ring)}" width="${ring * 2}" height="${ring * 2}"` +
                ` preserveAspectRatio="xMidYMid slice" clip-path="url(#rp-clip-${seg.index})"/>`
              : `<text class="rp-initial" x="${x}" y="${f(seg.label[1] - 20)}" text-anchor="middle"` +
                ` dominant-baseline="central">${escapeHtml(initial)}</text>`;
            const hint = candidate.hint
              ? `<text class="rp-hint" x="${x}" y="${f(seg.label[1] + 34)}" text-anchor="middle">${escapeHtml(candidate.hint)}</text>`
              : '';
            return (
              `<g class="rp-pin" data-seg-index="${seg.index}" data-pin-x="${x}" data-pin-y="${y}">` +
              `<circle class="rp-avatar-ring" cx="${x}" cy="${avatarY}" r="${ring}" stroke="${color}"/>` +
              face +
              `<text class="rp-label" data-seg-index="${seg.index}" x="${x}" y="${f(seg.label[1] + 16)}"` +
              ` text-anchor="middle">${escapeHtml(candidate.label)}</text>` +
              hint +
              `</g>`
            );
          })
          .join('');

  // 圆形头像是 <image> + 每段一个 clipPath（Chromium 对 CSS circle() 支持不一致，
  // 用 SVG 原生 clipPath 最稳）。
  const clips =
    opts.showLabels === false
      ? ''
      : `<defs>${wheel.segments
          .map(
            (seg) =>
              `<clipPath id="rp-clip-${seg.index}"><circle cx="${f(seg.label[0])}"` +
              ` cy="${f(seg.label[1] - 20)}" r="23"/></clipPath>`,
          )
          .join('')}</defs>`;

  // 外轮廓单独描一遍：让"整个多边形"读成一个形状，而不是散落的几个三角。
  const outline =
    wheel.outline.length > 1
      ? `<path class="rp-outline" d="${wheel.outline
          .map(([x, y], index) => `${index === 0 ? 'M' : 'L'} ${f(x)} ${f(y)}`)
          .join(' ')} Z"/>`
      : '';

  const center =
    `<circle class="rp-center" data-zone="center" cx="0" cy="0" r="${f(wheel.innerRadius)}"/>` +
    `<text class="rp-center-label" x="0" y="0" text-anchor="middle" dominant-baseline="middle"` +
    ` aria-hidden="true">${escapeHtml(opts.centerLabel ?? '更多')}</text>`;

  return (
    `<svg class="rp-wheel${cls}" viewBox="${-wheel.radius} ${-wheel.radius} ${wheel.radius * 2} ${wheel.radius * 2}"` +
    ` role="menu" aria-label="${label}">` +
    clips +
    outline +
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
