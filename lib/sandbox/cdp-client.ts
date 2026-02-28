import WebSocket from 'ws';

interface CDPTarget {
  webSocketDebuggerUrl: string;
  type: string;
}

export class CDPClient {
  private ws: WebSocket | null = null;
  private msgId = 0;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private eventListeners = new Map<string, ((params: unknown) => void)[]>();

  async connect(cdpUrl: string): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    const httpUrl = cdpUrl.replace(/\/$/, '');
    const res = await fetch(`${httpUrl}/json`);
    if (!res.ok) throw new Error(`CDP discovery failed: ${res.status}`);

    const targets: CDPTarget[] = await res.json() as CDPTarget[];
    const page = targets.find(t => t.type === 'page');
    if (!page?.webSocketDebuggerUrl) {
      throw new Error('No page target found');
    }

    await this.connectWs(page.webSocketDebuggerUrl);
  }

  private connectWs(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('CDP WebSocket connection timeout'));
      }, 10_000);

      ws.on('open', () => {
        clearTimeout(timeout);
        this.ws = ws;
        resolve();
      });

      ws.on('message', (data: WebSocket.Data) => {
        const msg = JSON.parse(data.toString());
        if ('id' in msg) {
          const handler = this.pending.get(msg.id);
          if (handler) {
            this.pending.delete(msg.id);
            if (msg.error) {
              handler.reject(new Error(msg.error.message));
            } else {
              handler.resolve(msg.result);
            }
          }
        } else if ('method' in msg) {
          const listeners = this.eventListeners.get(msg.method);
          if (listeners) {
            for (const fn of listeners) fn(msg.params);
          }
        }
      });

      ws.on('error', (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });

      ws.on('close', () => {
        this.ws = null;
        for (const [, handler] of this.pending) {
          handler.reject(new Error('CDP connection closed'));
        }
        this.pending.clear();
      });
    });
  }

  async send(method: string, params?: object): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('CDP not connected');
    }

    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, handler: (params: unknown) => void): () => void {
    const listeners = this.eventListeners.get(event) ?? [];
    listeners.push(handler);
    this.eventListeners.set(event, listeners);
    return () => {
      const idx = listeners.indexOf(handler);
      if (idx >= 0) listeners.splice(idx, 1);
    };
  }

  once(event: string): Promise<unknown> {
    return new Promise(resolve => {
      const listeners = this.eventListeners.get(event) ?? [];
      const handler = (params: unknown) => {
        const idx = listeners.indexOf(handler);
        if (idx >= 0) listeners.splice(idx, 1);
        resolve(params);
      };
      listeners.push(handler);
      this.eventListeners.set(event, listeners);
    });
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async close(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.pending.clear();
    this.eventListeners.clear();
  }
}
