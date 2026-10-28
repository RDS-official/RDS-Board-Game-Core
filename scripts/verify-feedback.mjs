import { launchChromium } from './lib/browser.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';

/**
 * Verifies the two feedback surfaces added for Betrayal:
 *   1. the recent-activity feed keeps kernel events;
 *   2. a trait movement paints a screen tint, shakes the sheet, flashes the
 *      ladder, floats a world-space number and lands a feed row.
 */
const dev = await ensureSoloServer();
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const errors = [];
page.on('pageerror', err => errors.push(err.message));
page.on('console', msg => {
  if (msg.type() === 'error') errors.push(msg.text());
});

const failures = [];

/* ---------------------------- activity feed ---------------------------- */
await page.goto(`${dev.url}?game=betrayal&scenario=exploration`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2400);
if (await page.locator('#boot-enter').count()) await page.click('#boot-enter');
await page.waitForTimeout(900);

const beforeRows = await page.evaluate(() => document.querySelectorAll('#activity-feed .af-row').length);
await page.evaluate(() => {
  window.__boardGameApp.session.pickTarget({
    kind: 'node',
    id: 'room_foyer',
    metadata: { intent: 'interact' }
  });
});
await page.waitForTimeout(700);

const feed = await page.evaluate(() => {
  const snap = window.__boardGameApp.session.getSnapshot();
  return {
    historyLen: snap.history.length,
    top: snap.history[0] ? `${snap.history[0].icon} ${snap.history[0].title}` : null,
    rows: document.querySelectorAll('#activity-feed .af-row').length,
    hasHead: !!document.querySelector('#activity-feed .af-head')
  };
});
if (feed.historyLen === 0) failures.push('feed: history stayed empty after a move');
if (feed.rows <= beforeRows) failures.push(`feed: DOM rows did not grow (${beforeRows} -> ${feed.rows})`);
if (!feed.hasHead) failures.push('feed: header missing');

// Collapse toggle must survive a repaint.
await page.locator('#af-toggle').click();
await page.waitForTimeout(200);
const collapsed = await page.evaluate(() =>
  document.querySelector('#activity-feed')?.classList.contains('collapsed')
);
if (!collapsed) failures.push('feed: collapse toggle did not apply');
await page.locator('#af-toggle').click();
await page.waitForTimeout(200);

await page.screenshot({ path: 'shots/activity-feed.png' });
console.log(`feed: history=${feed.historyLen} rows=${feed.rows} top="${feed.top}"`);

/* ------------------------ trait change feedback ------------------------ */
await page.goto(`${dev.url}?game=betrayal&scenario=haunt_eye`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2600);
if (await page.locator('#boot-enter').count()) await page.click('#boot-enter');
await page.waitForTimeout(900);

const attacked = await page.evaluate(async () => {
  const app = window.__boardGameApp;
  // Two things to absorb here:
  //  - the turn-start Speed roll shifted the PRNG, so one scripted attack can miss;
  //  - the damage feedback elements live for ~200ms, so a single sample after a
  //    fixed wait misses them.
  // Swing until something lands, polling fast enough to see the effects.
  const damageRows = () => document.querySelectorAll('#activity-feed .af-row.kind-damage').length;
  const before = damageRows();
  const seen = { screenHit: false, cardShake: false, pipFlash: false, cardBurst: false, worldBurst: false };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const sample = () => {
    if (document.querySelector('#screen-hit.mental, #screen-hit.physical')) seen.screenHit = true;
    if (document.querySelector('.pc.trait-hit, .pc.trait-heal')) seen.cardShake = true;
    if (document.querySelector('.trait-row.flash-down, .trait-row.flash-up')) seen.pipFlash = true;
    if (document.querySelector('.trait-burst')) seen.cardBurst = true;
    if (document.querySelector('.label-burst')) seen.worldBurst = true;
  };

  let lastError;
  for (let attempt = 0; attempt < 8; attempt++) {
    const raw = app.session.engine.getRawState();
    const active = raw.activeActorId ?? raw.activePlayerId;
    if (raw.players?.[active]) raw.players[active].customProps.attacksLeft = 1;
    app.session.setViewer('GOD');
    const snap = app.session.getSnapshot();
    const action = snap.actions.find(a => a.label.includes('攻击') || a.icon === '⚔');
    if (!action) {
      return { ok: false, reason: `no attack action among ${snap.actions.map(a => a.label).join(' | ')}` };
    }
    const res = app.session.perform(action.id, {}, undefined);
    if (!res.ok) lastError = res.error;

    // Poll through the effect lifetime instead of sampling once.
    for (let tick = 0; tick < 10; tick++) {
      await sleep(40);
      sample();
    }
    if (damageRows() > before) {
      return { ok: true, id: action.id, label: action.label, attempts: attempt + 1, seen };
    }
  }
  return { ok: false, reason: 'attack never dealt damage', error: lastError, seen };
});
await page.waitForTimeout(260);

const feedback = await page.evaluate(seen => {
  const snap = window.__boardGameApp.session.getSnapshot();
  return {
    screenHit: seen.screenHit ?? false,
    screenClass: document.querySelector('#screen-hit')?.className ?? '',
    cardShake: seen.cardShake ?? false,
    pipFlash: seen.pipFlash ?? false,
    cardBurst: seen.cardBurst ?? false,
    worldBurst: seen.worldBurst ?? false,
    feedDamage: [...document.querySelectorAll('#activity-feed .af-row.kind-damage')].length,
    historyTop: snap.history.slice(0, 2).map(h => `${h.kind}:${h.title}`)
  };
}, attacked.seen ?? {});

await page.screenshot({ path: 'shots/trait-damage-feedback.png' });

if (!attacked.ok) failures.push(`damage: attack did not dispatch (${attacked.error ?? attacked.reason})`);
if (!feedback.screenHit) failures.push(`damage: no screen tint (got "${feedback.screenClass}")`);
if (!feedback.cardShake) failures.push('damage: character sheet did not shake');
if (!feedback.pipFlash) failures.push('damage: trait ladder did not flash');
if (!feedback.cardBurst) failures.push('damage: no floating delta on the sheet');
if (!feedback.worldBurst) failures.push('damage: no world-space burst over the miniature');
if (feedback.feedDamage === 0) failures.push('damage: feed has no damage row');

console.log('damage:', JSON.stringify(feedback, null, 1));
console.log('ERRORS:', errors.length ? errors.slice(0, 5) : 'none');

if (failures.length > 0) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exitCode = 1;
} else {
  console.log('\nAll feedback checks passed.');
}

await browser.close();
dev.stop();
