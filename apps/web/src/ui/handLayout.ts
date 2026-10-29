/**
 * Fisheye hand-row layout — pure, dependency-free, unit-agnostic.
 *
 * ---------------------------------------------------------------------------
 * The problem
 * ---------------------------------------------------------------------------
 * A hand row owns a fixed amount of space (a CSS container, or the world-space
 * strip in front of a 3D seat) but the card count is unbounded. Uniform
 * spacing has only two failure modes: overflow the row, or squeeze every card
 * into an unreadable stack. What we want instead is a dock-style fisheye — the
 * cards under the pointer keep a readable gap, the cards further away compress
 * to absorb the difference — and the pointer may sit at *either* end, so the
 * bell has to travel with it.
 *
 * ---------------------------------------------------------------------------
 * How it works
 * ---------------------------------------------------------------------------
 * 1. Weight bell. Every card gets a weight
 *
 *        w_i = 1 + k · exp(-((i - c) / σ)²)
 *
 *    where c = focusX · (n - 1) is the fractional cursor index. Both σ and k
 *    grow with the card count (`handFocusSigma` / `handFocusAmplitude`): a wide
 *    bell for a five-card hand, a narrow one for fifty. A fixed σ would let the
 *    bell swallow the whole row on a big hand and collapse back to uniform.
 *
 * 2. Pitch multipliers. Adjacent pairs get a_i = (w_i + w_{i+1}) / 2, which is
 *    unimodal with its peak on the pair straddling the cursor. Normalising to
 *    t_i ∈ [0, 1] across the row gives a per-gap pitch target, in multiples of
 *    one card width:
 *
 *        m_i = CONTEXT_PITCH_RATIO + (FOCUS_PITCH_RATIO - CONTEXT_PITCH_RATIO) · t_i
 *
 *    i.e. 1.35 card widths right under the pointer and 0.22 card widths at the
 *    far end (a fifth of each context card stays visible). `blend` fades the
 *    whole range back towards 1 when the row is roomy enough to hold every card
 *    without overlap — there is no point magnifying a hand that already fits.
 *
 * 3. Exact fill (the normalisation). The card width is chosen so the focused
 *    gap lands on one card width, then the pitches are solved by one scalar:
 *
 *        cw = min(cardWidth, W · m_max / (Σm + m_max))     (bell centred)
 *        K  = (W - cw) / Σm,        pitch_i = K · m_i      (bell at cursor)
 *
 *    which gives  Σ pitch_i + cw = W  *identically*, for any card count, any
 *    cursor position and any container width. The row is a normalised density,
 *    not a clamped one: it can never overflow and never leaves a hole. With
 *    `focusStrength: 0` every m_i = 1, so cw = W / n and pitch = W / n — the
 *    plain uniform fit falls out of the same formula.
 *
 * 4. Positions are laid out from the left edge, so card 0's left edge is at 0
 *    and card n-1's right edge is at W. A "slot centred on the container"
 *    layout would instead push the end card half outside the row whenever the
 *    focus sits at the opposite end — the exact bug this module exists to avoid.
 *
 * The module returns plain numbers (centre offsets and a scale per card) so the
 * caller can map them onto CSS transforms or onto Three.js positions; it knows
 * nothing about either.
 */

/** Far-end pitch, as a fraction of one card width (22% of each card shows). */
const CONTEXT_PITCH_RATIO = 0.22;
/** Focus pitch, as a fraction of one card width (one card + 35% air). */
const FOCUS_PITCH_RATIO = 1.35;
/** Floor for the roominess blend, so a roomy row still reads as a fisheye. */
const MIN_BLEND = 0.45;
/** Extra size applied to the hovered card (visual only, not part of the fit). */
const HOVER_SCALE = 1.12;

export interface HandLayoutInput {
  /** Number of cards in the row. 0 is legal and yields an empty result. */
  count: number;
  /** Width available to the row, in any consistent unit (px, world units, …). */
  containerWidth: number;
  /** Width of one card at scale 1, in the same unit as `containerWidth`. */
  cardWidth: number;
  /** Pointer position along the row: 0 = left edge, 1 = right edge. */
  focusX?: number | null;
  /** 0..1 multiplier on the bell: 0 = uniform, 1 = full fisheye. */
  focusStrength?: number;
  /** Card currently hovered: gets a lift, a size bump and the top layer. */
  hoverIndex?: number | null;
}

export interface HandLayoutCard {
  index: number;
  /** Centre of the card measured from the row's left edge. */
  x: number;
  /** Same centre, expressed relative to the middle of the row. */
  offset: number;
  /** Uniform size multiplier (1 = `cardWidth`); includes the hover bump. */
  scale: number;
  /** Bell value at this card, 0..1 (1 = right under the pointer). */
  focus: number;
  /** Stacking order: higher draws in front. */
  z: number;
  /** 0..1 lift hint, 1 = the hovered card. */
  lift: number;
  /** Rendered width of the card (before any hover bump). */
  width: number;
}

export interface HandLayoutResult {
  cards: HandLayoutCard[];
  count: number;
  /** Left edge of the first card → right edge of the last (=== containerWidth). */
  span: number;
  /** `width / cardWidth` for every card (before the hover bump). */
  cardScale: number;
  /** Bell width actually used, in card indices. */
  sigma: number;
  /** Bell amplitude actually used (k · focusStrength). */
  amplitude: number;
  /** Fractional cursor index, or null when the row is uniform. */
  cursorIndex: number | null;
  /** Centre-to-centre distances between neighbours, left to right. */
  pitches: number[];
  /** Pitch at the cursor. */
  focusGap: number;
  /** Pitch at the end of the row furthest from the cursor. */
  farGap: number;
  minPitch: number;
  maxPitch: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function finiteOr(value: number | undefined | null, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Bell width, in card indices. Grows linearly with the hand, clamped so that a
 * two-card hand still gets a usable bell and a fifty-card hand does not smear
 * the focus across the whole row.
 */
export function handFocusSigma(count: number): number {
  return clamp(count * 0.16, 1, 7);
}

/**
 * Bell amplitude `k`. Bigger hands need a stronger bell: with 50 cards the row
 * has to steal space from ~45 context cards to make the focus readable.
 */
export function handFocusAmplitude(count: number): number {
  return clamp(0.9 + count * 0.11, 1.5, 6.5);
}

/**
 * How much of the available strip a hand of `count` cards is allowed to use.
 *
 * `maxSpan` is a budget, not a target: three cards should look like a small
 * fan, not like three cards scattered over the whole row. Up to roughly
 * `maxSpan / (cardWidth · (1 + airRatio))` cards the row grows one card plus a
 * sliver of air at a time; past that it stays at `maxSpan` and the fisheye
 * starts compressing the context cards, which is what keeps 20 or 50 cards on
 * screen. The result is still a container the layout fills *exactly*.
 */
export function handRowSpan(
  count: number,
  maxSpan: number,
  cardWidth: number,
  airRatio = 0.12
): number {
  const natural = Math.max(0, count) * cardWidth * (1 + airRatio);
  return Math.min(maxSpan, Math.max(natural, cardWidth * 1.6));
}

/**
 * Lay out one hand row.
 *
 * Deterministic and side-effect free: the same input always yields the same
 * numbers, which is what makes the fisheye testable outside a browser.
 */
export function handLayout(input: HandLayoutInput): HandLayoutResult {
  const count = Math.max(0, Math.floor(finiteOr(input.count, 0)));
  const width = Math.max(0, finiteOr(input.containerWidth, 0));
  const baseWidth = Math.max(0, finiteOr(input.cardWidth, 0));
  const strength = clamp(finiteOr(input.focusStrength, 1), 0, 1);
  const sigma = handFocusSigma(count);
  const amplitude = handFocusAmplitude(count) * strength;
  const focusX = input.focusX == null ? null : clamp(finiteOr(input.focusX, 0.5), 0, 1);
  const cursorIndex = focusX == null || count === 0 ? null : focusX * (count - 1);
  const hoverIndex =
    input.hoverIndex == null || count === 0
      ? null
      : clamp(Math.round(finiteOr(input.hoverIndex, 0)), 0, count - 1);

  const empty: HandLayoutResult = {
    cards: [],
    count,
    span: 0,
    cardScale: 0,
    sigma,
    amplitude,
    cursorIndex,
    pitches: [],
    focusGap: 0,
    farGap: 0,
    minPitch: 0,
    maxPitch: 0
  };
  if (count === 0 || width <= 0 || baseWidth <= 0) return empty;

  /* ---- 1. bell weights ------------------------------------------------ */
  // Bell value per card: 1 directly under the pointer, decaying with distance.
  // Kept for the `focus` field the renderer uses for hover emphasis; the pitch
  // maths below recomputes the same bell for whichever cursor it is asked about.
  const bell: number[] = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    if (cursorIndex == null || amplitude <= 0) {
      bell[i] = 0;
      continue;
    }
    const d = (i - cursorIndex) / sigma;
    bell[i] = Math.exp(-d * d);
  }

  /* ---- single card: no gap to normalise ------------------------------- */
  if (count === 1) {
    const cardWidth = Math.min(baseWidth, width);
    const hovered = hoverIndex === 0;
    const scale = cardWidth / baseWidth;
    return {
      cards: [
        {
          index: 0,
          x: width / 2,
          offset: 0,
          scale: scale * (hovered ? HOVER_SCALE : 1),
          focus: bell[0],
          z: hovered ? 1 : 0,
          lift: hovered ? 1 : 0,
          width: cardWidth
        }
      ],
      count,
      span: cardWidth,
      cardScale: scale,
      sigma,
      amplitude,
      cursorIndex,
      pitches: [],
      focusGap: 0,
      farGap: 0,
      minPitch: 0,
      maxPitch: 0
    };
  }

  /* ---- 2. pair weights → pitch multipliers ---------------------------- */
  // How much fisheye the row can afford: when the cards already fit without
  // overlap, the row only needs a hint of it.
  const roominess = width / (count * baseWidth);
  const blend = clamp(1 / roominess, MIN_BLEND, 1) * strength;

  // A pitch multiplier per gap: how wide that gap wants to be, in multiples of
  // one card width. `null` cursor means a flat row (every multiplier 1).
  const multipliersFor = (cursor: number | null) => {
    const pair: number[] = new Array<number>(count - 1);
    let pairMin = Number.POSITIVE_INFINITY;
    let pairMax = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < count - 1; i++) {
      let w0 = 1;
      let w1 = 1;
      if (cursor != null && amplitude > 0) {
        const d0 = (i - cursor) / sigma;
        const d1 = (i + 1 - cursor) / sigma;
        w0 = 1 + amplitude * Math.exp(-d0 * d0);
        w1 = 1 + amplitude * Math.exp(-d1 * d1);
      }
      const a = (w0 + w1) / 2;
      pair[i] = a;
      if (a < pairMin) pairMin = a;
      if (a > pairMax) pairMax = a;
    }
    const spread = pairMax - pairMin;
    const mult: number[] = new Array<number>(count - 1);
    let sum = 0;
    let max = 0;
    for (let i = 0; i < count - 1; i++) {
      const t = spread > 1e-9 ? (pair[i] - pairMin) / spread : 0.5;
      const raw = CONTEXT_PITCH_RATIO + (FOCUS_PITCH_RATIO - CONTEXT_PITCH_RATIO) * t;
      const m = 1 + (raw - 1) * blend;
      mult[i] = m;
      sum += m;
      if (m > max) max = m;
    }
    return { mult, sum, max };
  };

  /* ---- 3. card width + exact normalisation ---------------------------- */
  // The card size is a property of the *hand*, not of the pointer: it is
  // derived from a reference bell centred on the row, so sweeping the cursor
  // along the hand only redistributes the gaps instead of resizing every card.
  const reference = multipliersFor(cursorIndex == null ? null : (count - 1) / 2);
  const actual = cursorIndex == null ? reference : multipliersFor(cursorIndex);

  // Size the cards so the focused gap lands on one card width (measured with
  // the pointer at the centre of the row, see `reference`), then let the single
  // scalar K absorb everything else. Both stay positive: every m > 0, and
  // cardWidth < width because m_max < Σm + m_max.
  const cardWidth = Math.min(baseWidth, (width * reference.max) / (reference.sum + reference.max));
  const cardScale = cardWidth / baseWidth;
  const K = (width - cardWidth) / actual.sum;
  const pitches: number[] = new Array<number>(count - 1);
  let minPitch = Number.POSITIVE_INFINITY;
  let maxPitch = 0;
  for (let i = 0; i < count - 1; i++) {
    const pitch = K * actual.mult[i];
    pitches[i] = pitch;
    if (pitch < minPitch) minPitch = pitch;
    if (pitch > maxPitch) maxPitch = pitch;
  }

  /* ---- 4. positions, pinned to both edges of the row ------------------ */
  const cards: HandLayoutCard[] = new Array<HandLayoutCard>(count);
  let x = cardWidth / 2;
  for (let i = 0; i < count; i++) {
    const hovered = hoverIndex === i;
    cards[i] = {
      index: i,
      x,
      offset: x - width / 2,
      scale: cardScale * (hovered ? HOVER_SCALE : 1),
      focus: bell[i],
      z: hovered ? count : i,
      lift: hovered ? 1 : 0,
      width: cardWidth
    };
    if (i < count - 1) x += pitches[i];
  }

  // Report the widest and the narrowest gap in terms of the cursor: a gap sits
  // at i + 0.5, so the one whose midpoint is closest to the cursor is the
  // focus and the one furthest away is the context end (ties are symmetric).
  let focusGapIndex = 0;
  let farGapIndex = 0;
  if (cursorIndex != null) {
    let closest = Number.POSITIVE_INFINITY;
    let furthest = -1;
    for (let i = 0; i < count - 1; i++) {
      const distance = Math.abs(i + 0.5 - cursorIndex);
      if (distance < closest) {
        closest = distance;
        focusGapIndex = i;
      }
      if (distance > furthest) {
        furthest = distance;
        farGapIndex = i;
      }
    }
  } else {
    focusGapIndex = Math.floor((count - 1) / 2);
    farGapIndex = 0;
  }

  return {
    cards,
    count,
    span: cardWidth + pitches.reduce((sum, pitch) => sum + pitch, 0),
    cardScale,
    sigma,
    amplitude,
    cursorIndex,
    pitches,
    focusGap: pitches[focusGapIndex],
    farGap: pitches[farGapIndex],
    minPitch,
    maxPitch
  };
}
