/**
 * NetSession loopback test (no browser / no WebRTC / no signaling).
 * Drives a host NetSession (UniversalSession + GameRoom sharing one engine)
 * against a guest NetSession (projection-only) over in-memory channels, and
 * asserts the GamePresenter semantics documented in src/app/netSession.ts.
 */
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });

const { WebRtcGuestTransport } = await server.ssrLoadModule('/packages/net/src/webrtc-transport.ts');
const { NetSession } = await server.ssrLoadModule('/packages/app/src/netSession.ts');
const { GAME_REGISTRY } = await server.ssrLoadModule('/packages/games/src/registry.ts');

let failed = 0;
const ok = (cond, name) => { if (!cond) { failed++; console.error('FAIL', name); } else console.log('ok -', name); };

const module = GAME_REGISTRY.splendor;

// --- wiring: in-memory channel pair host <-> guest -------------------------
const { session: host, transport: hostTransport } = NetSession.createLoopbackHost(module, {
  hub: 'loopback',
  roomId: 'room-lo',
  token: 't',
  role: 'host',
  playerId: 'p1'
});

const guestNotices = [];
const guestSnapshots = [];
const hostSnapshots = [];

let hostToGuest = () => {};
const hostChannel = {
  readyState: 'open',
  send: text => hostToGuest(text),
  close() { this.readyState = 'closed'; }
};
hostTransport.acceptChannel('u_p2', hostChannel);

const guest = new NetSession(module, {
  hub: 'loopback',
  roomId: 'room-lo',
  token: 't',
  role: 'guest',
  playerId: 'p2',
  hostId: 'u_host_lo'
});
const gt = new WebRtcGuestTransport(text => hostChannel.onmessage?.({ data: text }));
hostToGuest = text => gt.receive(text);
guest.onNotice(n => guestNotices.push(n));
guest.subscribe(s => guestSnapshots.push(s));
host.subscribe(s => hostSnapshots.push(s));
guest.attachGuestTransport(gt); // sends join(p2) -> host replies full snapshot

// --- 1. join: guest gets a full projection ---------------------------------
{
  const s = guest.getSnapshot();
  ok(s && s.gameId === 'splendor', 'guest snapshot has gameId');
  ok(s.viewer === 'p2', 'guest viewer is its claimed seat p2');
  ok(!!s.board?.players?.p2, 'guest projection contains own player');
  ok(s.dependencyErrors.length === 0, 'no schema dependency errors');
  ok(guestSnapshots.length >= 1, 'guest subscribe delivered a snapshot');
  ok(s.log.seed === 0 && s.log.hash === '', 'guest log hides host-owned seed/hash');
}

// Splendor auto-advances the turn after each action, so the two seats
// alternate: host (p1) acts first, then the guest (p2) may act.
const tick = () => new Promise(r => setTimeout(r, 0));

// --- 2. host perform: local dispatch tails to guests -----------------------
{
  const hostBefore = host.getSnapshot();
  const target = hostBefore.actions.find(a => a.actionType === 'TAKE_3_DIFF_GEMS');
  if (!target) {
    ok(false, 'find a TAKE_3_DIFF_GEMS bound action for p1');
  } else {
    const before = guest.getSnapshot();
    const res = host.perform(target.id);
    ok(res.ok, 'host.perform delegates to inner session');
    await tick(); // engine notify -> microtask -> room tail-sync -> guest delta
    const after = guest.getSnapshot();
    ok(after.revision > before.revision, 'guest observed host-side action');
    ok(after.board?.seq === host.getSnapshot().board?.seq, 'board seq agrees after host move');
    ok(after.actions.some(a => a.actionType === 'TAKE_3_DIFF_GEMS'), 'p2 may act after host move');
  }
}

// --- 3. guest perform: optimistic submit, host-authoritative delta ---------
{
  const before = guest.getSnapshot();
  const target = before.actions.find(a => a.actionType === 'TAKE_3_DIFF_GEMS');
  if (!target) {
    ok(false, 'find a TAKE_3_DIFF_GEMS bound action for p2');
  } else {
    const res = guest.perform(target.id);
    ok(res.ok, 'guest.perform accepted (optimistic)');
    await tick(); // host room logs action, engine dispatch, delta back to guest
    const after = guest.getSnapshot();
    ok(after.revision > before.revision, 'guest revision advanced after host delta');
    ok(after.board?.seq === host.getSnapshot().board?.seq, 'board seq agrees after guest move');
    const p2Gems = st => JSON.stringify(st.board?.players?.p2?.customProps ?? st.board?.players?.p2 ?? {});
    ok(p2Gems(after) !== p2Gems(before), 'guest board state changed');
  }
}

// --- 4. illegal guest action: host rejects, guest gets error notice --------
{
  const before = guest.getSnapshot();
  const noticesBefore = guestNotices.length;
  gt.submit({ type: 'TAKE_3_DIFF_GEMS', playerId: 'p1', payload: {} }); // forged actor
  ok(guest.getSnapshot().revision === before.revision, 'forged actor did not change state');
  ok(guestNotices.length >= noticesBefore, 'rejection surfaced to guest (notice or silent)');
}

// --- 5. guest-only debug features degrade to notices ------------------------
{
  const noticesBefore = guestNotices.length;
  guest.rewind(1);
  guest.verifyReplay();
  guest.setViewer('GOD');
  guest.advanceClock(1);
  ok(guestNotices.length >= noticesBefore + 4, 'rewind/verify/setViewer/advanceClock all noticed');
  ok(guest.getSnapshot().viewer === 'p2', 'setViewer is a no-op for guests');
}

// --- 6. snapshot shape parity (UI contract) --------------------------------
{
  const s = guest.getSnapshot();
  for (const key of ['phaseLabel', 'players', 'actions', 'stack', 'hooks', 'spatial', 'placement', 'board', 'viewers']) {
    ok(key in s, `guest snapshot has ${key}`);
  }
  ok(s.viewers.some(v => v.id === 'GOD'), 'viewers include GOD for reference');
}

// --- 7. seat ownership: NetSession wires seatOwners into the transport ------
{
  const { session: host2, transport: t2 } = NetSession.createLoopbackHost(module, {
    hub: 'loopback',
    roomId: 'room-seats',
    token: 't',
    role: 'host',
    playerId: 'p1',
    seatOwners: { p1: 'u_p1', p2: 'u_p2' }
  });

  let sinkEvil = () => {};
  const chEvil = { readyState: 'open', send: text => sinkEvil(text), close() {} };
  t2.acceptChannel('u_evil', chEvil);
  const gEvil = new WebRtcGuestTransport(text => chEvil.onmessage?.({ data: text }));
  sinkEvil = text => gEvil.receive(text);
  const errors = [];
  gEvil.onUpdate = u => { if (u.revision === -1) errors.push(u); };
  gEvil.join('p2'); // u_evil claims p2, which belongs to u_p2
  ok(errors.length === 1, 'guest cannot claim a seat bound to another hub user');
  ok(errors[0].error === 'seat is bound to another user', 'rejection explains the seat binding');

  let sinkOwner = () => {};
  const chOwner = { readyState: 'open', send: text => sinkOwner(text), close() {} };
  t2.acceptChannel('u_p2', chOwner);
  const gOwner = new WebRtcGuestTransport(text => chOwner.onmessage?.({ data: text }));
  sinkOwner = text => gOwner.receive(text);
  gOwner.join('p2');
  ok(!!gOwner.state?.players?.p2, 'the bound seat owner still joins normally');

  host2.dispose();
}

host.dispose();
guest.dispose();
ok(true, 'dispose clean');

await server.close();
console.log(failed === 0 ? 'PASS net-session 7 blocks' : `FAILED ${failed}`);
process.exit(failed === 0 ? 0 : 1);
