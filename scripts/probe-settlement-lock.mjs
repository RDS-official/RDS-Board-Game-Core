/**
 * Poker settlement curtain close-lock probe.
 *
 * Runs the real HUD in a dev browser, folds a heads-up hand to reach the
 * settlement curtain, then verifies:
 *   - the close button is disabled and counts down in wall-clock seconds;
 *   - close button / backdrop / Escape all fail during the first 10 seconds;
 *   - at 11 seconds the button is enabled, says "关闭" and actually closes;
 *   - a game-driven next hand still removes the curtain during the lock;
 *   - with prefers-reduced-motion: reduce the countdown still advances.
 *
 * Vite must be running on :3000 (the probe opens the solo poker fixture).
 */
import { launchChromium } from './lib/browser.mjs';

const WEB = process.env.WEB ?? 'http://127.0.0.1:3000';
let failures = 0;
const check = (condition, label) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`);
  if (!condition) failures++;
};

async function waitForHand(page) {
  await page.waitForFunction(
    () => {
      const app = window.__boardGameApp;
      const hand = app?.session?.getSnapshot?.()?.board?.globalVars?.hand;
      return !!hand && hand.street !== 'COMPLETE';
    },
    { timeout: 15000 }
  );
}

async function ensureHand(page) {
  const state = await page.evaluate(() => {
    const snapshot = window.__boardGameApp.session.getSnapshot();
    return {
      street: snapshot.board.globalVars.hand?.street,
      actions: snapshot.actions.map(action => ({ id: action.id, type: action.actionType }))
    };
  });
  if (state.street !== 'COMPLETE') return;
  const start = state.actions.find(action => action.type === 'FORCE_START' || action.type === 'START_HAND');
  if (!start) throw new Error('no start action for a fresh hand');
  await page.evaluate(
    ({ id }) => {
      window.__boardGameApp.session.perform(id);
    },
    start
  );
  await waitForHand(page);
}

async function foldToSettlement(page) {
  await ensureHand(page);
  const result = await page.evaluate(() => {
    const session = window.__boardGameApp.session;
    const fold = session.getSnapshot().actions.find(action => action.actionType === 'FOLD');
    if (!fold) return { ok: false, error: 'no FOLD action' };
    return { ok: true, result: session.perform(fold.id) };
  });
  if (!result.ok || !result.result?.ok) throw new Error(`fold failed: ${JSON.stringify(result)}`);
  await page.waitForSelector('#moment-cine.open', { timeout: 15000 });
}

async function openTable(browser, { reducedMotion = false } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ...(reducedMotion ? { reducedMotion: 'reduce' } : {})
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`${WEB}/?game=poker&scenario=seats_2`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__boardGameApp?.session?.getSnapshot?.(), { timeout: 30000 });
  await page.locator('#boot-enter').click();
  await page.waitForFunction(
    () => document.querySelector('#boot-screen')?.classList.contains('hidden'),
    { timeout: 10000 }
  );
  await page.waitForTimeout(800);
  return { context, page, errors };
}

async function main() {
  const browser = await launchChromium();

  // ---- 1. locked settlement: all three manual exits are ignored -----------
  {
    const { context, page, errors } = await openTable(browser);
    await foldToSettlement(page);
    const opened = await page.evaluate(() => {
      const close = document.querySelector('#mc-close');
      return {
        text: close?.textContent ?? '',
        disabled: close?.disabled ?? false,
        lockUntil: Number(close?.dataset.lockUntil ?? 0),
        actions: [...document.querySelectorAll('[data-moment-action]')].map(button => button.disabled)
      };
    });
    check(/^\d+s 后可关闭$/.test(opened.text), `initial close label is a countdown (${opened.text})`);
    check(opened.disabled, 'close button is disabled at open');
    check(opened.actions.every(Boolean), 'all settlement action buttons are disabled during the lock');
    const lockStartedAt = opened.lockUntil - 10000;
    const waitUntilElapsed = async ms => {
      await page.waitForTimeout(Math.max(0, lockStartedAt + ms - Date.now()));
    };

    await waitUntilElapsed(3000);
    const atThree = await page.evaluate(() => {
      const close = document.querySelector('#mc-close');
      return {
        text: close?.textContent ?? '',
        disabled: close?.disabled ?? false,
        open: !!document.querySelector('#moment-cine.open')
      };
    });
    check(atThree.open, 'curtain still open at 3s');
    check(atThree.disabled, 'close remains disabled at 3s');
    check(atThree.text !== opened.text, `countdown advanced under real time (${opened.text} -> ${atThree.text})`);

    await page.locator('#mc-close').dispatchEvent('click');
    await page.keyboard.press('Escape');
    await page.locator('.mc-vignette').click({ position: { x: 4, y: 4 }, force: true });
    await page.waitForTimeout(250);
    check(
      await page.evaluate(() => !!document.querySelector('#moment-cine.open')),
      'close button + Esc + backdrop are all ignored at 3s'
    );

    await page.waitForTimeout(Math.max(0, opened.lockUntil + 1000 - Date.now()));
    const atEleven = await page.evaluate(() => {
      const close = document.querySelector('#mc-close');
      return {
        open: !!document.querySelector('#moment-cine.open'),
        text: close?.textContent ?? '',
        disabled: close?.disabled ?? false
      };
    });
    check(atEleven.open, 'curtain still open at 11s (not auto-closed)');
    check(!atEleven.disabled && atEleven.text === '关闭', 'close label is 关闭 and enabled at 11s');
    await page.locator('#mc-close').click();
    await page.waitForTimeout(150);
    check(
      !(await page.evaluate(() => !!document.querySelector('#moment-cine.open'))),
      'close button works once the countdown reaches 0'
    );
    check(errors.length === 0, `no page errors during the locked settlement (${errors.join('; ') || 'none'})`);
    await context.close();
  }

  // ---- 2. reduced motion must not stop the countdown ----------------------
  {
    const { context, page, errors } = await openTable(browser, { reducedMotion: true });
    await foldToSettlement(page);
    const first = await page.evaluate(() => document.querySelector('#mc-close')?.textContent ?? '');
    await page.waitForTimeout(2200);
    const second = await page.evaluate(() => document.querySelector('#mc-close')?.textContent ?? '');
    check(first !== second, `countdown still advances with reduced motion (${first} -> ${second})`);
    check(
      await page.evaluate(() => document.querySelector('#mc-close')?.disabled === true),
      'close stays locked with reduced motion'
    );
    check(errors.length === 0, `no page errors in reduced-motion run (${errors.join('; ') || 'none'})`);
    await context.close();
  }

  // ---- 3. a game-driven next hand retires the curtain before 10s ----------
  {
    const { context, page, errors } = await openTable(browser);
    await foldToSettlement(page);
    const advanced = await page.evaluate(() => {
      const session = window.__boardGameApp.session;
      const next = session.getSnapshot().actions.find(action =>
        ['FORCE_START', 'START_HAND'].includes(action.actionType ?? '')
      );
      if (!next) return false;
      const result = session.perform(next.id);
      return result.ok;
    });
    check(advanced, 'game/presenter can still advance to the next hand while the curtain is locked');
    await page.waitForFunction(
      () => !document.querySelector('#moment-cine.open'),
      { timeout: 3000 }
    );
    check(true, 'curtain closes when the game state moves on, without waiting for the lock');
    check(errors.length === 0, `no page errors in auto-advance run (${errors.join('; ') || 'none'})`);
    await context.close();
  }

  await browser.close();
  console.log(failures === 0 ? '\nPASS settlement lock' : `\n${failures} FAILURES`);
  if (failures > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error('FAIL:', error);
  process.exitCode = 1;
});
