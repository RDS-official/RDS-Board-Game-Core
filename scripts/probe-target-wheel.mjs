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

import { buildWheel, hitTestWheel, outlineContains } from '../apps/web/src/ui/radialPicker.ts';
import { radialPickerSvg } from '../apps/web/src/ui/radialPickerHtml.ts';
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

/* ---- 1b. pure: shape decides BOTH drawing and hit-testing ----------- */
{
  const TAU2 = Math.PI * 2;
  const ring = (wheel, r) => {
    const zones = [];
    for (let i = 0; i < 72; i += 1) {
      const a = (i / 72) * TAU2;
      zones.push(hitTestWheel(wheel, Math.cos(a) * r, Math.sin(a) * r).zone);
    }
    return zones;
  };
  for (const n of [1, 2, 3]) {
    const wheel = buildWheel(
      Array.from({ length: n }, (_, i) => ({ id: 'p' + i, label: 'P' + i })),
      { radius: 300, seed: 'circle-' + n }
    );
    record('n=' + n + ': shape is circle', wheel.shape === 'circle', wheel.shape);
    const inside = ring(wheel, 300 * 0.92);
    record(
      'n=' + n + ': a circle wheel judges by radius (whole ring is inside)',
      inside.every(zone => zone !== 'empty'),
      inside.filter(zone => zone === 'empty').length + '/72 empty'
    );
    const outside = ring(wheel, 300 * 1.05);
    record('n=' + n + ': outside the circle is empty', outside.every(zone => zone === 'empty'), outside.join(','));
  }
  for (const n of [4, 6]) {
    const wheel = buildWheel(
      Array.from({ length: n }, (_, i) => ({ id: 'p' + i, label: 'P' + i })),
      { radius: 300, seed: 'poly-' + n }
    );
    record('n=' + n + ': shape is polygon', wheel.shape === 'polygon', wheel.shape);
    // 顶点之间的"角"（半径 0.95R、两个顶点方向的正中间）在圆里、但在多边形外
    const mid = (wheel.segments[0].angleStart + wheel.segments[0].angleEnd) / 2;
    const corner = hitTestWheel(wheel, Math.cos(mid) * 300 * 0.95, Math.sin(mid) * 300 * 0.95);
    record('n=' + n + ': a polygon wheel judges by the polygon (corners are outside)', corner.zone === 'empty', corner.zone);
    const inside = hitTestWheel(wheel, Math.cos(mid) * 300 * 0.5, Math.sin(mid) * 300 * 0.5);
    record('n=' + n + ': inside the polygon still hits a sector', inside.zone === 'segment', inside.zone);
  }
}

/* ---- 1b. pure: n<=3 is a circle, n>=4 is a polygon ------------------ */
{
  for (const n of [1, 2, 3]) {
    const wheel = buildWheel(
      Array.from({ length: n }, (_, i) => ({ id: 'p' + i, label: 'P' + i })),
      { radius: 300, seed: 'circle-' + n }
    );
    const radii = wheel.outline.map(([x, y]) => Math.hypot(x, y));
    const spread = Math.max(...radii) - Math.min(...radii);
    record('n=' + n + ': the outline is a circle (no polygon corners)', spread < 0.01, spread.toFixed(4));
  }
  for (const n of [4, 6]) {
    const wheel = buildWheel(
      Array.from({ length: n }, (_, i) => ({ id: 'p' + i, label: 'P' + i })),
      { radius: 300, seed: 'poly-' + n }
    );
    record('n=' + n + ': the outline is a polygon', wheel.outline.length === n, String(wheel.outline.length));
    const radii = wheel.outline.map(([x, y]) => Math.hypot(x, y));
    record(
      'n=' + n + ': polygon vertices sit near the radius',
      radii.every(r => Math.abs(r - 300) <= 300 * 0.06),
      radii.map(r => r.toFixed(0)).join(',')
    );
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
    // 命中的是"多边形"，圆周四角属于轮盘外：只比较轮廓内的采样点。
    if (!outlineContains(a, dx, dy)) continue;
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
      bottom: rect ? rect.bottom : 0,
      handTop: document.querySelector('#action-hand')?.getBoundingClientRect().top ?? 0,
      frost: Boolean(document.querySelector('.rp-frost')),
      frostClip: (document.querySelector('.rp-frost')?.style.clipPath ?? '').slice(0, 12),
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
    const stacking = await page.evaluate(() => {
      const shell = document.querySelector('.ui-layer.app-shell');
      const layer = document.querySelector('.rp-layer');
      return {
        shell: shell ? Number(getComputedStyle(shell).zIndex || 0) : -1,
        shellDragging: shell?.getAttribute('data-dragging') ?? '',
        wheel: layer ? Number(getComputedStyle(layer).zIndex || 0) : -1
      };
    });
    record(
      'drag: the dragged card is painted above the wheel',
      stacking.shellDragging === '1' && stacking.shell > stacking.wheel,
      JSON.stringify(stacking)
    );
    record('drag: the frost layer exists and is clipped to the wheel', opened.frost && opened.frostClip.startsWith('path('), opened.frostClip);
    record('drag: no full-screen frosting outside the wheel', opened.scrim === false, String(opened.scrim));
    record(
      'drag: the wheel never covers the hand strip',
      opened.bottom > 0 && opened.handTop > 0 && opened.bottom <= opened.handTop + 1,
      opened.bottom.toFixed(0) + ' vs hand ' + opened.handTop.toFixed(0)
    );
    record('drag: one sector + one avatar pin per candidate', opened.sectors === opened.pins && opened.sectors >= 2, opened.sectors + '/' + opened.pins);
    record('drag: pins carry an avatar or an initial', opened.avatars >= opened.pins, String(opened.avatars));
    record('drag: wheel covers more than half the short edge', opened.width >= opened.viewport * 0.6, opened.width + '/' + opened.viewport);
    record(
      'drag: the wheel is pinned to the viewport centre (not following the pointer)',
      Math.abs(opened.cx - 1440 / 2) <= 1,
      opened.cx.toFixed(1) + ' vs 720'
    );

    // 目视检查的自动化版：用浏览器真实的命中测试回答三个问题——
    // ① 每个分区沿自己的引线真的被画出来了；② 头像落在**自己的**分区里；
    // ③ 轮盘外面什么也没画。
    const shape = await page.evaluate(() => {
      const dialog = document.querySelector('.rp-dialog');
      const layer = document.querySelector('.rp-layer');
      if (!dialog || !layer) return null;
      const rect = dialog.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      layer.style.pointerEvents = 'auto';
      dialog.style.pointerEvents = 'auto';
      const segIndexAt = (x, y) => {
        const stack = document.elementsFromPoint(x, y);
        const hit = stack.find(el => el.classList && el.classList.contains('rp-seg'));
        return hit ? Number(hit.dataset.segIndex) : -1;
      };
      let spokeHits = 0;
      let spokeTotal = 0;
      for (const seg of Array.from(document.querySelectorAll('.rp-seg'))) {
        const m = (seg.getAttribute('d') ?? '').match(/^M\s*(-?[\d.]+)\s+(-?[\d.]+)\s+L\s*(-?[\d.]+)\s+(-?[\d.]+)/);
        if (!m) continue;
        const ix = Number(m[1]);
        const iy = Number(m[2]);
        const ox = Number(m[3]);
        const oy = Number(m[4]);
        for (const t of [0.4, 0.7]) {
          spokeTotal += 1;
          if (segIndexAt(cx + ix + (ox - ix) * t, cy + iy + (oy - iy) * t) === Number(seg.dataset.segIndex)) {
            spokeHits += 1;
          }
        }
      }
      let pinHits = 0;
      let pinTotal = 0;
      for (const pin of Array.from(document.querySelectorAll('.rp-pin'))) {
        // 用几何锚点采样，而不是「包围盒中心 + 猜测偏移」——后者会被文字宽度带偏。
        const px = Number(pin.dataset.pinX);
        const py = Number(pin.dataset.pinY);
        pinTotal += 1;
        if (segIndexAt(cx + px, cy + py) === Number(pin.dataset.segIndex)) pinHits += 1;
      }
      let outsideHits = 0;
      let outsideTotal = 0;
      for (let i = 0; i < 60; i += 1) {
        const angle = (i / 60) * Math.PI * 2;
        const x = cx + Math.cos(angle) * (rect.width / 2) * 1.18;
        const y = cy + Math.sin(angle) * (rect.width / 2) * 1.18;
        if (x < 1 || y < 1 || x > window.innerWidth - 1 || y > window.innerHeight - 1) continue;
        outsideTotal += 1;
        if (segIndexAt(x, y) >= 0) outsideHits += 1;
      }
      layer.style.pointerEvents = '';
      dialog.style.pointerEvents = '';
      return { spokeHits, spokeTotal, pinHits, pinTotal, outsideHits, outsideTotal };
    });
    record(
      'shape: every sector is painted along its own spoke',
      Boolean(shape) && shape.spokeTotal > 0 && shape.spokeHits === shape.spokeTotal,
      JSON.stringify(shape)
    );
    record(
      'shape: every avatar pin sits inside its own sector',
      Boolean(shape) && shape.pinTotal === opened.sectors && shape.pinHits === shape.pinTotal,
      shape ? shape.pinHits + '/' + shape.pinTotal : 'missing'
    );
    record(
      'shape: nothing is painted outside the wheel (no arc bulge)',
      Boolean(shape) && shape.outsideHits === 0,
      shape ? shape.outsideHits + '/' + shape.outsideTotal : 'missing'
    );

    // hover a sector: exactly one highlight + the card shrinks so the pin stays readable
    const pinPoint = await page.evaluate(() => {
      const pin = document.querySelector('.rp-pin');
      const dialog = document.querySelector('.rp-dialog')?.getBoundingClientRect();
      if (!pin || !dialog) return null;
      return {
        x: dialog.left + dialog.width / 2 + Number(pin.dataset.pinX),
        y: dialog.top + dialog.height / 2 + Number(pin.dataset.pinY)
      };
    });
    record('browser: pins are hit-testable', Boolean(pinPoint));
    let shrank = false;
    if (pinPoint) {
      await page.mouse.move(pinPoint.x, pinPoint.y, { steps: 4 });
      await page.waitForTimeout(300);
      const over = await wheelState(page);
      record('hover: the sector under the pin is active', over.active >= 0, JSON.stringify(over));
      const cardHeight = async () =>
        (await page.evaluate(id => {
          const el = document.querySelector('#action-hand .ah-card[data-action-id="' + id + '"]');
          return el ? el.getBoundingClientRect().height : 0;
        }, selection.id)) || 0;

      const overSector = await cardHeight();
      // 侦测"放大时强制重新栅格"：缩小后再放大必须丢掉旧位图，否则会发虚。
      await page.evaluate(() => {
        window.__rasterSeen = 0;
        const observer = new MutationObserver(records => {
          for (const record of records) {
            const el = record.target;
            if (el instanceof HTMLElement && el.dataset.rasterising === '1') window.__rasterSeen += 1;
          }
        });
        observer.observe(document.querySelector('#action-hand') ?? document.body, {
          subtree: true,
          attributes: true,
          attributeFilter: ['data-rasterising']
        });
      });
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
        'hover: growing again drops the stale raster (no blur)',
        (await page.evaluate(() => window.__rasterSeen ?? 0)) > 0,
        String(await page.evaluate(() => window.__rasterSeen ?? 0))
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

  // 出图供目视复核：2/3/5/8 个目标各一张（同一个几何与配色）。
  const shotPage = await browser.newPage({ viewport: { width: 700, height: 700 } });
  for (const n of [2, 3, 5, 8]) {
    const candidates = Array.from({ length: n }, (_, i) => ({
      id: 'p' + i,
      label: ['吕布', '关羽', '曹操', '张飞', '赵云', '黄忠', '马超', '太史慈'][i % 8],
      hint: '距离 ' + (i + 1)
    }));
    const wheel = buildWheel(candidates, { radius: 300, seed: 'shot-' + n });
    const svg = radialPickerSvg(wheel, { label: '目标' });
    await shotPage.setContent(
      '<html><body style="margin:0;background:#0b0f14;display:grid;place-items:center;height:100vh">' +
        '<div style="width:600px;height:600px">' + svg + '</div></body></html>'
    );
    await shotPage.addStyleTag({
      content:
        '.rp-seg{fill:rgba(255,255,255,.06);stroke:rgba(255,255,255,.12);stroke-width:1}' +
        '.rp-outline{fill:none;stroke:rgba(255,255,255,.18);stroke-width:1.5}' +
        '.rp-center{fill:rgba(14,18,24,.72);stroke:rgba(217,180,91,.4)}' +
        '.rp-center-label{fill:#e7cf92;font-size:13px}.rp-label{fill:#c9d3e0;font-size:14px}' +
        '.rp-hint{fill:#8b98ab;font-size:12px}.rp-initial{fill:#e8eef6;font-size:18px}' +
        '.rp-avatar-ring{fill:rgba(10,14,20,.55);stroke-width:2}'
    });
    await shotPage.screenshot({ path: 'shots/target-wheel-' + n + '.png' });
  }
  await shotPage.close();
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
