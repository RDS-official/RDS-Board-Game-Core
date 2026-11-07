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

/* ---- 4. browser: hover / drag / drop / echo / held cards ------------ */
const dev = await ensureSoloServer();
const browser = await launchChromium();

/** 一张牌的可测几何：pivot（底边中点）随指针走，不受缩放影响。 */
const GEOM = () =>
  Array.from(document.querySelectorAll('#action-hand .ah-card')).map(el => {
    const r = el.getBoundingClientRect();
    return {
      id: el.dataset.actionId,
      mode: el.dataset.targetMode,
      cx: r.left + r.width / 2,
      cy: r.top + r.height / 2,
      bx: r.left + r.width / 2,
      by: r.bottom,
      height: r.height
    };
  });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(dev.url + '?game=betrayal&scenario=exploration&unified-hand', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });
  await page.waitForTimeout(4200);
  if (await page.locator('#boot-enter').count()) await page.click('#boot-enter').catch(() => {});
  await page.waitForTimeout(1400);

  const boxes = () => page.evaluate(GEOM);
  /** 先 hover，等弧线稳住，再取坐标：否则抓的是"让位前"的位置。 */
  const settleOn = async id => {
    let card = (await boxes()).find(c => c.id === id);
    if (!card) return null;
    await page.mouse.move(card.cx, card.cy);
    await page.waitForTimeout(240);
    card = (await boxes()).find(c => c.id === id) ?? card;
    return card;
  };
  const draggedGeometry = () =>
    page.evaluate(() => {
      const el = document.querySelector('#action-hand [data-drag="1"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        id: el.dataset.actionId,
        bx: r.left + r.width / 2,
        by: r.bottom,
        height: r.height,
        z: Number(getComputedStyle(el).zIndex || 0),
        viewport: window.innerHeight
      };
    });

  const base = await boxes();
  record('browser: cards mounted', base.length >= 3, String(base.length));
  record(
    'browser: physics layer active',
    await page.evaluate(() => document.querySelector('#action-hand')?.dataset.physics === '1')
  );
  record(
    'browser: no CSS transform transition (@@single-writer@@)',
    await page.evaluate(() => {
      const el = document.querySelector('#action-hand .ah-card');
      return el ? getComputedStyle(el).transitionProperty.includes('transform') === false : false;
    })
  );

  /* ---- hover ---- */
  const mid = base[Math.floor(base.length / 2)];
  await page.mouse.move(mid.cx, mid.cy);
  await page.waitForTimeout(300);
  const hovered = await boxes();
  const hoveredMid = hovered.find(c => c.id === mid.id);
  record('hover: card lifts >= 8px', hoveredMid.cy <= mid.cy - 8, (mid.cy - hoveredMid.cy).toFixed(1));
  record('hover: card scales up', hoveredMid.height > mid.height + 1, (hoveredMid.height - mid.height).toFixed(1));
  const neighbour = hovered.find(c => c.id !== mid.id);
  const neighbourBase = base.find(c => c.id === neighbour.id);
  record(
    'hover: neighbour yields sideways',
    Math.abs(neighbour.cx - neighbourBase.cx) >= 1.5,
    (neighbour.cx - neighbourBase.cx).toFixed(1)
  );
  record(
    'hover: the grown card draws above its neighbours',
    await page.evaluate(({ x, y }) => {
      const under = document.elementFromPoint(x, y)?.closest('.ah-card');
      if (!under) return false;
      const mine = Number(getComputedStyle(under).zIndex || 0);
      const others = Array.from(document.querySelectorAll('#action-hand .ah-card'))
        .filter(el => el !== under)
        .map(el => Number(getComputedStyle(el).zIndex || 0));
      return others.every(z => z < mine);
    }, { x: mid.cx, y: mid.cy }),
    'z-order'
  );
  await page.mouse.move(20, 200);
  await page.waitForTimeout(420);
  const rest = await boxes();
  record(
    'hover: returns to the arc',
    Math.abs(rest.find(c => c.id === mid.id).cy - mid.cy) <= 1.5,
    (rest.find(c => c.id === mid.id).cy - mid.cy).toFixed(1)
  );

  /* ---- drag: tracking, viewport scale, top layer, drop highlight ---- */
  const selection = rest.find(c => c.mode === 'selection');
  record('browser: a selection card exists', Boolean(selection));
  if (selection) {
    const grab = (await settleOn(selection.id)) ?? selection;
    await page.mouse.move(grab.cx, grab.cy);
    await page.waitForTimeout(120);
    await page.mouse.down();
    await page.mouse.move(grab.cx + 12, grab.cy - 12, { steps: 2 }); // 越过 slop，进入 dragging
    await page.waitForTimeout(120);
    const started = await draggedGeometry();
    await page.mouse.move(grab.cx + 60, grab.cy - 150, { steps: 6 });
    await page.waitForTimeout(200);
    const moved = await draggedGeometry();
    const state = await page.evaluate(() => ({
      state: document.querySelector('#action-hand')?.dataset.state,
      drop: document.querySelector('#action-hand')?.dataset.drop
    }));

    record('drag: state machine enters dragging', state.state === 'dragging', JSON.stringify(state));
    record('drag: board hit sets data-drop=valid', state.drop === 'valid', String(state.drop));
    record(
      'drag: card tracks the pointer 1:1',
      Boolean(started && moved) &&
        Math.abs(moved.bx - started.bx - 48) <= 6 &&
        Math.abs(moved.by - started.by + 138) <= 6,
      moved && started ? (moved.bx - started.bx).toFixed(1) + ',' + (moved.by - started.by).toFixed(1) : 'missing'
    );
    const ratio = moved ? moved.height / moved.viewport : 0;
    record(
      'drag: card grows to ~1/3 of the viewport height',
      ratio > 0.28 && ratio < 0.42,
      ratio.toFixed(2)
    );
    record('drag: dragged card is on top', Boolean(moved) && moved.z >= 2500, String(moved?.z));

    await page.mouse.up();
    await page.waitForTimeout(950);
    const back = (await boxes()).find(c => c.id === selection.id);
    record(
      'drop: non-playable card springs home',
      Boolean(back) &&
        Math.abs(back.bx - selection.bx) <= 3 &&
        Math.abs(back.by - selection.by) <= 3,
      back ? (back.bx - selection.bx).toFixed(1) + ',' + (back.by - selection.by).toFixed(1) : 'missing'
    );
    record('drop: the target picker opened instead', (await page.locator('.rp-dialog').count()) === 1);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }

  /* ---- drag a directly playable card: it leaves the hand + echoes ---- */
  await page.waitForTimeout(250);
  const playable = (await boxes()).find(c => c.mode === 'none' || c.mode === 'highlight');
  record('browser: a directly playable card exists', Boolean(playable));
  if (playable) {
    const grab = (await settleOn(playable.id)) ?? playable;
    await page.mouse.move(grab.cx, grab.cy);
    await page.waitForTimeout(120);
    await page.mouse.down();
    await page.mouse.move(grab.cx, grab.cy - 180, { steps: 6 });
    await page.waitForTimeout(120);
    await page.mouse.up();
    // 出牌成功的直接证据是"飞场"：状态机进入 flying，卡片朝桌面落点缩小淡出。
    // （不能只看 DOM 是否还在——同一个动作 id 打完可能立刻又被投影出来。）
    let flew = false;
    for (let i = 0; i < 20; i += 1) {
      flew = await page.evaluate(() => document.querySelector('#action-hand')?.dataset.state === 'flying');
      if (flew) break;
      await page.waitForTimeout(60);
    }
    record('drop: the played card flies onto the table', flew, 'state=flying');
    await page.waitForTimeout(500);
    const echo = await page.evaluate(() => {
      const el = document.querySelector('.hand-play-echo');
      return el
        ? { title: el.querySelector('.hpe-title')?.textContent ?? '', actor: el.querySelector('.hpe-actor')?.textContent ?? '' }
        : null;
    });
    record('play: a table echo announces the card', Boolean(echo) && (echo.title ?? '').length > 0, JSON.stringify(echo));
    record(
      'play: the action actually ran',
      await page.evaluate(() => {
        const snapshot = window.__boardGameApp?.session?.getSnapshot?.();
        return (snapshot?.board?.actionLog?.length ?? 0) > 0 || (snapshot?.actions?.length ?? 0) > 0;
      })
    );
  }

  await page.screenshot({ path: 'shots/card-hand-physics.png' });
  await page.close();

  /* ---- poker: hole cards are held, not actions, and must still show ---- */
  const poker = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await poker.goto(dev.url + '?game=poker&unified-hand', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await poker.waitForTimeout(4200);
  if (await poker.locator('#boot-enter').count()) await poker.click('#boot-enter').catch(() => {});
  await poker.waitForTimeout(1600);
  for (let i = 0; i < 12; i += 1) {
    const dealt = await poker.evaluate(
      () => (window.__boardGameApp?.session?.getSnapshot?.()?.board?.ownHand?.length ?? 0) > 0
    );
    if (dealt) break;
    await poker.waitForTimeout(1000);
  }
  const held = await poker.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('#action-hand .ah-card.ah-held'));
    return {
      total: document.querySelectorAll('#action-hand .ah-card').length,
      held: cards.length,
      withArt: cards.filter(card => Boolean(card.querySelector('img.ah-art'))).length,
      arts: cards.map(card => (card.querySelector('img.ah-art')?.getAttribute('src') ?? '').slice(0, 12)),
      ownHand: window.__boardGameApp?.session?.getSnapshot?.()?.board?.ownHand?.length ?? 0,
      actions: window.__boardGameApp?.session?.getSnapshot?.()?.actions?.length ?? 0
    };
  });
  record('poker: hole cards are rendered in the hand', held.held >= 2, JSON.stringify(held));
  record('poker: hole cards use the real card face', held.withArt === held.held, held.arts.join(','));
  record('poker: held cards sit alongside the action cards', held.total > held.held, String(held.total));
  await poker.close();
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
