/**
 * rds-room/1 WebRTC transport — the ONLY integration seam with RDS-Board-Hub.
 * Contract: docs/LOBBY-INTEGRATION.md and hub repo docs/PROTOCOL.md.
 *
 * Hub (RDS-Board-Hub) relays signaling only; game data flows peer-to-peer:
 *   Host browser  = authority: UniversalGameEngine + GameRoom (src/net/room.ts)
 *   Guest browser = projection consumer: own O(s,i) view + action submit
 */
import { GameRoom, RoomUpdate } from './room';
import type { Action, PlayerId } from '@rds/kernel/types';

/** Minimal data channel shape shared by RTCDataChannel and test doubles. */
export interface ChannelLike {
  readonly readyState: 'connecting' | 'open' | 'closing' | 'closed';
  send(data: string): void;
  close(): void;
}

// ---------------------------------------------------------------------------
// Hub signaling (WebSocket). Hub never parses SDP/ICE; from is hub-verified.
// ---------------------------------------------------------------------------
export type SignalHandler = {
  onPeerJoin?(peerId: string): void;
  onPeerLeave?(peerId: string): void;
  onSdp?(from: string, sdp: unknown): void;
  onIce?(from: string, candidate: unknown): void;
};

/** Phase 2 side-channel handlers: these survive signaling.on() overrides. */
export type SignalSideHandler = {
  onPresence?(online: string[]): void;
  onRoomUpdate?(room: { id: string; status: string }): void;
};

export class HubSignaling {
  private ws!: WebSocket;
  readonly selfId!: string;
  private peers = new Set<string>();
  private handlers: SignalHandler = {};
  private sideHandlers: SignalSideHandler = {};

  constructor(private readonly hubOrigin: string, private readonly token: string) {}

  public connect(roomId: string): Promise<{ selfId: string; peers: string[] }> {
    return new Promise((resolve, reject) => {
      // hub 参数可能是纯 origin（如 https://host）或已含 /ws 路径的 ws URL（契约形态），统一归一
      const base = this.hubOrigin.replace(/^http/, 'ws').replace(/\/$/, '');
      const url = (base.endsWith('/ws') ? base : base + '/ws') + '?token=' + encodeURIComponent(this.token);
      this.ws = new WebSocket(url);
      this.ws.onerror = () => reject(new Error('hub signaling failed: ' + url));
      this.ws.onmessage = ev => {
        const msg = JSON.parse(String(ev.data));
        switch (msg.t) {
          case 'hello':
            (this as { selfId: string }).selfId = msg.selfId;
            for (const p of msg.peers) this.peers.add(p);
            resolve({ selfId: msg.selfId, peers: [...this.peers] });
            break;
          case 'peer-join': this.peers.add(msg.peerId); this.handlers.onPeerJoin?.(msg.peerId); break;
          case 'peer-leave': this.peers.delete(msg.peerId); this.handlers.onPeerLeave?.(msg.peerId); break;
          case 'sdp': this.handlers.onSdp?.(msg.from, msg.sdp); break;
          case 'ice': this.handlers.onIce?.(msg.from, msg.candidate); break;
          case 'presence': this.sideHandlers.onPresence?.(msg.online ?? []); break;
          case 'room-updated': this.sideHandlers.onRoomUpdate?.(msg.room); break;
          default: break; // forward compatibility: ignore unknown
        }
      };
      this.ws.onopen = () => this.ws.send(JSON.stringify({ t: 'join-room', roomId }));
      this.ws.onclose = () => this.handlers.onPeerLeave?.('*');
    });
  }

  public on(h: SignalHandler): void { this.handlers = h; }
  /** Phase 2 side handlers (presence / room-updated); not replaced by on(). */
  public onSide(h: SignalSideHandler): void { this.sideHandlers = { ...this.sideHandlers, ...h }; }
  public sendSdp(to: string, sdp: unknown): void { this.ws.send(JSON.stringify({ t: 'sdp', to, sdp })); }
  public sendIce(to: string, candidate: unknown): void { this.ws.send(JSON.stringify({ t: 'ice', to, candidate })); }
  public close(): void { try { this.ws.send(JSON.stringify({ t: 'leave-room' })); this.ws.close(); } catch { /* already closed */ } }
}

// ---------------------------------------------------------------------------
// Channel message protocol (rds-room/1). Mirror of hub room-protocol types.
// ---------------------------------------------------------------------------
export type RoomChannelMessage =
  | { t: 'join'; viewer: string }
  | { t: 'submit'; action: Action }
  | { t: 'snapshot' }
  | { t: 'delta'; sinceRevision: number }
  | { t: 'room-update'; update: RoomUpdate }
  | { t: 'error'; message: string }
  | { t: 'bye' };

/** Host side: bridges DataChannels onto GameRoom exactly like RoomHttpAdapter. */
export class WebRtcHostTransport {
  /** peerId (hub userId) → open channel */
  private channels = new Map<string, ChannelLike>();
  /** peerId → viewer seat joined on the GameRoom */
  private viewers = new Map<string, PlayerId>();

  constructor(
    private readonly room: GameRoom,
    private readonly selfId: string,
    /** Test seam: production creates RTCPeerConnection per dialing guest. */
    private readonly attachChannel: (peerId: string, onChannel: (ch: ChannelLike) => void) => void,
    private readonly log: (...a: unknown[]) => void = () => {}
  ) {}

  public start(): void {
    this.attachChannel('*', () => { /* replaced per-peer by mesh layer */ });
  }

  /** Called by the mesh layer when a guest's data channel opens. */
  public acceptChannel(peerId: string, channel: ChannelLike): void {
    this.channels.set(peerId, channel);
    const bus = (channel as unknown as { onmessage?: { (ev: { data: string }): void } });
    (bus as any).onmessage = (ev: { data: string }) => this.onMessage(peerId, ev.data);
  }

  public channelClosed(peerId: string): void {
    this.channels.delete(peerId);
    const viewer = this.viewers.get(peerId);
    if (viewer) {
      this.viewers.delete(peerId);
      this.room.leave(viewer);
    }
  }

  private onMessage(peerId: string, text: string): void {
    let msg: RoomChannelMessage;
    try { msg = JSON.parse(text); } catch { return; }
    try {
    switch (msg.t) {
      case 'join': {
        // Seat claiming: each signaling peer owns exactly one viewer seat,
        // and each seat is owned by at most one peer. A peer cannot claim a
        // seat already held by another peer. Combined with the actor check in
        // 'submit' this prevents cross-player impersonation.
        const seat = msg.viewer as PlayerId;
        // 审查报告 S3：guest 自报座位，禁止 'GOD' 全知视角与非法座位标识
        if (typeof seat !== 'string' || !seat || seat === 'GOD' || seat.startsWith('__')) {
          this.reply(peerId, { t: 'error', message: 'invalid viewer seat' });
          return;
        }
        const owner = [...this.viewers.entries()].find(([, v]) => v === seat);
        if (owner && owner[0] !== peerId) {
          this.reply(peerId, { t: 'error', message: 'viewer seat already claimed by another peer' });
          return;
        }
        if (!owner) this.room.join(seat);
        this.viewers.set(peerId, seat);
        this.reply(peerId, { t: 'room-update', update: this.room.snapshot(seat) });
        break;
      }
      case 'submit': {
        const viewer = this.viewers.get(peerId);
        if (!viewer) { this.reply(peerId, { t: 'error', message: 'join first' }); return; }
        const action = msg.action;
        // 审查报告 S7/S10：__ 前缀是内核控制通道（如 __TICK__），guest 不可伪造；
        // 同时校验基本形状，畸形 action 不进入引擎。
        if (!action || typeof action !== 'object' || typeof action.type !== 'string' || action.type.startsWith('__')) {
          this.reply(peerId, { t: 'error', message: 'invalid action' });
          return;
        }
        if ((action.actorId ?? action.playerId) !== viewer) {
          this.reply(peerId, { t: 'error', message: 'actor does not match viewer' });
          return;
        }
        const result = this.room.submit(action);
        if (!result.ok) this.reply(peerId, { t: 'error', message: result.error ?? 'rejected' });
        // Every dispatch changes everyone's projection: push per-viewer deltas.
        this.pushDeltas();
        break;
      }
      case 'snapshot': {
        const viewer = this.viewers.get(peerId);
        if (viewer) this.reply(peerId, { t: 'room-update', update: this.room.snapshot(viewer) });
        break;
      }
      case 'delta': {
        const viewer = this.viewers.get(peerId);
        if (viewer) this.reply(peerId, { t: 'room-update', update: this.room.delta(viewer) });
        break;
      }
      case 'bye': this.channelClosed(peerId); break;
      default: break; // ignore unknown (forward compatibility)
    }
    } catch (err) {
      // 审查报告 S10：畸形消息不允许打崩宿主——降级为一条 error 回执
      this.log('channel message error from', peerId, err);
      this.reply(peerId, { t: 'error', message: 'malformed message' });
    }
  }

  /** After any submit, every joined guest gets its own projection delta. */
  public pushDeltas(): void {
    for (const [peerId, viewer] of this.viewers) {
      const ch = this.channels.get(peerId);
      if (ch?.readyState === 'open') ch.send(JSON.stringify({ t: 'room-update', update: this.room.delta(viewer) }));
    }
  }

  private reply(peerId: string, msg: RoomChannelMessage): void {
    const ch = this.channels.get(peerId);
    if (ch?.readyState === 'open') ch.send(JSON.stringify(msg));
    else this.log('drop reply to closed channel', peerId);
  }
}

/** Guest side: consumes its own projection; submits actions. No engine here. */
export class WebRtcGuestTransport {
  public state: unknown = null;
  public revision = -1;
  public onUpdate?: (update: RoomUpdate) => void;

  constructor(private readonly sendRaw: (text: string) => void) {}

  public receive(text: string): void {
    let msg: RoomChannelMessage;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.t === 'room-update') {
      const u = msg.update;
      this.revision = u.revision;
      if (u.full || this.state === null) this.state = u.state ?? null;
      this.onUpdate?.(u);
    } else if (msg.t === 'error') {
      this.onUpdate?.({ viewer: '', revision: -1, baseRevision: -1, full: true, patches: [], error: msg.message } as RoomUpdate);
    }
  }

  public join(viewer: PlayerId): void { this.sendRaw(JSON.stringify({ t: 'join', viewer })); }
  public submit(action: Action): void { this.sendRaw(JSON.stringify({ t: 'submit', action })); }
  public requestSnapshot(): void { this.sendRaw(JSON.stringify({ t: 'snapshot' })); }
  public requestDelta(sinceRevision: number): void { this.sendRaw(JSON.stringify({ t: 'delta', sinceRevision })); }
  public bye(): void { this.sendRaw(JSON.stringify({ t: 'bye' })); }
}

/** Browser mesh layer: guests dial the host (hostId known from the hub room DTO). */
export async function openGuestChannel(
  signaling: HubSignaling, hostId: string
): Promise<{ channel: RTCDataChannel; pc: RTCPeerConnection }> {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  const channel = pc.createDataChannel('rds-room');
  channel.binaryType = 'arraybuffer';
  pc.onicecandidate = ev => { if (ev.candidate) signaling.sendIce(hostId, ev.candidate); };
  signaling.on({
    onSdp: async (from, sdp) => {
      if (from === hostId) await pc.setRemoteDescription(sdp as RTCSessionDescriptionInit);
    },
    onIce: (from, candidate) => {
      if (from === hostId) pc.addIceCandidate(candidate as RTCIceCandidateInit).catch(() => undefined);
    }
  });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  signaling.sendSdp(hostId, offer);
  await new Promise<void>((resolve, reject) => {
    channel.onopen = () => resolve();
    channel.onerror = e => reject(e);
    setTimeout(() => reject(new Error('data channel timeout')), 20000);
  });
  return { channel, pc };
}

/** Browser host mesh: answers guest dials, hands channels to WebRtcHostTransport. */
export function startHostMesh(
  signaling: HubSignaling, transport: WebRtcHostTransport
): void {
  const peers = new Map<string, RTCPeerConnection>();
  signaling.on({
    onPeerLeave: peerId => {
      peers.get(peerId)?.close();
      peers.delete(peerId);
      transport.channelClosed(peerId);
    },
    onSdp: async (from, sdp) => {
      let pc = peers.get(from);
      // 阶段三：guest 掉线重拨时，旧 pc 可能停在 failed/disconnected 半死状态
      // （对它 setRemoteDescription 会静默失败，answer 永远发不回去）。先拆旧的再重建。
      if (pc && pc.connectionState !== 'connected' && pc.connectionState !== 'connecting' && pc.connectionState !== 'new') {
        try { pc.close(); } catch { /* already closed */ }
        peers.delete(from);
        transport.channelClosed(from);
        pc = undefined;
      }
      if (!pc) {
        pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        peers.set(from, pc);
        pc.ondatachannel = ev => {
          const ch = ev.channel;
          ch.binaryType = 'arraybuffer';
          ch.onopen = () => transport.acceptChannel(from, ch as unknown as ChannelLike);
          ch.onclose = () => transport.channelClosed(from);
        };
        pc.onicecandidate = e2 => { if (e2.candidate) signaling.sendIce(from, e2.candidate); };
      }
      await pc.setRemoteDescription(sdp as RTCSessionDescriptionInit);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      signaling.sendSdp(from, answer);
    },
    onIce: (from, candidate) => {
      peers.get(from)?.addIceCandidate(candidate as RTCIceCandidateInit).catch(() => undefined);
    }
  });
}
