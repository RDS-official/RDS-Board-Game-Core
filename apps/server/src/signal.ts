/** WebSocket 信令：房间组 + SDP/ICE 盲转发 + 大厅实时频道。不接触游戏数据。 */
import type { WebSocket } from 'ws';
import { verifyJwt, profileOf } from './auth.ts';
import type { HubRoomInfo, SignalMessage } from '@rds/room-protocol';

interface Client { userId: string; name: string; ws: WebSocket; roomId?: string; alive: boolean; lobby: boolean; }

export class SignalHub {
  private clients = new Set<Client>();

  accept(ws: WebSocket, token: string | null) {
    const payload = token ? verifyJwt(token) : null;
    if (!payload) { ws.close(4001, 'unauthorized'); return; }
    const client: Client = { userId: payload.sub, name: payload.name, ws, alive: true, lobby: false };
    // 同一用户新连接顶掉旧连接（页面重载/大厅→对局切换时旧 ws 可能未及时关闭，
    // 尤其经代理时服务端收不到 close；旧连接残留在房间组会让 SDP offer 发给死端）
    for (const c of [...this.clients]) {
      if (c.userId === client.userId && c.ws !== ws) {
        this.clients.delete(c);
        if (c.roomId) {
          this.broadcastRoom(c.roomId, { t: 'peer-leave', peerId: c.userId });
          this.broadcastPresence(c.roomId);
        }
        c.ws.terminate();
      }
    }
    this.clients.add(client);
    ws.on('pong', () => { client.alive = true; });
    ws.on('message', raw => this.onMessage(client, raw.toString()));
    ws.on('close', () => this.drop(client));
  }

  private drop(client: Client) {
    this.clients.delete(client);
    if (client.roomId) {
      const roomId = client.roomId;
      this.broadcastRoom(roomId, { t: 'peer-leave', peerId: client.userId }, client.userId);
      this.broadcastPresence(roomId);
    }
  }

  private onMessage(client: Client, text: string) {
    let msg: SignalMessage;
    try { msg = JSON.parse(text); } catch { return; }
    switch (msg.t) {
      case 'join-room': {
        if (client.roomId) this.dropFromRoom(client);
        client.roomId = msg.roomId;
        const peers = [...this.clients]
          .filter(c => c.roomId === msg.roomId && c !== client)
          .map(c => c.userId);
        this.send(client, { t: 'hello', selfId: client.userId, peers });
        this.broadcastRoom(msg.roomId, { t: 'peer-join', peerId: client.userId }, client.userId);
        this.broadcastPresence(msg.roomId);
        break;
      }
      case 'leave-room':
        this.dropFromRoom(client);
        break;
      case 'sdp':
      case 'ice': {
        const target = this.peerInRoom(client.roomId, msg.to);
        if (target) this.send(target, { ...msg, from: client.userId } as SignalMessage);
        break;
      }
      // ---- 大厅实时频道（Phase B） ----
      case 'lobby-sub': client.lobby = true; break;
      case 'lobby-unsub': client.lobby = false; break;
      case 'lobby-chat': {
        // 只做群内转发（房间组成员 + 发送者），不落盘、不鉴权成员资格（房间页只把
        // 自己 join-room 进组；游戏对局的 ws 连接不受影响——它不处理 lobby-chat）。
        if (!msg.roomId || typeof msg.text !== 'string' || !msg.text.trim()) return;
        const trimmed = msg.text.trim().slice(0, 200);
        const chatName = profileOf(client.userId)?.displayName ?? client.name;
        const payload: SignalMessage = { t: 'lobby-chat', roomId: msg.roomId, from: client.userId, name: chatName, text: trimmed, at: Date.now() };
        for (const c of this.clients) {
          if (c.roomId === msg.roomId) this.send(c, payload);
        }
        break;
      }
      default: break; // 未知消息忽略（前向兼容）
    }
  }

  /** 房间字段变化 → 房间组成员 + 大厅订阅者。阶段二：closed 也推给房内成员，让对局中的玩家知道对局已结束。 */
  broadcastRoomUpdate(room: HubRoomInfo): void {
    const msg: SignalMessage = { t: 'room-updated', room };
    for (const c of this.clients) {
      if (c.lobby || c.roomId === room.id) this.send(c, msg);
    }
  }

  private dropFromRoom(client: Client) {
    if (!client.roomId) return;
    const roomId = client.roomId;
    client.roomId = undefined;
    this.broadcastRoom(roomId, { t: 'peer-leave', peerId: client.userId }, client.userId);
    this.broadcastPresence(roomId);
  }

  /** 阶段三：某房间当前在线（去重 userId）。供 rooms.ts 回收清扫查询。 */
  onlineUsers(roomId: string): string[] {
    return [...new Set([...this.clients].filter(c => c.roomId === roomId).map(c => c.userId))];
  }

  /** Phase 2: deduped online userIds of a room group, pushed to every member. */
  private broadcastPresence(roomId: string): void {
    const online = [...new Set([...this.clients].filter(c => c.roomId === roomId).map(c => c.userId))];
    this.broadcastRoom(roomId, { t: 'presence', roomId, online });
  }

  private peerInRoom(roomId: string | undefined, userId: string) {
    if (!roomId) return undefined;
    return [...this.clients].find(c => c.roomId === roomId && c.userId === userId);
  }

  private broadcastRoom(roomId: string, msg: SignalMessage, except?: string) {
    for (const c of this.clients) {
      if (c.roomId === roomId && c.userId !== except) this.send(c, msg);
    }
  }

  private send(c: Client, msg: SignalMessage) {
    if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
  }

  /** 心动检测：30s 一次，两次无 pong 踢掉。 */
  startHeartbeat(intervalMs = 30000) {
    setInterval(() => {
      for (const c of this.clients) {
        if (!c.alive) { c.ws.terminate(); continue; }
        c.alive = false;
        c.ws.ping();
      }
    }, intervalMs);
  }
}
