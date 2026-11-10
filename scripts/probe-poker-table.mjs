import { launchChromium } from './lib/browser.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';

/**
 * Poker table presentation probe.
 *
 * Pins the four things a reader of the table can actually see, all of which used
 * to be missing or misleading:
 *
 *  1. 筹码堆 / 牌堆默认收起，菜单里的开关能整组打开（`capabilities.tableFurniture`）；
 *  2. 自己的下注除了筹码堆，还有一行写明金额的标签；
 *  3. 近期动态里的加注要写出本次下了多少筹码；
 *  4. 声明了思考时限的玩法：行动者座位卡带读秒，自己最后 10 秒屏幕正中出大字。
 *
 * Run: node scripts/probe-poker-table.mjs
 */
const dev = await ensureSoloServer();
const browser = await launchChromium();

const failures = [];
let checks = 0;
const record = (name, ok, detail) => {
  checks += 1;
  if (!ok) failures.push(`${name}: ${detail}`);
};

const enter = async page => {
  await page.goto(`${dev.url}?game=poker&scenario=seats_4`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });
  await page.waitForTimeout(4200);
  if (await page.locator('#boot-enter').count()) await page.click('#boot-enter').catch(() => {});
  await page.waitForFunction(() => !!window.__boardGameApp, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1800);
};

/** 开一手，并走到「自己」能加注为止（其他人用跟注/过牌推进）。 */
const raiseOnce = async page =>
  page.evaluate(async () => {
    const app = window.__boardGameApp;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    /** 每一步的音频流水：动作 → 这一动作新响的声音。 */
    const steps = [];
    const perform = (id, payload, label) => {
      const before = (window.__audioLog ?? []).length;
      const done = app.session.perform(id, payload);
      steps.push({ action: label, cues: (window.__audioLog ?? []).slice(before) });
      return done;
    };
    const start = app.session.getSnapshot().actions.find(a => /发下一手|开始游戏/.test(a.label));
    if (start) perform(start.id, undefined, 'start');
    await sleep(500);
    for (let step = 0; step < 24; step += 1) {
      let acted = false;
      for (const seat of ['p1', 'p2', 'p3', 'p4']) {
        app.session.setViewer(seat);
        await sleep(50);
        const actions = app.session.getSnapshot().actions;
        if (!actions.length) continue;
        const raise = actions.find(a => a.label === '加注' || a.label === '下注');
        if (seat === 'p1' && raise) {
          const min = Number(raise.fields?.[0]?.min ?? raise.fields?.[0]?.minimum ?? 20);
          const done = perform(raise.id, { amount: min + 60 }, 'raise');
          return { ok: done.ok, error: done.error ?? null, steps };
        }
        const passive = actions.find(a => /跟注|过牌/.test(a.label));
        if (passive) {
          perform(passive.id, undefined, passive.label);
          acted = true;
          break;
        }
      }
      if (!acted) return { ok: false, error: 'table stalled before the viewer could act', steps };
      await sleep(90);
    }
    return { ok: false, error: 'no raise action found' };
  });

const labelsOf = page =>
  page.evaluate(() => {
    const out = [];
    window.__boardGameApp.scene.boardObjectsGroup?.traverse?.(obj => {
      if (obj.userData?.labelRole) out.push(`${obj.userData.labelRole}:${obj.userData.text ?? ''}`);
    });
    return out;
  });

/** 场景里某类家具实例的数量（缓存键前缀）。 */
const countFurniture = (page, prefix) =>
  page.evaluate(key => {
    let count = 0;
    window.__boardGameApp.scene.boardObjectsGroup?.traverse?.(obj => {
      if (String(obj.userData?.cacheKey ?? '').startsWith(key)) count += 1;
    });
    return count;
  }, prefix);

// ---- 桌面：道具默认收起 / 开关能打开 ----------------------------------------
const desktop = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await enter(desktop);
const raised = await raiseOnce(desktop);
record('table', raised.ok, raised.error ?? 'raise failed');
await desktop.evaluate(() => window.__boardGameApp.session.setViewer('p1'));
await desktop.waitForTimeout(600);

const hidden = await labelsOf(desktop);
const hiddenDeck = await countFurniture(desktop, 'pile:zone_deck');
record('furniture', hiddenDeck === 0, `the draw pile is on the table by default: ${hiddenDeck} meshes`);

// 筹码堆没被画出来：底池标签仍在（读数要留着），但场景里没有筹码网格。
const chipMeshes = await countFurniture(desktop, 'poker:stack');
record('furniture', chipMeshes === 0, `seat chip stacks are drawn while hidden: ${chipMeshes}`);

// ---- 自己的下注额标签 --------------------------------------------------------
record(
  'own-bet',
  hidden.some(entry => /^own-bet:已下注 \d+$/.test(entry)),
  `no own-bet label: ${hidden.join(', ')}`
);

// ---- 近期动态写明加注金额 ----------------------------------------------------
const feed = await desktop.evaluate(() =>
  (window.__boardGameApp.session.getSnapshot().history ?? []).slice(0, 4).map(entry => entry.title)
);
record(
  'feed',
  feed.some(title => /加注到 \d+（本次 \+\d+）/.test(title)),
  `the feed does not spell out the raise: ${feed.join(' | ')}`
);

// ---- 音效：动作各响一声，且不双响 --------------------------------------------
// 映射本身由 core 用例守着（`packages/app/src/betting.ts` 的纯函数）；这里只验接线：
// 真按一次加注，音频流水里正好多一条 `poker:raise`。
const steps = raised.steps ?? [];
const raiseStep = steps.find(step => step.action === 'raise');
record('audio', !!raiseStep, 'no raise step was recorded');
if (raiseStep) {
  record(
    'audio',
    raiseStep.cues.length === 1 && raiseStep.cues[0] === 'poker:raise',
    `a raise should ring exactly once as poker:raise, got ${JSON.stringify(raiseStep.cues)}`
  );
}
record(
  'audio',
  steps.every(step => step.cues.length <= 1),
  `some action rang twice: ${JSON.stringify(steps.filter(step => step.cues.length > 1))}`
);

// ---- 开关：真的把道具放回桌面 ------------------------------------------------
await desktop.click('[data-toggle="menu"]');
await desktop.waitForTimeout(400);
const toggleSeen = await desktop.locator('[data-table-furniture]').count();
record('furniture', toggleSeen === 1, 'the menu has no table-furniture switch');
if (toggleSeen) {
  await desktop.click('[data-table-furniture]');
  await desktop.waitForTimeout(200);
  const pressed = await desktop.getAttribute('[data-table-furniture]', 'aria-pressed');
  record('furniture', pressed === 'true', `the switch did not turn on: aria-pressed=${pressed}`);
  await desktop.click('[data-menu-close]');
  await desktop.waitForTimeout(900);
  const shownDeck = await countFurniture(desktop, 'pile:zone_deck');
  record('furniture', shownDeck > 0, `the draw pile did not come back: ${shownDeck} meshes`);
}

// ---- 行动者读秒 + 自己最后 10 秒正中大字 ------------------------------------
const watcher = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await enter(watcher);
await watcher.evaluate(() => {
  const app = window.__boardGameApp;
  const start = app.session.getSnapshot().actions.find(a => /发下一手|开始游戏/.test(a.label));
  if (start) app.session.perform(start.id);
});
await watcher.waitForTimeout(800);

const actor = await watcher.evaluate(() => {
  const app = window.__boardGameApp;
  const snap = app.session.getSnapshot();
  const id = snap.focus[0] ?? snap.focusActors[0];
  app.session.setViewer(id);
  return { id, deadlineMs: snap.turnDeadlineMs ?? null };
});
record('clock', typeof actor.deadlineMs === 'number' && actor.deadlineMs > 0, 'the snapshot carries no turn deadline');

await watcher.waitForTimeout(600);
const cardClock = await watcher.evaluate(id => {
  const card = document.querySelector(`#player-rail .pc[data-player-id="${id}"] .pc-clock`);
  return card?.textContent ?? '';
}, actor.id);
record('clock', /\d+s/.test(cardClock), `the acting seat has no countdown: "${cardClock}"`);

// 等到最后 10 秒：正中大字必须是白色数字。
let centre = { on: false, text: '', color: '' };
for (let i = 0; i < 26 && !centre.on; i += 1) {
  await watcher.waitForTimeout(1000);
  centre = await watcher.evaluate(() => {
    const el = document.querySelector('#turn-clock-centre');
    if (!el) return { on: false, text: '', color: '' };
    return {
      on: el.classList.contains('on'),
      text: el.textContent ?? '',
      color: getComputedStyle(el).color
    };
  });
}
record('clock', centre.on, 'the centre countdown never appeared in the last 10 seconds');
record('clock', /^(10|[1-9])$/.test(centre.text), `the centre countdown shows "${centre.text}"`);
record('clock', centre.color === 'rgb(255, 255, 255)', `the centre countdown is not white: ${centre.color}`);

// ---- 移动端：行动中的座位卡放大转红并带读秒 --------------------------------
const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await enter(phone);
await phone.evaluate(() => {
  const app = window.__boardGameApp;
  const start = app.session.getSnapshot().actions.find(a => /发下一手|开始游戏/.test(a.label));
  if (start) app.session.perform(start.id);
});
await phone.waitForTimeout(2000);
const mobile = await phone.evaluate(() => {
  const card = document.querySelector('#player-rail .pc.active');
  if (!card) return { active: false };
  const cardStyle = getComputedStyle(card);
  const avatar = getComputedStyle(card.querySelector('.pc-avatar'));
  return {
    active: true,
    border: cardStyle.borderTopColor,
    avatarWidth: Number.parseFloat(avatar.width),
    clock: card.querySelector('.pc-clock')?.textContent ?? '',
    idleWidth: Number.parseFloat(
      getComputedStyle(document.querySelector('#player-rail .pc:not(.active) .pc-avatar')).width
    )
  };
});
record('mobile', mobile.active, 'no acting seat card on the phone layout');
if (mobile.active) {
  record('mobile', mobile.border === 'rgb(239, 68, 68)', `the acting card is not red: ${mobile.border}`);
  record(
    'mobile',
    mobile.avatarWidth > mobile.idleWidth,
    `the acting avatar is not bigger: ${mobile.avatarWidth} vs ${mobile.idleWidth}`
  );
  record('mobile', /\d+s/.test(mobile.clock), `the acting card has no countdown: "${mobile.clock}"`);
}

// ---- 贴边泡泡：放大后的读秒角标必须是元素，不是被转义出来的字面量 ----------------
// 泡泡的标记走 `html` 模板（不是 innerHTML 字符串），普通字符串插值会被转义成
// 文本——头像放大后用户看到的就是一串 `<span ...>`。
const bubbleMarkup = await phone.evaluate(() => {
  const layer = document.querySelector('#seat-bubbles');
  if (!layer) return { present: false, leaked: '' };
  const leaked = /<span|<div|<button/i.exec(layer.textContent ?? '')?.[0] ?? '';
  const clock = layer.querySelector('.seat-bubble .sb-clock');
  return {
    present: layer.childElementCount > 0,
    leaked,
    clockIsElement: !!clock,
    clockStyle: clock ? getComputedStyle(clock).position : ''
  };
});
if (bubbleMarkup.present) {
  record('bubble', !bubbleMarkup.leaked, `markup leaked into the seat bubble as text: "${bubbleMarkup.leaked}"`);
  record('bubble', bubbleMarkup.clockIsElement !== false, 'the bubble clock is not a real element');
}

console.log(`\nPoker table probe: ${checks} checks`);
if (failures.length) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const failure of failures) console.log(`  x ${failure}`);
  process.exitCode = 1;
} else {
  console.log('\nTable furniture, bet label, feed amount, turn clock and the phone seat card all behave.');
}

await browser.close();
dev.stop();
