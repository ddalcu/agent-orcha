import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';

// ── Mutable delegates for module-level mocks ──

let spawnFn: (...args: any[]) => any;
let execFileFn: (...args: any[]) => any;
let execFileSyncFn: (...args: any[]) => any;
let spawnSyncFn: (...args: any[]) => any;

// ── Module mocks (before importing module under test) ──

mock.module('child_process', {
  namedExports: {
    spawn: (...args: any[]) => spawnFn(...args),
    execFile: (...args: any[]) => execFileFn(...args),
    execFileSync: (...args: any[]) => execFileSyncFn(...args),
    spawnSync: (...args: any[]) => spawnSyncFn(...args),
  },
});

const { spawn, execFile, execFileSync, spawnSync } = await import('../../lib/utils/child-process.ts');

// ── Tests ──

describe('utils/child-process', () => {
  beforeEach(() => {
    spawnFn = mock.fn(() => ({ on: () => {} }));
    execFileFn = mock.fn(() => ({ on: () => {} }));
    execFileSyncFn = mock.fn(() => '');
    spawnSyncFn = mock.fn(() => ({ stdout: '', stderr: '', status: 0 }));
  });

  describe('spawn', () => {
    it('passes windowsHide: true by default', () => {
      spawn('node', ['--version']);
      const call = (spawnFn as any).mock.calls[0];
      assert.strictEqual(call.arguments[2]?.windowsHide, true);
    });

    it('allows overriding windowsHide to false', () => {
      spawn('node', ['--version'], { windowsHide: false });
      const call = (spawnFn as any).mock.calls[0];
      assert.strictEqual(call.arguments[2]?.windowsHide, false);
    });

    it('preserves other options', () => {
      spawn('node', ['--version'], { stdio: 'pipe', env: { FOO: 'bar' } });
      const opts = (spawnFn as any).mock.calls[0].arguments[2];
      assert.strictEqual(opts.windowsHide, true);
      assert.strictEqual(opts.stdio, 'pipe');
      assert.deepStrictEqual(opts.env, { FOO: 'bar' });
    });

    it('works without args array (command + options)', () => {
      spawn('node', { cwd: '/tmp' });
      const call = (spawnFn as any).mock.calls[0];
      assert.strictEqual(call.arguments[1]?.windowsHide, true);
      assert.strictEqual(call.arguments[1]?.cwd, '/tmp');
    });
  });

  describe('execFile', () => {
    it('passes windowsHide: true with args and options', () => {
      execFile('cmd', ['/c', 'echo'], { encoding: 'utf-8' });
      const call = (execFileFn as any).mock.calls[0];
      // Find the options object in the args
      const opts = call.arguments.find((a: any) => a && typeof a === 'object' && !Array.isArray(a) && typeof a !== 'function');
      assert.strictEqual(opts?.windowsHide, true);
      assert.strictEqual(opts?.encoding, 'utf-8');
    });

    it('injects windowsHide: true when no options provided (with callback)', () => {
      const cb = () => {};
      execFile('cmd', ['/c', 'echo'], cb);
      const call = (execFileFn as any).mock.calls[0];
      const opts = call.arguments.find((a: any) => a && typeof a === 'object' && !Array.isArray(a) && typeof a !== 'function');
      assert.strictEqual(opts?.windowsHide, true);
    });

    it('allows overriding windowsHide to false', () => {
      execFile('cmd', ['/c', 'echo'], { windowsHide: false });
      const call = (execFileFn as any).mock.calls[0];
      const opts = call.arguments.find((a: any) => a && typeof a === 'object' && !Array.isArray(a) && typeof a !== 'function');
      assert.strictEqual(opts?.windowsHide, false);
    });
  });

  describe('execFileSync', () => {
    it('passes windowsHide: true by default', () => {
      execFileSync('nvidia-smi', [], { encoding: 'utf-8', timeout: 5000 });
      const call = (execFileSyncFn as any).mock.calls[0];
      assert.strictEqual(call.arguments[2]?.windowsHide, true);
      assert.strictEqual(call.arguments[2]?.encoding, 'utf-8');
      assert.strictEqual(call.arguments[2]?.timeout, 5000);
    });

    it('passes windowsHide: true with no options', () => {
      execFileSync('nvidia-smi', ['--query']);
      const call = (execFileSyncFn as any).mock.calls[0];
      assert.strictEqual(call.arguments[2]?.windowsHide, true);
    });

    it('allows overriding windowsHide to false', () => {
      execFileSync('nvidia-smi', [], { windowsHide: false });
      const call = (execFileSyncFn as any).mock.calls[0];
      assert.strictEqual(call.arguments[2]?.windowsHide, false);
    });

    it('works with options-only (no args array)', () => {
      execFileSync('nvidia-smi', { encoding: 'utf-8' } as any);
      const call = (execFileSyncFn as any).mock.calls[0];
      assert.strictEqual(call.arguments[1]?.windowsHide, true);
      assert.strictEqual(call.arguments[1]?.encoding, 'utf-8');
    });
  });

  describe('spawnSync', () => {
    it('passes windowsHide: true by default', () => {
      spawnSync('node', ['--version'], { timeout: 5000, encoding: 'utf-8' });
      const call = (spawnSyncFn as any).mock.calls[0];
      assert.strictEqual(call.arguments[2]?.windowsHide, true);
      assert.strictEqual(call.arguments[2]?.timeout, 5000);
    });

    it('passes windowsHide: true with no options', () => {
      spawnSync('node', ['--version']);
      const call = (spawnSyncFn as any).mock.calls[0];
      assert.strictEqual(call.arguments[2]?.windowsHide, true);
    });

    it('allows overriding windowsHide to false', () => {
      spawnSync('node', ['--version'], { windowsHide: false });
      const call = (spawnSyncFn as any).mock.calls[0];
      assert.strictEqual(call.arguments[2]?.windowsHide, false);
    });
  });
});
