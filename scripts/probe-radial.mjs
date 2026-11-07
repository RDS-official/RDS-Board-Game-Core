/**
 * Radial target-picker geometry probe.
 *
 * Guards `apps/web/src/ui/radialPicker.ts` — the jittered polygon + centre
 * circle the drag-time target chooser draws and hit-tests. Pure, no browser.
 *
 * Proves:
 *   1. Shape: n segments; vertex angles strictly increasing; widths positive and
 *      summing to 2π (no inverted or overlapping sector).
 *   2. Bounds: vertex radii stay within the declared jitter band; inner radius
 *      is exactly radius·innerRatio.
 *   3. Determinism: identical options → identical geometry (seeded jitter).
 *   4. Hit-test parity: a sample inside each sector resolves to that segment, the
 *      centre resolves to 'center', and overshoot still lands on an angle sector.
 *   5. Degenerates: one candidate → one segment; none → empty.
 *
 * Run: node scripts/probe-radial.mjs   (or `pnpm probe:radial`)
 */

import { buildWheel, hitTestWheel } from '../apps/web/src/ui/radialPicker.ts';

const failures = [];
function check(ok, msg) {
  if (!ok) failures.push(msg);
  return ok;
}
function eq(a, b, msg) {
  return check(a === b, `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function close(a, b, tol = 1e-6) {
  return check(Math.abs(a - b) <= tol, `${a} ≉ ${b} (tol ${tol})`);
}

const TAU = Math.PI * 2;
const CANDS = [
  { id: 'alice', label: 'Alice' },
  { id: 'bob', label: 'Bob' },
  { id: 'carol', label: 'Carol' },
  { id: 'dave', label: 'Dave' },
  { id: 'erin', label: 'Erin' },
];

const R = 200;
const OPTS = { radius: R, innerRatio: 0.34, jitterRadius: 0.12, jitterAngle: 0.18, seed: 'probe' };
const wheel = buildWheel(CANDS, OPTS);

/* ---- 1. shape ------------------------------------------------------ */
eq(wheel.count, CANDS.length, 'segment count');
eq(wheel.segments.length, CANDS.length, 'segments length');
let sumWidth = 0;
for (let i = 0; i < wheel.segments.length; i++) {
  const s = wheel.segments[i];
  const width = s.angleEnd - s.angleStart;
  check(width > 0, `segment ${i} has positive width (${width})`);
  sumWidth += width;
  if (i > 0) check(s.angleStart > wheel.segments[i - 1].angleStart, `segment ${i} angle increases`);
  eq(s.candidate.id, CANDS[i].id, `segment ${i} candidate id`);
  check(
    typeof s.path === 'string' && s.path.startsWith('M ') && s.path.trimEnd().endsWith('Z'),
    `segment ${i} path`,
  );
}
close(sumWidth, TAU, 1e-9);

/* ---- 2. bounds ----------------------------------------------------- */
close(wheel.innerRadius, R * 0.34);
const lo = R * (1 - 0.12);
const hi = R * (1 + 0.12);
for (const s of wheel.segments) {
  check(
    s.outerRadiusStart >= lo - 1e-6 && s.outerRadiusStart <= hi + 1e-6,
    `outer r start in band (${s.outerRadiusStart})`,
  );
  check(
    s.outerRadiusEnd >= lo - 1e-6 && s.outerRadiusEnd <= hi + 1e-6,
    `outer r end in band (${s.outerRadiusEnd})`,
  );
  // label sits between inner and outer
  const lr = Math.hypot(s.label[0], s.label[1]);
  check(lr > wheel.innerRadius && lr < R, `label radius between inner and outer (${lr})`);
}

/* ---- 3. determinism ------------------------------------------------ */
const again = buildWheel(CANDS, OPTS);
const same = wheel.segments.every((s, i) => {
  const t = again.segments[i];
  return (
    close(s.angleStart, t.angleStart) &&
    close(s.angleEnd, t.angleEnd) &&
    close(s.outerRadiusStart, t.outerRadiusStart)
  );
});
check(same, 'same seed → identical geometry');

/* ---- 4. hit-test parity -------------------------------------------- */
// centre
eq(hitTestWheel(wheel, 0, 0).zone, 'center', 'origin is centre');
eq(hitTestWheel(wheel, wheel.innerRadius * 0.5, 0).zone, 'center', 'inside inner circle is centre');

// each sector sampled at its mid-angle, mid radius
for (const s of wheel.segments) {
  const mid = (s.angleStart + s.angleEnd) / 2;
  const r = (wheel.innerRadius + R) / 2;
  const hit = hitTestWheel(wheel, r * Math.cos(mid), r * Math.sin(mid));
  eq(hit.zone, 'segment', `mid of ${s.candidate.id} is a segment`);
  if (hit.zone === 'segment') {
    eq(hit.index, s.index, `mid of ${s.candidate.id} → index ${s.index}`);
    eq(hit.candidate.id, s.candidate.id, `mid of ${s.candidate.id} → candidate`);
  }

  // overshoot far outside still resolves to the same angle sector
  const far = 5 * R;
  const farHit = hitTestWheel(wheel, far * Math.cos(mid), far * Math.sin(mid));
  eq(farHit.zone, 'segment', `overshoot of ${s.candidate.id} still hits`);
  if (farHit.zone === 'segment') eq(farHit.index, s.index, `overshoot of ${s.candidate.id} same index`);
}

// just inside the start edge of each sector maps to that sector
for (const s of wheel.segments) {
  const edge = s.angleStart + (s.angleEnd - s.angleStart) * 0.02;
  const r = (wheel.innerRadius + R) / 2;
  const hit = hitTestWheel(wheel, r * Math.cos(edge), r * Math.sin(edge));
  eq(hit.zone, 'segment', `edge of ${s.candidate.id} hits a segment`);
  if (hit.zone === 'segment') eq(hit.index, s.index, `edge of ${s.candidate.id} → index`);
}

// every segment is reachable (no dead sector) over a dense angle sweep
const reached = new Set();
for (let k = 0; k < 720; k++) {
  const a = (k / 720) * TAU;
  const hit = hitTestWheel(wheel, R * Math.cos(a), R * Math.sin(a));
  if (hit.zone === 'segment') reached.add(hit.index);
}
eq(reached.size, wheel.count, 'every sector reachable by some angle');

/* ---- 5. degenerates ------------------------------------------------ */
const one = buildWheel([{ id: 'solo', label: 'Solo' }], { radius: 100 });
eq(one.count, 1, 'single candidate count');
eq(hitTestWheel(one, 80, 0).zone, 'segment', 'single candidate always segment outside centre');
const none = buildWheel([], { radius: 100 });
eq(none.count, 0, 'empty count');
eq(hitTestWheel(none, 50, 0).zone, 'empty', 'empty hit');
eq(none.segments.length, 0, 'empty segments');

// 8 candidates keep strictly increasing angles under max jitter
const eight = buildWheel(
  Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, label: `P${i}` })),
  { radius: R, jitterAngle: 0.45 },
);
let inc = true;
for (let i = 1; i < eight.segments.length; i++) {
  if (!(eight.segments[i].angleStart > eight.segments[i - 1].angleStart)) inc = false;
}
check(inc, '8-way max jitter keeps angles increasing');

/* ---- report -------------------------------------------------------- */
if (failures.length > 0) {
  console.error(`✗ probe:radial — ${failures.length} failure(s)`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(
  `✓ probe:radial — shape, bounds, determinism, hit parity, degenerates all green (n=${wheel.count})`,
);
