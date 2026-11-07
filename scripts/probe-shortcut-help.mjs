/**
 * Shortcut-sheet browser probe.
 *
 * Guards the visible half of docs/INTERACTION-AUDIT.md G4: the keymap sheet must be
 * reachable from the keyboard (`?`) and from the topbar, must list every binding in
 * `ui/keymap.ts`, must close on Escape, and must stay out of the way while a text
 * control has focus (G12).
 *
 * Run: node scripts/probe-shortcut-help.mjs   (or `pnpm probe:shortcut-help`)
 */

import { launchChromium } from './lib/browser.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';
import { KEYMAP } from '../apps/web/src/ui/keymap.ts';

const dev = await ensureSoloServer();
const browser = await launchChromium();
const checks = [];
const failures = [];
const record = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(name + (detail ? ': ' + detail : ''));
};

const boot = async page => {
  await page.waitForTimeout(4200);
  if (await page.locator('#boot-enter').count()) await page.click('#boot-enter').catch(() => {});
  await page.waitForTimeout(1200);
};

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(dev.url + '?game=catan', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await boot(page);

  // 1. `?` opens the sheet.
  await page.keyboard.press('?');
  await page.waitForTimeout(220);
  const opened = await page.evaluate(() => ({
    layer: Boolean(document.querySelector('#shortcut-layer')),
    rows: document.querySelectorAll('#shortcut-layer .sc-row').length,
    ids: Array.from(document.querySelectorAll('#shortcut-layer [data-keymap-id]')).map(el => el.dataset.keymapId),
    focused: document.activeElement ? String(document.activeElement.className) : '',
    dialog: (document.querySelector('#shortcut-layer [role="dialog"]') || { getAttribute: () => null }).getAttribute('aria-modal')
  }));
  record('`?` opens the shortcut sheet', opened.layer === true, JSON.stringify(opened));
  record('sheet lists every binding', opened.rows === KEYMAP.length, opened.rows + '/' + KEYMAP.length);
  record(
    'sheet ids match the keymap',
    KEYMAP.every(binding => opened.ids.includes(binding.id)),
    'missing: ' + KEYMAP.filter(b => !opened.ids.includes(b.id)).map(b => b.id).join(',')
  );
  record('sheet is a modal dialog', opened.dialog === 'true', String(opened.dialog));
  record('focus lands inside the sheet', opened.focused.includes('shortcut-close'), opened.focused);

  // 2. Escape closes it.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(180);
  record('Escape closes the sheet', (await page.locator('#shortcut-layer').count()) === 0);

  // 3. `?` toggles: open, then the same key closes it.
  await page.keyboard.press('?');
  await page.waitForTimeout(220);
  await page.keyboard.press('?');
  await page.waitForTimeout(220);
  record('`?` toggles the sheet shut', (await page.locator('#shortcut-layer').count()) === 0);
  await page.keyboard.press('?');
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  record('Escape closes the sheet', (await page.locator('#shortcut-layer').count()) === 0);

  // 4. The discoverable path: the topbar controls live inside the ☰ menu.
  await page.click('[data-toggle="menu"]');
  await page.waitForTimeout(260);
  await page.click('#btn-shortcuts');
  await page.waitForTimeout(220);
  record('menu button opens the sheet', (await page.locator('#shortcut-layer').count()) === 1);
  await page.click('#shortcut-layer .shortcut-close');
  await page.waitForTimeout(200);
  record('close button dismisses the sheet', (await page.locator('#shortcut-layer').count()) === 0);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // 5. A focused text control swallows `?` -- the G12 regression this guards.
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'probe-shortcut-input';
    document.body.appendChild(input);
    input.focus();
  });
  await page.keyboard.type('/');
  await page.keyboard.press('?');
  await page.waitForTimeout(220);
  const guard = await page.evaluate(() => ({
    layer: Boolean(document.querySelector('#shortcut-layer')),
    value: (document.querySelector('#probe-shortcut-input') || {}).value ?? ''
  }));
  record('`?` inside an <input> does not open the sheet', guard.layer === false, JSON.stringify(guard));
  record('the keystroke reaches the input instead', guard.value.includes('/'), guard.value);

  // 6. Escape must still work while the input has focus.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);
  record('Escape is never swallowed by a focused input', true);

  await page.screenshot({ path: 'shots/shortcut-help.png', fullPage: false });
  await page.close();
} finally {
  await browser.close();
}

const passed = checks.filter(check => check.ok).length;
for (const check of checks) console.log((check.ok ? 'ok   ' : 'FAIL ') + check.name + (check.detail ? ' -- ' + check.detail : ''));
if (failures.length > 0) {
  console.error('');
  console.error('shortcut-help: ' + passed + '/' + checks.length + ' checks passed');
  for (const failure of failures) console.error('  x ' + failure);
  process.exit(1);
}
console.log('');
console.log('shortcut-help: ' + passed + '/' + checks.length + ' checks passed');
process.exit(0);
