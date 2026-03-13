import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';

// Mock the GoogleGenerativeAI module before importing the provider
const mockEmbedContent = mock.fn(async (text: string) => ({
  embedding: { values: [0.1, 0.2, 0.3] },
}));

const mockGetGenerativeModel = mock.fn((_opts: any) => ({
  embedContent: mockEmbedContent,
}));

const MockGoogleGenerativeAI = mock.fn((_apiKey: string) => ({
  getGenerativeModel: mockGetGenerativeModel,
}));

// Mock the @google/generative-ai module so the real class uses our mock
mock.module('@google/generative-ai', {
  namedExports: {
    GoogleGenerativeAI: function(apiKey: string) {
      return MockGoogleGenerativeAI(apiKey);
    },
  },
});

const { GeminiEmbeddingsProvider } = await import('../../lib/llm/providers/gemini-embeddings.ts');

describe('GeminiEmbeddingsProvider', () => {
  beforeEach(() => {
    mockEmbedContent.mock.resetCalls();
    mockGetGenerativeModel.mock.resetCalls();
    MockGoogleGenerativeAI.mock.resetCalls();
  });

  it('should construct with explicit apiKey', () => {
    const provider = new GeminiEmbeddingsProvider({
      apiKey: 'test-api-key',
      modelName: 'text-embedding-004',
    });
    assert.ok(provider);
    assert.equal(MockGoogleGenerativeAI.mock.calls.length, 1);
    assert.equal(MockGoogleGenerativeAI.mock.calls[0]!.arguments[0], 'test-api-key');
  });

  it('should use GOOGLE_API_KEY env var when apiKey not provided', () => {
    const originalKey = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = 'env-api-key';

    try {
      const provider = new GeminiEmbeddingsProvider({
        modelName: 'text-embedding-004',
      });
      assert.ok(provider);
      // The constructor should have used the env var
      const lastCall = MockGoogleGenerativeAI.mock.calls[MockGoogleGenerativeAI.mock.calls.length - 1];
      assert.equal(lastCall!.arguments[0], 'env-api-key');
    } finally {
      if (originalKey === undefined) {
        delete process.env.GOOGLE_API_KEY;
      } else {
        process.env.GOOGLE_API_KEY = originalKey;
      }
    }
  });

  it('should fall back to empty string when no key is available', () => {
    const originalKey = process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    try {
      const provider = new GeminiEmbeddingsProvider({
        modelName: 'text-embedding-004',
      });
      assert.ok(provider);
      const lastCall = MockGoogleGenerativeAI.mock.calls[MockGoogleGenerativeAI.mock.calls.length - 1];
      assert.equal(lastCall!.arguments[0], '');
    } finally {
      if (originalKey !== undefined) {
        process.env.GOOGLE_API_KEY = originalKey;
      }
    }
  });

  it('should call embedContent for embedQuery and return values', async () => {
    const provider = new GeminiEmbeddingsProvider({
      apiKey: 'key',
      modelName: 'text-embedding-004',
    });

    const result = await provider.embedQuery('test query');
    assert.deepStrictEqual(result, [0.1, 0.2, 0.3]);
    assert.equal(mockEmbedContent.mock.calls.length, 1);
    assert.equal(mockEmbedContent.mock.calls[0]!.arguments[0], 'test query');
  });

  it('should call embedContent for each document in embedDocuments', async () => {
    const provider = new GeminiEmbeddingsProvider({
      apiKey: 'key',
      modelName: 'text-embedding-004',
    });

    const texts = ['doc1', 'doc2', 'doc3'];
    const results = await provider.embedDocuments(texts);

    assert.equal(results.length, 3);
    for (const r of results) {
      assert.deepStrictEqual(r, [0.1, 0.2, 0.3]);
    }
    assert.equal(mockEmbedContent.mock.calls.length, 3);
    assert.equal(mockEmbedContent.mock.calls[0]!.arguments[0], 'doc1');
    assert.equal(mockEmbedContent.mock.calls[1]!.arguments[0], 'doc2');
    assert.equal(mockEmbedContent.mock.calls[2]!.arguments[0], 'doc3');
  });

  it('should return empty array for embedDocuments with no texts', async () => {
    const provider = new GeminiEmbeddingsProvider({
      apiKey: 'key',
      modelName: 'text-embedding-004',
    });

    const results = await provider.embedDocuments([]);
    assert.deepStrictEqual(results, []);
    assert.equal(mockEmbedContent.mock.calls.length, 0);
  });

  it('should use the correct model name when calling getGenerativeModel', async () => {
    const provider = new GeminiEmbeddingsProvider({
      apiKey: 'key',
      modelName: 'custom-embedding-model',
    });

    await provider.embedQuery('test');

    // getGenerativeModel should have been called with the model name
    const calls = mockGetGenerativeModel.mock.calls;
    const lastCall = calls[calls.length - 1];
    assert.deepStrictEqual(lastCall!.arguments[0], { model: 'custom-embedding-model' });
  });
});
