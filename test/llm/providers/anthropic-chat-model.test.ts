import { describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { z } from 'zod';
import { AnthropicChatModel } from '../../../lib/llm/providers/anthropic-chat-model.ts';
import type { BaseMessage } from '../../../lib/types/llm-types.ts';

function createModel(clientOverride?: Record<string, any>) {
  const model = new AnthropicChatModel({
    apiKey: 'test-key',
    modelName: 'claude-3',
    temperature: 0.5,
    maxTokens: 100,
  });
  if (clientOverride) {
    (model as any).client = clientOverride;
  }
  return model;
}

describe('AnthropicChatModel', () => {
  describe('invoke', () => {
    it('should handle all message types and return response', async () => {
      const messages: BaseMessage[] = [
        { role: 'system', content: 'Be helpful' },
        { role: 'system', content: 'And concise' },
        { role: 'human', content: 'Hello' },
        { role: 'ai', content: 'Hi', tool_calls: [{ id: 'tc1', name: 'search', args: { q: 'test' } }] },
        { role: 'tool', content: 'result', tool_call_id: 'tc1', name: 'search' },
      ];

      const mockClient = {
        messages: {
          create: mock.fn(async () => ({
            content: [{ type: 'text', text: 'Response' }],
            usage: { input_tokens: 10, output_tokens: 5 },
          })),
        },
      };

      const model = createModel(mockClient);
      const result = await model.invoke(messages);

      assert.equal(result.content, 'Response');
      assert.equal(result.usage_metadata?.input_tokens, 10);
      assert.equal(result.usage_metadata?.output_tokens, 5);
      assert.equal(result.usage_metadata?.total_tokens, 15);

      // Verify system was combined and messages formatted
      const callArgs = mockClient.messages.create.mock.calls[0]!.arguments[0];
      assert.equal(callArgs.system, 'Be helpful\n\nAnd concise');
      // human message
      assert.equal(callArgs.messages[0].role, 'user');
      // ai message with tool_use
      assert.equal(callArgs.messages[1].role, 'assistant');
      assert.equal(callArgs.messages[1].content[0].type, 'text');
      assert.equal(callArgs.messages[1].content[1].type, 'tool_use');
      // tool result
      assert.equal(callArgs.messages[2].role, 'user');
      assert.equal(callArgs.messages[2].content[0].type, 'tool_result');
    });

    it('should parse tool calls from response', async () => {
      const mockClient = {
        messages: {
          create: mock.fn(async () => ({
            content: [
              { type: 'text', text: 'Let me search' },
              { type: 'tool_use', id: 'call_1', name: 'search', input: { query: 'hello' } },
            ],
            usage: { input_tokens: 5, output_tokens: 10 },
          })),
        },
      };

      const model = createModel(mockClient);
      const result = await model.invoke([{ role: 'human', content: 'search' }]);

      assert.equal(result.content, 'Let me search');
      assert.ok(result.tool_calls);
      assert.equal(result.tool_calls!.length, 1);
      assert.equal(result.tool_calls![0]!.name, 'search');
      assert.deepEqual(result.tool_calls![0]!.args, { query: 'hello' });
    });

    it('should handle ai message without content (only tool calls)', async () => {
      const messages: BaseMessage[] = [
        { role: 'ai', content: '', tool_calls: [{ id: 'tc1', name: 'calc', args: { x: 1 } }] },
      ];

      const mockClient = {
        messages: {
          create: mock.fn(async () => ({
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 5, output_tokens: 5 },
          })),
        },
      };

      const model = createModel(mockClient);
      await model.invoke(messages);

      const callArgs = mockClient.messages.create.mock.calls[0]!.arguments[0];
      // AI message should only have tool_use, no text (since content was empty)
      assert.equal(callArgs.messages[0].content.length, 1);
      assert.equal(callArgs.messages[0].content[0].type, 'tool_use');
    });
  });

  describe('stream', () => {
    it('should stream text content and yield usage', async () => {
      const events = [
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: ' World' } },
        { type: 'message_delta', usage: { output_tokens: 5 } },
      ];

      const mockClient = {
        messages: {
          stream: mock.fn(() => ({
            [Symbol.asyncIterator]: async function* () {
              for (const event of events) yield event;
            },
          })),
        },
      };

      const model = createModel(mockClient);
      const results: any[] = [];
      for await (const chunk of model.stream([{ role: 'human', content: 'hi' }])) {
        results.push(chunk);
      }

      assert.equal(results.length, 3);
      assert.equal(results[0].content, 'Hello');
      assert.equal(results[1].content, ' World');
      assert.equal(results[2].usage_metadata?.output_tokens, 5);
    });

    it('should accumulate tool calls from stream events', async () => {
      const events = [
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'search' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query"' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ':"test"}' } },
        { type: 'message_delta', usage: { output_tokens: 10 } },
      ];

      const mockClient = {
        messages: {
          stream: mock.fn(() => ({
            [Symbol.asyncIterator]: async function* () {
              for (const event of events) yield event;
            },
          })),
        },
      };

      const model = createModel(mockClient);
      const results: any[] = [];
      for await (const chunk of model.stream([{ role: 'human', content: 'search' }])) {
        results.push(chunk);
      }

      const lastChunk = results[results.length - 1];
      assert.ok(lastChunk.tool_calls);
      assert.equal(lastChunk.tool_calls[0].name, 'search');
      assert.deepEqual(lastChunk.tool_calls[0].args, { query: 'test' });
    });
  });

  describe('bindTools', () => {
    it('should return a new model with bound tools', () => {
      const mockTool = {
        name: 'test_tool',
        description: 'A test',
        schema: z.object({ input: z.string() }),
        invoke: async () => 'result',
      };
      const model = createModel();
      const bound = model.bindTools([mockTool]);
      assert.notStrictEqual(bound, model);
    });

    it('should include tools in request when bound', async () => {
      const mockTool = {
        name: 'calculator',
        description: 'Calc',
        schema: z.object({ expr: z.string() }),
        invoke: async () => '42',
      };

      const mockClient = {
        messages: {
          create: mock.fn(async () => ({
            content: [{ type: 'text', text: 'done' }],
            usage: { input_tokens: 5, output_tokens: 5 },
          })),
        },
      };

      const model = createModel(mockClient);
      const bound = model.bindTools([mockTool]);
      (bound as any).client = mockClient;

      await bound.invoke([{ role: 'human', content: 'calc' }]);
      const callArgs = mockClient.messages.create.mock.calls[0]!.arguments[0];
      assert.ok(callArgs.tools);
      assert.equal(callArgs.tools.length, 1);
      assert.equal(callArgs.tools[0].name, 'calculator');
    });
  });

  describe('withStructuredOutput', () => {
    it('should return a new model with structured schema', () => {
      const schema = { type: 'object', properties: { name: { type: 'string' } } };
      const model = createModel();
      const structured = model.withStructuredOutput(schema);
      assert.notStrictEqual(structured, model);
    });
  });
});
