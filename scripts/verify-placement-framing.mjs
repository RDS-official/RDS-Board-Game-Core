import { launchChromium } from './lib/browser.mjs';
import { clickDockAction } from './lib/actions.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';

/**
 * Placement framing must centre on the room being placed and lift the eye,
 * rather than pulling back to the whole-board view. Also checks the hand-off
 * afterwards still returns to the board and pans onto the actor.
 */
const dev = await ensureSoloServer();
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const errors = [];
page.on('pageerror', err => errors.push(err.message));
page.on('console', msg => {
  if (msg.type() === 'error') errors.push(msg.text());
});

const failures = [];
const sample = () =>
  page.evaluate(() => {
    const app = window.__boardGameApp;
    const cam = app.scene.camera;
    const tgt = app.scene.controls.target;
    const preview = app.scene.lastPlacement;
    return {
      cam: cam.position.toArray().map(n => +n.toFixed(2)),
      target: tgt.toArray().map(n => +n.toFixed(2)),
      previewPos: preview ? preview.position.map(n => +n.toFixed(2)) : null,
      dist: +cam.position.distanceTo(tgt).toFixed(2),
      controls: app.scene.controls.enabled
    };
  });

await page.goto(`${dev.url}?game=betrayal&scenario=exploration`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2500);
if (await page.locator('#boot-enter').count()) await page.click('#boot-enter');
await page.waitForTimeout(900);

const board = await sample();
console.log('board      :', JSON.stringify(board));

await clickDockAction(page, '探索');
// Wait for the preview to arm and the camera tween to finish: a fixed sleep
// sampled mid-animation once the dock gained its detail-panel step.
await page
  .waitForFunction(() => !!window.__boardGameApp?.scene?.placementPreview?.position, { timeout: 8000 })
  .catch(() => {});
await page
  .waitForFunction(
    () => {
      const cam = window.__boardGameApp?.scene?.camera;
      if (!cam) return false;
      const key = 'probeCam';
      const prev = window[key];
      window[key] = cam.position.toArray();
      if (!prev) return false;
      return prev.every((v, i) => Math.abs(v - window[key][i]) < 0.01);
    },
    { timeout: 8000, polling: 120 }
  )
  .catch(() => {});
await page.waitForTimeout(250);
const placing = await sample();
console.log('placing    :', JSON.stringify(placing));

// 1. The orbit target must sit on the tile being placed, not the board centre.
if (!placing.previewPos) {
  failures.push('no placement preview active; cannot check framing');
} else {
  const off = Math.hypot(
    placing.target[0] - placing.previewPos[0],
    placing.target[2] - placing.previewPos[2]
  );
  if (off > 1.0) failures.push(`placement target not on the new room (off by ${off.toFixed(2)})`);
}

// 2. It must rise: the eye sits higher than before entering placement.
if (!(placing.cam[1] > board.cam[1] + 1.0)) {
  failures.push(`placement camera did not rise (${board.cam[1]} -> ${placing.cam[1]})`);
}

// 3. It must come in closer than the wide board view, so the tile is readable.
if (!(placing.dist < board.dist - 2)) {
  failures.push(`placement camera did not move closer (${board.dist} -> ${placing.dist})`);
}

// 4. Rotating the tile must not refit the camera.
const beforeRotate = await sample();
for (let i = 0; i < 2; i++) {
  await page.locator('[data-place-rotate]').click();
  await page.waitForTimeout(180);
}
const afterRotate = await sample();
if (JSON.stringify(beforeRotate.cam) !== JSON.stringify(afterRotate.cam)) {
  failures.push('rotation refit the camera');
}

// 5. Confirming hands control back and the follow-up pan lands on the actor.
await page.locator('[data-place-confirm]').click();
// Wait past the post-placement pan (420ms) before sampling control state.
await page.waitForTimeout(1800);
const settled = await sample();
const actorRoom = await page.evaluate(() => {
  const app = window.__boardGameApp;
  const p1 = app.session.getSnapshot().board.players.p1;
  const mesh = app.scene.nodeMeshes.get(p1.customProps.currentRoomId);
  return mesh ? mesh.position.toArray().map(n => +n.toFixed(2)) : null;
});
if (!settled.controls) failures.push('controls not restored after placement');
if (actorRoom) {
  const off = Math.hypot(settled.target[0] - actorRoom[0], settled.target[2] - actorRoom[2]);
  if (off > 1.2) failures.push(`post-placement target not on the actor (off by ${off.toFixed(2)})`);
}

console.log('settled    :', JSON.stringify(settled), 'actorRoom:', JSON.stringify(actorRoom));
await page.screenshot({ path: 'shots/placement-camera-new-room.png' });
console.log('ERRORS:', errors.length ? errors.slice(0, 5) : 'none');

if (failures.length > 0) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exitCode = 1;
} else {
  console.log('\nPlacement framing checks passed.');
}

await browser.close();
dev.stop();
