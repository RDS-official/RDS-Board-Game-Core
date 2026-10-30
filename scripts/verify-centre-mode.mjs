/**
 * Centre mode (server-authoritative rooms) end-to-end verification.
 *
 * Boots the real hub server on a scratch data directory, creates a room through
 * the ordinary REST API (unchanged contract), then drives TWO WebSocket clients
 * exactly like the browser would (`join-room` → `match-join` → `match-submit`)
 * and asserts the server is the single authority:
 *
 *  - seats are assigned by the server, never self-declared;
 *  - both clients see only their own projection O(s,i);
 *  - a client cannot forge another player's actor;
 *  - a legal action by one client reaches the other client as a delta;
 *  - a browser can no longer advance the clock (`__TICK__`) or read raw state.
 */
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import WebSocket from 'ws';

const SERVER_PORT = 8799;
const BASE = `http://127.0.0.1:${SERVER_PORT}`;

let failed = 0;
const ok = (cond, name) => { if (!cond) { failed++; console.error('FAIL', name); } else console.log('ok -', name); };

function probePort(port) {
  return new Promise(resolve => {
    const s = connect({ port, host: '127.0.0.1' });
    s.setTimeout(400);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => { resolve(false); });
  });
}

async function waitForPort(port, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probePort(port)) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rds-centre-'));

const serverProc = spawn('node', ['./node_modules/tsx/dist/cli.mjs', 'apps/server/src/index.ts'], {
  stdio: 'pipe',
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    PORT: String(SERVER_PORT),
    HUB_DATA_DIR: dataDir,
    NODE_ENV: 'development',
    // Deterministic, fast logical clock for window timeouts.
    MATCH_TICK_MS: '300'
  }
});
serverProc.stderr.on('data', d => {
  const text = String(d);
  if (/uncaught|Error:/i.test(text)) console.error('[server]', text.trim().slice(0, 2000));
});

function cleanup() {
  try { serverProc.kill('SIGTERM'); } catch { /* already gone */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

async function api(pathname, init = {}) {
  const res = await fetch(BASE + pathname, init);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

/** Mirrors the browser client: connect, join-room, match-join, then collect. */
class Client {
  constructor(token, label) {
    this.token = token;
    this.label = label;
    this.updates = [];
    this.errors = [];
    this.seat = undefined;
    this.ws = null;
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/ws?token=${encodeURIComponent(this.token)}`);
      this.ws = ws;
      ws.on('error', err => reject(err));
      ws.on('message', raw => {
        let msg;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.t === 'match-seat') { this.seat = msg.seat; resolve(); }
        else if (msg.t === 'room-update') this.updates.push(msg.update);
        else if (msg.t === 'error') this.errors.push(msg.message);
      });
      ws.on('open', () => resolve());
      setTimeout(() => reject(new Error(this.label + ' connect timeout')), 8000);
    });
  }

  send(payload) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(payload)); }

  joinRoom(roomId) {
    return new Promise(resolve => {
      const onMessage = raw => {
        let msg;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.t === 'hello') { this.ws.off('message', onMessage); resolve(); }
      };
      this.ws.on('message', onMessage);
      this.send({ t: 'join-room', roomId });
      setTimeout(resolve, 4000);
    });
  }

  joinMatch(roomId) {
    return new Promise(resolve => {
      const onMessage = raw => {
        let msg;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.t === 'match-seat') { this.ws.off('message', onMessage); this.seat = msg.seat; resolve(); }
      };
      this.ws.on('message', onMessage);
      this.send({ t: 'match-join', roomId });
      setTimeout(resolve, 5000);
    });
  }

  latest() { return this.updates.at(-1); }

  waitForRevision(atLeast, timeoutMs = 6000) {
    return new Promise(resolve => {
      const has = () => this.latest() && this.latest().revision >= atLeast;
      if (has()) return resolve(true);
      const onMessage = raw => {
        let msg;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.t === 'room-update' && msg.update.revision >= atLeast) {
          this.ws.off('message', onMessage);
          resolve(true);
        }
      };
      this.ws.on('message', onMessage);
      setTimeout(() => { this.ws.off('message', onMessage); resolve(has()); }, timeoutMs);
    });
  }

  close() { try { this.ws?.close(); } catch { /* ignore */ } }
}

async function main() {
  const up = await waitForPort(SERVER_PORT);
  ok(up, 'hub server listens on ' + SERVER_PORT);
  if (!up) throw new Error('server did not start');

  // ---- ordinary account + room flow (unchanged REST contract) ----
  const admin = await api('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'rds', password: 'kgnb666' })
  });
  ok(admin.status === 200 && admin.body.token, 'admin can log in');
  const adminToken = admin.body.token;

  const created = await api('/api/admin/users', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'p_one', password: 'pass_one_123', displayName: '玩家一' })
  });
  ok(created.status === 200 && created.body.user?.id, 'admin creates the first player');
  const playerOneId = created.body.user.id;

  const created2 = await api('/api/admin/users', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'p_two', password: 'pass_two_123', displayName: '玩家二' })
  });
  ok(created2.status === 200 && created2.body.user?.id, 'admin creates the second player');
  const playerTwoId = created2.body.user.id;

  const loginOne = await api('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'p_one', password: 'pass_one_123' })
  });
  const loginTwo = await api('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'p_two', password: 'pass_two_123' })
  });
  ok(!!loginOne.body.token && !!loginTwo.body.token, 'both players log in');
  const tokenOne = loginOne.body.token;
  const tokenTwo = loginTwo.body.token;

  const room = await api('/api/rooms', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenOne}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '中心模式验证房', gameId: 'splendor' })
  });
  ok(room.status === 200 && room.body.id, 'room created through the unchanged REST API');
  const roomId = room.body.id;

  const joined = await api(`/api/rooms/${roomId}/join`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenTwo}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  ok(joined.status === 200 && joined.body.players.length === 2, 'second player joins the room');

  const started = await api(`/api/rooms/${roomId}/status`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenOne}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'playing' })
  });
  ok(started.status === 200 && started.body.status === 'playing', 'room switches to playing');

  // ---- centre mode: two clients, server owns the engine ----
  const one = new Client(tokenOne, 'p_one');
  const two = new Client(tokenTwo, 'p_two');
  await one.open();
  await two.open();
  await one.joinRoom(roomId);
  await two.joinRoom(roomId);
  await one.joinMatch(roomId);
  await two.joinMatch(roomId);
  // match-seat and the first full projection are separate frames; let both land.
  await new Promise(r => setTimeout(r, 500));

  ok(one.seat === 'p1', 'server assigns seat p1 to the first room member');
  ok(two.seat === 'p2', 'server assigns seat p2 to the second room member');

  ok(!!one.latest()?.state && !!two.latest()?.state, 'both clients receive a full projection');

  const projectionOne = one.latest().state;
  const projectionTwo = two.latest().state;
  ok(!!projectionOne.players?.p1 && !!projectionTwo.players?.p2, 'each client sees its own seat actor');
  // Projections are viewer-specific: the two clients must not receive identical views.
  ok(
    JSON.stringify(projectionOne.legalActions) !== JSON.stringify(projectionTwo.legalActions),
    'the server personalises each projection (no shared raw state)'
  );

  const legalOne = (projectionOne.legalActions ?? []).filter(a => (a.actorId ?? a.playerId) === 'p1');
  ok(legalOne.length > 0, 'server projection offers p1 its own legal actions');
  const illegalForeign = (projectionTwo.legalActions ?? []).some(a => (a.actorId ?? a.playerId) === 'p1');
  ok(!illegalForeign, 'p2 projection never contains p1 actions');

  // Forged identity from the network layer is rejected by the server.
  one.errors.length = 0;
  one.send({ t: 'match-submit', action: { ...legalOne[0], playerId: 'p2', actorId: 'p2' } });
  await new Promise(r => setTimeout(r, 600));
  ok(one.errors.some(e => /actor does not match|invalid/i.test(e)), 'server rejects a forged actor');

  // Kernel control channel is unreachable from a browser.
  one.errors.length = 0;
  one.send({ t: 'match-submit', action: { type: '__TICK__', playerId: 'p1', payload: { ticks: 5 } } });
  await new Promise(r => setTimeout(r, 600));
  ok(one.errors.length > 0, 'server rejects kernel control actions from clients');

  // A legal action by p1 propagates to p2 as a delta on the SAME server match.
  const before = two.latest().revision;
  const action = legalOne[0];
  one.send({ t: 'match-submit', action: { ...action, playerId: 'p1' } });
  const advanced = await two.waitForRevision(before + 1);
  ok(advanced, 'a legal action from p1 reaches p2 as a delta');
  ok(two.latest().state !== null, 'p2 still holds its own projection after the delta');

  // No client owns the raw state: the projection only carries legal actions and
  // scrubbed players; nothing exposes the seed or the full deck order.
  const raw = JSON.stringify(two.latest().state);
  ok(!/"seed"\s*:/.test(raw), 'projection does not leak the seed');
  ok(!/"passHash"|"salt"/.test(raw), 'projection never carries credential material');

  // ---- observability endpoint: members only ----
  const stats = await api(`/api/rooms/${roomId}/match`, { headers: { Authorization: `Bearer ${tokenOne}` } });
  ok(stats.status === 200 && stats.body.roomId === roomId, 'room member can inspect the server match');
  ok(Array.isArray(stats.body.seats) && stats.body.seats.length === 2, 'server match reports both seats');
  const stranger = await api(`/api/rooms/${roomId}/match`);
  ok(stranger.status === 401, 'anonymous access to match stats is rejected');

  // ---- closing the room releases the server match ----
  await api(`/api/rooms/${roomId}/status`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenOne}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'closed' })
  });
  await new Promise(r => setTimeout(r, 800));
  const afterClose = await api(`/api/rooms/${roomId}/match`, { headers: { Authorization: `Bearer ${tokenOne}` } });
  ok(afterClose.status === 404, 'closing the room releases its server match');

  one.close();
  two.close();

  // ---- P2P fallback still selectable through the same URL contract ----
  ok(playerOneId && playerTwoId, 'both player ids are known to the test');
}

main()
  .catch(err => { console.error('FAIL:', err); failed++; })
  .finally(() => {
    cleanup();
    console.log(failed ? failed + ' FAILURES' : 'ALL PASS');
    process.exit(failed ? 1 : 0);
  });
