import { launchChromium } from './lib/browser.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';

/**
 * Numeric "throw first, amount second" probe (docs/INTERACTION-REDESIGN.md P6).
 *
 * Poker raises carry a numeric amount field, so it is the one fixture that can
 * exercise the flow end to end. In a real browser this proves:
 *   1. A numeric card (`data-kind="numeric"`) is rendered in the unified hand.
 *   2. Clicking it starts the throw animation (`.is-playing`) immediately.
 *   3. The amount sheet opens after the animation.
 *   4. Escape cancels the sheet, the card stays in hand, and — critically — the
 *      snapshot revision is unchanged: nothing was dispatched before confirm.
 *
 * Run: node scripts/probe-unified-hand-numeric.mjs
 */

const dev = await ensureSoloServer();
const browser = await launchChromium();
const failures = [];
const checks = [];
const record = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
};

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
try {
  await page.goto(`${dev.url}?game=poker&unified-hand`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4500);
  if (await page.locator('#boot-enter').count()) await page.click('#boot-enter').catch(() => {});
  await page.waitForTimeout(1200);

  // Deal the first hand if the table is idle.
  await page.evaluate(() => {
    const app = window.__boardGameApp;
    const snap = app?.session?.getSnapshot?.();
    const start = snap?.actions?.find((a) => /开始|发下一手/.test(a.label));
    if (start) app.hud.promptAction(start.id);
  });

  // Advance AI turns until the hero is offered a numeric raise.
  let reached = null;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(700);
    reached = await page.evaluate(() => {
      const app = window.__boardGameApp;
      const snap = app?.session?.getSnapshot?.();
      const numeric = snap?.actions?.find((a) => a.fields?.some((f) => f.kind === 'number'));
      return {
        numericId: numeric?.id ?? null,
        revision: snap?.revision ?? -1,
        cards: document.querySelectorAll('#action-hand .ah-card').length,
        numericCards: document.querySelectorAll('#action-hand .ah-card[data-kind="numeric"]').length,
      };
    });
    if (reached.numericId) break;
    await page.evaluate(() => {
      const app = window.__boardGameApp;
      const engine = app?.session?.engine;
      if (!engine) return;
      const raw = engine.getRawState();
      const active = raw.activeActorId ?? raw.activePlayerId;
      const legal = engine.getLegalActions(active);
      const act = legal[0];
      if (act) engine.dispatch(act);
    });
  }

  if (!reached?.numericId) {
    record('numeric: reached a numeric action', false, 'poker never offered a raise');
  } else {
    record('numeric: reached a numeric action', true, reached.numericId);
    record(
      'numeric: card rendered with numeric kind',
      reached.numericCards >= 1,
      String(reached.numericCards),
    );

    const svgIcons = await page.evaluate(() => document.querySelectorAll('#action-hand .ah-ico svg').length);
    record('numeric: svg icons render as elements', svgIcons > 0, String(svgIcons));

    const card = page.locator(`#action-hand .ah-card[data-action-id="${reached.numericId}"]`).first();
    const revBefore = reached.revision;

    await card.click();
    await page.waitForTimeout(70);
    const playing = await page.evaluate(
      (id) =>
        document
          .querySelector(`#action-hand .ah-card[data-action-id="${id}"]`)
          ?.classList.contains('is-playing') ?? false,
      reached.numericId,
    );
    record('numeric: throw animation starts', playing);

    await page.waitForTimeout(450);
    const sheet = await page.evaluate(() => {
      const layer = document.querySelector('#payload-layer');
      return {
        display: layer ? getComputedStyle(layer).display : 'missing',
        sliders: document.querySelectorAll('#payload-layer input[type="range"]').length,
        forms: document.querySelectorAll('#payload-layer form').length,
      };
    });
    record(
      'numeric: amount sheet opens',
      sheet.display !== 'none' && sheet.display !== 'missing',
      sheet.display,
    );
    record('numeric: sheet has a slider', sheet.sliders >= 1, String(sheet.sliders));

    await page.keyboard.press('Escape');
    await page.waitForTimeout(220);
    const after = await page.evaluate((id) => {
      const app = window.__boardGameApp;
      const layer = document.querySelector('#payload-layer');
      return {
        display: layer ? getComputedStyle(layer).display : 'missing',
        revision: app?.session?.getSnapshot?.()?.revision ?? -1,
        cardStillThere: !!document.querySelector(`#action-hand .ah-card[data-action-id="${id}"]`),
      };
    }, reached.numericId);
    record(
      'numeric: Escape closes the sheet',
      after.display === 'none' || after.display === 'missing',
      after.display,
    );
    record('numeric: card stays in hand after cancel', after.cardStillThere);
    record(
      'numeric: cancel dispatches nothing (revision unchanged)',
      after.revision === revBefore,
      `${revBefore} → ${after.revision}`,
    );
  }
} finally {
  await browser.close();
}

const passed = checks.filter((c) => c.ok).length;
for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
if (failures.length > 0) {
  console.error(`\nunified-hand-numeric: ${passed}/${checks.length} checks passed`);
  for (const f of failures) console.error('  x ' + f);
  process.exit(1);
}
console.log(`\nunified-hand-numeric: ${passed}/${checks.length} checks passed`);
process.exit(0);
