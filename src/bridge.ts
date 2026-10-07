/** TCP 客户端：连游戏内插件（docs/protocol.md），断线后按固定间隔重连，直到 close()。 */
import { createConnection, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import type { GameEvent, GameState, Item } from './state.ts';

export const PROTOCOL = 1;
const RECONNECT_MS = 2000;

export interface Hello {
  t: 'hello';
  protocol: number;
  version: string;
}

export interface Reply {
  t: 'reply';
  id: number;
  ok: boolean;
  /** 失败原因，一句中文；`{item}` 指 item 字段的物品，`{by}` 指 by 字段的厨师身份。 */
  why?: string;
  item?: Item;
  by?: string;
  /** 这一步结束时 bot 手里的东西。 */
  held?: Item;
  /** put 放进去的容器在放进之后的样子。 */
  into?: Item;
  delivered?: boolean;
  washed?: number;
  left?: number;
  state?: string;
  /** go 的目标格是站点时，那个站点的 id。 */
  station?: number;
  png?: string;
}

type Frame = Hello | Reply | ({ t: 'state' } & GameState) | ({ t: 'ev' } & GameEvent);

/** 事件：`hello`(Hello)、`state`(GameState)、`ev`(GameEvent)、`disconnect`()。 */
export class GameBridge extends EventEmitter {
  private socket: Socket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private closed = true;
  private retry: NodeJS.Timeout | null = null;
  hello: Hello | null = null;

  get connected(): boolean {
    return this.hello !== null;
  }

  open(port: number): void {
    this.closed = false;
    this.dial(port);
  }

  close(): void {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.drop(new Error('bridge closed'));
  }

  request(payload: Record<string, unknown>, timeoutMs: number): Promise<Reply> {
    const socket = this.socket;
    if (!socket || !this.hello) return Promise.reject(new Error('游戏未连接'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`游戏 ${Math.round(timeoutMs / 1000)} 秒内没有回复 ${String(payload.op)}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(`${JSON.stringify({ ...payload, id })}\n`);
    });
  }

  private dial(port: number): void {
    if (this.closed) return;
    const socket = createConnection({ host: '127.0.0.1', port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line) this.receive(JSON.parse(line) as Frame);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (this.socket !== socket) return;
      const wasConnected = this.hello !== null;
      this.drop(new Error('游戏连接已断开'));
      if (wasConnected) this.emit('disconnect');
      if (!this.closed) this.retry = setTimeout(() => this.dial(port), RECONNECT_MS);
    });
  }

  private drop(error: Error): void {
    const socket = this.socket;
    this.socket = null;
    this.hello = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    socket?.destroy();
  }

  private receive(frame: Frame): void {
    if (frame.t === 'hello') {
      if (frame.protocol !== PROTOCOL) {
        this.emit('mismatch', frame);
        return;
      }
      this.hello = frame;
      this.emit('hello', frame);
    } else if (!this.hello) {
      return;
    } else if (frame.t === 'reply') {
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      clearTimeout(p.timer);
      p.resolve(frame);
    } else if (frame.t === 'state') {
      const { t: _t, ...state } = frame;
      this.emit('state', state as GameState);
    } else if (frame.t === 'ev') {
      const { t: _t, ...event } = frame;
      this.emit('ev', event as GameEvent);
    }
  }
}
