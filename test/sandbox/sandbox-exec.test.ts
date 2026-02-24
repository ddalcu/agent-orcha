import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createSandboxExecTool } from '../../lib/sandbox/sandbox-exec.ts';
import { VmExecutor } from '../../lib/sandbox/vm-executor.ts';
import type { SandboxConfig } from '../../lib/sandbox/types.ts';

function createConfig(overrides?: Partial<SandboxConfig>): SandboxConfig {
  return {
    enabled: true,
    commandTimeout: 30_000,
    maxOutputChars: 50_000,
    ...overrides,
  };
}

describe('createSandboxExecTool', () => {
  it('should create a tool with correct name and description', () => {
    const executor = new VmExecutor();
    const tool = createSandboxExecTool(executor, createConfig());
    assert.equal(tool.name, 'sandbox_exec');
    assert.ok(tool.description.includes('JavaScript'));
    executor.close();
  });

  it('should execute code and return result', async () => {
    const executor = new VmExecutor();
    const tool = createSandboxExecTool(executor, createConfig());
    const result = await tool.invoke({ code: 'return 1 + 2' });
    const parsed = JSON.parse(result as string);
    assert.equal(parsed.result, '3');
    assert.equal(parsed.error, undefined);
    executor.close();
  });

  it('should capture console output', async () => {
    const executor = new VmExecutor();
    const tool = createSandboxExecTool(executor, createConfig());
    const result = await tool.invoke({ code: 'console.log("hello world")' });
    const parsed = JSON.parse(result as string);
    assert.equal(parsed.stdout, 'hello world');
    executor.close();
  });

  it('should return error for invalid code', async () => {
    const executor = new VmExecutor();
    const tool = createSandboxExecTool(executor, createConfig());
    const result = await tool.invoke({ code: 'throw new Error("fail")' });
    const parsed = JSON.parse(result as string);
    assert.ok(parsed.error?.includes('fail'));
    executor.close();
  });

  it('should truncate long output', async () => {
    const executor = new VmExecutor();
    const tool = createSandboxExecTool(executor, createConfig({ maxOutputChars: 100 }));
    const result = await tool.invoke({ code: 'console.log("x".repeat(200)); return "done"' });
    const parsed = JSON.parse(result as string);
    assert.equal(parsed._truncated, true);
    assert.ok(parsed.stdout.length <= 100);
    executor.close();
  });

  it('should respect timeout parameter', async () => {
    const executor = new VmExecutor();
    const tool = createSandboxExecTool(executor, createConfig({ commandTimeout: 5000 }));
    // Passing a smaller timeout should not throw for fast code
    const result = await tool.invoke({ code: 'return "fast"', timeout: 1000 });
    const parsed = JSON.parse(result as string);
    assert.equal(parsed.result, 'fast');
    executor.close();
  });
});
