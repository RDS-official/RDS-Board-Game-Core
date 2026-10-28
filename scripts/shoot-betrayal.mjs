import { launchChromium } from './lib/browser.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';
const __solo = await ensureSoloServer();

const BASE = __solo.url;

const browser = await launchChromium();

const errors = [];

async function shoot(scenario, name, interact) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(`[${scenario}] [console] ${msg.text()}`);
  });
  page.on('pageerror', err => errors.push(`[${scenario}] [pageerror] ${err.message}`));

  await page.goto(`${BASE}?game=betrayal&scenario=${scenario}`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2200);
  await page.click('#boot-enter').catch(() => {});
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `shots/betrayal-${name}-01.png` });

  if (interact) {
    await interact(page);
  }

  await page.close();
}

try {
  await shoot('exploration', 'exploration', async page => {
    const explore = page.locator('.act[data-fan-label*="探索房门"], .act:has-text("探索房门")').first();
    if (await explore.count()) {
      await explore.click();
      await page.waitForTimeout(2000);
      await page.screenshot({ path: 'shots/betrayal-exploration-02-explore.png' });
    }
  });

  await shoot('trade_ready', 'trade', async page => {
    const trade = page.locator('.act[data-fan-label*="提出同房间交易"], .act:has-text("提出同房间交易")').first();
    if (await trade.count()) {
      await trade.click();
      await page.waitForTimeout(700);
      await page.screenshot({ path: 'shots/betrayal-trade-02-modal.png' });
      const submit = page.locator('.payload-card button[type="submit"]').first();
      if (await submit.count()) {
        await submit.click().catch(() => {});
        await page.waitForTimeout(1400);
        await page.screenshot({ path: 'shots/betrayal-trade-03-proposed.png' });
      }
    }
  });

  await shoot('haunt_mummy', 'mummy', async page => {
    await page.screenshot({ path: 'shots/betrayal-mummy-02-board.png' });
    const attack = page.locator('.act[data-fan-label*="攻击"], .act:has-text("攻击")').first();
    if (await attack.count()) {
      await attack.click();
      await page.waitForTimeout(700);
      await page.screenshot({ path: 'shots/betrayal-mummy-03-payload.png' });
    }
    const seal = page.locator('.act[data-fan-label*="破译神圣符文"], .act:has-text("破译神圣符文")').first();
    if (await seal.count()) {
      await seal.click();
      await page.waitForTimeout(1600);
      await page.screenshot({ path: 'shots/betrayal-mummy-04-ritual.png' });
    }
  });

  await shoot('omen_ready', 'omen', async page => {
    const end = page.locator('.act[data-fan-label*="结束回合"], .act:has-text("结束回合")').first();
    if (await end.count()) {
      await end.click();
      await page.waitForTimeout(1200);
      await page.screenshot({ path: 'shots/betrayal-omen-02-check.png' });
      const roll = page.locator('.act[data-fan-label*="进行作祟检定"], .act:has-text("进行作祟检定")').first();
      if (await roll.count()) {
        await roll.click();
        await page.waitForTimeout(2200);
        await page.screenshot({ path: 'shots/betrayal-omen-03-haunt.png' });
      }
    }
  });

  await shoot('haunt_eye', 'eye', async page => {
    const attack = page.locator('.act[data-fan-label*="攻击"], .act:has-text("攻击")').first();
    if (await attack.count()) {
      await attack.click();
      await page.waitForTimeout(700);
      await page.screenshot({ path: 'shots/betrayal-eye-02-attack.png' });
    }
  });

  await shoot('haunt_phantom', 'phantom', async page => {
    const search = page.locator('.act[data-fan-label*="搜寻怨灵遗骨"], .act:has-text("搜寻怨灵遗骨")').first();
    if (await search.count()) {
      await search.click();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: 'shots/betrayal-phantom-02-bones.png' });
    }
  });
} finally {
  console.log('ERRORS:', errors.length ? JSON.stringify(errors, null, 2) : 'none');
  await browser.close();
}
