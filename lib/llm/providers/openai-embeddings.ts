import OpenAI, { APIConnectionError } from 'openai';
import type { Embeddings } from '../../types/llm-types.ts';

interface OpenAIEmbeddingsOptions {
  apiKey?: string;
  modelName: string;
  baseURL?: string;
  dimensions?: number;
  maxRetries?: number;
}

const DEFAULT_MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;
const INITIAL_BATCH_SIZE = 128;
const MIN_BATCH_SIZE = 1;

function isBatchTooLargeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /too large to process|batch.size/i.test(error.message);
}

export class OpenAIEmbeddingsProvider implements Embeddings {
  private client: OpenAI;
  private modelName: string;
  private dimensions?: number;
  private baseURL?: string;
  private maxRetries: number;

  constructor(options: OpenAIEmbeddingsOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey ?? process.env.OPENAI_API_KEY ?? 'not-set',
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      maxRetries: 0, // We handle retries ourselves for better control
    });
    this.modelName = options.modelName;
    this.dimensions = options.dimensions;
    this.baseURL = options.baseURL;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  private async withRetry<T>(operation: () => Promise<T>, context: string): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        const isConnectionError = error instanceof APIConnectionError
          || (error instanceof Error && /connect|ECONNREFUSED|ECONNRESET|socket|network/i.test(error.message));

        if (!isConnectionError || attempt === this.maxRetries) {
          throw error;
        }

        lastError = error instanceof Error ? error : new Error(String(error));
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        const url = this.baseURL ?? 'default OpenAI endpoint';
        console.warn(`[Embeddings] ${context}: connection failed (${url}), retry ${attempt + 1}/${this.maxRetries} in ${delay}ms — ${lastError.message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw lastError;
  }

  private async embedBatch(items: { text: string; index: number }[]): Promise<{ embedding: number[]; index: number }[]> {
    const response = await this.withRetry(async () => {
      return this.client.embeddings.create({
        model: this.modelName,
        input: items.map((b) => b.text),
        encoding_format: 'float',
        ...(this.dimensions ? { dimensions: this.dimensions } : {}),
      });
    }, `embedBatch[${items.length} docs]`);

    return response.data
      .sort((a, b) => a.index - b.index)
      .map((d, j) => ({ embedding: d.embedding, index: items[j]!.index }));
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.withRetry(async () => {
      const response = await this.client.embeddings.create({
        model: this.modelName,
        input: text,
        encoding_format: 'float',
        ...(this.dimensions ? { dimensions: this.dimensions } : {}),
      });
      return response.data[0]!.embedding;
    }, 'embedQuery');
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    // Filter empty strings and track original indices
    const filtered: { text: string; index: number }[] = [];
    for (let i = 0; i < texts.length; i++) {
      if (texts[i].trim()) filtered.push({ text: texts[i], index: i });
    }

    const results: number[][] = new Array(texts.length);
    let effectiveBatchSize = INITIAL_BATCH_SIZE;

    for (let i = 0; i < filtered.length; ) {
      const batch = filtered.slice(i, i + effectiveBatchSize);

      try {
        const batchResults = await this.embedBatch(batch);
        for (const r of batchResults) {
          results[r.index] = r.embedding;
        }
        i += batch.length;
      } catch (error) {
        if (!isBatchTooLargeError(error)) throw error;

        if (batch.length <= MIN_BATCH_SIZE) {
          throw new Error(
            `Single document (index ${batch[0]!.index}) is too large for the embedding server's batch limit. ` +
            `Reduce chunkSize in your knowledge store's splitter config. ` +
            `Original error: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        // Bisect: halve based on the actual failing batch size (not effectiveBatchSize which may be larger)
        effectiveBatchSize = Math.max(MIN_BATCH_SIZE, Math.floor(batch.length / 2));
        console.warn(
          `[Embeddings] Batch of ${batch.length} docs exceeded server limit, reducing batch size to ${effectiveBatchSize}`
        );
        // Don't advance i — retry with smaller batch
      }
    }

    // Fill empty-string slots with zero vectors
    if (filtered.length < texts.length) {
      const dim = results.find((r) => r)?.length ?? 0;
      const zero = new Array(dim).fill(0);
      for (let i = 0; i < results.length; i++) {
        if (!results[i]) results[i] = zero;
      }
    }

    return results;
  }
}
