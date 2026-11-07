import { launchChromium } from './lib/browser.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';

/**
 * Hand-drag camera probe.
 *
 * Dragging the (read-only) 3D hand used to fall through to OrbitControls and
 * rotate the whole view. The fix locks the camera for any press on a surface
 * that declares `orbitLock` (the hand), while leaving ordinary board drags free
 * to orbit.
 *
 * Proves in a real browser:
 *   1. There is a hand surface (`metadata.orbitLock`) on screen.
 *   2. Dragging it leaves the camera position untouched and re-enables controls.
 *   3. It does not open a detail sheet after the drag.
 *   4. Dragging empty space still orbits (the lock is not over-applied).
 *
 * Run: node scripts/probe-hand-drag-camera.mjs
 */

const dev = await ensureSoloServer();
const browser = await launchChromium();
const failures = [];
const checks = [];
const record = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
};

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
try {
  await page.goto(`${dev.url}?game=betrayal&scenario=exploration`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForTimeout(4200);
  if (await page.locator('#boot-enter').count()) await page.click('#boot-enter').catch(() => {});
  await page.waitForTimeout(1600);

  const found = await page.evaluate(() => {
    const scene = window.__boardGameApp?.scene;
    const canvas = document.querySelector('canvas');
    if (!scene || !canvas) return null;
    const r = canvas.getBoundingClientRect();
    // The hand is a camera-attached strip at the bottom centre.
    const x0 = r.left + r.width * 0.25;
    const x1 = r.left + r.width * 0.75;
    const y0 = r.top + r.height * 0.55;
    const y1 = r.bottom - 6;
    for (let y = y1; y >= y0; y -= 12) {
      for (let x = x0; x <= x1; x += 12) {
        const d = scene.raycaster.pickAt(x, y);
        if (d && d.metadata && d.metadata.orbitLock === true) return { x, y, id: d.id };
      }
    }
    return null;
  });
  record('hand surface found on screen', !!found, JSON.stringify(found));

  if (found) {
    const before = await page.evaluate(() => {
      const scene = window.__boardGameApp?.scene;
      const p = scene.camera.position;
      const t = scene.controls.target;
      return { p: { x: p.x, y: p.y, z: p.z }, t: { x: t.x, y: t.y, z: t.z } };
    });

    await page.mouse.move(found.x, found.y);
    await page.mouse.down();
    await page.mouse.move(found.x + 90, found.y - 24, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(450);

    const after = await page.evaluate(() => {
      const scene = window.__boardGameApp?.scene;
      const p = scene.camera.position;
      const t = scene.controls.target;
      const layer = document.querySelector('#payload-layer');
      return {
        p: { x: p.x, y: p.y, z: p.z },
        t: { x: t.x, y: t.y, z: t.z },
        controls: scene.controls.enabled,
        sheet: layer ? getComputedStyle(layer).display : 'missing',
      };
    });

    const dp = Math.hypot(after.p.x - before.p.x, after.p.y - before.p.y, after.p.z - before.p.z);
    const dt = Math.hypot(after.t.x - before.t.x, after.t.y - before.t.y, after.t.z - before.t.z);
    record('hand drag does not move the camera', dp < 1e-3 && dt < 1e-3, `dp=${dp.toFixed(4)} dt=${dt.toFixed(4)}`);
    record('controls re-enabled after hand drag', after.controls === true, String(after.controls));
    record('hand drag does not open a sheet', after.sheet === 'none' || after.sheet === 'missing', after.sheet);

    /* ---- empty-space drag must still orbit --------------------------- */
    const empty = await page.evaluate(() => {
      const scene = window.__boardGameApp?.scene;
      const canvas = document.querySelector('canvas');
      const r = canvas.getBoundingClientRect();
      // Central board area, away from the topbar and the side panels.
      for (let y = r.top + r.height * 0.18; y < r.top + r.height * 0.5; y += 16) {
        for (let x = r.left + r.width * 0.38; x < r.left + r.width * 0.66; x += 16) {
          if (document.elementFromPoint(x, y) !== canvas) continue;
          if (!scene.raycaster.pickAt(x, y)) return { x, y };
        }
      }
      return null;
    });
    record('empty canvas point found', !!empty, JSON.stringify(empty));
    if (empty) {
      const p0 = await page.evaluate(() => {
        const p = window.__boardGameApp.scene.camera.position;
        return { x: p.x, y: p.y, z: p.z };
      });
      await page.mouse.move(empty.x, empty.y);
      await page.mouse.down();
      await page.mouse.move(empty.x + 120, empty.y + 10, { steps: 14 });
      await page.mouse.up();
      await page.waitForTimeout(500);
      const p1 = await page.evaluate(() => {
        const p = window.__boardGameApp.scene.camera.position;
        return { x: p.x, y: p.y, z: p.z };
      });
      const d = Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
      record('empty-space drag still orbits', d > 0.01, `moved=${d.toFixed(4)}`);
    }
  }
} finally {
  await browser.close();
}

const passed = checks.filter((c) => c.ok).length;
for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
if (failures.length > 0) {
  console.error(`\nhand-drag-camera: ${passed}/${checks.length} checks passed`);
  for (const f of failures) console.error('  x ' + f);
  process.exit(1);
}
console.log(`\nhand-drag-camera: ${passed}/${checks.length} checks passed`);
process.exit(0);
