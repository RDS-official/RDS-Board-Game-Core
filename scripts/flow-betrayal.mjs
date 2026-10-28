import { launchChromium } from './lib/browser.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';
const __solo = await ensureSoloServer();

const BASE = __solo.url;

const browser = await launchChromium();

const errors = [];
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
page.on('console', msg => {
  if (msg.type() === 'error') errors.push(`[console] ${msg.text()}`);
});
page.on('pageerror', err => errors.push(`[pageerror] ${err.message}`));

const actionTexts = async () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.act')].map(el => el.dataset.fanLabel || el.querySelector('.act-label')?.textContent || '')
  );
const clickAction = async text => {
  const button = page.locator(`.act[data-fan-label*="${text}"], .act:has-text("${text}")`).first();
  if (!(await button.count())) return false;
  await button.click();
  await page.waitForTimeout(900);
  return true;
};

const enter = async () => {
  await page.click('#boot-enter').catch(() => {});
  await page.waitForTimeout(800);
};

try {
  /* ------------------------------ exploration ------------------------------ */
  await page.goto(`${BASE}?game=betrayal&scenario=exploration`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.click('#boot-enter').catch(() => {});
  await page.waitForTimeout(1200);

  console.log('actions:', JSON.stringify(await actionTexts()));
  await clickAction('探索房门');
  await page.waitForTimeout(1400);
  console.log('after explore actions:', JSON.stringify(await actionTexts()));
  await page.screenshot({ path: 'shots/flow-exploration-explored.png' });

  // The drawn tile is preloaded on the table; rotate/confirm inline.
  if (await page.locator('.placement-panel').count()) {
    await page.locator('[data-place-rotate]').click();
    await page.waitForTimeout(350);
    await page.locator('[data-place-confirm]').click();
    await page.waitForTimeout(1200);
    console.log('after room placed actions:', JSON.stringify(await actionTexts()));
  } else if (await clickAction('放置')) {
    await page.waitForTimeout(800);
    console.log('after room placed actions:', JSON.stringify(await actionTexts()));
  }

  await clickAction('结束回合');
  await page.waitForTimeout(1200);
  console.log('after end turn actions:', JSON.stringify(await actionTexts()));
  await page.screenshot({ path: 'shots/flow-exploration-hauntcheck.png' });
  if (await clickAction('作祟检定')) {
    await page.waitForTimeout(1800);
    console.log('after haunt roll actions:', JSON.stringify(await actionTexts()));
    await page.screenshot({ path: 'shots/flow-exploration-hauntroll.png' });
  }

  /* --------------------------------- trade --------------------------------- */
  await page.goto(`${BASE}?game=betrayal&scenario=trade_ready`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1500);
  await enter();
  await clickAction('提出同房间交易');
  await page.waitForTimeout(500);
  await page.locator('.payload-card button[type="submit"]').first().click();
  await page.waitForTimeout(1500);
  console.log('after trade proposal:', JSON.stringify(await actionTexts()));
  await page.screenshot({ path: 'shots/flow-trade-proposed.png' });
  if (await clickAction('接受交易')) {
    await page.waitForTimeout(1200);
    console.log('after trade accept:', JSON.stringify(await actionTexts()));
    await page.screenshot({ path: 'shots/flow-trade-accepted.png' });
  }

  /* --------------------------------- mummy --------------------------------- */
  await page.goto(`${BASE}?game=betrayal&scenario=haunt_mummy`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1500);
  await enter();
  console.log('mummy actions:', JSON.stringify(await actionTexts()));
  if (await clickAction('攻击 公牛奥克斯')) {
    await page.waitForTimeout(500);
    await page.locator('.payload-card button[type="submit"]').first().click();
    await page.waitForTimeout(1600);
    console.log('after attack actions:', JSON.stringify(await actionTexts()));
    await page.screenshot({ path: 'shots/flow-mummy-attack.png' });
    if (await clickAction('选择承受伤害的属性')) {
      await page.waitForTimeout(500);
      await page.locator('.payload-card button[type="submit"]').first().click();
      await page.waitForTimeout(1400);
      console.log('after allocate actions:', JSON.stringify(await actionTexts()));
      await page.screenshot({ path: 'shots/flow-mummy-allocated.png' });
    }
  }

  /* ---------------------------------- eye ---------------------------------- */
  await page.goto(`${BASE}?game=betrayal&scenario=haunt_eye`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1500);
  await enter();
  console.log('eye actions:', JSON.stringify(await actionTexts()));
  await clickAction('攻击');
  await page.waitForTimeout(500);
  await page.locator('.payload-card button[type="submit"]').first().click();
  await page.waitForTimeout(1500);
  console.log('after eye attack:', JSON.stringify(await actionTexts()));
  await page.screenshot({ path: 'shots/flow-eye-attack.png' });
} finally {
  console.log('ERRORS:', errors.length ? JSON.stringify(errors, null, 2) : 'none');
  await browser.close();
}
