import { describe, it, beforeEach, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { OpenAIEmbeddingsProvider } from '../../lib/llm/providers/openai-embeddings.ts';

// Helper: create a mock OpenAI client response
function mockEmbeddingResponse(embeddings: number[][]) {
  return {
    data: embeddings.map((embedding, index) => ({ embedding, index })),
    model: 'test-model',
    object: 'list' as const,
    usage: { prompt_tokens: 0, total_tokens: 0 },
  };
}

// Helper: access private fields for mocking
function getClient(provider: OpenAIEmbeddingsProvider) {
  return (provider as any).client;
}

describe('OpenAIEmbeddingsProvider', () => {
  let provider: OpenAIEmbeddingsProvider;

  beforeEach(() => {
    provider = new OpenAIEmbeddingsProvider({
      apiKey: 'test-key',
      modelName: 'test-model',
      baseURL: 'http://127.0.0.1:9991/v1',
    });
  });

  describe('embedQuery', () => {
    it('should return embedding for a single text', async () => {
      const expected = [0.1, 0.2, 0.3];
      getClient(provider).embeddings = {
        create: mock.fn(async () => mockEmbeddingResponse([expected])),
      };

      const result = await provider.embedQuery('hello world');
      assert.deepEqual(result, expected);
    });
  });

  describe('embedDocuments', () => {
    it('should embed multiple texts as a batch', async () => {
      const embeddings = [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]];
      const calls: any[] = [];
      getClient(provider).embeddings = {
        create: mock.fn(async (params: any) => {
          calls.push(params.input);
          return mockEmbeddingResponse(embeddings);
        }),
      };

      const result = await provider.embedDocuments(['text1', 'text2', 'text3']);
      assert.equal(result.length, 3);
      assert.deepEqual(result[0], [0.1, 0.2]);
      assert.deepEqual(result[1], [0.3, 0.4]);
      assert.deepEqual(result[2], [0.5, 0.6]);
      assert.equal(calls.length, 1);
      assert.ok(Array.isArray(calls[0]));
    });

    it('should handle empty strings with zero vectors', async () => {
      getClient(provider).embeddings = {
        create: mock.fn(async () => mockEmbeddingResponse([[0.1, 0.2]])),
      };

      const result = await provider.embedDocuments(['text1', '', 'text3']);
      assert.equal(result.length, 3);
      assert.deepEqual(result[1], [0, 0]);
    });

    it('should handle all empty strings', async () => {
      const result = await provider.embedDocuments(['', '  ']);
      assert.equal(result.length, 2);
      assert.deepEqual(result[0], []);
      assert.deepEqual(result[1], []);
    });

    it('should bisect batch on "too large" error and succeed', async () => {
      const callInputs: string[][] = [];
      getClient(provider).embeddings = {
        create: mock.fn(async (params: any) => {
          const input = params.input as string[];
          callInputs.push(input);
          // Fail if batch has more than 2 docs
          if (input.length > 2) {
            throw new Error('input (999 tokens) is too large to process. increase the physical batch size');
          }
          return mockEmbeddingResponse(input.map(() => [0.1, 0.2]));
        }),
      };

      const texts = ['a', 'b', 'c', 'd'];
      const result = await provider.embedDocuments(texts);

      assert.equal(result.length, 4);
      // All results should have embeddings
      for (let i = 0; i < 4; i++) {
        assert.deepEqual(result[i], [0.1, 0.2]);
      }
      // First call fails (4 docs), then bisects: should succeed with smaller batches
      assert.ok(callInputs.length >= 3, `Expected at least 3 calls, got ${callInputs.length}`);
      // First call attempted all 4
      assert.equal(callInputs[0]!.length, 4);
      // Subsequent calls should be <= 2
      for (let i = 1; i < callInputs.length; i++) {
        assert.ok(callInputs[i]!.length <= 2, `Call ${i} had ${callInputs[i]!.length} docs, expected <= 2`);
      }
    });

    it('should throw clear error when single document is too large', async () => {
      getClient(provider).embeddings = {
        create: mock.fn(async () => {
          throw new Error('input (5000 tokens) is too large to process. increase the physical batch size');
        }),
      };

      await assert.rejects(
        () => provider.embedDocuments(['a very large document']),
        (err: Error) => {
          assert.ok(err.message.includes('Single document'));
          assert.ok(err.message.includes('chunkSize'));
          return true;
        }
      );
    });

    it('should carry effective batch size forward within a call', async () => {
      const callInputs: string[][] = [];
      let callCount = 0;
      getClient(provider).embeddings = {
        create: mock.fn(async (params: any) => {
          const input = params.input as string[];
          callInputs.push(input);
          callCount++;
          // Fail on first call only (batch too large)
          if (callCount === 1 && input.length > 1) {
            throw new Error('too large to process');
          }
          return mockEmbeddingResponse(input.map(() => [0.5]));
        }),
      };

      // 3 docs: first batch of 3 fails, bisects to 1, then continues with batch size 1
      const result = await provider.embedDocuments(['x', 'y', 'z']);
      assert.equal(result.length, 3);
      for (let i = 0; i < 3; i++) {
        assert.deepEqual(result[i], [0.5]);
      }
      // After bisection, all subsequent batches should be size 1
      // Call 1: [x,y,z] (fails), then size halves repeatedly until 1
      // Remaining calls: size 1 each
      const successCalls = callInputs.filter((_, idx) => idx > 0);
      for (const c of successCalls) {
        assert.ok(c.length <= 2, `Expected batch size <= 2 after bisection, got ${c.length}`);
      }
    });

    it('should propagate non-batch errors without bisecting', async () => {
      getClient(provider).embeddings = {
        create: mock.fn(async () => {
          throw new Error('Internal server error');
        }),
      };

      await assert.rejects(
        () => provider.embedDocuments(['text1']),
        (err: Error) => {
          assert.ok(!err.message.includes('Single document'));
          assert.ok(!err.message.includes('chunkSize'));
          return true;
        }
      );
    });
  });
});
