import { loadModel, createModel, detectGpu } from 'node-omni-orcha';
import type { LlmModel, ImageModel, TtsModel, GpuInfo, LlmLoadOptions, ImageLoadOptions } from 'node-omni-orcha';
import { logger } from '../../logger.ts';

export interface OmniModelStatus {
  llmChat: { loaded: boolean; modelPath: string | null };
  llmEmbed: { loaded: boolean; modelPath: string | null };
  image: { loaded: boolean; modelPath: string | null };
  tts: { loaded: boolean; modelPath: string | null };
  gpu: GpuInfo;
}

/**
 * Centralized singleton managing loaded node-omni-orcha model instances.
 * Implements "lazy load, keep loaded" — models load on first use and stay
 * in memory until explicitly swapped or unloaded.
 */
export class OmniModelCache {
  private static llmChat: LlmModel | null = null;
  private static llmChatPath: string | null = null;

  private static llmEmbed: LlmModel | null = null;
  private static llmEmbedPath: string | null = null;

  private static imageModel: ImageModel | null = null;
  private static imagePath: string | null = null;

  private static ttsModel: TtsModel | null = null;
  private static ttsPath: string | null = null;

  static async getLlmChat(modelPath: string, options?: LlmLoadOptions): Promise<LlmModel> {
    if (this.llmChat && this.llmChatPath === modelPath) {
      return this.llmChat;
    }
    if (this.llmChat) {
      logger.info(`[OmniModelCache] Unloading chat LLM: ${this.llmChatPath}`);
      await this.llmChat.unload();
    }
    logger.info(`[OmniModelCache] Loading chat LLM: ${modelPath}`);
    this.llmChat = await loadModel(modelPath, { ...options, type: 'llm' }) as LlmModel;
    this.llmChatPath = modelPath;
    return this.llmChat;
  }

  static async getLlmEmbed(modelPath: string, options?: LlmLoadOptions): Promise<LlmModel> {
    if (this.llmEmbed && this.llmEmbedPath === modelPath) {
      return this.llmEmbed;
    }
    if (this.llmEmbed) {
      logger.info(`[OmniModelCache] Unloading embedding LLM: ${this.llmEmbedPath}`);
      await this.llmEmbed.unload();
    }
    logger.info(`[OmniModelCache] Loading embedding LLM: ${modelPath}`);
    this.llmEmbed = await loadModel(modelPath, { ...options, type: 'llm' }) as LlmModel;
    this.llmEmbedPath = modelPath;
    return this.llmEmbed;
  }

  static async getImageModel(modelPath: string, options?: ImageLoadOptions): Promise<ImageModel> {
    if (this.imageModel && this.imagePath === modelPath) {
      return this.imageModel;
    }
    if (this.imageModel) {
      logger.info(`[OmniModelCache] Unloading image model: ${this.imagePath}`);
      await this.imageModel.unload();
    }
    logger.info(`[OmniModelCache] Loading image model: ${modelPath}`);
    const model = createModel(modelPath, 'image');
    await model.load({ keepVaeOnCpu: true, ...options });
    this.imageModel = model;
    this.imagePath = modelPath;
    return this.imageModel;
  }

  static async getTtsModel(modelPath: string, options?: { engine?: string }): Promise<TtsModel> {
    if (this.ttsModel && this.ttsPath === modelPath) {
      return this.ttsModel;
    }
    if (this.ttsModel) {
      logger.info(`[OmniModelCache] Unloading TTS model: ${this.ttsPath}`);
      await this.ttsModel.unload();
    }
    logger.info(`[OmniModelCache] Loading TTS model: ${modelPath} (engine: ${options?.engine || 'kokoro'})`);
    const model = createModel(modelPath, 'tts');
    await model.load({ engine: (options?.engine as 'kokoro' | 'qwen3') || 'kokoro' });
    this.ttsModel = model;
    this.ttsPath = modelPath;
    return this.ttsModel;
  }

  static async unloadLlmChat(): Promise<void> {
    if (this.llmChat) {
      await this.llmChat.unload();
      this.llmChat = null;
      this.llmChatPath = null;
    }
  }

  static async unloadLlmEmbed(): Promise<void> {
    if (this.llmEmbed) {
      await this.llmEmbed.unload();
      this.llmEmbed = null;
      this.llmEmbedPath = null;
    }
  }

  static async unloadImage(): Promise<void> {
    if (this.imageModel) {
      await this.imageModel.unload();
      this.imageModel = null;
      this.imagePath = null;
    }
  }

  static async unloadTts(): Promise<void> {
    if (this.ttsModel) {
      await this.ttsModel.unload();
      this.ttsModel = null;
      this.ttsPath = null;
    }
  }

  static async unloadAll(): Promise<void> {
    await Promise.all([
      this.unloadLlmChat(),
      this.unloadLlmEmbed(),
      this.unloadImage(),
      this.unloadTts(),
    ]);
    logger.info('[OmniModelCache] All models unloaded');
  }

  static getStatus(): OmniModelStatus {
    return {
      llmChat: { loaded: this.llmChat?.loaded ?? false, modelPath: this.llmChatPath },
      llmEmbed: { loaded: this.llmEmbed?.loaded ?? false, modelPath: this.llmEmbedPath },
      image: { loaded: this.imageModel?.loaded ?? false, modelPath: this.imagePath },
      tts: { loaded: this.ttsModel?.loaded ?? false, modelPath: this.ttsPath },
      gpu: detectGpu(),
    };
  }

  static getGpuInfo(): GpuInfo {
    return detectGpu();
  }
}
