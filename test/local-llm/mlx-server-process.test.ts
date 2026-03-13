import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'events';

// ── Mutable state that module-level mocks delegate to ──

let existsSyncFn: (p: string) => boolean;
let mkdirSyncFn: (...args: any[]) => void;
let writeFileSyncFn: (...args: any[]) => void;
let readFileSyncFn: (...args: any[]) => string;
let readdirSyncFn: (...args: any[]) => string[];
let unlinkSyncFn: (...args: any[]) => void;
let spawnFn: (...args: any[]) => any;
let getMlxBinaryPathFn: (...args: any[]) => Promise<string>;
let processKillFn: (pid: number, signal?: string | number) => boolean;

// ── Module mocks ──

mock.module('child_process', {
  namedExports: {
    spawn: (...args: any[]) => spawnFn(...args),
  },
});

mock.module('fs', {
  namedExports: {
    existsSync: (p: string) => existsSyncFn(p),
    mkdirSync: (...args: any[]) => mkdirSyncFn(...args),
    writeFileSync: (...args: any[]) => writeFileSyncFn(...args),
    readFileSync: (...args: any[]) => readFileSyncFn(...args),
    readdirSync: (...args: any[]) => readdirSyncFn(...args),
    unlinkSync: (...args: any[]) => unlinkSyncFn(...args),
  },
});

mock.module('net', {
  namedExports: {
    createServer: () => {
      const server = new EventEmitter() as any;
      server.listen = (_port: number, _host: string, cb: () => void) => {
        server.address = () => ({ port: _port });
        cb();
      };
      server.close = (cb: () => void) => cb();
      return server;
    },
  },
});

mock.module('../../lib/logger.ts', {
  namedExports: {
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  },
});

mock.module('../../lib/local-llm/mlx-binary-manager.ts', {
  namedExports: {
    getMlxBinaryPath: (...args: any[]) => getMlxBinaryPathFn(...args),
  },
});

// Import after mocks
const { MlxServerProcess, killOrphanedMlxServers } = await import('../../lib/local-llm/mlx-server-process.ts');

// ── Helpers ──

function createMockProc() {
  const proc = new EventEmitter() as any;
  proc.pid = 54321;
  proc.kill = mock.fn(() => true);
  proc.stderr = new EventEmitter();
  proc.stdout = null;
  proc.stdin = null;
  return proc;
}

let origKill: typeof process.kill;

describe('MlxServerProcess', () => {
  beforeEach(() => {
    existsSyncFn = () => false;
    mkdirSyncFn = () => {};
    writeFileSyncFn = () => {};
    readFileSyncFn = () => '{}';
    readdirSyncFn = () => [];
    unlinkSyncFn = () => {};
    spawnFn = () => createMockProc();
    getMlxBinaryPathFn = async () => '/usr/bin/mlx-serve';
    origKill = process.kill;
  });

  afterEach(() => {
    process.kill = origKill;
  });

  describe('constructor and getters', () => {
    it('should initialize with default values', () => {
      const server = new MlxServerProcess('/base');
      assert.strictEqual(server.port, 0);
      assert.strictEqual(server.modelPath, '');
      assert.strictEqual(server.running, false);
      assert.strictEqual(server.ready, false);
    });

    it('should accept custom role', () => {
      const server = new MlxServerProcess('/base', 'embedding');
      assert.strictEqual(server.port, 0);
      assert.strictEqual(server.running, false);
    });
  });

  describe('getBaseUrl', () => {
    it('should return correct URL format', () => {
      const server = new MlxServerProcess('/base');
      assert.strictEqual(server.getBaseUrl(), 'http://127.0.0.1:0');
    });
  });

  describe('stop', () => {
    it('should return immediately when no process is running', async () => {
      const server = new MlxServerProcess('/base');
      await server.stop(); // should not throw
      assert.strictEqual(server.running, false);
    });
  });

  describe('start', () => {
    it('should spawn process with correct arguments', async () => {
      const mockProc = createMockProc();
      let capturedArgs: string[] = [];
      let capturedBinary = '';

      spawnFn = (binary: string, args: string[]) => {
        capturedBinary = binary;
        capturedArgs = args;
        return mockProc;
      };

      const origFetch = globalThis.fetch;
      globalThis.fetch = async (url: any) => {
        if (String(url).includes('/health')) {
          return { ok: true, json: async () => ({ status: 'ok' }) } as any;
        }
        return origFetch(url);
      };

      const server = new MlxServerProcess('/base');
      await server.start({ modelPath: '/models/test-model', port: 9990 });

      assert.strictEqual(capturedBinary, '/usr/bin/mlx-serve');
      assert.ok(capturedArgs.includes('--model'));
      assert.ok(capturedArgs.includes('/models/test-model'));
      assert.ok(capturedArgs.includes('--serve'));
      assert.ok(capturedArgs.includes('--host'));
      assert.ok(capturedArgs.includes('127.0.0.1'));
      assert.ok(capturedArgs.includes('--port'));
      assert.ok(capturedArgs.includes('9990'));
      assert.strictEqual(server.running, true);
      assert.strictEqual(server.ready, true);
      assert.strictEqual(server.port, 9990);
      assert.strictEqual(server.modelPath, '/models/test-model');

      globalThis.fetch = origFetch;
      mockProc.emit('exit');
    });

    it('should include contextSize when provided', async () => {
      const mockProc = createMockProc();
      let capturedArgs: string[] = [];

      spawnFn = (_binary: string, args: string[]) => {
        capturedArgs = args;
        return mockProc;
      };

      const origFetch = globalThis.fetch;
      globalThis.fetch = async (url: any) => {
        if (String(url).includes('/health')) {
          return { ok: true, json: async () => ({ status: 'ok' }) } as any;
        }
        return origFetch(url);
      };

      const server = new MlxServerProcess('/base');
      await server.start({ modelPath: '/models/test', port: 9990, contextSize: 8192 });

      assert.ok(capturedArgs.includes('--ctx-size'));
      assert.ok(capturedArgs.includes('8192'));

      globalThis.fetch = origFetch;
      mockProc.emit('exit');
    });

    it('should include reasoningBudget when provided', async () => {
      const mockProc = createMockProc();
      let capturedArgs: string[] = [];

      spawnFn = (_binary: string, args: string[]) => {
        capturedArgs = args;
        return mockProc;
      };

      const origFetch = globalThis.fetch;
      globalThis.fetch = async (url: any) => {
        if (String(url).includes('/health')) {
          return { ok: true, json: async () => ({ status: 'ok' }) } as any;
        }
        return origFetch(url);
      };

      const server = new MlxServerProcess('/base');
      await server.start({ modelPath: '/models/test', port: 9990, reasoningBudget: 500 });

      assert.ok(capturedArgs.includes('--reasoning-budget'));
      assert.ok(capturedArgs.includes('500'));

      globalThis.fetch = origFetch;
      mockProc.emit('exit');
    });

    it('should not include optional args when not provided', async () => {
      const mockProc = createMockProc();
      let capturedArgs: string[] = [];

      spawnFn = (_binary: string, args: string[]) => {
        capturedArgs = args;
        return mockProc;
      };

      const origFetch = globalThis.fetch;
      globalThis.fetch = async (url: any) => {
        if (String(url).includes('/health')) {
          return { ok: true, json: async () => ({ status: 'ok' }) } as any;
        }
        return origFetch(url);
      };

      const server = new MlxServerProcess('/base');
      await server.start({ modelPath: '/models/test', port: 9990 });

      assert.ok(!capturedArgs.includes('--ctx-size'));
      assert.ok(!capturedArgs.includes('--reasoning-budget'));

      globalThis.fetch = origFetch;
      mockProc.emit('exit');
    });

    it('should stop existing process before starting new one', async () => {
      const mockProc1 = createMockProc();
      const mockProc2 = createMockProc();
      let spawnCount = 0;

      spawnFn = () => {
        spawnCount++;
        return spawnCount === 1 ? mockProc1 : mockProc2;
      };

      const origFetch = globalThis.fetch;
      globalThis.fetch = async (url: any) => {
        if (String(url).includes('/health')) {
          return { ok: true, json: async () => ({ status: 'ok' }) } as any;
        }
        return origFetch(url);
      };

      const server = new MlxServerProcess('/base');
      await server.start({ modelPath: '/models/test1', port: 9990 });

      // Make exit fire for stop
      const origOn = mockProc1.on.bind(mockProc1);
      mockProc1.on = ((event: string, cb: () => void) => {
        if (event === 'exit') setTimeout(cb, 0);
        return origOn(event, cb);
      }) as any;

      await server.start({ modelPath: '/models/test2', port: 9991 });
      assert.strictEqual(server.modelPath, '/models/test2');
      assert.strictEqual(spawnCount, 2);

      globalThis.fetch = origFetch;
      mockProc2.emit('exit');
    });

    it('should throw when process exits during startup', async () => {
      const mockProc = createMockProc();
      spawnFn = () => mockProc;

      const origFetch = globalThis.fetch;
      let fetchCount = 0;
      globalThis.fetch = async () => {
        fetchCount++;
        if (fetchCount === 1) {
          mockProc.emit('exit');
        }
        throw new Error('connection refused');
      };

      const server = new MlxServerProcess('/base');
      await assert.rejects(
        () => server.start({ modelPath: '/models/test', port: 9990 }),
        { message: 'mlx-serve process exited during startup' },
      );

      globalThis.fetch = origFetch;
    });

    it('should log stderr when startup fails', async () => {
      const mockProc = createMockProc();
      spawnFn = () => mockProc;

      const origFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        mockProc.stderr.emit('data', Buffer.from('Model not found'));
        mockProc.emit('exit');
        throw new Error('connection refused');
      };

      const server = new MlxServerProcess('/base');
      await assert.rejects(
        () => server.start({ modelPath: '/models/test', port: 9990 }),
        { message: 'mlx-serve process exited during startup' },
      );

      globalThis.fetch = origFetch;
    });

    it('should write pid file after successful start', async () => {
      const mockProc = createMockProc();
      spawnFn = () => mockProc;

      let writtenPath = '';
      let writtenData = '';
      writeFileSyncFn = (p: string, data: string) => {
        writtenPath = p;
        writtenData = data;
      };

      const origFetch = globalThis.fetch;
      globalThis.fetch = async (url: any) => {
        if (String(url).includes('/health')) {
          return { ok: true, json: async () => ({ status: 'ok' }) } as any;
        }
        return origFetch(url);
      };

      const server = new MlxServerProcess('/base');
      await server.start({ modelPath: '/models/test', port: 9990 });

      assert.ok(writtenPath.includes('chat.json'));
      const parsed = JSON.parse(writtenData);
      assert.strictEqual(parsed.pid, 54321);
      assert.strictEqual(parsed.port, 9990);
      assert.strictEqual(parsed.model, '/models/test');

      globalThis.fetch = origFetch;
      mockProc.emit('exit');
    });

    it('should write pid file with custom role name', async () => {
      const mockProc = createMockProc();
      spawnFn = () => mockProc;

      let writtenPath = '';
      writeFileSyncFn = (p: string) => { writtenPath = p; };

      const origFetch = globalThis.fetch;
      globalThis.fetch = async (url: any) => {
        if (String(url).includes('/health')) {
          return { ok: true, json: async () => ({ status: 'ok' }) } as any;
        }
        return origFetch(url);
      };

      const server = new MlxServerProcess('/base', 'embedding');
      await server.start({ modelPath: '/models/embed', port: 9991 });

      assert.ok(writtenPath.includes('embedding.json'));

      globalThis.fetch = origFetch;
      mockProc.emit('exit');
    });
  });

  describe('stop (with running process)', () => {
    it('should kill process and reset state', async () => {
      const mockProc = createMockProc();
      spawnFn = () => mockProc;

      const origFetch = globalThis.fetch;
      globalThis.fetch = async (url: any) => {
        if (String(url).includes('/health')) {
          return { ok: true, json: async () => ({ status: 'ok' }) } as any;
        }
        return origFetch(url);
      };

      const server = new MlxServerProcess('/base');
      await server.start({ modelPath: '/models/test', port: 9990 });
      assert.strictEqual(server.running, true);

      const origOn = mockProc.on.bind(mockProc);
      mockProc.on = ((event: string, cb: () => void) => {
        if (event === 'exit') setTimeout(cb, 10);
        return origOn(event, cb);
      }) as any;

      await server.stop();

      assert.strictEqual(server.running, false);
      assert.strictEqual(server.ready, false);
      assert.strictEqual(mockProc.kill.mock.callCount() >= 1, true);

      globalThis.fetch = origFetch;
    });
  });
});

describe('killOrphanedMlxServers', () => {
  beforeEach(() => {
    existsSyncFn = () => false;
    mkdirSyncFn = () => {};
    writeFileSyncFn = () => {};
    readFileSyncFn = () => '{}';
    readdirSyncFn = () => [];
    unlinkSyncFn = () => {};
    origKill = process.kill;
  });

  afterEach(() => {
    process.kill = origKill;
  });

  it('should return early when pid dir does not exist', () => {
    existsSyncFn = () => false;
    killOrphanedMlxServers('/base');
  });

  it('should skip non-json files', () => {
    existsSyncFn = () => true;
    readdirSyncFn = () => ['readme.txt', 'data.log'];
    let unlinkCalls = 0;
    unlinkSyncFn = () => { unlinkCalls++; };
    killOrphanedMlxServers('/base');
    assert.strictEqual(unlinkCalls, 0);
  });

  it('should kill alive orphaned process and remove pid file', () => {
    existsSyncFn = () => true;
    readdirSyncFn = () => ['chat.json'];
    readFileSyncFn = () => JSON.stringify({ pid: 88888, port: 9990, model: '/m/t' });

    let killCalls: Array<{ pid: number; signal: string | number }> = [];
    process.kill = ((pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal: signal ?? 0 });
      return true;
    }) as any;

    let unlinkCalls = 0;
    unlinkSyncFn = () => { unlinkCalls++; };

    killOrphanedMlxServers('/base');

    assert.ok(killCalls.length >= 2);
    assert.strictEqual(killCalls[0].signal, 0);
    assert.strictEqual(killCalls[1].signal, 'SIGTERM');
    assert.strictEqual(unlinkCalls, 1);
  });

  it('should remove pid file for dead process', () => {
    existsSyncFn = () => true;
    readdirSyncFn = () => ['chat.json'];
    readFileSyncFn = () => JSON.stringify({ pid: 88888, port: 9990, model: '/m/t' });

    process.kill = ((pid: number, signal?: string | number) => {
      if (signal === 0 || signal === undefined) throw new Error('ESRCH');
      return true;
    }) as any;

    let unlinkCalls = 0;
    unlinkSyncFn = () => { unlinkCalls++; };

    killOrphanedMlxServers('/base');
    assert.strictEqual(unlinkCalls, 1);
  });

  it('should handle corrupt pid file gracefully', () => {
    existsSyncFn = () => true;
    readdirSyncFn = () => ['chat.json'];
    readFileSyncFn = () => '{{{INVALID';

    let unlinkCalls = 0;
    unlinkSyncFn = () => { unlinkCalls++; };

    killOrphanedMlxServers('/base');
    assert.strictEqual(unlinkCalls, 1);
  });

  it('should handle readdirSync failure gracefully', () => {
    existsSyncFn = () => true;
    readdirSyncFn = () => { throw new Error('EACCES'); };

    killOrphanedMlxServers('/base');
  });

  it('should handle multiple pid files', () => {
    existsSyncFn = () => true;
    readdirSyncFn = () => ['chat.json', 'embedding.json'];

    let readCount = 0;
    readFileSyncFn = () => {
      readCount++;
      return JSON.stringify({ pid: 80000 + readCount, port: 9990 + readCount, model: `/m/t${readCount}` });
    };

    process.kill = ((pid: number, signal?: string | number) => {
      if (signal === 0 || signal === undefined) throw new Error('ESRCH');
      return true;
    }) as any;

    let unlinkCalls = 0;
    unlinkSyncFn = () => { unlinkCalls++; };

    killOrphanedMlxServers('/base');
    assert.strictEqual(unlinkCalls, 2);
  });
});
