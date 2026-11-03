/**
 * How far in front of a seat its hand row sits, given what the HUD covers.
 *
 * ---------------------------------------------------------------------------
 * The problem
 * ---------------------------------------------------------------------------
 * A player's own cards are drawn on the felt in front of their seat. That row
 * used to sit at a fixed 2.0 world units out from the seat centre — a number
 * chosen when the action dock was a centred strip along the bottom. The dock
 * now owns the left third of the viewport on desktop (1/7 … 4/7) and turns into
 * a full-width bottom drawer below 1200px, and the hand row projects right into
 * it: measured on six viewports, the cards were 65–100% covered — the pips sat
 * underneath the dock's own buttons.
 *
 * Pulling the row toward the table centre fixes most viewports, but the depth
 * that is needed is *not* a constant: it ranges from ~0.6 to ~1.65 world units
 * across 1280×960 … 1920×1080, because a wider window flattens the camera's
 * angle to the felt. A single new magic number would just move the overlap to
 * some other window size.
 *
 * So the row's depth is solved per frame instead: step outward from the seat
 * centre and keep the first depth whose projected cards clear every panel the
 * HUD has reserved. Screen-space input, world-space output — pure, so the
 * harness can assert the search without a browser.
 *
 * The search is deliberately *outward only*: moving the row toward the table
 * beyond what the table itself allows would put the cards under the community
 * board or the pot. When even the innermost step overlaps, the row stays as
 * close to the seat as the constraint allows and the caller keeps it visible by
 * other means — never by hiding the informaton.
 */

/** A screen-space rectangle in CSS pixels, `y` growing downward. */
export interface ScreenBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HandRowDepthInput {
  /** Depth currently in use; the search starts from here and only shrinks. */
  current: number;
  /** Closest depth the row may take before it collides with the table centre. */
  min: number;
  /** Furthest depth the row may take before it leaves the felt. */
  max: number;
  /**
   * Project one depth to the screen rectangle its cards occupy, or null when the
   * card is behind the camera. The caller owns the projection; this module only
   * compares boxes.
   */
  project: (depth: number) => ScreenBox | null;
  /** Screen areas the HUD occupies. An empty list means "nothing to avoid". */
  obstacles: ScreenBox[];
}

/** Depth step of the search, in world units. */
export const HAND_DEPTH_STEP = 0.15;

/** Fraction of a card's area that may be covered and still count as clear. */
export const HAND_OCCLUSION_TOLERANCE = 0.02;

/** Overlapping area of two boxes, in square pixels. */
export function overlapArea(a: ScreenBox, b: ScreenBox): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Largest fraction of `box` covered by any one obstacle; 0 when clear. */
export function coveredFraction(box: ScreenBox, obstacles: ScreenBox[]): number {
  const area = Math.max(1, box.width * box.height);
  let worst = 0;
  for (const obstacle of obstacles) {
    worst = Math.max(worst, overlapArea(box, obstacle) / area);
  }
  return worst;
}

/**
 * Choose the depth for one hand row.
 *
 * Walks *inward* from the preferred depth and returns the first depth at which
 * every card clears the HUD. Searching from the outside in (rather than the
 * other way round) keeps the hand as far forward — as close to the player's own
 * seat — as the HUD allows: the row only retreats towards the table centre by
 * as much as it must, instead of collapsing onto the board.
 *
 * An unobstructed row therefore keeps the depth it already had, so the fix never
 * moves a hand that was already visible. When no depth clears, the result is the
 * least-bad depth and `clear` is false, so the caller can report it instead of
 * silently pretending the hand is readable.
 */
export function solveHandRowDepth(input: HandRowDepthInput): { depth: number; clear: boolean } {
  const min = Math.max(0, input.min);
  const max = Math.max(min, input.max);
  const start = Math.min(max, Math.max(min, input.current));

  if (input.obstacles.length === 0) return { depth: start, clear: true };

  let best = { depth: start, covered: Number.POSITIVE_INFINITY };
  for (let step = 0; ; step++) {
    const depth = start - step * HAND_DEPTH_STEP;
    if (depth < min - 1e-9) break;
    const box = input.project(Math.max(min, depth));
    if (!box) continue;
    const covered = coveredFraction(box, input.obstacles);
    if (covered <= HAND_OCCLUSION_TOLERANCE) return { depth: Math.max(min, depth), clear: true };
    if (covered < best.covered) best = { depth: Math.max(min, depth), covered };
  }
  return { depth: best.depth, clear: false };
}
