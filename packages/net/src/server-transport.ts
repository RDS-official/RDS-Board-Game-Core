import type { Action, PlayerId } from '@rds/kernel/types';
import type { RoomUpdate } from './room';

/**
 * rds-room/1 server-authoritative transport (centre mode).
 *
 * Reuses the SAME hub endpoint and URL contract as the P2P path
 * (`<hub>/ws?token=…` + `join-room`), and speaks the SAME `room-update`
 * payload shape, so the presenter consumes projections identically. The only
 * difference is where the authority lives: the server owns the single engine,
 * assigns the seat, and every client is a read/act client.
 *
 * Messages (see apps/server/src/matchBroker.ts):
 *   → { t: 'join-room', roomId }   (membership checked by the signaling hub)
 *   → { t: 'match-join', roomId }
 *   ← { t: 'match-seat', roomId, seat }
 *   ← { t: 'room-update', update }
 *   ← { t: 'error', message }
 *   → { t: 'match-submit', action } | { t: 'match-snapshot' } | { t: 'match-delta' }
 */

export interface ServerTransportHandlers {
  onUpdate?(update: RoomUpdate): void;
  onSeat?(seat: PlayerId): void;
  onError?(message: string): void;
  onClosed?(): void;
  onReconnecting?(attempt: number): void;
  onReconnected?(): void;
}

export class ServerMatchTransport {
  public seat?: PlayerId;
  public state: unknown = null;
  public revision = -1;

  private ws?: WebSocket;
  private handlers: ServerTransportHandlers = {};
  private disposed = false;
  private reconnecting = false;
  private joined = false;

  constructor(
    private readonly hubOrigin: string,
    private readonly roomId: string,
    private readonly token: string
  ) {}

  /** 归一化 hub 参数：可能是纯 origin，也可能是已含 /ws 的 ws URL（契约形态）。 */
  private url(): string {
    const base = this.hubOrigin.replace(/^http/, 'ws').replace(/\/$/, '');
    return (base.endsWith('/ws') ? base : base + '/ws') + '?token=' + encodeURIComponent(this.token);
  }

  public on(handlers: ServerTransportHandlers): void {
    this.handlers = { ...this.handlers, ...handlers };
  }

  /** 连接并加入服务端对局；返回服务器分配的座位。 */
  public connect(): Promise<{ seat: PlayerId }> {
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('transport disposed'));
        return;
      }
      let settled = false;
      const ws = new WebSocket(this.url());
      this.ws = ws;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      ws.onerror = () => fail(new Error('server match connection failed'));

      ws.onopen = () => {
        ws.send(JSON.stringify({ t: 'join-room', roomId: this.roomId }));
        ws.send(JSON.stringify({ t: 'match-join', roomId: this.roomId }));
      };

      ws.onmessage = ev => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String((ev as MessageEvent).data));
        } catch {
          return;
        }
        switch (msg.t) {
          case 'match-seat': {
            const seat = String(msg.seat ?? '') as PlayerId;
            this.seat = seat;
            this.handlers.onSeat?.(seat);
            if (!settled) {
              settled = true;
              this.joined = true;
              resolve({ seat });
            }
            break;
          }
          case 'room-update': {
            const update = msg.update as RoomUpdate;
            this.revision = update.revision;
            if (update.full || this.state === null) this.state = update.state ?? null;
            this.handlers.onUpdate?.(update);
            break;
          }
          case 'match-state': {
            if (msg.closed) {
              this.handlers.onClosed?.();
              break;
            }
            const seat = msg.seat ? (String(msg.seat) as PlayerId) : undefined;
            if (seat && seat !== this.seat) {
              this.seat = seat;
              this.handlers.onSeat?.(seat);
            }
            break;
          }
          case 'error': {
            const message = String(msg.message ?? 'server rejected');
            this.handlers.onError?.(message);
            if (!settled) fail(new Error(message));
            break;
          }
          default:
            break; // 前向兼容：忽略未知消息
        }
      };

      ws.onclose = () => {
        // 只有「当前这条」连接断开才触发重连；旧 socket 晚到的 close 忽略。
        if (this.ws !== ws) return;
        if (this.disposed) return;
        if (!settled) {
          fail(new Error('server match connection closed'));
          return;
        }
        this.joined = false;
        void this.reconnect();
      };
    });
  }

  public submit(action: Action): void {
    this.send({ t: 'match-submit', action });
  }

  public requestSnapshot(): void {
    this.send({ t: 'match-snapshot' });
  }

  public requestDelta(): void {
    this.send({ t: 'match-delta' });
  }

  public bye(): void {
    try {
      this.ws?.send(JSON.stringify({ t: 'bye' }));
      this.ws?.close();
    } catch {
      /* already gone */
    }
  }

  public close(): void {
    this.disposed = true;
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.ws = undefined;
  }

  private send(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== 1 || !this.joined) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch {
      /* dropped; reconnect path will resync */
    }
  }

  /**
   * 自动重连：服务端权威模式下客户端只是订阅者，重连后重新 join 即拿回全量投影，
   * 因此不需要像 P2P 那样担心房主侧的会话状态。
   */
  private async reconnect(): Promise<void> {
    if (this.disposed || this.reconnecting) return;
    this.reconnecting = true;
    try {
      for (let attempt = 1; attempt <= 40; attempt++) {
        await new Promise(r => setTimeout(r, 2000));
        if (this.disposed) return;
        this.handlers.onReconnecting?.(attempt);
        try {
          await this.connect();
          this.reconnecting = false;
          this.handlers.onReconnected?.();
          return;
        } catch {
          /* 继续下一次 */
        }
      }
      this.handlers.onError?.('与服务器的连接已断开，自动重连失败');
    } finally {
      this.reconnecting = false;
    }
  }
}
