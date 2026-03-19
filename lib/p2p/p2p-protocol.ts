import type { Duplex } from 'stream';
import type { P2PMessage } from './types.ts';

/**
 * NDJSON protocol handler over a Duplex stream.
 * Each message is a single JSON line terminated by \n.
 */
export class P2PProtocol {
  private buffer = '';
  private handlers = new Map<string, (msg: P2PMessage) => void>();
  private destroyed = false;
  private socket: Duplex;

  constructor(socket: Duplex) {
    this.socket = socket;
    socket.on('data', (data: Buffer) => this.onData(data));
    socket.on('error', () => this.destroy());
    socket.on('close', () => this.destroy());
  }

  on(type: string, handler: (msg: P2PMessage) => void): void {
    this.handlers.set(type, handler);
  }

  onAny(handler: (msg: P2PMessage) => void): void {
    this.handlers.set('*', handler);
  }

  send(message: P2PMessage): void {
    if (this.destroyed) return;
    try {
      this.socket.write(JSON.stringify(message) + '\n');
    } catch {
      // Socket may be closing
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.handlers.clear();
    try { this.socket.destroy(); } catch { /* ignore */ }
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  private onData(data: Buffer): void {
    this.buffer += data.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as P2PMessage;
        const typeHandler = this.handlers.get(msg.type);
        if (typeHandler) typeHandler(msg);
        const anyHandler = this.handlers.get('*');
        if (anyHandler) anyHandler(msg);
      } catch {
        // Ignore malformed messages
      }
    }
  }
}
