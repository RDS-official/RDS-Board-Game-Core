/**
 * Radial picker markup probe.
 *
 * Guards `apps/web/src/ui/radialPickerHtml.ts`: the SVG the drag-time chooser
 * shows must have one sector + one label per candidate, a tagged centre, and
 * escaped text — and it must reuse the geometry's own path strings.
 *
 * Run: node scripts/probe-radial-html.mjs   (or `pnpm probe:radial-html`)
 */

import { buildWheel } from '../apps/web/src/ui/radialPicker.ts';
import { radialPickerSvg } from '../apps/web/src/ui/radialPickerHtml.ts';

const failures = [];
function check(ok, msg) {
  if (!ok) failures.push(msg);
  return ok;
}
function eq(a, b, msg) {
  return check(a === b, `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function contains(hay, needle, msg) {
  return check(hay.includes(needle), `${msg}: missing ${JSON.stringify(needle)}`);
}
function count(hay, re) {
  return (hay.match(re) || []).length;
}

const CANDS = [
  { id: 'alice', label: 'Alice', color: '#e0b060' },
  { id: 'bob', label: 'Bob' },
  { id: 'carol', label: '<b>C</b>', color: '#88c' },
];
const wheel = buildWheel(CANDS, { radius: 200, seed: 'svg' });
const svg = radialPickerSvg(wheel);

/* one sector per candidate, keyed */
eq(count(svg, /class="rp-seg"/g), CANDS.length, 'one sector path per candidate');
eq(count(svg, /data-candidate-id="/g), CANDS.length, 'candidate id per sector');
for (const c of CANDS) contains(svg, `data-candidate-id="${c.id}"`, `sector for ${c.id}`);

/* geometry path is embedded verbatim (drawing === hit-test shape) */
contains(svg, wheel.segments[0].path, 'first sector reuses geometry path');

/* one label per candidate */
eq(count(svg, /class="rp-label"/g), CANDS.length, 'one label per candidate');

/* centre is tagged */
contains(svg, 'data-zone="center"', 'centre circle tagged');

/* escaping */
check(!svg.includes('<b>C</b>'), 'label markup escaped');
contains(svg, '&lt;b&gt;C&lt;/b&gt;', 'escaped label present');

/* colour style passthrough, and only where a colour exists */
eq(count(svg, /style="--seg:/g), CANDS.filter((c) => c.color).length, 'seg colour only when provided');

/* viewBox spans the wheel */
contains(svg, `viewBox="-200 -200 400 400"`, 'viewBox spans radius');

/* empty wheel → empty string */
eq(radialPickerSvg(buildWheel([], { radius: 100 })), '', 'empty wheel emits nothing');

/* labels can be turned off */
eq(count(radialPickerSvg(wheel, { showLabels: false }), /class="rp-label"/g), 0, 'labels off');

/* ---- report -------------------------------------------------------- */
if (failures.length > 0) {
  console.error(`✗ probe:radial-html — ${failures.length} failure(s)`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`✓ probe:radial-html — sectors, labels, centre, escaping, viewBox all green (n=${wheel.count})`);
