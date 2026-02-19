import { GoogleGenerativeAI } from '@google/generative-ai';
import type { Embeddings } from '../../types/llm-types.ts';

interface GeminiEmbeddingsOptions {
  apiKey?: string;
  modelName: string;
}

export class GeminiEmbeddingsProvider implements Embeddings {
  private genAI: GoogleGenerativeAI;
  private modelName: string;

  constructor(options: GeminiEmbeddingsOptions) {
    this.genAI = new GoogleGenerativeAI(options.apiKey ?? process.env.GOOGLE_API_KEY ?? '');
    this.modelName = options.modelName;
  }

  async embedQuery(text: string): Promise<number[]> {
    const model = this.genAI.getGenerativeModel({ model: this.modelName });
    const result = await model.embedContent(text);
    return result.embedding.values;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const model = this.genAI.getGenerativeModel({ model: this.modelName });
    const results = await Promise.all(
      texts.map((text) => model.embedContent(text))
    );
    return results.map((r) => r.embedding.values);
  }
}
