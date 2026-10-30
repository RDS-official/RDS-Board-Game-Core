import type { WebSocket } from 'ws';
import type { Action } from '@rds/kernel/types';
import { MatchManager } from './match.ts';
import { profileOf } from './auth.ts';
import { rooms } from './storage.ts';

/**
 * 中心模式（服务器权威）的 WebSocket 通道。
 *
 * 复用既有 `/ws`：SignalHub 继续负责 join-room / sdp / presence / lobby-chat，
 * 本 broker 只额外接管以 `match-` 开头的消息，因此 **联机接口零破坏**
 * （URL 参数、REST、房间流程全部不变），权威从「房主浏览器」搬到服务端进程。
 *
 * 消息契约（与 rds-room/1 同形，客户端可复用同一套 RoomUpdate 消费逻辑）：
 *   client → server : { t: 'match-join' } | { t: 'match-submit', action }
 *                     | { t: 'match-snapshot' } | { t: 'match-delta' }
 *   server → client : { t: 'room-update', update } | { t: 'match-seat', seat, roomId }
 *                     | { t: 'match-state', ... } | { t: 'error', message }
 */

export class MatchBroker {
  public readonly matches = new MatchManager();
  /** roomId → (userId → ws) */
  private readonly roomSockets = new Map<string, Map<string, WebSocket>>();

  /**
   * 为一条已鉴权的连接挂上中心模式通道。
   * SignalHub 已在同一 ws 上监听 message，额外监听不会互相干扰。
   */
  public attach(ws: WebSocket, userId: string): void {
    let joinedRoomId: string | undefined;
    let pendingRoomId: string | undefined;
    let unsubscribe: (() => void) | undefined;

    const send = (payload: unknown) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(payload));
    };

    const pushDeltas = (roomId: string) => {
      const match = this.matches.get(roomId);
      const peers = this.roomSockets.get(roomId);
      if (!match || !peers) return;
      for (const [uid, socket] of peers) {
        if (socket.readyState !== 1) continue;
        const update = match.deltaFor(uid);
        if ('error' in update) continue;
        socket.send(JSON.stringify({ t: 'room-update', update }));
      }
    };

    const detach = () => {
      unsubscribe?.();
      unsubscribe = undefined;
      if (!joinedRoomId) return;
      this.matches.get(joinedRoomId)?.detach(userId);
      const peers = this.roomSockets.get(joinedRoomId);
      peers?.delete(userId);
      if (peers && peers.size === 0) this.roomSockets.delete(joinedRoomId);
      joinedRoomId = undefined;
    };

    const joinMatch = () => {
      const roomId = pendingRoomId;
      if (!roomId) {
        send({ t: 'error', message: '请先加入房间（join-room）' });
        return;
      }
      const room = rooms.byId(roomId);
      if (!room) {
        send({ t: 'error', message: '房间不存在' });
        return;
      }
      if (!room.players.includes(userId)) {
        send({ t: 'error', message: '你不在该房间内' });
        return;
      }

      // 座位 = 大厅玩家顺序（p1..pN），由服务器决定，客户端无法自报。
      const seats = room.players.map(pid => {
        const profile = profileOf(pid);
        return {
          userId: pid,
          name: profile?.displayName ?? profile?.name ?? pid,
          avatarUrl: profile?.avatarUrl
        };
      });
      const match = this.matches.ensure({
        roomId: room.id,
        gameId: room.gameId,
        scenario: room.scenarioId,
        players: seats
      });

      const update = match.attach(userId);
      if ('error' in update) {
        send({ t: 'error', message: update.error });
        return;
      }

      joinedRoomId = room.id;
      unsubscribe?.();
      unsubscribe = match.onChange(() => pushDeltas(room.id));

      let peers = this.roomSockets.get(room.id);
      if (!peers) {
        peers = new Map();
        this.roomSockets.set(room.id, peers);
      }
      peers.set(userId, ws);

      send({ t: 'match-seat', roomId: room.id, seat: match.seatOf(userId) });
      send({ t: 'room-update', update });
      send({
        t: 'match-state',
        roomId: room.id,
        gameId: room.gameId,
        revision: match.revision,
        seats: match.seatList()
      });
    };

    const onMessage = (raw: string) => {
      let msg: { t?: string; roomId?: string; action?: Action } = {};
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (!msg || typeof msg.t !== 'string') return;

      // 记录房间意图：join-room 由 SignalHub 校验成员资格，这里只记住房间号，
      // 真正建局推迟到 match-join，避免浏览大厅时误建对局。
      if (msg.t === 'join-room' && typeof msg.roomId === 'string') {
        pendingRoomId = msg.roomId;
        if (joinedRoomId && joinedRoomId !== msg.roomId) detach();
        return;
      }
      if (!msg.t.startsWith('match-')) return;

      switch (msg.t) {
        case 'match-join':
          if (msg.roomId && typeof msg.roomId === 'string') pendingRoomId = msg.roomId;
          joinMatch();
          break;
        case 'match-submit': {
          const match = joinedRoomId ? this.matches.get(joinedRoomId) : undefined;
          if (!match) {
            send({ t: 'error', message: '尚未加入对局' });
            return;
          }
          const action = msg.action;
          if (!action || typeof action !== 'object' || typeof action.type !== 'string') {
            send({ t: 'error', message: 'invalid action' });
            return;
          }
          try {
            const result = match.submit(userId, action);
            if (!result.ok) send({ t: 'error', message: result.error ?? 'rejected' });
          } catch (err) {
            send({ t: 'error', message: String((err as Error)?.message ?? 'submit failed') });
          }
          break;
        }
        case 'match-snapshot': {
          const match = joinedRoomId ? this.matches.get(joinedRoomId) : undefined;
          if (!match) {
            send({ t: 'error', message: '尚未加入对局' });
            return;
          }
          const update = match.snapshotFor(userId);
          if ('error' in update) send({ t: 'error', message: update.error });
          else send({ t: 'room-update', update });
          break;
        }
        case 'match-delta': {
          const match = joinedRoomId ? this.matches.get(joinedRoomId) : undefined;
          if (!match) return;
          const update = match.deltaFor(userId);
          if (!('error' in update)) send({ t: 'room-update', update });
          break;
        }
        default:
          break; // 前向兼容
      }
    };

    ws.on('message', (raw: unknown) => onMessage(String(raw)));
    ws.on('close', () => detach());
  }

  /** 房间关闭：通知房间内客户端并释放对局（定时器/引擎/投影缓存）。 */
  public onRoomClosed(roomId: string): void {
    const peers = this.roomSockets.get(roomId);
    if (peers) {
      for (const socket of peers.values()) {
        if (socket.readyState === 1) socket.send(JSON.stringify({ t: 'match-state', roomId, closed: true }));
      }
    }
    this.roomSockets.delete(roomId);
    this.matches.close(roomId);
  }

  public dispose(): void {
    this.matches.closeAll();
    this.roomSockets.clear();
  }

  /** 供自检/运维观察的服务端对局概况。 */
  public stats(): { roomId: string; gameId: string; revision: number; seats: string[]; attached: string[] }[] {
    const out: { roomId: string; gameId: string; revision: number; seats: string[]; attached: string[] }[] = [];
    for (const roomId of this.roomSockets.keys()) {
      const match = this.matches.get(roomId);
      if (!match) continue;
      out.push({
        roomId,
        gameId: match.moduleId,
        revision: match.revision,
        seats: match.seatList().map(seat => `${seat.seat}:${seat.name}`),
        attached: match.attachedUsers()
      });
    }
    return out;
  }
}
