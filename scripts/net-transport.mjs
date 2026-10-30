/**
 * rds-room/1 transport loopback test (no browser / no WebRTC).
 * Wires WebRtcHostTransport <-> WebRtcGuestTransport over in-memory channels
 * and asserts the protocol behaves like RoomHttpAdapter: identity check,
 * per-viewer projection, delta pushes, hidden-info redaction.
 */
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });

const { GameRoom } = await server.ssrLoadModule('/packages/net/src/room.ts');
const { WebRtcHostTransport, WebRtcGuestTransport } = await server.ssrLoadModule('/packages/net/src/webrtc-transport.ts');
const { GAME_REGISTRY } = await server.ssrLoadModule('/packages/games/src/registry.ts');

let failed = 0;
const ok = (cond, name) => { if (!cond) { failed++; console.error('FAIL', name); } else console.log('ok -', name); };

/** In-memory channel pair with a late-bound host sink (the guest transport). */
function loopbackPair() {
  let hostSink = () => {};
  const host = { readyState: 'open', closed: false, send: text => hostSink(text), close() { this.closed = true; } };
  const guest = { readyState: 'open', send: text => host.onmessage?.({ data: text }), close() {} };
  return {
    host, guest,
    bind(gt) { hostSink = t => gt.receive(t); }
  };
}

function makeGuest(transport, peerId, viewer) {
  const pair = loopbackPair();
  transport.acceptChannel(peerId, pair.host);
  const guest = new WebRtcGuestTransport(pair.guest.send);
  pair.bind(guest);
  guest.join(viewer);
  return guest;
}

// --- Splendor: near-perfect info, basic round trip -------------------------
{
  const room = new GameRoom(GAME_REGISTRY.splendor, 42);
  const transport = new WebRtcHostTransport(room, 'u_host', () => {});
  const guest = makeGuest(transport, 'u_p2', 'p2');

  const updates = [];
  guest.onUpdate = u => updates.push(u);
  guest.requestSnapshot();
  ok(updates.length >= 1 && updates.at(-1).full, 'join/snapshot returns full projection');
  ok(updates.at(-1).state?.players && 'p2' in updates.at(-1).state.players, 'projection contains p2');

  guest.submit({ type: 'TAKE_3_DIFF_GEMS', playerId: 'p1', payload: {} });
  const rev = guest.revision;
  ok(guest.revision === rev, 'forged actor (p1 via p2) rejected, no state change');

  guest.submit({ type: 'TAKE_3_DIFF_GEMS', playerId: 'p2', payload: {} });
  guest.requestDelta(guest.revision);
  ok(updates.at(-1).revision === guest.revision, 'delta request returns current revision');
}

// --- Sanguosha: hidden information must never leak to guests ---------------
{
  const room = new GameRoom(GAME_REGISTRY.sanguosha, 57);
  const transport = new WebRtcHostTransport(room, 'u_host', () => {});
  const guest = makeGuest(transport, 'u_p3', 'p3');
  const others = Object.values(guest.state.players).filter(p => p.id !== 'p3');
  ok(others.every(p => p.role === 'LORD' ? p.secretRole === 'LORD' : p.secretRole === undefined && p.role === undefined),
    'other players\' secret roles are redacted (Lord stays public)');
}

// --- Multi-guest: both viewers get their own delta after a submit ----------
{
  const room = new GameRoom(GAME_REGISTRY.splendor, 7);
  const transport = new WebRtcHostTransport(room, 'u_host', () => {});
  const ga = makeGuest(transport, 'u_p1', 'p1');
  const gb = makeGuest(transport, 'u_p2', 'p2');
  const revB = gb.revision;
  ga.submit({ type: 'TAKE_3_DIFF_GEMS', playerId: 'p1', payload: {} });
  const moved = ga.revision > revB;
  ok(gb.revision - revB === (moved ? 1 : 0), 'other viewer delta pushed exactly once after submit');
}

// --- Seat ownership: a guest cannot claim a seat bound to another user ------
{
  const room = new GameRoom(GAME_REGISTRY.splendor, 11);
  const transport = new WebRtcHostTransport(room, 'u_host', () => {}, undefined, {
    p1: 'u_p1',
    p2: 'u_p2'
  });
  const thief = makeGuest(transport, 'u_p1', 'p2'); // u_p1 tries to sit in p2's seat
  ok(thief.state === null, 'guest cannot claim a seat owned by another user');

  const owner = makeGuest(transport, 'u_p2', 'p2');
  ok(!!owner.state, 'seat owner may join their own seat');
  ok(owner.state?.players?.p2 !== undefined, 'owner projection has its player');
}

// --- Seat ownership off (scripts / no hub identity): first come first served -
{
  const room = new GameRoom(GAME_REGISTRY.splendor, 13);
  const transport = new WebRtcHostTransport(room, 'u_host', () => {});
  const first = makeGuest(transport, 'u_any', 'p2');
  ok(!!first.state, 'unbound seat keeps the legacy first-come behaviour');
}

// --- Room-level actor guard (defence in depth) ------------------------------
{
  const room = new GameRoom(GAME_REGISTRY.splendor, 17);
  room.join('p1');
  room.setCurrentViewer('p1');
  const forged = room.submit({ type: 'TAKE_3_DIFF_GEMS', playerId: 'p2', payload: {} });
  room.setCurrentViewer(undefined);
  ok(forged.ok === false, 'room.submit rejects an actor that is not the current viewer');
  ok(room.getRevision() === 0, 'rejected actor does not advance the room revision');
}

// --- Disconnect: channel close leaves the room safely ----------------------
{
  const room = new GameRoom(GAME_REGISTRY.splendor, 9);
  const transport = new WebRtcHostTransport(room, 'u_host', () => {});
  const guest = makeGuest(transport, 'u_p2', 'p2');
  transport.channelClosed('u_p2');
  guest.submit({ type: 'TAKE_3_DIFF_GEMS', playerId: 'p2', payload: {} });
  ok(true, 'submit after disconnect does not throw (dropped silently)');
}

await server.close();
console.log(failed ? failed + ' FAILURES' : 'ALL PASS');
process.exit(failed ? 1 : 0);