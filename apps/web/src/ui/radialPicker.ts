/**
 * Radial target picker geometry (docs/INTERACTION-REDESIGN.md §4).
 *
 * A drag-time chooser: the candidate targets are laid out as a jittered regular
 * polygon around a centre circle. Release over a segment → apply to that target;
 * release over the centre → open the second-level menu.
 *
 * Everything here is **pure and deterministic**: coordinates are relative to the
 * wheel centre (0,0), the vertex jitter is seeded, and the same geometry object
 * is used both to draw the SVG and to hit-test a pointer. That shared source is
 * the whole point — "看着在一个区、判在另一个区" becomes impossible.
 *
 * The caller translates these numbers to the pointer (or finger, lifted by an
 * offset) and scales them to the viewport.
 */

export interface RadialCandidate {
  id: string;
  label: string;
  /** 玩家色：只用来"区分是谁"，不参与装饰。 */
  color?: string;
  /** 头像 URL；缺省时渲染首字圆牌（同一个 color）。 */
  avatar?: string;
  /** 一行规则提示："距离 1 · 手牌 3"。由 presenter 提供，缺失就不占位。 */
  hint?: string;
  /** 预留：引擎判定为不可选的目标可以置灰（当前不产出）。 */
  disabled?: boolean;
}

export interface RadialWheelOptions {
  /** Outer radius in the unit the caller wants back (px, world units…). */
  radius: number;
  /** Centre-circle radius as a fraction of `radius`. Defaults to 0.34. */
  innerRatio?: number;
  /** Per-vertex radial jitter, fraction of `radius`. Defaults to 0.12. */
  jitterRadius?: number;
  /** Per-vertex angular jitter, fraction of one segment. Defaults to 0.18. */
  jitterAngle?: number;
  /** Where the first vertex sits, radians. Defaults to −π/2 (top). */
  startAngle?: number;
  /** Deterministic seed; defaults to a hash of the candidate ids. */
  seed?: number | string;
}

export type Point = readonly [number, number];

export interface RadialSegment {
  index: number;
  candidate: RadialCandidate;
  /** Vertex angles delimiting the sector, radians (absolute, increasing). */
  angleStart: number;
  angleEnd: number;
  /** Inner-circle radius (constant across segments). */
  innerRadius: number;
  /** Jittered vertex radii (outer polygon is not a perfect circle). */
  outerRadiusStart: number;
  outerRadiusEnd: number;
  /** Boundary anchors, relative to the wheel centre. */
  innerStart: Point;
  innerEnd: Point;
  outerStart: Point;
  outerEnd: Point;
  /** Where the label sits (mid-angle, between inner and outer). */
  label: Point;
  /** SVG path for this sector. */
  path: string;
}

/** 轮盘形态：n≤3 画圆（判据=半径），n≥4 画多边形（判据=多边形）。 */
export type WheelShape = 'circle' | 'polygon';

export interface RadialWheel {
  /** Number of candidates (segments). */
  count: number;
  /** 形态。**绘制与判定必须同时看它**，不允许"画圆却按多边形判"。 */
  shape: WheelShape;
  /** 外轮廓顶点（相对圆心，按角度顺序）。磨砂层用它做 clip-path：**只在轮盘内磨砂**。 */
  outline: Point[];
  radius: number;
  innerRadius: number;
  startAngle: number;
  segments: RadialSegment[];
}

export type RadialHit =
  | { zone: 'center' }
  | { zone: 'segment'; index: number; candidate: RadialCandidate }
  | { zone: 'empty' };

const TAU = Math.PI * 2;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** FNV-1a — small, stable, dependency-free string hash. */
function hashSeed(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 固定的抖动表（-1..1）。
 *
 * 打开轮盘时只需要 O(n) 查表，不建 PRNG、不跑循环里的浮点随机——10 个候选也压在
 * 20µs 以内。表是常量，所以"同一组候选 ⇒ 同一形状"天然成立（可复现、可截图比对）。
 */
const JITTER: readonly number[] = [
  0.0, -0.62, 0.38, -0.24, 0.71, -0.45, 0.15, -0.83, 0.52, -0.09, 0.27, -0.36
];

const jitterAt = (seed: number, index: number): number =>
  JITTER[(seed + index * 5) % JITTER.length] as number;

function polar(radius: number, angle: number): Point {
  return [radius * Math.cos(angle), radius * Math.sin(angle)];
}

/** Normalise an angle into [0, 2π). */
function normalize(angle: number): number {
  const a = angle % TAU;
  return a < 0 ? a + TAU : a;
}

/**
 * Build the wheel geometry for `candidates`.
 *
 * Vertex angles stay strictly increasing because the angular jitter is capped
 * below half a segment (`jitterAngle < 0.5`), so a sector can never invert even
 * with an unlucky seed.
 */
export function buildWheel(candidates: readonly RadialCandidate[], opts: RadialWheelOptions): RadialWheel {
  const n = candidates.length;
  const radius = Math.max(0, opts.radius);
  const innerRatio = clamp(opts.innerRatio ?? 0.26, 0.05, 0.9);
  const innerRadius = radius * innerRatio;
  const jitterR = clamp(opts.jitterRadius ?? 0.04, 0, 0.4);
  // 0.0375 = 相邻两条边界各抖 ±3.75%，每块角宽偏差 ≤ ±7.5%：
  // 既保留"不规则多边形"的手感，又不至于让某一块明显小得难点（区间再缩一倍）。
  const jitterA = clamp(opts.jitterAngle ?? 0.0375, 0, 0.45);
  const startAngle = opts.startAngle ?? -Math.PI / 2;

  if (n === 0) {
    return { count: 0, shape: 'circle', radius, innerRadius, startAngle, segments: [], outline: [] };
  }

  const seedValue = opts.seed ?? candidates.map((c) => c.id).join('|');
  const seed = typeof seedValue === 'string' ? hashSeed(seedValue) : seedValue >>> 0;

  const step = TAU / n;

  // 边界角抖动：**先取一组零均值的小抖动**，再摊回 2π。
  // 这一步是整个扇区"大小差不多"的关键：以前是每个顶点各自抖，扇区宽度可以差一倍
  // （120°±43°），画出来就是几条细缝贴着大圆。现在每块宽度被夹在 ±12% 以内。
  const rawJitter: number[] = [];
  for (let i = 0; i < n; i += 1) rawJitter.push(jitterAt(seed, i) * jitterA * step);
  const mean = rawJitter.reduce((sum, value) => sum + value, 0) / n;
  const boundaryAt = (index: number): number => startAngle + index * step + (rawJitter[index % n] - mean);

  // 半径抖动只负责"轮廓不呆板"，幅度比角度更小，避免出现尖刺。
  // n ≤ 3 时顶点太少：2 个顶点会让多边形退化成"过圆心的直线"（面积→0），3 个顶点
  // 的三角形又把扇区压得很窄、轮盘看着像几根棍子。所以 n≤3 统一用圆弧外边界
  // （环形扇区 = 圆形轮盘），只有 n≥4 才用多边形轮廓。
  const shape: WheelShape = n <= 3 ? 'circle' : 'polygon';
  const arcOuter = shape === 'circle';
  const radii: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const rJitter = arcOuter ? 0 : jitterAt(seed, i + 7) * jitterR * radius;
    radii.push(Math.max(innerRadius * 1.05, radius + rJitter));
  }

  const segments: RadialSegment[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const angleStart = boundaryAt(i);
    const angleEnd = i < n - 1 ? boundaryAt(i + 1) : boundaryAt(0) + TAU;
    const outerRadiusStart = radii[i];
    const outerRadiusEnd = radii[j];
    const innerStart = polar(innerRadius, angleStart);
    const innerEnd = polar(innerRadius, angleEnd);
    const outerStart = polar(outerRadiusStart, angleStart);
    const outerEnd = polar(outerRadiusEnd, angleEnd);
    // 标签点：沿**分区角平分线**往内收，落在"中心圆之外、外边界之内"。
    // 顶点加权重心在 n=2 时会塌到圆心（两条引线近乎反向），头像就叠在"更多"上——
    // 这是"头像看起来不在分区里"的真正原因。角平分线 + 收进 55% 对任意 n 都成立。
    const halfWidth = Math.max(1e-4, (angleEnd - angleStart) / 2);
    const outerMid = (outerRadiusStart + outerRadiusEnd) / 2;
    // 多边形模式下外边界是弦：沿角平分线到弦的距离 ≈ R·cos(半角)。
    const reach = arcOuter ? outerMid : outerMid * Math.cos(Math.min(Math.PI / 2 - 0.02, halfWidth));
    const labelRadius = innerRadius + Math.max(0, reach - innerRadius) * 0.55;
    const label = polar(labelRadius, (angleStart + angleEnd) / 2);
    // 扇区轮廓用折线拼，不用 SVG 圆弧命令：`A` 的 sweep/large-arc 标志在
    // "内外两条弧 + 两条引线"的组合里极易画反（旧版就是因此画出一堆鼓包与细缝）。
    // 折线在 R ≤ 560 时肉眼看不出差别，而且 n=1/2/3… 全是同一套逻辑。
    const ARC_STEPS = 10;
    const innerPts: Point[] = [];
    for (let k = 0; k <= ARC_STEPS; k += 1) {
      const angle = angleStart + (angleEnd - angleStart) * (k / ARC_STEPS);
      innerPts.push(polar(innerRadius, angle));
    }
    const outerPts: Point[] = arcOuter
      ? Array.from({ length: ARC_STEPS + 1 }, (_, k) =>
          polar(radius, angleStart + (angleEnd - angleStart) * (k / ARC_STEPS))
        )
      : [polar(outerRadiusStart, angleStart), polar(outerRadiusEnd, angleEnd)];
    const pts = [...innerPts, ...outerPts.slice().reverse()];
    const path =
      `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)} ` +
      pts
        .slice(1)
        .map(pt => `L ${pt[0].toFixed(2)} ${pt[1].toFixed(2)}`)
        .join(' ') +
      ' Z';

    segments.push({
      index: i,
      candidate: candidates[i],
      angleStart,
      angleEnd,
      innerRadius,
      outerRadiusStart,
      outerRadiusEnd,
      innerStart,
      innerEnd,
      outerStart,
      outerEnd,
      label,
      path,
    });
  }

  // 外轮廓与形态一致：圆形给一圈采样点（描边用），多边形给顶点。
  // 这里以前写的是 n<=2，而扇区绘制在 n<=3 就切成了圆弧 —— n=3 于是"画的是圆、
  // 判的是三角形"，光标在圆内三角外还能亮。现在统一由 shape 决定。
  const outline: Point[] =
    shape === 'circle'
      ? Array.from({ length: 48 }, (_, i) => polar(radius, startAngle + (i / 48) * TAU) as Point)
      : segments.map(seg => seg.outerStart);
  return { count: n, shape, radius, innerRadius, startAngle, segments, outline };
}

/** 点是否落在轮盘外轮廓（多边形/近似圆）内部。 */
export function outlineContains(wheel: RadialWheel, dx: number, dy: number): boolean {
  const points = wheel.outline;
  if (points.length < 3) return true;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > dy !== yj > dy && dx < ((xj - xi) * (dy - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Hit-test a pointer offset from the wheel centre.
 *
 * Uses the *same* segment angles the geometry was built from, so the pointer
 * lands in exactly the shape it appears to be over. Radius only decides
 * centre-vs-segment; beyond the centre circle every angle maps to a segment
 * (a forgiving target even if the pointer overshoots the polygon edge).
 */
export function hitTestWheel(wheel: RadialWheel, dx: number, dy: number): RadialHit {
  if (wheel.count === 0) return { zone: 'empty' };
  const r = Math.hypot(dx, dy);
  if (r < wheel.innerRadius) return { zone: 'center' };

  if (wheel.shape === 'circle') {
    // 圆形轮盘：判据就是半径——圈内就是某个扇区，出圈即"轮盘外"。
    if (r > wheel.radius * 1.02) return { zone: 'empty' };
  } else if (!outlineContains(wheel, dx, dy)) {
    // 多边形轮盘：四角是空白区，必须真的落在多边形里才算命中。
    return { zone: 'empty' };
  }

  if (wheel.count === 1) {
    return { zone: 'segment', index: 0, candidate: wheel.segments[0].candidate };
  }

  // Measure angles from the *actual* first vertex, not the nominal start: the
  // first vertex carries jitter too, so `opts.startAngle` is not its true angle.
  const base = wheel.segments[0].angleStart;
  const rel = normalize(Math.atan2(dy, dx) - base);
  for (const seg of wheel.segments) {
    const start = seg.angleStart - base;
    const width = seg.angleEnd - seg.angleStart;
    if (rel >= start && rel < start + width) {
      return { zone: 'segment', index: seg.index, candidate: seg.candidate };
    }
  }
  // Floating-point gap at the wrap seam: fall back to the last segment.
  const last = wheel.segments[wheel.count - 1];
  return { zone: 'segment', index: last.index, candidate: last.candidate };
}
