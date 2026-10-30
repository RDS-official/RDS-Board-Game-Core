/**
 * Presentation-only layout policy.
 *
 * Core modules must not carry camera/UI hints. This file is the app-layer
 * mapping from a game id to its preferred framing; the renderer receives a
 * structural LayoutHints object and never branches on the game id.
 */

export interface LayoutHints {
  /** Extra world-space padding around the graph bounds. */
  padding?: number;
  /** Preferred initial camera direction (normalized by the renderer). */
  cameraDirection?: [number, number, number];
  minDistance?: number;
}

const PRESENTATION: Record<string, LayoutHints> = {
  catan: { padding: 5, cameraDirection: [0.06, 0.72, 0.92], minDistance: 22 },
  sanguosha: { padding: 4, cameraDirection: [0.06, 0.7, 0.9], minDistance: 17 },
  splendor: { padding: 4, cameraDirection: [0.05, 0.7, 0.9], minDistance: 15 },
  betrayal: { padding: 4, cameraDirection: [0.03, 0.68, 0.9], minDistance: 18 },
  dune_mahjong: { padding: 4, cameraDirection: [0.05, 0.7, 0.9], minDistance: 15 },
  // A poker table reads best from a high seat: the board, the pot and every
  // stack label have to be legible at once.
  poker: { padding: 6, cameraDirection: [0.02, 0.86, 0.5], minDistance: 16 }
};

export function layoutForGame(gameId: string): LayoutHints {
  return PRESENTATION[gameId] ?? { padding: 4 };
}
