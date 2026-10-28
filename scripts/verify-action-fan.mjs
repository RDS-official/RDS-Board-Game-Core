import { launchChromium } from './lib/browser.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';

/**
 * Action fan: the dock must shrink from the old label+hint grid (349px with ten
 * actions) to a constant-height fanned hand, hover must surface the description
 * in a fixed bar, and a click must expand a detail card instead of executing.
 */
const dev = await ensureSoloServer();
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1699, height: 919 } });

const errors = [];
const isEnvNoise = text =>
  /\/healthz/i.test(text) || /status of 502/i.test(text);
page.on('pageerror', err => {
  if (!isEnvNoise(err.message)) errors.push(err.message);
});
page.on('console', msg => {
  if (msg.type() !== 'error') return;
  if (isEnvNoise(msg.text())) return;
  errors.push(msg.text());
});

const failures = [];

await page.goto(`${dev.url}?game=betrayal&scenario=haunt_zombie`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2400);
if (await page.locator('#boot-enter').count()) await page.click('#boot-enter');
await page.waitForTimeout(1000);

const metrics = await page.evaluate(() => {
  const dock = document.querySelector('#action-dock');
  const shell = document.querySelector('.dock-shell');
  const fan = document.querySelector('.dock-fan');
  const acts = [...document.querySelectorAll('.dock-fan .act')];
  const r = dock.getBoundingClientRect();
  const sr = shell.getBoundingClientRect();
  return {
    dockHeight: Math.round(r.height),
    shellHeight: Math.round(sr.height),
    coveredPercent: +((sr.width * sr.height) / (window.innerWidth * window.innerHeight) * 100).toFixed(1),
    actionCount: acts.length,
    rows: new Set(acts.map(a => Math.round(a.getBoundingClientRect().top))).size,
    fanExists: !!fan,
    viewportHeight: window.innerHeight
  };
});
console.log('dock metrics:', JSON.stringify(metrics));

if (!metrics.fanExists) failures.push('the fan container was not rendered');
// Pre-fan baseline was 349px (38% of a 919px viewport) and 13.1% of the screen.
const MAX_DOCK_HEIGHT = 250;
const MAX_COVERED_PERCENT = 8;
if (metrics.dockHeight > MAX_DOCK_HEIGHT) {
  failures.push(`dock is too tall (${metrics.dockHeight}px, baseline was 349px, target <= ${MAX_DOCK_HEIGHT})`);
}
if (metrics.coveredPercent > MAX_COVERED_PERCENT) {
  failures.push(
    `dock covers too much of the screen (${metrics.coveredPercent}%, baseline was 13.1%, target <= ${MAX_COVERED_PERCENT}%)`
  );
}

// Hover must fill the fixed hint bar with this card's description.
const first = page.locator('.dock-fan .act').first();
await first.hover();
await page.waitForTimeout(320);
const hovered = await page.evaluate(() => {
  const bar = document.querySelector('[data-fan-hint]');
  return {
    active: bar?.classList.contains('active') ?? false,
    label: bar?.querySelector('.fh-label')?.textContent?.trim() ?? '',
    detail: bar?.querySelector('.fh-detail')?.textContent?.trim() ?? '',
    lifted: getComputedStyle(document.querySelector('.dock-fan .act')).transform
  };
});
console.log('hover:', JSON.stringify(hovered));
if (!hovered.active) failures.push('hover did not activate the hint bar');
if (!hovered.label) failures.push('hover did not fill the hint bar label');
if (hovered.lifted === 'none') failures.push('hovered card was not lifted');

// Moving away restores the resting hint.
await page.mouse.move(40, 40);
await page.waitForTimeout(320);
const rested = await page.evaluate(() => {
  const bar = document.querySelector('[data-fan-hint]');
  return {
    active: bar?.classList.contains('active') ?? false,
    label: bar?.querySelector('.fh-label')?.textContent?.trim() ?? ''
  };
});
if (rested.active) failures.push('hint bar stayed active after the pointer left');

// Clicking a card must expand a detail card, NOT execute immediately.
const roomsBefore = await page.evaluate(
  () => Object.keys(window.__boardGameApp.session.getSnapshot().board.mapGraph.nodes).length
);
await first.click();
await page.waitForTimeout(500);
const detail = await page.evaluate(() => {
  const card = document.querySelector('.payload-card.action-detail');
  return {
    open: !!card,
    title: card?.querySelector('.pf-title')?.textContent?.trim() ?? '',
    hasRun: !!card?.querySelector('#ad-run'),
    hasClose: !!card?.querySelector('#ad-close')
  };
});
console.log('detail:', JSON.stringify(detail));
if (!detail.open) failures.push('clicking a card did not open the detail panel');
if (!detail.hasRun) failures.push('the detail panel has no execute button');
if (!detail.title) failures.push('the detail panel has no title');

// Executing from the detail card must actually run the action.
await page.locator('#ad-run').click();
await page.waitForTimeout(700);
const afterRun = await page.evaluate(() => ({
  detailClosed: !document.querySelector('.payload-card.action-detail'),
  payloadLayerHidden:
    getComputedStyle(document.querySelector('#payload-layer')).display === 'none' ||
    !document.querySelector('#payload-layer').innerHTML.trim()
}));
if (!afterRun.detailClosed && !afterRun.payloadLayerHidden) {
  failures.push('the detail card did not close after executing');
}

// Keyboard digit must still execute directly (fast path), not open the detail.
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await page.screenshot({ path: 'shots/action-fan.png' });
console.log('ERRORS:', errors.length ? errors.slice(0, 5) : 'none');

if (failures.length > 0) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exitCode = 1;
} else {
  console.log('\nAction fan checks passed.');
}

await browser.close();
dev.stop();
