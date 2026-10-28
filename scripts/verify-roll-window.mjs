import { launchChromium } from './lib/browser.mjs';
import { clickDockAction } from './lib/actions.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';

/**
 * Two-phase check window (K4) in the real UI.
 *
 * A vault check used to spend luck items automatically. Now, when the explorer
 * actually owns one, the check is split into declare → roll → react, and the
 * dock must show each step with a readable label instead of a raw action id.
 */
const dev = await ensureSoloServer();
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const errors = [];
const isEnvNoise = text =>
  /\/healthz/i.test(text) ||
  /Failed to load resource: the server responded with a status of 500/i.test(text) ||
  /Failed to load resource: the server responded with a status of 502/i.test(text);
page.on('pageerror', err => {
  if (!isEnvNoise(err.message)) errors.push(err.message);
});
page.on('console', msg => {
  if (msg.type() !== 'error') return;
  if (isEnvNoise(msg.text())) return;
  errors.push(msg.text());
});

const failures = [];

await page.goto(`${dev.url}?game=betrayal&scenario=room_features`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2400);
if (await page.locator('#boot-enter').count()) await page.click('#boot-enter');
await page.waitForTimeout(1000);

const dockLabels = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.dock-actions .act')].map(el => el.dataset.fanLabel || el.querySelector('.act-label')?.textContent?.trim() || '')
  );

// Give the vault explorer a post-roll luck item so the check has a real choice.
await page.evaluate(() => {
  const app = window.__boardGameApp;
  const engine = app.session.engine;
  const raw = engine.getRawState();
  // Reuse the module's own grant helper through a scenario-free path: push a card
  // straight into the hand zone using the same shape the deck uses.
  const src = Object.values(raw.entities).find(
    e => e?.components?.custom?.defId === 'lucky_stone'
  );
  if (src) {
    const clone = JSON.parse(JSON.stringify(src));
    clone.id = 'test_lucky_stone';
    clone.zoneId = 'zone_hand_p1';
    raw.entities[clone.id] = clone;
    raw.zones.zone_hand_p1.orderedEntities.push(clone.id);
  }
  app.session.setViewer('GOD');
});
await page.waitForTimeout(700);

const before = await dockLabels();
console.log('dock before:', JSON.stringify(before));

// Click 撬开金库
await clickDockAction(page, '撬开金库');
await page.waitForTimeout(900);

const declarePhase = await page.evaluate(() => {
  const app = window.__boardGameApp;
  const snap = app.session.getSnapshot();
  const labels = [...document.querySelectorAll('.dock-actions .act')].map(el => el.dataset.fanLabel || el.querySelector('.act-label')?.textContent?.trim() || '');
  return { labels, types: snap.actions.map(a => a.actionType ?? a.id) };
});
console.log('declare phase dock:', JSON.stringify(declarePhase.labels));
if (!declarePhase.labels.some(l => l.includes('掷骰检定'))) {
  failures.push(`roll action is missing or unlabelled (${declarePhase.labels.join(' | ')})`);
}
if (!declarePhase.labels.some(l => l.includes('结算检定'))) {
  failures.push(`resolve action is missing or unlabelled (${declarePhase.labels.join(' | ')})`);
}
if (declarePhase.labels.some(l => /^[A-Z_]{4,}$/.test(l))) {
  failures.push(`dock still shows a raw action id (${declarePhase.labels.join(' | ')})`);
}

// Roll.
await clickDockAction(page, '掷骰检定');
await page.waitForTimeout(900);

const reactPhase = await page.evaluate(() => {
  const labels = [...document.querySelectorAll('.dock-actions .act')].map(el => el.dataset.fanLabel || el.querySelector('.act-label')?.textContent?.trim() || '');
  return labels;
});
console.log('react phase dock:', JSON.stringify(reactPhase));
if (!reactPhase.some(l => l.includes('检定响应'))) {
  failures.push(`reaction action is missing after the roll (${reactPhase.join(' | ')})`);
}

// React with the lucky stone, then resolve.
await clickDockAction(page, '检定响应');
await page.waitForTimeout(800);
await clickDockAction(page, '结算检定');
await page.waitForTimeout(900);

const after = await page.evaluate(() => {
  const app = window.__boardGameApp;
  const snap = app.session.getSnapshot();
  return {
    labels: [...document.querySelectorAll('.dock-actions .act')].map(el => el.dataset.fanLabel || el.querySelector('.act-label')?.textContent?.trim() || ''),
    feed: snap.history.slice(0, 4).map(h => h.title),
    pending: !!snap.board.rollWindows?.length
  };
});
console.log('after resolve:', JSON.stringify(after));

if (after.pending) failures.push('the roll window is still pending after resolving');
if (after.labels.some(l => l.includes('结算检定'))) {
  failures.push('the check actions are still offered after resolving');
}

await page.screenshot({ path: 'shots/roll-window.png' });
console.log('ERRORS:', errors.length ? errors.slice(0, 5) : 'none');

if (failures.length > 0) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exitCode = 1;
} else {
  console.log('\nTwo-phase check window UI checks passed.');
}

await browser.close();
dev.stop();
