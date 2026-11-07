/**
 * Action-hand layout probe.
 *
 * Guards `apps/web/src/ui/actionHand.ts` — the fanned view-model the unified
 * action hand will render (docs/INTERACTION-REDESIGN.md §3.3). Pure, no browser.
 *
 * Proves:
 *   1. Count / order: one view card per action, same order, stable.
 *   2. Fill: every card centre sits inside the strip, left→right monotonic.
 *   3. Fan: cards left of centre tilt negative, right tilt positive, |angle| ≤ max.
 *   4. Focus: hovering an index gives it the largest scale and the top z.
 *   5. Badges: intake mode maps to the right corner glyph.
 *   6. Empty hand is a valid empty view; same input is deterministic.
 *
 * Run: node scripts/probe-action-hand.mjs   (or `pnpm probe:action-hand`)
 */

import { layoutActionHand } from '../apps/web/src/ui/actionHand.ts';

const failures = [];
function check(ok, msg) {
  if (!ok) failures.push(msg);
  return ok;
}
function eq(a, b, msg) {
  return check(a === b, `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function close(a, b, tol = 1e-6) {
  return Math.abs(a - b) <= tol;
}

const base = (over = {}) => ({ id: 'a', icon: '✦', label: 'A', hint: '', tone: 'normal', ...over });
const selection = { spec: { min: 1, max: 1 }, candidates: [{ id: 'p', label: 'P' }] };
const amount = { key: 'amount', label: 'Amount', kind: 'number', widget: 'slider', min: 1, max: 9 };

const ACTIONS = [
  base({ id: 'end', actionType: 'END_TURN' }),
  base({ id: 'move', highlightIds: ['n1'] }),
  base({ id: 'hit', selection }),
  base({ id: 'bet', fields: [amount] }),
  base({ id: 'build', placementEntityId: 'slot:1' }),
];

const WIDTH = 900;
const CARD = 96;

/* ---- 1. count + order + 2. fill ------------------------------------ */
const view = layoutActionHand(ACTIONS, { containerWidth: WIDTH, cardWidth: CARD, focusX: 0.5 });
eq(view.count, ACTIONS.length, 'count');
check(
  view.cards.every((c, i) => c.card.id === ACTIONS[i].id && c.index === i),
  'order preserved',
);
const half = WIDTH / 2;
check(
  view.cards.every((c) => c.x >= -half - 1e-6 && c.x <= half + 1e-6),
  'every centre inside the strip',
);
check(
  view.cards.every((c, i) => i === 0 || c.x > view.cards[i - 1].x),
  'centres left→right monotonic',
);

/* ---- 3. fan tilt --------------------------------------------------- */
const maxTilt = 9;
for (const c of view.cards) {
  if (c.x < -1e-6) check(c.angle < 0, `left card ${c.card.id} tilts negative (${c.angle})`);
  else if (c.x > 1e-6) check(c.angle > 0, `right card ${c.card.id} tilts positive (${c.angle})`);
  check(Math.abs(c.angle) <= maxTilt + 1e-6, `card ${c.card.id} tilt within max (${c.angle})`);
}

/* ---- 4. focus gets largest scale + top z --------------------------- */
const HOVER = 2;
const focused = layoutActionHand(ACTIONS, {
  containerWidth: WIDTH,
  cardWidth: CARD,
  focusX: 0.5,
  hoverIndex: HOVER,
});
const fz = focused.cards[HOVER];
check(
  focused.cards.every((c) => c.index === HOVER || c.scale <= fz.scale + 1e-9),
  'hovered card has the largest scale',
);
check(
  focused.cards.every((c) => c.index === HOVER || c.z < fz.z || close(c.z, fz.z)),
  'hovered card sits on top',
);
eq(focused.focusIndex, HOVER, 'focusIndex honours hoverIndex');

/* ---- 5. badges ----------------------------------------------------- */
const badgeBy = Object.fromEntries(view.cards.map((c) => [c.card.id, c.badge]));
eq(badgeBy.end, '', 'end badge');
eq(badgeBy.move, '', 'highlight badge empty');
eq(badgeBy.hit, '◎', 'selection badge');
eq(badgeBy.bet, '#', 'fields badge');
eq(badgeBy.build, '⌖', 'placement badge');

/* ---- 6. empty + determinism ---------------------------------------- */
const empty = layoutActionHand([], { containerWidth: WIDTH, cardWidth: CARD });
eq(empty.count, 0, 'empty count');
eq(empty.focusIndex, null, 'empty focusIndex');
eq(empty.cards.length, 0, 'empty cards');

const a = layoutActionHand(ACTIONS, { containerWidth: WIDTH, cardWidth: CARD, focusX: 0.33 });
const b = layoutActionHand(ACTIONS, { containerWidth: WIDTH, cardWidth: CARD, focusX: 0.33 });
check(
  a.cards.every((c, i) => close(c.x, b.cards[i].x) && close(c.angle, b.cards[i].angle)),
  'deterministic for identical input',
);

/* lockCardWidth path must not throw and must preserve the row. */
const locked = layoutActionHand(ACTIONS, { containerWidth: WIDTH, cardWidth: CARD, lockCardWidth: true });
eq(locked.count, ACTIONS.length, 'lockCardWidth count');
check(
  locked.cards.every((c, i) => i === 0 || c.x > locked.cards[i - 1].x),
  'lockCardWidth monotonic',
);

/* ---- report -------------------------------------------------------- */
if (failures.length > 0) {
  console.error(`✗ probe:action-hand — ${failures.length} failure(s)`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(
  `✓ probe:action-hand — fill, fan, focus, badges, empty, determinism all green (n=${ACTIONS.length})`,
);
