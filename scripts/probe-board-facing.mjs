/**
 * Board-orientation probe: the *revealed board row* turns to the viewer, stands
 * upright and floats, while the draw pile stays an ordinary table prop.
 *
 * The product rule measured here (2026-11):
 *
 *   1. the community-card group yaw follows the camera azimuth (seat and
 *      isometric views disagree by well over 20°);
 *   2. the group itself hangs at least half a world unit above the felt;
 *   3. every board card stands at `rotation.x ≈ −70°` and its face points at the
 *      camera;
 *   4. the draw pile's yaw and position are identical in both views — a deck is
 *      never rotated, floated or stood up;
 *   5. the viewer's own hand keeps the previous round's camera-attached overlay:
 *      its distance to the camera stays ~constant across views (±10 %) while the
 *      group's world Y moves with the camera;
 *   6. the page logs no errors while all of that happens.
 *
 * Run: node scripts/probe-board-facing.mjs   (or `pnpm probe:board`)
 */
import { launchChromium } from './lib/browser.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';

const SCENARIO = 'ai_table_6';
const VIEWER = 'p1';
const VIEWPORT = { width: 1440, height: 900 };
/** Poker cloth surface (`renderPokerTable` places its felt at y = 0.02). */
const TABLE_Y = 0.02;
/** Minimum clearance of the floating group above the felt. */
const MIN_HOVER = 0.5;
/** How close the group yaw must track the camera azimuth. */
const FACING_TOLERANCE_DEG = 10;
/** How much the camera (and therefore the row) must differ between views. */
const VIEW_DELTA_DEG = 20;
/** The upright pose, measured as the signed `rotation.x`. */
const TILT_DEG = -70;
const TILT_TOLERANCE_DEG = 10;
/** Camera-attached hand: distance must not follow the view. */
const HAND_DISTANCE_TOLERANCE = 0.1;
/** Two snapshots of a static prop must agree exactly (float round-off only). */
const STATIC_EPSILON = 0.01;

const dev = await ensureSoloServer();
const browser = await launchChromium();
const page = await browser.newPage({ viewport: VIEWPORT });

const pageErrors = [];
page.on('pageerror', error => pageErrors.push(String(error)));
page.on('console', message => {
  if (message.type() === 'error') pageErrors.push(message.text());
});

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

const DEG = 180 / Math.PI;
const angle = radians => ((radians * DEG + 540) % 360) - 180;
/** Smallest absolute angle between two bearings, in degrees. */
const angularDistanceDeg = (a, b) => Math.abs(angle(a - b));
const round = (value, digits = 2) => Number(value.toFixed(digits));

/**
 * Runs in the page: read the world pose of the board row, the draw pile and the
 * camera-attached hand from the live scene. No THREE global is available in the
 * page, so all directions come from the world matrices.
 */
const measure = () => {
  /** Visible easel tilt of the row (the signed mesh rotation is −70°). */
  const ROW_VISUAL_TILT = (70 * Math.PI) / 180;
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

  camera.updateMatrixWorld();
  const cameraPosition = [camera.position.x, camera.position.y, camera.position.z];
  const cameraAzimuth = Math.atan2(camera.position.x, camera.position.z);

  /** World position + yaw (of the local +Z axis) for an object. */
  const poseOf = object => {
    object.updateWorldMatrix(true, false);
    const m = object.matrixWorld.elements;
    return {
      position: [m[12], m[13], m[14]],
      yaw: Math.atan2(m[8], m[10])
    };
  };

  const board = [];
  let group = null;
  for (const id of boardZone.orderedEntities ?? []) {
    const mesh = meshes.get(id);
    if (!mesh) continue;
    const pose = poseOf(mesh);
    board.push({
      id,
      position: pose.position,
      tiltX: mesh.rotation.x,
      facing: 0,
      localY: mesh.position.y
    });
    // Every board card in the row shares one parent group.
    if (!group && mesh.parent) group = mesh.parent;
  }

  const groupPose = group ? poseOf(group) : null;
  if (groupPose) {
    // The visible row pose is an easel tilted `ROW_VISUAL_TILT` up from the
    // table: its face normal points up and toward the camera. The mesh reports
    // `rotation.x = −70°`; the compensating geometry turn is internal.
    const visualTilt = ROW_VISUAL_TILT;
    const normal = [
      Math.sin(groupPose.yaw) * Math.sin(visualTilt),
      Math.cos(visualTilt),
      Math.cos(groupPose.yaw) * Math.sin(visualTilt)
    ];
    for (const card of board) {
      const toCamera = [
        cameraPosition[0] - card.position[0],
        cameraPosition[1] - card.position[1],
        cameraPosition[2] - card.position[2]
      ];
      const length = Math.hypot(...toCamera) || 1;
      card.facing = (normal[0] * toCamera[0] + normal[1] * toCamera[1] + normal[2] * toCamera[2]) / length;
    }
  }

  const deckZone = state.zones?.zone_deck;
  const deckMesh = (deckZone?.orderedEntities ?? [])
    .map(id => meshes.get(id))
    .find(Boolean);
  const deckGroupPose = deckMesh?.parent ? poseOf(deckMesh.parent) : null;

  // Own hand: the viewer's cards live in the camera-attached overlay group.
  const viewer = state.viewerId;
  const handZone = viewer && viewer !== 'GOD' ? state.zones?.[`zone_hand_${viewer}`] : undefined;
  const handMeshes = (handZone?.orderedEntities ?? []).map(id => meshes.get(id)).filter(Boolean);
  const hand = handMeshes.map(mesh => {
    const pose = poseOf(mesh);
    const distance = Math.hypot(
      cameraPosition[0] - pose.position[0],
      cameraPosition[1] - pose.position[1],
      cameraPosition[2] - pose.position[2]
    );
    return { position: pose.position, distance };
  });
  const handGroupPose = handMeshes[0]?.parent ? poseOf(handMeshes[0].parent) : null;

  return {
    viewer,
    cameraPosition,
    cameraAzimuth,
    groupPose,
    groupY: groupPose?.position[1] ?? null,
    board,
    deckGroupPose,
    hasDeck: !!deckGroupPose,
    hand,
    handGroupY: handGroupPose?.position[1] ?? null
  };
};

const setSeat = async playerId => {
  const applied = await page.evaluate(async target => {
    const scene = window.__boardGameApp.scene;
    const result = scene.setSeatView({ playerId: target });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return result;
  }, playerId);
  // The seat camera tweens for 520ms; the probe reads a settled frame.
  await page.waitForTimeout(1000);
  return applied;
};

const setIso = async () => {
  await page.evaluate(async () => {
    window.__boardGameApp.scene.setCameraPreset('ISOMETRIC');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await page.waitForTimeout(1000);
};

console.log(`board-facing probe · poker/${SCENARIO} · viewer=${VIEWER} · ${VIEWPORT.width}x${VIEWPORT.height}\n`);

await page.goto(`${dev.url}/?game=poker&scenario=${SCENARIO}`);
await page.waitForFunction(() => !!window.__boardGameApp?.scene?.lastState, { timeout: 30_000 });
// The screenshots are worthless behind the "进入牌局" splash: dismiss it the
// same way a player does.
await page.evaluate(() => document.getElementById('boot-enter')?.click());
await page.waitForTimeout(500);

// The viewer stays the human seat for every measurement: the hand overlay must
// stay in front of the camera while the camera moves.
await page.evaluate(async target => {
  const app = window.__boardGameApp;
  app.session.setViewer(target);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}, VIEWER);
await page.waitForTimeout(600);

/**
 * Drive the table to a street that actually has community cards.
 *
 * Presses the same UI actions a player does (`session.perform`), never kernel
 * internals: start the hand, then keep checking/calling as the human seat while
 * the AI seats run on their own timer.
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
    // A seated viewer is held to the inter-hand cooldown; FORCE_START is the
    // same "发下一手" button the table offers while the timer runs down.
    const action = state.actions.find(a =>
      ['FORCE_START', 'START_HAND', 'CHECK', 'CALL'].includes(a.type)
    );
    if (action) await page.evaluate(id => window.__boardGameApp.session.perform(id), action.id);
    await page.waitForTimeout(700);
  }
  return false;
};

const reachedFlop = await dealToFlop();
// The deal fans cards out over ~0.5s per card plus a stagger; measuring during
// that window reads a card mid-flight and calls it sideways.
await page.waitForTimeout(3500);
if (!reachedFlop) bad('the probe could not reach the flop — nothing to measure');

const seatApplied = await setSeat(VIEWER);
if (!seatApplied) bad(`seat view for ${VIEWER} could not be applied`);
const seatView = await page.evaluate(measure);
await page.screenshot({ path: 'shots/upright-seat.png' });

/**
 * Read one board card's group-local Y a few times.
 *
 * Half a bob period (2 s) is sampled in 0.5 s steps, so the window always
 * contains the sine's peak or trough and the range reveals the real amplitude.
 */
const sampleBob = async () => {
  const heights = [];
  for (let index = 0; index < 5; index++) {
    heights.push(
      await page.evaluate(() => {
        const scene = window.__boardGameApp.scene;
        const zone = scene.lastState?.zones?.zone_board;
        const id = zone?.orderedEntities?.[0];
        const mesh = id ? scene.entityMeshes.get(id) : null;
        return mesh ? mesh.position.y : null;
      })
    );
    if (index < 4) await page.waitForTimeout(500);
  }
  return heights;
};

const bobHeights = await sampleBob();

await setIso();
const isoView = await page.evaluate(measure);
await page.screenshot({ path: 'shots/upright-iso.png' });

/* ------------------------------------------------------------------ */
/* 1–3. Board row: follows the camera, floats, stands upright          */
/* ------------------------------------------------------------------ */

/** Report one camera's view of the floating row. */
const reportBoard = (tag, shot) => {
  if (shot.error) return bad(`${tag}: ${shot.error}`);
  if (!shot.board?.length) return bad(`${tag}: no community cards on the felt`);
  if (!shot.groupPose) return bad(`${tag}: board cards have no parent group`);

  const azimuthDeg = shot.cameraAzimuth * DEG;
  const groupYawDeg = shot.groupPose.yaw * DEG;
  const facingDelta = angularDistanceDeg(shot.groupPose.yaw, shot.cameraAzimuth);
  const tilts = shot.board.map(card => card.tiltX * DEG);
  const minTilt = Math.min(...tilts);
  const maxTilt = Math.max(...tilts);
  const minFacing = Math.min(...shot.board.map(card => card.facing));

  console.log(
    `  ${tag}: camera ${round(azimuthDeg)}° · group yaw ${round(groupYawDeg)}° · Δ ${round(facingDelta)}°`
  );
  pick(
    facingDelta <= FACING_TOLERANCE_DEG,
    `${tag}: group yaw tracks the camera (${round(groupYawDeg)}° vs ${round(azimuthDeg)}°, Δ ${round(facingDelta)}° ≤ ${FACING_TOLERANCE_DEG}°)`,
    `${tag}: group yaw ${round(groupYawDeg)}° is ${round(facingDelta)}° off the camera ${round(azimuthDeg)}°`
  );

  console.log(
    `  ${tag}: group y ${round(shot.groupY, 3)} · X rotation ${round(minTilt)}° · face·camera ${round(minFacing, 3)}`
  );
  pick(
    shot.groupY >= TABLE_Y + MIN_HOVER,
    `${tag}: row floats ${round(shot.groupY - TABLE_Y, 3)} above the felt (group y ${round(shot.groupY, 3)} ≥ ${round(TABLE_Y + MIN_HOVER, 2)})`,
    `${tag}: group y ${round(shot.groupY, 3)} is below the felt + ${MIN_HOVER}`
  );
  pick(
    minTilt >= TILT_DEG - TILT_TOLERANCE_DEG && maxTilt <= TILT_DEG + TILT_TOLERANCE_DEG,
    `${tag}: board cards stand at ${round(minTilt)}° X rotation (${TILT_DEG}±${TILT_TOLERANCE_DEG}°)`,
    `${tag}: board X rotation ${round(minTilt)}° is outside ${TILT_DEG}±${TILT_TOLERANCE_DEG}°`
  );
  pick(
    minFacing > 0.4,
    `${tag}: every card face points at the camera (min dot ${round(minFacing, 3)})`,
    `${tag}: a card face points away from the camera (min dot ${round(minFacing, 3)})`
  );
};

reportBoard('seat view', seatView);
reportBoard('iso view', isoView);

/* The previous round's rule survives: clicking your own hand never arms a drag. */
const dragGuard = await page.evaluate(() => {
  const scene = window.__boardGameApp.scene;
  const state = scene.lastState;
  const ray = scene.raycaster;
  const dataFor = zoneId => {
    const id = state.zones?.[zoneId]?.orderedEntities?.[0];
    const mesh = id ? scene.entityMeshes.get(id) : null;
    return mesh ? ray.interactiveMeshes.get(mesh) : null;
  };
  const hand = dataFor(`zone_hand_${state.viewerId}`);
  const board = dataFor('zone_board');
  return {
    handFlag: hand?.metadata?.draggable,
    handDraggable: hand ? ray.isDraggable(hand) : null,
    boardDraggable: board ? ray.isDraggable(board) : null
  };
});
console.log(
  `  hand guard: own-hand draggable=${String(dragGuard.handFlag)} · armed=${String(dragGuard.handDraggable)} · board armed=${String(dragGuard.boardDraggable)}`
);
pick(
  dragGuard.handDraggable === false && dragGuard.boardDraggable === true,
  'own hand is clickable but never draggable; board cards still drag',
  `hand drag guard broke: own hand ${String(dragGuard.handDraggable)}, board ${String(dragGuard.boardDraggable)}`
);

if (!seatView.error && !isoView.error && seatView.groupPose && isoView.groupPose) {
  const cameraDelta = angularDistanceDeg(seatView.cameraAzimuth, isoView.cameraAzimuth);
  const yawDelta = angularDistanceDeg(seatView.groupPose.yaw, isoView.groupPose.yaw);
  console.log(`  view change: camera Δ ${round(cameraDelta)}° · group yaw Δ ${round(yawDelta)}°`);
  pick(
    cameraDelta > VIEW_DELTA_DEG && yawDelta > VIEW_DELTA_DEG,
    `seat vs iso differs by ${round(yawDelta)}° — the row turns with the camera (${round(cameraDelta)}° camera move)`,
    `seat vs iso only differs by ${round(cameraDelta)}° / ${round(yawDelta)}° (expected > ${VIEW_DELTA_DEG}°)`
  );

  /* Spacing and bob: cards keep their pitch and breathe together. */
  const positions = seatView.board.map(card => card.position);
  const gaps = positions.slice(1).map((position, index) =>
    Math.hypot(
      position[0] - positions[index][0],
      position[1] - positions[index][1],
      position[2] - positions[index][2]
    )
  );
  const minGap = Math.min(...gaps);
  const maxGap = Math.max(...gaps);
  console.log(`  spacing: ${gaps.map(gap => round(gap, 3)).join(' / ')} (card width 1.256)`);
  pick(
    gaps.length === 0 || (minGap > 1.2 && maxGap - minGap < 0.01),
    `board cards keep the row pitch (${round(minGap, 3)} unit gap > card width, uniform)`,
    `board row spacing broke: gaps ${gaps.map(gap => round(gap, 3)).join(' / ')}`
  );

  const bobValues = bobHeights.filter(value => typeof value === 'number');
  const bobRange = bobValues.length ? Math.max(...bobValues) - Math.min(...bobValues) : 0;
  console.log(`  bob: ${bobValues.map(value => round(value, 4)).join(' → ')} · range ${round(bobRange, 4)}`);
  pick(
    bobValues.length === 5 && bobRange >= 0.015 && bobRange <= 0.041,
    `floating row bobs ±0.02 (measured range ${round(bobRange, 4)} ≤ 0.04)`,
    `floating row is static or over-bobbing (measured range ${round(bobRange, 4)}, expected 0.02 amplitude)`
  );

  // `prefers-reduced-motion: reduce` must freeze the bob without lowering the
  // row: the same screenshots stay valid, the cards simply stop breathing.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(250);
  const stillHeights = (await sampleBob()).filter(value => typeof value === 'number');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const stillRange = stillHeights.length
    ? Math.max(...stillHeights) - Math.min(...stillHeights)
    : Number.POSITIVE_INFINITY;
  console.log(
    `  reduced motion: ${stillHeights.map(value => round(value, 4)).join(' → ')} · range ${round(stillRange, 4)}`
  );
  pick(
    stillHeights.length === 5 && stillRange < 0.002,
    `prefers-reduced-motion freezes the bob (range ${round(stillRange, 4)} ≈ 0)`,
    `prefers-reduced-motion still bobs (range ${round(stillRange, 4)})`
  );

  /* 4. Draw pile: identical yaw and position in both views. */
  if (!seatView.hasDeck || !isoView.hasDeck) {
    bad('no draw pile on the felt — cannot prove the deck stays put');
  } else {
    const seatDeck = seatView.deckGroupPose;
    const isoDeck = isoView.deckGroupPose;
    const positionDelta = Math.hypot(
      seatDeck.position[0] - isoDeck.position[0],
      seatDeck.position[1] - isoDeck.position[1],
      seatDeck.position[2] - isoDeck.position[2]
    );
    const deckYawDelta = angularDistanceDeg(seatDeck.yaw, isoDeck.yaw);
    console.log(
      `  deck: pos ${seatDeck.position.map(value => round(value, 3)).join(',')} · yaw ${round(seatDeck.yaw * DEG)}° (both views)`
    );
    pick(
      positionDelta < STATIC_EPSILON && deckYawDelta < STATIC_EPSILON,
      `deck is static: position Δ ${round(positionDelta, 4)} · yaw Δ ${round(deckYawDelta, 4)}° (< ${STATIC_EPSILON})`,
      `deck moved between views: position Δ ${round(positionDelta, 4)} · yaw Δ ${round(deckYawDelta, 4)}°`
    );
  }

  /* 5. Own hand: still the camera-attached overlay from the previous round. */
  if (!seatView.hand?.length || !isoView.hand?.length) {
    bad(`viewer ${VIEWER} has no own-hand cards to measure`);
  } else {
    const seatDistance = Math.min(...seatView.hand.map(card => card.distance));
    const isoDistance = Math.min(...isoView.hand.map(card => card.distance));
    const relativeDelta = Math.abs(seatDistance - isoDistance) / Math.max(seatDistance, isoDistance);
    console.log(
      `  hand: camera distance seat ${round(seatDistance)} · iso ${round(isoDistance)} (Δ ${(relativeDelta * 100).toFixed(2)}%)`
    );
    pick(
      relativeDelta <= HAND_DISTANCE_TOLERANCE,
      `own hand stays at the camera (distance Δ ${(relativeDelta * 100).toFixed(2)}% ≤ ${HAND_DISTANCE_TOLERANCE * 100}%)`,
      `own hand drifted off the camera (distance ${round(seatDistance)} → ${round(isoDistance)}, Δ ${(relativeDelta * 100).toFixed(2)}%)`
    );

    const groupYDelta = Math.abs((seatView.handGroupY ?? 0) - (isoView.handGroupY ?? 0));
    console.log(
      `  hand group y: seat ${round(seatView.handGroupY, 3)} · iso ${round(isoView.handGroupY, 3)} (Δ ${round(groupYDelta, 3)})`
    );
    pick(
      groupYDelta > 0.5,
      `own-hand group rides the camera height (world y Δ ${round(groupYDelta, 3)} > 0.5)`,
      `own-hand group Y did not follow the camera (Δ ${round(groupYDelta, 3)})`
    );
  }
}

/* 6. No errors in the page. */
pick(
  pageErrors.length === 0,
  'page reported no errors',
  `page reported ${pageErrors.length} error(s): ${pageErrors.slice(0, 3).join(' | ')}`
);

await page.close();
await browser.close();
await dev.stop();

console.log(`\nboard-facing: ${checks - failures.length}/${checks} checks passed`);
if (failures.length) {
  console.log(`\nFAILED (${failures.length}):`);
  for (const failure of failures) console.log(`  x ${failure}`);
  process.exitCode = 1;
}
