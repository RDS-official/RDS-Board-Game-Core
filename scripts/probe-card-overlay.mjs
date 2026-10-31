import { launchChromium } from './lib/browser.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';

/**
 * Card-sheet overlay probe (Step 3, docs/UI-ARCHITECTURE.md §overlay).
 *
 * The UI matrix proves a fan card opens and runs; nothing today watches the
 * framed card sheet (`#card-sheet-layer`) itself. This probe exercises the
 * OverlayArbiter's three invariants in a real browser, on every card-bearing
 * game, with the same HUD API gameplay uses:
 *
 *  1. one sheet at a time — opening twice without closing must not stack;
 *  2. explicit close — after `.cs-close` the layer is emptied, and a fresh
 *     open/close cycle rebuilds exactly one sheet (no listener/timer ghosts);
 *  3. no late ghosts — a 9.5s wait past the auto-dismiss timer must not
 *     reopen a closed sheet, and rapid cycling must not grow the DOM.
 *
 * Run: node scripts/probe-card-overlay.mjs
 */
const dev = await ensureSoloServer();
const browser = await launchChromium();

const GAMES = ['betrayal', 'splendor', 'poker', 'sanguosha', 'dune_mahjong'];
const VIEW = { title: '探针卡面', desc: 'overlay probe fixture card', tone: 'neutral' };

const failures = [];
let checks = 0;

const ok = (game, message) => {
  checks++;
  console.log(`    ok  ${message}`);
};
const bad = (game, message) => {
  checks++;
  failures.push(`${game}: ${message}`);
  console.log(`    FAIL ${message}`);
};

const countSheets = () => document.querySelectorAll('#card-sheet-layer .card-sheet').length;
const layerEmpty = () => {
  const layer = document.querySelector('#card-sheet-layer');
  return !layer || layer.innerHTML.trim() === '';
};

for (const game of GAMES) {
  console.log(`  ${game}`);
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', msg => {
    if (msg.type() === 'error' && !/healthz|502/.test(msg.text())) errors.push(msg.text());
  });
  try {
    await page.goto(`${dev.url}?game=${game}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__boardGameApp?.hud, null, { timeout: 20000 });

    // 1) open twice without closing: exactly one sheet may exist.
    await page.evaluate(view => {
      window.__boardGameApp.hud.showCardSheet(view);
      window.__boardGameApp.hud.showCardSheet(view);
    }, VIEW);
    await page.waitForTimeout(120);
    const stacked = await page.evaluate(countSheets);
    if (stacked === 1) ok(game, 'double open keeps a single sheet');
    else bad(game, `double open stacked ${stacked} sheets`);

    // 2) close, reopen, close: the layer must be fully emptied each time.
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.evaluate(view => window.__boardGameApp.hud.showCardSheet(view), VIEW);
      await page.waitForTimeout(60);
      const open = await page.evaluate(countSheets);
      if (open !== 1) bad(game, `cycle ${cycle}: expected 1 sheet, found ${open}`);
      await page.evaluate(() => document.querySelector('#card-sheet-layer .cs-close')?.click());
      await page.waitForTimeout(60);
      if (await page.evaluate(layerEmpty)) ok(game, `cycle ${cycle}: layer emptied on close`);
      else bad(game, `cycle ${cycle}: layer not emptied on close`);
    }

    // 3) rapid cycling must not grow the layer's DOM or leak nodes globally.
    const before = await page.evaluate(() => document.getElementsByTagName('*').length);
    for (let i = 0; i < 12; i++) {
      await page.evaluate(view => window.__boardGameApp.hud.showCardSheet(view), VIEW);
      await page.evaluate(() => document.querySelector('#card-sheet-layer .cs-close')?.click());
    }
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => document.getElementsByTagName('*').length);
    if (after - before < 40) ok(game, `rapid cycling stable (${before} -> ${after} nodes)`);
    else bad(game, `rapid cycling leaked ${after - before} DOM nodes`);

    // 4) a closed sheet must stay closed past the 9s auto-dismiss timer.
    await page.evaluate(view => window.__boardGameApp.hud.showCardSheet(view), VIEW);
    await page.waitForTimeout(150);
    await page.evaluate(() => document.querySelector('#card-sheet-layer .cs-close')?.click());
    await page.waitForTimeout(9500);
    if (await page.evaluate(layerEmpty)) ok(game, 'no ghost reopen past the dismiss timer');
    else bad(game, 'sheet reopened after explicit close');

    if (errors.length > 0) bad(game, `console errors: ${errors.slice(0, 3).join(' | ')}`);
  } catch (error) {
    bad(game, `threw — ${error?.message ?? error}`);
  }
  await page.close();
}

await browser.close();
dev.stop();

console.log(`\n${checks - failures.length}/${checks} overlay checks passed.`);
if (failures.length > 0) {
  console.error('FAILURES:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
