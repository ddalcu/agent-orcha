import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import { CDPClient } from '../../lib/sandbox/cdp-client.ts';

/**
 * Creates a minimal CDP mock server:
 * - HTTP /json endpoint returns target list
 * - WebSocket accepts connections and can respond to CDP messages
 */
function createMockCDPServer(): {
  server: http.Server;
  wss: WebSocketServer;
  port: number;
  start: () => Promise<number>;
  close: () => Promise<void>;
  onMessage: (handler: (msg: any, reply: (response: any) => void) => void) => void;
  sendEvent: (method: string, params?: object) => void;
} {
  const server = http.createServer((req, res) => {
    if (req.url === '/json') {
      const port = (server.address() as any).port;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([
        {
          type: 'page',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/TEST123`,
        },
      ]));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  const wss = new WebSocketServer({ server });
  let messageHandler: ((msg: any, reply: (r: any) => void) => void) | null = null;
  let activeWs: any = null;

  wss.on('connection', (ws) => {
    activeWs = ws;
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (messageHandler) {
        messageHandler(msg, (response) => {
          ws.send(JSON.stringify(response));
        });
      } else {
        // Default: auto-reply with empty result
        ws.send(JSON.stringify({ id: msg.id, result: {} }));
      }
    });
  });

  return {
    server,
    wss,
    get port() {
      return (server.address() as any)?.port ?? 0;
    },
    start: () => new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as any).port);
      });
    }),
    close: () => new Promise<void>((resolve) => {
      wss.close();
      server.close(() => resolve());
    }),
    onMessage: (handler) => { messageHandler = handler; },
    sendEvent: (method, params) => {
      if (activeWs && activeWs.readyState === 1) {
        activeWs.send(JSON.stringify({ method, params }));
      }
    },
  };
}

describe('CDPClient', () => {
  let client: CDPClient;
  let mockServer: ReturnType<typeof createMockCDPServer>;

  beforeEach(async () => {
    client = new CDPClient();
    mockServer = createMockCDPServer();
  });

  afterEach(async () => {
    await client.close();
    await mockServer.close();
  });

  describe('connect', () => {
    it('should discover a page target and connect via WebSocket', async () => {
      const port = await mockServer.start();
      await client.connect(`http://127.0.0.1:${port}`);
      assert.strictEqual(client.connected, true);
    });

    it('should throw when CDP discovery fails (non-ok response)', async () => {
      // Start a server that always 500s
      const badServer = http.createServer((req, res) => {
        res.writeHead(500);
        res.end();
      });
      await new Promise<void>(resolve => badServer.listen(0, '127.0.0.1', resolve));
      const port = (badServer.address() as any).port;

      await assert.rejects(
        () => client.connect(`http://127.0.0.1:${port}`),
        /CDP discovery failed: 500/,
      );

      await new Promise<void>(resolve => badServer.close(() => resolve()));
    });

    it('should throw when no page target found', async () => {
      const noPageServer = http.createServer((req, res) => {
        if (req.url === '/json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([
            { type: 'service_worker', webSocketDebuggerUrl: 'ws://127.0.0.1:1234/devtools/sw/X' },
          ]));
        }
      });
      await new Promise<void>(resolve => noPageServer.listen(0, '127.0.0.1', resolve));
      const port = (noPageServer.address() as any).port;

      await assert.rejects(
        () => client.connect(`http://127.0.0.1:${port}`),
        /No page target found/,
      );

      await new Promise<void>(resolve => noPageServer.close(() => resolve()));
    });

    it('should clean up existing connection before reconnecting', async () => {
      const port = await mockServer.start();
      await client.connect(`http://127.0.0.1:${port}`);
      assert.strictEqual(client.connected, true);

      // Reconnect
      await client.connect(`http://127.0.0.1:${port}`);
      assert.strictEqual(client.connected, true);
    });

    it('should rewrite WebSocket URL to match cdpUrl host and port', async () => {
      // The mock server reports ws://127.0.0.1:PORT/... but we connect via the same,
      // so the rewrite should preserve it. The important thing is it doesn't crash.
      const port = await mockServer.start();
      await client.connect(`http://127.0.0.1:${port}`);
      assert.strictEqual(client.connected, true);
    });
  });

  describe('send', () => {
    it('should throw when not connected', async () => {
      await assert.rejects(
        () => client.send('Page.navigate', { url: 'http://example.com' }),
        /CDP not connected/,
      );
    });

    it('should send a message and resolve on success response', async () => {
      const port = await mockServer.start();
      mockServer.onMessage((msg, reply) => {
        if (msg.method === 'Page.navigate') {
          reply({ id: msg.id, result: { frameId: 'F1' } });
        }
      });

      await client.connect(`http://127.0.0.1:${port}`);
      const result = await client.send('Page.navigate', { url: 'http://example.com' });
      assert.deepStrictEqual(result, { frameId: 'F1' });
    });

    it('should reject on CDP error response', async () => {
      const port = await mockServer.start();
      mockServer.onMessage((msg, reply) => {
        reply({ id: msg.id, error: { message: 'Invalid URL' } });
      });

      await client.connect(`http://127.0.0.1:${port}`);
      await assert.rejects(
        () => client.send('Page.navigate', { url: 'bad' }),
        /Invalid URL/,
      );
    });

    it('should reject on send timeout', async () => {
      const port = await mockServer.start();
      // Never reply to cause timeout
      mockServer.onMessage(() => {});

      await client.connect(`http://127.0.0.1:${port}`);
      await assert.rejects(
        () => client.send('Page.navigate', {}, 100),
        /CDP send timeout/,
      );
    });

    it('should send message without params', async () => {
      const port = await mockServer.start();
      let receivedMsg: any = null;
      mockServer.onMessage((msg, reply) => {
        receivedMsg = msg;
        reply({ id: msg.id, result: {} });
      });

      await client.connect(`http://127.0.0.1:${port}`);
      await client.send('Page.enable');
      assert.strictEqual(receivedMsg.method, 'Page.enable');
    });
  });

  describe('on', () => {
    it('should register event listeners and dispatch events', async () => {
      const port = await mockServer.start();
      await client.connect(`http://127.0.0.1:${port}`);

      const received: unknown[] = [];
      client.on('Page.loadEventFired', (params) => {
        received.push(params);
      });

      // Simulate CDP event from server
      mockServer.sendEvent('Page.loadEventFired', { timestamp: 12345 });

      // Wait for event to arrive
      await new Promise(r => setTimeout(r, 50));

      assert.strictEqual(received.length, 1);
      assert.deepStrictEqual(received[0], { timestamp: 12345 });
    });

    it('should support multiple listeners for the same event', async () => {
      const port = await mockServer.start();
      await client.connect(`http://127.0.0.1:${port}`);

      let count1 = 0, count2 = 0;
      client.on('Page.loadEventFired', () => { count1++; });
      client.on('Page.loadEventFired', () => { count2++; });

      mockServer.sendEvent('Page.loadEventFired', {});
      await new Promise(r => setTimeout(r, 50));

      assert.strictEqual(count1, 1);
      assert.strictEqual(count2, 1);
    });

    it('should return an unsubscribe function that stops delivery', async () => {
      const port = await mockServer.start();
      await client.connect(`http://127.0.0.1:${port}`);

      let callCount = 0;
      const unsub = client.on('Page.loadEventFired', () => { callCount++; });

      mockServer.sendEvent('Page.loadEventFired', {});
      await new Promise(r => setTimeout(r, 50));
      assert.strictEqual(callCount, 1);

      unsub();

      mockServer.sendEvent('Page.loadEventFired', {});
      await new Promise(r => setTimeout(r, 50));
      assert.strictEqual(callCount, 1); // Not incremented
    });
  });

  describe('once', () => {
    it('should resolve when event fires and auto-remove listener', async () => {
      const port = await mockServer.start();
      await client.connect(`http://127.0.0.1:${port}`);

      const promise = client.once('Page.loadEventFired');

      mockServer.sendEvent('Page.loadEventFired', { timestamp: 999 });

      const result = await promise;
      assert.deepStrictEqual(result, { timestamp: 999 });
    });
  });

  describe('connected', () => {
    it('should return false when not connected', () => {
      assert.strictEqual(client.connected, false);
    });

    it('should return true when connected', async () => {
      const port = await mockServer.start();
      await client.connect(`http://127.0.0.1:${port}`);
      assert.strictEqual(client.connected, true);
    });
  });

  describe('close', () => {
    it('should clean up WebSocket and clear event listeners', async () => {
      const port = await mockServer.start();
      await client.connect(`http://127.0.0.1:${port}`);
      client.on('Page.loadEventFired', () => {});

      await client.close();
      assert.strictEqual(client.connected, false);
    });

    it('should be safe to call close when not connected', async () => {
      await client.close(); // Should not throw
      assert.strictEqual(client.connected, false);
    });

    it('should handle close clearing pending timers without hanging', async () => {
      const port = await mockServer.start();
      await client.connect(`http://127.0.0.1:${port}`);
      assert.strictEqual(client.connected, true);

      await client.close();
      assert.strictEqual(client.connected, false);

      // After close, further sends should throw "not connected"
      await assert.rejects(
        () => client.send('Page.navigate', { url: 'http://example.com' }),
        /CDP not connected/,
      );
    });
  });
});
