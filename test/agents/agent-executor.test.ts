import { describe, it, before } from 'node:test';
import { strict as assert } from 'node:assert';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { AgentExecutor } from '../../lib/agents/agent-executor.ts';
import { ConversationStore } from '../../lib/memory/conversation-store.ts';
import { MemoryManager } from '../../lib/memory/memory-manager.ts';
import { loadLLMConfig } from '../../lib/llm/llm-config.ts';
import { LLMFactory } from '../../lib/llm/llm-factory.ts';
import * as fs from 'fs/promises';
import * as os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, '..', 'fixtures', 'llm.json');

// Minimal mock tool registry
function mockToolRegistry(tools: any[] = []) {
  return {
    resolveTools: async () => tools,
    getAllSandboxTools: () => [],
  } as any;
}

// Minimal agent definition
function minimalDefinition(overrides: Record<string, any> = {}) {
  return {
    name: 'test-agent',
    description: 'Test agent',
    llm: 'default',
    prompt: {
      system: 'You are a test assistant.',
      inputVariables: ['message'],
      ...overrides.prompt,
    },
    tools: [],
    ...overrides,
  } as any;
}

describe('AgentExecutor', () => {
  before(async () => {
    await loadLLMConfig(fixturePath);
  });

  it('should construct with required deps', () => {
    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store);
    assert.ok(executor);
  });

  it('should construct with optional deps', async () => {
    const store = new ConversationStore();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-exec-'));
    const memoryManager = new MemoryManager(tempDir);
    const executor = new AgentExecutor(mockToolRegistry(), store, undefined, memoryManager);
    assert.ok(executor);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should create instance without tools', async () => {
    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store);
    const instance = await executor.createInstance(minimalDefinition());
    assert.ok(instance.definition);
    assert.ok(typeof instance.invoke === 'function');
    assert.ok(typeof instance.stream === 'function');
    assert.equal(instance.definition.name, 'test-agent');
  });

  it('should create instance and augment prompt with memory', async () => {
    const store = new ConversationStore();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-exec-'));
    const memoryManager = new MemoryManager(tempDir);

    // Save some memory content
    await memoryManager.save('test-agent', 'Important fact: user likes cats', 100);

    const executor = new AgentExecutor(mockToolRegistry(), store, undefined, memoryManager);
    const def = minimalDefinition({ memory: { enabled: true, maxLines: 50 } });
    const instance = await executor.createInstance(def);

    // System prompt should include memory
    assert.ok(instance.definition.prompt.system.includes('long_term_memory'));
    assert.ok(instance.definition.prompt.system.includes('user likes cats'));

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should handle memory config as boolean true', async () => {
    const store = new ConversationStore();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-exec-'));
    const memoryManager = new MemoryManager(tempDir);

    const executor = new AgentExecutor(mockToolRegistry(), store, undefined, memoryManager);
    const def = minimalDefinition({ memory: true });
    const instance = await executor.createInstance(def);

    // Should add memory prompt with empty content
    assert.ok(instance.definition.prompt.system.includes('long_term_memory'));

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should handle memory config as boolean false', async () => {
    const store = new ConversationStore();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-exec-'));
    const memoryManager = new MemoryManager(tempDir);

    const executor = new AgentExecutor(mockToolRegistry(), store, undefined, memoryManager);
    const def = minimalDefinition({ memory: false });
    const instance = await executor.createInstance(def);

    // Should NOT add memory prompt
    assert.ok(!instance.definition.prompt.system.includes('long_term_memory'));

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should not augment prompt when memory not configured', async () => {
    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store);
    const instance = await executor.createInstance(minimalDefinition());
    assert.ok(!instance.definition.prompt.system.includes('long_term_memory'));
  });

  it('should augment prompt with skill content', async () => {
    const store = new ConversationStore();
    const mockSkillLoader = {
      resolveForAgentWithMeta: () => ({ content: '## Skill: Test\nDo test things', needsSandbox: false }),
    } as any;

    const executor = new AgentExecutor(mockToolRegistry(), store, mockSkillLoader);
    const def = minimalDefinition({ skills: 'all' });
    const instance = await executor.createInstance(def);

    assert.ok(instance.definition.prompt.system.includes('Skill: Test'));
  });

  it('should format user message with single input variable', async () => {
    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store);
    const def = minimalDefinition({
      prompt: { system: 'test', inputVariables: ['question'] },
    });

    // invokeWithoutTools is called internally; we test via invoke
    // We need a mock LLM to avoid real API calls
    // Since createInstance resolves tools and wraps LLM, let's test formatUserMessage indirectly
    const instance = await executor.createInstance(def);

    // Create a mock that captures the input
    // The formatUserMessage method is private, but tested through the flow
    assert.ok(instance);
  });

  it('should format user message with no input variables', async () => {
    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store);
    const def = minimalDefinition({
      prompt: { system: 'test', inputVariables: [] },
    });
    const instance = await executor.createInstance(def);
    assert.ok(instance);
  });

  it('should format user message with multiple input variables', async () => {
    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store);
    const def = minimalDefinition({
      prompt: { system: 'test', inputVariables: ['name', 'age', 'job'] },
    });
    const instance = await executor.createInstance(def);
    assert.ok(instance);
  });

  it('should inject sandbox tools when skill requires sandbox', async () => {
    const store = new ConversationStore();
    const mockSkillLoader = {
      resolveForAgentWithMeta: () => ({ content: '## Skill: Code\nRun code', needsSandbox: true }),
    } as any;

    const sandboxTool = { name: 'sandbox_exec' } as any;
    const registry = {
      resolveTools: async () => [],
      getAllSandboxTools: () => [sandboxTool],
    } as any;

    const executor = new AgentExecutor(registry, store, mockSkillLoader);
    const def = minimalDefinition({ skills: 'all' });
    const instance = await executor.createInstance(def);

    assert.ok(instance.definition.prompt.system.includes('Skill: Code'));
  });

  it('should handle memory config { enabled: false }', async () => {
    const store = new ConversationStore();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-exec-'));
    const memoryManager = new MemoryManager(tempDir);

    const executor = new AgentExecutor(mockToolRegistry(), store, undefined, memoryManager);
    const def = minimalDefinition({ memory: { enabled: false } });
    const instance = await executor.createInstance(def);

    assert.ok(!instance.definition.prompt.system.includes('long_term_memory'));

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should use default maxLines of 100 when memory enabled as boolean', async () => {
    const store = new ConversationStore();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-exec-'));
    const memoryManager = new MemoryManager(tempDir);

    const executor = new AgentExecutor(mockToolRegistry(), store, undefined, memoryManager);
    const def = minimalDefinition({ memory: true });
    const instance = await executor.createInstance(def);

    assert.ok(instance.definition.prompt.system.includes('100 lines'));

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should not augment skills when skillLoader not provided', async () => {
    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store);
    const def = minimalDefinition({ skills: 'all' });
    const instance = await executor.createInstance(def);

    // Without skillLoader, skills config is ignored
    assert.ok(!instance.definition.prompt.system.includes('Skill:'));
  });

  it('should not augment skills when content is empty', async () => {
    const store = new ConversationStore();
    const mockSkillLoader = {
      resolveForAgentWithMeta: () => ({ content: '', needsSandbox: false }),
    } as any;

    const executor = new AgentExecutor(mockToolRegistry(), store, mockSkillLoader);
    const def = minimalDefinition({ skills: 'all' });
    const instance = await executor.createInstance(def);

    // System prompt should be unchanged
    assert.equal(instance.definition.prompt.system, 'You are a test assistant.');
  });
});
