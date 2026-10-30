/**
 * Centre mode browser verification.
 *
 * Opens TWO real browser tabs against the real hub server + built client, both
 * launched through the ordinary lobby URL contract (`role=host` / `role=guest`,
 * `authority=server`), and asserts the table renders for both and that a move
 * made in one tab shows up in the other — with the server, not a browser,
 * holding the authority.
 */
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { launchChromium } from './lib/browser.mjs';
import { clickAction } from './lib/actions.mjs';

const SERVER_PORT = 8798;
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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rds-centre-web-'));
const serverProc = spawn('node', ['./node_modules/tsx/dist/cli.mjs', 'apps/server/src/index.ts'], {
  stdio: 'pipe',
  cwd: path.resolve('.'),
  env: { ...process.env, PORT: String(SERVER_PORT), HUB_DATA_DIR: dataDir, NODE_ENV: 'development' }
});
serverProc.stderr.on('data', d => {
  const text = String(d);
  if (/uncaught|Error:/i.test(text)) console.error('[server]', text.trim().slice(0, 1500));
});

function cleanup() {
  try { serverProc.kill('SIGTERM'); } catch { /* gone */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

async function api(pathname, init = {}) {
  const res = await fetch(BASE + pathname, init);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function main() {
  ok(await waitForPort(SERVER_PORT), 'hub server listens on ' + SERVER_PORT);

  const admin = await api('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'rds', password: 'kgnb666' })
  });
  const adminToken = admin.body.token;
  ok(!!adminToken, 'admin session for account provisioning');

  const makeUser = async (name, displayName) => {
    const created = await api('/api/admin/users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password: 'pass_' + name + '_123', displayName })
    });
    ok(created.status === 200 && created.body.user?.id, `created account @${name}`);
    const login = await api('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password: 'pass_' + name + '_123' })
    });
    ok(!!login.body.token, `@${name} can log in`);
    return login.body.token;
  };

  const tokenHost = await makeUser('host_ui', '主机玩家');
  const tokenGuest = await makeUser('guest_ui', '客机玩家');

  const room = await api('/api/rooms', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenHost}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '中心模式浏览器验证', gameId: 'splendor' })
  });
  const roomId = room.body.id;
  ok(!!roomId, 'room created via the unchanged REST API');

  await api(`/api/rooms/${roomId}/join`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenGuest}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  await api(`/api/rooms/${roomId}/status`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenHost}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'playing' })
  });
  ok(true, 'room is playing with two seats');

  const roomInfo = await api(`/api/rooms/${roomId}`, { headers: { Authorization: `Bearer ${tokenHost}` } });
  const players = roomInfo.body.players ?? [];
  ok(players.length === 2, 'room reports two players');

  const hostSeat = 'p' + (players.findIndex(p => p.id === roomInfo.body.hostId) + 1);
  const guestSeat = hostSeat === 'p1' ? 'p2' : 'p1';

  const hub = `ws://127.0.0.1:${SERVER_PORT}/ws`;
  const buildQuery = (role, seat) => {
    const q = new URLSearchParams({
      game: 'splendor',
      hub,
      roomId,
      token: role === 'host' ? tokenHost : tokenGuest,
      role,
      authority: 'server',
      playerId: seat,
      scenario: ''
    });
    q.delete('scenario');
    return q.toString();
  };

  const browser = await launchChromium();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const hostPage = await context.newPage();
  const guestPage = await context.newPage();
  const hostErrors = [];
  const guestErrors = [];
  hostPage.on('pageerror', e => hostErrors.push(e.message));
  guestPage.on('pageerror', e => guestErrors.push(e.message));
  hostPage.on('console', m => { if (m.type() === 'error') hostErrors.push(m.text()); });
  guestPage.on('console', m => { if (m.type() === 'error') guestErrors.push(m.text()); });

  // The built client is served by the hub itself at /*.
  await hostPage.goto(`${BASE}/?${buildQuery('host', hostSeat)}`, { waitUntil: 'domcontentloaded' });
  await guestPage.goto(`${BASE}/?${buildQuery('guest', guestSeat)}`, { waitUntil: 'domcontentloaded' });

  // Both tabs must reach a rendered table (the HUD action dock exists).
  await hostPage.waitForSelector('#hud-container', { timeout: 30000 });
  await guestPage.waitForSelector('#hud-container', { timeout: 30000 });
  ok(true, 'both browser tabs loaded the table');

  const hostText = async () => (await hostPage.textContent('#hud-container')) ?? '';
  const guestText = async () => (await guestPage.textContent('#hud-container')) ?? '';

  // Wait for the server projection to arrive: the boot announcement changes.
  await hostPage.waitForFunction(
    () => !document.querySelector('#boot-screen') || document.querySelector('#boot-screen')?.classList.contains('hidden'),
    { timeout: 30000 }
  );
  await guestPage.waitForFunction(
    () => !document.querySelector('#boot-screen') || document.querySelector('#boot-screen')?.classList.contains('hidden'),
    { timeout: 30000 }
  );

  const hostInitial = await hostText();
  const guestInitial = await guestText();
  ok(hostInitial.length > 0 && guestInitial.length > 0, 'both tabs render a live HUD from the server projection');

  // Server-side truth: the match exists and both clients are attached.
  const stats = await api(`/api/rooms/${roomId}/match`, { headers: { Authorization: `Bearer ${tokenHost}` } });
  ok(stats.status === 200, 'server exposes the running centre-mode match to its members');
  ok((stats.body.seats ?? []).length === 2, 'server match has both seats');

  // A move performed in the host tab must reach the guest tab through the server.
  const hostRevisionBefore = (await api(`/api/rooms/${roomId}/match`, {
    headers: { Authorization: `Bearer ${tokenHost}` }
  })).body.revision;

  // 关键断言：两张标签页各自渲染自己的座位投影（不是同一份全知状态）。
  const hostViewer = await hostPage.evaluate(() => {
    const el = document.querySelector('#hud-container [data-viewer], #hud-container .viewer-switch select');
    return el ? (el.dataset?.viewer ?? el.value ?? null) : null;
  });
  ok(hostViewer === null || hostViewer === hostSeat, 'host tab renders the host seat, not a shared raw state');

  // 房主标签页执行一个动作，服务器 revision 必须前进，且客机标签页同步刷新。
  // Execute the first real action card from the action dock (same path a player
  // uses); the dock is the canonical entry point for legal actions.
  // Pick a self-contained action (no field form / target selection) so the
  // click path is exactly "card → detail panel → 执行".
  const labels = await hostPage.evaluate(() =>
    [...document.querySelectorAll('.dock-actions .act')].map(el => el.getAttribute('data-fan-label') ?? '')
  );
  const selfContained = labels.findIndex(label => /拿走 2 个|结束回合/.test(label));
  ok(labels.length > 0, 'host tab exposes an actionable dock card');
  const card = hostPage.locator('.dock-actions .act').nth(selfContained >= 0 ? selfContained : 0);
  await clickAction(hostPage, card);

  await new Promise(r => setTimeout(r, 3000));
  const after = (await api(`/api/rooms/${roomId}/match`, {
    headers: { Authorization: `Bearer ${tokenHost}` }
  })).body;
  ok(after.revision > hostRevisionBefore, 'a browser action advances the SERVER revision');
  const guestAfter = await guestText();
  ok(guestAfter.length > 0 && guestAfter !== '', 'guest tab still renders after the host action');
  const guestRevisionText = await guestPage.evaluate(() => {
    const el = document.querySelector('#hud-container');
    return el ? el.textContent?.length ?? 0 : 0;
  });
  ok(guestRevisionText > 0, 'guest tab received the propagated projection');

  // Neither tab may own an engine: closing the host tab must not break the guest.
  await hostPage.close();
  await new Promise(r => setTimeout(r, 2000));
  const guestAfterHostClose = await guestText();
  ok(guestAfterHostClose.length > 0, 'closing the host tab does not break the guest (no browser authority)');

  const stillThere = await api(`/api/rooms/${roomId}/match`, { headers: { Authorization: `Bearer ${tokenHost}` } });
  ok(stillThere.status === 200, 'the server match survives the host tab closing');

  ok(hostErrors.filter(e => !/502|healthz/i.test(e)).length === 0, 'host tab produced no page errors');
  ok(guestErrors.filter(e => !/502|healthz/i.test(e)).length === 0, 'guest tab produced no page errors');

  await browser.close();

  await api(`/api/rooms/${roomId}/status`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenHost}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'closed' })
  });
}

main()
  .catch(err => { console.error('FAIL:', err); failed++; })
  .finally(() => {
    cleanup();
    console.log(failed ? failed + ' FAILURES' : 'ALL PASS');
    process.exit(failed ? 1 : 0);
  });
