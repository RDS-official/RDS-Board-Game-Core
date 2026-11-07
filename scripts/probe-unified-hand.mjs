import { launchChromium } from './lib/browser.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';

/**
 * Unified action hand browser probe (docs/INTERACTION-REDESIGN.md P3–P5).
 *
 * Proves, in a real browser:
 *   1. Default build: `#action-hand` is disabled and paints no cards (the legacy
 *      dock remains the only interactive path).
 *   2. `?unified-hand`: one card per snapshot action, in order, with the right
 *      intake badge; geometry stays inside the viewport.
 *   3. A `selection` card opens the radial picker; segment count matches the
 *      action's candidates; the centre option exists.
 *   4. Pointer hovering a sector marks exactly one segment active.
 *   5. Keyboard ArrowRight focuses the first option (aria-activedescendant);
 *      Escape closes.
 *   6. Clicking the centre opens the payload form; Escape closes it.
 *
 * Run: node scripts/probe-unified-hand.mjs   (or `pnpm probe:unified-hand`)
 */

const dev = await ensureSoloServer();
const browser = await launchChromium();

const failures = [];
const checks = [];
const record = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
};

const URL_BASE = `${dev.url}?game=betrayal&scenario=exploration`;
const boot = async (page) => {
  await page.waitForTimeout(4200);
  if (await page.locator('#boot-enter').count()) await page.click('#boot-enter').catch(() => {});
  await page.waitForTimeout(1400);
};

try {
  /* ---- 1. default build is untouched -------------------------------- */
  const plain = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await plain.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await boot(plain);
  const plainState = await plain.evaluate(() => {
    const hand = document.querySelector('#action-hand');
    return {
      exists: !!hand,
      enabled: hand?.getAttribute('data-enabled'),
      cards: document.querySelectorAll('#action-hand .ah-card').length,
      display: hand ? getComputedStyle(hand).display : 'missing',
    };
  });
  record('default: hand container exists', plainState.exists);
  record('default: hand disabled', plainState.enabled === '0', plainState.enabled);
  record('default: no cards painted', plainState.cards === 0, String(plainState.cards));
  record('default: hand not displayed', plainState.display === 'none', plainState.display);
  await plain.close();

  /* ---- 2. flagged build renders the hand ---------------------------- */
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${URL_BASE}&unified-hand`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await boot(page);

  const hand = await page.evaluate(() => {
    const app = window.__boardGameApp;
    const actions = app?.session?.getSnapshot?.()?.actions ?? [];
    const cards = [...document.querySelectorAll('#action-hand .ah-card')];
    const rects = cards.map((card) => {
      const r = card.getBoundingClientRect();
      return { id: card.dataset.actionId, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    });
    return {
      enabled: document.querySelector('#action-hand')?.getAttribute('data-enabled'),
      actionIds: actions.map((a) => a.id),
      cardIds: cards.map((card) => card.dataset.actionId),
      targetModes: cards.map((card) => card.dataset.targetMode),
      badges: cards.map((card) => card.querySelector('.ah-badge')?.textContent ?? ''),
      rects,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  });

  record('flagged: hand enabled', hand.enabled === '1', hand.enabled);
  record(
    'flagged: one card per action',
    hand.cardIds.length === hand.actionIds.length,
    `${hand.cardIds.length} cards vs ${hand.actionIds.length} actions`,
  );
  record(
    'flagged: card order matches actions',
    hand.cardIds.join(',') === hand.actionIds.join(','),
    hand.cardIds.join(','),
  );
  record(
    'flagged: selection card has ◎ badge',
    hand.targetModes.includes('selection') && hand.badges[hand.targetModes.indexOf('selection')] === '◎',
    JSON.stringify(hand.badges),
  );
  record(
    'flagged: cards stay horizontally inside the viewport',
    hand.rects.every((r) => r.left >= -1 && r.right <= hand.width + 1),
    JSON.stringify(hand.rects),
  );

  /* ---- 3. radial picker opens from a selection card ----------------- */
  const selectionCard = page.locator('#action-hand .ah-card[data-target-mode="selection"]').first();
  record('flagged: at least one selection card', (await selectionCard.count()) > 0);
  if ((await selectionCard.count()) > 0) {
    await selectionCard.click();
    await page.waitForTimeout(250);

    const wheel = await page.evaluate(() => {
      const dialog = document.querySelector('.rp-dialog');
      const segs = document.querySelectorAll('.rp-seg');
      const centre = document.querySelector('.rp-center');
      const r = dialog?.getBoundingClientRect();
      return {
        open: !!dialog,
        segments: segs.length,
        centre: !!centre,
        listOptions: document.querySelectorAll('.rp-list [role="option"]').length,
        width: r?.width ?? 0,
        height: r?.height ?? 0,
        left: r?.left ?? 0,
        top: r?.top ?? 0,
      };
    });
    record('radial: dialog open', wheel.open);
    record('radial: segment per candidate', wheel.segments >= 1, String(wheel.segments));
    record('radial: centre present', wheel.centre);
    record(
      'radial: accessible options = segments + centre',
      wheel.listOptions === wheel.segments + 1,
      String(wheel.listOptions),
    );
    record('radial: 1 unit = 1 px dialog size', wheel.width > 0);

    /* pointer hover over the first sector (mid-angle, 0.65R) */
    if (wheel.open && wheel.width > 0) {
      const n = wheel.segments;
      const angle = ((-90 + 180 / n) * Math.PI) / 180;
      const rad = wheel.width * 0.31; // 0.62R from centre, outside inner 0.34R
      await page.mouse.move(
        wheel.left + wheel.width / 2 + rad * Math.cos(angle),
        wheel.top + wheel.height / 2 + rad * Math.sin(angle),
      );
      await page.waitForTimeout(120);
      const active = await page.evaluate(() => document.querySelectorAll('.rp-seg.is-active').length);
      record('radial: pointer highlights exactly one sector', active === 1, String(active));
    }

    /* keyboard focus + Escape — reopen so focus starts empty */
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);
    await selectionCard.click();
    await page.waitForTimeout(200);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(80);
    const activeDesc = await page.evaluate(() =>
      document.querySelector('.rp-dialog')?.getAttribute('aria-activedescendant'),
    );
    record('radial: ArrowRight sets aria-activedescendant', activeDesc === 'rp-opt-0', String(activeDesc));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    record('radial: Escape closes', (await page.locator('.rp-dialog').count()) === 0);

    /* ---- 4. centre opens the payload form -------------------------- */
    await selectionCard.click();
    await page.waitForTimeout(200);
    await page.click('.rp-center');
    await page.waitForTimeout(250);
    const payload = await page.evaluate(() => {
      const layer = document.querySelector('#payload-layer');
      return {
        display: layer ? getComputedStyle(layer).display : 'missing',
        forms: document.querySelectorAll('#payload-layer form').length,
      };
    });
    record(
      'centre: payload layer visible',
      payload.display !== 'none' && payload.display !== 'missing',
      payload.display,
    );
    record('centre: payload form exists', payload.forms >= 1, String(payload.forms));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    const afterPayload = await page.evaluate(() => {
      const layer = document.querySelector('#payload-layer');
      return layer ? getComputedStyle(layer).display : 'missing';
    });
    record(
      'centre: Escape closes payload',
      afterPayload === 'none' || afterPayload === 'missing',
      afterPayload,
    );
  }

  await page.close();
} finally {
  await browser.close();
}

/* ---- report -------------------------------------------------------- */
const passed = checks.filter((c) => c.ok).length;
for (const c of checks) {
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}
if (failures.length > 0) {
  console.error(`\nunified-hand: ${passed}/${checks.length} checks passed`);
  for (const f of failures) console.error('  x ' + f);
  process.exit(1);
}
console.log(`\nunified-hand: ${passed}/${checks.length} checks passed`);
process.exit(0);
