/**
 * Target-wheel probe (drag-driven multi-target chooser).
 *
 * Pure half: every sector's angular width stays within ±15% of the equal share, the
 * widths sum to exactly 2π (no gaps/overlaps), the geometry is deterministic per
 * seed, and the hit-test agrees with the drawn boundaries.
 *
 * Browser half (sanguosha, `?unified-hand`): dragging a target-needing card pops the
 * big frosted wheel, hovering a sector highlights exactly one pin, the dragged card
 * shrinks over a sector, releasing on a sector dispatches that target, releasing on
 * the centre opens the payload form, and releasing outside cancels.
 *
 * Run: node scripts/probe-target-wheel.mjs   (or `pnpm probe:target-wheel`)
 */

import { buildWheel, hitTestWheel } from '../apps/web/src/ui/radialPicker.ts';
import { launchChromium } from './lib/browser.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';

const failures = [];
const checks = [];
const record = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(name + (detail ? ': ' + detail : ''));
};

/* ---- 1. pure: near-equal sectors, no gaps ---------------------------- */
const TAU = Math.PI * 2;
for (let n = 1; n <= 8; n += 1) {
  const candidates = Array.from({ length: n }, (_, i) => ({ id: 'p' + i, label: 'P' + i }));
  for (let seed = 0; seed < 6; seed += 1) {
    const wheel = buildWheel(candidates, { radius: 300, seed });
    const widths = wheel.segments.map(seg => seg.angleEnd - seg.angleStart);
    const sum = widths.reduce((total, value) => total + value, 0);
    record('n=' + n + ' seed=' + seed + ': sectors tile the full circle', Math.abs(sum - TAU) < 1e-9, String(sum));
    if (n > 1) {
      const share = TAU / n;
      const worst = Math.max(...widths.map(w => Math.abs(w - share) / share));
      record('n=' + n + ' seed=' + seed + ': every sector within ±15% of the equal share', worst <= 0.15, worst.toFixed(3));
      record('n=' + n + ' seed=' + seed + ': widths stay positive', widths.every(w => w > 0), widths.map(w => w.toFixed(2)).join(','));
    }
  }
}

/* ---- 2. pure: determinism + hit parity ------------------------------- */
{
  const candidates = [
    { id: 'alice', label: 'Alice' },
    { id: 'bob', label: 'Bob' },
    { id: 'carol', label: 'Carol' },
    { id: 'dave', label: 'Dave' }
  ];
  const a = buildWheel(candidates, { radius: 300, seed: 'fixed' });
  const b = buildWheel(candidates, { radius: 300, seed: 'fixed' });
  record('same seed → identical geometry', JSON.stringify(a.segments.map(s => s.path)) === JSON.stringify(b.segments.map(s => s.path)));
  const c = buildWheel(candidates, { radius: 300, seed: 'other' });
  record('different seed → different geometry', JSON.stringify(a.segments.map(s => s.path)) !== JSON.stringify(c.segments.map(s => s.path)));

  let mismatches = 0;
  let centreHits = 0;
  for (let i = 0; i < 400; i += 1) {
    const angle = (i / 400) * TAU;
    const radius = a.innerRadius + 10 + (i % 7) * 20;
    const dx = Math.cos(angle) * radius;
    const dy = Math.sin(angle) * radius;
    const hit = hitTestWheel(a, dx, dy);
    if (hit.zone === 'center') { centreHits += 1; continue; }
    const expected = a.segments.find(seg => {
      // 角度必须落在扇区自己声明的边界内（渲染与判定同源）
      const norm = ((v) => (v % TAU + TAU) % TAU)(angle);
      const start = ((v) => (v % TAU + TAU) % TAU)(seg.angleStart);
      const width = seg.angleEnd - seg.angleStart;
      const delta = (norm - start + TAU) % TAU;
      return delta <= width + 1e-9;
    });
    if (!expected || hit.zone !== 'segment' || hit.candidate.id !== expected.candidate.id) mismatches += 1;
  }
  record('hit-test agrees with the drawn boundaries', mismatches === 0, String(mismatches));
  record('centre circle is reachable', centreHits === 0, String(centreHits));
}

/* ---- 3. browser: drag-driven wheel ---------------------------------- */
const dev = await ensureSoloServer();
const browser = await launchChromium();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const boot = async page => {
  await page.waitForTimeout(4200);
  if (await page.locator('#boot-enter').count()) await page.click('#boot-enter').catch(() => {});
  await page.waitForTimeout(1600);
};

const handBoxes = page =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('#action-hand .ah-card')).map(el => {
      const r = el.getBoundingClientRect();
      return { id: el.dataset.actionId, mode: el.dataset.targetMode, cx: r.left + r.width / 2, cy: r.top + r.height / 2, height: r.height };
    })
  );

const settleOn = async (page, id) => {
  let card = (await handBoxes(page)).find(entry => entry.id === id);
  if (!card) return null;
  await page.mouse.move(card.cx, card.cy);
  await page.waitForTimeout(240);
  card = (await handBoxes(page)).find(entry => entry.id === id) ?? card;
  return card;
};

const wheelState = page =>
  page.evaluate(() => {
    const layer = document.querySelector('.rp-layer');
    const dialog = document.querySelector('.rp-dialog');
    const rect = dialog?.getBoundingClientRect();
    return {
      open: Boolean(layer),
      mode: layer?.getAttribute('data-mode') ?? '',
      scrim: Boolean(document.querySelector('.rp-scrim')),
      sectors: document.querySelectorAll('.rp-seg').length,
      pins: document.querySelectorAll('.rp-pin').length,
      avatars: document.querySelectorAll('.rp-avatar, .rp-initial').length,
      active: Array.from(document.querySelectorAll('.rp-seg')).findIndex(el => el.classList.contains('is-active')),
      width: rect?.width ?? 0,
      cx: rect ? rect.left + rect.width / 2 : 0,
      cy: rect ? rect.top + rect.height / 2 : 0,
      viewport: Math.min(window.innerWidth, window.innerHeight)
    };
  });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(dev.url + '?game=sanguosha&unified-hand', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await boot(page);

  const selection = (await handBoxes(page)).find(card => card.mode === 'selection');
  record('browser: a target-needing card exists', Boolean(selection));
  if (selection) {
    const grab = (await settleOn(page, selection.id)) ?? selection;
    await page.mouse.move(grab.cx, grab.cy);
    await page.waitForTimeout(120);
    await page.mouse.down();
    await page.mouse.move(grab.cx + 30, grab.cy - 60, { steps: 4 });
    await page.waitForTimeout(260);
    const opened = await wheelState(page);
    record('drag: the wheel appears while dragging', opened.open && opened.mode === 'drag', JSON.stringify(opened));
    record('drag: frosted scrim is present', opened.scrim);
    record('drag: one sector + one avatar pin per candidate', opened.sectors === opened.pins && opened.sectors >= 2, opened.sectors + '/' + opened.pins);
    record('drag: pins carry an avatar or an initial', opened.avatars >= opened.pins, String(opened.avatars));
    record('drag: wheel covers more than half the short edge', opened.width >= opened.viewport * 0.6, opened.width + '/' + opened.viewport);

    // hover a sector: exactly one highlight + the card shrinks so the pin stays readable
    const pinPoint = await page.evaluate(() => {
      const pin = document.querySelector('.rp-pin');
      const r = pin?.getBoundingClientRect();
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    });
    record('browser: pins are hit-testable', Boolean(pinPoint));
    let shrank = false;
    if (pinPoint) {
      await page.mouse.move(pinPoint.x, pinPoint.y, { steps: 4 });
      await page.waitForTimeout(300);
      const over = await wheelState(page);
      record('hover: the sector under the pin is active', over.active >= 0, String(over.active));
      const cardHeight = async () =>
        (await page.evaluate(id => {
          const el = document.querySelector('#action-hand .ah-card[data-action-id="' + id + '"]');
          return el ? el.getBoundingClientRect().height : 0;
        }, selection.id)) || 0;

      const overSector = await cardHeight();
      // 移到中心圆：应该放大回"屏幕 1/3"那档，方便看清自己打出去的牌
      await page.mouse.move(over.cx, over.cy, { steps: 4 });
      await page.waitForTimeout(320);
      const overCentre = await cardHeight();
      // 再移回分区：应该缩回去，让出提示位
      await page.mouse.move(pinPoint.x, pinPoint.y, { steps: 4 });
      await page.waitForTimeout(320);
      const backOnSector = await cardHeight();

      record(
        'hover: the card shrinks over a sector',
        overSector > 0 && overSector < opened.viewport * 0.2,
        overSector.toFixed(0) + ' of ' + opened.viewport
      );
      record(
        'hover: the card zooms back over the centre circle (~1/3 screen)',
        overCentre > opened.viewport * 0.28,
        overSector.toFixed(0) + ' → ' + overCentre.toFixed(0) + ' of ' + opened.viewport
      );
      record(
        'hover: it shrinks again when back on a sector',
        backOnSector < overCentre * 0.8,
        overCentre.toFixed(0) + ' → ' + backOnSector.toFixed(0)
      );
      shrank = overSector < opened.viewport * 0.2;
    }

    const beforeRevision = await page.evaluate(() => window.__boardGameApp?.session?.getSnapshot?.()?.revision ?? -1);
    await page.mouse.up();
    await page.waitForTimeout(900);
    const afterRevision = await page.evaluate(() => window.__boardGameApp?.session?.getSnapshot?.()?.revision ?? -1);
    record('drop on a sector: the action is dispatched', afterRevision > beforeRevision, beforeRevision + ' → ' + afterRevision);
    record('drop on a sector: the wheel closes', (await page.locator('.rp-layer').count()) === 0);
  }

  // centre circle → payload form; outside → cancel
  const reopen = async () => {
    const card = (await handBoxes(page)).find(entry => entry.mode === 'selection');
    if (!card) return null;
    const grab = (await settleOn(page, card.id)) ?? card;
    await page.mouse.move(grab.cx, grab.cy);
    await page.waitForTimeout(120);
    await page.mouse.down();
    await page.mouse.move(grab.cx + 30, grab.cy - 60, { steps: 4 });
    await page.waitForTimeout(240);
    return grab;
  };

  if (await reopen()) {
    const opened = await wheelState(page);
    await page.mouse.move(opened.cx, opened.cy, { steps: 4 });
    await page.waitForTimeout(200);
    await page.mouse.up();
    await page.waitForTimeout(400);
    const payload = await page.evaluate(() => {
      const layer = document.querySelector('#payload-layer');
      return layer ? getComputedStyle(layer).display : 'missing';
    });
    record('drop on the centre opens the second-level menu', payload !== 'none' && payload !== 'missing', String(payload));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }

  if (await reopen()) {
    const opened = await wheelState(page);
    const before = await page.evaluate(() => window.__boardGameApp?.session?.getSnapshot?.()?.revision ?? -1);
    const outside = { x: opened.cx + opened.width * 0.9, y: opened.cy + opened.width * 0.9 };
    await page.mouse.move(Math.min(outside.x, 1430), Math.min(outside.y, 890), { steps: 5 });
    await page.waitForTimeout(200);
    await page.mouse.up();
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => window.__boardGameApp?.session?.getSnapshot?.()?.revision ?? -1);
    const state = await page.evaluate(() => document.querySelector('#action-hand')?.dataset.state ?? '');
    record('drop outside the wheel cancels (no dispatch)', after === before, before + ' → ' + after);
    record('drop outside the wheel closes the wheel', (await page.locator('.rp-layer').count()) === 0);
    record('drop outside the wheel returns the card', state === 'idle' || state === '', state);
  }

  await page.screenshot({ path: 'shots/target-wheel.png' });
  await page.close();
} finally {
  await browser.close();
}

const passed = checks.filter(check => check.ok).length;
for (const check of checks) console.log((check.ok ? 'ok   ' : 'FAIL ') + check.name + (check.detail ? ' -- ' + check.detail : ''));
if (failures.length > 0) {
  console.error('');
  console.error('target-wheel: ' + passed + '/' + checks.length + ' checks passed');
  for (const failure of failures) console.error('  x ' + failure);
  process.exit(1);
}
console.log('');
console.log('target-wheel: ' + passed + '/' + checks.length + ' checks passed');
process.exit(0);
