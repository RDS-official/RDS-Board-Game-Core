/**
 * Responsive audit for the board-game shell.
 *
 * Drives the real Vite app in headless Chromium at the viewport matrix from
 * docs/UI-RESPONSIVE-PLAN.md, starts a poker hand, and records panel geometry,
 * clipping, overlaps, panel coverage and screenshots.
 *
 * Run: node scripts/probe-responsive-audit.mjs
 *
 * It intentionally does NOT assert a pass/fail threshold: this is a discovery
 * probe for the redesign. The JSON contract is stable enough for a future gate
 * (the plan proposes thresholds in docs/UI-RESPONSIVE-PLAN.md §6).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { launchChromium } from './lib/browser.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = path.join(ROOT, 'shots', 'responsive');
const FULL_JSON = path.join(OUT_DIR, 'responsive-audit.json');

const VIEWPORTS = [
  { name: 'iphone-se-portrait', width: 320, height: 568, dsf: 2, isMobile: true },
  { name: 'iphone-13-portrait', width: 390, height: 844, dsf: 3, isMobile: true },
  { name: 'iphone-13-landscape', width: 844, height: 390, dsf: 3, isMobile: true },
  { name: 'android-portrait', width: 412, height: 915, dsf: 1, isMobile: true },
  { name: 'android-landscape', width: 915, height: 412, dsf: 1, isMobile: true },
  { name: 'ipad-portrait', width: 768, height: 1024, dsf: 1, isMobile: false },
  { name: 'ipad-landscape', width: 1024, height: 768, dsf: 1, isMobile: false },
  { name: 'ipad-pro-11', width: 1180, height: 820, dsf: 1, isMobile: false },
  { name: 'hd-laptop', width: 1280, height: 720, dsf: 1, isMobile: false },
  { name: 'laptop-1366', width: 1366, height: 768, dsf: 1, isMobile: false },
  { name: 'laptop-1440', width: 1440, height: 900, dsf: 1, isMobile: false },
  { name: 'fhd-desktop', width: 1920, height: 1080, dsf: 1, isMobile: false },
  { name: 'ultrawide', width: 2560, height: 1080, dsf: 1, isMobile: false },
  { name: 'ipad-portrait-tall', width: 1024, height: 1366, dsf: 1, isMobile: false }
];

const SELECTORS = {
  topbar: '.topbar',
  rail: '#player-rail',
  side: '#side-column',
  dock: '#action-dock',
  hand: '#hand-slot',
  board: '#canvas-container',
  announce: '#announce',
  payload: '.payload-layer',
  feed: '.activity-feed',
  ranking: '.chip-ranking',
  observers: '.observer-rail',
  room: '.room-card',
  minimap: '.mansion-minimap'
};

const MEASURE_OPTIONS = {
  vw: 0,
  vh: 0,
  selectors: SELECTORS,
  textSelectors: ['.pc', '.rank-row', '.act'],
  extraTextSelectors: ['.cr-row', '.ob-row']
};

/**
 * Runs in the page. All returned numbers are CSS pixels from the live layout.
 * A panel is "rendered" only if it and every ancestor are display/visibility
 * visible; a closed drawer therefore reports rendered:false even though it
 * still has a transform-derived bounding box.
 */
function collectReport(options) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const round = (value) => Math.round(value * 10) / 10;
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return {
      x: round(r.x),
      y: round(r.y),
      w: round(r.width),
      h: round(r.height),
      right: round(r.right),
      bottom: round(r.bottom)
    };
  };
  const rendered = (el) => {
    if (!el) return false;
    let node = el;
    while (node && node.nodeType === 1) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      node = node.parentElement;
    }
    return true;
  };
  const visibleRectFor = (el, rect) => {
    let left = Math.max(rect.x, 0);
    let top = Math.max(rect.y, 0);
    let right = Math.min(rect.right, vw);
    let bottom = Math.min(rect.bottom, vh);
    let node = el.parentElement;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      const clipsX = style.overflowX !== 'visible';
      const clipsY = style.overflowY !== 'visible';
      if (clipsX || clipsY) {
        const r = node.getBoundingClientRect();
        if (clipsX) {
          left = Math.max(left, r.left);
          right = Math.min(right, r.right);
        }
        if (clipsY) {
          top = Math.max(top, r.top);
          bottom = Math.min(bottom, r.bottom);
        }
      }
      node = node.parentElement;
    }
    if (right <= left || bottom <= top) return null;
    return {
      x: round(left),
      y: round(top),
      w: round(right - left),
      h: round(bottom - top),
      right: round(right),
      bottom: round(bottom)
    };
  };
  const areaOf = (r) => Math.max(0, r.w) * Math.max(0, r.h);
  const fullyInViewport = (rect, visibleRect, isRendered) =>
    !!visibleRect &&
    isRendered &&
    Math.abs(visibleRect.w - rect.w) < 1 &&
    Math.abs(visibleRect.h - rect.h) < 1;

  const panels = {};
  const visibilityInfo = new Map();
  for (const [key, selector] of Object.entries(options.selectors)) {
    const el = document.querySelector(selector);
    if (!el) {
      panels[key] = { selector, exists: false, rendered: false, inViewport: false, rect: null, visibleRect: null };
      continue;
    }
    const style = getComputedStyle(el);
    const rect = rectOf(el);
    const isRendered = rendered(el);
    const visibleRect = isRendered ? visibleRectFor(el, rect) : null;
    const visibleFraction = rect.w * rect.h > 0 ? areaOf(visibleRect ?? { w: 0, h: 0 }) / (rect.w * rect.h) : 0;
    visibilityInfo.set(el, { rendered: isRendered, visibleRect });
    panels[key] = {
      selector,
      exists: true,
      display: style.display,
      visibility: style.visibility,
      opacity: Number(style.opacity),
      rendered: isRendered,
      inViewport: !!visibleRect,
      fullyInViewport: fullyInViewport(rect, visibleRect, isRendered),
      rect,
      visibleRect,
      visibleFraction: Number(visibleFraction.toFixed(3)),
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      clippedX: el.scrollWidth > el.clientWidth + 1,
      clippedY: el.scrollHeight > el.clientHeight + 1
    };
  }
  const onScreen = (el) => {
    if (!rendered(el)) return false;
    const cached = visibilityInfo.get(el);
    return cached ? !!cached.visibleRect : !!visibleRectFor(el, rectOf(el));
  };

  const textClipping = {};
  for (const selector of [...options.textSelectors, ...options.extraTextSelectors]) {
    const all = [...document.querySelectorAll(selector)];
    const visible = all.filter((el) => onScreen(el) && el.getBoundingClientRect().width > 0.5);
    const clipped = visible.filter(
      (el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1
    );
    textClipping[selector] = {
      total: all.length,
      visible: visible.length,
      clipped: clipped.length,
      items: clipped.slice(0, 8).map((el) => {
        const r = el.getBoundingClientRect();
        return {
          className: String(el.className || el.tagName).slice(0, 80),
          text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
          w: round(r.width),
          h: round(r.height),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight
        };
      })
    };
  }

  const cardMetrics = (() => {
    const cards = [...document.querySelectorAll('.pc')].filter((el) => rendered(el));
    const names = cards.map((el) => {
      const name = el.querySelector('.pc-name');
      if (!name) return null;
      const r = name.getBoundingClientRect();
      const lineHeight = Number.parseFloat(getComputedStyle(name).lineHeight) || 0;
      return {
        text: (name.textContent || '').trim(),
        width: round(r.width),
        height: round(r.height),
        scrollWidth: name.scrollWidth,
        clientWidth: name.clientWidth,
        truncated: name.scrollWidth > name.clientWidth + 1,
        lineHeight: round(lineHeight),
        lines: lineHeight > 0 ? Math.round(r.height / lineHeight) : null
      };
    });
    const scoreLabels = cards.map((el) => {
      const label = el.querySelector('.pc-score span');
      if (!label) return null;
      const r = label.getBoundingClientRect();
      const lineHeight = Number.parseFloat(getComputedStyle(label).lineHeight) || 0;
      return {
        text: (label.textContent || '').trim(),
        width: round(r.width),
        height: round(r.height),
        scrollWidth: label.scrollWidth,
        clientWidth: label.clientWidth,
        truncated: label.scrollWidth > label.clientWidth + 1,
        lineHeight: round(lineHeight),
        lines: lineHeight > 0 ? Math.round(r.height / lineHeight) : null
      };
    });
    return {
      count: cards.length,
      widths: cards.map((el) => round(el.getBoundingClientRect().width)),
      heights: cards.map((el) => round(el.getBoundingClientRect().height)),
      names,
      scoreLabels
    };
  })();

  const actionMetrics = (() => {
    const acts = [...document.querySelectorAll('#action-dock .act')].filter((el) => {
      if (!rendered(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0.5 && r.height > 0.5;
    });
    const fan = document.querySelector('#action-dock .dock-fan');
    const fanRect = fan ? fan.getBoundingClientRect() : null;
    return {
      visible: acts.length,
      fullyInViewport: acts.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left >= -0.5 && r.right <= vw + 0.5 && r.top >= -0.5 && r.bottom <= vh + 0.5;
      }).length,
      uniqueX: new Set(acts.map((el) => Math.round(el.getBoundingClientRect().x * 10) / 10)).size,
      rects: acts.slice(0, 10).map((el) => {
        const r = el.getBoundingClientRect();
        return {
          label: (el.querySelector('.act-label')?.textContent || el.getAttribute('aria-label') || el.title || '')
            .trim()
            .slice(0, 24),
          x: round(r.x),
          y: round(r.y),
          w: round(r.width),
          h: round(r.height)
        };
      }),
      fan: fan
        ? {
            x: round(fanRect.x),
            y: round(fanRect.y),
            w: round(fanRect.width),
            h: round(fanRect.height),
            scrollWidth: fan.scrollWidth,
            clientWidth: fan.clientWidth
          }
        : null
    };
  })();

  const overlapFor = (first, second) => {
    const a = panels[first];
    const b = panels[second];
    if (!a?.visibleRect || !b?.visibleRect || !a.rendered || !b.rendered) {
      return { area: 0, w: 0, h: 0, rect: null, visible: false };
    }
    const left = Math.max(a.visibleRect.x, b.visibleRect.x);
    const top = Math.max(a.visibleRect.y, b.visibleRect.y);
    const right = Math.min(a.visibleRect.right, b.visibleRect.right);
    const bottom = Math.min(a.visibleRect.bottom, b.visibleRect.bottom);
    if (right <= left || bottom <= top) {
      return { area: 0, w: 0, h: 0, rect: null, visible: false };
    }
    const w = round(right - left);
    const h = round(bottom - top);
    return {
      area: Math.round(w * h),
      w,
      h,
      rect: { x: round(left), y: round(top), w, h },
      visible: true
    };
  };
  const overlapPairs = {
    'dock×rail': overlapFor('dock', 'rail'),
    'dock×side': overlapFor('dock', 'side'),
    'dock×hand': overlapFor('dock', 'hand'),
    'dock×board': overlapFor('dock', 'board'),
    'topbar×board': overlapFor('topbar', 'board')
  };

  const coverageKeys = ['topbar', 'rail', 'side', 'dock', 'hand', 'announce', 'payload'];
  const covered = coverageKeys.filter((key) => panels[key]?.rendered && panels[key].inViewport);
  const coveredArea = covered.reduce((sum, key) => sum + areaOf(panels[key].visibleRect), 0);
  const coverage = {
    panels: covered,
    sumArea: Math.round(coveredArea),
    ratio: Number((coveredArea / (vw * vh)).toFixed(4))
  };

  const offscreen = Object.entries(panels)
    .filter(([, panel]) => panel.rendered && panel.rect && (panel.rect.x < -1 || panel.rect.right > vw + 1))
    .map(([key, panel]) => ({
      key,
      left: panel.rect.x,
      right: panel.rect.right,
      vw
    }));

  const touchTargets = (() => {
    const all = [...document.querySelectorAll('button, [role="button"], select, a[href]')];
    const visible = all.filter((el) => {
      if (!rendered(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0.5 && r.height > 0.5;
    });
    const small = visible.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width < 44 || r.height < 44;
    });
    return {
      visible: visible.length,
      under44: small.length,
      examples: small.slice(0, 8).map((el) => {
        const r = el.getBoundingClientRect();
        return {
          className: String(el.className || el.tagName).slice(0, 60),
          label: (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
          w: round(r.width),
          h: round(r.height)
        };
      })
    };
  })();

  return {
    viewport: { w: vw, h: vh, dpr: window.devicePixelRatio },
    document: {
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      bodyScrollWidth: document.body.scrollWidth,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      horizontalOverflow: document.documentElement.scrollWidth - window.innerWidth
    },
    panels,
    textClipping,
    cardMetrics,
    actionMetrics,
    overlapPairs,
    coverage,
    offscreen,
    touchTargets,
    handSlotVisible: !!(panels.hand?.rendered && panels.hand.inViewport)
  };
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function waitForApp(page) {
  await page.waitForFunction(
    () => !!window.__boardGameApp?.session?.getSnapshot && !!document.querySelector('#action-dock'),
    null,
    { timeout: 60000 }
  );
  await page.waitForTimeout(1800);
  const boot = page.locator('#boot-enter');
  if (await boot.count()) {
    await boot.click({ timeout: 5000 }).catch(() => {});
  }
  await page.waitForTimeout(500);
}

async function startPokerHand(page) {
  const started = await page.evaluate(() => {
    const app = window.__boardGameApp;
    const engine = app?.session?.engine;
    if (!engine) return { ok: false, reason: 'engine missing' };
    const active = engine.getActiveActorId?.();
    const legal = active ? engine.getLegalActions?.(active) ?? [] : [];
    const start = legal.find((action) => action.type === 'START_HAND');
    if (!start) return { ok: false, reason: 'START_HAND not legal', active, legal: legal.map((a) => a.type) };
    const result = engine.dispatch({ type: 'START_HAND', playerId: active });
    return { ok: !!result?.ok, active, result };
  });
  if (!started.ok) throw new Error(`could not start a poker hand: ${JSON.stringify(started)}`);
  // The poker action cooldown is intentionally visible in the HUD; wait it out so
  // screenshots show the ordinary post-deal dock rather than the initial overlay.
  await page.waitForTimeout(1800);
  return started;
}

async function clickVisible(page, selector) {
  const locator = page.locator(selector).first();
  if (!(await locator.count())) return false;
  if (!(await locator.isVisible().catch(() => false))) return false;
  await locator.click();
  return true;
}

async function openDrawer(page, which) {
  const toggle = `[data-toggle="${which}"]`;
  let clicked = await clickVisible(page, toggle);
  if (!clicked) {
    clicked = await clickVisible(page, '[data-toggle="menu"]');
    if (clicked) {
      await page.waitForTimeout(180);
      clicked = await clickVisible(page, toggle);
    }
  }
  if (!clicked) return false;
  const panelSelector = which === 'rail' ? '#player-rail' : '#side-column';
  // Transitions can lag behind wall-clock waits when the WebGL scene is busy.
  // Wait on the real rect rather than assuming 180ms is enough.
  await page
    .waitForFunction(
      (selector) => {
        const el = document.querySelector(selector);
        if (!el) return false;
        const style = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return style.visibility === 'visible' && r.width > 0 && r.left > -2 && r.right <= window.innerWidth + 2;
      },
      panelSelector,
      { timeout: 5000 }
    )
    .catch(() => {});
  // The phone/tablet menu is a separate popover from the drawer. Remove only the
  // popover state so the drawer itself is not obscured in the evidence shot.
  await page.evaluate(() => document.querySelector('.topbar')?.removeAttribute('data-menu'));
  await page.waitForTimeout(120);
  return true;
}

async function closeDrawer(page) {
  await page.evaluate(() => {
    const shell = document.querySelector('.ui-layer.app-shell');
    shell?.removeAttribute('data-rail');
    shell?.removeAttribute('data-side');
  });
  await page.waitForTimeout(350);
}

function panelSummary(panel) {
  if (!panel?.exists) return 'missing';
  if (!panel.rendered) return 'hidden';
  const r = panel.rect;
  return `${r.x},${r.y} ${r.w}x${r.h}${panel.inViewport ? '' : ' offscreen'}`;
}

function compactRow(record) {
  const p = record.report.panels;
  return {
    viewport: `${record.viewport.width}x${record.viewport.height}`,
    name: record.name,
    topbarH: p.topbar?.rect?.h ?? null,
    dock: panelSummary(p.dock),
    rail: panelSummary(p.rail),
    side: panelSummary(p.side),
    sideVisible: p.side?.rendered ? `${Math.round(p.side.visibleFraction * 100)}%` : null,
    horizontalOverflow: record.report.document.horizontalOverflow,
    overlaps: Object.fromEntries(
      Object.entries(record.report.overlapPairs).map(([key, value]) => [key, value.area])
    ),
    coverage: `${Math.round(record.report.coverage.ratio * 100)}%`,
    handSlot: record.report.handSlotVisible,
    dockActionVisibility: `${record.report.actionMetrics.fullyInViewport}/${record.report.actionMetrics.visible} (${record.report.actionMetrics.uniqueX} x-positions)`,
    clippedAct: record.report.textClipping['.act']?.clipped ?? 0,
    clippedPc: record.report.textClipping['.pc']?.clipped ?? 0,
    minPcWidth: record.report.cardMetrics.widths.length ? Math.min(...record.report.cardMetrics.widths) : null,
    verdict: record.verdict
  };
}

function verdictFor(report) {
  const p = report.panels;
  const blocking = [];
  if (report.document.horizontalOverflow > 1) blocking.push(`document horizontal overflow ${report.document.horizontalOverflow}px`);
  if (!p.topbar?.inViewport || (p.topbar?.rect?.h ?? 0) < 44) blocking.push('topbar not usable');
  if (!p.dock?.inViewport || (p.dock?.rect?.w ?? 0) < 160) blocking.push('action dock not usable');
  if (report.coverage.ratio > 0.65) blocking.push(`floating coverage ${Math.round(report.coverage.ratio * 100)}%`);
  for (const key of ['dock×rail', 'dock×side', 'dock×hand']) {
    if ((report.overlapPairs[key]?.area ?? 0) > 1000) blocking.push(`${key} overlap ${report.overlapPairs[key].area}px²`);
  }
  if (blocking.length) return `不可用：${blocking.join('；')}`;

  const restricted = [];
  if (!report.handSlotVisible) restricted.push('hand-slot hidden');
  if (report.panels.rail?.rendered && report.panels.rail.clippedY) restricted.push('rail scroll-clipped');
  if (report.panels.side?.rendered && report.panels.side.clippedY) restricted.push('side scroll-clipped');
  if (report.panels.dock?.rendered && report.panels.dock.clippedY) restricted.push('dock scroll-clipped');
  if (report.panels.side?.rendered && report.panels.side.visibleFraction < 0.999) {
    restricted.push(`side ${Math.round((1 - report.panels.side.visibleFraction) * 100)}% offscreen`);
  }
  if (report.coverage.ratio > 0.35) restricted.push(`coverage ${Math.round(report.coverage.ratio * 100)}%`);
  const minPc = report.cardMetrics.widths.length ? Math.min(...report.cardMetrics.widths) : 999;
  if (minPc < 160) restricted.push(`pc ${minPc}px`);
  if (report.textClipping['.pc']?.clipped) restricted.push('pc content clipped');
  if (report.textClipping['.act']?.clipped) restricted.push('act text clipped');
  return restricted.length ? `受限：${restricted.join('；')}` : '可用';
}

async function measurePage(page, options, name, vp, screenshotPath) {
  const report = await page.evaluate(collectReport, options);
  await page.screenshot({ path: screenshotPath });
  return {
    name,
    viewport: { width: vp.width, height: vp.height, dsf: vp.dsf, isMobile: vp.isMobile },
    screenshot: path.relative(ROOT, screenshotPath).replaceAll('\\', '/'),
    report
  };
}

const dev = await ensureSoloServer();
const browser = await launchChromium();
const results = [];

try {
  await mkdir(OUT_DIR, { recursive: true });
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.dsf,
      isMobile: vp.isMobile,
      hasTouch: vp.isMobile
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });

    const name = `${vp.width}x${vp.height}-${slug(vp.name)}`;
    console.log(`\n— ${name}`);
    try {
      await page.goto(`${dev.url}?game=poker&scenario=seats_4`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
      await waitForApp(page);
      const started = await startPokerHand(page);
      await page.evaluate(() => document.fonts?.ready);
      await page.waitForTimeout(250);
      const main = await measurePage(
        page,
        { ...MEASURE_OPTIONS, vw: vp.width, vh: vp.height },
        vp.name,
        vp,
        path.join(OUT_DIR, `${name}.png`)
      );
      main.started = started;
      main.errors = errors;
      main.verdict = verdictFor(main.report);
      results.push(main);

      const supplemental = {};
      if (vp.width < 1200) {
        if (await openDrawer(page, 'side')) {
          const sideReport = await page.evaluate(collectReport, { ...MEASURE_OPTIONS, vw: vp.width, vh: vp.height });
          supplemental.side = {
            panel: sideReport.panels.side,
            children: {
              feed: sideReport.panels.feed,
              ranking: sideReport.panels.ranking,
              observers: sideReport.panels.observers,
              room: sideReport.panels.room,
              minimap: sideReport.panels.minimap
            },
            textClipping: sideReport.textClipping,
            coverage: sideReport.coverage
          };
          await page.screenshot({ path: path.join(OUT_DIR, `${name}-side-open.png`) });
          await closeDrawer(page);
        }

        if (vp.width < 768 && (await openDrawer(page, 'rail'))) {
          const railReport = await page.evaluate(collectReport, { ...MEASURE_OPTIONS, vw: vp.width, vh: vp.height });
          supplemental.rail = {
            panel: railReport.panels.rail,
            textClipping: railReport.textClipping,
            cardMetrics: railReport.cardMetrics,
            coverage: railReport.coverage
          };
          await page.screenshot({ path: path.join(OUT_DIR, `${name}-rail-open.png`) });
          await closeDrawer(page);
        }

        if (vp.width < 768 && (await clickVisible(page, '[data-dock-toggle]'))) {
          await page
            .waitForFunction(
              () => {
                const dock = document.querySelector('#action-dock');
                if (!dock) return false;
                return dock.getAttribute('data-dock') === 'open' && dock.getBoundingClientRect().height > 120;
              },
              null,
              { timeout: 5000 }
            )
            .catch(() => {});
          await page.waitForTimeout(450);
          const dockReport = await page.evaluate(collectReport, { ...MEASURE_OPTIONS, vw: vp.width, vh: vp.height });
          supplemental.dock = {
            panel: dockReport.panels.dock,
            textClipping: dockReport.textClipping,
            actionMetrics: dockReport.actionMetrics,
            coverage: dockReport.coverage
          };
          await page.screenshot({ path: path.join(OUT_DIR, `${name}-dock-open.png`) });
          // A pointermove is also the code path that recomputes the fan. Record it
          // separately so the report distinguishes "first open is broken" from
          // "the row can never lay out at this width".
          const dockRect = dockReport.panels.dock.rect;
          await page.mouse.move(Math.round(dockRect.x + dockRect.w / 2), Math.round(dockRect.y + dockRect.h / 2));
          await page.waitForTimeout(350);
          const moved = await page.evaluate(collectReport, { ...MEASURE_OPTIONS, vw: vp.width, vh: vp.height });
          supplemental.dock.afterPointerMove = moved.actionMetrics;
        }
      }
      main.supplemental = supplemental;
      if (
        supplemental.dock?.actionMetrics &&
        supplemental.dock.actionMetrics.visible > 1 &&
        supplemental.dock.actionMetrics.uniqueX === 1
      ) {
        const dockFailure = `dock 展开后 ${supplemental.dock.actionMetrics.visible} 张动作卡同 x=${supplemental.dock.actionMetrics.rects[0]?.x}`;
        main.verdict = main.verdict.startsWith('不可用：')
          ? main.verdict.replace('不可用：', `不可用：${dockFailure}；`)
          : `不可用：${dockFailure}；${main.verdict.replace('受限：', '')}`;
      }
      main.errors = errors;
      console.log(
        `  ${main.verdict} | topbar ${main.report.panels.topbar?.rect?.h ?? '?'}px | ` +
          `dock ${panelSummary(main.report.panels.dock)} | rail ${panelSummary(main.report.panels.rail)} | ` +
          `side ${panelSummary(main.report.panels.side)} | hOverflow ${main.report.document.horizontalOverflow}px | ` +
          `coverage ${Math.round(main.report.coverage.ratio * 100)}%`
      );
    } catch (error) {
      results.push({
        name,
        viewport: { width: vp.width, height: vp.height, dsf: vp.dsf, isMobile: vp.isMobile },
        fatalError: error instanceof Error ? error.message : String(error),
        errors
      });
      console.error(`  FATAL: ${error instanceof Error ? error.message : error}`);
    } finally {
      await context.close();
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    url: `${dev.url}?game=poker&scenario=seats_4`,
    note: 'All numbers are CSS pixels measured after START_HAND; screenshots are device-pixel images.',
    viewports: results
  };
  await writeFile(FULL_JSON, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const table = results.map((entry) => (entry.fatalError ? { viewport: entry.name, fatalError: entry.fatalError } : compactRow(entry)));
  console.log('\nJSON TABLE');
  console.log(JSON.stringify(table, null, 2));
  console.log(`\nFull evidence: ${path.relative(ROOT, FULL_JSON)}`);

  const fatal = results.filter((entry) => entry.fatalError);
  if (fatal.length) process.exitCode = 1;
} finally {
  await browser.close();
  dev.stop();
}
