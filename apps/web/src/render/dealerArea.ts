/**
 * Pure maths for the floating "dealer row" (the revealed shared board cards).
 *
 * The renderer owns Three.js objects; everything here is a plain number so the
 * harness can assert the orientation and bob contract without a browser. The
 * draw pile is deliberately not part of this module: a deck is fixed table
 * furniture and must not turn, float or stand up.
 */

/** Peak vertical bob of a card in the dealer row, in world units. */
export const DEALER_BOB_AMPLITUDE = 0.02;
/** One full bob cycle, in milliseconds. */
export const DEALER_BOB_PERIOD_MS = 4000;
/** Whole-group lift while hovering or while a card is being dealt. */
export const DEALER_LIFT = 0.05;

/**
 * Yaw that makes a card row's top edge point away from the camera.
 *
 * The camera sits at `(cameraX, cameraZ)` in table space. Rotating the dealer
 * group around the table centre by this yaw keeps its reading direction aligned
 * with the camera, whichever seat (or free orbit) is looking at it.
 */
export function dealerAreaYaw(cameraX: number, cameraZ: number): number {
  const x = Number.isFinite(cameraX) ? cameraX : 0;
  const z = Number.isFinite(cameraZ) ? cameraZ : 0;
  return Math.atan2(x, z);
}

/** Shortest signed rotation from `from` to `to`, in radians. */
export function shortestAngleDelta(from: number, to: number): number {
  const a = Number.isFinite(from) ? from : 0;
  const b = Number.isFinite(to) ? to : 0;
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}

/** Sine bob in world units. `phase` is in radians. */
export function dealerBobOffset(nowMs: number, phase = 0): number {
  const t = Number.isFinite(nowMs) ? nowMs : 0;
  const p = Number.isFinite(phase) ? phase : 0;
  return Math.sin((t / DEALER_BOB_PERIOD_MS) * Math.PI * 2 + p) * DEALER_BOB_AMPLITUDE;
}
