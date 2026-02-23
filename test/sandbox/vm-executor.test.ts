import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { VmExecutor } from '../../lib/sandbox/vm-executor.ts';

describe('VmExecutor', () => {
  it('should construct without error', () => {
    const executor = new VmExecutor();
    assert.ok(executor);
  });

  it('should execute simple code', async () => {
    const executor = new VmExecutor();
    const result = await executor.execute('return 1 + 2');
    assert.equal(result.result, '3');
    assert.equal(result.error, undefined);
    executor.close();
  });

  it('should capture console.log output', async () => {
    const executor = new VmExecutor();
    const result = await executor.execute('console.log("hello"); console.log("world");');
    assert.equal(result.stdout, 'hello\nworld');
    executor.close();
  });

  it('should return string results directly', async () => {
    const executor = new VmExecutor();
    const result = await executor.execute('return "hello"');
    assert.equal(result.result, 'hello');
    executor.close();
  });

  it('should return JSON for object results', async () => {
    const executor = new VmExecutor();
    const result = await executor.execute('return { a: 1 }');
    assert.equal(result.result, '{"a":1}');
    executor.close();
  });

  it('should handle errors gracefully', async () => {
    const executor = new VmExecutor();
    const result = await executor.execute('throw new Error("test error")');
    assert.ok(result.error?.includes('test error'));
    executor.close();
  });

  it('should capture stdout even on error', async () => {
    const executor = new VmExecutor();
    const result = await executor.execute('console.log("before"); throw new Error("boom")');
    assert.equal(result.stdout, 'before');
    assert.ok(result.error?.includes('boom'));
    executor.close();
  });

  it('should persist state across executions', async () => {
    const executor = new VmExecutor();
    await executor.execute('globalThis.counter = 1');
    const result = await executor.execute('return globalThis.counter');
    assert.equal(result.result, '1');
    executor.close();
  });

  it('should reset context', async () => {
    const executor = new VmExecutor();
    await executor.execute('globalThis.counter = 42');
    executor.reset();
    const result = await executor.execute('return typeof globalThis.counter');
    assert.equal(result.result, 'undefined');
    executor.close();
  });

  it('should close without error', () => {
    const executor = new VmExecutor();
    executor.close();
  });

  it('should handle undefined return', async () => {
    const executor = new VmExecutor();
    const result = await executor.execute('console.log("no return")');
    assert.equal(result.result, undefined);
    assert.equal(result.stdout, 'no return');
    executor.close();
  });

  it('should have standard globals available', async () => {
    const executor = new VmExecutor();
    const result = await executor.execute(`
      const arr = [3, 1, 2];
      const sorted = arr.sort();
      const json = JSON.stringify(sorted);
      const pi = Math.PI;
      const url = new URL('https://example.com/path');
      return { json, pi: Math.round(pi * 100) / 100, host: url.host };
    `);
    const parsed = JSON.parse(result.result!);
    assert.equal(parsed.json, '[1,2,3]');
    assert.equal(parsed.pi, 3.14);
    assert.equal(parsed.host, 'example.com');
    executor.close();
  });
});
