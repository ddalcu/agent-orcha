import { describe, it, afterEach, beforeEach, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { EventEmitter } from 'node:events';
import { vncRoutes } from '../../src/routes/vnc.route.ts';
import type { VncRouteDeps } from '../../src/routes/vnc.route.ts';

// ─── Mock WebSocket classes ─────────────────────────────────────────────────

class MockWebSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  protocol = '';
  send = mock.fn();
  close = mock.fn();
  url: string | undefined;
  opts: any;

  constructor(url?: string, opts?: any) {
    super();
    this.url = url;
    this.opts = opts;
  }
}

// ─── No-op fastify-static replacement ────────────────────────────────────────

const fakeStaticPlugin: any = async function () { /* no-op */ };
fakeStaticPlugin[Symbol.for('skip-override')] = true;
fakeStaticPlugin[Symbol.for('fastify.display-name')] = 'fastify-static-mock';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let lastCreatedTargetWs: MockWebSocket | undefined;
let lastWssInstance: any;

function createMockWSS() {
  return class MockWSS extends EventEmitter {
    handleUpgrade: any;

    constructor(_opts?: any) {
      super();
      lastWssInstance = this;
      this.handleUpgrade = mock.fn(
        (_req: any, _socket: any, _head: any, cb: (ws: any) => void) => {
          const clientWs = new MockWebSocket();
          (this as any)._lastClientWs = clientWs;
          cb(clientWs);
        },
      );
    }
  };
}

function createTrackedWebSocket() {
  const cls = class TrackedMockWebSocket extends MockWebSocket {
    constructor(url?: string, opts?: any) {
      super(url, opts);
      lastCreatedTargetWs = this;
    }
  } as any;
  cls.OPEN = 1;
  return cls;
}

function makeDeps(overrides: Partial<VncRouteDeps> = {}): VncRouteDeps {
  return {
    existsSync: overrides.existsSync ?? (() => false),
    WebSocketServerClass: overrides.WebSocketServerClass ?? createMockWSS(),
    WebSocketClass: overrides.WebSocketClass ?? createTrackedWebSocket(),
    staticPlugin: overrides.staticPlugin ?? fakeStaticPlugin,
  };
}

async function buildApp(deps: VncRouteDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // VNC route accesses fastify.orchestrator.sandbox.getStatus()
  app.decorate('orchestrator', {
    sandbox: {
      getStatus: () => ({ status: 'idle', error: null }),
    },
  });
  await app.register(vncRoutes, makeDeps(deps));
  await app.ready();
  return app;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('vnc.route', () => {
  let app: FastifyInstance | undefined;
  const originalEnv = process.env['BROWSER_SANDBOX'];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    delete process.env['BROWSER_SANDBOX'];
    lastCreatedTargetWs = undefined;
    lastWssInstance = undefined;
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    if (originalEnv !== undefined) {
      process.env['BROWSER_SANDBOX'] = originalEnv;
    } else {
      delete process.env['BROWSER_SANDBOX'];
    }
    globalThis.fetch = originalFetch;
  });

  // ── GET /api/vnc/status ──────────────────────────────────────────────────

  describe('GET /api/vnc/status', () => {
    it('should return enabled=false when not in container and no external sandbox', async () => {
      globalThis.fetch = mock.fn(async () => {
        throw new Error('connection refused');
      }) as any;

      app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/api/vnc/status' });
      assert.equal(res.statusCode, 200);

      const body = JSON.parse(res.payload);
      assert.equal(body.enabled, false);
      assert.equal(body.mode, undefined);
      assert.equal(body.url, undefined);
    });

    it('should return external mode when sandbox container is available', async () => {
      globalThis.fetch = mock.fn(async () => ({ ok: true })) as any;

      app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/api/vnc/status' });
      assert.equal(res.statusCode, 200);

      const body = JSON.parse(res.payload);
      assert.equal(body.enabled, true);
      assert.equal(body.mode, 'external');
      assert.equal(body.url, 'http://localhost:6080/vnc.html?autoconnect=true');
    });

    it('should return enabled=false when external sandbox returns non-ok', async () => {
      globalThis.fetch = mock.fn(async () => ({ ok: false })) as any;

      app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/api/vnc/status' });
      assert.equal(res.statusCode, 200);

      const body = JSON.parse(res.payload);
      assert.equal(body.enabled, false);
    });

    it('should return embedded mode when in container with local noVNC', async () => {
      process.env['BROWSER_SANDBOX'] = 'true';

      app = await buildApp({ existsSync: () => true });
      const res = await app.inject({ method: 'GET', url: '/api/vnc/status' });
      assert.equal(res.statusCode, 200);

      const body = JSON.parse(res.payload);
      assert.equal(body.enabled, true);
      assert.equal(body.mode, 'embedded');
      assert.equal(body.url, '/vnc/vnc.html?autoconnect=true&path=websockify');
    });

    it('should not call fetch when inContainer is true (sandboxContainerAvailable short-circuits)', async () => {
      process.env['BROWSER_SANDBOX'] = 'true';

      const fetchMock = mock.fn(async () => {
        throw new Error('should not be called');
      });
      globalThis.fetch = fetchMock as any;

      app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/api/vnc/status' });
      assert.equal(res.statusCode, 200);

      const body = JSON.parse(res.payload);
      assert.equal(body.enabled, false);
      assert.equal(fetchMock.mock.callCount(), 0);
    });
  });

  // ── Early return (not in container) ──────────────────────────────────────

  describe('early return — not in container', () => {
    it('should not register /vnc redirect route', async () => {
      app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/vnc' });
      assert.equal(res.statusCode, 404);
    });

    it('should not register /vnc when inContainer but no local noVNC', async () => {
      process.env['BROWSER_SANDBOX'] = 'true';

      app = await buildApp({ existsSync: () => false });
      const res = await app.inject({ method: 'GET', url: '/vnc' });
      assert.equal(res.statusCode, 404);
    });
  });

  // ── In-container routes ──────────────────────────────────────────────────

  describe('in-container (BROWSER_SANDBOX=true, noVNC present)', () => {
    beforeEach(() => {
      process.env['BROWSER_SANDBOX'] = 'true';
    });

    function buildContainerApp() {
      return buildApp({ existsSync: () => true });
    }

    it('GET /vnc should redirect to vnc.html', async () => {
      app = await buildContainerApp();
      const res = await app.inject({ method: 'GET', url: '/vnc' });
      assert.equal(res.statusCode, 302);
      assert.equal(
        res.headers['location'],
        '/vnc/vnc.html?autoconnect=true&path=websockify',
      );
    });

    it('should set up WebSocket upgrade handler on the server', async () => {
      app = await buildContainerApp();
      const upgradeListeners = app.server.listeners('upgrade');
      assert.ok(upgradeListeners.length > 0, 'should have upgrade listeners');
    });

    it('upgrade handler should ignore non-/websockify requests', async () => {
      app = await buildContainerApp();

      const socket = new EventEmitter();
      const req = { url: '/other-path' };

      app.server.emit('upgrade', req, socket, Buffer.alloc(0));

      assert.equal(lastCreatedTargetWs, undefined);
    });

    it('upgrade handler should create target WebSocket on /websockify', async () => {
      app = await buildContainerApp();

      const socket = new EventEmitter();
      const req = { url: '/websockify' };

      app.server.emit('upgrade', req, socket, Buffer.alloc(0));

      assert.ok(lastCreatedTargetWs, 'target WS should be created');
      assert.ok(
        lastCreatedTargetWs.url?.includes('6080'),
        'target should connect to websockify port',
      );
    });

    it('should forward client messages to target after target opens', async () => {
      app = await buildContainerApp();

      const socket = new EventEmitter();
      const req = { url: '/websockify' };
      app.server.emit('upgrade', req, socket, Buffer.alloc(0));

      const targetWs = lastCreatedTargetWs!;
      const clientWs = lastWssInstance._lastClientWs as MockWebSocket;
      assert.ok(targetWs);
      assert.ok(clientWs);

      targetWs.emit('open');

      const msgData = Buffer.from('hello');
      clientWs.emit('message', msgData, true);

      assert.equal(targetWs.send.mock.callCount(), 1);
      const [sentData, sentOpts] = targetWs.send.mock.calls[0].arguments;
      assert.deepEqual(sentData, msgData);
      assert.deepEqual(sentOpts, { binary: true });
    });

    it('should forward target messages to client after target opens', async () => {
      app = await buildContainerApp();

      const socket = new EventEmitter();
      const req = { url: '/websockify' };
      app.server.emit('upgrade', req, socket, Buffer.alloc(0));

      const targetWs = lastCreatedTargetWs!;
      const clientWs = lastWssInstance._lastClientWs as MockWebSocket;

      targetWs.emit('open');

      const msgData = Buffer.from('world');
      targetWs.emit('message', msgData, false);

      assert.equal(clientWs.send.mock.callCount(), 1);
      const [sentData, sentOpts] = clientWs.send.mock.calls[0].arguments;
      assert.deepEqual(sentData, msgData);
      assert.deepEqual(sentOpts, { binary: false });
    });

    it('should not forward client message if target is not open', async () => {
      app = await buildContainerApp();

      const socket = new EventEmitter();
      const req = { url: '/websockify' };
      app.server.emit('upgrade', req, socket, Buffer.alloc(0));

      const targetWs = lastCreatedTargetWs!;
      const clientWs = lastWssInstance._lastClientWs as MockWebSocket;

      targetWs.readyState = 3; // CLOSED

      targetWs.emit('open');
      clientWs.emit('message', Buffer.from('data'), false);

      assert.equal(targetWs.send.mock.callCount(), 0);
    });

    it('should not forward target message if client is not open', async () => {
      app = await buildContainerApp();

      const socket = new EventEmitter();
      const req = { url: '/websockify' };
      app.server.emit('upgrade', req, socket, Buffer.alloc(0));

      const targetWs = lastCreatedTargetWs!;
      const clientWs = lastWssInstance._lastClientWs as MockWebSocket;

      clientWs.readyState = 3; // CLOSED

      targetWs.emit('open');
      targetWs.emit('message', Buffer.from('data'), false);

      assert.equal(clientWs.send.mock.callCount(), 0);
    });

    it('should close target when client closes', async () => {
      app = await buildContainerApp();

      const socket = new EventEmitter();
      const req = { url: '/websockify' };
      app.server.emit('upgrade', req, socket, Buffer.alloc(0));

      const targetWs = lastCreatedTargetWs!;
      const clientWs = lastWssInstance._lastClientWs as MockWebSocket;

      clientWs.emit('close');
      assert.equal(targetWs.close.mock.callCount(), 1);
    });

    it('should close client when target closes', async () => {
      app = await buildContainerApp();

      const socket = new EventEmitter();
      const req = { url: '/websockify' };
      app.server.emit('upgrade', req, socket, Buffer.alloc(0));

      const targetWs = lastCreatedTargetWs!;
      const clientWs = lastWssInstance._lastClientWs as MockWebSocket;

      targetWs.emit('close');
      assert.equal(clientWs.close.mock.callCount(), 1);
    });

    it('should close target when client errors', async () => {
      app = await buildContainerApp();

      const socket = new EventEmitter();
      const req = { url: '/websockify' };
      app.server.emit('upgrade', req, socket, Buffer.alloc(0));

      const targetWs = lastCreatedTargetWs!;
      const clientWs = lastWssInstance._lastClientWs as MockWebSocket;

      clientWs.emit('error', new Error('client error'));
      assert.equal(targetWs.close.mock.callCount(), 1);
    });

    it('should close client when target errors', async () => {
      app = await buildContainerApp();

      const socket = new EventEmitter();
      const req = { url: '/websockify' };
      app.server.emit('upgrade', req, socket, Buffer.alloc(0));

      const targetWs = lastCreatedTargetWs!;
      const clientWs = lastWssInstance._lastClientWs as MockWebSocket;

      targetWs.emit('error', new Error('target error'));
      assert.equal(clientWs.close.mock.callCount(), 1);
    });
  });
});
