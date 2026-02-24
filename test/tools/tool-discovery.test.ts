import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { ToolDiscovery } from '../../lib/tools/tool-discovery.ts';

function mockTool(name: string) {
  return { name, description: `Tool ${name}`, invoke: async () => 'result' } as any;
}

describe('ToolDiscovery', () => {
  const mockRegistry = {} as any;

  const mockMCP = {
    getServerNames: () => ['server1'],
    getToolsByServer: async () => [mockTool('mcp-search')],
  } as any;

  const mockKnowledge = {
    listConfigs: () => [],
    get: () => undefined,
    initialize: async () => ({ config: {} }),
  } as any;

  const mockFunctions = {
    list: () => [{ tool: mockTool('my-func') }],
  } as any;

  const mockAgentLoader = {
    names: () => ['agent1', 'agent2'],
    get: (name: string) => ({
      name,
      description: `Agent ${name}`,
      prompt: { system: 'System prompt', inputVariables: [] },
      tools: [],
    }),
  } as any;

  const mockExecutor = {
    createInstance: async () => ({
      invoke: async () => ({ output: 'result', metadata: { duration: 0 } }),
    }),
  } as any;

  function createDiscovery() {
    return new ToolDiscovery(
      mockRegistry,
      mockMCP,
      mockKnowledge,
      mockFunctions,
      mockAgentLoader,
      mockExecutor
    );
  }

  it('should discover MCP tools', async () => {
    const discovery = createDiscovery();
    const tools = await discovery.discoverAll({
      mode: 'all',
      sources: ['mcp'],
    });

    assert.ok(tools.some(t => t.name === 'mcp-search'));
  });

  it('should discover function tools', async () => {
    const discovery = createDiscovery();
    const tools = await discovery.discoverAll({
      mode: 'all',
      sources: ['function'],
    });

    assert.ok(tools.some(t => t.name === 'my-func'));
  });

  it('should discover builtin tools', async () => {
    const discovery = createDiscovery();
    const tools = await discovery.discoverAll({
      mode: 'all',
      sources: ['builtin'],
    });

    assert.ok(tools.some(t => t.name === 'ask_user'));
  });

  it('should filter tools with mode:none', async () => {
    const discovery = createDiscovery();
    const tools = await discovery.discoverAll({
      mode: 'none',
      sources: ['mcp', 'function'],
    });

    assert.equal(tools.length, 0);
  });

  it('should filter tools with mode:include', async () => {
    const discovery = createDiscovery();
    const tools = await discovery.discoverAll({
      mode: 'include',
      sources: ['mcp', 'function'],
      include: ['my-func'],
    });

    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.name, 'my-func');
  });

  it('should filter tools with mode:exclude', async () => {
    const discovery = createDiscovery();
    const tools = await discovery.discoverAll({
      mode: 'exclude',
      sources: ['function'],
      exclude: ['my-func'],
    });

    assert.equal(tools.length, 0);
  });

  it('should discover agent tools with mode:all', async () => {
    const discovery = createDiscovery();
    const tools = await discovery.discoverAgents({ mode: 'all' });

    assert.equal(tools.length, 2);
    assert.ok(tools.some(t => t.name === 'agent_agent1'));
    assert.ok(tools.some(t => t.name === 'agent_agent2'));
  });

  it('should return empty for agent mode:none', async () => {
    const discovery = createDiscovery();
    const tools = await discovery.discoverAgents({ mode: 'none' });

    assert.equal(tools.length, 0);
  });

  it('should include specific agents', async () => {
    const discovery = createDiscovery();
    const tools = await discovery.discoverAgents({
      mode: 'include',
      include: ['agent1'],
    });

    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.name, 'agent_agent1');
  });

  it('should exclude specific agents', async () => {
    const discovery = createDiscovery();
    const tools = await discovery.discoverAgents({
      mode: 'exclude',
      exclude: ['agent2'],
    });

    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.name, 'agent_agent1');
  });

  it('should discover knowledge tools when stores have configs', async () => {
    const storeInstance = {
      config: { name: 'kb1', kind: 'vector', source: { type: 'file' } },
      search: async () => [],
      getMetadata: () => ({ documentCount: 5 }),
    };

    const knowledgeWithConfigs = {
      listConfigs: () => [{ name: 'kb1', kind: 'vector' }],
      get: () => storeInstance,
      initialize: async () => storeInstance,
      getSqliteStore: () => undefined,
    } as any;

    const discovery = new ToolDiscovery(
      mockRegistry, mockMCP, knowledgeWithConfigs, mockFunctions, mockAgentLoader, mockExecutor
    );

    const tools = await discovery.discoverAll({
      mode: 'all',
      sources: ['knowledge'],
    });

    assert.ok(tools.length > 0);
  });

  it('should handle knowledge discovery errors gracefully', async () => {
    const failingKnowledge = {
      listConfigs: () => { throw new Error('DB error'); },
    } as any;

    const discovery = new ToolDiscovery(
      mockRegistry, mockMCP, failingKnowledge, mockFunctions, mockAgentLoader, mockExecutor
    );

    const tools = await discovery.discoverAll({
      mode: 'all',
      sources: ['knowledge'],
    });

    assert.equal(tools.length, 0);
  });

  it('should handle function discovery errors gracefully', async () => {
    const failingFunctions = {
      list: () => { throw new Error('FS error'); },
    } as any;

    const discovery = new ToolDiscovery(
      mockRegistry, mockMCP, mockKnowledge, failingFunctions, mockAgentLoader, mockExecutor
    );

    const tools = await discovery.discoverAll({
      mode: 'all',
      sources: ['function'],
    });

    assert.equal(tools.length, 0);
  });

  it('should discover all sources at once', async () => {
    const discovery = createDiscovery();
    const tools = await discovery.discoverAll({
      mode: 'all',
      sources: ['mcp', 'function', 'builtin'],
    });

    assert.ok(tools.length >= 3); // at least mcp + function + builtin ask_user
  });
});
