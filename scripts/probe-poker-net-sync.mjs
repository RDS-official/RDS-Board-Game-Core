/**
 * Dual-browser poker sync probe.
 *
 * Boots two REAL Playwright pages against a running hub on :8787 (the Vite
 * client on :3000 is used so `window.__boardGameApp` is exposed in dev mode).
 * A is the room host, B is the guest. Both join the same heads-up table.
 *
 * After each of A's first three table actions the probe samples, from B:
 *   - the world position / yaw of a NON-B seat standee (p1);
 *   - p1's hand-card meshes and count;
 *   - the session revision and the board seq the 3D scene last applied.
 * The same sample is taken from A so the two projections can be compared.
 *
 * Run (hub must already be listening):
 *   node node_modules/tsx/dist/cli.mjs apps/server/src/index.ts
 *   node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 3000
 *   node scripts/probe-poker-net-sync.mjs
 */
import { launchChromium } from './lib/browser.mjs';

const HUB = process.env.HUB ?? 'http://127.0.0.1:8787';
const WEB = process.env.WEB ?? 'http://127.0.0.1:3000';
const NON_B_SEAT = 'p1';

const api = async (pathname, init = {}) => {
  const response = await fetch(HUB + pathname, init);
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
};

const jsonHeaders = token => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json'
});

async function createAccount(adminToken, name) {
  const password = 'pass12345';
  const created = await api('/api/admin/users', {
    method: 'POST',
    headers: jsonHeaders(adminToken),
    body: JSON.stringify({ name, password, displayName: name })
  });
  if (!created.body.user?.id) throw new Error(`create ${name}: ${created.body.error ?? created.status}`);
  const login = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password })
  });
  if (!login.body.token) throw new Error(`login ${name}: ${login.body.error ?? login.status}`);
  return { id: created.body.user.id, name, token: login.body.token };
}

async function setupRoom() {
  const admin = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'rds', password: 'kgnb666' })
  });
  if (!admin.body.token) throw new Error(`admin login failed (${admin.status})`);

  const tag = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const a = await createAccount(admin.body.token, `sync_a_${tag}`);
  const b = await createAccount(admin.body.token, `sync_b_${tag}`);

  const room = await api('/api/rooms', {
    method: 'POST',
    headers: jsonHeaders(a.token),
    body: JSON.stringify({ name: '双端同步探针', gameId: 'poker', scenarioId: 'seats_2', maxPlayers: 2 })
  });
  if (!room.body.id) throw new Error(`create room: ${room.body.error ?? room.status}`);
  const roomId = room.body.id;

  await api(`/api/rooms/${roomId}/join`, {
    method: 'POST',
    headers: jsonHeaders(b.token),
    body: '{}'
  });
  await api(`/api/rooms/${roomId}/status`, {
    method: 'POST',
    headers: jsonHeaders(a.token),
    body: JSON.stringify({ status: 'playing' })
  });

  const info = await api(`/api/rooms/${roomId}`, { headers: { Authorization: `Bearer ${a.token}` } });
  const players = info.body.players ?? [];
  if (players.length !== 2) throw new Error(`expected 2 players, got ${players.length}`);
  return { a, b, roomId };
}

function tableUrl(roomId, token, role, seat) {
  const query = new URLSearchParams({
    game: 'poker',
    hub: `${HUB.replace(/^http/, 'ws')}/ws`,
    roomId,
    token,
    role,
    authority: 'server',
    playerId: seat
  });
  return `${WEB}/?${query}`;
}

async function waitForApp(page) {
  await page.waitForFunction(() => !!window.__boardGameApp?.session?.getSnapshot?.(), { timeout: 30000 });
  await page.waitForFunction(
    () => {
      const snap = window.__boardGameApp.session.getSnapshot();
      return snap && snap.actions !== undefined;
    },
    { timeout: 30000 }
  );
}

const SAMPLE = ({ seat }) => {
  const app = window.__boardGameApp;
  const session = app.session;
  const snapshot = session.getSnapshot();
  const scene = app.scene;
  const hand = snapshot.board?.globalVars?.hand ?? {};
  const standee = scene.seatStandees?.find(entry => entry.seatId === seat);

  let standeeWorld = null;
  if (standee?.group) {
    standee.group.updateWorldMatrix(true, false);
    const e = standee.group.matrixWorld.elements;
    standeeWorld = { x: e[12], y: e[13], z: e[14] };
  }

  const zoneId = `zone_hand_${seat}`;
  const zone = snapshot.board?.zones?.[zoneId];
  const cardIds = zone?.orderedEntities ?? [];
  const cards = cardIds.map(id => {
    const mesh = scene.entityMeshes?.get(id);
    if (!mesh) return { id, found: false };
    mesh.updateWorldMatrix(true, false);
    const e = mesh.matrixWorld.elements;
    return { id, found: true, uuid: mesh.uuid, x: e[12], y: e[13], z: e[14] };
  });
  const sceneHandIds = [...(scene.handRows?.get(zoneId)?.ids ?? [])];

  return {
    viewer: snapshot.viewer,
    sessionRevision: snapshot.revision,
    appliedRevision: session.netRevision ?? null,
    sceneBoardSeq: scene.lastState?.seq ?? null,
    boardSeq: snapshot.board?.seq ?? null,
    actionLogLength: snapshot.board?.actionLog?.length ?? null,
    syncKey: scene.lastBoardKey ?? null,
    street: hand.street ?? null,
    activePlayerId: snapshot.board?.activePlayerId ?? null,
    lastAction: hand.lastActions?.[seat] ?? null,
    folded: !!hand.folded?.includes(seat),
    chips: Number(snapshot.board?.players?.[seat]?.customProps?.chips ?? 0),
    handCount: cardIds.length,
    sceneHandIds,
    sceneHandMatches:
      sceneHandIds.length === cardIds.length && sceneHandIds.every(id => cardIds.includes(id)),
    standeeIds: (scene.seatStandees ?? []).map(entry => entry.seatId),
    playerOrder: snapshot.board?.playerOrder ?? [],
    seatNodeCount: Object.values(snapshot.board?.mapGraph?.nodes ?? {}).filter(node => node.type === 'SEAT').length,
    cards,
    standeeWorld,
    standeeYaw: standee?.group?.rotation?.y ?? null,
    standeeUuid: standee?.group?.uuid ?? null,
    actions: (snapshot.actions ?? []).map(action => ({
      id: action.id,
      type: action.actionType,
      label: action.label,
      fields: action.fields ?? [],
      hasSelection: !!action.selection
    }))
  };
};

const sample = (page, seat) => page.evaluate(SAMPLE, { seat });

async function perform(page, index = 0) {
  return page.evaluate(i => {
    const session = window.__boardGameApp.session;
    const action = session.getSnapshot().actions?.[i];
    if (!action) return { ok: false, error: 'no action', action: null };
    const payload = {};
    for (const field of action.fields ?? []) {
      if (field.default !== undefined) payload[field.key] = field.default;
    }
    const result = session.perform(action.id, payload);
    return {
      ok: result.ok,
      error: result.error,
      action: { id: action.id, type: action.actionType, label: action.label, payload }
    };
  }, index);
}

async function waitForSettled(page, previousRevision) {
  await page.waitForFunction(
    revision => {
      const session = window.__boardGameApp.session;
      const snap = session.getSnapshot();
      return !!snap && snap.revision > revision;
    },
    previousRevision,
    { timeout: 15000 }
  );
  // Two frames after the projection has been applied, so the scene has rebuilt.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

const fmt3 = value => (value === null || value === undefined ? '—' : Number(value).toFixed(3));

async function main() {
  const health = await fetch(`${HUB}/healthz`).catch(() => null);
  if (!health?.ok) throw new Error(`hub is not running at ${HUB}`);
  const room = await setupRoom();
  const browser = await launchChromium();
  const contextA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const contextB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await contextA.addInitScript(token => localStorage.setItem('token', token), room.a.token);
  await contextB.addInitScript(token => localStorage.setItem('token', token), room.b.token);
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const errors = [];
  const bWsRevisions = [];
  pageB.on('websocket', socket => {
    socket.on('framereceived', event => {
      const text = typeof event.payload === 'string' ? event.payload : '';
      if (!text.includes('"t":"room-update"')) return;
      try {
        const message = JSON.parse(text);
        bWsRevisions.push({
          revision: message.update?.revision,
          baseRevision: message.update?.baseRevision,
          full: !!message.update?.full,
          patches: message.update?.patches?.length ?? 0
        });
      } catch {
        /* non-JSON signalling frames are irrelevant */
      }
    });
  });
  for (const [label, page] of [['A', pageA], ['B', pageB]]) {
    page.on('pageerror', error => errors.push(`${label} pageerror: ${error.message}`));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(`${label} console: ${message.text()}`);
    });
  }

  await pageA.goto(tableUrl(room.roomId, room.a.token, 'host', 'p1'), { waitUntil: 'domcontentloaded' });
  await pageB.goto(tableUrl(room.roomId, room.b.token, 'guest', 'p2'), { waitUntil: 'domcontentloaded' });
  await Promise.all([waitForApp(pageA), waitForApp(pageB)]);
  // The server sends match-seat, then the first full projection.
  await pageA.waitForTimeout(1200);
  await pageB.waitForTimeout(1200);

  // A fresh room normally auto-deals when both players attach. If the table is
  // still waiting, press the same FORCE_START button a user would.
  const loaded = await sample(pageA, NON_B_SEAT);
  if (loaded.street === 'COMPLETE') {
    const startRevision = loaded.sessionRevision;
    const startResult = await perform(pageA, 0);
    if (!startResult.ok) throw new Error(`start hand failed: ${startResult.error}`);
    await waitForSettled(pageA, startRevision);
    await waitForSettled(pageB, startRevision);
  }

  // Pin both cameras to the same preset so a standee's camera-facing yaw is
  // directly comparable between the two browsers.
  await pageA.evaluate(() => window.__boardGameApp.scene.setCameraPreset('TOP_DOWN'));
  await pageB.evaluate(() => window.__boardGameApp.scene.setCameraPreset('TOP_DOWN'));
  await pageA.waitForTimeout(700);
  await pageB.waitForTimeout(700);

  const rows = [];
  const record = async label => {
    const [a, b] = await Promise.all([sample(pageA, NON_B_SEAT), sample(pageB, NON_B_SEAT)]);
    rows.push({ label, a, b });
    console.log(
      `ROW ${label} | B rev ${b.sessionRevision}/${b.sceneBoardSeq} log ${b.actionLogLength} | p1 pos ${fmt3(
        b.standeeWorld?.x
      )},${fmt3(b.standeeWorld?.z)} yaw ${fmt3(b.standeeYaw)} seat ${b.standeeUuid?.slice(0, 8)} | hand ${b.handCount} scene ${
        b.sceneHandIds.length
      } | A rev ${a.sessionRevision}/${a.sceneBoardSeq} log ${a.actionLogLength} | A hand ${a.handCount}${b.sceneHandMatches ? '' : ' | SCENE-HAND-MISMATCH'}`
    );
    return { a, b };
  };

  await record('server-loaded');
  const loadedA = await sample(pageA, NON_B_SEAT);
  const loadedB = await sample(pageB, NON_B_SEAT);
  console.log(
    `LOADED seats A ${loadedA.standeeIds.join(',')} / players ${loadedA.playerOrder.join(',')} / nodes ${
      loadedA.seatNodeCount
    } | B ${loadedB.standeeIds.join(',')} / players ${loadedB.playerOrder.join(',')} / nodes ${loadedB.seatNodeCount}`
  );

  let aActions = 0;
  let rounds = 0;
  while (aActions < 3 && rounds < 12) {
    rounds++;
    const [snapA, snapB] = await Promise.all([sample(pageA, NON_B_SEAT), sample(pageB, NON_B_SEAT)]);
    const actorPage = snapA.actions.length > 0 ? pageA : snapB.actions.length > 0 ? pageB : null;
    const actorSnap = actorPage === pageA ? snapA : snapB;
    if (!actorPage) {
      await pageA.waitForTimeout(1200);
      continue;
    }
    const isA = actorPage === pageA;
    // A's three actions should exercise the table: bet/raise, then call/check,
    // then fold if it becomes available; B answers passively in between.
    let chosen = 0;
    if (isA) {
      // First two actions: a real bet/raise. Third: fold when B has bet into A,
      // otherwise the first safe action (that also makes the hand-count change
      // visible if it happens to be the end of the hand).
      const preferred =
        aActions === 2 ? ['FOLD', 'CHECK', 'CALL', 'RAISE', 'BET'] : ['RAISE', 'BET', 'CALL', 'CHECK'];
      const found = preferred.find(type => actorSnap.actions.some(action => action.type === type));
      if (found) chosen = actorSnap.actions.findIndex(action => action.type === found);
    } else if (aActions >= 2) {
      // Let B put a bet in front of A so A's third action can be a fold.
      const aggressive = ['RAISE', 'BET', 'CALL', 'CHECK'];
      const found = aggressive.find(type => actorSnap.actions.some(action => action.type === type));
      if (found) chosen = actorSnap.actions.findIndex(action => action.type === found);
    } else {
      const passive = ['CHECK', 'CALL'];
      const found = passive.find(type => actorSnap.actions.some(action => action.type === type));
      if (found) chosen = actorSnap.actions.findIndex(action => action.type === found);
    }
    const [beforeA, beforeB] = await Promise.all([
      sample(pageA, NON_B_SEAT),
      sample(pageB, NON_B_SEAT)
    ]);
    console.log(
      `MOVE ${isA ? 'A' : 'B'} ${actorSnap.actions[chosen]?.type} | active ${snapA.activePlayerId}/${snapB.activePlayerId} | revisions ${beforeA.sessionRevision}/${beforeB.sessionRevision}`
    );
    const actionResult = await perform(actorPage, chosen);
    if (!actionResult.ok) {
      throw new Error(`${isA ? 'A' : 'B'} action failed: ${actionResult.error}`);
    }
    await waitForSettled(pageA, beforeA.sessionRevision).catch(async error => {
      const after = await sample(pageA, NON_B_SEAT);
      throw new Error(`A did not settle after ${actionResult.action.type}: ${error.message}; ${JSON.stringify(after)}`);
    });
    await waitForSettled(pageB, beforeB.sessionRevision).catch(async error => {
      const after = await sample(pageB, NON_B_SEAT);
      throw new Error(`B did not settle after ${actionResult.action.type}: ${error.message}; ${JSON.stringify(after)}`);
    });
    if (isA) {
      aActions++;
      await record(`A${aActions}:${actionResult.action.type}`);
    } else {
      await record(`B:${actionResult.action.type}`);
    }
  }

  console.log('\nCOMPARISON');
  console.log(
    'step | B p1 standee | B p1 pos (x,z) | B p1 yaw | B p1 cards (x,z) | B hand/scene | B rev (session/scene) | A p1 pos (x,z) | A p1 yaw | A hand | A rev (session/scene) | equal'
  );
  for (const row of rows) {
    const equal =
      row.a.standeeWorld?.x === row.b.standeeWorld?.x &&
      row.a.standeeWorld?.z === row.b.standeeWorld?.z &&
      Math.abs((row.a.standeeYaw ?? 0) - (row.b.standeeYaw ?? 0)) < 1e-9 &&
      row.a.handCount === row.b.handCount;
    const cardPose = row.b.cards.length
      ? row.b.cards.map(card => `${fmt3(card.x)},${fmt3(card.z)}`).join(' | ')
      : '—';
    console.log(
      `${row.label} | ${row.b.standeeUuid?.slice(0, 8)} | ${fmt3(row.b.standeeWorld?.x)},${fmt3(
        row.b.standeeWorld?.z
      )} | ${fmt3(row.b.standeeYaw)} | ${cardPose} | ${row.b.handCount}/${row.b.sceneHandIds.length}${
        row.b.sceneHandMatches ? '' : '!'
      } | ${row.b.sessionRevision}/${row.b.sceneBoardSeq} | ${fmt3(row.a.standeeWorld?.x)},${fmt3(
        row.a.standeeWorld?.z
      )} | ${fmt3(row.a.standeeYaw)} | ${row.a.handCount} | ${row.a.sessionRevision}/${
        row.a.sceneBoardSeq
      } | ${equal ? 'yes' : 'NO'}`
    );
  }

  const sceneStale = rows.some(row => row.b.sceneBoardSeq !== row.b.boardSeq);
  const handStale = rows.some(row => !row.b.sceneHandMatches);
  const uuidStableAcrossActions = rows.some(
    (row, index) =>
      index > 0 &&
      row.b.sessionRevision > rows[index - 1].b.sessionRevision &&
      row.b.standeeUuid === rows[index - 1].b.standeeUuid
  );
  console.log(
    `\nB ws updates: ${bWsRevisions
      .map(update => `${update.revision}${update.full ? 'F' : `D${update.patches}`}`)
      .join(' → ')}`
  );
  const failed =
    rows.length < 4 || sceneStale || handStale || uuidStableAcrossActions || rows.some(row => !row.b.actions);
  console.log(`\n${failed ? 'FAIL' : 'PASS'} dual-page poker sync (${room.roomId})`);
  if (errors.length) console.log('page-errors:\n' + errors.join('\n'));
  await browser.close();
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error('FAIL:', error);
  process.exitCode = 1;
});
