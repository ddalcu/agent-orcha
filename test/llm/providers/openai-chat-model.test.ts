import { describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { z } from 'zod';
import { OpenAIChatModel } from '../../../lib/llm/providers/openai-chat-model.ts';
import type { BaseMessage } from '../../../lib/types/llm-types.ts';

function createModel(clientOverride?: Record<string, any>) {
  const model = new OpenAIChatModel({
    apiKey: 'test-key',
    modelName: 'gpt-4',
    temperature: 0.5,
    maxTokens: 100,
  });
  if (clientOverride) {
    (model as any).client = clientOverride;
  }
  return model;
}

describe('OpenAIChatModel', () => {
  describe('invoke', () => {
    it('should invoke with all message types and return response', async () => {
      const messages: BaseMessage[] = [
        { role: 'system', content: 'You are helpful' },
        { role: 'human', content: 'Hello' },
        { role: 'ai', content: 'Hi there', tool_calls: [{ id: 'tc1', name: 'search', args: { q: 'test' } }] },
        { role: 'tool', content: 'result', tool_call_id: 'tc1' },
      ];

      const mockClient = {
        chat: {
          completions: {
            create: mock.fn(async () => ({
              choices: [{
                message: {
                  content: 'Response text',
                  tool_calls: undefined,
                },
              }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            })),
          },
        },
      };

      const model = createModel(mockClient);
      const result = await model.invoke(messages);

      assert.equal(result.content, 'Response text');
      assert.equal(result.usage_metadata?.input_tokens, 10);
      assert.equal(result.usage_metadata?.output_tokens, 5);
      assert.equal(result.usage_metadata?.total_tokens, 15);

      // Verify the messages were transformed correctly
      const callArgs = mockClient.chat.completions.create.mock.calls[0]!.arguments[0];
      assert.equal(callArgs.messages[0].role, 'system');
      assert.equal(callArgs.messages[1].role, 'user');
      assert.equal(callArgs.messages[2].role, 'assistant');
      assert.ok(callArgs.messages[2].tool_calls);
      assert.equal(callArgs.messages[2].tool_calls[0].function.name, 'search');
      assert.equal(callArgs.messages[3].role, 'tool');
    });

    it('should parse tool calls from response', async () => {
      const mockClient = {
        chat: {
          completions: {
            create: mock.fn(async () => ({
              choices: [{
                message: {
                  content: null,
                  tool_calls: [{
                    type: 'function',
                    id: 'call_1',
                    function: { name: 'search', arguments: '{"query":"hello"}' },
                  }],
                },
              }],
              usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
            })),
          },
        },
      };

      const model = createModel(mockClient);
      const result = await model.invoke([{ role: 'human', content: 'search for hello' }]);

      assert.equal(result.content, '');
      assert.ok(result.tool_calls);
      assert.equal(result.tool_calls!.length, 1);
      assert.equal(result.tool_calls![0]!.name, 'search');
      assert.deepEqual(result.tool_calls![0]!.args, { query: 'hello' });
    });

    it('should handle response without usage', async () => {
      const mockClient = {
        chat: {
          completions: {
            create: mock.fn(async () => ({
              choices: [{ message: { content: 'ok' } }],
            })),
          },
        },
      };

      const model = createModel(mockClient);
      const result = await model.invoke([{ role: 'human', content: 'hi' }]);
      assert.equal(result.content, 'ok');
      assert.equal(result.usage_metadata, undefined);
    });

    it('should handle default message role fallback', async () => {
      const mockClient = {
        chat: {
          completions: {
            create: mock.fn(async () => ({
              choices: [{ message: { content: 'ok' } }],
            })),
          },
        },
      };

      const model = createModel(mockClient);
      await model.invoke([{ role: 'unknown' as any, content: 'hi' }]);
      const callArgs = mockClient.chat.completions.create.mock.calls[0]!.arguments[0];
      assert.equal(callArgs.messages[0].role, 'user');
    });
  });

  describe('stream', () => {
    it('should stream content chunks and yield usage', async () => {
      const streamChunks = [
        { choices: [{ delta: { content: 'Hello' } }] },
        { choices: [{ delta: { content: ' World' } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
      ];

      const mockClient = {
        chat: {
          completions: {
            create: mock.fn(async () => ({
              [Symbol.asyncIterator]: async function* () {
                for (const chunk of streamChunks) yield chunk;
              },
            })),
          },
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
      assert.equal(results[2].usage_metadata?.total_tokens, 7);
    });

    it('should accumulate tool call deltas across chunks', async () => {
      const streamChunks = [
        {
          choices: [{
            delta: {
              tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search', arguments: '{"q' } }],
            },
          }],
        },
        {
          choices: [{
            delta: {
              tool_calls: [{ index: 0, function: { arguments: 'uery":"test"}' } }],
            },
          }],
        },
        {
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
        },
      ];

      const mockClient = {
        chat: {
          completions: {
            create: mock.fn(async () => ({
              [Symbol.asyncIterator]: async function* () {
                for (const chunk of streamChunks) yield chunk;
              },
            })),
          },
        },
      };

      const model = createModel(mockClient);
      const results: any[] = [];
      for await (const chunk of model.stream([{ role: 'human', content: 'search' }])) {
        results.push(chunk);
      }

      // Last chunk should have accumulated tool calls
      const lastChunk = results[results.length - 1];
      assert.ok(lastChunk.tool_calls);
      assert.equal(lastChunk.tool_calls[0].name, 'search');
      assert.deepEqual(lastChunk.tool_calls[0].args, { query: 'test' });
    });
  });

  describe('bindTools', () => {
    it('should return a new model with bound tools', async () => {
      const mockTool = {
        name: 'test_tool',
        description: 'A test tool',
        schema: z.object({ input: z.string() }),
        invoke: async () => 'result',
      };

      const model = createModel();
      const bound = model.bindTools([mockTool]);

      assert.notStrictEqual(bound, model);
      // Bound model should have tools (check via invoking which would include tools in request)
      assert.ok(bound);
    });
  });

  describe('withStructuredOutput', () => {
    it('should return a new model with structured schema', async () => {
      const schema = { type: 'object', properties: { name: { type: 'string' } } };
      const model = createModel();
      const structured = model.withStructuredOutput(schema);

      assert.notStrictEqual(structured, model);

      // Verify the structured model sends response_format in requests
      const mockClient = {
        chat: {
          completions: {
            create: mock.fn(async () => ({
              choices: [{ message: { content: '{"name":"test"}' } }],
              usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
            })),
          },
        },
      };
      (structured as any).client = mockClient;

      await structured.invoke([{ role: 'human', content: 'give me structured' }]);
      const callArgs = mockClient.chat.completions.create.mock.calls[0]!.arguments[0];
      assert.ok(callArgs.response_format);
      assert.equal(callArgs.response_format.type, 'json_schema');
    });
  });

  describe('tools in requests', () => {
    it('should include tools in invoke when bound', async () => {
      const mockTool = {
        name: 'calculator',
        description: 'A calculator',
        schema: z.object({ expression: z.string() }),
        invoke: async () => '42',
      };

      const mockClient = {
        chat: {
          completions: {
            create: mock.fn(async () => ({
              choices: [{ message: { content: 'done' } }],
            })),
          },
        },
      };

      const model = createModel(mockClient);
      const bound = model.bindTools([mockTool]);
      (bound as any).client = mockClient;

      await bound.invoke([{ role: 'human', content: 'calc 2+2' }]);

      const callArgs = mockClient.chat.completions.create.mock.calls[0]!.arguments[0];
      assert.ok(callArgs.tools);
      assert.equal(callArgs.tools.length, 1);
      assert.equal(callArgs.tools[0].function.name, 'calculator');
    });
  });
});
