/**
 * Poker settlement curtain probe.
 *
 * 契约（#333 之后的第二版）：结算幕布出现即代表结果已定，所以
 *   - 关闭按钮在幕布出现的那一刻就是可用的「关闭」，不再有 Ns 倒计时；
 *   - 幕布不会自动消失，玩家看够了才自己点掉（按钮 / 空白处 / Esc 三条路）；
 *   - 游戏推进到下一手时仍然收回幕布，玩家不用先关一次。
 *
 * 另外验证极简 2D 是显式开启项：不带 poker_view 参数时应落到 3D 桌面。
 *
 * Vite 必须跑在 :3100（或 WEB 环境变量指定的地址）。
 */
import { launchChromium } from './lib/browser.mjs';

const WEB = process.env.WEB ?? 'http://127.0.0.1:3100';
let failures = 0;
const check = (condition, label) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`);
  if (!condition) failures++;
};

async function waitForHand(page) {
  await page.waitForFunction(
    () => {
      const hand = window.__boardGameApp?.session?.getSnapshot?.()?.board?.globalVars?.hand;
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
  await page.evaluate(({ id }) => window.__boardGameApp.session.perform(id), start);
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

function readCurtain(page) {
  return page.evaluate(() => {
    const close = document.querySelector('#mc-close');
    return {
      open: !!document.querySelector('#moment-cine.open'),
      closeText: close?.textContent ?? null,
      closeDisabled: close?.disabled ?? null,
      actions: [...document.querySelectorAll('[data-moment-action]')].map(button => ({
        id: button.dataset.momentAction,
        disabled: button.disabled
      }))
    };
  });
}

const isOpen = page => page.evaluate(() => !!document.querySelector('#moment-cine.open'));

async function openTable(browser, { reducedMotion = false, query = '' } = {}) {
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
  await page.goto(`${WEB}/?game=poker&scenario=seats_2${query}`, { waitUntil: 'domcontentloaded' });
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

  // ---- 1. 默认视图：不传 poker_view 时是 3D，极简 2D 需要显式开启 --------
  {
    const { context, page, errors } = await openTable(browser);
    // hide() 只是把 2D 根节点藏起来，节点本身常驻，所以按可见性判定
    check(
      await page.evaluate(() => {
        const root = document.querySelector('#poker-2d-root');
        return !root || root.getBoundingClientRect().width === 0;
      }),
      'default table is the 3D simulator (2D stays off unless the player opts in)'
    );
    check(errors.length === 0, `no page errors on the default table (${errors.join('; ') || 'none'})`);
    await context.close();
  }
  {
    const { context, page, errors } = await openTable(browser, { query: '&poker_view=2d' });
    check(
      await page.evaluate(() => {
        const root = document.querySelector('#poker-2d-root');
        return !!root && root.getBoundingClientRect().width > 0;
      }),
      'poker_view=2d still switches the flat table on'
    );
    check(errors.length === 0, `no page errors on the 2D table (${errors.join('; ') || 'none'})`);
    await context.close();
  }

  // ---- 2. 幕布打开即可关闭，没有倒计时，也不会自己消失 -------------------
  {
    const { context, page, errors } = await openTable(browser);
    await foldToSettlement(page);
    const opened = await readCurtain(page);
    check(opened.open, 'settlement curtain opens after the decisive fold');
    check(opened.closeText === '关闭', `close button is a plain 关闭 at open (${opened.closeText})`);
    check(opened.closeDisabled === false, 'close button is clickable the moment the result shows');
    check(!/\d+\s*s/.test(opened.closeText ?? ''), 'no numeric countdown on the close button');
    check(
      opened.actions.length > 0 && opened.actions.every(action => !action.disabled),
      `settlement actions are usable at open (${opened.actions.map(a => `${a.id}:${a.disabled}`).join(' ')})`
    );

    await page.waitForTimeout(7000);
    const later = await readCurtain(page);
    check(later.open, 'curtain is still up 7s after it opened (no auto-close)');
    check(later.closeText === '关闭', `close label does not drift with time (${later.closeText})`);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    check(!(await isOpen(page)), 'Escape closes the curtain');
    check(errors.length === 0, `no page errors in the read-then-close run (${errors.join('; ') || 'none'})`);
    await context.close();
  }

  // ---- 3. 关闭按钮与空白处点击都能撤下幕布 -------------------------------
  {
    const { context, page, errors } = await openTable(browser);
    await foldToSettlement(page);
    await page.locator('#mc-close').click();
    await page.waitForTimeout(200);
    check(!(await isOpen(page)), 'close button retires the curtain');
    check(errors.length === 0, `no page errors on the close-button path (${errors.join('; ') || 'none'})`);
    await context.close();
  }
  {
    const { context, page, errors } = await openTable(browser);
    await foldToSettlement(page);
    await page.locator('.mc-vignette').click({ position: { x: 4, y: 4 }, force: true });
    await page.waitForTimeout(200);
    check(!(await isOpen(page)), 'clicking the empty backdrop retires the curtain');
    check(errors.length === 0, `no page errors on the backdrop path (${errors.join('; ') || 'none'})`);
    await context.close();
  }

  // ---- 4. 游戏推进到下一手时幕布自己让位 ---------------------------------
  {
    const { context, page, errors } = await openTable(browser);
    await foldToSettlement(page);
    const advanced = await page.evaluate(() => {
      const session = window.__boardGameApp.session;
      const next = session.getSnapshot().actions.find(action =>
        ['FORCE_START', 'START_HAND'].includes(action.actionType ?? '')
      );
      if (!next) return false;
      return session.perform(next.id).ok;
    });
    check(advanced, 'a new hand can be started while the curtain is up');
    await page.waitForFunction(() => !document.querySelector('#moment-cine.open'), { timeout: 3000 });
    check(true, 'curtain yields to the game without the player closing it first');
    check(errors.length === 0, `no page errors in the auto-advance run (${errors.join('; ') || 'none'})`);
    await context.close();
  }

  // ---- 5. reduced motion 下文案与可关闭性不变 ----------------------------
  {
    const { context, page, errors } = await openTable(browser, { reducedMotion: true });
    await foldToSettlement(page);
    const opened = await readCurtain(page);
    check(opened.closeText === '关闭' && opened.closeDisabled === false, 'reduced motion keeps an enabled 关闭');
    await page.waitForTimeout(2200);
    check((await readCurtain(page)).open, 'reduced motion does not auto-close the curtain either');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    check(!(await isOpen(page)), 'reduced motion still closes on Escape');
    check(errors.length === 0, `no page errors in the reduced-motion run (${errors.join('; ') || 'none'})`);
    await context.close();
  }

  await browser.close();
  console.log(failures === 0 ? '\nPASS settlement curtain' : `\n${failures} FAILURES`);
  if (failures > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error('FAIL:', error);
  process.exitCode = 1;
});
