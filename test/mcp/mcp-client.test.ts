import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { MCPClientManager } from '../../lib/mcp/mcp-client.ts';

describe('MCPClientManager', () => {
  it('should construct with empty config', () => {
    const manager = new MCPClientManager({
      version: '1.0.0',
      servers: {},
    });
    assert.ok(manager);
  });

  it('should return empty server names when no connections', () => {
    const manager = new MCPClientManager({
      version: '1.0.0',
      servers: {},
    });
    assert.deepEqual(manager.getServerNames(), []);
  });

  it('should return empty tools when no connections', async () => {
    const manager = new MCPClientManager({
      version: '1.0.0',
      servers: {},
    });
    const tools = await manager.getTools();
    assert.deepEqual(tools, []);
  });

  it('should return empty for non-existent server tools', async () => {
    const manager = new MCPClientManager({
      version: '1.0.0',
      servers: {},
    });
    const tools = await manager.getToolsByServer('nonexistent');
    assert.deepEqual(tools, []);
  });

  it('should return undefined for non-existent server config', () => {
    const manager = new MCPClientManager({
      version: '1.0.0',
      servers: {},
    });
    assert.equal(manager.getServerConfig('nonexistent'), undefined);
  });

  it('should return empty schemas for non-existent server', async () => {
    const manager = new MCPClientManager({
      version: '1.0.0',
      servers: {},
    });
    const schemas = await manager.getServerToolSchemas('nonexistent');
    assert.deepEqual(schemas, []);
  });

  it('should throw when calling tool on non-existent server', async () => {
    const manager = new MCPClientManager({
      version: '1.0.0',
      servers: {},
    });
    await assert.rejects(
      () => manager.callTool('nonexistent', 'tool', {}),
      { message: 'MCP server "nonexistent" not found' },
    );
  });

  it('should skip disabled servers during initialize', async () => {
    const manager = new MCPClientManager({
      version: '1.0.0',
      servers: {
        disabled: {
          transport: 'streamable-http' as const,
          url: 'http://localhost:9999',
          enabled: false,
          timeout: 1000,
        },
      },
    });

    await manager.initialize();
    assert.deepEqual(manager.getServerNames(), []);
  });

  it('should close cleanly with no connections', async () => {
    const manager = new MCPClientManager({
      version: '1.0.0',
      servers: {},
    });
    await manager.close();
    assert.deepEqual(manager.getServerNames(), []);
  });

  it('should warn on connection failure without throwOnLoadError', async () => {
    const manager = new MCPClientManager({
      version: '1.0.0',
      servers: {
        broken: {
          transport: 'streamable-http' as const,
          url: 'http://localhost:1',
          enabled: true,
          timeout: 500,
        },
      },
    });

    // Should not throw - logs warning instead
    await manager.initialize();
    assert.deepEqual(manager.getServerNames(), []);
  });

  it('should throw on connection failure with throwOnLoadError', async () => {
    const manager = new MCPClientManager({
      version: '1.0.0',
      servers: {
        broken: {
          transport: 'streamable-http' as const,
          url: 'http://localhost:1',
          enabled: true,
          timeout: 500,
        },
      },
      globalOptions: {
        throwOnLoadError: true,
        prefixToolNameWithServerName: true,
        additionalToolNamePrefix: '',
        defaultToolTimeout: 30000,
      },
    });

    await assert.rejects(() => manager.initialize());
  });

  it('should get tools from injected connection', async () => {
    const manager = new MCPClientManager({ version: '1.0.0', servers: {} });

    // Inject a mock connection
    const mockClient = {
      listTools: async () => ({
        tools: [
          { name: 'test-tool', description: 'A test tool', inputSchema: { properties: { query: { type: 'string' } } } },
        ],
      }),
      callTool: async () => ({ isError: false, content: [{ text: 'result' }] }),
      close: async () => {},
    };
    const mockConfig = { transport: 'streamable-http', url: 'http://test' };
    (manager as any).connections.set('test-server', { client: mockClient, config: mockConfig });

    const tools = await manager.getToolsByServer('test-server');
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.name, 'test-tool');

    // Should cache tools
    const toolsCached = await manager.getToolsByServer('test-server');
    assert.equal(toolsCached.length, 1);
  });

  it('should get server names from connections', () => {
    const manager = new MCPClientManager({ version: '1.0.0', servers: {} });
    (manager as any).connections.set('s1', { client: {}, config: {} });
    (manager as any).connections.set('s2', { client: {}, config: {} });

    const names = manager.getServerNames();
    assert.deepEqual(names.sort(), ['s1', 's2']);
  });

  it('should get server config from connection', () => {
    const manager = new MCPClientManager({ version: '1.0.0', servers: {} });
    const config = { transport: 'stdio', command: 'node' };
    (manager as any).connections.set('s1', { client: {}, config });

    assert.deepEqual(manager.getServerConfig('s1'), config);
  });

  it('should get tool schemas from connection', async () => {
    const manager = new MCPClientManager({ version: '1.0.0', servers: {} });
    const mockClient = {
      listTools: async () => ({
        tools: [
          { name: 'tool1', description: 'desc1', inputSchema: { type: 'object' } },
          { name: 'tool2', inputSchema: {} },
        ],
      }),
    };
    (manager as any).connections.set('server', { client: mockClient, config: {} });

    const schemas = await manager.getServerToolSchemas('server');
    assert.equal(schemas.length, 2);
    assert.equal(schemas[0]!.name, 'tool1');
    assert.equal(schemas[0]!.description, 'desc1');
  });

  it('should call tool on connection and extract content', async () => {
    const manager = new MCPClientManager({ version: '1.0.0', servers: {} });
    const mockClient = {
      callTool: async () => ({
        isError: false,
        content: [{ text: 'hello' }, { text: 'world' }],
      }),
    };
    (manager as any).connections.set('server', { client: mockClient, config: {} });

    const result = await manager.callTool('server', 'tool1', { arg: 'val' });
    assert.equal(result, 'hello\nworld');
  });

  it('should throw on error result from callTool', async () => {
    const manager = new MCPClientManager({ version: '1.0.0', servers: {} });
    const mockClient = {
      callTool: async () => ({
        isError: true,
        content: 'Something went wrong',
      }),
    };
    (manager as any).connections.set('server', { client: mockClient, config: {} });

    await assert.rejects(
      () => manager.callTool('server', 'tool1', {}),
      { message: 'Something went wrong' },
    );
  });

  it('should extract content from non-array', () => {
    const manager = new MCPClientManager({ version: '1.0.0', servers: {} });
    const result = (manager as any).extractContent('plain string');
    assert.equal(result, 'plain string');
  });

  it('should extract content from array with non-text items', () => {
    const manager = new MCPClientManager({ version: '1.0.0', servers: {} });
    const result = (manager as any).extractContent([42, { text: 'hello' }, 'raw']);
    assert.equal(result, '42\nhello\nraw');
  });

  it('should convert JSON schema to Zod with various types', () => {
    const manager = new MCPClientManager({ version: '1.0.0', servers: {} });
    const schema = {
      properties: {
        name: { type: 'string', description: 'The name' },
        age: { type: 'integer' },
        active: { type: 'boolean' },
        tags: { type: 'array' },
        meta: { type: 'object' },
        other: { type: 'custom' },
      },
      required: ['name'],
    };

    const zodSchema = (manager as any).convertJsonSchemaToZod(schema);
    assert.ok(zodSchema);

    // Verify required field validation
    const parsed = zodSchema.safeParse({ name: 'test' });
    assert.ok(parsed.success);

    // Missing required field should fail
    const failed = zodSchema.safeParse({});
    assert.ok(!failed.success);
  });

  it('should convert empty JSON schema to Zod', () => {
    const manager = new MCPClientManager({ version: '1.0.0', servers: {} });
    const zodSchema = (manager as any).convertJsonSchemaToZod({});
    assert.ok(zodSchema);
    const parsed = zodSchema.safeParse({});
    assert.ok(parsed.success);
  });

  it('should get all tools from all connections', async () => {
    const manager = new MCPClientManager({ version: '1.0.0', servers: {} });
    const makeMockClient = (toolName: string) => ({
      listTools: async () => ({
        tools: [{ name: toolName, inputSchema: {} }],
      }),
    });
    (manager as any).connections.set('s1', { client: makeMockClient('tool-a'), config: {} });
    (manager as any).connections.set('s2', { client: makeMockClient('tool-b'), config: {} });

    const tools = await manager.getTools();
    assert.equal(tools.length, 2);
    const names = tools.map(t => t.name).sort();
    assert.deepEqual(names, ['tool-a', 'tool-b']);
  });

  it('should close connections and clear caches', async () => {
    const manager = new MCPClientManager({ version: '1.0.0', servers: {} });
    let closed = false;
    (manager as any).connections.set('s1', { client: { close: async () => { closed = true; } }, config: {} });
    (manager as any).toolsCache.set('s1', []);

    await manager.close();
    assert.ok(closed);
    assert.equal(manager.getServerNames().length, 0);
  });

  it('should prefix tool names when globalOptions.prefixToolNameWithServerName', async () => {
    const manager = new MCPClientManager({
      version: '1.0.0',
      servers: {},
      globalOptions: {
        prefixToolNameWithServerName: true,
        throwOnLoadError: false,
        additionalToolNamePrefix: '',
        defaultToolTimeout: 30000,
      },
    });
    const mockClient = {
      listTools: async () => ({
        tools: [{ name: 'search', description: 'Search', inputSchema: {} }],
      }),
    };
    (manager as any).connections.set('myserver', { client: mockClient, config: {} });

    const tools = await manager.getToolsByServer('myserver');
    assert.equal(tools[0]!.name, 'myserver_search');
  });
});
