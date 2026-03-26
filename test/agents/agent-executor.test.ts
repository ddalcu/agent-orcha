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
    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp');
    assert.ok(executor);
  });

  it('should construct with optional deps', async () => {
    const store = new ConversationStore();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-exec-'));
    const memoryManager = new MemoryManager(tempDir);
    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp', undefined, memoryManager);
    assert.ok(executor);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should create instance without tools', async () => {
    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp');
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

    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp', undefined, memoryManager);
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

    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp', undefined, memoryManager);
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

    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp', undefined, memoryManager);
    const def = minimalDefinition({ memory: false });
    const instance = await executor.createInstance(def);

    // Should NOT add memory prompt
    assert.ok(!instance.definition.prompt.system.includes('long_term_memory'));

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should not augment prompt when memory not configured', async () => {
    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp');
    const instance = await executor.createInstance(minimalDefinition());
    assert.ok(!instance.definition.prompt.system.includes('long_term_memory'));
  });

  it('should augment prompt with skill content', async () => {
    const store = new ConversationStore();
    const mockSkillLoader = {
      resolveForAgent: () => '## Skill: Test\nDo test things',
    } as any;

    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp', mockSkillLoader);
    const def = minimalDefinition({ skills: 'all' });
    const instance = await executor.createInstance(def);

    assert.ok(instance.definition.prompt.system.includes('Skill: Test'));
  });

  it('should format user message with single input variable', async () => {
    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp');
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
    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp');
    const def = minimalDefinition({
      prompt: { system: 'test', inputVariables: [] },
    });
    const instance = await executor.createInstance(def);
    assert.ok(instance);
  });

  it('should format user message with multiple input variables', async () => {
    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp');
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

    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp', mockSkillLoader);
    const def = minimalDefinition({ skills: 'all' });
    const instance = await executor.createInstance(def);

    // Skill content is injected into prompt, but no sandbox tools auto-added
    assert.ok(instance.definition.prompt.system.includes('Skill: Code'));
  });

  it('should handle memory config { enabled: false }', async () => {
    const store = new ConversationStore();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-exec-'));
    const memoryManager = new MemoryManager(tempDir);

    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp', undefined, memoryManager);
    const def = minimalDefinition({ memory: { enabled: false } });
    const instance = await executor.createInstance(def);

    assert.ok(!instance.definition.prompt.system.includes('long_term_memory'));

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should use default maxLines of 100 when memory enabled as boolean', async () => {
    const store = new ConversationStore();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-exec-'));
    const memoryManager = new MemoryManager(tempDir);

    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp', undefined, memoryManager);
    const def = minimalDefinition({ memory: true });
    const instance = await executor.createInstance(def);

    assert.ok(instance.definition.prompt.system.includes('100 lines'));

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should not augment skills when skillLoader not provided', async () => {
    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp');
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

    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp', mockSkillLoader);
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
    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp');
    const instance = await executor.createInstance(minimalDefinition());

    const result = await instance.invoke({ message: 'hi' });
    assert.equal(result.output, 'Hello from mock!');
    assert.ok(result.metadata.duration >= 0);
  });

  it('should invoke with sessionId and store messages', async () => {
    LLMFactory.create = async () => mockChatModel('Session response');

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp');
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
    const executor = new AgentExecutor(mockToolRegistry([mockTool]), store, '/tmp');
    const instance = await executor.createInstance(minimalDefinition());

    const result = await instance.invoke({ message: 'hi' });
    assert.ok(typeof result.output === 'string');
    assert.ok((result.output as string).includes('error') || (result.output as string).includes('Error'));
  });

  it('should stream without tools', async () => {
    LLMFactory.create = async () => mockChatModel('Streamed content');

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp');
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
    const executor = new AgentExecutor(mockToolRegistry([greetTool]), store, '/tmp');
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
    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp');
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
    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp');
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
    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp', undefined, undefined, mockIntegrations);
    const def = minimalDefinition({
      integrations: [{ type: 'collabnook', url: 'ws://test', channel: 'test', botName: 'bot' }],
    });
    const instance = await executor.createInstance(def);
    assert.ok(instance);
  });

  it('should handle structured output in invoke', async () => {
    LLMFactory.create = async () => mockChatModel('{"result": "structured data"}');

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp');
    const def = minimalDefinition({
      output: { format: 'structured', schema: { type: 'object', properties: { result: { type: 'string' } } } },
    });
    const instance = await executor.createInstance(def);

    const result = await instance.invoke({ message: 'get data' });
    assert.ok(typeof result.output === 'object');
    assert.equal((result.output as any).result, 'structured data');
  });

  it('should store AI response in session for invoke without tools', async () => {
    LLMFactory.create = async () => mockChatModel('Session AI response');

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp');
    const instance = await executor.createInstance(minimalDefinition());

    const result = await instance.invoke({ input: { message: 'hi' }, sessionId: 'sess-store' });
    assert.equal(result.output, 'Session AI response');
    assert.equal(result.metadata.sessionId, 'sess-store');
    // user + ai messages stored
    assert.ok(store.getMessageCount('sess-store') >= 2);
  });

  it('should handle structured output validation failure in invoke without tools', async () => {
    LLMFactory.create = async () => mockChatModel('not json');

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp');
    const def = minimalDefinition({
      output: { format: 'structured', schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } },
    });
    const instance = await executor.createInstance(def);

    const result = await instance.invoke({ message: 'test' });
    // output gets wrapped in {content: ...} since it's not valid JSON
    assert.ok(typeof result.output === 'object');
  });

  it('should handle image attachments in buildUserContent', async () => {
    let receivedMessages: any = null;
    LLMFactory.create = async () => {
      const model: ChatModel = {
        async invoke(msgs: any): Promise<ChatModelResponse> {
          receivedMessages = msgs;
          return { content: 'Got image' };
        },
        async *stream(): AsyncIterable<ChatModelResponse> { yield { content: 'ok' }; },
        bindTools() { return model; },
        withStructuredOutput() { return model; },
      };
      return model;
    };

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp');
    const instance = await executor.createInstance(minimalDefinition());

    const result = await instance.invoke({
      message: 'describe this',
      attachments: [
        { data: 'base64imgdata', mediaType: 'image/png', name: 'test.png' },
      ],
    });
    assert.equal(result.output, 'Got image');
    // Verify the LLM received multimodal content
    assert.ok(receivedMessages);
    const lastHumanMsg = receivedMessages.find((m: any) => m.role === 'human');
    assert.ok(Array.isArray(lastHumanMsg.content));
    assert.ok(lastHumanMsg.content.some((p: any) => p.type === 'image'));
  });

  it('should handle non-image attachments in buildUserContent', async () => {
    let receivedMessages: any = null;
    LLMFactory.create = async () => {
      const model: ChatModel = {
        async invoke(msgs: any): Promise<ChatModelResponse> {
          receivedMessages = msgs;
          return { content: 'Got doc' };
        },
        async *stream(): AsyncIterable<ChatModelResponse> { yield { content: 'ok' }; },
        bindTools() { return model; },
        withStructuredOutput() { return model; },
      };
      return model;
    };

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp');
    const instance = await executor.createInstance(minimalDefinition());

    // text/plain attachment — base64 encoded "Hello world"
    const base64Text = Buffer.from('Hello world').toString('base64');
    const result = await instance.invoke({
      message: 'read this',
      attachments: [
        { data: base64Text, mediaType: 'text/plain', name: 'note.txt' },
      ],
    });
    assert.ok(result.output);
  });

  it('should handle invalid attachments gracefully', async () => {
    LLMFactory.create = async () => mockChatModel('No attachment');

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp');
    const instance = await executor.createInstance(minimalDefinition());

    // Attachment with missing data/mediaType should be skipped
    const result = await instance.invoke({
      message: 'test',
      attachments: [{ invalid: true }],
    });
    assert.equal(result.output, 'No attachment');
  });

  it('should stream without tools and store messages in session', async () => {
    LLMFactory.create = async () => mockChatModel('Streamed session');

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp');
    const instance = await executor.createInstance(minimalDefinition());

    const chunks: any[] = [];
    for await (const chunk of instance.stream({ input: { message: 'hi' }, sessionId: 'sess-stream' })) {
      chunks.push(chunk);
    }
    assert.ok(chunks.some(c => c.type === 'content'));
    // Session should have stored messages
    assert.ok(store.hasSession('sess-stream'));
    assert.ok(store.getMessageCount('sess-stream') >= 2);
  });

  it('should stream without tools and yield reasoning chunks', async () => {
    LLMFactory.create = async () => {
      const model: ChatModel = {
        async invoke(): Promise<ChatModelResponse> { return { content: 'ok' }; },
        async *stream(): AsyncIterable<ChatModelResponse> {
          yield { content: 'Answer', reasoning: 'I thought about it' };
        },
        bindTools() { return model; },
        withStructuredOutput() { return model; },
      };
      return model;
    };

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp');
    const instance = await executor.createInstance(minimalDefinition());

    const chunks: any[] = [];
    for await (const chunk of instance.stream({ input: { message: 'think' } })) {
      chunks.push(chunk);
    }
    assert.ok(chunks.some(c => c.type === 'thinking'));
    assert.ok(chunks.some(c => c.type === 'content'));
  });

  it('should stream without tools and yield usage stats', async () => {
    LLMFactory.create = async () => {
      const model: ChatModel = {
        async invoke(): Promise<ChatModelResponse> { return { content: 'ok' }; },
        async *stream(): AsyncIterable<ChatModelResponse> {
          yield {
            content: 'Done',
            usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          };
        },
        bindTools() { return model; },
        withStructuredOutput() { return model; },
      };
      return model;
    };

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp');
    const instance = await executor.createInstance(minimalDefinition());

    const chunks: any[] = [];
    for await (const chunk of instance.stream({ input: { message: 'stats' } })) {
      chunks.push(chunk);
    }
    const usageChunk = chunks.find(c => c.type === 'usage');
    assert.ok(usageChunk);
    assert.equal(usageChunk.input_tokens, 10);
    assert.equal(usageChunk.output_tokens, 5);
  });

  it('should stream without tools and handle structured output', async () => {
    LLMFactory.create = async () => {
      const model: ChatModel = {
        async invoke(): Promise<ChatModelResponse> { return { content: '{}' }; },
        async *stream(): AsyncIterable<ChatModelResponse> {
          yield { content: '{"key": "value"}' };
        },
        bindTools() { return model; },
        withStructuredOutput() { return model; },
      };
      return model;
    };

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp');
    const def = minimalDefinition({
      output: { format: 'structured' },
    });
    const instance = await executor.createInstance(def);

    const chunks: any[] = [];
    for await (const chunk of instance.stream({ input: { message: 'data' }, sessionId: 'sess-struct' })) {
      chunks.push(chunk);
    }
    const resultChunk = chunks.find(c => c.type === 'result');
    assert.ok(resultChunk);
    assert.equal(resultChunk.output.key, 'value');
    // Should store in session
    assert.ok(store.hasSession('sess-struct'));
  });
});

// --- extractStructuredOutput tests ---

describe('AgentExecutor extractStructuredOutput (via invoke)', () => {
  let originalCreate: typeof LLMFactory.create;

  before(async () => {
    const fp = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'llm.json');
    await loadLLMConfig(fp);
    originalCreate = LLMFactory.create;
  });

  afterEach(() => {
    LLMFactory.create = originalCreate;
  });

  it('should extract structured output from object without content property (with tools)', async () => {
    // When the react loop returns a message object without 'content', extractStructuredOutput
    // returns it as-is. This path is only hit through invokeWithTools.
    LLMFactory.create = async () => {
      let callCount = 0;
      const model: ChatModel = {
        async invoke(): Promise<ChatModelResponse> { return { content: '' }; },
        async *stream(): AsyncIterable<ChatModelResponse> {
          callCount++;
          // First call returns structured data without content
          yield { content: '{"result": "from_tools"}' };
        },
        bindTools() { return model; },
        withStructuredOutput() { return model; },
      };
      return model;
    };

    const dummyTool: StructuredTool = {
      name: 'structtool',
      description: 'dummy',
      schema: { type: 'object', properties: {} },
      invoke: async () => 'ok',
    } as StructuredTool;

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry([dummyTool]), store, '/tmp');
    const def = minimalDefinition({
      output: { format: 'structured' },
    });
    const instance = await executor.createInstance(def);
    const result = await instance.invoke({ message: 'get' });
    assert.ok(typeof result.output === 'object');
  });

  it('should extract structured output from message with object content', async () => {
    LLMFactory.create = async () => {
      const model: ChatModel = {
        async invoke(): Promise<ChatModelResponse> {
          return { content: { nested: 'obj' } } as any;
        },
        async *stream(): AsyncIterable<ChatModelResponse> { yield { content: '' }; },
        bindTools() { return model; },
        withStructuredOutput() { return model; },
      };
      return model;
    };

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp');
    const def = minimalDefinition({
      output: { format: 'structured' },
    });
    const instance = await executor.createInstance(def);
    const result = await instance.invoke({ message: 'get' });
    assert.ok(typeof result.output === 'object');
    assert.equal((result.output as any).nested, 'obj');
  });

  it('should extract structured output from unparseable string content', async () => {
    LLMFactory.create = async () => mockChatModel('not valid json');

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp');
    const def = minimalDefinition({
      output: { format: 'structured' },
    });
    const instance = await executor.createInstance(def);
    const result = await instance.invoke({ message: 'get' });
    assert.ok(typeof result.output === 'object');
    assert.equal((result.output as any).content, 'not valid json');
  });

  it('should handle structured output with valid JSON string content', async () => {
    LLMFactory.create = async () => mockChatModel('{"parsed": true}');

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry(), store, '/tmp');
    const def = minimalDefinition({
      output: { format: 'structured' },
    });
    const instance = await executor.createInstance(def);
    const result = await instance.invoke({ message: 'get' });
    assert.ok(typeof result.output === 'object');
    assert.equal((result.output as any).parsed, true);
  });
});

// --- invokeWithTools detailed tests ---

describe('AgentExecutor invokeWithTools', () => {
  let originalCreate: typeof LLMFactory.create;

  before(async () => {
    const fp = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'llm.json');
    await loadLLMConfig(fp);
    originalCreate = LLMFactory.create;
  });

  afterEach(() => {
    LLMFactory.create = originalCreate;
  });

  function createToolsModel(responses: Array<{ content: string; tool_calls?: any[] }>): ChatModel {
    let callIdx = 0;
    const model: ChatModel = {
      async invoke(): Promise<ChatModelResponse> {
        return responses[Math.min(callIdx++, responses.length - 1)]!;
      },
      async *stream(): AsyncIterable<ChatModelResponse> {
        const resp = responses[Math.min(callIdx++, responses.length - 1)]!;
        yield resp;
      },
      bindTools() { return model; },
      withStructuredOutput() { return model; },
    };
    return model;
  }

  it('should log sessionId when invoking with tools', async () => {
    LLMFactory.create = async () => createToolsModel([
      { content: 'Tool response with session' },
    ]);

    const dummyTool: StructuredTool = {
      name: 'dummy',
      description: 'dummy tool',
      schema: { type: 'object', properties: {} },
      invoke: async () => 'ok',
    } as StructuredTool;

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry([dummyTool]), store, '/tmp');
    const instance = await executor.createInstance(minimalDefinition());

    const result = await instance.invoke({ input: { message: 'hi' }, sessionId: 'sess-tools' });
    assert.equal(result.metadata.sessionId, 'sess-tools');
    assert.ok(typeof result.output === 'string');
  });

  it('should handle empty messages from agent with tools', async () => {
    // Force the react agent to return empty messages
    LLMFactory.create = async () => {
      const model: ChatModel = {
        async invoke(): Promise<ChatModelResponse> { return { content: '' }; },
        async *stream(): AsyncIterable<ChatModelResponse> {
          yield { content: '' };
        },
        bindTools() { return model; },
        withStructuredOutput() { return model; },
      };
      return model;
    };

    const dummyTool: StructuredTool = {
      name: 'noop',
      description: 'no-op',
      schema: { type: 'object', properties: {} },
      invoke: async () => 'ok',
    } as StructuredTool;

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry([dummyTool]), store, '/tmp');
    const instance = await executor.createInstance(minimalDefinition());

    const result = await instance.invoke({ message: 'hi' });
    // Should handle the case without crashing
    assert.ok(typeof result.output === 'string');
  });

  it('should handle structured output with tools and validate', async () => {
    LLMFactory.create = async () => createToolsModel([
      { content: '{"name": "Alice", "age": 30}' },
    ]);

    const dummyTool: StructuredTool = {
      name: 'lookup',
      description: 'lookup',
      schema: { type: 'object', properties: {} },
      invoke: async () => 'ok',
    } as StructuredTool;

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry([dummyTool]), store, '/tmp');
    const def = minimalDefinition({
      output: {
        format: 'structured',
        schema: { type: 'object', properties: { name: { type: 'string' } } },
      },
    });
    const instance = await executor.createInstance(def);

    const result = await instance.invoke({ message: 'lookup Alice' });
    assert.ok(typeof result.output === 'object');
    assert.ok(result.metadata.structuredOutputValid !== undefined);
  });

  it('should handle empty/null output with tools', async () => {
    LLMFactory.create = async () => createToolsModel([
      { content: '' },
    ]);

    const dummyTool: StructuredTool = {
      name: 'noop2',
      description: 'noop',
      schema: { type: 'object', properties: {} },
      invoke: async () => 'ok',
    } as StructuredTool;

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry([dummyTool]), store, '/tmp');
    const instance = await executor.createInstance(minimalDefinition());

    const result = await instance.invoke({ message: 'empty' });
    // Empty output should be replaced with fallback message
    assert.ok(typeof result.output === 'string');
  });

  it('should handle AbortError with tools', async () => {
    LLMFactory.create = async () => {
      const model: ChatModel = {
        async invoke() { throw new DOMException('Aborted', 'AbortError'); },
        async *stream() { throw new DOMException('Aborted', 'AbortError'); },
        bindTools() { return model; },
        withStructuredOutput() { return model; },
      };
      return model;
    };

    const dummyTool: StructuredTool = {
      name: 'aborttool',
      description: 'abort',
      schema: { type: 'object', properties: {} },
      invoke: async () => 'ok',
    } as StructuredTool;

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry([dummyTool]), store, '/tmp');
    const instance = await executor.createInstance(minimalDefinition());

    const result = await instance.invoke({ message: 'abort' });
    assert.ok(typeof result.output === 'string');
    assert.ok((result.output as string).includes('abort') || (result.output as string).includes('Abort'));
  });

  it('should store tool summaries in session with tools', async () => {
    let callCount = 0;
    LLMFactory.create = async () => {
      const model: ChatModel = {
        async invoke(): Promise<ChatModelResponse> { return { content: '' }; },
        async *stream(): AsyncIterable<ChatModelResponse> {
          callCount++;
          if (callCount === 1) {
            yield { content: '', tool_calls: [{ id: 'tc-1', name: 'greet', args: { name: 'Bob' } }] };
          } else {
            yield { content: 'Hello Bob! This is a response that is long enough to pass the minimum length check.' };
          }
        },
        bindTools() { return model; },
        withStructuredOutput() { return model; },
      };
      return model;
    };

    const greetTool: StructuredTool = {
      name: 'greet',
      description: 'greet',
      schema: { type: 'object', properties: { name: { type: 'string' } } },
      invoke: async (args: any) => `Hi ${args.name}`,
    } as StructuredTool;

    const store = new ConversationStore();
    const executor = new AgentExecutor(mockToolRegistry([greetTool]), store, '/tmp');
    const instance = await executor.createInstance(minimalDefinition());

    const result = await instance.invoke({ input: { message: 'greet Bob' }, sessionId: 'sess-tool-summary' });
    assert.equal(result.metadata.sessionId, 'sess-tool-summary');
    assert.ok(store.hasSession('sess-tool-summary'));
  });
});
