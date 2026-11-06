import { launchChromium } from './lib/browser.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';

/**
 * Scene furniture cache probe (docs/ARCHITECTURE-ISSUES.md AR-20 / issue #215).
 *
 * `syncState()` used to dispose and rebuild every board object on each action,
 * so two consecutive actions produced two entirely new object graphs even when
 * nothing on the table had changed. `render/objectCache.ts` now keys each
 * procedurally built piece by (key, content signature) and clones an unchanged
 * template instead of re-running its builder.
 *
 * This probe drives real actions and asserts the two things that can break:
 *
 *  1. reuse actually happens — the cache reports hits, and the reuse count grows
 *     with the number of actions instead of staying at zero;
 *  2. the cached board is structurally identical to a cold rebuild of the same
 *     snapshot — a stale signature would show up as a missing or duplicated
 *     mesh here, even when the stale object happens to sit in the right place.
 *
 * Positions are deliberately excluded from the structural digest: settle tweens
 * and the seat-beacon spinner animate local offsets, so they differ between a
 * board that has been running and one that was just rebuilt.
 *
 * Run: node scripts/probe-scene-cache.mjs
 */
const dev = await ensureSoloServer();
const browser = await launchChromium();

const failures = [];
let checks = 0;
const record = (name, ok, detail) => {
  checks++;
  if (!ok) failures.push(`${name}: ${detail}`);
};

const SCREENS = [
  { game: 'poker', scenario: 'seats_4' },
  { game: 'betrayal', scenario: 'exploration' },
];

for (const screen of SCREENS) {
  const label = `${screen.game}${screen.scenario ? `:${screen.scenario}` : ''}`;
  const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error?.message ?? error)));

  await page.goto(`${dev.url}?game=${screen.game}&scenario=${screen.scenario}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForTimeout(4200);
  if (await page.locator('#boot-enter').count()) {
    await page.click('#boot-enter').catch(() => {});
  }
  await page.waitForFunction(() => !!window.__boardGameApp, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2200);

  const result = await page.evaluate(async () => {
    const app = window.__boardGameApp;
    if (!app) return { failed: 'never reached the game view' };
    const scene = app.scene;
    const engine = app.session.engine;

    // Time every syncState call: `lastSyncMs` only keeps the most recent one and
    // the render loop calls it every frame, which hides the rebuilds.
    const proto = Object.getPrototypeOf(scene);
    const originalSync = proto.syncState;
    const durations = [];
    scene.syncState = function instrumented(...args) {
      const startedAt = performance.now();
      const value = originalSync.apply(this, args);
      durations.push(performance.now() - startedAt);
      return value;
    };

    const digest = () => {
      const parts = [];
      for (const root of [scene.boardObjectsGroup, scene.ownHandGroup, scene.dealerAreaGroup]) {
        root.traverse((object) => {
          // Only furniture that came out of the cache: standees, beacons and nav
          // arrows are animated per frame, so their colours and local offsets say
          // nothing about whether a cache entry went stale.
          const key = object.userData?.cacheKey;
          if (!key) return;
          const material = Array.isArray(object.material) ? object.material[0] : object.material;
          const geometry = object.geometry?.attributes?.position?.count ?? '-';
          parts.push(`${key}|${object.type}|${object.children.length}|${geometry}|${material?.type ?? '-'}`);
        });
      }
      const text = parts.join('|');
      let hash = 0x811c9dc5;
      for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
      }
      return { count: parts.length, hash: (hash >>> 0).toString(36) };
    };

    const baseline = scene.getRenderStats();
    const rows = [];
    let actions = 0;
    for (let step = 0; step < 8; step++) {
      const raw = engine.getRawState();
      const active = raw.activeActorId ?? raw.activePlayerId;
      const legal = engine.getLegalActions(active);
      const action =
        legal.find((entry) => entry.type === 'END_TURN' || entry.type === 'END_NPC_TURN') ?? legal[0];
      if (!action) break;
      durations.length = 0;
      engine.dispatch(action);
      app.session.setViewer('GOD');
      await new Promise((resolve) => setTimeout(resolve, 420));
      actions++;
      const stats = scene.getRenderStats();
      const rebuilds = durations.filter((ms) => ms >= 1);
      rows.push({
        step: `${step}:${action.type}`,
        hits: stats.cachedObjects - baseline.cachedObjects,
        misses: stats.rebuiltObjects - baseline.rebuiltObjects,
        maxSyncMs: rebuilds.length ? Math.round(Math.max(...rebuilds) * 10) / 10 : 0,
      });
    }
    delete scene.syncState;

    // Same snapshot, cache cleared: the two boards must be structurally equal.
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const warm = digest();
    const snapshot = app.session.getSnapshot();
    scene.resetForNewGame();
    scene.syncState(snapshot.board, snapshot.placement);
    const cold = digest();

    return {
      actions,
      rows,
      warm,
      cold,
      rebuilds: scene.getRenderStats().boardRebuilds,
      lastHits: scene.getRenderStats().cachedObjects - baseline.cachedObjects,
    };
  });

  if (result.failed) {
    failures.push(`${label}: ${result.failed}`);
    await page.close();
    continue;
  }

  const maxSync = Math.max(0, ...result.rows.map((row) => row.maxSyncMs));
  console.log(
    `${label}: ${result.actions} actions, ${result.rebuilds} rebuilds, reuse=${result.lastHits}, slowest sync ${maxSync}ms`,
  );
  for (const row of result.rows) {
    console.log(
      `    ${row.step.padEnd(18)} hits=${String(row.hits).padStart(3)} misses=${String(row.misses).padStart(2)} max=${row.maxSyncMs}ms`,
    );
  }
  console.log(`    warm=${JSON.stringify(result.warm)} cold=${JSON.stringify(result.cold)}`);

  record(label, result.actions >= 4, `only ${result.actions} actions could be driven`);
  // The first sync of a screen always builds; every later action must reuse.
  record(
    label,
    result.lastHits >= result.actions,
    `only ${result.lastHits} cache hits over ${result.actions} actions`,
  );
  record(
    label,
    result.warm.hash === result.cold.hash && result.warm.count === result.cold.count,
    `the cached board does not match a cold rebuild (${JSON.stringify(result.warm)} vs ${JSON.stringify(result.cold)})`,
  );
  record(label, pageErrors.length === 0, `page errors: ${pageErrors.slice(0, 2).join(' | ')}`);
  await page.close();
}

console.log(`\nScene cache probe: ${checks} checks`);
if (failures.length) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const failure of failures) console.log(`  x ${failure}`);
  process.exitCode = 1;
} else {
  console.log('\nBoard furniture is reused across actions and matches a cold rebuild.');
}

await browser.close();
dev.stop();
