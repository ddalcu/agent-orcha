import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { AgentToolWrapper } from '../../lib/tools/agent-tool-wrapper.ts';

describe('AgentToolWrapper', () => {
  const mockDefinition = {
    name: 'helper',
    description: 'A helper agent',
    prompt: { system: 'You are helpful. Answer questions clearly.', inputVariables: [] },
    tools: [],
  } as any;

  const mockExecutor = {
    createInstance: async () => ({
      invoke: async () => ({ output: 'Tool result', metadata: { duration: 10 } }),
    }),
  } as any;

  it('should create a tool from an agent definition', () => {
    const tool = AgentToolWrapper.createTool('helper', mockDefinition, mockExecutor);

    assert.equal(tool.name, 'agent_helper');
    assert.ok(tool.description.includes('A helper agent'));
  });

  it('should invoke the tool and return agent output', async () => {
    const tool = AgentToolWrapper.createTool('helper', mockDefinition, mockExecutor);
    const result = await tool.invoke({ input: 'What is 2+2?' });

    assert.equal(result, 'Tool result');
  });

  it('should return error string on failure', async () => {
    const failExecutor = {
      createInstance: async () => ({
        invoke: async () => { throw new Error('Agent crashed'); },
      }),
    } as any;

    const tool = AgentToolWrapper.createTool('helper', mockDefinition, failExecutor);
    const result = await tool.invoke({ input: 'test' });

    assert.ok(result.includes('Error'));
    assert.ok(result.includes('Agent crashed'));
  });

  it('should create tools for multiple agents', async () => {
    const mockLoader = {
      get: (name: string) => name === 'a1' || name === 'a2' ? { ...mockDefinition, name } : undefined,
    } as any;

    const tools = await AgentToolWrapper.createTools(['a1', 'a2', 'missing'], mockLoader, mockExecutor);

    assert.equal(tools.length, 2);
    assert.equal(tools[0]!.name, 'agent_a1');
    assert.equal(tools[1]!.name, 'agent_a2');
  });

  it('should create tools for all agents', async () => {
    const mockLoader = {
      names: () => ['a1', 'a2'],
      get: (name: string) => ({ ...mockDefinition, name }),
    } as any;

    const tools = await AgentToolWrapper.createAllTools(mockLoader, mockExecutor);

    assert.equal(tools.length, 2);
  });

  it('should stringify non-string outputs', async () => {
    const objExecutor = {
      createInstance: async () => ({
        invoke: async () => ({ output: { key: 'value' }, metadata: { duration: 10 } }),
      }),
    } as any;

    const tool = AgentToolWrapper.createTool('helper', mockDefinition, objExecutor);
    const result = await tool.invoke({ input: 'test' });

    assert.equal(result, '{"key":"value"}');
  });
});
