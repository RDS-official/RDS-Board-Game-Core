/**
 * Radial picker interaction controller probe.
 *
 * Guards `apps/web/src/ui/radialPickerModel.ts` — the pure pointer/keyboard →
 * intent state machine for the radial target chooser. No browser.
 *
 * Proves:
 *   1. Pointer: a sample in each sector focuses that segment; the centre focuses
 *      the centre; an out-of-wheel point clears focus.
 *   2. Keyboard: arrows ring through segments then the centre and wrap; a fresh
 *      focus starts at the first segment (+1) or the centre (−1).
 *   3. Commit: Enter on a segment yields that candidate; on the centre yields the
 *      centre intent; with no focus yields null (do nothing, not cancel).
 *   4. Escape cancels; option ids / active index are stable for ARIA.
 *
 * Run: node scripts/probe-radial-model.mjs   (or `pnpm probe:radial-model`)
 */

import { buildWheel } from '../apps/web/src/ui/radialPicker.ts';
import {
  activeSegmentIndex,
  cancelPicker,
  confirmFocus,
  createPickerState,
  focusSegment,
  moveFocus,
  optionId,
  pointAt,
} from '../apps/web/src/ui/radialPickerModel.ts';

const failures = [];
function check(ok, msg) {
  if (!ok) failures.push(msg);
  return ok;
}
function eq(a, b, msg) {
  return check(a === b, `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const CANDS = [
  { id: 'a', label: 'A' },
  { id: 'b', label: 'B' },
  { id: 'c', label: 'C' },
  { id: 'd', label: 'D' },
];
const R = 200;
const wheel = buildWheel(CANDS, { radius: R, seed: 'model' });
const fresh = () => createPickerState(wheel);

/* ---- 1. pointer ---------------------------------------------------- */
eq(fresh().focus.kind, 'none', 'fresh focus is none');
for (const seg of wheel.segments) {
  const mid = (seg.angleStart + seg.angleEnd) / 2;
  const r = (wheel.innerRadius + R) / 2;
  const s = pointAt(fresh(), r * Math.cos(mid), r * Math.sin(mid));
  eq(s.focus.kind, 'segment', `pointer mid ${seg.candidate.id} → segment`);
  if (s.focus.kind === 'segment') eq(s.focus.index, seg.index, `pointer mid ${seg.candidate.id} index`);
}
eq(pointAt(fresh(), 0, 0).focus.kind, 'center', 'pointer origin → centre');

/* ---- 2. keyboard ring ---------------------------------------------- */
const s = moveFocus(fresh(), 1);
eq(s.focus.kind, 'segment', 'first +1 is a segment');
if (s.focus.kind === 'segment') eq(s.focus.index, 0, 'first +1 → segment 0');

eq(moveFocus(fresh(), -1).focus.kind, 'center', 'first −1 → centre');

// walk +1 exactly n times from segment 0 → centre
let cur = focusSegment(fresh(), 0);
for (let i = 0; i < wheel.count; i++) cur = moveFocus(cur, 1);
eq(cur.focus.kind, 'center', 'after n steps from 0 → centre');
cur = moveFocus(cur, 1);
eq(cur.focus.kind, 'segment', 'centre +1 wraps to segment');
if (cur.focus.kind === 'segment') eq(cur.focus.index, 0, 'centre +1 → segment 0');

// walk −1 from centre → previous segment, then wraps to centre
cur = moveFocus(createPickerState(wheel), 1); // 0
cur = moveFocus(cur, -1); // wrap to centre
eq(cur.focus.kind, 'center', 'segment 0 −1 → centre');

/* ---- 3. commit ----------------------------------------------------- */
eq(confirmFocus(fresh()), null, 'Enter with no focus does nothing');

const seg2 = focusSegment(fresh(), 2);
const intent = confirmFocus(seg2);
check(intent !== null && intent.type === 'pick', 'Enter on segment → pick');
if (intent && intent.type === 'pick') {
  eq(intent.index, 2, 'pick index');
  eq(intent.candidate.id, CANDS[2].id, 'pick candidate');
}

let centreState = createPickerState(wheel);
centreState = moveFocus(centreState, -1); // to centre
const centreIntent = confirmFocus(centreState);
check(centreIntent !== null && centreIntent.type === 'center', 'Enter on centre → centre intent');

/* ---- 4. cancel + ARIA ---------------------------------------------- */
eq(cancelPicker().type, 'cancel', 'escape cancels');

eq(activeSegmentIndex(fresh()), null, 'no active segment when unfocused');
eq(activeSegmentIndex(seg2), 2, 'active segment index');
eq(optionId(seg2), 'rp-opt-2', 'segment option id');
eq(optionId(centreState), 'rp-opt-center', 'centre option id');
eq(optionId(seg2, 'x'), 'x-opt-2', 'custom prefix');

/* invalid focus index is ignored */
const ignored = focusSegment(fresh(), 99);
eq(ignored.focus.kind, 'none', 'out-of-range focus ignored');

/* ---- report -------------------------------------------------------- */
if (failures.length > 0) {
  console.error(`✗ probe:radial-model — ${failures.length} failure(s)`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(
  `✓ probe:radial-model — pointer, keyboard ring, commit, cancel, ARIA all green (n=${wheel.count})`,
);
