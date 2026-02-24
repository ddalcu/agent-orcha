import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createSandboxWebFetchTool, createSandboxWebSearchTool } from '../../lib/sandbox/sandbox-web.ts';
import type { SandboxConfig } from '../../lib/sandbox/types.ts';

const defaultConfig: SandboxConfig = {
  enabled: true,
  commandTimeout: 30_000,
  maxOutputChars: 50_000,
};

describe('createSandboxWebFetchTool', () => {
  it('should create a tool with correct name', () => {
    const tool = createSandboxWebFetchTool(defaultConfig);
    assert.equal(tool.name, 'sandbox_web_fetch');
    assert.ok(tool.description.includes('web'));
  });

  it('should reject invalid URLs', async () => {
    const tool = createSandboxWebFetchTool(defaultConfig);
    const result = await tool.invoke({ url: 'not-a-url' });
    const parsed = JSON.parse(result as string);
    assert.ok(parsed.error.includes('Invalid URL'));
  });

  it('should reject non-http protocols', async () => {
    const tool = createSandboxWebFetchTool(defaultConfig);
    const result = await tool.invoke({ url: 'ftp://example.com/file' });
    const parsed = JSON.parse(result as string);
    assert.ok(parsed.error.includes('http'));
  });
});

describe('createSandboxWebSearchTool', () => {
  it('should create a tool with correct name', () => {
    const tool = createSandboxWebSearchTool();
    assert.equal(tool.name, 'sandbox_web_search');
    assert.ok(tool.description.toLowerCase().includes('search'));
  });
});
