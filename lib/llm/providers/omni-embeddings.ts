import type { LlmModel } from '@agent-orcha/node-omni-orcha';
import type { Embeddings } from '../../types/llm-types.ts';
import { OmniModelCache } from './omni-model-cache.ts';

export interface OmniEmbeddingsOptions {
  modelPath: string;
  contextSize?: number;
}

export class OmniEmbeddingsProvider implements Embeddings {
  private options: OmniEmbeddingsOptions;
  private llm: LlmModel | null = null;

  constructor(options: OmniEmbeddingsOptions) {
    this.options = options;
  }

  private async ensureModel(): Promise<LlmModel> {
    if (!this.llm) {
      this.llm = await OmniModelCache.getLlmEmbed(this.options.modelPath, {
        contextSize: this.options.contextSize,
      });
    }
    return this.llm;
  }

  async embedQuery(text: string): Promise<number[]> {
    const model = await this.ensureModel();
    const result = await model.embed(text);
    return Array.from(result);
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const model = await this.ensureModel();
    const results = await model.embedBatch(texts);
    return results.map((r: Float64Array) => Array.from(r));
  }
}
