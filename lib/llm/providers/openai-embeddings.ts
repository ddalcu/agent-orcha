import OpenAI from 'openai';
import type { Embeddings } from '../../types/llm-types.ts';

interface OpenAIEmbeddingsOptions {
  apiKey?: string;
  modelName: string;
  baseURL?: string;
  dimensions?: number;
}

export class OpenAIEmbeddingsProvider implements Embeddings {
  private client: OpenAI;
  private modelName: string;
  private dimensions?: number;

  constructor(options: OpenAIEmbeddingsOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey ?? process.env.OPENAI_API_KEY ?? 'not-set',
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
    this.modelName = options.modelName;
    this.dimensions = options.dimensions;
  }

  async embedQuery(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.modelName,
      input: text,
      encoding_format: 'float',
      ...(this.dimensions ? { dimensions: this.dimensions } : {}),
    });
    return response.data[0]!.embedding;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    // Filter empty strings and track original indices
    const filtered: { text: string; index: number }[] = [];
    for (let i = 0; i < texts.length; i++) {
      if (texts[i].trim()) filtered.push({ text: texts[i], index: i });
    }

    const results: number[][] = new Array(texts.length);

    // Batch to avoid payload size limits; halve on "too large" errors (e.g. VRAM-limited GPUs)
    let batchSize = 128;
    for (let i = 0; i < filtered.length; ) {
      const batch = filtered.slice(i, i + batchSize);
      try {
        const response = await this.client.embeddings.create({
          model: this.modelName,
          input: batch.map((b) => b.text),
          encoding_format: 'float',
          ...(this.dimensions ? { dimensions: this.dimensions } : {}),
        });
        const sorted = response.data.sort((a, b) => a.index - b.index);
        for (let j = 0; j < sorted.length; j++) {
          results[batch[j].index] = sorted[j].embedding;
        }
        i += batch.length;
      } catch (error: any) {
        if (batchSize <= 1 || !/too large/i.test(error?.message ?? '')) throw error;
        batchSize = Math.floor(batchSize / 2);
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
