import { launchChromium } from './lib/browser.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';
const __solo = await ensureSoloServer();

const URL = __solo.url;

const browser = await launchChromium();

const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

const errors = [];
page.on('console', msg => {
  if (msg.type() === 'error') errors.push(`[console] ${msg.text()}`);
});
page.on('pageerror', err => errors.push(`[pageerror] ${err.message}`));

await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2500);

// Enter the table
await page.click('#boot-enter').catch(() => {});
await page.waitForTimeout(2200);
await page.screenshot({ path: 'shots/01-catan.png' });

// Top-down inspection
await page.click('.cam-btn[data-cam="top"]').catch(() => {});
await page.waitForTimeout(900);
await page.screenshot({ path: 'shots/01b-catan-top.png' });
await page.click('.cam-btn[data-cam="iso"]').catch(() => {});
await page.waitForTimeout(700);

// Inspector tab checks (the panel now starts collapsed, so open it first)
await page.click('#btn-inspector').catch(() => {});
await page.waitForTimeout(400);
const tabs = ['STACK', 'FACTIONS', 'HOOKS', 'TIME'];
for (const tab of tabs) {
  await page.click(`.mip-tab[data-tab="${tab}"]`).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: `shots/02-inspector-${tab.toLowerCase()}.png` });
}
await page.click('.mip-tab[data-tab="G"]').catch(() => {});
await page.waitForTimeout(300);

// Roll dice
const rollBtn = page.locator('.act[data-fan-label*="掷骰子"], .act:has-text("掷骰子")').first();
if (await rollBtn.count()) {
  await rollBtn.click();
  await page.waitForTimeout(1600);
  await page.screenshot({ path: 'shots/03-catan-roll.png' });
}

// Switch to Sanguosha
await page.click('.game-pill[data-game="sanguosha"]');
await page.waitForTimeout(2200);
await page.screenshot({ path: 'shots/04-sanguosha.png' });

const strikeBtn = page.locator('.act[data-fan-label*="出【杀】"], .act:has-text("出【杀】")').first();
if (await strikeBtn.count()) {
  await strikeBtn.click();
  await page.waitForTimeout(1400);
  await page.screenshot({ path: 'shots/05-sanguosha-stack.png' });
  await page.click('.mip-tab[data-tab="STACK"]').catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'shots/05b-sanguosha-stack-panel.png' });
  const dodge = page.locator('.act[data-fan-label*="出【闪】"], .act:has-text("出【闪】")').first();
  if (await dodge.count()) {
    await dodge.click();
    await page.waitForTimeout(1400);
    await page.screenshot({ path: 'shots/06-sanguosha-resolved.png' });
  }
}

// Cognitive filter demo: switch to player 1 perspective
await page.selectOption('#viewer-select', 'p1').catch(() => {});
await page.waitForTimeout(900);
await page.screenshot({ path: 'shots/06b-sanguosha-masked.png' });
await page.selectOption('#viewer-select', 'GOD').catch(() => {});
await page.waitForTimeout(500);

// Splendor
await page.click('.game-pill[data-game="splendor"]');
await page.waitForTimeout(2200);
await page.screenshot({ path: 'shots/07-splendor.png' });

// Betrayal
await page.click('.game-pill[data-game="betrayal"]');
await page.waitForTimeout(2200);
await page.screenshot({ path: 'shots/08-betrayal.png' });
const explore = page.locator('.act[data-fan-label*="探索房门"], .act:has-text("探索房门")').first();
if (await explore.count()) {
  await explore.click();
  await page.waitForTimeout(1600);
  await page.screenshot({ path: 'shots/09-betrayal-explore.png' });
  const haunt = page.locator('.act[data-fan-label*="作祟检定"], .act:has-text("作祟检定")').first();
  if (await haunt.count()) {
    await haunt.click();
    await page.waitForTimeout(2400);
    await page.screenshot({ path: 'shots/10-betrayal-haunt.png' });
    await page.click('.mip-tab[data-tab="HOOKS"]').catch(() => {});
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'shots/10b-betrayal-hooks.png' });
    await page.click('.mip-tab[data-tab="FACTIONS"]').catch(() => {});
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'shots/10c-betrayal-factions.png' });
  }
}

// Dune & Mahjong
await page.click('.game-pill[data-game="dune_mahjong"]');
await page.waitForTimeout(2200);
await page.screenshot({ path: 'shots/11-dune.png' });

const openBattle = page.locator('.act[data-fan-label*="开启秘密战斗窗口"], .act:has-text("开启秘密战斗窗口")').first();
if (await openBattle.count()) {
  await openBattle.click();
  await page.waitForTimeout(900);
  const commitP1 = page.locator('.act[data-fan-label*="锁定战斗转盘"], .act:has-text("锁定战斗转盘")').first();
  if (await commitP1.count()) {
    await commitP1.click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: 'shots/11b-dune-secret.png' });
    const commitP2 = page.locator('.act[data-fan-label*="锁定战斗转盘"], .act:has-text("锁定战斗转盘")').first();
    if (await commitP2.count()) {
      await commitP2.click();
      await page.waitForTimeout(1600);
      await page.screenshot({ path: 'shots/11c-dune-reveal.png' });
    }
  }
}

console.log('ERRORS:', errors.length ? JSON.stringify(errors, null, 2) : 'none');

await browser.close();
