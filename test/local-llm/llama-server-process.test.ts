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
let getBinaryPathFn: (...args: any[]) => Promise<string>;
let fetchFn: (...args: any[]) => Promise<any>;
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

mock.module('../../lib/local-llm/binary-manager.ts', {
  namedExports: {
    getBinaryPath: (...args: any[]) => getBinaryPathFn(...args),
  },
});

// Import after mocks
const { LlamaServerProcess, killOrphanedServers } = await import('../../lib/local-llm/llama-server-process.ts');

// ── Helpers ──

function createMockProc() {
  const proc = new EventEmitter() as any;
  proc.pid = 12345;
  proc.kill = mock.fn(() => true);
  proc.stderr = new EventEmitter();
  proc.stdout = null;
  proc.stdin = null;
  return proc;
}

let origKill: typeof process.kill;

describe('LlamaServerProcess', () => {
  beforeEach(() => {
    existsSyncFn = () => false;
    mkdirSyncFn = () => {};
    writeFileSyncFn = () => {};
    readFileSyncFn = () => '{}';
    readdirSyncFn = () => [];
    unlinkSyncFn = () => {};
    spawnFn = () => createMockProc();
    getBinaryPathFn = async () => '/usr/bin/llama-server';
    fetchFn = async () => ({ ok: true, json: async () => ({ status: 'ok' }) });
    origKill = process.kill;
    processKillFn = () => true;
  });

  afterEach(() => {
    process.kill = origKill;
  });

  describe('constructor and getters', () => {
    it('should initialize with default values', () => {
      const server = new LlamaServerProcess('/base');
      assert.strictEqual(server.port, 0);
      assert.strictEqual(server.modelPath, '');
      assert.strictEqual(server.running, false);
      assert.strictEqual(server.ready, false);
    });

    it('should set embedding role when isEmbedding is true', () => {
      const server = new LlamaServerProcess('/base', true);
      assert.strictEqual(server.port, 0);
      assert.strictEqual(server.running, false);
    });
  });

  describe('getBaseUrl', () => {
    it('should return correct URL format', () => {
      const server = new LlamaServerProcess('/base');
      assert.strictEqual(server.getBaseUrl(), 'http://127.0.0.1:0');
    });
  });

  describe('getServerProps', () => {
    it('should return null when not ready', async () => {
      const server = new LlamaServerProcess('/base');
      const result = await server.getServerProps();
      assert.strictEqual(result, null);
    });
  });

  describe('stop', () => {
    it('should return immediately when no process is running', async () => {
      const server = new LlamaServerProcess('/base');
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

      // Mock fetch for health check
      const origFetch = globalThis.fetch;
      globalThis.fetch = async (url: any) => {
        if (String(url).includes('/health')) {
          return { ok: true, json: async () => ({ status: 'ok' }) } as any;
        }
        return origFetch(url);
      };

      const server = new LlamaServerProcess('/base');
      await server.start({ modelPath: '/models/test.gguf', port: 8080 });

      assert.strictEqual(capturedBinary, '/usr/bin/llama-server');
      assert.ok(capturedArgs.includes('--model'));
      assert.ok(capturedArgs.includes('/models/test.gguf'));
      assert.ok(capturedArgs.includes('--port'));
      assert.ok(capturedArgs.includes('8080'));
      assert.ok(capturedArgs.includes('--host'));
      assert.ok(capturedArgs.includes('127.0.0.1'));
      assert.ok(capturedArgs.includes('--flash-attn'));
      assert.strictEqual(server.running, true);
      assert.strictEqual(server.ready, true);
      assert.strictEqual(server.port, 8080);
      assert.strictEqual(server.modelPath, '/models/test.gguf');

      globalThis.fetch = origFetch;

      // cleanup
      mockProc.emit('exit');
    });

    it('should include optional arguments when provided', async () => {
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

      const server = new LlamaServerProcess('/base');
      await server.start({
        modelPath: '/models/test.gguf',
        port: 8080,
        mmproj: '/models/mmproj.gguf',
        contextSize: 4096,
        threads: 8,
        batchSize: 512,
        ubatchSize: 256,
        cacheTypeK: 'f16',
        cacheTypeV: 'f16',
        mlock: true,
        gpuLayers: 32,
      });

      assert.ok(capturedArgs.includes('--mmproj'));
      assert.ok(capturedArgs.includes('/models/mmproj.gguf'));
      assert.ok(capturedArgs.includes('--ctx-size'));
      assert.ok(capturedArgs.includes('4096'));
      assert.ok(capturedArgs.includes('--threads'));
      assert.ok(capturedArgs.includes('8'));
      assert.ok(capturedArgs.includes('--batch-size'));
      assert.ok(capturedArgs.includes('512'));
      assert.ok(capturedArgs.includes('--ubatch-size'));
      assert.ok(capturedArgs.includes('256'));
      assert.ok(capturedArgs.includes('--cache-type-k'));
      assert.ok(capturedArgs.includes('f16'));
      assert.ok(capturedArgs.includes('--cache-type-v'));
      assert.ok(capturedArgs.includes('--mlock'));
      assert.ok(capturedArgs.includes('--n-gpu-layers'));
      assert.ok(capturedArgs.includes('32'));

      globalThis.fetch = origFetch;
      mockProc.emit('exit');
    });

    it('should include reasoning arguments when reasoningBudget is set', async () => {
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

      const server = new LlamaServerProcess('/base');
      await server.start({
        modelPath: '/models/test.gguf',
        port: 8080,
        reasoningBudget: 100,
      });

      assert.ok(capturedArgs.includes('--reasoning-format'));
      assert.ok(capturedArgs.includes('deepseek'));
      assert.ok(capturedArgs.includes('--reasoning-budget'));
      // Budget > 0 is clamped to -1
      assert.ok(capturedArgs.includes('-1'));

      globalThis.fetch = origFetch;
      mockProc.emit('exit');
    });

    it('should set reasoning budget to 0 when reasoningBudget is 0', async () => {
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

      const server = new LlamaServerProcess('/base');
      await server.start({
        modelPath: '/models/test.gguf',
        port: 8080,
        reasoningBudget: 0,
      });

      assert.ok(capturedArgs.includes('--reasoning-budget'));
      assert.ok(capturedArgs.includes('0'));

      globalThis.fetch = origFetch;
      mockProc.emit('exit');
    });

    it('should add --embedding flag for embedding server', async () => {
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

      const server = new LlamaServerProcess('/base', true);
      await server.start({ modelPath: '/models/embed.gguf', port: 9991 });

      assert.ok(capturedArgs.includes('--embedding'));

      globalThis.fetch = origFetch;
      mockProc.emit('exit');
    });

    it('should add --embedding flag when options.embedding is true', async () => {
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

      const server = new LlamaServerProcess('/base');
      await server.start({ modelPath: '/models/embed.gguf', port: 8080, embedding: true });

      assert.ok(capturedArgs.includes('--embedding'));

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

      const server = new LlamaServerProcess('/base');

      // First start
      await server.start({ modelPath: '/models/test1.gguf', port: 8080 });
      assert.strictEqual(server.running, true);

      // Mock exit for first proc (stop will kill it)
      mockProc1.on = ((event: string, cb: () => void) => {
        if (event === 'exit') setTimeout(cb, 0);
        return mockProc1;
      }) as any;

      // Second start should call stop first
      await server.start({ modelPath: '/models/test2.gguf', port: 8081 });
      assert.strictEqual(server.modelPath, '/models/test2.gguf');
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
          // Simulate process exit during startup
          mockProc.emit('exit');
        }
        throw new Error('connection refused');
      };

      const server = new LlamaServerProcess('/base');

      await assert.rejects(
        () => server.start({ modelPath: '/models/test.gguf', port: 8080 }),
        { message: 'llama-server process exited during startup' },
      );

      globalThis.fetch = origFetch;
    });

    it('should log stderr when startup fails', async () => {
      const mockProc = createMockProc();
      spawnFn = () => mockProc;

      const origFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        // Send stderr data then exit
        mockProc.stderr.emit('data', Buffer.from('CUDA error: out of memory'));
        mockProc.emit('exit');
        throw new Error('connection refused');
      };

      const server = new LlamaServerProcess('/base');

      await assert.rejects(
        () => server.start({ modelPath: '/models/test.gguf', port: 8080 }),
        { message: 'llama-server process exited during startup' },
      );

      globalThis.fetch = origFetch;
    });

    it('should not include --flash-attn when flashAttn is false', async () => {
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

      const server = new LlamaServerProcess('/base');
      await server.start({ modelPath: '/models/test.gguf', port: 8080, flashAttn: false });

      assert.ok(!capturedArgs.includes('--flash-attn'));

      globalThis.fetch = origFetch;
      mockProc.emit('exit');
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

      const server = new LlamaServerProcess('/base');
      await server.start({ modelPath: '/models/test.gguf', port: 8080 });

      assert.ok(writtenPath.includes('chat.json'));
      const parsed = JSON.parse(writtenData);
      assert.strictEqual(parsed.pid, 12345);
      assert.strictEqual(parsed.port, 8080);
      assert.strictEqual(parsed.model, '/models/test.gguf');

      globalThis.fetch = origFetch;
      mockProc.emit('exit');
    });

    it('should write embedding pid file for embedding server', async () => {
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

      const server = new LlamaServerProcess('/base', true);
      await server.start({ modelPath: '/models/embed.gguf', port: 9991 });

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

      const server = new LlamaServerProcess('/base');
      await server.start({ modelPath: '/models/test.gguf', port: 8080 });

      assert.strictEqual(server.running, true);

      // Make the exit listener fire when stop is called
      const origOn = mockProc.on.bind(mockProc);
      mockProc.on = ((event: string, cb: () => void) => {
        if (event === 'exit') {
          setTimeout(cb, 10);
        }
        return origOn(event, cb);
      }) as any;

      await server.stop();

      assert.strictEqual(server.running, false);
      assert.strictEqual(server.ready, false);
      assert.strictEqual(mockProc.kill.mock.callCount() >= 1, true);

      globalThis.fetch = origFetch;
    });
  });

  describe('getServerProps (when ready)', () => {
    it('should fetch and return server props', async () => {
      const mockProc = createMockProc();
      spawnFn = () => mockProc;

      const origFetch = globalThis.fetch;
      const propsData = { model: 'test', n_ctx: 4096 };

      globalThis.fetch = async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes('/health')) {
          return { ok: true, json: async () => ({ status: 'ok' }) } as any;
        }
        if (urlStr.includes('/props')) {
          return { ok: true, json: async () => propsData } as any;
        }
        return origFetch(url);
      };

      const server = new LlamaServerProcess('/base');
      await server.start({ modelPath: '/models/test.gguf', port: 8080 });

      const props = await server.getServerProps();
      assert.deepStrictEqual(props, propsData);

      globalThis.fetch = origFetch;
      mockProc.emit('exit');
    });

    it('should return null when fetch fails', async () => {
      const mockProc = createMockProc();
      spawnFn = () => mockProc;

      const origFetch = globalThis.fetch;

      globalThis.fetch = async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes('/health')) {
          return { ok: true, json: async () => ({ status: 'ok' }) } as any;
        }
        if (urlStr.includes('/props')) {
          throw new Error('connection refused');
        }
        return origFetch(url);
      };

      const server = new LlamaServerProcess('/base');
      await server.start({ modelPath: '/models/test.gguf', port: 8080 });

      const props = await server.getServerProps();
      assert.strictEqual(props, null);

      globalThis.fetch = origFetch;
      mockProc.emit('exit');
    });
  });
});

describe('killOrphanedServers', () => {
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
    killOrphanedServers('/base'); // should not throw
  });

  it('should skip non-json files', () => {
    existsSyncFn = () => true;
    readdirSyncFn = () => ['readme.txt', 'data.log'];
    let unlinkCalls = 0;
    unlinkSyncFn = () => { unlinkCalls++; };
    killOrphanedServers('/base');
    assert.strictEqual(unlinkCalls, 0);
  });

  it('should kill alive orphaned process and remove pid file', () => {
    existsSyncFn = () => true;
    readdirSyncFn = () => ['chat.json'];
    readFileSyncFn = () => JSON.stringify({ pid: 99999, port: 8080, model: '/m/t.gguf' });

    let killCalls: Array<{ pid: number; signal: string | number }> = [];
    process.kill = ((pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal: signal ?? 0 });
      return true;
    }) as any;

    let unlinkCalls = 0;
    unlinkSyncFn = () => { unlinkCalls++; };

    killOrphanedServers('/base');

    // process.kill(pid, 0) for alive check + process.kill(pid, 'SIGTERM')
    assert.ok(killCalls.length >= 2);
    assert.strictEqual(killCalls[0].signal, 0); // alive check
    assert.strictEqual(killCalls[1].signal, 'SIGTERM');
    assert.strictEqual(unlinkCalls, 1);
  });

  it('should remove pid file for dead process', () => {
    existsSyncFn = () => true;
    readdirSyncFn = () => ['chat.json'];
    readFileSyncFn = () => JSON.stringify({ pid: 99999, port: 8080, model: '/m/t.gguf' });

    process.kill = ((pid: number, signal?: string | number) => {
      if (signal === 0 || signal === undefined) throw new Error('ESRCH');
      return true;
    }) as any;

    let unlinkCalls = 0;
    unlinkSyncFn = () => { unlinkCalls++; };

    killOrphanedServers('/base');

    // Should still unlink the pid file
    assert.strictEqual(unlinkCalls, 1);
  });

  it('should handle corrupt pid file gracefully', () => {
    existsSyncFn = () => true;
    readdirSyncFn = () => ['chat.json'];
    readFileSyncFn = () => 'NOT VALID JSON{{{';

    let unlinkCalls = 0;
    unlinkSyncFn = () => { unlinkCalls++; };

    killOrphanedServers('/base'); // should not throw
    assert.strictEqual(unlinkCalls, 1);
  });

  it('should handle readdirSync failure gracefully', () => {
    existsSyncFn = () => true;
    readdirSyncFn = () => { throw new Error('EACCES'); };

    killOrphanedServers('/base'); // should not throw
  });
});
