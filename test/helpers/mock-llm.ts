/**
 * Mock LLM for testing. Provides configurable invoke/stream responses
 * without requiring any real LLM provider.
 */
export interface MockLLMOptions {
  /** Static response content for invoke() calls */
  response?: string;
  /** Sequence of responses (cycles through on repeated calls) */
  responses?: string[];
  /** Chunks for stream() calls */
  streamChunks?: string[];
  /** If true, invoke() will throw this error */
  error?: Error;
}

export function createMockLLM(options: MockLLMOptions = {}) {
  const {
    response = 'mock response',
    responses,
    streamChunks = ['chunk1', 'chunk2'],
    error,
  } = options;

  let callCount = 0;

  return {
    invoke: async (_input: unknown) => {
      if (error) throw error;
      const content = responses
        ? responses[callCount++ % responses.length]!
        : response;
      return { content };
    },
    stream: async function* (_input: unknown) {
      if (error) throw error;
      for (const chunk of streamChunks) {
        yield { content: chunk };
      }
    },
    withStructuredOutput: (schema: unknown) => {
      // Return self — structured output wrapper tests can verify this was called
      return createMockLLM(options);
    },
    bind: () => createMockLLM(options),
    getCallCount: () => callCount,
  } as any;
}
