import { launchChromium } from './lib/browser.mjs';
import { clickDockAction } from './lib/actions.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';

const dev = await ensureSoloServer();
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const errors = [];
page.on('pageerror', err => errors.push(err.message));
page.on('console', msg => {
  if (msg.type() === 'error') errors.push(msg.text());
});

console.log('1. Navigating to Betrayal exploration scenario …');
await page.goto(`${dev.url}?game=betrayal&scenario=exploration`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(1400);
if (await page.locator('#boot-enter').count()) await page.click('#boot-enter');
await page.waitForTimeout(600);

const before = await page.evaluate(() => {
  const app = window.__boardGameApp;
  const nodes = app.session.getSnapshot().board.mapGraph.nodes;
  return {
    roomCount: Object.keys(nodes).length,
    activeActor: app.session.getSnapshot().actorName
  };
});
console.log('Before explore:', before);

// Explore a door (p1 in ballroom exploring South door)
await clickDockAction(page, '探索').catch(() => { throw new Error('Explore action missing'); });
await page.waitForTimeout(800);

// Verify placement preview state
const previewData = await page.evaluate(() => {
  const app = window.__boardGameApp;
  const snap = app.session.getSnapshot();
  const placement = snap.placement;
  const cardTitle = document.querySelector('#room-card .rc-title')?.textContent;
  const cardFloor = document.querySelector('#room-card .rc-floor')?.textContent;
  const compassDoors = [...document.querySelectorAll('#room-card .rc-door')].map(el => ({
    text: el.textContent?.trim(),
    classes: el.className
  }));
  const panelConns = document.querySelector('.pp-connections')?.textContent?.trim();
  const previewObjectsCount = app.scene.previewObjects.length;

  return {
    placementName: placement?.name,
    placementFloor: placement?.floor,
    placementRotation: placement?.rotation,
    connections: placement?.connections,
    cardTitle,
    cardFloor,
    compassDoors,
    panelConns,
    previewObjectsCount
  };
});

console.log('\n--- Placement Preview Active ---');
console.log('Placement Name:', previewData.placementName);
console.log('Floor:', previewData.placementFloor);
console.log('Rotation:', previewData.placementRotation * 90 + '°');
console.log('Dossier Title:', previewData.cardTitle);
console.log('Dossier Floor:', previewData.cardFloor);
console.log('Panel Connections Text:', previewData.panelConns);
console.log('Door Connections Data:', previewData.connections);
console.log('Scene Preview Objects Count:', previewData.previewObjectsCount);

await page.screenshot({ path: 'shots/placement-preview-live-1.png' });
console.log('Saved screenshot shots/placement-preview-live-1.png');

// Rotate once
console.log('\nRotating placement …');
await page.locator('[data-place-rotate]').click();
await page.waitForTimeout(400);

const rotatedData = await page.evaluate(() => {
  const app = window.__boardGameApp;
  const snap = app.session.getSnapshot();
  const placement = snap.placement;
  const cardAngle = document.querySelector('#room-card .rc-angle')?.textContent;
  const panelAngle = document.querySelector('.pp-angle')?.textContent;
  const panelConns = document.querySelector('.pp-connections')?.textContent?.trim();

  return {
    rotation: placement?.rotation,
    cardAngle,
    panelAngle,
    panelConns,
    connections: placement?.connections
  };
});

console.log('Rotated to:', rotatedData.rotation * 90 + '°');
console.log('Dossier Angle:', rotatedData.cardAngle);
console.log('Panel Angle:', rotatedData.panelAngle);
console.log('Updated Connections:', rotatedData.panelConns);

await page.screenshot({ path: 'shots/placement-preview-live-2-rotated.png' });
console.log('Saved screenshot shots/placement-preview-live-2-rotated.png');

// Confirm placement
console.log('\nConfirming placement …');
await page.locator('[data-place-confirm]').click();
await page.waitForTimeout(1000);

const after = await page.evaluate(() => {
  const app = window.__boardGameApp;
  const snap = app.session.getSnapshot();
  const nodes = snap.board.mapGraph.nodes;
  return {
    roomCount: Object.keys(nodes).length,
    placedRoomTitle: document.querySelector('#room-card .rc-title')?.textContent,
    placementActive: !!snap.placement
  };
});

console.log('\n--- Placement Confirmed ---');
console.log('Rooms:', before.roomCount, '->', after.roomCount);
console.log('Placement Active:', after.placementActive);
console.log('Current Room in Dossier:', after.placedRoomTitle);

await page.screenshot({ path: 'shots/placement-preview-live-3-confirmed.png' });
console.log('Saved screenshot shots/placement-preview-live-3-confirmed.png');

console.log('\nERRORS:', errors.length ? errors : 'none');

await browser.close();
dev.stop();
