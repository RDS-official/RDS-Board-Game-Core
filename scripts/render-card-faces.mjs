import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchChromium } from './lib/browser.mjs';

/**
 * Renders representative card faces to PNG, offline, for eyeballing.
 *
 *   node scripts/render-card-faces.mjs
 *
 * Both renderers are exercised exactly as the app uses them:
 *
 *  - **3D faces** — `CardMeshBuilder.createCardFaceTexture()` is bundled from
 *    TypeScript with esbuild, run in a real browser canvas, and the resulting
 *    512×768 canvas is exported as PNG.
 *  - **DOM plates** — `cardArtSvg()` is dropped into the real `.card-sheet`
 *    markup and the shipped stylesheets, then screenshotted.
 *
 * No dev server, no network, no external assets. Output lands in `shots/`
 * (git-ignored).
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'shots');

/* -------------------------------------------------------------------------- */
/* Sample deck: 3 per family, short and long Chinese titles                    */
/* -------------------------------------------------------------------------- */

/**
 * Card families in the sample deck. The plate painter only understands opaque
 * tone tokens (danger / treasure / event / place), so the band text and seal
 * glyph — 山屋's own vocabulary — are spelled out here exactly as the game
 * package declares them.
 */
const FAMILIES = {
  OMEN: { tone: 'danger', badge: '预兆 · OMEN', seal: '👁' },
  ITEM: { tone: 'treasure', badge: '遗物 · ITEM', seal: '◆' },
  EVENT: { tone: 'event', badge: '事件 · EVENT', seal: '✦' }
};

const SAMPLES = [
  {
    slug: 'omen-bite',
    family: 'OMEN',
    en: 'Bite',
    title: '噬咬',
    desc: '不可名状之物从暗处扑出。右侧玩家代掷 4 颗骰对你进行一次力量攻击。此卡留在你面前作为预兆，不可交易或丢弃。',
    facts: [
      { label: '类别', value: '预兆' },
      { label: '交易', value: '不可交易' }
    ]
  },
  {
    slug: 'omen-crystal-ball',
    family: 'OMEN',
    en: 'Crystal Ball',
    title: '水晶球',
    desc: '每回合一次：知识检定。4+ 窥视事件或物品牌堆顶牌并决定置于顶或底；1–3 失去 1 神智；0 失去 2 神智。',
    facts: [
      { label: '使用方式', value: '每回合一次' },
      { label: '检定', value: '知识' }
    ]
  },
  {
    slug: 'omen-skeleton-key',
    family: 'OMEN',
    en: 'Skeleton Key',
    title: '骷髅万能钥匙',
    desc: '获得时知识 +1。开启任何上锁的门或金库时不需检定。失去时知识 -1。',
    facts: [
      { label: '获得', value: '知识 +1' },
      { label: '失去', value: '知识 -1' }
    ]
  },
  {
    slug: 'item-pickaxe',
    family: 'ITEM',
    en: 'Pickaxe',
    title: '铁镐',
    desc: '力量攻击 +1 骰。可砸开封锁的门，但会惊动宅邸里的东西。',
    facts: [{ label: '攻击', value: '力量 +1' }]
  },
  {
    slug: 'item-smelling-salts',
    family: 'ITEM',
    en: 'Smelling Salts',
    title: '刺激嗅盐',
    desc: '立刻结束你身上的眩晕状态，并恢复 1 点神智。用后弃置。',
    facts: [{ label: '剩余次数', value: '1' }]
  },
  {
    slug: 'item-revolver',
    family: 'ITEM',
    en: 'Revolver',
    title: '老式左轮手枪',
    desc: '速度攻击 +1 骰，可远程攻击同一房间内的目标。每场游戏只能装填一次。',
    facts: [{ label: '攻击', value: '速度 +1 · 远程' }]
  },
  {
    slug: 'event-drip',
    family: 'EVENT',
    en: 'Drip',
    title: '滴血之声',
    desc: '天花板上传来缓慢的滴水声。速度检定：失败则受到 1 点物理伤害。',
    facts: [{ label: '检定', value: '速度' }]
  },
  {
    slug: 'event-time-warp',
    family: 'EVENT',
    en: 'Time Warp',
    title: '时空迷离',
    desc: '你脚下的地板忽然倾斜。掷骰决定被传送到哪一层。',
    facts: [{ label: '效果', value: '传送' }]
  },
  {
    slug: 'event-whisper',
    family: 'EVENT',
    en: 'Unnameable Whispering',
    title: '不可名状的低语在长廊尽头回荡',
    desc: '长廊尽头有人在低声念你的名字。神智检定：失败则失去 1 点神智，并在本回合无法移动。',
    facts: [{ label: '检定', value: '神智' }]
  }
];

/** Extra face proving the same painter covers non-Betrayal decks. */
const RELIC_SAMPLE = {
  slug: 'relic-sapphire',
  type: 'TIER_2',
  title: '蓝宝石矿脉',
  desc: '终局计分时价值 3 点声望。购买需要 2 蓝宝石与 1 黑曜石。',
  score: 3,
  cost: { sapphire: 2, onyx: 1 }
};

/* -------------------------------------------------------------------------- */
/* esbuild: bundle the two TypeScript renderers for the browser               */
/* -------------------------------------------------------------------------- */

async function loadEsbuild() {
  try {
    return await import('esbuild');
  } catch {
    // pnpm keeps esbuild behind the store; resolve it explicitly.
    const store = join(ROOT, 'node_modules', '.pnpm');
    if (existsSync(store)) {
      for (const dir of readdirSync(store).filter(name => name.startsWith('esbuild@'))) {
        const main = join(store, dir, 'node_modules', 'esbuild', 'lib', 'main.js');
        if (existsSync(main)) return import(pathToFileURL(main).href);
      }
    }
    throw new Error('esbuild not found: run `pnpm install` first');
  }
}

async function bundleRenderers() {
  const esbuild = await loadEsbuild();
  const result = await esbuild.build({
    stdin: {
      contents: `
        import { cardArtSvg } from './apps/web/src/ui/cardArt';
        import { detailTone } from './apps/web/src/ui/detailView';
        import { CardMeshBuilder } from './apps/web/src/render/procedural/cardMesh';
        export { cardArtSvg, detailTone, CardMeshBuilder };
      `,
      resolveDir: ROOT,
      sourcefile: 'card-faces-entry.ts',
      loader: 'ts'
    },
    bundle: true,
    format: 'iife',
    globalName: 'CardFaces',
    platform: 'browser',
    target: 'chrome110',
    tsconfig: join(ROOT, 'tsconfig.json'),
    write: false,
    logLevel: 'warning'
  });
  return result.outputFiles[0].text;
}

/* -------------------------------------------------------------------------- */
/* Page scaffolding                                                            */
/* -------------------------------------------------------------------------- */

const SHEET_CSS = [
  'apps/web/src/ui/tokens/primitives.css',
  'apps/web/src/ui/tokens/semantic.css',
  'apps/web/src/ui/tokens/themes.css',
  'apps/web/src/ui/styles.css',
  'apps/web/src/ui/theme-gothic.css'
]
  .map(file => readFileSync(join(ROOT, file), 'utf8'))
  .join('\n');

/** The exact card-sheet markup the HUD builds, minus live action buttons. */
function sheetHtml(card) {
  const family = FAMILIES[card.family];
  const facts = (card.facts ?? []).map(row => `<li><span>${row.label}</span><b>${row.value}</b></li>`).join('');
  return `
    <article class="card-sheet" data-tone="${family.tone}">
      <button class="cs-close" type="button" aria-label="关闭">×</button>
      <div class="cs-ribbon"><span>${family.badge}</span></div>
      <div class="cs-body">
        <div class="cs-art"></div>
        <div class="cs-seal">${family.seal}</div>
        <h2 class="cs-title">${card.title}</h2>
        ${card.en ? `<div class="cs-en">${card.en}</div>` : ''}
        <div class="cs-rule"></div>
        <p class="cs-desc">${card.desc}</p>
        ${facts ? `<ul class="cs-facts">${facts}</ul>` : ''}
      </div>
      <div class="cs-foot">点击牌堆或场景实体继续</div>
    </article>
  `;
}

/** Element screenshots stitch badly when the element exceeds the viewport. */
async function shootElement(page, locator, file) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`element for ${file} has no box`);
  await page.setViewportSize({
    width: Math.ceil(box.width) + 48,
    height: Math.ceil(box.height) + 48
  });
  await page.waitForTimeout(60);
  await locator.screenshot({ path: file });
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });

  const bundle = await bundleRenderers();
  const browser = await launchChromium();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  const written = [];

  try {
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>${SHEET_CSS}
        body { background: #0a0c10; margin: 0; padding: 0; }
        #stage { display: flex; flex-wrap: wrap; gap: 24px; padding: 24px; align-items: flex-start; }
        #stage .card-sheet { animation: none; transform: none; }
        #stage .card-sheet:hover { transform: none; }
        .grid { display: grid; gap: 14px; padding: 18px; background: #08090c; }
        .grid figure { margin: 0; display: flex; flex-direction: column; gap: 6px; }
        .grid img { display: block; width: 100%; height: auto; border-radius: 6px;
          box-shadow: 0 10px 26px -12px #000, 0 0 0 1px rgba(201,162,74,0.28); }
        .grid figcaption { font: 600 11px/1.3 var(--font-ui); color: #cbbda1; letter-spacing: .06em; }
        .grid figcaption b { color: #f0d89a; font-weight: 800; }
      </style></head><body><div id="stage"></div></body></html>`,
      { waitUntil: 'load' }
    );

    await page.addScriptTag({ content: bundle });
    await page.evaluate(() => document.fonts.ready);

    // ---- DOM plates: real sheet markup + shipped stylesheets ----------------
    for (const card of SAMPLES) {
      const tone = FAMILIES[card.family].tone;
      // cardArtSvg only reads the neutral view: title, subtitle and tone token.
      const art = await page.evaluate(
        view => window.CardFaces.cardArtSvg(view),
        { title: card.title, subtitle: card.en, tone }
      );
      await page.evaluate(
        ({ html, art, tone }) => {
          const stage = document.getElementById('stage');
          const holder = document.createElement('div');
          holder.innerHTML = html;
          const sheet = holder.firstElementChild;
          // The HUD paints the same two variables from the same tone mapping.
          const theme = window.CardFaces.detailTone(tone);
          sheet.style.setProperty('--ink', theme.ink);
          sheet.style.setProperty('--ribbon', theme.ribbon);
          const artBox = sheet.querySelector('.cs-art');
          if (artBox) artBox.innerHTML = art;
          stage.appendChild(sheet);
        },
        { html: sheetHtml(card), art, tone }
      );
    }

    await page.waitForTimeout(120);

    for (let i = 0; i < SAMPLES.length; i++) {
      const sheet = page.locator('#stage > .card-sheet').nth(i);
      const file = join(SHOTS, `card-sheet-${SAMPLES[i].slug}.png`);
      await sheet.screenshot({ path: file });
      written.push(file);
    }

    // Full grid of sheets, for comparing the family languages side by side.
    const sheetGrid = await page.evaluate(() => {
      const stage = document.getElementById('stage');
      const clone = document.createElement('div');
      clone.id = 'sheet-grid';
      clone.className = 'grid';
      clone.style.gridTemplateColumns = 'repeat(3, 320px)';
      clone.style.alignItems = 'start';
      for (const sheet of Array.from(stage.children)) {
        const figure = document.createElement('figure');
        const wrapper = document.createElement('div');
        wrapper.style.width = '292px';
        wrapper.appendChild(sheet.cloneNode(true));
        figure.appendChild(wrapper);
        const cap = document.createElement('figcaption');
        cap.innerHTML = `<b>${sheet.getAttribute('data-tone')}</b> · ${sheet.querySelector('.cs-title').textContent}`;
        figure.appendChild(cap);
        clone.appendChild(figure);
      }
      document.body.innerHTML = '';
      document.body.appendChild(clone);
      return true;
    });
    if (sheetGrid) {
      const file = join(SHOTS, 'card-sheets-overview.png');
      await shootElement(page, page.locator('#sheet-grid'), file);
      written.push(file);
    }

    // ---- 3D faces ----------------------------------------------------------
    const faces = [];
    for (const card of SAMPLES) {
      const face = { title: card.title, type: card.family, desc: card.desc };
      const dataUrl = await page.evaluate(input => {
        const texture = window.CardFaces.CardMeshBuilder.createCardFaceTexture(input, false);
        return texture.image.toDataURL('image/png');
      }, face);
      const file = join(SHOTS, `card-face-${card.slug}.png`);
      writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
      written.push(file);
      faces.push({ dataUrl, label: `<b>${card.family}</b> · ${card.title}`, slug: card.slug });
    }

    const relicUrl = await page.evaluate(input => {
      const texture = window.CardFaces.CardMeshBuilder.createCardFaceTexture(input, false);
      return texture.image.toDataURL('image/png');
    }, RELIC_SAMPLE);
    const relicFile = join(SHOTS, `card-face-${RELIC_SAMPLE.slug}.png`);
    writeFileSync(relicFile, Buffer.from(relicUrl.split(',')[1], 'base64'));
    written.push(relicFile);

    // Masked (face-down) variant, same plate language.
    const maskedUrl = await page.evaluate(() => {
      const texture = window.CardFaces.CardMeshBuilder.createCardFaceTexture({ title: '未揭示' }, true);
      return texture.image.toDataURL('image/png');
    });
    const maskedFile = join(SHOTS, 'card-face-masked.png');
    writeFileSync(maskedFile, Buffer.from(maskedUrl.split(',')[1], 'base64'));
    written.push(maskedFile);

    await page.evaluate(
      async ({ faces, relicUrl }) => {
        const grid = document.createElement('div');
        grid.id = 'face-grid';
        grid.className = 'grid';
        grid.style.gridTemplateColumns = 'repeat(3, 300px)';
        const pending = [];
        const add = (url, label) => {
          const figure = document.createElement('figure');
          const img = document.createElement('img');
          // Explicit box: the screenshot must not race the image layout.
          img.width = 300;
          img.height = 450;
          img.src = url;
          pending.push(img.decode().catch(() => undefined));
          figure.appendChild(img);
          const cap = document.createElement('figcaption');
          cap.innerHTML = label;
          figure.appendChild(cap);
          grid.appendChild(figure);
        };
        for (const face of faces) add(face.dataUrl, face.label);
        add(relicUrl, '<b>RELIC</b> · 蓝宝石矿脉（非惊魂卡面）');
        document.body.innerHTML = '';
        document.body.appendChild(grid);
        await Promise.all(pending);
      },
      { faces, relicUrl }
    );
    const faceGridFile = join(SHOTS, 'card-faces-3d.png');
    await shootElement(page, page.locator('#face-grid'), faceGridFile);
    written.push(faceGridFile);

    // ---- DOM plate close-ups (just the art panel) --------------------------
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>${SHEET_CSS}
        body { background: #08090c; margin: 0; }
        .grid { display: grid; gap: 14px; padding: 18px; }
        .grid figure { margin: 0; display: flex; flex-direction: column; gap: 6px; }
        .cell { width: 300px; }
        .cell .cs-art { margin: 0; height: 138px; }
        .grid figcaption { font: 600 11px/1.3 var(--font-ui); color: #cbbda1; letter-spacing: .06em; }
        .grid figcaption b { color: #f0d89a; font-weight: 800; }
      </style></head><body><div id="plate-grid" class="grid"></div></body></html>`,
      { waitUntil: 'load' }
    );
    await page.addScriptTag({ content: bundle });
    await page.evaluate(
      samples => {
        const grid = document.getElementById('plate-grid');
        grid.style.gridTemplateColumns = 'repeat(3, 300px)';
        for (const card of samples) {
          const figure = document.createElement('figure');
          const cell = document.createElement('div');
          cell.className = 'cell';
          const art = document.createElement('div');
          art.className = 'cs-art';
          art.style.borderRadius = '4px';
          art.innerHTML = window.CardFaces.cardArtSvg(card);
          cell.appendChild(art);
          figure.appendChild(cell);
          const cap = document.createElement('figcaption');
          cap.innerHTML = `<b>${card.family}</b> · ${card.title}`;
          figure.appendChild(cap);
          grid.appendChild(figure);
        }
      },
      SAMPLES.map(card => ({
        title: card.title,
        subtitle: card.en,
        tone: FAMILIES[card.family].tone,
        family: card.family
      }))
    );
    await page.waitForTimeout(80);
    const plateGridFile = join(SHOTS, 'card-faces-dom.png');
    await shootElement(page, page.locator('#plate-grid'), plateGridFile);
    written.push(plateGridFile);

    // ---- Console summary ---------------------------------------------------
    console.log(`\ncard faces → ${SHOTS}`);
    for (const file of written) console.log(`  ${file.slice(ROOT.length + 1)}`);
    console.log(`\n${written.length} files · ${errors.length ? `console errors: ${errors.slice(0, 4).join(' | ')}` : 'no console errors'}`);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
