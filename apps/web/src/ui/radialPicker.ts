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
  /** Optional player/team colour, used by the renderer. */
  color?: string;
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

export interface RadialWheel {
  /** Number of candidates (segments). */
  count: number;
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

/** mulberry32 PRNG — deterministic 0..1 stream from a 32-bit seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
  const innerRatio = clamp(opts.innerRatio ?? 0.34, 0.05, 0.9);
  const innerRadius = radius * innerRatio;
  const jitterR = clamp(opts.jitterRadius ?? 0.12, 0, 0.4);
  const jitterA = clamp(opts.jitterAngle ?? 0.18, 0, 0.45);
  const startAngle = opts.startAngle ?? -Math.PI / 2;

  if (n === 0) {
    return { count: 0, radius, innerRadius, startAngle, segments: [] };
  }

  const seedValue = opts.seed ?? candidates.map((c) => c.id).join('|');
  const rand = mulberry32(typeof seedValue === 'string' ? hashSeed(seedValue) : seedValue >>> 0);

  const step = TAU / n;
  // Vertex angles and radii, jittered once (stable for the wheel's lifetime).
  const angles: number[] = [];
  const radii: number[] = [];
  for (let i = 0; i < n; i++) {
    const base = startAngle + i * step;
    const aJitter = (rand() * 2 - 1) * jitterA * step;
    const rJitter = (rand() * 2 - 1) * jitterR * radius;
    angles.push(base + aJitter);
    radii.push(Math.max(innerRadius * 1.05, radius + rJitter));
  }

  const segments: RadialSegment[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const angleStart = angles[i];
    const angleEnd = i < n - 1 ? angles[j] : angles[0] + TAU;
    const outerRadiusStart = radii[i];
    const outerRadiusEnd = radii[j];
    const innerStart = polar(innerRadius, angleStart);
    const innerEnd = polar(innerRadius, angleEnd);
    const outerStart = polar(outerRadiusStart, angleStart);
    const outerEnd = polar(outerRadiusEnd, angleEnd);
    const midAngle = (angleStart + angleEnd) / 2;
    const label = polar((innerRadius + radius) / 2, midAngle);
    const largeArc = angleEnd - angleStart > Math.PI ? 1 : 0;
    const path =
      `M ${innerStart[0].toFixed(2)} ${innerStart[1].toFixed(2)} ` +
      `L ${outerStart[0].toFixed(2)} ${outerStart[1].toFixed(2)} ` +
      `L ${outerEnd[0].toFixed(2)} ${outerEnd[1].toFixed(2)} ` +
      `A ${innerRadius.toFixed(2)} ${innerRadius.toFixed(2)} 0 ${largeArc} 0 ` +
      `${innerEnd[0].toFixed(2)} ${innerEnd[1].toFixed(2)} Z`;

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

  return { count: n, radius, innerRadius, startAngle, segments };
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
