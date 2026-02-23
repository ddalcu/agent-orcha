import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { ToolRegistry } from '../../lib/tools/tool-registry.ts';

function mockTool(name: string) {
  return { name, description: `Tool ${name}`, invoke: async () => 'result' } as any;
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  const mockMCP = {
    getToolsByServer: async (name: string) => name === 'server1' ? [mockTool('mcp-tool')] : [],
    getServerNames: () => ['server1'],
  } as any;

  const mockKnowledge = {
    get: (name: string) => name === 'kb1' ? { config: { kind: 'vector' } } : undefined,
    initialize: async () => ({ config: { kind: 'vector' } }),
    listConfigs: () => [],
    getSqliteStore: () => undefined,
  } as any;

  const mockFunctions = {
    getTool: (name: string) => name === 'greet' ? mockTool('greet') : undefined,
    list: () => [{ tool: mockTool('greet') }],
  } as any;

  beforeEach(() => {
    const sandboxTools = new Map([['exec', mockTool('sandbox_exec')]]);
    const workspaceTools = new Map([['list', mockTool('workspace_list')]]);
    registry = new ToolRegistry(mockMCP, mockKnowledge, mockFunctions, sandboxTools, workspaceTools);
  });

  it('should resolve function tool by string ref', async () => {
    const tools = await registry.resolveTools(['function:greet']);
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.name, 'greet');
  });

  it('should resolve mcp tools by string ref', async () => {
    const tools = await registry.resolveTools(['mcp:server1']);
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.name, 'mcp-tool');
  });

  it('should resolve sandbox tool by string ref', async () => {
    const tools = await registry.resolveTools(['sandbox:exec']);
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.name, 'sandbox_exec');
  });

  it('should resolve workspace tool by string ref', async () => {
    const tools = await registry.resolveTools(['workspace:list']);
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.name, 'workspace_list');
  });

  it('should return empty for non-existent function', async () => {
    const tools = await registry.resolveTools(['function:nonexistent']);
    assert.equal(tools.length, 0);
  });

  it('should return empty for unknown source', async () => {
    const tools = await registry.resolveTools(['unknown:foo']);
    assert.equal(tools.length, 0);
  });

  it('should resolve object ref by converting to string', async () => {
    const tools = await registry.resolveTools([{ name: 'greet', source: 'function' } as any]);
    assert.equal(tools.length, 1);
  });

  it('should register and resolve built-in tools', async () => {
    const myTool = mockTool('my-builtin');
    registry.registerBuiltIn('my-builtin', myTool);

    const tools = await registry.resolveTools(['builtin:my-builtin']);
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.name, 'my-builtin');
  });

  it('should resolve bare name as built-in', async () => {
    const myTool = mockTool('bare-tool');
    registry.registerBuiltIn('bare-tool', myTool);

    const tools = await registry.resolveTools(['bare-tool']);
    assert.equal(tools.length, 1);
  });

  it('should unregister built-in tools', () => {
    registry.registerBuiltIn('temp', mockTool('temp'));
    assert.ok(registry.listBuiltIn().includes('temp'));

    registry.unregisterBuiltIn('temp');
    assert.ok(!registry.listBuiltIn().includes('temp'));
  });

  it('should list built-in tools', () => {
    registry.registerBuiltIn('b1', mockTool('b1'));
    registry.registerBuiltIn('b2', mockTool('b2'));

    const names = registry.listBuiltIn();
    assert.ok(names.includes('b1'));
    assert.ok(names.includes('b2'));
  });

  it('should get all function tools', () => {
    const tools = registry.getAllFunctionTools();
    assert.equal(tools.length, 1);
  });

  it('should get all built-in tools', () => {
    registry.registerBuiltIn('x', mockTool('x'));
    const tools = registry.getAllBuiltInTools();
    assert.ok(tools.length >= 1);
  });

  it('should get all sandbox tools', () => {
    const tools = registry.getAllSandboxTools();
    assert.equal(tools.length, 1);
  });

  it('should get all workspace tools', () => {
    const tools = registry.getAllWorkspaceTools();
    assert.equal(tools.length, 1);
  });

  it('should get all MCP tools from all servers', async () => {
    const tools = await registry.getAllMCPTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.name, 'mcp-tool');
  });

  it('should handle MCP server errors in getAllMCPTools', async () => {
    const failingMCP = {
      getToolsByServer: async () => { throw new Error('Connection failed'); },
      getServerNames: () => ['bad-server'],
    } as any;
    const reg = new ToolRegistry(failingMCP, mockKnowledge, mockFunctions);
    const tools = await reg.getAllMCPTools();
    assert.equal(tools.length, 0);
  });

  it('should return empty for non-existent sandbox tool', async () => {
    const tools = await registry.resolveTools(['sandbox:nonexistent']);
    assert.equal(tools.length, 0);
  });

  it('should return empty for non-existent workspace tool', async () => {
    const tools = await registry.resolveTools(['workspace:nonexistent']);
    assert.equal(tools.length, 0);
  });

  it('should return empty for bare name without registration', async () => {
    const tools = await registry.resolveTools(['non-registered']);
    assert.equal(tools.length, 0);
  });

  it('should resolve knowledge tool when store exists', async () => {
    const mockStore = {
      config: { name: 'kb1', kind: 'vector', source: { type: 'directory' }, store: { type: 'memory' } },
      search: async () => [],
    };
    const knowledgeWithStore = {
      get: (name: string) => name === 'kb1' ? mockStore : undefined,
      initialize: async () => mockStore,
      listConfigs: () => [{ name: 'kb1', kind: 'vector' }],
      getSqliteStore: () => undefined,
    } as any;
    const reg = new ToolRegistry(mockMCP, knowledgeWithStore, mockFunctions);
    const tools = await reg.resolveTools(['knowledge:kb1']);
    assert.ok(tools.length >= 1);
  });

  it('should resolve knowledge tool when store needs initialization', async () => {
    const mockStore = {
      config: { name: 'kb2', kind: 'vector', source: { type: 'directory' }, store: { type: 'memory' } },
      search: async () => [],
    };
    let initialized = false;
    const knowledgeNeedInit = {
      get: () => initialized ? mockStore : undefined,
      initialize: async () => { initialized = true; return mockStore; },
      listConfigs: () => [],
      getSqliteStore: () => undefined,
    } as any;
    const reg = new ToolRegistry(mockMCP, knowledgeNeedInit, mockFunctions);
    const tools = await reg.resolveTools(['knowledge:kb2']);
    assert.ok(tools.length >= 1);
  });

  it('should return empty when knowledge store initialization returns nothing', async () => {
    const knowledgeNoStore = {
      get: () => undefined,
      initialize: async () => undefined,
      listConfigs: () => [],
      getSqliteStore: () => undefined,
    } as any;
    const reg = new ToolRegistry(mockMCP, knowledgeNoStore, mockFunctions);
    const tools = await reg.resolveTools(['knowledge:missing']);
    assert.equal(tools.length, 0);
  });

  it('should get all knowledge tools', async () => {
    const mockStore = {
      config: { name: 'kb1', kind: 'vector', source: { type: 'directory' }, store: { type: 'memory' } },
      search: async () => [],
    };
    const knowledgeWithConfigs = {
      get: () => mockStore,
      initialize: async () => mockStore,
      listConfigs: () => [{ name: 'kb1', kind: 'vector' }],
      getSqliteStore: () => undefined,
    } as any;
    const reg = new ToolRegistry(mockMCP, knowledgeWithConfigs, mockFunctions);
    const tools = await reg.getAllKnowledgeTools();
    assert.ok(tools.length >= 1);
  });

  it('should handle errors in getAllKnowledgeTools', async () => {
    const knowledgeFailing = {
      get: () => undefined,
      initialize: async () => { throw new Error('Init failed'); },
      listConfigs: () => [{ name: 'broken-kb' }],
      getSqliteStore: () => undefined,
    } as any;
    const reg = new ToolRegistry(mockMCP, knowledgeFailing, mockFunctions);
    const tools = await reg.getAllKnowledgeTools();
    assert.equal(tools.length, 0);
  });
});
