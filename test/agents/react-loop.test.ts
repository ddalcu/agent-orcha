import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createReActAgent, type StreamEvent } from '../../lib/agents/react-loop.ts';
import type { ChatModel, ChatModelResponse, StructuredTool, BaseMessage } from '../../lib/types/llm-types.ts';

/** Helper: create a mock ChatModel that returns canned responses in order */
function mockModel(responses: ChatModelResponse[]): ChatModel {
  let callIndex = 0;
  const base: ChatModel = {
    async invoke(messages: BaseMessage[]): Promise<ChatModelResponse> {
      return responses[callIndex++] ?? { content: '' };
    },
    async *stream(messages: BaseMessage[]): AsyncIterable<ChatModelResponse> {
      yield responses[callIndex++] ?? { content: '' };
    },
    bindTools(): ChatModel {
      return base;
    },
    withStructuredOutput(): ChatModel {
      return base;
    },
  };
  return base;
}

/** Helper: create a simple tool */
function mockTool(name: string, result: string): StructuredTool {
  return {
    name,
    description: `Mock tool ${name}`,
    schema: { type: 'object', properties: {} },
    invoke: async () => result,
  } as StructuredTool;
}

/** Helper: collect all stream events */
async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe('createReActAgent', () => {
  it('should return final text when model responds without tools', async () => {
    const model = mockModel([
      { content: 'Here is a long enough answer that exceeds fifty characters easily.' },
    ]);
    const agent = createReActAgent({ model, tools: [], systemPrompt: 'You are helpful.' });

    const result = await agent.invoke({ messages: [{ role: 'human', content: 'hello' }] });
    // Should have system + human + ai messages
    assert.ok(result.messages.length >= 3);
    const lastAi = result.messages.filter(m => m.role === 'ai').pop();
    assert.ok(lastAi);
    assert.ok(typeof lastAi.content === 'string' && lastAi.content.length > 50);
  });

  it('should execute tool calls and continue loop', async () => {
    const model = mockModel([
      // First response: tool call
      { content: '', tool_calls: [{ id: 'tc1', name: 'search', args: { q: 'test' } }] },
      // Second response: final answer
      { content: 'Based on the search results, here is a detailed answer for you.' },
    ]);
    const tool = mockTool('search', 'search result data');
    const agent = createReActAgent({ model, tools: [tool], systemPrompt: 'You are helpful.' });

    const result = await agent.invoke({ messages: [{ role: 'human', content: 'find info' }] });
    // Should have: system, human, ai (tool call), tool (result), ai (final)
    assert.ok(result.messages.length >= 5);
    const toolMsg = result.messages.find(m => m.role === 'tool');
    assert.ok(toolMsg);
    assert.equal(toolMsg.content, 'search result data');
  });

  it('should stream events correctly', async () => {
    const model = mockModel([
      { content: 'This is a response that is definitely long enough to be accepted as final.' },
    ]);
    const agent = createReActAgent({ model, tools: [], systemPrompt: 'test' });

    const events = await collectEvents(
      agent.streamEvents({ messages: [{ role: 'human', content: 'hi' }] }),
    );
    assert.ok(events.some(e => e.event === 'on_react_iteration'));
    assert.ok(events.some(e => e.event === 'on_chat_model_stream'));
    assert.ok(events.some(e => e.event === 'on_chat_model_end'));
  });

  it('should stream tool start and end events', async () => {
    const model = mockModel([
      { content: '', tool_calls: [{ id: 'tc1', name: 'calc', args: { x: 1 } }] },
      { content: 'The result is available, and here is a complete answer for you.' },
    ]);
    const tool = mockTool('calc', '42');
    const agent = createReActAgent({ model, tools: [tool], systemPrompt: 'test' });

    const events = await collectEvents(
      agent.streamEvents({ messages: [{ role: 'human', content: 'calculate' }] }),
    );
    assert.ok(events.some(e => e.event === 'on_tool_start' && e.name === 'calc'));
    assert.ok(events.some(e => e.event === 'on_tool_end' && e.name === 'calc'));
  });

  it('should handle tool not found gracefully', async () => {
    const model = mockModel([
      { content: '', tool_calls: [{ id: 'tc1', name: 'nonexistent', args: {} }] },
      { content: 'Sorry, that tool was not available. Here is a detailed response instead.' },
    ]);
    const agent = createReActAgent({ model, tools: [], systemPrompt: 'test' });

    const result = await agent.invoke({ messages: [{ role: 'human', content: 'hi' }] });
    const toolMsg = result.messages.find(m => m.role === 'tool');
    assert.ok(toolMsg);
    assert.ok(typeof toolMsg.content === 'string' && toolMsg.content.includes('not found'));
  });

  it('should handle tool execution errors', async () => {
    const failTool: StructuredTool = {
      name: 'fail',
      description: 'always fails',
      schema: { type: 'object', properties: {} },
      invoke: async () => { throw new Error('boom'); },
    } as StructuredTool;

    const model = mockModel([
      { content: '', tool_calls: [{ id: 'tc1', name: 'fail', args: {} }] },
      { content: 'The tool failed. Here is an explanation with enough detail for you.' },
    ]);
    const agent = createReActAgent({ model, tools: [failTool], systemPrompt: 'test' });

    const result = await agent.invoke({ messages: [{ role: 'human', content: 'do it' }] });
    const toolMsg = result.messages.find(m => m.role === 'tool');
    assert.ok(toolMsg);
    assert.ok(typeof toolMsg.content === 'string' && toolMsg.content.includes('Error: boom'));
  });

  it('should nudge model on empty responses and break after max retries', async () => {
    // 3 empty responses → should nudge and eventually stop
    const model = mockModel([
      { content: '' },
      { content: '' },
      { content: '' },
    ]);
    const agent = createReActAgent({ model, tools: [], systemPrompt: 'test' });

    const result = await agent.invoke({ messages: [{ role: 'human', content: 'hi' }] });
    // Should have nudge messages injected
    const humanNudges = result.messages.filter(
      m => m.role === 'human' && typeof m.content === 'string' && m.content.includes('continue'),
    );
    assert.ok(humanNudges.length >= 1);
  });

  it('should detect repeated identical tool calls and break loop', async () => {
    const model = mockModel([
      { content: '', tool_calls: [{ id: 'tc1', name: 'search', args: { q: 'same' } }] },
      { content: '', tool_calls: [{ id: 'tc2', name: 'search', args: { q: 'same' } }] },
      { content: '', tool_calls: [{ id: 'tc3', name: 'search', args: { q: 'same' } }] },
      { content: '', tool_calls: [{ id: 'tc4', name: 'search', args: { q: 'same' } }] },
      { content: '', tool_calls: [{ id: 'tc5', name: 'search', args: { q: 'same' } }] },
      { content: '', tool_calls: [{ id: 'tc6', name: 'search', args: { q: 'same' } }] },
    ]);
    const tool = mockTool('search', 'result');
    const agent = createReActAgent({ model, tools: [tool], systemPrompt: 'test' });

    const events = await collectEvents(
      agent.streamEvents({ messages: [{ role: 'human', content: 'search' }] }),
    );
    // Should eventually emit on_loop_stopped
    assert.ok(events.some(e => e.event === 'on_loop_stopped'));
  });

  it('should abort on signal', async () => {
    const controller = new AbortController();
    controller.abort();

    const model = mockModel([{ content: 'never reached' }]);
    const agent = createReActAgent({ model, tools: [], systemPrompt: 'test' });

    await assert.rejects(
      () => agent.invoke({ messages: [{ role: 'human', content: 'hi' }] }, { signal: controller.signal }),
      /Aborted/,
    );
  });

  it('should respect recursionLimit', async () => {
    // Model always returns tool calls — should stop at recursion limit
    let callCount = 0;
    const infiniteModel: ChatModel = {
      async invoke() { return { content: '' }; },
      async *stream() {
        callCount++;
        yield { content: '', tool_calls: [{ id: `tc${callCount}`, name: 'ping', args: { n: callCount } }] };
      },
      bindTools() { return infiniteModel; },
      withStructuredOutput() { return infiniteModel; },
    };
    const tool = mockTool('ping', 'pong');
    const agent = createReActAgent({ model: infiniteModel, tools: [tool], systemPrompt: 'test' });

    await agent.invoke(
      { messages: [{ role: 'human', content: 'go' }] },
      { recursionLimit: 3 },
    );
    assert.equal(callCount, 3);
  });

  it('should track token usage across iterations', async () => {
    const model = mockModel([
      { content: '', tool_calls: [{ id: 'tc1', name: 'calc', args: {} }], usage_metadata: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } },
      { content: 'Done — here is a detailed answer with enough characters to be accepted.', usage_metadata: { input_tokens: 200, output_tokens: 80, total_tokens: 280 } },
    ]);
    const tool = mockTool('calc', '42');
    const agent = createReActAgent({ model, tools: [tool], systemPrompt: 'test' });

    const events = await collectEvents(
      agent.streamEvents({ messages: [{ role: 'human', content: 'calc' }] }),
    );

    const iterationEvents = events.filter(e => e.event === 'on_react_iteration');
    // Second iteration should show cumulative tokens from first
    const second = iterationEvents[1];
    if (second) {
      assert.equal(second.data.inputTokens, 100);
      assert.equal(second.data.outputTokens, 50);
    }
  });

  it('should accept short text as final if reasoning is present', async () => {
    const model = mockModel([
      { content: 'Yes.', reasoning: 'The user asked a yes/no question so I can respond briefly.' },
    ]);
    const agent = createReActAgent({ model, tools: [], systemPrompt: 'test' });

    const result = await agent.invoke({ messages: [{ role: 'human', content: 'Is water wet?' }] });
    const lastAi = result.messages.filter(m => m.role === 'ai').pop();
    assert.ok(lastAi);
    // Should contain both reasoning and content
    assert.ok(typeof lastAi.content === 'string' && lastAi.content.includes('Yes.'));
  });

  it('should handle model with no tools (bindTools not called)', async () => {
    let bindToolsCalled = false;
    const model: ChatModel = {
      async invoke() { return { content: '' }; },
      async *stream() {
        yield { content: 'A response that is long enough to be accepted as the final answer.' };
      },
      bindTools() { bindToolsCalled = true; return model; },
      withStructuredOutput() { return model; },
    };
    const agent = createReActAgent({ model, tools: [], systemPrompt: 'test' });

    await agent.invoke({ messages: [{ role: 'human', content: 'hi' }] });
    assert.equal(bindToolsCalled, false);
  });
});
