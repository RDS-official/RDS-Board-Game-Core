/**
 * Hand-row fisheye layout probe.
 *
 * Guards the pure layout function in apps/web/src/ui/handLayout.ts, which the
 * 3D hand renderer (apps/web/src/render/scene.ts → renderHand) uses to place
 * every card of a hand inside one fixed-width row.
 *
 * What it proves, without a browser:
 *
 *   1. Fill. The row is exactly `containerWidth` wide for every card count and
 *      every cursor position — no overflow, no gap, no clipping at either edge.
 *   2. Fisheye. With the cursor at the left edge, the middle and the right
 *      edge, the gap next to the cursor is always wider than the gap at the far
 *      end, and the gaps decay monotonically as you move away from the cursor.
 *   3. Uniformity. `focusStrength: 0` (pointer away) degenerates into the plain
 *      uniform fit: identical gaps, cards exactly touching.
 *   4. Hover. The hovered card is lifted, enlarged and drawn on top; nothing
 *      else moves.
 *
 * Run: node scripts/probe-hand-layout.mjs   (or `pnpm probe:hand`)
 */

import {
  handLayout,
  handRowSpan,
  handFocusSigma,
  handFocusAmplitude
} from '../apps/web/src/ui/handLayout.ts';

const EPS = 1e-9;
const failures = [];
const notes = [];

function check(ok, message) {
  if (!ok) failures.push(message);
  return ok;
}

function close(a, b, tol = 1e-6) {
  return Math.abs(a - b) <= tol;
}

/** Rows the app actually renders: the 3D seat strip plus two DOM-ish widths. */
const ROWS = [
  { label: '3D seat row 6.4u', width: 6.4, cardWidth: 0.63 },
  { label: 'narrow 320px', width: 320, cardWidth: 62 },
  { label: 'wide 1200px', width: 1200, cardWidth: 62 }
];

const COUNTS = [1, 2, 3, 5, 10, 20, 50, 120];
const CURSORS = [0, 0.25, 0.5, 0.75, 1];

/* ------------------------------------------------------------------ */
/* 1 + 2. Fill and fisheye across the whole matrix                     */
/* ------------------------------------------------------------------ */
const matrix = [];

for (const row of ROWS) {
  for (const count of COUNTS) {
    for (const focusX of CURSORS) {
      const tag = `${row.label} n=${count} x=${focusX}`;
      const result = handLayout({
        count,
        containerWidth: row.width,
        cardWidth: row.cardWidth,
        focusX,
        focusStrength: 1
      });

      check(result.cards.length === count, `${tag}: expected ${count} cards, got ${result.cards.length}`);
      for (const card of result.cards) {
        check(
          Number.isFinite(card.x) && Number.isFinite(card.scale) && Number.isFinite(card.width),
          `${tag}: non-finite card ${card.index}`
        );
      }
      check(result.cardScale > 0 && result.cardScale <= 1 + EPS, `${tag}: cardScale out of range (${result.cardScale})`);

      if (count >= 2) {
        // ---- fill: the span is exactly the container, both edges included
        check(close(result.span, row.width, 1e-6), `${tag}: span ${result.span} !== width ${row.width}`);
        const first = result.cards[0];
        const last = result.cards[count - 1];
        check(
          first.x - first.width / 2 >= -1e-6,
          `${tag}: first card clips the left edge (${first.x - first.width / 2})`
        );
        check(
          last.x + last.width / 2 <= row.width + 1e-6,
          `${tag}: last card clips the right edge (${last.x + last.width / 2} > ${row.width})`
        );

        // ---- no crossings, every pitch positive
        for (let i = 0; i < count - 1; i++) {
          check(result.pitches[i] > 0, `${tag}: pitch ${i} is not positive (${result.pitches[i]})`);
          check(
            result.cards[i + 1].x > result.cards[i].x,
            `${tag}: cards ${i}/${i + 1} are out of order`
          );
        }

        // ---- fisheye: gaps decay with distance from the cursor
        const cursorIndex = focusX * (count - 1);
        const ordered = [...result.pitches.keys()].sort(
          (a, b) => Math.abs(a + 0.5 - cursorIndex) - Math.abs(b + 0.5 - cursorIndex)
        );
        for (let k = 1; k < ordered.length; k++) {
          const near = result.pitches[ordered[k - 1]];
          const far = result.pitches[ordered[k]];
          check(
            near >= far - 1e-9,
            `${tag}: gap at distance ${k - 1} (${near.toFixed(4)}) < gap at distance ${k} (${far.toFixed(4)})`
          );
        }

        // ---- near end vs far end, the headline requirement
        // (n = 3 at the centre is symmetric: both gaps are the same by design)
        if (count >= 4) {
          check(
            result.focusGap > result.farGap + 1e-9,
            `${tag}: focus gap ${result.focusGap.toFixed(4)} is not wider than far gap ${result.farGap.toFixed(4)}`
          );
        } else {
          check(
            result.focusGap >= result.farGap - 1e-9,
            `${tag}: focus gap ${result.focusGap.toFixed(4)} is narrower than far gap ${result.farGap.toFixed(4)}`
          );
        }

        // ---- the cursor really is at the end it claims
        if (focusX === 0) {
          check(result.cards[0].focus > result.cards[count - 1].focus + 1e-6, `${tag}: focus is not at the left end`);
          check(result.pitches[0] === result.maxPitch - 0 || close(result.pitches[0], result.maxPitch, 1e-9), `${tag}: left gap is not the widest`);
        }
        if (focusX === 1) {
          check(result.cards[count - 1].focus > result.cards[0].focus + 1e-6, `${tag}: focus is not at the right end`);
          check(close(result.pitches[count - 2], result.maxPitch, 1e-9), `${tag}: right gap is not the widest`);
        }
      }

      if (focusX === 0.5 || count === 1) {
        matrix.push({
          row: row.label,
          count,
          focusX,
          cardScale: result.cardScale,
          span: result.span,
          focusGap: result.focusGap,
          farGap: result.farGap,
          ratio: result.farGap > 0 ? result.focusGap / result.farGap : 0
        });
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 3. Uniform mode (pointer away)                                      */
/* ------------------------------------------------------------------ */
for (const row of ROWS) {
  for (const count of COUNTS) {
    const tag = `uniform ${row.label} n=${count}`;
    const result = handLayout({
      count,
      containerWidth: row.width,
      cardWidth: row.cardWidth,
      focusX: 0.5,
      focusStrength: 0
    });
    if (count >= 2) {
      check(close(result.span, row.width, 1e-6), `${tag}: span ${result.span} !== ${row.width}`);
      // Uniform mode spreads the hand evenly across the row: cards keep their
      // natural size while they fit, then shrink to W/n once they do not.
      const cardW = Math.min(row.cardWidth, row.width / count);
      const expected = (row.width - cardW) / (count - 1);
      for (const pitch of result.pitches) {
        check(close(pitch, expected, 1e-6), `${tag}: pitch ${pitch} !== uniform ${expected}`);
      }
      check(close(result.cardScale, cardW / row.cardWidth, 1e-6), `${tag}: cardScale ${result.cardScale}`);
      for (const card of result.cards) {
        check(card.focus === 0, `${tag}: uniform mode still reports focus ${card.focus}`);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 4. Hover                                                            */
/* ------------------------------------------------------------------ */
{
  const result = handLayout({
    count: 20,
    containerWidth: 6.4,
    cardWidth: 0.63,
    focusX: 0.3,
    focusStrength: 1,
    hoverIndex: 7
  });
  const hovered = result.cards[7];
  check(hovered.lift === 1, 'hover: hovered card is not lifted');
  check(hovered.scale > result.cardScale + 1e-9, 'hover: hovered card is not enlarged');
  check(hovered.z === result.count, `hover: hovered card z ${hovered.z} is not on top`);
  for (const card of result.cards) {
    if (card.index === 7) continue;
    check(card.lift === 0, `hover: card ${card.index} was lifted too`);
    check(card.z < hovered.z, `hover: card ${card.index} draws above the hovered card`);
    check(close(card.scale, result.cardScale, 1e-9), `hover: card ${card.index} changed size`);
  }
}

/* ------------------------------------------------------------------ */
/* 5. Degenerate inputs and determinism                                */
/* ------------------------------------------------------------------ */
{
  const empty = handLayout({ count: 0, containerWidth: 800, cardWidth: 62, focusX: 0.5 });
  check(empty.cards.length === 0 && empty.span === 0, 'empty: count 0 produced cards');

  const zeroWidth = handLayout({ count: 10, containerWidth: 0, cardWidth: 62, focusX: 0.5 });
  check(zeroWidth.cards.length === 0, 'empty: zero width produced cards');

  const single = handLayout({ count: 1, containerWidth: 800, cardWidth: 62, focusX: 0 });
  check(single.cards.length === 1 && close(single.cards[0].x, 400, 1e-9), 'single: card is not centred');

  const tiny = handLayout({ count: 500, containerWidth: 320, cardWidth: 62, focusX: 0.5 });
  check(close(tiny.span, 320, 1e-6), 'stress: 500 cards overflow the row');
  check(tiny.pitches.every(p => p > 0), 'stress: 500 cards produced a non-positive pitch');

  const a = handLayout({ count: 50, containerWidth: 6.4, cardWidth: 0.63, focusX: 0.7 });
  const b = handLayout({ count: 50, containerWidth: 6.4, cardWidth: 0.63, focusX: 0.7 });
  check(JSON.stringify(a) === JSON.stringify(b), 'determinism: two identical calls disagree');
}

/* ------------------------------------------------------------------ */
/* 6. The exact configuration the 3D hand renderer uses                */
/* ------------------------------------------------------------------ */
// apps/web/src/render/scene.ts: HAND_ROW_SPAN / HAND_CARD_WIDTH, with the row
// budget chosen per hand size by handRowSpan().
const RENDER_SPAN = 6.4;
const RENDER_CARD = 0.63;
const rendererRows = [];

for (let count = 1; count <= 60; count++) {
  const span = handRowSpan(count, RENDER_SPAN, RENDER_CARD);
  const tag = `renderer n=${count}`;
  check(span <= RENDER_SPAN + 1e-9, `${tag}: row span ${span} exceeds the ${RENDER_SPAN}u strip`);
  if (count > 1) {
    check(
      span >= handRowSpan(count - 1, RENDER_SPAN, RENDER_CARD) - 1e-9,
      `${tag}: row shrinks as the hand grows`
    );
  }

  for (const focusX of [0, 0.5, 1]) {
    const result = handLayout({
      count,
      containerWidth: span,
      cardWidth: RENDER_CARD,
      focusX,
      focusStrength: 1
    });
    // Card size is a property of the hand, not of the pointer: sweeping the
    // cursor must only redistribute gaps, never resize the whole row.
    if (count >= 2) {
      const centred = handLayout({
        count,
        containerWidth: span,
        cardWidth: RENDER_CARD,
        focusX: 0.5,
        focusStrength: 1
      });
      check(
        close(result.cardScale, centred.cardScale, 1e-9),
        `${tag} x=${focusX}: card size depends on the cursor position`
      );
    }
    if (count >= 2) {
      check(close(result.span, span, 1e-6), `${tag} x=${focusX}: span ${result.span} !== row ${span}`);
      check(result.pitches.every(p => p > 0), `${tag} x=${focusX}: non-positive pitch`);
      check(
        result.focusGap > result.farGap - 1e-9,
        `${tag} x=${focusX}: focus gap ${result.focusGap.toFixed(3)} < far gap ${result.farGap.toFixed(3)}`
      );
    }
    // Even a 60-card hand must keep the cards recognisable: the layout may
    // shrink them, but never below a fifth of their natural size.
    check(result.cardScale > 0.2, `${tag} x=${focusX}: cards shrunk to ${result.cardScale.toFixed(3)}×`);
  }

  if (count === 5 || count === 10 || count === 20 || count === 50) {
    const result = handLayout({ count, containerWidth: span, cardWidth: RENDER_CARD, focusX: 0.5, focusStrength: 1 });
    rendererRows.push({
      count,
      span,
      cardScale: result.cardScale,
      focusGap: result.focusGap,
      farGap: result.farGap,
      ratio: result.focusGap / result.farGap,
      strip: result.farGap / (result.cardScale * RENDER_CARD)
    });
  }
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */
console.log('\nHand-row fisheye layout probe\n');
console.log(
  '  ' +
    ['row', 'n', 'cardScale', 'span', 'focusGap', 'farGap', 'ratio'].map((h, i) => h.padEnd(i === 0 ? 20 : 12)).join('')
);
for (const entry of matrix) {
  console.log(
    '  ' +
      entry.row.padEnd(20) +
      String(entry.count).padEnd(12) +
      entry.cardScale.toFixed(3).padEnd(12) +
      entry.span.toFixed(3).padEnd(12) +
      entry.focusGap.toFixed(4).padEnd(12) +
      entry.farGap.toFixed(4).padEnd(12) +
      entry.ratio.toFixed(2)
  );
}

// The renderer's own geometry: how the row behaves as the hand grows.
console.log('\n  3D hand row (span 6.4u budget, 0.63u cards, cursor centred)\n');
console.log(
  '  ' +
    ['n', 'rowSpan', 'cardScale', 'focusGap', 'farGap', 'ratio', 'far strip']
      .map((h, i) => h.padEnd(i === 0 ? 6 : 12))
      .join('')
);
for (const entry of rendererRows) {
  console.log(
    '  ' +
      String(entry.count).padEnd(6) +
      entry.span.toFixed(3).padEnd(12) +
      entry.cardScale.toFixed(3).padEnd(12) +
      entry.focusGap.toFixed(4).padEnd(12) +
      entry.farGap.toFixed(4).padEnd(12) +
      entry.ratio.toFixed(2).padEnd(12) +
      `${(entry.strip * 100).toFixed(0)}%`
  );
}

// A concrete pitch profile, so the shape of the fisheye is visible in the log.
for (const focusX of [0, 0.5, 1]) {
  const result = handLayout({ count: 20, containerWidth: 6.4, cardWidth: 0.63, focusX, focusStrength: 1 });
  const bars = result.pitches
    .map(p => Math.max(1, Math.round((p / result.maxPitch) * 30)))
    .map(n => '#'.repeat(n))
    .join('\n      ');
  console.log(`\n  n=20, cursor at ${focusX.toFixed(2)} — pitch profile (${result.cardScale.toFixed(3)}× card size)`);
  console.log('      ' + bars);
}

console.log(
  `\n  bell: sigma(n) = ${[5, 20, 50].map(n => `${n}→${handFocusSigma(n).toFixed(2)}`).join(', ')}` +
    ` | k(n) = ${[5, 20, 50].map(n => `${n}→${handFocusAmplitude(n).toFixed(2)}`).join(', ')}`
);

if (failures.length) {
  console.log(`\n  ✗ ${failures.length} failure(s)\n`);
  for (const failure of failures.slice(0, 40)) console.log(`    - ${failure}`);
  if (failures.length > 40) console.log(`    … ${failures.length - 40} more`);
  process.exitCode = 1;
} else {
  const cases = ROWS.length * COUNTS.length * CURSORS.length + 60 * 3;
  console.log(`\n  ✓ hand layout holds across ${cases} configurations (fill, fisheye, uniform, hover, renderer)\n`);
}
