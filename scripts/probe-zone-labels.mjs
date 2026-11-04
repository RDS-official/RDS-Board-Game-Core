/**
 * Table-label regression probe.
 *
 * Measures the three poker zone labels (牌堆 / 烧牌 / 弃牌) and the POT readout
 * at 1440x900, 1024x768 and 390x844. The viewer is seated as p1 and the hand is
 * driven to the FLOP so the community-card row is present.
 *
 * Asserts:
 *   - the three zone labels and the POT label have zero pairwise overlap;
 *   - the POT label does not intersect the projected community-card row;
 *   - every label is at least 16 CSS pixels tall;
 *   - the POT label stays inside the viewport.
 *
 * Run: node scripts/probe-zone-labels.mjs
 */
import { launchChromium } from './lib/browser.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';

const SCENARIO = 'ai_table_6';
const VIEWER = 'p1';
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 }
];
const MIN_LABEL_HEIGHT = 16;

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
const round = (value, digits = 1) => Number(value.toFixed(digits));

function intersectionArea(a, b) {
  const width = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const height = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  return width * height;
}

const dealToFlop = async page => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const snapshot = window.__boardGameApp.session.getSnapshot();
      return {
        cards: snapshot.board.zones?.zone_board?.orderedEntities?.length ?? 0,
        actions: (snapshot.actions ?? []).map(action => ({
          id: action.id,
          type: action.actionType
        }))
      };
    });
    if (state.cards >= 3) return true;
    const action = state.actions.find(entry =>
      ['FORCE_START', 'START_HAND', 'CHECK', 'CALL'].includes(entry.type)
    );
    if (action) {
      await page.evaluate(id => window.__boardGameApp.session.perform(id), action.id);
    }
    await page.waitForTimeout(700);
  }
  return false;
};

/** Runs in the page: collect label rectangles and the community-card union. */
const measure = () => {
  const scene = window.__boardGameApp?.scene;
  const camera = scene?.camera;
  const state = scene?.lastState;
  if (!scene || !camera || !state) return { error: 'scene not ready' };

  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.updateMatrixWorld();
  const Vector = camera.position.constructor;
  const right = new Vector().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new Vector().setFromMatrixColumn(camera.matrixWorld, 1);
  const center = new Vector();
  const corner = new Vector();
  const worldScale = new Vector();

  const project = point => {
    point.project(camera);
    return {
      x: (point.x * 0.5 + 0.5) * width,
      y: (-point.y * 0.5 + 0.5) * height
    };
  };
  const rectOf = points => {
    const xs = points.map(point => point.x);
    const ys = points.map(point => point.y);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    const x1 = Math.max(...xs);
    const y1 = Math.max(...ys);
    return {
      x0: +x0.toFixed(1),
      y0: +y0.toFixed(1),
      x1: +x1.toFixed(1),
      y1: +y1.toFixed(1),
      width: +(x1 - x0).toFixed(1),
      height: +(y1 - y0).toFixed(1)
    };
  };

  scene.boardObjectsGroup.updateWorldMatrix(true, true);
  const labels = [];
  scene.boardObjectsGroup.traverse(object => {
    if (!object.isSprite || !object.userData.labelRole) return;
    object.getWorldPosition(center);
    object.getWorldScale(worldScale);
    const points = [];
    for (const sx of [-0.5, 0.5]) {
      for (const sy of [-0.5, 0.5]) {
        corner
          .copy(center)
          .addScaledVector(right, sx * worldScale.x)
          .addScaledVector(up, sy * worldScale.y);
        points.push(project(corner.clone()));
      }
    }
    const rect = rectOf(points);
    const designFont = Number(object.userData.labelFontSize ?? 0);
    const fontScale = Number(object.userData.fontScale ?? 1);
    // createLabelSprite maps the canvas font into 256 CSS design units.
    const canvasFont = Math.min(designFont * 3.2, 150);
    labels.push({
      role: object.userData.labelRole,
      zoneId: object.userData.zoneId ?? null,
      text: object.userData.labelText ?? '',
      fontScale,
      designFont: +(designFont * fontScale).toFixed(1),
      screenFont: +(rect.height * (canvasFont / 256)).toFixed(1),
      rect
    });
  });

  const boardPoints = [];
  for (const id of state.zones?.zone_board?.orderedEntities ?? []) {
    const mesh = scene.entityMeshes.get(id);
    if (!mesh) continue;
    mesh.updateWorldMatrix(true, false);
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox;
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          boardPoints.push(project(new Vector(x, y, z).applyMatrix4(mesh.matrixWorld)));
        }
      }
    }
  }

  const zoneOrder = ['zone_deck', 'zone_burn', 'zone_muck'];
  labels.sort((a, b) => {
    const indexOf = label =>
      label.role === 'pot' ? 99 : zoneOrder.indexOf(label.zoneId ?? '');
    return indexOf(a) - indexOf(b);
  });

  return {
    labels,
    board: boardPoints.length ? rectOf(boardPoints) : null
  };
};

for (const viewport of VIEWPORTS) {
  const page = await browser.newPage({ viewport });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  page.on('console', message => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });

  console.log(`\nlabels · poker/${SCENARIO} · viewer=${VIEWER} · ${viewport.width}x${viewport.height}`);

  await page.goto(`${dev.url}/?game=poker&scenario=${SCENARIO}`);
  await page.waitForFunction(() => !!window.__boardGameApp?.scene?.lastState, { timeout: 30_000 });
  await page.evaluate(() => document.getElementById('boot-enter')?.click());
  await page.waitForTimeout(500);
  await page.evaluate(async target => {
    window.__boardGameApp.session.setViewer(target);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, VIEWER);
  await page.waitForTimeout(600);

  const reachedFlop = await dealToFlop(page);
  await page.waitForTimeout(3200);
  if (!reachedFlop) bad(`${viewport.width}: could not reach the FLOP`);

  await page.evaluate(async viewer => {
    window.__boardGameApp.scene.setSeatView({ playerId: viewer });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, VIEWER);
  await page.waitForTimeout(1000);

  const data = await page.evaluate(measure);
  if (data.error) {
    bad(`${viewport.width}: ${data.error}`);
    await page.close();
    continue;
  }

  const zones = data.labels.filter(label => label.role === 'zone');
  const pot = data.labels.find(label => label.role === 'pot');
  pick(
    zones.length === 3 && !!pot,
    `${viewport.width}: found ${zones.length} zone labels and the POT label`,
    `${viewport.width}: expected 3 zone labels + POT, found ${zones.length} + ${pot ? 1 : 0}`
  );
  if (!pot) {
    await page.close();
    continue;
  }

  for (const label of data.labels) {
    console.log(
      `  ${label.role.padEnd(4)} ${String(label.zoneId ?? '').padEnd(10)} "${label.text}" ` +
        `rect=(${label.rect.x0},${label.rect.y0})-(${label.rect.x1},${label.rect.y1}) ` +
        `${label.rect.width}x${label.rect.height}px font=${label.screenFont}px (${label.designFont} design)`
    );
  }
  console.log(
    `  board row rect=(${data.board.x0},${data.board.y0})-(${data.board.x1},${data.board.y1}) ` +
      `${data.board.width}x${data.board.height}px`
  );

  let minPairArea = Number.POSITIVE_INFINITY;
  for (let i = 0; i < data.labels.length; i++) {
    for (let j = i + 1; j < data.labels.length; j++) {
      const area = intersectionArea(data.labels[i].rect, data.labels[j].rect);
      minPairArea = Math.min(minPairArea, area);
      if (area > 0) {
        bad(
          `${viewport.width}: ${data.labels[i].text} overlaps ${data.labels[j].text} by ${round(area, 2)}px²`
        );
      }
    }
  }
  pick(
    minPairArea === 0,
    `${viewport.width}: all label pairs have zero intersection area`,
    `${viewport.width}: label pair intersection area ${round(minPairArea, 2)}px²`
  );

  const potOverlap = intersectionArea(pot.rect, data.board);
  pick(
    potOverlap === 0,
    `${viewport.width}: POT label does not intersect the community-card row (gap ${round(pot.rect.y0 - data.board.y1, 1)}px)`,
    `${viewport.width}: POT intersects the community-card row by ${round(potOverlap, 2)}px²`
  );

  const minHeight = Math.min(...data.labels.map(label => label.rect.height));
  pick(
    minHeight >= MIN_LABEL_HEIGHT,
    `${viewport.width}: smallest label is ${round(minHeight, 1)}px tall (>= ${MIN_LABEL_HEIGHT}px)`,
    `${viewport.width}: smallest label is only ${round(minHeight, 1)}px tall (< ${MIN_LABEL_HEIGHT}px)`
  );

  pick(
    data.labels.every(label => Math.abs(label.fontScale - 0.6) < 0.001),
    `${viewport.width}: all four labels use the 0.6x label scale`,
    `${viewport.width}: a label does not use the 0.6x label scale`
  );

  const potInViewport =
    pot.rect.x0 >= 0 &&
    pot.rect.y0 >= 0 &&
    pot.rect.x1 <= viewport.width &&
    pot.rect.y1 <= viewport.height;
  pick(
    potInViewport,
    `${viewport.width}: POT label stays inside the viewport`,
    `${viewport.width}: POT label is clipped by the viewport (${JSON.stringify(pot.rect)})`
  );

  pick(
    pageErrors.length === 0,
    `${viewport.width}: page reported no errors`,
    `${viewport.width}: page errors: ${pageErrors.slice(0, 2).join(' | ')}`
  );

  await page.screenshot({ path: `shots/labels-${viewport.width}.png` });
  await page.close();
}

await browser.close();
await dev.stop();

console.log(`\nzone labels: ${checks - failures.length}/${checks} checks passed`);
if (failures.length) {
  console.log(`\nFAILED (${failures.length}):`);
  for (const failure of failures) console.log(`  x ${failure}`);
  process.exitCode = 1;
}
