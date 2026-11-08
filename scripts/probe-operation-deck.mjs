/**
 * Operation-deck probe (?zones).
 *
 * Verifies the new hand/verb separation without touching the legacy paths:
 *   - hand cards are physical entities (data-kind=hand), never commands;
 *   - the command rail owns END_TURN/ROLL/READY, and overflows into a menu;
 *   - board verbs live in the context row;
 *   - response/decision prompts render as a tray, not as hand cards;
 *   - no hand -> no hand panel (Catan/Splendor/Poker start states);
 *   - 390px viewport does not overflow.
 *
 * Run: node scripts/probe-operation-deck.mjs
 */

import { launchChromium } from './lib/browser.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';

const failures = [];
const checks = [];
const record = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(name + (detail ? ': ' + detail : ''));
};

const dev = await ensureSoloServer();
const browser = await launchChromium();

async function openPage(viewport = { width: 1440, height: 900 }) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  return { page, errors };
}

async function openGame(page, game) {
  await page.goto(dev.url + '?game=' + game + '&zones', { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (await page.locator('#boot-enter').count()) await page.click('#boot-enter').catch(() => {});
  await page.waitForSelector('#operation-deck[data-enabled="1"]', { timeout: 30000 });
  await page.waitForTimeout(700);
}

/* ---- 1. Sanguosha: hand entities + verb menu + radial ---- */
{
  const { page, errors } = await openPage();
  await openGame(page, 'sanguosha');
  const state = await page.evaluate(() => {
    const q = s => document.querySelector(s);
    const qa = s => [...document.querySelectorAll(s)];
    return {
      mode: q('#hud-container')?.dataset.hand,
      handCards: qa('#action-hand .ah-hand').length,
      commandCardsInHand: qa('#action-hand .ah-card[data-kind="command"]').length,
      commands: qa('#op-commands [data-op-action]').map(el => el.textContent.trim()),
      equip: qa('#op-equip [data-op-entity]').length
    };
  });
  record('sanguosha: zones mode active', state.mode === 'zones', state.mode);
  record('sanguosha: hand renders physical cards', state.handCards >= 4, String(state.handCards));
  record('sanguosha: no command card leaks into hand', state.commandCardsInHand === 0, String(state.commandCardsInHand));
  record('sanguosha: command rail owns END_TURN', state.commands.some(label => label.includes('结束回合')), state.commands.join('|'));
  record('sanguosha: equipment is a separate strip', state.equip >= 1, String(state.equip));

  await page.locator('#action-hand .ah-hand').first().click({ force: true });
  await page.waitForTimeout(150);
  const verbs = await page.locator('.hand-verb-menu button').allTextContents();
  record('sanguosha: a multi-verb card opens a verb menu', verbs.length >= 2, verbs.join('|'));
  if (verbs.length > 0) {
    await page.locator('.hand-verb-menu button').first().click({ force: true });
    await page.waitForTimeout(300);
    record('sanguosha: play opens the target wheel', (await page.locator('.rp-layer').count()) > 0);
    await page.keyboard.press('Escape');
  }
  const handBeforeDrag = await page.locator('#action-hand .ah-hand').count();
  const cardBox = await page.locator('#action-hand .ah-hand').first().boundingBox();
  if (cardBox) {
    await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(cardBox.x + cardBox.width / 2 + 60, cardBox.y + cardBox.height / 2 - 40, { steps: 5 });
    await page.waitForTimeout(350);
    const segment = await page.locator('.rp-seg').first().boundingBox();
    if (segment) {
      await page.mouse.move(segment.x + segment.width / 2, segment.y + segment.height / 2, { steps: 6 });
      await page.waitForTimeout(120);
    }
    await page.mouse.up();
    await page.waitForTimeout(900);
  }
  const handAfterDrag = await page.locator('#action-hand .ah-hand').count();
  record('sanguosha: drag-to-target actually plays the card', handAfterDrag < handBeforeDrag, handBeforeDrag + ' -> ' + handAfterDrag);

  record('sanguosha: no page errors', errors.length === 0, errors.join('; '));
  await page.close();
}

/* ---- 1b. GOD view: the victim can answer from the prompt or the hand ---- */
{
  const { page, errors } = await openPage();
  await openGame(page, 'sanguosha');
  await page.evaluate(() => {
    const el = document.querySelector('#viewer-select');
    if (el) {
      el.value = 'GOD';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await page.waitForTimeout(500);
  await page.locator('#action-hand .ah-hand').first().click({ force: true });
  await page.waitForTimeout(120);
  await page.locator('.hand-verb-menu button').first().click({ force: true });
  await page.waitForTimeout(250);
  await page.locator('.rp-seg').first().click({ force: true });
  await page.waitForTimeout(700);
  const response = await page.evaluate(() => ({
    promptVisible: !document.querySelector('#op-prompt')?.hidden,
    options: [...document.querySelectorAll('#op-prompt [data-op-action]')].map(el => el.textContent.trim()),
    playableCards: document.querySelectorAll('#action-hand .ah-hand[data-playable="1"]').length,
    handCount: document.querySelectorAll('#action-hand .ah-hand').length
  }));
  record('response: prompt tray lists the victim response', response.promptVisible && response.options.length > 0, JSON.stringify(response));
  record('response: the physical dodge card is clickable', response.playableCards > 0, JSON.stringify(response));
  const dodge = page.locator('#action-hand .ah-hand[data-playable="1"]').first();
  if (await dodge.count()) {
    await dodge.click({ force: true });
    await page.waitForTimeout(800);
  }
  const after = await page.evaluate(() => ({
    promptVisible: !document.querySelector('#op-prompt')?.hidden,
    handCount: document.querySelectorAll('#action-hand .ah-hand').length
  }));
  record('response: playing the dodge card resolves the window', !after.promptVisible && after.handCount < response.handCount, JSON.stringify(after));
  record('response: no page errors', errors.length === 0, errors.join('; '));
  await page.close();
}

/* ---- 2. Catan: no hand panel; board verbs in context ---- */
{
  const { page, errors } = await openPage();
  await openGame(page, 'catan');
  const state = await page.evaluate(() => ({
    handEnabled: document.querySelector('#action-hand')?.dataset.enabled,
    handCards: document.querySelectorAll('#action-hand .ah-hand').length,
    context: [...document.querySelectorAll('#op-context [data-op-action]')].map(el => el.textContent.trim())
  }));
  record('catan: no hand -> hand panel hidden', state.handEnabled === '0' && state.handCards === 0, JSON.stringify(state));
  record('catan: setup settlement is a board verb', state.context.some(label => label.includes('选择起始定居点')), state.context.join('|'));
  if (state.context.length > 0) {
    await page.locator('#op-context [data-op-action]').first().click({ force: true });
    await page.waitForTimeout(300);
    const toast = await page.locator('#toast-container').innerText();
    record('catan: board verb arms a highlighted group', toast.includes('高亮'), toast);
  }
  record('catan: no page errors', errors.length === 0, errors.join('; '));
  await page.close();
}

/* ---- 3. Splendor: token choices are one family, not N actions ---- */
{
  const { page, errors } = await openPage();
  await openGame(page, 'splendor');
  const commands = await page.locator('#op-commands [data-op-action]').allTextContents();
  record('splendor: token take is one action family', commands.filter(label => label.includes('拿取精灵球')).length === 1, commands.join('|'));
  record('splendor: double take is one action family', commands.filter(label => label.includes('双取同色')).length === 1, commands.join('|'));
  record('splendor: color combinations are not enumerated', !commands.some(label => label.includes('拿走 2 个')), commands.join('|'));

  const take = page.locator('#op-commands [data-op-action]', { hasText: '拿取精灵球' }).first();
  await take.click({ force: true });
  await page.waitForTimeout(250);
  const picker = await page.evaluate(() => ({
    title: document.querySelector('.pf-title')?.textContent ?? '',
    label: document.querySelector('.pf-label')?.textContent ?? '',
    colors: [...document.querySelectorAll('#payload-layer .pf-target')].map(el => el.textContent?.trim())
  }));
  record('splendor: token picker opens with color choices', picker.title.includes('拿取精灵球') && picker.colors.length >= 5, JSON.stringify(picker));
  record('splendor: token picker asks for colors', picker.label.includes('选择颜色'), picker.label);

  const boxes = page.locator('#payload-layer [data-target]');
  for (let i = 0; i < 3; i++) await boxes.nth(i).check({ force: true });
  await page.locator('#payload-layer button[type="submit"]').click({ force: true });
  await page.waitForTimeout(900);
  const toast = await page.evaluate(() => [...document.querySelectorAll('.toast')].map(el => el.textContent ?? '').join(' | '));
  record('splendor: choosing three colors dispatches once', toast.includes('收服 3 颗精灵球'), toast);
  record('splendor: no page errors', errors.length === 0, errors.join('; '));
  await page.close();
}

/* ---- 4. Dune: decision prompt is a tray, not hand cards ---- */
{
  const { page, errors } = await openPage();
  await openGame(page, 'dune_mahjong');
  const commands = await page.locator('#op-commands [data-op-action]').allTextContents();
  record('dune: battle command is in the rail', commands.some(label => label.includes('开启秘密战斗窗口')), commands.join('|'));
  if (commands.length > 0) {
    await page.locator('#op-commands [data-op-action]').first().click({ force: true });
    await page.waitForTimeout(400);
    const prompt = await page.evaluate(() => ({
      visible: !document.querySelector('#op-prompt')?.hidden,
      title: document.querySelector('#op-prompt strong')?.textContent ?? '',
      options: [...document.querySelectorAll('#op-prompt [data-op-action]')].map(el => el.textContent.trim()),
      handCards: document.querySelectorAll('#action-hand .ah-hand').length
    }));
    record('dune: decision renders in the prompt tray', prompt.visible && prompt.title.length > 0, JSON.stringify(prompt));
    record('dune: prompt options are bounded', prompt.options.length > 0 && prompt.options.length <= 4, String(prompt.options.length));
    record('dune: prompt does not become hand cards', prompt.handCards === 0, String(prompt.handCards));
  }
  record('dune: no page errors', errors.length === 0, errors.join('; '));
  await page.close();
}

/* ---- 5. Poker: start hand -> hole cards, no action cards ---- */
{
  const { page, errors } = await openPage();
  await openGame(page, 'poker');
  const before = await page.locator('#action-hand .ah-hand').count();
  const commands = await page.locator('#op-commands [data-op-action]').allTextContents();
  if (commands.length > 0) {
    await page.locator('#op-commands [data-op-action]').first().click({ force: true });
    await page.waitForTimeout(1500);
  }
  const after = await page.locator('#action-hand .ah-hand').count();
  record('poker: no hand before the deal', before === 0, String(before));
  record('poker: deal puts exactly the hole cards in hand', after === 2, String(after));
  record('poker: no page errors', errors.length === 0, errors.join('; '));
  await page.close();
}

/* ---- 5b. Switching fixtures must clear the old physical hand ---- */
{
  const { page, errors } = await openPage();
  await openGame(page, 'sanguosha');
  const before = await page.locator('#action-hand .ah-hand').count();
  await page.evaluate(() => document.querySelector('[data-game="poker"]')?.click());
  await page.waitForTimeout(2200);
  const stale = await page.evaluate(() => ({
    enabled: document.querySelector('#action-hand')?.dataset.enabled,
    children: document.querySelector('#action-hand')?.children.length ?? -1,
    cards: document.querySelectorAll('#action-hand .ah-hand').length
  }));
  record('switch: old hand is cleared before the new game', stale.children === 0 && stale.cards === 0, JSON.stringify(stale));
  const commands = await page.locator('#op-commands [data-op-action]').allTextContents();
  record('switch: poker shows its start command', commands.some(label => label.includes('立即开始')), commands.join('|'));
  if (commands.length > 0) {
    await page.locator('#op-commands [data-op-action]').first().click({ force: true });
    await page.waitForTimeout(1500);
  }
  const poker = await page.evaluate(() => ({
    cards: [...document.querySelectorAll('#action-hand .ah-hand')].map(el => el.dataset.entityId),
    stale: [...document.querySelectorAll('#action-hand .ah-hand')].some(el => String(el.dataset.entityId).startsWith('sgs_'))
  }));
  record('switch: poker deals only its own hole cards', poker.cards.length === 2 && !poker.stale, JSON.stringify(poker));
  record('switch: no page errors', errors.length === 0, errors.join('; '));
  record('switch: previous hand existed', before >= 4, String(before));
  await page.close();
}

/* ---- 6. Default zones + menu switch to traditional ---- */
{
  const { page, errors } = await openPage();
  await page.goto(dev.url + '?game=sanguosha', { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (await page.locator('#boot-enter').count()) await page.click('#boot-enter').catch(() => {});
  await page.waitForSelector('#operation-deck[data-enabled="1"]', { timeout: 30000 });
  await page.waitForTimeout(700);
  const initial = await page.evaluate(() => ({
    mode: document.querySelector('#hud-container')?.dataset.hand,
    hand: document.querySelectorAll('#action-hand .ah-hand').length
  }));
  record('default: zones is the opening mode', initial.mode === 'zones' && initial.hand > 0, JSON.stringify(initial));

  await page.locator('[data-toggle="menu"]').click({ force: true });
  await page.waitForTimeout(200);
  const menu = await page.evaluate(() => ({
    open: !!document.querySelector('#menu-dialog'),
    modes: [...document.querySelectorAll('[data-hand-mode]')].map(el => ({
      mode: el.dataset.handMode,
      pressed: el.getAttribute('aria-pressed')
    }))
  }));
  record('menu: both hand modes are offered', menu.open && menu.modes.length === 2, JSON.stringify(menu));
  record('menu: zones is pressed by default', menu.modes.find(item => item.mode === 'zones')?.pressed === 'true', JSON.stringify(menu.modes));

  await page.locator('[data-hand-mode="legacy"]').click({ force: true });
  await page.waitForTimeout(650);
  const legacy = await page.evaluate(() => ({
    mode: document.querySelector('#hud-container')?.dataset.hand,
    deck: document.querySelector('#operation-deck')?.dataset.enabled,
    hand: document.querySelectorAll('#action-hand .ah-hand').length,
    dockHeight: document.querySelector('#action-dock')?.getBoundingClientRect().height ?? 0
  }));
  record('menu: traditional mode restores the dock', legacy.mode === 'legacy' && legacy.deck === '0' && legacy.dockHeight > 0, JSON.stringify(legacy));

  await page.locator('[data-toggle="menu"]').click({ force: true });
  await page.waitForTimeout(150);
  await page.locator('[data-hand-mode="zones"]').click({ force: true });
  await page.waitForTimeout(650);
  const zones = await page.evaluate(() => ({
    mode: document.querySelector('#hud-container')?.dataset.hand,
    deck: document.querySelector('#operation-deck')?.dataset.enabled,
    hand: document.querySelectorAll('#action-hand .ah-hand').length
  }));
  record('menu: switching back restores the operation deck', zones.mode === 'zones' && zones.deck === '1' && zones.hand > 0, JSON.stringify(zones));
  record('menu: no page errors', errors.length === 0, errors.join('; '));
  await page.close();
}

/* ---- 5b. Mobile: hand and deck dock to the visual viewport ---- */
{
  const { page, errors } = await openPage({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await openGame(page, 'sanguosha');
  const state = await page.evaluate(() => {
    const rect = selector => {
      const el = document.querySelector(selector);
      return el ? el.getBoundingClientRect().toJSON() : null;
    };
    const cards = [...document.querySelectorAll('#action-hand .ah-card')].map(el => el.getBoundingClientRect().toJSON());
    return {
      appHeight: getComputedStyle(document.querySelector('#app')).height,
      hand: rect('#action-hand'),
      deck: rect('#operation-deck'),
      cards,
      overflowX: document.documentElement.scrollWidth > innerWidth,
      overflowY: document.documentElement.scrollHeight > innerHeight + 1
    };
  });
  record('mobile: app height follows the visual viewport', state.appHeight === '844px', state.appHeight);
  record('mobile: hand is docked inside the viewport', !!state.hand && state.hand.bottom <= 844 && state.hand.y >= 0, JSON.stringify(state.hand));
  record('mobile: operation deck sits above the hand', !!state.deck && state.deck.bottom <= (state.hand?.y ?? 844) + 1, JSON.stringify(state.deck));
  record('mobile: hand cards are visible and opaque', state.cards.length > 0 && state.cards.every(c => c.y >= 0 && c.bottom <= 844 && c.width > 0), JSON.stringify(state.cards.map(c => ({ y: Math.round(c.y), h: Math.round(c.height) }))));
  record('mobile: no page overflow', !state.overflowX && !state.overflowY, JSON.stringify({ x: state.overflowX, y: state.overflowY }));
  record('mobile: no page errors', errors.length === 0, errors.join('; '));
  await page.close();
}

/* ---- 5c. Bottom UI must not depend on a truthful viewport ---- */
{
  // 第三方浏览器（Via 等）会把自家工具栏算进 innerHeight / visualViewport，
  // absolute 贴底的 UI 就被切掉半截。手牌与操作台必须锚定真实视口。
  const { page, errors } = await openPage({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await openGame(page, 'sanguosha');
  const anchored = await page.evaluate(() => ({
    hand: getComputedStyle(document.querySelector('#action-hand')).position,
    deck: getComputedStyle(document.querySelector('#operation-deck')).position
  }));
  record(
    'mobile: hand and deck are viewport-anchored',
    anchored.hand === 'fixed' && anchored.deck === 'fixed',
    JSON.stringify(anchored)
  );
  record('mobile: anchored layout has no page errors', errors.length === 0, errors.join('; '));
  await page.close();
}

{
  // 真实可视高度 740，但 JS 自报 821（复现 Via）：贴底手牌仍须完整可见。
  const ctx = await browser.newContext({
    viewport: { width: 369, height: 740 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => 821 });
    const vv = window.visualViewport;
    if (vv) Object.defineProperty(vv, 'height', { configurable: true, get: () => 821 });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await openGame(page, 'sanguosha');
  const lying = await page.evaluate(() => {
    const realH = document.documentElement.clientHeight;
    const cards = [...document.querySelectorAll('#action-hand .ah-card')].map(el =>
      el.getBoundingClientRect().toJSON()
    );
    return {
      realH,
      reported: window.innerHeight,
      cards: cards.length,
      fullyVisible: cards.length > 0 && cards.every(card => card.top >= -2 && card.bottom <= realH + 2)
    };
  });
  record(
    'mobile: hand survives a browser that over-reports the viewport',
    lying.reported === 821 && lying.realH === 740 && lying.fullyVisible,
    JSON.stringify(lying)
  );
  record('mobile: lying-viewport layout has no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}
/* ---- 6. 390px: no horizontal overflow ---- */
{
  const { page, errors } = await openPage({ width: 390, height: 844 });
  await openGame(page, 'sanguosha');
  const state = await page.evaluate(() => {
    const deck = document.querySelector('#operation-deck')?.getBoundingClientRect();
    const hand = document.querySelector('#action-hand')?.getBoundingClientRect();
    return {
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      deck: deck ? { left: deck.left, right: deck.right } : null,
      hand: hand ? { left: hand.left, right: hand.right } : null
    };
  });
  record('phone: page has no horizontal overflow', state.scrollWidth <= state.viewport + 1, JSON.stringify(state));
  record('phone: deck stays inside the viewport', !!state.deck && state.deck.left >= -1 && state.deck.right <= state.viewport + 1, JSON.stringify(state.deck));
  record('phone: hand stays inside the viewport', !!state.hand && state.hand.left >= -1 && state.hand.right <= state.viewport + 1, JSON.stringify(state.hand));
  record('phone: no page errors', errors.length === 0, errors.join('; '));
  await page.close();
}

await browser.close();
dev.stop();

for (const check of checks) {
  console.log((check.ok ? 'ok   ' : 'FAIL ') + check.name + (check.detail ? ' -- ' + check.detail : ''));
}
console.log('\noperation-deck: ' + (checks.length - failures.length) + '/' + checks.length + ' checks passed');
if (failures.length > 0) {
  console.error('\nFailures:\n- ' + failures.join('\n- '));
  process.exitCode = 1;
}
