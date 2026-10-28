import { launchChromium } from './lib/browser.mjs';
import { clickDockAction } from './lib/actions.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';

/**
 * Placement camera hand-off: finishing a placement must first restore the pose
 * the player was holding, then pan the orbit target onto the actor who walked
 * into the new room — without a jump cut and without the auto-fit fighting it.
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
    const offset = cam.position.clone().sub(tgt);
    const p1 = app.session.getSnapshot().board.players.p1;
    // World position of the actor token/room, not logical grid coords: projected
    // layers carry a dynamic offset that raw props do not.
    const token = app.scene.entityMeshes.get(`meeple_${p1.id}`);
    const roomMesh = app.scene.nodeMeshes.get(p1.customProps.currentRoomId);
    return {
      pos: cam.position.toArray().map(n => +n.toFixed(3)),
      target: tgt.toArray().map(n => +n.toFixed(3)),
      /** Camera→target length: panning must not dolly. */
      distance: +offset.length().toFixed(3),
      /** Bearing as a unit vector: panning must not orbit. */
      bearing: offset.clone().normalize().toArray().map(n => +n.toFixed(4)),
      room: p1.customProps.currentRoomId,
      roomPos: roomMesh ? roomMesh.position.toArray().map(n => +n.toFixed(3)) : null,
      tokenPos: token ? token.position.toArray().map(n => +n.toFixed(3)) : null
    };
  });

await page.goto(`${dev.url}?game=betrayal&scenario=exploration`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2500);
if (await page.locator('#boot-enter').count()) await page.click('#boot-enter');
await page.waitForTimeout(900);

const before = await sample();
console.log('before explore:', JSON.stringify(before));

// Explore a door and confirm the placement.
await clickDockAction(page, '探索');
await page.waitForTimeout(900);
const raised = await sample();
await page.locator('[data-place-confirm]').click();

// Sample mid-flight and after the pan settles.
await page.waitForTimeout(260);
const midPan = await sample();
await page.waitForTimeout(1400);
const settled = await sample();

console.log('raised (placement):', JSON.stringify({ pos: raised.pos, target: raised.target }));
console.log('settled:', JSON.stringify(settled));

// 1. The camera must come back near the pre-placement pose before panning, so
//    the height should drop from the raised pose rather than stay up there.
if (!(settled.pos[1] < raised.pos[1] - 0.4)) {
  failures.push(`camera did not come back down (raised y=${raised.pos[1]} -> settled y=${settled.pos[1]})`);
}

// 2. Pan, not dolly: the camera→target distance is preserved.
if (Math.abs(settled.distance - before.distance) > 0.05) {
  failures.push(`distance changed (${before.distance} -> ${settled.distance}); expected a pan`);
}

// 3. Pan, not orbit: the bearing is preserved.
const dot =
  settled.bearing[0] * before.bearing[0] +
  settled.bearing[1] * before.bearing[1] +
  settled.bearing[2] * before.bearing[2];
if (dot < 0.999) failures.push(`bearing changed (dot=${dot.toFixed(4)}); expected a pan`);

// 4. The target must land on the actor's current room, not the old framing.
const anchor = settled.tokenPos ?? settled.roomPos;
if (anchor) {
  const offsetToAnchor = Math.hypot(settled.target[0] - anchor[0], settled.target[2] - anchor[2]);
  if (offsetToAnchor > 1.2) {
    failures.push(`target not centred on the actor (off by ${offsetToAnchor.toFixed(2)})`);
  }
}

// 5. It must actually move (a no-op pan would trivially satisfy the above).
const moved = Math.hypot(
  settled.target[0] - before.target[0],
  settled.target[2] - before.target[2]
);
if (moved < 0.3) failures.push(`target barely moved (${moved.toFixed(2)}); pan may not have run`);

// 6. Controls must be handed back.
const controls = await page.evaluate(() => window.__boardGameApp.scene.controls.enabled);
if (!controls) failures.push('orbit controls left disabled after the pan');

// 7. A mid-flight sample proves it animates instead of snapping.
const animated = Math.hypot(
  midPan.target[0] - settled.target[0],
  midPan.target[2] - settled.target[2]
);
console.log(`pan: moved=${moved.toFixed(2)} animatedMid=${animated.toFixed(2)} dot=${dot.toFixed(5)}`);

await page.screenshot({ path: 'shots/placement-camera-pan.png' });
console.log('ERRORS:', errors.length ? errors.slice(0, 5) : 'none');

if (failures.length > 0) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exitCode = 1;
} else {
  console.log('\nPlacement camera hand-off checks passed.');
}

await browser.close();
dev.stop();
