/** 视口坐标下的点与多边形工具：出牌区判定与飞场落点。 */

export interface Point {
  x: number;
  y: number;
}

/** 射线法。与渲染用的是同一份多边形，杜绝"看着在区内、判在区外"。 */
export function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

export function distanceToPolygon(point: Point, polygon: readonly Point[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    best = Math.min(best, distanceToSegment(point, polygon[j], polygon[i]));
  }
  return best;
}

/** 带外扩容差：手指比鼠标粗，边界内外 8–16px 都算命中。 */
export function pointInPolygonWithPadding(
  point: Point,
  polygon: readonly Point[],
  padding: number
): boolean {
  return pointInPolygon(point, polygon) || distanceToPolygon(point, polygon) <= padding;
}

export function polygonCentroid(polygon: readonly Point[]): Point {
  if (polygon.length === 0) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const point of polygon) {
    x += point.x;
    y += point.y;
  }
  return { x: x / polygon.length, y: y / polygon.length };
}

/** 视口矩形 → 多边形（顺时针），供"桌面区域"这类矩形出牌区使用。 */
export function rectPolygon(rect: { left: number; top: number; right: number; bottom: number }): Point[] {
  return [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom }
  ];
}
