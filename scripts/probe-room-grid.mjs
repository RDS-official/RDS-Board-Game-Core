import { launchChromium } from './lib/browser.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';

/**
 * Room grid probe.
 *
 * A scenario placed 实验室 at the same basement grid cell as 地下平台, so two
 * room tiles rendered on top of each other. Nothing else caught it: the layout
 * probe measures the DOM, probe:overlap measures furniture against a room
 * footprint, and nothing asserted that the room graph itself is collision-free.
 *
 * This builds every scenario and asserts that no two ROOM nodes share a grid
 * cell on the same floor.
 *
 * Run: node scripts/probe-room-grid.mjs
 */
const dev = await ensureSoloServer();
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const failures = [];

for (const scenario of ['exploration', 'omen_ready', 'trade_ready', 'haunt_mummy', 'haunt_eye', 'haunt_phantom', 'haunt_zombie', 'haunt_werewolf', 'room_features']) {
  await page.goto(`${dev.url}?game=betrayal&scenario=${scenario}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });
  await page.waitForTimeout(3800);
  if (await page.locator('#boot-enter').count()) await page.click('#boot-enter').catch(() => {});
  await page.waitForTimeout(1200);

  const rooms = await page.evaluate(() => {
    const raw = window.__boardGameApp.session.engine.getRawState();
    return Object.values(raw.mapGraph.nodes)
      .filter(node => node.type === 'ROOM')
      .map(node => ({
        id: node.id,
        name: node.props?.name ?? node.id,
        floor: node.props?.floor ?? node.layer ?? '?',
        col: node.props?.col,
        row: node.props?.row
      }));
  });

  const byCell = new Map();
  for (const room of rooms) {
    const key = `${room.floor}@${room.col},${room.row}`;
    if (!byCell.has(key)) byCell.set(key, []);
    byCell.get(key).push(`${room.name}(${room.id})`);
  }

  const conflicts = [...byCell.entries()].filter(([, list]) => list.length > 1);
  if (conflicts.length) {
    const detail = conflicts
      .map(([cell, list]) => `${cell}: ${list.join(' + ')}`)
      .join(' | ');
    failures.push(`${scenario}: ${conflicts.length} grid collision(s) — ${detail}`);
    console.log(`  x ${scenario}: ${detail}`);
  } else {
    console.log(`  ok ${scenario} (${rooms.length} rooms)`);
  }
}

console.log(`\nRoom grid probe: 9 scenarios`);
if (failures.length) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const f of failures) console.log(`  x ${f}`);
  process.exitCode = 1;
} else {
  console.log('No two rooms share a grid cell on any floor.');
}

await browser.close();
dev.stop();
