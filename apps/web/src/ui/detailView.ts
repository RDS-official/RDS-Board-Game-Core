import type { UiDetailView } from '@rds/app/contracts';

/**
 * How the HUD paints an opaque tone token.
 *
 * A `UiDetailView` never names a game category: the game picks a tone and the
 * view layer maps it onto one of its neutral plates. Unknown or missing tones
 * fall back to a parchment plate, so a new fixture looks deliberate on day one.
 */
const TONES: Record<string, { ink: string; ribbon: string }> = {
  danger: { ink: '#f2cfd8', ribbon: '#4a1020' },
  treasure: { ink: '#f0dfc2', ribbon: '#3f2c12' },
  event: { ink: '#dbe6f2', ribbon: '#1d2733' },
  place: { ink: '#efdfc6', ribbon: '#33261a' }
};

const NEUTRAL = { ink: '#e9dcc2', ribbon: '#2a2118' };

/** Palette for one tone token; never throws on unknown input. */
export function detailTone(tone?: string): { ink: string; ribbon: string } {
  return (tone && TONES[tone]) || NEUTRAL;
}

/**
 * A hover preview: the same subject as a full detail view, with no sections.
 *
 * Callers pass the subject's overlay key so the HUD can tell that the chip and a
 * pinned sheet describe the same thing (see OverlayArbiter).
 */
export function peekView(opts: {
  key: string;
  title: string;
  desc?: string;
  art?: string;
}): UiDetailView {
  return {
    key: opts.key,
    title: opts.title,
    desc: opts.desc,
    art: opts.art,
    sections: [],
    actions: []
  };
}
