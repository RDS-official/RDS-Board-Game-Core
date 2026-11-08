import { launchChromium } from './lib/browser.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';

/**
 * Seat-plaque hover probe (issue #216 follow-up: stuck standee plaque).
 *
 * The seat plaque ("立牌") is a hover surface: hovering a seat in the 3D board
 * opens the enlarged plaque window, and leaving it closes the window. Both the
 * open and the close come from the raycaster's `pointermove` handler.
 *
 * That breaks as soon as something else takes the pointer while the plaque is
 * open: a payload window opened by *clicking the seat itself* appears under a
 * pointer that never left the canvas, so no `pointermove` arrives, the hover
 * state is never cleared, and the plaque stays on screen with no way to dismiss
 * it except hovering the same seat again.
 *
 * This probe drives the real path (project a seat plate to screen space, hover
 * it, click it) and asserts the plaque yields to the payload window.
 *
 * Run: node scripts/probe-seat-peek.mjs
 */
const dev = await ensureSoloServer();
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const failures = [];
let checks = 0;
const record = (name, ok, detail) => {
  checks++;
  if (!ok) failures.push(`${name}: ${detail}`);
};

await page.goto(`${dev.url}?game=poker&scenario=seats_4`, {
  waitUntil: 'domcontentloaded',
  timeout: 60000
});
await page.waitForTimeout(4200);
if (await page.locator('#boot-enter').count()) await page.click('#boot-enter').catch(() => {});
await page
  .waitForFunction(() => !!window.__boardGameApp, null, { timeout: 30000 })
  .catch(() => {});
await page.waitForTimeout(2200);

// God view keeps every seat on screen regardless of who is acting.
await page.evaluate(() => window.__boardGameApp.session.setViewer('GOD'));
await page.waitForTimeout(1200);

const seatPoint = await page.evaluate(() => {
  const app = window.__boardGameApp;
  const scene = app.scene;
  const state = scene.lastState;
  if (!state) return { failed: 'scene has no state' };
  const node = Object.values(state.mapGraph.nodes).find(
    entry => entry.type === 'SEAT' && entry.props?.playerId
  );
  if (!node) return { failed: 'no seat node' };
  const mesh = scene.nodeMeshes.get(node.id);
  if (!mesh) return { failed: `no mesh for ${node.id}` };
  const projected = mesh.getWorldPosition(mesh.position.clone()).project(scene.camera);
  const rect = scene.renderer.domElement.getBoundingClientRect();
  return {
    seatId: String(node.props.playerId),
    x: rect.left + ((projected.x + 1) / 2) * rect.width,
    y: rect.top + ((1 - projected.y) / 2) * rect.height
  };
});

if (seatPoint.failed) {
  failures.push(`seat point: ${seatPoint.failed}`);
} else {
  const plaqueOn = () =>
    page.evaluate(() => {
      const peek = document.querySelector('#seat-peek');
      return !!peek && peek.classList.contains('on');
    });
  const payloadOpen = () =>
    page.evaluate(() => {
      const layer = document.querySelector('#payload-layer');
      if (!layer) return false;
      return getComputedStyle(layer).display !== 'none' && layer.childElementCount > 0;
    });

  // 1. Hovering the seat opens the plaque.
  await page.mouse.move(seatPoint.x, seatPoint.y, { steps: 8 });
  await page.waitForTimeout(350);
  record('plaque', await plaqueOn(), `hovering seat ${seatPoint.seatId} did not open the plaque`);

  // 2. Clicking the same seat opens the player sheet — with the pointer still on
  //    the canvas, so no pointerleave can clean up after it.
  await page.mouse.click(seatPoint.x, seatPoint.y);
  await page.waitForTimeout(500);
  const sheet = await payloadOpen();
  record('sheet', sheet, 'clicking the seat did not open the player sheet');
  if (sheet) {
    const sheetKind = await page.evaluate(
      () => document.querySelector('#payload-layer .player-sheet') !== null
    );
    record('sheet', sheetKind, 'the payload window is not a player sheet');
  }

  // 3. The plaque must yield to the window that now owns the screen.
  record('plaque', !(await plaqueOn()), 'the plaque stayed open behind the player sheet');
  const hintOn = await page.evaluate(() => {
    const hint = document.querySelector('#hover-hint');
    return !!hint && hint.classList.contains('on');
  });
  record('plaque', !hintOn, 'a hover chip stayed open behind the player sheet');

  // 4. Closing the window must not resurrect it.
  await page.evaluate(() => {
    const backdrop = document.querySelector('#payload-layer .payload-backdrop');
    backdrop?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await page.waitForTimeout(400);
  record('plaque', !(await plaqueOn()), 'the plaque came back after the player sheet closed');

  // 5. Hover still works afterwards: the plaque reopens and closes on its own.
  await page.mouse.move(20, 20, { steps: 6 });
  await page.waitForTimeout(250);
  await page.mouse.move(seatPoint.x, seatPoint.y, { steps: 8 });
  await page.waitForTimeout(350);
  record('plaque', await plaqueOn(), 'the plaque no longer opens on hover after the sheet closed');
  await page.mouse.move(20, 20, { steps: 8 });
  await page.waitForTimeout(350);
  record('plaque', !(await plaqueOn()), 'the plaque did not close when the pointer left the seat');

  // 6. Leaving the canvas for a panel closes it too: hover is not a state that
  //    survives the pointer being somewhere else.
  const topbarPoint = await page.evaluate(() => {
    const bar = document.querySelector('.topbar');
    if (!bar) return null;
    const rect = bar.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  if (!topbarPoint) {
    failures.push('topbar: not found');
  } else {
    await page.mouse.move(seatPoint.x, seatPoint.y, { steps: 8 });
    await page.waitForTimeout(350);
    record('plaque', await plaqueOn(), 'the plaque did not open before leaving the canvas');
    // One jump, not a slide: the only event the canvas gets is `pointerleave`,
    // which is exactly the path this case is about.
    await page.mouse.move(topbarPoint.x, topbarPoint.y);
    await page.waitForTimeout(350);
    record('plaque', !(await plaqueOn()), 'the plaque stayed open after the pointer left the canvas');
  }

  // 7. A payload window that opens while the pointer is nowhere near the board
  //    still dismisses the plaque. This is the path without any browser boundary
  //    event to lean on: the window must clear the hover surface itself.
  await page.evaluate(() => {
    const app = window.__boardGameApp;
    app.hud.showSeatPeek({ key: 'probe-seat', title: 'Probe', sections: [] });
  });
  await page.waitForTimeout(250);
  record('plaque', await plaqueOn(), 'the plaque could not be opened programmatically');
  const openedProgrammatically = await page.evaluate(() => {
    const app = window.__boardGameApp;
    const player = app.hud.latest?.players?.[0];
    if (!player) return false;
    app.hud.openPlayerSheet(player);
    return true;
  });
  if (!openedProgrammatically) {
    failures.push('sheet: no player view available for the programmatic open');
  } else {
    await page.waitForTimeout(350);
    record('plaque', !(await plaqueOn()), 'a payload window left the plaque open');
  }
}

console.log(`\nSeat plaque probe: ${checks} checks`);
if (failures.length) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const failure of failures) console.log(`  x ${failure}`);
  process.exitCode = 1;
} else {
  console.log('\nSeat plaque yields to payload windows and still tracks hover.');
}

await browser.close();
dev.stop();
