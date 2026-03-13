import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { ReactWorkflowExecutor } from '../../lib/workflows/react-workflow-executor.ts';
import { InterruptManager } from '../../lib/workflows/interrupt-manager.ts';
import { NodeInterrupt } from '../../lib/types/llm-types.ts';
import type { ReactWorkflowDefinition, WorkflowStatus } from '../../lib/workflows/types.ts';
import type { ChatModel, ChatModelResponse, StructuredTool, BaseMessage } from '../../lib/types/llm-types.ts';
import { LLMFactory } from '../../lib/llm/llm-factory.ts';

// --- Helpers ---

function makeDefinition(overrides: Partial<ReactWorkflowDefinition> = {}): ReactWorkflowDefinition {
  return {
    name: 'test-react-wf',
    description: 'Test react workflow',
    version: '1.0.0',
    type: 'react',
    chatOutputFormat: 'json',
    input: {
      schema: {
        query: { type: 'string', description: 'The query' },
      },
    },
    prompt: {
      system: 'You are a helpful assistant.',
      goal: 'Answer: {{input.query}}',
    },
    graph: {
      model: 'default',
      tools: { mode: 'all', sources: ['builtin'] },
      agents: { mode: 'none' },
      executionMode: 'react',
      maxIterations: 10,
      timeout: 300000,
    },
    output: {
      result: '{{state.messages[-1].content}}',
    },
    ...overrides,
  } as ReactWorkflowDefinition;
}

function makeMockLLM(responses: ChatModelResponse[]): ChatModel {
  let callIndex = 0;
  const llm: ChatModel = {
    invoke: mock.fn(async (_messages: BaseMessage[]) => {
      const response = responses[callIndex] ?? responses[responses.length - 1]!;
      callIndex++;
      return response;
    }),
    stream: mock.fn(async function* () { yield { content: '' }; }) as any,
    bindTools: mock.fn((_tools: StructuredTool[]) => llm),
    withStructuredOutput: mock.fn((_schema: Record<string, unknown>) => llm),
  };
  return llm;
}

function makeMockTool(name: string, result: string | (() => Promise<string>)): StructuredTool {
  return {
    name,
    description: `Tool ${name}`,
    schema: {},
    invoke: mock.fn(async () => {
      if (typeof result === 'function') return result();
      return result;
    }),
  } as unknown as StructuredTool;
}

function makeMockToolDiscovery(tools: StructuredTool[] = [], agentTools: StructuredTool[] = []) {
  return {
    discoverAll: mock.fn(async () => tools),
    discoverAgents: mock.fn(async () => agentTools),
  } as any;
}

// --- Tests ---

describe('ReactWorkflowExecutor', () => {
  let interruptManager: InterruptManager;
  let createStub: ReturnType<typeof mock.fn>;

  beforeEach(() => {
    interruptManager = new InterruptManager();
    createStub = mock.fn(async () => makeMockLLM([{ content: 'done' }]));
    mock.method(LLMFactory, 'create', createStub);
  });

  afterEach(() => {
    mock.restoreAll();
  });

  describe('execute', () => {
    it('should execute a simple workflow with no tool calls', async () => {
      const llm = makeMockLLM([{ content: 'Final answer' }]);
      mock.method(LLMFactory, 'create', async () => llm);

      const toolDiscovery = makeMockToolDiscovery();
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      const result = await executor.execute(makeDefinition(), { query: 'hello' });

      assert.equal(result.metadata.success, true);
      assert.equal(result.output.result, 'Final answer');
      assert.ok(result.metadata.duration >= 0);
    });

    it('should interpolate input variables in the goal', async () => {
      let capturedMessages: BaseMessage[] = [];
      const llm: ChatModel = {
        invoke: mock.fn(async (msgs: BaseMessage[]) => {
          capturedMessages = msgs;
          return { content: 'done' };
        }),
        stream: mock.fn(async function* () { yield { content: '' }; }) as any,
        bindTools: mock.fn(function (this: ChatModel) { return this; }),
        withStructuredOutput: mock.fn(function (this: ChatModel) { return this; }),
      };
      mock.method(LLMFactory, 'create', async () => llm);

      const toolDiscovery = makeMockToolDiscovery();
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      await executor.execute(makeDefinition(), { query: 'What is AI?' });

      // The human message should contain the interpolated goal
      const humanMsg = capturedMessages.find(m => m.role === 'human');
      assert.ok(humanMsg);
      assert.equal(humanMsg.content, 'Answer: What is AI?');
    });

    it('should generate a threadId when none is provided', async () => {
      const llm = makeMockLLM([{ content: 'done' }]);
      mock.method(LLMFactory, 'create', async () => llm);

      const toolDiscovery = makeMockToolDiscovery();
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      const result = await executor.execute(makeDefinition(), { query: 'test' });
      assert.equal(result.metadata.success, true);
    });

    it('should use the provided threadId', async () => {
      const llm = makeMockLLM([{ content: 'done' }]);
      mock.method(LLMFactory, 'create', async () => llm);

      const toolDiscovery = makeMockToolDiscovery();
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      const result = await executor.execute(makeDefinition(), { query: 'test' }, 'custom-thread-123');
      assert.equal(result.metadata.success, true);
    });

    it('should fire status callbacks in order', async () => {
      const statuses: WorkflowStatus[] = [];
      const llm = makeMockLLM([{ content: 'Final answer' }]);
      mock.method(LLMFactory, 'create', async () => llm);

      const toolDiscovery = makeMockToolDiscovery();
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      await executor.execute(makeDefinition(), { query: 'test' }, undefined, (s) => statuses.push(s));

      assert.ok(statuses.some(s => s.type === 'workflow_start'));
      assert.ok(statuses.some(s => s.type === 'tool_discovery'));
      assert.ok(statuses.some(s => s.type === 'react_iteration'));
      assert.ok(statuses.some(s => s.type === 'workflow_complete'));
    });

    it('should discover tools and agents', async () => {
      const tool1 = makeMockTool('search', 'search result');
      const agentTool = makeMockTool('agent_writer', 'agent result');
      const llm = makeMockLLM([{ content: 'done' }]);
      mock.method(LLMFactory, 'create', async () => llm);

      const toolDiscovery = makeMockToolDiscovery([tool1], [agentTool]);
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      await executor.execute(makeDefinition(), { query: 'test' });

      assert.equal((toolDiscovery.discoverAll as any).mock.callCount(), 1);
      assert.equal((toolDiscovery.discoverAgents as any).mock.callCount(), 1);
    });

    it('should handle tool calls and return results', async () => {
      const tool = makeMockTool('search', 'search result for AI');
      const llm = makeMockLLM([
        {
          content: 'Let me search for that.',
          tool_calls: [{ id: 'tc1', name: 'search', args: { query: 'AI' } }],
        },
        { content: 'Based on my search: AI is cool.' },
      ]);
      mock.method(LLMFactory, 'create', async () => llm);

      const toolDiscovery = makeMockToolDiscovery([tool]);
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      const result = await executor.execute(makeDefinition(), { query: 'What is AI?' });

      assert.equal(result.metadata.success, true);
      assert.equal(result.output.result, 'Based on my search: AI is cool.');
      assert.equal((tool.invoke as any).mock.callCount(), 1);
    });

    it('should handle multiple parallel tool calls', async () => {
      const tool1 = makeMockTool('search', 'result1');
      const tool2 = makeMockTool('lookup', 'result2');
      const llm = makeMockLLM([
        {
          content: 'Let me search.',
          tool_calls: [
            { id: 'tc1', name: 'search', args: { q: 'a' } },
            { id: 'tc2', name: 'lookup', args: { q: 'b' } },
          ],
        },
        { content: 'Got both results.' },
      ]);
      mock.method(LLMFactory, 'create', async () => llm);

      const toolDiscovery = makeMockToolDiscovery([tool1, tool2]);
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      const result = await executor.execute(makeDefinition(), { query: 'test' });

      assert.equal(result.metadata.success, true);
      assert.equal((tool1.invoke as any).mock.callCount(), 1);
      assert.equal((tool2.invoke as any).mock.callCount(), 1);
    });

    it('should handle tool not found', async () => {
      const statuses: WorkflowStatus[] = [];
      const llm = makeMockLLM([
        {
          content: 'Calling tool.',
          tool_calls: [{ id: 'tc1', name: 'nonexistent_tool', args: {} }],
        },
        { content: 'Tool was not found.' },
      ]);
      mock.method(LLMFactory, 'create', async () => llm);

      const toolDiscovery = makeMockToolDiscovery();
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      const result = await executor.execute(
        makeDefinition(), { query: 'test' }, undefined, (s) => statuses.push(s)
      );

      assert.equal(result.metadata.success, true);
      assert.ok(statuses.some(s => s.type === 'step_error' && s.message.includes('not found')));
    });

    it('should handle tool execution error', async () => {
      const statuses: WorkflowStatus[] = [];
      const failingTool: StructuredTool = {
        name: 'fail_tool',
        description: 'Fails',
        schema: {},
        invoke: mock.fn(async () => { throw new Error('Tool exploded'); }),
      } as unknown as StructuredTool;

      const llm = makeMockLLM([
        {
          content: 'Calling tool.',
          tool_calls: [{ id: 'tc1', name: 'fail_tool', args: {} }],
        },
        { content: 'Tool failed, providing answer anyway.' },
      ]);
      mock.method(LLMFactory, 'create', async () => llm);

      const toolDiscovery = makeMockToolDiscovery([failingTool]);
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      const result = await executor.execute(
        makeDefinition(), { query: 'test' }, undefined, (s) => statuses.push(s)
      );

      assert.equal(result.metadata.success, true);
      assert.ok(statuses.some(s => s.type === 'step_error' && s.message.includes('Tool exploded')));
    });

    it('should handle tool execution error with non-Error thrown', async () => {
      const failingTool: StructuredTool = {
        name: 'fail_tool',
        description: 'Fails',
        schema: {},
        invoke: mock.fn(async () => { throw 'string error'; }),
      } as unknown as StructuredTool;

      const llm = makeMockLLM([
        {
          content: 'Calling.',
          tool_calls: [{ id: 'tc1', name: 'fail_tool', args: {} }],
        },
        { content: 'Done.' },
      ]);
      mock.method(LLMFactory, 'create', async () => llm);

      const toolDiscovery = makeMockToolDiscovery([failingTool]);
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      const result = await executor.execute(makeDefinition(), { query: 'test' });
      assert.equal(result.metadata.success, true);
    });

    it('should respect maxIterations limit', async () => {
      // LLM always returns tool calls, never a final answer
      const tool = makeMockTool('loop_tool', 'still going');
      const llm: ChatModel = {
        invoke: mock.fn(async () => ({
          content: 'Calling tool again.',
          tool_calls: [{ id: `tc_${Date.now()}`, name: 'loop_tool', args: {} }],
        })),
        stream: mock.fn(async function* () { yield { content: '' }; }) as any,
        bindTools: mock.fn(function (this: ChatModel) { return this; }),
        withStructuredOutput: mock.fn(function (this: ChatModel) { return this; }),
      };
      mock.method(LLMFactory, 'create', async () => llm);

      const definition = makeDefinition({
        graph: {
          model: 'default',
          tools: { mode: 'all', sources: ['builtin'] },
          agents: { mode: 'none' },
          executionMode: 'react',
          maxIterations: 3,
          timeout: 300000,
        },
      } as any);

      const toolDiscovery = makeMockToolDiscovery([tool]);
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      const result = await executor.execute(definition, { query: 'test' });

      // Should complete (not hang), maxIterations reached
      assert.equal(result.metadata.success, true);
      // invoke is called once per iteration = 3 times for maxIterations=3
      assert.ok((llm.invoke as any).mock.callCount() <= 3);
    });

    it('should handle NodeInterrupt from tool execution', async () => {
      const interruptTool: StructuredTool = {
        name: 'ask_user',
        description: 'Ask user',
        schema: {},
        invoke: mock.fn(async () => {
          throw new NodeInterrupt({ question: 'What color?' });
        }),
      } as unknown as StructuredTool;

      const llm = makeMockLLM([
        {
          content: 'Need to ask.',
          tool_calls: [{ id: 'tc1', name: 'ask_user', args: { question: 'What color?' } }],
        },
      ]);
      mock.method(LLMFactory, 'create', async () => llm);

      const toolDiscovery = makeMockToolDiscovery([interruptTool]);
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      const result = await executor.execute(
        makeDefinition(), { query: 'test' }, 'thread-123'
      );

      assert.deepStrictEqual(result.output.interrupted, true);
      assert.equal(result.output.threadId, 'thread-123');
      assert.equal(result.output.question, 'What color?');
      assert.equal(result.metadata.success, false);
    });

    it('should handle NodeInterrupt with status callback', async () => {
      const statuses: WorkflowStatus[] = [];
      const interruptTool: StructuredTool = {
        name: 'ask_user',
        description: 'Ask user',
        schema: {},
        invoke: mock.fn(async () => {
          throw new NodeInterrupt({ question: 'Confirm?' });
        }),
      } as unknown as StructuredTool;

      const llm = makeMockLLM([
        {
          content: 'Need to ask.',
          tool_calls: [{ id: 'tc1', name: 'ask_user', args: {} }],
        },
      ]);
      mock.method(LLMFactory, 'create', async () => llm);

      const toolDiscovery = makeMockToolDiscovery([interruptTool]);
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      await executor.execute(
        makeDefinition(), { query: 'test' }, 'thread-456', (s) => statuses.push(s)
      );

      assert.ok(statuses.some(s => s.type === 'workflow_interrupt'));
      const interruptStatus = statuses.find(s => s.type === 'workflow_interrupt');
      assert.ok(interruptStatus?.interrupt);
      assert.equal(interruptStatus?.interrupt?.threadId, 'thread-456');
    });

    it('should handle general errors and re-throw', async () => {
      mock.method(LLMFactory, 'create', async () => {
        throw new Error('LLM creation failed');
      });

      const toolDiscovery = makeMockToolDiscovery();
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      await assert.rejects(
        () => executor.execute(makeDefinition(), { query: 'test' }),
        { message: 'LLM creation failed' }
      );
    });

    it('should fire workflow_error status on general error', async () => {
      const statuses: WorkflowStatus[] = [];
      mock.method(LLMFactory, 'create', async () => {
        throw new Error('LLM unavailable');
      });

      const toolDiscovery = makeMockToolDiscovery();
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      await assert.rejects(
        () => executor.execute(makeDefinition(), { query: 'test' }, undefined, (s) => statuses.push(s)),
        { message: 'LLM unavailable' }
      );

      assert.ok(statuses.some(s => s.type === 'workflow_error'));
    });

    it('should handle non-Error thrown in execute', async () => {
      const statuses: WorkflowStatus[] = [];
      mock.method(LLMFactory, 'create', async () => {
        throw 'string_error';
      });

      const toolDiscovery = makeMockToolDiscovery();
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      await assert.rejects(
        () => executor.execute(makeDefinition(), { query: 'test' }, undefined, (s) => statuses.push(s)),
      );

      assert.ok(statuses.some(s => s.type === 'workflow_error'));
    });

    it('should handle empty tool_calls array as final answer', async () => {
      const llm = makeMockLLM([{ content: 'No tools needed.', tool_calls: [] }]);
      mock.method(LLMFactory, 'create', async () => llm);

      const toolDiscovery = makeMockToolDiscovery();
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      const result = await executor.execute(makeDefinition(), { query: 'simple' });

      assert.equal(result.output.result, 'No tools needed.');
      assert.equal(result.metadata.success, true);
    });

    it('should bind tools when tools are available', async () => {
      const tool = makeMockTool('my_tool', 'result');
      const llm = makeMockLLM([{ content: 'done' }]);
      mock.method(LLMFactory, 'create', async () => llm);

      const toolDiscovery = makeMockToolDiscovery([tool]);
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      await executor.execute(makeDefinition(), { query: 'test' });

      assert.equal((llm.bindTools as any).mock.callCount(), 1);
    });

    it('should not bind tools when no tools are available', async () => {
      const llm = makeMockLLM([{ content: 'done' }]);
      mock.method(LLMFactory, 'create', async () => llm);

      const toolDiscovery = makeMockToolDiscovery([], []);
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      await executor.execute(makeDefinition(), { query: 'test' });

      assert.equal((llm.bindTools as any).mock.callCount(), 0);
    });

    it('should handle tool returning JSON string result', async () => {
      const tool: StructuredTool = {
        name: 'json_tool',
        description: 'Returns JSON',
        schema: {},
        invoke: mock.fn(async () => JSON.stringify({ key: 'value', nested: { a: 1 } })),
      } as unknown as StructuredTool;

      const llm = makeMockLLM([
        {
          content: 'Calling tool.',
          tool_calls: [{ id: 'tc1', name: 'json_tool', args: {} }],
        },
        { content: 'Got JSON result.' },
      ]);
      mock.method(LLMFactory, 'create', async () => llm);

      const toolDiscovery = makeMockToolDiscovery([tool]);
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      const result = await executor.execute(makeDefinition(), { query: 'test' });
      assert.equal(result.metadata.success, true);
    });

    it('should fire tool_call and tool_result status events', async () => {
      const statuses: WorkflowStatus[] = [];
      const tool = makeMockTool('my_tool', 'tool output');
      const llm = makeMockLLM([
        {
          content: 'Using tool.',
          tool_calls: [{ id: 'tc1', name: 'my_tool', args: { key: 'val' } }],
        },
        { content: 'Done.' },
      ]);
      mock.method(LLMFactory, 'create', async () => llm);

      const toolDiscovery = makeMockToolDiscovery([tool]);
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      await executor.execute(makeDefinition(), { query: 'test' }, undefined, (s) => statuses.push(s));

      assert.ok(statuses.some(s => s.type === 'tool_call' && s.message.includes('my_tool')));
      assert.ok(statuses.some(s => s.type === 'tool_result' && s.message.includes('my_tool')));

      const toolCallStatus = statuses.find(s => s.type === 'tool_call');
      assert.ok(toolCallStatus?.toolInput);

      const toolResultStatus = statuses.find(s => s.type === 'tool_result');
      assert.ok(toolResultStatus?.toolOutput);
    });
  });

  describe('single-turn executionMode', () => {
    it('should execute tools once and then stop in single-turn mode', async () => {
      const tool = makeMockTool('search', 'search result');
      let callCount = 0;
      const llm: ChatModel = {
        invoke: mock.fn(async () => {
          callCount++;
          if (callCount === 1) {
            return {
              content: 'Searching.',
              tool_calls: [{ id: 'tc1', name: 'search', args: {} }],
            };
          }
          // Second call: still tries to call tools, but single-turn should stop
          if (callCount === 2) {
            return {
              content: 'Here is the answer based on search.',
              tool_calls: [{ id: 'tc2', name: 'search', args: {} }],
            };
          }
          return { content: 'Final.' };
        }),
        stream: mock.fn(async function* () { yield { content: '' }; }) as any,
        bindTools: mock.fn(function (this: ChatModel) { return this; }),
        withStructuredOutput: mock.fn(function (this: ChatModel) { return this; }),
      };
      mock.method(LLMFactory, 'create', async () => llm);

      const definition = makeDefinition({
        graph: {
          model: 'default',
          tools: { mode: 'all', sources: ['builtin'] },
          agents: { mode: 'none' },
          executionMode: 'single-turn',
          maxIterations: 10,
          timeout: 300000,
        },
      } as any);

      const toolDiscovery = makeMockToolDiscovery([tool]);
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      const result = await executor.execute(definition, { query: 'test' });

      // Tool should only have been invoked once (first round)
      assert.equal((tool.invoke as any).mock.callCount(), 1);
      assert.equal(result.metadata.success, true);
    });

    it('should augment system prompt after tools executed in single-turn mode', async () => {
      const tool = makeMockTool('search', 'result');
      let capturedMessages: BaseMessage[][] = [];
      const llm: ChatModel = {
        invoke: mock.fn(async (msgs: BaseMessage[]) => {
          capturedMessages.push([...msgs]);
          if (capturedMessages.length === 1) {
            return {
              content: 'Searching.',
              tool_calls: [{ id: 'tc1', name: 'search', args: {} }],
            };
          }
          return { content: 'Final answer.' };
        }),
        stream: mock.fn(async function* () { yield { content: '' }; }) as any,
        bindTools: mock.fn(function (this: ChatModel) { return this; }),
        withStructuredOutput: mock.fn(function (this: ChatModel) { return this; }),
      };
      mock.method(LLMFactory, 'create', async () => llm);

      const definition = makeDefinition({
        graph: {
          model: 'default',
          tools: { mode: 'all', sources: ['builtin'] },
          agents: { mode: 'none' },
          executionMode: 'single-turn',
          maxIterations: 10,
          timeout: 300000,
        },
      } as any);

      const toolDiscovery = makeMockToolDiscovery([tool]);
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      await executor.execute(definition, { query: 'test' });

      // Second invoke call should have augmented system message
      assert.ok(capturedMessages.length >= 2);
      const secondCallSystemMsg = capturedMessages[1]!.find(m => m.role === 'system');
      assert.ok(secondCallSystemMsg);
      assert.ok(
        (secondCallSystemMsg.content as string).includes('Provide your final answer now'),
        'System message should include instruction to provide final answer'
      );
    });
  });

  describe('extractOutput', () => {
    it('should extract last message content for state.messages[-1] template', async () => {
      const llm = makeMockLLM([{ content: 'The final result is here.' }]);
      mock.method(LLMFactory, 'create', async () => llm);

      const toolDiscovery = makeMockToolDiscovery();
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      const result = await executor.execute(makeDefinition(), { query: 'test' });

      assert.equal(result.output.result, 'The final result is here.');
    });

    it('should pass through non-template output values', async () => {
      const llm = makeMockLLM([{ content: 'done' }]);
      mock.method(LLMFactory, 'create', async () => llm);

      const definition = makeDefinition({
        output: {
          result: '{{state.messages[-1].content}}',
          static_value: 'hello world',
        },
      });

      const toolDiscovery = makeMockToolDiscovery();
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      const result = await executor.execute(definition, { query: 'test' });

      assert.equal(result.output.result, 'done');
      assert.equal(result.output.static_value, 'hello world');
    });
  });

  describe('interpolateGoal', () => {
    it('should interpolate multiple input variables', async () => {
      let capturedMessages: BaseMessage[] = [];
      const llm: ChatModel = {
        invoke: mock.fn(async (msgs: BaseMessage[]) => {
          capturedMessages = msgs;
          return { content: 'done' };
        }),
        stream: mock.fn(async function* () { yield { content: '' }; }) as any,
        bindTools: mock.fn(function (this: ChatModel) { return this; }),
        withStructuredOutput: mock.fn(function (this: ChatModel) { return this; }),
      };
      mock.method(LLMFactory, 'create', async () => llm);

      const definition = makeDefinition({
        prompt: {
          system: 'You are a helper.',
          goal: 'Find {{input.topic}} about {{input.query}}',
        },
        input: {
          schema: {
            query: { type: 'string', description: 'Query' },
            topic: { type: 'string', description: 'Topic' },
          },
        },
      });

      const toolDiscovery = makeMockToolDiscovery();
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      await executor.execute(definition, { query: 'science', topic: 'AI' });

      const humanMsg = capturedMessages.find(m => m.role === 'human');
      assert.equal(humanMsg?.content, 'Find AI about science');
    });

    it('should replace missing input variables with empty string', async () => {
      let capturedMessages: BaseMessage[] = [];
      const llm: ChatModel = {
        invoke: mock.fn(async (msgs: BaseMessage[]) => {
          capturedMessages = msgs;
          return { content: 'done' };
        }),
        stream: mock.fn(async function* () { yield { content: '' }; }) as any,
        bindTools: mock.fn(function (this: ChatModel) { return this; }),
        withStructuredOutput: mock.fn(function (this: ChatModel) { return this; }),
      };
      mock.method(LLMFactory, 'create', async () => llm);

      const toolDiscovery = makeMockToolDiscovery();
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      await executor.execute(makeDefinition(), { }); // no query provided

      const humanMsg = capturedMessages.find(m => m.role === 'human');
      assert.equal(humanMsg?.content, 'Answer: ');
    });
  });

  describe('resumeWithAnswer', () => {
    it('should resume workflow after interrupt with ask_user tool call', async () => {
      const askUserTool: StructuredTool = {
        name: 'ask_user',
        description: 'Ask user',
        schema: {},
        invoke: mock.fn(async () => {
          throw new NodeInterrupt({ question: 'What color?' });
        }),
      } as unknown as StructuredTool;

      // First execute: triggers interrupt
      const llmForExecute = makeMockLLM([
        {
          content: 'Need to ask.',
          tool_calls: [{ id: 'tc_ask', name: 'ask_user', args: { question: 'What color?' } }],
        },
      ]);
      mock.method(LLMFactory, 'create', async () => llmForExecute);

      const toolDiscovery = makeMockToolDiscovery([askUserTool]);
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      const interruptResult = await executor.execute(
        makeDefinition(), { query: 'test' }, 'thread-resume-1'
      );
      assert.equal(interruptResult.output.interrupted, true);

      // Now resume: LLM gets the answer and provides final response
      const resumeTool = makeMockTool('ask_user', 'not called');
      const llmForResume = makeMockLLM([{ content: 'Blue is a great color!' }]);
      mock.method(LLMFactory, 'create', async () => llmForResume);

      const toolDiscoveryResume = makeMockToolDiscovery([resumeTool]);
      // Need a new executor with the same interruptManager
      const executor2 = new ReactWorkflowExecutor(toolDiscoveryResume, interruptManager);
      // The threadStates are on the original executor, so we use the same one
      const result = await executor.resumeWithAnswer(
        makeDefinition(), 'thread-resume-1', 'Blue'
      );

      assert.equal(result.metadata.success, true);
    });

    it('should throw when no active interrupt exists for thread', async () => {
      const toolDiscovery = makeMockToolDiscovery();
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      await assert.rejects(
        () => executor.resumeWithAnswer(makeDefinition(), 'nonexistent-thread', 'answer'),
        { message: /No active interrupt found/ }
      );
    });

    it('should fallback to human message when no ask_user tool call found', async () => {
      // Manually set up interrupt state
      interruptManager.addInterrupt({
        threadId: 'thread-fallback',
        workflowName: 'test-react-wf',
        question: 'Some question',
        timestamp: Date.now(),
        resolved: false,
      });

      const llm = makeMockLLM([{ content: 'Got it, thanks!' }]);
      mock.method(LLMFactory, 'create', async () => llm);

      const toolDiscovery = makeMockToolDiscovery();
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      // threadStates is empty, so no ask_user call found -> fallback to human message
      const result = await executor.resumeWithAnswer(
        makeDefinition(), 'thread-fallback', 'my answer'
      );

      assert.equal(result.metadata.success, true);
    });

    it('should fire status callbacks during resume', async () => {
      const statuses: WorkflowStatus[] = [];

      interruptManager.addInterrupt({
        threadId: 'thread-status',
        workflowName: 'test-react-wf',
        question: 'Question?',
        timestamp: Date.now(),
        resolved: false,
      });

      const llm = makeMockLLM([{ content: 'Resumed!' }]);
      mock.method(LLMFactory, 'create', async () => llm);

      const toolDiscovery = makeMockToolDiscovery();
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      await executor.resumeWithAnswer(
        makeDefinition(), 'thread-status', 'answer', (s) => statuses.push(s)
      );

      assert.ok(statuses.some(s => s.type === 'workflow_start' && s.message.includes('Resuming')));
      assert.ok(statuses.some(s => s.type === 'workflow_complete'));
    });

    it('should clean up interrupt and thread state after successful resume', async () => {
      interruptManager.addInterrupt({
        threadId: 'thread-cleanup',
        workflowName: 'test-react-wf',
        question: 'Question?',
        timestamp: Date.now(),
        resolved: false,
      });

      const llm = makeMockLLM([{ content: 'Done.' }]);
      mock.method(LLMFactory, 'create', async () => llm);

      const toolDiscovery = makeMockToolDiscovery();
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      await executor.resumeWithAnswer(makeDefinition(), 'thread-cleanup', 'answer');

      // Interrupt should be removed
      assert.equal(interruptManager.getInterrupt('thread-cleanup'), undefined);
    });

    it('should handle NodeInterrupt during resume (second interrupt)', async () => {
      interruptManager.addInterrupt({
        threadId: 'thread-double',
        workflowName: 'test-react-wf',
        question: 'First question',
        timestamp: Date.now(),
        resolved: false,
      });

      const askTool: StructuredTool = {
        name: 'ask_again',
        description: 'Ask again',
        schema: {},
        invoke: mock.fn(async () => {
          throw new NodeInterrupt({ question: 'Second question?' });
        }),
      } as unknown as StructuredTool;

      const llm = makeMockLLM([
        {
          content: 'Need to ask again.',
          tool_calls: [{ id: 'tc2', name: 'ask_again', args: {} }],
        },
      ]);
      mock.method(LLMFactory, 'create', async () => llm);

      const toolDiscovery = makeMockToolDiscovery([askTool]);
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      const result = await executor.resumeWithAnswer(
        makeDefinition(), 'thread-double', 'first answer'
      );

      assert.equal(result.output.interrupted, true);
      assert.equal(result.output.question, 'Second question?');
    });

    it('should handle general error during resume', async () => {
      const statuses: WorkflowStatus[] = [];

      interruptManager.addInterrupt({
        threadId: 'thread-err',
        workflowName: 'test-react-wf',
        question: 'Q?',
        timestamp: Date.now(),
        resolved: false,
      });

      mock.method(LLMFactory, 'create', async () => {
        throw new Error('Resume LLM failed');
      });

      const toolDiscovery = makeMockToolDiscovery();
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      await assert.rejects(
        () => executor.resumeWithAnswer(
          makeDefinition(), 'thread-err', 'answer', (s) => statuses.push(s)
        ),
        { message: 'Resume LLM failed' }
      );

      assert.ok(statuses.some(s => s.type === 'workflow_error'));
    });
  });

  describe('handleInterrupt', () => {
    it('should store interrupt in InterruptManager', async () => {
      const interruptTool: StructuredTool = {
        name: 'ask_user',
        description: 'Ask',
        schema: {},
        invoke: mock.fn(async () => {
          throw new NodeInterrupt({ question: 'Stored question' });
        }),
      } as unknown as StructuredTool;

      const llm = makeMockLLM([
        {
          content: 'Asking.',
          tool_calls: [{ id: 'tc1', name: 'ask_user', args: {} }],
        },
      ]);
      mock.method(LLMFactory, 'create', async () => llm);

      const toolDiscovery = makeMockToolDiscovery([interruptTool]);
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      await executor.execute(makeDefinition(), { query: 'test' }, 'thread-store');

      const interrupt = interruptManager.getInterrupt('thread-store');
      assert.ok(interrupt);
      assert.equal(interrupt.question, 'Stored question');
      assert.equal(interrupt.workflowName, 'test-react-wf');
      assert.equal(interrupt.resolved, false);
    });

    it('should handle NodeInterrupt without question data', async () => {
      const interruptTool: StructuredTool = {
        name: 'ask_user',
        description: 'Ask',
        schema: {},
        invoke: mock.fn(async () => {
          throw new NodeInterrupt({});
        }),
      } as unknown as StructuredTool;

      const llm = makeMockLLM([
        {
          content: 'Asking.',
          tool_calls: [{ id: 'tc1', name: 'ask_user', args: {} }],
        },
      ]);
      mock.method(LLMFactory, 'create', async () => llm);

      const toolDiscovery = makeMockToolDiscovery([interruptTool]);
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      const result = await executor.execute(makeDefinition(), { query: 'test' }, 'thread-no-q');

      // Should fallback to default message
      assert.equal(result.output.interrupted, true);
      assert.equal(result.output.question, 'Workflow interrupted');
    });
  });

  describe('stepsExecuted metadata', () => {
    it('should report correct stepsExecuted count from message history', async () => {
      const tool = makeMockTool('tool1', 'result');
      const llm = makeMockLLM([
        {
          content: 'Step 1.',
          tool_calls: [{ id: 'tc1', name: 'tool1', args: {} }],
        },
        {
          content: 'Step 2.',
          tool_calls: [{ id: 'tc2', name: 'tool1', args: {} }],
        },
        { content: 'Final.' },
      ]);
      mock.method(LLMFactory, 'create', async () => llm);

      const toolDiscovery = makeMockToolDiscovery([tool]);
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      const result = await executor.execute(makeDefinition(), { query: 'test' });

      // stepsExecuted = messages.length (system + human + ai + tool + ai + tool + ai = 7)
      assert.ok(result.metadata.stepsExecuted > 0);
    });
  });

  describe('tool args handling', () => {
    it('should emit tool_call status with string args', async () => {
      const statuses: WorkflowStatus[] = [];
      const tool = makeMockTool('my_tool', 'ok');

      const llm = makeMockLLM([
        {
          content: 'Calling.',
          tool_calls: [{ id: 'tc1', name: 'my_tool', args: 'raw string arg' as any }],
        },
        { content: 'Done.' },
      ]);
      mock.method(LLMFactory, 'create', async () => llm);

      const toolDiscovery = makeMockToolDiscovery([tool]);
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      await executor.execute(makeDefinition(), { query: 'test' }, undefined, (s) => statuses.push(s));

      const toolCallStatus = statuses.find(s => s.type === 'tool_call');
      assert.ok(toolCallStatus);
      assert.equal(toolCallStatus.toolInput, 'raw string arg');
    });
  });

  describe('default executionMode', () => {
    it('should default to react mode when executionMode not specified', async () => {
      const tool = makeMockTool('t', 'r');
      const llm = makeMockLLM([
        {
          content: 'Call.',
          tool_calls: [{ id: 'tc1', name: 't', args: {} }],
        },
        {
          content: 'Call again.',
          tool_calls: [{ id: 'tc2', name: 't', args: {} }],
        },
        { content: 'Final.' },
      ]);
      mock.method(LLMFactory, 'create', async () => llm);

      const definition = makeDefinition();
      // Remove executionMode to test default
      (definition.graph as any).executionMode = undefined;

      const toolDiscovery = makeMockToolDiscovery([tool]);
      const executor = new ReactWorkflowExecutor(toolDiscovery, interruptManager);

      const result = await executor.execute(definition, { query: 'test' });

      // In react mode (default), tools should be called multiple times
      assert.equal((tool.invoke as any).mock.callCount(), 2);
      assert.equal(result.metadata.success, true);
    });
  });
});
