import { describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { z } from 'zod';
import { GeminiChatModel } from '../../../lib/llm/providers/gemini-chat-model.ts';
import type { BaseMessage } from '../../../lib/types/llm-types.ts';

function createModel(genAIOverride?: Record<string, any>) {
  const model = new GeminiChatModel({
    apiKey: 'test-key',
    modelName: 'gemini-pro',
    temperature: 0.5,
    maxTokens: 100,
  });
  if (genAIOverride) {
    (model as any).genAI = genAIOverride;
  }
  return model;
}

function mockGenAI(generateResult: any, streamResult?: any) {
  return {
    getGenerativeModel: mock.fn(() => ({
      generateContent: mock.fn(async () => generateResult),
      generateContentStream: mock.fn(async () => streamResult),
    })),
  };
}

describe('GeminiChatModel', () => {
  describe('invoke', () => {
    it('should handle all message types and return response', async () => {
      const messages: BaseMessage[] = [
        { role: 'system', content: 'Be helpful' },
        { role: 'human', content: 'Hello' },
        { role: 'ai', content: 'Hi', tool_calls: [{ id: 'tc1', name: 'search', args: { q: 'test' } }] },
        { role: 'tool', content: 'result', tool_call_id: 'tc1', name: 'search' },
      ];

      const genAI = mockGenAI({
        response: {
          candidates: [{
            content: {
              parts: [{ text: 'Response text' }],
            },
          }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        },
      });

      const model = createModel(genAI);
      const result = await model.invoke(messages);

      assert.equal(result.content, 'Response text');
      assert.equal(result.usage_metadata?.input_tokens, 10);
      assert.equal(result.usage_metadata?.output_tokens, 5);
      assert.equal(result.usage_metadata?.total_tokens, 15);
    });

    it('should parse function calls from response', async () => {
      const genAI = mockGenAI({
        response: {
          candidates: [{
            content: {
              parts: [
                { functionCall: { name: 'search', args: { query: 'hello' } } },
              ],
            },
          }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10, totalTokenCount: 15 },
        },
      });

      const model = createModel(genAI);
      const result = await model.invoke([{ role: 'human', content: 'search' }]);

      assert.ok(result.tool_calls);
      assert.equal(result.tool_calls!.length, 1);
      assert.equal(result.tool_calls![0]!.name, 'search');
      assert.deepEqual(result.tool_calls![0]!.args, { query: 'hello' });
    });

    it('should handle response without candidates', async () => {
      const genAI = mockGenAI({
        response: {
          candidates: undefined,
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0, totalTokenCount: 5 },
        },
      });

      const model = createModel(genAI);
      const result = await model.invoke([{ role: 'human', content: 'hi' }]);
      assert.equal(result.content, '');
      assert.equal(result.tool_calls, undefined);
    });

    it('should handle response without usage metadata', async () => {
      const genAI = mockGenAI({
        response: {
          candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        },
      });

      const model = createModel(genAI);
      const result = await model.invoke([{ role: 'human', content: 'hi' }]);
      assert.equal(result.content, 'ok');
      assert.equal(result.usage_metadata, undefined);
    });

    it('should combine multiple system messages', async () => {
      const messages: BaseMessage[] = [
        { role: 'system', content: 'Rule 1' },
        { role: 'system', content: 'Rule 2' },
        { role: 'human', content: 'Hello' },
      ];

      const genAI = mockGenAI({
        response: {
          candidates: [{ content: { parts: [{ text: 'ok' }] } }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 },
        },
      });

      const model = createModel(genAI);
      await model.invoke(messages);

      const getModelArgs = genAI.getGenerativeModel.mock.calls[0]!.arguments[0];
      assert.equal(getModelArgs.systemInstruction, 'Rule 1\n\nRule 2');
    });
  });

  describe('stream', () => {
    it('should stream content and yield usage', async () => {
      const chunks = [
        {
          candidates: [{ content: { parts: [{ text: 'Hello' }] } }],
          usageMetadata: undefined,
        },
        {
          candidates: [{ content: { parts: [{ text: ' World' }] } }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
        },
      ];

      const genAI = mockGenAI(null, {
        stream: (async function* () {
          for (const chunk of chunks) yield chunk;
        })(),
      });

      const model = createModel(genAI);
      const results: any[] = [];
      for await (const chunk of model.stream([{ role: 'human', content: 'hi' }])) {
        results.push(chunk);
      }

      assert.equal(results.length, 2);
      assert.equal(results[0].content, 'Hello');
      assert.equal(results[1].content, ' World');
      assert.equal(results[1].usage_metadata?.total_tokens, 7);
    });

    it('should handle function calls in stream', async () => {
      const chunks = [
        {
          candidates: [{
            content: {
              parts: [{ functionCall: { name: 'search', args: { q: 'test' } } }],
            },
          }],
        },
      ];

      const genAI = mockGenAI(null, {
        stream: (async function* () {
          for (const chunk of chunks) yield chunk;
        })(),
      });

      const model = createModel(genAI);
      const results: any[] = [];
      for await (const chunk of model.stream([{ role: 'human', content: 'search' }])) {
        results.push(chunk);
      }

      assert.ok(results[0].tool_calls);
      assert.equal(results[0].tool_calls[0].name, 'search');
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

      const genAI = mockGenAI({
        response: {
          candidates: [{ content: { parts: [{ text: 'done' }] } }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 },
        },
      });

      const model = createModel(genAI);
      const bound = model.bindTools([mockTool]);
      (bound as any).genAI = genAI;

      await bound.invoke([{ role: 'human', content: 'calc' }]);
      const getModelArgs = genAI.getGenerativeModel.mock.calls[0]!.arguments[0];
      assert.ok(getModelArgs.tools);
      assert.ok(getModelArgs.tools[0].functionDeclarations);
      assert.equal(getModelArgs.tools[0].functionDeclarations[0].name, 'calculator');
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

  describe('schema conversion', () => {
    it('should convert complex tool schemas with arrays and nested objects', async () => {
      const complexTool = {
        name: 'complex_tool',
        description: 'Complex',
        schema: z.object({
          name: z.string().describe('The name'),
          count: z.number(),
          active: z.boolean(),
          tags: z.array(z.string()),
          nested: z.object({
            inner: z.string(),
          }),
        }),
        invoke: async () => 'result',
      };

      const genAI = mockGenAI({
        response: {
          candidates: [{ content: { parts: [{ text: 'ok' }] } }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 },
        },
      });

      const model = createModel(genAI);
      const bound = model.bindTools([complexTool]);
      (bound as any).genAI = genAI;

      await bound.invoke([{ role: 'human', content: 'test' }]);
      const getModelArgs = genAI.getGenerativeModel.mock.calls[0]!.arguments[0];
      const params = getModelArgs.tools[0].functionDeclarations[0].parameters;
      assert.ok(params.properties.name);
      assert.ok(params.properties.tags);
      assert.ok(params.properties.nested);
    });
  });
});
