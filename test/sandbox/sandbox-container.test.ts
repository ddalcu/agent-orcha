import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';

// ── Mutable mock delegates ──
let execFileSyncFn: (...args: any[]) => any;
let execFileFn: (...args: any[]) => any;

// Mock child_process
mock.module('node:child_process', {
  namedExports: {
    execFileSync: (...args: any[]) => execFileSyncFn(...args),
    execFile: (...args: any[]) => execFileFn(...args),
  },
});

// Mock logger
mock.module('../../lib/logger.ts', {
  namedExports: {
    logger: {
      info: mock.fn(),
      warn: mock.fn(),
      error: mock.fn(),
      debug: mock.fn(),
    },
  },
});

const { SandboxContainer } = await import('../../lib/sandbox/sandbox-container.ts');

describe('SandboxContainer', () => {
  let container: InstanceType<typeof SandboxContainer>;

  beforeEach(() => {
    // Reset defaults
    execFileSyncFn = () => { throw new Error('not found'); };
    execFileFn = () => {};

    container = new SandboxContainer();
  });

  afterEach(() => {
    mock.restoreAll();
  });

  describe('detectDocker', () => {
    it('should return true when docker is found at /usr/local/bin/docker', () => {
      execFileSyncFn = (cmd: string) => {
        if (cmd === '/usr/local/bin/docker') return Buffer.from('Docker version 24.0');
        throw new Error('not found');
      };

      assert.strictEqual(container.detectDocker(), true);
      assert.strictEqual(container.docker, '/usr/local/bin/docker');
    });

    it('should return true when docker is found at /usr/bin/docker', () => {
      execFileSyncFn = (cmd: string) => {
        if (cmd === '/usr/bin/docker') return Buffer.from('Docker version 24.0');
        throw new Error('not found');
      };

      assert.strictEqual(container.detectDocker(), true);
      assert.strictEqual(container.docker, '/usr/bin/docker');
    });

    it('should return true when docker is found via PATH', () => {
      execFileSyncFn = (cmd: string) => {
        if (cmd === 'docker') return Buffer.from('Docker version 24.0');
        throw new Error('not found');
      };

      assert.strictEqual(container.detectDocker(), true);
      assert.strictEqual(container.docker, 'docker');
    });

    it('should return false when no docker is available', () => {
      execFileSyncFn = () => { throw new Error('not found'); };

      assert.strictEqual(container.detectDocker(), false);
      assert.strictEqual(container.docker, null);
    });
  });

  describe('isContainerRunning', () => {
    it('should return false when docker is not detected', () => {
      assert.strictEqual(container.isContainerRunning(), false);
    });

    it('should return true when container inspect returns "true"', () => {
      execFileSyncFn = (cmd: string, args: string[]) => {
        if (args && args[0] === 'version') return Buffer.from('ok');
        if (args && args[0] === 'container') return Buffer.from('true');
        return Buffer.from('');
      };

      container.detectDocker();
      assert.strictEqual(container.isContainerRunning(), true);
    });

    it('should return false when container inspect returns "false"', () => {
      execFileSyncFn = (cmd: string, args: string[]) => {
        if (args && args[0] === 'version') return Buffer.from('ok');
        if (args && args[0] === 'container') return Buffer.from('false');
        return Buffer.from('');
      };

      container.detectDocker();
      assert.strictEqual(container.isContainerRunning(), false);
    });

    it('should return false when container inspect throws', () => {
      execFileSyncFn = (cmd: string, args: string[]) => {
        if (args && args[0] === 'version') return Buffer.from('ok');
        throw new Error('container not found');
      };

      container.detectDocker();
      assert.strictEqual(container.isContainerRunning(), false);
    });
  });

  describe('start', () => {
    it('should return false when docker is not detected', async () => {
      assert.strictEqual(await container.start(), false);
    });

    it('should return true when container is already running', async () => {
      execFileSyncFn = (cmd: string, args: string[]) => {
        if (args && args[0] === 'version') return Buffer.from('ok');
        if (args && args[0] === 'container') return Buffer.from('true');
        return Buffer.from('');
      };

      container.detectDocker();
      const result = await container.start();
      assert.strictEqual(result, true);
      assert.strictEqual(container.isRunning, true);
    });

    it('should pull image, start container and wait for CDP', async () => {
      execFileSyncFn = (cmd: string, args: string[]) => {
        if (args && args[0] === 'version') return Buffer.from('ok');
        if (args && args[0] === 'container') throw new Error('No such container');
        return Buffer.from('');
      };

      // Mock execFile: first call = pull (success), second call = run (success)
      let callCount = 0;
      execFileFn = (cmd: string, args: string[], opts: any, cb: Function) => {
        callCount++;
        cb(null, '', '');
      };

      // Mock fetch for CDP check
      const origFetch = globalThis.fetch;
      globalThis.fetch = mock.fn(() =>
        Promise.resolve({ ok: true } as Response),
      ) as any;

      container.detectDocker();
      const result = await container.start();

      assert.strictEqual(result, true);
      assert.strictEqual(container.isRunning, true);
      assert.ok(callCount >= 2, 'should have called pull and run');

      globalThis.fetch = origFetch;
    });

    it('should return false when docker run fails', async () => {
      execFileSyncFn = (cmd: string, args: string[]) => {
        if (args && args[0] === 'version') return Buffer.from('ok');
        if (args && args[0] === 'container') throw new Error('No such container');
        return Buffer.from('');
      };

      // Pull succeeds, run fails
      execFileFn = (cmd: string, args: string[], opts: any, cb: Function) => {
        if (args && args[0] === 'pull') {
          cb(null, '', '');
        } else {
          cb(new Error('run failed'), '', 'error output');
        }
      };

      container.detectDocker();
      const result = await container.start();

      assert.strictEqual(result, false);
    });

    it('should return false when all pull attempts fail', async () => {
      execFileSyncFn = (cmd: string, args: string[]) => {
        if (args && args[0] === 'version') return Buffer.from('ok');
        if (args && args[0] === 'container') return Buffer.from('false');
        return Buffer.from('');
      };

      execFileFn = (cmd: string, args: string[], opts: any, cb: Function) => {
        cb(new Error('pull failed'));
      };

      container.detectDocker();
      const result = await container.start();

      assert.strictEqual(result, false);
    });
  });

  describe('stop', () => {
    it('should be a no-op when docker is not detected', async () => {
      await container.stop(); // Should not throw
    });

    it('should be a no-op when not running', async () => {
      execFileSyncFn = (cmd: string, args: string[]) => {
        if (args && args[0] === 'version') return Buffer.from('ok');
        throw new Error('not found');
      };

      container.detectDocker();
      await container.stop(); // Should not throw
    });

    it('should stop a running container', async () => {
      // Start first
      execFileSyncFn = (cmd: string, args: string[]) => {
        if (args && args[0] === 'version') return Buffer.from('ok');
        if (args && args[0] === 'container') return Buffer.from('true');
        return Buffer.from('');
      };

      container.detectDocker();
      await container.start();
      assert.strictEqual(container.isRunning, true);

      // Now stop
      execFileFn = (cmd: string, args: string[], opts: any, cb: Function) => {
        cb(null, '', '');
      };

      await container.stop();
      assert.strictEqual(container.isRunning, false);
    });

    it('should handle stop failure gracefully', async () => {
      execFileSyncFn = (cmd: string, args: string[]) => {
        if (args && args[0] === 'version') return Buffer.from('ok');
        if (args && args[0] === 'container') return Buffer.from('true');
        return Buffer.from('');
      };

      container.detectDocker();
      await container.start();

      execFileFn = (cmd: string, args: string[], opts: any, cb: Function) => {
        cb(new Error('stop failed'));
      };

      await container.stop(); // Should not throw
      assert.strictEqual(container.isRunning, false);
    });
  });

  describe('exec', () => {
    it('should return error when container is not running', async () => {
      const result = await container.exec('echo hello', 5000);
      assert.strictEqual(result.exitCode, -1);
      assert.ok(result.error?.includes('not running'));
    });

    it('should execute command and return stdout/stderr', async () => {
      // Start container first
      execFileSyncFn = (cmd: string, args: string[]) => {
        if (args && args[0] === 'version') return Buffer.from('ok');
        if (args && args[0] === 'container') return Buffer.from('true');
        return Buffer.from('');
      };

      container.detectDocker();
      await container.start();

      // Mock exec
      execFileFn = (cmd: string, args: string[], opts: any, cb: Function) => {
        cb(null, 'hello world\n', '');
      };

      const result = await container.exec('echo hello world', 5000);
      assert.strictEqual(result.stdout, 'hello world\n');
      assert.strictEqual(result.stderr, '');
      assert.strictEqual(result.exitCode, 0);
    });

    it('should handle command failure with numeric exit code', async () => {
      execFileSyncFn = (cmd: string, args: string[]) => {
        if (args && args[0] === 'version') return Buffer.from('ok');
        if (args && args[0] === 'container') return Buffer.from('true');
        return Buffer.from('');
      };

      container.detectDocker();
      await container.start();

      execFileFn = (cmd: string, args: string[], opts: any, cb: Function) => {
        const err: any = new Error('command failed');
        err.code = 127;
        cb(err, '', 'command not found');
      };

      const result = await container.exec('nonexistent', 5000);
      assert.strictEqual(result.exitCode, 127);
      assert.strictEqual(result.stderr, 'command not found');
      assert.strictEqual(result.error, undefined);
    });

    it('should handle command failure with non-numeric error code', async () => {
      execFileSyncFn = (cmd: string, args: string[]) => {
        if (args && args[0] === 'version') return Buffer.from('ok');
        if (args && args[0] === 'container') return Buffer.from('true');
        return Buffer.from('');
      };

      container.detectDocker();
      await container.start();

      execFileFn = (cmd: string, args: string[], opts: any, cb: Function) => {
        const err: any = new Error('timeout exceeded');
        err.code = 'ETIMEDOUT';
        cb(err, '', '');
      };

      const result = await container.exec('sleep 100', 5000);
      assert.strictEqual(result.exitCode, 1);
      assert.ok(result.error?.includes('timeout exceeded'));
    });
  });

  describe('isRunning', () => {
    it('should return false initially', () => {
      assert.strictEqual(container.isRunning, false);
    });
  });

  describe('docker', () => {
    it('should return null before detection', () => {
      assert.strictEqual(container.docker, null);
    });

    it('should return docker path after detection', () => {
      execFileSyncFn = (cmd: string) => {
        if (cmd === '/usr/local/bin/docker') return Buffer.from('ok');
        throw new Error('not found');
      };

      container.detectDocker();
      assert.strictEqual(container.docker, '/usr/local/bin/docker');
    });
  });
});
