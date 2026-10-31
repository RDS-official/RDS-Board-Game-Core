/**
 * UI fixture matrix: boots every game/scenario, drives a short sequence of
 * action-dock interactions, and checks console/page errors + label overlaps.
 *
 * Speed notes (this suite used to run ~14 minutes single-threaded):
 *  - screens run in a worker pool (`UI_WORKERS`, default 4); each task owns its
 *    own page, so the dev server multiplexes them without sharing state;
 *  - waits are event-driven: `domcontentloaded` plus a predicate on the app's
 *    revision counter replaces the old `networkidle` + fixed sleeps, so a fast
 *    machine finishes a screen in a couple of seconds and a slow one simply
 *    waits a little longer;
 *  - `UI_ONLY=<regex>` narrows the run to matching labels and `UI_SMOKE=1` keeps
 *    only the default screen of each game, for the inner dev loop.
 */

import { availableParallelism } from 'node:os';
import { launchChromium } from './lib/browser.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';
import { gate, startMemoryWatch } from './lib/gates.mjs';

const startedAt = Date.now();
const memory = startMemoryWatch();

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

// One page per core (minus the dev server's share), capped at six: past that the
// shared vite server becomes the bottleneck and the run gets slower, not faster.
const DEFAULT_WORKERS = Math.min(6, Math.max(2, availableParallelism() - 1));
const WORKERS = Math.max(1, Number(process.env.UI_WORKERS ?? DEFAULT_WORKERS));
const ONLY = process.env.UI_ONLY ? new RegExp(process.env.UI_ONLY) : null;
const SMOKE = process.env.UI_SMOKE === '1';
/** `UI_TIMING=1` prints how long each screen spends booting vs driving actions. */
const TIMING = process.env.UI_TIMING === '1';
const now = () => Date.now();

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

/** Open a screen and wait until the session has produced its first snapshot. */
async function openScreen(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page
    .waitForFunction(
      () => (window.__boardGameApp?.session?.getSnapshot?.().revision ?? -1) >= 0,
      null,
      { timeout: 30000 }
    )
    .catch(() => {});
  if (await page.locator('#boot-enter').count()) {
    await page.click('#boot-enter').catch(() => {});
  }
}

/** Current session revision, or -1 when the app is not up yet. */
function revisionOf(page) {
  return page.evaluate(() => window.__boardGameApp?.session?.getSnapshot?.().revision ?? -1);
}

/**
 * Wait until the session advances past `before`.
 *
 * This replaces a fixed 500ms sleep: a dispatch normally lands within a frame or
 * two, and a slow one is caught by the timeout instead of being silently raced.
 */
async function waitForAdvance(page, before, timeout = 900) {
  await page
    .waitForFunction(
      previous => (window.__boardGameApp?.session?.getSnapshot?.().revision ?? -1) > previous,
      before,
      { timeout, polling: 30 }
    )
    .catch(() => {});
}

/**
 * One round trip for "which of these overlays is up?".
 *
 * Each `locator.count()` is a protocol round trip; a step used to make four of
 * them, which costs more than the click itself on a fast machine.
 */
function probeOverlays(page) {
  return page.evaluate(() => ({
    detail: !!document.querySelector('#ad-run'),
    submit: !!document.querySelector('.payload-card button[type="submit"]'),
    cancel: !!document.querySelector('#pf-cancel'),
    placeConfirm: !!document.querySelector('[data-place-confirm]')
  }));
}

/**
 * Wait until the camera stops moving.
 *
 * Placement raises the camera with a tween; sampling its height immediately
 * after the panel opens reads the pre-tween pose. Polling for two identical
 * poses is both faster and steadier than a fixed sleep.
 */
async function waitForCameraStill(page, timeout = 5000) {
  const started = Date.now();
  let previous = null;
  while (Date.now() - started < timeout) {
    const now = await page.evaluate(() => window.__boardGameApp?.scene?.camera?.position?.toArray?.() ?? null);
    if (now && previous && now.every((value, index) => Math.abs(value - previous[index]) < 0.001)) return;
    previous = now;
    await page.waitForTimeout(80);
  }
}

/* -------------------------------------------------------------------------- */
/* Tasks                                                                      */
/* -------------------------------------------------------------------------- */

async function runScreen(browser, game, scenario) {
  const label = `${game.id}${scenario ? `:${scenario}` : ''}`;
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  const failures = [];
  let clicks = 0;
  let state = null;
  collectErrors(page, errors);

  try {
    const openedAt = now();
    await openScreen(page, `${BASE}?game=${game.id}${scenario ? `&scenario=${scenario}` : ''}`);
    const openMs = now() - openedAt;
    const stepsAt = now();

    const initialActions = await page.locator('.dock-actions .act').count();
    if (initialActions === 0) failures.push(`${label}: no action buttons`);

    for (let step = 0; step < 6; step++) {
      const buttons = page.locator('.dock-actions .act');
      if ((await buttons.count()) === 0) break;
      const button = buttons.first();
      if (!(await button.isVisible().catch(() => false))) break;

      const before = await revisionOf(page);
      // `force` skips Playwright's stability wait: the fan cards animate on
      // hover, so the default actionability check idles for two frames on every
      // click. The click still lands on the element's centre.
      await button.click({ force: true });
      clicks++;

      // A fan card opens its detail panel instead of dispatching, so the run
      // button is the step that actually advances the game. Waiting for the
      // revision straight after the fan click used to burn the full timeout on
      // every single step — that alone was ~24s of each screen.
      let overlays = await probeOverlays(page);
      if (!overlays.detail) {
        await page.waitForTimeout(100);
        overlays = await probeOverlays(page);
      }
      if (overlays.detail) await page.locator('#ad-run').click({ force: true }).catch(() => {});
      await waitForAdvance(page, before);

      // Some actions ask for parameters first.
      overlays = await probeOverlays(page);
      if (overlays.submit) {
        await page.locator('.payload-card button[type="submit"]').first().click({ force: true }).catch(() => {});
        await waitForAdvance(page, before);
        overlays = await probeOverlays(page);
      }
      if (overlays.cancel) {
        // Invalid/default payload can leave the modal open; close it before the
        // next action click so the matrix measures the next screen.
        await page.locator('#pf-cancel').click({ force: true }).catch(() => {});
      }
      if (overlays.placeConfirm) {
        await page.locator('[data-place-confirm]').click({ force: true }).catch(() => {});
        await waitForAdvance(page, before);
      }
    }

    const stepsMs = now() - stepsAt;
    if (TIMING) console.log(`    ${label}: open=${openMs}ms steps=${stepsMs}ms clicks=${clicks}`);

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

    state = await page.evaluate(() => {
      const app = window.__boardGameApp;
      if (!app) return null;
      const snapshot = app.session.getSnapshot();
      return {
        actions: snapshot.actions.length,
        log: snapshot.log.cursor,
        stats: app.scene.getRenderStats?.() ?? null,
        heapMb: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576)
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
  return { failures, clicks, heapMb: state?.heapMb ?? 0 };
}

/** Targeted room-orientation flow: draw, raise camera, rotate without refit, place, restore camera. */
async function runRotationFlow(browser) {
  const label = 'betrayal:rotation-flow';
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  const failures = [];
  collectErrors(page, errors);
  try {
    await openScreen(page, `${BASE}?game=betrayal&scenario=exploration`);
    const before = await page.evaluate(() => ({
      rooms: Object.keys(window.__boardGameApp.session.getSnapshot().board.mapGraph.nodes).length,
      camera: window.__boardGameApp.scene.camera.position.toArray()
    }));
    const explore = page.locator('.dock-actions .act[data-fan-label*="探索"]').first();
    if (!(await explore.count())) throw new Error('explore action missing');
    await explore.click();
    // The fan card opens its detail panel first; run it explicitly.
    await page.locator('#ad-run').click();
    await page.locator('.placement-panel').waitFor({ timeout: 8000 });
    // Wait for the condition this flow asserts (the camera rises onto the
    // placement pose) rather than for "the camera stopped moving": under a busy
    // worker pool the tween has not started yet, and two identical samples at
    // t=0 look exactly like a finished tween.
    await page
      .waitForFunction(
        baseY => window.__boardGameApp.scene.camera.position.y > baseY + 0.5,
        before.camera[1],
        { timeout: 6000, polling: 50 }
      )
      .catch(() => {});
    await waitForCameraStill(page);
    const raised = await page.evaluate(() => window.__boardGameApp.scene.camera.position.toArray());
    if (!(raised[1] > before.camera[1] + 0.5)) {
      failures.push(`${label}: placement camera did not rise (${before.camera[1]} -> ${raised[1]})`);
    }

    await waitForCameraStill(page);
    const rotationCameraBefore = await page.evaluate(() => window.__boardGameApp.scene.camera.position.toArray());
    const angles = [];
    for (let i = 0; i < 3; i++) {
      await page.locator('[data-place-rotate]').click();
      await page.waitForTimeout(80);
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
    await page.waitForTimeout(150);
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
    console.log(
      `  ${label.padEnd(28)} rotations=${angles.join('/')} rooms=${before.rooms}->${after.rooms} cameraY=${before.camera[1].toFixed(1)}->${raised[1].toFixed(1)}->${after.camera[1].toFixed(1)} pan=${after.offsetToActor.toFixed(2)}`
    );
    await page.screenshot({ path: 'shots/ui-rotation-flow.png' });
  } catch (error) {
    failures.push(`${label}: threw — ${error?.message ?? error}`);
  }
  if (errors.length) failures.push(`${label}: ${errors.slice(0, 3).join(' | ')}`);
  await page.close();
  return { failures, clicks: 0 };
}

/** Targeted drag-height & settle flow: pick up entity, drag back and forth, ensure height stays stable, drop, ensure it settles to surface. */
async function runDragSettle(browser) {
  const label = 'betrayal:drag-settle-flow';
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  const failures = [];
  collectErrors(page, errors);
  try {
    await openScreen(page, `${BASE}?game=betrayal&scenario=exploration`);

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
      await page.waitForTimeout(20);
      const curY = await page.evaluate(id => window.__boardGameApp.scene.entityMeshes.get(id)?.position.y, start.id);
      heldHeights.push(curY);
    }

    const minHeld = Math.min(...heldHeights);
    const maxHeld = Math.max(...heldHeights);
    if (maxHeld - minHeld > 0.35 || maxHeld > 1.2) {
      failures.push(`${label}: entity flew higher and higher (min=${minHeld.toFixed(2)}, max=${maxHeld.toFixed(2)})`);
    }

    await page.mouse.up();
    // The drop animates onto the surface; wait for the settle queue to drain
    // instead of guessing how long the tween takes on this machine.
    await page
      .waitForFunction(
        id => {
          const scene = window.__boardGameApp.scene;
          const mesh = scene.entityMeshes.get(id);
          return !mesh || (scene.cardSettles.size === 0 && mesh.position.y <= 0.2);
        },
        start.id,
        { timeout: 4000, polling: 50 }
      )
      .catch(() => {});
    await page.waitForTimeout(80);

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
    await page.waitForTimeout(150);
    await page.mouse.up();
    await page.waitForTimeout(250);
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
  return { failures, clicks: 0 };
}

/** Discard action: card must settle on the room tile, not clip below it. */
async function runDiscardSettle(browser) {
  const label = 'betrayal:discard-settle';
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  const failures = [];
  collectErrors(page, errors);
  try {
    await openScreen(page, `${BASE}?game=betrayal&scenario=exploration`);
    const cameraBefore = await page.evaluate(() => window.__boardGameApp.scene.camera.position.toArray());
    const drop = page.locator('.dock-actions .act[data-fan-label*="丢下"]').first();
    if (!(await drop.count())) throw new Error('discard action missing');
    await drop.click();
    // The fan card opens its detail panel first; run it explicitly.
    await page.locator('#ad-run').click();
    await page.waitForTimeout(400);
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
  return { failures, clicks: 0 };
}

/** Entity-centric card sheet: art plate + direct actions. */
async function runCardSheet(browser) {
  const label = 'betrayal:card-sheet-actions';
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  const failures = [];
  collectErrors(page, errors);
  try {
    await openScreen(page, `${BASE}?game=betrayal&scenario=omen_ready`);
    const picked = await page.evaluate(() => {
      const app = window.__boardGameApp;
      const board = app.session.getSnapshot().board;
      const hand = board.zones.zone_hand_p1?.orderedEntities ?? [];
      const id = hand.find(candidate => board.entities[candidate]?.components?.cardFace);
      if (!id) return null;
      app.session.pickTarget({ kind: 'entity', id });
      return id;
    });
    await page.waitForTimeout(200);
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
  return { failures, clicks: 0 };
}

/* -------------------------------------------------------------------------- */
/* Pool                                                                       */
/* -------------------------------------------------------------------------- */

const tasks = [];
for (const game of GAMES) {
  const scenarios = SMOKE ? [undefined] : [undefined, ...game.scenarios];
  for (const scenario of scenarios) {
    const label = `${game.id}${scenario ? `:${scenario}` : ''}`;
    if (ONLY && !ONLY.test(label)) continue;
    tasks.push({ label, run: browser => runScreen(browser, game, scenario) });
  }
}
for (const [label, run] of [
  ['betrayal:rotation-flow', runRotationFlow],
  ['betrayal:drag-settle-flow', runDragSettle],
  ['betrayal:discard-settle', runDiscardSettle],
  ['betrayal:card-sheet-actions', runCardSheet]
]) {
  if (ONLY && !ONLY.test(label)) continue;
  tasks.push({ label, run });
}

const browser = await launchChromium();
const failures = [];
let screens = 0;
let actions = 0;
let peakHeapMb = 0;

let next = 0;
async function worker() {
  while (next < tasks.length) {
    const task = tasks[next++];
    const result = await task.run(browser);
    screens++;
    actions += result.clicks;
    peakHeapMb = Math.max(peakHeapMb, result.heapMb ?? 0);
    failures.push(...result.failures);
  }
}

await Promise.all(Array.from({ length: Math.min(WORKERS, tasks.length) }, () => worker()));

await browser.close();
dev.stop();
const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);
console.log(
  `\nUI matrix: ${screens} screens, ${actions} action clicks, ${seconds}s with ${WORKERS} workers, browser heap peak ${peakHeapMb}MB`
);
failures.push(...gate('ui', { startedAt, memory }));
if (failures.length > 0) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exitCode = 1;
} else {
  console.log('\nAll UI matrix checks passed.');
}
