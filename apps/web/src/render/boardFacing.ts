/**
 * Orientation of a shared card row (the poker community cards, a demo display)
 * so that whoever is looking at it reads it upright.
 *
 * A flat card row has exactly one "up" direction in world space, but a camera
 * sits at a seat and looks at the row from that seat's side. The two only agree
 * for the seat that happens to face the row's built-in north: every other seat
 * sees the pips sideways or upside down, foreshortened on top. That is the
 * "you have to orbit the camera to read the board" complaint — the fix is the
 * row's own bearing, not the camera.
 *
 * Given the viewer's seat bearing (unit vector from the table centre out to that
 * seat), lay the row along the seat's tangent and yaw every card so its top edge
 * points away from the seat:
 *
 *     yaw    = atan2(outX, outZ)      // card top → away from the viewer
 *     axis   = (outZ, -outX)          // reading order, left → right
 *     offset = (i - (n - 1) / 2) · pitch
 *
 * With `out = (0, 1)` (a seat on the +Z side) this degenerates to `yaw = 0`,
 * `axis = (1, 0)`: the legacy fixed-north layout, which is also what we keep
 * when no seat is known (omniscient camera, spectator, a game without seats).
 * So the caller pays nothing when the capability does not apply.
 *
 * Pure and unit-agnostic (world units in, world units out): the renderer maps the
 * frame onto Three.js and the harness asserts the maths without a browser.
 */

/** Unit vector from the table centre out towards the viewer's seat. */
export interface ViewerBearing {
  outX: number;
  outZ: number;
}

export interface BoardRowInput {
  /** Cards in the row (one Hold'em board is at most 5). */
  count: number;
  /** Row centre in world XZ. */
  centerX: number;
  centerZ: number;
  /** The viewer's seat bearing, or null when nobody is seated. */
  viewer?: ViewerBearing | null;
  /** Centre-to-centre spacing along the row, in world units. */
  pitch?: number;
}

export interface BoardRowFrame {
  centerX: number;
  centerZ: number;
  /** Unit tangent the row runs along; index 0 sits at `-axis`. */
  axisX: number;
  axisZ: number;
  /** Yaw for every card in the row (radians). */
  yaw: number;
  /** Centre-to-centre spacing the row was laid out with. */
  pitch: number;
  /** `true` when the row was turned to the viewer rather than left north. */
  facesViewer: boolean;
}

/** Default spacing of the board row (matches the historical fixed layout). */
export const BOARD_ROW_PITCH = 0.98;

const finite = (value: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** Lay one shared card row out for a viewer. Deterministic and side-effect free. */
export function boardRowFrame(input: BoardRowInput): BoardRowFrame {
  const pitch = Math.max(0, finite(input.pitch ?? BOARD_ROW_PITCH, BOARD_ROW_PITCH));
  const viewer = input.viewer ?? null;
  // A zero-length bearing carries no direction; treat it as "no seat".
  const seatKnown = viewer !== null && Math.abs(viewer.outX) + Math.abs(viewer.outZ) > 1e-6;
  const yaw = seatKnown ? Math.atan2(viewer.outX, viewer.outZ) : 0;
  // Card local +X is the reading direction; with `yaw` applied it maps onto the
  // seat's tangent, so index order reads left-to-right for that seat.
  return {
    centerX: finite(input.centerX, 0),
    centerZ: finite(input.centerZ, 0),
    axisX: seatKnown ? Math.cos(yaw) : 1,
    axisZ: seatKnown ? -Math.sin(yaw) : 0,
    yaw,
    pitch,
    facesViewer: seatKnown
  };
}

/** Offset of card `index` along the row tangent, for a row of `count` cards. */
export function boardRowOffset(count: number, index: number, pitch: number): number {
  return (index - (Math.max(1, Math.floor(finite(count, 1))) - 1) / 2) * pitch;
}

/** World position of one card in a laid-out row. */
export function boardCardPosition(
  frame: BoardRowFrame,
  count: number,
  index: number,
  height: number
): [number, number, number] {
  // The offset is derived from the live card count, not stored per frame, so a
  // zone showing fewer cards than it holds still extends the row in order.
  const offset = boardRowOffset(count, index, frame.pitch);
  return [frame.centerX + frame.axisX * offset, height, frame.centerZ + frame.axisZ * offset];
}
