import WebSocket from 'ws';

interface CDPTarget {
  webSocketDebuggerUrl: string;
  type: string;
}

const DEFAULT_SEND_TIMEOUT = 20_000;

export class CDPClient {
  private ws: WebSocket | null = null;
  private msgId = 0;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private eventListeners = new Map<string, ((params: unknown) => void)[]>();

  async connect(cdpUrl: string): Promise<void> {
    // Clean up any existing connection before reconnecting
    if (this.ws) {
      this.cleanup();
    }

    const httpUrl = cdpUrl.replace(/\/$/, '');
    const res = await fetch(`${httpUrl}/json`);
    if (!res.ok) throw new Error(`CDP discovery failed: ${res.status}`);

    const targets: CDPTarget[] = await res.json() as CDPTarget[];
    const page = targets.find(t => t.type === 'page');
    if (!page?.webSocketDebuggerUrl) {
      throw new Error('No page target found');
    }

    // Rewrite the discovered WebSocket URL to match the CDP URL we connected to.
    // When proxied (e.g. socat), Chromium reports its internal address which may not
    // be reachable from the host. Replace host:port with the one from cdpUrl.
    const cdpParsed = new URL(httpUrl);
    const wsParsed = new URL(page.webSocketDebuggerUrl);
    wsParsed.hostname = cdpParsed.hostname;
    wsParsed.port = cdpParsed.port;
    const wsUrl = wsParsed.toString();

    await this.connectWs(wsUrl);
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
            clearTimeout(handler.timer);
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
          clearTimeout(handler.timer);
          handler.reject(new Error('CDP connection closed'));
        }
        this.pending.clear();
      });
    });
  }

  async send(method: string, params?: object, timeout = DEFAULT_SEND_TIMEOUT): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('CDP not connected');
    }

    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP send timeout: ${method} (${timeout}ms)`));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });
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

  private cleanup(): void {
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    for (const [, handler] of this.pending) {
      clearTimeout(handler.timer);
    }
    this.pending.clear();
  }

  async close(): Promise<void> {
    this.cleanup();
    this.eventListeners.clear();
  }
}
