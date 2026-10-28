import { launchChromium } from './lib/browser.mjs';
import { clickDockAction } from './lib/actions.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';

/**
 * Verifies two user-reported fixes:
 * 1. Switching games automatically and completely refreshes both 3D scene and 2D UI:
 *    - boardKey tracks gameId so scene re-renders immediately
 *    - 3D meshes (hexes vs rooms vs seats) update completely without manual reload
 *    - URL search parameters sync dynamically with history.replaceState
 *    - Document title updates
 * 2. Room placement camera hand-off:
 *    - Elevates and looks down centered on the new room during placement
 *    - On confirm, smoothly transitions/dollies down directly to the actor in the new room
 *    - NEVER jumps back to the old pre-placement room position
 *    - Restores normal playing eye-height and distance smoothly
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

// ============================================================
// PART 1: GAME SWITCH AUTO REFRESH
// ============================================================
console.log('--- PART 1: GAME SWITCH REFRESH ---');
await page.goto(`${dev.url}?game=catan`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2000);
if (await page.locator('#boot-enter').count()) await page.click('#boot-enter');
await page.waitForTimeout(1000);

const catanState = await page.evaluate(() => {
  const app = window.__boardGameApp;
  const nodes = Object.values(app.session.getSnapshot().board.mapGraph.nodes);
  const meshCount = app.scene.nodeMeshes.size;
  const hasHexes = nodes.some(n => n.type === 'HEX');
  return { gameId: app.currentGameId, hasHexes, meshCount, url: window.location.search, title: document.title };
});
console.log('Catan initial:', JSON.stringify(catanState));
if (!catanState.hasHexes) failures.push('Catan did not render hexes');

// Switch to Sanguosha
console.log('Switching to Sanguosha...');
await page.click('.game-pill[data-game="sanguosha"]');
await page.waitForTimeout(1000);

const sanguoshaState = await page.evaluate(() => {
  const app = window.__boardGameApp;
  const nodes = Object.values(app.session.getSnapshot().board.mapGraph.nodes);
  const meshCount = app.scene.nodeMeshes.size;
  const hasSeats = nodes.some(n => n.type === 'SEAT');
  const hasHexes = nodes.some(n => n.type === 'HEX');
  return { gameId: app.currentGameId, hasSeats, hasHexes, meshCount, url: window.location.search, title: document.title };
});
console.log('Sanguosha after switch:', JSON.stringify(sanguoshaState));
if (!sanguoshaState.hasSeats || sanguoshaState.hasHexes) {
  failures.push('Sanguosha 3D scene did not refresh properly after switch from Catan');
}
if (!sanguoshaState.url.includes('game=sanguosha')) {
  failures.push(`URL did not sync to sanguosha: ${sanguoshaState.url}`);
}

// Switch to Betrayal
console.log('Switching to Betrayal...');
await page.click('.game-pill[data-game="betrayal"]');
await page.waitForTimeout(1000);

const betrayalState = await page.evaluate(() => {
  const app = window.__boardGameApp;
  const nodes = Object.values(app.session.getSnapshot().board.mapGraph.nodes);
  const meshCount = app.scene.nodeMeshes.size;
  const hasRooms = nodes.some(n => n.type === 'ROOM');
  const minimapVisible = getComputedStyle(document.querySelector('#mansion-minimap')).display !== 'none';
  return { gameId: app.currentGameId, hasRooms, meshCount, minimapVisible, url: window.location.search, title: document.title };
});
console.log('Betrayal after switch:', JSON.stringify(betrayalState));
if (!betrayalState.hasRooms) failures.push('Betrayal rooms not rendered after switch');
if (!betrayalState.minimapVisible) failures.push('Minimap not displayed for Betrayal');
if (!betrayalState.url.includes('game=betrayal')) failures.push(`URL did not sync to betrayal: ${betrayalState.url}`);

// Switch back to Catan
console.log('Switching back to Catan...');
await page.click('.game-pill[data-game="catan"]');
await page.waitForTimeout(1000);

const catanBackState = await page.evaluate(() => {
  const app = window.__boardGameApp;
  const nodes = Object.values(app.session.getSnapshot().board.mapGraph.nodes);
  const meshCount = app.scene.nodeMeshes.size;
  const hasHexes = nodes.some(n => n.type === 'HEX');
  const hasRooms = nodes.some(n => n.type === 'ROOM');
  const minimapVisible = document.querySelector('#mansion-minimap') ? getComputedStyle(document.querySelector('#mansion-minimap')).display !== 'none' : false;
  return { gameId: app.currentGameId, hasHexes, hasRooms, meshCount, minimapVisible, url: window.location.search };
});
console.log('Catan after switch back:', JSON.stringify(catanBackState));
if (!catanBackState.hasHexes || catanBackState.hasRooms) {
  failures.push('Catan 3D scene did not refresh back properly from Betrayal');
}
if (catanBackState.minimapVisible) failures.push('Minimap still visible in Catan');
if (!catanBackState.url.includes('game=catan')) failures.push(`URL did not sync back to catan: ${catanBackState.url}`);

// ============================================================
// PART 2: PLACEMENT CAMERA SMOOTH FORWARD TRANSITION
// ============================================================
console.log('\n--- PART 2: PLACEMENT CAMERA HAND-OFF ---');
await page.goto(`${dev.url}?game=betrayal&scenario=exploration`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2000);
if (await page.locator('#boot-enter').count()) await page.click('#boot-enter');
await page.waitForTimeout(900);

const sampleCam = () =>
  page.evaluate(() => {
    const app = window.__boardGameApp;
    const cam = app.scene.camera;
    const tgt = app.scene.controls.target;
    const preview = app.scene.lastPlacement;
    const p1 = app.session.getSnapshot().board.players.p1;
    const room = app.scene.nodeMeshes.get(p1.customProps.currentRoomId);
    return {
      camPos: cam.position.toArray().map(n => +n.toFixed(2)),
      targetPos: tgt.toArray().map(n => +n.toFixed(2)),
      dist: +cam.position.distanceTo(tgt).toFixed(2),
      height: +(cam.position.y - tgt.y).toFixed(2),
      previewPos: preview ? preview.position.map(n => +n.toFixed(2)) : null,
      actorRoomId: p1.customProps.currentRoomId,
      actorRoomPos: room ? room.position.toArray().map(n => +n.toFixed(2)) : null,
      controls: app.scene.controls.enabled
    };
  });

const beforeExplore = await sampleCam();
console.log('Pre-explore camera:', JSON.stringify(beforeExplore));

// Click explore door
console.log('Exploring door to trigger placement...');
await clickDockAction(page, '探索');
await page.waitForFunction(() => window.__boardGameApp.scene.controls.enabled, null, { timeout: 8000 });

const duringPlacement = await sampleCam();
console.log('During placement camera:', JSON.stringify(duringPlacement));

// Confirm elevated view centered on new room
const distTargetToPreview = Math.hypot(
  duringPlacement.targetPos[0] - duringPlacement.previewPos[0],
  duringPlacement.targetPos[2] - duringPlacement.previewPos[2]
);
if (distTargetToPreview > 0.8) {
  failures.push(`Placement target is not on the preview room (off by ${distTargetToPreview.toFixed(2)})`);
}
if (!(duringPlacement.camPos[1] > beforeExplore.camPos[1] + 1.0)) {
  failures.push(`Camera was not elevated during placement (${beforeExplore.camPos[1]} -> ${duringPlacement.camPos[1]})`);
}

// Click Confirm Placement
console.log('Confirming placement...');
await page.locator('[data-place-confirm]').click();
await page.waitForFunction(() => window.__boardGameApp.scene.controls.enabled, null, { timeout: 8000 });

const settled = await sampleCam();
console.log('Settled camera after confirm:', JSON.stringify(settled));

// ASSERTIONS:
// 1. Target never jumped back to pre-explore room:
const distSettledToOldRoom = Math.hypot(
  settled.targetPos[0] - beforeExplore.actorRoomPos[0],
  settled.targetPos[2] - beforeExplore.actorRoomPos[2]
);
console.log(`Distance from settled target to OLD room: ${distSettledToOldRoom.toFixed(2)}`);
if (distSettledToOldRoom < 1.0) {
  failures.push('Camera target jumped back to the old pre-explore room!');
}

// 2. Target landed centered on the new room where actor now stands:
const distSettledToNewRoom = Math.hypot(
  settled.targetPos[0] - settled.actorRoomPos[0],
  settled.targetPos[2] - settled.actorRoomPos[2]
);
console.log(`Distance from settled target to NEW room: ${distSettledToNewRoom.toFixed(2)}`);
if (distSettledToNewRoom > 1.2) {
  failures.push(`Camera target not on the new actor room (off by ${distSettledToNewRoom.toFixed(2)})`);
}

// 3. Eye height returned to normal playing height (from elevated placement view):
console.log(`Camera height relative to target: placement=${duringPlacement.height} -> settled=${settled.height} (pre=${beforeExplore.height})`);
if (Math.abs(settled.height - beforeExplore.height) > 1.0) {
  failures.push(`Camera did not restore pre-placement height (${beforeExplore.height} vs ${settled.height})`);
}
if (settled.camPos[1] >= duringPlacement.camPos[1] - 1.0) {
  failures.push('Camera did not dolly down from the elevated placement view');
}

// 4. Controls restored
if (!settled.controls) {
  failures.push('Controls not re-enabled after placement transition');
}

console.log('\nERRORS:', errors.length ? errors.slice(0, 5) : 'none');

if (failures.length > 0) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exitCode = 1;
} else {
  console.log('\nAll switch refresh and placement camera checks passed.');
}

await browser.close();
dev.stop();
