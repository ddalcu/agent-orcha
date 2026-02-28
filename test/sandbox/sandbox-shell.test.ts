import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createSandboxShellTool } from '../../lib/sandbox/sandbox-shell.ts';
import type { SandboxConfig } from '../../lib/sandbox/types.ts';

function createConfig(overrides?: Partial<SandboxConfig>): SandboxConfig {
  return {
    enabled: true,
    commandTimeout: 30_000,
    maxOutputChars: 50_000,
    ...overrides,
  };
}

describe('createSandboxShellTool', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env['ALLOW_UNSAFE_HOST_EXECUTION'];
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env['ALLOW_UNSAFE_HOST_EXECUTION'];
    } else {
      process.env['ALLOW_UNSAFE_HOST_EXECUTION'] = savedEnv;
    }
  });

  it('should create a tool with correct name', () => {
    const tool = createSandboxShellTool(createConfig());
    assert.equal(tool.name, 'sandbox_shell');
    assert.ok(tool.description.includes('shell command'));
  });

  it('should block execution outside Docker without env var', async () => {
    delete process.env['ALLOW_UNSAFE_HOST_EXECUTION'];
    const tool = createSandboxShellTool(createConfig());
    const result = await tool.invoke({ command: 'echo hello' });
    const parsed = JSON.parse(result as string);
    assert.ok(parsed.error?.includes('disabled outside Docker'));
    assert.equal(parsed.exitCode, -1);
  });

  it('should execute when ALLOW_UNSAFE_HOST_EXECUTION is set', async () => {
    process.env['ALLOW_UNSAFE_HOST_EXECUTION'] = 'true';
    const tool = createSandboxShellTool(createConfig());
    const result = await tool.invoke({ command: 'echo hello' });
    const parsed = JSON.parse(result as string);
    assert.equal(parsed.stdout.trim(), 'hello');
    assert.equal(parsed.exitCode, 0);
  });

  it('should return stderr and non-zero exit code on failure', async () => {
    process.env['ALLOW_UNSAFE_HOST_EXECUTION'] = 'true';
    const tool = createSandboxShellTool(createConfig());
    const result = await tool.invoke({ command: 'ls /nonexistent_dir_xyz_12345' });
    const parsed = JSON.parse(result as string);
    assert.ok(parsed.exitCode !== 0);
    assert.ok(parsed.stderr.length > 0);
  });

  it('should truncate long output', async () => {
    process.env['ALLOW_UNSAFE_HOST_EXECUTION'] = 'true';
    const tool = createSandboxShellTool(createConfig({ maxOutputChars: 50 }));
    const result = await tool.invoke({ command: 'yes | head -1000' });
    const parsed = JSON.parse(result as string);
    assert.equal(parsed._truncated, true);
  });

  it('should respect timeout', async () => {
    process.env['ALLOW_UNSAFE_HOST_EXECUTION'] = 'true';
    const tool = createSandboxShellTool(createConfig({ commandTimeout: 1000 }));
    const result = await tool.invoke({ command: 'echo fast' });
    const parsed = JSON.parse(result as string);
    assert.equal(parsed.stdout.trim(), 'fast');
    assert.equal(parsed.exitCode, 0);
  });
});
