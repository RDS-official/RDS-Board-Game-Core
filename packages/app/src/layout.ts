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
  /**
   * 能力声明：桌上的公开牌行（公共牌、演示摆牌）要随观察者转向。
   *
   * 缺省 false，所有把「摊平的双方块牌」当棋盘用的夹具行为完全不变。声明为
   * true 的游戏，牌行会沿**观察者座位的切线**排布，牌面顶端朝离开该座位的方向
   * —— 于是座位机位不用转镜头也能读牌。
   *
   * 这是能力而不是身份：渲染层从不问「这是哪款游戏」，只问「这行牌该不该跟着
   * 观察者」。座位从哪来由渲染层自己解（SEAT 节点），所以没有座位的游戏即使
   * 声明也不会出错。
   */
  boardFacesViewer?: boolean;
}

const PRESENTATION: Record<string, LayoutHints> = {
  catan: { padding: 5, cameraDirection: [0.06, 0.72, 0.92], minDistance: 22 },
  sanguosha: { padding: 4, cameraDirection: [0.06, 0.7, 0.9], minDistance: 17 },
  splendor: { padding: 4, cameraDirection: [0.05, 0.7, 0.9], minDistance: 15 },
  betrayal: { padding: 4, cameraDirection: [0.03, 0.68, 0.9], minDistance: 18 },
  dune_mahjong: { padding: 4, cameraDirection: [0.05, 0.7, 0.9], minDistance: 15 },
  // 牌桌从自己的座位看：公共牌要正对我，所以这一桌声明「牌行随观察者转向」。
  // 声明写在能力位上，渲染层因此不认识扑克；上帝视角不绑定座位，牌行保持原来的
  // 固定朝向，调试与截图脚本看到的仍是旧画面。
  poker: {
    padding: 6,
    cameraDirection: [0.02, 0.86, 0.5],
    minDistance: 16,
    boardFacesViewer: true
  }
};

export function layoutForGame(gameId: string): LayoutHints {
  return PRESENTATION[gameId] ?? { padding: 4 };
}
