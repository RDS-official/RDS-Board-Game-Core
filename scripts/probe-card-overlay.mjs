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

    // 2) a deliberate sheet must evict a hover preview: one card, one picture.
    await page.evaluate(view => {
      window.__boardGameApp.hud.showHoverHint({
        key: 'probe:peek',
        title: '探针悬停',
        desc: 'hover',
        sections: [],
        actions: []
      });
      window.__boardGameApp.hud.showCardSheet(view);
    }, VIEW);
    await page.waitForTimeout(80);
    const mixed = await page.evaluate(() => ({
      sheets: document.querySelectorAll('#card-sheet-layer .card-sheet').length,
      hint: Boolean(document.querySelector('#hover-hint.on'))
    }));
    if (mixed.sheets === 1 && !mixed.hint) ok(game, 'sheet evicts the hover preview');
    else bad(game, `sheet/hover stacked: ${JSON.stringify(mixed)}`);
    await page.evaluate(() => document.querySelector('#card-sheet-layer .cs-close')?.click());
    await page.waitForTimeout(60);

    // 3) close, reopen, close: the layer must be fully emptied each time.
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
    await page.waitForTimeout(500);
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

// 4) own-hand 3D hover must not also open the DOM hover card.
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  try {
    await page.goto(`${dev.url}?game=sanguosha&legacy`, { waitUntil: 'domcontentloaded' });
    if (await page.locator('#boot-enter').count()) await page.click('#boot-enter').catch(() => {});
    await page.waitForFunction(() => window.__boardGameApp?.scene?.handRows?.size > 0, null, { timeout: 20000 });
    await page.waitForTimeout(2200);
    const point = await page.evaluate(() => {
      const scene = window.__boardGameApp.scene;
      const row = [...scene.handRows.values()].find(entry => entry.cameraAttached && entry.ids.length > 0);
      const id = row?.ids[Math.floor(row.ids.length / 2)];
      const mesh = id ? scene.entityMeshes.get(id) : null;
      if (!mesh) return null;
      const v = mesh.getWorldPosition(new mesh.position.constructor());
      v.project(scene.camera);
      return { id, x: ((v.x + 1) / 2) * window.innerWidth, y: ((1 - v.y) / 2) * window.innerHeight };
    });
    if (!point) bad('hover', 'no 3D hand card to hover');
    else {
      await page.mouse.move(point.x, point.y, { steps: 5 });
      await page.waitForTimeout(250);
      const state = await page.evaluate(() => ({
        own: window.__boardGameApp.scene.isHoveringOwnHand(),
        hint: Boolean(document.querySelector('#hover-hint.on')),
        sheet: Boolean(document.querySelector('#card-sheet-layer.open'))
      }));
      if (state.own) ok('hover', '3D hand hover is recognized as own hand');
      else bad('hover', '3D hand hover was not recognized');
      if (!state.hint && !state.sheet) ok('hover', 'own-hand hover does not stack a DOM preview');
      else bad('hover', `own-hand hover stacked DOM overlays: ${JSON.stringify(state)}`);
    }
    if (errors.length > 0) bad('hover', `console errors: ${errors.slice(0, 3).join(' | ')}`);
  } catch (error) {
    bad('hover', `threw — ${error?.message ?? error}`);
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
