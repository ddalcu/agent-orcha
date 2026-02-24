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
      apiKey: options.apiKey,
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
    const response = await this.client.embeddings.create({
      model: this.modelName,
      input: texts,
      encoding_format: 'float',
      ...(this.dimensions ? { dimensions: this.dimensions } : {}),
    });
    return response.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
}
