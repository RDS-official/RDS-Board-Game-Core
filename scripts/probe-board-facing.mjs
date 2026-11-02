/**
 * Board-facing probe: the shared card row must be readable from *every* seat.
 *
 * This is the requirement named directly — "公开的牌在每个玩家自己的视角中，都应该
 * 是正对自己的，不需要旋转视角才能看" — asserted the way a player judges it, in
 * screen space, from each seat's own camera:
 *
 *   1. upright  — the projected text-top of every community card is within
 *                 `MAX_TILT_DEG` of screen-up (a fixed-north row fails five of six
 *                 seats by 85–180°);
 *   2. readable — its projected width is at least `MIN_CARD_PX` (the legacy row
 *                 foreshortens to 16–33px from a seat);
 *   3. left→right — index order reads in order on screen, not mirrored;
 *   4. own hand — the viewer's own hole cards are upright too;
 *   5. capability — the row only turns when the game declared it AND a seat is
 *                 bound; the GOD camera keeps the historical fixed-north row.
 *
 * Run: node scripts/probe-board-facing.mjs   (or `pnpm probe:board`)
 */
import { launchChromium } from './lib/browser.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';

const SCENARIO = 'ai_table_6';
const SEATS = 6;
const MAX_TILT_DEG = 15;
const MIN_CARD_PX = 60;
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

const describe = card => `${card.tilt.toFixed(0)}° ${card.widthPx.toFixed(0)}px`;

console.log(`board-facing probe · poker/${SCENARIO} · ${VIEWPORT.width}x${VIEWPORT.height}\n`);

await page.goto(`${dev.url}/?game=poker&scenario=${SCENARIO}`);
await page.waitForFunction(() => !!window.__boardGameApp?.scene?.lastState, { timeout: 30_000 });

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
const report = (tag, shot, { expectFixedRow = false } = {}) => {
  if (shot.error) return bad(`${tag}: ${shot.error}`);
  if (shot.board.length === 0) return bad(`${tag}: no community cards on the felt`);

  const summary = shot.board.map(describe).join(' · ');
  const worstTilt = Math.max(...shot.board.map(card => card.tilt));
  const worstWidth = Math.min(...shot.board.map(card => card.widthPx));
  const xs = shot.board.map(card => card.screenX);

  if (expectFixedRow) {
    // The capability is deliberately off for the omniscient camera: the row must
    // still be the unturned one, or the debug view and screenshot scripts change.
    return pick(
      Math.max(...shot.board.map(card => Math.abs(card.yaw))) < 1e-3,
      `${tag}: fixed-north row kept (${shot.board.length} cards, ${summary})`,
      `${tag}: row was turned to the camera (expected yaw 0)`
    );
  }

  pick(worstTilt <= MAX_TILT_DEG, `${tag}: upright ${worstTilt.toFixed(0)}° — ${summary}`,
    `${tag}: tilt ${worstTilt.toFixed(0)}° > ${MAX_TILT_DEG}° — ${summary}`);
  // Reading order left → right: an upright but mirrored row reads 10♠K♥.
  pick(xs.every((x, i) => i === 0 || x > xs[i - 1]), `${tag}: reads left→right`,
    `${tag}: mirrored — screen x ${xs.map(v => v.toFixed(0)).join('/')}`);
  pick(worstWidth >= MIN_CARD_PX, `${tag}: readable (min ${worstWidth.toFixed(0)}px)`,
    `${tag}: too small — min ${worstWidth.toFixed(0)}px < ${MIN_CARD_PX}px (${summary})`);

  // Own hand: the requirement is about the player's own view of the table. A seat
  // that folded has no cards left (they are in the muck) — a correct projection.
  if (shot.handEmpty) return ok(`${tag}: folded, no own cards to measure`);
  if (shot.own.length === 0) return bad(`${tag}: own hand not projected (binding broken)`);
  const handTilt = Math.max(...shot.own.map(card => card.tilt));
  pick(handTilt <= MAX_TILT_DEG, `${tag}: own hand upright (${handTilt.toFixed(0)}°)`,
    `${tag}: own hand tilt ${handTilt.toFixed(0)}° > ${MAX_TILT_DEG}°`);
};

const reachedFlop = await dealToFlop();
// The deal fans cards out over ~0.5s per card plus a stagger; measuring during
// that window reads a card mid-flight and calls it sideways.
await page.waitForTimeout(3500);
if (!reachedFlop) bad('the probe could not reach the flop — nothing to measure');

// The table opens seated now (the game declares its protagonist), so the
// omniscient camera has to be asked for explicitly before asserting it.
await setViewer('GOD');
report('GOD view', await page.evaluate(measure), { expectFixedRow: true });

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
  report(`seat ${seatIndex} (${seat})`, await page.evaluate(measure));
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
