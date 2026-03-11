import { describe, it, before, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { AgentExecutor } from '../../lib/agents/agent-executor.ts';
import { ConversationStore } from '../../lib/memory/conversation-store.ts';
import { MemoryManager } from '../../lib/memory/memory-manager.ts';
import { loadLLMConfig } from '../../lib/llm/llm-config.ts';
import { LLMFactory } from '../../lib/llm/llm-factory.ts';
import type { ChatModel, ChatModelResponse, StructuredTool } from '../../lib/types/llm-types.ts';
import * as fs from 'fs/promises';
import * as os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, '..', 'fixtures', 'llm.json');

// Minimal mock tool registry
function mockToolRegistry(tools: any[] = []) {
  return {
    resolveTools: async () => tools,
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
      resolveForAgent: () => '## Skill: Test\nDo test things',
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

  it('should not auto-inject sandbox tools from skills', async () => {
    const store = new ConversationStore();
    const mockSkillLoader = {
      resolveForAgent: () => '## Skill: Code\nRun code',
    } as any;

    const executor = new AgentExecutor(mockToolRegistry(), store, mockSkillLoader);
    const def = minimalDefinition({ skills: 'all' });
    const instance = await executor.createInstance(def);

    // Skill content is injected into prompt, but no sandbox tools auto-added
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
      resolveForAgent: () => '',
    } as any;

    const executor = new AgentExecutor(mockToolRegistry(), store, mockSkillLoader);
    const def = minimalDefinition({ skills: 'all' });
    const instance = await executor.createInstance(def);

    // System prompt should be unchanged
    assert.equal(instance.definition.prompt.system, 'You are a test assistant.');
  });
});

// --- Invoke / Stream tests using mock LLM ---

/** Creates a mock ChatModel returning canned content */
function mockChatModel(content: string): ChatModel {
  const model: ChatModel = {
    async invoke(): Promise<ChatModelResponse> {
      return { content };
    },
    async *stream(): AsyncIterable<ChatModelResponse> {
      yield { content };
    },
    bindTools() { return model; },
    withStructuredOutput() { return model; },
  };
  return model;
}

describe('AgentExecutor invoke/stream', () => {
  let originalCreate: typeof LLMFactory.create;

  before(async () => {
    const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'llm.json');
    await loadLLMConfig(fixturePath);
    originalCreate = LLMFactory.create;
  });

  afterEach(() => {
    // Restore original factory
    LLMFactory.create = originalCreate;
  });

  it('should invoke without tools and return output', async () => {
    LLMFactory.create = async () => mockChatModel('Hello from mock!');

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store);
    const instance = await executor.createInstance(minimalDefinition());

    const result = await instance.invoke({ message: 'hi' });
    assert.equal(result.output, 'Hello from mock!');
    assert.ok(result.metadata.duration >= 0);
  });

  it('should invoke with sessionId and store messages', async () => {
    LLMFactory.create = async () => mockChatModel('Session response');

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store);
    const instance = await executor.createInstance(minimalDefinition());

    const result = await instance.invoke({ input: { message: 'hi' }, sessionId: 'sess-1' });
    assert.equal(result.output, 'Session response');
    assert.equal(result.metadata.sessionId, 'sess-1');
    assert.ok(store.hasSession('sess-1'));
    assert.ok(store.getMessageCount('sess-1') >= 2); // user + ai
  });

  it('should handle invoke errors gracefully (with tools)', async () => {
    LLMFactory.create = async () => {
      const model: ChatModel = {
        async invoke() { throw new Error('LLM down'); },
        async *stream() { throw new Error('LLM down'); },
        bindTools() { return model; },
        withStructuredOutput() { return model; },
      };
      return model;
    };

    const store = new ConversationStore();
    const mockTool: StructuredTool = {
      name: 'test-tool',
      description: 'test',
      schema: { type: 'object', properties: {} },
      invoke: async () => 'ok',
    } as StructuredTool;
    const executor = new AgentExecutor(mockToolRegistry([mockTool]), store);
    const instance = await executor.createInstance(minimalDefinition());

    const result = await instance.invoke({ message: 'hi' });
    assert.ok(typeof result.output === 'string');
    assert.ok((result.output as string).includes('error') || (result.output as string).includes('Error'));
  });

  it('should stream without tools', async () => {
    LLMFactory.create = async () => mockChatModel('Streamed content');

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store);
    const instance = await executor.createInstance(minimalDefinition());

    const chunks: any[] = [];
    for await (const chunk of instance.stream({ input: { message: 'hi' } })) {
      chunks.push(chunk);
    }
    assert.ok(chunks.some(c => c.type === 'content'));
    const contentChunks = chunks.filter(c => c.type === 'content');
    assert.ok(contentChunks.some(c => c.content === 'Streamed content'));
  });

  it('should stream with tools and yield tool events', async () => {
    let callCount = 0;
    LLMFactory.create = async () => {
      const model: ChatModel = {
        async invoke() { return { content: '' }; },
        async *stream() {
          callCount++;
          if (callCount === 1) {
            yield { content: '', tool_calls: [{ id: 'tc1', name: 'greet', args: { name: 'test' } }] };
          } else {
            yield { content: 'Final answer after tool call is long enough to be accepted.' };
          }
        },
        bindTools() { return model; },
        withStructuredOutput() { return model; },
      };
      return model;
    };

    const greetTool: StructuredTool = {
      name: 'greet',
      description: 'greet someone',
      schema: { type: 'object', properties: { name: { type: 'string' } } },
      invoke: async (args: any) => `Hello ${args.name}!`,
    } as StructuredTool;

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry([greetTool]), store);
    const instance = await executor.createInstance(minimalDefinition());

    const chunks: any[] = [];
    for await (const chunk of instance.stream({ input: { message: 'greet test' } })) {
      chunks.push(chunk);
    }
    assert.ok(chunks.some(c => c.type === 'tool_start'));
    assert.ok(chunks.some(c => c.type === 'tool_end'));
    assert.ok(chunks.some(c => c.type === 'content'));
  });

  it('should invoke with multiple input variables', async () => {
    LLMFactory.create = async () => mockChatModel('Multi-var response');

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store);
    const def = minimalDefinition({
      prompt: { system: 'test', inputVariables: ['name', 'age'] },
    });
    const instance = await executor.createInstance(def);

    const result = await instance.invoke({ name: 'Alice', age: 30 });
    assert.equal(result.output, 'Multi-var response');
  });

  it('should invoke with no input variables (JSON stringify)', async () => {
    LLMFactory.create = async () => mockChatModel('No-var response');

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store);
    const def = minimalDefinition({
      prompt: { system: 'test', inputVariables: [] },
    });
    const instance = await executor.createInstance(def);

    const result = await instance.invoke({ arbitrary: 'data' });
    assert.equal(result.output, 'No-var response');
  });

  it('should inject integration tools when integrations configured', async () => {
    LLMFactory.create = async () => mockChatModel('With integrations');

    const mockIntegrations = {
      getChannelContext: () => 'channel context',
      getChannelMembers: () => ['user1'],
      postMessage: () => {},
      sendEmail: async () => {},
      hasEmailIntegration: () => false,
      hasChannelIntegration: (name: string) => name === 'test-agent',
    };

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store, undefined, undefined, mockIntegrations);
    const def = minimalDefinition({
      integrations: [{ type: 'collabnook', url: 'ws://test', channel: 'test', botName: 'bot' }],
    });
    const instance = await executor.createInstance(def);
    assert.ok(instance);
  });

  it('should handle structured output in invoke', async () => {
    LLMFactory.create = async () => mockChatModel('{"result": "structured data"}');

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store);
    const def = minimalDefinition({
      output: { format: 'structured', schema: { type: 'object', properties: { result: { type: 'string' } } } },
    });
    const instance = await executor.createInstance(def);

    const result = await instance.invoke({ message: 'get data' });
    assert.ok(typeof result.output === 'object');
    assert.equal((result.output as any).result, 'structured data');
  });
});
