import { OpenAIChatModel } from './providers/openai-chat-model.ts';
import { AnthropicChatModel } from './providers/anthropic-chat-model.ts';
import { GeminiChatModel } from './providers/gemini-chat-model.ts';
import type { ChatModel } from '../types/llm-types.ts';
import { getModelConfig, resolveApiKey, type ModelConfig } from './llm-config.ts';
import { resolveAgentLLMRef, type AgentLLMRef } from './types.ts';
import { detectProvider, type LLMProvider } from './provider-detector.ts';
import { logger } from '../logger.ts';

export class LLMFactory {
  private static instances: Map<string, ChatModel> = new Map();

  /**
   * Create an LLM instance from a config name (defined in llm.json)
   * @param ref - Config name as string, or object with name and optional temperature override
   */
  static create(ref: AgentLLMRef = 'default'): ChatModel {
    const { name, temperature: tempOverride } = resolveAgentLLMRef(ref);
    const config = getModelConfig(name);
    const provider = detectProvider(config);

    // Apply temperature override if provided, otherwise use config temperature
    const temperature = tempOverride ?? config.temperature;
    const key = this.getCacheKey(name, temperature ?? 0);

    const cached = this.instances.get(key);
    if (cached) {
      return cached;
    }

    logger.info(`[LLMFactory] Creating LLM: ${name} (provider: ${provider}, model: ${config.model}, temp: ${temperature ?? 'default'})`);

    let llm: ChatModel;
    switch (provider) {
      case 'openai':
        llm = this.createOpenAI(config, temperature);
        break;
      case 'gemini':
        llm = this.createGemini(config, temperature);
        break;
      case 'anthropic':
        llm = this.createAnthropic(config, temperature);
        break;
      case 'local':
        llm = this.createLocal(config, temperature, 'local');
        break;
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }

    this.instances.set(key, llm);
    return llm;
  }

  private static createOpenAI(config: ModelConfig, temperature?: number, provider: LLMProvider = 'openai'): ChatModel {
    const apiKey = resolveApiKey(provider, config.apiKey);
    return new OpenAIChatModel({
      modelName: config.model,
      apiKey,
      maxTokens: config.maxTokens,
      streamUsage: true,
      baseURL: config.baseUrl,
      ...(temperature !== undefined ? { temperature } : {}),
    });
  }

  private static createGemini(config: ModelConfig, temperature?: number): ChatModel {
    const apiKey = resolveApiKey('gemini', config.apiKey);
    return new GeminiChatModel({
      modelName: config.model,
      apiKey,
      maxTokens: config.maxTokens,
      ...(temperature !== undefined ? { temperature } : {}),
    });
  }

  private static createAnthropic(config: ModelConfig, temperature?: number): ChatModel {
    const apiKey = resolveApiKey('anthropic', config.apiKey);
    return new AnthropicChatModel({
      modelName: config.model,
      apiKey,
      maxTokens: config.maxTokens,
      ...(temperature !== undefined ? { temperature } : {}),
    });
  }

  private static createLocal(config: ModelConfig, temperature?: number, provider: LLMProvider = 'local'): ChatModel {
    return this.createOpenAI(config, temperature, provider);
  }

  private static getCacheKey(name: string, temperature: number): string {
    return `${name}-${temperature}`;
  }

  static clearCache(): void {
    this.instances.clear();
  }
}
