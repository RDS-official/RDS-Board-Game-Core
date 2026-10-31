import { launchChromium } from './lib/browser.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';

/**
 * Layout probe (docs/UI-ARCHITECTURE.md §5).
 *
 * The UI matrix only proves the page opens and clicks work; it cannot catch an
 * overlapping panel, a zero-width dock or 10px body text. This probe asserts the
 * geometry and readability floors across the aspect ratios the product targets
 * (16:9, 16:10, 3:2, 4:3) plus a portrait tablet and a phone.
 *
 * Slide-over panels are measured in BOTH states: a closed drawer is hidden from
 * the probe, so measuring only the default state would assert nothing about the
 * panels living inside it.
 */
const dev = await ensureSoloServer();
const browser = await launchChromium();

const VIEWPORTS = [
  { name: '16:9  desktop', w: 1920, h: 1080 },
  { name: '16:10 desktop', w: 1680, h: 1050 },
  { name: '3:2   laptop ', w: 1440, h: 960 },
  { name: '4:3   monitor', w: 1280, h: 960 },
  { name: '4:3   small  ', w: 1024, h: 768 },
  { name: '3:2   tablet ', w: 820, h: 1180 },
  { name: 'phone      ', w: 390, h: 844 }
];

const MIN_FONT_PX = 12;
const MIN_TOUCH_PX = 44;
const OVERLAP_TOLERANCE = 4;

const failures = [];
let checks = 0;

/** Runs in the page: measure every visible panel and the text/touch floors. */
const measure = ({ minFont, minTouch, tol }) => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const box = el => {
    const r = el.getBoundingClientRect();
    return { t: r.top, l: r.left, w: r.width, h: r.height, b: r.bottom, r: r.right };
  };
  const panels = {};
  const overlays = new Set();
  for (const [key, sel] of Object.entries({
    rail: '#player-rail',
    room: '#room-card',
    mini: '#mansion-minimap',
    feed: '#activity-feed',
    dock: '#action-dock'
  })) {
    const el = document.querySelector(sel);
    if (!el) continue;
    // Skip anything hidden, including via a closed slide-over ancestor.
    let hidden = false;
    let node = el;
    while (node) {
      const s = getComputedStyle(node);
      if (s.display === 'none' || s.visibility === 'hidden') { hidden = true; break; }
      node = node.parentElement;
    }
    if (hidden) continue;
    const b = box(el);
    if (b.w < 1 || b.h < 1) continue;
    panels[key] = b;
    if (getComputedStyle(el).position === 'fixed') overlays.add(key);
  }

  const overflow = [];
  for (const [k, b] of Object.entries(panels)) {
    if (b.l < -1 || b.r > vw + 1) overflow.push(`${k}:x`);
    if (b.t < -1 || b.b > vh + 1) overflow.push(`${k}:y`);
  }

  const overlaps = [];
  // Overlays (slide-overs, drawers) legitimately cover the board, so they are
  // excluded here and checked for containment instead.
  const keys = Object.keys(panels).filter(k => !overlays.has(k));
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = panels[keys[i]];
      const b = panels[keys[j]];
      const oy = Math.min(a.b, b.b) - Math.max(a.t, b.t);
      const ox = Math.min(a.r, b.r) - Math.max(a.l, b.l);
      if (oy > tol && ox > tol) overlaps.push(`${keys[i]}x${keys[j]}(${Math.round(ox)}x${Math.round(oy)})`);
    }
  }

  const small = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim();
    if (!text) continue;
    const parent = node.parentElement;
    if (!parent || seen.has(parent)) continue;
    seen.add(parent);
    const style = getComputedStyle(parent);
    if (style.display === 'none' || style.visibility === 'hidden' || +style.opacity === 0) continue;
    const rect = parent.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    const size = parseFloat(style.fontSize);
    if (Number.isFinite(size) && size < minFont - 0.01) small.push(`${parent.className || parent.tagName}:${size}px`);
  }

  const tiny = [];
  const narrow = vw < 900;
  for (const el of document.querySelectorAll('button, [role="button"]')) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (r.height < minTouch || r.width < minTouch) tiny.push(`${el.className || el.tagName}:${Math.round(r.width)}x${Math.round(r.height)}`);
  }

  // ---- topbar: must fit its own box and never overlap itself --------------
  // 顶栏是唯一「内容多到需要按宽度做减法」的容器；曾因 slide-over 面板占用
  // 网格轨道、行高写死、以及 1024px 直接 display:none 掉游戏页签，
  // 出现内容溢出到屏幕外与控件互相重叠（实测 1610px 溢出 139px）。
  let topbar = null;
  const bar = document.querySelector('.topbar');
  if (bar) {
    const barBox = box(bar);
    const visible = el => {
      if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') return false;
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden';
    };
    const leaves = [...bar.querySelectorAll(
      '.brand, .game-switch, .scenario-switch, .viewer-switch, .cam-switch, .icon-btn, .shell-toggle'
    )].filter(visible);

    const selfOverlaps = [];
    for (let i = 0; i < leaves.length; i++) {
      for (let j = i + 1; j < leaves.length; j++) {
        const a = leaves[i];
        const c = leaves[j];
        // 父子关系不算重叠；不同行（换行）也不算重叠。
        if (a.contains(c) || c.contains(a)) continue;
        const ba = box(a);
        const bc = box(c);
        const oy = Math.min(ba.b, bc.b) - Math.max(ba.t, bc.t);
        const ox = Math.min(ba.r, bc.r) - Math.max(ba.l, bc.l);
        if (oy > tol && ox > tol) {
          const label = el => (el.className || el.id || el.tagName).toString().split(' ')[0];
          selfOverlaps.push(`${label(a)}x${label(c)}(${Math.round(ox)}x${Math.round(oy)})`);
        }
      }
    }

    // 顶栏内容不得溢出自己的盒子（scrollWidth 超出即内容跑到栏外）。
    const inner = leaves.length
      ? Math.max(...leaves.map(el => box(el).r)) - Math.min(...leaves.map(el => box(el).l))
      : 0;
    const spills = [];
    for (const el of leaves) {
      const b2 = box(el);
      if (b2.r > barBox.r + 1 || b2.l < barBox.l - 1) {
        spills.push((el.className || el.id || el.tagName).toString().split(' ')[0]);
      }
    }

    topbar = {
      h: Math.round(barBox.h),
      w: Math.round(barBox.w),
      scrollOverflow: bar.scrollWidth - bar.clientWidth,
      innerWidth: Math.round(inner),
      controls: leaves.length,
      selfOverlaps: [...new Set(selfOverlaps)].slice(0, 6),
      spills: [...new Set(spills)].slice(0, 6)
    };
  }

  const dock = panels.dock ?? null;
  return {
    ratio: +(vw / vh).toFixed(3),
    topbar,
    panels: Object.keys(panels),
    overlays: [...overlays],
    overflow,
    overlaps,
    small: [...new Set(small)].slice(0, 8),
    smallCount: small.length,
    tiny: narrow ? [...new Set(tiny)].slice(0, 6) : [],
    tinyCount: narrow ? tiny.length : 0,
    dockCollapsed: !!dock && (dock.w < 40 || dock.h < 40)
  };
};

for (const vp of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
  const errors = [];
  const isEnvNoise = t => /\/healthz/i.test(t) || /status of 502/i.test(t);
  page.on('pageerror', e => {
    if (!isEnvNoise(e.message)) errors.push(e.message);
  });
  page.on('console', m => {
    if (m.type() !== 'error') return;
    if (isEnvNoise(m.text())) return;
    errors.push(m.text());
  });

  const tag = `${vp.name} ${vp.w}x${vp.h}`;
  try {
    await page.goto(`${dev.url}?game=betrayal&scenario=exploration`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await page.waitForTimeout(4200);
    if (await page.locator('#boot-enter').count()) await page.click('#boot-enter').catch(() => {});
    await page.waitForTimeout(2000);

    // Guard against the lobby: without this the game DOM never mounts and every
    // assertion below would pass vacuously.
    const mounted = await page.evaluate(() => ({
      dock: !!document.querySelector('#action-dock'),
      canvas: !!document.querySelector('canvas'),
      lobbyVisible: (() => {
        const l = document.querySelector('#lobby-root');
        return l ? !l.hidden : false;
      })()
    }));
    if (!mounted.dock || !mounted.canvas || mounted.lobbyVisible) {
      failures.push(`${tag}: never reached the game view (dock=${mounted.dock} canvas=${mounted.canvas} lobby=${mounted.lobbyVisible})`);
      await page.close();
      continue;
    }

    const opts = { minFont: MIN_FONT_PX, minTouch: MIN_TOUCH_PX, tol: OVERLAP_TOLERANCE };

    const state = async label => {
      const report = await page.evaluate(measure, opts);
      checks++;
      const problems = [];
      if (report.overflow.length) problems.push(`overflow ${report.overflow.join(',')}`);
      if (report.overlaps.length) problems.push(`overlap ${report.overlaps.join(',')}`);
      if (report.dockCollapsed) problems.push('dock collapsed');
      if (report.smallCount) problems.push(`${report.smallCount} small fonts (${report.small.slice(0, 4).join(', ')})`);
      if (report.tinyCount) problems.push(`${report.tinyCount} small touch targets (${report.tiny.slice(0, 3).join(', ')})`);

      // 顶栏：控件不得互相重叠、不得溢出自己的盒子；宽桌面必须是单行。
      const tb = report.topbar;
      if (!tb) {
        problems.push('topbar missing');
      } else {
        if (tb.selfOverlaps.length) problems.push(`topbar overlap ${tb.selfOverlaps.join(',')}`);
        if (tb.spills.length) problems.push(`topbar spill ${tb.spills.join(',')}`);
        if (tb.scrollOverflow > 1) problems.push(`topbar scroll overflow ${tb.scrollOverflow}px`);
        if (tb.w > 0 && tb.innerWidth > tb.w + 1) problems.push(`topbar content wider than bar (${tb.innerWidth}>${tb.w})`);
        // >=1200px 时动作区必须收在一行内（顶栏高度不应显著超过基准 68px）。
        if (vp.w >= 1200 && tb.h > 80) problems.push(`topbar wrapped at ${vp.w}px (h=${tb.h})`);
      }
      if (problems.length) {
        failures.push(`${tag} [${label}] (${report.ratio}): ${problems.join(' | ')}`);
        console.log(`  x ${tag} [${label}]`);
        for (const p of problems) console.log(`      ${p}`);
      } else {
        const tbNote = report.topbar ? ` bar=${report.topbar.w}x${report.topbar.h}/${report.topbar.controls}ctl` : '';
        console.log(`  ok ${tag} [${label}] (${report.ratio}) - ${report.panels.join('+')}${tbNote}`);
      }
      return report;
    };

    const base = await state('default');
    if (base.panels.length === 0) failures.push(`${tag}: no panels measured`);

    // Tablet/phone: assert the side slide-over while it is actually open.
    if (vp.w < 1200) {
      const toggle = page.locator('[data-toggle="side"]');
      if (await toggle.count()) {
        await toggle.first().click();
        // 等 slide-over 真正落位：data-side='open' 且 transform 归零。
        // 只等固定时间会在过渡动画中量到平移中的矩形，从而误报「溢出」。
        await page
          .waitForFunction(
            () => {
              const shell = document.querySelector('.app-shell');
              if (shell?.getAttribute('data-side') !== 'open') return false;
              const el = document.querySelector('#side-column');
              if (!el) return false;
              const t = getComputedStyle(el).transform;
              return t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)';
            },
            { timeout: 5000 }
          )
          .catch(() => {});
        await page.waitForTimeout(120);
        const opened = await state('side open');
        if (!opened.panels.includes('room') && !opened.panels.includes('mini')) {
          failures.push(`${tag} [side open]: the slide-over exposed no side panels`);
        }
        await toggle.first().click();
        await page.waitForTimeout(260);
      } else {
        failures.push(`${tag}: no side toggle on a narrow shell`);
      }
    }

    // Phone: rail slide-over and the dock drawer.
    if (vp.w < 768) {
      const railToggle = page.locator('[data-toggle="rail"]');
      if (await railToggle.count()) {
        await railToggle.first().click();
        // 同样要等过渡结束再量（手机角色栏是 translateX 滑入）。
        await page
          .waitForFunction(
            () => {
              const shell = document.querySelector('.app-shell');
              if (shell?.getAttribute('data-rail') !== 'open') return false;
              const el = document.querySelector('#player-rail');
              if (!el) return false;
              const t = getComputedStyle(el).transform;
              return t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)';
            },
            { timeout: 5000 }
          )
          .catch(() => {});
        await page.waitForTimeout(120);
        const opened = await state('rail open');
        if (!opened.panels.includes('rail')) failures.push(`${tag} [rail open]: the rail did not appear`);
        await railToggle.first().click();
        await page.waitForTimeout(300);
      } else {
        failures.push(`${tag}: no rail toggle on the phone shell`);
      }

      const handle = page.locator('.dock-handle');
      if (await handle.count()) {
        await handle.first().click();
        await page.waitForTimeout(700);
        await state('dock open');
        const fan = await page.locator('.dock-fan .act').count();
        if (fan === 0) failures.push(`${tag} [dock open]: the drawer exposed no action cards`);
        await handle.first().click();
        await page.waitForTimeout(300);
      } else {
        failures.push(`${tag}: the phone shell has no dock handle`);
      }
    }

    if (errors.length) failures.push(`${tag}: console ${errors.slice(0, 2).join(' | ')}`);
  } catch (error) {
    failures.push(`${tag}: threw - ${error?.message ?? error}`);
  }
  await page.close();
}

console.log(`\nUI layout probe: ${VIEWPORTS.length} viewports, ${checks} state checks`);
if (failures.length) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const f of failures) console.log(`  x ${f}`);
  process.exitCode = 1;
} else {
  console.log('\nAll layout, readability and touch-target checks passed.');
}

await browser.close();
dev.stop();