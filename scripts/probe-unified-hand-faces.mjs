import { launchChromium } from './lib/browser.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';

/**
 * Unified hand artwork + 3D de-duplication probe.
 *
 * In unified mode the camera-attached 3D hand must disappear, while every
 * entity-backed action uses the exact texture returned by the board renderer.
 * This is deliberately checked in Sanguosha, where many actions share card
 * faces but differ by target.
 *
 * Run: node scripts/probe-unified-hand-faces.mjs
 */

const dev = await ensureSoloServer();
const browser = await launchChromium();
const checks = [];
const failures = [];
const record = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
};

const boot = async page => {
  await page.waitForTimeout(4200);
  if (await page.locator('#boot-enter').count()) await page.click('#boot-enter').catch(() => {});
  await page.waitForTimeout(1800);
};

try {
  const plain = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await plain.goto(`${dev.url}?game=sanguosha`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await boot(plain);
  const legacy = await plain.evaluate(() => ({
    visible: window.__boardGameApp?.scene?.ownHandGroup?.visible,
    cards: window.__boardGameApp?.scene?.ownHandGroup?.children?.length ?? 0
  }));
  record('default: 3D own hand stays visible', legacy.visible === true, JSON.stringify(legacy));
  await plain.close();

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${dev.url}?game=sanguosha&unified-hand`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await boot(page);

  const faces = await page.evaluate(() => {
    const app = window.__boardGameApp;
    const snapshot = app?.session?.getSnapshot?.();
    const scene = app?.scene;
    const actions = snapshot?.actions ?? [];
    const expected = actions.filter(action => {
      const entity = action.entityId ? snapshot?.board?.entities?.[action.entityId] : undefined;
      return !!entity?.components?.cardFace;
    });
    const mismatches = [];
    let loaded = 0;
    for (const action of expected) {
      const image = document.querySelector(`#action-hand .ah-card[data-action-id="${action.id}"] .ah-art`);
      const expectedArt = scene?.entityCardArt?.(action.entityId);
      if (!image) {
        mismatches.push(`${action.id}:missing`);
        continue;
      }
      const src = image.getAttribute('src');
      if (src !== expectedArt) mismatches.push(`${action.id}:different`);
      if (image.complete && image.naturalWidth > 0) loaded += 1;
    }
    return {
      ownHandVisible: scene?.ownHandGroup?.visible,
      ownHandChildren: scene?.ownHandGroup?.children?.length ?? 0,
      expected: expected.length,
      artCards: document.querySelectorAll('#action-hand .ah-art').length,
      commandFallbacks: document.querySelectorAll('#action-hand .ah-ico').length,
      cards: document.querySelectorAll('#action-hand .ah-card').length,
      faces: document.querySelectorAll('#action-hand .ah-card .ah-art, #action-hand .ah-card .ah-ico').length,
      mismatches,
      loaded,
      firstSource: document.querySelector('#action-hand .ah-art')?.getAttribute('src')?.slice(0, 24) ?? '',
      textLeak: document.querySelector('#action-hand')?.textContent?.includes('viewBox') ?? false
    };
  });

  record('unified: 3D own hand is hidden', faces.ownHandVisible === false, JSON.stringify(faces));
  record('unified: entity actions have artwork', faces.expected > 0, String(faces.expected));
  record('unified: one image per entity-backed action', faces.artCards === faces.expected, `${faces.artCards}/${faces.expected}`);
  record('unified: images equal board textures exactly', faces.mismatches.length === 0, faces.mismatches.join(','));
  record('unified: every artwork image decoded', faces.loaded === faces.expected, `${faces.loaded}/${faces.expected}`);
  record('unified: procedural art is a real image', faces.firstSource.startsWith('data:image/'), faces.firstSource);
  // 每张牌都必须有"脸"：真实卡面（.ah-art）或图标兜底（.ah-ico）。三国杀全套都是实体牌，
  // 所以这里只要求两者之和覆盖所有卡片，而不是硬性要求图标兜底出现。
  record(
    'unified: every card renders a face',
    faces.faces >= faces.cards && faces.cards > 0,
    faces.faces + '/' + faces.cards + ' (icons ' + faces.commandFallbacks + ')',
  );
  record('unified: no SVG markup leaks as text', !faces.textLeak);

  await page.screenshot({ path: 'shots/unified-hand-sanguosha.png', fullPage: false });
  await page.close();
} finally {
  await browser.close();
}

const passed = checks.filter(c => c.ok).length;
for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
if (failures.length > 0) {
  console.error(`\nunified-hand-faces: ${passed}/${checks.length} checks passed`);
  for (const f of failures) console.error('  x ' + f);
  process.exit(1);
}
console.log(`\nunified-hand-faces: ${passed}/${checks.length} checks passed`);
process.exit(0);
