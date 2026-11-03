/**
 * Board-orientation probe: the shared card row keeps ONE fixed world bearing.
 *
 * The current product rule is deliberately the opposite of the earlier
 * "turn the row towards every seat" experiment: community cards are physical
 * table objects, so their yaw must not depend on which seat (or GOD camera) is
 * looking at them. A seat therefore rotates its *view* around the fixed row,
 * not the row under the viewer.
 *
 * Asserted from each seat's camera and from GOD:
 *
 *   1. all cards in the row share the same world yaw;
 *   2. every seat's board yaw matches the GOD baseline;
 *   3. the game leaves the `boardFacesViewer` capability undeclared, which is
 *      why the fixed row is the expected behaviour for all viewers.
 *
 * Run: node scripts/probe-board-facing.mjs   (or `pnpm probe:board`)
 */
import { launchChromium } from './lib/browser.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';

const SCENARIO = 'ai_table_6';
const SEATS = 6;
/** World yaw is exact arithmetic; only float round-off is tolerated. */
const YAW_EPSILON = 1e-6;
const VIEWPORT = { width: 1400, height: 900 };

const dev = await ensureSoloServer();
const browser = await launchChromium();
const page = await browser.newPage({ viewport: VIEWPORT });

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
/** Record one pass/fail pair: `pick(pass, okMessage, failMessage)`. */
const pick = (pass, passMessage, failMessage) => (pass ? ok(passMessage) : bad(failMessage));

/**
 * Runs in the page: orient and size every community card from the current
 * camera, the way a player reads the felt. The card's face is on +Y and the
 * printed top is local −Z, so its on-screen "up" is the projected local −Z.
 * Measuring the screen direction (not the world yaw) includes the seat camera's
 * pitch — a card upright in world space but seen from a raked seat still fails.
 */
const measure = () => {
  const app = window.__boardGameApp;
  if (!app) return { error: 'no app handle' };
  const scene = app.scene;
  if (!scene) return { error: 'no scene handle' };
  const camera = scene.camera;
  const meshes = scene.entityMeshes;
  const state = scene.lastState;
  if (!camera || !meshes || !state) return { error: 'scene not ready' };

  const boardZone = state.zones?.zone_board;
  if (!boardZone) return { error: 'no zone_board' };

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // The probe runs in the page but has no THREE global: project by hand. Camera
  // matrices are already world → camera → NDC, so one vector-matrix multiply is
  // all a screen position needs.
  camera.updateMatrixWorld();
  const viewProjection = camera.projectionMatrix
    .clone()
    .multiply(camera.matrixWorldInverse);
  const project = (x, y, z) => {
    const e = viewProjection.elements;
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    const cx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const cy = e[1] * x + e[5] * y + e[9] * z + e[13];
    return { x: (cx / w * 0.5 + 0.5) * vw, y: (-cy / w * 0.5 + 0.5) * vh };
  };

  const measureCard = mesh => {
    if (!mesh) return null;
    mesh.updateWorldMatrix(true, false);
    const m = mesh.matrixWorld.elements;
    const origin = [m[12], m[13], m[14]];
    // Column 2 of the world matrix is the local +Z axis, column 0 the local +X.
    // Text top is local −Z, so the on-screen "up" is minus that column. Each is
    // normalised so mesh scale does not leak into the direction.
    const unit = (x, y, z) => {
      const len = Math.hypot(x, y, z) || 1;
      return [x / len, y / len, z / len];
    };
    const [zx, zy, zz] = unit(m[8], m[9], m[10]);
    const topDir = [-zx, -zy, -zz];
    const rightDir = unit(m[0], m[1], m[2]);

    const centre = project(origin[0], origin[1], origin[2]);
    const top = project(
      origin[0] + topDir[0],
      origin[1] + topDir[1],
      origin[2] + topDir[2]
    );
    // Card width on screen: the mesh's own +X extent, in world units, measured
    // from the same centre — so the number is the readable width of the face.
    const right = project(
      origin[0] + rightDir[0],
      origin[1] + rightDir[1],
      origin[2] + rightDir[2]
    );
    const rightNegative = project(
      origin[0] - rightDir[0],
      origin[1] - rightDir[1],
      origin[2] - rightDir[2]
    );

    const dx = top.x - centre.x;
    const dy = top.y - centre.y;
    // Screen-up is (0, -1) in CSS pixels; measuring against it, not against the
    // world yaw, is what includes the seat camera's pitch and roll.
    const tilt = Math.abs(((Math.atan2(dx, -dy) * 180) / Math.PI + 540) % 360 - 180);
    // One world unit along the card's width, in pixels, times the mesh width.
    const widthPx = Math.hypot(right.x - rightNegative.x, right.y - rightNegative.y) * Math.abs(mesh.scale.x || 1);
    // World yaw of the row (0 = fixed north) so the capability gate can prove the
    // GOD camera did not turn it; `screenX` guards reading order (a mirrored row
    // reads 10♠K♥ instead of K♥10♠).
    return { tilt, widthPx, yaw: Math.atan2(rightDir[2], rightDir[0]), screenX: centre.x };
  };

  const board = [];
  for (const id of boardZone.orderedEntities ?? []) {
    const card = measureCard(meshes.get(id));
    if (card) board.push({ id, ...card });
  }

  const own = [];
  const viewer = state.viewerId;
  const handZone = viewer && viewer !== 'GOD' ? state.zones?.[`zone_hand_${viewer}`] : undefined;
  const handEmpty = !!handZone && (handZone.orderedEntities?.length ?? 0) === 0;
  for (const id of handZone?.orderedEntities ?? []) {
    const card = measureCard(meshes.get(id));
    if (card) own.push({ id, ...card });
  }

  return { viewer, board, own, handEmpty, hasHandZone: !!handZone };
};

const setViewer = async seat => {
  await page.evaluate(async target => {
    const app = window.__boardGameApp;
    app.session.setViewer(target);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, seat);
  // The seat camera tweens for 520ms; the probe reads a settled frame.
  await page.waitForTimeout(900);
};

const describe = card => `${(card.yaw * 180 / Math.PI).toFixed(2)}° ${card.widthPx.toFixed(0)}px`;
/** Smallest absolute angle between two bearings. */
const angularDistance = (a, b) => Math.abs(((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI);

console.log(`board-orientation probe · poker/${SCENARIO} · ${VIEWPORT.width}x${VIEWPORT.height}\n`);

await page.goto(`${dev.url}/?game=poker&scenario=${SCENARIO}`);
await page.waitForFunction(() => !!window.__boardGameApp?.scene?.lastState, { timeout: 30_000 });

// The fixed row is the behaviour *because* the game does not opt into the
// viewer-turning capability. Assert the declaration itself, not just its effect.
const boardFacesViewer = await page.evaluate(async () => {
  const layout = await import('/packages/app/src/layout.ts');
  return layout.layoutForGame('poker').boardFacesViewer;
});
pick(
  boardFacesViewer === undefined,
  'poker leaves boardFacesViewer undeclared (fixed row is the contract)',
  `poker declared boardFacesViewer=${String(boardFacesViewer)} — expected undeclared`
);

/**
 * Drive the table to a street that actually has community cards.
 *
 * Presses the same UI actions a player does (`session.perform`), never kernel
 * internals: start the hand, then keep checking/calling as the human seat while
 * the AI seats run on their own timer. `actionType` is the kernel action behind
 * the button; the probe never parses localised labels.
 */
const dealToFlop = async () => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const snapshot = window.__boardGameApp.session.getSnapshot();
      return {
        cards: snapshot.board.zones?.zone_board?.orderedEntities?.length ?? 0,
        actions: (snapshot.actions ?? []).map(a => ({ id: a.id, type: a.actionType }))
      };
    });
    if (state.cards >= 3) return true;
    const pick = state.actions.find(a => ['START_HAND', 'CHECK', 'CALL'].includes(a.type));
    if (pick) await page.evaluate(id => window.__boardGameApp.session.perform(id), pick.id);
    await page.waitForTimeout(700);
  }
  return false;
};

/** Report one camera's view of the board (used for GOD and every seat). */
const report = (tag, shot, baselineYaw) => {
  if (shot.error) return bad(`${tag}: ${shot.error}`);
  if (shot.board.length === 0) return bad(`${tag}: no community cards on the felt`);

  const summary = shot.board.map(describe).join(' · ');
  const yaws = shot.board.map(card => card.yaw);
  const yawSpread = Math.max(...yaws) - Math.min(...yaws);
  const maxBaselineDrift = Math.max(...yaws.map(yaw => angularDistance(yaw, baselineYaw)));
  // The shared row is part of the table, not of the viewer: every camera must
  // read the same world yaw, and every card in the row must agree with it.
  pick(
    yawSpread <= YAW_EPSILON && maxBaselineDrift <= YAW_EPSILON,
    `${tag}: fixed row yaw ${(baselineYaw * 180 / Math.PI).toFixed(2)}° (${shot.board.length} cards, ${summary})`,
    `${tag}: yaw drift ${(maxBaselineDrift * 180 / Math.PI).toFixed(2)}° vs GOD / spread ${(yawSpread * 180 / Math.PI).toFixed(2)}° — ${summary}`
  );
};

const reachedFlop = await dealToFlop();
// The deal fans cards out over ~0.5s per card plus a stagger; measuring during
// that window reads a card mid-flight and calls it sideways.
await page.waitForTimeout(3500);
if (!reachedFlop) bad('the probe could not reach the flop — nothing to measure');

// The table opens seated now (the game declares its protagonist), so the
// omniscient camera has to be asked for explicitly before asserting it.
await setViewer('GOD');
const godView = await page.evaluate(measure);
const baselineYaw = godView.board?.[0]?.yaw ?? 0;
report('GOD view', godView, baselineYaw);

for (let seatIndex = 0; seatIndex < SEATS; seatIndex++) {
  const seat = await page.evaluate(async index => {
    const nodes = Object.values(window.__boardGameApp.session.getSnapshot().board.mapGraph.nodes);
    const node = nodes.find(entry => entry.type === 'SEAT' && entry.props?.seatIndex === index);
    return node ? String(node.props.playerId) : null;
  }, seatIndex);
  if (!seat) {
    bad(`seat ${seatIndex}: no SEAT node`);
    continue;
  }
  await setViewer(seat);
  report(`seat ${seatIndex} (${seat})`, await page.evaluate(measure), baselineYaw);
}

await page.close();
await browser.close();
await dev.stop();

console.log(`\nboard-facing: ${checks - failures.length}/${checks} checks passed`);
if (failures.length) {
  console.log(`\nFAILED (${failures.length}):`);
  for (const failure of failures) console.log(`  x ${failure}`);
  process.exitCode = 1;
}
