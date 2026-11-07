/**
 * Card-hand physics probe (ui/cardHand).
 *
 * Two halves, one command:
 *
 *   Pure (no browser): arcLayout never overflows / never degenerates, the spring
 *   integrator converges and stays stable for ugly dt, cubic-bezier hits both
 *   endpoints, and the play-zone polygon agrees with its padding/hysteresis rules.
 *
 *   Browser: hover lifts and scales the card without moving its neighbours' base,
 *   neighbours yield sideways, a drag tracks the pointer 1:1, dragging into the
 *   board highlight toggles data-drop, and releasing a non-playable card springs it
 *   back to its slot instead of leaving it stuck under the cursor.
 *
 * Run: node scripts/probe-card-hand.mjs   (or `pnpm probe:card-hand`)
 */

import { arcLayout, DEFAULT_ARC_LAYOUT } from '../apps/web/src/ui/cardHand/layout.ts';
import { springStep, dampingRatio } from '../apps/web/src/ui/cardHand/spring.ts';
import { cubicBezier, HOVER_EASE } from '../apps/web/src/ui/cardHand/easing.ts';
import {
  pointInPolygon,
  pointInPolygonWithPadding,
  polygonCentroid,
  rectPolygon
} from '../apps/web/src/ui/cardHand/polygon.ts';
import { launchChromium } from './lib/browser.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';

const failures = [];
const checks = [];
const record = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(name + (detail ? ': ' + detail : ''));
};

/* ---- 1. pure: arc layout ------------------------------------------- */
const width = 900;
for (const count of [1, 2, 5, 12, 30]) {
  const slots = arcLayout(count, { handWidth: width });
  record('layout(' + count + '): one slot per card', slots.length === count, String(slots.length));
  const minX = Math.min(...slots.map(s => s.x));
  const maxX = Math.max(...slots.map(s => s.x));
  record(
    'layout(' + count + '): inside the strip',
    minX >= -width / 2 && maxX <= width / 2,
    minX + '..' + maxX
  );
  record(
    'layout(' + count + '): finite numbers',
    slots.every(s => [s.x, s.y, s.rotationDeg, s.scale, s.z].every(Number.isFinite)),
    ''
  );
  record(
    'layout(' + count + '): centre card sits highest',
    slots[Math.floor(count / 2)].y <= Math.min(...slots.map(s => s.y)) + 0.001,
    ''
  );
}
{
  const ordered = arcLayout(9, { handWidth: width });
  record('layout: x is monotone', ordered.every((slot, i) => i === 0 || slot.x > ordered[i - 1].x));
  const narrow = arcLayout(30, { handWidth: 360 });
  record(
    'layout: 30 cards in a phone strip shrink instead of overflowing',
    Math.max(...narrow.map(s => s.x)) <= 180.5 && Math.min(...narrow.map(s => s.scale)) < 1,
    ''
  );
  record('layout: defaults are documented', DEFAULT_ARC_LAYOUT.minSpacing > 0 && DEFAULT_ARC_LAYOUT.minSpacing < DEFAULT_ARC_LAYOUT.spacing);
}

/* ---- 2. pure: spring + easing -------------------------------------- */
{
  const config = { stiffness: 240, damping: 26, mass: 1 };
  record('spring: under-damped for a physical feel', dampingRatio(config) > 0.5 && dampingRatio(config) < 1, String(dampingRatio(config).toFixed(2)));
  const state = { value: 0, velocity: 0 };
  let settledAt = -1;
  for (let i = 0; i < 240; i += 1) {
    if (springStep(state, 100, config, 1 / 60) && settledAt < 0) settledAt = i;
  }
  record('spring: converges onto the target', Math.abs(state.value - 100) < 0.01, String(state.value));
  record('spring: settles within ~0.8s at 60fps', settledAt >= 0 && settledAt <= 50, String(settledAt));
  const ugly = { value: 0, velocity: 0 };
  springStep(ugly, 100, config, 2.5); // 切回标签页时的巨大 dt
  record('spring: survives a 2.5s frame without exploding', Number.isFinite(ugly.value) && Math.abs(ugly.value) <= 400, String(ugly.value));
  record('easing: cubic-bezier endpoints', Math.abs(HOVER_EASE(0)) < 1e-6 && Math.abs(HOVER_EASE(1) - 1) < 1e-6);
  const mid = HOVER_EASE(0.5);
  record('easing: front-loaded (fast start, soft landing)', mid > 0.55 && mid < 1, String(mid.toFixed(3)));
  const identity = cubicBezier(0.0, 0.0, 1.0, 1.0);
  record('easing: linear control points are identity', Math.abs(identity(0.37) - 0.37) < 1e-3, String(identity(0.37).toFixed(3)));
}

/* ---- 3. pure: play-zone polygon ------------------------------------ */
{
  const square = rectPolygon({ left: 0, top: 0, right: 100, bottom: 100 });
  record('polygon: inside is inside', pointInPolygon({ x: 50, y: 50 }, square));
  record('polygon: outside is outside', !pointInPolygon({ x: 150, y: 50 }, square));
  record('polygon: padding catches a near miss', pointInPolygonWithPadding({ x: 104, y: 50 }, square, 8));
  record('polygon: padding does not swallow a far miss', !pointInPolygonWithPadding({ x: 140, y: 50 }, square, 8));
  const centre = polygonCentroid(square);
  record('polygon: centroid of a square', Math.abs(centre.x - 50) < 0.01 && Math.abs(centre.y - 50) < 0.01);
}

/* ---- 4. browser: hover / yield / drag / spring back ----------------- */
const dev = await ensureSoloServer();
const browser = await launchChromium();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(dev.url + '?game=betrayal&scenario=exploration&unified-hand', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4200);
  if (await page.locator('#boot-enter').count()) await page.click('#boot-enter').catch(() => {});
  await page.waitForTimeout(1400);

  const boxes = async () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('#action-hand .ah-card')).map(el => {
        const r = el.getBoundingClientRect();
        return { id: el.dataset.actionId, mode: el.dataset.targetMode, left: r.left, top: r.top, width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
      })
    );

  const base = await boxes();
  record('browser: cards mounted', base.length >= 3, String(base.length));
  record('browser: physics layer active', await page.evaluate(() => document.querySelector('#action-hand')?.dataset.physics === '1'));
  record('browser: no CSS transform transition (@@single-writer@@)', await page.evaluate(() => {
    const el = document.querySelector('#action-hand .ah-card');
    return el ? getComputedStyle(el).transitionProperty.includes('transform') === false : false;
  }));

  // hover the middle card
  const mid = base[Math.floor(base.length / 2)];
  await page.mouse.move(mid.cx, mid.cy);
  await page.waitForTimeout(280);
  const hovered = await boxes();
  const hoveredMid = hovered.find(c => c.id === mid.id);
  record('hover: card lifts >= 8px', hoveredMid.top <= mid.top - 8, (mid.top - hoveredMid.top).toFixed(1));
  record('hover: card scales up', hoveredMid.width > mid.width + 1, (hoveredMid.width - mid.width).toFixed(1));
  const neighbour = hovered.find(c => c.id !== mid.id && Math.abs(c.cx - mid.cx) < 400);
  const neighbourBase = base.find(c => c.id === neighbour.id);
  record(
    'hover: neighbour yields sideways',
    Math.abs(neighbour.cx - neighbourBase.cx) >= 1.5,
    (neighbour.cx - neighbourBase.cx).toFixed(1)
  );

  // leave the strip: everything returns
  await page.mouse.move(20, 200);
  await page.waitForTimeout(420);
  const rest = await boxes();
  const restMid = rest.find(c => c.id === mid.id);
  record('hover: returns to the arc', Math.abs(restMid.top - mid.top) <= 1.5, (restMid.top - mid.top).toFixed(1));

  // drag a selection card onto the board: it must spring back, not stick
  const selection = rest.find(c => c.mode === 'selection');
  record('browser: a selection card exists', Boolean(selection));
  if (selection) {
    await page.mouse.move(selection.cx, selection.cy);
    await page.waitForTimeout(120);
    await page.mouse.down();
    await page.mouse.move(selection.cx + 60, selection.cy - 150, { steps: 6 });
    await page.waitForTimeout(120);
    const dragging = await page.evaluate(() => ({
      state: document.querySelector('#action-hand')?.dataset.state,
      drop: document.querySelector('#action-hand')?.dataset.drop,
      drag: document.querySelector('#action-hand [data-drag="1"]') !== null
    }));
    record('drag: state machine enters dragging', dragging.state === 'dragging', JSON.stringify(dragging));
    record('drag: card is marked as dragging', dragging.drag, JSON.stringify(dragging));
    record('drag: board hit sets data-drop=valid', dragging.drop === 'valid', String(dragging.drop));
    const moved = (await boxes()).find(c => c.id === selection.id);
    record(
      'drag: card tracks the pointer 1:1',
      Math.abs(moved.cx - (selection.cx + 60)) <= 14 && Math.abs(moved.cy - (selection.cy - 150)) <= 14,
      (moved.cx - selection.cx).toFixed(1) + ',' + (moved.cy - selection.cy).toFixed(1)
    );
    await page.mouse.up();
    await page.waitForTimeout(950);
    const after = await boxes();
    const back = after.find(c => c.id === selection.id);
    record(
      'drop: non-playable card springs home',
      back && Math.abs(back.cx - selection.cx) <= 2 && Math.abs(back.cy - selection.cy) <= 2,
      back ? (back.cx - selection.cx).toFixed(1) + ',' + (back.cy - selection.cy).toFixed(1) : 'missing'
    );
    record(
      'drop: the target picker opened instead',
      (await page.locator('.rp-dialog').count()) === 1
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(160);
  }

  // drag a directly playable card onto the board: it must leave the hand
  await page.waitForTimeout(200);
  const releasable = (await boxes()).find(c => c.mode === 'none' || c.mode === 'highlight');
  record('browser: a directly playable card exists', Boolean(releasable));
  if (releasable) {
    const before = (await boxes()).length;
    await page.mouse.move(releasable.cx, releasable.cy);
    await page.waitForTimeout(100);
    await page.mouse.down();
    await page.mouse.move(releasable.cx, releasable.cy - 180, { steps: 6 });
    await page.waitForTimeout(120);
    await page.mouse.up();
    await page.waitForTimeout(900);
    const after = (await boxes()).length;
    record('drop: playable card leaves the hand', after < before || after === 0, before + ' -> ' + after);
    record(
      'drop: the action actually ran',
      await page.evaluate(() => {
        const snapshot = window.__boardGameApp?.session?.getSnapshot?.();
        return (snapshot?.board?.actionLog?.length ?? 0) > 0 || (snapshot?.actions?.length ?? 0) > 0;
      })
    );
  }

  await page.screenshot({ path: 'shots/card-hand-physics.png' });
  await page.close();
} finally {
  await browser.close();
}

const passed = checks.filter(c => c.ok).length;
for (const c of checks) console.log((c.ok ? 'ok   ' : 'FAIL ') + c.name + (c.detail ? ' -- ' + c.detail : ''));
if (failures.length > 0) {
  console.error('');
  console.error('card-hand: ' + passed + '/' + checks.length + ' checks passed');
  for (const f of failures) console.error('  x ' + f);
  process.exit(1);
}
console.log('');
console.log('card-hand: ' + passed + '/' + checks.length + ' checks passed');
process.exit(0);
