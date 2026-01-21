import { ChatOpenAI } from '@langchain/openai';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { getModelConfig, type ModelConfig } from './llm-config.js';
import { resolveAgentLLMRef, type AgentLLMRef } from './types.js';
import { detectProvider } from './provider-detector.js';
import { logger } from '../logger.js';

export class LLMFactory {
  private static instances: Map<string, BaseChatModel> = new Map();

  /**
   * Create an LLM instance from a config name (defined in llm.json)
   * @param ref - Config name as string, or object with name and optional temperature override
   */
  static create(ref: AgentLLMRef = 'default'): BaseChatModel {
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

    let llm: BaseChatModel;
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
        llm = this.createLocal(config, temperature);
        break;
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }

    this.instances.set(key, llm);
    return llm;
  }

  /**
   * Create OpenAI LLM instance
   */
  private static createOpenAI(config: ModelConfig, temperature?: number): BaseChatModel {
    const options: any = {
      modelName: config.model,
      openAIApiKey: config.apiKey,
      maxTokens: config.maxTokens,
      configuration: config.baseUrl ? { baseURL: config.baseUrl } : undefined,
    };

    if (temperature !== undefined) {
      options.temperature = temperature;
    }

    return new ChatOpenAI(options);
  }

  /**
   * Create Google Gemini LLM instance
   */
  private static createGemini(config: ModelConfig, temperature?: number): BaseChatModel {
    const options: any = {
      model: config.model,
      apiKey: config.apiKey,
      maxOutputTokens: config.maxTokens,
    };

    if (temperature !== undefined) {
      options.temperature = temperature;
    }

    return new ChatGoogleGenerativeAI(options);
  }

  /**
   * Create Anthropic Claude LLM instance
   */
  private static createAnthropic(config: ModelConfig, temperature?: number): BaseChatModel {
    const options: any = {
      modelName: config.model,
      anthropicApiKey: config.apiKey,
      maxTokens: config.maxTokens,
    };

    if (temperature !== undefined) {
      options.temperature = temperature;
    }

    return new ChatAnthropic(options);
  }

  /**
   * Create Local LLM instance (OpenAI-compatible)
   * Used for LM Studio, Ollama, and other OpenAI-compatible local servers
   */
  private static createLocal(config: ModelConfig, temperature?: number): BaseChatModel {
    return this.createOpenAI(config, temperature);
  }

  private static getCacheKey(name: string, temperature: number): string {
    return `${name}-${temperature}`;
  }

  static clearCache(): void {
    this.instances.clear();
  }
}
