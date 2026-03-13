import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';

describe('OpenAIEmbeddingsProvider', () => {
  it('should construct with explicit options', async () => {
    const { OpenAIEmbeddingsProvider } = await import('../../lib/llm/providers/openai-embeddings.ts');
    const provider = new OpenAIEmbeddingsProvider({
      apiKey: 'test-key',
      modelName: 'text-embedding-3-small',
    });
    assert.ok(provider);
    assert.equal(typeof provider.embedQuery, 'function');
    assert.equal(typeof provider.embedDocuments, 'function');
  });

  it('should construct with baseURL option', async () => {
    const { OpenAIEmbeddingsProvider } = await import('../../lib/llm/providers/openai-embeddings.ts');
    const provider = new OpenAIEmbeddingsProvider({
      apiKey: 'test-key',
      modelName: 'text-embedding-3-small',
      baseURL: 'http://localhost:1234/v1',
    });
    assert.ok(provider);
  });

  it('should construct with dimensions option', async () => {
    const { OpenAIEmbeddingsProvider } = await import('../../lib/llm/providers/openai-embeddings.ts');
    const provider = new OpenAIEmbeddingsProvider({
      apiKey: 'test-key',
      modelName: 'text-embedding-3-small',
      dimensions: 512,
    });
    assert.ok(provider);
  });

  it('should use OPENAI_API_KEY env var when apiKey not provided', async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'env-openai-key';

    try {
      const { OpenAIEmbeddingsProvider } = await import('../../lib/llm/providers/openai-embeddings.ts');
      const provider = new OpenAIEmbeddingsProvider({
        modelName: 'text-embedding-3-small',
      });
      assert.ok(provider);
    } finally {
      if (originalKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalKey;
      }
    }
  });

  it('should default to "not-set" when no API key available', async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const { OpenAIEmbeddingsProvider } = await import('../../lib/llm/providers/openai-embeddings.ts');
      const provider = new OpenAIEmbeddingsProvider({
        modelName: 'text-embedding-3-small',
      });
      assert.ok(provider);
    } finally {
      if (originalKey !== undefined) {
        process.env.OPENAI_API_KEY = originalKey;
      }
    }
  });
});

describe('OpenAIEmbeddingsProvider with mocked client', () => {
  it('embedQuery should call client and return embedding', async () => {
    const { OpenAIEmbeddingsProvider } = await import('../../lib/llm/providers/openai-embeddings.ts');
    const provider = new OpenAIEmbeddingsProvider({
      apiKey: 'test-key',
      modelName: 'text-embedding-3-small',
    });

    // Mock the internal client's embeddings.create method
    const mockCreate = mock.fn(async (params: any) => ({
      data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
      model: params.model,
      usage: { prompt_tokens: 5, total_tokens: 5 },
    }));

    (provider as any).client = { embeddings: { create: mockCreate } };

    const result = await provider.embedQuery('test input');
    assert.deepStrictEqual(result, [0.1, 0.2, 0.3]);
    assert.equal(mockCreate.mock.calls.length, 1);

    const callArgs = mockCreate.mock.calls[0]!.arguments[0];
    assert.equal(callArgs.model, 'text-embedding-3-small');
    assert.equal(callArgs.input, 'test input');
    assert.equal(callArgs.encoding_format, 'float');
  });

  it('embedQuery should include dimensions when set', async () => {
    const { OpenAIEmbeddingsProvider } = await import('../../lib/llm/providers/openai-embeddings.ts');
    const provider = new OpenAIEmbeddingsProvider({
      apiKey: 'test-key',
      modelName: 'text-embedding-3-small',
      dimensions: 256,
    });

    const mockCreate = mock.fn(async (_params: any) => ({
      data: [{ embedding: [0.5, 0.6], index: 0 }],
    }));

    (provider as any).client = { embeddings: { create: mockCreate } };

    await provider.embedQuery('test');
    const callArgs = mockCreate.mock.calls[0]!.arguments[0];
    assert.equal(callArgs.dimensions, 256);
  });

  it('embedDocuments should embed multiple texts', async () => {
    const { OpenAIEmbeddingsProvider } = await import('../../lib/llm/providers/openai-embeddings.ts');
    const provider = new OpenAIEmbeddingsProvider({
      apiKey: 'test-key',
      modelName: 'text-embedding-3-small',
    });

    const mockCreate = mock.fn(async (params: any) => ({
      data: params.input.map((text: string, i: number) => ({
        embedding: [i * 0.1, i * 0.2],
        index: i,
      })),
    }));

    (provider as any).client = { embeddings: { create: mockCreate } };

    const result = await provider.embedDocuments(['doc1', 'doc2', 'doc3']);
    assert.equal(result.length, 3);
    assert.deepStrictEqual(result[0], [0, 0]);
    assert.deepStrictEqual(result[1], [0.1, 0.2]);
    assert.deepStrictEqual(result[2], [0.2, 0.4]);
  });

  it('embedDocuments should fill empty strings with zero vectors', async () => {
    const { OpenAIEmbeddingsProvider } = await import('../../lib/llm/providers/openai-embeddings.ts');
    const provider = new OpenAIEmbeddingsProvider({
      apiKey: 'test-key',
      modelName: 'text-embedding-3-small',
    });

    const mockCreate = mock.fn(async (params: any) => ({
      data: params.input.map((text: string, i: number) => ({
        embedding: [1.0, 2.0],
        index: i,
      })),
    }));

    (provider as any).client = { embeddings: { create: mockCreate } };

    const result = await provider.embedDocuments(['hello', '', 'world', '  ']);
    assert.equal(result.length, 4);
    // Non-empty strings get embeddings
    assert.deepStrictEqual(result[0], [1.0, 2.0]);
    assert.deepStrictEqual(result[2], [1.0, 2.0]);
    // Empty/whitespace strings get zero vectors
    assert.deepStrictEqual(result[1], [0, 0]);
    assert.deepStrictEqual(result[3], [0, 0]);
  });

  it('embedDocuments should handle all empty strings', async () => {
    const { OpenAIEmbeddingsProvider } = await import('../../lib/llm/providers/openai-embeddings.ts');
    const provider = new OpenAIEmbeddingsProvider({
      apiKey: 'test-key',
      modelName: 'text-embedding-3-small',
    });

    const mockCreate = mock.fn(async () => ({ data: [] }));
    (provider as any).client = { embeddings: { create: mockCreate } };

    const result = await provider.embedDocuments(['', '  ', '']);
    assert.equal(result.length, 3);
    // All should be zero vectors (dim=0 since no real embeddings)
    for (const r of result) {
      assert.deepStrictEqual(r, []);
    }
    // No API calls since all texts are empty
    assert.equal(mockCreate.mock.calls.length, 0);
  });

  it('embedDocuments should halve batch size on "too large" errors', async () => {
    const { OpenAIEmbeddingsProvider } = await import('../../lib/llm/providers/openai-embeddings.ts');
    const provider = new OpenAIEmbeddingsProvider({
      apiKey: 'test-key',
      modelName: 'text-embedding-3-small',
    });

    let callCount = 0;
    const mockCreate = mock.fn(async (params: any) => {
      callCount++;
      if (callCount === 1 && params.input.length > 1) {
        throw new Error('Request payload too large');
      }
      return {
        data: params.input.map((text: string, i: number) => ({
          embedding: [0.5],
          index: i,
        })),
      };
    });

    (provider as any).client = { embeddings: { create: mockCreate } };

    const result = await provider.embedDocuments(['a', 'b']);
    assert.equal(result.length, 2);
    // Should have retried with smaller batches
    assert.ok(mockCreate.mock.calls.length > 1);
  });

  it('embedDocuments should throw non-"too large" errors', async () => {
    const { OpenAIEmbeddingsProvider } = await import('../../lib/llm/providers/openai-embeddings.ts');
    const provider = new OpenAIEmbeddingsProvider({
      apiKey: 'test-key',
      modelName: 'text-embedding-3-small',
    });

    const mockCreate = mock.fn(async () => {
      throw new Error('Network error');
    });

    (provider as any).client = { embeddings: { create: mockCreate } };

    await assert.rejects(
      () => provider.embedDocuments(['text']),
      { message: 'Network error' },
    );
  });

  it('embedDocuments should throw when batch size is 1 and "too large" error', async () => {
    const { OpenAIEmbeddingsProvider } = await import('../../lib/llm/providers/openai-embeddings.ts');
    const provider = new OpenAIEmbeddingsProvider({
      apiKey: 'test-key',
      modelName: 'text-embedding-3-small',
    });

    const mockCreate = mock.fn(async () => {
      throw new Error('Request too large for single item');
    });

    (provider as any).client = { embeddings: { create: mockCreate } };

    await assert.rejects(
      () => provider.embedDocuments(['a very long text']),
      { message: 'Request too large for single item' },
    );
  });

  it('embedDocuments should sort response by index', async () => {
    const { OpenAIEmbeddingsProvider } = await import('../../lib/llm/providers/openai-embeddings.ts');
    const provider = new OpenAIEmbeddingsProvider({
      apiKey: 'test-key',
      modelName: 'text-embedding-3-small',
    });

    // Return data out of order
    const mockCreate = mock.fn(async (_params: any) => ({
      data: [
        { embedding: [0.3], index: 2 },
        { embedding: [0.1], index: 0 },
        { embedding: [0.2], index: 1 },
      ],
    }));

    (provider as any).client = { embeddings: { create: mockCreate } };

    const result = await provider.embedDocuments(['a', 'b', 'c']);
    // Should be sorted by original index
    assert.deepStrictEqual(result[0], [0.1]);
    assert.deepStrictEqual(result[1], [0.2]);
    assert.deepStrictEqual(result[2], [0.3]);
  });
});
