/**
 * Own-hand visibility probe: the player's cards must never sit under the HUD.
 *
 * The hand row is drawn on the felt in front of the player's seat. The action
 * dock paints over the same corner of the canvas, and how much it covers is a
 * function of the viewport, not a constant: a left third of the bottom edge on
 * desktop (1/7 … 4/7), a full-width drawer between 768px and 1200px, a thin strip
 * on a phone. With a fixed row depth the cards were buried — measured on seven
 * viewports, five of them covered 65–100% of every card, so the player was
 * looking at their own hole cards through the dock's buttons.
 *
 * The renderer now solves the row depth against the shell's real footprint
 * (`render/handRowDepth.ts`). This probe is what keeps that honest: it projects
 * every own card to screen space, intersects it with the panels the HUD actually
 * paints, and fails if the hand is covered or unreadable.
 *
 *   1. clear     — no reserved panel covers more than `MAX_COVERED` of a card;
 *   2. readable  — a card is at least `MIN_CARD_PX` wide on screen;
 *   3. on-screen — the card is inside the viewport, not pushed off an edge;
 *   4. in place  — the row is still in front of its seat, between the depth
 *                  bounds: dodging the HUD must not fling the hand across the
 *                  table or bury it in the player's own standee.
 *
 * Run: node scripts/probe-hand-visibility.mjs   (or `pnpm probe:hand:view`)
 */
import { launchChromium } from './lib/browser.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';

/** Games whose own hand is a face-up row on the felt worth measuring. */
const CASES = [
  { game: 'poker', scenario: 'ai_table_6', seat: 'p1' },
  { game: 'sanguosha', seat: 'p1' }
];

/** Viewports that exercise every shell layout the dock has. */
const VIEWPORTS = [
  { name: '1920x1080 desktop', width: 1920, height: 1080 },
  { name: '1680x1050 desktop', width: 1680, height: 1050 },
  { name: '1440x960  desktop', width: 1440, height: 960 },
  { name: '1280x960  desktop', width: 1280, height: 960 },
  { name: '1024x768  drawer ', width: 1024, height: 768 },
  { name: '820x1180  tablet ', width: 820, height: 1180 },
  { name: '390x844   phone  ', width: 390, height: 844 }
];

/** A card may lose this fraction of its area to a panel and still count as seen. */
const MAX_COVERED = 0.05;
/** Screen width below which the pips are unreadable. */
const MIN_CARD_PX = 34;
/** Row depth bounds the renderer is allowed to use (mirrors the scene). */
const DEPTH_MIN = 0.35;
const DEPTH_MAX = 2.6;

const dev = await ensureSoloServer();
const browser = await launchChromium();

const failures = [];
let checks = 0;
const ok = message => {
  checks++;
  console.log(`    ok  ${message}`);
};
const bad = message => {
  checks++;
  failures.push(message);
  console.log(`    FAIL ${message}`);
};
const pick = (pass, passMessage, failMessage) => (pass ? ok(passMessage) : bad(failMessage));

/**
 * Runs in the page: project every own-hand card and intersect it with the panels
 * the shell is painting. Card extents come from the mesh's own matrix, so the
 * fan on cards is included, not just their centres.
 */
const measure = () => {
  const app = window.__boardGameApp;
  const scene = app?.scene;
  const state = scene?.lastState;
  if (!scene || !state) return { error: 'scene not ready' };

  const camera = scene.camera;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  camera.updateMatrixWorld();
  const viewProjection = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse);
  const project = (x, y, z) => {
    const e = viewProjection.elements;
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    return {
      x: ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w) * 0.5 * vw + vw / 2,
      y: (-((e[1] * x + e[5] * y + e[9] * z + e[13]) / w)) * 0.5 * vh + vh / 2
    };
  };

  const panels = [];
  for (const selector of ['#action-dock', '.app-shell > .hand-slot', '#player-rail', '#activity-feed', '#room-card']) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    panels.push({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
  }

  const viewer = state.viewerId;
  const zone = viewer && viewer !== 'GOD' ? state.zones?.[`zone_hand_${viewer}`] : null;
  const cards = [];
  for (const id of zone?.orderedEntities ?? []) {
    const mesh = scene.entityMeshes.get(id);
    if (!mesh) continue;
    mesh.updateWorldMatrix(true, false);
    const e = mesh.matrixWorld.elements;
    // The card mesh is 1.12 wide and 1.68 deep before scaling; measure the
    // footprint, which is what a covering panel actually eats into.
    const halfWidth = 0.56 * Math.abs(mesh.scale.x);
    const halfDepth = 0.84 * Math.abs(mesh.scale.z);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const [dx, dz] of [
      [-halfWidth, -halfDepth],
      [halfWidth, -halfDepth],
      [halfWidth, halfDepth],
      [-halfWidth, halfDepth]
    ]) {
      const p = project(
        e[12] + e[0] * dx + e[8] * dz,
        e[13] + e[1] * dx + e[9] * dz,
        e[14] + e[2] * dx + e[10] * dz
      );
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    const rect = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    const area = Math.max(1, rect.width * rect.height);
    let covered = 0;
    for (const panel of panels) {
      const w = Math.min(rect.x + rect.width, panel.x + panel.width) - Math.max(rect.x, panel.x);
      const h = Math.min(rect.y + rect.height, panel.y + panel.height) - Math.max(rect.y, panel.y);
      if (w > 0 && h > 0) covered = Math.max(covered, (w * h) / area);
    }
    cards.push({ id, ...rect, covered });
  }

  // Where the row sits relative to its seat, so the fix cannot cheat by
  // flinging the hand across the table.
  const row = scene.handRows?.get(`zone_hand_${viewer}`);
  const seatNode = Object.values(state.mapGraph.nodes).find(
    node => node.type === 'SEAT' && String(node.props?.playerId ?? '') === String(viewer)
  );
  let depth = null;
  if (row && seatNode) {
    const [sx, , sz] = seatNode.position;
    const length = Math.max(1e-6, Math.hypot(sx, sz));
    const outX = sx / length;
    const outZ = sz / length;
    depth = (row.originX - seatNode.position[0]) * outX + (row.originZ - seatNode.position[2]) * outZ;
  }

  return { viewer, cards, depth, panels: panels.length, vw, vh };
};

console.log('own-hand visibility probe\n');

for (const testCase of CASES) {
  console.log(`  ${testCase.game}`);
  for (const viewport of VIEWPORTS) {
    const page = await browser.newPage({ viewport });
    const url = `${dev.url}/?game=${testCase.game}${testCase.scenario ? `&scenario=${testCase.scenario}` : ''}`;
    await page.goto(url);
    await page.waitForFunction(() => !!window.__boardGameApp?.scene?.lastState, { timeout: 30_000 });

    // Give the hand something in it: press the dock's own start action, or wait
    // for the setup to deal. Never touch kernel internals.
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const state = await page.evaluate(
        seat => {
          const session = window.__boardGameApp.session;
          const snapshot = session.getSnapshot();
          return {
            dealt: (snapshot.board.zones?.[`zone_hand_${seat}`]?.orderedEntities?.length ?? 0) > 0,
            actions: (snapshot.actions ?? []).map(action => ({ id: action.id, type: action.actionType }))
          };
        },
        testCase.seat
      );
      if (state.dealt) break;
      const start = state.actions.find(action =>
        ['START_HAND', 'FORCE_START', 'END_TURN'].includes(action.type)
      );
      if (start) await page.evaluate(id => window.__boardGameApp.session.perform(id), start.id);
      await page.waitForTimeout(600);
    }

    await page.evaluate(seat => window.__boardGameApp.session.setViewer(seat), testCase.seat);
    // Seat camera tween (520ms) + the deal fan.
    await page.waitForTimeout(2600);

    const shot = await page.evaluate(measure);
    const tag = `${viewport.name} · ${testCase.game}`;
    if (shot.error) {
      bad(`${tag}: ${shot.error}`);
      await page.close();
      continue;
    }
    if (shot.cards.length === 0) {
      bad(`${tag}: no own cards on the felt`);
      await page.close();
      continue;
    }

    const worstCovered = Math.max(...shot.cards.map(card => card.covered));
    pick(
      worstCovered <= MAX_COVERED,
      `${tag}: clear of the HUD (worst ${(worstCovered * 100).toFixed(0)}%)`,
      `${tag}: covered by a panel — worst ${(worstCovered * 100).toFixed(0)}% > ${MAX_COVERED * 100}%`
    );

    const narrowest = Math.min(...shot.cards.map(card => card.width));
    pick(
      narrowest >= MIN_CARD_PX,
      `${tag}: readable (min ${narrowest.toFixed(0)}px)`,
      `${tag}: too small — ${narrowest.toFixed(0)}px < ${MIN_CARD_PX}px`
    );

    const offScreen = shot.cards.filter(
      card =>
        card.x < -1 ||
        card.y < -1 ||
        card.x + card.width > shot.vw + 1 ||
        card.y + card.height > shot.vh + 1
    );
    pick(
      offScreen.length === 0,
      `${tag}: inside the viewport`,
      `${tag}: ${offScreen.length} card(s) pushed off-screen`
    );

    if (shot.depth === null) {
      ok(`${tag}: row depth not applicable`);
    } else {
      pick(
        shot.depth >= DEPTH_MIN - 1e-3 && shot.depth <= DEPTH_MAX + 1e-3,
        `${tag}: row sits in front of its seat (depth ${shot.depth.toFixed(2)})`,
        `${tag}: row depth ${shot.depth.toFixed(2)} outside ${DEPTH_MIN}..${DEPTH_MAX}`
      );
    }

    await page.close();
  }
  console.log('');
}

await browser.close();
await dev.stop();

console.log(`hand visibility: ${checks - failures.length}/${checks} checks passed`);
if (failures.length) {
  console.log(`\nFAILED (${failures.length}):`);
  for (const failure of failures) console.log(`  x ${failure}`);
  process.exitCode = 1;
}
