/**
 * UI fixture matrix: boots every game/scenario, drives a short sequence of
 * action-dock interactions, and checks console/page errors + label overlaps.
 */

import { launchChromium } from './lib/browser.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';

const dev = await ensureSoloServer();
const BASE = dev.url;
const GAMES = [
  { id: 'catan', scenarios: ['rich_action', 'trade_ready'] },
  { id: 'sanguosha', scenarios: [] },
  { id: 'splendor', scenarios: [] },
  {
    id: 'betrayal',
    scenarios: ['exploration', 'omen_ready', 'trade_ready', 'haunt_mummy', 'haunt_eye', 'haunt_phantom']
  },
  { id: 'dune_mahjong', scenarios: [] },
  { id: 'poker', scenarios: ['seats_2', 'seats_10', 'short_stack'] }
];

const browser = await launchChromium();

const failures = [];
let screens = 0;
let actions = 0;

/**
 * Benign environment noise, not a product defect.
 *
 * `vite.config.ts` proxies `/healthz`, `/api` and `/ws` to the Hub server on
 * :8787 so the unified shell can detect the lobby in dev. When the UI matrix
 * runs without `apps/server` up, every page load logs one 502 for that probe.
 * Filter it (and only it) so real console errors still fail the run.
 */
const ENV_NOISE = [
  /\/healthz/i,
  /Failed to load resource: the server responded with a status of 502/i
];

function isEnvNoise(text) {
  return ENV_NOISE.some(pattern => pattern.test(text));
}

/** Wire a page's console/page errors into `errors`, ignoring env noise. */
function collectErrors(page, errors) {
  page.on('pageerror', error => {
    if (!isEnvNoise(error.message)) errors.push(`pageerror: ${error.message}`);
  });
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (isEnvNoise(text)) return;
    errors.push(`console: ${text}`);
  });
}

for (const game of GAMES) {
  for (const scenario of [undefined, ...game.scenarios]) {
    screens++;
    const label = `${game.id}${scenario ? `:${scenario}` : ''}`;
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    collectErrors(page, errors);

    try {
      const url = `${BASE}?game=${game.id}${scenario ? `&scenario=${scenario}` : ''}`;
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(1600);
      if (await page.locator('#boot-enter').count()) {
        await page.click('#boot-enter');
        await page.waitForTimeout(600);
      }

      const initialActions = await page.locator('.dock-actions .act').count();
      if (initialActions === 0) failures.push(`${label}: no action buttons`);

      for (let step = 0; step < 6; step++) {
        const buttons = page.locator('.dock-actions .act');
        if ((await buttons.count()) === 0) break;
        const button = buttons.first();
        if (!(await button.isVisible().catch(() => false))) break;
        await button.click();
        actions++;
        await page.waitForTimeout(500);

        // A fan card opens its detail panel first; the run button carries the
        // action through. Keyed entries (number keys) stay the fast path.
        if (await page.locator('.payload-card.action-detail').count()) {
          await page.locator('#ad-run').click().catch(() => {});
          await page.waitForTimeout(500);
        }
        if (await page.locator('.payload-card').count()) {
          await page.locator('.payload-card button[type="submit"]').first().click().catch(() => {});
          await page.waitForTimeout(500);
        }
        if (await page.locator('.payload-card').count()) {
          // Invalid/default payload can leave the modal open; close it before
          // the next action click so the matrix measures the next screen.
          await page.locator('#pf-cancel').click().catch(() => {});
          await page.waitForTimeout(200);
        }
        if (await page.locator('[data-place-confirm]').count()) {
          await page.locator('[data-place-confirm]').click().catch(() => {});
          await page.waitForTimeout(600);
        }
      }

      const labelInfo = await page.evaluate(() => {
        const chips = [...document.querySelectorAll('.label-chip')]
          .filter(element => getComputedStyle(element).display !== 'none')
          .map(element => element.getBoundingClientRect());
        let overlaps = 0;
        for (let i = 0; i < chips.length; i++) {
          for (let j = i + 1; j < chips.length; j++) {
            const a = chips[i];
            const b = chips[j];
            if (!(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top)) overlaps++;
          }
        }
        return { count: chips.length, overlaps };
      });
      if (labelInfo.overlaps > 0) failures.push(`${label}: ${labelInfo.overlaps} label overlaps`);

      const state = await page.evaluate(() => {
        const app = window.__boardGameApp;
        if (!app) return null;
        const snapshot = app.session.getSnapshot();
        return {
          actions: snapshot.actions.length,
          log: snapshot.log.cursor,
          stats: app.scene.getRenderStats?.() ?? null
        };
      });
      console.log(
        `  ${label.padEnd(28)} initialActions=${String(initialActions).padStart(2)} log=${state?.log ?? '?'} labels=${labelInfo.count} sync=${state?.stats?.lastSyncMs ?? '?'}ms`
      );
    } catch (error) {
      failures.push(`${label}: threw — ${error?.message ?? error}`);
    }

    if (errors.length > 0) failures.push(`${label}: ${errors.slice(0, 3).join(' | ')}`);
    await page.close();
  }
}

// Targeted room-orientation flow: draw, raise camera, rotate without refit, place, restore camera.
{
  const label = 'betrayal:rotation-flow';
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  collectErrors(page, errors);
  try {
    await page.goto(`${BASE}?game=betrayal&scenario=exploration`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(1400);
    if (await page.locator('#boot-enter').count()) await page.click('#boot-enter');
    await page.waitForTimeout(600);
    const before = await page.evaluate(() => ({
      rooms: Object.keys(window.__boardGameApp.session.getSnapshot().board.mapGraph.nodes).length,
      camera: window.__boardGameApp.scene.camera.position.toArray()
    }));
    const explore = page.locator('.dock-actions .act[data-fan-label*="探索"]').first();
    if (!(await explore.count())) throw new Error('explore action missing');
    await explore.click();
    // The fan card opens its detail panel first; run it explicitly.
    await page.waitForTimeout(300);
    await page.locator('#ad-run').click();
    await page.waitForTimeout(800);
    if (!(await page.locator('.placement-panel').count())) throw new Error('placement panel missing after explore');
    const raised = await page.evaluate(() => window.__boardGameApp.scene.camera.position.toArray());
    if (!(raised[1] > before.camera[1] + 0.5)) {
      failures.push(`${label}: placement camera did not rise (${before.camera[1]} -> ${raised[1]})`);
    }

    const rotationCameraBefore = await page.evaluate(() => window.__boardGameApp.scene.camera.position.toArray());
    const angles = [];
    for (let i = 0; i < 3; i++) {
      await page.locator('[data-place-rotate]').click();
      await page.waitForTimeout(150);
      angles.push((await page.locator('.pp-angle').first().textContent())?.trim());
    }
    const rotationCameraAfter = await page.evaluate(() => window.__boardGameApp.scene.camera.position.toArray());
    if (JSON.stringify(rotationCameraBefore) !== JSON.stringify(rotationCameraAfter)) {
      failures.push(`${label}: rotation refit the camera`);
    }

    await page.locator('[data-place-confirm]').click();
    // Confirming restores the pose and then pans onto the actor. Wait for the
    // tween to actually finish (controls re-enable) instead of guessing a wall
    // clock delay — a throttled headless frame loop can still be mid-glide.
    await page
      .waitForFunction(() => window.__boardGameApp.scene.controls.enabled, null, { timeout: 8000 })
      .catch(() => {});
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => {
      const app = window.__boardGameApp;
      const snap = app.session.getSnapshot();
      const actor = snap.board.players.p1;
      const room = app.scene.nodeMeshes.get(actor.customProps.currentRoomId);
      const tgt = app.scene.controls.target;
      const offsetToActor = room ? Math.hypot(tgt.x - room.position.x, tgt.z - room.position.z) : 99;
      return {
        rooms: Object.keys(snap.board.mapGraph.nodes).length,
        camera: app.scene.camera.position.toArray(),
        controls: app.scene.controls.enabled,
        offsetToActor,
        centred: offsetToActor <= 1.2
      };
    });
    if (new Set(angles).size < 2) failures.push(`${label}: rotation did not change (${angles.join(',')})`);
    if (after.rooms <= before.rooms) failures.push(`${label}: room count did not grow (${before.rooms} -> ${after.rooms})`);
    // Height returns to the pre-placement framing (no stranded crane shot).
    if (Math.abs(after.camera[1] - before.camera[1]) > 0.6) {
      failures.push(`${label}: camera height not restored (${before.camera[1].toFixed(2)} -> ${after.camera[1].toFixed(2)})`);
    }
    // ...and the follow-up pan must have re-centred on the actor.
    if (!after.centred) {
      failures.push(`${label}: camera did not pan onto the actor (off by ${after.offsetToActor.toFixed(2)})`);
    }
    console.log(`  ${label.padEnd(28)} rotations=${angles.join('/')} rooms=${before.rooms}->${after.rooms} cameraY=${before.camera[1].toFixed(1)}->${raised[1].toFixed(1)}->${after.camera[1].toFixed(1)} pan=${after.offsetToActor.toFixed(2)}`);
    await page.screenshot({ path: 'shots/ui-rotation-flow.png' });
  } catch (error) {
    failures.push(`${label}: threw — ${error?.message ?? error}`);
  }
  if (errors.length) failures.push(`${label}: ${errors.slice(0, 3).join(' | ')}`);
  await page.close();
}

// Targeted drag-height & settle flow: pick up entity, drag back and forth, ensure height stays stable, drop, ensure it settles to surface.
{
  const label = 'betrayal:drag-settle-flow';
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  collectErrors(page, errors);
  try {
    await page.goto(`${BASE}?game=betrayal&scenario=exploration`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(1400);
    if (await page.locator('#boot-enter').count()) await page.click('#boot-enter');
    await page.waitForTimeout(600);

    const start = await page.evaluate(() => {
      const app = window.__boardGameApp;
      const m = app.scene.entityMeshes.get('scenario_item_p2_rope');
      const c = document.getElementById('canvas-container').getBoundingClientRect();
      const v = m.position.clone().project(app.scene.camera);
      return {
        id: 'scenario_item_p2_rope',
        x: c.left + (v.x * 0.5 + 0.5) * c.width,
        y: c.top + (-v.y * 0.5 + 0.5) * c.height,
        startY: m.position.y
      };
    });

    await page.mouse.move(start.x, start.y);
    await page.mouse.down();

    const heldHeights = [];
    for (let i = 0; i < 15; i++) {
      await page.mouse.move(start.x + (i % 2 === 0 ? 50 : -50), start.y - i * 6, { steps: 3 });
      await page.waitForTimeout(30);
      const curY = await page.evaluate(id => window.__boardGameApp.scene.entityMeshes.get(id)?.position.y, start.id);
      heldHeights.push(curY);
    }

    const minHeld = Math.min(...heldHeights);
    const maxHeld = Math.max(...heldHeights);
    if (maxHeld - minHeld > 0.35 || maxHeld > 1.2) {
      failures.push(`${label}: entity flew higher and higher (min=${minHeld.toFixed(2)}, max=${maxHeld.toFixed(2)})`);
    }

    await page.mouse.up();
    await page.waitForTimeout(350);

    const settledState = await page.evaluate(id => {
      const s = window.__boardGameApp.scene;
      const m = s.entityMeshes.get(id);
      return {
        y: m?.position.y,
        settlesRunning: s.cardSettles.size
      };
    }, start.id);

    if (settledState.y > 0.2) {
      failures.push(`${label}: entity did not settle down after drop (finalY=${settledState.y?.toFixed(2)})`);
    }

    console.log(`  ${label.padEnd(28)} heldRange=[${minHeld.toFixed(2)}, ${maxHeld.toFixed(2)}] settledY=${settledState.y?.toFixed(2)}`);
    // Release over the HUD (outside canvas): pointer capture must still finish the drop.
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(700, 820, { steps: 10 });
    await page.waitForTimeout(200);
    await page.mouse.up();
    await page.waitForTimeout(350);
    const hudRelease = await page.evaluate(id => {
      const s = window.__boardGameApp.scene;
      return { y: s.entityMeshes.get(id)?.position.y, controls: s.controls.enabled };
    }, start.id);
    if (hudRelease.y > 0.2 || !hudRelease.controls) {
      failures.push(`${label}: HUD release left y=${hudRelease.y?.toFixed(2)} controls=${hudRelease.controls}`);
    }


  } catch (error) {
    failures.push(`${label}: threw — ${error?.message ?? error}`);
  }
  if (errors.length) failures.push(`${label}: ${errors.slice(0, 3).join(' | ')}`);
  await page.close();
}

// Discard action: card must settle on the room tile, not clip below it.
{
  const label = 'betrayal:discard-settle';
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  collectErrors(page, errors);
  try {
    await page.goto(`${BASE}?game=betrayal&scenario=exploration`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(1400);
    if (await page.locator('#boot-enter').count()) await page.click('#boot-enter');
    await page.waitForTimeout(600);
    const cameraBefore = await page.evaluate(() => window.__boardGameApp.scene.camera.position.toArray());
    const drop = page.locator('.dock-actions .act[data-fan-label*="丢下"]').first();
    if (!(await drop.count())) throw new Error('discard action missing');
    await drop.click();
    // The fan card opens its detail panel first; run it explicitly.
    await page.waitForTimeout(300);
    await page.locator('#ad-run').click();
    await page.waitForTimeout(900);
    const cameraAfter = await page.evaluate(() => window.__boardGameApp.scene.camera.position.toArray());
    if (JSON.stringify(cameraBefore) !== JSON.stringify(cameraAfter)) {
      failures.push(`${label}: camera moved on discard ${cameraBefore} -> ${cameraAfter}`);
    }
    const result = await page.evaluate(() => {
      const s = window.__boardGameApp.scene;
      const m = s.entityMeshes.get('scenario_item_p1_axe');
      const y = m?.position.y ?? -999;
      const surface = m ? s.surfaceYAt(m.position.x, m.position.z, 'scenario_item_p1_axe') : -999;
      return { y, surface };
    });
    if (result.y < result.surface + 0.01) {
      failures.push(`${label}: card y=${result.y?.toFixed(3)} below tile surface ${result.surface?.toFixed(3)}`);
    }
    console.log(`  ${label.padEnd(28)} cardY=${result.y?.toFixed(3)} surfaceY=${result.surface?.toFixed(3)}`);
    await page.screenshot({ path: 'shots/ui-discard-settle.png' });
  } catch (error) {
    failures.push(`${label}: threw — ${error?.message ?? error}`);
  }
  if (errors.length) failures.push(`${label}: ${errors.slice(0, 3).join(' | ')}`);
  await page.close();
}

// Entity-centric card sheet: art plate + direct actions.
{
  const label = 'betrayal:card-sheet-actions';
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  collectErrors(page, errors);
  try {
    await page.goto(`${BASE}?game=betrayal&scenario=omen_ready`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(1400);
    if (await page.locator('#boot-enter').count()) await page.click('#boot-enter');
    await page.waitForTimeout(700);
    const picked = await page.evaluate(() => {
      const app = window.__boardGameApp;
      const board = app.session.getSnapshot().board;
      const hand = board.zones.zone_hand_p1?.orderedEntities ?? [];
      const id = hand.find(candidate => board.entities[candidate]?.components?.cardFace);
      if (!id) return null;
      app.session.pickTarget({ kind: 'entity', id });
      return id;
    });
    await page.waitForTimeout(300);
    const sheet = await page.evaluate(() => ({
      art: !!document.querySelector('.cs-art svg'),
      actions: document.querySelectorAll('[data-card-action]').length
    }));
    if (!picked || !sheet.art) failures.push(`${label}: card art plate missing`);
    if (sheet.actions === 0) failures.push(`${label}: no entity action shortcuts`);
    await page.screenshot({ path: 'shots/ui-card-sheet-actions.png' });
    console.log(`  ${label.padEnd(28)} art=${sheet.art} actions=${sheet.actions}`);
  } catch (error) {
    failures.push(`${label}: threw — ${error?.message ?? error}`);
  }
  if (errors.length) failures.push(`${label}: ${errors.slice(0, 3).join(' | ')}`);
  await page.close();
}

await browser.close();
dev.stop();
console.log(`\nUI matrix: ${screens} screens, ${actions} action clicks`);
if (failures.length > 0) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exitCode = 1;
} else {
  console.log('\nAll UI matrix checks passed.');
}
