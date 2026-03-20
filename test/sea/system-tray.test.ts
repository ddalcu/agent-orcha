import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';

// ── Mutable delegates for module-level mocks ──

let execFileFn: (...args: any[]) => any;
let spawnFn: (...args: any[]) => any;
let existsSyncFn: (p: string) => boolean;
let readFileSyncFn: (p: string) => any;
let chmodSyncFn: (...args: any[]) => void;
let isSeaFn: () => boolean;

// ── Module mocks (before importing module under test) ──

mock.module('child_process', {
  namedExports: {
    execFile: (...args: any[]) => execFileFn(...args),
    spawn: (...args: any[]) => spawnFn(...args),
    execFileSync: () => '',
    spawnSync: () => ({ stdout: '', stderr: '', status: 0 }),
  },
});

mock.module('fs', {
  namedExports: {
    existsSync: (p: string) => existsSyncFn(p),
    readFileSync: (p: string) => readFileSyncFn(p),
    chmodSync: (...args: any[]) => chmodSyncFn(...args),
  },
});

mock.module('../../lib/sea/bootstrap.ts', {
  namedExports: {
    isSea: () => isSeaFn(),
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

// Import module under test after mocks
const { createSystemTray } = await import('../../lib/sea/system-tray.ts');

// ── Helper: save and restore process.platform ──

let origPlatform: string;

function setPlatform(plat: string) {
  Object.defineProperty(process, 'platform', { value: plat, configurable: true });
}

function restorePlatform() {
  Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
}

// ── Helper: create a mock child process ──

function mockChildProcess() {
  return { unref: mock.fn() } as any;
}

// ── Helper: create a mock spawned process with stdio streams ──

function mockSpawnedProcess() {
  const stdin = { write: mock.fn(() => true) };
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const proc = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 12345,
  });
  return proc;
}

// ── Tests ──

describe('sea/system-tray', () => {
  beforeEach(() => {
    origPlatform = process.platform;
    isSeaFn = () => false;
    existsSyncFn = () => false;
    readFileSyncFn = () => Buffer.from('icon-data');
    chmodSyncFn = () => {};
    execFileFn = () => mockChildProcess();
    spawnFn = () => mockSpawnedProcess();
  });

  afterEach(() => {
    restorePlatform();
  });

  describe('createSystemTray()', () => {
    it('returns null on unsupported platform (linux)', () => {
      setPlatform('linux');
      const result = createSystemTray('http://localhost:3000', () => {});
      assert.strictEqual(result, null);
    });

    it('returns null when tray binary not found', () => {
      setPlatform('win32');
      existsSyncFn = () => false;

      const result = createSystemTray('http://localhost:3000', () => {});
      assert.strictEqual(result, null);
    });

    it('spawns the tray binary when found', () => {
      setPlatform('win32');
      existsSyncFn = () => true;
      const spawnCalls: any[][] = [];
      const proc = mockSpawnedProcess();
      spawnFn = (...args: any[]) => {
        spawnCalls.push(args);
        return proc;
      };

      const result = createSystemTray('http://localhost:3000', () => {});
      assert.notStrictEqual(result, null);
      assert.strictEqual(spawnCalls.length, 1);
    });

    it('writes menu config on ready event', () => {
      setPlatform('win32');
      existsSyncFn = () => true;
      const proc = mockSpawnedProcess();
      spawnFn = () => proc;
      execFileFn = () => mockChildProcess();

      createSystemTray('http://localhost:3000', () => {});

      // Simulate the tray sending 'ready'
      proc.stdout.push(JSON.stringify({ type: 'ready' }) + '\n');

      return new Promise<void>((resolve) => {
        setImmediate(() => {
          const written = (proc.stdin.write as any).mock.calls;
          assert.ok(written.length > 0, 'should write menu config to stdin');
          const menuJson = JSON.parse(written[0].arguments[0].replace('\n', ''));
          assert.strictEqual(menuJson.tooltip, 'Agent Orcha');
          // On win32, the label should be 'View Logs'
          const consoleItem = menuJson.items.find((i: any) => i.__id === 2);
          assert.ok(consoleItem, 'should have View Logs menu item');
          assert.strictEqual(consoleItem.title, 'View Logs');
          resolve();
        });
      });
    });

    it('writes menu with Show Console label on darwin', () => {
      setPlatform('darwin');
      existsSyncFn = () => true;
      const proc = mockSpawnedProcess();
      spawnFn = () => proc;
      execFileFn = () => mockChildProcess();

      createSystemTray('http://localhost:3000', () => {});

      proc.stdout.push(JSON.stringify({ type: 'ready' }) + '\n');

      return new Promise<void>((resolve) => {
        setImmediate(() => {
          const written = (proc.stdin.write as any).mock.calls;
          const menuJson = JSON.parse(written[0].arguments[0].replace('\n', ''));
          const consoleItem = menuJson.items.find((i: any) => i.__id === 2);
          assert.strictEqual(consoleItem.title, 'Show Console');
          resolve();
        });
      });
    });

    it('calls onQuit when Quit is clicked', () => {
      setPlatform('win32');
      existsSyncFn = () => true;
      const proc = mockSpawnedProcess();
      spawnFn = () => proc;
      execFileFn = () => mockChildProcess();

      let quitCalled = false;
      createSystemTray('http://localhost:3000', () => { quitCalled = true; });

      proc.stdout.push(JSON.stringify({ type: 'clicked', __id: 3 }) + '\n');

      return new Promise<void>((resolve) => {
        setImmediate(() => {
          assert.strictEqual(quitCalled, true);
          resolve();
        });
      });
    });

    it('opens log viewer on View Logs click, toggles off on second click (win32)', () => {
      setPlatform('win32');
      existsSyncFn = () => true;
      const trayProc = mockSpawnedProcess();
      spawnFn = () => trayProc;
      const execCalls: any[][] = [];
      let viewerPid = 99999;

      // Mock execFile: simulate the launcher callback returning a PID
      execFileFn = (...args: any[]) => {
        execCalls.push(args);
        if (args[0] === 'powershell' && args[1]?.some((a: string) => a.includes('Start-Process'))) {
          const cb = args.find((a: any) => typeof a === 'function');
          if (cb) setImmediate(() => cb(null, `${viewerPid}\n`));
        }
        return mockChildProcess();
      };

      // Mock process.kill: only our viewerPid is "alive"
      const origKill = process.kill;
      (process as any).kill = (pid: number, signal?: number) => {
        if (signal === 0 && pid === viewerPid) return true;
        if (signal === 0) throw new Error('ESRCH');
        return origKill.call(process, pid, signal);
      };

      createSystemTray('http://localhost:3000', () => {});

      // First click — opens log viewer
      trayProc.stdout.push(JSON.stringify({ type: 'clicked', __id: 2 }) + '\n');

      return new Promise<void>((resolve) => {
        // Wait for readline event + execFile callback chain to complete
        setTimeout(() => {
          // Verify the Start-Process call was made
          const psCall = execCalls.find((c) =>
            c[0] === 'powershell' && c[1]?.some((a: string) => a.includes('Start-Process')));
          assert.ok(psCall, 'should execFile powershell with Start-Process for log viewing');

          // Second click — should toggle off (kill existing log viewer)
          trayProc.stdout.push(JSON.stringify({ type: 'clicked', __id: 2 }) + '\n');

          setTimeout(() => {
            const taskKillCall = execCalls.find((c) => c[0] === 'taskkill');
            assert.ok(taskKillCall, 'should call taskkill to close log viewer');
            assert.ok(taskKillCall[1].includes('/PID'), 'should pass /PID flag');
            assert.ok(taskKillCall[1].includes(String(viewerPid)), 'should pass the viewer PID');

            (process as any).kill = origKill;
            resolve();
          }, 50);
        }, 100);
      });
    });

    it('opens Console.app on Show Console click (darwin)', () => {
      setPlatform('darwin');
      existsSyncFn = () => true;
      const proc = mockSpawnedProcess();
      spawnFn = () => proc;
      const execCalls: any[][] = [];
      execFileFn = (...args: any[]) => {
        execCalls.push(args);
        return mockChildProcess();
      };

      createSystemTray('http://localhost:3000', () => {});

      proc.stdout.push(JSON.stringify({ type: 'clicked', __id: 2 }) + '\n');

      return new Promise<void>((resolve) => {
        setImmediate(() => {
          const openCall = execCalls.find((c) => c[0] === 'open' && c[1]?.includes('-a'));
          assert.ok(openCall, 'should call open -a Console on darwin');
          resolve();
        });
      });
    });

    it('opens browser on Open in Browser click', () => {
      setPlatform('win32');
      existsSyncFn = () => true;
      const proc = mockSpawnedProcess();
      spawnFn = () => proc;
      const execCalls: any[][] = [];
      execFileFn = (...args: any[]) => {
        execCalls.push(args);
        return mockChildProcess();
      };

      createSystemTray('http://localhost:3000', () => {});

      // OPEN_ID = 1
      proc.stdout.push(JSON.stringify({ type: 'clicked', __id: 1 }) + '\n');

      return new Promise<void>((resolve) => {
        setImmediate(() => {
          const cmdCall = execCalls.find((c) => c[0] === 'rundll32');
          assert.ok(cmdCall, 'should call rundll32 to open browser on win32');
          assert.ok(cmdCall[1].includes('http://localhost:3000'));
          resolve();
        });
      });
    });

    it('kill() writes exit message to stdin', () => {
      setPlatform('win32');
      existsSyncFn = () => true;
      const proc = mockSpawnedProcess();
      spawnFn = () => proc;
      execFileFn = () => mockChildProcess();

      const tray = createSystemTray('http://localhost:3000', () => {});
      assert.notStrictEqual(tray, null);

      tray!.kill();

      const written = (proc.stdin.write as any).mock.calls;
      const exitMsg = written.find((c: any) => {
        try {
          const parsed = JSON.parse(c.arguments[0].replace('\n', ''));
          return parsed.type === 'exit';
        } catch { return false; }
      });
      assert.ok(exitMsg, 'should write {"type":"exit"} to stdin');
    });
  });
});
